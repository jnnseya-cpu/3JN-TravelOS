// Transactional email via SMTP (Hostinger).
//
// Credential-gated: activates only when SMTP_PASS is set (env / secret), so the
// offline prototype and tests run unchanged. Defaults target Hostinger's SMTP
// for info@3jntravel.com:
//   host smtp.hostinger.com · port 465 · SSL/TLS · user info@3jntravel.com
// The password is a SECRET — provide it via env (see .env.example), never commit.

import nodemailer from 'nodemailer';

const env = process.env;
let transporter = null;
let enabled = false;

export const MAIL_FROM = env.SMTP_FROM || '3JN Travel OS <info@3jntravel.com>';
export const MAIN_CONTACT = env.SMTP_USER || 'info@3jntravel.com';

export function initMailer() {
  const pass = env.SMTP_PASS;
  if (!pass) return { enabled: false, reason: 'no-smtp-pass' };
  const port = Number(env.SMTP_PORT) || 465;
  try {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST || 'smtp.hostinger.com',
      port,
      secure: port === 465, // SSL on 465
      auth: { user: MAIN_CONTACT, pass },
      // Bound every phase so a slow/dead SMTP fails fast instead of hanging a
      // request that now AWAITS the send (welcome email etc.) before responding.
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 8000,
    });
    enabled = true;
    return { enabled: true, host: env.SMTP_HOST || 'smtp.hostinger.com', port };
  } catch (err) {
    console.warn('[mail] init failed:', err?.message || err);
    return { enabled: false, reason: String(err?.message || err) };
  }
}

export function isMailerEnabled() { return enabled; }

// Send an email. Returns { ok, skipped? } — never throws (email is non-critical).
export async function sendMail({ to, subject, html, text, replyTo, attachments, bcc }) {
  if (!enabled) return { ok: false, skipped: true };
  if (!to || /@guest\.3jn$/.test(to)) return { ok: false, skipped: true, reason: 'no-real-recipient' };
  try {
    const info = await transporter.sendMail({ from: MAIL_FROM, to, subject, html, text, replyTo, ...(bcc ? { bcc } : {}), ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}) });
    return { ok: true, id: info.messageId };
  } catch (err) {
    console.warn('[mail] send failed:', err?.message || err);
    return { ok: false, error: String(err?.message || err) };
  }
}

// Booking-confirmation email body.
export function bookingEmail(option, booking) {
  const p = option.pricing;
  const comps = option.components.map((c) => `<li>${c.type} — ${c.supplier}</li>`).join('');
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;background:#0a1020;color:#eef2fb;padding:24px;border-radius:12px">
      <h2 style="color:#d8b46a;margin:0 0 4px">3JN Travel OS</h2>
      <p style="color:#9aa6c4;margin:0 0 16px">Booking confirmed · ${booking.id}</p>
      <p><strong>${option.tier} package</strong> — total ${p.symbol}${p.local.total}, paid via ${booking.gateway}.</p>
      <ul style="color:#9aa6c4">${comps}</ul>
      <p style="color:#46d39a">Your price is locked — no fare increases or currency surcharges before you travel. Pay monthly, interest-free, at the price you locked today.</p>
      <p style="color:#6b7799;font-size:12px">Questions? Reply to this email or contact info@3jntravel.com.<br/>Powered by Artificial Intelligence · Built for Better Travel.</p>
    </div>`;
  return { subject: `Your 3JN booking is confirmed (${booking.id})`, html, text: `Booking ${booking.id} confirmed — ${option.tier}, ${p.symbol}${p.local.total}.` };
}
