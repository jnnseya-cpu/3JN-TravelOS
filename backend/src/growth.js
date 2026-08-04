// AI Growth Engine — the 10 creator tools behind Rewards → Become a creator.
// Deterministic, dependency-free generators (the same "AI Gateway with local
// fallback" pattern as the blog/SEO agents), each PERSONALISED with the
// creator's own referral link so every asset drives THEIR referrals. Given the
// same inputs they're reproducible; pass a `variant` to get alternatives.

const PLATFORMS = ['instagram', 'tiktok', 'facebook', 'x', 'youtube', 'whatsapp', 'linkedin'];
function normPlatform(p) { const s = String(p || '').toLowerCase(); return PLATFORMS.includes(s) ? s : 'instagram'; }
function normDest(d) { return String(d || 'your next destination').trim().slice(0, 60) || 'your next destination'; }
function seedOf(s) { return Math.abs([...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0)); }
function pick(arr, seed) { return arr[seed % arr.length]; }
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

// Tone presets shape voice across the text generators.
const TONES = {
  friendly: { open: 'Real talk', vibe: 'no stress, just savings' },
  luxury: { open: 'Quietly, effortlessly', vibe: 'first-class feeling, sensible price' },
  urgent: { open: "Don't sleep on this", vibe: 'prices move fast' },
  inspiring: { open: 'Imagine this', vibe: 'the trip you keep putting off' },
};
function tone(t) { return TONES[String(t || '').toLowerCase()] || TONES.friendly; }

// ---- 1. Social media post --------------------------------------------------
export function socialPost({ destination, platform, tone: t, variant = 0 } = {}, ctx = {}) {
  const dest = normDest(destination); const pf = normPlatform(platform); const tn = tone(t);
  const link = ctx.referralLink || 'https://3jntravel.com';
  const seed = seedOf(dest + pf + variant);
  const hooks = [
    `${tn.open} — I built a full ${dest} trip (flights + hotel + transfers) for less than I expected. 👀`,
    `POV: you let AI plan ${dest} and it comes back cheaper than every tab you had open. ✈️`,
    `Everyone's overpaying for ${dest}. I found the reliable-cheapest way — ${tn.vibe}.`,
    `${dest} on a budget isn't a myth. Here's exactly how I booked it. 🧵`,
  ];
  const bodies = [
    `One sentence in, 3JN Travel OS builds the whole thing — flights, hotel, visa check, even eSIM — at the lowest *reliable* price, and you can pay monthly.`,
    `No more 12 browser tabs. The AI finds it, prices it against the live market, and books it. Split it into interest-free instalments if you want.`,
  ];
  const cta = `Plan yours free → ${link}`;
  const tags = hashtags({ destination: dest, platform: pf }, ctx).list.slice(0, pf === 'x' ? 3 : 8).join(' ');
  const body = `${pick(hooks, seed)}\n\n${pick(bodies, seed >> 1)}\n\n${cta}\n\n${tags}`;
  return { tool: 'social_post', platform: pf, title: `${cap(pf)} post — ${dest}`, output: body, copyText: body };
}

// ---- 2. Travel advert (paid ad copy) ---------------------------------------
export function travelAdvert({ destination, tone: t, variant = 0 } = {}, ctx = {}) {
  const dest = normDest(destination); const tn = tone(t); const seed = seedOf(dest + variant);
  const link = ctx.referralLink || 'https://3jntravel.com';
  const headline = pick([
    `${dest} for less — built by AI, paid monthly`,
    `Stop searching. Start saving on ${dest}.`,
    `Your ${dest} trip, at the reliable-cheapest price`,
  ], seed);
  const primary = `${tn.open}: describe your ${dest} trip in one sentence and 3JN Travel OS builds it — flights, hotel, transfers, visa & eSIM — at the lowest reliable price, with interest-free instalments and a 24/7 price guard.`;
  const description = `Verified suppliers · transparent 10% fee · pay monthly`;
  const out = [
    `HEADLINE (max 30 chars each):`,
    `• ${dest} deals, paid monthly`,
    `• AI-built ${dest} trips`,
    `• ${dest} for less`,
    ``,
    `PRIMARY TEXT:`,
    primary,
    ``,
    `DESCRIPTION: ${description}`,
    `CALL TO ACTION: Get my quote`,
    `LANDING URL: ${link}`,
  ].join('\n');
  return { tool: 'travel_advert', title: `Advert — ${dest}`, headline, output: out, copyText: out };
}

// ---- 3. Email campaign -----------------------------------------------------
export function emailCampaign({ destination, tone: t, variant = 0 } = {}, ctx = {}) {
  const dest = normDest(destination); const tn = tone(t); const seed = seedOf(dest + variant);
  const link = ctx.referralLink || 'https://3jntravel.com';
  const subjects = [
    `${dest} — cheaper than you think (and pay monthly)`,
    `I let AI plan ${dest}. Here's what it cost.`,
    `Your ${dest} trip, sorted in one sentence`,
  ];
  const subject = pick(subjects, seed);
  const body = [
    `Subject: ${subject}`,
    `Preheader: Flights, hotel, visa & transfers — built by AI at the reliable-cheapest price.`,
    ``,
    `Hi {{first_name}},`,
    ``,
    `${tn.open} — planning ${dest} used to mean a dozen tabs and a headache. Not anymore.`,
    ``,
    `With 3JN Travel OS you describe the trip in one sentence and the AI builds the whole thing — flights, hotel, transfers, a visa-approval check and eSIM — at the lowest *reliable* price. Prefer to spread the cost? Pay a deposit and the rest in interest-free instalments.`,
    ``,
    `👉 Plan your ${dest} trip free: ${link}`,
    ``,
    `See you on the other side,`,
    `${ctx.name || 'Your 3JN partner'}`,
    ``,
    `P.S. The price guard keeps watching after you book and passes any saving back to you.`,
  ].join('\n');
  return { tool: 'email_campaign', title: `Email — ${dest}`, subject, output: body, copyText: body };
}

// ---- 4. Landing page (copy-paste HTML) -------------------------------------
export function landingPage({ destination, variant = 0 } = {}, ctx = {}) {
  const dest = normDest(destination);
  const link = ctx.referralLink || 'https://3jntravel.com';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(dest)} — cheaper, reliable, pay monthly | 3JN Travel OS</title>
<style>body{font-family:system-ui,Segoe UI,Roboto,sans-serif;margin:0;color:#12100a;background:#0b0f1a}
.wrap{max-width:720px;margin:0 auto;padding:48px 20px;color:#f5f3ee}
h1{font-size:34px;line-height:1.1;margin:0 0 12px}.sub{opacity:.8;font-size:18px;margin:0 0 24px}
.cta{display:inline-block;background:#f4b71c;color:#1a1205;font-weight:700;padding:14px 26px;border-radius:12px;text-decoration:none}
.grid{display:grid;gap:14px;margin:28px 0}.card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:16px}</style>
</head><body><div class="wrap">
<h1>${esc(dest)} for less — built by AI, paid monthly</h1>
<p class="sub">Describe your trip in one sentence. Get flights, hotel, transfers, a visa-approval check and eSIM at the lowest reliable price — with interest-free instalments.</p>
<a class="cta" href="${esc(link)}">Plan my ${esc(dest)} trip free →</a>
<div class="grid">
  <div class="card"><strong>Reliable-cheapest</strong><br>Verified suppliers only, priced against the live market floor.</div>
  <div class="card"><strong>Pay monthly</strong><br>A deposit today, the rest interest-free before you travel.</div>
  <div class="card"><strong>Visa made simple</strong><br>Know your approval odds before you book anything.</div>
</div>
<a class="cta" href="${esc(link)}">Get my ${esc(dest)} quote →</a>
</div></body></html>`;
  return { tool: 'landing_page', title: `Landing page — ${dest}`, output: html, copyText: html, isHtml: true };
}

// ---- 5. Hashtags -----------------------------------------------------------
export function hashtags({ destination, platform, variant = 0 } = {}, ctx = {}) {
  const dest = normDest(destination); const pf = normPlatform(platform);
  const slug = dest.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const broad = ['#travel', '#traveltok', '#travelgram', '#wanderlust', '#budgettravel', '#traveldeals', '#paymonthly'];
  const niche = [`#${slug}`, `#${slug}travel`, `#visit${slug}`, `#${slug}holiday`, `#${slug}deals`, `#${slug}onabudget`];
  const branded = ['#3JNTravel', '#AItravel', '#StopSearchingStartSaving'];
  const platformExtra = { instagram: ['#igtravel', '#travelreels'], tiktok: ['#tiktoktravel', '#fyptravel'], youtube: ['#travelvlog', '#shorts'], x: [], facebook: ['#travelcommunity'], whatsapp: [], linkedin: ['#businesstravel'] }[pf] || [];
  const list = [...niche.slice(0, 5), ...broad.slice(0, pf === 'x' ? 2 : 6), ...platformExtra, ...branded];
  const dedup = [...new Set(list)];
  return { tool: 'hashtags', platform: pf, title: `Hashtags — ${dest}`, list: dedup, output: dedup.join(' '), copyText: dedup.join(' ') };
}

// ---- 6. Video script (short-form) ------------------------------------------
export function videoScript({ destination, platform, variant = 0 } = {}, ctx = {}) {
  const dest = normDest(destination); const pf = normPlatform(platform); const seed = seedOf(dest + variant);
  const link = ctx.referralLink || 'https://3jntravel.com';
  const hook = pick([
    `"You're overpaying for ${dest} — watch this."`,
    `"I planned ${dest} in one sentence. No cap."`,
    `"POV: AI just booked your ${dest} trip cheaper than you could."`,
  ], seed);
  const out = [
    `${cap(pf)} script · ~30s · ${dest}`,
    ``,
    `[0-3s] HOOK (on-screen text + say it): ${hook}`,
    `[3-8s] PROBLEM: "12 tabs, prices everywhere, still not sure it's the best deal."`,
    `[8-18s] DEMO: Screen-record typing one sentence into 3JN → the AI builds flights + hotel + transfers + visa check. Show the total.`,
    `[18-25s] PROOF: "Verified suppliers, pay monthly, and it keeps watching the price after you book."`,
    `[25-30s] CTA (on-screen + say): "Plan yours free — link in bio." → ${link}`,
    ``,
    `CAPTION: ${socialPost({ destination: dest, platform: pf }, ctx).output.split('\n\n')[0]}`,
    `B-ROLL: ${dest} skyline, airport, hotel pool, phone screen-record of the search.`,
  ].join('\n');
  return { tool: 'video_script', platform: pf, title: `Video script — ${dest}`, output: out, copyText: out };
}

// ---- 7. Performance recommendations (from real dashboard metrics) ----------
export function perfRecommendations(_params, ctx = {}) {
  const d = ctx.dashboard || {};
  const refs = d.totalReferrals || 0; const active = d.activeTravellers || 0; const followers = d.followers || 0;
  const paid = d.paidReferrals || 0; const unlock = d.unlockReferrals || 20;
  const recs = [];
  if (refs === 0) recs.push('You have 0 referrals yet — post your link with a specific destination hook (people act on "Faro for £X", not "travel deals"). Use the Social Post tool above.');
  if (refs > 0 && active / Math.max(1, refs) < 0.5) recs.push(`Only ${active}/${refs} of your referrals have booked. Follow up with the Email Campaign tool — a nudge with a concrete destination converts lurkers.`);
  if (paid < unlock) recs.push(`You're ${unlock - paid} paid referrals from unlocking lifetime revenue share. Run one focused campaign on your best-performing destination.`);
  if (followers === 0) recs.push('Add your follower count under "Become a creator partner" to unlock higher revenue-share tiers (5k → 0.25%, 10k → 1%).');
  recs.push('Post 3–4×/week. Consistency beats one viral post — the Best Posting Time tool tells you when.');
  recs.push('Lead with ONE destination per post. A specific place + price outperforms generic "cheap travel" every time.');
  return { tool: 'perf_recommendations', title: 'Performance recommendations', output: recs.map((r, i) => `${i + 1}. ${r}`).join('\n\n'), copyText: recs.join('\n'), recommendations: recs };
}

// ---- 8. Audience optimisation ----------------------------------------------
export function audienceOptimisation({ destination, variant = 0 } = {}, ctx = {}) {
  const dest = normDest(destination);
  const out = [
    `Target audience for ${dest} content:`,
    ``,
    `PRIMARY: 25–44, value-driven travellers who research before booking; diaspora communities with family/heritage ties; budget-conscious families.`,
    `INTERESTS: budget travel, pay-monthly / BNPL, ${dest} tourism, visa & passport, flight deals, family holidays.`,
    `GEOS: UK first (your pricing floor is GBP), then diaspora corridors (e.g. UK ↔ West Africa, UK ↔ South Asia).`,
    `HOOKS THAT CONVERT: exact price ("${dest} from £X"), pay-monthly, visa approval odds, "reliable-cheapest".`,
    `CHANNELS: short-form video (TikTok/Reels) for reach, WhatsApp/community groups for conversion, email for follow-up.`,
    `AVOID: generic "wanderlust" posts with no price and no destination — they don't convert to referrals.`,
  ].join('\n');
  return { tool: 'audience_optimisation', title: `Audience — ${dest}`, output: out, copyText: out };
}

// ---- 9. Campaign analytics (reads real metrics) ----------------------------
export function campaignAnalytics(_params, ctx = {}) {
  const d = ctx.dashboard || {};
  const refs = d.totalReferrals || 0; const active = d.activeTravellers || 0;
  const acu = d.acuEarned || 0; const lifetime = d.lifetimeEarningsGbp ?? d.revenueGbp ?? 0;
  const pending = d.pendingCommissionGbp || 0; const rank = d.rank || d.leaderboardRank || null;
  const conv = refs > 0 ? Math.round((active / refs) * 1000) / 10 : 0;
  const out = [
    `Your campaign snapshot:`,
    ``,
    `• Referrals: ${refs}  (active travellers: ${active})`,
    `• Referral → booking conversion: ${conv}%`,
    `• ACUs earned: ${acu.toLocaleString()}`,
    `• Lifetime commission: £${Number(lifetime).toFixed(2)}  ·  pending: £${Number(pending).toFixed(2)}`,
    `• Leaderboard: ${rank ? '#' + rank : '—'}`,
    ``,
    `INSIGHT: ${refs === 0 ? 'No data yet — publish your first destination post to start the loop.' : conv >= 50 ? 'Strong conversion — your audience trusts you. Scale posting frequency.' : 'Referrals are coming but not booking — tighten the CTA and follow up by email.'}`,
    `NEXT: ${refs === 0 ? 'Use the Social Post + Hashtag tools and post today.' : 'Double down on the destination that drove your best referrals.'}`,
  ].join('\n');
  return { tool: 'campaign_analytics', title: 'Campaign analytics', output: out, copyText: out, conversionPct: conv };
}

// ---- 10. Best posting time -------------------------------------------------
export function bestTime({ platform } = {}, ctx = {}) {
  const pf = normPlatform(platform);
  const windows = {
    instagram: ['Tue–Thu 11am & 7–9pm', 'Sat 10–11am'],
    tiktok: ['Tue 9am', 'Thu 12pm & 7pm', 'Fri 5pm'],
    facebook: ['Wed 11am–1pm', 'weekdays 7–9pm'],
    x: ['weekdays 8–10am & 6pm'],
    youtube: ['Fri–Sat 3–5pm (publish; algorithm pushes over the weekend)'],
    whatsapp: ['Weekday evenings 6–9pm & Sun morning — when community groups are most active'],
    linkedin: ['Tue–Thu 8–10am'],
  };
  const w = windows[pf] || windows.instagram;
  const out = [
    `Best posting times — ${cap(pf)} (times in your local timezone):`,
    ...w.map((x) => `• ${x}`),
    ``,
    `WHY: these are peak attention windows for ${cap(pf)}. Post your CTA content then; post teasers/B-roll off-peak.`,
    `TIP: your diaspora/community audience skews to evenings and Sunday mornings — test those first.`,
  ].join('\n');
  return { tool: 'best_time', platform: pf, title: `Best times — ${cap(pf)}`, output: out, copyText: out, windows: w };
}

// ---- Dispatcher ------------------------------------------------------------
const GENERATORS = {
  social_post: socialPost,
  travel_advert: travelAdvert,
  email_campaign: emailCampaign,
  landing_page: landingPage,
  hashtags,
  video_script: videoScript,
  perf_recommendations: perfRecommendations,
  audience_optimisation: audienceOptimisation,
  campaign_analytics: campaignAnalytics,
  best_time: bestTime,
};
export function generateGrowthContent(tool, params = {}, ctx = {}) {
  const gen = GENERATORS[tool];
  if (!gen) return null;
  return gen(params, ctx);
}
export const GROWTH_TOOL_KEYS = Object.keys(GENERATORS);
