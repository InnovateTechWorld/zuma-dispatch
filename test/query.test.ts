import { describe, expect, it } from 'vitest';
import { areaPart, cleanedQuery, distinctiveWords, houseNumber, isRelevant } from '../src/geocode/query';

describe('how customers write addresses vs how the map has them', () => {
  it('cleans the spelling: house number, Saint → St, possessive before a road', () => {
    expect(cleanedQuery('no 23 saint finbarrs road')).toBe('St finbarr road');
    expect(cleanedQuery("23, St. Finbarr's Road, Akoka")).toBe('St Finbarr Road, Akoka');
    expect(cleanedQuery('Jabi Lake Mall')).toBeNull();
  });
  it('keeps the house number for the rider', () => {
    expect(houseNumber('No 23 Saint Finbarrs Road')).toBe('23');
    expect(houseNumber('plot 5b Adeola Odeku Street')).toBe('5B');
    expect(houseNumber('Jabi Lake Mall')).toBeNull();
    expect(houseNumber('1004 Estate, Victoria Island')).toBe('1004');
  });
  it('finds the area the customer named', () => {
    expect(areaPart('Saint Finbarrs College, Akoka')).toBe('akoka');
    expect(areaPart('saint finbarrs road in akoka lagos')).toBe('akoka lagos');
    expect(areaPart('Jabi Lake Mall')).toBeNull();
    expect(areaPart('saint finbarrs school akoka lagos')).toBe('akoka lagos');
  });
  it('a result must share a distinctive word with what was typed', () => {
    expect(distinctiveWords('Saint Finbarrs College, Akoka')).toEqual(['finbarrs', 'akoka']);
    expect(isRelevant("Saint Gregory's College, Lagos", 'Saint Finbarrs College, Akoka')).toBe(false);
    expect(isRelevant("St. Mary's College, Alasia, LA", 'Saint Finbarrs College, Akoka')).toBe(false);
    expect(isRelevant('Finbarr road, Bariga', 'no 23 saint finbarrs road')).toBe(true);
    expect(isRelevant('Jabi Lake Mall, Jabi, Abuja', 'Jabi Lake Mall')).toBe(true);
    expect(isRelevant('Ikeja City Mall, 174/194, Agidingbi, Alausa', 'Ikeja City Mall')).toBe(true);
    expect(isRelevant('Wuse Market, Douala Street, Wuse, Abuja', 'Wuse Market, Abuja')).toBe(true);
    expect(isRelevant('Shoprite, Lamu Audu Drive, Wuse II', 'Shoprite')).toBe(true);
    // The place's own name must match; the area alone is not enough.
    expect(isRelevant('CMS Grammar School, Oyenuga Street, Akoka, Bariga, Lagos', 'saint finbarrs school akoka lagos')).toBe(false);
    expect(isRelevant('University of Lagos (UNILAG), Akoka', 'unilag')).toBe(true);
    expect(isRelevant('Lagos University Teaching Hospital, Idi-Araba', 'LUTH')).toBe(true);
    // Only generic words typed: nothing to compare, keep everything.
    expect(isRelevant('Anything', 'the school')).toBe(true);
  });
});

describe('Google labels', () => {
  it('does not repeat the name when the address starts with it', async () => {
    const { googleLabel } = await import('../src/geocode/providers');
    expect(googleLabel("23 St Finbarr's College Rd", "23 St Finbarr's College Rd, Akoka, Lagos 100001")).toBe("23 St Finbarr's College Rd, Akoka, Lagos 100001");
    expect(googleLabel("St Finbarr's College", "St Finbarr's College Rd, Yaba, Lagos")).toBe("St Finbarr's College, St Finbarr's College Rd, Yaba, Lagos");
    expect(googleLabel(undefined, 'Akoka, Lagos')).toBe('Akoka, Lagos');
    expect(googleLabel('Jabi Lake Mall', undefined)).toBe('Jabi Lake Mall');
  });
});
