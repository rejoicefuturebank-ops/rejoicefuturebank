const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const LedgerService = require('../services/ledger');
const OTPService = require('../services/otp');
const FraudDetectionService = require('../services/fraud');
const NotificationService = require('../services/notifications');
const flutterwave = require('../services/flutterwaveservice');
const { sendEmail } = require('../services/email');
const { internalTransferSchema, externalTransferSchema, withdrawalSchema } = require('../utils/validators');

router.use(authenticate);

// ============================================================
// Shared helpers
// ============================================================

async function getDailyUsage(supabase, userId) {
    const today = new Date().toISOString().split('T')[0];
    const { data } = await supabase
        .from('limit_usage')
        .select('*')
        .eq('user_id', userId)
        .eq('period_type', 'daily')
        .eq('period_start', today)
        .single();
    return { today, usage: data };
}

async function bumpDailyUsage(supabase, userId, { transferAmount = 0, transferCount = 0, withdrawalAmount = 0, withdrawalCount = 0 }) {
    const { today, usage } = await getDailyUsage(supabase, userId);
    await supabase.from('limit_usage').upsert({
        id: usage?.id || uuidv4(),
        user_id: userId,
        period_type: 'daily',
        period_start: today,
        transfer_amount: parseFloat(usage?.transfer_amount || 0) + transferAmount,
        transfer_count: parseInt(usage?.transfer_count || 0) + transferCount,
        withdrawal_amount: parseFloat(usage?.withdrawal_amount || 0) + withdrawalAmount,
        withdrawal_count: parseInt(usage?.withdrawal_count || 0) + withdrawalCount
    }, { onConflict: 'user_id,period_type,period_start' });
}

async function checkTransferLimits(supabase, userId, amount) {
    const { data: limits } = await supabase
        .from('transfer_limits')
        .select('*')
        .eq('user_id', userId)
        .single();

    if (!limits) return { ok: true, limits: null };

    if (amount < limits.single_transfer_min || amount > limits.single_transfer_max) {
        return {
            ok: false,
            response: {
                error: 'Amount outside allowed range',
                limit_exceeded: 'single_transfer',
                min: limits.single_transfer_min,
                max: limits.single_transfer_max
            }
        };
    }

    const { usage } = await getDailyUsage(supabase, userId);
    if (usage) {
        if (parseFloat(usage.transfer_amount) + amount > limits.daily_transfer_limit) {
            return {
                ok: false,
                response: {
                    error: 'Daily transfer limit reached',
                    limit_exceeded: 'daily_transfer',
                    current: usage.transfer_amount,
                    limit: limits.daily_transfer_limit
                }
            };
        }
        if (usage.transfer_count >= limits.daily_transfer_count) {
            return {
                ok: false,
                response: {
                    error: 'Daily transfer count limit reached',
                    limit_exceeded: 'daily_transfer_count',
                    current: usage.transfer_count,
                    limit: limits.daily_transfer_count
                }
            };
        }
    }

    return { ok: true, limits };
}

// Real OTP flow: create a challenge, email the code (never return it in
// the API response), and require the caller to come back with both
// challenge_id and otp_code, which we actually verify.
async function requireOtpIfNeeded(req, res, { type, amount, context }) {
    const otpService = new OTPService(req.supabase);
    const { otp_code, challenge_id } = req.body;

    const otpRequired = await otpService.checkOTPRequired(req.user.id, type, { amount });
    if (!otpRequired) return { passed: true };

    if (!otp_code || !challenge_id) {
        const challenge = await otpService.createChallenge(req.user.id, type, context);

        const { data: user } = await req.supabase
            .from('users')
            .select('email')
            .eq('id', req.user.id)
            .single();

        await sendEmail({
            to: user.email,
            subject: 'Your RejoiceFutureBank verification code',
            text: `Your verification code is ${challenge.otp}. It expires in 10 minutes. Never share this code with anyone.`,
            html: `<p>Your verification code is:</p><div style="font-size:28px;font-weight:700;letter-spacing:6px">${challenge.otp}</div><p>It expires in 10 minutes. Never share this code with anyone.</p>`
        }).catch((e) => console.error('OTP email failed:', e));

        res.status(402).json({
            otp_required: true,
            challenge_id: challenge.challengeId,
            message: 'A verification code has been sent to your email.'
        });
        return { passed: false };
    }

    const verification = await otpService.verifyChallenge(challenge_id, otp_code);
    if (!verification.verified) {
        res.status(400).json({ error: verification.error || 'Invalid or expired code' });
        return { passed: false };
    }

    return { passed: true };
}

// ============================================================
// INTERNAL TRANSFER — real ledger-to-ledger, same platform only.
// This is the "same app to same app" path: no external money
// movement, so it's genuinely production-ready with no third party.
// ============================================================
router.post('/internal', async (req, res) => {
    try {
        const { error, value } = internalTransferSchema.validate(req.body);
        if (error) return res.status(400).json({ error: error.details[0].message });

        const { from_account_id, recipient_identifier, amount, currency, description } = value;

        const { data: fromAccount } = await req.supabase
            .from('accounts')
            .select('*, account_balances(*)')
            .eq('id', from_account_id)
            .eq('user_id', req.user.id)
            .single();

        if (!fromAccount) return res.status(404).json({ error: 'Source account not found' });
        if (fromAccount.currency !== currency) {
            return res.status(400).json({ error: `This account is in ${fromAccount.currency}, not ${currency}.` });
        }

        const { data: sender } = await req.supabase
            .from('users')
            .select('is_frozen, is_suspended, freeze_transfers, email')
            .eq('id', req.user.id)
            .single();

        if (sender.is_suspended || sender.is_frozen || sender.freeze_transfers) {
            return res.status(403).json({ error: 'Transfers are currently unavailable on this account.' });
        }

        const availableBalance = parseFloat(fromAccount.account_balances?.available_balance || 0);
        if (availableBalance < amount) {
            return res.status(400).json({ error: 'Insufficient balance', available: availableBalance });
        }

        const limitCheck = await checkTransferLimits(req.supabase, req.user.id, amount);
        if (!limitCheck.ok) return res.status(400).json(limitCheck.response);

        // Resolve the recipient — by account number or by email, within
        // this platform only. Never leak whether an email exists on the
        // platform if it isn't found; give one generic error either way.
        let recipientAccount = null;

        const { data: byAccountNumber } = await req.supabase
            .from('accounts')
            .select('*, users!inner(id, email, is_suspended, is_frozen, registration_status)')
            .eq('account_number', recipient_identifier)
            .eq('currency', currency)
            .eq('is_active', true)
            .single();

        if (byAccountNumber) {
            recipientAccount = byAccountNumber;
        } else if (recipient_identifier.includes('@')) {
            const { data: recipientUser } = await req.supabase
                .from('users')
                .select('id, is_suspended, is_frozen, registration_status')
                .eq('email', recipient_identifier.toLowerCase())
                .single();

            if (recipientUser) {
                const { data: acct } = await req.supabase
                    .from('accounts')
                    .select('*')
                    .eq('user_id', recipientUser.id)
                    .eq('currency', currency)
                    .eq('is_active', true)
                    .single();
                if (acct) recipientAccount = { ...acct, users: recipientUser };
            }
        }

        if (!recipientAccount) {
            return res.status(404).json({
                error: `We couldn't find a ${currency} RejoiceFutureBank account matching that account number or email.`
            });
        }

        if (recipientAccount.id === fromAccount.id) {
            return res.status(400).json({ error: 'You cannot send money to the same account.' });
        }

        const recipientUser = recipientAccount.users;
        if (recipientUser.is_suspended || recipientUser.registration_status === 'closed') {
            return res.status(400).json({ error: 'This recipient account cannot receive transfers.' });
        }

        const otpResult = await requireOtpIfNeeded(req, res, {
            type: 'transfer',
            amount,
            context: { recipient: recipient_identifier, internal: true }
        });
        if (!otpResult.passed) return; // response already sent

        const fraudService = new FraudDetectionService(req.supabase);
        const fraudResult = await fraudService.analyzeTransaction(req.user.id, { amount, currency });

        const ledger = new LedgerService(req.supabase);
        const transaction = await ledger.createTransaction({
            type: 'internal_transfer',
            debitAccountId: fromAccount.id,
            creditAccountId: recipientAccount.id,
            amount,
            currency,
            fee: 0, // no fee for same-platform transfers
            description: description || `Transfer to ${recipient_identifier}`,
            initiatedBy: req.user.id,
            metadata: {
                recipient_identifier,
                recipient_user_id: recipientUser.id,
                fraud_flags: fraudResult.flags,
                risk_level: fraudResult.riskLevel
            }
        });

        await ledger.completeTransaction(transaction.id);
        await bumpDailyUsage(req.supabase, req.user.id, { transferAmount: amount, transferCount: 1 });

        const notificationService = new NotificationService(req.supabase);
        await notificationService.create(
            req.user.id, 'transfer', 'Transfer Sent',
            `You sent ${currency} ${amount.toLocaleString()} to ${recipient_identifier}.`
        );
        await notificationService.create(
            recipientUser.id, 'transfer_received', 'Money Received',
            `You received ${currency} ${amount.toLocaleString()} from ${sender.email}.`
        );

        res.status(201).json({
            transaction,
            message: 'Transfer completed successfully',
            receipt: {
                reference: transaction.reference,
                amount, currency, fee: 0, total: amount,
                date: transaction.created_at,
                recipient: recipient_identifier
            }
        });
    } catch (error) {
        console.error('Internal transfer error:', error);
        res.status(500).json({ error: 'Transfer failed' });
    }
});

// ============================================================
// EXTERNAL TRANSFER — payout to a saved beneficiary's bank account,
// via Flutterwave where the beneficiary's country is supported.
// Funds are reserved (debited) immediately and only finalized on
// webhook confirmation; a failed payout is reversed automatically.
// ============================================================
router.post('/external', async (req, res) => {
    try {
        const { error, value } = externalTransferSchema.validate(req.body);
        if (error) return res.status(400).json({ error: error.details[0].message });

        const { from_account_id, amount, currency, beneficiary_id, description } = value;

        const { data: fromAccount } = await req.supabase
            .from('accounts')
            .select('*, account_balances(*)')
            .eq('id', from_account_id)
            .eq('user_id', req.user.id)
            .single();

        if (!fromAccount) return res.status(404).json({ error: 'Source account not found' });

        const { data: beneficiary } = await req.supabase
            .from('beneficiaries')
            .select('*')
            .eq('id', beneficiary_id)
            .eq('user_id', req.user.id)
            .eq('is_active', true)
            .single();

        if (!beneficiary) return res.status(404).json({ error: 'Beneficiary not found' });

        if (!flutterwave.isPayoutSupported(beneficiary.country)) {
            return res.status(400).json({
                error: `External payouts to ${beneficiary.country || 'this country'} aren't available yet. ` +
                       `Supported destinations today: Nigeria, Ghana, Kenya, South Africa, Uganda, Tanzania.`
            });
        }

        if (!beneficiary.bank_code) {
            return res.status(400).json({
                error: 'This beneficiary is missing a bank code. Please edit the beneficiary and select their bank from the list to enable payouts.'
            });
        }

        const { data: sender } = await req.supabase
            .from('users')
            .select('is_frozen, is_suspended, freeze_transfers')
            .eq('id', req.user.id)
            .single();

        if (sender.is_suspended || sender.is_frozen || sender.freeze_transfers) {
            return res.status(403).json({ error: 'Transfers are currently unavailable on this account.' });
        }

        const availableBalance = parseFloat(fromAccount.account_balances?.available_balance || 0);
        const fee = Math.max(5, amount * 0.01);
        if (availableBalance < amount + fee) {
            return res.status(400).json({ error: 'Insufficient balance to cover amount plus fee', available: availableBalance, fee });
        }

        const limitCheck = await checkTransferLimits(req.supabase, req.user.id, amount);
        if (!limitCheck.ok) return res.status(400).json(limitCheck.response);

        const otpResult = await requireOtpIfNeeded(req, res, {
            type: 'international',
            amount,
            context: { beneficiary_id, external: true }
        });
        if (!otpResult.passed) return;

        const fraudService = new FraudDetectionService(req.supabase);
        const fraudResult = await fraudService.analyzeTransaction(req.user.id, {
            amount, currency, recipient_country: beneficiary.country
        });

        const ledger = new LedgerService(req.supabase);
        const transaction = await ledger.createTransaction({
            type: 'external_transfer',
            debitAccountId: fromAccount.id,
            amount,
            currency,
            fee,
            description: description || `Transfer to ${beneficiary.name}`,
            initiatedBy: req.user.id,
            metadata: {
                beneficiary_id,
                recipient_name: beneficiary.name,
                recipient_bank: beneficiary.bank_name,
                recipient_country: beneficiary.country,
                fraud_flags: fraudResult.flags,
                risk_level: fraudResult.riskLevel,
                provider: 'flutterwave'
            }
        });

        // Reserve funds immediately (debit only — no credit side exists,
        // the money is leaving the platform). Transaction stays 'pending'
        // until the provider confirms.
        await ledger.debitAccount(fromAccount.id, amount + fee);
        await req.supabase.from('transactions').update({ status: 'processing' }).eq('id', transaction.id);

        try {
            const payout = await flutterwave.initiateTransfer({
                reference: transaction.reference,
                bankCode: beneficiary.bank_code,
                accountNumber: beneficiary.account_number,
                amount,
                currency,
                narration: description || `RejoiceFutureBank transfer`,
                beneficiaryName: beneficiary.name
            });

            await req.supabase
                .from('transactions')
                .update({ metadata: { ...transaction.metadata, flw_transfer_id: payout.id, flw_status: payout.status } })
                .eq('id', transaction.id);

            await bumpDailyUsage(req.supabase, req.user.id, { transferAmount: amount, transferCount: 1 });

            const notificationService = new NotificationService(req.supabase);
            await notificationService.create(
                req.user.id, 'transfer', 'Transfer Processing',
                `Your transfer of ${currency} ${amount.toLocaleString()} to ${beneficiary.name} is being processed.`
            );

            res.status(202).json({
                transaction,
                message: 'Transfer initiated and is being processed',
                receipt: {
                    reference: transaction.reference,
                    amount, currency, fee, total: amount + fee,
                    date: transaction.created_at,
                    recipient: beneficiary.name,
                    status: 'processing'
                }
            });
        } catch (payoutError) {
            // Provider rejected the transfer — reverse the reservation.
            console.error('Flutterwave payout failed:', payoutError);
            await ledger.creditAccount(fromAccount.id, amount + fee);
            await req.supabase.from('transactions').update({ status: 'failed' }).eq('id', transaction.id);
            res.status(502).json({ error: 'The payout provider could not process this transfer. Your funds have not been deducted.' });
        }
    } catch (error) {
        console.error('External transfer error:', error);
        res.status(500).json({ error: 'Transfer failed' });
    }
});

// Legacy generic endpoint — kept only so old clients don't 404, but it
// now just explains the split instead of silently doing the wrong thing.
router.post('/', (req, res) => {
    res.status(410).json({
        error: 'This endpoint has been split. Use POST /transfers/internal for RejoiceFutureBank-to-RejoiceFutureBank transfers, or POST /transfers/external for payouts to a saved beneficiary.'
    });
});

// Get transfer history
router.get('/history', async (req, res) => {
    try {
        const { limit = 50, offset = 0, status } = req.query;

        let query = req.supabase
            .from('transactions')
            .select('*')
            .eq('initiated_by', req.user.id)
            .in('transaction_type', ['internal_transfer', 'external_transfer', 'transfer'])
            .order('created_at', { ascending: false })
            .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

        if (status) query = query.eq('status', status);

        const { data: transfers, error } = await query;
        if (error) throw error;

        res.json({ transfers });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch transfers' });
    }
});

// Beneficiaries
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

// List banks for a country — used by the frontend to let the user pick
// a real bank_code instead of typing free text.
router.get('/banks/:country', async (req, res) => {
    try {
        const banks = await flutterwave.listBanks(req.params.country);
        res.json({ banks });
    } catch (error) {
        res.status(502).json({ error: 'Failed to fetch bank list' });
    }
});

router.post('/beneficiaries', async (req, res) => {
    try {
        const { name, account_number, bank_name, bank_code, country, currency } = req.body;

        if (!name || !account_number || !bank_name || !country) {
            return res.status(400).json({ error: 'Name, account number, bank name, and country are required' });
        }

        const { data: beneficiary, error } = await req.supabase
            .from('beneficiaries')
            .insert({
                id: uuidv4(),
                user_id: req.user.id,
                name, account_number, bank_name, bank_code, country, currency
            })
            .select()
            .single();

        if (error) throw error;

        const notificationService = new NotificationService(req.supabase);
        await notificationService.create(
            req.user.id, 'beneficiary_added', 'New Beneficiary Added',
            `${name} has been added as a beneficiary.`
        );

        res.status(201).json(beneficiary);
    } catch (error) {
        console.error('Create beneficiary error:', error);
        res.status(500).json({ error: 'Failed to create beneficiary' });
    }
});

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

// ============================================================
// WITHDRAWAL — kept for existing UI, now just an alias that
// explains itself. "Withdrawing" to an external bank account is the
// same operation as an external transfer without a saved beneficiary;
// that requires the same bank_code/account_number a beneficiary needs,
// so we route people to add a beneficiary first rather than pretend a
// free-text "destination" field can move real money.
// ============================================================
router.post('/withdraw', async (req, res) => {
    res.status(400).json({
        error: 'To withdraw funds, add the destination as a beneficiary (with their bank selected from the list) and use External Transfer. This ensures we have the correct bank details to send your money.'
    });
});

module.exports = router;