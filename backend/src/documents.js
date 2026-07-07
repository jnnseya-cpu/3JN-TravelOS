// 3JN Travel OS — branded travel documents.
//
// Every document a customer receives — e-ticket, itinerary, booking confirmation —
// is 3JN-branded end to end: WE are the merchant of record and issue the
// document. It carries the 3JN identity, the 3JN booking reference AND the
// airline/supplier locators (PNR, e-ticket numbers) so it is valid at check-in.
//
// Output is a SELF-CONTAINED printable HTML page (inline CSS) — the customer can
// view it in the browser and "Save as PDF". No external assets, so it renders
// anywhere and can be emailed as-is.

const BRAND = {
  name: '3JN Travel OS',
  tagline: 'Your journey, intelligently managed',
  support: 'support@3jntravel.com',
  site: '3jntravel.com',
  gold: '#c9a24b',
  ink: '#0f1830',
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function money(local, symbol) {
  return `${symbol || ''}${Number(local || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

// A flight leg row (outbound/inbound) for the itinerary table.
function legRows(c) {
  const d = c.details || {};
  const one = (leg, dir) => {
    if (!leg) return '';
    return `<tr>
      <td class="dir">${dir}</td>
      <td><strong>${esc(leg.from || '')}</strong> ${esc(leg.fromCity ? '· ' + leg.fromCity : '')} → <strong>${esc(leg.to || '')}</strong> ${esc(leg.toCity ? '· ' + leg.toCity : '')}</td>
      <td>${esc(leg.date || '')}</td>
      <td>${esc(leg.depart || '')} – ${esc(leg.arrive || '')}${leg.arriveNextDay ? ' <span class="muted">+1</span>' : ''}</td>
      <td>${esc(leg.stopLabel || (leg.stops ? leg.stops + ' stop' : 'Direct'))}</td>
    </tr>`;
  };
  return one(d.outbound, 'Outbound') + one(d.inbound, 'Return');
}

// The document body for a single booking.
export function bookingDocument(booking, { user, currencySymbol } = {}) {
  const o = booking.option || {};
  const ful = booking.fulfilment || {};
  const lead = booking.leadTraveller || {};
  const sym = currencySymbol || o.pricing?.symbol || '£';
  const paidTotal = (booking.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const total = o.pricing?.local?.total || 0;
  const fullyPaid = total > 0 && paidTotal + 0.01 >= total;
  const status = ful.ticketing === 'issued' ? 'E-TICKET ISSUED'
    : ful.ticketing === 'held' ? 'FARE HELD — TICKET ON FINAL PAYMENT'
    : fullyPaid ? 'CONFIRMED — PAID' : 'CONFIRMED — DEPOSIT PAID';
  const pnr = ful.pnr || ful.duffelOrderId || booking.id;
  const tickets = (ful.ticketNumbers || []).filter(Boolean);

  const comps = (o.components || []);
  const flights = comps.filter((c) => c.type === 'flight');
  const stays = comps.filter((c) => c.type === 'hotel' || c.type === 'host');
  const others = comps.filter((c) => !['flight', 'hotel', 'host'].includes(c.type));

  const flightBlocks = flights.map((c) => `
    <div class="seg">
      <div class="seg-head"><span>✈ ${esc(c.supplier)}</span><span class="muted">${esc(c.details?.cabin || 'Economy')} · 🧳 ${esc(c.details?.baggage || 'per fare rules')}</span></div>
      <table class="legs"><tbody>${legRows(c)}</tbody></table>
    </div>`).join('');

  const stayBlocks = stays.map((c) => `
    <div class="seg">
      <div class="seg-head"><span>🏨 ${esc(c.supplier)}</span><span class="muted">${c.stars ? '★'.repeat(c.stars) : ''} ${esc(c.details?.roomType || '')}</span></div>
      <div class="muted small">${esc(c.details?.groupStay ? `Whole group · ${c.details.groupStay.guests} guests · ${c.details.groupStay.units.length} rooms/apartments` : (c.details?.boardBasis || 'Room only'))}</div>
    </div>`).join('');

  const otherRows = others.map((c) => `<li>${esc(labelFor(c.type))} — <span class="muted">${esc(c.supplier)}</span>${c.details?.visaType ? ' · ' + esc(c.details.visaType) : ''}${c.details?.planLabel ? ' · ' + esc(c.details.planLabel) : ''}</li>`).join('');

  const paxName = lead.fullLegalName || lead.name || user?.name || 'Lead traveller';
  const paxCount = o.travellers?.total || flights[0]?.details?.passengers || 1;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>3JN Travel OS — ${esc(o.tier || 'Travel')} · ${esc(pnr)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #14203a; margin: 0; background: #eef1f6; }
  .doc { max-width: 800px; margin: 24px auto; background: #fff; border-radius: 14px; overflow: hidden; box-shadow: 0 8px 34px rgba(0,0,0,.12); }
  .hd { background: linear-gradient(135deg, ${BRAND.ink}, #16223f); color: #fff; padding: 22px 28px; display: flex; justify-content: space-between; align-items: center; }
  .brand { font-weight: 800; font-size: 20px; letter-spacing: .5px; }
  .brand span { color: ${BRAND.gold}; }
  .tag { font-size: 11px; color: #b9c4de; }
  .status { text-align: right; font-size: 12px; }
  .status b { display: inline-block; margin-top: 4px; padding: 4px 10px; border-radius: 20px; background: ${BRAND.gold}; color: #1a1304; font-size: 11px; letter-spacing: .4px; }
  .refbar { display: flex; flex-wrap: wrap; gap: 20px; padding: 16px 28px; background: #f7f9fc; border-bottom: 1px solid #e7ecf4; }
  .refbar div { font-size: 12px; } .refbar b { display: block; font-size: 15px; color: ${BRAND.ink}; margin-top: 2px; }
  .body { padding: 22px 28px; }
  h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .8px; color: #8593b3; margin: 22px 0 8px; }
  .seg { border: 1px solid #e7ecf4; border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; }
  .seg-head { display: flex; justify-content: space-between; font-weight: 600; margin-bottom: 6px; }
  table.legs { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.legs td { padding: 6px 8px; border-top: 1px solid #eef2f8; vertical-align: top; }
  td.dir { color: ${BRAND.gold}; font-weight: 700; font-size: 11px; text-transform: uppercase; width: 74px; }
  .muted { color: #7c89a8; } .small { font-size: 12px; }
  ul { margin: 6px 0; padding-left: 18px; font-size: 13px; } li { margin: 3px 0; }
  .totals { display: flex; justify-content: space-between; padding: 14px 28px; background: #f7f9fc; border-top: 1px solid #e7ecf4; font-size: 14px; }
  .totals .big { font-size: 20px; font-weight: 800; color: ${BRAND.ink}; }
  .ft { padding: 16px 28px; font-size: 11px; color: #8593b3; border-top: 1px solid #e7ecf4; }
  .ticketno { font-family: ui-monospace, Menlo, monospace; }
  @media print { body { background: #fff; } .doc { box-shadow: none; margin: 0; } }
</style></head>
<body><div class="doc">
  <div class="hd">
    <div><div class="brand">3JN <span>Travel OS</span></div><div class="tag">${esc(BRAND.tagline)}</div></div>
    <div class="status">Issued by ${esc(BRAND.name)}<br><b>${esc(status)}</b></div>
  </div>
  <div class="refbar">
    <div>Booking reference<b>${esc(booking.id)}</b></div>
    <div>Airline / supplier PNR<b>${esc(pnr)}</b></div>
    ${tickets.length ? `<div>E-ticket number(s)<b class="ticketno">${tickets.map(esc).join(', ')}</b></div>` : ''}
    <div>Lead traveller<b>${esc(paxName)}</b></div>
    <div>Travellers<b>${esc(paxCount)}</b></div>
  </div>
  <div class="body">
    ${flights.length ? `<h3>Flights</h3>${flightBlocks}` : ''}
    ${stays.length ? `<h3>Accommodation</h3>${stayBlocks}` : ''}
    ${others.length ? `<h3>Included services</h3><ul>${otherRows}</ul>` : ''}
    ${booking.specialRequests?.length ? `<h3>Special requests</h3><ul>${booking.specialRequests.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
  </div>
  <div class="totals">
    <span>${esc(o.tier || '')} package · ${fullyPaid ? 'Paid in full' : `Paid ${money(paidTotal, sym)} of ${money(total, sym)}${booking.instalment ? ' (instalment plan)' : ''}`}</span>
    <span class="big">${money(total, sym)}</span>
  </div>
  <div class="ft">
    This document is issued by ${esc(BRAND.name)} as your booking agent and merchant of record. Present the booking reference and PNR at check-in.
    ${tickets.length ? '' : 'Your e-ticket number(s) will appear here once ticketing is complete.'}
    Manage your trip, documents and support in your 3JN Console. Need help? ${esc(BRAND.support)} · ${esc(BRAND.site)}.
    Baggage, fare rules and cancellation terms are governed by the operating carrier/supplier and your fare conditions.
  </div>
</div></body></html>`;
}

function labelFor(type) {
  return ({ transfer: 'Airport transfer', visa: 'Visa service', esim: 'eSIM / roaming', insurance: 'Travel insurance', activities: 'Activities', tickets: 'Attraction tickets', carhire: 'Car hire', train: 'Rail', coach: 'Coach', ferry: 'Ferry', cruise: 'Cruise' }[type] || type);
}
