// 3JN Travel OS — frontend controller.
// Talks to the JSON API, drives view switching, and renders the full pipeline.

const state = {
  context: null,
  user: null,
  country: null,
  lastPlan: null,
  lastQuote: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---- API helper (never lets an error surface as an empty object) ----------
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.user) headers['x-user-id'] = state.user.id;
  if (state.country) headers['x-country'] = state.country;
  try {
    const res = await fetch(path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
    return data;
  } catch (err) {
    toast(`⚠ ${err.message}`);
    throw err;
  }
}

function money(n, sym) {
  return `${sym || state.context?.context?.currency?.symbol || '£'}${Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}
function money2(n, sym) {
  return `${sym || '£'}${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ---- Toast ----------------------------------------------------------------
let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 3200);
}

// ---- Modal ----------------------------------------------------------------
function modal(html) {
  $('#modalBody').innerHTML = html + '<button class="btn btn-ghost btn-sm" style="margin-top:18px" onclick="closeModal()">Close</button>';
  $('#modalBg').classList.add('show');
}
window.closeModal = () => $('#modalBg').classList.remove('show');
$('#modalBg').addEventListener('click', (e) => { if (e.target.id === 'modalBg') closeModal(); });

// ---- View routing ---------------------------------------------------------
function nav(view) {
  $$('.view').forEach((v) => v.classList.remove('active'));
  const el = $(`#view-${view}`);
  if (el) el.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (view === 'console') renderConsole();
}
document.addEventListener('click', (e) => {
  const navEl = e.target.closest('[data-nav]');
  if (navEl) { e.preventDefault(); nav(navEl.dataset.nav); }
});

// ---- Static content (agents, tiers, steps, loyalty) -----------------------
const AGENTS = [
  ['✈', 'Flight Intelligence', 'Scans carriers for the cheapest reliable inbound + outbound fares.'],
  ['🏨', 'Hotel Negotiation', 'Compares hotels and private hosts, negotiates upgrades & board.'],
  ['🛂', 'Visa Automation', 'Detects requirements by nationality and processes eVisas.'],
  ['🚘', 'Transfer Logistics', 'Books verified airport transfers for arrival & departure.'],
  ['🛡', 'Savings Guard', 'Monitors price 24/7 and rebooks or refunds the difference.'],
  ['📊', 'Risk Intelligence', 'Weather, safety, currency and demand signals per destination.'],
  ['📶', 'Connectivity Agent', 'Finds the best-value eSIM / roaming for your data needs.'],
  ['💷', 'Currency Agent', 'Detects your local currency and prices everything transparently.'],
  ['🧾', 'Insurance Agent', 'Matches verified travel cover to your trip length & party.'],
  ['🧠', 'Itinerary Agent', 'Assembles activities into a coherent day-by-day plan.'],
];

const TIERS = [
  { save: '£420/yr', name: 'Travel+ Nomad', price: '£4.99', feature: false,
    benefits: ['AI Negotiation Engine', 'Priority Savings Alerts', '0% Transaction Fees', 'Digital Visa Assistance'] },
  { save: '£1,100/yr', name: 'Travel+ Family', price: '£12.99', feature: true, badge: 'Most popular for families',
    benefits: ['All Nomad Features', 'Child Safety Intelligence', 'Family Lounge Access', 'Sync-Mesh Itinerary'] },
  { save: '£2,400/yr', name: 'Travel+ Executive', price: '£24.99', feature: false,
    benefits: ['All Family Features', 'Fast-Track Security', 'Coworking Intelligence', 'Expense Integration'] },
  { save: '£5,000/yr+', name: 'Travel+ Elite', price: '£49.99', feature: false,
    benefits: ['All Executive Features', 'Private Aviation Access', 'Guaranteed Upgrades', '24/7 Risk Mitigation'] },
];

const STEPS = [
  ['01', 'AI CORE', 'Neural Intent Extraction', 'Our proprietary AI agents analyse your natural language requests to identify over 40 distinct travel parameters including destination intent, preferred budget tiers, and service requirements.'],
  ['02', 'INVENTORY', 'Global Wholesaler Negotiation', "3JN connects directly to the world's largest travel wholesalers and GDS networks, bypassing retail markups to identify the 'Global Minimum Price' for your specific itinerary."],
  ['03', 'SECURITY', 'Integrity Verification Shield', "Every flight and hotel option is cross-referenced against a 50-point integrity check. We only surface 'Verified' suppliers that meet our strict reliability and quality standards."],
  ['04', 'REWARDS', 'Loyalty Discount Injection', 'The OS automatically checks your 3JN membership status (Explorer to Elite) and injects an additional member-only discount on top of the already reduced wholesale rate.'],
  ['05', 'LOGISTICS', 'Universal Console Sync', 'Once secured, your journey is instantly synchronised with your Universal Console, centralising your visas, transfers, and eSIMs into one high-tech management interface.'],
  ['06', 'CONTINUOUS', 'Neural Price Guard', 'Our agents monitor global inventory 24/7 post-booking. If the price for your specific flight or hotel drops before you travel, we automatically rebook or refund you the difference.'],
];

const LOYALTY = [
  ['Explorer', '0 pts', '2% discount'],
  ['Voyager', '1,000 pts', '5% discount'],
  ['Nomad', '5,000 pts', '8% discount'],
  ['Elite', '15,000 pts', '12% discount + priority verification'],
];

function renderStatic() {
  $('#agentGrid').innerHTML = AGENTS.map(([ico, name, desc]) => `
    <div class="card agent-card"><div class="ag-ico">${ico}</div><h4>${name}</h4><p>${desc}</p></div>`).join('');

  const tierHTML = TIERS.map((t) => `
    <div class="card tier ${t.feature ? 'feature' : ''}">
      ${t.feature ? `<span class="badge-top">${t.badge}</span>` : ''}
      <div class="save-chip">Est. Savings ${t.save}</div>
      <h3>${t.name}</h3>
      <div class="price">${t.price}<span> /month</span></div>
      <ul>${t.benefits.map((b) => `<li>${b}</li>`).join('')}</ul>
      <button class="btn ${t.feature ? 'btn-gold' : 'btn-ghost'} btn-block" onclick="selectTier('${t.name}')">Select ${t.name.split(' ').pop()}</button>
    </div>`).join('');
  $('#tierGrid').innerHTML = tierHTML;
  $('#tierGridFull').innerHTML = tierHTML;

  $('#stepsGrid').innerHTML = STEPS.map(([num, tag, title, desc]) => `
    <div class="card step"><span class="num">${num}</span><span class="tag">${tag}</span><h3>${title}</h3><p>${desc}</p></div>`).join('');

  $('#loyaltyGrid').innerHTML = LOYALTY.map(([name, pts, disc]) => `
    <div class="card agent-card"><div class="ag-ico" style="background:rgba(216,180,106,0.15)">★</div><h4>${name}</h4><p>${pts} · ${disc}</p></div>`).join('');
}
window.selectTier = (name) => toast(`✓ ${name} selected — checkout is a prototype step.`);

// ---- Boot -----------------------------------------------------------------
async function boot() {
  renderStatic();
  try {
    state.context = await api('/api/context');
    const sel = $('#countrySelect');
    sel.innerHTML = state.context.currencies
      .map((c) => `<option value="${c.country}">${c.countryName} (${c.code})</option>`).join('');
    sel.value = state.context.context.country;
    state.country = sel.value;
    sel.addEventListener('change', () => { state.country = sel.value; syncCurrency(sel.value); });

    // Footer currency selector mirrors the planner country/currency.
    const fc = $('#footerCurrency');
    if (fc) {
      fc.innerHTML = state.context.currencies
        .map((c) => `<option value="${c.country}">${c.code} ${c.symbol}</option>`).join('');
      fc.value = state.context.context.country;
      fc.addEventListener('change', () => { state.country = fc.value; sel.value = fc.value; toast(`Currency set to ${fc.options[fc.selectedIndex].text.trim()}.`); });
    }
    const lang = $('#langSelect');
    if (lang) lang.addEventListener('change', () => toast(`Language: ${lang.options[lang.selectedIndex].text}. (Full i18n in roadmap — EN/FR/SW/LN/AR.)`));
  } catch { /* toast already shown */ }
}
function syncCurrency(country) {
  const fc = $('#footerCurrency');
  if (fc) fc.value = country;
}

// ---- Planner --------------------------------------------------------------
$('#planBtn').addEventListener('click', runPlan);
$$('.chip').forEach((c) => c.addEventListener('click', () => {
  $('#intentInput').value = c.dataset.example;
  runPlan();
}));

async function runPlan(overrides = {}) {
  const text = $('#intentInput').value.trim();
  if (!text) { toast('Describe your trip first.'); return; }
  const out = $('#plannerOut');
  out.innerHTML = scanAnimation();

  // brief, staged scan animation for feel
  await tick(450);

  let data;
  try {
    data = await api('/api/plan', {
      method: 'POST',
      body: JSON.stringify({
        text,
        searchTier: $('#tierSelect').value,
        country: state.country,
        currencyCountry: state.country,
        overrides,
      }),
    });
  } catch { out.innerHTML = ''; return; }

  state.lastPlan = data;

  if (data.stage === 'clarify') { renderClarify(data); return; }
  renderOptions(data);
}

function scanAnimation() {
  const lines = ['Understanding intent…', 'Detecting location & currency…', 'Checking cost-protection gate…', 'Scanning verified global suppliers…', 'Filtering for reliability…', 'Building transparent packages…'];
  return `<div class="card pad scanlog">${lines.map((l, i) => `<div class="ln" style="animation-delay:${i * 70}ms"><span class="ok">●</span> ${l}</div>`).join('')}</div>`;
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function renderClarify(data) {
  const qs = data.questions.map((q) => `
    <div style="margin-top:14px">
      <strong>${q.question}</strong>
      <div class="chips">${q.options.map((o) => `<span class="chip" onclick="answer('${q.id}','${o}')">${o}</span>`).join('')}</div>
    </div>`).join('');
  $('#plannerOut').innerHTML = `<div class="card pad"><span class="eyebrow">A couple of quick questions</span>
    <p class="muted" style="font-size:14px">We need a little more to build your best package.</p>${qs}</div>`;
}
window.answer = (id, val) => runPlan({ [id]: val });

function renderOptions(data) {
  const intent = data.intent;
  const gate = data.gate;
  const sym = data.context.currency.symbol;

  const gateBanner = gate.allowed
    ? `<div class="pill" style="margin:0 0 16px"><span class="dot"></span> ${gate.tierName} ran · funded by ${gate.reason} · AI cost $${gate.aiCostUSD}</div>`
    : `<div class="card pad" style="margin-bottom:16px;border-color:rgba(216,180,106,0.4)">
        <strong>⚠ Cost-Protection Gate</strong>
        <p class="muted" style="font-size:13.5px;margin:6px 0 10px">${gate.requirement?.message || 'Search downgraded.'}</p>
        <button class="btn btn-gold btn-sm" onclick="buyAcuFlow()">Buy ACUs to unlock</button>
      </div>`;

  const summary = `
    <div class="card pad" style="margin-bottom:20px">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:14px;align-items:center">
        <div>
          <span class="eyebrow">Trip understood</span>
          <div style="font-size:20px;font-family:'Space Grotesk';font-weight:700">${intent.destination.city}, ${intent.destination.countryName}</div>
          <div class="muted" style="font-size:13.5px">${intent.travellers.adults} adult${intent.travellers.adults > 1 ? 's' : ''}${intent.travellers.children ? ` · ${intent.travellers.children} children` : ''} · ${intent.nights} nights · ${intent.month || 'flexible'} · ${intent.dates.checkIn} → ${intent.dates.checkOut}</div>
        </div>
        <div style="text-align:right">
          <div class="t-label">Components</div>
          <div style="font-size:13px">${intent.components.join(' · ')}</div>
        </div>
      </div>
    </div>`;

  const scanRows = Object.entries(data.scanSummary).map(([k, s]) =>
    `<div class="ln"><span class="ok">●</span> ${k}: scanned ${s.scanned}, ${s.verified} verified, ${s.reliable} reliable</div>`).join('');
  const scanCard = `<div class="card pad scanlog" style="margin-bottom:20px"><span class="eyebrow">Supplier scan</span>${scanRows}</div>`;

  const opts = data.packages.options.map((o) => optionCard(o, sym, intent)).join('');

  $('#plannerOut').innerHTML = gateBanner + summary + scanCard +
    `<div class="section-head left" style="margin-bottom:10px"><h2 style="font-size:24px">Your package options</h2>
      <p>Recommended: <strong style="color:var(--gold)">${data.packages.recommendedTier}</strong> · Cheapest: <strong>${data.packages.cheapestTier}</strong>. 3JN's 10% fee is shown openly in every breakdown.</p></div>
    <div class="opt-grid">${opts}</div>`;

  // stash options for booking
  window.__options = {};
  data.packages.options.forEach((o) => { window.__options[o.tier] = o; });
  window.__intent = intent;
}

function optionCard(o, sym, intent) {
  const p = o.pricing;
  const comps = o.components.map((c) => {
    const src = c.sourcedVia ? `<span class="src ${c.agent ? 'agent' : ''}" title="${c.agent && c.agentId ? '3JN agent account ' + c.agentId : ''}">${c.agent ? '🔑 agent · ' : '↗ '}${c.sourcedVia}${c.agent && c.agentId ? ' · ' + c.agentId : ''}</span>` : '';
    return `
    <li><span class="cs">${labelFor(c)} <span class="muted">· ${c.supplier}</span> ${src}</span><span class="cp">${money2(c.priceUSD * (p.local.total / p.lines.totalUSD), sym)}</span></li>`;
  }).join('');
  return `
    <div class="card opt ${o.recommended ? 'rec' : ''}">
      ${o.recommended ? '<span class="rec-tag">★ Recommended</span>' : ''}
      <span class="verified-tag">✓ ${o.verified ? '100% Verified' : 'Mixed'} · reliability ${o.avgReliability}</span>
      <div class="rel-bar"><i style="width:${o.avgReliability}%"></i></div>
      <h3>${o.tier}</h3>
      <div class="blurb">${o.blurb}</div>
      <div class="price-big">${money(p.local.total, sym)}</div>
      ${p.local.savingsVsMarket > 0 ? `<div class="save-tag">You save ${money(p.local.savingsVsMarket, sym)} vs market</div>` : '<div class="save-tag">&nbsp;</div>'}
      <ul class="comp-list">${comps}</ul>
      <table class="brk">
        <tr><td>Suppliers</td><td>${money2(p.local.suppliers, sym)}</td></tr>
        <tr class="save"><td>Loyalty discount (${p.loyaltyTier} · ${(p.loyaltyDiscountPct * 100).toFixed(0)}%)</td><td>-${money2(p.local.loyaltyDiscount, sym)}</td></tr>
        <tr><td>3JN commission (10%)</td><td>${money2(p.local.commission, sym)}</td></tr>
        <tr class="total"><td>Total</td><td>${money2(p.local.total, sym)}</td></tr>
      </table>
      <button class="btn ${o.recommended ? 'btn-gold' : 'btn-ghost'} btn-block" style="margin-top:16px" onclick="openBooking('${o.tier}')">Quote & ${intent.wantsInstalments ? 'pay in instalments' : 'book'}</button>
    </div>`;
}

function labelFor(c) {
  const map = { flight: '✈ Flights', hotel: '🏨 Hotel', host: '🏡 Private host', activity: '🎟 ' + c.supplier, visa: '🛂 Visa', insurance: '🛡 Insurance', transfer: '🚘 Transfer', carhire: '🚗 Car/bike hire', tickets: '🎫 ' + c.supplier, boat: '⛵ ' + c.supplier, esim: '📶 eSIM' };
  return map[c.type] || c.type;
}

// ---- Booking + instalments ------------------------------------------------
window.openBooking = async (tier) => {
  const option = window.__options[tier];
  const intent = window.__intent;
  let data;
  try {
    data = await api('/api/quote', { method: 'POST', body: JSON.stringify({ option, intent, months: 3, depositPct: 0.2 }) });
  } catch { return; }
  state.lastQuote = data.quote;
  const inst = data.quote.instalment;
  const sym = option.pricing.symbol;

  const rows = inst.schedule.map((s, i) => `<div class="kv"><span>Instalment ${i + 1} · due ${s.due}</span><span>${money2(s.amount, sym)}</span></div>`).join('');
  modal(`
    <span class="eyebrow">${tier} package · ${intent.destination.city}</span>
    <h3 style="margin:6px 0 4px">${money2(option.pricing.local.total, sym)} total</h3>
    <p class="muted" style="font-size:13.5px">Deposit ${(inst.depositPct * 100).toFixed(0)}% today, then ${inst.months} interest-free instalments.</p>
    <div class="kv" style="font-weight:700"><span>Deposit today</span><span style="color:var(--gold)">${money2(inst.deposit, sym)}</span></div>
    ${rows}
    <div class="field" style="margin-top:14px">
      <label>Payment method</label>
      <select id="payMethod" class="in">
        <option value="card">💳 Card (Visa / Mastercard) — via Stripe</option>
        <option value="bitripay">🅱 BitriPay Wallet — instant</option>
        <option value="mpesa">📱 M-Pesa (CDF / KES)</option>
        <option value="airtel">📱 Airtel Money (CDF)</option>
        <option value="orange">📱 Orange Money (CDF / XOF)</option>
        <option value="africell">📱 Africell Money (CDF)</option>
      </select>
    </div>
    <button class="btn btn-gold btn-block" style="margin-top:16px" onclick="confirmBooking()">Pay deposit & confirm booking</button>`);
};

window.confirmBooking = async () => {
  if (!state.lastQuote) return;
  const paymentMethod = $('#payMethod')?.value || 'card';
  if (!state.user) {
    // auto-create a guest so loyalty & console work
    const u = await api('/api/account', { method: 'POST', body: JSON.stringify({ name: 'Guest Traveller' }) });
    setUser(u.user);
  }
  let data;
  try {
    data = await api('/api/book', { method: 'POST', body: JSON.stringify({ quoteId: state.lastQuote.id, months: 3, depositPct: 0.2, paymentMethod }) });
  } catch { return; }
  if (data.user) setUser(data.user);
  closeModal();
  const rail = paymentMethod === 'card' ? 'Stripe' : paymentMethod === 'bitripay' ? 'BitriPay Wallet' : 'BitriPay Mobile Money';
  toast(`✓ Booking confirmed — deposit paid via ${rail}. Opening your console.`);
  nav('console');
};

// ---- Console --------------------------------------------------------------
async function renderConsole() {
  const out = $('#consoleOut');
  if (!state.user) {
    out.innerHTML = `<div class="card pad center"><p class="muted">No journeys yet.</p>
      <button class="btn btn-gold" data-nav="planner">Plan your first trip</button>
      <button class="btn btn-ghost" onclick="provisionTest()" style="margin-left:10px">Use test account</button></div>`;
    return;
  }
  let data;
  try { data = await api(`/api/account/${state.user.id}`); } catch { return; }
  const u = data.user;
  const bookings = data.bookings || [];

  const profile = `
    <div class="card pad">
      <span class="eyebrow">Member</span>
      <h3 style="margin:4px 0">${u.name}</h3>
      <div class="kv"><span>Tier</span><span style="color:var(--gold)">${u.tier} (${(u.tierDiscount * 100).toFixed(0)}% off)</span></div>
      <div class="kv"><span>Loyalty points</span><span>${u.points.toLocaleString()}</span></div>
      <div class="kv"><span>ACU balance</span><span>${u.acuBalance.toLocaleString()}</span></div>
      <div class="kv"><span>Referral code</span><span>${u.referralCode}</span></div>
      <div class="kv"><span>Referrals</span><span>${u.referrals}</span></div>
      <button class="btn btn-ghost btn-sm btn-block" style="margin-top:12px" onclick="buyAcuFlow()">Buy ACU pack</button>
    </div>`;

  const cards = bookings.length ? bookings.map((b) => bookingCard(b)).join('') :
    `<div class="card pad center muted">No bookings yet. <button class="btn btn-ghost btn-sm" data-nav="planner">Plan a trip</button></div>`;

  out.innerHTML = `<div class="console-grid"><div>${profile}</div><div>${cards}</div></div>`;
}

function bookingCard(b) {
  const o = b.option;
  const sym = o.pricing.symbol;
  const intent = b.option;
  const pgEvents = (b.priceGuard.events || []).map((e) => `
    <div class="pg-event ${e.action === 'rebook-refund' ? 'drop' : ''}">${e.message}${e.refundUSD ? ` <strong style="color:var(--green)">(+${money2(e.refundUSD * (o.pricing.local.total / o.pricing.lines.totalUSD), sym)})</strong>` : ''}</div>`).join('');
  const sched = (b.instalment?.schedule || []).map((s, i) => `
    <div class="kv"><span>Instalment ${i + 1} · ${s.due}</span><span>${s.status === 'paid' ? '✓ paid' : `${money2(s.amount, sym)} <a onclick="payInstalment('${b.id}',${i},${s.amount})" style="color:var(--gold);cursor:pointer">pay now</a>`}</span></div>`).join('');
  const comps = o.components.map((c) => labelFor(c)).join(' · ');

  return `
    <div class="card booking-card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div><strong>${o.tier} package</strong> <span class="tag-confirmed">${b.status}</span></div>
        <strong style="font-family:'Space Grotesk'">${money2(o.pricing.local.total, sym)}</strong>
      </div>
      <p class="muted" style="font-size:12.5px;margin:6px 0">${comps}</p>
      <div style="margin:10px 0">${sched}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <button class="btn btn-ghost btn-sm" onclick="runGuard('${b.id}')">▶ Run Price Guard</button>
        <button class="btn btn-ghost btn-sm" onclick="reviewFlow('${b.id}')">★ Review suppliers</button>
      </div>
      ${pgEvents ? `<div style="margin-top:10px"><span class="eyebrow">Neural Price Guard</span>${pgEvents}</div>` : ''}
    </div>`;
}

window.payInstalment = async (id, index, amount) => {
  try { await api(`/api/book/${id}/pay`, { method: 'POST', body: JSON.stringify({ index, amount }) }); } catch { return; }
  toast('✓ Instalment paid.');
  renderConsole();
};

window.runGuard = async (id) => {
  try {
    const data = await api(`/api/book/${id}/price-guard`, { method: 'POST', body: JSON.stringify({}) });
    toast(data.event.message);
  } catch { return; }
  renderConsole();
};

window.reviewFlow = (bookingId) => {
  const b = state.user;
  const opts = (window.__options && Object.keys(window.__options).length) ? null : null;
  modal(`
    <span class="eyebrow">Post-trip review</span>
    <h3 style="margin:6px 0">Rate your suppliers</h3>
    <p class="muted" style="font-size:13px">Your ratings feed supplier scores and improve future recommendations.</p>
    <div class="field" style="margin-top:10px">
      <label>Supplier</label>
      <input class="in" id="revSupplier" placeholder="e.g. Emirates" />
    </div>
    <div style="margin:12px 0"><div class="t-label">Rating</div><div class="stars" id="revStars" data-val="5">★★★★★</div></div>
    <textarea id="revComment" class="in" style="width:100%;min-height:70px" placeholder="Optional comment"></textarea>
    <button class="btn btn-gold btn-block" style="margin-top:14px" onclick="submitReview('${bookingId}')">Submit review</button>`);
  let val = 5;
  $('#revStars').addEventListener('click', (e) => {
    const rect = e.target.getBoundingClientRect();
    val = Math.max(1, Math.ceil(((e.clientX - rect.left) / rect.width) * 5));
    e.target.dataset.val = val;
    e.target.textContent = '★★★★★'.slice(0, val) + '☆☆☆☆☆'.slice(0, 5 - val);
  });
};
window.submitReview = async (bookingId) => {
  const supplier = $('#revSupplier').value.trim();
  if (!supplier) { toast('Enter a supplier name.'); return; }
  const rating = Number($('#revStars').dataset.val) || 5;
  const comment = $('#revComment').value.trim();
  try { await api('/api/reviews', { method: 'POST', body: JSON.stringify({ supplier, rating, comment, bookingId, userId: state.user?.id }) }); } catch { return; }
  closeModal();
  toast(`✓ Review saved for ${supplier}.`);
};

// ---- ACU / account --------------------------------------------------------
window.buyAcuFlow = () => {
  modal(`
    <span class="eyebrow">ACU Packs · fund AI searches</span>
    <h3 style="margin:6px 0">Buy AI Compute Units</h3>
    <p class="muted" style="font-size:13px">No costly AI search runs unless it's funded. Packs keep the platform profitable while you get world-minimum prices.</p>
    ${[['starter', 'Starter', '£5', '500'], ['traveller', 'Smart Traveller', '£15', '1,750'], ['family', 'Family', '£29', '4,000'], ['business', 'Business', '£99', '20,000']]
      .map(([id, name, gbp, acu]) => `<div class="kv"><span>${name} · ${acu} ACU</span><button class="btn btn-ghost btn-sm" onclick="buyAcu('${id}')">${gbp}</button></div>`).join('')}`);
};
window.buyAcu = async (pack) => {
  if (!state.user) { const u = await api('/api/account', { method: 'POST', body: JSON.stringify({}) }); setUser(u.user); }
  try { const data = await api(`/api/account/${state.user.id}/acu`, { method: 'POST', body: JSON.stringify({ pack }) });
    toast(`✓ ${data.charged ? '£' + data.charged + ' charged · ' : ''}balance ${data.balance.toLocaleString()} ACU`);
    setUser({ ...state.user, acuBalance: data.balance });
  } catch { return; }
  closeModal();
  if ($('#view-console').classList.contains('active')) renderConsole();
};

function setUser(u) {
  state.user = u;
  const chip = $('#userChip');
  chip.classList.remove('hidden');
  chip.innerHTML = `<span class="dot"></span> ${u.name} · ${u.tier} · ${u.points.toLocaleString()} pts`;
}

window.provisionTest = async () => {
  try { const data = await api('/api/account/test', { method: 'POST', body: JSON.stringify({}) });
    setUser(data.user);
    toast('✓ Voyager test account active.');
    nav('console');
  } catch { /* */ }
};
$('#testAccountBtn').addEventListener('click', window.provisionTest);

// ---- API portal calculator -----------------------------------------------
const volRange = $('#volRange');
function updateCalc() {
  const v = Number(volRange.value);
  const comm = v * 0.10;
  const partner = comm * 0.90;
  const share = comm * 0.10;
  $('#volLabel').textContent = '$' + v.toLocaleString();
  $('#cVol').textContent = '$' + v.toLocaleString();
  $('#cComm').textContent = '$' + comm.toLocaleString();
  $('#cPartner').textContent = '$' + partner.toLocaleString();
  $('#cShare').textContent = '$' + share.toLocaleString();
}
volRange.addEventListener('input', updateCalc);
$('#apiKeyBtn').addEventListener('click', () => toast('✓ API key request received — a partner manager will be in touch (prototype).'));
$('#apiTryBtn').addEventListener('click', async () => {
  const pre = $('#apiResult');
  pre.style.display = 'block';
  pre.textContent = 'Requesting…';
  try {
    const data = await api('/api/v1/search', { method: 'POST', body: JSON.stringify({ text: 'Family trip to Dubai in August for 7 nights with flights hotel and transfer' }) });
    pre.textContent = JSON.stringify(data, null, 2);
  } catch { pre.textContent = 'Request failed.'; }
});

// ---- WhatsApp-first conversational commerce -------------------------------
const WA_NUMBER = '442000000000'; // 3JN WhatsApp business line (placeholder)
function openWhatsApp(prefill) {
  const msg = prefill || ($('#intentInput')?.value?.trim()) ||
    'Hi 3JN Travel OS — I want to plan a trip. Here are my dates, group size and destination:';
  const url = `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(msg)}`;
  window.open(url, '_blank');
  toast('💬 Opening WhatsApp — your travel request is pre-filled.');
}
$('#waHero')?.addEventListener('click', () => openWhatsApp());

// ---- Footer content (punchy, persuasive marketing copy) -------------------
const CONTENT = {
  flights: {
    title: '✈ Flights — inbound & outbound, always the cheapest reliable fare',
    body: `<p class="muted">We scan global carriers and wholesalers (Kiwi, Trip.com and direct airline inventory) for <strong>both legs</strong> of your journey, filter out unreliable operators, and lock the lowest verified fare. No hidden fees — 3JN's 10% is shown openly.</p>
      <ul class="comp-list"><li><span class="cs">Return flights, every cabin</span></li><li><span class="cs">Verified airlines only (reliability ≥ 70)</span></li><li><span class="cs">Price-guarded after you book</span></li></ul>`,
    cta: 'planner',
  },
  hotels: {
    title: '🏨 Hotels & private hosts — wholesale rates, member discounts',
    body: `<p class="muted">From 5★ resorts to verified private apartments, sourced via Trip.com/Expedia wholesale and our host network — then your loyalty tier shaves even more off. Free-cancellation options surfaced first.</p>`,
    cta: 'planner',
  },
  visa: {
    title: '🛂 Visa Automation — know before you go',
    body: `<p class="muted">We detect visa requirements by your nationality and destination automatically, quote the exact cost and processing time, and handle eVisas through our concierge. No surprises at the airport.</p>`,
    cta: 'planner',
  },
  transfers: {
    title: '🚘 Airport Transfers — arrival & departure, sorted',
    body: `<p class="muted">Verified private transfers for both ends of your trip — business saloons to MPVs — priced into your package so there's no scramble when you land.</p>`,
    cta: 'planner',
  },
  marketplace: {
    title: '🧺 Destination Marketplace — every trip is a basket',
    body: `<p class="muted">Beyond the basics, bolt on the experiences that make a trip: tours & attraction tickets (Tiqets, WeGoTrip), boat & yacht charters (Searadar), event tickets (TicketNetwork), car & bike hire, eSIM data (Airalo), local guides, photographers and more — all verified, all in one transparent total.</p>
      <div class="chips"><span class="chip">🎟 Activities</span><span class="chip">⛵ Boat charter</span><span class="chip">🎫 Event tickets</span><span class="chip">🚗 Car & bike hire</span><span class="chip">📶 eSIM data</span></div>`,
    cta: 'planner',
  },
  careers: {
    title: '🚀 Careers — build the operating system for global travel',
    body: `<p class="muted">We're a small team rethinking how the world books travel — AI-native, savings-obsessed, globally diverse. If you want your work in the hands of travellers across 195+ countries, we want to hear from you.</p>
      <p class="muted">Open areas: supplier integrations, pricing & optimisation, growth, and 24/7 traveller support. Email <strong>careers@3jntravel.com</strong>.</p>`,
  },
  privacy: {
    title: '🔒 Privacy Policy',
    body: `<p class="muted">Your trust is the product. We collect only what's needed to plan, book and support your trip — destination, dates, travellers and payment details — and we never sell your personal data. Location/currency is detected to price you fairly. You can request export or deletion at any time via <strong>privacy@3jntravel.com</strong>.</p>
      <p class="muted" style="font-size:12px">Prototype notice: this demo stores data in memory only and clears on restart.</p>`,
  },
  terms: {
    title: '📜 Terms of Use',
    body: `<p class="muted">3JN Travel OS finds and packages travel from verified third-party suppliers and adds a transparent 10% service fee. Prices are guaranteed at the moment of quote and protected by our Price Guard. Deposits and instalments are interest-free; refunds and rebookings are processed where commercially and legally possible. Full terms at <strong>legal@3jntravel.com</strong>.</p>
      <p class="muted" style="font-size:12px">Prototype notice: no real bookings or payments are taken in this demo.</p>`,
  },
  support: {
    title: '🛟 Support — 24/7, in your language',
    body: `<p class="muted">Real help, before, during and after your trip: flight-disruption assistance, document checklists, visa-deadline alerts, rebooking and refund guidance. Reach us any time.</p>
      <div class="kv"><span>WhatsApp / Chat</span><span>+44 20 0000 0000</span></div>
      <div class="kv"><span>Email</span><span>support@3jntravel.com</span></div>
      <div class="kv"><span>In-trip emergency line</span><span>24/7</span></div>`,
  },
};
window.openContent = (key) => {
  const c = CONTENT[key];
  if (!c) return;
  const cta = c.cta ? `<button class="btn btn-gold btn-block" style="margin-top:16px" onclick="closeModal();nav('${c.cta}')">Plan a trip with this</button>` : '';
  modal(`<span class="eyebrow">3JN Travel OS</span><h3 style="margin:6px 0 10px">${c.title}</h3>${c.body}${cta}`);
};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-content]');
  if (el) { e.preventDefault(); window.openContent(el.dataset.content); }
});

// ---- Become a Host --------------------------------------------------------
$('#hostLink')?.addEventListener('click', () => {
  modal(`
    <span class="eyebrow">Host Programme</span>
    <h3 style="margin:6px 0">Become a 3JN Verified Host</h3>
    <p class="muted" style="font-size:13.5px">List your apartment or villa to travellers worldwide. Verified hosts appear inside package options alongside hotels — you earn on every stay, 3JN handles pricing, payments and the price guard.</p>
    <div class="field" style="margin-top:12px"><label>Property name</label><input class="in" id="hostName" placeholder="e.g. Marina View Apartment" /></div>
    <div class="field" style="margin-top:10px"><label>City</label><input class="in" id="hostCity" placeholder="e.g. Dubai" /></div>
    <div class="field" style="margin-top:10px"><label>Nightly rate (your currency)</label><input class="in" id="hostRate" placeholder="e.g. 120" /></div>
    <button class="btn btn-gold btn-block" style="margin-top:14px" onclick="submitHost()">Apply to host</button>`);
});
window.submitHost = () => {
  const name = $('#hostName')?.value.trim();
  if (!name) { toast('Enter a property name.'); return; }
  closeModal();
  toast(`✓ ${name} submitted for 50-point verification. We'll be in touch (prototype).`);
};

boot();
updateCalc();
