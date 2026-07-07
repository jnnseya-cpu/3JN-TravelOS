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
export async function createCheckoutSession({ amountMinor, currency = 'gbp', description, bookingId, userId, successUrl, cancelUrl, customerEmail }) {
  if (!stripeEnabled()) return { ok: false, error: 'stripe-not-configured' };
  if (!(amountMinor > 0)) return { ok: false, error: 'invalid-amount' };
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
    metadata: { bookingId: bookingId || '', userId: userId || '' },
    payment_intent_data: { metadata: { bookingId: bookingId || '', userId: userId || '' } },
  });
  return { ok: true, sessionId: session.id, url: session.url };
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
