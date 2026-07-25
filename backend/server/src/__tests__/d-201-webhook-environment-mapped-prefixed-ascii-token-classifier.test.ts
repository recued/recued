import { describe, expect, it, vi } from 'vitest';

import {
  createWebhookEnvironmentMappedPrefixedAsciiTokenClassifier,
} from '../webhook-environment-mapped-prefixed-ascii-token-classifier.js';
import {
  WEBHOOK_REGISTRATION_ENVIRONMENT_TOKEN_PROFILE_PRESETS,
  webhookRegistrationEnvironmentTokenProfilePreset,
} from '../webhook-registration-environment-token-profile-presets.js';

const PRESET = {
  kind: 'environment_mapped_prefixed_ascii_token.v1',
  max_bytes: 512,
  mappings: [
    { prefix: 'sk_test_', environment: 'test' },
    { prefix: 'rk_test_', environment: 'test' },
    { prefix: 'sk_live_', environment: 'live' },
    { prefix: 'rk_live_', environment: 'live' },
  ],
} as const;

const legacyPrimitiveClassification = (
  value: unknown,
): { value: string; environment: 'test' | 'live' } | null => {
  if (typeof value !== 'string' || value.length > 512) return null;
  if (/^(?:sk|rk)_test_[A-Za-z0-9_-]+$/.test(value)) {
    return { value, environment: 'test' };
  }
  if (/^(?:sk|rk)_live_[A-Za-z0-9_-]+$/.test(value)) {
    return { value, environment: 'live' };
  }
  return null;
};

const legacyRuntimeEnvironment = (value: unknown): 'test' | 'live' | null => {
  if ((value as { length?: number }).length! > 512) return null;
  if (/^(?:sk|rk)_test_[A-Za-z0-9_-]+$/.test(value as string)) return 'test';
  if (/^(?:sk|rk)_live_[A-Za-z0-9_-]+$/.test(value as string)) return 'live';
  return null;
};

describe('D-201 Slice 9BB environment-mapped prefixed ASCII-token classifier', () => {
  it('classifies every mapped prefix and preserves the exact primitive token', () => {
    const classifier = createWebhookEnvironmentMappedPrefixedAsciiTokenClassifier(
      PRESET,
    );
    for (const [value, environment] of [
      ['sk_test_A', 'test'],
      ['rk_test_MixedCase_0123-token', 'test'],
      ['sk_live_A', 'live'],
      ['rk_live_MixedCase_0123-token', 'live'],
    ] as const) {
      const classified = classifier.classify(value);
      expect(classified).toEqual({ value, environment });
      expect(Object.isFrozen(classified)).toBe(true);
    }
    expect(Object.isFrozen(classifier)).toBe(true);
    expect(Object.isFrozen(classifier.preset)).toBe(true);
    expect(Object.isFrozen(classifier.preset.mappings)).toBe(true);
    expect(classifier.preset.mappings.every(Object.isFrozen)).toBe(true);
    expect(() => JSON.stringify(classifier.preset)).not.toThrow();
  });

  it('rejects missing suffixes, unknown prefixes, bounds, alphabets, and coercion', () => {
    const classifier = createWebhookEnvironmentMappedPrefixedAsciiTokenClassifier(
      PRESET,
    );
    for (const value of [
      '',
      'sk_test_',
      'sk_live_',
      'pk_test_publishable',
      'sk_custom_secret',
      'SK_TEST_secret',
      'sk_test_with.dot',
      'sk_test_with space',
      'sk_test_with\nnewline',
      'sk_test_with\rreturn',
      'sk_test_with\u0000nul',
      'sk_test_final\n',
      'sk_test_final\r',
      'sk_test_final\u2028',
      'sk_test_final\u2029',
      'sk_test_é',
      `sk_test_${'x'.repeat(505)}`,
      null,
      1,
      new String('sk_test_boxed'),
    ]) {
      expect(classifier.classify(value)).toBeNull();
    }
  });

  it('preserves the Stripe primitive-string classifier exactly', () => {
    const classifier = createWebhookEnvironmentMappedPrefixedAsciiTokenClassifier(
      PRESET,
    );
    const alphabet = 'aAzZ019_-+. *\n\r\u0000é';
    const prefixes = [
      'sk_test_',
      'rk_test_',
      'sk_live_',
      'rk_live_',
      'pk_test_',
      'other_',
    ];
    let state = 0x9bb201;
    const next = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    const candidates: unknown[] = [
      '',
      'sk_test_A',
      'rk_test_A',
      'sk_live_A',
      'rk_live_A',
      `sk_test_${'x'.repeat(504)}`,
      `sk_test_${'x'.repeat(505)}`,
      null,
      1,
      new String('sk_test_boxed'),
    ];
    while (candidates.length < 20_010) {
      const length = next() % 140;
      let suffix = '';
      for (let index = 0; index < length; index += 1) {
        suffix += alphabet[next() % alphabet.length];
      }
      candidates.push(`${prefixes[next() % prefixes.length]}${suffix}`);
    }

    for (const candidate of candidates) {
      expect(classifier.classify(candidate))
        .toEqual(legacyPrimitiveClassification(candidate));
    }
  });

  it('locks every Stripe prefix across the ASCII suffix alphabet and byte boundary', () => {
    const classifier = createWebhookEnvironmentMappedPrefixedAsciiTokenClassifier(
      PRESET,
    );
    const mappings = [
      ['sk_test_', 'test'],
      ['rk_test_', 'test'],
      ['sk_live_', 'live'],
      ['rk_live_', 'live'],
    ] as const;
    const allowedSuffixCharacters =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

    for (const [prefix, environment] of mappings) {
      expect(classifier.classify(prefix)).toBeNull();
      for (const character of allowedSuffixCharacters) {
        expect(classifier.classify(`${prefix}${character}`)).toEqual({
          value: `${prefix}${character}`,
          environment,
        });
      }
      for (let code = 0; code < 128; code += 1) {
        const candidate = `${prefix}${String.fromCharCode(code)}`;
        expect(classifier.classify(candidate))
          .toEqual(legacyPrimitiveClassification(candidate));
      }
      for (const character of ['é', '\u2028', '\u2029']) {
        const candidate = `${prefix}${character}`;
        expect(classifier.classify(candidate))
          .toEqual(legacyPrimitiveClassification(candidate));
      }
      const atBoundary = `${prefix}${'x'.repeat(512 - prefix.length)}`;
      const overBoundary = `${atBoundary}x`;
      expect(classifier.classify(atBoundary)).toEqual({
        value: atBoundary,
        environment,
      });
      expect(classifier.classify(overBoundary)).toBeNull();
    }
  });

  it('closes legacy regex coercion without changing primitive acceptance', () => {
    const classifier = createWebhookEnvironmentMappedPrefixedAsciiTokenClassifier(
      PRESET,
    );
    for (const value of [
      new String('sk_test_boxed'),
      { length: 13, toString: () => 'sk_test_token' },
    ]) {
      expect(legacyRuntimeEnvironment(value)).toBe('test');
      expect(classifier.classify(value)).toBeNull();
    }
  });

  it('accepts only exact, dense, prefix-free own-data mappings', () => {
    expect(() => createWebhookEnvironmentMappedPrefixedAsciiTokenClassifier(
      PRESET,
    )).not.toThrow();
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'vendor_api_key_callback.v1' },
      { ...PRESET, max_bytes: 0 },
      { ...PRESET, max_bytes: 65_537 },
      { ...PRESET, max_bytes: 512.5 },
      { ...PRESET, mappings: [] },
      { ...PRESET, mappings: Array.from({ length: 33 }, (_, index) => ({
        prefix: `p${index}_`,
        environment: 'test' as const,
      })) },
      { ...PRESET, mappings: [{
        prefix: 'sk_test_',
        environment: 'test',
        extra: true,
      }] },
      { ...PRESET, mappings: [{ prefix: 'sk.test.', environment: 'test' }] },
      { ...PRESET, mappings: [{ prefix: 'x'.repeat(65), environment: 'test' }] },
      { ...PRESET, max_bytes: 8, mappings: [{
        prefix: 'sk_test_',
        environment: 'test',
      }] },
      { ...PRESET, mappings: [{ prefix: 'sk_test_', environment: 'custom' }] },
      { ...PRESET, mappings: [
        { prefix: 'sk_', environment: 'test' },
        { prefix: 'sk_test_', environment: 'test' },
      ] },
      { ...PRESET, mappings: [
        { prefix: 'sk_test_', environment: 'test' },
        { prefix: 'sk_', environment: 'test' },
      ] },
      { ...PRESET, mappings: [
        { prefix: 'sk_test_', environment: 'test' },
        { prefix: 'sk_test_', environment: 'live' },
      ] },
      { ...PRESET, mappings: Object.assign([...PRESET.mappings], { extra: true }) },
      { ...PRESET, mappings: new Array(1) },
      { ...PRESET, [Symbol('authority')]: true },
      Object.create(PRESET),
      new Proxy({}, {
        ownKeys() {
          throw new Error('hostile environment-token preset');
        },
      }),
    ]) {
      expect(() => createWebhookEnvironmentMappedPrefixedAsciiTokenClassifier(
        invalid as never,
      )).toThrow('invalid trusted preset');
    }

    const getter = vi.fn(() => 'sk_test_');
    const accessorMapping = { environment: 'test' } as Record<string, unknown>;
    Object.defineProperty(accessorMapping, 'prefix', {
      enumerable: true,
      get: getter,
    });
    expect(() => createWebhookEnvironmentMappedPrefixedAsciiTokenClassifier({
      ...PRESET,
      mappings: [accessorMapping] as never,
    })).toThrow('invalid trusted preset');
    expect(getter).not.toHaveBeenCalled();

    const maxBytesGetter = vi.fn(() => 512);
    const accessorPreset = {
      kind: 'environment_mapped_prefixed_ascii_token.v1',
      mappings: PRESET.mappings,
    } as Record<string, unknown>;
    Object.defineProperty(accessorPreset, 'max_bytes', {
      enumerable: true,
      get: maxBytesGetter,
    });
    expect(() => createWebhookEnvironmentMappedPrefixedAsciiTokenClassifier(
      accessorPreset as never,
    )).toThrow('invalid trusted preset');
    expect(maxBytesGetter).not.toHaveBeenCalled();
  });

  it('copies mapping data before freezing the serializable preset', () => {
    const input = {
      kind: 'environment_mapped_prefixed_ascii_token.v1' as const,
      max_bytes: 64,
      mappings: [
        { prefix: 'test_', environment: 'test' as const },
        { prefix: 'live_', environment: 'live' as const },
      ],
    };
    const classifier = createWebhookEnvironmentMappedPrefixedAsciiTokenClassifier(
      input,
    );
    input.max_bytes = 1;
    input.mappings[0]!.prefix = 'changed_';
    input.mappings.pop();
    expect(classifier.preset).toEqual({
      kind: 'environment_mapped_prefixed_ascii_token.v1',
      max_bytes: 64,
      mappings: [
        { prefix: 'test_', environment: 'test' },
        { prefix: 'live_', environment: 'live' },
      ],
    });
    expect(classifier.classify('test_token')).toEqual({
      value: 'test_token',
      environment: 'test',
    });
  });

  it('binds Stripe to the prefixed classifier in the shared environment role', () => {
    const selected = webhookRegistrationEnvironmentTokenProfilePreset(
      'stripe.event.v1',
    );
    expect(selected).toEqual({
      profile_id: 'stripe.event.v1',
      classifier: PRESET,
    });
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected?.classifier)).toBe(true);
    expect(Object.isFrozen(selected?.classifier.mappings)).toBe(true);
    expect(webhookRegistrationEnvironmentTokenProfilePreset(
      'paddle.notification.v1',
    )?.classifier.kind).toBe('environment_mapped_segmented_ascii_token.v1');
    for (const profileId of [
      'github.webhook.v1',
      'telegram.bot-webhook.v1',
    ] as const) {
      expect(webhookRegistrationEnvironmentTokenProfilePreset(profileId)).toBeNull();
    }
    expect(Object.keys(WEBHOOK_REGISTRATION_ENVIRONMENT_TOKEN_PROFILE_PRESETS))
      .toEqual(['stripe.event.v1', 'paddle.notification.v1']);
    expect(Object.getPrototypeOf(
      WEBHOOK_REGISTRATION_ENVIRONMENT_TOKEN_PROFILE_PRESETS,
    )).toBeNull();
    expect(Object.isFrozen(
      WEBHOOK_REGISTRATION_ENVIRONMENT_TOKEN_PROFILE_PRESETS,
    )).toBe(true);
    expect(() => JSON.stringify(selected)).not.toThrow();
  });
});
