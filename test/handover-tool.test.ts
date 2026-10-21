import { afterEach, describe, expect, it, vi } from 'vitest';
import { handToTeamMessage, HANDOVER_REASON_PREFIX, matchThread, takeOverAfterReply } from '../src/chord/handover';

afterEach(() => vi.restoreAllMocks());
const NOW = Date.UTC(2026, 9, 21, 16, 11, 40);
const T = (id: string, over: Record<string, unknown> = {}) => ({ id: id.padEnd(24, '0'), control_state: 'agent_active', last_turn_direction: 'inbound', last_turn_at: NOW - 5_000, last_turn_preview: 'i want a refund', ...over });

describe('finding the conversation for hand_to_team', () => {
  it('matches the customer\'s latest message (case, punctuation and spacing ignored)', () => {
    const r = matchThread([T('a'), T('b', { last_turn_preview: 'send a charger' })], 'I want a refund!', NOW);
    expect(r).toEqual({ ok: true, thread: expect.objectContaining({ id: 'a'.padEnd(24, '0') }) });
  });
  it('ignores chats already with a person, answered by the AI, or older than 3 minutes', () => {
    expect(matchThread([T('a', { control_state: 'human_active' })], 'i want a refund', NOW).ok).toBe(false);
    expect(matchThread([T('a', { last_turn_direction: 'outbound' })], 'i want a refund', NOW).ok).toBe(false);
    expect(matchThread([T('a', { last_turn_at: NOW - 4 * 60_000 })], 'i want a refund', NOW).ok).toBe(false);
  });
  it('two customers with the same words: not guessed', () => {
    expect(matchThread([T('a'), T('b')], 'i want a refund', NOW)).toEqual({ ok: false, reason: 'ambiguous_thread' });
    expect(matchThread([], '', NOW)).toEqual({ ok: false, reason: 'thread_not_found' });
  });
  it('the line Zuma sends depends on dispatcher hours', () => {
    expect(handToTeamMessage(NOW)).toContain('will reply here shortly');
    expect(handToTeamMessage(Date.UTC(2026, 9, 21, 23, 0))).toContain('from 7am');
  });
});

describe('taking over only after Zuma\'s reply is in the chat', () => {
  const cfg = { base: 'https://api.chordhq.xyz', key: 'chord_live_' + 'x'.repeat(40), workspaceId: 'ws-1', teammateId: null, route: 'auto' as const };
  it('waits for an outbound turn newer than the call, then takes over with our reason', async () => {
    const calls: { url: string; body?: unknown }[] = [];
    let polls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/take-over')) return Response.json({ id: 't', control_state: 'human_active' });
      polls++;
      return Response.json({ id: 't', control_state: 'agent_active', last_turn_direction: polls < 2 ? 'inbound' : 'outbound', last_turn_at: polls < 2 ? NOW - 1 : Date.now() + 1 });
    });
    const out = await takeOverAfterReply(cfg, 't'.repeat(24), 'refund for paid job ZD-QFJ5F', Date.now(), 1000, async () => undefined);
    expect(out).toBe('taken_over');
    expect(polls).toBe(2);
    expect(calls.at(-1)!.body).toEqual({ reason: `${HANDOVER_REASON_PREFIX}refund for paid job ZD-QFJ5F` });
  });
  it('a person already took it: does nothing', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ id: 't', control_state: 'human_active' }));
    expect(await takeOverAfterReply(cfg, 't'.repeat(24), 'x', Date.now(), 1000, async () => undefined)).toBe('already_with_a_person');
  });
});
