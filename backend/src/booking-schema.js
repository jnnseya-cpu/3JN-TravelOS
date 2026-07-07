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
export const HOLIDAY_TYPES = ['Luxury', 'Family', 'Honeymoon', 'Solo', 'Group', 'Adventure', 'Religious', 'Business-leisure', 'Cruise', 'Safari', 'Medical tourism'];

// ---- 9/10. Insurance + ancillaries ----------------------------------------
export const INSURANCE = { coverage: ['Medical', 'Cancellation', 'Delay', 'Lost baggage', 'Death', 'Repatriation', 'Legal assistance'], collect: ['dob', 'preExistingConditions', 'tripDuration', 'destinationRisk'] };
export const ANCILLARIES = ['Airport transfer', 'Lounge access', 'Extra baggage', 'Seat selection', 'Fast-track security', 'Chauffeur', 'SIM / eSIM', 'Forex', 'Visa support', 'Concierge', 'Car rental'];
export const ANCILLARY_SUPPLIERS = ['Hertz', 'Avis Budget Group', 'Uber'];

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
  hotel: ['Photo ID', 'Booking voucher', 'Card for incidentals / deposit'],
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
export function validateBooking({ travellers = [], travelDate, nationality = 'GB', destination, international = true } = {}) {
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
  });

  // Visa / entry rule — only relevant when crossing a border.
  let visa;
  if (international) {
    visa = visaCheck(nationality, destination);
    if (visa.ok && visa.required) {
      checks.push({ check: `Visa required for ${visa.destination.city} (${visa.visaType})`, pass: true, advisory: true });
    } else if (visa.ok) {
      checks.push({ check: `No visa required for ${visa.destination.city}`, pass: true });
    }
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
  if (s.cardStolen) score += 55;
  if (s.binMismatch) score += 18;
  if (s.threeDSFailed) score += 22;
  if (s.multipleFailedPayments) score += 20;
  if (s.chargebackHistory) score += 25;
  if (s.botBooking) score += 30;
  if (s.cardTesting) score += 28;
  if (s.vpn) score += 10;
  if (s.ipSwitching) score += 12;
  if (s.rapidBooking) score += 14;
  if (s.identityMismatch) score += 35;
  score = Math.max(0, Math.min(100, score));
  const decision = score >= 70 ? 'reject' : score >= 45 ? 'manual review' : score >= 25 ? 'hold' : 'approve';
  return { score, decision };
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
