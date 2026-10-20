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

/** "Payment received: ₦1,950 for ZD-H01G4. <timing> The recipient gives the rider code 8960." */
export function paymentReceivedMessage(job: { id: string; amount_kobo: number; handover_code: string }, now: number): string {
  return `Payment received: ${formatNaira(job.amount_kobo)} for ${job.id}. ${afterPaymentTiming(now)} The recipient gives the rider code ${job.handover_code}.`;
}
