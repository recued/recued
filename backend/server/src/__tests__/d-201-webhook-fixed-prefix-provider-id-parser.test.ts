import { describe, expect, it } from 'vitest';

import {
  WEBHOOK_PAIRED_PROVIDER_ID_PROFILE_PRESETS,
  webhookPairedProviderIdProfilePreset,
} from '../webhook-delivery-engine-presets.js';
import {
  createWebhookFixedPrefixProviderIdParser,
} from '../webhook-fixed-prefix-provider-id-parser.js';
import {
  WEBHOOK_FIXED_PREFIX_REGISTRATION_REMOTE_ID_PROFILE_PRESETS,
  webhookFixedPrefixRegistrationRemoteIdProfilePreset,
} from '../webhook-shared-profile-parser-presets.js';

const PRESET = {
  kind: 'fixed_prefix_lowercase_alphanumeric_id.v1',
  prefix: 'evt_',
  suffix_length: 26,
} as const;

describe('D-201 Slices 9H + 9AO fixed-prefix provider-id parser', () => {
  it('accepts only the exact prefix and lowercase alphanumeric suffix shape', () => {
    const parser = createWebhookFixedPrefixProviderIdParser(PRESET);
    expect(parser.parse('evt_01gks14ge726w50ch2tmaw2a1x'))
      .toBe('evt_01gks14ge726w50ch2tmaw2a1x');
    expect(createWebhookFixedPrefixProviderIdParser({
      ...PRESET,
      prefix: 'a',
      suffix_length: 1,
    }).parse('a0')).toBe('a0');
    expect(createWebhookFixedPrefixProviderIdParser({
      ...PRESET,
      prefix: 'a'.repeat(64),
      suffix_length: 128,
    }).parse(`${'a'.repeat(64)}${'z'.repeat(128)}`))
      .toBe(`${'a'.repeat(64)}${'z'.repeat(128)}`);
    expect(Object.isFrozen(parser)).toBe(true);
    expect(Object.isFrozen(parser.preset)).toBe(true);
    expect(() => JSON.stringify(parser.preset)).not.toThrow();
  });

  it('rejects wrong prefixes, lengths, alphabets, padding, and coerced values', () => {
    const parser = createWebhookFixedPrefixProviderIdParser(PRESET);
    for (const value of [
      '',
      'ntf_01gks14ge726w50ch2tmaw2a1x',
      'evt_01gks14ge726w50ch2tmaw2a1',
      'evt_01gks14ge726w50ch2tmaw2a1xx',
      'evt_01GKS14GE726W50CH2TMAW2A1X',
      'evt_01gks14ge726w50ch2tmaw2a1-',
      'evt_01gks14ge726w50ch2tmaw2a1_',
      ' evt_01gks14ge726w50ch2tmaw2a1x',
      'evt_01gks14ge726w50ch2tmaw2a1x\n',
      `evt_${'a'.repeat(25)}\n`,
      `evt_${'a'.repeat(25)}\r`,
      `evt_${'a'.repeat(24)}\r\n`,
      `evt_${'a'.repeat(25)}\u2028`,
      `evt_${'a'.repeat(25)}\u2029`,
      `evt_${'a'.repeat(25)}\u0000`,
      null,
      1,
      new String('evt_01gks14ge726w50ch2tmaw2a1x'),
    ]) {
      expect(parser.parse(value)).toBeNull();
    }
  });

  it('accepts only exact own-data bounded presets without executing accessors', () => {
    expect(() => createWebhookFixedPrefixProviderIdParser(PRESET)).not.toThrow();
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'regex_id.v1' },
      { ...PRESET, prefix: '' },
      { ...PRESET, prefix: '0evt_' },
      { ...PRESET, prefix: 'Evt_' },
      { ...PRESET, prefix: 'evt.' },
      { ...PRESET, prefix: 'evt_\n' },
      { ...PRESET, prefix: 'evt_\r' },
      { ...PRESET, prefix: 'evt_\u2028' },
      { ...PRESET, prefix: 'evt_\u2029' },
      { ...PRESET, prefix: 'a'.repeat(65) },
      { ...PRESET, suffix_length: 0 },
      { ...PRESET, suffix_length: 129 },
      { ...PRESET, suffix_length: 1.5 },
      Object.create(PRESET),
      new Proxy({}, {
        getPrototypeOf() {
          throw new Error('hostile provider-id preset');
        },
      }),
    ]) {
      expect(() => createWebhookFixedPrefixProviderIdParser(invalid as never))
        .toThrow('invalid trusted preset');
    }

    let accessorReads = 0;
    const accessor = {
      kind: 'fixed_prefix_lowercase_alphanumeric_id.v1',
      prefix: 'evt_',
    } as Record<string, unknown>;
    Object.defineProperty(accessor, 'suffix_length', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return 26;
      },
    });
    expect(() => createWebhookFixedPrefixProviderIdParser(accessor as never))
      .toThrow('invalid trusted preset');
    expect(accessorReads).toBe(0);
  });

  it('keeps the paired Paddle identity shapes in the trusted profile registry', () => {
    const selected = webhookPairedProviderIdProfilePreset(
      'paddle.notification.v1',
    );
    expect(selected).toEqual({
      profile_id: 'paddle.notification.v1',
      event_id: PRESET,
      delivery_id: {
        kind: 'fixed_prefix_lowercase_alphanumeric_id.v1',
        prefix: 'ntf_',
        suffix_length: 26,
      },
    });
    expect(webhookPairedProviderIdProfilePreset('stripe.event.v1')).toBeNull();
    expect(Object.values(WEBHOOK_PAIRED_PROVIDER_ID_PROFILE_PRESETS)
      .map((value) => value?.profile_id)).toEqual(['paddle.notification.v1']);
    expect(Object.isFrozen(WEBHOOK_PAIRED_PROVIDER_ID_PROFILE_PRESETS))
      .toBe(true);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected?.event_id)).toBe(true);
    expect(Object.isFrozen(selected?.delivery_id)).toBe(true);
    expect(() => JSON.stringify(selected)).not.toThrow();
  });

  it('binds Paddle registration remote ids through a distinct trusted role', () => {
    const selected = webhookFixedPrefixRegistrationRemoteIdProfilePreset(
      'paddle.notification.v1',
    );
    expect(selected).toEqual({
      profile_id: 'paddle.notification.v1',
      parser: {
        kind: 'fixed_prefix_lowercase_alphanumeric_id.v1',
        prefix: 'ntfset_',
        suffix_length: 26,
      },
    });
    const parser = createWebhookFixedPrefixProviderIdParser(selected!.parser);
    expect(parser.parse(`ntfset_${'a'.repeat(26)}`))
      .toBe(`ntfset_${'a'.repeat(26)}`);
    expect(parser.parse(`ntfset_${'a'.repeat(25)}`)).toBeNull();
    expect(parser.parse(`ntfset_${'A'.repeat(26)}`)).toBeNull();
    expect(webhookFixedPrefixRegistrationRemoteIdProfilePreset(
      'github.webhook.v1',
    )).toBeNull();
    expect(Object.values(
      WEBHOOK_FIXED_PREFIX_REGISTRATION_REMOTE_ID_PROFILE_PRESETS,
    ).map((value) => value?.profile_id)).toEqual(['paddle.notification.v1']);
    expect(Object.getPrototypeOf(
      WEBHOOK_FIXED_PREFIX_REGISTRATION_REMOTE_ID_PROFILE_PRESETS,
    )).toBeNull();
    expect(Object.isFrozen(
      WEBHOOK_FIXED_PREFIX_REGISTRATION_REMOTE_ID_PROFILE_PRESETS,
    )).toBe(true);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected?.parser)).toBe(true);
    expect(() => JSON.stringify(selected)).not.toThrow();
  });
});
