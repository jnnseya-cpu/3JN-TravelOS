// 3JN Assistant — the deep, system-aware support agent.
//
// Unlike a canned chatbot, this agent has (1) deep KNOWLEDGE of how 3JN Travel OS
// works and (2) deep READ-ACCESS to the live system — the customer's bookings,
// payments, e-tickets, ACU wallet, rewards, visa rules and policies. It resolves
// the request with REAL data first, and only escalates to a human when an action
// needs human authorisation (refunds, disputes) or it genuinely cannot resolve —
// and when it escalates, it hands the human a full diagnostic so nothing is
// repeated. It runs through the AI gateway when an LLM key is present (the model
// composes from this knowledge + the resolved data) and answers deterministically
// offline. The provider is never exposed — the customer only ever sees "3JN
// Assistant".

import { classifySupport } from './chatbot.js';
import {
  getUserRaw, latestBookingForUser, bookingsForUser, findUserBookingByRef,
  acuWallet, partnerDashboard,
  operatorQuoteChange, operatorQuoteCancel, operatorConfirm, operatorHasPending,
} from './store.js';
import { visaCheck } from './intelligence.js';
import { resolveDestinationFromText } from './destinations.js';
import { parseExplicitDates } from './intent.js';

// ---- Deep system knowledge (facts the agent reasons from) ------------------
// Also serialised as grounding context for the LLM path.
export const KNOWLEDGE = {
  booking: 'We book, we issue the ticket. The customer books WITH 3JN (never on a supplier site). Pay in full → e-ticket issued now. Instalments → we HOLD the fare and issue the e-ticket automatically once the final instalment clears.',
  priceBasis: 'Live prices are real bookable fares (Duffel/Amadeus) and can take real payment. Estimated prices are indicative and NEVER charged — we only take money for a confirmed, bookable price. This is a legal-safety rule.',
  payments: 'Pay in full or in monthly instalments. Deposits and instalments are collected securely (Stripe). A held fare is issued as an e-ticket when the plan completes.',
  refunds: 'Refunds follow the fare/supplier rules on the specific booking. A human specialist authorises and processes any refund or dispute — the agent explains the exact policy first.',
  eticket: 'Every booking has a 3JN-branded e-ticket/itinerary with the airline PNR and e-ticket numbers, available in the Console and via the booking document link.',
  baggage: 'Flights show the real baggage allowance (cabin + checked) from the fare.',
  visa: 'Visa need depends on nationality + destination. Many nationalities are visa-free / visa-on-arrival (e.g. UK/US passports into the UAE). 3JN VisaOS handles applications where a visa is required.',
  priceGuard: 'After booking, the Neural Price Guard monitors the price; if it drops we rebook or refund the difference.',
  rewards: 'Every trip earns Travel ACUs. Refer & Earn pays 250 ACUs per referred paid booking; 20 paid referrals unlock 0.25% lifetime revenue share. Influencers earn up to 1% (Ambassador tier). Cap £20,000 per referred customer.',
  acu: 'ACUs (AI Credit Units) are the platform credit — earned via travel/referrals/reviews and spent on flights, hotels, transfers, insurance, eSIM, visa, and premium AI planning.',
  membership: 'Travel+ (£4.99), Travel+ Family (£12.99), Travel+ Elite (£49.99) and Travel+ Business (£99) — bigger automatic discounts and benefits; 10% of the fee funds ACUs.',
  support: 'The 3JN Assistant resolves most requests instantly and escalates to a human specialist for refunds/disputes, complaints, safety issues, or anything needing manual authorisation.',
};

// ---- Resolvers: deep read-access to the live system ------------------------
function bookingSnapshot(b) {
  if (!b) return null;
  const total = b.option?.pricing?.local?.total || 0;
  const sym = b.option?.pricing?.symbol || '£';
  const paid = (b.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const nextDue = (b.instalment?.schedule || []).find((s) => s.status !== 'paid') || null;
  return {
    id: b.id, tier: b.option?.tier, pnr: b.fulfilment?.pnr || null,
    ticketing: b.fulfilment?.ticketing || 'confirmed', ticketNumbers: b.fulfilment?.ticketNumbers || [],
    priceBasis: b.priceBasis, symbol: sym, total, paid: Math.round(paid * 100) / 100,
    fullyPaid: total > 0 && paid + 0.01 >= total,
    nextInstalment: nextDue ? { due: nextDue.due, amount: nextDue.amount } : null,
    refundPolicy: b.refundPolicy || null,
    components: (b.option?.components || []).map((c) => ({ type: c.type, supplier: c.supplier, live: !!c.live })),
  };
}

// Build the full context the agent reasons over for THIS user + message.
export function gatherContext(message, userId) {
  const user = userId ? getUserRaw(userId) : null;
  const ref = extractRef(message);
  const booking = user ? (ref && findUserBookingByRef(user.id, ref)) || latestBookingForUser(user.id) : null;
  const nationality = user?.travelProfile?.nationality || user?.country || null;
  const dest = resolveDestinationFromText(message);
  return {
    signedIn: !!user,
    name: user?.name || null,
    nationality,
    bookingCount: user ? bookingsForUser(user.id).length : 0,
    booking: bookingSnapshot(booking),
    wallet: user ? safe(() => acuWallet(user.id)) : null,
    rewards: user ? safe(() => partnerDashboard(user.id)) : null,
    destinationInMessage: dest ? { city: dest.city, country: dest.country } : null,
    visa: (dest && nationality) ? safe(() => visaCheck(nationality, dest.city)) : null,
  };
}

// ---- The agent: resolve with real data, escalate only when required --------
export function assist(message, userId) {
  const intent = classifySupport(message);
  const ctx = gatherContext(message, userId);
  const money = (n) => `${ctx.booking?.symbol || '£'}${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

  // ---- Operator actions: the assistant DOES what an operator does ----------
  // 1) A confirmation of a previously-quoted change/cancel → execute it now.
  if (ctx.booking && operatorHasPending(ctx.booking.id) && isConfirmation(message)) {
    const r = operatorConfirm(ctx.booking.id);
    if (r.ok && r.kind === 'change') {
      return mkResult(intent.key, `Done — I've ${r.summary.description}.${r.extraGbp > 0 ? ` The ${money(r.extraGbp)} change cost has been applied.` : ''}${r.hasDeferred ? ' Any airline fare difference is confirmed with the carrier at re-issue.' : ''} Your updated e-ticket is ready in your Console (🎫 View e-ticket).`, ctx, { resolved: true });
    }
    if (r.ok && r.kind === 'cancel') {
      return mkResult(intent.key, `Your booking is cancelled.${r.refundGbp > 0 ? ` A refund of ${money(r.refundGbp)} is being processed to your original payment method.` : ' This fare was non-refundable, so no refund is due.'}`, ctx, { resolved: true });
    }
    return mkResult(intent.key, 'I couldn’t complete that just now — I’m passing it to a specialist to finish safely.', ctx, { escalate: true, reason: 'operator action failed' });
  }
  // 2) A NEW change request → parse it, quote it, and ask to confirm.
  if (ctx.booking && intent.key === 'change') {
    const changes = parseChange(message);
    if (changes) {
      const q = operatorQuoteChange(ctx.booking.id, changes);
      if (q.ok) {
        const items = q.quote.lines.map((l) => `• ${l.label}: ${l.deferred ? 'confirmed at re-issue' : money(l.amountGbp)}`).join('\n');
        return mkResult('change', `I can ${q.quote.description} on booking ${ctx.booking.id}. Here's the cost:\n${items}\n**Total now: ${money(q.quote.totalExtraGbp)}${q.quote.hasDeferred ? ' + any airline fare difference' : ''}.** Reply **CONFIRM** and I'll make the change and re-issue your e-ticket.`, ctx, { resolved: true });
      }
    }
  }
  // 3) A cancellation → quote the refund and ask to confirm (operator self-serve).
  if (ctx.booking && intent.key === 'cancel') {
    const q = operatorQuoteCancel(ctx.booking.id);
    if (q.ok) {
      return mkResult('cancel', `I can cancel booking ${ctx.booking.id}. You've paid ${money(q.quote.paidGbp)}; per the fare rules ${q.quote.refundablePct}% is refundable, so you'd get back **${money(q.quote.refundGbp)}**${q.quote.nonRefundableGbp > 0 ? ` (${money(q.quote.nonRefundableGbp)} non-refundable)` : ''}. Reply **CONFIRM** to cancel, or tell me if you'd rather change the dates instead.`, ctx, { resolved: true });
    }
  }

  // Intents that ALWAYS need a human (authorised action / duty of care), but we
  // still resolve everything we can and attach it to the escalation.
  const hardEscalate = ['refund', 'complaint', 'safety', 'human'].includes(intent.key);

  let reply; let resolved = false; let escalate = hardEscalate; let reason = null; let diagnostic = null;

  switch (intent.key) {
    case 'booking_status': {
      if (!ctx.signedIn) { reply = 'Sign in and I can pull up your booking status, e-ticket and itinerary instantly. If you have a booking reference, share it and I’ll look it up.'; break; }
      if (!ctx.booking) { reply = 'I can’t see a booking on your account yet. If you have a reference from a recent booking, paste it here and I’ll check it.'; break; }
      const b = ctx.booking;
      const state = b.ticketing === 'issued' ? `ticketed ✅ (PNR ${b.pnr}${b.ticketNumbers.length ? `, e-ticket ${b.ticketNumbers.join(', ')}` : ''})`
        : b.ticketing === 'held' ? `reserved — your fare is held (PNR ${b.pnr}); the e-ticket issues automatically once your instalments complete`
        : `confirmed (ref ${b.id})`;
      const pay = b.fullyPaid ? 'Paid in full.' : b.nextInstalment ? `Next instalment: ${money(b.nextInstalment.amount)} due ${b.nextInstalment.due}.` : `Paid ${money(b.paid)} of ${money(b.total)}.`;
      reply = `Your ${b.tier} trip is ${state}. ${pay} Your documents are in your Console (🎫 View e-ticket). Anything else?`;
      resolved = true; break;
    }
    case 'payment': {
      if (!ctx.booking) { reply = KNOWLEDGE.payments + ' Sign in and I can show your exact plan and next payment.'; resolved = ctx.signedIn ? false : true; break; }
      const b = ctx.booking;
      reply = b.fullyPaid ? `Your ${b.tier} booking is paid in full — nothing more to pay.`
        : b.nextInstalment ? `You’re on an instalment plan: ${money(b.paid)} paid of ${money(b.total)}. Next payment ${money(b.nextInstalment.amount)} is due ${b.nextInstalment.due}. Your e-ticket issues automatically once the plan completes.`
        : `You’ve paid ${money(b.paid)} of ${money(b.total)} for your ${b.tier} booking.`;
      resolved = true; break;
    }
    case 'visa': {
      if (ctx.visa) {
        reply = ctx.visa.required
          ? `For ${esc(ctx.destinationInMessage.city)}, a ${ctx.nationality} passport ${ctx.visa.required ? 'needs a visa' : 'is visa-free'} — ${esc(ctx.visa.type || 'a visa/eVisa')}. 3JN VisaOS can handle the application; I can start it for you.`
          : `Good news — for ${esc(ctx.destinationInMessage.city)}, a ${ctx.nationality} passport is visa-free (${esc(ctx.visa.type || 'no visa required')}). Nothing to arrange.`;
        resolved = true;
      } else if (ctx.destinationInMessage && !ctx.nationality) {
        reply = `I can check that instantly — what nationality is your passport? (For ${esc(ctx.destinationInMessage.city)}.)`;
      } else {
        reply = 'Tell me your passport nationality and destination and I’ll confirm the visa requirement right away — many destinations are visa-free depending on your passport.';
      }
      break;
    }
    case 'rewards': {
      const r = ctx.rewards;
      if (r) {
        reply = `You’ve earned ${Math.round(r.totalAcuEarned).toLocaleString()} ACUs, referred ${r.totalReferrals} traveller${r.totalReferrals === 1 ? '' : 's'} and earned ${money(r.lifetimeEarningsGbp)} in commission. Your referral link is ${r.referralLink}. ${r.revshareUnlocked ? 'Lifetime revenue share is active! 🎉' : `${r.paidReferrals}/${r.unlockReferrals} paid referrals to unlock lifetime revenue share.`}`;
        resolved = true;
      } else { reply = KNOWLEDGE.rewards + ' Sign in to see your balance and referral link.'; resolved = !ctx.signedIn; }
      break;
    }
    case 'change': {
      reply = ctx.booking
        ? `I can start a change on your ${ctx.booking.tier} booking (ref ${ctx.booking.id}). Tell me exactly what to change — date, passenger or baggage — and I’ll check the fare rules and any price difference before anything is confirmed. A fare re-issue is completed by our travel team so it’s ticketed correctly.`
        : 'I can help change a booking — share the reference and what you’d like to change, and I’ll check the fare rules first.';
      resolved = !!ctx.booking; break;
    }
    case 'cancel': {
      const rp = ctx.booking?.refundPolicy;
      reply = ctx.booking
        ? `Here’s where your ${ctx.booking.tier} booking (ref ${ctx.booking.id}) stands for cancellation: ${rp ? summarisePolicy(rp, money) : 'refunds follow the fare/supplier rules on your booking'}. Nothing is cancelled until you confirm. Want me to pass this to a specialist to action the cancellation and any refund?`
        : 'I can help with a cancellation — share your booking reference and I’ll show the exact refund position before anything happens.';
      // A cancellation that touches money is completed by a human — offer, don't auto-do.
      break;
    }
    case 'booking_new': {
      reply = 'Let’s find you a great deal. Tell me where you’d like to go, your dates and how many travellers, and I’ll build a transparent, all-in package across verified suppliers — with the real bookable price, not just an estimate.';
      resolved = true; break;
    }
    case 'greeting': {
      const hi = ctx.name ? `Hi ${ctx.name.split(' ')[0]}!` : 'Hi there!';
      reply = `${hi} I’m the 3JN Assistant. I can check your bookings, e-tickets, payments, visas and rewards — and sort most things on the spot. What do you need?`;
      resolved = true; break;
    }
    // Hard-escalation intents — resolve context, then hand to a human.
    case 'refund':
      reason = 'Refund / payment dispute — requires human authorisation';
      reply = ctx.booking
        ? `I’m sorry about the payment issue. I’ve pulled up your ${ctx.booking.tier} booking (ref ${ctx.booking.id}, ${money(ctx.booking.paid)} paid of ${money(ctx.booking.total)}) and its refund terms, and I’m passing it to a specialist who can review the charge and process any refund securely. You won’t need to repeat yourself.`
        : 'I’m sorry about the payment issue. Because this involves your money, I’m passing it to a specialist who can review the charge and process any refund securely.';
      diagnostic = ctx.booking; break;
    case 'complaint':
      reason = 'Complaint / legal concern raised';
      reply = 'I’m really sorry you’ve had this experience — that’s not our standard. I’m escalating this to a specialist right now with the full context so a person can look into it properly and make it right.';
      diagnostic = ctx.booking; break;
    case 'safety':
      reason = 'Safety / emergency / lost-document issue';
      reply = 'That needs the right person immediately — I’m connecting you to our travel support team now. If you’re in immediate danger, please also contact local emergency services.';
      diagnostic = ctx.booking; break;
    case 'human':
      reason = 'Customer asked to speak to a person';
      reply = 'Of course — I’m connecting you with a specialist now. They’ll have your booking and this conversation, so you won’t have to repeat anything.';
      diagnostic = ctx.booking; break;
    default:
      // Unknown → try to be useful, then escalate with what we know.
      escalate = true; reason = 'Bot could not confidently resolve the request';
      reply = 'I want to make sure you get the right help — I’m passing this to a specialist who’ll follow up shortly. In the meantime, could you tell me a booking reference or a bit more detail?';
      diagnostic = ctx.booking; break;
  }

  return { intent: intent.key, reply, resolved, escalate, reason, context: ctx, diagnostic };
}

// ---- helpers --------------------------------------------------------------
// Build the standard assist() result (used by the operator-action fast paths).
function mkResult(intentKey, text, ctx, { resolved = false, escalate = false, reason = null, diagnostic = null } = {}) {
  return { intent: intentKey, reply: text, resolved, escalate, reason, context: ctx, diagnostic };
}
// Is the customer confirming a previously-quoted action?
function isConfirmation(message) {
  return /\b(confirm|confirmed|yes(\s*,?\s*(please|go ahead|proceed|do it))?|go ahead|proceed|do it|approve|accept)\b/i.test(String(message || '')) && !/\b(no|don'?t|cancel that|stop)\b/i.test(String(message || ''));
}
// Parse a change request into a structured change. Returns null if unclear.
function parseChange(message) {
  const t = String(message || '');
  // Add checked baggage.
  const bagM = t.match(/\b(?:add|extra|another|more)\b[^.]*\bbag(?:gage|s)?\b/i) || t.match(/\bbaggage\b/i);
  if (bagM) { const n = (t.match(/\b(\d+)\s*(?:bag|checked)/i) || [])[1]; return { kind: 'baggage', bags: Math.max(1, Number(n) || 1) }; }
  // Add a passenger/traveller.
  const paxM = t.match(/\b(?:add|extra|another)\b[^.]*\b(passenger|traveller|traveler|person|adult|child)\b/i);
  if (paxM) { const n = (t.match(/\b(\d+)\s*(?:passenger|traveller|traveler|person|adult|child)/i) || [])[1]; return { kind: 'passenger', passengers: Math.max(1, Number(n) || 1) }; }
  // Change the travel date.
  if (/\b(change|move|reschedul|shift|new date|different date|bring forward|push back)\b/i.test(t)) {
    const dates = safe(() => parseExplicitDates(t, new Date()));
    if (dates?.checkIn) return { kind: 'date', newDate: dates.checkIn, newReturnDate: dates.checkOut || null };
  }
  return null;
}
function extractRef(message) {
  const m = String(message || '').match(/\b((?:bkg|bk|qr)_[a-z0-9]+|[A-Z0-9]{5,7})\b/i);
  return m ? m[1] : null;
}
function summarisePolicy(rp, money) {
  if (Array.isArray(rp?.tiers) && rp.tiers.length) {
    return rp.tiers.map((t) => `${t.window || t.label}: ${t.refundPct != null ? t.refundPct + '% refundable' : (t.note || '')}`).join('; ');
  }
  if (rp?.summary) return rp.summary;
  return 'the fare/supplier rules on your booking apply';
}
function safe(fn) { try { return fn(); } catch { return null; } }
function esc(s) { return String(s == null ? '' : s); }

// Compact knowledge string for the LLM grounding path.
export function knowledgeContext() {
  return Object.entries(KNOWLEDGE).map(([k, v]) => `- ${k}: ${v}`).join('\n');
}
