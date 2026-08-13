const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../../middleware/auth');
const rbac = require('../../middleware/rbac');
const { auditLog } = require('../../middleware/audit');

router.use(authenticateAdmin);
router.use(rbac(['otp.manage']));

// Get OTP settings for user
router.get('/otp-settings/:userId', async (req, res) => {
    try {
        const { data: settings } = await req.supabase
            .from('otp_settings')
            .select('*')
            .eq('user_id', req.params.userId)
            .single();

        res.json(settings || {});
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch OTP settings' });
    }
});

// Update OTP settings
router.put('/otp-settings/:userId', async (req, res) => {
    try {
        const settings = req.body;

        const { data: previous } = await req.supabase
            .from('otp_settings')
            .select('*')
            .eq('user_id', req.params.userId)
            .single();

        const { data } = await req.supabase
            .from('otp_settings')
            .update(settings)
            .eq('user_id', req.params.userId)
            .select()
            .single();

        await auditLog(req.supabase, {
            actorId: req.admin.id,
            actorType: 'admin',
            action: 'ADMIN_CHANGED_OTP_SETTING',
            targetType: 'user',
            targetId: req.params.userId,
            previousValue: previous,
            newValue: data,
            ip: req.ip
        });

        res.json(data);
    } catch (error) {
        res.status(500).json({ error: 'Failed to update OTP settings' });
    }
});

// Get security events
router.get('/events', async (req, res) => {
    try {
        const { user_id, severity, limit = 50 } = req.query;

        let query = req.supabase
            .from('security_events')
            .select('*, users(email, profiles(full_name))')
            .order('created_at', { ascending: false })
            .limit(parseInt(limit));

        if (user_id) query = query.eq('user_id', user_id);
        if (severity) query = query.eq('severity', severity);

        const { data: events } = await query;
        res.json({ events });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch events' });
    }
});

module.exports = router;