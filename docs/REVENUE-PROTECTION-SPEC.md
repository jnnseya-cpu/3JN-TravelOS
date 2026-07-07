# 3JN Travel OS
## Revenue Protection, Cost Control & Multi-Income Engine
### Complete Developer-Ready Specification — *implemented, enforced, test-locked*

> **Final positioning.** 3JN Travel OS is **not** a free AI travel search tool. It is an AI-powered travel savings and booking operating system that finds the cheapest global prices while earning from ACUs, deposits, subscriptions, supplier commissions, savings fees, corporate accounts, group travel, marketplace add-ons, white-label SaaS and APIs. This keeps the platform profitable while still delivering the promise: **world-cheapest travel prices.**
>
> **Master rule** (heads `backend/src/revenue.js` as a never-to-be-weakened contract): *AI work starts only when the platform is protected by ACUs, a deposit, strong booking intent, supplier commission, advertising revenue, or expected 10% final-payment revenue — or is served from cache. If none of these hold, the system downgrades, limits, or asks for payment before continuing.*

Every section below is **live in production**. Column three names the exact implementing symbol; every rule is pinned by the test suite (`backend/test/pipeline.test.js`, **128 tests green**) so it cannot silently regress.

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
| 2 | **Refundable search deposits £5–£20**, deducted from final payment | Gate `requirement.orDepositGBP`; filters unserious users |
| 3 | **Paid ACU packs** — Starter £5 · Smart Traveller £15 · Family £29 · Business £99 (£1 = 100 ACU) | `ACU_PACKS` + console top-up UI |
| 4 | **Subscriptions** — Free (cached) · Smart · Family · Business (companies, NGOs, churches, teams, schools, delegations) · Concierge (AI + human, deposit) | `MEMBERSHIP_TIERS` + `CORPORATE_PLANS` + concierge tier |
| 5 | **AI cost tiers** — Basic free/cached · Smart **26 ACU** · Deep Hunt **57 ACU** · Concierge **91 ACU + deposit** | `SEARCH_TIERS` (composed from `ACU_ACTIONS`) |

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

## Survival mechanics

- **Cache everything** — popular routes, packages, visa rules, prior agent answers; **checked before spending ACUs at every tier**; fresh hits served free (`served-from-cache`, `acuCharged: 0`).
- **Abuse prevention** — daily cap, volume throttle, same-destination repetition, searches-vs-bookings ratio; fraud engine covers multi-account signals (IP switching, device intelligence).
- **Positioning enforced in the AI itself** — the platform `SYSTEM_PROMPT` carries: *“NOT free AI travel search — the AI-powered travel savings engine that finds cheaper global prices, protects customers from overpaying, and only charges when real value is created.”*

## Where each rule lives

`backend/src/revenue.js` (gate, tiers, caps, fees, group/white-label/API/finance catalogues) · `backend/src/partners.js` (supplier commissions, placements) · `backend/src/pricing.js` (10%, savings share, protection) · `backend/src/store.js` (ACU packs, pots, usage telemetry, cache) · `backend/src/planner.js` (cache-first, gate wiring) · `backend/src/ai-gateway.js` (agent budgets, positioning) · `backend/src/server.js` (ACU pre-approval, `/api/v1` products) · tests: `backend/test/pipeline.test.js`.
