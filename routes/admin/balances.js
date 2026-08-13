const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../../middleware/auth');
const rbac = require('../../middleware/rbac');
const { auditLog } = require('../../middleware/audit');
const { v4: uuidv4 } = require('uuid');

router.use(authenticateAdmin);
router.use(rbac(['balances.adjust']));

// Adjust balance
router.post('/adjust', async (req, res) => {
    try {
        const { account_id, type, amount, reason, reference } = req.body;

        if (!account_id || !amount || !reason) {
            return res.status(400).json({ error: 'Account ID, amount, and reason are required' });
        }

        // Get current balance
        const { data: account } = await req.supabase
            .from('accounts')
            .select('*, account_balances(*)')
            .eq('id', account_id)
            .single();

        if (!account) {
            return res.status(404).json({ error: 'Account not found' });
        }

        const balanceBefore = parseFloat(account.account_balances?.available_balance || 0);
        let balanceAfter = balanceBefore;

        if (type === 'increase' || type === 'set') {
            balanceAfter = type === 'set' ? parseFloat(amount) : balanceBefore + parseFloat(amount);
        } else if (type === 'decrease') {
            balanceAfter = balanceBefore - parseFloat(amount);
        }

        // Generate adjustment number
        const adjustmentNumber = 'BA-' + Date.now().toString().slice(-6);

        // Create adjustment record
        const { data: adjustment } = await req.supabase
            .from('balance_adjustments')
            .insert({
                id: uuidv4(),
                adjustment_number: adjustmentNumber,
                admin_id: req.admin.id,
                target_user_id: account.user_id,
                account_id: account.id,
                adjustment_type: type,
                amount: Math.abs(parseFloat(amount)),
                currency: account.currency,
                balance_before: balanceBefore,
                balance_after: balanceAfter,
                reason,
                reference: reference || adjustmentNumber
            })
            .select()
            .single();

        // Update balance
        await req.supabase
            .from('account_balances')
            .update({
                available_balance: balanceAfter,
                updated_at: new Date().toISOString()
            })
            .eq('account_id', account_id);

        // Audit log
        await auditLog(req.supabase, {
            actorId: req.admin.id,
            actorType: 'admin',
            action: 'ADMIN_ADJUSTED_SIMULATED_BALANCE',
            targetType: 'account',
            targetId: account_id,
            previousValue: { balance: balanceBefore },
            newValue: { balance: balanceAfter },
            reason,
            reference: adjustmentNumber,
            ip: req.ip,
            userAgent: req.get('user-agent')
        });

        // Create notification for user
        await req.supabase
            .from('notifications')
            .insert({
                id: uuidv4(),
                user_id: account.user_id,
                type: 'balance_adjustment',
                title: 'Account Balance Updated',
                message: `Your ${account.currency} account balance has been updated to ${balanceAfter.toFixed(2)}. Ref: ${adjustmentNumber}`
            });

        res.json({
            adjustment,
            message: 'Balance adjusted successfully',
            details: {
                before: balanceBefore,
                adjustment: type === 'decrease' ? -Math.abs(parseFloat(amount)) : Math.abs(parseFloat(amount)),
                after: balanceAfter,
                reference: adjustmentNumber
            }
        });
    } catch (error) {
        console.error('Balance adjustment error:', error);
        res.status(500).json({ error: 'Balance adjustment failed' });
    }
});

// Get adjustment history
router.get('/history', async (req, res) => {
    try {
        const { user_id, account_id, limit = 50 } = req.query;

        let query = req.supabase
            .from('balance_adjustments')
            .select('*, admin_users(first_name, last_name, email), accounts(account_number, currency)')
            .order('created_at', { ascending: false })
            .limit(parseInt(limit));

        if (user_id) query = query.eq('target_user_id', user_id);
        if (account_id) query = query.eq('account_id', account_id);

        const { data: adjustments, error } = await query;
        if (error) throw error;

        res.json({ adjustments });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch adjustments' });
    }
});

// Reverse adjustment
router.post('/:id/reverse', async (req, res) => {
    try {
        const { reason } = req.body;

        const { data: adjustment } = await req.supabase
            .from('balance_adjustments')
            .select('*, accounts(*)')
            .eq('id', req.params.id)
            .single();

        if (!adjustment) return res.status(404).json({ error: 'Adjustment not found' });
        if (adjustment.is_reversed) return res.status(400).json({ error: 'Already reversed' });

        // Reverse the balance
        const currentBalance = adjustment.balance_after;
        const reverseAmount = adjustment.adjustment_type === 'increase' ?
            currentBalance - adjustment.amount :
            currentBalance + adjustment.amount;

        await req.supabase
            .from('account_balances')
            .update({ available_balance: reverseAmount })
            .eq('account_id', adjustment.account_id);

        // Mark as reversed
        await req.supabase
            .from('balance_adjustments')
            .update({
                is_reversed: true,
                reversed_by: req.admin.id,
                reversed_at: new Date().toISOString()
            })
            .eq('id', req.params.id);

        await auditLog(req.supabase, {
            actorId: req.admin.id,
            actorType: 'admin',
            action: 'ADMIN_REVERSED_BALANCE_ADJUSTMENT',
            targetType: 'balance_adjustment',
            targetId: req.params.id,
            reason,
            ip: req.ip
        });

        res.json({ message: 'Adjustment reversed' });
    } catch (error) {
        res.status(500).json({ error: 'Reversal failed' });
    }
});

module.exports = router;