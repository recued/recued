/** D-125 Phase 3.1 — connection adapter shell.
 *
 *  The `kind: 'connection'` ingredient adapter — single dispatch
 *  surface for outbound api / mcp / notification calls keyed off
 *  enrolled connection records. Occupies `AdapterRegistry['connection']`
 *  whenever the boot site wires a `connectionStore`; without one the slot
 *  holds D-126's kind-named `unsupported('connection')` default. (It
 *  originally displaced a bespoke `KIND_NOT_YET_IMPLEMENTED` placeholder,
 *  retired once P3 shipped — that code now has no producer anywhere.)
 *
 *  Two entry paths converge here (per spec § 3.1 + § 3.2):
 *
 *    1. Direct invocation — recipes call the kernel `connection`
 *       ingredient (`{slug:'connection', author:'recued', kind:'connection',
 *       permission:'connection.direct', risk_tier:'admin'}`). High-trust
 *       recipes only; the engine's permission + risk-tier gate enforces
 *       `connection.direct` + `admin` before this adapter sees the call.
 *
 *    2. Wrapper invocation — third-party `kind: 'connection'` ingredients
 *       (`slack-post`, `ticket-reader-hubspot`, `mail-get`, …) carry their
 *       own `permission` + `risk_tier` (e.g. `notification_send` / `write`,
 *       `hubspot_read` / `read`); the engine enforces those before
 *       dispatching here. The wrapper's manifest provides
 *       `connection_kind` + `subtype` defaults; the recipe binds
 *       `connection` to a `{{config.<X>}}` picker config var.
 *
 *  `resolveDispatchSlot` (in `./dispatch.ts`) routes BOTH paths through
 *  the connection slot — `kind: 'connection'` wins over kernel-author
 *  routing so the kernel `connection` ingredient lands here, not at the
 *  kernel adapter's slug switch.
 *
 *  Dispatch shell only — the per-kind handlers (`api`, `mcp`,
 *  `notification`) ship in P4.1 / P4.2 / P4.3. P3.1 wires the
 *  binding-resolution + record-lookup + kind-switch contract; missing
 *  per-kind handlers throw a typed `RecipeError` at call time so a
 *  recipe execution exposes a precise diagnostic instead of a silent
 *  undefined-adapter crash. */

import type {
  ChunkedUploadAuditInfo,
  ConnectionKind,
  ConnectionRow,
} from '@recued/contracts';
import { IngredientError, type ResolvedCall } from './types.js';
import type { Adapter } from './dispatch.js';

/** Per-call binding lookup — the adapter calls `store.get(kind, name)`
 *  to fetch the live connection record at dispatch time. The store
 *  reference is passed at factory time so server-side / ext-side
 *  runtimes share the adapter signature; each side wires its own
 *  backing implementation (server: SQLite-backed; ext: IDB-backed).
 *
 *  The lookup MUST surface the latest write — no stale-cache reads.
 *  `enroll` / `update` rpcs and the cloud sync wire (P2.2) write
 *  through the same store; this read sees those writes immediately so
 *  a recipe re-run after re-enrollment uses the new auth without a
 *  process restart. */
export interface ConnectionAdapterStore {
  get(
    kind: ConnectionKind,
    name: string,
  ): ConnectionRow | null | Promise<ConnectionRow | null>;
}

/** D-125 P4.2 — per-handler ctx hook for adapter-level audit telemetry.
 *
 *  Decision recorded: handlers populate `bytes_in` / `bytes_out` on the
 *  audit emission via this ctx parameter, NOT via a return-shape
 *  decoration. P4.1 deferred the choice to the second handler; P4.2
 *  picks ctx because:
 *
 *    1. Return-shape decoration would force every handler to wrap its
 *       result in `{ value, telemetry }`, polluting the wrapper-
 *       ingredient contract — `ticket-reader-hubspot` then has to
 *       unwrap `step.<id>.value.id` instead of `step.<id>.id`.
 *    2. ctx keeps the handler return contract identical to P3.1's
 *       (`Promise<unknown>` — whatever the handler returns flows
 *       verbatim through the adapter to the engine).
 *    3. Future telemetry signals (per-tool-call timings for mcp,
 *       per-channel deliveries for notification) extend ctx with
 *       new methods without re-touching the handler return type.
 *
 *  ctx is OPTIONAL — handlers that don't need telemetry skip the
 *  4th arg entirely. P3.x test stubs (which use `(record, params, call)`
 *  signatures) keep working because the adapter passes ctx as the
 *  4th positional and JS ignores extra args. P4.x handlers opt in
 *  by destructuring `(record, params, call, ctx)`. */
export interface ConnectionHandlerCtx {
  /** Record measured payload sizes for the dispatch's audit row.
   *  Idempotent — last call wins. Handlers measure as soon as the
   *  size is known (bytes_out at request build time, bytes_in at
   *  response read time) and can call this once per call site, or
   *  once at the end with both values. */
  setBytes(bytes_in: number, bytes_out: number): void;
  /** SHA-256 of the resolved one-shot file bytes. The bytes themselves never
   * enter the audit row; this pin answers which stored content was sent. */
  setUploadContentSha256?(content_sha256: string): void;
  /** D-217 § 6.3 — record what a MULTI-REQUEST act actually did.
   *
   *  ⛔ `bytes_out` alone cannot tell a complete upload from an abandoned one
   *  that moved the same volume, and both `committed` and
   *  `committed_unconfirmed` are `status: 'ok'` rows — so without this the
   *  § 8.1 distinction the whole poll ruling turns on dies at the audit
   *  boundary. Called BEFORE the handler throws on a failed walk, so a partial
   *  egress lands on the error row rather than being lost with it.
   *
   *  Optional so the P3.x-era stub handlers (and test ctxs that only need
   *  `setBytes`) stay valid; the real adapter always supplies it. */
  setChunkedUpload?(info: ChunkedUploadAuditInfo): void;
}

/** Per-kind handler signature. Receives the resolved record (raw row
 *  with `auth_ciphertext` opaque — handlers decrypt at invoke time via
 *  their own `decodeAuthFromStorage` plumbing per P4.x), the destructured
 *  `params` block, the original ResolvedCall envelope for risk_tier /
 *  output / fallback access, and an optional ctx hook for audit
 *  telemetry (P4.2 — handlers populate bytes_in/bytes_out via
 *  `ctx.setBytes`). */
export type ConnectionKindHandler = (
  record: ConnectionRow,
  params: Record<string, unknown>,
  call: ResolvedCall,
  ctx?: ConnectionHandlerCtx,
) => Promise<unknown>;

/** D-125 Phase 3.2 — adapter-level audit emission per dispatch.
 *
 *  Spec § 3.3 prescribes one Memory row per adapter call faceted by
 *  transport kind. The adapter assembles the structured shape; the
 *  boot site (server-executor.ts) translates it into an
 *  `AuditLogStore.logActivity` call with the right action code
 *  (`connection_<kind>`), the connection record `name` as `target`,
 *  and the JSON-encoded detail tail. Splitting the shape from the
 *  storage shape keeps the adapter dep-free of `@recued/storage` and
 *  lets ext-side runtimes wire their own audit sink without import
 *  juggling.
 *
 *  Skip semantics — the adapter elides emission entirely when:
 *    1. `connection_kind` is invalid (no transport kind to bucket).
 *    2. `connection` is non-string non-null (programmer-error path —
 *       the recipe author or step-input fanout wrote a number / object
 *       into the binding slot, which would never reach here in normal
 *       flows since the validator catches `null` defaults at install).
 *
 *  Every other path emits exactly once, including:
 *    - `CONNECTION_NOT_BOUND` — picker resolved to empty (`name=''`).
 *    - `CONNECTION_NOT_FOUND` — bound but no record.
 *    - `INGREDIENT_ADAPTER_ALL_FAILED` — no handler wired for the kind.
 *    - Handler success / failure (any thrown error is captured + emitted
 *      with `status: 'error'` before re-throwing).
 *
 *  Emitter failures NEVER break dispatch — the surrounding try/catch
 *  swallows audit-sink errors so a back-pressured audit log can't take
 *  down a recipe run. */
export interface ConnectionAuditEmission {
  /** The wrapper ingredient slug that triggered the dispatch. The boot
   *  site uses this to look up `manifest.permission` for the `intent`
   *  field of the activity-row detail. */
  slug: string;
  /** Transport kind. Maps 1:1 to the activity-row `action` code via
   *  `connection_<kind>` at the boot site. */
  kind: ConnectionKind;
  /** Connection record name (the `connection` step-input value the
   *  picker resolved). Empty string for the `CONNECTION_NOT_BOUND`
   *  emission since no name was bound. */
  name: string;
  /** Connection record `subtype` when the lookup succeeded
   *  (`'slack' | 'telegram' | 'email' | 'in-app'` for notification;
   *  `'rest' | …` for api; `'sse' | 'websocket' | 'stdio'` for mcp).
   *  Omitted on `NOT_BOUND` / `NOT_FOUND` paths where no record was
   *  found. */
  subtype?: string;
  /** Outcome bucket. `'ok'` for handler success; `'error'` for every
   *  thrown path (validation failure post-kind-check, lookup miss,
   *  missing-handler placeholder, handler exception). */
  status: 'ok' | 'error';
  /** Wall-clock ms from adapter entry to emission. */
  duration_ms: number;
  /** Optional payload-size telemetry — handlers (P4.x) populate when
   *  measurable (api: response.headers['content-length']; mcp: encoded
   *  JSON length; notification: per-channel payload bytes). The shell
   *  never sets these — they remain `undefined` until P4.x lands. */
  bytes_in?: number;
  bytes_out?: number;
  /** SHA-256 of the resolved one-shot upload content, when this dispatch sent
   * a stored file. */
  content_sha256?: string;
  /** D-217 § 6.3 — present only on a chunked-upload dispatch. */
  chunked_upload?: ChunkedUploadAuditInfo;
  /** When `status === 'error'`, the captured error code + message. The
   *  code is the `RecipeErrorCode` string (`CONNECTION_NOT_BOUND` /
   *  `CONNECTION_NOT_FOUND` / `INGREDIENT_ADAPTER_ALL_FAILED` for the
   *  shell's emit sites; `INGREDIENT_*_FAILED` / handler-specific codes
   *  once P4.x wires real transports). Non-`IngredientError` throws
   *  surface as `{ code: 'UNKNOWN', message: <toString> }`. */
  error?: { code: string; message: string };
  /** Adapter entry timestamp (epoch ms). Boot site uses this as the
   *  activity-row `timestamp` so the row is ordered by call start, not
   *  by emission completion (the difference is `duration_ms`). */
  ts: number;
  /** D-117 follow-on (post-D-127) — engine-supplied originating recipe
   *  id. Forwarded from `call.stepMeta?.recipe_id` so the boot-site
   *  audit emitter can attach it to the activity row's detail. Absent
   *  for direct adapter callers (kernel `connection` ingredient invoked
   *  via MCP agent / Settings → Connections probe) which never carry
   *  step identity. Empty strings treated as absent. */
  recipe_id?: string;
  /** Same provenance as `recipe_id` — forwarded from
   *  `call.stepMeta?.step_id`. Either both fields are present (engine-
   *  driven calls) or both absent (direct-rpc callers). */
  step_id?: string;
  /** D-128 P6 — platform-reference enrichment scope this call is
   *  operating against. Forwarded from `call.stepMeta?.platform_scope`
   *  when set (vendor reconcilers stamp it before invoking the
   *  connection adapter). Folded into `ConnectionAuditDetail.platform_scope`
   *  so forensic queries can filter `connection_*` activity rows by
   *  enrichment scope (`connection.api.hubspot.deal`) in addition to
   *  the existing connection-name `target` field. Empty strings treated
   *  as absent. */
  platform_scope?: string;
}

export interface ConnectionAdapterDeps {
  /** Live store reference. Server passes the SQLite-backed store from
   *  `backend/server/src/storage/connection-store.ts`; ext passes the
   *  IDB-backed store from `packages/storage/src/connection-store.ts`.
   *  Both expose `.get(kind, name)` returning the live `ConnectionRow`
   *  or null. */
  store: ConnectionAdapterStore;

  /** Per-kind handlers. P3.1 ships with empty handlers — every kind
   *  surfaces `INGREDIENT_ADAPTER_ALL_FAILED` with `{kind: 'connection.<kind>'}`
   *  on the error context. P4.1 / P4.2 / P4.3 wire `api` / `mcp` /
   *  `notification` respectively at the boot site. Tests inject stub
   *  handlers to verify the dispatch routing without running the real
   *  per-kind transports. */
  handlers?: Partial<Record<ConnectionKind, ConnectionKindHandler>>;

  /** D-125 Phase 3.2 — best-effort audit hook. Called once per
   *  dispatch with the structured emission per `ConnectionAuditEmission`.
   *  Errors thrown by the sink are swallowed so audit back-pressure
   *  never fails a recipe run. Omitted in dbless test harnesses + the
   *  ext-side shell wiring (P3.x doesn't ship ext-side audit yet —
   *  the activity log lives on the paired server). */
  emitAudit?: (emission: ConnectionAuditEmission) => void | Promise<void>;

  /** D-177 P2b — pre-dispatch gate, invoked after the record resolves
   *  and BEFORE the per-kind handler crosses the wire. Throw (an
   *  `IngredientError`) to refuse the dispatch — the throw rides the
   *  standard handler-error path (audit emission with the error code,
   *  then re-throw), so a refused call is audited like a failed one.
   *
   *  The server wires the classification gate here: a
   *  `connection-mcp-read` / `connection-mcp-write` kernel dispatch must
   *  name a tool the user has enabled + classified for the connection
   *  (Settings → Connections → Tools) at a classification the manifest
   *  tier covers, and must carry `connection_kind: 'mcp'` — enforced at
   *  dispatch depth so no caller (chat Tier-3, a recipe binding the slug
   *  directly, an inline `recipe.run` recipe) can bypass it. Other slugs
   *  pass through untouched (the closure scopes itself). Absent dep ⇒ no
   *  gate (dbless harnesses / runtimes without the annotation store) —
   *  the additive-dep idiom every other optional hook here follows. */
  gateDispatch?: (args: {
    kind: ConnectionKind;
    record: ConnectionRow;
    params: Record<string, unknown>;
    call: ResolvedCall;
  }) => void;

  /** Wall-clock source. Tests inject a deterministic stub to assert
   *  `duration_ms` math; production wiring leaves it at `Date.now`. */
  now?: () => number;
}

const KNOWN_KINDS: ReadonlySet<ConnectionKind> = new Set<ConnectionKind>([
  'api',
  'mcp',
  'notification',
]);

const isConnectionKind = (v: unknown): v is ConnectionKind =>
  typeof v === 'string' && KNOWN_KINDS.has(v as ConnectionKind);

/** Build the connection adapter from per-runtime deps. The returned
 *  `Adapter` is wired into:
 *
 *    - `createAdapterRegistry({ connection: createConnectionAdapter(deps) })`
 *      at boot sites, replacing D-126's kind-named `unsupported('connection')`
 *      default (which stands only when no `connectionStore` is wired).
 *
 *    - Tests construct the adapter directly with stub handlers + an
 *      in-memory store double to assert the dispatch shell.
 *
 *  No permission or risk-tier assertions here — the gate fires upstream
 *  in `withApprovals` (the standard ingredient-approval wrapper that
 *  every kind shares since D-040). The connection adapter is downstream
 *  of dispatch, which is downstream of `withApprovals`; by the time a
 *  call reaches this adapter, the approval gate has already prompted
 *  (write/admin/destructive) or passed through (read/AI). Direct
 *  kernel-`connection` invocations carry `risk_tier: 'admin'` on the
 *  manifest and route through the admin trust path; wrapper ingredients
 *  carry their own `risk_tier` (write for `slack-post`, read for
 *  `mail-get`, etc.) and gate accordingly.
 *
 *  The wrapper's `permission` field (e.g. `'connection.direct'` for the
 *  kernel ingredient, `'notification_send'` for `slack-post`) is
 *  metadata — D-125 P3.2 wires it to the audit row's `intent` column
 *  for forward-compat with a future per-permission gate, but the
 *  runtime enforcement today is `risk_tier` only ("exactly like every
 *  other ingredient today" per spec § 3.3). The D-125 P3.3 verification
 *  tests at `packages/approvals/src/__tests__/d-125-phase-3-3-connection-gate.test.ts`
 *  pin this contract — denial blocks dispatch + the adapter never sees
 *  the call, step-input cannot spoof a lower tier, varying `permission`
 *  values do not affect dispatch. */
export const createConnectionAdapter = (
  deps: ConnectionAdapterDeps,
): Adapter => {
  const handlers = deps.handlers ?? {};
  const now = deps.now ?? (() => Date.now());

  return async (call: ResolvedCall): Promise<unknown> => {
    const startedAt = now();

    // D-117 follow-on (post-D-127) — capture engine-supplied step
    // identity once at adapter entry. Threaded into every `emit()` call
    // below so direct-rpc callers (no stepMeta) emit unattributed rows
    // and engine-driven calls attribute back to the originating recipe
    // + step. Empty strings are treated as absent at the boot-site
    // emitter — see `createConnectionAuditEmitter`.
    //
    // D-128 P6 — also captures `platform_scope` (the four-segment
    // `connection.api.<vendor>.<entity>` scope a vendor reconciler is
    // operating against). Threaded into emission so forensic queries
    // can filter `connection_*` activity rows by enrichment scope; the
    // empty-string-treated-as-absent convention mirrors the recipe_id /
    // step_id pair.
    const stepRecipeId = call.stepMeta?.recipe_id;
    const stepStepId = call.stepMeta?.step_id;
    const stepPlatformScope = call.stepMeta?.platform_scope;
    const redactSensitiveTransportError = call.stepMeta?.surface_dispatch === true
      && call.stepMeta.surface_dispatch_sensitive === true;

    // P3.2 single-shot emit — every dispatch path past the kind check
    // routes through here. `kind` carries the resolved transport (only
    // set after `isConnectionKind` succeeds); `name` carries the
    // resolved binding (`''` for `NOT_BOUND`); `subtype` carries the
    // record's subtype when the lookup found a row. The closure captures
    // `emitted` so a thrown handler that bubbles past a finally doesn't
    // double-fire (the catch + finally would otherwise both call emit
    // — the catch path emits with the captured error and the finally is
    // a no-op).
    let emitted = false;
    // P4.2 — handler-supplied bytes telemetry. Captured in the dispatch
    // closure and threaded into the emit call so the audit row carries
    // measured payload sizes when a handler opts in via the ctx hook.
    // Both stay `undefined` when the handler skips the ctx parameter
    // (P3.x stub handlers + the placeholder paths) — emit's spread
    // pattern omits undefined fields from the emission shape.
    let bytesIn: number | undefined;
    let bytesOut: number | undefined;
    let uploadContentSha256: string | undefined;
    // D-217 § 6.3 — captured in the SAME closure as the bytes so the error path
    // below emits it too. A walk that failed at chunk k sent k chunks to a third
    // party; the row that records that is the error row, not a success row that
    // never happens.
    let chunkedUpload: ChunkedUploadAuditInfo | undefined;
    const handlerCtx: ConnectionHandlerCtx = {
      setBytes(in_: number, out: number) {
        bytesIn = in_;
        bytesOut = out;
      },
      setUploadContentSha256(contentSha256: string) {
        uploadContentSha256 = contentSha256;
      },
      setChunkedUpload(info: ChunkedUploadAuditInfo) {
        chunkedUpload = info;
      },
    };
    const emit = async (
      kind: ConnectionKind,
      name: string,
      subtype: string | undefined,
      status: 'ok' | 'error',
      error?: { code: string; message: string },
    ): Promise<void> => {
      if (emitted || !deps.emitAudit) return;
      emitted = true;
      try {
        await deps.emitAudit({
          slug: call.slug,
          kind,
          name,
          ...(subtype !== undefined ? { subtype } : {}),
          status,
          duration_ms: now() - startedAt,
          ...(bytesIn !== undefined ? { bytes_in: bytesIn } : {}),
          ...(bytesOut !== undefined ? { bytes_out: bytesOut } : {}),
          ...(uploadContentSha256 !== undefined
            ? { content_sha256: uploadContentSha256 }
            : {}),
          ...(chunkedUpload !== undefined ? { chunked_upload: chunkedUpload } : {}),
          ...(error !== undefined ? { error } : {}),
          ts: startedAt,
          ...(stepRecipeId !== undefined ? { recipe_id: stepRecipeId } : {}),
          ...(stepStepId !== undefined ? { step_id: stepStepId } : {}),
          ...(stepPlatformScope !== undefined ? { platform_scope: stepPlatformScope } : {}),
        });
      } catch {
        // Audit-sink failures must NEVER break dispatch. The retention
        // pruner / pressure gate / SQLite lock contention can all
        // surface failures here; the recipe run continues either way.
      }
    };

    const input = call.input;
    const connection_kind = input.connection_kind;
    const connection = input.connection;

    if (!isConnectionKind(connection_kind)) {
      // No emit — without a valid kind there's no `connection_<kind>`
      // action code to bucket the row under. The validator catches
      // this at install time anyway; runtime arrival means a recipe
      // bypassed the gate (raw bundle install), and the surfaced
      // IOVF is the actionable signal.
      throw new IngredientError(
        'INGREDIENT_OUTPUT_VALIDATION_FAILED',
        `connection adapter: invalid connection_kind '${String(connection_kind)}' (expected api / mcp / notification)`,
        { slug: call.slug, connection_kind },
      );
    }

    // Spec § 3.2 — `CONNECTION_NOT_BOUND` fires when the picker resolved
    // to empty. The user installed a wrapper without binding a connection
    // (or bound one and later deleted it without re-binding). Distinct
    // from `CONNECTION_NOT_FOUND` (bound to a slug, but no record under
    // that slug) so the Kitchen UI can guide them to the picker, not the
    // Settings → Connections page.
    if (
      connection === undefined
      || connection === null
      || (typeof connection === 'string' && connection.trim() === '')
    ) {
      await emit(connection_kind, '', undefined, 'error', {
        code: 'CONNECTION_NOT_BOUND',
        message: `no connection bound for kind '${connection_kind}'`,
      });
      throw new IngredientError(
        'CONNECTION_NOT_BOUND',
        `connection adapter: no connection bound for kind '${connection_kind}' (slug '${call.slug}'). Edit the recipe in Kitchen and bind a connection.`,
        { slug: call.slug, kind: connection_kind },
      );
    }

    if (typeof connection !== 'string') {
      // No emit — programmer-error path (a recipe step input is a
      // number / object / boolean in the connection slot). The shell
      // surfaces IOVF and stops; the audit row would carry no useful
      // signal beyond the type, which is already in the thrown
      // `details`.
      throw new IngredientError(
        'INGREDIENT_OUTPUT_VALIDATION_FAILED',
        `connection adapter: connection name must be a string, got ${typeof connection} (slug '${call.slug}')`,
        { slug: call.slug, kind: connection_kind, connection_type: typeof connection },
      );
    }

    const record = await deps.store.get(connection_kind, connection);
    if (!record) {
      await emit(connection_kind, connection, undefined, 'error', {
        code: 'CONNECTION_NOT_FOUND',
        message: `no ${connection_kind} connection named '${connection}'`,
      });
      throw new IngredientError(
        'CONNECTION_NOT_FOUND',
        `connection adapter: no ${connection_kind} connection named '${connection}' (slug '${call.slug}'). Add it in Settings → Connections.`,
        { slug: call.slug, kind: connection_kind, name: connection },
      );
    }

    // Strip discriminants — every other key flows through to the
    // per-kind handler as `params`. Handlers normalize their own shape
    // (api validates `method` / `path` / `query.*` / `header.*`; mcp
    // pulls `mcp.tool` / `mcp.args`; notification pulls subtype-specific
    // payload fields). P3.1 stops at the dispatch boundary.
    const { connection_kind: _ck, connection: _c, ...params } = input;

    const handler = handlers[connection_kind];
    if (!handler) {
      await emit(connection_kind, connection, record.subtype, 'error', {
        code: 'INGREDIENT_ADAPTER_ALL_FAILED',
        message: `no handler wired for connection.${connection_kind} on this runtime`,
      });
      throw new IngredientError(
        'INGREDIENT_ADAPTER_ALL_FAILED',
        // ⛔ Name the UNWIRED DEPS, never a ship date. This read "the
        // connection.<kind> handler ships in D-125 P4.x" long after P4.1/4.2/4.3
        // all shipped, so the one condition it could describe — a boot site that
        // did not pass this handler's deps — was reported as an unbuilt feature.
        // A reader who believes it goes looking for a release instead of a wire.
        `connection adapter: no handler wired for kind '${connection_kind}' on this runtime (slug '${call.slug}'). The boot site did not supply the connection.${connection_kind} handler's deps — check the connection adapter's \`handlers\` wiring at the executor boot site.`,
        { slug: call.slug, kind: `connection.${connection_kind}`, name: connection },
      );
    }

    try {
      // D-177 P2b — pre-dispatch gate. Fires with the resolved kind +
      // record so the server's classification closure sees exactly what
      // would cross the wire; a throw is audited via the catch below
      // like any handler failure, and the boundary is never crossed.
      deps.gateDispatch?.({ kind: connection_kind, record, params, call });
      const result = await handler(record, params, call, handlerCtx);
      await emit(connection_kind, connection, record.subtype, 'ok');
      return result;
    } catch (e) {
      const code = e instanceof IngredientError
        ? e.code
        : 'UNKNOWN';
      const message = redactSensitiveTransportError
        ? 'sensitive connection dispatch failed without exposing request configuration'
        : e instanceof Error ? e.message : String(e);
      await emit(connection_kind, connection, record.subtype, 'error', { code, message });
      throw e;
    }
  };
};
