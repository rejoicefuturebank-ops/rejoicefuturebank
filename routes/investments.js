const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const LedgerService = require('../services/ledger');
const alpaca = require('../services/alpacaService');

router.use(authenticate);

// Get portfolio
router.get('/portfolio', async (req, res) => {
    try {
        const { data: portfolio } = await req.supabase
            .from('investment_portfolios')
            .select('*, investment_holdings(*, investment_assets(*))')
            .eq('user_id', req.user.id)
            .single();

        if (!portfolio) {
            const { data: newPortfolio } = await req.supabase
                .from('investment_portfolios')
                .insert({ id: uuidv4(), user_id: req.user.id })
                .select()
                .single();
            return res.json({ portfolio: newPortfolio, holdings: [] });
        }

        // Refresh holding values against live prices rather than the
        // stale value stored at time of purchase.
        const holdings = portfolio.investment_holdings || [];
        const symbols = holdings.map((h) => h.investment_assets?.symbol).filter(Boolean);
        const quotes = symbols.length ? await alpaca.getLatestQuotes(symbols) : [];
        const quoteMap = Object.fromEntries(quotes.filter((q) => !q.error).map((q) => [q.symbol, q.price]));

        let currentValue = 0;
        let totalGainLoss = 0;
        for (const h of holdings) {
            const symbol = h.investment_assets?.symbol;
            const livePrice = quoteMap[symbol];
            if (livePrice) {
                h.current_value = parseFloat((h.quantity * livePrice).toFixed(2));
                h.unrealized_gain_loss = parseFloat((h.current_value - h.quantity * h.avg_cost).toFixed(2));
            }
            currentValue += parseFloat(h.current_value || 0);
            totalGainLoss += parseFloat(h.unrealized_gain_loss || 0);
        }

        res.json({
            ...portfolio,
            current_value: currentValue,
            total_gain_loss: totalGainLoss,
            investment_holdings: holdings
        });
    } catch (error) {
        console.error('Portfolio error:', error);
        res.status(500).json({ error: 'Failed to fetch portfolio' });
    }
});

// Get available assets with live prices
router.get('/assets', async (req, res) => {
    try {
        const { data: assets } = await req.supabase
            .from('investment_assets')
            .select('*')
            .eq('is_active', true)
            .order('symbol');

        const symbols = (assets || []).map((a) => a.symbol);
        const quotes = symbols.length ? await alpaca.getLatestQuotes(symbols) : [];
        const quoteMap = Object.fromEntries(quotes.filter((q) => !q.error).map((q) => [q.symbol, q.price]));

        const priced = (assets || []).map((a) => ({
            ...a,
            current_price: quoteMap[a.symbol] ?? a.current_price, // fall back to last known if market data unavailable
            price_source: quoteMap[a.symbol] ? 'alpaca_live' : 'stale_fallback'
        }));

        res.json({ assets: priced });
    } catch (error) {
        console.error('Assets fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch assets' });
    }
});

async function waitForFill(orderId, attempts = 6, delayMs = 800) {
    for (let i = 0; i < attempts; i++) {
        const order = await alpaca.getOrder(orderId);
        if (order.status === 'filled') return order;
        if (['canceled', 'expired', 'rejected'].includes(order.status)) return order;
        await new Promise((r) => setTimeout(r, delayMs));
    }
    return alpaca.getOrder(orderId); // return whatever the last known state is
}

// Buy asset — places a real paper-trading market order
router.post('/buy', async (req, res) => {
    try {
        const { asset_id, amount, account_id } = req.body; // amount = dollar amount to invest

        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'Please enter a valid amount to invest' });
        }

        const { data: asset } = await req.supabase
            .from('investment_assets')
            .select('*')
            .eq('id', asset_id)
            .single();

        if (!asset) return res.status(404).json({ error: 'Asset not found' });

        const { data: account } = await req.supabase
            .from('accounts')
            .select('*, account_balances(*)')
            .eq('id', account_id)
            .eq('user_id', req.user.id)
            .single();

        if (!account) return res.status(404).json({ error: 'Account not found' });
        const availableBalance = parseFloat(account.account_balances?.available_balance || 0);
        if (availableBalance < amount) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }

        // Place the real paper order first — don't touch the ledger until
        // we know what actually happened with the trade.
        const clientOrderId = uuidv4();
        const order = await alpaca.placeMarketOrder({
            symbol: asset.symbol,
            side: 'buy',
            notional: amount,
            clientOrderId
        });

        const filledOrder = await waitForFill(order.id);

        if (filledOrder.status !== 'filled') {
            return res.status(202).json({
                message: `Order placed but not yet filled (status: ${filledOrder.status}). This can happen outside market hours.`,
                order_id: filledOrder.id,
                status: filledOrder.status
            });
        }

        const filledQty = parseFloat(filledOrder.filled_qty);
        const filledPrice = parseFloat(filledOrder.filled_avg_price);
        const totalAmount = filledQty * filledPrice;

        // Debit the account for exactly what was actually filled.
        const ledger = new LedgerService(req.supabase);
        await ledger.debitAccount(account.id, totalAmount);

        let { data: portfolio } = await req.supabase
            .from('investment_portfolios')
            .select('*')
            .eq('user_id', req.user.id)
            .single();

        if (!portfolio) {
            const { data } = await req.supabase
                .from('investment_portfolios')
                .insert({ id: uuidv4(), user_id: req.user.id })
                .select()
                .single();
            portfolio = data;
        }

        await req.supabase.from('investment_transactions').insert({
            id: uuidv4(),
            portfolio_id: portfolio.id,
            asset_id,
            transaction_type: 'buy',
            quantity: filledQty,
            price: filledPrice,
            total_amount: totalAmount,
            broker_order_id: filledOrder.id
        });

        const { data: existingHolding } = await req.supabase
            .from('investment_holdings')
            .select('*')
            .eq('portfolio_id', portfolio.id)
            .eq('asset_id', asset_id)
            .single();

        if (existingHolding) {
            const newQty = parseFloat(existingHolding.quantity) + filledQty;
            const newAvgCost = (parseFloat(existingHolding.avg_cost) * parseFloat(existingHolding.quantity) + totalAmount) / newQty;
            await req.supabase.from('investment_holdings').update({
                quantity: newQty,
                avg_cost: newAvgCost,
                current_value: newQty * filledPrice,
                unrealized_gain_loss: (newQty * filledPrice) - (newQty * newAvgCost)
            }).eq('id', existingHolding.id);
        } else {
            await req.supabase.from('investment_holdings').insert({
                id: uuidv4(),
                portfolio_id: portfolio.id,
                asset_id,
                quantity: filledQty,
                avg_cost: filledPrice,
                current_value: totalAmount,
                unrealized_gain_loss: 0
            });
        }

        await req.supabase.from('investment_portfolios').update({
            total_invested: parseFloat(portfolio.total_invested || 0) + totalAmount,
            current_value: parseFloat(portfolio.current_value || 0) + totalAmount
        }).eq('id', portfolio.id);

        res.json({
            message: 'Purchase completed',
            filled_quantity: filledQty,
            filled_price: filledPrice,
            totalAmount,
            asset: asset.symbol,
            order_id: filledOrder.id
        });
    } catch (error) {
        console.error('Buy error:', error);
        res.status(500).json({ error: error.message || 'Purchase failed' });
    }
});

// Sell asset — places a real paper-trading market order
router.post('/sell', async (req, res) => {
    try {
        const { asset_id, quantity, account_id } = req.body;

        if (!quantity || quantity <= 0) {
            return res.status(400).json({ error: 'Please enter a valid quantity to sell' });
        }

        const { data: asset } = await req.supabase
            .from('investment_assets')
            .select('*')
            .eq('id', asset_id)
            .single();
        if (!asset) return res.status(404).json({ error: 'Asset not found' });

        const { data: portfolio } = await req.supabase
            .from('investment_portfolios')
            .select('*')
            .eq('user_id', req.user.id)
            .single();
        if (!portfolio) return res.status(404).json({ error: 'No portfolio found' });

        const { data: holding } = await req.supabase
            .from('investment_holdings')
            .select('*')
            .eq('portfolio_id', portfolio.id)
            .eq('asset_id', asset_id)
            .single();

        if (!holding || parseFloat(holding.quantity) < quantity) {
            return res.status(400).json({ error: 'Insufficient holdings' });
        }

        const clientOrderId = uuidv4();
        const order = await alpaca.placeMarketOrder({
            symbol: asset.symbol,
            side: 'sell',
            qty: quantity,
            clientOrderId
        });

        const filledOrder = await waitForFill(order.id);

        if (filledOrder.status !== 'filled') {
            return res.status(202).json({
                message: `Order placed but not yet filled (status: ${filledOrder.status}). This can happen outside market hours.`,
                order_id: filledOrder.id,
                status: filledOrder.status
            });
        }

        const filledQty = parseFloat(filledOrder.filled_qty);
        const filledPrice = parseFloat(filledOrder.filled_avg_price);
        const totalAmount = filledQty * filledPrice;
        const costBasis = parseFloat(holding.avg_cost) * filledQty;
        const gainLoss = totalAmount - costBasis;

        await req.supabase.from('investment_transactions').insert({
            id: uuidv4(),
            portfolio_id: portfolio.id,
            asset_id,
            transaction_type: 'sell',
            quantity: filledQty,
            price: filledPrice,
            total_amount: totalAmount,
            broker_order_id: filledOrder.id
        });

        const newQty = parseFloat(holding.quantity) - filledQty;
        if (newQty <= 0) {
            await req.supabase.from('investment_holdings').delete().eq('id', holding.id);
        } else {
            await req.supabase.from('investment_holdings').update({
                quantity: newQty,
                current_value: newQty * filledPrice,
                unrealized_gain_loss: (newQty * filledPrice) - (newQty * parseFloat(holding.avg_cost))
            }).eq('id', holding.id);
        }

        const ledger = new LedgerService(req.supabase);
        await ledger.creditAccount(account_id, totalAmount);

        res.json({
            message: 'Sale completed',
            filled_quantity: filledQty,
            filled_price: filledPrice,
            totalAmount,
            gainLoss,
            order_id: filledOrder.id
        });
    } catch (error) {
        console.error('Sell error:', error);
        res.status(500).json({ error: error.message || 'Sale failed' });
    }
});

module.exports = router;