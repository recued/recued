import { describe, expect, it } from 'vitest';

import {
  createWebhookJsonEventNormalizer,
} from '../webhook-json-event-normalizer.js';

const PRESET = {
  kind: 'json_single_event_fields.v1',
  event_type_field: 'kind',
  event_type_grammar: 'ascii_alphanumeric_dot_colon_slash_dash.v1',
  event_type_max_bytes: 16,
  event_id_field: 'id',
  event_id_max_bytes: 8,
  event_id_required: false,
  provider_id_grammar: 'control_free_trimmed_utf8.v1',
  resource_id_field: 'resource',
  resource_fallback_object_field: 'actor',
  resource_fallback_nested_object_field: null,
  resource_fallback_id_field: 'id',
  resource_id_max_bytes: 8,
  resource_id_required: false,
  invalid_resource_id_disposition: 'reject.v1',
  occurred_at_field: 'at',
  occurred_at_unit: 'unix_seconds.v1',
  occurred_at_required: false,
  challenge_field: 'proof',
  challenge_max_bytes: 8,
  conditional_object_requirement: {
    when_event_type: 'requires.object',
    required_object_field: 'data',
  },
  exact_string_requirement: null,
} as const;

const CLASSIC_EVENT_PRESET = {
  ...PRESET,
  event_type_field: 'type',
  event_type_max_bytes: 128,
  event_id_field: 'id',
  event_id_max_bytes: 512,
  event_id_required: true,
  provider_id_grammar: 'trimmed_utf8.v1',
  resource_id_field: null,
  resource_fallback_object_field: 'data',
  resource_fallback_nested_object_field: 'object',
  resource_fallback_id_field: 'id',
  resource_id_max_bytes: 512,
  invalid_resource_id_disposition: 'treat_as_absent.v1',
  occurred_at_field: 'created',
  occurred_at_required: true,
  challenge_field: null,
  challenge_max_bytes: null,
  conditional_object_requirement: null,
  exact_string_requirement: {
    field: 'object',
    value: 'event',
  },
} as const;

describe('D-201 Slices 8S-8Z JSON event-field normalizer', () => {
  it('maps bounded own fields and one conflict-checked resource fallback', () => {
    const normalizer = createWebhookJsonEventNormalizer(PRESET);
    expect(Object.isFrozen(normalizer.preset)).toBe(true);
    expect(Object.isFrozen(normalizer.preset.conditional_object_requirement))
      .toBe(true);
    expect(() => JSON.stringify(normalizer.preset)).not.toThrow();

    const envelope = {
      kind: 'item.changed',
      id: 'evt_8s',
      resource: 'res_8s',
      actor: { id: 'res_8s' },
      at: 1_750_000_000,
      proof: 'proof_8s',
      ignored: { metadata: true },
    };
    const normalized = normalizer.normalize(envelope);
    expect(normalized).toEqual({
      event_type: 'item.changed',
      event_id: 'evt_8s',
      resource_id: 'res_8s',
      occurred_at: 1_750_000_000,
      challenge: 'proof_8s',
      payload: envelope,
    });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(normalized?.payload).toBe(envelope);

    const nestedOnly = {
      kind: 'item.changed',
      actor: { id: 'res_8s' },
    };
    expect(normalizer.normalize(nestedOnly)).toMatchObject({
      event_id: null,
      resource_id: 'res_8s',
      occurred_at: null,
      challenge: null,
    });
    expect(normalizer.normalize({
      kind: 'item.changed',
      resource: null,
      actor: { id: 'res_8s' },
    })).toMatchObject({ resource_id: 'res_8s' });
    for (const actor of [undefined, null, 'ignored', []]) {
      expect(normalizer.normalize({ kind: 'delivery', actor })).toMatchObject({
        resource_id: null,
      });
    }
    expect(normalizer.normalize({
      kind: 'delivery',
      resource: 'direct',
      actor: { id: 'nested' },
    })).toBeNull();

    const noFallbackOrChallenge = createWebhookJsonEventNormalizer({
      ...PRESET,
      resource_fallback_object_field: null,
      resource_fallback_nested_object_field: null,
      resource_fallback_id_field: null,
      challenge_field: null,
      challenge_max_bytes: null,
    });
    expect(noFallbackOrChallenge.normalize({
      kind: 'delivery',
      actor: { id: 'ignored' },
      proof: 'ignored',
    })).toMatchObject({ resource_id: null, challenge: null });
  });

  it('applies one own plain-object requirement only to its selected event type', () => {
    const normalizer = createWebhookJsonEventNormalizer(PRESET);
    expect(normalizer.normalize({
      kind: 'requires.object',
      data: { value: true },
    })).not.toBeNull();
    expect(normalizer.normalize({
      kind: 'requires.object',
      data: Object.create(null),
    })).not.toBeNull();
    for (const data of [undefined, null, 'invalid', []]) {
      expect(normalizer.normalize({ kind: 'requires.object', data })).toBeNull();
    }
    expect(normalizer.normalize({
      kind: 'requires.object',
      data: new Date(0),
    })).toBeNull();

    const inheritedData = Object.create({ data: { value: true } });
    inheritedData.kind = 'requires.object';
    expect(normalizer.normalize(inheritedData)).toBeNull();

    const nonEnumerableData = { kind: 'requires.object' };
    Object.defineProperty(nonEnumerableData, 'data', {
      enumerable: false,
      value: { value: true },
    });
    expect(normalizer.normalize(nonEnumerableData)).toBeNull();

    let accessorInvoked = false;
    const selectedAccessor = { kind: 'requires.object' };
    Object.defineProperty(selectedAccessor, 'data', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('conditional object accessor must not execute');
      },
    });
    expect(normalizer.normalize(selectedAccessor)).toBeNull();
    expect(accessorInvoked).toBe(false);

    const ignoredAccessor = { kind: 'other' };
    Object.defineProperty(ignoredAccessor, 'data', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('unmatched conditional field must not execute');
      },
    });
    expect(normalizer.normalize(ignoredAccessor)).not.toBeNull();
    expect(accessorInvoked).toBe(false);

    const unconditional = createWebhookJsonEventNormalizer({
      ...PRESET,
      conditional_object_requirement: null,
    });
    expect(unconditional.normalize({ kind: 'requires.object' })).not.toBeNull();
  });

  it('applies an exact string discriminator, required fields, and a deeper resource fallback', () => {
    const normalizer = createWebhookJsonEventNormalizer(CLASSIC_EVENT_PRESET);
    expect(Object.isFrozen(normalizer.preset.exact_string_requirement)).toBe(true);
    const envelope = {
      id: 'evt_8z',
      object: 'event',
      type: 'invoice.paid',
      created: 1_750_000_000,
      resource_id: 'ignored-top-level-authority',
      data: { object: { id: 'in_8z' } },
    };
    expect(normalizer.normalize(envelope)).toEqual({
      event_type: 'invoice.paid',
      event_id: 'evt_8z',
      resource_id: 'in_8z',
      occurred_at: 1_750_000_000,
      challenge: null,
      payload: envelope,
    });
    expect(normalizer.normalize({
      id: 'evt_without_resource',
      object: 'event',
      type: 'invoice.paid',
      created: 1_750_000_000,
    })).toMatchObject({ resource_id: null });

    for (const invalid of [
      { ...envelope, object: 'v2.core.event' },
      { ...envelope, object: undefined },
      { ...envelope, id: undefined },
      { ...envelope, created: undefined },
    ]) {
      expect(normalizer.normalize(invalid)).toBeNull();
    }
    expect(normalizer.normalize({
      ...envelope,
      id: 'evt_control\nidentifier',
    })).toMatchObject({ event_id: 'evt_control\nidentifier' });
    for (const data of [null, 'ignored', [], { object: null }]) {
      expect(normalizer.normalize({ ...envelope, data })).toMatchObject({
        resource_id: null,
      });
    }
    for (const id of [null, '', ' padded ', 'r'.repeat(513)]) {
      expect(normalizer.normalize({
        ...envelope,
        data: { object: { id } },
      })).toMatchObject({ resource_id: null });
    }

    let accessorInvoked = false;
    const discriminatorAccessor = { ...envelope };
    Object.defineProperty(discriminatorAccessor, 'object', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('exact discriminator accessor must not execute');
      },
    });
    expect(normalizer.normalize(discriminatorAccessor)).toBeNull();
    const nestedAccessor = { ...envelope, data: {} };
    Object.defineProperty(nestedAccessor.data, 'object', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('nested resource accessor must not execute');
      },
    });
    expect(normalizer.normalize(nestedAccessor)).toBeNull();
    const outerAccessor = { ...envelope };
    Object.defineProperty(outerAccessor, 'data', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('outer resource accessor must not execute');
      },
    });
    expect(normalizer.normalize(outerAccessor)).toBeNull();
    const directResourceNormalizer = createWebhookJsonEventNormalizer({
      ...CLASSIC_EVENT_PRESET,
      resource_id_field: 'resource',
    });
    const directAccessor = { ...envelope };
    Object.defineProperty(directAccessor, 'resource', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('direct resource accessor must not execute');
      },
    });
    expect(directResourceNormalizer.normalize(directAccessor)).toBeNull();
    expect(accessorInvoked).toBe(false);

    const requiredResource = createWebhookJsonEventNormalizer({
      ...CLASSIC_EVENT_PRESET,
      resource_id_required: true,
    });
    expect(requiredResource.normalize({
      id: 'evt_without_resource',
      object: 'event',
      type: 'invoice.paid',
      created: 1_750_000_000,
    })).toBeNull();
    expect(requiredResource.normalize({
      id: 'evt_invalid_required_resource',
      object: 'event',
      type: 'invoice.paid',
      created: 1_750_000_000,
      data: { object: { id: ' padded ' } },
    })).toBeNull();
  });

  it('enforces string, grammar, and timestamp bounds without coercion', () => {
    const normalizer = createWebhookJsonEventNormalizer(PRESET);
    expect(normalizer.normalize({
      kind: 't'.repeat(16),
      id: 'i'.repeat(8),
      resource: 'r'.repeat(8),
      at: Math.floor(Number.MAX_SAFE_INTEGER / 1_000),
      proof: 'p'.repeat(8),
    })).not.toBeNull();

    for (const envelope of [
      null,
      {},
      { kind: '' },
      { kind: ' padded ' },
      { kind: 'bad value' },
      { kind: 't'.repeat(17) },
      { kind: 'delivery', id: '' },
      { kind: 'delivery', id: 'i'.repeat(9) },
      { kind: 'delivery', resource: 'bad\nvalue' },
      { kind: 'delivery', actor: { id: 'r'.repeat(9) } },
      { kind: 'delivery', at: -1 },
      { kind: 'delivery', at: 1.5 },
      {
        kind: 'delivery',
        at: Math.floor(Number.MAX_SAFE_INTEGER / 1_000) + 1,
      },
      { kind: 'delivery', proof: 'p'.repeat(9) },
    ]) {
      expect(normalizer.normalize(envelope)).toBeNull();
    }

    const milliseconds = createWebhookJsonEventNormalizer({
      ...PRESET,
      occurred_at_unit: 'unix_milliseconds.v1',
    });
    expect(milliseconds.normalize({
      kind: 'delivery',
      at: Number.MAX_SAFE_INTEGER,
    })).toMatchObject({ occurred_at: Number.MAX_SAFE_INTEGER });
    expect(milliseconds.normalize({
      kind: 'delivery',
      at: Number.MAX_SAFE_INTEGER + 1,
    })).toBeNull();
  });

  it('fails closed on accessors, inherited fields, and widened presets', () => {
    const normalizer = createWebhookJsonEventNormalizer(PRESET);
    let accessorInvoked = false;
    const selectedAccessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(selectedAccessor, 'kind', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('event-type accessor must not execute');
      },
    });
    expect(normalizer.normalize(selectedAccessor)).toBeNull();
    expect(accessorInvoked).toBe(false);

    const nestedAccessor = { kind: 'delivery', actor: {} };
    Object.defineProperty(nestedAccessor.actor, 'id', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('nested resource accessor must not execute');
      },
    });
    expect(normalizer.normalize(nestedAccessor)).toBeNull();
    expect(accessorInvoked).toBe(false);

    const ignoredAccessor = { kind: 'delivery' };
    Object.defineProperty(ignoredAccessor, 'ignored', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('ignored accessor must not execute');
      },
    });
    expect(normalizer.normalize(ignoredAccessor)).not.toBeNull();
    expect(accessorInvoked).toBe(false);

    const inheritedType = createWebhookJsonEventNormalizer({
      ...PRESET,
      event_type_field: 'toString',
    });
    expect(inheritedType.normalize({ kind: 'ignored' })).toBeNull();
    expect(normalizer.normalize(new Proxy({}, {
      getPrototypeOf() {
        throw new Error('hostile event proxy');
      },
    }))).toBeNull();

    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      event_type_max_bytes: 128,
      event_id_field: 'f'.repeat(128),
      event_id_max_bytes: 512,
      resource_id_max_bytes: 512,
      challenge_max_bytes: 65_536,
      conditional_object_requirement: {
        when_event_type: 't'.repeat(128),
        required_object_field: 'c'.repeat(128),
      },
    })).not.toThrow();

    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      event_id_field: 'kind',
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      event_id_field: 'bad-field',
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      event_id_field: 'f'.repeat(129),
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      resource_fallback_id_field: null,
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      resource_fallback_object_field: null,
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      resource_fallback_object_field: null,
      resource_fallback_id_field: null,
      resource_fallback_nested_object_field: 'object',
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      resource_id_field: null,
      resource_fallback_object_field: null,
      resource_fallback_id_field: null,
      resource_id_required: true,
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      challenge_max_bytes: null,
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      challenge_field: null,
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      event_type_max_bytes: 129,
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      event_id_max_bytes: 513,
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      resource_id_max_bytes: 513,
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      challenge_max_bytes: 65_537,
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      event_type_grammar: 'owner_regex.v1',
    } as never)).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      event_id_required: 'yes',
    } as never)).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      provider_id_grammar: 'owner_regex.v1',
    } as never)).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      invalid_resource_id_disposition: 'coerce.v1',
    } as never)).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      exact_string_requirement: {
        field: 'kind',
        value: 'event',
      },
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      exact_string_requirement: {
        field: 'object',
        value: ' padded ',
      },
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      exact_string_requirement: {
        field: 'bad-field',
        value: 'event',
      },
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      exact_string_requirement: {
        field: 'object',
        value: 'event',
        matcher: () => true,
      },
    } as never)).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      conditional_object_requirement: {
        when_event_type: ' padded ',
        required_object_field: 'data',
      },
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      conditional_object_requirement: {
        when_event_type: 'bad value',
        required_object_field: 'data',
      },
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      conditional_object_requirement: {
        when_event_type: 't'.repeat(17),
        required_object_field: 'data',
      },
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      conditional_object_requirement: {
        when_event_type: 'requires.object',
        required_object_field: 'f'.repeat(129),
      },
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      conditional_object_requirement: {
        when_event_type: 'requires.object',
        required_object_field: 'kind',
      },
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      conditional_object_requirement: {
        when_event_type: 'requires.object',
        required_object_field: 'bad-field',
      },
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      conditional_object_requirement: {
        ...PRESET.conditional_object_requirement,
        validator: () => true,
      },
    } as never)).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      occurred_at_unit: 'iso8601_callback.v1',
    } as never)).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonEventNormalizer({
      ...PRESET,
      transform: () => 'executable normalizer',
    } as never)).toThrow('invalid trusted preset');

    const accessorPreset = { ...PRESET } as Record<string, unknown>;
    Object.defineProperty(accessorPreset, 'kind', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('normalizer preset accessor must not execute');
      },
    });
    expect(() => createWebhookJsonEventNormalizer(
      accessorPreset as never,
    )).toThrow('invalid trusted preset');
    expect(accessorInvoked).toBe(false);

    const conditionalAccessorPreset = { ...PRESET } as Record<string, unknown>;
    const conditional = {
      ...PRESET.conditional_object_requirement,
    } as Record<string, unknown>;
    Object.defineProperty(conditional, 'required_object_field', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('conditional preset accessor must not execute');
      },
    });
    conditionalAccessorPreset.conditional_object_requirement = conditional;
    expect(() => createWebhookJsonEventNormalizer(
      conditionalAccessorPreset as never,
    )).toThrow('invalid trusted preset');
    expect(accessorInvoked).toBe(false);

    const exactAccessorPreset = { ...PRESET } as Record<string, unknown>;
    const exactString = {
      field: 'object',
      value: 'event',
    } as Record<string, unknown>;
    Object.defineProperty(exactString, 'value', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('exact-string preset accessor must not execute');
      },
    });
    exactAccessorPreset.exact_string_requirement = exactString;
    expect(() => createWebhookJsonEventNormalizer(
      exactAccessorPreset as never,
    )).toThrow('invalid trusted preset');
    expect(accessorInvoked).toBe(false);
  });
});
