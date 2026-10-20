import { formatNaira } from '../lib/money';
import { pickupWindow } from './profile';

/**
 * Customer-facing sentences the server writes itself. Kept in one place so the chat notice our server
 * pushes and the text the agent is told to send (verify_payment's message_for_customer) never drift apart.
 */

/** What happens next once a job is paid, given rider hours. */
export function afterPaymentTiming(now: number): string {
  const w = pickupWindow(now);
  return w.now ? 'A dispatcher is assigning a rider now; pickup is usually within 45 minutes.' : w.note;
}

/**
 * "Payment received: ₦1,950 for ZD-H01G4. <what happens next> The recipient gives the rider code 8960."
 * "What happens next" follows the job's status, so a notice re-sent after dispatch is still true.
 */
export function paymentReceivedMessage(job: { id: string; amount_kobo: number; handover_code: string; status?: string }, now: number): string {
  const head = `Payment received: ${formatNaira(job.amount_kobo)} for ${job.id}.`;
  if (job.status === 'delivered') return `${head} It has been delivered.`;
  if (job.status === 'dispatched') return `${head} A rider already has the package. The recipient gives the rider code ${job.handover_code}.`;
  return `${head} ${afterPaymentTiming(now)} The recipient gives the rider code ${job.handover_code}.`;
}
