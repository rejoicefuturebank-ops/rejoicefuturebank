// Search users - FIXED SYNTAX
router.get('/search', rbac(['users.view']), async (req, res) => {
    try {
        const { q, limit = 50 } = req.query;

        let query = req.supabase
            .from('users')
            .select('*, profiles(*)')
            .limit(parseInt(limit))
            .order('created_at', { ascending: false });

        if (q) {
            // ✅ FIXED: Use proper OR syntax for Supabase
            // Search in users.email OR profiles.full_name
            query = query.or(`email.ilike.%${q}%,phone.ilike.%${q}%`);
            
            // Also search in profiles separately and merge results
            const { data: profileMatches } = await req.supabase
                .from('profiles')
                .select('user_id')
                .or(`full_name.ilike.%${q}%,first_name.ilike.%${q}%,last_name.ilike.%${q}%`);
            
            const profileUserIds = (profileMatches || []).map(p => p.user_id);
            
            if (profileUserIds.length > 0) {
                // Get users that match via profile
                const { data: usersFromProfiles } = await req.supabase
                    .from('users')
                    .select('*, profiles(*)')
                    .in('id', profileUserIds);
                
                // Execute main query
                const { data: directMatches, error } = await query;
                if (error) throw error;
                
                // Merge results and remove duplicates
                const allUsers = [...(directMatches || [])];
                const existingIds = new Set(allUsers.map(u => u.id));
                
                (usersFromProfiles || []).forEach(user => {
                    if (!existingIds.has(user.id)) {
                        allUsers.push(user);
                    }
                });
                
                // Get accounts for each user
                const usersWithAccounts = await Promise.all(
                    allUsers.slice(0, parseInt(limit)).map(async (user) => {
                        const { data: accounts } = await req.supabase
                            .from('accounts')
                            .select('*, account_balances(*)')
                            .eq('user_id', user.id);
                        return { ...user, accounts };
                    })
                );
                
                return res.json({ users: usersWithAccounts });
            }
        }

        const { data: users, error } = await query;
        if (error) throw error;

        // Get accounts for each user
        const usersWithAccounts = await Promise.all(
            (users || []).map(async (user) => {
                const { data: accounts } = await req.supabase
                    .from('accounts')
                    .select('*, account_balances(*)')
                    .eq('user_id', user.id);
                return { ...user, accounts };
            })
        );

        res.json({ users: usersWithAccounts });
    } catch (error) {
        console.error('Search users error:', error);
        res.status(500).json({ error: 'Search failed', details: error.message });
    }
});