// Vercel Serverless Function entry.
//
// Exposes the full Express API on the SAME Vercel deployment as the frontend,
// so `/api/*` works with no separate backend host. Vercel routes `/api/*` here
// via vercel.json; the static frontend is served by Vercel's CDN from frontend/.
//
// IMPORTANT: depending on the rewrite, Vercel may hand the function a URL with
// the `/api` prefix stripped (e.g. `/plan` instead of `/api/plan`). We normalise
// it back so the Express routes (defined as `/api/...`) always match — and we
// guarantee a JSON response even if anything throws.

import { app } from '../backend/src/server.js';

export default function handler(req, res) {
  try {
    if (req.url) {
      const pathOnly = req.url.split('?')[0];
      if (!pathOnly.startsWith('/api') && !pathOnly.startsWith('/shared')) {
        req.url = '/api' + (req.url.startsWith('/') ? req.url : '/' + req.url);
      }
    }
    return app(req, res);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'function-error', message: String(err && err.message || err) }));
  }
}
