import { describe, expect, it, vi } from 'vitest';

import {
  createWebhookPositiveSafeIntegerTextParser,
  type WebhookPositiveSafeIntegerTextParseResult,
} from '../webhook-positive-safe-integer-text-parser.js';
import {
  WEBHOOK_CREDENTIAL_VERSION_PARSER,
} from '../webhook-core-identity-parsers.js';

const PRESET = {
  kind: 'positive_safe_integer_text.v1',
  max_value: Number.MAX_SAFE_INTEGER,
} as const;

const legacyClassification = (
  value: unknown,
  maximum: number,
): WebhookPositiveSafeIntegerTextParseResult => {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    return { ok: false, reason: 'invalid_shape' };
  }
  const parsed = Number(value);
  return !Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum
    ? { ok: false, reason: 'out_of_range' }
    : { ok: true, text: value, value: parsed };
};

describe('D-201 Slice 9BG positive-safe-integer text parser', () => {
  it('accepts canonical primitive text through the selected safe ceiling', () => {
    const parser = createWebhookPositiveSafeIntegerTextParser(PRESET);
    expect(parser.parse('1')).toEqual({ ok: true, text: '1', value: 1 });
    expect(parser.parse(String(Number.MAX_SAFE_INTEGER))).toEqual({
      ok: true,
      text: String(Number.MAX_SAFE_INTEGER),
      value: Number.MAX_SAFE_INTEGER,
    });
    expect(Object.isFrozen(parser)).toBe(true);
    expect(Object.isFrozen(parser.preset)).toBe(true);
    expect(Object.isFrozen(parser.parse('1'))).toBe(true);

    const bounded = createWebhookPositiveSafeIntegerTextParser({
      kind: 'positive_safe_integer_text.v1',
      max_value: 100,
    });
    expect(bounded.parse('100')).toEqual({ ok: true, text: '100', value: 100 });
    expect(bounded.parse('101')).toEqual({ ok: false, reason: 'out_of_range' });
  });

  it('distinguishes invalid shape from well-shaped out-of-range text', () => {
    const parser = createWebhookPositiveSafeIntegerTextParser(PRESET);
    const toPrimitive = vi.fn(() => '1');
    const valueOf = vi.fn(() => 1);
    const toString = vi.fn(() => '1');
    const coercible = {
      [Symbol.toPrimitive]: toPrimitive,
      valueOf,
      toString,
    };
    for (const value of [
      '',
      '0',
      '01',
      '+1',
      '-1',
      ' 1',
      '1 ',
      '1.0',
      '1e1',
      '１',
      '\0',
      '1\0',
      '1\n',
      '1\r',
      '1\u2028',
      '1\u2029',
      null,
      1,
      1n,
      Symbol('1'),
      new String('1'),
      coercible,
    ]) {
      expect(parser.parse(value)).toEqual({
        ok: false,
        reason: 'invalid_shape',
      });
    }
    for (const value of [
      String(Number.MAX_SAFE_INTEGER + 1),
      '9'.repeat(128),
      '1'.repeat(10_000),
    ]) {
      expect(parser.parse(value)).toEqual({
        ok: false,
        reason: 'out_of_range',
      });
    }
    expect(toPrimitive).not.toHaveBeenCalled();
    expect(valueOf).not.toHaveBeenCalled();
    expect(toString).not.toHaveBeenCalled();
  });

  it('preserves primitive legacy shape/range classification across seeded inputs', () => {
    const parser = createWebhookPositiveSafeIntegerTextParser(PRESET);
    const candidates: unknown[] = [
      null,
      1,
      new String('1'),
      '1',
      String(Number.MAX_SAFE_INTEGER),
      String(Number.MAX_SAFE_INTEGER + 1),
      '1'.repeat(1_000),
    ];
    const alphabet = '0123456789+-eE. _\n\ré';
    let state = 0x9b6201;
    const next = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    while (candidates.length < 20_000) {
      const length = next() % 40;
      let candidate = '';
      for (let index = 0; index < length; index += 1) {
        candidate += alphabet[next() % alphabet.length];
      }
      candidates.push(candidate);
    }
    for (const candidate of candidates) {
      expect(parser.parse(candidate)).toEqual(
        legacyClassification(candidate, Number.MAX_SAFE_INTEGER),
      );
    }
  });

  it('accepts only exact own-data presets without executing accessors', () => {
    expect(() => createWebhookPositiveSafeIntegerTextParser(PRESET)).not.toThrow();
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'vendor_integer_callback.v1' },
      { ...PRESET, max_value: 0 },
      { ...PRESET, max_value: 1.5 },
      { ...PRESET, max_value: Number.POSITIVE_INFINITY },
      { ...PRESET, max_value: Number.MAX_SAFE_INTEGER + 1 },
      { ...PRESET, [Symbol('authority')]: true },
      Object.create(PRESET),
      new Proxy({}, {
        ownKeys() {
          throw new Error('hostile safe-integer preset');
        },
      }),
    ]) {
      expect(() => createWebhookPositiveSafeIntegerTextParser(
        invalid as never,
      )).toThrow('invalid trusted preset');
    }

    const getter = vi.fn(() => Number.MAX_SAFE_INTEGER);
    const accessor = { kind: PRESET.kind } as Record<string, unknown>;
    Object.defineProperty(accessor, 'max_value', {
      enumerable: true,
      get: getter,
    });
    expect(() => createWebhookPositiveSafeIntegerTextParser(
      accessor as never,
    )).toThrow('invalid trusted preset');
    expect(getter).not.toHaveBeenCalled();
  });

  it('copies trusted data and locks the core credential-version selection', () => {
    const input = {
      kind: 'positive_safe_integer_text.v1' as const,
      max_value: 100,
    };
    const parser = createWebhookPositiveSafeIntegerTextParser(input);
    input.max_value = 1;
    expect(parser.preset).toEqual({
      kind: 'positive_safe_integer_text.v1',
      max_value: 100,
    });
    expect(parser.parse('100')).toEqual({ ok: true, text: '100', value: 100 });

    expect(WEBHOOK_CREDENTIAL_VERSION_PARSER.preset).toEqual(PRESET);
    expect(WEBHOOK_CREDENTIAL_VERSION_PARSER.parse(
      String(Number.MAX_SAFE_INTEGER),
    )).toEqual({
      ok: true,
      text: String(Number.MAX_SAFE_INTEGER),
      value: Number.MAX_SAFE_INTEGER,
    });
    expect(Object.isFrozen(WEBHOOK_CREDENTIAL_VERSION_PARSER)).toBe(true);
  });
});
