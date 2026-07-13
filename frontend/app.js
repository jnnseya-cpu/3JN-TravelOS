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
  if (state.staffPin) headers['x-staff-pin'] = state.staffPin; // staff second factor
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
    // Cold-start grace: the server is still loading its store. Don't bother the
    // user — wait a beat and retry transparently a few times before surfacing.
    if (res.status === 503 && data.error === 'starting-up' && (opts._startRetry || 0) < 4) {
      await new Promise((r) => setTimeout(r, 900));
      return api(path, { ...opts, _startRetry: (opts._startRetry || 0) + 1 });
    }
    let m = data.message || data.error || `HTTP ${res.status}`;
    if (m === 'auth-required') m = 'Sign in first — this area is tied to your account. Use Sign in (or Full Access to explore).';
    // Callers can opt out of the toast for expected failures (e.g. a stale
    // session 404) by passing { silent: true }.
    if (!opts.silent) toast(`⚠ ${m}`);
    const err = new Error(m); err.status = res.status; throw err;
  }
  return data;
}

// British date format: 2026-09-02 → 02/09/2026 (dd/mm/yyyy). Non-ISO input is
// returned unchanged so we never mangle an already-formatted label.
function ukDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || '');
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
const VIEW_ROLES = { admin: ['admin'], business: ['business', 'admin'], comms: ['admin'] };
function canAccessView(view) {
  const roles = VIEW_ROLES[view];
  if (!roles) return true;
  const u = state.user;
  return !!u && (u.allAccess || roles.includes(u.role));
}

// Set + PERSIST the staff PIN so it's sent on every request and survives reloads
// / serverless instance changes (the stateless second factor for owner admin).
function setStaffPin(pin) {
  state.staffPin = pin;
  try { if (pin) localStorage.setItem('3jn_pin', pin); else localStorage.removeItem('3jn_pin'); } catch {}
}
// Is the current session a STAFF member (keeps full access to the estimator
// planner + marketplace even in commercial mode)?
function isStaff() {
  const u = state.user;
  return !!(state.staffPin || (u && (u.allAccess || ['admin', 'business', 'merchant', 'partner', 'embassy', 'consulate'].includes(u.role))));
}
// Commercial storefront: when LIVE_MODE is on, CUSTOMERS get the curated Deals
// catalogue as the storefront — the AI estimator planner + destination
// marketplace are hidden and any button that pointed at them routes to Deals,
// so no fabricated trip is ever shown. Staff are unaffected.
function dealsOnly() { return !!state.liveMode && !isStaff(); }
function applyStorefrontMode() {
  const on = dealsOnly();
  document.body.dataset.storefront = on ? 'deals' : 'full';
  document.querySelectorAll('[data-nav="planner"],[data-nav="marketplace"]').forEach((el) => {
    const inNav = el.closest('.nav-links');
    if (on) {
      if (inNav) { el.style.display = 'none'; return; }
      if (!el.dataset.origNav) el.dataset.origNav = el.dataset.nav;
      el.dataset.nav = 'deals';
      if (el.classList.contains('btn-gold')) el.textContent = 'Browse Deals';
    } else {
      if (inNav) el.style.display = '';
      if (el.dataset.origNav) el.dataset.nav = el.dataset.origNav;
    }
  });
}

function nav(view) {
  // Commercial mode: customers never reach the estimator — send them to Deals.
  if (dealsOnly() && (view === 'planner' || view === 'marketplace')) view = 'deals';
  // Block privileged views for the PUBLIC (not signed in). A signed-in user whose
  // role check doesn't pass yet is NOT bounced home — the view's own guard refreshes
  // the account and either renders or shows an in-page unlock, so serverless instance
  // lag never kicks a real admin back to the homepage.
  if (!canAccessView(view) && !state.user) {
    const roles = (VIEW_ROLES[view] || ['staff']).join(' or ');
    toast(`The ${view} area requires a ${roles} account. Please sign in.`);
    openAuth();
    view = 'home';
  }
  state.lastView = view;
  $$('.view').forEach((v) => v.classList.remove('active'));
  const el = $(`#view-${view}`);
  if (el) el.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (view === 'deals') renderDeals();
  if (view === 'console') renderConsole();
  if (view === 'admin') renderAdmin();
  if (view === 'comms') renderComms();
  if (view === 'business') renderBusiness();
  if (view === 'visaos') renderVisaOS();
  if (view === 'marketplace') renderMarketplace();
  if (view === 'blog') renderBlog();
  if (view === 'rewards') renderRewards();
  if (view === 'vendors') renderVendors();
  if (view === 'hosting') renderHosting();
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
window.addEventListener('resize', () => { if (window.innerWidth > 1240) closeMobileNav(); });

// ---- Static content (agents, tiers, steps, loyalty) -----------------------
const AGENTS = [
  ['✈', 'Journey Intelligence', 'Scans flights, trains, coaches, ferries & cruises for the cheapest reliable route.'],
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
  { key: 'nomad', save: '£420/yr', name: 'Travel+ Smart Traveller', price: '£4.99', priceNum: 4.99, feature: false,
    benefits: ['AI Negotiation Engine', 'Priority Savings Alerts', '0% instalment processing fees', 'Digital Visa Assistance'] },
  { key: 'family', save: '£1,100/yr', name: 'Travel+ Family Saver', price: '£12.99', priceNum: 12.99, feature: true, badge: 'Most popular for families',
    benefits: ['All Smart Traveller Features', 'Child Safety Intelligence', 'Family Lounge Access', 'Sync-Mesh Itinerary'] },
  { key: 'executive', save: '£2,400/yr', name: 'Travel+ Frequent Flyer', price: '£24.99', priceNum: 24.99, feature: false,
    benefits: ['All Family Saver Features', 'Fast-Track Security', 'Coworking Intelligence', 'Expense Integration'] },
  { key: 'elite', save: '£5,000/yr+', name: 'Travel+ Concierge Elite', price: '£49.99', priceNum: 49.99, feature: false,
    benefits: ['All Frequent Flyer Features', 'Private Aviation Access', 'Guaranteed Upgrades', '24/7 Risk Mitigation'] },
];
// 10% of each subscription auto-funds ACUs at £1 = 100 ACU.
const ACU_PER_GBP = 100;
const acuAllocation = (priceNum) => Math.round(priceNum * 0.10 * ACU_PER_GBP);

const STEPS = [
  ['01', 'AI CORE', 'Neural Intent Extraction', 'Our proprietary AI agents analyse your natural language requests to identify over 40 distinct travel parameters including destination intent, preferred budget tiers, and service requirements.'],
  ['02', 'INVENTORY', 'Global Wholesaler Negotiation', "3JN connects directly to the world's largest travel wholesalers and GDS networks, bypassing retail markups to identify the 'Global Minimum Price' for your specific itinerary."],
  ['03', 'SECURITY', 'Integrity Verification Shield', "Every flight and hotel option is cross-referenced against a 50-point integrity check. We only surface 'Verified' suppliers that meet our strict reliability and quality standards."],
  ['04', 'REWARDS', 'Loyalty Discount Injection', 'The OS automatically checks your 3JN membership status (Explorer to Elite) and injects an additional member-only discount on top of the already reduced wholesale rate.'],
  ['05', 'LOGISTICS', 'Universal Console Sync', 'Once secured, your journey is instantly synchronised with your Universal Console, centralising your visas, transfers, and eSIMs into one high-tech management interface.'],
  ['06', 'CONTINUOUS', 'Neural Price Guard', 'Our agents monitor global inventory 24/7 post-booking. If the price for your specific flight or hotel drops before you travel, we automatically rebook or refund you the difference.'],
];

const LOYALTY = [
  ['Explorer', '0 pts', '0% discount'],
  ['Voyager', '1,000 pts', '3% discount'],
  ['Nomad', '5,000 pts', '6% discount'],
  ['Elite', '15,000 pts', '8% discount + priority verification'],
];

// Pricing model: pay-as-you-go is the headline (search costs 5-20 ACU; no
// subscription), and membership is a cheap ONE-OFF ANNUAL fee (2× the old
// monthly) that unlocks the perks and returns 10% as ACU. Monthly is gone.
let membershipBilling = 'yearly';
function payAsYouGoHTML() {
  return `<div class="card pad" style="grid-column:1/-1;margin-bottom:14px;border-color:rgba(216,180,106,0.4)">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
      <div>
        <strong style="font-size:16px">No subscription needed — pay only for what you use</strong>
        <p class="muted" style="font-size:12.5px;margin:4px 0 0">Browse free (cached results, 5/day). A live AI search costs just <strong>5–20 ACU (~5–20p)</strong> — top up ACU and spend only when the AI actually works for you. New accounts start with 50 ACU free.</p>
      </div>
      <button class="btn btn-gold" onclick="buyAcuFlow()">⚡ Top up ACU</button>
    </div>
  </div>
  <div style="grid-column:1/-1;text-align:center;margin:4px 0 12px"><span class="muted" style="font-size:12.5px">Travel often? A one-off yearly membership unlocks fee-free flights, priority &amp; savings — and returns 10% as ACU:</span></div>`;
}
function tierCardsHTML() {
  return payAsYouGoHTML() + TIERS.map((t) => {
    const yearNum = Math.round(t.priceNum * 2 * 100) / 100;       // annual one-off = 2× old monthly
    const acu = Math.round(yearNum * 0.10 * 100);                  // 10% back as ACU (£1 = 100 ACU)
    return `<div class="card tier ${t.feature ? 'feature' : ''}">
      ${t.feature ? `<span class="badge-top">${t.badge}</span>` : ''}
      <div class="save-chip">Est. Savings ${t.save}</div>
      <h3>${t.name}</h3>
      <div class="price">£${yearNum.toLocaleString(undefined, { minimumFractionDigits: 2 })}<span> /year</span></div>
      <div class="muted" style="font-size:11.5px;margin:-4px 0 8px">one-off annual · no monthly charge</div>
      <div class="acu-fund">⚡ ${acu.toLocaleString()} ACU back on joining<br><span class="muted">10% of your fee · £1 = 100 ACU · plus member perks below</span></div>
      <ul>${t.benefits.map((b) => `<li>${b}</li>`).join('')}</ul>
      <button class="btn ${t.feature ? 'btn-gold' : 'btn-ghost'} btn-block" onclick="selectTier('${t.key}')">Join ${t.name.split(' ').pop()} · yearly</button>
    </div>`;
  }).join('');
}
function renderTierGrids() {
  const html = tierCardsHTML();
  if ($('#tierGrid')) $('#tierGrid').innerHTML = html;
  if ($('#tierGridFull')) $('#tierGridFull').innerHTML = html;
}
window.setBilling = (mode) => { membershipBilling = mode === 'yearly' ? 'yearly' : 'monthly'; renderTierGrids(); };

function renderStatic() {
  $('#agentGrid').innerHTML = AGENTS.map(([ico, name, desc]) => `
    <div class="card agent-card"><div class="ag-ico">${ico}</div><h4>${name}</h4><p>${desc}</p></div>`).join('');

  renderTierGrids();

  $('#stepsGrid').innerHTML = STEPS.map(([num, tag, title, desc]) => `
    <div class="card step"><span class="num">${num}</span><span class="tag">${tag}</span><h3>${title}</h3><p>${desc}</p></div>`).join('');

  $('#loyaltyGrid').innerHTML = LOYALTY.map(([name, pts, disc]) => `
    <div class="card agent-card"><div class="ag-ico" style="background:rgba(216,180,106,0.15)">★</div><h4>${name}</h4><p>${pts} · ${disc}</p></div>`).join('');
}
window.selectTier = async (key) => {
  if (!state.user) {
    toast('Sign in to join a membership plan.');
    openAuth();
    return;
  }
  let data;
  try { data = await api('/api/membership/subscribe', { method: 'POST', body: JSON.stringify({ tier: key, billing: membershipBilling }) }); }
  catch { return; }
  // Live mode: a paid plan opens Stripe Checkout; the webhook activates it.
  if (data.checkout) { toast('💳 Opening secure checkout…'); window.location.href = data.checkout; return; }
  if (data.user) setUser(data.user);
  toast(`✓ ${data.user?.membership?.name} active — ${(data.acuCredited || 0).toLocaleString()} ACU funded. Renews ${membershipBilling === 'yearly' ? 'yearly' : 'monthly'}.`);
};

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
    state.liveMode = !!state.context.liveMode;   // commercial storefront switch
    state.stripeReady = !!state.context.stripeReady;
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
  // Restore the staff PIN so an unlocked owner/staff stays admin across reloads
  // and serverless instances (the PIN is the stateless second factor sent on
  // every request). Without this, admin access "randomly" dropped after a reload.
  try { const sp = localStorage.getItem('3jn_pin'); if (sp) state.staffPin = sp; } catch {}
  refreshNotifications();
  await restoreSession();
  applyRoleVisibility();
  applyStorefrontMode();
  applyDeepLink();
  refreshJourney();
  // Live AI cost-efficiency badge (guaranteed ≥66% saving).
  (async () => {
    try {
      const s = await api('/api/ai/status');
      const co = s.gateway?.costOptimization;
      const badge = $('#aiSaveBadge');
      if (co && badge) badge.innerHTML = `<span class="dot"></span> AI runs at ${co.savingPct}% lower cost (floor ${co.floorPct}%) — routing + cache + local fallback`;
    } catch { /* keep static text */ }
  })();
  populateShowcase();
}

// Populate every landing-page headline figure from the REAL engine — a real
// sample trip + real platform metrics. Nothing on the page is hard-coded.
async function populateShowcase() {
  let s;
  try { s = (await api(`/api/showcase?country=${state.country || 'GB'}`)).showcase; } catch { return; }
  const set = (id, v) => { const el = $(id); if (el && v != null) el.textContent = v; };
  const m = s.metrics || {};
  // Hero + final-CTA stats (real cumulative savings + real coverage + agent count).
  const savedTxt = m.savedForTravellersLocal > 0 ? m.savedForTravellersDisplay : (s.example ? s.example.savedDisplay + '/trip' : '£0');
  set('#statSaved', savedTxt); set('#ctaSaved', savedTxt);
  set('#statCountries', (m.countriesServed || 195) + '+'); set('#ctaCountries', (m.countriesServed || 195) + '+');
  set('#statAgents', '10'); set('#ctaAgents', '10');
  // Example trip (problem/solution + featured holiday).
  if (s.example) {
    set('#solutionSaved', `You Save ${s.example.savedDisplay}`);
    set('#featuredPrice', s.example.totalDisplay);
    set('#featuredSave', `Save ${s.example.savedDisplay} (${s.example.savingsPct}%) vs ${s.example.marketDisplay}`);
  }
  // Savings engine — real per-component breakdown + total.
  const se = $('#savingsEngine');
  if (se && s.savingsBreakdown?.length) {
    const rows = s.savingsBreakdown.map((b) => `<div class="kv"><span>${esc(b.label)}</span><span style="color:var(--green)">Saved ${esc(b.saved)}</span></div>`).join('');
    se.innerHTML = rows + `<div class="kv" style="border:none;padding-top:16px"><span style="font-family:'Space Grotesk';font-weight:700;font-size:18px">Total Trip Saving</span><span style="font-family:'Space Grotesk';font-weight:700;font-size:26px;color:var(--gold)">${s.example ? esc(s.example.savedDisplay) : '—'}</span></div>`;
  }
  // Negotiation engine — real outcomes from the actual package.
  const neg = $('#negotiationList');
  if (neg && s.negotiation?.length) {
    neg.innerHTML = s.negotiation.map((n) => `<div class="holo-row"><span>${esc(n.item)}</span><span class="v ${n.status === 'Applied' ? 'blue' : 'good'}">${esc(n.status)}</span></div>`).join('');
  }
}
// Open the right view from the URL — supports PWA shortcuts (/?view=planner)
// and direct/shared paths (/console, /visaos, /how-it-works, …).
function applyDeepLink() {
  const views = new Set(['home', 'planner', 'how', 'marketplace', 'blog', 'visaos', 'membership', 'rewards', 'vendors', 'hosting', 'api', 'console', 'business', 'admin']);
  const pathMap = { '': 'home', 'app': 'home', 'how-it-works': 'how', 'api-portal': 'api', 'destinations': 'marketplace', 'marketplace': 'marketplace' };
  let target = '';
  // Meta Pixel: Stripe success returns to /console?paid=1&booking=... —
  // that IS the purchase moment. Guarded per booking id so refreshes never
  // double-count a conversion.
  const payQ = new URLSearchParams(location.search);
  if (payQ.get('paid') === '1' && payQ.get('booking')) {
    const pk = 'fbq_purchase_' + payQ.get('booking');
    if (!localStorage.getItem(pk)) {
      localStorage.setItem(pk, '1');
      metaTrack('Purchase', { value: Number(payQ.get('amt')) || 0, currency: 'GBP', content_ids: [payQ.get('booking')], content_type: 'product' });
    }
  }
  const qv = new URLSearchParams(location.search).get('view');
  if (qv && views.has(qv)) target = qv;
  else {
    const seg = location.pathname.replace(/^\/+|\/+$/g, '').split('/')[0];
    target = pathMap[seg] !== undefined ? pathMap[seg] : (views.has(seg) ? seg : '');
  }
  // A shared post link (/blog/<slug>) opens THAT post, not the whole list.
  const blogSlug = location.pathname.match(/^\/blog\/([^/]+)\/?$/)?.[1];
  if (blogSlug) { nav('blog'); openPost(decodeURIComponent(blogSlug)); return; }
  if (target && target !== 'home') nav(target);
}
function syncCurrency(country) {
  const fc = $('#footerCurrency');
  if (fc) fc.value = country;
}

// ---- Planner --------------------------------------------------------------
$('#planBtn').addEventListener('click', runPlan);

// Priority search: populate the paid scan tiers (in the visitor's currency) and
// let the traveller pay for a faster/dedicated scan. Standard stays free.
(async function initPriorityTiers() {
  const sel = $('#prioritySelect');
  if (!sel) return;
  let d;
  try { d = await api('/api/search/priority-tiers'); } catch { return; }
  const label = { standard: 'Standard', fast: 'Fast', urgent: 'Urgent', emergency: 'Emergency' };
  sel.innerHTML = (d.tiers || []).map((t) =>
    `<option value="${esc(t.level)}">${esc(label[t.level] || t.level)}${t.feeGBP ? ` — ${d.symbol}${t.feeLocal}` : ' (free)'}</option>`).join('');
  sel.addEventListener('change', async () => {
    const level = sel.value;
    if (level === 'standard') return;
    // Take the priority fee up front, then the traveller runs the faster scan.
    let r;
    try { r = await api('/api/search/priority-checkout', { method: 'POST', body: JSON.stringify({ level }) }); } catch { return; }
    if (r.url) { toast(`Priority ${level}: ${d.symbol}${r.feeGBP} — opening secure checkout…`); window.open(r.url, '_blank'); }
    else if (r.error === 'stripe-not-configured') toast(`Priority ${level} is £${r.feeGBP} — card checkout isn't live yet, so this runs as a standard scan for now.`);
    else if (r.feeGBP === 0) { /* standard */ }
  });
})();
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
  // Drafts are per-account (SEC-6). With no signed-in user there is nowhere
  // private to save — skip the call silently rather than nag an anon visitor.
  if (!state.user) { if (status) status.textContent = ''; return; }
  if (status) status.textContent = '✍ saving…';
  clearTimeout(autosaveT);
  autosaveT = setTimeout(async () => {
    try {
      const d = await api('/api/drafts/intent', { method: 'PUT', body: JSON.stringify({ payload: { text } }), silent: true });
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

// Deep Price Dive → one-tap "Apply & re-search": re-run the search live with the
// lever's dates/airport applied, so the customer sees a REAL bookable fare.
window.applyDiveLever = (i) => {
  const apply = (window.__diveApply || {})[i];
  if (!apply) return;
  const ov = {};
  if (apply.shiftDays) ov.shiftDays = apply.shiftDays;
  if (apply.airport) ov.originAirport = apply.airport;
  const label = apply.airport ? `flying from ${apply.airport}` : `departing ${apply.shiftDays > 0 ? '+' : ''}${apply.shiftDays} day(s)`;
  toast(`🔎 Re-searching live — ${label}…`);
  runPlan(ov);
};

async function runPlan(overrides = {}) {
  const { approveAcu, ...restOverrides } = overrides;
  let text = $('#intentInput').value.trim();
  // "Inspire me" works from a blank slate — the proposer just returns a
  // seasonal spread when there are no words to match.
  if (!text && restOverrides.inspire) text = 'somewhere nice';
  if (!text) { toast('Describe your trip first — or tap ✨ Inspire me.'); return; }
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
        approveAcu: approveAcu === true,
        overrides: restOverrides,
        preferences: {
          directOnly: !!$('#directOnly')?.checked,
          departureWindow: $('#departWindow')?.value || null,
        },
      }),
    });
  } catch { out.innerHTML = ''; return; }

  state.lastPlan = data;
  // Meta Pixel: a completed search with results is a Search event.
  if (data.stage === 'options') metaTrack('Search', { search_string: text.slice(0, 100), content_category: data.intent?.destination?.city || '' });
  if (data.appliedDiveLever) {
    const al = data.appliedDiveLever;
    const bits = [];
    if (al.shiftDays) bits.push(`dates shifted ${al.shiftDays > 0 ? '+' : ''}${al.shiftDays} day(s)`);
    if (al.airport) bits.push(`departing ${al.airport}`);
    setTimeout(() => toast(`✓ Live fare for your saving option — ${bits.join(' · ')}. This price is real & bookable.`), 700);
  }
  // The search just taught the behaviour model something — rebuild the dashboard.
  refreshJourney();

  if (data.stage === 'acu-approval-required') {
    const approve = confirm(`⚡ ${data.why}\n\nApprove ${data.acuNeeded} ACU? (balance: ${data.balance})`);
    if (approve) { runPlan({ approveAcu: true }); }
    else toast('Search cancelled — no ACU charged. Cached results remain free.');
    return;
  }
  if (data.stage === 'topup-required') { renderTopup(data); return; }
  if (data.stage === 'concierge-requires-commitment') { renderConciergeCommitment(data); return; }
  if (data.stage === 'inspiration') { renderInspiration(data); return; }
  if (data.stage === 'clarify') { renderClarify(data); return; }
  // A paid tier was funded by ACUs — reflect the new balance.
  if (typeof data.acuBalance === 'number' && state.user) {
    setUser({ ...state.user, acuBalance: data.acuBalance });
  }
  renderOptions(data);
}

// Hard block when an account has run out of ACUs — prompt a top-up (or a free
// cached search), never silently proceed.
function renderTopup(data) {
  const out = $('#plannerOut');
  out.innerHTML = `<div class="card pad center" style="max-width:560px;margin:0 auto;border-color:rgba(216,180,106,0.4)">
    <div style="font-size:34px">⚡</div>
    <h3 style="margin:10px 0 6px">You're out of ACUs</h3>
    <p class="muted" style="font-size:14px">${data.message || `${data.tierName} needs ${data.acuNeeded} ACU.`}</p>
    <div class="kv" style="max-width:280px;margin:10px auto"><span>Balance</span><span>${(data.balance || 0).toLocaleString()} ACU</span></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:8px">
      <button class="btn btn-gold" onclick="buyAcuFlow()">Top up ACUs</button>
      ${data.isMember ? '<button class="btn btn-ghost" onclick="renewMembership()">Renew plan (+ACU)</button>' : '<button class="btn btn-ghost" data-nav="membership">Join a plan (10% funds ACU)</button>'}
      <button class="btn btn-ghost" onclick="runFreeSearch()">Run free cached search</button>
    </div>
    <p class="muted" style="font-size:12px;margin-top:12px">£1 = 100 ACU. Members auto-fund ACUs from 10% of their subscription each month.</p>
  </div>`;
}
window.runFreeSearch = () => { const sel = $('#tierSelect'); if (sel) sel.value = 'free'; runPlan(); };

// Tier 4 Concierge pairs AI agents with a human travel expert — it needs a
// commitment first: a refundable £20 deposit, a subscription, or a premium plan.
function renderConciergeCommitment(data) {
  const out = $('#plannerOut');
  out.innerHTML = `<div class="card pad center" style="max-width:560px;margin:0 auto;border-color:rgba(216,180,106,0.4)">
    <div style="font-size:34px">🤝</div>
    <h3 style="margin:10px 0 6px">Concierge Search needs a commitment</h3>
    <p class="muted" style="font-size:14px">${data.message || 'Concierge pairs AI agents with a human travel expert — place a refundable £20 deposit, or use a subscription/premium plan.'}</p>
    <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:8px">
      <button class="btn btn-gold" onclick="placeConciergeDeposit()">Place refundable £20 deposit</button>
      <button class="btn btn-ghost" data-nav="membership">Join a plan</button>
      <button class="btn btn-ghost" onclick="runFreeSearch()">Run free cached search</button>
    </div>
    <p class="muted" style="font-size:12px;margin-top:12px">The deposit is deducted from your final payment when you book, and refundable if you don't — unless abuse is detected.</p>
  </div>`;
}
window.placeConciergeDeposit = async () => {
  if (!state.user) { toast('Sign in first to place a deposit.'); return; }
  try {
    const d = await api(`/api/account/${state.user.id}/deposit`, { method: 'POST', body: JSON.stringify({ tier: 'concierge' }) });
    // Live mode: pay the refundable deposit first; it activates on the webhook.
    if (d.checkout) { toast('💳 Opening secure checkout for your refundable deposit…'); window.location.href = d.checkout; return; }
    toast(`✓ £${d.deposit.amountGBP} refundable deposit placed — running your Concierge Search.`);
    runPlan();
  } catch { /* api() already surfaced the error */ }
};
window.renewMembership = async () => {
  let d; try { d = await api('/api/membership/renew', { method: 'POST', body: '{}' }); } catch { return; }
  if (d.checkout) { toast('💳 Opening secure checkout…'); window.location.href = d.checkout; return; }
  if (d.user) setUser(d.user);
  toast(`✓ Renewed — ${d.acuCredited?.toLocaleString()} ACU added. Balance ${d.user?.acuBalance?.toLocaleString()} ACU.`);
};

function scanAnimation() {
  const lines = ['Understanding intent…', 'Detecting location & currency…', 'Checking cost-protection gate…', 'Scanning verified global suppliers…', 'Filtering for reliability…', 'Building transparent packages…'];
  return `<div class="card pad scanlog">${lines.map((l, i) => `<div class="ln" style="animation-delay:${i * 70}ms"><span class="ok">●</span> ${l}</div>`).join('')}</div>`;
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// Pickable destination cards — used inside the clarify screen and as the
// full "Inspire me" stage. Picking one fills the search box and re-runs.
function proposalCardsHTML(proposals) {
  return (proposals || []).map((p) => `
    <div class="card pad dest-card" style="cursor:pointer" onclick="planProposed('${esc(p.city)}')">
      <div style="font-size:26px">${esc(p.emoji || '✈️')}</div>
      <h3 style="margin:6px 0 2px">${esc(p.city)}</h3>
      <div class="muted" style="font-size:12.5px">${esc(p.blurb || '')}</div>
      <div class="chips" style="margin-top:8px">
        ${p.inSeason ? '<span class="chip" style="color:var(--green);border-color:rgba(70,211,154,0.35)">☀ in season</span>' : ''}
        ${(p.matchedVibes || []).slice(0, 3).map((v) => `<span class="chip">${esc(v)}</span>`).join('')}
        ${p.budget ? `<span class="chip">${p.budget === 'low' ? '£ value' : p.budget === 'high' ? '£££ premium' : '££ mid'}</span>` : ''}
      </div>
      <button class="btn btn-gold btn-sm btn-block" style="margin-top:10px">Build this trip →</button>
    </div>`).join('');
}
window.planProposed = (city) => {
  const box = $('#intentInput');
  if (box) box.value = `A trip to ${city} for 5 nights with flights and hotel — the cheapest reliable price.`;
  runPlan();
};
window.inspireMe = () => runPlan({ inspire: true });

function renderClarify(data) {
  const qs = data.questions.map((q) => `
    <div style="margin-top:14px">
      <strong>${esc(q.question)}</strong>
      <div class="chips">${q.options.map((o) => `<span class="chip" onclick="answer('${esc(q.id)}','${esc(o)}')">${esc(o)}</span>`).join('')}</div>
    </div>`).join('');
  // When the destination is unresolved, offer proposals right here so the
  // traveller with nowhere in mind is never stuck on the question.
  const inspire = (data.proposals && data.proposals.length) ? `
    <div style="margin-top:18px;padding-top:14px;border-top:1px solid rgba(223,229,238,.1)">
      <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
        <strong>✨ Nowhere in mind? Let us propose</strong>
        <span class="muted" style="font-size:12px">tailored to your words &amp; season</span>
      </div>
      <div class="dest-grid" style="margin-top:10px">${proposalCardsHTML(data.proposals.slice(0, 6))}</div>
    </div>` : '';
  $('#plannerOut').innerHTML = `<div class="card pad"><span class="eyebrow">A couple of quick questions</span>
    <p class="muted" style="font-size:14px">Tell us where — or let us suggest somewhere below.</p>${qs}${inspire}</div>`;
}
window.answer = (id, val) => runPlan({ [id]: val });

// Full "Inspire me" stage — the traveller asked for suggestions outright.
function renderInspiration(data) {
  $('#plannerOut').innerHTML = `<div class="card pad">
    <span class="eyebrow">✨ Inspire me</span>
    <p class="muted" style="font-size:14px">${esc(data.message || 'Trips worth taking — pick one and we build the whole thing.')}</p>
    <div class="dest-grid" style="margin-top:14px">${proposalCardsHTML(data.proposals)}</div>
  </div>`;
}

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
          <span class="eyebrow">${data.journey === false ? 'Request understood' : 'Trip understood'}</span>
          <div style="font-size:20px;font-family:'Space Grotesk';font-weight:700">${data.journey !== false && data.origin ? esc(data.origin.city) + ' → ' : ''}${esc(intent.destination.city)}${intent.destination.countryName ? ', ' + esc(intent.destination.countryName) : ''}</div>
          <div class="muted" style="font-size:13.5px">${data.journey !== false && data.origin ? `${esc(data.origin.airport)}→${esc(intent.destination.code || '')} · ` : ''}${intent.travellers.adults} adult${intent.travellers.adults > 1 ? 's' : ''}${intent.travellers.children ? ` · ${intent.travellers.children} child${intent.travellers.children > 1 ? 'ren' : ''}${intent.travellers.childAges && intent.travellers.childAges.length ? ` (aged ${intent.travellers.childAges.join(', ')})` : ''}` : ''} · ${intent.nights} ${intent.nights === 1 ? 'night' : 'nights'} · ${intent.month || 'flexible'} · ${ukDate(intent.dates.checkIn)} → ${ukDate(intent.dates.checkOut)}</div>
          ${intent.hotelArea ? `<div class="muted" style="font-size:12px;margin-top:4px">📍 Searching hotels in <strong>${esc(intent.hotelArea)}</strong> as requested.</div>` : ''}
          ${data.recommendedDestination ? `<div class="muted" style="font-size:12px;margin-top:4px">📍 You named ${esc(data.recommendedDestination)} — we recommend <strong>${esc(intent.destination.city)}</strong> as the gateway city. Name a specific city to change it.</div>` : ''}
          ${data.journey !== false && data.origin && data.origin.inferred ? `<div class="muted" style="font-size:12px;margin-top:4px">🛫 Departure assumed <strong>${esc(data.origin.city)}</strong> — add "from &lt;your city&gt;" to your request for exact flights.</div>` : ''}
          ${data.journey !== false && data.origin && data.origin.approxCode ? `<div class="muted" style="font-size:12px;margin-top:4px">ℹ️ We used an approximate airport code for <strong>${esc(data.origin.city)}</strong> — name a major nearby city for an exact match.</div>` : ''}
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

  // Deep Price Dive — the deep-thinking pass behind every funded search:
  // quantified savings levers + the unbeatable-price verdict.
  const dive = data.priceDive;
  const diveCard = dive ? `
    <div class="card pad" style="margin-bottom:20px">
      <span class="eyebrow">Deep Price Dive · ${dive.combinationsExplored.toLocaleString()} combinations explored across ${dive.leversChecked} levers${dive.basis === 'estimated' ? ' · estimated' : ''}</span>
      ${dive.savings.length ? dive.savings.map((sv, i) => {
        const tag = sv.basis === 'verified' ? '<span class="chip" style="font-size:9px;border-color:rgba(121,217,155,.4);color:#79d99b">verified</span>'
          : sv.basis === 'estimated' ? '<span class="chip" style="font-size:9px;border-color:rgba(216,180,106,.4);color:var(--gold)">estimate</span>'
          : sv.basis === 'indicative' ? '<span class="chip" style="font-size:9px;border-color:rgba(216,180,106,.4);color:var(--gold)">indicative</span>' : '';
        let applyBtn = '';
        if (sv.apply && (sv.apply.shiftDays || sv.apply.airport)) {
          window.__diveApply = window.__diveApply || {};
          window.__diveApply[i] = sv.apply;
          applyBtn = `<button class="btn btn-ghost btn-sm" style="padding:4px 12px;margin-left:8px;font-size:11px" onclick="applyDiveLever(${i})">Apply &amp; re-search →</button>`;
        }
        return `<div class="ln"><span class="ok" style="color:var(--gold)">◆</span> <strong>${esc(sv.lever)}</strong> ${tag} — ${esc(sv.how)} <span style="color:var(--green);font-weight:700">save ${money(sv.savingUSD * (data.context?.currency?.rateFromUSD || 1), sym)}</span>${applyBtn}</div>`;
      }).join('')
        : '<div class="ln"><span class="ok">●</span> No cheaper reliable combination exists on your exact dates and airports.</div>'}
      ${dive.indicativeNote ? `<p class="muted" style="font-size:11.5px;margin-top:8px">ℹ ${esc(dive.indicativeNote)}</p>` : ''}
      <div class="pill" style="margin-top:12px;border-color:rgba(70,211,154,0.4)"><span class="dot" style="background:var(--green)"></span> ${esc(dive.unbeatable.verdict)}</div>
    </div>` : '';

  const opts = data.packages.options.map((o) => optionCard(o, sym, intent)).join('');

  // Flight-preference feedback: confirm direct/departure-window honoured, or
  // explain honestly when a non-stop wasn't available on this route.
  const fp = data.flightPrefs || {};
  const fpBits = [];
  if (fp.directOnly) {
    fpBits.push(fp.directUnavailable
      ? '⚠ No non-stop on this route — showing the best connecting flights'
      : '⭐ Direct flights only — honoured');
  }
  if (fp.departureWindow) fpBits.push(`🕑 Preferred departure: ${esc(fp.departureWindow)}`);
  // Mode competition: the OS compared every realistic way to travel.
  const mc = data.modeCompetition;
  const modeNote = mc
    ? `<div class="pill" style="margin:0 0 16px;border-color:rgba(78,161,255,0.4)">🧭 No travel mode specified — compared ${mc.map((m) => ({ flights: '✈ flights', train: '🚆 train', coach: '🚌 coach (FlixBus, Eurolines…)', ferry: '⛴ ferry' }[m] || m)).join(' vs ')} · cheapest reliable won</div>`
    : '';
  const flightPrefNote = fpBits.length
    ? `<div class="pill" style="margin:0 0 16px;border-color:${fp.directUnavailable ? 'rgba(216,180,106,0.45)' : 'rgba(70,211,154,0.35)'}">${fpBits.join(' · ')}</div>`
    : '';

  // Provenance transparency: real fares (Duffel/Amadeus), real schedules (OAG,
  // estimator-priced), or fully indicative estimates.
  const ps = data.priceSource || {};
  const ss = data.scheduleSource || {};
  const liveBits = [];
  if (ps.flights === 'live') liveBits.push('flight fares');
  if (ps.hotel === 'live') liveBits.push('hotel rates');
  const pl = ps.flightPartiesLive; // {live,total} on a multi-origin group
  let psNote = '';
  if (liveBits.length) {
    psNote = `<div class="pill" style="margin:0 0 16px;border-color:rgba(70,211,154,0.35)">🟢 Live prices · ${liveBits.join(' + ')} from connected providers</div>`;
  } else if (ps.flights === 'partial') {
    // Group with some parties live, some estimated — say so precisely.
    const n = pl ? `${pl.live} of ${pl.total}` : 'some';
    psNote = `<div class="pill" style="margin:0 0 16px;border-color:rgba(216,180,106,0.4)">🟡 ${n} departure fares are live &amp; bookable (Duffel) · the rest are indicative until we confirm live availability for those airports</div>`;
  } else if (ss.flights === 'live') {
    psNote = `<div class="pill" style="margin:0 0 16px;border-color:rgba(70,211,154,0.35)">🟢 Real flight schedules (OAG) · live carriers, times &amp; non-stops — fares indicative until a fare provider is connected</div>`;
  } else if (ps.flights || ps.hotel) {
    psNote = `<div class="pill" style="margin:0 0 16px"><span class="dot"></span> Indicative prices from the 3JN estimator — connect a live flight/hotel provider for real-time quotes</div>`;
  }

  // Clearly-LABELLED sponsored strip — separate from (never mixed into) the
  // ranked options, so the cheapest-reliable pick is never reordered by ads.
  const sponsoredStrip = Array.isArray(data.sponsored) && data.sponsored.length
    ? `<div class="card pad" style="margin-top:14px;border-style:dashed">
        <span class="eyebrow">Sponsored · from our partners</span>
        <div class="chips" style="margin-top:8px">${data.sponsored.map((s) => `<span class="chip">${esc(s.partner)} <span class="muted" style="font-size:10px">Ad</span></span>`).join('')}</div>
        <p class="muted" style="font-size:11px;margin:6px 0 0">Sponsored placements are clearly labelled and never change your recommended or cheapest pick.</p>
      </div>`
    : '';

  $('#plannerOut').innerHTML = gateBanner + modeNote + flightPrefNote + psNote + summary + scanCard + diveCard +
    `<div class="section-head left" style="margin-bottom:10px"><h2 style="font-size:24px">Your package options</h2>
      <p>Recommended: <strong style="color:var(--gold)">${data.packages.recommendedTier}</strong> · Cheapest: <strong>${data.packages.cheapestTier}</strong>. Every fee is shown openly in the breakdown — a 2% service fee on flights-only (min £4.99, capped at £15), 10% on packages.</p></div>
    <div class="opt-grid">${opts}</div>` + sponsoredStrip + compareCard(data, sym);

  // stash options for booking
  window.__options = {};
  data.packages.options.forEach((o) => { window.__options[o.tier] = o; });
  window.__intent = intent;
}

// Independent "verify our price" deep-links — built from the actual trip so the
// customer can check the SAME dates and passengers on neutral sites. We never
// fabricate a competitor's number; we let them confirm it live.
function yymmdd(d) { return (d || '').slice(2, 4) + (d || '').slice(5, 7) + (d || '').slice(8, 10); }
function slug(s) { return (s || '').toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, ''); }
function verifyLinks(data) {
  const o = data.origin?.airport || '';
  const oCity = data.origin?.city || '';
  const dcode = data.intent?.destination?.code || '';
  const city = data.intent?.destination?.city || '';
  const ci = data.intent?.dates?.checkIn || '';
  const co = data.intent?.dates?.checkOut || '';
  const t = data.intent?.travellers || {};
  const A = t.adults || 1; const C = t.children || 0; const ages = t.childAges || [];
  // Only show verify links for the modes the traveller actually searched.
  const comps = new Set(data.intent?.components || []);
  const recCruise = (data.packages?.options?.[0]?.components || []).find((c) => c.type === 'cruise');
  const isMini = !!recCruise?.details?.miniCruise;
  const links = [];

  if (comps.has('flights') && o && dcode && ci && co) {
    links.push({ name: 'Skyscanner', what: 'flights', url: `https://www.skyscanner.net/transport/flights/${o.toLowerCase()}/${dcode.toLowerCase()}/${yymmdd(ci)}/${yymmdd(co)}/?adults=${A}&children=${C}&cabinclass=economy&preferdirects=${data.flightPrefs?.directOnly ? 'true' : 'false'}` });
    links.push({ name: 'Google Flights', what: 'flights', url: `https://www.google.com/travel/flights?q=${encodeURIComponent(`flights from ${o} to ${dcode} on ${ci} returning ${co} ${A} adults ${C} children economy`)}` });
    links.push({ name: 'Kayak', what: 'flights', url: `https://www.kayak.co.uk/flights/${o}-${dcode}/${ci}/${co}/${A}adults${C ? '/' + C + 'children' : ''}?sort=price_a` });
  }
  if (comps.has('train')) {
    links.push({ name: 'Trainline', what: 'train', url: `https://www.thetrainline.com/train-times/${slug(oCity)}-to-${slug(city)}` });
    links.push({ name: 'Google', what: 'train', url: `https://www.google.com/search?q=${encodeURIComponent(`train ${oCity} to ${city} ${ci}`)}` });
  }
  if (comps.has('coach')) {
    links.push({ name: 'National Express', what: 'coach', url: 'https://www.nationalexpress.com/en' });
    links.push({ name: 'FlixBus', what: 'coach', url: `https://www.flixbus.co.uk/coach/${slug(oCity)}` });
  }
  if (comps.has('ferry')) {
    links.push({ name: 'Direct Ferries', what: 'ferry', url: `https://www.directferries.co.uk/${slug(oCity)}_${slug(city)}_ferry.htm` });
  }
  if (comps.has('cruise')) {
    if (isMini) {
      links.push({ name: 'DFDS Mini Cruises', what: 'mini cruise', url: 'https://www.dfds.com/en-gb/passenger-ferries/mini-cruises' });
      links.push({ name: 'Direct Ferries', what: 'mini cruise', url: 'https://www.directferries.co.uk/mini_cruises.htm' });
    } else {
      links.push({ name: 'Cruise.co.uk', what: 'cruise', url: `https://www.cruise.co.uk/cruise-search/?destination=${encodeURIComponent(city)}` });
    }
  }
  if (comps.has('hotel') && city && ci && co) {
    const ageParams = ages.map((a) => `&age=${a}`).join('');
    links.push({ name: 'Booking.com', what: 'hotel', url: `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(city)}&checkin=${ci}&checkout=${co}&group_adults=${A}&group_children=${C}${ageParams}` });
  }
  if (comps.has('esim')) {
    const cn = data.intent?.destination?.countryName || '';
    links.push({ name: 'Airalo', what: 'eSIM', url: cn ? `https://www.airalo.com/${slug(cn)}-esim` : 'https://www.airalo.com/' });
    links.push({ name: 'Holafly', what: 'eSIM', url: 'https://esim.holafly.com/' });
  }
  if (comps.has('carhire')) links.push({ name: 'Rentalcars', what: 'car hire', url: `https://www.rentalcars.com/SearchResults.do?destination=${encodeURIComponent(city)}` });
  if (comps.has('insurance')) links.push({ name: 'MoneySuperMarket', what: 'insurance', url: 'https://travel.moneysupermarket.com/' });
  return links;
}

// Price-check panel: our all-in vs a typical-retail estimate, plus live verify
// links. Lets you demo "we're cheapest" with receipts the customer can click.
function compareCard(data, sym) {
  // We do NOT send customers to competitor sites to compare, and we never show a
  // fabricated "typical retail / you save vs market" figure (the estimator's
  // market reference isn't a real quote). Only when a REAL cached market feed is
  // connected do we show an honest market range — otherwise show nothing but our
  // own Price-Match Promise (a 3JN commitment, not a comparison).
  const opts = data.packages?.options || [];
  if (!opts.length) return '';
  const rec = opts.find((o) => o.recommended) || opts[0];
  const our = rec.pricing.local.total;
  const marketBlock = data.marketLive
    ? `<div style="display:flex;gap:28px;flex-wrap:wrap;align-items:flex-end;margin-top:10px">
        <div><div class="t-label">3JN all-in</div><div style="font-family:'Space Grotesk';font-weight:700;font-size:30px;color:var(--gold)">${money(our, sym)}</div></div>
        <div><div class="t-label">Real market range (${esc(data.marketLive.cheapestCarrier || 'live cache')})</div><div style="font-family:'Space Grotesk';font-weight:700;font-size:24px">${money(data.marketLive.minGbp, '£')}<span class="muted" style="font-size:13px;font-weight:400"> – ${money(data.marketLive.maxGbp, '£')} · ${data.marketLive.sampled} fares</span></div></div>
      </div>
      <p class="muted" style="font-size:11.5px;margin-top:8px">Real fares travellers found on this route (${esc(data.marketLive.source)}). Cached prices aren't guaranteed bookable, so we only charge a live confirmed fare.</p>`
    : '';
  return `<div class="card pad" style="margin-top:26px;border-color:rgba(70,211,154,0.32)">
    <span class="eyebrow">Our Price-Match Promise</span>
    ${marketBlock}
    <div style="margin-top:12px;font-size:12.5px">
      🛡 <strong>Price-Match Promise</strong> — find this exact trip cheaper like-for-like (same flights, same dates, one protected booking) within 24h of booking and we match it and credit the difference as ACU.
    </div>
  </div>`;
}

// Kiwi-grade flight itinerary block ON the result card: per leg the date,
// cabin, carrier, times (+1), stops, airport codes, duration, WHERE it
// connects and the transfer type; then baggage per person and the per-person
// fare. A customer must never have to open a modal to learn the basics.
function flightItinBlock(c, o, sym, intent) {
  const d = c.details || {};
  const p = o.pricing;
  const rate = p.local.total / p.lines.totalUSD;
  const pax = d.passengers || intent?.travellers?.total || 1;
  const perPax = money2((c.priceUSD / pax) * rate, sym);
  const dateNice = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${+m[3]} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m[2]-1]}` : ''; };
  const legRow = (l, title) => {
    if (!l) return '';
    const via = (l.layovers || []).length
      ? l.layovers.map((v) => `${esc(v.city || v.airport)} (${esc(v.airport)})${v.durationLabel ? ' · ' + esc(v.durationLabel) + ' wait' : ''}${v.overnight ? ' · overnight' : ''}${v.tight ? ' · ⚠ tight' : ''}`).join(', ')
      : l.via ? `${esc(l.via.city || l.via.airport)} (${esc(l.via.airport)})` : '';
    const flights = (l.segments || []).map((s) => esc(s.flightNumber)).filter(Boolean).join(' + ');
    return `<div style="padding:8px 0;border-top:1px dashed rgba(223,229,238,.12)">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:4px;font-size:12px">
        <span><strong>${title}</strong> · ${esc(dateNice(l.date))} · ${esc(d.cabin || 'Economy')} · ${esc(c.supplier)}${flights ? ` · ${flights}` : ''}</span>
        <span class="muted">${l.stops ? ((l.layovers || []).length && l.layovers.every((v) => v.minutes != null && v.minutes <= 180 && !v.overnight) ? '<span style="color:var(--green)">⏱ Short stopover</span>' : `${l.stops} stop${l.stops > 1 ? 's' : ''}`) : '<span style="color:var(--green)">⭐ Direct</span>'}</span></div>
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:4px;margin-top:3px">
        <span style="font-family:'Space Grotesk';font-weight:700;font-size:16px">${esc(l.depart)} – ${esc(l.arrive)}${l.arriveNextDay ? ' <span class="muted" style="font-size:11px">+1</span>' : ''}</span>
        <span class="muted" style="font-size:12px">${esc(l.from)} – ${esc(l.to)} · ${esc(l.durationLabel || '')}</span></div>
      ${l.stops ? `<div style="font-size:11.5px;margin-top:3px;color:var(--green)">🔗 Protected transfer${via ? ' · via ' + via : ''} — one ticket, bags checked through, free rebooking if a delay breaks the connection</div>` : ''}
    </div>`;
  };
  return `<div style="margin:6px 0 2px">
    ${legRow(d.outbound, 'Outbound')}${legRow(d.inbound, 'Return')}
    <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:4px;padding:7px 0 2px;border-top:1px dashed rgba(223,229,238,.12);font-size:11.5px">
      <span class="muted">🧳 ${esc(d.baggage || 'Baggage per fare rules')} <span style="opacity:.75">· per person</span></span>
      <span><strong style="color:var(--gold)">${perPax}</strong> <span class="muted">per person${pax > 1 ? ` · ${pax} travellers` : ''}</span></span>
    </div>
  </div>`;
}

function optionCard(o, sym, intent) {
  const p = o.pricing;
  const comps = o.components.map((c, i) => {
    // Source chip. Only show an EXTERNAL "↗ <source>" link when the price is a
    // genuinely LIVE supplier fare — otherwise it falsely implies we sourced the
    // estimate from that site (e.g. "↗ Trip.com" on a synthesised price). Agent
    // (net-rate) sourcing keeps its badge; everything else shows "estimate".
    const isLiveSrc = !!(c.live || c.sourcedType === 'live' || /\blive\b/i.test(c.sourcedVia || ''));
    let src;
    if (c.agent) {
      src = `<span class="src agent" title="${c.agentId ? '3JN agent account ' + esc(c.agentId) : ''}">🔑 agent · ${esc(c.sourcedVia || '')}${c.agentId ? ' · ' + esc(c.agentId) : ''}</span>`;
    } else if (isLiveSrc && c.sourcedVia) {
      src = `<span class="src">↗ ${esc(c.sourcedVia)}</span>`;
    } else {
      src = '<span class="src" style="opacity:.65">estimate</span>';
    }
    const more = ['flight', 'hotel', 'host', 'cruise', 'train', 'coach', 'ferry'].includes(c.type) ? ` <span class="more-info" onclick="event.stopPropagation();showComponentInfo('${o.tier}',${i})">ⓘ more</span>` : '';
    const flightTag = c.type === 'flight' && c.details?.outbound
      ? ((c.details.outbound.stops || 0) === 0 && (c.details.inbound?.stops || 0) === 0
        ? ' <span class="ch-chip" style="color:var(--green);border-color:rgba(70,211,154,0.35)">⭐ Direct</span>'
        : ` <span class="ch-chip">${esc(c.details.outbound.stopLabel || '1 stop')}</span>`)
      : '';
    // Baggage allowance chip on flights — visible without expanding "ⓘ more".
    const bagTag = c.type === 'flight' && c.details?.baggage
      ? ` <span class="ch-chip" style="color:var(--blue-bright);border-color:rgba(78,161,255,0.3)" title="Baggage allowance included in this fare">🧳 ${esc(c.details.baggage)}</span>`
      : '';
    // Hotel/host rating chip: star class + guest score out of 10 with review count.
    const ratingTag = (c.type === 'hotel' || c.type === 'host')
      ? `${c.stars ? ` <span class="ch-chip" style="color:var(--gold);border-color:rgba(216,180,106,0.4)">${'★'.repeat(c.stars)}</span>` : ''}${c.details?.guestRating ? ` <span class="ch-chip" title="${(c.details.reviews || 0).toLocaleString()} verified reviews">${c.details.guestRating}/10</span>` : ''}`
      : '';
    // Mixed-mode leg chip: one booking, per-direction means & departure points.
    const legTag = c.details?.leg
      ? ` <span class="ch-chip" style="color:var(--blue-bright);border-color:rgba(78,161,255,0.35)">${c.details.leg === 'outbound' ? '→ Outbound' : '← Return'}${c.details.route ? ' · ' + esc(c.details.route) : ''}</span>`
      : '';
    // Multi-origin group chips: each party's own departure; one shared home.
    const partyTag = c.details?.party
      ? ` <span class="ch-chip" style="color:var(--blue-bright);border-color:rgba(78,161,255,0.35)">👥 ${esc(c.details.party)}${c.details.route ? ' · ' + esc(c.details.route) : ''}</span>`
      : '';
    const groupStayTag = c.details?.groupStay
      ? ` <span class="ch-chip" style="color:var(--gold);border-color:rgba(216,180,106,0.4)" title="${esc(c.details.groupStay.units.join(' • '))}">🏠 Whole group · ${c.details.groupStay.guests} guests · ${c.details.groupStay.units.length} rooms/apartments</span>`
      : '';
    // Transport-mode chip: nights + cabin (cruise) or class/duration (rail/coach/ferry).
    const modeTag = ['cruise', 'train', 'coach', 'ferry'].includes(c.type)
      ? `${c.details?.nights ? ` <span class="ch-chip">${c.details.nights} night${c.details.nights > 1 ? 's' : ''}</span>` : ''}${c.details?.cabin ? ` <span class="ch-chip">${esc(c.details.cabin.split('·')[0].trim())}</span>` : ''}${c.details?.travelClass ? ` <span class="ch-chip">${esc(c.details.travelClass)}</span>` : ''}`
      : (c.type === 'esim' && c.details?.planLabel ? ` <span class="ch-chip">${esc(c.details.planLabel)}</span>` : '');
    // Flights carry the FULL itinerary on the card (dates, times, stops, via,
    // baggage, per-person fare); other components stay one-line summaries.
    const itin = c.type === 'flight' && c.details?.outbound ? flightItinBlock(c, o, sym, intent) : '';
    // With the itinerary block the stop/baggage chips are redundant noise.
    const chips = itin ? `${legTag}${partyTag}` : `${legTag}${partyTag}${groupStayTag}${flightTag}${bagTag}${ratingTag}${modeTag}`;
    return `
    <li ${itin ? 'style="display:block"' : ''}><span class="cs" ${itin ? 'style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:4px"' : ''}>${labelFor(c)} <span class="muted">· ${esc(c.supplier)}</span>${chips} ${src}${more}${itin ? `<span class="cp">${money2(c.priceUSD * (p.local.total / p.lines.totalUSD), sym)}</span>` : ''}</span>${itin || `<span class="cp">${money2(c.priceUSD * (p.local.total / p.lines.totalUSD), sym)}</span>`}</li>`;
  }).join('');
  return `
    <div class="card opt ${o.recommended ? 'rec' : ''}">
      ${o.recommended ? '<span class="rec-tag">★ Recommended</span>' : ''}
      <span class="verified-tag">✓ ${o.verified ? '100% Verified' : 'Mixed'} · reliability ${o.avgReliability}</span>
      <div class="rel-bar"><i style="width:${o.avgReliability}%"></i></div>
      <h3>${esc(o.tier)}</h3>
      <div class="blurb">${esc(o.blurb)}</div>
      <div class="price-big">${money(p.local.total, sym)}</div>
      <div class="save-tag">&nbsp;</div>
      <!-- Fabricated "you save £X vs market" removed: the estimator's market reference is not a real quote. Real savings show only via the Deep Price Dive (verified) or a live market feed. -->
      <ul class="comp-list">${comps}</ul>
      <table class="brk">
        <tr><td>Suppliers</td><td>${money2(p.local.suppliers, sym)}</td></tr>
        <tr class="save"><td>${p.discountSource === 'member' ? 'Member' : 'Loyalty'} discount (${esc(p.loyaltyTier)} · ${(p.loyaltyDiscountPct * 100).toFixed(0)}%)</td><td>-${money2(p.local.loyaltyDiscount, sym)}</td></tr>
        <tr><td>${esc(p.feeLabel || '3JN commission (10%)')}</td><td>${(p.local.grossCommission ?? p.local.commission) > 0 ? money2(p.local.grossCommission ?? p.local.commission, sym) : '<span style="color:var(--green)">FREE</span>'}</td></tr>
        ${p.local.duffelFee > 0 ? `<tr><td>Airline booking fees (Duffel)</td><td>${money2(p.local.duffelFee, sym)}</td></tr>` : ''}
        <tr class="total"><td>Total</td><td>${money2(p.local.total, sym)}</td></tr>
      </table>
      ${o.bookableForRealPayment
        ? `<div class="save-tag" style="color:#79d99b;border-color:rgba(121,217,155,.4)">✓ Live bookable price</div>
           <button class="btn ${o.recommended ? 'btn-gold' : 'btn-ghost'} btn-block" style="margin-top:10px" onclick="openBooking('${o.tier}')">Quote & ${intent.wantsInstalments ? 'pay in instalments' : 'book'}</button>`
        : `<div class="save-tag" style="color:var(--gold);border-color:rgba(216,180,106,.4)">We book it for you — pay in full or in instalments</div>
           <button class="btn ${o.recommended ? 'btn-gold' : 'btn-ghost'} btn-block" style="margin-top:10px" onclick="openBooking('${o.tier}')">Book with 3JN${intent.wantsInstalments ? ' · pay monthly' : ''}</button>`}
    </div>`;
}

// The booking model: 3JN books, 3JN issues the ticket. There is no
// "book it yourself on the supplier's site" path — the customer books with us
// (pay in full or in instalments) and we create the order and issue the
// e-ticket. Pay in full → ticket now; instalments → we hold the fare and issue
// on completion. See optionCard's "Book with 3JN" CTA.

function labelFor(c) {
  const s = esc(c.supplier);
  const cruiseLabel = c.details?.miniCruise ? '🛳 Mini cruise' : '🛳 Cruise';
  // Generic mode names — the supplier is shown separately on the line, so don't
  // repeat it here (avoids "Fjord Line Mini Cruise · Fjord Line Mini Cruise").
  const map = { flight: '✈ Flights', train: '🚆 Train', coach: '🚌 Coach', ferry: '⛴ Ferry', cruise: cruiseLabel, hotel: '🏨 Hotel', host: '🏡 Private host', activity: '🎟 ' + s, visa: '🛂 Visa', insurance: '🛡 Insurance', transfer: '🚘 Transfer', carhire: '🚗 Car/bike hire', tickets: '🎫 ' + s, boat: '⛵ ' + s, esim: '📶 eSIM', photographer: '📸 Photographer', guide: '🧭 Local guide', restaurant: '🍽 Restaurant booking', translator: '🗣 Translator', driver: '🚙 Local driver' };
  return map[c.type] || esc(c.type);
}

// Per-passenger fare split (OTA-style): adults & 12–17 youths at full fare,
// 2–11 children at 75%, under-2 infants at 10%. Shown when a party has children.
function fareSplitHTML(d, toLocal) {
  const b = d.fareBreakdown;
  if (!b || (!b.youth && !b.child && !b.infant)) return '';
  const rows = [];
  if (b.adult) rows.push(`<div class="kv"><span>${b.adult} adult${b.adult > 1 ? 's' : ''} (full fare)</span><span>${toLocal(d.adultFareUSD)} ea</span></div>`);
  if (b.youth) rows.push(`<div class="kv"><span>${b.youth} youth 12–17 (adult fare)</span><span>${toLocal(d.adultFareUSD)} ea</span></div>`);
  if (b.child) rows.push(`<div class="kv"><span>${b.child} child 2–11 (75%)</span><span>${toLocal(d.childFareUSD)} ea</span></div>`);
  if (b.infant) rows.push(`<div class="kv"><span>${b.infant} infant under 2 (10%)</span><span>${toLocal(d.infantFareUSD)} ea</span></div>`);
  return `<div class="card pad" style="margin-top:10px">
    <span class="eyebrow">Fare split by passenger</span>${rows.join('')}
    <div class="muted" style="font-size:11.5px;margin-top:6px">Airlines charge 12+ as adults; 2–11 at a child fare; under-2 infants travel on a lap. Return fare shown per seat.</div>
  </div>`;
}

// Detailed info + images for a selected flight or hotel.
window.showComponentInfo = (tier, idx) => {
  const o = window.__options?.[tier];
  const c = o?.components?.[idx];
  if (!c) return;
  const sym = o.pricing.symbol;
  const toLocal = (usd) => money2(usd * (o.pricing.local.total / o.pricing.lines.totalUSD), sym);
  const d = c.details || {};
  if (c.type === 'flight') {
    // Connecting itineraries show the FULL plan: every flight number, the
    // stopover airport, and exactly how long each wait is.
    const connectionHTML = (l) => {
      if (!Array.isArray(l?.segments) || l.segments.length < 2) return '';
      const parts = [];
      l.segments.forEach((s, i) => {
        parts.push(`<div class="kv" style="border:none;padding:4px 0"><span>✈ <strong>${esc(s.flightNumber || s.carrier)}</strong> <span class="muted">${esc(s.carrier)}${s.operatedBy ? ' · operated by ' + esc(s.operatedBy) : ''}${s.aircraft ? ' · ' + esc(s.aircraft) : ''}</span></span><span style="font-size:12px">${esc(s.from)} ${esc(s.depart)} → ${esc(s.to)} ${esc(s.arrive)} <span class="muted">· ${esc(s.durationLabel || '')}</span></span></div>`);
        const lay = (l.layovers || [])[i];
        if (lay) parts.push(`<div style="margin:2px 0 2px 14px;font-size:12px;color:${lay.tight ? '#ffb86b' : 'var(--muted)'}">🕓 Stopover in ${esc(lay.city || lay.airport)} (${esc(lay.airport)}) — ${esc(lay.durationLabel || 'wait time per airline')}${lay.overnight ? ' · overnight' : ''}${lay.tight ? ' · ⚠ tight connection' : ''} · you stay airside, same ticket</div>`);
      });
      const indicative = l.segments.some((s2) => s2.indicative)
        ? '<div class="muted" style="font-size:11px;margin-top:4px">ℹ Indicative schedule from real route distances — exact flights, times and connection are confirmed when the fare is ticketed.</div>' : '';
      return `<div style="margin-top:8px;padding-top:8px;border-top:1px dashed rgba(223,229,238,.15)"><span class="muted" style="font-size:11px;letter-spacing:.12em;text-transform:uppercase">Your connection plan</span>${parts.join('')}${indicative}</div>`;
    };
    const legHTML = (l, title) => l ? `
      <div class="card pad" style="margin-top:10px">
        <div style="display:flex;justify-content:space-between;align-items:baseline">
          <strong>${title}</strong><span class="muted" style="font-size:12px">${esc(l.date)} · ${esc(l.stopLabel)} · ${esc(l.durationLabel)}</span></div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
          <div style="text-align:center"><div style="font-family:'Space Grotesk';font-weight:700;font-size:20px">${esc(l.depart)}</div><div class="muted" style="font-size:12px">${esc(l.from)}${l.fromCity ? ' · ' + esc(l.fromCity) : ''}</div></div>
          <div class="muted" style="flex:1;text-align:center;font-size:12px">✈ ${esc(l.durationLabel)}<div class="rel-bar" style="margin:6px 12px"><i style="width:100%"></i></div>${l.stops ? esc(`${l.stops} stop${l.stops > 1 ? 's' : ''}`) : 'Direct'}</div>
          <div style="text-align:center"><div style="font-family:'Space Grotesk';font-weight:700;font-size:20px">${esc(l.arrive)}${l.arriveNextDay ? ' <span class="muted" style="font-size:11px">+1</span>' : ''}</div><div class="muted" style="font-size:12px">${esc(l.to)}${l.toCity ? ' · ' + esc(l.toCity) : ''}</div></div>
        </div>${connectionHTML(l)}</div>` : '';
    const direct = (d.outbound?.stops || 0) === 0 && (d.inbound?.stops || 0) === 0;
    modal(`<span class="eyebrow">Flight details · ${esc(c.supplier)}</span>
      <h3 style="margin:6px 0 2px">${esc(d.outbound?.fromCity || d.outbound?.from)} → ${esc(d.outbound?.toCity || d.outbound?.to)}</h3>
      <div style="margin:6px 0">${direct
        ? '<span class="verified-tag" style="color:var(--green);border-color:rgba(70,211,154,0.35);background:rgba(70,211,154,0.1)">⭐ Direct flight — privilege selection</span>'
        : ([...(d.outbound?.layovers || []), ...(d.inbound?.layovers || [])].length && [...(d.outbound?.layovers || []), ...(d.inbound?.layovers || [])].every((v) => v.minutes != null && v.minutes <= 180 && !v.overnight))
          ? '<span class="verified-tag" style="color:var(--green);border-color:rgba(70,211,154,0.35);background:rgba(70,211,154,0.06)">⏱ Short stopover — privilege selection (no non-stop on this route)</span>'
          : '<span class="verified-tag">↺ Connecting flight (no non-stop or short-stopover option on this route)</span>'}</div>
      <div class="muted" style="font-size:12.5px">${d.passengers} passenger${d.passengers > 1 ? 's' : ''} · ${esc(d.cabin || 'Economy')} · ${esc(d.baggage || '')}${d.flightNumber ? ` · flight ${esc(d.flightNumber)}` : ''}${d.aircraft ? ` · ${esc(d.aircraft)}` : ''}</div>
      ${c.scheduleLive ? '<div class="muted" style="font-size:11.5px;margin-top:4px">🟢 Real operated schedule (OAG) — fare is indicative</div>' : ''}
      ${legHTML(d.outbound, 'Outbound')}${legHTML(d.inbound, 'Return')}
      ${fareSplitHTML(d, toLocal)}
      <div class="kv" style="margin-top:10px;font-weight:700"><span>Total (${d.passengers} pax)</span><span style="color:var(--gold)">${toLocal(c.priceUSD)}</span></div>
      <button class="btn btn-gold btn-block" style="margin-top:14px" onclick="closeModal();openBooking('${tier}')">Select this package</button>`);
    return;
  }
  if (['cruise', 'train', 'coach', 'ferry'].includes(c.type)) {
    const icon = { cruise: '🛳', train: '🚆', coach: '🚌', ferry: '⛴' }[c.type];
    const title = c.type === 'cruise' ? (d.miniCruise ? 'Mini cruise' : 'Cruise') : c.type[0].toUpperCase() + c.type.slice(1);
    const kv = (k, v) => v ? `<div class="kv"><span>${k}</span><span>${esc(String(v))}</span></div>` : '';
    const included = c.type === 'cruise'
      ? (d.miniCruise
        ? 'Return sailing + en-suite cabin + onboard meals. Add an outside cabin, car or excursions at checkout.'
        : 'Cabin + full-board dining + onboard entertainment. Shore excursions and drinks packages optional.')
      : (c.type === 'ferry' ? 'Foot-passenger crossing. Add a vehicle, cabin or priority boarding at checkout.'
        : 'Seat reservation included where available. Seat upgrades and flexible tickets optional at checkout.');
    modal(`<span class="eyebrow">${title} details · ${esc(c.supplier)}</span>
      <div class="property-banner"><span class="property-icon">${icon}</span>
        <div><div style="font-family:'Space Grotesk';font-weight:700;font-size:17px">${esc(c.supplier)}</div>
          <div class="muted" style="font-size:13px">${esc(d.route || d.region || '')}</div></div></div>
      <div style="margin-top:12px">
        ${kv('Route', d.route)}
        ${kv(c.type === 'cruise' ? 'Nights aboard' : 'Duration', c.type === 'cruise' ? (d.nights ? `${d.nights} night${d.nights > 1 ? 's' : ''}` : '') : d.approxDurationLabel)}
        ${kv('Cabin', d.cabin)}
        ${kv('Travel class', d.travelClass)}
        ${kv('Basis', d.basis)}
        ${kv('Travellers', d.people ? `${d.people} ${d.people > 1 ? 'people' : 'person'}` : '')}
        ${d.nightlyUSD ? kv('Per person / night', toLocal(d.nightlyUSD)) : ''}
        ${kv('Vehicle option', d.vehicleOption)}
      </div>
      <p class="muted" style="font-size:12.5px;margin:10px 0">${included}</p>
      <div class="muted" style="font-size:11.5px">Indicative price — connect a live ${c.type} provider for a bookable quote.</div>
      <div class="kv" style="margin-top:10px;font-weight:700"><span>Total${d.people ? ` (${d.people} ${d.people > 1 ? 'people' : 'person'})` : ''}</span><span style="color:var(--gold)">${toLocal(c.priceUSD)}</span></div>
      <button class="btn btn-gold btn-block" style="margin-top:14px" onclick="closeModal();openBooking('${tier}')">Select this package</button>`);
    return;
  }
  // Hotel / host — external properties get NO stock photos (we can't verify
  // them); instead they carry name + street address so the traveller verifies
  // the place on the internet. Properties hosted on OUR marketplace are the
  // exception: hosts must supply 10–100 real photos, which we show.
  const stars = '★'.repeat(c.stars || 0);
  const amen = (d.amenities || []).map((a) => `<span class="chip">${esc(a)}</span>`).join('');
  modal(`<span class="eyebrow">${c.type === 'host' ? 'Private host' : 'Hotel'} details</span>
    <div class="property-banner">
      <span class="property-icon">${c.type === 'host' ? '🏡' : '🏨'}</span>
      <div><div style="font-family:'Space Grotesk';font-weight:700;font-size:17px">${esc(d.propertyName || c.supplier)}</div>
        ${d.propertyName && d.propertyName !== c.supplier ? `<div class="muted" style="font-size:12px">${esc(c.supplier)}</div>` : ''}
        <div style="font-size:13px"><span style="color:var(--gold)">${stars}</span> <span class="muted">· ${esc(d.area || '')}</span></div></div>
    </div>
    <div class="muted" style="font-size:12.5px;margin-top:8px">${esc(d.propertyType || '')} · ${d.distanceToCentreKm ? d.distanceToCentreKm + 'km to centre · ' : ''}${d.guestRating ? d.guestRating + '/10 (' + (d.reviews || 0).toLocaleString() + ' verified reviews)' : ''}</div>
    ${d.address ? `<div class="kv" style="margin-top:8px"><span>📍 Address</span><span style="text-align:right">${esc(d.address)} · <a href="${esc(d.verifyUrl || ('https://www.google.com/search?q=' + encodeURIComponent((d.propertyName || c.supplier) + ' ' + d.address)))}" target="_blank" rel="noopener" style="color:var(--blue-bright);text-decoration:underline">see pictures & info on the web ↗</a> · <a href="${esc(d.mapUrl || ('https://www.google.com/maps/search/' + encodeURIComponent(d.address)))}" target="_blank" rel="noopener" style="color:var(--blue-bright);text-decoration:underline">map ↗</a></span></div>` : ''}
    ${(d.photos || []).length ? `
      <div style="margin-top:12px"><span class="eyebrow">Photos · ${d.photos.length} provided by the host</span>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:8px">
          ${d.photos.slice(0, 8).map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener" style="display:block;aspect-ratio:4/3;border-radius:8px;overflow:hidden;border:1px solid var(--line)"><img src="${esc(u)}" alt="Property photo" loading="lazy" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.style.display='none'"></a>`).join('')}
        </div>
        ${d.photos.length > 8 ? `<div class="muted" style="font-size:11.5px;margin-top:6px">+ ${d.photos.length - 8} more photos</div>` : ''}
      </div>` : ''}
    ${d.verifiedBadge ? `<div class="verified-tag" style="margin-top:8px">✓ ${esc(d.verifiedBadge)}</div>` : ''}
    <p class="muted" style="font-size:13px;margin:10px 0">${esc(d.description || '')}</p>

    <div class="console-grid" style="gap:0 18px">
      <div>
        <span class="eyebrow">Room & stay</span>
        <div class="kv"><span>Room</span><span>${esc(d.roomType || '')}</span></div>
        <div class="kv"><span>Beds</span><span>${esc(d.bedConfiguration || '—')}</span></div>
        <div class="kv"><span>Room size</span><span>${d.roomSizeSqm ? d.roomSizeSqm + ' m²' : '—'}</span></div>
        <div class="kv"><span>Sleeps</span><span>${d.maxOccupancy || d.sleeps || '—'}</span></div>
        <div class="kv"><span>Board</span><span>${esc(d.board || '')}</span></div>
        <div class="kv"><span>Breakfast</span><span>${esc(d.breakfastDetail || '—')}</span></div>
        <div class="kv"><span>Stay</span><span>${d.nights} nights · ${d.rooms} room${d.rooms > 1 ? 's' : ''}</span></div>
      </div>
      <div>
        <span class="eyebrow">Times & policies</span>
        <div class="kv"><span>Check-in</span><span>${esc(d.checkInTime || '15:00')}</span></div>
        <div class="kv"><span>Check-out</span><span>${esc(d.checkOutTime || '12:00')}</span></div>
        <div class="kv"><span>Cancellation</span><span>${d.freeCancellation ? '<span style="color:var(--green)">' + esc(d.cancellationDeadline || 'Free cancellation') + '</span>' : 'Non-refundable'}</span></div>
        <div class="kv"><span>Deposit</span><span style="font-size:12px">${esc(d.depositPolicy || '—')}</span></div>
        <div class="kv"><span>Parking</span><span>${esc(d.parking || '—')}</span></div>
        <div class="kv"><span>Pets</span><span>${esc(d.petsPolicy || '—')}</span></div>
        <div class="kv"><span>Children</span><span style="font-size:12px">${esc(d.childrenPolicy || '—')}</span></div>
      </div>
    </div>

    <div style="margin-top:12px"><span class="eyebrow">Amenities</span><div class="chips" style="margin-top:6px">${amen}</div></div>
    ${(d.nearbyLandmarks || []).length ? `<div style="margin-top:10px"><span class="eyebrow">What's nearby</span><div class="chips" style="margin-top:6px">${d.nearbyLandmarks.map((l) => `<span class="chip">📍 ${esc(l)}</span>`).join('')}</div></div>` : ''}
    ${(d.languages || []).length ? `<div class="kv" style="margin-top:10px"><span>Languages</span><span>${d.languages.map(esc).join(' · ')}</span></div>` : ''}
    ${(d.paymentOptions || []).length ? `<div class="kv"><span>Payment</span><span style="font-size:12px;text-align:right">${d.paymentOptions.map(esc).join(' · ')}</span></div>` : ''}
    ${d.taxesNote ? `<div class="muted" style="font-size:11.5px;margin-top:6px">${esc(d.taxesNote)}</div>` : ''}

    ${(d.priceLines || []).length ? `<div style="margin-top:12px"><span class="eyebrow">Prices — full breakdown, no surprise fees</span>
      ${d.priceLines.map((l) => `<div class="kv"><span>${esc(l.label)}</span><span>${toLocal(l.amountUSD)}</span></div>`).join('')}
      ${d.securityDepositUSD ? `<div class="kv"><span>Security deposit (held, refundable)</span><span>${toLocal(d.securityDepositUSD)}</span></div>` : ''}</div>` : ''}
    ${d.community ? `<div style="margin-top:12px"><span class="eyebrow">Terms & rules</span>
      ${d.cancellationPolicy ? `<div class="kv"><span>Cancellation</span><span style="font-size:12px;text-align:right">${esc(d.cancellationPolicy)}</span></div>` : ''}
      ${d.checkInAfter ? `<div class="kv"><span>Check-in after</span><span>${esc(d.checkInAfter)}</span></div>` : ''}
      ${d.checkOutBefore ? `<div class="kv"><span>Check-out before</span><span>${esc(d.checkOutBefore)}</span></div>` : ''}
      ${d.houseRules ? `<div class="kv"><span>House rules</span><span style="font-size:12px;text-align:right">${esc(d.houseRules)}</span></div>` : ''}
      ${d.instantBooking ? '<div class="kv"><span>Instant booking</span><span style="color:var(--green)">✓ Yes</span></div>' : ''}</div>` : ''}
    ${(d.facilities || []).length ? `<div style="margin-top:10px"><span class="eyebrow">Facilities</span><div class="chips" style="margin-top:6px">${d.facilities.map((f) => `<span class="chip">${esc(f)}</span>`).join('')}</div></div>` : ''}
    ${(d.services || []).length ? `<div style="margin-top:10px"><span class="eyebrow">Services (optional, paid)</span>${d.services.map((s) => `<div class="kv"><span>${esc(s.name)}${s.description ? ` <span class="muted" style="font-size:11px">· ${esc(s.description)}</span>` : ''}</span><span>${toLocal(s.priceUSD)}</span></div>`).join('')}</div>` : ''}
    ${d.hostName ? `<div class="kv" style="margin-top:10px"><span>Hosted by</span><span>${esc(d.hostName)} · <span style="color:var(--green)">✓ Verified</span></span></div>` : ''}
    ${d.videoUrl ? `<div class="kv"><span>Video</span><span><a href="${esc(d.videoUrl)}" target="_blank" rel="noopener" style="color:var(--blue-bright)">Watch ↗</a></span></div>` : ''}
    <div class="kv" style="margin-top:12px;font-weight:700"><span>Total stay</span><span style="color:var(--gold)">${toLocal(c.priceUSD)}</span></div>
    <button class="btn btn-gold btn-block" style="margin-top:14px" onclick="closeModal();openBooking('${tier}')">Select this package</button>`);
};

// ---- Booking + instalments ------------------------------------------------
// ---- Request Exact Quote (estimated options → real revenue capture) --------
window.payExactQuote = async (id) => {
  try {
    const st = await api('/api/pay/stripe/status', { silent: true });
    if (!st.enabled) { toast('Card payment goes live once Stripe is connected. Our team will confirm your booking meanwhile.'); return; }
    const sess = await api(`/api/quote-request/${id}/pay`, { method: 'POST', body: '{}' });
    if (sess.url) { toast('💳 Opening secure checkout…'); window.location.href = sess.url; }
  } catch (e) { toast(e.message || 'Could not start payment.'); }
};
// (removed requestExactQuote — superseded by openBooking; submitExactQuote below
// stays live via the console quote-request list.)
window.submitExactQuote = async (tier) => {
  const o = window.__options?.[tier];
  if (!o) return;
  const contact = { name: $('#qrName')?.value.trim(), email: $('#qrEmail')?.value.trim(), phone: $('#qrPhone')?.value.trim() };
  if (!contact.name || !contact.email) { toast('Please add your name and email so we can send your exact price.'); return; }
  const body = { option: o, intent: window.__intent || null, contact, depositIntentGBP: $('#qrDeposit')?.checked ? 20 : 0, note: $('#qrNote')?.value.trim() };
  try {
    const d = await api('/api/quote-request', { method: 'POST', body: JSON.stringify(body) });
    closeModal();
    modal(`<div class="center" style="padding:8px"><div style="font-size:40px">📝</div>
      <h3 style="margin:10px 0 6px">Request received</h3>
      <p class="muted" style="font-size:14px">We're confirming the exact bookable price for your <strong>${esc(tier)}</strong> trip. You'll get the precise amount by email and in your Console — approve it there to pay securely. Reference <strong>${esc(d.request.id)}</strong>.</p>
      <button class="btn btn-gold" style="margin-top:12px" onclick="closeModal();nav('console')">Go to my Console</button></div>`);
  } catch (e) { toast(e.message || 'Could not send your request — please try again.'); }
};

// The ADDITIONAL passengers (everyone after the lead) whose names Duffel needs
// to ticket a group/family flight. Order matches the fare-unit order the search
// used (adults first, then children by age) so the backend maps names 1:1.
function additionalPassengerList(t) {
  const party = t || { adults: 1, total: 1 };
  const adults = Math.max(1, party.adults || 1);
  const childAges = Array.isArray(party.childAges) ? party.childAges : [];
  const children = party.children || childAges.length || 0;
  const out = [];
  for (let i = 2; i <= adults; i++) out.push({ type: 'adult', label: `Adult ${i}` });
  childAges.forEach((age, idx) => out.push({ type: 'child', label: `Child ${idx + 1} (age ${age})`, age }));
  for (let i = childAges.length; i < children; i++) out.push({ type: 'child', label: `Child ${i + 1}` });
  return out;
}

window.openBooking = async (tier) => {
  const option = window.__options[tier];
  const intent = window.__intent;
  const international = state.lastPlan?.international !== false;
  let data, reqs;
  try {
    data = await api('/api/quote', { method: 'POST', body: JSON.stringify({ option, intent, months: 3, depositPct: 0.2 }) });
    reqs = await api('/api/booking/requirements', { method: 'POST', body: JSON.stringify({
      components: option.components.map((c) => c.category || c.type),
      destination: intent.destination.city, nationality: state.country || 'GB',
      passengers: intent.travellers.total, international,
    }) });
  } catch { return; }
  state.lastQuote = data.quote;
  state.lastReqs = reqs;
  metaTrack('InitiateCheckout', { value: option.pricing.local.total, currency: option.pricing.currency || 'GBP', content_name: `${tier} · ${intent.destination?.city || ''}` });
  const inst = data.quote.instalment;
  const sym = option.pricing.symbol;

  const rows = inst.schedule.map((s, i) => `<div class="kv"><span>Instalment ${i + 1} · due ${s.due}${s.final ? ' <span class="muted" style="font-size:11px">(final — 7 days before departure)</span>' : ''}</span><span>${money2(s.amount, sym)}</span></div>`).join('');
  // AI Smart Instalment plan header: which plan, why, and the protection rules
  // the customer is agreeing to — stated before they pay, not in small print.
  const smart = inst.engine === 'ai-smart' ? `
    <div class="card pad" style="margin:10px 0;border-color:rgba(216,180,106,0.35)">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;align-items:baseline">
        <strong>🤖 ${esc(inst.plan)}</strong>
        <span class="muted" style="font-size:11.5px">${inst.daysToDeparture} days to departure · AI-selected</span></div>
      <div class="muted" style="font-size:12px;margin-top:6px">
        Deposit <strong>${(inst.depositPct * 100).toFixed(0)}%</strong> today (<strong style="color:var(--gold)">non-refundable</strong> — it secures your booking and locks the fare) ·
        ${inst.schedule.length ? `${inst.schedule.length} interest-free instalment${inst.schedule.length > 1 ? 's' : ''}, fully settled by <strong>${esc(inst.finalDue)}</strong> (7 days before departure)` : 'full payment at booking — instalments are not available this close to departure'} ·
        pay any amount early, any time, no penalty.
      </div>
      <div class="muted" style="font-size:11px;margin-top:4px">Missed instalment → ${inst.graceHours}h grace period, then the booking auto-cancels and the deposit is forfeited; any balance beyond the deposit follows the supplier refund policy.</div>
      ${inst.risk?.requireIdCheck ? '<div style="font-size:11.5px;margin-top:4px;color:var(--gold)">🪪 Additional identity verification is required before this plan activates.</div>' : ''}
    </div>` : '';
  const docList = reqs.documents.map((d) => `<li><span class="cs">${esc(d)}</span></li>`).join('');
  const entry = reqs.entryRules.map((r) => `<div class="kv"><span><span class="vstatus ${r.required ? 'watch' : 'pass'}"></span>${esc(r.type)}</span><span class="muted" style="font-size:12px;max-width:55%;text-align:right">${esc(r.note)}</span></div>`).join('');
  modal(`
    <span class="eyebrow">${esc(tier)} package · ${esc(intent.destination.city)}</span>
    <h3 style="margin:6px 0 4px">${money2(option.pricing.local.total, sym)} total</h3>
    ${smart || `<p class="muted" style="font-size:13.5px">Deposit ${(inst.depositPct * 100).toFixed(0)}% today, then ${inst.months} interest-free instalments.</p>`}
    <div class="field" style="margin:10px 0 4px">
      <label>How would you like to pay?</label>
      <select id="payChoice" class="in" onchange="togglePayChoice()">
        <option value="deposit">Deposit now + interest-free instalments</option>
        <option value="full">Pay in full now (${money2(option.pricing.local.total, sym)})</option>
      </select>
    </div>
    <div id="depositSchedule">
      <div class="kv" style="font-weight:700"><span>Deposit today ${inst.engine === 'ai-smart' ? '<span class="muted" style="font-size:11px">(non-refundable)</span>' : ''}</span><span style="color:var(--gold)">${money2(inst.deposit, sym)}</span></div>
      ${rows}
    </div>
    <div id="fullSchedule" style="display:none">
      <div class="kv" style="font-weight:700"><span>Pay in full today</span><span style="color:var(--gold)">${money2(option.pricing.local.total, sym)}</span></div>
      <div class="muted" style="font-size:11.5px;margin-top:4px">One payment — your booking is settled in full, nothing more to pay.</div>
    </div>

    <div style="margin-top:16px"><span class="eyebrow">Lead traveller${international ? ' (exact passport spelling)' : ''}</span></div>
    <div class="composer-row" style="margin-top:6px">
      <div class="field"><label>Full legal name</label><input class="in" id="bkName" placeholder="${international ? 'As on passport' : 'As on photo ID'}" value="${esc((state.user?.travelProfile?.fullLegalName) || state.user?.name || '')}"></div>
      <div class="field"><label>Date of birth</label><input class="in" id="bkDob" type="date" value="${esc(state.user?.travelProfile?.dob || '')}"></div>
      ${international ? `
      <div class="field"><label>Nationality</label><input class="in" id="bkNat" value="${esc(state.user?.travelProfile?.nationality || state.country || 'GB')}" style="width:90px"></div>
      <div class="field"><label>Passport number</label><input class="in" id="bkPass" placeholder="e.g. A1234567" value="${esc(state.user?.travelProfile?.passportNumber || '')}"></div>
      <div class="field"><label>Passport expiry</label><input class="in" id="bkExp" type="date" value="${esc(state.user?.travelProfile?.passportExpiry || '')}"></div>
      ` : '<div class="field"><label>Photo ID number (optional)</label><input class="in" id="bkIdNum" placeholder="Driving licence / national ID" value=""></div>'}
    </div>
    ${international ? '' : '<div class="muted" style="font-size:11.5px;margin-top:4px">🚆 Local trip — no passport or visa required, just photo ID to travel.</div>'}
    ${Object.keys(state.user?.travelProfile || {}).length ? '<div class="muted" style="font-size:11px;margin-top:4px">✓ auto-filled from your Master Travel Profile</div>' : ''}
    ${(() => {
      const extra = additionalPassengerList(intent.travellers);
      if (!extra.length) return '';
      return `<div style="margin-top:14px"><span class="eyebrow">Other passengers${international ? ' (exact passport spelling)' : ''}</span>
        <p class="muted" style="font-size:11.5px;margin:2px 0 6px">Every traveller must be named to ticket the flight — enter each one exactly as on their ${international ? 'passport' : 'photo ID'}.</p>
        ${extra.map((p, n) => `<div class="card pad" style="margin-bottom:8px">
          <div class="t-label" style="margin-bottom:6px">${esc(p.label)}</div>
          <div class="composer-row">
            <div class="field"><label>Full legal name</label><input class="in" id="bkP${n}Name" placeholder="${international ? 'As on passport' : 'As on photo ID'}"></div>
            <div class="field"><label>Date of birth</label><input class="in" id="bkP${n}Dob" type="date"${p.age != null ? ` title="child, age ${p.age}"` : ''}></div>
            ${international ? `<div class="field"><label>Passport number</label><input class="in" id="bkP${n}Pass" placeholder="e.g. A1234567"></div>
            <div class="field"><label>Passport expiry</label><input class="in" id="bkP${n}Exp" type="date"></div>` : ''}
          </div></div>`).join('')}</div>`;
    })()}

    <div style="margin-top:14px"><span class="eyebrow">Documents needed</span><ul class="comp-list">${docList}</ul></div>
    ${entry ? `<div style="margin-top:6px"><span class="eyebrow">Entry requirements</span>${entry}</div>` : ''}

    <div style="margin-top:14px"><span class="eyebrow">Special requests (SSR)</span>
      <div class="chips" style="margin-top:6px" id="bkSSR">
        ${['Wheelchair', 'Infant', 'Bassinet', 'Blind passenger', 'Deaf passenger', 'Unaccompanied minor', 'Pregnant traveller', 'Medical oxygen', 'Extra seat', 'Pet in cabin', 'Pet in hold', 'Religious meal', 'Vegan meal', 'Halal meal', 'Kosher meal', 'Diabetic meal', 'Nut allergy'].map((o) => `<span class="chip" style="cursor:pointer" data-ssr="${o}" onclick="this.classList.toggle('chip-on');this.style.borderColor=this.classList.contains('chip-on')?'var(--gold)':'';this.style.color=this.classList.contains('chip-on')?'var(--gold)':''">${o}</span>`).join('')}
      </div>
      <div class="muted" style="font-size:11px;margin-top:4px">Sent to the airline / operator with your booking (SSR codes).</div>
    </div>
    ${(state.lastQuote?.option?.components || []).some((c) => c.type === 'hotel' || c.type === 'host') ? `
    <div style="margin-top:12px"><span class="eyebrow">Hotel special requests</span>
      <div class="chips" style="margin-top:6px" id="bkHotelSSR">
        ${['Early check-in', 'Late check-out', 'Airport transfer', 'Accessible room', 'Baby cot', 'Connecting rooms', 'Honeymoon setup', 'Anniversary setup', 'Birthday package', 'High floor', 'Low floor', 'Quiet room'].map((o) => `<span class="chip" style="cursor:pointer" data-ssr="${o}" onclick="this.classList.toggle('chip-on');this.style.borderColor=this.classList.contains('chip-on')?'var(--gold)':'';this.style.color=this.classList.contains('chip-on')?'var(--gold)':''">${o}</span>`).join('')}
      </div>
      <div class="muted" style="font-size:11px;margin-top:4px">Passed to the property with your reservation (subject to availability).</div>
    </div>` : ''}

    <div class="field" style="margin-top:14px">
      <label>Payment method</label>
      <select id="payMethod" class="in">
        <option value="card">💳 Card (Visa / Mastercard) — via Stripe</option>
        <option value="bitripay" disabled>🅱 BitriPay Wallet — coming soon</option>
        <option value="mpesa" disabled>📱 M-Pesa — coming soon via BitriPay</option>
        <option value="airtel" disabled>📱 Airtel Money — coming soon via BitriPay</option>
        <option value="orange" disabled>📱 Orange Money — coming soon via BitriPay</option>
        <option value="africell" disabled>📱 Africell Money — coming soon via BitriPay</option>
      </select>
      <div class="muted" style="font-size:11px;margin-top:4px">All payments run on Stripe today. BitriPay Wallet &amp; mobile money unlock automatically the day BitriPay launches.</div>
    </div>
    <div class="card pad" style="margin-top:12px;border-color:rgba(216,180,106,0.35)">
      <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer">
        <input type="checkbox" id="bkProtection" style="margin-top:3px" />
        <div><strong>🛡 Booking Protection</strong> <span class="muted" style="font-size:12px">· priority price-drop rebooking, mistake check, refund guidance, disruption support, document review, visa alerts</span>
        <div class="muted" style="font-size:11.5px;margin-top:2px">£5–£50 by trip value — added to your deposit.</div></div>
      </label>
    </div>
    <div id="payDetails" style="margin-top:8px">
      <div class="composer-row">
        <div class="field"><label>Card / account holder</label><input class="in" id="payHolder" value="${esc(state.user?.travelProfile?.fullLegalName || state.user?.name || '')}"></div>
        <div class="field"><label>Billing address</label><input class="in" id="payBilling" value="${esc(state.user?.travelProfile?.billingAddress || state.user?.travelProfile?.residentialAddress || '')}"></div>
      </div>
      <div class="muted" style="font-size:11px">Card numbers are entered on the secure payment page — never stored by 3JN (PCI SAQ-A).</div>
    </div>
    <div id="bkValidate"></div>
    <button class="btn btn-gold btn-block" id="bkConfirmBtn" style="margin-top:16px" onclick="confirmBooking()">Validate, pay deposit &amp; confirm</button>`);
};
// Toggle the deposit schedule vs full-payment view + the confirm button label.
window.togglePayChoice = () => {
  const full = $('#payChoice')?.value === 'full';
  const dep = $('#depositSchedule'); const fl = $('#fullSchedule'); const btn = $('#bkConfirmBtn');
  if (dep) dep.style.display = full ? 'none' : '';
  if (fl) fl.style.display = full ? '' : 'none';
  if (btn) btn.innerHTML = full ? 'Validate, pay in full &amp; confirm' : 'Validate, pay deposit &amp; confirm';
};

window.confirmBooking = async () => {
  if (!state.lastQuote) return;
  const intent = window.__intent;
  const international = state.lastPlan?.international !== false;
  const lead = {
    fullName: $('#bkName')?.value.trim(), dob: $('#bkDob')?.value,
    nationality: ($('#bkNat')?.value || state.country || 'GB').trim().toUpperCase(),
  };
  lead.type = 'adult';
  if (international) {
    lead.passportNumber = $('#bkPass')?.value.trim();
    lead.passportExpiry = $('#bkExp')?.value;
  } else if ($('#bkIdNum')?.value) {
    lead.idNumber = $('#bkIdNum').value.trim();
  }
  // Collect EVERY passenger — Duffel needs each real name to ticket a group/
  // family flight (the lead alone used to be sent, so 2+ pax orders would fail).
  const extra = additionalPassengerList(intent?.travellers);
  const others = extra.map((p, n) => {
    const t = { fullName: $(`#bkP${n}Name`)?.value.trim() || '', dob: $(`#bkP${n}Dob`)?.value || '', type: p.type, nationality: lead.nationality };
    if (international) { t.passportNumber = $(`#bkP${n}Pass`)?.value.trim() || ''; t.passportExpiry = $(`#bkP${n}Exp`)?.value || ''; }
    return t;
  });
  const travellers = [lead, ...others];
  // Every passenger must be named before we can ticket.
  const unnamed = travellers.findIndex((t) => !t.fullName);
  if (unnamed >= 0) { toast(`Enter the full name for ${unnamed === 0 ? 'the lead traveller' : (extra[unnamed - 1]?.label || 'each passenger')}.`); return; }
  const specialRequests = [...document.querySelectorAll('#bkSSR .chip-on')].map((c) => c.dataset.ssr);
  const hotelRequests = [...document.querySelectorAll('#bkHotelSSR .chip-on')].map((c) => c.dataset.ssr);
  const payment = { cardHolder: $('#payHolder')?.value.trim() || '', billingAddress: $('#payBilling')?.value.trim() || '' };
  // Validate traveller + documents (+ entry rules for international) BEFORE pay.
  const vbox = $('#bkValidate');
  if (vbox) vbox.innerHTML = `<div class="muted" style="font-size:12.5px;margin-top:10px"><span class="loader"></span> Validating ${international ? 'documents & entry rules' : 'traveller details'}…</div>`;
  let val;
  try {
    val = await api('/api/booking/validate', { method: 'POST', body: JSON.stringify({
      travellers, travelDate: intent?.dates?.checkIn,
      nationality: lead.nationality, destination: intent?.destination?.city, international,
    }) });
  } catch { return; }
  if (!val.valid) {
    if (vbox) vbox.innerHTML = `<div class="card pad" style="margin-top:10px;border-color:rgba(255,90,90,0.4)">
      <strong style="color:#ff8a8a">Can't book yet</strong>
      ${val.blocking.map((b) => `<div class="x-line">✕ ${esc(b)}</div>`).join('')}
    </div>`;
    return;
  }
  if (val.risk && val.risk.decision === 'reject') {
    if (vbox) vbox.innerHTML = `<div class="card pad" style="margin-top:10px;border-color:rgba(255,90,90,0.4)"><strong style="color:#ff8a8a">Payment held for review (risk ${val.risk.score}).</strong></div>`;
    return;
  }

  const paymentMethod = $('#payMethod')?.value || 'card';
  if (!state.user) {
    const u = await api('/api/account', { method: 'POST', body: JSON.stringify({ name: lead.fullName || 'Guest Traveller', humanCheck: humanCheckPayload(false) }) });
    setUser(u.user);
  }
  const payInFull = $('#payChoice')?.value === 'full';
  let data;
  try {
    // Send the option INLINE as well as the quoteId — on serverless the quote may
    // have been saved on another instance, so this lets /api/book proceed without
    // a "quote not found" (payment integrity is still enforced at checkout).
    data = await api('/api/book', { method: 'POST', body: JSON.stringify({ specialRequests, hotelRequests, payment, protection: !!$('#bkProtection')?.checked, quoteId: state.lastQuote.id, option: state.lastQuote.option, intent: window.__intent, months: 3, depositPct: 0.2, paymentMethod, lead, travellers }) });
  } catch { return; }
  if (data.user) setUser(data.user);
  closeModal();
  // LIVE CARD CHECKOUT: when Stripe is configured, card payments redirect to
  // the hosted Checkout page for the real deposit charge; the webhook then
  // marks the booking paid. Without Stripe keys, the simulated flow continues.
  if (paymentMethod === 'card' && data.booking?.id) {
    try {
      const st = await api('/api/pay/stripe/status', { silent: true });
      if (st.enabled) {
        toast(payInFull ? '💳 Redirecting to pay in full…' : '💳 Redirecting to secure card checkout…');
        const sess = await api('/api/pay/stripe/session', { method: 'POST', body: JSON.stringify({ bookingId: data.booking.id, kind: payInFull ? 'full' : 'deposit' }) });
        if (sess.url) { window.location.href = sess.url; return; }
      }
    } catch (e) {
      // LIVE INVENTORY GATE: estimated quotes never take real money.
      if (/estimated/i.test(String(e?.message || ''))) {
        toast('📋 Quote saved — this is an ESTIMATED price. No payment was taken; we only charge when live bookable fares are connected.');
        nav('console');
        return;
      }
      /* other errors fall through to the recorded flow */
    }
  }
  if (data.booking?.priceBasis === 'estimated') {
    toast('📋 Quote reserved at an estimated price — no real payment taken. Final price is confirmed with live suppliers before any charge.');
    nav('console');
    return;
  }
  const rail = paymentMethod === 'card' ? 'Stripe' : paymentMethod === 'bitripay' ? 'BitriPay Wallet' : 'BitriPay Mobile Money';
  toast(`✓ Documents validated · booking confirmed — deposit paid via ${rail}.`);
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
  try { data = await api(`/api/account/${state.user.id}`, { silent: true }); }
  catch (e) {
    if (e.status === 404) { try { localStorage.removeItem('3jn_uid'); } catch {} state.user = null; renderConsole(); }
    return;
  }
  const u = data.user;
  const bookings = data.bookings || [];
  let quoteReqs = [];
  try { quoteReqs = (await api('/api/quote-requests', { silent: true })).requests || []; } catch { /* optional */ }

  const profile = `
    <div class="card pad">
      <div class="cover-banner" style="${/^data:image\//.test(u.coverImage || '') ? `background-image:url('${encodeURI(u.coverImage)}')` : ''}"></div>
      <div style="display:flex;align-items:center;gap:12px;margin-top:14px">
        ${avatarHTML(u, 52)}
        <div><h3 style="margin:0">${esc(u.name)}</h3><div class="muted" style="font-size:12.5px">${esc(u.email)}</div>
        <span class="role-badge">${esc(u.role)}</span>${u.allAccess ? '<span class="role-badge" style="color:var(--green);border-color:rgba(70,211,154,0.4);background:rgba(70,211,154,0.08)">★ all access</span>' : ''}</div>
      </div>
      ${u.bio ? `<p class="muted" style="font-size:13px;margin:12px 0 0">${esc(u.bio)}</p>` : ''}
      <div class="kv" style="margin-top:12px"><span>Tier</span><span style="color:var(--gold)">${u.tier} (${(u.tierDiscount * 100).toFixed(0)}% off)</span></div>
      <div class="kv"><span>Loyalty points</span><span>${u.points.toLocaleString()}</span></div>
      <div class="kv"><span>ACU balance</span><span>${u.acuBalance.toLocaleString()} ACU</span></div>
      ${u.membership?.active
        ? `<div class="kv"><span>Membership</span><span style="color:var(--green)">${u.membership.name}</span></div>
           <div class="kv"><span>Auto-funds</span><span>${u.membership.acuPerMonth.toLocaleString()} ACU/mo (10%)</span></div>
           <div class="kv"><span>Renews</span><span>${new Date(u.membership.renewsAt).toLocaleDateString()}</span></div>`
        : `<div class="kv"><span>Membership</span><span class="muted">None — join to auto-fund ACUs</span></div>`}
      <div class="kv"><span>Referral code</span><span>${u.referralCode}</span></div>
      <div class="kv"><span>Referrals</span><span>${u.referrals}</span></div>
      <button class="btn btn-gold btn-sm btn-block" style="margin-top:12px" onclick="editProfile()">✎ Edit profile &amp; picture</button>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn btn-ghost btn-sm" style="flex:1" onclick="buyAcuFlow()">Top up ACUs</button>
        ${u.membership?.active
          ? '<button class="btn btn-ghost btn-sm" style="flex:1" onclick="renewMembership()">Renew (+ACU)</button>'
          : '<button class="btn btn-ghost btn-sm" style="flex:1" data-nav="membership">Join a plan</button>'}
      </div>
    </div>
    ${loyaltyHub(u)}
    <div class="card pad" style="margin-top:16px" id="travelProfileCard"></div>
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

  const quoteCards = quoteReqs.length ? `<div class="card pad" style="margin-bottom:16px"><span class="eyebrow">Exact-quote requests</span>${quoteReqs.map((q) => {
    const badge = q.status === 'paid' ? '<span class="tag-confirmed">✓ paid & booked</span>'
      : q.status === 'priced' ? '<span class="chip" style="border-color:rgba(121,217,155,.4);color:#79d99b">exact price ready</span>'
      : '<span class="chip" style="border-color:rgba(216,180,106,.4);color:var(--gold)">confirming price…</span>';
    const priceLine = q.confirmedTotalLocal ? `<strong style="color:var(--gold)">${q.symbol}${q.confirmedTotalLocal}</strong> confirmed` : `est ${q.symbol}${q.estimatedTotalLocal}`;
    const payBtn = q.status === 'priced' ? `<button class="btn btn-gold btn-sm" style="margin-top:8px" onclick="payExactQuote('${q.id}')">Pay ${q.symbol}${q.confirmedTotalLocal} & book</button>` : '';
    return `<div style="padding:10px 0;border-bottom:1px solid rgba(223,229,238,.07)">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px"><span><strong>${esc(q.tier)}</strong> · ${esc(q.destination)}</span>${badge}</div>
      <div class="muted" style="font-size:12.5px;margin-top:2px">${priceLine} · ref ${esc(q.id)}</div>${payBtn}</div>`;
  }).join('')}</div>` : '';
  const cards = quoteCards + (bookings.length ? bookings.map((b) => bookingCard(b)).join('') :
    `<div class="card pad center muted">No bookings yet. <button class="btn btn-ghost btn-sm" data-nav="planner">Plan a trip</button></div>`);

  // ROLE IDENTITY BANNER — every account opens knowing exactly what it is,
  // what it controls, and where its primary tools are. No two roles look alike.
  const ROLE_BANNERS = {
    merchant: { icon: '💳', title: 'BitriPay Merchant Portal', sub: 'You move money: create payment links & QR invoices, track every settlement to the penny. Your portal is directly below.', actions: [['Create payment link', "document.getElementById('merchantPortal')?.scrollIntoView({behavior:'smooth'})"]] },
    partner: { icon: '🤝', title: 'Agency Partner Command', sub: 'You resell the OS white-label: production API keys, per-booking revenue share, your own customers. Keys & settlement below.', actions: [['My API keys', "document.getElementById('merchantPortal')?.scrollIntoView({behavior:'smooth'})"], ['Vendor Programme', "nav('vendors')"]] },
    embassy: { icon: '🏛', title: 'Embassy Decision Command', sub: 'You hold full visa decision authority — criteria, fees, branding, releases. This traveller console is secondary for you.', actions: [['Open Decision Command Centre', "nav('visaos')"]] },
    consulate: { icon: '🛂', title: 'Consulate eVisa Command', sub: 'Your eVisa processing queue, decisions and audit chain live in VisaOS.', actions: [['Open eVisa queue', "nav('visaos')"]] },
    business: { icon: '🏢', title: 'Corporate Travel Command', sub: 'Approve trips against policy, monitor duty of care, manage team bookings — your command centre is the Business view.', actions: [['Open Business Centre', "nav('business')"]] },
    admin: { icon: '🛡', title: 'Platform Administration', sub: 'All 3JN income, AI margins, user/host/vendor queues and support tickets — your command centre is the Admin view.', actions: [['Open Admin Centre', "nav('admin')"]] },
  };
  const rb = !u.allAccess && ROLE_BANNERS[u.role];
  const roleBanner = rb ? `
    <div class="card pad" style="border-color:rgba(216,180,106,.45);margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
      <div><span class="eyebrow">${rb.icon} ${esc(rb.title)}</span>
        <p class="muted" style="font-size:12.5px;margin:4px 0 0;max-width:640px">${rb.sub}</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${rb.actions.map(([label, fn]) => `<button class="btn btn-gold btn-sm" onclick="${fn}">${label}</button>`).join('')}</div>
    </div>` : '';

  out.innerHTML = `${roleBanner}<div class="console-grid"><div>${profile}</div><div>${cards}</div></div>`;
  if (u.allAccess || ['merchant', 'partner', 'admin'].includes(u.role)) renderMerchantPortal();
  renderTravelProfile();
  renderEsims();
  renderExpense();
}

// ---- Master Travel Profile — one account for visa, flight, hotel, holiday ---
// Filled once here; every module (VisaOS application, booking, etc.) auto-fills
// from it and writes new details back, so the user never re-types passport/DOB.
const TRAVEL_PROFILE_FIELDS = [
  // Identity — exact passport spelling drives every PNR.
  { key: 'title', label: 'Title', type: 'select', options: ['Mr', 'Mrs', 'Ms', 'Miss', 'Dr', 'Mx'], group: 'Identity' },
  { key: 'firstName', label: 'First name (as on passport)', group: 'Identity' },
  { key: 'middleName', label: 'Middle name(s)', group: 'Identity' },
  { key: 'lastName', label: 'Last name (as on passport)', group: 'Identity' },
  { key: 'fullLegalName', label: 'Full legal name (passport)', group: 'Identity' },
  { key: 'preferredName', label: 'Preferred name', group: 'Identity' },
  { key: 'gender', label: 'Gender', type: 'select', options: ['Female', 'Male', 'Other'], group: 'Identity' },
  { key: 'dob', label: 'Date of birth', type: 'date', group: 'Identity' },
  { key: 'placeOfBirth', label: 'Place of birth', group: 'Identity' },
  { key: 'nationality', label: 'Nationality', type: 'country', group: 'Identity' },
  { key: 'dualNationality', label: 'Dual nationality', type: 'country', group: 'Identity' },
  { key: 'maritalStatus', label: 'Marital status', type: 'select', options: ['Single', 'Married', 'Divorced', 'Widowed'], group: 'Identity' },
  // Passport, ID & immigration status
  { key: 'passportNumber', label: 'Passport number', group: 'Passport & status' },
  { key: 'passportIssue', label: 'Passport issue date', type: 'date', group: 'Passport & status' },
  { key: 'passportExpiry', label: 'Passport expiry', type: 'date', group: 'Passport & status' },
  { key: 'passportCountry', label: 'Passport issuing country', type: 'country', group: 'Passport & status' },
  { key: 'nationalId', label: 'National ID number', group: 'Passport & status' },
  { key: 'residencyStatus', label: 'Residency status', type: 'select', options: ['Citizen', 'Permanent resident', 'Temporary resident', 'Student', 'Work permit', 'Refugee', 'Other'], group: 'Passport & status' },
  { key: 'visaStatus', label: 'Visa status (current)', group: 'Passport & status' },
  { key: 'alienRegistrationNumber', label: 'Alien registration no. (where applicable)', group: 'Passport & status' },
  // Airline-required / security (APIS = the passport + DOB + gender set above)
  { key: 'frequentTravelerNumbers', label: 'Frequent traveler numbers', group: 'Airline & security' },
  { key: 'knownTravelerNumber', label: 'Known Traveler Number (KTN)', group: 'Airline & security' },
  { key: 'redressNumber', label: 'Redress number', group: 'Airline & security' },
  { key: 'tsaPreCheck', label: 'TSA PreCheck', type: 'select', options: ['Yes', 'No'], group: 'Airline & security' },
  // Contact
  { key: 'mobile', label: 'Mobile number', group: 'Contact' },
  { key: 'secondaryPhone', label: 'Secondary phone', group: 'Contact' },
  { key: 'contactEmail', label: 'Booking email (if different)', group: 'Contact' },
  { key: 'emergencyContact', label: 'Emergency contact', group: 'Contact' },
  { key: 'emergencyContactRelation', label: 'Emergency contact relation', group: 'Contact' },
  // Address
  { key: 'residentialAddress', label: 'Residential address', group: 'Address' },
  { key: 'billingAddress', label: 'Billing address', group: 'Address' },
  { key: 'countryOfResidence', label: 'Country of residence', type: 'country', group: 'Address' },
  { key: 'postalCode', label: 'Postal code', group: 'Address' },
  // NOTE: Livelihood (occupation / employer / monthly income) is collected ONLY
  // on the visa application form — it's visa-specific and not part of the general
  // travel profile.
];

// Loyalty programmes the profile can hold — number, tier, expiry & benefits
// are pulled automatically into flight/hotel bookings.
const LOYALTY_PROGRAMS = ['British Airways Executive Club', 'Emirates Skywards', 'Marriott Bonvoy', 'Hilton Honors', 'IHG One Rewards', 'Other'];
function renderTravelProfile() {
  const el = $('#travelProfileCard');
  if (!el) return;
  const tp = state.user?.travelProfile || {};
  const filled = TRAVEL_PROFILE_FIELDS.filter((f) => tp[f.key]).length;
  const fieldHTML = (f) => {
    const id = `tp_${f.key}`;
    const val = tp[f.key] != null ? String(tp[f.key]) : '';
    if (f.type === 'country') return `<div class="field"><label>${f.label}</label><select class="in" id="${id}"><option value="">— select —</option>${countryOptions(val)}</select></div>`;
    if (f.type === 'select') return `<div class="field"><label>${f.label}</label><select class="in" id="${id}"><option value="">—</option>${f.options.map((o) => `<option${o === val ? ' selected' : ''}>${o}</option>`).join('')}</select></div>`;
    return `<div class="field"><label>${f.label}</label><input class="in" id="${id}" type="${f.type || 'text'}" value="${esc(val)}"></div>`;
  };
  const groups = [...new Set(TRAVEL_PROFILE_FIELDS.map((f) => f.group))];
  const grouped = groups.map((g) => `
    <div style="margin-top:12px"><span class="eyebrow" style="font-size:10.5px">${g}</span>
    <div class="composer-row" style="margin-top:6px">${TRAVEL_PROFILE_FIELDS.filter((f) => f.group === g).map(fieldHTML).join('')}</div></div>`).join('');

  // Loyalty accounts (BA Executive Club, Emirates Skywards, Marriott Bonvoy,
  // Hilton Honors, IHG One Rewards…) — number, tier, expiry, benefits.
  const accounts = Array.isArray(tp.loyaltyAccounts) ? tp.loyaltyAccounts : [];
  const loyaltyRow = (a, i) => `
    <div class="composer-row" style="margin-top:6px" data-loyalty-row="${i}">
      <div class="field"><label>Programme</label><select class="in" id="ly_prog_${i}">${LOYALTY_PROGRAMS.map((o) => `<option${o === (a.program || '') ? ' selected' : ''}>${o}</option>`).join('')}</select></div>
      <div class="field"><label>Membership number</label><input class="in" id="ly_num_${i}" value="${esc(a.membershipNumber || '')}"></div>
      <div class="field"><label>Tier</label><input class="in" id="ly_tier_${i}" value="${esc(a.tier || '')}" placeholder="e.g. Gold"></div>
      <div class="field"><label>Expiry</label><input class="in" id="ly_exp_${i}" type="date" value="${esc(a.expiry || '')}"></div>
      <div class="field"><label>Status benefits</label><input class="in" id="ly_ben_${i}" value="${esc(a.statusBenefits || '')}" placeholder="e.g. Lounge access, extra bag"></div>
    </div>`;
  const loyaltyHTML = `
    <div style="margin-top:14px"><span class="eyebrow" style="font-size:10.5px">Loyalty accounts</span>
      <div id="loyaltyRows">${accounts.map(loyaltyRow).join('') || '<p class="muted" style="font-size:12px;margin:6px 0 0">No programmes yet — add BA Executive Club, Emirates Skywards, Marriott Bonvoy, Hilton Honors, IHG One Rewards…</p>'}</div>
      <button class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="addLoyaltyRow()">+ Add loyalty programme</button>
    </div>`;

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
      <span class="eyebrow" style="margin:0">🪪 Master Travel Profile · Global Customer ID</span>
      <span class="muted" style="font-size:12px"><span id="tpCount">${filled}</span>/${TRAVEL_PROFILE_FIELDS.length} complete · <span id="tpSaveStatus" style="color:var(--green)">autosaves as you type</span></span>
    </div>
    ${grouped}
    ${loyaltyHTML}
    <button class="btn btn-gold btn-sm btn-block" style="margin-top:12px" onclick="saveTravelProfile()">Save travel profile</button>
    <p class="muted" style="font-size:11px;margin-top:6px">Every field autosaves moments after you stop typing and is shared instantly with every module that needs it — bookings, visa applications, payments, e-tickets, the Assistant. You never re-type your passport.</p>`;
  el.dataset.loyaltyCount = String(accounts.length);
  // AUTOSAVE: one delegated listener; debounced so it fires moments after the
  // user stops typing. Silent persists never re-render (that would steal the
  // cursor) — they update the status chip and completeness counter in place.
  el.oninput = el.onchange = () => {
    const st = $('#tpSaveStatus'); if (st) { st.textContent = 'saving…'; st.style.color = 'var(--gold)'; }
    clearTimeout(window.__tpAutosave);
    window.__tpAutosave = setTimeout(() => persistTravelProfile(true), 900);
  };
}
window.addLoyaltyRow = () => {
  const el = $('#travelProfileCard');
  const rows = $('#loyaltyRows');
  if (!el || !rows) return;
  const i = Number(el.dataset.loyaltyCount || 0);
  if (i >= 10) { toast('Maximum 10 loyalty programmes.'); return; }
  if (i === 0) rows.innerHTML = '';
  rows.insertAdjacentHTML('beforeend', `
    <div class="composer-row" style="margin-top:6px" data-loyalty-row="${i}">
      <div class="field"><label>Programme</label><select class="in" id="ly_prog_${i}">${LOYALTY_PROGRAMS.map((o) => `<option>${o}</option>`).join('')}</select></div>
      <div class="field"><label>Membership number</label><input class="in" id="ly_num_${i}"></div>
      <div class="field"><label>Tier</label><input class="in" id="ly_tier_${i}" placeholder="e.g. Gold"></div>
      <div class="field"><label>Expiry</label><input class="in" id="ly_exp_${i}" type="date"></div>
      <div class="field"><label>Status benefits</label><input class="in" id="ly_ben_${i}" placeholder="e.g. Lounge access"></div>
    </div>`);
  el.dataset.loyaltyCount = String(i + 1);
};
function collectTravelProfile() {
  const tp = {};
  TRAVEL_PROFILE_FIELDS.forEach((f) => { const el = $(`#tp_${f.key}`); if (el && el.value.trim()) tp[f.key] = f.type === 'number' ? Number(el.value) : el.value.trim(); });
  // Loyalty programme rows → structured accounts.
  const count = Number($('#travelProfileCard')?.dataset.loyaltyCount || 0);
  const loyaltyAccounts = [];
  for (let i = 0; i < count; i++) {
    const num = $(`#ly_num_${i}`)?.value.trim();
    if (!num) continue;
    loyaltyAccounts.push({
      program: $(`#ly_prog_${i}`)?.value || 'Other',
      membershipNumber: num,
      tier: $(`#ly_tier_${i}`)?.value.trim() || '',
      expiry: $(`#ly_exp_${i}`)?.value || '',
      statusBenefits: $(`#ly_ben_${i}`)?.value.trim() || '',
    });
  }
  if (loyaltyAccounts.length) tp.loyaltyAccounts = loyaltyAccounts;
  return tp;
}
// Persist the profile. silent=true → autosave path: update state + the status
// chip and counter IN PLACE, never re-render (a re-render steals the cursor
// mid-typing). The saved profile is instantly live everywhere: bookings, visa
// applications, payments, documents and the Assistant all read state.user.
async function persistTravelProfile(silent = false) {
  if (!state.user) return;
  const tp = collectTravelProfile();
  const st = $('#tpSaveStatus');
  let data;
  try { data = await api(`/api/account/${state.user.id}`, { method: 'PATCH', body: JSON.stringify({ travelProfile: tp }) }); }
  catch { if (st) { st.textContent = 'offline — retrying on next change'; st.style.color = '#ff8a8a'; } return; }
  setUser(data.user);
  const cnt = $('#tpCount'); if (cnt) cnt.textContent = String(TRAVEL_PROFILE_FIELDS.filter((f) => tp[f.key]).length);
  if (st) { st.textContent = '✓ saved · shared across the OS'; st.style.color = 'var(--green)'; }
  if (!silent) {
    toast('✓ Travel profile saved — it now auto-fills your visa & bookings.');
    renderTravelProfile();
  }
}
window.saveTravelProfile = () => persistTravelProfile(false);

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

// ---- Travel Intelligence (Visa + Risk) — works for ANY city worldwide ------
async function runIntel(dest, outEl) {
  if (!dest) { toast('Enter a destination.'); return; }
  const nat = state.country || 'GB';
  outEl.innerHTML = '<div class="muted" style="font-size:13px;margin-top:10px"><span class="loader"></span> Checking global intelligence…</div>';
  let visa, risk;
  try {
    visa = await api(`/api/visa/check?nationality=${nat}&destination=${encodeURIComponent(dest)}`);
    risk = await api(`/api/risk/${encodeURIComponent(dest)}`);
  } catch { return; }
  if (!visa.ok) { outEl.innerHTML = '<div class="muted" style="font-size:13px;margin-top:10px">Enter a city or country name.</div>'; return; }
  const city = visa.destination.city;
  const est = visa.estimated || risk.estimated;
  const checklist = visa.checklist.map((c) => `<li><span class="cs">${esc(c)}</span></li>`).join('');
  const layers = (risk.ok ? risk.layers : []).map((l) => `<span class="chip">${esc(l.layer)}: ${esc(l.note)}</span>`).join('');
  outEl.innerHTML = `
    <div style="margin-top:14px">
      ${est ? '<div class="muted" style="font-size:11.5px;margin-bottom:8px">⚡ Estimated profile for this destination — confirm details on the official portal.</div>' : ''}
      <div class="kv"><span>🛂 Visa (${esc(visa.nationality)} → ${esc(city)})</span><span>${visa.required ? `Required · $${visa.costUSD} · ${visa.processingDays}d` : '<span style="color:var(--green)">Not required</span>'}</span></div>
      ${visa.required ? `<div class="muted" style="font-size:12px;margin:4px 0">${esc(visa.visaType)}</div><ul class="comp-list">${checklist}</ul>` : ''}
      <div class="muted" style="font-size:12.5px;margin:6px 0 12px">${esc(visa.recommendation)}</div>
      ${risk.ok ? `<div class="kv"><span>🛡 Travel Risk Score · ${esc(city)}</span><span style="color:var(--green)">${risk.riskScore} · ${esc(risk.level)}</span></div><div class="chips" style="margin-top:8px">${layers}</div>` : ''}
      <button class="btn btn-ghost btn-sm" style="margin-top:12px" onclick="planDest('${esc(city).replace(/'/g, '')}')">Build a trip to ${esc(city)} →</button>
    </div>`;
}
window.checkIntel = () => runIntel($('#intelDest').value.trim(), $('#intelOut'));
window.checkIntelHome = () => runIntel($('#intelDestHome').value.trim(), $('#intelOutHome'));
window.quickIntel = (city) => { const i = $('#intelDestHome'); if (i) i.value = city; runIntel(city, $('#intelOutHome')); };

// Render an avatar — emoji or uploaded image data URL.
function avatarHTML(u, size = 32) {
  // Only a data:image avatar may become an <img src>; anything else is treated
  // as text (emoji) and escaped, so an avatar string can never inject markup.
  const isImg = /^data:image\//.test(u.avatar || '');
  if (isImg) return `<img class="avatar" src="${encodeURI(u.avatar)}" style="width:${size}px;height:${size}px" alt="">`;
  return `<span class="avatar avatar-emoji" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.5)}px">${esc(u.avatar || '🧳')}</span>`;
}

// ---- Editable profile + picture -------------------------------------------
window.editProfile = () => {
  const u = state.user;
  const roleOpts = ['consumer', 'business', 'merchant', 'partner', 'embassy', 'admin']
    .map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>`).join('');
  modal(`
    <span class="eyebrow">Edit profile</span>
    <div class="cover-edit" id="coverPreview" style="background-image:${u.coverImage ? `url('${u.coverImage}')` : 'none'}">
      <label class="btn btn-ghost btn-sm" style="cursor:pointer">🖼 Cover picture<input type="file" id="coverFile" accept="image/*" style="display:none"></label>
    </div>
    <div style="display:flex;align-items:center;gap:14px;margin:10px 0">
      <span id="avatarPreview">${avatarHTML(u, 64)}</span>
      <div>
        <label class="btn btn-ghost btn-sm" style="cursor:pointer">📷 Profile photo<input type="file" id="avatarFile" accept="image/*" style="display:none"></label>
        <div class="muted" style="font-size:11px;margin-top:6px">or pick an emoji:</div>
        <div class="chips" style="margin-top:4px">${['🧳','💼','🏪','🤝','🛡️','🧑‍✈️','🌍','⭐'].map((e) => `<span class="chip" onclick="pickEmoji('${e}')">${e}</span>`).join('')}</div>
      </div>
    </div>
    <div class="field" style="margin-top:8px"><label>Name</label><input class="in" id="pfName" value="${esc(u.name || '')}"></div>
    <div class="field" style="margin-top:10px"><label>Email</label><input class="in" id="pfEmail" value="${esc(u.email || '')}"></div>
    <div class="field" style="margin-top:10px"><label>Role</label><select class="in" id="pfRole">${roleOpts}</select></div>
    <div class="field" style="margin-top:10px"><label>Bio</label><textarea class="in" id="pfBio" style="width:100%;min-height:60px">${esc(u.bio || '')}</textarea></div>
    <button class="btn btn-gold btn-block" style="margin-top:14px" onclick="saveProfile()">Save profile</button>`);
  window.__avatar = u.avatar;
  window.__cover = u.coverImage || null;
  $('#avatarFile')?.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 500000) { toast('Image too large (max ~500KB).'); return; }
    const reader = new FileReader();
    reader.onload = () => { window.__avatar = reader.result; $('#avatarPreview').innerHTML = `<img class="avatar" src="${reader.result}" style="width:64px;height:64px" alt="">`; };
    reader.readAsDataURL(f);
  });
  $('#coverFile')?.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 800000) { toast('Cover too large (max ~800KB).'); return; }
    const reader = new FileReader();
    reader.onload = () => { window.__cover = reader.result; $('#coverPreview').style.backgroundImage = `url('${reader.result}')`; };
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
    coverImage: window.__cover || '',
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
    <span class="eyebrow">BitriPay · Payment Links &amp; Settlement <span class="ch-chip" style="color:var(--gold);border-color:rgba(216,180,106,0.4)">SANDBOX — launching soon</span></span>
    <div class="muted" style="font-size:11.5px;margin:4px 0 6px">BitriPay is completing certification. Live customer payments run on <strong>Stripe</strong> today; this portal is a sandbox preview — links here don't move real money yet.</div>
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
    <div class="kv"><span>Instalment ${i + 1} · ${s.due}${s.final ? ' <span class="muted" style="font-size:10.5px">(final)</span>' : ''}</span><span>${s.status === 'paid' ? '✓ paid' : `${money2(s.amount, sym)} <a onclick="payInstalment('${b.id}',${i},${s.amount})" style="color:var(--gold);cursor:pointer">pay now</a>`}</span></div>`).join('');
  const comps = o.components.map((c) => labelFor(c)).join(' · ');
  // AI Payment Protection: live progress tracker — % paid, outstanding, plan.
  const paidTotal = (b.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const totalLocal = o.pricing.local.total;
  const paidPct = totalLocal > 0 ? Math.min(100, Math.round((paidTotal / totalLocal) * 100)) : 0;
  const progress = b.instalment ? `
    <div style="margin:8px 0 2px">
      <div style="display:flex;justify-content:space-between;font-size:11.5px" class="muted">
        <span>${b.instalment.plan ? esc(b.instalment.plan) + ' · ' : ''}${paidPct}% paid</span>
        <span>${paidPct >= 100 ? '✓ fully settled' : `${money2(Math.max(0, totalLocal - paidTotal), sym)} remaining${b.instalment.finalDue ? ' · settled by ' + esc(b.instalment.finalDue) : ''}`}</span></div>
      <div class="rel-bar" style="margin-top:4px"><i style="width:${paidPct}%"></i></div>
    </div>` : '';
  // AI Booking Protection™: Price Locked badge + any market-rise savings the
  // Neural Price Guard recorded while the price was frozen.
  const lockSavedUSD = (b.priceGuard?.events || []).filter((e) => e.action === 'rate-locked').reduce((s, e) => Math.max(s, e.deltaUSD || 0), 0);
  const lockBadge = b.priceLock?.locked
    ? `<span class="chip" style="font-size:10px;border-color:rgba(121,217,155,.4);color:#79d99b" title="${esc(b.priceLock.guarantee || '')}">🔒 PRICE LOCKED${lockSavedUSD > 0 ? ` · saved ${money2(lockSavedUSD * (o.pricing.local.total / o.pricing.lines.totalUSD), sym)} vs market` : ''}</span>` : '';

  return `
    <div class="card booking-card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div><strong>${o.tier} package</strong> <span class="tag-confirmed">${b.status}</span> ${b.priceBasis === 'live' ? '<span class="chip" style="font-size:10px;border-color:rgba(121,217,155,.4);color:#79d99b">LIVE FARE</span>' : '<span class="chip" style="font-size:10px;border-color:rgba(216,180,106,.4);color:var(--gold)">ESTIMATED QUOTE — no payment taken</span>'} ${lockBadge}</div>
        <strong style="font-family:'Space Grotesk'">${money2(o.pricing.local.total, sym)}</strong>
      </div>
      <p class="muted" style="font-size:12.5px;margin:6px 0">${comps}</p>
      ${progress}
      <div style="margin:10px 0">${sched}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <button class="btn btn-gold btn-sm" onclick="viewEticket('${b.id}')">🎫 View e-ticket</button>
        <button class="btn btn-ghost btn-sm" onclick="runGuard('${b.id}')">▶ Run Price Guard</button>
        <button class="btn btn-ghost btn-sm" onclick="reviewFlow('${b.id}')">★ Review suppliers</button>
        <button class="btn btn-ghost btn-sm" onclick="openDocs('${b.id}')">📄 Documents</button>
      </div>
      ${pgEvents ? `<div style="margin-top:10px"><span class="eyebrow">Neural Price Guard</span>${pgEvents}</div>` : ''}
    </div>`;
}

// Open the branded 3JN e-ticket / itinerary in a new tab. Fetched with auth
// (the endpoint checks ownership), so we render the returned HTML directly.
window.viewEticket = async (bookingId) => {
  try {
    const headers = {};
    if (state.user) headers['x-user-id'] = state.user.id;
    const res = await fetch(API_BASE + `/api/book/${bookingId}/document`, { headers });
    if (!res.ok) { toast('Could not load your e-ticket — please try again.'); return; }
    const html = await res.text();
    const w = window.open('', '_blank');
    if (w) { w.document.open(); w.document.write(html); w.document.close(); }
    else { const url = URL.createObjectURL(new Blob([html], { type: 'text/html' })); window.open(url, '_blank'); }
  } catch { toast('Could not load your e-ticket — please try again.'); }
};

// ---- Rewards & Influencer Programme (partner dashboard) -------------------
async function renderRewards() {
  const out = $('#rewardsBody');
  if (!out) return;
  if (!state.user) {
    out.innerHTML = `<div class="card pad center">
      <h3 style="margin:0 0 8px">Sign in to start earning</h3>
      <p class="muted" style="max-width:520px;margin:0 auto 16px">Every trip earns Travel ACUs. Refer friends for 250 ACUs each and unlock lifetime revenue share — or join the Influencer Programme for up to 1% lifetime revenue share.</p>
      <button class="btn btn-gold" onclick="openAuth()">Sign in / Create account</button>
    </div>`;
    return;
  }
  out.innerHTML = '<div class="card pad center muted">Loading your rewards…</div>';
  let d;
  try { d = (await api('/api/rewards/me')).dashboard; } catch { out.innerHTML = '<div class="card pad center muted">Could not load your rewards. Please try again.</div>'; return; }
  const g = (n) => `£${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  const kpi = (label, val, sub) => `<div class="card pad" style="text-align:center"><div class="t-label">${label}</div><div style="font-family:'Space Grotesk';font-weight:700;font-size:24px;color:var(--gold)">${val}</div>${sub ? `<div class="muted" style="font-size:11px">${sub}</div>` : ''}</div>`;
  const tierName = { referrer: 'Referrer', rising: 'Rising Influencer', ambassador: 'Global Travel Ambassador' }[d.tier] || d.tier;
  const unlockMsg = d.revshareUnlocked
    ? `<span style="color:var(--green)">✓ Lifetime revenue share active · ${(d.revshareRate * 100).toFixed(2)}% · up to ${g(d.capPerCustomerGbp)}/customer</span>`
    : `${d.paidReferrals}/${d.unlockReferrals} paid referrals — refer ${Math.max(0, d.unlockReferrals - d.paidReferrals)} more to unlock lifetime revenue share`;
  const tools = (d.aiGrowthTools || []).map((t) => `<span class="chip" style="font-size:11px">${esc(t.label)}</span>`).join(' ');
  const wd = (d.withdrawalHistory || []).slice(0, 5).map((w) => `<div class="kv"><span>${esc((w.at || '').slice(0, 10))} · ${esc(w.method)}</span><span>${g(w.amountGbp)} · <span class="muted">${esc(w.status)}</span></span></div>`).join('') || '<div class="muted" style="font-size:12px">No withdrawals yet.</div>';

  out.innerHTML = `
    <div class="kpi-grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px">
      ${kpi('Total referrals', d.totalReferrals, `${d.activeTravellers} active travellers`)}
      ${kpi('ACUs earned', Math.round(d.totalAcuEarned).toLocaleString())}
      ${kpi('Lifetime earnings', g(d.lifetimeEarningsGbp))}
      ${kpi('Pending commission', g(d.pendingCommissionGbp))}
      ${kpi('This month', g(d.monthlyEarningsGbp))}
      ${kpi('Leaderboard', d.leaderboardRank ? `#${d.leaderboardRank}` : '—')}
    </div>

    <div class="console-grid" style="margin-top:18px">
      <div>
        <div class="card pad"><span class="eyebrow">Your referral link</span>
          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
            <input id="refLink" readonly value="${esc(d.referralLink)}" style="flex:1;min-width:200px;background:var(--navy-700);border:1px solid var(--line);border-radius:10px;padding:9px 12px;color:var(--text);font-size:13px" />
            <button class="btn btn-gold btn-sm" onclick="copyRef()">Copy</button>
          </div>
          <p class="muted" style="font-size:12px;margin-top:8px">Code <strong style="color:var(--gold)">${esc(d.referralCode)}</strong> · Share it anywhere. You earn 250 ACUs per friend who books. ${unlockMsg}</p>
        </div>

        <div class="card pad" style="margin-top:16px"><span class="eyebrow">Partner tier</span>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
            <div><strong>${esc(tierName)}</strong> <span class="muted" style="font-size:12px">· ${(d.revshareRate * 100).toFixed(2)}% revenue share</span></div>
            <span class="chip" style="font-size:11px;color:${d.standing === 'good' ? 'var(--green)' : 'var(--gold)'}">${esc(d.standing === 'good' ? 'In good standing' : d.standing)}</span>
          </div>
          ${d.tier === 'referrer' ? `
          <div style="margin-top:12px;border-top:1px solid var(--line);padding-top:12px">
            <div class="t-label">Become a creator partner</div>
            <p class="muted" style="font-size:12px;margin:4px 0 8px">5,000+ followers → Rising Influencer (0.25%). 10,000+ → Global Travel Ambassador (1%).</p>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <input id="folCount" type="number" min="0" placeholder="Total followers" style="flex:1;min-width:140px;background:var(--navy-700);border:1px solid var(--line);border-radius:10px;padding:9px 12px;color:var(--text);font-size:13px" />
              <button class="btn btn-ghost btn-sm" onclick="applyInfluencer()">Apply</button>
            </div>
          </div>` : `<p class="muted" style="font-size:12px;margin-top:8px">${d.status === 'pending' ? 'Your influencer application is under review.' : 'You’re an approved creator partner. 🎉'}</p>`}
        </div>
      </div>

      <div>
        <div class="card pad"><span class="eyebrow">Withdraw commission</span>
          <div class="kv" style="margin-top:8px"><span>Available to withdraw</span><span style="color:var(--gold)">${g(d.pendingCommissionGbp)}</span></div>
          <button class="btn btn-gold btn-block btn-sm" style="margin-top:10px" onclick="withdrawCommission(${d.pendingCommissionGbp})" ${d.pendingCommissionGbp > 0 ? '' : 'disabled'}>Request payout</button>
          <div style="margin-top:12px"><span class="eyebrow">Recent withdrawals</span>${wd}</div>
        </div>

        <div class="card pad" style="margin-top:16px"><span class="eyebrow">AI Growth Engine</span>
          <p class="muted" style="font-size:12px;margin:8px 0">Built-in tools to maximise your reach.</p>
          <div class="chips">${tools}</div>
        </div>
      </div>
    </div>`;
}
window.copyRef = () => {
  const el = $('#refLink'); if (!el) return;
  navigator.clipboard?.writeText(el.value).then(() => toast('✓ Referral link copied')).catch(() => { el.select(); document.execCommand('copy'); toast('✓ Copied'); });
};
window.applyInfluencer = async () => {
  const followers = Number($('#folCount')?.value || 0);
  if (!followers) { toast('Enter your total follower count.'); return; }
  try { await api('/api/rewards/influencer/apply', { method: 'POST', body: JSON.stringify({ followers }) }); toast('✓ Application submitted — we’ll review it shortly.'); renderRewards(); }
  catch { toast('Could not submit — please try again.'); }
};
window.withdrawCommission = async (amount) => {
  if (!(amount > 0)) return;
  try { const r = await api('/api/rewards/withdraw', { method: 'POST', body: JSON.stringify({ amountGbp: amount, method: 'bank' }) });
    if (r.ok) { toast('✓ Payout requested'); renderRewards(); } else { toast(r.error === 'insufficient-balance' ? 'Nothing available to withdraw yet.' : 'Could not request payout.'); }
  } catch { toast('Could not request payout.'); }
};

// ---- Vendor Partner Programme (vendor portal) ------------------------------
async function renderVendors() {
  const out = $('#vendorsBody');
  if (!out) return;
  let prog;
  try { prog = await api('/api/vendors/programme'); } catch { out.innerHTML = '<div class="card pad center muted">Could not load the programme. Please try again.</div>'; return; }
  const tierCards = prog.tiers.map((t) => `
    <div class="card pad">
      <span class="eyebrow">${esc(t.name)}</span>
      <div style="font-family:'Space Grotesk';font-weight:700;font-size:28px;color:var(--gold);margin:8px 0">${t.commissionPct}%<span class="muted" style="font-size:13px;font-weight:400"> of every eligible sale</span></div>
      <div class="kv"><span>Platform fee</span><span>${prog.platformFeePct}%</span></div>
      <div class="kv"><span>Platform keeps</span><span>${t.platformKeepsPct}%</span></div>
      <div class="kv"><span>Top Seller month</span><span style="color:var(--green)">${t.bonusPct}% (+1%)</span></div>
      <div class="kv"><span>£1,000 example</span><span>you earn <strong style="color:var(--gold)">£${t.example.vendorGbp}</strong></span></div>
      ${t.requiresRegistration ? `<p class="muted" style="font-size:11.5px;margin-top:8px">Requires legal registration: ${esc((t.requiredDocs || []).slice(0, 3).join(' · '))}…</p>` : '<p class="muted" style="font-size:11.5px;margin-top:8px">For individuals — no business registration needed.</p>'}
    </div>`).join('');

  let mine = null;
  if (state.user) { try { mine = (await api('/api/vendors/me')).dashboard; } catch { /* not a vendor yet */ } }

  const portal = mine ? `
    <div class="kpi-grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:22px">
      ${[['Status', mine.status], ['Rate', mine.commissionRatePct + '%' + (mine.topSellerBonusActive ? ' 🏆' : '')], ['Sales', mine.totalSales], ['Earned', '£' + mine.commissionEarnedGbp.toLocaleString()], ['Held until travel', '£' + (mine.heldUntilTravelGbp || 0).toLocaleString()], ['Ready for Friday', '£' + mine.pendingPayoutGbp.toLocaleString()]]
        .map(([l, v]) => `<div class="card pad" style="text-align:center"><div class="t-label">${l}</div><div style="font-family:'Space Grotesk';font-weight:700;font-size:22px;color:var(--gold)">${v}</div></div>`).join('')}
    </div>
    <div class="card pad" style="margin-top:14px"><span class="eyebrow">Your sell link</span>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <input readonly value="${esc(mine.sellLink)}" style="flex:1;min-width:220px;background:var(--navy-700);border:1px solid var(--line);border-radius:10px;padding:9px 12px;color:var(--text);font-size:13px" onclick="this.select()" />
        <button class="btn btn-gold btn-sm" onclick="navigator.clipboard.writeText('${esc(mine.sellLink)}').then(()=>toast('✓ Sell link copied'))">Copy</button>
      </div>
      <p class="muted" style="font-size:12px;margin-top:8px">Code <strong style="color:var(--gold)">${esc(mine.vendorCode)}</strong> · Every eligible sale through your link earns ${mine.commissionRatePct}% — paid automatically every Friday. ${mine.leaderboardRank ? `Leaderboard: #${mine.leaderboardRank}.` : ''} Top seller each month earns +1% the following month.</p>
      ${(mine.payoutHistory || []).length ? `<div style="margin-top:10px"><span class="eyebrow">Recent payouts</span>${mine.payoutHistory.map((p) => `<div class="kv"><span>${esc((p.at || '').slice(0, 10))}</span><span>£${p.amountGbp.toLocaleString()} · <span class="muted">${esc(p.status)}</span></span></div>`).join('')}</div>` : ''}
    </div>`
    : `
    <div class="card pad center" style="margin-top:22px">
      <h3 style="margin:0 0 8px">${state.user ? 'Apply to become a Vendor Partner' : 'Sign in to apply'}</h3>
      <p class="muted" style="max-width:560px;margin:0 auto 14px">Every applicant passes an AI risk review (identity, address, credibility, fraud, sanctions screening). Approved partners get the portal, weekly Friday payouts and the monthly Top Seller bonus.</p>
      ${state.user ? `
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
        <button class="btn btn-gold" onclick="applyVendorFlow('independent')">Apply as Individual (3%)</button>
        <button class="btn btn-ghost" onclick="applyVendorFlow('registered')">Apply as Registered Agent (4%)</button>
      </div>` : '<button class="btn btn-gold" onclick="openAuth()">Sign in / Create account</button>'}
    </div>`;

  // SERVICE LISTINGS + JOBS — for approved vendors who DELIVER services
  // (photographer, guide, driver, translator, restaurant). They list at their
  // own price, compete in real package searches, and earn 90% per delivered
  // job (paid the Friday after the service date).
  let servicesBlock = '';
  if (mine && mine.status === 'approved') {
    let jobs = [];
    try { jobs = (await api('/api/vendors/jobs')).jobs || []; } catch { /* none yet */ }
    const openJobs = jobs.filter((j) => j.status !== 'completed');
    const myServices = (mine.services || []).map((s) => `
      <div class="kv"><span>${esc(s.title)} <span class="muted">· ${esc(s.type)} · ${esc(s.city)} · ${esc(s.unit)}</span></span>
      <span>£${s.priceGbp} <a onclick="removeVendorSvc('${esc(s.id)}')" style="color:#ff8a8a;cursor:pointer;font-size:11px">remove</a></span></div>`).join('')
      || '<p class="muted" style="font-size:12px">No services listed yet — add your first below. It goes live in package searches for your city immediately.</p>';
    const jobCards = openJobs.map((j) => `
      <div style="padding:10px 0;border-bottom:1px solid rgba(223,229,238,.08)">
        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px"><strong>${esc(j.componentLabel)}</strong><span style="color:var(--gold)">${esc(j.symbol)}${j.sellPrice} · you earn £${(j.sellPrice * 0.9).toFixed(2)}</span></div>
        <div class="muted" style="font-size:12px;margin-top:3px">${esc(j.destination || '')}${j.serviceDate ? ' · ' + esc(j.serviceDate) : ''}${j.pax ? ' · ' + j.pax + ' pax' : ''}${j.customer?.name ? ' · ' + esc(j.customer.name) : ''}</div>
        <div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap">
          <input class="in" id="vjref-${esc(j.id)}" placeholder="Your confirmation ref for the customer" style="max-width:240px;font-size:12px">
          <button class="btn btn-gold btn-sm" onclick="confirmVendorJob('${esc(j.id)}')">✓ Confirm job</button>
        </div>
      </div>`).join('') || '<p class="muted" style="font-size:12px">No open jobs — when a customer books one of your services, it appears here and you\'re notified instantly.</p>';
    servicesBlock = `
    <div class="console-grid" style="margin-top:16px">
      <div class="card pad">
        <span class="eyebrow">💼 Jobs — customers who booked YOUR services (${openJobs.length})</span>
        <p class="muted" style="font-size:12px;margin:6px 0">Confirm each job with your reference — the customer's documents update instantly. You earn <strong>90%</strong>, released the Friday after the service date.</p>
        ${jobCards}
      </div>
      <div class="card pad">
        <span class="eyebrow">🛍 My service listings</span>
        ${myServices}
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:flex-end">
          <div class="field"><label>Type</label><select class="in" id="vsvcType" style="max-width:140px"><option value="photographer">Photographer</option><option value="guide">Local guide</option><option value="driver">Local driver</option><option value="translator">Translator</option><option value="restaurant">Restaurant</option><option value="activity">Activity / tour</option></select></div>
          <div class="field" style="flex:1;min-width:160px"><label>Title</label><input class="in" id="vsvcTitle" placeholder="e.g. Golden-hour photo shoot"></div>
          <div class="field"><label>City</label><input class="in" id="vsvcCity" placeholder="Dubai" style="max-width:120px"></div>
          <div class="field"><label>Price £</label><input class="in" id="vsvcPrice" inputmode="decimal" style="max-width:90px"></div>
          <div class="field"><label>Unit</label><input class="in" id="vsvcUnit" placeholder="per 2h shoot" style="max-width:130px"></div>
          <button class="btn btn-gold btn-sm" onclick="addVendorSvc()">+ List service</button>
        </div>
        <p class="muted" style="font-size:11px;margin-top:8px">You set the price; customers pay it inside their package. 3JN keeps a 10% platform fee — you receive 90% after delivery.</p>
      </div>
    </div>`;
  }

  out.innerHTML = `<div class="kpi-grid" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px">${tierCards}</div>
    <div class="card pad" style="margin-top:12px;border-color:rgba(216,180,106,0.3)">
      <span class="eyebrow">✈ Flights-only bookings — different maths, bigger prize</span>
      <p class="muted" style="font-size:12.5px;margin:6px 0">Flights-only baskets carry a small <strong>2%</strong> service fee (min £4.99, capped at £15) instead of 10% (that's how our flight prices beat the comparison sites). On those you earn <strong>30% of the fee</strong> — but you keep <strong>lifetime attribution</strong>: every hotel, package or extra that customer ever books afterwards pays your full ${'3–4%'} rate automatically, no code needed. Bring us a customer once, earn on everything they ever book.</p>
    </div>
    ${portal}${servicesBlock}
    <p class="center muted" style="font-size:12px;margin-top:18px">Commission is never paid on refunds, chargebacks, fraud, self-referrals or policy violations. The platform always keeps its minimum margin.</p>`;
}
window.addVendorSvc = async () => {
  const body = { type: $('#vsvcType')?.value, title: $('#vsvcTitle')?.value, city: $('#vsvcCity')?.value, priceGbp: parseFloat($('#vsvcPrice')?.value), unit: $('#vsvcUnit')?.value };
  try {
    const r = await api('/api/vendors/services', { method: 'POST', body: JSON.stringify(body) });
    if (!r.ok) { toast(r.message || 'Check the listing details.'); return; }
    toast('✓ Listed — live in package searches for ' + (body.city || 'your city') + ' now.');
    renderVendors();
  } catch { toast('Could not list the service.'); }
};
window.removeVendorSvc = async (id) => {
  try { await api(`/api/vendors/services/${id}`, { method: 'DELETE' }); toast('Removed.'); renderVendors(); } catch { toast('Could not remove.'); }
};
window.confirmVendorJob = async (id) => {
  const ref = $(`#vjref-${id}`)?.value?.trim();
  if (!ref) { toast('Enter your confirmation reference — the customer sees it in their documents.'); return; }
  try {
    const r = await api(`/api/vendors/jobs/${id}/confirm`, { method: 'POST', body: JSON.stringify({ ref }) });
    if (!r.ok) { toast(r.message || r.error || 'Could not confirm.'); return; }
    toast(`✅ Job confirmed — you earn £${r.earnings ? r.earnings.vendorGbp : ''} after the service date.`);
    renderVendors();
  } catch { toast('Could not confirm the job.'); }
};
window.applyVendorFlow = async (tier) => {
  try {
    const r = await api('/api/vendors/apply', { method: 'POST', body: JSON.stringify({ tier, identityDoc: true, addressProof: true, socialHandles: ['pending-verification'], businessHistory: tier === 'registered', documents: tier === 'registered' ? ['company-registration', 'tax-registration', 'director-id', 'bank-proof'] : [] }) });
    if (r.ok) { toast(r.profile.status === 'approved' ? '✓ Approved! Welcome to the programme.' : 'Application received — our compliance team is reviewing it.'); renderVendors(); }
    else toast('Could not submit application.');
  } catch { toast('Could not submit application.'); }
};

// ---- Document Vault -------------------------------------------------------
// Console → booking → 📄 Documents — the REAL document vault. Renders the same
// per-service confirmation cards as the printed travel document (one source of
// truth on the server), including refs, instructions and the eSIM activation code.
window.openDocs = async (bookingId) => {
  let d;
  try { d = await api(`/api/book/${bookingId}/documents`); } catch { toast('Could not load documents.'); return; }
  const cards = (d.services || []).map((s) => `
    <div class="card pad" style="margin-top:10px">
      <div style="font-weight:700;margin-bottom:6px">${s.icon} ${esc(s.label)} <span class="muted" style="font-weight:400;font-size:12px">— ${esc(s.supplier)}</span></div>
      ${s.rows.map(([k, v]) => `<div class="kv" style="align-items:flex-start"><span class="muted" style="font-size:11.5px;min-width:110px">${esc(k)}</span><span style="font-size:12.5px;text-align:right;flex:1">${v}</span></div>`).join('')}
    </div>`).join('');
  modal(`
    <span class="eyebrow">📄 Documents · ${esc(d.bookingId)}</span>
    <h3 style="margin:6px 0 2px">Your travel documents & service instructions</h3>
    <div class="kv"><span>Status</span><span>${esc(d.status)} · ${esc(d.ticketing)}</span></div>
    ${d.pnr ? `<div class="kv"><span>Airline PNR</span><span><b>${esc(d.pnr)}</b></span></div>` : ''}
    ${(d.ticketNumbers || []).length ? `<div class="kv"><span>E-ticket number(s)</span><span><b>${d.ticketNumbers.map(esc).join(', ')}</b></span></div>` : ''}
    <button class="btn btn-gold btn-block" style="margin-top:10px" onclick="closeModal();viewEticket('${esc(d.bookingId)}')">🎫 Open full e-ticket / itinerary (print or save as PDF)</button>
    ${cards || '<p class="muted" style="font-size:12.5px;margin-top:10px">No additional services on this booking.</p>'}
    <p class="muted" style="font-size:11px;margin-top:10px">Anything unclear? Ask the 💬 3JN Assistant — it reads this exact booking and can resend documents, reschedule services or connect you to a specialist.</p>`);
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
  // If you're ALREADY signed in (e.g. as admin@3jntravel.com) but not yet
  // elevated, you don't need to log in again — just prove the staff PIN right
  // here. This is the reliable path when the sign-in PIN prompt didn't appear.
  const signedIn = !!state.user;
  out.innerHTML = `<div class="card pad center" style="max-width:520px;margin:0 auto">
    <div style="font-size:34px">🔒</div>
    <h3 style="margin:10px 0 6px">${area} access required</h3>
    <p class="muted" style="font-size:14px">This area is restricted to <strong>${roles}</strong> accounts and isn't part of the public site.</p>
    ${signedIn
      ? `<p class="muted" style="font-size:13px;margin-top:10px">Signed in as <strong>${esc(state.user.email || state.user.name || '')}</strong>. If this is a staff account, unlock it with your PIN:</p>
         <button class="btn btn-gold" style="margin-top:8px" onclick="staffUnlock()">🔓 Unlock with staff PIN</button>
         <div style="margin-top:12px"><button class="btn btn-ghost btn-sm" onclick="openAuth('login')">Sign in as a different account</button></div>`
      : `<button class="btn btn-gold" style="margin-top:12px" onclick="openAuth('login')">Sign in</button>
         <button class="btn btn-ghost" style="margin-top:12px" onclick="provisionTest()">Use a full-access demo account</button>`}
  </div>`;
}
// Elevate the CURRENTLY signed-in account to admin by proving the staff PIN —
// works even if the login-time PIN prompt never appeared (cache, etc.). Only
// succeeds server-side when the account's email is on the ADMIN_EMAILS allowlist.
window.staffUnlock = async () => {
  // PRIMARY: re-run the live Firebase sign-in. It verifies a fresh token on the
  // server, rebuilds a valid session even if the stored one went stale, and
  // grants an allowlisted owner admin automatically (no PIN). This is the robust
  // path — the earlier "sign in first" error was a stale session id.
  if (window.firebaseAuth?.reauth) {
    toast('Refreshing your admin access…');
    const ok = await window.firebaseAuth.reauth();
    if (ok) return; // the firebase-auth handler sets the (now admin) user + navigates
  }
  // FALLBACK (no live Firebase session): the prototype PIN elevation.
  if (!state.user) { openAuth('login'); return; }
  const pin = window.prompt('Enter the staff access PIN:');
  if (!pin) return;
  setStaffPin(pin);
  try {
    const d = await api('/api/account/elevate', { method: 'POST', body: JSON.stringify({ staffPin: pin }) });
    setUser(d.user);
    toast(`✓ Admin unlocked — welcome, ${d.user.name}.`);
    nav('admin');
  } catch (e) { toast(e.message || 'Please sign out and sign in again, then reopen Admin.'); }
};

// ---- Admin Super Control Centre -------------------------------------------
async function renderAdmin() {
  const out = $('#adminOut');
  if (!(await ensurePrivilegedView('admin'))) { accessGate(out, 'Admin', 'admin'); return; }
  let data, auditData, sec, ops, seo, mkt;
  try {
    data = await api('/api/admin/overview'); auditData = await api('/api/admin/audit?limit=20');
    sec = (await api('/api/agents/security')).report; ops = (await api('/api/agents/ops')).report;
    seo = (await api('/api/agents/seo')).report; mkt = (await api('/api/agents/marketing')).report;
  } catch { accessGate(out, 'Admin', 'admin'); return; }
  let profit = null, uh = null;
  try { profit = await api('/api/admin/profitability'); } catch { /* optional panel */ }
  try { uh = await api('/api/admin/users-hosts'); } catch { /* optional panel */ }
  let qr = null;
  try { qr = await api('/api/admin/quote-requests'); } catch { /* optional panel */ }
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
    ['Placements £/mo', '£' + Number(o.placementRevenueMonthlyGBP || 0).toLocaleString()],
    ['Reviews', o.reviews],
    ['Referrals', o.referrals],
  ];
  const kpiCards = kpis.map(([k, v]) => `<div class="card pad kpi"><div class="kpi-v">${v}</div><div class="kpi-k">${k}</div></div>`).join('');

  const mix = (obj) => Object.entries(obj || {}).map(([k, v]) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`).join('') || '<div class="muted" style="font-size:13px">none yet</div>';

  const board = (data.leaderboard || []).length
    ? data.leaderboard.map((s) => `<div class="kv"><span>${esc(s.supplier)}</span><span>${s.avgRating}★ · ${s.reviews}</span></div>`).join('')
    : '<div class="muted" style="font-size:13px">no reviews yet</div>';

  const g = data.gateway;
  const providers = Object.entries(g.providers).map(([id, p]) =>
    `<div class="kv"><span>${p.name} <span class="muted">${p.model}</span></span><span>${p.configured ? '🟢 live' : '⚪ local'}</span></div>`).join('');

  const streams = (data.revenueStreams || []).map((s) => `<span class="chip">${s}</span>`).join('');

  const activity = (data.activity || []).length
    ? data.activity.map((e) => `<div class="ln"><span class="ok">●</span> <span style="color:var(--muted-dim)">[${e.type}]</span> ${e.detail}</div>`).join('')
    : '<div class="muted" style="font-size:13px">no activity yet — make a booking to populate the feed</div>';

  out.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
      <button class="btn btn-sm" style="background:var(--gold);color:#1a1205;font-weight:700" onclick="runSelfTest()">🚦 Launch readiness check</button>
      <button class="btn btn-ghost btn-sm" onclick="sendTestEmail()">✉️ Send test email</button>
      <button class="btn btn-ghost btn-sm" data-nav="comms">📡 Communication Architecture</button>
      <button class="btn btn-ghost btn-sm" data-nav="business">🏢 Business Command Centre</button>
      <button class="btn btn-ghost btn-sm" onclick="runBotSweep()" title="Quarantines accounts with machine-generated names AND zero activity. Any real activity = immune. Flagged accounts can be restored in one click.">🧹 Bot sweep</button>
      <button class="btn btn-ghost btn-sm" onclick="openPlacements()">💰 Sponsored placements</button>
      <button class="btn btn-ghost btn-sm" onclick="manageUser()">👤 Manage user (ACU / membership)</button>
      <button class="btn btn-sm" style="background:var(--gold);color:#1a1205;font-weight:700" onclick="openDealsManager()">🏷️ Manage deals</button>
    </div>
    <div id="selfTestOut"></div>
    <div class="kpi-grid">${kpiCards}</div>
    ${uh ? (() => {
      const risk = (v) => v?.securityRisk === 'Low' ? '#79d99b' : v?.securityRisk === 'Medium' ? 'var(--gold)' : '#ff6b6b';
      const pend = (uh.pendingReview || []).map((l) => `
        <div class="card pad" style="margin-bottom:10px;border-color:rgba(216,180,106,.35)">
          <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;align-items:baseline">
            <strong>${esc(l.title)}</strong>
            <span style="font-size:12px;color:${risk(l.aiVerification)}">AI verify ${l.aiVerification?.score ?? '—'}/100 · ${l.aiVerification?.securityRisk || '—'} risk</span>
          </div>
          <div class="muted" style="font-size:12.5px;margin-top:4px">${esc(l.hostName)} · ${esc(l.city)} · ${esc(l.address)} · $${l.nightlyUSD}/night · ${l.photos} photos</div>
          <div style="margin-top:6px">${(l.aiVerification?.checks || []).map((c) => `<span class="chip" style="font-size:10px;border-color:${c.pass ? 'rgba(121,217,155,.4)' : 'rgba(255,107,107,.5)'};color:${c.pass ? '#79d99b' : '#ff8a8a'}">${c.pass ? '✓' : '✕'} ${esc(c.check)}</span>`).join('')}</div>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button class="btn btn-gold btn-sm" onclick="reviewListing('${l.id}','approve')">✓ Approve & publish</button>
            <button class="btn btn-ghost btn-sm" onclick="reviewListing('${l.id}','reject')" style="color:#ff8a8a">✕ Reject</button>
          </div>
        </div>`).join('') || '<div class="muted" style="font-size:13px">No properties awaiting review.</div>';
      const allListings = (uh.listings || []).map((l) => `<div class="kv"><span>${esc(l.title)} <span class="muted">· ${esc(l.city)}</span></span><span style="color:${l.status === 'live' ? '#79d99b' : l.status === 'rejected' ? '#ff6b6b' : 'var(--gold)'}">${l.status}</span></div>`).join('') || '<div class="muted" style="font-size:13px">No listings.</div>';
      const userRows = (uh.users || []).slice(0, 40).map((u) => `<div class="kv"><span>${esc(u.name)} <span class="muted">· ${esc(u.email)}</span></span><span>${u.role}${u.isHost ? ' · host' : ''} · ${u.bookings} bk · ${u.acuBalance || 0} ACU${u.suspended ? ' · 🚫' : ''}</span></div>`).join('');
      // If the list is empty AND persistence is off on a serverless host, that's
      // the cause — accounts live only on the instance that created them.
      const persistWarn = (uh.serverless && uh.persistence === false)
        ? `<div class="card pad" style="border-color:rgba(255,107,107,.4);margin-bottom:10px"><strong style="color:#ff8a8a">⚠ Data persistence is OFF</strong><div class="muted" style="font-size:12.5px;margin-top:4px">This is a serverless deployment with no database configured, so each instance only sees the accounts created on it — that's why the user list looks empty or changes between refreshes. Set <strong>FIREBASE_SERVICE_ACCOUNT</strong> and <strong>FIREBASE_DATABASE_URL</strong> so every account is shared and durable.</div></div>`
        : '';
      return `${persistWarn}<div class="section-head left" style="margin:24px 0 10px"><h2 style="font-size:20px">Users & Host Property Management</h2></div>
        <div class="console-grid">
          <div class="card pad"><span class="eyebrow">Properties awaiting AI verification + review (${(uh.pendingReview || []).length})</span><div style="margin-top:10px">${pend}</div></div>
          <div>
            <div class="card pad"><span class="eyebrow">All properties (${(uh.listings || []).length})</span>${allListings}</div>
            <div class="card pad" style="margin-top:16px"><span class="eyebrow">All users (${(uh.users || []).length}) · ${(uh.hosts || []).length} hosts</span>${userRows}</div>
          </div>
        </div>`;
    })() : ''}
    ${qr && qr.requests?.length ? `<div class="section-head left" style="margin:24px 0 10px"><h2 style="font-size:20px">Exact-quote requests — confirm real bookable prices</h2></div>
      <div class="card pad">${qr.requests.map((r) => `
        <div style="padding:12px 0;border-bottom:1px solid rgba(223,229,238,.07)">
          <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px"><strong>${esc(r.tier)} · ${esc(r.destination)}</strong>
            <span class="chip" style="font-size:10px">${r.status}</span></div>
          <div class="muted" style="font-size:12.5px;margin-top:3px">${esc(r.contact.name)} &lt;${esc(r.contact.email)}&gt; ${esc(r.contact.phone || '')} · est ${r.symbol}${r.estimatedTotalLocal} · deposit intent £${r.depositIntentGBP}${r.note ? ' · “' + esc(r.note) + '”' : ''}</div>
          ${r.status === 'requested' ? `<div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap">
            <input class="in" id="qrc-${r.id}" placeholder="Exact confirmed ${r.symbol} total" style="max-width:200px" inputmode="decimal">
            <button class="btn btn-gold btn-sm" onclick="confirmQuote('${r.id}','${r.symbol}')">Confirm price → notify customer</button></div>`
            : r.confirmedTotalLocal ? `<div style="margin-top:4px;color:#79d99b;font-size:12.5px">Confirmed ${r.symbol}${r.confirmedTotalLocal}${r.status === 'paid' ? ' · PAID' : ' · awaiting customer payment'}</div>` : ''}
        </div>`).join('')}</div>` : ''}
    <div class="console-grid" style="margin-top:20px">
      <div>
        <div class="card pad"><span class="eyebrow">AI Gateway · Model Router</span><p class="muted" style="font-size:12.5px;margin:6px 0 8px">Default: ${g.defaultProvider}. Providers route by task; local fallback when no key.</p>${providers}
          ${g.costOptimization ? `<div class="kv" style="margin-top:8px"><span>AI cost saving <span class="muted">(floor ${g.costOptimization.floorPct}%)</span></span><span style="color:${g.costOptimization.meetsFloor ? 'var(--green)' : '#ff6b6b'}">${g.costOptimization.savingPct}% ${g.costOptimization.meetsFloor ? '✓' : '⚠'}</span></div>
          <div class="kv"><span>Cache hit rate</span><span>${g.costOptimization.cacheHitRatePct}%</span></div>
          <div class="muted" style="font-size:11.5px;margin-top:6px">${g.costOptimization.techniques.join(' · ')}</div>` : ''}</div>
        ${profit ? (() => {
          const st = profit.streams || {};
          const rows = [
            ['10% commission (bookings)', st.commissionRevenueUSD],
            ['Supplier commissions', st.supplierRevenueUSD],
            ['Savings-share fees', st.savingsRevenueUSD],
            ['Subscriptions (monthly)', st.subscriptionRevenueUSD],
            ['ACU pack sales', st.acuSalesRevenueUSD],
            ['Forfeited search deposits', st.searchDepositRevenueUSD],
            ['Booking protection fees', st.protectionRevenueUSD],
            ['Corporate accounts', st.corporateRevenueUSD],
            ['White-label SaaS', st.whiteLabelRevenueUSD],
            ['API per-call revenue', st.apiRevenueUSD],
          ].map(([k, v]) => `<div class="kv"><span>${k}</span><span>$${Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span></div>`).join('');
          return `<div class="card pad" style="margin-top:16px;border-color:rgba(216,180,106,0.35)"><span class="eyebrow">3JN income — every stream (our revenue only)</span>
            ${rows}
            <div class="kv" style="margin-top:8px"><span><strong>Total 3JN revenue</strong></span><span style="color:var(--gold)"><strong>$${Number(profit.revenueUSD || 0).toLocaleString()}</strong></span></div>
            <div class="kv"><span>AI cost (actual)</span><span>−$${Number(profit.aiCosts?.actualUSD || 0).toLocaleString()}</span></div>
            <div class="kv"><span><strong>Profit</strong></span><span style="color:var(--green)"><strong>$${Number(profit.profitUSD || 0).toLocaleString()}</strong></span></div>
            <div class="muted" style="font-size:11.5px;margin-top:6px">Live from the ledgers — supplier gross (the 90% host share etc.) is excluded; this is 3JN's income only.</div>
          </div>`;
        })() : ''}
        ${profit?.acuEconomics ? (() => {
          const e = profit.acuEconomics;
          const rates = Object.entries(e.providerRatesUSDPerMTokens || {}).map(([pr, r]) => `<div class="kv"><span>${pr}</span><span>$${r} / 1M tokens</span></div>`).join('');
          const spend = Object.entries(e.providerSpend || {}).filter(([, v]) => v.requests > 0).map(([pr, v]) => `<div class="kv"><span>${pr} <span class="muted">· ${v.requests} calls</span></span><span>est $${v.estimatedUSD} · actual $${v.actualUSD}</span></div>`).join('') || '<div class="muted" style="font-size:12.5px">No routed AI calls yet — local engine served everything at $0.</div>';
          return `<div class="card pad" style="margin-top:16px"><span class="eyebrow">AI provider costs & ACU profit</span>
            <div style="margin-top:8px"><span class="muted" style="font-size:11px;letter-spacing:.14em;text-transform:uppercase">Provider price list</span>${rates}</div>
            <div style="margin-top:10px"><span class="muted" style="font-size:11px;letter-spacing:.14em;text-transform:uppercase">Actual spend (from the ai_request_costs ledger)</span>${spend}</div>
            <div class="kv" style="margin-top:10px"><span>ACU sales revenue</span><span>$${(e.acuSalesRevenueUSD || 0).toLocaleString()}</span></div>
            <div class="kv"><span>AI cost (actual)</span><span>$${(e.aiCostActualUSD || 0).toLocaleString()}</span></div>
            <div class="kv"><span><strong>ACU gross profit</strong></span><span style="color:var(--gold)"><strong>$${(e.grossProfitUSD || 0).toLocaleString()}${e.marginPct != null ? ' · ' + e.marginPct + '%' : ''}</strong></span></div>
            <div class="muted" style="font-size:11.5px;margin-top:8px">Unit economics: 1 ACU sells at £${e.unitEconomics.acuSellPriceGBP} and costs £${e.unitEconomics.acuInternalCostGBP} to serve (${e.unitEconomics.intrinsicMarginPct}% intrinsic margin). ${e.unitEconomics.rule}.</div>
          </div>`;
        })() : ''}
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
    <div id="fulfilmentPanel" style="margin-top:24px"></div>
    <div id="benchmarkPanel" style="margin-top:24px"></div>
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
  renderBenchmark();
  renderFulfilment();
}

// ---- Ops Fulfilment Desk + Supplier Doors ------------------------------------
// Every paid booking's non-auto components land here, channel-routed (Rayna
// portal, visa desk, vendor marketplace…) with a pre-packed payload. Complete
// an order = paste the supplier confirmation; the OS updates the customer's
// documents and notifies them. The doors list is the API acquisition tracker.
async function renderFulfilment() {
  const el = $('#fulfilmentPanel'); if (!el) return;
  let d; try { d = await api('/api/admin/fulfilment'); } catch { return; }
  const open = (d.orders || []).filter((o) => o.status !== 'completed');
  const done = (d.orders || []).filter((o) => o.status === 'completed').slice(0, 6);
  const CH = {
    'ops:rayna': ['🟠 Rayna portal', 'var(--gold)'], 'ops:visa-desk': ['🛂 Visa desk', 'var(--blue-bright)'],
    'ops:vendor-marketplace': ['🧑‍🤝‍🧑 Vendor marketplace', 'var(--green)'], 'ops:activities': ['🎟 Activities', 'var(--muted)'],
    'ops:transfers': ['🚘 Transfers', 'var(--muted)'], 'ops:insurance-signpost': ['🛡 Insurance (signpost only — FCA)', '#ff8a8a'],
    'ops:carhire': ['🚗 Car hire', 'var(--muted)'], 'ops:ground': ['🚆 Ground transport', 'var(--muted)'],
    'ops:hotels': ['🏨 Hotel manual', 'var(--muted)'], 'auto:esim-api': ['📶 eSIM auto', 'var(--green)'],
    'auto:esim-inhouse': ['📶 eSIM auto (in-OS)', 'var(--green)'], 'auto:host-marketplace': ['🏠 Host auto', 'var(--green)'],
    'ops:viator-api': ['🎟 Viator', 'var(--blue-bright)'], 'ops:mozio-api': ['🚘 Mozio', 'var(--blue-bright)'], 'ops:insurance-api': ['🛡 Insurance', 'var(--blue-bright)'],
  };
  const chip = (c) => { const [label, color] = CH[c] || [c, 'var(--muted)']; return `<span class="ch-chip" style="color:${color};border-color:currentColor;font-size:10.5px">${label}</span>`; };
  const ageH = (iso) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 3600000));
  const rows = open.map((o) => `
    <div style="padding:10px 0;border-bottom:1px solid rgba(223,229,238,.08)">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;align-items:baseline">
        <strong>${esc(o.componentLabel)}</strong>
        <span>${chip(o.channel)} <span class="muted" style="font-size:11px">${ageH(o.createdAt)}h old${ageH(o.createdAt) > 24 ? ' ⚠' : ''}</span></span></div>
      <div class="muted" style="font-size:12px;margin-top:3px">${esc(o.destination || '')}${o.serviceDate ? ' · ' + esc(o.serviceDate) : ''}${o.pax ? ' · ' + o.pax + ' pax' : ''} · ${esc(o.symbol)}${o.sellPrice} · booking ${esc(o.bookingId)}${o.customer?.name ? ' · ' + esc(o.customer.name) : ''}</div>
      <div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" onclick="copyFulfilPayload('${esc(o.id)}')">📋 Copy portal payload</button>
        ${o.channel === 'ops:rayna' ? '<a class="btn btn-ghost btn-sm" href="https://agents.raynab2b.com" target="_blank" rel="noopener">Open Rayna portal ↗</a>' : ''}
        <input class="in" id="ffref-${esc(o.id)}" placeholder="Supplier confirmation no." style="max-width:200px;font-size:12px">
        <button class="btn btn-gold btn-sm" onclick="completeFulfil('${esc(o.id)}')">✓ Complete → notify customer</button>
      </div>
      <textarea id="ffpay-${esc(o.id)}" style="position:absolute;left:-9999px">${esc(o.portalPayload || '')}</textarea>
    </div>`).join('') || '<p class="muted" style="font-size:12.5px">Nothing waiting — every paid component is fulfilled. New paid bookings appear here automatically.</p>';
  const doneRows = done.map((o) => `<div class="kv"><span>${esc(o.componentLabel)} <span class="muted">· ${esc(o.channel)}</span></span><span style="color:var(--green)">✓ ${esc(o.supplierRef || '')}${o.completedBy === 'auto' ? ' · auto' : ''}</span></div>`).join('');
  const doors = (d.doors || []).map((dr) => `
    <div class="kv"><span>${dr.open ? '🟢' : '⚪'} <strong>${esc(dr.provider)}</strong> <span class="muted" style="font-size:11px">· ${esc(dr.covers)}</span></span>
    <span class="muted" style="font-size:11px;text-align:right;max-width:45%">${dr.open ? 'OPEN' : `${esc(dr.envVar)} · ${esc(dr.signup)}`}</span></div>`).join('');
  el.innerHTML = `
    <div class="section-head left" style="margin:0 0 10px"><h2 style="font-size:20px">🛠 Ops Fulfilment Desk — the automatic way around manual portals</h2></div>
    <div class="console-grid">
      <div class="card pad">
        <span class="eyebrow">Open orders (${open.length})</span>
        <p class="muted" style="font-size:12px;margin:6px 0">Each order is pre-packed: copy the payload, complete it in the supplier portal (Rayna at net rates), paste the confirmation — the customer's documents update and they're notified automatically.</p>
        ${rows}
        ${doneRows ? `<div style="margin-top:12px"><span class="eyebrow">Recently completed</span>${doneRows}</div>` : ''}
      </div>
      <div class="card pad">
        <span class="eyebrow">Supplier doors — API acquisition tracker</span>
        <p class="muted" style="font-size:12px;margin:6px 0">Each door opens the moment its key lands in Vercel env vars — no code changes. ⚪ = start the signup; 🟢 = live.</p>
        ${doors}
      </div>
    </div>`;
}
// Launch readiness: one click → plain-English green/red checklist of whether the
// OS can actually sell, charge, ticket, save and email. No terminal required.
window.runSelfTest = async () => {
  const box = $('#selfTestOut');
  if (box) box.innerHTML = `<div class="card pad" style="margin-bottom:16px"><span class="loader"></span> Checking Duffel, Stripe, Firebase and email from the server…</div>`;
  let d;
  try { d = await api('/api/admin/selftest'); }
  catch { if (box) box.innerHTML = `<div class="card pad" style="margin-bottom:16px;border-color:rgba(255,90,90,0.4)">Couldn't run the check — are you signed in as admin (with the staff PIN)?</div>`; return; }
  const dot = (ok) => ok ? '<span style="color:#4ade80">✅</span>' : '<span style="color:#ff8a8a">❌</span>';
  const v = d.verdict || {};
  const banner = v.readyToGoLive ? { c: '#4ade80', t: '🟢 LIVE-READY' }
    : v.readyToTest ? { c: 'var(--gold)', t: '🟡 READY TO TEST' }
    : { c: '#ff8a8a', t: '🔴 NOT READY' };
  const rows = (d.checks || []).map((c) => `
    <div class="card pad" style="margin-bottom:8px;border-color:${c.ok ? 'rgba(74,222,128,0.35)' : 'rgba(255,138,138,0.35)'}">
      <div style="display:flex;gap:8px;align-items:flex-start">
        <div style="font-size:16px">${dot(c.ok)}</div>
        <div>
          <strong>${esc(c.label)}</strong>
          <div class="muted" style="font-size:12px;margin-top:3px">${esc(c.detail || '')}</div>
          ${!c.ok && c.fix ? `<div style="font-size:12px;margin-top:5px;color:var(--gold)">→ ${esc(c.fix)}</div>` : ''}
        </div>
      </div>
    </div>`).join('');
  if (box) box.innerHTML = `
    <div class="card pad" style="margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <span class="eyebrow">🚦 Launch readiness</span>
        <strong style="color:${banner.c};font-size:15px">${banner.t}</strong>
      </div>
      <p class="muted" style="font-size:12.5px;margin:8px 0 14px">${esc(v.summary || '')}</p>
      ${rows}
      <p class="muted" style="font-size:11px;margin-top:8px">Modes — Duffel: <strong>${esc(d.mode?.duffel || '?')}</strong> · Stripe: <strong>${esc(d.mode?.stripe || '?')}</strong> · Live mode: <strong>${d.mode?.liveMode ? 'ON' : 'off'}</strong>${d.mode?.testPayments ? ' · test payments ON' : ''}. Re-run any time.</p>
    </div>`;
};
// One-click email test: sends a real message to a chosen inbox and reports back.
window.sendTestEmail = async () => {
  const to = prompt('Send a test email to which address? (leave blank to use your account email)', state.user?.email || '');
  if (to === null) return; // cancelled
  toast('✉️ Sending test email…');
  let r;
  try { r = await api('/api/admin/test-email', { method: 'POST', body: JSON.stringify({ to: (to || '').trim() }) }); }
  catch { toast('Could not send — are you signed in as admin (with the staff PIN)?'); return; }
  toast(r.ok ? `✅ ${r.message}` : `⚠ ${r.message}`);
};
// Admin: grant ACU + set membership level for any user (run the business; test tiers).
const MEMBERSHIP_OPTIONS = [
  ['none', 'No membership (free)'],
  ['nomad', 'Smart Traveller (£4.99)'],
  ['family', 'Family Saver (£12.99)'],
  ['executive', 'Frequent Flyer (£24.99)'],
  ['elite', 'Concierge Elite (£49.99)'],
];
window.manageUser = () => {
  modal(`
    <span class="eyebrow">👤 Manage user</span>
    <h3 style="margin:6px 0 4px">Grant ACU &amp; set membership</h3>
    <p class="muted" style="font-size:12.5px">Find a customer by email (or user id), then adjust their ACU balance or membership tier. Applies immediately.</p>
    <div class="field" style="margin-top:10px"><label>Customer email or id</label>
      <div style="display:flex;gap:8px"><input class="in" id="muQuery" placeholder="customer@email.com" style="flex:1"><button class="btn btn-gold btn-sm" onclick="muFind()">Find</button></div></div>
    <div id="muResult" style="margin-top:14px"></div>`);
};
window.muFind = async () => {
  const q = ($('#muQuery')?.value || '').trim();
  if (!q) { toast('Enter an email or user id.'); return; }
  const box = $('#muResult');
  if (box) box.innerHTML = '<div class="muted" style="font-size:12.5px"><span class="loader"></span> Looking up…</div>';
  let d;
  try { d = await api(`/api/admin/user-find?q=${encodeURIComponent(q)}`); }
  catch (e) { if (box) box.innerHTML = `<div class="muted" style="color:#ff8a8a">${esc(e.message || 'Not found')}</div>`; return; }
  muRenderUser(d.user);
};
function muRenderUser(u) {
  const box = $('#muResult');
  if (!box) return;
  window.__muUser = u;
  const opts = MEMBERSHIP_OPTIONS.map(([k, label]) => `<option value="${k}"${(u.membership?.tier || 'none') === k ? ' selected' : ''}>${esc(label)}</option>`).join('');
  box.innerHTML = `
    <div class="card pad">
      <strong>${esc(u.name || '(no name)')}</strong> <span class="muted">· ${esc(u.email || '')}</span>
      <div class="muted" style="font-size:12px;margin-top:4px">Role: ${esc(u.role || 'consumer')} · ACU: <strong id="muBal">${(u.acuBalance || 0).toLocaleString()}</strong> · Membership: <strong>${esc(u.membership?.name || 'none')}</strong></div>
      <div class="field" style="margin-top:12px"><label>Add ACU (use a negative number to deduct)</label>
        <div style="display:flex;gap:8px"><input class="in" id="muAcu" type="number" placeholder="e.g. 5000" style="flex:1"><button class="btn btn-gold btn-sm" onclick="muAddAcu()">Add ACU</button></div></div>
      <div class="field" style="margin-top:12px"><label>Set membership level</label>
        <div style="display:flex;gap:8px"><select class="in" id="muTier" style="flex:1">${opts}</select><button class="btn btn-gold btn-sm" onclick="muSetTier()">Set</button></div></div>
    </div>`;
}
window.muAddAcu = async () => {
  const u = window.__muUser; if (!u) return;
  const add = Number($('#muAcu')?.value || 0);
  if (!add) { toast('Enter an amount.'); return; }
  try {
    const r = await api(`/api/admin/users/${u.id}/acu`, { method: 'POST', body: JSON.stringify({ add }) });
    window.__muUser = r.user || u;
    if ($('#muBal')) $('#muBal').textContent = (r.balance || 0).toLocaleString();
    if ($('#muAcu')) $('#muAcu').value = '';
    toast(`✓ ACU updated — balance ${(r.balance || 0).toLocaleString()}.`);
  } catch (e) { toast('⚠ ' + (e.message || 'Failed')); }
};
window.muSetTier = async () => {
  const u = window.__muUser; if (!u) return;
  const tier = $('#muTier')?.value || 'none';
  try {
    const r = await api(`/api/admin/users/${u.id}/membership`, { method: 'POST', body: JSON.stringify({ tier }) });
    muRenderUser(r.user);
    toast(`✓ Membership set to ${r.user.membership?.name || 'none'}.`);
  } catch (e) { toast('⚠ ' + (e.message || 'Failed')); }
};
window.runBotSweep = async () => {
  try {
    const r = await api('/api/admin/bot-sweep', { method: 'POST', body: '{}' });
    toast(`🧹 Sweep done: ${r.checked} checked · ${r.flagged} quarantined · ${r.immune} untouched.`);
    if (r.flagged > 0) modal(`<span class="eyebrow">🧹 Bot sweep — quarantined accounts</span>
      <p class="muted" style="font-size:12px;margin:6px 0">Machine-generated identity AND zero activity. Any real activity makes an account immune. One-click restore if a flag is wrong.</p>
      ${r.list.map((u) => `<div class="kv"><span>${esc(u.name || '(no name)')} <span class="muted">· ${esc(u.email || 'no email')}</span><br><span class="muted" style="font-size:10.5px">${esc(u.reasons.join(', '))}</span></span>
        <button class="btn btn-ghost btn-sm" onclick="unflagBot('${esc(u.userId)}', this)">Restore</button></div>`).join('')}`);
  } catch { toast('Sweep failed — are you signed in as admin?'); }
};
// ---- Sponsored placements (admin revenue tool) ----------------------------
window.openPlacements = async () => {
  let d;
  try { d = await api('/api/admin/placements'); } catch { toast('Admin only.'); return; }
  const rows = (d.placements || []).length
    ? d.placements.map((p) => `<div class="kv"><span>${esc(p.partner)} <span class="muted" style="font-size:11px">· ${esc(p.section)} · ${esc(p.destination)} · £${p.feeGBPMonth}/mo ${p.active ? '' : '· <span style="color:var(--muted)">paused</span>'}</span></span>
      <span style="display:flex;gap:6px"><button class="btn btn-ghost btn-sm" onclick="togglePlacement('${p.id}', ${!p.active}, this)">${p.active ? 'Pause' : 'Resume'}</button>
      <button class="btn btn-ghost btn-sm" onclick="deletePlacement('${p.id}', this)">✕</button></span></div>`).join('')
    : '<div class="muted" style="font-size:12.5px">No placements yet — create one below.</div>';
  const opts = (d.sections || []).map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  modal(`<span class="eyebrow">💰 Sponsored placements · £${d.monthlyRevenueGBP}/mo recurring</span>
    <h3 style="margin:6px 0 8px">Labelled supplier placements</h3>
    <p class="muted" style="font-size:11.5px;margin:0 0 10px">Placements show as a clearly-marked "Sponsored" strip. They never override the reliability floor or reorder the cheapest-reliable pick.</p>
    <div style="max-height:200px;overflow:auto">${rows}</div>
    <div class="card pad" style="margin-top:12px">
      <span class="eyebrow">New placement</span>
      <div class="field" style="margin-top:8px"><label>Partner / supplier</label><input class="in" id="plPartner" placeholder="e.g. Rove Hotels"></div>
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
        <div class="field" style="flex:1;min-width:160px"><label>Section</label><select class="in" id="plSection">${opts}</select></div>
        <div class="field" style="width:130px"><label>Destination</label><input class="in" id="plDest" value="*" placeholder="* = all"></div>
        <div class="field" style="width:120px"><label>Fee £/month</label><input class="in" id="plFee" type="number" value="250" min="0"></div>
      </div>
      <button class="btn btn-gold btn-block" style="margin-top:12px" onclick="createPlacement()">Create placement</button>
    </div>`);
};
window.createPlacement = async () => {
  const partner = $('#plPartner')?.value.trim();
  if (!partner) { toast('Enter a partner name.'); return; }
  try {
    const r = await api('/api/admin/placements', { method: 'POST', body: JSON.stringify({ partner, section: $('#plSection').value, destination: $('#plDest').value.trim() || '*', feeGBPMonth: Number($('#plFee').value) || 0 }) });
    if (r.ok) { toast('✓ Placement created.'); openPlacements(); } else { toast(r.message || 'Invalid placement.'); }
  } catch { toast('Could not create placement.'); }
};
window.togglePlacement = async (id, active, btn) => {
  try { const r = await api(`/api/admin/placements/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) }); if (r.ok) openPlacements(); } catch { toast('Failed.'); }
};
window.deletePlacement = async (id) => {
  try { const r = await api(`/api/admin/placements/${id}`, { method: 'DELETE' }); if (r.ok) { toast('Removed.'); openPlacements(); } } catch { toast('Failed.'); }
};

window.unflagBot = async (userId, btn) => {
  try { const r = await api(`/api/admin/bot-sweep/${userId}/unflag`, { method: 'POST', body: '{}' }); if (r.ok) { btn.textContent = '✓ Restored'; btn.disabled = true; toast('Account restored.'); } } catch { toast('Could not restore.'); }
};
window.copyFulfilPayload = (id) => {
  const ta = $(`#ffpay-${id}`); if (!ta) return;
  navigator.clipboard?.writeText(ta.value).then(() => toast('📋 Payload copied — paste it in the supplier portal.'), () => { ta.select(); document.execCommand('copy'); toast('📋 Copied.'); });
};
window.completeFulfil = async (id) => {
  const supplierRef = $(`#ffref-${id}`)?.value?.trim();
  if (!supplierRef) { toast('Paste the supplier confirmation number first — the customer document depends on it.'); return; }
  try {
    const r = await api(`/api/admin/fulfilment/${id}/complete`, { method: 'POST', body: JSON.stringify({ supplierRef }) });
    if (!r.ok) { toast(r.message || r.error || 'Could not complete.'); return; }
    toast('✅ Completed — customer notified, documents updated.');
    renderFulfilment();
  } catch { toast('Could not complete the order.'); }
};

// ---- Market Benchmark: are we unbeatable? -----------------------------------
// Runs real routes through the SAME live Duffel search + checkout pricing the
// customer gets, then links the identical route + dates on Skyscanner / Google
// Flights / Kayak. Read the leader's price, record it, get an honest verdict.
async function renderBenchmark() {
  const el = $('#benchmarkPanel'); if (!el) return;
  let d; try { d = await api('/api/benchmark/flights'); } catch { return; }
  const run = d.lastRun;
  const VERDICT = {
    unbeatable: ['✅ UNBEATABLE', 'var(--green)'],
    competitive: ['🟡 Within 3%', 'var(--gold)'],
    'above-market': ['⚠ Above market', '#ff8a8a'],
    'no-live-fare': ['— no live fare', 'var(--muted)'],
  };
  const rows = (run?.rows || []).map((r) => {
    const chip = (res, label) => res && VERDICT[res.verdict]
      ? `<span class="ch-chip" style="color:${VERDICT[res.verdict][1]};border-color:currentColor">${label ? label + ' ' : ''}${VERDICT[res.verdict][0]}${res.deltaGbp != null ? ` · ${res.deltaGbp <= 0 ? '−' : '+'}£${Math.abs(res.deltaGbp).toFixed(2)} (${res.deltaPct > 0 ? '+' : ''}${res.deltaPct}%)` : ''}${res.vs ? ` vs ${esc(res.vs.source)} £${res.vs.priceGbp}${res.vs.selfTransfer ? ' (self-transfer)' : ''}` : ''}</span>`
      : '';
    const verdict = (chip(r.result, '') + (r.protectedResult && r.result?.vs?.selfTransfer ? ' ' + chip(r.protectedResult, 'Protected fares:') : ''))
      || '<span class="muted" style="font-size:11.5px">read a leader price → record it below</span>';
    const quotes = (r.marketQuotes || []).map((q) => `<span class="chip" style="font-size:10.5px">${esc(q.source)} £${q.priceGbp}${q.selfTransfer ? ' · self-transfer' : ''}${q.caveat ? ' · ' + esc(q.caveat) : ''}</span>`).join(' ');
    const noteHTML = r.note ? `<div style="font-size:11.5px;color:var(--green);margin-top:4px">✓ ${esc(r.note)}</div>` : '';
    const fare = r.live
      ? `<strong style="color:var(--gold)">£${(r.ourPriceGbp ?? 0).toFixed(2)}</strong> <span class="muted" style="font-size:11px">customer pays · raw £${(r.rawFareGbp ?? 0).toFixed(2)} · ${esc(r.carrier || '')} · ${esc(r.cabin || '')}${r.baggage ? ' · ' + esc(r.baggage) : ''} · ${r.offersFound} offers</span>`
      : `<span style="color:#ff8a8a">${r.error === 'no-offers' ? 'No live offers on this route/date — try the alternate airport or another date' : esc(r.error || 'no result')}</span>`;
    return `<div style="padding:10px 0;border-bottom:1px solid rgba(223,229,238,.08)">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;align-items:baseline">
        <strong>${esc(r.label)}</strong>
        <span class="muted" style="font-size:11.5px">${esc(r.depart)}${r.ret ? ' → ' + esc(r.ret) : ' one-way'} · ${r.adults} adult${r.adults > 1 ? 's' : ''}</span></div>
      <div style="margin-top:4px;font-size:13px">${fare}</div>
      <div style="margin-top:6px;font-size:12px">Check the same route: <a href="${r.links.skyscanner}" target="_blank" rel="noopener" style="color:var(--gold)">Skyscanner</a> · <a href="${r.links.googleFlights}" target="_blank" rel="noopener" style="color:var(--gold)">Google Flights</a> · <a href="${r.links.kayak}" target="_blank" rel="noopener" style="color:var(--gold)">Kayak</a></div>
      <div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap">
        <select class="in" id="bmsrc-${esc(r.id)}" style="max-width:150px;padding:6px 8px"><option>Skyscanner</option><option>Google Flights</option><option>Kayak</option><option>momondo</option><option>Kiwi.com</option><option>Trip.com</option><option>Expedia</option></select>
        <input class="in" id="bmp-${esc(r.id)}" placeholder="Leader's £ total" style="max-width:140px" inputmode="decimal">
        <label class="muted" style="font-size:11.5px;display:flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" id="bmst-${esc(r.id)}"> self-transfer / separate tickets</label>
        <input class="in" id="bmcv-${esc(r.id)}" placeholder="caveat, e.g. lands at Charleroi" style="max-width:190px;font-size:12px">
        <button class="btn btn-ghost btn-sm" onclick="saveBenchmarkMarket('${esc(run.id)}','${esc(r.id)}')">Record & judge</button>
      </div>
      ${quotes ? `<div style="margin-top:6px">${quotes}</div>` : ''}
      <div style="margin-top:6px">${verdict}</div>
      ${noteHTML}
    </div>`;
  }).join('');
  el.innerHTML = `
    <div class="section-head left" style="margin:0 0 10px"><h2 style="font-size:20px">✈ Market Benchmark — are we unbeatable?</h2></div>
    <div class="card pad">
      ${d.enabled
        ? `<div class="muted" style="font-size:12.5px">Duffel <strong>${esc(d.mode || '')}</strong> key detected — fares below are the real prices a customer pays (raw fare + 10% + Duffel pass-through), against the same route on the market leaders.</div>`
        : '<div style="color:#ffb86b;font-size:12.5px">⚠ No live fare key in this environment — the sweep only returns real prices on production (Vercel), where the Duffel key is set.</div>'}
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:flex-end">
        <div class="field"><label>Depart</label><input class="in" id="bmDepart" type="date" value="2026-09-01" style="max-width:150px"></div>
        <div class="field"><label>Return</label><input class="in" id="bmReturn" type="date" value="2026-09-06" style="max-width:150px"></div>
        <div class="field"><label>From (IATA)</label><input class="in" id="bmFrom" placeholder="EMA" maxlength="3" style="max-width:90px;text-transform:uppercase"></div>
        <div class="field"><label>To (IATA)</label><input class="in" id="bmTo" placeholder="BRU" maxlength="3" style="max-width:90px;text-transform:uppercase"></div>
        <button class="btn btn-gold btn-sm" onclick="runBenchmark(true)">Run custom route</button>
        <button class="btn btn-ghost btn-sm" onclick="runBenchmark(false)">Run full sweep (${(d.defaults || []).length} routes)</button>
      </div>
      <div class="muted" style="font-size:11px;margin-top:6px">Default sweep: ${(d.defaults || []).map((r) => esc(r.label)).join(' · ')}</div>
      ${run ? `<div style="margin-top:14px"><span class="eyebrow">Last run · ${esc((run.at || '').replace('T', ' ').slice(0, 16))} · Duffel ${esc(run.mode || '')}</span>${rows}</div>` : ''}
    </div>`;
}
window.runBenchmark = async (custom) => {
  const depart = $('#bmDepart')?.value; const ret = $('#bmReturn')?.value || null;
  if (!depart) { toast('Pick a departure date.'); return; }
  const body = { depart, ret };
  if (custom) {
    const from = ($('#bmFrom')?.value || '').trim().toUpperCase(); const to = ($('#bmTo')?.value || '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) { toast('Enter 3-letter IATA codes, e.g. EMA → BRU.'); return; }
    body.routes = [{ label: `${from} → ${to}`, origin: from, dest: to }];
  }
  toast('✈ Running live fare sweep — a few seconds per route…');
  try {
    const r = await api('/api/benchmark/flights', { method: 'POST', body: JSON.stringify(body) });
    if (!r.ok) { toast(r.message || 'Benchmark could not run here.'); return; }
    toast('✓ Sweep complete — open the leader links and record their prices.');
    renderBenchmark();
  } catch (e) { toast(e?.message || 'Benchmark failed.'); }
};
window.saveBenchmarkMarket = async (runId, rowId) => {
  const priceGbp = parseFloat($(`#bmp-${rowId}`)?.value);
  const source = $(`#bmsrc-${rowId}`)?.value || 'market';
  const selfTransfer = !!$(`#bmst-${rowId}`)?.checked;
  const caveat = $(`#bmcv-${rowId}`)?.value || '';
  if (!(priceGbp > 0)) { toast('Enter the leader’s price in £ first.'); return; }
  try {
    const r = await api('/api/benchmark/flights/market', { method: 'POST', body: JSON.stringify({ runId, rowId, source, priceGbp, selfTransfer, caveat }) });
    if (!r.ok) { toast(r.message || r.error || 'Could not record.'); return; }
    toast('✓ Recorded — verdict updated.');
    renderBenchmark();
  } catch { toast('Could not record the market price.'); }
};

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
      <span class="eyebrow">${esc(p.destination)} · ${p.readMins} min read</span>
      <h3 style="margin:6px 0 6px;cursor:pointer" onclick="openPost('${esc(p.slug)}')">${esc(p.title)}</h3>
      <p class="muted" style="font-size:13.5px">${esc(p.excerpt)}</p>
      <div class="chips" style="margin-top:8px">${p.tags.map((t) => `<span class="chip">#${esc(t)}</span>`).join('')}</div>
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
  let data; try { data = await api(`/api/blog/${encodeURIComponent(slug)}`); } catch { return; }
  const p = data.post;
  if (!p) { toast('That post could not be found.'); return; }
  // Reflect the post in the URL so the browser back button and re-shares work.
  try { history.replaceState({}, '', `/blog/${p.slug}`); } catch {}
  modal(`
    <span class="eyebrow">${esc(p.destination)} · ${p.readMins} min read · ${esc(p.author)}</span>
    <h2 style="margin:6px 0 4px;font-size:24px">${esc(p.title)}</h2>
    <div class="muted" style="font-size:12px;margin-bottom:12px">${(p.tags || []).map((t) => '#' + esc(t)).join(' ')}</div>
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
      <div class="chips" style="margin-top:10px">${(data.addOns || []).map((a) => `<span class="chip" style="cursor:pointer" title="Add to your next trip search" onclick="addBasketAddon('${esc(a)}')">＋ ${a}</span>`).join('')}</div>
      <p class="muted" style="font-size:11.5px;margin-top:6px">Tap any add-on to drop it into your trip — it's searched, priced and booked inside the same package.</p>
    </div>`;
}
window.planDest = (city) => {
  $('#intentInput').value = `I want to travel to ${city} with my family for 7 nights with flights, hotel, activities, transfer and eSIM — the cheapest reliable price.`;
  nav('planner');
  runPlan();
};
// Marketplace basket: every ＋ add-on chip is ACTIVE — tapping it drops the
// service into the trip sentence, and the engine searches & prices it as a
// real component inside the same package.
const BASKET_PHRASES = {
  'Tours': 'tours', 'Local drivers': 'a local driver', 'Photographers': 'a photographer',
  'Guides': 'a local guide', 'Restaurant bookings': 'restaurant reservations',
  'Event tickets': 'event tickets', 'Airport pickup': 'airport transfer',
  'Translators': 'a translator', 'eSIM data': 'an eSIM', 'Travel insurance': 'travel insurance',
};
window.addBasketAddon = (label) => {
  const phrase = BASKET_PHRASES[label] || label.toLowerCase();
  nav('planner');
  const input = $('#intentInput');
  if (input) {
    const t = input.value.trim();
    if (!t) input.value = `Trip to Dubai for 5 nights, 2 adults, flights and hotel, with ${phrase}`;
    else if (!t.toLowerCase().includes(phrase)) input.value = t.replace(/\.?\s*$/, '') + `, with ${phrase}`;
    input.focus();
  }
  toast(`＋ ${label} added to your trip — hit Search and it's priced inside the package.`);
};

// ---- Curated Deals Catalogue ----------------------------------------------
// The real, ready-to-book products. Price shown = price paid (all-in). Buying
// creates a real confirmed booking and either opens Stripe checkout or (until
// card payments are live) takes a reservation our team confirms.
let __dealsCache = {};
function dealBanner(d) {
  const img = d.image || '';
  const base = 'height:150px;width:100%;border-radius:12px 12px 0 0';
  if (img.startsWith('data:')) return `<div style="${base};background-image:url('${img}');background-size:cover;background-position:center"></div>`;
  const emoji = img && img.length <= 4 ? img : ({ package: '🧳', hotel: '🏨', flight: '✈️', experience: '🎟️', cruise: '🛳️', transfer: '🚘', other: '🌍' }[d.category] || '🌍');
  return `<div style="${base};display:flex;align-items:center;justify-content:center;font-size:52px;background:linear-gradient(135deg,#141b2e,#20293f)">${emoji}</div>`;
}
async function renderDeals() {
  const out = $('#dealsOut');
  if (!out) return;
  let data;
  try { data = await api('/api/deals'); } catch { out.innerHTML = '<div class="card pad muted">Failed to load deals.</div>'; return; }
  const deals = data.deals || [];
  deals.forEach((d) => { __dealsCache[d.id] = d; });
  if (!deals.length) {
    out.innerHTML = '<div class="card pad center muted">New deals are landing soon — check back shortly, or <span class="lnk" data-nav="planner">plan a custom trip</span>.</div>';
    return;
  }
  const cards = deals.map((d) => {
    const sym = '£';
    const price = `${sym}${Number(d.priceGBP).toLocaleString()}`;
    const was = d.wasPriceGBP ? `<span class="muted" style="text-decoration:line-through;font-size:13px;margin-right:6px">${sym}${Number(d.wasPriceGBP).toLocaleString()}</span>` : '';
    const per = d.perPerson ? ' <span class="muted" style="font-size:11px">pp</span>' : '';
    const from = d.fromPrice ? '<span class="muted" style="font-size:11px">from </span>' : '';
    const loc = [d.destinationCity, d.destinationCountry].filter(Boolean).join(', ');
    const window = d.travelFrom || d.travelTo ? `<div class="muted" style="font-size:11.5px;margin-top:4px">🗓 ${esc(d.travelFrom || '')}${d.travelTo ? ' → ' + esc(d.travelTo) : ''}</div>` : '';
    const incl = (d.inclusions || []).slice(0, 5).map((x) => `<span class="chip">${esc(x)}</span>`).join('');
    const soldOut = d.soldOut;
    const remain = d.remaining != null && d.remaining <= 5 && !soldOut ? `<div class="muted" style="font-size:11px;color:var(--gold);margin-top:4px">Only ${d.remaining} left</div>` : '';
    return `
      <div class="card deal-card" style="padding:0;overflow:hidden;display:flex;flex-direction:column">
        ${dealBanner(d)}
        <div class="pad" style="display:flex;flex-direction:column;flex:1">
          ${d.featured ? '<span class="chip" style="align-self:flex-start;border-color:rgba(216,180,106,.5);color:var(--gold);margin-bottom:6px">★ Featured</span>' : ''}
          <h3 style="margin:2px 0 2px">${esc(d.title)}</h3>
          ${loc ? `<div class="muted" style="font-size:12.5px">📍 ${esc(loc)}${d.nights ? ' · ' + d.nights + ' nights' : ''}</div>` : ''}
          ${d.summary ? `<p class="muted" style="font-size:12.5px;margin:8px 0">${esc(d.summary)}</p>` : ''}
          <div class="exp-tags" style="margin:4px 0">${incl}</div>
          ${window}
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:auto;padding-top:12px">
            <div>${was}${from}<span style="font-family:'Space Grotesk';font-weight:700;font-size:22px;color:var(--gold)">${price}</span>${per}</div>
          </div>
          ${remain}
          <button class="btn ${soldOut ? 'btn-ghost' : 'btn-gold'} btn-sm btn-block" style="margin-top:10px" ${soldOut ? 'disabled' : `onclick="openDealCheckout('${d.id}')"`}>${soldOut ? 'Sold out' : 'Book this deal →'}</button>
        </div>
      </div>`;
  }).join('');
  out.innerHTML = `<div class="dest-grid">${cards}</div>
    <p class="muted center" style="font-size:11.5px;margin-top:16px">Every deal is a real, all-inclusive price confirmed by our travel team. ${data.stripeReady ? 'Pay securely by card.' : 'Reserve now — our team confirms your booking and takes payment.'}</p>`;
}
window.openDealCheckout = (dealId) => {
  const d = __dealsCache[dealId];
  if (!d) return;
  const sym = '£';
  const stripeReady = true; // resolved server-side; label adjusts after submit
  modal(`
    <span class="eyebrow">Book · ${esc(d.title)}</span>
    <h3 style="margin:6px 0 2px">${sym}${Number(d.priceGBP).toLocaleString()}${d.perPerson ? ' <span class="muted" style="font-size:12px">per person</span>' : ' total'}</h3>
    ${d.summary ? `<p class="muted" style="font-size:12.5px">${esc(d.summary)}</p>` : ''}
    <div class="form-grid" style="margin-top:12px">
      ${d.perPerson ? '<label>Travellers<input id="dealPax" type="number" min="1" max="30" value="2"></label>' : '<input id="dealPax" type="hidden" value="1">'}
      <label>Full name<input id="dealName" placeholder="Your name" value="${esc(state.user?.name || '')}"></label>
      <label>Email<input id="dealEmail" type="email" placeholder="you@email.com" value="${esc(state.user?.email || '')}"></label>
      <label>Phone (optional)<input id="dealPhone" placeholder="+44…"></label>
    </div>
    ${d.termsNote ? `<p class="muted" style="font-size:11px;margin-top:8px">${esc(d.termsNote)}</p>` : ''}
    <button class="btn btn-gold btn-block" style="margin-top:14px" onclick="submitDealCheckout('${d.id}')">Confirm &amp; pay →</button>
  `);
};
window.submitDealCheckout = async (dealId) => {
  const pax = Math.max(1, parseInt($('#dealPax')?.value || '1', 10) || 1);
  const lead = {
    fullName: ($('#dealName')?.value || '').trim(),
    email: ($('#dealEmail')?.value || '').trim(),
    phone: ($('#dealPhone')?.value || '').trim(),
  };
  if (!lead.email) { toast('Please enter your email.'); return; }
  let r;
  try { r = await api(`/api/deals/${dealId}/checkout`, { method: 'POST', body: JSON.stringify({ pax, lead }) }); }
  catch { return; }
  if (r.mode === 'stripe' && r.url) { window.location.href = r.url; return; }
  closeModal();
  modal(`<span class="eyebrow">Reservation received ✓</span>
    <h3 style="margin:6px 0">Thank you, ${esc(lead.fullName || 'traveller')}!</h3>
    <p class="muted" style="font-size:13px">${esc(r.message || 'Our team will contact you shortly to confirm your booking and take payment.')}</p>
    <p class="muted" style="font-size:12px;margin-top:8px">Reference: <strong>${esc(r.booking?.id || '')}</strong></p>`);
};

// ---- Admin: Curated Deals manager -----------------------------------------
window.openDealsManager = async () => {
  let data;
  try { data = await api('/api/admin/deals'); } catch { return; }
  const deals = data.deals || [];
  const rows = deals.length ? deals.map((d) => `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid rgba(223,229,238,.08)">
      <div style="min-width:0">
        <strong>${esc(d.title)}</strong> <span class="chip" style="font-size:10px">${esc(d.category)}</span>
        ${d.active ? '<span class="chip" style="font-size:10px;border-color:rgba(121,217,155,.4);color:#79d99b">live</span>' : '<span class="chip" style="font-size:10px">draft</span>'}
        <div class="muted" style="font-size:11.5px">£${Number(d.priceGBP).toLocaleString()}${d.perPerson ? 'pp' : ''} · ${esc([d.destinationCity, d.destinationCountry].filter(Boolean).join(', '))}${d.slots != null ? ` · ${d.sold}/${d.slots} sold` : ''}</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button class="btn btn-ghost btn-sm" onclick="dealForm('${d.id}')">Edit</button>
        <button class="btn btn-ghost btn-sm" onclick="toggleDealActive('${d.id}',${d.active ? 'false' : 'true'})">${d.active ? 'Unpublish' : 'Publish'}</button>
        <button class="btn btn-ghost btn-sm" style="color:#ff8a8a" onclick="removeDeal('${d.id}')">✕</button>
      </div>
    </div>`).join('') : '<div class="muted" style="font-size:13px">No deals yet — create your first ready-to-book product.</div>';
  modal(`
    <span class="eyebrow">Curated Deals · ${deals.length}</span>
    <h3 style="margin:6px 0 10px">Manage ready-to-book products</h3>
    <button class="btn btn-gold btn-sm" onclick="dealForm()">＋ New deal</button>
    <div style="margin-top:12px;max-height:52vh;overflow:auto">${rows}</div>`);
};
window.dealForm = (dealId) => {
  const d = dealId ? (window.__adminDeals && window.__adminDeals[dealId]) : null;
  // Fetch fresh into a cache for editing.
  const doRender = (deal) => {
    const v = (k, def = '') => deal && deal[k] != null ? deal[k] : def;
    modal(`
      <span class="eyebrow">${deal ? 'Edit' : 'New'} deal</span>
      <div class="form-grid" style="margin-top:10px">
        <label>Title<input id="df_title" value="${esc(v('title'))}" placeholder="Dubai 5★ Escape — 5 nights"></label>
        <label>Category
          <select id="df_category">${['package', 'hotel', 'flight', 'experience', 'cruise', 'transfer', 'other'].map((c) => `<option value="${c}" ${v('category', 'package') === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
        </label>
        <label>Destination city<input id="df_city" value="${esc(v('destinationCity'))}" placeholder="Dubai"></label>
        <label>Destination country<input id="df_country" value="${esc(v('destinationCountry'))}" placeholder="UAE"></label>
        <label>Price £ (real, all-in)<input id="df_price" type="number" min="0" step="0.01" value="${esc(v('priceGBP'))}"></label>
        <label>Was £ (optional RRP)<input id="df_was" type="number" min="0" step="0.01" value="${esc(v('wasPriceGBP'))}"></label>
        <label style="display:flex;align-items:center;gap:8px"><input id="df_perperson" type="checkbox" ${v('perPerson') ? 'checked' : ''} style="width:auto"> Price is per person</label>
        <label style="display:flex;align-items:center;gap:8px"><input id="df_from" type="checkbox" ${v('fromPrice') ? 'checked' : ''} style="width:auto"> Show as "from"</label>
        <label>Nights<input id="df_nights" type="number" min="0" value="${esc(v('nights', 0))}"></label>
        <label>Deposit £ (optional)<input id="df_deposit" type="number" min="0" step="0.01" value="${esc(v('depositGBP'))}"></label>
        <label>Travel from<input id="df_from_date" type="date" value="${esc(v('travelFrom'))}"></label>
        <label>Travel to<input id="df_to_date" type="date" value="${esc(v('travelTo'))}"></label>
        <label>Stock / slots (blank = unlimited)<input id="df_slots" type="number" min="0" value="${deal && deal.slots != null ? deal.slots : ''}"></label>
        <label>Image (emoji or paste data URL)<input id="df_image" value="${esc(v('image'))}" placeholder="🏝️"></label>
      </div>
      <label style="display:block;margin-top:8px">Summary (one line)<input id="df_summary" value="${esc(v('summary'))}" placeholder="Beachfront 5★ with flights, transfers & breakfast"></label>
      <label style="display:block;margin-top:8px">What's included (one per line)<textarea id="df_incl" rows="4" placeholder="Return flights from London\n5 nights 5★ half-board\nPrivate airport transfers">${esc((v('inclusions', []) || []).join('\n'))}</textarea></label>
      <label style="display:block;margin-top:8px">Description<textarea id="df_desc" rows="3">${esc(v('description'))}</textarea></label>
      <label style="display:block;margin-top:8px">Terms note (shown to customer)<input id="df_terms" value="${esc(v('termsNote'))}"></label>
      <label style="display:block;margin-top:8px">Internal fulfilment note (team only — how to book)<input id="df_fulfil" value="${esc(v('fulfilmentNote'))}" placeholder="Book via XYZ agent portal, net £X"></label>
      <label style="display:flex;align-items:center;gap:8px;margin-top:10px"><input id="df_active" type="checkbox" ${deal ? (v('active') ? 'checked' : '') : 'checked'} style="width:auto"> Published (visible to customers)</label>
      <label style="display:flex;align-items:center;gap:8px;margin-top:6px"><input id="df_featured" type="checkbox" ${v('featured') ? 'checked' : ''} style="width:auto"> Featured</label>
      <button class="btn btn-gold btn-block" style="margin-top:14px" onclick="saveDeal(${deal ? `'${deal.id}'` : 'null'})">${deal ? 'Save changes' : 'Create deal'}</button>
    `);
  };
  if (dealId) {
    api('/api/admin/deals').then((data) => {
      window.__adminDeals = {}; (data.deals || []).forEach((x) => { window.__adminDeals[x.id] = x; });
      doRender(window.__adminDeals[dealId] || null);
    }).catch(() => doRender(null));
  } else doRender(null);
};
window.saveDeal = async (dealId) => {
  const num = (id) => { const x = $(id)?.value; return x === '' || x == null ? null : Number(x); };
  const payload = {
    title: $('#df_title')?.value || '',
    category: $('#df_category')?.value || 'package',
    destinationCity: $('#df_city')?.value || '',
    destinationCountry: $('#df_country')?.value || '',
    priceGBP: num('#df_price'),
    wasPriceGBP: $('#df_was')?.value || '',
    perPerson: $('#df_perperson')?.checked || false,
    fromPrice: $('#df_from')?.checked || false,
    nights: num('#df_nights') || 0,
    depositGBP: $('#df_deposit')?.value || '',
    travelFrom: $('#df_from_date')?.value || '',
    travelTo: $('#df_to_date')?.value || '',
    slots: $('#df_slots')?.value === '' ? '' : num('#df_slots'),
    image: $('#df_image')?.value || '',
    summary: $('#df_summary')?.value || '',
    inclusions: ($('#df_incl')?.value || '').split('\n').map((x) => x.trim()).filter(Boolean),
    description: $('#df_desc')?.value || '',
    termsNote: $('#df_terms')?.value || '',
    fulfilmentNote: $('#df_fulfil')?.value || '',
    active: $('#df_active')?.checked || false,
    featured: $('#df_featured')?.checked || false,
  };
  if (!payload.title || !(payload.priceGBP > 0)) { toast('A title and a real price are required.'); return; }
  try {
    if (dealId) await api(`/api/admin/deals/${dealId}`, { method: 'PATCH', body: JSON.stringify(payload) });
    else await api('/api/admin/deals', { method: 'POST', body: JSON.stringify(payload) });
    toast(dealId ? 'Deal updated.' : 'Deal created.');
    openDealsManager();
  } catch { /* toast shown by api */ }
};
window.toggleDealActive = async (dealId, active) => {
  try { await api(`/api/admin/deals/${dealId}/active`, { method: 'POST', body: JSON.stringify({ active }) }); openDealsManager(); } catch {}
};
window.removeDeal = async (dealId) => {
  if (!confirm('Delete this deal permanently?')) return;
  try { await api(`/api/admin/deals/${dealId}`, { method: 'DELETE' }); openDealsManager(); } catch {}
};

// ---- 3JN VisaOS -----------------------------------------------------------
// VisaOS is TWO different products in one view — role decides which you get:
//   · Officers (embassy/consulate/admin) → the DECISION COMMAND CENTRE.
//   · Everyone else → the applicant experience (apply + track MY applications).
function isVisaOfficer() {
  return !!(state.user && (state.user.allAccess || ['embassy', 'consulate', 'admin'].includes(state.user.role)));
}
function renderVisaOS() {
  const officer = isVisaOfficer();
  const a = $('#visaTabApply'); const g = $('#visaTabGov');
  if (a && g) {
    if (officer) {
      g.textContent = '🛡 Decision Command Centre';
      g.classList.add('btn-gold'); g.classList.remove('btn-ghost');
      a.textContent = 'Applicant view (preview)';
      a.classList.add('btn-ghost'); a.classList.remove('btn-gold');
    } else {
      a.textContent = 'Apply for a visa';
      a.classList.add('btn-gold'); a.classList.remove('btn-ghost');
      g.textContent = '📋 My applications';
      g.classList.add('btn-ghost'); g.classList.remove('btn-gold');
    }
  }
  officer ? renderVisaGov() : renderVisaApply();
}
$('#visaTabApply')?.addEventListener('click', renderVisaApply);
$('#visaTabGov')?.addEventListener('click', () => (isVisaOfficer() ? renderVisaGov() : renderMyVisaApplications()));

// Applicant: track my applications — REDACTED view (status only until the
// embassy releases the decision; then decision + official letter).
async function renderMyVisaApplications() {
  const out = $('#visaosOut');
  if (!out) return;
  if (!state.user) { out.innerHTML = '<div class="card pad center"><p class="muted">Sign in to track your visa applications.</p><button class="btn btn-gold" onclick="openAuth()">Sign in</button></div>'; return; }
  out.innerHTML = '<div class="card pad center muted">Loading your applications…</div>';
  let d;
  try { d = await api('/api/visaos/my-applications'); } catch { out.innerHTML = '<div class="card pad center muted">Could not load applications.</div>'; return; }
  const rows = (d.applications || []).map((x) => {
    const decided = x.status === 'decided' && x.decision;
    const col = decided ? (x.decision.decision === 'Approved' ? 'var(--green)' : x.decision.decision === 'Refused' ? '#ff8a8a' : 'var(--blue-bright)') : 'var(--gold)';
    return `<div class="card pad" style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <strong>${esc(x.applicant?.name || 'Application')} → ${esc(x.country || x.applicant?.destination || '')}</strong>
        <span style="color:${col};font-weight:600">${decided ? esc(x.decision.decision) : '🕓 Under embassy review'}</span>
      </div>
      <div class="muted" style="font-size:12px;margin-top:4px">${esc(x.id)} · ${esc(x.visaType || 'tourist')} · submitted ${esc((x.at || '').slice(0, 10))}</div>
      ${decided ? `<div class="muted" style="font-size:12.5px;margin-top:6px">${esc(x.decision.reason || '')}${(x.decision.conditions || []).length ? '<br>Conditions: ' + x.decision.conditions.map(esc).join(' · ') : ''}</div>
        <button class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="viewVisaLetter('${esc(x.id)}')">📄 Official decision letter</button>`
        : `<p class="muted" style="font-size:12px;margin-top:6px">The embassy is reviewing your file. You'll be notified the moment your decision letter is issued — decisions are made and released by an authorised officer.</p>`}
      ${(x.missingDocuments || []).length ? `<div style="margin-top:6px"><span class="t-label">Speeds up review if provided:</span> <span class="muted" style="font-size:12px">${x.missingDocuments.map(esc).join(' · ')}</span></div>` : ''}
    </div>`;
  }).join('');
  out.innerHTML = rows || '<div class="card pad center muted">No applications yet — tap "Apply for a visa" to start.</div>';
}

// Fields the applicant must complete. `req: true` means it gates the AI run.
const VISA_FORM_FIELDS = [
  { key: 'fullName', label: 'Full legal name', req: true },
  { key: 'dob', label: 'Date of birth', type: 'date', req: true },
  { key: 'gender', label: 'Gender', type: 'select', options: ['Female', 'Male', 'Other'] },
  { key: 'nationality', label: 'Nationality', type: 'country', req: true },
  { key: 'passportNumber', label: 'Passport number', req: true },
  { key: 'passportExpiry', label: 'Passport expiry', type: 'date', req: true },
  { key: 'passportCountry', label: 'Passport issuing country', type: 'country' },
  { key: 'maritalStatus', label: 'Marital status', type: 'select', options: ['Single', 'Married', 'Divorced', 'Widowed'] },
  { key: 'address', label: 'Current address', req: true },
  { key: 'email', label: 'Email', req: true },
  { key: 'phone', label: 'Phone number' },
  { key: 'occupation', label: 'Occupation', req: true },
  { key: 'employer', label: 'Employer / school' },
  { key: 'monthlyIncome', label: 'Monthly income (USD)', type: 'number' },
  { key: 'travelHistory', label: 'Travel history (10y)' },
  { key: 'previousRefusals', label: 'Previous visa refusals', type: 'select', options: ['None', 'Yes — declared'] },
  { key: 'criminalHistory', label: 'Criminal history', type: 'select', options: ['None', 'Yes — declared'] },
  { key: 'overstayHistory', label: 'Overstay history', type: 'select', options: ['None', 'Yes — declared'] },
  { key: 'arrival', label: 'Planned arrival', type: 'date' },
  { key: 'departure', label: 'Planned departure', type: 'date' },
  { key: 'accommodation', label: 'Accommodation' },
  { key: 'fundingSource', label: 'Funding source', type: 'select', options: ['Self', 'Employer', 'Sponsor', 'Scholarship', 'Family'] },
];

function visaFieldHTML(f, val = '') {
  const id = `vf_${f.key}`;
  const star = f.req ? ' <span style="color:var(--gold)">*</span>' : '';
  const v = val != null ? String(val) : '';
  let input;
  if (f.type === 'country') input = `<select class="in vf" id="${id}" data-req="${!!f.req}"><option value="">— select —</option>${countryOptions(v || (f.key === 'nationality' ? 'NG' : ''))}</select>`;
  else if (f.type === 'select') input = `<select class="in vf" id="${id}" data-req="${!!f.req}"><option value="">— select —</option>${f.options.map((o) => `<option${o === v ? ' selected' : ''}>${o}</option>`).join('')}</select>`;
  else input = `<input class="in vf" id="${id}" data-req="${!!f.req}" type="${f.type || 'text'}" value="${esc(v)}">`;
  return `<div class="field"><label>${esc(f.label)}${star}</label>${input}</div>`;
}
// Pre-fill the visa form from the user's Master Travel Profile.
function visaPrefill() {
  const tp = state.user?.travelProfile || {};
  return {
    fullName: tp.fullLegalName, dob: tp.dob, gender: tp.gender, nationality: tp.nationality,
    passportNumber: tp.passportNumber, passportExpiry: tp.passportExpiry, passportCountry: tp.passportCountry,
    maritalStatus: tp.maritalStatus, address: tp.residentialAddress, email: state.user?.email,
    phone: tp.mobile, occupation: tp.occupation, employer: tp.employer, monthlyIncome: tp.monthlyIncome,
  };
}

async function renderVisaApply() {
  const out = $('#visaosOut');
  if (!out) return;
  // Visa application is a signed-in dashboard feature — not a public page.
  if (!state.user) {
    out.innerHTML = `<div class="card pad center" style="max-width:540px;margin:0 auto">
      <div style="font-size:34px">🔒</div>
      <h3 style="margin:10px 0 6px">Sign in to start a visa application</h3>
      <p class="muted" style="font-size:14px">The Visa Application is part of your private dashboard. Your documents and identity data stay in your account.</p>
      <button class="btn btn-gold" style="margin-top:12px" onclick="openAuth('login')">Sign in</button>
      <button class="btn btn-ghost" style="margin-top:12px" onclick="provisionTest()">Use a full-access demo account</button>
    </div>`;
    return;
  }
  out.innerHTML = `
    <div class="planner-shell">
      <div class="card pad">
        <span class="eyebrow">Digital Visa Application · private dashboard</span>
        <p class="muted" style="font-size:12.5px">Complete every required field <strong>and attach every document</strong>. The AI decision swarm only runs once your file is 100% complete. <span class="muted">* = required</span></p>

        <div style="margin-top:12px"><span class="eyebrow">Trip & visa</span></div>
        <div class="composer-row" style="margin-top:6px">
          <div class="field"><label>Destination country <span style="color:var(--gold)">*</span></label><select class="in vf" id="vf_destination" data-req="true"><option value="">— select —</option>${countryOptions('AE')}</select></div>
          <div class="field"><label>Visa country</label><select class="in" id="vCountry">${VISA_COUNTRIES.map((c) => `<option value="${c.code}"${c.code === 'AE' ? ' selected' : ''}>${c.flag} ${esc(c.name)}</option>`).join('')}</select></div>
          <div class="field"><label>Visa type</label><select class="in" id="vType">${VISA_TYPES_FE.map((t) => `<option value="${t.key}">${t.icon} ${esc(t.name)}</option>`).join('')}</select></div>
          <div class="field"><label>Purpose <span style="color:var(--gold)">*</span></label><select class="in vf" id="vf_purpose" data-req="true"><option value="">— select —</option>${['tourism', 'business', 'study', 'work', 'family', 'medical', 'transit'].map((p) => `<option>${p}</option>`).join('')}</select></div>
        </div>

        <div style="margin-top:14px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px"><span class="eyebrow" style="margin:0">Applicant information</span><span class="muted" style="font-size:11.5px">${Object.values(visaPrefill()).filter(Boolean).length ? '✓ auto-filled from your Master Travel Profile' : 'Tip: fill your Master Travel Profile in the Console to auto-fill this'}</span></div>
        <div class="composer-row" style="margin-top:6px">${(() => { const pf = visaPrefill(); return VISA_FORM_FIELDS.map((f) => visaFieldHTML(f, pf[f.key])).join(''); })()}</div>

        <div style="margin-top:14px"><span class="eyebrow">Verification signals (simulate upstream agent findings)</span></div>
        <div class="chips" style="margin-top:8px" id="vSignals">
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

        <div style="margin-top:16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <span class="eyebrow" style="margin:0">Required documents — attach each one</span>
          <span class="muted" style="font-size:12px" id="vDocsHint">Select destination & visa type to load the checklist</span>
        </div>
        <div id="vDocs" style="margin-top:8px"><div class="muted" style="font-size:13px"><span class="loader"></span> Loading checklist…</div></div>

        <div class="rel-bar" style="margin:14px 0 6px"><i id="vProgressBar" style="width:0%"></i></div>
        <div class="muted" style="font-size:12.5px" id="vProgress">—</div>
        <button class="btn btn-gold" id="vSubmit" style="margin-top:12px" disabled>▶ Run Visa Decision Agent Swarm</button>
        <div class="muted" style="font-size:11.5px;margin-top:6px" id="vGateNote">Complete all required fields and attach all documents to enable the AI run.</div>
      </div>
      <div id="visaDecision" style="margin-top:20px"></div>
    </div>`;

  $('#vSubmit').addEventListener('click', submitVisa);
  // Re-evaluate the gate on every change; reload documents when trip/type changes.
  out.querySelectorAll('.vf').forEach((el) => el.addEventListener('input', updateVisaGate));
  $('#vf_destination').addEventListener('change', loadVisaDocs);
  $('#vCountry').addEventListener('change', loadVisaDocs);
  $('#vType').addEventListener('change', loadVisaDocs);
  loadVisaDocs();
}

// Load the country/type-specific checklist and render each document as an
// attach-toggle. The AI run stays locked until every document is attached.
async function loadVisaDocs() {
  const box = $('#vDocs');
  if (!box) return;
  box.innerHTML = '<div class="muted" style="font-size:13px"><span class="loader"></span> Building checklist…</div>';
  let d;
  try {
    d = await api('/api/visa/checklist', { method: 'POST', body: JSON.stringify({ country: $('#vCountry').value, visaType: $('#vType').value, applicant: applicantFromForm() }) });
  } catch { return; }
  const hint = $('#vDocsHint'); if (hint) hint.textContent = `${d.totalDocuments} documents${d.country ? ' · ' + d.country.name : ''}`;
  let idx = 0;
  box.innerHTML = d.sections.map((s) => `
    <div style="margin-top:10px"><div class="muted" style="font-size:12px;font-weight:600">${esc(s.title)} · ${s.items.length}</div>
      ${s.items.map((it) => {
        const id = `vdoc_${idx++}`;
        return `<label for="${id}" class="vdoc-row"><input type="checkbox" class="vdoc-check" id="${id}" onchange="updateVisaGate()"> <span>${esc(it)}</span> <span class="vdoc-tag">attach</span></label>`;
      }).join('')}</div>`).join('');
  updateVisaGate();
}

// Gate: enable the AI run ONLY when all required fields are filled AND every
// document is attached.
function updateVisaGate() {
  const reqEls = [...document.querySelectorAll('.vf[data-req="true"]')];
  const filled = reqEls.filter((el) => el.value && el.value.trim());
  const docs = [...document.querySelectorAll('.vdoc-check')];
  const attached = docs.filter((c) => c.checked);
  const ready = reqEls.length > 0 && filled.length === reqEls.length && docs.length > 0 && attached.length === docs.length;
  const btn = $('#vSubmit'); if (btn) btn.disabled = !ready;
  const bar = $('#vProgressBar');
  const totalItems = reqEls.length + docs.length;
  const done = filled.length + attached.length;
  if (bar) bar.style.width = totalItems ? Math.round((done / totalItems) * 100) + '%' : '0%';
  const prog = $('#vProgress');
  if (prog) prog.innerHTML = `Fields ${filled.length}/${reqEls.length} · Documents ${attached.length}/${docs.length}` + (ready ? ' · <span style="color:var(--green)">✓ file complete — AI ready</span>' : '');
  const note = $('#vGateNote'); if (note) note.style.display = ready ? 'none' : 'block';
}
window.updateVisaGate = updateVisaGate;

// Visa framework metadata (mirrors backend visa-framework.js).
const VISA_COUNTRIES = [
  { code: 'SCHENGEN', name: 'Schengen / EU', flag: '🇪🇺' }, { code: 'GB', name: 'United Kingdom', flag: '🇬🇧' },
  { code: 'US', name: 'United States', flag: '🇺🇸' }, { code: 'CA', name: 'Canada', flag: '🇨🇦' },
  { code: 'AU', name: 'Australia', flag: '🇦🇺' }, { code: 'NZ', name: 'New Zealand', flag: '🇳🇿' },
  { code: 'AE', name: 'UAE / Dubai', flag: '🇦🇪' }, { code: 'SA', name: 'Saudi Arabia', flag: '🇸🇦' },
  { code: 'QA', name: 'Qatar', flag: '🇶🇦' }, { code: 'TR', name: 'Turkey', flag: '🇹🇷' },
  { code: 'CN', name: 'China', flag: '🇨🇳' }, { code: 'JP', name: 'Japan', flag: '🇯🇵' },
  { code: 'KR', name: 'South Korea', flag: '🇰🇷' }, { code: 'ZA', name: 'South Africa', flag: '🇿🇦' },
  { code: 'IN', name: 'India', flag: '🇮🇳' }, { code: 'BR', name: 'Brazil', flag: '🇧🇷' },
];
const VISA_TYPES_FE = [
  { key: 'tourist', name: 'Tourist / Visitor', icon: '🏖️' }, { key: 'business', name: 'Business', icon: '💼' },
  { key: 'student', name: 'Student', icon: '🎓' }, { key: 'work', name: 'Work', icon: '🛠️' },
  { key: 'family', name: 'Family / Dependant', icon: '👨‍👩‍👧' }, { key: 'medical', name: 'Medical', icon: '🏥' },
  { key: 'transit', name: 'Transit', icon: '🛫' },
];

// Full ISO 3166-1 alpha-2 code list. Names + flags are derived at runtime from
// the browser (Intl.DisplayNames + regional-indicator emoji) so we don't ship a
// long hard-coded name table.
const COUNTRY_CODES = ('AF AL DZ AD AO AG AR AM AU AT AZ BS BH BD BB BY BE BZ BJ BT BO BA BW BR BN BG BF BI CV KH CM CA CF TD CL CN CO KM CG CD CR CI HR CU CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FJ FI FR GA GM GE DE GH GR GD GT GN GW GY HT HN HU IS IN ID IR IQ IE IL IT JM JP JO KZ KE KI KW KG LA LV LB LS LR LY LI LT LU MG MW MY MV ML MT MH MR MU MX FM MD MC MN ME MA MZ MM NA NR NP NL NZ NI NE NG MK NO OM PK PW PA PG PY PE PH PL PT QA RO RU RW KN LC VC WS SM ST SA SN RS SC SL SG SK SI SB SO ZA KR SS ES LK SD SR SE CH SY TW TJ TZ TH TL TG TO TT TN TR TM TV UG UA AE GB US UY UZ VU VE VN YE ZM ZW').split(' ');
let __regionNames; try { __regionNames = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { __regionNames = null; }
function countryName(code) { try { return __regionNames ? __regionNames.of(code) : code; } catch { return code; } }
function flagEmoji(code) { return /^[A-Z]{2}$/.test(code) ? code.replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0))) : '🏳️'; }
function countryOptions(selected) {
  return COUNTRY_CODES
    .map((c) => ({ code: c, name: countryName(c) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => `<option value="${c.code}"${c.code === selected ? ' selected' : ''}>${flagEmoji(c.code)} ${esc(c.name)}</option>`)
    .join('');
}

function ageOf(dob) {
  if (!dob) return undefined;
  const t = Date.parse(dob);
  if (Number.isNaN(t)) return undefined;
  return Math.floor((Date.now() - t) / (365.25 * 24 * 3600 * 1000));
}
function applicantFromForm() {
  const sig = {};
  $$('.vsig').forEach((el) => { sig[el.dataset.key] = el.dataset.on === 'true'; });
  const v = (k) => { const el = $(`#vf_${k}`); return el ? el.value.trim() : ''; };
  return {
    fullName: v('fullName'), name: v('fullName') || 'Applicant',
    nationality: v('nationality') || 'GB',
    destination: v('destination') ? countryName(v('destination')) : '',
    purpose: v('purpose') || 'tourism',
    age: ageOf(v('dob')),
    dob: v('dob'),
    occupation: v('occupation'), employer: v('employer'),
    monthlyIncome: Number(v('monthlyIncome')) || 0,
    maritalStatus: v('maritalStatus') || 'Single',
    passportNumber: v('passportNumber'), passportExpiry: v('passportExpiry'),
    previousRefusals: v('previousRefusals'),
    overstayHistory: v('overstayHistory'),
    homeTies: 'strong',
    behaviourHesitation: Number($('#vBeh')?.value) || 10, ...sig,
  };
}

// (removed showVisaChecklist — a redundant orphan; the live checklist is built
// and rendered by loadVisaDocs on country change, into #vDocs.)
function signalToggle(key, label, on) {
  return `<span class="chip vsig ${on ? 'on' : ''}" data-key="${key}" data-on="${on}" onclick="toggleSignal(this)">${on ? '✓' : '○'} ${label}</span>`;
}
window.toggleSignal = (el) => { const on = el.dataset.on !== 'true'; el.dataset.on = on; el.classList.toggle('on', on); el.textContent = `${on ? '✓' : '○'} ${el.textContent.slice(2)}`; };

async function submitVisa() {
  const applicant = applicantFromForm();
  // The robust list of documents the applicant attached for THIS application.
  const providedDocuments = [...document.querySelectorAll('.vdoc-row')]
    .filter((r) => r.querySelector('.vdoc-check')?.checked)
    .map((r) => r.querySelector('span')?.textContent.trim())
    .filter(Boolean);
  const out = $('#visaDecision');
  const agents = ['Document Forensics', 'Financial Authenticity', 'Identity Verification', 'Online Footprint', 'Behavioural Intelligence', 'Overstay Risk', 'Fraud Detection', 'Intent Assessment', 'Border Risk', 'Decision Agent'];
  out.innerHTML = `<div class="card pad scanlog">${agents.map((a, i) => `<div class="ln" style="animation-delay:${i * 60}ms"><span class="ok">●</span> ${a} Agent verifying…</div>`).join('')}</div>`;
  await tick(700);
  let data;
  try {
    data = await api('/api/visa/assess-application', {
      method: 'POST',
      body: JSON.stringify({ applicant, country: $('#vCountry').value, visaType: $('#vType').value, providedDocuments }),
    });
  } catch { return; }
  // CONFIDENTIAL: the AI's verdict goes to the EMBASSY OFFICER only. The
  // applicant gets a receipt — they learn the outcome when the officer
  // releases the decision (notification + official letter).
  $('#visaDecision').innerHTML = `
    <div class="card pad" style="border-color:rgba(78,161,255,0.35)">
      <span class="eyebrow">Application submitted</span>
      <h3 style="margin:8px 0 4px">Under embassy review</h3>
      <p class="muted" style="font-size:13.5px">Your application <strong style="color:var(--gold)">${esc(data.applicationId || '')}</strong> and ${data.received || 0} document${(data.received || 0) === 1 ? '' : 's'} have been received and passed to the embassy. Decisions are made by an authorised officer — you'll be notified here and by email the moment your decision letter is issued.</p>
      ${(data.missingDocuments || []).length ? `<div style="margin-top:8px"><span class="t-label">Still missing (submitting these speeds up review)</span>${data.missingDocuments.map((m) => `<div class="x-line">• ${esc(m)}</div>`).join('')}</div>` : ''}
      <p class="muted" style="font-size:11.5px;margin-top:10px">Track status in Console → My visa applications.</p>
    </div>`;
  // Save captured identity back to the Master Travel Profile (retrieved
  // automatically next time across visa & bookings).
  if (state.user) {
    const tp = {
      fullLegalName: applicant.fullName, dob: applicant.dob, nationality: applicant.nationality,
      passportNumber: applicant.passportNumber, passportExpiry: applicant.passportExpiry,
      maritalStatus: applicant.maritalStatus, occupation: applicant.occupation,
      employer: applicant.employer, monthlyIncome: applicant.monthlyIncome,
    };
    Object.keys(tp).forEach((k) => { if (!tp[k]) delete tp[k]; });
    api(`/api/account/${state.user.id}`, { method: 'PATCH', body: JSON.stringify({ travelProfile: tp }) })
      .then((d) => { if (d.user) state.user = d.user; }).catch(() => {});
  }
}

// Render the full decision-ready file: recommendation + checklist completeness +
// document verification + fraud battery + the risk decision.
// (removed renderVisaFile + renderVisaDecision — dead code that exposed the AI
// officer verdict; the applicant view is a confidential "under embassy review"
// receipt via submitVisa, and the embassy view is renderVisaGov.)

async function renderVisaGov() {
  const out = $('#visaosOut');
  // Embassy workspace is a government account feature.
  const isEmbassy = state.user && (state.user.allAccess || ['embassy', 'consulate', 'admin'].includes(state.user.role));
  if (!isEmbassy) {
    out.innerHTML = `<div class="card pad center" style="max-width:560px;margin:0 auto">
      <div style="font-size:34px">🏛️</div>
      <h3 style="margin:10px 0 6px">Embassy / Government workspace</h3>
      <p class="muted" style="font-size:14px">This is a secured government account area — embassy officers review each application's full information and documents and issue decisions. Requires an <strong>embassy</strong> or admin account.</p>
      <button class="btn btn-gold" style="margin-top:12px" onclick="provisionTest()">Open with full-access demo</button>
    </div>`;
    return;
  }
  let data, apps, chain;
  try { data = await api('/api/visaos/government'); apps = await api('/api/visaos/applications'); } catch { return; }
  try { chain = await api('/api/visaos/audit-chain'); } catch { chain = null; }
  const g = data.analytics;
  window.__visaApps = {};
  (apps.applications || []).forEach((a) => { window.__visaApps[a.id] = a; });
  const kpis = [
    ['Applications', g.applications], ['Approval rate', g.approvalRate + '%'],
    ['Fraud attempts', g.fraudAttempts], ['Fully digital', `${g.autoDigitalRate}% <span style="font-size:10px;color:var(--muted)">target ${(g.digitalTargetPct || [90, 95]).join('–')}%</span>`],
    ['Avg risk', g.avgScore], ['Usage revenue', '£' + (g.revenue?.totalUsageGBP ?? 0).toLocaleString()],
  ].map(([k, v]) => `<div class="card pad kpi"><div class="kpi-v">${v}</div><div class="kpi-k">${k}</div></div>`).join('');
  const decisions = Object.entries(g.decisions || {}).map(([k, v]) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`).join('') || '<div class="muted" style="font-size:13px">No applications yet — run one in the Applicant tab.</div>';
  const countries = (g.topCountries || []).map((c) => `<div class="kv"><span>${c.country}</span><span>${c.count}</span></div>`).join('') || '<div class="muted" style="font-size:13px">—</div>';
  // Application queue — each row opens the full file (info + documents + AI).
  const queue = (apps.applications || []).length
    ? (apps.applications || []).map((a) => {
        const st = a.embassyDecision ? a.embassyDecision.decision : (a.status === 'submitted' ? 'Awaiting review' : a.status);
        const col = a.embassyDecision ? (a.embassyDecision.decision === 'Approved' ? 'var(--green)' : a.embassyDecision.decision === 'Refused' ? '#ff6b6b' : 'var(--blue-bright)') : 'var(--gold)';
        return `<div class="kv" style="cursor:pointer" onclick="openVisaApp('${a.id}')">
          <span><span class="vstatus ${a.totalScore <= 200 ? 'pass' : a.totalScore <= 450 ? 'watch' : 'fail'}"></span>${esc(a.applicant.name || 'Applicant')} · ${esc(a.applicant.nationality || '')} → ${esc(a.country || a.applicant.destination || '')}</span>
          <span style="color:${col};font-size:12.5px">${esc(st)} · ${a.totalScore}</span></div>`;
      }).join('')
    : '<div class="muted" style="font-size:13px">No applications yet — submit one in the Applicant tab.</div>';
  const dash = '—';
  const highRisk = (g.highRiskCountries || []).map((c) => `<div class="kv"><span>${esc(c.country)}</span><span style="color:#ff8a8a">${c.avgScore} avg · ${c.applications} apps</span></div>`).join('') || `<div class="muted" style="font-size:13px">No high-risk countries (avg > 450) in current volume.</div>`;
  const overstay = (g.overstayTrends || []).map((c) => `<div class="kv"><span>${esc(c.country)}</span><span>${c.avgOverstayRisk}/100</span></div>`).join('') || `<div class="muted" style="font-size:13px">${dash}</div>`;
  const pt = g.processingTimes || {};
  const processing = `
    <div class="kv"><span>Decision target</span><span>${pt.targetMinutes ?? 5} minutes</span></div>
    <div class="kv"><span>Auto-decided</span><span>${pt.autoDecided ?? 0} (${pt.autoDecidedPct ?? 0}%)</span></div>
    <div class="kv"><span>Escalated to human</span><span>${pt.escalatedToHuman ?? 0}</span></div>`;
  const perf = (g.agentPerformance || []).map((a) => `<div class="kv"><span>${esc(a.agent)}</span><span><span style="color:var(--green)">${a.pass}✓</span> · ${a.watch}⚠ · <span style="color:#ff8a8a">${a.fail}✕</span> · ${a.passRatePct}%</span></div>`).join('') || `<div class="muted" style="font-size:13px">Runs appear after the first assessment.</div>`;
  const rev = g.revenue ? `
    <div class="kv"><span>Per-application fees</span><span>£${g.revenue.perApplicationGBP.toLocaleString()}</span></div>
    <div class="kv"><span>AI processing fees</span><span>£${g.revenue.aiProcessingGBP.toLocaleString()}</span></div>
    <div class="kv"><span>Biometric fees</span><span>£${g.revenue.biometricGBP.toLocaleString()}</span></div>
    <div class="kv"><span><strong>Usage revenue total</strong></span><span style="color:var(--gold)"><strong>£${g.revenue.totalUsageGBP.toLocaleString()}</strong></span></div>
    <p class="muted" style="font-size:11px;margin-top:8px">Plus recurring: SaaS license £250k/yr · fraud-intelligence £4,999/mo · Border Intelligence API £0.15/call.</p>` : '';
  const alerts = (g.securityAlerts || []).map((a) => `<div class="kv"><span>🛑 ${esc(a.nationality)} → ${esc(a.destination || '')}</span><span style="color:#ff8a8a">security ${a.securityRisk}/100</span></div>`).join('') || `<div class="muted" style="font-size:13px">No active security alerts.</div>`;
  const chainOk = chain?.integrity?.ok ?? g.auditChain?.ok;
  const chainBadge = `<div class="kv"><span>Chain integrity</span><span style="color:${chainOk ? 'var(--green)' : '#ff6b6b'}">${chainOk ? '✓ Intact' : '✕ TAMPERED — investigate'}</span></div>
    <div class="kv"><span>Sealed blocks</span><span>${chain?.integrity?.blocks ?? g.auditChain?.blocks ?? 0}</span></div>
    ${(chain?.blocks || []).slice(0, 5).map((b) => `<div class="kv"><span class="muted" style="font-size:11px">#${b.index} ${esc(b.event)}</span><span class="muted" style="font-size:11px">${esc((b.hash || '').slice(0, 14))}…</span></div>`).join('')}`;
  // EMBASSY vs CONSULATE: the embassy SETS the country's policy (criteria,
  // fees, branding, templates); a consulate PROCESSES applications under that
  // policy — full decision powers on its queue, no policy control.
  const isConsulate = state.user?.role === 'consulate' && !state.user?.allAccess;
  out.innerHTML = `
    <div class="card pad" style="border-color:rgba(216,180,106,.45);margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
      <div>
        <span class="eyebrow">${isConsulate ? '🛂 Consulate eVisa Processing Centre' : '🛡 Embassy Decision Command Centre'}</span>
        <div style="font-family:'Space Grotesk';font-weight:700;font-size:17px;margin-top:2px">${isConsulate ? 'You process and decide — under the Embassy\'s policy.' : 'You hold full policy and decision authority.'}</div>
        <p class="muted" style="font-size:12.5px;margin:4px 0 0;max-width:620px">${isConsulate
          ? 'The AI screens every file and proposes against the <strong>Embassy\'s</strong> criteria. You confirm, refuse or request more on your queue; high-risk overrides need the approval chain. The Embassy sets the criteria, fees, branding and letter language — you work within them; every action is sealed in the audit chain.'
          : 'The AI screens every file and proposes against <strong>your</strong> criteria — you confirm, override, refuse or request more. Applicants see <strong>nothing</strong> until you release the decision. You set the visa fees, the refusal reasons, the visa conditions, and the letter carries your embassy\'s name, seal and language.'}</p>
      </div>
      ${isConsulate
        ? '<span class="chip" style="color:var(--gold);border-color:rgba(216,180,106,.4)">🔒 Policy set by the Embassy</span>'
        : '<button class="btn btn-gold btn-sm" onclick="openEmbassySettings()">⚙ Set criteria · fees · branding · language</button>'}
    </div>
    <div class="kpi-grid">${kpis}</div>
    <div class="console-grid" style="margin-top:20px">
      <div>
        <div class="card pad"><span class="eyebrow">Application queue · click to review</span>${queue}</div>
        <div class="card pad" style="margin-top:16px"><span class="eyebrow">Agent performance · live swarm runs</span>${perf}</div>
        <div class="card pad" style="margin-top:16px"><span class="eyebrow">Security alerts</span>${alerts}</div>
      </div>
      <div>
        <div class="card pad"><span class="eyebrow">Decisions</span>${decisions}</div>
        <div class="card pad" style="margin-top:16px"><span class="eyebrow">Processing times</span>${processing}</div>
        <div class="card pad" style="margin-top:16px"><span class="eyebrow">High-risk countries</span>${highRisk}</div>
        <div class="card pad" style="margin-top:16px"><span class="eyebrow">Overstay trends</span>${overstay}</div>
        <div class="card pad" style="margin-top:16px"><span class="eyebrow">Top applicant countries</span>${countries}</div>
        <div class="card pad" style="margin-top:16px"><span class="eyebrow">Government revenue</span>${rev}</div>
        <div class="card pad" style="margin-top:16px"><span class="eyebrow">Blockchain audit trail</span>${chainBadge}</div>
      </div>
    </div>
    <div id="visaAppDetail" style="margin-top:20px"></div>`;
}

// Embassy: open the full application — robust info + every document provided + AI.
window.openVisaApp = async (id) => {
  const a = window.__visaApps?.[id];
  if (!a) return;
  // The AI PROPOSAL, banded by THIS embassy's configured criteria, plus the
  // embassy's refusal-reason and visa-condition templates for the officer.
  let prop = null;
  try { prop = await api(`/api/embassy/applications/${id}/proposal`); } catch { /* defaults apply */ }
  const fa = a.fullApplicant || a.applicant || {};
  const infoRows = Object.entries(fa)
    .filter(([k, v]) => v !== '' && v != null && typeof v !== 'object')
    .map(([k, v]) => `<div class="kv"><span class="muted" style="font-size:12px">${esc(k)}</span><span style="font-size:12.5px">${esc(String(v))}</span></div>`).join('');
  const docs = (a.documents || []).length
    ? (a.documents || []).map((d) => `<div class="ok-line"><span class="ck">📎</span>${esc(d)}</div>`).join('')
    : '<div class="muted" style="font-size:13px">No documents recorded.</div>';
  const f = a.file || {};
  const fraud = f.fraud ? `${f.fraud.flagCount}/${f.fraud.results.length} flags` : '—';
  const docv = f.documentVerification ? `${f.documentVerification.verified}/${f.documentVerification.total} verified` : '—';
  const dec = a.embassyDecision;
  $('#visaAppDetail').innerHTML = `
    <div class="card pad">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;align-items:baseline">
        <strong style="font-family:'Space Grotesk';font-size:18px">${esc(fa.fullName || a.applicant.name || 'Applicant')}</strong>
        <span class="muted" style="font-size:12.5px">${esc(a.country)} · ${esc(a.visaType)} · AI: ${esc(a.recommendation || a.decision)} · risk ${a.totalScore}/1000</span>
      </div>
      <div class="console-grid" style="margin-top:14px">
        <div><span class="eyebrow">Information provided (${Object.keys(fa).length})</span>${infoRows || '<div class="muted" style="font-size:13px">—</div>'}</div>
        <div><span class="eyebrow">Documents provided (${(a.documents || []).length})</span>${docs}
          <div style="margin-top:10px"><span class="eyebrow">AI checks</span>
            <div class="kv"><span>Document verification</span><span>${docv}</span></div>
            <div class="kv"><span>Fraud battery</span><span>${fraud}</span></div>
          </div></div>
      </div>
      ${prop?.proposal ? `
      <div class="card pad" style="margin-top:14px;border-color:rgba(78,161,255,0.35)">
        <span class="eyebrow">AI proposal · banded by your embassy criteria</span>
        <div style="margin-top:6px"><strong style="color:${prop.proposal.proposal === 'Approved' ? 'var(--green)' : prop.proposal.proposal === 'Refused' ? '#ff8a8a' : 'var(--gold)'}">${esc(prop.proposal.proposal)}</strong>
        <span class="muted" style="font-size:12.5px"> — ${esc(prop.proposal.why)}</span></div>
      </div>` : ''}
      ${dec
        ? `<div class="card pad" style="margin-top:14px;border-color:rgba(70,211,154,0.3)"><strong>Embassy decision: ${esc(dec.decision)}</strong>
            <span class="chip" style="font-size:10.5px;margin-left:8px;color:${dec.released ? 'var(--green)' : 'var(--gold)'};border-color:${dec.released ? 'rgba(70,211,154,.4)' : 'rgba(216,180,106,.4)'}">${dec.released ? '✓ RELEASED to applicant' : '🔒 CONFIDENTIAL — applicant not yet informed'}</span>
            <div class="muted" style="font-size:12.5px;margin-top:4px">${esc(dec.reason || '')}${(dec.conditions || []).length ? '<br>Conditions: ' + dec.conditions.map(esc).join(' · ') : ''} · ${new Date(dec.at).toLocaleString()}</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
              ${!dec.released ? `<button class="btn btn-gold btn-sm" onclick="releaseVisa('${a.id}')">📤 Release decision to applicant</button>` : ''}
              <button class="btn btn-ghost btn-sm" onclick="viewVisaLetter('${a.id}')">📄 Embassy decision letter</button>
            </div></div>`
        : `<div style="margin-top:14px"><span class="eyebrow">Officer decision · confirm or override the AI proposal</span>
            ${prop?.templates?.refusalReasons?.length ? `
            <div class="field" style="margin-top:8px"><label>Reason template (or write your own below)</label>
              <select class="in" id="embReasonTpl" onchange="if(this.value)$('#embReason').value=this.value">
                <option value="">— pick a configured reason —</option>
                ${prop.templates.refusalReasons.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}
              </select></div>` : ''}
            <textarea class="in" id="embReason" placeholder="Reason / notes (recorded in the audit log and shown on the decision letter)" style="width:100%;min-height:54px;margin-top:6px"></textarea>
            ${prop?.templates?.approvalConditions?.length ? `
            <div style="margin-top:8px"><span class="t-label">Visa conditions (attached to an approval)</span>
              ${prop.templates.approvalConditions.map((c, i) => `<label style="display:block;font-size:12.5px;margin:3px 0"><input type="checkbox" class="embCond" value="${esc(c)}"> ${esc(c)}</label>`).join('')}
            </div>` : ''}
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
              ${prop?.proposal ? `<button class="btn btn-gold btn-sm" onclick="decideVisa('${a.id}','${esc(prop.proposal.proposal)}')">✓ Confirm AI proposal (${esc(prop.proposal.proposal)})</button>` : ''}
              <button class="btn ${prop?.proposal?.proposal === 'Approved' ? 'btn-ghost' : 'btn-gold'} btn-sm" onclick="decideVisa('${a.id}','Approved')">✓ Approve</button>
              <button class="btn btn-ghost btn-sm" onclick="decideVisa('${a.id}','More info requested')">Request more info</button>
              <button class="btn btn-ghost btn-sm" onclick="decideVisa('${a.id}','Escalated')">Escalate</button>
              <button class="btn btn-ghost btn-sm" onclick="decideVisa('${a.id}','Refused')" style="color:#ff8a8a">✕ Refuse</button>
            </div></div>`}
    </div>`;
  $('#visaAppDetail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};
window.decideVisa = async (id, decision, secondApproverId) => {
  const reason = $('#embReason')?.value || '';
  const conditions = [...document.querySelectorAll('.embCond:checked')].map((el) => el.value);
  let d;
  try {
    d = await api(`/api/visaos/applications/${id}/decide`, { method: 'POST', body: JSON.stringify({ decision, reason, secondApproverId, conditions }) });
  } catch (e) {
    // Anti-corruption layer: approving against a high-risk AI verdict is an
    // override — it needs a written reason AND a second approver.
    const msg = String(e?.message || e);
    if (/override-requires-reason|written reason/i.test(msg)) { toast('⚠ Override: a written reason is mandatory — add it in the notes box.'); return; }
    if (/override-requires-approval-chain|second approver/i.test(msg)) {
      const second = prompt('Anti-corruption override: enter the SECOND approver\'s officer ID (no single officer can approve a high-risk case alone):');
      if (second) return window.decideVisa(id, decision, second.trim());
      toast('Override cancelled — approval chain incomplete.');
      return;
    }
    return;
  }
  const o = d.application?.embassyDecision;
  toast(o?.override ? `✓ OVERRIDE recorded with approval chain [${o.approvalChain.join(' → ')}] — sealed in the audit trail.` : `✓ Decision recorded: ${decision}`);
  renderVisaGov();
};
// Officer releases the decision — ONLY now does the applicant learn the outcome.
window.releaseVisa = async (id) => {
  try { await api(`/api/visaos/applications/${id}/release`, { method: 'POST', body: JSON.stringify({}) }); }
  catch { toast('Could not release the decision.'); return; }
  toast('✓ Decision released — the applicant has been notified and can now open their letter.');
  renderVisaGov();
};
// Embassy-branded decision letter (opens in a new tab; applicant sees the same).
window.viewVisaLetter = async (id) => {
  try {
    const headers = {};
    if (state.user) headers['x-user-id'] = state.user.id;
    if (state.staffPin) headers['x-staff-pin'] = state.staffPin;
    const res = await fetch(API_BASE + `/api/visaos/applications/${id}/letter`, { headers });
    if (!res.ok) { toast('Letter not available yet.'); return; }
    const html = await res.text();
    const w = window.open('', '_blank');
    if (w) { w.document.open(); w.document.write(html); w.document.close(); }
  } catch { toast('Could not open the letter.'); }
};

// ---- Embassy settings: criteria · branding · language · fees · templates ---
window.openEmbassySettings = async () => {
  let cfg;
  try { cfg = (await api('/api/embassy/config')).config; } catch { toast('Could not load embassy settings.'); return; }
  const feeRow = (type, f) => `<div class="kv"><span style="text-transform:capitalize">${type}</span>
    <span>£<input class="in" id="fee-${type}" type="number" min="0" value="${f.amountGBP}" style="width:80px;display:inline-block;padding:4px 8px"> ·
    <input class="in" id="days-${type}" type="number" min="0" value="${f.processingDays}" style="width:56px;display:inline-block;padding:4px 8px">d</span></div>`;
  modal(`
    <span class="eyebrow">Embassy settings · ${esc(cfg.country)}</span>
    <h3 style="margin:6px 0 4px">Govern how VisaOS works for your country</h3>
    <div class="field" style="margin-top:8px"><label>Embassy name (appears on every decision letter)</label><input class="in" id="embName" value="${esc(cfg.embassyName)}"></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
      <div class="field" style="flex:1;min-width:110px"><label>Seal (emoji)</label><input class="in" id="embSeal" value="${esc(cfg.branding.seal)}" maxlength="4"></div>
      <div class="field" style="flex:1;min-width:110px"><label>Primary colour</label><input class="in" id="embColor1" type="color" value="${esc(cfg.branding.primaryColor)}"></div>
      <div class="field" style="flex:1;min-width:110px"><label>Accent colour</label><input class="in" id="embColor2" type="color" value="${esc(cfg.branding.accentColor)}"></div>
      <div class="field" style="flex:1;min-width:130px"><label>Letter language</label>
        <select class="in" id="embLang">${['en', 'fr', 'ar', 'es'].map((l) => `<option value="${l}" ${cfg.language === l ? 'selected' : ''}>${{ en: 'English', fr: 'Français', ar: 'العربية', es: 'Español' }[l]}</option>`).join('')}</select></div>
    </div>
    <span class="eyebrow" style="margin-top:14px;display:block">Decision criteria · the AI proposes against these</span>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <div class="field" style="flex:1;min-width:130px"><label>Auto-approve ≤ score</label><input class="in" id="crAppr" type="number" value="${cfg.criteria.autoApproveMaxScore}"></div>
      <div class="field" style="flex:1;min-width:130px"><label>Auto-refuse ≥ score</label><input class="in" id="crRej" type="number" value="${cfg.criteria.autoRejectMinScore}"></div>
      <div class="field" style="flex:1;min-width:130px"><label>Security ceiling</label><input class="in" id="crSec" type="number" value="${cfg.criteria.securityRiskMax}"></div>
    </div>
    <label style="font-size:12.5px;display:block;margin-top:4px"><input type="checkbox" id="crDocs" ${cfg.criteria.requireDocsComplete ? 'checked' : ''}> Incomplete documents force "More info requested"</label>
    <span class="eyebrow" style="margin-top:14px;display:block">Visa fees · the price of an application (per type)</span>
    ${Object.entries(cfg.fees).map(([t, f]) => feeRow(t, f)).join('')}
    <span class="eyebrow" style="margin-top:14px;display:block">Refusal reason templates (one per line)</span>
    <textarea class="in" id="embRefusals" style="width:100%;min-height:80px">${esc(cfg.refusalReasons.join('\n'))}</textarea>
    <span class="eyebrow" style="margin-top:10px;display:block">Visa condition templates (one per line)</span>
    <textarea class="in" id="embConds" style="width:100%;min-height:80px">${esc(cfg.approvalConditions.join('\n'))}</textarea>
    <button class="btn btn-gold btn-block" style="margin-top:14px" onclick="saveEmbassySettings('${esc(cfg.country)}')">Save embassy settings</button>`);
};
window.saveEmbassySettings = async (country) => {
  const lines = (id) => ($(id)?.value || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const fees = {};
  document.querySelectorAll('[id^="fee-"]').forEach((el) => {
    const type = el.id.slice(4);
    fees[type] = { amountGBP: Number(el.value) || 0, processingDays: Number($(`#days-${type}`)?.value) || 0 };
  });
  const patch = {
    country,
    embassyName: $('#embName')?.value || undefined,
    language: $('#embLang')?.value || 'en',
    branding: { seal: $('#embSeal')?.value || '🛂', primaryColor: $('#embColor1')?.value, accentColor: $('#embColor2')?.value },
    criteria: { autoApproveMaxScore: Number($('#crAppr')?.value) || 220, autoRejectMinScore: Number($('#crRej')?.value) || 451, securityRiskMax: Number($('#crSec')?.value) || 60, requireDocsComplete: $('#crDocs')?.checked ?? true },
    fees,
    refusalReasons: lines('#embRefusals'),
    approvalConditions: lines('#embConds'),
  };
  try { await api('/api/embassy/config', { method: 'POST', body: JSON.stringify(patch) }); toast('✓ Embassy settings saved — criteria, branding, fees and templates now govern every review.'); closeModal(); renderVisaGov(); }
  catch { toast('Could not save settings.'); }
};

// ---- Communication Event Architecture (admin) -----------------------------
async function renderComms() {
  const out = $('#commsOut');
  if (!out) return;
  if (!(await ensurePrivilegedView('comms'))) { accessGate(out, 'Communications', 'admin'); return; }
  let d;
  try { d = (await api('/api/comms/architecture')).architecture; } catch { accessGate(out, 'Communications', 'admin'); return; }
  window.__comms = d;
  const sevColor = { info: 'var(--blue-bright)', success: 'var(--green)', warning: 'var(--gold)', critical: '#ff6b6b' };

  const kpis = [
    ['Catalogue events', d.totalEvents, `${d.categories} categories`],
    ['Mandatory notices', d.mandatory, 'bypass user opt-outs'],
    ['Messages delivered', `${d.deliveredCount}`, `of ${d.attemptedCount} attempted`],
    ['Channels wired', d.channelsWired, d.channels.join(' · ')],
  ].map(([k, v, sub]) => `<div class="card pad kpi"><div class="kpi-v">${v}</div><div class="kpi-k">${k}</div><div class="muted" style="font-size:10.5px;margin-top:4px">${esc(sub)}</div></div>`).join('');

  const coverage = d.channels.map((ch) => {
    const total = d.channelCoverage[ch] || 0; const sent = d.sentByChannel[ch] || 0;
    return `<div class="kv"><span style="text-transform:capitalize">${esc(ch)}</span><span>${total} events${sent ? ` · ${sent} sent` : ''}</span></div>`;
  }).join('');

  const eventOpts = d.catalogue.flatMap((c) => c.events.map((e) => `<option value="${e.key}">${esc(c.name)} · ${esc(e.name)} (${e.key})</option>`)).join('');
  const companyOpts = (d.companies || []).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');

  const recent = (d.recent || []).length
    ? d.recent.map((r) => `<div class="kv"><span><span class="vstatus ${r.status === 'sent' ? 'pass' : 'info'}"></span>${esc(r.channel)} · <strong>${esc(r.event)}</strong></span><span class="muted" style="font-size:12px">${esc(r.status)} · ${esc(r.provider)} · ${new Date(r.at).toLocaleTimeString()}</span></div>`).join('')
    : '<div class="muted" style="font-size:13px">No deliveries yet — fire a test below.</div>';

  const catalogue = d.catalogue.map((cat) => `
    <div class="card pad" style="margin-top:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline"><strong style="font-family:'Space Grotesk'">${esc(cat.name)}</strong><span class="muted" style="font-size:12px">${cat.count} events</span></div>
      <div style="margin-top:8px">${cat.events.map((e) => `
        <div class="comms-row">
          <div><div style="font-size:13.5px">${esc(e.name)} ${e.mandatory ? '<span class="role-badge" style="margin:0;color:#ff9b9b;border-color:rgba(255,90,90,0.3)">mandatory</span>' : ''}</div>
            <div class="muted" style="font-size:11.5px"><code>${esc(e.key)}</code> · ${esc(e.subject)}</div></div>
          <div style="display:flex;gap:5px;align-items:center;flex-shrink:0">
            <span class="sev-dot" style="background:${sevColor[e.severity]}" title="${e.severity}"></span>
            ${e.channels.map((ch) => `<span class="ch-chip">${esc(ch === 'inapp' ? 'in-app' : ch)}</span>`).join('')}
          </div>
        </div>`).join('')}</div>
    </div>`).join('');

  out.innerHTML = `
    <button class="btn btn-ghost btn-sm" style="margin-bottom:14px" onclick="nav('admin')">← Back to Admin</button>
    <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr)">${kpis}</div>
    <div class="console-grid" style="margin-top:20px">
      <div class="card pad"><span class="eyebrow">Channel coverage</span><p class="muted" style="font-size:12px;margin:6px 0 8px">How many catalogue events fire on each channel by default</p>${coverage}</div>
      <div class="card pad"><span class="eyebrow">Template QA</span>
        <p class="muted" style="font-size:12px;margin:6px 0 8px">Preview the branded email or fire any event to yourself across its channels.</p>
        <div class="field"><label>Event</label><select class="in" id="commsEvent">${eventOpts}</select></div>
        <div class="field" style="margin-top:8px"><label>Company brand</label><select class="in" id="commsCompany">${companyOpts}</select></div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" onclick="commsPreview()">Preview email</button>
          <button class="btn btn-gold btn-sm" onclick="commsTest()">Send test to me</button>
        </div>
        <div id="commsPreviewOut"></div>
      </div>
    </div>
    <div class="card pad scanlog" style="margin-top:16px"><span class="eyebrow">Recent deliveries</span><div style="margin-top:8px" id="commsRecent">${recent}</div></div>
    <div class="section-head left" style="margin:24px 0 6px"><h2 style="font-size:20px">Event catalogue · ${d.totalEvents} events · ${d.categories} categories</h2></div>
    ${catalogue}`;
}
window.commsPreview = async () => {
  const event = $('#commsEvent').value, company = $('#commsCompany').value;
  let d; try { d = await api('/api/comms/preview', { method: 'POST', body: JSON.stringify({ event, company }) }); } catch { return; }
  modal(`<span class="eyebrow">Email preview · ${esc(event)}</span>
    <p class="muted" style="font-size:12px">Exactly what a recipient receives — ${esc(d.company.name)} logo, brand colour and details.</p>
    <iframe style="width:100%;height:420px;border:1px solid var(--line);border-radius:10px;margin-top:10px;background:#fff" srcdoc="${esc(d.html).replace(/&quot;/g, '&quot;')}"></iframe>`);
};
window.commsTest = async () => {
  const event = $('#commsEvent').value;
  let d; try { d = await api('/api/comms/test', { method: 'POST', body: JSON.stringify({ event }) }); } catch { return; }
  toast(`✓ Fired ${event} across ${d.deliveries.length} channel${d.deliveries.length > 1 ? 's' : ''}`);
  renderComms();
};

// ---- Business / Enterprise Command Centre ---------------------------------
async function renderBusiness() {
  const out = $('#businessOut');
  if (!(await ensurePrivilegedView('business'))) { accessGate(out, 'Business', 'business or admin'); return; }
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
    <button class="btn btn-ghost btn-sm" style="margin-bottom:14px" onclick="nav('admin')">← Back to Admin</button>
    <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr)">${kpis}</div>
    <div class="console-grid" style="margin-top:20px">
      <div>
        <div class="card pad"><span class="eyebrow">Travel Policy</span>
          <div class="kv"><span>Max trip value (auto-approve)</span><span>$4,000</span></div>
          <div class="kv"><span>Cabin (long-haul)</span><span>Economy / Premium</span></div>
          <div class="kv"><span>Preferred payment</span><span>Card via Stripe (BitriPay coming soon)</span></div>
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
      ${contracts.length ? contracts.map((c) => `<div class="kv"><span>${esc(c.supplier)} <span class="muted">${esc(c.category)}</span></span><span>$${(c.annualVolumeUSD).toLocaleString()}/yr · <strong style="color:var(--green)">${(c.discountPct * 100).toFixed(1)}%</strong> · ${esc(c.status)}</span></div>`).join('') : '<div class="muted" style="font-size:13px">No contracts yet. The Supplier Negotiation Agent scales the discount with committed volume.</div>'}
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
    <span class="eyebrow">ACU Marketplace · bigger packs earn bonus ACUs</span>
    <h3 style="margin:6px 0">Top up AI Compute Units</h3>
    <p class="muted" style="font-size:13px">ACUs power your AI searches and actions at £1 = 100 ACU. Members auto-fund ACUs from 10% of their plan each month; top up any time — bigger top-ups earn a bonus.</p>
    ${[['top5', '£5', '500', ''], ['top10', '£10', '1,100', '+10% bonus'], ['top15', '£15', '1,800', '+20% bonus']]
      .map(([id, gbp, acu, bonus]) => `<div class="kv"><span>${acu} ACU ${bonus ? `<span style="color:var(--green);font-size:11px">${bonus}</span>` : ''}</span><button class="btn ${id === 'top15' ? 'btn-gold' : 'btn-ghost'} btn-sm" onclick="buyAcu('${id}')">${gbp}</button></div>`).join('')}
    <div class="kv" style="opacity:.8"><span>Family · 4,000 ACU</span><button class="btn btn-ghost btn-sm" onclick="buyAcu('family')">£29</button></div>
    <div class="kv"><span>Enterprise · custom volume</span><a class="btn btn-ghost btn-sm" href="mailto:sales@3jntravel.com">Contact sales</a></div>`);
};
window.buyAcu = async (pack) => {
  if (!state.user) { const u = await api('/api/account', { method: 'POST', body: JSON.stringify({ humanCheck: humanCheckPayload(false) }) }); setUser(u.user); }
  try { const data = await api(`/api/account/${state.user.id}/acu`, { method: 'POST', body: JSON.stringify({ pack }) });
    // Live mode: pay first — the wallet credits when the webhook confirms.
    if (data.checkout) { toast('💳 Opening secure checkout…'); window.location.href = data.checkout; return; }
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
  // Compact account chip: avatar + first name only — everything else lives in
  // the dropdown, so the top bar never overflows when signed in.
  const chip = $('#userChip');
  chip.classList.remove('hidden');
  chip.classList.add('account-chip');
  const firstName = (u.name || 'Account').split(' ')[0];
  chip.title = `${u.name} · ${u.tier} · ${u.points.toLocaleString()} pts`;
  chip.innerHTML = `${avatarHTML(u, 22)} ${esc(firstName)} <span class="caret">▾</span>`;
  chip.onclick = (e) => { e.stopPropagation(); toggleAccountMenu(); };
  try { localStorage.setItem('3jn_uid', u.id); } catch {}
  // Signed in: Sign in + Full Access buttons disappear (sign-out moves into
  // the account menu); the bar keeps only chip · bell · CTA.
  $('#signBtn')?.classList.add('hidden');
  applyRoleVisibility();
  applyStorefrontMode(); // staff sign-in re-enables the planner; customers stay Deals-first
  refreshNotifications();
}

// Re-fetch the signed-in account from the server (re-applies admin from the env
// allowlist, and forces a serverless instance to re-read the store if it was
// missing the account). Used to recover from a TRANSIENT privilege miss before
// showing an access gate, so instance-to-instance lag never locks staff out.
async function refreshUser() {
  const id = state.user?.id;
  if (!id) return false;
  try {
    const d = await api(`/api/account/${id}`, { silent: true, headers: { 'x-user-id': id } });
    if (d.user) { setUser(d.user); return true; }
  } catch {}
  return false;
}
// Confirm access to a privileged view, refreshing the account once (and retrying)
// before giving up — smooths over serverless instance inconsistency.
async function ensurePrivilegedView(view) {
  if (canAccessView(view)) return true;
  await refreshUser();
  if (canAccessView(view)) return true;
  await new Promise((r) => setTimeout(r, 600));
  await refreshUser();
  return canAccessView(view);
}

function toggleAccountMenu() {
  const existing = $('#accountMenu');
  if (existing) { existing.remove(); return; }
  const u = state.user;
  if (!u) return;
  const can = (roles) => u.allAccess || roles.includes(u.role);
  const item = (icon, label, fn) => `<div class="am-item" onclick="${fn}">${icon} ${label}</div>`;
  const menu = document.createElement('div');
  menu.id = 'accountMenu';
  menu.className = 'account-menu';
  menu.innerHTML = `
    <div class="am-head">${avatarHTML(u, 34)}<div><div class="am-name">${esc(u.name)}</div>
      <div class="am-sub">${esc(u.tier)} · ${u.points.toLocaleString()} pts${u.membership?.active ? ' · ' + esc(u.membership.name) : ''}</div></div></div>
    ${item('🧭', 'My Console', "closeAccountMenu();nav('console')")}
    ${item('🎁', 'Rewards · Refer & Earn', "closeAccountMenu();nav('rewards')")}
    ${item('🤝', 'Vendor Partner Programme', "closeAccountMenu();nav('vendors')")}
    ${item('🛂', 'VisaOS · Visa Centre', "closeAccountMenu();nav('visaos')")}
    ${item('🏠', 'Host Dashboard', 'closeAccountMenu();openHostDashboard()')}
    ${can(['business', 'admin']) ? item('💼', 'Business Centre', "closeAccountMenu();nav('business')") : ''}
    ${can(['embassy', 'consulate', 'admin']) ? item('🏛', 'Consulate / VisaOS', "closeAccountMenu();nav('visaos')") : ''}
    ${can(['admin']) ? item('🛡', 'Admin Centre', "closeAccountMenu();nav('admin')") : ''}
    <div class="am-sep"></div>
    ${item('🚪', 'Sign out', 'closeAccountMenu();signOut()')}`;
  $('#userChip').insertAdjacentElement('afterend', menu);
  // Close on any outside click.
  setTimeout(() => document.addEventListener('click', closeAccountMenu, { once: true }), 0);
  menu.addEventListener('click', (e) => e.stopPropagation());
}
window.closeAccountMenu = () => $('#accountMenu')?.remove();
async function restoreSession() {
  let uid; try { uid = localStorage.getItem('3jn_uid'); } catch {}
  if (!uid) return;
  try {
    // Send the stored id explicitly so the self-lookup authenticates even before
    // state.user is set — the endpoint also promotes an allowlisted owner to admin.
    const d = await api(`/api/account/${uid}`, { silent: true, headers: { 'x-user-id': uid } });
    if (d.user) setUser(d.user);
  } catch (e) {
    // A 404 can mean the account genuinely doesn't exist OR (right after a deploy /
    // on a fresh serverless instance) just isn't loaded here yet. Don't log the
    // user out outright: if Firebase can re-authenticate, let it rebuild the
    // session (and re-apply admin). Only clear the stored id when there's no
    // Firebase session to fall back on.
    if (e.status === 404) {
      if (window.firebaseAuth?.reauth) { try { if (await window.firebaseAuth.reauth()) return; } catch {} }
      try { localStorage.removeItem('3jn_uid'); } catch {}
      state.user = null;
    }
  }
}
window.signOut = () => {
  try { localStorage.removeItem('3jn_uid'); } catch {}
  if (window.firebaseAuth?.available) { try { window.firebaseAuth.signOut(); } catch {} }
  state.user = null;
  setStaffPin(''); // clear the persisted staff PIN on sign-out
  $('#userChip').classList.add('hidden');
  $('#accountMenu')?.remove();
  const signBtn = $('#signBtn');
  if (signBtn) { signBtn.textContent = 'Sign in'; signBtn.classList.remove('hidden'); }
  applyRoleVisibility();
  applyStorefrontMode(); // back to the customer (Deals-first) storefront on sign-out
  if (state.lastView === 'admin' || state.lastView === 'business') nav('home');
  toast('Signed out.');
};

// ---- Login / Signup -------------------------------------------------------
$('#signBtn')?.addEventListener('click', () => { if (state.user) return window.signOut(); openAuth('login'); });

// Bridge a Firebase identity to a backend account (get-or-create by email).
let firebaseBridging = false;
window.addEventListener('firebase-auth', async (e) => {
  if (firebaseBridging) return;
  firebaseBridging = true;
  try {
    const bridge = () => api('/api/auth/firebase', { method: 'POST', body: JSON.stringify({ idToken: e.detail.idToken, name: e.detail.name, staffPin: state.staffPin || undefined }) });
    let d;
    try { d = await bridge(); }
    catch (err) {
      // Staff/owner account: collect the PIN once and retry (state.staffPin then
      // rides on every future request via the x-staff-pin header).
      if (/PIN/i.test(err?.message || '')) {
        const pin = window.prompt('This is a staff account. Enter the staff access PIN:');
        if (!pin) return;
        setStaffPin(pin);
        try { d = await bridge(); } catch (e2) { toast('⚠ ' + (e2?.message || 'PIN not accepted.')); return; }
      } else {
        // Surface the real reason instead of failing silently (e.g. token could
        // not be verified, or an anti-bot block) so it's actionable.
        toast('⚠ ' + (err?.message || 'Sign-in could not be completed. Please try again.'));
        return;
      }
    }
    if (!d || !d.user) { toast('⚠ Sign-in did not return an account. Please try again.'); return; }
    setUser(d.user); closeModal();
    toast(`✓ Signed in as ${d.user.name}`);
    // Staff/admin accounts authenticate with the staff PIN, and their login email
    // is often a no-inbox alias (e.g. admin@…) — email verification is redundant
    // and impossible to action, so never nag them. Only customers see it.
    const isStaff = d.user.role === 'admin' || d.user.allAccess;
    if (!isStaff && e.detail && e.detail.emailVerified === false) {
      setTimeout(() => toast('📧 Please verify your email — check your inbox.'), 1600);
      showVerifyBanner();
    } else {
      $('#verifyBanner')?.remove();
    }
    // If they were sitting on a privileged view (e.g. the Admin gate) and are now
    // allowed in, re-render it so it flips straight to the dashboard. Otherwise
    // land them on the console.
    const active = $('.view.active')?.id?.replace('view-', '') || '';
    if (active && VIEW_ROLES[active] && canAccessView(active)) nav(active);
    else if (!$('#view-console').classList.contains('active')) nav('console');
  } catch {} finally { firebaseBridging = false; }
});
window.addEventListener('firebase-signout', () => { $('#verifyBanner')?.remove(); });
// When Firebase finishes loading (or fails), re-render an open auth modal so the
// password field + "forgot password" + Google button appear without a manual
// reopen, and refresh the storefront gating.
window.addEventListener('firebase-ready', () => {
  try { applyStorefrontMode(); } catch {}
  if (state.authModalOpen && $('#modalBg')?.classList.contains('show')) openAuth(state.authModalOpen);
});
// Persistent nudge until the email is verified — with one-tap resend.
function showVerifyBanner() {
  if ($('#verifyBanner')) return;
  const b = document.createElement('div');
  b.id = 'verifyBanner';
  b.style.cssText = 'position:sticky;top:0;z-index:60;background:linear-gradient(90deg,rgba(216,180,106,.16),rgba(216,180,106,.08));border-bottom:1px solid rgba(216,180,106,.35);padding:9px 16px;font-size:13px;display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap';
  b.innerHTML = `<span>📧 Verify your email to secure your account — check your inbox.</span>
    <button class="btn btn-ghost btn-sm" style="padding:5px 14px" onclick="resendVerifyEmail()">Resend email</button>
    <span style="cursor:pointer;color:var(--muted);font-size:16px;line-height:1" onclick="this.parentElement.remove()" title="Dismiss">×</span>`;
  document.body.prepend(b);
}
window.resendVerifyEmail = async () => {
  try {
    const sent = await window.firebaseAuth?.resendVerification();
    toast(sent ? '📧 Verification email re-sent — check your inbox (and spam).' : 'Sign in again to resend the verification email.');
  } catch (e) { toast(e.message || 'Could not resend — try again in a minute.'); }
};
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

// ---- Human verification (anti-bot) ----------------------------------------
// Signup/login are HUMAN-ONLY: honeypot + fill-time + interaction counting +
// a server-signed challenge. Bots and scripts are refused by the backend.
const HUMAN = { pageLoadedAt: Date.now(), interactions: 0, formOpenedAt: 0, challenge: null };
['keydown', 'pointerdown', 'pointermove', 'touchstart'].forEach((ev) =>
  document.addEventListener(ev, () => { HUMAN.interactions = Math.min(HUMAN.interactions + 1, 9999); }, { passive: true }));
async function fetchHumanChallenge() {
  try { HUMAN.challenge = await api('/api/auth/challenge'); } catch { HUMAN.challenge = null; }
  const el = $('#humanQ');
  if (el && HUMAN.challenge) el.textContent = HUMAN.challenge.question + ' =';
}
// ---- Analytics: Meta Pixel (1176409173894579) + GTM (GTM-WRNTT4HN) -----------
// One call feeds BOTH rails: fbq for Meta ads, dataLayer for GTM -> GA4 /
// Google Ads (with GA4-convention event names). Safe wrapper: never throws
// when a pixel is blocked — analytics can never break the product.
const GA4_EVENT_MAP = {
  Search: 'search',
  InitiateCheckout: 'begin_checkout',
  CompleteRegistration: 'sign_up',
  Purchase: 'purchase',
};
function metaTrack(event, params) {
  const p = params || {};
  try { if (typeof fbq === 'function') fbq('track', event, p); } catch { /* blocked — fine */ }
  try {
    window.dataLayer = window.dataLayer || [];
    const ga = { event: GA4_EVENT_MAP[event] || event.toLowerCase() };
    if (p.search_string) ga.search_term = p.search_string;
    if (p.value != null) { ga.value = p.value; ga.currency = p.currency || 'GBP'; }
    if (p.content_name) ga.item_name = p.content_name;
    if (event === 'Purchase' && p.content_ids && p.content_ids[0]) ga.transaction_id = p.content_ids[0];
    window.dataLayer.push(ga);
  } catch { /* blocked — fine */ }
}

function humanCheckPayload(full) {
  const c = HUMAN.challenge || {};
  return {
    website: $('#hpWebsite')?.value || '',                    // honeypot — must stay empty
    elapsedMs: Date.now() - (HUMAN.formOpenedAt || HUMAN.pageLoadedAt),
    interactions: HUMAN.interactions,
    ...(full ? { a: c.a, b: c.b, expiresAt: c.expiresAt, token: c.token, answer: Number($('#humanA')?.value || NaN) } : {}),
  };
}
// The human-challenge block rendered inside both auth forms.
function humanBlock() {
  return `
    <input id="hpWebsite" name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0" aria-hidden="true">
    <div class="field" style="margin-top:10px"><label>Human check · <span id="humanQ">…</span></label>
      <input class="in" id="humanA" inputmode="numeric" placeholder="Answer" autocomplete="off"></div>
    <p class="muted" style="font-size:11px;margin-top:6px">🛡 Signup and login are human-only — automated scripts are blocked.</p>`;
}

function openAuth(mode = 'signup') {
  HUMAN.formOpenedAt = Date.now();
  state.authModalOpen = mode; // so we can re-render once Firebase finishes loading
  const fb = window.firebaseAuth?.available;
  // If the Firebase SDK is still loading, tell the user password sign-in is on
  // its way (the field appears automatically when it's ready); if it errored,
  // say so plainly instead of silently hiding the password field.
  const fbNote = !fb ? (window.__fbAuthStatus === 'loading'
    ? '<p class="muted center" style="font-size:11.5px;margin:2px 0 8px">🔑 Loading secure password sign-in…</p>'
    : `<p class="muted center" style="font-size:11px;margin:2px 0 8px;color:var(--gold)">Password sign-in couldn't load (${esc(String(window.__fbAuthStatus || 'unknown'))}). Continue with email below, or tell your admin.</p>`) : '';
  // Google is the FRICTIONLESS primary path: one tap, no password to set, no
  // email to verify (Google addresses are pre-verified). Make it the prominent
  // button so most customers never touch the email/password fields at all.
  const googleBtn = fb ? '<button class="btn btn-gold btn-block" style="margin-bottom:6px;font-weight:700" onclick="googleSignIn()">Continue with Google — one tap</button><div class="muted center" style="font-size:11.5px;margin:8px 0 10px">Fastest way in. Or use email below.</div>' : '';
  // SIGNUP and LOGIN are separate, dedicated screens — never mixed.
  if (mode === 'login') {
    modal(`
      <span class="eyebrow">Log in</span>
      <h3 style="margin:6px 0 4px">Welcome back</h3>
      <p class="muted" style="font-size:13px">Sign in to your 3JN Travel OS account.</p>
      ${fbNote}${googleBtn}
      <div class="field" style="margin-top:8px"><label>Email</label><input class="in" id="liEmail" placeholder="you@email.com" autocomplete="email"></div>
      ${fb ? '<div class="field" style="margin-top:10px"><label>Password</label><input class="in" type="password" id="liPass" placeholder="••••••••" autocomplete="current-password"></div>' : ''}
      ${humanBlock()}
      <button class="btn btn-gold btn-block" style="margin-top:14px" onclick="doLogin()">Log in</button>
      ${fb ? '<p class="muted center" style="font-size:12px;margin-top:10px"><a onclick="forgotPassword()" style="color:var(--gold);cursor:pointer">Forgot password?</a></p>' : ''}
      <p class="muted center" style="font-size:12.5px;margin-top:12px">New to 3JN? <a style="color:var(--gold);cursor:pointer" onclick="openAuth('signup')">Create an account</a></p>
      <p class="muted center" style="font-size:11.5px;margin-top:8px;opacity:.75">🛡 <a style="color:var(--muted);cursor:pointer;text-decoration:underline" onclick="openStaffLogin()">Staff / Admin sign in</a> · 🧪 <a style="color:var(--muted);cursor:pointer;text-decoration:underline" onclick="openDemoAccounts()">Fully-loaded demo accounts</a></p>`);
  } else {
    modal(`
      <span class="eyebrow">Create account</span>
      <h3 style="margin:6px 0 4px">Join 3JN Travel OS</h3>
      <p class="muted" style="font-size:13px">One account for searches, bookings, ACUs, visas and your travel wallet.</p>
      ${fbNote}${googleBtn}
      <div class="field" style="margin-top:8px"><label>Name</label><input class="in" id="auName" placeholder="Your name" autocomplete="name"></div>
      <div class="field" style="margin-top:10px"><label>Email</label><input class="in" id="auEmail" placeholder="you@email.com" autocomplete="email"></div>
      ${fb ? '<div class="field" style="margin-top:10px"><label>Password</label><input class="in" type="password" id="auPass" placeholder="••••••••" autocomplete="new-password"></div>' : ''}
      <div class="field" style="margin-top:10px"><label>I am a…</label><select class="in" id="auRole"><option value="consumer">Traveller</option><option value="business">Business</option><option value="merchant">Merchant</option><option value="partner">Agency partner</option></select></div>
      <div class="field" style="margin-top:10px"><label>Referral code (optional)</label><input class="in" id="auRef" placeholder="3JN-XXXX"></div>
      ${humanBlock()}
      <button class="btn btn-gold btn-block" style="margin-top:14px" onclick="doSignup()">Create account · 250 pts bonus</button>
      <p class="muted center" style="font-size:12.5px;margin-top:12px">Already have an account? <a style="color:var(--gold);cursor:pointer" onclick="openAuth('login')">Log in</a></p>
      <p class="muted center" style="font-size:11.5px;margin-top:8px;opacity:.75">🧪 <a style="color:var(--muted);cursor:pointer;text-decoration:underline" onclick="openDemoAccounts()">Just exploring? Use a fully-loaded demo account</a></p>`);
  }
  fetchHumanChallenge();
}
window.openAuth = openAuth;
// Discreet staff/admin sign-in — same secure login; privileged areas then
// appear inside the account menu (never in the public top bar).
window.openStaffLogin = () => {
  HUMAN.formOpenedAt = Date.now();
  modal(`
    <span class="eyebrow">Staff / Admin access</span>
    <h3 style="margin:6px 0 4px">Sign in to your 3JN Travel OS staff account</h3>
    <p class="muted" style="font-size:13px">Admin, Business, Embassy and Consulate consoles open from your account menu after sign-in — they're never shown in the public navigation.</p>
    <div class="field" style="margin-top:8px"><label>Email</label><input class="in" id="liEmail" placeholder="you@3jntravel.com" autocomplete="email"></div>
    ${window.firebaseAuth?.available ? '<div class="field" style="margin-top:10px"><label>Password</label><input class="in" type="password" id="liPass" placeholder="••••••••" autocomplete="current-password"></div>' : ''}
    ${humanBlock()}
    <button class="btn btn-gold btn-block" style="margin-top:14px" onclick="doLogin()">Sign in</button>
    <p class="muted center" style="font-size:11.5px;margin-top:10px;opacity:.75">🧪 <a style="color:var(--muted);cursor:pointer;text-decoration:underline" onclick="openDemoAccounts()">Use a fully-loaded staff demo account</a></p>`);
  fetchHumanChallenge();
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
    try {
      const r = await window.firebaseAuth.signUp(email, pass, name);
      if (r && r.verificationSent === false) {
        toast(`Account created, but the verification email could not be sent (${r.verificationError || 'unknown'}). You can still use your account; tap Resend later.`);
      }
    } catch (e) { toast(e.message || 'Sign-up failed.'); }
    return;
  }
  if (!email) { toast('Enter your email.'); return; }
  if (!$('#humanA')?.value) { toast('Answer the human check to continue.'); return; }
  const body = { name, email, role: $('#auRole').value, referredByCode: $('#auRef').value.trim() || undefined, humanCheck: humanCheckPayload(true) };
  let d; try { d = await api('/api/account', { method: 'POST', body: JSON.stringify(body) }); } catch { fetchHumanChallenge(); return; }
  setUser(d.user); closeModal(); toast(`✓ Welcome, ${d.user.name}!`); nav('console');
  metaTrack('CompleteRegistration', { status: true });
};
window.doLogin = async () => {
  const email = $('#liEmail').value.trim();
  if (!email) { toast('Enter your email.'); return; }
  if (window.firebaseAuth?.available) {
    const pass = $('#liPass')?.value || '';
    try { await window.firebaseAuth.signIn(email, pass); } catch (e) { toast(e.message || 'Login failed.'); }
    return;
  }
  if (!$('#humanA')?.value) { toast('Answer the human check to continue.'); return; }
  let d;
  try { d = await api('/api/login', { method: 'POST', body: JSON.stringify({ email, humanCheck: humanCheckPayload(true) }) }); }
  catch (e) {
    // Staff accounts require the second factor: collect the PIN and retry once.
    if (/PIN/i.test(e?.message || '')) {
      const pin = window.prompt('This is a staff account. Enter the staff access PIN:');
      if (!pin) return;
      setStaffPin(pin);
      try { d = await api('/api/login', { method: 'POST', body: JSON.stringify({ email, humanCheck: humanCheckPayload(true), staffPin: pin }) }); }
      catch { toast('PIN not accepted.'); fetchHumanChallenge(); return; }
    } else { fetchHumanChallenge(); return; }
  }
  setUser(d.user); closeModal(); toast(`✓ Welcome back, ${d.user.name}!`); nav('console');
};

window.confirmQuote = async (id, sym) => {
  const val = Number(($(`#qrc-${id}`)?.value || '').replace(/[^0-9.]/g, ''));
  if (!(val > 0)) { toast('Enter the exact confirmed total.'); return; }
  try { await api(`/api/admin/quote-requests/${id}/confirm`, { method: 'POST', body: JSON.stringify({ confirmedTotalLocal: val }) }); }
  catch (e) { toast(e.message || 'Confirm failed.'); return; }
  toast(`✓ ${sym}${val} confirmed — customer notified to pay.`);
  renderAdmin();
};
window.reviewListing = async (id, decision) => {
  let reason = '';
  if (decision === 'reject') { reason = prompt('Reason for rejection (sent to the host):') || 'Did not pass review'; }
  try { await api(`/api/admin/listings/${id}/review`, { method: 'POST', body: JSON.stringify({ decision, reason }) }); }
  catch (e) { toast(e.message || 'Review failed.'); return; }
  toast(decision === 'approve' ? '✓ Property approved — now live for booking.' : '✕ Property rejected — host notified.');
  renderAdmin();
};
window.provisionTest = async () => {
  try { const data = await api('/api/account/test', { method: 'POST', body: JSON.stringify({}) });
    setUser(data.user);
    toast('✓ Voyager test account active.');
    nav('console');
  } catch { /* */ }
};

// ---- Fully-loaded demo accounts (one per role) -----------------------------
// Seeds all role accounts (admin, business, merchant, partner, consumer,
// embassy, consulate) — each pre-loaded with memberships, ACU, bookings,
// listings and queue data — and lets you sign in as any of them in one tap.
// Per-account meta: email wins over role (the host is a consumer WITH hosting
// power). Blurbs state the ACCOUNT'S AUTHORITY — what this account decides.
const DEMO_ACCOUNT_META = {
  'host@3jntravel.com': { icon: '🏠', label: 'Property Host', view: 'hosting', blurb: 'RUNS a live listing: The Palm Residence, Dubai Marina (approved, 12 photos) — full-page dashboard: set nightly price, pause/publish, publish new properties, see reservations & 90% payouts' },
};
const DEMO_ROLE_META = {
  admin: { icon: '🛡', label: 'Platform Admin', view: 'admin', blurb: 'RULES the platform: all 3JN income & AI-margin panels · approves/suspends vendors, influencers & host listings · sees every user, booking & support ticket · 10,500 ACU, Elite' },
  business: { icon: '🏢', label: 'Corporate Manager', view: 'business', blurb: 'CONTROLS company travel: approves/declines trip requests against policy · duty-of-care map · team bookings · 5,250 ACU float' },
  merchant: { icon: '💳', label: 'BitriPay Merchant', view: 'console', blurb: 'BitriPay SANDBOX preview: payment links & QR invoices (£420 demo) · settlement to the penny · live money runs on Stripe until BitriPay ships' },
  partner: { icon: '🤝', label: 'Agency Partner', view: 'console', blurb: 'RESELLS the OS: white-label production API key · revenue share on every booking through it' },
  consumer: { icon: '🧳', label: 'Test Traveller', view: 'console', blurb: 'LIVES the customer journey: paid Dubai booking with e-ticket · Travel+ Family plan · 1,930 ACU · savings pot · visa application AWAITING the embassy\'s decision' },
  embassy: { icon: '🏛', label: 'Embassy Officer', view: 'visaos', blurb: 'DECIDES visas with full authority: sets the country\'s criteria, fees & letter branding · sees the AI\'s confidential verdict on 3 pending files · approves, refuses or overrides with reasons & conditions · RELEASES the decision when ready' },
  consulate: { icon: '🛂', label: 'Consulate eVisa Officer', view: 'visaos', blurb: 'PROCESSES applications UNDER the Embassy\'s policy: decides its own queue (approve/refuse/more-info) but CANNOT change criteria, fees or branding — that\'s embassy-level. High-risk overrides need the approval chain; every action sealed in the audit chain' },
};
const demoMetaFor = (a) => DEMO_ACCOUNT_META[a.email] || DEMO_ROLE_META[a.role] || { icon: '👤', label: a.role, view: 'console', blurb: '' };
window.openDemoAccounts = async () => {
  modal('<div class="center muted" style="padding:30px">Loading fully-loaded demo accounts…</div>');
  let data;
  try { data = await api('/api/accounts/seed-roles', { method: 'POST', body: JSON.stringify({}) }); }
  catch { modal('<div class="center muted" style="padding:30px">Could not load demo accounts — please try again.</div>'); return; }
  const rows = (data.accounts || []).map((a) => {
    const m = demoMetaFor(a);
    const btn = a.pinRequired
      ? `<button class="btn btn-ghost btn-sm" onclick="staffPinPrompt()">🔒 PIN</button>`
      : `<button class="btn btn-gold btn-sm" onclick="demoSignIn('${esc(a.id)}')">Sign in</button>`;
    return `<div class="kv" style="align-items:flex-start;gap:10px">
      <span style="flex:1">${m.icon} <strong>${esc(m.label)}</strong> <span class="muted" style="font-size:11.5px">· ${esc(a.email)}</span><br>
        <span class="muted" style="font-size:11.5px">${esc(m.blurb)}</span></span>
      ${btn}
    </div>`;
  }).join('');
  window.__demoAccounts = data.accounts || [];
  modal(`
    <span class="eyebrow">Fully-loaded demo accounts · one per role</span>
    <h3 style="margin:6px 0 4px">Explore every side of the OS</h3>
    <p class="muted" style="font-size:12.5px">Each account ships pre-loaded — memberships, ACU balances, bookings with e-tickets, host listings, payment links and visa queues — so every command centre demos end-to-end. Tap Sign in to switch.</p>
    ${rows}
    <p class="muted" style="font-size:11px;margin-top:10px">Demo data is synthesised. Switch accounts any time from this panel.</p>`);
};
window.demoSignIn = (id) => {
  const acct = (window.__demoAccounts || []).find((a) => a.id === id);
  if (!acct) { toast('Account not found — reopen the demo panel.'); return; }
  setUser(acct);
  closeModal();
  const meta = demoMetaFor(acct);
  toast(`✓ Signed in as ${acct.name} (${meta.label || acct.role})`);
  nav(meta.view);
};
// Staff second factor: collect the PIN, keep it for this session (sent as the
// x-staff-pin header on every request) and reopen the demo panel unlocked.
window.staffPinPrompt = () => {
  const pin = window.prompt('Staff access PIN');
  if (!pin) return;
  setStaffPin(pin);
  openDemoAccounts();
};

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
  journeys: {
    title: '🚆⛴ Trains, Coaches, Ferries & Cruises — every way to travel, one OS',
    body: `<p class="muted">3JN is not a flight tool. Ask for <strong>any journey mode</strong> in plain English — “Amsterdam from Newcastle by ferry”, “Paris by Eurostar”, “a 7-night Mediterranean cruise”, “London to Manchester by coach” — and the OS scans verified operators (Eurostar, Trainline, FlixBus, National Express, DFDS, P&O, Brittany Ferries, MSC, Royal Caribbean and more), prices the whole trip and books it with the same openly-shown fees, instalments and price guard as flights.</p>
      <ul class="comp-list"><li><span class="cs">Trains, coaches, ferries, mini cruises & ocean cruises</span></li><li><span class="cs">Car & bike hire, transfers, boats & yacht charters</span></li><li><span class="cs">Mix modes in one package — rail out, ferry back</span></li></ul>`,
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
  if (save && d.savings) {
    save.textContent = d.savings.headline || `Est. saving ${d.savings.display}`;
    if (d.savings.note) save.title = d.savings.note;
  }
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
    <div class="notif ${n.read ? '' : 'unread'}"><span class="notif-ico">${esc(n.icon)}</span>
      <div><strong>${esc(n.title)}</strong><div class="muted" style="font-size:12.5px">${esc(n.body)}</div></div></div>`).join('')
    : '<div class="muted" style="font-size:13px">No notifications yet. Book a trip or run the Price Guard to see updates here.</div>';
  modal(`<span class="eyebrow">Notifications</span><h3 style="margin:6px 0 10px">Your alerts</h3>${rows}`);
  try { await api('/api/notifications/read', { method: 'POST', body: '{}' }); } catch {}
  refreshNotifications();
}
$('#notifBtn')?.addEventListener('click', openNotifications);
$('#notifBtnMobile')?.addEventListener('click', () => { closeMobileNav(); openNotifications(); });

// ---- Contact form ---------------------------------------------------------
// ---- Group Travel quote (churches, schools, teams, diaspora groups) --------
$('#groupTravelLink')?.addEventListener('click', () => openGroupQuote());
window.openGroupQuote = () => {
  modal(`
    <span class="eyebrow">Group Travel</span>
    <h3 style="margin:6px 0 4px">Get a group quote</h3>
    <p class="muted" style="font-size:13px">Churches, schools, sports teams, weddings, conferences, family reunions and diaspora groups — one coordinator, one plan, group rates.</p>
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
      <div class="field" style="flex:1;min-width:130px"><label>How many travellers?</label><input class="in" id="grpHead" type="number" value="20" min="1"></div>
      <div class="field" style="flex:1;min-width:150px"><label>Est. trip value each (optional)</label><input class="in" id="grpValue" type="number" placeholder="e.g. 900"></div>
    </div>
    <button class="btn btn-gold btn-block" style="margin-top:12px" onclick="calcGroupQuote()">Calculate group quote</button>
    <div id="grpOut" style="margin-top:12px"></div>`);
};
window.calcGroupQuote = async () => {
  const headcount = Number($('#grpHead')?.value) || 10;
  const tripValueGBP = Number($('#grpValue')?.value) || 0;
  let d;
  try { d = await api('/api/group/quote', { method: 'POST', body: JSON.stringify({ headcount, tripValueGBP }) }); } catch { toast('Could not calculate.'); return; }
  const out = $('#grpOut'); if (!out) return;
  out.innerHTML = `<div class="card pad">
    <div class="kv"><span>Group planning fee</span><span>£${d.planningFeeGBP}</span></div>
    <div class="kv"><span>Coordination fee (£5 × ${d.headcount})</span><span>£${d.groupBookingFeeGBP}</span></div>
    <div class="kv total"><span><strong>Upfront to start</strong></span><span><strong style="color:var(--gold)">£${d.totalUpfrontGBP}</strong></span></div>
    <p class="muted" style="font-size:11.5px;margin:8px 0 0">Plus the standard 10% on the final package. Every traveller gets their own itinerary, and the group shares one coordinator. We'll email <strong>${esc(d.contact)}</strong> to build it.</p>
    <button class="btn btn-gold btn-block" style="margin-top:10px" onclick="closeModal(); (document.getElementById('contactLink')||{click(){}}).click()">Talk to a group specialist</button>
  </div>`;
};

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
// ---- 3JN Host Marketplace — Host Dashboard ---------------------------------
// End-to-end accommodation management: register first, then publish and run
// your properties — set prices, pause/resume, manage bookings and earnings.
$('#hostLink')?.addEventListener('click', () => openHostDashboard());

// The Host Dashboard is a full PAGE (nav: Hosting), not a pop-up — property
// setup and management need room. openHostDashboard stays as the entry point
// every existing link uses.
function openHostDashboard() { nav('hosting'); }

async function renderHosting() {
  const out = $('#hostingBody');
  if (!out) return;
  if (!state.user) {
    out.innerHTML = `<div class="card pad center">
      <h3 style="margin:0 0 8px">Sign in to start hosting</h3>
      <p class="muted" style="max-width:520px;margin:0 auto 14px">Register once, publish your property with photos, pass AI verification + admin review, and it sells inside 3JN packages next to hotels. You keep <strong>90%</strong> of every stay.</p>
      <button class="btn btn-gold" onclick="openAuth()">Sign in / Create account</button></div>`;
    return;
  }
  out.innerHTML = '<div class="card pad center muted">Loading your hosting dashboard…</div>';
  let d; try { d = await api('/api/host/dashboard'); } catch { out.innerHTML = '<div class="card pad center muted">Could not load the dashboard — please try again.</div>'; return; }

  // Step 1 — registration gate (on the page, not a pop-up).
  if (!d.registered) {
    out.innerHTML = `<div class="card pad" style="max-width:560px;margin:0 auto">
      <span class="eyebrow">Step 1 of 2 · Register as a host</span>
      <h3 style="margin:6px 0">Open your Host Dashboard</h3>
      <p class="muted" style="font-size:13px">One registration unlocks everything: publish properties, set your prices, pause or resume listings, manage bookings and payouts. You keep <strong>90%</strong> of every stay; 3JN keeps 10%.</p>
      <div class="field" style="margin-top:12px"><label>Host display name (shown to guests)</label><input class="in" id="hostRegName" value="${esc(state.user.name || '')}" /></div>
      <div class="field" style="margin-top:10px"><label>Payout method — where we send your 90%</label>
        <select class="in" id="hostRegPayout" onchange="hostPayoutFields(this.value)"><option>Bank transfer</option><option>PayPal</option><option value="BitriPay wallet" disabled>BitriPay wallet — coming soon</option></select></div>
      <div class="muted" style="font-size:11px;margin-top:4px">Payouts run on Stripe (bank transfer) or PayPal today. BitriPay wallet unlocks the day BitriPay launches.</div>
      <div id="hostPayoutFields">${payoutFieldsHTML('Bank transfer')}</div>
      <button class="btn btn-gold btn-block" style="margin-top:14px" onclick="hostRegister()">Register & open my dashboard</button>
      <p class="muted" style="font-size:11.5px;margin-top:8px">Payout details are required — we can't pay you without them. They're stored securely, shown masked (last 4 digits only), and verified before your first payout. Identity comes from your 3JN account; properties pass the 50-point integrity check + AI security verification + admin review before going live.</p>
    </div>`;
    return;
  }

  // Step 2 — the dashboard (full page, two columns).
  const statusChip = (l) => l.status === 'live'
    ? '<span class="ch-chip" style="color:var(--green);border-color:rgba(70,211,154,0.35)">● Live in searches</span>'
    : l.status === 'pending-review'
      ? '<span class="ch-chip" style="color:var(--gold);border-color:rgba(216,180,106,0.4)">🕓 Awaiting 3JN review</span>'
      : '<span class="ch-chip" style="color:var(--muted)">⏸ Paused</span>';
  const props = (d.listings || []).map((l) => `
    <div class="card pad" style="margin-bottom:10px">
      ${(l.photos || []).length ? `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-bottom:8px">${(l.photos || []).slice(0, 4).map((p) => `<img src="${esc(p)}" style="width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:6px" alt="" loading="lazy">`).join('')}</div>` : ''}
      <div class="kv" style="border:none;padding:0"><span style="font-family:'Space Grotesk';font-weight:700">🏠 ${esc(l.title)}</span>${statusChip(l)}</div>
      <div class="muted" style="font-size:12px;margin:2px 0 8px">${esc(l.city)} · ${esc(l.address || '')} · ${esc(l.propertyType || '')} · sleeps ${l.sleeps} · ${(l.photos || []).length} photos · reliability ${l.reliabilityScore}${l.aiVerification ? ` · AI verification ${l.aiVerification.score}/100 · security ${esc(l.aiVerification.securityRisk || '—')}` : ''}</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <label class="muted" style="font-size:12px">Nightly (USD)</label>
        <input class="in" id="price_${l.id}" type="number" value="${l.nightlyUSD}" style="width:100px" />
        <button class="btn btn-ghost btn-sm" onclick="hostSetPrice('${l.id}')">Update price</button>
        <button class="btn btn-ghost btn-sm" onclick="openHostCalendar('${l.id}')">📅 Calendar & special prices</button>
        ${l.status !== 'pending-review' ? `<button class="btn btn-ghost btn-sm" onclick="hostToggle('${l.id}','${l.status === 'live' ? 'paused' : 'live'}')">${l.status === 'live' ? '⏸ Pause listing' : '▶ Go live'}</button>` : '<span class="muted" style="font-size:11.5px">Goes live automatically once 3JN approves it.</span>'}
      </div>
    </div>`).join('') || '<p class="muted" style="font-size:12.5px">No properties yet — publish your first on the right. It goes through AI verification + admin review, then sells inside packages automatically.</p>';

  const bookings = (d.bookings || []).map((b) => `
    <div class="kv"><span>${esc(b.listing)} <span class="muted" style="font-size:11.5px">· ${b.nights || '—'} nights · ${esc(b.status || '')}</span></span>
    <span>gross $${b.grossUSD} · <strong style="color:var(--gold)">you $${b.netUSD}</strong></span></div>`).join('')
    || '<p class="muted" style="font-size:12px">No reservations yet — live listings sell inside package options automatically.</p>';

  const e = d.earnings;
  out.innerHTML = `
    <div class="kpi-grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px">
      ${[['Properties', (d.listings || []).length], ['Live now', (d.listings || []).filter((l) => l.status === 'live').length], ['Reservations', (d.bookings || []).length], ['Gross', '$' + (e ? e.totals.grossUSD : 0)], ['Your 90%', '$' + (e ? e.totals.netUSD : 0)]]
        .map(([k, v]) => `<div class="card pad" style="text-align:center"><div class="t-label">${k}</div><div style="font-family:'Space Grotesk';font-weight:700;font-size:22px;color:var(--gold)">${v}</div></div>`).join('')}
    </div>
    <p class="muted center" style="font-size:12px;margin:8px 0 14px">Host: <strong style="color:var(--gold)">${esc(d.profile.displayName)}</strong> · payouts via ${esc(d.profile.payoutMethod)}${d.profile.payoutMasked ? ` (${esc(d.profile.payoutMasked.accountNumber || d.profile.payoutMasked.walletId || d.profile.payoutMasked.paypalEmail || '')}) ${d.profile.payoutMasked.verified ? '<span style="color:var(--green)">✓ verified</span>' : '<span style="color:var(--gold)">verification pending</span>'}` : ''} · you keep 90% of every stay
      · <a style="color:var(--blue-bright);cursor:pointer;text-decoration:underline" onclick="openPayoutUpdate()">update payout details</a></p>
    <div class="console-grid">
      <div>
        <span class="eyebrow">My properties · price, pause, publish</span>
        <div style="margin:8px 0 14px">${props}</div>
        <span class="eyebrow">Reservations & payouts</span>
        <div class="card pad" style="margin-top:6px">${bookings}</div>
      </div>
      <div>
        <div class="card pad">
        <span class="eyebrow">Publish a new listing</span>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn btn-gold btn-sm" id="kindStay" onclick="setHostKind('stay')">🏠 Property / stay</button>
          <button class="btn btn-ghost btn-sm" id="kindExp" onclick="setHostKind('experience')">🎟 Experience</button>
        </div>
        <div class="field" style="margin-top:10px"><label id="lblTitle">Title</label><input class="in" id="hostName" placeholder="e.g. Marina View Apartment" /></div>
        <div class="field" style="margin-top:10px"><label>Description</label><textarea class="in" id="hostDesc" rows="3" placeholder="About this listing — what makes it special"></textarea></div>
        <div class="field" style="margin-top:10px"><label>City</label><input class="in" id="hostCity" placeholder="e.g. Dubai" /></div>
        <div class="field" style="margin-top:10px"><label>Street address (guests verify you online by name + address)</label><input class="in" id="hostAddress" placeholder="e.g. 14 Marina Walk, Dubai Marina" /></div>
        <div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap">
          <div class="field" style="flex:1;min-width:140px" id="typeWrap"><label>Listing type</label><select class="in" id="hostType"><option>Entire apartment</option><option>Private room</option><option>Villa</option><option>Townhouse</option><option>Guest suite</option></select></div>
          <div class="field" style="width:100px"><label id="lblGuests">Guests</label><input class="in" id="hostSleeps" type="number" value="4" min="1" max="40" /></div>
          <div class="field" style="width:140px"><label id="lblRate">Price (USD)</label><input class="in" id="hostRate" type="number" placeholder="120" /></div>
          <div class="field" style="width:130px" id="rateUnitWrap"><label>Priced per</label><select class="in" id="hostRateUnit"><option value="night">Night</option><option value="day">Day</option><option value="hour">Hour</option><option value="week">Week</option><option value="month">Month</option><option value="stay">Stay</option></select></div>
        </div>

        <details class="hostSec" data-kind="stay" style="margin-top:10px"><summary style="cursor:pointer;font-weight:600">Information — rooms & size</summary>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
            ${[['hostBedrooms', 'Bedrooms', 2], ['hostBeds', 'Beds', 3], ['hostBaths', 'Bathrooms', 1], ['hostRooms', 'Rooms', 3], ['hostSize', 'Size (m²)', 80]].map(([id, l, v]) => `<div class="field" style="flex:1;min-width:90px"><label>${l}</label><input class="in" id="${id}" type="number" min="0" value="${v}" /></div>`).join('')}
          </div>
          <div class="field" style="margin-top:8px"><label>Bedrooms detail — one per line: Name | guests | beds | bed type</label><textarea class="in" id="hostBedroomsDetail" rows="2" placeholder="Master | 2 | 1 | King&#10;Second | 2 | 2 | Twin"></textarea></div>
        </details>

        <details class="hostSec" style="margin-top:8px"><summary style="cursor:pointer;font-weight:600">Pricing — weekends, long-term, instant booking</summary>
          <label style="font-size:12.5px;display:block;margin-top:8px"><input type="checkbox" id="hostInstant"> Instant booking (no approval needed per reservation)</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px" data-kind="stay" class="hostSec">
            <div class="field" style="flex:1;min-width:120px"><label>Weekend price (USD)</label><input class="in" id="hostWeekend" type="number" min="0" placeholder="optional" /></div>
            <div class="field" style="flex:1;min-width:140px"><label>Weekly rate — 7+ nights (per night)</label><input class="in" id="hostWeekly" type="number" min="0" placeholder="optional" /></div>
            <div class="field" style="flex:1;min-width:140px"><label>Monthly rate — 30+ nights (per night)</label><input class="in" id="hostMonthly" type="number" min="0" placeholder="optional" /></div>
          </div>
        </details>

        <details class="hostSec" style="margin-top:8px"><summary style="cursor:pointer;font-weight:600">Additional costs — fees, deposit, tax</summary>
          <label style="font-size:12.5px;display:block;margin-top:8px"><input type="checkbox" id="hostAllowExtra"> Allow additional guests</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
            <div class="field" style="flex:1;min-width:110px"><label>Included guests</label><input class="in" id="hostIncGuests" type="number" min="1" value="2" /></div>
            <div class="field" style="flex:1;min-width:120px"><label>Extra guest fee /night</label><input class="in" id="hostExtraFee" type="number" min="0" placeholder="0" /></div>
            <div class="field" style="flex:1;min-width:110px"><label>Cleaning fee</label><input class="in" id="hostCleaning" type="number" min="0" placeholder="0" /></div>
            <div class="field" style="flex:1;min-width:110px"><label>City fee /night</label><input class="in" id="hostCityFee" type="number" min="0" placeholder="0" /></div>
            <div class="field" style="flex:1;min-width:120px"><label>Security deposit</label><input class="in" id="hostDeposit" type="number" min="0" placeholder="0" /></div>
            <div class="field" style="flex:1;min-width:90px"><label>Tax % (your country's law)</label><input class="in" id="hostTax" type="number" min="0" max="40" placeholder="0" /></div>
          </div>
        </details>

        <details class="hostSec" style="margin-top:8px"><summary style="cursor:pointer;font-weight:600">Features & media</summary>
          <div class="field" style="margin-top:8px"><label>Amenities (comma-separated)</label><input class="in" id="hostAmenities" placeholder="Full kitchen, WiFi, Washer, Self check-in" /></div>
          <div class="field" style="margin-top:8px"><label>Facilities (comma-separated)</label><input class="in" id="hostFacilities" placeholder="Pool, Gym, Parking" /></div>
          <div class="field" style="margin-top:8px"><label>Video URL (YouTube/Vimeo)</label><input class="in" id="hostVideo" placeholder="https://…" /></div>
          <div class="field" style="margin-top:8px"><label>Services offered — one per line: Name | price | description</label><textarea class="in" id="hostServices" rows="2" placeholder="Airport pickup | 35 | Meet & greet at arrivals"></textarea></div>
        </details>

        <details class="hostSec" data-kind="experience" style="margin-top:8px;display:none"><summary style="cursor:pointer;font-weight:600">Experience details — what you provide</summary>
          <div class="field" style="margin-top:8px"><label>Experience type</label><input class="in" id="expType" placeholder="Food tour, Desert safari, Yoga class…" /></div>
          <div class="field" style="margin-top:8px"><label>Describe yourself and your qualifications</label><textarea class="in" id="expQualifications" rows="2" placeholder="Licensed guide, 8 years leading tours…"></textarea></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
            <div class="field" style="flex:1;min-width:150px"><label>Languages (comma-separated)</label><input class="in" id="expLanguages" placeholder="English, Arabic" /></div>
            <div class="field" style="width:130px"><label>Duration (hours)</label><input class="in" id="expDuration" type="number" min="0" value="3" /></div>
          </div>
          <div class="field" style="margin-top:8px"><label>What I will provide (one per line)</label><textarea class="in" id="expProvided" rows="2" placeholder="Cold water&#10;Tastings"></textarea></div>
          <div class="field" style="margin-top:8px"><label>What you will bring (one per line)</label><textarea class="in" id="expBring" rows="2" placeholder="Comfortable shoes&#10;Yoga mat"></textarea></div>
        </details>

        <details class="hostSec" style="margin-top:8px"><summary style="cursor:pointer;font-weight:600">Terms & rules — cancellation, stay limits, house rules</summary>
          <div class="field" style="margin-top:8px"><label>Cancellation policy</label><select class="in" id="hostCancel"><option>Flexible — full refund until 24h before</option><option>Moderate — full refund until 5 days before</option><option>Strict — 50% refund until 7 days before</option><option>Non-refundable</option></select></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
            <div class="field" style="flex:1;min-width:100px"><label>Min stay</label><input class="in" id="hostMinStay" type="number" min="0" placeholder="1" /></div>
            <div class="field" style="flex:1;min-width:100px"><label>Max stay</label><input class="in" id="hostMaxStay" type="number" min="0" placeholder="365" /></div>
            <div class="field" style="flex:1;min-width:110px"><label>Check-in after</label><input class="in" id="hostCheckin" value="15:00" /></div>
            <div class="field" style="flex:1;min-width:110px"><label>Check-out before</label><input class="in" id="hostCheckout" value="11:00" /></div>
            <div class="field" style="flex:1;min-width:110px"><label>Deposit at booking %</label><input class="in" id="hostDepositPct" type="number" min="0" max="100" value="10" /></div>
          </div>
          <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:12.5px">
            <label><input type="checkbox" id="ruleSmoking"> Smoking allowed</label>
            <label><input type="checkbox" id="rulePets"> Pets allowed</label>
            <label><input type="checkbox" id="ruleParty"> Parties allowed</label>
            <label><input type="checkbox" id="ruleChildren" checked> Children allowed</label>
          </div>
          <div class="field" style="margin-top:8px"><label>Additional rules (optional)</label><textarea class="in" id="hostRules" rows="2" placeholder="Quiet hours after 22:00…"></textarea></div>
        </details>

        <details class="hostSec" style="margin-top:8px"><summary style="cursor:pointer;font-weight:600">Opening hours</summary>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
            <div class="field" style="flex:1;min-width:120px"><label>Mon – Fri</label><input class="in" id="hoursMF" value="08:00–20:00" /></div>
            <div class="field" style="flex:1;min-width:120px"><label>Saturday</label><input class="in" id="hoursSat" value="09:00–18:00" /></div>
            <div class="field" style="flex:1;min-width:120px"><label>Sunday</label><input class="in" id="hoursSun" value="10:00–16:00" /></div>
          </div>
        </details>

        <div class="field" style="margin-top:10px"><label>Photos — minimum 10 (5 for an experience), maximum 100</label>
          <input type="file" id="hostPhotoFiles" accept="image/*" multiple style="display:none" onchange="hostAddPhotos(this.files)" />
          <button class="btn btn-ghost btn-block" type="button" onclick="$('#hostPhotoFiles').click()">📷 Upload photos from this device</button>
          <div class="muted" style="font-size:11.5px;margin-top:6px" id="hostPhotoCount">0 / 10 minimum · photos compress automatically before upload</div>
          <div id="hostPhotoPreview" style="display:grid;grid-template-columns:repeat(6,1fr);gap:4px;margin-top:8px"></div>
          <details style="margin-top:8px"><summary class="muted" style="font-size:12px;cursor:pointer">Or paste image URLs (one per line)</summary>
            <textarea class="in" id="hostPhotos" rows="3" placeholder="https://…/living-room.jpg" style="margin-top:6px" oninput="hostPhotoRecount()"></textarea></details></div>
        <button class="btn btn-gold btn-block" style="margin-top:14px" onclick="submitHost()">Verify & publish</button>
        <p class="muted" style="font-size:11px;margin-top:8px">Every listing passes the 50-point integrity check, AI security verification and 3JN admin review before going live. Guests book through 3JN; you're paid your 90%.</p>
        </div>
      </div>
    </div>`;
}
// Toggle between publishing a stay and an experience (per-person pricing).
window.setHostKind = (kind) => {
  window.__hostKind = kind;
  const stay = kind === 'stay';
  $('#kindStay')?.classList.toggle('btn-gold', stay); $('#kindStay')?.classList.toggle('btn-ghost', !stay);
  $('#kindExp')?.classList.toggle('btn-gold', !stay); $('#kindExp')?.classList.toggle('btn-ghost', stay);
  document.querySelectorAll('.hostSec[data-kind]').forEach((el) => { el.style.display = el.dataset.kind === kind ? '' : 'none'; });
  const set = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
  set('#lblTitle', stay ? 'Title' : 'Experience title');
  set('#lblRate', stay ? 'Price (USD)' : 'Price per person (USD)');
  set('#lblGuests', stay ? 'Guests' : 'Max guests');
  const tw = $('#typeWrap'); if (tw) tw.style.display = stay ? '' : 'none';
  const ru = $('#rateUnitWrap'); if (ru) ru.style.display = stay ? '' : 'none';
  const pc = $('#hostPhotoCount'); if (pc) pc.textContent = `${hostUploadedPhotos.length} / ${stay ? 10 : 5} minimum · photos compress automatically before upload`;
};

// Per-method payout detail fields (bank / BitriPay / PayPal).
function payoutFieldsHTML(method, idPrefix = 'hp') {
  if (method === 'BitriPay wallet') {
    return `<div class="field" style="margin-top:8px"><label>BitriPay wallet ID or registered phone</label><input class="in" id="${idPrefix}Wallet" placeholder="BTP-… or +44…" /></div>`;
  }
  if (method === 'PayPal') {
    return `<div class="field" style="margin-top:8px"><label>PayPal email</label><input class="in" id="${idPrefix}Paypal" type="email" placeholder="you@email.com" /></div>`;
  }
  return `
    <div class="field" style="margin-top:8px"><label>Account holder name (exactly as the bank knows it)</label><input class="in" id="${idPrefix}Holder" placeholder="e.g. Jean N Bankwa" /></div>
    <div class="field" style="margin-top:8px"><label>IBAN or account number</label><input class="in" id="${idPrefix}Account" placeholder="GB29 NWBK 6016 1331 9268 19" /></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
      <div class="field" style="flex:1;min-width:140px"><label>Bank name</label><input class="in" id="${idPrefix}Bank" placeholder="e.g. NatWest" /></div>
      <div class="field" style="flex:1;min-width:120px"><label>Sort code / SWIFT</label><input class="in" id="${idPrefix}Sort" placeholder="60-16-13 or NWBKGB2L" /></div>
      <div class="field" style="width:90px"><label>Currency</label><input class="in" id="${idPrefix}Cur" value="GBP" maxlength="3" /></div>
    </div>`;
}
window.hostPayoutFields = (method, targetId = '#hostPayoutFields', idPrefix = 'hp') => {
  const el = $(targetId); if (el) el.innerHTML = payoutFieldsHTML(method, idPrefix);
};
function collectPayout(idPrefix = 'hp') {
  const v = (id) => $(`#${idPrefix}${id}`)?.value || '';
  return {
    accountHolder: v('Holder'), accountNumber: v('Account'), bankName: v('Bank'),
    sortOrSwift: v('Sort'), currency: v('Cur'),
    walletId: v('Wallet'), paypalEmail: v('Paypal'),
  };
}
window.hostRegister = async () => {
  try {
    const r = await api('/api/host/register', { method: 'POST', body: JSON.stringify({
      displayName: $('#hostRegName')?.value,
      payoutMethod: $('#hostRegPayout')?.value,
      payout: collectPayout('hp'),
    }) });
    if (!r.ok) { toast(r.message || 'Check your payout details.'); return; }
    toast('🏠 Host account active — payout set up. Welcome to your dashboard.');
    renderHosting();
  } catch (e) { toast(e?.message || 'Check your payout details — they are required to pay you.'); }
};
// Update payout details later (dashboard) — masked display, full re-entry.
window.openPayoutUpdate = async () => {
  const d = await api('/api/host/dashboard').catch(() => null);
  const method = d?.profile?.payoutMethod || 'Bank transfer';
  modal(`
    <span class="eyebrow">💷 Payout details · where your 90% goes</span>
    <p class="muted" style="font-size:12px;margin:6px 0">Current: ${esc(method)} ${d?.profile?.payoutMasked ? '· ' + esc(d.profile.payoutMasked.accountNumber || d.profile.payoutMasked.walletId || d.profile.payoutMasked.paypalEmail || '') : ''} ${d?.profile?.payoutMasked?.verified ? '<span style="color:var(--green)">✓ verified</span>' : '<span style="color:var(--gold)">verification pending</span>'}</p>
    <div class="field"><label>Payout method</label>
      <select class="in" id="pu_method" onchange="hostPayoutFields(this.value, '#pu_fields', 'pu')">
        ${['Bank transfer', 'PayPal'].map((m) => `<option ${m === method ? 'selected' : ''}>${m}</option>`).join('')}
        <option value="BitriPay wallet" disabled ${method === 'BitriPay wallet' ? 'selected' : ''}>BitriPay wallet — coming soon</option>
      </select></div>
    <div id="pu_fields">${payoutFieldsHTML(method, 'pu')}</div>
    <button class="btn btn-gold btn-block" style="margin-top:12px" onclick="savePayoutUpdate()">Save payout details</button>
    <p class="muted" style="font-size:11px;margin-top:8px">Changed details are re-verified before the next Friday payout run — this protects you from account-takeover fraud.</p>`);
};
window.savePayoutUpdate = async () => {
  try {
    const r = await api('/api/host/payout', { method: 'PATCH', body: JSON.stringify({ payoutMethod: $('#pu_method')?.value, payout: collectPayout('pu') }) });
    if (!r.ok) { toast(r.message || 'Check the details.'); return; }
    toast('✓ Payout details updated — re-verification before the next payout.');
    closeModal(); renderHosting();
  } catch (e) { toast(e?.message || 'Could not save payout details.'); }
};

window.hostSetPrice = async (id) => {
  const nightlyUSD = Number($(`#price_${id}`)?.value);
  try {
    await api(`/api/host/listings/${id}`, { method: 'PATCH', body: JSON.stringify({ nightlyUSD }) });
    toast(`✓ Price updated — $${nightlyUSD}/night applies to every new search.`);
  } catch {}
};

window.hostToggle = async (id, status) => {
  try {
    await api(`/api/host/listings/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    toast(status === 'live' ? '▶ Listing is live in searches again.' : '⏸ Listing paused — hidden from searches.');
    openHostDashboard();
  } catch {}
};

// Uploaded property photos (compressed data URLs), collected before publish.
let hostUploadedPhotos = [];
window.hostPhotoRecount = () => {
  const urls = ($('#hostPhotos')?.value || '').split(/\n|,/).map((x) => x.trim()).filter(Boolean);
  const n = hostUploadedPhotos.length + urls.length;
  const el = $('#hostPhotoCount');
  if (el) el.textContent = `${n} / 10 minimum${n > 100 ? ' — over the 100 maximum' : ''}`;
};
// Compress each chosen image in the browser (max 1024px, JPEG ~0.72) so a
// phone photo of 4MB becomes ~120KB — then it uploads inside the publish call.
window.hostAddPhotos = async (files) => {
  for (const f of Array.from(files || [])) {
    if (hostUploadedPhotos.length >= 100) { toast('Maximum 100 photos.'); break; }
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(f);
        img.onload = () => {
          const scale = Math.min(1, 1024 / Math.max(img.width, img.height));
          const cv = document.createElement('canvas');
          cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          URL.revokeObjectURL(url);
          resolve(cv.toDataURL('image/jpeg', 0.72));
        };
        img.onerror = reject;
        img.src = url;
      });
      hostUploadedPhotos.push(dataUrl);
      $('#hostPhotoPreview')?.insertAdjacentHTML('beforeend',
        `<img src="${dataUrl}" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:6px;border:1px solid var(--line)" alt="">`);
    } catch { toast('One image could not be read — skipped.'); }
  }
  hostPhotoRecount();
};

window.submitHost = async () => {
  const kind = window.__hostKind || 'stay';
  const title = $('#hostName')?.value.trim();
  const city = $('#hostCity')?.value.trim();
  const nightlyUSD = Number($('#hostRate')?.value);
  if (!title || !city || !nightlyUSD) { toast(`Title, city and ${kind === 'experience' ? 'per-person price' : 'price'} are required.`); return; }
  const v = (id) => $(id)?.value || '';
  const nv = (id) => Number($(id)?.value) || 0;
  const ck = (id) => !!$(id)?.checked;
  // Bedrooms/services rows: "Name | n | n | type" one per line.
  const rows = (id, map) => v(id).split('\n').map((line) => line.split('|').map((x) => x.trim())).filter((p) => p[0]).map(map);
  try {
    const urlPhotos = ($('#hostPhotos')?.value || '').split(/\n|,/).map((x) => x.trim()).filter(Boolean);
    const photos = [...hostUploadedPhotos, ...urlPhotos];
    const r = await api('/api/host/listings', { method: 'POST', body: JSON.stringify({
      kind, title, city, nightlyUSD, photos,
      description: v('#hostDesc'),
      address: v('#hostAddress'),
      propertyType: v('#hostType'),
      sleeps: nv('#hostSleeps') || 2,
      amenities: v('#hostAmenities'),
      // Information
      bedrooms: nv('#hostBedrooms'), beds: nv('#hostBeds'), bathrooms: nv('#hostBaths'), rooms: nv('#hostRooms'), sizeSqm: nv('#hostSize'),
      bedroomsDetail: rows('#hostBedroomsDetail', (p) => ({ name: p[0], guests: Number(p[1]) || 0, beds: Number(p[2]) || 0, bedType: p[3] || 'Double' })),
      // Pricing
      rateUnit: v('#hostRateUnit') || 'night', instantBooking: ck('#hostInstant'),
      weekendPriceUSD: nv('#hostWeekend'), weeklyRateUSD: nv('#hostWeekly'), monthlyRateUSD: nv('#hostMonthly'),
      // Additional costs
      allowAdditionalGuests: ck('#hostAllowExtra'), includedGuests: nv('#hostIncGuests') || 2, additionalGuestFeeUSD: nv('#hostExtraFee'),
      cleaningFeeUSD: nv('#hostCleaning'), cityFeeUSD: nv('#hostCityFee'), securityDepositUSD: nv('#hostDeposit'), taxPct: nv('#hostTax'),
      // Features & media
      facilities: v('#hostFacilities'), videoUrl: v('#hostVideo'),
      services: rows('#hostServices', (p) => ({ name: p[0], priceUSD: Number(p[1]) || 0, description: p[2] || '' })),
      // Experience-specific
      experienceType: v('#expType'), hostQualifications: v('#expQualifications'),
      hostLanguages: v('#expLanguages'), durationHours: nv('#expDuration'),
      whatProvided: v('#expProvided'), whatToBring: v('#expBring'),
      // Terms & rules + reservation policy
      cancellationPolicy: v('#hostCancel'), minStay: nv('#hostMinStay'), maxStay: nv('#hostMaxStay'),
      checkInAfter: v('#hostCheckin'), checkOutBefore: v('#hostCheckout'), depositPct: nv('#hostDepositPct') || 10,
      smokingAllowed: ck('#ruleSmoking'), petsAllowed: ck('#rulePets'), partyAllowed: ck('#ruleParty'), childrenAllowed: ck('#ruleChildren'),
      additionalRules: v('#hostRules'),
      openingHours: { monFri: v('#hoursMF'), sat: v('#hoursSat'), sun: v('#hoursSun') },
    }) });
    hostUploadedPhotos = [];
    toast(`${kind === 'experience' ? '🎟' : '🏠'} ${r.listing.title} submitted — it goes live in ${r.listing.city} once 3JN review approves it.`);
    renderHosting();
  } catch {}
};

// ---- Availability calendar: block dates · per-date prices -------------------
// Shows 8 weeks; click a date to BLOCK/unblock it. Set a per-date price for
// events/high season below. Weekend pricing comes from the listing's settings.
window.openHostCalendar = async (listingId) => {
  const d = await api('/api/host/dashboard').catch(() => null);
  const l = d?.listings?.find((x) => x.id === listingId);
  if (!l) { toast('Listing not found.'); return; }
  const av = l.availability || { blocked: [], priceOverridesUSD: {} };
  const blocked = new Set(av.blocked || []);
  const overrides = av.priceOverridesUSD || {};
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  const cells = [];
  for (let i = 0; i < 56; i++) {
    const dt = new Date(start); dt.setUTCDate(dt.getUTCDate() + i);
    const iso = dt.toISOString().slice(0, 10);
    const isBlocked = blocked.has(iso);
    const ov = overrides[iso];
    cells.push(`<div onclick="hostCalToggle('${listingId}','${iso}')" title="${iso}${ov ? ' · $' + ov : ''}" style="cursor:pointer;padding:6px 2px;border-radius:6px;text-align:center;font-size:11px;border:1px solid ${isBlocked ? 'rgba(255,107,107,.5)' : ov ? 'rgba(216,180,106,.5)' : 'var(--line)'};background:${isBlocked ? 'rgba(255,107,107,.15)' : ov ? 'rgba(216,180,106,.12)' : 'transparent'}">
      ${dt.getUTCDate()}${dt.getUTCDate() === 1 || i === 0 ? `<div style="font-size:9px;color:var(--muted)">${dt.toLocaleString('en', { month: 'short', timeZone: 'UTC' })}</div>` : ''}${ov ? `<div style="font-size:9px;color:var(--gold)">$${ov}</div>` : ''}${isBlocked ? '<div style="font-size:9px;color:#ff8a8a">✕</div>' : ''}</div>`);
  }
  modal(`
    <span class="eyebrow">📅 Availability & calendar pricing · ${esc(l.title)}</span>
    <p class="muted" style="font-size:12px;margin:6px 0">Tap a date to <strong style="color:#ff8a8a">block/unblock</strong> it (blocked dates never sell). Set a <strong style="color:var(--gold)">special price</strong> for event dates below. Weekend pricing is in your listing settings.</p>
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px;font-size:10px;color:var(--muted);text-align:center">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((w) => `<div>${w}</div>`).join('')}</div>
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px;margin-top:4px">${'<div></div>'.repeat(start.getUTCDay())}${cells.join('')}</div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:flex-end">
      <div class="field" style="flex:1;min-width:130px"><label>Date</label><input class="in" id="calDate" type="date" /></div>
      <div class="field" style="width:120px"><label>Price (USD)</label><input class="in" id="calPrice" type="number" min="0" placeholder="e.g. 250" /></div>
      <button class="btn btn-gold btn-sm" onclick="hostCalPrice('${listingId}')">Set price</button>
      <button class="btn btn-ghost btn-sm" onclick="hostCalPrice('${listingId}', true)">Clear price</button>
    </div>`);
  window.__hostCal = { listingId, blocked: [...blocked], overrides: { ...overrides } };
};
window.hostCalToggle = async (listingId, iso) => {
  const s = window.__hostCal; if (!s || s.listingId !== listingId) return;
  s.blocked = s.blocked.includes(iso) ? s.blocked.filter((x) => x !== iso) : [...s.blocked, iso];
  await api(`/api/host/listings/${listingId}`, { method: 'PATCH', body: JSON.stringify({ availability: { blocked: s.blocked, priceOverridesUSD: s.overrides } }) }).catch(() => toast('Could not save.'));
  openHostCalendar(listingId);
};
window.hostCalPrice = async (listingId, clear = false) => {
  const s = window.__hostCal; if (!s) return;
  const dt = $('#calDate')?.value; const price = Number($('#calPrice')?.value);
  if (!dt) { toast('Pick a date.'); return; }
  if (clear) delete s.overrides[dt]; else if (price > 0) s.overrides[dt] = price; else { toast('Enter a price.'); return; }
  await api(`/api/host/listings/${listingId}`, { method: 'PATCH', body: JSON.stringify({ availability: { blocked: s.blocked, priceOverridesUSD: s.overrides } }) }).catch(() => toast('Could not save.'));
  toast(clear ? '✓ Special price cleared' : `✓ ${dt} priced at $${price}`);
  openHostCalendar(listingId);
};

boot();
updateCalc();

// ---- PWA: service-worker registration -------------------------------------
// Registers the offline/installable shell. Network-first for app code keeps it
// from ever serving stale builds (see sw.js). Auto-applies updates on next load.
if ('serviceWorker' in navigator) {
  let refreshing = false;
  // Whether a service worker was ALREADY controlling this page when it loaded.
  // If so, a controllerchange means a NEW version just deployed and took over →
  // reload once to actually run the fresh code. (On a first-ever visit there is
  // no prior controller, so we skip the reload to avoid a flash for new users.)
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing || !hadController) return;
    refreshing = true;
    window.location.reload(); // pick up the just-deployed app.js automatically
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // Proactively check for a new version now and whenever the tab refocuses,
      // so an open tab never lingers on stale code between deploys.
      reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
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

// ---- AI Support Concierge (floating chatbot with human escalation) --------
(function initChat() {
  const fab = $('#chatFab'); const panel = $('#chatPanel');
  const log = $('#chatLog'); const form = $('#chatForm'); const input = $('#chatInput');
  if (!fab || !panel) return;
  let greeted = false;
  const bubble = (text, cls) => {
    const d = document.createElement('div');
    d.className = `chat-msg ${cls}`;
    // Allow our own <strong> emphasis, escape everything else.
    d.innerHTML = esc(text).replace(/&lt;strong&gt;/g, '<strong>').replace(/&lt;\/strong&gt;/g, '</strong>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    log.appendChild(d); log.scrollTop = log.scrollHeight;
    return d;
  };
  const open = () => {
    panel.hidden = false; fab.hidden = true; input.focus();
    if (!greeted) { greeted = true; bubble("Hi! I'm the 3JN Assistant. Ask me about your bookings, payments, visas or rewards — or just say hello.", 'bot'); }
  };
  const close = () => { panel.hidden = true; fab.hidden = false; };
  fab.addEventListener('click', open);
  $('#chatClose')?.addEventListener('click', close);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = input.value.trim(); if (!msg) return;
    bubble(msg, 'me'); input.value = '';
    const typing = bubble('…', 'bot');
    try {
      const d = await api('/api/support/chat', { method: 'POST', body: JSON.stringify({ message: msg }) });
      typing.remove();
      bubble(d.reply, 'bot');
      if (d.escalated) bubble(`🎧 ${d.handoff || 'A 3JN specialist will follow up shortly.'}${d.ticketId ? ` (ref ${d.ticketId})` : ''}`, 'esc');
    } catch { typing.remove(); bubble('Sorry — I couldn’t reach support just now. Please try again in a moment.', 'bot'); }
  });
})();
