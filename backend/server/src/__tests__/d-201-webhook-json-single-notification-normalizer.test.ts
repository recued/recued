import { describe, expect, it } from 'vitest';

import {
  WEBHOOK_JSON_SINGLE_NOTIFICATION_PROFILE_PRESETS,
  webhookJsonSingleNotificationProfilePreset,
} from '../webhook-delivery-engine-presets.js';
import {
  createWebhookDotSegmentEventTypeParser,
} from '../webhook-dot-segment-event-type-parser.js';
import {
  createWebhookFixedPrefixProviderIdParser,
} from '../webhook-fixed-prefix-provider-id-parser.js';
import {
  createWebhookJsonObjectDecoder,
  WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET,
} from '../webhook-json-object-decoder.js';
import {
  createWebhookJsonObjectProviderIdExtractor,
} from '../webhook-json-object-provider-id-extractor.js';
import {
  createWebhookJsonRequiredObjectExtractor,
} from '../webhook-json-required-object-extractor.js';
import {
  compileWebhookJsonSingleNotificationNormalizerPreset,
  createWebhookJsonSingleNotificationNormalizer,
  type WebhookJsonSingleNotificationNormalizerDependencies,
} from '../webhook-json-single-notification-normalizer.js';
import {
  createWebhookRfc3339TimestampParser,
} from '../webhook-rfc3339-timestamp-parser.js';

const PRESET = {
  kind: 'json_single_notification_fields.v1',
  event_id_field: 'event_id',
  delivery_id_field: 'notification_id',
  event_type_field: 'event_type',
  occurred_at_field: 'occurred_at',
} as const;

const dependencies = (): WebhookJsonSingleNotificationNormalizerDependencies => ({
  decoder: createWebhookJsonObjectDecoder(WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET),
  event_id_parser: createWebhookFixedPrefixProviderIdParser({
    kind: 'fixed_prefix_lowercase_alphanumeric_id.v1',
    prefix: 'evt_',
    suffix_length: 3,
  }),
  delivery_id_parser: createWebhookFixedPrefixProviderIdParser({
    kind: 'fixed_prefix_lowercase_alphanumeric_id.v1',
    prefix: 'ntf_',
    suffix_length: 3,
  }),
  event_type_parser: createWebhookDotSegmentEventTypeParser({
    kind: 'lowercase_dot_segment_event_type.v1',
    segment_count: 2,
    max_segment_characters: 16,
  }),
  occurred_at_parser: createWebhookRfc3339TimestampParser({
    kind: 'strict_rfc3339_milliseconds.v1',
    max_bytes: 64,
  }),
  data_object_extractor: createWebhookJsonRequiredObjectExtractor({
    kind: 'required_json_object_field.v1',
    field: 'data',
  }),
  resource_id_extractor: createWebhookJsonObjectProviderIdExtractor({
    kind: 'optional_json_object_provider_id.v1',
    field: 'id',
    grammar: 'control_free_trimmed_utf8.v1',
    max_bytes: 32,
  }),
});

const body = (overrides: Record<string, unknown> = {}): Buffer =>
  Buffer.from(JSON.stringify({
    event_id: 'evt_abc',
    notification_id: 'ntf_xyz',
    event_type: 'subscription.updated',
    occurred_at: '2026-07-12T20:00:00.125Z',
    data: { id: 'sub_123' },
    ...overrides,
  }), 'utf8');

describe('D-201 Slice 9L JSON single-notification normalizer', () => {
  it('decodes and assembles generic event and delivery roles', () => {
    const normalizer = createWebhookJsonSingleNotificationNormalizer(
      PRESET,
      dependencies(),
    );
    const normalized = normalizer.normalize(body());
    expect(normalized).toEqual({
      event_id: 'evt_abc',
      delivery_id: 'ntf_xyz',
      event_type: 'subscription.updated',
      occurred_at: Date.parse('2026-07-12T20:00:00.125Z'),
      resource_id: 'sub_123',
      payload: {
        event_id: 'evt_abc',
        notification_id: 'ntf_xyz',
        event_type: 'subscription.updated',
        occurred_at: '2026-07-12T20:00:00.125Z',
        data: { id: 'sub_123' },
      },
    });
    expect(Object.isFrozen(normalizer)).toBe(true);
    expect(Object.isFrozen(normalizer.preset)).toBe(true);
    expect(Object.isFrozen(normalized)).toBe(true);
  });

  it('fails closed when decoding or any required field engine rejects', () => {
    const normalizer = createWebhookJsonSingleNotificationNormalizer(
      PRESET,
      dependencies(),
    );
    for (const rawBody of [
      Buffer.from('{', 'utf8'),
      body({ event_id: 'bad' }),
      body({ notification_id: 'bad' }),
      body({ event_type: 'Subscription.Updated' }),
      body({ occurred_at: 'not-a-time' }),
      body({ data: null }),
      body({ data: [] }),
    ]) {
      expect(normalizer.normalize(rawBody)).toBeNull();
    }
    expect(normalizer.normalize(body({ data: {} }))).toMatchObject({
      resource_id: null,
    });
  });

  it('does not execute field accessors and propagates trusted dependency faults', () => {
    let accessorReads = 0;
    const envelope = {
      notification_id: 'ntf_xyz',
      event_type: 'subscription.updated',
      occurred_at: '2026-07-12T20:00:00Z',
      data: {},
    } as Record<string, unknown>;
    Object.defineProperty(envelope, 'event_id', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return 'evt_abc';
      },
    });
    const base = dependencies();
    const normalizer = createWebhookJsonSingleNotificationNormalizer(PRESET, {
      ...base,
      decoder: {
        preset: base.decoder.preset,
        decode: () => envelope,
      },
    });
    expect(normalizer.normalize(Buffer.alloc(0))).toBeNull();
    expect(accessorReads).toBe(0);

    const throwing = createWebhookJsonSingleNotificationNormalizer(PRESET, {
      ...base,
      decoder: {
        preset: base.decoder.preset,
        decode() {
          throw new Error('trusted decoder failure');
        },
      },
    });
    expect(() => throwing.normalize(Buffer.alloc(0)))
      .toThrow('trusted decoder failure');
  });

  it('accepts exact distinct field presets and rejects dependency collisions', () => {
    expect(compileWebhookJsonSingleNotificationNormalizerPreset(PRESET))
      .toEqual(PRESET);
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'owner_jsonpath.v1' },
      { ...PRESET, event_id_field: '' },
      { ...PRESET, event_id_field: '0event' },
      { ...PRESET, event_id_field: 'event.id' },
      { ...PRESET, event_id_field: 'event_id\n' },
      { ...PRESET, event_id_field: 'a'.repeat(129) },
      { ...PRESET, delivery_id_field: 'event_id' },
      Object.create(PRESET),
      new Proxy({}, {
        getPrototypeOf() {
          throw new Error('hostile normalizer preset');
        },
      }),
    ]) {
      expect(() => compileWebhookJsonSingleNotificationNormalizerPreset(
        invalid as never,
      )).toThrow('invalid trusted preset');
    }

    const base = dependencies();
    expect(() => createWebhookJsonSingleNotificationNormalizer(PRESET, {
      ...base,
      data_object_extractor: createWebhookJsonRequiredObjectExtractor({
        kind: 'required_json_object_field.v1',
        field: 'event_id',
      }),
    })).toThrow('conflicting field dependencies');
  });

  it('keeps Paddle field mapping in the trusted delivery registry', () => {
    const selected = webhookJsonSingleNotificationProfilePreset(
      'paddle.notification.v1',
    );
    expect(selected).toEqual({
      profile_id: 'paddle.notification.v1',
      normalizer: PRESET,
    });
    expect(webhookJsonSingleNotificationProfilePreset('stripe.event.v1'))
      .toBeNull();
    expect(Object.values(WEBHOOK_JSON_SINGLE_NOTIFICATION_PROFILE_PRESETS)
      .map((value) => value?.profile_id)).toEqual(['paddle.notification.v1']);
    expect(Object.isFrozen(WEBHOOK_JSON_SINGLE_NOTIFICATION_PROFILE_PRESETS))
      .toBe(true);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected?.normalizer)).toBe(true);
    expect(() => JSON.stringify(selected)).not.toThrow();
  });
});
