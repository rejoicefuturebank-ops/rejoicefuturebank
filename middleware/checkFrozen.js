/**
 * Middleware: Check if user account is frozen
 * Blocks financial actions but allows viewing
 */
const checkFrozen = async (req, res, next) => {
    try {
        if (!req.user?.id) {
            return next();
        }

        const { data: user } = await req.supabase
            .from('users')
            .select('is_frozen, is_suspended, freeze_transfers, freeze_withdrawals')
            .eq('id', req.user.id)
            .single();

        if (!user) {
            return next();
        }

        // Suspended users are fully blocked
        if (user.is_suspended) {
            return res.status(403).json({ 
                error: 'Your account has been suspended. Please contact support.',
                code: 'ACCOUNT_SUSPENDED'
            });
        }

        // Frozen users - block the action but with helpful message
        if (user.is_frozen) {
            return res.status(403).json({ 
                error: 'Your account is frozen. This action is not available. Please contact support to resolve this issue.',
                code: 'ACCOUNT_FROZEN',
                can_view: true, // Frontend can still show balances
                support_link: '/support'
            });
        }

        // Check specific freezes
        if (req.path.includes('/transfer') && user.freeze_transfers) {
            return res.status(403).json({ 
                error: 'Transfers are currently frozen for your account.',
                code: 'TRANSFERS_FROZEN'
            });
        }

        if (req.path.includes('/withdraw') && user.freeze_withdrawals) {
            return res.status(403).json({ 
                error: 'Withdrawals are currently frozen for your account.',
                code: 'WITHDRAWALS_FROZEN'
            });
        }

        next();
    } catch (error) {
        console.error('Check frozen error:', error);
        next(); // Don't block on error
    }
};

module.exports = checkFrozen;