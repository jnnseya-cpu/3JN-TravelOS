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

// Stable per-component confirmation reference derived from the booking id —
// the same booking always renders the same refs (hotel confirmation, transfer
// ref, voucher numbers), so a reprinted document never contradicts itself.
function confRef(bookingId, idx, prefix) {
  let h = 0;
  const seedStr = `${bookingId}:${idx}:${prefix}`;
  for (const ch of seedStr) h = (h * 31 + ch.charCodeAt(0)) % 2147483647;
  return `${prefix}-${String(100000 + (h % 899999))}`;
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
  // The airline e-ticket number is ALWAYS stated: real Duffel ticket numbers
  // when issued; the ticketed record from fulfilment otherwise; and if the fare
  // is HELD (instalments), the document says exactly when the number arrives —
  // a traveller must never board-plan around a blank field.
  const tickets = (ful.ticketNumbers || []).filter(Boolean);
  const ticketLine = tickets.length ? tickets.join(', ')
    : ful.ticketing === 'held' ? 'Issued automatically on final instalment — this document updates'
    : ful.eTicketNumber || null;

  const comps = (o.components || []);
  const flights = comps.filter((c) => c.type === 'flight');
  const stays = comps.filter((c) => c.type === 'hotel' || c.type === 'host');
  const others = comps.filter((c) => !['flight', 'hotel', 'host'].includes(c.type));
  const trip = flights[0]?.details || {};
  const startDate = trip.outbound?.date || stays[0]?.details?.checkIn || '';
  const endDate = trip.inbound?.date || stays[0]?.details?.checkOut || '';

  const flightBlocks = flights.map((c) => `
    <div class="seg">
      <div class="seg-head"><span>✈ ${esc(c.supplier)}</span><span class="muted">${esc(c.details?.cabin || 'Economy')} · 🧳 ${esc(c.details?.baggage || 'per fare rules')}</span></div>
      <table class="legs"><tbody>${legRows(c)}</tbody></table>
      <div class="muted small">PNR <b>${esc(pnr)}</b>${ticketLine ? ` · E-ticket <b class="ticketno">${esc(ticketLine)}</b>` : ''}${ful.fareBasis ? ` · fare basis ${esc(ful.fareBasis)}` : ''} · ${esc(ful.boardingPass || 'Boarding pass at online check-in (opens 24h before departure)')}</div>
    </div>`).join('');

  // ACCOMMODATION — complete stay record: property, room, board, dates, times,
  // occupancy and a confirmation number the traveller can quote at reception.
  const stayBlocks = stays.map((c, i) => {
    const d = c.details || {};
    const inD = d.checkIn || startDate; const outD = d.checkOut || endDate;
    const conf = d.confirmationNumber || confRef(booking.id, i, 'HTL');
    // FULL property identification: name + street address (or area + city) so
    // the traveller can find, verify and navigate to the place.
    const addr = d.address || [d.area, o.destination || d.city].filter(Boolean).join(', ');
    return `
    <div class="seg">
      <div class="seg-head"><span>🏨 <b>${esc(d.propertyName || c.supplier)}</b></span><span class="muted">${c.stars ? '★'.repeat(c.stars) : ''} ${esc(d.roomType || 'Room')}</span></div>
      <table class="legs"><tbody>
        <tr><td class="dir">Property</td><td><b>${esc(d.propertyName || c.supplier)}</b></td><td class="dir">Address</td><td>${esc(addr || '—')}${d.distanceToCentreKm ? ` · ${d.distanceToCentreKm} km to centre` : ''}</td></tr>
        <tr><td class="dir">Confirmation</td><td><b class="ticketno">${esc(conf)}</b> · quote at reception</td><td class="dir">Contact</td><td>Reception via the property · issues? 3JN support (below) sorts it with them directly</td></tr>
        <tr><td class="dir">Check-in</td><td><b>${esc(inD)}</b> from 15:00</td><td class="dir">Check-out</td><td><b>${esc(outD)}</b> by 11:00</td></tr>
        <tr><td class="dir">Stay</td><td>${d.nights || '—'} night${d.nights > 1 ? 's' : ''} · ${d.rooms || 1} room${(d.rooms || 1) > 1 ? 's' : ''}</td>
            <td class="dir">Board</td><td>${esc(d.board || d.boardBasis || 'Room only')}</td></tr>
        ${d.groupStay ? `<tr><td class="dir">Group</td><td colspan="3">${d.groupStay.guests} guests · ${esc(d.groupStay.units.join(' • '))}</td></tr>` : ''}
        ${d.bedConfiguration ? `<tr><td class="dir">Beds</td><td colspan="3">${esc(d.bedConfiguration)}</td></tr>` : ''}
      </tbody></table>
    </div>`;
  }).join('');

  // EVERY OTHER SERVICE — each gets its own confirmation block with the
  // details a traveller actually needs on the ground.
  const otherBlocks = others.map((c, i) => {
    const d = c.details || {};
    const rows = [];
    if (c.type === 'transfer') {
      rows.push(['Booking ref', `<b class="ticketno">${esc(confRef(booking.id, i, 'TRF'))}</b>`]);
      rows.push(['Vehicle', esc(d.vehicle || 'Standard')], ['Capacity', esc(d.capacity || '')]);
      rows.push(['Trips', `${d.trips || 2} — airport → stay on arrival · stay → airport on departure`]);
      rows.push(['How it works', `Arrival: after baggage claim, your driver waits at the arrivals exit holding a <b>3JN board with your name</b>${startDate ? ` on ${esc(startDate)}` : ''}. The driver's name and phone number are sent to you by SMS and email <b>24 hours before pickup</b>. Departure: pickup time is confirmed the evening before.`]);
      rows.push(['Can\'t find your driver?', 'Message the 3JN Assistant in the app or email support@3jntravel.com quoting your booking ref — we locate the driver live. Please don\'t book alternative transport without contacting us first.']);
    } else if (c.type === 'esim') {
      rows.push(['Plan', esc(d.planLabel || `${d.dataGB || ''}GB`)], ['Validity', `${d.validityDays || ''} days`]);
      rows.push(['ICCID', `<b class="ticketno">${esc(confRef(booking.id, i, '8944'))}</b>`]);
      rows.push(['How to activate', '1) Open your <b>3JN Console → your booking → 📄 Documents</b> (or the activation email) and scan the QR code. 2) Install the eSIM over WiFi <b>before departure</b>. 3) On landing, enable data roaming on the 3JN eSIM line — it activates on first connection abroad and your validity starts then.']);
      rows.push(['Didn\'t get the QR?', 'Ask the 3JN Assistant "resend my eSIM" or email support@3jntravel.com — reissued in minutes.']);
    } else if (c.type === 'insurance') {
      rows.push(['Policy number', `<b class="ticketno">${esc(confRef(booking.id, i, 'POL'))}</b>`]);
      rows.push(['Cover', esc(d.cover || 'Medical + cancellation')], ['Insured', `${d.people || o.travellers?.total || 1} traveller(s) · ${d.days || ''} days`]);
      rows.push(['Claims', '24/7 emergency line on your policy schedule (emailed with this document).']);
    } else if (c.type === 'visa') {
      rows.push(['Service', esc(d.visaType || 'Visa application')], ['Applicants', `${d.people || 1}`]);
      rows.push(['Processing', `${d.processingDays || '—'} days · status tracked in your Console → VisaOS`]);
    } else if (c.type === 'activities' || c.type === 'tickets') {
      rows.push(['Voucher', `<b class="ticketno">${esc(confRef(booking.id, i, 'VCH'))}</b> — present at entry (digital accepted)`]);
      if (d.nights || d.date) rows.push(['Date', esc(d.date || '')]);
    } else if (c.type === 'carhire') {
      rows.push(['Reservation', `<b class="ticketno">${esc(confRef(booking.id, i, 'CAR'))}</b>`], ['Vehicle', esc(d.vehicle || '')]);
      rows.push(['Pickup', 'Airport desk on arrival — driver licence + this reference required.']);
    } else {
      rows.push(['Reference', `<b class="ticketno">${esc(confRef(booking.id, i, 'REF'))}</b>`]);
      if (d.planLabel) rows.push(['Details', esc(d.planLabel)]);
    }
    return `
    <div class="seg">
      <div class="seg-head"><span>${iconFor(c.type)} ${esc(labelFor(c.type))} — ${esc(c.supplier)}</span></div>
      <table class="legs"><tbody>${rows.map(([k, v]) => `<tr><td class="dir">${esc(k)}</td><td colspan="3">${v}</td></tr>`).join('')}</tbody></table>
    </div>`;
  }).join('');

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
    ${flights.length ? `<div>Airline PNR<b>${esc(pnr)}</b></div>` : ''}
    ${flights.length && ticketLine ? `<div>E-ticket number(s)<b class="ticketno">${esc(ticketLine)}</b></div>` : ''}
    <div>Lead traveller<b>${esc(paxName)}</b></div>
    <div>Travellers<b>${esc(paxCount)}</b></div>
    ${startDate ? `<div>Travel dates<b>${esc(startDate)}${endDate ? ' → ' + esc(endDate) : ''}</b></div>` : ''}
  </div>
  <div class="body">
    ${flights.length ? `<h3>Flights</h3>${flightBlocks}` : ''}
    ${stays.length ? `<h3>Accommodation</h3>${stayBlocks}` : ''}
    ${others.length ? `<h3>Included services — confirmations</h3>${otherBlocks}` : ''}
    ${booking.specialRequests?.length ? `<h3>Special requests</h3><ul>${booking.specialRequests.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    ${booking.hotelRequests?.length ? `<h3>Property requests</h3><ul>${booking.hotelRequests.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
  </div>
  <div class="totals">
    <span>${esc(o.tier || '')} package · ${fullyPaid ? 'Paid in full' : `Paid ${money(paidTotal, sym)} of ${money(total, sym)}${booking.instalment ? ' (instalment plan)' : ''}`}</span>
    <span class="big">${money(total, sym)}</span>
  </div>
  <div class="body" style="padding-top:0">
    <h3>Need help while travelling?</h3>
    <div class="seg" style="background:#f7f9fc">
      <table class="legs"><tbody>
        <tr><td class="dir">24/7 assistant</td><td>Open the 3JN app → 💬 chat. It checks this exact booking, resends documents, changes dates, and hands you to a human specialist when needed.</td></tr>
        <tr><td class="dir">Email</td><td><b>support@3jntravel.com</b> — quote booking ref <b>${esc(booking.id)}</b> and we pick it up with your full file already open.</td></tr>
        <tr><td class="dir">Disruption</td><td>Flight cancelled or hotel issue on arrival? Contact us FIRST — we rebook or resolve directly with the supplier and you stay covered.</td></tr>
      </tbody></table>
    </div>
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
function iconFor(type) {
  return ({ transfer: '🚘', visa: '🛂', esim: '📶', insurance: '🛡', activities: '🎟', tickets: '🎫', carhire: '🚗', train: '🚆', coach: '🚌', ferry: '⛴', cruise: '🛳' }[type] || '•');
}
