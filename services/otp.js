const { v4: uuidv4 } = require('uuid');
const { generateOTP, hashOTP } = require('../utils/crypto');

class OTPService {
    constructor(supabase) {
        this.supabase = supabase;
    }

    async createChallenge(userId, type, context = {}) {
        // Get user OTP settings
        const { data: settings } = await this.supabase
            .from('otp_settings')
            .select('*')
            .eq('user_id', userId)
            .single();

        // Check if OTP is required for this type
        let required = false;
        if (settings) {
            if (type === 'transfer' && settings.otp_transfers_enabled) required = true;
            if (type === 'withdrawal' && settings.otp_withdrawals_enabled) required = true;
            if (type === 'card_action' && settings.otp_card_actions_enabled) required = true;
            if (type === 'beneficiary' && settings.otp_beneficiary_creation) required = true;
            if (type === 'conversion' && settings.otp_currency_conversion) required = true;
            if (type === 'international' && settings.otp_international_transfers) required = true;

            // Check amount threshold
            if (settings.otp_amount_threshold && context.amount > settings.otp_amount_threshold) {
                required = true;
            }
        }

        if (!required) return { required: false };

        const otp = generateOTP();
        const otpHash = hashOTP(otp);
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

        const { data: challenge, error } = await this.supabase
            .from('otp_challenges')
            .insert({
                id: uuidv4(),
                user_id: userId,
                challenge_type: type,
                challenge_context: context,
                otp_code: otp, // In production, this would be sent via SMS/email, not stored plaintext
                otp_hash: otpHash,
                expires_at: expiresAt.toISOString()
            })
            .select()
            .single();

        if (error) throw error;

        // In a real system, send OTP via SMS/Email
        // For simulation, we return it (in production this would be sent securely)
        return { required: true, challengeId: challenge.id, otp: otp, expiresAt };
    }

    async verifyChallenge(challengeId, otpCode) {
        const { data: challenge, error } = await this.supabase
            .from('otp_challenges')
            .select('*')
            .eq('id', challengeId)
            .single();

        if (error || !challenge) {
            return { verified: false, error: 'Challenge not found' };
        }

        if (challenge.is_verified) {
            return { verified: false, error: 'Already verified' };
        }

        if (challenge.attempts >= challenge.max_attempts) {
            return { verified: false, error: 'Maximum attempts exceeded', locked: true };
        }

        if (new Date(challenge.expires_at) < new Date()) {
            return { verified: false, error: 'OTP expired' };
        }

        const inputHash = hashOTP(otpCode);
        const isValid = inputHash === challenge.otp_hash;

        // Update attempts
        await this.supabase
            .from('otp_challenges')
            .update({
                attempts: challenge.attempts + 1,
                is_verified: isValid,
                verified_at: isValid ? new Date().toISOString() : null
            })
            .eq('id', challengeId);

        if (isValid) {
            return { verified: true };
        } else {
            return { verified: false, error: 'Invalid OTP', attemptsRemaining: challenge.max_attempts - challenge.attempts - 1 };
        }
    }

    async checkOTPRequired(userId, type, context) {
        const { data: settings } = await this.supabase
            .from('otp_settings')
            .select('*')
            .eq('user_id', userId)
            .single();

        if (!settings) return false;

        if (type === 'transfer' && settings.otp_transfers_enabled) return true;
        if (type === 'withdrawal' && settings.otp_withdrawals_enabled) return true;
        if (type === 'card_action' && settings.otp_card_actions_enabled) return true;
        if (type === 'beneficiary' && settings.otp_beneficiary_creation) return true;
        if (type === 'conversion' && settings.otp_currency_conversion) return true;
        if (type === 'international' && settings.otp_international_transfers) return true;

        if (settings.otp_amount_threshold && context.amount > settings.otp_amount_threshold) {
            return true;
        }

        return false;
    }
}

module.exports = OTPService;