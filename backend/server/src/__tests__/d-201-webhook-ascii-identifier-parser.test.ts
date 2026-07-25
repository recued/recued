import { describe, expect, it, vi } from 'vitest';

import {
  createWebhookAsciiIdentifierParser,
} from '../webhook-ascii-identifier-parser.js';
import {
  WEBHOOK_ASCII_IDENTIFIER_EVENT_TYPE_PROFILE_PRESETS,
  webhookAsciiIdentifierEventTypeProfilePreset,
} from '../webhook-shared-profile-parser-presets.js';

const PRESET = {
  kind: 'ascii_identifier.v1',
  max_bytes: 128,
} as const;

describe('D-201 Slice 9AR ASCII identifier parser', () => {
  it('accepts the bounded mixed-case ASCII identifier grammar', () => {
    const parser = createWebhookAsciiIdentifierParser(PRESET);
    for (const value of [
      'A',
      'z',
      'Edited_Message9',
      `E${'v'.repeat(127)}`,
    ]) {
      expect(parser.parse(value)).toBe(value);
    }
    expect(Object.isFrozen(parser)).toBe(true);
    expect(Object.isFrozen(parser.preset)).toBe(true);
    expect(() => JSON.stringify(parser.preset)).not.toThrow();
  });

  it('rejects wrong alphabets, bounds, controls, and coercion', () => {
    const parser = createWebhookAsciiIdentifierParser(PRESET);
    for (const value of [
      '',
      '9message',
      '_message',
      'edited.message',
      'edited-message',
      'edited/message',
      'edited:message',
      `E${'v'.repeat(128)}`,
      'message\n',
      'message\r',
      'message\u0000',
      'message\u2028',
      'é',
      null,
      1,
      new String('message'),
    ]) {
      expect(parser.parse(value)).toBeNull();
    }
  });

  it('preserves the retired Telegram primitive-string grammar exactly', () => {
    const parser = createWebhookAsciiIdentifierParser(PRESET);
    const legacy = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
    const alphabet = 'aAzZ019_+-. /:\n\r\u0000é';
    let state = 0x9a201;
    const next = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    const candidates = [
      '',
      'A',
      'message',
      'Edited_Message9',
      `E${'v'.repeat(127)}`,
      `E${'v'.repeat(128)}`,
    ];
    while (candidates.length < 20_006) {
      const length = next() % 140;
      let candidate = '';
      for (let index = 0; index < length; index += 1) {
        candidate += alphabet[next() % alphabet.length];
      }
      candidates.push(candidate);
    }

    for (const candidate of candidates) {
      expect(parser.parse(candidate)).toBe(
        legacy.test(candidate) ? candidate : null,
      );
    }
  });

  it('accepts only exact own-data bounded presets without accessors', () => {
    expect(() => createWebhookAsciiIdentifierParser(PRESET)).not.toThrow();
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'owner_regex.v1' },
      { ...PRESET, max_bytes: 0 },
      { ...PRESET, max_bytes: 129 },
      { ...PRESET, max_bytes: 1.5 },
      Object.create(PRESET),
      new Proxy({}, {
        ownKeys() {
          throw new Error('hostile ASCII identifier preset');
        },
      }),
    ]) {
      expect(() => createWebhookAsciiIdentifierParser(invalid as never))
        .toThrow('invalid trusted preset');
    }

    const getter = vi.fn(() => 128);
    const accessor = { kind: 'ascii_identifier.v1' } as Record<string, unknown>;
    Object.defineProperty(accessor, 'max_bytes', {
      enumerable: true,
      get: getter,
    });
    expect(() => createWebhookAsciiIdentifierParser(accessor as never))
      .toThrow('invalid trusted preset');
    expect(getter).not.toHaveBeenCalled();
  });

  it('binds Telegram event types through trusted profile data', () => {
    const selected = webhookAsciiIdentifierEventTypeProfilePreset(
      'telegram.bot-webhook.v1',
    );
    expect(selected).toEqual({
      profile_id: 'telegram.bot-webhook.v1',
      parser: PRESET,
    });
    expect(webhookAsciiIdentifierEventTypeProfilePreset(
      'github.webhook.v1',
    )).toBeNull();
    expect(Object.values(
      WEBHOOK_ASCII_IDENTIFIER_EVENT_TYPE_PROFILE_PRESETS,
    ).map((value) => value?.profile_id))
      .toEqual(['telegram.bot-webhook.v1']);
    expect(Object.getPrototypeOf(
      WEBHOOK_ASCII_IDENTIFIER_EVENT_TYPE_PROFILE_PRESETS,
    )).toBeNull();
    expect(Object.isFrozen(
      WEBHOOK_ASCII_IDENTIFIER_EVENT_TYPE_PROFILE_PRESETS,
    )).toBe(true);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected?.parser)).toBe(true);
    expect(() => JSON.stringify(selected)).not.toThrow();
  });
});
