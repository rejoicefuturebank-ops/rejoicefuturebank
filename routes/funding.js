const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const LedgerService = require('../services/ledger');
const stripeService = require('../services/stripeService');
const flutterwaveService = require('../services/flutterwaveService');
const { fundingInitiateSchema } = require('../utils/validators');

router.use(authenticate);

// Initiate a deposit. Nothing is credited here — the transaction is
// created as 'pending' and only completed when the matching webhook
// (webhooks.js) confirms the payment actually succeeded.
router.post('/initiate', async (req, res) => {
    try {
        const { error, value } = fundingInitiateSchema.validate(req.body);
        if (error) return res.status(400).json({ error: error.details[0].message });

        const { account_id, amount, currency, provider } = value;

        const { data: account } = await req.supabase
            .from('accounts')
            .select('*')
            .eq('id', account_id)
            .eq('user_id', req.user.id)
            .single();

        if (!account) return res.status(404).json({ error: 'Account not found' });
        if (account.currency !== currency) {
            return res.status(400).json({ error: `This account is in ${account.currency}, not ${currency}.` });
        }

        const { data: user } = await req.supabase
            .from('users')
            .select('email')
            .eq('id', req.user.id)
            .single();

        const { data: profile } = await req.supabase
            .from('profiles')
            .select('full_name')
            .eq('user_id', req.user.id)
            .single();

        const ledger = new LedgerService(req.supabase);
        const transaction = await ledger.createTransaction({
            type: 'funding',
            creditAccountId: account.id,
            amount,
            currency,
            description: `Account funding via ${provider}`,
            initiatedBy: req.user.id,
            metadata: { provider, status_detail: 'awaiting_payment' }
        });
        // Note: transaction status stays 'pending' — completeTransaction()
        // is only called from the webhook handler once payment clears.

        if (provider === 'stripe') {
            const successUrl = `${process.env.FRONTEND_URL || ''}/dashboard.html?funding_ref=${transaction.reference}&funding_status=success`;
            const cancelUrl = `${process.env.FRONTEND_URL || ''}/dashboard.html?funding_ref=${transaction.reference}&funding_status=cancelled`;

            const session = await stripeService.createFundingCheckoutSession({
                amount, currency, accountId: account.id, userId: req.user.id,
                reference: transaction.reference,
                successUrl, cancelUrl
            });

            await req.supabase
                .from('transactions')
                .update({ metadata: { ...transaction.metadata, stripe_checkout_session_id: session.id } })
                .eq('id', transaction.id);

            return res.json({
                provider: 'stripe',
                payment_link: session.url,
                reference: transaction.reference
            });
        }

        if (provider === 'flutterwave') {
            const redirectUrl = `${process.env.FRONTEND_URL || ''}/dashboard.html?funding_ref=${transaction.reference}`;
            const payment = await flutterwaveService.createFundingLink({
                txRef: transaction.reference,
                amount, currency,
                accountId: account.id,
                userId: req.user.id,
                customerEmail: user.email,
                customerName: profile?.full_name || user.email,
                redirectUrl
            });

            return res.json({
                provider: 'flutterwave',
                payment_link: payment.link,
                reference: transaction.reference
            });
        }

        res.status(400).json({ error: 'Unsupported provider' });
    } catch (error) {
        console.error('Funding initiate error:', error);
        res.status(500).json({ error: 'Failed to start deposit' });
    }
});

// Poll status after redirect back from a hosted payment page (Flutterwave)
router.get('/status/:reference', async (req, res) => {
    try {
        const { data: transaction } = await req.supabase
            .from('transactions')
            .select('reference, status, amount, currency, completed_at')
            .eq('reference', req.params.reference)
            .eq('initiated_by', req.user.id)
            .single();

        if (!transaction) return res.status(404).json({ error: 'Transaction not found' });
        res.json({ transaction });
    } catch (error) {
        res.status(500).json({ error: 'Failed to check status' });
    }
});

module.exports = router;