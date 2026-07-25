import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { WebhookClockHealthAuthority } from '../webhook-clock-health.js';
import {
  createClockGatedTimestampedFormWebhookProfileAdapter,
  createTimestampedFormWebhookProfileAdapter,
} from '../webhook-timestamped-form-profile.js';
import {
  createWebhookProfileRuntimeRegistry,
  type RawWebhookRequest,
  type ResolvedWebhookCredentialVersion,
  type WebhookProfileResult,
  type WebhookProfileRuntimeContext,
} from '../webhook-profile-runtime.js';

const NOW_MS = Date.parse('2026-07-12T17:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW_MS / 1_000);
const SECRET = 'slack-signing-secret-d201-8x';
const TRIGGER_ID = '13345224609.738474920.8088930838d88f008e0';

const commandBody = Buffer.from([
  'token=legacy-verification-token',
  'team_id=T_D201_8X',
  'team_domain=example',
  'channel_id=C_D201_8X',
  'user_id=U_D201_8X',
  'command=%2Fdeploy',
  'text=production+carefully',
  `response_url=${encodeURIComponent('https://hooks.slack.com/commands/T/C/bearer')}`,
  `trigger_id=${TRIGGER_ID}`,
  'api_app_id=A_D201_8X',
].join('&'), 'utf8');

const signature = (
  body: Buffer,
  timestamp = String(NOW_SECONDS),
  secret = SECRET,
): string => `v0=${createHmac('sha256', secret)
  .update(`v0:${timestamp}:`)
  .update(body)
  .digest('hex')}`;

const credentialVersion = (
  version: number,
  credentials: Record<string, string> = { signing_secret: SECRET },
): ResolvedWebhookCredentialVersion => ({
  version: String(version),
  created_at: NOW_MS + version,
  credentials,
});

const context = (
  versions: readonly ResolvedWebhookCredentialVersion[] = [credentialVersion(1)],
  now: () => number = () => NOW_MS,
): WebhookProfileRuntimeContext => ({
  ingress_id: 'whi_d201_8x_timestamped_form',
  environment: 'test',
  credential_versions: versions,
  now,
});

const request = (input: {
  body?: Buffer;
  timestamp?: string;
  presentedSignature?: string;
  contentType?: string | readonly string[];
} = {}): RawWebhookRequest => {
  const body = input.body ?? commandBody;
  const timestamp = input.timestamp ?? String(NOW_SECONDS);
  const presentedSignature = input.presentedSignature
    ?? signature(body, timestamp);
  const contentType = input.contentType
    ?? 'application/x-www-form-urlencoded; charset=utf-8';
  return {
    method: 'POST',
    raw_body: body,
    headers: new Map([
      ['content-type', typeof contentType === 'string'
        ? [contentType]
        : contentType],
      ['x-slack-request-timestamp', [timestamp]],
      ['x-slack-signature', [presentedSignature]],
    ]),
    raw_path_and_query: '/v1/webhooks/d201-8x',
    canonical_public_url: 'https://hooks.example.test/v1/webhooks/d201-8x',
    received_at: NOW_MS,
    remote_ip: '127.0.0.1',
  };
};

const accepted = (
  result: WebhookProfileResult,
): Extract<WebhookProfileResult, { ok: true }>['delivery'] => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected acceptance, got ${result.failure.code}`);
  return result.delivery;
};

const expectFailure = (
  result: WebhookProfileResult,
  code: Extract<WebhookProfileResult, { ok: false }>['failure']['code'],
  status: number,
): void => {
  expect(result).toEqual({
    ok: false,
    failure: {
      disposition: code === 'profile_internal_error'
        || code === 'profile_dependency_unavailable'
        ? 'retry'
        : 'reject',
      code,
      response: { status },
    },
  });
};

describe('D-201 Slice 8X neutral timestamped form profile', () => {
  it('authenticates exact form bytes and withholds embedded callback authority', async () => {
    const adapter = createTimestampedFormWebhookProfileAdapter(
      'slack.slash-command.v1',
    );
    expect(adapter.profile_id).toBe('slack.slash-command.v1');
    expect(adapter.handleHandshake).toBeUndefined();
    expect(adapter.buildTestDelivery).toBeUndefined();
    expect(createWebhookProfileRuntimeRegistry([adapter]).get(adapter.profile_id))
      .not.toBeNull();

    const delivery = accepted(await adapter.verifyAndDecode(
      request(),
      context(),
    ));
    const digest = createHash('sha256').update(TRIGGER_ID, 'utf8').digest('hex');
    expect(delivery).toMatchObject({
      delivery_dedup_key: `slack:slash-command:${digest}`,
      decoded_content_type: 'application/x-www-form-urlencoded',
      response: { status: 200 },
      admission: {
        transport_assurance: 'authenticated',
        credential_version: '1',
        freshness_checked: true,
        method_label: 'timestamped-hmac-sha256',
      },
      events: [{
        event_dedup_key: `slack:slash-command:${digest}:0`,
        provider_event_id: TRIGGER_ID,
        provider_resource_id: 'T_D201_8X',
        provider_event_type: 'slash_command',
        provider_occurred_at: null,
        decoded_payload: {
          type: 'slash_command',
          team_id: 'T_D201_8X',
          team_domain: 'example',
          channel_id: 'C_D201_8X',
          user_id: 'U_D201_8X',
          command: '/deploy',
          text: 'production carefully',
          trigger_id: TRIGGER_ID,
          api_app_id: 'A_D201_8X',
        },
      }],
    });
    const payload = delivery.events[0]!.decoded_payload as Record<string, unknown>;
    expect(Object.getPrototypeOf(payload)).toBeNull();
    expect(Object.isFrozen(payload)).toBe(true);
    expect(payload).not.toHaveProperty('response_url');
    expect(payload).not.toHaveProperty('token');
  });

  it('fails closed for changed bytes, wrong media, ssl_check, and credential widening', async () => {
    const adapter = createTimestampedFormWebhookProfileAdapter(
      'slack.slash-command.v1',
    );
    const changed = Buffer.from(`${commandBody.toString('utf8')}&extra=changed`, 'utf8');
    expectFailure(await adapter.verifyAndDecode(request({
      body: changed,
      presentedSignature: signature(commandBody),
    }), context()), 'authentication_failed', 401);

    const staleTimestamp = String(NOW_SECONDS - 301);
    expectFailure(await adapter.verifyAndDecode(request({
      timestamp: staleTimestamp,
      presentedSignature: signature(commandBody, staleTimestamp),
    }), context()), 'authentication_failed', 401);

    for (const contentType of [
      'application/json',
      ['application/x-www-form-urlencoded', 'application/x-www-form-urlencoded'],
    ] as const) {
      expectFailure(await adapter.verifyAndDecode(request({ contentType }), context()),
        'structural_admission_failed', 400);
    }

    for (const body of [
      Buffer.from('ssl_check=1&token=legacy-verification-token', 'utf8'),
      Buffer.from(`${commandBody.toString('utf8')}&ssl_check=1`, 'utf8'),
    ]) {
      expectFailure(await adapter.verifyAndDecode(request({ body }), context()),
        'structural_admission_failed', 400);
    }

    expectFailure(await adapter.verifyAndDecode(request(), context([
      credentialVersion(1, {
        signing_secret: SECRET,
        ignored_authority: 'must-fail',
      }),
    ])), 'profile_internal_error', 503);
    expect(() => createTimestampedFormWebhookProfileAdapter('slack.request.v0'))
      .toThrow("webhook timestamped form profile 'slack.request.v0' is unavailable");
  });

  it('uses only a healthy bounded clock authority in production composition', async () => {
    const unavailable: WebhookClockHealthAuthority = {
      check: async () => ({ healthy: false, reason: 'probe_unavailable' }),
    };
    const unavailableAdapter =
      createClockGatedTimestampedFormWebhookProfileAdapter(
        'slack.slash-command.v1',
        unavailable,
      );
    expectFailure(await unavailableAdapter.verifyAndDecode(
      request(),
      context([], () => { throw new Error('caller clock must not run'); }),
    ), 'profile_dependency_unavailable', 503);

    const healthy: WebhookClockHealthAuthority = {
      check: async () => ({
        healthy: true,
        trusted_now_ms: NOW_MS,
        maximum_error_ms: 1_000,
        checked_at: NOW_MS,
      }),
    };
    const healthyAdapter = createClockGatedTimestampedFormWebhookProfileAdapter(
      'slack.slash-command.v1',
      healthy,
    );
    expect(accepted(await healthyAdapter.verifyAndDecode(
      request(),
      context([credentialVersion(1)], () => {
        throw new Error('caller clock must not run');
      }),
    )).events).toHaveLength(1);
  });
});
