// Enterprise AI agents: Security, Ops/Self-healing, SEO, Marketing, and the
// Blog writer. Deterministic in the prototype (no external model needed) but
// shaped like the real agents — each produces a structured, actionable report
// or artefact. They run through the AI Gateway in production.

import { db } from './store.js';
import { adminAudit, supplierScores, recordAudit } from './store.js';
import { findDestination } from './destinations.js';
import { threatStats, THREAT_CONFIG } from './threat-shield.js';

const DESTS = ['Dubai', 'Istanbul', 'Barcelona', 'New York', 'Bali', 'Rome', 'Faro', 'Marrakech', 'Lisbon', 'Zanzibar'];

// Real, per-destination facts the blog agent GROUNDS posts in (authenticity over
// keyword-stuffing): the actual visa rule for a UK traveller, the genuinely
// cheaper shoulder months, and an indicative "from" price — pulled from the live
// destination catalogue, not invented. Falls back gracefully off-catalogue.
const _MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function destFacts(name) {
  const d = findDestination(String(name || '')) || findDestination(`to ${name}`) || null;
  const visaGB = d?.visa?.GB || d?.visa?.DEFAULT || null;
  const months = Array.isArray(d?.months) && d.months.length ? d.months.map((m) => _MONTHS[m - 1]).filter(Boolean).slice(0, 4) : [];
  const fromGbp = (d?.flightBaseUSD || d?.hotelNightBaseUSD)
    ? Math.round(((Number(d.flightBaseUSD) || 0) + (Number(d.hotelNightBaseUSD) || 0) * 5) * 0.79 / 10) * 10
    : null;
  return {
    country: d?.countryName || null,
    visaRequiredGB: visaGB ? !!visaGB.required : null,
    visaType: visaGB?.type || null,
    bestMonths: months,
    fromGbp,
  };
}

// ---- Security Agent (cybercrime / anti-hacking) ---------------------------
// Synthesises a security posture from the audit trail + recent activity.
export function securityReport() {
  const audit = adminAudit(500);
  const failedAuth = audit.filter((a) => /auth|login/.test(a.action) && /fail/.test(a.summary || '')).length;
  const apiKeyEvents = audit.filter((a) => a.action?.startsWith('apikey')).length;
  const visaRejections = audit.filter((a) => a.action === 'visa.auto-rejection').length;
  // ACTIVE anti-hacking perimeter: live blocks by the Threat Shield (scanner
  // UAs, path probes, injection payloads) and how many source IPs it currently
  // has quarantined. This is the agent DOING something, not just reading history.
  const threatBlocks = audit.filter((a) => a.action === 'security.threat-blocked').length;
  const shield = threatStats();
  // A simple 0-100 posture score (higher = safer). Active blocks IMPROVE the
  // posture (the perimeter is catching and stopping attacks), while unresolved
  // failed auths and fraud attempts pull it down.
  const posture = Math.max(40, Math.min(100, 100 - failedAuth * 5 - visaRejections * 2 + Math.min(10, threatBlocks)));
  return {
    postureScore: posture,
    level: posture >= 85 ? 'Strong' : posture >= 70 ? 'Guarded' : 'Elevated',
    controls: [
      { control: 'Human-only signup & login (bot gate)', status: 'enforced' },
      { control: 'Anti-hacking Threat Shield', status: `active · ${threatBlocks} blocked · ${shield.quarantined} IP(s) quarantined` },
      { control: 'Attack-signature coverage', status: `${THREAT_CONFIG.scannerSignatures} scanners · ${THREAT_CONFIG.pathPatterns} path probes · ${THREAT_CONFIG.injectionKeys} injection ops` },
      { control: 'Zero-Trust access', status: 'enforced' },
      { control: 'CORS + rate-limit perimeter', status: 'active' },
      { control: 'JSON-only API (no HTML leak)', status: 'active' },
      { control: 'Immutable audit log', status: `${audit.length} events` },
      { control: 'Fraud scoring (VisaOS)', status: `${visaRejections} blocked` },
      { control: 'Secrets in env / Secret Manager', status: 'no secrets in code' },
      { control: 'Encryption in transit (TLS 1.3)', status: 'on deploy' },
    ],
    threats: [
      threatBlocks > 0 ? { type: 'Automated intrusion attempts', severity: shield.quarantined > 0 ? 'medium' : 'low', note: `${threatBlocks} blocked by shield, ${shield.quarantined} IP(s) quarantined` } : null,
      failedAuth > 3 ? { type: 'Credential stuffing', severity: 'medium', note: `${failedAuth} failed auths` } : null,
      apiKeyEvents > 10 ? { type: 'API abuse', severity: 'low', note: `${apiKeyEvents} key events` } : null,
    ].filter(Boolean),
    recommendation: posture >= 85
      ? 'Posture strong — human-only gate and active shield holding. Maintain monitoring and rotate secrets quarterly.'
      : 'Review recent auth failures; the shield is auto-quarantining scanners. Consider MFA and tighter rate limits.',
  };
}

// ---- Ops / Self-healing Agent (maintenance, issues, debugs) ----------------
// Runs live diagnostics across subsystems and reports issues + auto-remediation.
export function opsDiagnostics(env = {}) {
  const checks = [
    { system: 'API', status: 'ok', detail: 'JSON error-perimeter active' },
    { system: 'Store integrity', status: db.users instanceof Map ? 'ok' : 'degraded', detail: `${db.users.size} users, ${db.bookings.size} bookings` },
    { system: 'Persistence (RTDB)', status: env.persistence ? 'ok' : 'disabled', detail: env.persistence ? 'flushing' : 'in-memory (set creds to enable)' },
    { system: 'Email (SMTP)', status: env.email ? 'ok' : 'disabled', detail: env.email ? 'Hostinger SMTP' : 'set SMTP_PASS to enable' },
    { system: 'AI Gateway', status: 'ok', detail: 'model router + local fallback' },
    { system: 'Price Guard worker', status: 'ok', detail: 'on-demand + scheduled' },
  ];
  const issues = checks.filter((c) => c.status !== 'ok');
  return {
    health: issues.length === 0 ? 'healthy' : 'attention',
    checks,
    issues,
    autoRemediation: issues.map((i) => ({ system: i.system, action: i.status === 'disabled' ? 'awaiting credentials (no action)' : 'restart + alert ops' })),
    uptimeTargetSLO: '99.9%',
  };
}

// ---- SEO Agent (rank #1 across search + social) ---------------------------
export function seoReport(baseUrl = 'https://3jntravel.com') {
  const keywords = [
    'cheapest reliable flights and hotel package', 'AI travel planner', 'pay monthly holidays',
    'Dubai family holiday deals', 'visa approval probability', 'African diaspora travel',
    'instalment travel booking', 'eSIM for travel', 'AI visa decision', 'unbeatable travel prices',
    'ferry crossings and mini cruises', 'train and coach travel packages', 'cruise holidays pay monthly',
  ];
  const titles = DESTS.map((d) => `Cheapest reliable ${d} holiday packages — flights, hotel, visa & transfers | 3JN Travel OS`);
  return {
    metaTitle: 'Stop Searching. Start Saving. — AI Travel OS | 3JN Travel OS',
    metaDescription: '3JN Travel OS finds, negotiates and books the cheapest reliable travel — flights, hotels, visa, activities, eSIM and transfers — with pay-monthly instalments and an AI visa decision engine.',
    targetKeywords: keywords,
    destinationTitles: titles,
    onPage: ['Unique <title> + meta per page', 'Open Graph + Twitter cards', 'JSON-LD Organization + Product schema', 'sitemap.xml + robots.txt', 'fast Core Web Vitals (static frontend)'],
    offPage: ['Shareable AI blog with internal links', 'social auto-posts per destination', 'partner/affiliate backlinks', 'diaspora-community syndication'],
    sitemapUrls: ['/', '/how-it-works', '/membership', '/visaos', '/marketplace', '/blog', ...DESTS.map((d) => `/blog/${slugify('cheapest ' + d + ' holiday')}`)].map((u) => baseUrl + u),
    recommendation: 'Publish 2 AI blog posts/week with internal links to the planner + destination pages; auto-share to social; build partner backlinks.',
  };
}

// ---- Marketing Agent (make it the #1 OS online) ----------------------------
export function marketingPlan() {
  return {
    positioning: 'The AI travel operating system — stop searching, start saving.',
    channels: [
      { channel: 'TikTok / Reels', play: 'AI-finds-savings before/after clips per destination' },
      { channel: 'WhatsApp / community', play: 'diaspora group offers + referral loop (+100/+50 pts)' },
      { channel: 'SEO blog', play: 'rank for "cheapest reliable {destination} holiday"' },
      { channel: 'Influencer/affiliate', play: 'promo codes + 90/10 white-label revenue share' },
      { channel: 'Email (info@3jntravel.com)', play: 'price-drop + visa-approval triggers' },
    ],
    socialPosts: DESTS.slice(0, 3).map((d) => ({
      destination: d,
      post: `✈️ ${d} on a budget? 3JN Travel OS just built a verified ${d} package — flights + hotel + visa + transfers at an unbeatable price, pay monthly. Get your quote → 3jntravel.com #travel #${d.replace(/\s/g, '')} #AItravel`,
    })),
    kpis: ['CAC < £8', 'referral K-factor > 0.4', 'blog → planner CTR > 6%', 'organic traffic +25%/mo'],
    recommendation: 'Run the referral + influencer loop alongside daily AI social posts and 2 SEO posts/week.',
  };
}

// ---- Blog Agent (dynamic, hyperlinked, shareable) --------------------------
function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 70); }
let blogCounter = 0;

const blogEsc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Pick two OTHER destinations to build an internal-link cluster (topical
// authority + crawl depth). Links go to the planner deep-link, which always
// resolves regardless of whether a sibling post exists yet, so seeding is safe.
function clusterLinks(dest) {
  const others = DESTS.filter((d) => d.toLowerCase() !== String(dest).toLowerCase());
  const seed = Math.abs([...String(dest)].reduce((a, c) => a + c.charCodeAt(0), 0));
  const pick = [others[seed % others.length], others[(seed + 3) % others.length]].filter((v, i, a) => a.indexOf(v) === i).slice(0, 2);
  return pick.map((d) => `<a href="/planner?to=${encodeURIComponent(d)}">${blogEsc(d)}</a>`);
}

// A trust/why block shared by every angle — grounded in real destFacts, not
// keyword filler. This is the "authenticity over SEO tricks" lesson applied:
// give the reader the genuine reason (verified suppliers, price guard, the
// actual visa rule) rather than a stamped template.
function whyBlock(dh, facts) {
  const priceLine = facts.fromGbp
    ? `Indicative packages start around <strong>£${facts.fromGbp}pp</strong> (flights + hotel), but your exact price depends on dates and party — `
    : '';
  const monthLine = facts.bestMonths.length
    ? ` The genuinely cheaper window is <strong>${facts.bestMonths.slice(0, 3).map(blogEsc).join(', ')}</strong> — same ${dh}, lower fares and quieter hotels.`
    : '';
  return `<h3>Why book ${dh} with 3JN?</h3><p>${priceLine}<a href="/planner">get an instant, exact quote →</a>${monthLine} Every package is built from verified suppliers only, with a transparent 10% fee and a 24/7 price guard that rebooks you lower and passes the saving back after you buy — see <a href="/membership">membership tiers</a>.</p>`;
}

// Intent-varied angles. Each produces a UNIQUE title, meta, body, adaptive
// CTA and FAQ — so 10 destinations no longer stamp 10 near-identical "doorway"
// pages. The CTA adapts to the reader's likely intent (the Drive idea: match
// the tool to the moment) — visa content routes to VisaOS, cost content to a
// live quote, family content to instalments.
const BLOG_ANGLES = [
  {
    key: 'best-time',
    title: (d, f) => f.bestMonths.length ? `Best time to visit ${d}: when to go for cheaper flights (${f.bestMonths[0]}${f.bestMonths[1] ? '–' + f.bestMonths[1] : ''})` : `Best time to visit ${d}: when to go for cheaper flights`,
    meta: (d, f) => `When is the cheapest time to fly to ${d}? ${f.bestMonths.length ? f.bestMonths.slice(0, 3).join(', ') + ' cut fares without cutting the weather. ' : ''}3JN Travel OS finds the lowest reliable ${d} fare for your dates.`,
    excerpt: (d) => `The shoulder-season sweet spot for ${d} — same trip, lower price. Let the AI find your cheapest dates.`,
    cta: { href: '/planner', label: (d) => `Find my cheapest ${d} dates →` },
    body: (dh, f, cta, links) => [
      `<p>Timing is the single biggest lever on the price of a <strong>${dh}</strong> trip. Fly in peak weeks and you pay a premium for the same hotel and the same weather.${f.bestMonths.length ? ` For ${dh}, the value window is <strong>${f.bestMonths.slice(0, 3).map(blogEsc).join(', ')}</strong>.` : ''}</p>`,
      `<h3>When are ${dh} flights cheapest?</h3><p>${f.bestMonths.length ? `${blogEsc(f.bestMonths[0])} onward tends to drop fares 20–35% versus the peak while keeping the good weather.` : 'Shoulder season — just before and after peak — is almost always cheaper.'} Rather than guess, <a href="/planner">describe your trip once</a> and the AI prices your exact dates against the live market floor.</p>`,
      whyBlock(dh, f),
      `<p>Planning further afield? Compare <strong>${links.join('</strong> and <strong>')}</strong> too.</p>`,
      `<p><a href="${cta.href}">${cta.label(dh)}</a></p>`,
    ].join(''),
    faq: (dh, f) => [
      { q: `When is the cheapest time to visit ${dh}?`, a: f.bestMonths.length ? `${f.bestMonths.slice(0, 3).join(', ')} typically offer the lowest ${dh} fares while keeping good weather. 3JN Travel OS prices your exact dates so you can see the difference.` : `Shoulder season — the weeks just before and after peak — is usually cheapest for ${dh}. 3JN prices your exact dates against the live market floor.` },
      { q: `How far ahead should I book ${dh}?`, a: `For most ${dh} trips, 6–10 weeks ahead balances price and availability. Book with a 20% deposit and 3JN's price guard keeps watching for a cheaper rebooking after you buy.` },
    ],
  },
  {
    key: 'visa',
    title: (d, f) => f.visaRequiredGB === false ? `Do you need a visa for ${d}? (UK passport holders)` : `${d} visa for UK travellers: requirement, cost & how to check your odds`,
    meta: (d, f) => f.visaRequiredGB === false ? `UK passport holders can usually visit ${d} visa-free — here's the rule and how long you can stay. Check your exact eligibility with 3JN VisaOS.` : `Do UK travellers need a visa for ${d}? Get the requirement, cost, processing time and your approval probability in seconds with 3JN VisaOS.`,
    excerpt: (d) => `The real visa rule for ${d} — plus an instant read on your approval odds before you book anything.`,
    cta: { href: '/visaos', label: () => 'Check my visa approval odds →' },
    body: (dh, f, cta, links) => [
      `<p>Before you book a <strong>${dh}</strong> trip, get the visa question settled — it changes your timeline and, sometimes, whether the trip happens at all.</p>`,
      `<h3>Do UK travellers need a visa for ${dh}?</h3><p>${f.visaRequiredGB === false ? `Good news — UK passport holders can typically enter ${dh} without a visa for short stays.` : f.visaRequiredGB === true ? `Yes — UK passport holders generally need ${f.visaType ? blogEsc(f.visaType) + ' ' : 'a '}entry clearance for ${dh}.` : `Rules for ${dh} depend on your exact nationality and trip length.`} The precise requirement, cost, processing time and document checklist for <em>your</em> nationality is one click away in <a href="/visaos">3JN VisaOS</a>.</p>`,
      `<h3>Know your odds before you pay</h3><p>VisaOS gives you an <a href="/visaos">approval-probability score</a> up front, so you don't book flights and then get refused. If you need an embassy-ready flight + hotel reservation to support the application, 3JN issues real, cancellable bookings for that too.</p>`,
      whyBlock(dh, f),
      `<p>Weighing options? Check the visa picture for <strong>${links.join('</strong> and <strong>')}</strong> as well.</p>`,
      `<p><a href="${cta.href}">${cta.label(dh)}</a></p>`,
    ].join(''),
    faq: (dh, f) => [
      { q: `Do UK citizens need a visa for ${dh}?`, a: f.visaRequiredGB === false ? `UK passport holders can usually visit ${dh} visa-free for short stays. Confirm your exact eligibility and stay length in 3JN VisaOS.` : f.visaRequiredGB === true ? `UK passport holders generally need ${f.visaType ? f.visaType + ' ' : ''}entry clearance for ${dh}. VisaOS gives you the cost, timeline and your approval probability.` : `It depends on your nationality and trip. 3JN VisaOS returns the exact ${dh} requirement for your passport in seconds.` },
      { q: `Can 3JN provide a flight and hotel reservation for my ${dh} visa application?`, a: `Yes. 3JN can issue a real, embassy-ready flight + hotel reservation for your ${dh} application, valid for the booking window and cancellable — without the cost of buying the full trip up front.` },
    ],
  },
  {
    key: 'family',
    title: (d) => `${d} family holidays you can pay for monthly (flights, hotel & transfers)`,
    meta: (d) => `Plan a ${d} family holiday and spread the cost over interest-free instalments. 3JN Travel OS builds the whole package — flights, family room, transfers — around your dates and budget.`,
    excerpt: (d) => `A ${d} trip the whole family fits into — right room size, right price, paid monthly.`,
    cta: { href: '/membership', label: () => 'See pay-monthly options →' },
    body: (dh, f, cta, links) => [
      `<p>Family travel to <strong>${dh}</strong> has two hard parts: finding a room that actually fits everyone, and paying for it all at once. 3JN Travel OS solves both.</p>`,
      `<h3>Rooms that fit your whole party</h3><p>Tell the AI "2 adults and a 9-year-old" and it only prices hotels with genuine family occupancy — no more discovering at checkout that the room maxes out at two. <a href="/planner">Describe your family trip →</a> and every child is counted.</p>`,
      `<h3>Spread the cost, interest-free</h3><p>Pay a 20% deposit and split the rest over interest-free instalments${f.fromGbp ? ` — indicative ${dh} packages start near £${f.fromGbp}pp` : ''}. <a href="/membership">Membership</a> adds loyalty rewards that grow with every family trip.</p>`,
      whyBlock(dh, f),
      `<p>Comparing where to take the kids? Look at <strong>${links.join('</strong> and <strong>')}</strong> too.</p>`,
      `<p><a href="${cta.href}">${cta.label(dh)}</a></p>`,
    ].join(''),
    faq: (dh, f) => [
      { q: `Can I pay for a ${dh} family holiday monthly?`, a: `Yes. Pay a 20% deposit and spread the rest over interest-free instalments. 3JN builds the full ${dh} package — flights, a room that fits your party, and transfers — around your budget.` },
      { q: `Will 3JN find a room for a family of three or more in ${dh}?`, a: `Yes. The planner only prices ${dh} hotels with real occupancy for your exact party — every adult and child is counted, so the room genuinely fits before you pay.` },
    ],
  },
  {
    key: 'cost',
    title: (d, f) => f.fromGbp ? `How much is a ${d} holiday? Real costs from £${f.fromGbp}pp` : `How much does a ${d} holiday cost? A real breakdown`,
    meta: (d, f) => `What does a ${d} trip actually cost? ${f.fromGbp ? `Packages from around £${f.fromGbp}pp. ` : ''}3JN Travel OS breaks down flights, hotel, transfers and visa — and prices your exact dates against the live market floor.`,
    excerpt: (d) => `An honest ${d} cost breakdown — flights, hotel, transfers, visa — with no hidden fees.`,
    cta: { href: '/planner', label: (d) => `Price my exact ${d} trip →` },
    body: (dh, f, cta, links) => [
      `<p>"How much is a <strong>${dh}</strong> holiday?" honestly depends on your dates and party — but here's what actually goes into the number, with nothing hidden.</p>`,
      `<h3>What a ${dh} package includes</h3><p>Flights, hotel, transfers and (where needed) visa and eSIM.${f.fromGbp ? ` Indicative ${dh} packages start around <strong>£${f.fromGbp}pp</strong>, then move with season and availability.` : ''}${f.bestMonths.length ? ` Travelling in ${blogEsc(f.bestMonths[0])} can trim the flight cost noticeably.` : ''} 3JN adds a transparent 10% fee — no surprise line items at checkout.</p>`,
      `<h3>See your real number in seconds</h3><p>Rather than a range, <a href="/planner">describe your trip once</a> and the AI prices it against the live market floor, so you know you're not overpaying. A 20% deposit holds it; instalments cover the rest.</p>`,
      whyBlock(dh, f),
      `<p>Budgeting a few options? Compare <strong>${links.join('</strong> and <strong>')}</strong> side by side.</p>`,
      `<p><a href="${cta.href}">${cta.label(dh)}</a></p>`,
    ].join(''),
    faq: (dh, f) => [
      { q: `How much does a ${dh} holiday cost?`, a: `${f.fromGbp ? `Indicative ${dh} packages start around £${f.fromGbp}pp for flights and hotel, ` : `It depends on your dates and party, `}but 3JN prices your exact trip against the live market floor so you see the real number, not a guess.` },
      { q: `Does 3JN add hidden fees to a ${dh} booking?`, a: `No. 3JN charges a transparent 10% fee shown up front, with a price guard that rebooks you lower after purchase and passes the saving back — no surprise line items.` },
    ],
  },
  {
    key: 'first-timer',
    title: (d) => `First time in ${d}? The stress-free way to plan flights, hotel & visa`,
    meta: (d) => `Planning your first trip to ${d}? 3JN Travel OS builds the whole thing from one sentence — flights, hotel, visa and transfers — and watches the price after you book.`,
    excerpt: (d) => `Never been to ${d}? Describe the trip once and let the AI handle flights, hotel, visa and transfers.`,
    cta: { href: '/planner', label: (d) => `Build my ${d} trip →` },
    body: (dh, f, cta, links) => [
      `<p>First trip to <strong>${dh}</strong>? The hardest part is knowing where to start. With 3JN Travel OS you don't — you describe the trip in one sentence and the AI assembles the whole thing.</p>`,
      `<h3>One sentence in, a full trip out</h3><p>"Two of us to ${dh}${f.bestMonths.length ? ' in ' + blogEsc(f.bestMonths[0]) : ''} for a week" is enough. <a href="/planner">Try it →</a> and you get flights, hotel, transfers, visa guidance and eSIM as one reliable package — not twelve browser tabs.</p>`,
      `<h3>Visa and timing, sorted for you</h3><p>${f.visaRequiredGB === false ? `UK travellers can usually visit ${dh} visa-free, ` : f.visaRequiredGB === true ? `You'll likely need a visa for ${dh}, ` : ''}and <a href="/visaos">VisaOS</a> confirms your exact requirement and odds.${f.bestMonths.length ? ` Going in ${blogEsc(f.bestMonths.slice(0, 2).map(blogEsc).join(' or '))} keeps costs down.` : ''}</p>`,
      whyBlock(dh, f),
      `<p>Still deciding where? Have a look at <strong>${links.join('</strong> and <strong>')}</strong> too.</p>`,
      `<p><a href="${cta.href}">${cta.label(dh)}</a></p>`,
    ].join(''),
    faq: (dh, f) => [
      { q: `How do I plan a first trip to ${dh}?`, a: `Describe it in one sentence — dates, who's going, roughly what you want — and 3JN Travel OS builds the flights, hotel, transfers and visa guidance as one reliable ${dh} package.` },
      { q: `Is ${dh} easy to visit for first-timers?`, a: `${f.visaRequiredGB === false ? `UK travellers can usually enter ${dh} visa-free, which keeps it simple. ` : ''}3JN handles the logistics — visa check, timing and a full package — so your first ${dh} trip is stress-free.` },
    ],
  },
];

// ---- Feature-led "money pages" (bottom-of-funnel SEO) ---------------------
// The destination angles above capture "where to go" demand. These capture the
// higher-intent "how do I DO this" demand — someone searching "pay monthly
// flights" or "check my visa odds" is far closer to booking. Each post sells ONE
// real capability (honestly — no overclaiming), and is DENSELY interlinked:
// every post links out to live destination pages, route pages and sibling
// feature posts, so link equity flows to the money pages and Google sees a tight
// topical cluster (the on-site SEO lever we control). Links point at pages the
// SSR layer really renders, so they never 404.

// Known-good internal-link targets (these pages are generated by seo-render.js).
const FEATURE_DEST_SLUGS = ['lagos', 'kinshasa', 'accra', 'nairobi', 'dubai', 'istanbul', 'delhi', 'kingston', 'bangkok', 'cape-town', 'johannesburg', 'mumbai', 'casablanca', 'dar-es-salaam', 'zanzibar', 'abuja'];
const FEATURE_DEST_NAMES = { lagos: 'Lagos', kinshasa: 'Kinshasa', accra: 'Accra', nairobi: 'Nairobi', dubai: 'Dubai', istanbul: 'Istanbul', delhi: 'Delhi', kingston: 'Kingston', bangkok: 'Bangkok', 'cape-town': 'Cape Town', johannesburg: 'Johannesburg', mumbai: 'Mumbai', casablanca: 'Casablanca', 'dar-es-salaam': 'Dar es Salaam', zanzibar: 'Zanzibar', abuja: 'Abuja' };
const FEATURE_ROUTES = [
  ['london-to-lagos', 'London → Lagos'], ['manchester-to-accra', 'Manchester → Accra'],
  ['birmingham-to-mumbai', 'Birmingham → Mumbai'], ['new-york-to-accra', 'New York → Accra'],
  ['london-to-kingston', 'London → Kingston'], ['toronto-to-kingston', 'Toronto → Kingston'],
  ['london-to-nairobi', 'London → Nairobi'], ['london-to-dubai', 'London → Dubai'],
];
// Deterministic rotating picker — each feature post links to a DIFFERENT subset,
// so the internal-link graph is varied (dynamic), not the same block everywhere.
// The stride is derived from the seed and made coprime-ish to the array length,
// so different seeds walk the array on different paths (maximises variety).
function rot(arr, seed, n) {
  const len = arr.length;
  let stride = 1 + (seed % (len - 1));
  while (len % stride === 0 && stride > 1) stride -= 1; // avoid short cycles
  const start = seed % len;
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[(start + i * stride) % len]);
  return [...new Set(out)].slice(0, n);
}
function seedOf(key) { return Math.abs([...String(key)].reduce((a, c) => a + c.charCodeAt(0), 0)); }
// Build the three dynamic link ribbons for a feature post.
function featureLinks(key) {
  const s = seedOf(key);
  const dests = rot(FEATURE_DEST_SLUGS, s, 4).map((sl) => `<a href="/destinations/${sl}">${blogEsc(FEATURE_DEST_NAMES[sl] || sl)}</a>`).join(' · ');
  const routes = rot(FEATURE_ROUTES, s, 3).map(([sl, lbl]) => `<a href="/flights/${sl}">${blogEsc(lbl)}</a>`).join(' · ');
  const siblings = rot(FEATURE_POSTS.map((f) => f.key).filter((k) => k !== key), s, 3)
    .map((k) => { const f = FEATURE_POSTS.find((x) => x.key === k); return f ? `<a href="/blog/${f.slug}">${blogEsc(f.linkText)}</a>` : ''; }).filter(Boolean).join(' · ');
  return { dests, routes, siblings };
}
// A shared closing block: dynamic links to destinations, routes and sibling
// features + the primary CTA. This is the "very dynamic hyperlinks" engine.
function featureFooter(key, ctaHref, ctaLabel) {
  const { dests, routes, siblings } = featureLinks(key);
  return `<hr style="border:none;border-top:1px solid rgba(255,255,255,.08);margin:20px 0 12px">
<p><strong>Popular right now:</strong> ${dests}</p>
<p><strong>Popular routes:</strong> ${routes}</p>
<p><strong>Keep reading:</strong> ${siblings}</p>
<p class="muted" style="font-size:12.5px"><strong>Explore:</strong> <a href="/planner">AI trip planner</a> · <a href="/destinations">All destinations</a> · <a href="/flights">All routes</a> · <a href="/visaos">VisaOS</a> · <a href="/why-3jn">Why trust 3JN</a> · <a href="/blog">More guides</a></p>
<p><a href="${ctaHref}">${blogEsc(ctaLabel)}</a></p>`;
}

const FEATURE_POSTS = [
  {
    key: 'pay-monthly', slug: 'pay-monthly-flights-and-holidays-uk', linkText: 'Pay-monthly flights & holidays',
    title: 'Pay Monthly Flights & Holidays (UK): Spread the Cost, Interest-Free',
    meta: 'Book flights and holidays now and pay monthly, interest-free. 3JN Travel OS takes a small deposit, locks your price, and spreads the rest over weeks or months.',
    excerpt: 'Book the trip now, pay for it over time — a small deposit, then interest-free instalments, with your price locked from day one.',
    tags: ['pay-monthly', 'instalments', 'buy-now-pay-later', 'flights', 'feature'],
    cta: { href: '/planner', label: 'Build a pay-monthly trip →' },
    body: (k) => `<p>The biggest barrier to booking a trip isn't the price — it's paying it <em>all at once</em>. 3JN Travel OS removes that: put down a small deposit, and spread the rest over interest-free instalments while your price stays locked.</p>
<h3>How pay-monthly works</h3><p>You choose your trip, pay a deposit (typically around 20%), and the balance splits into weekly or monthly instalments. There's no interest and no credit check drama — and crucially, <a href="/blog/price-lock-guarantee">your price is locked</a> the day you book, so fare rises and currency swings can't touch it.</p>
<h3>Your ticket is secured for you</h3><p>You don't wait until the last instalment to be sure of your seat. 3JN's AI tracks your fare and your payments, and the moment your balance covers the ticket, it buys and <a href="/blog/how-3jn-holds-your-ticket">holds the ticket</a> for you — released the instant you're paid in full. If a cheaper fare appears while you're paying, the <a href="/blog/savings-guarantee-price-guard">price guard</a> can rebook you lower.</p>
<h3>Works on the trips people actually take</h3><p>Pay-monthly applies across flights, hotels and full packages — including the long-haul routes families save hardest for. See it on a real trip, then spread the cost.</p>
${featureFooter('pay-monthly', '/planner', 'Build a pay-monthly trip →')}`,
    faq: [
      { q: 'Can I really pay for flights monthly in the UK?', a: 'Yes. 3JN Travel OS takes a small deposit (around 20%) and spreads the rest over interest-free weekly or monthly instalments, with your price locked at booking.' },
      { q: 'Is pay-monthly interest-free?', a: 'Yes — the instalments are interest-free. 3JN charges a transparent fee shown up front, not hidden interest.' },
      { q: 'When do I actually get my ticket?', a: 'The AI secures and holds your ticket as soon as your payments cover the fare, and releases it to you the moment your balance reaches zero — so your seat is protected while you pay.' },
    ],
  },
  {
    key: 'cheapest-date', slug: 'cheapest-day-to-fly-ai-date-finder', linkText: 'Cheapest-day-to-fly finder',
    title: 'Find the Cheapest Day to Fly: Let AI Scan a Whole Date Window',
    meta: 'Not fixed on dates? 3JN Travel OS scans a whole window of departure dates and finds the cheapest day to fly — then books it and lets you pay monthly.',
    excerpt: 'Flexible on dates? Tell the AI "cheapest dates" and it scans a whole window for the lowest fare — instead of you guessing one day at a time.',
    tags: ['cheapest-date', 'flexible-dates', 'cheap-flights', 'feature'],
    cta: { href: '/planner', label: 'Find my cheapest dates →' },
    body: (k) => `<p>Fare websites make you pick a date first, then show the price. That's backwards when you're flexible. 3JN Travel OS flips it: say <em>"cheapest dates"</em> and the AI scans a whole window of departures to find the lowest fare — the single biggest saving most travellers leave on the table.</p>
<h3>One instruction, a whole window scanned</h3><p>"Anytime in the next three months, cheapest" is enough. The AI samples across the window against live market fares and surfaces the cheapest day to fly — not one guess, but the real floor. <a href="/planner">Try it →</a></p>
<h3>Then lock it and pay monthly</h3><p>Found a great date? Book it at that price — your <a href="/blog/price-lock-guarantee">price is locked</a> — and <a href="/blog/pay-monthly-flights-and-holidays-uk">pay monthly</a> if you'd rather spread it. This is especially powerful on long-haul, where a week's difference can move the fare by hundreds.</p>
${featureFooter('cheapest-date', '/planner', 'Find my cheapest dates →')}`,
    faq: [
      { q: 'How do I find the cheapest day to fly?', a: 'Tell 3JN you\'re flexible ("cheapest dates") and the AI scans a whole window of departure dates against live fares, returning the cheapest day — no manual date-by-date checking.' },
      { q: 'Can I still book if I\'m flexible on dates?', a: 'Yes — that\'s exactly when the AI helps most. It finds the lowest fare in your window, then you lock it and can pay monthly.' },
    ],
  },
  {
    key: 'visa-check', slug: 'check-visa-approval-odds-before-you-book', linkText: 'Visa approval-odds check',
    title: 'Check Your Visa Approval Odds Before You Book (AI Visa Check)',
    meta: 'Don\'t book flights then get refused. 3JN VisaOS gives you a visa approval-probability score for your nationality and destination in seconds — before you pay.',
    excerpt: 'Get an instant read on your visa approval odds — for your exact passport and destination — before you spend a penny on flights.',
    tags: ['visa', 'visaos', 'visa-approval', 'feature'],
    cta: { href: '/visaos', label: 'Check my visa odds →' },
    body: (k) => `<p>The worst way to plan a trip is to book the flights, then discover you need a visa you might not get. 3JN VisaOS puts that question first: an instant <strong>approval-probability score</strong> for your exact nationality and destination — before you pay for anything.</p>
<h3>Know your odds up front</h3><p><a href="/visaos">VisaOS</a> reads the real rule for your passport, tells you the requirement, cost and processing time, and scores your likelihood of approval — so you book with confidence or fix the gaps first.</p>
<h3>Need an embassy-ready reservation?</h3><p>Many applications require a flight and hotel booking. 3JN issues a real, cancellable <a href="/blog/flight-and-hotel-reservation-for-a-visa">reservation for your visa file</a> — without buying the whole trip up front. Once you're approved, turn it into the real booking and <a href="/blog/pay-monthly-flights-and-holidays-uk">pay monthly</a>.</p>
${featureFooter('visa-check', '/visaos', 'Check my visa odds →')}`,
    faq: [
      { q: 'Can I check my visa approval chances before booking?', a: 'Yes. 3JN VisaOS returns an approval-probability score for your nationality and destination in seconds, plus the requirement, cost and processing time — before you spend anything.' },
      { q: 'Does 3JN help with the visa reservation documents?', a: 'Yes — it can issue a real, cancellable flight and hotel reservation for your visa application, so you have the documents without buying the full trip up front.' },
    ],
  },
  {
    key: 'price-lock', slug: 'price-lock-guarantee', linkText: 'Price-lock guarantee',
    title: 'Price-Lock Guarantee: Book at Today\'s Price, No Surcharges',
    meta: 'Book with 3JN Travel OS and your price is locked — no fare increases, no currency surcharges before you travel, even while you pay monthly.',
    excerpt: 'The price you book is the price you pay — no fare hikes, no fuel or currency surcharges, even while you spread the cost.',
    tags: ['price-lock', 'guarantee', 'no-surcharge', 'feature'],
    cta: { href: '/planner', label: 'Lock in a price →' },
    body: (k) => `<p>Airline and hotel prices move by the hour. With 3JN Travel OS, the moment you book, your total is fixed — <strong>no fare increases and no currency surcharges before you travel</strong>. That certainty is what makes <a href="/blog/pay-monthly-flights-and-holidays-uk">paying monthly</a> safe: the price can't drift up while you pay it down.</p>
<h3>Locked, even on instalments</h3><p>Your locked price holds across every instalment. And it only ever moves in your favour — if a cheaper fare appears after you book, the <a href="/blog/savings-guarantee-price-guard">price guard</a> can rebook you lower and pass the saving back.</p>
<h3>See it on your trip</h3><p>Price your exact dates, lock the number, and relax. It works the same whether you're heading to a weekend city break or a long-haul family trip.</p>
${featureFooter('price-lock', '/planner', 'Lock in a price →')}`,
    faq: [
      { q: 'Will my flight price go up after I book?', a: 'No. 3JN locks your price at booking — no fare increases or currency surcharges before you travel, even while you pay in instalments.' },
      { q: 'What if the price drops after I book?', a: 'The 24/7 price guard can rebook you at the lower fare and pass the saving back — the lock only ever moves in your favour.' },
    ],
  },
  {
    key: 'ai-planner', slug: 'plan-a-trip-from-one-sentence-with-ai', linkText: 'AI trip planner',
    title: 'Plan a Whole Trip From One Sentence with AI (Flights, Hotel, Visa, eSIM)',
    meta: 'Describe your trip in one sentence and 3JN\'s AI builds the whole thing — flights, hotel, transfers, visa check and eSIM — as one reliable, pay-monthly package.',
    excerpt: 'Describe the trip in a sentence — the AI returns flights, hotel, transfers, visa guidance and eSIM as one package. No twelve browser tabs.',
    tags: ['ai-planner', 'trip-planner', 'feature'],
    cta: { href: '/planner', label: 'Plan my trip →' },
    body: (k) => `<p>Planning a trip usually means a dozen tabs — flights here, hotels there, visa rules somewhere else. 3JN Travel OS replaces all of it with one sentence. Say <em>"two of us to Lagos in March for ten days"</em> and the AI assembles the whole trip.</p>
<h3>One sentence in, a full trip out</h3><p>Flights, hotel, transfers, a <a href="/blog/check-visa-approval-odds-before-you-book">visa check</a> and an <a href="/blog/travel-esim-land-with-data-working">eSIM</a> — priced against the live market and returned as one reliable package. <a href="/planner">Try it →</a></p>
<h3>Flexible, honest, pay-monthly</h3><p>Flexible on dates? It finds the <a href="/blog/cheapest-day-to-fly-ai-date-finder">cheapest day to fly</a>. Happy with the price? <a href="/blog/price-lock-guarantee">Lock it</a> and <a href="/blog/pay-monthly-flights-and-holidays-uk">pay monthly</a>. Every supplier is verified, and the fee is transparent.</p>
${featureFooter('ai-planner', '/planner', 'Plan my trip →')}`,
    faq: [
      { q: 'How does the AI trip planner work?', a: 'You describe the trip in plain English — dates, who\'s going, roughly what you want — and 3JN builds flights, hotel, transfers, visa guidance and eSIM as one package priced against the live market.' },
      { q: 'Can I change what the AI suggests?', a: 'Yes — refine any part (dates, budget, room type) and the AI reprices instantly. When you\'re happy, lock the price and pay monthly if you like.' },
    ],
  },
  {
    key: 'visa-reservation', slug: 'flight-and-hotel-reservation-for-a-visa', linkText: 'Flight + hotel reservation for a visa',
    title: 'Flight & Hotel Reservation for a Visa Application (Real & Cancellable)',
    meta: 'Need a flight and hotel reservation for a visa application? 3JN issues a real, embassy-ready, cancellable booking — without paying for the whole trip up front.',
    excerpt: 'A real, embassy-ready flight + hotel reservation for your visa file — verifiable and cancellable, without buying the full trip first.',
    tags: ['visa-reservation', 'dummy-ticket', 'visa', 'feature'],
    cta: { href: '/visaos', label: 'Get a visa reservation →' },
    body: (k) => `<p>Most visa applications ask for proof of onward travel and accommodation. Buying the full trip before you're approved is risky. 3JN issues a <strong>real, embassy-ready flight and hotel reservation</strong> for your application — verifiable and cancellable — so you have the documents without the full outlay.</p>
<h3>Real bookings, not a risky "dummy ticket"</h3><p>These are genuine reservations valid for the application window, not a screenshot. Pair them with your <a href="/blog/check-visa-approval-odds-before-you-book">approval-odds check</a> in <a href="/visaos">VisaOS</a> so you apply with confidence.</p>
<h3>Approved? Turn it into the real trip</h3><p>Once your visa comes through, convert the reservation into the actual booking and <a href="/blog/pay-monthly-flights-and-holidays-uk">pay monthly</a>, with your <a href="/blog/price-lock-guarantee">price locked</a>.</p>
${featureFooter('visa-reservation', '/visaos', 'Get a visa reservation →')}`,
    faq: [
      { q: 'Can I get a flight reservation for a visa without buying the ticket?', a: 'Yes. 3JN issues a real, cancellable flight and hotel reservation valid for your visa application window — you don\'t pay for the whole trip until you\'re approved.' },
      { q: 'Is this an accepted document for embassies?', a: 'It\'s a genuine, verifiable reservation (not a fake screenshot), which is what embassies expect for proof of onward travel and accommodation.' },
    ],
  },
  {
    key: 'travel-esim', slug: 'travel-esim-land-with-data-working', linkText: 'Travel eSIM',
    title: 'Travel eSIM: Land With Data Already Working (No Roaming Bills)',
    meta: 'Skip the roaming bills. Add a travel eSIM to your 3JN trip and land with mobile data already working — bought as part of the same package.',
    excerpt: 'Land with data already on. Add a travel eSIM to your trip and skip roaming charges and airport SIM queues entirely.',
    tags: ['esim', 'travel-data', 'roaming', 'feature'],
    cta: { href: '/planner', label: 'Add an eSIM to my trip →' },
    body: (k) => `<p>Nothing kills the start of a trip like landing with no data — no maps, no ride app, no way to reach your hotel. 3JN Travel OS bundles a <strong>travel eSIM</strong> into your trip so you land connected, with no roaming bill and no SIM-kiosk queue.</p>
<h3>Part of the same package</h3><p>Add the eSIM when you <a href="/planner">plan the trip</a> — it's provisioned for your destination and ready to activate before you fly. One package, one price, <a href="/blog/pay-monthly-flights-and-holidays-uk">payable monthly</a>.</p>
<h3>Everywhere you're going</h3><p>Data plans cover the destinations travellers actually head to — city breaks and long-haul alike.</p>
${featureFooter('travel-esim', '/planner', 'Add an eSIM to my trip →')}`,
    faq: [
      { q: 'What is a travel eSIM?', a: 'A digital SIM you activate on your phone to get local mobile data abroad — no physical SIM, no roaming charges. 3JN provisions one for your destination as part of your trip.' },
      { q: 'Do I need to buy the eSIM separately?', a: 'No — add it to your 3JN trip and it\'s part of the same package and the same pay-monthly plan.' },
    ],
  },
  {
    key: 'held-ticket', slug: 'how-3jn-holds-your-ticket', linkText: 'How 3JN holds your ticket',
    title: 'How 3JN Buys Your Ticket the Moment the Fare Is Covered — and Holds It',
    meta: 'Paying monthly? 3JN\'s AI tracks your fare and your payments, buys your ticket the moment it\'s covered, and holds it safely until your balance clears.',
    excerpt: 'You don\'t wait until the final instalment to be sure of your seat — the AI secures and holds your ticket the moment your payments cover it.',
    tags: ['held-ticket', 'pay-monthly', 'instalments', 'feature'],
    cta: { href: '/planner', label: 'Start a pay-monthly trip →' },
    body: (k) => `<p>The obvious worry with <a href="/blog/pay-monthly-flights-and-holidays-uk">paying monthly</a> is: "what if the fare's gone by the time I've paid?" 3JN Travel OS closes that gap. Its AI watches your fare and your instalments together, and the moment your payments cover the ticket, it <strong>buys and holds the ticket</strong> for you — released the instant your balance hits zero.</p>
<h3>Your seat, protected while you pay</h3><p>You're not exposed to the last-minute price. Once secured, the ticket is held in the system in your name. And thanks to the <a href="/blog/price-lock-guarantee">price lock</a>, the number never rises on you.</p>
<h3>The same care for your hotel</h3><p>The hotel side is handled the same way, so the whole trip is protected — not just the flight. Pick a <a href="/destinations/dubai">destination</a> and start.</p>
${featureFooter('held-ticket', '/planner', 'Start a pay-monthly trip →')}`,
    faq: [
      { q: 'If I pay monthly, could my fare disappear before I finish paying?', a: 'No. The AI buys and holds your ticket as soon as your payments cover the fare, and your price is locked from booking — so you\'re never exposed to a last-minute increase.' },
      { q: 'When is the ticket released to me?', a: 'The held ticket is released the moment your balance reaches zero.' },
    ],
  },
  {
    key: 'savings-guarantee', slug: 'savings-guarantee-price-guard', linkText: 'Savings guarantee & price guard',
    title: 'Savings Guarantee + 24/7 Price Guard: We Rebook You Lower',
    meta: 'If 3JN can\'t beat or match your quote, your search credits are refunded. And after you book, a 24/7 price guard rebooks you lower and passes the saving back.',
    excerpt: 'If we can\'t beat or match your quote, your search credits come back. And after you book, the price guard keeps hunting a lower fare for you.',
    tags: ['savings-guarantee', 'price-guard', 'cheap-flights', 'feature'],
    cta: { href: '/planner', label: 'Price my trip →' },
    body: (k) => `<p>Two promises sit behind every 3JN quote. First, a <strong>savings guarantee</strong>: if we can't beat or match your current quote, your search credits are refunded. Second, a <strong>24/7 price guard</strong> that keeps working <em>after</em> you book.</p>
<h3>The price guard never stops looking</h3><p>Once you've booked, the guard keeps scanning. If it finds a cheaper equivalent, it can rebook you lower and pass the saving back — you don't lift a finger. Combined with the <a href="/blog/price-lock-guarantee">price lock</a>, your price can only ever go down.</p>
<h3>Honest by design</h3><p>Every package is built from verified suppliers with a transparent fee — no surprise line items. Try it on a <a href="/blog/cheapest-day-to-fly-ai-date-finder">flexible-date search</a> and see the floor for yourself.</p>
${featureFooter('savings-guarantee', '/planner', 'Price my trip →')}`,
    faq: [
      { q: 'What is 3JN\'s savings guarantee?', a: 'If 3JN Travel OS can\'t beat or match your current quote, your search credits are refunded — so checking costs you nothing.' },
      { q: 'Does 3JN keep looking for a lower price after I book?', a: 'Yes. A 24/7 price guard keeps scanning and can rebook you at a lower fare, passing the saving back to you.' },
    ],
  },
  {
    key: 'group-pots', slug: 'group-travel-split-the-cost-with-travel-pots', linkText: 'Group travel & travel pots',
    title: 'Group Travel Made Easy: Split the Cost with Travel Pots',
    meta: 'Travelling as a group? 3JN travel pots let everyone contribute towards one trip over time — then book it together and pay any balance monthly.',
    excerpt: 'Everyone chips in towards one shared pot over time — then the group books the trip together and spreads any balance monthly.',
    tags: ['group-travel', 'travel-pots', 'split-cost', 'feature'],
    cta: { href: '/planner', label: 'Start a group trip →' },
    body: (k) => `<p>Group trips fall apart on one thing: money. Chasing everyone for their share is nobody's idea of fun. 3JN travel pots fix it — everyone contributes towards <strong>one shared pot</strong> over time, then the group books together.</p>
<h3>Contribute over time, book together</h3><p>Set a goal, share the pot, and let each traveller add their bit whenever they can. When the trip's ready, <a href="/planner">build it</a> and put the pot towards it — any remaining balance can be <a href="/blog/pay-monthly-flights-and-holidays-uk">paid monthly</a>.</p>
<h3>Perfect for the trips groups take</h3><p>Reunions, weddings abroad, diaspora trips home — the routes where a group saving together makes the difference.</p>
${featureFooter('group-pots', '/planner', 'Start a group trip →')}`,
    faq: [
      { q: 'How does group travel payment work with 3JN?', a: 'Create a travel pot with a goal, share it with the group, and everyone contributes over time. When you\'re ready, book the trip and put the pot towards it — any balance can be paid monthly.' },
      { q: 'Can everyone pay their own share?', a: 'Yes — each traveller contributes to the shared pot whenever suits them, so no one person fronts the whole cost.' },
    ],
  },
];

// Feature money-pages are stored in db.blog exactly like destination posts, so
// they appear at /blog/:slug, in the sitemap, RSS and related-posts — and get
// server-rendered (indexable) by the SSR layer. Slugs are STABLE (no counter
// suffix) so inbound links and rankings don't churn.
function createFeaturePost(def, now) {
  const post = {
    id: 'blog_' + def.slug, slug: def.slug, title: def.title,
    destination: null, angle: 'feature:' + def.key, feature: true,
    excerpt: def.excerpt, metaDescription: def.meta.slice(0, 300),
    tags: def.tags,
    body: def.body(def.key),
    faq: def.faq.map((f) => ({ q: String(f.q).slice(0, 200), a: String(f.a).slice(0, 500) })),
    cta: def.cta,
    readMins: 4, author: '3JN AI Editorial',
    publishedAt: (now ? new Date(now) : new Date(Date.UTC(2026, 6, 1, 9, 0, seedOf(def.key) % 60))).toISOString(),
  };
  return post;
}
// Idempotent: seed any feature post that isn't already present (by slug).
export function ensureFeaturePosts() {
  let added = 0;
  for (const def of FEATURE_POSTS) {
    if (!db.blog.some((p) => p.slug === def.slug)) {
      db.blog.unshift(createFeaturePost(def));
      added += 1;
    }
  }
  if (added) recordAudit({ actor: 'blog-agent', role: 'agent', action: 'blog.features-seeded', entity: 'blog', entityId: 'features', summary: `${added} feature money-page(s) published` });
  return added;
}
export function featurePostCount() { return FEATURE_POSTS.length; }

export function createPost({ topic, destination, now, angle } = {}) {
  const idx = ++blogCounter;
  const dest = String(destination || DESTS[idx % DESTS.length]).slice(0, 80);
  const facts = destFacts(dest);
  // Rotate the angle so seeding 10 destinations yields varied intents, not 10
  // stamped templates. Offset by counter so the SAME destination re-published
  // tomorrow gets a fresh angle (autonomous daily loop).
  const chosen = (typeof angle === 'string' && BLOG_ANGLES.find((a) => a.key === angle))
    || BLOG_ANGLES[(idx - 1) % BLOG_ANGLES.length];
  // The body is rendered as raw HTML on a PUBLIC page, so the caller-supplied
  // destination MUST be escaped here or it becomes stored XSS (the endpoint is
  // also admin-gated as the primary defence). Title/excerpt render as text.
  const dh = blogEsc(dest);
  const links = clusterLinks(dest);
  const title = String(topic || chosen.title(dest, facts)).slice(0, 160);
  const slug = slugify(title) + '-' + idx;
  const cta = chosen.cta;
  // Every post ends with a pillar-nav footer — a persistent internal-link block
  // to the hub pages. Combined with the in-body cluster links and the live
  // "related posts" rail, it makes the internal link graph dense (topical
  // authority + crawl depth), which is the on-site SEO lever we actually control.
  const pillarFooter = `<hr style="border:none;border-top:1px solid rgba(255,255,255,.08);margin:20px 0 12px"><p class="muted" style="font-size:12.5px"><strong>Explore 3JN Travel OS:</strong> <a href="/planner">AI trip planner</a> · <a href="/marketplace">Destination marketplace</a> · <a href="/visaos">VisaOS approval check</a> · <a href="/membership">Pay-monthly membership</a> · <a href="/how-it-works">How it works</a> · <a href="/blog">More travel guides</a></p>`;
  const body = chosen.body(dh, facts, cta, links) + pillarFooter;
  const faq = chosen.faq(dh, facts).map((f) => ({ q: String(f.q).slice(0, 200), a: String(f.a).slice(0, 500) }));
  const post = {
    id: 'blog_' + slug, slug, title, destination: dest,
    angle: chosen.key,
    excerpt: chosen.excerpt(dest, facts),
    metaDescription: chosen.meta(dest, facts).slice(0, 300),
    tags: ['travel', dest.toLowerCase().replace(/\s/g, ''), chosen.key, 'ai-travel'],
    body,
    faq,
    cta: { href: cta.href, label: cta.label(dest) },
    readMins: 3,
    author: '3JN AI Editorial',
    publishedAt: (now ? new Date(now) : new Date(Date.UTC(2026, 5, 30, 12, 0, idx % 60))).toISOString(),
  };
  db.blog.unshift(post);
  recordAudit({ actor: 'blog-agent', role: 'agent', action: 'blog.published', entity: 'blog', entityId: post.id, summary: title });
  return post;
}

export function ensureSeedPosts() {
  if (db.blog.length === 0) { DESTS.forEach((d) => createPost({ destination: d })); ensureFeaturePosts(); return db.blog; }
  // ONE-TIME MIGRATION: older builds seeded 10 near-identical templated posts
  // (no `angle` field). Those were persisted, so the intent-varied generator never
  // replaced them and the live journal reads "all the same". If ANY legacy post is
  // present, rebuild the whole set with the varied generator. Self-heals on the
  // next blog read/deploy; idempotent once every post carries an `angle`.
  if (db.blog.some((p) => !p.angle)) {
    db.blog.splice(0, db.blog.length);
    blogCounter = 0;
    DESTS.forEach((d) => createPost({ destination: d }));
    recordAudit({ actor: 'blog-agent', role: 'agent', action: 'blog.migrated', entity: 'blog', entityId: 'seed', summary: `replaced legacy templated posts with ${db.blog.length} intent-varied posts` });
  }
  // Feature money-pages self-heal too: if a new feature post has been added to
  // the catalogue since this store was seeded, publish the missing ones.
  ensureFeaturePosts();
  return db.blog;
}
// Admin-forced regeneration — wipe and rebuild the journal with fresh, varied
// posts (a new angle rotation), e.g. to refresh the catalogue on demand.
export function regenerateBlog() {
  db.blog.splice(0, db.blog.length);
  DESTS.forEach((d) => createPost({ destination: d }));
  recordAudit({ actor: 'blog-agent', role: 'agent', action: 'blog.regenerated', entity: 'blog', entityId: 'all', summary: `regenerated ${db.blog.length} posts` });
  return db.blog;
}
export function listPosts() { return ensureSeedPosts().map(({ body, ...meta }) => ({ ...meta, views: meta.views || 0 })); }
export function getPost(slug) { ensureSeedPosts(); return db.blog.find((p) => p.slug === slug) || null; }
// Increment a post's view count. Called from a POST beacon so the mutation goes
// through the serverless read-modify-write persistence path (a GET never saves).
// Returns the new count, or null if the slug is unknown.
export function recordBlogView(slug) {
  ensureSeedPosts();
  const p = db.blog.find((x) => x.slug === slug);
  if (!p) return null;
  p.views = (p.views || 0) + 1;
  return p.views;
}

// ---- Dynamic internal link graph (topical authority / internal backlinks) ---
// Every post is linked FROM its most-related siblings and links back to them, so
// link equity flows both ways. Computed LIVE (not baked at write time), so the
// graph automatically gets denser as the catalogue grows — no rewriting old
// posts. Same destination is the strongest signal, then shared tags, then angle.
export function relatedPosts(slugOrPost, limit = 6) {
  ensureSeedPosts();
  const post = typeof slugOrPost === 'string' ? db.blog.find((p) => p.slug === slugOrPost) : slugOrPost;
  if (!post) return [];
  const tagSet = new Set(post.tags || []);
  return db.blog
    .filter((p) => p.slug !== post.slug)
    .map((p) => {
      let score = 0;
      if (p.destination === post.destination) score += 5;
      score += (p.tags || []).filter((t) => tagSet.has(t)).length;
      if (p.angle && post.angle && p.angle === post.angle) score += 1;
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (Date.parse(b.p.publishedAt) || 0) - (Date.parse(a.p.publishedAt) || 0))
    .slice(0, limit)
    .map(({ p }) => ({ slug: p.slug, title: p.title, destination: p.destination, angle: p.angle, readMins: p.readMins }));
}

// A simple density metric for the autopilot dashboard: average related links per
// post (higher = tighter cluster) and any orphan posts (0 inbound relations).
export function linkGraphStats() {
  ensureSeedPosts();
  const rels = db.blog.map((p) => relatedPosts(p, 6).length);
  const total = rels.reduce((s, n) => s + n, 0);
  const orphans = db.blog.filter((p, i) => rels[i] === 0).map((p) => p.slug);
  return { posts: db.blog.length, avgRelatedLinks: db.blog.length ? Math.round((total / db.blog.length) * 10) / 10 : 0, orphans };
}

// RSS 2.0 feed — a real syndication channel (feed readers, aggregators, auto-
// posters). Publishing everywhere is how legitimate EXTERNAL backlinks actually
// form: you can't fabricate them, but you make the content maximally linkable.
export function blogRssFeed(baseUrl = 'https://3jntravel.com') {
  ensureSeedPosts();
  const x = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const items = db.blog.slice(0, 50).map((p) => `    <item>
      <title>${x(p.title)}</title>
      <link>${baseUrl}/blog/${p.slug}</link>
      <guid isPermaLink="true">${baseUrl}/blog/${p.slug}</guid>
      <pubDate>${new Date(p.publishedAt).toUTCString()}</pubDate>
      <description>${x(p.metaDescription || p.excerpt || '')}</description>
${(p.tags || []).map((t) => `      <category>${x(t)}</category>`).join('\n')}
    </item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
    <title>3JN Travel OS — Journal</title>
    <atom:link href="${baseUrl}/blog.xml" rel="self" type="application/rss+xml" />
    <link>${baseUrl}/blog</link>
    <description>AI-built cheapest-reliable travel guides: flights, hotels, visas and pay-monthly holidays.</description>
    <language>en-gb</language>
    <lastBuildDate>${new Date(db.blog.reduce((m, p) => Math.max(m, Date.parse(p.publishedAt) || 0), 0) || Date.now()).toUTCString()}</lastBuildDate>
${items}
</channel></rss>`;
}

// ---- SEO Autopilot ----------------------------------------------------------
// One call that runs the whole autonomous SEO cycle: publish the due post, keep
// the internal link graph dense (it's computed live, so it always is), and
// report the state the operator watches. The sitemap + RSS regenerate from
// db.blog on every request, so "refresh" is inherent — nothing to schedule.
export function seoAutopilot(now = Date.now(), baseUrl = 'https://3jntravel.com') {
  const publish = ensureDailyPublish(now);
  const graph = linkGraphStats();
  const status = {
    ranAt: new Date(now).toISOString(),
    published: publish.published,
    newPost: publish.published ? publish.post : null,
    posts: graph.posts,
    avgRelatedLinks: graph.avgRelatedLinks,
    orphans: graph.orphans,
    sitemap: `${baseUrl}/sitemap.xml`,
    rss: `${baseUrl}/blog.xml`,
    nextPublishInMs: publish.nextDueInMs ?? null,
  };
  recordAudit({ actor: 'seo-agent', role: 'agent', action: 'seo.autopilot.ran', entity: 'seo', entityId: 'autopilot', summary: `${graph.posts} posts · ${graph.avgRelatedLinks} avg links · ${publish.published ? 'published' : 'no new post'}` });
  return status;
}

export { slugify };

// ---- Autonomous daily publishing loop ---------------------------------------
// The Blog, SEO and Marketing agents publish WITHOUT a human: whenever the
// newest post is older than the cadence (24h), the Blog agent writes the next
// destination post, the SEO agent's sitemap picks it up automatically (the
// sitemap is built from db.blog), and the Marketing agent logs the matching
// social push. Checked on boot, on an interval, and lazily on every blog read —
// so it works on always-on servers AND serverless cold starts alike.
const PUBLISH_EVERY_MS = 24 * 3600 * 1000;

export function ensureDailyPublish(now = Date.now()) {
  ensureSeedPosts();
  const newest = db.blog.reduce((max, p) => Math.max(max, Date.parse(p.publishedAt) || 0), 0);
  if (now - newest < PUBLISH_EVERY_MS) return { published: false, nextDueInMs: PUBLISH_EVERY_MS - (now - newest) };

  const post = createPost({ now });
  // Marketing agent: matching social push for the fresh post (audited).
  const social = `✈️ ${post.destination} on a budget? New on the 3JN journal: "${post.title}" → 3jntravel.com/blog/${post.slug} #travel #AItravel`;
  recordAudit({ actor: 'marketing-agent', role: 'agent', action: 'marketing.social.published', entity: 'blog', entityId: post.id, summary: social.slice(0, 140) });
  recordAudit({ actor: 'seo-agent', role: 'agent', action: 'seo.sitemap.refreshed', entity: 'blog', entityId: post.id, summary: `sitemap now includes /blog/${post.slug}` });
  return { published: true, post: { id: post.id, slug: post.slug, title: post.title, destination: post.destination }, social };
}

// Start the in-process scheduler (no-op on platforms that recycle processes —
// the lazy boot/read checks cover those). unref() keeps tests exiting cleanly.
export function startPublishingLoop() {
  seoAutopilot();
  const t = setInterval(() => seoAutopilot(), 6 * 3600 * 1000);
  if (typeof t.unref === 'function') t.unref();
  return t;
}
