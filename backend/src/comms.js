// 3JN Travel OS — Communication Event Architecture.
//
// ONE event engine: 177 catalogue events across 15 categories fan out over five
// channels (email · in-app · sms · push · whatsapp). Mandatory notices bypass
// user opt-outs. Email sends through the existing mailer (live when SMTP/Resend
// keys are set, sandbox-logged otherwise); the in-app channel writes to the
// existing notification feed; sms/push/whatsapp are provider-gated and recorded
// in sandbox until their keys are configured — so every flow is always testable.

import { recordCommsDelivery, listCommsDeliveries, pushNotification } from './store.js';
import { isMailerEnabled, sendMail } from './mailer.js';

const BRAND = '3JN Travel OS';

// Channel codes used in the compact catalogue. E=email I=in-app S=sms P=push W=whatsapp
export const CHANNELS = ['email', 'inapp', 'sms', 'push', 'whatsapp'];
const CODE = { E: 'email', I: 'inapp', S: 'sms', P: 'push', W: 'whatsapp' };
const sub = (s) => s.replace(/VERYX/g, BRAND);
// ev(key, name, subject, severity, channelCodes, mandatory)
const ev = (key, name, subject, severity, chans, mandatory = false) => ({
  key, name, subject: sub(subject), severity,
  channels: chans.split('').map((c) => CODE[c]).filter(Boolean),
  mandatory: !!mandatory,
});

export const CATEGORIES = [
  ['Identity & Account', [
    ev('account.registration.requested', 'Account requested', 'Welcome to VERYX — confirm your account', 'info', 'EI'),
    ev('account.registration.received', 'Registration received', 'We received your registration', 'info', 'EI'),
    ev('account.email_verification_required', 'Email verification required', 'Verify your email address', 'warning', 'EI'),
    ev('account.mobile_verification_required', 'Mobile verification required', 'Verify your mobile number', 'warning', 'EIS'),
    ev('account.verification.successful', 'Verification successful', 'Your account is verified', 'success', 'EI'),
    ev('account.verification.failed', 'Verification failed', 'Verification could not be completed', 'warning', 'EI'),
    ev('account.verification.expired', 'Verification expired', 'Your verification link expired', 'warning', 'EI'),
    ev('account.registration.abandoned', 'Registration abandoned', 'Finish setting up your VERYX account', 'info', 'EI'),
    ev('enterprise.request.received', 'Enterprise request received', 'Your enterprise application was received', 'info', 'EI'),
    ev('enterprise.verification.started', 'Enterprise verification started', 'Verification of {{enterprise}} has started', 'info', 'EI'),
    ev('enterprise.documents.requested', 'Documents requested', 'Documents needed to verify {{enterprise}}', 'warning', 'EI'),
    ev('enterprise.documents.received', 'Documents received', 'We received your documents', 'info', 'EI'),
    ev('enterprise.documents.approved', 'Documents approved', 'Your documents were approved', 'success', 'EI'),
    ev('enterprise.documents.rejected', 'Documents rejected', 'Documents need attention', 'warning', 'EI'),
    ev('enterprise.activated', 'Enterprise activated', '{{enterprise}} is now live on VERYX', 'success', 'EIP'),
    ev('invitation.sent', 'User invited', '{{actor}} invited you to {{enterprise}} on VERYX', 'info', 'EI'),
    ev('invitation.reminder', 'Invitation reminder', 'Reminder: your invitation to {{enterprise}}', 'info', 'EI'),
    ev('invitation.accepted', 'Invitation accepted', '{{name}} accepted your invitation', 'success', 'I'),
    ev('invitation.declined', 'Invitation declined', '{{name}} declined the invitation', 'info', 'I'),
    ev('invitation.expired', 'Invitation expired', 'Your invitation has expired', 'info', 'EI'),
  ]],
  ['Login & Security', [
    ev('auth.login.success', 'Successful login', 'New sign-in to your VERYX account', 'info', 'I'),
    ev('auth.login.failed', 'Failed login', 'Failed sign-in attempt', 'warning', 'I'),
    ev('auth.login.suspicious', 'Suspicious login', 'Unusual sign-in detected', 'critical', 'EIS', true),
    ev('auth.device.new', 'New device detected', 'New device signed in', 'warning', 'EI', true),
    ev('auth.device.approved', 'Device approved', 'Device approved', 'success', 'I'),
    ev('auth.device.rejected', 'Device rejected', 'Device rejected', 'warning', 'EI'),
    ev('password.forgot', 'Forgot password', 'Reset your VERYX password', 'info', 'EI'),
    ev('password.reset_link', 'Password reset link', 'Your password reset link', 'info', 'EI'),
    ev('password.reset.successful', 'Password reset successful', 'Your password was reset', 'success', 'EIS', true),
    ev('password.changed', 'Password changed', 'Your password was changed', 'success', 'EI', true),
    ev('password.expiry_warning', 'Password expiry warning', 'Your password expires soon', 'warning', 'EI'),
    ev('mfa.otp_code', 'OTP code', 'Your VERYX verification code', 'info', 'EIS'),
    ev('mfa.enabled', 'MFA enabled', 'Two-factor authentication enabled', 'success', 'EI', true),
    ev('mfa.disabled', 'MFA disabled', 'Two-factor authentication disabled', 'warning', 'EIS', true),
    ev('mfa.backup_code_generated', 'Backup codes generated', 'New MFA backup codes generated', 'info', 'EI'),
    ev('security.alert', 'Security alert', 'Security alert on your account', 'critical', 'EIS', true),
    ev('account.locked', 'Account locked', 'Your account has been locked', 'critical', 'EIS', true),
    ev('account.unlocked', 'Account unlocked', 'Your account is unlocked', 'success', 'EI'),
    ev('security.too_many_attempts', 'Too many attempts', 'Too many attempts', 'warning', 'I'),
    ev('session.revoked', 'Session revoked', 'A session was signed out', 'warning', 'EI', true),
  ]],
  ['Subscription & Billing', [
    ev('subscription.trial_started', 'Trial started', 'Your VERYX trial has started', 'success', 'EI'),
    ev('subscription.trial_ending', 'Trial ending', 'Your trial ends in 3 days', 'warning', 'EI'),
    ev('subscription.trial_expired', 'Trial expired', 'Your trial has ended', 'warning', 'EI'),
    ev('subscription.activated', 'Subscription activated', 'Your {{plan}} subscription is active', 'success', 'EI'),
    ev('subscription.renewed', 'Subscription renewed', 'Your subscription renewed', 'info', 'EI'),
    ev('subscription.cancelled', 'Subscription cancelled', 'Your subscription was cancelled', 'warning', 'EI'),
    ev('subscription.reactivated', 'Subscription reactivated', 'Your subscription is reactivated', 'success', 'EI'),
    ev('payment.pending', 'Payment pending', 'Payment is processing', 'info', 'I'),
    ev('payment.successful', 'Payment successful', 'Payment received — {{amount}}', 'success', 'EI'),
    ev('payment.failed', 'Payment failed', 'Your payment failed', 'warning', 'EIS', true),
    ev('payment.retry', 'Payment retry', 'We’ll retry your payment', 'info', 'EI'),
    ev('payment.card_expiring', 'Card expiring', 'Your card expires soon', 'warning', 'EI'),
    ev('payment.card_expired', 'Card expired', 'Your card has expired', 'warning', 'EI'),
    ev('payment.refund_processed', 'Refund processed', 'Your refund was processed', 'success', 'EI'),
    ev('invoice.generated', 'Invoice generated', 'Invoice {{number}} is ready', 'info', 'EI'),
    ev('invoice.overdue', 'Invoice overdue', 'Invoice {{number}} is overdue', 'warning', 'EIS', true),
    ev('invoice.reminder', 'Invoice reminder', 'Reminder: invoice {{number}} due {{date}}', 'info', 'EI'),
    ev('invoice.paid', 'Invoice paid', 'Invoice {{number}} paid', 'success', 'EI'),
    ev('invoice.credit_note_issued', 'Credit note issued', 'Credit note issued', 'info', 'EI'),
  ]],
  ['User Management', [
    ev('user.created', 'User created', 'New user added', 'info', 'I'),
    ev('user.activated', 'User activated', 'Your account is active', 'success', 'EI'),
    ev('user.suspended', 'User suspended', 'Your account has been suspended', 'warning', 'EI', true),
    ev('user.reactivated', 'User reactivated', 'Your account is reactivated', 'success', 'EI'),
    ev('user.removed', 'User removed', 'Your access has been removed', 'warning', 'EI', true),
    ev('role.assigned', 'Role assigned', 'Your role was updated', 'info', 'EI'),
    ev('role.removed', 'Role removed', 'A role was removed', 'info', 'I'),
    ev('permission.changed', 'Permission changed', 'Your permissions changed', 'info', 'I'),
    ev('team.member_added', 'Added to team', 'You were added to {{item}}', 'info', 'IP'),
    ev('team.member_removed', 'Removed from team', 'You were removed from {{item}}', 'info', 'I'),
    ev('team.ownership_changed', 'Team ownership changed', 'Team ownership changed', 'info', 'EI'),
  ]],
  ['Approvals', [
    ev('approval.requested', 'Approval requested', 'Approval needed: {{item}}', 'warning', 'EIP'),
    ev('approval.reminder', 'Approval reminder', 'Reminder: approval pending for {{item}}', 'warning', 'EIP'),
    ev('approval.escalated', 'Approval escalated', 'Escalated approval: {{item}}', 'warning', 'EIP'),
    ev('approval.approved', 'Approved', '{{item}} was approved', 'success', 'EIP'),
    ev('approval.rejected', 'Rejected', '{{item}} was rejected', 'warning', 'EIP'),
    ev('approval.returned', 'Returned for amendment', '{{item}} returned for changes', 'warning', 'EIP'),
    ev('approval.sla_breach', 'SLA breach', 'SLA breach: {{item}} approval overdue', 'critical', 'EIS', true),
    ev('approval.escalated_manager', 'Escalated to manager', 'Approval escalated to manager', 'warning', 'EIP'),
    ev('approval.escalated_executive', 'Escalated to executive', 'Approval escalated to executive', 'critical', 'EIS', true),
  ]],
  ['Trip & Project Management', [
    ev('project.created', 'Project created', 'Project created: {{project}}', 'info', 'I'),
    ev('project.archived', 'Project archived', 'Project archived: {{project}}', 'info', 'I'),
    ev('project.completed', 'Project completed', 'Project completed: {{project}}', 'success', 'EI'),
    ev('project.cancelled', 'Project cancelled', 'Project cancelled: {{project}}', 'warning', 'EI'),
    ev('milestone.due', 'Milestone due', 'Milestone due: {{item}}', 'info', 'IP'),
    ev('milestone.overdue', 'Milestone overdue', 'Milestone overdue: {{item}}', 'warning', 'EIP'),
    ev('milestone.achieved', 'Milestone achieved', 'Milestone achieved: {{item}}', 'success', 'I'),
    ev('task.assigned', 'Task assigned', 'Task assigned: {{task}}', 'info', 'IP'),
    ev('task.accepted', 'Task accepted', 'Task accepted', 'info', 'I'),
    ev('task.rejected', 'Task rejected', 'Task rejected', 'warning', 'I'),
    ev('task.completed', 'Task completed', 'Task completed: {{task}}', 'success', 'I'),
    ev('task.overdue', 'Task overdue', 'Task overdue: {{task}}', 'warning', 'IP'),
    ev('risk.identified', 'Risk identified', 'New risk on {{project}}', 'warning', 'EI'),
    ev('risk.escalated', 'Risk escalated', 'Risk escalated: {{item}}', 'critical', 'EIS', true),
    ev('risk.resolved', 'Risk resolved', 'Risk resolved: {{item}}', 'success', 'I'),
  ]],
  ['Product & Delivery', [
    ev('product.created', 'Product created', 'Product created: {{item}}', 'info', 'I'),
    ev('product.approved', 'Product approved', 'Product approved: {{item}}', 'success', 'EI'),
    ev('product.archived', 'Product archived', 'Product archived: {{item}}', 'info', 'I'),
    ev('roadmap.updated', 'Roadmap updated', 'Roadmap updated', 'info', 'I'),
    ev('roadmap.approved', 'Roadmap approved', 'Roadmap approved', 'success', 'EI'),
    ev('story.created', 'Story created', 'Story created: {{item}}', 'info', 'I'),
    ev('story.assigned', 'Story assigned', 'Story assigned: {{item}}', 'info', 'IP'),
    ev('story.approved', 'Story approved', 'Story approved: {{item}}', 'success', 'I'),
    ev('release.planned', 'Release planned', 'Release planned: {{item}}', 'info', 'EI'),
    ev('release.approved', 'Release approved', 'Release approved: {{item}}', 'success', 'EI'),
    ev('release.deployed', 'Release deployed', 'Release deployed: {{item}}', 'success', 'EIP'),
  ]],
  ['Procurement & Contracts', [
    ev('procurement.rfq_issued', 'RFQ issued', 'RFQ issued: {{item}}', 'info', 'EI'),
    ev('procurement.bid_received', 'Bid received', 'Bid received for {{item}}', 'info', 'I'),
    ev('procurement.bid_accepted', 'Bid accepted', 'Your bid was accepted', 'success', 'EI'),
    ev('procurement.bid_rejected', 'Bid rejected', 'Bid outcome for {{item}}', 'info', 'EI'),
    ev('contract.created', 'Contract created', 'Contract created: {{item}}', 'info', 'I'),
    ev('contract.pending_signature', 'Contract pending signature', 'Signature needed: {{item}}', 'warning', 'EIP'),
    ev('contract.signed', 'Contract signed', 'Contract signed: {{item}}', 'success', 'EI'),
    ev('contract.expiring', 'Contract expiring', 'Contract expiring: {{item}}', 'warning', 'EI'),
    ev('contract.renewed', 'Contract renewed', 'Contract renewed: {{item}}', 'success', 'EI'),
  ]],
  ['Document & Compliance', [
    ev('document.uploaded', 'Document uploaded', 'Document uploaded: {{item}}', 'info', 'I'),
    ev('document.approved', 'Document approved', 'Document approved: {{item}}', 'success', 'EI'),
    ev('document.rejected', 'Document rejected', 'Document rejected: {{item}}', 'warning', 'EI'),
    ev('document.expiring', 'Document expiring', 'Document expiring: {{item}}', 'warning', 'EI'),
    ev('document.archived', 'Document archived', 'Document archived: {{item}}', 'info', 'I'),
    ev('compliance.document_required', 'Compliance document required', 'Compliance document required', 'warning', 'EIS', true),
    ev('compliance.breach', 'Compliance breach', 'Compliance breach detected', 'critical', 'EIS', true),
    ev('compliance.resolved', 'Compliance resolved', 'Compliance issue resolved', 'success', 'EI'),
  ]],
  ['AI Agent', [
    ev('ai.insight_generated', 'Insight generated', 'New insight from {{actor}}', 'info', 'IP'),
    ev('ai.recommendation_available', 'Recommendation available', 'A recommendation is ready', 'info', 'IP'),
    ev('ai.opportunity_identified', 'Opportunity identified', 'Opportunity identified', 'success', 'EI'),
    ev('ai.risk_detected', 'Risk detected', 'AI risk alert', 'warning', 'EIP'),
    ev('ai.budget_risk', 'Budget risk', 'AI budget alert', 'warning', 'EIP'),
    ev('ai.schedule_risk', 'Schedule risk', 'AI schedule alert', 'warning', 'EIP'),
    ev('ai.resource_conflict', 'Resource conflict', 'AI resource alert', 'warning', 'EIP'),
    ev('ai.supplier_issue', 'Supplier issue', 'AI supplier alert', 'warning', 'EIP'),
    ev('ai.workflow_completed', 'Workflow completed', 'Workflow completed', 'success', 'I'),
    ev('ai.workflow_failed', 'Workflow failed', 'Workflow failed', 'warning', 'EIP'),
    ev('ai.human_intervention_required', 'Human intervention required', 'Action needed: {{item}}', 'critical', 'EIP', true),
  ]],
  ['Reporting & BI', [
    ev('report.generated', 'Report generated', 'Report ready: {{item}}', 'info', 'I'),
    ev('report.scheduled_ready', 'Scheduled report ready', 'Your scheduled report is ready', 'info', 'EI'),
    ev('report.export_completed', 'Export completed', 'Your export is ready', 'success', 'EI'),
    ev('kpi.threshold_breached', 'KPI threshold breached', 'KPI alert: {{item}}', 'warning', 'EIP'),
    ev('kpi.recovered', 'KPI recovered', 'KPI recovered: {{item}}', 'success', 'I'),
    ev('executive.alert', 'Executive alert', 'Executive alert', 'critical', 'EIS', true),
  ]],
  ['Support & Success', [
    ev('support.ticket_created', 'Ticket created', 'Support ticket {{number}} created', 'info', 'EI'),
    ev('support.ticket_assigned', 'Ticket assigned', 'Ticket {{number}} assigned', 'info', 'I'),
    ev('support.ticket_updated', 'Ticket updated', 'Update on ticket {{number}}', 'info', 'EI'),
    ev('support.ticket_resolved', 'Ticket resolved', 'Ticket {{number}} resolved', 'success', 'EI'),
    ev('support.ticket_closed', 'Ticket closed', 'Ticket {{number}} closed', 'info', 'I'),
    ev('cs.onboarding_started', 'Onboarding started', 'Welcome — let’s get you set up', 'info', 'EI'),
    ev('cs.onboarding_completed', 'Onboarding completed', 'You’re all set up', 'success', 'EI'),
    ev('cs.health_score_warning', 'Health score warning', 'Let’s check in on {{enterprise}}', 'warning', 'EI'),
    ev('cs.renewal_reminder', 'Renewal reminder', 'Your renewal is coming up', 'info', 'EI'),
  ]],
  ['Platform Administration', [
    ev('system.maintenance_scheduled', 'Scheduled maintenance', 'Scheduled maintenance on {{date}}', 'info', 'EI'),
    ev('system.maintenance_emergency', 'Emergency maintenance', 'Emergency maintenance in progress', 'warning', 'EIS', true),
    ev('system.outage', 'System outage', 'Service disruption', 'critical', 'EIS', true),
    ev('system.service_restored', 'Service restored', 'Service restored', 'success', 'EI'),
    ev('audit.completed', 'Audit completed', 'Audit completed', 'info', 'I'),
    ev('audit.policy_violation', 'Policy violation', 'Policy violation detected', 'critical', 'EIS', true),
    ev('audit.investigation_opened', 'Investigation opened', 'Investigation opened', 'warning', 'EI', true),
  ]],
  ['Legal & Privacy', [
    ev('privacy.consent_request', 'Consent request', 'We need your consent', 'info', 'EI', true),
    ev('privacy.consent_updated', 'Consent updated', 'Your consent preferences were updated', 'info', 'EI'),
    ev('privacy.data_export_ready', 'Data export ready', 'Your data export is ready', 'success', 'EI'),
    ev('privacy.account_deletion_requested', 'Account deletion requested', 'Account deletion requested', 'warning', 'EI', true),
    ev('privacy.account_deletion_completed', 'Account deletion completed', 'Your account has been deleted', 'info', 'EI', true),
    ev('regulatory.update', 'Regulatory update', 'Regulatory update', 'info', 'EI'),
    ev('compliance.notification', 'Compliance notification', 'Compliance notification', 'info', 'EI'),
  ]],
  ['Enterprise Onboarding', [
    ev('onboarding.enterprise_application_received', 'Enterprise application received', 'Application received for {{enterprise}}', 'info', 'EI'),
    ev('onboarding.enterprise_approved', 'Enterprise approved', '{{enterprise}} approved', 'success', 'EI'),
    ev('onboarding.enterprise_rejected', 'Enterprise rejected', 'Update on {{enterprise}}’s application', 'warning', 'EI'),
    ev('onboarding.enterprise_activated', 'Enterprise activated', '{{enterprise}} is live', 'success', 'EIP'),
    ev('onboarding.admin_invitation', 'Admin invitation', 'You’re the administrator for {{enterprise}}', 'info', 'EI'),
    ev('onboarding.admin_accepted', 'Admin accepted', 'Administrator activated', 'success', 'I'),
    ev('onboarding.admin_first_login', 'Admin first login', 'Administrator first sign-in', 'info', 'I'),
    ev('onboarding.department_created', 'Department created', 'Department created: {{item}}', 'info', 'I'),
    ev('onboarding.department_approved', 'Department approved', 'Department approved: {{item}}', 'success', 'I'),
    ev('onboarding.user_invited', 'User invited', 'Join {{enterprise}} on VERYX', 'info', 'EI'),
    ev('onboarding.user_activated', 'User activated', 'User activated', 'success', 'I'),
    ev('onboarding.user_completed', 'User completed onboarding', 'Onboarding complete', 'success', 'I'),
    ev('onboarding.training_assigned', 'Training assigned', 'Training assigned: {{item}}', 'info', 'EI'),
    ev('onboarding.training_completed', 'Training completed', 'Training completed: {{item}}', 'success', 'I'),
    ev('onboarding.certification_achieved', 'Certification achieved', 'Certification achieved: {{item}}', 'success', 'EI'),
  ]],
];

// Flatten to a lookup.
export const EVENTS = {};
for (const [cat, events] of CATEGORIES) for (const e of events) EVENTS[e.key] = { ...e, category: cat };

// Brands whose logo + colour appear on outbound email (the preview selector).
export const COMPANIES = [
  { id: '3jn', name: '3JN Travel OS', color: '#d8b46a', logo: '/logo.png' },
  { id: 'groupe-nseya', name: 'Groupe Nseya', color: '#2f7fe0', logo: '/logo.png' },
];

// Which channels can deliver live right now (provider keys present)? Email rides
// the existing mailer; the rest are gated on their provider env keys.
function channelLive(channel) {
  if (channel === 'email') return isMailerEnabled();
  if (channel === 'inapp') return true; // always available (in-app feed)
  if (channel === 'sms') return !!process.env.SMS_PROVIDER_KEY;
  if (channel === 'push') return !!process.env.PUSH_PROVIDER_KEY;
  if (channel === 'whatsapp') return !!process.env.WHATSAPP_PROVIDER_KEY;
  return false;
}

const fill = (str, vars = {}) => (str || '').replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : `{{${k}}}`));

// Fire an event: fan out across its channels (mandatory events ignore opt-outs).
export function emit(eventKey, { userId, recipient, vars = {}, optOuts = [] } = {}) {
  const e = EVENTS[eventKey];
  if (!e) return { ok: false, error: 'unknown-event' };
  const subject = fill(e.subject, vars);
  const deliveries = [];
  for (const channel of e.channels) {
    // Mandatory notices bypass user opt-outs.
    if (!e.mandatory && optOuts.includes(channel)) continue;
    const live = channelLive(channel);
    let status = live ? 'sent' : 'logged';
    let provider = { email: live ? (process.env.RESEND_API_KEY ? 'resend' : 'smtp') : 'sandbox', inapp: 'in-app', sms: live ? 'sms' : 'sandbox', push: live ? 'push' : 'sandbox', whatsapp: live ? 'whatsapp' : 'sandbox' }[channel];
    if (channel === 'inapp' && userId) {
      pushNotification(userId, { type: e.severity === 'critical' ? 'warning' : e.severity, icon: severityIcon(e.severity), title: e.name, body: subject });
      status = 'sent';
    }
    if (channel === 'email' && live && recipient) {
      sendMail({ to: recipient, subject, html: renderEmail(eventKey, { vars }).html, text: subject }).catch(() => {});
    }
    deliveries.push(recordCommsDelivery({ event: eventKey, name: e.name, channel, recipient: recipient || (userId || 'me'), status, provider, severity: e.severity }));
  }
  return { ok: true, event: eventKey, subject, deliveries };
}

function severityIcon(sev) { return { info: 'ℹ️', success: '✅', warning: '⚠️', critical: '🚨' }[sev] || 'ℹ️'; }

// Branded HTML email preview — the selected company's logo, colour and details.
export function renderEmail(eventKey, { company, vars = {} } = {}) {
  const e = EVENTS[eventKey] || { name: 'Notification', subject: '', severity: 'info' };
  const co = COMPANIES.find((c) => c.id === company) || COMPANIES[0];
  const subject = fill(e.subject, vars);
  const html = `<!doctype html><html><body style="margin:0;background:#0a1020;font-family:Inter,Arial,sans-serif;color:#eef2fb">
    <div style="max-width:560px;margin:0 auto;background:#0f1830;border:1px solid rgba(255,255,255,0.1);border-radius:14px;overflow:hidden">
      <div style="background:${co.color};padding:18px 24px;display:flex;align-items:center;gap:10px">
        <img src="${co.logo}" alt="${co.name}" width="34" height="34" style="border-radius:8px;display:block"/>
        <strong style="color:#1a1304;font-size:16px">${co.name}</strong>
      </div>
      <div style="padding:28px 24px">
        <div style="font-size:12px;letter-spacing:0.15em;text-transform:uppercase;color:${co.color}">${e.severity}</div>
        <h1 style="font-size:22px;margin:8px 0 12px">${subject}</h1>
        <p style="color:#9aa6c4;font-size:14px;line-height:1.6">${e.name} — this is the branded message a recipient receives from ${co.name} on 3JN Travel OS.</p>
        <a href="https://3jntravel.com" style="display:inline-block;margin-top:14px;background:${co.color};color:#1a1304;padding:11px 18px;border-radius:9px;font-weight:700;text-decoration:none">Open 3JN Travel OS</a>
      </div>
      <div style="padding:16px 24px;border-top:1px solid rgba(255,255,255,0.08);color:#6b7799;font-size:11px">
        ${co.name} · event <code>${eventKey}</code> · You receive this because of your account activity.
      </div>
    </div></body></html>`;
  return { subject, html, company: co };
}

// Architecture stats + channel coverage for the admin dashboard.
export function architecture() {
  const all = Object.values(EVENTS);
  const channelCoverage = {};
  for (const ch of CHANNELS) channelCoverage[ch] = all.filter((e) => e.channels.includes(ch)).length;
  const deliveries = listCommsDeliveries(0);
  const sentByChannel = {};
  for (const ch of CHANNELS) sentByChannel[ch] = deliveries.filter((d) => d.channel === ch && d.status === 'sent').length;
  return {
    totalEvents: all.length,
    categories: CATEGORIES.length,
    mandatory: all.filter((e) => e.mandatory).length,
    channels: CHANNELS,
    channelsWired: CHANNELS.length,
    channelCoverage,
    sentByChannel,
    deliveredCount: deliveries.filter((d) => d.status === 'sent').length,
    attemptedCount: deliveries.length,
    companies: COMPANIES,
    recent: listCommsDeliveries(12),
    catalogue: CATEGORIES.map(([name, events]) => ({ name, count: events.length, events })),
  };
}
