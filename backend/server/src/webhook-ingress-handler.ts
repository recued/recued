/** D-201 Slices 1 / 5A / 5B2B / 6B1 / 6B2 / 7D / 7E / 8D / 8G / 9BE-9BG / 9BO — owner-only webhook control-plane RPCs.
 *
 * Secret-bearing writes are validated against the trusted profile descriptor,
 * encrypted by the store, and never echoed except for a Recued-generated value
 * in the single write response where the owner may need to copy it manually.
 * Manual confirmation and enablement stay fail-closed on an injected, live
 * runtime-readiness projection; the handler never trusts client reachability.
 * Accepted-delivery inspection projects no internal dedup keys, storage refs,
 * response bodies, or credential values.
 */

import { randomBytes } from 'node:crypto';
import {
  MAX_WEBHOOK_DELIVERY_PAGE_SIZE,
  MAX_WEBHOOK_CREDENTIAL_TOTAL_BYTES,
  MAX_WEBHOOK_CREDENTIAL_VALUE_BYTES,
  MAX_WEBHOOK_EVENT_TYPES_PER_REQUIREMENT,
  MAX_WEBHOOK_INGRESS_DISPLAY_NAME_LENGTH,
  RpcError,
  WEBHOOK_ENVIRONMENTS,
  WEBHOOK_REGISTRATION_MODES,
  webhookProfile,
  webhookProfileAcceptsEventType,
  webhookProfileRequiresPairedConnection,
  type HandlerSlice,
  type ServerRpcRegistry,
  type AcceptedWebhookDeliveryRecord,
  type WebhookCredentialVersionView,
  type WebhookDeliveryDetailView,
  type WebhookDeliveryEventGetRequest,
  type WebhookDeliveryEventPayloadView,
  type WebhookDeliveryEventSummaryView,
  type WebhookDeliveryGetRequest,
  type WebhookDeliveryListCursor,
  type WebhookDeliveryListRequest,
  type WebhookDeliveryListResponse,
  type WebhookDeliveryRetentionPruneRequest,
  type WebhookDeliveryRetentionPruneResponse,
  type WebhookDeliverySummaryView,
  type WebhookRejectedDeliveryListCursor,
  type WebhookRejectedDeliveryListRequest,
  type WebhookRejectedDeliveryListResponse,
  type WebhookRejectedDeliverySummaryView,
  type WebhookEnvironment,
  type WebhookIngressCreateRequest,
  type WebhookIngressCredentialRetireRequest,
  type WebhookIngressCredentialWriteRequest,
  type WebhookIngressCredentialWriteResponse,
  type WebhookIngressDisableRequest,
  type WebhookIngressEnableRequest,
  type WebhookIngressHealthStatus,
  type WebhookIngressManualConfirmRequest,
  type WebhookIngressRegistrationReconcileRequest,
  type WebhookIngressReadinessBlocker,
  type WebhookIngressRecord,
  type WebhookIngressRetireRequest,
  type WebhookIngressTestDeliveryRequest,
  type WebhookIngressTestDeliveryResponse,
  type WebhookIngressUpdateRequest,
  type WebhookIngressView,
  type WebhookIngressListResponse,
  type WebhookProfileDescriptor,
  type WebhookProfileId,
  type WebhookProfileRuntimeCapabilityView,
  type WebhookRegistrationMode,
  type WebhookRegistrationTarget,
} from '@recued/contracts';
import type { WsClient } from './ws-server.js';
import {
  WEBHOOK_PAIRED_CONNECTION_DELETED,
  WebhookIngressStoreError,
  type WebhookCredentialVersionMetadata,
  type WebhookIngressStore,
  type WebhookIngressUpdateInput,
} from './storage/webhook-ingress-store.js';
import {
  WebhookDeliveryStoreError,
  type WebhookDeliveryStore,
  type WebhookRejectedDeliveryRecord,
  type WebhookStoredEventInspection,
} from './storage/webhook-delivery-store.js';
import {
  BUILTIN_WEBHOOK_PROFILE_POLICIES,
  type WebhookProfileControlPlanePolicyRegistry,
} from './webhook-profile-policy.js';
import {
  WebhookTestDeliveryError,
  type WebhookTestDeliveryResult,
  type WebhookTestDeliveryService,
} from './webhook-test-delivery.js';
import {
  WebhookManagedRegistrationError,
  type WebhookManagedRegistrationService,
} from './webhook-registration-reconciler.js';
import {
  WEBHOOK_CREDENTIAL_VERSION_PARSER,
  WEBHOOK_DELIVERY_ID_PARSER,
  WEBHOOK_EVENT_ID_PARSER,
  WEBHOOK_INGRESS_ID_PARSER,
  WEBHOOK_REJECTION_ID_PARSER,
} from './webhook-core-identity-parsers.js';

export interface WebhookIngressRpcDeps {
  store: WebhookIngressStore;
  /** Server-projected installed profile/mode surface. Portable descriptors do
   * not authorize creation when their executable driver is absent. */
  profileCapabilities?: readonly WebhookProfileRuntimeCapabilityView[];
  /** Trusted control-plane policy selected by profile. The built-in closed
   * registry is the compatibility default for tests and embedded callers. */
  profilePolicies?: WebhookProfileControlPlanePolicyRegistry;
  deliveryStore?: WebhookDeliveryStore;
  /** Retirement is destructive to every logical webhook binding. Production
   * supplies the consumer store's exact reference count; absence fails closed. */
  countConsumerBindings?: (ingressId: string) => number;
  /** Code-backed public-path simulator. Absence means the owner test action is
   * unavailable even if a portable descriptor happens to exist. */
  testDelivery?: WebhookTestDeliveryService;
  /** Closed trusted managed-endpoint coordinator. Packs/clients can invoke it
   * only by ingress id and never supply an outbound URL or provider request. */
  managedRegistration?: WebhookManagedRegistrationService;
  /** Trusted API-connection lookup used only to acknowledge an explicit
   * operation-bound recovery. Absence fails closed. */
  pairedConnectionAvailable?: (pairedConnectionId: string) => boolean;
  /** Code-backed remote-account continuity proof for operation-bound recovery.
   * The current generic fixture deliberately supplies none: local connection
   * name/existence is not evidence that attached remote resources belong to
   * the same account. A real adapter may inject a bounded proof later. */
  proveOperationBoundConnectionRebind?: (input: Readonly<{
    ingress: WebhookIngressRecord;
    paired_connection_id: string;
  }>) => boolean | Promise<boolean>;
  /** Injectable only for deterministic tests. Production uses 256 random bits. */
  generateSecret?: () => string;
  /** Live, server-trusted enablement evidence. Absent means no ingress can be
   * enabled, even when its persisted configuration is otherwise complete. */
  runtimeReadiness?: (
    ingress: WebhookIngressRecord,
    profile: WebhookProfileDescriptor,
  ) => WebhookIngressRuntimeReadiness | Promise<WebhookIngressRuntimeReadiness>;
}

export interface WebhookIngressRuntimeReadiness {
  endpoint_url: string | null;
  profile_runtime_available: boolean;
  paired_connection_available: boolean;
  listener_available: boolean;
  public_reachability_enabled: boolean;
  tls_ready: boolean;
  clock_ready: boolean;
  test_delivery_supported: boolean;
  vault_unlocked: boolean;
  server_unpaused: boolean;
}

type WebhookIngressMethods =
  | 'webhook.ingress.list'
  | 'webhook.ingress.get'
  | 'webhook.ingress.create'
  | 'webhook.ingress.update'
  | 'webhook.ingress.credentials.write'
  | 'webhook.ingress.credentials.retire'
  | 'webhook.ingress.manual.confirm'
  | 'webhook.ingress.registration.reconcile'
  | 'webhook.ingress.enable'
  | 'webhook.ingress.disable'
  | 'webhook.ingress.test.deliver'
  | 'webhook.ingress.retire'
  | 'webhook.delivery.list'
  | 'webhook.delivery.get'
  | 'webhook.delivery.event.get'
  | 'webhook.delivery.rejected.list'
  | 'webhook.delivery.retention.prune';

const CREATE_KEYS = new Set([
  'display_name',
  'profile_id',
  'environment',
  'paired_connection_id',
  'registration_target',
  'registration_mode',
  'selected_event_types',
]);
const UPDATE_KEYS = new Set(['ingress_id', 'patch']);
const UPDATE_PATCH_KEYS = new Set(CREATE_KEYS);
const REGISTRATION_RECONCILE_KEYS = new Set(['ingress_id', 'paired_connection_id']);
const CREDENTIAL_WRITE_KEYS = new Set(['ingress_id', 'credentials']);
const CREDENTIAL_RETIRE_KEYS = new Set(['ingress_id', 'credential_version']);
const RETIRE_KEYS = new Set(['ingress_id']);
const DELIVERY_LIST_KEYS = new Set(['ingress_id', 'limit', 'cursor']);
const DELIVERY_CURSOR_KEYS = new Set(['received_at', 'delivery_id']);
const DELIVERY_GET_KEYS = new Set(['ingress_id', 'delivery_id']);
const DELIVERY_EVENT_GET_KEYS = new Set(['ingress_id', 'delivery_id', 'event_id']);
const REJECTED_DELIVERY_LIST_KEYS = new Set(['ingress_id', 'limit', 'cursor']);
const REJECTED_DELIVERY_CURSOR_KEYS = new Set(['bucket_started_at', 'rejection_id']);
const RETENTION_PRUNE_KEYS = new Set(['ingress_id']);

const badRequest = (message: string): RpcError =>
  new RpcError('bad_request', message, 400);

const profilePolicies = (
  deps: WebhookIngressRpcDeps,
): WebhookProfileControlPlanePolicyRegistry =>
  deps.profilePolicies ?? BUILTIN_WEBHOOK_PROFILE_POLICIES;

const ensureProfileCapability = (
  deps: WebhookIngressRpcDeps,
  method: string,
  profileId: WebhookProfileId,
  mode: WebhookRegistrationMode,
): void => {
  const capability = deps.profileCapabilities?.find((candidate) =>
    candidate.profile_id === profileId);
  if (!capability || !capability.registration_modes.includes(mode)) {
    throw new RpcError(
      'webhook_profile_unavailable',
      `${method}: profile '${profileId}' has no installed '${mode}' runtime`,
      501,
    );
  }
};

const ensureIngressProfileCapability = (
  deps: WebhookIngressRpcDeps,
  method: string,
  ingress: Pick<WebhookIngressRecord, 'profile_id' | 'registration_mode'>,
): void => ensureProfileCapability(
  deps,
  method,
  ingress.profile_id,
  ingress.registration_mode,
);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const ensureRecord = (method: string, value: unknown, field = 'args'): Record<string, unknown> => {
  if (!isRecord(value)) throw badRequest(`${method}: ${field} must be an object`);
  return value;
};

const ensureOnlyKeys = (
  method: string,
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field = 'args',
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw badRequest(`${method}: unknown ${field} field '${key}'`);
    }
  }
};

/** RPC payloads originate as JSON, but handler exports are also callable from
 * in-process tests/adapters. Never let an inherited value satisfy a required or
 * optional control-plane field if Object.prototype was polluted elsewhere. */
const ownValue = (
  value: Record<string, unknown>,
  key: string,
): unknown => Object.prototype.hasOwnProperty.call(value, key)
  ? value[key]
  : undefined;

const requireOwnerClient = (
  method: string,
  caller: { instance_id: string | null | undefined } | undefined,
): void => {
  if (!caller?.instance_id) {
    throw new RpcError(
      'permission_denied',
      `${method}: requires a registered paired owner client`,
      403,
    );
  }
};

const ensureIngressId = (method: string, value: unknown): string => {
  const ingressId = WEBHOOK_INGRESS_ID_PARSER.parse(value);
  if (ingressId === null) {
    throw badRequest(`${method}: ingress_id has invalid shape`);
  }
  return ingressId;
};

const ensureDeliveryId = (method: string, value: unknown): string => {
  const deliveryId = WEBHOOK_DELIVERY_ID_PARSER.parse(value);
  if (deliveryId === null) {
    throw badRequest(`${method}: delivery_id has invalid shape`);
  }
  return deliveryId;
};

const ensureEventId = (method: string, value: unknown): string => {
  const eventId = WEBHOOK_EVENT_ID_PARSER.parse(value);
  if (eventId === null) {
    throw badRequest(`${method}: event_id has invalid shape`);
  }
  return eventId;
};

const ensureDeliveryLimit = (method: string, value: unknown): number => {
  if (value === undefined) return 10;
  if (!Number.isSafeInteger(value)
    || (value as number) < 1
    || (value as number) > MAX_WEBHOOK_DELIVERY_PAGE_SIZE) {
    throw badRequest(
      `${method}: limit must be in 1..${MAX_WEBHOOK_DELIVERY_PAGE_SIZE}`,
    );
  }
  return value as number;
};

const ensureDeliveryCursor = (
  method: string,
  value: unknown,
): WebhookDeliveryListCursor | undefined => {
  if (value === undefined) return undefined;
  const cursor = ensureRecord(method, value, 'cursor');
  ensureOnlyKeys(method, cursor, DELIVERY_CURSOR_KEYS, 'cursor');
  const receivedAt = ownValue(cursor, 'received_at');
  if (!Number.isSafeInteger(receivedAt) || (receivedAt as number) < 0) {
    throw badRequest(`${method}: cursor.received_at is invalid`);
  }
  return {
    received_at: receivedAt as number,
    delivery_id: ensureDeliveryId(method, ownValue(cursor, 'delivery_id')),
  };
};

const ensureRejectionId = (method: string, value: unknown): string => {
  const rejectionId = WEBHOOK_REJECTION_ID_PARSER.parse(value);
  if (rejectionId === null) {
    throw badRequest(`${method}: rejection_id has invalid shape`);
  }
  return rejectionId;
};

const ensureRejectedDeliveryCursor = (
  method: string,
  value: unknown,
): WebhookRejectedDeliveryListCursor | undefined => {
  if (value === undefined) return undefined;
  const cursor = ensureRecord(method, value, 'cursor');
  ensureOnlyKeys(method, cursor, REJECTED_DELIVERY_CURSOR_KEYS, 'cursor');
  const bucketStartedAt = ownValue(cursor, 'bucket_started_at');
  if (!Number.isSafeInteger(bucketStartedAt) || (bucketStartedAt as number) < 0) {
    throw badRequest(`${method}: cursor.bucket_started_at is invalid`);
  }
  return {
    bucket_started_at: bucketStartedAt as number,
    rejection_id: ensureRejectionId(method, ownValue(cursor, 'rejection_id')),
  };
};

const ensureDisplayName = (method: string, value: unknown): string => {
  if (typeof value !== 'string'
    || value.trim().length === 0
    || value.length > MAX_WEBHOOK_INGRESS_DISPLAY_NAME_LENGTH) {
    throw badRequest(
      `${method}: display_name must be non-empty and at most ${MAX_WEBHOOK_INGRESS_DISPLAY_NAME_LENGTH} characters`,
    );
  }
  return value;
};

const ensureProfile = (method: string, value: unknown): WebhookProfileDescriptor => {
  const profile = webhookProfile(value);
  if (!profile) throw badRequest(`${method}: profile_id is not registered`);
  return profile;
};

const ensureEnvironment = (method: string, value: unknown): WebhookEnvironment => {
  if (typeof value !== 'string'
    || !(WEBHOOK_ENVIRONMENTS as readonly string[]).includes(value)) {
    throw badRequest(`${method}: environment is invalid`);
  }
  return value as WebhookEnvironment;
};

const ensureRegistrationMode = (
  method: string,
  value: unknown,
): WebhookRegistrationMode => {
  if (typeof value !== 'string'
    || !(WEBHOOK_REGISTRATION_MODES as readonly string[]).includes(value)) {
    throw badRequest(`${method}: registration_mode is invalid`);
  }
  return value as WebhookRegistrationMode;
};

const ensurePairedConnectionId = (
  method: string,
  value: unknown,
): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    throw badRequest(`${method}: paired_connection_id must be null or a non-empty string`);
  }
  return value;
};

const ensureRegistrationTarget = (
  deps: WebhookIngressRpcDeps,
  method: string,
  value: unknown,
  profile: WebhookProfileDescriptor,
  mode: WebhookRegistrationMode,
): WebhookRegistrationTarget | null => {
  const resolved = profilePolicies(deps).get(profile.profile_id)
    .resolveRegistrationTarget(value, mode);
  if (!resolved.ok) throw badRequest(`${method}: ${resolved.message}`);
  return resolved.target;
};

const ensureSelectedEventTypes = (
  method: string,
  value: unknown,
  profile: WebhookProfileDescriptor,
): string[] => {
  if (!Array.isArray(value)
    || value.length === 0
    || value.length > MAX_WEBHOOK_EVENT_TYPES_PER_REQUIREMENT) {
    throw badRequest(
      `${method}: selected_event_types must contain 1..${MAX_WEBHOOK_EVENT_TYPES_PER_REQUIREMENT} events`,
    );
  }
  const seen = new Set<string>();
  const selected: string[] = [];
  for (let i = 0; i < value.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(value, i)) {
      throw badRequest(`${method}: selected_event_types must not be sparse`);
    }
    const eventType = value[i];
    if (!webhookProfileAcceptsEventType(profile, eventType)) {
      throw badRequest(
        `${method}: selected_event_types[${i}] is not admitted by profile '${profile.profile_id}'`,
      );
    }
    if (seen.has(eventType)) {
      throw badRequest(`${method}: selected_event_types contains duplicate '${eventType}'`);
    }
    seen.add(eventType);
    selected.push(eventType);
  }
  return selected;
};

const validateProfileConfiguration = (
  method: string,
  profile: WebhookProfileDescriptor,
  environment: WebhookEnvironment,
  mode: WebhookRegistrationMode,
  pairedConnectionId: string | null,
): void => {
  if (!profile.supported_environments.includes(environment)) {
    throw badRequest(
      `${method}: environment '${environment}' is not supported by profile '${profile.profile_id}'`,
    );
  }
  if (!profile.registration_modes.includes(mode)) {
    throw badRequest(
      `${method}: registration_mode '${mode}' is not supported by profile '${profile.profile_id}'`,
    );
  }
  if (webhookProfileRequiresPairedConnection(profile, mode)
    && pairedConnectionId === null) {
    throw badRequest(
      `${method}: paired_connection_id is required for registration_mode '${mode}'`,
    );
  }
};

const storeErrorToRpc = (method: string, error: WebhookIngressStoreError): RpcError => {
  switch (error.code) {
    case 'not_found':
      return new RpcError('not_found', `${method}: ${error.message}`, 404);
    case 'locked':
      return new RpcError('locked', `${method}: ${error.message}`, 423);
    case 'conflict':
      return new RpcError('conflict', `${method}: ${error.message}`, 409);
    case 'retired':
    case 'invalid_state':
    case 'immutable':
      return new RpcError('invalid_state', `${method}: ${error.message}`, 409);
    case 'corrupt':
      return new RpcError('storage_corrupt', `${method}: webhook metadata is corrupt`, 500);
  }
};

const withStoreErrors = <T>(method: string, fn: () => T): T => {
  try {
    return fn();
  } catch (error) {
    if (error instanceof WebhookIngressStoreError) throw storeErrorToRpc(method, error);
    throw error;
  }
};

const withStoreErrorsAsync = async <T>(method: string, fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof WebhookIngressStoreError) throw storeErrorToRpc(method, error);
    throw error;
  }
};

const deliveryStoreErrorToRpc = (
  method: string,
  error: WebhookDeliveryStoreError,
): RpcError => {
  switch (error.code) {
    case 'not_found':
      return new RpcError('not_found', `${method}: accepted delivery data not found`, 404);
    case 'locked':
      return new RpcError('locked', `${method}: webhook payload vault is locked`, 423);
    case 'conflict':
    case 'stale_claim':
    case 'ingress_closed':
    case 'backpressure':
      return new RpcError('conflict', `${method}: webhook delivery state changed`, 409);
    case 'corrupt':
      return new RpcError('storage_corrupt', `${method}: webhook delivery data is corrupt`, 500);
  }
};

const withDeliveryStoreErrors = <T>(method: string, fn: () => T): T => {
  try {
    return fn();
  } catch (error) {
    if (error instanceof WebhookDeliveryStoreError) {
      throw deliveryStoreErrorToRpc(method, error);
    }
    throw error;
  }
};

const withDeliveryStoreErrorsAsync = async <T>(
  method: string,
  fn: () => Promise<T>,
): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof WebhookDeliveryStoreError) {
      throw deliveryStoreErrorToRpc(method, error);
    }
    throw error;
  }
};

const testDeliveryErrorToRpc = (
  method: string,
  error: WebhookTestDeliveryError,
): RpcError => {
  switch (error.code) {
    case 'invalid_state':
      return new RpcError('invalid_state', `${method}: ${error.message}`, 409);
    case 'unsupported':
    case 'profile_unavailable':
      return new RpcError(
        'webhook_test_unavailable',
        `${method}: test delivery is unavailable`,
        503,
      );
    case 'request_failed':
    case 'not_observed':
      return new RpcError(
        'webhook_test_unconfirmed',
        `${method}: ${error.message}`,
        409,
      );
    case 'accepted_response_unconfirmed':
    case 'accepted_state_changed':
      return new RpcError(
        'webhook_test_accepted_unconfirmed',
        `${method}: ${error.message}`,
        409,
      );
  }
};

const managedRegistrationErrorToRpc = (
  method: string,
  error: WebhookManagedRegistrationError,
): RpcError => {
  switch (error.code) {
    case 'unsupported':
      return new RpcError(
        'webhook_registration_unavailable',
        `${method}: managed registration is unavailable for this profile`,
        501,
      );
    case 'endpoint_unavailable':
      return new RpcError(
        'webhook_not_ready',
        `${method}: ${error.message}`,
        409,
        method,
        { blockers: ['public_url_unavailable'] },
      );
    case 'invalid_state':
    case 'environment_mismatch':
      return new RpcError('invalid_state', `${method}: ${error.message}`, 409);
    case 'ambiguous':
    case 'remote_missing':
      return new RpcError(
        'webhook_registration_ambiguous',
        `${method}: ${error.message}`,
        409,
      );
    case 'state_changed':
      return new RpcError('conflict', `${method}: ${error.message}`, 409);
    case 'connection_unavailable':
      return new RpcError(
        'webhook_registration_unavailable',
        `${method}: ${error.message}`,
        503,
      );
    case 'upstream_unavailable':
    case 'upstream_rejected':
      return new RpcError(
        'webhook_registration_unconfirmed',
        `${method}: ${error.message}`,
        error.code === 'upstream_rejected' ? 409 : 503,
      );
  }
};

const healthStatusFor = (
  row: WebhookIngressRecord,
  runtimeReady: boolean,
  registrationReady: boolean,
): WebhookIngressHealthStatus => {
  if (row.intake_state === 'retired') return 'retired';
  if (row.intake_state === 'disabled') return 'disabled';
  if (row.intake_state === 'degraded'
    || row.registration_state === 'drifted'
    || row.registration_state === 'cleanup_pending'
    || row.last_error_code !== null) return 'degraded';
  if (row.intake_state === 'enabled') {
    return runtimeReady && registrationReady ? 'healthy'
      : 'degraded';
  }
  if (row.intake_state === 'ready') return 'ready';
  if (row.intake_state === 'draft') return 'draft';
  return 'pending';
};

const UNAVAILABLE_RUNTIME_READINESS: WebhookIngressRuntimeReadiness = Object.freeze({
  endpoint_url: null,
  profile_runtime_available: false,
  paired_connection_available: false,
  listener_available: false,
  public_reachability_enabled: false,
  tls_ready: false,
  clock_ready: false,
  test_delivery_supported: false,
  vault_unlocked: false,
  server_unpaused: true,
});

export const projectWebhookIngress = (
  store: WebhookIngressStore,
  row: WebhookIngressRecord,
  runtimeReadiness: WebhookIngressRuntimeReadiness = UNAVAILABLE_RUNTIME_READINESS,
): WebhookIngressView => {
  const profile = webhookProfile(row.profile_id);
  if (!profile) {
    throw new WebhookIngressStoreError(
      'corrupt',
      `webhook ingress '${row.ingress_id}' references an unknown profile`,
    );
  }
  const credentialVersions = store.listCredentialVersions(row.ingress_id);
  const activeMetadata = credentialVersions.filter((entry) => entry.active);
  const configuredFields = activeMetadata[0]?.configured_fields.slice() ?? [];
  const configuredSet = new Set(configuredFields);
  const missingRequiredFields = profile.fields
    .filter((field) => field.required && !configuredSet.has(field.key))
    .map((field) => field.key);
  const credentialsComplete = activeMetadata.length > 0 && missingRequiredFields.length === 0;
  const registrationStateComplete = row.registration_state === 'registered'
    || row.registration_state === 'not_applicable';
  const registrationEndpointMatches = row.registration_mode === 'operation_bound'
    || (runtimeReadiness.endpoint_url !== null
      && row.confirmed_endpoint_url === runtimeReadiness.endpoint_url);
  const eventSelectionComplete = row.selected_event_types.length > 0;
  const pairedConnectionRequired = webhookProfileRequiresPairedConnection(
    profile,
    row.registration_mode,
  );
  const localBlockers: WebhookIngressReadinessBlocker[] = [];
  if (!credentialsComplete) localBlockers.push('credentials_incomplete');
  if (!registrationStateComplete) localBlockers.push('registration_incomplete');
  if (!eventSelectionComplete) localBlockers.push('event_selection_empty');
  if (pairedConnectionRequired
    && row.last_error_code === WEBHOOK_PAIRED_CONNECTION_DELETED) {
    localBlockers.push('paired_connection_rebind_required');
  }
  if (row.intake_state === 'retired') localBlockers.push('retired');
  const runtimeBlockers: WebhookIngressReadinessBlocker[] = [];
  if (row.intake_state !== 'retired') {
    if (registrationStateComplete && !registrationEndpointMatches) {
      runtimeBlockers.push('registration_endpoint_changed');
    }
    if (!runtimeReadiness.profile_runtime_available) {
      runtimeBlockers.push('profile_runtime_unavailable');
    }
    if (pairedConnectionRequired && !runtimeReadiness.paired_connection_available) {
      runtimeBlockers.push('paired_connection_unavailable');
    }
    if (!runtimeReadiness.listener_available) runtimeBlockers.push('listener_unavailable');
    if (runtimeReadiness.endpoint_url === null) runtimeBlockers.push('public_url_unavailable');
    if (!runtimeReadiness.public_reachability_enabled) {
      runtimeBlockers.push('public_reachability_disabled');
    }
    if (!runtimeReadiness.tls_ready) runtimeBlockers.push('tls_unavailable');
    if (!runtimeReadiness.clock_ready) runtimeBlockers.push('clock_unverified');
    if (!runtimeReadiness.vault_unlocked) runtimeBlockers.push('vault_locked');
    if (!runtimeReadiness.server_unpaused) runtimeBlockers.push('server_paused');
  }
  const blockers = [...localBlockers, ...runtimeBlockers];

  const activeVersions: WebhookCredentialVersionView[] = activeMetadata.map((entry) => ({
    version: entry.version,
    created_at: entry.created_at,
    retired_at: entry.retired_at,
    last_verified_at: entry.last_verified_at,
  }));
  return {
    ingress_id: row.ingress_id,
    public_id: row.public_id,
    display_name: row.display_name,
    profile_id: row.profile_id,
    environment: row.environment,
    paired_connection_id: row.paired_connection_id,
    registration_target: row.registration_target === null
      ? null
      : { ...row.registration_target },
    pending_paired_connection_id: row.pending_paired_connection_id ?? null,
    registration_mode: row.registration_mode,
    endpoint_url: runtimeReadiness.endpoint_url,
    remote_endpoint_id: row.remote_endpoint_id,
    selected_event_types: row.selected_event_types.slice(),
    registration_state: row.registration_state,
    intake_state: row.intake_state,
    configured_fields: configuredFields,
    missing_required_fields: missingRequiredFields,
    active_credential_versions: activeVersions,
    readiness: {
      credentials_complete: credentialsComplete,
      registration_complete: registrationStateComplete,
      registration_endpoint_matches: registrationEndpointMatches,
      event_selection_complete: eventSelectionComplete,
      local_configuration_complete: localBlockers.length === 0,
      profile_runtime_available: runtimeReadiness.profile_runtime_available,
      paired_connection_available: runtimeReadiness.paired_connection_available,
      listener_available: runtimeReadiness.listener_available,
      public_url_available: runtimeReadiness.endpoint_url !== null,
      public_reachability_enabled: runtimeReadiness.public_reachability_enabled,
      tls_ready: runtimeReadiness.tls_ready,
      clock_ready: runtimeReadiness.clock_ready,
      test_delivery_supported: runtimeReadiness.test_delivery_supported,
      vault_unlocked: runtimeReadiness.vault_unlocked,
      server_unpaused: runtimeReadiness.server_unpaused,
      can_enable: blockers.length === 0,
      blockers,
    },
    health: {
      status: healthStatusFor(
        row,
        runtimeBlockers.length === 0,
        registrationStateComplete && registrationEndpointMatches,
      ),
      test_observed_at: row.test_observed_at,
      last_delivery_at: row.last_delivery_at,
      last_error_code: row.last_error_code,
    },
    enabled_at: row.enabled_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
};

const project = async (
  deps: WebhookIngressRpcDeps,
  method: string,
  row: WebhookIngressRecord,
): Promise<WebhookIngressView> => {
  const profile = webhookProfile(row.profile_id);
  if (!profile) {
    throw storeErrorToRpc(method, new WebhookIngressStoreError(
      'corrupt',
      `webhook ingress '${row.ingress_id}' references an unknown profile`,
    ));
  }
  let runtime = UNAVAILABLE_RUNTIME_READINESS;
  if (deps.runtimeReadiness) {
    try {
      runtime = await deps.runtimeReadiness(row, profile);
    } catch {
      // Readiness is an availability dependency. A failed probe must project a
      // closed ingress instead of making owner list/get fail or look ready.
      runtime = UNAVAILABLE_RUNTIME_READINESS;
    }
  }
  return withStoreErrors(
    method,
    () => projectWebhookIngress(deps.store, row, runtime),
  );
};

const requireDeliveryStore = (
  deps: WebhookIngressRpcDeps,
  method: string,
): WebhookDeliveryStore => {
  if (!deps.deliveryStore) {
    throw new RpcError(
      'not_configured',
      `${method}: webhook delivery inspection is unavailable`,
      501,
    );
  }
  return deps.deliveryStore;
};

const requireOwnerIngress = (
  deps: WebhookIngressRpcDeps,
  method: string,
  ingressId: string,
): WebhookIngressRecord => {
  const ingress = withStoreErrors(method, () => deps.store.get(ingressId));
  if (!ingress) throw new RpcError('not_found', `${method}: delivery not found`, 404);
  return ingress;
};

const deliverySummaryView = (
  delivery: AcceptedWebhookDeliveryRecord,
): WebhookDeliverySummaryView => ({
  delivery_id: delivery.delivery_id,
  ingress_id: delivery.ingress_id,
  profile_id: delivery.profile_id,
  environment: delivery.environment,
  received_at: delivery.received_at,
  raw_body_sha256: delivery.raw_body_sha256,
  raw_body_retained: delivery.raw_body_ref !== null,
  decoded_content_type: delivery.decoded_content_type,
  decoded_schema_id: delivery.decoded_schema_id,
  transport_assurance: delivery.transport_assurance,
  minimum_source_truth_policy: delivery.minimum_source_truth_policy,
  credential_version: delivery.credential_version,
  admission_method: delivery.admission_method,
  freshness_checked: delivery.freshness_checked,
  event_count: delivery.event_count,
  metadata_expires_at: delivery.expires_at,
});

const deliveryEventSummaryView = (
  stored: WebhookStoredEventInspection,
): WebhookDeliveryEventSummaryView => {
  const base = {
    event_id: stored.event.event_id,
    delivery_id: stored.event.delivery_id,
    ingress_id: stored.event.ingress_id,
    event_index: stored.event.event_index,
    provider_event_id: stored.event.provider_event_id,
    provider_resource_id: stored.event.provider_resource_id,
    provider_event_type: stored.event.provider_event_type,
    provider_occurred_at: stored.event.provider_occurred_at,
    selected_for_dispatch: stored.event.selected_for_dispatch,
    dispatch_state: stored.event.dispatch_state,
    metadata_expires_at: stored.event.expires_at,
  };
  return stored.payload_retained
    ? {
        ...base,
        payload_retained: true,
        payload_expires_at: stored.payload_expires_at,
      }
    : {
        ...base,
        payload_retained: false,
        payload_expires_at: null,
      };
};

const rejectedDeliverySummaryView = (
  rejection: WebhookRejectedDeliveryRecord,
): WebhookRejectedDeliverySummaryView => ({
  rejection_id: rejection.rejection_id,
  ingress_id: rejection.ingress_id,
  profile_id: rejection.profile_id,
  environment: rejection.environment,
  reason_code: rejection.reason_code,
  http_status: rejection.http_status,
  bucket_started_at: rejection.bucket_started_at,
  first_recorded_at: rejection.first_recorded_at,
  last_recorded_at: rejection.last_recorded_at,
  recorded_attempt_count: rejection.recorded_attempt_count,
  metadata_prune_eligible_at: rejection.expires_at,
});

const parseCredentialVersion = (method: string, value: unknown): number => {
  const parsed = WEBHOOK_CREDENTIAL_VERSION_PARSER.parse(value);
  if (!parsed.ok) {
    throw badRequest(parsed.reason === 'invalid_shape'
      ? `${method}: credential_version has invalid shape`
      : `${method}: credential_version is out of range`);
  }
  return parsed.value;
};

const buildCredentialVersion = (
  method: string,
  profile: WebhookProfileDescriptor,
  value: unknown,
  generateSecret: () => string,
): {
  credentials: Record<string, string>;
  generated: Record<string, string>;
} => {
  const input = ensureRecord(method, value, 'credentials');
  const descriptorByKey = new Map(profile.fields.map((field) => [field.key, field]));
  for (const key of Object.keys(input)) {
    const descriptor = descriptorByKey.get(key);
    if (!descriptor) throw badRequest(`${method}: unknown credential field '${key}'`);
    if (descriptor.source === 'recued_generated'
      || descriptor.source === 'managed_registration_result') {
      throw badRequest(`${method}: credential field '${key}' is generated by trusted core`);
    }
  }

  const credentials = Object.create(null) as Record<string, string>;
  const generated = Object.create(null) as Record<string, string>;
  let totalBytes = 0;
  const append = (key: string, raw: unknown): void => {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw badRequest(`${method}: credential field '${key}' must be a non-empty string`);
    }
    const bytes = Buffer.byteLength(raw, 'utf8');
    if (bytes > MAX_WEBHOOK_CREDENTIAL_VALUE_BYTES) {
      throw badRequest(
        `${method}: credential field '${key}' exceeds ${MAX_WEBHOOK_CREDENTIAL_VALUE_BYTES} bytes`,
      );
    }
    totalBytes += bytes;
    if (totalBytes > MAX_WEBHOOK_CREDENTIAL_TOTAL_BYTES) {
      throw badRequest(
        `${method}: credential set exceeds ${MAX_WEBHOOK_CREDENTIAL_TOTAL_BYTES} bytes`,
      );
    }
    credentials[key] = raw;
  };

  for (const descriptor of profile.fields) {
    if (descriptor.source === 'recued_generated') {
      const secret = generateSecret();
      append(descriptor.key, secret);
      generated[descriptor.key] = secret;
      continue;
    }
    const supplied = ownValue(input, descriptor.key);
    if (supplied === undefined) {
      if (descriptor.required) {
        throw badRequest(`${method}: missing required credential field '${descriptor.key}'`);
      }
      continue;
    }
    append(descriptor.key, supplied);
  }
  return { credentials, generated };
};

const clearCredentialRecord = (credentials: Record<string, string>): void => {
  for (const key of Object.keys(credentials)) credentials[key] = '';
};

const ensureActiveCredentialShapes = async (
  deps: WebhookIngressRpcDeps,
  method: string,
  ingress: WebhookIngressRecord,
): Promise<void> => {
  const versions = await withStoreErrorsAsync(
    method,
    () => deps.store.readActiveCredentialVersions(ingress.ingress_id),
  );
  try {
    const policy = profilePolicies(deps).get(ingress.profile_id);
    if (versions.some((version) =>
      !policy.validateCredentialShape(version.credentials))) {
      throw new RpcError(
        'webhook_not_ready',
        `${method}: replace or retire malformed webhook credential versions`,
        409,
        method,
        { blockers: ['credential_shape_invalid'] },
      );
    }
  } finally {
    for (const version of versions) {
      clearCredentialRecord(version.credentials);
    }
  }
};

export const handleWebhookIngressList = async (
  deps: WebhookIngressRpcDeps,
  args: { include_retired?: boolean } | void,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<WebhookIngressListResponse> => {
  const method = 'webhook.ingress.list';
  requireOwnerClient(method, caller);
  let includeRetired = false;
  if (args !== undefined) {
    const input = ensureRecord(method, args);
    ensureOnlyKeys(method, input, new Set(['include_retired']));
    const includeRetiredValue = ownValue(input, 'include_retired');
    if (includeRetiredValue !== undefined && typeof includeRetiredValue !== 'boolean') {
      throw badRequest(`${method}: include_retired must be a boolean`);
    }
    includeRetired = includeRetiredValue === true;
  }
  const rows = withStoreErrors(method, () => deps.store.list({
    include_retired: includeRetired,
  }));
  return {
    ingresses: await Promise.all(rows.map((row) => project(deps, method, row))),
    profiles: (deps.profileCapabilities ?? []).map((profile) => ({
      profile_id: profile.profile_id,
      registration_modes: profile.registration_modes.slice(),
      deduplication: {
        ...profile.deduplication,
        identity: { ...profile.deduplication.identity },
      },
    })),
  };
};

export const handleWebhookIngressGet = async (
  deps: WebhookIngressRpcDeps,
  args: { ingress_id: string },
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<{ ingress: WebhookIngressView | null }> => {
  const method = 'webhook.ingress.get';
  requireOwnerClient(method, caller);
  const input = ensureRecord(method, args);
  ensureOnlyKeys(method, input, RETIRE_KEYS);
  const ingressId = ensureIngressId(method, ownValue(input, 'ingress_id'));
  const row = withStoreErrors(method, () => deps.store.get(ingressId));
  return { ingress: row ? await project(deps, method, row) : null };
};

export const handleWebhookIngressCreate = async (
  deps: WebhookIngressRpcDeps,
  args: WebhookIngressCreateRequest,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<{ ingress: WebhookIngressView }> => {
  const method = 'webhook.ingress.create';
  requireOwnerClient(method, caller);
  const input = ensureRecord(method, args);
  ensureOnlyKeys(method, input, CREATE_KEYS);
  const displayName = ensureDisplayName(method, ownValue(input, 'display_name'));
  const profile = ensureProfile(method, ownValue(input, 'profile_id'));
  const environment = ensureEnvironment(method, ownValue(input, 'environment'));
  const registrationMode = ensureRegistrationMode(
    method,
    ownValue(input, 'registration_mode'),
  );
  const pairedConnectionId = ensurePairedConnectionId(
    method,
    ownValue(input, 'paired_connection_id'),
  );
  validateProfileConfiguration(
    method,
    profile,
    environment,
    registrationMode,
    pairedConnectionId,
  );
  ensureProfileCapability(deps, method, profile.profile_id, registrationMode);
  const registrationTarget = ensureRegistrationTarget(
    deps,
    method,
    ownValue(input, 'registration_target'),
    profile,
    registrationMode,
  );
  const selectedEventTypes = ensureSelectedEventTypes(
    method,
    ownValue(input, 'selected_event_types'),
    profile,
  );
  const row = withStoreErrors(method, () => deps.store.create({
    display_name: displayName,
    profile_id: profile.profile_id,
    environment,
    paired_connection_id: pairedConnectionId,
    registration_target: registrationTarget,
    registration_mode: registrationMode,
    selected_event_types: selectedEventTypes,
  }));
  return { ingress: await project(deps, method, row) };
};

export const handleWebhookIngressUpdate = async (
  deps: WebhookIngressRpcDeps,
  args: WebhookIngressUpdateRequest,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<{ ingress: WebhookIngressView }> => {
  const method = 'webhook.ingress.update';
  requireOwnerClient(method, caller);
  const input = ensureRecord(method, args);
  ensureOnlyKeys(method, input, UPDATE_KEYS);
  const ingressId = ensureIngressId(method, ownValue(input, 'ingress_id'));
  const patch = ensureRecord(method, ownValue(input, 'patch'), 'patch');
  ensureOnlyKeys(method, patch, UPDATE_PATCH_KEYS, 'patch');
  if (Object.keys(patch).length === 0) throw badRequest(`${method}: patch must not be empty`);
  const current = withStoreErrors(method, () => deps.store.get(ingressId));
  if (!current) throw new RpcError('not_found', `${method}: ingress not found`, 404);

  const profileId = ownValue(patch, 'profile_id');
  const environmentValue = ownValue(patch, 'environment');
  const registrationModeValue = ownValue(patch, 'registration_mode');
  const pairedConnectionProvided = Object.prototype.hasOwnProperty.call(
    patch,
    'paired_connection_id',
  );
  const pairedConnectionValue = ownValue(patch, 'paired_connection_id');
  const registrationTargetProvided = Object.prototype.hasOwnProperty.call(
    patch,
    'registration_target',
  );
  const registrationTargetValue = ownValue(patch, 'registration_target');
  const displayNameValue = ownValue(patch, 'display_name');
  const selectedEventTypesValue = ownValue(patch, 'selected_event_types');
  const profile = profileId !== undefined
    ? ensureProfile(method, profileId)
    : ensureProfile(method, current.profile_id);
  const environment = environmentValue !== undefined
    ? ensureEnvironment(method, environmentValue)
    : current.environment;
  const registrationMode = registrationModeValue !== undefined
    ? ensureRegistrationMode(method, registrationModeValue)
    : current.registration_mode;
  const pairedConnectionId = pairedConnectionProvided
    ? ensurePairedConnectionId(method, pairedConnectionValue)
    : current.paired_connection_id;
  validateProfileConfiguration(
    method,
    profile,
    environment,
    registrationMode,
    pairedConnectionId,
  );
  // Renaming is recovery-safe metadata. Every other patch changes profile
  // configuration or provider authority and therefore requires the selected
  // delivery/mode runtime to remain installed.
  if (Object.keys(patch).some((key) => key !== 'display_name')) {
    ensureProfileCapability(deps, method, profile.profile_id, registrationMode);
  }
  const registrationTarget = ensureRegistrationTarget(
    deps,
    method,
    registrationTargetProvided ? registrationTargetValue : current.registration_target,
    profile,
    registrationMode,
  );

  const storePatch: WebhookIngressUpdateInput = {};
  if (displayNameValue !== undefined) {
    storePatch.display_name = ensureDisplayName(method, displayNameValue);
  }
  if (profileId !== undefined) storePatch.profile_id = profile.profile_id;
  if (environmentValue !== undefined) storePatch.environment = environment;
  if (pairedConnectionProvided) {
    storePatch.paired_connection_id = pairedConnectionId;
  }
  if (registrationTargetProvided) {
    storePatch.registration_target = registrationTarget;
  }
  if (registrationModeValue !== undefined) storePatch.registration_mode = registrationMode;
  if (selectedEventTypesValue !== undefined || profileId !== undefined) {
    storePatch.selected_event_types = ensureSelectedEventTypes(
      method,
      selectedEventTypesValue ?? current.selected_event_types,
      profile,
    );
  }
  if (current.registration_mode === 'managed_endpoint'
    && pairedConnectionValue !== undefined
    && pairedConnectionId !== current.paired_connection_id) {
    if (Object.keys(patch).length !== 1) {
      throw badRequest(
        `${method}: managed paired connection replacement must be its own update`,
      );
    }
    if (pairedConnectionId === null) {
      throw badRequest(`${method}: managed paired connection cannot be cleared`);
    }
    if (!deps.managedRegistration) {
      throw new RpcError(
        'webhook_registration_unavailable',
        `${method}: managed connection replacement is not configured`,
        501,
      );
    }
    try {
      const row = await deps.managedRegistration.rebind(ingressId, pairedConnectionId);
      return { ingress: await project(deps, method, row) };
    } catch (error) {
      if (error instanceof WebhookManagedRegistrationError) {
        throw managedRegistrationErrorToRpc(method, error);
      }
      if (error instanceof WebhookIngressStoreError) {
        throw storeErrorToRpc(method, error);
      }
      throw error;
    }
  }
  if (current.registration_mode === 'operation_bound'
    && current.last_error_code === WEBHOOK_PAIRED_CONNECTION_DELETED
    && pairedConnectionProvided) {
    if (Object.keys(patch).length !== 1) {
      throw badRequest(
        `${method}: paired connection recovery must be its own update`,
      );
    }
    if (pairedConnectionId === null
      || !(deps.pairedConnectionAvailable?.(pairedConnectionId) ?? false)) {
      throw new RpcError(
        'webhook_connection_unavailable',
        `${method}: replacement paired connection is unavailable`,
        409,
      );
    }
    if (!deps.proveOperationBoundConnectionRebind) {
      throw new RpcError(
        'webhook_connection_rebind_unavailable',
        `${method}: no code-backed operation-bound account-continuity proof is installed`,
        501,
      );
    }
    let continuityProven = false;
    try {
      continuityProven = await deps.proveOperationBoundConnectionRebind({
        ingress: current,
        paired_connection_id: pairedConnectionId,
      }) === true;
    } catch {
      throw new RpcError(
        'webhook_connection_rebind_unavailable',
        `${method}: operation-bound account-continuity proof is unavailable`,
        503,
      );
    }
    if (!continuityProven) {
      throw new RpcError(
        'webhook_connection_rebind_unconfirmed',
        `${method}: replacement connection did not prove remote-account continuity`,
        409,
      );
    }
    if (!(deps.pairedConnectionAvailable?.(pairedConnectionId) ?? false)) {
      throw new RpcError(
        'webhook_connection_unavailable',
        `${method}: replacement paired connection changed during continuity proof`,
        409,
      );
    }
    const recovered = withStoreErrors(
      method,
      () => deps.store.recoverDeletedOperationBoundConnection(
        ingressId,
        pairedConnectionId,
      ),
    );
    return { ingress: await project(deps, method, recovered) };
  }
  const row = withStoreErrors(method, () => deps.store.update(ingressId, storePatch));
  return { ingress: await project(deps, method, row) };
};

export const handleWebhookCredentialWrite = async (
  deps: WebhookIngressRpcDeps,
  args: WebhookIngressCredentialWriteRequest,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<WebhookIngressCredentialWriteResponse> => {
  const method = 'webhook.ingress.credentials.write';
  requireOwnerClient(method, caller);
  const input = ensureRecord(method, args);
  ensureOnlyKeys(method, input, CREDENTIAL_WRITE_KEYS);
  const ingressId = ensureIngressId(method, ownValue(input, 'ingress_id'));
  const row = withStoreErrors(method, () => deps.store.get(ingressId));
  if (!row) throw new RpcError('not_found', `${method}: ingress not found`, 404);
  const profile = ensureProfile(method, row.profile_id);
  if (row.registration_mode === 'managed_endpoint') {
    throw new RpcError(
      'invalid_state',
      `${method}: managed endpoint credentials are captured only by trusted registration`,
      409,
    );
  }
  if (row.registration_mode !== 'manual'
    && profile.fields.some((field) =>
      field.source === 'vendor_generated'
        || field.source === 'managed_registration_result')) {
    throw new RpcError(
      'invalid_state',
      `${method}: provider-returned credentials are captured only by managed registration`,
      409,
    );
  }
  ensureIngressProfileCapability(deps, method, row);
  const generateSecret = deps.generateSecret
    ?? (() => randomBytes(32).toString('base64url'));
  const credentialVersion = buildCredentialVersion(
    method,
    profile,
    ownValue(input, 'credentials'),
    generateSecret,
  );
  if (!profilePolicies(deps).get(profile.profile_id)
    .validateCredentialShape(credentialVersion.credentials)) {
    clearCredentialRecord(credentialVersion.credentials);
    throw badRequest(
      `${method}: credential fields are invalid for profile '${profile.profile_id}'`,
    );
  }
  let written: WebhookCredentialVersionMetadata;
  try {
    written = await withStoreErrorsAsync(
      method,
      () => deps.store.writeCredentialVersion(ingressId, credentialVersion.credentials),
    );
  } finally {
    clearCredentialRecord(credentialVersion.credentials);
  }
  let updated = withStoreErrors(method, () => deps.store.get(ingressId));
  if (!updated) throw new RpcError('not_found', `${method}: ingress disappeared`, 404);
  if (updated.registration_mode === 'operation_bound' && profile.handshakes.length === 0) {
    withStoreErrors(method, () => deps.store.confirmOperationBoundReadiness(ingressId));
    updated = withStoreErrors(method, () => deps.store.get(ingressId));
  }
  if (!updated) throw new RpcError('not_found', `${method}: ingress disappeared`, 404);
  const response: WebhookIngressCredentialWriteResponse = {
    ingress: await project(deps, method, updated),
    credential_version: {
      version: written.version,
      created_at: written.created_at,
      retired_at: written.retired_at,
      last_verified_at: written.last_verified_at,
    },
  };
  if (Object.keys(credentialVersion.generated).length > 0) {
    response.one_time_generated_credentials = credentialVersion.generated;
  }
  return response;
};

export const handleWebhookCredentialRetire = async (
  deps: WebhookIngressRpcDeps,
  args: WebhookIngressCredentialRetireRequest,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<{ ingress: WebhookIngressView }> => {
  const method = 'webhook.ingress.credentials.retire';
  requireOwnerClient(method, caller);
  const input = ensureRecord(method, args);
  ensureOnlyKeys(method, input, CREDENTIAL_RETIRE_KEYS);
  const ingressId = ensureIngressId(method, ownValue(input, 'ingress_id'));
  const version = parseCredentialVersion(method, ownValue(input, 'credential_version'));
  const row = withStoreErrors(
    method,
    () => deps.store.retireCredentialVersion(ingressId, version),
  );
  return { ingress: await project(deps, method, row) };
};

export const handleWebhookManualRegistrationConfirm = async (
  deps: WebhookIngressRpcDeps,
  args: WebhookIngressManualConfirmRequest,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<{ ingress: WebhookIngressView }> => {
  const method = 'webhook.ingress.manual.confirm';
  requireOwnerClient(method, caller);
  const input = ensureRecord(method, args);
  ensureOnlyKeys(method, input, RETIRE_KEYS);
  const ingressId = ensureIngressId(method, ownValue(input, 'ingress_id'));
  const current = withStoreErrors(method, () => deps.store.get(ingressId));
  if (!current) throw new RpcError('not_found', `${method}: ingress not found`, 404);
  if (current.registration_mode !== 'manual') {
    throw new RpcError(
      'invalid_state',
      `${method}: ingress does not use manual registration`,
      409,
    );
  }
  ensureIngressProfileCapability(deps, method, current);
  const currentView = await project(deps, method, current);
  if (!currentView.readiness.credentials_complete) {
    throw new RpcError(
      'webhook_not_ready',
      `${method}: write a complete credential version before confirming registration`,
      409,
      method,
      { blockers: ['credentials_incomplete'] },
    );
  }
  if (currentView.endpoint_url === null) {
    throw new RpcError(
      'webhook_not_ready',
      `${method}: configure a trusted public HTTPS URL before confirming registration`,
      409,
      method,
      { blockers: ['public_url_unavailable'] },
    );
  }
  await ensureActiveCredentialShapes(deps, method, current);
  const profile = ensureProfile(method, current.profile_id);
  const row = withStoreErrors(
    method,
    () => deps.store.confirmManualRegistration(ingressId, {
      requires_handshake: profile.handshakes.length > 0,
      endpoint_url: currentView.endpoint_url!,
    }),
  );
  return { ingress: await project(deps, method, row) };
};

export const handleWebhookManagedRegistrationReconcile = async (
  deps: WebhookIngressRpcDeps,
  args: WebhookIngressRegistrationReconcileRequest,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<{ ingress: WebhookIngressView }> => {
  const method = 'webhook.ingress.registration.reconcile';
  requireOwnerClient(method, caller);
  const input = ensureRecord(method, args);
  ensureOnlyKeys(method, input, REGISTRATION_RECONCILE_KEYS);
  const ingressId = ensureIngressId(method, ownValue(input, 'ingress_id'));
  const current = withStoreErrors(method, () => deps.store.get(ingressId));
  if (!current) throw new RpcError('not_found', `${method}: ingress not found`, 404);
  if (current.registration_mode !== 'managed_endpoint') {
    throw new RpcError(
      'invalid_state',
      `${method}: ingress does not use managed endpoint registration`,
      409,
    );
  }
  const pairedConnectionValue = ownValue(input, 'paired_connection_id');
  const requestedConnectionId = pairedConnectionValue === undefined
    ? null
    : ensurePairedConnectionId(method, pairedConnectionValue);
  if (pairedConnectionValue !== undefined && requestedConnectionId === null) {
    throw badRequest(`${method}: paired_connection_id must be a non-empty string`);
  }
  const pendingConnectionId = current.pending_paired_connection_id ?? null;
  // Only an exact retry of an already-persisted cutover intent is recovery.
  // A caller cannot use cleanup_pending as a capability bypass to substitute a
  // different connection or to start fresh reconciliation.
  const exactCleanupRetry = current.registration_state === 'cleanup_pending'
    && pendingConnectionId !== null
    && (requestedConnectionId === null || requestedConnectionId === pendingConnectionId);
  if (!exactCleanupRetry) ensureIngressProfileCapability(deps, method, current);
  if (!deps.managedRegistration) {
    throw new RpcError(
      'webhook_registration_unavailable',
      `${method}: managed registration is not configured`,
      501,
    );
  }
  const cutoverConnectionId = requestedConnectionId ?? pendingConnectionId;
  let row: WebhookIngressRecord;
  try {
    row = cutoverConnectionId !== null
      && (cutoverConnectionId !== current.paired_connection_id
        || pendingConnectionId !== null)
      ? await deps.managedRegistration.rebind(ingressId, cutoverConnectionId)
      : await deps.managedRegistration.reconcile(ingressId);
  } catch (error) {
    if (error instanceof WebhookManagedRegistrationError) {
      throw managedRegistrationErrorToRpc(method, error);
    }
    if (error instanceof WebhookIngressStoreError) {
      throw storeErrorToRpc(method, error);
    }
    throw error;
  }
  return { ingress: await project(deps, method, row) };
};

export const handleWebhookIngressEnable = async (
  deps: WebhookIngressRpcDeps,
  args: WebhookIngressEnableRequest,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<{ ingress: WebhookIngressView }> => {
  const method = 'webhook.ingress.enable';
  requireOwnerClient(method, caller);
  const input = ensureRecord(method, args);
  ensureOnlyKeys(method, input, RETIRE_KEYS);
  const ingressId = ensureIngressId(method, ownValue(input, 'ingress_id'));
  const current = withStoreErrors(method, () => deps.store.get(ingressId));
  if (!current) throw new RpcError('not_found', `${method}: ingress not found`, 404);
  ensureIngressProfileCapability(deps, method, current);
  const currentView = await project(deps, method, current);
  if (!currentView.readiness.can_enable) {
    throw new RpcError(
      'webhook_not_ready',
      `${method}: webhook ingress is not ready to enable`,
      409,
      method,
      { blockers: currentView.readiness.blockers.slice() },
    );
  }
  await ensureActiveCredentialShapes(deps, method, current);
  // Runtime prerequisites can change while encrypted credential shapes are
  // being revalidated. Re-read them immediately before the state mutation so
  // a clock-health expiry (or any other live gate) cannot ride a stale first
  // projection into enabled intake.
  const recheckedView = await project(deps, method, current);
  if (!recheckedView.readiness.can_enable) {
    throw new RpcError(
      'webhook_not_ready',
      `${method}: webhook ingress is not ready to enable`,
      409,
      method,
      { blockers: recheckedView.readiness.blockers.slice() },
    );
  }
  if (current.intake_state === 'enabled' || current.intake_state === 'degraded') {
    return { ingress: recheckedView };
  }
  const row = withStoreErrors(method, () => deps.store.enable(ingressId));
  return { ingress: await project(deps, method, row) };
};

export const handleWebhookIngressDisable = async (
  deps: WebhookIngressRpcDeps,
  args: WebhookIngressDisableRequest,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<{ ingress: WebhookIngressView }> => {
  const method = 'webhook.ingress.disable';
  requireOwnerClient(method, caller);
  const input = ensureRecord(method, args);
  ensureOnlyKeys(method, input, RETIRE_KEYS);
  const ingressId = ensureIngressId(method, ownValue(input, 'ingress_id'));
  const current = withStoreErrors(method, () => deps.store.get(ingressId));
  if (!current) throw new RpcError('not_found', `${method}: ingress not found`, 404);
  let row: WebhookIngressRecord;
  if (current.registration_mode === 'managed_endpoint') {
    row = withStoreErrors(method, () => deps.store.disable(ingressId));
    if (row.registration_state === 'cleanup_pending') {
      if (!deps.managedRegistration) {
        throw new RpcError(
          'webhook_registration_unavailable',
          `${method}: local intake is disabled but provider cleanup is unavailable`,
          503,
        );
      } else {
        try {
          row = await deps.managedRegistration.cleanup(ingressId, 'disable');
        } catch (error) {
          if (error instanceof WebhookManagedRegistrationError) {
            throw managedRegistrationErrorToRpc(method, error);
          }
          if (error instanceof WebhookIngressStoreError) {
            throw storeErrorToRpc(method, error);
          }
          throw error;
        }
      }
    }
  } else {
    row = withStoreErrors(method, () => deps.store.disable(ingressId));
  }
  return { ingress: await project(deps, method, row) };
};

export const handleWebhookIngressTestDelivery = async (
  deps: WebhookIngressRpcDeps,
  args: WebhookIngressTestDeliveryRequest,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<WebhookIngressTestDeliveryResponse> => {
  const method = 'webhook.ingress.test.deliver';
  requireOwnerClient(method, caller);
  const input = ensureRecord(method, args);
  ensureOnlyKeys(method, input, RETIRE_KEYS);
  const ingressId = ensureIngressId(method, ownValue(input, 'ingress_id'));
  const current = withStoreErrors(method, () => deps.store.get(ingressId));
  if (!current) throw new RpcError('not_found', `${method}: ingress not found`, 404);
  ensureIngressProfileCapability(deps, method, current);
  if (current.environment !== 'test') {
    throw new RpcError(
      'invalid_state',
      `${method}: use a separate test-environment ingress`,
      409,
    );
  }
  if (current.intake_state !== 'enabled' && current.intake_state !== 'degraded') {
    throw new RpcError(
      'invalid_state',
      `${method}: enable the test ingress before sending a test delivery`,
      409,
    );
  }
  const currentView = await project(deps, method, current);
  if (!deps.testDelivery || !currentView.readiness.test_delivery_supported) {
    throw new RpcError(
      'webhook_test_unavailable',
      `${method}: this profile has no code-backed test delivery`,
      503,
    );
  }
  if (currentView.endpoint_url === null || !currentView.readiness.can_enable) {
    throw new RpcError(
      'webhook_not_ready',
      `${method}: webhook test delivery prerequisites are not ready`,
      409,
      method,
      { blockers: currentView.readiness.blockers.slice() },
    );
  }
  let result: WebhookTestDeliveryResult;
  try {
    result = await deps.testDelivery.deliver({
      ingress: current,
      endpoint_url: currentView.endpoint_url,
    });
  } catch (error) {
    if (error instanceof WebhookTestDeliveryError) {
      throw testDeliveryErrorToRpc(method, error);
    }
    throw error;
  }
  const refreshed = withStoreErrors(method, () => deps.store.get(ingressId));
  if (!refreshed) {
    throw new RpcError('not_found', `${method}: ingress not found`, 404);
  }
  return {
    ingress: await project(deps, method, refreshed),
    delivery_id: result.delivery_id,
    observed_at: result.observed_at,
  };
};

export const handleWebhookIngressRetire = async (
  deps: WebhookIngressRpcDeps,
  args: WebhookIngressRetireRequest,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<{ ingress: WebhookIngressView }> => {
  const method = 'webhook.ingress.retire';
  requireOwnerClient(method, caller);
  const input = ensureRecord(method, args);
  ensureOnlyKeys(method, input, RETIRE_KEYS);
  const ingressId = ensureIngressId(method, ownValue(input, 'ingress_id'));
  const current = withStoreErrors(method, () => deps.store.get(ingressId));
  if (!current) throw new RpcError('not_found', `${method}: ingress not found`, 404);
  // A completed retirement is idempotent and no longer depends on live binding
  // authority. `cleanup_pending` is intentionally not complete: repeating this
  // RPC is the owner-visible retry for provider deletion.
  if (current.intake_state === 'retired'
    && current.registration_state === 'retired') {
    return { ingress: await project(deps, method, current) };
  }
  const retryingCleanup = current.intake_state === 'retired'
    && current.registration_state === 'cleanup_pending';
  if (!retryingCleanup && !deps.countConsumerBindings) {
    throw new RpcError(
      'not_configured',
      `${method}: webhook binding authority is unavailable`,
      501,
    );
  }
  const bindingCount = retryingCleanup ? 0 : deps.countConsumerBindings!(ingressId);
  if (!Number.isSafeInteger(bindingCount) || bindingCount < 0) {
    throw new RpcError(
      'storage_corrupt',
      `${method}: webhook binding count is corrupt`,
      500,
    );
  }
  if (bindingCount > 0) {
    throw new RpcError(
      'webhook_in_use',
      `${method}: remove or rebind every webhook consumer before retirement`,
      409,
      method,
      { binding_count: bindingCount },
    );
  }
  let row: WebhookIngressRecord;
  if (current.registration_mode === 'managed_endpoint') {
    row = withStoreErrors(method, () => deps.store.retire(ingressId));
    if (row.registration_state === 'cleanup_pending') {
      if (!deps.managedRegistration) {
        throw new RpcError(
          'webhook_registration_unavailable',
          `${method}: local retirement is committed but provider cleanup is unavailable`,
          503,
        );
      } else {
        try {
          row = await deps.managedRegistration.cleanup(ingressId, 'retire');
        } catch (error) {
          if (error instanceof WebhookManagedRegistrationError) {
            throw managedRegistrationErrorToRpc(method, error);
          }
          if (error instanceof WebhookIngressStoreError) {
            throw storeErrorToRpc(method, error);
          }
          throw error;
        }
      }
    }
  } else {
    row = withStoreErrors(method, () => deps.store.retire(ingressId));
  }
  return { ingress: await project(deps, method, row) };
};

export const handleWebhookDeliveryList = async (
  deps: WebhookIngressRpcDeps,
  args: WebhookDeliveryListRequest,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<WebhookDeliveryListResponse> => {
  const method = 'webhook.delivery.list';
  requireOwnerClient(method, caller);
  const input = ensureRecord(method, args);
  ensureOnlyKeys(method, input, DELIVERY_LIST_KEYS);
  const ingressId = ensureIngressId(method, ownValue(input, 'ingress_id'));
  requireOwnerIngress(deps, method, ingressId);
  const limit = ensureDeliveryLimit(method, ownValue(input, 'limit'));
  const cursor = ensureDeliveryCursor(method, ownValue(input, 'cursor'));
  const store = requireDeliveryStore(deps, method);
  const page = withDeliveryStoreErrors(method, () => store.listDeliveriesPage({
    ingress_id: ingressId,
    limit,
    ...(cursor !== undefined ? { cursor } : {}),
  }));
  const last = page.deliveries.at(-1);
  return {
    deliveries: page.deliveries.map(deliverySummaryView),
    next_cursor: page.has_more && last
      ? { received_at: last.received_at, delivery_id: last.delivery_id }
      : null,
  };
};

export const handleWebhookRejectedDeliveryList = async (
  deps: WebhookIngressRpcDeps,
  args: WebhookRejectedDeliveryListRequest,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<WebhookRejectedDeliveryListResponse> => {
  const method = 'webhook.delivery.rejected.list';
  requireOwnerClient(method, caller);
  const input = ensureRecord(method, args);
  ensureOnlyKeys(method, input, REJECTED_DELIVERY_LIST_KEYS);
  const ingressId = ensureIngressId(method, ownValue(input, 'ingress_id'));
  const ingress = requireOwnerIngress(deps, method, ingressId);
  const limit = ensureDeliveryLimit(method, ownValue(input, 'limit'));
  const cursor = ensureRejectedDeliveryCursor(method, ownValue(input, 'cursor'));
  const store = requireDeliveryStore(deps, method);
  const page = withDeliveryStoreErrors(
    method,
    () => store.listRejectedDeliveriesPage({
      ingress_id: ingressId,
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
    }),
  );
  if (page.rejections.some((rejection) => rejection.ingress_id !== ingressId
    || rejection.profile_id !== ingress.profile_id
    || rejection.environment !== ingress.environment)) {
    throw new RpcError(
      'storage_corrupt',
      `${method}: webhook rejection identity is corrupt`,
      500,
    );
  }
  const last = page.rejections.at(-1);
  return {
    rejections: page.rejections.map(rejectedDeliverySummaryView),
    next_cursor: page.has_more && last
      ? {
          bucket_started_at: last.bucket_started_at,
          rejection_id: last.rejection_id,
        }
      : null,
  };
};

export const handleWebhookDeliveryRetentionPrune = async (
  deps: WebhookIngressRpcDeps,
  args: WebhookDeliveryRetentionPruneRequest,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<WebhookDeliveryRetentionPruneResponse> => {
  const method = 'webhook.delivery.retention.prune';
  requireOwnerClient(method, caller);
  const input = ensureRecord(method, args);
  ensureOnlyKeys(method, input, RETENTION_PRUNE_KEYS);
  const ingressId = ensureIngressId(method, ownValue(input, 'ingress_id'));
  requireOwnerIngress(deps, method, ingressId);
  const store = requireDeliveryStore(deps, method);
  return {
    result: withDeliveryStoreErrors(
      method,
      () => store.pruneIngress({ ingress_id: ingressId }),
    ),
  };
};

const requireDeliveryDetail = (
  deps: WebhookIngressRpcDeps,
  method: string,
  ingressId: string,
  deliveryId: string,
): WebhookDeliveryDetailView => {
  requireOwnerIngress(deps, method, ingressId);
  const store = requireDeliveryStore(deps, method);
  const delivery = withDeliveryStoreErrors(method, () => store.getDelivery(deliveryId));
  if (!delivery || delivery.ingress_id !== ingressId) {
    throw new RpcError('not_found', `${method}: delivery not found`, 404);
  }
  const events = withDeliveryStoreErrors(
    method,
    () => store.listEventsForDelivery(deliveryId),
  );
  if (events.some((stored) =>
    stored.event.delivery_id !== deliveryId
      || stored.event.ingress_id !== ingressId)) {
    throw new RpcError(
      'storage_corrupt',
      `${method}: webhook delivery data is corrupt`,
      500,
    );
  }
  return {
    delivery: deliverySummaryView(delivery),
    events: events.map(deliveryEventSummaryView),
  };
};

export const handleWebhookDeliveryGet = async (
  deps: WebhookIngressRpcDeps,
  args: WebhookDeliveryGetRequest,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<{ detail: WebhookDeliveryDetailView }> => {
  const method = 'webhook.delivery.get';
  requireOwnerClient(method, caller);
  const input = ensureRecord(method, args);
  ensureOnlyKeys(method, input, DELIVERY_GET_KEYS);
  const ingressId = ensureIngressId(method, ownValue(input, 'ingress_id'));
  const deliveryId = ensureDeliveryId(method, ownValue(input, 'delivery_id'));
  return { detail: requireDeliveryDetail(deps, method, ingressId, deliveryId) };
};

export const handleWebhookDeliveryEventGet = async (
  deps: WebhookIngressRpcDeps,
  args: WebhookDeliveryEventGetRequest,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<{ event: WebhookDeliveryEventPayloadView }> => {
  const method = 'webhook.delivery.event.get';
  requireOwnerClient(method, caller);
  const input = ensureRecord(method, args);
  ensureOnlyKeys(method, input, DELIVERY_EVENT_GET_KEYS);
  const ingressId = ensureIngressId(method, ownValue(input, 'ingress_id'));
  const deliveryId = ensureDeliveryId(method, ownValue(input, 'delivery_id'));
  const eventId = ensureEventId(method, ownValue(input, 'event_id'));
  const detail = requireDeliveryDetail(deps, method, ingressId, deliveryId);
  const summary = detail.events.find((event) => event.event_id === eventId);
  if (!summary) throw new RpcError('not_found', `${method}: event not found`, 404);
  if (!summary.payload_retained) {
    return { event: { event: summary, payload_retained: false } };
  }
  const store = requireDeliveryStore(deps, method);
  const retained = await withDeliveryStoreErrorsAsync(
    method,
    () => store.readRetainedEventPayload(eventId),
  );
  if (!retained) {
    return {
      event: {
        event: {
          ...summary,
          payload_retained: false,
          payload_expires_at: null,
        },
        payload_retained: false,
      },
    };
  }
  return {
    event: {
      event: summary,
      payload_retained: true,
      payload: retained.payload,
    },
  };
};

export const makeWebhookIngressHandlers = (
  deps: WebhookIngressRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, WebhookIngressMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  const caller = (client: WsClient | undefined): { instance_id: string | null } | undefined =>
    client ? { instance_id: client.instance_id ?? null } : undefined;
  return {
    methods: [
      'webhook.ingress.list',
      'webhook.ingress.get',
      'webhook.ingress.create',
      'webhook.ingress.update',
      'webhook.ingress.credentials.write',
      'webhook.ingress.credentials.retire',
      'webhook.ingress.manual.confirm',
      'webhook.ingress.registration.reconcile',
      'webhook.ingress.enable',
      'webhook.ingress.disable',
      'webhook.ingress.test.deliver',
      'webhook.ingress.retire',
      'webhook.delivery.list',
      'webhook.delivery.get',
      'webhook.delivery.event.get',
      'webhook.delivery.rejected.list',
      'webhook.delivery.retention.prune',
    ],
    handlers: {
      'webhook.ingress.list': (args, client) =>
        handleWebhookIngressList(deps, args, caller(client)),
      'webhook.ingress.get': (args, client) =>
        handleWebhookIngressGet(deps, args, caller(client)),
      'webhook.ingress.create': (args, client) =>
        handleWebhookIngressCreate(deps, args, caller(client)),
      'webhook.ingress.update': (args, client) =>
        handleWebhookIngressUpdate(deps, args, caller(client)),
      'webhook.ingress.credentials.write': (args, client) =>
        handleWebhookCredentialWrite(deps, args, caller(client)),
      'webhook.ingress.credentials.retire': (args, client) =>
        handleWebhookCredentialRetire(deps, args, caller(client)),
      'webhook.ingress.manual.confirm': (args, client) =>
        handleWebhookManualRegistrationConfirm(deps, args, caller(client)),
      'webhook.ingress.registration.reconcile': (args, client) =>
        handleWebhookManagedRegistrationReconcile(deps, args, caller(client)),
      'webhook.ingress.enable': (args, client) =>
        handleWebhookIngressEnable(deps, args, caller(client)),
      'webhook.ingress.disable': (args, client) =>
        handleWebhookIngressDisable(deps, args, caller(client)),
      'webhook.ingress.test.deliver': (args, client) =>
        handleWebhookIngressTestDelivery(deps, args, caller(client)),
      'webhook.ingress.retire': (args, client) =>
        handleWebhookIngressRetire(deps, args, caller(client)),
      'webhook.delivery.list': (args, client) =>
        handleWebhookDeliveryList(deps, args, caller(client)),
      'webhook.delivery.get': (args, client) =>
        handleWebhookDeliveryGet(deps, args, caller(client)),
      'webhook.delivery.event.get': (args, client) =>
        handleWebhookDeliveryEventGet(deps, args, caller(client)),
      'webhook.delivery.rejected.list': (args, client) =>
        handleWebhookRejectedDeliveryList(deps, args, caller(client)),
      'webhook.delivery.retention.prune': (args, client) =>
        handleWebhookDeliveryRetentionPrune(deps, args, caller(client)),
    },
  };
};
