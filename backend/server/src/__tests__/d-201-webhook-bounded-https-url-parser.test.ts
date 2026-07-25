import { describe, expect, it, vi } from 'vitest';
import {
  TELEGRAM_SUPPORTED_PORTS,
  WEBHOOK_PROFILE_IDS,
} from '@recued/contracts';

import {
  isTelegramWebhookEndpointSupported,
} from '../connections/providers/telegram-webhook-protocol.js';
import {
  createWebhookBoundedHttpsUrlParser,
} from '../webhook-bounded-https-url-parser.js';
import {
  WEBHOOK_ENDPOINT_PROFILE_PRESETS,
  webhookEndpointProfilePreset,
} from '../webhook-endpoint-profile-presets.js';
import {
  BUILTIN_WEBHOOK_PROFILE_POLICIES,
} from '../webhook-profile-policy.js';

const PRESET = {
  kind: 'bounded_https_url.v1',
  max_bytes: 4_096,
  allowed_ports: [443, 80, 88, 8_443],
} as const;

describe('D-201 Slice 9AX bounded HTTPS URL parser', () => {
  it('accepts primitive HTTPS URLs on each selected port', () => {
    const parser = createWebhookBoundedHttpsUrlParser(PRESET);
    for (const value of [
      'https://hooks.example.test/v1/webhooks/opaque',
      'https://hooks.example.test:443/v1/webhooks/opaque',
      'https://hooks.example.test:80/v1/webhooks/opaque',
      'https://hooks.example.test:88/v1/webhooks/opaque',
      'https://hooks.example.test:8443/v1/webhooks/opaque',
      'HTTPS://hooks.example.test:8443/v1/webhooks/opaque',
      'https://[2001:db8::1]:8443/v1/webhooks/opaque',
    ]) {
      expect(parser.parse(value)).toBe(value);
    }
    expect(Object.isFrozen(parser)).toBe(true);
    expect(Object.isFrozen(parser.preset)).toBe(true);
    expect(Object.isFrozen(parser.preset.allowed_ports)).toBe(true);
    expect(() => JSON.stringify(parser.preset)).not.toThrow();
  });

  it('rejects wrong schemes, ports, authority components, bounds, and coercion', () => {
    const parser = createWebhookBoundedHttpsUrlParser(PRESET);
    for (const value of [
      '',
      '/v1/webhooks/opaque',
      'http://hooks.example.test:80/v1/webhooks/opaque',
      'ftp://hooks.example.test/v1/webhooks/opaque',
      'https://hooks.example.test:9443/v1/webhooks/opaque',
      'https://user@hooks.example.test/v1/webhooks/opaque',
      'https://user:pass@hooks.example.test/v1/webhooks/opaque',
      'https://hooks.example.test/v1/webhooks/opaque?authority=1',
      'https://hooks.example.test/v1/webhooks/opaque#authority',
      'https://hooks.example.test:65536/v1/webhooks/opaque',
      `https://hooks.example.test/${'x'.repeat(4_096)}`,
      null,
      443,
      new String('https://hooks.example.test/v1/webhooks/opaque'),
      { toString: () => 'https://hooks.example.test/v1/webhooks/opaque' },
    ]) {
      expect(parser.parse(value)).toBeNull();
    }
  });

  it('returns legacy raw spelling across WHATWG normalization edges', () => {
    const parser = createWebhookBoundedHttpsUrlParser(PRESET);
    for (const value of [
      'https://hooks.example.test/v1/webhooks/opaque?',
      'https://hooks.example.test/v1/webhooks/opaque#',
      'https://hooks.example.test/v1/webhooks/opaque?#',
      'https://@hooks.example.test/v1/webhooks/opaque',
      'https://:@hooks.example.test/v1/webhooks/opaque',
      'https:hooks.example.test/v1/webhooks/opaque',
      'https:/hooks.example.test/v1/webhooks/opaque',
      'https:///hooks.example.test/v1/webhooks/opaque',
      ' https://hooks.example.test/v1/webhooks/opaque ',
    ]) {
      expect(parser.parse(value)).toBe(value);
      expect(isTelegramWebhookEndpointSupported(value)).toBe(true);
    }
  });

  it('enforces the UTF-8 byte ceiling at the exact boundary', () => {
    const parser = createWebhookBoundedHttpsUrlParser(PRESET);
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
    expect(isTelegramWebhookEndpointSupported(exactAscii)).toBe(true);
    expect(isTelegramWebhookEndpointSupported(exactMultibyte)).toBe(true);
  });

  it('preserves the Telegram hosted-endpoint grammar exactly', () => {
    const parser = createWebhookBoundedHttpsUrlParser(PRESET);
    const legacy = (value: unknown): string | null =>
      isTelegramWebhookEndpointSupported(value) ? value : null;
    const candidates: unknown[] = [
      null,
      443,
      new String('https://hooks.example.test/v1/webhooks/opaque'),
      `https://hooks.example.test/${'x'.repeat(4_096)}`,
      'https://münich.example:8443/v1/webhooks/opaque',
      'https://[2001:db8::1]:88/v1/webhooks/opaque',
      'https://hooks.example.test/v1/webhooks/opaque?',
      'https://hooks.example.test/v1/webhooks/opaque#',
      'https://hooks.example.test/v1/webhooks/opaque?#',
      'https://@hooks.example.test/v1/webhooks/opaque',
      'https://:@hooks.example.test/v1/webhooks/opaque',
      'https:hooks.example.test/v1/webhooks/opaque',
      'https:/hooks.example.test/v1/webhooks/opaque',
      'https:///hooks.example.test/v1/webhooks/opaque',
    ];
    for (const scheme of ['https', 'HTTPS', 'http', 'ftp']) {
      for (const authority of [
        'hooks.example.test',
        'user@hooks.example.test',
        'user:pass@hooks.example.test',
      ]) {
        for (const port of [
          '',
          ':80',
          ':88',
          ':443',
          ':8443',
          ':9443',
          ':0',
          ':65536',
          ':not-a-port',
        ]) {
          for (const suffix of [
            '/v1/webhooks/opaque',
            '/v1/webhooks/opaque?query=1',
            '/v1/webhooks/opaque#fragment',
          ]) {
            const value = `${scheme}://${authority}${port}${suffix}`;
            candidates.push(value, ` ${value} `, `${value}\n`);
          }
        }
      }
    }

    for (const candidate of candidates) {
      expect(parser.parse(candidate)).toBe(legacy(candidate));
    }
  });

  it('accepts only exact own-data presets and dense unique port lists', () => {
    expect(() => createWebhookBoundedHttpsUrlParser(PRESET)).not.toThrow();
    const sparsePorts = new Array(1) as number[];
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'owner_url_callback.v1' },
      { ...PRESET, max_bytes: 0 },
      { ...PRESET, max_bytes: 65_537 },
      { ...PRESET, max_bytes: 4_096.5 },
      { ...PRESET, max_bytes: Number.NaN },
      { ...PRESET, allowed_ports: [] },
      { ...PRESET, allowed_ports: [0] },
      { ...PRESET, allowed_ports: [65_536] },
      { ...PRESET, allowed_ports: [443, 443] },
      { ...PRESET, allowed_ports: Array.from({ length: 33 }, (_, index) => index + 1) },
      { ...PRESET, allowed_ports: sparsePorts },
      { ...PRESET, allowed_ports: Object.create([443]) },
      Object.create(PRESET),
      new Proxy({}, {
        ownKeys() {
          throw new Error('hostile bounded HTTPS URL preset');
        },
      }),
    ]) {
      expect(() => createWebhookBoundedHttpsUrlParser(invalid as never))
        .toThrow('invalid trusted preset');
    }

    const maxBytesGetter = vi.fn(() => 4_096);
    const accessor = {
      kind: 'bounded_https_url.v1',
      allowed_ports: [443],
    } as Record<string, unknown>;
    Object.defineProperty(accessor, 'max_bytes', {
      enumerable: true,
      get: maxBytesGetter,
    });
    expect(() => createWebhookBoundedHttpsUrlParser(accessor as never))
      .toThrow('invalid trusted preset');
    expect(maxBytesGetter).not.toHaveBeenCalled();

    const portGetter = vi.fn(() => 443);
    const accessorPorts: number[] = [];
    Object.defineProperty(accessorPorts, 0, {
      enumerable: true,
      get: portGetter,
    });
    expect(() => createWebhookBoundedHttpsUrlParser({
      ...PRESET,
      allowed_ports: accessorPorts,
    } as never)).toThrow('invalid trusted preset');
    expect(portGetter).not.toHaveBeenCalled();
  });

  it('copies and deeply freezes trusted byte and port bounds', () => {
    const ports = [443, 8_443];
    const input = {
      kind: 'bounded_https_url.v1' as const,
      max_bytes: 128,
      allowed_ports: ports,
    };
    const parser = createWebhookBoundedHttpsUrlParser(input);
    input.max_bytes = 1;
    ports[0] = 9_443;
    ports.push(88);

    expect(parser.preset).toEqual({
      kind: 'bounded_https_url.v1',
      max_bytes: 128,
      allowed_ports: [443, 8_443],
    });
    expect(parser.parse('https://hooks.example.test/path')).toBe(
      'https://hooks.example.test/path',
    );
    expect(parser.parse('https://hooks.example.test:9443/path')).toBeNull();
  });

  it('binds Telegram manual and managed endpoint admission to one profile value', () => {
    const selected = webhookEndpointProfilePreset('telegram.bot-webhook.v1');
    expect(selected).toEqual({
      profile_id: 'telegram.bot-webhook.v1',
      parser: PRESET,
    });
    expect(selected?.parser.allowed_ports).toEqual(TELEGRAM_SUPPORTED_PORTS);
    expect(webhookEndpointProfilePreset('github.webhook.v1')).toBeNull();
    expect(Object.values(WEBHOOK_ENDPOINT_PROFILE_PRESETS)
      .map((value) => value?.profile_id)).toEqual([
      'telegram.bot-webhook.v1',
    ]);
    expect(Object.getPrototypeOf(WEBHOOK_ENDPOINT_PROFILE_PRESETS)).toBeNull();
    expect(Object.isFrozen(WEBHOOK_ENDPOINT_PROFILE_PRESETS)).toBe(true);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected?.parser)).toBe(true);
    expect(Object.isFrozen(selected?.parser.allowed_ports)).toBe(true);
    expect(() => JSON.stringify(selected)).not.toThrow();

    const policy = BUILTIN_WEBHOOK_PROFILE_POLICIES.get(
      'telegram.bot-webhook.v1',
    );
    for (const endpoint of [
      'https://hooks.example.test/v1/webhooks/opaque',
      'https://hooks.example.test:8443/v1/webhooks/opaque',
    ]) {
      expect(policy.endpointSupported(endpoint)).toBe(true);
    }
    expect(policy.endpointSupported(
      'https://hooks.example.test:9443/v1/webhooks/opaque',
    )).toBe(false);
    for (const profileId of WEBHOOK_PROFILE_IDS) {
      if (profileId === 'telegram.bot-webhook.v1') continue;
      expect(BUILTIN_WEBHOOK_PROFILE_POLICIES.get(profileId).endpointSupported(
        'https://hooks.example.test:9443/v1/webhooks/opaque',
      )).toBe(true);
    }
  });
});
