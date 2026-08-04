/** D-145 PA11 — Settings → Housekeeping "LLM result cache" card mount.
 *
 *  Webclient surface for the per-pair `llm_result_cache` substrate
 *  shipped in PA9.6 + PA11. The ui-shared `renderHousekeepingLlmResult
 *  CacheCard` is a pure HTML-string renderer; this module is the
 *  webclient mount that drives it — fires `housekeeping.cache.stats`
 *  on mount, wires the three `data-action` click affordances, drives
 *  `housekeeping.cache.clear` through the two-stage inline confirm,
 *  and refreshes stats after a successful clear.
 *
 *  ## Why a mount file and not a panel-render fold
 *
 *  PA11's spec scope was narrow: "Settings → Housekeeping per-pair tab
 *  gains a 'LLM result cache' summary card" (D-145 line
 *  1261). The full housekeeping panel (preset picker / trust radios /
 *  topic-reset modal / detail drawer) has roughly 15 rpcs + 3 realtime
 *  event subscriptions; mounting it wholesale is a ~1000+ LOC slice.
 *  This file mounts JUST the cache card so PA11 ships user-visible
 *  without committing to the full panel-mount substrate. A follow-on
 *  slice mounts the larger panel + nests this card inside it.
 *
 *  ## Key design decisions (READ before touching)
 *
 *  DD#1 — Caller seams are narrow Promise functions, mirroring
 *  `packs-panel.ts` / `conflicts-panel.ts`. The route wires
 *  `() => conn('housekeeping.cache.stats', undefined)` + `() =>
 *  conn('housekeeping.cache.clear', undefined)` from the bootstrap's
 *  rpc conn so this module stays agnostic to the rpc layer. Tests
 *  inject fakes.
 *
 *  DD#2 — `host.innerHTML = renderCard(props)` + delegated click
 *  listener. Mirrors `devices-page-mount.ts` + `reception-prompts-
 *  host.ts`. The ui-shared renderer escapes user-influenced strings
 *  via `e()` (the `error-handler` topic / `_malformed` bucket etc.),
 *  so writing innerHTML is safe. Re-render on every state transition
 *  rebuilds the inner DOM; the host element + the delegated listener
 *  outlive each transition.
 *
 *  DD#3 — `runClear` is optional. When omitted the card renders
 *  read-only — the user sees stats but no Clear button. Mirrors the
 *  `runInstall` discipline in `packs-panel.ts`. The bootstrap supplies
 *  both callers by default; a future restricted-role mount could pass
 *  only `runStats` to gate the destructive operation.
 *
 *  DD#4 — Refresh after successful clear. The clear rpc returns
 *  `rows_deleted` but doesn't return the new stats shape; the panel
 *  re-fires `runStats` after the clear so the rollup zeroes
 *  naturally + the per-topic table empties on the next paint. Mirrors
 *  the post-install refresh in `packs-panel.ts` (DD#8 there).
 *
 *  DD#5 — Errors surface inline + the rendered card chooses where to
 *  put them (load errors paint above the rollup; clear errors paint
 *  beside the Clear button). The ui-shared renderer owns the visual
 *  treatment — this mount just drops the error message into state.
 *
 *  DD#6 — `now` seam mirrors `tls-renew-panel.ts`. Production passes
 *  `Date.now`; tests pin a fixed instant so the rendered "Last GC: Xh
 *  ago" text is reproducible.
 *
 *  Spec: D-145 § A.7.10 + PA11 widening (line 1261). */

import { LLM_RESULT_CACHE_GC_TASK_ID } from '@recued/contracts';
import {
  initialHousekeepingCacheCardState,
  renderHousekeepingLlmResultCacheCard,
  type HousekeepingCacheCardState,
} from '@recued/ui-shared/server-settings/housekeeping';

import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

// ════════════════════════════════════════════════════════════════
// Attribute constants — stable hooks for DOM tests + host introspection
// ════════════════════════════════════════════════════════════════

export const CACHE_CARD_HOST_ATTR = 'data-recued-cache-card-host';

/** `data-action` values fired by the ui-shared renderer's button
 *  primitive. Inlined here so the click delegator can branch without
 *  re-importing button internals; the renderer's `button({ action })`
 *  generates `data-action="<value>"`. */
const ACTION_CLEAR = 'housekeeping-cache-clear';
const ACTION_CLEAR_CONFIRM = 'housekeeping-cache-clear-confirm';
const ACTION_CLEAR_CANCEL = 'housekeeping-cache-clear-cancel';

// ════════════════════════════════════════════════════════════════
// Caller seams + handle
// ════════════════════════════════════════════════════════════════

/** Stats rpc caller seam. Resolves with the substrate's full snapshot
 *  shape verbatim; the panel patches it into `state.stats`. A thrown
 *  error lands in `state.loadError`. */
export type LlmResultCacheStatsCaller = () => Promise<{
  total_entries: number;
  total_hits: number;
  per_topic: ReadonlyArray<{
    topic: string;
    entry_count: number;
    hit_count: number;
  }>;
  last_gc_at: number | null;
}>;

/** Clear rpc caller seam. Resolves with `{ ok: true, rows_deleted }`
 *  on success. A thrown error lands in `state.clearError`; the
 *  rpc-rejection case (`permission_denied` / `unsupported`) also
 *  throws on the conn surface, so both land in the same slot. */
export type LlmResultCacheClearCaller = () => Promise<{
  ok: true;
  rows_deleted: number;
}>;

export interface MountLlmResultCacheCardOptions {
  /** Host element the card renders into. Owned wholesale —
   *  `innerHTML` writes wipe + replace the inner DOM on every state
   *  transition. `dispose()` clears `innerHTML` + drops the listener.
   *  The mount uses only `host.innerHTML` + the click delegator, so no
   *  `document` reference is needed (mirrors `devices-page-mount.ts`
   *  + `reception-prompts-host.ts`'s string-renderer pattern). */
  host: HTMLElement;
  /** Stats rpc caller (DD#1). Fired on mount + after every successful
   *  clear (DD#4). */
  runStats: LlmResultCacheStatsCaller;
  /** Clear rpc caller (DD#1, DD#3). When omitted the card renders
   *  read-only — Clear button hidden, two-stage confirm unreachable. */
  runClear?: LlmResultCacheClearCaller;
  /** `Date.now`-compatible clock for the "Last GC: Xh ago" copy
   *  (DD#6). Defaults to `Date.now`. */
  now?: () => number;
  /** DD#7 — Live broadcast subscription. When provided, the mount
   *  subscribes to `housekeeping_cycle` events on creation and calls
   *  `refresh()` whenever the event's `per_task[]` includes the
   *  `LLM_RESULT_CACHE_GC_TASK_ID` entry — so the rollup + per-topic
   *  table reflect a GC sweep's deletions without the user clicking
   *  Refresh. Pass `subscriber.on` from the webclient's broadcast
   *  subscriber; tests inject a fake matching `BroadcastSubscriber['on']`.
   *
   *  Filter rule: refresh on ANY status (`'complete' | 'yield' |
   *  'error'`) — a yielded GC still likely deleted rows before
   *  yielding, and a refresh is idempotent (re-reads the same stats
   *  if the cache didn't change). Filter ONLY on task_id match.
   *
   *  Optional by design: omitting `subscribe` keeps the card on the
   *  prior poll-after-clear cadence (refresh fires on mount + after
   *  every successful `runClear`). Mirrors `reception-page-shell.ts`'s
   *  subscription discipline — subscribe at creation, unsubscribe on
   *  dispose. */
  subscribe?: BroadcastSubscriber['on'];
}

export interface LlmResultCacheCardMount {
  /** Current state snapshot — primary surface for tests + host
   *  introspection. Returns the closure state by value (defensive
   *  copy of mutable maps + arrays is unnecessary; the slice is
   *  immutable-by-construction at the renderer boundary). */
  getState(): HousekeepingCacheCardState;
  /** Host-driven refresh — re-issues `runStats`. Use after a known
   *  cache mutation happened elsewhere (a future broadcast
   *  subscription would call this on `housekeeping_cache_clear`
   *  audit fan-out). */
  refresh(): Promise<void>;
  /** Initial-load promise — resolves after the first `runStats`
   *  settles (success → `loadError === null`, failure → populated
   *  `loadError`). Subsequent `refresh()` calls + the post-clear
   *  auto-refresh also update the tracked promise. */
  whenLoaded(): Promise<void>;
  /** Latest clear-rpc settle promise — resolves after the in-flight
   *  `runClear` + the chained `runStats` refresh both settle. Returns
   *  an immediately-resolved promise when no clear has been fired.
   *  Tests + hosts use this to await the clear flow without polling. */
  whenClearSettled(): Promise<void>;
  /** True while the destructive cache clear has no terminal result. */
  hasInFlightWork(): boolean;
  /** Tear down the card DOM + remove event listeners. Idempotent. */
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

export const mountLlmResultCacheCard = (
  opts: MountLlmResultCacheCardOptions,
): LlmResultCacheCardMount => {
  const now = opts.now ?? Date.now;

  // ── State ────────────────────────────────────────────────────────
  let state: HousekeepingCacheCardState = initialHousekeepingCacheCardState();
  let disposed = false;
  // Track the in-flight load so test seams + the route can await
  // completion past `refresh()`.
  let pendingLoad: Promise<void> = Promise.resolve();
  // Track the in-flight clear so the confirm-click test seam can
  // await the rpc + the chained refresh.
  let pendingClear: Promise<void> | null = null;
  // Stale-load generation guard — closes the 304th Slice D MINOR
  // finding. `doRefresh` captures this value BEFORE awaiting
  // `runStats`; after the await, a mismatch with `loadGeneration`
  // means a newer kickoff has occurred + this result is stale (drop
  // silently). Without the guard, two `housekeeping_cycle` broadcasts
  // in quick succession could race: the older rpc's response landing
  // last would overwrite the fresher snapshot. The post-clear
  // refresh path threads through the same `doRefresh` so the guard
  // covers it symmetrically. The packs panel ships the same fix
  // (`packs-panel.ts` Slice H / DD#14) — both surfaces share refresh
  // shape so the fix is symmetric.
  let loadGeneration = 0;

  opts.host.setAttribute(CACHE_CARD_HOST_ATTR, '');

  // ── Render ───────────────────────────────────────────────────────
  const render = (): void => {
    if (disposed) return;
    opts.host.innerHTML = renderHousekeepingLlmResultCacheCard({
      state,
      now: now(),
    });
  };

  // ── Transitions ──────────────────────────────────────────────────
  const setState = (patch: Partial<HousekeepingCacheCardState>): void => {
    if (disposed) return;
    state = { ...state, ...patch };
    render();
  };

  const doRefresh = async (): Promise<void> => {
    if (disposed) return;
    // Stale-load guard — pre-increment + capture BEFORE await; drop
    // the result if a newer kickoff has occurred. Both success + error
    // branches re-check so a stale throw can't paint an error chip on
    // top of a fresher success.
    const captured = ++loadGeneration;
    // Preserve prior stats across refresh so the UI doesn't flash
    // back to the loading skeleton; `loading: true` is what `render`
    // reads to surface the spinner alongside the stale snapshot.
    setState({ loading: true, loadError: null });
    try {
      const stats = await opts.runStats();
      if (disposed) return;
      if (captured !== loadGeneration) return; // newer load in flight
      setState({ loading: false, stats, loadError: null });
    } catch (err) {
      if (disposed) return;
      if (captured !== loadGeneration) return; // newer load in flight
      const message = humanizeRpcError(err);
      setState({ loading: false, loadError: message });
    }
  };

  const doClear = async (): Promise<void> => {
    if (disposed) return;
    if (!opts.runClear) return;
    setState({ clearing: true, clearError: null });
    try {
      await opts.runClear();
      if (disposed) return;
      // Close the confirm strip + immediately re-fetch stats so the
      // rollup zeros + the per-topic table empties (DD#4). The post-
      // clear refresh sets its own loading/loadError flags; we don't
      // double-set `clearing: false` until after the refresh settles
      // so the disabled-confirm button outlives the round-trip.
      setState({
        clearing: false,
        confirmingClear: false,
        clearError: null,
      });
      await doRefresh();
    } catch (err) {
      if (disposed) return;
      const message = humanizeRpcError(err);
      setState({ clearing: false, clearError: message });
    }
  };

  // ── Click delegation (DD#2) ──────────────────────────────────────
  const onClick = (ev: Event): void => {
    if (disposed) return;
    const target = ev.target as
      | (HTMLElement & {
          closest?: (selector: string) => HTMLElement | null;
        })
      | null;
    if (!target?.closest) return;
    const actionEl = target.closest('[data-action]') as HTMLElement | null;
    if (!actionEl) return;
    const action = actionEl.getAttribute('data-action');

    if (action === ACTION_CLEAR) {
      // No-op when read-only (no `runClear`) or the stats haven't
      // landed yet — the renderer suppresses the Clear button in
      // both cases, but a fake DOM in tests could still synthesize
      // the click.
      if (!opts.runClear) return;
      if (state.stats === null) return;
      setState({ confirmingClear: true, clearError: null });
      return;
    }
    if (action === ACTION_CLEAR_CANCEL) {
      // Defensive — Cancel is disabled mid-clear, but a stray click
      // through a fake DOM in tests would otherwise leak past the
      // disabled attribute. Guard so the state machine stays
      // deterministic.
      if (state.clearing) return;
      setState({ confirmingClear: false, clearError: null });
      return;
    }
    if (action === ACTION_CLEAR_CONFIRM) {
      if (!opts.runClear) return;
      if (state.clearing) return;
      pendingClear = doClear();
      return;
    }
  };

  opts.host.addEventListener('click', onClick);

  // ── Broadcast subscription (DD#7) ────────────────────────────────
  // Subscribe to `housekeeping_cycle` so the card refreshes whenever
  // the GC sweep completes — rollup zeros + per-topic counts decay
  // without the user clicking. Refresh is idempotent + fire-and-
  // forget; failures land in `state.loadError` via the normal path,
  // never propagate up the broadcast dispatch loop.
  let unsubscribeCycle: (() => void) | null = null;
  if (opts.subscribe) {
    unsubscribeCycle = opts.subscribe('housekeeping_cycle', (event) => {
      if (disposed) return;
      const hit = event.per_task.some(
        (t) => t.task_id === LLM_RESULT_CACHE_GC_TASK_ID,
      );
      if (!hit) return;
      pendingLoad = doRefresh();
    });
  }

  // ── Initial paint + load ─────────────────────────────────────────
  render();
  pendingLoad = doRefresh();

  return {
    getState: () => state,
    refresh: () => {
      pendingLoad = doRefresh();
      return pendingLoad;
    },
    whenLoaded: () => pendingLoad,
    whenClearSettled: () => pendingClear ?? Promise.resolve(),
    hasInFlightWork: () => !disposed && state.clearing,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (unsubscribeCycle) {
        try {
          unsubscribeCycle();
        } catch {
          // Unsubscribe errors are isolated — the broadcast subscriber
          // owns its own teardown; we just need to drop the handle.
        }
        unsubscribeCycle = null;
      }
      opts.host.removeEventListener('click', onClick);
      try {
        opts.host.innerHTML = '';
      } catch {
        // Some fake DOMs throw on innerHTML setter; ignore — the
        // listener is already removed + the host reference is the
        // caller's to retain or drop.
      }
      opts.host.removeAttribute(CACHE_CARD_HOST_ATTR);
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════

/** Self-scoped CSS for the card. The host injects this once at boot
 *  alongside the route's other section styles. Selectors are scoped
 *  to the `.housekeeping-cache-card` class the ui-shared renderer
 *  emits so they don't bleed into adjacent sections. */
export const LLM_RESULT_CACHE_CARD_STYLES = `
.housekeeping-cache-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg);
  font-size: 13px;
}
.housekeeping-cache-card h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.housekeeping-cache-card-summary,
.housekeeping-cache-card-meta,
.housekeeping-cache-card-loading {
  margin: 0;
  line-height: 1.45;
}
.housekeeping-cache-card-meta {
  color: var(--muted);
}
.housekeeping-cache-card-rollup {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(4, max-content);
  gap: 4px 16px;
  padding: 8px 10px;
  background: var(--bg-elev);
  border-radius: 4px;
}
.housekeeping-cache-card-rollup > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.housekeeping-cache-card-rollup dt {
  margin: 0;
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.housekeeping-cache-card-rollup dd {
  margin: 0;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.housekeeping-cache-card-topics {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.housekeeping-cache-card-topics thead th {
  text-align: left;
  font-weight: 600;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  color: var(--muted);
}
.housekeeping-cache-card-topics tbody td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-subtle);
  font-variant-numeric: tabular-nums;
}
.housekeeping-cache-card-topics tbody tr:last-child td {
  border-bottom: none;
}
.housekeeping-cache-card-topics code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  font-size: 11px;
}
.housekeeping-cache-card-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.housekeeping-cache-card-clear-confirm {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
`;
