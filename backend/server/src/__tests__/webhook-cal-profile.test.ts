import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { webhookProfile } from '@recued/contracts';
import {
  createCalWebhookProfileAdapter,
  validateCalWebhookCredentialShape,
} from '../webhook-cal-profile.js';
import { webhookRawBodyHmacDeliveryProfilePreset } from '../webhook-delivery-engine-presets.js';
import type {
  RawWebhookRequest,
  WebhookProfileRuntimeContext,
} from '../webhook-profile-runtime.js';

const SECRET = 'cal-signing-secret-for-tests';
const BODY = Buffer.from(JSON.stringify({
  triggerEvent: 'RECORDING_TRANSCRIPTION_GENERATED',
  createdAt: '2026-08-20T12:34:56.789Z',
  payload: {
    uid: 'booking_UID-123',
    title: 'Project review',
    attendees: [{ email: '[email protected]' }],
  },
}), 'utf8');

const context = (): WebhookProfileRuntimeContext => ({
  ingress_id: 'whi_cal_transcription',
  environment: 'live',
  credential_versions: [{
    version: '1',
    created_at: 1,
    credentials: { signing_secret: SECRET },
  }],
  now: () => Date.parse('2026-08-20T12:35:00.000Z'),
});

const request = (
  rawBody: Uint8Array = BODY,
  signature = createHmac('sha256', SECRET).update(rawBody).digest('hex'),
  receivedAt = Date.parse('2026-08-20T12:35:01.000Z'),
): RawWebhookRequest => ({
  method: 'POST',
  raw_body: Buffer.from(rawBody),
  headers: new Map([['x-cal-signature-256', [signature]]]),
  raw_path_and_query: '/webhooks/whi_cal_transcription',
  canonical_public_url: 'https://recued.example/webhooks/whi_cal_transcription',
  received_at: receivedAt,
  remote_ip: '203.0.113.10',
});

const SUPPORTED_EVENTS = [
  'RECORDING_TRANSCRIPTION_GENERATED',
  'BOOKING_CANCELLED',
  'BOOKING_RESCHEDULED',
  'BOOKING_NO_SHOW_UPDATED',
  'BOOKING_PAID',
] as const;

describe('Cal.com booking and meeting webhook profile', () => {
  it('declares the normalized signed events and the exact Cal.com digest format', () => {
    expect(webhookProfile('cal.webhook.v1')).toMatchObject({
      vendor: 'cal.com',
      mechanism_kind: 'raw_body_hmac',
      decoded_schema_id: 'cal.webhook.v1',
      minimum_source_truth_policy: 'provider_readback_required',
      event_types: {
        kind: 'closed',
        values: SUPPORTED_EVENTS,
      },
      deduplication: { identity: { kind: 'stable_provider_id' } },
    });
    expect(webhookRawBodyHmacDeliveryProfilePreset('cal.webhook.v1')?.mechanism)
      .toMatchObject({
        secret_field: 'signing_secret',
        signature_header: { kind: 'fixed', name: 'x-cal-signature-256' },
        signature_format: 'lowerhex.v1',
      });
  });

  it.each(SUPPORTED_EVENTS)('normalizes signed %s deliveries to a booking pointer', async (eventType) => {
    const rawBody = Buffer.from(JSON.stringify({
      triggerEvent: eventType,
      createdAt: '2026-08-20T12:34:56.789Z',
      payload: eventType === 'BOOKING_NO_SHOW_UPDATED'
        ? { bookingUid: 'booking_UID-123' }
        : { uid: 'booking_UID-123' },
    }), 'utf8');
    await expect(createCalWebhookProfileAdapter().verifyAndDecode(
      request(rawBody),
      context(),
    )).resolves.toMatchObject({
      ok: true,
      delivery: { events: [{
        provider_resource_id: 'booking_UID-123',
        provider_event_type: eventType,
      }] },
    });
  });

  it('authenticates the raw body and projects a stable booking event', async () => {
    const result = await createCalWebhookProfileAdapter()
      .verifyAndDecode(request(), context());
    expect(result).toMatchObject({
      ok: true,
      delivery: {
        decoded_content_type: 'application/json',
        admission: {
          transport_assurance: 'authenticated',
          credential_version: '1',
          freshness_checked: false,
          method_label: 'cal-hmac-sha256',
        },
        events: [{
          provider_resource_id: 'booking_UID-123',
          provider_event_type: 'RECORDING_TRANSCRIPTION_GENERATED',
          provider_occurred_at: Date.parse('2026-08-20T12:34:56.789Z'),
        }],
      },
    });
    if (!result.ok) throw new Error('expected accepted Cal.com delivery');
    expect(result.delivery.delivery_dedup_key).toMatch(/^cal:delivery:[a-f0-9]{64}$/u);
    expect(result.delivery.events[0]?.provider_event_id)
      .toMatch(/^cal:event:[a-f0-9]{64}$/u);
  });

  it('deduplicates an exact provider retry independently of receipt time', async () => {
    const adapter = createCalWebhookProfileAdapter();
    const first = await adapter.verifyAndDecode(request(BODY, undefined, 1), context());
    const retry = await adapter.verifyAndDecode(request(BODY, undefined, 9_999_999), context());
    if (!first.ok || !retry.ok) throw new Error('expected accepted Cal.com deliveries');
    expect(retry.delivery.delivery_dedup_key).toBe(first.delivery.delivery_dedup_key);
    expect(retry.delivery.events[0]?.event_dedup_key)
      .toBe(first.delivery.events[0]?.event_dedup_key);
  });

  it('rejects a prefixed digest, a bad digest, and unsupported payload shapes', async () => {
    const digest = createHmac('sha256', SECRET).update(BODY).digest('hex');
    const adapter = createCalWebhookProfileAdapter();
    await expect(adapter.verifyAndDecode(request(BODY, `sha256=${digest}`), context()))
      .resolves.toMatchObject({ ok: false, failure: { code: 'authentication_failed' } });
    await expect(adapter.verifyAndDecode(request(BODY, '0'.repeat(64)), context()))
      .resolves.toMatchObject({ ok: false, failure: { code: 'authentication_failed' } });

    for (const payload of [
      { triggerEvent: 'BOOKING_CREATED', createdAt: '2026-08-20T12:34:56.789Z', payload: { uid: 'x' } },
      { triggerEvent: 'RECORDING_TRANSCRIPTION_GENERATED', createdAt: 'not-a-time', payload: { uid: 'x' } },
      { triggerEvent: 'RECORDING_TRANSCRIPTION_GENERATED', createdAt: '2026-08-20T12:34:56.789Z', payload: {} },
    ]) {
      const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
      await expect(adapter.verifyAndDecode(request(rawBody), context()))
        .resolves.toMatchObject({ ok: false, failure: { code: 'structural_admission_failed' } });
    }
  });

  it.each(SUPPORTED_EVENTS)('round-trips a core %s test delivery', async (eventType) => {
    expect(validateCalWebhookCredentialShape({ signing_secret: SECRET })).toBe(true);
    expect(validateCalWebhookCredentialShape({ signing_secret: '' })).toBe(false);
    expect(validateCalWebhookCredentialShape({ signing_secret: SECRET, extra: 'x' })).toBe(false);

    const adapter = createCalWebhookProfileAdapter();
    const built = await adapter.buildTestDelivery?.({
      nonce: 'a'.repeat(64),
      selected_event_types: [eventType],
    }, context());
    expect(built).toBeDefined();
    const delivery = await adapter.verifyAndDecode({
      ...request(built!.raw_body),
      headers: new Map(Object.entries(built!.headers).map(([name, value]) => [name, [value]])),
    }, context());
    expect(delivery).toMatchObject({
      ok: true,
      delivery: {
        events: [{ provider_event_type: eventType }],
      },
    });
  });
});
