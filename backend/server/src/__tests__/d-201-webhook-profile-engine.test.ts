import { describe, expect, it } from 'vitest';
import { webhookProfile } from '@recued/contracts';

import {
  TELEGRAM_SECRET_HEADER,
} from '../connections/providers/telegram-webhook-protocol.js';
import {
  GITHUB_DELIVERY_HEADER,
  GITHUB_EVENT_HEADER,
  GITHUB_HOOK_ID_HEADER,
  GITHUB_SIGNATURE_HEADER,
  verifyGitHubWebhookSignature,
} from '../connections/providers/github-webhook-protocol.js';
import {
  GITHUB_METADATA_PAYLOAD_EVENT_NORMALIZER_PRESET,
  GITHUB_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET,
  GITHUB_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET,
  GITHUB_RAW_HEADER_JSON_SINGLE_EVENT_TEST_ENVELOPE_PRESET,
  GITHUB_RAW_HEADER_METADATA_NORMALIZER_PRESET,
  GITHUB_WEBHOOK_RAW_BODY_HMAC_MECHANISM_PRESET,
} from '../webhook-github-profile.js';
import {
  WEBHOOK_STATIC_HEADER_TOKEN_DELIVERY_PROFILE_PRESETS,
  WEBHOOK_RAW_BODY_HMAC_DELIVERY_PROFILE_PRESETS,
  WEBHOOK_TIMESTAMPED_HMAC_DELIVERY_PROFILE_PRESETS,
} from '../webhook-delivery-engine-presets.js';
import {
  createWebhookFormUrlencodedDecoder,
  WEBHOOK_FORM_URLENCODED_DECODER_V1,
  WEBHOOK_FORM_URLENCODED_DECODER_V1_PRESET,
} from '../webhook-form-urlencoded-decoder.js';
import {
  createWebhookFormWrappedJsonDecoder,
} from '../webhook-form-wrapped-json-decoder.js';
import {
  createWebhookJsonObjectDecoder,
  WEBHOOK_JSON_OBJECT_DECODER_V1,
  WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET,
} from '../webhook-json-object-decoder.js';
import {
  createWebhookJsonChallengeProjector,
} from '../webhook-json-challenge-projector.js';
import {
  createWebhookNormalizedSingleEventProjector,
} from '../webhook-normalized-event-projector.js';
import {
  GENERIC_STATIC_HEADER_TOKEN_JSON_OBJECT_DECODER_PRESET,
  GENERIC_STATIC_HEADER_TOKEN_MECHANISM_PRESET,
  GENERIC_RAW_BODY_HMAC_MECHANISM_PRESET,
} from '../webhook-primitive-profiles.js';
import {
  TELEGRAM_JSON_OBJECT_DECODER_PRESET,
  TELEGRAM_JSON_SINGLE_MEMBER_EVENT_NORMALIZER_PRESET,
  TELEGRAM_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET,
  TELEGRAM_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET,
  TELEGRAM_STATIC_HEADER_TOKEN_MECHANISM_PRESET,
} from '../webhook-telegram-profile.js';
import {
  createWebhookRawBodyHmacMechanism,
} from '../webhook-raw-body-hmac-engine.js';
import type {
  RawWebhookRequest,
  ResolvedWebhookCredentialVersion,
  WebhookProfileRuntimeContext,
} from '../webhook-profile-runtime.js';

const BODY = Buffer.from('{"z":1,\n "a":{"items":[true,null,"ok"]}}', 'utf8');
const GENERATED_SECRET = 'A'.repeat(43);

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
): WebhookProfileRuntimeContext => ({
  ingress_id: 'whi_d201_profile_engine_fixture',
  environment: 'test',
  credential_versions: credentialVersions,
  now: () => {
    throw new Error('raw-body HMAC must not read a clock');
  },
});

const request = (
  rawBody: Buffer,
  headerName: string,
  headerValue: string | readonly string[],
): RawWebhookRequest => ({
  method: 'POST',
  raw_body: rawBody,
  headers: new Map([[
    headerName,
    typeof headerValue === 'string' ? [headerValue] : headerValue,
  ]]),
  raw_path_and_query: '/v1/webhooks/profile-engine-fixture',
  canonical_public_url:
    'https://hooks.example.test/v1/webhooks/profile-engine-fixture',
  received_at: 1_900_000_000_000,
  remote_ip: '127.0.0.1',
});

const expectDeeplyFrozen = (value: unknown, seen = new WeakSet<object>()): void => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    expectDeeplyFrozen((value as Record<PropertyKey, unknown>)[key], seen);
  }
};

describe('D-201 Slices 8K + 8O-8Q + 8U + 9S-9AD typed webhook profile engines', () => {
  it('exposes only deeply frozen serializable profile preset data', () => {
    expect(Object.keys(WEBHOOK_STATIC_HEADER_TOKEN_DELIVERY_PROFILE_PRESETS))
      .toEqual([
        'generic.static-header-token.v1',
        'telegram.bot-webhook.v1',
      ]);
    expect(Object.getPrototypeOf(
      WEBHOOK_STATIC_HEADER_TOKEN_DELIVERY_PROFILE_PRESETS,
    )).toBeNull();
    expectDeeplyFrozen(WEBHOOK_STATIC_HEADER_TOKEN_DELIVERY_PROFILE_PRESETS);
    expect(() => JSON.stringify(
      WEBHOOK_STATIC_HEADER_TOKEN_DELIVERY_PROFILE_PRESETS,
    )).not.toThrow();
    expect(GENERIC_STATIC_HEADER_TOKEN_MECHANISM_PRESET).toEqual({
      kind: 'static_header_token.v1',
      token_field: 'header_token',
      token_shape: 'trimmed_printable_ascii_8192.v1',
      token_header: { kind: 'credential_field', field: 'header_name' },
      matching_credential: 'first',
    });
    expect(TELEGRAM_STATIC_HEADER_TOKEN_MECHANISM_PRESET).toEqual({
      kind: 'static_header_token.v1',
      token_field: 'secret_token',
      token_shape: {
        kind: 'bounded_ascii_token.v1',
        max_characters: 256,
      },
      token_header: { kind: 'fixed', name: TELEGRAM_SECRET_HEADER },
      matching_credential: 'newest',
    });
    expect(WEBHOOK_STATIC_HEADER_TOKEN_DELIVERY_PROFILE_PRESETS[
      'generic.static-header-token.v1'
    ]?.mechanism).toBe(GENERIC_STATIC_HEADER_TOKEN_MECHANISM_PRESET);
    expect(WEBHOOK_STATIC_HEADER_TOKEN_DELIVERY_PROFILE_PRESETS[
      'telegram.bot-webhook.v1'
    ]?.mechanism).toBe(TELEGRAM_STATIC_HEADER_TOKEN_MECHANISM_PRESET);
    expect(GENERIC_STATIC_HEADER_TOKEN_JSON_OBJECT_DECODER_PRESET)
      .toBe(WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET);
    expect(TELEGRAM_JSON_OBJECT_DECODER_PRESET)
      .toBe(WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET);
    expect(WEBHOOK_STATIC_HEADER_TOKEN_DELIVERY_PROFILE_PRESETS[
      'generic.static-header-token.v1'
    ]?.decoder).toBe(GENERIC_STATIC_HEADER_TOKEN_JSON_OBJECT_DECODER_PRESET);
    expect(WEBHOOK_STATIC_HEADER_TOKEN_DELIVERY_PROFILE_PRESETS[
      'telegram.bot-webhook.v1'
    ]?.decoder).toBe(TELEGRAM_JSON_OBJECT_DECODER_PRESET);
    expect(WEBHOOK_STATIC_HEADER_TOKEN_DELIVERY_PROFILE_PRESETS[
      'generic.static-header-token.v1'
    ]?.event_normalizer).toBeNull();
    expect(WEBHOOK_STATIC_HEADER_TOKEN_DELIVERY_PROFILE_PRESETS[
      'telegram.bot-webhook.v1'
    ]?.event_normalizer)
      .toBe(TELEGRAM_JSON_SINGLE_MEMBER_EVENT_NORMALIZER_PRESET);
    expect(WEBHOOK_STATIC_HEADER_TOKEN_DELIVERY_PROFILE_PRESETS[
      'generic.static-header-token.v1'
    ]?.delivery_deduplicator).toBeNull();
    expect(WEBHOOK_STATIC_HEADER_TOKEN_DELIVERY_PROFILE_PRESETS[
      'telegram.bot-webhook.v1'
    ]?.delivery_deduplicator)
      .toBe(TELEGRAM_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET);
    expect(WEBHOOK_STATIC_HEADER_TOKEN_DELIVERY_PROFILE_PRESETS[
      'generic.static-header-token.v1'
    ]?.event_projector).toBeNull();
    expect(WEBHOOK_STATIC_HEADER_TOKEN_DELIVERY_PROFILE_PRESETS[
      'telegram.bot-webhook.v1'
    ]?.event_projector)
      .toBe(TELEGRAM_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET);
    expect(WEBHOOK_STATIC_HEADER_TOKEN_DELIVERY_PROFILE_PRESETS[
      'generic.static-header-token.v1'
    ]?.admission_method_label).toBeNull();
    expect(WEBHOOK_STATIC_HEADER_TOKEN_DELIVERY_PROFILE_PRESETS[
      'telegram.bot-webhook.v1'
    ]?.admission_method_label).toBe('telegram-secret-token');
    expect(WEBHOOK_TIMESTAMPED_HMAC_DELIVERY_PROFILE_PRESETS[
      'slack.request.v0'
    ]).toMatchObject({
      admission_method_label: 'slack-signature-v0',
      runtime_error_label: 'Slack webhook',
    });
    expectDeeplyFrozen(WEBHOOK_TIMESTAMPED_HMAC_DELIVERY_PROFILE_PRESETS[
      'slack.request.v0'
    ]);
    expect(Object.keys(WEBHOOK_RAW_BODY_HMAC_DELIVERY_PROFILE_PRESETS)).toEqual([
      'cal.webhook.v1',
      'generic.raw-body-hmac-sha256.v1',
      'github.webhook.v1',
      'lemonsqueezy.webhook.v1',
    ]);
    expect(Object.getPrototypeOf(WEBHOOK_RAW_BODY_HMAC_DELIVERY_PROFILE_PRESETS))
      .toBeNull();
    expectDeeplyFrozen(WEBHOOK_RAW_BODY_HMAC_DELIVERY_PROFILE_PRESETS);
    expect(() => JSON.stringify(WEBHOOK_RAW_BODY_HMAC_DELIVERY_PROFILE_PRESETS))
      .not.toThrow();
    expect(GENERIC_RAW_BODY_HMAC_MECHANISM_PRESET).toEqual({
      kind: 'raw_body_hmac_sha256.v1',
      secret_field: 'signing_secret',
      secret_shape: 'nonempty_utf8_65536',
      signature_header: {
        kind: 'credential_field',
        field: 'signature_header',
      },
      signature_format: 'sha256_equals_lowerhex.v1',
      matching_credential: 'first',
    });
    expect(GITHUB_WEBHOOK_RAW_BODY_HMAC_MECHANISM_PRESET).toEqual({
      kind: 'raw_body_hmac_sha256.v1',
      secret_field: 'webhook_secret',
      secret_shape: {
        kind: 'fixed_length_ascii_token.v1',
        characters: 43,
      },
      signature_header: {
        kind: 'fixed',
        name: GITHUB_SIGNATURE_HEADER,
      },
      signature_format: 'sha256_equals_lowerhex.v1',
      matching_credential: 'newest',
    });
    expect(GITHUB_RAW_HEADER_METADATA_NORMALIZER_PRESET).toEqual({
      kind: 'raw_header_single_event_metadata.v1',
      delivery_id_header: GITHUB_DELIVERY_HEADER,
      event_type_header: GITHUB_EVENT_HEADER,
      structural_evidence_header: GITHUB_HOOK_ID_HEADER,
    });
    expect(WEBHOOK_RAW_BODY_HMAC_DELIVERY_PROFILE_PRESETS[
      'generic.raw-body-hmac-sha256.v1'
    ]?.raw_header_metadata).toBeNull();
    expect(WEBHOOK_RAW_BODY_HMAC_DELIVERY_PROFILE_PRESETS[
      'github.webhook.v1'
    ]?.raw_header_metadata).toBe(
      GITHUB_RAW_HEADER_METADATA_NORMALIZER_PRESET,
    );
    expect(GITHUB_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET).toEqual({
      kind: 'normalized_required_single_id_sha256.v1',
      stable_id_field: 'delivery_id',
      stable_id_prefix: 'github:delivery:',
    });
    expect(WEBHOOK_RAW_BODY_HMAC_DELIVERY_PROFILE_PRESETS[
      'generic.raw-body-hmac-sha256.v1'
    ]?.delivery_deduplicator).toBeNull();
    expect(WEBHOOK_RAW_BODY_HMAC_DELIVERY_PROFILE_PRESETS[
      'github.webhook.v1'
    ]?.delivery_deduplicator).toBe(
      GITHUB_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET,
    );
    expect(GITHUB_METADATA_PAYLOAD_EVENT_NORMALIZER_PRESET).toEqual({
      kind: 'metadata_payload_single_event.v1',
    });
    expect(GITHUB_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET).toEqual({
      kind: 'normalized_single_event.v1',
      provider_event_id_field: 'event_id',
      provider_resource_id_field: 'resource_id',
      provider_event_type_field: 'event_type',
      provider_occurred_at_field: 'occurred_at',
      decoded_payload_field: 'payload',
      occurred_at_unit: 'unix_milliseconds.v1',
    });
    expect(WEBHOOK_RAW_BODY_HMAC_DELIVERY_PROFILE_PRESETS[
      'generic.raw-body-hmac-sha256.v1'
    ]?.metadata_payload_event_normalizer).toBeNull();
    expect(WEBHOOK_RAW_BODY_HMAC_DELIVERY_PROFILE_PRESETS[
      'generic.raw-body-hmac-sha256.v1'
    ]?.event_projector).toBeNull();
    expect(WEBHOOK_RAW_BODY_HMAC_DELIVERY_PROFILE_PRESETS[
      'github.webhook.v1'
    ]?.metadata_payload_event_normalizer).toBe(
      GITHUB_METADATA_PAYLOAD_EVENT_NORMALIZER_PRESET,
    );
    expect(WEBHOOK_RAW_BODY_HMAC_DELIVERY_PROFILE_PRESETS[
      'github.webhook.v1'
    ]?.event_projector).toBe(
      GITHUB_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET,
    );
    expect(GITHUB_RAW_HEADER_JSON_SINGLE_EVENT_TEST_ENVELOPE_PRESET).toEqual({
      kind: 'raw_header_json_single_event_test_envelope.v1',
      nonce_grammar: 'lowercase_hex_64.v1',
      delivery_id_derivation: 'sha256_uuid_v4_variant8.v1',
      delivery_id_domain_separator: 'recued:github:test-delivery:',
      structural_evidence: '1',
      base_payload_json:
        '{"action":"recued_test_delivery","hook":{"id":1,"type":"Repository","active":true},'
        + '"repository":{"id":1,"full_name":"recued/test-delivery"},'
        + '"sender":{"id":1,"login":"recued-test-delivery","type":"Bot"}}',
      marker_object_field: 'recued_test_delivery',
      marker_nonce_field: 'nonce',
      max_body_bytes: 1_048_576,
    });
    expect(WEBHOOK_RAW_BODY_HMAC_DELIVERY_PROFILE_PRESETS[
      'generic.raw-body-hmac-sha256.v1'
    ]?.test_envelope).toBeNull();
    expect(WEBHOOK_RAW_BODY_HMAC_DELIVERY_PROFILE_PRESETS[
      'github.webhook.v1'
    ]?.test_envelope).toBe(
      GITHUB_RAW_HEADER_JSON_SINGLE_EVENT_TEST_ENVELOPE_PRESET,
    );
    expect(WEBHOOK_RAW_BODY_HMAC_DELIVERY_PROFILE_PRESETS[
      'generic.raw-body-hmac-sha256.v1'
    ]).toMatchObject({
      admission_method_label: null,
      runtime_error_label: null,
      test_signing_credential: null,
    });
    expect(WEBHOOK_RAW_BODY_HMAC_DELIVERY_PROFILE_PRESETS[
      'github.webhook.v1'
    ]).toMatchObject({
      admission_method_label: 'github-hmac-sha256',
      runtime_error_label: 'GitHub webhook',
      test_signing_credential: 'oldest',
    });
    for (const preset of [
      GENERIC_RAW_BODY_HMAC_MECHANISM_PRESET,
      GITHUB_WEBHOOK_RAW_BODY_HMAC_MECHANISM_PRESET,
      WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET,
      WEBHOOK_FORM_URLENCODED_DECODER_V1_PRESET,
    ]) {
      expectDeeplyFrozen(preset);
      expect(() => JSON.stringify(preset)).not.toThrow();
    }
    for (const deliveryPreset of Object.values(
      WEBHOOK_RAW_BODY_HMAC_DELIVERY_PROFILE_PRESETS,
    )) {
      expect(deliveryPreset).toBeDefined();
      if (deliveryPreset === undefined) continue;
      const descriptor = webhookProfile(deliveryPreset.profile_id)!;
      expect(descriptor.mechanism_kind).toBe('raw_body_hmac');
      expect(descriptor.decoder_kind).toBe('json');
      expect(descriptor.fields.every((field) => field.required)).toBe(true);
      expect(descriptor.fields.find(
        (field) => field.key === deliveryPreset.mechanism.secret_field,
      )?.kind).toBe('secret');
      if (deliveryPreset.mechanism.signature_header.kind === 'credential_field') {
        const headerField = deliveryPreset.mechanism.signature_header.field;
        expect(descriptor.fields.find(
          (field) => field.key === headerField,
        )?.kind).toBe('text');
      }
    }
  });

  it('shares exact-byte authentication while preserving profile match policy', () => {
    const officialBody = Buffer.from('Hello, World!', 'utf8');
    const officialSecret = "It's a Secret to Everybody";
    const officialSignature =
      'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
    const officialMechanism = createWebhookRawBodyHmacMechanism({
      kind: 'raw_body_hmac_sha256.v1',
      secret_field: 'secret',
      secret_shape: 'nonempty_utf8_65536',
      signature_header: { kind: 'fixed', name: GITHUB_SIGNATURE_HEADER },
      signature_format: 'sha256_equals_lowerhex.v1',
      matching_credential: 'newest',
    });
    const officialContext = context([
      version(1, 100, { secret: officialSecret }),
    ]);
    expect(verifyGitHubWebhookSignature({
      signature: officialSignature,
      raw_body: officialBody,
      webhook_secret: officialSecret,
    })).toBe(true);
    expect(officialMechanism.authenticate(
      request(officialBody, GITHUB_SIGNATURE_HEADER, officialSignature),
      officialContext,
    )).toEqual({ ok: true, credential_version: '1' });
    expect('resolveCredentials' in officialMechanism).toBe(false);
    expect(officialMechanism.sign(
      officialBody,
      officialContext,
      'newest',
    )?.header_value).toBe(officialSignature);

    const configurable = createWebhookRawBodyHmacMechanism(
      GENERIC_RAW_BODY_HMAC_MECHANISM_PRESET,
    );
    const configurableContext = context([
      version(1, 100, {
        signature_header: 'X-Profile-Signature',
        signing_secret: 'shared-secret',
      }),
      version(2, 200, {
        signature_header: 'x-profile-signature',
        signing_secret: 'shared-secret',
      }),
    ]);
    const signed = configurable.sign(BODY, configurableContext, 'oldest')!;
    expect(configurable.authenticate(
      request(BODY, signed.header_name, signed.header_value),
      configurableContext,
    )).toEqual({ ok: true, credential_version: '1' });

    const fixed = createWebhookRawBodyHmacMechanism(
      GITHUB_WEBHOOK_RAW_BODY_HMAC_MECHANISM_PRESET,
    );
    const fixedContext = context([
      version(1, 100, { webhook_secret: GENERATED_SECRET }),
      version(2, 200, { webhook_secret: GENERATED_SECRET }),
    ]);
    const fixedSigned = fixed.sign(BODY, fixedContext, 'oldest')!;
    expect(fixedSigned).toMatchObject({
      credential_version: '1',
      header_name: GITHUB_SIGNATURE_HEADER,
    });
    expect(fixed.sign(BODY, context([
      version(1, 100, {
        webhook_secret: GENERATED_SECRET,
        signature_header: 'x-attacker-selected-signature',
      }),
    ]), 'oldest')).toBeNull();
    expect(fixed.authenticate(
      request(BODY, GITHUB_SIGNATURE_HEADER, fixedSigned.header_value),
      fixedContext,
    )).toEqual({ ok: true, credential_version: '2' });

    expect(configurable.authenticate(
      request(Buffer.from(BODY.toString('utf8').replace('\n ', '')), signed.header_name,
        signed.header_value),
      configurableContext,
    )).toEqual({ ok: false, reason: 'authentication_failed' });
    expect(configurable.authenticate(
      request(BODY, signed.header_name, signed.header_value.toUpperCase()),
      configurableContext,
    )).toEqual({ ok: false, reason: 'authentication_failed' });
    expect(configurable.authenticate(
      request(BODY, signed.header_name, [signed.header_value, signed.header_value]),
      configurableContext,
    )).toEqual({ ok: false, reason: 'authentication_failed' });
  });

  it('fails closed on credential and trusted-preset expansion', () => {
    const mechanism = createWebhookRawBodyHmacMechanism(
      GENERIC_RAW_BODY_HMAC_MECHANISM_PRESET,
    );
    expect(mechanism.validateCredentialShape({
      signature_header: 'x-signature',
      signing_secret: 'secret',
    })).toBe(true);
    expect(mechanism.validateCredentialShape({
      signature_header: 'x-signature',
      signing_secret: 'secret',
      algorithm: 'sha1',
    })).toBe(false);
    expect(mechanism.validateCredentialShape({
      signature_header: 'host',
      signing_secret: 'secret',
    })).toBe(false);
    expect(mechanism.authenticate(request(BODY, 'x-signature', 'sha256='), context([
      version(1, 1, { signature_header: 'x-signature', signing_secret: 'one' }),
      version(2, 2, { signature_header: 'x-signature', signing_secret: 'two' }),
      version(3, 3, { signature_header: 'x-signature', signing_secret: 'three' }),
    ]))).toEqual({ ok: false, reason: 'configuration_failed' });

    expect(() => createWebhookRawBodyHmacMechanism({
      ...GENERIC_RAW_BODY_HMAC_MECHANISM_PRESET,
      signature_format: 'owner-controlled',
    } as never)).toThrow('invalid trusted preset');
    expect(() => createWebhookRawBodyHmacMechanism({
      ...GENERIC_RAW_BODY_HMAC_MECHANISM_PRESET,
      algorithm: 'sha1',
    } as never)).toThrow('invalid trusted preset');
    expect(() => createWebhookRawBodyHmacMechanism({
      ...GENERIC_RAW_BODY_HMAC_MECHANISM_PRESET,
      signature_header: { kind: 'fixed', name: 'host' },
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookRawBodyHmacMechanism({
      ...GENERIC_RAW_BODY_HMAC_MECHANISM_PRESET,
      signature_header: {
        kind: 'credential_field',
        field: 'signing_secret',
      },
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookRawBodyHmacMechanism({
      ...GENERIC_RAW_BODY_HMAC_MECHANISM_PRESET,
      secret_shape: 'recued_generated_base64url_32',
    } as never)).toThrow('invalid trusted preset');
    expect(() => createWebhookRawBodyHmacMechanism({
      ...GITHUB_WEBHOOK_RAW_BODY_HMAC_MECHANISM_PRESET,
      secret_shape: {
        kind: 'fixed_length_ascii_token.v1',
        characters: 43,
        regex: '.*',
      },
    } as never)).toThrow('invalid trusted preset');

    let presetAccessorInvoked = false;
    const accessorHeader = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorHeader, 'kind', {
      enumerable: true,
      get() {
        presetAccessorInvoked = true;
        throw new Error('preset accessor must not execute');
      },
    });
    expect(() => createWebhookRawBodyHmacMechanism({
      ...GENERIC_RAW_BODY_HMAC_MECHANISM_PRESET,
      signature_header: accessorHeader,
    } as never)).toThrow('invalid trusted preset');
    expect(presetAccessorInvoked).toBe(false);

    const sparseVersions = new Array(1) as ResolvedWebhookCredentialVersion[];
    const sparseContext = context(sparseVersions);
    expect(mechanism.hasValidConfiguration(sparseContext)).toBe(false);
    expect(mechanism.authenticate(
      request(BODY, 'x-signature', `sha256=${'0'.repeat(64)}`),
      sparseContext,
    )).toEqual({ ok: false, reason: 'configuration_failed' });
    expect(mechanism.sign(BODY, sparseContext, 'newest')).toBeNull();
    const throwingArray = new Proxy([
      version(1, 1, {
        signature_header: 'x-signature',
        signing_secret: 'secret',
      }),
    ], {
      get(target, property, receiver) {
        if (property === 'length') throw new Error('array length unavailable');
        return Reflect.get(target, property, receiver);
      },
    });
    expect(mechanism.hasValidConfiguration(context(throwingArray))).toBe(false);

    let credentialAccessorInvoked = false;
    const accessorVersion = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(accessorVersion, {
      version: { enumerable: true, value: '1' },
      created_at: { enumerable: true, value: 1 },
      credentials: {
        enumerable: true,
        get() {
          credentialAccessorInvoked = true;
          throw new Error('credential accessor must not execute');
        },
      },
    });
    expect(mechanism.hasValidConfiguration(context([
      accessorVersion as unknown as ResolvedWebhookCredentialVersion,
    ]))).toBe(false);
    expect(credentialAccessorInvoked).toBe(false);

    const throwingContext = {
      ingress_id: 'whi_d201_profile_engine_throwing_fixture',
      environment: 'test',
      get credential_versions(): readonly ResolvedWebhookCredentialVersion[] {
        throw new Error('credential versions unavailable');
      },
      now: () => 0,
    } as WebhookProfileRuntimeContext;
    expect(mechanism.hasValidConfiguration(throwingContext)).toBe(false);
    expect(mechanism.sign(BODY, throwingContext, 'newest')).toBeNull();
    expect(mechanism.sign(
      BODY,
      context([version(1, 1, {
        signature_header: 'x-signature',
        signing_secret: 'secret',
      })]),
      'neither' as never,
    )).toBeNull();
  });

  it('uses core credential-version admission in raw-body HMAC contexts', () => {
    const mechanism = createWebhookRawBodyHmacMechanism(
      GENERIC_RAW_BODY_HMAC_MECHANISM_PRESET,
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
        request(BODY, 'x-signature', `sha256=${'0'.repeat(64)}`),
        invalidContext,
      )).toEqual({ ok: false, reason: 'configuration_failed' });
      expect(mechanism.sign(BODY, invalidContext, 'newest')).toBeNull();
    }
    expect(coercions).toBe(0);
  });

  it('decodes one bounded UTF-8 JSON object through a hard-capped preset', () => {
    expect(WEBHOOK_JSON_OBJECT_DECODER_V1.decode(BODY)).toEqual({
      z: 1,
      a: { items: [true, null, 'ok'] },
    });
    for (const invalid of [
      Buffer.from([0xff]),
      Buffer.from('\ufeff{"ok":true}', 'utf8'),
      Buffer.from('[]', 'utf8'),
      Buffer.from('{"value":1e400}', 'utf8'),
      Buffer.from('{"__proto__":{}}', 'utf8'),
      Buffer.from(`${'{"nested":'.repeat(34)}{}${'}'.repeat(34)}`, 'utf8'),
      Buffer.from(JSON.stringify({ values: new Array(10_001).fill(null) }), 'utf8'),
      Buffer.from(JSON.stringify({ ['k'.repeat(257)]: true }), 'utf8'),
    ]) {
      expect(WEBHOOK_JSON_OBJECT_DECODER_V1.decode(invalid)).toBeNull();
    }

    const shallower = createWebhookJsonObjectDecoder({
      ...WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET,
      max_depth: 1,
    });
    expect(shallower.decode(Buffer.from('{"one":{"two":{"value":1}}}', 'utf8')))
      .toBeNull();
    expect(() => createWebhookJsonObjectDecoder({
      ...WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET,
      max_nodes: 50_001,
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonObjectDecoder({
      ...WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET,
      locator: '$.event',
    } as never)).toThrow('invalid trusted preset');
  });

  it('decodes strict bounded form fields through a hard-capped preset', () => {
    const decoded = WEBHOOK_FORM_URLENCODED_DECODER_V1.decode(Buffer.from(
      'message=hello+world&token=a=b&encoded=%2Frecued'
        + '&unicode=%E2%9C%93&literal_plus=%2B&empty=',
      'utf8',
    ));
    expect(decoded).toEqual({
      message: 'hello world',
      token: 'a=b',
      encoded: '/recued',
      unicode: '✓',
      literal_plus: '+',
      empty: '',
    });
    expect(decoded).not.toBeNull();
    if (decoded === null) return;
    expect(Object.getPrototypeOf(decoded)).toBeNull();
    expect(Object.isFrozen(decoded)).toBe(true);

    for (const invalid of [
      Buffer.alloc(0),
      Buffer.from([0xff]),
      Buffer.from('\ufeffkey=value', 'utf8'),
      Buffer.from('missing-equals', 'utf8'),
      Buffer.from('=missing-key', 'utf8'),
      Buffer.from('bad=%ZZ', 'utf8'),
      Buffer.from('__proto__=value', 'utf8'),
      Buffer.from('constructor=value', 'utf8'),
      Buffer.from('a=one&%61=two', 'utf8'),
      Buffer.from(Array.from(
        { length: 65 },
        (_, index) => `k${index}=v`,
      ).join('&'), 'utf8'),
      Buffer.from(`${'k'.repeat(129)}=value`, 'utf8'),
      Buffer.from(`key=${'v'.repeat(262_145)}`, 'utf8'),
      Buffer.alloc(1_048_577, 0x61),
    ]) {
      expect(WEBHOOK_FORM_URLENCODED_DECODER_V1.decode(invalid)).toBeNull();
    }

    const maximumFields = WEBHOOK_FORM_URLENCODED_DECODER_V1.decode(Buffer.from(
      Array.from({ length: 64 }, (_, index) => `k${index}=v`).join('&'),
      'utf8',
    ));
    expect(maximumFields).not.toBeNull();
    expect(Object.keys(maximumFields!)).toHaveLength(64);
    const maximumKey = 'k'.repeat(128);
    const maximumValue = 'v'.repeat(262_144);
    const maximumKeyAndValue = WEBHOOK_FORM_URLENCODED_DECODER_V1.decode(
      Buffer.from(`${maximumKey}=${maximumValue}`, 'utf8'),
    );
    expect(maximumKeyAndValue?.[maximumKey]).toHaveLength(262_144);

    const oneField = createWebhookFormUrlencodedDecoder({
      ...WEBHOOK_FORM_URLENCODED_DECODER_V1_PRESET,
      max_fields: 1,
    });
    expect(oneField.decode(Buffer.from('one=1', 'utf8'))).toEqual({ one: '1' });
    expect(oneField.decode(Buffer.from('one=1&two=2', 'utf8'))).toBeNull();
    const fourBytes = createWebhookFormUrlencodedDecoder({
      ...WEBHOOK_FORM_URLENCODED_DECODER_V1_PRESET,
      max_body_bytes: 4,
    });
    expect(fourBytes.decode(Buffer.from('a=12', 'utf8'))).toEqual({ a: '12' });
    expect(fourBytes.decode(Buffer.from('a=123', 'utf8'))).toBeNull();

    expect(() => createWebhookFormUrlencodedDecoder({
      ...WEBHOOK_FORM_URLENCODED_DECODER_V1_PRESET,
      max_fields: 65,
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookFormUrlencodedDecoder({
      ...WEBHOOK_FORM_URLENCODED_DECODER_V1_PRESET,
      key_grammar: 'owner_regex',
    } as never)).toThrow('invalid trusted preset');
    expect(() => createWebhookFormUrlencodedDecoder({
      ...WEBHOOK_FORM_URLENCODED_DECODER_V1_PRESET,
      parser: () => ({ arbitrary: 'code' }),
    } as never)).toThrow('invalid trusted preset');

    let accessorInvoked = false;
    const accessorPreset = {
      ...WEBHOOK_FORM_URLENCODED_DECODER_V1_PRESET,
    } as Record<string, unknown>;
    Object.defineProperty(accessorPreset, 'kind', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('form-decoder preset accessor must not execute');
      },
    });
    expect(() => createWebhookFormUrlencodedDecoder(
      accessorPreset as never,
    )).toThrow('invalid trusted preset');
    expect(accessorInvoked).toBe(false);
  });

  it('selects one exclusive form-wrapped JSON field through preset data', () => {
    const wrapper = createWebhookFormWrappedJsonDecoder({
      kind: 'exclusive_form_json_field.v1',
      json_field: 'body',
    });
    expectDeeplyFrozen(wrapper.preset);
    expect(() => JSON.stringify(wrapper.preset)).not.toThrow();

    const wrapped = WEBHOOK_FORM_URLENCODED_DECODER_V1.decode(Buffer.from(
      'body=%7B%22type%22%3A%22changed%22%2C%22value%22%3A1%7D',
      'utf8',
    ));
    expect(wrapper.classify(wrapped, WEBHOOK_JSON_OBJECT_DECODER_V1)).toEqual({
      kind: 'matched',
      envelope: { type: 'changed', value: 1 },
    });
    expect(wrapper.classify(
      Object.freeze(Object.assign(Object.create(null), { flat: 'value' })),
      WEBHOOK_JSON_OBJECT_DECODER_V1,
    )).toEqual({ kind: 'not_matched' });
    const inheritedWrapper = createWebhookFormWrappedJsonDecoder({
      kind: 'exclusive_form_json_field.v1',
      json_field: 'toString',
    });
    expect(inheritedWrapper.classify(
      { flat: 'value' },
      WEBHOOK_JSON_OBJECT_DECODER_V1,
    )).toEqual({ kind: 'matched_invalid' });
    expect(inheritedWrapper.classify(
      Object.assign(Object.create(null), { flat: 'value' }),
      WEBHOOK_JSON_OBJECT_DECODER_V1,
    )).toEqual({ kind: 'not_matched' });

    for (const fields of [
      Object.freeze(Object.assign(Object.create(null), {
        body: '{}',
        extra: 'ambiguous',
      })),
      Object.freeze(Object.assign(Object.create(null), { body: '[]' })),
      Object.freeze(Object.assign(Object.create(null), { body: '{' })),
      { body: 1 },
      Object.create({ body: '{}' }),
    ]) {
      expect(wrapper.classify(fields, WEBHOOK_JSON_OBJECT_DECODER_V1))
        .toEqual({ kind: 'matched_invalid' });
    }

    let accessorInvoked = false;
    const accessorFields = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorFields, 'body', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('wrapped JSON field accessor must not execute');
      },
    });
    expect(wrapper.classify(accessorFields, WEBHOOK_JSON_OBJECT_DECODER_V1))
      .toEqual({ kind: 'matched_invalid' });
    expect(accessorInvoked).toBe(false);

    const nonEnumerableFields = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(nonEnumerableFields, 'body', {
      enumerable: false,
      value: '{}',
    });
    expect(wrapper.classify(
      nonEnumerableFields,
      WEBHOOK_JSON_OBJECT_DECODER_V1,
    )).toEqual({ kind: 'matched_invalid' });
    expect(wrapper.classify(wrapped, {
      ...WEBHOOK_JSON_OBJECT_DECODER_V1,
      decode() {
        throw new Error('bounded JSON decoder unavailable');
      },
    })).toEqual({ kind: 'matched_invalid' });

    expect(() => createWebhookFormWrappedJsonDecoder({
      kind: 'exclusive_form_json_field.v1',
      json_field: 'f'.repeat(128),
    })).not.toThrow();

    expect(() => createWebhookFormWrappedJsonDecoder({
      kind: 'exclusive_form_json_field.v1',
      json_field: 'bad field',
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookFormWrappedJsonDecoder({
      kind: 'exclusive_form_json_field.v1',
      json_field: 'f'.repeat(129),
    })).toThrow('invalid trusted preset');
    for (const jsonField of ['__proto__', 'constructor', 'prototype']) {
      expect(() => createWebhookFormWrappedJsonDecoder({
        kind: 'exclusive_form_json_field.v1',
        json_field: jsonField,
      })).toThrow('invalid trusted preset');
    }
    expect(() => createWebhookFormWrappedJsonDecoder({
      kind: 'exclusive_form_json_field.v1',
      json_field: 'body',
      reviver: () => true,
    } as never)).toThrow('invalid trusted preset');

    const accessorPreset = {
      kind: 'exclusive_form_json_field.v1',
      json_field: 'body',
    } as Record<string, unknown>;
    Object.defineProperty(accessorPreset, 'json_field', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('wrapped JSON preset accessor must not execute');
      },
    });
    expect(() => createWebhookFormWrappedJsonDecoder(accessorPreset as never))
      .toThrow('invalid trusted preset');
    expect(accessorInvoked).toBe(false);
  });

  it('classifies and renders one closed JSON challenge projection', () => {
    const preset = {
      kind: 'json_challenge_echo.v1',
      discriminator_field: 'mode',
      discriminator_value: 'prove',
      challenge_field: 'token',
      response_field: 'proof',
      max_challenge_bytes: 8,
    } as const;
    const projector = createWebhookJsonChallengeProjector(preset);
    expectDeeplyFrozen(projector.preset);
    expect(() => JSON.stringify(projector.preset)).not.toThrow();
    expect(projector.classify({ mode: 'other', token: 'ignored' }))
      .toEqual({ kind: 'not_matched' });
    expect(projector.classify({ token: 'missing mode' }))
      .toEqual({ kind: 'not_matched' });

    for (const envelope of [
      { mode: 'prove' },
      { mode: 'prove', token: null },
      { mode: 'prove', token: '' },
      { mode: 'prove', token: ' padded ' },
      { mode: 'prove', token: 'bad\nvalue' },
      { mode: 'prove', token: '123456789' },
      [],
    ]) {
      expect(projector.classify(envelope)).toEqual({ kind: 'matched_invalid' });
    }

    const challenge = 'a"b\\c';
    const matched = projector.classify({
      mode: 'prove',
      token: challenge,
      ignored: 'metadata',
    });
    expect(matched).toEqual({
      kind: 'matched',
      projection: {
        response: {
          status: 200,
          content_type: 'application/json',
          body: JSON.stringify({ proof: challenge }),
        },
        readiness_proven: true,
      },
    });
    expectDeeplyFrozen(matched);

    let envelopeAccessorInvoked = false;
    const accessorEnvelope = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(accessorEnvelope, {
      mode: { enumerable: true, value: 'prove' },
      token: {
        enumerable: true,
        get() {
          envelopeAccessorInvoked = true;
          throw new Error('challenge accessor must not execute');
        },
      },
    });
    expect(projector.classify(accessorEnvelope))
      .toEqual({ kind: 'matched_invalid' });
    expect(envelopeAccessorInvoked).toBe(false);

    const discriminatorAccessorEnvelope = Object.create(null) as Record<
      string,
      unknown
    >;
    Object.defineProperties(discriminatorAccessorEnvelope, {
      mode: {
        enumerable: true,
        get() {
          envelopeAccessorInvoked = true;
          throw new Error('discriminator accessor must not execute');
        },
      },
      token: { enumerable: true, value: challenge },
    });
    expect(projector.classify(discriminatorAccessorEnvelope))
      .toEqual({ kind: 'matched_invalid' });
    expect(envelopeAccessorInvoked).toBe(false);

    expect(() => createWebhookJsonChallengeProjector({
      ...preset,
      challenge_field: 'mode',
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonChallengeProjector({
      ...preset,
      response_field: '__proto__',
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonChallengeProjector({
      ...preset,
      max_challenge_bytes: 65_537,
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonChallengeProjector({
      ...preset,
      render: () => 'arbitrary response',
    } as never)).toThrow('invalid trusted preset');

    let presetAccessorInvoked = false;
    const accessorPreset = { ...preset } as Record<string, unknown>;
    Object.defineProperty(accessorPreset, 'kind', {
      enumerable: true,
      get() {
        presetAccessorInvoked = true;
        throw new Error('challenge preset accessor must not execute');
      },
    });
    expect(() => createWebhookJsonChallengeProjector(
      accessorPreset as never,
    )).toThrow('invalid trusted preset');
    expect(presetAccessorInvoked).toBe(false);
  });

  it('projects one normalized record through closed top-level field data', () => {
    const preset = {
      kind: 'normalized_single_event.v1',
      provider_event_id_field: 'external_id',
      provider_resource_id_field: 'subject_id',
      provider_event_type_field: 'event_kind',
      provider_occurred_at_field: 'event_seconds',
      decoded_payload_field: 'body',
      occurred_at_unit: 'unix_seconds_to_milliseconds.v1',
    } as const;
    const projector = createWebhookNormalizedSingleEventProjector(preset);
    expectDeeplyFrozen(projector.preset);
    expect(() => JSON.stringify(projector.preset)).not.toThrow();

    const payload = { nested: { value: true } };
    const projected = projector.project({
      external_id: 'evt_8q',
      subject_id: 'resource_8q',
      event_kind: 'object.changed',
      event_seconds: 1_750_000_000,
      body: payload,
      ignored: 'metadata',
    }, 'delivery:8q:0');
    expect(projected).toEqual({
      event_dedup_key: 'delivery:8q:0',
      provider_event_id: 'evt_8q',
      provider_resource_id: 'resource_8q',
      provider_event_type: 'object.changed',
      provider_occurred_at: 1_750_000_000_000,
      decoded_payload: payload,
    });
    expect(Object.isFrozen(projected)).toBe(true);
    expect(projected?.decoded_payload).toBe(payload);

    expect(projector.project({
      external_id: null,
      subject_id: null,
      event_kind: 'delivery',
      event_seconds: null,
      body: Object.create(null),
    }, 'delivery:8q:nulls')).toMatchObject({
      provider_event_id: null,
      provider_resource_id: null,
      provider_occurred_at: null,
    });
    const millisecondsProjector = createWebhookNormalizedSingleEventProjector({
      ...preset,
      occurred_at_unit: 'unix_milliseconds.v1',
    });
    expect(millisecondsProjector.project({
      external_id: null,
      subject_id: null,
      event_kind: 'delivery',
      event_seconds: 1_750_000_000_123,
      body: {},
    }, 'delivery:8q:milliseconds')).toMatchObject({
      provider_occurred_at: 1_750_000_000_123,
    });
    expect(millisecondsProjector.project({
      external_id: null,
      subject_id: null,
      event_kind: 'delivery',
      event_seconds: Number.MAX_SAFE_INTEGER + 1,
      body: {},
    }, 'delivery:8q:unsafe-milliseconds')).toBeNull();

    expect(projector.project({
      external_id: 'i'.repeat(512),
      subject_id: 'r'.repeat(512),
      event_kind: 't'.repeat(128),
      event_seconds: Math.floor(Number.MAX_SAFE_INTEGER / 1_000),
      body: {},
    }, 'd'.repeat(256))).not.toBeNull();

    const validBase = {
      external_id: 'evt_8q',
      subject_id: 'resource_8q',
      event_kind: 'object.changed',
      event_seconds: 1_750_000_000,
      body: {},
    };
    for (const [candidate, dedupKey] of [
      [null, 'delivery:8q:invalid'],
      [{ ...validBase, external_id: '' }, 'delivery:8q:invalid'],
      [{ ...validBase, external_id: ' padded ' }, 'delivery:8q:invalid'],
      [{ ...validBase, external_id: 'i'.repeat(513) }, 'delivery:8q:invalid'],
      [{ ...validBase, subject_id: 'bad\nvalue' }, 'delivery:8q:invalid'],
      [{ ...validBase, subject_id: 'r'.repeat(513) }, 'delivery:8q:invalid'],
      [{ ...validBase, event_kind: '' }, 'delivery:8q:invalid'],
      [{ ...validBase, event_kind: 't'.repeat(129) }, 'delivery:8q:invalid'],
      [{ ...validBase, event_seconds: -1 }, 'delivery:8q:invalid'],
      [{ ...validBase, event_seconds: 1.5 }, 'delivery:8q:invalid'],
      [{
        ...validBase,
        event_seconds: Math.floor(Number.MAX_SAFE_INTEGER / 1_000) + 1,
      }, 'delivery:8q:invalid'],
      [{ ...validBase, body: [] }, 'delivery:8q:invalid'],
      [{
        external_id: validBase.external_id,
        subject_id: validBase.subject_id,
        event_kind: validBase.event_kind,
        event_seconds: validBase.event_seconds,
      }, 'delivery:8q:invalid'],
      [validBase, ''],
      [validBase, ' padded '],
      [validBase, 'bad\ndedup'],
      [validBase, 'd'.repeat(257)],
    ] as const) {
      expect(projector.project(candidate, dedupKey)).toBeNull();
    }

    let accessorInvoked = false;
    const accessorEnvelope = { ...validBase };
    Object.defineProperty(accessorEnvelope, 'event_kind', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('normalized event accessor must not execute');
      },
    });
    expect(projector.project(accessorEnvelope, 'delivery:8q:accessor'))
      .toBeNull();
    expect(accessorInvoked).toBe(false);

    const ignoredAccessorEnvelope = { ...validBase };
    Object.defineProperty(ignoredAccessorEnvelope, 'ignored', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('ignored metadata accessor must not execute');
      },
    });
    expect(projector.project(
      ignoredAccessorEnvelope,
      'delivery:8q:ignored-accessor',
    )).not.toBeNull();
    expect(accessorInvoked).toBe(false);

    const inheritedFieldProjector =
      createWebhookNormalizedSingleEventProjector({
        ...preset,
        provider_event_type_field: 'toString',
      });
    expect(inheritedFieldProjector.project(
      validBase,
      'delivery:8q:inherited',
    )).toBeNull();

    expect(() => createWebhookNormalizedSingleEventProjector({
      ...preset,
      decoded_payload_field: 'event_kind',
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookNormalizedSingleEventProjector({
      ...preset,
      provider_event_id_field: '__proto__',
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookNormalizedSingleEventProjector({
      ...preset,
      provider_event_id_field: 'bad-field',
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookNormalizedSingleEventProjector({
      ...preset,
      provider_event_id_field: 'f'.repeat(129),
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookNormalizedSingleEventProjector({
      ...preset,
      occurred_at_unit: 'iso8601_callback.v1',
    } as never)).toThrow('invalid trusted preset');
    expect(() => createWebhookNormalizedSingleEventProjector({
      ...preset,
      transform: () => 'executable projection',
    } as never)).toThrow('invalid trusted preset');

    const accessorPreset = { ...preset } as Record<string, unknown>;
    Object.defineProperty(accessorPreset, 'kind', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error('normalized event preset accessor must not execute');
      },
    });
    expect(() => createWebhookNormalizedSingleEventProjector(
      accessorPreset as never,
    )).toThrow('invalid trusted preset');
    expect(accessorInvoked).toBe(false);
  });
});
