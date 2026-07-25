import { describe, expect, it, vi } from 'vitest';

import {
  createWebhookRegistrationIdempotencyKeyParser,
} from '../webhook-registration-idempotency-key-parser.js';
import {
  WEBHOOK_REGISTRATION_IDEMPOTENCY_KEY_PROFILE_PRESETS,
  webhookRegistrationIdempotencyKeyProfilePreset,
} from '../webhook-registration-idempotency-key-profile-presets.js';

const PRESET = {
  kind: 'ascii_registration_idempotency_key.v1',
  max_characters: 255,
} as const;

describe('D-201 Slices 9AJ-9AM registration idempotency-key parser', () => {
  it('admits only the fixed ASCII alphabet through the trusted ceiling', () => {
    const parser = createWebhookRegistrationIdempotencyKeyParser(PRESET);

    expect(parser.parse('AaZz09._:-')).toBe('AaZz09._:-');
    expect(parser.parse('a'.repeat(255))).toBe('a'.repeat(255));
    expect(Object.isFrozen(parser)).toBe(true);
    expect(Object.isFrozen(parser.preset)).toBe(true);
    expect(() => JSON.stringify(parser.preset)).not.toThrow();
  });

  it.each([
    null,
    undefined,
    1,
    new String('key'),
    '',
    'contains space',
    'contains/slash',
    'contains\nnewline',
    'contains\u0000control',
    'unicode-é',
    'a'.repeat(256),
  ])('rejects nonprimitive, non-ASCII, or out-of-bound input: %j', (value) => {
    const parser = createWebhookRegistrationIdempotencyKeyParser(PRESET);
    expect(parser.parse(value)).toBeNull();
  });

  it('accepts only exact bounded trusted presets without executing accessors', () => {
    expect(() => createWebhookRegistrationIdempotencyKeyParser(PRESET))
      .not.toThrow();
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'owner_regex.v1' },
      { ...PRESET, max_characters: 0 },
      { ...PRESET, max_characters: 256 },
      { ...PRESET, max_characters: 1.5 },
      Object.create(PRESET),
      new Proxy({}, {
        ownKeys() {
          throw new Error('hostile idempotency-key preset');
        },
      }),
    ]) {
      expect(() => createWebhookRegistrationIdempotencyKeyParser(
        invalid as never,
      )).toThrow('invalid trusted preset');
    }

    const getter = vi.fn(() => 255);
    const accessor = {
      kind: 'ascii_registration_idempotency_key.v1',
    } as Record<string, unknown>;
    Object.defineProperty(accessor, 'max_characters', {
      enumerable: true,
      get: getter,
    });
    expect(() => createWebhookRegistrationIdempotencyKeyParser(
      accessor as never,
    )).toThrow('invalid trusted preset');
    expect(getter).not.toHaveBeenCalled();
  });

  it('binds managed providers through trusted profile data only', () => {
    const stripe = webhookRegistrationIdempotencyKeyProfilePreset(
      'stripe.event.v1',
    );
    expect(stripe).toEqual({
      profile_id: 'stripe.event.v1',
      parser: PRESET,
    });
    const paddle = webhookRegistrationIdempotencyKeyProfilePreset(
      'paddle.notification.v1',
    );
    expect(paddle).toEqual({
      profile_id: 'paddle.notification.v1',
      parser: PRESET,
    });
    const github = webhookRegistrationIdempotencyKeyProfilePreset(
      'github.webhook.v1',
    );
    expect(github).toEqual({
      profile_id: 'github.webhook.v1',
      parser: PRESET,
    });
    const telegram = webhookRegistrationIdempotencyKeyProfilePreset(
      'telegram.bot-webhook.v1',
    );
    expect(telegram).toEqual({
      profile_id: 'telegram.bot-webhook.v1',
      parser: PRESET,
    });
    expect(Object.keys(
      WEBHOOK_REGISTRATION_IDEMPOTENCY_KEY_PROFILE_PRESETS,
    )).toEqual([
      'stripe.event.v1',
      'paddle.notification.v1',
      'github.webhook.v1',
      'telegram.bot-webhook.v1',
    ]);
    expect(Object.getPrototypeOf(
      WEBHOOK_REGISTRATION_IDEMPOTENCY_KEY_PROFILE_PRESETS,
    )).toBeNull();
    expect(Object.isFrozen(
      WEBHOOK_REGISTRATION_IDEMPOTENCY_KEY_PROFILE_PRESETS,
    )).toBe(true);
    expect(Object.isFrozen(stripe)).toBe(true);
    expect(Object.isFrozen(stripe?.parser)).toBe(true);
    expect(Object.isFrozen(paddle)).toBe(true);
    expect(Object.isFrozen(paddle?.parser)).toBe(true);
    expect(Object.isFrozen(github)).toBe(true);
    expect(Object.isFrozen(github?.parser)).toBe(true);
    expect(Object.isFrozen(telegram)).toBe(true);
    expect(Object.isFrozen(telegram?.parser)).toBe(true);
    expect(() => JSON.stringify([stripe, paddle, github, telegram])).not.toThrow();
  });
});
