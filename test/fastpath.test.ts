import { describe, expect, it } from 'vitest';
import { demoConfirm } from '../src/tools/resolveAddress';
import { ADDRESS_CHECK_QUESTION, BOOK_QUESTION, confirmedInQuote, quoteView } from '../src/tools/quoteDelivery';

const PAYSTACK = { label: 'Paystack office, 3A Ladoke Akintola Street, Ikeja GRA, Lagos', lat: 6.5833, lng: 3.3553 };
const place = (over: Record<string, unknown>) => ({
  id: 'P-AAAAAAAA', query_text: 'x', label: 'Somewhere, Lagos', lat: 6.5, lng: 3.4, precision: 'exact', postcode: null, postcode_status: null,
  provider: 'photon', confidence: 'high', in_service_area: 1, state: 'LA', created_at: 0, ...over,
}) as never;
const quote = {
  id: 'Q-REDZJ92N', pickup_place_id: 'P-1', dropoff_place_id: 'P-2', package_size: 'small', distance_m: 12700, duration_s: 1800,
  distance_source: 'osrm', approximate: 0, amount_kobo: 300000, breakdown_json: '[]', rate_card_version: 'v1', created_at: 0, expires_at: 30 * 60_000,
} as never;
const NOON = Date.UTC(2026, 9, 21, 11, 0); // 12:00 WAT, inside the pickup window

describe('fast path: demo postcodes are confirmed in the quote message', () => {
  it('a demo postcode needs no question of its own', () => {
    const r = demoConfirm(PAYSTACK, 'LA');
    expect(r.confirm).toBe('in_quote');
    expect(r.what_to_do).toContain('Do not ask the customer to confirm it');
    expect(r.say_in_reply).toBe('Pickup: Paystack office, 3A Ladoke Akintola Street, Ikeja GRA, Lagos (from your postcode)');
    expect(demoConfirm(PAYSTACK, null).confirm).toBe('in_quote');
  });
  it('shows the decoded postcode before the quote, labelled by role, without asking about it', () => {
    const r = demoConfirm(PAYSTACK, 'LA', 'dropoff');
    expect(r.say_in_reply).toBe('Drop-off: Paystack office, 3A Ladoke Akintola Street, Ikeja GRA, Lagos (from your postcode)');
    expect(r.what_to_do).toContain(`"${r.say_in_reply}"`);
    expect(r.what_to_do).toMatch(/If you send the quote in this same reply, leave the line out/);
    expect(demoConfirm(PAYSTACK, 'LA').say_in_reply).toMatch(/^Pickup: /); // role defaults to pickup
    expect(demoConfirm(PAYSTACK, 'LA', 'something-else').say_in_reply).toMatch(/^Pickup: /);
  });
  it('a demo postcode in the other state is never fast-pathed (and gets no "from your postcode" line)', () => {
    expect(demoConfirm(PAYSTACK, 'FC', 'dropoff').say_in_reply).toBeUndefined();
    const r = demoConfirm(PAYSTACK, 'FC');
    expect(r.confirm).toBe('ask_first');
    expect(r.what_to_do).toContain('only deliver within one state');
  });
  it('only exact demo-postcode places count as confirmed in the quote', () => {
    expect(confirmedInQuote({ postcode_status: 'demo', precision: 'exact' })).toBe(true);
    expect(confirmedInQuote({ postcode_status: 'demo', precision: 'lga' })).toBe(false);
    expect(confirmedInQuote({ postcode_status: 'not_found', precision: 'exact' })).toBe(false);
    expect(confirmedInQuote({ postcode_status: null, precision: 'exact' })).toBe(false);
  });
  it('the quote asks the customer to check both addresses when either was a demo postcode', () => {
    const v = quoteView(quote, place({ postcode_status: 'demo', label: PAYSTACK.label }), place({ label: 'University of Lagos (UNILAG), Akoka, Lagos' }), NOON, false);
    expect(v.closing_question).toBe(ADDRESS_CHECK_QUESTION);
    expect(v.addresses_confirmed_in_this_message).toBe(true);
    expect(String(v.what_to_do)).toContain('"Pickup: Paystack office');
    expect(String(v.what_to_do)).toContain('confirms both addresses and the price');
    expect(v.details_question).toContain('1. Your name');
    expect(String(v.what_to_do)).toContain('ask only for the missing ones');
    expect(String(v.what_to_do)).toContain('Quote ref Q-REDZJ92N');
  });
  it('landmarks confirmed one by one keep the plain booking question', () => {
    const v = quoteView(quote, place({}), place({ id: 'P-BBBBBBBB' }), NOON, false);
    expect(v.closing_question).toBe(BOOK_QUESTION);
    expect(v.addresses_confirmed_in_this_message).toBe(false);
  });
});

describe('order and wording', () => {
  it('the quote question only confirms; it never promises to book', () => {
    for (const q of [ADDRESS_CHECK_QUESTION, BOOK_QUESTION]) {
      expect(q).toMatch(/reply YES/i);
      expect(q.toLowerCase()).not.toContain('book');
    }
    expect(ADDRESS_CHECK_QUESTION).toContain('Are both addresses right?');
  });
  it('every tool result tells the model not to narrate its re-checks', async () => {
    const { HISTORY_NOTE } = await import('../src/mcp/tooling');
    expect(HISTORY_NOTE).not.toMatch(/re-run tools/); // read by the model as "don't call tools" (23 Oct)
    expect(HISTORY_NOTE).toContain('where the rider or package is → get_job_status');
    expect(HISTORY_NOTE).toContain('never say a person will take over unless hand_to_team returned ok');
    expect(HISTORY_NOTE).toContain('never write a link no tool gave you');
    expect(HISTORY_NOTE).toContain('after your last tool call');
    expect(HISTORY_NOTE.length).toBeLessThan(700);
  });
});

describe('ready-to-send customer messages', () => {
  it('bank transfer details always carry bank, account number, name, exact amount and expiry', async () => {
    const { transferMessage } = await import('../src/business/messages');
    const m = transferMessage({ amount_kobo: 300000, bank: 'Test Bank', account_number: '1234567890', account_name: 'Zuma Dispatch', expires: '1:26 PM' });
    for (const part of ['Bank: Test Bank', 'Account number: 1234567890', 'Account name: Zuma Dispatch', 'Amount: exactly ₦3,000', 'expires at 1:26 PM', 'reply "sent"']) expect(m).toContain(part);
  });
  it('expiry reads as a 12-hour time', async () => {
    const { twelveHour } = await import('../src/business/messages');
    expect(twelveHour('13:34')).toBe('1:34 PM');
    expect(twelveHour('00:05')).toBe('12:05 AM');
    expect(twelveHour('12:00')).toBe('12:00 PM');
    expect(twelveHour('soon')).toBe('soon');
  });
  it('the link sits on its own line', async () => {
    const { linkMessage } = await import('../src/business/messages');
    expect(linkMessage(300000, 'https://checkout.paystack.com/abc').split('\n')).toContain('https://checkout.paystack.com/abc');
  });
  it('reserved: first name, recipient, job id, amount, and the payment question', async () => {
    const { reservedMessage } = await import('../src/business/messages');
    const m = reservedMessage({ id: 'ZD-FE1ST', sender_name: 'joshua', recipient_name: 'bola ahmed', amount_kobo: 300000 });
    expect(m).toContain('Great, Joshua!');
    expect(m).toContain('to Bola Ahmed is reserved as ZD-FE1ST (₦3,000)');
    expect(m).toContain('How would you like to pay');
    expect(m).not.toMatch(/handover code/i);
  });
});
