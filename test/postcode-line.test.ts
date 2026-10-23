import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config';
import type { ToolContext } from '../src/mcp/tooling';
import { resolveAddress } from '../src/tools/resolveAddress';
import { d1 } from './helpers/sqliteD1';

// 23 Oct 2026: "from Ikeja City Mall to LA-11-ZDM-PS-01" got only the pickup read back; the decoded
// postcode first appeared in the quote. Now the reply before the quote shows it too.
const config = { nipostApiKey: 'nipost_test_x', providerTimeoutMs: 1000, geocoderChain: [], geocoderMode: 'fallback', routerChain: [] } as unknown as Config;

describe('a decoded demo postcode is shown with its role, and the cache never mixes roles', () => {
  it('drop-off, then the same code as a pickup', async () => {
    const { env } = d1();
    const ctx = { env, config, db: env.DB, requestId: 'r', now: () => Date.parse('2026-10-23T09:30:00+01:00'), waitUntil: () => {}, publicOrigin: 'https://x', trace: [] } as ToolContext;
    const asDropoff = await resolveAddress({ text: 'LA-11-ZDM-PS-01', role: 'dropoff', state: 'lagos' } as never, ctx);
    expect(asDropoff).toMatchObject({ status: 'confirmed', confirm: 'in_quote', say_in_reply: 'Drop-off: Paystack office, 3A Ladoke Akintola Street, Ikeja GRA, Lagos (from your postcode)' });
    const again = await resolveAddress({ text: 'LA-11-ZDM-PS-01', role: 'dropoff', state: 'lagos' } as never, ctx);
    expect(ctx.trace).toContain('resolve:stable-reuse'); // the same role reuses the stable answer
    expect(again['say_in_reply']).toBe(asDropoff['say_in_reply']);
    const asPickup = await resolveAddress({ text: 'LA-11-ZDM-PS-01', role: 'pickup', state: 'lagos' } as never, ctx);
    expect(asPickup['say_in_reply']).toBe('Pickup: Paystack office, 3A Ladoke Akintola Street, Ikeja GRA, Lagos (from your postcode)');
    expect(asPickup['role']).toBe('pickup');
  });
});
