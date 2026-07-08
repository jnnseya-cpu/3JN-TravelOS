// Embassy Governance Layer — how a government CONTROLS VisaOS.
//
// The AI (visaos.js) scores and PROPOSES; the embassy GOVERNS. Each embassy
// configures:
//   - decision CRITERIA (score thresholds the AI proposal is banded against),
//   - BRANDING (embassy name, seal, colours, letterhead) + letter LANGUAGE,
//   - visa FEES per visa type (the price of an application),
//   - REFUSAL REASON templates and APPROVAL CONDITION templates officers pick
//     from when confirming or overriding the AI's proposal.
// Officers then review each application against the AI's proposal and issue a
// decision with reasons/conditions; the applicant receives an embassy-branded
// decision letter in the embassy's language.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ---- Default configuration (used until an embassy customises its own) ------
export const DEFAULT_EMBASSY_CONFIG = {
  country: 'DEFAULT',
  embassyName: 'Embassy — Visa Section',
  branding: {
    seal: '🛂',
    primaryColor: '#0f1830',
    accentColor: '#c9a24b',
    letterhead: ['Visa Section', 'Issued via 3JN VisaOS'],
  },
  language: 'en', // decision-letter language
  // CRITERIA: the AI risk score (0–600, higher = riskier) is banded against
  // these thresholds to produce the PROPOSAL the officer sees.
  criteria: {
    autoApproveMaxScore: 220,  // ≤ this → AI proposes APPROVE
    humanReviewMinScore: 221,  // between → AI proposes HUMAN REVIEW
    autoRejectMinScore: 451,   // ≥ this → AI proposes REFUSE
    securityRiskMax: 60,       // any security risk above this forces HUMAN REVIEW
    requireDocsComplete: true, // missing documents force MORE INFO
  },
  // FEES: the price of a visa application, set by the embassy per visa type.
  fees: {
    tourist: { amountGBP: 95, processingDays: 5 },
    business: { amountGBP: 150, processingDays: 4 },
    student: { amountGBP: 120, processingDays: 10 },
    transit: { amountGBP: 45, processingDays: 2 },
    medical: { amountGBP: 80, processingDays: 3 },
  },
  refusalReasons: [
    'Insufficient evidence of funds for the intended stay',
    'Travel history and profile indicate elevated overstay risk',
    'Purpose of visit could not be verified from the documents provided',
    'Documents provided appear incomplete or inconsistent',
    'Security screening returned an unresolved concern',
  ],
  approvalConditions: [
    'Single entry · validity 30 days from date of issue',
    'Multiple entry · validity 90 days from date of issue',
    'No recourse to public funds',
    'Employment is not permitted under this visa',
    'Medical/travel insurance must be held for the full stay',
    'Registration with local authorities within 7 days of arrival',
  ],
};

// Merge a saved config over the defaults (deep for known sections).
export function resolveEmbassyConfig(saved) {
  const d = DEFAULT_EMBASSY_CONFIG;
  if (!saved) return { ...d };
  return {
    ...d, ...saved,
    branding: { ...d.branding, ...(saved.branding || {}) },
    criteria: { ...d.criteria, ...(saved.criteria || {}) },
    fees: { ...d.fees, ...(saved.fees || {}) },
    refusalReasons: saved.refusalReasons?.length ? saved.refusalReasons : d.refusalReasons,
    approvalConditions: saved.approvalConditions?.length ? saved.approvalConditions : d.approvalConditions,
  };
}

// ---- The AI proposal, banded by THIS embassy's criteria --------------------
// app: a stored visa application (has totalScore, risk.security, band, files).
export function embassyProposal(app, config) {
  const c = resolveEmbassyConfig(config).criteria;
  const score = Number(app?.totalScore) || 0;
  const security = Number(app?.risk?.security) || 0;
  const docsMissing = c.requireDocsComplete && Array.isArray(app?.missingDocuments) && app.missingDocuments.length > 0;
  let proposal; let why;
  if (docsMissing) { proposal = 'More info requested'; why = `Required documents missing (${app.missingDocuments.length}) — embassy criteria require a complete file.`; }
  else if (security > c.securityRiskMax) { proposal = 'Escalated'; why = `Security risk ${security} exceeds the embassy ceiling of ${c.securityRiskMax} — human review required.`; }
  else if (score >= c.autoRejectMinScore) { proposal = 'Refused'; why = `Risk score ${score} ≥ refusal threshold ${c.autoRejectMinScore}.`; }
  else if (score <= c.autoApproveMaxScore) { proposal = 'Approved'; why = `Risk score ${score} ≤ auto-approve threshold ${c.autoApproveMaxScore}.`; }
  else { proposal = 'Escalated'; why = `Risk score ${score} falls in the human-review band (${c.humanReviewMinScore}–${c.autoRejectMinScore - 1}).`; }
  return { proposal, why, score, security, criteria: c };
}

// ---- Branded decision letter ------------------------------------------------
// Small label i18n so an embassy can issue letters in its own language.
const LETTER_I18N = {
  en: { decision: 'Decision', application: 'Application', applicant: 'Applicant', nationality: 'Nationality', destination: 'Destination', visaType: 'Visa type', fee: 'Visa fee', reasons: 'Reasons', conditions: 'Visa conditions', approved: 'VISA APPROVED', refused: 'VISA REFUSED', moreinfo: 'FURTHER INFORMATION REQUIRED', escalated: 'UNDER EXTENDED REVIEW', issued: 'Issued', officer: 'Authorised officer', footer: 'This decision was reviewed and issued by an authorised officer. AI screening via 3JN VisaOS.' },
  fr: { decision: 'Décision', application: 'Demande', applicant: 'Demandeur', nationality: 'Nationalité', destination: 'Destination', visaType: 'Type de visa', fee: 'Frais de visa', reasons: 'Motifs', conditions: 'Conditions du visa', approved: 'VISA ACCORDÉ', refused: 'VISA REFUSÉ', moreinfo: 'INFORMATIONS COMPLÉMENTAIRES REQUISES', escalated: 'EXAMEN APPROFONDI EN COURS', issued: 'Émis le', officer: 'Agent autorisé', footer: 'Cette décision a été examinée et délivrée par un agent autorisé. Contrôle IA via 3JN VisaOS.' },
  ar: { decision: 'القرار', application: 'الطلب', applicant: 'مقدم الطلب', nationality: 'الجنسية', destination: 'الوجهة', visaType: 'نوع التأشيرة', fee: 'رسوم التأشيرة', reasons: 'الأسباب', conditions: 'شروط التأشيرة', approved: 'تمت الموافقة على التأشيرة', refused: 'رُفضت التأشيرة', moreinfo: 'مطلوب معلومات إضافية', escalated: 'قيد المراجعة الموسعة', issued: 'تاريخ الإصدار', officer: 'الموظف المخوّل', footer: 'تمت مراجعة هذا القرار وإصداره من قبل موظف مخوّل. الفحص الذكي عبر 3JN VisaOS.' },
  es: { decision: 'Decisión', application: 'Solicitud', applicant: 'Solicitante', nationality: 'Nacionalidad', destination: 'Destino', visaType: 'Tipo de visado', fee: 'Tasa de visado', reasons: 'Motivos', conditions: 'Condiciones del visado', approved: 'VISADO CONCEDIDO', refused: 'VISADO DENEGADO', moreinfo: 'SE REQUIERE INFORMACIÓN ADICIONAL', escalated: 'EN REVISIÓN AMPLIADA', issued: 'Emitido', officer: 'Funcionario autorizado', footer: 'Esta decisión fue revisada y emitida por un funcionario autorizado. Cribado de IA vía 3JN VisaOS.' },
};

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

export function visaDecisionLetter(app, config) {
  const cfg = resolveEmbassyConfig(config);
  const t = LETTER_I18N[cfg.language] || LETTER_I18N.en;
  const rtl = cfg.language === 'ar';
  const dec = app.embassyDecision || {};
  const headline = dec.decision === 'Approved' ? t.approved
    : dec.decision === 'Refused' ? t.refused
    : dec.decision === 'More info requested' ? t.moreinfo : t.escalated;
  const color = dec.decision === 'Approved' ? '#1e7a4b' : dec.decision === 'Refused' ? '#a33030' : cfg.branding.accentColor;
  const visaType = app.applicant?.visaType || app.visaType || 'tourist';
  const fee = cfg.fees[String(visaType).toLowerCase()] || cfg.fees.tourist;
  const conditions = dec.conditions || [];
  const reasons = dec.reason ? [dec.reason] : [];
  return `<!doctype html><html lang="${cfg.language}" dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(cfg.embassyName)} — ${esc(t.decision)} ${esc(app.id)}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; color: #1b2333; background: #eef0f4; margin: 0; }
  .doc { max-width: 760px; margin: 26px auto; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 8px 30px rgba(0,0,0,.14); }
  .hd { background: ${cfg.branding.primaryColor}; color: #fff; padding: 26px 32px; }
  .seal { font-size: 34px; } .emb { font-size: 20px; font-weight: 700; letter-spacing: .4px; }
  .lh { font-size: 11.5px; opacity: .8; margin-top: 4px; }
  .verdict { margin: 26px 32px 6px; padding: 12px 18px; border: 2px solid ${color}; color: ${color}; font-weight: 700; letter-spacing: 1.2px; display: inline-block; }
  .body { padding: 10px 32px 26px; font-size: 14.5px; line-height: 1.55; }
  table { border-collapse: collapse; margin: 12px 0; } td { padding: 5px 14px 5px 0; vertical-align: top; }
  td.k { color: #6b7590; font-size: 12px; text-transform: uppercase; letter-spacing: .6px; }
  h4 { margin: 18px 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: .8px; color: ${cfg.branding.accentColor}; }
  ul { margin: 4px 0; padding-${rtl ? 'right' : 'left'}: 20px; } li { margin: 4px 0; }
  .ft { padding: 16px 32px; border-top: 1px solid #e3e7ef; font-size: 11px; color: #6b7590; }
  .sig { margin-top: 22px; } .sig b { display: block; font-size: 13px; }
  @media print { body { background: #fff; } .doc { box-shadow: none; margin: 0; } }
</style></head><body><div class="doc">
  <div class="hd"><span class="seal">${esc(cfg.branding.seal)}</span>
    <div class="emb">${esc(cfg.embassyName)}</div>
    <div class="lh">${cfg.branding.letterhead.map(esc).join(' · ')}</div>
  </div>
  <div class="verdict">${esc(headline)}</div>
  <div class="body">
    <table>
      <tr><td class="k">${esc(t.application)}</td><td><strong>${esc(app.id)}</strong></td></tr>
      <tr><td class="k">${esc(t.applicant)}</td><td>${esc(app.applicant?.name || '')}</td></tr>
      <tr><td class="k">${esc(t.nationality)}</td><td>${esc(app.applicant?.nationality || '')}</td></tr>
      <tr><td class="k">${esc(t.destination)}</td><td>${esc(app.applicant?.destination || app.country || '')}</td></tr>
      <tr><td class="k">${esc(t.visaType)}</td><td>${esc(visaType)}</td></tr>
      <tr><td class="k">${esc(t.fee)}</td><td>£${round2(fee.amountGBP)} · ${fee.processingDays}d</td></tr>
      <tr><td class="k">${esc(t.issued)}</td><td>${esc((dec.at || '').slice(0, 10))}</td></tr>
    </table>
    ${reasons.length ? `<h4>${esc(t.reasons)}</h4><ul>${reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    ${conditions.length ? `<h4>${esc(t.conditions)}</h4><ul>${conditions.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
    <div class="sig">${esc(t.officer)}<b>${esc(dec.officerId || 'embassy')}</b></div>
  </div>
  <div class="ft">${esc(t.footer)} · ${esc(dec.auditBlock?.hash ? 'Audit ' + String(dec.auditBlock.hash).slice(0, 16) + '…' : '')}</div>
</div></body></html>`;
}
