// ============================================================
// ALPACA SERVICE — paper trading (simulated money, real market
// data and real order execution against Alpaca's paper environment).
// This replaces the old hardcoded current_price column with live
// quotes, and replaces "just move numbers in our own DB" with an
// actual broker order lifecycle (pending -> filled).
//
// Requires: ALPACA_API_KEY_ID, ALPACA_API_SECRET_KEY
// Paper trading base URLs (never point these at live endpoints
// without a deliberate, separate decision):
//   Trading:     https://paper-api.alpaca.markets
//   Market data: https://data.alpaca.markets
// ============================================================

const TRADING_BASE = 'https://paper-api.alpaca.markets';
const DATA_BASE = 'https://data.alpaca.markets';

function authHeaders() {
    if (!process.env.ALPACA_API_KEY_ID || !process.env.ALPACA_API_SECRET_KEY) {
        throw new Error('Alpaca is not configured (missing ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY)');
    }
    return {
        'APCA-API-KEY-ID': process.env.ALPACA_API_KEY_ID,
        'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET_KEY,
        'Content-Type': 'application/json'
    };
}

async function alpacaFetch(base, path, options = {}) {
    const response = await fetch(`${base}${path}`, { ...options, headers: authHeaders() });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        console.error('Alpaca error:', path, data);
        throw new Error(data.message || 'Alpaca request failed');
    }
    return data;
}

// Latest quote (bid/ask) for a symbol. Used to price the "Buy"/"Sell"
// preview in the UI before an order is placed.
async function getLatestQuote(symbol) {
    const data = await alpacaFetch(DATA_BASE, `/v2/stocks/${symbol}/quotes/latest`);
    const quote = data.quote;
    if (!quote) throw new Error(`No quote available for ${symbol}`);
    // Mid-price between bid and ask as the reference price.
    return {
        symbol,
        bid: quote.bp,
        ask: quote.ap,
        price: (quote.bp + quote.ap) / 2,
        timestamp: quote.t
    };
}

async function getLatestQuotes(symbols) {
    const results = await Promise.all(
        symbols.map((s) => getLatestQuote(s).catch((e) => ({ symbol: s, error: e.message })))
    );
    return results;
}

// Places a market order in Alpaca's paper account. For "buy", notional
// (dollar amount) orders let a customer say "buy $100 of AAPL" without
// doing fractional-share math themselves; for "sell" we use qty since
// customers are selling shares they already hold.
async function placeMarketOrder({ symbol, side, notional, qty, clientOrderId }) {
    const body = {
        symbol,
        side, // 'buy' | 'sell'
        type: 'market',
        time_in_force: 'day',
        client_order_id: clientOrderId
    };
    if (notional) body.notional = notional.toFixed(2);
    else if (qty) body.qty = qty.toString();
    else throw new Error('Either notional or qty is required');

    return alpacaFetch(TRADING_BASE, '/v2/orders', {
        method: 'POST',
        body: JSON.stringify(body)
    });
}

async function getOrder(orderId) {
    return alpacaFetch(TRADING_BASE, `/v2/orders/${orderId}`);
}

async function getAccount() {
    return alpacaFetch(TRADING_BASE, '/v2/account');
}

module.exports = { getLatestQuote, getLatestQuotes, placeMarketOrder, getOrder, getAccount };