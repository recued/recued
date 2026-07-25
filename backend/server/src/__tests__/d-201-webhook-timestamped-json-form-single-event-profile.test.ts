import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { WebhookClockHealthAuthority } from '../webhook-clock-health.js';
import { createBuiltinWebhookDeliveryProfileAdapters } from '../webhook-delivery-profile-presets.js';
import { BUILTIN_WEBHOOK_PROFILE_POLICIES } from '../webhook-profile-policy.js';
import {
  WebhookProfileDependencyUnavailableError,
  type RawWebhookRequest,
  type ResolvedWebhookCredentialVersion,
  type WebhookProfileRuntimeContext,
} from '../webhook-profile-runtime.js';
import {
  createClockGatedTimestampedJsonFormSingleEventWebhookProfileAdapter,
  createTimestampedJsonFormSingleEventWebhookCredentialShapeValidator,
  createTimestampedJsonFormSingleEventWebhookProfileAdapter,
} from '../webhook-timestamped-json-form-single-event-profile.js';

const NOW_MS = Date.parse('2026-07-12T22:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW_MS / 1_000);
const SECRET = 'timestamped-json-form-composer-secret';

const healthyClock: WebhookClockHealthAuthority = {
  check: async () => ({
    healthy: true,
    trusted_now_ms: NOW_MS,
    maximum_error_ms: 1_000,
    checked_at: NOW_MS,
  }),
};

const credential = (
  version: number,
  secret = SECRET,
): ResolvedWebhookCredentialVersion => ({
  version: String(version),
  created_at: NOW_MS + version,
  credentials: { signing_secret: secret },
});

const context = (
  now: () => number = () => NOW_MS,
): WebhookProfileRuntimeContext => ({
  ingress_id: 'whi_d201jsonformcomposer123',
  environment: 'test',
  credential_versions: [credential(1)],
  now,
});

const signature = (
  body: Buffer,
  timestamp = String(NOW_SECONDS),
): string => `v0=${createHmac('sha256', SECRET)
  .update(`v0:${timestamp}:`)
  .update(body)
  .digest('hex')}`;

const request = (
  body: Buffer,
  contentType = 'application/json',
): RawWebhookRequest => ({
  method: 'POST',
  raw_body: body,
  headers: new Map([
    ['content-type', [contentType]],
    ['x-slack-request-timestamp', [String(NOW_SECONDS)]],
    ['x-slack-signature', [signature(body)]],
  ]),
  raw_path_and_query: '/v1/webhooks/composed-json-form-fixture',
  canonical_public_url:
    'https://hooks.example.test/v1/webhooks/composed-json-form-fixture',
  received_at: NOW_MS,
  remote_ip: '127.0.0.1',
});

const eventBody = (): Buffer => Buffer.from(JSON.stringify({
  type: 'event_callback',
  event_id: 'Ev_composed_1',
  team_id: 'T_composed_1',
  event_time: NOW_SECONDS - 10,
  event: { type: 'message' },
}), 'utf8');

describe('D-201 Slice 9AD timestamped JSON/form single-event composition', () => {
  it('constructs only profiles with one complete compatible engine set', () => {
    const adapter = createTimestampedJsonFormSingleEventWebhookProfileAdapter(
      'slack.request.v0',
    );
    expect(adapter.profile_id).toBe('slack.request.v0');
    expect(adapter.success_response).toEqual({ status: 200 });
    expect(adapter.handleHandshake).toBeTypeOf('function');
    expect(adapter.buildTestDelivery).toBeUndefined();

    for (const profileId of [
      'generic.timestamped-raw-body-hmac-sha256.v1',
      'stripe.event.v1',
      'paddle.notification.v1',
      'slack.slash-command.v1',
    ] as const) {
      expect(() => createTimestampedJsonFormSingleEventWebhookProfileAdapter(
        profileId,
      )).toThrow('is unavailable');
      expect(() =>
        createTimestampedJsonFormSingleEventWebhookCredentialShapeValidator(
          profileId,
        )).toThrow('is unavailable');
    }
  });

  it('routes JSON, wrapped form JSON, and challenges through selected policy', async () => {
    const adapter = createTimestampedJsonFormSingleEventWebhookProfileAdapter(
      'slack.request.v0',
    );
    const body = eventBody();
    await expect(adapter.verifyAndDecode(request(body), context()))
      .resolves.toMatchObject({
        ok: true,
        delivery: {
          decoded_content_type: 'application/json',
          admission: {
            credential_version: '1',
            freshness_checked: true,
            method_label: 'slack-signature-v0',
          },
          events: [{
            provider_event_id: 'Ev_composed_1',
            provider_resource_id: 'T_composed_1',
            provider_event_type: 'event_callback',
            provider_occurred_at: (NOW_SECONDS - 10) * 1_000,
          }],
        },
      });

    const interactive = {
      type: 'block_actions',
      team: { id: 'T_composed_form' },
      actions: [{ action_id: 'approve' }],
    };
    const formBody = Buffer.from(
      `payload=${encodeURIComponent(JSON.stringify(interactive))}`,
      'utf8',
    );
    await expect(adapter.verifyAndDecode(request(
      formBody,
      'application/x-www-form-urlencoded; charset=utf-8',
    ), context())).resolves.toMatchObject({
      ok: true,
      delivery: {
        events: [{
          provider_event_id: null,
          provider_resource_id: 'T_composed_form',
          provider_event_type: 'block_actions',
          decoded_payload: interactive,
        }],
      },
    });

    const challengeBody = Buffer.from(JSON.stringify({
      type: 'url_verification',
      challenge: 'composed-challenge',
    }), 'utf8');
    await expect(adapter.handleHandshake!(
      request(challengeBody),
      context(),
    )).resolves.toMatchObject({
      readiness_proven: true,
      response: {
        status: 200,
        content_type: 'application/json',
        body: '{"challenge":"composed-challenge"}',
      },
      admission: { method_label: 'slack-signature-v0' },
    });
  });

  it('shares credential admission and keeps clock failure retryable', async () => {
    const validate =
      createTimestampedJsonFormSingleEventWebhookCredentialShapeValidator(
        'slack.request.v0',
      );
    expect(validate({ signing_secret: SECRET })).toBe(true);
    expect(validate({ signing_secret: SECRET, extra: 'authority' })).toBe(false);

    const unavailable: WebhookClockHealthAuthority = {
      check: async () => ({ healthy: false, reason: 'probe_unavailable' }),
    };
    const adapter =
      createClockGatedTimestampedJsonFormSingleEventWebhookProfileAdapter(
        'slack.request.v0',
        unavailable,
      );
    await expect(adapter.verifyAndDecode(
      request(eventBody()),
      context(() => {
        throw new Error('caller clock must remain unused');
      }),
    )).resolves.toEqual({
      ok: false,
      failure: {
        disposition: 'retry',
        code: 'profile_dependency_unavailable',
        response: { status: 503 },
      },
    });

    const challengeBody = Buffer.from(JSON.stringify({
      type: 'url_verification',
      challenge: 'clock-required',
    }), 'utf8');
    await expect(adapter.handleHandshake!(
      request(challengeBody),
      context(),
    )).rejects.toBeInstanceOf(WebhookProfileDependencyUnavailableError);
    await expect(adapter.handleHandshake!(
      request(challengeBody),
      context(),
    )).rejects.toThrow('Slack webhook trusted clock is unavailable');

    const pure = createTimestampedJsonFormSingleEventWebhookProfileAdapter(
      'slack.request.v0',
    );
    await expect(pure.handleHandshake!(
      request(challengeBody),
      { ...context(), credential_versions: [] },
    )).rejects.toThrow('Slack webhook profile credentials are unavailable');
  });

  it('mounts and validates the profile directly through neutral factories', () => {
    expect(createBuiltinWebhookDeliveryProfileAdapters(null)
      .map((adapter) => adapter.profile_id))
      .not.toContain('slack.request.v0');
    const mounted = createBuiltinWebhookDeliveryProfileAdapters(healthyClock)
      .filter((adapter) => adapter.profile_id === 'slack.request.v0');
    expect(mounted).toHaveLength(1);
    expect(mounted[0]).toMatchObject({
      profile_id: 'slack.request.v0',
      success_response: { status: 200 },
      verifyAndDecode: expect.any(Function),
      handleHandshake: expect.any(Function),
    });
    expect(mounted[0]?.buildTestDelivery).toBeUndefined();

    const policy = BUILTIN_WEBHOOK_PROFILE_POLICIES.get('slack.request.v0');
    expect(policy.validateCredentialShape({ signing_secret: SECRET })).toBe(true);
    expect(policy.validateCredentialShape({
      signing_secret: SECRET,
      ignored_authority: 'must fail closed',
    })).toBe(false);
  });
});
