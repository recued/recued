/** D-125 Phase 4.1 — `connection.api` per-kind handler.
 *
 *  First per-kind handler under the `connection` adapter (P3.1 shell,
 *  P3.2 audit emission, P3.3 gate verification). Implements the
 *  HTTP transport for `kind: 'connection' + connection_kind: 'api'`
 *  ingredients, replacing the P3.1 placeholder that surfaces
 *  `INGREDIENT_ADAPTER_ALL_FAILED` with `kind: 'connection.api'`.
 *
 *  Wire shape (spec § 4.1):
 *
 *    Input — `params` after the shell strips `connection_kind` +
 *    `connection`. Dot-prefix keys decompose into structured wire
 *    pieces; flat keys are reserved for the discriminants and never
 *    reach this handler:
 *      - method: HTTP method ('GET' | 'POST' | 'PUT' | 'PATCH' |
 *        'DELETE' | 'HEAD' | 'OPTIONS'). Required.
 *      - path: appended to `record.config.base_url` via
 *        `new URL(path, base_url)`. Required.
 *      - query.<k>: query string parameters (auth-free).
 *      - header.<k>: request headers (auth-free; Authorization /
 *        custom auth header injected after input validation, so a
 *        recipe author can't accidentally exfiltrate the token via
 *        `{{step.<id>.headers.authorization}}`).
 *      - body.<k>: structured body fields. They default to JSON; when the
 *        binding pins `Content-Type: application/x-www-form-urlencoded`,
 *        scalar fields (and arrays of scalars) are encoded as form entries.
 *      - body_raw: literal string body. Mutually exclusive with
 *        `body.*` — when both appear, `body_raw` wins.
 *      - timeout_ms: per-call timeout override. Clamped via
 *        `resolveTimeoutMs` to [MIN_TIMEOUT_MS, MAX_TIMEOUT_MS].
 *
 *    Output — the response shape per spec § 4.1:
 *      `{ status: number, headers: Record<string, string>,
 *         result: <parsed body> }`.
 *      Body is JSON-parsed when content-type matches
 *      `application/json`; otherwise text.
 *
 *  Auth injection — the only code path that touches the connection's
 *  decrypted token. `decodeAuth(row)` is called once per dispatch
 *  via the dep injection point; the boot site closes over
 *  `decodeAuthFromStorage` from `backend/server/src/connection-handler.ts`
 *  + the `connection` HKDF sub-DEK. Auth never appears in `headers` /
 *  `query` keys at the input layer.
 *
 *  OAuth2 refresh (per spec § 4.1):
 *    - Triggered when `auth.expires_at` is past or within
 *      `OAUTH2_REFRESH_LEAD_MS` (60s default).
 *    - Single-flight per (kind, name) via in-memory `Map<pk, Promise>`
 *      so a second concurrent call awaits the first's result rather
 *      than racing the token endpoint.
 *    - Persists the new `current_access_token` + `expires_at` (and
 *      rotated `refresh_token` if the issuer returned one) via
 *      `persistAuth(row, newAuth)` — boot site re-encodes the auth
 *      ciphertext and upserts via the connection store.
 *    - Two-device sync races collapse via LWW on `updated_at` per
 *      D-100/101 — one of the two refreshes "wins" and the other's
 *      access token is silently superseded; OAuth2 spec permits the
 *      issuer to revoke the older token, so eventual convergence is
 *      the worst-case.
 *
 *  Bytes telemetry (P4.2 — ctx hook). Reports request body size as
 *  `bytes_out` and response Content-Length / measured body length as
 *  `bytes_in` via `ctx.setBytes`. Both populate the audit emission's
 *  `bytes_in`/`bytes_out` fields; an `undefined` ctx (older test
 *  harnesses) silently no-ops. */

import {
  CONNECTION_API_TIMEOUT_MS,
  OAUTH2_REFRESH_LEAD_MS,
  getVendorProvider,
  isValidOAuthEndpointUrl,
  resolveVendorOAuthRuntimeBase,
  walkPath,
  validateHeaderAuthEntries,
  describeHeaderAuthIssue,
  HTTP_UPLOAD_MAX_BYTES_CEILING,
  HTTP_UPLOAD_WIRE_FIELD_KEY,
  HTTP_UPLOAD_WIRE_KIND_KEY,
  HTTP_UPLOAD_WIRE_MAX_BYTES_KEY,
  CHUNKED_UPLOAD_WIRE_TOKEN_KEY,
  CHUNKED_UPLOAD_WIRE_OFFSET_KEY,
  CHUNKED_UPLOAD_WIRE_LENGTH_KEY,
  CHUNKED_UPLOAD_WIRE_FIELD_KEY,
  CHUNKED_UPLOAD_WIRE_WALK_KEY,
  HTTP_CHUNKED_UPLOAD_MAX_BYTES_CEILING,
} from '@recued/contracts';
import { sha256Hex } from '@recued/crypto/hash';
import type {
  ConnectionAuth,
  ConnectionRow,
  ConnectionVendorProvider,
  VendorOAuthRuntimeBaseResolution,
} from '@recued/contracts';
import {
  encodeMultipart,
  makeBoundary,
  type MultipartField,
  type MultipartFile,
} from './multipart.js';
import type { ConnectionHandlerCtx, ConnectionKindHandler } from './connection.js';
import { IngredientError, type ResolvedCall } from './types.js';
import {
  resolveTimeoutMs,
  isWriteRiskTier,
} from './timeout.js';
import { assertUrlSafe, composeApiUrl, interpolateUrl, UrlRefInvalidError } from './url-template.js';
import { CrossOriginRedirectError, fetchOriginPinned } from './origin-pinned-fetch.js';
import { parseChunkedWalkInput, runChunkedUpload } from './chunked-upload-runner.js';
import {
  discardResponseBody,
  readBoundedResponseBytes,
  readBoundedResponseText,
  ResponseBodyTooLargeError,
} from './bounded-response-body.js';

const ALLOWED_METHODS = new Set([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
]);
const PROTOTYPE_SENSITIVE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const hasOwn = (obj: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

const own = (obj: Record<string, unknown>, key: string): unknown =>
  hasOwn(obj, key) ? obj[key] : undefined;

export interface ConnectionApiHandlerDeps {
  /** Decrypt at-rest `auth_ciphertext` to a typed `ConnectionAuth`.
   *  Boot site closes over `decodeAuthFromStorage` from
   *  `backend/server/src/connection-handler.ts` + the connection
   *  sub-DEK; tests inject a stub returning a synthetic auth. The
   *  handler calls this once per dispatch — auth is never cached
   *  at the handler level so a re-enrollment between calls is
   *  picked up immediately. */
  decodeAuth: (row: ConnectionRow) => Promise<ConnectionAuth>;

  /** D-216 — resolve a `file_ref` to bytes for an upload op. The SAME dep
   *  shape the cli `input_materialize` path uses, and wired from the same
   *  boot site: resolution was already solved, only encoding is new.
   *
   *  ⚠ Takes a REF, never a path. A path parameter here would turn this
   *  handler into an arbitrary-file-read primitive pointed at the network
   *  (D-216 § 5.2). Absent ⇒ an upload op fails closed. */
  readFileBytes?: (
    record_id: string,
  ) => Promise<{ bytes: Uint8Array; mime_type: string; filename: string }>;

  /** D-217 slice 2b-ii — read ONE chunk out of a staged plaintext for a
   *  chunked upload's APPEND.
   *
   *  ⚠ **A separate dep from `readFileBytes` on purpose, and the difference is
   *  the whole point of D-217 slice 0.** `readFileBytes` returns the WHOLE
   *  file; calling it per chunk would decrypt a 512 MB blob 103 times. The
   *  engine stages the plaintext ONCE and the wire carries the resulting
   *  token, so this reads a range out of an already-open, already-verified
   *  handle.
   *
   *  ⚠ Takes a TOKEN, never a path and never a record id — the same
   *  refusal-to-be-a-file-read-primitive `readFileBytes` makes. The token
   *  addresses a handle the engine minted for a walk it is already running;
   *  the adapter cannot open a file of its own. Absent ⇒ a chunked upload
   *  fails closed. */
  readUploadChunk?: (
    token: string,
    offset: number,
    length: number,
  ) => Promise<{ bytes: Uint8Array; mime_type: string }>;

  /** D-217 slice 2b-ii-β2 — stage a warehouse file's plaintext for a chunked
   *  walk, and dispose it after.
   *
   *  ⛔ **Staging happens HERE, below the commit boundary, and that is a
   *  correctness requirement rather than a tidiness one.** The § 8a amendment
   *  first had the ENGINE stage and put the resulting token on the dispatch
   *  input. But the action-identity hash basis covers the full wire input and
   *  drops nothing engine-owned, so a fresh token per attempt yields a fresh
   *  `canonical_payload_hash` and a D-177 session grant can never match an
   *  honest repeat — failing CLOSED, re-asking every upload, which is why
   *  nothing would have surfaced it. The wire names the FILE; this stages it.
   *
   *  🔑 A second reason it belongs here: the owner's DECRYPTED plaintext then
   *  exists only for the walk itself, rather than from input-build time through
   *  hashing, admission and a possible approval hold.
   *
   *  ⚠ **Both halves or neither** — the same rule `ExecutionContext.uploadStaging`
   *  states. A `stage` without a `dispose` leaves that plaintext on disk for the
   *  life of the process, so they are ONE dep. `readUploadChunk` above is the
   *  third leg of the same registry. Absent ⇒ a chunked upload fails closed. */
  uploadStaging?: {
    stage: (input: {
      file_ref: string;
      expect_sha256?: string;
      max_bytes: number;
    }) => Promise<{ token: string; size_bytes: number }>;
    dispose: (token: string) => Promise<void>;
  };

  /** D-218 § 7.5d — a refreshed credential could not be written back. Forwarded
   *  to the shared freshness gate; see `EnsureFreshAuthDeps.onPersistFailure`
   *  for why the write stays non-fatal and why it must not stay silent. */
  onPersistFailure?: (row: ConnectionRow, error: unknown) => void;

  /** A registered provider's refresh response omitted or malformed its
   * tenant-specific API origin. The refresh gate ignores that destination but
   * still uses and persists the rotated credential; this advisory hook lets a
   * production host surface the degraded state without receiving the raw URL. */
  onRuntimeBaseIssue?: (
    row: ConnectionRow,
    issue: Extract<VendorOAuthRuntimeBaseResolution, { status: 'missing' | 'invalid' }>,
  ) => void;

  /** Persist a refreshed OAuth2 auth back to the connection store.
   *  Boot site re-encodes via `encodeAuthForStorage` (the same
   *  `connection` sub-DEK used by enrollment) and upserts the row
   *  with bumped `updated_at`. The cloud sync wire (D-125 P2.2)
   *  carries the new ciphertext to other devices on the next
   *  delta scan; LWW on `updated_at` resolves the two-device race.
   *  Best-effort — refresh persistence failures are logged but
   *  don't block the in-flight call (the new access token is used
   *  for THIS request even if persistence fails). */
  persistAuth: (
    row: ConnectionRow,
    newAuth: ConnectionAuth,
    configPatch?: { base_url: string },
  ) => Promise<void>;

  /** fetch implementation. Defaults to `globalThis.fetch` (Node 18+
   *  has it built-in). Tests inject a stub that returns
   *  pre-canned `Response` objects to assert wire-shape construction
   *  + status classification + body parsing. */
  fetchImpl?: typeof fetch;

  /** Wall-clock source. Defaults to `Date.now`. Tests inject a
   *  deterministic stub to assert OAuth2 expiry-window math. */
  now?: () => number;
}

type RenewableOAuth2Auth = Extract<
  ConnectionAuth,
  { type: 'oauth2_refresh' | 'oauth2_client_credentials' }
>;

const isRenewableOAuth2 = (
  auth: ConnectionAuth,
): auth is RenewableOAuth2Auth =>
  auth.type === 'oauth2_refresh' || auth.type === 'oauth2_client_credentials';

const extractDotPrefix = (
  params: Record<string, unknown>,
  prefix: string,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  const skip = prefix.length + 1;
  const dotPrefix = `${prefix}.`;
  for (const [key, val] of Object.entries(params)) {
    if (!key.startsWith(dotPrefix) || val == null) continue;
    const name = key.slice(skip);
    if (PROTOTYPE_SENSITIVE_KEYS.has(name)) continue;
    out[name] = val;
  }
  return out;
};

const appendQueryScalar = (
  searchParams: URLSearchParams,
  key: string,
  value: unknown,
): void => {
  if (
    typeof value !== 'string'
    && typeof value !== 'number'
    && typeof value !== 'boolean'
  ) {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      `connection.api: query parameter '${key}' must be a string, number, boolean, or array of those scalars`,
      { field: key },
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      `connection.api: query parameter '${key}' must be finite`,
      { field: key },
    );
  }
  searchParams.append(key, String(value));
};

const JSON_DECIMAL_INTEGER_RE = /^-?(?:0|[1-9][0-9]*)$/;

/** Serialize selected top-level body values from exact decimal strings to raw
 * JSON integer literals. All unselected values retain native JSON.stringify
 * semantics. The mode is intentionally narrow: no nested paths, coercion, or
 * exponent/fraction syntax, and arrays require every item to be exact text. */
const stringifyJsonBodyWithDecimalIntegers = (
  fields: Record<string, unknown>,
  rawSpec: unknown,
): string => {
  let selectors: unknown;
  try {
    selectors = typeof rawSpec === 'string' ? JSON.parse(rawSpec) : undefined;
  } catch {
    selectors = undefined;
  }
  if (!Array.isArray(selectors) || selectors.some((field) => typeof field !== 'string')) {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      'connection.api: invalid engine-owned decimal-integer JSON field declaration',
    );
  }
  const scalar = new Set<string>();
  const arrays = new Set<string>();
  for (const selector of selectors as string[]) {
    if (selector.endsWith('[]')) arrays.add(selector.slice(0, -2));
    else scalar.add(selector);
  }
  const exactInteger = (field: string, value: unknown): string => {
    if (typeof value !== 'string' || !JSON_DECIMAL_INTEGER_RE.test(value)) {
      throw new IngredientError(
        'INGREDIENT_OUTPUT_VALIDATION_FAILED',
        `connection.api: JSON integer field '${field}' must be an exact decimal string`,
        { field },
      );
    }
    return value;
  };
  return '{' + Object.entries(fields).map(([field, value]) => {
    let encoded: string;
    if (scalar.has(field)) {
      encoded = exactInteger(field, value);
    } else if (arrays.has(field)) {
      if (!Array.isArray(value)) {
        throw new IngredientError(
          'INGREDIENT_OUTPUT_VALIDATION_FAILED',
          `connection.api: JSON integer-array field '${field}' must be an array of exact decimal strings`,
          { field },
        );
      }
      encoded = '[' + value.map((item) => exactInteger(`${field}[]`, item)).join(',') + ']';
    } else {
      encoded = JSON.stringify(value);
    }
    return JSON.stringify(field) + ':' + encoded;
  }).join(',') + '}';
};

/** D-216 slice 2 / D-217 slice 2b-ii — resolve + encode an UPLOAD body.
 *
 *  Three wire pieces. Not one of them carries BYTES: each names something the
 *  handler resolves through an injected dep, so the dispatch input stays small
 *  and the owner's file never rides through the layers above this one.
 *
 *    `body_file.<field>` → one multipart part per entry, with `body.<k>`
 *                          scalars riding along as TEXT parts so a caption
 *                          and its image go in ONE request. (`file_ref` →
 *                          `readFileBytes`.)
 *    `body_binary`       → the file IS the whole body, raw, with the
 *                          record's own Content-Type. (`file_ref` →
 *                          `readFileBytes`.)
 *    `__cu_staged`       → ONE chunk of a staged plaintext, raw, with the
 *                          staged record's Content-Type. (staging token +
 *                          range → `readUploadChunk`.) Engine-owned: the
 *                          gateway strips the `__cu_` prefix from recipe args,
 *                          so a recipe can never address staged plaintext.
 *
 *  ⛔ Every refusal below is `bad_request` and every one is deliberate:
 *  a silent precedence rule is how a caller ships the wrong body and never
 *  learns. `body_raw` already wins over `body.*`; a THIRD silent winner
 *  would make the wire unreadable.
 *
 *  ⚠ filename + mime come from the RESOLVED RECORD, never from the caller.
 *  Letting a recipe name the file would let it misrepresent what it sends.
 *
 *  Returns `undefined` when no upload piece is present — the ordinary
 *  JSON/form path then runs unchanged. */
const buildUploadBody = async (
  params: Record<string, unknown>,
  headers: Headers,
  deps: ConnectionApiHandlerDeps,
): Promise<{
  body: Uint8Array;
  contentType: string;
  contentSha256?: string;
} | undefined> => {
  const fileFields = extractDotPrefix(params, 'body_file');
  const hasBinary = hasOwn(params, 'body_binary');
  const hasFiles = Object.keys(fileFields).length > 0;
  const hasChunk = hasOwn(params, CHUNKED_UPLOAD_WIRE_TOKEN_KEY);
  const declaredKind = own(params, HTTP_UPLOAD_WIRE_KIND_KEY);
  const hasDeclaration = declaredKind !== undefined;
  if (!hasFiles && !hasBinary && !hasChunk && !hasDeclaration) return undefined;

  if (hasChunk && (hasBinary || hasFiles)) {
    throw new IngredientError('BAD_INPUT', `connection.api: ${CHUNKED_UPLOAD_WIRE_TOKEN_KEY} is exclusive — it cannot combine with body_file.* or body_binary`, {});
  }
  if (!hasChunk) {
    if (declaredKind !== 'multipart' && declaredKind !== 'binary') {
      throw new IngredientError(
        'BAD_INPUT',
        'connection.api: body_file.* / body_binary requires an engine-owned bind.upload declaration',
        {},
      );
    }
    if (declaredKind === 'binary' && (!hasBinary || hasFiles)) {
      throw new IngredientError(
        'BAD_INPUT',
        'connection.api: declared binary upload must carry exactly body_binary',
        {},
      );
    }
    if (declaredKind === 'multipart') {
      const expectedField = own(params, HTTP_UPLOAD_WIRE_FIELD_KEY);
      const actualFields = Object.keys(fileFields);
      if (typeof expectedField !== 'string'
        || expectedField.trim().length === 0
        || hasBinary
        || actualFields.length !== 1
        || actualFields[0] !== expectedField) {
        throw new IngredientError(
          'BAD_INPUT',
          'connection.api: declared multipart upload must carry exactly its declared body_file field',
          {},
        );
      }
    }
  }
  // ⚠ **`body.*` beside a chunk is legal ONLY for a MULTIPART chunk**, and the
  // asymmetry is the encoding, not a policy. A `binary` chunk IS the whole
  // request body — there is nowhere for a sibling field to go, so accepting one
  // would mean silently dropping it. A `multipart` chunk is one part among
  // several, exactly like the one-shot `body_file.*` path, which has carried
  // `body.*` scalars as TEXT PARTS since D-216.
  //
  // ⛔ **Slice 4 is what forced this, and § 9.6 predicted it would.** X's v2
  // APPEND is `POST /2/media/upload/{id}/append` with `media` (the chunk) AND
  // `segment_index` as a sibling form field. Refusing every `body.*` made the
  // one protocol this whole D exists to unblock INEXPRESSIBLE — discovered, as
  // the encoding split was, by asking what the real pack actually needs.
  const chunkTextFields = extractDotPrefix(params, 'body');
  const chunkIsMultipart = typeof own(params, CHUNKED_UPLOAD_WIRE_FIELD_KEY) === 'string';
  if (hasChunk && hasOwn(params, 'body_raw')) {
    throw new IngredientError('BAD_INPUT', `connection.api: ${CHUNKED_UPLOAD_WIRE_TOKEN_KEY} is exclusive — it cannot combine with body_raw`, {});
  }
  if (hasChunk && !chunkIsMultipart && Object.keys(chunkTextFields).length > 0) {
    throw new IngredientError('BAD_INPUT', `connection.api: a raw (binary) chunk IS the request body — body.* has nowhere to go. Declare chunk_encoding 'multipart' with a chunk_field to send fields beside the chunk`, {});
  }
  if (hasBinary && hasFiles) {
    throw new IngredientError('BAD_INPUT', 'connection.api: body_binary is exclusive — it cannot combine with body_file.*', {});
  }
  if (hasBinary && (hasOwn(params, 'body_raw') || Object.keys(extractDotPrefix(params, 'body')).length > 0)) {
    throw new IngredientError('BAD_INPUT', 'connection.api: body_binary is exclusive — it cannot combine with body.* or body_raw', {});
  }
  if (hasFiles && hasOwn(params, 'body_raw')) {
    throw new IngredientError('BAD_INPUT', 'connection.api: body_file.* cannot combine with body_raw — a multipart body is built from body.* text parts', {});
  }
  // A hand-set Content-Type cannot be honoured: multipart needs the
  // GENERATED boundary, and a binary body takes the record's own type.
  // Silently overwriting it would be worse than refusing.
  if (headers.get('Content-Type') !== null) {
    throw new IngredientError('BAD_INPUT', 'connection.api: an upload body sets its own Content-Type — remove the pinned header.content-type', {});
  }
  // D-217 slice 2b-ii — ONE chunk of a staged plaintext. The engine already
  // staged and content-verified the file (slice 0) and fixed the request count
  // (slice 2a); what arrives here is a token plus a range, and the bytes are
  // resolved on THIS side of the wire so they never enter the dispatch input
  // — which the commit gateway persists as `args` and hashes.
  if (hasChunk) {
    if (deps.readUploadChunk === undefined) {
      throw new IngredientError('SERVER_NOT_REACHABLE', 'connection.api: this host cannot read a staged upload chunk — a chunked upload fails closed', {});
    }
    const token = own(params, CHUNKED_UPLOAD_WIRE_TOKEN_KEY);
    if (typeof token !== 'string' || token.length === 0) {
      throw new IngredientError('BAD_INPUT', `connection.api: ${CHUNKED_UPLOAD_WIRE_TOKEN_KEY} must be a non-empty staging token`, {});
    }
    const offset = own(params, CHUNKED_UPLOAD_WIRE_OFFSET_KEY);
    const length = own(params, CHUNKED_UPLOAD_WIRE_LENGTH_KEY);
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
      throw new IngredientError('BAD_INPUT', `connection.api: ${CHUNKED_UPLOAD_WIRE_OFFSET_KEY} must be a non-negative safe integer`, {});
    }
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length <= 0) {
      throw new IngredientError('BAD_INPUT', `connection.api: ${CHUNKED_UPLOAD_WIRE_LENGTH_KEY} must be a positive safe integer`, {});
    }
    // ONE chunk is ONE request body held in memory, so it inherits the
    // one-shot ceiling for exactly the reason D-216 § 4 set it — the 512 MB
    // chunked ceiling bounds the WALK, never a single buffer. A plan that
    // asked for more than this was mis-computed; refuse before the socket.
    if (length > HTTP_UPLOAD_MAX_BYTES_CEILING) {
      throw new IngredientError('BAD_INPUT', `connection.api: a single chunk of ${length} bytes exceeds the ${HTTP_UPLOAD_MAX_BYTES_CEILING}-byte per-request ceiling`, { max_bytes: HTTP_UPLOAD_MAX_BYTES_CEILING });
    }
    const field = own(params, CHUNKED_UPLOAD_WIRE_FIELD_KEY);
    if (field !== undefined && (typeof field !== 'string' || field.trim().length === 0)) {
      throw new IngredientError('BAD_INPUT', `connection.api: ${CHUNKED_UPLOAD_WIRE_FIELD_KEY} must be a non-empty form-field name when present`, {});
    }
    const chunk = await deps.readUploadChunk(token, offset, length);
    // The staging handle refuses a short read (slice 0), but it is a dep here
    // and a dep is whatever the host wired. A truncated chunk is accepted and
    // stored by most targets, so it is worth the one comparison.
    if (chunk.bytes.byteLength !== length) {
      throw new IngredientError('BAD_INPUT', `connection.api: staged chunk returned ${chunk.bytes.byteLength} bytes for a ${length}-byte range`, {});
    }
    // Presence of a field name IS the encoding — set ⇒ one named form part,
    // absent ⇒ the chunk is the raw body. ⚠ The part's filename is the literal
    // `chunk`, NOT the staged record's: a chunk is one slice of a multi-request
    // upload, not a file in its own right, and repeating the owner's filename
    // on every APPEND would disclose it N times for no protocol benefit.
    if (typeof field === 'string') {
      // The declaration's `body.*` ride along as TEXT PARTS — same coercion the
      // one-shot path uses below, so a caption beside a file and a
      // `segment_index` beside a chunk are the same mechanism, not two.
      const chunkParts: MultipartField[] = Object.entries(chunkTextFields)
        .map(([name, value]) => ({ name, value: value == null ? '' : String(value) }));
      const encoded = encodeMultipart(chunkParts, [{
        name: field.trim(),
        filename: 'chunk',
        mime_type: chunk.mime_type,
        bytes: new Uint8Array(chunk.bytes),
      }], makeBoundary());
      return { body: encoded.body, contentType: encoded.content_type };
    }
    return { body: chunk.bytes, contentType: chunk.mime_type };
  }

  if (deps.readFileBytes === undefined) {
    throw new IngredientError('SERVER_NOT_REACHABLE', 'connection.api: this host cannot resolve file_ref bytes — an upload op fails closed', {});
  }

  const maxBytes = resolveUploadMaxBytes(own(params, HTTP_UPLOAD_WIRE_MAX_BYTES_KEY));
  let total = 0;
  const resolveRef = async (ref: unknown, where: string) => {
    if (typeof ref !== 'string' || ref.length === 0) {
      throw new IngredientError('BAD_INPUT', `connection.api: ${where} must be a non-empty file_ref string`, {});
    }
    const file = await deps.readFileBytes!(ref);
    total += file.bytes.length;
    // Checked AFTER each resolution and BEFORE any socket opens: a truncated
    // body is accepted and stored by most targets, so a partial upload is
    // worse than a refusal.
    if (total > maxBytes) {
      throw new IngredientError('BAD_INPUT', `connection.api: upload exceeds the ${maxBytes}-byte ceiling`, { max_bytes: maxBytes });
    }
    return { ...file, contentSha256: sha256Hex(file.bytes) };
  };

  if (hasBinary) {
    const file = await resolveRef(own(params, 'body_binary'), 'body_binary');
    return {
      body: new Uint8Array(file.bytes),
      contentType: file.mime_type,
      contentSha256: file.contentSha256,
    };
  }

  const textParts: MultipartField[] = Object.entries(extractDotPrefix(params, 'body'))
    .map(([name, value]) => ({ name, value: value == null ? '' : String(value) }));
  const files: MultipartFile[] = [];
  for (const [field, ref] of Object.entries(fileFields)) {
    const file = await resolveRef(ref, `body_file.${field}`);
    files.push({
      name: field,
      filename: file.filename,
      mime_type: file.mime_type,
      bytes: new Uint8Array(file.bytes),
    });
  }
  const encoded = encodeMultipart(textParts, files, makeBoundary());
  return {
    body: encoded.body,
    contentType: encoded.content_type,
    contentSha256: sha256Hex(files[0]!.bytes),
  };
};

/** A pack op may LOWER the handler ceiling, never raise it (D-216 § 4). An
 *  absent / malformed / raised value falls back to the ceiling rather than
 *  failing — the authoring validator is where a bad declaration is caught,
 *  and the handler's job is to stay bounded regardless. */
export const resolveUploadMaxBytes = (declared: unknown): number => {
  if (typeof declared !== 'number' || !Number.isFinite(declared) || declared <= 0) {
    return HTTP_UPLOAD_MAX_BYTES_CEILING;
  }
  return Math.min(Math.trunc(declared), HTTP_UPLOAD_MAX_BYTES_CEILING);
};

/** D-216 slice 3 — the request body's true size on the wire.
 *
 *  ⚠ The pre-D-216 telemetry was `TextEncoder().encode(body).byteLength`,
 *  which silently mis-measures a `Uint8Array` (it stringifies it to
 *  "0,255,27,…" and reports that length). An upload is exactly the case
 *  where `bytes_out` matters most, so it gets the real number. */
const bodyByteLength = (body: string | Uint8Array | undefined): number => {
  if (body === undefined) return 0;
  if (typeof body === 'string') return new TextEncoder().encode(body).byteLength;
  return body.byteLength;
};

const buildBody = (
  params: Record<string, unknown>,
  headers: Headers,
): string | undefined => {
  // body_raw wins when both shapes appear — recipes that need raw
  // bytes (form posts to legacy endpoints, signed payloads with
  // exact-byte hashing) opt out of JSON encoding here.
  if (hasOwn(params, 'body_raw')) {
    const raw = own(params, 'body_raw');
    if (raw == null) return undefined;
    return typeof raw === 'string' ? raw : String(raw);
  }
  const fields = extractDotPrefix(params, 'body');
  if (Object.keys(fields).length === 0) return undefined;
  const contentType = headers.get('Content-Type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  const decimalIntegerSpec = own(params, '__rc_json_decimal_integer_fields');
  if (decimalIntegerSpec !== undefined
    && contentType !== undefined
    && contentType !== 'application/json') {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      'connection.api: exact decimal-integer request serialization requires application/json',
      { content_type: contentType },
    );
  }
  if (contentType === 'application/x-www-form-urlencoded') {
    const form = new URLSearchParams();
    const appendScalar = (key: string, value: unknown): void => {
      if (typeof value !== 'string'
        && typeof value !== 'number'
        && typeof value !== 'boolean') {
        throw new IngredientError(
          'INGREDIENT_OUTPUT_VALIDATION_FAILED',
          `connection.api: form body field '${key}' must be a string, number, boolean, or array of those scalars`,
          { field: key, content_type: contentType },
        );
      }
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new IngredientError(
          'INGREDIENT_OUTPUT_VALIDATION_FAILED',
          `connection.api: form body field '${key}' must be finite`,
          { field: key, content_type: contentType },
        );
      }
      form.append(key, String(value));
    };
    for (const [key, value] of Object.entries(fields)) {
      if (Array.isArray(value)) {
        for (const item of value) appendScalar(key, item);
      } else {
        appendScalar(key, value);
      }
    }
    return form.toString();
  }
  if (!hasContentTypeHeader(headers)) {
    headers.set('Content-Type', 'application/json');
  }
  if (decimalIntegerSpec !== undefined) {
    return stringifyJsonBodyWithDecimalIntegers(
      fields,
      decimalIntegerSpec,
    );
  }
  return JSON.stringify(fields);
};

const hasContentTypeHeader = (headers: Headers): boolean =>
  // `Headers.has()` is case-insensitive per HTTP spec — both
  // `Content-Type` and `content-type` resolve to the same slot.
  headers.has('Content-Type');

const authTypeOf = (auth: ConnectionAuth): string => {
  const raw = (auth as { type?: unknown }).type;
  return typeof raw === 'string' ? raw : String(raw);
};

const requireAuthString = (
  auth: ConnectionAuth,
  field: string,
): string => {
  const value = (auth as unknown as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      `connection.api: auth.${field} is required for auth.type='${authTypeOf(auth)}'`,
      { auth_type: authTypeOf(auth), field },
    );
  }
  return value;
};

/** Final credential-use gate for restored/legacy rows. Enrollment validation
 * prevents new unsafe endpoints, but token exchange must remain authoritative
 * even when auth material came from an older database or an internal caller. */
const requireOAuthTokenEndpoint = (
  auth: ConnectionAuth,
  operation: 'OAuth2 refresh' | 'OAuth2 client-credentials exchange',
): string => {
  const endpoint = requireAuthString(auth, 'token_endpoint');
  if (!isValidOAuthEndpointUrl(endpoint)) {
    throw new IngredientError(
      'TOKEN_REFRESH_FAILED',
      `${operation} refused: auth.token_endpoint must be a complete HTTPS URL with no embedded username or password and no URL fragment`,
      { cause: 'unsafe_token_endpoint' },
    );
  }
  return endpoint.trim();
};

const requireAuthNameString = (
  auth: ConnectionAuth,
  field: string,
): string => {
  const value = requireAuthString(auth, field);
  if (PROTOTYPE_SENSITIVE_KEYS.has(value)) {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      `connection.api: auth.${field} cannot be a reserved object key`,
      { auth_type: authTypeOf(auth), field },
    );
  }
  return value;
};

const injectAuth = (
  auth: ConnectionAuth,
  headers: Headers,
  url: URL,
): void => {
  switch (auth.type) {
    case 'none':
      return;
    case 'bearer':
      headers.set('Authorization', `Bearer ${requireAuthString(auth, 'token')}`);
      return;
    case 'basic': {
      // btoa is global in Node 18+ and every browser. ASCII-only
      // by spec; non-ASCII passwords would already break the
      // RFC 7617 base64 contract before reaching this layer.
      const b64 = btoa(
        `${requireAuthString(auth, 'username')}:${requireAuthString(auth, 'password')}`,
      );
      headers.set('Authorization', `Basic ${b64}`);
      return;
    }
    case 'header': {
      const res = validateHeaderAuthEntries(auth.headers);
      if (!res.ok) {
        throw new IngredientError(
          'INGREDIENT_OUTPUT_VALIDATION_FAILED',
          `connection.api: auth.headers ${describeHeaderAuthIssue(res.issue)}`,
          { auth_type: 'header' },
        );
      }
      for (const h of res.entries) headers.set(h.header_name, h.value);
      return;
    }
    case 'query':
      url.searchParams.set(requireAuthNameString(auth, 'param_name'), requireAuthString(auth, 'value'));
      return;
    case 'oauth2_refresh':
    case 'oauth2_client_credentials':
      if (
        typeof auth.current_access_token !== 'string' ||
        auth.current_access_token.trim() === ''
      ) {
        throw new IngredientError(
          'OAUTH_EXPIRED',
          'OAuth2 access token has not been acquired yet — refresh flow did not run or failed silently',
          { auth_type: auth.type },
        );
      }
      headers.set('Authorization', `Bearer ${auth.current_access_token}`);
      return;
    // D-218 — the `accessJwt` an AT Protocol session exchange produced. Sent as
    // an ordinary bearer, because that is what the protocol asks for.
    //
    // ⚠ **Slice 0 has no exchange yet, so this is the ONLY behaviour it can
    // have and it must FAIL rather than send nothing.** A row enrolls, no
    // session has been minted, and every dispatch stops here with an actionable
    // code. Slice 1 makes the absent-token case reachable-and-fixable by
    // performing the exchange; slice 2 makes an EXPIRED one recoverable by
    // reacting to the 401 that a stale token earns.
    case 'atproto_session':
      if (
        typeof auth.current_access_token !== 'string' ||
        auth.current_access_token.trim() === ''
      ) {
        throw new IngredientError(
          'OAUTH_EXPIRED',
          'AT Protocol session has not been established yet — no accessJwt has been exchanged for this connection',
          { auth_type: auth.type },
        );
      }
      headers.set('Authorization', `Bearer ${auth.current_access_token}`);
      return;
  }
  throw new IngredientError(
    'INGREDIENT_OUTPUT_VALIDATION_FAILED',
    `connection.api: unsupported auth.type '${authTypeOf(auth)}'`,
    { auth_type: authTypeOf(auth) },
  );
};

/** Map an HTTP response to the right error code per spec § 4.1
 *  + the existing executeHTTP convention (D-040). For write-tier
 *  calls, 5xx becomes `ACTION_DELIVERY_UNCERTAIN` because the
 *  server may have committed before the ack failed; the user must
 *  verify in-system before retrying. */
const classifyHttpError = (
  response: Response,
  slug: string,
  isWrite: boolean,
): void => {
  if (response.ok) return;
  const status = response.status;
  if (status === 401 || status === 403) {
    throw new IngredientError(
      'OAUTH_EXPIRED',
      `${slug} returned ${status} ${response.statusText}`,
      { status },
    );
  }
  if (status === 404) {
    throw new IngredientError(
      'API_NOT_FOUND',
      `${slug} returned 404 ${response.statusText}`,
      { status },
    );
  }
  if (status === 429) {
    throw new IngredientError(
      'API_RATE_LIMITED',
      `${slug} rate limited (429)`,
      { status },
    );
  }
  if (status >= 500) {
    if (isWrite) {
      throw new IngredientError(
        'ACTION_DELIVERY_UNCERTAIN',
        `Write to ${slug} returned ${status} ${response.statusText} — server error after request dispatch, outcome cannot be confirmed, please verify state in the target system before retrying`,
        { status, cause: 'server_5xx' },
      );
    }
    throw new IngredientError(
      'NETWORK_ERROR',
      `${slug} server error: ${status} ${response.statusText}`,
      { status },
    );
  }
  throw new IngredientError(
    'NETWORK_ERROR',
    `${slug} returned ${status} ${response.statusText}`,
    { status },
  );
};

/** Quote only plain JSON integer literals that JavaScript cannot represent
 * exactly. This is deliberately a lexical pass followed by the native parser:
 * strings (including escaped quotes and digits) are copied byte-for-byte,
 * fractions/exponents keep number semantics, and malformed JSON still fails in
 * `JSON.parse`. The transformed unsafe integer becomes its exact decimal text. */
const stringifyUnsafeJsonIntegers = (json: string): string => {
  let out = '';
  let index = 0;
  while (index < json.length) {
    const char = json[index]!;
    if (char === '"') {
      const start = index++;
      while (index < json.length) {
        if (json[index] === '\\') {
          index += 2;
          continue;
        }
        if (json[index++] === '"') break;
      }
      out += json.slice(start, index);
      continue;
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      const start = index;
      if (json[index] === '-') index += 1;
      if (json[index] === '0') {
        index += 1;
      } else {
        while (index < json.length && json[index]! >= '0' && json[index]! <= '9') index += 1;
      }
      let integerLiteral = true;
      if (json[index] === '.') {
        integerLiteral = false;
        index += 1;
        while (index < json.length && json[index]! >= '0' && json[index]! <= '9') index += 1;
      }
      if (json[index] === 'e' || json[index] === 'E') {
        integerLiteral = false;
        index += 1;
        if (json[index] === '+' || json[index] === '-') index += 1;
        while (index < json.length && json[index]! >= '0' && json[index]! <= '9') index += 1;
      }
      const token = json.slice(start, index);
      if (integerLiteral) {
        try {
          const value = BigInt(token);
          if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
            out += JSON.stringify(token);
            continue;
          }
        } catch {
          // The native JSON parser below owns malformed-token classification.
        }
      }
      out += token;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
};

const parseResponseBody = async (
  response: Response,
  slug: string,
  stringifyUnsafeIntegers: boolean,
): Promise<{ readonly value: unknown; readonly byteLength: number }> => {
  const contentType = response.headers.get('content-type') ?? '';
  let text: string;
  let byteLength: number;
  ({ text, byteLength } = await readBoundedResponseText(response));
  if (contentType.includes('application/json')) {
    try {
      const value = JSON.parse(
        stringifyUnsafeIntegers ? stringifyUnsafeJsonIntegers(text) : text,
      ) as unknown;
      return { value, byteLength };
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      throw new IngredientError(
        'NETWORK_ERROR',
        `${slug} returned malformed JSON`,
        { response_body_failure: 'malformed_json' },
      );
    }
  }
  return { value: text, byteLength };
};

const responseHeadersToObject = (
  headers: Headers,
): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => { out[key] = value; });
  return out;
};

/** SMB-finance slice 3 (storage-gdrive `file.download`) — ceiling on a
 *  captured response body. A downloaded document is small; a runaway / wrong
 *  endpoint must fail loud rather than buffer an unbounded body into memory.
 *  Mirrors the CLI `output_capture` 64 MiB cap. */
const RESPONSE_CAPTURE_MAX_BYTES = 64 * 1024 * 1024;
const CREDENTIAL_RESPONSE_MAX_BYTES = 1024 * 1024;

interface CredentialJsonRequest {
  readonly label: string;
  readonly endpoint: string;
  readonly origin: string;
  readonly init: Omit<RequestInit, 'signal'>;
  readonly fetchImpl: typeof fetch;
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * Credential exchanges run before the ordinary operation request, so the
 * operation's AbortController cannot protect them. Give the exchange its own
 * end-to-end deadline (including redirects and response streaming), bound its
 * JSON body, and release every response on all exits.
 */
const fetchCredentialJson = async <T>({
  label,
  endpoint,
  origin,
  init,
  fetchImpl,
  details = {},
}: CredentialJsonRequest): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECTION_API_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchOriginPinned(fetchImpl, endpoint, {
      ...init,
      signal: controller.signal,
    }, origin);
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof CrossOriginRedirectError) {
      throw new IngredientError(
        'TOKEN_REFRESH_FAILED',
        `${label} refused: ${e.message} — credentials not sent to the redirect target`,
        { ...details, cause: 'cross_origin_redirect' },
      );
    }
    const isAbort = (e as Error).name === 'AbortError';
    throw new IngredientError(
      'TOKEN_REFRESH_FAILED',
      isAbort
        ? `${label} timed out after ${CONNECTION_API_TIMEOUT_MS}ms`
        : `${label} failed: ${(e as Error).message}`,
      { ...details, cause: isAbort ? 'timeout' : 'network' },
    );
  }

  try {
    if (!response.ok) {
      throw new IngredientError(
        'TOKEN_REFRESH_FAILED',
        `${label} returned ${response.status} ${response.statusText}`,
        { ...details, status: response.status },
      );
    }

    let text: string;
    try {
      ({ text } = await readBoundedResponseText(response, CREDENTIAL_RESPONSE_MAX_BYTES));
    } catch (e) {
      if (e instanceof ResponseBodyTooLargeError) {
        throw new IngredientError(
          'TOKEN_REFRESH_FAILED',
          `${label} response exceeded the ${e.maxBytes}-byte body limit`,
          { ...details, cause: 'response_too_large', max_bytes: e.maxBytes },
        );
      }
      const isAbort = (e as Error).name === 'AbortError';
      throw new IngredientError(
        'TOKEN_REFRESH_FAILED',
        isAbort
          ? `${label} timed out after ${CONNECTION_API_TIMEOUT_MS}ms while reading the response`
          : `${label} response failed: ${(e as Error).message}`,
        { ...details, cause: isAbort ? 'timeout' : 'response_body' },
      );
    }

    try {
      return JSON.parse(text) as T;
    } catch (e) {
      throw new IngredientError(
        'TOKEN_REFRESH_FAILED',
        `${label} returned malformed JSON: ${(e as Error).message}`,
        { ...details, cause: 'malformed_json' },
      );
    }
  } finally {
    discardResponseBody(response);
    clearTimeout(timer);
  }
};

/** Portable Uint8Array → base64 (the codebase avoids Node `Buffer` for
 *  portability — `btoa` is global in Node 18+ and every browser). Chunked
 *  `fromCharCode` so a large body never blows the argument-spread stack. */
const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
};

/** Pull a display filename from a `Content-Disposition` header. Prefers the
 *  RFC 5987 `filename*=UTF-8''…` form (percent-decoded), then the plain
 *  `filename="…"` / `filename=…` form. Returns `null` when absent/unparseable
 *  — the caller falls back to the binding's filename source. */
const filenameFromContentDisposition = (header: string | null): string | null => {
  if (!header) return null;
  const ext = /filename\*\s*=\s*[^']*''([^;]+)/i.exec(header);
  if (ext && ext[1]) {
    try {
      return decodeURIComponent(ext[1].trim());
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  if (plain && plain[1]) return plain[1].trim();
  return null;
};

const mapOutput = (
  data: unknown,
  outputMapping: Record<string, string>,
  fallback?: Record<string, string>,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const [responsePath, fieldName] of Object.entries(outputMapping)) {
    if (PROTOTYPE_SENSITIVE_KEYS.has(fieldName)) continue;
    result[fieldName] = walkPath(data, responsePath);
  }
  if (fallback) {
    for (const [responsePath, fieldName] of Object.entries(fallback)) {
      if (PROTOTYPE_SENSITIVE_KEYS.has(fieldName)) continue;
      if (result[fieldName] === undefined) {
        result[fieldName] = walkPath(data, responsePath);
      }
    }
  }
  return result;
};

/** Read `record.config_json.base_url` — the per-record API root.
 *  Throws `INGREDIENT_OUTPUT_VALIDATION_FAILED` when missing or
 *  malformed; the connection should never have been enrolled
 *  without a base_url, but a corrupted row would otherwise surface
 *  a confusing URL parse error instead of an actionable diagnostic. */
const readBaseUrl = (row: ConnectionRow): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.config_json);
  } catch {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      `connection.api: malformed config_json for connection '${row.name}'`,
      { name: row.name },
    );
  }
  const config = parsed as Record<string, unknown> | null;
  const base = config?.base_url;
  if (typeof base !== 'string' || base.trim() === '') {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      `connection.api: connection '${row.name}' has no base_url in config (re-enroll in Settings → Connections)`,
      { name: row.name },
    );
  }
  return base;
};

interface OAuth2TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  instance_url?: unknown;
  api_domain?: unknown;
}

/** Exchange an OAuth2 client id + secret for a short-lived bearer token.
 *  This is adapter-internal credential bootstrap: recipe operations can never
 *  invoke the token endpoint or observe the client secret. The request uses
 *  the standard form-encoded client-credentials grant, supported by Airbyte's
 *  public token endpoint as well as conventional OAuth issuers. */
export const exchangeOAuth2ClientCredentials = async (
  auth: Extract<ConnectionAuth, { type: 'oauth2_client_credentials' }>,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<ConnectionAuth> => {
  const clientId = requireAuthString(auth, 'client_id');
  const clientSecret = requireAuthString(auth, 'client_secret');
  const tokenEndpoint = requireOAuthTokenEndpoint(auth, 'OAuth2 client-credentials exchange');
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  const tokenAuthStyle = auth.token_auth_style ?? 'body';
  if (tokenAuthStyle === 'basic') {
    headers.Authorization =
      `Basic ${bytesToBase64(new TextEncoder().encode(`${clientId}:${clientSecret}`))}`;
  } else {
    body.set('client_id', clientId);
    body.set('client_secret', clientSecret);
  }
  if (auth.scope !== undefined) {
    const scope = auth.scope.trim();
    if (scope.length === 0) {
      throw new IngredientError(
        'TOKEN_REFRESH_FAILED',
        'OAuth2 client-credentials exchange: auth.scope must be non-empty when present',
      );
    }
    body.set('scope', scope);
  }

  const tokenOrigin = new URL(tokenEndpoint).origin;
  const data = await fetchCredentialJson<OAuth2TokenResponse>({
    label: 'OAuth2 client-credentials exchange',
    endpoint: tokenEndpoint,
    origin: tokenOrigin,
    fetchImpl,
    init: {
      method: 'POST',
      headers,
      body: body.toString(),
    },
    details: { token_endpoint: tokenEndpoint },
  });
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new IngredientError(
      'TOKEN_REFRESH_FAILED',
      'OAuth2 client-credentials exchange returned a non-object token response',
    );
  }
  if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
    throw new IngredientError(
      'TOKEN_REFRESH_FAILED',
      'OAuth2 client-credentials exchange response missing access_token',
    );
  }
  if (data.token_type !== undefined
    && (typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer')) {
    throw new IngredientError(
      'TOKEN_REFRESH_FAILED',
      `OAuth2 client-credentials exchange returned unsupported token_type '${data.token_type}'`,
    );
  }
  const expiresIn = data.expires_in;
  const hasUsableExpiry = typeof expiresIn === 'number'
    && Number.isFinite(expiresIn)
    && expiresIn > 0;
  return {
    type: 'oauth2_client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    token_endpoint: tokenEndpoint,
    ...(auth.token_auth_style !== undefined ? { token_auth_style: auth.token_auth_style } : {}),
    ...(auth.scope !== undefined ? { scope: auth.scope } : {}),
    current_access_token: data.access_token,
    ...(hasUsableExpiry ? { expires_at: now() + expiresIn * 1_000 } : {}),
  };
};

/** Exchange a refresh token for a fresh access token via the
 *  enrolled `token_endpoint`. POST form-urlencoded per OAuth2 RFC
 *  6749 § 6. Failures map to `TOKEN_REFRESH_FAILED` so the user
 *  surface points to "reconnect the account" rather than the
 *  generic NETWORK_ERROR.
 *
 *  Exported for D-129 P2 — the housekeeping reconciliation harness
 *  reuses the exact same refresh dance from outside the api handler
 *  so re-implementing the OAuth2 grant flow in two places stays
 *  avoided. The harness builds its own persist callback (the
 *  connection-store upsert with re-encoded `auth_ciphertext`). */
export interface OAuth2RefreshResult {
  auth: ConnectionAuth;
  runtime_base: VendorOAuthRuntimeBaseResolution;
}

/** Refresh with the provider response metadata retained. Callers that own the
 * connection row use this form so a Salesforce/Pipedrive tenant-origin change
 * can be persisted atomically beside a rotated credential. */
export const refreshOAuth2WithMetadata = async (
  auth: Extract<ConnectionAuth, { type: 'oauth2_refresh' }>,
  fetchImpl: typeof fetch,
  now: () => number,
  provider?: ConnectionVendorProvider | null,
): Promise<OAuth2RefreshResult> => {
  const refreshToken = requireAuthString(auth, 'refresh_token');
  const clientId = requireAuthString(auth, 'client_id');
  const tokenEndpoint = requireOAuthTokenEndpoint(auth, 'OAuth2 refresh');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const tokenAuthStyle = auth.token_auth_style ?? 'body';
  if (auth.client_secret && tokenAuthStyle === 'basic') {
    headers.Authorization =
      `Basic ${bytesToBase64(new TextEncoder().encode(`${clientId}:${auth.client_secret}`))}`;
  } else {
    body.set('client_id', clientId);
    if (auth.client_secret) {
      body.set('client_secret', auth.client_secret);
    }
  }

  // SSRF: pin redirects to the token endpoint's own origin. A
  // 307/308 from a compromised / open-redirect token endpoint would
  // otherwise re-POST the refresh_token + client_secret to an attacker
  // host (method + body preserved on 307/308). Same-origin redirects
  // re-send to the same trusted origin only; cross-origin is refused
  // before the secret leaves the box.
  const tokenOrigin = new URL(tokenEndpoint).origin;
  const data = await fetchCredentialJson<OAuth2TokenResponse>({
    label: 'OAuth2 refresh',
    endpoint: tokenEndpoint,
    origin: tokenOrigin,
    fetchImpl,
    init: {
      method: 'POST',
      headers,
      body: body.toString(),
    },
    details: { token_endpoint: tokenEndpoint },
  });
  if (typeof data.access_token !== 'string' || data.access_token === '') {
    throw new IngredientError(
      'TOKEN_REFRESH_FAILED',
      `OAuth2 refresh response missing access_token`,
    );
  }
  const next: ConnectionAuth = {
    type: 'oauth2_refresh',
    refresh_token:
      typeof data.refresh_token === 'string' && data.refresh_token !== ''
        ? data.refresh_token
        : refreshToken,
    client_id: clientId,
    ...(auth.client_secret !== undefined ? { client_secret: auth.client_secret } : {}),
    token_endpoint: tokenEndpoint,
    ...(auth.token_auth_style !== undefined ? { token_auth_style: auth.token_auth_style } : {}),
    current_access_token: data.access_token,
    ...(typeof data.expires_in === 'number'
      ? { expires_at: now() + data.expires_in * 1_000 }
      : {}),
  };
  return {
    auth: next,
    runtime_base: provider === undefined || provider === null
      ? { status: 'not_expected' }
      : resolveVendorOAuthRuntimeBase(
          provider,
          data as unknown as Readonly<Record<string, unknown>>,
        ),
  };
};

/** Backward-compatible auth-only refresh. Consumers that do not own connection
 * config keep their existing contract; row-aware gates use the metadata form. */
export const refreshOAuth2 = async (
  auth: Extract<ConnectionAuth, { type: 'oauth2_refresh' }>,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<ConnectionAuth> =>
  (await refreshOAuth2WithMetadata(auth, fetchImpl, now)).auth;

// ────────────────────────────────────────────────────────────────
// D-218 — AT Protocol session exchange
// ────────────────────────────────────────────────────────────────

/** The two XRPC procedures a session lives on. Constants, not configuration —
 *  see `atprotoSessionUrl`. */
const ATPROTO_CREATE_SESSION_NSID = 'com.atproto.server.createSession';
const ATPROTO_REFRESH_SESSION_NSID = 'com.atproto.server.refreshSession';

type AtprotoSessionAuth = Extract<ConnectionAuth, { type: 'atproto_session' }>;

/** What both session procedures return. ⚠ Read as OPAQUE strings — the AT
 *  Protocol spec says "the JWT fields and semantics are not a stable part of
 *  the specification", so nothing here parses one. */
interface AtprotoSessionResponse {
  accessJwt?: unknown;
  refreshJwt?: unknown;
}

/** Derive a session endpoint from the connection's OWN base URL.
 *
 *  ⛔ **This is § 7.5b's ruling as code, and the derivation IS the security
 *  property.** Every other exchanging auth type carries a `token_endpoint`
 *  field; this one deliberately has none, because a credential-only
 *  destination is the highest-value exfiltration primitive in the system — a
 *  place an account password gets POSTed that no reviewer would think to audit.
 *  Deriving from `base_url` means the password can only ever reach the host
 *  this connection already talks to.
 *
 *  Uses the same `composeApiUrl` every op path goes through, so a PDS mounted
 *  under a base path resolves identically to the ops beside it. */
const atprotoSessionUrl = (baseUrl: string, nsid: string): URL => {
  try {
    return composeApiUrl(baseUrl, `/xrpc/${nsid}`);
  } catch (e) {
    throw new IngredientError(
      'TOKEN_REFRESH_FAILED',
      `AT Protocol session: cannot resolve '${nsid}' against base_url '${baseUrl}': ${(e as Error).message}`,
      { nsid },
    );
  }
};

/** POST one session procedure and read the token pair out of it.
 *
 *  ⚠ **Origin-pinned, and it matters more here than anywhere else in this
 *  file.** A 307/308 preserves method AND body, so an open redirect on a
 *  compromised PDS would re-POST `createSession`'s body — **the app password
 *  itself** — to the redirect target. `fetchOriginPinned` refuses before the
 *  credential leaves the box.
 *
 *  ⚠ **No error path may echo the request body.** The message carries the
 *  status and the procedure name; the response text is deliberately not
 *  included, because a PDS that rejects a login commonly quotes what it was
 *  sent. */
const postAtprotoSession = async (
  url: URL,
  init: { headers: Record<string, string>; body?: string },
  fetchImpl: typeof fetch,
  nsid: string,
): Promise<{ accessJwt: string; refreshJwt?: string }> => {
  const data = await fetchCredentialJson<AtprotoSessionResponse>({
    label: `AT Protocol ${nsid}`,
    endpoint: url.toString(),
    origin: url.origin,
    fetchImpl,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...init.headers },
      ...(init.body !== undefined ? { body: init.body } : {}),
    },
    details: { nsid },
  });
  const accessJwt = data.accessJwt;
  if (typeof accessJwt !== 'string' || accessJwt === '') {
    throw new IngredientError(
      'TOKEN_REFRESH_FAILED',
      `AT Protocol ${nsid} response missing accessJwt`,
      { nsid },
    );
  }
  const refreshJwt = data.refreshJwt;
  return {
    accessJwt,
    ...(typeof refreshJwt === 'string' && refreshJwt !== '' ? { refreshJwt } : {}),
  };
};

/** Fold a fresh token pair back onto the auth row, preserving the credential.
 *
 *  ⛔ **A missing `refreshJwt` DROPS the stored one — it does not keep it.**
 *  `refreshOAuth2` falls back to the old refresh token when a response omits
 *  one, which is right for OAuth2 where rotation is optional and the old token
 *  usually still works. Here rotation is mandatory and **using the refresh
 *  token invalidates it**, so the stored copy is already dead. Keeping it would
 *  store a credential guaranteed to fail; dropping it says "log in again",
 *  which is exactly what the retained app password (§ 7.5c) makes possible. */
const withAtprotoTokens = (
  auth: AtprotoSessionAuth,
  tokens: { accessJwt: string; refreshJwt?: string },
): ConnectionAuth => ({
  type: 'atproto_session',
  identifier: auth.identifier,
  app_password: auth.app_password,
  current_access_token: tokens.accessJwt,
  ...(tokens.refreshJwt !== undefined ? { refresh_token: tokens.refreshJwt } : {}),
});

/** Log in with the stored app password — `com.atproto.server.createSession`.
 *
 *  ⚠ The ONLY call in this file that puts a long-lived account credential on
 *  the wire. Everything about it is deliberate: derived endpoint, origin pin,
 *  JSON body (the protocol's shape, and the reason `basic` could not express
 *  this type), and an error path that never quotes what was sent. */
export const createAtprotoSession = async (
  auth: AtprotoSessionAuth,
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<ConnectionAuth> => {
  const identifier = requireAuthString(auth, 'identifier');
  const appPassword = requireAuthString(auth, 'app_password');
  const url = atprotoSessionUrl(baseUrl, ATPROTO_CREATE_SESSION_NSID);
  const tokens = await postAtprotoSession(
    url,
    {
      headers: {},
      body: JSON.stringify({ identifier, password: appPassword }),
    },
    fetchImpl,
    ATPROTO_CREATE_SESSION_NSID,
  );
  return withAtprotoTokens(auth, tokens);
};

/** Renew with the stored refresh token — `com.atproto.server.refreshSession`.
 *
 *  🔑 **The refresh token goes in the AUTHORIZATION HEADER, not the body**, and
 *  that single fact is most of why `oauth2_refresh` could not express this
 *  type: its whole shape is a form-encoded grant with the token in the payload.
 *
 *  ⛔ **Calling this INVALIDATES the token it sent.** By the time it returns,
 *  the caller's stored copy is dead whether or not the new one is ever
 *  persisted — which is why the persist failure that follows is not
 *  recoverable by retrying, and why (§ 7.5d) failing the call would help
 *  nobody. */
export const refreshAtprotoSession = async (
  auth: AtprotoSessionAuth,
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<ConnectionAuth> => {
  const refreshToken = requireAuthString(auth, 'refresh_token');
  const url = atprotoSessionUrl(baseUrl, ATPROTO_REFRESH_SESSION_NSID);
  const tokens = await postAtprotoSession(
    url,
    { headers: { Authorization: `Bearer ${refreshToken}` } },
    fetchImpl,
    ATPROTO_REFRESH_SESSION_NSID,
  );
  return withAtprotoTokens(auth, tokens);
};

/** Deps for the shared OAuth2 refresh gate — a subset of `ConnectionApiHandlerDeps`.
 *  The `connection.mcp` handler supplies the same shape so both kinds share ONE
 *  refresh implementation (single source for the single-flight + lead-time +
 *  best-effort-persist semantics). */
export interface EnsureFreshAuthDeps {
  /** Persist a refreshed OAuth2 auth back to the connection store. Best-effort:
   *  a failure is swallowed — the fresh token is still used for the current call;
   *  the next call sees the un-persisted state and refreshes again (wasteful but
   *  safe). */
  persistAuth: (
    row: ConnectionRow,
    newAuth: ConnectionAuth,
    configPatch?: { base_url: string },
  ) => Promise<void>;
  /** fetch implementation. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Wall-clock source. Defaults to `Date.now`. */
  now?: () => number;
  /** D-218 § 7.5d — a refreshed credential could not be written back.
   *
   *  ⛔ **The swallow stays non-fatal and stops being SILENT.** Failing the call
   *  would help nobody: the exchange already invalidated the stored token one
   *  step earlier, so failing destroys a successful call and recovers nothing.
   *  But for a single-use rotating credential the swallow is not free either —
   *  the durable row now holds a DEAD token, and the next call pays an extra
   *  round trip to discover that and log in again. Recoverable, and worth
   *  seeing.
  *
  *  Absent ⇒ silent, exactly as before (test harnesses, dbless boots). */
  onPersistFailure?: (row: ConnectionRow, error: unknown) => void;
  /** A registered provider omitted or malformed its refresh-response runtime
   * base. The credential is still persisted (rotation may already have made the
   * old refresh token unusable), but the unsafe destination is ignored. */
  onRuntimeBaseIssue?: (
    row: ConnectionRow,
    issue: Extract<VendorOAuthRuntimeBaseResolution, { status: 'missing' | 'invalid' }>,
  ) => void;
}

export interface FreshConnectionAuth {
  auth: ConnectionAuth;
  /** Valid provider-issued replacement for `config.base_url`. */
  runtime_base_url?: string;
}

const registeredProviderForRow = (
  row: ConnectionRow,
): ConnectionVendorProvider | null => {
  try {
    const parsed: unknown = JSON.parse(row.config_json);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const vendor = (parsed as Record<string, unknown>).vendor;
    return typeof vendor === 'string' ? getVendorProvider(vendor) : null;
  } catch {
    return null;
  }
};

/** Build the "refresh the OAuth2 access token if it's missing or within the
 *  lead window" gate shared by the `connection.api` + `connection.mcp` handlers.
 *  Non-oauth2 auth passes through untouched. Both refresh-token and
 *  client-credentials grants use this same gate. A per-`row.pk` single-flight map
 *  (one per gate instance) collapses concurrent calls touching the same
 *  connection onto one in-flight refresh; the map clears on settle so a
 *  later-expired token re-enters the path. The rotated token is persisted
 *  best-effort.
 *
 *  One gate instance per handler instance, so the single-flight only collapses
 *  refreshes WITHIN that instance. Multiple instances in the SAME process (the
 *  executor handler + the watch poll-source handler each build their own) hold
 *  separate maps, so a concurrent refresh of the same connection across
 *  instances can double-refresh and last-writer-wins on the store upsert — the
 *  same pre-existing behavior as the api handler. Tolerable because each refresh
 *  yields a usable token and a stale write self-heals on the next call; a
 *  process-wide gate or a versioned/CAS upsert would tighten it (follow-up).
 *  Across processes (server vs extension) refreshes are independent by design;
 *  LWW on `updated_at` + OAuth2-issuer revocation resolve that cross-runtime
 *  race. */
export const createEnsureFreshAuthDetailed = (
  deps: EnsureFreshAuthDeps,
): ((row: ConnectionRow, auth: ConnectionAuth) => Promise<FreshConnectionAuth>) => {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = deps.now ?? (() => Date.now());
  const refreshFlight = new Map<string, Promise<FreshConnectionAuth>>();

  /** Run ONE credential exchange per row at a time, then persist it.
   *
   *  ⚠ **Extracted by D-218 so both auth families share it**, rather than the
   *  new one growing a second copy of the single-flight and drifting from this
   *  one. `produce` is the only difference between them.
   *
   *  ⛔ **The persist failure is NOT recoverable by retrying, and the comment
   *  that used to sit here said the opposite.** It read: *"the next call just
   *  re-refreshes from the un-persisted state — wasteful but safe."* That is
   *  true for OAuth2, where the old refresh token generally still works. It is
   *  FALSE for a single-use rotating credential: the exchange already
   *  invalidated the stored token, so the un-persisted state is not
   *  stale-but-usable, it is dead.
   *
   *  🔑 Failing the call here would not help either — the invalidation happened
   *  one step earlier, inside `produce`, so failing would destroy a SUCCESSFUL
   *  call and recover nothing (§ 7.5d). The recovery is the retained app
   *  password: the next call finds a dead refresh token and logs in again, and
   *  `onPersistFailure` makes the cost of that visible instead of silent.
   *
   *  ⚠ **The same recovery covers the CROSS-RUNTIME race, and it is the only
   *  thing that does.** This map is per handler instance, so a server and an
   *  extension refreshing the same connection concurrently each get a token and
   *  one of them ends up holding a copy the other already invalidated. For
   *  OAuth2 that is benign — the comment below says LWW plus issuer revocation
   *  resolve it, and for OAuth2 they do. **There is no issuer here that
   *  tolerates it** (D-218 § 5b). What makes it survivable is that a dead
   *  refresh token is not a dead connection: it is one extra login. */
  const exchangeInFlight = (
    row: ConnectionRow,
    produce: () => Promise<FreshConnectionAuth>,
  ): Promise<FreshConnectionAuth> => {
    const existing = refreshFlight.get(row.pk);
    if (existing) return existing;
    const flight = (async () => {
      try {
        const next = await produce();
        // Still within the single-flight, before the map clears in `finally`.
        try {
          await deps.persistAuth(
            row,
            next.auth,
            next.runtime_base_url === undefined
              ? undefined
              : { base_url: next.runtime_base_url },
          );
        } catch (e) {
          // Non-fatal by ruling, not by convenience — see the block comment
          // above. ⚠ But no longer silent: a swallowed write costs a real extra
          // round trip on the next call and points at a storage problem.
          // The sink itself must never break dispatch.
          try { deps.onPersistFailure?.(row, e); } catch { /* sink is advisory */ }
        }
        return next;
      } finally {
        refreshFlight.delete(row.pk);
      }
    })();
    refreshFlight.set(row.pk, flight);
    return flight;
  };

  return async (row: ConnectionRow, auth: ConnectionAuth): Promise<FreshConnectionAuth> => {
    // D-218 — an AT Protocol session takes the same single-flight and the same
    // persist, and a DIFFERENT freshness rule.
    //
    // ⛔ **There is no clock here, deliberately (§ 7.5a).** The protocol
    // supplies no `expires_in` and tells clients its tokens are opaque, so
    // there is no honest number to compare against `now()`. A row that HAS a
    // token is treated as fresh; an expired one earns a 401, and reacting to
    // that is slice 2. Until then a stale session surfaces as an auth error
    // rather than silently renewing on a guessed schedule — which is the
    // honest failure, not a convenient one.
    if (auth.type === 'atproto_session') {
      // ⚠ `.trim()`, matching `injectAuth` exactly. A whitespace-only token
      // would otherwise read as "fresh" here and be REJECTED there — the row
      // would fail every dispatch with no exchange ever attempted, which a
      // slice-0 test caught by asserting the whitespace case.
      if (typeof auth.current_access_token === 'string'
        && auth.current_access_token.trim() !== '') {
        return { auth };
      }
      return exchangeInFlight(row, async () => {
        const baseUrl = readBaseUrl(row);
        const hasRefresh = typeof auth.refresh_token === 'string'
          && auth.refresh_token.trim() !== '';
        if (!hasRefresh) {
          return { auth: await createAtprotoSession(auth, baseUrl, fetchImpl) };
        }
        try {
          return { auth: await refreshAtprotoSession(auth, baseUrl, fetchImpl) };
        } catch (e) {
          // D-218 § 7.5c — the retained app password earning its keep. A
          // refresh token dies for ordinary reasons: it aged out, the session
          // was revoked, or a previous rotation failed to persist. Logging in
          // again turns every one of those from a dead connection into one
          // extra request.
          //
          // ⛔ **But only when the server actually REJECTED the refresh.** The
          // app password is the most valuable thing this row holds, and it is
          // sent only where there is reason to believe it will help:
          //
          //   - a status-carrying rejection (4xx/5xx) ⇒ the TOKEN is the
          //     problem, and a fresh login is exactly the fix;
          //   - a cross-origin redirect refusal ⇒ ⛔ NEVER. Our own guard just
          //     refused to hand this endpoint a REFRESH token; handing it the
          //     account credential instead is the worst possible response;
          //   - a network failure or a malformed response ⇒ the request never
          //     landed or the server is broken. A login would fail the same
          //     way, so it buys nothing and transmits the credential for
          //     nothing.
          //
          // ONE attempt. A failed login throws, and the caller sees the login's
          // error rather than the refresh's — the more actionable of the two.
          const status = (e as IngredientError)?.details?.status;
          if (typeof status !== 'number') throw e;
          return { auth: await createAtprotoSession(auth, baseUrl, fetchImpl) };
        }
      });
    }
    if (!isRenewableOAuth2(auth)) return { auth };
    const expiresAt = auth.expires_at;
    const haveAccessToken = typeof auth.current_access_token === 'string'
      && auth.current_access_token !== '';
    const fresh = haveAccessToken
      && typeof expiresAt === 'number'
      && expiresAt - OAUTH2_REFRESH_LEAD_MS > now();
    if (fresh) return { auth };

    return exchangeInFlight(row, async () => {
      if (auth.type !== 'oauth2_refresh') {
        return { auth: await exchangeOAuth2ClientCredentials(auth, fetchImpl, now) };
      }
      const refreshed = await refreshOAuth2WithMetadata(
        auth,
        fetchImpl,
        now,
        registeredProviderForRow(row),
      );
      if (
        refreshed.runtime_base.status === 'missing'
        || refreshed.runtime_base.status === 'invalid'
      ) {
        try {
          deps.onRuntimeBaseIssue?.(row, refreshed.runtime_base);
        } catch {
          // Advisory only: never sacrifice a successfully rotated credential.
        }
      }
      return {
        auth: refreshed.auth,
        ...(refreshed.runtime_base.status === 'valid'
          ? { runtime_base_url: refreshed.runtime_base.base_url }
          : {}),
      };
    });
  };
};

/** Auth-only compatibility surface used by connection kinds that do not need
 * the refreshed runtime URL for their in-flight request. Persistence still
 * receives the atomic config patch through the detailed gate. */
export const createEnsureFreshAuth = (
  deps: EnsureFreshAuthDeps,
): ((row: ConnectionRow, auth: ConnectionAuth) => Promise<ConnectionAuth>) => {
  const detailed = createEnsureFreshAuthDetailed(deps);
  return async (row, auth) => (await detailed(row, auth)).auth;
};

/** Build the api handler bound to per-runtime deps. The returned
 *  `ConnectionKindHandler` is registered at the boot site:
 *
 *    createConnectionAdapter({
 *      store,
 *      handlers: { api: createConnectionApiHandler({ decodeAuth, persistAuth }) },
 *      ...
 *    })
 *
 *  The single-flight refresh map is closed over the factory call
 *  — one map per handler instance, scoped to one runtime. Servers
 *  + extensions get separate maps; that's correct: each runtime
 *  refreshes independently, with LWW + OAuth2-issuer revocation
 *  resolving cross-runtime races. */
export const createConnectionApiHandler = (
  deps: ConnectionApiHandlerDeps,
): ConnectionKindHandler => {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = deps.now ?? (() => Date.now());

  // Per-row single-flight OAuth2 refresh gate (shared with connection.mcp).
  const ensureFreshAuth = createEnsureFreshAuthDetailed({
    persistAuth: deps.persistAuth,
    fetchImpl,
    now,
    ...(deps.onPersistFailure ? { onPersistFailure: deps.onPersistFailure } : {}),
    ...(deps.onRuntimeBaseIssue
      ? { onRuntimeBaseIssue: deps.onRuntimeBaseIssue }
      : {}),
  });

  const handler: ConnectionKindHandler = async (
    record: ConnectionRow,
    params: Record<string, unknown>,
    call: ResolvedCall,
    ctx?: ConnectionHandlerCtx,
  ): Promise<unknown> => {
    // ────────────── D-217 slice 2b-ii-β — the chunked walk ──────────────
    // ⚠ FIRST, before `method` / `path` validation, because a walk HAS no
    // single method or path — it is N requests, each with its own, declared by
    // the op. The commit Gateway above saw exactly one dispatch; the protocol
    // runs here, below it, so one act stays one commit row and one approval
    // (§ 8a amendment).
    //
    // 🔑 The runner calls THIS handler back, once per phase — see
    // `runChunkedUpload`. So every chunk gets the same auth injection, SSRF
    // origin-pinning, redirect policy and response parse as any other request,
    // rather than a second implementation of them that can drift. A phase input
    // never carries the walk key, so the recursion is exactly two deep and
    // `assertNoNestedWalk` pins it.
    if (hasOwn(params, CHUNKED_UPLOAD_WIRE_WALK_KEY)) {
      return runWalk(record, params, call, ctx);
    }

    // ────────────── input validation ──────────────
    const rawMethod = own(params, 'method');
    if (typeof rawMethod !== 'string' || rawMethod === '') {
      throw new IngredientError(
        'INGREDIENT_OUTPUT_VALIDATION_FAILED',
        `connection.api: 'method' is required (got ${typeof rawMethod})`,
        { slug: call.slug, name: record.name },
      );
    }
    const method = rawMethod.toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      throw new IngredientError(
        'INGREDIENT_OUTPUT_VALIDATION_FAILED',
        `connection.api: 'method' must be one of GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS (got '${rawMethod}')`,
        { slug: call.slug, name: record.name, method: rawMethod },
      );
    }
    const rawPath = own(params, 'path');
    if (typeof rawPath !== 'string' || rawPath === '') {
      throw new IngredientError(
        'INGREDIENT_OUTPUT_VALIDATION_FAILED',
        `connection.api: 'path' is required (got ${typeof rawPath})`,
        { slug: call.slug, name: record.name },
      );
    }

    let baseUrl = readBaseUrl(record);

    // ────────────── path param interpolation (D-112 parity) ──────────────
    // The engine's namespace resolver (`resolveDeep`) resolves only
    // namespace refs (`{{config.*}}`, `{{step.*}}`, …) before dispatch —
    // a bare `{{deal_id}}` / `{{contact_id}}` is NOT a namespace, so it
    // survives to here as a literal in `path`. Connection-api wrappers
    // declare such path params as flat input fields (`deal_id: null` +
    // `path: '/crm/v3/objects/deals/{{deal_id}}'`), exactly like the HTTP
    // adapter does; mirror its D-112 pass so the id lands in the URL.
    // `interpolateUrl` applies position-aware encoding + rejects raw `/`
    // injection; `assertUrlSafe` catches a `..` segment a ref value could
    // smuggle in (encodeURIComponent leaves `.` untouched). Run on the raw
    // path BEFORE `new URL`, which would normalise `..`/`.` away. A missing
    // param leaves its `{{ref}}` marker in place (HTTP-adapter parity) —
    // recipe validation requires the wrapper's `null` inputs, so a live
    // call always supplies them.
    let resolvedPath: string;
    try {
      resolvedPath = interpolateUrl(rawPath, (ref) => own(params, ref));
      assertUrlSafe(resolvedPath);
    } catch (e) {
      if (e instanceof UrlRefInvalidError) {
        throw new IngredientError(
          'URL_REF_INVALID',
          `connection.api (${call.slug}): ${e.message}`,
          { slug: call.slug, name: record.name, ref: e.ref },
        );
      }
      throw e;
    }

    // ────────────── URL construction ──────────────
    // D-192 #8h — `composeApiUrl` preserves the base_url's path prefix for a leading-slash
    // op path (OpenAPI server+path concatenation); a bare `new URL(path, base)` would REPLACE
    // it, dropping a versioned base segment (`.../v1.0` + `/me/…` → `.../me/…`). Absolute /
    // protocol-relative paths fall through unchanged so the cross-origin guard below still
    // refuses them; an already-rooted continuation cursor (Graph `@odata.nextLink`) is not
    // doubled. `assertUrlSafe(resolvedPath)` (above) still guards `..`/`.` traversal.
    const queryParams = extractDotPrefix(params, 'query');
    const resolveRequestUrl = (apiBase: string): { url: URL; baseOrigin: string } => {
      let nextUrl: URL;
      try {
        nextUrl = composeApiUrl(apiBase, resolvedPath);
      } catch (e) {
        throw new IngredientError(
          'INGREDIENT_OUTPUT_VALIDATION_FAILED',
          `connection.api: cannot resolve path '${resolvedPath}' against base_url '${apiBase}': ${(e as Error).message}`,
          { slug: call.slug, name: record.name },
        );
      }
      // Cross-origin guard (Codex review HIGH). A path that resolves to a
      // DIFFERENT origin than base_url — absolute `scheme://host`,
      // protocol-relative `//host`, or a backslash trick `new URL` normalizes —
      // would send the request WITH the connection's auth to an attacker host.
      let nextBaseOrigin = '';
      try {
        nextBaseOrigin = new URL(apiBase).origin;
      } catch { /* readBaseUrl already validated the stored base; refreshed bases are normalized. */ }
      if (nextUrl.origin !== nextBaseOrigin) {
        throw new IngredientError(
          'URL_REF_INVALID',
          `connection.api (${call.slug}): resolved path '${resolvedPath}' changes the origin to `
            + `'${nextUrl.origin}' (base_url origin '${nextBaseOrigin}') — cross-origin dispatch refused`,
          { slug: call.slug, name: record.name },
        );
      }
      for (const [k, v] of Object.entries(queryParams)) {
        if (Array.isArray(v)) {
          for (const item of v) appendQueryScalar(nextUrl.searchParams, k, item);
        } else {
          appendQueryScalar(nextUrl.searchParams, k, v);
        }
      }
      return { url: nextUrl, baseOrigin: nextBaseOrigin };
    };
    let { url, baseOrigin } = resolveRequestUrl(baseUrl);

    // ────────────── headers + body ──────────────
    const headerInputs = extractDotPrefix(params, 'header');
    const headers = new Headers();
    for (const [k, v] of Object.entries(headerInputs)) {
      headers.set(k, String(v));
    }
    // D-216 — an upload body short-circuits the JSON/form path and brings
    // its own Content-Type (a generated multipart boundary, or the record's
    // own type). GET/HEAD never carry one.
    const upload = method === 'GET' || method === 'HEAD'
      ? undefined
      : await buildUploadBody(params, headers, deps);
    if (upload !== undefined) headers.set('Content-Type', upload.contentType);
    if (upload?.contentSha256 !== undefined) {
      ctx?.setUploadContentSha256?.(upload.contentSha256);
    }
    const body = upload !== undefined
      ? upload.body
      : method === 'GET' || method === 'HEAD'
        ? undefined
        : buildBody(params, headers);

    // ────────────── auth (decrypt + maybe refresh + inject) ──────────────
    const auth = await deps.decodeAuth(record);
    const refreshed = await ensureFreshAuth(record, auth);
    const liveAuth = refreshed.auth;
    if (
      refreshed.runtime_base_url !== undefined
      && refreshed.runtime_base_url !== baseUrl
    ) {
      baseUrl = refreshed.runtime_base_url;
      ({ url, baseOrigin } = resolveRequestUrl(baseUrl));
    }
    injectAuth(liveAuth, headers, url);

    // ────────────── fetch with timeout ──────────────
    const timeoutMs = resolveTimeoutMs(
      own(params, 'timeout_ms') ?? CONNECTION_API_TIMEOUT_MS,
    );
    const isWrite = isWriteRiskTier(call.risk_tier);
    /** One trip to the target, with its own timeout budget.
     *
     *  ⚠ Extracted by D-218 slice 2 so the 401 path can run it a SECOND time.
     *  Each attempt gets a fresh controller — a retry that inherited an
     *  already-fired abort signal would fail instantly and look like a target
     *  problem. */
    const attempt = async (): Promise<{
      readonly response: Response;
      finish(): void;
    }> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
      };
      try {
        // SSRF: follow redirects manually, pinned to base_url's origin.
        // The cross-origin guard above only covers the INITIAL url; without
        // this a 3xx to an internal / metadata host would be followed
        // (carrying non-stripped custom auth headers) and its body returned
        // to the recipe. Same-origin redirects still work.
        const response = await fetchOriginPinned(fetchImpl, url.toString(), {
          method,
          headers,
          body: body as BodyInit | undefined,
          signal: controller.signal,
        }, baseOrigin);
        return { response, finish };
      } catch (e) {
        finish();
        if (e instanceof IngredientError) throw e;
        if (e instanceof CrossOriginRedirectError) {
          throw new IngredientError(
            'URL_REF_INVALID',
            `connection.api (${call.slug}): ${e.message} — cross-origin redirect refused`,
            { slug: call.slug, name: record.name },
          );
        }
        const isAbort = (e as Error).name === 'AbortError';
        if (isWrite) {
          throw new IngredientError(
            'ACTION_DELIVERY_UNCERTAIN',
            `Write via connection '${record.name}' ${isAbort ? `timed out after ${timeoutMs}ms` : `failed: ${(e as Error).message}`} — outcome cannot be confirmed, please verify state in the target system before retrying`,
            {
              slug: call.slug,
              name: record.name,
              risk_tier: call.risk_tier,
              cause: isAbort ? 'timeout' : 'network',
            },
          );
        }
        if (isAbort) {
          throw new IngredientError(
            'STEP_TIMEOUT',
            `connection.api call to '${record.name}' timed out after ${timeoutMs}ms`,
            { slug: call.slug, name: record.name },
          );
        }
        throw new IngredientError(
          'NETWORK_ERROR',
          `connection.api call to '${record.name}' failed: ${(e as Error).message}`,
          { slug: call.slug, name: record.name },
        );
      }
    };

    let pending = await attempt();
    try {
      let response = pending.response;

    // ────────────── D-218 § 7.5a — reactive re-auth on a 401 ──────────────
    //
    // 🔑 **This is the ONLY retry on this dispatch path, and it is narrow
    // BECAUSE a 401 is a clean rejection.** `ACTION_DELIVERY_UNCERTAIN` exists
    // for 5xx and timeouts because the target may have COMMITTED before the ack
    // was lost. A 401 is different in kind: the request was refused at auth,
    // before the handler, so re-sending it cannot double-apply a write. That is
    // a property of the status code — provable, not a hope about the target —
    // which is why this carve-out does NOT generalise to any other status and
    // must not be widened into one.
    //
    // ⛔ Bounded by four conditions, every one of them load-bearing:
    //
    //   1. **401 ONLY.** ⚠ `classifyHttpError` buckets `401 || 403` into a
    //      single `OAUTH_EXPIRED` throw, so the retry reads the STATUS, not the
    //      error code. A 403 is *authenticated but forbidden* — refreshing
    //      changes nothing and re-sending is pure amplification.
    //   2. **An auth type that can exchange.** `atproto_session` only; OAuth2
    //      has a working expiry gate and widening to it would change a shipped
    //      path with no ruling behind it.
    //   3. **ONCE.** No loop, no ladder. A second 401 is the answer.
    //   4. **Only if the exchange actually CHANGED the token** — otherwise the
    //      retry is byte-identical to the call that just failed.
    //
    // ⚠ A re-exchange that THROWS propagates instead of the 401. That is the
    // more actionable error: "your app password no longer works" tells the
    // owner what to do, where a bare 401 on the op does not.
    if (response.status === 401 && liveAuth.type === 'atproto_session') {
      const staleToken = liveAuth.current_access_token;
      // Clearing the cached token is how the existing gate is asked to exchange
      // — it then refreshes or logs in by its own rule, and the single-flight
      // still collapses concurrent 401s into ONE exchange, which matters
      // doubly when the refresh token is single-use. The cleared copy is local;
      // what gets persisted is built from the row's own credential fields.
      const reauthResult = await ensureFreshAuth(record, {
        ...liveAuth,
        current_access_token: undefined,
      });
      const reauthed = reauthResult.auth;
      // ⚠ This narrowing is what the TYPE SYSTEM needs to read the field off a
      // `ConnectionAuth`, NOT a second guard — the behavioural one is
      // `liveAuth.type` above. A mutation sweep confirmed it: casting past this
      // changes nothing, while deleting the outer check lets an
      // `oauth2_refresh` row retry. Do not "simplify" by trusting this one.
      const freshToken = reauthed.type === 'atproto_session'
        ? reauthed.current_access_token
        : undefined;
      if (freshToken !== undefined && freshToken !== staleToken) {
        // Release the refused response before replacing it — an unread body
        // holds its socket open, and this is the one path that discards a
        // response instead of throwing on it.
        await response.body?.cancel().catch(() => {});
        pending.finish();
        injectAuth(reauthed, headers, url);
        pending = await attempt();
        response = pending.response;
      }
    }

    // ────────────── status classification + body parse ──────────────
    classifyHttpError(response, call.slug, isWrite);

    // SMB-finance slice 3 — response_capture (storage-gdrive `file.download`):
    // read the raw response BODY rather than JSON/text-parsing it, and return
    // base64 bytes + detected mime + filename. The gateway ingests these into
    // the CAS and returns a `file_ref` with the bytes STRIPPED — the bytes
    // transit server memory only, never an op-step value or the audit. Driven
    // by the engine-set `__rc_*` wire keys (see `buildApiDispatchInput`); a
    // recipe arg can never set them (the gateway strips the `__rc_` prefix).
    if (own(params, '__rc_capture') === '1') {
      // Both declared and chunked responses are capped before an attacker can
      // make the server buffer the complete body. This supersedes the former
      // post-arrayBuffer check, which detected an overage only after allocating
      // it in full.
      const bytes = await readBoundedResponseBytes(response, RESPONSE_CAPTURE_MAX_BYTES);
      const ctHeader = response.headers.get('content-type') ?? '';
      const detectedMime = ctHeader.split(';')[0].trim();
      const fallbackMime = String(own(params, '__rc_mime') ?? '');
      const mime_type = detectedMime || fallbackMime || 'application/octet-stream';
      const argFilename = String(own(params, '__rc_filename') ?? '');
      const filename =
        argFilename
        || filenameFromContentDisposition(response.headers.get('content-disposition'))
        || 'download';
      ctx?.setBytes(bytes.byteLength, bodyByteLength(body));
      return {
        status: response.status,
        headers: responseHeadersToObject(response.headers),
        bytes_b64: bytesToBase64(bytes),
        mime_type,
        filename,
      };
    }

    // P4.2 — surface bytes_out (request body length) before body parse.
    // bytes_in lands after parseResponseBody so we know the actual
    // content length even when the server omitted the response header.
    const bytesOut = bodyByteLength(body);
    const parsed = await parseResponseBody(
      response,
      call.slug,
      own(params, '__rc_json_unsafe_integers') === 'string',
    );
    const result = parsed.value;
    const declaredLen = response.headers.get('content-length');
    const bytesIn = declaredLen !== null && Number.isFinite(Number(declaredLen))
      ? Number(declaredLen)
      : parsed.byteLength;
    ctx?.setBytes(bytesIn, bytesOut);

    // ────────────── shape + output mapping ──────────────
    // Spec § 4.1: response shape `{ status, headers, result }`.
    // Wrappers may declare `output` mappings (e.g.
    // `{"result.id": "ticket_id"}`) — apply mapOutput when set so
    // downstream `{{step.<id>.<field>}}` refs hit the wrapper's
    // declared keys rather than the raw `{status, headers, result}`.
    // Empty `output` (test fixtures) → return raw shape.
    const data = {
      status: response.status,
      headers: responseHeadersToObject(response.headers),
      result,
    };
    if (Object.keys(call.output).length === 0) {
      return data;
    }
    return mapOutput(data, call.output, call.fallback);
    } catch (e) {
      if (e instanceof ResponseBodyTooLargeError) {
        if (isWrite) {
          throw new IngredientError(
            'ACTION_DELIVERY_UNCERTAIN',
            `Write via connection '${record.name}' returned an oversized response after request dispatch — outcome cannot be confirmed, please verify state in the target system before retrying`,
            {
              slug: call.slug,
              name: record.name,
              risk_tier: call.risk_tier,
              cause: 'response_too_large',
              max_bytes: e.maxBytes,
            },
          );
        }
        throw new IngredientError(
          'INGREDIENT_OUTPUT_VALIDATION_FAILED',
          `connection.api (${call.slug}): response exceeded the ${e.maxBytes}-byte body limit`,
          {
            slug: call.slug,
            name: record.name,
            max_bytes: e.maxBytes,
            ...(e.declaredBytes !== undefined ? { declared_bytes: e.declaredBytes } : {}),
            ...(e.observedBytes !== undefined ? { observed_bytes: e.observedBytes } : {}),
          },
        );
      }
      if (e instanceof IngredientError) {
        if (isWrite && e.details?.response_body_failure !== undefined) {
          throw new IngredientError(
            'ACTION_DELIVERY_UNCERTAIN',
            `Write via connection '${record.name}' returned an unreadable response after request dispatch — outcome cannot be confirmed, please verify state in the target system before retrying`,
            {
              slug: call.slug,
              name: record.name,
              risk_tier: call.risk_tier,
              cause: e.details.response_body_failure,
            },
          );
        }
        throw e;
      }
      const isAbort = (e as Error).name === 'AbortError';
      if (isWrite) {
        throw new IngredientError(
          'ACTION_DELIVERY_UNCERTAIN',
          `Write via connection '${record.name}' ${isAbort ? `timed out after ${timeoutMs}ms while reading the response` : `returned an unreadable response: ${(e as Error).message}`} — outcome cannot be confirmed, please verify state in the target system before retrying`,
          {
            slug: call.slug,
            name: record.name,
            risk_tier: call.risk_tier,
            cause: isAbort ? 'timeout' : 'response_body',
          },
        );
      }
      if (isAbort) {
        throw new IngredientError(
          'STEP_TIMEOUT',
          `connection.api call to '${record.name}' timed out after ${timeoutMs}ms while reading the response`,
          { slug: call.slug, name: record.name },
        );
      }
      throw new IngredientError(
        'NETWORK_ERROR',
        `connection.api call to '${record.name}' response failed: ${(e as Error).message}`,
        { slug: call.slug, name: record.name },
      );
    } finally {
      discardResponseBody(pending.response);
      pending.finish();
    }
  };

  /** D-217 slice 2b-ii-β — one act, N requests, below the commit boundary.
   *
   *  ⚠ **`call.output` is deliberately EMPTIED for the phases.** A wrapper's
   *  `output` mapping describes the ACT's result, and the act's result is what
   *  FINALIZE returned. Mapping every phase would rewrite the INIT response
   *  before `session_from` — which a manifest writes against the raw
   *  `{status, headers, result}` shape — ever reads it, and the walk would fail
   *  for a reason no author could see. Everything else on `call` is preserved:
   *  `risk_tier` in particular, so each request classifies its errors as the
   *  write it is. */
  const runWalk = async (
    record: ConnectionRow,
    params: Record<string, unknown>,
    call: ResolvedCall,
    ctx?: ConnectionHandlerCtx,
  ): Promise<unknown> => {
    // ⛔ Exclusive, and REFUSED rather than ignored. The walk branch returns
    // before the body builder runs, so a one-shot body shape riding along here
    // would be silently dropped — a caller shipping the wrong body and never
    // learning, which is the precedence hazard `buildUploadBody` refuses for
    // exactly the same reason.
    const collides = [
      CHUNKED_UPLOAD_WIRE_TOKEN_KEY, 'body_binary', 'body_raw',
    ].find((k) => hasOwn(params, k))
      ?? (Object.keys(extractDotPrefix(params, 'body_file')).length > 0
        ? 'body_file.*'
        : undefined);
    if (collides !== undefined) {
      throw new IngredientError(
        'BAD_INPUT',
        `connection.api: ${CHUNKED_UPLOAD_WIRE_WALK_KEY} is exclusive — it cannot combine with ${collides}. The walk builds each request's body itself, one phase at a time`,
        { slug: call.slug, name: record.name },
      );
    }
    let walkInput;
    try {
      walkInput = parseChunkedWalkInput(own(params, CHUNKED_UPLOAD_WIRE_WALK_KEY));
    } catch (e) {
      throw new IngredientError(
        'BAD_INPUT',
        `connection.api (${call.slug}): ${(e as Error).message}`,
        { slug: call.slug, name: record.name },
      );
    }

    if (deps.uploadStaging === undefined) {
      throw new IngredientError(
        'SERVER_NOT_REACHABLE',
        'connection.api: this host cannot stage a file for a chunked upload — the walk fails closed',
        { slug: call.slug, name: record.name },
      );
    }

    // ⛔ Bounded BEFORE decrypting anything. `stagePlaintext` sizes off the
    // metadata path, so an over-ceiling file is refused without touching the
    // ciphertext — and refusing to stage means the walk never starts, so no
    // bytes leave.
    const maxBytes = Math.min(
      walkInput.spec.max_bytes ?? HTTP_CHUNKED_UPLOAD_MAX_BYTES_CEILING,
      HTTP_CHUNKED_UPLOAD_MAX_BYTES_CEILING,
    );
    let staged: { token: string; size_bytes: number };
    try {
      staged = await deps.uploadStaging.stage({
        file_ref: walkInput.file_ref,
        ...(walkInput.expect_sha256 !== undefined
          ? { expect_sha256: walkInput.expect_sha256 }
          : {}),
        max_bytes: maxBytes,
      });
    } catch (e) {
      // A content-pin mismatch lands here: the file changed between the engine
      // sizing it and this staging it. Nothing has been sent.
      throw new IngredientError(
        'BAD_INPUT',
        `connection.api (${call.slug}): cannot stage '${walkInput.file_ref}' for a chunked upload: ${(e as Error).message}`,
        { slug: call.slug, name: record.name },
      );
    }

    let run;
    try {
      run = await runChunkedUpload({
        input: walkInput,
        staged,
        connectionName: record.name,
        now,
        performPhase: (phaseParams, phaseCtx) =>
          handler(record, phaseParams, { ...call, output: {} }, phaseCtx),
      });
    } catch (e) {
      // Refused before the first request — a declaration that fails the § 8a
      // predicate at run time, an over-ceiling file, a size that no longer
      // matches the plan, or a count that does not match the one approved. No
      // bytes left, so there is nothing to record.
      if (e instanceof IngredientError) throw e;
      throw new IngredientError(
        'BAD_INPUT',
        `connection.api (${call.slug}): ${(e as Error).message}`,
        { slug: call.slug, name: record.name },
      );
    } finally {
      // ⚠ Not best-effort housekeeping — this is the owner's decrypted
      // plaintext. The boot sweep is the backstop for a SIGKILL, not a
      // substitute for disposing on every exit path including a throw.
      // A failing dispose must not mask the walk's own outcome.
      await deps.uploadStaging.dispose(staged.token).catch(() => {});
    }

    // ⛔ BEFORE the throw below, never after. § 6.3 — a walk that failed at
    // chunk k still sent k chunks to a third party, and the audit records what
    // LEFT rather than what was intended. The adapter's emit closure reads
    // these on the error path too, so this is what makes a failed upload a
    // truthful row instead of a no-op.
    ctx?.setBytes(run.bytes_in, run.bytes_out);
    // ⚠ The bytes alone cannot tell a complete upload from an abandoned one
    // that moved the same volume — and `committed_unconfirmed` is an `ok` row
    // like `committed`, so without this the § 8.1 distinction dies here.
    ctx?.setChunkedUpload?.({
      outcome: run.outcome,
      chunks_sent: run.chunks_sent,
      chunk_count: walkInput.count,
      requests: run.requests,
    });

    if (run.outcome === 'processing_failed') {
      throw new IngredientError(
        'NETWORK_ERROR',
        `Chunked upload via connection '${record.name}' was finalized, but the target reported terminal processing failure: ${run.message ?? 'no detail'}`,
        {
          slug: call.slug,
          name: record.name,
          chunks_sent: run.chunks_sent,
          bytes_sent: run.bytes_sent,
          requests: run.requests,
        },
      );
    }

    if (run.outcome === 'failed') {
      const detail = {
        slug: call.slug,
        name: record.name,
        chunks_sent: run.chunks_sent,
        bytes_sent: run.bytes_sent,
        requests: run.requests,
      };
      // ⛔ A failed FINALIZE is NOT a definite failure. Fail-closed guarantees
      // the commit request is unreachable after a bad chunk — so `failed` means
      // "never created" for every phase EXCEPT this one, where the commit
      // request did go out and its outcome is precisely what could not be
      // confirmed. Reporting it as definite invites the retry that double-posts,
      // which is the same hazard § 8.1 rules on for the poll.
      if (run.failed_phase === 'finalize') {
        throw new IngredientError(
          'ACTION_DELIVERY_UNCERTAIN',
          `Chunked upload via connection '${record.name}' sent all ${run.chunks_sent} chunk(s) but could not confirm the commit request: ${run.message ?? 'no detail'} — verify in the target system before retrying, a retry may double-post`,
          detail,
        );
      }
      // Everything else fails closed: FINALIZE was never sent, so the asset was
      // never created. Re-thrown under the code the single request produced, so
      // a 403 on chunk 3 still reads as a 403.
      const cause = run.failed_error;
      throw new IngredientError(
        cause?.code ?? 'BAD_INPUT',
        `Chunked upload via connection '${record.name}' failed at ${run.failed_phase ?? 'the walk'} after ${run.chunks_sent} of ${walkInput.count} chunk(s); no commit request was sent, so nothing was created. ${run.message ?? ''}`.trim(),
        detail,
      );
    }

    // ⚠ FINALIZE's response, and no other phase's — the INIT handle is state
    // the WALK owns and must not become a step value (§ 4.1).
    const data = {
      ...(isRecord(run.result) ? run.result : { result: run.result }),
      upload: {
        outcome: run.outcome,
        requests: run.requests,
        chunks_sent: run.chunks_sent,
        bytes_sent: run.bytes_sent,
        ...(run.message !== undefined ? { message: run.message } : {}),
      },
    };
    if (Object.keys(call.output).length === 0) {
      return data;
    }
    return mapOutput(data, call.output, call.fallback);
  };

  return handler;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
