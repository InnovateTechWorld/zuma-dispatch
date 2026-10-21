import { z } from 'zod';
import { defineTool } from '../mcp/tooling';
import { cancelJob as cancelJobHandler, createDispatchJob as createJobHandler, getJobStatus as getJobStatusHandler } from './jobs';
import { createPaymentLink as createLinkHandler, verifyPayment as verifyHandler } from './payments';
import { quoteDelivery as quoteHandler } from './quoteDelivery';
import { resolveAddress as resolveHandler } from './resolveAddress';
import { handToTeam as handToTeamHandler } from './handover';

/*
 * Tool surface for the Zuma Dispatch teammate.
 *
 * Design rules (see docs/ARCHITECTURE.md):
 *  - The model passes ids of rows this server created (place -> quote -> job). It never
 *    passes coordinates, prices or amounts, so it cannot invent or alter them.
 *  - Every error carries a stable code and a `what_to_do` hint written for the agent.
 *  - Calls that create things are idempotent, so a retried call is safe.
 */

const placeId = z.string().min(3).max(20).describe('A place_id returned by resolve_address, e.g. "P-7K3QP2MX".');
const quoteId = z.string().min(3).max(20).describe('A quote_id returned by quote_delivery, e.g. "Q-4HX9T2KD".');
const jobId = z
  .string()
  .min(3)
  .max(20)
  .describe('A job id returned by create_dispatch_job, e.g. "ZD-7K3QP". Customers may type it in lower case or without the hyphen; that is fine.');

export const resolveAddress = defineTool({
  name: 'resolve_address',
  title: 'Resolve an address',
  description: [
    'Turn what the customer typed into a confirmed location. Call this once for the pickup and once for the drop-off, before quoting.',
    'Accepts landmarks ("opposite Shoprite, Jabi Lake Mall"), street addresses, area names, and NIPOST postcodes (e.g. "FC-02-A09-DB-09"); pass the customer\'s words unchanged.',
    'We deliver within Abuja (the whole FCT) and within Lagos State; both addresses must be in the same state. Each result names the state.',
    'Pass state ("abuja" or "lagos") once you know it (from the customer, or from the first confirmed address) so the other address is looked up there.',
    'Returns status: "confirmed" (read the label back and get a yes), "ambiguous" (show the candidates and let the customer pick), "needs_detail" (too vague, e.g. just "Lagos" or a postcode alone: ask for a street or landmark), "not_found" (ask for a nearby landmark), or "out_of_area" (outside both states).',
    'Never describe a location the tool did not return, and never pass coordinates anywhere.',
  ].join(' '),
  inputSchema: {
    text: z.string().min(2).max(300).describe('The address exactly as the customer wrote it.'),
    role: z.enum(['pickup', 'dropoff']).describe('Whether this is where the package is collected or delivered.'),
    state: z
      .enum(['abuja', 'lagos'])
      .optional()
      .describe('Which state the delivery is in, once known. Omit if you do not know yet.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: resolveHandler,
});

export const quoteDelivery = defineTool({
  name: 'quote_delivery',
  title: 'Quote a delivery',
  description: [
    'Price a delivery between two confirmed places. The price comes only from this tool: never state, estimate or adjust a price yourself.',
    'Returns a quote_id, the total in naira, a short breakdown and how long the quote is valid.',
    'If approximate is true, tell the customer the distance is estimated. If the quote has expired, call this again.',
  ].join(' '),
  inputSchema: {
    pickup_place_id: placeId,
    dropoff_place_id: placeId,
    package_size: z
      .enum(['small', 'medium', 'large'])
      .describe('small: fits in a backpack (documents, phone, food pack). medium: shoebox to carton up to 10 kg. large: up to 25 kg, needs a car.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  handler: quoteHandler,
});

export const createDispatchJob = defineTool({
  name: 'create_dispatch_job',
  title: 'Book the delivery',
  description: [
    'Create the delivery job from a quote. Only call this after you have read the price and both addresses back and the customer has clearly said yes.',
    'Safe to retry: calling it again with the same quote_id returns the same job instead of a duplicate.',
    'Returns the job id, the amount due and a handover code the sender should share with the recipient.',
  ].join(' '),
  inputSchema: {
    quote_id: quoteId,
    sender_name: z.string().min(2).max(80).describe('Name of the person sending the package.'),
    recipient_name: z.string().min(2).max(80).describe('Name of the person receiving the package.'),
    recipient_phone: z
      .string()
      .min(3)
      .max(20)
      .describe('Recipient phone number as given, e.g. "0803 123 4567" or "+2348031234567". The server checks and normalises it.'),
    package_note: z.string().max(200).optional().describe('Optional: what is in the package or handling notes ("fragile", "keep upright").'),
    customer_confirmed: z
      .literal(true)
      .describe('Must be true. Set it only after the customer explicitly agreed to the price and addresses you read back.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  fieldHints: {
    customer_confirmed:
      'Do not book yet. Send the quote (pickup, drop-off, package size, price) ending with its closing_question, and call again only after the customer clearly says yes.',
  },
  handler: createJobHandler,
});

export const createPaymentLink = defineTool({
  name: 'create_payment_link',
  title: 'Get payment details',
  description: [
    'Get payment details for a booked job. The amount is taken from the job; you never pass it.',
    'method "link" (default): a Paystack checkout link that opens inside WhatsApp and accepts card, bank transfer and USSD.',
    'method "bank_transfer": a bank name, account number and exact amount the customer sends from their banking app; the account is for this job only and expires in 30 minutes. Use it when the customer prefers to transfer, cannot open links, or asks for an account number.',
    'Safe to call again: open details are returned, not replaced. Ask the customer to reply once they have paid, then call verify_payment.',
  ].join(' '),
  inputSchema: {
    job_id: jobId,
    method: z
      .enum(['link', 'bank_transfer'])
      .optional()
      .describe('"link" (default) or "bank_transfer" (account number + bank + exact amount to send).'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: createLinkHandler,
});

export const verifyPayment = defineTool({
  name: 'verify_payment',
  title: 'Check payment',
  description: [
    'Ask Paystack whether the customer has paid for a job. Call this when the customer says they have paid, or asks.',
    'Only say a job is paid when this tool returns payment_status "paid". A customer saying "I have paid" or sending a screenshot is not proof.',
    'Returns payment_status: "paid", "not_paid_yet", "awaiting_transfer" (bank transfer not received yet), "in_progress", "failed", "not_paid" (job cancelled, nothing taken) or "needs_review", with what to tell the customer.',
  ].join(' '),
  inputSchema: { job_id: jobId },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: verifyHandler,
});

export const getJobStatus = defineTool({
  name: 'get_job_status',
  title: 'Look up a job',
  description: [
    'Read the current status of a delivery, as set by the dispatcher: awaiting_payment, paid, dispatched, delivered, cancelled, payment_failed or amount_mismatch. Use it when the customer asks where their delivery is.',
    'Pass job_id if you have it (from Customer Memory or earlier messages). Otherwise pass recipient_phone and sender_name together; the customer does not need to remember the job id.',
  ].join(' '),
  inputSchema: {
    job_id: jobId.optional(),
    recipient_phone: z.string().min(3).max(20).optional().describe("Recipient's phone as the customer gives it. Use with sender_name when there is no job id."),
    sender_name: z.string().min(2).max(80).optional().describe("Sender's name (first name is enough). Use with recipient_phone when there is no job id."),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: getJobStatusHandler,
});

export const cancelJob = defineTool({
  name: 'cancel_job',
  title: 'Cancel an unpaid job',
  description: [
    'Cancel a job the customer no longer wants. Only works before payment (status awaiting_payment or payment_failed); it first checks Paystack so a payment that just landed is not lost.',
    'For paid jobs, do not cancel: hand the conversation to a human dispatcher, who handles refunds.',
  ].join(' '),
  inputSchema: {
    job_id: jobId,
    reason: z.string().min(2).max(200).describe('Short reason in the customer\'s words, e.g. "changed my mind".'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  handler: cancelJobHandler,
});

export const handToTeam = defineTool({
  name: 'hand_to_team',
  title: 'Hand the customer to a person',
  description: [
    'Pass the conversation to a human dispatcher (refunds, cancelling a paid job, complaints, out-of-scope requests, a customer who asks for a person).',
    'Use this instead of the built-in handover tool: it returns the line to send the customer, and a person takes over right after your reply.',
    'If it returns an error, use the built-in handover tool.',
  ].join(' '),
  inputSchema: {
    reason: z.string().min(3).max(280).describe('Why a person is needed, with the job id if there is one, e.g. "refund for paid job ZD-QFJ5F".'),
    customer_message: z.string().min(1).max(500).describe("The customer's latest message, word for word (used to find this conversation)."),
    job_id: jobId.optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: handToTeamHandler,
});

export const ALL_TOOLS = [
  resolveAddress,
  quoteDelivery,
  createDispatchJob,
  createPaymentLink,
  verifyPayment,
  getJobStatus,
  cancelJob,
  handToTeam,
] as const;
