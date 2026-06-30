# Deploying 3JN Travel OS

The app is two pieces:

- **frontend/** — static files (HTML/CSS/JS). Best on a CDN/static host (Vercel).
- **backend/** — Node/Express API + the engine. Needs a long-running Node host
  (Cloud Run, Render, Fly.io, Railway). **Firebase *Functions* is not ideal for a
  long-lived Express app — use Cloud Run** (Firebase Hosting can rewrite to it).

> The repo is configured for the **recommended split: Vercel (frontend) +
> Cloud Run/Render (backend) + Hostinger domain**. You can also run everything on
> one host — `Dockerfile` serves the frontend from Express too.

Config files included: `vercel.json`, `Dockerfile`, `render.yaml`, `firebase.json`,
`.dockerignore`, `.env.example`.

---

## 1. Backend — pick ONE host

### Option A (recommended): Google Cloud Run
```bash
gcloud run deploy 3jn-travel-os-api \
  --source . --region europe-west1 --allow-unauthenticated \
  --set-env-vars NODE_ENV=production
# set secrets (never commit them):
gcloud run services update 3jn-travel-os-api --region europe-west1 \
  --update-secrets RAYNA_AGENT_PASSWORD=rayna-pw:latest,ANTHROPIC_API_KEY=claude:latest
```
Note the service URL it prints, e.g. `https://3jn-travel-os-api-xxxx.run.app`.

### Option B: Render (simplest)
Push to GitHub, then in Render → **New → Blueprint** and point it at the repo.
`render.yaml` provisions the service. Add secrets in the dashboard. You get
`https://3jn-travel-os-api.onrender.com`.

### Option C: Firebase Hosting + Cloud Run
Deploy the backend to Cloud Run (Option A), then `firebase deploy --only hosting`
— `firebase.json` rewrites `/api/**` and `/shared/**` to the Cloud Run service.

---

## 2. Frontend — Vercel
1. Import the repo at vercel.com → it detects `vercel.json`
   (`outputDirectory: frontend`, no build step).
2. Edit `vercel.json` → replace `https://api.3jntravel.com` in the two `/api` and
   `/shared` rewrites with your **real backend URL** from step 1 (or keep
   `api.3jntravel.com` and point that subdomain at the backend in step 3).
3. Deploy. You get `https://3jn-travel-os.vercel.app`.

> The frontend calls the API with **relative paths** (`/api/...`), so the Vercel
> rewrites transparently proxy them to the backend — no CORS, no code change.

---

## 3. Domain — Hostinger DNS

In **Hostinger → Domains → DNS / Nameservers** for `3jntravel.com`:

| Type | Name | Value | Purpose |
|---|---|---|---|
| A / CNAME | `@` (root) | Vercel target (`76.76.21.21` or `cname.vercel-dns.com`) | Frontend |
| CNAME | `www` | `cname.vercel-dns.com` | Frontend |
| CNAME | `api` | your backend host (e.g. `…run.app` / `…onrender.com`) | Backend |

Then:
- In **Vercel → Project → Domains**, add `3jntravel.com` + `www.3jntravel.com`
  (Vercel verifies the DNS above and issues SSL automatically).
- In your **backend host**, add the custom domain `api.3jntravel.com`
  (Cloud Run: *Manage Custom Domains*; Render: *Custom Domains*).

DNS can take up to a few hours to propagate. SSL is automatic on all three.

---

## 4. Environment secrets

Copy `.env.example` → `.env` locally, or set the same keys in each host's
dashboard. **Never commit `.env`** (it is git-ignored). Secrets:
`RAYNA_AGENT_PASSWORD`, `RAYNA_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`. The app runs fully **without** any of these (offline fallback);
add them to enable live Rayna booking and live AI providers.

---

## 5. Note on data persistence

The prototype stores bookings/users in memory (`backend/src/store.js`) — fine for
a demo, but it resets on restart and won't share state across instances. For
production, swap `store.js` for PostgreSQL/Firestore (the blueprint's target) and
run a single instance or add a shared DB before scaling horizontally.
