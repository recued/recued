/** Cal.com booking and meeting webhook admission.
 *
 * Cal.com signs the exact request body with HMAC-SHA256 and sends the plain
 * lower-hex digest in `x-cal-signature-256`. The payload has no provider event
 * id, so this adapter derives one from the signed event type, occurrence time,
 * and booking UID. That identity makes an exact provider retry converge while
 * leaving the booking UID available only as a pointer for provider read-back.
 */

import { createHash } from 'node:crypto';
import {
  webhookProfile,
  webhookProfileAcceptsEventType,
  type WebhookProfileId,
} from '@recued/contracts';
import { webhookRawBodyHmacDeliveryProfilePreset } from './webhook-delivery-engine-presets.js';
import { createWebhookJsonObjectDecoder } from './webhook-json-object-decoder.js';
import { createWebhookRawBodyHmacMechanism } from './webhook-raw-body-hmac-engine.js';
import { createWebhookRfc3339TimestampParser } from './webhook-rfc3339-timestamp-parser.js';
import type {
  RawWebhookRequest,
  WebhookIngressProfileAdapter,
  WebhookProfileResult,
  WebhookProfileRuntimeContext,
  WebhookProfileTestDeliveryInput,
} from './webhook-profile-runtime.js';

const PROFILE_ID: WebhookProfileId = 'cal.webhook.v1';
const SUCCESS_RESPONSE = Object.freeze({ status: 200 } as const);
const BOOKING_UID_RE = /^[A-Za-z0-9_-]{1,256}$/u;
const TEST_NONCE_RE = /^[a-f0-9]{64}$/u;

const preset = webhookRawBodyHmacDeliveryProfilePreset(PROFILE_ID);
if (preset === null) throw new Error('Cal.com webhook delivery preset is unavailable');
const descriptor = webhookProfile(PROFILE_ID);
if (descriptor === null) throw new Error('Cal.com webhook descriptor is unavailable');

const mechanism = createWebhookRawBodyHmacMechanism(preset.mechanism);
const decoder = createWebhookJsonObjectDecoder(preset.decoder);
const timestampParser = createWebhookRfc3339TimestampParser({
  kind: 'strict_rfc3339_milliseconds.v1',
  max_bytes: 64,
});

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const configurationFailure = (): WebhookProfileResult => ({
  ok: false,
  failure: {
    disposition: 'retry',
    code: 'profile_internal_error',
    response: { status: 503 },
  },
});

const authenticationFailure = (): WebhookProfileResult => ({
  ok: false,
  failure: {
    disposition: 'reject',
    code: 'authentication_failed',
    response: { status: 401 },
  },
});

const structuralFailure = (): WebhookProfileResult => ({
  ok: false,
  failure: {
    disposition: 'reject',
    code: 'structural_admission_failed',
    response: { status: 400 },
  },
});

const normalize = (envelope: Record<string, unknown>) => {
  const eventType = envelope.triggerEvent;
  const occurredAt = timestampParser.parse(envelope.createdAt);
  const payload = envelope.payload;
  if (typeof eventType !== 'string'
    || !webhookProfileAcceptsEventType(descriptor, eventType)
    || occurredAt === null
    || !isPlainRecord(payload)) {
    return null;
  }
  const rawBookingUid = payload.uid ?? payload.bookingUid;
  if (typeof rawBookingUid !== 'string' || !BOOKING_UID_RE.test(rawBookingUid)) {
    return null;
  }
  const identityDigest = createHash('sha256')
    .update(eventType, 'utf8')
    .update('\0')
    .update(envelope.createdAt as string, 'utf8')
    .update('\0')
    .update(rawBookingUid, 'utf8')
    .digest('hex');
  return {
    eventType,
    occurredAt,
    bookingUid: rawBookingUid,
    providerEventId: `cal:event:${identityDigest}`,
    deliveryDedupKey: `cal:delivery:${identityDigest}`,
  };
};

export const validateCalWebhookCredentialShape = (
  credentials: Readonly<Record<string, string>>,
): boolean => mechanism.validateCredentialShape(credentials);

export const createCalWebhookProfileAdapter = (): WebhookIngressProfileAdapter =>
  Object.freeze({
    profile_id: PROFILE_ID,
    success_response: SUCCESS_RESPONSE,
    buildTestDelivery(
      input: WebhookProfileTestDeliveryInput,
      context: WebhookProfileRuntimeContext,
    ) {
      const selectedEvent = input.selected_event_types[0];
      if (input.selected_event_types.length !== 1
        || typeof selectedEvent !== 'string'
        || !webhookProfileAcceptsEventType(descriptor, selectedEvent)
        || !TEST_NONCE_RE.test(input.nonce)
        || !mechanism.hasValidConfiguration(context)) {
        throw new Error('Cal.com webhook test delivery configuration is invalid');
      }
      let now: number;
      try {
        now = context.now();
      } catch {
        throw new Error('Cal.com webhook test clock is unavailable');
      }
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new Error('Cal.com webhook test clock is unavailable');
      }
      const rawBody = Buffer.from(JSON.stringify({
        triggerEvent: selectedEvent,
        createdAt: new Date(now).toISOString(),
        payload: { uid: `recued-test-${input.nonce}` },
      }), 'utf8');
      const signature = mechanism.sign(rawBody, context, 'newest');
      if (signature === null) {
        throw new Error('Cal.com webhook test credentials are unavailable');
      }
      return {
        raw_body: rawBody,
        headers: Object.freeze({
          [signature.header_name]: signature.header_value,
        }),
      };
    },
    async verifyAndDecode(
      request: RawWebhookRequest,
      context: WebhookProfileRuntimeContext,
    ): Promise<WebhookProfileResult> {
      if (!mechanism.hasValidConfiguration(context)
        || !descriptor.supported_environments.includes(context.environment)) {
        return configurationFailure();
      }
      const authenticated = mechanism.authenticate(request, context);
      if (!authenticated.ok) {
        return authenticated.reason === 'configuration_failed'
          ? configurationFailure()
          : authenticationFailure();
      }
      const envelope = decoder.decode(request.raw_body);
      if (envelope === null) return structuralFailure();
      const normalized = normalize(envelope);
      if (normalized === null) return structuralFailure();
      return {
        ok: true,
        delivery: {
          delivery_dedup_key: normalized.deliveryDedupKey,
          decoded_content_type: 'application/json',
          events: [{
            event_dedup_key: `${normalized.deliveryDedupKey}:0`,
            provider_event_id: normalized.providerEventId,
            provider_resource_id: normalized.bookingUid,
            provider_event_type: normalized.eventType,
            provider_occurred_at: normalized.occurredAt,
            decoded_payload: envelope,
          }],
          response: SUCCESS_RESPONSE,
          admission: {
            transport_assurance: 'authenticated',
            credential_version: authenticated.credential_version,
            freshness_checked: false,
            method_label: 'cal-hmac-sha256',
          },
        },
      };
    },
  });
