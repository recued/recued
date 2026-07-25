import { describe, expect, it, vi } from 'vitest';

import {
  createWebhookEnvironmentMappedSegmentedAsciiTokenClassifier,
} from '../webhook-environment-mapped-segmented-ascii-token-classifier.js';
import {
  WEBHOOK_REGISTRATION_ENVIRONMENT_TOKEN_PROFILE_PRESETS,
  webhookRegistrationEnvironmentTokenProfilePreset,
} from '../webhook-registration-environment-token-profile-presets.js';

const PRESET = {
  kind: 'environment_mapped_segmented_ascii_token.v1',
  separator: '_',
  segments: [
    { length: 26, alphabet: 'lowercase_alphanumeric' },
    { length: 22, alphabet: 'ascii_alphanumeric' },
    { length: 3, alphabet: 'ascii_alphanumeric' },
  ],
  mappings: [
    { prefix: 'pdl_sdbx_apikey_', environment: 'test' },
    { prefix: 'pdl_live_apikey_', environment: 'live' },
  ],
} as const;

const TEST_API_KEY =
  `pdl_sdbx_apikey_${'a'.repeat(26)}_${'B'.repeat(22)}_${'C'.repeat(3)}`;
const LIVE_API_KEY =
  `pdl_live_apikey_${'d'.repeat(26)}_${'E'.repeat(22)}_${'F'.repeat(3)}`;

const legacyPrimitiveClassification = (
  value: unknown,
): { value: string; environment: 'test' | 'live' } | null => {
  if (typeof value !== 'string') return null;
  const match = /^pdl_(live|sdbx)_apikey_[a-z0-9]{26}_[A-Za-z0-9]{22}_[A-Za-z0-9]{3}$/
    .exec(value);
  if (match === null) return null;
  return {
    value,
    environment: match[1] === 'sdbx' ? 'test' : 'live',
  };
};

describe('D-201 Slice 9BD environment-mapped segmented ASCII-token classifier', () => {
  it('classifies exact sandbox and live primitives with per-segment alphabets', () => {
    const classifier = createWebhookEnvironmentMappedSegmentedAsciiTokenClassifier(
      PRESET,
    );
    for (const [value, environment] of [
      [TEST_API_KEY, 'test'],
      [LIVE_API_KEY, 'live'],
    ] as const) {
      const classified = classifier.classify(value);
      expect(classified).toEqual({ value, environment });
      expect(Object.isFrozen(classified)).toBe(true);
    }
    expect(Object.isFrozen(classifier)).toBe(true);
    expect(Object.isFrozen(classifier.preset)).toBe(true);
    expect(Object.isFrozen(classifier.preset.segments)).toBe(true);
    expect(classifier.preset.segments.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(classifier.preset.mappings)).toBe(true);
    expect(classifier.preset.mappings.every(Object.isFrozen)).toBe(true);
    expect(() => JSON.stringify(classifier.preset)).not.toThrow();
  });

  it('rejects wrong mappings, segment counts, lengths, alphabets, and coercion', () => {
    const classifier = createWebhookEnvironmentMappedSegmentedAsciiTokenClassifier(
      PRESET,
    );
    for (const value of [
      '',
      'pdl_sdbx_apikey_',
      `pdl_test_apikey_${'a'.repeat(26)}_${'B'.repeat(22)}_${'C'.repeat(3)}`,
      `pdl_sdbx_client-side_${'a'.repeat(50)}`,
      TEST_API_KEY.replace('a'.repeat(26), `A${'a'.repeat(25)}`),
      TEST_API_KEY.replace('a'.repeat(26), `.${'a'.repeat(25)}`),
      TEST_API_KEY.replace('B'.repeat(22), `${'B'.repeat(21)}-`),
      TEST_API_KEY.replace('_CCC', '_C-_'),
      TEST_API_KEY.replace('a'.repeat(26), 'a'.repeat(25)),
      TEST_API_KEY.replace('B'.repeat(22), 'B'.repeat(23)),
      `${TEST_API_KEY}_extra`,
      `${TEST_API_KEY}\n`,
      `${TEST_API_KEY}\u0000`,
      null,
      1,
      new String(TEST_API_KEY),
      { toString: () => TEST_API_KEY },
    ]) {
      expect(classifier.classify(value)).toBeNull();
    }
  });

  it('preserves the Paddle primitive classifier exactly', () => {
    const classifier = createWebhookEnvironmentMappedSegmentedAsciiTokenClassifier(
      PRESET,
    );
    const prefixes = ['pdl_sdbx_apikey_', 'pdl_live_apikey_', 'pdl_test_apikey_'];
    const alphabet = 'aAzZ019_-. *\n\r\u0000é';
    const lowercaseAlphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const mixedAlphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const candidates: unknown[] = [
      '',
      TEST_API_KEY,
      LIVE_API_KEY,
      `${TEST_API_KEY}\n`,
      null,
      1,
      new String(TEST_API_KEY),
    ];
    for (const base of [TEST_API_KEY, LIVE_API_KEY]) {
      for (let index = 0; index < base.length; index += 1) {
        for (let code = 0; code < 128; code += 1) {
          candidates.push(
            `${base.slice(0, index)}${String.fromCharCode(code)}${base.slice(index + 1)}`,
          );
        }
      }
    }
    let state = 0x9bd201;
    const next = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    for (const prefix of prefixes) {
      for (let code = 0; code < 128; code += 1) {
        candidates.push(
          `${prefix}${String.fromCharCode(code)}${'a'.repeat(25)}_${'B'.repeat(22)}_${'C'.repeat(3)}`,
          `${prefix}${'a'.repeat(26)}_${String.fromCharCode(code)}${'B'.repeat(21)}_${'C'.repeat(3)}`,
          `${prefix}${'a'.repeat(26)}_${'B'.repeat(22)}_${String.fromCharCode(code)}CC`,
        );
      }
    }
    for (let sample = 0; sample < 256; sample += 1) {
      let first = '';
      let second = '';
      let third = '';
      for (let index = 0; index < 26; index += 1) {
        first += lowercaseAlphabet[next() % lowercaseAlphabet.length];
      }
      for (let index = 0; index < 22; index += 1) {
        second += mixedAlphabet[next() % mixedAlphabet.length];
      }
      for (let index = 0; index < 3; index += 1) {
        third += mixedAlphabet[next() % mixedAlphabet.length];
      }
      candidates.push(`pdl_sdbx_apikey_${first}_${second}_${third}`);
      candidates.push(`pdl_live_apikey_${first}_${second}_${third}`);
    }
    while (candidates.length < 20_000) {
      const prefix = prefixes[next() % prefixes.length]!;
      const lengths = [next() % 34, next() % 30, next() % 8];
      const segments = lengths.map((length) => {
        let value = '';
        for (let index = 0; index < length; index += 1) {
          value += alphabet[next() % alphabet.length];
        }
        return value;
      });
      candidates.push(`${prefix}${segments.join(next() % 5 === 0 ? '-' : '_')}`);
    }

    for (const candidate of candidates) {
      expect(classifier.classify(candidate))
        .toEqual(legacyPrimitiveClassification(candidate));
    }
  });

  it('accepts only exact, dense, bounded own-data segments and mappings', () => {
    expect(() => createWebhookEnvironmentMappedSegmentedAsciiTokenClassifier(
      PRESET,
    )).not.toThrow();
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'vendor_api_key_callback.v1' },
      { ...PRESET, separator: '.' },
      { ...PRESET, segments: [] },
      { ...PRESET, segments: Array.from({ length: 9 }, () => ({
        length: 1,
        alphabet: 'ascii_alphanumeric' as const,
      })) },
      { ...PRESET, segments: [{ length: 0, alphabet: 'ascii_alphanumeric' }] },
      { ...PRESET, segments: [{ length: 129, alphabet: 'ascii_alphanumeric' }] },
      { ...PRESET, segments: [{ length: 1.5, alphabet: 'ascii_alphanumeric' }] },
      { ...PRESET, segments: [{ length: 1, alphabet: 'printable_ascii' }] },
      { ...PRESET, segments: [{
        length: 1,
        alphabet: 'ascii_alphanumeric',
        extra: true,
      }] },
      { ...PRESET, mappings: [] },
      { ...PRESET, mappings: Array.from({ length: 33 }, (_, index) => ({
        prefix: `p${index}_`,
        environment: 'test' as const,
      })) },
      { ...PRESET, mappings: [{ prefix: '', environment: 'test' }] },
      { ...PRESET, mappings: [{ prefix: 'x'.repeat(65), environment: 'test' }] },
      { ...PRESET, mappings: [{ prefix: 'invalid.', environment: 'test' }] },
      { ...PRESET, mappings: [{ prefix: 'test_', environment: 'custom' }] },
      { ...PRESET, mappings: [{
        prefix: 'test_',
        environment: 'test',
        extra: true,
      }] },
      { ...PRESET, mappings: [
        { prefix: 'pdl_', environment: 'test' },
        { prefix: 'pdl_live_', environment: 'live' },
      ] },
      { ...PRESET, mappings: [
        { prefix: 'pdl_live_', environment: 'live' },
        { prefix: 'pdl_', environment: 'test' },
      ] },
      { ...PRESET, mappings: [
        { prefix: 'pdl_live_', environment: 'live' },
        { prefix: 'pdl_live_', environment: 'test' },
      ] },
      { ...PRESET, segments: Object.assign([...PRESET.segments], { extra: true }) },
      { ...PRESET, segments: new Array(1) },
      { ...PRESET, mappings: new Array(1) },
      { ...PRESET, [Symbol('authority')]: true },
      Object.create(PRESET),
      new Proxy({}, {
        ownKeys() {
          throw new Error('hostile segmented environment-token preset');
        },
      }),
    ]) {
      expect(() => createWebhookEnvironmentMappedSegmentedAsciiTokenClassifier(
        invalid as never,
      )).toThrow('invalid trusted preset');
    }

    const segmentGetter = vi.fn(() => 26);
    const accessorSegment = { alphabet: 'lowercase_alphanumeric' } as Record<
      string,
      unknown
    >;
    Object.defineProperty(accessorSegment, 'length', {
      enumerable: true,
      get: segmentGetter,
    });
    expect(() => createWebhookEnvironmentMappedSegmentedAsciiTokenClassifier({
      ...PRESET,
      segments: [accessorSegment] as never,
    })).toThrow('invalid trusted preset');
    expect(segmentGetter).not.toHaveBeenCalled();

    const mappingGetter = vi.fn(() => 'test');
    const accessorMapping = { prefix: 'test_' } as Record<string, unknown>;
    Object.defineProperty(accessorMapping, 'environment', {
      enumerable: true,
      get: mappingGetter,
    });
    expect(() => createWebhookEnvironmentMappedSegmentedAsciiTokenClassifier({
      ...PRESET,
      mappings: [accessorMapping] as never,
    })).toThrow('invalid trusted preset');
    expect(mappingGetter).not.toHaveBeenCalled();

    const separatorGetter = vi.fn(() => '_');
    const accessorPreset = {
      kind: PRESET.kind,
      segments: PRESET.segments,
      mappings: PRESET.mappings,
    } as Record<string, unknown>;
    Object.defineProperty(accessorPreset, 'separator', {
      enumerable: true,
      get: separatorGetter,
    });
    expect(() => createWebhookEnvironmentMappedSegmentedAsciiTokenClassifier(
      accessorPreset as never,
    )).toThrow('invalid trusted preset');
    expect(separatorGetter).not.toHaveBeenCalled();
  });

  it('copies segment and mapping data before freezing the preset', () => {
    const input = {
      kind: 'environment_mapped_segmented_ascii_token.v1' as const,
      separator: '_' as const,
      segments: [
        { length: 2, alphabet: 'lowercase_alphanumeric' as const },
        { length: 3, alphabet: 'ascii_alphanumeric' as const },
      ],
      mappings: [
        { prefix: 'test_', environment: 'test' as const },
        { prefix: 'live_', environment: 'live' as const },
      ],
    };
    const classifier = createWebhookEnvironmentMappedSegmentedAsciiTokenClassifier(
      input,
    );
    input.separator = '-' as never;
    input.segments[0]!.length = 1;
    input.mappings[0]!.prefix = 'changed_';
    input.mappings.pop();
    expect(classifier.preset).toEqual({
      kind: 'environment_mapped_segmented_ascii_token.v1',
      separator: '_',
      segments: [
        { length: 2, alphabet: 'lowercase_alphanumeric' },
        { length: 3, alphabet: 'ascii_alphanumeric' },
      ],
      mappings: [
        { prefix: 'test_', environment: 'test' },
        { prefix: 'live_', environment: 'live' },
      ],
    });
    expect(classifier.classify('test_a1_B2c')).toEqual({
      value: 'test_a1_B2c',
      environment: 'test',
    });
  });

  it('selects Paddle beside Stripe in the shared environment-token role', () => {
    const selected = webhookRegistrationEnvironmentTokenProfilePreset(
      'paddle.notification.v1',
    );
    expect(selected).toEqual({
      profile_id: 'paddle.notification.v1',
      classifier: PRESET,
    });
    expect(webhookRegistrationEnvironmentTokenProfilePreset(
      'stripe.event.v1',
    )?.classifier.kind).toBe('environment_mapped_prefixed_ascii_token.v1');
    for (const profileId of [
      'github.webhook.v1',
      'telegram.bot-webhook.v1',
    ] as const) {
      expect(webhookRegistrationEnvironmentTokenProfilePreset(profileId)).toBeNull();
    }
    expect(Object.keys(WEBHOOK_REGISTRATION_ENVIRONMENT_TOKEN_PROFILE_PRESETS))
      .toEqual(['stripe.event.v1', 'paddle.notification.v1']);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected?.classifier)).toBe(true);
    expect(Object.isFrozen(selected?.classifier.mappings)).toBe(true);
    expect(Object.getPrototypeOf(
      WEBHOOK_REGISTRATION_ENVIRONMENT_TOKEN_PROFILE_PRESETS,
    )).toBeNull();
    expect(Object.isFrozen(
      WEBHOOK_REGISTRATION_ENVIRONMENT_TOKEN_PROFILE_PRESETS,
    )).toBe(true);
    expect(() => JSON.stringify(selected)).not.toThrow();
  });
});
