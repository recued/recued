/** UI model for the read-only API connection "Suggest and guide" flow.
 *
 *  The privacy boundary is explicit: a request contains a cleaned public HTTPS
 *  URL, the selected auth discriminant, and visible schema field KEYS. It never
 *  contains the `ConnectionFormValues` object where credentials and other
 *  free-form values live.
 */

import {
  APPLICABLE_GUIDE_FIELD_KEYS,
  CONNECTION_AUTH_TYPES,
  HTTPS_GUIDE_FIELD_KEYS,
  canApplyConnectionSetupGuideSuggestion,
  isPrivateHost,
  type RpcRequest,
  type RpcResponse,
  type ServerRpcRegistry,
} from '@recued/contracts';

// D-223 — the admission filter and its key sets MOVED to `@recued/contracts` so
// the pack-manifest validator can apply the very same gate to a publisher's
// declared hints. Re-exported here because this module was their home and every
// existing caller imports them from it; there is deliberately no second copy.
export {
  APPLICABLE_GUIDE_FIELD_KEYS,
  HTTPS_GUIDE_FIELD_KEYS,
  canApplyConnectionSetupGuideSuggestion,
};
import type {
  ConnectionFormValues,
  ConnectionSchema,
} from '../connection-schemas/types.js';

export type ConnectionSetupGuideRequest = RpcRequest<
  ServerRpcRegistry,
  'collection.connection.suggestSetup'
>;
export type ConnectionSetupGuideResult = RpcResponse<
  ServerRpcRegistry,
  'collection.connection.suggestSetup'
>;
export type ConnectionSetupGuideAuthType = ConnectionSetupGuideRequest['auth_type'];
export type ConnectionSetupGuideConfidence =
  ConnectionSetupGuideResult['guide']['field_suggestions'][number]['confidence'];

export interface ConnectionSetupGuidePreview extends ConnectionSetupGuideRequest {
  visible_fields: Array<{
    key: string;
    label: string;
  }>;
}

export type ConnectionsSetupGuideStage =
  | 'closed'
  | 'entry'
  | 'preview'
  | 'loading'
  | 'ready'
  | 'error';

export interface ConnectionsSetupGuideState {
  stage: ConnectionsSetupGuideStage;
  targetUrl: string;
  preview: ConnectionSetupGuidePreview | null;
  result: ConnectionSetupGuideResult | null;
  error: string | null;
  /** A privacy-safe durable guide was restored after navigation/reload. The
   *  host clears this only when the owner explicitly resumes or abandons it. */
  resumeAvailable: boolean;
  /** Exact reviewed field to focus when resuming. The field name is safe
   *  continuity metadata; no field value is ever carried with it. */
  resumeFieldKey: string | null;
}

export const initialConnectionsSetupGuideState = (): ConnectionsSetupGuideState => ({
  stage: 'closed',
  targetUrl: '',
  preview: null,
  result: null,
  error: null,
  resumeAvailable: false,
  resumeFieldKey: null,
});

/** Mirrors the server's closed field-key vocabulary. Only keys are sent; labels
 *  in the privacy preview come from the live local schema and are NOT egress. */
const GUIDE_FIELD_KEYS = new Set<string>([
  'name',
  'display_name',
  'config.base_url',
  'subresource_path',
  'auth.type',
  'auth.token',
  'auth.username',
  'auth.password',
  'auth.headers',
  'auth.param_name',
  'auth.value',
  'auth.refresh_token',
  'auth.client_id',
  'auth.client_secret',
  'auth.token_endpoint',
  'auth.identifier',
  'auth.app_password',
  'auth.scope',
  'auth.authorize_url',
  'auth.scopes',
]);

const AUTH_TYPES = new Set<string>(CONNECTION_AUTH_TYPES);
const MAX_TARGET_URL = 2_048;


export type CanonicalConnectionSetupGuideUrl =
  | { ok: true; url: string }
  | { ok: false; error: string };

/** Client-side twin of the server gate so the review step shows the exact URL
 *  that will leave the server. The server repeats every check authoritatively. */
export const canonicalizeConnectionSetupGuideUrl = (
  raw: string,
): CanonicalConnectionSetupGuideUrl => {
  const input = raw.trim();
  if (input.length === 0) {
    return {
      ok: false,
      error: 'Type the service’s address, or its developer page, and Recued will write you a guide.',
    };
  }
  if (input.length > MAX_TARGET_URL) {
    return { ok: false, error: 'The provider URL is too long.' };
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return {
      ok: false,
      error: 'Type the whole address, starting with https, like https://developer.example.com.',
    };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'The provider URL must use HTTPS.' };
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return {
      ok: false,
      error: 'Take the username and password out of that address.',
    };
  }
  if (isPrivateHost(parsed.hostname)) {
    return {
      ok: false,
      error: 'Use a public address, not one on your own network.',
    };
  }
  parsed.search = '';
  parsed.hash = '';
  const url = parsed.toString();
  return url.length <= MAX_TARGET_URL
    ? { ok: true, url }
    : { ok: false, error: 'The provider URL is too long.' };
};

export type BuildConnectionSetupGuidePreviewResult =
  | { ok: true; preview: ConnectionSetupGuidePreview }
  | { ok: false; error: string };

export const buildConnectionSetupGuidePreview = (
  schema: ConnectionSchema,
  values: ConnectionFormValues,
  rawTargetUrl: string,
): BuildConnectionSetupGuidePreviewResult => {
  const canonical = canonicalizeConnectionSetupGuideUrl(rawTargetUrl);
  if (!canonical.ok) return canonical;
  const rawAuthType = values['auth.type'];
  if (typeof rawAuthType !== 'string' || !AUTH_TYPES.has(rawAuthType)) {
    return { ok: false, error: 'Choose an authentication method first.' };
  }
  const visible_fields = schema.fields
    .filter((field) => !field.hidden)
    .filter((field) => field.showWhen?.(values) ?? true)
    .filter((field) => GUIDE_FIELD_KEYS.has(field.key))
    .map((field) => ({ key: field.key, label: field.label }));
  if (visible_fields.length === 0) {
    return { ok: false, error: 'No visible setup fields are available to describe.' };
  }
  return {
    ok: true,
    preview: {
      target_url: canonical.url,
      auth_type: rawAuthType as ConnectionSetupGuideAuthType,
      field_keys: visible_fields.map((field) => field.key),
      visible_fields,
    },
  };
};

export const connectionSetupGuideContextsMatch = (
  expected: ConnectionSetupGuideRequest,
  actual: ConnectionSetupGuideRequest,
): boolean => expected.target_url === actual.target_url
  && expected.auth_type === actual.auth_type
  && expected.field_keys.length === actual.field_keys.length
  && expected.field_keys.every((key, index) => actual.field_keys[index] === key);

/** AI may explain every reviewed field, but the form handoff can transfer only
 *  this narrow set of non-secret, non-identity values. Provider-issued client
 *  IDs remain manual even though they are not secret: the model never saw the
 *  provider app and therefore cannot be their source of truth.
 *
 *  D-223 — the key sets and `canApplyConnectionSetupGuideSuggestion` now live in
 *  `@recued/contracts` and are re-exported above, so the pack-manifest validator
 *  applies the SAME gate to a publisher's declared hints. */

export type ConnectionSetupGuideReturnTarget =
  | { kind: 'field'; fieldKey: string }
  | { kind: 'authorize' }
  | { kind: 'submit' };

/** Pick the next useful control after the owner returns from creating a
 *  provider app. This is derived from the live schema instead of a generic
 *  OAuth field list so hidden/fixed vendor fields are never targeted. */
export const connectionSetupGuideReturnTarget = (
  schema: ConnectionSchema,
  values: ConnectionFormValues,
): ConnectionSetupGuideReturnTarget | null => {
  const authType = values['auth.type'];
  if (authType !== 'oauth2_refresh' && authType !== 'oauth2_client_credentials') {
    return null;
  }
  const priority = authType === 'oauth2_refresh'
    ? [
        'auth.client_id',
        'auth.client_secret',
        'auth.token_endpoint',
        'auth.authorize_url',
      ]
    : [
        'auth.client_id',
        'auth.client_secret',
        'auth.token_endpoint',
      ];
  for (const fieldKey of priority) {
    const field = schema.fields.find((candidate) =>
      candidate.key === fieldKey
      && !candidate.hidden
      && !candidate.readonly
      && (candidate.showWhen?.(values) ?? true));
    if (
      field === undefined
      || (field.optional && field.key !== 'auth.authorize_url')
      || (values[fieldKey] ?? '').trim().length > 0
    ) continue;
    return { kind: 'field', fieldKey };
  }
  if (authType === 'oauth2_refresh') return { kind: 'authorize' };
  // Client credentials has no separate authorization step. Do not send the
  // owner to a disabled Save button while a required connection-identity or
  // endpoint field is still empty.
  const missingRequired = schema.fields.find((field) =>
    !field.hidden
    && !field.readonly
    && !field.optional
    && (field.showWhen?.(values) ?? true)
    && (values[field.key] ?? '').trim().length === 0);
  return missingRequired === undefined
    ? { kind: 'submit' }
    : { kind: 'field', fieldKey: missingRequired.key };
};
