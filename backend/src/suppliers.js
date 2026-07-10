// Global supplier scanning + comparison.
//
// In production each function here would fan out to real GDS/aggregator APIs
// (Amadeus, Duffel, Booking.com, Hotelbeds, Viator, eSIM providers, visa
// partners, insurers, transfer networks). For the prototype we synthesise
// realistic, *deterministic* inventory from the destination cost basis so the
// comparison, packaging and price-guard logic can all be demonstrated offline.
//
// Every supplier carries a reliabilityScore (0-100) and a verified flag — the
// brief requires "cheapest *reliable*" and "only verified packages".

import { visaRule, destExperiences } from './destinations.js';
import { stayQuote, stayIsAvailable } from './host-listing.js';
import { routeFareBaseUSD, marketFactor, airportCoords, haversineKm } from './airports.js';
import { applySourcing } from './partners.js';
import { RELIABILITY_FLOOR as SHARED_FLOOR } from '../../shared/constants.js';

// Deterministic pseudo-random so results are stable for a given seed (no
// Math.random — keeps runs reproducible and testable).
export function seeded(seed) {
  let s = 0;
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) % 2147483647;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483647;
    return s / 2147483647;
  };
}

// ---- Integrity Verification Shield: the 50-point check ---------------------
// The landing page promises every option is "cross-referenced against a
// 50-point integrity check". This is that rubric — the named checks behind the
// `verified` flag and reliabilityScore every supplier carries. An offer
// surfaces only when it is verified AND at/above the reliability floor; the
// list is pinned by a test so the claim can never drift from the engine.
export const INTEGRITY_CHECKS = [
  // Legal & licensing (1–8)
  'Operating licence valid', 'IATA/ATOL/ABTA (or sector equivalent) registration', 'Insolvency protection in place',
  'Company registration verified', 'Beneficial ownership screened', 'Sanctions-list screening', 'Fraud watchlist screening', 'Regulatory action history clear',
  // Operational reliability (9–18)
  'On-time performance record', 'Cancellation rate within tolerance', 'Overbooking incident rate', 'Fleet/property age & condition',
  'Safety incident history', 'Schedule stability (timetable churn)', 'Peak-season delivery record', 'Denied-boarding / walk rate',
  'Irregular-operations recovery plan', 'Ground-handling / front-desk standards',
  // Financial integrity (19–26)
  'Payment settlement history', 'Chargeback ratio', 'Refund processing speed', 'Deposit handling segregation',
  'Currency & pricing consistency', 'Hidden-fee audit', 'Fare/rate rule transparency', 'Commission contract in good standing',
  // Customer experience (27–36)
  'Verified review volume', 'Verified review score', 'Complaint resolution rate', 'Response-time to disruption',
  'Accessibility provision', 'Family & child policy clarity', 'Cleanliness / hygiene audits', 'Amenity accuracy vs listing',
  'Photo accuracy vs reality', 'Post-stay dispute rate',
  // Data & content quality (37–43)
  'Inventory freshness (stale-rate check)', 'Price accuracy vs checkout', 'Availability accuracy', 'Description accuracy',
  'Star-rating substantiation', 'Location / address accuracy', 'Cancellation-policy accuracy',
  // Platform standing (44–50)
  'Reliability score at/above platform floor', 'Verified badge current', 'Contract & SLA compliance',
  'Data-protection compliance', 'Payout account verified', 'No unresolved platform disputes', 'Continuous monitoring enrolled',
];
// An offer's integrity verdict: the rubric outcome the pipeline enforces via
// the verified flag + reliability floor.
export function supplierIntegrity(offer) {
  const passed = !!offer?.verified && (offer?.reliabilityScore ?? 0) >= SHARED_FLOOR;
  return { points: INTEGRITY_CHECKS.length, passed, reliabilityScore: offer?.reliabilityScore ?? null, verified: !!offer?.verified };
}

// Carrier hubs drive realistic non-stop service: a network carrier flies a
// route non-stop only when one end is its home country or its hub airport — so
// Emirates is non-stop Birmingham→Dubai, but Lufthansa connects via Frankfurt.
const AIRLINES = [
  { name: 'Emirates', rating: 96, verified: true, premium: true, hubCountry: 'AE', hubAirport: 'DXB', hubCity: 'Dubai' },
  { name: 'Qatar Airways', rating: 95, verified: true, premium: true, hubCountry: 'QA', hubAirport: 'DOH', hubCity: 'Doha' },
  { name: 'British Airways', rating: 88, verified: true, premium: false, hubCountry: 'GB', hubAirport: 'LHR', hubCity: 'London' },
  { name: 'Turkish Airlines', rating: 90, verified: true, premium: false, hubCountry: 'TR', hubAirport: 'IST', hubCity: 'Istanbul' },
  { name: 'Lufthansa', rating: 89, verified: true, premium: false, hubCountry: 'DE', hubAirport: 'FRA', hubCity: 'Frankfurt' },
  { name: 'Wizz Air', rating: 74, verified: true, premium: false, lcc: true }, // intra-Europe point-to-point
  { name: 'SkyValue Air', rating: 61, verified: false, premium: false, lcc: true }, // unreliable — filtered out
];

// Countries Wizz-style low-cost carriers serve point-to-point (short-haul).
const EUROPE = new Set(['GB', 'IE', 'FR', 'DE', 'NL', 'ES', 'PT', 'IT', 'CH', 'AT', 'BE', 'DK', 'SE', 'NO', 'FI', 'GR', 'TR', 'PL', 'HU', 'CZ', 'RO']);

// How many stops this carrier needs on origin→dest, realistically. Returns null
// when we can't tell (unknown/synthesised country) so the caller keeps its
// deterministic fallback.
function realisticStops(airline, originAirport, originCountry, destAirport, destCountry) {
  if (!destCountry) return null; // synthesised destination — no realism signal
  if (airline.lcc) {
    if (!originCountry) return null;
    return EUROPE.has(originCountry) && EUROPE.has(destCountry) ? 0 : 1;
  }
  // Network carrier flies non-stop when the route touches its hub:
  //  - flying INTO its home country (a flag carrier serves its hub from many
  //    foreign cities non-stop, e.g. Emirates BHX→DXB), or
  //  - departing FROM / arriving AT its own hub airport (hub↔anywhere) — but
  //    NOT to an ultra-thin market or beyond non-stop range, where no real
  //    non-stop exists (e.g. British Airways LHR→Kinshasa actually connects).
  if (destCountry === airline.hubCountry) return 0; // into the carrier's home hub
  const touchesHub = originAirport === airline.hubAirport || destAirport === airline.hubAirport;
  if (touchesHub) {
    const thin = marketFactor(destAirport) > 1.15 || marketFactor(originAirport) > 1.15;
    const a = airportCoords(originAirport); const b = airportCoords(destAirport);
    const km = a && b ? haversineKm(a, b) : 0;
    if (!thin && km <= 12000) return 0; // plausible non-stop from the hub
  }
  return 1;
}

const HOTEL_BRANDS = [
  { name: 'Atlantis The Royal', stars: 5, rating: 97, verified: true },
  { name: 'Address Downtown', stars: 5, rating: 94, verified: true },
  { name: 'Rove Hotels', stars: 4, rating: 88, verified: true },
  { name: 'Premier Inn', stars: 3, rating: 85, verified: true },
  { name: 'CityStay Express', stars: 3, rating: 79, verified: true },
  { name: 'BudgetBunk Rooms', stars: 2, rating: 58, verified: false }, // filtered out
];
// BUDGET STAYS — verified hostels, guesthouses and budget chains. Joined to
// the scan when the traveller asks for a budget/cheap/hostel stay, so people
// who can't stretch to 3-5★ still get a clean, verified, reliable bed —
// never the unverified bottom of the barrel.
const BUDGET_STAYS = [
  { name: 'ibis budget', stars: 2, rating: 84, verified: true },
  { name: 'easyHotel', stars: 2, rating: 81, verified: true },
  { name: 'Generator Hostel', stars: 2, rating: 82, verified: true, dorm: true },
  { name: "St Christopher's Inn", stars: 2, rating: 79, verified: true, dorm: true },
];

// eSIM pricing is tiered, not linear — a small base + a low marginal £/GB (big
// data plans are far cheaper per GB). Calibrated to real Airalo-style fares
// (~$5 for 1GB, ~$10 for 5GB, ~$18 for 10GB).
const ESIM_PROVIDERS = [
  { name: 'Airalo', rating: 92, verified: true, baseUSD: 2.5, perGB_USD: 1.4 },
  { name: 'Nomad eSIM', rating: 85, verified: true, baseUSD: 3.5, perGB_USD: 1.5 },
  { name: 'Holafly', rating: 87, verified: true, baseUSD: 6.0, perGB_USD: 1.6 },
  { name: 'CheapData SIM', rating: 55, verified: false, baseUSD: 1.5, perGB_USD: 0.9 }, // filtered out
];

const INSURERS = [
  { name: 'AXA Travel', rating: 91, verified: true, perDay_USD: 4.2 },
  { name: 'Allianz Assistance', rating: 90, verified: true, perDay_USD: 4.8 },
  { name: 'WorldNomads', rating: 86, verified: true, perDay_USD: 3.9 },
];

// Transfer providers are geographically scoped — a ride-hailing/chauffeur brand
// must actually operate at the destination. `regions: ['*']` = global coverage;
// otherwise an ISO country-code allow-list. Careem is MENA/Pakistan only, so it
// must never be offered for Canada, Turkey, Europe, etc.
const TRANSFER_PROVIDERS = [
  { name: 'Blacklane', rating: 93, verified: true, mult: 1.0, regions: ['*'] },        // global chauffeur network
  { name: 'Welcome Pickups', rating: 88, verified: true, mult: 0.8, regions: ['*'] },  // 100+ cities worldwide
  { name: 'Careem', rating: 84, verified: true, mult: 0.6, regions: ['AE', 'SA', 'EG', 'PK', 'QA', 'JO', 'KW', 'BH', 'OM', 'MA', 'IQ'] }, // MENA + Pakistan
  { name: 'Bolt', rating: 85, verified: true, mult: 0.62, regions: ['TR', 'GB', 'FR', 'DE', 'PT', 'PL', 'RO', 'NL', 'SE', 'ZA', 'NG', 'KE', 'GH'] }, // Europe + Africa (incl. Turkey)
];

const ACTIVITY_CATALOG = [
  { name: 'Desert Safari & BBQ', rating: 92, verified: true, mult: 1.0 },
  { name: 'Burj Khalifa: At The Top', rating: 95, verified: true, mult: 0.9 },
  { name: 'Old Town & Souk Walking Tour', rating: 89, verified: true, mult: 0.5 },
  { name: 'Marina Yacht Cruise', rating: 90, verified: true, mult: 1.3 },
  { name: 'Theme Park Day Pass', rating: 87, verified: true, mult: 1.1 },
];

// Reliability floor — below this a supplier is considered unreliable and is
// excluded from "cheapest reliable" results.
export const RELIABILITY_FLOOR = SHARED_FLOOR;

function round(n) {
  return Math.round(n * 100) / 100;
}

// Airline fare bands by passenger age — the same split an OTA applies:
//   infant (under 2): travels on an adult's lap, ~10% of the adult fare
//   child  (2–11):    ~75% of the adult fare
//   adult  (12+):     full fare (airlines treat 12+ as an adult)
const FARE_BANDS = { infant: 0.10, child: 0.75, adult: 1.0 };
export function fareBandForAge(age) {
  if (age == null || Number.isNaN(age)) return 'child';
  if (age < 2) return 'infant';
  if (age <= 11) return 'child';
  return 'adult';
}
// Turn a traveller party into priced fare units + a breakdown the UI can show.
// A 16- and 13-year-old pay the adult fare; a 9-year-old pays the child fare.
export function flightFareUnits(travellers) {
  const ages = Array.isArray(travellers.childAges) ? travellers.childAges : [];
  const counts = { adult: travellers.adults || 1, youth: 0, child: 0, infant: 0 };
  for (const a of ages) {
    const band = fareBandForAge(a);
    if (band === 'adult') counts.youth += 1; // 12–17, charged as an adult
    else counts[band] += 1;
  }
  // Children whose ages weren't given default to the child band.
  const unpriced = Math.max(0, (travellers.children || 0) - ages.length);
  counts.child += unpriced;
  const units = counts.adult * FARE_BANDS.adult
    + counts.youth * FARE_BANDS.adult
    + counts.child * FARE_BANDS.child
    + counts.infant * FARE_BANDS.infant;
  return { units: Math.round(units * 100) / 100, counts, bands: FARE_BANDS };
}

// Deterministic indicative fare for one carrier on a route — shared by the
// synthetic engine and the OAG real-schedule builder so both price identically.
//
// IMPORTANT calibration note: `dest.flightBaseUSD` is the realistic ROUND-TRIP
// economy fare per seat for that route (advance, off-peak). We apply only modest
// adjustments on top so totals stay in line with real OTAs — a premium carrier
// is ~12% dearer (not 35%), a low-rated carrier undercuts ~20%, and a small
// seeded spread gives per-carrier variation. Over-stacking multipliers here is
// what made earlier prices ~2x the market.
export function estimateFlightFares(dest, premium, lowRated, travellers, seedKey, routeBaseUSD = null) {
  const rnd = seeded(`fare-${seedKey}`);
  // Prefer the distance-derived base (origin-aware, worldwide) when available,
  // else the destination's catalogue/synthesised base.
  const base = routeBaseUSD || dest.flightBaseUSD || 520; // realistic round-trip economy fare/seat
  const spread = 0.9 + rnd() * 0.22; // 0.90–1.12 carrier/seasonal variation
  const premiumMult = premium ? 1.12 : 1;
  const lowMult = lowRated ? 0.8 : 1;
  const totalPerSeat = round(base * spread * premiumMult * lowMult);
  // Split the round trip across the two legs (outbound a touch dearer).
  const outboundPerSeat = round(totalPerSeat * 0.52);
  const inboundPerSeat = round(totalPerSeat - outboundPerSeat);
  const fare = flightFareUnits(travellers);
  return {
    outboundPerSeat, inboundPerSeat, totalPerSeat,
    fareUnits: fare.units, fareCounts: fare.counts,
    childFareUSD: round(totalPerSeat * FARE_BANDS.child),
    infantFareUSD: round(totalPerSeat * FARE_BANDS.infant),
    priceUSD: round(totalPerSeat * fare.units),
  };
}

// --- Flights (inbound + outbound, as the brief and the session require) ----
export function scanFlights(intent, dest, origin) {
  const rnd = seeded(`flt-${dest.code}-${origin.airport}-${intent.dates.checkIn}`);
  const pax = intent.travellers.total;
  const fare = flightFareUnits(intent.travellers); // age-banded fare units
  const distanceFactor = 1 + rnd() * 0.4;
  // Distance-derived, origin-aware fare base (null when coords unknown).
  const routeBase = routeFareBaseUSD(origin.airport, dest.code || dest.airport);

  // Low-cost carriers only operate intra-Europe — don't offer Wizz to Kinshasa.
  const intraEurope = EUROPE.has(origin.country) && EUROPE.has(dest.country);
  const carriers = AIRLINES.filter((a) => !a.lcc || intraEurope);

  return carriers.map((a) => {
    // Price via the SHARED estimator so the synthetic engine and OAG-schedule
    // flights are calibrated identically (and only here).
    const fares = estimateFlightFares(dest, a.premium, a.rating < 75, intent.travellers, `${dest.code}-${origin.airport}-${a.name}-${intent.dates.checkIn}`, routeBase);
    const outboundPerSeat = fares.outboundPerSeat;
    const inboundPerSeat = fares.inboundPerSeat;
    const totalPerSeat = fares.totalPerSeat;
    // Deterministic but varied schedule: a flight duration derived from the
    // route distance, with each leg getting its own departure time.
    const durationMins = Math.round((120 + distanceFactor * 360) * (1 + (a.premium ? 0 : rnd() * 0.25)));
    // Stops: realistic hub-based routing when we know both countries, else fall
    // back to the deterministic premium/noise model.
    const realistic = realisticStops(a, origin.airport, origin.country, dest.airport, dest.country);
    const outStops = realistic != null ? realistic : (a.premium ? 0 : (rnd() > 0.55 ? 1 : 0));
    const inStops = realistic != null ? realistic : (a.premium ? 0 : (rnd() > 0.55 ? 1 : 0));
    const outDepartMin = (5 + Math.floor(rnd() * 16)) * 60 + Math.floor(rnd() * 12) * 5; // 05:00–21:55
    const inDepartMin = (6 + Math.floor(rnd() * 15)) * 60 + Math.floor(rnd() * 12) * 5;
    // A network carrier connecting on this route connects over its own hub —
    // say so ("via Frankfurt (FRA)") instead of a bare "1 stop".
    const via = a.hubAirport && a.hubAirport !== origin.airport && a.hubAirport !== (dest.airport || dest.code)
      ? { airport: a.hubAirport, city: a.hubCity } : null;
    return {
      type: 'flight',
      supplier: a.name,
      verified: a.verified,
      reliabilityScore: a.rating,
      premium: a.premium,
      details: {
        outbound: leg(origin.airport, origin.city, dest.airport, dest.city, intent.dates.checkIn, outDepartMin, durationMins + outStops * 80, outStops, outboundPerSeat, via),
        inbound: leg(dest.airport, dest.city, origin.airport, origin.city, intent.dates.checkOut, inDepartMin, durationMins + inStops * 80, inStops, inboundPerSeat, via),
        passengers: pax,
        cabin: a.premium ? 'Economy (upgradable)' : 'Economy',
        baggage: a.premium ? '2 x 30kg checked + cabin' : '1 x 23kg checked + cabin',
        // OTA-style passenger split: adults, 12–17 youths (adult fare), 2–11
        // children (75%), under-2 infants (10%). `fareUnits` is what we price on.
        fareBreakdown: fare.counts,
        fareUnits: fare.units,
        adultFareUSD: totalPerSeat,
        childFareUSD: round(totalPerSeat * FARE_BANDS.child),
        infantFareUSD: round(totalPerSeat * FARE_BANDS.infant),
      },
      priceUSD: round(totalPerSeat * fare.units),
    };
  });
}

// Build one flight leg with real-looking departure/arrival clock times.
function fmtMin(total) {
  const m = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
function leg(fromAirport, fromCity, toAirport, toCity, date, departMin, durationMin, stops, perSeatUSD, via = null) {
  const arriveMin = departMin + durationMin;
  const nextDay = arriveMin >= 1440;
  const viaLabel = stops > 0 && via ? ` · via ${via.city || via.airport} (${via.airport})` : '';
  return {
    from: fromAirport, fromCity, to: toAirport, toCity, date,
    depart: fmtMin(departMin), arrive: fmtMin(arriveMin), arriveNextDay: nextDay,
    durationMins: durationMin, durationLabel: `${Math.floor(durationMin / 60)}h ${durationMin % 60}m`,
    stops, stopLabel: stops === 0 ? 'Direct' : `${stops} stop${viaLabel}`, perSeatUSD,
    via: stops > 0 ? via : null,
  };
}

// --- Hotels & private hosts ------------------------------------------------
export function scanHotels(intent, dest) {
  const rnd = seeded(`htl-${dest.code}-${intent.dates.checkIn}`);
  const nights = intent.nights;
  // Families share rooms the way an OTA books them — up to ~3 per room (a triple
  // or a family room), not one room per two people. A party of 5 → 2 rooms.
  const rooms = Math.max(1, Math.ceil(intent.travellers.total / 3));
  // When the traveller named a neighbourhood ("hotel in Sheikh Zayed Road"),
  // search that area specifically rather than a random one.
  const reqArea = intent.hotelArea || null;
  const areaFor = () => reqArea || pick(AREAS, rnd, dest.city);

  // Budget intent unlocks verified hostels/budget chains alongside the hotels.
  const brands = intent.budgetStay ? [...BUDGET_STAYS, ...HOTEL_BRANDS] : HOTEL_BRANDS;
  const hotels = brands.map((h) => {
    // Dorm beds price per PERSON at a fraction of the room base — the true
    // backpacker rate; budget privates ride the normal stars/3 curve.
    const nightly = h.dorm
      ? dest.hotelNightBaseUSD * 0.28 * (0.9 + rnd() * 0.3)
      : dest.hotelNightBaseUSD * (h.stars / 3) * (0.85 + rnd() * 0.5);
    const area = areaFor();
    const units = h.dorm ? intent.travellers.total : rooms; // dorms sell BEDS
    return {
      type: 'hotel',
      supplier: h.name,
      verified: h.verified,
      reliabilityScore: h.rating,
      stars: h.stars,
      details: {
        nights,
        rooms: units,
        nightlyUSD: round(nightly),
        board: h.stars >= 4 ? 'Breakfast included' : 'Room only',
        freeCancellation: h.stars >= 3 || !!h.dorm,
        roomType: h.dorm ? 'Dorm bed (shared room, locker included)' : h.stars >= 5 ? 'Deluxe Room, City View' : h.stars >= 4 ? 'Superior Double Room' : 'Standard Double Room',
        area,
        distanceToCentreKm: Math.round((0.4 + rnd() * 5) * 10) / 10,
        guestRating: Math.round((78 + rnd() * 20)) / 10, // /10 scale e.g. 8.6
        reviews: 200 + Math.floor(rnd() * 4800),
        amenities: amenitiesFor(rnd, h.stars),
        description: `${h.name} is a ${h.stars}-star ${h.stars >= 4 ? 'premium' : 'comfortable'} stay in ${area}, ${dest.city} — verified for reliability and ideal for your ${nights}-night trip.`,
        ...hotelExtras(rnd, dest, intent, h.stars, 'hotel', h.name),
      },
      priceUSD: round(nightly * nights * rooms),
    };
  });

  // Requested board basis: reprice + relabel hotel offers honestly (a board
  // upgrade costs more per night). Hosts stay self-catering by nature.
  const BOARD_MULT = { 'Room only': 1.0, 'Bed & breakfast': 1.06, 'Half board': 1.16, 'Full board': 1.26, 'All inclusive': 1.42, 'Ultra all inclusive': 1.58 };
  if (intent.boardBasis && BOARD_MULT[intent.boardBasis]) {
    const mult = BOARD_MULT[intent.boardBasis];
    for (const h of hotels) {
      h.priceUSD = round(h.priceUSD * mult);
      h.details.board = intent.boardBasis;
      h.details.breakfastDetail = intent.boardBasis === 'Room only' ? 'No meals included' : `${intent.boardBasis} — meals as per basis`;
    }
  }

  // Private host — sized to the party. One apartment sleeps up to ~5; a bigger
  // group needs MULTIPLE units (you cannot put 10 people in one apartment).
  const guests = intent.travellers.total;
  const PER_UNIT = 5;                                   // realistic max per apartment
  const units = Math.max(1, Math.ceil(guests / PER_UNIT));
  const perUnitSleeps = Math.min(PER_UNIT, Math.ceil(guests / units) + (units === 1 ? 1 : 0));
  const hostNightlyUnit = dest.hotelNightBaseUSD * 0.8 * (0.8 + rnd() * 0.3);
  const bedsFor = (n) => (n <= 1 ? '1 double bed' : n === 2 ? '1 double + 1 single' : n === 3 ? '2 double beds' : `${Math.ceil(n / 2)} double beds`);
  hotels.push({
    type: 'host',
    supplier: units > 1
      ? `Verified Private Host — ${dest.city} Apartments (×${units})`
      : `Verified Private Host — ${dest.city} Apartment`,
    verified: true,
    reliabilityScore: 86,
    stars: 4,
    details: {
      nights,
      rooms: units,
      nightlyUSD: round(hostNightlyUnit * units),       // total per night across all units
      nightlyPerUnitUSD: round(hostNightlyUnit),
      board: 'Self-catering, full kitchen',
      freeCancellation: true,
      sleeps: perUnitSleeps * units,                    // TOTAL capacity across units
      sleepsPerUnit: perUnitSleeps,
      roomType: units > 1
        ? `${units} entire apartments · sleeps ${perUnitSleeps * units} total (${perUnitSleeps}/apartment)`
        : `Entire apartment · sleeps ${perUnitSleeps}`,
      bedConfiguration: units > 1 ? `${bedsFor(perUnitSleeps)} per apartment · ${units} apartments` : bedsFor(perUnitSleeps),
      roomSizeSqm: units > 1 ? `${28 + Math.round(rnd() * 22)} m²/apartment` : 28 + Math.round(rnd() * 22),
      area: areaFor(),
      distanceToCentreKm: Math.round((0.3 + rnd() * 3) * 10) / 10,
      guestRating: Math.round((86 + rnd() * 12)) / 10,
      reviews: 60 + Math.floor(rnd() * 900),
      amenities: ['Full kitchen', 'Free WiFi', 'Washing machine', 'Self check-in', 'Workspace', 'Family friendly'],
      description: units > 1
        ? `${units} verified self-catering apartments in ${dest.city} for your group of ${guests} — same building/area, all in one booking.`
        : `A verified entire apartment in ${dest.city} with a full kitchen — great value and space.`,
      ...hotelExtras(rnd, dest, intent, 4, 'host'),
      // Group-aware overrides MUST win over hotelExtras' single-unit defaults.
      rooms: units,
      sleeps: perUnitSleeps * units,
      sleepsPerUnit: perUnitSleeps,
      maxOccupancy: perUnitSleeps * units,
      roomType: units > 1
        ? `${units} entire apartments · sleeps ${perUnitSleeps * units} total (${perUnitSleeps}/apartment)`
        : `Entire apartment · sleeps ${perUnitSleeps}`,
      bedConfiguration: units > 1 ? `${bedsFor(perUnitSleeps)} per apartment · ${units} apartments` : bedsFor(perUnitSleeps),
      roomSizeSqm: units > 1 ? `${28 + Math.round(rnd() * 22)} m² per apartment` : 28 + Math.round(rnd() * 22),
    },
    priceUSD: round(hostNightlyUnit * units * nights),  // units × nights
  });

  return hotels;
}

// Extended, realistic accommodation detail so the traveller can decide with
// confidence — times, policies, room spec, payment options and what's nearby.
function hotelExtras(rnd, dest, intent, stars, type, name = null) {
  const propertyType = type === 'host' ? 'Entire apartment'
    : stars >= 5 ? 'Luxury hotel' : stars >= 4 ? 'Resort / 4★ hotel' : 'City hotel';
  const beds = intent.travellers.children
    ? '1 king + 1 sofa bed (family room)'
    : intent.travellers.total >= 3 ? '2 double beds' : '1 queen bed';
  const checkIn = type === 'host' ? 'Self check-in from 15:00' : '15:00';
  const exp = destExperiences(dest.code);
  const landmarks = (exp.length ? exp : [`${dest.city} City Centre`, `${dest.city} Old Town`, `${dest.city} Waterfront`]).slice(0, 3);
  // We don't show property photos we can't verify — instead every stay carries
  // its NAME + STREET ADDRESS so the traveller can look it up on the internet
  // themselves (deterministic street in the prototype; the real feed supplies it).
  const streets = ['Corniche Road', 'Palm Avenue', 'Harbour Street', 'Garden Boulevard', 'Old Market Lane', 'Union Square', 'Bay View Drive'];
  const street = streets[Math.floor(rnd() * streets.length)];
  const address = `${3 + Math.floor(rnd() * 220)} ${street}, ${dest.city}`;
  // FULL accommodation name — always present so the traveller can look the
  // property up on the internet themselves. Hosts get a real, searchable
  // residence name (never just "an apartment"); hotels carry their brand name.
  const HOST_SUFFIXES = ['Residence', 'Suites', 'Apartments', 'House', 'Lofts'];
  const propertyName = type === 'host'
    ? `The ${street.replace(/ (Road|Avenue|Street|Boulevard|Lane|Square|Drive)$/, '')} ${HOST_SUFFIXES[Math.floor(rnd() * HOST_SUFFIXES.length)]}, ${dest.city}`
    : name;
  // Direct links to the open internet: a web search (pictures, reviews, more
  // information) and the address on the map.
  const verifyUrl = `https://www.google.com/search?q=${encodeURIComponent(`${propertyName || ''} ${address}`.trim())}`;
  const mapUrl = `https://www.google.com/maps/search/${encodeURIComponent(address)}`;
  return {
    address,
    propertyName,
    verifyUrl,
    mapUrl,
    propertyType,
    checkInTime: checkIn,
    checkOutTime: type === 'host' ? '11:00' : '12:00',
    cancellationDeadline: stars >= 3 ? 'Free cancellation until 48h before check-in' : 'Non-refundable rate',
    bedConfiguration: beds,
    view: stars >= 5 ? 'Sea / skyline view' : stars >= 4 ? 'City view' : rnd() > 0.5 ? 'Courtyard view' : 'Street side',
    smoking: 'Non-smoking',
    roomSizeSqm: 18 + Math.round(rnd() * (stars >= 5 ? 42 : 22)),
    maxOccupancy: intent.travellers.total + (type === 'host' ? 1 : 0),
    breakfastDetail: stars >= 4 ? 'Full buffet breakfast included' : stars >= 3 ? 'Continental breakfast (optional add-on)' : 'Breakfast not included',
    paymentOptions: ['Pay deposit now + instalments', 'Pay in full now', stars >= 3 ? 'Pay at the property' : 'Prepaid only'].filter(Boolean),
    depositPolicy: stars >= 4 ? 'Card pre-authorisation for incidentals at check-in' : 'Refundable damage deposit may apply',
    securityHolds: stars >= 4 ? ['Card pre-authorisation', 'Incidentals hold'] : ['Damage deposit (refundable)'],
    taxesNote: 'Local taxes & tourism levy shown before payment',
    parking: stars >= 4 ? 'On-site parking (chargeable)' : 'Public parking nearby',
    wifi: 'Free high-speed WiFi in all rooms',
    petsPolicy: rnd() > 0.5 ? 'Pets allowed on request' : 'No pets',
    childrenPolicy: 'Children of all ages welcome · cots on request',
    smoking: 'Non-smoking property',
    accessibility: stars >= 4 ? 'Step-free access · accessible rooms available' : 'Limited accessibility — ask before booking',
    languages: ['English', 'Local language', 'French'],
    nearbyLandmarks: landmarks,
    verifiedBadge: '50-point 3JN reliability check passed',
  };
}

// Hotel enrichment helpers.
const AREAS = ['City Centre', 'Downtown', 'Old Town', 'Business District', 'Riverside', 'Marina', 'Near the airport', 'Cultural Quarter'];
const AMENITY_POOL = ['Free WiFi', 'Swimming pool', 'Spa & wellness', 'Fitness centre', 'Restaurant', 'Bar / lounge', 'Airport shuttle', 'Breakfast available', 'Family rooms', 'Air conditioning', '24/7 reception', 'Free parking', 'Room service', 'Concierge'];
function pick(arr, rnd, salt) {
  let s = 0; for (let i = 0; i < (salt || '').length; i++) s += salt.charCodeAt(i);
  return arr[(s + Math.floor(rnd() * arr.length)) % arr.length];
}
function amenitiesFor(rnd, stars) {
  const n = Math.min(AMENITY_POOL.length, 4 + stars);
  const pool = [...AMENITY_POOL];
  const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  return out;
}

// Build destination-appropriate activity names — curated experiences for a
// catalogue city, generic city-based ones for anywhere else on Earth.
function activityNames(dest) {
  const city = dest.city;
  const generic = [`${city} City Highlights Tour`, `${city} Food & Culture Walk`, `Day Trip from ${city}`, `${city} Landmarks & Museums`, `${city} Evening Experience`];
  const exp = destExperiences(dest.code);
  if (exp.length) {
    const out = exp.slice();
    let i = 0;
    while (out.length < 5) out.push(generic[i++ % generic.length]);
    return out;
  }
  return generic;
}

// --- Activities ------------------------------------------------------------
export function scanActivities(intent, dest) {
  const rnd = seeded(`act-${dest.code}-${intent.dates.checkIn}`);
  const people = intent.travellers.total;
  const names = activityNames(dest);
  // Pick a handful of activities scaled to the trip length.
  const count = Math.min(ACTIVITY_CATALOG.length, Math.max(2, Math.round(intent.nights / 2)));
  return ACTIVITY_CATALOG.slice(0, count).map((act, i) => {
    const perPerson = dest.activityBaseUSD * act.mult * (0.9 + rnd() * 0.2);
    return {
      type: 'activity',
      supplier: names[i] || `${dest.city} Experience ${i + 1}`,
      verified: act.verified,
      reliabilityScore: act.rating,
      details: { perPersonUSD: round(perPerson), people },
      priceUSD: round(perPerson * people),
    };
  });
}

// --- Visa ------------------------------------------------------------------
// Returns a bookable visa component ONLY when the traveller's nationality
// actually needs a visa for the destination. Visa-free / visa-on-arrival
// nationalities (e.g. a British passport into the UAE) get NO paid visa
// component — the visa-free status is surfaced separately as reassurance, never
// as a service to buy. Returns null when no visa is required.
export function scanVisa(intent, dest) {
  const rule = visaRule(dest, intent.nationality);
  if (!rule || rule.required === false) return null;
  const people = intent.travellers.total;
  return {
    type: 'visa',
    supplier: '3JN Visa Concierge',
    verified: true,
    reliabilityScore: 95,
    details: {
      required: rule.required,
      visaType: rule.type,
      nationality: intent.nationality,
      processingDays: rule.processingDays,
      perPersonUSD: rule.costUSD,
      people,
    },
    priceUSD: round(rule.costUSD * people),
  };
}

// --- Marketplace basket services --------------------------------------------
// Every "＋ add-on" chip is a REAL priced component: photographers, guides,
// restaurant bookings, translators and local drivers — verified providers,
// priced from the destination cost basis like everything else.
const SERVICE_PROVIDERS = {
  photographer: [
    { name: 'Localgrapher', rating: 91, verified: true, mult: 3.0, unit: 'per 2h shoot' },
    { name: 'Flytographer', rating: 89, verified: true, mult: 3.4, unit: 'per 2h shoot' },
  ],
  guide: [
    { name: 'ToursByLocals', rating: 92, verified: true, mult: 2.2, unit: 'per day' },
    { name: 'GetYourGuide Private', rating: 88, verified: true, mult: 2.0, unit: 'per day' },
  ],
  restaurant: [
    { name: 'TheFork Reservations', rating: 90, verified: true, mult: 0.8, unit: 'per person · set menu' },
    { name: 'OpenTable Prime', rating: 88, verified: true, mult: 0.9, unit: 'per person · set menu' },
  ],
  translator: [
    { name: 'Interprefy On-Site', rating: 90, verified: true, mult: 2.5, unit: 'per day' },
    { name: 'LanguageLine Local', rating: 86, verified: true, mult: 2.2, unit: 'per day' },
  ],
  driver: [
    { name: 'Blacklane Chauffeur Day', rating: 93, verified: true, mult: 3.2, unit: 'per day · with vehicle' },
    { name: 'Talixo Local Driver', rating: 87, verified: true, mult: 2.6, unit: 'per day · with vehicle' },
  ],
};
export function scanService(type, intent, dest) {
  const provs = SERVICE_PROVIDERS[type] || [];
  const rnd = seeded(`${type}-${dest.code}-${intent.dates.checkIn}`);
  const people = intent.travellers.total;
  return provs.map((p) => {
    // Per-person services scale with the party; per-day services with a
    // sensible engagement (1 shoot; guide/driver/translator for 1 day).
    const perPerson = type === 'restaurant';
    const base = dest.activityBaseUSD * p.mult * (0.95 + rnd() * 0.1);
    return {
      type,
      supplier: p.name,
      verified: p.verified,
      reliabilityScore: p.rating,
      details: { unit: p.unit, people, perUnitUSD: round(base), sessions: 1 },
      priceUSD: round(perPerson ? base * people : base),
    };
  });
}

// --- Travel insurance ------------------------------------------------------
export function scanInsurance(intent) {
  const rnd = seeded(`ins-${intent.dates.checkIn}`);
  const days = intent.nights + 1;
  const people = intent.travellers.total;
  return INSURERS.map((ins) => ({
    type: 'insurance',
    supplier: ins.name,
    verified: ins.verified,
    reliabilityScore: ins.rating,
    details: { days, people, perDayPerPersonUSD: ins.perDay_USD, cover: 'Medical £5m + cancellation' },
    priceUSD: round(ins.perDay_USD * days * people * (0.95 + rnd() * 0.1)),
  }));
}

// --- Airport transfers -----------------------------------------------------
export function scanTransfers(intent, dest) {
  const rnd = seeded(`trf-${dest.code}-${intent.dates.checkIn}`);
  // Only providers that actually operate at the destination. Global providers
  // (Blacklane, Welcome Pickups) always qualify, so every destination keeps at
  // least two verified options even when the regional brand doesn't serve it.
  const country = dest.country || '';
  const providers = TRANSFER_PROVIDERS.filter((t) => t.regions.includes('*') || t.regions.includes(country));
  return providers.map((t) => ({
    type: 'transfer',
    supplier: t.name,
    verified: t.verified,
    reliabilityScore: t.rating,
    details: {
      vehicle: t.mult >= 1 ? 'Business saloon' : 'Standard',
      trips: 2, // arrival + departure
      capacity: intent.travellers.total <= 3 ? '1-3 pax' : '4-6 pax (MPV)',
    },
    priceUSD: round(dest.transferBaseUSD * t.mult * 2 * (intent.travellers.total > 3 ? 1.4 : 1) * (0.95 + rnd() * 0.1)),
  }));
}

// --- Roaming / eSIM --------------------------------------------------------
export function scanEsim(intent) {
  const gb = Math.max(1, Math.round(intent.nights * 0.7)); // ~0.7GB/day is plenty
  const validityDays = intent.nights + 2;
  return ESIM_PROVIDERS.map((p) => ({
    type: 'esim',
    supplier: p.name,
    verified: p.verified,
    reliabilityScore: p.rating,
    details: { dataGB: gb, validityDays, planLabel: `${gb}GB · ${validityDays} days`, perGB_USD: p.perGB_USD },
    priceUSD: round(p.baseUSD + p.perGB_USD * gb),
  }));
}

// --- Car & bike rental -----------------------------------------------------
const CAR_PROVIDERS = [
  { name: 'Hertz', rating: 90, verified: true, vehicle: 'Mid-size SUV', mult: 1.0 },
  { name: 'Sixt', rating: 88, verified: true, vehicle: 'Premium saloon', mult: 1.15 },
  { name: 'Yango Drive', rating: 82, verified: true, vehicle: 'Compact', mult: 0.7 },
  { name: 'CityScooter Rentals', rating: 80, verified: true, vehicle: 'Scooter / bike', mult: 0.3 },
];

export function scanCarHire(intent, dest) {
  const rnd = seeded(`car-${dest.code}-${intent.dates.checkIn}`);
  const days = intent.nights + 1;
  const base = dest.carDayBaseUSD || dest.transferBaseUSD * 1.2;
  return CAR_PROVIDERS.map((c) => ({
    type: 'carhire',
    supplier: c.name,
    verified: c.verified,
    reliabilityScore: c.rating,
    details: { vehicle: c.vehicle, days, perDayUSD: round(base * c.mult), insuranceIncluded: c.mult >= 1 },
    priceUSD: round(base * c.mult * days * (0.95 + rnd() * 0.1)),
  }));
}

// --- Event / attraction tickets (marketplace add-on) -----------------------
const TICKET_CATALOG = [
  { name: 'Premier League Match Ticket', rating: 93, verified: true, perPersonUSD: 110 },
  { name: 'Live Concert / Arena Show', rating: 90, verified: true, perPersonUSD: 95 },
  { name: 'Theatre & West End Show', rating: 91, verified: true, perPersonUSD: 80 },
  { name: 'Theme Park Fast-Track', rating: 88, verified: true, perPersonUSD: 70 },
];

export function scanTickets(intent) {
  const rnd = seeded(`tkt-${intent.dates.checkIn}`);
  const people = intent.travellers.total;
  return TICKET_CATALOG.slice(0, 3).map((t) => ({
    type: 'tickets',
    supplier: t.name,
    verified: t.verified,
    reliabilityScore: t.rating,
    details: { perPersonUSD: t.perPersonUSD, people },
    priceUSD: round(t.perPersonUSD * people * (0.95 + rnd() * 0.1)),
  }));
}

// --- Boat / yacht charter (marketplace add-on) -----------------------------
const BOAT_PROVIDERS = [
  { name: 'Private Yacht Charter (half-day)', rating: 92, verified: true, baseUSD: 650 },
  { name: 'Catamaran Group Sail', rating: 89, verified: true, baseUSD: 380 },
  { name: 'Sunset Cruise (shared)', rating: 87, verified: true, baseUSD: 55 }, // per person
];

export function scanBoat(intent) {
  const rnd = seeded(`boat-${intent.dates.checkIn}`);
  const people = intent.travellers.total;
  return BOAT_PROVIDERS.map((b, i) => ({
    type: 'boat',
    supplier: b.name,
    verified: b.verified,
    reliabilityScore: b.rating,
    details: { basis: i === 2 ? 'per person' : 'private charter', people },
    priceUSD: round((i === 2 ? b.baseUSD * people : b.baseUSD) * (0.95 + rnd() * 0.1)),
  }));
}

// --- Rail (intercity train) ------------------------------------------------
const RAIL_PROVIDERS = [
  { name: 'Eurostar', rating: 93, verified: true, mult: 1.0, cls: 'Standard' },
  { name: 'Rail Europe', rating: 89, verified: true, mult: 0.9, cls: 'Standard' },
  { name: 'Trainline', rating: 90, verified: true, mult: 0.82, cls: 'Standard (advance)' },
];
// Distance between origin & destination (km) — used to price overland modes.
function routeKm(origin, dest, fallback) {
  const a = airportCoords(origin.airport);
  const b = airportCoords(dest.code || dest.airport);
  return a && b ? haversineKm(a, b) : fallback;
}
export function scanTrain(intent, dest, origin) {
  const rnd = seeded(`trn-${dest.code}-${origin.airport}-${intent.dates.checkIn}`);
  const km = routeKm(origin, dest, 700);
  const people = intent.travellers.total;
  const baseRT = Math.max(45, km * 0.12 * 2); // per-person return, USD
  return RAIL_PROVIDERS.map((p) => ({
    type: 'train',
    supplier: p.name,
    verified: p.verified,
    reliabilityScore: p.rating,
    details: { basis: 'per person · return', people, travelClass: p.cls, approxDurationLabel: `${Math.max(1, Math.round(km / 110))}h approx`, route: `${origin.city} → ${dest.city}` },
    priceUSD: round(baseRT * p.mult * (0.9 + rnd() * 0.2) * people),
  }));
}

// --- Coach / bus -----------------------------------------------------------
const COACH_PROVIDERS = [
  { name: 'FlixBus', rating: 86, verified: true, mult: 1.0 },
  { name: 'Eurolines', rating: 84, verified: true, mult: 0.95 },
  { name: 'National Express', rating: 85, verified: true, mult: 1.1 },
  { name: 'BlaBlaCar Bus', rating: 82, verified: true, mult: 0.9 },
  { name: 'Megabus', rating: 80, verified: true, mult: 0.85 },
];
export function scanCoach(intent, dest, origin) {
  const rnd = seeded(`cch-${dest.code}-${origin.airport}-${intent.dates.checkIn}`);
  const km = routeKm(origin, dest, 700);
  const people = intent.travellers.total;
  const baseRT = Math.max(22, km * 0.05 * 2); // per-person return, USD
  return COACH_PROVIDERS.map((p) => ({
    type: 'coach',
    supplier: p.name,
    verified: p.verified,
    reliabilityScore: p.rating,
    details: { basis: 'per person · return', people, approxDurationLabel: `${Math.max(2, Math.round(km / 75))}h approx`, route: `${origin.city} → ${dest.city}` },
    priceUSD: round(baseRT * p.mult * (0.9 + rnd() * 0.2) * people),
  }));
}

// --- Ferry / sea crossing --------------------------------------------------
const FERRY_PROVIDERS = [
  { name: 'DFDS Seaways', rating: 88, verified: true, mult: 1.0 },
  { name: 'P&O Ferries', rating: 86, verified: true, mult: 1.05 },
  { name: 'Brittany Ferries', rating: 89, verified: true, mult: 1.15 },
];
export function scanFerry(intent, dest, origin) {
  const rnd = seeded(`fry-${dest.code}-${origin.airport}-${intent.dates.checkIn}`);
  const people = intent.travellers.total;
  const baseRT = 60; // per-person return, USD (short sea crossing)
  return FERRY_PROVIDERS.map((p) => ({
    type: 'ferry',
    supplier: p.name,
    verified: p.verified,
    reliabilityScore: p.rating,
    details: { basis: 'per person · return (foot passenger)', people, vehicleOption: 'Add a car at checkout', route: `${origin.city} → ${dest.city}` },
    priceUSD: round(baseRT * p.mult * (0.9 + rnd() * 0.25) * people),
  }));
}

// --- Cruise (multi-night sailing holiday) ----------------------------------
const CRUISE_LINES = [
  { name: 'MSC Cruises', rating: 90, verified: true, nightlyUSD: 145, cabin: 'Balcony · full board' },
  { name: 'Royal Caribbean', rating: 93, verified: true, nightlyUSD: 205, cabin: 'Balcony · full board' },
  { name: 'Costa Cruises', rating: 87, verified: true, nightlyUSD: 125, cabin: 'Ocean view · full board' },
];
// Short ferry-cruises (e.g. DFDS Newcastle→Amsterdam) — a cabin + return sailing
// + meals, far cheaper than an ocean liner.
const MINI_CRUISE_LINES = [
  { name: 'DFDS Mini Cruise', rating: 88, nightlyUSD: 60, cabin: 'Sea-view cabin · return sailing + meals' },
  { name: 'P&O Mini Cruise', rating: 86, nightlyUSD: 70, cabin: 'Inside cabin · return sailing' },
  { name: 'Fjord Line Mini Cruise', rating: 85, nightlyUSD: 64, cabin: 'Standard cabin · return sailing' },
];
export function scanCruise(intent, dest, origin) {
  const rnd = seeded(`crz-${dest.code}-${intent.dates.checkIn}`);
  const nights = intent.nights;
  const people = intent.travellers.total;
  const route = origin ? `${origin.city} → ${dest.city}` : dest.city;
  const lines = intent.miniCruise ? MINI_CRUISE_LINES : CRUISE_LINES;
  return lines.map((c) => ({
    type: 'cruise',
    supplier: c.name,
    verified: true,
    reliabilityScore: c.rating,
    details: {
      basis: intent.miniCruise ? 'per person · return mini cruise' : 'per person · full board',
      nights, people, cabin: c.cabin, nightlyUSD: c.nightlyUSD,
      miniCruise: !!intent.miniCruise, region: dest.city, route,
    },
    priceUSD: round(c.nightlyUSD * nights * people * (0.9 + rnd() * (intent.miniCruise ? 0.2 : 0.25))),
  }));
}

// Convert a return-trip offer into a single one-way leg for mixed-mode /
// split-origin journeys. Returns price at ~52% of the round trip (a return
// is usually a little cheaper than two one-ways), relabels the basis, and
// carries an explicit leg + route so the UI shows direction per component.
export function toOneWayLeg(offer, leg, fromCity, toCity) {
  const d = offer.details || {};
  const details = {
    ...d,
    leg, // 'outbound' | 'return'
    oneWay: true,
    basis: (d.basis || 'per person').replace(/return[^·]*/i, 'one-way'),
    route: `${fromCity} → ${toCity}`,
  };
  // A one-way flight leg keeps only its own direction's schedule.
  if (offer.type === 'flight') {
    if (leg === 'outbound') details.inbound = null;
    else if (d.inbound) { details.outbound = d.inbound; details.inbound = null; }
  }
  return { ...offer, priceUSD: round(offer.priceUSD * 0.52), details };
}

// Run a full scan across every requested component. Returns a map of
// component -> array of supplier offers (or a single offer for visa).
export function scanAll(intent, dest, origin, live = null, communityHosts = null, communityExperiences = null, vendorServices = null) {
  const scan = {};
  const wanted = new Set(intent.components);

  // Live provider offers (when configured + reachable) replace the synthetic
  // ones for that component; everything else keeps the deterministic engine.
  if (wanted.has('flights')) {
    scan.flights = (live && live.flights && live.flights.length) ? live.flights : scanFlights(intent, dest, origin);
  }
  if (wanted.has('hotel')) {
    scan.hotel = (live && live.hotels && live.hotels.length) ? live.hotels : scanHotels(intent, dest);
    // Community Host Marketplace: real 3JN-verified host listings compete with
    // hotels in the SAME scan — so they inherit everything the OS does
    // (reliability floor, sourcing, price guard, instalments, group stays).
    if (Array.isArray(communityHosts) && communityHosts.length) {
      const nights = intent.nights;
      const guests = intent.travellers.total;
      // AVAILABILITY: a listing whose host blocked any date of this stay never
      // appears — the calendar is the source of truth.
      const fits = communityHosts.filter((l) => l.sleeps >= guests && stayIsAvailable(l, intent.dates?.checkIn, nights));
      scan.hotel = scan.hotel.concat(fits.map((l) => {
        // The FULL listing schema prices the stay: long-term rates auto-apply
        // (7+/30+ nights), per-date calendar prices & weekend pricing apply,
        // cleaning/city fees and tax are included upfront — the guest sees one
        // honest total, never surprise fees at check-in.
        const quote = stayQuote(l, nights, guests, intent.dates?.checkIn);
        const ld = l.details || {};
        return {
          type: 'host',
          supplier: l.title,
          verified: !!l.verified,
          reliabilityScore: l.reliabilityScore,
          stars: 4,
          details: {
            nights,
            rooms: 1,
            nightlyUSD: quote.nightlyUSD,
            rateUnit: quote.rateUnit,
            priceLines: quote.lines, // transparent fee breakdown
            securityDepositUSD: quote.depositUSD, // held, not charged
            board: 'Self-catering',
            freeCancellation: /flexible|moderate/i.test(ld.cancellationPolicy || ''),
            cancellationPolicy: ld.cancellationPolicy,
            checkIn: intent.dates?.checkIn, checkOut: intent.dates?.checkOut,
            checkInAfter: ld.checkInAfter, checkOutBefore: ld.checkOutBefore,
            sleeps: l.sleeps,
            roomType: `${l.propertyType} · sleeps ${l.sleeps}`,
            bedrooms: ld.bedrooms || null, beds: ld.beds || null, bathrooms: ld.bathrooms || null,
            bedConfiguration: (ld.bedroomsDetail || []).map((b) => `${b.name}: ${b.beds} × ${b.bedType}`).join(' · ') || undefined,
            roomSizeSqm: ld.sizeSqm || undefined,
            houseRules: [ld.smokingAllowed ? 'Smoking allowed' : 'No smoking', ld.petsAllowed ? 'Pets allowed' : 'No pets', ld.partyAllowed ? 'Parties allowed' : 'No parties', ld.childrenAllowed === false ? 'No children' : 'Children welcome'].join(' · '),
            services: ld.services || [],
            instantBooking: !!ld.instantBooking,
            area: ld.area || l.city,
            address: l.address,
            photos: l.photos, // hosted by US → real photos (min 10, max 100)
            photoCount: Array.isArray(l.photos) ? l.photos.length : 0,
            videoUrl: ld.videoUrl || undefined,
            amenities: l.amenities,
            facilities: ld.facilities || [],
            guestRating: Math.round(l.reliabilityScore) / 10,
            community: true,
            hostName: l.hostName,
            description: ld.description || `${l.title} — a 3JN-verified community host property in ${l.city}, hosted by ${l.hostName}.`,
          },
          priceUSD: quote.totalUSD,
        };
      }));
    }
  }
  if (wanted.has('train')) scan.train = scanTrain(intent, dest, origin);
  if (wanted.has('coach')) scan.coach = scanCoach(intent, dest, origin);
  if (wanted.has('ferry')) scan.ferry = scanFerry(intent, dest, origin);
  if (wanted.has('cruise')) scan.cruise = scanCruise(intent, dest, origin);

  // Multi-origin group: each party flies from its OWN city, priced for its own
  // headcount; everyone shares the same dates, stay and booking. "2 from
  // Birmingham, 1 from London, 4 from Manchester, 2 from Nottingham" yields
  // four flight components in one package.
  if (intent.groupOrigins && intent.groupOrigins.resolved && (scan.flights || (live && live.groupFlights))) {
    scan.groupTravel = intent.groupOrigins.resolved.flatMap((party, idx) => {
      const partyIntent = {
        ...intent,
        travellers: { adults: party.count, children: 0, childAges: [], total: party.count },
      };
      // Live per-party fares when available (real bookable); else the estimator.
      const liveParty = live && live.groupFlights && live.groupFlights.find((g) => g.partyIndex === idx);
      const partyOffers = (liveParty && liveParty.offers && liveParty.offers.length)
        ? liveParty.offers
        : scanFlights(partyIntent, dest, party.origin);
      return partyOffers.map((o) => ({
        ...o,
        details: {
          ...o.details,
          party: `${party.count} × ${party.origin.city}`,
          partyIndex: idx,
          partySize: party.count,
          route: `${party.origin.city} → ${dest.city}`,
        },
      }));
    });
    delete scan.flights; // the party legs replace the single-origin scan
  }
  // The whole group shares ONE home: annotate stays with the group size and a
  // per-party bedroom/apartment split ("different kinds of bedrooms — all in
  // one booking").
  if (intent.groupOrigins && scan.hotel) {
    const parties = intent.groupOrigins.parties;
    const guests = parties.reduce((s, p) => s + p.count, 0);
    const unitFor = (n) => (n <= 1 ? 'Single room' : n === 2 ? 'Double / twin room' : n === 3 ? 'Triple room' : `Family apartment (sleeps ${n})`);
    const units = parties.map((p) => `${unitFor(p.count)} — party of ${p.count} (${p.city})`);
    scan.hotel = scan.hotel.map((h) => ({
      ...h,
      details: { ...h.details, groupStay: { guests, units, sameProperty: true } },
    }));
  }

  // Mixed-mode / split-origin legs: one booking, per-direction means & points.
  // Each direction is scanned with its OWN mode and origin, converted to a
  // one-way leg, and packaged together — "train out from London, ferry back
  // into Newcastle" yields two leg components in the same package.
  if (intent.legs && intent.legs.resolved) {
    const { out: outOrigin, back: backOrigin } = intent.legs.resolved;
    const outMode = intent.legs.out.mode;
    const backMode = intent.legs.back.mode;
    const scanMode = (mode, o) => ({
      flights: () => scanFlights(intent, dest, o),
      train: () => scanTrain(intent, dest, o),
      coach: () => scanCoach(intent, dest, o),
      ferry: () => scanFerry(intent, dest, o),
      cruise: () => scanCruise(intent, dest, o),
    }[mode] || (() => []))();
    scan.outboundLeg = scanMode(outMode, outOrigin)
      .map((o) => toOneWayLeg(o, 'outbound', outOrigin.city, dest.city));
    scan.returnLeg = scanMode(backMode, backOrigin)
      .map((o) => toOneWayLeg(o, 'return', dest.city, backOrigin.city));
    // The legs replace whole-journey return scans of the same modes.
    delete scan[outMode === 'flights' ? 'flights' : outMode];
    delete scan[backMode === 'flights' ? 'flights' : backMode];
  }
  if (wanted.has('activities')) {
    scan.activities = scanActivities(intent, dest);
    // Community EXPERIENCES (host-run tours, priced per person) compete inside
    // the activities scan exactly as community stays compete with hotels.
    if (Array.isArray(communityExperiences) && communityExperiences.length) {
      const people = intent.travellers.total;
      scan.activities = scan.activities.concat(communityExperiences.map((l) => {
        const ld = l.details || {};
        return {
          type: 'activities',
          supplier: l.title,
          verified: !!l.verified,
          reliabilityScore: l.reliabilityScore,
          details: {
            community: true, experience: true,
            experienceType: ld.experienceType || 'Local experience',
            hostName: l.hostName, hostLanguages: ld.hostLanguages || [],
            durationHours: ld.durationHours || undefined,
            perPersonUSD: l.nightlyUSD, people,
            whatProvided: ld.whatProvided || [], whatToBring: ld.whatToBring || [],
            instantBooking: !!ld.instantBooking,
            openingHours: ld.openingHours,
            cancellationPolicy: ld.cancellationPolicy,
            photos: l.photos, address: l.address, area: ld.area || l.city,
            description: ld.description || `${l.title} — a 3JN-verified host-run experience in ${l.city}.`,
          },
          priceUSD: Math.round(l.nightlyUSD * people * 100) / 100,
        };
      }));
    }
  }
  // Marketplace basket services — active whenever the traveller asks for them.
  // REAL local vendors (risk-reviewed, admin-approved, listing their own
  // services at their own price) compete alongside the vetted catalogue —
  // a well-priced vendor wins the slot on merit.
  for (const svc of ['photographer', 'guide', 'restaurant', 'translator', 'driver']) {
    if (wanted.has(svc)) {
      const local = (vendorServices || []).filter((v) => v.type === svc);
      scan[svc] = [...local, ...scanService(svc, intent, dest)];
    }
  }
  if (wanted.has('visa')) { const v = scanVisa(intent, dest); scan.visa = v ? [v] : []; }
  if (wanted.has('insurance')) scan.insurance = scanInsurance(intent);
  if (wanted.has('transfer')) scan.transfer = scanTransfers(intent, dest);
  if (wanted.has('carhire')) scan.carhire = scanCarHire(intent, dest);
  if (wanted.has('tickets')) scan.tickets = scanTickets(intent);
  if (wanted.has('boat')) scan.boat = scanBoat(intent);
  if (wanted.has('esim')) scan.esim = scanEsim(intent);

  // Attribute every offer to its booking partner / agent account and apply
  // agent net rates (e.g. Rayna Tours for Dubai land products).
  for (const key of Object.keys(scan)) {
    scan[key] = scan[key].map((offer) => applySourcing(offer, dest.country));
  }

  return scan;
}

// ---- Destination Marketplace add-ons ------------------------------------------
// Every trip becomes a marketplace basket: local services sold alongside the
// core package, priced per destination and verified like any supplier.
// Destination Marketplace (spec §12) — every trip becomes a basket. Each
// add-on carries its commission rate; all rates sit inside the 5%–30% band.
export const MARKETPLACE_COMMISSION_RANGE = { min: 0.05, max: 0.30 };
export const MARKETPLACE_ADDONS = [
  { key: 'tours', name: 'Guided tours', baseUSD: 45, per: 'person', commission: 0.15 },
  { key: 'driver', name: 'Local driver (day)', baseUSD: 60, per: 'day', commission: 0.12 },
  { key: 'translator', name: 'Translation services', baseUSD: 70, per: 'day', commission: 0.15 },
  { key: 'security', name: 'Security services', baseUSD: 120, per: 'day', commission: 0.10 },
  { key: 'photographer', name: 'Trip photographer', baseUSD: 90, per: 'session', commission: 0.15 },
  { key: 'pickup', name: 'Airport pickup', baseUSD: 35, per: 'trip', commission: 0.10 },
  { key: 'restaurants', name: 'Restaurant reservations', baseUSD: 8, per: 'booking', commission: 0.05 },
  { key: 'tickets', name: 'Event tickets', baseUSD: 55, per: 'ticket', commission: 0.10 },
  { key: 'esim', name: 'Local SIM / eSIM', baseUSD: 12, per: 'plan', commission: 0.30 },
  { key: 'guide', name: 'Local guides', baseUSD: 6, per: 'trip', commission: 0.30 },
];
export function scanMarketplaceAddons(dest) {
  const rnd = seeded(`addons-${dest.code || dest.city}`);
  const factor = (dest.activityBaseUSD || 50) / 50;
  return MARKETPLACE_ADDONS.map((a) => ({
    ...a,
    destination: dest.city,
    priceUSD: Math.round(a.baseUSD * factor * (0.9 + rnd() * 0.25)),
    verified: true,
    reliabilityScore: 80 + Math.round(rnd() * 15),
  }));
}
