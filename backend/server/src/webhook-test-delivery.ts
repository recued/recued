/** D-201 Slice 5B2B2B2A — profile-aware public-path test delivery.
 *
 * A trusted profile builds one bounded authenticated request. Core fixes its
 * destination to the ingress's already-confirmed canonical HTTPS endpoint,
 * refuses redirects, sends it through the ordinary listener, and reports
 * success only after the exact nonce-bearing raw body is present in the
 * durable accepted-delivery store. There is no in-process admission shortcut
 * and no test-only dispatch bypass.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  webhookProfile,
  type AcceptedWebhookDeliveryRecord,
  type WebhookIngressRecord,
  type WebhookProfileId,
} from '@recued/contracts';
import type { WebhookIngressStore } from './storage/webhook-ingress-store.js';
import type { WebhookDeliveryStore } from './storage/webhook-delivery-store.js';
import type {
  ResolvedWebhookCredentialVersion,
  WebhookProfileRuntimeContext,
  WebhookProfileRuntimeRegistry,
  WebhookProfileTestDeliveryRequest,
} from './webhook-profile-runtime.js';

const DEFAULT_TEST_DELIVERY_TIMEOUT_MS = 10_000;
const MAX_TEST_HEADERS = 16;
const MAX_HEADER_NAME_BYTES = 128;
const MAX_HEADER_VALUE_BYTES = 8_192;
const MAX_HEADER_TOTAL_BYTES = 32_768;
const MAX_ENDPOINT_BYTES = 4_096;
const TEST_NONCE_RE = /^[0-9a-f]{64}$/;
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]+$/;
const FORBIDDEN_TEST_HEADERS = new Set([
  'connection',
  'content-length',
  'content-type',
  'expect',
  'forwarded',
  'host',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
  'x-real-ip',
]);

export type WebhookTestDeliveryErrorCode =
  | 'unsupported'
  | 'invalid_state'
  | 'profile_unavailable'
  | 'request_failed'
  | 'not_observed'
  | 'accepted_response_unconfirmed'
  | 'accepted_state_changed';

export class WebhookTestDeliveryError extends Error {
  constructor(
    readonly code: WebhookTestDeliveryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WebhookTestDeliveryError';
  }
}

export interface WebhookTestDeliveryResult {
  delivery_id: string;
  observed_at: number;
}

export interface WebhookTestDeliveryService {
  supports(profileId: WebhookProfileId): boolean;
  deliver(input: {
    ingress: WebhookIngressRecord;
    endpoint_url: string;
  }): Promise<WebhookTestDeliveryResult>;
}

export interface WebhookTestDeliveryServiceOptions {
  ingressStore: WebhookIngressStore;
  deliveryStore: WebhookDeliveryStore;
  profiles: WebhookProfileRuntimeRegistry;
  fetchImpl?: typeof fetch;
  now?: () => number;
  newNonce?: () => string;
  timeoutMs?: number;
}

const clearCredentials = (
  versions: readonly ResolvedWebhookCredentialVersion[],
): void => {
  for (const version of versions) {
    const credentials = version.credentials as Record<string, string>;
    for (const key of Object.keys(credentials)) {
      try {
        credentials[key] = '';
      } catch {
        // Dropping the reference remains safe if a trusted implementation
        // froze its credential view.
      }
    }
  }
};

const clearHeaders = (headers: unknown): void => {
  if (headers === null || typeof headers !== 'object') return;
  const mutable = headers as Record<string, string>;
  let keys: string[];
  try {
    keys = Object.keys(mutable);
  } catch {
    return;
  }
  for (const key of keys) {
    try {
      mutable[key] = '';
    } catch {
      // A frozen trusted adapter result is still dropped immediately.
    }
  }
};

const normalizedHeaders = (
  value: Readonly<Record<string, string>>,
): Record<string, string> => {
  let prototype: object | null;
  let ownKeys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    ownKeys = Reflect.ownKeys(value);
  } catch {
    throw new WebhookTestDeliveryError(
      'profile_unavailable',
      'webhook test profile emitted invalid headers',
    );
  }
  if ((prototype !== Object.prototype && prototype !== null)
    || ownKeys.length < 1
    || ownKeys.length > MAX_TEST_HEADERS
    || ownKeys.some((key) => typeof key !== 'string')) {
    throw new WebhookTestDeliveryError(
      'profile_unavailable',
      'webhook test profile emitted invalid headers',
    );
  }
  const headers = Object.create(null) as Record<string, string>;
  let totalBytes = 0;
  for (const key of ownKeys as string[]) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      descriptor = undefined;
    }
    const headerValue = descriptor && 'value' in descriptor
      ? descriptor.value
      : undefined;
    const normalized = key.toLowerCase();
    const nameBytes = Buffer.byteLength(key, 'utf8');
    const valueBytes = typeof headerValue === 'string'
      ? Buffer.byteLength(headerValue, 'utf8')
      : MAX_HEADER_VALUE_BYTES + 1;
    if (!descriptor?.enumerable
      || typeof headerValue !== 'string'
      || key !== normalized
      || nameBytes < 1
      || nameBytes > MAX_HEADER_NAME_BYTES
      || !HEADER_NAME_RE.test(key)
      || valueBytes < 1
      || valueBytes > MAX_HEADER_VALUE_BYTES
      || !PRINTABLE_ASCII_RE.test(headerValue)
      || FORBIDDEN_TEST_HEADERS.has(normalized)
      || normalized.startsWith('content-')
      || normalized.startsWith('x-forwarded-')
      || Object.prototype.hasOwnProperty.call(headers, normalized)) {
      throw new WebhookTestDeliveryError(
        'profile_unavailable',
        'webhook test profile emitted invalid headers',
      );
    }
    totalBytes += nameBytes + valueBytes;
    if (totalBytes > MAX_HEADER_TOTAL_BYTES) {
      throw new WebhookTestDeliveryError(
        'profile_unavailable',
        'webhook test profile emitted invalid headers',
      );
    }
    headers[normalized] = headerValue;
  }
  return headers;
};

const validEndpoint = (
  endpoint: string,
  ingress: WebhookIngressRecord,
): boolean => {
  if (Buffer.byteLength(endpoint, 'utf8') > MAX_ENDPOINT_BYTES
    || ingress.confirmed_endpoint_url !== endpoint) return false;
  try {
    const parsed = new URL(endpoint);
    return parsed.protocol === 'https:'
      && parsed.username.length === 0
      && parsed.password.length === 0
      && parsed.search.length === 0
      && parsed.hash.length === 0
      && parsed.pathname.endsWith(`/v1/webhooks/${ingress.public_id}`)
      && parsed.href === endpoint;
  } catch {
    return false;
  }
};

const sameStrings = (
  left: readonly string[],
  right: readonly string[],
): boolean => left.length === right.length
  && left.every((value, index) => value === right[index]);

const ingressStillEligible = (
  store: WebhookIngressStore,
  original: WebhookIngressRecord,
  endpointUrl: string,
): boolean => {
  try {
    const current = store.get(original.ingress_id);
    return current !== null
      && current.public_id === original.public_id
      && current.profile_id === original.profile_id
      && current.environment === original.environment
      && current.registration_mode === original.registration_mode
      && current.registration_state === original.registration_state
      && current.confirmed_endpoint_url === endpointUrl
      && current.credential_set_ref === original.credential_set_ref
      && sameStrings(current.selected_event_types, original.selected_event_types)
      && (current.intake_state === 'enabled'
        || current.intake_state === 'degraded');
  } catch {
    return false;
  }
};

interface ActiveCredentialIdentity {
  version: string;
  created_at: number;
}

const activeCredentialsStillMatch = (
  store: WebhookIngressStore,
  ingressId: string,
  expected: readonly ActiveCredentialIdentity[],
): boolean => {
  try {
    const current = store.listCredentialVersions(ingressId)
      .filter((version) => version.active)
      .map((version) => ({
        version: version.version,
        created_at: version.created_at,
      }));
    const expectedByVersion = new Map(
      expected.map((version) => [version.version, version.created_at]),
    );
    return current.length === expectedByVersion.size
      && current.every((version) =>
        expectedByVersion.get(version.version) === version.created_at);
  } catch {
    return false;
  }
};

const validateBuiltRequest = (
  value: WebhookProfileTestDeliveryRequest,
  maxBodyBytes: number,
): { raw_body: Buffer; headers: Record<string, string> } => {
  if (value === null || typeof value !== 'object'
    || !Buffer.isBuffer(value.raw_body)
    || value.raw_body.byteLength < 1
    || value.raw_body.byteLength > maxBodyBytes
    || value.headers === null
    || typeof value.headers !== 'object') {
    throw new WebhookTestDeliveryError(
      'profile_unavailable',
      'webhook test profile emitted an invalid request',
    );
  }
  return {
    raw_body: value.raw_body,
    headers: normalizedHeaders(value.headers),
  };
};

const observedDelivery = (
  store: WebhookDeliveryStore,
  ingress: WebhookIngressRecord,
  rawBodySha256: string,
): AcceptedWebhookDeliveryRecord | null => {
  let delivery: AcceptedWebhookDeliveryRecord | null;
  try {
    delivery = store.findDeliveryByRawBodySha256(
      ingress.ingress_id,
      rawBodySha256,
    );
  } catch {
    throw new WebhookTestDeliveryError(
      'profile_unavailable',
      'webhook test delivery observation is unavailable',
    );
  }
  if (!delivery) return null;
  if (delivery.ingress_id !== ingress.ingress_id
    || delivery.profile_id !== ingress.profile_id
    || delivery.environment !== ingress.environment
    || delivery.raw_body_sha256 !== rawBodySha256) {
    throw new WebhookTestDeliveryError(
      'profile_unavailable',
      'webhook test delivery identity is corrupt',
    );
  }
  return delivery;
};

export const createWebhookTestDeliveryService = (
  options: WebhookTestDeliveryServiceOptions,
): WebhookTestDeliveryService => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const newNonce = options.newNonce ?? (() => randomBytes(32).toString('hex'));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TEST_DELIVERY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('webhook test delivery timeout must be in 1..60000');
  }

  const supports = (profileId: WebhookProfileId): boolean => {
    const descriptor = webhookProfile(profileId);
    return descriptor !== null
      && descriptor.allowed_methods.includes('POST')
      && descriptor.allowed_content_types.includes('application/json')
      && options.profiles.get(profileId)?.buildTestDelivery !== undefined;
  };

  return Object.freeze({
    supports,
    async deliver({ ingress, endpoint_url: endpointUrl }: {
      ingress: WebhookIngressRecord;
      endpoint_url: string;
    }): Promise<WebhookTestDeliveryResult> {
      if (ingress.environment !== 'test'
        || (ingress.intake_state !== 'enabled'
          && ingress.intake_state !== 'degraded')) {
        throw new WebhookTestDeliveryError(
          'invalid_state',
          'webhook test delivery requires an enabled test-environment ingress',
        );
      }
      if (!validEndpoint(endpointUrl, ingress)) {
        throw new WebhookTestDeliveryError(
          'invalid_state',
          'webhook test delivery requires the confirmed canonical endpoint',
        );
      }
      if (!ingressStillEligible(options.ingressStore, ingress, endpointUrl)) {
        throw new WebhookTestDeliveryError(
          'invalid_state',
          'webhook ingress changed before the test delivery started',
        );
      }
      const descriptor = webhookProfile(ingress.profile_id);
      const adapter = options.profiles.get(ingress.profile_id);
      if (!descriptor || !adapter?.buildTestDelivery || !supports(ingress.profile_id)) {
        throw new WebhookTestDeliveryError(
          'unsupported',
          'webhook profile does not provide a test delivery',
        );
      }

      let nonce: string;
      try {
        nonce = newNonce();
      } catch {
        throw new WebhookTestDeliveryError(
          'profile_unavailable',
          'webhook test nonce source is unavailable',
        );
      }
      if (!TEST_NONCE_RE.test(nonce)) {
        throw new WebhookTestDeliveryError(
          'profile_unavailable',
          'webhook test nonce source is unavailable',
        );
      }
      let credentialVersions: ResolvedWebhookCredentialVersion[] = [];
      let credentialSnapshot: ActiveCredentialIdentity[] = [];
      let built: WebhookProfileTestDeliveryRequest;
      try {
        const decrypted = await options.ingressStore.readActiveCredentialVersions(
          ingress.ingress_id,
        );
        try {
          credentialVersions = decrypted.map((version) => ({
            version: version.version,
            created_at: version.created_at,
            credentials: Object.assign(Object.create(null), version.credentials),
          })).sort((left, right) =>
            right.created_at - left.created_at
              || Number(right.version) - Number(left.version));
          credentialSnapshot = credentialVersions.map((version) => ({
            version: version.version,
            created_at: version.created_at,
          }));
        } finally {
          clearCredentials(decrypted);
        }
        const context: WebhookProfileRuntimeContext = {
          ingress_id: ingress.ingress_id,
          environment: ingress.environment,
          credential_versions: credentialVersions,
          now,
        };
        built = await adapter.buildTestDelivery({
          nonce,
          selected_event_types: [...ingress.selected_event_types],
        }, context);
      } catch (error) {
        if (error instanceof WebhookTestDeliveryError) throw error;
        throw new WebhookTestDeliveryError(
          'profile_unavailable',
          'webhook test profile could not build a request',
        );
      } finally {
        clearCredentials(credentialVersions);
      }

      let request: { raw_body: Buffer; headers: Record<string, string> };
      try {
        request = validateBuiltRequest(built, descriptor.max_body_bytes);
      } finally {
        clearHeaders(built && typeof built === 'object' ? built.headers : undefined);
      }
      if (!ingressStillEligible(options.ingressStore, ingress, endpointUrl)
        || !activeCredentialsStillMatch(
          options.ingressStore,
          ingress.ingress_id,
          credentialSnapshot,
        )) {
        clearHeaders(request.headers);
        request.raw_body.fill(0);
        throw new WebhookTestDeliveryError(
          'invalid_state',
          'webhook ingress changed while the test request was being built',
        );
      }
      const rawBodySha256 = createHash('sha256')
        .update(request.raw_body)
        .digest('hex');
      let alreadyObserved: AcceptedWebhookDeliveryRecord | null;
      try {
        alreadyObserved = observedDelivery(
          options.deliveryStore,
          ingress,
          rawBodySha256,
        );
      } catch (error) {
        clearHeaders(request.headers);
        request.raw_body.fill(0);
        throw error;
      }
      if (alreadyObserved) {
        clearHeaders(request.headers);
        request.raw_body.fill(0);
        throw new WebhookTestDeliveryError(
          'profile_unavailable',
          'webhook test nonce source repeated an accepted request',
        );
      }
      const outboundBody = Uint8Array.from(request.raw_body);
      const outboundHeaders = new Headers();
      try {
        for (const [name, value] of Object.entries(request.headers)) {
          outboundHeaders.set(name, value);
        }
        outboundHeaders.set('content-type', 'application/json');
      } catch {
        clearHeaders(request.headers);
        request.raw_body.fill(0);
        outboundBody.fill(0);
        throw new WebhookTestDeliveryError(
          'profile_unavailable',
          'webhook test profile emitted unusable headers',
        );
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        const fetched = await fetchImpl(endpointUrl, {
          method: 'POST',
          headers: outboundHeaders,
          body: outboundBody,
          redirect: 'error',
          signal: controller.signal,
        });
        if (fetched === null
          || typeof fetched !== 'object'
          || !Number.isSafeInteger(fetched.status)) {
          throw new Error('invalid webhook test response');
        }
        response = fetched;
      } catch {
        const observed = observedDelivery(
          options.deliveryStore,
          ingress,
          rawBodySha256,
        );
        if (observed) {
          throw new WebhookTestDeliveryError(
            'accepted_response_unconfirmed',
            `delivery ${observed.delivery_id} was durably accepted and may have dispatched, but the HTTP success response was not confirmed; inspect it before retrying`,
          );
        }
        throw new WebhookTestDeliveryError(
          'request_failed',
          'the request ended without observed durable acceptance; it may still arrive, so inspect before retrying',
        );
      } finally {
        clearTimeout(timer);
        clearHeaders(request.headers);
        for (const name of Object.keys(request.headers)) {
          try {
            outboundHeaders.set(name, '');
          } catch {
            // Drop the fetch-owned header view even if mutation is refused.
          }
        }
        request.raw_body.fill(0);
        outboundBody.fill(0);
      }
      try {
        // Do not await a remote stream's cancellation hook: the bounded test
        // result depends only on status + local durable observation, and an
        // endpoint-controlled body must not extend the request timeout.
        void response.body?.cancel().catch(() => undefined);
      } catch {
        // The response body is never part of the test result.
      }
      const observed = observedDelivery(
        options.deliveryStore,
        ingress,
        rawBodySha256,
      );
      if (response.status !== adapter.success_response.status) {
        if (observed) {
          throw new WebhookTestDeliveryError(
            'accepted_response_unconfirmed',
            `delivery ${observed.delivery_id} was durably accepted and may have dispatched, but the endpoint returned the wrong status; inspect it before retrying`,
          );
        }
        throw new WebhookTestDeliveryError(
          'request_failed',
          'the endpoint returned the wrong status without observed durable acceptance; inspect before retrying',
        );
      }
      if (!observed) {
        throw new WebhookTestDeliveryError(
          'not_observed',
          'the endpoint returned success but no durable delivery was observed; it may be misrouted or delayed, so inspect before retrying',
        );
      }
      if (!ingressStillEligible(options.ingressStore, ingress, endpointUrl)
        || !activeCredentialsStillMatch(
          options.ingressStore,
          ingress.ingress_id,
          credentialSnapshot,
        )) {
        throw new WebhookTestDeliveryError(
          'accepted_state_changed',
          `delivery ${observed.delivery_id} was durably accepted and may have dispatched, but the ingress changed during the test; inspect it before retrying`,
        );
      }
      return {
        delivery_id: observed.delivery_id,
        observed_at: observed.received_at,
      };
    },
  });
};
