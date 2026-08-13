const Joi = require('joi');

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

module.exports = {
    registerSchema,
    loginSchema,
    transferSchema,
    withdrawalSchema,
    beneficiarySchema,
    supportTicketSchema,
    adminLoginSchema
};