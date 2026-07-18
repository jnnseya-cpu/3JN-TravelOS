// Stripe Checkout integration — live card payments for deposits & balances.
//
// Design constraints:
//   - No SDK dependency: Stripe's REST API is called with fetch + form
//     encoding, so nothing new to install and serverless cold-starts stay fast.
//   - Credential-gated like every other integration: without STRIPE_SECRET_KEY
//     the OS keeps its simulated payment flow — nothing breaks offline.
//   - Webhooks are verified with the official scheme (HMAC-SHA256 over
//     `${timestamp}.${rawBody}` against STRIPE_WEBHOOK_SECRET) so a forged
//     "payment succeeded" can never mark a booking paid.

import { createHmac, timingSafeEqual } from 'node:crypto';

const env = (typeof process !== 'undefined' && process.env) ? process.env : {};
const API = 'https://api.stripe.com/v1';

export function stripeEnabled() {
  return Boolean(env.STRIPE_SECRET_KEY);
}

function form(data, prefix = '') {
  // Stripe expects application/x-www-form-urlencoded with bracket nesting.
  const parts = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) parts.push(form(v, key));
    else if (Array.isArray(v)) v.forEach((item, i) => parts.push(typeof item === 'object' ? form(item, `${key}[${i}]`) : `${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return parts.filter(Boolean).join('&');
}

async function stripePost(path, data) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form(data),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message || `stripe ${res.status}`);
  return json;
}

// Create a hosted Checkout session for a booking payment (deposit or balance).
// amountMinor is in the currency's minor unit (pence/cents). Returns the
// hosted payment page URL — the frontend simply redirects to it.
export async function createCheckoutSession({ amountMinor, currency = 'gbp', description, bookingId, userId, successUrl, cancelUrl, customerEmail, metadata = {} }) {
  if (!stripeEnabled()) return { ok: false, error: 'stripe-not-configured' };
  if (!(amountMinor > 0)) return { ok: false, error: 'invalid-amount' };
  // Base metadata (bookingId/userId) plus any caller-supplied keys (e.g. an ACU
  // or membership purchase carries kind/pack/tier so the webhook fulfils it).
  const meta = { bookingId: bookingId || '', userId: userId || '', ...metadata };
  const session = await stripePost('/checkout/sessions', {
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer_email: customerEmail || undefined,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: currency.toLowerCase(),
        unit_amount: Math.round(amountMinor),
        product_data: { name: description || '3JN Travel OS booking payment' },
      },
    }],
    metadata: meta,
    // Create a Customer and SAVE the card for later off-session use, so a booking
    // CHANGE (fee + airline fare difference) can be auto-charged to the same card
    // without another checkout. Harmless for one-off payers; required for changes.
    customer_creation: 'always',
    payment_intent_data: { metadata: meta, setup_future_usage: 'off_session' },
  });
  return { ok: true, sessionId: session.id, url: session.url };
}

// Auto-charge the customer's SAVED card OFF-SESSION (no redirect / no customer
// present) — used to collect a booking-change fee + airline fare difference at
// re-issue. Reuses the Customer + payment method from the ORIGINAL booking payment
// (saved via setup_future_usage at checkout). Returns { ok, paymentIntentId } on
// success; on failure { ok:false, reason, requiresAction } so the caller can fall
// back to a payment link and NEVER records a charge that didn't happen.
export async function chargeSavedCard({ originalPaymentIntentId, amountMinor, currency = 'gbp', description, metadata = {} }) {
  if (!stripeEnabled()) return { ok: false, error: 'stripe-not-configured', reason: 'Card payments are not configured.' };
  if (!originalPaymentIntentId) return { ok: false, error: 'no-original-intent', reason: 'No card on file for this booking.' };
  if (!(amountMinor > 0)) return { ok: false, error: 'invalid-amount' };
  try {
    const orig = await stripeGet(`/payment_intents/${encodeURIComponent(originalPaymentIntentId)}`);
    const customer = typeof orig.customer === 'string' ? orig.customer : orig.customer?.id;
    const paymentMethod = typeof orig.payment_method === 'string' ? orig.payment_method : orig.payment_method?.id;
    if (!customer || !paymentMethod) return { ok: false, error: 'no-saved-card', reason: 'The original payment did not save a reusable card.' };
    const pi = await stripePost('/payment_intents', {
      amount: Math.round(amountMinor),
      currency: currency.toLowerCase(),
      customer,
      payment_method: paymentMethod,
      off_session: true,
      confirm: true,
      description: description || '3JN booking change',
      metadata,
    });
    if (pi.status === 'succeeded') return { ok: true, paymentIntentId: pi.id, amount: pi.amount };
    // requires_action → the bank wants 3DS; we can't do that off-session, so fall back.
    return { ok: false, status: pi.status, requiresAction: pi.status === 'requires_action', paymentIntentId: pi.id, reason: `Card needs confirmation (${pi.status}).` };
  } catch (e) {
    const msg = e?.message || 'charge-failed';
    // Stripe throws on a declined off-session charge (card_declined,
    // authentication_required, …). Surface it so we can send a payment link.
    return { ok: false, error: msg, requiresAction: /authentication/i.test(msg), reason: msg };
  }
}

async function stripeGet(path) {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message || `stripe ${res.status}`);
  return json;
}

// Retrieve a Checkout Session to confirm payment WITHOUT relying on the webhook.
// On return from Checkout the app calls this to reconcile the booking — so a
// missing/delayed/misconfigured webhook can never leave a paid booking stuck at
// "awaiting payment". Returns paid status + the authoritative amount/intent.
export async function retrieveCheckoutSession(sessionId) {
  if (!stripeEnabled()) return { ok: false, error: 'stripe-not-configured' };
  if (!sessionId) return { ok: false, error: 'no-session' };
  try {
    const s = await stripeGet(`/checkout/sessions/${encodeURIComponent(sessionId)}`);
    return { ok: true, paid: s.payment_status === 'paid', amountTotal: s.amount_total, currency: s.currency, paymentIntent: typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent?.id || null), metadata: s.metadata || {} };
  } catch (e) {
    return { ok: false, error: e?.message || 'retrieve-failed' };
  }
}

// Refund a captured payment by its PaymentIntent id (full, or a partial amount).
// Used when fulfilment fails AFTER money was taken (a flight ticket couldn't be
// issued) so the customer is actually made whole — not just told they are.
export async function createRefund({ paymentIntentId, amountMinor = null, reason = 'requested_by_customer' } = {}) {
  if (!stripeEnabled()) return { ok: false, error: 'stripe-not-configured' };
  if (!paymentIntentId) return { ok: false, error: 'no-payment-intent' };
  try {
    const data = { payment_intent: paymentIntentId, reason };
    if (amountMinor != null && amountMinor > 0) data.amount = Math.round(amountMinor);
    const r = await stripePost('/refunds', data);
    return { ok: true, refundId: r.id, status: r.status, amount: r.amount };
  } catch (e) {
    return { ok: false, error: e?.message || 'refund-failed' };
  }
}

// Live reachability + key probe for the admin readiness check. Does a light
// authenticated GET (/balance) so it proves BOTH that the network can reach
// Stripe AND that the secret key is valid — without creating anything.
export async function stripeDiagnostic() {
  const key = env.STRIPE_SECRET_KEY || '';
  const mode = key.startsWith('sk_live') ? 'live' : key.startsWith('sk_test') ? 'test' : 'none';
  if (!key) return { ok: false, mode, reason: 'not-configured', message: 'No STRIPE_SECRET_KEY set — card checkout is simulated, not real.' };
  if (typeof fetch !== 'function') return { ok: false, mode, reason: 'no-fetch', message: 'This runtime has no fetch() — cannot reach Stripe.' };
  const webhookSet = Boolean(env.STRIPE_WEBHOOK_SECRET);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  const startedAt = Date.now();
  try {
    const r = await fetch(`${API}/balance`, { headers: { authorization: `Bearer ${key}` }, signal: ctrl.signal });
    const latencyMs = Date.now() - startedAt;
    if (r.status === 401) return { ok: false, mode, webhookSet, reason: 'auth-rejected', status: 401, latencyMs, message: 'Stripe rejected the key (HTTP 401) — it may be wrong, rolled, or revoked.' };
    if (!r.ok) { let p = null; try { p = await r.json(); } catch {} return { ok: false, mode, webhookSet, reason: 'provider-error', status: r.status, latencyMs, message: `Stripe returned an error: ${p?.error?.message || `HTTP ${r.status}`}` }; }
    return { ok: true, mode, webhookSet, reason: 'ok', status: r.status, latencyMs, message: `Stripe (${mode}) is reachable and the key works${webhookSet ? '' : ' — but STRIPE_WEBHOOK_SECRET is NOT set, so payments would capture but never fulfil'}.` };
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    return { ok: false, mode, webhookSet, reason: aborted ? 'timeout' : 'unreachable', message: aborted ? 'Stripe did not respond within 8s — this host may be unable to reach api.stripe.com (network egress).' : `Could not reach api.stripe.com (${e?.message || 'network error'}). Check outbound network access.` };
  } finally {
    clearTimeout(t);
  }
}

// Verify a Stripe webhook signature (Stripe-Signature: t=...,v1=...).
// rawBody must be the EXACT bytes Stripe sent — not re-serialised JSON.
export function verifyStripeSignature(rawBody, signatureHeader, secret = env.STRIPE_WEBHOOK_SECRET, toleranceSec = 300, now = Date.now()) {
  if (!secret || !signatureHeader || !rawBody) return { ok: false, error: 'missing-signature-inputs' };
  const parts = Object.fromEntries(
    String(signatureHeader).split(',').map((p) => p.split('=').map((x) => x.trim())).filter((p) => p.length === 2),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!t || !v1) return { ok: false, error: 'malformed-signature' };
  if (Math.abs(now / 1000 - t) > toleranceSec) return { ok: false, error: 'timestamp-out-of-tolerance' };
  const payload = `${t}.${typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')}`;
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: 'signature-mismatch' };
  return { ok: true };
}

// Test helper: produce a valid signature header for a payload (used by the
// test suite; harmless in production since it needs the secret anyway).
export function signStripePayload(rawBody, secret, now = Date.now()) {
  const t = Math.floor(now / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${v1}`;
}
