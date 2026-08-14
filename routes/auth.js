const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const {
  hashPassword,
  comparePassword,
  generateSessionToken,
} = require("../utils/crypto");
const { registerSchema, loginSchema } = require("../utils/validators");

// Register
router.post("/register", async (req, res) => {
  try {
    const { error } = registerSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const {
      email,
      password,
      phone,
      first_name,
      last_name,
      date_of_birth,
      country,
      nationality,
    } = req.body;

    // Check if user exists
    const { data: existingUser } = await req.supabase
      .from("users")
      .select("id")
      .eq("email", email)
      .single();

    if (existingUser) {
      return res.status(409).json({ error: "Email already registered" });
    }

    // Hash password
    const passwordHash = await hashPassword(password);

    // Create user
    const { data: user, error: userError } = await req.supabase
      .from("users")
      .insert({
        id: uuidv4(),
        email,
        password_hash: passwordHash,
        phone,
        email_verified: true, // Auto-verify for demo
        phone_verified: false,
      })
      .select()
      .single();

    if (userError) throw userError;

    // Create profile
    const { error: profileError } = await req.supabase.from("profiles").insert({
      id: uuidv4(),
      user_id: user.id,
      first_name,
      last_name,
      full_name: `${first_name} ${last_name}`,
      date_of_birth,
      country,
      nationality,
      kyc_status: "pending",
    });

    if (profileError) throw profileError;

    // Create default USD account
    const accountNumber = "ACC" + Date.now().toString().slice(-10);
    const { data: account } = await req.supabase
      .from("accounts")
      .insert({
        id: uuidv4(),
        user_id: user.id,
        account_number: accountNumber,
        account_type: "checking",
        currency: "USD",
      })
      .select()
      .single();

    // Create balance record
    await req.supabase.from("account_balances").insert({
      id: uuidv4(),
      account_id: account.id,
      available_balance: 0,
      pending_balance: 0,
    });

    // Create default transfer limits
    await req.supabase.from("transfer_limits").insert({
      id: uuidv4(),
      user_id: user.id,
    });

    // Create default OTP settings
    await req.supabase.from("otp_settings").insert({
      id: uuidv4(),
      user_id: user.id,
    });

    // Create investment portfolio
    await req.supabase.from("investment_portfolios").insert({
      id: uuidv4(),
      user_id: user.id,
    });

    // Generate token
    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "24h" },
    );

    // Create session
    const sessionToken = generateSessionToken();
    await req.supabase.from("device_sessions").insert({
      id: uuidv4(),
      user_id: user.id,
      session_token: sessionToken,
      ip_address: req.ip,
      user_agent: req.get("user-agent"),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });

    // Record login
    await req.supabase.from("login_history").insert({
      id: uuidv4(),
      user_id: user.id,
      login_type: "registration",
      ip_address: req.ip,
      user_agent: req.get("user-agent"),
      is_successful: true,
    });

    // Create welcome notification
    await req.supabase.from("notifications").insert({
      id: uuidv4(),
      user_id: user.id,
      type: "welcome",
      title: "Welcome to GlobalBank!",
      message:
        "Your account has been created successfully. Welcome to our international banking platform.",
    });

    res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
      },
      token,
      account: {
        id: account.id,
        account_number: account.account_number,
        currency: account.currency,
      },
    });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({ error: "Registration failed" });
  }
});

// Login
/*router.post("/login", async (req, res) => {
  try {
    const { error } = loginSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const { email, password } = req.body;

    // Get user
    const { data: user, error: userError } = await req.supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .single();

    if (userError || !user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Check if account is locked
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return res
        .status(423)
        .json({ error: "Account temporarily locked. Please try again later." });
    }

    // Check if suspended/frozen
    if (user.is_suspended) {
      return res
        .status(403)
        .json({ error: "Account suspended. Please contact support." });
    }

    if (user.is_frozen) {
      return res
        .status(403)
        .json({ error: "Account frozen. Please contact support." });
    }

    // Verify password
    const isValid = await comparePassword(password, user.password_hash);

    if (!isValid) {
      // Increment login attempts
      const attempts = (user.login_attempts || 0) + 1;
      const updateData = { login_attempts: attempts };

      if (attempts >= 5) {
        updateData.locked_until = new Date(
          Date.now() + 30 * 60 * 1000,
        ).toISOString();
        updateData.login_attempts = 0;
      }

      await req.supabase.from("users").update(updateData).eq("id", user.id);

      // Record failed login
      await req.supabase.from("login_history").insert({
        id: uuidv4(),
        user_id: user.id,
        login_type: "password",
        ip_address: req.ip,
        user_agent: req.get("user-agent"),
        is_successful: false,
        failure_reason: "invalid_password",
      });

      return res.status(401).json({
        error: "Invalid credentials",
        attemptsRemaining: Math.max(0, 5 - attempts),
      });
    }

    // Reset login attempts
    await req.supabase
      .from("users")
      .update({
        login_attempts: 0,
        locked_until: null,
        last_login: new Date().toISOString(),
        last_login_ip: req.ip,
      })
      .eq("id", user.id);

    // Get profile
    const { data: profile } = await req.supabase
      .from("profiles")
      .select("*")
      .eq("user_id", user.id)
      .single();

    // Generate token
    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "24h" },
    );

    // Create session
    const sessionToken = generateSessionToken();
    await req.supabase.from("device_sessions").insert({
      id: uuidv4(),
      user_id: user.id,
      session_token: sessionToken,
      device_info: { userAgent: req.get("user-agent") },
      ip_address: req.ip,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });

    // Record successful login
    await req.supabase.from("login_history").insert({
      id: uuidv4(),
      user_id: user.id,
      login_type: "password",
      ip_address: req.ip,
      user_agent: req.get("user-agent"),
      is_successful: true,
    });

    // Login notification
    await req.supabase.from("notifications").insert({
      id: uuidv4(),
      user_id: user.id,
      type: "login",
      title: "New Login Detected",
      message: `A new login was detected from IP: ${req.ip}`,
    });

    res.json({
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        two_factor_enabled: user.two_factor_enabled,
      },
      profile: {
        first_name: profile?.first_name,
        last_name: profile?.last_name,
        full_name: profile?.full_name,
        country: profile?.country,
      },
      token,
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
});*/

// Login - ALLOW FROZEN USERS TO LOGIN
router.post('/login', async (req, res) => {
    try {
        const { error } = loginSchema.validate(req.body);
        if (error) return res.status(400).json({ error: error.details[0].message });

        const { email, password } = req.body;

        const { data: user, error: userError } = await req.supabase
            .from('users')
            .select('*')
            .eq('email', email)
            .single();

        if (userError || !user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // ✅ ONLY BLOCK SUSPENDED USERS (not frozen)
        if (user.is_suspended) {
            return res.status(403).json({ 
                error: 'Your account has been suspended. Please contact support.',
                code: 'ACCOUNT_SUSPENDED'
            });
        }

        // ✅ FROZEN USERS CAN LOGIN - they just can't perform actions
        // We pass the frozen status so frontend knows to show banner

        // Check if account is locked
        if (user.locked_until && new Date(user.locked_until) > new Date()) {
            return res.status(423).json({ error: 'Account temporarily locked. Please try again later.' });
        }

        // Verify password
        const isValid = await comparePassword(password, user.password_hash);

        if (!isValid) {
            const attempts = (user.login_attempts || 0) + 1;
            const updateData = { login_attempts: attempts };

            if (attempts >= 5) {
                updateData.locked_until = new Date(Date.now() + 30 * 60 * 1000).toISOString();
                updateData.login_attempts = 0;
            }

            await req.supabase
                .from('users')
                .update(updateData)
                .eq('id', user.id);

            await req.supabase
                .from('login_history')
                .insert({
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

        // Reset login attempts
        await req.supabase
            .from('users')
            .update({
                login_attempts: 0,
                locked_until: null,
                last_login: new Date().toISOString(),
                last_login_ip: req.ip
            })
            .eq('id', user.id);

        // Get profile
        const { data: profile } = await req.supabase
            .from('profiles')
            .select('*')
            .eq('user_id', user.id)
            .single();

        // Generate token - include frozen status
        const token = jwt.sign(
            { 
                id: user.id, 
                email: user.email,
                is_frozen: user.is_frozen, // ✅ Include frozen status in token
                is_suspended: user.is_suspended
            },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
        );

        // Create session
        const sessionToken = generateSessionToken();
        await req.supabase
            .from('device_sessions')
            .insert({
                id: uuidv4(),
                user_id: user.id,
                session_token: sessionToken,
                device_info: { userAgent: req.get('user-agent') },
                ip_address: req.ip,
                expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
            });

        // Record successful login
        await req.supabase
            .from('login_history')
            .insert({
                id: uuidv4(),
                user_id: user.id,
                login_type: 'password',
                ip_address: req.ip,
                user_agent: req.get('user-agent'),
                is_successful: true
            });

        // Login notification (only if not frozen)
        if (!user.is_frozen) {
            await req.supabase
                .from('notifications')
                .insert({
                    id: uuidv4(),
                    user_id: user.id,
                    type: 'login',
                    title: 'New Login Detected',
                    message: `A new login was detected from IP: ${req.ip}`
                });
        }

        res.json({
            user: {
                id: user.id,
                email: user.email,
                phone: user.phone,
                two_factor_enabled: user.two_factor_enabled,
                is_frozen: user.is_frozen, // ✅ Send frozen status to frontend
                is_suspended: user.is_suspended
            },
            profile: {
                first_name: profile?.first_name,
                last_name: profile?.last_name,
                full_name: profile?.full_name,
                country: profile?.country
            },
            token
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Admin Login
router.post("/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const { data: admin, error } = await req.supabase
      .from("admin_users")
      .select("*, admin_roles(name)")
      .eq("email", email)
      .single();

    /*if (error || !admin) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }*/
    if (error || !admin) {
      console.error("Supabase Admin Query Error:", error);
      return res.status(401).json({
        error: "Invalid credentials",
        debug_info: error ? error.message : "User not found in database",
      });
    }

    if (!admin.is_active) {
      return res.status(403).json({ error: "Account disabled" });
    }

    const isValid = await comparePassword(password, admin.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Get permissions
    const { data: permissions } = await req.supabase
      .from("admin_permissions")
      .select("permission")
      .eq("role_id", admin.role_id);

    const token = jwt.sign(
      {
        id: admin.id,
        email: admin.email,
        role_id: admin.role_id,
        role_name: admin.admin_roles.name,
        permissions: permissions.map((p) => p.permission),
      },
      process.env.ADMIN_JWT_SECRET,
      { expiresIn: "8h" },
    );

    // Update last login
    await req.supabase
      .from("admin_users")
      .update({ last_login: new Date().toISOString() })
      .eq("id", admin.id);

    res.json({
      admin: {
        id: admin.id,
        email: admin.email,
        first_name: admin.first_name,
        last_name: admin.last_name,
        role: admin.admin_roles.name,
        permissions: permissions.map((p) => p.permission),
      },
      token,
    });
  } catch (error) {
    console.error("Admin login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
});

// Get current user
router.get(
  "/me",
  require("../middleware/auth").authenticate,
  async (req, res) => {
    try {
      const { data: user } = await req.supabase
        .from("users")
        .select("*, profiles(*)")
        .eq("id", req.user.id)
        .single();

      const { data: accounts } = await req.supabase
        .from("accounts")
        .select("*, account_balances(*)")
        .eq("user_id", req.user.id)
        .eq("is_active", true);

      res.json({ user, accounts });
    } catch (error) {
      res.status(500).json({ error: "Failed to get user data" });
    }
  },
);

// Logout
router.post(
  "/logout",
  require("../middleware/auth").authenticate,
  async (req, res) => {
    try {
      // Deactivate session
      await req.supabase
        .from("device_sessions")
        .update({ is_active: false })
        .eq("user_id", req.user.id);

      res.json({ message: "Logged out successfully" });
    } catch (error) {
      res.status(500).json({ error: "Logout failed" });
    }
  },
);

// Forgot password
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    const { data: user } = await req.supabase
      .from("users")
      .select("id")
      .eq("email", email)
      .single();

    // Always return success (don't reveal if email exists)
    if (user) {
      // In production, send email with reset token
      // For demo, we'll simulate it
      const resetToken = require("crypto").randomBytes(32).toString("hex");
      // Store reset token with expiry...
    }

    res.json({ message: "If the email exists, a reset link has been sent." });
  } catch (error) {
    res.status(500).json({ error: "Failed to process request" });
  }
});

// Reset password
router.post("/reset-password", async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    // Verify token and update password
    const passwordHash = await hashPassword(newPassword);
    // Update user password...
    res.json({ message: "Password reset successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to reset password" });
  }
});

module.exports = router;
