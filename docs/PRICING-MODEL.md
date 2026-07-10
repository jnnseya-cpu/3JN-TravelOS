# 3JN Tiered Take-Rate — how we lead on price WITHOUT killing margin

## The problem it solves

A 10% fee on a flights-only booking loses every Skyscanner comparison —
10% of a booking that never happens is £0. Meanwhile the big OTAs all run
flights at ~zero margin as customer acquisition and earn on everything else.

## The model

| Basket | 3JN take | Why |
|---|---|---|
| **Flights only** | **flat £4.99** (`FLIGHT_ONLY_FEE_GBP`) — **FREE for active Travel+ members** | Level with metasearch prices; the flight becomes break-even customer acquisition (the fee covers Duffel's ~£2.20 + 1%). |
| Hotels, packages, extras | **10%** (`COMMISSION_RATE`) | Where the margin genuinely lives, inside bundles that beat DIY totals. |
| Ancillaries, insurance, eSIM, transfers, visa, ACU/AI, membership | supplier commissions & markups | High-margin attach on the customer the flight acquired. |

The switch is automatic: a basket whose priced components are all flights
gets the flat fee (`pricing.feeModel = 'flight-flat'` /
`'flight-flat-member-free'`); anything else keeps `'commission-10'`.
The breakdown table, Price-check box and benchmark all state which model
applied — no hidden fees, ever.

## Partner / affiliate economics (protects them AND us)

Partners are paid from what 3JN **actually earns** — the industry standard
(Booking.com pays affiliates 25–40% of ITS commission, never of booking value):

- **Packages/hotels/extras**: unchanged — 3–4% of sale carved from our 10%.
- **Flights-only**: `FLIGHT_ONLY_PARTNER_SHARE` (40%) of the flat flight fee
  (~£2/ticket). Structurally, no sale can ever pay out more than it brings in.
- **Lifetime attribution**: the partner who brings a customer is stored on
  the customer (`user.attributedVendor`, set on the first attributed paid
  booking). Every future booking — including the £1,200 package next Easter —
  credits that partner at the full carve, with no code needed. "Bring us a
  customer once, earn on everything they ever book."

Influencer revenue-share needs no change: it already accrues from
`pricing.revenue.commissionUSD`, which now reflects the true take per basket.

## Price-Match Promise (the trust weapon)

Shown on every result: find the exact trip cheaper **like-for-like** (same
flights, same dates, one protected booking) within 24h of booking → we match
it and credit the difference in ACU. Like-for-like matches are rare (most
"cheaper" fares are self-transfer hacks or wrong-airport routings — the
Market Benchmark proves it), so the promise costs little and converts
first-time customers a new brand can't win any other way.

## Changing the numbers

All three levers are constants in `shared/constants.js`:
`FLIGHT_ONLY_FEE_GBP` (4.99) · `FLIGHT_ONLY_MEMBER_FREE` (true) ·
`FLIGHT_ONLY_PARTNER_SHARE` (0.40). One-line edits, fully test-covered.
