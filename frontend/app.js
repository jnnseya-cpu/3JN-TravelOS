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

// API base — empty for same-origin (Vercel rewrite or Firebase Hosting). Set
// window.API_BASE (see frontend/config.js) to call a Firebase Functions / Cloud
// Run URL directly when the frontend and backend are on different origins.
const API_BASE = (typeof window !== 'undefined' && window.API_BASE) ? String(window.API_BASE).replace(/\/$/, '') : '';

// ---- API helper (never lets an error surface as an empty object) ----------
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.user) headers['x-user-id'] = state.user.id;
  if (state.country) headers['x-country'] = state.country;
  let res;
  try {
    res = await fetch(API_BASE + path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  } catch (netErr) {
    toast('⚠ Cannot reach the 3JN API — check your connection or the API URL.');
    throw new Error('network');
  }
  // Read as text first so a non-JSON error page doesn't blow up JSON.parse.
  const raw = await res.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; }
  catch {
    // Backend returned HTML/text (e.g. a proxy/error page) — usually means the
    // frontend isn't routed to the API. Give an actionable message, not a parse error.
    const hint = API_BASE ? `API_BASE=${API_BASE}` : 'same-origin /api (set window.API_BASE or a rewrite to your backend)';
    const msg = `API returned a non-JSON response (HTTP ${res.status}). The backend may not be deployed/routed — ${hint}.`;
    toast(`⚠ ${msg}`);
    throw new Error(msg);
  }
  if (!res.ok) {
    const m = data.message || data.error || `HTTP ${res.status}`;
    toast(`⚠ ${m}`);
    throw new Error(m);
  }
  return data;
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
// Which roles may open each restricted view (mirrors the backend role guard).
const VIEW_ROLES = { admin: ['admin'], business: ['business', 'admin'] };
function canAccessView(view) {
  const roles = VIEW_ROLES[view];
  if (!roles) return true;
  const u = state.user;
  return !!u && (u.allAccess || roles.includes(u.role));
}

function nav(view) {
  // Block privileged views for the public — redirect home with a prompt.
  if (!canAccessView(view)) {
    const roles = VIEW_ROLES[view].join(' or ');
    toast(`The ${view} area requires a ${roles} account. Please sign in.`);
    if (!state.user) openAuth();
    view = 'home';
  }
  state.lastView = view;
  $$('.view').forEach((v) => v.classList.remove('active'));
  const el = $(`#view-${view}`);
  if (el) el.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (view === 'console') renderConsole();
  if (view === 'admin') renderAdmin();
  if (view === 'business') renderBusiness();
  if (view === 'visaos') renderVisaApply();
  if (view === 'marketplace') renderMarketplace();
  if (view === 'blog') renderBlog();
}
document.addEventListener('click', (e) => {
  const navEl = e.target.closest('[data-nav]');
  if (navEl) { e.preventDefault(); nav(navEl.dataset.nav); closeMobileNav(); }
});

// ---- Mobile navigation (hamburger) ----------------------------------------
function openMobileNav() {
  document.body.classList.add('nav-open');
  const t = $('#navToggle'); const s = $('#navScrim');
  if (t) { t.classList.add('on'); t.setAttribute('aria-expanded', 'true'); t.setAttribute('aria-label', 'Close menu'); }
  if (s) s.hidden = false;
}
function closeMobileNav() {
  document.body.classList.remove('nav-open');
  const t = $('#navToggle'); const s = $('#navScrim');
  if (t) { t.classList.remove('on'); t.setAttribute('aria-expanded', 'false'); t.setAttribute('aria-label', 'Open menu'); }
  if (s) s.hidden = true;
}
$('#navToggle')?.addEventListener('click', () => {
  if (document.body.classList.contains('nav-open')) closeMobileNav(); else openMobileNav();
});
$('#navScrim')?.addEventListener('click', closeMobileNav);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMobileNav(); });
window.addEventListener('resize', () => { if (window.innerWidth > 1080) closeMobileNav(); });

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
// Detect the user's language + country from their DEVICE (more reliable than a
// proxied header): navigator.languages + Intl timezone/region.
function detectDevice() {
  const langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en-GB'];
  const primary = langs[0] || 'en-GB';
  const langCode = primary.split('-')[0].toLowerCase();
  let region = (primary.split('-')[1] || '').toUpperCase();
  // Fall back to timezone → region heuristic when the locale has no region.
  if (!region) {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      const TZ = { 'Europe/London': 'GB', 'Asia/Dubai': 'AE', 'America/New_York': 'US', 'Europe/Paris': 'FR', 'Africa/Lagos': 'NG', 'Africa/Kinshasa': 'CD', 'Africa/Nairobi': 'KE', 'Asia/Kolkata': 'IN' };
      region = TZ[tz] || '';
    } catch { /* ignore */ }
  }
  const supportedLang = ['en', 'fr', 'sw', 'ln', 'ar'].includes(langCode) ? langCode : null;
  return { lang: supportedLang, region };
}

async function boot() {
  renderStatic();
  const device = detectDevice();
  try {
    state.context = await api('/api/context');
    const sel = $('#countrySelect');
    sel.innerHTML = state.context.currencies
      .map((c) => `<option value="${c.country}">${c.countryName} (${c.code})</option>`).join('');
    // Prefer the device region for currency if we support it, else server detection.
    const supportedCountry = state.context.currencies.some((c) => c.country === device.region);
    sel.value = supportedCountry ? device.region : state.context.context.country;
    state.country = sel.value;
    sel.addEventListener('change', () => { state.country = sel.value; syncCurrency(sel.value); });

    // Footer currency selector mirrors the planner country/currency.
    const fc = $('#footerCurrency');
    if (fc) {
      fc.innerHTML = state.context.currencies
        .map((c) => `<option value="${c.country}">${c.code} ${c.symbol}</option>`).join('');
      fc.value = state.country;
      fc.addEventListener('change', () => { state.country = fc.value; sel.value = fc.value; toast(`Currency set to ${fc.options[fc.selectedIndex].text.trim()}.`); });
    }

    const lang = $('#langSelect');
    if (lang) {
      // Device language wins, then server-detected, then English.
      const chosen = device.lang || (I18N[state.context.context.language] ? state.context.context.language : 'en');
      lang.value = chosen;
      applyLanguage(chosen);
      lang.addEventListener('change', () => { applyLanguage(lang.value); toast(`Language: ${lang.options[lang.selectedIndex].text}`); });
    }
  } catch { /* toast already shown */ }
  refreshNotifications();
  await restoreSession();
  applyRoleVisibility();
  applyDeepLink();
  refreshJourney();
}
// Open the right view from the URL — supports PWA shortcuts (/?view=planner)
// and direct/shared paths (/console, /visaos, /how-it-works, …).
function applyDeepLink() {
  const views = new Set(['home', 'planner', 'how', 'marketplace', 'blog', 'visaos', 'membership', 'api', 'console', 'business', 'admin']);
  const pathMap = { '': 'home', 'how-it-works': 'how', 'api-portal': 'api', 'destinations': 'marketplace' };
  let target = '';
  const qv = new URLSearchParams(location.search).get('view');
  if (qv && views.has(qv)) target = qv;
  else {
    const seg = location.pathname.replace(/^\/+|\/+$/g, '').split('/')[0];
    target = pathMap[seg] !== undefined ? pathMap[seg] : (views.has(seg) ? seg : '');
  }
  if (target && target !== 'home') nav(target);
}
function syncCurrency(country) {
  const fc = $('#footerCurrency');
  if (fc) fc.value = country;
}

// ---- Planner --------------------------------------------------------------
$('#planBtn').addEventListener('click', runPlan);
$$('.chip').forEach((c) => c.addEventListener('click', () => {
  $('#intentInput').value = c.dataset.example;
  autosaveIntent();
  runPlan();
}));

// ---- Autosave (master-prompt rule: save everything automatically) ---------
let autosaveT;
function autosaveIntent() {
  const status = $('#autosaveStatus');
  const text = $('#intentInput')?.value || '';
  if (status) status.textContent = '✍ saving…';
  clearTimeout(autosaveT);
  autosaveT = setTimeout(async () => {
    try {
      const d = await api('/api/drafts/intent', { method: 'PUT', body: JSON.stringify({ payload: { text } }) });
      if (status) status.textContent = '✓ autosaved';
    } catch { if (status) status.textContent = ''; }
  }, 700);
}
$('#intentInput')?.addEventListener('input', autosaveIntent);
// Restore any saved draft on load.
(async () => {
  try {
    const d = await api('/api/drafts/intent');
    if (d.draft?.payload?.text && $('#intentInput')) {
      // Only restore if the user hasn't changed the default — keep it unobtrusive.
      $('#autosaveStatus') && ($('#autosaveStatus').textContent = '✓ draft restored');
    }
  } catch { /* none */ }
})();

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
  // The search just taught the behaviour model something — rebuild the dashboard.
  refreshJourney();

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
      ${data.visa?.ok ? `<div class="pill" style="margin:14px 0 0;cursor:pointer" onclick="nav('visaos')"><span class="dot" style="background:${data.visa.approvalProbability >= 85 ? 'var(--green)' : 'var(--gold)'}"></span> 3JN VisaOS · approval probability <strong style="margin:0 4px">${data.visa.approvalProbability}%</strong> · ${data.visa.visaRequired ? 'visa required' : 'visa-free'} · decision in ~${data.visa.typicalDecisionMinutes} min</div>` : ''}
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
      <div style="display:flex;align-items:center;gap:12px">
        ${avatarHTML(u, 52)}
        <div><h3 style="margin:0">${u.name}</h3><div class="muted" style="font-size:12.5px">${u.email}</div>
        <span class="role-badge">${u.role}</span>${u.allAccess ? '<span class="role-badge" style="color:var(--green);border-color:rgba(70,211,154,0.4);background:rgba(70,211,154,0.08)">★ all access</span>' : ''}</div>
      </div>
      ${u.bio ? `<p class="muted" style="font-size:13px;margin:12px 0 0">${u.bio}</p>` : ''}
      <div class="kv" style="margin-top:12px"><span>Tier</span><span style="color:var(--gold)">${u.tier} (${(u.tierDiscount * 100).toFixed(0)}% off)</span></div>
      <div class="kv"><span>Loyalty points</span><span>${u.points.toLocaleString()}</span></div>
      <div class="kv"><span>ACU balance</span><span>${u.acuBalance.toLocaleString()}</span></div>
      <div class="kv"><span>Referral code</span><span>${u.referralCode}</span></div>
      <div class="kv"><span>Referrals</span><span>${u.referrals}</span></div>
      <button class="btn btn-gold btn-sm btn-block" style="margin-top:12px" onclick="editProfile()">✎ Edit profile &amp; picture</button>
      <button class="btn btn-ghost btn-sm btn-block" style="margin-top:8px" onclick="buyAcuFlow()">Buy ACU pack</button>
    </div>
    ${loyaltyHub(u)}
    <div class="card pad" style="margin-top:16px" id="intelCard">
      <span class="eyebrow">Travel Intelligence · Visa &amp; Risk</span>
      <div style="display:flex;gap:8px;margin-top:10px">
        <input class="in" id="intelDest" placeholder="Destination e.g. Dubai" style="flex:1">
        <button class="btn btn-ghost btn-sm" onclick="checkIntel()">Check</button>
      </div>
      <div id="intelOut"></div>
    </div>
    <div id="esimCard" class="card pad" style="margin-top:16px"></div>
    ${u.allAccess || ['executive', 'business', 'admin'].includes(u.role) || u.tier === 'Elite' || u.tier === 'Nomad' ? '<div id="expenseCard" class="card pad" style="margin-top:16px"></div>' : ''}
    ${u.allAccess || ['merchant', 'partner', 'admin'].includes(u.role) ? '<div id="merchantPortal" class="card pad" style="margin-top:16px"></div>' : ''}`;

  const cards = bookings.length ? bookings.map((b) => bookingCard(b)).join('') :
    `<div class="card pad center muted">No bookings yet. <button class="btn btn-ghost btn-sm" data-nav="planner">Plan a trip</button></div>`;

  out.innerHTML = `<div class="console-grid"><div>${profile}</div><div>${cards}</div></div>`;
  if (u.allAccess || ['merchant', 'partner', 'admin'].includes(u.role)) renderMerchantPortal();
  renderEsims();
  renderExpense();
}

// ---- eSIM Manager ---------------------------------------------------------
async function renderEsims() {
  const el = $('#esimCard');
  if (!el) return;
  let data; try { data = await api('/api/esims'); } catch { return; }
  const rows = (data.esims || []).map((e) => `
    <div class="kv"><span>📶 ${e.destination} · ${e.dataGB}GB <span class="muted">${e.coverage}</span></span>
      <span>${e.status === 'active'
        ? `<span style="color:var(--green)">active · ${e.dataUsedGB}/${e.dataGB}GB</span>`
        : `<a onclick="activateEsim('${e.id}')" style="color:var(--gold);cursor:pointer">activate</a>`}</span></div>`).join('')
    || '<div class="muted" style="font-size:13px">No eSIMs yet.</div>';
  el.innerHTML = `<span class="eyebrow">eSIM Manager · global connectivity</span>${rows}
    <div style="display:flex;gap:8px;margin-top:10px">
      <select class="in" id="esimDest"><option>Dubai</option><option>Istanbul</option><option>Barcelona</option><option>New York</option><option>Bali</option></select>
      <button class="btn btn-ghost btn-sm" onclick="provisionEsim()">+ Provision eSIM</button>
    </div>`;
}
window.provisionEsim = async () => {
  try { await api('/api/esims', { method: 'POST', body: JSON.stringify({ destination: $('#esimDest').value, dataGB: 5, days: 9 }) }); } catch { return; }
  toast('✓ eSIM provisioned.'); renderEsims();
};
window.activateEsim = async (id) => { try { await api(`/api/esims/${id}/activate`, { method: 'POST', body: '{}' }); } catch { return; } toast('✓ eSIM activated.'); renderEsims(); };

// ---- Expense Intelligence -------------------------------------------------
async function renderExpense() {
  const el = $('#expenseCard');
  if (!el) return;
  let data; try { data = await api('/api/expense'); } catch { return; }
  const r = data.report;
  const cats = Object.entries(r.categories || {});
  if (!cats.length) { el.innerHTML = '<span class="eyebrow">Expense Intelligence</span><div class="muted" style="font-size:13px;margin-top:6px">No expenses yet — book a trip to populate.</div>'; return; }
  const rows = cats.map(([k, v]) => `<div class="kv"><span>${k}</span><span>${r.currency} ${v.toLocaleString()}</span></div>`).join('');
  el.innerHTML = `<span class="eyebrow">Expense Intelligence</span>${rows}
    <div class="kv" style="font-weight:700"><span>Total</span><span style="color:var(--gold)">${r.currency} ${r.total.toLocaleString()}</span></div>
    <button class="btn btn-ghost btn-sm btn-block" style="margin-top:10px" onclick='downloadDoc("expenses", ${JSON.stringify(r.csv)})'>⬇ Export CSV (Xero/QuickBooks)</button>`;
}

// ---- Loyalty Hub ----------------------------------------------------------
const LOYALTY_LADDER = [['Explorer', 0], ['Voyager', 1000], ['Nomad', 5000], ['Elite', 15000]];
function loyaltyHub(u) {
  const idx = LOYALTY_LADDER.findIndex(([n]) => n === u.tier);
  const next = LOYALTY_LADDER[idx + 1];
  const floor = LOYALTY_LADDER[idx][1];
  const pct = next ? Math.min(100, Math.round(((u.points - floor) / (next[1] - floor)) * 100)) : 100;
  const toNext = next ? `${(next[1] - u.points).toLocaleString()} pts to ${next[0]}` : 'Top tier reached 🏆';
  const shareUrl = `https://3jntravel.com/?ref=${u.referralCode}`;
  return `
    <div class="card pad" style="margin-top:16px">
      <span class="eyebrow">Loyalty Hub</span>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:6px">
        <strong style="font-family:'Space Grotesk';font-size:18px;color:var(--gold)">${u.tier}</strong>
        <span class="muted" style="font-size:12.5px">${u.points.toLocaleString()} pts · ${(u.tierDiscount * 100).toFixed(0)}% off</span>
      </div>
      <div class="rel-bar" style="margin:10px 0 6px"><i style="width:${pct}%"></i></div>
      <div class="muted" style="font-size:12px">${toNext}</div>
      <div class="kv" style="margin-top:12px"><span>Refer &amp; earn</span><span>+100 you · +50 friend</span></div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <input class="in" id="refLink" value="${shareUrl}" readonly style="flex:1;font-size:12px">
        <button class="btn btn-ghost btn-sm" onclick="copyRef()">Copy</button>
        <button class="btn btn-gold btn-sm" onclick="shareRef('${shareUrl}')">Share</button>
      </div>
    </div>`;
}
window.copyRef = () => { const i = $('#refLink'); i.select(); try { navigator.clipboard.writeText(i.value); } catch {} toast('✓ Referral link copied.'); };
window.shareRef = async (url) => {
  if (navigator.share) { try { await navigator.share({ title: '3JN Travel OS', text: 'Plan smarter, travel cheaper with 3JN.', url }); return; } catch {} }
  window.copyRef();
};

// ---- Travel Intelligence (Visa + Risk) ------------------------------------
window.checkIntel = async () => {
  const dest = $('#intelDest').value.trim();
  if (!dest) { toast('Enter a destination.'); return; }
  const nat = state.country || 'GB';
  const out = $('#intelOut');
  out.innerHTML = '<div class="muted" style="font-size:13px;margin-top:10px">Checking…</div>';
  let visa, risk;
  try { visa = await api(`/api/visa/check?nationality=${nat}&destination=${encodeURIComponent(dest)}`); risk = await api(`/api/risk/${encodeURIComponent(dest)}`); } catch { return; }
  if (!visa.ok) { out.innerHTML = '<div class="muted" style="font-size:13px;margin-top:10px">Destination not recognised. Try Dubai, Istanbul, Barcelona, New York or Bali.</div>'; return; }
  const checklist = visa.checklist.map((c) => `<li><span class="cs">${c}</span></li>`).join('');
  const layers = (risk.ok ? risk.layers : []).map((l) => `<span class="chip">${l.layer}: ${l.note}</span>`).join('');
  out.innerHTML = `
    <div style="margin-top:14px">
      <div class="kv"><span>🛂 Visa (${visa.nationality} → ${visa.destination.city})</span><span>${visa.required ? `Required · $${visa.costUSD} · ${visa.processingDays}d` : '<span style="color:var(--green)">Not required</span>'}</span></div>
      ${visa.required ? `<div class="muted" style="font-size:12px;margin:4px 0">${visa.visaType}</div><ul class="comp-list">${checklist}</ul>` : ''}
      <div class="muted" style="font-size:12.5px;margin:6px 0 12px">${visa.recommendation}</div>
      ${risk.ok ? `<div class="kv"><span>🛡 Travel Risk Score</span><span style="color:var(--green)">${risk.riskScore} · ${risk.level}</span></div><div class="chips" style="margin-top:8px">${layers}</div>` : ''}
    </div>`;
};

// Render an avatar — emoji or uploaded image data URL.
function avatarHTML(u, size = 32) {
  const isImg = u.avatar && u.avatar.startsWith('data:');
  if (isImg) return `<img class="avatar" src="${u.avatar}" style="width:${size}px;height:${size}px" alt="">`;
  return `<span class="avatar avatar-emoji" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.5)}px">${u.avatar || '🧳'}</span>`;
}

// ---- Editable profile + picture -------------------------------------------
window.editProfile = () => {
  const u = state.user;
  const roleOpts = ['consumer', 'business', 'merchant', 'partner', 'admin']
    .map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>`).join('');
  modal(`
    <span class="eyebrow">Edit profile</span>
    <div style="display:flex;align-items:center;gap:14px;margin:10px 0">
      <span id="avatarPreview">${avatarHTML(u, 64)}</span>
      <div>
        <label class="btn btn-ghost btn-sm" style="cursor:pointer">📷 Upload picture<input type="file" id="avatarFile" accept="image/*" style="display:none"></label>
        <div class="muted" style="font-size:11px;margin-top:6px">or pick an emoji:</div>
        <div class="chips" style="margin-top:4px">${['🧳','💼','🏪','🤝','🛡️','🧑‍✈️','🌍','⭐'].map((e) => `<span class="chip" onclick="pickEmoji('${e}')">${e}</span>`).join('')}</div>
      </div>
    </div>
    <div class="field" style="margin-top:8px"><label>Name</label><input class="in" id="pfName" value="${(u.name || '').replace(/"/g, '&quot;')}"></div>
    <div class="field" style="margin-top:10px"><label>Email</label><input class="in" id="pfEmail" value="${(u.email || '').replace(/"/g, '&quot;')}"></div>
    <div class="field" style="margin-top:10px"><label>Role</label><select class="in" id="pfRole">${roleOpts}</select></div>
    <div class="field" style="margin-top:10px"><label>Bio</label><textarea class="in" id="pfBio" style="width:100%;min-height:60px">${u.bio || ''}</textarea></div>
    <button class="btn btn-gold btn-block" style="margin-top:14px" onclick="saveProfile()">Save profile</button>`);
  window.__avatar = u.avatar;
  $('#avatarFile')?.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 500000) { toast('Image too large (max ~500KB).'); return; }
    const reader = new FileReader();
    reader.onload = () => { window.__avatar = reader.result; $('#avatarPreview').innerHTML = `<img class="avatar" src="${reader.result}" style="width:64px;height:64px" alt="">`; };
    reader.readAsDataURL(f);
  });
};
window.pickEmoji = (e) => { window.__avatar = e; $('#avatarPreview').innerHTML = `<span class="avatar avatar-emoji" style="width:64px;height:64px;font-size:32px">${e}</span>`; };
window.saveProfile = async () => {
  const newEmail = $('#pfEmail').value.trim();
  // If signed in via Firebase and the email changed, use the secure verify-
  // before-update flow (sends a review email to the old address) instead of
  // silently changing it in the backend.
  if (window.firebaseAuth?.available && state.user?.email && newEmail && newEmail !== state.user.email) {
    try { await window.firebaseAuth.changeEmail(newEmail); toast('📧 Confirm the change via the email sent to your current address.'); }
    catch (e) { toast(e.message || 'Could not start email change.'); return; }
  }
  const patch = {
    name: $('#pfName').value, email: newEmail,
    role: $('#pfRole').value, bio: $('#pfBio').value, avatar: window.__avatar,
  };
  let data;
  try { data = await api(`/api/account/${state.user.id}`, { method: 'PATCH', body: JSON.stringify(patch) }); } catch { return; }
  setUser(data.user);
  closeModal();
  toast('✓ Profile updated.');
  renderConsole();
};

// ---- Merchant / white-label API portal ------------------------------------
async function renderMerchantPortal() {
  const el = $('#merchantPortal');
  if (!el) return;
  let data;
  try { data = await api('/api/merchant/keys'); } catch { return; }
  const keys = data.keys || [];
  const rows = keys.length ? keys.map((k) => `
    <div class="kv"><span>${k.label} <span class="muted">${k.prefix} · ${k.environment}</span></span>
    <span>${k.revokedAt ? '<span class="muted">revoked</span>' : `<a onclick="revokeKey('${k.id}')" style="color:#ff8a8a;cursor:pointer">revoke</a>`}</span></div>`).join('')
    : '<div class="muted" style="font-size:13px">No API keys yet. Create one to call the white-label API and earn 90% of generated commission.</div>';
  el.innerHTML = `
    <span class="eyebrow">Merchant / White-Label API</span>
    <p class="muted" style="font-size:12.5px;margin:6px 0 10px">Create keys to integrate the 3JN engine under your brand. You keep 90%; 3JN takes a 10% platform fee.</p>
    ${rows}
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn btn-gold btn-sm" onclick="createKey('sandbox')">+ Sandbox key</button>
      <button class="btn btn-ghost btn-sm" onclick="createKey('production')">+ Production key</button>
    </div>
    <div id="bitripayPortal" style="margin-top:20px"></div>`;
  renderBitriPay();
}

// ---- BitriPay Merchant Portal (payment links + QR + settlement) -----------
async function renderBitriPay() {
  const el = $('#bitripayPortal');
  if (!el) return;
  let data;
  try { data = await api('/api/bitripay/links'); } catch { return; }
  const s = data.settlement || {};
  const money = (minor) => `${s.currency || 'GBP'} ${((minor || 0) / 100).toFixed(2)}`;
  const links = (data.links || []).map((p) => `
    <div class="kv">
      <span>${p.ref} <span class="muted">${p.description}</span><br><span class="muted" style="font-size:11px">${p.url}</span></span>
      <span>${money(p.amountMinor)} · ${p.status === 'settled' ? '✓ settled' : `<a onclick="settleLink('${p.id}')" style="color:var(--gold);cursor:pointer">mark paid</a>`} <a onclick="showQR('${p.ref}','${p.qrData}')" style="cursor:pointer" title="QR">▦</a></span>
    </div>`).join('') || '<div class="muted" style="font-size:13px">No payment links yet.</div>';
  el.innerHTML = `
    <span class="eyebrow">BitriPay · Payment Links &amp; Settlement</span>
    <div class="kv"><span>Settled / pending</span><span>${s.settled || 0} / ${s.pending || 0}</span></div>
    <div class="kv"><span>Gross settled</span><span>${money(s.grossMinor)}</span></div>
    <div class="kv"><span>Gateway fee (~1.2%)</span><span>-${money(s.feeMinor)}</span></div>
    <div class="kv"><span>Net payout</span><span style="color:var(--green)">${money(s.netMinor)}</span></div>
    <div style="margin-top:12px">${links}</div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <input class="in" id="plAmount" placeholder="Amount e.g. 250.00" style="width:130px">
      <input class="in" id="plDesc" placeholder="Description" style="flex:1">
      <button class="btn btn-gold btn-sm" onclick="createLink()">+ Link / QR</button>
    </div>`;
}
window.createLink = async () => {
  const amount = parseFloat($('#plAmount').value) || 0;
  if (amount <= 0) { toast('Enter an amount.'); return; }
  try { await api('/api/bitripay/links', { method: 'POST', body: JSON.stringify({ amountMinor: Math.round(amount * 100), currency: 'GBP', description: $('#plDesc').value }) }); }
  catch { return; }
  toast('✓ Payment link created.');
  renderBitriPay();
};
window.settleLink = async (id) => { try { await api(`/api/bitripay/links/${id}/settle`, { method: 'POST', body: '{}' }); } catch { return; } toast('✓ Settled.'); renderBitriPay(); };
window.showQR = (ref, qrData) => {
  // Render a deterministic faux-QR (visual placeholder) from the payload hash.
  let h = 0; for (let i = 0; i < qrData.length; i++) h = (h * 31 + qrData.charCodeAt(i)) >>> 0;
  let cells = '';
  for (let r = 0; r < 11; r++) for (let c = 0; c < 11; c++) {
    h = (h * 1103515245 + 12345) >>> 0;
    if ((h >> 5) & 1) cells += `<rect x="${c}" y="${r}" width="1" height="1"/>`;
  }
  modal(`<span class="eyebrow">BitriPay QR · ${ref}</span>
    <div style="display:grid;place-items:center;margin:14px 0">
      <svg viewBox="0 0 11 11" width="180" height="180" style="background:#fff;border-radius:10px;padding:8px" fill="#06121f">${cells}</svg>
    </div>
    <p class="muted" style="font-size:12px;text-align:center">Scan with the BitriPay / mobile-money app. (Prototype QR — encodes <code>${qrData}</code>.)</p>`);
};
window.createKey = async (environment) => {
  let data;
  try { data = await api('/api/merchant/keys', { method: 'POST', body: JSON.stringify({ environment, label: environment === 'production' ? 'Live key' : 'Sandbox key' }) }); }
  catch { return; }
  if (!data.ok) { toast(data.message || 'Could not create key.'); return; }
  const k = data.key;
  modal(`
    <span class="eyebrow">API key created · ${k.environment}</span>
    <h3 style="margin:6px 0">Copy your secret now</h3>
    <p class="muted" style="font-size:13px">This is shown <strong>once</strong>. Store it securely — it won't be displayed again.</p>
    <pre class="card pad" style="font-size:12px;overflow:auto;font-family:monospace;user-select:all">${k.secret}</pre>
    <p class="muted" style="font-size:12px">Use it as the <code>x-partner-key</code> header on <code>POST /api/v1/search</code>. Revenue share: ${k.revenueShare}.</p>`);
  renderMerchantPortal();
};
window.revokeKey = async (keyId) => {
  try { await api(`/api/merchant/keys/${keyId}`, { method: 'DELETE' }); } catch { return; }
  toast('Key revoked.');
  renderMerchantPortal();
};

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
        <button class="btn btn-ghost btn-sm" onclick="openDocs('${b.id}')">📄 Documents</button>
      </div>
      ${pgEvents ? `<div style="margin-top:10px"><span class="eyebrow">Neural Price Guard</span>${pgEvents}</div>` : ''}
    </div>`;
}

// ---- Document Vault -------------------------------------------------------
window.openDocs = async (bookingId) => {
  let data;
  try { data = await api(`/api/book/${bookingId}`); } catch { return; }
  const b = data.booking;
  const o = b.option;
  const sym = o.pricing.symbol;
  const lines = o.components.map((c) => `  • ${labelFor(c).replace(/<[^>]+>/g, '')} — ${c.supplier}${c.agentId ? ` [agent ${c.agentId}]` : ''}`).join('\n');
  const doc = `3JN TRAVEL OS — BOOKING CONFIRMATION
=====================================
Booking ref : ${b.id}
Package     : ${o.tier}
Status      : ${b.status}
Paid via    : ${b.gateway}
Total       : ${sym}${o.pricing.local.total}

INCLUDED
${lines}

Powered by Artificial Intelligence • Built for Better Travel`;
  modal(`
    <span class="eyebrow">Document Vault · ${b.id}</span>
    <h3 style="margin:6px 0">Your travel documents</h3>
    <div class="kv"><span>✈ e-Ticket</span><span class="muted">issued</span></div>
    <div class="kv"><span>🏨 Hotel voucher</span><span class="muted">issued</span></div>
    <div class="kv"><span>🛡 Insurance certificate</span><span class="muted">issued</span></div>
    <div class="kv"><span>🛂 Visa approval</span><span class="muted">where applicable</span></div>
    <pre class="card pad" style="margin-top:12px;font-size:11px;white-space:pre-wrap;font-family:monospace">${doc.replace(/</g, '&lt;')}</pre>
    <button class="btn btn-gold btn-block" style="margin-top:12px" onclick='downloadDoc(${JSON.stringify(b.id)}, ${JSON.stringify(doc)})'>⬇ Download confirmation</button>`);
};
window.downloadDoc = (id, text) => {
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `3JN-${id}.txt`; a.click();
  URL.revokeObjectURL(url);
  toast('✓ Confirmation downloaded.');
};

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
  refreshNotifications();
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

// Access-denied panel for restricted views.
function accessGate(out, area, roles) {
  out.innerHTML = `<div class="card pad center" style="max-width:520px;margin:0 auto">
    <div style="font-size:34px">🔒</div>
    <h3 style="margin:10px 0 6px">${area} access required</h3>
    <p class="muted" style="font-size:14px">This area is restricted to <strong>${roles}</strong> accounts and isn't part of the public site.</p>
    <button class="btn btn-gold" style="margin-top:12px" onclick="openAuth()">Sign in</button>
    <button class="btn btn-ghost" style="margin-top:12px" onclick="provisionTest()">Use a full-access demo account</button>
  </div>`;
}

// ---- Admin Super Control Centre -------------------------------------------
async function renderAdmin() {
  const out = $('#adminOut');
  if (!canAccessView('admin')) { accessGate(out, 'Admin', 'admin'); return; }
  let data, auditData, sec, ops, seo, mkt;
  try {
    data = await api('/api/admin/overview'); auditData = await api('/api/admin/audit?limit=20');
    sec = (await api('/api/agents/security')).report; ops = (await api('/api/agents/ops')).report;
    seo = (await api('/api/agents/seo')).report; mkt = (await api('/api/agents/marketing')).report;
  } catch { accessGate(out, 'Admin', 'admin'); return; }
  const o = data.overview;
  const usd = (n) => '$' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });

  const kpis = [
    ['Users', o.users],
    ['Bookings', o.bookings],
    ['GMV', usd(o.gmvUSD)],
    ['3JN revenue', usd(o.totalRevenueUSD)],
    ['Commission', usd(o.commissionUSD)],
    ['Savings-share', usd(o.savingsShareUSD)],
    ['ACU sold', (o.acuPurchased || 0).toLocaleString()],
    ['ACU used', (o.acuUsed || 0).toLocaleString()],
    ['Reviews', o.reviews],
    ['Referrals', o.referrals],
  ];
  const kpiCards = kpis.map(([k, v]) => `<div class="card pad kpi"><div class="kpi-v">${v}</div><div class="kpi-k">${k}</div></div>`).join('');

  const mix = (obj) => Object.entries(obj || {}).map(([k, v]) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`).join('') || '<div class="muted" style="font-size:13px">none yet</div>';

  const board = (data.leaderboard || []).length
    ? data.leaderboard.map((s) => `<div class="kv"><span>${s.supplier}</span><span>${s.avgRating}★ · ${s.reviews}</span></div>`).join('')
    : '<div class="muted" style="font-size:13px">no reviews yet</div>';

  const g = data.gateway;
  const providers = Object.entries(g.providers).map(([id, p]) =>
    `<div class="kv"><span>${p.name} <span class="muted">${p.model}</span></span><span>${p.configured ? '🟢 live' : '⚪ local'}</span></div>`).join('');

  const streams = (data.revenueStreams || []).map((s) => `<span class="chip">${s}</span>`).join('');

  const activity = (data.activity || []).length
    ? data.activity.map((e) => `<div class="ln"><span class="ok">●</span> <span style="color:var(--muted-dim)">[${e.type}]</span> ${e.detail}</div>`).join('')
    : '<div class="muted" style="font-size:13px">no activity yet — make a booking to populate the feed</div>';

  out.innerHTML = `
    <div class="kpi-grid">${kpiCards}</div>
    <div class="console-grid" style="margin-top:20px">
      <div>
        <div class="card pad"><span class="eyebrow">AI Gateway · Model Router</span><p class="muted" style="font-size:12.5px;margin:6px 0 8px">Default: ${g.defaultProvider}. Providers route by task; local fallback when no key.</p>${providers}</div>
        <div class="card pad" style="margin-top:16px"><span class="eyebrow">Tier mix</span>${mix(o.tierMix)}</div>
        <div class="card pad" style="margin-top:16px"><span class="eyebrow">Payment rail mix</span>${mix(o.gatewayMix)}</div>
        <div class="card pad" style="margin-top:16px"><span class="eyebrow">Supplier leaderboard</span>${board}</div>
      </div>
      <div>
        <div class="card pad"><span class="eyebrow">Revenue streams (${(data.revenueStreams||[]).length})</span><div class="chips" style="margin-top:10px">${streams}</div></div>
        <div class="card pad scanlog" style="margin-top:16px"><span class="eyebrow">Live activity feed</span><div style="margin-top:8px">${activity}</div></div>
        <div class="card pad scanlog" style="margin-top:16px"><span class="eyebrow">Immutable audit log</span><div style="margin-top:8px">${
          (auditData.audit || []).length
            ? auditData.audit.map((a) => `<div class="ln"><span class="ok">●</span> <span style="color:var(--muted-dim)">${a.action}</span> · ${a.summary} <span class="muted">(${a.role})</span></div>`).join('')
            : '<div class="muted" style="font-size:13px">no audited actions yet</div>'
        }</div></div>
      </div>
    </div>
    <div class="section-head left" style="margin:28px 0 10px"><h2 style="font-size:20px">Enterprise AI agents</h2></div>
    <div class="console-grid">
      <div class="card pad">
        <span class="eyebrow">🛡 Security Agent · ${sec.level} (${sec.postureScore})</span>
        ${sec.controls.map((c) => `<div class="kv"><span>${c.control}</span><span class="muted" style="font-size:12px">${c.status}</span></div>`).join('')}
        ${sec.threats.length ? sec.threats.map((t) => `<div class="pg-event" style="border-color:rgba(255,90,90,.3)">${t.type} · ${t.severity} · ${t.note}</div>`).join('') : '<div class="muted" style="font-size:12px;margin-top:6px">No active threats.</div>'}
        <p class="muted" style="font-size:12px;margin-top:8px">${sec.recommendation}</p>
      </div>
      <div class="card pad">
        <span class="eyebrow">🔧 Ops / Self-healing Agent · ${ops.health}</span>
        ${ops.checks.map((c) => `<div class="kv"><span><span class="vstatus ${c.status === 'ok' ? 'pass' : c.status === 'disabled' ? 'watch' : 'fail'}"></span>${c.system}</span><span class="muted" style="font-size:12px">${c.detail}</span></div>`).join('')}
      </div>
    </div>
    <div class="console-grid" style="margin-top:16px">
      <div class="card pad">
        <span class="eyebrow">🔎 SEO Agent</span>
        <p class="muted" style="font-size:12.5px;margin:6px 0">${seo.recommendation}</p>
        <div class="chips">${seo.targetKeywords.slice(0, 8).map((k) => `<span class="chip">${k}</span>`).join('')}</div>
        <div style="margin-top:8px"><a class="muted" href="/sitemap.xml" target="_blank" style="font-size:12px;text-decoration:underline">sitemap.xml</a> · <a class="muted" href="/robots.txt" target="_blank" style="font-size:12px;text-decoration:underline">robots.txt</a></div>
      </div>
      <div class="card pad">
        <span class="eyebrow">📣 Marketing Agent</span>
        <p class="muted" style="font-size:12.5px;margin:6px 0">${mkt.positioning}</p>
        ${mkt.channels.slice(0, 4).map((c) => `<div class="kv"><span>${c.channel}</span><span class="muted" style="font-size:12px">${c.play}</span></div>`).join('')}
        <p class="muted" style="font-size:12px;margin-top:8px">${mkt.recommendation}</p>
      </div>
    </div>
    <p class="muted" style="font-size:12px;margin-top:14px">Prototype note: in production this centre is gated by role + AI Governance with dual-control and an immutable audit log (see docs/AI-OS-ARCHITECTURE.md §14).</p>`;
}

// ---- Blog (AI-written, hyperlinked, shareable) ----------------------------
$('#genPostBtn')?.addEventListener('click', async () => {
  try { await api('/api/blog/generate', { method: 'POST', body: '{}' }); toast('✨ New post published.'); renderBlog(); } catch {}
});
async function renderBlog() {
  const out = $('#blogOut');
  if (!out) return;
  let data; try { data = await api('/api/blog'); } catch { return; }
  const cards = (data.posts || []).map((p) => `
    <div class="card pad blog-card">
      <span class="eyebrow">${p.destination} · ${p.readMins} min read</span>
      <h3 style="margin:6px 0 6px;cursor:pointer" onclick="openPost('${p.slug}')">${p.title}</h3>
      <p class="muted" style="font-size:13.5px">${p.excerpt}</p>
      <div class="chips" style="margin-top:8px">${p.tags.map((t) => `<span class="chip">#${t}</span>`).join('')}</div>
      <div style="display:flex;gap:8px;margin-top:12px;align-items:center">
        <button class="btn btn-gold btn-sm" onclick="openPost('${p.slug}')">Read</button>
        ${shareButtons(p)}
      </div>
    </div>`).join('');
  out.innerHTML = `<div class="steps">${cards}</div>`;
}
function shareButtons(p) {
  const url = `${location.origin}/blog/${p.slug}`;
  const text = encodeURIComponent(p.title + ' — 3JN Travel OS');
  const u = encodeURIComponent(url);
  return `
    <a class="share" title="Share on X" target="_blank" href="https://twitter.com/intent/tweet?text=${text}&url=${u}">𝕏</a>
    <a class="share" title="Share on Facebook" target="_blank" href="https://www.facebook.com/sharer/sharer.php?u=${u}">f</a>
    <a class="share" title="Share on LinkedIn" target="_blank" href="https://www.linkedin.com/sharing/share-offsite/?url=${u}">in</a>
    <a class="share" title="Share on WhatsApp" target="_blank" href="https://wa.me/?text=${text}%20${u}">✆</a>
    <a class="share" title="Copy link" onclick="copyText('${url}')">🔗</a>`;
}
window.copyText = (t) => { try { navigator.clipboard.writeText(t); } catch {} toast('✓ Link copied.'); };
window.openPost = async (slug) => {
  let data; try { data = await api(`/api/blog/${slug}`); } catch { return; }
  const p = data.post;
  modal(`
    <span class="eyebrow">${p.destination} · ${p.readMins} min read · ${p.author}</span>
    <h2 style="margin:6px 0 4px;font-size:24px">${p.title}</h2>
    <div class="muted" style="font-size:12px;margin-bottom:12px">${p.tags.map((t) => '#' + t).join(' ')}</div>
    <div class="blog-body" onclick="blogLink(event)">${p.body}</div>
    <div style="display:flex;gap:8px;margin-top:16px;align-items:center"><span class="muted" style="font-size:12px">Share:</span>${shareButtons(p)}</div>`);
};
// Intercept internal links inside a post so they navigate the SPA, not reload.
window.blogLink = (e) => {
  const a = e.target.closest('a'); if (!a) return;
  const href = a.getAttribute('href') || '';
  const map = { '/planner': 'planner', '/marketplace': 'marketplace', '/visaos': 'visaos', '/membership': 'membership', '/blog': 'blog' };
  if (map[href]) { e.preventDefault(); closeModal(); nav(map[href]); if (map[href] === 'planner') runPlan(); }
};

// ---- Destination Marketplace ----------------------------------------------
async function renderMarketplace() {
  const out = $('#marketOut');
  if (!out) return;
  let data;
  try { data = await api(`/api/destinations?country=${state.country || 'GB'}`); } catch { out.innerHTML = '<div class="card pad muted">Failed to load.</div>'; return; }
  const cards = (data.destinations || []).map((d) => `
    <div class="card pad dest-card" onclick="trackView('${d.code}','${d.city}');planDest('${d.city}')">
      <div class="dest-emoji">${d.emoji}</div>
      <h3 style="margin:6px 0 2px">${d.city}</h3>
      <div class="muted" style="font-size:12.5px">${d.country} · ${d.tag}</div>
      <div class="exp-tags">${d.experiences.map((e) => `<span class="chip">${e}</span>`).join('')}</div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:12px">
        <span class="muted" style="font-size:12px">from</span>
        <span style="font-family:'Space Grotesk';font-weight:700;font-size:22px;color:var(--gold)">${d.symbol}${d.fromLocal.toLocaleString()}</span>
      </div>
      <button class="btn btn-gold btn-sm btn-block" style="margin-top:10px">Build my package →</button>
    </div>`).join('');
  out.innerHTML = `
    <div class="dest-grid">${cards}</div>
    <div class="card pad" style="margin-top:24px">
      <span class="eyebrow">Every trip is a marketplace basket</span>
      <div class="chips" style="margin-top:10px">${(data.addOns || []).map((a) => `<span class="chip">＋ ${a}</span>`).join('')}</div>
    </div>`;
}
window.planDest = (city) => {
  $('#intentInput').value = `I want to travel to ${city} with my family for 7 nights with flights, hotel, activities, transfer and eSIM — the cheapest reliable price.`;
  nav('planner');
  runPlan();
};

// ---- 3JN VisaOS -----------------------------------------------------------
$('#visaTabApply')?.addEventListener('click', renderVisaApply);
$('#visaTabGov')?.addEventListener('click', renderVisaGov);

function renderVisaApply() {
  const out = $('#visaosOut');
  if (!out) return;
  out.innerHTML = `
    <div class="planner-shell">
      <div class="card pad">
        <span class="eyebrow">Digital Visa Application</span>
        <p class="muted" style="font-size:12.5px">Submit once — the agent swarm verifies and decides. Toggle the verification signals to see how the engine reacts (these simulate the agents' upstream findings).</p>
        <div class="composer-row" style="margin-top:8px">
          <div class="field"><label>Full name</label><input class="in" id="vName" value="Daniel Okoro"></div>
          <div class="field"><label>Nationality</label>
            <select class="in" id="vNat"><option>GB</option><option>US</option><option selected>NG</option><option>IN</option><option>FR</option></select></div>
          <div class="field"><label>Destination</label>
            <select class="in" id="vDest"><option selected>Dubai</option><option>Istanbul</option><option>Barcelona</option><option>New York</option><option>Bali</option></select></div>
          <div class="field"><label>Purpose</label>
            <select class="in" id="vPurpose"><option>tourism</option><option>business</option><option>study</option><option>family visit</option><option>medical</option><option>conference</option></select></div>
          <div class="field"><label>Age</label><input class="in" id="vAge" value="34" style="width:70px"></div>
          <div class="field"><label>Employer</label><input class="in" id="vEmployer" value="GE Aerospace"></div>
          <div class="field"><label>Monthly income (USD)</label><input class="in" id="vIncome" value="4200" style="width:120px"></div>
          <div class="field"><label>Home ties</label><select class="in" id="vTies"><option value="strong">strong</option><option value="moderate">moderate</option><option value="weak">weak</option></select></div>
        </div>
        <div class="chips" style="margin-top:12px" id="vSignals">
          ${signalToggle('documentsAuthentic', 'Documents authentic', true)}
          ${signalToggle('fundsConsistent', 'Funds consistent', true)}
          ${signalToggle('footprintMatches', 'Footprint matches', true)}
          ${signalToggle('purposeCredible', 'Purpose credible', true)}
          ${signalToggle('priorOverstays', 'Prior overstay', false)}
          ${signalToggle('onWatchlist', 'On watchlist', false)}
          ${signalToggle('knownFraudNetwork', 'Fraud network', false)}
          ${signalToggle('suddenDeposit', 'Sudden deposit', false)}
        </div>
        <div class="field" style="margin-top:12px"><label>Behaviour: hesitation around employment (0=calm, 100=evasive) — <span id="vBehLbl">10</span></label>
          <input type="range" id="vBeh" min="0" max="100" value="10" oninput="document.getElementById('vBehLbl').textContent=this.value"></div>
        <button class="btn btn-gold" style="margin-top:14px" id="vSubmit">▶ Run Visa Decision Agent Swarm</button>
      </div>
      <div id="visaDecision" style="margin-top:20px"></div>
    </div>`;
  $('#vSubmit').addEventListener('click', submitVisa);
}
function signalToggle(key, label, on) {
  return `<span class="chip vsig ${on ? 'on' : ''}" data-key="${key}" data-on="${on}" onclick="toggleSignal(this)">${on ? '✓' : '○'} ${label}</span>`;
}
window.toggleSignal = (el) => { const on = el.dataset.on !== 'true'; el.dataset.on = on; el.classList.toggle('on', on); el.textContent = `${on ? '✓' : '○'} ${el.textContent.slice(2)}`; };

async function submitVisa() {
  const sig = {};
  $$('.vsig').forEach((el) => { sig[el.dataset.key] = el.dataset.on === 'true'; });
  const body = {
    name: $('#vName').value, nationality: $('#vNat').value, destination: $('#vDest').value,
    purpose: $('#vPurpose').value, age: Number($('#vAge').value), employer: $('#vEmployer').value,
    monthlyIncome: Number($('#vIncome').value), homeTies: $('#vTies').value,
    behaviourHesitation: Number($('#vBeh').value), ...sig,
  };
  const out = $('#visaDecision');
  const agents = ['Document Forensics', 'Financial Authenticity', 'Identity Verification', 'Online Footprint', 'Behavioural Intelligence', 'Overstay Risk', 'Fraud Detection', 'Intent Assessment', 'Border Risk', 'Decision Agent'];
  out.innerHTML = `<div class="card pad scanlog">${agents.map((a, i) => `<div class="ln" style="animation-delay:${i * 60}ms"><span class="ok">●</span> ${a} Agent verifying…</div>`).join('')}</div>`;
  await tick(700);
  let data;
  try { data = await api('/api/visaos/assess', { method: 'POST', body: JSON.stringify(body) }); } catch { return; }
  renderVisaDecision(data.assessment);
}

function renderVisaDecision(a) {
  const decColor = { 'Auto Approval': 'var(--green)', 'Conditional Approval': 'var(--gold)', 'Human Review': 'var(--blue-bright)', 'Auto Rejection': '#ff6b6b' }[a.decision];
  const agentRows = a.agents.map((ag) => `<div class="kv"><span><span class="vstatus ${ag.status}"></span>${ag.agent}</span><span class="muted" style="font-size:12px;max-width:55%;text-align:right">${ag.finding}</span></div>`).join('');
  const dims = Object.entries(a.risk).map(([k, v]) => `<div class="kv"><span style="text-transform:capitalize">${k} risk</span><span><span class="rel-bar" style="display:inline-block;width:90px;vertical-align:middle"><i style="width:${v}%;background:${v >= 60 ? '#ff6b6b' : v >= 35 ? 'var(--gold)' : 'var(--green)'}"></i></span> ${v}</span></div>`).join('');
  const cond = a.conditions.length ? `<div style="margin-top:8px"><span class="eyebrow">Conditions</span>${a.conditions.map((c) => `<div class="ok-line"><span class="ck">✓</span>${c}</div>`).join('')}</div>` : '';
  $('#visaDecision').innerHTML = `
    <div class="card pad" style="border-color:${decColor}">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <div><span class="eyebrow">Decision · ${a.slaMinutes === 'escalated' ? 'escalated' : 'in ' + a.slaMinutes + ' min'}</span>
          <div style="font-family:'Space Grotesk';font-weight:700;font-size:26px;color:${decColor}">${a.decision}</div>
          <div class="muted" style="font-size:13px">${a.applicant.name} · ${a.applicant.nationality} → ${a.applicant.destination} · ${a.applicant.purpose}</div></div>
        <div style="text-align:right"><div class="t-label">Unified risk (0–1000)</div>
          <div style="font-family:'Space Grotesk';font-weight:700;font-size:32px;color:${decColor}">${a.totalScore}</div>
          <div class="muted" style="font-size:12px">${a.band} · ${a.confidence}% confidence</div></div>
      </div>
      ${cond}
    </div>
    <div class="console-grid" style="margin-top:16px">
      <div class="card pad"><span class="eyebrow">Agent swarm findings</span>${agentRows}</div>
      <div class="card pad"><span class="eyebrow">Risk scoring engine</span>${dims}
        <p class="muted" style="font-size:11px;margin-top:10px">Zero-trust · biometric liveness · device fingerprint · metadata analysis · immutable blockchain audit trail. Anti-corruption: every human override requires reason + approval chain + audit log.</p></div>
    </div>`;
}

async function renderVisaGov() {
  const out = $('#visaosOut');
  let data;
  try { data = await api('/api/visaos/government'); } catch { return; }
  const g = data.analytics;
  const kpis = [
    ['Applications', g.applications], ['Approval rate', g.approvalRate + '%'],
    ['Fraud attempts', g.fraudAttempts], ['Fully digital', g.autoDigitalRate + '%'], ['Avg risk', g.avgScore],
  ].map(([k, v]) => `<div class="card pad kpi"><div class="kpi-v">${v}</div><div class="kpi-k">${k}</div></div>`).join('');
  const decisions = Object.entries(g.decisions || {}).map(([k, v]) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`).join('') || '<div class="muted" style="font-size:13px">No applications yet — run one in the Applicant tab.</div>';
  const countries = (g.topCountries || []).map((c) => `<div class="kv"><span>${c.country}</span><span>${c.count}</span></div>`).join('') || '<div class="muted" style="font-size:13px">—</div>';
  const recent = (g.recent || []).map((r) => `<div class="ln"><span class="ok">●</span> ${r.nationality}→${r.destination} · <strong>${r.decision}</strong> <span class="muted">(${r.score})</span></div>`).join('') || '<div class="muted" style="font-size:13px">—</div>';
  out.innerHTML = `
    <div class="kpi-grid">${kpis}</div>
    <div class="console-grid" style="margin-top:20px">
      <div><div class="card pad"><span class="eyebrow">Decisions</span>${decisions}</div>
        <div class="card pad" style="margin-top:16px"><span class="eyebrow">Top applicant countries</span>${countries}</div></div>
      <div class="card pad scanlog"><span class="eyebrow">Recent decisions</span><div style="margin-top:8px">${recent}</div>
        <p class="muted" style="font-size:11px;margin-top:10px">Revenue: SaaS license · per-application fee · AI processing fee · biometric fee · fraud-intelligence subscription · Border Intelligence API.</p></div>
    </div>`;
}

// ---- Business / Enterprise Command Centre ---------------------------------
async function renderBusiness() {
  const out = $('#businessOut');
  if (!canAccessView('business')) { accessGate(out, 'Business', 'business or admin'); return; }
  let data, contractData;
  try { data = await api('/api/business/approvals'); contractData = await api('/api/business/contracts'); } catch { accessGate(out, 'Business', 'business or admin'); return; }
  const bookings = data.bookings || [];
  const approvals = data.approvals || [];
  const contracts = contractData.contracts || [];

  const spendUSD = bookings.reduce((s, b) => s + (b.totalUSD || 0), 0);
  const destinations = [...new Set(bookings.map((b) => b.destination).filter((d) => d && d !== '—'))];

  const kpis = [
    ['Team trips', bookings.length],
    ['Total spend', '$' + Math.round(spendUSD).toLocaleString()],
    ['Pending approvals', approvals.filter((a) => a.status === 'pending').length],
    ['Destinations', destinations.length || '—'],
  ].map(([k, v]) => `<div class="card pad kpi"><div class="kpi-v">${v}</div><div class="kpi-k">${k}</div></div>`).join('');

  const apprRows = approvals.length ? approvals.map((a) => `
    <div class="kv"><span>${a.bookingId} <span class="muted">$${Math.round(a.amountUSD).toLocaleString()}</span></span>
    <span>${a.status === 'pending'
      ? `<a onclick="decideApproval('${a.id}','approve')" style="color:var(--green);cursor:pointer">approve</a> · <a onclick="decideApproval('${a.id}','reject')" style="color:#ff8a8a;cursor:pointer">reject</a>`
      : `<span class="muted">${a.status}</span>`}</span></div>`).join('')
    : '<div class="muted" style="font-size:13px">No approvals pending. High-value bookings (≥ $4,000) appear here automatically.</div>';

  const teamRows = bookings.length ? bookings.map((b) => `
    <div class="kv"><span>${b.tier} · ${b.destination}</span><span>${b.currency || ''} ${Math.round(b.totalLocal || 0).toLocaleString()} · <span class="muted">${b.status}</span></span></div>`).join('')
    : '<div class="muted" style="font-size:13px">No team trips yet.</div>';

  const duty = destinations.length ? destinations.map((d) => `<span class="chip">📍 ${d} · risk 92 low</span>`).join('') : '<span class="muted" style="font-size:13px">No active travellers.</span>';

  out.innerHTML = `
    <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr)">${kpis}</div>
    <div class="console-grid" style="margin-top:20px">
      <div>
        <div class="card pad"><span class="eyebrow">Travel Policy</span>
          <div class="kv"><span>Max trip value (auto-approve)</span><span>$4,000</span></div>
          <div class="kv"><span>Cabin (long-haul)</span><span>Economy / Premium</span></div>
          <div class="kv"><span>Preferred payment</span><span>BitriPay / Card</span></div>
          <div class="kv"><span>Cheapest compliant fare</span><span style="color:var(--green)">enforced</span></div>
        </div>
        <div class="card pad" style="margin-top:16px"><span class="eyebrow">Duty of Care · live</span><div class="chips" style="margin-top:10px">${duty}</div></div>
      </div>
      <div>
        <div class="card pad"><span class="eyebrow">Approval queue</span>${apprRows}</div>
        <div class="card pad" style="margin-top:16px"><span class="eyebrow">Team itinerary mesh</span>${teamRows}</div>
      </div>
    </div>
    <div class="card pad" style="margin-top:16px">
      <span class="eyebrow">Supplier Contract Manager · AI-negotiated volume deals</span>
      ${contracts.length ? contracts.map((c) => `<div class="kv"><span>${c.supplier} <span class="muted">${c.category}</span></span><span>$${(c.annualVolumeUSD).toLocaleString()}/yr · <strong style="color:var(--green)">${(c.discountPct * 100).toFixed(1)}%</strong> · ${c.status}</span></div>`).join('') : '<div class="muted" style="font-size:13px">No contracts yet. The Supplier Negotiation Agent scales the discount with committed volume.</div>'}
      <div class="composer-row" style="margin-top:12px">
        <div class="field"><label>Supplier</label><input class="in" id="ctrSupplier" placeholder="e.g. Emirates" style="width:150px"></div>
        <div class="field"><label>Category</label><select class="in" id="ctrCat"><option value="hotel">hotel</option><option value="flights">flights</option><option value="carhire">car hire</option><option value="transfer">transfer</option></select></div>
        <div class="field"><label>Annual volume (USD)</label><input class="in" id="ctrVol" value="500000" style="width:130px"></div>
        <div style="flex:1"></div>
        <button class="btn btn-gold btn-sm" onclick="createContract()">🤝 Negotiate</button>
      </div>
    </div>`;
}
window.createContract = async () => {
  const supplier = $('#ctrSupplier').value.trim();
  if (!supplier) { toast('Enter a supplier.'); return; }
  try { await api('/api/business/contracts', { method: 'POST', body: JSON.stringify({ supplier, category: $('#ctrCat').value, annualVolumeUSD: Number($('#ctrVol').value) }) }); } catch { return; }
  toast('✓ Contract negotiated.'); renderBusiness();
};
window.decideApproval = async (id, decision) => {
  try { await api(`/api/business/approvals/${id}`, { method: 'POST', body: JSON.stringify({ decision }) }); } catch { return; }
  toast(`✓ ${decision === 'approve' ? 'Approved' : 'Rejected'}.`);
  renderBusiness();
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

// Show/hide role-restricted nav links (Admin, Business) based on the signed-in
// user's role. Privileged areas are NOT shown to the public — the backend also
// enforces this, so hiding the link is purely UX.
function applyRoleVisibility() {
  const u = state.user;
  $$('.role-link').forEach((el) => {
    const roles = (el.dataset.roles || '').split(',').map((r) => r.trim()).filter(Boolean);
    const allowed = !!u && (u.allAccess || roles.includes(u.role));
    el.classList.toggle('hidden', !allowed);
  });
}

function setUser(u) {
  state.user = u;
  const chip = $('#userChip');
  chip.classList.remove('hidden');
  chip.innerHTML = `${avatarHTML(u, 22)} ${u.name} · ${u.tier} · ${u.points.toLocaleString()} pts`;
  try { localStorage.setItem('3jn_uid', u.id); } catch {}
  const signBtn = $('#signBtn'); if (signBtn) signBtn.textContent = 'Sign out';
  applyRoleVisibility();
  refreshNotifications();
}
async function restoreSession() {
  let uid; try { uid = localStorage.getItem('3jn_uid'); } catch {}
  if (!uid) return;
  try { const d = await api(`/api/account/${uid}`); if (d.user) setUser(d.user); } catch {}
}
window.signOut = () => {
  try { localStorage.removeItem('3jn_uid'); } catch {}
  if (window.firebaseAuth?.available) { try { window.firebaseAuth.signOut(); } catch {} }
  state.user = null; $('#userChip').classList.add('hidden'); $('#signBtn').textContent = 'Sign in';
  applyRoleVisibility();
  if (state.lastView === 'admin' || state.lastView === 'business') nav('home');
  toast('Signed out.');
};

// ---- Login / Signup -------------------------------------------------------
$('#signBtn')?.addEventListener('click', () => { if (state.user) return window.signOut(); openAuth(); });

// Bridge a Firebase identity to a backend account (get-or-create by email).
let firebaseBridging = false;
window.addEventListener('firebase-auth', async (e) => {
  if (firebaseBridging) return;
  firebaseBridging = true;
  try {
    const d = await api('/api/auth/firebase', { method: 'POST', body: JSON.stringify({ email: e.detail.email, name: e.detail.name }) });
    setUser(d.user); closeModal();
    toast(`✓ Signed in as ${d.user.name}`);
    if (e.detail && e.detail.emailVerified === false) {
      setTimeout(() => toast('📧 Please verify your email — check your inbox.'), 1600);
    }
    if (!$('#view-console').classList.contains('active')) nav('console');
  } catch {} finally { firebaseBridging = false; }
});
window.addEventListener('firebase-signout', () => { /* handled by signOut() */ });
window.googleSignIn = async () => {
  if (!window.firebaseAuth?.available) { toast('Google sign-in unavailable — use email.'); return; }
  try { await window.firebaseAuth.google(); } catch (err) { toast('Google sign-in cancelled.'); }
};
window.forgotPassword = async () => {
  const email = ($('#liEmail')?.value || '').trim();
  if (!email) { toast('Enter your email first, then tap “Forgot password?”.'); return; }
  try { await window.firebaseAuth.resetPassword(email); toast(`📧 Password reset link sent to ${email}.`); }
  catch (e) { toast(e.message || 'Could not send reset email.'); }
};

function openAuth() {
  const fb = window.firebaseAuth?.available;
  const googleBtn = fb ? '<button class="btn btn-ghost btn-block" style="margin-bottom:12px" onclick="googleSignIn()">🇬 Continue with Google</button><div class="muted center" style="font-size:11px;margin-bottom:8px">or with email</div>' : '';
  modal(`
    <span class="eyebrow">Welcome to 3JN Travel OS</span>
    ${googleBtn}
    <div class="chips" style="margin:10px 0">
      <span class="chip on" id="authTabSignup" onclick="authTab('signup')">Sign up</span>
      <span class="chip" id="authTabLogin" onclick="authTab('login')">Log in</span>
    </div>
    <div id="authSignup">
      <div class="field" style="margin-top:8px"><label>Name</label><input class="in" id="auName" placeholder="Your name"></div>
      <div class="field" style="margin-top:10px"><label>Email</label><input class="in" id="auEmail" placeholder="you@email.com"></div>
      ${fb ? '<div class="field" style="margin-top:10px"><label>Password</label><input class="in" type="password" id="auPass" placeholder="••••••••"></div>' : ''}
      <div class="field" style="margin-top:10px"><label>I am a…</label><select class="in" id="auRole"><option value="consumer">Traveller</option><option value="business">Business</option><option value="merchant">Merchant</option><option value="partner">Agency partner</option></select></div>
      <div class="field" style="margin-top:10px"><label>Referral code (optional)</label><input class="in" id="auRef" placeholder="3JN-XXXX"></div>
      <button class="btn btn-gold btn-block" style="margin-top:14px" onclick="doSignup()">Create account · 250 pts bonus</button>
    </div>
    <div id="authLogin" style="display:none">
      <div class="field" style="margin-top:8px"><label>Email</label><input class="in" id="liEmail" placeholder="you@email.com"></div>
      ${fb ? '<div class="field" style="margin-top:10px"><label>Password</label><input class="in" type="password" id="liPass" placeholder="••••••••"></div>' : ''}
      <button class="btn btn-gold btn-block" style="margin-top:14px" onclick="doLogin()">Log in</button>
      ${fb ? '<p class="muted center" style="font-size:12px;margin-top:10px"><a onclick="forgotPassword()" style="color:var(--gold);cursor:pointer">Forgot password?</a></p>' : '<p class="muted" style="font-size:12px;margin-top:10px">Try the seeded accounts: admin@3jntravel.com, business@3jntravel.com, merchant@3jntravel.com.</p>'}
    </div>`);
}
window.authTab = (t) => {
  $('#authTabSignup').classList.toggle('on', t === 'signup');
  $('#authTabLogin').classList.toggle('on', t === 'login');
  $('#authSignup').style.display = t === 'signup' ? 'block' : 'none';
  $('#authLogin').style.display = t === 'login' ? 'block' : 'none';
};
window.doSignup = async () => {
  const name = $('#auName').value.trim();
  const email = $('#auEmail').value.trim();
  if (!name) { toast('Enter your name.'); return; }
  // With Firebase available, create the credential there; the firebase-auth
  // event then bridges to a backend account. (Role/referral applied on bridge.)
  if (window.firebaseAuth?.available) {
    const pass = $('#auPass')?.value || '';
    if (pass.length < 6) { toast('Password must be 6+ characters.'); return; }
    try { await window.firebaseAuth.signUp(email, pass, name); } catch (e) { toast(e.message || 'Sign-up failed.'); }
    return;
  }
  const body = { name, email, role: $('#auRole').value, referredByCode: $('#auRef').value.trim() || undefined };
  let d; try { d = await api('/api/account', { method: 'POST', body: JSON.stringify(body) }); } catch { return; }
  setUser(d.user); closeModal(); toast(`✓ Welcome, ${d.user.name}!`); nav('console');
};
window.doLogin = async () => {
  const email = $('#liEmail').value.trim();
  if (!email) { toast('Enter your email.'); return; }
  if (window.firebaseAuth?.available) {
    const pass = $('#liPass')?.value || '';
    try { await window.firebaseAuth.signIn(email, pass); } catch (e) { toast(e.message || 'Login failed.'); }
    return;
  }
  let d; try { d = await api('/api/login', { method: 'POST', body: JSON.stringify({ email }) }); } catch { return; }
  setUser(d.user); closeModal(); toast(`✓ Welcome back, ${d.user.name}!`); nav('console');
};

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
      <p class="muted">Open areas: supplier integrations, pricing & optimisation, growth, and 24/7 traveller support. Email <strong>info@3jntravel.com</strong>.</p>`,
  },
  privacy: {
    title: '🔒 Privacy Policy',
    body: `<p class="muted">Your trust is the product. We collect only what's needed to plan, book and support your trip — destination, dates, travellers and payment details — and we never sell your personal data. Location/currency is detected to price you fairly. You can request export or deletion at any time via <strong>info@3jntravel.com</strong>.</p>
      <p class="muted" style="font-size:12px">Prototype notice: this demo stores data in memory only and clears on restart.</p>`,
  },
  terms: {
    title: '📜 Terms of Use',
    body: `<p class="muted">3JN Travel OS finds and packages travel from verified third-party suppliers and adds a transparent 10% service fee. Prices are guaranteed at the moment of quote and protected by our Price Guard. Deposits and instalments are interest-free; refunds and rebookings are processed where commercially and legally possible. Full terms at <strong>info@3jntravel.com</strong>.</p>
      <p class="muted" style="font-size:12px">Prototype notice: no real bookings or payments are taken in this demo.</p>`,
  },
  support: {
    title: '🛟 Support — 24/7, in your language',
    body: `<p class="muted">Real help, before, during and after your trip: flight-disruption assistance, document checklists, visa-deadline alerts, rebooking and refund guidance. Reach us any time.</p>
      <div class="kv"><span>Main contact</span><span><strong style="color:var(--gold)">info@3jntravel.com</strong></span></div>
      <div class="kv"><span>WhatsApp / Chat</span><span>+44 20 0000 0000</span></div>
      <div class="kv"><span>In-trip emergency line</span><span>24/7</span></div>`,
  },
  cookies: {
    title: '🍪 Cookie Policy',
    body: `<p class="muted">We use cookies and similar technologies to keep you signed in, remember your currency/language, measure performance, and improve recommendations.</p>
      <ul class="comp-list">
        <li><span class="cs">Essential</span><span class="cp">always on</span></li>
        <li><span class="cs">Preferences (currency, language)</span><span class="cp">on</span></li>
        <li><span class="cs">Analytics (anonymised)</span><span class="cp">optional</span></li>
        <li><span class="cs">Marketing</span><span class="cp">opt-in only</span></li>
      </ul>
      <p class="muted" style="font-size:12px">Manage preferences any time via <strong>info@3jntravel.com</strong>. Prototype: this demo sets no third-party cookies.</p>`,
  },
  disclaimer: {
    title: '⚠️ Disclaimer',
    body: `<p class="muted">3JN Travel OS is a travel technology platform that aggregates and packages inventory from independent third-party suppliers (airlines, hotels, hosts, tour operators, insurers, transfer and eSIM providers). 3JN is not the operator of those services; the supplier's own terms apply to each component.</p>
      <p class="muted">Prices, availability, visa rules and risk information are indicative and can change until booking is confirmed. AI-generated recommendations are decision-support, not professional travel, legal, financial or medical advice. Always verify visa and entry requirements with the relevant authority before travelling.</p>
      <p class="muted" style="font-size:12px">Prototype notice: figures and inventory in this demo are synthesised for illustration.</p>`,
  },
  refund: {
    title: '💷 Refund &amp; Cancellation Policy',
    body: `<p class="muted">Refunds and rebookings are processed where commercially and legally possible, subject to each supplier's fare/rate rules. Our Neural Price Guard automatically refunds the difference if a monitored price drops before you travel.</p>
      <ul class="comp-list">
        <li><span class="cs">Free-cancellation rates</span><span class="cp">full refund in window</span></li>
        <li><span class="cs">Instalment deposits</span><span class="cp">per plan terms</span></li>
        <li><span class="cs">Price-drop difference</span><span class="cp">auto-refunded</span></li>
      </ul>
      <p class="muted" style="font-size:12px">Requests: <strong>info@3jntravel.com</strong>. ATOL/ABTA financial protection applies to eligible UK package bookings.</p>`,
  },
  acceptable: {
    title: '✅ Acceptable Use Policy',
    body: `<p class="muted">Use the platform and API lawfully: no fraud, scraping abuse, reselling without a partner agreement, circumventing the cost-protection/ACU system, or automated bulk searches outside your rate limit. We may rate-limit, restrict or suspend accounts that breach this policy (see the Search Abuse Detection logic in our architecture docs).</p>`,
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

// ---- Internationalisation (EN / FR / SW / LN / AR) ------------------------
const I18N = {
  en: { 'nav.home': 'Home', 'nav.plan': 'Plan a Trip', 'nav.how': 'How it Works', 'nav.membership': 'Membership', 'nav.api': 'API', 'nav.console': 'Console', 'nav.business': 'Business', 'nav.admin': 'Admin', 'hero.line1': 'Stop Searching.', 'hero.line2': 'Start Saving.', 'hero.lede': '3JN Travel OS finds, optimises, negotiates, books and manages your entire journey while continuously reducing travel costs through AI-powered travel intelligence.', 'hero.cta1': 'Get My Best Trip', 'hero.cta2': 'See How It Works', 'hero.whatsapp': '💬 Book on WhatsApp' },
  fr: { 'nav.home': 'Accueil', 'nav.plan': 'Planifier', 'nav.how': 'Comment ça marche', 'nav.membership': 'Abonnement', 'nav.api': 'API', 'nav.console': 'Console', 'nav.business': 'Entreprise', 'nav.admin': 'Admin', 'hero.line1': 'Arrêtez de chercher.', 'hero.line2': 'Commencez à économiser.', 'hero.lede': "3JN Travel OS trouve, optimise, négocie, réserve et gère tout votre voyage tout en réduisant continuellement les coûts grâce à l'intelligence artificielle.", 'hero.cta1': 'Mon meilleur voyage', 'hero.cta2': 'Comment ça marche', 'hero.whatsapp': '💬 Réserver sur WhatsApp' },
  sw: { 'nav.home': 'Nyumbani', 'nav.plan': 'Panga Safari', 'nav.how': 'Jinsi Inavyofanya', 'nav.membership': 'Uanachama', 'nav.api': 'API', 'nav.console': 'Konsoli', 'nav.business': 'Biashara', 'nav.admin': 'Msimamizi', 'hero.line1': 'Acha Kutafuta.', 'hero.line2': 'Anza Kuokoa.', 'hero.lede': '3JN Travel OS hupata, huboresha, hujadiliana, huweka nafasi na kusimamia safari yako yote huku ikipunguza gharama kwa akili bandia.', 'hero.cta1': 'Pata Safari Bora', 'hero.cta2': 'Jinsi Inavyofanya', 'hero.whatsapp': '💬 Weka kwa WhatsApp' },
  ln: { 'nav.home': 'Ndako', 'nav.plan': 'Bongisa Mobembo', 'nav.how': 'Ndenge Esalaka', 'nav.membership': 'Bosangani', 'nav.api': 'API', 'nav.console': 'Console', 'nav.business': 'Mombongo', 'nav.admin': 'Admin', 'hero.line1': 'Tika Koluka.', 'hero.line2': 'Banda Kobomba.', 'hero.lede': '3JN Travel OS ekolukaka, ekobongisaka, ekosololaka, ekosalaka mpe ekobatelaka mobembo na yo mobimba na kokitisáká motúya na nzelá ya mayele ya masini.', 'hero.cta1': 'Zwá Mobembo Malamu', 'hero.cta2': 'Ndenge Esalaka', 'hero.whatsapp': '💬 Réserver na WhatsApp' },
  ar: { 'nav.home': 'الرئيسية', 'nav.plan': 'خطط رحلة', 'nav.how': 'كيف يعمل', 'nav.membership': 'العضوية', 'nav.api': 'API', 'nav.console': 'لوحة التحكم', 'nav.business': 'الأعمال', 'nav.admin': 'المشرف', 'hero.line1': 'توقف عن البحث.', 'hero.line2': 'ابدأ التوفير.', 'hero.lede': 'يبحث 3JN Travel OS ويحسّن ويتفاوض ويحجز ويدير رحلتك بالكامل مع خفض التكاليف باستمرار عبر الذكاء الاصطناعي.', 'hero.cta1': 'احصل على أفضل رحلة', 'hero.cta2': 'كيف يعمل', 'hero.whatsapp': '💬 احجز عبر واتساب' },
};
function applyLanguage(lang) {
  const dict = I18N[lang] || I18N.en;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const k = el.dataset.i18n;
    if (dict[k]) el.textContent = dict[k];
  });
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  state.lang = lang;
}

// ---- Behavioural learning + personalised Journey Dashboard ----------------
// Fire-and-forget telemetry so the ML agents learn from real activity.
function trackEvent(event, destination, payload) {
  try {
    api('/api/track', { method: 'POST', body: JSON.stringify({ event, destination, payload }) })
      .then(() => { if (event !== 'dwell') refreshJourney(); })
      .catch(() => {});
  } catch { /* never block the UI */ }
}
window.trackEvent = trackEvent;
window.trackView = (code, city) => trackEvent('view_destination', code, { city });

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function refreshJourney() {
  const rowsEl = $('#journeyRows');
  if (!rowsEl) return;
  let d;
  try { d = await api(`/api/journey?country=${state.country || 'GB'}`); } catch { return; }
  rowsEl.innerHTML = (d.rows || []).map((r) => `
    <div class="holo-row"><span><span class="ico">${esc(r.icon)}</span>${esc(r.label)}</span>
      <span class="v ${r.kind === 'good' ? 'good' : 'blue'}">${esc(r.value)}</span></div>`).join('');
  const dest = $('#journeyDest');
  if (dest) dest.textContent = d.destination ? `· ${d.destination.emoji} ${d.destination.city}` : '';
  const learned = $('#journeyLearned');
  if (learned) learned.textContent = d.learnedFrom || '';
  const save = $('#journeySave');
  if (save && d.savings) save.textContent = `You Save ${d.savings.display}`;
  const agentsEl = $('#journeyAgents');
  if (agentsEl) {
    agentsEl.innerHTML = (d.agents || []).map((a) => `
      <span class="learn-chip" title="${esc(a.track)}"><b>${esc(a.agent)}</b> <span class="ld">${esc(a.learned)}</span></span>`).join('');
  }
}
window.refreshJourney = refreshJourney;

// ---- Notifications engine -------------------------------------------------
async function refreshNotifications() {
  let data;
  try { data = await api('/api/notifications'); } catch { return; }
  ['#notifBadge', '#notifBadgeMobile'].forEach((sel) => {
    const badge = $(sel);
    if (!badge) return;
    if (data.unread > 0) { badge.textContent = data.unread; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  });
  window.__notifs = data.notifications || [];
}
async function openNotifications() {
  const items = window.__notifs || [];
  const rows = items.length ? items.map((n) => `
    <div class="notif ${n.read ? '' : 'unread'}"><span class="notif-ico">${n.icon}</span>
      <div><strong>${n.title}</strong><div class="muted" style="font-size:12.5px">${n.body}</div></div></div>`).join('')
    : '<div class="muted" style="font-size:13px">No notifications yet. Book a trip or run the Price Guard to see updates here.</div>';
  modal(`<span class="eyebrow">Notifications</span><h3 style="margin:6px 0 10px">Your alerts</h3>${rows}`);
  try { await api('/api/notifications/read', { method: 'POST', body: '{}' }); } catch {}
  refreshNotifications();
}
$('#notifBtn')?.addEventListener('click', openNotifications);
$('#notifBtnMobile')?.addEventListener('click', () => { closeMobileNav(); openNotifications(); });

// ---- Contact form ---------------------------------------------------------
$('#contactLink')?.addEventListener('click', () => {
  modal(`
    <span class="eyebrow">Contact 3JN Travel OS</span>
    <h3 style="margin:6px 0">We'd love to hear from you</h3>
    <p class="muted" style="font-size:13px">Goes straight to <strong>info@3jntravel.com</strong>. We reply 24/7.</p>
    <div class="field" style="margin-top:10px"><label>Your name</label><input class="in" id="ctName"></div>
    <div class="field" style="margin-top:10px"><label>Your email</label><input class="in" id="ctEmail" placeholder="you@email.com"></div>
    <div class="field" style="margin-top:10px"><label>Message</label><textarea class="in" id="ctMsg" style="width:100%;min-height:90px"></textarea></div>
    <button class="btn btn-gold btn-block" style="margin-top:14px" onclick="sendContact()">Send message</button>`);
});
window.sendContact = async () => {
  const email = $('#ctEmail').value.trim();
  const message = $('#ctMsg').value.trim();
  if (!email || !message) { toast('Enter your email and a message.'); return; }
  let d; try { d = await api('/api/contact', { method: 'POST', body: JSON.stringify({ name: $('#ctName').value.trim(), email, message }) }); } catch { return; }
  closeModal();
  toast(d.sent ? '✓ Message sent to info@3jntravel.com.' : '✓ Message received — we’ll be in touch.');
};

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

// ---- PWA: service-worker registration -------------------------------------
// Registers the offline/installable shell. Network-first for app code keeps it
// from ever serving stale builds (see sw.js). Auto-applies updates on next load.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          // A new SW has taken control while an old one was running — refresh once.
          if (sw.state === 'activated' && navigator.serviceWorker.controller) {
            if (!window.__reloadedForSW) { window.__reloadedForSW = true; }
          }
        });
      });
    }).catch(() => { /* SW optional — app works without it */ });
  });
}

// ---- PWA: install prompt --------------------------------------------------
let __deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  __deferredPrompt = e;
  const btn = $('#installBtn');
  if (btn) btn.classList.remove('hidden');
});
window.promptInstall = async () => {
  if (!__deferredPrompt) { toast('Use your browser menu › "Add to Home Screen" to install.'); return; }
  __deferredPrompt.prompt();
  try { await __deferredPrompt.userChoice; } catch {}
  __deferredPrompt = null;
  const btn = $('#installBtn');
  if (btn) btn.classList.add('hidden');
};
window.addEventListener('appinstalled', () => {
  __deferredPrompt = null;
  const btn = $('#installBtn');
  if (btn) btn.classList.add('hidden');
  toast('✓ 3JN Travel OS installed. Launch it from your home screen.');
});
