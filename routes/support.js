const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const { supportTicketSchema } = require('../utils/validators');

router.use(authenticate);

// Get user tickets
router.get('/tickets', async (req, res) => {
    try {
        const { data: tickets } = await req.supabase
            .from('support_tickets')
            .select('*, support_messages(*)')
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false });

        res.json({ tickets: tickets || [] });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch tickets' });
    }
});

// Create ticket
router.post('/tickets', async (req, res) => {
    try {
        const { error: validationError } = supportTicketSchema.validate(req.body);
        if (validationError) {
            return res.status(400).json({ error: validationError.details[0].message });
        }

        const { subject, category, priority, message, limit_request_id } = req.body;

        const ticketNumber = 'TKT-' + Date.now().toString().slice(-6);

        const { data: ticket, error } = await req.supabase
            .from('support_tickets')
            .insert({
                id: uuidv4(),
                user_id: req.user.id,
                ticket_number: ticketNumber,
                subject,
                category,
                priority: priority || 'medium',
                status: 'open',
                limit_request_id
            })
            .select()
            .single();

        if (error) throw error;

        // Add initial message
        await req.supabase
            .from('support_messages')
            .insert({
                id: uuidv4(),
                ticket_id: ticket.id,
                sender_id: req.user.id,
                sender_type: 'customer',
                message
            });

        // If limit request, create it
        if (category === 'limit_request' && req.body.requested_limit) {
            await req.supabase
                .from('limit_requests')
                .insert({
                    id: uuidv4(),
                    user_id: req.user.id,
                    limit_type: req.body.limit_type,
                    current_value: req.body.current_limit,
                    requested_value: req.body.requested_limit,
                    reason: req.body.reason
                });
        }

        res.status(201).json(ticket);
    } catch (error) {
        console.error('Create ticket error:', error);
        res.status(500).json({ error: 'Failed to create ticket' });
    }
});

// Reply to ticket
router.post('/tickets/:id/reply', async (req, res) => {
    try {
        const { message } = req.body;

        // Verify ownership
        const { data: ticket } = await req.supabase
            .from('support_tickets')
            .select('id')
            .eq('id', req.params.id)
            .eq('user_id', req.user.id)
            .single();

        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

        const { data: msg } = await req.supabase
            .from('support_messages')
            .insert({
                id: uuidv4(),
                ticket_id: req.params.id,
                sender_id: req.user.id,
                sender_type: 'customer',
                message
            })
            .select()
            .single();

        // Update ticket status
        await req.supabase
            .from('support_tickets')
            .update({ status: 'waiting_for_admin', updated_at: new Date().toISOString() })
            .eq('id', req.params.id);

        res.json(msg);
    } catch (error) {
        res.status(500).json({ error: 'Failed to reply' });
    }
});

// Get ticket messages
router.get('/tickets/:id/messages', async (req, res) => {
    try {
        const { data: messages } = await req.supabase
            .from('support_messages')
            .select('*')
            .eq('ticket_id', req.params.id)
            .eq('is_internal', false)
            .order('created_at');

        res.json({ messages: messages || [] });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

// Request limit increase (creates ticket + limit request)
router.post('/request-limit-increase', async (req, res) => {
    try {
        const { limit_type, current_limit, requested_limit, reason } = req.body;

        // Create limit request
        const { data: limitRequest } = await req.supabase
            .from('limit_requests')
            .insert({
                id: uuidv4(),
                user_id: req.user.id,
                limit_type,
                current_value: current_limit,
                requested_value: requested_limit,
                reason,
                status: 'pending'
            })
            .select()
            .single();

        // Create support ticket
        const ticketNumber = 'TKT-' + Date.now().toString().slice(-6);
        const { data: ticket } = await req.supabase
            .from('support_tickets')
            .insert({
                id: uuidv4(),
                user_id: req.user.id,
                ticket_number: ticketNumber,
                subject: `Limit Increase Request - ${limit_type}`,
                category: 'limit_request',
                priority: 'medium',
                status: 'open',
                limit_request_id: limitRequest.id
            })
            .select()
            .single();

        await req.supabase
            .from('support_messages')
            .insert({
                id: uuidv4(),
                ticket_id: ticket.id,
                sender_id: req.user.id,
                sender_type: 'customer',
                message: `Request to increase ${limit_type} from ${current_limit} to ${requested_limit}.\n\nReason: ${reason}`
            });

        res.json({ ticket, limitRequest, message: 'Limit increase request submitted' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to submit request' });
    }
});

module.exports = router;