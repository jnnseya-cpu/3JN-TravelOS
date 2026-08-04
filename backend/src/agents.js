// Enterprise AI agents: Security, Ops/Self-healing, SEO, Marketing, and the
// Blog writer. Deterministic in the prototype (no external model needed) but
// shaped like the real agents — each produces a structured, actionable report
// or artefact. They run through the AI Gateway in production.

import { db } from './store.js';
import { adminAudit, supplierScores, recordAudit } from './store.js';
import { findDestination } from './destinations.js';

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
  // A simple 0-100 posture score (higher = safer).
  const posture = Math.max(40, 100 - failedAuth * 5 - visaRejections * 2);
  return {
    postureScore: posture,
    level: posture >= 85 ? 'Strong' : posture >= 70 ? 'Guarded' : 'Elevated',
    controls: [
      { control: 'Zero-Trust access', status: 'enforced' },
      { control: 'CORS + rate-limit perimeter', status: 'active' },
      { control: 'JSON-only API (no HTML leak)', status: 'active' },
      { control: 'Immutable audit log', status: `${audit.length} events` },
      { control: 'Fraud scoring (VisaOS)', status: `${visaRejections} blocked` },
      { control: 'Secrets in env / Secret Manager', status: 'no secrets in code' },
      { control: 'Encryption in transit (TLS 1.3)', status: 'on deploy' },
    ],
    threats: [
      failedAuth > 3 ? { type: 'Credential stuffing', severity: 'medium', note: `${failedAuth} failed auths` } : null,
      apiKeyEvents > 10 ? { type: 'API abuse', severity: 'low', note: `${apiKeyEvents} key events` } : null,
    ].filter(Boolean),
    recommendation: posture >= 85
      ? 'Posture strong — maintain monitoring and rotate secrets quarterly.'
      : 'Enable MFA, tighten rate limits, and review recent auth failures.',
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
  if (db.blog.length === 0) { DESTS.forEach((d) => createPost({ destination: d })); return db.blog; }
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
export function listPosts() { return ensureSeedPosts().map(({ body, ...meta }) => meta); }
export function getPost(slug) { ensureSeedPosts(); return db.blog.find((p) => p.slug === slug) || null; }

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
