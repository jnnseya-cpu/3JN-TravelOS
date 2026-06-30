# Deploying 3JN Travel OS

## Recommended long-term architecture (enterprise / VisaOS-grade)

Because 3JN Travel OS + **VisaOS** handle sensitive documents (passports, bank
statements), visa decisions, payments, audit logs and AI decisions, the
recommended production stack prioritises security, document storage, compliance
and auditability:

```
Claude build → GitHub
  → Vercel                      (frontend, static)
  → Firebase Auth               (identity, MFA, social login)
  → Cloud Run / Cloud Functions (backend logic — this Express app, containerised)
  → Firestore                   (app activity + realtime journey/visa status)
  → Google Cloud Storage        (visa documents, e-tickets — large objects, lifecycle rules)
  → Cloud SQL PostgreSQL        (payments, audit, visa decisions, ACU ledger, financial records)
  → Stripe / BitriPay           (payments)
  → AI gateway                  (Claude / OpenAI / Gemini, controlled)
```

| Concern | Service | Why |
|---|---|---|
| Domain | **Hostinger** | DNS for `3jntravel.com` / `api.3jntravel.com` |
| Frontend | **Vercel** | CDN, instant deploys, no build step |
| Auth | **Firebase Auth** | MFA, social login, fast UX |
| Backend | **Cloud Run** | long-running Express, autoscale, custom domain |
| App data / realtime | **Firestore** | journey + visa status, low-latency reads |
| Documents | **Google Cloud Storage** | large sensitive files, per-GB pricing, lifecycle, ACLs — **not** in the DB |
| Financial / visa / audit | **Cloud SQL PostgreSQL** | structured, transactional, auditable records |
| Payments | **Stripe + BitriPay** | cards + African rail (CDF/mobile money) |
| AI | **AI Gateway** (`backend/src/ai-gateway.js`) | provider-agnostic routing |

> **Why not Vercel + Neon as the main backend?** Neon is great serverless
> Postgres, but the hard problems here are heavy/sensitive document storage,
> identity verification, audit logs and government-grade access control — which
> belong in **GCS + Firestore + Cloud SQL inside Google Cloud**, not a single
> Postgres layer. Keep documents in object storage, never in the database.

The config files below already target **Vercel (frontend) + Cloud Run/Firebase
(backend) + Hostinger DNS**; add Firestore/GCS/Cloud SQL when you move off the
in-memory store.

---

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
