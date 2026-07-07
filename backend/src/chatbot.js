// 3JN Travel OS — AI Support Concierge (customer chatbot).
//
// Handles customer requests conversationally and ONLY escalates to a human when
// genuinely required. It runs through the AI gateway: with an LLM key it routes
// to a model (branded as "3JN Assistant" — the provider is never exposed); with
// no key it answers deterministically so support works fully offline.
//
// Escalation policy (escalate to a human when):
//   - the customer explicitly asks for a human/agent,
//   - money is at stake in a way the bot must not action alone (refund, dispute,
//     chargeback, fraud, duplicate charge),
//   - a complaint / safety / legal / medical issue is raised,
//   - the bot cannot confidently resolve (unknown intent, repeated failures).
// Everything else — status, policy, how-to, visa/ACU/rewards info — is answered.

// Intent detection from the customer's message (keyword + phrase heuristics).
// Ordered by priority: hard-escalation intents win over informational ones.
const INTENTS = [
  { key: 'human', escalate: true, re: /\b(human|agent|person|representative|speak to (someone|a person)|real person|talk to (someone|a human))\b/i },
  { key: 'complaint', escalate: true, re: /\b(complaint|complain|terrible|awful|disgusting|unacceptable|scam|fraud|sue|lawyer|legal|ombudsman|angry|furious|worst)\b/i },
  { key: 'safety', escalate: true, re: /\b(emergency|stranded|accident|hospital|medical|injured|unsafe|danger|lost passport|stolen|robbed|embassy)\b/i },
  { key: 'refund', escalate: true, re: /\b(refund|money back|charged twice|double char(ge|d)|chargeback|dispute|didn'?t authori[sz]e|wrong amount|overcharged)\b/i },
  { key: 'cancel', escalate: false, re: /\b(cancel|cancellation|call off)\b/i },
  { key: 'change', escalate: false, re: /\b(change|amend|reschedul|move (my )?(flight|booking|date)|different date|add (a )?(passenger|bag))\b/i },
  { key: 'booking_status', escalate: false, re: /\b(where is|status|confirm(ed|ation)|e-?ticket|itinerary|my booking|booking reference|pnr|check[- ]?in)\b/i },
  { key: 'payment', escalate: false, re: /\b(pay|payment|instal?ment|deposit|card declined|how (much|do i pay)|split the cost)\b/i },
  { key: 'visa', escalate: false, re: /\b(visa|passport|eta|evisa|entry requirement|do i need a visa)\b/i },
  { key: 'rewards', escalate: false, re: /\b(acu|acus|reward|rewards|refer|refers|referral|referrals|influencer|ambassador|points|loyalty|cashback|commission|earnings)\b/i },
  { key: 'booking_new', escalate: false, re: /\b(book|quote|price|cheap|deal|holiday|flight|hotel|package|plan (a )?trip)\b/i },
  { key: 'greeting', escalate: false, re: /\b(hi|hello|hey|good (morning|afternoon|evening)|help|support)\b/i },
];

export function classifySupport(message) {
  const t = String(message || '').trim();
  if (!t) return { key: 'greeting', escalate: false };
  for (const i of INTENTS) if (i.re.test(t)) return { key: i.key, escalate: i.escalate };
  return { key: 'unknown', escalate: true }; // couldn't understand → hand to a human
}

// Deterministic, on-brand answers. `ctx` may carry the signed-in user's name and
// their latest booking so replies are specific. Returns the assistant text.
export function supportAnswer(intentKey, { name, booking } = {}) {
  const who = name ? name.split(' ')[0] : 'there';
  const ref = booking ? (booking.fulfilment?.pnr || booking.id) : null;
  switch (intentKey) {
    case 'greeting':
      return `Hi ${who}! I'm the 3JN Assistant. I can help with your bookings, payments, visas, rewards and planning a new trip. What do you need?`;
    case 'booking_status':
      return booking
        ? `Your ${booking.option?.tier || ''} trip to ${booking.option?.destination || 'your destination'} is **${booking.fulfilment?.ticketing === 'issued' ? 'ticketed' : booking.fulfilment?.ticketing === 'held' ? 'reserved (fare held)' : 'confirmed'}** — reference **${ref}**. Your documents are in your Console under Bookings. Anything specific you'd like to check?`
        : `Happy to check that. Please share your booking reference (or sign in) and I'll pull up the status, e-ticket and itinerary.`;
    case 'change':
      return `I can start a change for you — date, passenger or baggage. Tell me the booking reference and exactly what you'd like changed, and I'll check the fare rules and any difference before anything is confirmed. If it needs a manual fare re-issue, I'll pass it to our travel team.`;
    case 'cancel':
      return `I can help with a cancellation. Cancellations follow the fare/supplier rules on your booking — I'll show you any refund due before you confirm, and nothing is cancelled until you say yes. Share your booking reference to begin.`;
    case 'payment':
      return `You can pay in full or in instalments — for instalments we reserve (hold) your fare and issue the e-ticket automatically once the final payment clears. You'll only ever be charged a confirmed, bookable price. Want me to open your payment plan?`;
    case 'visa':
      return `Visa needs depend on your nationality and destination. Our Visa Centre checks this instantly and 3JN VisaOS can handle the application where one is required — and it'll tell you clearly when you're visa-free (many nationalities don't need one for popular destinations). Which passport and destination?`;
    case 'rewards':
      return `Every trip earns Travel ACUs, and our Refer & Earn programme pays 250 ACUs per referred booking — refer 20 travellers and you unlock lifetime revenue share. Creators can join the Influencer Programme for up to 1% lifetime revenue share. Want your referral link?`;
    case 'booking_new':
      return `Let's find you a great deal. Tell me where you'd like to go, your dates and how many travellers, and I'll build a transparent, all-in package across verified suppliers — you'll see the real bookable price, not just an estimate.`;
    // Escalation acknowledgements — warm, specific, then a human takes over.
    case 'refund':
      return `I'm sorry about the payment issue. Because this involves your money, I'm passing it straight to a 3JN specialist who can review the charge and sort out any refund securely. I've logged the details so you won't need to repeat yourself.`;
    case 'complaint':
      return `I'm really sorry you've had this experience — that's not the standard we hold ourselves to. I'm escalating this to a member of our team right now so a person can look into it properly and make it right.`;
    case 'safety':
      return `That sounds urgent and I want the right person on it immediately. I'm connecting you to our travel support team now. If you're in immediate danger, please also contact local emergency services.`;
    case 'human':
      return `Of course — I'm connecting you with a member of our team now. They'll have your details and pick up right where we left off.`;
    default:
      return `I want to make sure you get the right help, so I'm passing this to a member of our team who'll follow up shortly.`;
  }
}

// Decide the full response for a message. Pure/deterministic; the server wires
// escalation into a support ticket. Returns { intent, reply, escalate, reason }.
export function supportRespond(message, ctx = {}) {
  const intent = classifySupport(message);
  const reply = supportAnswer(intent.key, ctx);
  let reason = null;
  if (intent.escalate) {
    reason = ({
      human: 'Customer asked to speak to a person',
      complaint: 'Complaint / legal concern raised',
      safety: 'Safety / emergency / lost-document issue',
      refund: 'Refund / payment dispute — requires human authorisation',
      unknown: 'Bot could not confidently understand the request',
    })[intent.key] || 'Requires human assistance';
  }
  return { intent: intent.key, reply, escalate: intent.escalate, reason };
}

export const SUPPORT_TASK = 'support_chat';
