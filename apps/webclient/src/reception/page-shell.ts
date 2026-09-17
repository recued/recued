/** D-149 follow-on § A.9 — Reception page shell.
 *
 *  The § A.9 spine (`spine.ts`) and the five satellite Settings
 *  surfaces (`abuse-inbox.ts`, `authoring.ts`,
 *  `view-as-visitor.ts`, `templates.ts`,
 *  `launch-wizard.ts`) are all PURE PROJECTION modules — zero
 *  I/O, every `build*Model` a pure function of server-supplied state,
 *  every `build*Dispatch` a payload-shaper. Nothing rendered them and
 *  nothing called the `reception.*` rpc surface. This is that wiring
 *  layer — the one stateful piece that ties the projections to the WS
 *  conn + the broadcast bus.
 *
 *  ── What the shell owns ───────────────────────────────────────────
 *    - **State** — the current `ReceptionPageModel` (the § A.9 list +
 *      status header), the open per-endpoint detail, the Abuse Inbox
 *      subview, the Templates browser, the View-As-Visitor panel, the
 *      out-of-band status context, plus the in-flight / last-error
 *      bookkeeping. `getState()` snapshots it; `subscribe()` makes the
 *      shell observable so the renderer re-renders on every change.
 *    - **Rpc dispatch** — every action method builds its payload via a
 *      satellite's `build*Dispatch` builder, fires the corresponding
 *      `reception.*` rpc through the injected `call` conn, then refetches
 *      + re-projects. The renderer never touches the conn.
 *    - **Broadcast subscription** — on creation the shell subscribes to
 *      the two reception broadcast kinds. `reception.endpoint_changed`
 *      carries only `{ op, endpoint_id }` (no row), so the shell
 *      refetches `reception.endpoints.list` + re-runs
 *      `buildReceptionPageModel` (the spine has no single-row reducer,
 *      by design). `reception.emergency_disabled` carries enough to
 *      apply optimistically — the shell flips the status override + runs
 *      the spine's `reduceReceptionEmergencyDisabled`, then refetches
 *      for the authoritative state.
 *
 *  ── Dependency injection — why the shell does NOT own the WS client ─
 *  `apps/webclient/src/realtime/ws-client.ts` is fire-and-forget
 *  (`send()` only — no request/response correlation). The page shell
 *  needs typed request/response rpc, so it takes an injected `call`
 *  conn (`ReceptionConn`) — the host (the PWA runtime) wires the real
 *  correlation layer; tests inject a deterministic fake. The broadcast
 *  seam is the injected `subscribe` (exactly `BroadcastSubscriber['on']`
 *  — the host passes `subscriber.on`). The clock is injected too. So
 *  the shell stays I/O-free + fully unit-testable, like every other
 *  module under `apps/webclient/src/settings/`.
 *
 *  ── Templates ────────────────────────────────────────────────────
 *  The shell no longer owns a Templates browser satellite: the inline
 *  `state.templates` / `loadTemplates()` were retired when the standalone
 *  templates-browser modal (`templates-mount.ts`, fed by the
 *  route's own `reception.template.list` cache) became the live surface.
 *
 *  Spec: D-149 § A.9 + § A.10 + § A.20.1-A.20.6. */

import {
  RpcError,
  type Conn,
  type EndpointSummary,
  type ReceptionEndpointCreateResult,
  type ReceptionEndpointKind,
  type ReceptionEndpointPreviewResult,
  type ReceptionEndpointRotateReason,
  type ReceptionEndpointRotateResult,
  type ReceptionRpcMethodName,
  type ServerEvent,
  type ServerRpcRegistry,
  type ShareCardsInput,
} from '@recued/contracts';

import type {
  BroadcastListener,
  BroadcastSubscriber,
} from '../realtime/subscriber.js';

import {
  buildReceptionDisableDispatch,
  buildReceptionEmergencyDisableAllDispatch,
  buildReceptionEnableDispatch,
  buildReceptionEndpointDetailModel,
  buildReceptionExtendDispatch,
  buildReceptionPageModel,
  buildReceptionRevokeDispatch,
  buildReceptionRotateDispatch,
  reduceReceptionEmergencyDisabled,
  type ReceptionEndpointDetailModel,
  type ReceptionPageModel,
  type ReceptionStatusInput,
} from './spine.js';
import {
  buildAbuseInboxBanIpDispatch,
  buildAbuseInboxListDispatch,
  buildAbuseInboxUnbanIpDispatch,
  buildAbuseInboxSubviewModel,
  type AbuseInboxSubviewModel,
} from './abuse-inbox.js';
import {
  buildEndpointCreateDispatch,
  buildEndpointPreviewDispatch,
  type ReceptionEndpointCreateDispatch,
  type ReceptionEndpointPreviewDispatch,
  type ReceptionPageUpsertDispatch,
} from './authoring.js';
import {
  buildViewAsVisitorModel,
  previewDispatchArgsFromSummary,
  type ViewAsVisitorModel,
} from './view-as-visitor.js';
import type { LaunchWizardDispatchPlan } from './launch-wizard.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

// ════════════════════════════════════════════════════════════════
// Conn + broadcast wiring types
// ════════════════════════════════════════════════════════════════

/** Typed rpc dispatch narrowed to the `reception.*` method subset of
 *  the full `ServerRpcRegistry`. The host wires a real conn (the WS
 *  envelope sender + request/response correlation layer); tests inject
 *  a deterministic fake. `Pick`-ing the registry keeps the shell from
 *  depending on rpc methods it never calls. */
export type ReceptionConn = Conn<Pick<ServerRpcRegistry, ReceptionRpcMethodName>>;

/** The two broadcast kinds the shell subscribes to on creation. Exposed
 *  as a const so the host can confirm they are in
 *  `WEBCLIENT_DEFAULT_SUBSCRIPTIONS` + tests can assert the registration. */
export const RECEPTION_PAGE_SHELL_BROADCAST_KINDS = [
  'reception.endpoint_changed',
  'reception.emergency_disabled',
] as const;

// ════════════════════════════════════════════════════════════════
// State
// ════════════════════════════════════════════════════════════════

/** A captured rpc failure — code + message only. The renderer resolves
 *  the code to remediation copy through the satellites' closed-list
 *  `*_ERROR_COPY` registries (`RECEPTION_ERROR_COPY`,
 *  `ABUSE_INBOX_ERROR_COPY`, …); the shell stays copy-free. `code` is
 *  the `RpcError.code` for a typed rpc rejection, `'transport'` for a
 *  non-rpc throw (network drop, malformed response). */
export interface ReceptionPageShellError {
  readonly code: string;
  readonly message: string;
}

/** Result of `runLaunchWizard` — the § A.20.1 first-run flow's ordered
 *  substrate operations, executed. */
export interface LaunchWizardRunResult {
  /** Always `true` once the wizard's `reception.page.upsert` lands (the
   *  shell throws — and the renderer surfaces `last_error` — if it does
   *  not, so a `false` is unreachable; the field documents intent). */
  readonly page_upserted: boolean;
  /** One entry per `LaunchWizardDispatchPlan` draft, in planner order —
   *  the kind + the `reception.endpoint.create` result (carrying the
   *  one-shot `share_url_once` the renderer captures via
   *  `setEndpointShare`). */
  readonly created: ReadonlyArray<{
    readonly kind: ReceptionEndpointKind;
    readonly result: ReceptionEndpointCreateResult;
  }>;
}

/** The full observable state of the Reception page. Every field is a
 *  satellite projection (or `null` until first loaded) — the shell never
 *  synthesises display state, it only holds the builders' output. */
export interface ReceptionPageShellState {
  /** § A.9 management spine — `null` until `loadPage()`. */
  readonly page: ReceptionPageModel | null;
  /** Open per-endpoint detail view — `null` when closed. */
  readonly detail: ReceptionEndpointDetailModel | null;
  /** § A.20.5 Abuse Inbox subview — `null` until `loadAbuseInbox()`. */
  readonly abuse_inbox: AbuseInboxSubviewModel | null;
  /** § A.20.2 View-As-Visitor panel — `null` until a preview runs. */
  readonly view_as_visitor: ViewAsVisitorModel | null;
  /** Out-of-band status context the page model is projected against —
   *  the exposure resolution's `/reception` public bit + the
   *  emergency-disable override + the resolved base URL. Seeded from
   *  `deps.initialStatus`; updated via `setStatus()` (exposure change)
   *  or the `reception.emergency_disabled` broadcast (override flip). */
  readonly status: ReceptionStatusInput;
  /** Last rpc failure — cleared at the start of every action; `null`
   *  after any success. */
  readonly last_error: ReceptionPageShellError | null;
  /** True while one or more rpc round-trips are in flight. */
  readonly loading: boolean;
}

// ════════════════════════════════════════════════════════════════
// Shell interface + deps
// ════════════════════════════════════════════════════════════════

/** Injected dependencies. All I/O + the clock enter here so the shell
 *  itself stays pure + unit-testable. */
export interface ReceptionPageShellDeps {
  /** Typed rpc dispatch over the `reception.*` method subset. */
  readonly call: ReceptionConn;
  /** Broadcast-bus subscription seam — exactly `BroadcastSubscriber['on']`.
   *  The host passes `subscriber.on`; the shell registers the two
   *  reception kinds on creation + tears them down on `dispose()`. */
  readonly subscribe: BroadcastSubscriber['on'];
  /** Clock seam — threaded into every `build*Model` projection. */
  readonly now: () => number;
  /** Initial out-of-band status context (see `ReceptionPageShellState.status`). */
  readonly initialStatus: ReceptionStatusInput;
}

/** The Reception page shell — a stateful, observable container wiring
 *  the spine + five satellite projections to the `reception.*` rpc
 *  surface + the broadcast subscription. */
export interface ReceptionPageShell {
  /** Snapshot the current state (a fresh object — safe for renderer
   *  reference-equality checks). */
  getState(): ReceptionPageShellState;
  /** Observe state changes — the listener fires with a fresh snapshot
   *  on every change. Returns an unsubscribe fn. */
  subscribe(listener: (state: ReceptionPageShellState) => void): () => void;
  /** Tear down the broadcast subscriptions. Idempotent. */
  dispose(): void;

  // ── Spine: list + status + lifecycle ────────────────────────────
  /** Fetch `reception.endpoints.list` + re-run `buildReceptionPageModel`. */
  loadPage(): Promise<void>;
  /** Replace the out-of-band status context (e.g. when the exposure
   *  resolution changes) + re-project the page model. Synchronous —
   *  no rpc. */
  setStatus(status: ReceptionStatusInput): void;
  enableEndpoint(endpoint_id: string): Promise<void>;
  disableEndpoint(endpoint_id: string): Promise<void>;
  revokeEndpoint(endpoint_id: string, reason?: string): Promise<void>;
  extendEndpoint(endpoint_id: string, new_expires_at: number | null): Promise<void>;
  /** Fire `reception.endpoint.rotate_token` + refetch the list. Returns
   *  the result — `share_url_once` is one-shot (the substrate never
   *  re-surfaces it), so the renderer captures it from the return value
   *  + registers it via `setEndpointShare`. The post-rotate list refetch
   *  is best-effort: a refetch failure is captured into `last_error` but
   *  never swallows the one-shot result. */
  rotateToken(
    endpoint_id: string,
    reason?: ReceptionEndpointRotateReason,
  ): Promise<ReceptionEndpointRotateResult>;
  emergencyDisableAll(reason?: string): Promise<void>;

  // ── Spine: per-endpoint detail ──────────────────────────────────
  /** Fetch `reception.endpoint.access_log` for `endpoint_id` + build the
   *  detail model (pairing the cached `EndpointSummary` + any share URL
   *  registered via `setEndpointShare`). */
  openDetail(endpoint_id: string): Promise<void>;
  closeDetail(): void;
  /** Register the one-shot share URL + copy for an endpoint so the next
   *  `openDetail` surfaces its § A.20.4 Share Cards. The renderer calls
   *  this after a `createEndpoint` / `rotateToken` while it still holds
   *  the never-re-readable `share_url_once`; the shell holds it (the
   *  share URL is genuinely one-shot — see the spine's DD#4). */
  setEndpointShare(endpoint_id: string, share: ShareCardsInput): void;

  // ── Satellite: authoring (preview → create) + page upsert ───────
  /** Fire `reception.endpoint.preview_draft` + project the result into
   *  the View-As-Visitor panel. Returns the result so the authoring
   *  flow can take the `preview_hash` for the create step. */
  runPreview(dispatch: ReceptionEndpointPreviewDispatch): Promise<ReceptionEndpointPreviewResult>;
  /** Fire `reception.endpoint.create` + refetch the list. Returns the
   *  result (carrying the one-shot `share_url_once`). */
  createEndpoint(dispatch: ReceptionEndpointCreateDispatch): Promise<ReceptionEndpointCreateResult>;
  /** Fire `reception.page.upsert` for the `reception_page` singleton +
   *  refetch the list. */
  upsertReceptionPage(dispatch: ReceptionPageUpsertDispatch): Promise<void>;

  // ── Satellite: View-As-Visitor ──────────────────────────────────
  /** Run `reception.endpoint.preview_draft` for an already-created
   *  endpoint (the detail-view "View as visitor" button) — looks the
   *  `EndpointSummary` up in the loaded list, projects it via
   *  `previewDispatchArgsFromSummary`. */
  previewEndpointAsVisitor(endpoint_id: string): Promise<void>;
  closeViewAsVisitor(): void;

  // ── Satellite: Abuse Inbox ──────────────────────────────────────
  loadAbuseInbox(opts?: {
    since?: number;
    limit?: number;
    cluster_threshold?: number;
  }): Promise<void>;
  banIp(endpoint_id: string, source_ip_hash: string, reason?: string): Promise<void>;
  unbanIp(endpoint_id: string, source_ip_hash: string): Promise<void>;

  // ── Satellite: Launch Wizard orchestration ──────────────────────
  /** Execute a `LaunchWizardDispatchPlan` (built by the renderer via the
   *  launch-wizard satellite's `buildLaunchWizardDispatchPlan`): the
   *  `reception.page.upsert` first, then per draft in planner order
   *  preview → `buildEndpointCreateDispatch({ ...draft, preview_hash })`
   *  → create. Refetches the list at the end. */
  runLaunchWizard(plan: LaunchWizardDispatchPlan): Promise<LaunchWizardRunResult>;
}

// ════════════════════════════════════════════════════════════════
// Factory
// ════════════════════════════════════════════════════════════════

export const createReceptionPageShell = (
  deps: ReceptionPageShellDeps,
): ReceptionPageShell => {
  // ── Internal state ────────────────────────────────────────────
  // The raw `reception.endpoints.list` result — `null` until first
  // loaded. Held separately from `state.page` so `setStatus` /
  // `reduceReceptionEmergencyDisabled` can re-project without a refetch.
  let endpoints: ReadonlyArray<EndpointSummary> | null = null;
  let state: ReceptionPageShellState = {
    page: null,
    detail: null,
    abuse_inbox: null,
    view_as_visitor: null,
    status: deps.initialStatus,
    last_error: null,
    loading: false,
  };
  let inflight = 0;
  /** Monotonic detail-request token (the DD#8 stale-response-guard pattern,
   *  mirrored from `mountReceptionRoute`'s `asksReloadGeneration`). R19 Slice
   *  4 routes the detail view, so `openDetail` / `closeDetail` now RE-MOUNT
   *  the spine over this LONG-LIVED shell — an in-flight `refetchDetail` can
   *  resolve AFTER a later `closeDetail` / `openDetail` (e.g. a Back nav while
   *  the access-log rpc is slow). Without this guard its trailing `setState`
   *  would repopulate `detail` on the now-list route. Bumped at the start of
   *  each `refetchDetail` + by `closeDetail`; a refetch writes only while its
   *  token is still current. */
  let detailRequestSeq = 0;
  /** Captured one-shot share URLs keyed by endpoint id — the share URL
   *  is never re-readable, so `openDetail` can only surface Share Cards
   *  when the renderer registered one via `setEndpointShare`. */
  const shareById = new Map<string, ShareCardsInput>();
  /** Last `loadAbuseInbox` options — replayed after a ban/unban so the
   *  refetched subview keeps the operator's window / threshold. */
  let lastAbuseOpts: { since?: number; limit?: number; cluster_threshold?: number } = {};
  const listeners = new Set<(s: ReceptionPageShellState) => void>();
  const unsubscribers: Array<() => void> = [];
  let disposed = false;

  // ── State plumbing ────────────────────────────────────────────
  const notify = (): void => {
    const snapshot: ReceptionPageShellState = { ...state };
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Listener errors are isolated — one broken renderer must not
        // take down the notify loop (same discipline as the broadcast
        // subscriber's dispatch).
      }
    }
  };

  const setState = (partial: Partial<ReceptionPageShellState>): void => {
    state = { ...state, ...partial };
    notify();
  };

  const captureError = (err: unknown): void => {
    const code = err instanceof RpcError ? err.code : 'transport';
    const message = humanizeRpcError(err);
    setState({ last_error: { code, message } });
  };

  /** Wrap a user-initiated action: clear the prior error, raise the
   *  in-flight flag, capture + re-throw any failure. The caller's
   *  promise rejects on failure (so it can `catch`) AND `last_error` is
   *  set (so a renderer that only observes state still sees it). */
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    inflight += 1;
    setState({ loading: true, last_error: null });
    try {
      return await fn();
    } catch (err) {
      captureError(err);
      throw err;
    } finally {
      inflight -= 1;
      if (inflight === 0) setState({ loading: false });
    }
  };

  // ── Projection ────────────────────────────────────────────────
  const computePage = (): ReceptionPageModel | null =>
    endpoints === null
      ? null
      : buildReceptionPageModel({
          endpoints,
          status: state.status,
          now: deps.now(),
        });

  // ── Private refetch helpers (no `run` wrap — called inside `run` by
  // the public methods, or by the broadcast handlers which catch their
  // own rejections) ─────────────────────────────────────────────────
  const refetchEndpoints = async (): Promise<void> => {
    const result = await deps.call('reception.endpoints.list');
    endpoints = result.endpoints;
    setState({ page: computePage() });
  };

  const refetchDetail = async (endpoint_id: string): Promise<void> => {
    // Claim this detail request; a later openDetail/closeDetail (a Slice 4
    // re-mount) bumps the token + invalidates this in-flight refetch's writes.
    const seq = ++detailRequestSeq;
    // The access-log rpc returns only the log; the row comes from the
    // cached endpoints list. Refetch the list first if it is not loaded.
    if (endpoints === null) await refetchEndpoints();
    const summary = endpoints?.find((e) => e.endpoint_id === endpoint_id);
    if (!summary) {
      // Endpoint not in the list (revoked + filtered out, or a stale id)
      // — clear the detail rather than throw; the renderer shows the
      // "not found" empty state. Skip if a newer request superseded us.
      if (seq === detailRequestSeq) setState({ detail: null });
      return;
    }
    const log = await deps.call('reception.endpoint.access_log', { endpoint_id });
    // A newer openDetail/closeDetail superseded this in-flight refetch (the
    // spine re-mounted over the shared long-lived shell) — drop the stale
    // write so it can't repopulate `detail` on the now-current view.
    if (seq !== detailRequestSeq) return;
    const share = shareById.get(endpoint_id);
    setState({
      detail: buildReceptionEndpointDetailModel({
        summary,
        access_log: log.entries,
        ...(share !== undefined ? { share } : {}),
        now: deps.now(),
      }),
    });
  };

  const refetchAbuseInbox = async (opts: {
    since?: number;
    limit?: number;
    cluster_threshold?: number;
  }): Promise<void> => {
    lastAbuseOpts = opts;
    const { op, ...payload } = buildAbuseInboxListDispatch(opts);
    const result = await deps.call(op, payload);
    setState({
      abuse_inbox: buildAbuseInboxSubviewModel({
        summary: result.summary,
        blocked: result.blocked,
        now: deps.now(),
      }),
    });
  };

  const runPreviewDraft = async (
    dispatch: ReceptionEndpointPreviewDispatch,
  ): Promise<ReceptionEndpointPreviewResult> => {
    const { op, ...payload } = dispatch;
    const result = await deps.call(op, payload);
    setState({
      view_as_visitor: buildViewAsVisitorModel({ result, now: deps.now() }),
    });
    return result;
  };

  // ── Broadcast handlers ────────────────────────────────────────
  const onEndpointChanged: BroadcastListener<'reception.endpoint_changed'> = (
    event,
  ): void => {
    // The broadcast carries only `{ op, endpoint_id }` — no row — so the
    // spine has no single-row reducer: refetch the list + re-project.
    // When the changed endpoint's detail view is open, refresh it too —
    // but CHAINED after the list refetch, never in parallel: `endpoints`
    // is already non-null (the detail is open ⇒ the page has loaded), so
    // a parallel `refetchDetail` would rebuild the detail row from the
    // stale cached summary before the fresh list lands. The `.catch`
    // captures any failure into `last_error` + keeps the floating
    // promise from surfacing an unhandled rejection.
    void refetchEndpoints()
      .then(() =>
        state.detail && state.detail.row.endpoint_id === event.endpoint_id
          ? refetchDetail(event.endpoint_id)
          : undefined,
      )
      .catch(captureError);
  };

  const onEmergencyDisabled: BroadcastListener<'reception.emergency_disabled'> = (
    _event,
  ): void => {
    // Carries `disabled_count` + `reason` — enough to apply optimistically
    // via the spine reducer. Flip the status override + reduce the current
    // page model for instant feedback, then refetch for the authoritative
    // state (which re-projects from raw endpoints + the flipped status).
    const nextStatus: ReceptionStatusInput = {
      ...state.status,
      emergency_disabled: true,
    };
    const optimisticPage =
      state.page !== null ? reduceReceptionEmergencyDisabled(state.page) : null;
    state = { ...state, status: nextStatus, page: optimisticPage };
    notify();
    void refetchEndpoints().catch(captureError);
  };

  // Subscribe on creation — the shell owns the broadcast wiring.
  unsubscribers.push(deps.subscribe('reception.endpoint_changed', onEndpointChanged));
  unsubscribers.push(deps.subscribe('reception.emergency_disabled', onEmergencyDisabled));

  // ── Public surface ────────────────────────────────────────────
  return {
    getState: () => ({ ...state }),

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const off of unsubscribers) {
        try {
          off();
        } catch {
          // Unsubscribe errors are isolated — tear down the rest.
        }
      }
      unsubscribers.length = 0;
      listeners.clear();
    },

    // ── Spine: list + status + lifecycle ──────────────────────────
    loadPage: () => run(refetchEndpoints),

    setStatus: (status) => {
      state = { ...state, status, page: null };
      // Re-project against the new status (no-op page stays `null` if the
      // list has not loaded yet).
      state = { ...state, page: computePage() };
      notify();
    },

    enableEndpoint: (endpoint_id) =>
      run(async () => {
        const { op, ...payload } = buildReceptionEnableDispatch({ endpoint_id });
        await deps.call(op, payload);
        await refetchEndpoints();
      }),

    disableEndpoint: (endpoint_id) =>
      run(async () => {
        const { op, ...payload } = buildReceptionDisableDispatch({ endpoint_id });
        await deps.call(op, payload);
        await refetchEndpoints();
      }),

    revokeEndpoint: (endpoint_id, reason) =>
      run(async () => {
        const { op, ...payload } = buildReceptionRevokeDispatch({
          endpoint_id,
          ...(reason !== undefined ? { reason } : {}),
        });
        await deps.call(op, payload);
        await refetchEndpoints();
      }),

    extendEndpoint: (endpoint_id, new_expires_at) =>
      run(async () => {
        const { op, ...payload } = buildReceptionExtendDispatch({
          endpoint_id,
          new_expires_at,
        });
        await deps.call(op, payload);
        await refetchEndpoints();
      }),

    rotateToken: (endpoint_id, reason) =>
      run(async () => {
        const { op, ...payload } = buildReceptionRotateDispatch({
          endpoint_id,
          ...(reason !== undefined ? { reason } : {}),
        });
        // `rotate_token` mints a fresh one-shot `share_url_once`. The
        // shell does not know the human share-card copy, so it does NOT
        // auto-cache — it RETURNS the result so the renderer captures it
        // + calls `setEndpointShare` with the kind-appropriate copy. The
        // post-rotate refetch is best-effort: a refetch failure is
        // captured into `last_error` but must NOT reject before the
        // caller receives the never-re-readable URL.
        const result = await deps.call(op, payload);
        await refetchEndpoints().catch(captureError);
        return result;
      }),

    emergencyDisableAll: (reason) =>
      run(async () => {
        const { op, ...payload } = buildReceptionEmergencyDisableAllDispatch({
          ...(reason !== undefined ? { reason } : {}),
        });
        await deps.call(op, payload);
        // Flip the local status override so the refetched page projects
        // the emergency-disabled header even before the broadcast lands.
        state = {
          ...state,
          status: { ...state.status, emergency_disabled: true },
        };
        await refetchEndpoints();
      }),

    // ── Spine: per-endpoint detail ────────────────────────────────
    openDetail: (endpoint_id) => run(() => refetchDetail(endpoint_id)),

    closeDetail: () => {
      // Bump the detail token so an in-flight `refetchDetail` (started before
      // this close) drops its trailing write instead of repopulating `detail`
      // after the close — the R19 Slice 4 re-mount race over the shared shell.
      detailRequestSeq += 1;
      setState({ detail: null });
    },

    setEndpointShare: (endpoint_id, share) => {
      // Store only — the detail model holds projected access-log rows,
      // not raw `AccessLogEntry`s, so it cannot be rebuilt in place
      // without a refetch. The next `openDetail(endpoint_id)` reads this
      // map + surfaces the § A.20.4 Share Cards; if the detail is already
      // open the renderer re-opens it to pick the share up.
      shareById.set(endpoint_id, share);
    },

    // ── Satellite: authoring (preview → create) + page upsert ─────
    runPreview: (dispatch) => run(() => runPreviewDraft(dispatch)),

    createEndpoint: (dispatch) =>
      run(async () => {
        const { op, ...payload } = dispatch;
        const result = await deps.call(op, payload);
        // Best-effort refetch — `result.share_url_once` is one-shot, so a
        // post-create list-refetch failure must never reject before the
        // caller receives the create result (it is captured into
        // `last_error` instead).
        await refetchEndpoints().catch(captureError);
        return result;
      }),

    upsertReceptionPage: (dispatch) =>
      run(async () => {
        const { op, ...payload } = dispatch;
        await deps.call(op, payload);
        await refetchEndpoints();
      }),

    // ── Satellite: View-As-Visitor ────────────────────────────────
    previewEndpointAsVisitor: (endpoint_id) =>
      run(async () => {
        if (endpoints === null) await refetchEndpoints();
        const summary = endpoints?.find((e) => e.endpoint_id === endpoint_id);
        if (!summary) {
          throw new RpcError(
            'endpoint_not_found',
            `reception page shell: endpoint '${endpoint_id}' is not in the loaded list — call loadPage() first`,
            404,
            'reception.endpoint.preview_draft',
          );
        }
        const dispatch = buildEndpointPreviewDispatch(
          previewDispatchArgsFromSummary(summary),
        );
        await runPreviewDraft(dispatch);
      }),

    closeViewAsVisitor: () => {
      setState({ view_as_visitor: null });
    },

    // ── Satellite: Abuse Inbox ────────────────────────────────────
    loadAbuseInbox: (opts) => run(() => refetchAbuseInbox(opts ?? {})),

    banIp: (endpoint_id, source_ip_hash, reason) =>
      run(async () => {
        const { op, ...payload } = buildAbuseInboxBanIpDispatch({
          endpoint_id,
          source_ip_hash,
          ...(reason !== undefined ? { reason } : {}),
        });
        await deps.call(op, payload);
        await refetchAbuseInbox(lastAbuseOpts);
      }),

    unbanIp: (endpoint_id, source_ip_hash) =>
      run(async () => {
        const { op, ...payload } = buildAbuseInboxUnbanIpDispatch({
          endpoint_id,
          source_ip_hash,
        });
        await deps.call(op, payload);
        await refetchAbuseInbox(lastAbuseOpts);
      }),

    // ── Satellite: Launch Wizard orchestration ────────────────────
    runLaunchWizard: (plan) =>
      run(async () => {
        // 1. The `reception_page` singleton front door first.
        const { op: pageOp, ...pagePayload } = plan.page_upsert;
        await deps.call(pageOp, pagePayload);
        // 2. Per draft, in the planner's canonical order: preview →
        //    create. Each create gates on the preceding preview's
        //    `preview_hash` (the launch-wizard satellite pre-paired each
        //    preview dispatch with its draft so no re-correlation is
        //    needed here).
        const created: Array<{
          kind: ReceptionEndpointKind;
          result: ReceptionEndpointCreateResult;
        }> = [];
        for (const { draft, preview } of plan.drafts) {
          const previewResult = await runPreviewDraft(preview);
          const createDispatch = buildEndpointCreateDispatch({
            kind: draft.kind,
            packet_declaration: draft.packet_declaration,
            metadata: draft.metadata,
            preview_hash: previewResult.preview_hash,
            ...(draft.expires_at !== undefined
              ? { expires_at: draft.expires_at }
              : {}),
          });
          const { op: createOp, ...createPayload } = createDispatch;
          const result = await deps.call(createOp, createPayload);
          created.push({ kind: draft.kind, result });
        }
        // Best-effort — every `created` result carries a one-shot
        // `share_url_once`; a final list-refetch failure must not reject
        // before the caller receives them.
        await refetchEndpoints().catch(captureError);
        return { page_upserted: true, created };
      }),
  };
};
