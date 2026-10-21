import { formatNaira } from '../lib/money';
import { pickupWindow } from './profile';
import { riderById, riderLine } from './riders';

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
  job: { id: string; amount_kobo: number; handover_code: string; status?: string; rider_id?: string | null },
  now: number,
): string {
  const head = `Payment received: ${formatNaira(job.amount_kobo)} for ${job.id}.`;
  const rider = riderById(job.rider_id);
  const code = `The recipient gives the rider handover code ${job.handover_code}; please share it with them.`;
  if (job.status === 'delivered') return `${head} It has been delivered.`;
  if (job.status === 'dispatched') return `${head} ${rider ? `${riderLine(rider)} has the package.` : 'A rider already has the package.'} ${code}`;
  return `${head} ${rider ? `Your rider is ${riderLine(rider)}. ` : ''}${afterPaymentTiming(now, Boolean(rider))} ${code}`;
}
