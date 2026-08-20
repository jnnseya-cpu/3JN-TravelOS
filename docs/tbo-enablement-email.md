# TBO / TekTravels — API activation & product enablement email

> **Ready to send** once you fill the four `«…»` placeholders (TBO Agency/Member
> ID, account-manager name, your phone, expected monthly volume). Suggested
> recipients: your TBO/TekTravels account manager **+** `support@tektravels.com`
> (and `apisupport@tektravels.com` if you have it).
>
> This email covers **all** TBO product APIs. It supersedes the earlier
> Air-only draft; the Air-specific technical detail is retained in §A below.

---

**To:** «TBO / TekTravels account manager» <«am@tektravels.com»>; support@tektravels.com
**Cc:** «finance/ops contact»
**Subject:** API activation + product enablement — 3JN Travel (Agency ID «xxxx»)

Hi «name»,

We're 3JN Travel, an existing TBO account holder (**Agency/Member ID «xxxx»**).
We're moving from portal use to **full API integration** and would like to
**activate our API credentials** and **enable API access across your product
range** so we can search, book and ticket through TBO programmatically.

## 1. Please activate / provide our API credentials

- **ClientId**, **API UserName** and **Password** (the API user, distinct from
  the portal login) for **both UAT/sandbox and production**.
- Confirmation of the **token/session model** (we cache the `TokenId` from
  `Authenticate` — please confirm its real validity/TTL).

## 2. Please enable API access for these product lines

We'd like the API switched on for each of the following (a few we're integrating
first, the rest for our roadmap — please enable all so we can build progressively):

| Priority | Product | We're building now? |
|---|---|---|
| **1** | **Air** (flights — search/hold/ticket) | ✅ adapter built, ready to certify |
| **1** | **Hotels** | ✅ search built |
| 2 | **Transfers** | roadmap |
| 2 | **Sightseeing** | roadmap |
| 2 | **Car Rental** | roadmap |
| 2 | **Packages** | roadmap |
| 3 | **Insurance** | roadmap |
| 3 | **Rail Europe** | roadmap |
| 3 | **Cruise** | roadmap |
| 3 | **Umrah** | roadmap |
| 3 | **Cargo** | roadmap |
| 3 | **Marine** | roadmap |
| 3 | **Platinum Collection** | roadmap |

For each enabled product, please send us the **API documentation pack** (request/
response spec) and the **base URL / service endpoint** our calls should target,
plus a note on any product that requires a separate **certification** before we
can go live.

## 3. End-user IP / server allowlisting — please advise

Your APIs take an **`EndUserIp`** on each request, and we understand TBO may also
**allowlist the calling server IPs**. Our platform runs on **serverless
infrastructure, so outbound requests don't come from a single static IP.** Please
tell us how you'd like this handled:

- (a) you allowlist a **CIDR range**, or
- (b) we route TBO traffic through a **static-egress proxy/NAT** and give you one
  fixed IP (straightforward on our side — just confirm and we'll provision it), or
- (c) you don't IP-restrict and rely on credential auth.

Also please confirm what value you expect in the **`EndUserIp`** field (traveller
IP, our server IP, or a fixed value).

## 4. Settlement, funding & commercials

- How is booking/ticketing **funded** — prepaid **deposit/wallet balance**, a
  **credit line**, or per-transaction? Which **currency**, minimum balance, and
  top-up mechanics?
- **Net-rate vs commission** basis per product, and where fare rules / baggage /
  cancellation policy / ancillaries are returned in the responses.
- For **Air specifically**: please confirm the account is set up for
  **consolidator/agency ticketing** (issuing on TBO's plating/stock, no separate
  IATA needed on our side) and any market/airline or **LCC vs GDS** scope limits.

## 5. Environment & limits

- A **UAT/sandbox ClientId** so we can run controlled end-to-end tests
  (search → book → cancel/void within the free window) before production.
- Any **rate limits**, and a **technical support contact** for live issues.

We're integrated and ready to certify **Air and Hotels immediately** once
credentials land, and will onboard the remaining products in turn. Happy to jump
on a short call to fast-track this.

Thanks very much,

«Full name»
«Title», 3JN Travel
info@3jntravel.com · «phone»
https://3jntravel.com

---

## §A — Air API (v10) technical specifics (for your API/onboarding team)

Our Air integration targets the **v10 spec** (`Authenticate` → `Search` →
`FareQuote`/`Book`/`Ticket`). Our adapter currently defaults to:

- Auth: `https://api.tektravels.com/SharedServices/SharedData.svc/rest/Authenticate`
- Search: `https://api.tektravels.com/BookingEngineService_Air/AirService.svc/rest/Search`

Please confirm the correct **live base URL/host** if different, and confirm the
credentials are enabled for the **Air** service (`BookingEngineService_Air`), not
hotel-only. We'll re-verify the exact request/response field names against the
live responses on first connect.

---

### Internal notes (do NOT include in the email)
- Air env vars in `backend/src/live-suppliers.js`: `TBO_AIR_CLIENT_ID`,
  `TBO_AIR_USERNAME`, `TBO_AIR_PASSWORD`, `TBO_AIR_END_USER_IP` (must be a real/
  allowlisted IP — not the `1.1.1.1` placeholder), `TBO_AIR_BASE_URL`
  (default `https://api.tektravels.com`). TBO Hotels reuses `TBO_HOTEL_USERNAME`/
  `TBO_HOTEL_PASSWORD`.
- The Air adapter is inert (`tboAirEnabled()` false) until ClientId + username +
  password are set; verify via `/api/admin/live-status` (`flights.tboAir`) or
  `tboAirDiagnostic()`. Booking/ticket field names are flagged "re-verify at
  certification" — do the sandbox cert before enabling a live key.
- Only Air + TBO Hotels have adapters today; Transfers/Sightseeing/Car/Packages/
  Insurance/Rail/Cruise/Umrah/Cargo/Marine/Platinum need adapters built after TBO
  provides each product's spec.
