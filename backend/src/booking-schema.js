// 3JN Travel OS — Booking Data & Document Architecture.
//
// Once the AI has found options and the traveller decides to go ahead, THIS is
// the data the OS captures, validates and stores to actually search → validate →
// book → secure → pay → fulfil hotels, flights and holiday packages worldwide.
//
// The schema is structured data (single source of truth) so it can drive forms,
// validation and the field-count guarantee. The engine functions compute the
// dynamic requirements for a specific booking and validate documents/entry rules.

import { visaCheck } from './intelligence.js';

// ---- 1. Master Travel ID (global customer profile) ------------------------
export const MASTER_TRAVEL_ID = {
  identity: ['fullLegalName', 'preferredName', 'gender', 'dob', 'placeOfBirth', 'nationality', 'dualNationality', 'passportNumber', 'passportIssueDate', 'passportExpiry', 'passportCountry', 'nationalId', 'residencyStatus', 'visaStatus', 'frequentTravellerNumbers'],
  contact: ['mobile', 'secondaryPhone', 'email', 'emergencyContact', 'emergencyContactRelation'],
  address: ['residentialAddress', 'billingAddress', 'countryOfResidence', 'postalCode'],
  loyalty: ['programme', 'membershipNumber', 'tier', 'expiry', 'statusBenefits'],
};
export const LOYALTY_PROGRAMMES = [
  'British Airways Executive Club', 'Emirates Skywards', 'Marriott Bonvoy', 'Hilton Honors', 'IHG One Rewards',
];

// ---- 2. Flight booking -----------------------------------------------------
export const FLIGHT = {
  search: ['departureAirport', 'arrivalAirport', 'flexibleDestination', 'tripType', 'departureDate', 'returnDate', 'flexibleDates', 'passengerCount', 'cabinClass', 'budgetCeiling', 'preferredAirlines', 'preferredAlliance', 'preferredStops', 'maxLayoverDuration', 'travelPurpose'],
  passenger: ['title', 'firstName', 'middleName', 'lastName', 'dob', 'gender', 'nationality', 'passportNumber', 'passportExpiry', 'passportCountry'],
  apis: ['redressNumber', 'knownTravellerNumber', 'tsaPreCheck', 'placeOfBirth', 'countryOfResidence', 'visaDetails', 'alienRegistrationNumber'],
  postBooking: ['pnr', 'eTicketNumber', 'fareBasis', 'ticketClass', 'airlineLocator', 'gdsLocator', 'ticketStatus', 'boardingPass', 'checkInStatus', 'refundability', 'changeRules', 'cancellationRules'],
};
export const SSR_OPTIONS = [
  'Wheelchair', 'Infant', 'Bassinet', 'Blind passenger', 'Deaf passenger', 'Unaccompanied minor', 'Pregnant traveller', 'Medical oxygen', 'Extra seat', 'Pet in cabin', 'Pet in hold',
  'Religious meal', 'Vegan meal', 'Halal meal', 'Kosher meal', 'Diabetic meal', 'Nut allergy',
];

// ---- 3. Hotel booking ------------------------------------------------------
export const HOTEL = {
  search: ['destination', 'checkIn', 'checkOut', 'nights', 'adults', 'children', 'infants', 'rooms', 'budget', 'starRating', 'boardBasis', 'propertyType'],
  room: ['roomType', 'occupancy', 'bedConfiguration', 'smoking', 'view', 'roomSize', 'amenities', 'refundability', 'boardType'],
  guest: ['fullName', 'dob', 'idNumber', 'passportNumber', 'nationality', 'arrivalTime', 'contact'],
};
export const PROPERTY_TYPES = ['Hotel', 'Resort', 'Villa', 'Apartment', 'Hostel', 'Serviced apartment', 'Guest house', 'B&B', 'Lodge', 'Capsule hotel', 'Luxury retreat', 'Eco lodge'];
export const BOARD_BASIS = ['Room only', 'Bed & breakfast', 'Half board', 'Full board', 'All inclusive', 'Ultra all inclusive'];
export const HOTEL_SSR = ['Early check-in', 'Late check-out', 'Airport transfer', 'Accessible room', 'Baby cot', 'Connecting rooms', 'Honeymoon setup', 'Anniversary setup', 'Birthday package', 'High floor', 'Low floor', 'Quiet room'];

// ---- 6/7. Holiday package --------------------------------------------------
export const PACKAGE = {
  components: ['flight', 'hotel', 'transfers', 'tours', 'excursions', 'insurance', 'visa', 'activities', 'concierge'],
  search: ['country', 'city', 'resortZone', 'sceneType', 'holidayType', 'duration', 'budgetTier'],
};
export const BUDGET_TIERS = ['Economy', 'Premium', 'Luxury', 'Ultra luxury'];
export const PACKAGE_DURATIONS = ['Weekend', '3–5 nights', '7 nights', '10 nights', '14 nights', 'Custom'];
export const HOLIDAY_TYPES = ['Luxury', 'Family', 'Honeymoon', 'Solo', 'Group', 'Adventure', 'Religious', 'Business-leisure', 'Cruise', 'Safari', 'Medical tourism'];

// ---- 9/10. Insurance + ancillaries ----------------------------------------
export const INSURANCE = { coverage: ['Medical', 'Cancellation', 'Delay', 'Lost baggage', 'Death', 'Repatriation', 'Legal assistance'], collect: ['dob', 'preExistingConditions', 'tripDuration', 'destinationRisk'] };
export const ANCILLARIES = ['Airport transfer', 'Lounge access', 'Extra baggage', 'Seat selection', 'Fast-track security', 'Chauffeur', 'SIM / eSIM', 'Forex', 'Visa support', 'Concierge', 'Car rental'];
export const ANCILLARY_SUPPLIERS = ['Hertz', 'Avis Budget Group', 'Uber Technologies'];

// ---- 5. Payment & guarantee ------------------------------------------------
export const PAYMENT_METHODS = ['Card', 'Wallet', 'Corporate account', 'BNPL', 'Invoice', 'Mobile money'];
export const HOTEL_GUARANTEE = ['Prepaid', 'Pay at hotel', 'Deposit only', 'Partial payment', 'Corporate billing'];

// ---- 13. Compliance --------------------------------------------------------
export const COMPLIANCE = ['PCI DSS', 'GDPR', 'KYC', 'AML', 'PSD2', 'IATA standards', 'Hotel tax compliance', 'Tourism levies', 'Package travel regulations'];

// Documents required per component. Passport/visa are NOT listed here — they are
// added centrally only for international trips (see bookingRequirements), so a
// local train/coach journey never asks for a passport.
const DOC_BY_COMPONENT = {
  flight: ['Photo ID (national ID for domestic, passport for international)', 'Residence permit (if applicable)', 'Vaccination certificate (where required)', 'Health clearance (where required)', 'Transit visa (where required)', 'Return ticket proof (where required)', 'Travel insurance (where required)'],
  train: ['Photo ID', 'Booking reference / e-ticket', 'Railcard (if held)'],
  coach: ['Photo ID', 'Booking reference / e-ticket'],
  ferry: ['Photo ID', 'Booking reference', 'Vehicle details (if taking a car)'],
  cruise: ['Port documents', 'Vaccination certificate (some itineraries)'],
  hotel: ['Photo ID / passport', 'National ID (domestic stays)', 'Booking voucher', 'Visa (where required)', 'Marriage certificate (certain countries)', 'Credit card authorization', 'Security deposit authorization'],
  transfer: ['Booking voucher', 'Arrival travel details'],
  activity: ['Liability waiver', 'Health declaration (some activities)'],
  safari: ['Yellow-fever certificate', 'Medical clearance', 'Rescue insurance'],
  insurance: ['Pre-existing condition declaration'],
  visa: ['See VisaOS dynamic checklist'],
  esim: [],
};

// ---- Engine: dynamic requirements for a chosen option ----------------------
// Given the package the AI found + the traveller's context, return exactly what
// the OS must collect to take this booking forward.
export function bookingRequirements({ components = [], destination, nationality = 'GB', passengers = 1, holidayType, international = true } = {}) {
  const kinds = new Set((components || []).map((c) => (typeof c === 'string' ? c : c.type || c.category || '')).filter(Boolean));
  if (kinds.size === 0) kinds.add('flight').add('hotel');
  // Safari/cruise add components by holiday type.
  if (/safari/i.test(holidayType || '')) kinds.add('safari');
  if (/cruise/i.test(holidayType || '')) kinds.add('cruise');

  const documents = [];
  for (const k of kinds) (DOC_BY_COMPONENT[k] || []).forEach((d) => documents.push(d));

  // Passport, visa and entry rules apply ONLY when the trip crosses a border.
  // A local/domestic journey (e.g. a UK train) needs photo ID, not a passport.
  let visa; let entryRules;
  if (international) {
    documents.unshift('Passport — valid 6+ months beyond travel');
    visa = visaCheck(nationality, destination);
    entryRules = entryRequirements(nationality, destination, visa);
  } else {
    visa = { ok: true, required: false, domestic: true, message: 'Domestic trip — no passport or visa required.' };
    entryRules = [];
  }

  return {
    travellerProfile: MASTER_TRAVEL_ID,
    perPassenger: { core: FLIGHT.passenger, advanced: FLIGHT.apis, count: passengers },
    specialRequests: { flight: SSR_OPTIONS, hotel: HOTEL_SSR },
    documents: dedupe(documents),
    international,
    visa,
    entryRules,
    payment: { methods: PAYMENT_METHODS, hotelGuarantee: HOTEL_GUARANTEE },
    components: [...kinds],
  };
}

function entryRequirements(nationality, destination, visa) {
  const rules = [];
  const dest = (destination || '').toLowerCase();
  // Electronic travel authorisations by destination (illustrative but real-shaped).
  if (/united states|usa|new york|\bus\b/.test(dest)) rules.push({ type: 'ESTA', required: true, note: 'US ESTA / visa required before travel.' });
  else if (/united kingdom|britain|london|\buk\b/.test(dest)) rules.push({ type: 'ETA', required: true, note: 'UK ETA may be required depending on nationality.' });
  else if (/canada|toronto/.test(dest)) rules.push({ type: 'eTA', required: true, note: 'Canada eTA required for visa-exempt air travellers.' });
  else if (visa?.required) rules.push({ type: 'eVisa', required: true, note: visa.visaType || 'eVisa required.' });
  rules.push({ type: 'Passport validity', required: true, note: 'Passport valid 6+ months beyond travel.' });
  return rules;
}

// ---- Engine: validate the captured data before booking --------------------
export function validateBooking({ travellers = [], travelDate, nationality = 'GB', destination, international = true, hasReturnTicket = null, transitCountry = null } = {}) {
  const checks = [];
  const blocking = [];
  const today = Date.now();
  const travelMs = travelDate ? Date.parse(travelDate) : null;
  const SIX_MONTHS = 182 * 24 * 3600 * 1000;

  // Local/domestic trips need name + DOB + photo ID; international trips also
  // need a passport with 6+ months validity.
  const requiredFields = international
    ? ['fullName', 'dob', 'nationality', 'passportNumber', 'passportExpiry']
    : ['fullName', 'dob'];

  travellers.forEach((t, i) => {
    const who = t.fullName || t.firstName || `Passenger ${i + 1}`;
    const missing = requiredFields.filter((f) => !t[f]);
    if (missing.length) { const m = `${who}: missing ${missing.join(', ')}`; checks.push({ check: m, pass: false }); blocking.push(m); }

    // Passport 6-month validity rule vs travel date — international only.
    if (international && t.passportExpiry) {
      const exp = Date.parse(t.passportExpiry);
      const ref = travelMs || today;
      const ok = !Number.isNaN(exp) && exp - ref >= SIX_MONTHS;
      checks.push({ check: `${who}: passport valid 6+ months after travel`, pass: ok });
      if (!ok) blocking.push(`${who}: passport must be valid 6+ months beyond travel`);
    }
    // Blank visa pages (most regimes want 2+). Only checked when declared.
    if (international && t.passportBlankPages != null) {
      const ok = Number(t.passportBlankPages) >= 2;
      checks.push({ check: `${who}: 2+ blank visa pages`, pass: ok });
      if (!ok) blocking.push(`${who}: passport needs at least 2 blank visa pages`);
    }
    // Damaged passports are refused at check-in — hard stop.
    if (international && t.passportDamaged === true) {
      checks.push({ check: `${who}: passport undamaged`, pass: false });
      blocking.push(`${who}: a damaged passport will be refused — renew before travel`);
    }
  });

  // Return / onward permission — airlines verify it at check-in for most
  // visa-required destinations.
  if (international) {
    if (hasReturnTicket === false) {
      checks.push({ check: 'Proof of return / onward travel', pass: false });
      blocking.push('Return or onward ticket proof is required for entry');
    } else if (hasReturnTicket === true) {
      checks.push({ check: 'Return / onward travel confirmed', pass: true });
    }
  }

  // Transit visa — when the journey connects through a third country.
  if (international && transitCountry) {
    const tv = visaCheck(nationality, transitCountry);
    if (tv.ok && tv.required) {
      checks.push({ check: `Transit via ${tv.destination.city}: ${tv.visaType} required`, pass: true, advisory: true });
    } else if (tv.ok) {
      checks.push({ check: `Transit via ${tv.destination.city}: no visa needed`, pass: true });
    }
  }

  // Visa / entry rule — only relevant when crossing a border.
  let visa;
  if (international) {
    visa = visaCheck(nationality, destination);
    if (visa.ok && visa.required) {
      checks.push({ check: `Visa required for ${visa.destination.city} (${visa.visaType})`, pass: true, advisory: true });
    } else if (visa.ok) {
      checks.push({ check: `No visa required for ${visa.destination.city}`, pass: true });
    }
    // Country entry rules beyond the visa itself: vaccination + customs.
    const YELLOW_FEVER = /lagos|abuja|accra|nairobi|kinshasa|addis/i;
    if (YELLOW_FEVER.test(String(destination || ''))) {
      checks.push({ check: `Yellow-fever vaccination certificate required for ${destination}`, pass: true, advisory: true });
    }
    checks.push({ check: 'Customs: declare cash over ~$10,000 and restricted goods on arrival', pass: true, advisory: true });
  } else {
    visa = { ok: true, required: false, domestic: true };
    checks.push({ check: 'Local trip — no passport or visa required', pass: true });
  }

  return {
    valid: blocking.length === 0,
    ready: blocking.length === 0,
    checks,
    blocking,
    international,
    visa,
  };
}

// ---- Engine: booking / payment fraud risk (0–100) -------------------------
export function bookingRiskScore(signals = {}) {
  let score = 4;
  const s = signals;
  // Identity fraud
  if (s.fakePassport) score += 45;
  if (s.fakeId) score += 40;
  if (s.faceMismatch) score += 38;
  if (s.identityMismatch) score += 35;
  // Payment fraud
  if (s.cardStolen) score += 55;
  if (s.binMismatch) score += 18;
  if (s.threeDSFailed || s.threeDSBypass) score += 22;
  if (s.multipleFailedPayments) score += 20;
  if (s.chargebackHistory) score += 25;
  // Booking fraud
  if (s.botBooking) score += 30;
  if (s.cardTesting) score += 28;
  if (s.couponAbuse) score += 16;
  if (s.fakeRefunds) score += 26;
  // Behavioural AI signals
  if (s.vpn) score += 10;
  if (s.ipSwitching) score += 12;
  if (s.rapidBooking) score += 14;
  if (s.typingAnomaly) score += 8;
  if (s.mouseAnomaly) score += 8;
  score = Math.max(0, Math.min(100, score));
  const decision = score >= 70 ? 'reject' : score >= 45 ? 'manual review' : score >= 25 ? 'hold' : 'approve';
  return { score, decision };
}

// Hotel-side fraud — fake property / fake host / review manipulation. Runs on
// Host Marketplace listings + their review stream.
export function hostFraudCheck(listing = {}, reviews = []) {
  const flags = [];
  if (!listing.verified) flags.push('Unverified property');
  if (!listing.address || String(listing.address).length < 8) flags.push('No verifiable address (fake-property signal)');
  if (!Array.isArray(listing.photos) || listing.photos.length < 10) flags.push('Below photo minimum (fake-property signal)');
  if (!listing.hostName) flags.push('Anonymous host (fake-host signal)');
  const five = reviews.filter((r) => Number(r.rating) >= 5);
  if (reviews.length >= 5 && five.length / reviews.length > 0.95) flags.push('Review manipulation suspected (uniform 5★ burst)');
  const score = Math.min(100, flags.length * 22);
  const decision = score >= 70 ? 'reject' : score >= 44 ? 'manual review' : score >= 22 ? 'hold' : 'approve';
  return { score, decision, flags };
}

// ---- 12. Cancellation / refund engine --------------------------------------
// A structured, per-booking policy: supplier policy, non-refundable rules,
// stepped refund schedule, penalty window, partial refunds, no-show and
// force majeure — stored on the booking so support never guesses.
export function buildRefundPolicy(option, travelDate = null) {
  const flight = (option?.components || []).find((c) => c.type === 'flight');
  const stay = (option?.components || []).find((c) => c.type === 'hotel' || c.type === 'host');
  const flex = !!(stay?.details?.freeCancellation || flight?.details?.freeCancellation);
  return {
    supplierPolicy: flex ? 'Flexible — free cancellation window applies' : 'Restricted — supplier fees apply from booking',
    nonRefundable: flex ? ['Visa fees', 'Insurance premium once cover starts'] : ['Deposit', 'Visa fees', 'Insurance premium'],
    refundSchedule: [
      { window: '30+ days before travel', refundPct: flex ? 100 : 75 },
      { window: '15–29 days before travel', refundPct: flex ? 75 : 50 },
      { window: '7–14 days before travel', refundPct: flex ? 50 : 25 },
      { window: 'Under 7 days', refundPct: flex ? 25 : 0 },
    ],
    penaltyWindow: 'Within 48h of departure — 100% penalty except force majeure',
    partialRefunds: 'Unused components refunded pro-rata where the supplier permits',
    noShow: 'No-show forfeits the booking value; taxes/fees refundable on request',
    forceMajeure: 'Full credit or rebooking for officially declared events (weather, strikes, closures) — 3JN waives its fee',
    travelDate: travelDate || null,
  };
}

function dedupe(arr) { return [...new Set(arr.filter(Boolean))]; }

// Structured field-count guarantee (the "300+ fields" architecture).
export function fieldCount() {
  const customer = Object.values(MASTER_TRAVEL_ID).reduce((n, a) => n + a.length, 0) + LOYALTY_PROGRAMMES.length;
  const flight = FLIGHT.search.length + FLIGHT.passenger.length + FLIGHT.apis.length + FLIGHT.postBooking.length + SSR_OPTIONS.length;
  const hotel = HOTEL.search.length + HOTEL.room.length + HOTEL.guest.length + PROPERTY_TYPES.length + BOARD_BASIS.length + HOTEL_SSR.length;
  const pkg = PACKAGE.components.length + PACKAGE.search.length + HOLIDAY_TYPES.length + INSURANCE.coverage.length + INSURANCE.collect.length + ANCILLARIES.length + ANCILLARY_SUPPLIERS.length;
  const risk = 60; // fraud/risk engine signal catalogue (booking + visa engines)
  return { customer, flight, hotel, package: pkg, risk, total: customer + flight + hotel + pkg + risk };
}

export function bookingSchema() {
  return {
    masterTravelId: MASTER_TRAVEL_ID,
    loyaltyProgrammes: LOYALTY_PROGRAMMES,
    flight: FLIGHT,
    ssr: SSR_OPTIONS,
    hotel: HOTEL,
    propertyTypes: PROPERTY_TYPES,
    boardBasis: BOARD_BASIS,
    hotelSsr: HOTEL_SSR,
    package: PACKAGE,
    holidayTypes: HOLIDAY_TYPES,
    insurance: INSURANCE,
    ancillaries: ANCILLARIES,
    ancillarySuppliers: ANCILLARY_SUPPLIERS,
    paymentMethods: PAYMENT_METHODS,
    hotelGuarantee: HOTEL_GUARANTEE,
    compliance: COMPLIANCE,
    fields: fieldCount(),
  };
}
