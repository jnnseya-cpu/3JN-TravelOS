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

## 1. Backend — Firebase Functions (recommended)

The Express app is wrapped as a single 2nd-gen HTTPS function named **`api`**
(`index.js` → `onRequest(app)`). `app.listen` is skipped automatically under
Functions; CORS + `/api/health` are built in.

```bash
npm install                     # installs express + firebase-functions
npm install -g firebase-tools   # one-time, the CLI
firebase login
# set your project id in .firebaserc (replace "3jn-travel-os"), then:
firebase use --add              # pick/confirm the project

# (optional) secrets — never commit these:
firebase functions:secrets:set RAYNA_AGENT_PASSWORD
firebase functions:secrets:set ANTHROPIC_API_KEY   # OPENAI/GEMINI as needed
# (then add them to index.js `secrets: [...]` and redeploy)

firebase deploy --only functions          # backend only
# or deploy backend + Firebase Hosting (serves the frontend too):
firebase deploy --only functions,hosting
```

The function URL is printed, e.g.
`https://api-<hash>-ew.a.run.app` (2nd-gen functions run on Cloud Run) and is
also reachable at `https://<region>-<project>.cloudfunctions.net/api`.

> **Alternatives** (same code, both work): **Cloud Run** —
> `gcloud run deploy 3jn-travel-os-api --source . --region europe-west1 --allow-unauthenticated`;
> **Render** — *New → Blueprint* on the repo (`render.yaml`). The `Dockerfile`
> works on any container host and also serves the frontend from Express.

---

## 2. Frontend — Vercel

1. Import the repo at vercel.com → it auto-detects `vercel.json`
   (`outputDirectory: frontend`, **no build step**).
2. Point the API at your backend. Two options:
   - **Recommended (no CORS):** keep `vercel.json`'s rewrites and map
     `api.3jntravel.com` to your backend (step 3). The frontend calls relative
     `/api/...`, Vercel proxies to `https://api.3jntravel.com/api/...`.
   - **Or direct:** set `window.API_BASE` in `frontend/config.js` to the
     function URL (e.g. `https://api-<hash>-ew.a.run.app`). CORS is already
     enabled server-side (`CORS_ORIGIN`, default `*` — lock it to your domain).
3. Deploy → `https://3jn-travel-os.vercel.app`.

> All static assets (`index.html`, `app.js`, `styles.css`, `config.js`) are
> self-contained in `frontend/` — Vercel needs no backend to serve the UI.

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

## 5. Data persistence (Firebase Realtime Database)

Persistence is **built in and credential-gated** (`backend/src/persistence.js`):

- On **Firebase Functions / Cloud Run**, Application Default Credentials are
  present automatically, so the store **loads from RTDB on boot** and **flushes
  on every mutation (debounced) + every 15 s**. State survives restarts.
- **Locally**, set `GOOGLE_APPLICATION_CREDENTIALS` to a service-account JSON to
  enable it; otherwise it stays in-memory (the offline prototype/tests are
  unaffected). `GET /api/health` reports `"persistence": true|false`.
- DB URL defaults to the project's RTDB; override with `FIREBASE_DATABASE_URL`.

**Enable RTDB once** in the Firebase console (Build → Realtime Database → Create)
and set rules. The whole store is written under `/3jnos`. For heavy scale, move
hot records to **per-document Firestore + Cloud SQL** (docs/AI-OS-ARCHITECTURE.md
§9–10) — `snapshot()`/`hydrate()` keep that swap localised.
