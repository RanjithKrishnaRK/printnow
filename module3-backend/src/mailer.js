// src/mailer.js
//
// Sends OTP emails via SMTP - works with Gmail (app password), Zoho,
// Mailgun, Resend's SMTP endpoint, or any other SMTP provider. Only touched
// by otp.js/routes/shops.js; if email sending ever needs to change provider
// or become an HTTP API instead of SMTP, this is the only file that changes.
const nodemailer = require('nodemailer');
const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = require('./config');

let transporter = null;

function getTransporter() {
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    // Fails the request that called this (via the route's try/catch), not
    // the whole server at boot - lets everything else keep working in an
    // environment where email just hasn't been set up yet.
    throw new Error(
      'Email is not configured - set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and SMTP_FROM'
    );
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465, // 465 = implicit TLS; 587/others use STARTTLS
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      // Force IPv4. Render (like several other hosts) has no outbound IPv6
      // route, but Node's default DNS resolution can still hand back an
      // IPv6 address for smtp.gmail.com - the connection then fails with
      // ENETUNREACH on an address that was never reachable from this host
      // in the first place. family: 4 makes the DNS lookup only consider
      // IPv4 addresses, so this can't happen.
      family: 4,
      // Without these, a blocked/unreachable SMTP port (common on some
      // hosts, which block outbound SMTP by default) hangs the connection
      // attempt for a long time with no error - the request just never
      // resolves, which looks like a frozen "Sending code…" button with no
      // way to tell what's wrong. Short timeouts turn that into a fast,
      // clear failure instead.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    });
  }
  return transporter;
}

const SUBJECT_BY_PURPOSE = {
  shop_signup: 'Verify your email — PrintNow',
  shop_password_reset: 'Reset your password — PrintNow',
};
const HEADING_BY_PURPOSE = {
  shop_signup: 'Verify your email to finish setting up your shop',
  shop_password_reset: 'Reset your PrintNow password',
};

async function sendOtpEmail(toEmail, otp, purpose) {
  const subject = SUBJECT_BY_PURPOSE[purpose] || 'Your PrintNow verification code';
  const heading = HEADING_BY_PURPOSE[purpose] || 'Your verification code';
  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 480px; margin: 0 auto; color: #1c1917;">
      <h2 style="margin-bottom: 8px;">${heading}</h2>
      <p style="color: #57534e;">Enter this code in PrintNow:</p>
      <p style="font-size: 32px; font-weight: 700; letter-spacing: 6px; margin: 16px 0;">${otp}</p>
      <p style="color: #78716c; font-size: 13px;">
        This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.
      </p>
    </div>
  `;

  const mailer = getTransporter();
  await mailer.sendMail({
    from: SMTP_FROM || SMTP_USER,
    to: toEmail,
    subject,
    html,
  });
}

module.exports = { sendOtpEmail };
