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

// Carrier hubs drive realistic non-stop service: a network carrier flies a
// route non-stop only when one end is its home country or its hub airport — so
// Emirates is non-stop Birmingham→Dubai, but Lufthansa connects via Frankfurt.
const AIRLINES = [
  { name: 'Emirates', rating: 96, verified: true, premium: true, hubCountry: 'AE', hubAirport: 'DXB' },
  { name: 'Qatar Airways', rating: 95, verified: true, premium: true, hubCountry: 'QA', hubAirport: 'DOH' },
  { name: 'British Airways', rating: 88, verified: true, premium: false, hubCountry: 'GB', hubAirport: 'LHR' },
  { name: 'Turkish Airlines', rating: 90, verified: true, premium: false, hubCountry: 'TR', hubAirport: 'IST' },
  { name: 'Lufthansa', rating: 89, verified: true, premium: false, hubCountry: 'DE', hubAirport: 'FRA' },
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

const ESIM_PROVIDERS = [
  { name: 'Airalo', rating: 92, verified: true, perGB_USD: 4.5 },
  { name: 'Holafly', rating: 87, verified: true, perGB_USD: 6.0 },
  { name: 'Nomad eSIM', rating: 85, verified: true, perGB_USD: 5.0 },
  { name: 'CheapData SIM', rating: 55, verified: false, perGB_USD: 2.0 }, // filtered out
];

const INSURERS = [
  { name: 'AXA Travel', rating: 91, verified: true, perDay_USD: 4.2 },
  { name: 'Allianz Assistance', rating: 90, verified: true, perDay_USD: 4.8 },
  { name: 'WorldNomads', rating: 86, verified: true, perDay_USD: 3.9 },
];

const TRANSFER_PROVIDERS = [
  { name: 'Blacklane', rating: 93, verified: true, mult: 1.0 },
  { name: 'Welcome Pickups', rating: 88, verified: true, mult: 0.8 },
  { name: 'Careem', rating: 84, verified: true, mult: 0.6 },
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
    return {
      type: 'flight',
      supplier: a.name,
      verified: a.verified,
      reliabilityScore: a.rating,
      premium: a.premium,
      details: {
        outbound: leg(origin.airport, origin.city, dest.airport, dest.city, intent.dates.checkIn, outDepartMin, durationMins + outStops * 80, outStops, outboundPerSeat),
        inbound: leg(dest.airport, dest.city, origin.airport, origin.city, intent.dates.checkOut, inDepartMin, durationMins + inStops * 80, inStops, inboundPerSeat),
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
function leg(fromAirport, fromCity, toAirport, toCity, date, departMin, durationMin, stops, perSeatUSD) {
  const arriveMin = departMin + durationMin;
  const nextDay = arriveMin >= 1440;
  return {
    from: fromAirport, fromCity, to: toAirport, toCity, date,
    depart: fmtMin(departMin), arrive: fmtMin(arriveMin), arriveNextDay: nextDay,
    durationMins: durationMin, durationLabel: `${Math.floor(durationMin / 60)}h ${durationMin % 60}m`,
    stops, stopLabel: stops === 0 ? 'Direct' : `${stops} stop`, perSeatUSD,
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

  const hotels = HOTEL_BRANDS.map((h) => {
    const nightly = dest.hotelNightBaseUSD * (h.stars / 3) * (0.85 + rnd() * 0.5);
    const area = areaFor();
    return {
      type: 'hotel',
      supplier: h.name,
      verified: h.verified,
      reliabilityScore: h.rating,
      stars: h.stars,
      details: {
        nights,
        rooms,
        nightlyUSD: round(nightly),
        board: h.stars >= 4 ? 'Breakfast included' : 'Room only',
        freeCancellation: h.stars >= 3,
        roomType: h.stars >= 5 ? 'Deluxe Room, City View' : h.stars >= 4 ? 'Superior Double Room' : 'Standard Double Room',
        area,
        distanceToCentreKm: Math.round((0.4 + rnd() * 5) * 10) / 10,
        guestRating: Math.round((78 + rnd() * 20)) / 10, // /10 scale e.g. 8.6
        reviews: 200 + Math.floor(rnd() * 4800),
        amenities: amenitiesFor(rnd, h.stars),
        description: `${h.name} is a ${h.stars}-star ${h.stars >= 4 ? 'premium' : 'comfortable'} stay in ${area}, ${dest.city} — verified for reliability and ideal for your ${nights}-night trip.`,
        ...hotelExtras(rnd, dest, intent, h.stars, 'hotel'),
      },
      priceUSD: round(nightly * nights * rooms),
    };
  });

  // Private host (Airbnb-style) — one strong option, named for the destination.
  const hostNightly = dest.hotelNightBaseUSD * 0.8 * (0.8 + rnd() * 0.3);
  hotels.push({
    type: 'host',
    supplier: `Verified Private Host — ${dest.city} Apartment`,
    verified: true,
    reliabilityScore: 86,
    stars: 4,
    details: {
      nights,
      rooms: 1,
      nightlyUSD: round(hostNightly),
      board: 'Self-catering, full kitchen',
      freeCancellation: true,
      sleeps: intent.travellers.total + 1,
      roomType: `Entire apartment · sleeps ${intent.travellers.total + 1}`,
      area: areaFor(),
      distanceToCentreKm: Math.round((0.3 + rnd() * 3) * 10) / 10,
      guestRating: Math.round((86 + rnd() * 12)) / 10,
      reviews: 60 + Math.floor(rnd() * 900),
      amenities: ['Full kitchen', 'Free WiFi', 'Washing machine', 'Self check-in', 'Workspace', 'Family friendly'],
      description: `A verified entire apartment in ${dest.city} with a full kitchen — great value and space for your group.`,
      ...hotelExtras(rnd, dest, intent, 4, 'host'),
    },
    priceUSD: round(hostNightly * nights),
  });

  return hotels;
}

// Extended, realistic accommodation detail so the traveller can decide with
// confidence — times, policies, room spec, payment options and what's nearby.
function hotelExtras(rnd, dest, intent, stars, type) {
  const propertyType = type === 'host' ? 'Entire apartment'
    : stars >= 5 ? 'Luxury hotel' : stars >= 4 ? 'Resort / 4★ hotel' : 'City hotel';
  const beds = intent.travellers.children
    ? '1 king + 1 sofa bed (family room)'
    : intent.travellers.total >= 3 ? '2 double beds' : '1 queen bed';
  const checkIn = type === 'host' ? 'Self check-in from 15:00' : '15:00';
  const exp = destExperiences(dest.code);
  const landmarks = (exp.length ? exp : [`${dest.city} City Centre`, `${dest.city} Old Town`, `${dest.city} Waterfront`]).slice(0, 3);
  return {
    propertyType,
    checkInTime: checkIn,
    checkOutTime: type === 'host' ? '11:00' : '12:00',
    cancellationDeadline: stars >= 3 ? 'Free cancellation until 48h before check-in' : 'Non-refundable rate',
    bedConfiguration: beds,
    roomSizeSqm: 18 + Math.round(rnd() * (stars >= 5 ? 42 : 22)),
    maxOccupancy: intent.travellers.total + (type === 'host' ? 1 : 0),
    breakfastDetail: stars >= 4 ? 'Full buffet breakfast included' : stars >= 3 ? 'Continental breakfast (optional add-on)' : 'Breakfast not included',
    paymentOptions: ['Pay deposit now + instalments', 'Pay in full now', stars >= 3 ? 'Pay at the property' : 'Prepaid only'].filter(Boolean),
    depositPolicy: stars >= 4 ? 'Card pre-authorisation for incidentals at check-in' : 'Refundable damage deposit may apply',
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
export function scanVisa(intent, dest) {
  const rule = visaRule(dest, intent.nationality);
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
  return TRANSFER_PROVIDERS.map((t) => ({
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
  const gb = Math.max(3, Math.round(intent.nights * 1.5));
  return ESIM_PROVIDERS.map((p) => ({
    type: 'esim',
    supplier: p.name,
    verified: p.verified,
    reliabilityScore: p.rating,
    details: { dataGB: gb, validityDays: intent.nights + 2, perGB_USD: p.perGB_USD },
    priceUSD: round(p.perGB_USD * gb),
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

// Run a full scan across every requested component. Returns a map of
// component -> array of supplier offers (or a single offer for visa).
export function scanAll(intent, dest, origin, live = null) {
  const scan = {};
  const wanted = new Set(intent.components);

  // Live provider offers (when configured + reachable) replace the synthetic
  // ones for that component; everything else keeps the deterministic engine.
  if (wanted.has('flights')) {
    scan.flights = (live && live.flights && live.flights.length) ? live.flights : scanFlights(intent, dest, origin);
  }
  if (wanted.has('hotel')) {
    scan.hotel = (live && live.hotels && live.hotels.length) ? live.hotels : scanHotels(intent, dest);
  }
  if (wanted.has('activities')) scan.activities = scanActivities(intent, dest);
  if (wanted.has('visa')) scan.visa = [scanVisa(intent, dest)];
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
