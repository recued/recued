import { describe, expect, it, vi } from 'vitest';

import {
  createWebhookFixedLengthAsciiTokenParser,
} from '../webhook-fixed-length-ascii-token-parser.js';
import {
  webhookRawBodyHmacDeliveryProfilePreset,
} from '../webhook-delivery-engine-presets.js';
import {
  WEBHOOK_FIXED_LENGTH_ASCII_CREDENTIAL_PROFILE_PRESETS,
  webhookFixedLengthAsciiCredentialProfilePreset,
} from '../webhook-shared-profile-parser-presets.js';

const PRESET = {
  kind: 'fixed_length_ascii_token.v1',
  characters: 43,
} as const;
const SECRET = 'Ab09_-'.repeat(7) + 'A';

describe('D-201 Slice 9AV fixed-length ASCII-token parser', () => {
  it('accepts exact bounded ASCII-token grammars', () => {
    const parser = createWebhookFixedLengthAsciiTokenParser(PRESET);
    expect(parser.parse(SECRET)).toBe(SECRET);
    expect(createWebhookFixedLengthAsciiTokenParser({
      kind: 'fixed_length_ascii_token.v1',
      characters: 1,
    }).parse('_')).toBe('_');
    const largest = createWebhookFixedLengthAsciiTokenParser({
      kind: 'fixed_length_ascii_token.v1',
      characters: 65_536,
    });
    expect(largest.parse('x'.repeat(65_536))).toBe('x'.repeat(65_536));
    expect(Object.isFrozen(parser)).toBe(true);
    expect(Object.isFrozen(parser.preset)).toBe(true);
    expect(() => JSON.stringify(parser.preset)).not.toThrow();
  });

  it('rejects wrong lengths, alphabets, whitespace, controls, and coercion', () => {
    const parser = createWebhookFixedLengthAsciiTokenParser(PRESET);
    for (const value of [
      '',
      'A'.repeat(42),
      'A'.repeat(44),
      `${'A'.repeat(42)}.`,
      `${'A'.repeat(42)} `,
      `${'A'.repeat(42)}\n`,
      `${'A'.repeat(42)}\r`,
      `${'A'.repeat(42)}\u0000`,
      `${'A'.repeat(42)}é`,
      null,
      1,
      new String(SECRET),
      { toString: () => SECRET },
    ]) {
      expect(parser.parse(value)).toBeNull();
    }
  });

  it('preserves the former GitHub generated-secret grammar exactly', () => {
    const parser = createWebhookFixedLengthAsciiTokenParser(PRESET);
    const legacy = (value: unknown): string | null => typeof value === 'string'
      && /^[A-Za-z0-9_-]{43}$/.test(value)
      ? value
      : null;
    const alphabet = 'aAzZ019_-. *\n\r\u0000é';
    let state = 0x9a5601;
    const next = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    const candidates: unknown[] = [
      '',
      SECRET,
      'A'.repeat(42),
      'A'.repeat(44),
      `${'A'.repeat(42)}!`,
      null,
      1,
      new String(SECRET),
    ];
    while (candidates.length < 20_008) {
      const length = next() % 88;
      let value = '';
      for (let index = 0; index < length; index += 1) {
        value += alphabet[next() % alphabet.length];
      }
      candidates.push(value);
    }

    for (const candidate of candidates) {
      expect(parser.parse(candidate)).toBe(legacy(candidate));
    }
  });

  it('accepts only exact own-data bounded presets without accessors', () => {
    expect(() => createWebhookFixedLengthAsciiTokenParser(PRESET)).not.toThrow();
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'owner_regex.v1' },
      { ...PRESET, characters: 0 },
      { ...PRESET, characters: 65_537 },
      { ...PRESET, characters: 43.5 },
      { ...PRESET, characters: Number.NaN },
      Object.create(PRESET),
      new Proxy({}, {
        ownKeys() {
          throw new Error('hostile fixed-length ASCII-token preset');
        },
      }),
    ]) {
      expect(() => createWebhookFixedLengthAsciiTokenParser(invalid as never))
        .toThrow('invalid trusted preset');
    }

    const getter = vi.fn(() => 43);
    const accessor = {
      kind: 'fixed_length_ascii_token.v1',
    } as Record<string, unknown>;
    Object.defineProperty(accessor, 'characters', {
      enumerable: true,
      get: getter,
    });
    expect(() => createWebhookFixedLengthAsciiTokenParser(accessor as never))
      .toThrow('invalid trusted preset');
    expect(getter).not.toHaveBeenCalled();
  });

  it('copies and freezes the trusted character count', () => {
    const input = {
      kind: 'fixed_length_ascii_token.v1' as const,
      characters: 4,
    };
    const parser = createWebhookFixedLengthAsciiTokenParser(input);
    input.characters = 5;

    expect(parser.preset).toEqual({
      kind: 'fixed_length_ascii_token.v1',
      characters: 4,
    });
    expect(parser.parse('Ab_1')).toBe('Ab_1');
    expect(parser.parse('Ab_12')).toBeNull();
  });

  it('binds the GitHub credential grammar across trusted profile data and delivery', () => {
    const selected = webhookFixedLengthAsciiCredentialProfilePreset(
      'github.webhook.v1',
    );
    expect(selected).toEqual({
      profile_id: 'github.webhook.v1',
      credential_field: 'webhook_secret',
      parser: PRESET,
    });
    expect(webhookFixedLengthAsciiCredentialProfilePreset(
      'telegram.bot-webhook.v1',
    )).toBeNull();
    expect(Object.values(
      WEBHOOK_FIXED_LENGTH_ASCII_CREDENTIAL_PROFILE_PRESETS,
    ).map((value) => value?.profile_id)).toEqual(['github.webhook.v1']);
    expect(Object.getPrototypeOf(
      WEBHOOK_FIXED_LENGTH_ASCII_CREDENTIAL_PROFILE_PRESETS,
    )).toBeNull();
    expect(Object.isFrozen(
      WEBHOOK_FIXED_LENGTH_ASCII_CREDENTIAL_PROFILE_PRESETS,
    )).toBe(true);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected?.parser)).toBe(true);
    expect(() => JSON.stringify(selected)).not.toThrow();

    const delivery = webhookRawBodyHmacDeliveryProfilePreset(
      'github.webhook.v1',
    );
    expect(delivery?.mechanism.secret_field).toBe(
      selected?.credential_field,
    );
    expect(delivery?.mechanism.secret_shape).toEqual(selected?.parser);
  });
});
