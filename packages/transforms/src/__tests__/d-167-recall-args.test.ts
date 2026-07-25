import { describe, it, expect } from 'vitest';
import {
  createLedger,
  createCounters,
  buildKnownValueIndex,
  aliasKnownValuesInContent,
  aliasRecallArgs,
  tokenizeForOverlap,
  restoreInString,
  getOrAllocate,
  type KnownValueSeed,
  type Ledger,
} from '../pii-alias.js';

const index = (seeds: readonly KnownValueSeed[]) => buildKnownValueIndex(seeds);

const expectRestoredDeepClean = (
  ledger: Ledger,
  aliased: unknown,
  expected: unknown,
): void => {
  const restoredJson = restoreInString(ledger, JSON.stringify(aliased));
  expect(restoredJson).not.toContain('pii.');
  expect(restoredJson).not.toContain('.invalid');
  const restored = JSON.parse(restoredJson) as unknown;
  expect(restored).toEqual(expected);
  expect(JSON.stringify(restored)).toBe(JSON.stringify(expected));
};

describe('aliasRecallArgs - recall-path re-aliasing', () => {
  it('closes the cross-session leak by seeding known values into an empty ledger', () => {
    const ledger = createLedger('s');
    const result = { entries: [{ output_string: 'note from Diego Okafor', run_id: 'r1' }] };
    const aliased = aliasRecallArgs(
      ledger,
      result,
      index([{ value: 'Diego Okafor', kind: 'name' }]),
      [],
      new Set(),
    );

    expect(aliased.entries[0].output_string).toBe('note from pii.Person1');
    expect(aliased.entries[0].run_id).toBe('r1');
    expectRestoredDeepClean(ledger, aliased, result);
  });

  it('decorates a disclosed overlap in a nested string leaf', () => {
    const ledger = createLedger('s');
    const result = { entries: [{ output_string: 'met Sarah Smith at expo' }] };
    const aliased = aliasRecallArgs(
      ledger,
      result,
      index([{ value: 'Sarah Smith', kind: 'name' }]),
      [],
      tokenizeForOverlap('who is Sarah'),
    );

    expect(aliased.entries[0].output_string).toBe('met pii.Person1.sarah at expo');
    expectRestoredDeepClean(ledger, aliased, result);
  });

  it('aliases identifier seeds and restores phone values to canonical form', () => {
    const ledger = createLedger('s');
    const result = { entries: [{ output_string: 'reach alice@acme.com or +1 415 555 0199' }] };
    const aliased = aliasRecallArgs(
      ledger,
      result,
      index([]),
      [
        { kind: 'email', value: 'alice@acme.com' },
        { kind: 'phone', value: '+14155550199' },
      ],
      new Set(),
    );
    const json = JSON.stringify(aliased);

    expect(json).not.toContain('alice@acme.com');
    expect(json).not.toContain('0199');
    expect(aliased.entries[0].output_string).toContain('m1@d1.invalid');
    expect(aliased.entries[0].output_string).toContain('pii.Phone1.us');
    expectRestoredDeepClean(
      ledger,
      aliased,
      { entries: [{ output_string: 'reach alice@acme.com or +14155550199' }] },
    );
  });

  it('walks deeply nested arrays and objects while preserving shape', () => {
    const ledger = createLedger('s');
    const result = {
      entries: [
        { output: ['safe', { lines: ['first', ['Diego Okafor buried deep']] }] },
        { meta: { count: 1, flags: [true, null] } },
      ],
    };
    const aliased = aliasRecallArgs(
      ledger,
      result,
      index([{ value: 'Diego Okafor', kind: 'name' }]),
      [],
      new Set(),
    );

    expect(aliased).toEqual({
      entries: [
        { output: ['safe', { lines: ['first', ['pii.Person1 buried deep']] }] },
        { meta: { count: 1, flags: [true, null] } },
      ],
    });
    expect(Array.isArray(aliased.entries)).toBe(true);
    expect(Array.isArray(aliased.entries[0].output)).toBe(true);
    expectRestoredDeepClean(ledger, aliased, result);
  });

  it('aliases keys from the ledger without overlap decoration', () => {
    const ledger = createLedger('s');
    getOrAllocate(ledger, 'name', 'Bob Stone');
    const result: Record<string, string> = { 'Bob Stone': 'note' };
    const aliased = aliasRecallArgs(
      ledger,
      result,
      index([]),
      [],
      tokenizeForOverlap('bob'),
    );
    const keys = Object.keys(aliased);

    expect(keys).toEqual(['pii.Person1']);
    expect(keys[0]).not.toContain('.bob');
    expectRestoredDeepClean(ledger, aliased, result);
  });

  it('counts content replacements once and does not bump identifier counters for seeds', () => {
    const leaf = 'hi Pat Lee and alice@acme.com or +1 415 555 0199';
    const seeds = index([{ value: 'Pat Lee', kind: 'name' }]);
    const identifierSeeds = [
      { kind: 'email' as const, value: 'alice@acme.com' },
      { kind: 'phone' as const, value: '+14155550199' },
    ];
    const ledger = createLedger('s');
    const counters = createCounters();
    const aliased = aliasRecallArgs(
      ledger,
      { entries: [{ output_string: leaf }] },
      seeds,
      identifierSeeds,
      new Set(),
      counters,
    );
    const directCounters = createCounters();
    const direct = aliasKnownValuesInContent(
      createLedger('direct'),
      leaf,
      seeds,
      identifierSeeds,
      directCounters,
    );

    expect(counters.content_text_replacements).toBeGreaterThan(0);
    expect(counters.content_text_replacements).toBe(direct.replacements);
    expect(counters.content_text_replacements).toBe(directCounters.content_text_replacements);
    expect(counters.name).toBe(0);
    expect(counters.email).toBe(0);
    expect(counters.phone).toBe(0);
    expect(JSON.stringify(aliased)).toContain('pii.Person1');
    expectRestoredDeepClean(
      ledger,
      aliased,
      { entries: [{ output_string: 'hi Pat Lee and alice@acme.com or +14155550199' }] },
    );
  });

  it('does not mutate the input object', () => {
    const ledger = createLedger('s');
    const result = {
      entries: [{ output_string: 'note from Diego Okafor', tags: ['known', 'contact'] }],
    };
    const clone = JSON.parse(JSON.stringify(result)) as typeof result;

    aliasRecallArgs(
      ledger,
      result,
      index([{ value: 'Diego Okafor', kind: 'name' }]),
      [],
      new Set(),
    );

    expect(result).toEqual(clone);
    expect(JSON.stringify(result)).toBe(JSON.stringify(clone));
  });

  it('is a no-op for plain strings with no known values', () => {
    const ledger = createLedger('s');
    const result = {
      entries: [
        { output_string: 'plain note', details: ['still plain', { value: 'nothing known' }] },
      ],
    };
    const aliased = aliasRecallArgs(ledger, result, index([]), [], new Set());

    expect(aliased).toEqual(result);
    expectRestoredDeepClean(ledger, aliased, result);
  });

  it('scales overlap reveal per disclosed entity in one result', () => {
    const ledger = createLedger('s');
    const result = {
      entries: [{ output_string: 'Sarah Smith and Bob Jones own the rollout' }],
    };
    const aliased = aliasRecallArgs(
      ledger,
      result,
      index([
        { value: 'Sarah Smith', kind: 'name' },
        { value: 'Bob Jones', kind: 'name' },
      ]),
      [],
      tokenizeForOverlap('Sarah'),
    );

    expect(aliased.entries[0].output_string).toBe(
      'pii.Person1.sarah and pii.Person2 own the rollout',
    );
    expectRestoredDeepClean(ledger, aliased, result);
  });

  it('drops prototype-unsafe keys without polluting Object.prototype', () => {
    const ledger = createLedger('s');
    const pollutionKey = '__d167RecallPolluted';
    const result = JSON.parse(
      '{"__proto__":{"__d167RecallPolluted":true},"entries":[{"output_string":"note from Diego Okafor"}]}',
    ) as { entries: Array<{ output_string: string }>; [key: string]: unknown };

    expect(Object.prototype).not.toHaveProperty(pollutionKey);
    const aliased = aliasRecallArgs(
      ledger,
      result,
      index([{ value: 'Diego Okafor', kind: 'name' }]),
      [],
      new Set(),
    );

    expect(Object.prototype).not.toHaveProperty(pollutionKey);
    expect(Object.prototype.hasOwnProperty.call(aliased, '__proto__')).toBe(false);
    expect(Object.keys(aliased)).toEqual(['entries']);
    expect(aliased.entries[0].output_string).toBe('note from pii.Person1');
    expectRestoredDeepClean(
      ledger,
      aliased,
      { entries: [{ output_string: 'note from Diego Okafor' }] },
    );
  });
});
