const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { authenticateAdmin } = require('../../middleware/auth');
const rbac = require('../../middleware/rbac');
const { auditLog } = require('../../middleware/audit');

router.use(authenticateAdmin);
router.use(rbac(['impersonation.create']));

// Start impersonation ("test mode")
router.post('/start', async (req, res) => {
    try {
        const { userId, reason } = req.body;

        if (!userId || !reason) {
            return res.status(400).json({ error: 'userId and reason are required' });
        }

        const { data: user, error } = await req.supabase
            .from('users')
            .select('id, email')
            .eq('id', userId)
            .single();

        if (error || !user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const sessionId = uuidv4();

        const token = jwt.sign(
            {
                impersonation: true,
                admin: {
                    id: req.admin.id,
                    email: req.admin.email,
                    role_name: req.admin.role_name
                },
                user: {
                    id: user.id,
                    email: user.email
                },
                sessionId
            },
            process.env.JWT_SECRET,
            { expiresIn: '1h' }
        );

        await req.supabase
            .from('impersonation_sessions')
            .insert({
                id: sessionId,
                admin_id: req.admin.id,
                target_user_id: user.id,
                reason,
                started_at: new Date().toISOString(),
                is_active: true
            });

        await auditLog(req.supabase, {
            actorId: req.admin.id,
            actorType: 'admin',
            action: 'ADMIN_STARTED_IMPERSONATION',
            targetType: 'user',
            targetId: user.id,
            reason,
            reference: sessionId,
            ip: req.ip,
            userAgent: req.get('user-agent')
        });

        res.json({ token, sessionId, message: 'Impersonation session started' });
    } catch (error) {
        console.error('Impersonation start error:', error);
        res.status(500).json({ error: 'Failed to start impersonation' });
    }
});

// End impersonation
router.post('/:sessionId/end', async (req, res) => {
    try {
        await req.supabase
            .from('impersonation_sessions')
            .update({ is_active: false, ended_at: new Date().toISOString() })
            .eq('id', req.params.sessionId);

        await auditLog(req.supabase, {
            actorId: req.admin.id,
            actorType: 'admin',
            action: 'ADMIN_ENDED_IMPERSONATION',
            targetType: 'impersonation_session',
            targetId: req.params.sessionId,
            ip: req.ip,
            userAgent: req.get('user-agent')
        });

        res.json({ message: 'Impersonation session ended' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to end impersonation' });
    }
});

module.exports = router;