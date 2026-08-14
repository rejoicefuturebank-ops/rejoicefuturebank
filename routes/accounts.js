const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const LedgerService = require('../services/ledger');
const ExchangeService = require('../services/exchange');
const NotificationService = require('../services/notifications');

router.use(authenticate);

const checkFrozen = require('../middleware/checkFrozen');

// ============================================
// EXCHANGE RATES (MUST BE BEFORE /:id)
// ============================================
router.get('/exchange-rates', async (req, res) => {
    try {
        const exchange = new ExchangeService(req.supabase);
        const rates = await exchange.getAllRates('USD');
        res.json({ base: 'USD', rates });
    } catch (error) {
        console.error('Exchange rates error:', error);
        res.status(500).json({ error: 'Failed to fetch exchange rates' });
    }
});

// ============================================
// CURRENCY CONVERSION (MUST BE BEFORE /:id)
// ============================================
router.post('/convert', checkFrozen, async (req, res) => {
    try {
        const { from_account_id, to_account_id, amount } = req.body;

        if (!from_account_id || !to_account_id || !amount) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const { data: fromAccount } = await req.supabase
            .from('accounts')
            .select('*, account_balances(*)')
            .eq('id', from_account_id)
            .eq('user_id', req.user.id)
            .single();

        const { data: toAccount } = await req.supabase
            .from('accounts')
            .select('*, account_balances(*)')
            .eq('id', to_account_id)
            .eq('user_id', req.user.id)
            .single();

        if (!fromAccount || !toAccount) {
            return res.status(404).json({ error: 'Account not found' });
        }

        if (fromAccount.currency === toAccount.currency) {
            return res.status(400).json({ error: 'Cannot convert to the same currency' });
        }

        const availableBalance = parseFloat(fromAccount.account_balances?.available_balance || 0);
        if (availableBalance < amount) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }

        const exchange = new ExchangeService(req.supabase);
        const conversion = await exchange.convert(amount, fromAccount.currency, toAccount.currency);

        const ledger = new LedgerService(req.supabase);
        const transaction = await ledger.createTransaction({
            type: 'currency_conversion',
            debitAccountId: fromAccount.id,
            creditAccountId: toAccount.id,
            amount: conversion.convertedAmount,
            currency: toAccount.currency,
            fee: conversion.fee,
            description: `Converted ${amount} ${fromAccount.currency} to ${toAccount.currency}`,
            initiatedBy: req.user.id,
            exchangeRate: conversion.rate,
            originalAmount: amount,
            originalCurrency: fromAccount.currency,
            metadata: { conversion }
        });

        await ledger.completeTransaction(transaction.id);

        const notificationService = new NotificationService(req.supabase);
        await notificationService.create(
            req.user.id,
            'conversion',
            'Currency Conversion Complete',
            `Converted ${amount} ${fromAccount.currency} to ${conversion.convertedAmount.toFixed(2)} ${toAccount.currency}`
        );

        res.json({ transaction, conversion });
    } catch (error) {
        console.error('Conversion error:', error);
        res.status(500).json({ error: 'Conversion failed' });
    }
});

// ============================================
// GET USER ACCOUNTS
// ============================================
router.get('/', async (req, res) => {
    try {
        const { data: accounts, error } = await req.supabase
            .from('accounts')
            .select('*, account_balances(*)')
            .eq('user_id', req.user.id)
            .eq('is_active', true);

        if (error) throw error;

        // Calculate total balance in USD
        let totalBalanceUSD = 0;
        const exchange = new ExchangeService(req.supabase);

        for (const account of (accounts || [])) {
            const balance = parseFloat(account.account_balances?.available_balance || 0);
            if (account.currency !== 'USD') {
                try {
                    const rate = await exchange.getRate(account.currency, 'USD');
                    totalBalanceUSD += balance * rate;
                } catch (e) {
                    totalBalanceUSD += balance; // Fallback
                }
            } else {
                totalBalanceUSD += balance;
            }
        }

        res.json({
            accounts: accounts || [],
            totalBalanceUSD: parseFloat(totalBalanceUSD.toFixed(2))
        });
    } catch (error) {
        console.error('Get accounts error:', error);
        res.status(500).json({ error: 'Failed to fetch accounts' });
    }
});

// ============================================
// GET SINGLE ACCOUNT
// ============================================
router.get('/:id', async (req, res) => {
    try {
        const { data: account, error } = await req.supabase
            .from('accounts')
            .select('*, account_balances(*)')
            .eq('id', req.params.id)
            .eq('user_id', req.user.id)
            .single();

        if (error || !account) {
            return res.status(404).json({ error: 'Account not found' });
        }

        res.json(account);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch account' });
    }
});

// ============================================
// CREATE NEW CURRENCY ACCOUNT
// ============================================
router.post('/', async (req, res) => {
    try {
        const { currency, account_type } = req.body;

        if (!currency) {
            return res.status(400).json({ error: 'Currency is required' });
        }

        // Check if currency is supported
        const { data: curr } = await req.supabase
            .from('currencies')
            .select('*')
            .eq('code', currency)
            .eq('is_active', true)
            .single();

        if (!curr) {
            return res.status(400).json({ error: 'Unsupported currency' });
        }

        // Check if user already has this currency account
        const { data: existing } = await req.supabase
            .from('accounts')
            .select('id')
            .eq('user_id', req.user.id)
            .eq('currency', currency)
            .eq('is_active', true)
            .single();

        if (existing) {
            return res.status(409).json({ error: 'Account for this currency already exists' });
        }

        const accountNumber = 'ACC' + Date.now().toString().slice(-10);
        const { data: account, error } = await req.supabase
            .from('accounts')
            .insert({
                id: uuidv4(),
                user_id: req.user.id,
                account_number: accountNumber,
                account_type: account_type || 'checking',
                currency
            })
            .select()
            .single();

        if (error) throw error;

        // Create balance record with 0.00 balance
        await req.supabase
            .from('account_balances')
            .insert({
                id: uuidv4(),
                account_id: account.id,
                available_balance: 0,
                pending_balance: 0
            });

        res.status(201).json(account);
    } catch (error) {
        console.error('Create account error:', error);
        res.status(500).json({ error: 'Failed to create account' });
    }
});

// ============================================
// GET ACCOUNT TRANSACTIONS
// ============================================
router.get('/:id/transactions', async (req, res) => {
    try {
        const { limit = 50, offset = 0 } = req.query;

        const ledger = new LedgerService(req.supabase);
        const transactions = await ledger.getAccountTransactions(req.params.id, {
            limit: parseInt(limit),
            offset: parseInt(offset)
        });

        res.json({ transactions });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch transactions' });
    }
});

// ============================================
// DEPOSIT (SIMULATED)
// ============================================
router.post('/:id/deposit', checkFrozen, async (req, res) => {
    try {
        const { amount, currency, description } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'Invalid amount' });
        }

        const { data: account } = await req.supabase
            .from('accounts')
            .select('*, account_balances(*)')
            .eq('id', req.params.id)
            .eq('user_id', req.user.id)
            .single();

        if (!account) {
            return res.status(404).json({ error: 'Account not found' });
        }

        const ledger = new LedgerService(req.supabase);
        const transaction = await ledger.createTransaction({
            type: 'deposit',
            creditAccountId: account.id,
            amount,
            currency: currency || account.currency,
            description: description || 'Simulated deposit',
            initiatedBy: req.user.id,
            metadata: { type: 'simulated_deposit' }
        });

        await ledger.completeTransaction(transaction.id);

        const notificationService = new NotificationService(req.supabase);
        await notificationService.create(
            req.user.id,
            'deposit',
            'Deposit Received',
            `A deposit of ${currency || account.currency} ${amount.toLocaleString()} has been credited to your account.`
        );

        res.json({ transaction, message: 'Deposit completed successfully' });
    } catch (error) {
        console.error('Deposit error:', error);
        res.status(500).json({ error: 'Deposit failed' });
    }
});

module.exports = router;