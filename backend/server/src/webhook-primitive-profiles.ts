/** D-201 Slices 3 + 8K + 8L + 9X-9Y + 9BH — exact generic webhook profile adapters.
 *
 * These are trusted, server-only protocol implementations. They deliberately
 * expose no signing-base template, algorithm selector, owner decoder selector,
 * tolerance override, or network hook. Production composes the timestamped
 * adapter only through Slice 5B2B2B2B's bounded clock-health wrapper.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  MAX_ACTIVE_WEBHOOK_CREDENTIAL_VERSIONS,
  type WebhookProfileId,
} from '@recued/contracts';
import {
  readTrustedWebhookClockNow,
  type WebhookClockHealthAuthority,
} from './webhook-clock-health.js';
import { WEBHOOK_CREDENTIAL_VERSION_PARSER } from './webhook-core-identity-parsers.js';
import {
  createWebhookProfileRuntimeRegistry,
  type RawWebhookRequest,
  type ResolvedWebhookCredentialVersion,
  type WebhookIngressProfileAdapter,
  type WebhookProfileResult,
  type WebhookProfileRuntimeContext,
  type WebhookProfileRuntimeRegistry,
  type WebhookProfileTestDeliveryInput,
} from './webhook-profile-runtime.js';
import {
  createWebhookJsonObjectDecoder,
  WEBHOOK_JSON_OBJECT_DECODER_V1,
  type WebhookJsonObjectDecoder,
} from './webhook-json-object-decoder.js';
import {
  webhookRawBodyHmacDeliveryProfilePreset,
  webhookStaticHeaderTokenDeliveryProfilePreset,
  webhookTimestampedHmacDeliveryProfilePreset,
} from './webhook-delivery-engine-presets.js';
import {
  createWebhookRawBodyHmacMechanism,
} from './webhook-raw-body-hmac-engine.js';
import {
  createWebhookTimestampedHmacMechanism,
  WEBHOOK_TIMESTAMPED_HMAC_REPLAY_WINDOW_SECONDS,
} from './webhook-timestamped-hmac-engine.js';
import {
  createWebhookStaticHeaderTokenMechanism,
} from './webhook-static-header-token-engine.js';

export const GENERIC_WEBHOOK_FINGERPRINT_WINDOW_MS = 5 * 60 * 1_000;
export const GENERIC_TIMESTAMPED_HMAC_REPLAY_WINDOW_SECONDS =
  WEBHOOK_TIMESTAMPED_HMAC_REPLAY_WINDOW_SECONDS;

export const PRIMITIVE_WEBHOOK_PROFILE_IDS = [
  'generic.static-header-token.v1',
  'generic.http-basic.v1',
  'generic.raw-body-hmac-sha256.v1',
  'generic.timestamped-raw-body-hmac-sha256.v1',
] as const satisfies readonly WebhookProfileId[];

const SUCCESS_RESPONSE = Object.freeze({ status: 202 } as const);
const MAX_HEADER_VALUE_BYTES = 8_192;
const TEST_DELIVERY_NONCE_RE = /^[0-9a-f]{64}$/;

const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/;

interface BasicCredential {
  version: string;
  created_at: number;
  expected: Buffer;
}

const authenticationFailure = (): WebhookProfileResult => ({
  ok: false,
  failure: {
    disposition: 'reject',
    code: 'authentication_failed',
    response: { status: 401 },
  },
});

const structuralFailure = (): WebhookProfileResult => ({
  ok: false,
  failure: {
    disposition: 'reject',
    code: 'structural_admission_failed',
    response: { status: 400 },
  },
});

const configurationFailure = (): WebhookProfileResult => ({
  ok: false,
  failure: {
    disposition: 'retry',
    code: 'profile_internal_error',
    response: { status: 503 },
  },
});

const dependencyFailure = (): WebhookProfileResult => ({
  ok: false,
  failure: {
    disposition: 'retry',
    code: 'profile_dependency_unavailable',
    response: { status: 503 },
  },
});

const ownString = (
  record: Readonly<Record<string, string>>,
  key: string,
): string | null => {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
    ? descriptor.value
    : null;
};

const hasExactCredentialFields = (
  record: Readonly<Record<string, string>>,
  expected: readonly string[],
): boolean => {
  try {
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const ownKeys = Reflect.ownKeys(record);
    if (ownKeys.some((key) => typeof key !== 'string')) return false;
    const keys = (ownKeys as string[]).sort();
    const expectedKeys = [...expected].sort();
    return keys.length === expectedKeys.length
      && keys.every((key, index) => key === expectedKeys[index])
      && keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        return descriptor !== undefined
          && descriptor.enumerable
          && 'value' in descriptor
          && typeof descriptor.value === 'string';
      });
  } catch {
    return false;
  }
};

const validCredentialVersion = (
  value: ResolvedWebhookCredentialVersion,
): boolean => WEBHOOK_CREDENTIAL_VERSION_PARSER.parse(value.version).ok
  && Number.isSafeInteger(value.created_at)
  && value.created_at >= 0;

const exactHeaderValue = (
  request: RawWebhookRequest,
  name: string,
): string | null => {
  const values = request.headers.get(name);
  return values?.length === 1 && typeof values[0] === 'string'
    ? values[0]
    : null;
};

const digestForCompare = (value: string | Uint8Array): Buffer =>
  createHash('sha256').update(value).digest();

const constantTimeEqual = (
  left: string | Uint8Array,
  right: string | Uint8Array,
): boolean => timingSafeEqual(digestForCompare(left), digestForCompare(right));

const bodySha256 = (request: RawWebhookRequest): string =>
  createHash('sha256').update(request.raw_body).digest('hex');

const windowedDedupKey = (
  profileId: WebhookProfileId,
  request: RawWebhookRequest,
): string | null => {
  if (!Number.isSafeInteger(request.received_at) || request.received_at < 0) {
    return null;
  }
  const bucket = Math.floor(
    request.received_at / GENERIC_WEBHOOK_FINGERPRINT_WINDOW_MS,
  );
  return `generic:${profileId}:w${bucket}:${bodySha256(request)}`;
};

const timestampedDedupKey = (
  profileId: WebhookProfileId,
  timestamp: string,
  request: RawWebhookRequest,
): string => `generic:${profileId}:t${timestamp}:${bodySha256(request)}`;

const acceptedDelivery = (input: {
  delivery_dedup_key: string;
  credential_version: string;
  method_label: string;
  freshness_checked: boolean;
  payload: Record<string, unknown>;
}): WebhookProfileResult => ({
  ok: true,
  delivery: {
    delivery_dedup_key: input.delivery_dedup_key,
    decoded_content_type: 'application/json',
    events: [{
      event_dedup_key: `${input.delivery_dedup_key}:0`,
      provider_event_id: null,
      provider_resource_id: null,
      provider_event_type: 'delivery',
      provider_occurred_at: null,
      decoded_payload: input.payload,
    }],
    response: SUCCESS_RESPONSE,
    admission: {
      transport_assurance: 'authenticated',
      credential_version: input.credential_version,
      freshness_checked: input.freshness_checked,
      method_label: input.method_label,
    },
  },
});

const configuredBasicCredentials = (
  context: WebhookProfileRuntimeContext,
): BasicCredential[] | null => {
  if (context.credential_versions.length === 0
    || context.credential_versions.length > MAX_ACTIVE_WEBHOOK_CREDENTIAL_VERSIONS) {
    return null;
  }
  const configured: BasicCredential[] = [];
  for (const version of context.credential_versions) {
    if (!validCredentialVersion(version)
      || !hasExactCredentialFields(version.credentials, ['password', 'username'])) {
      return null;
    }
    const username = ownString(version.credentials, 'username');
    const password = ownString(version.credentials, 'password');
    if (username === null || password === null
      || username.length === 0 || password.length === 0
      || username.includes(':')
      || CONTROL_CHARACTER_RE.test(username)
      || CONTROL_CHARACTER_RE.test(password)) {
      return null;
    }
    const expected = Buffer.from(`${username}:${password}`, 'utf8');
    if (expected.byteLength > MAX_HEADER_VALUE_BYTES) return null;
    configured.push({
      version: version.version,
      created_at: version.created_at,
      expected,
    });
  }
  return configured;
};

const newestCredential = <T extends { version: string; created_at: number }>(
  credentials: readonly T[],
): T => credentials.reduce((newest, candidate) =>
  candidate.created_at > newest.created_at
    || (candidate.created_at === newest.created_at
      && Number(candidate.version) > Number(newest.version))
    ? candidate
    : newest);

const primitiveTestBody = (nonce: string): Buffer => {
  if (!TEST_DELIVERY_NONCE_RE.test(nonce)) {
    throw new Error('webhook primitive test delivery nonce is invalid');
  }
  return Buffer.from(JSON.stringify({
    recued_test_delivery: {
      nonce,
    },
  }), 'utf8');
};

const oneTestHeader = (name: string, value: string): Record<string, string> => {
  const headers = Object.create(null) as Record<string, string>;
  headers[name] = value;
  return headers;
};

/** Apply the same closed credential-shape checks at control-plane write time
 * that the primitive adapters apply again at delivery time. `null` means the
 * profile is outside this primitive family; callers must not mistake that for
 * a successful validation of a vendor profile. */
export const validatePrimitiveWebhookCredentialShape = (
  profileId: WebhookProfileId,
  credentials: Readonly<Record<string, string>>,
): boolean | null => {
  const context: WebhookProfileRuntimeContext = {
    ingress_id: 'credential-shape-validation',
    environment: 'custom',
    credential_versions: [{
      version: '1',
      created_at: 0,
      credentials,
    }],
    now: () => 0,
  };
  switch (profileId) {
    case 'generic.static-header-token.v1':
      return staticHeaderTokenMechanism.validateCredentialShape(credentials);
    case 'generic.http-basic.v1':
      return configuredBasicCredentials(context) !== null;
    case 'generic.raw-body-hmac-sha256.v1':
      return rawBodyHmacMechanism.validateCredentialShape(credentials);
    case 'generic.timestamped-raw-body-hmac-sha256.v1':
      return timestampedHmacMechanism.validateCredentialShape(credentials);
    default:
      return null;
  }
};

const parseCanonicalBasic = (value: string | null): Buffer | null => {
  if (value === null) return null;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match) return null;
  const encoded = match[1]!;
  if (encoded.length % 4 !== 0) return null;
  const decoded = Buffer.from(encoded, 'base64');
  return decoded.toString('base64') === encoded ? decoded : null;
};

const decodeAndAccept = (input: {
  profile_id: WebhookProfileId;
  request: RawWebhookRequest;
  credential_version: string;
  method_label: string;
  freshness_checked: boolean;
  timestamp_literal?: string;
  decoder?: WebhookJsonObjectDecoder;
}): WebhookProfileResult => {
  const payload = (input.decoder ?? WEBHOOK_JSON_OBJECT_DECODER_V1)
    .decode(input.request.raw_body);
  if (payload === null) return structuralFailure();
  const deliveryKey = input.timestamp_literal === undefined
    ? windowedDedupKey(input.profile_id, input.request)
    : timestampedDedupKey(
        input.profile_id,
        input.timestamp_literal,
        input.request,
      );
  if (deliveryKey === null) return configurationFailure();
  return acceptedDelivery({
    delivery_dedup_key: deliveryKey,
    credential_version: input.credential_version,
    method_label: input.method_label,
    freshness_checked: input.freshness_checked,
    payload,
  });
};

const staticHeaderTokenDeliveryPreset =
  webhookStaticHeaderTokenDeliveryProfilePreset(
    'generic.static-header-token.v1',
  );
if (staticHeaderTokenDeliveryPreset === null) {
  throw new Error('generic static header-token delivery preset is unavailable');
}
const staticHeaderTokenMechanism = createWebhookStaticHeaderTokenMechanism(
  staticHeaderTokenDeliveryPreset.mechanism,
);
const staticHeaderTokenDecoder = createWebhookJsonObjectDecoder(
  staticHeaderTokenDeliveryPreset.decoder,
);
export const GENERIC_STATIC_HEADER_TOKEN_MECHANISM_PRESET =
  staticHeaderTokenDeliveryPreset.mechanism;
export const GENERIC_STATIC_HEADER_TOKEN_JSON_OBJECT_DECODER_PRESET =
  staticHeaderTokenDeliveryPreset.decoder;

const staticHeaderTokenAdapter: WebhookIngressProfileAdapter = Object.freeze({
  profile_id: 'generic.static-header-token.v1',
  success_response: SUCCESS_RESPONSE,
  buildTestDelivery(
    input: WebhookProfileTestDeliveryInput,
    context: WebhookProfileRuntimeContext,
  ) {
    const presentation = staticHeaderTokenMechanism.buildPresentation(
      context,
      'newest',
    );
    if (presentation === null) {
      throw new Error('webhook primitive test credentials are unavailable');
    }
    return {
      raw_body: primitiveTestBody(input.nonce),
      headers: oneTestHeader(
        presentation.header_name,
        presentation.header_value,
      ),
    };
  },
  async verifyAndDecode(
    request: RawWebhookRequest,
    context: WebhookProfileRuntimeContext,
  ) {
    const authenticated = staticHeaderTokenMechanism.authenticate(request, context);
    if (!authenticated.ok) {
      return authenticated.reason === 'configuration_failed'
        ? configurationFailure()
        : authenticationFailure();
    }
    return decodeAndAccept({
      profile_id: 'generic.static-header-token.v1',
      request,
      credential_version: authenticated.credential_version,
      method_label: 'static-header-token',
      freshness_checked: false,
      decoder: staticHeaderTokenDecoder,
    });
  },
});

const httpBasicAdapter: WebhookIngressProfileAdapter = Object.freeze({
  profile_id: 'generic.http-basic.v1',
  success_response: SUCCESS_RESPONSE,
  buildTestDelivery(
    input: WebhookProfileTestDeliveryInput,
    context: WebhookProfileRuntimeContext,
  ) {
    const credentials = configuredBasicCredentials(context);
    if (credentials === null || credentials.length === 0) {
      throw new Error('webhook primitive test credentials are unavailable');
    }
    const active = newestCredential(credentials);
    let authorization: string;
    try {
      authorization = `Basic ${active.expected.toString('base64')}`;
    } finally {
      for (const credential of credentials) credential.expected.fill(0);
    }
    return {
      raw_body: primitiveTestBody(input.nonce),
      headers: oneTestHeader('authorization', authorization),
    };
  },
  async verifyAndDecode(
    request: RawWebhookRequest,
    context: WebhookProfileRuntimeContext,
  ) {
    const credentials = configuredBasicCredentials(context);
    if (credentials === null) return configurationFailure();
    const candidate = parseCanonicalBasic(exactHeaderValue(request, 'authorization'));
    if (candidate === null) return authenticationFailure();
    const match = credentials.find((credential) =>
      constantTimeEqual(candidate, credential.expected));
    if (!match) return authenticationFailure();
    return decodeAndAccept({
      profile_id: 'generic.http-basic.v1',
      request,
      credential_version: match.version,
      method_label: 'http-basic',
      freshness_checked: false,
    });
  },
});

const rawBodyHmacDeliveryPreset = webhookRawBodyHmacDeliveryProfilePreset(
  'generic.raw-body-hmac-sha256.v1',
);
if (rawBodyHmacDeliveryPreset === null) {
  throw new Error('generic raw-body HMAC delivery preset is unavailable');
}
const rawBodyHmacMechanism = createWebhookRawBodyHmacMechanism(
  rawBodyHmacDeliveryPreset.mechanism,
);
const rawBodyHmacDecoder = createWebhookJsonObjectDecoder(
  rawBodyHmacDeliveryPreset.decoder,
);
export const GENERIC_RAW_BODY_HMAC_MECHANISM_PRESET =
  rawBodyHmacDeliveryPreset.mechanism;

const rawBodyHmacAdapter: WebhookIngressProfileAdapter = Object.freeze({
  profile_id: 'generic.raw-body-hmac-sha256.v1',
  success_response: SUCCESS_RESPONSE,
  buildTestDelivery(
    input: WebhookProfileTestDeliveryInput,
    context: WebhookProfileRuntimeContext,
  ) {
    if (!rawBodyHmacMechanism.hasValidConfiguration(context)) {
      throw new Error('webhook primitive test credentials are unavailable');
    }
    const rawBody = primitiveTestBody(input.nonce);
    const signature = rawBodyHmacMechanism.sign(rawBody, context, 'newest');
    if (signature === null) {
      throw new Error('webhook primitive test credentials are unavailable');
    }
    return {
      raw_body: rawBody,
      headers: oneTestHeader(signature.header_name, signature.header_value),
    };
  },
  async verifyAndDecode(
    request: RawWebhookRequest,
    context: WebhookProfileRuntimeContext,
  ) {
    const authenticated = rawBodyHmacMechanism.authenticate(request, context);
    if (!authenticated.ok) {
      return authenticated.reason === 'configuration_failed'
        ? configurationFailure()
        : authenticationFailure();
    }
    return decodeAndAccept({
      profile_id: 'generic.raw-body-hmac-sha256.v1',
      request,
      credential_version: authenticated.credential_version,
      method_label: 'raw-body-hmac-sha256',
      freshness_checked: false,
      decoder: rawBodyHmacDecoder,
    });
  },
});

const timestampedHmacDeliveryPreset = webhookTimestampedHmacDeliveryProfilePreset(
  'generic.timestamped-raw-body-hmac-sha256.v1',
);
if (timestampedHmacDeliveryPreset === null) {
  throw new Error('generic timestamped HMAC delivery preset is unavailable');
}
const timestampedHmacMechanism = createWebhookTimestampedHmacMechanism(
  timestampedHmacDeliveryPreset.mechanism,
);
export const GENERIC_TIMESTAMPED_HMAC_MECHANISM_PRESET =
  timestampedHmacDeliveryPreset.mechanism;

const buildTimestampedHmacTestDelivery = (
  input: WebhookProfileTestDeliveryInput,
  context: WebhookProfileRuntimeContext,
) => {
  if (!timestampedHmacMechanism.hasValidConfiguration(context)) {
    throw new Error('webhook primitive test credentials are unavailable');
  }
  let nowMilliseconds: number;
  try {
    nowMilliseconds = context.now();
  } catch {
    throw new Error('webhook primitive trusted clock is unavailable');
  }
  if (!Number.isSafeInteger(nowMilliseconds) || nowMilliseconds < 1_000) {
    throw new Error('webhook primitive trusted clock is unavailable');
  }
  const timestamp = String(Math.floor(nowMilliseconds / 1_000));
  const rawBody = primitiveTestBody(input.nonce);
  const signature = timestampedHmacMechanism.sign(
    rawBody,
    { ...context, now: () => nowMilliseconds },
    'newest',
  );
  if (signature === null || signature.timestamp_literal !== timestamp) {
    throw new Error('webhook primitive test credentials are unavailable');
  }
  return {
    raw_body: rawBody,
    headers: oneTestHeader(signature.header_name, signature.header_value),
  };
};

const timestampedHmacAdapter: WebhookIngressProfileAdapter = Object.freeze({
  profile_id: 'generic.timestamped-raw-body-hmac-sha256.v1',
  success_response: SUCCESS_RESPONSE,
  async verifyAndDecode(
    request: RawWebhookRequest,
    context: WebhookProfileRuntimeContext,
  ) {
    const authenticated = timestampedHmacMechanism.authenticate(request, context);
    if (!authenticated.ok) {
      return authenticated.reason === 'configuration_failed'
        ? configurationFailure()
        : authenticationFailure();
    }
    return decodeAndAccept({
      profile_id: 'generic.timestamped-raw-body-hmac-sha256.v1',
      request,
      credential_version: authenticated.credential_version,
      method_label: 'timestamped-hmac-sha256',
      freshness_checked: true,
      timestamp_literal: authenticated.timestamp_literal,
    });
  },
});

/** Production-only timestamped primitive. Every verification and simulator
 * request obtains a fresh bounded lease from the shared clock authority and
 * replaces the caller's local wall clock with the authority-derived instant. */
export const createClockGatedTimestampedHmacWebhookProfileAdapter = (
  authority: WebhookClockHealthAuthority,
): WebhookIngressProfileAdapter => Object.freeze({
  profile_id: timestampedHmacAdapter.profile_id,
  success_response: timestampedHmacAdapter.success_response,
  async buildTestDelivery(
    input: WebhookProfileTestDeliveryInput,
    context: WebhookProfileRuntimeContext,
  ) {
    const now = await readTrustedWebhookClockNow(authority);
    if (now === null) {
      throw new Error('webhook primitive trusted clock is unavailable');
    }
    return buildTimestampedHmacTestDelivery(input, {
      ...context,
      now: () => now,
    });
  },
  async verifyAndDecode(
    request: RawWebhookRequest,
    context: WebhookProfileRuntimeContext,
  ) {
    const now = await readTrustedWebhookClockNow(authority);
    if (now === null) return dependencyFailure();
    return timestampedHmacAdapter.verifyAndDecode(request, {
      ...context,
      now: () => now,
    });
  },
});

/** Return only generic primitives. Vendor adapters remain absent until their
 * later D-201 slices; production composition selects its admitted subset. */
export const createPrimitiveWebhookProfileAdapters = (
): readonly WebhookIngressProfileAdapter[] => Object.freeze([
  staticHeaderTokenAdapter,
  httpBasicAdapter,
  rawBodyHmacAdapter,
  timestampedHmacAdapter,
]);

export const createPrimitiveWebhookProfileRuntimeRegistry = (
): WebhookProfileRuntimeRegistry => createWebhookProfileRuntimeRegistry(
  createPrimitiveWebhookProfileAdapters(),
);
