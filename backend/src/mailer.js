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
// ---- Lead funnel emails ----------------------------------------------------
// Escaping — recipient-supplied destination text renders into HTML email.
function mailEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function mailShell(inner) {
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;background:#0a1020;color:#eef2fb;padding:24px;border-radius:12px">
    <h2 style="color:#d8b46a;margin:0 0 4px">3JN Travel OS</h2>
    ${inner}
    <p style="color:#6b7799;font-size:12px;margin-top:20px">Powered by Artificial Intelligence · Built for Better Travel.</p>
  </div>`;
}
// Welcome / double-confirmation when someone asks for a cheapest-date alert.
export function leadWelcomeEmail({ destination, fromGbp, months, planUrl, unsubUrl } = {}) {
  const dest = mailEsc(destination || 'your next trip');
  const priceLine = fromGbp ? `<p style="color:#46d39a">Trips to ${dest} are indicatively from <strong>£${fromGbp}pp</strong> right now — and you can spread it over monthly instalments.</p>` : '';
  const monthLine = Array.isArray(months) && months.length ? `<p style="color:#9aa6c4">Cheaper months to fly: <strong>${mailEsc(months.join(', '))}</strong>.</p>` : '';
  const html = mailShell(`
    <p style="color:#9aa6c4;margin:0 0 16px">You're on the list ✈</p>
    <p>We'll watch fares to <strong>${dest}</strong> and email you when the price is worth booking.</p>
    ${priceLine}${monthLine}
    <p style="margin:18px 0"><a href="${mailEsc(planUrl || 'https://3jntravel.com/?open=planner')}" style="background:#1668e3;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700">Plan my ${dest} trip now →</a></p>
    <p style="color:#6b7799;font-size:12px">Not interested? <a href="${mailEsc(unsubUrl || 'https://3jntravel.com/api/leads/unsubscribe')}" style="color:#6b7799">Unsubscribe</a>.</p>`);
  return { subject: `Your cheapest-date watch for ${destination || 'your trip'} is on`, html, text: `You're on the list. We'll watch fares to ${destination || 'your trip'} and email you when to book. Plan now: ${planUrl || 'https://3jntravel.com'}` };
}
// ---- Weekly feature newsletter --------------------------------------------
// Sent to every registered user: a feature round-up that SELLS the platform,
// densely hyperlinked so each line is a one-tap jump into the product. Blog
// highlights and the reader's own referral link are injected dynamically.
export function featureNewsletterEmail({ name, base = 'https://3jntravel.com', referralCode, unsubUrl, posts = [] } = {}) {
  const b = String(base).replace(/\/$/, '');
  const hi = name && !/guest/i.test(name) ? mailEsc(String(name).split(' ')[0]) : 'traveller';
  const link = (path, label) => `<a href="${mailEsc(b + path)}" style="color:#8fb8e6;text-decoration:none;font-weight:600">${mailEsc(label)}</a>`;
  const feature = (emoji, title, path, desc) => `
    <tr><td style="padding:11px 0;border-bottom:1px solid #1c2740">
      <div style="font-size:15px;font-weight:700;color:#eef2fb">${emoji} ${link(path, title)}</div>
      <div style="font-size:13px;color:#9aa6c4;margin-top:2px">${desc}</div>
    </td></tr>`;
  const postLinks = (Array.isArray(posts) ? posts : []).slice(0, 4)
    .map((p) => `<li style="margin:5px 0">${link('/blog/' + p.slug, p.title)}</li>`).join('');
  const refUrl = referralCode ? `${b}/?ref=${encodeURIComponent(referralCode)}` : `${b}/`;
  const inner = `
    <p style="color:#9aa6c4;margin:0 0 12px">This week at 3JN · Hi ${hi} 👋</p>
    <p style="margin:0 0 16px">Everything your 3JN account can already do — tap any feature to jump straight in:</p>
    <table role="presentation" width="100%" style="border-collapse:collapse">
      ${feature('🔎', 'AI cheapest-date search', '/?open=planner', 'Give it a month and it scans every date for the lowest fare.')}
      ${feature('💳', 'Pay monthly, price locked', '/how-it-works', 'Small deposit, spread the rest interest-free — your price frozen from day one.')}
      ${feature('🛡️', 'Price-Lock &amp; savings guarantee', '/why-3jn', 'No fare hikes or currency surcharges before you travel. See how it works.')}
      ${feature('🛂', 'VisaOS — instant visa check', '/visaos', 'Know if you&rsquo;ll be approved before you book, plus real cancellable reservations.')}
      ${feature('🏝️', 'Curated deals &amp; marketplace', '/marketplace', 'Hand-picked, all-in packages you can book and pay monthly.')}
      ${feature('📶', 'Travel eSIM', '/how-it-works', 'Land with mobile data already working — no roaming bills.')}
      ${feature('🌍', 'Destination &amp; route guides', '/destinations', 'Real fares, best months and pay-monthly plans for your city.')}
      ${feature('🎁', 'Membership &amp; rewards', '/membership', 'More AI credit, member fares and perks that pay for the plan.')}
    </table>
    ${postLinks ? `<p style="margin:20px 0 6px;font-weight:700;color:#eef2fb">Fresh from the journal</p><ul style="color:#9aa6c4;padding-left:18px;margin:0">${postLinks}</ul>` : ''}
    <p style="margin:22px 0"><a href="${mailEsc(b + '/?open=planner')}" style="background:#1668e3;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">Plan a trip now →</a></p>
    <p style="background:#0f1830;border:1px solid #1c2740;border-radius:10px;padding:12px 14px;color:#9aa6c4;font-size:13px;margin:0">💛 Love 3JN? <a href="${mailEsc(refUrl)}" style="color:#46d39a;font-weight:700;text-decoration:none">Share your referral link</a> — earn ACU credit and revenue share when a friend books.</p>
    <p style="color:#6b7799;font-size:12px;margin-top:16px">You're receiving this because you have a 3JN account. <a href="${mailEsc(unsubUrl || (b + '/api/newsletter/unsubscribe'))}" style="color:#6b7799">Unsubscribe from the newsletter</a>.</p>`;
  const text = `This week at 3JN, ${name || 'traveller'}.\n\n`
    + `AI cheapest-date search: ${b}/?open=planner\n`
    + `Pay monthly, price locked: ${b}/how-it-works\n`
    + `Price-Lock & savings guarantee: ${b}/why-3jn\n`
    + `VisaOS instant visa check: ${b}/visaos\n`
    + `Curated deals & marketplace: ${b}/marketplace\n`
    + `Destination & route guides: ${b}/destinations\n`
    + `Membership & rewards: ${b}/membership\n\n`
    + `Plan a trip now: ${b}/?open=planner\n`
    + `Share your referral link: ${refUrl}\n\n`
    + `Unsubscribe: ${unsubUrl || (b + '/api/newsletter/unsubscribe')}`;
  return { subject: 'This week at 3JN — pay-monthly flights, instant visa checks & more', html: mailShell(inner), text };
}
// The recurring cheapest-date alert the lifecycle agent sends.
export function cheapestDateAlertEmail({ destination, fromGbp, cheapestDate, marketMinGbp, planUrl, unsubUrl } = {}) {
  const dest = mailEsc(destination || 'your trip');
  const price = marketMinGbp || fromGbp;
  const dateLine = cheapestDate ? `<p>The cheapest dates we're seeing land around <strong>${mailEsc(cheapestDate)}</strong>.</p>` : '';
  const html = mailShell(`
    <p style="color:#9aa6c4;margin:0 0 16px">Fare watch · ${dest}</p>
    <p>Good news — we've found a lower fare window for <strong>${dest}</strong>.</p>
    ${price ? `<p style="color:#46d39a;font-size:20px;font-weight:800">from £${price}pp</p>` : ''}
    ${dateLine}
    <p style="color:#9aa6c4">Book now and spread it over monthly instalments — the AI buys your ticket the moment the fare is covered.</p>
    <p style="margin:18px 0"><a href="${mailEsc(planUrl || 'https://3jntravel.com/?open=planner')}" style="background:#1668e3;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700">See ${dest} deals →</a></p>
    <p style="color:#6b7799;font-size:12px">To stop these alerts, <a href="${mailEsc(unsubUrl || 'https://3jntravel.com/api/leads/unsubscribe')}" style="color:#6b7799">unsubscribe</a>.</p>`);
  return { subject: `Cheaper fares to ${destination || 'your trip'}${price ? ` — from £${price}pp` : ''}`, html, text: `Lower fares to ${destination || 'your trip'}${price ? ` from £${price}pp` : ''}. Book & pay monthly: ${planUrl || 'https://3jntravel.com'}` };
}

// ---- Vendor / Partner programme lifecycle emails ---------------------------
export function vendorApplicationEmail({ name, tierLabel } = {}) {
  const who = name ? mailEsc(String(name).split(' ')[0]) : 'there';
  const html = mailShell(`
    <p style="color:#9aa6c4;margin:0 0 12px">Application received 🤝</p>
    <p>Hi ${who}, thanks for applying to the <strong>3JN Vendor Partner Programme</strong>${tierLabel ? ` (${mailEsc(tierLabel)})` : ''}.</p>
    <p>Your application has passed our automated risk screen and is now with our compliance team for a final decision. <strong>No sell code or commission is active yet</strong> — we never activate a partnership until a human has reviewed it.</p>
    <p style="color:#9aa6c4">We'll email you the moment a decision is made. Once approved, your portal, sell link and weekly payouts unlock automatically in your account.</p>
    <p style="color:#6b7799;font-size:12px">Questions? Reply to this email or contact info@3jntravel.com.</p>`);
  return { subject: "We received your 3JN Vendor Partner application", html, text: `Hi ${name || 'there'}, we received your 3JN Vendor Partner application${tierLabel ? ` (${tierLabel})` : ''}. It passed the automated risk screen and is with our compliance team. No sell code or commission is active until you are approved — we will email you the decision.` };
}
export function vendorApprovedEmail({ name, tierLabel, sellCode, commissionPct, portalUrl } = {}) {
  const who = name ? mailEsc(String(name).split(' ')[0]) : 'there';
  const url = mailEsc(portalUrl || 'https://3jntravel.com/');
  const html = mailShell(`
    <p style="color:#46d39a;margin:0 0 12px">You're approved ✅</p>
    <p>Welcome to the <strong>3JN Vendor Partner Programme</strong>${tierLabel ? ` (${mailEsc(tierLabel)})` : ''}, ${who}!</p>
    ${sellCode ? `<p>Your sell code is <strong style="color:#d8b46a;font-size:18px">${mailEsc(sellCode)}</strong>.</p>` : ''}
    ${commissionPct ? `<p>You earn <strong>${mailEsc(String(commissionPct))}%</strong> on every eligible sale, paid every <strong>Friday</strong> once each trip completes.</p>` : ''}
    <p style="margin:18px 0"><a href="${url}" style="background:#1668e3;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700">Open your partner portal →</a></p>
    <p style="color:#9aa6c4">Your portal, sell link and payout dashboard are now live in your account. Share your link and start earning.</p>`);
  return { subject: "You are approved — your 3JN partner portal is live", html, text: `You are approved for the 3JN Vendor Partner Programme${tierLabel ? ` (${tierLabel})` : ''}!${sellCode ? ` Sell code: ${sellCode}.` : ''}${commissionPct ? ` You earn ${commissionPct}% on every eligible sale, paid weekly.` : ''} Open your portal: ${portalUrl || 'https://3jntravel.com/'}` };
}
export function vendorDeclinedEmail({ name, reason } = {}) {
  const who = name ? mailEsc(String(name).split(' ')[0]) : 'there';
  const html = mailShell(`
    <p style="color:#9aa6c4;margin:0 0 12px">Application update</p>
    <p>Hi ${who}, thank you for your interest in the 3JN Vendor Partner Programme.</p>
    <p>After review, we are unable to approve your application at this time${reason ? `: ${mailEsc(reason)}` : '.'} You are welcome to reapply with updated details.</p>
    <p style="color:#6b7799;font-size:12px">If you believe this is an error, reply to this email or contact info@3jntravel.com.</p>`);
  return { subject: "Your 3JN Vendor Partner application", html, text: `Hi ${name || 'there'}, after review we are unable to approve your 3JN Vendor Partner application at this time${reason ? `: ${reason}` : '.'} You are welcome to reapply.` };
}
export function vendorSuspendedEmail({ name, reason } = {}) {
  const who = name ? mailEsc(String(name).split(' ')[0]) : 'there';
  const html = mailShell(`
    <p style="color:#e0824c;margin:0 0 12px">Account suspended ⛔</p>
    <p>Hi ${who}, your 3JN Vendor Partner account has been <strong>suspended</strong>${reason ? `: ${mailEsc(reason)}` : ' pending review'}.</p>
    <p style="color:#9aa6c4">Your sell link and new commission are paused while this is reviewed. Any commission already earned on completed trips is unaffected.</p>
    <p style="color:#6b7799;font-size:12px">Questions or think this is a mistake? Reply to this email or contact info@3jntravel.com.</p>`);
  return { subject: "Your 3JN Vendor Partner account has been suspended", html, text: `Hi ${name || 'there'}, your 3JN Vendor Partner account has been suspended${reason ? `: ${reason}` : ' pending review'}. Your sell link and new commission are paused. Contact info@3jntravel.com with any questions.` };
}
export function vendorReinstatedEmail({ name, portalUrl } = {}) {
  const who = name ? mailEsc(String(name).split(' ')[0]) : 'there';
  const url = mailEsc(portalUrl || 'https://3jntravel.com/');
  const html = mailShell(`
    <p style="color:#46d39a;margin:0 0 12px">You're back 🎉</p>
    <p>Good news ${who} — your 3JN Vendor Partner account has been <strong>reinstated</strong>. Your sell link and weekly payouts are active again.</p>
    <p style="margin:18px 0"><a href="${url}" style="background:#1668e3;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700">Open your partner portal →</a></p>`);
  return { subject: "Your 3JN Vendor Partner account is reinstated", html, text: `Good news ${name || 'there'} — your 3JN Vendor Partner account has been reinstated. Your sell link and weekly payouts are active again. Portal: ${portalUrl || 'https://3jntravel.com/'}` };
}
