# 3JN Host Marketplace — Full Listing Schema (Homey-class)

Everything a host configures when setting up a **property/stay** or an
**experience** in the Hosting section. Implemented in `backend/src/host-listing.js`
(sanitizer + pricing) and the Hosting page publish form.

## Listing kinds
- **Stay** — priced per Night / Day / Hour / Week / Month / Stay (host chooses the unit).
- **Experience** — priced **per person**; full payment at booking (`depositPct: 100`).

## Sections (both kinds unless noted)
1. **Information** — title, description, listing type, guests, bedrooms, beds,
   bathrooms, rooms, size (+unit), per-bedroom detail (name | guests | beds | bed type).
2. **Pricing** — priced-per unit, price, weekend price + weekend days, instant
   booking, after-price label.
3. **Long-term pricing** — weekly rate (7+ nights) and monthly rate (30+ nights),
   auto-applied when the stay qualifies.
4. **Additional costs** — allow additional guests, included guests, extra-guest
   fee, cleaning fee (+type), city fee (+type), security deposit (held, not
   charged), tax % (per-listing, per each country's law).
5. **Features** — amenities + facilities. **Media** — 10–100 photos (5+ for
   experiences, browser-compressed upload) + video URL.
6. **Location** — street address (mandatory, guest-verifiable), apt, area,
   state, country, zip, lat/lng.
7. **Services** — optional paid extras (name | price | description).
8. **Terms & rules** — cancellation policy, min/max stay, check-in after,
   check-out before, smoking/pets/party/children rules, additional rules.
9. **Opening hours** — Mon–Fri / Sat / Sun (hourly listings & experiences).
10. **Experience-only** — experience type, host qualifications, languages,
    duration (hours), *what I will provide*, *what you will bring*.

## Availability calendar (per listing)
- Host **blocks dates** (never sell) and sets **per-date special prices**
  (events/high season). Weekend pricing separate. Search EXCLUDES any listing
  whose blocked dates intersect the stay; per-date prices flow into the quote.

## Reservation policy
- Stays: deposit % at booking (default 10%). Experiences: full payment.
- Pending reservation auto-cancels after N hours unpaid (default 24).
- No-show cancel window before check-in (default 24h).

## One honest price
`stayQuote()` = calendar/weekend/long-term rate × nights + extra-guest fees +
cleaning fee + city fee + tax % → ONE total shown upfront (deposit shown as
held). No surprise fees at check-in. 3JN keeps 10% (host fee); hosts keep 90%.

## Captured for later (theme-config parity, not yet built)
- Label/i18n customisation of every field name (day/days… guest/guests).
- Grid/List/Card show-hide toggles (bedrooms/baths/guests/type/host/rating).
- Address composer (which address parts show on cards), sticky/half-map list
  layouts, "Load More" pagination, icon set, compare & favourite.
- Guest-side services fee (platform already charges the transparent 10%).
- Booking-form field hiding (guests/children), no-login guest checkout.
- Instant Booking marketing page copy.
- Taxonomy pages (type/room type/language/city/state/country/area) layout for
  BOTH listings and experiences, featured-on-top / date ordering, per-page counts.
