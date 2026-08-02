/** D-125 P7.2 — schema → rpc-payload projection.
 *
 *  The form holds a flat map of dotted-path strings → values. The
 *  enrollment rpc takes a structured `{ name, kind, subtype?,
 *  display_name, publisher_id?, config: {}, auth: {} }`. This module
 *  walks the active schema, evaluates each field's `showWhen`, drops
 *  hidden + empty values, and assembles the structured payload.
 *
 *  Coercion is minimal: `json` fields parse to `unknown`; numeric
 *  fields stay strings (the rpc handler / per-kind handler coerces).
 *  Empty optional values are silently dropped. Required-empty surfaces
 *  as a validation error before submit; the projection itself never
 *  rejects — invalid shapes flow downstream and the rpc returns a
 *  structured `bad_request`. */

import type {
  ConnectionField,
  ConnectionFormValues,
  ConnectionSchema,
} from '../connection-schemas/index.js';
import {
  collectHeaderRows,
  initialVendorSchemaValues,
  resolveConnectionSchema,
  syncVendorOAuthEndpointValue,
} from '../connection-schemas/index.js';
import {
  getMessengerVendorDeclaration,
  getVendorProvider,
  resolveMessengerConnectionIngressMode,
} from '@recued/contracts';
import type { ConnectionAuth, ConnectionKind, ConnectionView } from '@recued/contracts';
import { connectionRowKey } from './state.js';

export interface ConnectionPayload {
  name: string;
  kind: ConnectionKind;
  subtype?: string;
  display_name: string;
  publisher_id?: string;
  config: Record<string, unknown>;
  auth: ConnectionAuth;
  /** D-165 P3.path-picker — optional sub-resource scope. Top-level (not
   *  config/auth). Omitted when the form field is blank → enroll
   *  canonicalizes the absent value to `/`. */
  subresource_path?: string;
  /** granted-scopes — vendor-granted OAuth scopes from a just-completed
   *  dance. NOT a schema/form field: lives in dialog state
   *  (`oauthGrantedScopes`) and is injected at the submit site, so
   *  `projectConnectionPayload` never sets it. Persisted non-secret for
   *  pack-readiness coverage; omitted → enroll preserves the existing set. */
  granted_scopes?: string[];
}

/** A path segment that is a non-negative integer addresses an ARRAY index — so the
 *  container at the PRECEDING segment is built as an array, not an object. Lets a flat
 *  schema key like `auth.headers.0.header_name` project into `headers: [{...}]`. No
 *  existing connection field key uses a numeric segment, so this is inert for them. */
const isArrayIndexSegment = (seg: string): boolean => /^\d+$/.test(seg);

const setDeep = (
  target: Record<string, unknown>,
  segments: readonly string[],
  value: unknown,
): void => {
  if (segments.length === 0) return;
  if (segments.length === 1) {
    target[segments[0]] = value;
    return;
  }
  const head = segments[0];
  const existing = target[head];
  const wantArray = isArrayIndexSegment(segments[1]);
  const next: Record<string, unknown> = wantArray
    ? (Array.isArray(existing) ? (existing as unknown as Record<string, unknown>) : ([] as unknown as Record<string, unknown>))
    : (typeof existing === 'object' && existing !== null && !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {});
  target[head] = next;
  setDeep(next, segments.slice(1), value);
};

const coerce = (field: ConnectionField, raw: string): unknown => {
  if (field.type === 'json') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return raw;
};

const AUTH_INTENT_EXCLUDED_KEYS = new Set(['auth.type', 'auth.token_endpoint', 'auth.token_auth_style']);

/** Edit mode does not hydrate stored auth secrets. Treat auth updates
 *  as opt-in: only send `patch.auth` when the user or OAuth flow has
 *  supplied at least one credential-bearing auth field. */
export const shouldPatchConnectionAuth = (
  schema: ConnectionSchema,
  values: ConnectionFormValues,
): boolean =>
  schema.fields.some((field) => {
    if (!field.key.startsWith('auth.')) return false;
    if (AUTH_INTENT_EXCLUDED_KEYS.has(field.key)) return false;
    if (field.showWhen && !field.showWhen(values)) return false;
    if (field.type === 'header-list') {
      return collectHeaderRows(values, field.key).some((row) =>
        row.header_name.trim().length > 0 || row.value.trim().length > 0);
    }
    return (values[field.key] ?? '').trim().length > 0;
  });

/** Project a (schema, values, kind, subtype?) tuple into the rpc
 *  payload shape. Hidden fields are skipped. Empty optional values
 *  are dropped. The discriminated `auth` union is built field-by-
 *  field; downstream rpc validation rejects malformed combinations. */
export const projectConnectionPayload = (
  schema: ConnectionSchema,
  values: ConnectionFormValues,
  kind: ConnectionKind,
  subtype: string | null,
): ConnectionPayload => {
  const root: Record<string, unknown> = {};
  for (const field of schema.fields) {
    if (field.showWhen && !field.showWhen(values)) continue;
    // D-192 M4c-UI — the messenger triggers are NOT projected into the
    // enroll/update `config`: they are stripped from `ConnectionView` (a config
    // replace can't round-trip them) and persisted either by the dedicated
    // `setMatchPatterns` merge-write or atomically inside credential rotation.
    // Skip the flat `<key>.<i>.*` rows here so they never leak into `config`.
    if (field.type === 'match-pattern-list') continue;
    // header-list — gather the credential-header rows, DROP fully-blank ones,
    // and RE-INDEX contiguously (0..N-1) so the array-aware `setDeep` builds a
    // clean `auth.headers` array with NO sparse holes (a removed row left a gap
    // in the form indices). Values are sent verbatim; the server's
    // `validateHeaderAuthEntries` is the authority on the final shape (a
    // half-filled row that slips through is rejected there).
    if (field.type === 'header-list') {
      const base = field.key.split('.');
      collectHeaderRows(values, field.key)
        .filter((r) => r.header_name.trim().length > 0 || r.value.trim().length > 0)
        .forEach((r, j) => {
          setDeep(root, [...base, String(j), 'header_name'], r.header_name);
          setDeep(root, [...base, String(j), 'value'], r.value);
        });
      continue;
    }
    const raw = values[field.key] ?? '';
    if (raw === '' && field.optional) continue;
    if (raw === '' && !field.optional && field.type !== 'select') {
      // Skip empty required scalars — caller's required-validator
      // surfaces this; projection still produces a shape so the rpc
      // handler can also respond with `bad_request`.
      continue;
    }
    const coerced = coerce(field, raw);
    if (coerced === undefined) continue;
    setDeep(root, field.key.split('.'), coerced);
  }

  const name = (root.name as string | undefined) ?? '';
  const display_name = (root.display_name as string | undefined) ?? '';
  const config = (root.config as Record<string, unknown> | undefined) ?? {};
  const authObj = (root.auth as Record<string, unknown> | undefined) ?? { type: 'none' };
  const auth = authObj as unknown as ConnectionAuth;

  const payload: ConnectionPayload = {
    name,
    kind,
    display_name,
    config,
    auth,
  };
  if (subtype) payload.subtype = subtype;
  // D-165 P3.path-picker — top-level scope (the field's optional+empty is
  // already dropped by the loop above, so a present value means the user
  // typed one). Absent → enroll defaults to `/`.
  if (typeof root.subresource_path === 'string') {
    payload.subresource_path = root.subresource_path;
  }
  return payload;
};

/** Inverse projection — flatten an enrolled `ConnectionView`'s top-
 *  level config into form values keyed by `config.<field>`. Auth
 *  fields are NEVER hydrated (the view excludes them by construction);
 *  edit mode requires the user to retype credentials. */
export const flattenConnectionViewIntoValues = (
  view: Record<string, unknown>,
): ConnectionFormValues => {
  const values: ConnectionFormValues = {};
  if (typeof view.name === 'string') values.name = view.name;
  if (typeof view.display_name === 'string') values.display_name = view.display_name;
  // D-165 P3.path-picker — map the scope to the TOP-LEVEL form key so edit
  // mode pre-fills the read-only picker; without this special-case the
  // loop below would mis-file it as `config.subresource_path`.
  if (typeof view.subresource_path === 'string') values.subresource_path = view.subresource_path;
  for (const [k, v] of Object.entries(view)) {
    if (
      k === 'name'
      || k === 'kind'
      || k === 'subtype'
      || k === 'display_name'
      || k === 'subresource_path'
      // Server-projected connection metadata guides the edit surface but is
      // not provider config. In particular, `auth_type` is consumed below to
      // restore the right credential family; flattening it as
      // `config.auth_type` would misclassify it as owner configuration.
      || k === 'auth_type'
      || k === 'updated_at'
      || k === 'granted_scopes'
      || k === 'bound_pack_slugs'
      || k === 'supports_engagement_health'
    ) continue;
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') {
      values[`config.${k}`] = JSON.stringify(v);
    } else {
      values[`config.${k}`] = String(v);
    }
  }
  return values;
};

export interface ConnectionEditDialogPatch {
  stage: 'form';
  mode: 'edit';
  kind: ConnectionKind;
  subtype: string | null;
  vendor: string | null;
  values: ConnectionFormValues;
  editingId: string;
  error: null;
}

export const resolveConnectionViewVendor = (view: ConnectionView): string | null => {
  if (view.kind !== 'api') return null;
  if (typeof view.vendor !== 'string') return null;
  return getVendorProvider(view.vendor) ? view.vendor : null;
};

/** Build the host patch for editing an enrolled connection. Auth
 *  credentials are still excluded, but vendor flows need their hidden
 *  OAuth defaults restored so the dialog resolves the same schema that
 *  created the row. */
export const buildConnectionEditDialogPatch = (
  view: ConnectionView,
): ConnectionEditDialogPatch => {
  const subtype = typeof view.subtype === 'string' ? view.subtype : null;
  const vendor = resolveConnectionViewVendor(view);
  let values: ConnectionFormValues = {
    ...(vendor ? initialVendorSchemaValues(vendor) : {}),
    ...flattenConnectionViewIntoValues(view),
  };
  values = syncVendorOAuthEndpointValue(vendor, values);

  const schema = resolveConnectionSchema(
    view.kind,
    subtype ?? undefined,
    vendor ?? undefined,
  );
  if (schema) {
    // A pre-ingress-mode messenger row historically ran as a webhook. The
    // renderer visually selects option[0] when form state is absent, so without
    // this explicit projection an old row would *look* local-first while saving
    // back as webhook. Make the compatibility decision visible and editable.
    const messenger = subtype === null ? null : getMessengerVendorDeclaration(subtype);
    if (messenger !== null && values['config.ingress_mode'] === undefined) {
      const legacyMode = resolveMessengerConnectionIngressMode(messenger, {});
      if (legacyMode !== null) values['config.ingress_mode'] = legacyMode;
    }
    const authField = schema.fields.find((f) => f.key === 'auth.type');
    const storedAuthType = view.auth_type;
    if (
      typeof storedAuthType === 'string'
      && authField?.options?.includes(storedAuthType)
    ) {
      values['auth.type'] = storedAuthType;
    } else if (authField?.options?.[0]) {
      values['auth.type'] = authField.options[0];
    }
  }

  return {
    stage: 'form',
    mode: 'edit',
    kind: view.kind,
    subtype,
    vendor,
    values,
    editingId: connectionRowKey(view.kind, view.name),
    error: null,
  };
};
