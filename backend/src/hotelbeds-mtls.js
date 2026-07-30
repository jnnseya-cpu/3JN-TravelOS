// Hotelbeds mutual-TLS transport.
//
// The Hotelbeds LIVE (production) environment requires MUTUAL TLS: every request
// must present a client certificate issued by Hotelbeds (from your CSR). The
// TEST environment does not — it authenticates with the Api-key + X-Signature
// alone. So this module is a drop-in request helper that behaves EXACTLY like the
// plain httpJSON helpers, except: when a client certificate is configured, it
// routes the call through node:https presenting that cert (mTLS). With no cert
// set (the test phase), it transparently falls back to global fetch — nothing
// changes until you go live.
//
// The cert/key/passphrase come from env (Vercel secrets), never from code:
//   HOTELBEDS_CLIENT_CERT           the issued certificate (PEM or base64)
//   HOTELBEDS_CLIENT_KEY            the private key           (PEM or base64)
//   HOTELBEDS_CLIENT_KEY_PASSPHRASE the private-key password
// PEM values may be pasted raw, with literal \n escapes, or base64-encoded — all
// three are accepted (base64 is easiest to store in a single-line env var).

import https from 'node:https';
import zlib from 'node:zlib';
import { Buffer } from 'node:buffer';

const env = process.env;

// Accept a PEM as raw text, \n-escaped text, or base64-encoded, and normalise to
// real PEM. Returns null when it can't be turned into something containing a PEM
// header — so a missing/garbled value simply disables mTLS rather than crashing.
function decodePem(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (s.includes('-----BEGIN')) return s.replace(/\\n/g, '\n');
  try {
    const d = Buffer.from(s, 'base64').toString('utf8');
    return d.includes('-----BEGIN') ? d : null;
  } catch { return null; }
}

let _agent;
let _agentBuilt = false;
export function hotelbedsMtlsConfigured() {
  return !!(decodePem(env.HOTELBEDS_CLIENT_CERT) && decodePem(env.HOTELBEDS_CLIENT_KEY));
}
function hbAgent() {
  if (_agentBuilt) return _agent;
  _agentBuilt = true;
  const cert = decodePem(env.HOTELBEDS_CLIENT_CERT);
  const key = decodePem(env.HOTELBEDS_CLIENT_KEY);
  if (!cert || !key) { _agent = null; return null; }
  try {
    _agent = new https.Agent({ cert, key, passphrase: env.HOTELBEDS_CLIENT_KEY_PASSPHRASE || undefined, keepAlive: true });
  } catch { _agent = null; }
  return _agent;
}

// Drop-in for httpJSON. Same return contract: parsed JSON body on 2xx,
// { __error, __status } on an HTTP error, or null on any transport/parse failure.
// Uses mTLS (node:https + client cert) when configured, else global fetch.
export async function hbRequest(url, opts = {}) {
  const agent = hbAgent();
  if (!agent) {
    // Test phase — no client cert. Behave exactly like the existing httpJSON.
    if (typeof fetch !== 'function') return null;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || 8000);
    try {
      const r = await fetch(url, { ...opts, signal: ctrl.signal });
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('json')) return null;
      const body = await r.json();
      return r.ok ? body : { __error: body, __status: r.status };
    } catch { return null; } finally { clearTimeout(t); }
  }
  // LIVE phase — present the client certificate via node:https.
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const u = new URL(url);
      const req = https.request({
        method: opts.method || 'GET',
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: opts.headers || {},
        agent,
        timeout: opts.timeoutMs || 8000,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let buf = Buffer.concat(chunks);
          const enc = String(res.headers['content-encoding'] || '').toLowerCase();
          try {
            if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
            else if (enc.includes('br')) buf = zlib.brotliDecompressSync(buf);
            else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
          } catch { return done(null); }
          const ct = String(res.headers['content-type'] || '').toLowerCase();
          if (!ct.includes('json')) return done(null);
          let body; try { body = JSON.parse(buf.toString('utf8')); } catch { return done(null); }
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          done(ok ? body : { __error: body, __status: res.statusCode });
        });
      });
      req.on('timeout', () => { req.destroy(); done(null); });
      req.on('error', () => done(null));
      if (opts.body) req.write(opts.body);
      req.end();
    } catch { done(null); }
  });
}
