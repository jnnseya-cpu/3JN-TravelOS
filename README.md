# 3JN Travel OS

> Stop Searching. Start Saving.

A **global travel operating system**: say what you want in one sentence and the OS
understands your intent, scans verified global suppliers, builds the cheapest
*reliable* package across every travel vertical, adds 3JN's transparent
commission, and lets you pay by deposit + interest-free instalments — then keeps
working after you book with a 24/7 price guard.

This is a **self-contained, runnable prototype**. It needs **no API keys and no
external AI service** — the intent engine is deterministic, so it never fails
with the "empty AI error" class of problems. Everything runs offline.

```bash
npm install
npm start
# → http://localhost:3000
```

Run the tests:

```bash
npm test
```

---

## What it does (the full brief, end to end)

Type a sentence like:

> *"I want to travel to Dubai with my family in August for 7 nights. I want
> flights, hotel, visa, activities, internet abroad, airport transfer,
> instalments and the cheapest reliable price."*

…and the system runs the complete pipeline:

| Stage | Module | What happens |
|------|--------|--------------|
| **Understand intent** | `backend/src/intent.js` | Destination, travellers (family → 2+2), nights, month, dates, requested components, instalments, "cheapest reliable" — all parsed deterministically. Ambiguous requests return clarifying questions instead of crashing. |
| **Detect location/language/currency** | `backend/src/geo.js` | Reads `Accept-Language` / country and prices everything in the traveller's currency. |
| **Cost-protection gate (ACPE)** | `backend/src/revenue.js` | No costly search runs unless funded by ACU balance, deposit, subscription, supplier commission or expected booking revenue (revenue ≥ AI cost × 10). Otherwise it downgrades to cached results. |
| **Scan global suppliers** | `backend/src/suppliers.js` | Flights (inbound **and** outbound), hotels, private hosts, activities, visa, insurance, transfers, car/bike hire, event tickets, boat/yacht charter, roaming/eSIM — each with a reliability score and verified flag. |
| **Partner & agent sourcing** | `backend/src/partners.js` | Every component is attributed to a real booking partner with a deep-link. **Rayna Tours** is the **agent account** for Dubai/UAE land products (activities, tickets, transfers, visa, boats) — 3JN buys at **net rates ~18% below public**, funding the "up to 30% cheaper" promise. Flights → Kiwi/Trip, hotels → Trip/Expedia, eSIM → Airalo, etc. |
| **Compare & filter** | `backend/src/packager.js` | Keeps only **verified** suppliers above the reliability floor (70). |
| **Find cheapest reliable combination** | `backend/src/packager.js` | Builds 3 tiered options — **Standard (cheapest reliable)**, **Premium (best balance)**, **Luxury (top-rated)** — and **recommends the best value**. |
| **Add 3JN commission** | `backend/src/pricing.js` | Transparent 10% fee, loyalty discount and savings-vs-market shown in every breakdown. |
| **Deposit & instalments** | `backend/src/pricing.js` | 20% deposit + interest-free monthly schedule ending before departure. |
| **Monitor price after booking** | `backend/src/monitor.js` | Neural Price Guard re-scans the market; if the price drops it rebooks and refunds the difference; if it rises it confirms your locked rate saved you money. |
| **Reviews & supplier scoring** | `backend/src/reviews.js` | Post-trip reviews feed live supplier scores that blend back into future reliability rankings. |
| **Revenue model** | `backend/src/revenue.js` | 15+ streams: 10% fee, ACU packs, deposits, supplier commissions, savings-share, subscriptions, corporate, group, marketplace, white-label, API, finance. |

## Pages (frontend in `public/`)

- **Landing** — *Stop Searching. Start Saving.* hero, the "Travel Search Is
  Broken" problem split, featured Dubai holiday, the 10-agent AI Core, the four
  **Travel+** membership tiers (Nomad / Family / Executive / Elite), and the
  *Future of Travel is Intelligent* CTA.
- **Plan a Trip** — the working planner: one-sentence input → live supplier scan
  → tiered package comparison → quote → instalments → booking.
- **How it Works** — the 6-step neural pipeline + the 3JN-vs-Legacy comparison.
- **Membership** — tiers plus the Explorer→Elite loyalty ladder.
- **API** — white-label portal with a live 90/10 revenue-share calculator and a
  runnable `/api/v1/search` partner endpoint.
- **Universal Console** — your bookings, instalment schedules, the price guard,
  loyalty/ACU balances, referral code and post-trip reviews.

Try the **Full Access** button (top-right) to load a single account that unlocks
every section of the OS (admin, business, merchant, consumer, VisaOS).

## Modules

Beyond the core travel pipeline, the OS includes these working modules:

- **3JN VisaOS** (`/visaos`) — AI visa decision engine: a 10-agent swarm →
  7 risk dimensions → 0–1000 score → decision (Approve/Conditional/Review/Reject),
  plus a Government Dashboard. Integrated into the planner as a pre-booking
  approval-probability badge. (`backend/src/visaos.js`)
- **Admin Super Control Centre** (`/admin`) — platform KPIs, AI-gateway routing,
  tier/payment-rail mix, supplier leaderboard, revenue streams, live activity +
  immutable audit log.
- **Business / Enterprise Command Centre** (`/business`) — team itinerary mesh,
  travel policy, multi-level approval queue, duty-of-care, **Supplier Contract
  Manager** (AI-negotiated volume discounts).
- **Destination Marketplace** (`/marketplace`) — browsable destinations with
  localised "from" prices that deep-link into the planner.
- **Universal Console** (`/console`) — bookings, instalments, price guard,
  reviews, **Loyalty Hub**, **eSIM Manager**, **Expense Intelligence** (CSV
  export), **Document Vault**, **Travel Intelligence** (Visa Centre + Risk Feed),
  and the **Merchant / White-Label API + BitriPay portal** (keys, payment links,
  QR, settlement).
- **Accounts** — multi-role (consumer/business/merchant/partner/admin), editable
  profile + profile picture, login/signup with session persistence, an
  `allAccess` capability, loyalty + referrals.
- **AI Gateway** (`backend/src/ai-gateway.js`) — Model Router across Claude /
  OpenAI / Gemini / Cohere, anchored to the platform system prompt
  (`docs/MASTER_AI_PROMPT.md`), ACU-metered, local fallback with no keys.
- **Notifications**, **autosave + audit log**, **i18n** (EN/FR/SW/LN/AR, RTL),
  and **device-based language/currency auto-detection**.

## API surface

```
GET  /api/context                 detect currency/language + config
POST /api/plan                    run the full pipeline → tiered options
POST /api/quote                   persist an option + build instalments
POST /api/book                    confirm + take deposit (+loyalty points)
POST /api/book/:id/pay            pay an instalment
POST /api/book/:id/price-guard    run the Neural Price Guard
POST /api/reviews                 submit a post-trip supplier review
GET  /api/suppliers/leaderboard   supplier scores
POST /api/account | /account/test create / provision test account
POST /api/account/:id/acu         buy an ACU pack
GET  /api/white-label/payout      partner 90/10 revenue-share calculator
GET  /api/admin/revenue           profitability snapshot
POST /api/v1/search               white-label partner search endpoint
```

## Architecture notes

- **No fragile AI dependency.** The previous Gemini/Genkit build repeatedly
  failed with `Console Error: {}` because every search hit an LLM behind strict
  schema validation. Here, intent parsing is rule-based and every API handler is
  wrapped so an error always returns clean JSON — never an empty object.
- **Deterministic suppliers.** Inventory is synthesised from a per-destination
  cost basis with a seeded PRNG, so results are stable and testable. Swap
  `backend/src/suppliers.js` for real GDS/aggregator calls to go live.
- **In-memory store** (`backend/src/store.js`) — swap for Postgres/Firestore for
  persistence.

## Project structure

```
3JN-TravelOS/
├── frontend/            # Browser app — no build step
│   ├── index.html       #   cinematic landing + planner + console + how-it-works + API + membership
│   ├── app.js           #   controller: API calls, view routing, the full pipeline UI
│   └── styles.css       #   premium navy/gold/electric-blue design system
├── backend/             # Node/Express API + engine
│   ├── src/             #   server.js + intent, geo, destinations, suppliers, packager,
│   │                    #   pricing, revenue, monitor, reviews, store, planner, partners
│   └── test/            #   node:test suite (12 tests)
├── shared/              # Single source of truth imported by backend + served to frontend
│   └── constants.js     #   commission, loyalty tiers, membership plans, ACU economy, reliability floor
├── docs/
│   └── BLUEPRINT.md     # Full investor-grade AI-OS master blueprint (16 sections)
└── package.json
```

The `shared/` module is imported directly by the backend and mounted at `/shared`
so the browser reads the same constants — frontend and backend never drift.

## Documentation

- **[`docs/AI-OS-MASTER-BLUEPRINT.md`](docs/AI-OS-MASTER-BLUEPRINT.md)** — **Master Blueprint v2 (forensic upgrade).**
  The production build specification: a forensic gap register (technical/commercial/scalability/security/operational/AI)
  with proven-pattern remedies, then all 17 required sections + the enterprise multi-agent workforce, self-managing
  platform layer, Cybersecurity Command Centre, AI Data Intelligence layer, agent runtime, production DB DDL, `/api/v1`
  spec, and PRR gates — every claim anchored to a real file/endpoint/entity in this repo. Supersedes v1 (nothing removed).
- **[`docs/AI-OS-ARCHITECTURE.md`](docs/AI-OS-ARCHITECTURE.md)** — v1 baseline: production-grade AI Infrastructure
  OS architecture (17 sections: vision, market gap, user ecosystem, AI command centres, the full
  multi-agent workforce + self-managing layer, cybersecurity command centre, data-intelligence
  layer, BitriPay gateway, connector ecosystem, architecture, ERD, API spec, monetisation,
  security/compliance, admin centre, roadmap, competitive advantage, production-readiness review).
- **[`docs/BLUEPRINT.md`](docs/BLUEPRINT.md)** — the 16-section base platform blueprint.
- **[`docs/MASTER_AI_PROMPT.md`](docs/MASTER_AI_PROMPT.md)** — the platform-wide system prompt,
  wired into the AI Gateway (`SYSTEM_PROMPT` + standard output format) so every routed model call
  is anchored to it.
- **[`DEPLOY.md`](DEPLOY.md)** — Vercel (frontend) + Cloud Run/Render (backend) + Hostinger DNS.

## Stack

Node.js + Express, vanilla JS frontend (Space Grotesk + Inter), zero build step. The **AI Gateway**
(`backend/src/ai-gateway.js`) is a provider-agnostic Model Router that shares work across Claude /
OpenAI / Gemini / Cohere by task, meters ACU, and falls back to the local deterministic engine when
no API keys are present — so the platform runs fully offline yet is live-provider ready.
