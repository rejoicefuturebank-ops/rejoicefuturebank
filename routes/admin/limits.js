const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../../middleware/auth');
const rbac = require('../../middleware/rbac');
const { auditLog } = require('../../middleware/audit');
const { v4: uuidv4 } = require('uuid');

// Require admin authentication and 'limits.edit' permission
router.use(authenticateAdmin);
router.use(rbac(['limits.edit']));

// Get limits for a specific user
router.get('/user/:userId', async (req, res) => {
    try {
        const { data: limits, error } = await req.supabase
            .from('transfer_limits')
            .select('*')
            .eq('user_id', req.params.userId)
            .single();

        if (error || !limits) {
            return res.status(404).json({ error: 'Limits not found for this user' });
        }

        res.json(limits);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch limits' });
    }
});

// Update limits for a specific user
router.put('/user/:userId', async (req, res) => {
    try {
        const limitData = req.body;
        const { reason } = limitData;

        if (!reason) {
            return res.status(400).json({ error: 'Reason is required for audit purposes' });
        }

        // Get previous limits for the audit log
        const { data: previous } = await req.supabase
            .from('transfer_limits')
            .select('*')
            .eq('user_id', req.params.userId)
            .single();

        // Prepare update object (exclude 'reason' from actual DB update)
        const updateData = { ...limitData };
        delete updateData.reason;
        updateData.updated_at = new Date().toISOString();

        const { data: limits, error } = await req.supabase
            .from('transfer_limits')
            .update(updateData)
            .eq('user_id', req.params.userId)
            .select()
            .single();

        if (error) throw error;

        // Record in audit log
        await auditLog(req.supabase, {
            actorId: req.admin.id,
            actorType: 'admin',
            action: 'ADMIN_CHANGED_TRANSFER_LIMIT',
            targetType: 'user',
            targetId: req.params.userId,
            previousValue: previous,
            newValue: limits,
            reason,
            ip: req.ip,
            userAgent: req.get('user-agent')
        });

        // Notify the user
        await req.supabase
            .from('notifications')
            .insert({
                id: uuidv4(),
                user_id: req.params.userId,
                type: 'limit_updated',
                title: 'Your Transfer Limits Have Been Updated',
                message: `An administrator has updated your account limits. Reason: ${reason}`
            });

        res.json({ limits, message: 'Limits updated successfully' });
    } catch (error) {
        console.error('Update limits error:', error);
        res.status(500).json({ error: 'Failed to update limits' });
    }
});

// Get all pending limit increase requests
router.get('/requests', async (req, res) => {
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

module.exports = router;