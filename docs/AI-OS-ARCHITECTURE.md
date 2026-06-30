# 3JN Travel OS — AI Infrastructure Operating System: Production Architecture

> **Developer-ready, investor-grade specification.** This document upgrades the platform from an
> AI-agent app into a true **AI Infrastructure Operating System (AI-OS)** with autonomous
> governance, self-healing, BitriPay integration, enterprise security, multi-agent orchestration,
> profitability systems, and production-grade architecture. It **preserves everything** in
> `docs/BLUEPRINT.md` (the 16-section base spec) and expands it. The running prototype in this
> repo implements the consumer slice end-to-end; items marked **✅** exist today, **◑** partial,
> **○** specified-for-build.

**Companion docs:** `BLUEPRINT.md` (base platform spec) · `MASTER_AI_PROMPT.md` (platform system
prompt) · `DEPLOY.md` (hosting). **Proven-pattern references** cited per section
(Stripe, Palantir Foundry, Goldman Aladdin, Uber Michelangelo, Cloudflare, CrowdStrike,
ServiceNow, Databricks, Snowflake, Temporal, LangGraph).

---

## 1. Executive Product Vision

3JN Travel OS is a **global AI-powered travel infrastructure platform** — an autonomous operating
system that manages the entire travel lifecycle (Idea → Discovery → Pricing → Booking → Payments →
Support → Rebooking → Refunds → Loyalty → Repeat) on the user's behalf. Legacy platforms present
*options*; the OS delivers *decisions* and *executes* them.

- **What it is:** an agentic AI-OS combining OTA + metasearch + dynamic packaging + fintech (BitriPay) + CRM + supplier extranet + loyalty + white-label SaaS + API marketplace into one infrastructure layer.
- **Problem solved:** travel is fragmented (42+ tabs), retail-marked (18–35%), abandoned post-booking, and manual for visa/transfer/eSIM/insurance — with no continuous optimisation and no rail for African-diaspora corridors.
- **Why different / why it dominates:** AI-led *managed execution* (not search), direct-to-wholesale + agent-account net rates, lifecycle ownership with a 24/7 price guard, WhatsApp-first conversational commerce, and BitriPay + CDF/mobile-money rails no incumbent serves. Defensibility = wholesale relationships, the Travel Intelligence Mesh + proprietary data, Universal Console lock-in, the BitriPay African rail, the ACU data network, and the white-label ecosystem.

---

## 2. Market Gap Deep Review

| Competitor | Does well | Fails to solve | 3JN fills the gap with |
|---|---|---|---|
| Booking.com / Expedia | Transaction trust, supplier tooling, conversion | Retail markup, no AI execution, abandons post-booking | Wholesale + agent net rates, lifecycle OS, price guard |
| Trip.com | Ecosystem breadth, loyalty loops | Generic personalisation, no diaspora rail | AI Chief of Staff personalisation + BitriPay/CDF |
| Airbnb | Marketplace trust between strangers | Single vertical, no flights/visa/transfer | Verified hosts inside a full package |
| Skyscanner / Momondo / Google Flights | Comparison + search aggregation | No booking, management, agents, loyalty | Intent → execute → manage end-to-end |
| loveholidays | Package conversion, flexible payments | UK-centric, no AI, no African rail | AI packaging + instalments + CDF mobile money |
| TravelPerk / Navan | Corporate travel management | £20–50/booking, enterprise-only, no Africa | AI-OS at consumer price + enterprise command centre |

**Underserved demand:** African diaspora travel, pay-monthly travel, WhatsApp-led commerce,
verified African accommodation supply, group/family/event travel, Dubai/Abu Dhabi premium funnels,
Africa-focused trust infrastructure. **Where money leaks:** retail markup, FX, no savings-share,
no post-booking rebooking, manual admin.

---

## 3. Complete User Ecosystem

| Class | User types | Primary surface |
|---|---|---|
| Consumers | Explorer/Nomad, Family, Executive, Elite; diaspora, students, group organisers | Universal Console ✅ |
| Businesses | SME Travel Manager, Enterprise Admin, Corporate Travel Team | Business/Enterprise Command Centre ○ |
| Partners | Travel Agency (white-label), Influencer/Affiliate, Supplier/DMC (e.g. Rayna agent ✅), Host ◑ | Partner Portal ◑ |
| Developers | API Developer Partner | Developer Centre (`/api/v1/*` ✅) |
| Merchants | BitriPay merchant | Merchant Portal ○ |
| Operators | Super Admin, Ops Manager, Finance Admin, Compliance Officer, AI Governance Admin | Admin Super Control Centre ◑ |
| External | Regulators (read-only audit), Third-party API partners | Compliance/API surfaces ○ |

---

## 4. AI-Agent Command Centres (per user type)

Every user receives a role-scoped **AI Command Centre**. Each centre composes the seven personal
agents below over that role's data scope, actions, automations and decision rights. *(Pattern:
Palantir Foundry workspaces + role-based AI copilots.)*

| Personal agent | Capability | Sees | Can do | Decides/recommends |
|---|---|---|---|---|
| Chief of Staff | Planning, scheduling, prioritisation, risk alerts | User memory, journeys, calendar | Plan trips, trigger agents, draft messages | Next best action, priority queue |
| AI Analyst | Analysis, reporting, forecasting | Bookings, spend, savings | Build reports, charts, exports | Savings/forecast insights |
| Research Agent | Market/competitor/destination intelligence | Public + supplier data | Compile briefings | Best window, deal alerts |
| Automation Agent | Process automation, task delegation | Workflows, triggers | Create rules/templates, auto-assign | What to automate |
| Growth Agent | Revenue, acquisition, retention, profit | Funnels, loyalty, referrals | Launch offers, referral nudges | Upsell/retention plays |
| Security Agent | Threat/access/fraud/anomaly monitoring | Auth + txn signals (scoped) | Step-up auth, lock, alert | Allow/flag/deny |
| Knowledge Agent | Knowledge/learning/memory mgmt | 4-level memory store | Curate memory, summarise | What to remember/learn |

Scope examples — **Consumer:** own trips/documents/savings; **Enterprise Admin:** team itineraries,
policy, budget, duty-of-care; **Merchant:** BitriPay txns, settlements; **Super Admin:** platform-wide
(read/act) with AI Governance gating.

---

## 5. Core AI Agents (domain spec)

The **Travel Intelligence Mesh** (10 core) + **Enterprise Workforce** (40+) run on LangGraph with a
shared event bus (Kafka) and shared vector memory (Pinecone). Each agent below is specified with
purpose, I/O, permissions, triggers, escalation, APIs and business value. *(Pattern: LangGraph
StateGraph nodes + Temporal durable workflows; OpenAI/Anthropic tool-use.)*

| Agent | Purpose | Inputs → Outputs | Permissions | Triggers | Escalation | APIs | Business value |
|---|---|---|---|---|---|---|---|
| Onboarding | KYC + plan + preference intake | identity, plan → verified profile | write user | signup | KYC Agent → human | Sumsub, Auth0 | activation rate |
| Compliance & KYC ✅ | identity verification, AML, monitoring | docs, txns → status, risk flag | read PII (scoped) | onboard, high-value txn | MLRO review | Sumsub, ComplyAdvantage | regulatory pass |
| Risk Intelligence ✅ | FCO/weather/health/civil risk | destination, dates → risk score, alert | read trip | booking, T-72h, live event | duty-of-care team | FCO, WHO | trust, fewer disruptions |
| Revenue / Monetisation | revenue-mix optimisation | streams, costs → recommendations | read finance | weekly, threshold | CFO Agent | internal | margin uplift |
| Pricing | dynamic ACU + tier conversion | usage, elasticity → price moves | propose only | real-time, weekly | Finance Admin | internal | ARPU |
| Customer Support | resolve queries, in-trip help | ticket, context → resolution/draft | act on own tickets | inbound msg | human agent | Intercom, WhatsApp | CSAT, deflection |
| Marketing / Growth | acquisition, retention | funnels, cohorts → campaigns | propose/launch (gated) | weekly, churn signal | CMO Agent | PostHog, SendGrid | CAC↓ LTV↑ |
| Data Intelligence | extract meaning, summaries | structured+unstructured → insights | read warehouse | continuous | — | BigQuery, Pinecone | decision quality |
| Operations | SLA, queue, capacity | telemetry → ops alerts | act on infra (gated) | continuous | COO Agent | Prometheus | uptime |
| Fraud Detection ✅(model) | txn fraud + ATO | txn, device → score, decision | block/flag/allow | every txn | SOC Agent | Seon, Stripe Radar | loss prevention |
| Payment | route, settle, refund | payment intent → settlement | execute (gated) | checkout, refund | Finance Admin | BitriPay, Stripe, Adyen | conversion, settlement |
| API Integration | manage connectors, retries | webhook/API events → normalised data | service scope | event | Infra Agent | all connectors | reliability |
| Workflow Automation ✅(gate) | turn repeat work into flows | actions → templates/triggers | create rules | repeated pattern | owner approval | internal | productivity |
| Predictive Growth | forecast demand, rebooking | history → predictions | propose | scheduled | CRO Agent | ML pipeline | proactive savings |
| Admin Control | platform-wide actions | admin intent → safe execution | super-admin (audited) | admin action | dual-control | internal | governance |
| Flight / Hotel / Visa / Transfer / Savings Guard / Loyalty / eSIM ✅ | (see BLUEPRINT §5.1) | — | scoped | booking lifecycle | Chief of Staff | GDS/wholesale/Visa/Airalo | core pipeline |

**Self-managing layer (autonomous ops):** System Health, Bug Detection, Auto-Repair, Infrastructure
Optimisation, Release Management, AI Governance agents. *(Pattern: ServiceNow AIOps + CrowdStrike +
progressive-delivery rollbacks.)* All write actions are **gated by AI Governance** + dual-control +
immutable audit.

---

## 6. Full Platform Modules

Consumer (✅ most modelled): Onboarding, Search & Discovery (NLP), Booking Engine, Universal Console,
Price Monitor, Visa Centre, Loyalty Hub, Risk Feed, Document Vault, Referral & Rewards, Wallet.
Business/Enterprise (○): Travel Portal, Expense Intelligence, Duty of Care, Supplier Contract
Manager, Analytics. Merchant/Partner (○): BitriPay Merchant Portal, API Settings, Commission/
Settlement, White-Label config. Admin (◑): Super Admin, Revenue Control, Compliance, Dispute, API
Management, Agent Configuration, Platform Health, Fraud Intelligence. Cross-cutting: Notifications,
Reporting/Analytics, Billing/Subscription, Audit Trail, Security. (Field-level detail: BLUEPRINT §6.)

---

## 7. BitriPay Payment Gateway API Door

Dedicated gateway environment (BLUEPRINT §7) with: **Merchant Integration Portal** (API key
mgmt ✅-prototype keys, webhook mgmt, sandbox/production), **Payment Services** (QR, wallet, card,
bank transfer, mobile money — M-Pesa/Airtel/Orange/Africell, CDF native ✅ at checkout), **Developer
Centre** (SDKs: JS/TS, Python, PHP, Flutter, RN; docs; webhook simulator), **Revenue Management**
(fee mgmt, revenue sharing, T+1 settlement, commission splitter, dispute/refund API). Webhooks are
HMAC-SHA256 signed with retry + idempotency keys. *(Pattern: Stripe Connect + webhooks.)*

---

## 8. Third-Party Connector Ecosystem (plug-and-play API doors)

| Category | Why needed | Connects at | Data in/out | Best providers |
|---|---|---|---|---|
| Payments | charge/settle | Booking/Payment Agent | amount, method ↔ status, settlement | **BitriPay**, Stripe, Adyen, Checkout.com, PayPal |
| Banking-as-a-Service / Open Banking | payouts, account verify, A2A | Finance, Payments | account, balance ↔ transfer | TrueLayer, BaaS provider |
| KYC/KYB · Identity | verify users/merchants | Onboarding, Compliance | docs, biometrics ↔ pass/fail | Sumsub, Persona, Veriff |
| AML screening | sanctions/PEP | Compliance Agent | profile ↔ risk | ComplyAdvantage |
| Fraud / Device | txn risk | Fraud Agent | device, txn ↔ score | Seon, Stripe Radar |
| Email · SMS · WhatsApp · Push | comms + AI channel | Communication Agent | events ↔ delivery | SendGrid/Brevo, Twilio, 360dialog, FCM |
| Maps · Logistics | routing, transfers | Transfer Agent | geo ↔ ETA | Google Maps, Mapbox |
| Accounting · Tax | expense export | Expense Intelligence | txns ↔ ledger | Xero, QuickBooks |
| CRM | partner/enterprise | Growth Agent | contacts ↔ pipeline | Salesforce, HubSpot |
| Analytics | product intel | Data Intelligence | events ↔ cohorts | PostHog |
| AI model providers | reasoning/gen | **AI Gateway** ✅ | prompt ↔ completion | OpenAI, Anthropic, Gemini/Vertex, Cohere, Mistral |
| Cloud · Storage | compute/objects | Infra | files ↔ urls | GCP/AWS/Azure, Cloudflare R2, S3 |
| Auth | identity/session | Identity | creds ↔ token | Auth0, Firebase Auth |
| Doc gen · E-signature | vouchers, contracts | Document Agent | data ↔ pdf/signature | PDF service, DocuSign |
| Currency exchange | multi-currency | Pricing/Payments | pair ↔ rate | Wise |
| Subscription billing | memberships | Billing | plan ↔ invoice | Stripe Billing |

Travel inventory connectors (Amadeus/Sabre, Hotelbeds/RateHawk, Duffel/Kiwi, Mozio/Cartrawler,
VisaHQ/Sherpa°, Airalo/Holafly, Cover Genius) per BLUEPRINT §8.1. Prototype models these via
`backend/src/partners.js` ✅ with the **AI Gateway** ✅ abstracting model providers.

---

## 9. Production-Grade Architecture

- **Frontend:** Next.js 15 + React Native (Expo) target; **prototype = static `frontend/`** ✅.
- **Backend:** NestJS microservices target; **prototype = Express `backend/`** ✅. Kong + cloud API gateway.
- **Data:** PostgreSQL 16 (relational) ✅-modelled, Firestore (realtime), Redis (cache/session), Pinecone (vector), BigQuery (warehouse), Elasticsearch (search), GCS/R2 (objects), Kafka (event store).
- **Auth & RBAC:** Auth0/Firebase, JWT, MFA, device fingerprinting; role + attribute-based access.
- **AI orchestration:** LangGraph + LangChain; **AI Gateway / model router** ✅ (`backend/src/ai-gateway.js`) shares Claude/OpenAI/Gemini/Cohere by task, meters ACU, local fallback.
- **Agent memory:** Pinecone (long-term) + Redis (session) — the 4-level memory model (User/Workspace/Process/Intelligence) from `MASTER_AI_PROMPT.md`.
- **Event-driven workflows:** Kafka topics + Temporal.io durable workflows (booking, visa, compliance, settlement). Webhook engine (HMAC, retries, idempotency).
- **Cross-cutting:** notification engine, immutable audit log, admin control layer, observability (Prometheus/Grafana/Datadog/Sentry), structured error handling (the prototype's `safe()` wrapper guarantees clean JSON ✅), horizontal scaling behind a stateless API + shared DB.

### Cybersecurity Command Centre (military-grade)
Zero-Trust (never trust, always verify); Identity layer (MFA, biometrics, device fingerprint,
risk-based auth); Threat detection (real-time monitoring, behavioural analytics, AI anomaly);
Fraud prevention (txn/behaviour scoring, device intelligence); Anti-hacking (DDoS, SQLi, XSS, CSRF,
session hijack, ATO, credential stuffing, API abuse, bots) via Cloudflare + WAF + rate limits;
Data protection (encryption at rest AES-256 / in transit TLS 1.3 / in use, tokenisation).
*(Pattern: CrowdStrike + Cloudflare + PCI-DSS v4.0.)*

### AI Data Intelligence Layer
Data Lake → Warehouse (BigQuery) → Vector DB (Pinecone) → Knowledge Graph; Event Streaming (Kafka);
Real-time Analytics, Predictive, Behavioural, Recommendation, and Decision Intelligence engines.
*(Pattern: Databricks/Snowflake + Uber Michelangelo feature store.)* Feeds the learning loop in
`MASTER_AI_PROMPT.md`.

---

## 10. Database Schema (developer-ready)

Core tables (PostgreSQL, soft-delete + version + audit): `users`, `memberships`, `bookings`,
`booking_segments`, `payments`, `price_monitors`, `savings_events`, `visa_applications`,
`loyalty_accounts`, `agent_logs`, `risk_alerts`, `merchants`, `api_keys`, `accu_ledger`
(fields/relationships in BLUEPRINT §10). **AI-OS additions:**

| Table | Key fields | Purpose / index |
|---|---|---|
| `agent_memory` | id, scope(user/workspace/process/intel), subject_id, embedding, payload, ts | vector index; 4-level memory |
| `automations` | id, owner_id, trigger, condition, action, enabled, last_run | event-driven rules |
| `audit_log` | id, actor, role, action, entity, before, after, ip, ts (immutable) | GDPR Art.30; ts/actor index |
| `autosave_versions` | id, entity, entity_id, version, diff, actor, ts | rollback/version history |
| `webhooks` | id, merchant_id, url, secret_hash, events[], status | HMAC delivery |
| `fraud_scores` | id, txn_id, score, signals jsonb, decision | every txn; txn_id index |
| `connector_credentials` | id, provider, scope, secret_ref(vault), status | secrets in Vault, not table |

Indexes on all FKs + `(user_id, created_at)`; RLS/row-level permissions by role; PII columns
encrypted/tokenised.

---

## 11. API Specification

Versioned `/api/v1/`, Bearer JWT (Auth0), JSON:API, Kong rate limits, idempotency keys on writes.
Representative endpoints (BLUEPRINT §11): `POST /search/intent`, `/search/flights|hotels`,
`POST /bookings`, `GET /bookings/:id`, `POST /bookings/:id/cancel`, `GET /console`,
`POST /agents/chat`, `price-monitors`, `visa/check|apply`, `loyalty`, `risk/:destination`,
`savings/history`, `payments/intent`, `payments/webhook` (HMAC), `admin/*`, `merchant/keys`.
**Prototype live endpoints** ✅: `/api/context`, `/api/plan`, `/api/quote`, `/api/book`,
`/api/book/:id/pay`, `/api/book/:id/price-guard`, `/api/reviews`, `/api/account*`,
`/api/white-label/payout`, `/api/admin/revenue`, `/api/ai/status`, `/api/v1/search`.
Standard error envelope `{error, message}`; codes 400/401/403/404/409/422/429/500.

---

## 12. Monetisation Model (commercial dominance)

Revenue Engine streams: **subscriptions** (£4.99–£49.99), **wholesale margin** (3–8%),
**transaction fee** (1.5–2.5%), **10% final-payment fee** ✅, **ACU usage** (from £0.002) ✅,
**savings-share** (10%) ✅, **BitriPay gateway** (0.8–1.5%), **API access** (£99–£2,499/mo),
**white-label** (£2k–£25k/mo) ✅-calculator, **supplier advertising**, **insurance commission**
(8–15%), **marketplace** (5–30%), **data intelligence** (enterprise). Engines: Dynamic Pricing,
AI Revenue Optimisation, CLV, Churn Prevention, Upsell, Cross-Sell. ACU tiers + Appendix B costs ✅
in `shared/constants.js`. *(Pattern: Stripe usage-based billing + AWS metering.)*

---

## 13. Security, Compliance & Risk

GDPR (consent, DSAR, 72h breach), PCI-DSS v4.0 (SAQ D, tokenisation, WAF), FCA EMI, ATOL/ABTA,
AML/CTF (MLR 2017), BCC Instruction n°58 (DRC), DRC data localisation. KYC tiers 1–3 + ongoing
monitoring; SAR via MLRO ≤24h. Fraud 0–100 on 40+ signals (<30 allow, 30–70 step-up, >70 review),
3DS2 >£150. Controls: RBAC, encryption, secure API keys (Vault), webhook signing, transaction
monitoring, **immutable admin-action audit** + AI-decision audit. (Detail: BLUEPRINT §13.)

---

## 14. Admin Super Control Centre

Modules (◑ partial in prototype): Platform Health (Prometheus/Grafana), Revenue Intelligence
(BigQuery + Stripe + BitriPay) ✅`/api/admin/revenue`, User Lifecycle (PostHog), **AI Governance
Panel** (agent instructions, model selection, permissions, policy, A/B, escalation queue),
Compliance, Fraud Intelligence, Dispute Resolution, API Management, **Agent Command Centre** (per-
agent health/queue/success/latency). Dual-control + immutable audit on every privileged action.

---

## 15. Developer Build Roadmap

| Phase | Window | Deliverables | Commercial objective |
|---|---|---|---|
| MVP ✅(prototype-equivalent) | M1–4 | Auth+KYC, Flight/Hotel agents, Booking (Stripe+BitriPay), Console v1, Billing, Admin v1, infra | first paying subs + verified bookings |
| Beta | M5–8 | Savings Guard, Visa, Risk, eSIM, Loyalty v1, full BitriPay (QR+mobile money+CDF), Business Portal, mobile apps | 5,000 members + first business + African activation |
| Commercial | M9–14 | Chief of Staff v2, ACU billing, API Developer Portal+SDKs, White-Label, Enterprise Command Centre, fraud upgrade, full compliance | £1M ARR + 20,000 members + first white-label |
| Enterprise | M15–24 | full 40+ agent workforce, self-healing infra, AI Governance framework, data-intelligence product, marketplace, DRC/Lingala, predictive rebooking | £10M ARR + 150,000 members + 3 white-label + DRC leader |
| Global scale | M24+ | multi-region, new GDS, regional compliance modules, knowledge-graph intelligence | category leadership |

Each phase lists required modules/APIs/user-flows/agents/milestones (cross-ref BLUEPRINT §15).

---

## 16. Competitive Advantage

Structural moats (BLUEPRINT §16): Wholesale Intelligence (12–18mo), Travel Intelligence Mesh
(18–24mo + data), Universal Console lock-in, BitriPay African rail (regulatory + first-mover), ACU
data network (compounds with GMV), white-label distribution. **Why incumbents can't match:** no
competitor combines wholesale pricing + AI intent + multi-agent mesh + Universal Console + BitriPay
+ ACU economy + diaspora rail in one OS. The OS is engineered to be **impossible to operate
without** — more personal than Trip.com, more outcome-driven than Booking.com, more trusted for
African travel than generic OTAs, more automated than agents, more execution-focused than
metasearch.

---

## 17. Production Readiness Review (gates before GA)

Architecture (frontend/backend/shared) ✅ · Tests (12/12) ✅ · Error-perimeter (no `Console
Error: {}`) ✅ · Secrets in env/Vault, none committed ✅ · CI/CD + IaC (Terraform) ○ · Observability
SLOs (P99 latency, error budget) ○ · DR/Business-continuity (multi-region, RPO/RTO) ○ · Pen-test +
PCI SAQ D ○ · Data governance + retention ○ · Load/scale test ○ · Runbooks + on-call ○.

---

*3JN TRAVEL OS — AI Infrastructure OS Architecture. Powered by Artificial Intelligence • Built for
Better Travel. CONFIDENTIAL — Proprietary & Investor-Grade — Groupe Nseya Digital / JNN Global Ltd.*
