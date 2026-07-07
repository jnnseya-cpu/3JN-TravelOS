# 3JN Travel OS — Go-Live Stack (locked strategy)

## Recommended stack

**Claude Build → GitHub → Vercel frontend → Firebase backend first. Hostinger domain. Use Neon/Postgres later** for heavy relational data, reporting, finance, the booking ledger, corporate travel and VisaOS decision records.

```
Claude Build
   ↓
GitHub  (repo: jnnseya-cpu/3jn-travelos · deploy branch: main)
   ↓
Vercel Frontend  (static frontend + serverless Express via api/index.js)
   ↓
Firebase Auth · Firestore/RTDB · Storage · Cloud Functions
Stripe (payments)
AI APIs (Claude / OpenAI / Gemini via the AI Gateway)
Hostinger Domain
```

## Why Firebase first

Firebase gives the fast-MVP backend in one place: authentication, database, storage, cloud functions, analytics and easy scaling — with real-time sync and offline support built for web/mobile apps, and Cloud Functions running backend code without managing servers. The first version needs many app features quickly:

login · user profiles · ACU wallet · bookings · documents · uploads · notifications · admin dashboard · AI usage logs · payment events · real-time application status

Firebase is faster for all of this. **Current wiring:** `backend/src/persistence.js` already snapshots/hydrates the entire store to Firebase RTDB when credentials are present (credential-gated, no-op offline).

## Why not Vercel + Neon only at launch

Neon's serverless Postgres (autoscaling, monitoring, connection pooling) is excellent for structured business data — but it doesn't give you auth, storage, notifications or realtime out of the box, and a fast travel-OS launch needs those immediately.

## Clear recommendation (locked)

**Phase 1 — MVP / Go Live (fastest and safest route):**
Hostinger Domain · Vercel Frontend · Firebase Backend · Stripe Payments · AI APIs.

**Phase 2 — Serious commercial platform:** add **Neon/Postgres** and use it for:
ACU ledger · payment reconciliation · booking accounting · supplier commissions · corporate travel · government visa decisions · fraud/risk scoring logs · audit trail.

**Phase 3 — Enterprise / VisaOS:** move critical decision records to structured SQL.
Use **Firebase for speed · Neon/Postgres for governance · BigQuery/Data Warehouse for analytics**.

**Final answer:** start with **Vercel + Firebase**; add Postgres when the platform needs stronger financial control, reporting, audits and enterprise-grade decision records. Speed now, serious scalability later.

### One long-term recommendation (locked)

Hostinger domain + Vercel frontend + **Google Cloud/Firebase backend** + Google Cloud Storage + **Postgres later inside Google Cloud (Cloud SQL)** — not Neon as the main backend.

**Why not Vercel + Neon as the main long-term backend.** Excellent for modern SaaS, but this platform's biggest challenge is not database speed — it is: heavy document storage · sensitive visa files · identity verification · audit logs · government-grade security · access control · AI processing · long-running background checks · document forensics · compliance. Those needs belong on the Google Cloud stack above.

```
Claude Build
   ↓
GitHub
   ↓
Vercel Frontend
   ↓
Firebase Auth
   ↓
Google Cloud Run / Cloud Functions Backend
   ↓
Firestore — app activity + realtime status
   ↓
Google Cloud Storage — visa documents
   ↓
Cloud SQL PostgreSQL — payments, audit, visa decisions, financial records
   ↓
Stripe / payment gateway
   ↓
AI agent layer
```

## Best long-term architecture — hybrid (do not choose only one forever)

| Layer | Technology | Responsibility |
|---|---|---|
| Frontend | **Vercel** | static SPA + landing page + serverless API |
| App backend | **Firebase** | Auth, realtime app data, storage, notifications, cloud functions |
| System of record | **Neon / Postgres** (phase 2) | financial ledger, booking records, reporting, VisaOS decision records, audit logs |
| Payments | **Stripe** | cards, wallets, subscriptions, deposits |
| Intelligence | **AI Gateway** | Claude / OpenAI / Gemini agents (`backend/src/ai-gateway.js` — model router, budgets, cost ledger) |

### Migration path to Neon (phase 2)

The in-memory store is intentionally swappable (`backend/src/store.js` header). The tables that graduate to Postgres first, mapped to existing structures:

1. `bookings` + `payments` + `refundPolicy` → booking ledger (`db.bookings`)
2. `acu_wallets` / `acu_transactions` / `ai_request_costs` → finance & AI cost reporting (`db.acuTxns`, `db.aiRequestCosts`)
3. `search_deposits` → deposit ledger (`db.searchDeposits`)
4. VisaOS: applications, decisions, hash-chained audit trail → `db.visaApps`, `db.visaChain`
5. `audit` → append-only audit table
6. Corporate travel: approvals, policies, invoices → `db.approvals` + corporate plans
