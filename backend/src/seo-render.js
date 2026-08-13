// Server-side SEO rendering — the "get found on Google" layer.
//
// The app is a client-side SPA: humans get the rich JS experience, but a search
// engine or social scraper that fetches the raw HTML would otherwise see an
// empty shell with the SAME <title> and meta on every URL — so nothing ranks
// and nothing gets indexed with its real content. This module renders REAL HTML
// (unique title, description, canonical, Open Graph, Twitter card, JSON-LD and
// the actual body text + internal links) for two audiences:
//
//   1. Crawlers / social scrapers hitting SPA routes (/, /blog, /blog/:slug) —
//      served the fully-rendered page so the content indexes and link previews
//      work. Humans on those routes still get the SPA.
//   2. Programmatic destination landing pages (/destinations, /destinations/:slug)
//      — real, data-grounded pages served to EVERYONE (crawler and human alike,
//      so it is dynamic rendering, not cloaking). Hundreds of genuinely useful,
//      interlinked, high-intent pages: "cheap flights & hotels to <city>, pay
//      monthly", grounded in the live destination catalogue.

import { listPosts, getPost } from './agents.js';
import { DESTINATIONS, synthesizeDestination } from './destinations.js';

// The programmatic-SEO destination set. Deliberately weighted toward the routes
// big OTAs under-serve — African, Caribbean, South-Asian and Middle-Eastern
// cities where the diaspora travel market is large and the organic competition
// is thin. That under-served long tail is 3JN's realistic organic wedge; the
// obvious hubs are here too. Every city is resolved through the live engine
// (real cost basis + visa rule), so each page is data-grounded, not filler.
const SEO_CITIES = [
  // Global hubs & Europe
  'Dubai', 'Istanbul', 'Barcelona', 'Rome', 'Lisbon', 'Paris', 'Amsterdam', 'Madrid', 'Athens', 'Faro',
  'Venice', 'Milan', 'Munich', 'Berlin', 'Vienna', 'Prague', 'Budapest', 'Dublin', 'Edinburgh', 'Malaga',
  'Nice', 'Geneva', 'Zurich', 'Copenhagen', 'Reykjavik', 'Krakow', 'Palma', 'Tenerife',
  // Africa & the diaspora routes (the wedge)
  'Kinshasa', 'Lagos', 'Abuja', 'Accra', 'Nairobi', 'Mombasa', 'Johannesburg', 'Cape Town', 'Cairo',
  'Casablanca', 'Marrakech', 'Dakar', 'Addis Ababa', 'Kigali', 'Dar es Salaam', 'Zanzibar', 'Luanda',
  'Douala', 'Yaounde', 'Abidjan', 'Freetown', 'Banjul', 'Harare', 'Lusaka', 'Kampala', 'Bamako',
  'Conakry', 'Lome', 'Cotonou', 'Libreville', 'Brazzaville', 'Windhoek', 'Maputo', 'Tunis', 'Algiers',
  // Middle East
  'Doha', 'Abu Dhabi', 'Riyadh', 'Jeddah', 'Amman', 'Beirut', 'Muscat', 'Kuwait City',
  // South & Southeast Asia
  'Delhi', 'Mumbai', 'Bengaluru', 'Chennai', 'Hyderabad', 'Kochi', 'Ahmedabad', 'Colombo', 'Kathmandu',
  'Dhaka', 'Karachi', 'Lahore', 'Islamabad', 'Bangkok', 'Phuket', 'Bali', 'Jakarta', 'Kuala Lumpur',
  'Singapore', 'Manila', 'Cebu', 'Hanoi', 'Ho Chi Minh City', 'Male',
  // East Asia
  'Tokyo', 'Osaka', 'Seoul', 'Hong Kong', 'Shanghai', 'Beijing',
  // Americas & Caribbean
  'New York', 'Miami', 'Orlando', 'Los Angeles', 'Toronto', 'Boston', 'Washington', 'Atlanta',
  'Cancun', 'Kingston', 'Montego Bay', 'Bridgetown', 'Port of Spain', 'Nassau', 'Punta Cana',
  'Havana', 'Rio de Janeiro', 'Sao Paulo', 'Buenos Aires', 'Lima', 'Bogota',
];

const BRAND = '3JN Travel OS';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ---- Crawler detection ----------------------------------------------------
// Search engines + the social scrapers that build link previews (they need the
// OG tags). Kept broad on purpose — serving good HTML to a non-crawler is
// harmless; missing a crawler is a lost indexing opportunity.
const CRAWLER_UA = /(googlebot|bingbot|slurp|duckduckbot|baiduspider|yandex|sogou|exabot|facebot|facebookexternalhit|twitterbot|linkedinbot|whatsapp|slackbot|telegrambot|discordbot|pinterest|redditbot|applebot|petalbot|bytespider|ia_archiver|semrushbot|ahrefsbot|mj12bot|screaming frog|google-inspectiontool|chrome-lighthouse)/i;
export function isCrawler(req) {
  const ua = String(req?.headers?.['user-agent'] || '');
  return CRAWLER_UA.test(ua);
}

// ---- Helpers --------------------------------------------------------------
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function slugifyCity(name) {
  return String(name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function indicativeFromGbp(d) {
  const f = Number(d?.flightBaseUSD) || 0;
  const h = Number(d?.hotelNightBaseUSD) || 0;
  if (!f && !h) return null;
  return Math.round((f + h * 5) * 0.79 / 10) * 10; // flight + ~5 nights, USD→GBP, rounded
}
function bestMonths(d) {
  const m = Array.isArray(d?.months) && d.months.length ? d.months : null;
  if (!m) return [];
  return m.map((n) => MONTHS[n - 1]).filter(Boolean).slice(0, 3);
}

// Slug ↔ destination index. Built once from the curated SEO city list, each
// resolved through the live engine (catalogue entry where one exists, otherwise
// synthesised) so every landing page has a real cost basis + visa rule.
let _slugIndex = null;
function slugIndex() {
  if (_slugIndex) return _slugIndex;
  _slugIndex = new Map();
  // Curated catalogue cities first (richer data incl. best months).
  for (const [code, d] of Object.entries(DESTINATIONS)) {
    if (d?.city) _slugIndex.set(slugifyCity(d.city), { code, ...d });
  }
  // Then the wider SEO city set, synthesised when off-catalogue.
  for (const name of SEO_CITIES) {
    const slug = slugifyCity(name);
    if (_slugIndex.has(slug)) continue;
    try {
      const d = synthesizeDestination(name);
      if (d?.city && d?.visa) _slugIndex.set(slugifyCity(d.city), d);
    } catch { /* skip anything the engine can't resolve */ }
  }
  return _slugIndex;
}
export function destinationSlugs() { return [...slugIndex().keys()]; }
export function destinationBySlug(slug) { return slugIndex().get(String(slug || '').toLowerCase()) || null; }

// ---- The HTML shell -------------------------------------------------------
// A complete, self-contained, fast, theme-neutral document. Real content in the
// raw HTML (no JS needed to see it), correct head tags, and a clear CTA that
// deep-links into the SPA planner with the search pre-filled.
function shell({ title, description, canonical, base, jsonLd = [], bodyHtml, ogType = 'website', image }) {
  const img = image || `${base}/logo.png`;
  const ld = (Array.isArray(jsonLd) ? jsonLd : [jsonLd]).filter(Boolean)
    .map((o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta property="og:type" content="${esc(ogType)}">
<meta property="og:site_name" content="${esc(BRAND)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(img)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(img)}">
<link rel="icon" href="/favicon.png">
${ld}
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#0b1220;background:#fff}
@media(prefers-color-scheme:dark){body{color:#e7ecf3;background:#0b1020}}
a{color:#1668e3}
@media(prefers-color-scheme:dark){a{color:#7db4ff}}
header,footer{padding:16px 20px;border-color:rgba(128,128,128,.18)}
header{border-bottom:1px solid rgba(128,128,128,.18);display:flex;align-items:center;gap:12px;flex-wrap:wrap}
footer{border-top:1px solid rgba(128,128,128,.18);font-size:14px;margin-top:40px}
.brand{font-weight:800;letter-spacing:.2px;text-decoration:none;color:inherit}
nav a{margin-right:14px;font-size:14px}
main{max-width:760px;margin:0 auto;padding:28px 20px}
h1{font-size:30px;line-height:1.2;margin:.2em 0 .4em}
h2{font-size:22px;margin:1.4em 0 .4em}
.lede{font-size:18px;opacity:.9}
.cta{display:inline-block;margin:18px 0;padding:13px 22px;background:#1668e3;color:#fff;border-radius:10px;text-decoration:none;font-weight:700}
.facts{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0;padding:0;list-style:none}
.facts li{padding:10px 14px;border:1px solid rgba(128,128,128,.22);border-radius:10px;font-size:14px}
.muted{opacity:.7;font-size:13px}
.links a{display:inline-block;margin:0 12px 8px 0}
article :is(h2,h3){margin-top:1.4em}
</style>
</head>
<body>
<header>
<a class="brand" href="/">✈ ${esc(BRAND)}</a>
<nav>
<a href="/">Plan a trip</a>
<a href="/destinations">Destinations</a>
<a href="/blog">Guides</a>
<a href="/visaos">Visa check</a>
<a href="/membership">Pay monthly</a>
</nav>
</header>
<main>
${bodyHtml}
</main>
<footer>
<p><strong>${esc(BRAND)}</strong> — AI builds your cheapest reliable trip: flights, hotels, visa, transfers &amp; eSIM, with pay-monthly instalments.</p>
<p class="links">
<a href="/">AI trip planner</a>
<a href="/destinations">All destinations</a>
<a href="/blog">Travel guides</a>
<a href="/visaos">Visa approval check</a>
<a href="/membership">Membership</a>
<a href="/how-it-works">How it works</a>
</p>
<p class="muted">© ${esc(BRAND)}. Prices are indicative and refreshed live at search time.</p>
</footer>
</body>
</html>`;
}

// Email-capture block — the top-of-funnel hook on every landing page. A visitor
// who isn't ready to buy leaves an email for a cheapest-date alert. Includes a
// honeypot ("company" — hidden from humans, catnip to bots) and posts JSON to
// /api/leads/subscribe with the destination pre-filled. Progressive enhancement:
// it's a real <form> that still submits without JS.
function emailCapture(destination, source) {
  const d = destination ? esc(destination) : '';
  const label = destination ? `Get cheapest-date alerts for ${d}` : 'Get cheapest-date fare alerts';
  return `
<section style="margin:26px 0;padding:18px 20px;border:1px solid rgba(22,104,227,.35);border-radius:12px;background:rgba(22,104,227,.06)">
<h2 style="margin:.1em 0 .3em;font-size:19px">✉ ${label}</h2>
<p class="muted" style="margin:.2em 0 .8em">Not ready to book? We'll watch the fares and email you the moment ${destination ? `${d}` : 'your route'} gets cheaper. No spam, one-click unsubscribe.</p>
<form id="lead-form" onsubmit="return jnLead(event)" style="display:flex;gap:8px;flex-wrap:wrap">
<input type="email" name="email" required placeholder="you@email.com" aria-label="Email address" style="flex:1 1 220px;min-width:0;padding:11px 13px;border:1px solid rgba(128,128,128,.35);border-radius:9px;font-size:15px">
<input type="text" name="company" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0">
<input type="hidden" name="destination" value="${d}">
<input type="hidden" name="source" value="${esc(source || 'landing')}">
<button type="submit" style="padding:11px 20px;background:#1668e3;color:#fff;border:0;border-radius:9px;font-weight:700;font-size:15px;cursor:pointer">Alert me</button>
</form>
<p id="lead-msg" style="margin:.7em 0 0;font-size:14px;color:#46a05a;display:none">✓ You're on the list — check your inbox.</p>
<script>
function jnLead(e){e.preventDefault();var f=e.target;var b={email:f.email.value,destination:f.destination.value,source:f.source.value,company:f.company.value};
fetch('/api/leads/subscribe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(function(r){return r.json()}).then(function(){var m=document.getElementById('lead-msg');m.style.display='block';f.style.display='none'}).catch(function(){});return false}
</script>
</section>`;
}

// ---- Trust surface --------------------------------------------------------
// HONEST trust signals only. Every claim here is something 3JN genuinely does:
// the price-lock, the savings guarantee, Stripe-secured payments, transparent
// pay-monthly, one-trip management. The regulated financial-protection badge
// (ATOL / TTA / trust account) appears ONLY when a real scheme is configured in
// the environment — never claim cover you don't hold.
function moneyProtectionBadge() {
  const scheme = String(process.env.MONEY_PROTECTION_SCHEME || '').trim();
  if (!scheme) return null;
  const number = String(process.env.MONEY_PROTECTION_NUMBER || '').trim();
  return `🛡 ${esc(scheme)}${number ? ` ${esc(number)}` : ''} protected`;
}
const TRUST_SIGNALS = [
  { icon: '🔒', title: 'Your price is locked', body: 'Book and your total is fixed — no fare hikes or currency surcharges before you travel.' },
  { icon: '💳', title: 'Secure payments', body: 'Card payments are processed by Stripe. 3JN never stores your card details.' },
  { icon: '📅', title: 'Pay monthly, transparently', body: 'Spread the cost over weeks or months. The AI buys your ticket the moment the fare is covered and holds it for you.' },
  { icon: '✅', title: 'Savings guarantee', body: 'If we can\'t beat or match your current quote, your search credits are refunded.' },
];
function trustBlock({ compact = false } = {}) {
  const badge = moneyProtectionBadge();
  const items = TRUST_SIGNALS.map((s) => `<li style="padding:12px 14px;border:1px solid rgba(128,128,128,.2);border-radius:10px"><strong>${s.icon} ${esc(s.title)}</strong><br><span class="muted">${esc(s.body)}</span></li>`).join('');
  return `
<section style="margin:26px 0">
<h2 style="font-size:${compact ? '19' : '22'}px;margin:.2em 0 .5em">Why you can trust 3JN</h2>
${badge ? `<p style="display:inline-block;padding:6px 12px;border-radius:8px;background:rgba(70,160,90,.14);border:1px solid rgba(70,160,90,.4);font-weight:700;font-size:14px">${badge}</p>` : ''}
<ul style="list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin:.6em 0">${items}</ul>
${compact ? '<p><a href="/why-3jn">More on how 3JN protects you →</a></p>' : ''}
</section>`;
}
// Referral activation — surfaces the (already-built) reward: a friend's first
// paid trip earns the referrer real credit. Anonymous SSR visitors are pointed
// to sign up (where their personal referral code lives).
function referralBlock() {
  return `
<section style="margin:26px 0;padding:18px 20px;border:1px solid rgba(216,180,106,.4);border-radius:12px;background:rgba(216,180,106,.07)">
<h2 style="margin:.1em 0 .3em;font-size:19px">👥 Refer a friend — you both win</h2>
<p class="muted" style="margin:.2em 0 .8em">Share 3JN with friends and family. When someone you refer takes their first trip, <strong>you earn reward credit</strong> toward your own travel — and they get the cheapest reliable package too.</p>
<a class="cta" href="/?open=signup" style="margin:4px 0">Create an account &amp; get your referral link →</a>
</section>`;
}

const org = (base) => ({
  '@context': 'https://schema.org', '@type': 'Organization', name: BRAND, url: base + '/',
  logo: base + '/logo.png',
  sameAs: [], description: 'AI travel platform: cheapest reliable flights, hotels, visas, eSIM and transfers with pay-monthly instalments.',
});

// ---- Page renderers -------------------------------------------------------

export function renderHome(base) {
  const featured = destinationSlugs().slice(0, 12).map((s) => destinationBySlug(s)).filter(Boolean);
  const cards = featured.map((d) => `<a href="/destinations/${slugifyCity(d.city)}">${esc(d.city)}</a>`).join(' · ');
  const body = `
<h1>Stop searching. Start saving.</h1>
<p class="lede">Describe your trip in one sentence. 3JN's AI finds, negotiates and books the cheapest reliable package — flights, hotels, visa, transfers and eSIM — and lets you pay monthly.</p>
<a class="cta" href="/?open=planner">Plan my trip →</a>
<h2>What 3JN does</h2>
<ul>
<li><strong>Cheapest reliable flights &amp; hotels</strong> from multiple suppliers, compared in seconds.</li>
<li><strong>Pay monthly</strong> — spread the cost over weeks or months, with the AI tracking the fare and buying the moment it drops.</li>
<li><strong>AI VisaOS</strong> — an instant read on your visa approval odds before you book anything.</li>
<li><strong>One trip, fully managed</strong> — flights, hotel, transfers, eSIM and visa in a single plan.</li>
</ul>
<h2>Popular destinations</h2>
<p class="links">${cards}</p>
<p><a href="/destinations">Browse all destinations →</a> · <a href="/blog">Read the travel guides →</a></p>`;
  return shell({
    title: `${BRAND} — cheap flights & hotels, pay monthly, AI visa check`,
    description: 'Describe your trip once — 3JN\'s AI books the cheapest reliable flights, hotels, visa, transfers and eSIM, with pay-monthly instalments and an instant visa approval check.',
    canonical: base + '/', base, ogType: 'website', jsonLd: [org(base), {
      '@context': 'https://schema.org', '@type': 'WebSite', name: BRAND, url: base + '/',
      potentialAction: { '@type': 'SearchAction', target: base + '/?q={search_term_string}', 'query-input': 'required name=search_term_string' },
    }], bodyHtml: body,
  });
}

export function renderBlogIndex(base) {
  const posts = listPosts();
  const items = posts.map((p) => `<li><a href="/blog/${esc(p.slug)}">${esc(p.title)}</a><br><span class="muted">${esc(p.excerpt || '')}</span></li>`).join('\n');
  const body = `
<h1>3JN Travel Guides</h1>
<p class="lede">Honest, data-grounded guides to flying, staying and getting a visa for less — written by our AI travel editor and refreshed continuously.</p>
<ul>${items}</ul>`;
  return shell({
    title: `Travel guides — cheaper flights, hotels & visas | ${BRAND}`,
    description: 'Data-grounded travel guides: the cheapest months to fly, real visa rules, honest holiday cost breakdowns, and how to pay monthly.',
    canonical: base + '/blog', base, ogType: 'website',
    jsonLd: { '@context': 'https://schema.org', '@type': 'Blog', name: `${BRAND} Travel Guides`, url: base + '/blog' },
    bodyHtml: body,
  });
}

export function renderBlogPost(slug, base) {
  const p = getPost(slug);
  if (!p) return null;
  const url = `${base}/blog/${p.slug}`;
  const faqLd = Array.isArray(p.faq) && p.faq.length ? {
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: p.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  } : null;
  const articleLd = {
    '@context': 'https://schema.org', '@type': 'Article', headline: p.title,
    description: p.metaDescription || p.excerpt || '', datePublished: p.publishedAt, dateModified: p.publishedAt,
    author: { '@type': 'Organization', name: p.author || BRAND }, publisher: org(base),
    mainEntityOfPage: url, url,
  };
  const faqHtml = Array.isArray(p.faq) && p.faq.length
    ? `<h2>FAQ</h2>${p.faq.map((f) => `<h3>${esc(f.q)}</h3><p>${esc(f.a)}</p>`).join('')}`
    : '';
  const cta = p.cta?.href ? `<a class="cta" href="${esc(p.cta.href)}">${esc(p.cta.label || 'Plan this trip →')}</a>` : `<a class="cta" href="/?open=planner">Plan this trip →</a>`;
  const body = `
<article>
<p class="muted"><a href="/blog">← Travel guides</a></p>
<h1>${esc(p.title)}</h1>
<p class="lede">${esc(p.excerpt || '')}</p>
${cta}
${p.body || ''}
${faqHtml}
</article>`;
  return shell({
    title: `${p.title} | ${BRAND}`,
    description: p.metaDescription || p.excerpt || p.title,
    canonical: url, base, ogType: 'article', jsonLd: [articleLd, faqLd].filter(Boolean), bodyHtml: body,
  });
}

// Programmatic destination landing page — served to everyone. Data-grounded in
// the live catalogue: best months, indicative from-price, and the real visa
// rule for the biggest source markets, with a planner CTA + dense internal links.
export function renderDestinationPage(slug, base) {
  const d = destinationBySlug(slug);
  if (!d) return null;
  const city = d.city;
  const country = d.countryName || d.country || '';
  // Some country display names disambiguate with the city ("Congo - Kinshasa").
  // Drop the country label where it just repeats the city, so titles read clean.
  const countryLabel = (country && !new RegExp(`(^|[\\s-])${city}([\\s-]|$)`, 'i').test(country)) ? country : '';
  const url = `${base}/destinations/${slugifyCity(city)}`;
  const fromGbp = indicativeFromGbp(d);
  const months = bestMonths(d);
  const gb = d.visa ? (d.visa.GB || d.visa.DEFAULT) : null;
  const facts = [
    fromGbp ? `<li><strong>From ~£${fromGbp}pp</strong><br><span class="muted">flights + ~5 nights, indicative</span></li>` : '',
    months.length ? `<li><strong>Cheapest months</strong><br><span class="muted">${esc(months.join(', '))}</span></li>` : '',
    gb ? `<li><strong>UK passport visa</strong><br><span class="muted">${esc(gb.required ? (gb.type || 'required') : 'not required')}</span></li>` : '',
    `<li><strong>Pay monthly</strong><br><span class="muted">spread over weeks or months</span></li>`,
  ].filter(Boolean).join('');
  const q = encodeURIComponent(`flights and hotel to ${city}`);
  const related = destinationSlugs().filter((s) => s !== slug).slice(0, 8)
    .map((s) => destinationBySlug(s)).filter(Boolean)
    .map((r) => `<a href="/destinations/${slugifyCity(r.city)}">${esc(r.city)}</a>`).join(' · ');
  const visaSentence = gb
    ? (gb.required
      ? `UK passport holders need a visa for ${esc(country || city)} (${esc(gb.type || 'tourist visa')}). 3JN's VisaOS gives you an instant read on your approval odds before you commit.`
      : `Good news for UK passport holders: ${esc(country || city)} does not require a visa in advance (${esc(gb.type || 'visa-free / on arrival')}).`)
    : `Check your visa requirement for ${esc(country || city)} with 3JN's VisaOS before you book.`;
  const faq = [
    { q: `How much does a trip to ${city} cost?`, a: fromGbp ? `Indicatively from about £${fromGbp} per person for flights plus around five nights — 3JN refreshes real prices live at search time and can spread it over monthly instalments.` : `3JN prices your ${city} trip live from multiple suppliers and can spread the cost over monthly instalments.` },
    { q: `When is the cheapest time to fly to ${city}?`, a: months.length ? `${months.join(', ')} tend to be the cheaper shoulder months for ${city}. Tell 3JN "cheapest dates" and the AI scans a whole window for the lowest fare.` : `Ask 3JN for "the cheapest dates to ${city}" and the AI scans a window of dates for the lowest fare.` },
    { q: `Do I need a visa to visit ${city}?`, a: gb ? (gb.required ? `UK passport holders need a ${gb.type || 'tourist visa'} for ${country || city}. VisaOS estimates your approval odds instantly.` : `UK passport holders do not need a visa in advance for ${country || city} (${gb.type || 'visa-free / on arrival'}).`) : `Use 3JN VisaOS to check the current visa rule for ${country || city}.` },
    { q: `Can I pay for a ${city} holiday monthly?`, a: `Yes — 3JN lets you spread the cost over weeks or months. The AI tracks your fare and buys the ticket the moment the price is covered, then holds it in your account.` },
  ];
  const faqLd = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) };
  const body = `
<p class="muted"><a href="/destinations">← All destinations</a></p>
<h1>Cheap flights &amp; hotels to ${esc(city)}${countryLabel ? `, ${esc(countryLabel)}` : ''} — pay monthly</h1>
<p class="lede">Describe your ${esc(city)} trip in one sentence and 3JN's AI builds the cheapest reliable package — flights, hotel, transfers, visa and eSIM — with the option to pay over time.</p>
<a class="cta" href="/?open=planner&amp;q=${q}">Find my ${esc(city)} trip →</a>
<ul class="facts">${facts}</ul>
${emailCapture(city, `dest:${slugifyCity(city)}`)}
<h2>Visa for ${esc(city)}</h2>
<p>${visaSentence}</p>
<h2>How to get ${esc(city)} for less</h2>
<ul>
<li><strong>Let the AI pick your dates.</strong> Ask for "the cheapest dates to ${esc(city)}" and it scans a whole window instead of one guess.</li>
<li><strong>Bundle flight + hotel.</strong> 3JN compares suppliers together, where the real savings hide.</li>
<li><strong>Pay monthly.</strong> Spread the cost; the AI buys your ticket the moment the fare is covered and holds it for you.</li>
</ul>
<h2>${esc(city)} travel FAQ</h2>
${faq.map((f) => `<h3>${esc(f.q)}</h3><p>${esc(f.a)}</p>`).join('')}
${trustBlock({ compact: true })}
${referralBlock()}
<h2>Explore more destinations</h2>
<p class="links">${related}</p>
<p><a href="/blog">Read our travel guides →</a> · <a href="/visaos">Check your visa odds →</a></p>`;
  return shell({
    title: `Cheap flights & hotels to ${city}${countryLabel ? `, ${countryLabel}` : ''} — pay monthly | ${BRAND}`,
    description: `Book ${city} flights and hotels the smart way: 3JN's AI finds the cheapest reliable package${fromGbp ? ` from ~£${fromGbp}pp` : ''}, checks your visa, and lets you pay monthly.`,
    canonical: url, base, ogType: 'website', jsonLd: [org(base), faqLd], bodyHtml: body,
  });
}

export function renderDestinationIndex(base) {
  const all = destinationSlugs().map((s) => destinationBySlug(s)).filter(Boolean)
    .sort((a, b) => String(a.city).localeCompare(String(b.city)));
  const items = all.map((d) => `<li><a href="/destinations/${slugifyCity(d.city)}">${esc(d.city)}${d.countryName ? `, ${esc(d.countryName)}` : ''}</a></li>`).join('\n');
  const body = `
<h1>Destinations — cheap flights &amp; hotels, pay monthly</h1>
<p class="lede">Pick a destination and let 3JN's AI build the cheapest reliable package — flights, hotel, visa, transfers and eSIM — with pay-monthly instalments.</p>
<ul style="columns:2;-webkit-columns:2;gap:24px">${items}</ul>`;
  return shell({
    title: `All destinations — cheap flights & hotels, pay monthly | ${BRAND}`,
    description: 'Browse destinations and let 3JN\'s AI build the cheapest reliable flight + hotel + visa package, payable monthly.',
    canonical: base + '/destinations', base, ogType: 'website',
    jsonLd: org(base), bodyHtml: body,
  });
}

// "Why trust a new brand?" — the trust page. Honest, founder-voiced, and built
// entirely from real guarantees (no fabricated badges). Served to everyone.
export function renderWhy(base) {
  const badge = moneyProtectionBadge();
  const body = `
<h1>Why trust 3JN with your trip?</h1>
<p class="lede">A fair question — we're a new name. Here's exactly how your money and your trip are protected, in plain English.</p>
${badge ? `<p style="display:inline-block;padding:8px 14px;border-radius:8px;background:rgba(70,160,90,.14);border:1px solid rgba(70,160,90,.4);font-weight:700">${badge}</p>` : ''}
${trustBlock({ compact: false })}
<h2>How pay-monthly actually works</h2>
<p>You put down a deposit and spread the rest over weeks or months. Your price is locked the day you book. Our AI keeps watching your fare, and the moment your payments cover the ticket, it buys it and holds it safely in your account — released to you as soon as your balance reaches zero. No interest, no surprises.</p>
<h2>What happens if something goes wrong</h2>
<p>Your total is fixed at booking — no fare increases, no currency surcharges. Card payments run through Stripe, so 3JN never touches your card number. If our savings guarantee isn't met, your search credits come back to you.${badge ? ' Your package is financially protected under the scheme shown above.' : ''}</p>
<h2>Real reviews, not paid ones</h2>
<p>After every trip we invite you — through Trustpilot's verified system — to leave an honest review. We'd rather earn a real reputation slowly than fake one.</p>
${referralBlock()}
<p style="margin-top:24px"><a class="cta" href="/?open=planner">Plan my trip →</a></p>`;
  return shell({
    title: `Why trust 3JN Travel OS — price lock, secure payments, pay monthly`,
    description: 'How 3JN protects your money and your trip: locked prices, Stripe-secured payments, transparent pay-monthly, a savings guarantee and verified reviews.',
    canonical: base + '/why-3jn', base, ogType: 'website', jsonLd: org(base), bodyHtml: body,
  });
}
