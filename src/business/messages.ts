import { formatNaira } from '../lib/money';
import { localDisplay } from '../lib/phone';
import { pickupWindow } from './profile';
import { riderById, riderLine, riderPhone } from './riders';

/**
 * Customer-facing sentences the server writes itself. Kept in one place so the chat notice our server
 * pushes and the text the agent is told to send (verify_payment's message_for_customer) never drift apart.
 */

/** What happens next once a job is paid, given rider hours. */
export function afterPaymentTiming(now: number, riderAssigned = false): string {
  const w = pickupWindow(now);
  if (!w.now) return w.note;
  return riderAssigned ? 'Pickup is usually within 45 minutes.' : 'A dispatcher is assigning a rider now; pickup is usually within 45 minutes.';
}

/**
 * The confirmation after payment: amount, job, who is coming, when, and (only now) the handover code.
 * "What happens next" follows the job's status, so a notice re-sent after dispatch is still true.
 */
export function paymentReceivedMessage(
  job: { id: string; amount_kobo: number; handover_code: string; status?: string; rider_id?: string | null; recipient_name?: string },
  now: number,
  /** Our /t/… link (src/business/trackLink.ts): always the rider's live position. */
  track?: string,
): string {
  // Short blocks with blank lines between them: it is read on a phone. Names, not roles, where we have them.
  const head = `Payment received: ${formatNaira(job.amount_kobo)} for ${job.id}. Thank you!`;
  const rider = riderById(job.rider_id);
  const code = handoverLines(job, rider);
  if (job.status === 'delivered') return `${head}\n\nIt has been delivered.`;
  const live = rider && track ? `\nTrack ${riderFirst(rider)} live: ${track}` : '';
  if (job.status === 'dispatched') {
    return [head, rider ? `${riderLine(rider)} has the package.\n${riderFirst(rider)} (rider): ${riderPhone(rider)}${live}` : 'A rider already has the package.', code].join('\n\n');
  }
  const coming = rider
    ? `${pickupWindow(now).now ? `${riderLine(rider)} is on the way to the pickup now.` : `Your rider is ${riderLine(rider)}.`} ${afterPaymentTiming(now, true)}\n${riderFirst(rider)} (rider): ${riderPhone(rider)}${live}`
    : afterPaymentTiming(now, false);
  return [head, coming, code].join('\n\n');
}

const riderFirst = (r: { name: string }) => r.name.split(' ')[0]!;

/** "Handover code: 5277 / Share it with Anthony (recipient); Tunde (rider) will ask for it at drop-off." */
function handoverLines(job: { handover_code: string; recipient_name?: string }, rider: { name: string } | null): string {
  const to = job.recipient_name?.trim() ? `${firstName(job.recipient_name)} (recipient)` : 'the recipient';
  return `Handover code: ${job.handover_code}\nShare it with ${to}; ${rider ? `${riderFirst(rider)} (rider)` : 'the rider'} will ask for it at drop-off.`;
}

/**
 * When the customer already saw our "Payment received" notice and then asks: confirm briefly, with the
 * rider and the code again, without repeating the whole notice.
 */
export function paidFollowUp(job: { id: string; handover_code: string; status?: string; rider_id?: string | null; recipient_name?: string }, now: number, track?: string): string {
  if (job.status === 'delivered') return `Yes, ${job.id} is paid and it has been delivered.`;
  const rider = riderById(job.rider_id);
  const who = job.status === 'dispatched'
    ? `${rider ? riderLine(rider) : 'The rider'} has the package and is on the way to the drop-off.`
    : rider ? (pickupWindow(now).now ? `${riderLine(rider)} is on the way to the pickup now.` : `${riderLine(rider)} will collect it. ${pickupWindow(now).note}`) : afterPaymentTiming(now, false);
  const live = rider && track ? `\nTrack ${riderFirst(rider)} live: ${track}` : '';
  return [`Yes, your payment is confirmed. ${who}${rider ? `\n${riderFirst(rider)} (rider): ${riderPhone(rider)}${live}` : ''}`, handoverLines(job, rider)].join('\n\n');
}

/** "bola ahmed" → "Bola Ahmed", for addressing people in messages (stored names keep the customer's spelling). */
export function displayName(name: string): string {
  return name.trim().split(/\s+/).map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(' ');
}
export const firstName = (name: string) => displayName(name).split(' ')[0] ?? '';

/** Sent right after create_dispatch_job: reserved, the amount, and the one question that comes next. */
export function reservedMessage(job: { id: string; sender_name: string; recipient_name: string; recipient_phone?: string; amount_kobo: number }): string {
  const hi = firstName(job.sender_name);
  // The number is read back so a typo is caught before the rider calls a stranger.
  const on = job.recipient_phone?.startsWith('+234') ? ` (${localDisplay(job.recipient_phone)})` : '';
  return `Great${hi ? `, ${hi}` : ''}! Your delivery to ${displayName(job.recipient_name)}${on} is reserved as ${job.id} (${formatNaira(job.amount_kobo)}). It's confirmed as soon as payment comes in.\n\nHow would you like to pay: a payment link (card, transfer or USSD), or a bank transfer to an account number?`;
}

export function linkMessage(amountKobo: number, url: string): string {
  return `Here's your payment link for ${formatNaira(amountKobo)}. You can pay by card, bank transfer or USSD:\n${url}\n\nOnce you've paid, just reply "paid" and I'll confirm it.`;
}

/** "13:34" → "1:34 PM" (anything else is left as it is). */
export function twelveHour(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return hhmm;
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

export function transferMessage(p: { amount_kobo: number; bank: string; account_number: string; account_name: string; expires: string }): string {
  return [
    `Here are the transfer details for ${formatNaira(p.amount_kobo)}:`,
    `Bank: ${p.bank}`,
    `Account number: ${p.account_number}`,
    `Account name: ${p.account_name}`,
    `Amount: exactly ${formatNaira(p.amount_kobo)}`,
    '',
    `This account is only for this delivery and expires at ${twelveHour(p.expires)}. Please send the exact amount, then reply "sent" and I'll confirm it.`,
  ].join('\n');
}
