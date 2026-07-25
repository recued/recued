import http from 'node:http';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { startServer } from '../server.js';
import {
  TELEGRAM_SECRET_HEADER,
  isTelegramWebhookEndpointSupported,
} from '../connections/providers/telegram-webhook-protocol.js';
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
  createTelegramWebhookProfileAdapter,
  TELEGRAM_JSON_OBJECT_DECODER_PRESET,
  TELEGRAM_JSON_SINGLE_MEMBER_EVENT_NORMALIZER_PRESET,
  TELEGRAM_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET,
  TELEGRAM_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET,
  TELEGRAM_STATIC_HEADER_TOKEN_MECHANISM_PRESET,
  validateTelegramWebhookCredentialShape,
} from '../webhook-telegram-profile.js';
import {
  WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET,
} from '../webhook-json-object-decoder.js';

const NOW_MS = Date.parse('2026-07-11T23:00:00.000Z');
const SECRET = 'Telegram_secret-token_d201';

const telegramBody = (
  updateId = 104_200,
  updateType = 'message',
  updatePayload: Record<string, unknown> = {
    message_id: 81,
    date: 1_752_000_000,
    chat: { id: 123_456, type: 'private' },
    text: 'hello from Telegram',
  },
): Buffer => Buffer.from(JSON.stringify({
  update_id: updateId,
  [updateType]: updatePayload,
}), 'utf8');

const credentialVersion = (
  version: number,
  secretToken: string,
): ResolvedWebhookCredentialVersion => ({
  version: String(version),
  created_at: NOW_MS + version,
  credentials: { secret_token: secretToken },
});

const context = (input: {
  credentials?: readonly ResolvedWebhookCredentialVersion[];
  now?: () => number;
} = {}): WebhookProfileRuntimeContext => ({
  ingress_id: 'whi_d201telegramprofilefixture123',
  environment: 'test',
  credential_versions: input.credentials ?? [credentialVersion(1, SECRET)],
  now: input.now ?? (() => NOW_MS),
});

const rawRequest = (input: {
  body?: Buffer;
  secret?: string | readonly string[];
} = {}): RawWebhookRequest => {
  const secret = input.secret ?? SECRET;
  return {
    method: 'POST',
    raw_body: input.body ?? telegramBody(),
    headers: new Map([
      ['content-type', ['application/json']],
      [TELEGRAM_SECRET_HEADER, typeof secret === 'string' ? [secret] : secret],
    ]),
    raw_path_and_query: '/v1/webhooks/telegram-profile-fixture',
    canonical_public_url:
      'https://hooks.example.test/v1/webhooks/telegram-profile-fixture',
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

describe('D-201 Slices 7E + 9X-9AC + 9AX Telegram webhook profile adapter', () => {
  it('retains the legacy Telegram HTTPS endpoint compatibility helper', () => {
    expect(isTelegramWebhookEndpointSupported(
      'https://hooks.example.test/v1/webhooks/telegram',
    )).toBe(true);
    expect(isTelegramWebhookEndpointSupported(
      'https://hooks.example.test:8443/v1/webhooks/telegram',
    )).toBe(true);
    expect(isTelegramWebhookEndpointSupported(
      'https://hooks.example.test:9443/v1/webhooks/telegram',
    )).toBe(false);
    expect(isTelegramWebhookEndpointSupported(
      'http://hooks.example.test:80/v1/webhooks/telegram',
    )).toBe(false);
  });

  it('authenticates rotation and projects one stable-id Update without a clock', async () => {
    const adapter = createTelegramWebhookProfileAdapter();
    const olderSecret = 'Telegram_older-secret';
    const body = telegramBody();
    const delivery = requireAccepted(await adapter.verifyAndDecode(rawRequest({
      body,
      secret: olderSecret,
    }), context({
      credentials: [
        credentialVersion(1, olderSecret),
        credentialVersion(2, SECRET),
      ],
      now: () => {
        throw new Error('Telegram static-token verification must not read time');
      },
    })));

    expect(delivery).toMatchObject({
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
        decoded_payload: JSON.parse(body.toString('utf8')),
      }],
    });
    expect(delivery.delivery_dedup_key).toBe(
      'telegram:update:93a0453c0add4392e45c68f4292d55f4e9c6aca0e6cc48a968236af55be9726d',
    );
    expect(delivery.events[0]?.event_dedup_key)
      .toBe(`${delivery.delivery_dedup_key}:0`);
    expect(TELEGRAM_STATIC_HEADER_TOKEN_MECHANISM_PRESET).toEqual({
      kind: 'static_header_token.v1',
      token_field: 'secret_token',
      token_shape: {
        kind: 'bounded_ascii_token.v1',
        max_characters: 256,
      },
      token_header: {
        kind: 'fixed',
        name: TELEGRAM_SECRET_HEADER,
      },
      matching_credential: 'newest',
    });
    expect(TELEGRAM_JSON_OBJECT_DECODER_PRESET)
      .toBe(WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET);
    expect(TELEGRAM_JSON_SINGLE_MEMBER_EVENT_NORMALIZER_PRESET).toEqual({
      kind: 'json_single_member_event.v1',
      event_id_field: 'update_id',
      event_id_grammar: 'positive_safe_integer.v1',
      event_id_max_value: 0x7fffffff,
      event_type_grammar: 'ascii_identifier.v1',
      event_type_max_bytes: 128,
    });
    expect(TELEGRAM_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET).toEqual({
      kind: 'normalized_required_single_id_sha256.v1',
      stable_id_field: 'event_id',
      stable_id_prefix: 'telegram:update:',
    });
    expect(TELEGRAM_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET).toEqual({
      kind: 'normalized_single_event.v1',
      provider_event_id_field: 'event_id',
      provider_resource_id_field: 'resource_id',
      provider_event_type_field: 'event_type',
      provider_occurred_at_field: 'occurred_at',
      decoded_payload_field: 'payload',
      occurred_at_unit: 'unix_milliseconds.v1',
    });
    const sameIdEditedBody = telegramBody(104_200, 'edited_message', {
      message_id: 81,
      text: 'retry with changed bytes',
    });
    expect(requireAccepted(await adapter.verifyAndDecode(rawRequest({
      body: sameIdEditedBody,
    }), context())).delivery_dedup_key).toBe(delivery.delivery_dedup_key);
  });

  it('rejects missing, wrong, malformed, and repeated secret headers before decode', async () => {
    const adapter = createTelegramWebhookProfileAdapter();
    const malformed = Buffer.from('{not-json', 'utf8');
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      body: malformed,
      secret: 'wrong_secret',
    }), context()), 'authentication_failed', 401);
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      secret: [],
    }), context()), 'authentication_failed', 401);
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      secret: [SECRET, SECRET],
    }), context()), 'authentication_failed', 401);
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      secret: 'contains spaces',
    }), context()), 'authentication_failed', 401);
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      body: malformed,
    }), context()), 'structural_admission_failed', 400);
  });

  it('admits only one bounded official Update member and numeric update id', async () => {
    const adapter = createTelegramWebhookProfileAdapter();
    const invalidBodies = [
      Buffer.from([0xff]),
      Buffer.from('{"update_id":"42","message":{}}', 'utf8'),
      Buffer.from('{"update_id":-1,"message":{}}', 'utf8'),
      Buffer.from('{"update_id":0,"message":{}}', 'utf8'),
      Buffer.from(`{"update_id":${
        TELEGRAM_JSON_SINGLE_MEMBER_EVENT_NORMALIZER_PRESET.event_id_max_value + 1
      },"message":{}}`, 'utf8'),
      Buffer.from('{"update_id":42}', 'utf8'),
      Buffer.from('{"update_id":42,"message":{},"callback_query":{}}', 'utf8'),
      Buffer.from('{"update_id":42,"message":[]}', 'utf8'),
      Buffer.from('{"update_id":42,"message":null}', 'utf8'),
      Buffer.from('{"update_id":42,"message":{"n":1e400}}', 'utf8'),
      Buffer.from('{"update_id":42,"message":{"constructor":{}}}', 'utf8'),
      Buffer.from('{"update_id":42,"message":{},"__proto__":{}}', 'utf8'),
    ];
    for (const body of invalidBodies) {
      expectFailure(await adapter.verifyAndDecode(rawRequest({ body }), context()),
        'structural_admission_failed', 400);
    }
  });

  it('requires one exact generated-token field and at most two active versions', async () => {
    expect(validateTelegramWebhookCredentialShape({ secret_token: SECRET })).toBe(true);
    expect(validateTelegramWebhookCredentialShape({ secret_token: 'a' })).toBe(true);
    expect(validateTelegramWebhookCredentialShape({
      secret_token: 'a'.repeat(256),
    })).toBe(true);
    expect(validateTelegramWebhookCredentialShape({
      secret_token: SECRET,
      ignored_secret: 'must-fail',
    })).toBe(false);
    expect(validateTelegramWebhookCredentialShape({
      secret_token: 'contains spaces',
    })).toBe(false);
    expect(validateTelegramWebhookCredentialShape({
      secret_token: 'a'.repeat(257),
    })).toBe(false);
    const inherited = Object.create({ secret_token: SECRET }) as Record<string, string>;
    expect(validateTelegramWebhookCredentialShape(inherited)).toBe(false);

    expectFailure(await createTelegramWebhookProfileAdapter().verifyAndDecode(
      rawRequest(),
      context({
        credentials: [
          credentialVersion(1, 'telegram-secret-one'),
          credentialVersion(2, 'telegram-secret-two'),
          credentialVersion(3, SECRET),
        ],
      }),
    ), 'profile_internal_error', 503);
  });

  it('durably deduplicates retries and dispatches one selected Update', async () => {
    const db = new Database(':memory:');
    const ingressStore = createWebhookIngressStore(db, {
      now: () => NOW_MS,
      getEncryptionKey: () => new Uint8Array(32).fill(51),
    });
    const created = ingressStore.create({
      display_name: 'Durable Telegram fixture',
      profile_id: 'telegram.bot-webhook.v1',
      environment: 'test',
      paired_connection_id: null,
      registration_mode: 'manual',
      selected_event_types: ['message'],
    });
    await ingressStore.writeCredentialVersion(created.ingress_id, {
      secret_token: SECRET,
    });
    const endpoint = `https://hooks.example.test/v1/webhooks/${created.public_id}`;
    ingressStore.confirmManualRegistration(created.ingress_id, {
      requires_handshake: false,
      endpoint_url: endpoint,
    });
    ingressStore.enable(created.ingress_id);
    const deliveryStore = createWebhookDeliveryStore(db, {
      now: () => NOW_MS,
      getEncryptionKey: () => new Uint8Array(32).fill(52),
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
        createTelegramWebhookProfileAdapter(),
      ]),
      isOutboxDispatcherStarted: outbox.isStarted,
      resolveCanonicalPublicUrl: () => endpoint,
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
            'X-Telegram-Bot-Api-Secret-Token': SECRET,
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

    const body = telegramBody();
    try {
      await expect(send(body)).resolves.toEqual({ status: 200, body: '' });
      await expect(send(body)).resolves.toEqual({ status: 200, body: '' });
      expect(deliveryStore.listDeliveries(created.ingress_id)).toHaveLength(1);
      expect(deliveryStore.listEvents(created.ingress_id)).toEqual([
        expect.objectContaining({
          provider_event_id: '104200',
          provider_event_type: 'message',
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
