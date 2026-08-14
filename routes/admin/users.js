const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../../middleware/auth');
const rbac = require('../../middleware/rbac');
const { auditLog } = require('../../middleware/audit');
const { v4: uuidv4 } = require('uuid');

router.use(authenticateAdmin);

// Search users
router.get('/search', rbac(['users.view']), async (req, res) => {
    try {
        const { q, limit = 50 } = req.query;

        let query = req.supabase
            .from('users')
            .select('*, profiles(*)')
            .limit(parseInt(limit));

        if (q) {
            query = query.or(`email.ilike.%${q}%,profiles.full_name.ilike.%${q}%`);
        }

        const { data: users, error } = await query.order('created_at', { ascending: false });
        if (error) throw error;

        // Get accounts for each user
        const usersWithAccounts = await Promise.all(
            users.map(async (user) => {
                const { data: accounts } = await req.supabase
                    .from('accounts')
                    .select('*, account_balances(*)')
                    .eq('user_id', user.id);

                return { ...user, accounts };
            })
        );

        res.json({ users: usersWithAccounts });
    } catch (error) {
        console.error('Search users error:', error);
        res.status(500).json({ error: 'Search failed' });
    }
});

// Get user details
router.get('/:id', rbac(['users.view']), async (req, res) => {
    try {
        const { data: user } = await req.supabase
            .from('users')
            .select('*, profiles(*)')
            .eq('id', req.params.id)
            .single();

        if (!user) return res.status(404).json({ error: 'User not found' });

        const { data: accounts } = await req.supabase
            .from('accounts')
            .select('*, account_balances(*)')
            .eq('user_id', user.id);

        const { data: limits } = await req.supabase
            .from('transfer_limits')
            .select('*')
            .eq('user_id', user.id)
            .single();

        const { data: cards } = await req.supabase
            .from('cards')
            .select('*')
            .eq('user_id', user.id);

        const { data: loginHistory } = await req.supabase
            .from('login_history')
            .select('*')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false })
            .limit(20);

        const { data: securityEvents } = await req.supabase
            .from('security_events')
            .select('*')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false })
            .limit(20);

        const { data: supportTickets } = await req.supabase
            .from('support_tickets')
            .select('*')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false })
            .limit(10);

        res.json({
            user,
            accounts,
            limits,
            cards,
            loginHistory,
            securityEvents,
            supportTickets
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch user' });
    }
});

// Freeze account
router.post('/:id/freeze', rbac(['users.freeze']), async (req, res) => {
    try {
        const { reason } = req.body;

        if (!reason) {
            return res.status(400).json({ error: 'Freeze reason is required' });
        }

        // Get previous state for audit
        const { data: previous } = await req.supabase
            .from('users')
            .select('is_frozen, freeze_reason, frozen_at')
            .eq('id', req.params.id)
            .single();

        // Update user with freeze details
        const { data: user, error } = await req.supabase
            .from('users')
            .update({ 
                is_frozen: true,
                freeze_reason: reason,
                frozen_at: new Date().toISOString(),
                frozen_by: req.admin.id
            })
            .eq('id', req.params.id)
            .select()
            .single();

        if (error) throw error;

        // Audit log
        await auditLog(req.supabase, {
            actorId: req.admin.id,
            actorType: 'admin',
            action: 'ADMIN_FROZE_ACCOUNT',
            targetType: 'user',
            targetId: req.params.id,
            previousValue: previous,
            newValue: { is_frozen: true, reason },
            reason: reason,
            ip: req.ip,
            userAgent: req.get('user-agent')
        });

        // Notify user about freeze
        await req.supabase
            .from('notifications')
            .insert({
                id: uuidv4(),
                user_id: req.params.id,
                type: 'account_frozen',
                title: 'Account Frozen',
                message: `Your account has been frozen. Reason: ${reason}. Please contact support for assistance.`
            });

        res.json({ 
            user, 
            message: 'Account frozen successfully',
            reason: reason
        });
    } catch (error) {
        console.error('Freeze error:', error);
        res.status(500).json({ error: 'Failed to freeze account' });
    }
});

// Unfreeze account - clear the reason
router.post('/:id/unfreeze', rbac(['users.freeze']), async (req, res) => {
    try {
        const { reason } = req.body;

        const { data: user } = await req.supabase
            .from('users')
            .update({ 
                is_frozen: false,
                freeze_reason: null, // Clear reason
                frozen_at: null,
                frozen_by: null
            })
            .eq('id', req.params.id)
            .select()
            .single();

        await auditLog(req.supabase, {
            actorId: req.admin.id,
            actorType: 'admin',
            action: 'ADMIN_UNFROZE_ACCOUNT',
            targetType: 'user',
            targetId: req.params.id,
            reason: reason || 'Account unfrozen',
            ip: req.ip
        });

        // Notify user
        await req.supabase
            .from('notifications')
            .insert({
                id: uuidv4(),
                user_id: req.params.id,
                type: 'account_unfrozen',
                title: 'Account Unfrozen',
                message: 'Your account has been unfrozen. All services are now available.'
            });

        res.json({ user, message: 'Account unfrozen' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to unfreeze' });
    }
});

// Suspend account
router.post('/:id/suspend', rbac(['users.suspend']), async (req, res) => {
    try {
        const { reason } = req.body;

        const { data: user } = await req.supabase
            .from('users')
            .update({ is_suspended: true })
            .eq('id', req.params.id)
            .select()
            .single();

        await auditLog(req.supabase, {
            actorId: req.admin.id,
            actorType: 'admin',
            action: 'ADMIN_SUSPENDED_ACCOUNT',
            targetType: 'user',
            targetId: req.params.id,
            reason,
            ip: req.ip
        });

        res.json({ user, message: 'Account suspended' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to suspend' });
    }
});

// Update limits
router.put('/:id/limits', rbac(['limits.edit']), async (req, res) => {
    try {
        const limitData = req.body;

        const { data: previous } = await req.supabase
            .from('transfer_limits')
            .select('*')
            .eq('user_id', req.params.id)
            .single();

        const { data: limits, error } = await req.supabase
            .from('transfer_limits')
            .update(limitData)
            .eq('user_id', req.params.id)
            .select()
            .single();

        if (error) throw error;

        await auditLog(req.supabase, {
            actorId: req.admin.id,
            actorType: 'admin',
            action: 'ADMIN_CHANGED_TRANSFER_LIMIT',
            targetType: 'user',
            targetId: req.params.id,
            previousValue: previous,
            newValue: limits,
            reason: limitData.reason || 'Admin limit modification',
            ip: req.ip
        });

        res.json({ limits, message: 'Limits updated' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update limits' });
    }
});

module.exports = router;