import { describe, expect, it, vi } from 'vitest';

import {
  createWebhookPrefixSetPrintableAsciiTokenParser,
} from '../webhook-prefix-set-printable-ascii-token-parser.js';
import {
  WEBHOOK_REGISTRATION_ACCESS_TOKEN_PROFILE_PRESETS,
  webhookRegistrationAccessTokenProfilePreset,
} from '../webhook-registration-access-token-profile-presets.js';

const PRESET = {
  kind: 'prefix_set_printable_ascii_token.v1',
  max_bytes: 4_096,
  prefixes: ['ghp_', 'github_pat_'],
} as const;

const legacyGitHubPersonalAccessToken = (value: unknown): string | null =>
  typeof value === 'string'
  && /^[\x21-\x7e]{1,4096}$/.test(value)
  && (value.startsWith('ghp_') || value.startsWith('github_pat_'))
    ? value
    : null;

describe('D-201 Slice 9BC printable-ASCII token prefix-set parser', () => {
  it('preserves exact classic and fine-grained personal-token primitives', () => {
    const parser = createWebhookPrefixSetPrintableAsciiTokenParser(PRESET);
    for (const value of [
      'ghp_',
      'github_pat_',
      'ghp_classic-personal-token',
      'github_pat_fine.grained+token/value=fixture',
      'ghp_!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
    ]) {
      expect(parser.parse(value)).toBe(value);
    }
    expect(Object.isFrozen(parser)).toBe(true);
    expect(Object.isFrozen(parser.preset)).toBe(true);
    expect(Object.isFrozen(parser.preset.prefixes)).toBe(true);
    expect(() => JSON.stringify(parser.preset)).not.toThrow();
  });

  it('rejects foreign prefixes, nonprintable bytes, bounds, and coercion', () => {
    const parser = createWebhookPrefixSetPrintableAsciiTokenParser(PRESET);
    for (const value of [
      '',
      'gho_oauth-token',
      'ghu_app-user-token',
      'ghs_app-installation-token',
      'github_pat_bad token',
      'ghp_tab\t',
      'ghp_newline\n',
      'ghp_return\r',
      'ghp_nul\u0000',
      'ghp_del\u007f',
      'ghp_é',
      'ghp_\u2028',
      'ghp_\u2029',
      `ghp_${'x'.repeat(4_093)}`,
      null,
      1,
      new String('ghp_boxed'),
      { toString: () => 'ghp_object' },
    ]) {
      expect(parser.parse(value)).toBeNull();
    }
  });

  it('matches the removed GitHub helper across both prefixes and boundaries', () => {
    const parser = createWebhookPrefixSetPrintableAsciiTokenParser(PRESET);
    const prefixes = ['ghp_', 'github_pat_', 'gho_', 'other_'];
    const candidates: unknown[] = [null, undefined, 1, new String('ghp_boxed')];
    for (const prefix of prefixes) {
      candidates.push(prefix);
      for (let code = 0; code < 128; code += 1) {
        candidates.push(`${prefix}${String.fromCharCode(code)}`);
      }
      candidates.push(
        `${prefix}${'x'.repeat(Math.max(0, 4_096 - prefix.length))}`,
        `${prefix}${'x'.repeat(Math.max(0, 4_097 - prefix.length))}`,
        `${prefix}é`,
        `${prefix}\u2028`,
        `${prefix}\u2029`,
      );
    }

    const alphabet = 'aAzZ019_-+. */:=\n\r\u0000é';
    let state = 0x9bc201;
    const next = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    while (candidates.length < 20_000) {
      const prefix = prefixes[next() % prefixes.length]!;
      const length = next() % 160;
      let suffix = '';
      for (let index = 0; index < length; index += 1) {
        suffix += alphabet[next() % alphabet.length];
      }
      candidates.push(`${prefix}${suffix}`);
    }

    for (const candidate of candidates) {
      expect(parser.parse(candidate)).toBe(
        legacyGitHubPersonalAccessToken(candidate),
      );
    }
  });

  it('accepts only exact, dense, unique own-data prefix sets', () => {
    expect(() => createWebhookPrefixSetPrintableAsciiTokenParser(
      PRESET,
    )).not.toThrow();
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'vendor_pat_callback.v1' },
      { ...PRESET, max_bytes: 0 },
      { ...PRESET, max_bytes: 65_537 },
      { ...PRESET, max_bytes: 4_096.5 },
      { ...PRESET, prefixes: [] },
      { ...PRESET, prefixes: Array.from(
        { length: 33 },
        (_, index) => `p${index}_`,
      ) },
      { ...PRESET, prefixes: ['', 'github_pat_'] },
      { ...PRESET, prefixes: ['x'.repeat(65)] },
      { ...PRESET, prefixes: ['ghp bad'] },
      { ...PRESET, prefixes: ['ghp_\n'] },
      { ...PRESET, max_bytes: 3, prefixes: ['ghp_'] },
      { ...PRESET, prefixes: ['ghp_', 'ghp_'] },
      { ...PRESET, prefixes: Object.assign([...PRESET.prefixes], { extra: true }) },
      { ...PRESET, prefixes: new Array(1) },
      { ...PRESET, [Symbol('authority')]: true },
      Object.create(PRESET),
      new Proxy({}, {
        ownKeys() {
          throw new Error('hostile access-token preset');
        },
      }),
    ]) {
      expect(() => createWebhookPrefixSetPrintableAsciiTokenParser(
        invalid as never,
      )).toThrow('invalid trusted preset');
    }

    const prefixGetter = vi.fn(() => 'ghp_');
    const accessorPrefixes = ['github_pat_'];
    Object.defineProperty(accessorPrefixes, 0, {
      enumerable: true,
      get: prefixGetter,
    });
    expect(() => createWebhookPrefixSetPrintableAsciiTokenParser({
      ...PRESET,
      prefixes: accessorPrefixes,
    })).toThrow('invalid trusted preset');
    expect(prefixGetter).not.toHaveBeenCalled();

    const maxBytesGetter = vi.fn(() => 4_096);
    const accessorPreset = {
      kind: 'prefix_set_printable_ascii_token.v1',
      prefixes: PRESET.prefixes,
    } as Record<string, unknown>;
    Object.defineProperty(accessorPreset, 'max_bytes', {
      enumerable: true,
      get: maxBytesGetter,
    });
    expect(() => createWebhookPrefixSetPrintableAsciiTokenParser(
      accessorPreset as never,
    )).toThrow('invalid trusted preset');
    expect(maxBytesGetter).not.toHaveBeenCalled();
  });

  it('copies prefix data before freezing the serializable preset', () => {
    const input = {
      kind: 'prefix_set_printable_ascii_token.v1' as const,
      max_bytes: 64,
      prefixes: ['classic_', 'fine_'],
    };
    const parser = createWebhookPrefixSetPrintableAsciiTokenParser(input);
    input.max_bytes = 1;
    input.prefixes[0] = 'changed_';
    input.prefixes.pop();
    expect(parser.preset).toEqual({
      kind: 'prefix_set_printable_ascii_token.v1',
      max_bytes: 64,
      prefixes: ['classic_', 'fine_'],
    });
    expect(parser.parse('classic_!')).toBe('classic_!');
    expect(parser.parse('changed_!')).toBeNull();
  });

  it('exposes only GitHub in the printable access-token role', () => {
    const selected = webhookRegistrationAccessTokenProfilePreset(
      'github.webhook.v1',
    );
    expect(selected).toEqual({
      profile_id: 'github.webhook.v1',
      parser: PRESET,
    });
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected?.parser)).toBe(true);
    expect(Object.isFrozen(selected?.parser.prefixes)).toBe(true);
    for (const profileId of [
      'stripe.event.v1',
      'paddle.notification.v1',
      'telegram.bot-webhook.v1',
    ] as const) {
      expect(webhookRegistrationAccessTokenProfilePreset(profileId)).toBeNull();
    }
    expect(Object.keys(WEBHOOK_REGISTRATION_ACCESS_TOKEN_PROFILE_PRESETS))
      .toEqual(['github.webhook.v1']);
    expect(Object.getPrototypeOf(
      WEBHOOK_REGISTRATION_ACCESS_TOKEN_PROFILE_PRESETS,
    )).toBeNull();
    expect(Object.isFrozen(
      WEBHOOK_REGISTRATION_ACCESS_TOKEN_PROFILE_PRESETS,
    )).toBe(true);
    expect(() => JSON.stringify(selected)).not.toThrow();
  });
});
