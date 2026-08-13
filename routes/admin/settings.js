const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../../middleware/auth');
const rbac = require('../../middleware/rbac');
const { auditLog } = require('../../middleware/audit');

router.use(authenticateAdmin);

// Get all settings
router.get('/', rbac(['settings.manage']), async (req, res) => {
    try {
        const { data: settings } = await req.supabase
            .from('system_settings')
            .select('*');

        const settingsMap = {};
        settings.forEach(s => { settingsMap[s.key] = s.value; });

        res.json(settingsMap);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

// Update setting
router.put('/:key', rbac(['settings.manage']), async (req, res) => {
    try {
        const { key } = req.params;
        const { value, description } = req.body;

        const { data: previous } = await req.supabase
            .from('system_settings')
            .select('value')
            .eq('key', key)
            .single();

        const { data, error } = await req.supabase
            .from('system_settings')
            .upsert({
                key,
                value,
                description,
                updated_by: req.admin.id,
                updated_at: new Date().toISOString()
            }, { onConflict: 'key' })
            .select()
            .single();

        if (error) throw error;

        await auditLog(req.supabase, {
            actorId: req.admin.id,
            actorType: 'admin',
            action: 'ADMIN_CHANGED_SYSTEM_SETTING',
            targetType: 'system_setting',
            targetId: key,
            previousValue: previous?.value,
            newValue: value,
            ip: req.ip
        });

        res.json(data);
    } catch (error) {
        res.status(500).json({ error: 'Failed to update setting' });
    }
});

// Get currencies
router.get('/currencies', async (req, res) => {
    try {
        const { data } = await req.supabase
            .from('currencies')
            .select('*')
            .eq('is_active', true);
        res.json({ currencies: data });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch currencies' });
    }
});

// Update exchange rates
router.put('/exchange-rates', rbac(['settings.manage']), async (req, res) => {
    try {
        const { rates } = req.body;

        for (const rate of rates) {
            await req.supabase
                .from('exchange_rates')
                .upsert({
                    from_currency: rate.from,
                    to_currency: rate.to,
                    rate: rate.rate,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'from_currency,to_currency' });
        }

        res.json({ message: 'Exchange rates updated' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update rates' });
    }
});

module.exports = router;