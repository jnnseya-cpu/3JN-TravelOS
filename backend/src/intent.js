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

import { findDestination, resolveDestinationFromText, airportForCity } from './destinations.js';

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

// Component requests we recognise, with the phrases that trigger them. The OS is
// multi-modal: a traveller can search trains, coaches, cruises or ferries — and
// must see ONLY what they ask for (no auto flights/hotel/activities).
const COMPONENT_TRIGGERS = {
  flights: ['flight', 'flights', 'fly', 'flying', 'airfare', 'plane'],
  train: ['train', 'trains', 'rail', 'eurostar', 'by rail', 'tgv', 'railway'],
  coach: ['coach', 'bus', 'megabus', 'flixbus', 'national express', 'by coach'],
  cruise: ['cruise', 'cruises', 'cruising', 'cruise ship', 'ocean liner'],
  ferry: ['ferry', 'ferries', 'crossing', 'by sea'],
  hotel: ['hotel', 'accommodation', 'stay', 'resort', 'apartment', 'host', 'airbnb', 'hostel', 'lodge', 'villa'],
  visa: ['visa'],
  activities: ['activity', 'activities', 'tours', 'excursion', 'things to do', 'experiences'],
  esim: ['internet', 'esim', 'e-sim', 'roaming', 'data abroad', 'sim card', 'sim'],
  transfer: ['transfer', 'airport pickup', 'airport pick-up', 'chauffeur', 'taxi'],
  carhire: ['car rental', 'car hire', 'rent a car', 'hire a car', 'bike rental', 'bike hire', 'scooter', 'self drive', 'self-drive'],
  tickets: ['event ticket', 'concert', 'show ticket', 'match ticket', 'attraction ticket', 'theatre', 'sports ticket'],
  boat: ['yacht', 'boat', 'sailing', 'catamaran', 'dhow', 'yacht charter'],
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
    // "family of 5", "group of 4", "party of 6" — an explicit headcount wins.
    const groupOf = lower.match(/\b(family|group|party)\s+of\s+(\d+)\b/);
    const peopleMatch = lower.match(/(\d+)\s*(?:people|persons|pax|travellers|travelers|of us|of you)\b/);
    if (groupOf) {
      const n = Math.max(1, parseInt(groupOf[2], 10));
      if (groupOf[1] === 'family') { adults = Math.min(2, n); children = Math.max(0, n - 2); } // 2 adults + the rest children
      else { adults = n; }
    } else if (peopleMatch) {
      adults = Math.max(1, parseInt(peopleMatch[1], 10));
    } else if (/\bfamily\b/.test(lower)) {
      adults = 2;
      children = 2;
    } else if (/\bcouple\b|\bwife\b|\bhusband\b|\bpartner\b/.test(lower)) {
      adults = 2;
    } else if (/\bsolo\b|\balone\b|\bmyself\b/.test(lower)) {
      adults = 1;
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
  const lower = ` ${text.toLowerCase()} `;
  const requested = new Set();
  for (const [component, triggers] of Object.entries(COMPONENT_TRIGGERS)) {
    // Whole-word match so "bus" doesn't fire on "business", "sim" on "simple", etc.
    if (triggers.some((t) => new RegExp(`\\b${t.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i').test(lower))) {
      requested.add(component);
    }
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
const ORIGIN_STOP = /^(to|in|for|with|on|during|next|this|and|by|the|my|our|a|an|cheapest|cheap|reliable|best|affordable|nights?|days?|weeks?|months?|please|return|one|way|alone|solo|myself|together|only|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)$/i;
function parseOrigin(text) {
  const m = (text || '').match(/\b(?:from|departing(?:\s+from)?|leaving(?:\s+from)?|fly(?:ing)?\s+(?:from|out\s+of)|out\s+of)\s+(.+)/i);
  if (!m) {
    // No explicit "from" — handle a leading "<City> to <Dest>" (e.g. the user's
    // "Birmingham to Kinshasa"), where the first token is a KNOWN city.
    const lead = (text || '').match(/^\s*([A-Za-zÀ-ÿ'’\- ]{3,30}?)\s+to\s+/i);
    if (lead) {
      const cand = lead[1].trim().replace(/\s+/g, ' ');
      if (airportForCity(cand)) return cand;
      // Try just the last word of the lead (e.g. "travel Birmingham to ...").
      const lastWord = cand.split(' ').pop();
      if (lastWord && airportForCity(lastWord)) return lastWord;
    }
    return null;
  }
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

// Mixed-mode / multi-origin legs — one booking, different means and different
// departure points per direction: "out by train from London, back by ferry
// into Newcastle", "fly from Heathrow, returning into Manchester".
const LEG_MODE = { fly: 'flights', flight: 'flights', flights: 'flights', plane: 'flights', air: 'flights', train: 'train', rail: 'train', eurostar: 'train', coach: 'coach', bus: 'coach', ferry: 'ferry', cruise: 'cruise' };
const MODE_WORDS = 'fly|flight|flights|plane|air|train|rail|eurostar|coach|bus|ferry|cruise';
function parseLegs(raw) {
  const t = raw || '';
  const norm = (w) => LEG_MODE[(w || '').toLowerCase()] || null;
  // Outbound mode: "out/going/there by train", "train out", "take the train there".
  const outBy = t.match(new RegExp(`\\b(?:out(?:bound)?|going|go|there|travel(?:ling)? out)\\s+by\\s+(${MODE_WORDS})\\b`, 'i'))
    || t.match(new RegExp(`\\b(${MODE_WORDS})\\s+(?:out|there)\\b`, 'i'));
  // Return mode: "back/returning/home by ferry", "ferry back", "fly home".
  const backBy = t.match(new RegExp(`\\b(?:back|home|return(?:ing)?|coming back|come back)\\s+by\\s+(${MODE_WORDS})\\b`, 'i'))
    || t.match(new RegExp(`\\b(${MODE_WORDS})\\s+(?:back|home)\\b`, 'i'));
  // Return arrival point: "back into Newcastle", "returning (by ferry) into
  // Manchester" — a couple of words may sit between the return cue and "into".
  const backTo = t.match(/\b(?:back|return(?:ing)?)(?:\s+[\w'’-]+){0,3}?\s+(?:in)?to\s+([A-ZÀ-Þ][\w'’-]*(?:\s+[A-ZÀ-Þ][\w'’-]*)?)/);
  const outMode = norm(outBy && outBy[1]);
  const backMode = norm(backBy && backBy[1]);
  const backToCity = backTo ? backTo[1].trim() : null;
  // Legs exist only when the directions genuinely differ — different modes, or
  // a different return arrival point (split airports/stations/ports).
  if ((outMode && backMode && outMode !== backMode) || backToCity) {
    return { out: { mode: outMode || backMode || 'flights' }, back: { mode: backMode || outMode || 'flights', to: backToCity } };
  }
  return null;
}

// Group origins — one group converging from several departure cities in the
// SAME booking: "2 will come from Birmingham, 1 from London, 4 from Manchester
// and 2 from Nottingham". Each party keeps its own origin; dates, stay and
// booking are shared.
function parseGroupOrigins(raw) {
  const parties = [];
  // "<count> [will] [come/travel/fly/depart/leave/go] from <City>" — the verb is
  // optional but constrained, so "7 nights from London" can never match.
  const re = /(\d+)\s+(?:(?:will|would)\s+)?(?:come(?:s)?|coming|travel(?:ling|ing)?|depart(?:ing)?|fly(?:ing)?|flies|leave|leaving|going|go)?\s*from\s+([A-ZÀ-Þ][A-Za-zÀ-ÿ'’-]*(?:\s+[A-ZÀ-Þ][A-Za-zÀ-ÿ'’-]*)?)/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const count = parseInt(m[1], 10);
    if (count >= 1 && count <= 40) parties.push({ count, city: m[2].trim() });
  }
  // A group needs at least two distinct parties; a single "<n> from <city>"
  // is just a headcount + origin, already handled by the base parsers.
  return parties.length >= 2 ? parties : null;
}

export function parseIntent(text, ctx = {}, today = new Date()) {
  const raw = (text || '').trim();
  // Worldwide: resolve a catalogue city OR synthesise any destination on Earth.
  const destination = resolveDestinationFromText(raw);
  const originCity = parseOrigin(raw);
  const travellers = parseTravellers(raw);

  // Multi-origin group: parties from different cities, one shared booking.
  const groupParties = parseGroupOrigins(raw);
  if (groupParties) {
    const total = groupParties.reduce((s, p) => s + p.count, 0);
    travellers.adults = Math.max(1, total - (travellers.children || 0));
    travellers.total = travellers.adults + (travellers.children || 0);
  }
  const requested = parseComponents(raw);

  // Explicit calendar dates the traveller typed take priority over a bare month.
  const explicit = parseExplicitDates(raw, today);
  const monthInfo = parseMonth(raw) || (explicit ? { index: explicit.monthIndex, name: MONTHS[explicit.monthIndex] } : null);
  // A "mini cruise" is a short 2-night ferry-cruise (e.g. Newcastle→Amsterdam),
  // NOT a week-long ocean liner — price and default duration differ.
  const miniCruise = /\bmini[\s-]?cruise\b/i.test(raw);
  // Nights: an explicit range defines them; else the stated "N nights"; else
  // default (2 for a mini cruise when nothing is stated, otherwise 7).
  const nightsStated = /\d+\s*(?:night|nights|day|days|week|weeks)/i.test(raw);
  let nights = (explicit && explicit.nights) || parseNights(raw);
  if (miniCruise && !nightsStated && !(explicit && explicit.nights)) nights = 2;
  const dates = explicit && explicit.checkIn
    ? {
      checkIn: explicit.checkIn,
      checkOut: explicit.checkOut || isoPlusNights(explicit.checkIn, nights),
    }
    : buildDates(monthInfo, nights, today);

  // Board basis — "all inclusive", "half board", "B&B", "room only"…
  const BOARD_PATTERNS = [
    [/(ultra[\s-]?all[\s-]?inclusive)/i, 'Ultra all inclusive'],
    [/all[\s-]?inclusive/i, 'All inclusive'],
    [/full[\s-]?board/i, 'Full board'],
    [/half[\s-]?board/i, 'Half board'],
    [/bed\s*(?:&|and)\s*breakfast|\bb\s*&\s*b\b|\bbnb\b|with breakfast/i, 'Bed & breakfast'],
    [/room[\s-]?only|self[\s-]?catering/i, 'Room only'],
  ];
  const boardBasis = (BOARD_PATTERNS.find(([re]) => re.test(raw)) || [])[1] || null;

  // Hotel area / neighbourhood the traveller named ("hotel in Sheikh Zayed Road").
  const hotelArea = parseHotelArea(raw);

  const wantsInstalments = /instal?ment|instalments|monthly|pay later|split/i.test(raw);
  const wantsCheapestReliable = /cheapest|reliable|best price|value|affordable/i.test(raw);

  // Deliver exactly what the traveller asked for — the plain-English promise.
  // We NEVER invent components they didn't express. When they name none, we
  // infer only the obvious: an explicit holiday/package → the full bundle; a
  // clear "travel + stay" phrasing (nights/week/trip/visit) → flights + hotel;
  // anything genuinely unspecified → ask what they need (handled in plan()).
  const wantsFullPackage = /\b(holiday|holidays|package|all.?inclusive|getaway|vacation|honeymoon|full package|complete trip|everything)\b/i.test(raw);
  const travelStaySignal = /\b(\d+\s*(?:night|nights|day|days|week|weeks)|weekend|trip|travel|travelling|traveling|visit|visiting|staying|go to|going to|getaway)\b/i.test(raw);

  // Did the traveller EXPLICITLY name how to travel? If not, the planner opens
  // the journey to mode competition (ferry vs coach vs train vs flight).
  const modesExplicit = ['flights', 'train', 'coach', 'ferry', 'cruise'].some((m) => requested.has(m));

  // Mixed-mode / split-origin legs (one booking, per-direction means & points).
  let legs = parseLegs(raw);
  // "back to <destination>" is a round trip, not a split return point.
  if (legs && legs.back.to && destination && destination.city && legs.back.to.toLowerCase() === destination.city.toLowerCase()) {
    legs.back.to = null;
    if (legs.out.mode === legs.back.mode) legs = null;
  }
  if (legs) {
    requested.add(legs.out.mode);
    requested.add(legs.back.mode);
  }
  // A multi-origin group implies getting everyone there: default to flights
  // when no journey mode was named ("a group traveling to Morocco by plane"
  // names it; "2 from Birmingham, 4 from Manchester to Marrakech" does not).
  if (groupParties && !['flights', 'train', 'coach', 'ferry', 'cruise'].some((m) => requested.has(m))) {
    requested.add('flights');
  }

  let needComponents = false;
  if (requested.size === 0 && destination) {
    if (wantsFullPackage) ['flights', 'hotel', 'activities', 'transfer', 'esim'].forEach((c) => requested.add(c));
    else if (travelStaySignal) ['flights', 'hotel'].forEach((c) => requested.add(c)); // implied "get there + stay"
    else needComponents = true; // truly unspecified — ask rather than assume
  }

  return {
    raw,
    destination, // null if not recognised
    travellers,
    nights,
    month: monthInfo ? monthInfo.name : null,
    dates,
    components: [...requested],
    needComponents, // true → user named a place but no need; ask what they want
    wantsInstalments,
    wantsCheapestReliable,
    priority: wantsCheapestReliable ? 'cheapest-reliable' : 'balanced',
    nationality: ctx.country || 'GB',
    originCity, // the user's stated departure city (null if not given)
    modesExplicit: modesExplicit || !!legs || !!groupParties, // journey mode named by the traveller
    legs, // mixed-mode / split-origin legs (null for a simple round trip)
    groupOrigins: groupParties ? { parties: groupParties } : null, // multi-origin group, one booking
    miniCruise, // short ferry-cruise rather than an ocean liner
    hotelArea, // requested hotel neighbourhood/road (null if not given)
    boardBasis, // requested board (Room only … Ultra all inclusive) or null
    recommendedDestination: destination?.recommendedFromCountry || null,
    unresolved: destination ? [] : ['destination'],
  };
}
