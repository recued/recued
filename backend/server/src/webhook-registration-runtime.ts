/** D-201 Slices 6A + 8D + 8E — trusted managed-endpoint registration contracts.
 *
 * This is deliberately a code-only surface. A pack can request a registered
 * profile and select events, but it cannot provide an HTTP template, callback
 * URL, provider metadata, idempotency key, connection credential, or response
 * parser. Those values are derived by core and handed only to one closed
 * adapter selected by profile id.
 */

import {
  webhookProfile,
  type WebhookEnvironment,
  type WebhookProfileId,
  type WebhookRegistrationTarget,
} from '@recued/contracts';

export interface ManagedWebhookEndpointDesired {
  ingress_id: string;
  environment: WebhookEnvironment;
  registration_target: WebhookRegistrationTarget | null;
  endpoint_url: string;
  event_types: readonly string[];
}

export interface ManagedWebhookEndpointSnapshot {
  remote_endpoint_id: string;
  environment: WebhookEnvironment;
  endpoint_url: string;
  event_types: readonly string[];
  enabled: boolean;
  /** Closed profile-specific evidence not represented by the common fields is
   * still valid. This may be provider metadata (Stripe) or delivery config
   * invariants inside an already target-scoped opaque URL match (GitHub). */
  correlation_valid: boolean;
}

export interface ManagedWebhookEndpointMatch {
  endpoint: ManagedWebhookEndpointSnapshot;
  /** `owned` means the closed adapter proved its profile-specific deletion
   * authority: correlation metadata, or a pinned provider target plus this
   * ingress's opaque URL. The other values are collision evidence only. */
  correlation: 'owned' | 'url_only' | 'metadata_conflict';
}

export interface ManagedWebhookRegistrationContext {
  paired_connection_id: string;
  desired: ManagedWebhookEndpointDesired;
}

export interface ManagedWebhookEndpointCreateResult {
  endpoint: ManagedWebhookEndpointSnapshot;
  /** Plaintext exists only until the ingress store encrypts the result in the
   * same local transaction as the remote id. It must never enter an RPC view. */
  credential_result: Readonly<Record<string, string>>;
}

export type WebhookRegistrationAdapterErrorCode =
  | 'registration_input_invalid'
  | 'connection_unavailable'
  | 'connection_locked'
  | 'connection_auth_invalid'
  | 'environment_mismatch'
  | 'upstream_unavailable'
  | 'upstream_rejected'
  | 'upstream_response_invalid'
  | 'upstream_response_too_large'
  | 'search_incomplete';

/** Adapter messages are intentionally safe summaries and must not embed an API
 * response body, connection credential, endpoint secret, or request headers. */
export class WebhookRegistrationAdapterError extends Error {
  constructor(
    readonly code: WebhookRegistrationAdapterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WebhookRegistrationAdapterError';
  }
}

export interface WebhookManagedEndpointRegistrationAdapter {
  readonly profile_id: WebhookProfileId;
  find(
    context: ManagedWebhookRegistrationContext,
  ): Promise<readonly ManagedWebhookEndpointMatch[]>;
  create(
    context: ManagedWebhookRegistrationContext,
    idempotencyKey: string,
  ): Promise<ManagedWebhookEndpointCreateResult>;
  read(
    context: ManagedWebhookRegistrationContext,
    remoteEndpointId: string,
  ): Promise<ManagedWebhookEndpointSnapshot | null>;
  update(
    context: ManagedWebhookRegistrationContext,
    remoteEndpointId: string,
    idempotencyKey: string,
  ): Promise<ManagedWebhookEndpointSnapshot>;
  delete(
    context: ManagedWebhookRegistrationContext,
    remoteEndpointId: string,
  ): Promise<void>;
}

export interface WebhookRegistrationRuntimeRegistry {
  get(profileId: WebhookProfileId): WebhookManagedEndpointRegistrationAdapter | null;
  list(): readonly WebhookManagedEndpointRegistrationAdapter[];
}

export const createWebhookRegistrationRuntimeRegistry = (
  adapters: readonly WebhookManagedEndpointRegistrationAdapter[],
): WebhookRegistrationRuntimeRegistry => {
  const byId = new Map<WebhookProfileId, WebhookManagedEndpointRegistrationAdapter>();
  for (const adapter of adapters) {
    const descriptor = webhookProfile(adapter.profile_id);
    if (!descriptor) {
      throw new Error(
        `webhook registration runtime: unknown profile '${adapter.profile_id}'`,
      );
    }
    if (!descriptor.registration_modes.includes('managed_endpoint')
      || !descriptor.managed_registration_requires_connection) {
      throw new Error(
        `webhook registration runtime: profile '${adapter.profile_id}' does not declare connection-bound managed registration`,
      );
    }
    if (byId.has(adapter.profile_id)) {
      throw new Error(
        `webhook registration runtime: duplicate adapter '${adapter.profile_id}'`,
      );
    }
    byId.set(adapter.profile_id, Object.freeze({
      profile_id: adapter.profile_id,
      find: adapter.find.bind(adapter),
      create: adapter.create.bind(adapter),
      read: adapter.read.bind(adapter),
      update: adapter.update.bind(adapter),
      delete: adapter.delete.bind(adapter),
    }));
  }
  const listed = Object.freeze([...byId.values()]);
  return Object.freeze({
    get: (profileId: WebhookProfileId) => byId.get(profileId) ?? null,
    list: () => listed,
  });
};
