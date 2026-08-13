const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../../middleware/auth');
const rbac = require('../../middleware/rbac');
const { auditLog } = require('../../middleware/audit');
const { v4: uuidv4 } = require('uuid');

router.use(authenticateAdmin);
router.use(rbac(['support.manage']));

// Get all tickets
router.get('/tickets', async (req, res) => {
    try {
        const { status, category, priority, limit = 50 } = req.query;

        let query = req.supabase
            .from('support_tickets')
            .select('*, users(email, profiles(full_name))')
            .order('created_at', { ascending: false })
            .limit(parseInt(limit));

        if (status) query = query.eq('status', status);
        if (category) query = query.eq('category', category);
        if (priority) query = query.eq('priority', priority);

        const { data: tickets, error } = await query;
        if (error) throw error;

        res.json({ tickets: tickets || [] });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch tickets' });
    }
});

// Get single ticket with messages
router.get('/tickets/:id', async (req, res) => {
    try {
        const { data: ticket, error } = await req.supabase
            .from('support_tickets')
            .select('*, users(*, profiles(*)), support_messages(*)')
            .eq('id', req.params.id)
            .single();

        if (error || !ticket) return res.status(404).json({ error: 'Ticket not found' });

        res.json(ticket);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch ticket' });
    }
});

// Reply to ticket
router.post('/tickets/:id/reply', async (req, res) => {
    try {
        const { message, is_internal } = req.body;

        const { data: msg, error } = await req.supabase
            .from('support_messages')
            .insert({
                id: uuidv4(),
                ticket_id: req.params.id,
                sender_id: req.admin.id,
                sender_type: 'admin',
                message,
                is_internal: is_internal || false
            })
            .select()
            .single();

        if (error) throw error;

        // Update ticket status
        await req.supabase
            .from('support_tickets')
            .update({ status: 'waiting_for_customer', updated_at: new Date().toISOString() })
            .eq('id', req.params.id);

        // Notify user if not internal
        if (!is_internal) {
            const { data: ticket } = await req.supabase
                .from('support_tickets')
                .select('user_id')
                .eq('id', req.params.id)
                .single();

            if (ticket) {
                await req.supabase
                    .from('notifications')
                    .insert({
                        id: uuidv4(),
                        user_id: ticket.user_id,
                        type: 'support_reply',
                        title: 'Support Response',
                        message: 'Your support ticket has received a new response.'
                    });
            }
        }

        res.json(msg);
    } catch (error) {
        res.status(500).json({ error: 'Failed to reply' });
    }
});

// Update ticket status
router.put('/tickets/:id/status', async (req, res) => {
    try {
        const { status } = req.body;

        const { data: ticket, error } = await req.supabase
            .from('support_tickets')
            .update({
                status,
                resolved_at: status === 'resolved' ? new Date().toISOString() : null,
                updated_at: new Date().toISOString()
            })
            .eq('id', req.params.id)
            .select()
            .single();

        if (error) throw error;

        res.json(ticket);
    } catch (error) {
        res.status(500).json({ error: 'Failed to update status' });
    }
});

// Get all limit requests
router.get('/limit-requests', async (req, res) => {
    try {
        const { status = 'pending' } = req.query;

        const { data: requests, error } = await req.supabase
            .from('limit_requests')
            .select('*, users(email, profiles(full_name))')
            .eq('status', status)
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json({ requests: requests || [] });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch limit requests' });
    }
});

// Approve limit request
router.post('/limit-requests/:id/approve', async (req, res) => {
    try {
        const { new_limit_values, notes } = req.body;

        const { data: request } = await req.supabase
            .from('limit_requests')
            .select('*')
            .eq('id', req.params.id)
            .single();

        if (!request) return res.status(404).json({ error: 'Request not found' });

        // Update limit request
        await req.supabase
            .from('limit_requests')
            .update({
                status: 'approved',
                admin_notes: notes,
                reviewed_by: req.admin.id,
                reviewed_at: new Date().toISOString()
            })
            .eq('id', req.params.id);

        // Update user limits if provided
        if (new_limit_values) {
            await req.supabase
                .from('transfer_limits')
                .update(new_limit_values)
                .eq('user_id', request.user_id);
        }

        // Notify user
        await req.supabase
            .from('notifications')
            .insert({
                id: uuidv4(),
                user_id: request.user_id,
                type: 'limit_approved',
                title: 'Limit Increase Approved',
                message: `Your request for a ${request.limit_type} increase has been approved.`
            });

        await auditLog(req.supabase, {
            actorId: req.admin.id,
            actorType: 'admin',
            action: 'ADMIN_APPROVED_LIMIT_REQUEST',
            targetType: 'limit_request',
            targetId: req.params.id,
            reason: notes,
            ip: req.ip
        });

        res.json({ message: 'Limit request approved' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to approve request' });
    }
});

// Reject limit request
router.post('/limit-requests/:id/reject', async (req, res) => {
    try {
        const { notes } = req.body;

        const { data: request } = await req.supabase
            .from('limit_requests')
            .select('*')
            .eq('id', req.params.id)
            .single();

        if (!request) return res.status(404).json({ error: 'Request not found' });

        await req.supabase
            .from('limit_requests')
            .update({
                status: 'rejected',
                admin_notes: notes,
                reviewed_by: req.admin.id,
                reviewed_at: new Date().toISOString()
            })
            .eq('id', req.params.id);

        // Notify user
        await req.supabase
            .from('notifications')
            .insert({
                id: uuidv4(),
                user_id: request.user_id,
                type: 'limit_rejected',
                title: 'Limit Increase Denied',
                message: `Your request for a limit increase has been denied. ${notes || ''}`
            });

        res.json({ message: 'Limit request rejected' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to reject request' });
    }
});

module.exports = router;