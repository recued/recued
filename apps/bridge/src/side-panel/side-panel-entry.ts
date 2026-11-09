/** D-169 P1 — bundled side-panel entry.
 *
 *  Bundled at build time into `build/side-panel/index.js`, loaded by
 *  `build/side-panel/index.html`. This file is the side-panel
 *  equivalent of `service-worker-entry.ts`: it binds chrome.* globals
 *  to the pure mount + store modules.
 *
 *  Wiring shape:
 *   - Build a fresh `SidePanelStore`.
 *   - Mount the panel into `<main id="root">` via `mountSidePanel`. While
 *     the bridge is unpaired the panel shows the pair form
 *     (`pairing/pair-code-input-host.ts`), which asks the service worker's
 *     pairing session to pair; the toolbar icon has no popup.
 *   - Read pair state from `chrome.storage.local` + push into the store.
 *   - Subscribe to `chrome.storage.onChanged` so a pair finishing (or a
 *     re-pair / un-pair) re-renders without an explicit refresh.
 *   - Periodically call `recued.bridge.side-panel.fetch-status`
 *     against the SW (which forwards to the `system.status` rpc); push
 *     the result + any error into the store.
 *   - Periodically call `recued.bridge.inspect` for the diagnostic
 *     section's local counters (idempotency / execution queue / grants).
 *
 *  ⚠️  Tests do NOT import this file — its top-level side effects
 *  reference `chrome.*`. The testable surface lives in `mount.ts` +
 *  `store/local-store.ts` + `views.ts`; this entry is the production
 *  binder. */

import {
  createSidePanelStore,
  DEFAULT_BRIDGE_MODE,
  type SidePanelPairState,
  type SidePanelStoreState,
} from './store/local-store.js';
import { mountSidePanel } from './mount.js';
import { runBridgeModeConvergence } from './bridge-mode-convergence.js';
import { onLocalStorageChanged, type StorageChangeEvents } from './storage-changes.js';
import { createDiagnosticRefresh, createDiagnosticRefreshQueue, createPairStateRefresh, diagnosticScopeFromLocal } from './diagnostic-refresh.js';
import { createDiagnosticSummaryCopy, formatDiagnosticSummary } from './diagnostic-summary.js';
import type { BridgeIdempotencyScope } from '../idempotency/cache.js';
import { mountBridgePairCodeInputHost } from '../pairing/pair-code-input-host.js';
import { BLOCKED_SITES_KEY } from '../permissions/site-grants.js';
import { KEEP_SIGNED_IN_KEY, KEEP_SIGNED_IN_STATUS_KEY } from '../keep-signed-in.js';
import { createSitesControls, type SitesChrome } from './sites.js';
import { createDisconnectControls } from './disconnect.js';
import { createSidePanelFolds } from './folds.js';
import {
  createRuntimePairingClient,
  deriveBridgeDeviceLabel,
} from '../pairing/pairing-client.js';
import { ASK_CARD_STYLES } from '@recued/ui-shared/approval-card';

const STATUS_REFRESH_MS = 30_000;
const DIAGNOSTIC_REFRESH_MS = 15_000;
// D-169 P2 Slice 1 — live-list poll cadence. Tighter than the status
// tick: sections #2/#3/#4 are the user's "live" view of bus activity,
// and the SW responder is a cheap in-memory buffer read over the
// message port. The SW stays alive via the WS keepalive while paired,
// so this is a round-trip to an already-awake worker, not a wake cost.
const FRAMES_REFRESH_MS = 5_000;

/** chrome.storage.local fields the side panel reads from. Closed list
 *  so a future schema drift doesn't silently break the panel. */
const WATCHED_FIELDS = [
  'server_url',
  'webclient_token',
  'server_public_key',
  'pair_metadata',
] as const;

/** D-169 P2 brick 3 — picker launch (inject) failure reason → user copy. */
const LAUNCH_FAIL_MESSAGE: Record<string, string> = {
  picker_unavailable: 'Could not start the picker — the bridge is not ready yet.',
  no_active_tab: 'Open a web page in this window, then try again.',
  unsupported_page: 'The picker runs only on web pages (http / https).',
  inject_failed:
    'Could not start the picker on this page. Grant this site to the bridge, or try another page.',
};

interface ChromeStorageEntry {
  webclient_token?: { token_id?: string } | null;
  server_url?: string | null;
  server_public_key?: string | null;
  pair_metadata?: { server_display_name?: string } | null;
}

interface ChromeRuntime {
  getManifest?(): { version?: string };
  sendMessage(
    message: unknown,
  ): Promise<unknown>;
  /** D-169 P2 Slice 4 — receive the SW's `bridge-mode-invalidated` push.
   *  Optional: a test fake / pre-Slice-4 SW may not wire it, in which case
   *  the panel falls back to its mount + reconnect-driven mode re-fetch. */
  onMessage?: {
    addListener(
      handler: (
        message: unknown,
        sender: unknown,
        sendResponse: (response: unknown) => void,
      ) => boolean | undefined | void,
    ): void;
  };
}

interface ChromeStorageLocal extends Pick<StorageChangeEvents['local'], 'onChanged'> {
  get(keys: ReadonlyArray<string>): Promise<ChromeStorageEntry>;
  /** D-335 slice G — the owner's list of sites Recued must never use. */
  set(items: Record<string, unknown>): Promise<void>;
}

interface ChromePermissionsEvent {
  addListener(handler: () => void): void;
}

interface ChromeApi {
  runtime: ChromeRuntime;
  storage: { local: ChromeStorageLocal; onChanged?: StorageChangeEvents['onChanged'] };
  /** D-335 slice G — Chrome's grant of sites to this extension. */
  permissions?: SitesChrome['permissions'] & { onAdded?: ChromePermissionsEvent; onRemoved?: ChromePermissionsEvent };
  /** D-163 O-1 — whether Chrome shows this extension's notifications. */
  notifications?: {
    getPermissionLevel(callback: (level: string) => void): void;
    /** Fired on ChromeOS only, Chrome's own documentation says: elsewhere the panel re-reads. */
    onPermissionLevelChanged?: { addListener(handler: (level: string) => void): void };
  };
}

const deriveSidePanelPairState = (
  entry: ChromeStorageEntry,
): SidePanelPairState => {
  const paired =
    entry.server_url !== null &&
    entry.server_url !== undefined &&
    entry.webclient_token !== null &&
    entry.webclient_token !== undefined &&
    entry.server_public_key !== null &&
    entry.server_public_key !== undefined;
  return {
    paired,
    server_url: typeof entry.server_url === 'string' ? entry.server_url : null,
    server_display_name:
      typeof entry.pair_metadata?.server_display_name === 'string'
        ? entry.pair_metadata.server_display_name
        : null,
  };
};

const main = async (): Promise<void> => {
  const chromeApi = (globalThis as { chrome?: ChromeApi }).chrome;
  if (!chromeApi) {
    // Likely a test that loaded the bundle directly. Tests should use
    // the pure mount module + a hand-built store; this entry is for
    // production only.
    return;
  }
  const store = createSidePanelStore();
  let diagnosticScope: BridgeIdempotencyScope | null = null;
  let bridgeVersion: string | undefined;
  try { bridgeVersion = chromeApi.runtime.getManifest?.().version; } catch { /* Unavailable in an invalidated extension context. */ }
  const clipboard = globalThis.navigator?.clipboard;
  const diagnosticCopy = createDiagnosticSummaryCopy({
    getSummary: () => formatDiagnosticSummary(store.getState().diagnostic, { bridgeVersion, createdAt: Date.now() }),
    getScope: () => diagnosticScope,
    canCopy: () => store.getState().pair.paired,
    writeText: typeof clipboard?.writeText === 'function' ? text => clipboard.writeText(text) : undefined,
    apply: state => store.applyDiagnosticCopyState(state),
  });
  let initialPairReadFailed = false;
  const diagnostics = createDiagnosticRefresh({ store, getScope: () => diagnosticScope,
    inspect: () => chromeApi.runtime.sendMessage({ type: 'recued.bridge.inspect' }) });
  const diagnosticReads = createDiagnosticRefreshQueue({
    store,
    prepare: async () => { if (pairState.needsRefresh()) await pairState.refresh(); },
    refresh: () => diagnostics.refresh(),
  });
  const refreshDiagnostic = (): void => diagnosticReads.request();

  // D-169 P2 Slice 3 — inject the shared approval-card stylesheet (the card
  // co-exports its CSS the same way the ui-shared primitives do, so the
  // side panel doesn't hard-code it in index.html).
  if (typeof document !== 'undefined' && document.head) {
    const styleEl = document.createElement('style');
    styleEl.textContent = ASK_CARD_STYLES;
    document.head.appendChild(styleEl);
  }

  /** D-169 P2 Slice 3 — submit an approval-card answer via the SW
   *  `submit-answer` responder (→ `notification.submitAnswer` rpc). The SW
   *  re-seeds history on success + returns the post-seed snapshot, so the
   *  answered ask drops out of the approvals list right away (ahead of the
   *  `notification.ask_closed` bus frame). Rejects on a failed / missing
   *  reply so the approval card re-enables its buttons + shows an inline
   *  error for retry (Codex Slice-3 fold); the block dedups any eventual
   *  duplicate answer (D-158 I-6). */
  const submitAnswer = async (
    ask_id: string,
    option_id: string,
    note?: string,
  ): Promise<void> => {
    const reply = (await chromeApi.runtime.sendMessage({
      type: 'recued.bridge.side-panel.submit-answer',
      ask_id,
      option_id,
      // D-234 § 234.4e — one more hop the reason has to survive. This message
      // crosses a `sendMessage` clone boundary, so an omitted key here is
      // indistinguishable downstream from a user who typed nothing.
      ...(note !== undefined ? { note } : {}),
    })) as
      | {
          ok: true;
          recipe_results: SidePanelStoreState['recipe_results']['items'];
          notifications: SidePanelStoreState['notifications']['items'];
          approvals: SidePanelStoreState['approvals']['items'];
        }
      | { ok: false; error: string }
      | null;
    // Reject on a missing / error reply so the approval card re-enables its
    // buttons + shows an inline error for retry. A transport throw from
    // sendMessage propagates the same way. The server block dedups any
    // eventual duplicate answer (D-158 I-6), so a retry is always safe.
    if (reply === null || reply === undefined) {
      throw new Error('No reply from bridge service worker.');
    }
    if (reply.ok === false) {
      throw new Error(reply.error);
    }
    // Success — apply the post-seed snapshot so the answered ask drops out
    // of the approvals list immediately (the SW re-seeded history before
    // replying), ahead of the `notification.ask_closed` bus frame.
    store.applyBusFrames(
      {
        recipe_results: reply.recipe_results,
        notifications: reply.notifications,
        approvals: reply.approvals,
      },
      { fetched_at: Date.now(), error: null },
    );
  };

  /** D-169 P2 brick 3 — launch the "Watch this element" picker: ask the SW
   *  to inject the picker into the active tab. The picked element returns
   *  asynchronously as a separate `picker-result` push (handled below); this
   *  only reflects the launch (inject) outcome. */
  let pickerLaunchInFlight = false;
  const launchPicker = async (): Promise<void> => {
    // Rendering the status line replaces this surface's DOM, including its
    // locally-disabled button. Keep the actual launch guard in this stable
    // production closure so a second click cannot inject a duplicate picker.
    if (pickerLaunchInFlight) return;
    pickerLaunchInFlight = true;
    try {
      store.applyElementWatchStatus({
        message: 'Starting the element picker…',
        tone: 'info',
        webclient_link: false,
      });
      let reply:
        | { ok: true }
        | { ok: false; reason?: string }
        | null;
      try {
        reply = (await chromeApi.runtime.sendMessage({
          type: 'recued.bridge.side-panel.launch-picker',
        })) as { ok: true } | { ok: false; reason?: string } | null;
      } catch {
        reply = null;
      }
      if (reply !== null && reply !== undefined && reply.ok === true) {
        store.applyElementWatchStatus({
          message: 'Pick an element on the page, then confirm.',
          tone: 'info',
          webclient_link: false,
        });
        return;
      }
      const reason =
        reply !== null && reply !== undefined && reply.ok === false
          ? reply.reason
          : undefined;
      store.applyElementWatchStatus({
        message:
          (reason !== undefined ? LAUNCH_FAIL_MESSAGE[reason] : undefined) ??
          'Could not start the picker.',
        tone: 'danger',
        webclient_link: false,
      });
    } finally {
      pickerLaunchInFlight = false;
    }
  };

  /** D-169 P2 brick 3 — apply the SW-pushed create outcome (after the user
   *  confirms a pick, the SW derives the url + calls
   *  `triggers.createElementWatch`, then pushes the result here). The watch
   *  lands DISARMED — the success line points at the webclient to enable it. */
  const applyPickerResult = (push: {
    ok?: unknown;
    created?: unknown;
    error?: unknown;
  }): void => {
    if (push.ok === true) {
      const alreadyExisted = push.created === false;
      store.applyElementWatchStatus({
        message: alreadyExisted
          ? 'A watch on this element already exists. Enable it in the webclient.'
          : 'Watch created — it is off. Enable it in the webclient.',
        tone: 'info',
        webclient_link: true,
      });
      return;
    }
    const error = typeof push.error === 'string' ? push.error : '';
    const message =
      error === 'bridge_not_paired'
        ? 'Pair this bridge before creating a watch.'
        : error === 'unsupported_page'
          ? 'That page cannot be watched.'
          : error !== ''
            ? 'Could not create the watch: ' + error
            : 'Could not create the watch.';
    store.applyElementWatchStatus({ message, tone: 'danger', webclient_link: false });
  };

  // Resolve pair identity before the first dynamic paint. The static HTML keeps
  // a small "Connecting…" card visible during this read; mounting first would
  // briefly show the unpaired CTA to every already-paired user.
  try {
    const entry = await chromeApi.storage.local.get([...WATCHED_FIELDS]);
    diagnosticScope = diagnosticScopeFromLocal(entry);
    store.applyPairState(deriveSidePanelPairState(entry));
  } catch {
    initialPairReadFailed = true;
    // chrome.storage failed (rare; corrupt extension state). The panel
    // renders unpaired, and the pair form asks the worker, which reads
    // storage itself.
  }

  // The pair form's link to the worker's pairing session, and the device
  // label the server lists this bridge under ("Chrome on macOS").
  const pairingClient = createRuntimePairingClient(chromeApi.runtime);
  const userAgent = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent;
  const displayName = userAgent ? deriveBridgeDeviceLabel(userAgent) : undefined;

  // D-335 slice G — the Sites section: Chrome's grant of every site, and the
  // owner's list of sites Recued must never use.
  const permissions = chromeApi.permissions;
  const sites = permissions
    ? createSitesControls({
      permissions,
      storage: {
        get: async keys => (await chromeApi.storage.local.get(keys)) as Record<string, unknown>,
        set: items => chromeApi.storage.local.set(items),
      },
    }, next => store.applySitesState(next))
    : undefined;

  // The Server status section's Disconnect: the worker tells the server and forgets the pairing.
  const disconnect = createDisconnectControls(
    (message) => chromeApi.runtime.sendMessage(message),
    (next) => store.applyDisconnectState(next),
  );

  /** 2026-11-04 — the owner's open-or-closed sections, kept in this browser. Reading
   *  `localStorage` can itself throw (site data blocked); then they are kept for this panel. */
  const foldStorage = (() => {
    try {
      return globalThis.localStorage;
    } catch {
      return undefined;
    }
  })();
  mountSidePanel({
    store,
    folds: createSidePanelFolds(foldStorage),
    ...(sites ? { sites } : {}),
    disconnect,
    onRefreshDiagnostic: refreshDiagnostic,
    onCopyDiagnostic: () => { void diagnosticCopy.copy(); },
    // Return the promise so the approval card can await the submit + react
    // to a rejection (re-enable its buttons + show an inline error). The
    // card owns the only rejection handler; nothing else awaits this.
    onAnswer: (ask_id, option_id, note) => (note === undefined
      ? submitAnswer(ask_id, option_id)
      : submitAnswer(ask_id, option_id, note)),
    // D-181 slice 6a — live-control routing for the active-executions section.
    // The mount only forwards it to the section when this bridge holds approval
    // mode (§8); the server re-checks the same gate.
    onControl: (action, id) => controlExecution(action, id),
    // D-169 P2 brick 3 — the "Watch this element" creator gesture.
    onLaunchPicker: () => launchPicker(),
    mountPairing: (slot) =>
      mountBridgePairCodeInputHost({
        splashElement: slot,
        pairing: pairingClient,
        ...(displayName ? { displayName } : {}),
      }),
  });

  // Re-read pair state on every chrome.storage change so a pair finishing
  // with the panel open (and re-pair / un-pair) re-renders without a manual
  // refresh. `onLocalStorageChanged` owns the two events' different
  // signatures (`storage-changes.ts`).
  const pairState = createPairStateRefresh({
    initiallyInvalidated: initialPairReadFailed,
    read: () => chromeApi.storage.local.get([...WATCHED_FIELDS]),
    invalidate: () => {
      diagnosticScope = null;
      diagnosticCopy.invalidate();
      diagnostics.invalidate();
    },
    apply: (entry, identityChanged) => {
      const wasPaired = store.getState().pair.paired;
      const nextPair = deriveSidePanelPairState(entry);
      diagnosticScope = diagnosticScopeFromLocal(entry);
      if (identityChanged) {
        // Clear every prior-server frame and apply the new pair in ONE
        // notification. Without this, re-pairing an open panel briefly
        // exposes the old server's runs/asks under the new header.
        store.reset(nextPair);
      } else {
        // pair_metadata-only updates are presentation changes (for example
        // the server display name); keep the live frames + mode intact.
        store.applyPairState(nextPair);
      }
      // D-169 P2 Slice 4 (Codex fold) — a pair-identity change (un-pair
      // / re-pair, possibly to a DIFFERENT server) invalidates this
      // bridge's cached approval mode. Reset to the fail-closed default
      // so the approvals section can't keep rendering interactive cards
      // using the PRIOR pairing's approval flag. The mode is NOT re-
      // fetched inline here on purpose: an immediate fetch would race
      // the SW's own reconnection to the new server (the rpc could
      // still hit the OLD connection and re-apply a stale mode). The
      // periodic tick re-fetches once the SW has settled on the new
      // identity, so the gate stays fail-closed (read-only) in between.
      // `reset(nextPair)` above already restores this fail-closed default
      // atomically. A metadata-only update must not erase a live mode.
      //
      // A pair just finished: load the paired sections now rather than
      // on the next ticks. The worker answers the status read
      // "connecting" until its socket is up, then pushes
      // `server-connected`, which reads it again.
      if (!wasPaired && nextPair.paired) loadPairedSections();
    },
  });
  // D-163 O-1 — whether Chrome shows this Bridge's notifications at all, read when the panel
  // opens, when it is shown again, on the status tick, and on Chrome's own change event. Chrome
  // cannot report the computer's settings (a Mac's Focus), so only its own setting is shown.
  const readDesktopNotifications = (): void => {
    const notifications = chromeApi.notifications;
    if (notifications === undefined) return;
    try {
      notifications.getPermissionLevel((level) => {
        store.applyDesktopNotifications(level === 'denied' ? 'denied' : level === 'granted' ? 'granted' : null);
      });
    } catch {
      // Unreadable: the panel says nothing rather than guess.
    }
  };
  readDesktopNotifications();
  chromeApi.notifications?.onPermissionLevelChanged?.addListener(() => { readDesktopNotifications(); });
  const panelDocument = (globalThis as { document?: Document }).document;
  panelDocument?.addEventListener('visibilitychange', () => {
    if (panelDocument.visibilityState === 'visible') readDesktopNotifications();
  });
  if (sites) {
    void sites.refresh();
    // Granted or taken back here, in Chrome's own settings, or by another panel.
    permissions?.onAdded?.addListener(() => { void sites.refresh(); });
    permissions?.onRemoved?.addListener(() => { void sites.refresh(); });
    onLocalStorageChanged(chromeApi.storage, (changes) => {
      if (BLOCKED_SITES_KEY in changes || KEEP_SIGNED_IN_KEY in changes || KEEP_SIGNED_IN_STATUS_KEY in changes) {
        void sites.refresh();
      }
    });
  }
  onLocalStorageChanged(chromeApi.storage, (changes) => {
    if (!WATCHED_FIELDS.some((f) => f in changes)) return;
    if (['server_url', 'webclient_token', 'server_public_key'].some(field => field in changes)) pairState.invalidateIdentity();
    void pairState.refresh();
  });

  /** D-169 P1 — pull a fresh `system.status` snapshot via the SW.
   *  The SW handler proxies to its `rpcConn`. It answers
   *  `bridge_connecting` while the socket is still coming up, and pushes
   *  `server-connected` once it is up, which runs this again; the view
   *  shows the connecting state as neutral copy, not an error. */
  let statusGeneration = 0;
  const refreshStatus = async (): Promise<void> => {
    if (!store.getState().pair.paired) return;
    // The 30 s tick, the connect push and mount can overlap; only the
    // newest answer applies, so a late "connecting" never replaces a
    // status that arrived after it.
    const generation = ++statusGeneration;
    try {
      const reply = (await chromeApi.runtime.sendMessage({
        type: 'recued.bridge.side-panel.fetch-status',
      })) as
        | { ok: true; status: import('@recued/contracts').ServerSystemStatus }
        | { ok: false; error: string }
        | null;
      if (generation !== statusGeneration) return;
      if (reply === null || reply === undefined) {
        store.applyStatusFrame({
          status: null,
          fetched_at: null,
          error: 'No reply from bridge service worker.',
        });
        return;
      }
      if (reply.ok === false) {
        store.applyStatusFrame({
          status: store.getState().status.status,
          fetched_at: store.getState().status.fetched_at,
          error: reply.error,
        });
        return;
      }
      store.applyStatusFrame({
        status: reply.status,
        fetched_at: Date.now(),
        error: null,
      });
    } catch (err) {
      if (generation !== statusGeneration) return;
      store.applyStatusFrame({
        status: store.getState().status.status,
        fetched_at: store.getState().status.fetched_at,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  /** D-169 P2 Slice 1 — pull the live bus-buffer snapshot via the SW
   *  `fetch-frames` responder + apply sections #2/#3/#4 in one patch.
   *  The SW buffer accumulates bus events live; this poll is the
   *  render-through read. Best-effort: a missing / failed reply keeps
   *  the prior items (the next tick recovers) rather than blanking the
   *  lists — they have no user-facing failure surface this slice. */
  const refreshFrames = async (): Promise<void> => {
    if (!store.getState().pair.paired) return;
    try {
      const reply = (await chromeApi.runtime.sendMessage({
        type: 'recued.bridge.side-panel.fetch-frames',
      })) as
        | {
            ok: true;
            recipe_results: SidePanelStoreState['recipe_results']['items'];
            notifications: SidePanelStoreState['notifications']['items'];
            approvals: SidePanelStoreState['approvals']['items'];
          }
        | { ok: false; error: string }
        | null;
      if (reply === null || reply === undefined || reply.ok === false) return;
      store.applyBusFrames(
        {
          recipe_results: reply.recipe_results,
          notifications: reply.notifications,
          approvals: reply.approvals,
        },
        { fetched_at: Date.now(), error: null },
      );
    } catch {
      // Best-effort — keep prior list state on a transient failure.
    }
  };

  // D-181 slice 6a (Codex fold) — monotonic generation for `refreshActive`.
  // The 5s poll + a control-triggered refresh can be in flight at once; only
  // the NEWEST request's result is applied so a slower, staler `execution.active`
  // response can't overwrite a fresher snapshot (or clear a fresher control
  // notice). Mirrors the seed-generation guard the historical seeder uses + the
  // webclient slice-5b active-refresh sequencing.
  let activeRefreshSeq = 0;

  /** D-181 slice 6a — pull the live active-executions snapshot via the SW
   *  `fetch-active` responder (→ the `execution.active` rpc). `notice` carries
   *  a transient control-result line to render above the list (default '' — a
   *  plain poll clears any stale notice). Best-effort: a missing / failed reply
   *  keeps the prior entries/lanes (the next tick recovers) and applies the
   *  notice if one was supplied, rather than blanking the section — the same
   *  best-effort posture as the sibling `refreshFrames` live-list poll (a
   *  transient blip keeps the last-known list rather than hiding it behind an
   *  error card; the frame's `error` field is reserved for a future explicit
   *  failure surface). An out-of-order response (a newer refresh started while
   *  this one was in flight) is discarded. */
  const refreshActive = async (notice = ''): Promise<void> => {
    if (!store.getState().pair.paired) return;
    const seq = ++activeRefreshSeq;
    try {
      const reply = (await chromeApi.runtime.sendMessage({
        type: 'recued.bridge.side-panel.fetch-active',
      })) as
        | {
            ok: true;
            entries: import('@recued/contracts').ActiveExecutionEntry[];
            lanes: import('@recued/contracts').LaneStatus[];
          }
        | { ok: false; error: string }
        | null;
      if (seq !== activeRefreshSeq) return; // superseded by a newer refresh
      if (reply === null || reply === undefined || reply.ok === false) {
        const prior = store.getState().active;
        if (notice !== '' || prior.notice !== '') {
          store.applyActiveFrame({ ...prior, notice });
        }
        return;
      }
      store.applyActiveFrame({
        entries: reply.entries,
        lanes: reply.lanes,
        fetched_at: Date.now(),
        error: null,
        notice,
      });
    } catch {
      if (seq !== activeRefreshSeq) return;
      // Best-effort — keep prior list state on a transient failure.
      const prior = store.getState().active;
      if (notice !== '' || prior.notice !== '') {
        store.applyActiveFrame({ ...prior, notice });
      }
    }
  };

  /** D-181 slice 6a — map a control mutator's verdict to a user-facing notice.
   *  A clean terminal outcome (`killed` / `cancelled_before_dispatch` /
   *  `promoted`) needs no line ('' ); a non-terminal verdict is made legible so
   *  a no-op click isn't silent. */
  const controlVerdictNotice = (
    action: 'kill' | 'cancel' | 'promote',
    status: string,
  ): string => {
    if (action === 'kill') {
      if (status === 'already_terminal') return 'That run already finished.';
      if (status === 'not_found') return 'That run is no longer active.';
      return '';
    }
    if (action === 'cancel') {
      if (status === 'already_dispatched') {
        return 'That call already started — use Kill to stop it.';
      }
      if (status === 'not_found') return 'That queued call is no longer waiting.';
      return '';
    }
    // promote
    if (status === 'not_found') return 'That queued call is no longer waiting.';
    return '';
  };

  // D-181 slice 6a (Codex fold) — in-flight control guard. The panel rebuilds
  // its DOM wholesale on every store change, so a per-button `disabled`
  // attribute wouldn't survive a re-render; instead this stable closure-scoped
  // set bails a duplicate click while the same (action, id) is in flight. Kill
  // is server-idempotent, but the guard also stops a redundant click from
  // racing a misleading `not_found` / `already_terminal` notice in behind a
  // just-succeeded action.
  const controlInFlight = new Set<string>();

  /** D-181 slice 6a — route a kill / cancel / promote from an active-row button
   *  through the SW responder, then re-fetch the active list (carrying any
   *  non-terminal-verdict / error notice). The server re-checks the
   *  bridge-approval gate, so a `forbidden` (a non-approval bridge that somehow
   *  reaches here) surfaces as the notice rather than mutating anything. */
  const controlExecution = async (
    action: 'kill' | 'cancel' | 'promote',
    id: string,
  ): Promise<void> => {
    const inFlightKey = `${action}:${id}`;
    if (controlInFlight.has(inFlightKey)) return; // ignore a double-click
    controlInFlight.add(inFlightKey);
    const type =
      action === 'kill'
        ? 'recued.bridge.side-panel.execution-kill'
        : action === 'cancel'
          ? 'recued.bridge.side-panel.execution-cancel'
          : 'recued.bridge.side-panel.execution-promote';
    const args = action === 'kill' ? { run_id: id } : { queued_call_id: id };
    let notice = '';
    try {
      const reply = (await chromeApi.runtime.sendMessage({ type, ...args })) as
        | { ok: true; status: string }
        | { ok: false; error: string }
        | null;
      if (reply === null || reply === undefined) {
        notice = 'No reply from bridge service worker.';
      } else if (reply.ok === false) {
        notice =
          reply.error === 'bridge_not_paired'
            ? 'Pair this bridge before controlling executions.'
            : `Could not ${action}: ${reply.error}`;
      } else {
        notice = controlVerdictNotice(action, reply.status);
      }
    } catch (err) {
      notice = `Could not ${action}: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      controlInFlight.delete(inFlightKey);
    }
    await refreshActive(notice);
  };

  /** D-169 P2 Slice 2 — mount-time historical fetch (spec § A.4 "on
   *  side-panel mount"). Asks the SW to seed the bus buffer from the three
   *  historical-view rpcs, then applies the post-seed snapshot so the
   *  panel renders recent history immediately on open. Steady-state live
   *  updates then flow through the 5s `refreshFrames` poll. Same payload
   *  shape as `fetch-frames`; best-effort (a failure leaves the lists
   *  empty until the first `refreshFrames` tick). */
  const refreshHistory = async (): Promise<void> => {
    if (!store.getState().pair.paired) return;
    try {
      const reply = (await chromeApi.runtime.sendMessage({
        type: 'recued.bridge.side-panel.fetch-history',
      })) as
        | {
            ok: true;
            recipe_results: SidePanelStoreState['recipe_results']['items'];
            notifications: SidePanelStoreState['notifications']['items'];
            approvals: SidePanelStoreState['approvals']['items'];
          }
        | { ok: false; error: string }
        | null;
      if (reply === null || reply === undefined || reply.ok === false) return;
      store.applyBusFrames(
        {
          recipe_results: reply.recipe_results,
          notifications: reply.notifications,
          approvals: reply.approvals,
        },
        { fetched_at: Date.now(), error: null },
      );
    } catch {
      // Best-effort — the 5s refreshFrames poll recovers the live view.
    }
  };

  /** D-169 P2 Slice 4 — pull THIS bridge's own mode flags via the SW
   *  `fetch-bridge-mode` responder (→ the self-scoped
   *  `notifications.my_bridge_mode` rpc, keyed server-side on the
   *  authenticated client_token_id). Drives `mount`'s approvals
   *  interactive-vs-read-only gate. Fail-closed by construction: only an
   *  AFFIRMATIVE server reply updates the gate — `modes: null` (the server
   *  does not recognise this client as a paired bridge) resolves to
   *  both-off (read-only), and a transport-level failure (ok:false / no
   *  reply / throw) leaves the last-known mode untouched to avoid flicker.
   *  The mount default + the pair-change reset are both-off, so the panel
   *  starts (and re-pairs) read-only until a successful fetch confirms
   *  approval mode ON for this bridge. Returns whether it applied an
   *  authoritative mode — an unpaired panel has none to apply, so resolves
   *  `true` (nothing to converge); the invalidation path below uses this
   *  return to drive its retry + fail-closed convergence. */
  const refreshBridgeMode = async (): Promise<boolean> => {
    if (!store.getState().pair.paired) return true;
    try {
      const reply = (await chromeApi.runtime.sendMessage({
        type: 'recued.bridge.side-panel.fetch-bridge-mode',
      })) as
        | {
            ok: true;
            modes: import('@recued/contracts').NotificationBridgeModeRow | null;
          }
        | { ok: false; error: string }
        | null;
      if (reply !== null && reply !== undefined && reply.ok === true) {
        // An affirmative reply — including an authoritative `modes: null`
        // (both-off) — is a definitive answer the gate converges to.
        store.applyBridgeMode(reply.modes ?? DEFAULT_BRIDGE_MODE);
        return true;
      }
      return false;
    } catch {
      // Transient failure — didn't learn the mode (the converge loop
      // below retries, then fails closed rather than trust the stale one).
      return false;
    }
  };

  // D-169 P2 Slice 4 (live-mode propagation) — converge this bridge's mode
  // when the SW pushes a `bridge-mode-invalidated` signal (a
  // `notification.bridge_mode_changed` bus event + every reconnect). The
  // push is value-less: we re-read our OWN mode via `my_bridge_mode`
  // (server-authoritative) rather than trust any flags on the wire. If the
  // first re-fetch fails we FAIL CLOSED to read-only at once (then retry to
  // recover the true mode) — see `runBridgeModeConvergence` for why a stale
  // approval-ON gate is unsafe. This replaces the status-tick mode re-poll
  // below.
  const BRIDGE_MODE_CONVERGE_ATTEMPTS = 3;
  const BRIDGE_MODE_CONVERGE_RETRY_MS = 2_000;
  const convergeBridgeModeAfterInvalidation = (): Promise<void> =>
    runBridgeModeConvergence({
      refresh: refreshBridgeMode,
      failClosed: () => {
        store.applyBridgeMode(DEFAULT_BRIDGE_MODE);
      },
      delay: (ms) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }),
      attempts: BRIDGE_MODE_CONVERGE_ATTEMPTS,
      retryMs: BRIDGE_MODE_CONVERGE_RETRY_MS,
    });

  chromeApi.runtime.onMessage?.addListener((message) => {
    const typed = message as { type?: unknown } | null | undefined;
    if (typed?.type === 'recued.bridge.side-panel.diagnostics-invalidated') {
      refreshDiagnostic();
    }
    if (
      typed &&
      typed.type === 'recued.bridge.side-panel.bridge-mode-invalidated'
    ) {
      void convergeBridgeModeAfterInvalidation();
    }
    // The socket just (re)connected: a status read that found it still
    // connecting can get its real answer now, not on the 30 s tick.
    if (typed && typed.type === 'recued.bridge.side-panel.server-connected') {
      void refreshStatus();
      void refreshDiagnostic();
    }
    // D-169 P2 brick 3 — the SW pushes the "Watch this element" create
    // outcome here once the user confirms a pick on the page.
    if (typed && typed.type === 'recued.bridge.side-panel.picker-result') {
      applyPickerResult(
        message as { ok?: unknown; created?: unknown; error?: unknown },
      );
    }
    return undefined;
  });

  // Kick off initial fetches. `refreshHistory` seeds + renders the
  // authoritative recent slice on mount; the 5s `refreshFrames` poll then
  // carries live bus updates on top. `refreshBridgeMode` resolves the
  // approvals interactive-vs-read-only gate before the user can act.
  // Each one returns at once while the bridge is unpaired; a pair that
  // finishes with the panel open runs them again (the storage listener).
  const loadPairedSections = (): void => {
    void refreshStatus();
    void refreshDiagnostic();
    void refreshHistory();
    void refreshBridgeMode();
    // D-181 slice 6a — seed the active-executions list on mount; the 5s
    // live-list tick below keeps it fresh.
    void refreshActive();
  };
  loadPairedSections();
  // Periodic refresh — the side panel is the user's live view; a 30s
  // status tick + 15s diagnostic tick + 5s live-list tick is a
  // reasonable battery / freshness trade. The SW handles each call as a
  // thin pass-through.
  setInterval(() => {
    void refreshStatus();
    readDesktopNotifications();
    // D-169 P2 Slice 4 — the per-bridge mode is no longer re-polled here:
    // a `bridge-mode-invalidated` push (bus-driven + on every reconnect)
    // now flips the approvals gate live, so the status tick stays a pure
    // status refresh.
  }, STATUS_REFRESH_MS);
  setInterval(() => {
    void refreshDiagnostic();
  }, DIAGNOSTIC_REFRESH_MS);
  setInterval(() => {
    void refreshFrames();
    // D-181 slice 6a — the active-executions snapshot rides the same 5s live
    // cadence as the bus-buffer lists (it is no more time-critical than the
    // approvals list, and a control action re-fetches immediately). Each poll
    // passes no notice, so a stale control line clears on the next tick.
    void refreshActive();
  }, FRAMES_REFRESH_MS);
};

void main();
