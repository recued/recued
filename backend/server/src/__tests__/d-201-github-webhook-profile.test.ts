import { createHmac } from 'node:crypto';
import http from 'node:http';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { startServer } from '../server.js';
import {
  GITHUB_DELIVERY_HEADER,
  GITHUB_EVENT_HEADER,
  GITHUB_HOOK_ID_HEADER,
  GITHUB_SIGNATURE_HEADER,
  verifyGitHubWebhookSignature,
} from '../connections/providers/github-webhook-protocol.js';
import { createWebhookDeliveryStore } from '../storage/webhook-delivery-store.js';
import { createWebhookIngressStore } from '../storage/webhook-ingress-store.js';
import { createWebhookOutboxRuntime } from '../webhook-outbox-dispatcher.js';
import { createWebhookProfileListener } from '../webhook-profile-listener.js';
import {
  createWebhookProfileRuntimeRegistry,
  type RawWebhookRequest,
  type ResolvedWebhookCredentialVersion,
  type WebhookProfileResult,
  type WebhookProfileRuntimeContext,
} from '../webhook-profile-runtime.js';
import {
  createGitHubWebhookProfileAdapter,
  GITHUB_DELIVERY_ID_PARSER_PRESET,
  GITHUB_EVENT_TYPE_PARSER_PRESET,
  GITHUB_HOOK_ID_PARSER_PRESET,
  GITHUB_METADATA_PAYLOAD_EVENT_NORMALIZER_PRESET,
  GITHUB_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET,
  GITHUB_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET,
  GITHUB_RAW_HEADER_METADATA_NORMALIZER_PRESET,
  GITHUB_RAW_HEADER_JSON_SINGLE_EVENT_TEST_ENVELOPE_PRESET,
  validateGitHubWebhookCredentialShape,
} from '../webhook-github-profile.js';
import {
  createWebhookCanonicalUuidParser,
} from '../webhook-canonical-uuid-parser.js';
import {
  createWebhookLowercaseIdentifierEventTypeParser,
} from '../webhook-lowercase-identifier-event-type-parser.js';
import {
  createWebhookPositiveDecimalIdentifierParser,
} from '../webhook-positive-decimal-identifier-parser.js';

const NOW_MS = Date.parse('2026-07-11T23:30:00.000Z');
const SECRET = 'A'.repeat(43);
const OLDER_SECRET = 'B'.repeat(43);
const DELIVERY_ID = '72d3162e-cc78-11e3-81ab-4c9367dc0958';

const githubBody = (
  action = 'opened',
): Buffer => Buffer.from(JSON.stringify({
  action,
  issue: {
    id: 1_347,
    number: 81,
    title: 'Webhook profile fixture',
  },
  repository: {
    id: 1_296_269,
    full_name: 'octocat/Hello-World',
  },
  sender: { id: 1, login: 'octocat' },
}), 'utf8');

const signatureFor = (body: Buffer, secret = SECRET): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

const credentialVersion = (
  version: number,
  webhookSecret: string,
): ResolvedWebhookCredentialVersion => ({
  version: String(version),
  created_at: NOW_MS + version,
  credentials: { webhook_secret: webhookSecret },
});

const context = (input: {
  environment?: 'test' | 'live' | 'custom';
  credentials?: readonly ResolvedWebhookCredentialVersion[];
  now?: () => number;
} = {}): WebhookProfileRuntimeContext => ({
  ingress_id: 'whi_d201githubprofilefixture1234',
  environment: input.environment ?? 'test',
  credential_versions: input.credentials ?? [credentialVersion(1, SECRET)],
  now: input.now ?? (() => NOW_MS),
});

const headerValues = (
  value: string | readonly string[],
): readonly string[] => typeof value === 'string' ? [value] : value;

const rawRequest = (input: {
  body?: Buffer;
  signature?: string | readonly string[];
  signatureSecret?: string;
  deliveryId?: string | readonly string[];
  eventType?: string | readonly string[];
  hookId?: string | readonly string[];
} = {}): RawWebhookRequest => {
  const body = input.body ?? githubBody();
  const signature = input.signature
    ?? signatureFor(body, input.signatureSecret ?? SECRET);
  return {
    method: 'POST',
    raw_body: body,
    headers: new Map([
      ['content-type', ['application/json']],
      [GITHUB_SIGNATURE_HEADER, headerValues(signature)],
      [GITHUB_DELIVERY_HEADER, headerValues(input.deliveryId ?? DELIVERY_ID)],
      [GITHUB_EVENT_HEADER, headerValues(input.eventType ?? 'issues')],
      [GITHUB_HOOK_ID_HEADER, headerValues(input.hookId ?? '292430182')],
    ]),
    raw_path_and_query: '/v1/webhooks/github-profile-fixture',
    canonical_public_url:
      'https://hooks.example.test/v1/webhooks/github-profile-fixture',
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
      disposition: code === 'profile_internal_error' ? 'retry' : 'reject',
      code,
      response: { status },
    },
  });
};

describe('D-201 Slices 8A + 8C + 9P-9W GitHub webhook profile adapter', () => {
  it('matches GitHub official exact-byte HMAC-SHA256 fixture only', () => {
    const secret = "It's a Secret to Everybody";
    const body = Buffer.from('Hello, World!', 'utf8');
    const signature =
      'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
    expect(verifyGitHubWebhookSignature({
      signature,
      raw_body: body,
      webhook_secret: secret,
    })).toBe(true);
    expect(verifyGitHubWebhookSignature({
      signature,
      raw_body: Buffer.from('Hello, World!\n', 'utf8'),
      webhook_secret: secret,
    })).toBe(false);
    expect(verifyGitHubWebhookSignature({
      signature: signature.toUpperCase(),
      raw_body: body,
      webhook_secret: secret,
    })).toBe(false);
    expect(verifyGitHubWebhookSignature({
      signature: signature.replace('sha256=', 'sha1='),
      raw_body: body,
      webhook_secret: secret,
    })).toBe(false);

    const exactJson = Buffer.from('{"message":"café","order":[1,2]}', 'utf8');
    const exactSignature = signatureFor(exactJson);
    for (const mutation of [
      Buffer.from('{ "message":"café","order":[1,2]}', 'utf8'),
      Buffer.from('{"order":[1,2],"message":"café"}', 'utf8'),
      Buffer.from('{"message":"caf\\u00e9","order":[1,2]}', 'utf8'),
    ]) {
      expect(verifyGitHubWebhookSignature({
        signature: exactSignature,
        raw_body: mutation,
        webhook_secret: SECRET,
      })).toBe(false);
    }
  });

  it('authenticates rotation and projects bounded GitHub delivery metadata without a clock', async () => {
    const body = githubBody();
    const adapter = createGitHubWebhookProfileAdapter();
    const delivery = requireAccepted(await adapter.verifyAndDecode(rawRequest({
      body,
      signatureSecret: OLDER_SECRET,
    }), context({
      credentials: [
        credentialVersion(1, OLDER_SECRET),
        credentialVersion(2, SECRET),
      ],
      now: () => {
        throw new Error('GitHub raw-HMAC verification must not read time');
      },
    })));

    expect(delivery).toMatchObject({
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
        decoded_payload: JSON.parse(body.toString('utf8')),
      }],
    });
    expect(delivery.delivery_dedup_key).toBe(
      'github:delivery:'
      + '9514e6751b793abb198c32e333740b61b580a65d749f15221ae766d020e698c4',
    );
    expect(delivery.events[0]?.event_dedup_key)
      .toBe(`${delivery.delivery_dedup_key}:0`);

    expect(GITHUB_DELIVERY_ID_PARSER_PRESET).toEqual({
      kind: 'canonical_uuid_hex.v1',
    });
    expect(GITHUB_EVENT_TYPE_PARSER_PRESET).toEqual({
      kind: 'lowercase_identifier_event_type.v1',
      max_characters: 128,
    });
    expect(GITHUB_HOOK_ID_PARSER_PRESET).toEqual({
      kind: 'positive_decimal_identifier.v1',
      max_digits: 32,
    });
    expect(GITHUB_RAW_HEADER_METADATA_NORMALIZER_PRESET).toEqual({
      kind: 'raw_header_single_event_metadata.v1',
      delivery_id_header: GITHUB_DELIVERY_HEADER,
      event_type_header: GITHUB_EVENT_HEADER,
      structural_evidence_header: GITHUB_HOOK_ID_HEADER,
    });
    expect(GITHUB_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET).toEqual({
      kind: 'normalized_required_single_id_sha256.v1',
      stable_id_field: 'delivery_id',
      stable_id_prefix: 'github:delivery:',
    });
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
    const uppercaseDelivery = requireAccepted(await adapter.verifyAndDecode(
      rawRequest({
        body,
        deliveryId: DELIVERY_ID.toUpperCase(),
      }),
      context(),
    ));
    expect(uppercaseDelivery.delivery_dedup_key)
      .toBe(delivery.delivery_dedup_key);
    expect(uppercaseDelivery.events[0]?.provider_event_id).toBe(DELIVERY_ID);

    const changedMetadata = requireAccepted(await adapter.verifyAndDecode(rawRequest({
      body,
      deliveryId: '0b989ba4-242f-11e5-81e1-c7b6966d2516',
      eventType: 'pull_request',
      hookId: '292430183',
    }), context()));
    expect(changedMetadata.delivery_dedup_key).not.toBe(delivery.delivery_dedup_key);
    expect(changedMetadata.events[0]?.event_dedup_key)
      .not.toBe(delivery.events[0]?.event_dedup_key);

    const changedBody = githubBody('closed');
    const reusedGuid = requireAccepted(await adapter.verifyAndDecode(rawRequest({
      body: changedBody,
    }), context()));
    expect(reusedGuid.delivery_dedup_key).toBe(delivery.delivery_dedup_key);
    expect(reusedGuid.events[0]?.event_dedup_key)
      .toBe(delivery.events[0]?.event_dedup_key);
  });

  it('builds one nonce-bearing selected test event without verifying a rotated secret', async () => {
    const adapter = createGitHubWebhookProfileAdapter();
    const nonce = 'd'.repeat(64);
    const runtime = context({
      credentials: [
        credentialVersion(1, OLDER_SECRET),
        credentialVersion(2, SECRET),
      ],
      now: () => {
        throw new Error('GitHub test delivery must not read a clock');
      },
    });
    const built = await adapter.buildTestDelivery!({
      nonce,
      selected_event_types: ['issues', 'pull_request'],
    }, runtime);

    expect(built.raw_body.toString('utf8')).toBe(JSON.stringify({
      action: 'recued_test_delivery',
      hook: { id: 1, type: 'Repository', active: true },
      repository: { id: 1, full_name: 'recued/test-delivery' },
      sender: { id: 1, login: 'recued-test-delivery', type: 'Bot' },
      recued_test_delivery: { nonce },
    }));
    expect(built.raw_body.toString('utf8')).not.toContain(SECRET);
    expect(JSON.parse(built.raw_body.toString('utf8'))).toMatchObject({
      action: 'recued_test_delivery',
      hook: { id: 1, type: 'Repository', active: true },
      repository: { id: 1, full_name: 'recued/test-delivery' },
      sender: { id: 1, login: 'recued-test-delivery', type: 'Bot' },
      recued_test_delivery: { nonce },
    });
    const deliveryId = built.headers[GITHUB_DELIVERY_HEADER]!;
    expect(deliveryId).toBe('98cd051b-a930-4d30-8ded-92b45f603dce');
    expect(createWebhookCanonicalUuidParser(
      GITHUB_DELIVERY_ID_PARSER_PRESET,
    ).parse(deliveryId)).toBe(deliveryId);
    expect(createWebhookLowercaseIdentifierEventTypeParser(
      GITHUB_EVENT_TYPE_PARSER_PRESET,
    ).parse(built.headers[GITHUB_EVENT_HEADER])).toBe('issues');
    expect(createWebhookPositiveDecimalIdentifierParser(
      GITHUB_HOOK_ID_PARSER_PRESET,
    ).parse(built.headers[GITHUB_HOOK_ID_HEADER])).toBe('1');
    expect(deliveryId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect({ ...built.headers }).toEqual({
      [GITHUB_SIGNATURE_HEADER]: expect.stringMatching(/^sha256=[0-9a-f]{64}$/),
      [GITHUB_DELIVERY_HEADER]: deliveryId,
      [GITHUB_EVENT_HEADER]: 'issues',
      [GITHUB_HOOK_ID_HEADER]: '1',
    });
    expect(verifyGitHubWebhookSignature({
      signature: built.headers[GITHUB_SIGNATURE_HEADER]!,
      raw_body: built.raw_body,
      webhook_secret: OLDER_SECRET,
    })).toBe(true);
    expect(verifyGitHubWebhookSignature({
      signature: built.headers[GITHUB_SIGNATURE_HEADER]!,
      raw_body: built.raw_body,
      webhook_secret: SECRET,
    })).toBe(false);
    const samePrefix = await adapter.buildTestDelivery!({
      nonce: `${nonce.slice(0, -1)}e`,
      selected_event_types: ['issues'],
    }, runtime);
    expect(samePrefix.headers[GITHUB_DELIVERY_HEADER]).not.toBe(deliveryId);

    const accepted = requireAccepted(await adapter.verifyAndDecode(rawRequest({
      body: built.raw_body,
      signature: built.headers[GITHUB_SIGNATURE_HEADER]!,
      deliveryId: built.headers[GITHUB_DELIVERY_HEADER]!,
      eventType: built.headers[GITHUB_EVENT_HEADER]!,
      hookId: built.headers[GITHUB_HOOK_ID_HEADER]!,
    }), runtime));
    expect(accepted.admission).toMatchObject({
      credential_version: '1',
      freshness_checked: false,
      method_label: 'github-hmac-sha256',
    });
    expect(accepted.events[0]).toMatchObject({
      provider_event_id: deliveryId,
      provider_resource_id: null,
      provider_event_type: 'issues',
      provider_occurred_at: null,
      decoded_payload: {
        recued_test_delivery: { nonce },
      },
    });

    await expect(Promise.resolve().then(() => adapter.buildTestDelivery!({
      nonce: 'invalid',
      selected_event_types: ['issues'],
    }, runtime))).rejects.toThrow('nonce is invalid');
    await expect(Promise.resolve().then(() => adapter.buildTestDelivery!({
      nonce,
      selected_event_types: ['invalid event type'],
    }, runtime))).rejects.toThrow('selected test event is invalid');
    await expect(Promise.resolve().then(() => adapter.buildTestDelivery!({
      nonce,
      selected_event_types: [],
    }, runtime))).rejects.toThrow('selected test event is invalid');
    await expect(Promise.resolve().then(() => adapter.buildTestDelivery!({
      nonce,
      selected_event_types: ['issues'],
    }, context({ environment: 'live' })))).rejects.toThrow(
      'test configuration is unavailable',
    );
  });

  it('rejects bad or repeated signatures before decoding untrusted JSON', async () => {
    const adapter = createGitHubWebhookProfileAdapter();
    const malformed = Buffer.from('{not-json', 'utf8');
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      body: malformed,
      signatureSecret: OLDER_SECRET,
    }), context()), 'authentication_failed', 401);
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      signature: [],
    }), context()), 'authentication_failed', 401);
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      signature: [signatureFor(githubBody()), signatureFor(githubBody())],
    }), context()), 'authentication_failed', 401);
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      body: malformed,
    }), context()), 'structural_admission_failed', 400);
  });

  it('requires exact GUID, event, hook, and bounded JSON shapes after authentication', async () => {
    const adapter = createGitHubWebhookProfileAdapter();
    const invalidRequests: RawWebhookRequest[] = [
      rawRequest({ deliveryId: 'not-a-guid' }),
      rawRequest({ deliveryId: [DELIVERY_ID, DELIVERY_ID] }),
      rawRequest({ eventType: 'Issues' }),
      rawRequest({ eventType: 'issues.opened' }),
      rawRequest({ hookId: '0' }),
      rawRequest({ hookId: '01' }),
      rawRequest({ hookId: '1a' }),
      rawRequest({ hookId: '9'.repeat(33) }),
      rawRequest({ hookId: ['292430182', '292430182'] }),
      rawRequest({ body: Buffer.from([0xff]) }),
      rawRequest({ body: Buffer.from('\ufeff{"action":"opened"}', 'utf8') }),
      rawRequest({ body: Buffer.from('[]', 'utf8') }),
      rawRequest({ body: Buffer.from('{"value":1e400}', 'utf8') }),
      rawRequest({ body: Buffer.from('{"__proto__":{}}', 'utf8') }),
      rawRequest({
        body: Buffer.from(`${'{"nested":'.repeat(34)}{}${'}'.repeat(34)}`, 'utf8'),
      }),
      rawRequest({
        body: Buffer.from(JSON.stringify({ values: new Array(10_001).fill(null) }), 'utf8'),
      }),
    ];
    for (const request of invalidRequests) {
      expectFailure(await adapter.verifyAndDecode(request, context()),
        'structural_admission_failed', 400);
    }
  });

  it('requires one exact generated secret and at most two active versions', async () => {
    expect(validateGitHubWebhookCredentialShape({ webhook_secret: SECRET })).toBe(true);
    expect(validateGitHubWebhookCredentialShape({
      webhook_secret: SECRET,
      ignored_secret: 'must-fail',
    })).toBe(false);
    expect(validateGitHubWebhookCredentialShape({ webhook_secret: 'A'.repeat(42) }))
      .toBe(false);
    expect(validateGitHubWebhookCredentialShape({ webhook_secret: 'A'.repeat(44) }))
      .toBe(false);
    expect(validateGitHubWebhookCredentialShape({ webhook_secret: 'A'.repeat(42) + '!' }))
      .toBe(false);
    const inherited = Object.create({ webhook_secret: SECRET }) as Record<string, string>;
    expect(validateGitHubWebhookCredentialShape(inherited)).toBe(false);

    expectFailure(await createGitHubWebhookProfileAdapter().verifyAndDecode(
      rawRequest(),
      context({
        credentials: [
          credentialVersion(1, OLDER_SECRET),
          credentialVersion(2, 'C'.repeat(43)),
          credentialVersion(3, SECRET),
        ],
      }),
    ), 'profile_internal_error', 503);
  });

  it('deduplicates retries while preserving distinct GUID deliveries with identical bodies', async () => {
    const db = new Database(':memory:');
    const ingressStore = createWebhookIngressStore(db, {
      now: () => NOW_MS,
      getEncryptionKey: () => new Uint8Array(32).fill(61),
    });
    const created = ingressStore.create({
      display_name: 'Durable GitHub fixture',
      profile_id: 'github.webhook.v1',
      environment: 'test',
      paired_connection_id: null,
      registration_mode: 'manual',
      selected_event_types: ['issues'],
    });
    await ingressStore.writeCredentialVersion(created.ingress_id, {
      webhook_secret: SECRET,
    });
    const endpoint = `https://hooks.example.test/v1/webhooks/${created.public_id}`;
    ingressStore.confirmManualRegistration(created.ingress_id, {
      requires_handshake: false,
      endpoint_url: endpoint,
    });
    ingressStore.enable(created.ingress_id);
    const deliveryStore = createWebhookDeliveryStore(db, {
      now: () => NOW_MS,
      getEncryptionKey: () => new Uint8Array(32).fill(62),
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
        createGitHubWebhookProfileAdapter(),
      ]),
      isOutboxDispatcherStarted: outbox.isStarted,
      resolveCanonicalPublicUrl: () => endpoint,
      now: () => NOW_MS,
    });
    const server = await startServer(0, { webhookProfileListener: listener });
    outbox.start();

    const send = (
      body: Buffer,
      deliveryId: string,
    ): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: server.port,
        path: `/v1/webhooks/${created.public_id}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.byteLength,
          'X-Hub-Signature-256': signatureFor(body),
          'X-GitHub-Delivery': deliveryId,
          'X-GitHub-Event': 'issues',
          'X-GitHub-Hook-ID': '292430182',
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
    });

    const body = githubBody();
    try {
      await expect(send(body, DELIVERY_ID)).resolves.toEqual({ status: 200, body: '' });
      await expect(send(body, DELIVERY_ID)).resolves.toEqual({ status: 200, body: '' });
      await expect(send(body, '0b989ba4-242f-11e5-81e1-c7b6966d2516'))
        .resolves.toEqual({ status: 200, body: '' });
      expect(deliveryStore.listDeliveries(created.ingress_id)).toHaveLength(2);
      const storedEvents = deliveryStore.listEvents(created.ingress_id);
      expect(storedEvents).toHaveLength(2);
      expect(storedEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          provider_event_id: DELIVERY_ID,
          provider_resource_id: null,
          provider_event_type: 'issues',
          dispatch_state: 'pending',
        }),
        expect.objectContaining({
          provider_event_id: '0b989ba4-242f-11e5-81e1-c7b6966d2516',
          provider_resource_id: null,
          provider_event_type: 'issues',
          dispatch_state: 'pending',
        }),
      ]));
      expect(deliveryStore.listOutbox()).toHaveLength(2);
      await outbox.drainOnce();
      expect(dispatched.slice().sort()).toEqual(storedEvents
        .map((event) => event.event_id)
        .sort());
    } finally {
      await server.close();
      await outbox.stop();
      db.close();
    }
  });
});
