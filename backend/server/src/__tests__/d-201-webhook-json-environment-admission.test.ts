import { describe, expect, it } from 'vitest';

import {
  createWebhookJsonEnvironmentAdmission,
  type WebhookJsonEnvironmentAdmissionPreset,
} from '../webhook-json-environment-admission.js';

const PRESET: WebhookJsonEnvironmentAdmissionPreset = {
  kind: 'json_boolean_environment_map.v1',
  boolean_field: 'production_mode',
  false_environment: 'test',
  true_environment: 'live',
};

describe('D-201 Slice 9A JSON environment admission', () => {
  it('maps either boolean value to a portable environment without coercion', () => {
    const admission = createWebhookJsonEnvironmentAdmission(PRESET);

    expect(admission.classify({ production_mode: false }, 'test'))
      .toEqual({ kind: 'matched' });
    expect(admission.classify({ production_mode: true }, 'live'))
      .toEqual({ kind: 'matched' });
    expect(admission.classify({ production_mode: false }, 'live'))
      .toEqual({ kind: 'environment_mismatch' });
    expect(admission.classify({ production_mode: true }, 'test'))
      .toEqual({ kind: 'environment_mismatch' });
    expect(admission.classify({ production_mode: false }, 'custom'))
      .toEqual({ kind: 'environment_mismatch' });

    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype.production_mode = true;
    expect(admission.classify(nullPrototype, 'live'))
      .toEqual({ kind: 'matched' });
  });

  it('rejects absent, inherited, hidden, accessor, and non-boolean selections', () => {
    const admission = createWebhookJsonEnvironmentAdmission(PRESET);
    for (const envelope of [
      null,
      [],
      new Date(0),
      {},
      { production_mode: undefined },
      { production_mode: null },
      { production_mode: 0 },
      { production_mode: 'false' },
      Object.create({ production_mode: false }),
    ]) {
      expect(admission.classify(envelope, 'test')).toEqual({ kind: 'invalid' });
    }

    const hidden = {};
    Object.defineProperty(hidden, 'production_mode', {
      configurable: true,
      enumerable: false,
      value: false,
    });
    expect(admission.classify(hidden, 'test')).toEqual({ kind: 'invalid' });

    let selectedGetterCalls = 0;
    const selectedAccessor = {};
    Object.defineProperty(selectedAccessor, 'production_mode', {
      enumerable: true,
      get() {
        selectedGetterCalls += 1;
        return false;
      },
    });
    expect(admission.classify(selectedAccessor, 'test'))
      .toEqual({ kind: 'invalid' });
    expect(selectedGetterCalls).toBe(0);
  });

  it('ignores unrelated accessors and fails closed on hostile reflection', () => {
    const admission = createWebhookJsonEnvironmentAdmission(PRESET);
    let ignoredGetterCalls = 0;
    const envelope = { production_mode: false };
    Object.defineProperty(envelope, 'ignored', {
      enumerable: true,
      get() {
        ignoredGetterCalls += 1;
        throw new Error('must not execute');
      },
    });
    expect(admission.classify(envelope, 'test')).toEqual({ kind: 'matched' });
    expect(ignoredGetterCalls).toBe(0);

    const prototypeTrap = new Proxy({}, {
      getPrototypeOf() {
        throw new Error('hostile prototype trap');
      },
    });
    expect(admission.classify(prototypeTrap, 'test'))
      .toEqual({ kind: 'invalid' });

    const descriptorTrap = new Proxy({ production_mode: false }, {
      getOwnPropertyDescriptor() {
        throw new Error('hostile descriptor trap');
      },
    });
    expect(admission.classify(descriptorTrap, 'test'))
      .toEqual({ kind: 'invalid' });
    expect(admission.classify({ production_mode: false }, 'invalid' as never))
      .toEqual({ kind: 'invalid' });
  });

  it('copies one exact data-only preset into frozen serializable authority', () => {
    const input = { ...PRESET };
    const admission = createWebhookJsonEnvironmentAdmission(input);
    input.boolean_field = 'changed_after_construction';

    expect(admission.preset).toEqual(PRESET);
    expect(Object.isFrozen(admission)).toBe(true);
    expect(Object.isFrozen(admission.preset)).toBe(true);
    expect(JSON.parse(JSON.stringify(admission.preset))).toEqual(PRESET);

    const nullPrototype = Object.assign(Object.create(null), PRESET);
    expect(createWebhookJsonEnvironmentAdmission(nullPrototype).preset)
      .toEqual(PRESET);
  });

  it('rejects widened, ambiguous, executable, and accessor preset authority', () => {
    for (const invalid of [
      { ...PRESET, kind: 'other' },
      { ...PRESET, boolean_field: '' },
      { ...PRESET, boolean_field: '__proto__' },
      { ...PRESET, boolean_field: 'x'.repeat(129) },
      { ...PRESET, false_environment: 'preview' },
      { ...PRESET, true_environment: 'preview' },
      { ...PRESET, true_environment: 'test' },
      { ...PRESET, callback: () => true },
      Object.create(PRESET),
    ]) {
      expect(() => createWebhookJsonEnvironmentAdmission(invalid as never))
        .toThrow('invalid trusted preset');
    }

    let getterCalls = 0;
    const accessorPreset = { ...PRESET } as Record<string, unknown>;
    Object.defineProperty(accessorPreset, 'boolean_field', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'production_mode';
      },
    });
    expect(() => createWebhookJsonEnvironmentAdmission(accessorPreset as never))
      .toThrow('invalid trusted preset');
    expect(getterCalls).toBe(0);

    const hostilePreset = new Proxy(PRESET, {
      ownKeys() {
        throw new Error('hostile preset trap');
      },
    });
    expect(() => createWebhookJsonEnvironmentAdmission(hostilePreset))
      .toThrow('invalid trusted preset');
  });
});
