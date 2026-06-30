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
    { key: 'criminalHistory', label: 'Criminal history declaration', type: 'select', options: ['None', 'Yes — declared'] },
    { key: 'overstayHistory', label: 'Immigration breach / overstay history', type: 'select', options: ['None', 'Yes — declared'] },
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
export const CORE_DOCUMENTS = [
  'Valid passport (6+ months, 2 blank pages)', 'Passport biodata page scan', 'Previous passports',
  'Recent biometric passport photo', 'Completed visa application form', 'Signed declaration of truth',
  'Visa fee payment receipt', 'Appointment confirmation', 'Travel itinerary', 'Return or onward ticket',
  'Hotel / accommodation proof', 'Travel & medical insurance', 'Bank statements (3–6 months)',
  'Proof of income', 'Employment letter', 'Proof of home ties / assets',
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
  tourist: ['Purpose of visit statement', 'Day-by-day travel plan', 'Approved leave letter', 'Proof of family/property ties', 'Invitation letter (if visiting)', 'Host immigration status & proof of address'],
  business: ['Business invitation letter', 'Conference / trade-fair registration', 'Meeting agenda', 'Company introduction letter', 'Employer approval letter', 'Business registration', 'Proof of commercial relationship', 'Evidence applicant will not work illegally'],
  student: ['Admission / acceptance letter (CAS / I-20 / LOA)', 'SEVIS / provincial attestation (PAL/TAL/CAQ) where required', 'Tuition payment receipt', 'Proof of funds', 'Academic transcripts & certificates', 'English-test certificate', 'Study plan / statement of purpose', 'Parental consent + birth certificate (minors)'],
  work: ['Job offer & employment contract', 'Certificate of Sponsorship / work-permit approval', 'Sponsor licence number & occupation code', 'CV & qualification certificates', 'Professional licences', 'Work-experience letters', 'English-language proof', 'Police clearance', 'Proof of maintenance funds'],
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
  if (/self|freelan|own/i.test(applicant.occupation || '')) out.push('Business registration (self-employed)', 'Tax returns');
  return out;
}

// ---- 11. Country-specific high-demand modules (priority destinations) ------
export const COUNTRY_MODULES = [
  { code: 'SCHENGEN', name: 'Schengen / EU', flag: '🇪🇺', system: 'VFS / consulate', notes: 'Passport ≤10y, valid 3+ months after exit, 2 blank pages, mandatory travel insurance.', docs: ['Schengen application form', 'Travel insurance €30,000 cover'] },
  { code: 'GB', name: 'United Kingdom', flag: '🇬🇧', system: 'UKVI online', notes: '10-year travel history, employer & sponsor/payment details, family in the UK.', docs: ['10-year travel history', 'Sponsor/payment details'] },
  { code: 'US', name: 'United States', flag: '🇺🇸', system: 'DS-160 + interview', notes: 'DS-160 confirmation, interview, social-media handles (vetting).', docs: ['DS-160 confirmation', 'Interview appointment', 'Social-media identifiers'] },
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

  // Completeness: how many checklist documents were supplied.
  const required = checklist.totalDocuments;
  const supplied = Array.isArray(providedDocuments) ? providedDocuments.length : required; // demo assumes full upload
  const complete = supplied >= required;

  // Final AI officer recommendation.
  let recommendation;
  if (risk.decision === 'Auto Rejection' || fraud.flags.some((f) => /sanction|watchlist|pep/i.test(f.category))) {
    recommendation = 'Refuse';
  } else if (!complete || !docs.allClear) {
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
    completeness: { required, supplied, complete },
    recommendation,
    decisionReadyMinutes: recommendation === 'Escalate to human' ? 'escalated' : 5,
  };
}

// Metadata bundle for the UI (schema + catalogues).
export function visaFramework() {
  return {
    applicantFields: APPLICANT_FIELDS,
    visaTypes: VISA_TYPES,
    countries: COUNTRY_MODULES,
    coreDocuments: CORE_DOCUMENTS,
    fraudChecks: FRAUD_CHECKS.map(([name, category]) => ({ name, category })),
  };
}
