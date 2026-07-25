import { describe, expect, it } from 'vitest';

import {
  createWebhookCanonicalUuidParser,
} from '../webhook-canonical-uuid-parser.js';
import {
  WEBHOOK_CANONICAL_UUID_PROFILE_PRESETS,
  webhookCanonicalUuidProfilePreset,
} from '../webhook-shared-profile-parser-presets.js';

const PRESET = { kind: 'canonical_uuid_hex.v1' } as const;

describe('D-201 Slice 9P canonical UUID parser', () => {
  it('canonicalizes UUID-shaped hexadecimal identity without version semantics', () => {
    const parser = createWebhookCanonicalUuidParser(PRESET);
    expect(parser.parse('72d3162e-cc78-11e3-81ab-4c9367dc0958'))
      .toBe('72d3162e-cc78-11e3-81ab-4c9367dc0958');
    expect(parser.parse('72D3162E-CC78-11E3-81AB-4C9367DC0958'))
      .toBe('72d3162e-cc78-11e3-81ab-4c9367dc0958');
    expect(parser.parse('00000000-0000-0000-0000-000000000000'))
      .toBe('00000000-0000-0000-0000-000000000000');
    expect(Object.isFrozen(parser.preset)).toBe(true);
    expect(() => JSON.stringify(parser.preset)).not.toThrow();

    for (const value of [
      '',
      '72d3162ecc7811e381ab4c9367dc0958',
      '{72d3162e-cc78-11e3-81ab-4c9367dc0958}',
      '72d3162e-cc78-11e3-81ab-4c9367dc0958 ',
      '72d3162e-cc78-11e3-81ab-4c9367dc095g',
      '72d3162e-cc78-11e3-81ab-4c9367dc09580',
      null,
      1,
      new String('72d3162e-cc78-11e3-81ab-4c9367dc0958'),
    ]) {
      expect(parser.parse(value)).toBeNull();
    }
  });

  it('accepts only exact own-data inert presets', () => {
    expect(() => createWebhookCanonicalUuidParser(PRESET)).not.toThrow();
    for (const invalid of [
      { ...PRESET, extra: true },
      { kind: 'uuid_callback.v1' },
      Object.create(PRESET),
      new Proxy({}, {
        ownKeys() {
          throw new Error('hostile UUID preset');
        },
      }),
    ]) {
      expect(() => createWebhookCanonicalUuidParser(invalid as never))
        .toThrow('invalid trusted preset');
    }
    let accessorReads = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, 'kind', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return PRESET.kind;
      },
    });
    expect(() => createWebhookCanonicalUuidParser(accessor as never))
      .toThrow('invalid trusted preset');
    expect(accessorReads).toBe(0);
  });

  it('selects the frozen parser only for the registered JSON profile', () => {
    expect(webhookCanonicalUuidProfilePreset('github.webhook.v1')).toEqual({
      profile_id: 'github.webhook.v1',
      parser: PRESET,
    });
    expect(Object.isFrozen(
      webhookCanonicalUuidProfilePreset('github.webhook.v1'),
    )).toBe(true);
    expect(Object.values(WEBHOOK_CANONICAL_UUID_PROFILE_PRESETS)
      .map((value) => value?.profile_id)).toEqual(['github.webhook.v1']);
    expect(webhookCanonicalUuidProfilePreset('paddle.notification.v1'))
      .toBeNull();
  });
});
