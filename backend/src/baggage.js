// In-checkout baggage math — PURE (no I/O), so it is unit-testable without Duffel.
//
// The customer picks checked bags in the booking modal; the server re-fetches the
// real airline prices from Duffel (a tampered client price can never change what
// we charge) and folds the surcharge into the option BEFORE the deposit /
// instalments / full-payment total are derived. The same selection is later
// ticketed IN the Duffel order, so a bag is never charged without fulfilment.

// Compute the authoritative bag surcharge from already-fetched Duffel bags and the
// customer's selected service ids. Returns null when nothing valid is selected.
//   bags:     [{ id, amount, currency, priceUSD, maxQuantity, kg }]
//   services: [{ id, quantity }]
//   rateFromUSD: display-currency FX rate (localTotal is in the display currency;
//                offerAmount/offerCurrency is what Duffel is paid so the bag issues).
export function computeBaggageSurcharge(bags, services, rateFromUSD = 0.79) {
  if (!Array.isArray(bags) || !bags.length || !Array.isArray(services) || !services.length) return null;
  const byId = new Map(bags.map((b) => [b.id, b]));
  let offerAmount = 0, offerCurrency = null, usd = 0; const lines = [];
  for (const s of services) {
    const b = byId.get(s?.id);
    if (!b || b.priceUSD == null || b.amount == null) continue;
    const qty = Math.max(1, Math.min(Number(b.maxQuantity) || 1, Number(s.quantity) || 1));
    if (offerCurrency && b.currency !== offerCurrency) continue; // mixed currencies → skip the odd one
    offerCurrency = b.currency;
    offerAmount += Number(b.amount) * qty;
    usd += Number(b.priceUSD) * qty;
    lines.push({ id: b.id, quantity: qty, kg: b.kg || null, priceUSD: Math.round(Number(b.priceUSD) * qty * 100) / 100 });
  }
  if (!lines.length) return null;
  const rate = rateFromUSD || 0.79;
  return {
    offerAmount: Math.round(offerAmount * 100) / 100, offerCurrency,
    usd: Math.round(usd * 100) / 100,
    localTotal: Math.round(usd * rate * 100) / 100,
    lines,
  };
}

// Add the bag surcharge to an option IN PLACE (total, USD, and a display line) so
// the instalment plan, deposit, full-payment amount and document all include it.
export function applyBaggageToOption(option, bag) {
  if (!option || !bag) return option;
  const p2 = (n) => Math.round(n * 100) / 100;
  option.pricing = option.pricing || {}; option.pricing.local = option.pricing.local || {};
  option.pricing.local.total = p2((Number(option.pricing.local.total) || 0) + bag.localTotal);
  option.pricing.local.baggage = p2((Number(option.pricing.local.baggage) || 0) + bag.localTotal);
  option.totalUSD = p2((Number(option.totalUSD) || 0) + bag.usd);
  return option;
}
