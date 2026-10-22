import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chord, chordProblem, chordTiming, clearChordCache, retryAfterMs, type NoticeConfig } from '../src/chord/notices';

// 2026-10-22: the Handovers list made up to 22 Chord calls at once, and the next page got
// "chord_http_429: Rate limit exceeded. Retry after 1 seconds." (the API key allows 30 a minute).
const cfg: NoticeConfig = { key: 'chord_live_' + 'x'.repeat(43), base: 'https://chord.test', workspaceId: 'ws-1' } as NoticeConfig;
const limited = () => Response.json({ error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded. Retry after 1 seconds.' } }, { status: 429 });
const waits: number[] = [];
const realSleep = chordTiming.sleep;

beforeEach(() => {
  clearChordCache();
  waits.length = 0;
  chordTiming.sleep = async (ms) => {
    waits.push(ms);
  };
});
afterEach(() => {
  chordTiming.sleep = realSleep;
  vi.restoreAllMocks();
});

function api(replies: (() => Response)[]) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    const next = replies.length > 1 ? replies.shift()! : replies[0]!;
    return next();
  });
  return calls;
}

describe('Chord rate limit (429)', () => {
  it('waits what Chord asks, then retries and succeeds', async () => {
    const calls = api([limited, () => Response.json({ id: 't1' })]);
    const r = await chord<{ id: string }>(cfg, '/v1/threads/t1', 1000);
    expect(r.ok && r.data.id).toBe('t1');
    expect(calls).toHaveLength(2);
    expect(waits[0]).toBeGreaterThanOrEqual(1000);
    expect(waits[0]).toBeLessThan(1250);
  });

  it('gives up after two retries and says so in plain words', async () => {
    const calls = api([limited]);
    const r = await chord(cfg, '/v1/threads/t1', 1000);
    expect(calls).toHaveLength(3);
    expect(r.ok).toBe(false);
    expect(chordProblem(r)).toMatch(/^Chord is limiting how fast the board can read/);
    expect(chordProblem(r)).not.toMatch(/\.$/);
  });

  it('does not wait longer than the cap: a long Retry-After is reported at once', async () => {
    const calls = api([() => new Response('{}', { status: 429, headers: { 'Retry-After': '30' } })]);
    const r = await chord(cfg, '/v1/threads/t1', 1000);
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(retryAfterMs(r)).toBe(30_000);
  });

  it('retries a refused POST too (Chord did not run it)', async () => {
    const calls = api([limited, () => Response.json({ id: 'turn_1' }, { status: 201 })]);
    const r = await chord(cfg, '/v1/threads/t1/messages', 1000, { text: 'hi' });
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['POST https://chord.test/v1/threads/t1/messages', 'POST https://chord.test/v1/threads/t1/messages']);
  });

  it('other errors are not retried', async () => {
    const calls = api([() => new Response('{}', { status: 502 })]);
    await chord(cfg, '/v1/threads/t1', 1000);
    expect(calls).toHaveLength(1);
  });

  it('reads Retry-After from the header first, then the message, else 1 s', () => {
    const fail = (headers: Record<string, string>, body: string) => ({ ok: false as const, failure: 'http' as const, status: 429, body, headers: new Headers(headers), ms: 1 });
    expect(retryAfterMs(fail({ 'Retry-After': '2' }, ''))).toBe(2000);
    expect(retryAfterMs(fail({}, '{"error":{"message":"Retry after 3 seconds."}}'))).toBe(3000);
    expect(retryAfterMs(fail({}, ''))).toBe(1000);
  });
});

describe('cached board reads', () => {
  it('identical reads share one Chord call, in flight and within the cache time', async () => {
    const calls = api([() => Response.json({ threads: [] })]);
    const [a, b] = await Promise.all([chord(cfg, '/v1/threads?x=1', 1000, undefined, { cacheMs: 10_000 }), chord(cfg, '/v1/threads?x=1', 1000, undefined, { cacheMs: 10_000 })]);
    await chord(cfg, '/v1/threads?x=1', 1000, undefined, { cacheMs: 10_000 });
    expect(a.ok && b.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('expires after the cache time', async () => {
    const calls = api([() => Response.json({ threads: [] })]);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await chord(cfg, '/v1/threads?x=1', 1000, undefined, { cacheMs: 10_000 });
    now.mockReturnValue(1_011_000);
    await chord(cfg, '/v1/threads?x=1', 1000, undefined, { cacheMs: 10_000 });
    expect(calls).toHaveLength(2);
  });

  it('a failed read is not reused', async () => {
    const calls = api([() => new Response('{}', { status: 502 }), () => Response.json({ threads: [] })]);
    expect((await chord(cfg, '/v1/threads?x=1', 1000, undefined, { cacheMs: 10_000 })).ok).toBe(false);
    expect((await chord(cfg, '/v1/threads?x=1', 1000, undefined, { cacheMs: 10_000 })).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("any POST clears the cache, so the board shows the dispatcher's own action", async () => {
    const calls = api([() => Response.json({ threads: [] })]);
    await chord(cfg, '/v1/threads?x=1', 1000, undefined, { cacheMs: 10_000 });
    await chord(cfg, '/v1/threads/t1/take-over', 1000, {});
    await chord(cfg, '/v1/threads?x=1', 1000, undefined, { cacheMs: 10_000 });
    expect(calls.filter((c) => c.startsWith('GET'))).toHaveLength(2);
  });

  it('reads without cacheMs are always fresh', async () => {
    const calls = api([() => Response.json({ id: 't1' })]);
    await chord(cfg, '/v1/threads/t1', 1000);
    await chord(cfg, '/v1/threads/t1', 1000);
    expect(calls).toHaveLength(2);
  });
});
