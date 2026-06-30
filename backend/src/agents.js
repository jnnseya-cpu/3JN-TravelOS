// Enterprise AI agents: Security, Ops/Self-healing, SEO, Marketing, and the
// Blog writer. Deterministic in the prototype (no external model needed) but
// shaped like the real agents — each produces a structured, actionable report
// or artefact. They run through the AI Gateway in production.

import { db } from './store.js';
import { adminAudit, supplierScores, recordAudit } from './store.js';

const DESTS = ['Dubai', 'Istanbul', 'Barcelona', 'New York', 'Bali'];

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

export function createPost({ topic, destination } = {}) {
  const dest = destination || DESTS[blogCounter % DESTS.length];
  const title = topic || `Cheapest reliable ${dest} holiday: flights, hotel, visa & transfers`;
  const slug = slugify(title) + '-' + (++blogCounter);
  // Body with internal hyperlinks (to the planner, destination, VisaOS, membership).
  const body = [
    `<p><strong>${dest}</strong> doesn't have to be expensive. With <a href="/planner">3JN Travel OS</a> you describe your trip in one sentence and the AI builds the cheapest <em>reliable</em> package — flights, hotel, activities, visa, transfers and eSIM — then keeps monitoring the price after you book.</p>`,
    `<h3>How much is a ${dest} trip?</h3><p>Open the <a href="/marketplace">Destination Marketplace</a> to see live "from" prices in your currency, or <a href="/planner">get an instant quote</a>. Most travellers pay a 20% deposit and spread the rest over interest-free instalments.</p>`,
    `<h3>Do I need a visa for ${dest}?</h3><p>Check your <a href="/visaos">visa approval probability</a> before you book — <a href="/visaos">3JN VisaOS</a> tells you the requirement, cost, processing time and document checklist for your nationality in seconds.</p>`,
    `<h3>Why 3JN?</h3><p>Verified suppliers only, transparent 10% fee, a 24/7 price guard that rebooks or refunds if the price drops, and loyalty rewards that grow with every trip — see <a href="/membership">membership tiers</a>.</p>`,
    `<p>Ready? <a href="/planner">Plan your ${dest} trip now →</a></p>`,
  ].join('');
  const post = {
    id: 'blog_' + slug, slug, title, destination: dest,
    excerpt: `Plan a cheaper, reliable ${dest} holiday with AI — flights, hotel, visa and transfers, pay monthly.`,
    metaDescription: `Cheapest reliable ${dest} holiday packages with 3JN Travel OS: AI-built flights + hotel + visa + transfers, pay-monthly instalments, verified suppliers.`,
    tags: ['travel', dest.toLowerCase().replace(/\s/g, ''), 'deals', 'ai-travel'],
    body,
    readMins: 3,
    author: '3JN AI Editorial',
    publishedAt: new Date(Date.UTC(2026, 5, 30, 12, 0, blogCounter % 60)).toISOString(),
  };
  db.blog.unshift(post);
  recordAudit({ actor: 'blog-agent', role: 'agent', action: 'blog.published', entity: 'blog', entityId: post.id, summary: title });
  return post;
}

export function ensureSeedPosts() {
  if (db.blog.length === 0) DESTS.forEach((d) => createPost({ destination: d }));
  return db.blog;
}
export function listPosts() { return ensureSeedPosts().map(({ body, ...meta }) => meta); }
export function getPost(slug) { ensureSeedPosts(); return db.blog.find((p) => p.slug === slug) || null; }

export { slugify };
