/** Privacy-bounded continuity for an interrupted provider-app setup guide.
 *
 * The connection form is deliberately absent from this envelope. A reload
 * rebuilds that form from its local schema defaults, so client ids, secrets,
 * tokens, account names, endpoints entered by the owner, and every other form
 * value disappear. Only the already-reviewed public URL, closed-list field
 * keys, safe AI guidance, and the non-secret schema identity survive long
 * enough to offer an explicit one-shot return.
 */

import { CONNECTION_AUTH_TYPES } from '@recued/contracts';
import {
  CONNECTION_NAME_REGEX,
  canonicalizeConnectionSetupGuideUrl,
  canApplyConnectionSetupGuideSuggestion,
  type ConnectionSetupGuideResult,
} from '@recued/ui-shared';

export type ProviderSetupContinuityStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem'
>;

export type ProviderSetupSchemaKind =
  | 'bare_api'
  | 'registered_vendor'
  | 'pack_vendor';

export interface ProviderSetupContinuityDraft {
  /** Distinguishes a built-in schema from a generic vendor-tagged API form so
   *  a registry change cannot silently restore the guide into another form. */
  readonly schemaKind: ProviderSetupSchemaKind;
  /** Registered vendor slug, pack vendor slug, or null for the bare API form. */
  readonly schemaVendor: string | null;
  /** Closed-list field name only—never its value. This preserves the exact
   *  unfinished handoff without retaining any connection-form material. */
  readonly resumeFieldKey: string | null;
  readonly result: ConnectionSetupGuideResult;
}

export interface ProviderSetupContinuityStore {
  /** Replaces the one same-tab draft with a newly audited safe projection. */
  write(draft: ProviderSetupContinuityDraft): boolean;
  /** Peeks without consuming so route changes do not discard the offer. */
  read(): ProviderSetupContinuityDraft | null;
  /** Makes the offer inert before best-effort physical removal. */
  retire(): void;
}

interface StoredProviderSetupV1 {
  readonly version: 1;
  readonly scope_id: string;
  readonly saved_at: number;
  readonly schema_kind: ProviderSetupSchemaKind;
  readonly schema_vendor: string | null;
  readonly resume_field_key: string | null;
  readonly result: ConnectionSetupGuideResult;
}

export const PROVIDER_SETUP_CONTINUITY_SESSION_KEY =
  'recued.connections.provider-setup.v1';

const DEFAULT_MAX_AGE_MS = 2 * 60 * 60 * 1_000;
const MAX_SCOPE_ID = 256;
const MAX_GUIDE_FIELDS = 24;
const MAX_STEPS = 12;
const MAX_STEP_FIELDS = 8;
const MAX_CAUTIONS = 8;
const SCHEMA_KINDS: ReadonlySet<string> = new Set([
  'bare_api',
  'registered_vendor',
  'pack_vendor',
]);

const GUIDE_FIELD_KEYS = new Set([
  'name',
  'display_name',
  'config.base_url',
  'subresource_path',
  'auth.type',
  'auth.refresh_token',
  'auth.client_id',
  'auth.client_secret',
  'auth.token_endpoint',
  'auth.authorize_url',
  'auth.scopes',
  'auth.scope',
]);

const OAUTH_AUTH_TYPES: ReadonlySet<string> = new Set(
  CONNECTION_AUTH_TYPES.filter((type) =>
    type === 'oauth2_refresh' || type === 'oauth2_client_credentials'),
);
const URL_SUGGESTION_FIELDS: ReadonlySet<string> = new Set([
  'config.base_url',
  'auth.token_endpoint',
  'auth.authorize_url',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
};

const boundedText = (
  value: unknown,
  max: number,
): string | null => {
  if (typeof value !== 'string' || value.length > max) return null;
  if (value.trim().length === 0) return null;
  return value;
};

const safeFieldKeys = (
  value: unknown,
  allowed?: ReadonlySet<string>,
  max = MAX_GUIDE_FIELDS,
): string[] | null => {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: string[] = [];
  for (const key of value) {
    if (
      typeof key !== 'string'
      || !GUIDE_FIELD_KEYS.has(key)
      || (allowed !== undefined && !allowed.has(key))
      || out.includes(key)
    ) return null;
    out.push(key);
  }
  return out;
};

/** Rebuild a fresh result object while stripping concrete values for every
 * guidance-only/identity/secret field. This is intentionally stricter than
 * the live renderer: persistence retains only suggestions the UI is allowed
 * to transfer into a non-secret field after another explicit check. */
const safeResult = (
  value: unknown,
  strictStored = false,
): ConnectionSetupGuideResult | null => {
  if (!isRecord(value) || !hasExactKeys(value, ['shared_context', 'guide'])) {
    return null;
  }
  const context = value.shared_context;
  if (
    !isRecord(context)
    || !hasExactKeys(context, ['target_url', 'auth_type', 'field_keys'])
    || typeof context.target_url !== 'string'
    || typeof context.auth_type !== 'string'
    || !OAUTH_AUTH_TYPES.has(context.auth_type)
  ) return null;
  const canonical = canonicalizeConnectionSetupGuideUrl(context.target_url);
  if (!canonical.ok || canonical.url !== context.target_url) return null;
  const fieldKeys = safeFieldKeys(context.field_keys);
  if (fieldKeys === null || fieldKeys.length === 0) return null;
  const allowed = new Set(fieldKeys);

  const guide = value.guide;
  if (
    !isRecord(guide)
    || !hasExactKeys(guide, [
      'provider_name',
      'overview',
      'field_suggestions',
      'steps',
      'cautions',
    ])
  ) return null;
  const providerName = boundedText(guide.provider_name, 100);
  const overview = boundedText(guide.overview, 700);
  if (providerName === null || overview === null) return null;

  if (
    !Array.isArray(guide.field_suggestions)
    || guide.field_suggestions.length > MAX_GUIDE_FIELDS
  ) return null;
  const seenSuggestions = new Set<string>();
  const fieldSuggestions: ConnectionSetupGuideResult['guide']['field_suggestions'] = [];
  for (const raw of guide.field_suggestions) {
    if (
      !isRecord(raw)
      || !hasExactKeys(
        raw,
        ['field_key', 'guidance', 'confidence'],
        ['suggested_value'],
      )
      || typeof raw.field_key !== 'string'
      || !allowed.has(raw.field_key)
      || seenSuggestions.has(raw.field_key)
      || (raw.confidence !== 'high'
        && raw.confidence !== 'medium'
        && raw.confidence !== 'low')
    ) return null;
    const guidance = boundedText(raw.guidance, 700);
    if (guidance === null) return null;
    if (
      Object.hasOwn(raw, 'suggested_value')
      && typeof raw.suggested_value !== 'string'
    ) return null;
    let suggestedValue = typeof raw.suggested_value === 'string'
      && canApplyConnectionSetupGuideSuggestion(raw.field_key, raw.suggested_value)
      ? raw.suggested_value.trim()
      : undefined;
    // URL suggestions are public metadata, but a query/fragment is neither
    // needed to rebuild the guide nor safe to carry across reloads. Apply the
    // same canonicalizer as reviewed context before persistence.
    if (suggestedValue !== undefined && URL_SUGGESTION_FIELDS.has(raw.field_key)) {
      const safeUrl = canonicalizeConnectionSetupGuideUrl(suggestedValue);
      suggestedValue = safeUrl.ok ? safeUrl.url : undefined;
    }
    // Writes deliberately project unsafe model values away. Reads are
    // stricter: if a stored marker was widened later (for example with a
    // client secret or query-bearing URL), retire the whole marker instead of
    // leaving credential-bearing bytes behind while showing reassuring copy.
    if (
      strictStored
      && Object.hasOwn(raw, 'suggested_value')
      && suggestedValue !== raw.suggested_value
    ) return null;
    fieldSuggestions.push({
      field_key: raw.field_key,
      ...(suggestedValue !== undefined ? { suggested_value: suggestedValue } : {}),
      guidance,
      confidence: raw.confidence,
    });
    seenSuggestions.add(raw.field_key);
  }

  if (!Array.isArray(guide.steps) || guide.steps.length > MAX_STEPS) return null;
  const steps: ConnectionSetupGuideResult['guide']['steps'] = [];
  for (const raw of guide.steps) {
    if (
      !isRecord(raw)
      || !hasExactKeys(raw, ['title', 'instruction', 'field_keys'])
    ) return null;
    const title = boundedText(raw.title, 120);
    const instruction = boundedText(raw.instruction, 900);
    const stepFields = safeFieldKeys(raw.field_keys, allowed, MAX_STEP_FIELDS);
    if (title === null || instruction === null || stepFields === null) return null;
    steps.push({ title, instruction, field_keys: stepFields });
  }
  if (steps.length === 0) return null;

  if (!Array.isArray(guide.cautions) || guide.cautions.length > MAX_CAUTIONS) {
    return null;
  }
  const cautions: string[] = [];
  for (const caution of guide.cautions) {
    const text = boundedText(caution, 500);
    if (text === null) return null;
    cautions.push(text);
  }

  return {
    shared_context: {
      target_url: canonical.url,
      auth_type: context.auth_type as ConnectionSetupGuideResult['shared_context']['auth_type'],
      field_keys: fieldKeys,
    },
    guide: {
      provider_name: providerName,
      overview,
      field_suggestions: fieldSuggestions,
      steps,
      cautions,
    },
  };
};

const retireStored = (
  storage: ProviderSetupContinuityStorage,
  scopeId: string,
): void => {
  try {
    const raw = storage.getItem(PROVIDER_SETUP_CONTINUITY_SESSION_KEY);
    if (raw !== null) {
      const value = JSON.parse(raw) as unknown;
      if (
        isRecord(value)
        && typeof value.scope_id === 'string'
        && value.scope_id.length > 0
        && value.scope_id.length <= MAX_SCOPE_ID
        && value.scope_id !== scopeId
      ) return;
    }
  } catch {
    // If the marker cannot be classified, continue with the fail-closed inert
    // write. This is the only way to make a current-scope offer one-shot when
    // a browser allows writes but intermittently denies reads.
  }
  try {
    storage.setItem(
      PROVIDER_SETUP_CONTINUITY_SESSION_KEY,
      '{"version":1,"retired":true}',
    );
  } catch {
    // Removal may still be permitted even when quota/policy blocks writes.
  }
  try {
    storage.removeItem(PROVIDER_SETUP_CONTINUITY_SESSION_KEY);
  } catch {
    // If the inert write succeeded it is already safe. If both mutations were
    // denied, the store instance still prevents replay for the current boot.
  }
};

export const createProviderSetupContinuityStore = (options: {
  storage?: ProviderSetupContinuityStorage | null;
  scopeId?: string | null;
  now?: () => number;
  maxAgeMs?: number;
}): ProviderSetupContinuityStore => {
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
    && scopeId.length <= MAX_SCOPE_ID;
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs !== undefined
    && Number.isFinite(options.maxAgeMs)
    && options.maxAgeMs > 0
    ? options.maxAgeMs
    : DEFAULT_MAX_AGE_MS;
  let locallyRetired = false;

  const retire = (): void => {
    locallyRetired = true;
    if (enabled) retireStored(storage!, scopeId);
  };

  return {
    write(draft) {
      if (!enabled) return false;
      const savedAt = now();
      const result = safeResult(draft.result);
      if (
        !Number.isFinite(savedAt)
        || !SCHEMA_KINDS.has(draft.schemaKind)
        || (draft.schemaVendor !== null
          && !CONNECTION_NAME_REGEX.test(draft.schemaVendor))
        || ((draft.schemaKind === 'bare_api') !== (draft.schemaVendor === null))
        || result === null
        || (draft.resumeFieldKey !== null
          && (!GUIDE_FIELD_KEYS.has(draft.resumeFieldKey)
            || !result.shared_context.field_keys.includes(draft.resumeFieldKey)))
      ) return false;
      const stored: StoredProviderSetupV1 = {
        version: 1,
        scope_id: scopeId,
        saved_at: savedAt,
        schema_kind: draft.schemaKind,
        schema_vendor: draft.schemaVendor,
        resume_field_key: draft.resumeFieldKey,
        result,
      };
      try {
        storage!.setItem(
          PROVIDER_SETUP_CONTINUITY_SESSION_KEY,
          JSON.stringify(stored),
        );
        locallyRetired = false;
        return true;
      } catch {
        return false;
      }
    },

    read() {
      if (!enabled || locallyRetired) return null;
      let raw: string | null;
      try {
        raw = storage!.getItem(PROVIDER_SETUP_CONTINUITY_SESSION_KEY);
      } catch {
        return null;
      }
      if (raw === null) return null;

      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        retire();
        return null;
      }
      if (!isRecord(value)) {
        retire();
        return null;
      }
      // A sessionStorage tab may deliberately switch profiles and later
      // switch back. Do not expose or destroy another profile's safe draft.
      if (
        typeof value.scope_id === 'string'
        && value.scope_id.length > 0
        && value.scope_id.length <= MAX_SCOPE_ID
        && value.scope_id !== scopeId
      ) return null;
      if (
        !hasExactKeys(value, [
          'version',
          'scope_id',
          'saved_at',
          'schema_kind',
          'schema_vendor',
          'resume_field_key',
          'result',
        ])
        || value.version !== 1
        || value.scope_id !== scopeId
        || typeof value.saved_at !== 'number'
        || !Number.isFinite(value.saved_at)
        || (() => {
          const readAt = now();
          return !Number.isFinite(readAt)
            || value.saved_at > readAt
            || readAt - value.saved_at > maxAgeMs;
        })()
        || typeof value.schema_kind !== 'string'
        || !SCHEMA_KINDS.has(value.schema_kind)
        || (value.schema_vendor !== null
          && (typeof value.schema_vendor !== 'string'
            || !CONNECTION_NAME_REGEX.test(value.schema_vendor)))
        || ((value.schema_kind === 'bare_api') !== (value.schema_vendor === null))
        || (value.resume_field_key !== null
          && (typeof value.resume_field_key !== 'string'
            || !GUIDE_FIELD_KEYS.has(value.resume_field_key)))
      ) {
        retire();
        return null;
      }
      const result = safeResult(value.result, true);
      if (
        result === null
        || (value.resume_field_key !== null
          && !result.shared_context.field_keys.includes(value.resume_field_key))
      ) {
        retire();
        return null;
      }
      return {
        schemaKind: value.schema_kind as ProviderSetupSchemaKind,
        schemaVendor: value.schema_vendor as string | null,
        resumeFieldKey: value.resume_field_key as string | null,
        result,
      };
    },

    retire,
  };
};
