/** Webclient connection-status controller — derives a user-facing
 *  "is my server reachable" signal from the raw `WebclientWsClient`
 *  state machine.
 *
 *  ── Why this exists ─────────────────────────────────────────────────
 *  The ws-client (`ws-client.ts`) already owns the true connection
 *  lifecycle (`connecting / connected / reconnecting / reauth_required
 *  / closed`) and auto-reconnects with exponential backoff. But two
 *  consumers need a COARSER, debounced view of it:
 *
 *    1. the topbar status chip + offline banner — "Connected" vs
 *       "Reconnecting…" vs "Offline" (so the UI stops looking logged-in
 *       while the paired server is actually unreachable), and
 *    2. the rpc conn — so a call against a genuinely-down server
 *       fails fast with `server_offline` instead of parking on the 30s
 *       per-call timeout.
 *
 *  Both want the SAME distinction the raw state machine doesn't draw on
 *  its own: a brief reconnect blip (a server restart, a flaky network
 *  hiccup) should be ridden out silently, but a sustained outage should
 *  surface + fast-fail. This controller centralizes that one judgement
 *  so the chip, the banner, and the rpc layer never disagree.
 *
 *  ── The derived states ──────────────────────────────────────────────
 *    - `connecting`   — never yet reached `connected` this session and
 *                       still within the grace window (fresh boot).
 *    - `connected`    — the socket is up.
 *    - `reconnecting` — was connected, the socket dropped, still within
 *                       the grace window (ride-out-the-blip).
 *    - `stalled`      — the socket is UP but the server stopped answering:
 *                       no `server_heartbeat` arrived for the stale window
 *                       while `connected` (a half-open restart — socket
 *                       accepted before the rpc/warehouse layer was ready).
 *                       Auto-recovers on the next beat, so it wears the calm
 *                       `reconnecting` presentation (nothing for the user to
 *                       do) — but the rpc layer still fast-fails it.
 *    - `offline`      — the socket has been continuously non-`connected`
 *                       past the grace window, OR the ws-client reported
 *                       `closed` / `reauth_required` (a non-transient
 *                       failure that won't self-heal without user
 *                       action). This is the state the rpc layer
 *                       fast-fails on + the banner appears for.
 *
 *  ── Half-open detection (the heartbeat) ─────────────────────────────
 *  A socket can read `connected` while the server behind it is restarting
 *  and answering nothing. The server PUSHES a `server_heartbeat` every
 *  ~SERVER_HEARTBEAT_INTERVAL_MS while it is `running`; the bootstrap feeds
 *  each arrival to `noteHeartbeat()`. While `connected` a stale timer runs;
 *  every beat resets it; if it fires (beats stopped) the status crosses to
 *  `stalled`. The next beat recovers it to `connected`. Recovery is thus
 *  beat-driven, never a probe rpc — which is why the rpc layer can safely
 *  fast-fail `stalled` (a healthy server proves itself again on its own).
 *
 *  ── The grace timer (the one non-obvious invariant) ─────────────────
 *  While a server is down the ws-client CHURNS `connecting → reconnecting
 *  → connecting → …` across its backoff loop. The grace timer is armed
 *  ONCE when the socket first leaves `connected` (or at construction,
 *  since we boot non-connected) and is NOT re-armed on that churn — only
 *  a real `connected` clears it. Re-arming on every transition would
 *  push the offline deadline forever and `offline` would never trigger.
 *
 *  ── Seams ───────────────────────────────────────────────────────────
 *  `setTimer` mirrors the ws-client's timer seam (returns a `{ cancel }`
 *  handle) so tests drive BOTH the grace deadline and the heartbeat-stale
 *  deadline deterministically (distinguished by `delayMs`). The controller
 *  reads `ws.onState` + `ws.state()` and is fed beats via `noteHeartbeat()`;
 *  it never mutates the socket. */

import { SERVER_HEARTBEAT_INTERVAL_MS } from '@recued/contracts';

import type { WebclientWsClient, WebclientWsState } from './ws-client.js';

/** How long the socket may sit continuously non-`connected` before the
 *  status crosses to `offline`. Long enough to ride out a quick server
 *  restart / network blip without a scary flash; short enough that an
 *  rpc against a genuinely-down server fast-fails well inside the 30s
 *  per-call timeout. */
export const WEBCLIENT_OFFLINE_GRACE_MS = 6_000;

/** How long the socket may sit `connected` WITHOUT a `server_heartbeat`
 *  before the status crosses to `stalled` — a half-open server (the socket
 *  was accepted but the rpc/warehouse layer isn't answering yet, e.g. a
 *  restarting server). The server pushes a beat every
 *  `SERVER_HEARTBEAT_INTERVAL_MS` while `running`, so 3 missed beats means
 *  it is NOT responding. Tight enough to fast-fail rpcs well inside their
 *  30s timeout; loose enough to ride a single dropped push. */
export const WEBCLIENT_HEARTBEAT_STALE_MS = 3 * SERVER_HEARTBEAT_INTERVAL_MS;

/** After the stale window elapses, wait this much longer before actually
 *  crossing to `stalled`. The grace covers a beat that is already QUEUED
 *  but not yet dispatched — which happens when the event loop was starved
 *  past the stale window (a backgrounded/throttled tab, a long main-thread
 *  task): the overdue stale timer must not win the race against the buffered
 *  heartbeat and flash a spurious `stalled`. Short — the event loop drains
 *  queued messages in well under this once it resumes. */
export const WEBCLIENT_HEARTBEAT_STALE_CONFIRM_MS = 2_000;

export type WebclientConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  /** Socket is up but the server stopped answering — no `server_heartbeat`
   *  in {@link WEBCLIENT_HEARTBEAT_STALE_MS} while `connected`. A restarting
   *  server that accepted the socket before it was ready. Auto-recovers on
   *  the next beat, so it wears the calm `reconnecting` presentation (there
   *  is nothing for the user to do) — but the rpc layer still fast-fails it
   *  so calls don't hang the full 30s. */
  | 'stalled'
  | 'offline';

/** A reconnect subscription seam — fires the listener on each transition
 *  INTO `connected` (including the first connect, since a server that was
 *  down at boot recovers via that same transition). Surfaces that hold a
 *  one-shot server-push registration — the approvals route + the attention
 *  popover's `approval.subscribe` — re-arm it on each fire so a RESTARTED
 *  server (which kept no subscription record) re-registers the client and
 *  any stale "live updates unavailable" error clears. Returns an unsub. */
export type WebclientReconnectSubscriber = (
  listener: () => void,
) => () => void;

/** Build a {@link WebclientReconnectSubscriber} from a status controller —
 *  fires the listener whenever the status reaches `connected`. */
export const reconnectSubscriberFromStatus = (
  controller: Pick<WebclientConnectionStatusController, 'onStatus'>,
): WebclientReconnectSubscriber => {
  return (listener) =>
    controller.onStatus((status) => {
      if (status === 'connected') listener();
    });
};

export interface WebclientConnectionStatusController {
  /** Current derived status. */
  status(): WebclientConnectionStatus;
  /** True only when the socket is genuinely down past the grace window
   *  (`offline`). Does NOT cover `stalled` — that is a socket-up state. The
   *  rpc layer reads `status()` directly to fast-fail BOTH with distinct
   *  codes, so this stays a narrow "is the socket down" predicate. */
  isOffline(): boolean;
  /** Feed a `server_heartbeat` arrival — proof the paired server is
   *  responsive right now. Resets the stale countdown while `connected`,
   *  and recovers `stalled → connected`. A no-op in socket-down states
   *  (a beat can only arrive over an open socket; the ws-state machine
   *  owns those transitions). */
  noteHeartbeat(): void;
  /** Subscribe to status transitions. Does NOT fire synchronously with
   *  the current value — read `status()` once for the initial render,
   *  then listen. Returns an unsubscribe fn. */
  onStatus(listener: (status: WebclientConnectionStatus) => void): () => void;
  /** Detach the ws-state subscription + cancel the grace timer.
   *  Idempotent. */
  dispose(): void;
}

interface ConnectionStatusOptions {
  /** The ws-client whose state drives this controller. Only `onState`
   *  + `state` are read. */
  ws: Pick<WebclientWsClient, 'onState' | 'state'>;
  /** Override the grace window (tests; bespoke compositions). */
  offlineGraceMs?: number;
  /** Override the heartbeat-stale window (tests). Defaults to
   *  {@link WEBCLIENT_HEARTBEAT_STALE_MS}. */
  heartbeatStaleMs?: number;
  /** Override the post-stale confirmation window (tests). Defaults to
   *  {@link WEBCLIENT_HEARTBEAT_STALE_CONFIRM_MS}. */
  heartbeatStaleConfirmMs?: number;
  /** Schedule a delayed callback (tests inject a deterministic timer).
   *  Mirrors the ws-client's `setTimer` seam. Drives BOTH the grace timer
   *  and the heartbeat-stale timer — tests distinguish them by `delayMs`. */
  setTimer?(handler: () => void, delayMs: number): { cancel: () => void };
}

const realTimer = (
  handler: () => void,
  delayMs: number,
): { cancel: () => void } => {
  const id = setTimeout(handler, delayMs);
  return { cancel: () => clearTimeout(id) };
};

export const createWebclientConnectionStatus = (
  options: ConnectionStatusOptions,
): WebclientConnectionStatusController => {
  const setTimer = options.setTimer ?? realTimer;
  const graceMs = options.offlineGraceMs ?? WEBCLIENT_OFFLINE_GRACE_MS;
  const staleMs = options.heartbeatStaleMs ?? WEBCLIENT_HEARTBEAT_STALE_MS;
  const staleConfirmMs =
    options.heartbeatStaleConfirmMs ?? WEBCLIENT_HEARTBEAT_STALE_CONFIRM_MS;

  // Boot non-connected: the bootstrap constructs this BEFORE the first
  // `ws.connect()`, so we start in `connecting` and arm the grace timer
  // immediately — a server that's down at boot crosses to `offline`
  // after the grace window without ever needing a state transition.
  let cur: WebclientConnectionStatus = 'connecting';
  let graceTimer: { cancel: () => void } | null = null;
  // SEPARATE from the grace timer: armed while `connected`, reset by each
  // heartbeat; firing it (no beat in the window) is what crosses to
  // `stalled`. Unlike grace it is NOT armed-once — every beat re-arms it.
  let staleTimer: { cancel: () => void } | null = null;
  let disposed = false;
  const listeners = new Set<(s: WebclientConnectionStatus) => void>();

  const emit = (next: WebclientConnectionStatus): void => {
    if (cur === next) return;
    cur = next;
    for (const l of [...listeners]) {
      try {
        l(cur);
      } catch {
        // Listener errors isolated — same discipline as ws-client.ts.
      }
    }
  };

  const cancelGrace = (): void => {
    if (graceTimer !== null) {
      graceTimer.cancel();
      graceTimer = null;
    }
  };

  const armGrace = (): void => {
    // Armed-once: do NOT reset an in-flight timer. The ws-client churns
    // connecting↔reconnecting across its backoff loop while a server is
    // down; re-arming on that churn would push the offline deadline out
    // forever and `offline` would never fire.
    if (graceTimer !== null) return;
    graceTimer = setTimer(() => {
      graceTimer = null;
      if (disposed) return;
      // Only commit to offline if we haven't reconnected in the meantime.
      if (cur !== 'connected') emit('offline');
    }, graceMs);
  };

  const cancelStale = (): void => {
    if (staleTimer !== null) {
      staleTimer.cancel();
      staleTimer = null;
    }
  };

  // Phase 2 of stale detection — see `armStale`. Split out so the single
  // `staleTimer` handle carries both phases (only one is ever pending), and
  // `cancelStale` / `armStale` / `noteHeartbeat` cancel whichever is live.
  const onStaleWindowElapsed = (): void => {
    staleTimer = null;
    if (disposed) return;
    // Socket already dropped → the ws-state path owns the transition.
    if (cur !== 'connected') return;
    // A short confirmation window before declaring `stalled`, so a beat that
    // is already QUEUED but not yet dispatched can land first. This matters
    // when the event loop was starved PAST the stale window — a backgrounded
    // / throttled tab, a long main-thread task — and the overdue timer would
    // otherwise beat the buffered heartbeat to a spurious `stalled`. A beat
    // here re-arms phase 1 via `noteHeartbeat`; continued silence commits.
    staleTimer = setTimer(() => {
      staleTimer = null;
      if (disposed) return;
      if (cur === 'connected') emit('stalled');
    }, staleConfirmMs);
  };

  const armStale = (): void => {
    // Phase 1 — the full no-beat window. Reset-on-each-beat (NOT armed-once):
    // a healthy server beats every ~SERVER_HEARTBEAT_INTERVAL_MS and each beat
    // re-arms this, so it only elapses when beats actually STOP for the whole
    // window. Only a `connected` socket expects beats.
    cancelStale();
    staleTimer = setTimer(onStaleWindowElapsed, staleMs);
  };

  const onWsState = (state: WebclientWsState): void => {
    if (disposed) return;
    if (state === 'connected') {
      cancelGrace();
      emit('connected');
      // Now expect beats — arm a fresh stale countdown. A healthy server's
      // first beat (within ~SERVER_HEARTBEAT_INTERVAL_MS) re-arms it; a
      // half-open server that accepted the socket but isn't `running` sends
      // none, so this fires → `stalled`.
      armStale();
      return;
    }
    if (state === 'closed') {
      // A deliberate stop — skip the grace window and surface offline now.
      cancelGrace();
      cancelStale();
      emit('offline');
      return;
    }
    // `connecting` / `reconnecting` / `disconnected` / `reauth_required` —
    // a non-connected state we treat as transient. Surface "reconnecting"
    // only once we've been connected at least once this session (a fresh
    // boot stays "connecting"); either way keep the grace timer running
    // toward `offline`.
    //
    // `reauth_required` deliberately rides this transient path rather than
    // jumping straight to `offline`: it is an AUTHORIZATION failure, not a
    // reachability outage. It is owned by the bootstrap's reauth funnel
    // (which remounts the pair form) and by the rpc conn's own
    // `WebclientReauthRequiredError` → `webclient_reauth_required` mapping.
    // If the controller emitted `offline` here it would fire synchronously
    // inside the same `setState('reauth_required')` that throws from
    // `ws.send`, and the offline pending-sweep would preempt that specific
    // reauth rejection with a generic `connection_lost`. Leaving it
    // transient lets the reauth path win; the grace window is still a
    // backstop that surfaces `offline` if no remount ever arrives.
    //
    // The socket is down → no beats can arrive; cancel the stale timer so
    // it can't race a spurious `stalled` while the grace/offline path owns
    // this. `stalled` counts as "was connected" here (the socket was up),
    // so a drop out of `stalled` surfaces `reconnecting` like a drop out of
    // `connected`.
    cancelStale();
    if (cur === 'connected' || cur === 'stalled') emit('reconnecting');
    if (cur !== 'offline') armGrace();
  };

  const detach = options.ws.onState(onWsState);
  // Boot is non-connected — start the clock toward offline immediately so
  // a server that's unreachable from the very first connect attempt still
  // surfaces, even if no further state transition arrives.
  armGrace();

  return {
    status: () => cur,
    isOffline: () => cur === 'offline',
    noteHeartbeat() {
      if (disposed) return;
      // A beat can only have arrived over an open socket, so it is proof of
      // life. Recover from `stalled`, then re-arm the stale countdown. In a
      // socket-down state (`connecting` / `reconnecting` / `offline`) ignore
      // it — the ws-state machine owns those, and arming a stale timer there
      // would race the grace/offline path.
      if (cur === 'stalled') emit('connected');
      if (cur === 'connected') armStale();
    },
    onStatus(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelGrace();
      cancelStale();
      detach();
      listeners.clear();
    },
  };
};
