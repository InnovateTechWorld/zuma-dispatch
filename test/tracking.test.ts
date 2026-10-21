import { describe, expect, it } from 'vitest';
import { riderById } from '../src/business/riders';
import { APPROACH_MIN, simulateRider, startPoint } from '../src/business/tracking';

const rider = riderById('R-LA1')!;
const pickup = { lat: 6.5833, lng: 3.3553, label: 'Paystack office, 3A Ladoke Akintola Street, Ikeja GRA, Lagos' };
const dropoff = { lat: 6.5158, lng: 3.3896, label: 'University of Lagos (UNILAG), Akoka, Lagos' };
const T0 = Date.UTC(2026, 9, 21, 15, 0);
const base = { jobId: 'ZD-QFJ5F', rider, pickup, dropoff, assignedAt: T0, dispatchedAt: null, tripMinutes: 30, riderHoursNow: true, riderHoursNote: '', now: T0 };
const min = (m: number) => T0 + m * 60_000;

describe('simulated rider tracking (test mode)', () => {
  it('paid: heading to the pickup, minutes and km fall as time passes', () => {
    const a = simulateRider({ ...base, status: 'paid', now: min(2) })!;
    const b = simulateRider({ ...base, status: 'paid', now: min(10) })!;
    expect(a.phase).toBe('to_pickup');
    expect(a.minutes_away).toBe(APPROACH_MIN - 2);
    expect(b.minutes_away).toBe(APPROACH_MIN - 10);
    expect(b.km_away!).toBeLessThan(a.km_away!);
    expect(a.message).toContain('on the way to the pickup at Paystack office');
    expect(a.map_url).toMatch(/^https:\/\/www\.openstreetmap\.org\/\?mlat=/);
    expect(a.simulated).toBe(true);
  });
  it('the same moment always gives the same position (no jumping between calls)', () => {
    expect(simulateRider({ ...base, status: 'paid', now: min(4) })).toEqual(simulateRider({ ...base, status: 'paid', now: min(4) }));
    expect(startPoint('ZD-QFJ5F', pickup)).toEqual(startPoint('ZD-QFJ5F', pickup));
  });
  it('paid but past the approach time: at the pickup', () => {
    expect(simulateRider({ ...base, status: 'paid', now: min(40) })!.phase).toBe('at_pickup');
  });
  it('dispatched: moves towards the drop-off, then arriving', () => {
    const d = { ...base, status: 'dispatched', dispatchedAt: T0 };
    const mid = simulateRider({ ...d, now: min(15) })!;
    expect(mid.phase).toBe('to_dropoff');
    expect(mid.minutes_away).toBe(15);
    expect(mid.message).toContain('on the way to University of Lagos (UNILAG)');
    expect(simulateRider({ ...d, now: min(31) })!.phase).toBe('arriving');
  });
  it('outside rider hours: no movement, says when', () => {
    const u = simulateRider({ ...base, status: 'paid', riderHoursNow: false, riderHoursNote: 'Pickup starts at 7am.' })!;
    expect(u.phase).toBe('waiting_hours');
    expect(u.message).toContain('Pickup starts at 7am.');
  });
  it('delivered, and statuses with no rider movement', () => {
    expect(simulateRider({ ...base, status: 'delivered' })!.phase).toBe('delivered');
    expect(simulateRider({ ...base, status: 'cancelled' })).toBeNull();
    expect(simulateRider({ ...base, status: 'awaiting_payment' })).toBeNull();
  });
});
