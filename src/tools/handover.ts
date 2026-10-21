import { findHandoverThread, handoverConfig, handToTeamMessage, takeOverAfterReply } from '../chord/handover';
import { cleanText } from '../lib/text';
import { ToolError, type ToolContext } from '../mcp/tooling';

export interface HandToTeamArgs { reason: string; customer_message: string; job_id?: string | undefined }

const FALLBACK = 'Use your built-in human handover tool instead, with the same reason.';

export async function handToTeam(args: HandToTeamArgs, ctx: ToolContext): Promise<Record<string, unknown>> {
  const reason = cleanText(args.reason, 280);
  if (reason.length < 3) throw new ToolError('INVALID_ARGUMENTS', 'A short reason is needed.', 'Say in a few words why a person is needed (e.g. "refund for paid job ZD-QFJ5F"), then call again.');
  const conf = handoverConfig(ctx.env, ctx.publicOrigin);
  if ('error' in conf) {
    throw new ToolError('HANDOVER_UNAVAILABLE', conf.error === 'local_server' ? 'A local test server does not take over real conversations.' : 'The team inbox is not connected (CHORD_API_KEY).', FALLBACK);
  }
  const now = ctx.now();
  const timeoutMs = Math.min(Number(ctx.env.PROVIDER_TIMEOUT_MS) || 4000, 6000);
  const found = await findHandoverThread(conf.cfg, { customer_message: args.customer_message, job_id: args.job_id ?? null }, now, timeoutMs);
  if (!found.ok) {
    throw new ToolError('HANDOVER_UNAVAILABLE', `Could not find this conversation (${found.reason}).`, FALLBACK);
  }
  ctx.trace.push(`hand_to_team:${found.threadId}`);
  ctx.waitUntil(takeOverAfterReply(conf.cfg, found.threadId, reason, now, timeoutMs));
  return {
    handed_over: true,
    message_for_customer: handToTeamMessage(now),
    what_to_do: 'Reply with message_for_customer as your whole message, then stop. A person takes over this chat a few seconds after your reply. Do not call any other handover tool.',
  };
}
