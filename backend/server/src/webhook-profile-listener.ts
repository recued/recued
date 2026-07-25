/** D-201 Slices 2 + 5B2B2A + 7D + 9BO — exact-byte webhook ingress HTTP kernel.
 *
 * This listener is intentionally opt-in. The server router mounts it only when
 * supplied explicitly, and it returns the same generic 404 while its durable
 * outbox consumer is not started. Slice 5A production composition supplies it
 * only for explicitly admitted adapters after the full readiness gate passes.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  webhookProfile,
  webhookProfileAcceptsEventType,
  type WebhookIngressRecord,
  type WebhookProfileDescriptor,
  type WebhookRejectedDeliveryReasonCode,
} from '@recued/contracts';
import {
  WEBHOOK_PAIRED_CONNECTION_DELETED,
  type WebhookIngressStore,
} from './storage/webhook-ingress-store.js';
import {
  WebhookDeliveryStoreError,
  type WebhookAcceptedDeliveryInput,
  type WebhookAcceptedEventInput,
  type WebhookDeliveryStore,
} from './storage/webhook-delivery-store.js';
import {
  WebhookProfileDependencyUnavailableError,
  type RawWebhookRequest,
  type RawWebhookTransportEvidence,
  type ResolvedWebhookCredentialVersion,
  type WebhookHandshakeResult,
  type WebhookIngressProfileAdapter,
  type WebhookProfileFailureCode,
  type WebhookProfileHttpResponse,
  type WebhookProfileAdmission,
  type WebhookProfileResult,
  type WebhookProfileRuntimeContext,
  type WebhookProfileRuntimeRegistry,
} from './webhook-profile-runtime.js';

export const DEFAULT_WEBHOOK_PROFILE_GLOBAL_BODY_BYTES = 1_048_576;
export const MAX_WEBHOOK_DECODED_PAYLOAD_BYTES = 2_097_152;
export const MAX_WEBHOOK_PROFILE_RESPONSE_BYTES = 65_536;

const MAX_RAW_PATH_BYTES = 4_096;
const MAX_HEADER_NAMES = 128;
const MAX_HEADER_NAME_BYTES = 128;
const MAX_HEADER_VALUE_BYTES = 8_192;
const MAX_HEADER_TOTAL_BYTES = 32_768;
const MAX_PAYLOAD_DEPTH = 32;
const MAX_PAYLOAD_NODES = 50_000;
const MAX_PAYLOAD_ARRAY_ITEMS = 10_000;
const MAX_PAYLOAD_OBJECT_KEYS = 10_000;
const MAX_PAYLOAD_KEY_BYTES = 256;
const MAX_DEDUP_KEY_BYTES = 256;
const MAX_PROVIDER_ID_BYTES = 512;
const MAX_CLIENT_CERTIFICATES = 8;
const MAX_CLIENT_CERTIFICATE_BYTES = 65_536;
const MAX_CLIENT_CERTIFICATE_CHAIN_BYTES = 262_144;

const PROTOTYPE_SENSITIVE_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

class WebhookKernelValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookKernelValidationError';
  }
}

class WebhookHeaderCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookHeaderCaptureError';
  }
}

class WebhookProfileTimeoutError extends Error {
  constructor() {
    super('webhook profile timed out');
    this.name = 'WebhookProfileTimeoutError';
  }
}

export interface WebhookProfileListenerOptions {
  ingressStore: WebhookIngressStore;
  deliveryStore: WebhookDeliveryStore;
  profiles: WebhookProfileRuntimeRegistry;
  /** The route is dormant unless a durable consumer is actively composed. */
  isOutboxDispatcherStarted: () => boolean;
  /** D-188 master pause gate. Checked before ingress lookup so pause does not
   * reveal whether an opaque id exists. */
  isPaused?: () => boolean;
  /** Live public-path exposure gate. Production checks the authoritative
   * exposure state on every request so a later public-path demotion also closes
   * the still-present LAN alias before ingress lookup. */
  isIntakeReachable?: () => boolean | Promise<boolean>;
  /** Resolve from trusted exposure configuration, never Host/Forwarded headers. */
  resolveCanonicalPublicUrl: (input: {
    ingress: WebhookIngressRecord;
    raw_path_and_query: string;
  }) => string | null;
  captureTransportEvidence?: (
    request: IncomingMessage,
  ) => RawWebhookTransportEvidence | undefined;
  now?: () => number;
  globalMaxBodyBytes?: number;
  maxConcurrentRequests?: number;
  maxConcurrentPerIngress?: number;
  globalRateLimitPerSecond?: number;
  globalRateLimitBurst?: number;
  rateLimitPerSecond?: number;
  rateLimitBurst?: number;
  profileTimeoutMs?: number;
  onProfileFailure?: (input: {
    ingress_id: string;
    code: WebhookProfileFailureCode;
  }) => void;
  onHandshakeReadinessProven?: (ingressId: string) => void;
  log?: (
    level: 'warn' | 'error',
    message: string,
    metadata: Readonly<Record<string, string | number>>,
  ) => void;
}

export type WebhookProfileRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  publicId: string,
) => Promise<void>;

interface RateBucket {
  tokens: number;
  last_refill: number;
}

const writeJson = (
  response: ServerResponse,
  status: number,
  code: string,
): void => {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify({ error: { code } }));
};

const writeNotFound = (response: ServerResponse): void => {
  writeJson(response, 404, 'not_found');
};

const writeProfileResponse = (
  response: ServerResponse,
  profileResponse: WebhookProfileHttpResponse,
): void => {
  response.statusCode = profileResponse.status;
  response.setHeader('Cache-Control', 'no-store');
  if (profileResponse.content_type !== undefined) {
    response.setHeader('Content-Type', profileResponse.content_type);
  }
  response.end(profileResponse.body ?? '');
};

const drainRequest = (request: IncomingMessage): void => {
  request.resume();
};

const captureHeaders = (
  request: IncomingMessage,
): ReadonlyMap<string, readonly string[]> => {
  const collected = new Map<string, string[]>();
  let totalBytes = 0;
  const append = (rawName: string, rawValue: string): void => {
    const name = rawName.toLowerCase();
    const nameBytes = Buffer.byteLength(name, 'utf8');
    const valueBytes = Buffer.byteLength(rawValue, 'utf8');
    if (nameBytes === 0 || nameBytes > MAX_HEADER_NAME_BYTES
      || valueBytes > MAX_HEADER_VALUE_BYTES) {
      throw new WebhookHeaderCaptureError('webhook header exceeds capture bounds');
    }
    totalBytes += nameBytes + valueBytes;
    if (totalBytes > MAX_HEADER_TOTAL_BYTES) {
      throw new WebhookHeaderCaptureError('webhook headers exceed aggregate bound');
    }
    const values = collected.get(name);
    if (values) values.push(rawValue);
    else {
      if (collected.size >= MAX_HEADER_NAMES) {
        throw new WebhookHeaderCaptureError('webhook has too many header names');
      }
      collected.set(name, [rawValue]);
    }
  };

  if (request.rawHeaders.length > 0) {
    for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
      append(request.rawHeaders[index]!, request.rawHeaders[index + 1]!);
    }
  } else {
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') append(name, value);
      else if (Array.isArray(value)) {
        for (const entry of value) append(name, entry);
      }
    }
  }
  return new Map(
    [...collected.entries()].map(([name, values]) => [name, Object.freeze(values.slice())]),
  );
};

const headerValues = (
  headers: ReadonlyMap<string, readonly string[]>,
  name: string,
): readonly string[] => headers.get(name) ?? [];

const normalizedContentType = (
  headers: ReadonlyMap<string, readonly string[]>,
): string | null => {
  const values = headerValues(headers, 'content-type');
  if (values.length !== 1) return null;
  const [mediaType] = values[0]!.split(';', 1);
  const normalized = mediaType!.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
};

const contentLength = (
  headers: ReadonlyMap<string, readonly string[]>,
): number | null => {
  const values = headerValues(headers, 'content-length');
  if (values.length === 0) return null;
  if (values.length !== 1 || !/^(0|[1-9][0-9]*)$/.test(values[0]!)) {
    throw new WebhookHeaderCaptureError('webhook content-length is invalid');
  }
  const parsed = Number(values[0]);
  if (!Number.isSafeInteger(parsed)) {
    throw new WebhookHeaderCaptureError('webhook content-length is out of range');
  }
  return parsed;
};

const hasSupportedContentEncoding = (
  headers: ReadonlyMap<string, readonly string[]>,
): boolean => {
  const values = headerValues(headers, 'content-encoding');
  return values.length === 0
    || (values.length === 1 && values[0]!.trim().toLowerCase() === 'identity');
};

const readBodyWithCap = async (
  request: IncomingMessage,
  cap: number,
): Promise<{ ok: true; body: Buffer } | { ok: false; reason: 'too_large' | 'stream_error' }> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overLimit = false;
    let settled = false;
    const finish = (
      result: { ok: true; body: Buffer } | { ok: false; reason: 'too_large' | 'stream_error' },
    ): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    request.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > cap) {
        overLimit = true;
        chunks.length = 0;
        return;
      }
      chunks.push(bytes);
    });
    request.on('end', () => {
      finish(overLimit
        ? { ok: false, reason: 'too_large' }
        : { ok: true, body: Buffer.concat(chunks, total) });
    });
    request.on('aborted', () => finish({ ok: false, reason: 'stream_error' }));
    request.on('error', () => finish({ ok: false, reason: 'stream_error' }));
    request.on('close', () => {
      if (!request.complete) finish({ ok: false, reason: 'stream_error' });
    });
  });

const withProfileTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new WebhookProfileTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const assertPlainRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebhookKernelValidationError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WebhookKernelValidationError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
};

const ownValue = (
  record: Record<string, unknown>,
  key: string,
): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
};

const assertBoundedString = (
  value: unknown,
  label: string,
  maxBytes: number,
): string => {
  if (typeof value !== 'string'
    || value.length === 0
    || /[\u0000-\u001f\u007f]/.test(value)
    || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new WebhookKernelValidationError(`${label} has invalid shape`);
  }
  return value;
};

const nullableBoundedString = (
  value: unknown,
  label: string,
  maxBytes: number,
): string | null => value === null
  ? null
  : assertBoundedString(value, label, maxBytes);

const normalizeTransportEvidence = (
  value: RawWebhookTransportEvidence | undefined,
): RawWebhookTransportEvidence | undefined => {
  if (value === undefined) return undefined;
  const record = assertPlainRecord(value, 'webhook transport evidence');
  for (const key of Object.keys(record)) {
    if (key !== 'trusted_proxy_id' && key !== 'client_certificate_chain_der') {
      throw new WebhookKernelValidationError('webhook transport evidence has unknown fields');
    }
  }
  const trustedProxyId = ownValue(record, 'trusted_proxy_id');
  if (trustedProxyId !== undefined) {
    assertBoundedString(trustedProxyId, 'trusted proxy id', 128);
  }
  const rawChain = ownValue(record, 'client_certificate_chain_der');
  let chain: Buffer[] | undefined;
  if (rawChain !== undefined) {
    if (!Array.isArray(rawChain) || rawChain.length > MAX_CLIENT_CERTIFICATES) {
      throw new WebhookKernelValidationError('client certificate chain is invalid');
    }
    let total = 0;
    chain = rawChain.map((certificate, index) => {
      if (!Object.prototype.hasOwnProperty.call(rawChain, index)
        || !Buffer.isBuffer(certificate)
        || certificate.byteLength === 0
        || certificate.byteLength > MAX_CLIENT_CERTIFICATE_BYTES) {
        throw new WebhookKernelValidationError('client certificate evidence is invalid');
      }
      total += certificate.byteLength;
      if (total > MAX_CLIENT_CERTIFICATE_CHAIN_BYTES) {
        throw new WebhookKernelValidationError('client certificate chain is too large');
      }
      return Buffer.from(certificate);
    });
  }
  return {
    ...(trustedProxyId !== undefined
      ? { trusted_proxy_id: trustedProxyId as string }
      : {}),
    ...(chain !== undefined ? { client_certificate_chain_der: chain } : {}),
  };
};

const normalizeHttpResponse = (
  value: unknown,
  label: string,
  accepted: boolean,
): WebhookProfileHttpResponse => {
  const response = assertPlainRecord(value, label);
  const status = ownValue(response, 'status');
  if (!Number.isSafeInteger(status)
    || (accepted ? (status as number) < 200 || (status as number) > 299
      : (status as number) < 400 || (status as number) > 599)) {
    throw new WebhookKernelValidationError(`${label}.status is invalid`);
  }
  const contentType = ownValue(response, 'content_type');
  if (contentType !== undefined
    && (typeof contentType !== 'string'
      || contentType.length === 0
      || contentType.length > 128
      || !/^[A-Za-z0-9!#$&^_.+\-/]+(?:;[ A-Za-z0-9!#$&^_.+\-/="']+)?$/.test(contentType))) {
    throw new WebhookKernelValidationError(`${label}.content_type is invalid`);
  }
  const body = ownValue(response, 'body');
  if (body !== undefined
    && (typeof body !== 'string'
      || Buffer.byteLength(body, 'utf8') > MAX_WEBHOOK_PROFILE_RESPONSE_BYTES)) {
    throw new WebhookKernelValidationError(`${label}.body is invalid`);
  }
  if (status === 204 && body !== undefined && body.length > 0) {
    throw new WebhookKernelValidationError(`${label} cannot attach a body to 204`);
  }
  return {
    status: status as number,
    ...(contentType !== undefined ? { content_type: contentType as string } : {}),
    ...(body !== undefined ? { body: body as string } : {}),
  };
};

interface PayloadBudget {
  nodes: number;
}

const normalizePayloadValue = (
  value: unknown,
  depth: number,
  budget: PayloadBudget,
  ancestors: WeakSet<object>,
): unknown => {
  budget.nodes += 1;
  if (budget.nodes > MAX_PAYLOAD_NODES || depth > MAX_PAYLOAD_DEPTH) {
    throw new WebhookKernelValidationError('decoded payload exceeds structural bounds');
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new WebhookKernelValidationError('decoded payload contains a non-finite number');
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new WebhookKernelValidationError('decoded payload contains a non-JSON value');
  }
  if (ancestors.has(value)) {
    throw new WebhookKernelValidationError('decoded payload contains a cycle');
  }
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      if (value.length > MAX_PAYLOAD_ARRAY_ITEMS) {
        throw new WebhookKernelValidationError('decoded payload array is too large');
      }
      const allowedKeys = new Set(['length']);
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        allowedKeys.add(key);
        const descriptor = descriptors[key];
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
          throw new WebhookKernelValidationError('decoded payload array is sparse or accessor-backed');
        }
        result.push(normalizePayloadValue(
          descriptor.value,
          depth + 1,
          budget,
          ancestors,
        ));
      }
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string' || !allowedKeys.has(key)) {
          throw new WebhookKernelValidationError('decoded payload array has extra properties');
        }
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new WebhookKernelValidationError('decoded payload contains a non-plain object');
    }
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > MAX_PAYLOAD_OBJECT_KEYS) {
      throw new WebhookKernelValidationError('decoded payload object has too many keys');
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== 'string'
        || PROTOTYPE_SENSITIVE_KEYS.has(key)
        || Buffer.byteLength(key, 'utf8') > MAX_PAYLOAD_KEY_BYTES) {
        throw new WebhookKernelValidationError('decoded payload object key is unsafe');
      }
      const descriptor = descriptors[key]!;
      if (!('value' in descriptor) || !descriptor.enumerable) {
        throw new WebhookKernelValidationError('decoded payload object is accessor-backed');
      }
      result[key] = normalizePayloadValue(
        descriptor.value,
        depth + 1,
        budget,
        ancestors,
      );
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
};

/** Exported for adversarial fixtures; adapters never choose serialization. */
export const normalizeWebhookDecodedPayload = (value: unknown): string => {
  const normalized = normalizePayloadValue(value, 0, { nodes: 0 }, new WeakSet());
  const serialized = JSON.stringify(normalized);
  if (serialized === undefined
    || Buffer.byteLength(serialized, 'utf8') > MAX_WEBHOOK_DECODED_PAYLOAD_BYTES) {
    throw new WebhookKernelValidationError('decoded payload exceeds byte bound');
  }
  return serialized;
};

const normalizeAcceptedDelivery = (
  value: unknown,
  descriptor: WebhookProfileDescriptor,
  adapter: WebhookIngressProfileAdapter,
  credentials: readonly ResolvedWebhookCredentialVersion[],
): Omit<WebhookAcceptedDeliveryInput,
  | 'ingress_id'
  | 'profile_id'
  | 'environment'
  | 'received_at'
  | 'raw_body_sha256'
  | 'decoded_schema_id'
  | 'minimum_source_truth_policy'> => {
  const delivery = assertPlainRecord(value, 'profile delivery');
  const dedupKey = assertBoundedString(
    ownValue(delivery, 'delivery_dedup_key'),
    'delivery_dedup_key',
    MAX_DEDUP_KEY_BYTES,
  );
  const decodedContentType = assertBoundedString(
    ownValue(delivery, 'decoded_content_type'),
    'decoded_content_type',
    128,
  );
  if (!/^[A-Za-z0-9!#$&^_.+\-/]+$/.test(decodedContentType)) {
    throw new WebhookKernelValidationError('decoded_content_type is invalid');
  }
  const response = normalizeHttpResponse(
    ownValue(delivery, 'response'),
    'profile response',
    true,
  );
  const declaredResponse = normalizeHttpResponse(
    adapter.success_response,
    'declared profile response',
    true,
  );
  if (response.status !== declaredResponse.status
    || response.content_type !== declaredResponse.content_type
    || response.body !== declaredResponse.body) {
    throw new WebhookKernelValidationError(
      'profile response differs from its registered success response',
    );
  }
  const admission = normalizeProfileAdmission(
    ownValue(delivery, 'admission'),
    descriptor,
    credentials,
    'profile admission',
  );
  const deliveryEvents = ownValue(delivery, 'events');
  if (!Array.isArray(deliveryEvents)
    || deliveryEvents.length < 1
    || deliveryEvents.length > descriptor.max_events_per_delivery) {
    throw new WebhookKernelValidationError('profile event count is out of bounds');
  }

  const dedupKeys = new Set<string>();
  const events: WebhookAcceptedEventInput[] = [];
  let totalPayloadBytes = 0;
  for (let index = 0; index < deliveryEvents.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(deliveryEvents, index)) {
      throw new WebhookKernelValidationError('profile events array is sparse');
    }
    const event = assertPlainRecord(deliveryEvents[index], `profile event ${index}`);
    const eventDedupKey = assertBoundedString(
      ownValue(event, 'event_dedup_key'),
      `event ${index} dedup key`,
      MAX_DEDUP_KEY_BYTES,
    );
    if (dedupKeys.has(eventDedupKey)) {
      throw new WebhookKernelValidationError('profile emitted duplicate event dedup keys');
    }
    dedupKeys.add(eventDedupKey);
    const eventType = assertBoundedString(
      ownValue(event, 'provider_event_type'),
      `event ${index} type`,
      128,
    );
    if (!webhookProfileAcceptsEventType(descriptor, eventType)) {
      throw new WebhookKernelValidationError('profile emitted an unsupported event type');
    }
    const occurredAt = ownValue(event, 'provider_occurred_at');
    if (occurredAt !== null
      && (!Number.isSafeInteger(occurredAt) || (occurredAt as number) < 0)) {
      throw new WebhookKernelValidationError('profile event timestamp is invalid');
    }
    const payloadJson = normalizeWebhookDecodedPayload(
      ownValue(event, 'decoded_payload'),
    );
    totalPayloadBytes += Buffer.byteLength(payloadJson, 'utf8');
    if (totalPayloadBytes > MAX_WEBHOOK_DECODED_PAYLOAD_BYTES) {
      throw new WebhookKernelValidationError('profile delivery payloads exceed byte bound');
    }
    events.push({
      event_dedup_key: eventDedupKey,
      provider_event_id: nullableBoundedString(
        ownValue(event, 'provider_event_id'),
        `event ${index} provider_event_id`,
        MAX_PROVIDER_ID_BYTES,
      ),
      provider_resource_id: nullableBoundedString(
        ownValue(event, 'provider_resource_id'),
        `event ${index} provider_resource_id`,
        MAX_PROVIDER_ID_BYTES,
      ),
      provider_event_type: eventType,
      provider_occurred_at: occurredAt as number | null,
      decoded_payload_json: payloadJson,
    });
  }

  return {
    delivery_dedup_key: dedupKey,
    decoded_content_type: decodedContentType,
    transport_assurance: admission.transport_assurance,
    credential_version: admission.credential_version,
    admission_method: admission.method_label,
    freshness_checked: admission.freshness_checked,
    response,
    events,
  };
};

const normalizeProfileAdmission = (
  value: unknown,
  descriptor: WebhookProfileDescriptor,
  credentials: readonly ResolvedWebhookCredentialVersion[],
  label: string,
): WebhookProfileAdmission => {
  const admission = assertPlainRecord(value, label);
  if (ownValue(admission, 'transport_assurance') !== descriptor.transport_assurance) {
    throw new WebhookKernelValidationError('profile changed its registered assurance');
  }
  const activeCredentialVersions = new Set(credentials.map((entry) => entry.version));
  const credentialVersion = ownValue(admission, 'credential_version');
  if (credentialVersion !== null
    && (typeof credentialVersion !== 'string'
      || !activeCredentialVersions.has(credentialVersion))) {
    throw new WebhookKernelValidationError('profile selected an inactive credential version');
  }
  if (descriptor.transport_assurance === 'notification_only' && credentialVersion !== null) {
    throw new WebhookKernelValidationError('notification-only profile claimed a credential');
  }
  if (descriptor.transport_assurance === 'authenticated'
    && descriptor.fields.some((field) => field.required)
    && credentialVersion === null) {
    throw new WebhookKernelValidationError('authenticated profile omitted credential version');
  }
  const freshnessChecked = ownValue(admission, 'freshness_checked');
  if (typeof freshnessChecked !== 'boolean') {
    throw new WebhookKernelValidationError('profile freshness result is invalid');
  }
  if (descriptor.mechanism_kind === 'timestamped_hmac'
    && freshnessChecked !== true) {
    throw new WebhookKernelValidationError(
      'timestamped profile accepted without a freshness check',
    );
  }
  const methodLabel = assertBoundedString(
    ownValue(admission, 'method_label'),
    'admission method_label',
    64,
  );
  if (!/^[A-Za-z0-9._:-]+$/.test(methodLabel)) {
    throw new WebhookKernelValidationError('admission method_label is invalid');
  }
  return {
    transport_assurance: descriptor.transport_assurance,
    credential_version: credentialVersion as string | null,
    method_label: methodLabel,
    freshness_checked: freshnessChecked,
  };
};

const normalizeFailure = (
  value: unknown,
): { code: WebhookProfileFailureCode; status: number } => {
  const failure = assertPlainRecord(value, 'profile failure');
  const disposition = ownValue(failure, 'disposition');
  const code = ownValue(failure, 'code');
  if (disposition !== 'reject' && disposition !== 'retry') {
    throw new WebhookKernelValidationError('profile failure disposition is invalid');
  }
  const codes: readonly WebhookProfileFailureCode[] = [
    'authentication_failed',
    'structural_admission_failed',
    'unsupported_delivery',
    'profile_dependency_unavailable',
    'profile_internal_error',
  ];
  if (!codes.includes(code as WebhookProfileFailureCode)) {
    throw new WebhookKernelValidationError('profile failure code is invalid');
  }
  const retryableCode = code === 'profile_dependency_unavailable'
    || code === 'profile_internal_error';
  if ((retryableCode && disposition !== 'retry')
    || (!retryableCode && disposition !== 'reject')) {
    throw new WebhookKernelValidationError('profile failure disposition contradicts its code');
  }
  const response = normalizeHttpResponse(
    ownValue(failure, 'response'),
    'profile failure response',
    false,
  );
  if (disposition === 'retry' && response.status < 500) {
    throw new WebhookKernelValidationError('retryable profile failure must use 5xx');
  }
  if (disposition === 'reject' && response.status >= 500) {
    throw new WebhookKernelValidationError('rejected profile failure must use 4xx');
  }
  return { code: code as WebhookProfileFailureCode, status: response.status };
};

const normalizeHandshake = (
  value: unknown,
  descriptor: WebhookProfileDescriptor,
  credentials: readonly ResolvedWebhookCredentialVersion[],
): WebhookHandshakeResult => {
  const handshake = assertPlainRecord(value, 'profile handshake');
  const readinessProven = ownValue(handshake, 'readiness_proven');
  if (typeof readinessProven !== 'boolean') {
    throw new WebhookKernelValidationError('profile handshake readiness is invalid');
  }
  return {
    response: normalizeHttpResponse(
      ownValue(handshake, 'response'),
      'handshake response',
      true,
    ),
    readiness_proven: readinessProven,
    admission: normalizeProfileAdmission(
      ownValue(handshake, 'admission'),
      descriptor,
      credentials,
      'handshake admission',
    ),
  };
};

const clearCredentials = (
  versions: readonly ResolvedWebhookCredentialVersion[],
): void => {
  for (const version of versions) {
    const record = version.credentials as Record<string, string>;
    for (const key of Object.keys(record)) {
      try {
        record[key] = '';
      } catch {
        // A trusted adapter may have frozen its view; dropping the reference is
        // still safe and must not replace an already-written HTTP response.
      }
    }
  }
};

const revalidateCredentialVersion = async (
  store: WebhookIngressStore,
  ingressId: string,
  credentialVersion: string | null,
): Promise<boolean> => {
  // Re-read through the encrypted store, rather than metadata alone, so an
  // in-flight handshake also loses authority when the vault locks or its key
  // rotates. The store's final synchronous checks close its own async race.
  const versions = await store.readActiveCredentialVersions(ingressId);
  try {
    return credentialVersion === null
      || versions.some((version) => version.version === credentialVersion);
  } finally {
    clearCredentials(versions);
  }
};

const isIngressStillEligible = (
  current: WebhookIngressRecord | null,
  original: WebhookIngressRecord,
): boolean => current !== null
  && current.public_id === original.public_id
  && current.profile_id === original.profile_id
  && current.environment === original.environment
  && current.confirmed_endpoint_url === original.confirmed_endpoint_url
  && current.last_error_code !== WEBHOOK_PAIRED_CONNECTION_DELETED
  && (current.intake_state === 'enabled'
    || current.intake_state === 'degraded'
    || current.intake_state === 'ready'
    || current.intake_state === 'verification_pending');

const validCanonicalPublicUrl = (value: string | null): value is string => {
  if (value === null || Buffer.byteLength(value, 'utf8') > MAX_RAW_PATH_BYTES * 2) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.username.length === 0
      && parsed.password.length === 0
      && parsed.hash.length === 0;
  } catch {
    return false;
  }
};

const registrationEndpointUrl = (canonicalPublicUrl: string): string | null => {
  try {
    const parsed = new URL(canonicalPublicUrl);
    parsed.search = '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return null;
  }
};

export const createWebhookProfileListener = (
  options: WebhookProfileListenerOptions,
): WebhookProfileRequestHandler => {
  const now = options.now ?? Date.now;
  const globalMaxBody = options.globalMaxBodyBytes
    ?? DEFAULT_WEBHOOK_PROFILE_GLOBAL_BODY_BYTES;
  const maxConcurrent = options.maxConcurrentRequests ?? 64;
  const maxConcurrentPerIngress = options.maxConcurrentPerIngress ?? 8;
  const globalRatePerSecond = options.globalRateLimitPerSecond ?? 1_000;
  const globalRateBurst = options.globalRateLimitBurst ?? 200;
  const ratePerSecond = options.rateLimitPerSecond ?? 100;
  const rateBurst = options.rateLimitBurst ?? 20;
  const profileTimeoutMs = options.profileTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(globalMaxBody) || globalMaxBody < 1) {
    throw new Error('webhook profile listener: globalMaxBodyBytes must be positive');
  }
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1
    || !Number.isSafeInteger(maxConcurrentPerIngress) || maxConcurrentPerIngress < 1) {
    throw new Error('webhook profile listener: concurrency limits must be positive integers');
  }
  if (!Number.isFinite(globalRatePerSecond) || globalRatePerSecond <= 0
    || !Number.isSafeInteger(globalRateBurst) || globalRateBurst < 1
    || !Number.isFinite(ratePerSecond) || ratePerSecond <= 0
    || !Number.isSafeInteger(rateBurst) || rateBurst < 1) {
    throw new Error('webhook profile listener: rate limits must be positive');
  }
  if (!Number.isSafeInteger(profileTimeoutMs)
    || profileTimeoutMs < 1
    || profileTimeoutMs > 60_000) {
    throw new Error('webhook profile listener: profileTimeoutMs must be in 1..60000');
  }
  let concurrent = 0;
  let globalRateBucket: RateBucket | null = null;
  const concurrentByIngress = new Map<string, number>();
  const rateBuckets = new Map<string, RateBucket>();

  const takeRateToken = (ingressId: string, stamp: number): boolean => {
    const bucket = rateBuckets.get(ingressId) ?? {
      tokens: rateBurst,
      last_refill: stamp,
    };
    const elapsed = Math.max(0, stamp - bucket.last_refill) / 1_000;
    bucket.tokens = Math.min(rateBurst, bucket.tokens + elapsed * ratePerSecond);
    bucket.last_refill = stamp;
    rateBuckets.set(ingressId, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  };

  const takeGlobalRateToken = (stamp: number): boolean => {
    const bucket = globalRateBucket ?? {
      tokens: globalRateBurst,
      last_refill: stamp,
    };
    const elapsed = Math.max(0, stamp - bucket.last_refill) / 1_000;
    bucket.tokens = Math.min(
      globalRateBurst,
      bucket.tokens + elapsed * globalRatePerSecond,
    );
    bucket.last_refill = stamp;
    globalRateBucket = bucket;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  };

  const noteFailure = (
    ingressId: string,
    code: WebhookProfileFailureCode,
  ): void => {
    if (code === 'unsupported_delivery'
      || code === 'profile_dependency_unavailable'
      || code === 'profile_internal_error') {
      try {
        options.ingressStore.recordRuntimeFailure(ingressId, code);
      } catch {
        // The external rejection still fails closed if health persistence fails.
      }
    }
    try {
      options.onProfileFailure?.({ ingress_id: ingressId, code });
    } catch {
      // Health telemetry cannot change an external admission decision.
    }
  };

  return async (request, response, publicId): Promise<void> => {
    if (options.isPaused?.()) {
      drainRequest(request);
      writeJson(response, 503, 'server_paused');
      return;
    }
    try {
      if (options.isIntakeReachable && !await options.isIntakeReachable()) {
        drainRequest(request);
        writeNotFound(response);
        return;
      }
    } catch {
      drainRequest(request);
      writeNotFound(response);
      return;
    }
    if (!options.isOutboxDispatcherStarted()) {
      writeNotFound(response);
      return;
    }
    const stamp = now();
    if (!takeGlobalRateToken(stamp)) {
      drainRequest(request);
      writeJson(response, 429, 'rate_limited');
      return;
    }
    const ingress = options.ingressStore.getByPublicId(publicId);
    if (!ingress
      || ingress.last_error_code === WEBHOOK_PAIRED_CONNECTION_DELETED
      || (ingress.intake_state !== 'enabled'
        && ingress.intake_state !== 'degraded'
        && ingress.intake_state !== 'ready'
        && ingress.intake_state !== 'verification_pending')) {
      writeNotFound(response);
      return;
    }
    const descriptor = webhookProfile(ingress.profile_id);
    const adapter = options.profiles.get(ingress.profile_id);
    if (!descriptor || !adapter) {
      writeNotFound(response);
      return;
    }
    const handshakeOnlyState = ingress.intake_state === 'verification_pending'
      || ingress.intake_state === 'ready';
    if (handshakeOnlyState && !adapter.handleHandshake) {
      writeNotFound(response);
      return;
    }
    const routeStillEligible = (): boolean => isIngressStillEligible(
      options.ingressStore.get(ingress.ingress_id),
      ingress,
    );
    const noteRejectedDelivery = (
      reasonCode: WebhookRejectedDeliveryReasonCode,
      httpStatus: number,
    ): void => {
      // Verification handshakes are not ordinary delivery attempts. Rejection
      // persistence is diagnostic-only and can never change the HTTP decision.
      if (handshakeOnlyState) return;
      try {
        options.deliveryStore.recordRejectedDelivery({
          ingress_id: ingress.ingress_id,
          profile_id: ingress.profile_id,
          environment: ingress.environment,
          received_at: stamp,
          reason_code: reasonCode,
          http_status: httpStatus,
        });
      } catch {
        // Fail closed externally without creating a rejection-triggered retry
        // or log-amplification channel.
      }
    };

    if (!takeRateToken(ingress.ingress_id, stamp)) {
      drainRequest(request);
      writeJson(response, 429, 'rate_limited');
      return;
    }
    const ingressConcurrency = concurrentByIngress.get(ingress.ingress_id) ?? 0;
    if (concurrent >= maxConcurrent || ingressConcurrency >= maxConcurrentPerIngress) {
      drainRequest(request);
      writeJson(response, 503, 'temporarily_unavailable');
      return;
    }

    const rawPathAndQuery = request.url ?? `/v1/webhooks/${publicId}`;
    if (Buffer.byteLength(rawPathAndQuery, 'utf8') > MAX_RAW_PATH_BYTES) {
      drainRequest(request);
      noteRejectedDelivery('uri_too_long', 414);
      writeJson(response, 414, 'uri_too_long');
      return;
    }
    let headers: ReadonlyMap<string, readonly string[]>;
    try {
      headers = captureHeaders(request);
    } catch {
      drainRequest(request);
      noteRejectedDelivery('request_headers_too_large', 431);
      writeJson(response, 431, 'request_headers_too_large');
      return;
    }
    const method = request.method ?? 'POST';
    if (!descriptor.allowed_methods.includes(method)) {
      drainRequest(request);
      noteRejectedDelivery('method_not_allowed', 405);
      writeJson(response, 405, 'method_not_allowed');
      return;
    }
    const contentType = normalizedContentType(headers);
    if (contentType === null
      || !descriptor.allowed_content_types.includes(contentType)
      || !hasSupportedContentEncoding(headers)) {
      drainRequest(request);
      noteRejectedDelivery('unsupported_media_type', 415);
      writeJson(response, 415, 'unsupported_media_type');
      return;
    }
    const cap = Math.min(globalMaxBody, descriptor.max_body_bytes);
    try {
      const declaredLength = contentLength(headers);
      if (declaredLength !== null && declaredLength > cap) {
        drainRequest(request);
        noteRejectedDelivery('payload_too_large', 413);
        writeJson(response, 413, 'payload_too_large');
        return;
      }
    } catch {
      drainRequest(request);
      noteRejectedDelivery('invalid_request', 400);
      writeJson(response, 400, 'invalid_request');
      return;
    }
    let canonicalPublicUrl: string | null;
    try {
      canonicalPublicUrl = options.resolveCanonicalPublicUrl({
        ingress,
        raw_path_and_query: rawPathAndQuery,
      });
    } catch {
      canonicalPublicUrl = null;
    }
    if (!validCanonicalPublicUrl(canonicalPublicUrl)) {
      drainRequest(request);
      writeJson(response, 503, 'profile_unavailable');
      return;
    }
    // Manual and managed endpoints both bind provider registration to this
    // exact canonical URL. A later public-base change closes intake until the
    // owner confirms or reconciles the new endpoint. Operation-bound callbacks
    // have separate attach/detach authority and no single confirmed URL here.
    if (ingress.registration_mode !== 'operation_bound'
      && ingress.confirmed_endpoint_url
        !== registrationEndpointUrl(canonicalPublicUrl)) {
      drainRequest(request);
      writeNotFound(response);
      return;
    }

    concurrent += 1;
    concurrentByIngress.set(ingress.ingress_id, ingressConcurrency + 1);
    let rawBody: Buffer | null = null;
    let credentialVersions: ResolvedWebhookCredentialVersion[] = [];
    try {
      const bodyResult = await readBodyWithCap(request, cap);
      if (!bodyResult.ok) {
        if (bodyResult.reason === 'too_large') {
          noteRejectedDelivery('payload_too_large', 413);
        }
        writeJson(
          response,
          bodyResult.reason === 'too_large' ? 413 : 400,
          bodyResult.reason === 'too_large' ? 'payload_too_large' : 'stream_error',
        );
        return;
      }
      rawBody = bodyResult.body;
      // Preserve the evidence hash before trusted adapter code receives its
      // mutable Buffer view. Adapter bugs cannot rewrite the audit identity of
      // bytes that already crossed the HTTP boundary.
      const rawBodySha256 = createHash('sha256').update(rawBody).digest('hex');
      try {
        const decrypted = await options.ingressStore.readActiveCredentialVersions(
          ingress.ingress_id,
        );
        try {
          credentialVersions = decrypted.map((version) => ({
            version: version.version,
            created_at: version.created_at,
            credentials: Object.assign(Object.create(null), version.credentials),
          }));
        } finally {
          clearCredentials(decrypted);
        }
      } catch {
        if (routeStillEligible()) writeJson(response, 503, 'profile_unavailable');
        else writeNotFound(response);
        return;
      }
      if (!routeStillEligible()) {
        writeNotFound(response);
        return;
      }
      let transportEvidence: RawWebhookTransportEvidence | undefined;
      try {
        transportEvidence = normalizeTransportEvidence(
          options.captureTransportEvidence?.(request),
        );
      } catch {
        writeJson(response, 503, 'profile_unavailable');
        return;
      }
      const rawRequest: RawWebhookRequest = {
        method,
        raw_body: rawBody,
        headers,
        raw_path_and_query: rawPathAndQuery,
        canonical_public_url: canonicalPublicUrl,
        received_at: stamp,
        remote_ip: request.socket.remoteAddress ?? null,
        ...(transportEvidence !== undefined
          ? { transport_evidence: transportEvidence }
          : {}),
      };
      const context: WebhookProfileRuntimeContext = {
        ingress_id: ingress.ingress_id,
        environment: ingress.environment,
        credential_versions: credentialVersions,
        now,
      };

      if (adapter.handleHandshake) {
        let rawHandshake: WebhookHandshakeResult | null;
        try {
          rawHandshake = await withProfileTimeout(
            adapter.handleHandshake(rawRequest, context),
            profileTimeoutMs,
          );
        } catch (error) {
          if (!routeStillEligible()) {
            writeNotFound(response);
            return;
          }
          noteFailure(
            ingress.ingress_id,
            error instanceof WebhookProfileTimeoutError
              || error instanceof WebhookProfileDependencyUnavailableError
              ? 'profile_dependency_unavailable'
              : 'profile_internal_error',
          );
          writeJson(response, 503, 'profile_unavailable');
          return;
        }
        if (rawHandshake !== null) {
          if (!routeStillEligible()) {
            writeNotFound(response);
            return;
          }
          let handshake: WebhookHandshakeResult;
          try {
            handshake = normalizeHandshake(
              rawHandshake,
              descriptor,
              credentialVersions,
            );
          } catch {
            noteFailure(ingress.ingress_id, 'profile_internal_error');
            writeJson(response, 503, 'profile_unavailable');
            return;
          }
          try {
            if (!await revalidateCredentialVersion(
              options.ingressStore,
              ingress.ingress_id,
              handshake.admission.credential_version,
            )) {
              if (routeStillEligible()) writeJson(response, 503, 'profile_unavailable');
              else writeNotFound(response);
              return;
            }
          } catch {
            if (routeStillEligible()) writeJson(response, 503, 'profile_unavailable');
            else writeNotFound(response);
            return;
          }
          if (!routeStillEligible()) {
            writeNotFound(response);
            return;
          }
          if (handshake.readiness_proven) {
            try {
              options.onHandshakeReadinessProven?.(ingress.ingress_id);
            } catch {
              writeJson(response, 503, 'profile_unavailable');
              return;
            }
          }
          writeProfileResponse(response, handshake.response);
          return;
        }
      }
      if (handshakeOnlyState) {
        writeNotFound(response);
        return;
      }

      let result: WebhookProfileResult;
      try {
        result = await withProfileTimeout(
          adapter.verifyAndDecode(rawRequest, context),
          profileTimeoutMs,
        );
      } catch (error) {
        if (!routeStillEligible()) {
          writeNotFound(response);
          return;
        }
        noteFailure(
          ingress.ingress_id,
          error instanceof WebhookProfileTimeoutError
            || error instanceof WebhookProfileDependencyUnavailableError
            ? 'profile_dependency_unavailable'
            : 'profile_internal_error',
        );
        writeJson(response, 503, 'profile_unavailable');
        return;
      }
      if (!routeStillEligible()) {
        writeNotFound(response);
        return;
      }
      let resultOk: boolean | null = null;
      let resultRecord: Record<string, unknown> | null = null;
      try {
        resultRecord = assertPlainRecord(result, 'profile result');
        const ok = ownValue(resultRecord, 'ok');
        resultOk = typeof ok === 'boolean' ? ok : null;
      } catch {
        resultOk = null;
      }
      if (resultOk === null) {
        noteFailure(ingress.ingress_id, 'profile_internal_error');
        writeJson(response, 503, 'profile_unavailable');
        return;
      }
      if (!resultOk) {
        try {
          const failure = normalizeFailure(ownValue(resultRecord!, 'failure'));
          if (failure.code === 'authentication_failed'
            || failure.code === 'structural_admission_failed'
            || failure.code === 'unsupported_delivery') {
            noteRejectedDelivery(failure.code, failure.status);
          }
          noteFailure(ingress.ingress_id, failure.code);
          writeJson(response, failure.status, failure.code);
        } catch {
          noteFailure(ingress.ingress_id, 'profile_internal_error');
          writeJson(response, 503, 'profile_unavailable');
        }
        return;
      }

      let accepted: ReturnType<typeof normalizeAcceptedDelivery>;
      try {
        accepted = normalizeAcceptedDelivery(
          ownValue(resultRecord!, 'delivery'),
          descriptor,
          adapter,
          credentialVersions,
        );
      } catch {
        noteFailure(ingress.ingress_id, 'profile_internal_error');
        writeJson(response, 503, 'profile_unavailable');
        return;
      }
      if (!options.isOutboxDispatcherStarted()) {
        writeJson(response, 503, 'temporarily_unavailable');
        return;
      }
      const storeInput: WebhookAcceptedDeliveryInput = {
        ingress_id: ingress.ingress_id,
        profile_id: ingress.profile_id,
        environment: ingress.environment,
        received_at: stamp,
        delivery_dedup_key: accepted.delivery_dedup_key,
        raw_body_sha256: rawBodySha256,
        decoded_content_type: accepted.decoded_content_type,
        decoded_schema_id: descriptor.decoded_schema_id,
        transport_assurance: accepted.transport_assurance,
        minimum_source_truth_policy: descriptor.minimum_source_truth_policy,
        credential_version: accepted.credential_version,
        admission_method: accepted.admission_method,
        freshness_checked: accepted.freshness_checked,
        response: accepted.response,
        events: accepted.events,
      };
      try {
        const persisted = await options.deliveryStore.accept(storeInput);
        try {
          options.ingressStore.recordAcceptedDelivery(ingress.ingress_id, stamp);
        } catch {
          // Acceptance/outbox are already durable. Health projection is
          // best-effort and must not turn that committed success into a provider
          // retry storm; the next accepted duplicate can repair it.
          options.log?.('warn', 'webhook ingress health update failed', {
            ingress_id: ingress.ingress_id,
            code: 'health_update_failed',
          });
        }
        writeProfileResponse(response, persisted.response);
      } catch (error) {
        if (error instanceof WebhookDeliveryStoreError
          && (error.code === 'ingress_closed' || error.code === 'not_found')) {
          writeNotFound(response);
          return;
        }
        options.log?.('error', 'webhook durable acceptance failed', {
          ingress_id: ingress.ingress_id,
          code: error instanceof WebhookDeliveryStoreError
            ? error.code
            : 'storage_failure',
        });
        writeJson(response, 503, 'temporarily_unavailable');
      }
    } finally {
      rawBody?.fill(0);
      clearCredentials(credentialVersions);
      concurrent -= 1;
      const remainingForIngress = Math.max(
        0,
        (concurrentByIngress.get(ingress.ingress_id) ?? 1) - 1,
      );
      if (remainingForIngress === 0) concurrentByIngress.delete(ingress.ingress_id);
      else concurrentByIngress.set(ingress.ingress_id, remainingForIngress);
    }
  };
};
