# 3JN Travel OS — Go‑Live (single source of truth)

This is the one canonical go‑live document. It replaces the older
`GO-LIVE-STACK.md`, `HELD-TICKET-GO-LIVE.md`, and `LAUNCH-WEEK.md` (folded in
below).

**Contents**

- [Part A — Backend go‑live (credentials & switches)](#part-a--backend-go-live)
- [Part B — Launch week (frontend, SEO, first customers)](#part-b--launch-week)
- [Part C — Held‑ticket / split‑pay feature runbook](#part-c--held-ticket--split-pay-runbook)
- [Part D — Architecture & stack strategy](#part-d--architecture--stack-strategy)
- [Appendix — env‑var reference](#appendix--env-var-reference)

> **Golden rule (applies everywhere):** the OS is **fail‑closed by design**.
> With no keys set it runs the safe simulated flow — nothing charges a real card
> or issues a real ticket. Every env var below takes effect **only after you
> redeploy**. That one step is the most common reason a change "didn't work".

---

<a name="part-a--backend-go-live"></a>
## Part A — Backend go‑live

Set these on the **backend deployment** (the API host / Vercel project), not the
static frontend, then redeploy.

### 1. Master switch

| Var | Value | Effect |
|-----|-------|--------|
| `LIVE_MODE` | `true` | Removes every demo/free‑AI affordance: guests get cached results only, all AI actions are ACU‑funded, and demo/admin surfaces fail closed unless the staff PIN is set **and** supplied. |

### 2. Staff access (REQUIRED before `LIVE_MODE=true`)

| Var | Notes |
|-----|-------|
| `STAFF_ACCESS_PIN` | Second factor for every privileged (admin/embassy/consulate) area and the demo‑account surfaces. Without it, privileged **login** fails closed (good), but set it so your own staff can get in. Long random value; rotate on staff change. |
| `HUMAN_CHECK_SECRET` | Signs the sign‑up/login human‑challenge tokens. Set a random secret in production so challenges can't be forged. |

### 3. Payments — Stripe (set BOTH or neither)

| Var | Notes |
|-----|-------|
| `STRIPE_SECRET_KEY` | `sk_live_…`. Enables real Checkout for booking payments **and** ACU/membership purchases (both credited only by the signed webhook). |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` for `/api/pay/stripe/webhook`. **Without it every incoming webhook is rejected**, so payments capture but never fulfil. Configure the endpoint in the Stripe dashboard to POST `checkout.session.completed` to `https://<api-host>/api/pay/stripe/webhook`. |

Test‑mode dry run: `STRIPE_SECRET_KEY=sk_test_…` + `ALLOW_TEST_PAYMENTS=true`
exercises the full pay → webhook → ticket flow without live cards. Remove
`ALLOW_TEST_PAYMENTS` for production.

### 4. Flights — Duffel (the ticketing engine)

| Var | Notes |
|-----|-------|
| `DUFFEL_TOKEN` | A **test** token (`duffel_test_…`) issues test orders; a **live** token issues real tickets. Live flights + auto‑ticketing only run when set. |
| `DUFFEL_STAYS` | Defaults on when Duffel is enabled; set `false` to disable Stays auto‑booking and hand hotels to the ops desk. Uses the **same** `DUFFEL_TOKEN`. |
| `DUFFEL_VERSION` / `DUFFEL_BASE_URL` | Optional overrides; defaults are correct for current Duffel. |

### 5. Persistence — Firebase RTDB (so data survives a restart)

| Var | Notes |
|-----|-------|
| `FIREBASE_SERVICE_ACCOUNT` | JSON service‑account credential (or use `GOOGLE_APPLICATION_CREDENTIALS`). |
| `FIREBASE_DATABASE_URL` | RTDB URL. Both are needed for the store to hydrate on boot and flush on write/shutdown. Without them the store is in‑memory only and **resets on every redeploy/scale event**. |

### 6. Email / notifications (recommended)

Set SMTP so ticket confirmations, refunds, welcome emails and cheapest‑date
alerts actually reach customers. The mailer turns on as soon as **`SMTP_PASS`**
is set; `SMTP_HOST` defaults to `smtp.hostinger.com`, `SMTP_PORT` to `465`
(SSL) — override `SMTP_HOST`/`SMTP_PORT`/`SMTP_FROM`/`SMTP_USER` for a different
provider. No `SMTP_PASS` = confirmations are logged only, not sent.

### 7. Optional supplier channels (each independent, fail‑closed)

Set only what you've contracted; each stays off (with a safe fallback) until its
keys are present.

- **Market fares / calibration:** `TRAVELPAYOUTS_TOKEN` (self‑serve, free).
- **LCC fares:** `KIWI_TEQUILA_KEY` / `TEQUILA_API_KEY` (ops‑desk ticketing).
- **Hotels fallback:** `AMADEUS_CLIENT_ID` + `AMADEUS_CLIENT_SECRET`.
- **eSIM:** `AIRALO_CLIENT_ID` + `AIRALO_CLIENT_SECRET`, or `ESIMACCESS_API_KEY`.
- **Activities:** `VIATOR_API_KEY` (+ `VIATOR_PARTNER_TIER`).
- **Transfers / mobility:** `MOZIO_API_KEY`; `CARTRAWLER_PARTNER_TOKEN` + `CARTRAWLER_PARTNER_ID` + `CARTRAWLER_BASE_URL` + `CARTRAWLER_WEBHOOK_SECRET`.
- **Insurance:** `XCOVER_API_KEY` / `BATTLEFACE_API_KEY` (+ `INSURANCE_AUTHORISED`).
- **CORS:** `CORS_ORIGIN` to your public frontend origin.

### 8. Pre‑flight verification

1. `cd backend && npm test` — the full suite must be green.
2. With test keys, run one booking end‑to‑end: search → book → pay (Stripe test
   card) → confirm the webhook issues a Duffel test order and the customer gets a
   PNR + e‑ticket in the Console.
3. Confirm a **refund path**: force a ticketing failure and verify the Stripe
   refund fires and an ops ticket is raised.
4. Confirm **persistence**: redeploy and check bookings/users survived.
5. Flip `LIVE_MODE=true`, swap to live keys, and repeat step 2 with a real
   low‑value fare before advertising.

### Minimal live set (shortest path to real bookings)

```
LIVE_MODE=true
STAFF_ACCESS_PIN=<random>
HUMAN_CHECK_SECRET=<random>
STRIPE_SECRET_KEY=sk_live_…
STRIPE_WEBHOOK_SECRET=whsec_…
DUFFEL_TOKEN=duffel_live_…
FIREBASE_SERVICE_ACCOUNT=<json>
FIREBASE_DATABASE_URL=https://<project>.firebaseio.com
SMTP_PASS=…                 # + SMTP_FROM; SMTP_HOST/PORT default to Hostinger:465
```

### Curated Deals — sell real products on day one (no supplier API needed)

Fastest path to revenue before live supplier feeds are connected: the **Curated
Deals** catalogue — real packages your team publishes at a real, all‑in price
you fulfil through your agent network.

1. Sign in as owner/admin → **Admin → Manage deals → ＋ New deal**. Enter a
   title, a real GBP price, what's included, and an internal fulfilment note
   (never shown to customers). Publish.
2. Customers see them under **Deals** and book:
   - With Stripe set → self‑serve **card checkout**; on payment the order lands
     in the **Ops Fulfilment Desk** and the customer is emailed a confirmation.
   - Without Stripe yet → the buy button takes a **reservation**; your team is
     emailed to collect payment and confirm. Nothing is fulfilled until paid.
3. Fulfil each paid order from the ops queue (manual now). When you later connect
   a live door (Duffel etc.), the same order path is ready to auto‑fulfil.

Curated deals are `priceBasis: 'confirmed'` — a real committed price — payable
exactly like a live fare.

---

<a name="part-b--launch-week"></a>
## Part B — Launch week

Everything in the codebase is built and pushed. These are the moves only you can
make — the ones that turn 483 landing pages and 20 blog posts into your first
paying customers. All settings here are env vars in **Vercel → Settings →
Environment Variables**, scoped to **Production**, then **Redeploy**.

### Step 1 — Switch on email capture ⚡ makes money · ~10 min

Landing pages already have the "get cheapest‑date alerts" box; it just needs a
mailbox to send from (same `SMTP_PASS` as Part A §6).

```bash
SMTP_PASS=your-hostinger-mailbox-password
# Optional if different from defaults:
SMTP_USER=info@3jntravel.com
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=465
```

**Verify:** open `/destinations/lagos`, enter your own email in the alert box,
check your inbox for the welcome email. If it lands, capture is live and the
weekly cheapest‑date alerts fire on their own.

### Step 2 — Get indexed by Google ⚡ makes money · ~15 min

Until you do this, the 483 landing pages and 20 posts are invisible to search.

1. [Google Search Console](https://search.google.com/search-console) → add site
   as a **URL‑prefix** property with `https://3jntravel.com`.
2. Pick a verification method, set the matching env var, **Redeploy**, then
   click **Verify**:

```bash
# Option A · meta tag (easiest) — copy just the token Google shows:
GOOGLE_SITE_VERIFICATION=ABC123theTokenGoogleGivesYou

# Option B · HTML file — set its exact filename:
GOOGLE_VERIFICATION_FILE=google1a2b3c.html
```

3. Once verified: Search Console → **Sitemaps** → submit `sitemap.xml`.
4. Optional — same on [Bing Webmaster Tools](https://www.bing.com/webmasters)
   with `BING_SITE_VERIFICATION`.

Submitting the sitemap is what tells Google your 500+ pages exist. New domains
take 8–16 weeks to rank; this starts that clock the day you do it.

### Step 3 — Post to your own communities ⚡ makes money · ~20 min · today

Your first 10–50 customers come from people who already trust *you*. Pick 3–5
WhatsApp / Facebook / association groups you're part of and share the page that
fits each. Ready‑to‑paste post:

```text
✈️ Planning a trip home or abroad? I built something for us.

3JN Travel OS finds the cheapest reliable flights + hotels and lets you PAY
MONTHLY — a small deposit, then spread the rest interest-free, with your price
locked in from day one.

What it does:
• Tell it "cheapest dates" and the AI scans a whole month for the lowest fare
• Instant visa approval check before you book anything
• Real, cancellable flight + hotel reservations for visa applications
• A travel eSIM so you land with data already working

Have a look — no sign-up needed to search:
👉 https://3jntravel.com

Flying to Lagos?  → https://3jntravel.com/flights/london-to-lagos
Heading to Accra? → https://3jntravel.com/destinations/accra
Home to Kingston? → https://3jntravel.com/destinations/kingston

Any questions, just ask me directly 🙏
```

**Match the link to the group:** UK–Nigeria → `/flights/london-to-lagos`; Ghana
→ `/destinations/accra`; Caribbean → `/destinations/kingston`. There are 339
route pages and 123 destination pages — one for almost everyone.

### Step 4 — Verified reviews ⏳ when you make your first sale

The review invite already fires on every booking confirmation; it just needs a
Trustpilot address to BCC.

```bash
TRUSTPILOT_AFS_EMAIL=yourcompany+xxxx@invite.trustpilot.com
# Later, once your profile shows real stars:
TRUSTPILOT_BUSINESS_UNIT_ID=your-business-unit-id
TRUSTPILOT_WIDGET=true
```

### Step 5 — Financial‑protection badge ⏳ before you scale flight sales

Selling flight‑inclusive packages to UK travellers **legally needs** financial
protection (ATOL, or a TTA / trust‑account arrangement). The badge is wired
everywhere already — it appears the moment you set a real scheme and **stays
hidden until you do**, so you never claim cover you don't hold.

```bash
MONEY_PROTECTION_SCHEME=ATOL
MONEY_PROTECTION_NUMBER=12345
MONEY_PROTECTION_URL=https://checkatol.caa.co.uk/
```

This one is legal, not optional. Until it's sorted, lean on the pages you can
sell now (hotels, visa reservations, eSIM) and get cover moving in parallel.

### Launch‑week live check (run from your browser — 60 seconds)

- `/api/health` → `build` reads the current version (`…feature-money-pages-v255`
  or later; older = your deploy is stale, redeploy).
- `/sitemap.xml` → loads and lists `/destinations/…`, `/flights/…`, `/blog/…`.
- `/blog` → shows 20 posts, incl. "Pay Monthly Flights" and "Price‑Lock
  Guarantee".
- `/why-3jn` → the trust page renders.

Do steps 1–3 this week — they're free and they're what actually starts customer
acquisition. Steps 4–5 slot in as you make your first sales and sort protection.

---

<a name="part-c--held-ticket--split-pay-runbook"></a>
## Part C — Held‑ticket / split‑pay runbook

Covers the two staged features behind the **`SPLIT_PAY_INSTANT_FARES`** flag:

1. **Flight‑secured split pay** — when a package's flight must be paid in full at
   booking (instant‑only fare) but the hotel is holdable, the flight is paid now
   (ticketed + **held**) and the hotel is spread over instalments.
2. **Auto‑secure when funded** — on a holdable instalment booking, the moment the
   customer's own payments cover the net fare, the ticket is **bought and held**
   (never 3JN's cash), releasing at a £0 balance.

Both are **OFF by default**; production behaviour is unchanged until you enable
the flag.

> **Golden rule:** a held ticket is *bought but not handed over*. It releases to
> the customer only when their balance reaches £0 — **or** if they cancel, in
> which case they keep the flight they've already paid for. No component is ever
> fulfilled beyond what has been paid for it.

### 0. Prerequisites (must already be live — see Part A)

These features issue **real airline tickets**, so the live payment + flight rails
must be on first. Confirm on `/api/admin/live-status` (Console → Admin → 🚦
Launch readiness check):

- [ ] **Stripe** live (`STRIPE_SECRET_KEY` = `sk_live_…`, webhook registered).
- [ ] **Duffel** live (live token, `liveFlightsEnabled` = true).
- [ ] **Hotelbeds** live (hotel key + secret) — for the split's hotel leg.
- [ ] **Durable persistence** ON (Firebase RTDB or Vercel KV) — held‑ticket state
      (`fulfilment.released`) must survive instance recycling.

If any are simulated, **stop** — a held ticket with no real Duffel order behind
it is meaningless. Finish Part A first.

### 1. Environment variables

Set on the backend deployment, then redeploy.

| Var | Value | Effect |
|-----|-------|--------|
| `SPLIT_PAY_INSTANT_FARES` | `true` | Master switch for BOTH held‑ticket features. Unset / anything else = off. |
| `AUTO_FRONT_CAP_GBP` | `0` (default) | How much 3JN cash may be fronted to secure a fare before the customer has covered it. **Keep `0`** — a ticket is then only ever auto‑bought once payments cover the net fare. |
| `SPLIT_HOTEL_CANCEL_CAP` | `100` (default) | Cap on the 20% hotel late‑cancel fee (applied only when a split's hotel is cancelled within 7 days of departure). |
| `LOCK_MARGIN_PCT` | `0.08` (default) | The 8% price‑guarantee margin (part of the 11% pay‑monthly uplift). Listed so you don't touch it by accident. |

**Rollback at any point:** set `SPLIT_PAY_INSTANT_FARES=false` (or unset) and
redeploy. New bookings revert immediately; **in‑flight held bookings are
unaffected** — a ticket already bought stays valid and still releases at £0.

### 2. Confirm the flag is live

- [ ] `GET /api/health` shows the current build.
- [ ] Build a search returning an **instant‑only flight + a hotel**. At checkout
      you should now see the green **"✈️ Flight secured now — hotel paid
      monthly"** card instead of the amber "paid in full at booking" card. Still
      amber = flag isn't live (check the var, confirm redeploy, hard‑refresh).

> Admin surfaces are header‑authed, not cookie‑authed — a URL in the browser bar
> returns 403. Use a DevTools console `fetch` with `x-user-id` (and `x-staff-pin`
> if set) to hit admin/status endpoints.

### 3. Test A — Split booking (instant flight + hotel)

Use a **real card you control**; departure ~30–60 days out.

1. [ ] Search instant‑only flight + hotel; open checkout; confirm the split card
       shows **flight today** + **hotel spread** summing to the total.
2. [ ] Choose **"Pay the flight now + hotel monthly"** and pay — the Stripe
       charge should be the **flight portion only**.
3. [ ] **Verify the flight is really ticketed:** Console shows **"Flight ticketed
       · e‑ticket held until £0 balance"** (button disabled); a real Duffel order
       with a PNR exists.
4. [ ] **Verify the e‑ticket is withheld:** click the held button /
       `GET /api/book/<id>/document` → the **"held on your account"** notice, NOT
       the e‑ticket. Confirm the real ticket number is NOT in the response.
5. [ ] **Pay the remaining hotel instalments** ("pay early"). On the final
       payment: booking flips to **released** (e‑ticket renders in full), the
       **hotel is booked** (Hotelbeds confirmation), and the confirmation
       email/PDF is sent.

**Money check:** the flight charge should be **≥ the airline fare 3JN paid
Duffel**. On Admin → 🔒 Lock exposure, `frontedGbp` for this booking is **0**.

### 4. Test B — Auto‑secure when funded (holdable flight, instalments)

Use a **holdable** fare (normal 20% deposit + instalments).

1. [ ] Book with the standard **20% deposit**; confirm the 11% pay‑monthly uplift
       + instalment schedule.
2. [ ] Right after deposit, booking is **"price locked"** — Duffel has **no**
       order yet, `fulfilment.ticketing = lock-scheduled`.
3. [ ] **Pay instalments until cumulative payments ≥ net fare cost.** The moment
       they do (offer still live), the agent should **buy the ticket** (real
       Duffel order, `ticketing = issued`, `securedEarly = true`,
       `released = false`), push **"Your flight is secured"**, and keep the
       e‑ticket **held**.
4. [ ] **Pay remaining balance to £0** → e‑ticket **releases** (full document +
       email).

> **Expected on long plans:** if the original Duffel offer has **expired** by the
> time payments cover the fare (normal on 90‑day plans), the agent will **not**
> auto‑buy — it stays `lock-scheduled` and an ops "secure the flight" work‑order
> is raised. That's the safe fallback, not a bug. Auto‑buy fires cleanly for
> short‑dated bookings and fast payers.

**Money check:** before the ticket is bought, `frontedGbp` should never be
non‑zero (with `AUTO_FRONT_CAP_GBP=0`).

### 5. Test C — Abandonment paths (do NOT skip)

**C1 — Split, customer cancels the hotel (flight paid):**
1. [ ] Create a split booking; pay the flight (ticket held).
2. [ ] Cancel → preview reads *"Flight paid and ticketed — you keep it… hotel
       cancelled…"*.
3. [ ] Confirm: flight **e‑ticket released** (they keep it); **hotel not booked**
       (only reserved) — no supplier loss; if within **7 days** of departure a
       **20% hotel fee (capped £100)** is deducted from hotel instalments paid,
       otherwise refunded in full.

**C2 — Auto‑default (missed instalments past grace):**
1. [ ] Let an instalment lapse past grace (or trigger the sweep in a test window).
2. [ ] Daily sweep marks the booking cancelled‑default, **releases the held
       flight** (they covered the fare), applies the split late‑cancel fee if
       within 7 days, refunds per policy.

**C3 — Ticketing failure safety net:**
1. [ ] A Duffel order failure on a funded booking must **not** refund it away —
       it falls back to `lock-scheduled` + an ops work‑order. A paid, unticketed
       customer is never stranded.

### 6. Monitoring while live

- **Admin → 🔒 Lock exposure** — `frontedGbp` should stay **0** across the
  portfolio. Non‑zero with `AUTO_FRONT_CAP_GBP=0` = investigate immediately.
- **Audit log** — watch `ticketing.secured-early`, `ticketing.released`,
  `ticketing.issued … HELD`, `ticketing.lock-scheduled`.
- **Ops queue** — `ops-secure-flight` work‑orders (expected fallback for long
  plans whose offer expired) should be worked before departure.
- **Held‑but‑overdue** — a booking `issued + released:false` near departure with
  a non‑£0 balance needs a decision (chase payment, or release+cancel per policy).

### 7. Rollback

1. `SPLIT_PAY_INSTANT_FARES=false` (or unset) on the backend; redeploy.
2. New instant fares → pay‑in‑full; new holdable fares → lock‑scheduled securing.
3. **Do not** delete `fulfilment.released` on existing bookings — held tickets in
   flight must still release at £0 (release logic keys off that flag regardless
   of the master switch).

### Appendix — where held‑ticket logic lives

| Concern | Location |
|--------|----------|
| Split plan builder + late‑cancel fee + split refund | `backend/src/instalments.js` (`buildFlightSecuredSplit`, `splitHotelCancelFee`, `refundOutcome`) |
| Plan selection (split vs pay‑in‑full) | `backend/src/server.js` `smartPlanForRequest` + `flightLocalShare` |
| Auto‑secure‑when‑funded + held issue/release | `backend/src/server.js` `autoTicketFlight`, `releaseHeldTicket`, `flightPortionFunded` |
| "Buy when payments cover the fare" decision | `backend/src/pricelock.js` `flightSecuringPlan` (front cap `AUTO_FRONT_CAP_GBP`) |
| Held e‑ticket withheld server‑side | `backend/src/server.js` `GET /api/book/:id/document` |
| Cancel / auto‑default release | `backend/src/server.js` cancel endpoint; `backend/src/store.js` default sweep |
| Checkout + Console UI | `frontend/app.js` (split checkout card, held e‑ticket button) |
| Tests | `backend/test/pipeline.test.js` (split math, `/api/quote` gating, refund, held‑document) |

---

<a name="part-d--architecture--stack-strategy"></a>
## Part D — Architecture & stack strategy

**Locked recommendation:** Claude Build → GitHub → **Vercel frontend → Firebase
backend** first; Hostinger domain; add **Neon/Postgres (or Cloud SQL) later** for
heavy relational data — the booking ledger, finance/reporting, corporate travel,
and VisaOS decision records.

```
Claude Build → GitHub (repo: jnnseya-cpu/3jn-travelos · deploy branch: main)
   → Vercel frontend (static SPA + serverless Express via api/index.js)
   → Firebase (Auth · Firestore/RTDB · Storage · Cloud Functions)
   → Stripe (payments) · AI Gateway (Claude/OpenAI/Gemini)
   → Hostinger domain
```

**Why Firebase first:** it gives the fast‑MVP backend in one place — auth,
database, storage, cloud functions, realtime sync — everything the first version
needs quickly (login, profiles, ACU wallet, bookings, documents, uploads,
notifications, admin dashboard, AI usage logs, payment events, realtime status).
`backend/src/persistence.js` already snapshots/hydrates the whole store to
Firebase RTDB when credentials are present (credential‑gated, no‑op offline).

**Why not Vercel + Neon only at launch:** Neon's serverless Postgres is excellent
for structured business data but gives you no auth, storage, notifications or
realtime out of the box — all of which a fast travel‑OS launch needs immediately.

**Phased plan (locked):**

- **Phase 1 — MVP / go live:** Hostinger + Vercel + Firebase + Stripe + AI APIs.
- **Phase 2 — commercial platform:** add **Neon/Postgres (or Cloud SQL)** for the
  ACU ledger, payment reconciliation, booking accounting, supplier commissions,
  corporate travel, visa decisions, fraud/risk logs, audit trail.
- **Phase 3 — enterprise / VisaOS:** Firebase for speed · Postgres for governance
  · BigQuery/warehouse for analytics; critical decision records in structured SQL.

**Hybrid target architecture:**

| Layer | Technology | Responsibility |
|---|---|---|
| Frontend | **Vercel** | static SPA + landing pages + serverless API |
| App backend | **Firebase** (or Cloud Run/Functions) | auth, realtime app data, storage, notifications |
| System of record | **Neon / Cloud SQL Postgres** (phase 2) | financial ledger, booking records, reporting, VisaOS decisions, audit logs |
| Payments | **Stripe** | cards, wallets, subscriptions, deposits |
| Intelligence | **AI Gateway** | Claude/OpenAI/Gemini agents (`backend/src/ai-gateway.js` — model router, budgets, cost ledger) |

**Migration path to Postgres (phase 2).** The in‑memory store is intentionally
swappable (`backend/src/store.js` header). Tables that graduate first:

1. `bookings` + `payments` + `refundPolicy` → booking ledger (`db.bookings`)
2. `acu_wallets` / `acu_transactions` / `ai_request_costs` → finance & AI cost
   reporting (`db.acuTxns`, `db.aiRequestCosts`)
3. `search_deposits` → deposit ledger (`db.searchDeposits`)
4. VisaOS applications, decisions, hash‑chained audit trail → `db.visaApps`,
   `db.visaChain`
5. `audit` → append‑only audit table
6. Corporate travel approvals, policies, invoices → `db.approvals` + corporate plans

For heavy document storage, sensitive visa files, identity verification and
government‑grade compliance, prefer the Google Cloud stack (Cloud Run + Cloud
Storage + Cloud SQL) over Neon as the long‑term primary backend.

---

<a name="appendix--env-var-reference"></a>
## Appendix — env‑var reference

| Variable | Turns on | When |
| --- | --- | --- |
| `LIVE_MODE` | Production mode (no free AI / demo affordances) | Go‑live |
| `STAFF_ACCESS_PIN` | Privileged/admin access second factor | Before `LIVE_MODE` |
| `HUMAN_CHECK_SECRET` | Signs sign‑up/login challenge tokens | Before `LIVE_MODE` |
| `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` | Real card checkout + fulfilment | Go‑live |
| `DUFFEL_TOKEN` | Live flights + auto‑ticketing | Go‑live |
| `FIREBASE_SERVICE_ACCOUNT` + `FIREBASE_DATABASE_URL` | Durable persistence | Go‑live |
| `SMTP_PASS` | Email capture, welcome, alerts, confirmations | Now |
| `GOOGLE_SITE_VERIFICATION` | Google Search Console (meta method) | Now |
| `GOOGLE_VERIFICATION_FILE` | Google Search Console (file method) | Now — alt to above |
| `BING_SITE_VERIFICATION` | Bing Webmaster Tools | Optional |
| `TRUSTPILOT_AFS_EMAIL` | Verified review invites after booking | First sale |
| `TRUSTPILOT_WIDGET` | Live star widget (once stars exist) | Later |
| `MONEY_PROTECTION_SCHEME` + `MONEY_PROTECTION_NUMBER` | ATOL/TTA protection badge sitewide | When certified |
| `SPLIT_PAY_INSTANT_FARES` | Held‑ticket / split‑pay features (Part C) | When flight rails live |
| `AUTO_FRONT_CAP_GBP` | Cash 3JN may front to secure a fare (keep `0`) | With Part C |
