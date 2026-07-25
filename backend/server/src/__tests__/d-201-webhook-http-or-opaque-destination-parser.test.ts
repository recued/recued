import { describe, expect, it, vi } from 'vitest';

import {
  createWebhookHttpOrOpaqueDestinationParser,
} from '../webhook-http-or-opaque-destination-parser.js';
import {
  WEBHOOK_REGISTRATION_DESTINATION_PROFILE_PRESETS,
  webhookRegistrationDestinationProfilePreset,
} from '../webhook-registration-destination-profile-presets.js';

const PRESET = {
  kind: 'http_or_opaque_destination.v1',
  max_characters: 2_048,
  http_url_discriminator: 'url',
  opaque_discriminator: 'email',
} as const;

const legacyBoundedRemoteDestination = (value: unknown): string | null => {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 2_048
    || /[\u0000-\u001f\u007f]/.test(value)) {
    return null;
  }
  return value;
};

const legacyBoundedRemoteUrl = (value: unknown): string | null => {
  const destination = legacyBoundedRemoteDestination(value);
  if (destination === null) return null;
  try {
    const parsed = new URL(destination);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:')
      && parsed.username.length === 0
      && parsed.password.length === 0
      ? destination
      : null;
  } catch {
    return null;
  }
};

const legacyParse = (discriminator: unknown, value: unknown): string | null =>
  discriminator === 'url'
    ? legacyBoundedRemoteUrl(value)
    : discriminator === 'email'
      ? legacyBoundedRemoteDestination(value)
      : null;

describe('D-201 Slice 9AZ HTTP-or-opaque destination parser', () => {
  it('preserves typed HTTP(S) and opaque destinations without rewriting', () => {
    const parser = createWebhookHttpOrOpaqueDestinationParser(PRESET);
    for (const value of [
      'https://hooks.example.test/path?query=1#fragment',
      'http://hooks.example.test:8080/hook',
      'HTTPS://hooks.example.test/hook',
      ' https://hooks.example.test/hook ',
      'https://@hooks.example.test/hook',
    ]) {
      expect(parser.parse('url', value)).toBe(value);
    }
    for (const value of [
      'owner@example.test',
      'not required to be an email address',
      ' surrounding opaque whitespace ',
      'opaque-üñîcode-destination',
    ]) {
      expect(parser.parse('email', value)).toBe(value);
    }
    expect(Object.isFrozen(parser)).toBe(true);
    expect(Object.isFrozen(parser.preset)).toBe(true);
    expect(() => JSON.stringify(parser.preset)).not.toThrow();
  });

  it('rejects unknown types, invalid HTTP URLs, controls, bounds, and coercion', () => {
    const parser = createWebhookHttpOrOpaqueDestinationParser(PRESET);
    for (const [discriminator, value] of [
      ['sms', 'owner@example.test'],
      ['url', 'owner@example.test'],
      ['url', 'ftp://hooks.example.test/hook'],
      ['url', 'https://user@hooks.example.test/hook'],
      ['url', 'https://user:pass@hooks.example.test/hook'],
      ['url', 'https://hooks.example.test:65536/hook'],
      ['email', ''],
      ['email', 'owner\n@example.test'],
      ['email', 'x'.repeat(2_049)],
      ['email', null],
      ['email', new String('owner@example.test')],
    ] as const) {
      expect(parser.parse(discriminator, value)).toBeNull();
    }
  });

  it('preserves Paddle destination acceptance exactly across both wire types', () => {
    const parser = createWebhookHttpOrOpaqueDestinationParser(PRESET);
    const candidates: unknown[] = [
      null,
      1,
      new String('owner@example.test'),
      '',
      ' ',
      'owner@example.test',
      'not-an-email',
      'owner\t@example.test',
      'https://hooks.example.test/hook',
      'http://hooks.example.test:8080/hook?query=1#fragment',
      'HTTPS://hooks.example.test/hook',
      'https:hooks.example.test/hook',
      'https://@hooks.example.test/hook',
      'https://user@hooks.example.test/hook',
      'ftp://hooks.example.test/hook',
      'x'.repeat(2_048),
      'x'.repeat(2_049),
    ];
    for (const discriminator of ['url', 'email', 'sms']) {
      for (const candidate of candidates) {
        expect(parser.parse(discriminator, candidate))
          .toBe(legacyParse(discriminator, candidate));
      }
    }
  });

  it('uses the exact legacy UTF-16 code-unit boundary rather than a byte bound', () => {
    const parser = createWebhookHttpOrOpaqueDestinationParser(PRESET);
    const exact = 'é'.repeat(PRESET.max_characters);
    expect(exact).toHaveLength(PRESET.max_characters);
    expect(Buffer.byteLength(exact, 'utf8')).toBe(PRESET.max_characters * 2);
    expect(parser.parse('email', exact)).toBe(exact);
    expect(parser.parse('email', `${exact}x`)).toBeNull();
  });

  it('accepts only exact own-data presets without invoking accessors', () => {
    expect(() => createWebhookHttpOrOpaqueDestinationParser(PRESET)).not.toThrow();
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'vendor_destination_callback.v1' },
      { ...PRESET, max_characters: 0 },
      { ...PRESET, max_characters: 65_537 },
      { ...PRESET, max_characters: 2_048.5 },
      { ...PRESET, http_url_discriminator: 'URL' },
      { ...PRESET, opaque_discriminator: 'url' },
      Object.create(PRESET),
      new Proxy({}, {
        ownKeys() {
          throw new Error('hostile destination preset');
        },
      }),
    ]) {
      expect(() => createWebhookHttpOrOpaqueDestinationParser(invalid as never))
        .toThrow('invalid trusted preset');
    }

    const getter = vi.fn(() => 2_048);
    const accessor = {
      kind: 'http_or_opaque_destination.v1',
      http_url_discriminator: 'url',
      opaque_discriminator: 'email',
    } as Record<string, unknown>;
    Object.defineProperty(accessor, 'max_characters', {
      enumerable: true,
      get: getter,
    });
    expect(() => createWebhookHttpOrOpaqueDestinationParser(accessor as never))
      .toThrow('invalid trusted preset');
    expect(getter).not.toHaveBeenCalled();
  });

  it('copies settings and exposes only the Paddle trusted destination role', () => {
    const input = {
      kind: 'http_or_opaque_destination.v1' as const,
      max_characters: 128,
      http_url_discriminator: 'callback',
      opaque_discriminator: 'mailbox',
    };
    const parser = createWebhookHttpOrOpaqueDestinationParser(input);
    input.max_characters = 1;
    input.http_url_discriminator = 'changed';
    expect(parser.preset).toEqual({
      kind: 'http_or_opaque_destination.v1',
      max_characters: 128,
      http_url_discriminator: 'callback',
      opaque_discriminator: 'mailbox',
    });

    const selected = webhookRegistrationDestinationProfilePreset(
      'paddle.notification.v1',
    );
    expect(selected).toEqual({
      profile_id: 'paddle.notification.v1',
      parser: PRESET,
    });
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected?.parser)).toBe(true);
    for (const profileId of [
      'stripe.event.v1',
      'github.webhook.v1',
      'telegram.bot-webhook.v1',
    ] as const) {
      expect(webhookRegistrationDestinationProfilePreset(profileId)).toBeNull();
    }
    expect(Object.keys(WEBHOOK_REGISTRATION_DESTINATION_PROFILE_PRESETS))
      .toEqual(['paddle.notification.v1']);
    expect(Object.getPrototypeOf(
      WEBHOOK_REGISTRATION_DESTINATION_PROFILE_PRESETS,
    )).toBeNull();
    expect(Object.isFrozen(
      WEBHOOK_REGISTRATION_DESTINATION_PROFILE_PRESETS,
    )).toBe(true);
  });
});
