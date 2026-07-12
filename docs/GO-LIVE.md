# 3JN Travel OS — Go‑Live Checklist

The OS is **fail‑closed by design**: every live integration is credential‑gated, so
with no keys set it runs the safe simulated flow and nothing charges a real card
or issues a real ticket. Going live is a matter of setting the right environment
variables **in matched sets** and flipping the master switch. Set these on the
backend deployment (Cloud Run / the API host), not the static frontend.

## 1. Master switch

| Var | Value | Effect |
|-----|-------|--------|
| `LIVE_MODE` | `true` | Removes every demo/free‑AI affordance: guests get cached results only, all AI actions are ACU‑funded, and demo/admin surfaces fail closed unless the staff PIN is set **and** supplied. |

## 2. Staff access (REQUIRED before `LIVE_MODE=true`)

| Var | Notes |
|-----|-------|
| `STAFF_ACCESS_PIN` | Second factor for every privileged (admin/embassy/consulate) area and the demo‑account surfaces. Without it, privileged **login** fails closed (good), but set it so your own staff can actually get in. Use a long random value; rotate on staff change. |
| `HUMAN_CHECK_SECRET` | Signs the sign‑up/login human‑challenge tokens. Set a random secret in production so challenges can't be forged. |

## 3. Payments — Stripe (set BOTH or neither)

| Var | Notes |
|-----|-------|
| `STRIPE_SECRET_KEY` | `sk_live_…`. Enables real Checkout for booking payments **and** ACU/membership purchases (both credited only by the signed webhook). |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` for the `/api/pay/stripe/webhook` endpoint. **Without it every incoming webhook is rejected**, so payments would capture but never fulfil. Configure the webhook endpoint in the Stripe dashboard to POST `checkout.session.completed` to `https://<api-host>/api/pay/stripe/webhook`. |

Test‑mode dry run: `STRIPE_SECRET_KEY=sk_test_…` + `ALLOW_TEST_PAYMENTS=true` lets you
exercise the full pay → webhook → ticket flow without live cards. Remove
`ALLOW_TEST_PAYMENTS` for production.

## 4. Flights — Duffel (the ticketing engine)

| Var | Notes |
|-----|-------|
| `DUFFEL_TOKEN` | A **test** token (`duffel_test_…`) issues test orders; a **live** token issues real tickets. Live flights + auto‑ticketing only run when this is set. |
| `DUFFEL_STAYS` | Defaults on when Duffel is enabled; set `false` to disable Stays auto‑booking and hand hotels to the ops desk. Uses the **same** `DUFFEL_TOKEN`. |
| `DUFFEL_VERSION` / `DUFFEL_BASE_URL` | Optional overrides; defaults are correct for current Duffel. |

## 5. Persistence — Firebase RTDB (so data survives a restart)

| Var | Notes |
|-----|-------|
| `FIREBASE_SERVICE_ACCOUNT` | JSON service‑account credential (or use `GOOGLE_APPLICATION_CREDENTIALS`). |
| `FIREBASE_DATABASE_URL` | RTDB URL. Both are needed for the store to hydrate on boot and flush on write/shutdown. Without them the store is in‑memory only and **resets on every redeploy/scale event**. |

## 6. Email / notifications (recommended)

Set SMTP so ticket confirmations and refunds actually reach customers. The mailer
turns on as soon as **`SMTP_PASS`** is set; `SMTP_HOST` defaults to `smtp.hostinger.com`
and `SMTP_PORT` to `465` (SSL) — override `SMTP_HOST`/`SMTP_PORT`/`SMTP_FROM` for a
different provider. No `SMTP_PASS` = confirmations are logged only, not sent.

## 7. Optional supplier channels (each independent, fail‑closed)

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

## 8. Pre‑flight verification

1. `cd backend && npm test` — the full suite must be green.
2. With test keys, run one booking end‑to‑end: search → book → pay (Stripe test
   card) → confirm the webhook issues a Duffel test order and the customer gets a
   PNR + e‑ticket in the Console.
3. Confirm a **refund path**: force a ticketing failure and verify the Stripe
   refund fires and an ops ticket is raised.
4. Confirm **persistence**: redeploy and check bookings/users survived.
5. Flip `LIVE_MODE=true`, swap to live keys, and repeat step 2 with a real low‑value
   fare before advertising.

## Minimal live set (the shortest path to real bookings)

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

## Curated Deals — sell real products on day one (no supplier API needed)

The fastest path to revenue when live supplier feeds aren't connected yet: the
**Curated Deals** catalogue. These are real packages your team publishes at a
real, all-in price you fulfil through your agent network.

1. Sign in as an owner/admin → **Admin → Manage deals → ＋ New deal**. Enter a
   title, a real GBP price, what's included, and an internal fulfilment note
   (how your team books it — never shown to customers). Publish.
2. Customers see them under **Deals** and book:
   - With `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` set → self-serve **card
     checkout**; on payment the order lands in the **Ops Fulfilment Desk** and
     the customer is emailed a confirmation.
   - Without Stripe yet → the buy button takes a **reservation**; your team is
     emailed to collect payment and confirm. Nothing is fulfilled until paid.
3. Fulfil each paid order from the ops queue (manual now). When you later
   connect a live door (Duffel etc.), the same order path is ready to auto-fulfil.

Curated deals are `priceBasis: 'confirmed'` — a real committed price — so they
are payable exactly like a live fare. The AI estimator stays clearly labelled
"estimate" and funnels searchers into these deals + the exact-quote flow.
