// 3JN Travel OS — real outbound dispatch for SMS / WhatsApp / Web-Push.
//
// Each adapter is FAIL-CLOSED: with no provider keys it returns
// {ok:false, skipped:true} and performs no network call, so comms.emit() never
// marks a message 'sent' that it couldn't actually dispatch. The transports here
// are the standard, stable provider APIs:
//   SMS       → Twilio REST
//   WhatsApp  → Meta WhatsApp Cloud API (Graph)
//   Push      → OneSignal REST (targets the 3JN userId as an external user id)
//
// cert: template names / sender IDs are confirmed with each provider account;
// the request shapes below are the documented ones and don't change per account.

const env = (typeof process !== 'undefined' && process.env) ? process.env : {};
const DISPATCH_TIMEOUT_MS = Number(env.COMMS_DISPATCH_TIMEOUT_MS) || 8000;

async function postHttp(url, opts, timeoutMs = DISPATCH_TIMEOUT_MS) {
  if (typeof fetch !== 'function') return { ok: false, error: 'no-fetch' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const body = await r.text().catch(() => '');
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, error: e?.message || 'network' };
  } finally {
    clearTimeout(t);
  }
}

function b64(s) {
  if (typeof Buffer !== 'undefined') return Buffer.from(s).toString('base64');
  // eslint-disable-next-line no-undef
  if (typeof btoa === 'function') return btoa(s);
  return s;
}

// ---- SMS via Twilio ---------------------------------------------------------
// SMS_PROVIDER_KEY = "<AccountSID>:<AuthToken>"  (or set TWILIO_ACCOUNT_SID +
// TWILIO_AUTH_TOKEN separately). SMS_FROM (or TWILIO_FROM) = your sender number.
function twilioCreds() {
  const key = env.SMS_PROVIDER_KEY || '';
  const sid = env.TWILIO_ACCOUNT_SID || key.split(':')[0] || '';
  const tok = env.TWILIO_AUTH_TOKEN || key.split(':')[1] || '';
  const from = env.SMS_FROM || env.TWILIO_FROM || '';
  return { sid, tok, from };
}
export function smsConfigured() {
  const { sid, tok, from } = twilioCreds();
  return !!(sid && tok && from) && typeof fetch === 'function';
}
export async function sendSMS(to, body) {
  if (!smsConfigured() || !to) return { ok: false, skipped: true };
  const { sid, tok, from } = twilioCreds();
  const form = new URLSearchParams({ To: String(to), From: from, Body: String(body).slice(0, 1500) });
  const r = await postHttp(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${b64(`${sid}:${tok}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  return r.ok ? { ok: true } : { ok: false, status: r.status, error: r.body || r.error };
}

// ---- WhatsApp via Meta Cloud API -------------------------------------------
// WHATSAPP_PROVIDER_KEY = permanent access token. WHATSAPP_PHONE_ID = the
// WhatsApp Business phone-number ID. Business-INITIATED messages outside the 24h
// customer service window require an APPROVED TEMPLATE — set WHATSAPP_TEMPLATE
// (+ WHATSAPP_TEMPLATE_LANG); inside the window a plain text body is delivered.
export function whatsappConfigured() {
  return !!(env.WHATSAPP_PROVIDER_KEY && env.WHATSAPP_PHONE_ID) && typeof fetch === 'function';
}
export async function sendWhatsApp(to, body) {
  if (!whatsappConfigured() || !to) return { ok: false, skipped: true };
  const base = env.WHATSAPP_BASE_URL || 'https://graph.facebook.com/v21.0';
  const num = String(to).replace(/[^\d+]/g, '');
  const payload = env.WHATSAPP_TEMPLATE
    ? {
      messaging_product: 'whatsapp', to: num, type: 'template',
      template: {
        name: env.WHATSAPP_TEMPLATE, language: { code: env.WHATSAPP_TEMPLATE_LANG || 'en' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: String(body).slice(0, 900) }] }],
      },
    }
    : { messaging_product: 'whatsapp', to: num, type: 'text', text: { body: String(body).slice(0, 4000) } };
  const r = await postHttp(`${base}/${encodeURIComponent(env.WHATSAPP_PHONE_ID)}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WHATSAPP_PROVIDER_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.ok ? { ok: true } : { ok: false, status: r.status, error: r.body || r.error };
}

// ---- Push via OneSignal -----------------------------------------------------
// PUSH_PROVIDER_KEY = OneSignal REST API key. PUSH_APP_ID = OneSignal app id.
// The client SDK must set the 3JN userId as the OneSignal external user id so
// this can target the right person (no device tokens are stored server-side).
export function pushConfigured() {
  return !!(env.PUSH_PROVIDER_KEY && env.PUSH_APP_ID) && typeof fetch === 'function';
}
export async function sendPush(userId, title, body) {
  if (!pushConfigured() || !userId) return { ok: false, skipped: true };
  const r = await postHttp('https://onesignal.com/api/v1/notifications', {
    method: 'POST',
    headers: { Authorization: `Basic ${env.PUSH_PROVIDER_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: env.PUSH_APP_ID,
      include_external_user_ids: [String(userId)],
      headings: { en: String(title || '3JN Travel OS').slice(0, 120) },
      contents: { en: String(body || '').slice(0, 2000) },
    }),
  });
  return r.ok ? { ok: true } : { ok: false, status: r.status, error: r.body || r.error };
}

// Diagnostic snapshot for the admin comms dashboard.
export function dispatchStatus() {
  return {
    sms: { provider: 'Twilio', configured: smsConfigured() },
    whatsapp: { provider: 'Meta WhatsApp Cloud API', configured: whatsappConfigured() },
    push: { provider: 'OneSignal', configured: pushConfigured() },
  };
}
