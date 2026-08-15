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
//
// EXCEPTION — SEO/marketing routes that Express serves at their REAL path (no
// `/api` prefix): /sitemap.xml, /robots.txt, the RSS feeds, the destination and
// route landing pages, the trust page, and the Google Search Console HTML-file
// verification. These are routed to this function by vercel.json but must reach
// Express unprefixed, or the sitemap and every organic landing page would 404 in
// production. Keep this list in sync with the matching rewrites in vercel.json.

import { app } from '../backend/src/server.js';

// Paths Express owns at their non-`/api` path — passed through untouched.
function isSeoPassthrough(pathOnly) {
  return (
    pathOnly === '/sitemap.xml' ||
    pathOnly === '/robots.txt' ||
    pathOnly === '/blog.xml' || pathOnly === '/rss.xml' || pathOnly === '/feed.xml' ||
    pathOnly === '/why-3jn' ||
    pathOnly === '/destinations' || pathOnly.startsWith('/destinations/') ||
    pathOnly === '/flights' || pathOnly.startsWith('/flights/') ||
    /^\/google[0-9a-f]+\.html$/i.test(pathOnly)
  );
}

export default function handler(req, res) {
  try {
    if (req.url) {
      const pathOnly = req.url.split('?')[0];
      if (!pathOnly.startsWith('/api') && !pathOnly.startsWith('/shared') && !isSeoPassthrough(pathOnly)) {
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
