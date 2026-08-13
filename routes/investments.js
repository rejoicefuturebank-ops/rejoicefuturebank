const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

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
            // Create portfolio
            const { data: newPortfolio } = await req.supabase
                .from('investment_portfolios')
                .insert({ id: uuidv4(), user_id: req.user.id })
                .select()
                .single();
            return res.json({ portfolio: newPortfolio, holdings: [] });
        }

        res.json(portfolio);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch portfolio' });
    }
});

// Get available assets
router.get('/assets', async (req, res) => {
    try {
        const { data: assets } = await req.supabase
            .from('investment_assets')
            .select('*')
            .eq('is_active', true)
            .order('symbol');

        res.json({ assets });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch assets' });
    }
});

// Buy asset
router.post('/buy', async (req, res) => {
    try {
        const { asset_id, quantity, account_id } = req.body;

        const { data: asset } = await req.supabase
            .from('investment_assets')
            .select('*')
            .eq('id', asset_id)
            .single();

        if (!asset) return res.status(404).json({ error: 'Asset not found' });

        const totalAmount = parseFloat(asset.current_price) * parseFloat(quantity);

        // Check balance
        const { data: account } = await req.supabase
            .from('accounts')
            .select('*, account_balances(*)')
            .eq('id', account_id)
            .eq('user_id', req.user.id)
            .single();

        if (!account) return res.status(404).json({ error: 'Account not found' });
        if (parseFloat(account.account_balances.available_balance) < totalAmount) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }

        // Get or create portfolio
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

        // Record transaction
        await req.supabase
            .from('investment_transactions')
            .insert({
                id: uuidv4(),
                portfolio_id: portfolio.id,
                asset_id,
                transaction_type: 'buy',
                quantity,
                price: asset.current_price,
                total_amount: totalAmount
            });

        // Update or create holding
        const { data: existingHolding } = await req.supabase
            .from('investment_holdings')
            .select('*')
            .eq('portfolio_id', portfolio.id)
            .eq('asset_id', asset_id)
            .single();

        if (existingHolding) {
            const newQty = parseFloat(existingHolding.quantity) + parseFloat(quantity);
            const newAvgCost = (parseFloat(existingHolding.avg_cost) * parseFloat(existingHolding.quantity) + totalAmount) / newQty;
            await req.supabase
                .from('investment_holdings')
                .update({
                    quantity: newQty,
                    avg_cost: newAvgCost,
                    current_value: newQty * parseFloat(asset.current_price),
                    unrealized_gain_loss: (newQty * parseFloat(asset.current_price)) - (newQty * newAvgCost)
                })
                .eq('id', existingHolding.id);
        } else {
            await req.supabase
                .from('investment_holdings')
                .insert({
                    id: uuidv4(),
                    portfolio_id: portfolio.id,
                    asset_id,
                    quantity,
                    avg_cost: asset.current_price,
                    current_value: totalAmount,
                    unrealized_gain_loss: 0
                });
        }

        // Update portfolio totals
        await req.supabase
            .from('investment_portfolios')
            .update({
                total_invested: parseFloat(portfolio.total_invested || 0) + totalAmount,
                current_value: parseFloat(portfolio.current_value || 0) + totalAmount
            })
            .eq('id', portfolio.id);

        // Debit account
        await req.supabase
            .from('account_balances')
            .update({
                available_balance: parseFloat(account.account_balances.available_balance) - totalAmount
            })
            .eq('account_id', account_id);

        res.json({ message: 'Purchase completed', totalAmount, asset: asset.symbol });
    } catch (error) {
        console.error('Buy error:', error);
        res.status(500).json({ error: 'Purchase failed' });
    }
});

// Sell asset
router.post('/sell', async (req, res) => {
    try {
        const { asset_id, quantity, account_id } = req.body;

        const { data: asset } = await req.supabase
            .from('investment_assets')
            .select('*')
            .eq('id', asset_id)
            .single();

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

        const totalAmount = parseFloat(asset.current_price) * parseFloat(quantity);
        const costBasis = parseFloat(holding.avg_cost) * parseFloat(quantity);
        const gainLoss = totalAmount - costBasis;

        // Record transaction
        await req.supabase
            .from('investment_transactions')
            .insert({
                id: uuidv4(),
                portfolio_id: portfolio.id,
                asset_id,
                transaction_type: 'sell',
                quantity,
                price: asset.current_price,
                total_amount: totalAmount
            });

        // Update holding
        const newQty = parseFloat(holding.quantity) - parseFloat(quantity);
        if (newQty <= 0) {
            await req.supabase.from('investment_holdings').delete().eq('id', holding.id);
        } else {
            await req.supabase
                .from('investment_holdings')
                .update({
                    quantity: newQty,
                    current_value: newQty * parseFloat(asset.current_price),
                    unrealized_gain_loss: (newQty * parseFloat(asset.current_price)) - (newQty * parseFloat(holding.avg_cost))
                })
                .eq('id', holding.id);
        }

        // Credit account
        await req.supabase
            .from('account_balances')
            .update({
                available_balance: req.supabase.rpc('increment_balance', {
                    p_account_id: account_id,
                    p_amount: totalAmount
                }) || totalAmount
            })
            .eq('account_id', account_id);

        // Simple balance update
        const { data: balance } = await req.supabase
            .from('account_balances')
            .select('available_balance')
            .eq('account_id', account_id)
            .single();

        await req.supabase
            .from('account_balances')
            .update({ available_balance: parseFloat(balance.available_balance) + totalAmount })
            .eq('account_id', account_id);

        res.json({ message: 'Sale completed', totalAmount, gainLoss });
    } catch (error) {
        console.error('Sell error:', error);
        res.status(500).json({ error: 'Sale failed' });
    }
});

module.exports = router;