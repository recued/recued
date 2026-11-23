/** D-201 Slices 6A + 6B1 + 6B2 + 8D — ambiguity-safe managed-endpoint lifecycle.
 *
 * No local transaction can include a provider API call. This coordinator uses
 * a durable attempt generation for provider idempotency, searches correlation
 * metadata/canonical URL before create, deletes a conclusively-owned orphan
 * whose one-time secret was lost, requires remote read-back, then atomically
 * commits the remote id and encrypted credential result. Disable/retire closes
 * locally first, serializes behind reconciliation, and confirms remote absence
 * before finalizing cleanup.
 */

import { createHash } from 'node:crypto';
import {
  MAX_WEBHOOK_EVENT_TYPES_PER_REQUIREMENT,
  webhookProfile,
  webhookProfileAcceptsEventType,
  type WebhookIngressRecord,
} from '@recued/contracts';
import {
  WebhookIngressStoreError,
  type WebhookIngressStore,
  type WebhookManagedRegistrationCleanupIntent,
  type WebhookManagedRegistrationExpectation,
  type WebhookManagedRegistrationFailureCode,
  type WebhookUnsettledCreate,
} from './storage/webhook-ingress-store.js';
import {
  WebhookRegistrationAdapterError,
  type ManagedWebhookEndpointDesired,
  type ManagedWebhookEndpointMatch,
  type ManagedWebhookEndpointSnapshot,
  type ManagedWebhookRegistrationContext,
  type WebhookRegistrationRuntimeRegistry,
} from './webhook-registration-runtime.js';
import {
  BUILTIN_WEBHOOK_PROFILE_POLICIES,
  type WebhookProfileControlPlanePolicyRegistry,
} from './webhook-profile-policy.js';
import { mayBeSetAgain } from './webhook-refusal-run.js';

export type WebhookManagedRegistrationErrorCode =
  | 'unsupported'
  | 'invalid_state'
  | 'endpoint_unavailable'
  | 'ambiguous'
  | 'remote_missing'
  | 'connection_unavailable'
  | 'environment_mismatch'
  | 'upstream_unavailable'
  | 'upstream_rejected'
  | 'state_changed'
  /** D-201 Slice 10G — the vendor did not keep these names (`event_types`). */
  | 'event_types_unknown';

export class WebhookManagedRegistrationError extends Error {
  constructor(
    readonly code: WebhookManagedRegistrationErrorCode,
    message: string,
    /** The names the vendor did not keep (`event_types_unknown` only). */
    readonly event_types: readonly string[] = [],
    /** D-201 Slice 10O — with `event_types_unknown`: the vendor was left on
     *  its default set of event types, so it may now send every one. */
    readonly left_on_default: boolean = false,
    /** D-201 Slice 10Z (10V finding 25) — with `left_on_default`: it was on
     *  that default before, and nothing was put back. */
    readonly was_on_default: boolean = false,
  ) {
    super(message);
    this.name = 'WebhookManagedRegistrationError';
  }
}

/** D-201 Slice 10Z (10V findings 8 and 9) — how long after it was sent a create
 *  may still land. A vendor carries a request out within seconds, a minute at
 *  most; an hour bounds it with room. A search of its account made after this
 *  that finds no stray settles it. */
export const WEBHOOK_UNSETTLED_CREATE_WINDOW_MS = 60 * 60 * 1000;

/** D-201 Slice 10Z — a create whose account no search could reach for this
 *  long (its connection gone or failing) is given up, and stays a stray at the
 *  vendor if it landed. D-201 Slice 10AH (10AE findings 9 and 19) — counted
 *  over the searches the sweep ran and failed (`unreachedAfter`), and so is a
 *  stray the search reached but could not remove. */
export const WEBHOOK_UNSETTLED_CREATE_GIVE_UP_MS = 7 * 24 * 60 * 60 * 1000;

/** D-201 Slice 10AH (10AE finding 9) — the most one gap between two failed
 *  searches counts toward the give-up. The sweep runs every two minutes while
 *  it can, so a longer gap is time it did not run: the server off, paused,
 *  locked or asleep. */
export const WEBHOOK_UNSETTLED_CREATE_UNREACHED_GAP_MS = 60 * 60 * 1000;

/** D-201 Slice 10AH (10AE finding 9) — how long a record's searches will have
 *  failed with one more failing at `at`: what they had, and the gap since the
 *  last, at most `WEBHOOK_UNSETTLED_CREATE_UNREACHED_GAP_MS`. The first failed
 *  search counts nothing. */
export const unreachedAfter = (
  record: Pick<WebhookUnsettledCreate, 'unreached_ms' | 'unreached_last_at'>,
  at: number,
): number => record.unreached_ms + (record.unreached_last_at === null
  ? 0
  : Math.min(Math.max(at - record.unreached_last_at, 0), WEBHOOK_UNSETTLED_CREATE_UNREACHED_GAP_MS));

/** D-201 Slice 10Z — what one sweep of the unsettled creates did. */
export interface WebhookUnsettledCreateSweep {
  /** Strays found and removed (each confirmed gone by a read). */
  readonly removed: number;
  /** Creates settled: searched for after they could have landed. */
  readonly settled: number;
  /** Creates given up: no search reached their account for a week. */
  readonly given_up: number;
  /** Creates whose account could not be searched, or a stray not removed,
   *  this time: kept for the next sweep. */
  readonly failed: number;
}

export interface WebhookManagedRegistrationService {
  reconcile(ingressId: string): Promise<WebhookIngressRecord>;
  /** D-201 Slice 10AN (the owner's call, 2026-11-20) — set a webhook whose
   *  secret Recued sets (`recuedSetsSecret`) again at its service, with the
   *  secret it holds, though it reads back as wanted: a set that replaced the
   *  secret cannot be read back. Its messages were refused for their
   *  signature. D-201 Slice 10AU (10AS finding 6) — the secret alone, through
   *  the adapter's `setSecret`: what else differs there stays, said as drifted.
   *  D-201 Slice 10AU (10AS finding 27) — null, and nothing tried, for a webhook
   *  that may not be set again as it stands under its lock (`mayBeSetAgain`):
   *  one whose secret is not Recued's, or (D-201 Slice 10AR) not taking
   *  messages or not set up there. Refused, the pass noted it as a failed try. */
  setSecretAgain(ingressId: string): Promise<WebhookIngressRecord | null>;
  cleanup(
    ingressId: string,
    intent: 'disable' | 'retire',
  ): Promise<WebhookIngressRecord>;
  rebind(ingressId: string, pairedConnectionId: string): Promise<WebhookIngressRecord>;
  /** D-201 Slice 10Z (10V findings 8 and 9; the owner's call of 2026-11-19: an
   *  edit or rebind is never refused, and a stray is removed when it lands) —
   *  search the account of each create that may still land, and remove every
   *  endpoint this ingress made there that is not the one it committed. Run
   *  one ingress at a time, under the lock its passes take. `isStopping`
   *  stops it between ingresses. */
  sweepUnsettledCreates(options?: {
    readonly isStopping?: () => boolean;
  }): Promise<WebhookUnsettledCreateSweep>;
}

export interface WebhookManagedRegistrationServiceDeps {
  store: WebhookIngressStore;
  adapters: WebhookRegistrationRuntimeRegistry;
  profilePolicies?: WebhookProfileControlPlanePolicyRegistry;
  resolveCanonicalEndpoint: (
    ingress: WebhookIngressRecord,
  ) => string | null | Promise<string | null>;
  /** D-201 Slice 10BY (10BX finding 2) — every address this server takes the
   *  webhook's messages at: its listener answers the webhook's path on every
   *  name the server serves, and moving the webhooks address keeps the old name
   *  the server's own. A stray at any of them sends here, so it is not
   *  `elsewhere`. Absent, only the address now counts. */
  ownEndpointUrls?: (ingress: WebhookIngressRecord) => readonly string[];
  /** D-201 Slice 10Z — the sweep's clock; the store's records its sends. */
  now?: () => number;
}

const sameEvents = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false;
  const sortedLeft = left.slice().sort();
  const sortedRight = right.slice().sort();
  return sortedLeft.every((entry, index) => entry === sortedRight[index]);
};

const sameRegistrationTarget = (
  left: WebhookIngressRecord['registration_target'],
  right: WebhookIngressRecord['registration_target'],
): boolean => left === null
  ? right === null
  : right !== null && left.kind === right.kind && left.key === right.key;

const registrationTargetAdmitted = (
  row: WebhookIngressRecord,
  policies: WebhookProfileControlPlanePolicyRegistry,
): boolean => {
  const resolved = policies.get(row.profile_id)
    .resolveRegistrationTarget(row.registration_target, row.registration_mode);
  return resolved.ok && sameRegistrationTarget(resolved.target, row.registration_target);
};

const matchesDesired = (
  endpoint: ManagedWebhookEndpointSnapshot,
  desired: ManagedWebhookEndpointDesired,
): boolean => endpoint.environment === desired.environment
  && endpoint.endpoint_url === desired.endpoint_url
  && endpoint.enabled
  && endpoint.correlation_valid
  && sameEvents(endpoint.event_types, desired.event_types);

const createIdempotencyKey = (
  expected: WebhookManagedRegistrationExpectation,
  desired: ManagedWebhookEndpointDesired,
): string => {
  const ingressDigest = createHash('sha256')
    .update(expected.ingress_id)
    .digest('hex')
    .slice(0, 32);
  const desiredDigest = createHash('sha256').update(JSON.stringify({
    endpoint_url: desired.endpoint_url,
    event_types: desired.event_types.slice().sort(),
    environment: desired.environment,
    registration_target: desired.registration_target,
  })).digest('hex').slice(0, 32);
  return `recued-d201-${ingressDigest}-${expected.attempt}-create-${desiredDigest}`;
};

const updateIdempotencyKey = (
  expected: WebhookManagedRegistrationExpectation,
  desired: ManagedWebhookEndpointDesired,
): string => {
  const ingressDigest = createHash('sha256')
    .update(expected.ingress_id)
    .digest('hex')
    .slice(0, 32);
  const digest = createHash('sha256').update(JSON.stringify({
    endpoint_url: desired.endpoint_url,
    event_types: desired.event_types.slice().sort(),
    environment: desired.environment,
    registration_target: desired.registration_target,
  })).digest('hex').slice(0, 32);
  return `recued-d201-${ingressDigest}-${expected.attempt}-update-${digest}`;
};

const validCanonicalEndpoint = (value: string, publicId: string): boolean => {
  if (Buffer.byteLength(value, 'utf8') > 4_096
    || value.includes('?')
    || value.includes('#')) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.username.length === 0
      && parsed.password.length === 0
      && parsed.pathname.endsWith(`/v1/webhooks/${publicId}`)
      && parsed.href === value;
  } catch {
    return false;
  }
};

const clearCredentialResult = (credentials: Readonly<Record<string, string>>): void => {
  for (const key of Object.keys(credentials)) {
    try {
      (credentials as Record<string, string>)[key] = '';
    } catch {
      // A provider may return a frozen object. The store still clears its
      // plaintext serialization; this best-effort overwrite shortens lifetime
      // for the ordinary mutable adapter result.
    }
  }
};

const adapterError = (error: WebhookRegistrationAdapterError): WebhookManagedRegistrationError => {
  switch (error.code) {
    case 'registration_input_invalid':
      return new WebhookManagedRegistrationError('invalid_state', error.message);
    case 'connection_unavailable':
    case 'connection_locked':
    case 'connection_auth_invalid':
      return new WebhookManagedRegistrationError(
        'connection_unavailable',
        error.message,
      );
    case 'environment_mismatch':
      return new WebhookManagedRegistrationError('environment_mismatch', error.message);
    case 'upstream_rejected':
    // D-201 Slice 10BG — refused before anything was sent, its own code stored.
    case 'certificate_unheld':
      return new WebhookManagedRegistrationError('upstream_rejected', error.message);
    case 'upstream_unavailable':
    case 'upstream_response_invalid':
    case 'upstream_response_too_large':
    case 'search_incomplete':
      return new WebhookManagedRegistrationError('upstream_unavailable', error.message);
    case 'event_types_unknown':
      return new WebhookManagedRegistrationError(
        'event_types_unknown',
        error.message,
        error.event_types.slice(),
        error.left_on_default,
        error.was_on_default,
      );
  }
};

/** D-201 Slice 10Z (10V findings 8 and 9) — whether a create that failed may
 *  still have made its endpoint. Only a request never sent, or one the vendor
 *  refused outright, made nothing. Anything else, a key sent or not, may land
 *  later: no response, a request still running, a server error, or an answer
 *  that could not be read. */
const createMayHaveLanded = (error: unknown): boolean =>
  !(error instanceof WebhookRegistrationAdapterError)
  || !(error.code === 'registration_input_invalid'
    || error.code === 'connection_unavailable'
    || error.code === 'connection_locked'
    || error.code === 'connection_auth_invalid'
    || (error.code === 'upstream_rejected' && !error.no_response && !error.in_progress));

const expectedMatchesRow = (
  expected: WebhookManagedRegistrationExpectation,
  row: WebhookIngressRecord,
): boolean => row.ingress_id === expected.ingress_id
  && row.public_id === expected.public_id
  && row.profile_id === expected.profile_id
  && row.environment === expected.environment
  && row.paired_connection_id === expected.paired_connection_id
  && sameRegistrationTarget(row.registration_target, expected.registration_target)
  && (row.pending_paired_connection_id ?? null)
    === expected.pending_paired_connection_id
  && row.registration_mode === 'managed_endpoint'
  && row.remote_endpoint_id === expected.remote_endpoint_id
  && row.confirmed_endpoint_url === expected.confirmed_endpoint_url
  && row.registration_state === expected.registration_state
  && row.intake_state === expected.intake_state
  && sameEvents(row.selected_event_types, expected.selected_event_types);

const sameRegistrationInputs = (
  left: WebhookIngressRecord,
  right: WebhookIngressRecord,
): boolean => left.ingress_id === right.ingress_id
  && left.public_id === right.public_id
  && left.profile_id === right.profile_id
  && left.environment === right.environment
  && left.paired_connection_id === right.paired_connection_id
  && sameRegistrationTarget(left.registration_target, right.registration_target)
  && (left.pending_paired_connection_id ?? null)
    === (right.pending_paired_connection_id ?? null)
  && left.registration_mode === right.registration_mode
  && left.remote_endpoint_id === right.remote_endpoint_id
  && left.confirmed_endpoint_url === right.confirmed_endpoint_url
  && left.registration_state === right.registration_state
  && left.intake_state === right.intake_state
  && right.intake_state !== 'retired'
  && sameEvents(left.selected_event_types, right.selected_event_types);

export const createWebhookManagedRegistrationService = (
  deps: WebhookManagedRegistrationServiceDeps,
): WebhookManagedRegistrationService => {
  const profilePolicies = deps.profilePolicies ?? BUILTIN_WEBHOOK_PROFILE_POLICIES;
  const clock = deps.now ?? (() => Date.now());
  const markDrift = (
    expected: WebhookManagedRegistrationExpectation,
    code: WebhookManagedRegistrationFailureCode,
    read?: ManagedWebhookEndpointSnapshot,
  ): void => {
    try {
      // D-201 Slice 10BY (10BX finding 1) — with what the read before it found.
      deps.store.markManagedRegistrationDrift(expected, code, read === undefined
        ? undefined
        : { read_holds_unsendable: read.holds_unsendable === true });
    } catch (error) {
      // Never let a stale external result overwrite a newer ingress edit. A
      // compare-and-set conflict is the desired outcome and the caller's
      // original, more specific failure remains authoritative.
      if (!(error instanceof WebhookIngressStoreError)
        || (error.code !== 'conflict' && error.code !== 'retired')) throw error;
    }
  };

  /** D-201 Slice 10AD (10AA finding 25) — a vendor found on its default set
   *  because an earlier pass's put-back failed was not "on its default
   *  already": Recued left it there, and it still could not be put back. The
   *  owner's retry said it had been, losing that, and the set it had. */
  const leftThereByUs = (
    ingressId: string,
    error: WebhookRegistrationAdapterError,
  ): WebhookRegistrationAdapterError => {
    if (error.code !== 'event_types_unknown' || !error.was_on_default) return error;
    let stored: string | null;
    try {
      stored = deps.store.get(ingressId)?.last_error_code ?? null;
    } catch {
      return error;
    }
    if (stored !== 'managed_registration_event_types_unrestored') return error;
    return new WebhookRegistrationAdapterError(
      'event_types_unknown',
      `The service does not know ${error.event_types.join(', ')}; an earlier change left it on its default set `
        + 'and it could not be put back to the events it had, so it may send every kind of event',
      error.event_types,
      { left_on_default: true },
    );
  };

  /** D-201 Slice 10K — a mutation the vendor refused for names it does not
   *  keep: the names are stored with their code, for Settings to say which.
   *  Any other adapter failure is `fallback`. */
  const markAdapterFailure = (
    expected: WebhookManagedRegistrationExpectation,
    error: WebhookRegistrationAdapterError,
    fallback: WebhookManagedRegistrationFailureCode,
    read?: ManagedWebhookEndpointSnapshot,
  ): void => {
    // D-201 Slice 10BG (10BF finding 13) — a certificate set at the service,
    // which a set would remove: said as that, not as a setup that may differ.
    if (error.code === 'certificate_unheld') {
      markDrift(expected, 'managed_registration_certificate_unheld');
      return;
    }
    if (error.code !== 'event_types_unknown' || error.event_types.length === 0) {
      markDrift(expected, fallback, read);
      return;
    }
    try {
      deps.store.markManagedRegistrationEventTypesUnknown(
        expected,
        error.event_types,
        // D-201 Slice 10O — and whether the vendor was left sending every one.
        // D-201 Slice 10Z (10V finding 25) — and whether it was there before.
        error.left_on_default
          ? { left_on_default: true, ...(error.was_on_default ? { was_on_default: true } : {}) }
          : undefined,
      );
    } catch (storeError) {
      if (!(storeError instanceof WebhookIngressStoreError)
        || (storeError.code !== 'conflict' && storeError.code !== 'retired')) throw storeError;
    }
  };

  /** D-201 Slice 10K — this attempt's mutation result was thrown away: its
   *  idempotency keys are never sent again, or a vendor that keeps a key's
   *  first response (for a day, for one of them) replays the endpoint or the
   *  refusal Recued discarded: an unconfirmed create removed left setup stuck
   *  on `remote_missing`. Safe for every vendor because the next pass searches
   *  before it creates. After the failure is recorded: a record made with the
   *  old attempt after this would lose its compare-and-set. */
  /** D-201 Slices 10O and 10T — the request went out and may still be carried
   *  out: no response came back, or the vendor said one under this key is
   *  still running. Its key is kept, so the vendor answers the next pass's
   *  request with that one's result, or refuses it while it runs. */
  const keepsKey = (error: WebhookRegistrationAdapterError): boolean =>
    error.no_response || error.in_progress;

  const abandonAttempt = (expected: WebhookManagedRegistrationExpectation): void => {
    try {
      deps.store.abandonManagedRegistrationAttempt(expected);
    } catch {
      // The failure being reported is the one that matters; a later pass
      // reads the attempt as it stands.
    }
  };

  const ensureCurrent = async (
    expected: WebhookManagedRegistrationExpectation,
    endpointUrl: string,
  ): Promise<void> => {
    const current = deps.store.get(expected.ingress_id);
    if (!current || !expectedMatchesRow(expected, current)) {
      throw new WebhookManagedRegistrationError(
        'state_changed',
        'webhook registration inputs changed during provider reconciliation',
      );
    }
    const currentEndpoint = await deps.resolveCanonicalEndpoint(current);
    if (currentEndpoint !== endpointUrl) {
      throw new WebhookManagedRegistrationError(
        'state_changed',
        'canonical webhook endpoint changed during provider reconciliation',
      );
    }
  };

  const validateCredentialResult = (
    ingress: WebhookIngressRecord,
    credentials: Readonly<Record<string, string>>,
  ): void => {
    const profile = webhookProfile(ingress.profile_id);
    if (!profile) {
      throw new WebhookManagedRegistrationError(
        'invalid_state',
        'webhook profile is no longer registered',
      );
    }
    const expectedFields = profile.fields
      .filter((field) => field.required)
      .map((field) => field.key)
      .sort();
    const actualFields = Object.keys(credentials).sort();
    if (JSON.stringify(expectedFields) !== JSON.stringify(actualFields)
      || actualFields.some((field) =>
        typeof credentials[field] !== 'string' || credentials[field]!.length === 0)) {
      throw new WebhookManagedRegistrationError(
        'upstream_unavailable',
        'managed registration returned an incomplete credential result',
      );
    }
  };

  const reconcileUnlocked = async (
    ingressId: string,
    options: { readonly setSecretAgain?: true } = {},
  ): Promise<WebhookIngressRecord> => {
      const preview = deps.store.get(ingressId);
      if (!preview) {
        throw new WebhookIngressStoreError(
          'not_found',
          `webhook ingress '${ingressId}' not found`,
        );
      }
      const previewProfile = webhookProfile(preview.profile_id);
      if (preview.registration_mode !== 'managed_endpoint'
        || preview.paired_connection_id === null
        || preview.intake_state === 'retired'
        || !previewProfile
        || !previewProfile.supported_environments.includes(preview.environment)
        || !registrationTargetAdmitted(preview, profilePolicies)) {
        throw new WebhookManagedRegistrationError(
          'invalid_state',
          'webhook ingress is not eligible for managed registration',
        );
      }
      const adapter = deps.adapters.get(preview.profile_id);
      if (!adapter) {
        throw new WebhookManagedRegistrationError(
          'unsupported',
          `profile '${preview.profile_id}' has no managed registration adapter`,
        );
      }
      // D-201 Slice 10AU (10AS finding 6) — a set again sends the secret alone,
      // which an adapter without `setSecret` cannot.
      const setSecret = adapter.setSecret;
      if (options.setSecretAgain === true && setSecret === undefined) {
        throw new WebhookManagedRegistrationError(
          'unsupported',
          `profile '${preview.profile_id}' cannot set its secret alone at its service`,
        );
      }
      const previewEndpoint = await deps.resolveCanonicalEndpoint(preview);
      if (previewEndpoint === null
        || !validCanonicalEndpoint(previewEndpoint, preview.public_id)) {
        throw new WebhookManagedRegistrationError(
          'endpoint_unavailable',
          'configure a canonical public HTTPS endpoint before registration',
        );
      }
      if (preview.selected_event_types.length === 0
        || preview.selected_event_types.length > MAX_WEBHOOK_EVENT_TYPES_PER_REQUIREMENT
        || new Set(preview.selected_event_types).size !== preview.selected_event_types.length
        || preview.selected_event_types.some((eventType) =>
          !webhookProfileAcceptsEventType(previewProfile, eventType))) {
        throw new WebhookManagedRegistrationError(
          'invalid_state',
          'webhook registration event selection is invalid for the profile',
        );
      }
      if (preview.remote_endpoint_id === null
        && deps.store.listCredentialVersions(preview.ingress_id)
          .some((version) => version.active)) {
        throw new WebhookManagedRegistrationError(
          'invalid_state',
          'managed registration cannot replace a pre-existing active credential',
        );
      }

      const desired: ManagedWebhookEndpointDesired = Object.freeze({
        ingress_id: preview.ingress_id,
        environment: preview.environment,
        registration_target: preview.registration_target === null
          ? null
          : Object.freeze({ ...preview.registration_target }),
        endpoint_url: previewEndpoint,
        event_types: Object.freeze(preview.selected_event_types.slice()),
      });
      const context: ManagedWebhookRegistrationContext = Object.freeze({
        paired_connection_id: preview.paired_connection_id,
        desired,
      });

      // The exhaustive provider read also validates and pins the paired
      // connection. Do it before allocating the first mutation attempt so a
      // missing, locked, malformed, or wrong-mode connection does not freeze an
      // otherwise editable draft even though no provider mutation was issued.
      let discoveredMatches: readonly ManagedWebhookEndpointMatch[] | null = null;
      if (preview.remote_endpoint_id === null) {
        try {
          discoveredMatches = await adapter.find(context);
        } catch (error) {
          if (error instanceof WebhookRegistrationAdapterError) {
            throw adapterError(error);
          }
          throw error;
        }
        const afterSearch = deps.store.get(preview.ingress_id);
        if (!afterSearch || !sameRegistrationInputs(preview, afterSearch)) {
          throw new WebhookManagedRegistrationError(
            'state_changed',
            'webhook registration inputs changed during provider search',
          );
        }
        const afterSearchEndpoint = await deps.resolveCanonicalEndpoint(afterSearch);
        const beforePrepare = deps.store.get(preview.ingress_id);
        if (afterSearchEndpoint !== previewEndpoint
          || !beforePrepare
          || !sameRegistrationInputs(preview, beforePrepare)) {
          throw new WebhookManagedRegistrationError(
            'state_changed',
            'webhook registration inputs changed during provider search',
          );
        }
      }

      let prepared;
      try {
        prepared = deps.store.prepareManagedRegistration(ingressId);
      } catch (error) {
        if (error instanceof WebhookIngressStoreError
          && (error.code === 'invalid_state'
            || error.code === 'retired'
            || error.code === 'immutable')) {
          throw new WebhookManagedRegistrationError('invalid_state', error.message);
        }
        throw error;
      }
      let { ingress, expected } = prepared;
      if (!sameRegistrationInputs(preview, ingress)) {
        throw new WebhookManagedRegistrationError(
          'state_changed',
          'webhook registration inputs changed before reconciliation started',
        );
      }
      if (ingress.remote_endpoint_id === null
        && deps.store.listCredentialVersions(ingress.ingress_id)
          .some((version) => version.active)) {
        throw new WebhookManagedRegistrationError(
          'invalid_state',
          'managed registration cannot replace a pre-existing active credential',
        );
      }
      const endpointUrl = await deps.resolveCanonicalEndpoint(ingress);
      if (endpointUrl === null
        || !validCanonicalEndpoint(endpointUrl, ingress.public_id)) {
        throw new WebhookManagedRegistrationError(
          'endpoint_unavailable',
          'configure a canonical public HTTPS endpoint before registration',
        );
      }
      if (endpointUrl !== previewEndpoint) {
        throw new WebhookManagedRegistrationError(
          'state_changed',
          'canonical webhook endpoint changed before reconciliation started',
        );
      }

      if (ingress.remote_endpoint_id !== null) {
        let remote: ManagedWebhookEndpointSnapshot | null;
        // D-201 Slice 10BY (10BX finding 1) — this webhook's setup as this pass
        // last read it: a drift after a read that found no certificate ends the
        // certificate's word. A bot pointed elsewhere without one was refused as
        // not this webhook's, on the owner's "Line the address up again" and on
        // the set again alike, and the card went on speaking of the certificate.
        let seen: ManagedWebhookEndpointSnapshot | undefined;
        let updateSent = false;
        // D-201 Slice 10O — the update went out and nothing came back: the
        // vendor may still carry it out, so its key is kept for the next pass.
        let updateUnanswered = false;
        try {
          remote = await adapter.read(context, ingress.remote_endpoint_id);
          if (remote === null) {
            markDrift(expected, 'managed_remote_missing');
            throw new WebhookManagedRegistrationError(
              'remote_missing',
              'the committed provider webhook endpoint no longer exists',
            );
          }
          if (remote.remote_endpoint_id !== ingress.remote_endpoint_id) {
            markDrift(expected, 'managed_registration_drift');
            throw new WebhookManagedRegistrationError(
              'upstream_unavailable',
              'provider read-back returned a different webhook endpoint id',
            );
          }
          seen = remote;
          // D-201 Slice 10AN — set again with the secret it holds, though it
          // reads back as wanted: a secret never reads back. D-201 Slice 10AU
          // (10AS finding 6) — the secret alone. Through the full update, the
          // hourly set again an outsider's refused requests can start sent a
          // whole endpoint, switched on and with Recued's events, so one
          // switched off at its service, or given other events there, was
          // changed back. What else differs there stays as it is, and is said:
          // drifted, for the owner's own reconcile to set back, or not.
          if (options.setSecretAgain === true && setSecret !== undefined) {
            await ensureCurrent(expected, endpointUrl);
            updateSent = true;
            remote = await setSecret(context, ingress.remote_endpoint_id);
            if (remote === null || remote.remote_endpoint_id !== ingress.remote_endpoint_id) {
              markDrift(expected, remote === null
                ? 'managed_remote_missing'
                : 'managed_registration_drift');
              abandonAttempt(expected);
              throw new WebhookManagedRegistrationError(
                remote === null ? 'remote_missing' : 'upstream_unavailable',
                'provider webhook endpoint read-back after its secret was set again did not match',
              );
            }
            if (!matchesDesired(remote, desired)) {
              // Drifted already, its code says more (names a vendor left on its
              // default set, say), and stays: only a match clears it. D-201
              // Slice 10BY (10BX finding 1) — but not the certificate's, once
              // the read-back finds none: set again, it holds none.
              if (ingress.registration_state !== 'drifted'
                || (ingress.last_error_code === 'managed_registration_certificate_unheld'
                  && remote.holds_unsendable !== true)) {
                markDrift(expected, 'managed_registration_drift', remote);
              }
              abandonAttempt(expected);
              const drifted = deps.store.get(ingressId);
              if (drifted === null) {
                throw new WebhookIngressStoreError('not_found', `webhook ingress '${ingressId}' not found`);
              }
              return drifted;
            }
          } else if (!matchesDesired(remote, desired)) {
            await ensureCurrent(expected, endpointUrl);
            updateSent = true;
            try {
              await adapter.update(
                context,
                ingress.remote_endpoint_id,
                updateIdempotencyKey(expected, desired),
              );
            } catch (error) {
              updateUnanswered = error instanceof WebhookRegistrationAdapterError
                && keepsKey(error);
              throw error;
            }
            remote = await adapter.read(context, ingress.remote_endpoint_id);
            if (remote === null
              || remote.remote_endpoint_id !== ingress.remote_endpoint_id
              || !matchesDesired(remote, desired)) {
              markDrift(expected, remote === null
                ? 'managed_remote_missing'
                : 'managed_registration_drift', remote !== null
                && remote.remote_endpoint_id === ingress.remote_endpoint_id ? remote : undefined);
              abandonAttempt(expected);
              throw new WebhookManagedRegistrationError(
                remote === null ? 'remote_missing' : 'upstream_unavailable',
                'provider webhook endpoint read-back did not match the requested configuration',
              );
            }
          }
        } catch (caught) {
          if (caught instanceof WebhookManagedRegistrationError) throw caught;
          const error = caught instanceof WebhookRegistrationAdapterError
            ? leftThereByUs(expected.ingress_id, caught)
            : caught;
          if (error instanceof WebhookRegistrationAdapterError) {
            markAdapterFailure(expected, error, 'managed_registration_drift', seen);
            // D-201 Slice 10K — a repair update that did not hold is never
            // replayed under its key. D-201 Slice 10O (10L finding 11) — unless
            // nothing came back from it: then the key stays, so the update
            // still being carried out answers the next pass's instead of a
            // second change landing beside it.
            if (updateSent && !updateUnanswered) abandonAttempt(expected);
            throw adapterError(error);
          }
          throw error;
        }
        await ensureCurrent(expected, endpointUrl);
        const confirmed = deps.store.confirmManagedRegistrationReadBack({
          expected,
          remote_endpoint_id: ingress.remote_endpoint_id,
          endpoint_url: endpointUrl,
          requires_handshake: false,
          // D-201 Slice 10BQ (10BM finding 15) — a read-back that set nothing,
          // still beside a setting a set would drop: a set again's refusal over
          // it stands.
          keep_certificate_unheld: remote?.holds_unsendable === true,
        });
        // D-201 Slice 10O (10L finding 12) — a repair that held moves the
        // attempt on too: a later repair back to the same set would send the
        // same key, and a vendor that keeps a key's first response would answer
        // it with this success without making the change.
        // D-201 Slice 10T (10Q finding 18) — and so does every confirmation:
        // a repair that got no response but landed is confirmed by a later
        // pass's read, which sends nothing, and its key stayed, so a drift
        // back within the vendor's replay window got the old success again.
        // A confirmed setup needs no earlier request answered again: the next
        // change goes out under a new key.
        abandonAttempt(expected);
        return confirmed;
      }

      if (discoveredMatches === null) {
        throw new WebhookManagedRegistrationError(
          'state_changed',
          'managed registration search result was not retained',
        );
      }
      const matches = discoveredMatches;
      const endpointIds = new Set(matches.map((match) =>
        match.endpoint.remote_endpoint_id));
      if (matches.some((match) => match.correlation !== 'owned')
        || endpointIds.size > 1) {
        markDrift(expected, 'managed_registration_ambiguous');
        throw new WebhookManagedRegistrationError(
          'ambiguous',
          'provider webhook endpoint correlation is ambiguous; no remote endpoint was changed',
        );
      }

      const orphan = matches.find((match) => match.correlation === 'owned');
      if (orphan) {
        // Rotate first. If delete times out, the next pass must search again and
        // must not reuse the idempotency key whose create response/secret was
        // previously lost. No create occurs until deletion is confirmed.
        const rotated = deps.store.rotateManagedRegistrationAttempt(expected);
        ingress = rotated.ingress;
        expected = rotated.expected;
        try {
          await adapter.delete(context, orphan.endpoint.remote_endpoint_id);
        } catch (error) {
          if (error instanceof WebhookRegistrationAdapterError) {
            markDrift(expected, 'managed_registration_unconfirmed');
            throw adapterError(error);
          }
          throw error;
        }
        // D-201 Slice 10AQ (10AM finding 21) — a stray recorded for it leaves
        // the count now: it stayed counted until the next sweep, and one given
        // up kept its notice three sweeps later.
        try {
          deps.store.settleStrayEndpoint(ingress.ingress_id, orphan.endpoint.remote_endpoint_id);
        } catch {
          // Settled by the next sweep that finds it gone.
        }
      }

      await ensureCurrent(expected, endpointUrl);
      // D-201 Slice 10Z (10V findings 8 and 9) — written before it is sent. A
      // create whose outcome is not known may land after the owner edited the
      // events, rebound, switched off or retired, when no pass searches for it
      // again: kept until the sweep has searched its account after it could
      // have landed, so a stray it leaves is removed when it lands.
      const unsettled = deps.store.recordUnsettledCreate({
        ingress_id: ingress.ingress_id,
        connection_id: context.paired_connection_id,
        endpoint_url: desired.endpoint_url,
      });
      const settleCreate = (): void => {
        try {
          deps.store.settleUnsettledCreate(unsettled.create_id);
        } catch {
          // The sweep settles it: it finds this pass's endpoint committed, or
          // removes it.
        }
      };
      let created;
      try {
        created = await adapter.create(
          context,
          createIdempotencyKey(expected, desired),
        );
      } catch (error) {
        if (!createMayHaveLanded(error)) settleCreate();
        if (error instanceof WebhookRegistrationAdapterError) {
          markAdapterFailure(expected, error, 'managed_registration_unconfirmed');
          // D-201 Slice 10K — a create that failed is never replayed under its
          // key: the next pass searches first, so one that did land is found.
          // D-201 Slice 10O (10L finding 11) — but one that got no response is
          // kept: it may still be carried out after the next pass's search, and
          // under a new key the next create would land beside it, holding a
          // secret Recued never stored. Under the same key the vendor gives the
          // next create this one's result, or refuses it while it runs.
          if (!keepsKey(error)) abandonAttempt(expected);
          throw adapterError(error);
        }
        throw error;
      }
      try {
        validateCredentialResult(ingress, created.credential_result);
        if (!matchesDesired(created.endpoint, desired)) {
          markDrift(expected, 'managed_registration_drift');
          throw new WebhookManagedRegistrationError(
            'upstream_unavailable',
            'provider create result did not match the requested webhook configuration',
          );
        }
        let readBack: ManagedWebhookEndpointSnapshot | null;
        try {
          readBack = await adapter.read(
            context,
            created.endpoint.remote_endpoint_id,
          );
        } catch (error) {
          if (error instanceof WebhookRegistrationAdapterError) {
            markDrift(expected, 'managed_registration_unconfirmed');
            throw adapterError(error);
          }
          throw error;
        }
        if (readBack === null || !matchesDesired(readBack, desired)) {
          markDrift(expected, readBack === null
            ? 'managed_remote_missing'
            : 'managed_registration_drift');
          throw new WebhookManagedRegistrationError(
            readBack === null ? 'remote_missing' : 'upstream_unavailable',
            'provider webhook endpoint read-back did not confirm creation',
          );
        }
        if (readBack.remote_endpoint_id !== created.endpoint.remote_endpoint_id) {
          markDrift(expected, 'managed_registration_drift');
          throw new WebhookManagedRegistrationError(
            'upstream_unavailable',
            'provider creation read-back returned a different endpoint id',
          );
        }
        await ensureCurrent(expected, endpointUrl);
        const committed = await deps.store.commitManagedRegistrationCreate({
          expected,
          remote_endpoint_id: readBack.remote_endpoint_id,
          endpoint_url: endpointUrl,
          credentials: created.credential_result,
          requires_handshake: false,
        });
        settleCreate();
        return committed;
      } catch (error) {
        // D-201 Slice 10G — nothing stored the credential this create returned,
        // so the vendor must not keep the endpoint that holds it: deliveries
        // would come signed with a secret Recued discarded. Remove it now. If
        // that fails too, nothing more is needed here: with no committed
        // endpoint, the next pass searches first, finds it by its URL and
        // removes it before it creates one again.
        // D-201 Slice 10K (10H finding 7) — and first move the attempt on, as
        // the orphan path does: a vendor that keeps a key's first response
        // would answer the next pass's create under this key with the endpoint
        // removed here, and setup would stop on `remote_missing`.
        abandonAttempt(expected);
        try {
          await adapter.delete(context, created.endpoint.remote_endpoint_id);
          // D-201 Slice 10Z — removed, so it stands nowhere.
          settleCreate();
        } catch {
          // The create's own failure is the one to report. D-201 Slice 10Z —
          // kept unsettled, so the sweep removes it when it can.
        }
        throw error;
      } finally {
        clearCredentialResult(created.credential_result);
      }
  };

  const markCleanupPending = (
    expected: WebhookManagedRegistrationExpectation,
    code: 'managed_cleanup_ambiguous' | 'managed_cleanup_unconfirmed',
  ): void => {
    try {
      deps.store.markManagedRegistrationCleanupPending(expected, code);
    } catch (error) {
      if (!(error instanceof WebhookIngressStoreError)
        || (error.code !== 'conflict' && error.code !== 'retired')) throw error;
    }
  };

  const completedCleanup = (
    ingressId: string,
    intent: WebhookManagedRegistrationCleanupIntent,
  ): WebhookIngressRecord | null => {
    const current = deps.store.get(ingressId);
    if (!current
      || current.registration_mode !== 'managed_endpoint'
      || current.remote_endpoint_id !== null
      || current.confirmed_endpoint_url !== null) return null;
    if ((intent === 'disable' || intent === 'rebind')
      && current.intake_state === 'disabled'
      && current.registration_state === 'managed_pending') return current;
    if (intent === 'retire'
      && current.intake_state === 'retired'
      && current.registration_state === 'retired') return current;
    return null;
  };

  const cleanupUnlocked = async (
    ingressId: string,
    intent: WebhookManagedRegistrationCleanupIntent,
  ): Promise<WebhookIngressRecord> => {
    // A same-intent request may have closed locally and queued while an earlier
    // cleanup held the ingress lock. If that earlier request completed, the
    // queued request is an idempotent replay rather than an invalid transition.
    const completed = completedCleanup(ingressId, intent);
    if (completed) return completed;
    const prepared = deps.store.prepareManagedRegistrationCleanup(ingressId, intent);
    const { ingress, expected } = prepared;
    const profile = webhookProfile(ingress.profile_id);
    const adapter = deps.adapters.get(ingress.profile_id);
    if (!profile || !adapter || ingress.paired_connection_id === null) {
      markCleanupPending(expected, 'managed_cleanup_unconfirmed');
      throw new WebhookManagedRegistrationError(
        'unsupported',
        `profile '${ingress.profile_id}' has no managed cleanup adapter`,
      );
    }
    if (!registrationTargetAdmitted(ingress, profilePolicies)) {
      markCleanupPending(expected, 'managed_cleanup_unconfirmed');
      throw new WebhookManagedRegistrationError(
        'invalid_state',
        'webhook registration target is invalid for managed cleanup',
      );
    }
    const endpointUrl = ingress.confirmed_endpoint_url
      ?? await deps.resolveCanonicalEndpoint(ingress);
    if (endpointUrl === null || !validCanonicalEndpoint(endpointUrl, ingress.public_id)) {
      markCleanupPending(expected, 'managed_cleanup_unconfirmed');
      throw new WebhookManagedRegistrationError(
        'endpoint_unavailable',
        'restore the canonical public HTTPS endpoint before orphan cleanup',
      );
    }
    const desired: ManagedWebhookEndpointDesired = Object.freeze({
      ingress_id: ingress.ingress_id,
      environment: ingress.environment,
      registration_target: ingress.registration_target === null
        ? null
        : Object.freeze({ ...ingress.registration_target }),
      endpoint_url: endpointUrl,
      event_types: Object.freeze(ingress.selected_event_types.slice()),
    });
    const context: ManagedWebhookRegistrationContext = Object.freeze({
      paired_connection_id: ingress.paired_connection_id,
      desired,
    });

    let remoteEndpointId = ingress.remote_endpoint_id;
    try {
      if (remoteEndpointId === null) {
        const matches = await adapter.find(context);
        const endpointIds = new Set(matches.map((match) =>
          match.endpoint.remote_endpoint_id));
        if (matches.some((match) => match.correlation !== 'owned')
          || matches.length > 1
          || endpointIds.size > 1) {
          markCleanupPending(expected, 'managed_cleanup_ambiguous');
          throw new WebhookManagedRegistrationError(
            'ambiguous',
            'provider webhook cleanup correlation is ambiguous; no remote endpoint was changed',
          );
        }
        remoteEndpointId = matches[0]?.endpoint.remote_endpoint_id ?? null;
      }
      if (remoteEndpointId !== null) {
        await adapter.delete(context, remoteEndpointId);
        const readBack = await adapter.read(context, remoteEndpointId);
        if (readBack !== null) {
          markCleanupPending(expected, 'managed_cleanup_unconfirmed');
          throw new WebhookManagedRegistrationError(
            'upstream_unavailable',
            'provider webhook endpoint still exists after cleanup',
          );
        }
        // D-201 Slice 10AT (10AS finding 3) — a stray recorded for what the
        // clean-up removed leaves the card now, given up or not: only the
        // reconcile's removal settled it, and a given-up record is never
        // searched again, so a retire's or a rebind's stayed on the card.
        try {
          deps.store.settleStrayEndpoint(ingress.ingress_id, remoteEndpointId);
        } catch {
          // Settled by the next search that finds it gone.
        }
      }
    } catch (error) {
      if (error instanceof WebhookManagedRegistrationError) throw error;
      if (error instanceof WebhookRegistrationAdapterError) {
        markCleanupPending(expected, error.code === 'search_incomplete'
          ? 'managed_cleanup_ambiguous'
          : 'managed_cleanup_unconfirmed');
        throw adapterError(error);
      }
      throw error;
    }
    return deps.store.completeManagedRegistrationCleanup({ expected, intent });
  };

  const rebindUnlocked = async (
    ingressId: string,
    pairedConnectionId: string,
  ): Promise<WebhookIngressRecord> => {
    if (pairedConnectionId.trim().length === 0 || pairedConnectionId.length > 256) {
      throw new WebhookManagedRegistrationError(
        'invalid_state',
        'replacement paired connection id is invalid',
      );
    }
    const current = deps.store.get(ingressId);
    if (!current) {
      throw new WebhookIngressStoreError(
        'not_found',
        `webhook ingress '${ingressId}' not found`,
      );
    }
    const pendingConnectionId = current.pending_paired_connection_id ?? null;
    if (pendingConnectionId !== null) {
      if (pendingConnectionId !== pairedConnectionId
        || current.registration_state !== 'cleanup_pending'
        || current.intake_state !== 'disabled') {
        throw new WebhookManagedRegistrationError(
          'state_changed',
          'a different managed connection cutover is already pending',
        );
      }
      return cleanupUnlocked(ingressId, 'rebind');
    }
    if (current.paired_connection_id === pairedConnectionId) return current;

    const { ingress, expected } = deps.store.snapshotManagedRegistration(ingressId);
    const profile = webhookProfile(ingress.profile_id);
    const adapter = deps.adapters.get(ingress.profile_id);
    if (!profile
      || !adapter
      || ingress.paired_connection_id === null
      || ingress.intake_state === 'retired'
      || !profile.supported_environments.includes(ingress.environment)
      || !registrationTargetAdmitted(ingress, profilePolicies)) {
      throw new WebhookManagedRegistrationError(
        'invalid_state',
        'webhook ingress is not eligible for managed connection replacement',
      );
    }
    if (ingress.selected_event_types.length === 0
      || ingress.selected_event_types.length > MAX_WEBHOOK_EVENT_TYPES_PER_REQUIREMENT
      || new Set(ingress.selected_event_types).size !== ingress.selected_event_types.length
      || ingress.selected_event_types.some((eventType) =>
        !webhookProfileAcceptsEventType(profile, eventType))) {
      throw new WebhookManagedRegistrationError(
        'invalid_state',
        'webhook registration event selection is invalid for the profile',
      );
    }
    const endpointUrl = await deps.resolveCanonicalEndpoint(ingress);
    if (endpointUrl === null || !validCanonicalEndpoint(endpointUrl, ingress.public_id)) {
      throw new WebhookManagedRegistrationError(
        'endpoint_unavailable',
        'configure a canonical public HTTPS endpoint before changing connections',
      );
    }
    const desired: ManagedWebhookEndpointDesired = Object.freeze({
      ingress_id: ingress.ingress_id,
      environment: ingress.environment,
      registration_target: ingress.registration_target === null
        ? null
        : Object.freeze({ ...ingress.registration_target }),
      endpoint_url: endpointUrl,
      event_types: Object.freeze(ingress.selected_event_types.slice()),
    });
    const targetContext: ManagedWebhookRegistrationContext = Object.freeze({
      paired_connection_id: pairedConnectionId,
      desired,
    });

    try {
      if (ingress.remote_endpoint_id !== null) {
        const targetRemote = await adapter.read(
          targetContext,
          ingress.remote_endpoint_id,
        );
        await ensureCurrent(expected, endpointUrl);
        if (targetRemote !== null) {
          if (targetRemote.remote_endpoint_id !== ingress.remote_endpoint_id
            || !matchesDesired(targetRemote, desired)) {
            throw new WebhookManagedRegistrationError(
              'ambiguous',
              'replacement connection reached a conflicting provider endpoint; no connection changed',
            );
          }
          return deps.store.commitManagedConnectionAliasRebind({
            expected,
            paired_connection_id: pairedConnectionId,
            // D-201 Slice 10BT (10BS finding 11) — a confirmation by read: the
            // certificate's word kept while the read-back still holds it.
            keep_certificate_unheld: targetRemote.holds_unsendable === true,
          });
        }
      }

      const targetMatches = await adapter.find(targetContext);
      await ensureCurrent(expected, endpointUrl);
      // D-201 Slice 10AD (10AA finding 27) — strays of this webhook's own
      // lost creates there are removed, and the rebind goes on: the owner's
      // call, a rebind is never refused for one (it was, until the sweep
      // cleared it). Anything there not provably this webhook's stray stays
      // a refusal, and so does the endpoint it committed.
      if (targetMatches.some((match) => match.correlation !== 'owned'
        || match.endpoint.remote_endpoint_id === ingress.remote_endpoint_id)) {
        throw new WebhookManagedRegistrationError(
          'ambiguous',
          'replacement connection already contains correlated webhook endpoints; no connection changed',
        );
      }
      // The rebind below moves the attempt on itself (its cleanup), so a
      // removed stray is never answered back to the next create.
      // D-201 Slice 10AH (10AE finding 8) — each is recorded for the sweep
      // before its removal, and settled once a read finds it gone. One the
      // rebind could not remove stays recorded: the sweep removes it, and the
      // webhook's view counts it for the owner. It stood unrecorded: the sweep
      // never searched for it, and the owner was told nothing.
      for (const match of targetMatches) {
        let kept: WebhookUnsettledCreate | null = null;
        try {
          // D-201 Slice 10AL (10AI finding 20) — named by its endpoint, so a
          // rebind tried again takes up the record it kept, and the card
          // counts the stray once. It counted it again on every try.
          kept = deps.store.recordUnsettledCreate({
            ingress_id: ingress.ingress_id,
            connection_id: pairedConnectionId,
            endpoint_url: endpointUrl,
            kind: 'stray',
            remote_endpoint_id: match.endpoint.remote_endpoint_id,
          });
        } catch {
          // Unrecorded, as before 10AH: the next create's search meets it.
        }
        try {
          await adapter.delete(targetContext, match.endpoint.remote_endpoint_id);
          if (kept !== null
            && await adapter.read(targetContext, match.endpoint.remote_endpoint_id) === null) {
            deps.store.settleUnsettledCreate(kept.create_id);
          }
        } catch {
          // Not a refusal (the owner's call): kept for the sweep.
        }
      }
    } catch (error) {
      if (error instanceof WebhookManagedRegistrationError) throw error;
      if (error instanceof WebhookRegistrationAdapterError) throw adapterError(error);
      throw error;
    }

    const prepared = deps.store.prepareManagedConnectionRebind({
      expected,
      paired_connection_id: pairedConnectionId,
    });
    if (!prepared.cleanup_required) return prepared.ingress;
    return cleanupUnlocked(ingressId, 'rebind');
  };

  const tails = new Map<string, Promise<void>>();
  const withIngressLock = async <T>(
    ingressId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const prior = tails.get(ingressId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.catch(() => undefined).then(() => gate);
    tails.set(ingressId, tail);
    await prior.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (tails.get(ingressId) === tail) tails.delete(ingressId);
    }
  };

  /** D-201 Slice 10Z — after a stray is removed from an ingress with nothing
   *  committed, its next create goes out under a new key: the stray may be this
   *  attempt's own create, and a vendor that keeps a key's first response would
   *  answer the next one with the endpoint just removed (as the orphan path
   *  moves it on before its delete). */
  const moveAttemptOnAfterStray = (ingressId: string): void => {
    try {
      const { expected } = deps.store.snapshotManagedRegistration(ingressId);
      if (expected.remote_endpoint_id === null) deps.store.abandonManagedRegistrationAttempt(expected);
    } catch {
      // Retired, or not managed now: no create follows to replay it.
    }
  };

  /** D-201 Slice 10AQ (10AM findings 8 and 26) — the strays of an ingress
   *  recorded at one account and address that a search of it no longer finds:
   *  gone, so settled, given up or not. A fault leaves them for the next sweep.
   *  D-201 Slice 10AT (10AS finding 4) — `found` is every endpoint the search
   *  found, whether or not it could prove one is this webhook's: one whose
   *  metadata was edited at the service still stands, and was settled as gone.
   *  The records it settled, for the sweep to count (10AS finding 23). */
  const settleStraysGone = (
    ingressId: string,
    connectionId: string,
    endpointUrl: string,
    found: ReadonlySet<string>,
  ): Set<string> => {
    const settledIds = new Set<string>();
    let strays: ReturnType<typeof deps.store.listStrayEndpoints>;
    try {
      strays = deps.store.listStrayEndpoints(ingressId);
    } catch {
      return settledIds;
    }
    for (const stray of strays) {
      if (stray.remote_endpoint_id === null || stray.connection_id !== connectionId
        || stray.endpoint_url !== endpointUrl || found.has(stray.remote_endpoint_id)) continue;
      try {
        deps.store.settleStrayEndpoint(ingressId, stray.remote_endpoint_id);
        settledIds.add(stray.create_id);
      } catch {
        // Settled by the next search that finds it gone.
      }
    }
    return settledIds;
  };

  /** D-201 Slice 10Z — one account the unsettled creates of one ingress were
   *  sent to, at one address: searched once, under that ingress's lock, so no
   *  pass of it runs meanwhile and the endpoint it committed cannot change. */
  const sweepAccount = async (
    records: readonly WebhookUnsettledCreate[],
    at: number,
  ): Promise<WebhookUnsettledCreateSweep> => {
    const first = records[0]!;
    let removed = 0;
    let settled = 0;
    let givenUp = 0;
    let failed = 0;
    /** D-201 Slice 10AH (10AE finding 20) — a write that fails leaves the
     *  record as it was, for the next sweep: thrown, it ended the whole sweep,
     *  and the other accounts' strays stayed for that round. */
    const settle = (record: WebhookUnsettledCreate): boolean => {
      try {
        deps.store.settleUnsettledCreate(record.create_id);
        return true;
      } catch {
        return false;
      }
    };
    /** No search reached the account this time, or a stray it reached could
     *  not be removed: kept, unless its searches have now failed for a week.
     *  D-201 Slice 10AD (10AA finding 24) — never a week since its send.
     *  D-201 Slice 10AH (10AE finding 9) — nor a week since its first failed
     *  search: only time between failed searches counts, a gap at most an hour,
     *  so a week the sweep did not run is no longer a week of failures. */
    /** D-201 Slice 10AL (10AI finding 21) — a stray given up is kept, no
     *  longer swept, so its card says Recued stopped: its record went, and the
     *  row with it, which read as resolved while the stray stood. */
    const giveUp = (record: WebhookUnsettledCreate): boolean => {
      if (record.kind !== 'stray') return settle(record);
      try {
        deps.store.giveUpStrayEndpoint(record.create_id, at);
        return true;
      } catch {
        return false;
      }
    };
    // D-201 Slice 10AQ (10AM findings 8 and 26) — only the records a search
    // left open: a stray it found gone or removed is settled, and counted
    // nowhere as failed. Every record of the account went here, one removed
    // stray counted as failed beside the one that was not.
    const unreached = (open: readonly WebhookUnsettledCreate[] = records): void => {
      for (const record of open) {
        const unreachedMs = unreachedAfter(record, at);
        if (unreachedMs >= WEBHOOK_UNSETTLED_CREATE_GIVE_UP_MS) {
          if (giveUp(record)) givenUp += 1;
          else failed += 1;
        } else {
          try {
            deps.store.noteUnsettledCreateUnreached(record.create_id, at, unreachedMs);
          } catch {
            // Its next failed search counts from the last one noted.
          }
          failed += 1;
        }
      }
    };
    const ingress = deps.store.get(first.ingress_id);
    const adapter = ingress === null ? null : deps.adapters.get(ingress.profile_id);
    if (ingress === null || adapter === null) {
      unreached();
      return { removed, settled, given_up: givenUp, failed };
    }
    const context: ManagedWebhookRegistrationContext = Object.freeze({
      paired_connection_id: first.connection_id,
      desired: Object.freeze({
        ingress_id: ingress.ingress_id,
        environment: ingress.environment,
        registration_target: ingress.registration_target === null
          ? null
          : Object.freeze({ ...ingress.registration_target }),
        endpoint_url: first.endpoint_url,
        event_types: Object.freeze(ingress.selected_event_types.slice()),
      }),
    });
    // The endpoint this ingress committed, through whichever connection: one
    // reached by an alias of this account is the same endpoint, and stays.
    const committed = ingress.remote_endpoint_id;
    // D-201 Slice 10AL (10AI finding 20) — what the search found standing, so
    // a stray it could not remove is recorded for the owner, and one it
    // removed is settled at once, given up or not.
    const standing: string[] = [];
    // D-201 Slice 10AT (10AS finding 4) — every endpoint the search found, ours
    // provably or not: a stray among them still stands.
    // D-201 Slice 10BA (10AY finding 1) — only what could be a stray of this
    // webhook: at its address, and not the endpoint it committed. Where a
    // service keeps one endpoint per account under one id, a stray, the
    // committed endpoint and whatever the account points at share that id:
    // found as the committed one, or at another service's address, the stray
    // read as standing, was never settled, and a week on the card asked the
    // owner to remove the webhook's own endpoint, or another service's.
    // D-201 Slice 10BK (10BF finding 12) — only there. A service that gives
    // each endpoint an id of its own finds it at whatever address it now
    // holds: under 10BA's rule, a stray whose address was edited at the
    // service was settled as gone while it stood, or recorded again at every
    // sweep and never given up. 10BA said nothing changed for such a service.
    const perAccount = adapter.one_endpoint_per_account === true;
    const found = new Set<string>();
    // D-201 Slice 10BA (10AY finding 4) — of those, the ones the search could
    // not prove are this webhook's: never removed here.
    const unproven = new Set<string>();
    // D-201 Slice 10BQ (10BM finding 13) — and of those, the ones found sending
    // to another address than this webhook's: changed at the service. Their
    // card said they send to this webhook's address.
    const elsewhere = new Set<string>();
    // D-201 Slice 10AT (10AS finding 23) — the records settled as gone, counted
    // once, also when the account's sweep fails after.
    let settledGone = new Set<string>();
    // What this sweep removed: a stray the search found and did not remove still
    // stands, and is never settled below.
    const removedIds = new Set<string>();
    const stillStands = (record: WebhookUnsettledCreate): boolean => record.kind === 'stray'
      && record.remote_endpoint_id !== null
      && found.has(record.remote_endpoint_id)
      && !removedIds.has(record.remote_endpoint_id);
    /** D-201 Slice 10BA (10AY finding 4) — a stray that still stands, noted as
     *  the search left it: unproven, so its card says Recued does not remove
     *  it; or proven since. Best effort: noted again by the next sweep. */
    const noteProof = (record: WebhookUnsettledCreate): void => {
      if (record.remote_endpoint_id === null) return;
      try {
        deps.store.noteStrayUnproven(record.create_id, unproven.has(record.remote_endpoint_id) ? at : null,
          elsewhere.has(record.remote_endpoint_id));
      } catch {
        // The next sweep notes it.
      }
    };
    // D-201 Slice 10AQ — whether the search reached the account: only then
    // does what it did not find say anything.
    let searched = false;
    // D-201 Slice 10BT (10BS finding 13) — "elsewhere" against the webhook's
    // address now, not the one the stray was recorded at: after the owner moved
    // the webhooks address, a stray edited to the new one read as sending
    // elsewhere. When the address now cannot be read, the confirmed one stands
    // in, else the one the stray was recorded at.
    let here = first.endpoint_url;
    try {
      here = (await deps.resolveCanonicalEndpoint(ingress)) ?? ingress.confirmed_endpoint_url ?? first.endpoint_url;
    } catch {
      here = ingress.confirmed_endpoint_url ?? first.endpoint_url;
    }
    // D-201 Slice 10BY (10BX finding 2) — and against every other address the
    // server takes this webhook's messages at: its listener answers on every
    // name the server serves, so a stray left at the old name after a move
    // still sends here. 10BT read it as elsewhere, and left it out of what may
    // send the messages refused here.
    const home = new Set<string>([here]);
    try {
      for (const url of deps.ownEndpointUrls?.(ingress) ?? []) home.add(url);
    } catch {
      // The address now alone, as before.
    }
    try {
      for (const match of await adapter.find(context)) {
        if (!perAccount
          || (match.endpoint.remote_endpoint_id !== committed && match.endpoint.endpoint_url === first.endpoint_url)) {
          found.add(match.endpoint.remote_endpoint_id);
          if (match.correlation !== 'owned') {
            unproven.add(match.endpoint.remote_endpoint_id);
            if (!home.has(match.endpoint.endpoint_url)) elsewhere.add(match.endpoint.remote_endpoint_id);
          }
        }
        if (match.correlation !== 'owned'
          || match.endpoint.remote_endpoint_id === committed) continue;
        standing.push(match.endpoint.remote_endpoint_id);
      }
      searched = true;
      // D-201 Slice 10AQ (10AM findings 8 and 26) — the search reached the
      // account: a stray of this webhook's recorded there that it no longer
      // finds is gone, settled now, given up or not, whatever else in the
      // account fails below. Settled only once the whole account's sweep
      // succeeded, one stray that could not be removed kept another, gone
      // already, counted and given up as one to remove.
      settledGone = settleStraysGone(ingress.ingress_id, first.connection_id, first.endpoint_url, found);
      settled += settledGone.size;
      for (const remoteEndpointId of standing.slice()) {
        await adapter.delete(context, remoteEndpointId);
        if (await adapter.read(context, remoteEndpointId) !== null) {
          throw new WebhookRegistrationAdapterError(
            'upstream_unavailable',
            'a stray webhook endpoint still exists after its removal',
          );
        }
        standing.splice(standing.indexOf(remoteEndpointId), 1);
        removedIds.add(remoteEndpointId);
        removed += 1;
        try {
          deps.store.settleStrayEndpoint(ingress.ingress_id, remoteEndpointId);
        } catch {
          // Settled with its account's records below, or by the next sweep.
        }
      }
    } catch {
      if (removed > 0 && committed === null) moveAttemptOnAfterStray(ingress.ingress_id);
      for (const remoteEndpointId of standing) {
        try {
          deps.store.noteStrayEndpointStanding({
            ingress_id: ingress.ingress_id,
            connection_id: first.connection_id,
            endpoint_url: first.endpoint_url,
            remote_endpoint_id: remoteEndpointId,
          });
        } catch {
          // Unrecorded, as before 10AL: its account's records keep it swept.
        }
      }
      // D-201 Slice 10BA (10AY finding 4) — each stray that still stands, as
      // proven or not.
      if (searched) for (const record of records) if (stillStands(record)) noteProof(record);
      // Open still: every record when the search never reached the account;
      // else a create (something of it may stand), a stray recorded before
      // 10AL (named nowhere), and a stray that still stands.
      unreached(searched
        ? records.filter((record) => record.kind !== 'stray'
          || record.remote_endpoint_id === null
          || standing.includes(record.remote_endpoint_id)
          || stillStands(record))
        : records);
      return { removed, settled, given_up: givenUp, failed };
    }
    if (removed > 0 && committed === null) moveAttemptOnAfterStray(ingress.ingress_id);
    // Searched after the time it could land: nothing of it stands but the
    // endpoint committed, so it is settled. D-201 Slice 10AH (10AE finding
    // 8) — a stray a rebind kept had landed already: gone now, it is settled.
    const unprovable: WebhookUnsettledCreate[] = [];
    for (const record of records) {
      if (settledGone.has(record.create_id)) continue;
      // D-201 Slice 10AT (10AS finding 4) — found, and not removed: the search
      // could not prove it is this webhook's (its metadata edited at the
      // service), so it stands, kept as one whose removal is refused, given up
      // after a week for the owner to remove. Settled here, it left the card
      // while it stood at the service.
      if (stillStands(record)) {
        // D-201 Slice 10BA (10AY finding 4) — so its card says so.
        noteProof(record);
        unprovable.push(record);
        continue;
      }
      if (record.kind === 'stray' || at - record.sent_at >= WEBHOOK_UNSETTLED_CREATE_WINDOW_MS) {
        if (settle(record)) settled += 1;
      } else if (record.unreached_last_at !== null || record.unreached_since !== null) {
        // Reached again: a later run of failures counts from nothing.
        // D-201 Slice 10AH (10AE finding 20) — kept as it was if this cannot be
        // written: it was the one write here that could end the whole sweep.
        try {
          deps.store.noteUnsettledCreateReached(record.create_id);
        } catch {
          // The next search that reaches it notes it.
        }
      }
    }
    unreached(unprovable);
    return { removed, settled, given_up: givenUp, failed };
  };

  let sweeping: Promise<WebhookUnsettledCreateSweep> | null = null;
  const sweepUnsettledCreates: WebhookManagedRegistrationService['sweepUnsettledCreates'] = (
    options = {},
  ) => {
    if (sweeping !== null) return sweeping;
    sweeping = (async (): Promise<WebhookUnsettledCreateSweep> => {
      // Taken before any search: a record is settled only by a search made
      // after its window, and every search here is made after this.
      const at = clock();
      const accounts = new Map<string, WebhookUnsettledCreate[]>();
      for (const record of deps.store.listUnsettledCreates()) {
        const key = JSON.stringify([record.ingress_id, record.connection_id, record.endpoint_url]);
        const group = accounts.get(key);
        if (group === undefined) accounts.set(key, [record]);
        else group.push(record);
      }
      let removed = 0;
      let settled = 0;
      let givenUp = 0;
      let failed = 0;
      for (const records of accounts.values()) {
        if (options.isStopping?.() === true) break;
        // D-201 Slice 10AH (10AE finding 20) — one account's fault (a busy
        // database) is that account's, for the next sweep: it ended the sweep,
        // so every account after it waited a round too.
        let result: WebhookUnsettledCreateSweep;
        try {
          result = await withIngressLock(records[0]!.ingress_id, () => sweepAccount(records, at));
        } catch {
          failed += records.length;
          continue;
        }
        removed += result.removed;
        settled += result.settled;
        givenUp += result.given_up;
        failed += result.failed;
      }
      return { removed, settled, given_up: givenUp, failed };
    })().finally(() => { sweeping = null; });
    return sweeping;
  };

  return {
    reconcile: (ingressId) => withIngressLock(
      ingressId,
      () => reconcileUnlocked(ingressId),
    ),
    setSecretAgain: (ingressId) => withIngressLock(ingressId, async () => {
      const ingress = deps.store.get(ingressId);
      // D-201 Slice 10AR (10AM finding 12) — its secret Recued's, set up there,
      // and taking messages, as it stands under its lock (`mayBeSetAgain`, the
      // pass's rule): the pass read a snapshot. Switched off, it is the
      // owner's (2026-11-19), and the reconcile would set it at the service and
      // clear the latch a deleted connection leaves, which the owner clears by
      // hand. D-201 Slice 10AU (10AS finding 27) — none to set again is not a
      // failure: nothing is sent, and nothing is noted.
      if (ingress === null || !mayBeSetAgain(ingress)) return null;
      return reconcileUnlocked(ingressId, { setSecretAgain: true });
    }),
    sweepUnsettledCreates,
    cleanup(ingressId, intent) {
      let closed: WebhookIngressRecord;
      try {
        closed = intent === 'disable'
          ? deps.store.disable(ingressId)
          : deps.store.retire(ingressId);
      } catch (error) {
        return Promise.reject(error);
      }
      if (closed.registration_state !== 'cleanup_pending') {
        return Promise.resolve(closed);
      }
      const effectiveIntent = intent === 'disable'
        && (closed.pending_paired_connection_id ?? null) !== null
        ? 'rebind'
        : intent;
      return withIngressLock(
        ingressId,
        () => cleanupUnlocked(ingressId, effectiveIntent),
      );
    },
    rebind: (ingressId, pairedConnectionId) => withIngressLock(
      ingressId,
      () => rebindUnlocked(ingressId, pairedConnectionId),
    ),
  };
};
