const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const { hashPassword, generateCardNumber, generateCVV } = require('../utils/crypto');
const NotificationService = require('../services/notifications');

router.use(authenticate);

// Get user cards
router.get('/', async (req, res) => {
    try {
        const { data: cards } = await req.supabase
            .from('cards')
            .select('*')
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false });

        // Mask card numbers
        const maskedCards = (cards || []).map(card => ({
            ...card,
            card_last_four: card.card_last_four,
            masked_number: `**** **** **** ${card.card_last_four}`
        }));

        res.json({ cards: maskedCards });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch cards' });
    }
});

// Create card
router.post('/', async (req, res) => {
    try {
        const { account_id, card_type, is_virtual } = req.body;

        // Get account
        const { data: account } = await req.supabase
            .from('accounts')
            .select('*')
            .eq('id', account_id)
            .eq('user_id', req.user.id)
            .single();

        if (!account) return res.status(404).json({ error: 'Account not found' });

        const cardNumber = generateCardNumber();
        const cvv = generateCVV();
        const expiryMonth = Math.floor(Math.random() * 12) + 1;
        const expiryYear = new Date().getFullYear() + 4;

        const cardNumberHash = require('crypto').createHash('sha256').update(cardNumber).digest('hex');
        const cvvHash = require('crypto').createHash('sha256').update(cvv).digest('hex');

        const { data: card, error } = await req.supabase
            .from('cards')
            .insert({
                id: uuidv4(),
                user_id: req.user.id,
                account_id,
                card_number_hash: cardNumberHash,
                card_last_four: cardNumber.slice(-4),
                card_type: card_type || 'debit',
                card_brand: 'visa',
                is_virtual: is_virtual !== false,
                expiry_month: expiryMonth,
                expiry_year: expiryYear,
                cvv_hash: cvvHash,
                status: 'inactive'
            })
            .select()
            .single();

        if (error) throw error;

        const notificationService = new NotificationService(req.supabase);
        await notificationService.create(
            req.user.id,
            'card_created',
            'New Card Created',
            `A new ${is_virtual ? 'virtual' : 'physical'} card ending in ${card.card_last_four} has been created.`
        );

        res.status(201).json({
            card: {
                ...card,
                masked_number: `**** **** **** ${card.card_last_four}`,
                // Only show full details on creation
                full_number: cardNumber,
                cvv,
                expiry: `${String(expiryMonth).padStart(2, '0')}/${expiryYear}`
            }
        });
    } catch (error) {
        console.error('Create card error:', error);
        res.status(500).json({ error: 'Failed to create card' });
    }
});

// Activate card
router.post('/:id/activate', async (req, res) => {
    try {
        const { data: card } = await req.supabase
            .from('cards')
            .update({ status: 'active', activated_at: new Date().toISOString() })
            .eq('id', req.params.id)
            .eq('user_id', req.user.id)
            .select()
            .single();

        if (!card) return res.status(404).json({ error: 'Card not found' });

        res.json({ message: 'Card activated', card });
    } catch (error) {
        res.status(500).json({ error: 'Failed to activate card' });
    }
});

// Freeze card
router.post('/:id/freeze', async (req, res) => {
    try {
        await req.supabase
            .from('cards')
            .update({ is_frozen: true })
            .eq('id', req.params.id)
            .eq('user_id', req.user.id);

        res.json({ message: 'Card frozen' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to freeze card' });
    }
});

// Unfreeze card
router.post('/:id/unfreeze', async (req, res) => {
    try {
        await req.supabase
            .from('cards')
            .update({ is_frozen: false })
            .eq('id', req.params.id)
            .eq('user_id', req.user.id);

        res.json({ message: 'Card unfrozen' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to unfreeze card' });
    }
});

// Update card settings
router.put('/:id/settings', async (req, res) => {
    try {
        const { daily_limit, monthly_limit, international_enabled, online_enabled, atm_enabled, contactless_enabled } = req.body;

        const { data: card } = await req.supabase
            .from('cards')
            .update({
                daily_limit, monthly_limit,
                international_enabled, online_enabled,
                atm_enabled, contactless_enabled
            })
            .eq('id', req.params.id)
            .eq('user_id', req.user.id)
            .select()
            .single();

        res.json({ card, message: 'Card settings updated' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

// Cancel card
router.post('/:id/cancel', async (req, res) => {
    try {
        await req.supabase
            .from('cards')
            .update({ status: 'cancelled' })
            .eq('id', req.params.id)
            .eq('user_id', req.user.id);

        const notificationService = new NotificationService(req.supabase);
        await notificationService.create(
            req.user.id,
            'card_cancelled',
            'Card Cancelled',
            'Your card has been cancelled. Please request a replacement if needed.'
        );

        res.json({ message: 'Card cancelled' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to cancel card' });
    }
});

module.exports = router;