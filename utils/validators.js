const Joi = require('joi');

// ============================================================
// EXISTING SCHEMAS — unchanged, other routes still depend on these
// ============================================================
const registerSchema = Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().min(8).max(100).required(),
    phone: Joi.string().pattern(/^\+?[1-9]\d{6,14}$/),
    first_name: Joi.string().max(100).required(),
    last_name: Joi.string().max(100).required(),
    date_of_birth: Joi.date().iso(),
    country: Joi.string().max(100),
    nationality: Joi.string().max(100)
});

const loginSchema = Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().required()
});

const transferSchema = Joi.object({
    from_account_id: Joi.string().uuid().required(),
    to_account_id: Joi.string().uuid().optional(),
    beneficiary_id: Joi.string().uuid().optional(),
    recipient_name: Joi.string().max(200),
    recipient_account_number: Joi.string().max(50),
    recipient_bank: Joi.string().max(200),
    recipient_country: Joi.string().max(100),
    amount: Joi.number().positive().required(),
    currency: Joi.string().length(3).required(),
    description: Joi.string().max(500),
    otp_code: Joi.string().length(6).optional()
}).xor('to_account_id', 'beneficiary_id', 'recipient_account_number');

const withdrawalSchema = Joi.object({
    account_id: Joi.string().uuid().required(),
    amount: Joi.number().positive().required(),
    currency: Joi.string().length(3).required(),
    destination: Joi.string().max(500).required(),
    description: Joi.string().max(500),
    otp_code: Joi.string().length(6).optional()
});

const beneficiarySchema = Joi.object({
    name: Joi.string().max(200).required(),
    account_number: Joi.string().max(50).required(),
    bank_name: Joi.string().max(200).required(),
    bank_code: Joi.string().max(20),
    country: Joi.string().max(100),
    currency: Joi.string().length(3)
});

const supportTicketSchema = Joi.object({
    subject: Joi.string().max(200).required(),
    category: Joi.string().valid('general', 'transfer', 'withdrawal', 'card', 'security', 'limit_request', 'account_review', 'otp_assistance').required(),
    priority: Joi.string().valid('low', 'medium', 'high', 'urgent').default('medium'),
    message: Joi.string().max(5000).required(),
    limit_request_id: Joi.string().uuid().optional()
});

const adminLoginSchema = Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().required()
});

// ============================================================
// NEW SCHEMAS — stepped signup flow
// ============================================================

// Step 1: Personal information (client-side only until step 2, but the
// server re-validates it once it arrives bundled with step 2's submit)
const registerStep1Schema = Joi.object({
    first_name: Joi.string().max(100).required(),
    middle_name: Joi.string().max(100).allow('', null).optional(),
    last_name: Joi.string().max(100).required(),
    date_of_birth: Joi.date().iso().max('now').required(),
    gender: Joi.string().valid('male', 'female', 'non_binary', 'prefer_not_to_say').required()
});

// Step 2: Email + password — this is what actually creates the user row
const passwordComplexity = Joi.string()
    .min(8)
    .max(100)
    .pattern(/[A-Z]/, 'uppercase letter')
    .pattern(/[a-z]/, 'lowercase letter')
    .pattern(/[0-9]/, 'number')
    .pattern(/[^A-Za-z0-9]/, 'special character')
    .required()
    .messages({
        'string.pattern.name': 'Password must include at least one {#name}',
        'string.min': 'Password must be at least 8 characters'
    });

const registerStep2Schema = registerStep1Schema.keys({
    email: Joi.string().email().required(),
    password: passwordComplexity,
    confirm_password: Joi.any().valid(Joi.ref('password')).required().messages({
        'any.only': 'Passwords do not match'
    })
});

// Step 3: Location
const registerLocationSchema = Joi.object({
    country: Joi.string().max(100).required(),
    state: Joi.string().max(100).required(),
    city: Joi.string().max(100).required(),
    address: Joi.string().max(500).required()
});

// Step 5: Email verification code
const verifyEmailSchema = Joi.object({
    code: Joi.string().length(6).pattern(/^[0-9]{6}$/).required()
});

// ============================================================
// NEW SCHEMAS — internal transfers, external funding, payouts
// ============================================================

const internalTransferSchema = Joi.object({
    from_account_id: Joi.string().uuid().required(),
    recipient_identifier: Joi.string().required(), // account number or email
    amount: Joi.number().positive().required(),
    currency: Joi.string().length(3).required(),
    description: Joi.string().max(500).allow('', null),
    otp_code: Joi.string().length(6).optional(),
    challenge_id: Joi.string().uuid().optional()
});

const fundingInitiateSchema = Joi.object({
    account_id: Joi.string().uuid().required(),
    amount: Joi.number().positive().required(),
    currency: Joi.string().length(3).required(),
    provider: Joi.string().valid('stripe', 'flutterwave').required()
});

const externalTransferSchema = Joi.object({
    from_account_id: Joi.string().uuid().required(),
    amount: Joi.number().positive().required(),
    currency: Joi.string().length(3).required(),
    beneficiary_id: Joi.string().uuid().required(),
    description: Joi.string().max(500).allow('', null),
    otp_code: Joi.string().length(6).optional(),
    challenge_id: Joi.string().uuid().optional()
});

module.exports = {
    registerSchema,
    loginSchema,
    transferSchema,
    withdrawalSchema,
    beneficiarySchema,
    supportTicketSchema,
    adminLoginSchema,
    registerStep1Schema,
    registerStep2Schema,
    registerLocationSchema,
    verifyEmailSchema,
    internalTransferSchema,
    fundingInitiateSchema,
    externalTransferSchema
};