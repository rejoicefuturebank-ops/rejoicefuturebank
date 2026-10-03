const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const {
    hashPassword,
    comparePassword,
    generateSessionToken
} = require('../utils/crypto');
const {
    loginSchema,
    registerStep2Schema,
    registerLocationSchema,
    verifyEmailSchema
} = require('../utils/validators');
const { authenticate } = require('../../middleware/auth');
const EmailVerificationService = require('../../services/emailverification');
const { sendEmail } = require('../../services/email');

const signToken = (user) => jwt.sign(
    {
        id: user.id,
        email: user.email,
        is_frozen: user.is_frozen,
        is_suspended: user.is_suspended
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
);

const hashResetToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// ============================================================
// STEP 1 (personal info) is client-side only — there is no user
// record to attach it to until step 2 supplies a unique email.
// The frontend holds first/middle/last name, DOB, and gender in
// memory and re-submits them here bundled with step 2's fields.
// ============================================================

// STEP 2 — create the account (personal info + email + password)
router.post('/register', async (req, res) => {
    try {
        const { error, value } = registerStep2Schema.validate(req.body);
        if (error) return res.status(400).json({ error: error.details[0].message });

        const { email, password, first_name, middle_name, last_name, date_of_birth, gender } = value;

        const { data: existingUser } = await req.supabase
            .from('users')
            .select('id, registration_status')
            .eq('email', email)
            .single();

        if (existingUser) {
            if (existingUser.registration_status === 'active') {
                return res.status(409).json({
                    error: 'An account with this email already exists. Please sign in.'
                });
            }
            // Incomplete registration with this email — don't create a duplicate.
            return res.status(409).json({
                error: 'You already started an account with this email. Please sign in to continue where you left off.',
                resume: true
            });
        }

        const passwordHash = await hashPassword(password);

        const { data: user, error: userError } = await req.supabase
            .from('users')
            .insert({
                id: uuidv4(),
                email,
                password_hash: passwordHash,
                email_verified: false,
                registration_status: 'in_progress'
            })
            .select()
            .single();

        if (userError) throw userError;

        const { error: profileError } = await req.supabase.from('profiles').insert({
            id: uuidv4(),
            user_id: user.id,
            first_name,
            middle_name: middle_name || null,
            last_name,
            full_name: `${first_name} ${last_name}`,
            date_of_birth,
            gender,
            kyc_status: 'pending',
            signup_stage: 2
        });

        if (profileError) throw profileError;

        const token = signToken(user);

        res.status(201).json({
            token,
            user: { id: user.id, email: user.email },
            registration_status: 'in_progress',
            signup_stage: 2
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'We couldn\'t create your account. Please try again.' });
    }
});

// STEP 3 — location
router.patch('/register/location', authenticate, async (req, res) => {
    try {
        const { error, value } = registerLocationSchema.validate(req.body);
        if (error) return res.status(400).json({ error: error.details[0].message });

        const { country, state, city, address } = value;

        const { error: updateError } = await req.supabase
            .from('profiles')
            .update({ country, state, city, address, signup_stage: 3 })
            .eq('user_id', req.user.id);

        if (updateError) throw updateError;

        res.json({ message: 'Location saved', signup_stage: 3 });
    } catch (error) {
        console.error('Location update error:', error);
        res.status(500).json({ error: 'Failed to save location' });
    }
});

// STEP 4 — review (returns everything collected so far)
router.get('/register/review', authenticate, async (req, res) => {
    try {
        const { data: user } = await req.supabase
            .from('users')
            .select('email, registration_status')
            .eq('id', req.user.id)
            .single();

        const { data: profile } = await req.supabase
            .from('profiles')
            .select('first_name, middle_name, last_name, date_of_birth, gender, country, state, city, address, signup_stage')
            .eq('user_id', req.user.id)
            .single();

        if (!user || !profile) {
            return res.status(404).json({ error: 'Registration not found' });
        }

        // Reaching review means step 3 is behind them; advance the marker.
        if (profile.signup_stage < 4) {
            await req.supabase.from('profiles').update({ signup_stage: 4 }).eq('user_id', req.user.id);
        }

        res.json({
            email: user.email,
            registration_status: user.registration_status,
            personal: {
                first_name: profile.first_name,
                middle_name: profile.middle_name,
                last_name: profile.last_name,
                date_of_birth: profile.date_of_birth,
                gender: profile.gender
            },
            location: {
                country: profile.country,
                state: profile.state,
                city: profile.city,
                address: profile.address
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load review' });
    }
});

// STEP 5 — send the first verification code
router.post('/register/send-verification', authenticate, async (req, res) => {
    try {
        const { data: user } = await req.supabase
            .from('users')
            .select('email')
            .eq('id', req.user.id)
            .single();

        const { data: profile } = await req.supabase
            .from('profiles')
            .select('first_name')
            .eq('user_id', req.user.id)
            .single();

        const verification = new EmailVerificationService(req.supabase);
        const result = await verification.sendCode(req.user.id, user.email, profile?.first_name);

        if (!result.sent) {
            return res.status(429).json({ error: result.error });
        }

        res.json({ message: 'Verification code sent', expires_at: result.expiresAt });
    } catch (error) {
        console.error('Send verification error:', error);
        res.status(500).json({ error: 'Failed to send verification code' });
    }
});

// Resend code (same cooldown/rate-limit logic as the initial send)
router.post('/register/resend-code', authenticate, async (req, res) => {
    try {
        const { data: user } = await req.supabase
            .from('users')
            .select('email')
            .eq('id', req.user.id)
            .single();

        const { data: profile } = await req.supabase
            .from('profiles')
            .select('first_name')
            .eq('user_id', req.user.id)
            .single();

        const verification = new EmailVerificationService(req.supabase);
        const result = await verification.sendCode(req.user.id, user.email, profile?.first_name);

        if (!result.sent) {
            return res.status(429).json({ error: result.error });
        }

        res.json({ message: 'Verification code resent', expires_at: result.expiresAt });
    } catch (error) {
        res.status(500).json({ error: 'Failed to resend code' });
    }
});

// Verify the code and activate the account
router.post('/register/verify-email', authenticate, async (req, res) => {
    try {
        const { error, value } = verifyEmailSchema.validate(req.body);
        if (error) return res.status(400).json({ error: 'Please enter a valid 6-digit code' });

        const verification = new EmailVerificationService(req.supabase);
        const result = await verification.verifyCode(req.user.id, value.code);

        if (!result.verified) {
            const statusCode = result.locked ? 429 : (result.expired ? 410 : 400);
            return res.status(statusCode).json({
                error: result.error,
                attemptsRemaining: result.attemptsRemaining
            });
        }

        // Only now — after real verification — do we bootstrap banking
        // infrastructure for this user. An abandoned signup never gets one.
        const userId = req.user.id;

        const accountNumber = 'ACC' + Date.now().toString().slice(-10);
        const { data: account } = await req.supabase
            .from('accounts')
            .insert({
                id: uuidv4(),
                user_id: userId,
                account_number: accountNumber,
                account_type: 'checking',
                currency: 'USD'
            })
            .select()
            .single();

        if (account) {
            await req.supabase.from('account_balances').insert({
                id: uuidv4(),
                account_id: account.id,
                available_balance: 0,
                pending_balance: 0
            });
        }

        await req.supabase.from('transfer_limits').insert({ id: uuidv4(), user_id: userId });
        await req.supabase.from('otp_settings').insert({ id: uuidv4(), user_id: userId });
        await req.supabase.from('investment_portfolios').insert({ id: uuidv4(), user_id: userId });

        await req.supabase.from('notifications').insert({
            id: uuidv4(),
            user_id: userId,
            type: 'welcome',
            title: 'Welcome to RejoiceFutureBank!',
            message: 'Your account is ready. Welcome aboard.'
        });

        const { data: user } = await req.supabase
            .from('users')
            .select('*')
            .eq('id', userId)
            .single();

        const token = signToken(user);

        res.json({
            message: 'Your account is ready.',
            token,
            registration_status: 'active'
        });
    } catch (error) {
        console.error('Verify email error:', error);
        res.status(500).json({ error: 'Verification failed' });
    }
});

// ============================================================
// LOGIN — status decides routing, decided server-side only
// ============================================================
router.post('/login', async (req, res) => {
    try {
        const { error } = loginSchema.validate(req.body);
        if (error) return res.status(400).json({ error: error.details[0].message });

        const { email, password } = req.body;

        const { data: user, error: userError } = await req.supabase
            .from('users')
            .select('*, profiles(*)')
            .eq('email', email)
            .single();

        if (userError || !user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        if (user.registration_status === 'suspended') {
            return res.status(403).json({
                error: 'Your account has been suspended. Please contact support.',
                code: 'ACCOUNT_SUSPENDED'
            });
        }

        if (user.registration_status === 'closed') {
            return res.status(403).json({
                error: 'This account has been closed. Please contact support.',
                code: 'ACCOUNT_CLOSED'
            });
        }

        // Frozen users can still log in — they just can't perform financial
        // actions (enforced by the checkFrozen middleware elsewhere).

        if (user.locked_until && new Date(user.locked_until) > new Date()) {
            return res.status(423).json({ error: 'Account temporarily locked. Please try again later.' });
        }

        const isValid = await comparePassword(password, user.password_hash);

        if (!isValid) {
            const attempts = (user.login_attempts || 0) + 1;
            const updateData = { login_attempts: attempts };

            if (attempts >= 5) {
                updateData.locked_until = new Date(Date.now() + 30 * 60 * 1000).toISOString();
                updateData.login_attempts = 0;
            }

            await req.supabase.from('users').update(updateData).eq('id', user.id);

            await req.supabase.from('login_history').insert({
                id: uuidv4(),
                user_id: user.id,
                login_type: 'password',
                ip_address: req.ip,
                user_agent: req.get('user-agent'),
                is_successful: false,
                failure_reason: 'invalid_password'
            });

            return res.status(401).json({
                error: 'Invalid credentials',
                attemptsRemaining: Math.max(0, 5 - attempts)
            });
        }

        await req.supabase
            .from('users')
            .update({
                login_attempts: 0,
                locked_until: null,
                last_login: new Date().toISOString(),
                last_login_ip: req.ip
            })
            .eq('id', user.id);

        const token = signToken(user);

        const sessionToken = generateSessionToken();
        await req.supabase.from('device_sessions').insert({
            id: uuidv4(),
            user_id: user.id,
            session_token: sessionToken,
            device_info: { userAgent: req.get('user-agent') },
            ip_address: req.ip,
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        });

        await req.supabase.from('login_history').insert({
            id: uuidv4(),
            user_id: user.id,
            login_type: 'password',
            ip_address: req.ip,
            user_agent: req.get('user-agent'),
            is_successful: true
        });

        if (!user.is_frozen && user.registration_status === 'active') {
            await req.supabase.from('notifications').insert({
                id: uuidv4(),
                user_id: user.id,
                type: 'login',
                title: 'New Login Detected',
                message: `A new login was detected from IP: ${req.ip}`
            });
        }

        const profile = user.profiles;

        res.json({
            user: {
                id: user.id,
                email: user.email,
                phone: user.phone,
                two_factor_enabled: user.two_factor_enabled,
                is_frozen: user.is_frozen,
                is_suspended: user.is_suspended
            },
            profile: profile ? {
                first_name: profile.first_name,
                last_name: profile.last_name,
                full_name: profile.full_name,
                country: profile.country
            } : null,
            token,
            // Server is authoritative on where the frontend should route next.
            registration_status: user.registration_status,
            signup_stage: profile?.signup_stage ?? 5
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// ============================================================
// ADMIN LOGIN
// ============================================================
router.post('/admin/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        const { data: admin, error } = await req.supabase
            .from('admin_users')
            .select('*, admin_roles(name)')
            .eq('email', email)
            .single();

        if (error || !admin) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        if (!admin.is_active) {
            return res.status(403).json({ error: 'Account disabled' });
        }

        const isValid = await comparePassword(password, admin.password_hash);
        if (!isValid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const { data: permissions } = await req.supabase
            .from('admin_permissions')
            .select('permission')
            .eq('role_id', admin.role_id);

        const token = jwt.sign(
            {
                id: admin.id,
                email: admin.email,
                role_id: admin.role_id,
                role_name: admin.admin_roles.name,
                permissions: permissions.map((p) => p.permission)
            },
            process.env.ADMIN_JWT_SECRET,
            { expiresIn: '8h' }
        );

        await req.supabase
            .from('admin_users')
            .update({ last_login: new Date().toISOString() })
            .eq('id', admin.id);

        res.json({
            admin: {
                id: admin.id,
                email: admin.email,
                first_name: admin.first_name,
                last_name: admin.last_name,
                role: admin.admin_roles.name,
                permissions: permissions.map((p) => p.permission)
            },
            token
        });
    } catch (error) {
        console.error('Admin login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Get current user
router.get('/me', authenticate, async (req, res) => {
    try {
        const { data: user } = await req.supabase
            .from('users')
            .select('*, profiles(*)')
            .eq('id', req.user.id)
            .single();

        if (!user) return res.status(404).json({ error: 'User not found' });

        const { data: accounts } = await req.supabase
            .from('accounts')
            .select('*, account_balances(*)')
            .eq('user_id', req.user.id)
            .eq('is_active', true);

        const freezeInfo = user.is_frozen ? {
            is_frozen: true,
            reason: user.freeze_reason || 'No reason provided',
            frozen_at: user.frozen_at
        } : { is_frozen: false };

        res.json({
            user,
            accounts,
            freeze_info: freezeInfo,
            registration_status: user.registration_status,
            signup_stage: user.profiles?.signup_stage ?? 5
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get user data' });
    }
});

// Logout
router.post('/logout', authenticate, async (req, res) => {
    try {
        await req.supabase
            .from('device_sessions')
            .update({ is_active: false })
            .eq('user_id', req.user.id);

        res.json({ message: 'Logged out successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Logout failed' });
    }
});

// ============================================================
// PASSWORD RESET — actually wired up (was a stub before)
// ============================================================
router.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email is required' });

        const { data: user } = await req.supabase
            .from('users')
            .select('id')
            .eq('email', email)
            .single();

        // Always return the same message either way — never reveal
        // whether an email is registered.
        if (user) {
            const resetToken = crypto.randomBytes(32).toString('hex');
            const tokenHash = hashResetToken(resetToken);
            const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min

            await req.supabase
                .from('users')
                .update({
                    password_reset_token_hash: tokenHash,
                    password_reset_expires_at: expiresAt.toISOString()
                })
                .eq('id', user.id);

            const resetUrl = `${process.env.FRONTEND_URL || ''}/reset-password.html?token=${resetToken}`;

            await sendEmail({
                to: email,
                subject: 'Reset your RejoiceFutureBank password',
                text: `We received a request to reset your password. This link expires in 30 minutes:\n\n${resetUrl}\n\nIf you didn't request this, you can ignore this email.`,
                html: `<p>We received a request to reset your password. This link expires in 30 minutes:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you didn't request this, you can ignore this email.</p>`
            }).catch((e) => console.error('Password reset email failed:', e));
        }

        res.json({ message: 'If an account exists for this email, a reset link has been sent.' });
    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ error: 'Failed to process request' });
    }
});

router.post('/reset-password', async (req, res) => {
    try {
        const { token, newPassword } = req.body;
        if (!token || !newPassword) {
            return res.status(400).json({ error: 'Token and new password are required' });
        }
        if (newPassword.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        const tokenHash = hashResetToken(token);

        const { data: user } = await req.supabase
            .from('users')
            .select('id, password_reset_expires_at')
            .eq('password_reset_token_hash', tokenHash)
            .single();

        if (!user) {
            return res.status(400).json({ error: 'This reset link is invalid or has already been used.' });
        }

        if (new Date(user.password_reset_expires_at) < new Date()) {
            return res.status(410).json({ error: 'This reset link has expired. Please request a new one.' });
        }

        const passwordHash = await hashPassword(newPassword);

        await req.supabase
            .from('users')
            .update({
                password_hash: passwordHash,
                password_reset_token_hash: null,
                password_reset_expires_at: null,
                login_attempts: 0,
                locked_until: null
            })
            .eq('id', user.id);

        res.json({ message: 'Password reset successfully. Please sign in with your new password.' });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

module.exports = router;