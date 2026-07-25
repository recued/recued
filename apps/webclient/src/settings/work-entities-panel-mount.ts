/** Settings → Work Entities panel mount (D-145 PA11).
 *
 *  The webclient mount for the ui-shared `renderWorkEntitiesPanel`
 *  renderer. PA11 shipped the renderer + its state shape + its tests;
 *  **nothing ever mounted it**, so `work_entity.source.set_mcp_exposed`
 *  had zero callers and the per-Source `mcp_exposed` flag — which
 *  boots `false` (`work-entity-source-boot.ts:491,711`) — could never
 *  be flipped by any shipped surface. That made the external half of
 *  `work.search` / `work.read` return `entities: []` +
 *  `hidden_sources: N` to every MCP door, permanently: the read tools
 *  are real + wired + tested, but their owner opt-in had no door.
 *  This module is that door.
 *
 *  ## Key design decisions (READ before touching)
 *
 *  DD#1 — Caller seams are narrow Promise functions, mirroring
 *  `llm-result-cache-card-mount.ts` (DD#1 there). The route wires
 *  `() => rpcConn.call('work_entity.source.list', undefined)` etc. so
 *  this module stays agnostic to the rpc layer; tests inject fakes.
 *
 *  DD#2 — `host.innerHTML = renderWorkEntitiesPanel(state)` + a
 *  delegated `change` listener. The ui-shared renderer is a pure HTML
 *  string builder that escapes every source-supplied string via `e()`.
 *  The panel's controls are checkboxes + a `<select>`, so the
 *  delegator listens on `change`, NOT `click` (the cache card's
 *  buttons are the click case).
 *
 *  DD#3 — **All five seams are REQUIRED; the mount is all-or-nothing.**
 *  Unlike the cache card (whose Clear button hides when `runClear` is
 *  omitted), `renderWorkEntitySourceRow` renders BOTH toggles
 *  unconditionally — it has no read-only mode. Mounting with a write
 *  seam missing would paint a live-looking checkbox that silently does
 *  nothing, which is the exact failure this file exists to fix. So the
 *  route gates the mount on all five callers being present rather than
 *  degrading. An unwired seam must render NOTHING, never a dead
 *  control.
 *
 *  DD#4 — Post-write patch, no refetch. `set_enabled` /
 *  `set_mcp_exposed` return the post-write row as `effective`; we
 *  splice it into `sources` by id (the state doc's own contract:
 *  "every toggle rpc returns the post-write Source row + the renderer
 *  patches it into `sources` without a follow-up read"). `set_default`
 *  / `clear_default` return no row, so the per-kind default map is
 *  patched from the request we just made.
 *
 *  DD#5 — Optimism is deliberately absent. A toggle paints `pending`
 *  (both checkboxes disabled) and only moves once the server's
 *  `effective` row lands. `mcp_exposed` governs whether a Source's
 *  rows leave the house to an external door; a checkbox that paints ON
 *  before the server agrees would misreport the boundary state. The
 *  rendering is a claim about what is true server-side.
 *
 *  DD#6 — Per-control error slots. A failed toggle lands in
 *  `pending_by_source[source_id].error`; a failed default lands in
 *  `pending_by_default[kind].error`. Page-level `error` is reserved for
 *  a failed LIST — a write failure must never blank the panel.
 *
 *  DD#7 — Stale-load guard mirrors the cache card: `doLoad` captures
 *  the generation before awaiting and drops a superseded response, so
 *  two refreshes in flight can't paint the older snapshot last.
 *
 *  Spec: docs/d-145-spec.md § PA11 + § A.2. */

import {
  WORK_ENTITY_KINDS,
  type SourceRegistration,
  type WorkEntityKind,
} from '@recued/contracts';
import {
  EMPTY_WORK_ENTITIES_PANEL_STATE,
  renderWorkEntitiesPanel,
  type WorkEntitiesPanelState,
} from '@recued/ui-shared/server-settings/work-entities';

import { humanizeRpcError } from '../shell/rpc-error-copy.js';

/** Re-exported so the route imports the panel's styles + its mount from
 *  ONE module (mirroring `housekeeping-panel-mount.ts`, which defines
 *  its own). The rules live in ui-shared beside the renderer that emits
 *  the class names. */
export { WORK_ENTITIES_PANEL_STYLES } from '@recued/ui-shared/server-settings/work-entities';

// ════════════════════════════════════════════════════════════════
// Attribute constants — stable hooks for DOM tests + host introspection
// ════════════════════════════════════════════════════════════════

export const WORK_ENTITIES_PANEL_HOST_ATTR =
  'data-recued-work-entities-host';

/** `data-action` values the ui-shared renderer emits. Inlined here so
 *  the change delegator can branch without importing renderer
 *  internals (`source-row.ts` / `kind-section.ts` author them). */
const ACTION_SET_ENABLED = 'set-source-enabled';
const ACTION_SET_MCP_EXPOSED = 'set-source-mcp-exposed';
const ACTION_SET_DEFAULT = 'set-default-source';

// ════════════════════════════════════════════════════════════════
// Caller seams + handle
// ════════════════════════════════════════════════════════════════

/** `work_entity.source.list` — every registered Source + the per-kind
 *  default map, in one round-trip. */
export type WorkEntitiesPanelSourceListCaller = () => Promise<{
  sources: ReadonlyArray<SourceRegistration>;
  defaults_by_kind: Readonly<Partial<Record<WorkEntityKind, string>>>;
}>;

/** `work_entity.source.set_enabled` — returns the post-write row. */
export type WorkEntitiesPanelSetEnabledCaller = (args: {
  source_id: string;
  enabled: boolean;
}) => Promise<{ ok: true; effective: SourceRegistration }>;

/** `work_entity.source.set_mcp_exposed` — returns the post-write row.
 *  THE reason this mount exists: no other shipped surface calls it. */
export type WorkEntitiesPanelSetMcpExposedCaller = (args: {
  source_id: string;
  mcp_exposed: boolean;
}) => Promise<{ ok: true; effective: SourceRegistration }>;

/** `work_entity.source.set_default` — pins a per-kind default Source. */
export type WorkEntitiesPanelSetDefaultCaller = (args: {
  kind: WorkEntityKind;
  source_id: string;
}) => Promise<{ ok: true }>;

/** `work_entity.source.clear_default` — drops the per-kind default.
 *  `cleared: false` when nothing was pinned (not an error). */
export type WorkEntitiesPanelClearDefaultCaller = (args: {
  kind: WorkEntityKind;
}) => Promise<{ ok: true; cleared: boolean }>;

export interface MountWorkEntitiesPanelOptions {
  /** Host element the panel renders into. Owned wholesale —
   *  `innerHTML` writes wipe + replace the inner DOM on every state
   *  transition. `dispose()` clears it + drops the listener. */
  host: HTMLElement;
  /** Read seam (DD#1). Fired on mount + on every `refresh()`. */
  runSourceList: WorkEntitiesPanelSourceListCaller;
  /** Write seams (DD#1, DD#3) — all required; see DD#3 for why there
   *  is no read-only degradation. */
  runSetEnabled: WorkEntitiesPanelSetEnabledCaller;
  runSetMcpExposed: WorkEntitiesPanelSetMcpExposedCaller;
  runSetDefault: WorkEntitiesPanelSetDefaultCaller;
  runClearDefault: WorkEntitiesPanelClearDefaultCaller;
}

export interface WorkEntitiesPanelMount {
  /** Current state snapshot — primary surface for tests + host
   *  introspection. */
  getState(): WorkEntitiesPanelState;
  /** Host-driven refresh — re-issues `work_entity.source.list`. */
  refresh(): Promise<void>;
  /** Initial-load promise — resolves after the first list settles
   *  (success → `error === null`, failure → populated `error`).
   *  `refresh()` updates the tracked promise. */
  whenLoaded(): Promise<void>;
  /** Latest write settle promise — resolves after the in-flight
   *  toggle / default rpc settles. Immediately-resolved when no write
   *  has been fired. Tests await this instead of polling. */
  whenWriteSettled(): Promise<void>;
  /** Tear down the panel DOM + remove the listener. Idempotent. */
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

const isWorkEntityKind = (value: string): value is WorkEntityKind =>
  (WORK_ENTITY_KINDS as ReadonlyArray<string>).includes(value);

export const mountWorkEntitiesPanel = (
  opts: MountWorkEntitiesPanelOptions,
): WorkEntitiesPanelMount => {
  // ── State ────────────────────────────────────────────────────────
  let state: WorkEntitiesPanelState = EMPTY_WORK_ENTITIES_PANEL_STATE;
  let disposed = false;
  let pendingLoad: Promise<void> = Promise.resolve();
  let pendingWrite: Promise<void> = Promise.resolve();
  // Stale-load generation guard (DD#7).
  let loadGeneration = 0;

  opts.host.setAttribute(WORK_ENTITIES_PANEL_HOST_ATTR, '');

  // ── Render ───────────────────────────────────────────────────────
  const render = (): void => {
    if (disposed) return;
    opts.host.innerHTML = renderWorkEntitiesPanel(state);
  };

  const setState = (patch: Partial<WorkEntitiesPanelState>): void => {
    if (disposed) return;
    state = { ...state, ...patch };
    render();
  };

  /** Patch one Source row in place by id (DD#4). A row whose id we
   *  don't know is appended — the server is the authority on what
   *  exists, and dropping it would hide a Source from the panel. */
  const patchSource = (effective: SourceRegistration): void => {
    const known = state.sources.some((s) => s.id === effective.id);
    const sources = known
      ? state.sources.map((s) => (s.id === effective.id ? effective : s))
      : [...state.sources, effective];
    setState({ sources });
  };

  const setSourcePending = (
    source_id: string,
    pending: boolean,
    error: string | null,
  ): void => {
    setState({
      pending_by_source: {
        ...state.pending_by_source,
        [source_id]: { pending, error },
      },
    });
  };

  /** Drop a per-Source slot once a write settles clean — an empty slot
   *  renders as "no pending, no error", which is the resting state. */
  const clearSourcePending = (source_id: string): void => {
    const next = { ...state.pending_by_source };
    delete next[source_id];
    setState({ pending_by_source: next });
  };

  const setDefaultPending = (
    kind: WorkEntityKind,
    pending: boolean,
    error: string | null,
  ): void => {
    setState({
      pending_by_default: {
        ...state.pending_by_default,
        [kind]: { pending, error },
      },
    });
  };

  const clearDefaultPending = (kind: WorkEntityKind): void => {
    const next = { ...state.pending_by_default };
    delete next[kind];
    setState({ pending_by_default: next });
  };

  // ── Transitions ──────────────────────────────────────────────────
  const doLoad = async (): Promise<void> => {
    if (disposed) return;
    const captured = ++loadGeneration;
    // Keep prior `sources` visible across a refresh (no flicker); the
    // renderer only shows the loading placeholder on an empty list.
    setState({ loading: true, error: null });
    try {
      const res = await opts.runSourceList();
      if (disposed || captured !== loadGeneration) return;
      setState({
        loading: false,
        error: null,
        sources: res.sources,
        defaults_by_kind: res.defaults_by_kind,
      });
    } catch (err) {
      if (disposed || captured !== loadGeneration) return;
      setState({ loading: false, error: humanizeRpcError(err) });
    }
  };

  /** Shared body for the two per-Source toggles — identical state
   *  machine, different rpc + payload key (DD#4/DD#5/DD#6). */
  const doSourceToggle = async (
    source_id: string,
    call: () => Promise<{ ok: true; effective: SourceRegistration }>,
  ): Promise<void> => {
    if (disposed) return;
    setSourcePending(source_id, true, null);
    try {
      const res = await call();
      if (disposed) return;
      // Patch the authoritative row FIRST, then drop the pending slot —
      // so the checkbox never paints un-disabled against a stale value.
      patchSource(res.effective);
      clearSourcePending(source_id);
    } catch (err) {
      if (disposed) return;
      // Leave the row as the server last told us it was + surface the
      // failure inline. The checkbox re-renders from `sources`, so a
      // refused toggle visibly springs back — the honest outcome.
      setSourcePending(source_id, false, humanizeRpcError(err));
    }
  };

  const doSetDefault = async (
    kind: WorkEntityKind,
    source_id: string | null,
  ): Promise<void> => {
    if (disposed) return;
    setDefaultPending(kind, true, null);
    try {
      if (source_id === null) {
        await opts.runClearDefault({ kind });
        if (disposed) return;
        const next = { ...state.defaults_by_kind };
        delete next[kind];
        setState({ defaults_by_kind: next });
      } else {
        await opts.runSetDefault({ kind, source_id });
        if (disposed) return;
        setState({
          defaults_by_kind: { ...state.defaults_by_kind, [kind]: source_id },
        });
      }
      clearDefaultPending(kind);
    } catch (err) {
      if (disposed) return;
      setDefaultPending(kind, false, humanizeRpcError(err));
    }
  };

  // ── Delegated change listener (DD#2) ─────────────────────────────
  const onChange = (ev: Event): void => {
    if (disposed) return;
    const target = ev.target as HTMLElement | null;
    if (!target || typeof target.getAttribute !== 'function') return;
    const action = target.getAttribute('data-action');
    if (!action) return;

    if (action === ACTION_SET_ENABLED || action === ACTION_SET_MCP_EXPOSED) {
      const source_id = target.getAttribute('data-source-id');
      if (!source_id) return;
      // Guard a stray change against an in-flight write for the same
      // row: the renderer disables both boxes while pending, but a
      // synthesized event in a fake DOM would leak past the attribute.
      if (state.pending_by_source[source_id]?.pending === true) return;
      const checked = (target as HTMLInputElement).checked === true;
      pendingWrite = doSourceToggle(source_id, () =>
        action === ACTION_SET_ENABLED
          ? opts.runSetEnabled({ source_id, enabled: checked })
          : opts.runSetMcpExposed({ source_id, mcp_exposed: checked }),
      );
      return;
    }

    if (action === ACTION_SET_DEFAULT) {
      const kind = target.getAttribute('data-kind');
      if (!kind || !isWorkEntityKind(kind)) return;
      if (state.pending_by_default[kind]?.pending === true) return;
      const raw = (target as HTMLSelectElement).value;
      // The renderer's "(none — pick at write time)" option carries an
      // empty value; that is the CLEAR gesture, not a malformed id.
      pendingWrite = doSetDefault(kind, raw === '' ? null : raw);
      return;
    }
  };

  opts.host.addEventListener('change', onChange);

  // ── Initial paint + load ─────────────────────────────────────────
  render();
  pendingLoad = doLoad();

  return {
    getState: () => state,
    refresh: () => {
      pendingLoad = doLoad();
      return pendingLoad;
    },
    whenLoaded: () => pendingLoad,
    whenWriteSettled: () => pendingWrite,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      opts.host.removeEventListener('change', onChange);
      opts.host.innerHTML = '';
    },
  };
};
