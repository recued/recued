/** D-201 Slice 2 — trusted, server-only webhook profile runtime contracts.
 *
 * Portable profile descriptors live in `@recued/contracts`; this module is the
 * deliberately non-serializable half. It is the only profile boundary allowed
 * to receive exact request bytes, repeated signature headers, decrypted ingress
 * credentials, canonical public URLs, or listener-authenticated TLS evidence.
 * Packs and recipes can name a profile id but can never provide an adapter.
 */

import {
  webhookProfile,
  type WebhookEnvironment,
  type WebhookProfileId,
  type WebhookTransportAssurance,
} from '@recued/contracts';

export interface RawWebhookTransportEvidence {
  client_certificate_chain_der?: readonly Buffer[];
  trusted_proxy_id?: string;
}

export interface RawWebhookRequest {
  method: string;
  /** Exact HTTP entity bytes after transfer framing, before any content decode. */
  raw_body: Buffer;
  /** Lower-case names with every raw header occurrence retained in order. */
  headers: ReadonlyMap<string, readonly string[]>;
  /** Original Node request target, including the untouched query string. */
  raw_path_and_query: string;
  /** Trusted configured URL; never reconstructed from inbound forwarding headers. */
  canonical_public_url: string;
  received_at: number;
  remote_ip: string | null;
  transport_evidence?: RawWebhookTransportEvidence;
}

/** A complete active credential version. Only trusted adapter code receives
 * this plaintext, and only for the duration of one verification call. */
export interface ResolvedWebhookCredentialVersion {
  version: string;
  created_at: number;
  credentials: Readonly<Record<string, string>>;
}

export interface WebhookProfileRuntimeContext {
  ingress_id: string;
  environment: WebhookEnvironment;
  credential_versions: readonly ResolvedWebhookCredentialVersion[];
  now: () => number;
}

/** Trusted adapters use this only when an external verification dependency
 * cannot currently establish authority. The listener maps it to the same
 * retryable, content-free dependency failure as a profile timeout. */
export class WebhookProfileDependencyUnavailableError extends Error {
  constructor(message = 'webhook profile dependency is unavailable') {
    super(message);
    this.name = 'WebhookProfileDependencyUnavailableError';
  }
}

/** Core-owned inputs for one profile-aware test delivery. The adapter may use
 * the nonce only as decoded test payload data and may choose only from the
 * ingress's already-persisted event selection. It never chooses a destination
 * or suppresses the resulting ordinary event dispatch. */
export interface WebhookProfileTestDeliveryInput {
  nonce: string;
  selected_event_types: readonly string[];
}

/** Exact request bytes and authentication headers emitted by a trusted
 * profile's test builder. Core supplies Content-Type, fixes the destination to
 * the ingress's canonical HTTPS URL, disables redirects, and later requires a
 * matching durable accepted-delivery row before reporting success. */
export interface WebhookProfileTestDeliveryRequest {
  raw_body: Buffer;
  headers: Readonly<Record<string, string>>;
}

export interface AcceptedProfileEvent {
  event_dedup_key: string;
  provider_event_id: string | null;
  provider_resource_id: string | null;
  provider_event_type: string;
  /** Provider occurrence time normalized to Unix epoch milliseconds. */
  provider_occurred_at: number | null;
  decoded_payload: unknown;
}

export interface WebhookProfileHttpResponse {
  status: number;
  content_type?: string;
  body?: string;
}

export interface AcceptedProfileDelivery {
  delivery_dedup_key: string;
  decoded_content_type: string;
  events: readonly AcceptedProfileEvent[];
  response: WebhookProfileHttpResponse;
  admission: WebhookProfileAdmission;
}

/** Core-verifiable admission evidence. Handshakes carry the same evidence as
 * ordinary deliveries so credential rotation and freshness races cannot be
 * hidden behind a dynamic challenge response. */
export interface WebhookProfileAdmission {
  transport_assurance: WebhookTransportAssurance;
  credential_version: string | null;
  freshness_checked: boolean;
  method_label: string;
}

export type WebhookProfileFailureCode =
  | 'authentication_failed'
  | 'structural_admission_failed'
  | 'unsupported_delivery'
  | 'profile_dependency_unavailable'
  | 'profile_internal_error';

export type WebhookProfileResult =
  | { ok: true; delivery: AcceptedProfileDelivery }
  | {
      ok: false;
      failure: {
        disposition: 'reject' | 'retry';
        code: WebhookProfileFailureCode;
        response: WebhookProfileHttpResponse;
      };
    };

export interface WebhookHandshakeResult {
  response: WebhookProfileHttpResponse;
  readiness_proven: boolean;
  admission: WebhookProfileAdmission;
}

export interface WebhookIngressProfileAdapter {
  readonly profile_id: WebhookProfileId;
  /** Closed ordinary-delivery acknowledgement. Core compares the adapter
   * result against this exact value so decoded vendor input cannot choose a
   * synchronous response. Dynamic bodies are handshake-only. */
  readonly success_response: Readonly<WebhookProfileHttpResponse>;
  verifyAndDecode(
    request: RawWebhookRequest,
    context: WebhookProfileRuntimeContext,
  ): Promise<WebhookProfileResult>;
  handleHandshake?(
    request: RawWebhookRequest,
    context: WebhookProfileRuntimeContext,
  ): Promise<WebhookHandshakeResult | null>;
  /** Optional server-side simulator for a normal authenticated delivery. It
   * builds bytes only: core still sends them through the public listener and
   * the ordinary durable admission/dispatch path. */
  buildTestDelivery?(
    input: WebhookProfileTestDeliveryInput,
    context: WebhookProfileRuntimeContext,
  ): WebhookProfileTestDeliveryRequest | Promise<WebhookProfileTestDeliveryRequest>;
}

export interface WebhookProfileRuntimeRegistry {
  get(profileId: WebhookProfileId): WebhookIngressProfileAdapter | null;
  list(): readonly WebhookIngressProfileAdapter[];
}

/** Build a closed runtime registry. A portable descriptor is necessary but not
 * sufficient: only adapters explicitly supplied here can ever receive traffic. */
export const createWebhookProfileRuntimeRegistry = (
  adapters: readonly WebhookIngressProfileAdapter[],
): WebhookProfileRuntimeRegistry => {
  const byId = new Map<WebhookProfileId, WebhookIngressProfileAdapter>();
  for (const adapter of adapters) {
    const descriptor = webhookProfile(adapter.profile_id);
    if (!descriptor) {
      throw new Error(
        `webhook profile runtime: unknown portable profile '${adapter.profile_id}'`,
      );
    }
    if (byId.has(adapter.profile_id)) {
      throw new Error(
        `webhook profile runtime: duplicate adapter '${adapter.profile_id}'`,
      );
    }
    if ((descriptor.handshakes.length > 0) !== Boolean(adapter.handleHandshake)) {
      throw new Error(
        `webhook profile runtime: adapter '${adapter.profile_id}' handshake surface does not match its descriptor`,
      );
    }
    const successResponse = adapter.success_response;
    if (!Number.isSafeInteger(successResponse.status)
      || successResponse.status < 200
      || successResponse.status > 299) {
      throw new Error(
        `webhook profile runtime: adapter '${adapter.profile_id}' has invalid success status`,
      );
    }
    const registered: WebhookIngressProfileAdapter = Object.freeze({
      profile_id: adapter.profile_id,
      success_response: Object.freeze({ ...successResponse }),
      verifyAndDecode: adapter.verifyAndDecode.bind(adapter),
      ...(adapter.handleHandshake
        ? { handleHandshake: adapter.handleHandshake.bind(adapter) }
        : {}),
      ...(adapter.buildTestDelivery
        ? { buildTestDelivery: adapter.buildTestDelivery.bind(adapter) }
        : {}),
    });
    byId.set(adapter.profile_id, registered);
  }
  const listed = Object.freeze([...byId.values()]);
  return Object.freeze({
    get: (profileId: WebhookProfileId) => byId.get(profileId) ?? null,
    list: () => listed,
  });
};
