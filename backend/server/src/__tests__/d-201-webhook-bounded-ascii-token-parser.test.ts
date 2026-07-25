import { describe, expect, it, vi } from 'vitest';

import {
  isValidTelegramWebhookSecret,
} from '../connections/providers/telegram-webhook-protocol.js';
import {
  createWebhookBoundedAsciiTokenParser,
} from '../webhook-bounded-ascii-token-parser.js';
import {
  webhookStaticHeaderTokenDeliveryProfilePreset,
} from '../webhook-delivery-engine-presets.js';
import {
  WEBHOOK_BOUNDED_ASCII_CREDENTIAL_PROFILE_PRESETS,
  webhookBoundedAsciiCredentialProfilePreset,
} from '../webhook-shared-profile-parser-presets.js';

const PRESET = {
  kind: 'bounded_ascii_token.v1',
  max_characters: 256,
} as const;

describe('D-201 Slice 9AW bounded ASCII-token parser', () => {
  it('accepts nonempty bounded ASCII-token grammars', () => {
    const parser = createWebhookBoundedAsciiTokenParser(PRESET);
    for (const value of [
      'a',
      'AZaz09_-',
      'x'.repeat(256),
    ]) {
      expect(parser.parse(value)).toBe(value);
    }
    const largest = createWebhookBoundedAsciiTokenParser({
      kind: 'bounded_ascii_token.v1',
      max_characters: 65_536,
    });
    const largestValue = 'x'.repeat(65_536);
    expect(largest.parse(largestValue)).toBe(largestValue);
    expect(Object.isFrozen(parser)).toBe(true);
    expect(Object.isFrozen(parser.preset)).toBe(true);
    expect(() => JSON.stringify(parser.preset)).not.toThrow();
  });

  it('rejects emptiness, excess length, wrong alphabets, and coercion', () => {
    const parser = createWebhookBoundedAsciiTokenParser(PRESET);
    for (const value of [
      '',
      'x'.repeat(257),
      'with.dot',
      'with space',
      'with\nnewline',
      'with\rreturn',
      'with\u0000nul',
      'é',
      null,
      1,
      new String('boxed_token'),
      { toString: () => 'coerced_token' },
    ]) {
      expect(parser.parse(value)).toBeNull();
    }
  });

  it('preserves the Telegram protocol secret grammar exactly', () => {
    const parser = createWebhookBoundedAsciiTokenParser(PRESET);
    const legacy = (value: unknown): string | null =>
      isValidTelegramWebhookSecret(value) ? value : null;
    const alphabet = 'aAzZ019_-. *\n\r\u0000é';
    let state = 0x9a5701;
    const next = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    const candidates: unknown[] = [
      '',
      'a',
      'AZaz09_-',
      'x'.repeat(256),
      'x'.repeat(257),
      null,
      1,
      new String('boxed_token'),
    ];
    while (candidates.length < 20_008) {
      const length = next() % 300;
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
    expect(() => createWebhookBoundedAsciiTokenParser(PRESET)).not.toThrow();
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'owner_regex.v1' },
      { ...PRESET, max_characters: 0 },
      { ...PRESET, max_characters: 65_537 },
      { ...PRESET, max_characters: 256.5 },
      { ...PRESET, max_characters: Number.NaN },
      Object.create(PRESET),
      new Proxy({}, {
        ownKeys() {
          throw new Error('hostile bounded ASCII-token preset');
        },
      }),
    ]) {
      expect(() => createWebhookBoundedAsciiTokenParser(invalid as never))
        .toThrow('invalid trusted preset');
    }

    const getter = vi.fn(() => 256);
    const accessor = {
      kind: 'bounded_ascii_token.v1',
    } as Record<string, unknown>;
    Object.defineProperty(accessor, 'max_characters', {
      enumerable: true,
      get: getter,
    });
    expect(() => createWebhookBoundedAsciiTokenParser(accessor as never))
      .toThrow('invalid trusted preset');
    expect(getter).not.toHaveBeenCalled();
  });

  it('copies and freezes the trusted character ceiling', () => {
    const input = {
      kind: 'bounded_ascii_token.v1' as const,
      max_characters: 4,
    };
    const parser = createWebhookBoundedAsciiTokenParser(input);
    input.max_characters = 5;

    expect(parser.preset).toEqual({
      kind: 'bounded_ascii_token.v1',
      max_characters: 4,
    });
    expect(parser.parse('Ab_1')).toBe('Ab_1');
    expect(parser.parse('Ab_12')).toBeNull();
  });

  it('binds the Telegram credential grammar across trusted profile data and delivery', () => {
    const selected = webhookBoundedAsciiCredentialProfilePreset(
      'telegram.bot-webhook.v1',
    );
    expect(selected).toEqual({
      profile_id: 'telegram.bot-webhook.v1',
      credential_field: 'secret_token',
      parser: PRESET,
    });
    expect(webhookBoundedAsciiCredentialProfilePreset(
      'github.webhook.v1',
    )).toBeNull();
    expect(Object.values(
      WEBHOOK_BOUNDED_ASCII_CREDENTIAL_PROFILE_PRESETS,
    ).map((value) => value?.profile_id)).toEqual([
      'telegram.bot-webhook.v1',
    ]);
    expect(Object.getPrototypeOf(
      WEBHOOK_BOUNDED_ASCII_CREDENTIAL_PROFILE_PRESETS,
    )).toBeNull();
    expect(Object.isFrozen(
      WEBHOOK_BOUNDED_ASCII_CREDENTIAL_PROFILE_PRESETS,
    )).toBe(true);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected?.parser)).toBe(true);
    expect(() => JSON.stringify(selected)).not.toThrow();

    const delivery = webhookStaticHeaderTokenDeliveryProfilePreset(
      'telegram.bot-webhook.v1',
    );
    expect(delivery?.mechanism.token_field).toBe(
      selected?.credential_field,
    );
    expect(delivery?.mechanism.token_shape).toEqual(selected?.parser);
  });
});
