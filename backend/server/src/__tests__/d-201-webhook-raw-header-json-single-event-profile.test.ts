import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  GITHUB_DELIVERY_HEADER,
  GITHUB_EVENT_HEADER,
  GITHUB_HOOK_ID_HEADER,
  GITHUB_SIGNATURE_HEADER,
} from '../connections/providers/github-webhook-protocol.js';
import {
  createRawHeaderJsonSingleEventWebhookCredentialShapeValidator,
  createRawHeaderJsonSingleEventWebhookProfileAdapter,
} from '../webhook-raw-header-json-single-event-profile.js';
import type {
  RawWebhookRequest,
  ResolvedWebhookCredentialVersion,
  WebhookProfileRuntimeContext,
} from '../webhook-profile-runtime.js';

const NOW_MS = Date.parse('2026-07-12T20:00:00.000Z');
const SECRET = 'A'.repeat(43);
const OLDER_SECRET = 'B'.repeat(43);
const DELIVERY_ID = '72d3162e-cc78-11e3-81ab-4c9367dc0958';

const credential = (
  version: number,
  secret: string,
): ResolvedWebhookCredentialVersion => ({
  version: String(version),
  created_at: NOW_MS + version,
  credentials: { webhook_secret: secret },
});

const context = (
  versions: readonly ResolvedWebhookCredentialVersion[] = [
    credential(1, SECRET),
  ],
): WebhookProfileRuntimeContext => ({
  ingress_id: 'whi_d201rawheadercomposer1234',
  environment: 'test',
  credential_versions: versions,
  now: () => {
    throw new Error('raw-body composition must not read a clock');
  },
});

const request = (
  body: Buffer,
  secret = SECRET,
): RawWebhookRequest => ({
  method: 'POST',
  raw_body: body,
  headers: new Map([
    ['content-type', ['application/json']],
    [GITHUB_SIGNATURE_HEADER, [
      `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    ]],
    [GITHUB_DELIVERY_HEADER, [DELIVERY_ID]],
    [GITHUB_EVENT_HEADER, ['issues']],
    [GITHUB_HOOK_ID_HEADER, ['1']],
  ]),
  raw_path_and_query: '/v1/webhooks/composed-profile-fixture',
  canonical_public_url:
    'https://hooks.example.test/v1/webhooks/composed-profile-fixture',
  received_at: NOW_MS,
  remote_ip: '127.0.0.1',
});

describe('D-201 Slice 9W raw-header JSON single-event composition', () => {
  it('constructs only profiles with one complete compatible engine set', () => {
    const adapter = createRawHeaderJsonSingleEventWebhookProfileAdapter(
      'github.webhook.v1',
    );
    expect(adapter.profile_id).toBe('github.webhook.v1');
    expect(adapter.success_response).toEqual({ status: 200 });
    expect(adapter.buildTestDelivery).toBeTypeOf('function');

    for (const profileId of [
      'generic.raw-body-hmac-sha256.v1',
      'stripe.event.v1',
      'paddle.notification.v1',
    ] as const) {
      expect(() => createRawHeaderJsonSingleEventWebhookProfileAdapter(
        profileId,
      )).toThrow('is unavailable');
      expect(() => createRawHeaderJsonSingleEventWebhookCredentialShapeValidator(
        profileId,
      )).toThrow('is unavailable');
    }
  });

  it('runs authentication through projection with preset-selected policy', async () => {
    const adapter = createRawHeaderJsonSingleEventWebhookProfileAdapter(
      'github.webhook.v1',
    );
    const body = Buffer.from('{"action":"opened","issue":{"id":1}}', 'utf8');
    const result = await adapter.verifyAndDecode(request(body), context());
    expect(result).toMatchObject({
      ok: true,
      delivery: {
        decoded_content_type: 'application/json',
        response: { status: 200 },
        admission: {
          transport_assurance: 'authenticated',
          credential_version: '1',
          freshness_checked: false,
          method_label: 'github-hmac-sha256',
        },
        events: [{
          provider_event_id: DELIVERY_ID,
          provider_resource_id: null,
          provider_event_type: 'issues',
          provider_occurred_at: null,
          decoded_payload: { action: 'opened', issue: { id: 1 } },
        }],
      },
    });

    const invalid = await adapter.verifyAndDecode(
      request(body, OLDER_SECRET),
      context(),
    );
    expect(invalid).toEqual({
      ok: false,
      failure: {
        disposition: 'reject',
        code: 'authentication_failed',
        response: { status: 401 },
      },
    });
  });

  it('uses preset-selected oldest signing and shared credential admission', async () => {
    const validate =
      createRawHeaderJsonSingleEventWebhookCredentialShapeValidator(
        'github.webhook.v1',
      );
    expect(validate({ webhook_secret: SECRET })).toBe(true);
    expect(validate({ webhook_secret: SECRET, extra: 'authority' })).toBe(false);

    const adapter = createRawHeaderJsonSingleEventWebhookProfileAdapter(
      'github.webhook.v1',
    );
    const built = await adapter.buildTestDelivery!({
      nonce: 'd'.repeat(64),
      selected_event_types: ['issues'],
    }, context([
      credential(1, OLDER_SECRET),
      credential(2, SECRET),
    ]));
    const oldSignature = `sha256=${createHmac('sha256', OLDER_SECRET)
      .update(built.raw_body).digest('hex')}`;
    const newSignature = `sha256=${createHmac('sha256', SECRET)
      .update(built.raw_body).digest('hex')}`;
    expect(built.headers[GITHUB_SIGNATURE_HEADER]).toBe(oldSignature);
    expect(built.headers[GITHUB_SIGNATURE_HEADER]).not.toBe(newSignature);
    expect(built.headers[GITHUB_EVENT_HEADER]).toBe('issues');
  });
});
