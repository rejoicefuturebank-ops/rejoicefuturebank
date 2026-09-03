// Public Support Routes — NO authentication (used by the landing page widget)
// Mount this at /api/public in index.js, e.g.:
//   const publicSupportRoutes = require('./routes/public-support');
//   app.use('/api/public', publicSupportRoutes);
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');

// Stricter than the general API limiter since this endpoint has no auth at all
const publicContactLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5,
    message: { error: 'Too many requests. Please try again later.' }
});

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_CATEGORIES = ['general', 'account', 'transfer', 'card', 'security', 'other'];

function validateContactPayload(body) {
    const { name, email, subject, category, message, website } = body;

    // Honeypot: a hidden field real visitors never see or fill; bots often do.
    if (website) {
        return { valid: false, error: 'Invalid submission' };
    }

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
        return { valid: false, error: 'Please enter your name' };
    }
    if (!email || typeof email !== 'string' || !EMAIL_REGEX.test(email)) {
        return { valid: false, error: 'Please enter a valid email address' };
    }
    if (!message || typeof message !== 'string' || message.trim().length < 10) {
        return { valid: false, error: 'Please describe your issue (at least 10 characters)' };
    }
    if (message.length > 5000) {
        return { valid: false, error: 'Message is too long' };
    }

    const safeCategory = ALLOWED_CATEGORIES.includes(category) ? category : 'general';

    return {
        valid: true,
        data: {
            name: name.trim().slice(0, 120),
            email: email.trim().toLowerCase().slice(0, 200),
            subject: (subject || 'Website Contact Form').toString().trim().slice(0, 150),
            category: safeCategory,
            message: message.trim()
        }
    };
}

// POST /api/public/contact — visitors on index.html who aren't signed in yet
router.post('/contact', publicContactLimiter, async (req, res) => {
    try {
        const result = validateContactPayload(req.body);
        if (!result.valid) {
            return res.status(400).json({ error: result.error });
        }
        const { name, email, subject, category, message } = result.data;

        const ticketNumber = 'TKT-' + Date.now().toString().slice(-6);

        const { data: ticket, error } = await req.supabase
            .from('support_tickets')
            .insert({
                id: uuidv4(),
                user_id: null,
                is_guest: true,
                guest_name: name,
                guest_email: email,
                ticket_number: ticketNumber,
                subject,
                category,
                priority: 'medium',
                status: 'open'
            })
            .select()
            .single();

        if (error) throw error;

        await req.supabase
            .from('support_messages')
            .insert({
                id: uuidv4(),
                ticket_id: ticket.id,
                sender_id: null,
                sender_type: 'customer',
                message
            });

        res.status(201).json({
            ticket_number: ticketNumber,
            message: `Thanks, ${name.split(' ')[0]}! We've received your message and will reply to ${email} shortly.`
        });
    } catch (error) {
        console.error('Public contact error:', error);
        res.status(500).json({ error: 'Failed to submit your message. Please try again.' });
    }
});

module.exports = router;