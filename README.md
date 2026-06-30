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
| **Understand intent** | `src/intent.js` | Destination, travellers (family → 2+2), nights, month, dates, requested components, instalments, "cheapest reliable" — all parsed deterministically. Ambiguous requests return clarifying questions instead of crashing. |
| **Detect location/language/currency** | `src/geo.js` | Reads `Accept-Language` / country and prices everything in the traveller's currency. |
| **Cost-protection gate (ACPE)** | `src/revenue.js` | No costly search runs unless funded by ACU balance, deposit, subscription, supplier commission or expected booking revenue (revenue ≥ AI cost × 10). Otherwise it downgrades to cached results. |
| **Scan global suppliers** | `src/suppliers.js` | Flights (inbound **and** outbound), hotels, private hosts, activities, visa, insurance, transfers, car/bike hire, event tickets, boat/yacht charter, roaming/eSIM — each with a reliability score and verified flag. |
| **Partner & agent sourcing** | `src/partners.js` | Every component is attributed to a real booking partner with a deep-link. **Rayna Tours** is the **agent account** for Dubai/UAE land products (activities, tickets, transfers, visa, boats) — 3JN buys at **net rates ~18% below public**, funding the "up to 30% cheaper" promise. Flights → Kiwi/Trip, hotels → Trip/Expedia, eSIM → Airalo, etc. |
| **Compare & filter** | `src/packager.js` | Keeps only **verified** suppliers above the reliability floor (70). |
| **Find cheapest reliable combination** | `src/packager.js` | Builds 3 tiered options — **Standard (cheapest reliable)**, **Premium (best balance)**, **Luxury (top-rated)** — and **recommends the best value**. |
| **Add 3JN commission** | `src/pricing.js` | Transparent 10% fee, loyalty discount and savings-vs-market shown in every breakdown. |
| **Deposit & instalments** | `src/pricing.js` | 20% deposit + interest-free monthly schedule ending before departure. |
| **Monitor price after booking** | `src/monitor.js` | Neural Price Guard re-scans the market; if the price drops it rebooks and refunds the difference; if it rises it confirms your locked rate saved you money. |
| **Reviews & supplier scoring** | `src/reviews.js` | Post-trip reviews feed live supplier scores that blend back into future reliability rankings. |
| **Revenue model** | `src/revenue.js` | 15+ streams: 10% fee, ACU packs, deposits, supplier commissions, savings-share, subscriptions, corporate, group, marketplace, white-label, API, finance. |

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

Try the **Test Account** button (top-right) to load a Voyager-tier member
pre-populated for testing.

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
  `src/suppliers.js` for real GDS/aggregator calls to go live.
- **In-memory store** (`src/store.js`) — swap for Postgres/Firestore for
  persistence.

## Stack

Node.js + Express, vanilla JS frontend (Space Grotesk + Inter), zero build step.
