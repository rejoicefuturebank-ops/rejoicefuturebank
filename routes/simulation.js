const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/auth');
const rbac = require('../middleware/rbac');
const { auditLog } = require('../middleware/audit');
const { v4: uuidv4 } = require('uuid');
const LedgerService = require('../services/ledger');

router.use(authenticateAdmin);
router.use(rbac(['simulation.use']));

// Simulate various scenarios
router.post('/simulate', async (req, res) => {
    try {
        const { scenario, user_id, account_id, amount, ...params } = req.body;

        const result = {};

        switch (scenario) {
            case 'successful_transaction': {
                const ledger = new LedgerService(req.supabase);
                const transaction = await ledger.createTransaction({
                    type: 'simulated_transaction',
                    debitAccountId: account_id,
                    amount: amount || 100,
                    currency: 'USD',
                    description: 'Simulated successful transaction',
                    initiatedBy: user_id,
                    metadata: { simulation: true }
                });
                await ledger.completeTransaction(transaction.id);
                result.transaction = transaction;
                break;
            }

            case 'failed_transaction': {
                const ledger = new LedgerService(req.supabase);
                const transaction = await ledger.createTransaction({
                    type: 'simulated_transaction',
                    debitAccountId: account_id,
                    amount: amount || 100,
                    currency: 'USD',
                    description: 'Simulated failed transaction',
                    initiatedBy: user_id,
                    metadata: { simulation: true, simulated_failure: true }
                });
                await req.supabase
                    .from('transactions')
                    .update({ status: 'failed' })
                    .eq('id', transaction.id);
                result.transaction = { ...transaction, status: 'failed' };
                break;
            }

            case 'pending_transaction': {
                const ledger = new LedgerService(req.supabase);
                const transaction = await ledger.createTransaction({
                    type: 'simulated_transaction',
                    debitAccountId: account_id,
                    amount: amount || 100,
                    currency: 'USD',
                    description: 'Simulated pending transaction',
                    initiatedBy: user_id,
                    metadata: { simulation: true }
                });
                result.transaction = transaction;
                break;
            }

            case 'account_freeze': {
                await req.supabase
                    .from('users')
                    .update({ is_frozen: true })
                    .eq('id', user_id);
                result.message = 'Account frozen (simulated)';
                break;
            }

            case 'exchange_rate_change': {
                const { from, to, new_rate } = params;
                await req.supabase
                    .from('exchange_rates')
                    .update({ rate: new_rate, updated_at: new Date().toISOString() })
                    .eq('from_currency', from)
                    .eq('to_currency', to);
                result.message = `Exchange rate ${from}/${to} changed to ${new_rate}`;
                break;
            }

            case 'otp_required': {
                await req.supabase
                    .from('notifications')
                    .insert({
                        id: uuidv4(),
                        user_id,
                        type: 'security',
                        title: 'OTP Verification Required',
                        message: 'A transaction requires OTP verification (simulated).'
                    });
                result.message = 'OTP challenge created';
                break;
            }

            case 'fraud_detection': {
                await req.supabase
                    .from('security_events')
                    .insert({
                        id: uuidv4(),
                        user_id,
                        event_type: 'fraud_flagged',
                        severity: 'high',
                        description: 'Simulated fraud detection alert',
                        metadata: { simulation: true, flags: ['large_amount', 'new_device'] }
                    });
                result.message = 'Fraud alert created';
                break;
            }

            case 'card_decline': {
                await req.supabase
                    .from('notifications')
                    .insert({
                        id: uuidv4(),
                        user_id,
                        type: 'card_decline',
                        title: 'Card Transaction Declined',
                        message: 'A card transaction was declined (simulated).'
                    });
                result.message = 'Card decline notification sent';
                break;
            }

            default:
                return res.status(400).json({ error: 'Unknown scenario' });
        }

        await auditLog(req.supabase, {
            actorId: req.admin.id,
            actorType: 'admin',
            action: 'ADMIN_SIMULATED_EVENT',
            targetType: 'simulation',
            targetId: user_id,
            newValue: { scenario, params },
            ip: req.ip
        });

        res.json(result);
    } catch (error) {
        console.error('Simulation error:', error);
        res.status(500).json({ error: 'Simulation failed', details: error.message });
    }
});

// Get available scenarios
router.get('/scenarios', (req, res) => {
    res.json({
        scenarios: [
            { id: 'successful_transaction', name: 'Successful Transaction', category: 'transaction' },
            { id: 'failed_transaction', name: 'Failed Transaction', category: 'transaction' },
            { id: 'pending_transaction', name: 'Pending Transaction', category: 'transaction' },
            { id: 'reversed_transaction', name: 'Reversed Transaction', category: 'transaction' },
            { id: 'refunded_transaction', name: 'Refunded Transaction', category: 'transaction' },
            { id: 'provider_timeout', name: 'Provider Timeout', category: 'error' },
            { id: 'insufficient_balance', name: 'Insufficient Balance', category: 'error' },
            { id: 'limit_exceeded', name: 'Limit Exceeded', category: 'error' },
            { id: 'otp_required', name: 'OTP Required', category: 'security' },
            { id: 'otp_failure', name: 'OTP Failure', category: 'security' },
            { id: 'fraud_detection', name: 'Fraud Detection', category: 'security' },
            { id: 'account_freeze', name: 'Account Freeze', category: 'account' },
            { id: 'exchange_rate_change', name: 'Exchange Rate Change', category: 'market' },
            { id: 'loan_approval', name: 'Loan Approval', category: 'loan' },
            { id: 'loan_rejection', name: 'Loan Rejection', category: 'loan' },
            { id: 'card_decline', name: 'Card Decline', category: 'card' }
        ]
    });
});

module.exports = router;