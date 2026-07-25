import { describe, expect, it } from 'vitest';

import {
  createWebhookStaticHeaderTokenMechanism,
  type WebhookStaticHeaderTokenMechanismPreset,
} from '../webhook-static-header-token-engine.js';
import type {
  RawWebhookRequest,
  ResolvedWebhookCredentialVersion,
  WebhookProfileRuntimeContext,
} from '../webhook-profile-runtime.js';

const CONFIGURABLE: WebhookStaticHeaderTokenMechanismPreset = {
  kind: 'static_header_token.v1',
  token_field: 'header_token',
  token_shape: 'trimmed_printable_ascii_8192.v1',
  token_header: { kind: 'credential_field', field: 'header_name' },
  matching_credential: 'first',
};

const FIXED: WebhookStaticHeaderTokenMechanismPreset = {
  kind: 'static_header_token.v1',
  token_field: 'secret_token',
  token_shape: {
    kind: 'bounded_ascii_token.v1',
    max_characters: 256,
  },
  token_header: { kind: 'fixed', name: 'x-provider-secret-token' },
  matching_credential: 'newest',
};

const version = (
  value: number,
  credentials: Readonly<Record<string, string>>,
  createdAt = value,
): ResolvedWebhookCredentialVersion => ({
  version: String(value),
  created_at: createdAt,
  credentials,
});

const context = (
  versions: readonly ResolvedWebhookCredentialVersion[],
): WebhookProfileRuntimeContext => ({
  ingress_id: 'whi_d201staticheaderengine123',
  environment: 'test',
  credential_versions: versions,
  now: () => {
    throw new Error('static header token must not read a clock');
  },
});

const request = (
  name: string,
  values: readonly string[],
): RawWebhookRequest => ({
  method: 'POST',
  raw_body: Buffer.from('{}', 'utf8'),
  headers: new Map([[name, values]]),
  raw_path_and_query: '/v1/webhooks/static-header-fixture',
  canonical_public_url:
    'https://hooks.example.test/v1/webhooks/static-header-fixture',
  received_at: 1,
  remote_ip: '127.0.0.1',
});

describe('D-201 Slices 9X + 9AW + 9BH static header-token mechanism engine', () => {
  it('authenticates an owner-configured header without widening credentials', () => {
    const mechanism = createWebhookStaticHeaderTokenMechanism(CONFIGURABLE);
    const runtime = context([
      version(1, { header_name: 'X-Profile-Token', header_token: 'secret one' }),
    ]);
    expect(mechanism.validateCredentialShape({
      header_name: 'X-Profile-Token',
      header_token: 'secret one',
    })).toBe(true);
    expect(mechanism.validateCredentialShape({
      header_name: 'X-Profile-Token',
      header_token: 'secret one',
      ignored: 'authority',
    })).toBe(false);
    expect(mechanism.authenticate(
      request('x-profile-token', ['secret one']),
      runtime,
    )).toEqual({ ok: true, credential_version: '1' });
    expect(mechanism.authenticate(
      request('x-profile-token', ['wrong']),
      runtime,
    )).toEqual({ ok: false, reason: 'authentication_failed' });
    expect(mechanism.authenticate(
      request('x-profile-token', ['secret one', 'secret one']),
      runtime,
    )).toEqual({ ok: false, reason: 'authentication_failed' });
  });

  it('selects the newest matching fixed-header credential deterministically', () => {
    const mechanism = createWebhookStaticHeaderTokenMechanism(FIXED);
    const runtime = context([
      version(2, { secret_token: 'same_secret' }, 20),
      version(1, { secret_token: 'same_secret' }, 10),
    ]);
    expect(mechanism.authenticate(
      request('x-provider-secret-token', ['same_secret']),
      runtime,
    )).toEqual({ ok: true, credential_version: '2' });
    expect(mechanism.buildPresentation(runtime, 'oldest')).toEqual({
      credential_version: '1',
      header_name: 'x-provider-secret-token',
      header_value: 'same_secret',
    });
    expect(mechanism.buildPresentation(runtime, 'newest')).toEqual({
      credential_version: '2',
      header_name: 'x-provider-secret-token',
      header_value: 'same_secret',
    });
  });

  it('enforces each closed token grammar without coercion', () => {
    const generic = createWebhookStaticHeaderTokenMechanism(CONFIGURABLE);
    for (const token of ['', ' padded ', 'bad\nvalue', 'x'.repeat(8_193)]) {
      expect(generic.validateCredentialShape({
        header_name: 'x-token',
        header_token: token,
      })).toBe(false);
    }
    const generated = createWebhookStaticHeaderTokenMechanism(FIXED);
    for (const token of ['', 'contains spaces', 'bad!', 'x'.repeat(257)]) {
      expect(generated.validateCredentialShape({ secret_token: token })).toBe(false);
    }
    expect(generated.validateCredentialShape({ secret_token: 'a_B-9' })).toBe(true);
  });

  it('fails malformed runtime configuration without throwing', () => {
    const mechanism = createWebhookStaticHeaderTokenMechanism(FIXED);
    expect(mechanism.authenticate(
      request('x-provider-secret-token', ['secret']),
      context([]),
    )).toEqual({ ok: false, reason: 'configuration_failed' });
    const sparse = new Array(1) as ResolvedWebhookCredentialVersion[];
    expect(mechanism.hasValidConfiguration(context(sparse))).toBe(false);
    expect(mechanism.buildPresentation(context(sparse), 'newest')).toBeNull();
    expect(mechanism.authenticate(
      request('x-provider-secret-token', ['secret']),
      context([
        version(1, { secret_token: 'one' }),
        version(2, { secret_token: 'two' }),
        version(3, { secret_token: 'three' }),
      ]),
    )).toEqual({ ok: false, reason: 'configuration_failed' });
  });

  it('uses core credential-version admission without coercion', () => {
    const mechanism = createWebhookStaticHeaderTokenMechanism(FIXED);
    const contextWithVersion = (value: unknown): WebhookProfileRuntimeContext =>
      context([{
        version: value as string,
        created_at: 1,
        credentials: { secret_token: 'secret' },
      }]);

    expect(mechanism.hasValidConfiguration(
      contextWithVersion(String(Number.MAX_SAFE_INTEGER)),
    )).toBe(true);

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
      const invalidContext = contextWithVersion(invalid);
      expect(mechanism.hasValidConfiguration(invalidContext)).toBe(false);
      expect(mechanism.authenticate(
        request('x-provider-secret-token', ['secret']),
        invalidContext,
      )).toEqual({ ok: false, reason: 'configuration_failed' });
      expect(mechanism.buildPresentation(invalidContext, 'newest')).toBeNull();
    }
    expect(coercions).toBe(0);
  });

  it('accepts only exact own-data frozen serializable presets', () => {
    const mechanism = createWebhookStaticHeaderTokenMechanism(FIXED);
    expect(mechanism.preset).toEqual(FIXED);
    expect(Object.isFrozen(mechanism)).toBe(true);
    expect(Object.isFrozen(mechanism.preset)).toBe(true);
    expect(Object.isFrozen(mechanism.preset.token_header)).toBe(true);
    expect(() => JSON.stringify(mechanism.preset)).not.toThrow();

    for (const invalid of [
      { ...FIXED, extra: true },
      { ...FIXED, kind: 'callback_token.v1' },
      { ...FIXED, token_shape: 'unbounded.v1' },
      { ...FIXED, token_shape: 'ascii_alphanumeric_underscore_dash_256.v1' },
      {
        ...FIXED,
        token_shape: {
          kind: 'bounded_ascii_token.v1',
          max_characters: 256,
          regex: '.*',
        },
      },
      { ...FIXED, matching_credential: 'all' },
      { ...FIXED, token_header: { kind: 'fixed', name: 'Host' } },
      { ...FIXED, token_header: { kind: 'credential_field', field: 'secret_token' } },
      Object.create(FIXED),
      new Proxy(FIXED, {
        ownKeys() {
          throw new Error('hostile preset');
        },
      }),
    ]) {
      expect(() => createWebhookStaticHeaderTokenMechanism(invalid as never))
        .toThrow('invalid trusted preset');
    }

    let accessorCalls = 0;
    const accessor = { ...FIXED } as Record<string, unknown>;
    Object.defineProperty(accessor, 'token_shape', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return FIXED.token_shape;
      },
    });
    expect(() => createWebhookStaticHeaderTokenMechanism(accessor as never))
      .toThrow('invalid trusted preset');
    expect(accessorCalls).toBe(0);

    let proxyGets = 0;
    const deceptiveHeader = new Proxy(FIXED.token_header, {
      get() {
        proxyGets += 1;
        throw new Error('validated preset must not be copied through get');
      },
    });
    expect(createWebhookStaticHeaderTokenMechanism({
      ...FIXED,
      token_header: deceptiveHeader,
    }).preset).toEqual(FIXED);
    expect(proxyGets).toBe(0);
  });
});
