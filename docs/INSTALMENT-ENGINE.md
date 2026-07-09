# AI Smart Instalment Payment Engine

**Flexible. Fair. Protected.** — implemented in `backend/src/instalments.js`,
enforced in `backend/src/store.js` (`enforceInstalments`), wired at
`/api/quote`, `/api/book`, `/api/instalments/preview` and
`/api/admin/instalments/enforce`.

## Core principles

- Lower deposit + more instalments for customers booking far in advance.
- Higher deposit + fewer instalments for last-minute bookings.
- Final payment is **always due no later than 7 days before departure**.
- All deposits are **strictly non-refundable** once the booking is confirmed —
  the deposit secures the booking, locks the fare (where applicable), reserves
  supplier inventory and covers processing/payment/admin costs.
- Customers may pay the remaining balance **at any time without penalty**.
- The AI automatically selects the best eligible plan from departure date,
  supplier rules, booking value and customer risk profile.

## The ten plans (by days before departure)

| Band | Plan | Deposit | Instalments |
|---|---|---|---|
| 181+ | Ultimate Flex | 10% | 150d 15% · 120d 15% · 90d 15% · 60d 15% · 30d 15% · **7d 15%** |
| 121–180 | Premium Flex | 15% | 90d 20% · 60d 20% · 30d 20% · **7d 25%** |
| 91–120 | Smart Plan | 20% | 60d 25% · 30d 25% · **7d 30%** |
| 61–90 | Easy Plan | 30% | 30d 30% · **7d 40%** |
| 46–60 | Express Plan | 40% | 21d 30% · **7d 30%** |
| 31–45 | Quick Plan | 50% | 14d 25% · **7d 25%** |
| 22–30 | Priority Plan | 60% | **7d 40%** |
| 15–21 | Last-Minute Flex | 75% | **7d 25%** |
| 8–14 | Rapid Plan | 90% | **7d 10%** |
| 0–7 | Instant Booking | 100% | none — full payment at booking |

Every band sums to exactly 100%; the final instalment absorbs rounding so the
schedule always equals the booking total to the penny. The plan is re-derived
at booking time, so a stale quote books on the CURRENT date band.

## Commercial protection rules

- Deposit 100% non-refundable once the booking is confirmed.
- Missed instalment → AI-managed grace period (default **48h**, configurable
  via `INSTALMENT_GRACE_HOURS`), with an automatic customer warning.
- Still unpaid after grace → the booking **auto-cancels**, the deposit is
  forfeited, and any refundable balance (paid minus deposit) is calculated per
  the supplier cancellation policy attached to the booking.
- Early/extra payments accepted any time before the final due date.

## AI Risk-Based Instalment Engine

Evaluated per customer before a plan is offered (`assessInstalmentRisk`):
payment history, identity verification, fraud/chargeback record, booking
value, destination & supplier risk, time to departure, product type, previous
cancellations and no-shows.

Automatic adjustments:

- **High risk** → deposit +15pp, instalments capped at 2, extra ID check.
- **Medium risk** → deposit +5pp, instalments capped at 4.
- **Trusted repeat customers** (3+ paid bookings, clean record) → deposit
  −5pp, floored at the 10% supplier minimum.
- **Declined** (score ≥60, e.g. chargeback history + guest checkout) →
  instalments unavailable; Instant Booking (100%) only.

## Operational notes

- `GET /api/instalments/preview?depart=YYYY-MM-DD&total=1234` — the plan a
  given departure date earns, with the caller's own risk profile applied.
- `POST /api/admin/instalments/enforce` — runs the grace/default sweep
  (production: run on a daily scheduler).
- Instalment-held flight fares: Duffel fares are HELD at deposit and the
  e-ticket is issued automatically on final payment (existing behaviour).
