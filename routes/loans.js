const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

router.use(authenticate);

// Get user loans
router.get('/', async (req, res) => {
    try {
        const { data: loans } = await req.supabase
            .from('loans')
            .select('*, loan_payments(*)')
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false });

        res.json({ loans: loans || [] });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch loans' });
    }
});

// Apply for loan
router.post('/apply', async (req, res) => {
    try {
        const { loan_type, principal_amount, term_months } = req.body;

        // Simple eligibility check (simulated)
        const { data: accounts } = await req.supabase
            .from('accounts')
            .select('account_balances(available_balance)')
            .eq('user_id', req.user.id);

        const totalBalance = accounts.reduce((sum, a) => sum + parseFloat(a.account_balances?.available_balance || 0), 0);

        if (principal_amount > totalBalance * 10) {
            return res.status(400).json({ error: 'Loan amount too high relative to account balance' });
        }

        // Calculate interest
        const interestRates = {
            personal: 8.5,
            auto: 5.5,
            business: 7.0,
            credit_line: 12.0
        };

        const rate = interestRates[loan_type] || 8.5;
        const monthlyRate = rate / 100 / 12;
        const monthlyPayment = principal_amount * (monthlyRate * Math.pow(1 + monthlyRate, term_months)) / (Math.pow(1 + monthlyRate, term_months) - 1);

        const startDate = new Date();
        const endDate = new Date();
        endDate.setMonth(endDate.getMonth() + term_months);

        const { data: loan, error } = await req.supabase
            .from('loans')
            .insert({
                id: uuidv4(),
                user_id: req.user.id,
                loan_type,
                principal_amount,
                outstanding_balance: principal_amount,
                interest_rate: rate,
                term_months,
                monthly_payment: parseFloat(monthlyPayment.toFixed(2)),
                start_date: startDate.toISOString().split('T')[0],
                end_date: endDate.toISOString().split('T')[0],
                status: 'active'
            })
            .select()
            .single();

        if (error) throw error;

        // Generate payment schedule
        let remainingBalance = principal_amount;
        for (let i = 1; i <= term_months; i++) {
            const interestPayment = remainingBalance * monthlyRate;
            const principalPayment = monthlyPayment - interestPayment;
            remainingBalance -= principalPayment;

            const paymentDate = new Date(startDate);
            paymentDate.setMonth(paymentDate.getMonth() + i);

            await req.supabase
                .from('loan_payments')
                .insert({
                    id: uuidv4(),
                    loan_id: loan.id,
                    payment_number: i,
                    principal_paid: parseFloat(principalPayment.toFixed(2)),
                    interest_paid: parseFloat(interestPayment.toFixed(2)),
                    total_paid: parseFloat(monthlyPayment.toFixed(2)),
                    balance_after: parseFloat(Math.max(0, remainingBalance).toFixed(2)),
                    payment_date: paymentDate.toISOString().split('T')[0],
                    status: 'pending'
                });
        }

        res.status(201).json({ loan, message: 'Loan approved and created' });
    } catch (error) {
        console.error('Loan application error:', error);
        res.status(500).json({ error: 'Loan application failed' });
    }
});

// Make payment
router.post('/:id/pay', async (req, res) => {
    try {
        const { amount } = req.body;

        const { data: loan } = await req.supabase
            .from('loans')
            .select('*')
            .eq('id', req.params.id)
            .eq('user_id', req.user.id)
            .single();

        if (!loan) return res.status(404).json({ error: 'Loan not found' });

        // Get next pending payment
        const { data: nextPayment } = await req.supabase
            .from('loan_payments')
            .select('*')
            .eq('loan_id', loan.id)
            .eq('status', 'pending')
            .order('payment_number')
            .limit(1)
            .single();

        if (!nextPayment) return res.status(400).json({ error: 'No pending payments' });

        const paymentAmount = amount || nextPayment.total_paid;

        // Update payment
        await req.supabase
            .from('loan_payments')
            .update({ status: 'paid' })
            .eq('id', nextPayment.id);

        // Update loan
        const newBalance = parseFloat(loan.outstanding_balance) - parseFloat(nextPayment.principal_paid);
        await req.supabase
            .from('loans')
            .update({
                outstanding_balance: Math.max(0, newBalance),
                total_paid: parseFloat(loan.total_paid) + parseFloat(paymentAmount),
                total_interest_paid: parseFloat(loan.total_interest_paid) + parseFloat(nextPayment.interest_paid),
                status: newBalance <= 0 ? 'paid_off' : 'active'
            })
            .eq('id', loan.id);

        res.json({ message: 'Payment made', newBalance });
    } catch (error) {
        res.status(500).json({ error: 'Payment failed' });
    }
});

// Loan calculator
router.post('/calculate', (req, res) => {
    const { principal, rate, term_months } = req.body;

    const monthlyRate = (rate || 8.5) / 100 / 12;
    const monthlyPayment = principal * (monthlyRate * Math.pow(1 + monthlyRate, term_months)) / (Math.pow(1 + monthlyRate, term_months) - 1);
    const totalPayment = monthlyPayment * term_months;
    const totalInterest = totalPayment - principal;

    res.json({
        monthly_payment: parseFloat(monthlyPayment.toFixed(2)),
        total_payment: parseFloat(totalPayment.toFixed(2)),
        total_interest: parseFloat(totalInterest.toFixed(2)),
        rate: rate || 8.5,
        term_months
    });
});

module.exports = router;