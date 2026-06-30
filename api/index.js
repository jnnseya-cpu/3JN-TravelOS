// Vercel Serverless Function entry.
//
// Exposes the full Express API on the SAME Vercel deployment as the frontend,
// so `/api/*` works with no separate backend host (fixes the "non-JSON / An
// error occurred" routing error). The app's own `app.listen` is skipped on
// Vercel (VERCEL env var), so the platform owns the lifecycle here.
//
// vercel.json rewrites `/api/*` to this function; the frontend static files are
// still served by Vercel's CDN from `frontend/`.

import { app } from '../backend/src/server.js';

export default app;
