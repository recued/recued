import { describe, expect, it } from 'vitest';

import {
  TELEGRAM_SECRET_HEADER,
} from '../connections/providers/telegram-webhook-protocol.js';
import type {
  RawWebhookRequest,
  ResolvedWebhookCredentialVersion,
  WebhookProfileRuntimeContext,
} from '../webhook-profile-runtime.js';
import {
  createStaticHeaderJsonSingleEventWebhookCredentialShapeValidator,
  createStaticHeaderJsonSingleEventWebhookProfileAdapter,
} from '../webhook-static-header-json-single-event-profile.js';

const NOW_MS = Date.parse('2026-07-12T21:00:00.000Z');
const SECRET = 'Telegram_static_composer_secret';

const credential = (
  version: number,
  secret: string,
): ResolvedWebhookCredentialVersion => ({
  version: String(version),
  created_at: NOW_MS + version,
  credentials: { secret_token: secret },
});

const context = (
  versions: readonly ResolvedWebhookCredentialVersion[] = [
    credential(1, SECRET),
  ],
): WebhookProfileRuntimeContext => ({
  ingress_id: 'whi_d201staticheadercomposer1',
  environment: 'test',
  credential_versions: versions,
  now: () => {
    throw new Error('static-header composition must not read a clock');
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
    [TELEGRAM_SECRET_HEADER, [secret]],
  ]),
  raw_path_and_query: '/v1/webhooks/composed-profile-fixture',
  canonical_public_url:
    'https://hooks.example.test/v1/webhooks/composed-profile-fixture',
  received_at: NOW_MS,
  remote_ip: '127.0.0.1',
});

describe('D-201 Slice 9AC static-header JSON single-event composition', () => {
  it('constructs only profiles with one complete compatible engine set', () => {
    const adapter = createStaticHeaderJsonSingleEventWebhookProfileAdapter(
      'telegram.bot-webhook.v1',
    );
    expect(adapter.profile_id).toBe('telegram.bot-webhook.v1');
    expect(adapter.success_response).toEqual({ status: 200 });
    expect(adapter.buildTestDelivery).toBeUndefined();

    for (const profileId of [
      'generic.static-header-token.v1',
      'github.webhook.v1',
      'stripe.event.v1',
    ] as const) {
      expect(() => createStaticHeaderJsonSingleEventWebhookProfileAdapter(
        profileId,
      )).toThrow('is unavailable');
      expect(() =>
        createStaticHeaderJsonSingleEventWebhookCredentialShapeValidator(
          profileId,
        )).toThrow('is unavailable');
    }
  });

  it('runs authentication through projection with preset-selected policy', async () => {
    const adapter = createStaticHeaderJsonSingleEventWebhookProfileAdapter(
      'telegram.bot-webhook.v1',
    );
    const body = Buffer.from(
      '{"update_id":104200,"message":{"message_id":81,"text":"hello"}}',
      'utf8',
    );
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
          method_label: 'telegram-secret-token',
        },
        events: [{
          provider_event_id: '104200',
          provider_resource_id: null,
          provider_event_type: 'message',
          provider_occurred_at: null,
          decoded_payload: {
            update_id: 104200,
            message: { message_id: 81, text: 'hello' },
          },
        }],
      },
    });
    if (!result.ok) throw new Error('expected composed delivery acceptance');
    expect(result.delivery.delivery_dedup_key).toBe(
      'telegram:update:93a0453c0add4392e45c68f4292d55f4e9c6aca0e6cc48a968236af55be9726d',
    );
    expect(result.delivery.events[0]?.event_dedup_key)
      .toBe(`${result.delivery.delivery_dedup_key}:0`);
  });

  it('shares credential admission and preserves closed failure mapping', async () => {
    const validate =
      createStaticHeaderJsonSingleEventWebhookCredentialShapeValidator(
        'telegram.bot-webhook.v1',
      );
    expect(validate({ secret_token: SECRET })).toBe(true);
    expect(validate({ secret_token: SECRET, extra: 'authority' })).toBe(false);

    const adapter = createStaticHeaderJsonSingleEventWebhookProfileAdapter(
      'telegram.bot-webhook.v1',
    );
    const body = Buffer.from('{"update_id":1,"message":{}}', 'utf8');
    await expect(adapter.verifyAndDecode(
      request(body, 'wrong_secret'),
      context(),
    )).resolves.toEqual({
      ok: false,
      failure: {
        disposition: 'reject',
        code: 'authentication_failed',
        response: { status: 401 },
      },
    });
    await expect(adapter.verifyAndDecode(
      request(Buffer.from('{not-json', 'utf8')),
      context(),
    )).resolves.toEqual({
      ok: false,
      failure: {
        disposition: 'reject',
        code: 'structural_admission_failed',
        response: { status: 400 },
      },
    });
    await expect(adapter.verifyAndDecode(
      request(body),
      context([
        credential(1, SECRET),
        credential(2, SECRET),
        credential(3, SECRET),
      ]),
    )).resolves.toEqual({
      ok: false,
      failure: {
        disposition: 'retry',
        code: 'profile_internal_error',
        response: { status: 503 },
      },
    });
  });
});
