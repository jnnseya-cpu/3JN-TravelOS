# Supplier Doors — API acquisition checklist & fulfilment map

Every supply channel is an env-gated "door": start the signup today, and the
moment the key lands in Vercel → Environment Variables, that lane goes live
with **zero code changes**. Until then, fulfilment runs through the Ops
Fulfilment Desk (below). Live tracker: **Admin console → 🛠 Ops Fulfilment
Desk → Supplier doors**.

## Start these signups today

| Door | Provider | Env var | Where | Lead time |
|---|---|---|---|---|
| Flights (live) | Duffel | `DUFFEL_TOKEN` | duffel.com | ✅ already live |
| Market fares (incl. Ryanair) | Travelpayouts | `TRAVELPAYOUTS_TOKEN` | travelpayouts.com → Tools → API | minutes, self-serve |
| Hotels (live) | Amadeus | `AMADEUS_CLIENT_ID` + `AMADEUS_CLIENT_SECRET` | developers.amadeus.com | in progress |
| eSIM (auto-provision) | eSIM Access | `ESIMACCESS_API_KEY` | esimaccess.com | days, self-serve reseller |
| Activities (global) | Viator | `VIATOR_API_KEY` | partnerresources.viator.com | days–week, open signup |
| Transfers | Mozio | `MOZIO_API_KEY` | mozio.com/partners | weeks, application |
| Insurance | Cover Genius / battleface | `XCOVER_API_KEY` **+ `INSURANCE_AUTHORISED=true`** | covergenius.com / battleface.com | **START FIRST — FCA IAR required; sales stay OFF until authorised** |
| Ryanair/Jet2 bookable | Travelfusion / Ryanair approved-OTA | `TEQUILA_API_KEY` slot | travelfusion.com (sales) | months, contract |
| Car hire | CarTrawler (Discover Cars affiliate meanwhile) | later | cartrawler.com | weeks |
| Rail/coach | Distribusion | later | distribusion.com | weeks |

## Rayna Tours (B2B agreement — no API, portal operated by 3JN)

Rayna activities **and Dubai visas** route to the Ops Fulfilment Desk on the
`ops:rayna` channel. The "automatic way" around the manual portal:

1. Customer pays → the booking auto-decomposes into fulfilment orders.
2. Each Rayna order arrives **pre-packed**: product, date, pax, lead
   traveller (name/nationality/passport), our ref, sell price — one click
   copies the whole payload; one click opens the Rayna portal.
3. Operator books at net rates in the portal, pastes the Rayna confirmation
   number back → the OS writes it into the customer's travel documents and
   notifies them instantly. Orders age visibly (⚠ after 24h) so nothing rots.
4. When volume justifies it: ask Rayna for their B2B XML/API (they provide it
   to higher-volume agents) — the `ops:rayna` channel then flips to an
   API adapter with no workflow change.

## Fulfilment lanes (who completes what today)

- **auto:** eSIM (API or in-OS provisioning — activation code straight into
  documents), host-marketplace stays.
- **ops:rayna:** Rayna-footprint activities + Dubai visa.
- **ops:vendor-marketplace:** photographers, guides, translators, drivers,
  restaurants — 3JN's own vendors (risk-reviewed, paid Fridays post-service).
- **ops:visa-desk / ops:hotels / ops:transfers / ops:ground / ops:carhire:**
  desk-fulfilled until each door's API lands.
- **ops:insurance-signpost:** NO sales until FCA authorisation — fail closed.
