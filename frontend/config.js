// Frontend runtime config.
//
// Leave API_BASE empty ('') when the frontend and API share an origin — i.e.
// when Vercel/Firebase Hosting rewrites /api/* to the backend (recommended).
//
// Set it to your backend URL ONLY if you deploy the frontend and backend on
// different origins without a rewrite proxy, e.g.:
//   window.API_BASE = 'https://europe-west1-3jn-travel-os.cloudfunctions.net/api';
//   window.API_BASE = 'https://api.3jntravel.com';
window.API_BASE = '';
