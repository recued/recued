import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { WebhookProfileId } from '@recued/contracts';
import {
  GENERIC_TIMESTAMPED_HMAC_REPLAY_WINDOW_SECONDS,
  GENERIC_WEBHOOK_FINGERPRINT_WINDOW_MS,
  PRIMITIVE_WEBHOOK_PROFILE_IDS,
  createClockGatedTimestampedHmacWebhookProfileAdapter,
  createPrimitiveWebhookProfileRuntimeRegistry,
} from '../webhook-primitive-profiles.js';
import type { WebhookClockHealthAuthority } from '../webhook-clock-health.js';
import type {
  RawWebhookRequest,
  ResolvedWebhookCredentialVersion,
  WebhookProfileResult,
  WebhookProfileRuntimeContext,
} from '../webhook-profile-runtime.js';

const BODY = Buffer.from('{"hello":"world","n":1}', 'utf8');
const RECEIVED_AT = GENERIC_WEBHOOK_FINGERPRINT_WINDOW_MS * 10_000 + 1;
const NOW_SECONDS = 2_000_000_000;

const credentialVersion = (
  version: number,
  credentials: Record<string, string>,
): ResolvedWebhookCredentialVersion => ({
  version: String(version),
  created_at: 1_900_000_000_000 + version,
  credentials,
});

const runtimeContext = (
  versions: readonly ResolvedWebhookCredentialVersion[],
  nowSeconds = NOW_SECONDS,
): WebhookProfileRuntimeContext => ({
  ingress_id: 'whi_primitive_profile_fixture',
  environment: 'test',
  credential_versions: versions,
  now: () => nowSeconds * 1_000,
});

const rawRequest = (input: {
  body?: Buffer;
  headers?: Readonly<Record<string, string | readonly string[]>>;
  receivedAt?: number;
} = {}): RawWebhookRequest => ({
  method: 'POST',
  raw_body: input.body ?? BODY,
  headers: new Map(Object.entries(input.headers ?? {}).map(([name, value]) => [
    name.toLowerCase(),
    typeof value === 'string' ? [value] : value,
  ])),
  raw_path_and_query: '/v1/webhooks/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  canonical_public_url:
    'https://hooks.example.test/v1/webhooks/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  received_at: input.receivedAt ?? RECEIVED_AT,
  remote_ip: '127.0.0.1',
});

const requireAccepted = (
  result: WebhookProfileResult,
): Extract<WebhookProfileResult, { ok: true }>['delivery'] => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected accepted result, got ${result.failure.code}`);
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

const rawHmac = (secret: string, body: Buffer): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

const timestampedHmac = (
  secret: string,
  timestamp: string,
  body: Buffer,
): string => createHmac('sha256', secret)
  .update(`${timestamp}.`)
  .update(body)
  .digest('hex');

describe('D-201 primitive webhook profile registry', () => {
  it('registers only the four generic primitives and no vendor migration', () => {
    const registry = createPrimitiveWebhookProfileRuntimeRegistry();
    expect(registry.list().map((adapter) => adapter.profile_id)).toEqual(
      PRIMITIVE_WEBHOOK_PROFILE_IDS,
    );
    expect(registry.get('stripe.event.v1')).toBeNull();
    expect(registry.get('slack.request.v0')).toBeNull();
    expect(registry.get('telegram.bot-webhook.v1')).toBeNull();
    expect(registry.get('github.webhook.v1')).toBeNull();
    expect(registry.list().every((adapter) => (
      Object.isFrozen(adapter)
      && Object.isFrozen(adapter.success_response)
      && adapter.success_response.status === 202
    ))).toBe(true);
  });

  it('builds nonce-bearing tests that re-enter normal admission for each live primitive', async () => {
    const registry = createPrimitiveWebhookProfileRuntimeRegistry();
    const nonce = 'a'.repeat(64);
    const fixtures: Array<{
      profile_id:
        | 'generic.static-header-token.v1'
        | 'generic.http-basic.v1'
        | 'generic.raw-body-hmac-sha256.v1';
      credentials: Record<string, string>;
    }> = [
      {
        profile_id: 'generic.static-header-token.v1' as const,
        credentials: {
          header_name: 'x-test-token',
          header_token: 'test-token',
        },
      },
      {
        profile_id: 'generic.http-basic.v1' as const,
        credentials: {
          username: 'test-user',
          password: 'test-password',
        },
      },
      {
        profile_id: 'generic.raw-body-hmac-sha256.v1' as const,
        credentials: {
          signature_header: 'x-test-signature',
          signing_secret: 'test-signing-secret',
        },
      },
    ];
    for (const fixture of fixtures) {
      const adapter = registry.get(fixture.profile_id)!;
      const olderCredentials = Object.fromEntries(
        Object.entries(fixture.credentials).map(([key, value]) => [
          key,
          `${value}-old`,
        ]),
      );
      const context = runtimeContext([
        credentialVersion(1, olderCredentials),
        credentialVersion(2, fixture.credentials),
      ]);
      expect(adapter.buildTestDelivery).toEqual(expect.any(Function));
      const built = await adapter.buildTestDelivery!({
        nonce,
        selected_event_types: ['delivery'],
      }, context);
      for (const credentialValue of Object.values(fixture.credentials)) {
        expect(built.raw_body.toString('utf8')).not.toContain(credentialValue);
      }
      const accepted = requireAccepted(await adapter.verifyAndDecode(rawRequest({
        body: built.raw_body,
        headers: built.headers,
      }), context));
      expect(accepted.admission.credential_version).toBe('2');
      expect(accepted.events[0]?.decoded_payload).toEqual({
        recued_test_delivery: { nonce },
      });
    }
    expect(registry.get('generic.timestamped-raw-body-hmac-sha256.v1')
      ?.buildTestDelivery).toBeUndefined();
  });

  it('uses authority-derived time and rechecks clock health on every timestamped delivery', async () => {
    const trustedNow = NOW_SECONDS * 1_000;
    const checks = [
      { healthy: true, trusted_now_ms: trustedNow, maximum_error_ms: 1_000, checked_at: trustedNow },
      { healthy: true, trusted_now_ms: trustedNow, maximum_error_ms: 1_000, checked_at: trustedNow },
      { healthy: false, reason: 'probe_unavailable' },
      { healthy: true, trusted_now_ms: trustedNow, maximum_error_ms: 6_000, checked_at: trustedNow },
      { healthy: false, reason: 'clock_error_exceeded' },
    ];
    const authority: WebhookClockHealthAuthority = {
      check: async () => checks.shift() as Awaited<ReturnType<WebhookClockHealthAuthority['check']>>,
    };
    const adapter = createClockGatedTimestampedHmacWebhookProfileAdapter(authority);
    const secret = 'trusted-clock-secret';
    const context = {
      ...runtimeContext([
        credentialVersion(1, {
          signature_header: 'x-timestamped-signature',
          signing_secret: 'older-trusted-clock-secret',
        }),
        credentialVersion(2, {
          signature_header: 'x-timestamped-signature',
          signing_secret: secret,
        }),
      ]),
      // A caller-supplied local clock is never the replay authority.
      now: () => (NOW_SECONDS - 100_000) * 1_000,
    };
    const built = await adapter.buildTestDelivery!({
      nonce: 'b'.repeat(64),
      selected_event_types: ['delivery'],
    }, context);
    expect(built.headers['x-timestamped-signature']).toMatch(
      new RegExp(`^t=${NOW_SECONDS},v1=[0-9a-f]{64}$`),
    );
    const accepted = requireAccepted(await adapter.verifyAndDecode(rawRequest({
      body: built.raw_body,
      headers: built.headers,
    }), context));
    expect(accepted.admission).toMatchObject({
      credential_version: '2',
      freshness_checked: true,
      method_label: 'timestamped-hmac-sha256',
    });
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      body: built.raw_body,
      headers: built.headers,
    }), context), 'profile_dependency_unavailable', 503);
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      body: built.raw_body,
      headers: built.headers,
    }), context), 'profile_dependency_unavailable', 503);
    await expect(adapter.buildTestDelivery!({
      nonce: 'c'.repeat(64),
      selected_event_types: ['delivery'],
    }, context))
      .rejects.toThrow('trusted clock is unavailable');
    expect(checks).toHaveLength(0);
  });

  it('authenticates an exact static header across rotation and bounds body fingerprints', async () => {
    const adapter = createPrimitiveWebhookProfileRuntimeRegistry()
      .get('generic.static-header-token.v1')!;
    const context = runtimeContext([
      credentialVersion(2, {
        header_name: 'X-Webhook-Token',
        header_token: 'new-token',
      }),
      credentialVersion(1, {
        header_name: 'x-webhook-token',
        header_token: 'old-token',
      }),
    ]);
    const accepted = requireAccepted(await adapter.verifyAndDecode(rawRequest({
      headers: { 'X-Webhook-Token': 'old-token' },
    }), context));
    expect(accepted).toMatchObject({
      decoded_content_type: 'application/json',
      admission: {
        credential_version: '1',
        transport_assurance: 'authenticated',
        freshness_checked: false,
        method_label: 'static-header-token',
      },
      events: [{
        provider_event_type: 'delivery',
        provider_event_id: null,
        decoded_payload: { hello: 'world', n: 1 },
      }],
      response: { status: 202 },
    });

    const sameWindow = requireAccepted(await adapter.verifyAndDecode(rawRequest({
      headers: { 'x-webhook-token': 'old-token' },
      receivedAt: RECEIVED_AT + GENERIC_WEBHOOK_FINGERPRINT_WINDOW_MS - 2,
    }), context));
    const nextWindow = requireAccepted(await adapter.verifyAndDecode(rawRequest({
      headers: { 'x-webhook-token': 'old-token' },
      receivedAt: RECEIVED_AT + GENERIC_WEBHOOK_FINGERPRINT_WINDOW_MS,
    }), context));
    expect(sameWindow.delivery_dedup_key).toBe(accepted.delivery_dedup_key);
    expect(nextWindow.delivery_dedup_key).not.toBe(accepted.delivery_dedup_key);
    expect(accepted.events[0]!.event_dedup_key)
      .toBe(`${accepted.delivery_dedup_key}:0`);

    expectFailure(await adapter.verifyAndDecode(rawRequest({
      headers: { 'x-webhook-token': ['old-token', 'old-token'] },
    }), context), 'authentication_failed', 401);
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      headers: { 'x-webhook-token': 'wrong-token' },
    }), context), 'authentication_failed', 401);
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      headers: { host: 'fixture-secret' },
    }), runtimeContext([credentialVersion(1, {
      header_name: 'host',
      header_token: 'fixture-secret',
    })])), 'profile_internal_error', 503);

    const symbolCredential = {
      header_name: 'x-webhook-token',
      header_token: 'old-token',
    };
    Object.defineProperty(symbolCredential, Symbol('hidden-authority'), {
      value: 'must-not-be-ignored',
      enumerable: false,
    });
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      headers: { 'x-webhook-token': 'old-token' },
    }), runtimeContext([credentialVersion(1, symbolCredential)])),
    'profile_internal_error', 503);

    expectFailure(await adapter.verifyAndDecode(rawRequest({
      headers: { 'x-webhook-token': 'токен' },
    }), runtimeContext([credentialVersion(1, {
      header_name: 'x-webhook-token',
      header_token: 'токен',
    })])), 'profile_internal_error', 503);

    expectFailure(await adapter.verifyAndDecode(rawRequest({
      headers: { 'x-webhook-token': 'old-token' },
    }), runtimeContext([
      credentialVersion(3, {
        header_name: 'x-webhook-token',
        header_token: 'newest-token',
      }),
      credentialVersion(2, {
        header_name: 'x-webhook-token',
        header_token: 'new-token',
      }),
      credentialVersion(1, {
        header_name: 'x-webhook-token',
        header_token: 'old-token',
      }),
    ])), 'profile_internal_error', 503);
  });

  it('parses HTTP Basic canonically and compares the full UTF-8 credential', async () => {
    const adapter = createPrimitiveWebhookProfileRuntimeRegistry()
      .get('generic.http-basic.v1')!;
    const context = runtimeContext([credentialVersion(1, {
      username: 'álîce',
      password: 'pä:ssword',
    })]);
    const encoded = Buffer.from('álîce:pä:ssword', 'utf8').toString('base64');
    const accepted = requireAccepted(await adapter.verifyAndDecode(rawRequest({
      headers: { authorization: `bAsIc ${encoded}` },
    }), context));
    expect(accepted.admission).toMatchObject({
      credential_version: '1',
      method_label: 'http-basic',
      freshness_checked: false,
    });

    expectFailure(await adapter.verifyAndDecode(rawRequest({
      headers: { authorization: `Basic  ${encoded}` },
    }), context), 'authentication_failed', 401);
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      headers: {
        authorization: `Basic ${encoded.endsWith('=')
          ? encoded.replace(/=+$/, '')
          : `${encoded}=`}`,
      },
    }), context), 'authentication_failed', 401);
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      headers: { authorization: [`Basic ${encoded}`, `Basic ${encoded}`] },
    }), context), 'authentication_failed', 401);
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      headers: { authorization: `Basic ${encoded}` },
    }), runtimeContext([credentialVersion(1, {
      username: 'bad:user',
      password: 'password',
    })])), 'profile_internal_error', 503);
  });

  it('uses core credential-version admission for HTTP Basic without coercion', async () => {
    const adapter = createPrimitiveWebhookProfileRuntimeRegistry()
      .get('generic.http-basic.v1')!;
    const credentials = { username: 'alice', password: 'secret' };
    const encoded = Buffer.from('alice:secret', 'utf8').toString('base64');
    const authorization = `Basic ${encoded}`;
    const request = rawRequest({ headers: { authorization } });
    const contextWithVersion = (value: unknown): WebhookProfileRuntimeContext =>
      runtimeContext([{
        version: value as string,
        created_at: 1,
        credentials,
      }]);

    const maximum = String(Number.MAX_SAFE_INTEGER);
    const accepted = requireAccepted(await adapter.verifyAndDecode(
      request,
      contextWithVersion(maximum),
    ));
    expect(accepted.admission.credential_version).toBe(maximum);

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
      expectFailure(
        await adapter.verifyAndDecode(request, contextWithVersion(invalid)),
        'profile_internal_error',
        503,
      );
    }
    expect(coercions).toBe(0);
  });

  it('verifies raw-body HMAC over untouched bytes with one exact signature grammar', async () => {
    const adapter = createPrimitiveWebhookProfileRuntimeRegistry()
      .get('generic.raw-body-hmac-sha256.v1')!;
    const oldSecret = 'old-raw-hmac-secret';
    const context = runtimeContext([
      credentialVersion(2, {
        signature_header: 'X-Raw-Signature',
        signing_secret: 'new-raw-hmac-secret',
      }),
      credentialVersion(1, {
        signature_header: 'x-raw-signature',
        signing_secret: oldSecret,
      }),
    ]);
    const body = Buffer.from('{"z":1,\n "a":2}', 'utf8');
    const signature = rawHmac(oldSecret, body);
    const accepted = requireAccepted(await adapter.verifyAndDecode(rawRequest({
      body,
      headers: { 'x-raw-signature': signature },
    }), context));
    expect(accepted.admission).toMatchObject({
      credential_version: '1',
      method_label: 'raw-body-hmac-sha256',
      freshness_checked: false,
    });

    const reserialized = Buffer.from('{"z":1,"a":2}', 'utf8');
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      body: reserialized,
      headers: { 'x-raw-signature': signature },
    }), context), 'authentication_failed', 401);
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      body,
      headers: { 'x-raw-signature': signature.slice('sha256='.length) },
    }), context), 'authentication_failed', 401);
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      body,
      headers: { 'x-raw-signature': signature.toUpperCase() },
    }), context), 'authentication_failed', 401);
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      body,
      headers: { 'x-raw-signature': [signature, signature] },
    }), context), 'authentication_failed', 401);

    const malformed = Buffer.from('{"not":"closed"', 'utf8');
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      body: malformed,
      headers: { 'x-raw-signature': rawHmac(oldSecret, malformed) },
    }), context), 'structural_admission_failed', 400);
  });

  it('enforces canonical timestamp grammar, freshness, exact bytes, and rotation', async () => {
    const adapter = createPrimitiveWebhookProfileRuntimeRegistry()
      .get('generic.timestamped-raw-body-hmac-sha256.v1')!;
    const oldSecret = 'old-timestamped-secret';
    const timestamp = String(NOW_SECONDS);
    const good = timestampedHmac(oldSecret, timestamp, BODY);
    const context = runtimeContext([
      credentialVersion(2, {
        signature_header: 'X-Timestamped-Signature',
        signing_secret: 'new-timestamped-secret',
      }),
      credentialVersion(1, {
        signature_header: 'x-timestamped-signature',
        signing_secret: oldSecret,
      }),
    ]);
    const header = `t=${timestamp},v1=${'0'.repeat(64)},v1=${good}`;
    const accepted = requireAccepted(await adapter.verifyAndDecode(rawRequest({
      headers: { 'x-timestamped-signature': header },
    }), context));
    expect(accepted.admission).toEqual({
      transport_assurance: 'authenticated',
      credential_version: '1',
      freshness_checked: true,
      method_label: 'timestamped-hmac-sha256',
    });

    const laterReceipt = requireAccepted(await adapter.verifyAndDecode(rawRequest({
      headers: { 'x-timestamped-signature': header },
      receivedAt: RECEIVED_AT + (10 * GENERIC_WEBHOOK_FINGERPRINT_WINDOW_MS),
    }), context));
    expect(laterReceipt.delivery_dedup_key).toBe(accepted.delivery_dedup_key);

    for (const staleSeconds of [
      NOW_SECONDS - GENERIC_TIMESTAMPED_HMAC_REPLAY_WINDOW_SECONDS - 1,
      NOW_SECONDS + GENERIC_TIMESTAMPED_HMAC_REPLAY_WINDOW_SECONDS + 1,
    ]) {
      const literal = String(staleSeconds);
      const staleHeader = `t=${literal},v1=${timestampedHmac(oldSecret, literal, BODY)}`;
      expectFailure(await adapter.verifyAndDecode(rawRequest({
        headers: { 'x-timestamped-signature': staleHeader },
      }), context), 'authentication_failed', 401);
    }

    expectFailure(await adapter.verifyAndDecode(rawRequest({
      headers: { 'x-timestamped-signature': `t=0${timestamp},v1=${good}` },
    }), context), 'authentication_failed', 401);
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      headers: { 'x-timestamped-signature': `t=${timestamp}, v1=${good}` },
    }), context), 'authentication_failed', 401);
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      headers: { 'x-timestamped-signature': `v1=${good},t=${timestamp}` },
    }), context), 'authentication_failed', 401);
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      headers: { 'x-timestamped-signature': `t=${timestamp},v1=${good.toUpperCase()}` },
    }), context), 'authentication_failed', 401);
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      body: Buffer.from('{"hello":"changed","n":1}'),
      headers: { 'x-timestamped-signature': header },
    }), context), 'authentication_failed', 401);
    expectFailure(
      await adapter.verifyAndDecode(rawRequest({
        headers: { 'x-timestamped-signature': header },
      }), runtimeContext(context.credential_versions, Number.NaN)),
      'profile_internal_error',
      503,
    );
  });

  it('rejects ambiguous valid timestamp versions instead of choosing by order', async () => {
    const adapter = createPrimitiveWebhookProfileRuntimeRegistry()
      .get('generic.timestamped-raw-body-hmac-sha256.v1')!;
    const newerTimestamp = String(NOW_SECONDS);
    const olderTimestamp = String(NOW_SECONDS - 1);
    const newerSecret = 'newer-secret';
    const olderSecret = 'older-secret';
    const context = runtimeContext([
      credentialVersion(2, {
        signature_header: 'x-signature-new',
        signing_secret: newerSecret,
      }),
      credentialVersion(1, {
        signature_header: 'x-signature-old',
        signing_secret: olderSecret,
      }),
    ]);
    expectFailure(await adapter.verifyAndDecode(rawRequest({
      headers: {
        'x-signature-new': `t=${newerTimestamp},v1=${timestampedHmac(
          newerSecret,
          newerTimestamp,
          BODY,
        )}`,
        'x-signature-old': `t=${olderTimestamp},v1=${timestampedHmac(
          olderSecret,
          olderTimestamp,
          BODY,
        )}`,
      },
    }), context), 'authentication_failed', 401);
  });

  it('classifies authenticated unsafe JSON as structural and checks auth first', async () => {
    const adapter = createPrimitiveWebhookProfileRuntimeRegistry()
      .get('generic.static-header-token.v1')!;
    const context = runtimeContext([credentialVersion(1, {
      header_name: 'x-webhook-token',
      header_token: 'fixture-token',
    })]);
    const unsafeBodies = [
      Buffer.from('[1,2,3]', 'utf8'),
      Buffer.from('{"__proto__":{"polluted":true}}', 'utf8'),
      Buffer.from([0xff]),
      Buffer.from('\ufeff{"bom":true}', 'utf8'),
      Buffer.from('{"non_finite":1e400}', 'utf8'),
      Buffer.from(JSON.stringify({
        items: Array.from({ length: 10_001 }, () => 0),
      }), 'utf8'),
      Buffer.from(JSON.stringify(Object.fromEntries(
        Array.from({ length: 10_001 }, (_, index) => [`k${index}`, 0]),
      )), 'utf8'),
      Buffer.from(JSON.stringify({ ['k'.repeat(257)]: true }), 'utf8'),
      Buffer.from(JSON.stringify({
        groups: Array.from(
          { length: 6 },
          () => Array.from({ length: 10_000 }, () => 0),
        ),
      }), 'utf8'),
      Buffer.from(JSON.stringify(Array.from({ length: 34 }).reduce<Record<string, unknown>>(
        (child) => ({ child }),
        {},
      )), 'utf8'),
    ];
    for (const body of unsafeBodies) {
      expectFailure(await adapter.verifyAndDecode(rawRequest({
        body,
        headers: { 'x-webhook-token': 'fixture-token' },
      }), context), 'structural_admission_failed', 400);
    }

    expectFailure(await adapter.verifyAndDecode(rawRequest({
      body: unsafeBodies[1],
      headers: { 'x-webhook-token': 'wrong-token' },
    }), context), 'authentication_failed', 401);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('keeps every primitive id compatible with the portable registry', () => {
    const registry = createPrimitiveWebhookProfileRuntimeRegistry();
    for (const profileId of PRIMITIVE_WEBHOOK_PROFILE_IDS) {
      expect(registry.get(profileId as WebhookProfileId)).not.toBeNull();
    }
  });
});
