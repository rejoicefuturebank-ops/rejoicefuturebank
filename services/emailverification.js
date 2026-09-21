const { generateOTP, hashOTP } = require('../utils/crypto');
const { sendVerificationCodeEmail } = require('./email');

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000; // 1 minute between resends

class EmailVerificationService {
    constructor(supabase) {
        this.supabase = supabase;
    }

    // Generates a new code, stores its hash, and emails it. Used for both
    // the initial send (end of step 5) and "resend code".
    async sendCode(userId, email, firstName) {
        const { data: user } = await this.supabase
            .from('users')
            .select('email_verification_last_sent_at')
            .eq('id', userId)
            .single();

        if (user?.email_verification_last_sent_at) {
            const elapsed = Date.now() - new Date(user.email_verification_last_sent_at).getTime();
            if (elapsed < RESEND_COOLDOWN_MS) {
                const waitSeconds = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
                return { sent: false, error: `Please wait ${waitSeconds}s before requesting another code.` };
            }
        }

        const code = generateOTP();
        const codeHash = hashOTP(code);
        const expiresAt = new Date(Date.now() + CODE_TTL_MS);

        const { error } = await this.supabase
            .from('users')
            .update({
                email_verification_code_hash: codeHash,
                email_verification_expires_at: expiresAt.toISOString(),
                email_verification_attempts: 0,
                email_verification_last_sent_at: new Date().toISOString(),
                registration_status: 'email_pending'
            })
            .eq('id', userId);

        if (error) throw error;

        await sendVerificationCodeEmail(email, firstName, code);

        return { sent: true, expiresAt };
    }

    async verifyCode(userId, submittedCode) {
        const { data: user, error } = await this.supabase
            .from('users')
            .select('email_verification_code_hash, email_verification_expires_at, email_verification_attempts')
            .eq('id', userId)
            .single();

        if (error || !user || !user.email_verification_code_hash) {
            return { verified: false, error: 'No verification code found. Please request a new one.' };
        }

        if (user.email_verification_attempts >= MAX_ATTEMPTS) {
            return { verified: false, error: 'Too many attempts. Please request a new code.', locked: true };
        }

        if (new Date(user.email_verification_expires_at) < new Date()) {
            return { verified: false, error: 'This code has expired. Please request a new one.', expired: true };
        }

        const isValid = hashOTP(submittedCode) === user.email_verification_code_hash;

        if (!isValid) {
            await this.supabase
                .from('users')
                .update({ email_verification_attempts: user.email_verification_attempts + 1 })
                .eq('id', userId);

            return {
                verified: false,
                error: 'Invalid code.',
                attemptsRemaining: Math.max(0, MAX_ATTEMPTS - (user.email_verification_attempts + 1))
            };
        }

        // Success — clear the challenge and activate the account.
        await this.supabase
            .from('users')
            .update({
                email_verified: true,
                registration_status: 'active',
                email_verification_code_hash: null,
                email_verification_expires_at: null,
                email_verification_attempts: 0
            })
            .eq('id', userId);

        await this.supabase
            .from('profiles')
            .update({ signup_stage: 5 })
            .eq('user_id', userId);

        return { verified: true };
    }
}

module.exports = EmailVerificationService;