import { describe, expect, it, vi } from 'vitest';

import {
  isValidPaddleEndpointSecretKey,
} from '../connections/providers/paddle-webhook-protocol.js';
import {
  createWebhookSegmentedAsciiTokenParser,
} from '../webhook-segmented-ascii-token-parser.js';
import {
  webhookTimestampedHmacDeliveryProfilePreset,
} from '../webhook-delivery-engine-presets.js';
import {
  WEBHOOK_SEGMENTED_ASCII_CREDENTIAL_PROFILE_PRESETS,
  webhookSegmentedAsciiCredentialProfilePreset,
} from '../webhook-shared-profile-parser-presets.js';

const PRESET = {
  kind: 'segmented_ascii_token.v1',
  prefix: 'pdl_ntfset_',
  separator: '_',
  segment_lengths: [26, 32],
} as const;
const FIRST_SEGMENT = 'A'.repeat(26);
const SECOND_SEGMENT = 'b'.repeat(32);
const ENDPOINT_SECRET =
  `${PRESET.prefix}${FIRST_SEGMENT}_${SECOND_SEGMENT}`;

describe('D-201 Slice 9AU segmented ASCII-token parser', () => {
  it('accepts exact bounded underscore and dash segment grammars', () => {
    const parser = createWebhookSegmentedAsciiTokenParser(PRESET);
    expect(parser.parse(ENDPOINT_SECRET)).toBe(ENDPOINT_SECRET);

    const dashParser = createWebhookSegmentedAsciiTokenParser({
      kind: 'segmented_ascii_token.v1',
      prefix: 'fixture_',
      separator: '-',
      segment_lengths: [1, 2, 3],
    });
    expect(dashParser.parse('fixture_A-b2-C3d')).toBe('fixture_A-b2-C3d');
    expect(Object.isFrozen(parser)).toBe(true);
    expect(Object.isFrozen(parser.preset)).toBe(true);
    expect(Object.isFrozen(parser.preset.segment_lengths)).toBe(true);
    expect(() => JSON.stringify(parser.preset)).not.toThrow();
  });

  it('rejects wrong prefixes, segment counts, lengths, alphabets, and coercion', () => {
    const parser = createWebhookSegmentedAsciiTokenParser(PRESET);
    for (const value of [
      '',
      PRESET.prefix,
      `${PRESET.prefix}${FIRST_SEGMENT}`,
      `${PRESET.prefix}${FIRST_SEGMENT}_${SECOND_SEGMENT}_extra`,
      `other_${FIRST_SEGMENT}_${SECOND_SEGMENT}`,
      `${PRESET.prefix}${'A'.repeat(25)}_${SECOND_SEGMENT}`,
      `${PRESET.prefix}${FIRST_SEGMENT}_${'b'.repeat(31)}`,
      `${PRESET.prefix}${FIRST_SEGMENT}.${SECOND_SEGMENT}`,
      `${PRESET.prefix}${'A'.repeat(25)}é_${SECOND_SEGMENT}`,
      `${PRESET.prefix}${'A'.repeat(25)} _${SECOND_SEGMENT}`,
      `${PRESET.prefix}${'A'.repeat(25)}\n_${SECOND_SEGMENT}`,
      `${PRESET.prefix}${'A'.repeat(25)}\u0000_${SECOND_SEGMENT}`,
      null,
      1,
      new String(ENDPOINT_SECRET),
    ]) {
      expect(parser.parse(value)).toBeNull();
    }
  });

  it('preserves the D-201 Paddle primitive-string grammar exactly', () => {
    const parser = createWebhookSegmentedAsciiTokenParser(PRESET);
    const legacy = (value: unknown): string | null =>
      isValidPaddleEndpointSecretKey(value)
      ? value
      : null;
    const alphabet = 'aAzZ019_-. *\n\r\u0000é';
    const validAlphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let state = 0x9a5501;
    const next = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    const candidates: unknown[] = [
      '',
      ENDPOINT_SECRET,
      `${ENDPOINT_SECRET}_extra`,
      `${ENDPOINT_SECRET}\n`,
      null,
      1,
      new String(ENDPOINT_SECRET),
    ];
    for (let sample = 0; sample < 256; sample += 1) {
      let first = '';
      let second = '';
      for (let index = 0; index < 26; index += 1) {
        first += validAlphabet[next() % validAlphabet.length];
      }
      for (let index = 0; index < 32; index += 1) {
        second += validAlphabet[next() % validAlphabet.length];
      }
      const valid = `${PRESET.prefix}${first}_${second}`;
      candidates.push(valid);
      const mutationIndex = PRESET.prefix.length + (next() % 26);
      candidates.push(
        `${valid.slice(0, mutationIndex)}.${valid.slice(mutationIndex + 1)}`,
      );
    }
    while (candidates.length < 20_007) {
      const firstLength = next() % 40;
      const secondLength = next() % 48;
      let first = '';
      let second = '';
      for (let index = 0; index < firstLength; index += 1) {
        first += alphabet[next() % alphabet.length];
      }
      for (let index = 0; index < secondLength; index += 1) {
        second += alphabet[next() % alphabet.length];
      }
      const prefix = next() % 3 === 0 ? 'other_' : PRESET.prefix;
      const separator = next() % 4 === 0 ? '-' : '_';
      const suffix = next() % 8 === 0 ? '_extra' : '';
      candidates.push(`${prefix}${first}${separator}${second}${suffix}`);
    }

    for (const candidate of candidates) {
      expect(parser.parse(candidate)).toBe(legacy(candidate));
    }
  });

  it('accepts only exact own-data bounded presets without accessors', () => {
    expect(() => createWebhookSegmentedAsciiTokenParser(PRESET)).not.toThrow();

    const sparse = Array<number>(2);
    sparse[0] = 26;
    const withExtra = [26, 32] as number[] & { extra?: boolean };
    withExtra.extra = true;
    const inherited = [26, 32];
    Object.setPrototypeOf(inherited, Object.create(Array.prototype));
    class SegmentLengths extends Array<number> {}
    const subclass = new SegmentLengths(26, 32);
    const segmentGetter = vi.fn(() => 26);
    const accessorSegment = [26, 32];
    Object.defineProperty(accessorSegment, 0, {
      enumerable: true,
      get: segmentGetter,
    });

    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'owner_regex.v1' },
      { ...PRESET, prefix: '' },
      { ...PRESET, prefix: 'a'.repeat(65) },
      { ...PRESET, prefix: 'invalid.' },
      { ...PRESET, separator: '.' },
      { ...PRESET, segment_lengths: [] },
      { ...PRESET, segment_lengths: Array(9).fill(1) },
      { ...PRESET, segment_lengths: [0] },
      { ...PRESET, segment_lengths: [129] },
      { ...PRESET, segment_lengths: [1.5] },
      { ...PRESET, segment_lengths: sparse },
      { ...PRESET, segment_lengths: withExtra },
      { ...PRESET, segment_lengths: inherited },
      { ...PRESET, segment_lengths: subclass },
      { ...PRESET, segment_lengths: accessorSegment },
      Object.create(PRESET),
      new Proxy({}, {
        ownKeys() {
          throw new Error('hostile segmented ASCII-token preset');
        },
      }),
      {
        ...PRESET,
        segment_lengths: new Proxy([26, 32], {
          ownKeys() {
            throw new Error('hostile segment lengths');
          },
        }),
      },
    ]) {
      expect(() => createWebhookSegmentedAsciiTokenParser(invalid as never))
        .toThrow('invalid trusted preset');
    }
    expect(segmentGetter).not.toHaveBeenCalled();

    const prefixGetter = vi.fn(() => PRESET.prefix);
    const accessorPreset = {
      kind: PRESET.kind,
      separator: PRESET.separator,
      segment_lengths: PRESET.segment_lengths,
    } as Record<string, unknown>;
    Object.defineProperty(accessorPreset, 'prefix', {
      enumerable: true,
      get: prefixGetter,
    });
    expect(() => createWebhookSegmentedAsciiTokenParser(
      accessorPreset as never,
    )).toThrow('invalid trusted preset');
    expect(prefixGetter).not.toHaveBeenCalled();
  });

  it('copies and freezes the trusted segment grammar', () => {
    const segmentLengths = [2, 3];
    const input = {
      kind: 'segmented_ascii_token.v1' as const,
      prefix: 'fixture_',
      separator: '-' as const,
      segment_lengths: segmentLengths,
    };
    const parser = createWebhookSegmentedAsciiTokenParser(input);
    segmentLengths[0] = 1;
    input.prefix = 'changed_';

    expect(parser.preset).toEqual({
      kind: 'segmented_ascii_token.v1',
      prefix: 'fixture_',
      separator: '-',
      segment_lengths: [2, 3],
    });
    expect(parser.parse('fixture_A1-b2C')).toBe('fixture_A1-b2C');
    expect(parser.parse('changed_A-b2C')).toBeNull();
  });

  it('binds the Paddle credential grammar across trusted profile data and delivery', () => {
    const selected = webhookSegmentedAsciiCredentialProfilePreset(
      'paddle.notification.v1',
    );
    expect(selected).toEqual({
      profile_id: 'paddle.notification.v1',
      credential_field: 'endpoint_secret_key',
      parser: PRESET,
    });
    expect(webhookSegmentedAsciiCredentialProfilePreset(
      'stripe.event.v1',
    )).toBeNull();
    expect(Object.values(
      WEBHOOK_SEGMENTED_ASCII_CREDENTIAL_PROFILE_PRESETS,
    ).map((value) => value?.profile_id)).toEqual(['paddle.notification.v1']);
    expect(Object.getPrototypeOf(
      WEBHOOK_SEGMENTED_ASCII_CREDENTIAL_PROFILE_PRESETS,
    )).toBeNull();
    expect(Object.isFrozen(
      WEBHOOK_SEGMENTED_ASCII_CREDENTIAL_PROFILE_PRESETS,
    )).toBe(true);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected?.parser)).toBe(true);
    expect(Object.isFrozen(selected?.parser.segment_lengths)).toBe(true);
    expect(() => JSON.stringify(selected)).not.toThrow();

    const delivery = webhookTimestampedHmacDeliveryProfilePreset(
      'paddle.notification.v1',
    );
    expect(delivery?.mechanism.secret_field).toBe(
      selected?.credential_field,
    );
    expect(delivery?.mechanism.secret_shape).toEqual(selected?.parser);
  });
});
