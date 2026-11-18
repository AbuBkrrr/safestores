// ------------------------------------------------------------
// Transactional email — real SMTP delivery via nodemailer.
//
// Works with any SMTP provider: SendGrid, Mailgun, Postmark, Amazon SES,
// Resend, or a plain Gmail/Workspace SMTP relay — just fill in the SMTP_*
// vars in .env (see .env.example). Used for support-ticket notifications
// today; anything else that needs to email a store admin or the support
// inbox can call sendMail() the same way.
//
// If SMTP_HOST isn't set, sendMail() logs a warning and resolves without
// throwing — so a store running without email configured still works,
// it just relies on in-app notifications instead of also getting email.
// ------------------------------------------------------------

let nodemailer;
try {
  nodemailer = require('nodemailer');
} catch {
  nodemailer = null; // package not installed — sendMail() will no-op below
}

const isConfigured = !!(nodemailer && process.env.SMTP_HOST);

let transporter = null;
if (isConfigured) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true', // true for port 465, false for 587/STARTTLS
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
} else {
  console.warn(
    '⚠️  Email: not configured (no SMTP_HOST set, or nodemailer not installed). ' +
    'Support-ticket notifications will only be visible in-app, not emailed. ' +
    'Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS in .env to enable — see .env.example.'
  );
}

/**
 * @param {{ to: string, subject: string, text?: string, html?: string, attachments?: Array<{filename: string, content: string}> }} opts
 * @returns {Promise<boolean>} true if actually sent, false if email isn't configured
 */
async function sendMail({ to, subject, text, html, attachments }) {
  if (!isConfigured || !to) return false;
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || `SAFE Stores <no-reply@${(process.env.SMTP_HOST || 'safestores.local')}>`,
      to,
      subject,
      text,
      html: html || `<p>${text}</p>`,
      attachments,
    });
    return true;
  } catch (err) {
    console.error('Email send failed:', err.message);
    return false;
  }
}

module.exports = { sendMail, isConfigured };
