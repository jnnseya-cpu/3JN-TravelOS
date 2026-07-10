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

// A flight leg row (outbound/inbound) for the itinerary table. A connecting
// leg ALSO prints every individual flight (number, times) and each stopover
// (airport + wait) — a traveller changing planes must never have to guess
// where they connect or how long they have.
function legRows(c) {
  const d = c.details || {};
  const one = (leg, dir) => {
    if (!leg) return '';
    const main = `<tr>
      <td class="dir">${dir}</td>
      <td><strong>${esc(leg.from || '')}</strong> ${esc(leg.fromCity ? '· ' + leg.fromCity : '')} → <strong>${esc(leg.to || '')}</strong> ${esc(leg.toCity ? '· ' + leg.toCity : '')}</td>
      <td>${esc(leg.date || '')}</td>
      <td>${esc(leg.depart || '')} – ${esc(leg.arrive || '')}${leg.arriveNextDay ? ' <span class="muted">+1</span>' : ''}</td>
      <td>${esc(leg.stopLabel || (leg.stops ? leg.stops + ' stop' : 'Direct'))}</td>
    </tr>`;
    if (!Array.isArray(leg.segments) || leg.segments.length < 2) return main;
    const plan = leg.segments.map((s, i) => {
      const lay = (leg.layovers || [])[i];
      return `<div>✈ <strong>${esc(s.flightNumber || s.carrier)}</strong> ${esc(s.carrier)}${s.operatedBy ? ` (operated by ${esc(s.operatedBy)})` : ''} — ${esc(s.from)} ${esc(s.depart)} → ${esc(s.to)} ${esc(s.arrive)} (${esc(s.durationLabel || '')})</div>${lay ? `<div class="muted" style="margin-left:14px">🕓 Change planes in ${esc(lay.city || lay.airport)} (${esc(lay.airport)}) — ${esc(lay.durationLabel || 'see boarding pass')} wait${lay.overnight ? ', overnight' : ''}${lay.tight ? ' — TIGHT CONNECTION, go straight to your gate' : ''}. Same ticket: your bags are checked through and the airline rebooks you free if a delay breaks the connection.</div>` : ''}`;
    }).join('');
    return `${main}<tr><td></td><td colspan="4" style="font-size:11.5px;padding:4px 8px 10px">${plan}</td></tr>`;
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
  // details a traveller actually needs on the ground. serviceBlockData is the
  // SINGLE source of truth: the printed document AND the Console → 📄 Documents
  // panel both render from it, so they can never diverge.
  const otherBlocks = others.map((c, i) => {
    const b = serviceBlockData(booking, c, i, { startDate, endDate });
    return `
    <div class="seg">
      <div class="seg-head"><span>${b.icon} ${esc(b.label)} — ${esc(b.supplier)}</span></div>
      <table class="legs"><tbody>${b.rows.map(([k, v]) => `<tr><td class="dir">${esc(k)}</td><td colspan="3">${v}</td></tr>`).join('')}</tbody></table>
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
  return ({ transfer: 'Airport transfer', visa: 'Visa service', esim: 'eSIM / roaming', insurance: 'Travel insurance', activities: 'Activities', tickets: 'Attraction tickets', carhire: 'Car hire', train: 'Rail', coach: 'Coach', ferry: 'Ferry', cruise: 'Cruise', photographer: 'Photography session', guide: 'Private local guide', restaurant: 'Restaurant reservation', translator: 'Translator / interpreter', driver: 'Private driver (day)' }[type] || type);
}
function iconFor(type) {
  return ({ transfer: '🚘', visa: '🛂', esim: '📶', insurance: '🛡', activities: '🎟', tickets: '🎫', carhire: '🚗', train: '🚆', coach: '🚌', ferry: '⛴', cruise: '🛳', photographer: '📸', guide: '🧭', restaurant: '🍽', translator: '🗣', driver: '🚙' }[type] || '•');
}

// ---------------------------------------------------------------------------
// One included-service confirmation card, as structured data:
//   { type, icon, label, supplier, rows: [[key, htmlValue]...] }
// The SINGLE source of truth for service instructions — the printed travel
// document renders it, and GET /api/book/:id/documents feeds the Console
// "📄 Documents" panel from it, so the two can never diverge.
export function serviceBlockData(booking, c, i, { startDate = '', endDate = '' } = {}) {
  const o = booking.option || {};
  const d = c.details || {};
  const rows = [];
  if (c.type === 'transfer') {
    rows.push(['Booking ref', `<b class="ticketno">${esc(confRef(booking.id, i, 'TRF'))}</b>`]);
    rows.push(['Vehicle', esc(d.vehicle || 'Standard')], ['Capacity', esc(d.capacity || '')]);
    rows.push(['Trips', `${d.trips || 2} — airport → stay on arrival · stay → airport on departure`]);
    rows.push(['How it works', `Arrival: after baggage claim, your driver waits at the arrivals exit holding a <b>3JN board with your name</b>${startDate ? ` on ${esc(startDate)}` : ''}. The driver's name and phone number are sent to you by SMS and email <b>24 hours before pickup</b>. Departure: pickup time is confirmed the evening before.`]);
    rows.push(['Can\'t find your driver?', 'Message the 3JN Assistant in the app or email support@3jntravel.com quoting your booking ref — we locate the driver live. Please don\'t book alternative transport without contacting us first.']);
  } else if (c.type === 'esim') {
    // REAL eSIM (Airalo/eSIM Access) once provisioned — genuine ICCID, LPA
    // activation string, SM-DP+ address, QR and the eSIMs Cloud share link.
    const live = d.esim && d.esim.live && d.esim.iccid ? d.esim : null;
    if (live) {
      rows.push(['Provider · plan', `${esc(live.provider)} · ${esc(live.packageTitle || d.planLabel || '')}${live.dataLabel ? ' · ' + esc(live.dataLabel) : ''}`]);
      if (live.validityDays) rows.push(['Validity', `${live.validityDays} days (starts on first connection abroad)`]);
      rows.push(['ICCID', `<b class="ticketno">${esc(live.iccid)}</b>`]);
      if (live.lpa) rows.push(['Activation code (LPA)', `<b class="ticketno">${esc(live.lpa)}</b> — Settings → Mobile/Cellular → Add eSIM → <b>Enter Details Manually</b>`]);
      if (live.smdp) rows.push(['SM-DP+ address', `<b>${esc(live.smdp)}</b>${live.matchingId ? ` · activation code <b>${esc(live.matchingId)}</b>` : ''}`]);
      if (live.qrUrl) rows.push(['QR code', `<a href="${esc(live.qrUrl)}">Open your QR code</a> — scan it on another screen to install`]);
      if (live.appleInstallUrl) rows.push(['iPhone (iOS 17.4+)', `<a href="${esc(live.appleInstallUrl)}">Tap to install directly</a>`]);
      if (live.shareLink) rows.push(['All details & instructions', `<a href="${esc(live.shareLink)}">${esc(live.shareLink)}</a>${live.shareAccessCode ? ` · access code <b>${esc(live.shareAccessCode)}</b>` : ''}`]);
      if (live.apnValue) rows.push(['APN (if needed)', `${esc(live.apnValue)}${live.isRoaming ? ' · enable data roaming' : ''}`]);
      rows.push(['How to activate', '1) Install over WiFi <b>before departure</b> (scan the QR or enter the LPA/SM-DP+ details manually). 2) On landing, enable data roaming on this line — it activates on first connection abroad and your validity starts then.']);
    } else {
      const iccid = confRef(booking.id, i, '8944');
      rows.push(['Plan', esc(d.planLabel || `${d.dataGB || ''}GB`)], ['Validity', `${d.validityDays || ''} days`]);
      rows.push(['ICCID', `<b class="ticketno">${esc(iccid)}</b>`]);
      rows.push(['Activation', 'Your eSIM QR + activation code arrive by email once issued — or ask the 3JN Assistant "resend my eSIM". Install over WiFi before departure; enable data roaming on landing.']);
    }
  } else if (c.type === 'insurance') {
    rows.push(['Policy number', `<b class="ticketno">${esc(confRef(booking.id, i, 'POL'))}</b>`]);
    rows.push(['Cover', esc(d.cover || 'Medical + cancellation')], ['Insured', `${d.people || o.travellers?.total || 1} traveller(s) · ${d.days || ''} days · valid ${esc(startDate)} → ${esc(endDate || startDate)}`]);
    rows.push(['How to claim', '1) Medical emergency: call the 24/7 emergency line on your policy schedule (emailed with this document) BEFORE treatment where possible. 2) Keep every receipt, report and reference. 3) Start the claim from your 3JN Console → booking → Insurance, or ask the 3JN Assistant — we pre-fill the claim with your trip data.']);
    rows.push(['Carry', 'A copy of the policy schedule (digital is fine) and this booking reference.']);
  } else if (c.type === 'visa') {
    rows.push(['Service', esc(d.visaType || 'Visa application')], ['Applicants', `${d.people || 1}`]);
    rows.push(['Status & tracking', `Processing ~${d.processingDays || '—'} days. Track live in your Console → VisaOS → My applications. The embassy releases the decision — you're notified instantly and your official decision letter appears there.`]);
    rows.push(['At the border', 'Carry your passport, a printed or digital copy of the decision letter, and this itinerary. Conditions on the visa (validity, entries) are stated on the letter.']);
  } else if (c.type === 'activities' || c.type === 'tickets') {
    rows.push(['Voucher', `<b class="ticketno">${esc(confRef(booking.id, i, 'VCH'))}</b> — show at entry (digital accepted, ID may be requested)`]);
    rows.push(['Schedule', `${d.date ? esc(d.date) + ' · ' : ''}Exact meeting point and start time are confirmed by email and in your Console <b>24–48h before</b>. ${d.durationHours ? `Duration ~${d.durationHours}h. ` : ''}Arrive 15 minutes early.`]);
    rows.push(['Changes', 'Need a different day or headcount? Ask the 3JN Assistant — free rescheduling up to 24h before where the operator allows.']);
    if (d.whatProvided?.length) rows.push(['Included', d.whatProvided.map(esc).join(' · ')]);
    if (d.whatToBring?.length) rows.push(['Bring', d.whatToBring.map(esc).join(' · ')]);
  } else if (c.type === 'carhire') {
    rows.push(['Reservation', `<b class="ticketno">${esc(confRef(booking.id, i, 'CAR'))}</b>`], ['Vehicle', esc(d.vehicle || '')]);
    rows.push(['Pickup', `Airport rental desk on arrival${startDate ? ` (${esc(startDate)})` : ''} — quote the reservation number.`]);
    rows.push(['You must bring', 'Full driving licence held 1+ years, passport, and a credit card in the MAIN driver\'s name (a refundable deposit is blocked on it). International Driving Permit where required.']);
    rows.push(['Cover', 'Basic collision cover included; excess-reduction offered at the desk — check your travel insurance first, it may already cover the excess.']);
  } else if (c.type === 'photographer') {
    rows.push(['Session ref', `<b class="ticketno">${esc(confRef(booking.id, i, 'PHO'))}</b>`], ['Session', esc(d.unit || 'per 2h shoot')]);
    rows.push(['Scheduling', 'The photographer contacts you within 24h of booking (email + Console message) to agree the date, time and shoot locations. Golden-hour slots go first — reply early.']);
    rows.push(['Your photos', 'Edited photos delivered to your Console → Documents within 5 days of the shoot (full-resolution download, yours to keep).']);
  } else if (c.type === 'guide') {
    rows.push(['Booking ref', `<b class="ticketno">${esc(confRef(booking.id, i, 'GDE'))}</b>`], ['Engagement', esc(d.unit || 'per day')]);
    rows.push(['Meeting', 'Your guide meets you at your accommodation lobby at the agreed time (default 09:00, day after arrival). Name, photo and phone number sent 24h before.']);
    rows.push(['Customising', 'Tell the 3JN Assistant what you want to see — the itinerary is yours; the guide adapts on the day. Entry fees for attractions are paid separately unless stated.']);
  } else if (c.type === 'restaurant') {
    rows.push(['Reservation ref', `<b class="ticketno">${esc(confRef(booking.id, i, 'RSV'))}</b>`], ['Covers', `${d.people || o.travellers?.total || 2} · ${esc(d.unit || 'set menu per person')}`]);
    rows.push(['Confirmation', 'The exact restaurant, date and table time are confirmed by email and in your Console 48h before. Give the reservation ref (or your name) at the door.']);
    rows.push(['Dietary needs', 'Allergies or preferences? Tell the 3JN Assistant now — we pass them to the kitchen with the reservation.']);
  } else if (c.type === 'translator') {
    rows.push(['Booking ref', `<b class="ticketno">${esc(confRef(booking.id, i, 'TRN'))}</b>`], ['Engagement', esc(d.unit || 'per day')]);
    rows.push(['Meeting', 'Your interpreter meets you at your accommodation (or a location you choose) at the agreed time. Name and phone number sent 24h before. Working languages confirmed at booking.']);
    rows.push(['Scope', 'Business meetings, medical appointments, shopping, officialdom — anything spoken. Written document translation can be added via the Assistant.']);
  } else if (c.type === 'driver') {
    rows.push(['Booking ref', `<b class="ticketno">${esc(confRef(booking.id, i, 'DRV'))}</b>`], ['Engagement', esc(d.unit || 'per day · with vehicle')]);
    rows.push(['How it works', 'A licensed driver with an air-conditioned vehicle is at your disposal for the day (up to 10 hours). Pickup at your accommodation at the agreed time; the driver waits at every stop. Driver name, vehicle plate and phone sent 24h before.']);
    rows.push(['Notes', 'Fuel, parking and tolls included within the city. Out-of-city day trips — agree the route with the Assistant first so it\'s priced upfront.']);
  } else {
    rows.push(['Reference', `<b class="ticketno">${esc(confRef(booking.id, i, 'REF'))}</b>`]);
    if (d.planLabel) rows.push(['Details', esc(d.planLabel)]);
    rows.push(['How to use', 'Open this card in your Console → booking → 📄 Documents, or ask the 3JN Assistant.']);
  }
  return { type: c.type, icon: iconFor(c.type), label: labelFor(c.type), supplier: c.supplier, rows };
}

// All included-service cards for a booking — feeds the Console Documents panel.
export function includedServices(booking) {
  const comps = booking.option?.components || [];
  const flights = comps.filter((x) => x.type === 'flight');
  const stays = comps.filter((x) => x.type === 'hotel' || x.type === 'host');
  const trip = flights[0]?.details || {};
  const startDate = trip.outbound?.date || stays[0]?.details?.checkIn || '';
  const endDate = trip.inbound?.date || stays[0]?.details?.checkOut || '';
  // Index within the filtered list — identical to the printed document's
  // indexing, so the refs (TRF-…, VCH-…) match exactly on both surfaces.
  return comps
    .filter((c) => !['flight', 'hotel', 'host'].includes(c.type))
    .map((c, i) => serviceBlockData(booking, c, i, { startDate, endDate }));
}
