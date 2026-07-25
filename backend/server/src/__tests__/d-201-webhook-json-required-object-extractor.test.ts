import { describe, expect, it } from 'vitest';

import {
  createWebhookJsonRequiredObjectExtractor,
} from '../webhook-json-required-object-extractor.js';
import {
  WEBHOOK_JSON_REQUIRED_OBJECT_PROFILE_PRESETS,
  webhookJsonRequiredObjectProfilePreset,
} from '../webhook-shared-profile-parser-presets.js';

const PRESET = {
  kind: 'required_json_object_field.v1',
  field: 'data',
} as const;

describe('D-201 Slice 9K required JSON-object extractor', () => {
  it('returns the exact selected own-data plain record', () => {
    const extractor = createWebhookJsonRequiredObjectExtractor(PRESET);
    const data = { id: 'resource_1' };
    expect(extractor.extract({ data })).toBe(data);
    const nullPrototypeEnvelope = Object.create(null) as Record<string, unknown>;
    const nullPrototypeData = Object.create(null) as Record<string, unknown>;
    nullPrototypeData.id = 'resource_2';
    nullPrototypeEnvelope.data = nullPrototypeData;
    expect(extractor.extract(nullPrototypeEnvelope)).toBe(nullPrototypeData);
    expect(Object.isFrozen(extractor)).toBe(true);
    expect(Object.isFrozen(extractor.preset)).toBe(true);
    expect(() => JSON.stringify(extractor.preset)).not.toThrow();
  });

  it('rejects missing, nullable, inherited, array, scalar, and exotic values', () => {
    const extractor = createWebhookJsonRequiredObjectExtractor(PRESET);
    for (const value of [
      {},
      { data: undefined },
      { data: null },
      { data: [] },
      { data: 'object' },
      { data: 1 },
      { data: new Date(0) },
      [],
      null,
      Object.create({ data: { inherited: true } }),
    ]) {
      expect(extractor.extract(value)).toBeNull();
    }
  });

  it('does not execute accessors and contains hostile proxy failures', () => {
    const extractor = createWebhookJsonRequiredObjectExtractor(PRESET);
    let accessorReads = 0;
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, 'data', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return {};
      },
    });
    expect(extractor.extract(accessor)).toBeNull();
    expect(accessorReads).toBe(0);
    const nonEnumerable = {} as Record<string, unknown>;
    Object.defineProperty(nonEnumerable, 'data', {
      enumerable: false,
      value: {},
    });
    expect(extractor.extract(nonEnumerable)).toBeNull();
    let proxyTrapCalls = 0;
    expect(extractor.extract(new Proxy({}, {
      getPrototypeOf() {
        proxyTrapCalls += 1;
        throw new Error('hostile required-object input');
      },
    }))).toBeNull();
    expect(proxyTrapCalls).toBe(1);
    let selectedProxyTrapCalls = 0;
    const selectedProxy = new Proxy({}, {
      getPrototypeOf() {
        selectedProxyTrapCalls += 1;
        throw new Error('hostile selected object');
      },
    });
    expect(extractor.extract({ data: selectedProxy })).toBeNull();
    expect(selectedProxyTrapCalls).toBe(1);
  });

  it('accepts exact own-data presets and contains hostile objects', () => {
    expect(() => createWebhookJsonRequiredObjectExtractor(PRESET)).not.toThrow();
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'jsonpath_required_object.v1' },
      { ...PRESET, field: '' },
      { ...PRESET, field: '0data' },
      { ...PRESET, field: 'data.value' },
      { ...PRESET, field: 'data\n' },
      { ...PRESET, field: 'a'.repeat(129) },
      Object.create(PRESET),
      new Proxy({}, {
        getPrototypeOf() {
          throw new Error('hostile required-object preset');
        },
      }),
    ]) {
      expect(() => createWebhookJsonRequiredObjectExtractor(invalid as never))
        .toThrow('invalid trusted preset');
    }

    let accessorReads = 0;
    const accessor = {
      kind: 'required_json_object_field.v1',
    } as Record<string, unknown>;
    Object.defineProperty(accessor, 'field', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return 'data';
      },
    });
    expect(() => createWebhookJsonRequiredObjectExtractor(accessor as never))
      .toThrow('invalid trusted preset');
    expect(accessorReads).toBe(0);
  });

  it('binds only Paddle data selection through trusted profile data', () => {
    const selected = webhookJsonRequiredObjectProfilePreset(
      'paddle.notification.v1',
    );
    expect(selected).toEqual({
      profile_id: 'paddle.notification.v1',
      extractor: PRESET,
    });
    expect(webhookJsonRequiredObjectProfilePreset('stripe.event.v1')).toBeNull();
    expect(Object.values(WEBHOOK_JSON_REQUIRED_OBJECT_PROFILE_PRESETS)
      .map((value) => value?.profile_id)).toEqual(['paddle.notification.v1']);
    expect(Object.isFrozen(WEBHOOK_JSON_REQUIRED_OBJECT_PROFILE_PRESETS))
      .toBe(true);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected?.extractor)).toBe(true);
    expect(() => JSON.stringify(selected)).not.toThrow();
  });
});
