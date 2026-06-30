// Firebase Cloud Functions (2nd gen) entry point.
//
// Wraps the Express app as a single HTTPS function named `api`. Firebase reads
// this file via package.json "main". Deploy with `firebase deploy --only
// functions` (and `--only hosting` if you also serve the frontend from Firebase
// Hosting). Local dev still uses `npm start` (backend/src/server.js).
//
// The app's own `app.listen` is skipped automatically when FUNCTION_TARGET is
// set (see backend/src/server.js), so the wrapper owns the lifecycle here.

import { onRequest } from 'firebase-functions/v2/https';
import { app } from './backend/src/server.js';

export const api = onRequest(
  {
    region: process.env.FUNCTIONS_REGION || 'europe-west1',
    memory: '512MiB',
    timeoutSeconds: 60,
    // Secrets are injected via Firebase config / Secret Manager — never committed.
    // e.g. secrets: ['RAYNA_AGENT_PASSWORD', 'ANTHROPIC_API_KEY', 'STRIPE_KEY'],
  },
  app,
);
