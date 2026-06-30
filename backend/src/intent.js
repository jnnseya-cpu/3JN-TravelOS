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

  // Child ages — "children 16,13 and 9 years old", "aged 16, 13, 9".
  let childAges = [];
  const ageBlock = lower.match(/(?:child|children|kid|kids|aged?|ages)[^.]*?((?:\d{1,2}\s*(?:,|and|&|\/|\s)\s*){1,}\d{1,2}|\d{1,2})\s*(?:year|yr|yo|y\.?o\.?|years?\s*old)?/);
  if (ageBlock) {
    childAges = (ageBlock[1].match(/\d{1,2}/g) || []).map(Number).filter((a) => a >= 0 && a <= 17);
  }
  // If ages were listed but the count wasn't, infer the child count from them.
  if (childAges.length && !childMatch) children = childAges.length;

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

  return { adults, children, total: adults + children, childAges };
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

// Parse explicit calendar dates from the request. Handles UK-style ranges the
// traveller actually types: "17/08 to 24/08", "17/08/2026 - 24/08/2026",
// "17-24 August", "August 17 to 24". Returns {checkIn, checkOut, nights,
// monthIndex} or null when no explicit date is present. DD/MM is assumed (the
// platform is UK-first); a value > 12 in the first slot confirms it.
function parseExplicitDates(text, today = new Date()) {
  const baseYear = today.getUTCFullYear();
  const iso = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
  const rollYear = (m) => (m < today.getUTCMonth() ? baseYear + 1 : baseYear);

  // 1) Numeric DD/MM[/YYYY] (optionally a range with to / - / – / until).
  const num = /\b(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?\s*(?:to|until|till|[\-–—])\s*(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?/i;
  let m = text.match(num);
  if (m) {
    const d1 = +m[1], mo1 = +m[2], d2 = +m[4], mo2 = +m[5];
    if (mo1 >= 1 && mo1 <= 12 && mo2 >= 1 && mo2 <= 12 && d1 <= 31 && d2 <= 31) {
      const y1 = m[3] ? normYear(m[3]) : rollYear(mo1 - 1);
      const y2 = m[6] ? normYear(m[6]) : (mo2 < mo1 ? y1 + 1 : y1);
      const ci = new Date(Date.UTC(y1, mo1 - 1, d1));
      const co = new Date(Date.UTC(y2, mo2 - 1, d2));
      const nights = Math.max(1, Math.round((co - ci) / 86400000));
      return { checkIn: iso(y1, mo1 - 1, d1), checkOut: iso(y2, mo2 - 1, d2), nights, monthIndex: mo1 - 1 };
    }
  }

  // 2) Single DD/MM[/YYYY] (no range) → use it as check-in.
  const single = /\b(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?\b/;
  m = text.match(single);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[1] <= 31) {
    const d1 = +m[1], mo1 = +m[2];
    const y1 = m[3] ? normYear(m[3]) : rollYear(mo1 - 1);
    return { checkIn: iso(y1, mo1 - 1, d1), checkOut: null, nights: null, monthIndex: mo1 - 1 };
  }

  // 3) Day range with a month name: "17-24 August" or "August 17 to 24".
  const mn = MONTHS.map((x) => x.slice(0, 3)).join('|');
  let dm = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:to|until|[\\-–—])\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s+(${mn})`, 'i'));
  if (!dm) dm = text.match(new RegExp(`\\b(${mn})[a-z]*\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:to|until|[\\-–—])\\s*(\\d{1,2})`, 'i'));
  if (dm) {
    const monthName = (dm[3] || dm[1]).toLowerCase().slice(0, 3);
    const mi = MONTHS.findIndex((x) => x.startsWith(monthName));
    const d1 = +(dm[3] ? dm[1] : dm[2]);
    const d2 = +(dm[3] ? dm[2] : dm[3]);
    if (mi >= 0 && d1 && d2) {
      const y = rollYear(mi);
      const nights = Math.max(1, d2 - d1);
      return { checkIn: iso(y, mi, d1), checkOut: iso(y, mi, d2), nights, monthIndex: mi };
    }
  }
  return null;
}

function normYear(s) {
  const n = parseInt(s, 10);
  return n < 100 ? 2000 + n : n;
}

function isoPlusNights(checkIn, nights) {
  const d = new Date(`${checkIn}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (nights || 7));
  return d.toISOString().slice(0, 10);
}

// Neighbourhood / area for the hotel ("hotel in Sheikh Zayed Road", "stay in
// Downtown"). Stops at the next clause so trailing requests aren't swallowed.
function parseHotelArea(text) {
  const m = text.match(/\b(?:hotel|stay|accommodation|apartment)\b[^.,]*?\b(?:in|on|near|at|along|around)\s+([A-Za-zÀ-ÿ' \-]+?)(?=\s*(?:,|\.|;|\band\b|\bwith\b|\bfor\b|\bplus\b|$))/i);
  if (!m) return null;
  const area = m[1].trim().replace(/\s+/g, ' ');
  // Reject generic words that aren't a place.
  if (/^(the|a|an|some|any|good|nice|cheap|best)$/i.test(area) || area.length < 3) return null;
  return area.replace(/\b\w/g, (c) => c.toUpperCase());
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

// Departure city — "from London", "departing Paris", "leaving from Lagos".
const ORIGIN_STOP = /^(to|in|for|with|on|during|next|this|and|by|the|my|our|a|an|cheapest|cheap|reliable|best|affordable|nights?|days?|weeks?|months?|please|return|one|way|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)$/i;
function parseOrigin(text) {
  const m = (text || '').match(/\b(?:from|departing(?:\s+from)?|leaving(?:\s+from)?|fly(?:ing)?\s+(?:from|out\s+of)|out\s+of)\s+(.+)/i);
  if (!m) return null;
  const words = m[1].replace(/[.,!?].*$/, '').split(/\s+/);
  const out = [];
  for (const w of words) {
    const clean = w.replace(/[^A-Za-zÀ-ÿ'’\-]/g, '');
    if (!clean || ORIGIN_STOP.test(clean) || /^\d/.test(w)) break;
    out.push(clean);
    if (out.length >= 3) break;
  }
  const name = out.join(' ').trim();
  return name && name.length > 1 ? name : null;
}

export function parseIntent(text, ctx = {}, today = new Date()) {
  const raw = (text || '').trim();
  // Worldwide: resolve a catalogue city OR synthesise any destination on Earth.
  const destination = resolveDestinationFromText(raw);
  const originCity = parseOrigin(raw);
  const travellers = parseTravellers(raw);
  const requested = parseComponents(raw);

  // Explicit calendar dates the traveller typed take priority over a bare month.
  const explicit = parseExplicitDates(raw, today);
  const monthInfo = parseMonth(raw) || (explicit ? { index: explicit.monthIndex, name: MONTHS[explicit.monthIndex] } : null);
  // Nights: an explicit range defines them; else the stated "N nights"; else default.
  const nights = (explicit && explicit.nights) || parseNights(raw);
  const dates = explicit && explicit.checkIn
    ? {
      checkIn: explicit.checkIn,
      checkOut: explicit.checkOut || isoPlusNights(explicit.checkIn, nights),
    }
    : buildDates(monthInfo, nights, today);

  // Hotel area / neighbourhood the traveller named ("hotel in Sheikh Zayed Road").
  const hotelArea = parseHotelArea(raw);

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
    originCity, // the user's stated departure city (null if not given)
    hotelArea, // requested hotel neighbourhood/road (null if not given)
    recommendedDestination: destination?.recommendedFromCountry || null,
    unresolved: destination ? [] : ['destination'],
  };
}
