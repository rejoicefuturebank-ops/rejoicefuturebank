const express = require('express');
const router = express.Router();
const LedgerService = require('../services/ledger');
const NotificationService = require('../services/notifications');
const stripeService = require('../services/stripeService');
const flutterwaveService = require('../services/flutterwaveService');

// NOTE ON MOUNTING: this router must be mounted in index.js BEFORE the
// global express.json() middleware. Stripe's webhook signature check
// needs the untouched raw request body — if express.json() runs first,
// the body is already consumed/parsed and signature verification will
// always fail. Each route below applies its own body parser instead:
//   - /stripe uses express.raw() (Stripe needs the raw bytes)
//   - /flutterwave uses express.json() (it only checks a header, a
//     parsed body is fine)

router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    let event;
    try {
        event = stripeService.constructWebhookEvent(req.body, req.headers['stripe-signature']);
    } catch (err) {
        console.error('Stripe webhook signature verification failed:', err.message);
        return res.status(400).send('Webhook signature verification failed');
    }

    try {
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            if (session.payment_status !== 'paid') {
                return res.json({ received: true, skipped: 'not_paid' });
            }

            const reference = session.metadata?.transaction_reference;
            if (!reference) return res.json({ received: true, skipped: 'no_reference' });

            const { data: transaction } = await req.supabase
                .from('transactions')
                .select('*')
                .eq('reference', reference)
                .single();

            if (!transaction || transaction.status === 'completed') {
                return res.json({ received: true }); // already processed / unknown — idempotent
            }

            const ledger = new LedgerService(req.supabase);
            await ledger.completeTransaction(transaction.id);

            const notificationService = new NotificationService(req.supabase);
            await notificationService.create(
                transaction.initiated_by, 'deposit', 'Deposit Received',
                `Your deposit of ${transaction.currency} ${transaction.amount.toLocaleString()} has been credited.`
            );
        }

        if (event.type === 'checkout.session.expired') {
            const session = event.data.object;
            const reference = session.metadata?.transaction_reference;
            if (reference) {
                await req.supabase.from('transactions').update({ status: 'failed' }).eq('reference', reference);
            }
        }

        res.json({ received: true });
    } catch (error) {
        console.error('Stripe webhook processing error:', error);
        // Still 200 so Stripe doesn't retry into a poison-pill loop for a
        // bug on our side; the error is logged for investigation.
        res.status(200).json({ received: true, error: 'processing_error' });
    }
});

// ============================================================
// FLUTTERWAVE WEBHOOK
// ============================================================
router.post('/flutterwave', express.json(), async (req, res) => {
    if (!flutterwaveService.verifyWebhookHash(req.headers['verif-hash'])) {
        return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    try {
        const event = req.body;

        // Inbound funding confirmation
        if (event.event === 'charge.completed' && event.data?.status === 'successful') {
            // Always re-verify server-side rather than trusting the webhook
            // payload's amount directly.
            const verified = await flutterwaveService.verifyTransaction(event.data.id);
            if (verified.status !== 'successful') {
                return res.json({ received: true, skipped: 'not_verified' });
            }

            const reference = verified.tx_ref;
            const { data: transaction } = await req.supabase
                .from('transactions')
                .select('*')
                .eq('reference', reference)
                .single();

            if (!transaction || transaction.status === 'completed') {
                return res.json({ received: true });
            }

            if (parseFloat(verified.amount) < parseFloat(transaction.amount)) {
                console.error('Flutterwave amount mismatch — refusing to credit', reference);
                await req.supabase.from('transactions').update({ status: 'failed' }).eq('id', transaction.id);
                return res.json({ received: true, skipped: 'amount_mismatch' });
            }

            const ledger = new LedgerService(req.supabase);
            await ledger.completeTransaction(transaction.id);

            const notificationService = new NotificationService(req.supabase);
            await notificationService.create(
                transaction.initiated_by, 'deposit', 'Deposit Received',
                `Your deposit of ${transaction.currency} ${transaction.amount.toLocaleString()} has been credited.`
            );
        }

        // Outbound payout confirmation (from the /transfers/external flow)
        if (event.event === 'transfer.completed') {
            const reference = event.data?.reference;
            const status = event.data?.status; // 'SUCCESSFUL' | 'FAILED'

            const { data: transaction } = await req.supabase
                .from('transactions')
                .select('*')
                .eq('reference', reference)
                .single();

            if (!transaction) return res.json({ received: true, skipped: 'unknown_reference' });

            if (status === 'SUCCESSFUL' && transaction.status !== 'completed') {
                await req.supabase
                    .from('transactions')
                    .update({ status: 'completed', completed_at: new Date().toISOString() })
                    .eq('id', transaction.id);

                const notificationService = new NotificationService(req.supabase);
                await notificationService.create(
                    transaction.initiated_by, 'transfer', 'Transfer Completed',
                    `Your transfer of ${transaction.currency} ${transaction.amount.toLocaleString()} was delivered successfully.`
                );
            }

            if (status === 'FAILED' && transaction.status !== 'failed' && transaction.status !== 'reversed') {
                // Funds were reserved when the payout was initiated — refund them.
                const ledger = new LedgerService(req.supabase);
                await ledger.creditAccount(transaction.debit_account_id, parseFloat(transaction.amount) + parseFloat(transaction.fee || 0));
                await req.supabase.from('transactions').update({ status: 'failed' }).eq('id', transaction.id);

                const notificationService = new NotificationService(req.supabase);
                await notificationService.create(
                    transaction.initiated_by, 'transfer_failed', 'Transfer Failed',
                    `Your transfer of ${transaction.currency} ${transaction.amount.toLocaleString()} could not be delivered and has been refunded.`
                );
            }
        }

        res.json({ received: true });
    } catch (error) {
        console.error('Flutterwave webhook processing error:', error);
        res.status(200).json({ received: true, error: 'processing_error' });
    }
});

module.exports = router;