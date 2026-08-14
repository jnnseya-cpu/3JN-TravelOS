# 3JN Launch Week

Everything in the codebase is built and pushed. These are the moves only you
can make — the ones that turn 483 landing pages and 20 blog posts into your
first paying customers. Work top to bottom.

- **Destination:** first customers
- **Build:** `…feature-money-pages-v255` live
- **ETA:** steps 1–3 today

> **Golden rule:** every setting below is an environment variable in
> **Vercel → your project → Settings → Environment Variables**. Add it, scope
> it to **Production**, then hit **Redeploy**. Nothing takes effect until you
> redeploy — that one step is the most common reason a change "didn't work".

---

## 1. Switch on email capture ⚡ makes money · ~10 min

Your landing pages already have the "get cheapest-date alerts" box. It just
needs a mailbox to send from. Set your Hostinger SMTP password and redeploy.

```bash
# Required — the mailbox password for info@3jntravel.com
SMTP_PASS=your-hostinger-mailbox-password

# Optional — only if different from the defaults shown
SMTP_USER=info@3jntravel.com
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=465
```

**Then verify:** open `/destinations/lagos`, enter your own email in the alert
box, and check your inbox for the welcome email. If it lands, capture is live
and the weekly cheapest-date alerts will fire on their own.

> **Why:** the 95% who aren't ready to buy on the first visit now leave you an
> email you can re-engage — the highest-ROI switch you have.

---

## 2. Get indexed by Google ⚡ makes money · ~15 min

This is the switch that makes all the SEO real. Until you do it, your 483
landing pages and 20 posts are invisible to search.

1. Go to [Google Search Console](https://search.google.com/search-console) and
   add your site (use the **URL-prefix** property with `https://3jntravel.com`
   — it's the simplest).
2. Choose a verification method and set the matching env var, then
   **Redeploy**, then click **Verify** in Search Console:

**Option A · meta tag (easiest)**

```bash
# Google shows: <meta name="google-site-verification" content="ABC123…">
# Copy just the token into this var:
GOOGLE_SITE_VERIFICATION=ABC123theTokenGoogleGivesYou
```

**Option B · HTML file**

```bash
# Google offers a file like google1a2b3c.html — set its exact name:
GOOGLE_VERIFICATION_FILE=google1a2b3c.html
```

3. Once verified: in Search Console open **Sitemaps** and submit `sitemap.xml`.
4. Optional — do the same on
   [Bing Webmaster Tools](https://www.bing.com/webmasters) with
   `BING_SITE_VERIFICATION`.

> **Why:** submitting the sitemap is what tells Google your 500+ pages exist.
> New domains take 8–16 weeks to rank — this starts that clock the day you do
> it, not before.

---

## 3. Post to your own communities ⚡ makes money · ~20 min · today

Your first 10–50 customers come from people who already trust *you*, not from
an algorithm. Pick 3–5 WhatsApp / Facebook / association groups you're
genuinely part of and share the page that fits each one. Paste this, swap the
domain if yours differs, and drop in the link that matches the group:

```text
✈️ Planning a trip home or abroad? I built something for us.

3JN Travel OS finds the cheapest reliable flights + hotels and lets you PAY
MONTHLY — a small deposit, then spread the rest interest-free, with your price
locked in from day one.

What it does:
• Tell it "cheapest dates" and the AI scans a whole month for the lowest fare
• Instant visa approval check before you book anything
• Real, cancellable flight + hotel reservations for visa applications
• A travel eSIM so you land with data already working

Have a look — no sign-up needed to search:
👉 https://3jntravel.com

Flying to Lagos?  → https://3jntravel.com/flights/london-to-lagos
Heading to Accra? → https://3jntravel.com/destinations/accra
Home to Kingston? → https://3jntravel.com/destinations/kingston

Any questions, just ask me directly 🙏
```

**Match the link to the group:** a UK–Nigeria group gets
`/flights/london-to-lagos`; a Ghana group gets `/destinations/accra`; a
Caribbean group gets `/destinations/kingston`. There are 339 route pages and
123 destination pages — there's one for almost everyone.

> **Why:** this does two jobs at once — it can produce your first customer in
> days, and the early real traffic sends Google the engagement signals that
> make everything rank faster.

---

## 4. Turn on verified reviews ⏳ when you make your first sale

The review invite already fires automatically on every booking confirmation —
it just needs a Trustpilot address to BCC. Create a free Trustpilot business
account, find your Automatic Feedback Service (AFS) address, and set it.

```bash
TRUSTPILOT_AFS_EMAIL=yourcompany+xxxx@invite.trustpilot.com

# Later, once your Trustpilot profile shows real stars:
TRUSTPILOT_BUSINESS_UNIT_ID=your-business-unit-id
TRUSTPILOT_WIDGET=true
```

> **Why:** real reviews after each trip build the trust a new brand doesn't
> have yet — earned honestly, not bought.

---

## 5. Financial-protection badge ⏳ before you scale flight sales

Selling flight-inclusive packages to UK travellers legally needs financial
protection (ATOL, or a TTA / trust-account arrangement). It's also your single
biggest conversion lever. The badge is wired everywhere already — it appears
the moment you set a real scheme, and **stays hidden until you do** so you
never claim cover you don't hold.

```bash
MONEY_PROTECTION_SCHEME=ATOL
MONEY_PROTECTION_NUMBER=12345
MONEY_PROTECTION_URL=https://checkatol.caa.co.uk/
```

> **Do not skip:** this one is legal, not optional, for UK flight packages.
> Until it's sorted, lean on the pages you can sell now (hotels, visa
> reservations, eSIM) and get the cover moving in parallel.

---

## Confirm it's all live — 60-second check

- `/api/health` → `build` reads `…feature-money-pages-v255` (older = your
  deploy is stale, redeploy).
- `/sitemap.xml` → loads and lists `/destinations/…`, `/flights/…` and
  `/blog/…` URLs.
- `/blog` → shows 20 posts, including "Pay Monthly Flights" and "Price-Lock
  Guarantee".
- `/why-3jn` → the trust page renders.

---

## Reference — every env var, one place

| Variable | Turns on | When |
| --- | --- | --- |
| `SMTP_PASS` | Email capture + welcome & alert emails | Now |
| `GOOGLE_SITE_VERIFICATION` | Google Search Console (meta method) | Now |
| `GOOGLE_VERIFICATION_FILE` | Google Search Console (file method) | Now — alt to above |
| `BING_SITE_VERIFICATION` | Bing Webmaster Tools | Optional |
| `TRUSTPILOT_AFS_EMAIL` | Verified review invites after booking | First sale |
| `TRUSTPILOT_WIDGET` | Live star widget (once stars exist) | Later |
| `MONEY_PROTECTION_SCHEME` | ATOL/TTA protection badge sitewide | When certified |
| `MONEY_PROTECTION_NUMBER` | Your scheme number on the badge | When certified |

---

Do steps 1–3 this week — they're free and they're what actually starts customer
acquisition. Steps 4–5 slot in as you make your first sales and sort
protection. The engine is built and pointed the right way; this is the fuel.
