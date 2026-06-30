// Booking partners & agent-account sourcing.
//
// 3JN sources each component from a real downstream supplier. Some are
// *agent accounts* (B2B wholesale) where 3JN buys at NET rates below public
// price — that net margin is what funds the "up to 30% cheaper" promise while
// 3JN still adds its transparent commission. Others are affiliate/deep-link
// partners where the customer is handed off to book.
//
// Rayna Tours is configured as the primary AGENT ACCOUNT for Dubai/UAE land
// products (activities, attraction tickets, transfers, visa, boat charters):
// the user asked to "book from here on the account of agent".
//
// The 3JN Rayna B2B agent account is configured below. The agent id, email and
// portal are non-secret identifiers and may carry defaults; the API
// key/password is a SECRET and is read from the environment ONLY — it is never
// committed. Provide RAYNA_AGENT_PASSWORD / RAYNA_API_KEY via env (see
// .env.example) for a live integration.
const env = (typeof process !== 'undefined' && process.env) ? process.env : {};
export const RAYNA_AGENT = {
  portal: env.RAYNA_PORTAL_URL || 'https://raynab2b.com/',
  agentId: env.RAYNA_AGENT_ID || 'AGT-48973',
  email: env.RAYNA_AGENT_EMAIL || 'info@3jntravel.com',
  // Secrets — env only, no default, never logged or sent to the client.
  hasCredentials: Boolean(env.RAYNA_AGENT_PASSWORD || env.RAYNA_API_KEY),
};

export const PARTNERS = {
  rayna: {
    id: 'rayna',
    name: 'Rayna Tours',
    type: 'agent',                 // 3JN books on its agent account at net rates
    url: RAYNA_AGENT.portal,       // B2B agent portal (raynab2b.com)
    retailUrl: 'https://www.raynatours.com/',
    agentId: RAYNA_AGENT.agentId,  // 3JN agent account — used to book at net rates
    agentNetDiscount: 0.18,        // ~18% below public — the agent net rate
    fulfils: ['activities', 'tickets', 'transfer', 'visa', 'boat'],
    regions: ['AE'],               // Dubai / Abu Dhabi specialism
  },
  kiwi: { id: 'kiwi', name: 'Kiwi.com', type: 'affiliate', url: 'https://www.kiwi.com/', fulfils: ['flights'], regions: ['*'] },
  trip: { id: 'trip', name: 'Trip.com', type: 'affiliate', url: 'https://uk.trip.com/', fulfils: ['hotel', 'flights'], regions: ['*'] },
  expedia: { id: 'expedia', name: 'Expedia', type: 'affiliate', url: 'https://www.expedia.co.uk/', fulfils: ['hotel', 'flights', 'activities'], regions: ['*'] },
  tiqets: { id: 'tiqets', name: 'Tiqets', type: 'affiliate', url: 'https://www.tiqets.com/', fulfils: ['tickets', 'activities'], regions: ['*'] },
  wegotrip: { id: 'wegotrip', name: 'WeGoTrip', type: 'affiliate', url: 'https://wegotrip.com/', fulfils: ['activities'], regions: ['*'] },
  searadar: { id: 'searadar', name: 'Searadar', type: 'affiliate', url: 'https://searadar.com/', fulfils: ['boat'], regions: ['*'] },
  ticketnetwork: { id: 'ticketnetwork', name: 'TicketNetwork', type: 'affiliate', url: 'https://www.ticketnetwork.com/', fulfils: ['tickets'], regions: ['*'] },
  compensair: { id: 'compensair', name: 'Compensair', type: 'disruption', url: 'https://www.compensair.com/', fulfils: ['disruption'], regions: ['*'] },
};

// Some suppliers ARE the bookable brand (the eSIM provider, the airline). When
// the chosen offer's supplier matches one of these, link straight to it rather
// than to a generic aggregator. (Affiliate ids would be appended live.)
export const BRAND_URLS = {
  'Airalo': 'https://www.airalo.com/',
  'Holafly': 'https://esim.holafly.com/',
  'Nomad eSIM': 'https://www.getnomad.app/',
  'Emirates': 'https://www.emirates.com/',
  'Qatar Airways': 'https://www.qatarairways.com/',
  'British Airways': 'https://www.britishairways.com/',
  'Turkish Airlines': 'https://www.turkishairlines.com/',
  'Lufthansa': 'https://www.lufthansa.com/',
  'Hertz': 'https://www.hertz.com/',
  'Sixt': 'https://www.sixt.com/',
  'AXA Travel': 'https://www.axa-travelinsurance.com/',
  'Allianz Assistance': 'https://www.allianz-assistance.com/',
};

// Optional per-partner affiliate / agent tracking ids (kept out of code; in a
// real deployment these come from env/secrets). Shown here as the structure.
export const PARTNER_TRACKING = {
  // rayna: { agentId: process.env.RAYNA_AGENT_ID },
  // kiwi:  { affilid: process.env.KIWI_AFFIL_ID },
};

// Supplier offers use singular component types ('flight', 'activity', 'host');
// the partner registry uses the intent vocabulary ('flights', 'activities',
// 'hotel'). Normalise so routing lines up.
const TYPE_ALIASES = {
  flight: 'flights',
  activity: 'activities',
  host: 'hotel',
};
function canonicalType(t) {
  return TYPE_ALIASES[t] || t;
}

// Choose the booking partner for a component + destination country. Prefers an
// agent account whose region matches (net rates win), else the first affiliate
// that fulfils the component.
export function partnerFor(componentType, destCountry) {
  const ct = canonicalType(componentType);
  const candidates = Object.values(PARTNERS).filter((p) => p.fulfils.includes(ct));
  // Agent account in-region first.
  const agentInRegion = candidates.find((p) => p.type === 'agent' && p.regions.includes(destCountry));
  if (agentInRegion) return agentInRegion;
  // Otherwise any agent, then any affiliate.
  return candidates.find((p) => p.type === 'agent') || candidates[0] || null;
}

// Build a booking deep-link for a component (would carry tracking ids live).
export function bookingUrl(partner) {
  return partner ? partner.url : null;
}

// Attach sourcing metadata to a supplier offer and apply the agent net rate
// where the chosen partner is an agent account. Returns a new offer object.
export function applySourcing(offer, destCountry) {
  // Live provider offers (real fares from Duffel, real schedules from OAG, real
  // hotel rates from Amadeus) keep their own attribution and are never adjusted
  // by a synthetic agent net-rate — the quoted figure is the source of truth.
  if (offer.live || offer.scheduleLive) {
    return {
      ...offer,
      publicPriceUSD: offer.publicPriceUSD || offer.priceUSD,
      sourcedVia: offer.sourcedVia || 'Live provider',
      sourcedType: offer.sourcedType || 'live',
      bookingUrl: offer.bookingUrl || null,
      agent: false,
    };
  }
  // If the supplier is itself a bookable brand, link straight to it (no agent
  // net-rate adjustment — that's the retail brand price).
  if (BRAND_URLS[offer.supplier]) {
    return { ...offer, publicPriceUSD: offer.priceUSD, sourcedVia: offer.supplier, sourcedType: 'brand', bookingUrl: BRAND_URLS[offer.supplier], agent: false };
  }

  const partner = partnerFor(offer.type, destCountry);
  if (!partner) return { ...offer, publicPriceUSD: offer.priceUSD, sourcedVia: 'Direct', bookingUrl: null, agent: false };

  let priceUSD = offer.priceUSD;
  let publicPriceUSD = offer.priceUSD;
  let agent = false;

  if (partner.type === 'agent') {
    // 3JN's buy price is the agent net rate; public price is what a retail
    // customer would pay. The gap is real saving 3JN can pass on + margin.
    publicPriceUSD = Math.round(offer.priceUSD * 100) / 100;
    priceUSD = Math.round(offer.priceUSD * (1 - partner.agentNetDiscount) * 100) / 100;
    agent = true;
  }

  return {
    ...offer,
    priceUSD,
    publicPriceUSD,
    sourcedVia: partner.name,
    sourcedType: partner.type,
    bookingUrl: partner.url,
    agentId: agent ? (partner.agentId || null) : null, // 3JN agent account id
    agent,
  };
}
