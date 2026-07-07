# 3JN Travel OS
## Revenue Protection, Cost Control & Multi-Income Engine
### Complete Developer-Ready Specification — *implemented, enforced, test-locked*

> **THE ULTIMATE POSITIONING (USP #10, top of the business model).** *3JN Travel OS is not a travel search engine. It is an AI-powered **Travel Operating System** that continuously saves travellers money, optimises every component of their journey, negotiates better travel outcomes, manages trips end-to-end, and provides personalised travel intelligence before, during and after travel.* It **Plans · Optimises · Negotiates · Books · Protects · Tracks · Manages · Saves Money · Supports During Travel · Learns User Preferences** — from one platform. We never compete with free aggregators on search; we sell **Savings, Protection, Intelligence, Negotiation and Execution** — outcomes, not search results (`POSITIONING`, test-locked).
>
> **Final positioning.** 3JN Travel OS is **not** a free AI travel search tool. It is an AI-powered travel savings and booking operating system that finds the cheapest global prices while earning from ACUs, deposits, subscriptions, supplier commissions, savings fees, corporate accounts, group travel, marketplace add-ons, white-label SaaS and APIs. This keeps the platform profitable while still delivering the promise: **world-cheapest travel prices.**
>
> **Master rule** (heads `backend/src/revenue.js` as a never-to-be-weakened contract): *AI work starts only when the platform is protected by ACUs, a deposit, strong booking intent, supplier commission, advertising revenue, or expected 10% final-payment revenue — or is served from cache. If none of these hold, the system downgrades, limits, or asks for payment before continuing.*

Every section below is **live in production**. Column three names the exact implementing symbol; every rule is pinned by the test suite (`backend/test/pipeline.test.js`, **147 tests green**) so it cannot silently regress.

### The ten USP pillars (all live)

| USP | What it does | Symbol |
|---|---|---|
| 1. AI Travel CFO | Quantified adviser: "travel 10 days later: save £430 · fly from Manchester: save £165 · same-rating hotel swap: save £290" | `travelCFO` (dive levers incl. new hotel-swap) |
| 2. Guaranteed Savings Engine | Can't beat or match your quote → your search ACUs are refunded | `claimSavingsGuarantee` · `POST /api/account/:id/savings-guarantee` |
| 3. Travel Intelligence Score | 7 scores per trip: Cost, Safety, Visa, Weather, Crowd, Value, Risk (0–100 + band) | `travelIntelligenceScore` → `result.intelligenceScore` |
| 4. Global Travel Optimiser | Flight+hotel+transfer+visa+insurance+eSIM optimised together, never piecemeal | `buildPackages` · `decision.optimisedTogether` |
| 5. AI Negotiation Layer | Net rates below public prices + perks (upgrade, breakfast, pickup, late checkout) | `result.negotiation` |
| 6. Diaspora Travel Specialist | Africa/Caribbean/South Asia/Middle East family journeys: excess baggage, money transfer, SIM, relative pickup, visa, multi-city | `result.diaspora` (region/family-signal detection) |
| 7. Group Travel OS | Multi-origin groups in ONE booking + 4 stacked group earners | `groupOrigins` + `groupTravelFees` |
| 8. Travel Wallet | Savings pots with goals, monthly plans, family/group kinds — earn before travel | `createTravelPot` (goal/monthlyUSD/kind) |
| 9. Travel+ Membership | 7 recurring benefit families | `TRAVEL_PLUS_BENEFITS` + `MEMBERSHIP_TIERS` |
| 10. Travel Operating System | The category: decisions, not options — `result.decision` returns ONE recommended answer with the saving and each best pick | `POSITIONING` + `buildDecision` |

---

## Core business principle

The platform must **never** operate as *"Free AI travel search."*
It operates as: *"An AI-powered travel savings and booking operating system where **every AI action is monetized, protected, funded, or revenue-backed**."*

## 0. The AI Cost Protection Engine — ACPE (the spine)

```
User Request
      │
      ▼
AI Cost Estimator            (SEARCH_TIERS → aiCostUSD per tier)
      │
      ▼
Revenue Opportunity Calc     (expected 10% of booking value)
      │
      ▼
Protection Gate              (costProtectionGate — 10-point checklist)
      │
      ├── Approved ──────► Execute AI Agents   (per-agent budgets enforced)
      │
      └── Rejected ──────► Request ACUs / Deposit / Upgrade
                           (or serve from cache · downgrade · throttle)
```

**Revenue Protection Formula:** `Expected Revenue ≥ Estimated AI Cost × 10`
AI cost £2 → minimum revenue potential required £20 — otherwise **BLOCK** or **DOWNGRADE**.

### The gate's checks

| Check (asked on every search) | Implementation |
|---|---|
| Is the user paying ACUs? | `costProtectionGate` → `acu-balance` funding source |
| Is there a deposit? | `search-deposit` source; £5 (Deep) / £20 (Concierge), refundable, deducted on booking |
| Is there subscription coverage? | `subscription` source (Travel+ tiers auto-fund 10% of plan into ACUs) |
| Is there supplier commission? | `SUPPLIER_COMMISSIONS` — every booked component earns |
| Is expected 10% revenue enough? | `REVENUE_TO_COST_MULTIPLE = 10` — **Expected Revenue ≥ AI Cost × 10** |
| Is cached data available? | Cache-first at **every** tier (`getCachedSearch`); fresh hits are ACU-free |
| Is the user abusing the system? | Real telemetry (`usageStats`): search volume, same-destination repeats, bookings ratio → throttle with the message *“To continue deep AI price hunting, please add ACUs or place a refundable booking deposit.”* |
| Is booking intent strong? | Explicit dates + ≥2 components → ×5 threshold assist |

**Outcomes:** allow · downgrade-to-cached · throttle · request top-up/deposit. The gate returns its 10-point answered checklist on every funded search.
**AI cost cap:** `aiCostCap()` — AI cost never exceeds 5–10% of expected profit (£1,000 booking → £100 fee → £5–£10 AI budget).
**ACU pre-approval:** paid tiers return `acu-approval-required` with the reason (“this search requires N ACU because…”); **no approval = no AI cost**.
**Per-agent budgets:** `AGENT_BUDGETS` (Flight 20 · Hotel 20 · Visa 10 · Itinerary 15 · Savings 25 …) enforced in the AI gateway; past the ceiling → `budget-stop`, zero spend.
**Free tier:** `FREE_DAILY_SEARCH_LIMIT = 5`/day, cached results only beyond — no deep agents, negotiation, booking hold or custom itineraries.

## 1–5. Core fees & AI tiers

| # | Rule | Implementation |
|---|---|---|
| 1 | **10% final-payment fee** (main revenue) | `COMMISSION_RATE = 0.10` in every `priceBreakdown` |
| 2 | **Refundable search deposits** — Deep **£5** · Luxury **£20** · Corporate **£50**; refundable, and **deducted from the final payment** when a booking occurs (`search_deposits` ledger: deposit_id, user_id, amount, search_id, refunded, converted_to_booking, date) | `placeSearchDeposit` / `refundSearchDeposit` / `convertDepositToBooking`; live deposit funds the gate (`hasDeposit`); `/api/account/:id/deposit` |
| 3 | **ACU Marketplace** — Starter **£5 = 500** · Traveller **£15 = 1,750** · Family **£29 = 4,000** · Business **£99 = 20,000** · Enterprise **custom (contact sales)**. Volume above the £1 = 100 base rate is booked as a BONUS transaction | `ACU_PACKS` + console top-up UI; `buyAcu` splits base purchase vs volume bonus |
| 4 | **Subscriptions** — Free (cached) · Smart · Family · Business (companies, NGOs, churches, teams, schools, delegations) · Concierge (AI + human, deposit) | `MEMBERSHIP_TIERS` + `CORPORATE_PLANS` + concierge tier |
| 5 | **Multi-tier search system** — Tier 1 Free: cached results, top deals, destination suggestions, previous searches, limited (5/day), **no expensive AI** · Smart **26 ACU** (Flight + Hotel + Transfer agents) · Deep Hunt **57 ACU** (+ Visa, Price Monitor, Savings/Risk agents) · Concierge **91 ACU + deposit** (+ Chief-of-Staff, Private Aviation) | `SEARCH_TIERS` (composed from `ACU_ACTIONS`; `features`/`agents` per tier) |

## 5b–8. Supply-side & value-based earnings

| # | Rule | Implementation |
|---|---|---|
| 5b | **Supplier commissions** — hotels 10%, airlines 2%, tours 12%, car rental 8%, transfers 10%, eSIM 15%, insurance 20%, visa 10%, luggage 12%, cruise 8%, tickets 10%, holiday homes 10%, travel finance 3% — *3JN earns even on the cheapest deal* | `SUPPLIER_COMMISSIONS`; `booking.supplierEarnings` per booking |
| 6 | **Savings-share** — save > £100 → 10% of the verified saving (£2,000→£1,700: £300 saved → **£30**); below £100 the customer keeps it all | `SAVINGS_SHARE_RATE` + `SAVINGS_SHARE_MIN_USD` in `priceBreakdown` |
| 7 | **Booking Protection** — optional £5–£50 (~2% of trip value): price-drop priority, mistake check, refund guidance, disruption support, document review, visa alerts | `protectionFee()` + checkout checkbox + `booking.protection` |
| 8 | **Priority search fees** — standard free · priority £3–£10 · urgent same-day £15–£50 | `PRIORITY_SEARCH_FEES` / `prioritySearchFee()` |

## 9–15. The multi-income engine

| # | Stream | Implementation |
|---|---|---|
| 9 | **Partner placements** in 6 sections (recommended deals, destination, family, African diaspora, student, business pages) — **always labelled**, never reorders the cheapest-reliable pick | `addSponsoredPlacement` / `PLACEMENT_SECTIONS` |
| 10 | **Corporate accounts** — Team £99 / Enterprise £299 monthly; staff booking, policy control, invoicing, approvals, expense export, cheapest-compliant fares, reporting | `CORPORATE_PLANS` + Business Command Centre |
| 11 | **Group travel** (churches, schools, teams, weddings, conferences, reunions, diaspora) — planning fee £49–£149 + £5/head + 10% + supplier commission | `groupTravelFees` / `GROUP_SEGMENTS`; composes with multi-origin group bookings |
| 12 | **Destination marketplace** — 10 add-ons (tours, drivers, translators, security, photographers, pickup, restaurants, tickets, SIM/eSIM, guides): *every trip a basket* | `MARKETPLACE_ADDONS` · `GET /api/marketplace/addons` |
| 13 | **White-label** — setup £1,500 · SaaS £199/mo · ACU metering · 10% commission share (partners keep 90%) · support £99/mo | `WHITE_LABEL_PRICING` / `whiteLabelPayout` |
| 14 | **API revenue** — 6 productised endpoints: search £0.05 · itinerary £0.04 · visa checklist £0.03 · group quote £0.08 · savings £0.05 · hotels £0.04 per call | `API_PRODUCTS` · `/api/v1/*` (key-gated) |
| 15 | **Finance** — pay-monthly, savings wallet, deposit plans, **group pots (1.5% processing, working)**, corporate invoicing, layaway £1/mo | `FINANCE_PRODUCTS` · `createTravelPot`/`contributeToPot` |

## The cost & ACU ledgers (spec §3–§4)

**AI Cost Estimator — `ai_request_costs`.** Every routed AI call books a ledger row: `id, provider, model, agent_name, estimated_tokens, estimated_cost, actual_cost, request_timestamp, user_id, trip_id` (+ search/booking/organisation). The gateway records automatically on every `run()` (local fallback = £0 actual); funded searches book their tier cost per user. `aiCostReport()` aggregates **per provider (OpenAI / Claude / Gemini / Vertex)** and **per Search / Trip / User / Booking / Organisation** — served at `GET /api/admin/ai-costs`. Implementation: `recordAiRequestCost` / `aiCostReport` (store) + `estimateRequestCost` / `PROVIDER_TOKEN_RATES` (gateway).

**ACU Economy — `acu_wallets` + `acu_transactions`.** The wallet view (`acuWallet`) derives `wallet_id, user_id, current_balance, lifetime_purchased, lifetime_used, lifetime_earned, status` live from the transaction ledger so counters can never drift. Every movement is a typed transaction — **PURCHASE / USAGE / REFUND / BONUS / REWARD** (`transaction_id, wallet_id, type, amount, date`): pack purchases split base PURCHASE vs volume BONUS, membership funding books as BONUS, incentives as REWARD (`rewardAcu`), reversals as REFUND (`refundAcu`). Served at `GET /api/account/:id/wallet`.

## Survival mechanics

- **Cache-First Intelligence Engine (spec §16)** — before ANY AI search the engine checks: historical results, popular routes, past bookings, cached prices, destination intelligence, supplier deals. Cache confidence decays with age; **above 85% → serve cache, no AI cost** (`cacheConfidence` / `CACHE_SERVE_CONFIDENCE`); the free tier serves any age.
- **Search Abuse Detection Engine (spec §15)** — seven tracked signals (searches without booking, repeated searches, bot behaviour, multiple accounts, excessive AI consumption, chargebacks, suspicious activity) scored 0–100 with the spec bands **0–30 Normal · 31–60 Monitor · 61–80 Restrict · 81–100 Block** (`searchAbuseScore`, verdict attached to every gate throttle). Abuse detection also **forfeits the active search deposit** (Revenue Source 3: non-refundable if abuse detected — `forfeitSearchDeposit`).
- **Multi-tier search (spec §7, complete)** — Tier 3 Deep runs Flight, Hotel, Visa, Transfer, **Price Negotiation** and **Savings** agents; Tier 4 Concierge pairs the AI agents with a **Human Travel Expert** and REQUIRES a deposit, subscription or premium plan (`concierge-requires-commitment` — ACU balance alone is never enough for human time).
- **Per-agent budgets (spec §8)** — Flight 20 · Hotel 20 · Visa 10 · **eSIM 5 · Transfer 5** · Itinerary 15 · Savings max 25; exceeding a budget **pauses execution and requests user approval** (`budget-stop`).
- **Profitability Dashboard (spec §17)** — `GET /api/admin/profitability`: real-time ACUs sold/burned, AI costs (estimated vs actual), profit, and every stream (commission, supplier, subscription, search-deposit, savings, ACU sales, protection, corporate, white-label, API) computed live from the ledgers.
- **FINAL PLATFORM RULE (LOCKED)** — no AI agent executes unless funded by: ACU balance · search deposit · active subscription · supplier-commission opportunity · expected 10% booking revenue · **corporate contract** · **white-label contract**. If none exist: downgrade, request payment, or block (`costProtectionGate`, all seven sources test-pinned).
- **Positioning enforced in the AI itself** — the platform `SYSTEM_PROMPT` carries: *“NOT free AI travel search — the AI-powered travel savings engine that finds cheaper global prices, protects customers from overpaying, and only charges when real value is created.”*

## Where each rule lives

`backend/src/revenue.js` (gate, tiers, caps, fees, group/white-label/API/finance catalogues) · `backend/src/partners.js` (supplier commissions, placements) · `backend/src/pricing.js` (10%, savings share, protection) · `backend/src/store.js` (ACU packs, pots, usage telemetry, cache) · `backend/src/planner.js` (cache-first, gate wiring) · `backend/src/ai-gateway.js` (agent budgets, positioning) · `backend/src/server.js` (ACU pre-approval, `/api/v1` products) · tests: `backend/test/pipeline.test.js`.
