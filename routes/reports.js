const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/auth');
const rbac = require('../middleware/rbac');

router.use(authenticateAdmin);
router.use(rbac(['audit.view']));

// Dashboard statistics
router.get('/dashboard', async (req, res) => {
    try {
        // Total users
        const { count: totalUsers } = await req.supabase
            .from('users')
            .select('*', { count: 'exact', head: true });

        // Active users (logged in last 30 days)
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const { count: activeUsers } = await req.supabase
            .from('users')
            .select('*', { count: 'exact', head: true })
            .gte('last_login', thirtyDaysAgo);

        // Total balances
        const { data: balances } = await req.supabase
            .from('account_balances')
            .select('available_balance, accounts(currency)');

        let totalBalanceUSD = 0;
        for (const b of balances) {
            const balance = parseFloat(b.available_balance || 0);
            if (b.accounts?.currency === 'USD') {
                totalBalanceUSD += balance;
            }
            // Simplified - in production convert using exchange rates
        }

        // Transaction stats
        const { count: totalTransactions } = await req.supabase
            .from('transactions')
            .select('*', { count: 'exact', head: true });

        const { count: pendingTransactions } = await req.supabase
            .from('transactions')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'pending');

        const { count: failedTransactions } = await req.supabase
            .from('transactions')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'failed');

        // Support tickets
        const { count: openTickets } = await req.supabase
            .from('support_tickets')
            .select('*', { count: 'exact', head: true })
            .in('status', ['open', 'waiting_for_admin', 'under_review']);

        // Security events
        const { count: securityEvents } = await req.supabase
            .from('security_events')
            .select('*', { count: 'exact', head: true })
            .eq('is_resolved', false);

        // Transfer volume (last 30 days)
        const { data: recentTransfers } = await req.supabase
            .from('transactions')
            .select('amount, currency')
            .eq('transaction_type', 'transfer')
            .gte('created_at', thirtyDaysAgo);

        let transferVolume = 0;
        for (const t of recentTransfers) {
            transferVolume += parseFloat(t.amount || 0);
        }

        res.json({
            totalUsers: totalUsers || 0,
            activeUsers: activeUsers || 0,
            totalBalanceUSD: parseFloat(totalBalanceUSD.toFixed(2)),
            totalTransactions: totalTransactions || 0,
            pendingTransactions: pendingTransactions || 0,
            failedTransactions: failedTransactions || 0,
            openTickets: openTickets || 0,
            securityEvents: securityEvents || 0,
            transferVolume30d: parseFloat(transferVolume.toFixed(2))
        });
    } catch (error) {
        console.error('Dashboard stats error:', error);
        res.status(500).json({ error: 'Failed to fetch statistics' });
    }
});

// Transaction report
router.get('/transactions', async (req, res) => {
    try {
        const { start_date, end_date, type, status, currency, limit = 100 } = req.query;

        let query = req.supabase
            .from('transactions')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(parseInt(limit));

        if (start_date) query = query.gte('created_at', start_date);
        if (end_date) query = query.lte('created_at', end_date);
        if (type) query = query.eq('transaction_type', type);
        if (status) query = query.eq('status', status);
        if (currency) query = query.eq('currency', currency);

        const { data: transactions } = await query;

        res.json({ transactions });
    } catch (error) {
        res.status(500).json({ error: 'Failed to generate report' });
    }
});

// Export CSV
router.get('/export/transactions', async (req, res) => {
    try {
        const { start_date, end_date } = req.query;

        let query = req.supabase
            .from('transactions')
            .select('*')
            .order('created_at', { ascending: false });

        if (start_date) query = query.gte('created_at', start_date);
        if (end_date) query = query.lte('created_at', end_date);

        const { data: transactions } = await query;

        const csv = [
            'Reference,Type,Status,Amount,Currency,Fee,Description,Created At',
            ...transactions.map(t =>
                `${t.reference},${t.transaction_type},${t.status},${t.amount},${t.currency},${t.fee},"${t.description || ''}",${t.created_at}`
            )
        ].join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=transactions.csv');
        res.send(csv);
    } catch (error) {
        res.status(500).json({ error: 'Export failed' });
    }
});

module.exports = router;