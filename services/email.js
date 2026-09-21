// ============================================================
// EMAIL SERVICE — Brevo (transactional API)
// Requires env vars: BREVO_API_KEY, BREVO_SENDER_EMAIL, BREVO_SENDER_NAME
// No extra dependency needed — uses the built-in fetch (Node 18+).
// ============================================================

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

async function sendEmail({ to, toName, subject, html, text }) {
    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.BREVO_SENDER_EMAIL;
    const senderName = process.env.BREVO_SENDER_NAME || 'RejoiceFutureBank';

    if (!apiKey || !senderEmail) {
        // Fail loudly in server logs, but don't leak this detail to the client.
        console.error('Email service misconfigured: missing BREVO_API_KEY or BREVO_SENDER_EMAIL');
        throw new Error('Email service is not configured');
    }

    const response = await fetch(BREVO_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'api-key': apiKey
        },
        body: JSON.stringify({
            sender: { email: senderEmail, name: senderName },
            to: [{ email: to, name: toName || to }],
            subject,
            htmlContent: html,
            textContent: text
        })
    });

    if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        console.error('Brevo send failed:', response.status, errorBody);
        throw new Error('Failed to send email');
    }

    return response.json();
}

async function sendVerificationCodeEmail(toEmail, firstName, code) {
    return sendEmail({
        to: toEmail,
        toName: firstName,
        subject: 'Verify your email — RejoiceFutureBank',
        text: `Hi ${firstName || ''},\n\nYour RejoiceFutureBank verification code is: ${code}\n\nThis code expires in 10 minutes. If you didn't request this, you can safely ignore this email.`,
        html: `
            <div style="font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1e293b;">
                <p>Hi ${firstName || 'there'},</p>
                <p>Your RejoiceFutureBank verification code is:</p>
                <div style="font-size: 32px; font-weight: 700; letter-spacing: 8px; text-align: center; padding: 20px; background: #f1f5f9; border-radius: 8px; margin: 16px 0;">
                    ${code}
                </div>
                <p style="color: #64748b; font-size: 14px;">This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>
            </div>
        `
    });
}

module.exports = { sendEmail, sendVerificationCodeEmail };