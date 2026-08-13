class FraudDetectionService {
    constructor(supabase) {
        this.supabase = supabase;
    }

    async analyzeTransaction(userId, transaction) {
        const flags = [];
        let riskLevel = 'low';
        let action = 'allow';

        // Check for large amount
        if (transaction.amount > 10000) {
            flags.push('large_amount');
            riskLevel = 'medium';
        }

        if (transaction.amount > 50000) {
            flags.push('very_large_amount');
            riskLevel = 'high';
            action = 'require_otp';
        }

        // Check for rapid transactions
        const recentTxs = await this.getRecentTransactions(userId, 5); // Last hour
        if (recentTxs.length >= 5) {
            flags.push('rapid_transactions');
            riskLevel = 'medium';
        }

        // Check for new beneficiary
        if (transaction.beneficiary_id) {
            const beneficiary = await this.getBeneficiaryAge(transaction.beneficiary_id);
            if (beneficiary && beneficiary.ageInHours < 24) {
                flags.push('new_beneficiary');
                riskLevel = 'medium';
                action = 'require_otp';
            }
        }

        // Check for international transfer
        if (transaction.recipient_country && transaction.country !== transaction.recipient_country) {
            flags.push('international_transfer');
            if (riskLevel === 'low') riskLevel = 'medium';
            action = 'require_otp';
        }

        // Check device/location
        const loginHistory = await this.getRecentLogins(userId);
        if (loginHistory.length > 0) {
            const lastLogin = loginHistory[0];
            // In production, compare IP/location
        }

        // Record security event if flagged
        if (flags.length > 0) {
            await this.recordSecurityEvent(userId, {
                event_type: 'transaction_flagged',
                severity: riskLevel,
                description: `Transaction flagged: ${flags.join(', ')}`,
                metadata: { flags, transaction, action }
            });
        }

        return { flags, riskLevel, action };
    }

    async getRecentTransactions(userId, minutes = 60) {
        const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();
        const { data } = await this.supabase
            .from('transactions')
            .select('*')
            .eq('initiated_by', userId)
            .gte('created_at', since);
        return data || [];
    }

    async getBeneficiaryAge(beneficiaryId) {
        const { data } = await this.supabase
            .from('beneficiaries')
            .select('created_at')
            .eq('id', beneficiaryId)
            .single();

        if (!data) return null;

        const ageInHours = (Date.now() - new Date(data.created_at).getTime()) / (1000 * 60 * 60);
        return { ...data, ageInHours };
    }

    async getRecentLogins(userId, limit = 5) {
        const { data } = await this.supabase
            .from('login_history')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(limit);
        return data || [];
    }

    async recordSecurityEvent(userId, event) {
        const { v4: uuidv4 } = require('uuid');
        await this.supabase
            .from('security_events')
            .insert({
                id: uuidv4(),
                user_id: userId,
                event_type: event.event_type,
                severity: event.severity,
                description: event.description,
                ip_address: event.ip,
                user_agent: event.userAgent,
                metadata: event.metadata
            });
    }
}

module.exports = FraudDetectionService;