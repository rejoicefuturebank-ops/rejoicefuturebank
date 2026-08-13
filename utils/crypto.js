const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const SALT_ROUNDS = 10;

const hashPassword = async (password) => {
    return bcrypt.hash(password, SALT_ROUNDS);
};

const comparePassword = async (password, hash) => {
    return bcrypt.compare(password, hash);
};

const generateOTP = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

const hashOTP = (otp) => {
    return crypto.createHash('sha256').update(otp).digest('hex');
};

const generateSessionToken = () => {
    return crypto.randomBytes(32).toString('hex');
};

const generateCardNumber = () => {
    const prefix = '4'; // Visa
    let number = prefix;
    for (let i = 1; i < 15; i++) {
        number += Math.floor(Math.random() * 10);
    }
    // Luhn check digit
    let sum = 0;
    let isEven = false;
    for (let i = number.length - 1; i >= 0; i--) {
        let digit = parseInt(number[i]);
        if (isEven) {
            digit *= 2;
            if (digit > 9) digit -= 9;
        }
        sum += digit;
        isEven = !isEven;
    }
    number += ((10 - (sum % 10)) % 10).toString();
    return number;
};

const generateCVV = () => {
    return Math.floor(100 + Math.random() * 900).toString();
};

module.exports = {
    hashPassword,
    comparePassword,
    generateOTP,
    hashOTP,
    generateSessionToken,
    generateCardNumber,
    generateCVV
};