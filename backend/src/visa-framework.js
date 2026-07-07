// 3JN VisaOS — Global Visa Intelligence Framework.
//
// One engine that knows what each country needs, builds a dynamic document
// checklist from the applicant + visa type + country, runs document verification
// and a fraud-check battery, scores risk (via visaos.js) and produces a
// decision-ready file: Approve / Refuse / Request more info / Escalate.
//
// Flow: Applicant Profile → Visa Type → Country Rules → Dynamic Checklist →
//       Document Upload → AI Verification → Risk Score → Final Review → Decision.
//
// Pure + deterministic (seeded) so the same file always yields the same result.

import { assessVisa } from './visaos.js';

function seed(str) {
  let s = 0;
  for (let i = 0; i < str.length; i++) s = (s * 31 + str.charCodeAt(i)) % 2147483647;
  return () => { s = (s * 1103515245 + 12345) % 2147483647; return s / 2147483647; };
}

// ---- 1. Universal applicant information schema ----------------------------
export const APPLICANT_FIELDS = [
  { group: 'Identity', fields: [
    { key: 'fullName', label: 'Full legal name', type: 'text', required: true },
    { key: 'previousNames', label: 'Previous names / aliases', type: 'text' },
    { key: 'dob', label: 'Date of birth', type: 'date', required: true },
    { key: 'placeOfBirth', label: 'Place of birth', type: 'text', required: true },
    { key: 'gender', label: 'Gender', type: 'select', options: ['Female', 'Male', 'Other'] },
    { key: 'nationality', label: 'Nationality', type: 'text', required: true },
    { key: 'dualNationality', label: 'Dual nationality', type: 'text' },
    { key: 'passportNumber', label: 'Passport number', type: 'text', required: true },
    { key: 'passportIssue', label: 'Passport issue date', type: 'date' },
    { key: 'passportExpiry', label: 'Passport expiry date', type: 'date', required: true },
    { key: 'passportCountry', label: 'Passport issuing country', type: 'text' },
    { key: 'nationalId', label: 'National ID number', type: 'text' },
    { key: 'maritalStatus', label: 'Marital status', type: 'select', options: ['Single', 'Married', 'Divorced', 'Widowed'] },
  ] },
  { group: 'Contact & livelihood', fields: [
    { key: 'address', label: 'Current address', type: 'text', required: true },
    { key: 'phone', label: 'Phone number', type: 'text' },
    { key: 'email', label: 'Email', type: 'text', required: true },
    { key: 'occupation', label: 'Occupation', type: 'text', required: true },
    { key: 'employer', label: 'Employer / business / school', type: 'text' },
    { key: 'monthlyIncome', label: 'Monthly income (USD)', type: 'number' },
  ] },
  { group: 'Background & history', fields: [
    { key: 'travelHistory', label: 'Travel history (last 10 years)', type: 'text' },
    { key: 'previousRefusals', label: 'Previous visa refusals', type: 'select', options: ['None', 'Yes — declared'] },
    { key: 'previousRefusalsDetails', label: 'Refusal details (country, year, reason)', type: 'text' },
    { key: 'criminalHistory', label: 'Criminal history declaration', type: 'select', options: ['None', 'Yes — declared'] },
    { key: 'criminalHistoryDetails', label: 'Criminal history details (offence, country, year)', type: 'text' },
    { key: 'overstayHistory', label: 'Immigration breach / overstay history', type: 'select', options: ['None', 'Yes — declared'] },
    { key: 'overstayDetails', label: 'Breach / overstay details (country, year)', type: 'text' },
    { key: 'familyInDestination', label: 'Family members in destination country', type: 'text' },
    { key: 'socialHandles', label: 'Social media / online identifiers (where required)', type: 'text' },
  ] },
  { group: 'Trip & sponsor', fields: [
    { key: 'purpose', label: 'Purpose of travel', type: 'select', options: ['tourism', 'business', 'study', 'work', 'family', 'medical', 'transit'] },
    { key: 'arrival', label: 'Planned arrival date', type: 'date' },
    { key: 'departure', label: 'Planned departure date', type: 'date' },
    { key: 'accommodation', label: 'Accommodation details', type: 'text' },
    { key: 'fundingSource', label: 'Funding source', type: 'select', options: ['Self', 'Employer', 'Sponsor', 'Scholarship', 'Family'] },
    { key: 'sponsorDetails', label: 'Sponsor / host details', type: 'text' },
    { key: 'emergencyContact', label: 'Emergency contact', type: 'text' },
  ] },
];

// ---- 2. Core documents required for almost every visa ---------------------
// The global default checklist. Schengen baseline honoured: signed application,
// passport no older than 10 years with 2+ blank visa pages and validity 3+
// months after leaving the zone, photo, insurance and declarations.
export const CORE_DOCUMENTS = [
  'Valid passport (≤10 years old, 6+ months validity, 2 blank pages)', 'Passport biodata page scan',
  'Passport cover page (where required)', 'Previous passports',
  'Recent biometric passport photo', 'Completed visa application form', 'Signed declaration of truth',
  'Visa fee payment receipt', 'Appointment confirmation', 'Travel itinerary', 'Return or onward ticket',
  'Hotel booking / accommodation proof', 'Travel & medical insurance', 'Bank statements (3–6 months)',
  'Proof of income', 'Employment letter', 'Recent payslips (3 months)', 'Tax returns',
  'Proof of property / assets', 'Family ties evidence',
  'Certified translations for non-accepted languages',
];

// ---- 3–9. Visa types and their additional documents -----------------------
export const VISA_TYPES = [
  { key: 'tourist', name: 'Tourist / Visitor', icon: '🏖️' },
  { key: 'business', name: 'Business', icon: '💼' },
  { key: 'student', name: 'Student', icon: '🎓' },
  { key: 'work', name: 'Work', icon: '🛠️' },
  { key: 'family', name: 'Family / Spouse / Dependant', icon: '👨‍👩‍👧' },
  { key: 'medical', name: 'Medical', icon: '🏥' },
  { key: 'transit', name: 'Transit', icon: '🛫' },
];

export const TYPE_DOCUMENTS = {
  tourist: ['Purpose of visit statement', 'Day-by-day travel plan', 'Flight reservation', 'Employment confirmation', 'Approved leave letter', 'Proof of home ties', 'Family ties evidence', 'Property ownership proof', 'Business ownership proof', 'Invitation letter (if visiting)', 'Host immigration status & proof of address', 'Host financial support letter', 'Previous visas & travel stamps'],
  business: ['Business invitation letter', 'Conference invitation', 'Trade-fair registration', 'Meeting agenda', 'Company introduction letter', 'Employer approval letter', 'Proof of employment', 'Business registration', 'Tax documents', 'Company bank statements', 'Proof of commercial relationship', 'Contracts / purchase orders', 'Event ticket / badge', 'Speaker invitation (if speaking)', 'Training invitation (if training)', 'Evidence applicant will not work illegally'],
  student: ['Admission letter', 'Confirmation of Acceptance for Studies — CAS (UK)', 'Form I-20 (US F-1 / M-1)', 'SEVIS fee receipt (US)', 'Letter of Acceptance from a Canadian DLI', 'Provincial/territorial attestation letter — PAL/TAL (Canada, where required)', 'CAQ (Quebec)', 'Tuition payment receipt', 'Proof of funds', 'Sponsor letter', 'Sponsor bank statements', 'Academic transcripts', 'Academic certificates', 'English test certificate', 'Study plan / statement of purpose', 'Accommodation proof', 'Parental consent letter (minors)', 'Birth certificate (minors)', 'Tuberculosis test certificate (where required)'],
  work: ['Job offer letter', 'Employment contract', 'Certificate of Sponsorship / work-permit approval', 'Sponsor licence number', 'Occupation code', 'Salary details', 'CV', 'Qualification certificates', 'Professional licences', 'Work experience letters', 'English language proof', 'Police clearance', 'Medical test', 'Tuberculosis test certificate (where required)', 'Proof of maintenance funds', 'Employer compliance documents', 'Labour market test evidence (where applicable)', "Dependants' documents (if accompanying)"],
  family: ['Marriage / birth / adoption certificate', 'Proof of relationship history (photos, messages, joint bills)', 'Sponsor immigration status & passport', 'Sponsor proof of address & employment', 'Sponsor payslips & bank statements', 'Accommodation suitability proof', 'Consent / custody documents for children'],
  medical: ['Medical diagnosis & referral letter', 'Hospital invitation & treatment plan', 'Cost estimate & proof of payment/deposit', 'Doctor letter', 'Proof of funds', 'Companion details', 'Return plan after treatment'],
  transit: ['Confirmed onward ticket', 'Destination-country visa', 'Transit airport & layover details', 'Proof of final-destination entry permission', 'Hotel booking (overnight transit)'],
};

// Conditional documents triggered by applicant facts.
function conditionalDocs(applicant) {
  const out = [];
  const age = ageFromDob(applicant.dob, applicant.age);
  if (age != null && age < 18) out.push('Birth certificate (minor)', 'Parental consent letter (minor)');
  if (/married/i.test(applicant.maritalStatus || '')) out.push('Marriage certificate');
  if (/divorced/i.test(applicant.maritalStatus || '')) out.push('Divorce certificate');
  if (/widow/i.test(applicant.maritalStatus || '')) out.push('Death certificate of spouse');
  if (/self|freelan|own/i.test(applicant.occupation || '')) out.push('Business registration (self-employed)', 'Tax returns (self-employed)');
  if (/student/i.test(applicant.occupation || '')) out.push('Student enrolment letter');
  // Sponsor-funded trips: the sponsor must be evidenced too.
  if (/sponsor|family|scholarship|employer/i.test(applicant.fundingSource || '')) {
    out.push('Sponsor ID / passport / residence permit', 'Sponsor bank statements', 'Proof of relationship to sponsor');
  }
  // Visiting someone (host declared): invitation + host status.
  if (!isBlank(applicant.sponsorDetails) || !isBlank(applicant.familyInDestination)) {
    out.push('Invitation letter from host');
  }
  return out;
}

// ---- 11. Country-specific high-demand modules (priority destinations) ------
export const COUNTRY_MODULES = [
  { code: 'SCHENGEN', name: 'Schengen / EU', flag: '🇪🇺', system: 'VFS / consulate', notes: 'Passport ≤10y, valid 3+ months after exit, 2 blank pages, mandatory travel insurance.', docs: ['Schengen application form', 'Travel insurance €30,000 cover'] },
  { code: 'GB', name: 'United Kingdom', flag: '🇬🇧', system: 'UKVI online', notes: '10-year travel history, employer & sponsor/payment details, family in the UK. Business visits split into document-dependent categories: business, conference, intra-corporate, training, research, paid engagements. Skilled Worker: CoS reference, English proof, job title, salary, occupation code, employer name + sponsor licence number.', docs: ['10-year travel history', 'Sponsor/payment details'] },
  { code: 'US', name: 'United States', flag: '🇺🇸', system: 'DS-160 + interview', notes: 'DS-160 confirmation, interview, social-media handles (vetting).', docs: ['DS-160 confirmation', 'MRV visa fee receipt', 'Interview appointment', 'Social-media identifiers'] },
  { code: 'CA', name: 'Canada', flag: '🇨🇦', system: 'IRCC online', notes: 'Personalised document checklist by nationality & purpose; biometrics.', docs: ['IRCC personalised checklist', 'Biometrics'] },
  { code: 'AU', name: 'Australia', flag: '🇦🇺', system: 'ImmiAccount', notes: 'Online lodgement; health & character requirements.', docs: ['Health examination', 'Character declaration'] },
  { code: 'NZ', name: 'New Zealand', flag: '🇳🇿', system: 'Immigration NZ online', notes: 'Online system with document-based checks by nationality.', docs: ['Online application'] },
  { code: 'AE', name: 'UAE / Dubai', flag: '🇦🇪', system: 'GDRFA / airline', notes: 'Passport 6+ months, photo, health insurance; ~USD 4,000 balance for long/multiple-entry tourist visas.', docs: ['Health insurance', 'Bank balance evidence (long-stay)'] },
  { code: 'SA', name: 'Saudi Arabia', flag: '🇸🇦', system: 'eVisa', notes: 'eVisa with mandatory insurance for tourism.', docs: ['Tourist insurance'] },
  { code: 'QA', name: 'Qatar', flag: '🇶🇦', system: 'Hayya / eVisa', notes: 'Passport validity & confirmed booking.', docs: ['Confirmed hotel booking'] },
  { code: 'TR', name: 'Turkey', flag: '🇹🇷', system: 'e-Visa', notes: 'e-Visa for eligible nationalities.', docs: ['e-Visa application'] },
  { code: 'CN', name: 'China', flag: '🇨🇳', system: 'Visa centre', notes: 'Invitation letter & detailed itinerary.', docs: ['Invitation letter', 'Detailed itinerary'] },
  { code: 'JP', name: 'Japan', flag: '🇯🇵', system: 'Consulate / eVisa', notes: 'Itinerary, proof of funds, guarantor where applicable.', docs: ['Daily itinerary', 'Guarantor (if applicable)'] },
  { code: 'KR', name: 'South Korea', flag: '🇰🇷', system: 'K-ETA / consulate', notes: 'K-ETA for eligible nationalities.', docs: ['K-ETA registration'] },
  { code: 'ZA', name: 'South Africa', flag: '🇿🇦', system: 'VFS / eVisa', notes: 'Yellow-fever certificate from endemic areas.', docs: ['Yellow-fever certificate (if applicable)'] },
  { code: 'IN', name: 'India', flag: '🇮🇳', system: 'e-Visa', notes: 'e-Visa with photo & passport scan.', docs: ['e-Visa application', 'Photo + passport scan upload'] },
  { code: 'BR', name: 'Brazil', flag: '🇧🇷', system: 'eVisa / consulate', notes: 'Proof of funds & accommodation.', docs: ['Proof of funds', 'Accommodation proof'] },
];

// Countries that commonly add health / police requirements.
const HEALTH_POLICE = {
  GB: ['TB test certificate (where required)'],
  AU: ['Police clearance certificate', 'Medical certificate'],
  CA: ['Police clearance certificate', 'Medical exam (where required)'],
  NZ: ['Police clearance certificate', 'Medical/chest x-ray (long stay)'],
  US: ['Medical examination (immigrant categories)'],
};

// ---- 10. Digital fraud & risk checks --------------------------------------
export const FRAUD_CHECKS = [
  ['Passport OCR & MRZ validation', 'document'], ['Passport expiry & blank-page rule', 'document'],
  ['Face match (selfie ↔ passport)', 'biometric'], ['Liveness check', 'biometric'],
  ['Photo manipulation detection', 'document'], ['Bank-statement fraud detection', 'financial'],
  ['Payslip fraud detection', 'financial'], ['Document metadata analysis', 'document'],
  ['PDF edit-history detection', 'document'], ['Name/date mismatch engine', 'identity'],
  ['Address consistency check', 'identity'], ['Employer verification', 'identity'],
  ['School verification', 'identity'], ['Hotel booking verification', 'travel'],
  ['Flight booking verification', 'travel'], ['Sponsor identity check', 'sponsor'],
  ['Previous refusal detection', 'history'], ['Watchlist screening', 'security'],
  ['Sanctions screening', 'security'], ['PEP screening', 'security'],
  ['Criminal-declaration risk scoring', 'history'], ['Overstay risk scoring', 'history'],
  ['Travel-history pattern analysis', 'behaviour'], ['Income-to-trip-cost affordability', 'financial'],
  ['Online footprint review (lawful)', 'behaviour'], ['Behavioural assessment', 'behaviour'],
  ['Device fingerprinting', 'device'], ['IP geolocation check', 'device'],
  ['VPN / proxy detection', 'device'], ['Duplicate applicant detection', 'identity'],
  ['Agent fraud-pattern detection', 'agent'], ['High-risk sponsor detection', 'sponsor'],
  ['Document reuse across applicants', 'document'], ['Payment fraud check', 'financial'],
];

const titleCase = (s) => (s || '').trim().replace(/\b\w/g, (c) => c.toUpperCase());
function ageFromDob(dob, fallback) {
  if (dob) {
    const t = Date.parse(dob);
    if (!Number.isNaN(t)) return Math.floor((Date.now() - t) / (365.25 * 24 * 3600 * 1000));
  }
  return fallback != null ? Number(fallback) : null;
}

// ---- Dynamic checklist -----------------------------------------------------
export function buildChecklist({ country, visaType = 'tourist', applicant = {} } = {}) {
  const cm = COUNTRY_MODULES.find((c) => c.code === country) || null;
  const type = VISA_TYPES.find((t) => t.key === visaType) || VISA_TYPES[0];
  const sections = [
    { title: 'Core documents (every visa)', items: dedupe(CORE_DOCUMENTS) },
    { title: `${type.name} documents`, items: dedupe(TYPE_DOCUMENTS[type.key] || []) },
  ];
  const countryItems = dedupe([...(cm?.docs || []), ...(HEALTH_POLICE[country] || [])]);
  if (countryItems.length) sections.push({ title: `${cm ? cm.name : country} specifics`, items: countryItems });
  const cond = dedupe(conditionalDocs(applicant));
  if (cond.length) sections.push({ title: 'Based on your profile', items: cond });

  const total = sections.reduce((n, s) => n + s.items.length, 0);
  return { country: cm, visaType: type, sections, totalDocuments: total };
}
function dedupe(arr) { return [...new Set(arr.filter(Boolean))]; }

// ---- Document verification (AI forensics simulation) ----------------------
export function runDocumentVerification(applicant = {}) {
  const rnd = seed(`docv|${applicant.fullName || applicant.name}|${applicant.passportNumber}`);
  const a = applicant;
  const checks = [
    { check: 'Passport OCR & MRZ', pass: a.documentsAuthentic !== false },
    { check: 'Passport expiry & blank pages', pass: a.documentsAuthentic !== false },
    { check: 'Face match + liveness', pass: a.identityDuplicate ? false : a.documentsAuthentic !== false },
    { check: 'Photo manipulation scan', pass: a.documentsAuthentic !== false },
    { check: 'Bank-statement authenticity', pass: a.fundsConsistent !== false && !a.suddenDeposit },
    { check: 'Payslip authenticity', pass: a.fundsConsistent !== false },
    { check: 'Metadata / PDF edit-history', pass: a.documentsAuthentic !== false },
    { check: 'Booking verification (flight + hotel)', pass: rnd() > 0.06 },
  ];
  const verified = checks.filter((c) => c.pass).length;
  return { checks, verified, total: checks.length, allClear: verified === checks.length };
}

// ---- Fraud-check battery ---------------------------------------------------
export function runFraudChecks(applicant = {}) {
  const a = applicant;
  const flagFor = (name, cat) => {
    let flagged = false;
    if (/sanction|watchlist|pep|security/i.test(cat)) flagged = !!a.onWatchlist || !!a.sanctioned;
    else if (/financial/i.test(cat)) flagged = a.fundsConsistent === false || !!a.suddenDeposit;
    else if (/document/i.test(cat)) flagged = a.documentsAuthentic === false;
    else if (/history/i.test(cat)) flagged = !!a.priorOverstays || a.previousRefusals === 'Yes — declared';
    else if (/identity/i.test(cat)) flagged = !!a.identityDuplicate;
    else if (/agent|sponsor/i.test(cat)) flagged = !!a.knownFraudNetwork;
    else if (/behaviour/i.test(cat)) flagged = Number(a.behaviourHesitation) > 55 || !!a.contradictions;
    if (/Income-to-trip/i.test(name)) flagged = Number(a.monthlyIncome || 2500) < 1200;
    return flagged;
  };
  const results = FRAUD_CHECKS.map(([name, category]) => ({ name, category, flagged: flagFor(name, category) }));
  const flags = results.filter((r) => r.flagged);
  return { results, flags, flagCount: flags.length, clearCount: results.length - flags.length };
}

// ---- Full assessment: decision-ready file ---------------------------------
export function assessApplication({ applicant = {}, country, visaType = 'tourist', providedDocuments = null } = {}) {
  const checklist = buildChecklist({ country, visaType, applicant });
  // Map applicant → risk-engine input (reuse the VisaOS swarm for scoring).
  const riskInput = {
    name: applicant.fullName || applicant.name,
    nationality: applicant.nationality,
    destination: applicant.destination || (checklist.country ? checklist.country.name : country),
    age: ageFromDob(applicant.dob, applicant.age),
    employer: applicant.employer,
    monthlyIncome: applicant.monthlyIncome,
    purpose: applicant.purpose || visaType,
    behaviourHesitation: applicant.behaviourHesitation,
    documentsAuthentic: applicant.documentsAuthentic,
    fundsConsistent: applicant.fundsConsistent,
    footprintMatches: applicant.footprintMatches,
    purposeCredible: applicant.purposeCredible,
    priorOverstays: applicant.priorOverstays || applicant.overstayHistory === 'Yes — declared',
    onWatchlist: applicant.onWatchlist,
    sanctioned: applicant.sanctioned,
    knownFraudNetwork: applicant.knownFraudNetwork,
    identityDuplicate: applicant.identityDuplicate,
    suddenDeposit: applicant.suddenDeposit,
    homeTies: applicant.homeTies,
  };
  const risk = assessVisa(riskInput);
  const docs = runDocumentVerification(applicant);
  const fraud = runFraudChecks(applicant);
  const applicantValidation = validateApplicant(applicant, country);
  // Only declared-but-undetailed conditionals block the decision (e.g. a
  // criminal/refusal/overstay declaration with no details, or a sponsor-funded
  // trip with no sponsor evidence). Base-profile completeness is surfaced in
  // applicantValidation for the officer but does not force a downgrade.
  const missingCritical = applicantValidation.missing.filter((k) => (FIELD_RULES[k] || {}).requiredIf);

  // Completeness: how many checklist documents were supplied.
  const required = checklist.totalDocuments;
  const supplied = Array.isArray(providedDocuments) ? providedDocuments.length : required; // demo assumes full upload
  const complete = supplied >= required;

  // Final AI officer recommendation.
  let recommendation;
  if (risk.decision === 'Auto Rejection' || fraud.flags.some((f) => /sanction|watchlist|pep/i.test(f.category))) {
    recommendation = 'Refuse';
  } else if (!complete || !docs.allClear || missingCritical.length > 0) {
    recommendation = 'Request more info';
  } else if (risk.decision === 'Human Review' || fraud.flagCount >= 3) {
    recommendation = 'Escalate to human';
  } else if (risk.decision === 'Auto Approval') {
    recommendation = 'Approve';
  } else {
    recommendation = 'Approve with conditions';
  }

  return {
    applicant: { name: riskInput.name, nationality: riskInput.nationality, destination: riskInput.destination, purpose: riskInput.purpose },
    country: checklist.country,
    visaType: checklist.visaType,
    checklist,
    documentVerification: docs,
    fraud,
    risk,
    applicantValidation,
    completeness: { required, supplied, complete },
    recommendation,
    decisionReadyMinutes: recommendation === 'Escalate to human' ? 'escalated' : 5,
  };
}

// ---- 1b. Field governance: sensitivity, per-country requirements, conditionals
//
// sensitivity drives log redaction + access control:
//   restricted   = special-category / high-harm (criminal, refusal, overstay)
//   confidential = strong PII (passport, national ID, financials, address)
//   internal     = ordinary PII (name, DOB, contact) — the default
// requiredBy    = country codes that force an otherwise-optional field
//   (UK visitor: 10-year travel history + employer; US vetting: social handles)
// requiredIf    = the field becomes mandatory when another field has a value
export const FIELD_RULES = {
  passportNumber: { sensitivity: 'confidential' },
  passportIssue: { sensitivity: 'confidential' },
  passportExpiry: { sensitivity: 'confidential' },
  passportCountry: { sensitivity: 'confidential' },
  nationalId: { sensitivity: 'confidential' },
  address: { sensitivity: 'confidential' },
  monthlyIncome: { sensitivity: 'confidential' },
  employer: { sensitivity: 'confidential', requiredBy: ['GB'] },
  travelHistory: { sensitivity: 'confidential', requiredBy: ['GB', 'US', 'CA', 'AU'] },
  familyInDestination: { sensitivity: 'confidential' },
  socialHandles: { sensitivity: 'confidential', requiredBy: ['US'] },
  sponsorDetails: { sensitivity: 'confidential', requiredIf: { field: 'fundingSource', in: ['Sponsor', 'Employer', 'Family', 'Scholarship'] } },
  accommodation: { sensitivity: 'confidential' },
  emergencyContact: { sensitivity: 'confidential' },
  previousRefusals: { sensitivity: 'restricted' },
  previousRefusalsDetails: { sensitivity: 'restricted', requiredIf: { field: 'previousRefusals', in: ['Yes — declared'] } },
  criminalHistory: { sensitivity: 'restricted' },
  criminalHistoryDetails: { sensitivity: 'restricted', requiredIf: { field: 'criminalHistory', in: ['Yes — declared'] } },
  overstayHistory: { sensitivity: 'restricted' },
  overstayDetails: { sensitivity: 'restricted', requiredIf: { field: 'overstayHistory', in: ['Yes — declared'] } },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9\s().-]{6,20}$/;
const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

function allApplicantFields() {
  return APPLICANT_FIELDS.flatMap((g) => g.fields.map((fld) => ({ ...fld, group: g.group })));
}

// The exact field keys mandatory for this applicant in this country —
// base `required` flags + country escalations + declaration conditionals.
export function requiredFieldsFor(country, applicant = {}) {
  const keys = [];
  for (const fld of allApplicantFields()) {
    const rule = FIELD_RULES[fld.key] || {};
    let required = !!fld.required;
    if (rule.requiredBy && rule.requiredBy.includes(country)) required = true;
    if (rule.requiredIf && rule.requiredIf.in.includes(String(applicant[rule.requiredIf.field] || ''))) required = true;
    if (required) keys.push(fld.key);
  }
  return keys;
}

// Validate the applicant record for a destination country. Format checks only
// run on present values; completeness counts required fields only.
export function validateApplicant(applicant = {}, country = null) {
  const errors = [];
  const required = requiredFieldsFor(country, applicant);
  const missing = required.filter((k) => isBlank(applicant[k]));
  const labels = new Map(allApplicantFields().map((fld) => [fld.key, fld.label]));
  for (const k of missing) errors.push({ field: k, message: `${labels.get(k) || k} is required.` });

  const a = applicant;
  if (!isBlank(a.email) && !EMAIL_RE.test(String(a.email).trim())) errors.push({ field: 'email', message: 'Enter a valid email address.' });
  if (!isBlank(a.phone) && !PHONE_RE.test(String(a.phone).trim())) errors.push({ field: 'phone', message: 'Enter a valid phone number.' });
  const t = (d) => { const n = Date.parse(d); return Number.isNaN(n) ? null : n; };
  const now = Date.now();
  if (!isBlank(a.dob)) {
    const d = t(a.dob);
    if (d === null) errors.push({ field: 'dob', message: 'Date of birth is not a valid date.' });
    else if (d > now) errors.push({ field: 'dob', message: 'Date of birth must be in the past.' });
  }
  if (!isBlank(a.passportExpiry)) {
    const d = t(a.passportExpiry);
    if (d === null) errors.push({ field: 'passportExpiry', message: 'Passport expiry is not a valid date.' });
    else {
      if (d < now) errors.push({ field: 'passportExpiry', message: 'Passport has expired.' });
      const iss = isBlank(a.passportIssue) ? null : t(a.passportIssue);
      if (iss !== null && iss !== undefined && iss >= d) errors.push({ field: 'passportExpiry', message: 'Passport expiry must be after its issue date.' });
    }
  }
  if (!isBlank(a.arrival) && !isBlank(a.departure)) {
    const ar = t(a.arrival); const dep = t(a.departure);
    if (ar !== null && dep !== null && dep <= ar) errors.push({ field: 'departure', message: 'Departure must be after arrival.' });
  }

  const present = required.length - missing.length;
  const completeness = required.length === 0 ? 100 : Math.round((present / required.length) * 100);
  return { country, valid: errors.length === 0, errors, missing, required, completeness };
}

// Log/analytics-safe copy: restricted values fully masked, confidential values
// truncated to a ••••-prefixed tail, internal values kept. Applications must
// never reach logs or audit summaries in the clear.
export function redactApplicant(applicant = {}) {
  const out = {};
  for (const [k, v] of Object.entries(applicant)) {
    const sens = (FIELD_RULES[k] || {}).sensitivity || 'internal';
    if (sens === 'restricted') out[k] = '‹restricted›';
    else if (sens === 'confidential') {
      out[k] = isBlank(v) ? v : `••••${String(v).replace(/\s/g, '').slice(-2)}`;
    } else out[k] = v;
  }
  return out;
}

// Metadata bundle for the UI (schema + catalogues).
export function visaFramework() {
  return {
    applicantFields: APPLICANT_FIELDS,
    fieldRules: FIELD_RULES,
    visaTypes: VISA_TYPES,
    countries: COUNTRY_MODULES,
    coreDocuments: CORE_DOCUMENTS,
    fraudChecks: FRAUD_CHECKS.map(([name, category]) => ({ name, category })),
  };
}
