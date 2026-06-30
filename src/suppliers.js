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

import { visaRule } from './destinations.js';
import { applySourcing } from './partners.js';

// Deterministic pseudo-random so results are stable for a given seed (no
// Math.random — keeps runs reproducible and testable).
function seeded(seed) {
  let s = 0;
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) % 2147483647;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483647;
    return s / 2147483647;
  };
}

const AIRLINES = [
  { name: 'Emirates', rating: 96, verified: true, premium: true },
  { name: 'Qatar Airways', rating: 95, verified: true, premium: true },
  { name: 'British Airways', rating: 88, verified: true, premium: false },
  { name: 'Turkish Airlines', rating: 90, verified: true, premium: false },
  { name: 'Lufthansa', rating: 89, verified: true, premium: false },
  { name: 'Wizz Air', rating: 74, verified: true, premium: false },
  { name: 'SkyValue Air', rating: 61, verified: false, premium: false }, // unreliable — filtered out
];

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
export const RELIABILITY_FLOOR = 70;

function round(n) {
  return Math.round(n * 100) / 100;
}

// --- Flights (inbound + outbound, as the brief and the session require) ----
export function scanFlights(intent, dest, origin) {
  const rnd = seeded(`flt-${dest.code}-${origin.airport}-${intent.dates.checkIn}`);
  const pax = intent.travellers.total;
  const distanceFactor = 1 + rnd() * 0.4;

  return AIRLINES.map((a) => {
    const seatBase = dest.flightBaseUSD * distanceFactor * (a.premium ? 1.35 : 1);
    const noise = 0.85 + rnd() * 0.4;
    const perSeat = seatBase * noise * (a.rating < 75 ? 0.7 : 1); // cheap-but-risky carriers undercut
    const outboundPerSeat = round(perSeat);
    const inboundPerSeat = round(perSeat * (0.95 + rnd() * 0.2));
    const totalPerSeat = outboundPerSeat + inboundPerSeat;
    return {
      type: 'flight',
      supplier: a.name,
      verified: a.verified,
      reliabilityScore: a.rating,
      premium: a.premium,
      details: {
        outbound: {
          from: origin.airport,
          to: dest.airport,
          date: intent.dates.checkIn,
          depart: '08:25',
          arrive: '17:40',
          stops: a.premium ? 0 : (rnd() > 0.5 ? 1 : 0),
          perSeatUSD: outboundPerSeat,
        },
        inbound: {
          from: dest.airport,
          to: origin.airport,
          date: intent.dates.checkOut,
          depart: '21:10',
          arrive: '06:30',
          stops: a.premium ? 0 : (rnd() > 0.5 ? 1 : 0),
          perSeatUSD: inboundPerSeat,
        },
        passengers: pax,
        baggage: a.premium ? '2 x 30kg' : '1 x 23kg',
      },
      priceUSD: round(totalPerSeat * pax),
    };
  });
}

// --- Hotels & private hosts ------------------------------------------------
export function scanHotels(intent, dest) {
  const rnd = seeded(`htl-${dest.code}-${intent.dates.checkIn}`);
  const nights = intent.nights;
  const rooms = Math.max(1, Math.ceil(intent.travellers.total / 2));

  const hotels = HOTEL_BRANDS.map((h) => {
    const nightly = dest.hotelNightBaseUSD * (h.stars / 3) * (0.85 + rnd() * 0.5);
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
      },
      priceUSD: round(nightly * nights * rooms),
    };
  });

  // Private host (Airbnb-style) — one strong option.
  const hostNightly = dest.hotelNightBaseUSD * 0.8 * (0.8 + rnd() * 0.3);
  hotels.push({
    type: 'host',
    supplier: 'Verified Private Host — Marina Apartment',
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
    },
    priceUSD: round(hostNightly * nights),
  });

  return hotels;
}

// --- Activities ------------------------------------------------------------
export function scanActivities(intent, dest) {
  const rnd = seeded(`act-${dest.code}-${intent.dates.checkIn}`);
  const people = intent.travellers.total;
  // Pick a handful of activities scaled to the trip length.
  const count = Math.min(ACTIVITY_CATALOG.length, Math.max(2, Math.round(intent.nights / 2)));
  return ACTIVITY_CATALOG.slice(0, count).map((act) => {
    const perPerson = dest.activityBaseUSD * act.mult * (0.9 + rnd() * 0.2);
    return {
      type: 'activity',
      supplier: act.name,
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
export function scanAll(intent, dest, origin) {
  const scan = {};
  const wanted = new Set(intent.components);

  if (wanted.has('flights')) scan.flights = scanFlights(intent, dest, origin);
  if (wanted.has('hotel')) scan.hotel = scanHotels(intent, dest);
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
