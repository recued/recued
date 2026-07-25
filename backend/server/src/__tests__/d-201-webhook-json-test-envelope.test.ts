import { describe, expect, it } from 'vitest';

import type { WebhookJsonEnvironmentAdmissionPreset } from '../webhook-json-environment-admission.js';
import type { WebhookJsonEventNormalizerPreset } from '../webhook-json-event-normalizer.js';
import { WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET } from '../webhook-json-object-decoder.js';
import {
  createWebhookJsonSingleEventTestEnvelopeBuilder,
  type WebhookJsonSingleEventTestEnvelopePreset,
} from '../webhook-json-single-event-test-envelope.js';

const PRESET: WebhookJsonSingleEventTestEnvelopePreset = {
  kind: 'json_single_event_test_envelope.v1',
  nonce_grammar: 'lowercase_hex_64.v1',
  event_id_prefix: 'probe_message_',
  resource_id_prefix: 'probe_resource_',
  marker_object_field: 'core_probe',
  marker_nonce_field: 'nonce',
};

const NORMALIZER: WebhookJsonEventNormalizerPreset = {
  kind: 'json_single_event_fields.v1',
  event_type_field: 'topic',
  event_type_grammar: 'ascii_alphanumeric_dot_colon_slash_dash.v1',
  event_type_max_bytes: 128,
  event_id_field: 'message_id',
  event_id_max_bytes: 256,
  event_id_required: true,
  provider_id_grammar: 'control_free_trimmed_utf8.v1',
  resource_id_field: null,
  resource_fallback_object_field: 'payload',
  resource_fallback_nested_object_field: 'entity',
  resource_fallback_id_field: 'key',
  resource_id_max_bytes: 256,
  resource_id_required: false,
  invalid_resource_id_disposition: 'reject.v1',
  occurred_at_field: 'sent_at',
  occurred_at_unit: 'unix_seconds.v1',
  occurred_at_required: true,
  challenge_field: null,
  challenge_max_bytes: null,
  conditional_object_requirement: null,
  exact_string_requirement: {
    field: 'kind',
    value: 'notification',
  },
};

const ENVIRONMENT: WebhookJsonEnvironmentAdmissionPreset = {
  kind: 'json_boolean_environment_map.v1',
  boolean_field: 'production',
  false_environment: 'test',
  true_environment: 'live',
};

const createBuilder = (
  preset: WebhookJsonSingleEventTestEnvelopePreset = PRESET,
  normalizer: WebhookJsonEventNormalizerPreset = NORMALIZER,
  environment: WebhookJsonEnvironmentAdmissionPreset = ENVIRONMENT,
) => createWebhookJsonSingleEventTestEnvelopeBuilder(
  preset,
  WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET,
  normalizer,
  environment,
);

describe('D-201 Slice 9C JSON single-event test envelope', () => {
  it('builds one code-ordered envelope from composed field semantics', () => {
    const builder = createBuilder();
    const nonce = 'a'.repeat(64);
    const built = builder.build({
      nonce,
      event_type: 'item.changed',
      occurred_at: 2_000_000_000,
      environment: 'test',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error('expected a built envelope');
    expect(built.raw_body.toString('utf8')).toBe(JSON.stringify({
      message_id: `probe_message_${nonce}`,
      kind: 'notification',
      topic: 'item.changed',
      sent_at: 2_000_000_000,
      production: false,
      payload: { entity: { key: `probe_resource_${nonce}` } },
      core_probe: { nonce },
    }));

    const live = builder.build({
      nonce: 'b'.repeat(64),
      event_type: 'item.created',
      occurred_at: 2_000_000_001,
      environment: 'live',
    });
    expect(live.ok).toBe(true);
    if (!live.ok) throw new Error('expected a live envelope');
    expect(JSON.parse(live.raw_body.toString('utf8'))).toMatchObject({
      production: true,
      topic: 'item.created',
    });
  });

  it('keeps nonce grammar distinct from other invalid envelope inputs', () => {
    const builder = createBuilder();
    expect(builder.hasValidNonce('a'.repeat(64))).toBe(true);
    for (const nonce of [
      undefined,
      null,
      'invalid',
      'A'.repeat(64),
      'a'.repeat(63),
      'a'.repeat(65),
    ]) {
      expect(builder.hasValidNonce(nonce)).toBe(false);
      expect(builder.build({
        nonce,
        event_type: 'item.changed',
        occurred_at: 2_000_000_000,
        environment: 'test',
      })).toEqual({ ok: false, reason: 'invalid_nonce' });
    }
    for (const input of [
      { event_type: undefined, occurred_at: 2_000_000_000, environment: 'test' },
      { event_type: 'invalid event', occurred_at: 2_000_000_000, environment: 'test' },
      { event_type: 'item.changed', occurred_at: -1, environment: 'test' },
      { event_type: 'item.changed', occurred_at: 1.5, environment: 'test' },
      { event_type: 'item.changed', occurred_at: 2_000_000_000, environment: 'custom' },
    ] as const) {
      expect(builder.build({
        nonce: 'a'.repeat(64),
        ...input,
      })).toEqual({ ok: false, reason: 'invalid_envelope' });
    }

    let accessorCalls = 0;
    const accessorInput = {
      nonce: 'a'.repeat(64),
      event_type: 'item.changed',
      occurred_at: 2_000_000_000,
      environment: 'test',
    } as Record<string, unknown>;
    Object.defineProperty(accessorInput, 'event_type', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return 'item.changed';
      },
    });
    expect(builder.build(accessorInput as never))
      .toEqual({ ok: false, reason: 'invalid_envelope' });
    expect(accessorCalls).toBe(0);
    let toJsonCalls = 0;
    expect(builder.build({
      nonce: 'a'.repeat(64),
      event_type: {
        toJSON() {
          toJsonCalls += 1;
          return 'item.changed';
        },
      },
      occurred_at: 2_000_000_000,
      environment: 'test',
    })).toEqual({ ok: false, reason: 'invalid_envelope' });
    expect(toJsonCalls).toBe(0);
  });

  it('copies exact preset data into frozen serializable authority', () => {
    const input = { ...PRESET };
    const builder = createBuilder(input);
    input.event_id_prefix = 'changed_after_construction_';

    expect(builder.preset).toEqual(PRESET);
    expect(Object.isFrozen(builder)).toBe(true);
    expect(Object.isFrozen(builder.preset)).toBe(true);
    expect(JSON.parse(JSON.stringify(builder.preset))).toEqual(PRESET);
    expect(createBuilder(Object.assign(Object.create(null), PRESET)).preset)
      .toEqual(PRESET);
  });

  it('rejects widened, executable, accessor, and unsafe preset authority', () => {
    for (const invalid of [
      { ...PRESET, kind: 'other' },
      { ...PRESET, nonce_grammar: 'uuid.v1' },
      { ...PRESET, event_id_prefix: '' },
      { ...PRESET, event_id_prefix: 'bad prefix' },
      { ...PRESET, resource_id_prefix: 'r'.repeat(129) },
      { ...PRESET, marker_object_field: '__proto__' },
      { ...PRESET, marker_nonce_field: 'constructor' },
      { ...PRESET, callback: () => true },
      Object.create(PRESET),
    ]) {
      expect(() => createBuilder(invalid as never)).toThrow(
        'invalid trusted preset',
      );
    }

    let getterCalls = 0;
    const accessorPreset = { ...PRESET } as Record<string, unknown>;
    Object.defineProperty(accessorPreset, 'event_id_prefix', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'probe_message_';
      },
    });
    expect(() => createBuilder(accessorPreset as never))
      .toThrow('invalid trusted preset');
    expect(getterCalls).toBe(0);

    const hostilePreset = new Proxy(PRESET, {
      ownKeys() {
        throw new Error('hostile preset trap');
      },
    });
    expect(() => createBuilder(hostilePreset)).toThrow('invalid trusted preset');
  });

  it('rejects incompatible decoder-adjacent field semantics at composition', () => {
    for (const [normalizer, environment] of [
      [{ ...NORMALIZER, event_id_required: false }, ENVIRONMENT],
      [{ ...NORMALIZER, occurred_at_required: false }, ENVIRONMENT],
      [{ ...NORMALIZER, exact_string_requirement: null }, ENVIRONMENT],
      [{
        ...NORMALIZER,
        resource_id_field: 'resource_id',
      }, ENVIRONMENT],
      [{
        ...NORMALIZER,
        resource_fallback_object_field: null,
        resource_fallback_nested_object_field: null,
        resource_fallback_id_field: null,
      }, ENVIRONMENT],
      [{
        ...NORMALIZER,
        challenge_field: 'challenge',
        challenge_max_bytes: 128,
      }, ENVIRONMENT],
      [{
        ...NORMALIZER,
        conditional_object_requirement: {
          when_event_type: 'item.changed',
          required_object_field: 'change',
        },
      }, ENVIRONMENT],
      [{
        ...NORMALIZER,
        event_id_max_bytes: 64,
      }, ENVIRONMENT],
      [NORMALIZER, {
        ...ENVIRONMENT,
        boolean_field: NORMALIZER.event_id_field,
      }],
      [NORMALIZER, {
        ...ENVIRONMENT,
        boolean_field: 'constructor',
      }],
    ] as const) {
      expect(() => createBuilder(
        PRESET,
        normalizer as WebhookJsonEventNormalizerPreset,
        environment as WebhookJsonEnvironmentAdmissionPreset,
      )).toThrow('invalid trusted preset');
    }
    expect(() => createBuilder({
      ...PRESET,
      marker_object_field: NORMALIZER.event_type_field,
    })).toThrow('invalid trusted preset');
  });
});
