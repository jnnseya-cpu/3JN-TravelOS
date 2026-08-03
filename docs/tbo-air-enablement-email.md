# TBO Air API (v10) — Enablement Email Draft

> **Status: DRAFT — do not send yet.** Fill the `«…»` placeholders (company/legal
> name, contact, expected volumes, egress IPs) before sending. Suggested
> recipients: your TBO/TekTravels account manager + `support@tektravels.com` /
> your onboarding contact.

---

**To:** «TBO / TekTravels account manager» <«am@tektravels.com»>
**Cc:** «finance/ops contact»
**Subject:** Air API (v10) live enablement — «3JN Travel / legal entity» consolidator ticketing

Hi «name»,

We'd like to enable **live Air API (v10)** access on our TBO account so we can
search, hold and ticket air content through TBO as a consolidator alongside our
existing GDS/NDC lanes. Our integration against the v10 Air spec
(`Authenticate` → `Search` → `FareQuote`/`Book`/`Ticket`) is already built and
tested against the documented request/response contract; we just need live
credentials and the account configured for ticketing.

Could you please provide / confirm the following:

### 1. Live API credentials
- **ClientId** for the live environment
- **UserName** and **Password** (API user, distinct from the portal login)
- Confirmation these are enabled for the **Air** service (`BookingEngineService_Air`),
  not hotel-only

### 2. Endpoint / base URL
- Please confirm the **live base URL** our calls should target. Our adapter
  currently defaults to `https://api.tektravels.com`
  (`/SharedServices/SharedData.svc/rest/Authenticate` and
  `/BookingEngineService_Air/AirService.svc/rest/Search`). If live traffic should
  go to a different host/path, let us know and we'll point to it.

### 3. End-user IP allowlisting — please advise
The v10 API takes an **`EndUserIp`** on every request, and we understand TBO may
also **allowlist the calling server IPs**. Two things we need to sort out:
- **Our platform runs on serverless infrastructure (Vercel), so outbound requests
  do not originate from a single static IP.** Please tell us how you'd like us to
  handle this — e.g. (a) you allowlist a CIDR range, (b) we route TBO traffic
  through a **static-egress proxy / NAT** and give you that fixed IP, or (c) you
  don't IP-restrict and rely on credential auth. Option (b) is straightforward on
  our side if you need a single fixed IP — just confirm and we'll provision it and
  send you the address.
- Please confirm what value you expect in the request `EndUserIp` field (the
  traveller's IP, our server IP, or a fixed placeholder).

### 4. Consolidator ticketing arrangement
- Please confirm the account is set up for **consolidator/agency ticketing** (i.e.
  we can issue tickets on TBO's plating/stock rather than needing our own IATA),
  and note any **markets/airlines** or **LCC vs GDS** scope limits we should code
  around.
- **Settlement & deposit:** how is ticketing funded — prepaid **deposit/wallet
  balance**, credit line, or per-PNR? What currency, and what are the top-up
  mechanics and any minimum balance?
- **Commission / net-fare** basis and where fare rules / baggage / ancillaries are
  returned in the v10 responses, so we surface them correctly to travellers.

### 5. Environment & limits
- A **UAT/staging** ClientId (if separate) so we can run a controlled end-to-end
  test (search → hold → void within the free window) before pointing production at
  live.
- Any **rate limits**, session/token TTLs (our adapter caches the `TokenId` for
  ~12h — please confirm the real validity), and support contact for live issues.

Once we have the ClientId + credentials and the IP question resolved, we can be
live-testing the same day. Happy to jump on a short call if that's easier.

Thanks very much,

«Full name»
«Title», «3JN Travel / legal entity»
«email» · «phone»
«website»

---

### Internal notes (do not include in the email)
- Env vars the credentials map to in `backend/src/live-suppliers.js`:
  `TBO_AIR_CLIENT_ID`, `TBO_AIR_USERNAME`, `TBO_AIR_PASSWORD`,
  `TBO_AIR_END_USER_IP`, `TBO_AIR_BASE_URL` (default `https://api.tektravels.com`).
- The adapter is **inert** (`tboAirEnabled()` returns false) until ClientId +
  username + password are all set — no risk of live calls before we're ready.
- Verify live status after credentials land via `/api/admin/live-status`
  (`flights.tboAir`) or the `tboAirDiagnostic()` probe.
- The v10 request/response field names in the adapter follow the documented spec
  but should be **re-verified against the live responses** on first connect
  (there's a code comment flagging this).
- If they require a fixed egress IP (option b), provision a static-egress
  proxy/NAT for TBO calls and set `TBO_AIR_END_USER_IP` accordingly.
