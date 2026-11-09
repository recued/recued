/** D-169 P1 — side-panel local store.
 *
 *  A thin read-through cache the side panel subscribes to (I-9). Two
 *  state slices ride here:
 *
 *   1. **Pair state** — derived from `chrome.storage.local`'s
 *      `webclient_token` + `server_url` + `pair_metadata` fields. When
 *      paired the panel renders its 5 sections; when not, it renders
 *      the pair CTA (TR-7).
 *
 *   2. **Push frames** — the live snapshots the side panel renders:
 *      rich server status (section #1), recipe results, notifications,
 *      pending asks. P1 ships section #1's storage; sections #2-5
 *      remain empty arrays until P2 wires the bus subscription.
 *
 *  Change semantics: callers `subscribe(fn)` for any-field change
 *  notifications. The store fires `notify()` synchronously after every
 *  patch; subscribers re-render. No diffing — the side panel rebuilds
 *  its DOM on every notify (low cost, the panel is small).
 *
 *  ⚠️  This module does NOT read `chrome.storage` directly — the SW
 *  forwards pair-state snapshots in via `applyPairState`. Decoupling
 *  keeps the side-panel surface testable in jsdom without polyfilling
 *  the chrome extension API. */

import type { KeepSignedInSite, KeepSignedInStatus } from '../../keep-signed-in.js';
import type {
  ActiveExecutionEntry,
  LaneStatus,
  ServerSystemStatus,
} from '@recued/contracts';
import { confirmedErrorMetadata, type BridgeConfirmedInspection, type BridgeInFlightInspection } from '../../idempotency/cache.js';
import type { DiagnosticSummaryCopyState } from '../diagnostic-summary.js';

/** D-169 P1 — pair-state derived snapshot. Three fields are enough for
 *  the panel to decide between "render sections" + "render pair CTA"
 *  + "show paired server's identifying handle in the header". */
export interface SidePanelPairState {
  /** True when a `webclient_token` is persisted. The side panel renders
   *  the 5 sections in this case; otherwise it renders the pair CTA. */
  paired: boolean;
  /** Paired server URL (raw, no normalisation) — header subtitle. */
  server_url: string | null;
  /** Pair-time display name set in the `pair_metadata` blob. The side
   *  panel falls back to the URL when unset. */
  server_display_name: string | null;
}

const DEFAULT_PAIR_STATE: SidePanelPairState = {
  paired: false,
  server_url: null,
  server_display_name: null,
};

/** D-169 P1 — rich server status frame for section #1 (N.5 #1). Lives
 *  here so the section view stays a pure render of the slice. */
export interface SidePanelStatusFrame {
  status: ServerSystemStatus | null;
  /** Last successful `system.status` fetch unix-ms; used for the
   *  "Refreshed Xs ago" header. Null until the first fetch lands. */
  fetched_at: number | null;
  /** Last fetch error message — surfaced in the section's empty-state
   *  card when present. Null when the most-recent fetch succeeded. */
  error: string | null;
}

const DEFAULT_STATUS_FRAME: SidePanelStatusFrame = {
  status: null,
  fetched_at: null,
  error: null,
};

/** D-169 P1 — sections #2/#3/#4 frames. P1 ships empty arrays + an
 *  optional load-error string; P2 fills these from the rpc snapshots
 *  + the bus subscription. The shape is fixed now so P2 doesn't churn
 *  the side-panel views. */
export interface SidePanelListFrame<T> {
  items: ReadonlyArray<T>;
  fetched_at: number | null;
  error: string | null;
}

/** Empty list frame — handed back from defaults + after a reset. */
const emptyListFrame = <T,>(): SidePanelListFrame<T> => ({
  items: [],
  fetched_at: null,
  error: null,
});

/** D-169 P1 — local-only diagnostic frame for section #5 (N.5 #5).
 *  Sourced from the bridge's in-process stores (idempotency cache /
 *  execution queue / grant store); the side panel reads it directly without
 *  going through the server. Unknown values remain unavailable until read. */
export interface SidePanelDiagnosticFrame {
  idempotency_entry_count: number | null;
  unresolved: BridgeInFlightInspection | null;
  recent_confirmed: BridgeConfirmedInspection | null;
  pending_command_count: number | null;
  current_command_id: string | null;
  queue_paused: boolean | null;
  grant_count: number | null;
  /** Completion time of the last fully available inspection for this pair. */
  last_successful_refresh_at: number | null;
  refreshing: boolean;
  refresh_error: string | null;
}

export const DEFAULT_DIAGNOSTIC_FRAME: SidePanelDiagnosticFrame = {
  idempotency_entry_count: null,
  unresolved: null,
  recent_confirmed: null,
  pending_command_count: null,
  current_command_id: null,
  queue_paused: null,
  grant_count: null,
  last_successful_refresh_at: null,
  refreshing: false,
  refresh_error: null,
};

export const DEFAULT_DIAGNOSTIC_COPY_STATE: DiagnosticSummaryCopyState = { phase: 'idle', summary: '' };

const copyDiagnostic = (frame: SidePanelDiagnosticFrame): SidePanelDiagnosticFrame => ({
  ...frame, unresolved: frame.unresolved === null ? null : {
    count: frame.unresolved.count, entries: frame.unresolved.entries.map(entry => ({ ...entry })),
  },
  recent_confirmed: frame.recent_confirmed === null ? null : {
    count: frame.recent_confirmed.count, entries: frame.recent_confirmed.entries.map(entry => ({
      command_id: entry.command_id, status: entry.status, stored_at: entry.stored_at,
      ...confirmedErrorMetadata(entry.status, entry.error_code),
    })),
  },
});

/** D-169 P2 Slice 4 — THIS bridge's own per-bridge mode flags, fetched
 *  from the self-scoped `notifications.my_bridge_mode` rpc. `approval`
 *  gates whether the Approvals section renders INTERACTIVE cards (the
 *  `onAnswer` submit path) or READ-ONLY rows. Both default `false`
 *  (fail-closed: never render an interactive approval card unless the
 *  server affirmatively reports approval mode ON for this bridge — a
 *  failed / pending / `null` fetch leaves the user unable to act, not
 *  acting on an approval they never opted into). */
export interface SidePanelBridgeMode {
  notification: boolean;
  approval: boolean;
}

export const DEFAULT_BRIDGE_MODE: SidePanelBridgeMode = {
  notification: false,
  approval: false,
};

/** D-181 slice 6a — the live active-executions frame the bridge side-panel
 *  mirrors. Unlike the recipe-results / notifications / approvals lists (which
 *  accumulate in the SW bus buffer), the active list is a *snapshot* of what is
 *  running / queued *right now*, pulled fresh from the `execution.active` rpc
 *  each poll tick (a run that starts and finishes between ticks never appears —
 *  it is ephemeral, with nothing to control). `entries` + `lanes` come straight
 *  off the rpc response; `notice` carries a transient, human-legible result of
 *  a kill / cancel / promote whose verdict was non-terminal (e.g. "that run
 *  already finished") — `''` when none. */
export interface SidePanelActiveFrame {
  entries: ReadonlyArray<ActiveExecutionEntry>;
  lanes: ReadonlyArray<LaneStatus>;
  /** Last successful `execution.active` fetch unix-ms; null until the first. */
  fetched_at: number | null;
  /** Last fetch error message — surfaced in the section's empty-state card
   *  when present. Null when the most-recent fetch succeeded. */
  error: string | null;
  /** Transient control-result line ('' = none). */
  notice: string;
}

const DEFAULT_ACTIVE_FRAME: SidePanelActiveFrame = {
  entries: [],
  lanes: [],
  fetched_at: null,
  error: null,
  notice: '',
};

/** D-169 P2 brick 3 — transient status of the "Watch this element" creator
 *  flow. The side-panel button asks the SW to inject the picker; the SW
 *  pushes the create outcome back here. `message: ''` ⇒ render no status
 *  line. `tone: 'danger'` uses the one danger hue (a launch / create
 *  failure). `webclient_link: true` ⇒ render the #automation deep-link (the
 *  watch lands DISARMED — the user enables it in the webclient). */
export interface SidePanelElementWatchStatus {
  message: string;
  tone: 'info' | 'danger';
  webclient_link: boolean;
}

const DEFAULT_ELEMENT_WATCH_STATUS: SidePanelElementWatchStatus = {
  message: '',
  tone: 'info',
  webclient_link: false,
};

/** D-335 slice G — the Sites section: whether this Bridge may use every site
 *  (Chrome's own grant; null until read) and the owner's list of sites Recued
 *  must never use. `message` says why the last change did not go through; ''
 *  when it did. This browser's, not the server's: a re-pair keeps it. */
export interface SidePanelSitesState {
  every_site: boolean | null;
  /** D-335 slice H — whether "Allow screenshots" is on; null while unread. */
  screenshots: boolean | null;
  blocked: readonly string[];
  message: string;
  /** D-347 follow-up 19 — the sites Keep signed in refreshes, with what happened last; none when absent. */
  keep?: readonly SidePanelKeepRow[];
  /** D-347 follow-up 22 — what Keep signed in's card says: why its last change did not go through, or what to
   *  fix in its form. Absent when there is nothing to say; `message` is the list of sites never used. */
  keep_message?: string;
}

/** D-347 follow-up 19 — a site Keep signed in refreshes (`keep-signed-in.ts`), and its status. */
export interface SidePanelKeepRow {
  entry: KeepSignedInSite;
  status?: KeepSignedInStatus;
}

const DEFAULT_SITES_STATE: SidePanelSitesState = { every_site: null, screenshots: null, blocked: [], message: '', keep: [] };

/** D-163 O-1 — whether Chrome shows this extension's notifications at all
 *  (`chrome.notifications.getPermissionLevel`): `denied` once someone turned
 *  off notifications from Recued Bridge in Chrome's notification settings;
 *  null while unread. It cannot see the computer's own settings (a Mac's Focus,
 *  or Chrome's notifications turned off there), which Chrome reports as
 *  granted. This browser's, not the server's: a re-pair keeps it. */
export type SidePanelDesktopNotifications = 'granted' | 'denied' | null;

/** The Server status section's Disconnect: idle, asking the owner to confirm, or under way;
 *  `message` says why the last one did not go through ('' when it did). */
export interface SidePanelDisconnectState {
  phase: 'idle' | 'confirming' | 'working';
  message: string;
}

const DEFAULT_DISCONNECT_STATE: SidePanelDisconnectState = { phase: 'idle', message: '' };

export interface SidePanelStoreState {
  pair: SidePanelPairState;
  status: SidePanelStatusFrame;
  recipe_results: SidePanelListFrame<{
    /** D-169 P2 Slice 2 — stable run id. The live `execution` bus frame +
     *  the `execution.recent` rpc row both carry it, so the buffer dedups
     *  a run that appears in BOTH the rpc-seeded slice and a terminal live
     *  event by `run_id` (Codex P2 fold). Null only for a row that somehow
     *  lacks one (defensive; both real sources always supply it). */
    run_id: string | null;
    recipe_id: string;
    status: 'ok' | 'error' | 'paused';
    started_at: number;
    duration_ms: number | null;
    error_category?: string;
  }>;
  notifications: SidePanelListFrame<{
    id: string;
    title?: string;
    text: string;
    fired_at: number;
  }>;
  approvals: SidePanelListFrame<{
    ask_id: string;
    title?: string;
    text: string;
    options: ReadonlyArray<{ id: string; label: string }>;
    created_at: number;
    /** D-234 § 234.3 — "read the thing this is about". ⚠ THIS FIELD WAS MISSING
     *  AND THE LINK HAS NEVER RENDERED ON BRIDGE: this struct is an enumerating
     *  copier, and `ServerPendingAsk.link_url` exists precisely because the
     *  webclient once lacked it the same way. Found while adding `note_prompt`
     *  below — same struct, same bug class, one field along. */
    link_url?: string;
    /** D-234 § 234.4e — this ask invites a written reason. Without it the Bridge
     *  card renders no field, and a `'required'` ask answered here NO-OPS
     *  server-side with nothing on screen to say why. */
    note_prompt?: 'optional' | 'required';
    /** D-234 § 234.4f — the document behind the question. Bridge is one of the
     *  owner's own paired surfaces, so it may hold it; a channel adapter may
     *  not. */
    body?: string;
    resource_review?: import('@recued/contracts').ResourceReview;
  }>;
  diagnostic: SidePanelDiagnosticFrame;
  /** Local feedback for copying diagnostics; polling does not overwrite it. */
  diagnostic_copy: DiagnosticSummaryCopyState;
  /** D-169 P2 Slice 4 — this bridge's own mode flags (gates the approvals
   *  section's interactive-vs-read-only rendering, and — D-181 slice 6a — the
   *  active-executions section's control buttons). */
  bridge_mode: SidePanelBridgeMode;
  /** D-181 slice 6a — the live active-executions snapshot. */
  active: SidePanelActiveFrame;
  /** D-169 P2 brick 3 — "Watch this element" creator-flow status line. */
  element_watch: SidePanelElementWatchStatus;
  /** D-335 slice G — the sites this Bridge may use, and the owner's list. */
  sites: SidePanelSitesState;
  /** D-163 O-1 — whether Chrome shows this Bridge's desktop notifications. */
  desktop_notifications: SidePanelDesktopNotifications;
  /** The owner disconnecting this bridge from the Server status section. */
  disconnect: SidePanelDisconnectState;
}

const initialState = (): SidePanelStoreState => ({
  pair: { ...DEFAULT_PAIR_STATE },
  status: { ...DEFAULT_STATUS_FRAME },
  recipe_results: emptyListFrame(),
  notifications: emptyListFrame(),
  approvals: emptyListFrame(),
  diagnostic: { ...DEFAULT_DIAGNOSTIC_FRAME },
  diagnostic_copy: { ...DEFAULT_DIAGNOSTIC_COPY_STATE },
  bridge_mode: { ...DEFAULT_BRIDGE_MODE },
  active: { ...DEFAULT_ACTIVE_FRAME },
  element_watch: { ...DEFAULT_ELEMENT_WATCH_STATUS },
  sites: { ...DEFAULT_SITES_STATE },
  desktop_notifications: null,
  disconnect: { ...DEFAULT_DISCONNECT_STATE },
});

export type SidePanelSubscriber = (state: SidePanelStoreState) => void;

export interface SidePanelStore {
  /** Current snapshot — never mutated by callers; the patch methods
   *  produce fresh frames. */
  getState(): SidePanelStoreState;
  /** Subscribe to any-field changes. Returns the unsubscribe handle. */
  subscribe(fn: SidePanelSubscriber): () => void;
  /** D-169 P1 — apply a pair-state patch. The SW forwards this in on
   *  every `chrome.storage` change. */
  applyPairState(state: SidePanelPairState): void;
  /** D-169 P1 — apply the status frame (a fresh `system.status` fetch
   *  on mount + each periodic tick). */
  applyStatusFrame(frame: SidePanelStatusFrame): void;
  /** D-169 P1 — section #5's local snapshot and refresh state. Read on
   *  polling ticks, invalidations and explicit Refresh requests. */
  applyDiagnosticFrame(frame: SidePanelDiagnosticFrame): void;
  applyDiagnosticCopyState(state: DiagnosticSummaryCopyState): void;
  /** D-169 P2 Slice 1 — apply the live-list snapshot for sections
   *  #2/#3/#4 in one patch (one re-render). The three lists always
   *  update together — they come from a single SW bus-buffer poll
   *  (`fetch-frames`), where the buffer is the accumulator + this store
   *  is a render-through cache. `meta` (fetched_at / error) applies to
   *  all three uniformly. */
  applyBusFrames(
    frames: {
      recipe_results: SidePanelStoreState['recipe_results']['items'];
      notifications: SidePanelStoreState['notifications']['items'];
      approvals: SidePanelStoreState['approvals']['items'];
    },
    meta: { fetched_at: number | null; error: string | null },
  ): void;
  /** D-169 P2 Slice 4 — apply this bridge's own mode flags (fetched from
   *  the self-scoped `notifications.my_bridge_mode` rpc on mount + each
   *  periodic refresh). Re-renders so an approval-mode toggle made in
   *  Settings on another surface flips this bridge's approvals section
   *  between interactive + read-only on the next tick. */
  applyBridgeMode(mode: SidePanelBridgeMode): void;
  /** D-181 slice 6a — apply the live active-executions snapshot (pulled from
   *  the `execution.active` rpc on mount + each periodic tick + right after a
   *  control mutation). Re-renders so the section reflects what is running /
   *  queued now and any transient control notice. */
  applyActiveFrame(frame: SidePanelActiveFrame): void;
  /** D-169 P2 brick 3 — set the "Watch this element" status line (launch
   *  feedback + the SW-pushed create outcome). Re-renders. */
  applyElementWatchStatus(status: SidePanelElementWatchStatus): void;
  /** D-335 slice G — the Sites section's state, read from Chrome. */
  applySitesState(sites: SidePanelSitesState): void;
  /** D-163 O-1 — Chrome's answer to whether it shows this Bridge's notifications. */
  applyDesktopNotifications(level: SidePanelDesktopNotifications): void;
  /** The Disconnect's phase and message. */
  applyDisconnectState(next: SidePanelDisconnectState): void;
  /** D-169 P1 — reset every live frame to defaults. An optional pair state
   *  lets the storage binder move directly into a new pairing in one atomic
   *  notification, so prior-server rows never flash under the new identity. */
  reset(pair?: SidePanelPairState): void;
}

/** D-169 P1 Codex Angle 3 fold (+ P2 Slice 1 Codex fold) — freeze the
 *  state tree on every patch so `getState()` cannot be mutated by
 *  callers (the documented invariant).
 *
 *  P1 froze each frame + its items array. P2 Slice 1 populates the
 *  recipe_results / notifications / approvals lists, so we now also
 *  freeze each ROW object (and the nested approval `options` array + its
 *  option objects) — otherwise a consumer could mutate live row fields
 *  through `getState()`. Row fields are otherwise primitives, so a
 *  per-row freeze (plus the options deep-freeze) seals every mutable
 *  handle.
 *
 *  Object.freeze in non-strict mode silently drops writes rather than
 *  throwing; under TypeScript strict mode + an `'use strict'` module
 *  (which ES modules are by default) the writes throw. Either way, the
 *  invariant becomes structurally enforced rather than convention-
 *  enforced. */
const freezeState = (s: SidePanelStoreState): SidePanelStoreState => {
  Object.freeze(s.pair);
  Object.freeze(s.status);
  Object.freeze(s.recipe_results);
  for (const row of s.recipe_results.items) Object.freeze(row);
  Object.freeze(s.recipe_results.items);
  Object.freeze(s.notifications);
  for (const row of s.notifications.items) Object.freeze(row);
  Object.freeze(s.notifications.items);
  Object.freeze(s.approvals);
  for (const row of s.approvals.items) {
    for (const opt of row.options) Object.freeze(opt);
    Object.freeze(row.options);
    Object.freeze(row);
  }
  Object.freeze(s.approvals.items);
  if (s.diagnostic.unresolved) {
    for (const entry of s.diagnostic.unresolved.entries) Object.freeze(entry);
    Object.freeze(s.diagnostic.unresolved.entries);
    Object.freeze(s.diagnostic.unresolved);
  }
  if (s.diagnostic.recent_confirmed) {
    for (const entry of s.diagnostic.recent_confirmed.entries) Object.freeze(entry);
    Object.freeze(s.diagnostic.recent_confirmed.entries);
    Object.freeze(s.diagnostic.recent_confirmed);
  }
  Object.freeze(s.diagnostic);
  Object.freeze(s.diagnostic_copy);
  Object.freeze(s.bridge_mode);
  Object.freeze(s.disconnect);
  // D-181 slice 6a — the active frame's entries / lanes carry nested objects
  // (an entry's `progress` / `kill` / `source`), so freeze one level into each
  // entry too — otherwise a consumer could mutate a live entry's nested fields
  // through getState(). The rows cross the SW→panel `sendMessage` clone, so the
  // store never aliases the buffer's arrays; this seals the read-through copy.
  Object.freeze(s.active);
  for (const entry of s.active.entries) {
    for (const key of Object.keys(entry) as Array<keyof typeof entry>) {
      const v = entry[key];
      if (v !== null && typeof v === 'object') Object.freeze(v);
    }
    Object.freeze(entry);
  }
  Object.freeze(s.active.entries);
  for (const lane of s.active.lanes) Object.freeze(lane);
  Object.freeze(s.active.lanes);
  Object.freeze(s.element_watch);
  Object.freeze(s.sites.blocked);
  Object.freeze(s.sites);
  return Object.freeze(s);
};

/** D-169 P1 — pure factory; no chrome.* dependency. The SW wires the
 *  bridge-side dispatchers; tests inject patches directly. */
export const createSidePanelStore = (
  initial?: Partial<SidePanelStoreState>,
): SidePanelStore => {
  let state: SidePanelStoreState = freezeState({
    ...initialState(),
    ...(initial ?? {}),
    diagnostic: copyDiagnostic(initial?.diagnostic ?? DEFAULT_DIAGNOSTIC_FRAME),
    diagnostic_copy: { ...(initial?.diagnostic_copy ?? DEFAULT_DIAGNOSTIC_COPY_STATE) },
  });
  const subscribers = new Set<SidePanelSubscriber>();

  const notify = (): void => {
    for (const fn of subscribers) {
      try {
        fn(state);
      } catch {
        // Best-effort — a subscriber throwing must not break the patch.
      }
    }
  };

  return {
    getState: () => state,
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    applyPairState(next) {
      state = freezeState({ ...state, pair: { ...next } });
      notify();
    },
    applyStatusFrame(frame) {
      state = freezeState({ ...state, status: { ...frame } });
      notify();
    },
    applyDiagnosticFrame(frame) {
      state = freezeState({ ...state, diagnostic: copyDiagnostic(frame) });
      notify();
    },
    applyDiagnosticCopyState(copy) {
      state = freezeState({ ...state, diagnostic_copy: { phase: copy.phase, summary: copy.summary } });
      notify();
    },
    applyBridgeMode(mode) {
      state = freezeState({ ...state, bridge_mode: { ...mode } });
      notify();
    },
    applyActiveFrame(frame) {
      state = freezeState({ ...state, active: { ...frame } });
      notify();
    },
    applyElementWatchStatus(status) {
      state = freezeState({ ...state, element_watch: { ...status } });
      notify();
    },
    applySitesState(sites) {
      state = freezeState({ ...state, sites: { ...sites, blocked: [...sites.blocked] } });
      notify();
    },
    applyDesktopNotifications(level) {
      if (state.desktop_notifications === level) return;
      state = freezeState({ ...state, desktop_notifications: level });
      notify();
    },
    applyDisconnectState(next) {
      state = freezeState({ ...state, disconnect: { ...next } });
      notify();
    },
    applyBusFrames(frames, meta) {
      state = freezeState({
        ...state,
        recipe_results: {
          items: frames.recipe_results,
          fetched_at: meta.fetched_at,
          error: meta.error,
        },
        notifications: {
          items: frames.notifications,
          fetched_at: meta.fetched_at,
          error: meta.error,
        },
        approvals: {
          items: frames.approvals,
          fetched_at: meta.fetched_at,
          error: meta.error,
        },
      });
      notify();
    },
    reset(pair) {
      // The sites and Chrome's notification setting are this browser's, not
      // the prior server's: kept.
      const next = { ...initialState(), sites: state.sites, desktop_notifications: state.desktop_notifications };
      state = freezeState(
        pair === undefined ? next : { ...next, pair: { ...pair } },
      );
      notify();
    },
  };
};
