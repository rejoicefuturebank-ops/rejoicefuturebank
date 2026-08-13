const rbac = (requiredPermissions) => {
    return async (req, res, next) => {
        try {
            if (!req.admin) {
                return res.status(403).json({ error: 'Admin access required' });
            }

            const { data: permissions } = await req.supabase
                .from('admin_permissions')
                .select('permission')
                .eq('role_id', req.admin.role_id);

            const userPermissions = permissions.map(p => p.permission);

            // Super Admin has all permissions
            if (req.admin.role_name === 'Super Admin') {
                return next();
            }

            const hasPermission = requiredPermissions.some(p => userPermissions.includes(p));

            if (!hasPermission) {
                return res.status(403).json({ error: 'Insufficient permissions' });
            }

            req.adminPermissions = userPermissions;
            next();
        } catch (error) {
            console.error('RBAC Error:', error);
            return res.status(500).json({ error: 'Permission check failed' });
        }
    };
};

module.exports = rbac;