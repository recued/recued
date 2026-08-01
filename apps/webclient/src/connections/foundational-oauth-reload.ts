/** Privacy-safe reload marker for foundational OAuth.
 *
 * A browser reload destroys the popup listener and every in-memory callback.
 * Persisting the authorization code/state would make that recoverable only by
 * making it replayable, so this marker deliberately stores neither. It keeps
 * just enough closed-list identity to return the owner to the exact lane and
 * distinguish a clean restart from an exchange whose server outcome must be
 * checked first. */

import type { OAuthAppIssuer } from '@recued/contracts';
import type { AccountFormValues, AccountLaneId } from '@recued/ui-shared';

export type FoundationalOAuthReloadPhase =
  | 'before_exchange'
  | 'during_exchange';

export interface FoundationalOAuthReloadMarker {
  readonly lane: Extract<AccountLaneId, 'mail' | 'calendar'>;
  readonly providerId: string;
  readonly providerLabel: string;
  readonly issuer: OAuthAppIssuer;
  readonly slug: string;
  readonly returnHref: string;
  readonly accountValues: Readonly<AccountFormValues>;
  readonly clientId: string;
  readonly phase: FoundationalOAuthReloadPhase;
  readonly phaseStartedAt: number;
}

export type FoundationalOAuthContinuityStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem'
>;

interface StoredMarkerV1 {
  readonly version: 1;
  readonly scope_id: string;
  readonly lane: 'mail' | 'calendar';
  readonly provider_id: string;
  readonly slug: string;
  readonly account_values: Readonly<Record<string, string>>;
  readonly client_id: string;
  readonly phase: FoundationalOAuthReloadPhase;
  readonly phase_started_at: number;
}

const STORAGE_KEY = 'recued.foundational-oauth.reload.v1';
const DEFAULT_MAX_AGE_MS = 30 * 60 * 1_000;
const SLUG_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SAFE_VALUE_KEYS = new Set([
  'name',
  'send_enabled',
  'calendar_enabled',
]);

/** Defense-in-depth allowlist shared by in-memory continuity and the durable
 * marker. Adding a provider field does not make it boot-lived by accident. */
export const retainFoundationalOAuthAccountValues = (
  values: Readonly<AccountFormValues>,
): AccountFormValues => {
  const out: AccountFormValues = {};
  for (const [key, value] of Object.entries(values)) {
    if (SAFE_VALUE_KEYS.has(key)) out[key] = value;
  }
  return out;
};

const providerIdentity = (
  lane: StoredMarkerV1['lane'],
  providerId: string,
): { providerLabel: string; issuer: OAuthAppIssuer } | null => {
  if (lane === 'mail' && providerId === 'gmail') {
    return { providerLabel: 'Gmail', issuer: 'google' };
  }
  if (lane === 'mail' && providerId === 'graph') {
    return { providerLabel: 'Microsoft', issuer: 'microsoft' };
  }
  if (lane === 'calendar' && providerId === 'gcal') {
    return { providerLabel: 'Google', issuer: 'google' };
  }
  if (lane === 'calendar' && providerId === 'graph') {
    return { providerLabel: 'Microsoft', issuer: 'microsoft' };
  }
  return null;
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object'
  && value !== null
  && !Array.isArray(value);

const safeValues = (
  value: unknown,
  rejectUnknown = true,
): AccountFormValues | null => {
  if (!isPlainRecord(value)) return null;
  const out: AccountFormValues = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!SAFE_VALUE_KEYS.has(key)) {
      if (rejectUnknown) return null;
      continue;
    }
    if (typeof fieldValue !== 'string') return null;
    if (key === 'name') {
      if (!SLUG_REGEX.test(fieldValue)) return null;
    } else if (fieldValue !== 'true' && fieldValue !== 'false') {
      return null;
    }
    out[key] = fieldValue;
  }
  return out;
};

const retire = (storage: FoundationalOAuthContinuityStorage): boolean => {
  try {
    // Inert-before-remove makes a denied remove one-shot too. If even this
    // write fails, callers refuse to trust the old marker rather than replay it.
    storage.setItem(STORAGE_KEY, '{"version":1,"retired":true}');
    try {
      storage.removeItem(STORAGE_KEY);
    } catch {
      /* the inert replacement is already safe */
    }
    return true;
  } catch {
    return false;
  }
};

const parse = (
  raw: string,
  scopeId: string,
  now: number,
  maxAgeMs: number,
): FoundationalOAuthReloadMarker | null => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainRecord(value)) return null;
  if (
    value['version'] !== 1
    || value['scope_id'] !== scopeId
    || (value['lane'] !== 'mail' && value['lane'] !== 'calendar')
    || typeof value['provider_id'] !== 'string'
    || typeof value['slug'] !== 'string'
    || !SLUG_REGEX.test(value['slug'])
    || typeof value['client_id'] !== 'string'
    || value['client_id'].length > 512
    || (value['phase'] !== 'before_exchange'
      && value['phase'] !== 'during_exchange')
    || typeof value['phase_started_at'] !== 'number'
    || !Number.isFinite(value['phase_started_at'])
    || value['phase_started_at'] > now
    || now - value['phase_started_at'] > maxAgeMs
  ) return null;

  const lane = value['lane'];
  const providerId = value['provider_id'];
  const provider = providerIdentity(lane, providerId);
  const accountValues = safeValues(value['account_values']);
  if (provider === null || accountValues === null) return null;
  if (accountValues['name'] !== value['slug']) return null;

  return {
    lane,
    providerId,
    providerLabel: provider.providerLabel,
    issuer: provider.issuer,
    slug: value['slug'],
    returnHref: `#connections/${lane}`,
    accountValues,
    clientId: value['client_id'],
    phase: value['phase'],
    phaseStartedAt: value['phase_started_at'],
  };
};

export interface FoundationalOAuthReloadStore {
  write(marker: Omit<FoundationalOAuthReloadMarker,
    'providerLabel' | 'issuer' | 'returnHref'>): boolean;
  consume(): FoundationalOAuthReloadMarker | null;
  retire(): void;
}

export const createFoundationalOAuthReloadStore = (options: {
  storage?: FoundationalOAuthContinuityStorage | null;
  scopeId?: string | null;
  now?: () => number;
  maxAgeMs?: number;
}): FoundationalOAuthReloadStore => {
  const storage = options.storage === undefined
    ? (() => {
        try {
          return globalThis.sessionStorage;
        } catch {
          return null;
        }
      })()
    : options.storage;
  const scopeId = options.scopeId?.trim() ?? '';
  const enabled = storage !== null
    && storage !== undefined
    && scopeId.length > 0
    && scopeId.length <= 256;
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

  return {
    write(marker) {
      if (!enabled) return false;
      const provider = providerIdentity(marker.lane, marker.providerId);
      // Callers can carry future route-local fields. Persist only this audited
      // allowlist; parsing remains strict so storage tampering cannot smuggle
      // an unknown value back into a form.
      const values = safeValues(
        retainFoundationalOAuthAccountValues(marker.accountValues),
        false,
      );
      if (
        provider === null
        || values === null
        || !SLUG_REGEX.test(marker.slug)
        || values['name'] !== marker.slug
        || marker.clientId.length > 512
        || !Number.isFinite(marker.phaseStartedAt)
      ) return false;
      const stored: StoredMarkerV1 = {
        version: 1,
        scope_id: scopeId,
        lane: marker.lane,
        provider_id: marker.providerId,
        slug: marker.slug,
        account_values: values,
        client_id: marker.clientId,
        phase: marker.phase,
        phase_started_at: marker.phaseStartedAt,
      };
      try {
        storage!.setItem(STORAGE_KEY, JSON.stringify(stored));
        return true;
      } catch {
        return false;
      }
    },
    consume() {
      if (!enabled) return null;
      let raw: string | null;
      try {
        raw = storage!.getItem(STORAGE_KEY);
      } catch {
        return null;
      }
      if (raw === null) return null;
      if (!retire(storage!)) return null;
      return parse(raw, scopeId, now(), maxAgeMs);
    },
    retire() {
      if (enabled) retire(storage!);
    },
  };
};
