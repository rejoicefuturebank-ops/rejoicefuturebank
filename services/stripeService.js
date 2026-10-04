// ============================================================
// STRIPE SERVICE — inbound funding only.
// Stripe does not have a general "pay any external bank account"
// API without Stripe Connect (a full onboarding/compliance program
// for each recipient). This service intentionally does NOT attempt
// outbound payouts — see flutterwaveService.js for that.
//
// Requires: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
// Uses the official Stripe Node SDK (npm i stripe)
// ============================================================

const Stripe = require('stripe');

let stripeClient = null;
function getClient() {
    if (!stripeClient) {
        if (!process.env.STRIPE_SECRET_KEY) {
            throw new Error('Stripe is not configured (missing STRIPE_SECRET_KEY)');
        }
        stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
    }
    return stripeClient;
}

// Creates a PaymentIntent for a customer funding their RejoiceFutureBank
// account by card. amount is in the major currency unit (e.g. 50.00 USD);
// Stripe wants the minor unit (cents), so we convert.
// Creates a hosted Stripe Checkout Session for funding. Using Checkout
// (vs. building a custom card form with Stripe Elements) keeps the PCI
// scope on Stripe's hosted page and gives a simple redirect-out /
// redirect-back flow, matching the Flutterwave integration's shape.
async function createFundingCheckoutSession({ amount, currency, accountId, userId, reference, successUrl, cancelUrl }) {
    const stripe = getClient();

    const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [{
            price_data: {
                currency: currency.toLowerCase(),
                product_data: { name: 'RejoiceFutureBank account funding' },
                unit_amount: Math.round(amount * 100)
            },
            quantity: 1
        }],
        metadata: {
            account_id: accountId,
            user_id: userId,
            transaction_reference: reference,
            purpose: 'account_funding'
        },
        success_url: successUrl,
        cancel_url: cancelUrl
    });

    return session;
}

async function retrieveIntent(paymentIntentId) {
    const stripe = getClient();
    return stripe.paymentIntents.retrieve(paymentIntentId);
}

// Verifies the raw webhook body against the Stripe-Signature header.
// Must be called with the RAW (unparsed) request body — see webhooks.js
// and the index.js mounting note.
function constructWebhookEvent(rawBody, signatureHeader) {
    const stripe = getClient();
    return stripe.webhooks.constructEvent(
        rawBody,
        signatureHeader,
        process.env.STRIPE_WEBHOOK_SECRET
    );
}

module.exports = { createFundingCheckoutSession, retrieveIntent, constructWebhookEvent };