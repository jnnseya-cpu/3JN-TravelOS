# Travelfusion Partner Application — 3JN Travel OS

> Purpose: apply to Travelfusion for bookable low-cost-carrier (LCC) content —
> Ryanair, easyJet, Jet2, Wizz, Vueling — to close the price gap on European
> short-haul where Duffel's NDC fares sit ~£45pp above consolidator fares, and
> to unlock Ryanair/Jet2 which Duffel does not sell at all.
>
> Fields marked **[FILL]** need the operator's real figures before sending —
> do not send placeholders to the supplier.

---

## Where to apply

- Travelfusion sales enquiry: https://www.travelfusion.com (Contact / Partner enquiry)
- Ask specifically for: **the Flight API (XML), with LCC content enabled for
  Ryanair, easyJet, Jet2, Wizz Air and Vueling**, UK point of sale, GBP.
- Parallel option (do both): **Ryanair Approved-OTA programme**
  (https://www.ryanair.com/gb/en/corporate/approved-ota) — Ryanair's own
  channel; Travelfusion is one accredited route into it.

---

## Draft enquiry email

**Subject:** Flight API partner application — 3JN Travel OS (UK OTA, LCC content)

Hello Travelfusion team,

We are 3JN Travel OS, a UK-based online travel platform focused on the African
and global diaspora market. We currently ticket flights and hotels live through
Duffel and Stripe, and we are looking to add a low-cost-carrier content source
to serve European short-haul routes competitively.

We would like to apply for your Flight API with the following content enabled:

- **Carriers:** Ryanair, easyJet, Jet2, Wizz Air, Vueling (and your wider LCC set)
- **Point of sale:** United Kingdom, currency GBP
- **Model:** we are the merchant of record; we take payment from the traveller
  via Stripe and pay the fare through your API (agency pay / card pass-through —
  whichever you support for these carriers)

About us:

- **Company:** [FILL: registered company name]
- **Registration / country:** [FILL: company number, UK]
- **Website:** https://3jntravel.com  (API host: https://api.3jntravel.com)
- **Live since:** [FILL: launch date]
- **Current suppliers:** Duffel (flights + Stays), Stripe (payments),
  Hotelbeds (hotels, in certification), Airalo (eSIM)
- **Expected monthly flight volume (first 6 months):** [FILL: honest estimate,
  e.g. 50–200 segments/month ramping] — do not overstate; they credit-check
- **Primary routes:** UK ⇄ Western Europe (Paris, Barcelona, Rome, Milan,
  Brussels), plus UK ⇄ Africa connections
- **Technical readiness:** Node.js backend, we already run live NDC (Duffel)
  and can consume your XML/SOAP API; we can complete certification quickly

Please let us know:

1. The commercial terms and any deposit / prefunding requirement
2. Whether Ryanair and easyJet content is available on our UK POS
3. The certification steps and test credentials to begin integration
4. The payment model per carrier (agency pay vs. traveller card pass-through)

Thank you — we're ready to start certification as soon as you can enable a test
account.

Best regards,
[FILL: name]
3JN Travel OS
[FILL: phone] · jnbankwa@gmail.com

---

## What they will ask for (prepare these now)

| Item | Status | Note |
|---|---|---|
| Registered company + number | **[FILL]** | UK Ltd expected |
| Proof of trading / website | ✅ | 3jntravel.com is live |
| Expected volumes | **[FILL]** | Be honest — they credit-check |
| Payment / prefunding capacity | **[FILL]** | Some LCC content needs a deposit float |
| Technical contact | **[FILL]** | For certification |
| PCI / card handling | ✅ (Stripe) | We never store PANs |

---

## Integration plan (engineering) — after they issue test credentials

Travelfusion is an **XML/SOAP** API, distinct from the existing Kiwi Tequila
REST adapter. The work is a new adapter mirroring the Duffel/Tequila contract so
the rest of the pipeline is unchanged.

1. **Auth** — `LoginRequest` → session; store `TRAVELFUSION_LOGIN_ID` +
   `TRAVELFUSION_PASSWORD` in Vercel env (new keys, not `TEQUILA_API_KEY`).
2. **Search** — `FlightSearchRequest` (async: start → poll `FlightSearchResults`).
   Normalise each itinerary to our flight-offer shape via a
   `normalizeTravelfusionItinerary()` (contract identical to
   `normalizeDuffelOffer` / `normalizeTequilaItinerary`, incl. per-segment legs,
   baggage truthfully labelled, `requiresInstantPayment`).
3. **Price re-check** — `FlightDetailsRequest` before charging (the LCC
   equivalent of `validateDuffelOffer` — never charge a stale fare).
4. **Book** — `FlightBookingStartRequest` → `FlightBookingConfirmRequest`,
   returning the airline PNR + ticket; feed it into the existing booking record
   so documents/notifications fire exactly like Duffel.
5. **Wire in** — add the fetch to `fetchLiveFlights`'s concurrent task list and
   let the existing rank-and-merge pick the cheapest reliable fare. Because the
   ranking already tags/keeps origin + dates exact, Travelfusion fares slot in
   as real bookable options with no other change.
6. **Gate** — `travelfusionEnabled()` returns false with no keys, so the adapter
   is inert until certified — same fail-closed pattern as every other supplier.

Estimated effort once test credentials land: ~2–3 focused days for search+price,
a further ~2 for book+certify (Travelfusion certification sign-off gates live).

---

## Interim (while the application is pending)

- Duffel remains the live flight source — fully bookable, just not price-leading
  on bare European LCC seats.
- Be transparent in the UI: we sell the *cheapest reliable* fare we can *book*,
  and never a self-transfer hack. That positioning holds even while we're above
  the metasearch floor on some LCC hops.
