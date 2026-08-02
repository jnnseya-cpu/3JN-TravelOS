// 3JN Travel OS — Visa Support Reservations.
//
// A widely-used, legitimate travel product: embassies require proof of onward
// travel and accommodation for a visa application, but a traveller should not
// buy a non-refundable ticket/room before their visa is granted. So we issue:
//   • a GENUINE, verifiable onward/return FLIGHT reservation (a held itinerary
//     with a real locator, valid for the appointment window), and
//   • a free-cancellation HOTEL reservation confirmation.
// Both are REAL and time-boxed — never fabricated documents, never charged to
// the traveller as a fare/room. The customer pays only a flat one-off SERVICE
// fee; the reservations are released/cancelled after the visa decision.
//
// This module is pure/testable: products, fee maths and the reservation record
// shape. State (orders, fulfilment, revenue) lives in store.js.

import {
  VISA_DOC_FEE_FLIGHT_GBP, VISA_DOC_FEE_HOTEL_GBP, VISA_DOC_FEE_PACK_GBP,
  VISA_DOC_MEMBER_DISCOUNT, VISA_DOC_VALIDITY_DAYS,
  VISA_HOTEL_DEPOSIT_PER_NIGHT_GBP, VISA_HOTEL_DEPOSIT_MIN_GBP, VISA_HOTEL_DEPOSIT_CAP_GBP,
} from '../../shared/constants.js';

const GBP_TO_USD = 1 / 0.79; // single platform anchor
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

export const VISA_DOC_KINDS = ['flight', 'hotel', 'pack'];

export const VISA_DOC_PRODUCTS = {
  flight: {
    kind: 'flight', name: 'Flight reservation (for visa)', feeGbp: VISA_DOC_FEE_FLIGHT_GBP,
    includes: ['Real onward/return flight reservation', 'Airline booking reference you can verify on the airline site', 'Held — issued close to your appointment', 'PDF for your embassy file'],
    delivers: ['flight'],
  },
  hotel: {
    kind: 'hotel', name: 'Hotel reservation (for visa)', feeGbp: VISA_DOC_FEE_HOTEL_GBP,
    includes: ['Real free-cancellation hotel reservation', 'Named hotel confirmation number for your dates', `Held ~${VISA_DOC_VALIDITY_DAYS} days`, 'PDF for your embassy file'],
    delivers: ['hotel'],
  },
  pack: {
    kind: 'pack', name: 'Flight + hotel reservation pack', feeGbp: VISA_DOC_FEE_PACK_GBP,
    includes: ['Both reservations for your visa file', 'Onward flight + free-cancellation hotel', 'Real, verifiable references', `Saves £${round2(VISA_DOC_FEE_FLIGHT_GBP + VISA_DOC_FEE_HOTEL_GBP - VISA_DOC_FEE_PACK_GBP)}`],
    delivers: ['flight', 'hotel'],
  },
};

// One-off fee for a product, with the member discount applied when active.
export function visaDocFee(kind, { memberActive = false } = {}) {
  const p = VISA_DOC_PRODUCTS[kind] || VISA_DOC_PRODUCTS.pack;
  const baseGbp = round2(p.feeGbp);
  const discountPct = memberActive ? VISA_DOC_MEMBER_DISCOUNT : 0;
  const feeGbp = round2(baseGbp * (1 - discountPct));
  return {
    kind: p.kind, name: p.name,
    baseGbp, memberDiscountPct: Math.round(discountPct * 100),
    feeGbp, feeUSD: round2(feeGbp * GBP_TO_USD),
    delivers: p.delivers.slice(),
  };
}

// Refundable room deposit for a hotel/pack stay: covers the room so the CUSTOMER
// carries it, not 3JN. Scales with nights, floored + capped. Fully refunded once
// the booking is cancelled after the visa decision.
export function visaHotelDeposit(nights = 1, kind = 'pack') {
  if (kind === 'flight') return { depositGbp: 0, perNightGbp: VISA_HOTEL_DEPOSIT_PER_NIGHT_GBP };
  const n = Math.max(1, Math.min(90, Number(nights) || 1));
  const raw = n * VISA_HOTEL_DEPOSIT_PER_NIGHT_GBP;
  const depositGbp = round2(Math.min(VISA_HOTEL_DEPOSIT_CAP_GBP, Math.max(VISA_HOTEL_DEPOSIT_MIN_GBP, raw)));
  return { depositGbp, perNightGbp: VISA_HOTEL_DEPOSIT_PER_NIGHT_GBP };
}

// The pricing catalogue for the storefront (member-aware).
export function visaDocPricing({ memberActive = false } = {}) {
  return {
    validityDays: VISA_DOC_VALIDITY_DAYS,
    memberDiscountPct: Math.round(VISA_DOC_MEMBER_DISCOUNT * 100),
    hotelDeposit: { perNightGbp: VISA_HOTEL_DEPOSIT_PER_NIGHT_GBP, minGbp: VISA_HOTEL_DEPOSIT_MIN_GBP, capGbp: VISA_HOTEL_DEPOSIT_CAP_GBP },
    products: VISA_DOC_KINDS.map((k) => ({ ...VISA_DOC_PRODUCTS[k], ...visaDocFee(k, { memberActive }) })),
  };
}

// Reservation validity window: from an ISO date, held for `days`.
export function visaReservationValidity(fromISO, days = VISA_DOC_VALIDITY_DAYS) {
  const base = fromISO ? new Date(`${String(fromISO).slice(0, 10)}T00:00:00Z`) : null;
  if (!base || Number.isNaN(base.getTime())) return null;
  const end = new Date(base);
  end.setUTCDate(end.getUTCDate() + Number(days || VISA_DOC_VALIDITY_DAYS));
  return end.toISOString().slice(0, 10);
}

// A 3JN reservation locator (our own reference — NOT a fabricated airline PNR).
// Deterministic from a seed so the same order always renders the same locator.
export function visaDocReference(prefix, seed) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
  let h = 2166136261;
  const s = String(seed || prefix || 'vr');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  let out = '';
  for (let i = 0; i < 6; i++) { h = Math.imul(h ^ (h >>> 13), 3266489909); out += alphabet[(h >>> 8) % alphabet.length]; }
  return `${prefix}-${out}`;
}

// A real calendar date in YYYY-MM-DD (rejects malformed and impossible dates like
// 2026-02-30, which would otherwise reach the airline as a passenger DoB / travel
// date and be rejected there after the customer has already paid).
export function isValidYMD(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Validate an order payload → normalised trip, or an error. `today` is injectable
// for tests; defaults to the current UTC date.
export function validateVisaDocOrder({ kind, destination, origin, departDate, returnDate, nights, travellers, applicantName } = {}, { today } = {}) {
  if (!VISA_DOC_KINDS.includes(kind)) return { ok: false, error: 'invalid-kind', message: 'Choose a flight, hotel or combined reservation.' };
  const dest = String(destination || '').trim();
  if (!dest) return { ok: false, error: 'destination-required', message: 'Enter the destination country/city for your visa.' };
  const needsFlight = kind === 'flight' || kind === 'pack';
  const needsHotel = kind === 'hotel' || kind === 'pack';
  if (needsFlight && !String(origin || '').trim()) return { ok: false, error: 'origin-required', message: 'Enter where you fly from for the flight reservation.' };
  if (!String(departDate || '').trim()) return { ok: false, error: 'depart-required', message: 'Enter your intended arrival/travel date.' };
  // Dates must be real and deliverable: not malformed, not in the past, and a
  // return (if given) not before departure — otherwise the airline hold can never
  // issue and the customer has paid for something undeliverable.
  const dep = String(departDate).slice(0, 10);
  if (!isValidYMD(dep)) return { ok: false, error: 'invalid-date', message: 'Enter a valid travel date.' };
  const todayYMD = String(today || new Date().toISOString().slice(0, 10)).slice(0, 10);
  if (dep < todayYMD) return { ok: false, error: 'date-in-past', message: 'Your travel date must be today or in the future.' };
  const ret = returnDate ? String(returnDate).slice(0, 10) : null;
  if (ret) {
    if (!isValidYMD(ret)) return { ok: false, error: 'invalid-return-date', message: 'Enter a valid return date.' };
    if (ret < dep) return { ok: false, error: 'return-before-depart', message: 'Your return date must be on or after your travel date.' };
  }
  const pax = Math.max(1, Math.min(9, Number(travellers) || 1));
  const nts = needsHotel ? Math.max(1, Math.min(90, Number(nights) || 7)) : 0;
  return {
    ok: true,
    trip: {
      kind, needsFlight, needsHotel,
      destination: dest, origin: String(origin || '').trim() || null,
      departDate: dep, returnDate: ret,
      nights: nts, travellers: pax,
      applicantName: String(applicantName || '').trim() || null,
    },
  };
}
