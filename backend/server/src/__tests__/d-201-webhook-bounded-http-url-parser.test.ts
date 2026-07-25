import { describe, expect, it, vi } from 'vitest';

import {
  createWebhookBoundedHttpUrlParser,
} from '../webhook-bounded-http-url-parser.js';
import {
  WEBHOOK_REGISTRATION_REMOTE_URL_PROFILE_PRESETS,
  webhookRegistrationRemoteUrlProfilePreset,
} from '../webhook-registration-remote-url-profile-presets.js';

const PRESET = {
  kind: 'bounded_http_url.v1',
  max_bytes: 4_096,
} as const;

const legacyBoundedRemoteUrl = (value: unknown): string | null => {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4_096) {
    return null;
  }
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:')
      && parsed.username.length === 0
      && parsed.password.length === 0
      ? value
      : null;
  } catch {
    return null;
  }
};

describe('D-201 Slice 9AY bounded HTTP(S) URL parser', () => {
  it('accepts provider-returned HTTP and HTTPS URL spellings without rewriting', () => {
    const parser = createWebhookBoundedHttpUrlParser(PRESET);
    for (const value of [
      'https://hooks.example.test/v1/webhooks/opaque',
      'http://hooks.example.test:8080/hook?source=legacy#fragment',
      'HTTPS://hooks.example.test:443/hook',
      'https:hooks.example.test/hook',
      'https:/hooks.example.test/hook',
      'https:///hooks.example.test/hook',
      'https://@hooks.example.test/hook',
      ' https://hooks.example.test/hook ',
      'https://münich.example/hook',
      'http://[2001:db8::1]:8080/hook',
    ]) {
      expect(parser.parse(value)).toBe(value);
    }
    expect(Object.isFrozen(parser)).toBe(true);
    expect(Object.isFrozen(parser.preset)).toBe(true);
    expect(() => JSON.stringify(parser.preset)).not.toThrow();
  });

  it('rejects other protocols, nonempty userinfo, invalid URLs, bounds, and coercion', () => {
    const parser = createWebhookBoundedHttpUrlParser(PRESET);
    for (const value of [
      '',
      '/relative/hook',
      'ftp://hooks.example.test/hook',
      'file:///tmp/hook',
      'ws://hooks.example.test/hook',
      'https://user@hooks.example.test/hook',
      'https://user:pass@hooks.example.test/hook',
      'https://hooks.example.test:65536/hook',
      `https://hooks.example.test/${'x'.repeat(4_096)}`,
      null,
      443,
      new String('https://hooks.example.test/hook'),
      { toString: () => 'https://hooks.example.test/hook' },
    ]) {
      expect(parser.parse(value)).toBeNull();
    }
  });

  it('preserves the duplicate Stripe and GitHub read-back grammar exactly', () => {
    const parser = createWebhookBoundedHttpUrlParser(PRESET);
    const candidates: unknown[] = [
      null,
      443,
      new String('https://hooks.example.test/hook'),
      `https://hooks.example.test/${'é'.repeat(2_100)}`,
      'https://hooks.example.test/hook?',
      'https://hooks.example.test/hook#',
      'https://@hooks.example.test/hook',
      'https:hooks.example.test/hook',
    ];
    for (const scheme of ['http', 'HTTP', 'https', 'HTTPS', 'ftp', 'ws']) {
      for (const authority of [
        'hooks.example.test',
        '@hooks.example.test',
        ':@hooks.example.test',
        'user@hooks.example.test',
        'user:pass@hooks.example.test',
      ]) {
        for (const port of ['', ':80', ':443', ':8080', ':65535', ':65536']) {
          for (const suffix of [
            '/hook',
            '/hook?query=1',
            '/hook#fragment',
            '/hook?query=1#fragment',
          ]) {
            const value = `${scheme}://${authority}${port}${suffix}`;
            candidates.push(value, ` ${value} `, `${value}\n`);
          }
        }
      }
    }

    for (const candidate of candidates) {
      expect(parser.parse(candidate)).toBe(legacyBoundedRemoteUrl(candidate));
    }
  });

  it('enforces the UTF-8 byte ceiling at the exact boundary', () => {
    const parser = createWebhookBoundedHttpUrlParser(PRESET);
    const prefix = 'https://hooks.example.test/';
    const remaining = PRESET.max_bytes - Buffer.byteLength(prefix, 'utf8');
    const exactAscii = `${prefix}${'x'.repeat(remaining)}`;
    const exactMultibyte = `${prefix}${'x'.repeat(remaining - 2)}é`;

    expect(Buffer.byteLength(exactAscii, 'utf8')).toBe(PRESET.max_bytes);
    expect(Buffer.byteLength(exactMultibyte, 'utf8')).toBe(PRESET.max_bytes);
    expect(parser.parse(exactAscii)).toBe(exactAscii);
    expect(parser.parse(exactMultibyte)).toBe(exactMultibyte);
    expect(parser.parse(`${exactAscii}x`)).toBeNull();
    expect(parser.parse(`${exactMultibyte}x`)).toBeNull();
  });

  it('accepts only exact own-data presets without invoking accessors', () => {
    expect(() => createWebhookBoundedHttpUrlParser(PRESET)).not.toThrow();
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'owner_url_callback.v1' },
      { ...PRESET, max_bytes: 0 },
      { ...PRESET, max_bytes: 65_537 },
      { ...PRESET, max_bytes: 4_096.5 },
      { ...PRESET, max_bytes: Number.NaN },
      Object.create(PRESET),
      new Proxy({}, {
        ownKeys() {
          throw new Error('hostile bounded HTTP URL preset');
        },
      }),
    ]) {
      expect(() => createWebhookBoundedHttpUrlParser(invalid as never))
        .toThrow('invalid trusted preset');
    }

    const getter = vi.fn(() => 4_096);
    const accessor = { kind: 'bounded_http_url.v1' } as Record<string, unknown>;
    Object.defineProperty(accessor, 'max_bytes', {
      enumerable: true,
      get: getter,
    });
    expect(() => createWebhookBoundedHttpUrlParser(accessor as never))
      .toThrow('invalid trusted preset');
    expect(getter).not.toHaveBeenCalled();
  });

  it('copies bounds and exposes only Stripe and GitHub trusted profile data', () => {
    const input = {
      kind: 'bounded_http_url.v1' as const,
      max_bytes: 128,
    };
    const parser = createWebhookBoundedHttpUrlParser(input);
    input.max_bytes = 1;
    expect(parser.preset).toEqual({
      kind: 'bounded_http_url.v1',
      max_bytes: 128,
    });

    for (const profileId of ['stripe.event.v1', 'github.webhook.v1'] as const) {
      const selected = webhookRegistrationRemoteUrlProfilePreset(profileId);
      expect(selected).toEqual({ profile_id: profileId, parser: PRESET });
      expect(Object.isFrozen(selected)).toBe(true);
      expect(Object.isFrozen(selected?.parser)).toBe(true);
      expect(() => JSON.stringify(selected)).not.toThrow();
    }
    expect(webhookRegistrationRemoteUrlProfilePreset(
      'paddle.notification.v1',
    )).toBeNull();
    expect(webhookRegistrationRemoteUrlProfilePreset(
      'telegram.bot-webhook.v1',
    )).toBeNull();
    expect(Object.keys(WEBHOOK_REGISTRATION_REMOTE_URL_PROFILE_PRESETS))
      .toEqual(['stripe.event.v1', 'github.webhook.v1']);
    expect(Object.getPrototypeOf(
      WEBHOOK_REGISTRATION_REMOTE_URL_PROFILE_PRESETS,
    )).toBeNull();
    expect(Object.isFrozen(
      WEBHOOK_REGISTRATION_REMOTE_URL_PROFILE_PRESETS,
    )).toBe(true);
  });
});
