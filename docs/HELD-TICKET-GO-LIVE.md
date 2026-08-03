# Held-Ticket Payments — Go-Live Runbook

Covers the two staged features behind the **`SPLIT_PAY_INSTANT_FARES`** flag:

1. **Flight-secured split pay** — when a package's flight must be paid in full at
   booking (instant-only fare) but the hotel is holdable, the flight is paid now
   (ticketed + **held**) and the hotel is spread over instalments.
2. **Auto-secure when funded** — on a holdable instalment booking, the moment the
   customer's own payments cover the net fare, the ticket is **bought and held**
   (never 3JN's cash), releasing at a £0 balance.

Both are **OFF by default**. Production behaviour is unchanged until you enable
the flag. This runbook takes you from off → verified live, with a rollback at
every step.

> **Golden rule:** a held ticket is *bought but not handed over*. It releases to
> the customer only when their balance reaches £0 — **or** if they cancel, in
> which case they keep the flight they've already paid for. No component is ever
> fulfilled beyond what has been paid for it.

---

## 0. Prerequisites (must already be live)

These features issue **real airline tickets**, so the live payment + flight rails
must be on first. Confirm on `/api/admin/live-status` (or the Console → Admin →
🚦 Launch readiness check):

- [ ] **Stripe** live (`STRIPE_SECRET_KEY` = `sk_live_…`, webhook registered at
      `/api/pay/stripe/webhook`).
- [ ] **Duffel** live (`DUFFEL_ACCESS_TOKEN` live, `liveFlightsEnabled` = true).
- [ ] **Hotelbeds** live (hotel key + secret) — for the split's hotel leg.
- [ ] **Durable persistence** ON (Firebase RTDB or Vercel KV) — held-ticket state
      (`fulfilment.released`) must survive instance recycling.

If any of these are simulated, **stop** — a held ticket with no real Duffel order
behind it is meaningless. Get the base go-live done first (`docs/GO-LIVE.md`).

---

## 1. Environment variables

Set on the **backend** deployment (the API host / Vercel project), then redeploy.

| Var | Value | Effect |
|-----|-------|--------|
| `SPLIT_PAY_INSTANT_FARES` | `true` | Master switch for BOTH held-ticket features. Unset / anything else = off. |
| `AUTO_FRONT_CAP_GBP` | `0` (default) | How much 3JN cash may be fronted to secure a fare before the customer has covered it. **Keep `0`** unless you deliberately want 3JN to front cash — with `0`, a ticket is only ever auto-bought once payments cover the net fare. |
| `SPLIT_HOTEL_CANCEL_CAP` | `100` (default) | Cap on the 20% hotel late-cancel fee (applied only when a split's hotel is cancelled within 7 days of departure). |
| `LOCK_MARGIN_PCT` | `0.08` (default) | The 8% price-guarantee margin (part of the 11% pay-monthly uplift). Unchanged by these features; listed so you don't touch it by accident. |

**Rollback at any point:** set `SPLIT_PAY_INSTANT_FARES=false` (or unset) and
redeploy. New bookings immediately revert to pay-in-full for instant fares and
lock-scheduled securing for holdable fares. **In-flight held bookings are
unaffected** — a ticket already bought stays valid and still releases at £0.

---

## 2. Confirm the flag is live

After redeploy:

- [ ] `GET /api/health` shows the current build (`…-auto-secure-when-funded-v240`
      or later).
- [ ] Build a search that returns an **instant-only flight + a hotel** (a fare
      the airline won't hold). At checkout you should now see the green
      **"✈️ Flight secured now — hotel paid monthly"** card instead of the amber
      "This fare is paid in full at booking" card. If you still see the amber
      card, the flag isn't live (check the var, confirm the redeploy, hard-refresh).

> Tip: admin surfaces are header-authed, not cookie-authed — a URL in the browser
> bar returns 403. Use a DevTools console `fetch` with `x-user-id` (and
> `x-staff-pin` if set) to hit admin/status endpoints.

---

## 3. Test A — Split booking (instant flight + hotel)

Use a **real card you control**. Pick a departure **~30–60 days out** so the plan
has a real instalment schedule but a short tail you can pay off quickly.

1. [ ] Search an instant-only flight + hotel; open checkout; confirm the split
       card shows **flight amount today** + **hotel spread** figures that sum to
       the total.
2. [ ] Choose **"Pay the flight now + hotel monthly"** and pay. The Stripe charge
       should be the **flight portion only**.
3. [ ] **Verify the flight is really ticketed:** Console → the booking shows
       **"Flight ticketed · e-ticket held until £0 balance"** (button disabled).
       In Duffel, a real order exists with a PNR.
4. [ ] **Verify the e-ticket is withheld:** click the held button / hit
       `GET /api/book/<id>/document` — you should get the **"held on your account"**
       notice, **not** the e-ticket. Confirm the real ticket number is NOT in the
       response.
5. [ ] **Pay the remaining hotel instalments** (use "pay early"). On the final
       payment:
       - [ ] The booking flips to **released** — the e-ticket document now renders
             in full (PNR + ticket number).
       - [ ] The **hotel is booked** with the supplier (Hotelbeds confirmation
             appears).
       - [ ] The full booking-confirmation email/PDF is sent.

**Money check:** the flight charge you took should be **≥ the airline fare 3JN
paid Duffel** (it's the flight's cost-proportional share of the all-in total,
which always sits above the raw fare because commission is on top). Confirm on
Admin → 🔒 Lock exposure that `frontedGbp` for this booking is **0**.

---

## 4. Test B — Auto-secure when funded (holdable flight, instalments)

Use a **holdable** fare (one that *doesn't* show the split card — normal 20%
deposit + instalments). Pick a departure far enough out to get a multi-instalment
plan, but be ready to pay it down.

1. [ ] Book with the standard **20% deposit**; confirm the plan shows the 11%
       pay-monthly uplift and the instalment schedule.
2. [ ] Right after the deposit, the booking should be **"price locked"** (fare not
       yet funded) — Duffel has **no** order yet, `fulfilment.ticketing =
       lock-scheduled`.
3. [ ] **Pay instalments until cumulative payments ≥ the net fare cost.** The
       moment they do (and the offer is still live), the agent should:
       - [ ] **Buy the ticket** — a real Duffel order appears, `ticketing =
             issued`, `securedEarly = true`, `released = false`.
       - [ ] Push the customer **"Your flight is secured"** and keep the e-ticket
             **held** (document endpoint returns the held notice).
4. [ ] **Pay the remaining balance to £0** → e-ticket **releases** (full document
       + email).

> **Expected on long plans:** if the original Duffel offer has **expired** by the
> time payments cover the fare (normal on 90-day plans), the agent will **not**
> auto-buy — it stays `lock-scheduled` and an ops "secure the flight" work-order
> is raised to secure within the locked price + 8% margin. That's the safe
> fallback, not a bug. Auto-buy fires cleanly for **short-dated bookings and fast
> payers**, where the offer is still live when funding lands.

**Money check:** at no point before the ticket is bought should `frontedGbp` be
non-zero (with `AUTO_FRONT_CAP_GBP=0`). The ticket is only ever bought with the
customer's own money.

---

## 5. Test C — Abandonment paths (do NOT skip)

Use throwaway bookings you're willing to cancel.

**C1 — Split, customer cancels the hotel (flight paid):**
1. [ ] Create a split booking; pay the flight (ticket held).
2. [ ] Cancel via Console → the cancel **preview** should read *"Flight paid and
       ticketed — you keep it… hotel cancelled…"*.
3. [ ] Confirm the cancel. Verify:
       - [ ] The **flight e-ticket is released** to the customer (they keep it).
       - [ ] The **hotel is not booked** (it was only reserved) — no supplier loss.
       - [ ] If cancelled **within 7 days** of departure: a **20% hotel fee
             (capped £100)** is deducted from any hotel instalments paid. Outside
             7 days: hotel money refunded in full.

**C2 — Auto-default (missed instalments past grace):**
1. [ ] On a held booking (split or auto-secured), let an instalment lapse past the
       grace window (or trigger the sweep in a test window).
2. [ ] Verify the daily sweep:
       - [ ] Marks the booking cancelled-default.
       - [ ] **Releases the held flight** to the customer (they covered the fare).
       - [ ] Applies the split late-cancel fee if within 7 days; refunds per policy.

**C3 — Ticketing failure safety net:**
1. [ ] (If you can force it) a Duffel order failure on a funded booking should
       **not** refund the funded booking away — it falls back to `lock-scheduled`
       + an ops work-order. A paid, unticketed customer is never stranded.

---

## 6. Monitoring while live

- **Admin → 🔒 Lock exposure** — `frontedGbp` should stay **0** across the
  portfolio. Any non-zero value means 3JN cash is committed ahead of payment;
  with `AUTO_FRONT_CAP_GBP=0` it should never happen — investigate immediately.
- **Audit log** — watch for `ticketing.secured-early`, `ticketing.released`,
  `ticketing.issued … HELD`, and `ticketing.lock-scheduled`.
- **Ops queue** — `ops-secure-flight` work-orders are the expected fallback for
  long plans whose offer expired; they should be worked before departure.
- **Held-but-overdue** — a booking `issued + released:false` whose departure is
  near but balance isn't £0 needs a decision (chase payment, or release+cancel
  hotel per policy).

---

## 7. Rollback

1. Set `SPLIT_PAY_INSTANT_FARES=false` (or unset) on the backend; redeploy.
2. New instant fares → pay-in-full; new holdable fares → lock-scheduled securing.
3. **Do not** delete `fulfilment.released` on existing bookings — held tickets in
   flight must still release at £0. The release logic keys off that flag
   regardless of the master switch.

---

## Appendix — where it lives in the code

| Concern | Location |
|--------|----------|
| Split plan builder + late-cancel fee + split refund | `backend/src/instalments.js` (`buildFlightSecuredSplit`, `splitHotelCancelFee`, `refundOutcome`) |
| Plan selection (split vs pay-in-full) | `backend/src/server.js` `smartPlanForRequest` + `flightLocalShare` |
| Auto-secure-when-funded + held issue/release | `backend/src/server.js` `autoTicketFlight`, `releaseHeldTicket`, `flightPortionFunded` |
| "Buy when payments cover the fare" decision | `backend/src/pricelock.js` `flightSecuringPlan` (front cap `AUTO_FRONT_CAP_GBP`) |
| Held e-ticket withheld server-side | `backend/src/server.js` `GET /api/book/:id/document` |
| Cancel / auto-default release | `backend/src/server.js` cancel endpoint; `backend/src/store.js` default sweep |
| Checkout + Console UI | `frontend/app.js` (split checkout card, held e-ticket button) |
| Tests | `backend/test/pipeline.test.js` (split math, `/api/quote` gating, refund, held-document) |
