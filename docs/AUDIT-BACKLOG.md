# 3JN Travel OS — 20-Day Deep-Dive Audit & Backlog

A full sweep of the last 20 days (73 commits) across four lanes — unfinished
code, verification/certification gaps, supplier/config completeness, and
docs↔code drift — plus the open threads from the build sessions.

**Health verdict:** the **code is healthy** — 547/547 tests pass, zero orphan
modules, no dead/`.bak` files, and **no money or security path is silently
broken** (payment rails fail honestly: refuse, or run a clearly-labelled
simulation). The real backlog is (a) a handful of fail-open gaps now closed,
(b) integrations that are wired but **credential/certification-gated**, and
(c) documentation drift now largely corrected.

Owners: **[CLEARED]** done in this pass · **[CODE]** needs a focused code
follow-up · **[YOU]** needs your credentials/certification/legal · **[DECIDE]**
needs a business decision.

---

## 1. Cleared in this pass  ✅

### Code-safety (committed, 547/547 green)
- **comms `sent`-without-sending** — SMS/push/WhatsApp had no send implementation
  yet were logged `status:'sent'` when a `*_PROVIDER_KEY` was set, silently
  dropping possibly-critical notices. Now only email (with a recipient) and
  in-app report `sent`; the unwired channels stay `logged`. Dropped the false
  `resend` provider label (email always sends via SMTP).
- **Duffel webhook fail-open** — the signature check was skipped entirely when
  `DUFFEL_WEBHOOK_SECRET` was unset, so a forged POST could raise a fake "your
  airline changed your flight" alert. Now fails closed (ping still registers the
  endpoint; real events ignored until the secret is set).
- **Visa reservation free-issue risk** — a `LIVE_MODE` deploy with Stripe
  misconfigured could mark a fee'd reservation paid and queue issuance for free.
  Now forces awaiting-payment in `LIVE_MODE`.

### Docs drift
- **`.env.example`** rewritten — it wrongly listed Stripe as "reserved / next
  build step" (it's fully built) and omitted `STRIPE_*`, `DATA_ENCRYPTION_KEY`,
  `PII_ENCRYPTION_KEY`, `CRON_SECRET`, `DUFFEL_WEBHOOK_SECRET`, persistence, and
  every supplier lane. Now organised go-live-first with the wired lanes.
- **README** — `public/`→`frontend/`; membership tiers "four (Nomad/Family/
  Executive/Elite)" → the real "two (Travel+, Travel+ Family)"; test count
  "12"→"547"; the "live-provider ready" AI claim corrected to say the provider
  call is stubbed.
- **SUPPLIER-DOORS** — the "every door goes live with zero code changes" promise
  now names the doors that need an adapter built first (WebBeds, RateHawk,
  CarTrawler car-hire, Distribusion).

---

## 2. Code follow-ups (real; need a focused, careful change)  [CODE]

| # | Item | Where | Risk | Priority |
|---|------|-------|------|----------|
| 2.1 | **Money-array soft-trim** — `capArr` splices memory but the durable per-record leaf survives, so a trimmed payout/fulfilment/withdrawal row can resurrect on hydrate and be re-processed. The `d739126` commit shipped with this as a known follow-up. | `store.js` `capArr`, `KEYED_ARRAY_KEYS`; `persistence.js` | Re-paid payout / re-fulfilled order at scale (low at launch volume) | **P1** |
| 2.2 | **Swallowed post-payment side-effects** — bare `catch {/* best-effort */}` around `createFulfilmentOrders`, rewards, referral, vendor attribution. A paid booking can silently lack a fulfilment order with only a console trace. | `store.js:2084/2142/2177`, `server.js:4239` | Paid-but-unfulfilled booking invisible to ops | P2 |
| 2.3 | **No "live path fell back N times" alert** — every unverified integration fails closed to the ops desk *silently*, so a broken field-mapping looks like "quiet" rather than an alarm. | supplier adapters + a counter | Broken supplier hides behind ops desk | P2 |
| 2.4 | **Duffel Stays has no API cancel** — cancellation routes to the ops desk (`cancelDuffelStay` absent). | `live-suppliers.js` | Manual cancels only | P3 |
| 2.5 | **Live hotel resilience** (only worth doing once on a prod Hotelbeds key): move the availability cache + quota flag to shared KV (kills the serverless flip-flop); complete the IATA→Hotelbeds destination-code map / resolve via the destinations content API (fixes cities like Faro/Paris returning 0 → estimate). | `live-suppliers.js` `HB_METRO_CODE`, `hotelbedsDestCode`, `_hbAvailCache` | Hotels stay "estimated" | P2 (post-key) |
| 2.6 | **AI Gateway live call is a stub** — `callProvider()` always throws; every "AI" task runs the local heuristic engine. Wire the provider SDK (or keep as heuristic and market it as such). | `ai-gateway.js:242` | "AI" output is deterministic, not an LLM | P2 |

---

## 3. Your action — credentials / certification / legal  [YOU]

These cannot be cleared by code. Ranked by go-live impact.

### P0 — required for any real go-live
- **Durable store:** `FIREBASE_SERVICE_ACCOUNT` (+ URL) **or** `KV_REST_API_URL`+`KV_REST_API_TOKEN` — without it every booking/user/lead is lost on each serverless cold start.
- **Stripe live:** `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` (else payments are simulated).
- **Duffel live token** (`duffel_live_…`) — a test token in `LIVE_MODE` disables flights **and** Duffel-Stays hotels.
- **Security:** `STAFF_ACCESS_PIN` (or staff consoles open with no password), `HUMAN_CHECK_SECRET`, `DATA_ENCRYPTION_KEY`, `PII_ENCRYPTION_KEY`, `CRON_SECRET`, `CORS_ORIGIN`, `LIVE_MODE=true`.
- **`SMTP_PASS`** — turns on email capture, welcome, alerts, and the newsletter.

### P1 — live hotels (your repeated pain point)
- **Production Hotelbeds contract + key + mTLS cert** and `HOTELBEDS_BASE_URL=https://api.hotelbeds.com`. The current test/eval key has a ~50/day quota and only demo-city inventory (Faro/Paris absent) — this is *the* reason hotels show "estimated", and no code change conjures inventory the sandbox lacks. Then do §2.5.
- Or enable **Duffel Stays** on the Duffel account (reuses `DUFFEL_TOKEN`; thinner inventory) as the faster hotel path.

### P1–P2 — supplier certifications (booking field-names unverified)
Every live **booking** path ships flagged "MUST be re-verified at certification"
and is untested against a real supplier response. Certify before enabling: Duffel
Stays, **Hotelbeds Booking** (Availability→CheckRate→Booking→Cancel), **TBO Air**
ticketing (+ real `EndUserIp`, not the `1.1.1.1` default), **TBO Hotels**
(city→HotelCode lookup), **Viator merchant** (`paymentDataToken`,
`VIATOR_PARTNER_ID`, tier=merchant), Kiwi/Tequila booking (adapter is an ops
stub). Until then these are "book" in name only — human-completed via the ops desk.

### Legal / compliance
- **TTA → ATOL** financial protection — legal gate for flight-inclusive packages; also the protection badge.
- **FCA IAR authorisation** — before enabling any insurance sale (no `bookInsurance` exists even then).
- **BitriPay / mobile-money** certification — deferred; Stripe-only until then.
- **VisaOS live** — needs real KYC/watchlist/liveness services wired (`visaos.js:186` signals are demo booleans) before enabling.

### Optional lanes / notifications
- SMS/Push/WhatsApp: `*_PROVIDER_KEY` are read but **no send code exists** — a provider integration must be built (setting the key alone does nothing now).
- AI providers: wire `callProvider` + set a key (see §2.6).

---

## 4. Business decisions needed  [DECIDE]

| Item | Doc says | Code says | Question |
|------|----------|-----------|----------|
| Flights free for members | `PRICING-MODEL.md`: **FREE for Travel+** (`FLIGHT_ONLY_MEMBER_FREE=true`) | `shared/constants.js:32`: **false** | Which is intended? (customer-facing promise) |
| Flight-only partner share | `PRICING-MODEL.md`: **40%** | `shared/constants.js:65`: **30%** | Which is the real commercial number? |

Tell me the intended value for each and I'll reconcile the doc **and** the constant.

---

## 5. Deliberate gates (NOT bugs — for awareness)

These are intentionally off and fail safe; listed so they're not mistaken for defects:
Save-&-Search wallet (safeguarding-gated), Corporate & Embassy consoles ("coming
soon" — unbuilt), priority paid-search tiers (Stripe-gated), simulated ACU/deposit
paths (unreachable once Stripe is live), GeoIP (header-only), partner affiliate
tracking map (empty until deals sign), Amadeus/Mozio/TBO-Hotels/Hotelbeds-activities
booking (search-only, ops-desk fulfilment), RateHawk/Distribusion/CarTrawler-car-hire
(roadmap, unwired), OAG/Travelpayouts (informational, never bookable), Rayna
(manual portal by design).

---

*Generated from a four-lane parallel audit. The code fixes and doc corrections in
§1 are committed; §2 are the code follow-ups; §3–§4 need you.*
