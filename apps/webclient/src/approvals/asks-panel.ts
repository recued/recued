/** D-169 P2 Slice 3b — webclient D-158 ask (approval) surface.
 *
 *  The webclient counterpart to the bridge side panel's Approvals
 *  section (Slice 3 — `apps/bridge/src/side-panel/views.ts`). Both
 *  clients render each open D-158 `ask` through the ONE shared
 *  `@recued/ui-shared/approval-card` primitive (I-12 / TR-9 — no
 *  per-client copy; a UX change or bug fix lands on both surfaces at
 *  once). This module is what closes I-12 for the webclient: it imports
 *  + renders `renderAskCard`.
 *
 *  ── Data model: server-authoritative; bus + submit trigger a re-fetch ─
 *  The open-ask set is small + bounded (a preflight gate waiting on the
 *  user, D-157), and the server's D-158 ask store is the single source
 *  of truth. So this panel mirrors the Settings → Packs panel's proven
 *  shape (`packs-panel.ts`): seed from the `notification.pending_asks`
 *  rpc, then treat every live signal — a `notification.ask` /
 *  `notification.ask_closed` bus frame, OR a local answer submit — as a
 *  "something changed, re-read the authoritative list" trigger. The bus
 *  frame's payload is NOT consumed for state (same posture packs takes
 *  with `pack_installed`): a re-fetch avoids synthesising a `created_at`
 *  the `notification.ask` wire frame doesn't carry, and avoids a
 *  local-mutation-vs-refresh clobber race. The `loadGeneration` guard
 *  (DD — shared with packs / the cache card) ensures only the freshest
 *  in-flight `runList` writes state when several triggers fire close
 *  together.
 *
 *  ── Submit: first-answer-wins across surfaces ───────────────────────
 *  Clicking an option round-trips `notification.submitAnswer({ ask_id,
 *  option_id })`. The block dedups first-answer-wins across every
 *  surface (D-158 I-6) — a webclient click + a bridge click for the same
 *  ask resolve once; the loser is a silent server-side no-op. The rpc
 *  always acks `{ ok: true }` (it's a no-op on an unknown / already-
 *  answered ask), so on a successful submit the panel retires that ask
 *  immediately and holds a short-lived tombstone while (a) the
 *  `notification.ask_closed` bus frame and (b) a defensive re-fetch
 *  reconcile — both idempotent. A submit
 *  FAILURE (transport / reauth) propagates out of the card's `onAnswer`
 *  promise, which re-enables the card's buttons + shows its own inline
 *  error so the user can retry (the shared card owns that affordance) —
 *  the re-fetch is fire-and-forget so it can never turn a landed answer
 *  into a card-level "could not submit" error.
 *
 *  ── Render model: DOM nodes, not innerHTML ──────────────────────────
 *  The shared approval card is a DOM-node builder with real click
 *  listeners (not the `innerHTML` + `data-action` delegation the other
 *  webclient settings panels use), so this panel rebuilds its content
 *  via `createElement` + `clearChildren` on every render (the same shape
 *  as the bridge side-panel mount), not via an HTML string.
 *
 *  Spec: D-169 § N.5 #4 / A.4 / I-11 / I-12 / TR-9. */

import {
  ASK_CARD_STYLES,
  renderAskCard,
} from '@recued/ui-shared/approval-card';
import type { ServerPendingAsk } from '@recued/contracts';

import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import { renderPreapprovalAsk } from './preapproval-route.js';

// ════════════════════════════════════════════════════════════════
// Caller seams + handle
// ════════════════════════════════════════════════════════════════

/** `notification.pending_asks` caller seam — the currently-open asks
 *  (`AskStore.listByStatus('open')`, projected to `ServerPendingAsk`). */
export type AsksListCaller = () => Promise<{
  asks: ReadonlyArray<ServerPendingAsk>;
}>;

/** `notification.submitAnswer` caller seam — funnels into the block's
 *  first-answer-wins `submitAnswer` (D-158 I-6). Always resolves
 *  `{ ok: true }`; the card converges via `notification.ask_closed`. */
export type AsksSubmitAnswerCaller = (args: {
  ask_id: string;
  option_id: string;
  /** D-234 § 234.4e — the written reason, when the ask invited one. */
  note?: string;
}) => Promise<{ ok: true }>;

export type AsksPanelState = 'loading' | 'ready' | 'error';

export interface MountAsksPanelOptions {
  /** Host element the panel renders into. The panel appends a single
   *  wrapper div + rebuilds its inner contents across state changes.
   *  `dispose()` drops the wrapper. */
  host: HTMLElement;
  /** DOM document seam. Defaults to `globalThis.document`. */
  document?: Document;
  /** `notification.pending_asks` caller seam. */
  runList: AsksListCaller;
  /** `notification.submitAnswer` caller seam. */
  runSubmitAnswer: AsksSubmitAnswerCaller;
  /** Live broadcast subscription seam. When provided, the mount
   *  subscribes to `notification.ask` + `notification.ask_closed` on
   *  creation and re-fetches the authoritative open-ask list whenever
   *  either fires (an ask raised on the server, or one closed from any
   *  surface). Unsubscribes on dispose. Optional by design: omitting it
   *  keeps the panel on the seed-plus-post-submit-refresh cadence (no
   *  cross-surface live updates) — used by the read-only test paths. */
  subscribe?: BroadcastSubscriber['on'];
  /** Headless mode (R20) — when true the panel manages ask state (seed +
   *  live `notification.ask`/`ask_closed` subscription + first-answer-wins
   *  submit) and fires `onChange`, but renders NO cards into its host. The
   *  unified `#approvals` list renders the ask cards itself (interleaved with
   *  gates, newest-first) and drives submits through `submitAnswer`, so the
   *  panel is pure state/IO here and its host stays empty. */
  headless?: boolean;
  /** Optional loading copy override. Pass `null` when a parent queue
   *  renders the loading skeleton. */
  loadingCopy?: string | null;
  /** Optional empty copy override. Pass `null` when a parent queue
   *  renders the combined all-clear state. */
  emptyCopy?: string | null;
  /** Parent notification seam. Fires after each local render-relevant
   *  state transition so a composed queue can update counts / empty
   *  state without polling this mount. */
  onChange?: (state: {
    phase: AsksPanelState;
    asks: ReadonlyArray<ServerPendingAsk>;
    listError: string | null;
  }) => void;
}

export interface AsksPanelMount {
  /** Current panel state — primary surface for tests + host introspection. */
  getState(): AsksPanelState;
  /** The currently-held open asks in display order. On a refresh failure
   *  the prior list is RETAINED (rendered beneath the error chip — a
   *  transient failure must not wipe approvals the user can still act on),
   *  except for locally acknowledged answers, which stay retired even when
   *  their follow-up read fails. An empty result therefore means there is no
   *  currently actionable ask in the retained state (including an ask just
   *  acknowledged locally), not necessarily that the last list read worked. */
  getAsks(): ReadonlyArray<ServerPendingAsk>;
  /** Top-level list error message. Null when the last load succeeded. */
  getListError(): string | null;
  /** Host-driven refresh — re-issues `runList`. Returns the load promise. */
  refresh(): Promise<void>;
  /** Initial load promise — resolves after the most recent `runList`
   *  settles (success → `'ready'`, failure → `'error'`). */
  whenLoaded(): Promise<void>;
  /** Submit an answer for a given ask — the same path a card-option
   *  click drives (`runSubmitAnswer` + the defensive re-fetch).
   *  Test seam + host convenience. Awaits both the submit AND the
   *  follow-up re-fetch so callers can observe the converged list. */
  submitAnswer(askId: string, optionId: string, note?: string): Promise<void>;
  /** An answer write has been issued and has not acknowledged yet. */
  hasInFlightWork(): boolean;
  /** Tear down the panel DOM + remove the broadcast subscription.
   *  Idempotent. */
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// Attribute constants — stable hooks for tests + the Settings shell
// ════════════════════════════════════════════════════════════════

/** Wrapper the panel owns inside the caller's host. */
export const ASKS_PANEL_HOST_ATTR = 'data-recued-asks-panel';
/** The empty-state line (ready, zero open asks). */
export const ASKS_PANEL_EMPTY_ATTR = 'data-recued-asks-empty';
/** The list-error chip (a `runList` failure). */
export const ASKS_PANEL_ERROR_ATTR = 'data-recued-asks-error';
/** The loading line (first load in flight). */
export const ASKS_PANEL_LOADING_ATTR = 'data-recued-asks-loading';

// ════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════

interface InternalState {
  phase: AsksPanelState;
  asks: ReadonlyArray<ServerPendingAsk>;
  listError: string | null;
}

const errMessage = (err: unknown): string =>
  humanizeRpcError(err);

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

export const mountAsksPanel = (
  opts: MountAsksPanelOptions,
): AsksPanelMount => {
  const doc =
    opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountAsksPanel: no document available — pass `opts.document` for non-browser environments',
    );
  }

  let state: InternalState = { phase: 'loading', asks: [], listError: null };
  let disposed = false;
  // Bumped before every `runList` await; the post-await write only lands
  // when its captured generation is still current — older racers (a bus
  // re-fetch overtaken by a newer one, a submit re-fetch + a bus frame
  // in the same tick) drop silently. Mirrors packs / cache-card DD#14 /
  // DD#7.
  let loadGeneration = 0;
  let pendingLoad: Promise<void> = Promise.resolve();
  let answersInFlight = 0;
  // An acknowledged answer is authoritative even if its defensive follow-up
  // list read fails or briefly returns a pre-answer snapshot. Keep it filtered
  // until one successful snapshot proves the id absent; then release the
  // tombstone so a theoretically reused id is not hidden forever.
  const acknowledgedAskIds = new Set<string>();

  const root = doc.createElement('div');
  root.setAttribute(ASKS_PANEL_HOST_ATTR, '');
  opts.host.appendChild(root);

  const clearChildren = (node: HTMLElement): void => {
    while (node.firstChild) node.removeChild(node.firstChild);
  };

  const appendLine = (
    attr: string,
    className: string,
    text: string,
  ): void => {
    const line = doc.createElement('div');
    line.setAttribute(attr, '');
    line.className = className;
    line.textContent = text;
    root.appendChild(line);
  };

  const notifyChange = (): void => {
    opts.onChange?.({
      phase: state.phase,
      asks: state.asks,
      listError: state.listError,
    });
  };

  const render = (): void => {
    if (disposed) return;
    // Headless (R20): the unified #approvals list owns the card rendering +
    // all chrome (loading / empty / error). The panel only manages state and
    // fires `onChange`; its host stays empty.
    if (opts.headless === true) return;
    clearChildren(root);

    // A load error surfaces as a chip ABOVE any still-visible cards —
    // a transient refresh failure shows the chip without wiping the
    // approvals the user can still act on.
    if (state.listError !== null) {
      appendLine(
        ASKS_PANEL_ERROR_ATTR,
        'asks-error',
        `Recued could not load your approvals: ${state.listError}`,
      );
    }

    if (state.asks.length > 0) {
      for (const ask of state.asks) {
        // The shared card (I-12). `ServerPendingAsk` satisfies its
        // structural `AskCardModel` ({ ask_id, title?, text, options }).
        root.appendChild(
          renderPreapprovalAsk(doc, ask) ??
          renderAskCard(doc, ask, {
            onAnswer: (optionId, note) => submitFromCard(ask.ask_id, optionId, note),
          }),
        );
      }
      return;
    }

    if (state.phase === 'loading') {
      if (opts.loadingCopy !== null) {
        appendLine(
          ASKS_PANEL_LOADING_ATTR,
          'asks-loading',
          opts.loadingCopy ?? 'Loading approvals…',
        );
      }
      return;
    }
    if (state.phase === 'ready') {
      if (opts.emptyCopy !== null) {
        appendLine(
          ASKS_PANEL_EMPTY_ATTR,
          'asks-empty',
          opts.emptyCopy
            ?? 'Nothing to approve. Anything waiting for you shows up here.',
        );
      }
    }
    // phase === 'error' with zero asks → the error chip above is the
    // whole surface; no empty / loading line.
  };

  const doRefresh = (): Promise<void> => {
    const gen = ++loadGeneration;
    pendingLoad = (async () => {
      try {
        const res = await opts.runList();
        if (disposed || gen !== loadGeneration) return; // stale / torn down
        const returnedIds = new Set(res.asks.map((ask) => ask.ask_id));
        // ⛔ OLDEST FIRST — the thing that has been waiting longest is the thing
        // to answer first, and it was rendering at the BOTTOM.
        //
        // ⚠ SORTED HERE AND NOT AT THE RPC, DELIBERATELY. `handlePendingAsks`
        // returns newest-first for a stated reason: the BRIDGE seeds its bus
        // buffer from the same call and live `notification.ask` frames PREPEND
        // on top (`bus-buffer.ts`), so a newest-first seed is what keeps the
        // bridge's feed in one consistent order. Flipping the wire would fix
        // this list and desync that one. Wire order is a buffer concern; queue
        // order is a display decision, so it belongs on this side.
        //
        // This panel takes the whole list from the rpc on every change (a live
        // frame triggers `doRefresh`, it never splices), so sorting the fetched
        // array orders this panel's own render and the attention popover.
        // ⚠ NOT the `#approvals` route: it reads this list via `onChange` and
        // then RE-SORTS it into a unified gate+ask+plan set (`mergedRows`),
        // which is the authoritative order for that surface. Both sorts are
        // needed — changing only one moves only half the UI.
        const asks = res.asks
          .filter((ask) => !acknowledgedAskIds.has(ask.ask_id))
          .sort((a, b) => a.created_at - b.created_at);
        for (const id of [...acknowledgedAskIds]) {
          if (!returnedIds.has(id)) acknowledgedAskIds.delete(id);
        }
        state = { phase: 'ready', asks, listError: null };
        render();
        notifyChange();
      } catch (err) {
        if (disposed || gen !== loadGeneration) return;
        // Keep any currently-visible asks; surface the error as a chip.
        state = { phase: 'error', asks: state.asks, listError: errMessage(err) };
        render();
        notifyChange();
      }
    })();
    return pendingLoad;
  };

  const retireAcknowledgedAsk = (askId: string): void => {
    if (disposed) return;
    acknowledgedAskIds.add(askId);
    state = {
      ...state,
      asks: state.asks.filter((ask) => ask.ask_id !== askId),
    };
    render();
    notifyChange();
  };

  const submitAndRetire = async (
    askId: string,
    optionId: string,
    note?: string,
  ): Promise<void> => {
    answersInFlight += 1;
    try {
      // D-234 § 234.4e — the reason rides with the option. ⛔ Threading it all
      // the way from the card is the whole point: the box can render, the user
      // can type, and if any hop here drops it the answer still SUCCEEDS —
      // silently, minus the thing they were asked for.
      await opts.runSubmitAnswer({
        ask_id: askId,
        option_id: optionId,
        ...(note !== undefined ? { note } : {}),
      });
    } finally {
      answersInFlight -= 1;
    }
    retireAcknowledgedAsk(askId);
  };

  /** The card-click path: submit, then reconcile against the
   *  authoritative list. The submit's failure propagates (the card
   *  re-enables + shows its inline error); the re-fetch is
   *  fire-and-forget so a re-fetch failure never masquerades as a
   *  submit failure. */
  const submitFromCard = async (
    askId: string,
    optionId: string,
    note?: string,
  ): Promise<void> => {
    await submitAndRetire(askId, optionId, note);
    // Acked + retired. Reconcile the rest of the queue (also covered by the
    // ask_closed bus frame; both idempotent). Not awaited here so the card's
    // onAnswer resolves on the submit alone.
    void doRefresh();
  };

  // ── Live broadcast subscription ──────────────────────────────────
  // Both ask kinds are bus signals to re-read the authoritative list:
  // `notification.ask` → a new ask the server raised; `ask_closed` → an
  // ask answered / closed on any surface (this one or a bridge). The
  // payload isn't consumed — the re-fetch is the source of truth.
  const unsubscribes: Array<() => void> = [];
  if (opts.subscribe) {
    unsubscribes.push(
      opts.subscribe('notification.ask', () => {
        if (disposed) return;
        void doRefresh();
      }),
    );
    unsubscribes.push(
      opts.subscribe('notification.ask_closed', () => {
        if (disposed) return;
        void doRefresh();
      }),
    );
  }

  // ── Initial paint + seed load ────────────────────────────────────
  render();
  notifyChange();
  void doRefresh();

  return {
    getState: () => state.phase,
    getAsks: () => state.asks,
    getListError: () => state.listError,
    refresh: () => doRefresh(),
    whenLoaded: () => pendingLoad,
    submitAnswer: async (askId, optionId, note) => {
      await submitAndRetire(askId, optionId, note);
      // Test seam / host convenience: await the reconcile too, so a
      // caller can observe the converged list (the card path doesn't).
      await doRefresh();
    },
    hasInFlightWork: () => answersInFlight > 0,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const unsub of unsubscribes) {
        try {
          unsub();
        } catch {
          // Unsubscribe errors are isolated — the subscriber owns its
          // own teardown; we just need to drop the handle.
        }
      }
      unsubscribes.length = 0;
      try {
        opts.host.removeChild(root);
      } catch {
        // Some fake DOMs / a detached host throw on removeChild; ignore —
        // the subscription is already dropped + the host is the caller's
        // to retain or discard.
      }
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════

/** Self-scoped CSS for the Approvals surface. Bundles the shared
 *  `ASK_CARD_STYLES` (so the card looks identical to the bridge's) plus
 *  the panel's own loading / empty / error chrome, all scoped under
 *  `[data-recued-asks-panel]` so the rules are inert when the panel
 *  isn't mounted. The top-level Approvals route joins this into its
 *  `<style>` bundle (`APPROVALS_ROUTE_STYLES`). */
export const ASKS_PANEL_STYLES = `
${ASK_CARD_STYLES}
[data-recued-asks-panel] .asks-loading,
[data-recued-asks-panel] .asks-empty {
  font-size: 13px;
  color: var(--muted);
  padding: 6px 2px;
}
[data-recued-asks-panel] .asks-error {
  font-size: 13px;
  color: var(--fail);
  padding: 6px 2px;
}
`;
