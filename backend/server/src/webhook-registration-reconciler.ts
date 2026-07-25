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
  | 'state_changed';

export class WebhookManagedRegistrationError extends Error {
  constructor(
    readonly code: WebhookManagedRegistrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WebhookManagedRegistrationError';
  }
}

export interface WebhookManagedRegistrationService {
  reconcile(ingressId: string): Promise<WebhookIngressRecord>;
  cleanup(
    ingressId: string,
    intent: 'disable' | 'retire',
  ): Promise<WebhookIngressRecord>;
  rebind(ingressId: string, pairedConnectionId: string): Promise<WebhookIngressRecord>;
}

export interface WebhookManagedRegistrationServiceDeps {
  store: WebhookIngressStore;
  adapters: WebhookRegistrationRuntimeRegistry;
  profilePolicies?: WebhookProfileControlPlanePolicyRegistry;
  resolveCanonicalEndpoint: (
    ingress: WebhookIngressRecord,
  ) => string | null | Promise<string | null>;
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
      return new WebhookManagedRegistrationError('upstream_rejected', error.message);
    case 'upstream_unavailable':
    case 'upstream_response_invalid':
    case 'upstream_response_too_large':
    case 'search_incomplete':
      return new WebhookManagedRegistrationError('upstream_unavailable', error.message);
  }
};

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
  const markDrift = (
    expected: WebhookManagedRegistrationExpectation,
    code: WebhookManagedRegistrationFailureCode,
  ): void => {
    try {
      deps.store.markManagedRegistrationDrift(expected, code);
    } catch (error) {
      // Never let a stale external result overwrite a newer ingress edit. A
      // compare-and-set conflict is the desired outcome and the caller's
      // original, more specific failure remains authoritative.
      if (!(error instanceof WebhookIngressStoreError)
        || (error.code !== 'conflict' && error.code !== 'retired')) throw error;
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

  const reconcileUnlocked = async (ingressId: string): Promise<WebhookIngressRecord> => {
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
          if (!matchesDesired(remote, desired)) {
            await ensureCurrent(expected, endpointUrl);
            await adapter.update(
              context,
              ingress.remote_endpoint_id,
              updateIdempotencyKey(expected, desired),
            );
            remote = await adapter.read(context, ingress.remote_endpoint_id);
            if (remote === null
              || remote.remote_endpoint_id !== ingress.remote_endpoint_id
              || !matchesDesired(remote, desired)) {
              markDrift(expected, remote === null
                ? 'managed_remote_missing'
                : 'managed_registration_drift');
              throw new WebhookManagedRegistrationError(
                remote === null ? 'remote_missing' : 'upstream_unavailable',
                'provider webhook endpoint read-back did not match the requested configuration',
              );
            }
          }
        } catch (error) {
          if (error instanceof WebhookManagedRegistrationError) throw error;
          if (error instanceof WebhookRegistrationAdapterError) {
            markDrift(expected, 'managed_registration_drift');
            throw adapterError(error);
          }
          throw error;
        }
        await ensureCurrent(expected, endpointUrl);
        return deps.store.confirmManagedRegistrationReadBack({
          expected,
          remote_endpoint_id: ingress.remote_endpoint_id,
          endpoint_url: endpointUrl,
          requires_handshake: false,
        });
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
      }

      await ensureCurrent(expected, endpointUrl);
      let created;
      try {
        created = await adapter.create(
          context,
          createIdempotencyKey(expected, desired),
        );
      } catch (error) {
        if (error instanceof WebhookRegistrationAdapterError) {
          markDrift(expected, 'managed_registration_unconfirmed');
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
        return await deps.store.commitManagedRegistrationCreate({
          expected,
          remote_endpoint_id: readBack.remote_endpoint_id,
          endpoint_url: endpointUrl,
          credentials: created.credential_result,
          requires_handshake: false,
        });
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
          });
        }
      }

      const targetMatches = await adapter.find(targetContext);
      await ensureCurrent(expected, endpointUrl);
      if (targetMatches.length > 0) {
        throw new WebhookManagedRegistrationError(
          'ambiguous',
          'replacement connection already contains correlated webhook endpoints; no connection changed',
        );
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

  return {
    reconcile: (ingressId) => withIngressLock(
      ingressId,
      () => reconcileUnlocked(ingressId),
    ),
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
