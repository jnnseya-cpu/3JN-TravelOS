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
  createSupportTicket,
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
  priceGuard: 'After booking, the Neural Price Guard monitors the price; if it drops and the fare can be rebooked at the lower price, we pass the saving back to you.',
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
  const flight = (b.option?.components || []).find((c) => c.type === 'flight');
  return {
    id: b.id, tier: b.option?.tier, pnr: b.fulfilment?.pnr || null,
    ticketing: b.fulfilment?.ticketing || 'confirmed', ticketNumbers: b.fulfilment?.ticketNumbers || [],
    priceBasis: b.priceBasis, symbol: sym, total, paid: Math.round(paid * 100) / 100,
    fullyPaid: total > 0 && paid + 0.01 >= total,
    nextInstalment: nextDue ? { due: nextDue.due, amount: nextDue.amount } : null,
    refundPolicy: b.refundPolicy || null,
    departDate: flight?.details?.outbound?.date || null,
    returnDate: flight?.details?.inbound?.date || null,
    components: (b.option?.components || []).map((c) => ({ type: c.type, supplier: c.supplier, live: !!c.live })),
  };
}

// Build the full context the agent reasons over for THIS user + message.
export function gatherContext(message, userId) {
  const user = userId ? getUserRaw(userId) : null;
  const ref = extractRef(message);
  let booking = user ? ((ref && findUserBookingByRef(user.id, ref)) || null) : null;
  if (user && !booking) {
    // Mid-flow (e.g. a bare "CONFIRM" with no ref): prefer the booking that has a
    // PENDING action so the confirmation lands on the change we just quoted — even
    // if the customer has a NEWER booking that would otherwise be "latest". Without
    // this, "CONFIRM" resolved to the latest booking, missed the pending change on
    // the referenced booking, and wrongly escalated to a human.
    const pending = bookingsForUser(user.id).find((b) => operatorHasPending(b.id));
    booking = pending || latestBookingForUser(user.id);
  }
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
export function assist(message, userId, history = []) {
  const intent = classifySupport(message);
  const ctx = gatherContext(message, userId);
  const money = (n) => `${ctx.booking?.symbol || '£'}${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  // The assistant is stateless per request, so a bare follow-up ("departure")
  // would otherwise re-classify to "unknown" and escalate. Read the recent
  // transcript so a reply is understood as part of the conversation in flight.
  const topic = recentTopic(history);

  // ---- Operator actions: the assistant DOES what an operator does ----------
  // 1) A confirmation of a previously-quoted change/cancel → execute it now.
  if (ctx.booking && operatorHasPending(ctx.booking.id) && isConfirmation(message)) {
    const r = operatorConfirm(ctx.booking.id);
    if (r.ok && r.kind === 'change') {
      if (r.reissuePending) {
        // A live airline ticket — the carrier reissue is handled by our team, and
        // the fee is charged ONLY once the new ticket issues (never before).
        return mkResult(intent.key, `Done — I've requested your change: ${r.summary.description}. Our travel team is confirming the new fare with the airline and reissuing your ticket now. You'll receive the updated e-ticket by email, and the ${money(r.extraGbp)} change fee applies only once your new ticket is issued — never before.${r.hasDeferred ? ' Any airline fare difference is confirmed with the carrier at re-issue.' : ''}`, ctx, { resolved: true });
      }
      return mkResult(intent.key, `Done — your change is applied: ${r.summary.description}.${r.extraGbp > 0 ? ` The ${money(r.extraGbp)} change fee has been applied.` : ''}${r.hasDeferred ? ' Any airline fare difference is confirmed with the carrier at re-issue.' : ''} Your updated itinerary is in your Console and on its way to you by email.`, ctx, { resolved: true });
    }
    if (r.ok && r.kind === 'cancel') {
      return mkResult(intent.key, `Your booking is cancelled.${r.refundGbp > 0 ? ` A refund of ${money(r.refundGbp)} is being processed to your original payment method.` : ' This fare was non-refundable, so no refund is due.'}`, ctx, { resolved: true });
    }
    return mkResult(intent.key, 'I couldn’t complete that just now — I’m passing it to a specialist to finish safely.', ctx, { escalate: true, reason: 'operator action failed' });
  }
  // 2) A change request — a fresh "change" intent OR a follow-up to one already
  // in flight (e.g. the customer answers "departure", then "12 August"). We keep
  // the conversation going and only quote once we have something concrete.
  const followingChange = topic === 'change' && (intent.key === 'change' || intent.key === 'unknown' || !!changeSlot(message) || hasTravelDate(message));
  if (ctx.booking && (intent.key === 'change' || followingChange)) {
    // (a0) DEPARTURE-AIRPORT / re-route — a different origin airport means a whole
    // new set of flights, NOT a date shift or a simple fee. Capture it as an ops
    // re-route request (with the airports if named) and set the expectation clearly:
    // the team confirms the new-origin options + any fare difference, and nothing is
    // charged until the customer approves. (Previously "change my departure airport"
    // was misread as a date change, then dead-ended in a generic escalation.)
    if (changeSlot(message) === 'airport' || slotFromHistory(history) === 'airport') {
      const air = message.match(/from\s+([A-Za-zÀ-ÿ'’\- ]{2,30}?)\s+(?:to|into|→|-\s*>)\s+([A-Za-zÀ-ÿ'’\- ]{2,30})/i);
      // A bare place answer ("Manchester", "from Birmingham") — but NOT the intent
      // sentence itself ("change my departure airport"), so we don't log on turn 1.
      const bareM = !air && message.trim().match(/^(?:(?:i(?:['’]?d)?\s+(?:want|like|prefer)\s+)?(?:to\s+(?:fly|depart|leave)\s+)?(?:from|out of)\s+)?([A-Za-z][A-Za-zÀ-ÿ'’\- ]{1,28})$/i);
      const bare = bareM && !/\b(change|airport|departure|depart|leaving|ticket|flight|dates?|book(?:ing)?|please|help)\b/i.test(bareM[1]) ? bareM[1].trim() : null;
      if (air || bare) {
        const detail = air ? ` (from ${air[1].trim()} to ${air[2].trim()})` : ` (to ${bare})`;
        try { createSupportTicket({ userId, bookingId: ctx.booking.id, intent: 'ops-reroute', message: `Departure-airport / re-route request on booking ${ctx.booking.id}${detail}. Customer said: "${message}". Confirm the new-origin flight options and any fare difference with the customer, then reissue. Do NOT charge until the customer approves.`, reason: 'departure-airport change (re-route)' }); } catch { /* still answer the customer */ }
        return mkResult('change', `Changing your **departure airport**${detail} is a re-route — different flights, so our travel team arranges it directly with the airline to keep your ticket valid. I've logged it on booking ${ctx.booking.id} and a specialist will come back with the options and any fare difference. **Nothing is changed or charged until you approve.**`, ctx, { resolved: true });
      }
      // Named the intent but not the airport yet → ask, staying in the flow.
      return mkResult('change', `Sure — which airport would you like to **depart from** instead? Tell me the city or airport and I'll pass the re-route to our travel team; they'll confirm the flight options and any fare difference before anything is charged.`, ctx, { resolved: true });
    }
    // (a) A concrete change we can parse outright → quote it.
    let changes = parseChange(message);
    // (b) In flow, a bare date ("12 August") is the new date for the slot the
    // customer named earlier (departure by default; return if they said so).
    if (!changes) {
      const dates = safe(() => parseExplicitDates(message, new Date()));
      if (dates?.checkIn) {
        const slot = changeSlot(message) || slotFromHistory(history);
        if (slot === 'return' && ctx.booking.departDate) {
          changes = { kind: 'date', newDate: ctx.booking.departDate, newReturnDate: dates.checkIn };
        } else {
          changes = { kind: 'date', newDate: dates.checkIn, newReturnDate: dates.checkOut || null };
        }
      }
    }
    if (changes) {
      const q = operatorQuoteChange(ctx.booking.id, changes, message);
      if (q.ok) {
        const items = q.quote.lines.map((l) => `• ${l.label}: ${l.deferred ? 'confirmed at re-issue' : money(l.amountGbp)}`).join('\n');
        // For a live airline ticket the dates are confirmed with the customer by
        // the ops desk at reissue, so we ECHO the dates we understood and ask them
        // to check them — never assert a parsed date as final on a real ticket.
        const echo = changes.kind === 'date' ? `\n\nI've read your new dates as **${uk(changes.newDate)}${changes.newReturnDate ? ' → ' + uk(changes.newReturnDate) : ''}** — please check that's right before you confirm.` : '';
        return mkResult('change', `I can ${q.quote.description} on booking ${ctx.booking.id}. Here's the cost:\n${items}\n**Total now: ${money(q.quote.totalExtraGbp)}${q.quote.hasDeferred ? ' + any airline fare difference' : ''}.**${echo}\nReply **CONFIRM** and our travel team will reissue your e-ticket — the fee applies only once the new ticket is issued.`, ctx, { resolved: true });
      }
      // A change is already being reissued — don't let a second one stack a fee.
      if (q.error === 'change-in-progress') return mkResult('change', q.message, ctx, { resolved: true });
    }
    // (c) The customer named WHAT to change but not the value yet → ask for the
    // specific detail and stay in the flow. This is the case that used to
    // dead-end into an escalation ("departure" → handed to a human).
    const slot = changeSlot(message);
    if (slot) return mkResult('change', slotPrompt(slot, ctx), ctx, { resolved: true });
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
      const pay = b.fullyPaid ? 'Paid in full.' : b.nextInstalment ? `Next instalment: ${money(b.nextInstalment.amount)} due ${uk(b.nextInstalment.due)}.` : `Paid ${money(b.paid)} of ${money(b.total)}.`;
      reply = `Your ${b.tier} trip is ${state}. ${pay} Your documents are in your Console (🎫 View e-ticket). Anything else?`;
      resolved = true; break;
    }
    case 'payment': {
      if (!ctx.booking) { reply = KNOWLEDGE.payments + ' Sign in and I can show your exact plan and next payment.'; resolved = ctx.signedIn ? false : true; break; }
      const b = ctx.booking;
      reply = b.fullyPaid ? `Your ${b.tier} booking is paid in full — nothing more to pay.`
        : b.nextInstalment ? `You’re on an instalment plan: ${money(b.paid)} paid of ${money(b.total)}. Next payment ${money(b.nextInstalment.amount)} is due ${uk(b.nextInstalment.due)}. Your e-ticket issues automatically once the plan completes.`
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
// What topic is the conversation already on? Reads the last few turns so a bare
// follow-up ("departure") is understood in context instead of escalating. Turns
// are { role: 'user'|'me'|'bot'|'assistant', text }.
function recentTopic(history) {
  const turns = Array.isArray(history) ? history.slice(-6) : [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i] || {};
    const role = String(turn.role || turn.from || '').toLowerCase();
    const text = String(turn.text || turn.message || turn.content || '');
    if (!text) continue;
    if (role === 'user' || role === 'me' || role === 'customer') {
      const k = classifySupport(text).key;
      if (k === 'change' || k === 'cancel') return k;
    } else { // assistant / bot turn
      if (/\b(change|new departure|new return date|what to change|what.?s the new)\b/i.test(text)) return 'change';
      if (/\bcancel|refund position|action the cancellation\b/i.test(text)) return 'cancel';
    }
  }
  return null;
}
// Which part of a booking is the customer naming ("departure", "add a bag")?
function changeSlot(message) {
  const t = String(message || '');
  // Airport / origin re-route ("change my departure AIRPORT", "fly from a different
  // airport", "wrong airport") — checked BEFORE 'departure' so "departure airport"
  // isn't mistaken for a departure-date change. This is a re-route, not a date shift.
  if (/\bairport\b|\b(?:fly|depart|leav\w*)\s+(?:out\s+)?from\s+(?:a\s+)?(?:different|another|new|wrong)\b|\b(?:different|another|wrong)\s+airport\b/i.test(t)) return 'airport';
  if (/\b(depart(ure|ing)?|outbound|leaving|fly out|go out|onward|out ?bound)\b/i.test(t)) return 'departure';
  if (/\b(return|inbound|coming back|come back|way back|back home)\b/i.test(t)) return 'return';
  if (/\b(passenger|traveller|traveler|add (a )?(person|name|guest)|extra person)\b/i.test(t)) return 'passenger';
  if (/\b(bag|bags|baggage|luggage|suitcase|checked bag)\b/i.test(t)) return 'baggage';
  if (/\b(room|suite)\b/i.test(t)) return 'room';
  if (/\b(board|breakfast|half board|full board|all[- ]inclusive)\b/i.test(t)) return 'board';
  if (/\b(night|nights|extend (my )?(stay|trip)|stay longer)\b/i.test(t)) return 'nights';
  if (/\b(date|dates|day|when|reschedul|move it|bring forward|push back|earlier|later)\b/i.test(t)) return 'date';
  return null;
}
// The most recent slot the customer named earlier in the conversation, so a bare
// date ("12 August") lands on the right leg (departure vs return).
function slotFromHistory(history) {
  const turns = Array.isArray(history) ? history.slice(-6) : [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i] || {};
    const role = String(turn.role || turn.from || '').toLowerCase();
    if (role === 'user' || role === 'me' || role === 'customer') {
      const s = changeSlot(String(turn.text || turn.message || turn.content || ''));
      if (s) return s;
    }
  }
  return null;
}
// Ask for the specific value once the customer has named WHAT to change.
function slotPrompt(slot, ctx) {
  const ref = ctx.booking?.id;
  switch (slot) {
    case 'departure': return `Sure — what's the new **departure date**? Tell me the date (e.g. 12 August 2026) and I'll check availability and the fare difference on booking ${ref} before anything is confirmed.`;
    case 'return': return `Got it — what's the new **return date**? Give me the date and I'll price the change on booking ${ref} before you confirm.`;
    case 'date': return `Sure — what new **travel dates** would you like? Tell me the departure (and the return, if it's a round trip) and I'll check the fare difference on booking ${ref} before anything is confirmed.`;
    case 'passenger': return `Happy to add a traveller to booking ${ref}. How many extra passengers, and their full names exactly as on their passports? I'll quote the added fare before anything is confirmed.`;
    case 'baggage': return `I can add checked baggage to booking ${ref}. How many extra bags? I'll show the exact price before you confirm.`;
    case 'room': return `I can look at a room upgrade on booking ${ref}. Which room type would you like? I'll quote it before anything changes.`;
    case 'board': return `I can upgrade the board basis on booking ${ref} — half board, full board or all-inclusive. Which would you like? I'll price it first.`;
    case 'nights': return `I can extend your stay on booking ${ref}. How many extra nights? I'll quote the added cost before confirming.`;
    default: return `Tell me exactly what to change on booking ${ref} — a new departure or return date, a passenger, or baggage — and I'll check the fare rules and the price difference before anything is confirmed.`;
  }
}
// Does the message contain a concrete travel date we can act on?
function hasTravelDate(message) {
  const d = safe(() => parseExplicitDates(String(message || ''), new Date()));
  return !!d?.checkIn;
}
// Is the customer confirming a previously-quoted action?
function isConfirmation(message) {
  return /\b(confirm|confirmed|yes(\s*,?\s*(please|go ahead|proceed|do it))?|go ahead|proceed|do it|approve|accept)\b/i.test(String(message || '')) && !/\b(no|don'?t|cancel that|stop)\b/i.test(String(message || ''));
}
// Parse a change request into a structured change. Returns null if unclear.
function parseChange(message) {
  const t = String(message || '');
  // Hotel: add nights to the stay.
  const nightM = t.match(/\b(?:add|extra|more|another|extend)\b[^.]*\bnight/i);
  if (nightM) { const n = (t.match(/\b(\d+)\s*(?:extra\s*)?night/i) || [])[1]; return { kind: 'nights', nights: Math.max(1, Number(n) || 1) }; }
  // Hotel: board-basis upgrade.
  const boardM = t.match(/\b(half board|full board|all[- ]inclusive|bed (?:and|&) breakfast|breakfast included)\b/i);
  if (boardM) { const b = { 'half board': 'Half board', 'full board': 'Full board', 'all inclusive': 'All inclusive', 'all-inclusive': 'All inclusive', 'bed and breakfast': 'Bed & breakfast', 'bed & breakfast': 'Bed & breakfast', 'breakfast included': 'Bed & breakfast' }[boardM[1].toLowerCase()] || 'Half board'; return { kind: 'board', board: b }; }
  // A bare "breakfast" / "add breakfast" / "I need breakfast" is a Bed & Breakfast
  // board upgrade — the most common stay change and one the bot must handle, not escalate.
  if (/\bbreakfast\b/i.test(t)) return { kind: 'board', board: 'Bed & breakfast' };
  // Hotel: room upgrade.
  if (/\b(upgrade|better|bigger|change)\b[^.]*\broom\b|\broom\b[^.]*\bupgrade\b/i.test(t)) return { kind: 'room' };
  // Add checked baggage.
  const bagM = t.match(/\b(?:add|extra|another|more)\b[^.]*\bbag(?:gage|s)?\b/i) || t.match(/\bbaggage\b/i);
  if (bagM) { const n = (t.match(/\b(\d+)\s*(?:bag|checked)/i) || [])[1]; return { kind: 'baggage', bags: Math.max(1, Number(n) || 1) }; }
  // Add a passenger/traveller.
  const paxM = t.match(/\b(?:add|extra|another)\b[^.]*\b(passenger|traveller|traveler|person|adult|child)\b/i);
  if (paxM) { const n = (t.match(/\b(\d+)\s*(?:passenger|traveller|traveler|person|adult|child)/i) || [])[1]; return { kind: 'passenger', passengers: Math.max(1, Number(n) || 1) }; }
  // Change the travel date (moves the whole trip — flights + stay).
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
// British date format for anything the assistant says: 2026-08-03 → 03/08/2026.
function uk(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso == null ? '' : iso));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso == null ? '' : iso);
}
function esc(s) { return String(s == null ? '' : s); }

// Compact knowledge string for the LLM grounding path.
export function knowledgeContext() {
  return Object.entries(KNOWLEDGE).map(([k, v]) => `- ${k}: ${v}`).join('\n');
}
