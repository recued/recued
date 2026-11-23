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
   * still valid. This may be provider metadata, or delivery config invariants
   * inside an already target-scoped opaque URL match. */
  correlation_valid: boolean;
  /** D-201 Slice 10BQ (10BM finding 15) — the service holds a setting for this
   *  endpoint that a set from Recued would drop, for Recued cannot send it back
   *  (a certificate it does not hold). A set again refuses over it
   *  (`certificate_unheld`); a read-back that still finds it keeps that word on
   *  the webhook, and one that no longer does clears it. Absent when none. */
  holds_unsendable?: true;
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
  | 'search_incomplete'
  /** D-201 Slice 10G — the vendor did not keep some of the names it was given
   *  (a service may skip a name it does not know). `event_types` names them. */
  | 'event_types_unknown'
  /** D-201 Slice 10BG (10BF finding 13) — the setup at the service uses a
   *  certificate set there, which Recued does not hold and a set would remove:
   *  nothing was changed. */
  | 'certificate_unheld';

/** Adapter messages are intentionally safe summaries and must not embed an API
 * response body, connection credential, endpoint secret, or request headers. */
export class WebhookRegistrationAdapterError extends Error {
  /** D-201 Slice 10O — the request was sent and no response came back (a
   *  timeout, a dropped connection): the vendor may still carry it out. A
   *  vendor that keeps an idempotency key's first response then gives that
   *  result to the same key, so the reconciler keeps the key. Only an adapter
   *  that sends the key needs to say so. */
  readonly no_response: boolean;
  /** D-201 Slice 10T (10Q finding 6) — the vendor answered that a request under
   *  this key is still being carried out (it refuses the same key meanwhile).
   *  That request may yet land, so the reconciler keeps the key, as after no
   *  response: under a new key the next create would land beside it. Only an
   *  adapter that sends the key needs to say so. */
  readonly in_progress: boolean;
  /** D-201 Slice 10O — with `event_types_unknown`: the vendor fell back to its
   *  default set of event types and could not be put back to the set it had,
   *  so it may now send every event type. */
  readonly left_on_default: boolean;
  /** D-201 Slice 10Z (10V finding 25) — with `left_on_default`: the vendor was
   *  on its default set before the change, so nothing was put back. */
  readonly was_on_default: boolean;

  constructor(
    readonly code: WebhookRegistrationAdapterErrorCode,
    message: string,
    /** The names the vendor did not keep (`event_types_unknown` only). */
    readonly event_types: readonly string[] = [],
    detail: {
      readonly no_response?: boolean;
      readonly in_progress?: boolean;
      readonly left_on_default?: boolean;
      readonly was_on_default?: boolean;
    } = {},
  ) {
    super(message);
    this.name = 'WebhookRegistrationAdapterError';
    this.no_response = detail.no_response === true;
    this.in_progress = detail.in_progress === true;
    this.left_on_default = detail.left_on_default === true;
    this.was_on_default = this.left_on_default && detail.was_on_default === true;
  }
}

/** The most event names one managed registration sends. */
export const MAX_MANAGED_WEBHOOK_EVENT_TYPES = 64;

/** D-201 Slice 10G — a managed adapter checks the desired event names where it
 *  sends them, at create and update, and nowhere else. Finding, reading and
 *  deleting never depend on them, so a webhook holding a name its grammar no
 *  longer admits (one saved before Slice 10C) can still be switched off and
 *  retired (10D finding 9). */
export const assertDesiredEventTypesAdmitted = (
  context: ManagedWebhookRegistrationContext,
  eventTypeParser: { parse(value: unknown): string | null },
  vendor: string,
): void => {
  const eventTypes = context.desired.event_types;
  if (eventTypes.length < 1
    || eventTypes.length > MAX_MANAGED_WEBHOOK_EVENT_TYPES
    || new Set(eventTypes).size !== eventTypes.length
    || eventTypes.some((eventType) => eventTypeParser.parse(eventType) === null)) {
    throw new WebhookRegistrationAdapterError(
      'registration_input_invalid',
      `${vendor} managed registration input is invalid`,
    );
  }
};

export interface WebhookManagedEndpointRegistrationAdapter {
  readonly profile_id: WebhookProfileId;
  /** D-201 Slice 10BK (10BF finding 12) — how the service names its endpoints:
   *  set when it keeps one endpoint per account under one id, so a stray of
   *  the webhook, the endpoint it committed and whatever the account now
   *  points at share that id, and only one at the webhook's address, not the
   *  committed one, can be a stray (10BA). Unset, each endpoint has an id of
   *  its own: any the search finds is that endpoint, at whatever address the
   *  service now holds for it. D-201 Slice 10BQ (10BM finding 14) — a search
   *  that matches only the address finds none whose address was edited at the
   *  service: such a stray is settled as gone while it stands, as before 10BA
   *  (stated). */
  readonly one_endpoint_per_account?: true;
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
  /** D-201 Slice 10AU (10AS finding 6) — set the endpoint's secret again, with
   *  the one the webhook holds, and change nothing else there: not whether it
   *  is switched on, not its events, not its address. Then its read-back, null
   *  when it is gone. Only for a profile whose secret Recued sets
   *  (`recuedSetsSecret`): the hourly set again (`webhook-refusal-run.ts`) uses
   *  it, never `update`, whose full set switched a hook switched off at its
   *  service back on. */
  setSecret?(
    context: ManagedWebhookRegistrationContext,
    remoteEndpointId: string,
  ): Promise<ManagedWebhookEndpointSnapshot | null>;
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
      ...(adapter.one_endpoint_per_account === true ? { one_endpoint_per_account: true as const } : {}),
      find: adapter.find.bind(adapter),
      create: adapter.create.bind(adapter),
      read: adapter.read.bind(adapter),
      update: adapter.update.bind(adapter),
      delete: adapter.delete.bind(adapter),
      ...(adapter.setSecret === undefined ? {} : { setSecret: adapter.setSecret.bind(adapter) }),
    }));
  }
  const listed = Object.freeze([...byId.values()]);
  return Object.freeze({
    get: (profileId: WebhookProfileId) => byId.get(profileId) ?? null,
    list: () => listed,
  });
};
