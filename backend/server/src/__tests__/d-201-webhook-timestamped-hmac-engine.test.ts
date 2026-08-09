import { createHmac } from 'node:crypto';
import {
  webhookProfile,
  webhookProfileAcceptsEventType,
} from '@recued/contracts';
import { describe, expect, it } from 'vitest';

import {
  PADDLE_SIGNATURE_HEADER,
  PADDLE_WEBHOOK_TOLERANCE_SECONDS,
  verifyPaddleWebhookSignature,
} from '../connections/providers/paddle-webhook-protocol.js';
import {
  SLACK_REPLAY_WINDOW_SECONDS,
  SLACK_REQUEST_TIMESTAMP_HEADER,
  SLACK_SIGNATURE_HEADER,
  verifySlackWebhookSignature,
} from '../connections/providers/slack-webhook-protocol.js';
import {
  STRIPE_SIGNATURE_HEADER,
  verifyStripeWebhookSignature,
} from '../connections/providers/stripe-webhook-protocol.js';
import {
  WEBHOOK_TIMESTAMPED_HMAC_DELIVERY_PROFILE_PRESETS,
} from '../webhook-delivery-engine-presets.js';
import {
  WEBHOOK_FORM_URLENCODED_DECODER_V1_PRESET,
} from '../webhook-form-urlencoded-decoder.js';
import {
  WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET,
} from '../webhook-json-object-decoder.js';
import {
  PADDLE_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET,
  PADDLE_TIMESTAMPED_HMAC_MECHANISM_PRESET,
} from '../webhook-paddle-profile.js';
import {
  GENERIC_TIMESTAMPED_HMAC_MECHANISM_PRESET,
} from '../webhook-primitive-profiles.js';
import {
  SLACK_FLAT_FORM_EVENT_NORMALIZER_PRESET,
  SLACK_FORM_URLENCODED_DECODER_PRESET,
  SLACK_FORM_WRAPPED_JSON_DECODER_PRESET,
  SLACK_JSON_CHALLENGE_PROJECTOR_PRESET,
  SLACK_JSON_EVENT_NORMALIZER_PRESET,
  SLACK_JSON_OBJECT_DECODER_PRESET,
  SLACK_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET,
  SLACK_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET,
  SLACK_TIMESTAMPED_HMAC_MECHANISM_PRESET,
} from '../webhook-slack-profile.js';
import {
  STRIPE_JSON_ENVIRONMENT_ADMISSION_PRESET,
  STRIPE_JSON_EVENT_NORMALIZER_PRESET,
  STRIPE_JSON_OBJECT_DECODER_PRESET,
  STRIPE_JSON_SINGLE_EVENT_TEST_ENVELOPE_PRESET,
  STRIPE_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET,
  STRIPE_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET,
  STRIPE_TIMESTAMPED_HMAC_MECHANISM_PRESET,
} from '../webhook-stripe-profile.js';
import {
  createWebhookTimestampedHmacMechanism,
  WEBHOOK_TIMESTAMPED_HMAC_REPLAY_WINDOW_SECONDS,
} from '../webhook-timestamped-hmac-engine.js';
import type {
  RawWebhookRequest,
  ResolvedWebhookCredentialVersion,
  WebhookProfileRuntimeContext,
} from '../webhook-profile-runtime.js';

const BODY = Buffer.from('{"z":1,\n "a":{"ok":true}}', 'utf8');
const NOW_SECONDS = 2_000_000_000;
const NOW_MS = NOW_SECONDS * 1_000;
const STRIPE_SECRET = 'whsec_D201TimestampedEngine123';
const PADDLE_SECRET =
  'pdl_ntfset_01gkpjp8bkm3tm53kdgkx6sms7_6h3qd3uFSi9YCD3OLYAShQI90XTI5vEI';
const SLACK_SECRET = 'slack-signing-secret-d201-engine';

const version = (
  value: number,
  createdAt: number,
  credentials: Record<string, string>,
): ResolvedWebhookCredentialVersion => ({
  version: String(value),
  created_at: createdAt,
  credentials,
});

const context = (
  credentialVersions: readonly ResolvedWebhookCredentialVersion[],
  now: () => number = () => NOW_MS,
): WebhookProfileRuntimeContext => ({
  ingress_id: 'whi_d201_timestamped_engine_fixture',
  environment: 'test',
  credential_versions: credentialVersions,
  now,
});

const request = (
  rawBody: Buffer,
  headers: Readonly<Record<string, string | readonly string[]>>,
): RawWebhookRequest => ({
  method: 'POST',
  raw_body: rawBody,
  headers: new Map(Object.entries(headers).map(([name, value]) => [
    name.toLowerCase(),
    typeof value === 'string' ? [value] : value,
  ])),
  raw_path_and_query: '/v1/webhooks/timestamped-engine-fixture',
  canonical_public_url:
    'https://hooks.example.test/v1/webhooks/timestamped-engine-fixture',
  received_at: NOW_MS,
  remote_ip: '127.0.0.1',
});

const signature = (
  secret: string,
  timestamp: string,
  body = BODY,
): string => createHmac('sha256', secret)
  .update(`${timestamp}.`)
  .update(body)
  .digest('hex');

const colonSignature = (
  secret: string,
  timestamp: string,
  body = BODY,
): string => createHmac('sha256', secret)
  .update(`${timestamp}:`)
  .update(body)
  .digest('hex');

const v0Signature = (
  secret: string,
  timestamp: string,
  body = BODY,
): string => `v0=${createHmac('sha256', secret)
  .update(`v0:${timestamp}:`)
  .update(body)
  .digest('hex')}`;

const expectDeeplyFrozen = (value: unknown, seen = new WeakSet<object>()): void => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    expectDeeplyFrozen((value as Record<PropertyKey, unknown>)[key], seen);
  }
};

describe('D-201 Slices 8L-9C + 9BH timestamped HMAC profile engine', () => {
  it('keeps profile differences in frozen serializable preset data', () => {
    expect(Object.keys(WEBHOOK_TIMESTAMPED_HMAC_DELIVERY_PROFILE_PRESETS)).toEqual([
      'generic.timestamped-raw-body-hmac-sha256.v1',
      'stripe.event.v1',
      'paddle.notification.v1',
      'slack.request.v0',
      'slack.slash-command.v1',
      'recued-peer.exchange.v1',
    ]);
    expect(Object.getPrototypeOf(WEBHOOK_TIMESTAMPED_HMAC_DELIVERY_PROFILE_PRESETS))
      .toBeNull();
    expectDeeplyFrozen(WEBHOOK_TIMESTAMPED_HMAC_DELIVERY_PROFILE_PRESETS);
    expect(() => JSON.stringify(WEBHOOK_TIMESTAMPED_HMAC_DELIVERY_PROFILE_PRESETS))
      .not.toThrow();
    expect(GENERIC_TIMESTAMPED_HMAC_MECHANISM_PRESET).toEqual({
      kind: 'timestamped_hmac_sha256.v1',
      secret_field: 'signing_secret',
      secret_shape: {
        kind: 'nonempty_utf8.v1',
        max_bytes: 65_536,
      },
      signature_header: {
        kind: 'credential_field',
        field: 'signature_header',
      },
      timestamp_source: { kind: 'signature_envelope' },
      signature_envelope: 'strict_ordered_comma_t_v1_lowerhex.v1',
      signed_payload: 'timestamp_dot_raw_body.v1',
      replay_window_seconds: 300,
      admission_order: 'clock_then_signature',
      matching_credential: 'first',
    });
    expect(STRIPE_TIMESTAMPED_HMAC_MECHANISM_PRESET).toEqual({
      kind: 'timestamped_hmac_sha256.v1',
      secret_field: 'endpoint_secret',
      secret_shape: {
        kind: 'prefixed_ascii_token.v1',
        prefix: 'whsec_',
        max_bytes: 4_096,
      },
      signature_header: { kind: 'fixed', name: STRIPE_SIGNATURE_HEADER },
      timestamp_source: { kind: 'signature_envelope' },
      signature_envelope: 'extensible_comma_t_v1_hex.v1',
      signed_payload: 'timestamp_dot_raw_body.v1',
      replay_window_seconds: 300,
      admission_order: 'signature_then_clock',
      matching_credential: 'newest',
    });
    expect(STRIPE_JSON_OBJECT_DECODER_PRESET)
      .toEqual(WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET);
    expect(STRIPE_JSON_ENVIRONMENT_ADMISSION_PRESET).toEqual({
      kind: 'json_boolean_environment_map.v1',
      boolean_field: 'livemode',
      false_environment: 'test',
      true_environment: 'live',
    });
    expect(STRIPE_JSON_SINGLE_EVENT_TEST_ENVELOPE_PRESET).toEqual({
      kind: 'json_single_event_test_envelope.v1',
      nonce_grammar: 'lowercase_hex_64.v1',
      event_id_prefix: 'evt_recued_test_',
      resource_id_prefix: 'recued_test_',
      marker_object_field: 'recued_test_delivery',
      marker_nonce_field: 'nonce',
    });
    expect(STRIPE_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET).toEqual({
      kind: 'normalized_single_event.v1',
      provider_event_id_field: 'event_id',
      provider_resource_id_field: 'resource_id',
      provider_event_type_field: 'event_type',
      provider_occurred_at_field: 'occurred_at',
      decoded_payload_field: 'payload',
      occurred_at_unit: 'unix_seconds_to_milliseconds.v1',
    });
    expect(STRIPE_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET).toEqual({
      kind: 'normalized_id_or_timestamp_body_sha256.v1',
      stable_id_field: 'event_id',
      stable_id_prefix: 'stripe:event:',
      fallback_prefix: 'stripe:request:',
      max_body_bytes: 1_048_576,
    });
    expect(STRIPE_JSON_EVENT_NORMALIZER_PRESET).toEqual({
      kind: 'json_single_event_fields.v1',
      event_type_field: 'type',
      event_type_grammar: 'ascii_alphanumeric_dot_colon_slash_dash.v1',
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
      resource_id_required: false,
      invalid_resource_id_disposition: 'treat_as_absent.v1',
      occurred_at_field: 'created',
      occurred_at_unit: 'unix_seconds.v1',
      occurred_at_required: true,
      challenge_field: null,
      challenge_max_bytes: null,
      conditional_object_requirement: null,
      exact_string_requirement: {
        field: 'object',
        value: 'event',
      },
    });
    expect(PADDLE_TIMESTAMPED_HMAC_MECHANISM_PRESET).toEqual({
      kind: 'timestamped_hmac_sha256.v1',
      secret_field: 'endpoint_secret_key',
      secret_shape: {
        kind: 'segmented_ascii_token.v1',
        prefix: 'pdl_ntfset_',
        separator: '_',
        segment_lengths: [26, 32],
      },
      signature_header: { kind: 'fixed', name: PADDLE_SIGNATURE_HEADER },
      timestamp_source: { kind: 'signature_envelope' },
      signature_envelope: 'strict_semicolon_ts_h1_lowerhex.v1',
      signed_payload: 'timestamp_colon_raw_body.v1',
      replay_window_seconds: 5,
      admission_order: 'signature_then_clock',
      matching_credential: 'newest',
    });
    expect(PADDLE_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET).toEqual({
      kind: 'normalized_paired_ids_sha256.v1',
      delivery_id_field: 'delivery_id',
      event_id_field: 'event_id',
      delivery_id_prefix: 'paddle:notification:',
      event_id_prefix: 'paddle:event:',
    });
    expect(SLACK_TIMESTAMPED_HMAC_MECHANISM_PRESET).toEqual({
      kind: 'timestamped_hmac_sha256.v1',
      secret_field: 'signing_secret',
      secret_shape: {
        kind: 'nonempty_utf8.v1',
        max_bytes: 4_096,
      },
      signature_header: { kind: 'fixed', name: SLACK_SIGNATURE_HEADER },
      timestamp_source: {
        kind: 'fixed_header',
        name: SLACK_REQUEST_TIMESTAMP_HEADER,
      },
      signature_envelope: 'separate_decimal_timestamp_v0_lowerhex.v1',
      signed_payload: 'v0_colon_timestamp_colon_raw_body.v1',
      replay_window_seconds: 300,
      admission_order: 'signature_then_clock',
      matching_credential: 'newest',
    });
    expect(SLACK_JSON_OBJECT_DECODER_PRESET)
      .toEqual(WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET);
    expect(SLACK_FORM_URLENCODED_DECODER_PRESET)
      .toEqual(WEBHOOK_FORM_URLENCODED_DECODER_V1_PRESET);
    expect(SLACK_FORM_WRAPPED_JSON_DECODER_PRESET).toEqual({
      kind: 'exclusive_form_json_field.v1',
      json_field: 'payload',
    });
    expect(SLACK_FLAT_FORM_EVENT_NORMALIZER_PRESET).toEqual({
      kind: 'flat_form_slash_command_event.v1',
      event_type: 'slash_command',
      payload_event_type_field: 'type',
      command_field: 'command',
      event_id_field: 'trigger_id',
      event_id_max_bytes: 512,
      resource_id_field: 'team_id',
      resource_id_max_bytes: 512,
      reserved_fields: ['type', 'event_id', 'event_time', 'challenge'],
      payload_omitted_fields: [],
    });
    const slashCommandPreset =
      WEBHOOK_TIMESTAMPED_HMAC_DELIVERY_PROFILE_PRESETS[
        'slack.slash-command.v1'
      ]!;
    expect(slashCommandPreset.mechanism)
      .toEqual(SLACK_TIMESTAMPED_HMAC_MECHANISM_PRESET);
    expect(slashCommandPreset.decoder).toBeNull();
    expect(slashCommandPreset.form_decoder)
      .toEqual(WEBHOOK_FORM_URLENCODED_DECODER_V1_PRESET);
    expect(slashCommandPreset.handshake).toBeNull();
    expect(slashCommandPreset.event_normalizer).toBeNull();
    expect(slashCommandPreset.form_json_envelope).toBeNull();
    expect(slashCommandPreset.flat_form_event_normalizer).toMatchObject({
      event_type: 'slash_command',
      reserved_fields: expect.arrayContaining(['ssl_check']),
      payload_omitted_fields: ['response_url', 'token'],
    });
    expect(SLACK_JSON_CHALLENGE_PROJECTOR_PRESET).toEqual({
      kind: 'json_challenge_echo.v1',
      discriminator_field: 'type',
      discriminator_value: 'url_verification',
      challenge_field: 'challenge',
      response_field: 'challenge',
      max_challenge_bytes: 4_096,
    });
    expect(SLACK_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET).toEqual({
      kind: 'normalized_single_event.v1',
      provider_event_id_field: 'event_id',
      provider_resource_id_field: 'resource_id',
      provider_event_type_field: 'event_type',
      provider_occurred_at_field: 'occurred_at',
      decoded_payload_field: 'payload',
      occurred_at_unit: 'unix_seconds_to_milliseconds.v1',
    });
    expect(SLACK_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET).toEqual({
      kind: 'normalized_id_or_timestamp_body_sha256.v1',
      stable_id_field: 'event_id',
      stable_id_prefix: 'slack:event:',
      fallback_prefix: 'slack:request:',
      max_body_bytes: 1_048_576,
    });
    expect(SLACK_JSON_EVENT_NORMALIZER_PRESET).toEqual({
      kind: 'json_single_event_fields.v1',
      event_type_field: 'type',
      event_type_grammar: 'ascii_alphanumeric_dot_colon_slash_dash.v1',
      event_type_max_bytes: 128,
      event_id_field: 'event_id',
      event_id_max_bytes: 512,
      event_id_required: false,
      provider_id_grammar: 'control_free_trimmed_utf8.v1',
      resource_id_field: 'team_id',
      resource_fallback_object_field: 'team',
      resource_fallback_nested_object_field: null,
      resource_fallback_id_field: 'id',
      resource_id_max_bytes: 512,
      resource_id_required: false,
      invalid_resource_id_disposition: 'reject.v1',
      occurred_at_field: 'event_time',
      occurred_at_unit: 'unix_seconds.v1',
      occurred_at_required: false,
      challenge_field: 'challenge',
      challenge_max_bytes: 4_096,
      conditional_object_requirement: {
        when_event_type: 'event_callback',
        required_object_field: 'event',
      },
      exact_string_requirement: null,
    });
    expect(Object.values(WEBHOOK_TIMESTAMPED_HMAC_DELIVERY_PROFILE_PRESETS)
      .flatMap((preset) => preset !== undefined
        && preset.event_projector !== null
        ? [preset.profile_id]
        : [])).toEqual([
          'stripe.event.v1',
          'paddle.notification.v1',
          'slack.request.v0',
          'slack.slash-command.v1',
          'recued-peer.exchange.v1',
        ]);
    expect(Object.values(WEBHOOK_TIMESTAMPED_HMAC_DELIVERY_PROFILE_PRESETS)
      .flatMap((preset) => preset !== undefined
        && preset.event_normalizer !== null
        ? [preset.profile_id]
        : [])).toEqual([
          'stripe.event.v1',
          'slack.request.v0',
          'recued-peer.exchange.v1',
        ]);
    expect(Object.values(WEBHOOK_TIMESTAMPED_HMAC_DELIVERY_PROFILE_PRESETS)
      .flatMap((preset) => preset !== undefined
        && preset.environment_admission !== null
        ? [preset.profile_id]
        : [])).toEqual(['stripe.event.v1', 'recued-peer.exchange.v1']);
    expect(Object.values(WEBHOOK_TIMESTAMPED_HMAC_DELIVERY_PROFILE_PRESETS)
      .flatMap((preset) => preset !== undefined
        && preset.test_envelope !== null
        ? [preset.profile_id]
        : [])).toEqual(['stripe.event.v1', 'recued-peer.exchange.v1']);
    expect(Object.values(WEBHOOK_TIMESTAMPED_HMAC_DELIVERY_PROFILE_PRESETS)
      .flatMap((preset) => preset !== undefined
        && preset.delivery_deduplicator !== null
        ? [preset.profile_id]
        : [])).toEqual([
          'stripe.event.v1',
          'paddle.notification.v1',
          'slack.request.v0',
          'slack.slash-command.v1',
          'recued-peer.exchange.v1',
        ]);
    expect(Object.values(WEBHOOK_TIMESTAMPED_HMAC_DELIVERY_PROFILE_PRESETS)
      .flatMap((preset) => preset !== undefined
        && preset.form_json_envelope !== null
        ? [preset.profile_id]
        : [])).toEqual(['slack.request.v0']);
    expect(Object.values(WEBHOOK_TIMESTAMPED_HMAC_DELIVERY_PROFILE_PRESETS)
      .flatMap((preset) => preset !== undefined
        && preset.flat_form_event_normalizer !== null
        ? [preset.profile_id]
        : [])).toEqual(['slack.request.v0', 'slack.slash-command.v1']);
    for (const deliveryPreset of Object.values(
      WEBHOOK_TIMESTAMPED_HMAC_DELIVERY_PROFILE_PRESETS,
    )) {
      expect(deliveryPreset).toBeDefined();
      if (deliveryPreset === undefined) continue;
      const descriptor = webhookProfile(deliveryPreset.profile_id)!;
      expect(descriptor.mechanism_kind).toBe('timestamped_hmac');
      expect(descriptor.decoder_kind).toBe(
        deliveryPreset.decoder === null ? 'form_urlencoded' : 'json',
      );
      if (deliveryPreset.decoder !== null) {
        expect(deliveryPreset.decoder)
          .toEqual(WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET);
      }
      expect(deliveryPreset.form_decoder !== null).toBe(
        descriptor.allowed_content_types.includes(
          'application/x-www-form-urlencoded',
        ),
      );
      if (deliveryPreset.form_json_envelope !== null) {
        expect(deliveryPreset.form_decoder).not.toBeNull();
        expect(Buffer.byteLength(
          deliveryPreset.form_json_envelope.json_field,
          'utf8',
        )).toBeLessThanOrEqual(deliveryPreset.form_decoder!.max_key_bytes);
      }
      if (deliveryPreset.flat_form_event_normalizer !== null) {
        const flat = deliveryPreset.flat_form_event_normalizer;
        expect(deliveryPreset.form_decoder).not.toBeNull();
        expect(deliveryPreset.event_projector).not.toBeNull();
        const descriptorEventTypes = descriptor.event_types.kind === 'closed'
          ? descriptor.event_types.values
          : descriptor.event_types.known_values;
        expect(webhookProfileAcceptsEventType(descriptor, flat.event_type))
          .toBe(true);
        if (deliveryPreset.profile_id === 'slack.request.v0') {
          expect(descriptorEventTypes).not.toContain(flat.event_type);
          expect(descriptor.handshakes).toContain('slack_url_verification');
        } else {
          expect(descriptorEventTypes).toContain(flat.event_type);
          expect(descriptor.handshakes).toEqual([]);
        }
        for (const field of [
          flat.payload_event_type_field,
          flat.command_field,
          flat.event_id_field,
          flat.resource_id_field,
          ...flat.reserved_fields,
          ...flat.payload_omitted_fields,
        ]) {
          expect(Buffer.byteLength(field, 'utf8'))
            .toBeLessThanOrEqual(deliveryPreset.form_decoder!.max_key_bytes);
        }
        expect(flat.event_id_max_bytes)
          .toBeLessThanOrEqual(deliveryPreset.form_decoder!.max_value_bytes);
        expect(flat.resource_id_max_bytes)
          .toBeLessThanOrEqual(deliveryPreset.form_decoder!.max_value_bytes);
      }
      expect([...descriptor.allowed_content_types].sort()).toEqual(
        [
          ...(deliveryPreset.decoder === null ? [] : ['application/json']),
          ...(deliveryPreset.form_decoder === null
            ? []
            : ['application/x-www-form-urlencoded']),
        ].sort(),
      );
      expect(descriptor.handshakes).toEqual(
        deliveryPreset.handshake === null
          ? []
          : [deliveryPreset.handshake.portable_kind],
      );
      if (deliveryPreset.event_projector !== null) {
        expect(descriptor.max_events_per_delivery).toBe(1);
        expect(deliveryPreset.event_projector).toMatchObject({
          provider_event_id_field: 'event_id',
          provider_resource_id_field: 'resource_id',
          provider_event_type_field: 'event_type',
          provider_occurred_at_field: 'occurred_at',
          decoded_payload_field: 'payload',
        });
      }
      if (deliveryPreset.delivery_deduplicator !== null) {
        expect(deliveryPreset.event_projector).not.toBeNull();
        if (deliveryPreset.delivery_deduplicator.kind
          === 'normalized_id_or_timestamp_body_sha256.v1') {
          expect(deliveryPreset.delivery_deduplicator.max_body_bytes)
            .toBe(descriptor.max_body_bytes);
          expect(deliveryPreset.delivery_deduplicator.stable_id_field)
            .toBe(deliveryPreset.event_projector?.provider_event_id_field);
        } else {
          expect(deliveryPreset.delivery_deduplicator).toMatchObject({
            delivery_id_field: 'delivery_id',
            event_id_field:
              deliveryPreset.event_projector?.provider_event_id_field,
          });
        }
      }
      if (deliveryPreset.event_normalizer !== null) {
        expect(deliveryPreset.event_projector).not.toBeNull();
        expect(deliveryPreset.event_projector).toMatchObject({
          provider_event_id_field: 'event_id',
          provider_resource_id_field: 'resource_id',
          provider_event_type_field: 'event_type',
          provider_occurred_at_field: 'occurred_at',
          decoded_payload_field: 'payload',
        });
        if (deliveryPreset.handshake !== null) {
          expect(deliveryPreset.event_normalizer.event_type_field)
            .toBe(deliveryPreset.handshake.projector.discriminator_field);
          expect(deliveryPreset.event_normalizer.challenge_field)
            .toBe(deliveryPreset.handshake.projector.challenge_field);
          expect(deliveryPreset.event_normalizer.challenge_max_bytes)
            .toBe(deliveryPreset.handshake.projector.max_challenge_bytes);
        }
        const conditional =
          deliveryPreset.event_normalizer.conditional_object_requirement;
        if (conditional !== null) {
          const descriptorEventTypes = descriptor.event_types.kind === 'closed'
            ? descriptor.event_types.values
            : descriptor.event_types.known_values;
          expect(descriptorEventTypes).toContain(conditional.when_event_type);
        }
      }
      if (deliveryPreset.environment_admission !== null) {
        expect(deliveryPreset.decoder).not.toBeNull();
        expect([...descriptor.supported_environments].sort()).toEqual([
          deliveryPreset.environment_admission.false_environment,
          deliveryPreset.environment_admission.true_environment,
        ].sort());
      }
      if (deliveryPreset.test_envelope !== null) {
        expect(deliveryPreset.decoder).not.toBeNull();
        expect(deliveryPreset.event_normalizer).not.toBeNull();
        expect(deliveryPreset.environment_admission).not.toBeNull();
      }
      expect(descriptor.fields.every((field) => field.required)).toBe(true);
      expect(deliveryPreset.credential_sources).toEqual(Object.fromEntries(
        descriptor.fields.map((field) => [field.key, field.source]),
      ));
      expect(descriptor.fields.find(
        (field) => field.key === deliveryPreset.mechanism.secret_field,
      )?.kind).toBe('secret');
      if (deliveryPreset.mechanism.signature_header.kind === 'credential_field') {
        const headerField = deliveryPreset.mechanism.signature_header.field;
        expect(descriptor.fields.find((field) => field.key === headerField)?.kind)
          .toBe('text');
      }
    }
  });

  it('shares exact timestamp-dot-body authentication with locked grammar policies', () => {
    const strict = createWebhookTimestampedHmacMechanism(
      GENERIC_TIMESTAMPED_HMAC_MECHANISM_PRESET,
    );
    const strictContext = context([
      version(2, 200, {
        signature_header: 'X-Strict-Signature',
        signing_secret: 'new-secret',
      }),
      version(1, 100, {
        signature_header: 'x-strict-signature',
        signing_secret: 'old-secret',
      }),
    ]);
    const strictSigned = strict.sign(BODY, strictContext, 'oldest')!;
    expect(strictSigned).toMatchObject({
      credential_version: '1',
      timestamp_literal: String(NOW_SECONDS),
      header_name: 'x-strict-signature',
    });
    expect(strict.authenticate(request(BODY, {
      [strictSigned.header_name]: strictSigned.header_value,
    }), strictContext)).toEqual({
      ok: true,
      credential_version: '1',
      timestamp_literal: String(NOW_SECONDS),
    });
    for (const invalid of [
      strictSigned.header_value.replace(',v1=', ', v1='),
      strictSigned.header_value.replace('t=', `legacy=${'0'.repeat(64)},t=`),
      strictSigned.header_value.toUpperCase(),
    ]) {
      expect(strict.authenticate(request(BODY, {
        [strictSigned.header_name]: invalid,
      }), strictContext)).toEqual({ ok: false, reason: 'authentication_failed' });
    }

    const extensible = createWebhookTimestampedHmacMechanism(
      STRIPE_TIMESTAMPED_HMAC_MECHANISM_PRESET,
    );
    const stripeContext = context([
      version(1, 100, { endpoint_secret: STRIPE_SECRET }),
      version(2, 200, { endpoint_secret: STRIPE_SECRET }),
    ]);
    const stripeSigned = extensible.sign(BODY, stripeContext, 'oldest')!;
    const digest = stripeSigned.header_value.slice(
      stripeSigned.header_value.indexOf('v1=') + 3,
    );
    const extensibleHeader =
      `future=value, v1=${digest.toUpperCase()}, t=${NOW_SECONDS}, t=${NOW_SECONDS}`;
    expect(verifyStripeWebhookSignature({
      header: extensibleHeader,
      raw_body: BODY,
      endpoint_secret: STRIPE_SECRET,
      now_ms: NOW_MS,
    })).toBe(true);
    expect(extensible.authenticate(request(BODY, {
      [STRIPE_SIGNATURE_HEADER]: extensibleHeader,
    }), stripeContext)).toEqual({
      ok: true,
      credential_version: '2',
      timestamp_literal: String(NOW_SECONDS),
    });
    expect(extensible.authenticate(request(Buffer.from(
      BODY.toString('utf8').replace('\n ', ''),
      'utf8',
    ), {
      [STRIPE_SIGNATURE_HEADER]: extensibleHeader,
    }), stripeContext)).toEqual({ ok: false, reason: 'authentication_failed' });
    expect(extensible.authenticate(request(BODY, {
      [STRIPE_SIGNATURE_HEADER]: [extensibleHeader, extensibleHeader],
    }), stripeContext)).toEqual({ ok: false, reason: 'authentication_failed' });

    const staleTimestamp = String(
      NOW_SECONDS - WEBHOOK_TIMESTAMPED_HMAC_REPLAY_WINDOW_SECONDS - 1,
    );
    const staleDigest = signature(STRIPE_SECRET, staleTimestamp);
    const parityHeaders = [
      `t=${NOW_SECONDS},v1=${digest}`,
      `v1=${digest.toUpperCase()}, t=${NOW_SECONDS}`,
      `unknown=future,not-a-pair,t=${NOW_SECONDS},v1=${digest}`,
      `t=${NOW_SECONDS},t=${NOW_SECONDS},v1=${digest}`,
      `t=${NOW_SECONDS},t=${NOW_SECONDS - 1},v1=${digest}`,
      `t=0${NOW_SECONDS},v1=${digest}`,
      `t=${NOW_SECONDS},v1=${'z'.repeat(64)}`,
      `t=${staleTimestamp},v1=${staleDigest}`,
      `t=${NOW_SECONDS},${Array.from(
        { length: 17 },
        (_, index) => `v1=${index === 0 ? digest : '0'.repeat(64)}`,
      ).join(',')}`,
      `${'unknown=x,'.repeat(4_100)}t=${NOW_SECONDS},v1=${digest}`,
    ];
    for (const header of parityHeaders) {
      const protocolAccepted = verifyStripeWebhookSignature({
        header,
        raw_body: BODY,
        endpoint_secret: STRIPE_SECRET,
        now_ms: NOW_MS,
      });
      const engineAccepted = extensible.authenticate(request(BODY, {
        [STRIPE_SIGNATURE_HEADER]: header,
      }), stripeContext).ok;
      expect(engineAccepted, header.slice(0, 160)).toBe(protocolAccepted);
    }
  });

  it('enforces freshness, one timestamp authority, and fail-closed context bounds', () => {
    const mechanism = createWebhookTimestampedHmacMechanism(
      GENERIC_TIMESTAMPED_HMAC_MECHANISM_PRESET,
    );
    const one = 'one-secret';
    const two = 'two-secret';
    const versions = [
      version(2, 200, {
        signature_header: 'x-signature-two',
        signing_secret: two,
      }),
      version(1, 100, {
        signature_header: 'x-signature-one',
        signing_secret: one,
      }),
    ];
    const runtime = context(versions);
    for (const timestamp of [
      NOW_SECONDS - WEBHOOK_TIMESTAMPED_HMAC_REPLAY_WINDOW_SECONDS - 1,
      NOW_SECONDS + WEBHOOK_TIMESTAMPED_HMAC_REPLAY_WINDOW_SECONDS + 1,
    ]) {
      const literal = String(timestamp);
      expect(mechanism.authenticate(request(BODY, {
        'x-signature-one': `t=${literal},v1=${signature(one, literal)}`,
      }), runtime)).toEqual({ ok: false, reason: 'authentication_failed' });
    }
    const newerTimestamp = String(NOW_SECONDS);
    const olderTimestamp = String(NOW_SECONDS - 1);
    expect(mechanism.authenticate(request(BODY, {
      'x-signature-two':
        `t=${newerTimestamp},v1=${signature(two, newerTimestamp)}`,
      'x-signature-one':
        `t=${olderTimestamp},v1=${signature(one, olderTimestamp)}`,
    }), runtime)).toEqual({ ok: false, reason: 'authentication_failed' });

    expect(mechanism.authenticate(request(BODY, {}), context(versions, () => {
      throw new Error('clock unavailable');
    }))).toEqual({ ok: false, reason: 'configuration_failed' });
    const extensible = createWebhookTimestampedHmacMechanism(
      STRIPE_TIMESTAMPED_HMAC_MECHANISM_PRESET,
    );
    expect(extensible.authenticate(request(BODY, {}), context([
      version(1, 1, { endpoint_secret: STRIPE_SECRET }),
    ], () => {
      throw new Error('clock unavailable');
    }))).toEqual({ ok: false, reason: 'authentication_failed' });
    expect(mechanism.authenticate(request(BODY, {}), context([
      ...versions,
      version(3, 300, {
        signature_header: 'x-signature-three',
        signing_secret: 'three-secret',
      }),
    ]))).toEqual({ ok: false, reason: 'configuration_failed' });
    expect(mechanism.hasValidConfiguration(context(
      new Array(1) as ResolvedWebhookCredentialVersion[],
    ))).toBe(false);
    const throwingArray = new Proxy([...versions], {
      get(target, property, receiver) {
        if (property === 'length') throw new Error('array length unavailable');
        return Reflect.get(target, property, receiver);
      },
    });
    expect(mechanism.hasValidConfiguration(context(throwingArray))).toBe(false);
  });

  it('uses core credential-version admission without changing timestamp grammar', () => {
    const mechanism = createWebhookTimestampedHmacMechanism(
      GENERIC_TIMESTAMPED_HMAC_MECHANISM_PRESET,
    );
    const contextWithVersion = (value: unknown): WebhookProfileRuntimeContext =>
      context([{
        version: value as string,
        created_at: 1,
        credentials: {
          signature_header: 'x-signature',
          signing_secret: 'secret',
        },
      }]);

    expect(mechanism.hasValidConfiguration(
      contextWithVersion(String(Number.MAX_SAFE_INTEGER)),
    )).toBe(true);

    let coercions = 0;
    const coercibleVersion = {
      [Symbol.toPrimitive]() {
        coercions += 1;
        return '1';
      },
    };
    for (const invalid of [
      '0',
      '01',
      String(Number.MAX_SAFE_INTEGER + 1),
      1,
      Symbol('1'),
      new String('1'),
      coercibleVersion,
    ]) {
      const invalidContext = contextWithVersion(invalid);
      expect(mechanism.hasValidConfiguration(invalidContext)).toBe(false);
      expect(mechanism.authenticate(
        request(BODY, {}),
        invalidContext,
      )).toEqual({ ok: false, reason: 'configuration_failed' });
      expect(mechanism.sign(BODY, invalidContext, 'newest')).toBeNull();
    }
    expect(coercions).toBe(0);
  });

  it('shares strict semicolon timestamp-colon-body authentication', () => {
    const mechanism = createWebhookTimestampedHmacMechanism(
      PADDLE_TIMESTAMPED_HMAC_MECHANISM_PRESET,
    );
    const officialBody = Buffer.from('{"data": ["1", "2"]}', 'utf8');
    const officialHeader =
      'ts=1698796800;h1=c174899d19b7316437836caa36609c632749005f8090b8904bd13d7af06d0501';
    expect(mechanism.authenticate(request(officialBody, {
      [PADDLE_SIGNATURE_HEADER]: officialHeader,
    }), context([
      version(1, 100, { endpoint_secret_key: PADDLE_SECRET }),
    ], () => 1_698_796_800_000))).toEqual({
      ok: true,
      credential_version: '1',
      timestamp_literal: '1698796800',
    });
    const runtime = context([
      version(1, 100, { endpoint_secret_key: PADDLE_SECRET }),
      version(2, 200, { endpoint_secret_key: PADDLE_SECRET }),
    ]);
    const signed = mechanism.sign(BODY, runtime, 'oldest')!;
    expect(signed).toMatchObject({
      credential_version: '1',
      timestamp_literal: String(NOW_SECONDS),
      header_name: PADDLE_SIGNATURE_HEADER,
      header_value: expect.stringMatching(
        new RegExp(`^ts=${NOW_SECONDS};h1=[0-9a-f]{64}$`),
      ),
    });
    expect(mechanism.authenticate(request(BODY, {
      [PADDLE_SIGNATURE_HEADER]: signed.header_value,
    }), runtime)).toEqual({
      ok: true,
      credential_version: '2',
      timestamp_literal: String(NOW_SECONDS),
    });

    let clockInvoked = false;
    const unavailableClock = context([
      version(1, 100, { endpoint_secret_key: PADDLE_SECRET }),
    ], () => {
      clockInvoked = true;
      throw new Error('clock unavailable');
    });
    expect(mechanism.authenticate(request(BODY, {}), unavailableClock))
      .toEqual({ ok: false, reason: 'authentication_failed' });
    expect(mechanism.authenticate(request(BODY, {
      [PADDLE_SIGNATURE_HEADER]: [signed.header_value, signed.header_value],
    }), unavailableClock)).toEqual({
      ok: false,
      reason: 'authentication_failed',
    });
    expect(clockInvoked).toBe(false);

    const digest = colonSignature(PADDLE_SECRET, String(NOW_SECONDS));
    const staleTimestamp = String(
      NOW_SECONDS - PADDLE_WEBHOOK_TOLERANCE_SECONDS - 1,
    );
    const edgeTimestamp = String(
      NOW_SECONDS + PADDLE_WEBHOOK_TOLERANCE_SECONDS,
    );
    const parityHeaders = [
      `ts=${NOW_SECONDS};h1=${digest}`,
      `ts=${edgeTimestamp};h1=${colonSignature(PADDLE_SECRET, edgeTimestamp)}`,
      `h2=future; ts=${NOW_SECONDS} ; h1=${'0'.repeat(64)} ; h1=${digest}`,
      `ts=${NOW_SECONDS};ts=${NOW_SECONDS};h1=${digest}`,
      `ts=0${NOW_SECONDS};h1=${digest}`,
      `ts=${NOW_SECONDS};h1=${digest.toUpperCase()}`,
      `ts=${NOW_SECONDS};;h1=${digest}`,
      `bad-key=value;ts=${NOW_SECONDS};h1=${digest}`,
      `future=a=b;ts=${NOW_SECONDS};h1=${digest}`,
      `ts=${staleTimestamp};h1=${colonSignature(PADDLE_SECRET, staleTimestamp)}`,
      `ts=${NOW_SECONDS};${Array.from(
        { length: 17 },
        (_, index) => `h1=${index === 0 ? digest : '0'.repeat(64)}`,
      ).join(';')}`,
      `ts=${NOW_SECONDS};h1=${digest};x=${'a'.repeat(8_192)}`,
    ];
    for (const header of parityHeaders) {
      const protocolAccepted = verifyPaddleWebhookSignature({
        header,
        raw_body: BODY,
        endpoint_secret_key: PADDLE_SECRET,
        now_ms: NOW_MS,
      });
      const engineAccepted = mechanism.authenticate(request(BODY, {
        [PADDLE_SIGNATURE_HEADER]: header,
      }), runtime).ok;
      expect(engineAccepted, header.slice(0, 160)).toBe(protocolAccepted);
    }
    expect(mechanism.authenticate(request(Buffer.from(`${BODY.toString()}\n`), {
      [PADDLE_SIGNATURE_HEADER]: signed.header_value,
    }), runtime)).toEqual({ ok: false, reason: 'authentication_failed' });
  });

  it('shares separate decimal timestamp-header v0 authentication', () => {
    const mechanism = createWebhookTimestampedHmacMechanism(
      SLACK_TIMESTAMPED_HMAC_MECHANISM_PRESET,
    );
    const runtime = context([
      version(1, 100, { signing_secret: SLACK_SECRET }),
      version(2, 200, { signing_secret: SLACK_SECRET }),
    ]);
    const signed = mechanism.sign(BODY, runtime, 'oldest')!;
    expect(signed).toMatchObject({
      credential_version: '1',
      timestamp_literal: String(NOW_SECONDS),
      header_name: SLACK_SIGNATURE_HEADER,
      header_value: expect.stringMatching(/^v0=[0-9a-f]{64}$/),
      timestamp_header: {
        name: SLACK_REQUEST_TIMESTAMP_HEADER,
        value: String(NOW_SECONDS),
      },
    });
    expect(mechanism.authenticate(request(BODY, {
      [SLACK_REQUEST_TIMESTAMP_HEADER]: signed.timestamp_header!.value,
      [SLACK_SIGNATURE_HEADER]: signed.header_value,
    }), runtime)).toEqual({
      ok: true,
      credential_version: '2',
      timestamp_literal: String(NOW_SECONDS),
    });

    const edgeTimestamp = String(
      NOW_SECONDS + SLACK_REPLAY_WINDOW_SECONDS,
    );
    const pastEdgeTimestamp = String(
      NOW_SECONDS - SLACK_REPLAY_WINDOW_SECONDS,
    );
    const staleTimestamp = String(
      NOW_SECONDS - SLACK_REPLAY_WINDOW_SECONDS - 1,
    );
    const futureStaleTimestamp = String(
      NOW_SECONDS + SLACK_REPLAY_WINDOW_SECONDS + 1,
    );
    const leadingTimestamp = `0${NOW_SECONDS}`;
    const parityCases = [
      [String(NOW_SECONDS), v0Signature(SLACK_SECRET, String(NOW_SECONDS))],
      [edgeTimestamp, v0Signature(SLACK_SECRET, edgeTimestamp)],
      [pastEdgeTimestamp, v0Signature(SLACK_SECRET, pastEdgeTimestamp)],
      [leadingTimestamp, v0Signature(SLACK_SECRET, leadingTimestamp)],
      [staleTimestamp, v0Signature(SLACK_SECRET, staleTimestamp)],
      [futureStaleTimestamp, v0Signature(SLACK_SECRET, futureStaleTimestamp)],
      [`${NOW_SECONDS}junk`, v0Signature(SLACK_SECRET, `${NOW_SECONDS}junk`)],
      [String(NOW_SECONDS), v0Signature(
        SLACK_SECRET,
        String(NOW_SECONDS),
      ).toUpperCase()],
      [String(NOW_SECONDS), `v1=${'0'.repeat(64)}`],
      ['9'.repeat(33), `v0=${'0'.repeat(64)}`],
      [String(Number.MAX_SAFE_INTEGER + 1), `v0=${'0'.repeat(64)}`],
      ['', `v0=${'0'.repeat(64)}`],
      [String(NOW_SECONDS), `${v0Signature(
        SLACK_SECRET,
        String(NOW_SECONDS),
      )}x`],
    ] as const;
    for (const [timestamp, presentedSignature] of parityCases) {
      const protocolAccepted = verifySlackWebhookSignature({
        timestamp,
        signature: presentedSignature,
        raw_body: BODY,
        signing_secret: SLACK_SECRET,
        now_ms: NOW_MS,
      });
      const engineAccepted = mechanism.authenticate(request(BODY, {
        [SLACK_REQUEST_TIMESTAMP_HEADER]: timestamp,
        [SLACK_SIGNATURE_HEADER]: presentedSignature,
      }), runtime).ok;
      expect(engineAccepted, `${timestamp}:${presentedSignature.slice(0, 80)}`)
        .toBe(protocolAccepted);
    }
    expect(mechanism.authenticate(request(Buffer.from(`${BODY.toString()}\n`), {
      [SLACK_REQUEST_TIMESTAMP_HEADER]: String(NOW_SECONDS),
      [SLACK_SIGNATURE_HEADER]: signed.header_value,
    }), runtime)).toEqual({ ok: false, reason: 'authentication_failed' });

    let clockInvoked = false;
    const unavailableClock = context([
      version(1, 100, { signing_secret: SLACK_SECRET }),
    ], () => {
      clockInvoked = true;
      throw new Error('clock unavailable');
    });
    const absentOrRepeatedHeaders: Array<Readonly<Record<
      string,
      string | readonly string[]
    >>> = [
      {},
      { [SLACK_REQUEST_TIMESTAMP_HEADER]: String(NOW_SECONDS) },
      { [SLACK_SIGNATURE_HEADER]: signed.header_value },
      {
        [SLACK_REQUEST_TIMESTAMP_HEADER]: [
          String(NOW_SECONDS),
          String(NOW_SECONDS),
        ],
        [SLACK_SIGNATURE_HEADER]: signed.header_value,
      },
      {
        [SLACK_REQUEST_TIMESTAMP_HEADER]: String(NOW_SECONDS),
        [SLACK_SIGNATURE_HEADER]: [signed.header_value, signed.header_value],
      },
    ];
    for (const headers of absentOrRepeatedHeaders) {
      expect(mechanism.authenticate(request(BODY, headers), unavailableClock))
        .toEqual({ ok: false, reason: 'authentication_failed' });
    }
    expect(clockInvoked).toBe(false);
    expect(mechanism.authenticate(request(BODY, {
      [SLACK_REQUEST_TIMESTAMP_HEADER]: `${NOW_SECONDS}junk`,
      [SLACK_SIGNATURE_HEADER]: `v0=${'0'.repeat(64)}`,
    }), unavailableClock)).toEqual({
      ok: false,
      reason: 'configuration_failed',
    });
    expect(clockInvoked).toBe(true);
  });

  it('rejects executable or widened presets and keeps secret resolution private', () => {
    const mechanism = createWebhookTimestampedHmacMechanism(
      STRIPE_TIMESTAMPED_HMAC_MECHANISM_PRESET,
    );
    const alternatePrefix = createWebhookTimestampedHmacMechanism({
      ...STRIPE_TIMESTAMPED_HMAC_MECHANISM_PRESET,
      secret_field: 'token',
      secret_shape: {
        kind: 'prefixed_ascii_token.v1',
        prefix: 'sig_',
        max_bytes: 32,
      },
    });
    expect(alternatePrefix.validateCredentialShape({ token: 'sig_abc-123' }))
      .toBe(true);
    expect(alternatePrefix.validateCredentialShape({ token: STRIPE_SECRET }))
      .toBe(false);
    expect('resolveCredentials' in mechanism).toBe(false);
    expect(mechanism.sign(BODY, context([
      version(1, 1, {
        endpoint_secret: STRIPE_SECRET,
        signature_header: 'x-attacker-selected',
      }),
    ]), 'newest')).toBeNull();
    expect(mechanism.sign(BODY, context([
      version(1, 1, { endpoint_secret: STRIPE_SECRET }),
    ]), 'neither' as never)).toBeNull();
    expect(mechanism.sign(BODY, context([
      version(1, 1, { endpoint_secret: STRIPE_SECRET }),
    ], () => 999), 'newest')).toBeNull();

    expect(() => createWebhookTimestampedHmacMechanism({
      ...STRIPE_TIMESTAMPED_HMAC_MECHANISM_PRESET,
      algorithm: 'sha1',
    } as never)).toThrow('invalid trusted preset');
    expect(() => createWebhookTimestampedHmacMechanism({
      ...STRIPE_TIMESTAMPED_HMAC_MECHANISM_PRESET,
      replay_window_seconds: 301,
    } as never)).toThrow('invalid trusted preset');
    expect(() => createWebhookTimestampedHmacMechanism({
      ...STRIPE_TIMESTAMPED_HMAC_MECHANISM_PRESET,
      signed_payload: 'owner_template',
    } as never)).toThrow('invalid trusted preset');
    expect(() => createWebhookTimestampedHmacMechanism({
      ...STRIPE_TIMESTAMPED_HMAC_MECHANISM_PRESET,
      secret_shape: {
        kind: 'prefixed_ascii_token.v1',
        prefix: '',
        max_bytes: 4_096,
      },
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookTimestampedHmacMechanism({
      ...PADDLE_TIMESTAMPED_HMAC_MECHANISM_PRESET,
      secret_shape: {
        kind: 'segmented_ascii_token.v1',
        prefix: 'pdl_ntfset_',
        separator: '_',
        segment_lengths: [26, 0, 32],
      },
    })).toThrow('invalid trusted preset');
    let iteratorInvoked = false;
    class ExecutableSegmentLengths extends Array<number> {
      override [Symbol.iterator](): ArrayIterator<number> {
        iteratorInvoked = true;
        return super[Symbol.iterator]();
      }
    }
    const executableSegmentLengths = new ExecutableSegmentLengths(26, 32);
    expect(() => createWebhookTimestampedHmacMechanism({
      ...PADDLE_TIMESTAMPED_HMAC_MECHANISM_PRESET,
      secret_shape: {
        kind: 'segmented_ascii_token.v1',
        prefix: 'pdl_ntfset_',
        separator: '_',
        segment_lengths: executableSegmentLengths,
      },
    })).toThrow('invalid trusted preset');
    expect(iteratorInvoked).toBe(false);
    const sparseSegmentLengths = new Array(2) as number[];
    sparseSegmentLengths[0] = 26;
    expect(() => createWebhookTimestampedHmacMechanism({
      ...PADDLE_TIMESTAMPED_HMAC_MECHANISM_PRESET,
      secret_shape: {
        kind: 'segmented_ascii_token.v1',
        prefix: 'pdl_ntfset_',
        separator: '_',
        segment_lengths: sparseSegmentLengths,
      },
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookTimestampedHmacMechanism({
      ...STRIPE_TIMESTAMPED_HMAC_MECHANISM_PRESET,
      signature_header: { kind: 'fixed', name: 'host' },
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookTimestampedHmacMechanism({
      ...SLACK_TIMESTAMPED_HMAC_MECHANISM_PRESET,
      timestamp_source: { kind: 'signature_envelope' },
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookTimestampedHmacMechanism({
      ...SLACK_TIMESTAMPED_HMAC_MECHANISM_PRESET,
      timestamp_source: {
        kind: 'fixed_header',
        name: SLACK_SIGNATURE_HEADER,
      },
    })).toThrow('invalid trusted preset');
    const configurableSeparateHeader = createWebhookTimestampedHmacMechanism({
      ...SLACK_TIMESTAMPED_HMAC_MECHANISM_PRESET,
      signature_header: {
        kind: 'credential_field',
        field: 'signature_header',
      },
    });
    expect(configurableSeparateHeader.validateCredentialShape({
      signature_header: 'x-independent-signature',
      signing_secret: SLACK_SECRET,
    })).toBe(true);
    expect(configurableSeparateHeader.validateCredentialShape({
      signature_header: 'X-Slack-Request-Timestamp',
      signing_secret: SLACK_SECRET,
    })).toBe(false);
    expect(configurableSeparateHeader.hasValidConfiguration(context([
      version(1, 1, {
        signature_header: 'X-Slack-Request-Timestamp',
        signing_secret: SLACK_SECRET,
      }),
    ]))).toBe(false);

    let accessorInvoked = false;
    const accessorHeader = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorHeader, 'kind', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('preset accessor must not execute');
      },
    });
    expect(() => createWebhookTimestampedHmacMechanism({
      ...STRIPE_TIMESTAMPED_HMAC_MECHANISM_PRESET,
      signature_header: accessorHeader,
    } as never)).toThrow('invalid trusted preset');
    expect(accessorInvoked).toBe(false);

    let timestampAccessorInvoked = false;
    const accessorTimestampSource = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorTimestampSource, 'kind', {
      enumerable: true,
      get() {
        timestampAccessorInvoked = true;
        throw new Error('timestamp-source accessor must not execute');
      },
    });
    expect(() => createWebhookTimestampedHmacMechanism({
      ...SLACK_TIMESTAMPED_HMAC_MECHANISM_PRESET,
      timestamp_source: accessorTimestampSource,
    } as never)).toThrow('invalid trusted preset');
    expect(timestampAccessorInvoked).toBe(false);
  });
});
