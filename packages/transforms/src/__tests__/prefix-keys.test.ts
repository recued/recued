import { describe, expect, it } from 'vitest';
import { getTransform } from '../index.js';

describe('prefix_keys', () => {
  const prefixKeys = getTransform('prefix_keys')!;

  it('prefixes own keys while preserving scalar types', () => {
    const result = prefixKeys({
      source: { name: 'Ada', count: 2, approved: true, empty: null },
      prefix: 'response.',
    }, null as never);

    expect(result).toEqual({
      'response.name': 'Ada',
      'response.count': 2,
      'response.approved': true,
      'response.empty': null,
    });
    expect(Object.getPrototypeOf(result)).toBeNull();
  });

  it('does not flatten nested visitor-authored values', () => {
    const nested = { unsafe: ['not', 'a', 'scalar'] };
    expect(prefixKeys({ source: { details: nested }, prefix: 'response.' }, null as never))
      .toEqual({ 'response.details': nested });
  });

  it.each([
    [{ source: null, prefix: 'response.' }, 'source'],
    [{ source: [], prefix: 'response.' }, 'source'],
    [{ source: new Date(0), prefix: 'response.' }, 'source'],
    [{ source: {}, prefix: '' }, 'prefix'],
  ])('fails loud on invalid runtime input %#', (params, field) => {
    expect(() => prefixKeys(params, null as never)).toThrow(field);
  });
});
