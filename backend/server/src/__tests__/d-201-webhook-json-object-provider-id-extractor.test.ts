import { describe, expect, it } from 'vitest';

import {
  createWebhookJsonObjectProviderIdExtractor,
} from '../webhook-json-object-provider-id-extractor.js';
import {
  WEBHOOK_JSON_OBJECT_PROVIDER_ID_PROFILE_PRESETS,
  webhookJsonObjectProviderIdProfilePreset,
} from '../webhook-shared-profile-parser-presets.js';

const PRESET = {
  kind: 'optional_json_object_provider_id.v1',
  field: 'id',
  grammar: 'control_free_trimmed_utf8.v1',
  max_bytes: 512,
} as const;

describe('D-201 Slice 9J JSON-object provider-id extractor', () => {
  it('extracts exact own-data ids at ASCII and UTF-8 byte boundaries', () => {
    const extractor = createWebhookJsonObjectProviderIdExtractor(PRESET);
    expect(extractor.extract({ id: 'sub_01h04vsc0qhwtsbsxh3422wjs4' }))
      .toBe('sub_01h04vsc0qhwtsbsxh3422wjs4');
    expect(extractor.extract({ id: 'a'.repeat(512) })).toBe('a'.repeat(512));
    expect(extractor.extract({ id: 'é'.repeat(256) })).toBe('é'.repeat(256));
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype.id = 'null_proto_id';
    expect(extractor.extract(nullPrototype)).toBe('null_proto_id');
    expect(Object.isFrozen(extractor)).toBe(true);
    expect(Object.isFrozen(extractor.preset)).toBe(true);
    expect(() => JSON.stringify(extractor.preset)).not.toThrow();
  });

  it('treats missing, nullable, malformed, inherited, and coerced ids as absent', () => {
    const extractor = createWebhookJsonObjectProviderIdExtractor(PRESET);
    for (const value of [
      {},
      { id: undefined },
      { id: null },
      { id: '' },
      { id: ' padded' },
      { id: 'padded ' },
      { id: 'line\nbreak' },
      { id: 'nul\u0000id' },
      { id: 'del\u007fid' },
      { id: 'a'.repeat(513) },
      { id: 'é'.repeat(257) },
      { id: 1 },
      { id: new String('boxed') },
      [],
      null,
      Object.create({ id: 'inherited' }),
    ]) {
      expect(extractor.extract(value)).toBeNull();
    }
  });

  it('does not execute accessors and contains hostile proxy failures', () => {
    const extractor = createWebhookJsonObjectProviderIdExtractor(PRESET);
    let accessorReads = 0;
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, 'id', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return 'must_not_run';
      },
    });
    expect(extractor.extract(accessor)).toBeNull();
    expect(accessorReads).toBe(0);
    const nonEnumerable = {} as Record<string, unknown>;
    Object.defineProperty(nonEnumerable, 'id', {
      enumerable: false,
      value: 'hidden',
    });
    expect(extractor.extract(nonEnumerable)).toBeNull();
    let proxyTrapCalls = 0;
    expect(extractor.extract(new Proxy({}, {
      getPrototypeOf() {
        proxyTrapCalls += 1;
        throw new Error('hostile runtime object');
      },
    }))).toBeNull();
    expect(proxyTrapCalls).toBe(1);
  });

  it('accepts exact own-data presets and contains hostile objects', () => {
    expect(() => createWebhookJsonObjectProviderIdExtractor(PRESET)).not.toThrow();
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'jsonpath_provider_id.v1' },
      { ...PRESET, field: '' },
      { ...PRESET, field: '0id' },
      { ...PRESET, field: 'id.value' },
      { ...PRESET, field: 'id\n' },
      { ...PRESET, field: 'a'.repeat(129) },
      { ...PRESET, grammar: 'owner_regex.v1' },
      { ...PRESET, max_bytes: 0 },
      { ...PRESET, max_bytes: 513 },
      { ...PRESET, max_bytes: 1.5 },
      Object.create(PRESET),
      new Proxy({}, {
        getPrototypeOf() {
          throw new Error('hostile extractor preset');
        },
      }),
    ]) {
      expect(() => createWebhookJsonObjectProviderIdExtractor(invalid as never))
        .toThrow('invalid trusted preset');
    }

    let accessorReads = 0;
    const accessor = {
      kind: 'optional_json_object_provider_id.v1',
      field: 'id',
      grammar: 'control_free_trimmed_utf8.v1',
    } as Record<string, unknown>;
    Object.defineProperty(accessor, 'max_bytes', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return 512;
      },
    });
    expect(() => createWebhookJsonObjectProviderIdExtractor(accessor as never))
      .toThrow('invalid trusted preset');
    expect(accessorReads).toBe(0);
  });

  it('binds only Paddle resource identity through trusted profile data', () => {
    const selected = webhookJsonObjectProviderIdProfilePreset(
      'paddle.notification.v1',
    );
    expect(selected).toEqual({
      profile_id: 'paddle.notification.v1',
      extractor: PRESET,
    });
    expect(webhookJsonObjectProviderIdProfilePreset('stripe.event.v1')).toBeNull();
    expect(Object.values(WEBHOOK_JSON_OBJECT_PROVIDER_ID_PROFILE_PRESETS)
      .map((value) => value?.profile_id)).toEqual(['paddle.notification.v1']);
    expect(Object.isFrozen(WEBHOOK_JSON_OBJECT_PROVIDER_ID_PROFILE_PRESETS))
      .toBe(true);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected?.extractor)).toBe(true);
    expect(() => JSON.stringify(selected)).not.toThrow();
  });
});
