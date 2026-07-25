import { describe, expect, it } from 'vitest';
import { getTransform } from '../index.js';
import { ctx } from './helpers.js';

const c = ctx();

const mapTransform = () => {
  const fn = getTransform('map');
  if (!fn) throw new Error('map transform is not registered');
  return fn;
};

describe('map expression date coercion (G2 datetime unify)', () => {
  it('normalizes epoch-ms (string/number) and ISO forms to a unix-ms number, preserving invalid as null', () => {
    const items = [
      { value: '1735689600000', name: 'hubspot epoch-ms string' },
      { value: 1735689600000, name: 'already a ms number' },
      { value: '2025-01-01', name: 'salesforce ISO date' },
      { value: '2025-01-01T10:30:00.000+0000', name: 'salesforce ISO datetime' },
      { value: '', name: 'empty' },
      { value: null, name: 'null' },
      { name: 'missing' },
      { value: 'not-a-date', name: 'garbage' },
    ];

    const result = mapTransform()(
      {
        array: items,
        expression: {
          ms: '{{item.value | date_ms}}',
          name: '{{item.name}}',
        },
      },
      c,
    ) as Array<{ ms: unknown; name: unknown }>;

    expect(result.map((row) => row.ms)).toEqual([
      1735689600000,
      1735689600000,
      Date.parse('2025-01-01'),
      Date.parse('2025-01-01T10:30:00.000+0000'),
      null,
      null,
      null,
      null,
    ]);
    // epoch-ms string and the already-number form land on the SAME instant.
    expect(result[0].ms).toBe(result[1].ms);
    // the projected output is a real number, not a string.
    expect(typeof result[0].ms).toBe('number');
    // sibling refs are untouched.
    expect(result[0].name).toBe('hubspot epoch-ms string');
  });

  it('reads the SAME canonical date identically across vendor shapes (cross-vendor parity)', () => {
    // The exact bite from converged §8: HubSpot returns the close date as an
    // epoch-ms string, Salesforce as an ISO datetime — the SAME instant must
    // project to the SAME canonical unix-ms value.
    const instantMs = Date.parse('2025-01-01T00:00:00.000Z');
    const hubspot = mapTransform()(
      { array: [{ closedate: String(instantMs) }], expression: { close_date: '{{item.closedate | date_ms}}' } },
      c,
    ) as Array<{ close_date: unknown }>;
    const salesforce = mapTransform()(
      { array: [{ CloseDate: '2025-01-01T00:00:00.000Z' }], expression: { close_date: '{{item.CloseDate | date_ms}}' } },
      c,
    ) as Array<{ close_date: unknown }>;

    expect(hubspot[0].close_date).toBe(instantMs);
    expect(salesforce[0].close_date).toBe(instantMs);
    expect(hubspot[0].close_date).toBe(salesforce[0].close_date);
  });

  it('coerces nested dotted paths (HubSpot properties.* envelope)', () => {
    const result = mapTransform()(
      {
        array: [{ properties: { closedate: '1735689600000' }, CloseDate: '2025-01-01' }],
        expression: {
          nested: '{{item.properties.closedate | date_ms}}',
          flat: '{{item.CloseDate | date_ms}}',
        },
      },
      c,
    ) as Array<{ nested: unknown; flat: unknown }>;

    expect(result).toEqual([{ nested: 1735689600000, flat: Date.parse('2025-01-01') }]);
  });

  it('treats a whitespace-only value as null (not the 1970 epoch) and trims a padded epoch-ms', () => {
    const result = mapTransform()(
      {
        array: [
          { value: '   ', name: 'whitespace' },
          { value: ' 1735689600000 ', name: 'padded epoch-ms' },
          { value: '  2025-01-01  ', name: 'padded ISO' },
        ],
        expression: { ms: '{{item.value | date_ms}}', name: '{{item.name}}' },
      },
      c,
    ) as Array<{ ms: unknown; name: unknown }>;

    expect(result.map((r) => r.ms)).toEqual([
      null,
      1735689600000,
      Date.parse('2025-01-01'),
    ]);
  });

  it('does not coerce the date-filter form when embedded in surrounding text', () => {
    const result = mapTransform()(
      { array: [{ value: '1735689600000' }], expression: 'closes={{item.value | date_ms}}' },
      c,
    ) as string[];

    expect(result).toEqual(['closes={{item.value | date_ms}}']);
  });
});
