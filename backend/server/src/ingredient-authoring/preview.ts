/** D-170 N.4 — test-before-save preview of a composition operation.
 *
 *  `ingredient.preview` runs ONE operation of an in-progress draft through the
 *  REAL gateway connection adapter so the author can confirm a read works (and
 *  review the redacted request target + auth source for any operation) BEFORE
 *  committing the draft → installed transition (N.4). It is non-persisting
 *  (no audit row, no draft mutation, no stored sample — R14), redacted (no
 *  secret value ever leaves the store), and bounded (output capped to
 *  `INGREDIENT_PREVIEW_MAX_OUTPUT_BYTES`).
 *
 *  ── Safety model: preview NEVER executes a write blindly ──
 *
 *  The load-bearing invariant. The risk tier comes from the operation's own
 *  declaration (the same `OperationRow.risk_tier` the gateway resolves), and
 *  the injected `execute` seam — the real connection adapter — is reached on
 *  EXACTLY ONE code path, lexically inside the `risk_tier === 'read'` branch.
 *  Every mutation (`write` / `admin` / `destructive`) returns
 *  `{ executed: false, reason: 'mutation' }` with the redacted request plan +
 *  risk/approval summary, and `execute` is never called. A read that cannot be
 *  safely dispatched (connector surface, realtime binding, unenrolled
 *  connection, no execution seam) also degrades to a non-executing plan with
 *  an honest reason — it never falls back to executing a different operation.
 *
 *  The preview builds the connection-api wire params from the operation's
 *  binding exactly as `packages/engine/src/catalog-gateway.ts`
 *  (`buildApiDispatchInput` / `buildGraphqlDispatchInput`) does for live
 *  dispatch — the binding owns method/path (Invariant 4), caller `args` carry
 *  only the per-call payload + path params, engine-locked keys are stripped,
 *  and `static_query` / `static_headers` fold authoritatively. So a previewed
 *  read is the same call the installed catalog would make.
 *
 *  Spec: D-170 § N.4 (test-before-save), N.15 (server-side rpc,
 *  "preview runs through the real gateway connection adapter"). */

import {
  isLockedInputKey,
  walkPath,
  INGREDIENT_PREVIEW_MAX_OUTPUT_BYTES,
  type ApiExecutionBinding,
  type McpExecutionBinding,
  type CompositionAuthModel,
  type CompositionIngredient,
  type CompositionSurface,
  type ConnectionKind,
  type ConnectionRow,
  type ConnectorExecutionBinding,
  type IngredientEntityField,
  type IngredientRow,
  type GraphQLExecutionBinding,
  type IngredientPreviewArgs,
  type IngredientPreviewExecution,
  type IngredientPreviewFieldMapping,
  type IngredientPreviewResult,
  type IngredientPreviewTarget,
  type OperationApproval,
  type OperationRiskTier,
  type PackOperationRow,
  type RestExecutionBinding,
  truncateUtf8WithMarker,
} from '@recued/contracts';
import type { ResolvedCall } from '@recued/ingredients';
import type { DraftStore } from './draft-store.js';

export interface IngredientPreviewDeps {
  /** The per-pair draft store — `get(draft_id)` resolves the composition. */
  draftStore: Pick<DraftStore, 'get'>;
  /** Resolve an enrolled api connection row (for the redacted base_url + the
   *  enrolled check). Optional — absent → reads degrade to `no_connection`.
   *  The same `.get(kind, name)` seam the connection adapter uses. */
  connectionLookup?: (
    kind: ConnectionKind,
    name: string,
  ) => ConnectionRow | null | Promise<ConnectionRow | null>;
  /** Execute a READ through the real connection adapter. Optional — absent →
   *  reads degrade to `preview_unavailable`. NEVER invoked for a mutation:
   *  the risk gate is upstream of every call site (see the file header). */
  execute?: (call: ResolvedCall) => Promise<unknown>;
}

// ───────────────────────── redaction + bounding ─────────────────────────
//
// Preview redaction is deliberately CONSERVATIVE — it over-redacts rather than
// risk leaking a credential into an authoring surface. Any object key (or URL
// query param name) that LOOKS auth-related is masked; a read response should
// not carry secrets, but a misconfigured endpoint echoing headers / tokens
// must never surface one here.

const AUTH_LIKE_SUBSTRINGS = [
  'authorization',
  'secret',
  'password',
  'passwd',
  'token',
  'api_key',
  'apikey',
  'x-api-key',
  'private_key',
  'credential',
  'cookie',
  'bearer',
  'signature',
];
const AUTH_LIKE_EXACT = new Set(['auth', 'pwd', 'session', 'sig', 'key']);

const isAuthLikeKey = (key: string): boolean => {
  const k = key.toLowerCase();
  if (AUTH_LIKE_EXACT.has(k)) return true;
  return AUTH_LIKE_SUBSTRINGS.some((p) => k.includes(p));
};

const REDACTED = '[redacted]';
const MAX_DEPTH = 6;
const MAX_ARRAY = 50;
const MAX_KEYS = 100;
const MAX_STRING = 1024;
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Redact a fully-resolved URL for display: strip userinfo + mask any
 *  auth-like query parameter VALUE. Falls back to the raw string when it
 *  doesn't parse (still length-bounded). */
const redactUrl = (raw: string): string => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw.length > MAX_STRING ? `${raw.slice(0, MAX_STRING)}…` : raw;
  }
  url.username = '';
  url.password = '';
  for (const key of [...url.searchParams.keys()]) {
    if (isAuthLikeKey(key)) url.searchParams.set(key, REDACTED);
  }
  const out = url.toString();
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…` : out;
};

/** Alternation of auth-like key fragments for the value/message redactor.
 *  Matches underscored compounds (`access_token`, `client_secret`,
 *  `refresh-token`) the object-key detector catches but a `\bword\b` regex
 *  would miss (no word boundary inside `access_token`). */
const AUTH_KEY_FRAGMENT =
  '(?:authorization|secret|password|passwd|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|credentials?|cookie|bearer|signature|token)';
// Hoisted (compiled once) — `String.replace` resets a global regex's lastIndex,
// so reuse across calls is safe.
const URL_RE = /https?:\/\/[^\s'"<>]+/gi;
const BEARER_RE = /\bBearer\s+[\w.\-+/=]+/gi;
// HEADER-style auth values are MULTI-token (`Authorization: Basic <b64>`,
// `Cookie: a=b; c=d`) — a single-token matcher would leave the credential after
// the scheme. Consume the whole value to a structural delimiter (newline /
// quote / JSON brace/bracket), keeping only the header name.
const AUTH_HEADER_RE =
  /\b(authorization|proxy-authorization|cookie|set-cookie)\b\s*[:=]\s*[^\n\r"'}\]]+/gi;
// KV-style values (`access_token=…&x=y`, `token: abc`), including the JSON /
// log forms where the key and/or value are QUOTED (`"access_token":"LEAK"`,
// `client_secret: "LEAK"`) — the key's optional surrounding quotes and a value's
// optional opening quote are consumed so the secret token is masked even in a
// text/plain body or a stringified-JSON leaf.
const AUTH_KV_RE = new RegExp(
  `(["']?[\\w.\\-]*${AUTH_KEY_FRAGMENT}[\\w.\\-]*["']?)\\s*[:=]\\s*["']?[^\\s,&;"'}\\]]+`,
  'gi',
);

/** Scrub secret fragments out of an arbitrary string VALUE — embedded http(s)
 *  URLs (via `redactUrl`), full `Authorization` / `Cookie` header values (any
 *  scheme — Basic / Bearer / Digest), bare `Bearer <token>`, and any
 *  `<auth-key>=<value>` / `<auth-key>: <value>` fragment (incl. underscored
 *  compounds like `access_token` / `client_secret`). Applied to every
 *  executed-read output string + error message + the final request target, so a
 *  credential echoed in a benign-keyed field, a text body, an array element, or
 *  typed into connector argv is masked even though no object key names it.
 *  Length-bounded by the callers.
 *
 *  Best-effort boundary (a blocklist can't be exhaustive): an UNLABELED
 *  high-entropy secret (a bare `sk-…` with no key / scheme / pattern), or a
 *  secret hidden URL-ENCODED inside an unrelated value (`q=client_secret%3D…`),
 *  is not caught. The realistic surfaces — object keys, auth schemes, and
 *  labeled `key[:=]value` fragments (quoted or not) — are covered, and the
 *  module over-redacts rather than under-redacts everywhere it can. */
const redactSecretsInString = (s: string): string =>
  s
    .replace(URL_RE, (u) => redactUrl(u))
    .replace(AUTH_HEADER_RE, '$1=[redacted]')
    .replace(BEARER_RE, 'Bearer [redacted]')
    .replace(AUTH_KV_RE, '$1=[redacted]');

/** Redact a message string for an executed-read error. */
const redactMessage = (message: string): string =>
  redactSecretsInString(message).slice(0, MAX_STRING);

/** One bounded + redacted pass over an arbitrary JSON value. Sets `truncated`
 *  (via the captured flag) whenever any bound clipped the input, so the caller
 *  can flag the preview honestly. Redacts at TWO levels: an auth-like object
 *  KEY masks its whole value, and every string LEAF is scrubbed for embedded
 *  secret fragments (`redactSecretsInString`) so a token under a benign key
 *  (`{ echo: 'Authorization: Bearer …' }`) or in a bare string / array element
 *  can't surface. */
const boundAndRedactInto = (
  value: unknown,
  depth: number,
  flag: { truncated: boolean },
): unknown => {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') {
      const redacted = redactSecretsInString(value);
      if (redacted.length > MAX_STRING) {
        flag.truncated = true;
        return `${redacted.slice(0, MAX_STRING)}…`;
      }
      return redacted;
    }
    return value;
  }
  if (depth >= MAX_DEPTH) {
    flag.truncated = true;
    return Array.isArray(value) ? '[truncated:array]' : '[truncated:object]';
  }
  if (Array.isArray(value)) {
    const slice = value.length > MAX_ARRAY ? value.slice(0, MAX_ARRAY) : value;
    if (value.length > MAX_ARRAY) flag.truncated = true;
    return slice.map((v) => boundAndRedactInto(v, depth + 1, flag));
  }
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  const kept = entries.length > MAX_KEYS ? entries.slice(0, MAX_KEYS) : entries;
  if (entries.length > MAX_KEYS) flag.truncated = true;
  for (const [k, v] of kept) {
    if (PROTO_KEYS.has(k)) continue;
    out[k] = isAuthLikeKey(k) ? REDACTED : boundAndRedactInto(v, depth + 1, flag);
  }
  return out;
};

/** Bound + redact a value, then enforce the serialized byte cap as a backstop
 *  (the structural bounds keep most payloads well under it; a pathologically
 *  wide-but-shallow value is clipped to a string preview). */
const boundAndRedact = (value: unknown): { value: unknown; truncated: boolean } => {
  const flag = { truncated: false };
  const bounded = boundAndRedactInto(value, 0, flag);
  let serialized: string;
  try {
    serialized = JSON.stringify(bounded ?? null);
  } catch {
    return { value: '[unserializable]', truncated: true };
  }
  if (Buffer.byteLength(serialized, 'utf8') > INGREDIENT_PREVIEW_MAX_OUTPUT_BYTES) {
    return {
      // ⛔ `slice` on a BYTE cap, plus a 3-byte `…` added on top of a budget
      //   that was already spent — over by 3 on ASCII, by 3x on CJK.
      value: truncateUtf8WithMarker(serialized, INGREDIENT_PREVIEW_MAX_OUTPUT_BYTES),
      truncated: true,
    };
  }
  return { value: bounded, truncated: flag.truncated };
};

// ───────────────────────── wire construction ─────────────────────────
//
// Mirrors `packages/engine/src/catalog-gateway.ts` so a previewed read is the
// SAME call the installed catalog would dispatch. The binding owns method /
// path / connection (Invariant 4); caller args carry per-call payload + path
// params; engine-locked keys (method / url / header.authorization / .cookie /
// .host) are stripped from args via the shared `isLockedInputKey`.

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/** REST binding + caller args → connection-api wire input (mirrors
 *  `buildApiDispatchInput`). */
const buildRestWireInput = (
  binding: RestExecutionBinding,
  args: Record<string, unknown>,
  connectionName: string,
): Record<string, unknown> => {
  const input: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (PROTO_KEYS.has(k) || isLockedInputKey(k.trim().toLowerCase())) continue;
    input[k] = v;
  }
  for (const [k, v] of Object.entries(binding.static_query ?? {})) {
    input[`query.${k}`] = v;
  }
  for (const [k, v] of Object.entries(binding.static_headers ?? {})) {
    if (isLockedInputKey(`header.${k.trim().toLowerCase()}`)) continue;
    input[`header.${k}`] = v;
  }
  input.method = binding.method;
  input.path = binding.path_template;
  input.connection_kind = 'api';
  if (connectionName) input.connection = connectionName;
  return input;
};

/** GraphQL (query/mutation) binding + caller args → connection-api wire input
 *  (mirrors `buildGraphqlDispatchInput`). */
const buildGraphqlWireInput = (
  binding: GraphQLExecutionBinding,
  args: Record<string, unknown>,
  connectionName: string,
): Record<string, unknown> => {
  const input: Record<string, unknown> = {};
  input.method = 'POST';
  input.path = binding.endpoint_path;
  input['body.query'] = binding.query;
  input['body.variables'] = args;
  input.connection_kind = 'api';
  if (connectionName) input.connection = connectionName;
  return input;
};

/** Binding classification keyed on the ACTUAL request shape, NOT the declared
 *  `risk_tier`. This is the load-bearing half of the safety invariant: a draft
 *  is unvalidated, so an author (or attacker) can label a `DELETE` /
 *  `mutation` operation `risk_tier: 'read'`. The preview must decide what to
 *  execute from the BINDING, never from the tier alone — only `rest_read`
 *  (GET/HEAD) and `graphql_query` are ever dispatched; `rest_write` /
 *  `graphql_mutation` are treated as mutations and never run. */
type BindingClass =
  | 'rest_read'
  | 'rest_write'
  | 'graphql_query'
  | 'graphql_mutation'
  | 'connector'
  // D-225 Slice 1 — its OWN class, not folded into `realtime`. An mcp binding
  // is a one-shot request, so calling it a subscription would be false; and it
  // is not previewable for a reason the other classes don't share — a tool name
  // carries no read/write signal (see `validateApiBindingRiskConsistency`), so
  // the preview cannot establish that dispatching it is safe. Non-dispatchable
  // for a stated reason beats non-dispatchable under a wrong label.
  | 'mcp'
  | 'realtime';

/** The only HTTP methods a preview will ever dispatch — RFC-safe / read-only.
 *  Everything else mutates and is gated out before `execute`. */
const SAFE_PREVIEW_METHODS = new Set(['GET', 'HEAD']);

const classifyBinding = (
  binding: ApiExecutionBinding | ConnectorExecutionBinding,
): BindingClass => {
  if (binding.kind === 'rest') {
    return SAFE_PREVIEW_METHODS.has(String(binding.method).toUpperCase())
      ? 'rest_read'
      : 'rest_write';
  }
  if (binding.kind === 'graphql') {
    return binding.operation_type === 'query'
      ? 'graphql_query'
      : binding.operation_type === 'mutation'
        ? 'graphql_mutation'
        : 'realtime'; // subscription — needs a stream substrate, not a one-shot
  }
  if (binding.kind === 'mcp') return 'mcp';
  if (binding.kind === 'method_call' || binding.kind === 'cli_invocation') return 'connector';
  // webhook_subscription / queue_subscription / push_channel — realtime, not a
  // one-shot request the preview can dispatch.
  return 'realtime';
};

/** Safe `base_url` read off a connection row's `config_json` (non-throwing —
 *  a malformed config yields undefined, and the redacted target falls back to
 *  the bare path). */
const resolveBaseUrl = (record: ConnectionRow | null): string | undefined => {
  if (!record) return undefined;
  try {
    const config = JSON.parse(record.config_json) as Record<string, unknown> | null;
    const base = config?.base_url;
    return typeof base === 'string' && base.trim() !== '' ? base : undefined;
  } catch {
    return undefined;
  }
};

/** Best-effort `{{ref}}` → value interpolation for the DISPLAY path only (the
 *  adapter re-interpolates safely for an executed read; this is presentation).
 *  An unsupplied ref is left as its literal marker, like the live adapter; an
 *  auth-like ref name (`{{api_key}}`, `{{token}}`) is masked so a secret path
 *  param never lands in the redacted target. */
const interpolatePathForDisplay = (
  template: string,
  args: Record<string, unknown>,
): string =>
  template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, ref: string) => {
    const v = args[ref];
    if (v === undefined || v === null) return whole;
    if (isAuthLikeKey(ref)) return REDACTED;
    return encodeURIComponent(String(v));
  });

/** Build the redacted request descriptor for an api operation. */
const apiRequestDescriptor = (
  binding: RestExecutionBinding | GraphQLExecutionBinding,
  args: Record<string, unknown>,
  baseUrl: string | undefined,
): { verb: string; request: string } => {
  if (binding.kind === 'graphql') {
    const where = baseUrl
      ? redactUrl(safeJoin(baseUrl, binding.endpoint_path))
      : binding.endpoint_path;
    return { verb: 'POST', request: `POST ${where} (graphql ${binding.operation_type})` };
  }
  const path = interpolatePathForDisplay(binding.path_template, args);
  // Compose the query string from static_query + caller `query.*` args, masking
  // auth-like param VALUES at build time so EVERY return branch below (base-url,
  // no-base-url, and the catch) is pre-redacted — `redactUrl` on the base-url
  // branch is then a second line of defense, not the only one.
  const query = new URLSearchParams();
  const appendQuery = (name: string, raw: unknown): void => {
    query.append(name, isAuthLikeKey(name) ? REDACTED : String(raw));
  };
  for (const [k, v] of Object.entries(binding.static_query ?? {})) appendQuery(k, v);
  for (const [k, v] of Object.entries(args)) {
    if (k.startsWith('query.') && v != null) appendQuery(k.slice('query.'.length), v);
  }
  const qs = query.toString();
  if (baseUrl) {
    let url: string;
    try {
      const u = new URL(path, baseUrl);
      if (qs) u.search = u.search ? `${u.search}&${qs}` : `?${qs}`;
      url = redactUrl(u.toString());
    } catch {
      url = `${path}${qs ? `?${qs}` : ''}`;
    }
    return { verb: binding.method, request: `${binding.method} ${url}` };
  }
  const bare = `${path}${qs ? `?${qs}` : ''} (base_url unresolved — connection not enrolled)`;
  return { verb: binding.method, request: `${binding.method} ${bare}` };
};

const safeJoin = (base: string, path: string): string => {
  try {
    return new URL(path, base).toString();
  } catch {
    return path;
  }
};

/** Redacted request descriptor for a connector operation (no api dispatch). */
const connectorRequestDescriptor = (
  binding: ConnectorExecutionBinding,
): { verb: string; request: string } => {
  if (binding.kind === 'cli_invocation') {
    const argv = binding.argv_template;
    const detached = binding.detached
      ? ` (detached ${binding.detached.completion.kind})`
      : '';
    const argvTokenText = (entry: typeof argv[number]): string =>
      typeof entry === 'string' ? entry : `{${entry.expand_arg}...}`;
    const verb = typeof argv[0] === 'string' ? argv[0] : 'cli';
    return { verb, request: `${argv.map(argvTokenText).join(' ')}${detached}` };
  }
  return { verb: binding.method_name, request: `call ${binding.method_name}` };
};

/** Descriptor for a realtime api binding (graphql subscription / webhook /
 *  queue / push) — described, never dispatched (no one-shot request shape). */
const realtimeRequestDescriptor = (
  binding: ApiExecutionBinding,
): { verb: string; request: string } => ({
  verb: binding.kind,
  request: `${binding.kind} (realtime subscription — not previewable)`,
});

/** D-225 Slice 1 — descriptor for an mcp binding. Described, never dispatched:
 *  the reason is NOT that it lacks a one-shot shape (it has one) but that a
 *  tool name carries no read/write signal, so a preview cannot establish the
 *  call is safe to make. Says exactly that rather than borrowing the realtime
 *  wording, which would be false. */
const mcpRequestDescriptor = (
  binding: McpExecutionBinding,
): { verb: string; request: string } => ({
  verb: 'tools/call',
  request: `tools/call ${binding.tool} (mcp — not previewable: a tool name carries no read/write signal)`,
});

// ───────────────────────── mapping preview ─────────────────────────

const appliesToResponse = (field: IngredientEntityField): boolean =>
  field.applies !== 'request' && field.applies !== 'req';

/** True when a mapped field's SOURCE or DESTINATION names a secret — any
 *  segment of `maps_to` (`result.access_token`, `headers.Authorization`) or the
 *  entity `field_path` (`token`) is auth-like. The sampled VALUE is a primitive
 *  with no key context, so `boundAndRedact` alone (which keys off object keys)
 *  would return it raw — this path-level check is what masks it. */
const mappingSampleIsAuthLike = (field: IngredientEntityField): boolean =>
  field.maps_to.split('.').some(isAuthLikeKey)
  || field.field_path.split('.').some(isAuthLikeKey);

/** All of a composition's vendor-surface fields, flattened across every
 *  ingredient's nested `entities` map. */
const allCompositionFields = (composition: CompositionIngredient): IngredientEntityField[] =>
  (composition.ingredients ?? []).flatMap((ing) =>
    Object.values(ing.entities ?? {}).flatMap((entity) => entity.fields));

/** The Table-A ingredient an operation joins to (`op.ingredient`), falling back
 *  to the primary ingredient for a malformed draft. */
const ingredientForOp = (
  composition: CompositionIngredient,
  op: PackOperationRow,
): IngredientRow | undefined =>
  composition.ingredients?.find((ing) => ing.slug === op.ingredient) ?? composition.ingredients?.[0];

const ingredientConnectionName = (ingredient: IngredientRow | undefined): string | null =>
  ingredient?.http?.connection ?? ingredient?.connection?.connection ?? null;

/** Response→field mappings for one operation: response-applicable entity
 *  fields scoped to this operation (or unscoped). `sample` is filled only when
 *  a live response is supplied (executed read). */
const buildMappingPreview = (
  composition: CompositionIngredient,
  operationKey: string,
  response: unknown | undefined,
): IngredientPreviewFieldMapping[] =>
  allCompositionFields(composition)
    .filter(
      (field) =>
        appliesToResponse(field)
        && (field.source_operation === undefined || field.source_operation === operationKey),
    )
    .map((field) => {
      const base: IngredientPreviewFieldMapping = {
        entity_field: field.field_path,
        source_path: field.maps_to,
        type: field.type,
      };
      if (response === undefined) return base;
      // An auth-like source/destination → mask the primitive sample (the value
      // has no key context for `boundAndRedact` to catch). `maps_to` is rooted
      // at the connection-api raw shape `{status, headers, result}` (decomposer
      // `fieldOutput` convention) — walk over the full response so a `result.*`
      // path resolves.
      const sample = mappingSampleIsAuthLike(field)
        ? REDACTED
        : boundAndRedact(walkPath(response, field.maps_to)).value;
      return { ...base, sample };
    });

// ───────────────────────── the preview itself ─────────────────────────

const isCompositionLike = (body: unknown): body is CompositionIngredient =>
  body !== null
  && typeof body === 'object'
  && !Array.isArray(body)
  && Array.isArray((body as Record<string, unknown>).operations);

const authModelOf = (composition: CompositionIngredient): CompositionAuthModel =>
  composition.ingredients?.[0]?.kind === 'cli' ? 'cli_delegated' : 'recued_injected';

/** The coarse surface label for an operation — derived from its ingredient's
 *  kind (`cli` lowers to connector; `http` / `connection` to api). */
const surfaceOf = (ingredient: IngredientRow | undefined): CompositionSurface =>
  ingredient?.kind === 'cli' ? 'connector' : 'api';

export const runIngredientPreview = async (
  deps: IngredientPreviewDeps,
  args: IngredientPreviewArgs,
): Promise<IngredientPreviewResult> => {
  const draftId = args?.draft_id;
  const operationKey = args?.operation_key;
  if (typeof draftId !== 'string' || draftId === '' || typeof operationKey !== 'string' || operationKey === '') {
    return { ok: false, code: 'bad_request', message: 'ingredient.preview: draft_id and operation_key are required' };
  }

  const draft = deps.draftStore.get(draftId);
  if (!draft) {
    return { ok: false, code: 'draft_not_found', message: `no draft '${draftId}'` };
  }
  if (!isCompositionLike(draft.body)) {
    return { ok: false, code: 'invalid_draft', message: `draft '${draftId}' body is not a previewable composition (no operations)` };
  }
  const composition = draft.body;
  const row = composition.operations.find((r) => r?.op === operationKey);
  if (!row) {
    return { ok: false, code: 'operation_not_found', message: `operation '${operationKey}' not found in draft '${draftId}'` };
  }
  const ingredient = ingredientForOp(composition, row);

  const riskTier: OperationRiskTier = row.risk;
  const approval: OperationApproval = row.approval;
  const surface = surfaceOf(ingredient);
  const binding = row.bind as unknown as ApiExecutionBinding | ConnectorExecutionBinding;
  const bindingClass = classifyBinding(binding);
  const connectionName = ingredientConnectionName(ingredient);
  const isApiBinding = binding.kind === 'rest' || binding.kind === 'graphql';

  // Resolve the enrolled connection (api bindings only — connector has no
  // adapter path) for the redacted base_url + the enrolled check.
  const record =
    isApiBinding && connectionName && deps.connectionLookup
      ? await deps.connectionLookup('api', connectionName)
      : null;
  const baseUrl = resolveBaseUrl(record);

  const callerArgs = asRecord(args.args);
  const descriptor =
    binding.kind === 'rest' || binding.kind === 'graphql'
      ? apiRequestDescriptor(binding, callerArgs, baseUrl)
      : binding.kind === 'mcp'
      ? mcpRequestDescriptor(binding)
      : binding.kind === 'cli_invocation' || binding.kind === 'method_call'
        ? connectorRequestDescriptor(binding)
        : realtimeRequestDescriptor(binding);

  const target: IngredientPreviewTarget = {
    surface,
    verb: descriptor.verb,
    // Final belt-and-suspenders scrub over EVERY descriptor path (api / connector
    // argv / realtime) so a secret an author typed into a binding can't surface
    // in the displayed target.
    request: redactSecretsInString(descriptor.request),
    auth: {
      model: authModelOf(composition),
      connection: connectionName,
      connection_enrolled: record !== null,
    },
  };

  const execution = await decideExecution({
    deps,
    composition,
    operationKey,
    riskTier,
    bindingClass,
    binding,
    callerArgs,
    connectionName,
    connectionEnrolled: record !== null,
  });

  return { ok: true, operation_key: operationKey, risk_tier: riskTier, approval, target, execution };
};

interface ExecutionDecision {
  deps: IngredientPreviewDeps;
  composition: CompositionIngredient;
  operationKey: string;
  riskTier: OperationRiskTier;
  bindingClass: BindingClass;
  binding: ApiExecutionBinding | ConnectorExecutionBinding;
  callerArgs: Record<string, unknown>;
  connectionName: string | null;
  connectionEnrolled: boolean;
}

/** The risk-gated execution decision. `execute` is called on EXACTLY ONE path,
 *  reached only for a `rest_read` / `graphql_query` binding whose declared tier
 *  is also `read` — so a mutation can never reach it. The gate keys on the
 *  BINDING shape, not the declared tier alone: a draft that labels a `DELETE` /
 *  `mutation` operation `risk_tier: 'read'` (drafts are unvalidated) is still
 *  refused, because `rest_write` / `graphql_mutation` map to `reason:
 *  'mutation'` regardless of the tier (the test-before-save invariant: a
 *  preview never performs a blind write). */
const decideExecution = async (d: ExecutionDecision): Promise<IngredientPreviewExecution> => {
  // ── SAFETY GATE 1 ── a declared mutation is NEVER executed.
  if (d.riskTier !== 'read') {
    return { executed: false, reason: 'mutation' };
  }
  // ── SAFETY GATE 2 ── a MUTATING binding is NEVER executed, even if the draft
  // mislabels its tier `read`. Connector / realtime degrade honestly; neither
  // falls through to executing some other shape.
  switch (d.bindingClass) {
    case 'connector':
      return { executed: false, reason: 'connector_surface' };
    case 'rest_write':
    case 'graphql_mutation':
      return { executed: false, reason: 'mutation' };
    case 'mcp':
    case 'realtime':
      return { executed: false, reason: 'unsupported_binding' };
    case 'rest_read':
    case 'graphql_query':
      break; // the only executable shapes — fall through to the connection gates
  }
  if (!d.connectionEnrolled || !d.connectionName) {
    return { executed: false, reason: 'no_connection' };
  }
  if (!d.deps.execute) {
    return { executed: false, reason: 'preview_unavailable' };
  }

  // Belt-and-suspenders: only a safe read shape can build wire input + dispatch.
  // (Unreachable given the switch above — a defensive backstop against a future
  // refactor that loosens the gate.)
  if (d.bindingClass !== 'rest_read' && d.bindingClass !== 'graphql_query') {
    return { executed: false, reason: 'mutation' };
  }
  const input =
    d.bindingClass === 'rest_read'
      ? buildRestWireInput(d.binding as RestExecutionBinding, d.callerArgs, d.connectionName)
      : buildGraphqlWireInput(d.binding as GraphQLExecutionBinding, d.callerArgs, d.connectionName);

  // Empty `output` → the adapter returns the raw `{status, headers, result}`
  // shape; the preview maps + bounds it itself.
  const call: ResolvedCall = {
    slug: d.composition.slug,
    risk_tier: 'read',
    input,
    output: {},
  };

  try {
    const raw = await d.deps.execute(call);
    const rawObj = asRecord(raw);
    const status = typeof rawObj.status === 'number' ? rawObj.status : undefined;
    const body = 'result' in rawObj ? rawObj.result : raw;
    const { value: outputPreview, truncated } = boundAndRedact(body);
    return {
      executed: true,
      outcome: 'ok',
      ...(status !== undefined ? { status } : {}),
      output_preview: outputPreview,
      truncated,
      mapping_preview: buildMappingPreview(d.composition, d.operationKey, raw),
    };
  } catch (e) {
    const code = typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : 'PREVIEW_FAILED';
    const message = e instanceof Error ? e.message : String(e);
    return { executed: true, outcome: 'error', error: { code, message: redactMessage(message) } };
  }
};
