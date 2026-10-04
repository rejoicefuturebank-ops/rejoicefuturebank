// ============================================================
// FLUTTERWAVE SERVICE — inbound funding AND outbound payouts.
// Flutterwave's Transfers API genuinely supports paying out to
// external bank accounts in its supported markets (NG, GH, KE, ZA,
// and others) — unlike Stripe, which needs a full Connect program
// for that. This is why outbound "external transfer" goes through
// Flutterwave rather than Stripe.
//
// Requires: FLW_SECRET_KEY, FLW_WEBHOOK_HASH
// Uses the built-in fetch (Node 18+) — no extra dependency needed.
// ============================================================

const FLW_BASE = 'https://api.flutterwave.com/v3';

function authHeaders() {
    if (!process.env.FLW_SECRET_KEY) {
        throw new Error('Flutterwave is not configured (missing FLW_SECRET_KEY)');
    }
    return {
        Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
        'Content-Type': 'application/json'
    };
}

async function flwRequest(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${FLW_BASE}${path}`, {
        method,
        headers: authHeaders(),
        body: body ? JSON.stringify(body) : undefined
    });

    const data = await response.json();

    if (!response.ok || data.status === 'error') {
        console.error('Flutterwave error:', path, data);
        throw new Error(data.message || 'Flutterwave request failed');
    }

    return data;
}

// Countries where Flutterwave's payout (Transfers) network is supported
// for this integration. Extend as you verify support with Flutterwave.
const SUPPORTED_PAYOUT_COUNTRIES = ['NG', 'GH', 'KE', 'ZA', 'UG', 'TZ'];

function isPayoutSupported(countryCode) {
    return SUPPORTED_PAYOUT_COUNTRIES.includes((countryCode || '').toUpperCase());
}

// --- FUNDING (inbound) ---
// Creates a hosted payment link the customer completes on Flutterwave's
// side (card, bank transfer, or mobile money depending on their country).
async function createFundingLink({ txRef, amount, currency, accountId, userId, customerEmail, customerName, redirectUrl }) {
    const data = await flwRequest('/payments', {
        method: 'POST',
        body: {
            tx_ref: txRef,
            amount,
            currency,
            redirect_url: redirectUrl,
            customer: { email: customerEmail, name: customerName },
            customizations: { title: 'RejoiceFutureBank', description: 'Add money to your account' },
            meta: { account_id: accountId, user_id: userId, purpose: 'account_funding' }
        }
    });

    return data.data; // { link, ... }
}

// Verifies a transaction by Flutterwave's numeric transaction id (from
// the webhook payload or the redirect callback).
async function verifyTransaction(transactionId) {
    const data = await flwRequest(`/transactions/${transactionId}/verify`);
    return data.data;
}

// --- PAYOUTS (outbound / external transfer) ---
async function listBanks(countryCode) {
    const data = await flwRequest(`/banks/${countryCode}`);
    return data.data;
}

async function initiateTransfer({ reference, bankCode, accountNumber, amount, currency, narration, beneficiaryName }) {
    const data = await flwRequest('/transfers', {
        method: 'POST',
        body: {
            account_bank: bankCode,
            account_number: accountNumber,
            amount,
            currency,
            narration,
            reference,
            beneficiary_name: beneficiaryName
        }
    });
    return data.data; // { id, status: 'NEW' | 'PENDING', ... }
}

async function getTransferStatus(transferId) {
    const data = await flwRequest(`/transfers/${transferId}`);
    return data.data;
}

// Flutterwave signs webhooks with a static secret hash you set in your
// dashboard, sent back verbatim in the 'verif-hash' header — not an
// HMAC signature like Stripe. Simple equality check.
function verifyWebhookHash(headerValue) {
    return Boolean(process.env.FLW_WEBHOOK_HASH) && headerValue === process.env.FLW_WEBHOOK_HASH;
}

module.exports = {
    isPayoutSupported,
    createFundingLink,
    verifyTransaction,
    listBanks,
    initiateTransfer,
    getTransferStatus,
    verifyWebhookHash
};