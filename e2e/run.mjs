// 3JN Travel OS — real-browser E2E: drives the actual UI as ADMIN and as USER,
// screenshots every component, records pass/fail + console errors. Local only.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const CHROME = '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';
const BASE = 'http://127.0.0.1:3210';
const SHOTS = 'screenshots';
const ids = JSON.parse(fs.readFileSync('e2e/ids.json', 'utf8'));
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
let n = 0;
const pad = () => String(++n).padStart(2, '0');
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

async function newSession(uid, label) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1700 } });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(BASE) || u.startsWith('data:')) return route.continue();
    return route.abort();
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e).slice(0, 200)));
  await page.addInitScript((id) => { try { localStorage.setItem('3jn_uid', id); } catch {} }, uid);
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  page._errors = errors; page._label = label;
  return { ctx, page };
}
async function step(page, name, fn, { waitMs = 900, assertText = null } = {}) {
  const file = `${SHOTS}/${pad()}-${page._label}-${name.replace(/[^a-z0-9]+/gi, '-')}.png`;
  const before = page._errors.length;
  let ok = true, note = '';
  try {
    await fn();
    await page.waitForTimeout(waitMs);
    if (assertText) {
      // Case-insensitive, with a short retry so an async render isn't a false miss.
      let found = false;
      for (let i = 0; i < 6 && !found; i++) {
        found = await page.evaluate((t) => document.body.innerText.toLowerCase().includes(t.toLowerCase()), assertText);
        if (!found) await page.waitForTimeout(500);
      }
      if (!found) throw new Error(`expected text not found: "${assertText}"`);
    }
  } catch (e) { ok = false; note = String(e.message || e).slice(0, 160); }
  try { await page.screenshot({ path: file, fullPage: true }); } catch {}
  const newErrs = page._errors.slice(before);
  results.push({ label: page._label, name, ok, file, note, consoleErrors: newErrs });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${page._label}] ${name}${note ? ' — ' + note : ''}${newErrs.length ? ' — consoleErr:' + newErrs.length : ''}`);
}
const nav = (page, v) => page.evaluate((x) => window.nav(x), v);
const call = (page, f, ...a) => page.evaluate(({ f, a }) => window[f]?.(...a), { f, a });
const closeModal = (page) => page.evaluate(() => window.closeModal?.()).catch(() => {});

// ============================ ADMIN ============================
{
  const { page } = await newSession(ids.adminId, 'admin');
  await step(page, 'admin-console', () => nav(page, 'admin'), { waitMs: 1600, assertText: 'Control' });
  await step(page, 'launch-readiness', () => call(page, 'runSelfTest'), { waitMs: 2600 });
  await step(page, 'manage-user', () => call(page, 'manageUser'), { waitMs: 700, assertText: 'Manage user' });
  await closeModal(page);
  await step(page, 'client-money', () => call(page, 'openClientMoney'), { waitMs: 900, assertText: 'Client money' });
  await closeModal(page);
  await step(page, 'lock-exposure', () => call(page, 'openExposure'), { waitMs: 900 });
  await closeModal(page);
  await step(page, 'ops-queue', () => call(page, 'openOpsQueue'), { waitMs: 900 });
  await closeModal(page);
  await step(page, 'sponsored-placements', () => call(page, 'openPlacements'), { waitMs: 900 });
  await closeModal(page);
  await step(page, 'testimonials', () => call(page, 'openTestimonialModeration'), { waitMs: 900 });
  await closeModal(page);
  await step(page, 'deals-manager', () => call(page, 'openDealsManager'), { waitMs: 1000 });
  await closeModal(page);
  // Enable every module so the gated views render their real content.
  await step(page, 'enable-modules', async () => {
    for (const k of ['corporate', 'visaos', 'embassy', 'savewallet']) { await call(page, 'toggleModule', k, true); await page.waitForTimeout(250); }
  }, { waitMs: 600 });
  await closeModal(page);
  await step(page, 'business-centre', () => nav(page, 'business'), { waitMs: 1600, assertText: 'Approval' });
  await step(page, 'comms', () => nav(page, 'comms'), { waitMs: 1200 });
  await page.context().close();
}

// ============================ USER ============================
{
  const { page } = await newSession(ids.userId, 'user');
  await step(page, 'home', () => nav(page, 'home'), { waitMs: 900 });
  await step(page, 'how-it-works', () => nav(page, 'how'), { waitMs: 900 });
  await step(page, 'search', async () => {
    await nav(page, 'planner'); await page.waitForTimeout(400);
    await page.fill('#intentInput', 'London to Dubai for 2 adults, 7 nights in September, flights and hotel');
    await page.click('#planBtn');
  }, { waitMs: 3800, assertText: 'package options' });
  await step(page, 'fare-risk-chip', async () => {
    const has = await page.evaluate(() => document.body.innerText.includes('Fare risk'));
    if (!has) throw new Error('fare-risk chip missing');
  }, { waitMs: 200 });
  await step(page, 'booking-checkout', () => call(page, 'openBooking', 'Standard'), { waitMs: 1200 });
  await closeModal(page);
  await step(page, 'membership', () => nav(page, 'membership'), { waitMs: 1200 });
  await step(page, 'rewards', () => nav(page, 'rewards'), { waitMs: 1200 });
  await step(page, 'vendors', () => nav(page, 'vendors'), { waitMs: 1200 });
  await step(page, 'api-portal', () => nav(page, 'api'), { waitMs: 1200 });
  await step(page, 'blog', () => nav(page, 'blog'), { waitMs: 1200 });
  await step(page, 'marketplace', () => nav(page, 'marketplace'), { waitMs: 1200 });
  await step(page, 'visaos', () => nav(page, 'visaos'), { waitMs: 1400 });
  await step(page, 'host-dashboard', () => nav(page, 'hosting'), { waitMs: 1400 });
  await step(page, 'console', () => nav(page, 'console'), { waitMs: 1400 });
  await step(page, 'edit-profile', () => call(page, 'editProfile'), { waitMs: 900 });
  await closeModal(page);
  // Save & Search wallet (module now ON): create a pot, then attach a flight watch.
  await step(page, 'save-search-open', () => call(page, 'openSaveWallet'), { waitMs: 900, assertText: 'Save & Search' });
  await step(page, 'save-search-create-pot', async () => {
    await page.fill('#pot-name', 'Dubai 2027'); await page.fill('#pot-target', '3000');
    await call(page, 'potCreate');
  }, { waitMs: 1400 });
  await step(page, 'save-search-watch-form', async () => { const pid = await firstPotId(page); await call(page, 'potWatchForm', pid); }, { waitMs: 700 });
  await step(page, 'save-search-set-watch', async () => {
    await page.fill('#w-origin', 'London'); await page.fill('#w-dest', 'Dubai'); await page.fill('#w-depart', '2027-09-10');
    await page.evaluate(() => window.potSetWatch(window.__firstPot));
  }, { waitMs: 1600, assertText: 'watched from' });
  await page.context().close();
}
async function firstPotId(page) {
  const id = await page.evaluate(async () => {
    const r = await fetch('/api/pots', { headers: { 'x-user-id': localStorage.getItem('3jn_uid') } }).then((x) => x.json());
    const pid = r.pots?.[0]?.id; window.__firstPot = pid; return pid;
  });
  return id;
}

await browser.close();
fs.writeFileSync('e2e/results.json', JSON.stringify(results, null, 2));
const pass = results.filter((r) => r.ok).length;
console.log(`\n==== ${pass}/${results.length} steps passed ====`);
const fails = results.filter((r) => !r.ok || r.consoleErrors.length);
if (fails.length) { console.log('ATTENTION:'); for (const f of fails) console.log(` - [${f.label}] ${f.name}: ${f.ok ? 'ok+consoleErr' : 'FAIL ' + f.note}${f.consoleErrors.length ? ' :: ' + f.consoleErrors.join(' | ') : ''}`); }
process.exit(0);
