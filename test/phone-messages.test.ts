import { describe, expect, it } from 'vitest';
import { localDisplay, looksMadeUp, phoneProblemMessage } from '../src/lib/phone';
import { reservedMessage } from '../src/business/messages';

describe('phone numbers that look wrong or incomplete', () => {
  const who = "John's";
  it('too short: says how many digits and what a right one looks like', () => {
    expect(phoneProblemMessage('0907656543', who)).toBe("John's number looks incomplete: I got 10 digits, and Nigerian mobile numbers have 11 (like 0803 123 4567). Could you send it again?");
    expect(phoneProblemMessage('0907', who)).toContain('I got 4 digits');
  });
  it('too long', () => {
    expect(phoneProblemMessage('090765654345', who)).toContain('looks too long: I got 12 digits');
  });
  it('not a Nigerian mobile prefix', () => {
    expect(phoneProblemMessage('06012345678', who)).toContain("doesn't look like a Nigerian mobile number");
  });
  it('no number at all', () => {
    expect(phoneProblemMessage('call him', who)).toContain("I couldn't find a phone number");
  });
  it('placeholder-looking numbers are questioned once, real ones are not', () => {
    expect(looksMadeUp('+2348000000000')).toBe(true);
    expect(looksMadeUp('+2348011111111')).toBe(true);
    expect(looksMadeUp('+2348012345678')).toBe(true);
    expect(looksMadeUp('+2349076565434')).toBe(false);
    expect(phoneProblemMessage('08000000000', who)).toContain('Just checking: is 0800 000 0000 really');
    expect(phoneProblemMessage('09076565434', who)).toBe('');
  });
  it('the reserved message reads the number back the Nigerian way', () => {
    expect(localDisplay('+2349076565434')).toBe('0907 656 5434');
    expect(reservedMessage({ id: 'ZD-XSE4F', sender_name: 'ada', recipient_name: 'john doe', recipient_phone: '+2349076565434', amount_kobo: 300000 }))
      .toContain('Your delivery to John Doe (0907 656 5434) is reserved as ZD-XSE4F');
  });
});
