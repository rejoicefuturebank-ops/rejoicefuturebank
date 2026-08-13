const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const NotificationService = require('../services/notifications');

router.use(authenticate);

// Get savings accounts
router.get('/', async (req, res) => {
    try {
        const { data: accounts } = await req.supabase
            .from('savings_accounts')
            .select('*')
            .eq('user_id', req.user.id)
            .eq('status', 'active')
            .order('created_at', { ascending: false });

        res.json({ accounts: accounts || [] });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch savings' });
    }
});

// Create savings account
router.post('/', async (req, res) => {
    try {
        const { name, savings_type, currency, target_amount, interest_rate, maturity_date, auto_save_enabled, auto_save_amount, auto_save_frequency } = req.body;

        const { data: account, error } = await req.supabase
            .from('savings_accounts')
            .insert({
                id: uuidv4(),
                user_id: req.user.id,
                name,
                savings_type: savings_type || 'flexible',
                currency: currency || 'USD',
                target_amount,
                interest_rate: interest_rate || 2.5,
                maturity_date,
                auto_save_enabled,
                auto_save_amount,
                auto_save_frequency
            })
            .select()
            .single();

        if (error) throw error;

        const notificationService = new NotificationService(req.supabase);
        await notificationService.create(
            req.user.id,
            'savings_created',
            'Savings Account Created',
            `Your "${name}" savings account has been created with ${interest_rate || 2.5}% interest rate.`
        );

        res.status(201).json(account);
    } catch (error) {
        console.error('Create savings error:', error);
        res.status(500).json({ error: 'Failed to create savings account' });
    }
});

// Deposit to savings
router.post('/:id/deposit', async (req, res) => {
    try {
        const { amount } = req.body;

        const { data: account } = await req.supabase
            .from('savings_accounts')
            .select('*')
            .eq('id', req.params.id)
            .eq('user_id', req.user.id)
            .single();

        if (!account) return res.status(404).json({ error: 'Savings account not found' });

        const newBalance = parseFloat(account.balance) + parseFloat(amount);

        await req.supabase
            .from('savings_accounts')
            .update({ balance: newBalance })
            .eq('id', req.params.id);

        // Record transaction
        await req.supabase
            .from('savings_transactions')
            .insert({
                id: uuidv4(),
                savings_account_id: req.params.id,
                transaction_type: 'deposit',
                amount,
                balance_after: newBalance,
                description: 'Savings deposit'
            });

        res.json({ message: 'Deposit successful', newBalance });
    } catch (error) {
        res.status(500).json({ error: 'Deposit failed' });
    }
});

// Withdraw from savings
router.post('/:id/withdraw', async (req, res) => {
    try {
        const { amount } = req.body;

        const { data: account } = await req.supabase
            .from('savings_accounts')
            .select('*')
            .eq('id', req.params.id)
            .eq('user_id', req.user.id)
            .single();

        if (!account) return res.status(404).json({ error: 'Savings account not found' });
        if (parseFloat(account.balance) < amount) return res.status(400).json({ error: 'Insufficient savings' });

        if (account.savings_type === 'fixed' && new Date() < new Date(account.maturity_date)) {
            return res.status(400).json({ error: 'Fixed savings cannot be withdrawn before maturity date' });
        }

        const newBalance = parseFloat(account.balance) - parseFloat(amount);

        await req.supabase
            .from('savings_accounts')
            .update({ balance: newBalance })
            .eq('id', req.params.id);

        await req.supabase
            .from('savings_transactions')
            .insert({
                id: uuidv4(),
                savings_account_id: req.params.id,
                transaction_type: 'withdrawal',
                amount: -amount,
                balance_after: newBalance,
                description: 'Savings withdrawal'
            });

        res.json({ message: 'Withdrawal successful', newBalance });
    } catch (error) {
        res.status(500).json({ error: 'Withdrawal failed' });
    }
});

module.exports = router;