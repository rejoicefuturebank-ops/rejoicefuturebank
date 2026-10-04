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

// Apply for loan — DISABLED pending a real lending partner/underwriting.
// This used to auto-approve any loan under 10x the requester's balance
// with no real credit check, funding source, or license behind it.
router.post('/apply', async (req, res) => {
    res.status(503).json({
        error: 'Loan applications are not currently available. We are working on real underwriting and funding — check back soon.',
        code: 'LOANS_NOT_AVAILABLE'
    });
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