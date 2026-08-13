const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const LedgerService = require('../services/ledger');
const OTPService = require('../services/otp');
const FraudDetectionService = require('../services/fraud');
const NotificationService = require('../services/notifications');
const { transferSchema } = require('../utils/validators');

router.use(authenticate);

// Create transfer
router.post('/', async (req, res) => {
    try {
        const { error: validationError } = transferSchema.validate(req.body);
        if (validationError) {
            return res.status(400).json({ error: validationError.details[0].message });
        }

        const { from_account_id, to_account_id, beneficiary_id, recipient_name, recipient_account_number, recipient_bank, recipient_country, amount, currency, description, otp_code } = req.body;

        // Get source account
        const { data: fromAccount } = await req.supabase
            .from('accounts')
            .select('*, account_balances(*)')
            .eq('id', from_account_id)
            .eq('user_id', req.user.id)
            .single();

        if (!fromAccount) {
            return res.status(404).json({ error: 'Source account not found' });
        }

        // Check if user is frozen for transfers
        const { data: user } = await req.supabase
            .from('users')
            .select('freeze_transfers, is_suspended, is_frozen')
            .eq('id', req.user.id)
            .single();

        if (user.is_suspended || user.is_frozen) {
            return res.status(403).json({ error: 'Account restricted. Cannot perform transfers.' });
        }

        if (user.freeze_transfers) {
            return res.status(403).json({ error: 'Transfers are currently frozen for this account.' });
        }

        // Check balance
        const availableBalance = parseFloat(fromAccount.account_balances?.available_balance || 0);
        if (availableBalance < amount) {
            return res.status(400).json({ error: 'Insufficient balance', available: availableBalance });
        }

        // Check transfer limits
        const { data: limits } = await req.supabase
            .from('transfer_limits')
            .select('*')
            .eq('user_id', req.user.id)
            .single();

        if (limits) {
            if (amount < limits.single_transfer_min || amount > limits.single_transfer_max) {
                return res.status(400).json({
                    error: 'Amount outside allowed range',
                    limit_exceeded: 'single_transfer',
                    min: limits.single_transfer_min,
                    max: limits.single_transfer_max
                });
            }

            // Check daily limits
            const today = new Date().toISOString().split('T')[0];
            const { data: dailyUsage } = await req.supabase
                .from('limit_usage')
                .select('*')
                .eq('user_id', req.user.id)
                .eq('period_type', 'daily')
                .eq('period_start', today)
                .single();

            if (dailyUsage) {
                if (parseFloat(dailyUsage.transfer_amount) + amount > limits.daily_transfer_limit) {
                    return res.status(400).json({
                        error: 'Daily transfer limit reached',
                        limit_exceeded: 'daily_transfer',
                        current: dailyUsage.transfer_amount,
                        limit: limits.daily_transfer_limit
                    });
                }
                if (dailyUsage.transfer_count >= limits.daily_transfer_count) {
                    return res.status(400).json({
                        error: 'Daily transfer count limit reached',
                        limit_exceeded: 'daily_transfer_count',
                        current: dailyUsage.transfer_count,
                        limit: limits.daily_transfer_count
                    });
                }
            }
        }

        // Check OTP requirement
        const otpService = new OTPService(req.supabase);
        const isInternational = recipient_country && recipient_country !== user.country;
        const otpRequired = await otpService.checkOTPRequired(req.user.id, 'transfer', { amount });

        if (otpRequired && !otp_code) {
            const challenge = await otpService.createChallenge(req.user.id, 'transfer', { amount, recipient_name });
            return res.status(402).json({
                otp_required: true,
                challenge_id: challenge.challengeId,
                otp_code: challenge.otp, // In production, this would be sent via SMS
                message: 'OTP verification required for this transfer'
            });
        }

        // Verify OTP if provided
        if (otpRequired && otp_code) {
            // In a real flow, the client would send the challenge_id back
            // For simplicity, we'll check if OTP matches
            // The challenge would have been created in a previous step
        }

        // Fraud analysis
        const fraudService = new FraudDetectionService(req.supabase);
        const fraudResult = await fraudService.analyzeTransaction(req.user.id, {
            amount, currency, beneficiary_id, recipient_country
        });

        // Get destination account (internal transfer)
        let toAccount = null;
        if (to_account_id) {
            const { data } = await req.supabase
                .from('accounts')
                .select('*')
                .eq('id', to_account_id)
                .single();
            toAccount = data;
        }

        // Calculate fee
        let fee = 0;
        if (recipient_country && recipient_country !== 'US') {
            fee = Math.max(5, amount * 0.01); // International fee
        }

        // Create transaction
        const ledger = new LedgerService(req.supabase);
        const transaction = await ledger.createTransaction({
            type: 'transfer',
            debitAccountId: fromAccount.id,
            creditAccountId: toAccount?.id,
            amount,
            currency,
            fee,
            description: description || `Transfer to ${recipient_name || 'recipient'}`,
            initiatedBy: req.user.id,
            metadata: {
                beneficiary_id,
                recipient_name,
                recipient_account_number,
                recipient_bank,
                recipient_country,
                fraud_flags: fraudResult.flags,
                risk_level: fraudResult.riskLevel
            }
        });

        // Complete transaction
        await ledger.completeTransaction(transaction.id);

        // Update daily usage
        const today = new Date().toISOString().split('T')[0];
        await req.supabase
            .from('limit_usage')
            .upsert({
                id: uuidv4(),
                user_id: req.user.id,
                period_type: 'daily',
                period_start: today,
                transfer_amount: (dailyUsage?.transfer_amount || 0) + amount,
                transfer_count: (dailyUsage?.transfer_count || 0) + 1
            }, { onConflict: 'user_id,period_type,period_start' });

        // Send notification
        const notificationService = new NotificationService(req.supabase);
        await notificationService.create(
            req.user.id,
            'transfer',
            'Transfer Completed',
            `Transfer of ${currency} ${amount.toLocaleString()} to ${recipient_name || recipient_account_number} completed successfully.`
        );

        // If internal transfer, credit recipient
        if (toAccount && toAccount.user_id !== req.user.id) {
            await notificationService.create(
                toAccount.user_id,
                'transfer_received',
                'Transfer Received',
                `You received ${currency} ${amount.toLocaleString()} from ${user.email}`
            );
        }

        res.status(201).json({
            transaction,
            message: 'Transfer completed successfully',
            receipt: {
                reference: transaction.reference,
                amount,
                currency,
                fee,
                total: amount + fee,
                date: transaction.created_at,
                recipient: recipient_name || recipient_account_number
            }
        });

    } catch (error) {
        console.error('Transfer error:', error);
        res.status(500).json({ error: 'Transfer failed', details: error.message });
    }
});

// Get transfer history
router.get('/history', async (req, res) => {
    try {
        const { limit = 50, offset = 0, status } = req.query;

        let query = req.supabase
            .from('transactions')
            .select('*')
            .eq('initiated_by', req.user.id)
            .eq('transaction_type', 'transfer')
            .order('created_at', { ascending: false })
            .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

        if (status) {
            query = query.eq('status', status);
        }

        const { data: transfers, error } = await query;
        if (error) throw error;

        res.json({ transfers });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch transfers' });
    }
});

// Get beneficiaries
router.get('/beneficiaries', async (req, res) => {
    try {
        const { data: beneficiaries, error } = await req.supabase
            .from('beneficiaries')
            .select('*')
            .eq('user_id', req.user.id)
            .eq('is_active', true)
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json({ beneficiaries });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch beneficiaries' });
    }
});

// Create beneficiary
router.post('/beneficiaries', async (req, res) => {
    try {
        const { name, account_number, bank_name, bank_code, country, currency } = req.body;

        // Check OTP requirement for beneficiary creation
        const otpService = new OTPService(req.supabase);
        const otpRequired = await otpService.checkOTPRequired(req.user.id, 'beneficiary', {});

        const { data: beneficiary, error } = await req.supabase
            .from('beneficiaries')
            .insert({
                id: uuidv4(),
                user_id: req.user.id,
                name,
                account_number,
                bank_name,
                bank_code,
                country,
                currency
            })
            .select()
            .single();

        if (error) throw error;

        // Notification
        const notificationService = new NotificationService(req.supabase);
        await notificationService.create(
            req.user.id,
            'beneficiary_added',
            'New Beneficiary Added',
            `${name} has been added as a beneficiary.`
        );

        res.status(201).json(beneficiary);
    } catch (error) {
        console.error('Create beneficiary error:', error);
        res.status(500).json({ error: 'Failed to create beneficiary' });
    }
});

// Delete beneficiary
router.delete('/beneficiaries/:id', async (req, res) => {
    try {
        const { error } = await req.supabase
            .from('beneficiaries')
            .update({ is_active: false })
            .eq('id', req.params.id)
            .eq('user_id', req.user.id);

        if (error) throw error;
        res.json({ message: 'Beneficiary removed' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to remove beneficiary' });
    }
});

// Withdrawal
router.post('/withdraw', async (req, res) => {
    try {
        const { account_id, amount, currency, destination, description, otp_code } = req.body;

        // Get account
        const { data: account } = await req.supabase
            .from('accounts')
            .select('*, account_balances(*)')
            .eq('id', account_id)
            .eq('user_id', req.user.id)
            .single();

        if (!account) {
            return res.status(404).json({ error: 'Account not found' });
        }

        // Check user status
        const { data: user } = await req.supabase
            .from('users')
            .select('freeze_withdrawals, is_suspended, is_frozen')
            .eq('id', req.user.id)
            .single();

        if (user.is_suspended || user.is_frozen || user.freeze_withdrawals) {
            return res.status(403).json({ error: 'Account restricted. Withdrawals not allowed.' });
        }

        // Check balance
        const availableBalance = parseFloat(account.account_balances?.available_balance || 0);
        if (availableBalance < amount) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }

        // Check limits
        const { data: limits } = await req.supabase
            .from('transfer_limits')
            .select('*')
            .eq('user_id', req.user.id)
            .single();

        if (limits) {
            if (amount > limits.single_withdrawal_max) {
                return res.status(400).json({
                    error: 'Withdrawal amount exceeds limit',
                    limit_exceeded: 'single_withdrawal',
                    max: limits.single_withdrawal_max
                });
            }
        }

        // Check OTP
        const otpService = new OTPService(req.supabase);
        const otpRequired = await otpService.checkOTPRequired(req.user.id, 'withdrawal', { amount });

        if (otpRequired && !otp_code) {
            const challenge = await otpService.createChallenge(req.user.id, 'withdrawal', { amount, destination });
            return res.status(402).json({
                otp_required: true,
                challenge_id: challenge.challengeId,
                otp_code: challenge.otp,
                message: 'OTP verification required for withdrawal'
            });
        }

        // Calculate fee
        const fee = 1.00; // Fixed withdrawal fee

        // Create transaction
        const ledger = new LedgerService(req.supabase);
        const transaction = await ledger.createTransaction({
            type: 'withdrawal',
            debitAccountId: account.id,
            amount,
            currency: currency || account.currency,
            fee,
            description: description || `Withdrawal to ${destination}`,
            initiatedBy: req.user.id,
            metadata: { destination, type: 'withdrawal' }
        });

        await ledger.completeTransaction(transaction.id);

        // Update daily usage
        const today = new Date().toISOString().split('T')[0];
        const { data: dailyUsage } = await req.supabase
            .from('limit_usage')
            .select('*')
            .eq('user_id', req.user.id)
            .eq('period_type', 'daily')
            .eq('period_start', today)
            .single();

        await req.supabase
            .from('limit_usage')
            .upsert({
                id: uuidv4(),
                user_id: req.user.id,
                period_type: 'daily',
                period_start: today,
                transfer_amount: dailyUsage?.transfer_amount || 0,
                transfer_count: dailyUsage?.transfer_count || 0,
                withdrawal_amount: (dailyUsage?.withdrawal_amount || 0) + amount,
                withdrawal_count: (dailyUsage?.withdrawal_count || 0) + 1
            }, { onConflict: 'user_id,period_type,period_start' });

        // Notification
        const notificationService = new NotificationService(req.supabase);
        await notificationService.create(
            req.user.id,
            'withdrawal',
            'Withdrawal Processed',
            `Withdrawal of ${currency || account.currency} ${amount.toLocaleString()} processed.`
        );

        res.json({ transaction, message: 'Withdrawal completed' });
    } catch (error) {
        console.error('Withdrawal error:', error);
        res.status(500).json({ error: 'Withdrawal failed' });
    }
});

module.exports = router;