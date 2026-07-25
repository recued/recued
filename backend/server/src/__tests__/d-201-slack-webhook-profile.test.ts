import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { startServer } from '../server.js';
import { createWebhookDeliveryStore } from '../storage/webhook-delivery-store.js';
import { createWebhookIngressStore } from '../storage/webhook-ingress-store.js';
import { createWebhookOutboxRuntime } from '../webhook-outbox-dispatcher.js';
import { createWebhookProfileListener } from '../webhook-profile-listener.js';
import {
  WebhookProfileDependencyUnavailableError,
  createWebhookProfileRuntimeRegistry,
  type RawWebhookRequest,
  type ResolvedWebhookCredentialVersion,
  type WebhookProfileResult,
  type WebhookProfileRuntimeContext,
} from '../webhook-profile-runtime.js';
import {
  createClockGatedSlackWebhookProfileAdapter,
  createSlackWebhookProfileAdapter,
  validateSlackWebhookCredentialShape,
} from '../webhook-slack-profile.js';
import type { WebhookClockHealthAuthority } from '../webhook-clock-health.js';

const NOW_MS = Date.parse('2026-07-11T22:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW_MS / 1_000);
const SECRET = 'slack-signing-secret-d201';

const slackBody = (overrides: Record<string, unknown> = {}): Buffer =>
  Buffer.from(JSON.stringify({
    type: 'event_callback',
    event_id: 'Ev_d201_slack_1',
    team_id: 'T_d201_slack',
    event_time: NOW_SECONDS - 20,
    event: { type: 'message', ts: `${NOW_SECONDS - 20}.000100` },
    ...overrides,
  }), 'utf8');

const slackSignature = (
  body: Buffer,
  secret = SECRET,
  timestamp: string | number = NOW_SECONDS,
): string => `v0=${createHmac('sha256', secret)
  .update(`v0:${timestamp}:`)
  .update(body)
  .digest('hex')}`;

const slackStableDedupKey = (stableId: string): string =>
  `slack:event:${createHash('sha256').update(stableId, 'utf8').digest('hex')}`;

const slackFallbackDedupKey = (
  timestamp: string,
  body: Buffer,
): string => `slack:request:${createHash('sha256')
  .update(timestamp, 'utf8')
  .update('\0', 'utf8')
  .update(body)
  .digest('hex')}`;

const credentialVersion = (
  version: number,
  signingSecret: string,
): ResolvedWebhookCredentialVersion => ({
  version: String(version),
  created_at: NOW_MS + version,
  credentials: { signing_secret: signingSecret },
});

const context = (input: {
  credentials?: readonly ResolvedWebhookCredentialVersion[];
  now?: () => number;
} = {}): WebhookProfileRuntimeContext => ({
  ingress_id: 'whi_d201slackprofilefixture1234567',
  environment: 'test',
  credential_versions: input.credentials ?? [credentialVersion(1, SECRET)],
  now: input.now ?? (() => NOW_MS),
});

const rawRequest = (input: {
  body?: Buffer;
  timestamp?: string | readonly string[];
  signature?: string | readonly string[];
  contentType?: string;
} = {}): RawWebhookRequest => {
  const body = input.body ?? slackBody();
  const timestamp = input.timestamp ?? String(NOW_SECONDS);
  const signature = input.signature ?? slackSignature(
    body,
    SECRET,
    Array.isArray(timestamp) ? timestamp[0]! : timestamp,
  );
  return {
    method: 'POST',
    raw_body: body,
    headers: new Map([
      ['content-type', [input.contentType ?? 'application/json; charset=utf-8']],
      ['x-slack-request-timestamp', typeof timestamp === 'string'
        ? [timestamp]
        : timestamp],
      ['x-slack-signature', typeof signature === 'string'
        ? [signature]
        : signature],
    ]),
    raw_path_and_query: '/v1/webhooks/slack-profile-fixture',
    canonical_public_url: 'https://hooks.example.test/v1/webhooks/slack-profile-fixture',
    received_at: NOW_MS,
    remote_ip: '127.0.0.1',
  };
};

const requireAccepted = (
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

describe('D-201 Slices 7D + 9AD Slack profile adapter', () => {
  it('authenticates exact bytes across rotation and projects one bounded JSON event', async () => {
    const adapter = createSlackWebhookProfileAdapter();
    const olderSecret = 'slack-signing-secret-older';
    const body = slackBody();
    const runtime = context({
      credentials: [
        credentialVersion(1, olderSecret),
        credentialVersion(2, SECRET),
      ],
    });
    const delivery = requireAccepted(await adapter.verifyAndDecode(
      rawRequest({
        body,
        signature: slackSignature(body, olderSecret),
      }),
      runtime,
    ));

    expect(delivery).toMatchObject({
      decoded_content_type: 'application/json',
      response: { status: 200 },
      admission: {
        transport_assurance: 'authenticated',
        credential_version: '1',
        freshness_checked: true,
        method_label: 'slack-signature-v0',
      },
      events: [{
        provider_event_id: 'Ev_d201_slack_1',
        provider_resource_id: 'T_d201_slack',
        provider_event_type: 'event_callback',
        provider_occurred_at: (NOW_SECONDS - 20) * 1_000,
        decoded_payload: JSON.parse(body.toString('utf8')),
      }],
    });
    expect(delivery.delivery_dedup_key)
      .toBe(slackStableDedupKey('Ev_d201_slack_1'));
    expect(delivery.events[0]?.event_dedup_key)
      .toBe(`${delivery.delivery_dedup_key}:0`);

    const leadingTimestamp = `0${NOW_SECONDS}`;
    const leadingDelivery = requireAccepted(await adapter.verifyAndDecode(
      rawRequest({
        body,
        timestamp: leadingTimestamp,
        signature: slackSignature(body, SECRET, leadingTimestamp),
      }),
      context(),
    ));
    expect(leadingDelivery.admission.credential_version).toBe('1');
    expect(leadingDelivery.delivery_dedup_key).toBe(delivery.delivery_dedup_key);
  });

  it('rejects changed bytes, ambiguous headers, stale timestamps, and malformed JSON', async () => {
    const adapter = createSlackWebhookProfileAdapter();
    const body = slackBody();
    const changed = slackBody({ event_id: 'Ev_changed' });
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      body: changed,
      signature: slackSignature(body),
    }), context()), 'authentication_failed', 401);
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      body,
      timestamp: [String(NOW_SECONDS), String(NOW_SECONDS)],
      signature: slackSignature(body),
    }), context()), 'authentication_failed', 401);
    const staleTimestamp = NOW_SECONDS - 301;
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      body,
      timestamp: String(staleTimestamp),
      signature: slackSignature(body, SECRET, staleTimestamp),
    }), context()), 'authentication_failed', 401);
    const suffixedTimestamp = `${NOW_SECONDS}junk`;
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      body,
      timestamp: suffixedTimestamp,
      signature: slackSignature(body, SECRET, suffixedTimestamp),
    }), context()), 'authentication_failed', 401);
    const malformed = Buffer.from('{"type":"event_callback"', 'utf8');
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      body: malformed,
      signature: slackSignature(malformed),
    }), context()), 'structural_admission_failed', 400);
    const conflictingTeam = slackBody({
      team_id: 'T_top_level',
      team: { id: 'T_nested' },
    });
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      body: conflictingTeam,
      signature: slackSignature(conflictingTeam),
    }), context()), 'structural_admission_failed', 400);
    const missingCallbackEvent = slackBody({ event: undefined });
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      body: missingCallbackEvent,
      signature: slackSignature(missingCallbackEvent),
    }), context()), 'structural_admission_failed', 400);
    const nonCallbackWithoutEvent = slackBody({
      type: 'block_actions',
      event: undefined,
    });
    expect(requireAccepted(await adapter.verifyAndDecode(rawRequest({
      body: nonCallbackWithoutEvent,
      signature: slackSignature(nonCallbackWithoutEvent),
    }), context())).events[0]?.provider_event_type).toBe('block_actions');
  });

  it('decodes bounded interactive payload and slash-command forms after signature verification', async () => {
    const adapter = createSlackWebhookProfileAdapter();
    const interactivePayload = {
      type: 'block_actions',
      team: { id: 'T_d201_interactive' },
      trigger_id: 'trigger-interactive-1',
      actions: [{ action_id: 'approve', value: 'yes' }],
    };
    const interactiveBody = Buffer.from(
      `payload=${encodeURIComponent(JSON.stringify(interactivePayload))}`,
      'utf8',
    );
    const interactive = requireAccepted(await adapter.verifyAndDecode(rawRequest({
      body: interactiveBody,
      signature: slackSignature(interactiveBody),
      contentType: 'application/x-www-form-urlencoded',
    }), context()));
    expect(interactive.events[0]).toMatchObject({
      provider_event_id: null,
      provider_resource_id: 'T_d201_interactive',
      provider_event_type: 'block_actions',
      decoded_payload: interactivePayload,
    });
    expect(interactive.delivery_dedup_key).toBe(slackFallbackDedupKey(
      String(NOW_SECONDS),
      interactiveBody,
    ));
    expect(interactive.events[0]?.event_dedup_key)
      .toBe(`${interactive.delivery_dedup_key}:0`);

    const leadingInteractiveTimestamp = `0${NOW_SECONDS}`;
    const leadingInteractive = requireAccepted(await adapter.verifyAndDecode(
      rawRequest({
        body: interactiveBody,
        timestamp: leadingInteractiveTimestamp,
        signature: slackSignature(
          interactiveBody,
          SECRET,
          leadingInteractiveTimestamp,
        ),
        contentType: 'application/x-www-form-urlencoded',
      }),
      context(),
    ));
    expect(leadingInteractive.delivery_dedup_key).toBe(slackFallbackDedupKey(
      leadingInteractiveTimestamp,
      interactiveBody,
    ));
    expect(leadingInteractive.delivery_dedup_key)
      .not.toBe(interactive.delivery_dedup_key);

    const slashBody = Buffer.from(
      'command=%2Frecued&team_id=T_d201_command&trigger_id=trigger-command-1&text=hello+world',
      'utf8',
    );
    const slash = requireAccepted(await adapter.verifyAndDecode(rawRequest({
      body: slashBody,
      signature: slackSignature(slashBody),
      contentType: 'application/x-www-form-urlencoded; charset=utf-8',
    }), context()));
    expect(slash.events[0]).toMatchObject({
      provider_event_id: 'trigger-command-1',
      provider_resource_id: 'T_d201_command',
      provider_event_type: 'slash_command',
      decoded_payload: {
        type: 'slash_command',
        command: '/recued',
        team_id: 'T_d201_command',
        trigger_id: 'trigger-command-1',
        text: 'hello world',
      },
    });
    expect(slash.delivery_dedup_key)
      .toBe(slackStableDedupKey('trigger-command-1'));
    expect(slash.events[0]?.event_dedup_key)
      .toBe(`${slash.delivery_dedup_key}:0`);

    const duplicatePayload = Buffer.from('payload=%7B%7D&payload=%7B%7D', 'utf8');
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      body: duplicatePayload,
      signature: slackSignature(duplicatePayload),
      contentType: 'application/x-www-form-urlencoded',
    }), context()), 'structural_admission_failed', 400);
    const ambiguousWrappedPayload = Buffer.from(
      'payload=%7B%22type%22%3A%22block_actions%22%7D&extra=shadowed',
      'utf8',
    );
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      body: ambiguousWrappedPayload,
      signature: slackSignature(ambiguousWrappedPayload),
      contentType: 'application/x-www-form-urlencoded',
    }), context()), 'structural_admission_failed', 400);
    const malformedEscape = Buffer.from(
      'command=%ZZ&team_id=T1&trigger_id=trigger-1',
      'utf8',
    );
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      body: malformedEscape,
      signature: slackSignature(malformedEscape),
      contentType: 'application/x-www-form-urlencoded',
    }), context()), 'structural_admission_failed', 400);
    for (const reservedField of ['type', 'event_id', 'event_time', 'challenge']) {
      const ambiguousBody = Buffer.from(
        `command=%2Frecued&team_id=T1&trigger_id=trigger-1&${reservedField}=shadowed`,
        'utf8',
      );
      expectFailure(await adapter.verifyAndDecode(rawRequest({
        body: ambiguousBody,
        signature: slackSignature(ambiguousBody),
        contentType: 'application/x-www-form-urlencoded',
      }), context()), 'structural_admission_failed', 400);
    }
    for (const invalidFlatBody of [
      'command=recued&team_id=T1&trigger_id=trigger-1',
      'command=%2Fbad%3F&team_id=T1&trigger_id=trigger-1',
      'command=%2Frecued&team_id=T1',
      'command=%2Frecued&team_id=+T1+&trigger_id=trigger-1',
    ].map((value) => Buffer.from(value, 'utf8'))) {
      expectFailure(await adapter.verifyAndDecode(rawRequest({
        body: invalidFlatBody,
        signature: slackSignature(invalidFlatBody),
        contentType: 'application/x-www-form-urlencoded',
      }), context()), 'structural_admission_failed', 400);
    }
  });

  it('requires one exact signing-secret field and at most two active versions', async () => {
    expect(validateSlackWebhookCredentialShape({ signing_secret: SECRET })).toBe(true);
    expect(validateSlackWebhookCredentialShape({
      signing_secret: SECRET,
      ignored_secret: 'must-fail',
    })).toBe(false);
    const inherited = Object.create({ signing_secret: SECRET }) as Record<string, string>;
    expect(validateSlackWebhookCredentialShape(inherited)).toBe(false);

    const body = slackBody();
    expectFailure(await createSlackWebhookProfileAdapter().verifyAndDecode(
      rawRequest({ body, signature: slackSignature(body) }),
      context({
        credentials: [
          credentialVersion(1, 'slack-secret-one'),
          credentialVersion(2, 'slack-secret-two'),
          credentialVersion(3, SECRET),
        ],
      }),
    ), 'profile_internal_error', 503);
  });

  it('echoes only an authenticated bounded URL-verification challenge', async () => {
    const adapter = createSlackWebhookProfileAdapter();
    const challenge = 'd201-slack-url-verification';
    const body = slackBody({
      type: 'url_verification',
      challenge,
      event_id: undefined,
      team_id: undefined,
      event_time: undefined,
      event: undefined,
    });
    const request = rawRequest({ body, signature: slackSignature(body) });

    await expect(adapter.handleHandshake!(request, context())).resolves.toEqual({
      response: {
        status: 200,
        content_type: 'application/json',
        body: JSON.stringify({ challenge }),
      },
      readiness_proven: true,
      admission: {
        transport_assurance: 'authenticated',
        credential_version: '1',
        freshness_checked: true,
        method_label: 'slack-signature-v0',
      },
    });
    await expect(adapter.handleHandshake!(request, context())).resolves.toMatchObject({
      readiness_proven: true,
    });
    await expect(adapter.handleHandshake!(rawRequest({
      body,
      signature: slackSignature(body, 'wrong-slack-secret'),
    }), context())).resolves.toBeNull();
    await expect(adapter.handleHandshake!(rawRequest(), context())).resolves.toBeNull();
    expectFailure(await adapter.verifyAndDecode(request, context()),
      'structural_admission_failed', 400);

    const malformedChallengeBody = slackBody({
      type: 'url_verification',
      challenge: undefined,
      event_id: undefined,
      team_id: undefined,
      event_time: undefined,
      event: undefined,
    });
    await expect(adapter.handleHandshake!(rawRequest({
      body: malformedChallengeBody,
      signature: slackSignature(malformedChallengeBody),
    }), context())).resolves.toBeNull();
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      body: malformedChallengeBody,
      signature: slackSignature(malformedChallengeBody),
    }), context()), 'structural_admission_failed', 400);

    const maximumChallenge = 'c'.repeat(4_096);
    const maximumChallengeBody = slackBody({
      type: 'url_verification',
      challenge: maximumChallenge,
      event_id: undefined,
      team_id: undefined,
      event_time: undefined,
      event: undefined,
    });
    await expect(adapter.handleHandshake!(rawRequest({
      body: maximumChallengeBody,
      signature: slackSignature(maximumChallengeBody),
    }), context())).resolves.toMatchObject({
      response: { body: JSON.stringify({ challenge: maximumChallenge }) },
      readiness_proven: true,
    });
    const oversizedChallengeBody = slackBody({
      type: 'url_verification',
      challenge: 'c'.repeat(4_097),
      event_id: undefined,
      team_id: undefined,
      event_time: undefined,
      event: undefined,
    });
    await expect(adapter.handleHandshake!(rawRequest({
      body: oversizedChallengeBody,
      signature: slackSignature(oversizedChallengeBody),
    }), context())).resolves.toBeNull();
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      body: oversizedChallengeBody,
      signature: slackSignature(oversizedChallengeBody),
    }), context()), 'structural_admission_failed', 400);
  });

  it('uses only authority time and classifies an unavailable handshake clock retryably', async () => {
    const checks = [
      {
        healthy: true as const,
        trusted_now_ms: NOW_MS,
        maximum_error_ms: 1_000,
        checked_at: NOW_MS,
      },
      { healthy: false as const, reason: 'probe_unavailable' as const },
      {
        healthy: true as const,
        trusted_now_ms: NOW_MS,
        maximum_error_ms: 1_000,
        checked_at: NOW_MS,
      },
      {
        healthy: true as const,
        trusted_now_ms: NOW_MS,
        maximum_error_ms: 1_000,
        checked_at: NOW_MS,
      },
      { healthy: false as const, reason: 'probe_unavailable' as const },
    ];
    const authority: WebhookClockHealthAuthority = {
      check: async () => checks.shift()!,
    };
    const adapter = createClockGatedSlackWebhookProfileAdapter(authority);
    const untrustedLocalClock = context({ now: () => NOW_MS - 86_400_000 });
    await expect(adapter.handleHandshake!(rawRequest(), untrustedLocalClock))
      .resolves.toBeNull();
    expect(checks).toHaveLength(5);

    const malformedChallengeBody = slackBody({
      type: 'url_verification',
      challenge: undefined,
      event_id: undefined,
      team_id: undefined,
      event_time: undefined,
      event: undefined,
    });
    await expect(adapter.handleHandshake!(rawRequest({
      body: malformedChallengeBody,
      signature: slackSignature(malformedChallengeBody),
    }), untrustedLocalClock)).resolves.toBeNull();
    expect(checks).toHaveLength(4);
    await expect(adapter.handleHandshake!(rawRequest({
      body: malformedChallengeBody,
      signature: slackSignature(malformedChallengeBody),
    }), untrustedLocalClock)).rejects.toBeInstanceOf(
      WebhookProfileDependencyUnavailableError,
    );
    expect(checks).toHaveLength(3);

    const challengeBody = slackBody({
      type: 'url_verification',
      challenge: 'trusted-clock-challenge',
      event_id: undefined,
      team_id: undefined,
      event_time: undefined,
      event: undefined,
    });
    await expect(adapter.handleHandshake!(rawRequest({
      body: challengeBody,
      signature: slackSignature(challengeBody),
    }), untrustedLocalClock)).resolves.toMatchObject({ readiness_proven: true });
    expect(requireAccepted(await adapter.verifyAndDecode(
      rawRequest(),
      untrustedLocalClock,
    )).admission.freshness_checked).toBe(true);
    await expect(adapter.handleHandshake!(rawRequest({
      body: challengeBody,
      signature: slackSignature(challengeBody),
    }), untrustedLocalClock)).rejects.toBeInstanceOf(
      WebhookProfileDependencyUnavailableError,
    );
    expect(checks).toHaveLength(0);
  });

  it('moves a signed handshake to repeat-safe readiness, then durably deduplicates enabled events', async () => {
    const db = new Database(':memory:');
    const ingressStore = createWebhookIngressStore(db, {
      now: () => NOW_MS,
      getEncryptionKey: () => new Uint8Array(32).fill(41),
    });
    const created = ingressStore.create({
      display_name: 'Durable Slack fixture',
      profile_id: 'slack.request.v0',
      environment: 'test',
      paired_connection_id: null,
      registration_mode: 'manual',
      selected_event_types: ['event_callback'],
    });
    await ingressStore.writeCredentialVersion(created.ingress_id, {
      signing_secret: SECRET,
    });
    const endpoint = `https://hooks.example.test/v1/webhooks/${created.public_id}`;
    ingressStore.confirmManualRegistration(created.ingress_id, {
      requires_handshake: true,
      endpoint_url: endpoint,
    });
    const deliveryStore = createWebhookDeliveryStore(db, {
      now: () => NOW_MS,
      getEncryptionKey: () => new Uint8Array(32).fill(42),
      hasDispatchTarget: () => true,
    });
    const dispatched: string[] = [];
    const outbox = createWebhookOutboxRuntime(deliveryStore, {
      dispatch: async (event) => {
        dispatched.push(event.idempotency_key);
      },
    }, { poll_interval_ms: 60_000 });
    const listener = createWebhookProfileListener({
      ingressStore,
      deliveryStore,
      profiles: createWebhookProfileRuntimeRegistry([
        createSlackWebhookProfileAdapter(),
      ]),
      isOutboxDispatcherStarted: outbox.isStarted,
      resolveCanonicalPublicUrl: () => endpoint,
      onHandshakeReadinessProven: (ingressId) => {
        ingressStore.confirmHandshakeReadiness(ingressId);
      },
      now: () => NOW_MS,
    });
    const server = await startServer(0, { webhookProfileListener: listener });
    outbox.start();

    const send = (body: Buffer): Promise<{ status: number; body: string }> => new Promise(
      (resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: server.port,
          path: `/v1/webhooks/${created.public_id}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': body.byteLength,
            'X-Slack-Request-Timestamp': String(NOW_SECONDS),
            'X-Slack-Signature': slackSignature(body),
          },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }));
        });
        req.on('error', reject);
        req.end(body);
      },
    );

    const challenge = 'repeat-safe-slack-challenge';
    const challengeBody = slackBody({
      type: 'url_verification',
      challenge,
      event_id: undefined,
      team_id: undefined,
      event_time: undefined,
      event: undefined,
    });
    const eventBody = slackBody();
    try {
      await expect(send(challengeBody)).resolves.toEqual({
        status: 200,
        body: JSON.stringify({ challenge }),
      });
      expect(ingressStore.get(created.ingress_id)?.intake_state).toBe('ready');
      await expect(send(challengeBody)).resolves.toEqual({
        status: 200,
        body: JSON.stringify({ challenge }),
      });
      await expect(send(eventBody)).resolves.toMatchObject({ status: 404 });

      ingressStore.enable(created.ingress_id);
      await expect(send(eventBody)).resolves.toEqual({ status: 200, body: '' });
      await expect(send(eventBody)).resolves.toEqual({ status: 200, body: '' });
      expect(deliveryStore.listDeliveries(created.ingress_id)).toHaveLength(1);
      expect(deliveryStore.listEvents(created.ingress_id)).toEqual([
        expect.objectContaining({
          provider_event_id: 'Ev_d201_slack_1',
          provider_event_type: 'event_callback',
          dispatch_state: 'pending',
        }),
      ]);
      expect(deliveryStore.listOutbox()).toHaveLength(1);
      await outbox.drainOnce();
      expect(dispatched).toEqual([
        deliveryStore.listEvents(created.ingress_id)[0]!.event_id,
      ]);
    } finally {
      await server.close();
      await outbox.stop();
      db.close();
    }
  });
});
