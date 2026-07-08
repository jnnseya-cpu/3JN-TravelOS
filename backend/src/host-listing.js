// Host listing schema — the COMPLETE professional listing model a host fills in
// when setting up a property (docs: user-dictated schema, Homey-class):
//   Information · Pricing (per night/day/hour/week/month/stay, weekends,
//   instant booking) · Long-term pricing (7+ / 30+) · Additional costs
//   (extra guests, cleaning fee, city fee, security deposit, tax) · Features
//   (amenities + facilities) · Media (photos + video) · Location (full
//   address → area → zip → lat/long) · Bedrooms (per-room detail) · Services ·
//   Terms & rules (cancellation, min/max stay, check-in/out, house rules) ·
//   Opening hours (hourly listings).
//
// stayQuote() turns all of that into ONE transparent price for a stay — the
// same maths the search pipeline, the booking and the host payout all use.

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const num = (v, min = 0, max = 1e9) => Math.max(min, Math.min(max, Number(v) || 0));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ---- Common time/guest units (singular/plural labels) -----------------------
export const RATE_UNITS = {
  night: { key: 'night', one: 'night', many: 'nights', label: 'Nightly' },
  day: { key: 'day', one: 'day', many: 'days', label: 'Daily' },
  hour: { key: 'hour', one: 'hour', many: 'hours', label: 'Hourly' },
  week: { key: 'week', one: 'week', many: 'weeks', label: 'Weekly' },
  month: { key: 'month', one: 'month', many: 'months', label: 'Monthly' },
  stay: { key: 'stay', one: 'stay', many: 'stays', label: 'Per stay' },
};
export const GUEST_LABELS = { one: 'guest', many: 'guests' };
export const FEE_TYPES = ['per stay', 'per night', 'per guest'];
export const CANCELLATION_POLICIES = ['Flexible — full refund until 24h before', 'Moderate — full refund until 5 days before', 'Strict — 50% refund until 7 days before', 'Non-refundable'];
export const BED_TYPES = ['Double', 'King', 'Queen', 'Twin', 'Single', 'Sofa bed', 'Bunk bed'];

// ---- Full-schema sanitizer ---------------------------------------------------
// Accepts the raw form payload; returns the structured, bounded listing detail.
export function sanitizeListingDetails(x = {}) {
  const unit = RATE_UNITS[x.rateUnit] ? x.rateUnit : 'night';
  return {
    // Information
    description: str(x.description, 2000),
    roomType: str(x.roomType, 60),
    listingType: str(x.listingType || x.propertyType, 40),
    bedrooms: num(x.bedrooms, 0, 30),
    beds: num(x.beds, 0, 60),
    bathrooms: num(x.bathrooms, 0, 30),
    rooms: num(x.rooms, 0, 60),
    sizeSqm: num(x.sizeSqm, 0, 10000),
    sizeUnit: ['sqm', 'sqft'].includes(x.sizeUnit) ? x.sizeUnit : 'sqm',
    // Pricing
    rateUnit: unit,
    instantBooking: !!x.instantBooking,
    weekendPriceUSD: num(x.weekendPriceUSD, 0, 100000),
    weekendDays: Array.isArray(x.weekendDays) ? x.weekendDays.filter((d) => ['Fri', 'Sat', 'Sun'].includes(d)) : ['Fri', 'Sat'],
    afterPriceLabel: str(x.afterPriceLabel, 40),
    // Long-term pricing (auto-applies at 7+/30+ units)
    weeklyRateUSD: num(x.weeklyRateUSD, 0, 100000),   // per night when staying 7+
    monthlyRateUSD: num(x.monthlyRateUSD, 0, 100000), // per night when staying 30+
    // Additional costs
    allowAdditionalGuests: !!x.allowAdditionalGuests,
    includedGuests: num(x.includedGuests, 1, 40),
    additionalGuestFeeUSD: num(x.additionalGuestFeeUSD, 0, 10000),
    cleaningFeeUSD: num(x.cleaningFeeUSD, 0, 10000),
    cleaningFeeType: FEE_TYPES.includes(x.cleaningFeeType) ? x.cleaningFeeType : 'per stay',
    cityFeeUSD: num(x.cityFeeUSD, 0, 10000),
    cityFeeType: FEE_TYPES.includes(x.cityFeeType) ? x.cityFeeType : 'per night',
    securityDepositUSD: num(x.securityDepositUSD, 0, 100000),
    taxPct: num(x.taxPct, 0, 40),
    // Features
    facilities: (Array.isArray(x.facilities) ? x.facilities : String(x.facilities || '').split(',')).map((a) => str(a, 40)).filter(Boolean).slice(0, 20),
    // Media
    videoUrl: str(x.videoUrl, 300),
    // Location detail (street address is on the listing root; these refine it)
    apt: str(x.apt, 60), country: str(x.country, 60), state: str(x.state, 60),
    area: str(x.area, 80), zip: str(x.zip, 16),
    lat: x.lat != null ? num(x.lat, -90, 90) : null,
    lng: x.lng != null ? num(x.lng, -180, 180) : null,
    // Bedrooms (per-room detail)
    bedroomsDetail: (Array.isArray(x.bedroomsDetail) ? x.bedroomsDetail : []).slice(0, 30).map((b) => ({
      name: str(b.name, 40) || 'Bedroom', guests: num(b.guests, 0, 10), beds: num(b.beds, 0, 10),
      bedType: BED_TYPES.includes(b.bedType) ? b.bedType : str(b.bedType, 24) || 'Double',
    })),
    // Paid services offered with the stay
    services: (Array.isArray(x.services) ? x.services : []).slice(0, 20).map((s) => ({
      name: str(s.name, 60), priceUSD: num(s.priceUSD, 0, 10000), description: str(s.description, 200),
    })).filter((s) => s.name),
    // Terms & rules
    cancellationPolicy: CANCELLATION_POLICIES.includes(x.cancellationPolicy) ? x.cancellationPolicy : str(x.cancellationPolicy, 120) || CANCELLATION_POLICIES[1],
    minStay: num(x.minStay, 0, 365), maxStay: num(x.maxStay, 0, 365), // in rateUnit units
    checkInAfter: str(x.checkInAfter, 8) || '15:00',
    checkOutBefore: str(x.checkOutBefore, 8) || '11:00',
    smokingAllowed: !!x.smokingAllowed, petsAllowed: !!x.petsAllowed,
    partyAllowed: !!x.partyAllowed, childrenAllowed: x.childrenAllowed !== false,
    additionalRules: str(x.additionalRules, 600),
    // Opening hours (hourly listings / reception)
    openingHours: {
      monFri: str(x.openingHours?.monFri, 24) || '08:00–20:00',
      sat: str(x.openingHours?.sat, 24) || '09:00–18:00',
      sun: str(x.openingHours?.sun, 24) || '10:00–16:00',
    },
    // Reservation policy (payment-while-booking + auto-cancel windows)
    depositPct: num(x.depositPct, 0, 100) || 10,       // % due at booking
    pendingCancelHours: num(x.pendingCancelHours, 1, 168) || 24, // unpaid pending auto-cancels
    checkinCancelHours: num(x.checkinCancelHours, 1, 168) || 24, // no-show cancel window
    // EXPERIENCES (host-run tours/activities) — priced PER PERSON.
    experienceType: str(x.experienceType, 60),
    hostQualifications: str(x.hostQualifications, 600),
    hostLanguages: (Array.isArray(x.hostLanguages) ? x.hostLanguages : String(x.hostLanguages || '').split(',')).map((a) => str(a, 30)).filter(Boolean).slice(0, 8),
    durationHours: num(x.durationHours, 0, 72),
    whatProvided: (Array.isArray(x.whatProvided) ? x.whatProvided : String(x.whatProvided || '').split(/[\n,]+/)).map((a) => str(a, 60)).filter(Boolean).slice(0, 20),
    whatToBring: (Array.isArray(x.whatToBring) ? x.whatToBring : String(x.whatToBring || '').split(/[\n,]+/)).map((a) => str(a, 60)).filter(Boolean).slice(0, 20),
  };
}

// Nightly-equivalent of a rate in any unit — how a weekly/monthly/hourly
// listing competes fairly against hotels in a per-night search.
export function nightlyEquivalentUSD(rateUSD, unit, nights = 1) {
  switch (unit) {
    case 'hour': return round2(rateUSD * 24);
    case 'day': case 'night': return round2(rateUSD);
    case 'week': return round2(rateUSD / 7);
    case 'month': return round2(rateUSD / 30);
    case 'stay': return round2(rateUSD / Math.max(1, nights));
    default: return round2(rateUSD);
  }
}

// ---- Availability calendar ----------------------------------------------------
// listing.availability = { blocked: ['YYYY-MM-DD'…], priceOverridesUSD: {date: usd} }
// Hosts block dates (maintenance, personal use) and set per-date prices (events,
// high season). Weekend days can price differently via weekendPriceUSD.
export function datesOfStay(checkIn, nights) {
  const out = [];
  if (!checkIn) return out;
  const d = new Date(`${checkIn}T00:00:00Z`);
  for (let i = 0; i < Math.max(1, nights); i++) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
export function stayIsAvailable(listing, checkIn, nights) {
  const blocked = new Set(listing.availability?.blocked || []);
  if (!blocked.size || !checkIn) return true;
  return !datesOfStay(checkIn, nights).some((dt) => blocked.has(dt));
}
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function isWeekend(dateISO, weekendDays) {
  const day = WD[new Date(`${dateISO}T00:00:00Z`).getUTCDay()];
  return (weekendDays || ['Fri', 'Sat']).includes(day);
}

// ---- The one price a guest pays ---------------------------------------------
// Applies: per-date price overrides, weekend pricing, long-term rate (7+/30+
// nights), extra-guest fees, cleaning fee, city fee, tax %.
// Returns { totalUSD, nightlyUSD, lines[], depositUSD }.
export function stayQuote(listing, nights, guests, checkIn = null) {
  const d = listing.details || {};
  const n = Math.max(1, Math.round(nights || 1));
  const g = Math.max(1, Math.round(guests || 1));
  const unit = d.rateUnit || 'night';
  let nightly = nightlyEquivalentUSD(listing.nightlyUSD, unit, n);
  let rateLabel = `${RATE_UNITS[unit].label} rate`;
  // Long-term pricing wins when the stay qualifies and the host set one.
  if (n >= 30 && d.monthlyRateUSD > 0) { nightly = d.monthlyRateUSD; rateLabel = 'Monthly rate (30+ nights)'; }
  else if (n >= 7 && d.weeklyRateUSD > 0) { nightly = d.weeklyRateUSD; rateLabel = 'Weekly rate (7+ nights)'; }
  // Per-DATE pricing when the check-in date is known: a host's calendar
  // override wins outright; else the weekend price applies on weekend days.
  const overrides = listing.availability?.priceOverridesUSD || {};
  let accomTotal; let accomLabel;
  if (checkIn && (Object.keys(overrides).length || d.weekendPriceUSD > 0)) {
    const dates = datesOfStay(checkIn, n);
    accomTotal = round2(dates.reduce((s, dt) => s + (Number(overrides[dt]) > 0 ? Number(overrides[dt]) : (d.weekendPriceUSD > 0 && isWeekend(dt, d.weekendDays) ? d.weekendPriceUSD : nightly)), 0));
    accomLabel = `${rateLabel} × ${n} ${n === 1 ? RATE_UNITS.night.one : RATE_UNITS.night.many} (calendar-priced)`;
    nightly = round2(accomTotal / n);
  } else {
    accomTotal = round2(nightly * n);
    accomLabel = `${rateLabel} × ${n} ${n === 1 ? RATE_UNITS.night.one : RATE_UNITS.night.many}`;
  }
  const lines = [{ label: accomLabel, amountUSD: accomTotal }];
  // Additional guests beyond what the base rate includes.
  const included = d.includedGuests || listing.sleeps || g;
  if (d.allowAdditionalGuests && g > included && d.additionalGuestFeeUSD > 0) {
    lines.push({ label: `${g - included} additional ${g - included === 1 ? GUEST_LABELS.one : GUEST_LABELS.many} × ${n}`, amountUSD: round2(d.additionalGuestFeeUSD * (g - included) * n) });
  }
  if (d.cleaningFeeUSD > 0) lines.push({ label: `Cleaning fee (${d.cleaningFeeType})`, amountUSD: round2(d.cleaningFeeType === 'per night' ? d.cleaningFeeUSD * n : d.cleaningFeeType === 'per guest' ? d.cleaningFeeUSD * g : d.cleaningFeeUSD) });
  if (d.cityFeeUSD > 0) lines.push({ label: `City fee (${d.cityFeeType})`, amountUSD: round2(d.cityFeeType === 'per night' ? d.cityFeeUSD * n : d.cityFeeType === 'per guest' ? d.cityFeeUSD * g : d.cityFeeUSD) });
  const subtotal = round2(lines.reduce((s, l) => s + l.amountUSD, 0));
  if (d.taxPct > 0) lines.push({ label: `Tax (${d.taxPct}%)`, amountUSD: round2(subtotal * d.taxPct / 100) });
  const totalUSD = round2(lines.reduce((s, l) => s + l.amountUSD, 0));
  return {
    totalUSD, nightlyUSD: nightly, lines,
    depositUSD: d.securityDepositUSD > 0 ? round2(d.securityDepositUSD) : 0, // held, not charged
    rateUnit: unit,
  };
}
