# 3JN Travel OS — AI Infrastructure Operating System Blueprint

> **An Intelligent Way To Traverse The Globe**
> Production-Grade Developer Blueprint • Investor-Grade Architecture • Agentic AI Platform

| | |
|---|---|
| **Document Type** | AI-OS Master Blueprint — Developer & Investor Grade |
| **Platform** | 3JN Travel OS (3JN Travel Operating System) |
| **Parent Entity** | Groupe Nseya Digital / JNN Global Ltd |
| **Version** | v1.0 — Production Specification |
| **Classification** | CONFIDENTIAL — Proprietary |
| **Target Markets** | UK, EU, Pan-Africa, DRC/Kinshasa, Global Diaspora Corridors |
| **Primary Currency** | GBP (Secondary: USD, EUR, CDF) |
| **Payment Rail** | BitriPay (Primary African Rail) + Stripe + Adyen |
| **Architecture** | AI-Native • Event-Driven • Microservices • Zero-Trust |
| **Build Stack** | NestJS • Next.js • PostgreSQL • Firestore • GCP • LangGraph |

> **Note on this repository.** The accompanying prototype in this repo is a self-contained,
> runnable demonstration of the *consumer pipeline* described below (intent → scan → tiered
> packages → commission → instalments → price guard → reviews → loyalty → agent sourcing). It
> runs with **no API keys** so the end-to-end experience can be shown offline. This document is
> the full production target the prototype is a first step toward. Where the prototype already
> implements a concept, it is marked **✅ in prototype**.

---

## Section 01 — Executive Product Vision

3JN Travel OS is a purpose-engineered **AI Infrastructure Operating System** that eliminates
travel complexity and minimises total trip cost through autonomous neural intelligence. Where
legacy platforms present *options*, 3JN Travel OS delivers *decisions*.

**The core problem.** The global travel industry processes USD 9T+ annually, yet the consumer
experience is unchanged since the 1990s: 42+ browser tabs per booking, 18–35% retail markup over
wholesale, zero post-booking intelligence, manual visa/transfer/eSIM management, no real-time
price monitoring, and unintegrated risk/disruption guidance.

### The seven-layer autonomous intelligence stack

| Layer | Intelligence Function | Commercial Outcome | Prototype |
|---|---|---|---|
| 01 Neural Intent | NLP extraction of 40+ travel parameters from natural language | Zero-friction search; 100% intent accuracy | ✅ `src/intent.js` |
| 02 Wholesale Engine | Direct GDS + wholesaler API negotiation bypass | 18–35% cost reduction at booking | ✅ agent net rates `src/partners.js` |
| 03 Integrity Shield | 50-point verification against supplier database | 100% verified inventory only | ✅ reliability floor `src/packager.js` |
| 04 Loyalty Injection | Membership tier discount auto-application | Additional 2–15% member savings | ✅ `src/pricing.js` |
| 05 Universal Console | Centralised visa, transfer, eSIM, document management | Single-pane journey command centre | ✅ console view |
| 06 Continuous Monitor | 24/7 price monitoring and disruption detection | Post-booking savings + zero surprises | ✅ `src/monitor.js` |
| 07 Autonomous Reoptimise | AI-triggered rebooking on price drops or disruptions | Lifetime trip cost reduction | ✅ price guard rebook/refund |

**Strategic position.** A category of one — not competing at the search layer with
Booking.com/Expedia/Skyscanner, but with the entire concept of *manual travel management*. The
closest analogy is an autonomous CFO for every journey: always negotiating, monitoring, optimising.

---

## Section 02 — Market Gap Analysis

Key gaps 3JN closes: retail-only pricing (→ direct wholesale + AI negotiation), keyword-only
search (→ 40+ parameter NLP), platforms abandoning users post-booking (→ 24/7 monitoring),
fragmented visa/transfer/eSIM/insurance (→ Universal Console), no direct GDS coverage for
Sub-Saharan Africa (→ BitriPay + pan-African operators + CDF), siloed loyalty (→ aggregation +
auto-injection), manual FCO checks (→ Risk Intelligence Agent), expensive corporate tools
(→ AI-OS at consumer price), multi-traveller family logistics, and private-aviation access.

### Addressable market

| Segment | TAM | SAM (3JN) | 3-Year SOM |
|---|---|---|---|
| Global OTA Market | USD 1.06T | USD 180B | GBP 85M ARR |
| Corporate Travel Tech | USD 47B | USD 12B | GBP 22M ARR |
| African Travel (DRC + SSA) | USD 38B | USD 8B | GBP 14M ARR |
| UK/EU Diaspora Corridors | USD 22B | USD 6B | GBP 9M ARR |
| AI Travel Assistants (41% CAGR) | USD 3.2B | Full market | GBP 18M ARR |

---

## Section 03 — User Ecosystem

### Consumer tiers ✅ in prototype (pricing + loyalty)

| Tier | Plan | £/mo | Use Case | Key AI Features |
|---|---|---|---|---|
| Explorer | Travel+ Nomad | 4.99 | Solo / digital nomad | AI Negotiation, Savings Alerts, 0% Transaction Fees |
| Family | Travel+ Family | 12.99 | Families, 2–6 travellers | Child Safety Intelligence, Sync-Mesh Itinerary, Lounge Access |
| Executive | Travel+ Executive | 24.99 | Business / SME | Coworking Intelligence, Expense Integration, Fast-Track |
| Elite | Travel+ Elite | 49.99 | HNWI / C-Suite | Private Aviation, Guaranteed Upgrades, 24/7 Risk Mitigation |

**Business/Enterprise users:** SME Travel Manager, Enterprise Admin, Travel Agency Partner
(white-label), API Developer Partner, BitriPay Merchant.
**Operations users:** Super Admin, Operations Manager, Finance Admin, Compliance Officer,
AI Governance Admin — each with a dedicated command centre.

---

## Section 04 — AI Command Centres

Every user class receives a dedicated, role-specific **AI Command Centre**.

- **Traveller (Universal Console)** — Journey Status, AI Chief of Staff, Price Watch, Visa
  Automation, Transfer Intelligence, eSIM Manager, Savings Ledger, Risk Feed, Loyalty Aggregator,
  Document Vault. ✅ *prototype console covers journeys, instalments, price guard, reviews*
- **Executive layer** — Expense Intelligence (Xero/QuickBooks/SAP), Coworking Finder, Meeting
  Logistics, Fast-Track Intelligence.
- **Elite layer** — Private Aviation Agent, Concierge Intelligence, Security Briefing, Guaranteed
  Upgrade Engine.
- **Business/Enterprise** — Policy Enforcement, Approval Workflow, Budget Intelligence, Team
  Itinerary Mesh, Supplier Negotiation, Duty of Care.
- **Admin Super Control Centre** — Platform Health, Revenue Intelligence, User Lifecycle, AI
  Governance, Compliance, Dispute Resolution, Fraud Intelligence. ✅ *prototype `/api/admin/revenue`*

---

## Section 05 — AI Agent Architecture (Travel Intelligence Mesh)

Orchestrated via **LangGraph**, agents share an event bus and vector memory.

### Core 10 agents ✅ represented in prototype landing + sourcing

Flight Intelligence · Hotel Negotiation · Visa Automation · Transfer Logistics · Savings Guard ·
Risk Intelligence · Loyalty Aggregation · eSIM Intelligence · Compliance & KYC · AI Chief of Staff
(central orchestrator).

### Enterprise agent workforce (40+)

- **Executive:** CEO, CFO, CMO, CRO, COO agents.
- **Cybersecurity:** Threat Hunter, SOC, Fraud Detection, Identity, Vulnerability.
- **Revenue & Commercial:** Pricing, Upsell, Churn Prevention, Monetisation.
- **Compliance:** GDPR, AML, KYC, Regulatory (ATOL/IATA/CAA).

Each agent has defined inputs, outputs, triggers, escalation rules and commercial KPIs.

---

## Section 06 — Platform Modules

- **Consumer:** Onboarding, Search & Discovery (NLP), Booking Engine (BitriPay checkout),
  Universal Console, Price Monitor Dashboard, Visa Centre, Loyalty Hub, Risk Intelligence Feed,
  Document Vault, Referral & Rewards. ✅ *most modelled in prototype*
- **Business/Enterprise:** Business Travel Portal, Expense Intelligence, Duty of Care Centre,
  Supplier Contract Manager, Analytics & Reporting.
- **Admin/Ops:** Super Admin Panel, Revenue Control Centre, Compliance Centre, Dispute Centre,
  API Management, Agent Configuration, Platform Health, Fraud Intelligence.

---

## Section 07 — BitriPay Payment Gateway (African Rail)

Primary payment infrastructure for African market transactions with full multi-currency incl.
**CDF (Congolese Franc)**. A dedicated *BitriPay API Door*: API Key Manager, Sandbox, Webhook
Engine (HMAC-SHA256), Merchant Onboarding (KYB), QR Payment Engine, Payment Links, Wallet,
**Mobile Money Bridge (M-Pesa, Airtel, Orange, Africell — CDF native)**, Settlement (T+1),
Refund & Dispute API, Commission Splitter, Transaction Monitor.

**Supported methods:** BitriPay Wallet (instant), M-Pesa/Airtel/Orange/Africell (T+1, CDF & local),
SEPA (EUR T+1), Cards (T+2), QR (instant). ✅ *prototype offers BitriPay + mobile money at checkout*

---

## Section 08 — Third-Party API Connector Ecosystem

- **Travel inventory/GDS:** Amadeus (+ Sabre), Hotelbeds (+ RateHawk/Juniper), Duffel + Kiwi.com
  (LCC), Cartrawler/RentalCars (car), Mozio (transfers), Airalo/Holafly (eSIM), VisaHQ/Sherpa°
  (visa), Cover Genius/Battleface (insurance), Points.com/Award Wallet (loyalty).
- **Payments/FinTech:** BitriPay (African rail), Stripe (cards/subscriptions), Adyen (enterprise),
  TrueLayer (open banking), Wise (FX), Stripe Billing.
- **Identity/KYC/Compliance:** Sumsub (+ KYB + Liveness), ComplyAdvantage (AML), Stripe Radar/Seon
  (fraud), Auth0/Firebase (auth).
- **Communications:** SendGrid (email), Twilio (SMS), Twilio/360dialog (**WhatsApp Business** —
  journey updates + AI assistant channel) ✅ *prototype WhatsApp CTA*, FCM (push), Intercom (chat).
- **AI providers:** Anthropic Claude (Sonnet/Haiku — intent, Chief of Staff, risk), OpenAI GPT-4o
  (reviews, itineraries, extraction), Google Vertex/Gemini (multimodal, translation), Cohere
  Command R+ (enterprise RAG), Pinecone (vector memory).

---

## Section 09 — Technical Architecture

- **Frontend:** Next.js 15 (App Router), shadcn/ui + Radix, Zustand + React Query, WebSocket/SSE,
  Google Maps/Mapbox, React Native (Expo), next-intl (EN/FR/SW/**LN Lingala**), PostHog.
- **Backend:** NestJS, Kong + AWS API Gateway, Apache Kafka (event bus), BullMQ + Redis,
  Auth0 + Firebase, **LangGraph + LangChain**, Pinecone + Redis memory, Temporal.io workflows.
- **Databases:** PostgreSQL 16 (Cloud SQL), Firestore, Redis (Upstash), Pinecone, BigQuery,
  GCS + Cloudflare R2, Kafka event store, Elasticsearch.
- **AI Orchestration Layer:** agent graph (10 core + 40+ enterprise as StateGraph nodes), model
  router (Claude/GPT-4o/Gemini by task + cost), tool registry, shared vector memory bus, session
  memory, escalation bus, AI governance layer, **ACU metering on every LLM call**.
- **Zero-Trust Security:** Auth0 MFA + biometrics + device fingerprinting (ISO 27001/SOC 2);
  Kong JWT/rate-limit/WAF (OWASP API Top 10); AES-256 at rest + TLS 1.3 (PCI-DSS v4.0);
  tokenisation; Cloudflare + GCP Cloud Armor DDoS; Snyk/Trivy/ZAP scanning (<48h CVE SLA);
  immutable BigQuery audit log (GDPR Art.30).

---

## Section 10 — Database Schema (PostgreSQL)

All tables include `created_at`, `updated_at`, `deleted_at` (soft delete), `version` (optimistic
lock). Monetary values stored as integers (minor units). UUIDs via `uuid_generate_v4()`.

Core tables: `users`, `memberships`, `bookings`, `booking_segments`, `payments`, `price_monitors`,
`savings_events`, `visa_applications`, `loyalty_accounts`, `agent_logs`, `risk_alerts`,
`merchants`, `api_keys`, `accu_ledger`. (Full field lists in source spec §10.1.)

---

## Section 11 — API Specification

Versioned under `/api/v1/`, Bearer JWT (Auth0), JSON:API responses, Kong rate limits.

Representative endpoints: `POST /search/intent` (NL intent), `/search/flights`, `/search/hotels`,
`POST /bookings`, `GET /bookings/:id`, `POST /bookings/:id/cancel`, `GET /console`,
`POST /agents/chat` (Chief of Staff), `price-monitors`, `visa/check` + `visa/apply`, `loyalty`,
`risk/:destination`, `savings/history`, `payments/intent`, `payments/webhook` (HMAC),
`admin/users`, `admin/revenue`, `merchant/keys`.

Webhook events: `booking.confirmed`, `booking.cancelled`, `price.drop_detected`,
`visa.status_update`, `risk.alert`, `payment.succeeded`, `payment.failed`, `kyc.completed`,
`agent.escalation`.

> The prototype implements a parallel, simplified set: `/api/plan`, `/api/quote`, `/api/book`,
> `/api/book/:id/pay`, `/api/book/:id/price-guard`, `/api/reviews`, `/api/admin/revenue`,
> `/api/v1/search` (white-label).

---

## Section 12 — Monetisation Model

### Revenue streams ✅ several modelled in prototype `src/revenue.js`

Membership subscriptions (£4.99–£49.99) · wholesale margin (3–8%) · transaction fees (1.5–2.5%) ·
**ACU credits (from £0.002/ACU)** · BitriPay gateway (0.8–1.5%) · API access (£99–£2,499/mo) ·
white-label licensing (£2,000–£25,000/mo) · supplier advertising (CPM+CPC) · insurance commission
(8–15%) · data intelligence (enterprise).

### ACU (AI Credits Unit) allowances ✅ in prototype

| Tier | Included ACU/mo | Overage |
|---|---|---|
| Nomad | 1,500 | £0.004 |
| Family | 4,000 | £0.003 |
| Executive | 10,000 | £0.0025 |
| Elite | 30,000 | £0.002 |
| Business | 50,000/team | £0.0018 |
| API Developer | PAYG | £0.003 |

### 3-Year projection

| Metric | Y1 | Y2 | Y3 |
|---|---|---|---|
| Paid members | 12,000 | 65,000 | 210,000 |
| Business clients | 80 | 420 | 1,800 |
| ARPU/mo | £12.40 | £14.20 | £16.80 |
| GBV | £18M | £95M | £380M |
| Total revenue | £3.1M | £18.4M | £71.5M |
| Gross margin | 62% | 68% | 74% |

---

## Section 13 — Security, Compliance & Risk

Regulatory matrix: **GDPR** (UK/EU), **PCI-DSS v4.0**, **FCA EMI**, **ATOL/ABTA**, **AML/CTF
(MLR 2017)**, **BCC Instruction n°58 (DRC)**, **DRC data localisation**.

KYC tiers: Tier 1 (all users — email/phone + Sumsub doc + liveness + sanctions), Tier 2 (Elite +
Business — source-of-funds, EDD), Tier 3 (ongoing monitoring + 12-month re-verification). SARs via
MLRO to NCA (UK) / FIU (DRC) within 24h.

Fraud: every transaction scored 0–100 on 40+ signals; <30 auto-allow, 30–70 step-up, >70 review;
ATO protection; 3DS2 on card payments >£150.

---

## Section 14 — Admin Super Control Centre

Modules: Platform Health (Prometheus/Grafana), Revenue Intelligence (BigQuery + Stripe + BitriPay),
User Lifecycle (PostHog), AI Governance (LangGraph + agent logs), Compliance, Fraud Intelligence,
Dispute Resolution, API Management, Agent Command Centre.

---

## Section 15 — Developer Build Roadmap

- **Phase 1 — MVP (M1–4):** Auth + onboarding, Flight Agent v1 (Amadeus), Hotel Agent v1
  (Hotelbeds), Booking Engine (Stripe + BitriPay), Universal Console v1, Membership billing,
  Admin v1, GCP infra. *Objective: first paying subscribers + verified bookings.*
- **Phase 2 — Beta (M5–8):** Savings Guard, Visa Automation v1, Risk Intelligence, eSIM, Loyalty
  v1, full BitriPay (QR + mobile money + CDF), Business Portal v1, Transfer Logistics, mobile
  apps. *Objective: 5,000 members + first business clients + African activation.*
- **Phase 3 — Commercial Launch (M9–14):** Chief of Staff v2, ACU billing, API Developer Portal +
  SDKs, White-Label framework, Enterprise Command Centre, fraud upgrade, full compliance suite,
  Coworking + Private Aviation agents. *Objective: £1M ARR + 20,000 members + first white-label.*
- **Phase 4 — Enterprise & Global Scale (M15–24):** full 40+ agent workforce, self-healing infra,
  AI governance framework, data intelligence product, marketplace layer, DRC/Kinshasa features
  (CDF-native, Lingala), predictive rebooking, global expansion. *Objective: £10M ARR + 150,000
  members + 3 white-label partners + DRC market leader.*

---

## Section 16 — Competitive Advantage

**Structural moats:** Wholesale Intelligence (12–18 mo to replicate), Travel Intelligence Mesh
(18–24 mo + proprietary data), Universal Console lock-in (grows with tenure), BitriPay African Rail
(first-mover + regulatory), ACU Data Network (compounds with GMV), White-Label Ecosystem
(distribution moat).

**Why incumbents can't match it:** OTAs are retail marketplaces (no wholesale/agents/post-booking
OS); metasearch is pure search (no booking/management/loyalty); corporate TMCs are £20–50/booking
enterprise-only with no African market; traditional agents have wholesale but no AI/automation/
scale. No platform combines wholesale pricing + AI intent + 10-agent mesh + Universal Console +
BitriPay + ACU economy in one OS.

---

## Appendix A — Technology Stack Reference

Frontend: Next.js 15, React Native (Expo), shadcn/ui, Tailwind, Zustand, React Query, Socket.io ·
Backend: NestJS, Temporal.io, LangGraph, LangChain, BullMQ · Databases: PostgreSQL 16, Firestore,
Redis, Pinecone, BigQuery, Elasticsearch · Infra: GCP, Cloudflare Enterprise, Terraform, GitHub
Actions · AI: Claude (Sonnet/Haiku), GPT-4o, Gemini Pro, Cohere Command R+ · Payments: BitriPay,
Stripe, Adyen, TrueLayer, Wise · Identity/Compliance: Auth0, Sumsub, ComplyAdvantage, Seon,
DocuSign · Inventory: Amadeus, Sabre, Hotelbeds, Duffel, Mozio, VisaHQ, Airalo, Cover Genius ·
Comms: SendGrid, Twilio, FCM, Intercom · Monitoring: Prometheus, Grafana, PostHog, Datadog, Sentry.

## Appendix B — ACU Reference Table ✅ in prototype `src/revenue.js`

| Agent Action | ACU | Notes |
|---|---|---|
| Natural language intent extraction | 8 | per search query |
| Flight search (GDS + wholesale) | 15 | per search execution |
| Hotel search (Hotelbeds wholesale) | 12 | per search execution |
| Price monitor check (automated) | 3 | per check cycle |
| Visa eligibility check | 10 | per destination per passport |
| Risk intelligence briefing | 18 | full destination risk report |
| Chief of Staff conversational turn | 12 | per dialogue exchange |
| Expense categorisation (per receipt) | 5 | Executive+ tier |
| Private aviation quote | 25 | Elite tier only |
| Coworking recommendation | 8 | Executive+ tier |

---

*3JN TRAVEL OS — AI Infrastructure OS Blueprint. Powered by Artificial Intelligence • Built for
Better Travel. CONFIDENTIAL — Proprietary & Investor-Grade — Groupe Nseya Digital / JNN Global Ltd.*
