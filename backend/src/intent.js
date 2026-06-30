// Natural-language travel intent parser.
//
// The brief asks the system to "understand the travel intent" from a sentence
// like:
//   "I want to travel to Dubai with my family in August for 7 nights. I want
//    flights, hotel, visa, activities, internet abroad, airport transfer,
//    instalments and the cheapest reliable price."
//
// A production system would route this through an LLM. To keep the prototype
// fully self-contained and deterministic we use a rule-based parser that is
// good enough to demonstrate the full pipeline. It returns a normalised intent
// object the rest of the OS consumes.

import { findDestination, resolveDestinationFromText } from './destinations.js';

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

// Component requests we recognise, with the phrases that trigger them.
const COMPONENT_TRIGGERS = {
  flights: ['flight', 'fly', 'airfare', 'plane'],
  hotel: ['hotel', 'accommodation', 'stay', 'resort', 'apartment', 'host', 'airbnb'],
  visa: ['visa'],
  activities: ['activity', 'activities', 'tours', 'excursion', 'things to do', 'experiences'],
  esim: ['internet', 'esim', 'e-sim', 'roaming', 'data abroad', 'sim'],
  transfer: ['transfer', 'airport pickup', 'airport pick-up', 'chauffeur', 'taxi'],
  carhire: ['car rental', 'car hire', 'rent a car', 'hire a car', 'bike rental', 'bike hire', 'scooter', 'self drive', 'self-drive'],
  tickets: ['event ticket', 'concert', 'show ticket', 'match ticket', 'attraction ticket', 'theatre', 'sports ticket'],
  boat: ['yacht', 'boat', 'charter', 'sailing', 'cruise', 'catamaran', 'dhow'],
  insurance: ['insurance', 'cover', 'protection'],
};

function parseTravellers(text) {
  const lower = text.toLowerCase();
  let adults = 1;
  let children = 0;

  const adultMatch = lower.match(/(\d+)\s*adult/);
  const childMatch = lower.match(/(\d+)\s*(child|children|kid)/);
  if (adultMatch) adults = parseInt(adultMatch[1], 10);
  if (childMatch) children = parseInt(childMatch[1], 10);

  if (!adultMatch && !childMatch) {
    if (/\bfamily\b/.test(lower)) {
      adults = 2;
      children = 2;
    } else if (/\bcouple\b|\bwife\b|\bhusband\b|\bpartner\b/.test(lower)) {
      adults = 2;
    } else if (/\bsolo\b|\balone\b|\bmyself\b/.test(lower)) {
      adults = 1;
    } else {
      const peopleMatch = lower.match(/(\d+)\s*(people|persons|pax|travellers|travelers|of us)/);
      if (peopleMatch) adults = parseInt(peopleMatch[1], 10);
    }
  }

  return { adults, children, total: adults + children };
}

function parseNights(text) {
  const lower = text.toLowerCase();
  const nightMatch = lower.match(/(\d+)\s*night/);
  if (nightMatch) return parseInt(nightMatch[1], 10);
  const dayMatch = lower.match(/(\d+)\s*day/);
  if (dayMatch) return Math.max(1, parseInt(dayMatch[1], 10) - 1);
  const weekMatch = lower.match(/(\d+)\s*week/);
  if (weekMatch) return parseInt(weekMatch[1], 10) * 7;
  return 7; // sensible default
}

function parseMonth(text) {
  const lower = text.toLowerCase();
  for (let i = 0; i < MONTHS.length; i++) {
    if (lower.includes(MONTHS[i])) return { index: i, name: MONTHS[i] };
  }
  return null;
}

function parseComponents(text) {
  const lower = text.toLowerCase();
  const requested = new Set();
  for (const [component, triggers] of Object.entries(COMPONENT_TRIGGERS)) {
    if (triggers.some((t) => lower.includes(t))) requested.add(component);
  }
  return requested;
}

// Build a check-in date for the requested month, in the current or next year.
function buildDates(monthInfo, nights, today = new Date()) {
  const targetMonth = monthInfo ? monthInfo.index : (today.getMonth() + 1) % 12;
  let year = today.getFullYear();
  // If the month has already passed this year, roll to next year.
  if (targetMonth < today.getMonth() || (targetMonth === today.getMonth() && today.getDate() > 20)) {
    year += 1;
  }
  const checkIn = new Date(Date.UTC(year, targetMonth, 12));
  const checkOut = new Date(checkIn);
  checkOut.setUTCDate(checkOut.getUTCDate() + nights);
  return {
    checkIn: checkIn.toISOString().slice(0, 10),
    checkOut: checkOut.toISOString().slice(0, 10),
  };
}

export function parseIntent(text, ctx = {}, today = new Date()) {
  const raw = (text || '').trim();
  // Worldwide: resolve a catalogue city OR synthesise any destination on Earth.
  const destination = resolveDestinationFromText(raw);
  const travellers = parseTravellers(raw);
  const nights = parseNights(raw);
  const monthInfo = parseMonth(raw);
  const requested = parseComponents(raw);
  const dates = buildDates(monthInfo, nights, today);

  const wantsInstalments = /instal?ment|instalments|monthly|pay later|split/i.test(raw);
  const wantsCheapestReliable = /cheapest|reliable|best price|value|affordable/i.test(raw);

  // If the user listed no explicit components but clearly wants a trip, assume a
  // sensible full package.
  if (requested.size === 0 && destination) {
    ['flights', 'hotel', 'activities', 'transfer', 'esim'].forEach((c) => requested.add(c));
  }

  return {
    raw,
    destination, // null if not recognised
    travellers,
    nights,
    month: monthInfo ? monthInfo.name : null,
    dates,
    components: [...requested],
    wantsInstalments,
    wantsCheapestReliable,
    priority: wantsCheapestReliable ? 'cheapest-reliable' : 'balanced',
    nationality: ctx.country || 'GB',
    unresolved: destination ? [] : ['destination'],
  };
}
