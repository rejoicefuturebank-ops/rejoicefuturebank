// Get current user - include freeze reason
router.get('/me', require('../middleware/auth').authenticate, async (req, res) => {
    try {
        const { data: user } = await req.supabase
            .from('users')
            .select('*, profiles(*)')
            .eq('id', req.user.id)
            .single();

        const { data: accounts } = await req.supabase
            .from('accounts')
            .select('*, account_balances(*)')
            .eq('user_id', req.user.id)
            .eq('is_active', true);

        // Include freeze info in response
        const freezeInfo = user.is_frozen ? {
            is_frozen: true,
            reason: user.freeze_reason || 'No reason provided',
            frozen_at: user.frozen_at
        } : {
            is_frozen: false
        };

        res.json({ 
            user, 
            accounts,
            freeze_info: freezeInfo // ✅ Add freeze info
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get user data' });
    }
});