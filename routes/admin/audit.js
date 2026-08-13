const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../../middleware/auth');
const rbac = require('../../middleware/rbac');

router.use(authenticateAdmin);
router.use(rbac(['audit.view']));

// Get audit logs
router.get('/', async (req, res) => {
    try {
        const { action, actor_id, target_type, target_id, limit = 100, offset = 0 } = req.query;

        let query = req.supabase
            .from('audit_logs')
            .select('*')
            .order('created_at', { ascending: false })
            .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

        if (action) query = query.eq('action', action);
        if (actor_id) query = query.eq('actor_id', actor_id);
        if (target_type) query = query.eq('target_type', target_type);
        if (target_id) query = query.eq('target_id', target_id);

        const { data: logs, error } = await query;
        if (error) throw error;

        const { count } = await req.supabase
            .from('audit_logs')
            .select('*', { count: 'exact', head: true });

        res.json({ logs, total: count });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch audit logs' });
    }
});

// Get audit log details
router.get('/:id', async (req, res) => {
    try {
        const { data: log, error } = await req.supabase
            .from('audit_logs')
            .select('*')
            .eq('id', req.params.id)
            .single();

        if (error || !log) return res.status(404).json({ error: 'Log not found' });
        res.json(log);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch log' });
    }
});

module.exports = router;