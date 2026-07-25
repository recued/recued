import { describe, expect, it, vi } from 'vitest';

import {
  createWebhookBoundedPrefixProviderIdParser,
} from '../webhook-bounded-prefix-provider-id-parser.js';
import {
  WEBHOOK_BOUNDED_PREFIX_REGISTRATION_REMOTE_ID_PROFILE_PRESETS,
  webhookBoundedPrefixRegistrationRemoteIdProfilePreset,
} from '../webhook-shared-profile-parser-presets.js';

const PRESET = {
  kind: 'fixed_prefix_ascii_alphanumeric_id.v1',
  prefix: 'we_',
  min_suffix_length: 1,
  max_suffix_length: 252,
} as const;

describe('D-201 Slice 9AP bounded-prefix provider-id parser', () => {
  it('accepts the fixed prefix and ASCII-alphanumeric suffix range', () => {
    const parser = createWebhookBoundedPrefixProviderIdParser(PRESET);
    expect(parser.parse('we_A')).toBe('we_A');
    expect(parser.parse('we_aZ09')).toBe('we_aZ09');
    expect(parser.parse(`we_${'A'.repeat(252)}`))
      .toBe(`we_${'A'.repeat(252)}`);
    expect(Object.isFrozen(parser)).toBe(true);
    expect(Object.isFrozen(parser.preset)).toBe(true);
    expect(() => JSON.stringify(parser.preset)).not.toThrow();
  });

  it('rejects wrong prefixes, bounds, alphabets, padding, and coercion', () => {
    const parser = createWebhookBoundedPrefixProviderIdParser(PRESET);
    for (const value of [
      '',
      'we_',
      'WE_a',
      'evt_a',
      `we_${'a'.repeat(253)}`,
      'we_a-',
      'we_a_',
      'we_a.',
      ' we_a',
      'we_a\n',
      'we_a\r',
      'we_a\u2028',
      'we_a\u2029',
      'we_a\u0000',
      'we_é',
      null,
      1,
      new String('we_a'),
    ]) {
      expect(parser.parse(value)).toBeNull();
    }
  });

  it('accepts only exact own-data bounded presets without accessors', () => {
    expect(() => createWebhookBoundedPrefixProviderIdParser(PRESET))
      .not.toThrow();
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'regex_id.v1' },
      { ...PRESET, prefix: '' },
      { ...PRESET, prefix: '0we_' },
      { ...PRESET, prefix: 'We_' },
      { ...PRESET, prefix: 'we.' },
      { ...PRESET, prefix: 'we_\n' },
      { ...PRESET, prefix: 'a'.repeat(65) },
      { ...PRESET, min_suffix_length: 0 },
      { ...PRESET, min_suffix_length: 2, max_suffix_length: 1 },
      { ...PRESET, max_suffix_length: 253 },
      { ...PRESET, max_suffix_length: 1.5 },
      Object.create(PRESET),
      new Proxy({}, {
        ownKeys() {
          throw new Error('hostile bounded-prefix preset');
        },
      }),
    ]) {
      expect(() => createWebhookBoundedPrefixProviderIdParser(invalid as never))
        .toThrow('invalid trusted preset');
    }

    const getter = vi.fn(() => 252);
    const accessor = {
      kind: 'fixed_prefix_ascii_alphanumeric_id.v1',
      prefix: 'we_',
      min_suffix_length: 1,
    } as Record<string, unknown>;
    Object.defineProperty(accessor, 'max_suffix_length', {
      enumerable: true,
      get: getter,
    });
    expect(() => createWebhookBoundedPrefixProviderIdParser(
      accessor as never,
    )).toThrow('invalid trusted preset');
    expect(getter).not.toHaveBeenCalled();
  });

  it('binds Stripe registration remote ids through trusted profile data', () => {
    const selected = webhookBoundedPrefixRegistrationRemoteIdProfilePreset(
      'stripe.event.v1',
    );
    expect(selected).toEqual({
      profile_id: 'stripe.event.v1',
      parser: PRESET,
    });
    const parser = createWebhookBoundedPrefixProviderIdParser(selected!.parser);
    expect(parser.parse('we_A0z')).toBe('we_A0z');
    expect(parser.parse('we_')).toBeNull();
    expect(webhookBoundedPrefixRegistrationRemoteIdProfilePreset(
      'paddle.notification.v1',
    )).toBeNull();
    expect(Object.values(
      WEBHOOK_BOUNDED_PREFIX_REGISTRATION_REMOTE_ID_PROFILE_PRESETS,
    ).map((value) => value?.profile_id)).toEqual(['stripe.event.v1']);
    expect(Object.getPrototypeOf(
      WEBHOOK_BOUNDED_PREFIX_REGISTRATION_REMOTE_ID_PROFILE_PRESETS,
    )).toBeNull();
    expect(Object.isFrozen(
      WEBHOOK_BOUNDED_PREFIX_REGISTRATION_REMOTE_ID_PROFILE_PRESETS,
    )).toBe(true);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected?.parser)).toBe(true);
    expect(() => JSON.stringify(selected)).not.toThrow();
  });
});
