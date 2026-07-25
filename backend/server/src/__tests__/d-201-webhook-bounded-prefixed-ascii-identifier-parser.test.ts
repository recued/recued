import { describe, expect, it, vi } from 'vitest';

import {
  createWebhookBoundedPrefixedAsciiIdentifierParser,
} from '../webhook-bounded-prefixed-ascii-identifier-parser.js';
import {
  WEBHOOK_DELIVERY_ID_PARSER,
  WEBHOOK_EVENT_ID_PARSER,
  WEBHOOK_INGRESS_ID_PARSER,
  WEBHOOK_REJECTION_ID_PARSER,
} from '../webhook-core-identity-parsers.js';

const PRESET = {
  kind: 'bounded_prefixed_ascii_identifier.v1',
  prefix: 'whi_',
  min_suffix_characters: 16,
  max_suffix_characters: 128,
} as const;

const legacyIngressId = (value: unknown): string | null =>
  typeof value === 'string' && /^whi_[A-Za-z0-9_-]{16,128}$/.test(value)
    ? value
    : null;

const legacyRemainingCoreId = (
  prefix: 'whd_' | 'whe_' | 'whr_',
  value: unknown,
): string | null => {
  if (typeof value !== 'string') return null;
  const accepted = prefix === 'whd_'
    ? /^whd_[A-Za-z0-9_-]{16,128}$/.test(value)
    : prefix === 'whe_'
      ? /^whe_[A-Za-z0-9_-]{16,128}$/.test(value)
      : /^whr_[A-Za-z0-9_-]{16,128}$/.test(value);
  return accepted ? value : null;
};

describe('D-201 Slice 9BE bounded-prefixed ASCII identifier parser', () => {
  it('accepts exact primitive prefix, suffix alphabet, and length boundaries', () => {
    const parser = createWebhookBoundedPrefixedAsciiIdentifierParser(PRESET);
    for (const value of [
      `whi_${'a'.repeat(16)}`,
      `whi_${'A0_-'.repeat(32)}`,
    ]) {
      expect(parser.parse(value)).toBe(value);
    }
    expect(Object.isFrozen(parser)).toBe(true);
    expect(Object.isFrozen(parser.preset)).toBe(true);
    expect(() => JSON.stringify(parser.preset)).not.toThrow();

    const largest = createWebhookBoundedPrefixedAsciiIdentifierParser({
      kind: 'bounded_prefixed_ascii_identifier.v1',
      prefix: 'p'.repeat(64),
      min_suffix_characters: 1,
      max_suffix_characters: 65_472,
    });
    const largestValue = `${'p'.repeat(64)}${'a'.repeat(65_472)}`;
    expect(largest.parse(largestValue)).toBe(largestValue);
    expect(largest.parse(`${largestValue}a`)).toBeNull();
  });

  it('rejects wrong prefixes, lengths, alphabets, and coercion', () => {
    const parser = createWebhookBoundedPrefixedAsciiIdentifierParser(PRESET);
    const valid = `whi_${'a'.repeat(16)}`;
    for (const value of [
      '',
      'whi_',
      `whi_${'a'.repeat(15)}`,
      `whi_${'a'.repeat(129)}`,
      `whd_${'a'.repeat(16)}`,
      `WHI_${'a'.repeat(16)}`,
      `whi_${'a'.repeat(15)}.`,
      `whi_${'a'.repeat(15)} `,
      `whi_${'a'.repeat(15)}\n`,
      `whi_${'a'.repeat(15)}é`,
      null,
      1,
      new String(valid),
      { toString: () => valid },
    ]) {
      expect(parser.parse(value)).toBeNull();
    }
  });

  it('preserves the six legacy ingress-id checks exactly', () => {
    const parser = createWebhookBoundedPrefixedAsciiIdentifierParser(PRESET);
    const minimum = `whi_${'a'.repeat(16)}`;
    const maximum = `whi_${'A0_-'.repeat(32)}`;
    const alphabet = 'aAzZ019_-. *\n\r\u0000é';
    const prefixes = ['whi_', 'whd_', 'WHI_', '', 'xwhi_'];
    const candidates: unknown[] = [
      '',
      minimum,
      maximum,
      null,
      1,
      new String(minimum),
    ];
    for (const valid of [minimum, maximum]) {
      for (let index = 0; index < valid.length; index += 1) {
        for (let code = 0; code < 128; code += 1) {
          candidates.push(
            `${valid.slice(0, index)}${String.fromCharCode(code)}${valid.slice(index + 1)}`,
          );
        }
      }
    }
    let state = 0x9be201;
    const next = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    while (candidates.length < 20_000) {
      const prefix = prefixes[next() % prefixes.length]!;
      const length = next() % 145;
      let suffix = '';
      for (let index = 0; index < length; index += 1) {
        suffix += alphabet[next() % alphabet.length];
      }
      candidates.push(`${prefix}${suffix}`);
    }

    for (const candidate of candidates) {
      expect(parser.parse(candidate)).toBe(legacyIngressId(candidate));
    }
  });

  it('accepts only exact bounded own-data presets without executing accessors', () => {
    expect(() => createWebhookBoundedPrefixedAsciiIdentifierParser(
      PRESET,
    )).not.toThrow();
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'vendor_identifier_callback.v1' },
      { ...PRESET, prefix: '' },
      { ...PRESET, prefix: '1whi_' },
      { ...PRESET, prefix: 'whi.' },
      { ...PRESET, prefix: `w${'h'.repeat(64)}` },
      { ...PRESET, min_suffix_characters: 0 },
      { ...PRESET, min_suffix_characters: 16.5 },
      { ...PRESET, max_suffix_characters: 15 },
      { ...PRESET, max_suffix_characters: 65_533 },
      { ...PRESET, [Symbol('authority')]: true },
      Object.create(PRESET),
      new Proxy({}, {
        ownKeys() {
          throw new Error('hostile bounded-prefixed identifier preset');
        },
      }),
    ]) {
      expect(() => createWebhookBoundedPrefixedAsciiIdentifierParser(
        invalid as never,
      )).toThrow('invalid trusted preset');
    }

    const getter = vi.fn(() => 'whi_');
    const accessor = {
      kind: PRESET.kind,
      min_suffix_characters: 16,
      max_suffix_characters: 128,
    } as Record<string, unknown>;
    Object.defineProperty(accessor, 'prefix', {
      enumerable: true,
      get: getter,
    });
    expect(() => createWebhookBoundedPrefixedAsciiIdentifierParser(
      accessor as never,
    )).toThrow('invalid trusted preset');
    expect(getter).not.toHaveBeenCalled();
  });

  it('copies and freezes trusted preset data', () => {
    const input = {
      kind: 'bounded_prefixed_ascii_identifier.v1' as const,
      prefix: 'id_',
      min_suffix_characters: 2,
      max_suffix_characters: 4,
    };
    const parser = createWebhookBoundedPrefixedAsciiIdentifierParser(input);
    input.prefix = 'changed_';
    input.min_suffix_characters = 1;
    input.max_suffix_characters = 1;
    expect(parser.preset).toEqual({
      kind: 'bounded_prefixed_ascii_identifier.v1',
      prefix: 'id_',
      min_suffix_characters: 2,
      max_suffix_characters: 4,
    });
    expect(parser.parse('id_A-')).toBe('id_A-');
    expect(parser.parse('changed_A')).toBeNull();
  });

  it('locks the shared core ingress identity outside profile and owner data', () => {
    expect(WEBHOOK_INGRESS_ID_PARSER.preset).toEqual(PRESET);
    expect(WEBHOOK_INGRESS_ID_PARSER.parse(
      'whi_0123456789abcdef0123456789abcdef',
    )).toBe('whi_0123456789abcdef0123456789abcdef');
    expect(Object.isFrozen(WEBHOOK_INGRESS_ID_PARSER)).toBe(true);
    expect(Object.isFrozen(WEBHOOK_INGRESS_ID_PARSER.preset)).toBe(true);
  });
});

describe('D-201 Slice 9BF remaining core identity admission', () => {
  const parsers = [
    { prefix: 'whd_' as const, parser: WEBHOOK_DELIVERY_ID_PARSER },
    { prefix: 'whe_' as const, parser: WEBHOOK_EVENT_ID_PARSER },
    { prefix: 'whr_' as const, parser: WEBHOOK_REJECTION_ID_PARSER },
  ];

  it('locks each code-owned role to its compatibility prefix and bounds', () => {
    for (const { prefix, parser } of parsers) {
      expect(parser.preset).toEqual({
        kind: 'bounded_prefixed_ascii_identifier.v1',
        prefix,
        min_suffix_characters: 16,
        max_suffix_characters: 128,
      });
      const minimum = `${prefix}${'a'.repeat(16)}`;
      const maximum = `${prefix}${'A0_-'.repeat(32)}`;
      expect(parser.parse(minimum)).toBe(minimum);
      expect(parser.parse(maximum)).toBe(maximum);
      expect(Object.isFrozen(parser)).toBe(true);
      expect(Object.isFrozen(parser.preset)).toBe(true);
      for (const other of parsers) {
        if (other.prefix !== prefix) {
          expect(parser.parse(`${other.prefix}${'a'.repeat(16)}`)).toBeNull();
        }
      }
    }
  });

  it('preserves all three removed primitive regex contracts exactly', () => {
    const mismatches: Array<{
      prefix: string;
      candidate: unknown;
      expected: string | null;
      actual: string | null;
    }> = [];
    let checked = 0;
    const compare = (
      prefix: 'whd_' | 'whe_' | 'whr_',
      parser: typeof WEBHOOK_DELIVERY_ID_PARSER,
      candidate: unknown,
    ): void => {
      checked += 1;
      const expected = legacyRemainingCoreId(prefix, candidate);
      const actual = parser.parse(candidate);
      if (actual !== expected && mismatches.length < 10) {
        mismatches.push({ prefix, candidate, expected, actual });
      }
    };

    for (const { prefix, parser } of parsers) {
      const minimum = `${prefix}${'a'.repeat(16)}`;
      const maximum = `${prefix}${'A0_-'.repeat(32)}`;
      for (const candidate of [
        '',
        `${prefix}${'a'.repeat(15)}`,
        minimum,
        maximum,
        `${prefix}${'a'.repeat(129)}`,
        `${prefix}${'a'.repeat(15)}.`,
        `${prefix}${'a'.repeat(15)}\n`,
        `${prefix}${'a'.repeat(15)}é`,
        null,
        1,
        new String(minimum),
      ]) compare(prefix, parser, candidate);

      for (const valid of [minimum, maximum]) {
        for (let index = 0; index < valid.length; index += 1) {
          for (let code = 0; code < 128; code += 1) {
            compare(
              prefix,
              parser,
              `${valid.slice(0, index)}${String.fromCharCode(code)}${valid.slice(index + 1)}`,
            );
          }
        }
      }
    }

    expect(checked).toBe(58_401);
    expect(mismatches).toEqual([]);
  });
});
