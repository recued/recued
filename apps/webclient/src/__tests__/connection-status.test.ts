/** Webclient connection-status controller acceptance.
 *
 *  Drives `createWebclientConnectionStatus` over a fake ws (settable
 *  `state` + a `fireState` driver) and an injected timer seam so the
 *  grace deadline fires deterministically. Pins the derived states
 *  (`connecting / connected / reconnecting / offline`), the ARMED-ONCE
 *  grace invariant (connecting↔reconnecting backoff churn must not keep
 *  pushing the offline deadline out), ride-out-the-blip, the
 *  non-transient `closed` / `reauth_required` immediate-offline, and
 *  dispose teardown. */

import { HEARTBEAT_STALE_MS } from '@recued/contracts';
import { describe, expect, it } from 'vitest';

import {
  WEBCLIENT_HEARTBEAT_STALE_MS,
  WEBCLIENT_OFFLINE_GRACE_MS,
  createWebclientConnectionStatus,
  reconnectSubscriberFromStatus,
  type WebclientConnectionStatus,
} from '../realtime/connection-status.js';
import type { WebclientWsState } from '../realtime/ws-client.js';

// ──────────────────────────────────────────────────────────────────
// Fakes
// ──────────────────────────────────────────────────────────────────

const buildFakeWs = () => {
  let cur: WebclientWsState = 'disconnected';
  const listeners = new Set<(s: WebclientWsState) => void>();
  return {
    ws: {
      state: () => cur,
      onState: (l: (s: WebclientWsState) => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
    fireState: (s: WebclientWsState): void => {
      cur = s;
      for (const l of [...listeners]) l(s);
    },
    listenerCount: () => listeners.size,
  };
};

interface TimerSlot {
  handler: () => void;
  delayMs: number;
  cancelled: boolean;
}

const buildFakeTimers = () => {
  const slots: TimerSlot[] = [];
  return {
    setTimer(handler: () => void, delayMs: number): { cancel: () => void } {
      const slot: TimerSlot = { handler, delayMs, cancelled: false };
      slots.push(slot);
      return {
        cancel: () => {
          slot.cancelled = true;
        },
      };
    },
    /** Live (un-cancelled, un-fired) timers. */
    pending: () => slots.filter((s) => !s.cancelled),
    /** Total timers ever armed (incl. cancelled) — proves armed-once. */
    armedTotal: () => slots.length,
    fire(idx = 0): void {
      const live = slots.filter((s) => !s.cancelled);
      const target = live[idx];
      if (!target) throw new Error(`no live timer at index ${idx}`);
      target.cancelled = true;
      target.handler();
    },
  };
};

// ──────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────

describe('webclient connection-status controller', () => {
  it('exports a sane default grace window', () => {
    expect(WEBCLIENT_OFFLINE_GRACE_MS).toBeGreaterThan(1000);
    expect(WEBCLIENT_OFFLINE_GRACE_MS).toBeLessThan(30_000);
  });

  it('boots `connecting` and arms exactly one grace timer', () => {
    const ws = buildFakeWs();
    const timers = buildFakeTimers();
    const ctrl = createWebclientConnectionStatus({
      ws: ws.ws,
      setTimer: timers.setTimer,
    });
    expect(ctrl.status()).toBe('connecting');
    expect(ctrl.isOffline()).toBe(false);
    expect(timers.armedTotal()).toBe(1);
    ctrl.dispose();
  });

  it('reaches `connected` on the ws `connected` transition + cancels the grace timer', () => {
    const ws = buildFakeWs();
    const timers = buildFakeTimers();
    const ctrl = createWebclientConnectionStatus({
      ws: ws.ws,
      setTimer: timers.setTimer,
    });
    ws.fireState('connecting');
    ws.fireState('connected');
    expect(ctrl.status()).toBe('connected');
    // Boot grace cancelled; the heartbeat-stale timer is now armed (1 live).
    expect(timers.pending().length).toBe(1);
    ctrl.dispose();
  });

  it('a sustained drop crosses to `offline` after the grace window', () => {
    const ws = buildFakeWs();
    const timers = buildFakeTimers();
    const ctrl = createWebclientConnectionStatus({
      ws: ws.ws,
      setTimer: timers.setTimer,
    });
    ws.fireState('connected');
    ws.fireState('reconnecting');
    expect(ctrl.status()).toBe('reconnecting');
    expect(ctrl.isOffline()).toBe(false);
    timers.fire(); // grace deadline
    expect(ctrl.status()).toBe('offline');
    expect(ctrl.isOffline()).toBe(true);
    ctrl.dispose();
  });

  it('ARMED-ONCE: the connecting↔reconnecting backoff churn never re-arms the grace timer', () => {
    const ws = buildFakeWs();
    const timers = buildFakeTimers();
    const ctrl = createWebclientConnectionStatus({
      ws: ws.ws,
      setTimer: timers.setTimer,
    });
    ws.fireState('connected'); // cancels the boot grace
    ws.fireState('reconnecting'); // arms grace #2
    // The ws-client churns these across its backoff loop while the server
    // is down — none of them may push the offline deadline out.
    ws.fireState('connecting');
    ws.fireState('reconnecting');
    ws.fireState('connecting');
    ws.fireState('reconnecting');
    expect(timers.pending().length).toBe(1); // still exactly one live timer
    expect(ctrl.status()).toBe('reconnecting');
    timers.fire();
    expect(ctrl.status()).toBe('offline');
    ctrl.dispose();
  });

  it('rides out a blip: reconnecting → connected before the grace fires stays connected', () => {
    const ws = buildFakeWs();
    const timers = buildFakeTimers();
    const ctrl = createWebclientConnectionStatus({
      ws: ws.ws,
      setTimer: timers.setTimer,
    });
    ws.fireState('connected');
    ws.fireState('reconnecting');
    ws.fireState('connected'); // reconnected within the grace
    expect(ctrl.status()).toBe('connected');
    // Grace cancelled (no offline); the heartbeat-stale timer is armed (1 live).
    expect(timers.pending().length).toBe(1);
    ctrl.dispose();
  });

  it('recovers from `offline` back to `connected` on reconnect', () => {
    const ws = buildFakeWs();
    const timers = buildFakeTimers();
    const ctrl = createWebclientConnectionStatus({
      ws: ws.ws,
      setTimer: timers.setTimer,
    });
    ws.fireState('connected');
    ws.fireState('reconnecting');
    timers.fire();
    expect(ctrl.status()).toBe('offline');
    ws.fireState('connected');
    expect(ctrl.status()).toBe('connected');
    expect(ctrl.isOffline()).toBe(false);
    ctrl.dispose();
  });

  it('`closed` goes straight to `offline` without waiting out the grace', () => {
    const ws = buildFakeWs();
    const timers = buildFakeTimers();
    const ctrl = createWebclientConnectionStatus({
      ws: ws.ws,
      setTimer: timers.setTimer,
    });
    ws.fireState('connected');
    ws.fireState('closed');
    expect(ctrl.status()).toBe('offline');
    expect(timers.pending().length).toBe(0);
    ctrl.dispose();
  });

  it('`reauth_required` is transient (reconnecting), NOT an immediate offline', () => {
    // Reauth is an authorization failure owned by the reauth funnel + the
    // rpc conn's own `webclient_reauth_required` mapping. Emitting `offline`
    // synchronously here would let the offline sweep preempt that specific
    // rejection (it fires inside the same setState that throws from
    // ws.send). So it rides the transient path; the grace is the backstop.
    const ws = buildFakeWs();
    const timers = buildFakeTimers();
    const ctrl = createWebclientConnectionStatus({
      ws: ws.ws,
      setTimer: timers.setTimer,
    });
    ws.fireState('connected');
    ws.fireState('reauth_required');
    expect(ctrl.status()).toBe('reconnecting'); // not offline
    timers.fire(); // backstop: still surfaces offline if no remount arrives
    expect(ctrl.status()).toBe('offline');
    ctrl.dispose();
  });

  it('a server down from boot crosses to `offline` when the boot grace fires', () => {
    const ws = buildFakeWs();
    const timers = buildFakeTimers();
    const ctrl = createWebclientConnectionStatus({
      ws: ws.ws,
      setTimer: timers.setTimer,
    });
    // No `connected` ever arrives. The boot grace alone takes us offline.
    timers.fire();
    expect(ctrl.status()).toBe('offline');
    ctrl.dispose();
  });

  it('onStatus emits transitions (not the current value on subscribe) + dispose teardown', () => {
    const ws = buildFakeWs();
    const timers = buildFakeTimers();
    const ctrl = createWebclientConnectionStatus({
      ws: ws.ws,
      setTimer: timers.setTimer,
    });
    const seen: WebclientConnectionStatus[] = [];
    const unsub = ctrl.onStatus((s) => seen.push(s));
    expect(seen).toEqual([]); // no synchronous replay
    ws.fireState('connected');
    ws.fireState('reconnecting');
    timers.fire();
    expect(seen).toEqual(['connected', 'reconnecting', 'offline']);
    unsub();
    ws.fireState('connected');
    expect(seen).toEqual(['connected', 'reconnecting', 'offline']); // unsubbed
    ctrl.dispose();
  });

  it('dispose detaches the ws listener, cancels the timer, and is idempotent', () => {
    const ws = buildFakeWs();
    const timers = buildFakeTimers();
    const ctrl = createWebclientConnectionStatus({
      ws: ws.ws,
      setTimer: timers.setTimer,
    });
    expect(ws.listenerCount()).toBe(1);
    ctrl.dispose();
    expect(ws.listenerCount()).toBe(0);
    expect(timers.pending().length).toBe(0);
    // Post-dispose state changes are inert; double-dispose does not throw.
    expect(() => ws.fireState('connected')).not.toThrow();
    expect(() => ctrl.dispose()).not.toThrow();
  });

  it('reconnectSubscriberFromStatus fires only on connected transitions + unsub stops it', () => {
    const ws = buildFakeWs();
    const timers = buildFakeTimers();
    const ctrl = createWebclientConnectionStatus({
      ws: ws.ws,
      setTimer: timers.setTimer,
    });
    const reconnect = reconnectSubscriberFromStatus(ctrl);
    let fires = 0;
    const unsub = reconnect(() => {
      fires += 1;
    });
    ws.fireState('connected'); // +1
    ws.fireState('reconnecting'); // ignored
    ws.fireState('connected'); // +1 (a genuine reconnect)
    expect(fires).toBe(2);
    unsub();
    ws.fireState('reconnecting');
    ws.fireState('connected'); // unsubscribed — no fire
    expect(fires).toBe(2);
    ctrl.dispose();
  });

  it('a listener that throws does not derail the emit loop', () => {
    const ws = buildFakeWs();
    const timers = buildFakeTimers();
    const ctrl = createWebclientConnectionStatus({
      ws: ws.ws,
      setTimer: timers.setTimer,
    });
    const seen: WebclientConnectionStatus[] = [];
    ctrl.onStatus(() => {
      throw new Error('boom');
    });
    ctrl.onStatus((s) => seen.push(s));
    expect(() => ws.fireState('connected')).not.toThrow();
    expect(seen).toEqual(['connected']);
    ctrl.dispose();
  });
});

describe('webclient connection-status: heartbeat half-open detection', () => {
  it('exports a stale window tighter than the pill, wider than the grace', () => {
    expect(WEBCLIENT_HEARTBEAT_STALE_MS).toBeGreaterThan(WEBCLIENT_OFFLINE_GRACE_MS);
    expect(WEBCLIENT_HEARTBEAT_STALE_MS).toBeLessThan(HEARTBEAT_STALE_MS);
  });

  it('crosses to `stalled` after the stale window + confirmation when beats stop', () => {
    const ws = buildFakeWs();
    const timers = buildFakeTimers();
    const ctrl = createWebclientConnectionStatus({
      ws: ws.ws,
      setTimer: timers.setTimer,
    });
    ws.fireState('connected');
    expect(ctrl.status()).toBe('connected');
    timers.fire(); // phase 1: stale window elapsed → arms the confirmation timer
    expect(ctrl.status()).toBe('connected'); // not yet — confirmation pending
    timers.fire(); // phase 2: confirmation elapsed with no beat → stalled
    expect(ctrl.status()).toBe('stalled');
    // `stalled` is a socket-UP state — NOT offline.
    expect(ctrl.isOffline()).toBe(false);
    ctrl.dispose();
  });

  it('`stalled` does NOT escalate to offline — it arms no grace timer', () => {
    const ws = buildFakeWs();
    const timers = buildFakeTimers();
    const ctrl = createWebclientConnectionStatus({
      ws: ws.ws,
      setTimer: timers.setTimer,
    });
    ws.fireState('connected');
    timers.fire();
    timers.fire(); // → stalled
    expect(ctrl.status()).toBe('stalled');
    // No live timer left: stalled holds until a beat or a socket event, and
    // must never drift to the red `offline` state on its own.
    expect(timers.pending().length).toBe(0);
    ctrl.dispose();
  });

  it('a heartbeat resets the stale window (a healthy server never stalls)', () => {
    const ws = buildFakeWs();
    const timers = buildFakeTimers();
    const ctrl = createWebclientConnectionStatus({
      ws: ws.ws,
      setTimer: timers.setTimer,
    });
    ws.fireState('connected');
    const armedAfterConnect = timers.armedTotal();
    ctrl.noteHeartbeat();
    // The old stale timer was cancelled and a fresh one armed — exactly one
    // live, and the total grew by one.
    expect(timers.pending().length).toBe(1);
    expect(timers.armedTotal()).toBe(armedAfterConnect + 1);
    expect(ctrl.status()).toBe('connected');
    ctrl.dispose();
  });

  it('a heartbeat recovers `stalled` back to `connected` and re-arms detection', () => {
    const ws = buildFakeWs();
    const timers = buildFakeTimers();
    const ctrl = createWebclientConnectionStatus({
      ws: ws.ws,
      setTimer: timers.setTimer,
    });
    ws.fireState('connected');
    timers.fire();
    timers.fire(); // → stalled
    expect(ctrl.status()).toBe('stalled');
    ctrl.noteHeartbeat();
    expect(ctrl.status()).toBe('connected');
    // Detection is re-armed: stop beats again → stalled again.
    timers.fire();
    timers.fire();
    expect(ctrl.status()).toBe('stalled');
    ctrl.dispose();
  });

  it('a beat during the confirmation window aborts the stalled crossing', () => {
    // The event-loop-starvation guard: an overdue stale timer fires, but a
    // heartbeat that was queued-but-not-yet-dispatched lands during the
    // confirmation window — so we must NOT flash `stalled`.
    const ws = buildFakeWs();
    const timers = buildFakeTimers();
    const ctrl = createWebclientConnectionStatus({
      ws: ws.ws,
      setTimer: timers.setTimer,
    });
    ws.fireState('connected');
    timers.fire(); // phase 1 elapsed → confirmation armed
    expect(ctrl.status()).toBe('connected');
    ctrl.noteHeartbeat(); // the straggler beat arrives → abort + re-arm phase 1
    expect(ctrl.status()).toBe('connected');
    expect(timers.pending().length).toBe(1);
    // Prove the live timer is a FRESH full stale window, not the lingering
    // confirmation timer: reaching stalled again must take BOTH phases (two
    // fires). If the abort had failed to cancel the old confirm timer, the
    // first fire below would jump straight to stalled and this would fail.
    timers.fire(); // phase 1 again → arms confirmation
    expect(ctrl.status()).toBe('connected');
    timers.fire(); // confirmation → stalled
    expect(ctrl.status()).toBe('stalled');
    ctrl.dispose();
  });

  it('a drop out of `stalled` surfaces `reconnecting`, then `offline` via grace', () => {
    const ws = buildFakeWs();
    const timers = buildFakeTimers();
    const ctrl = createWebclientConnectionStatus({
      ws: ws.ws,
      setTimer: timers.setTimer,
    });
    ws.fireState('connected');
    timers.fire();
    timers.fire(); // → stalled
    ws.fireState('reconnecting'); // the socket actually dropped now
    expect(ctrl.status()).toBe('reconnecting');
    timers.fire(); // grace deadline
    expect(ctrl.status()).toBe('offline');
    ctrl.dispose();
  });

  it('a heartbeat in a socket-down state is ignored (no spurious recovery)', () => {
    const ws = buildFakeWs();
    const timers = buildFakeTimers();
    const ctrl = createWebclientConnectionStatus({
      ws: ws.ws,
      setTimer: timers.setTimer,
    });
    ws.fireState('connected');
    ws.fireState('reconnecting'); // socket down, riding the grace window
    expect(ctrl.status()).toBe('reconnecting');
    const liveBefore = timers.pending().length; // just the grace timer
    ctrl.noteHeartbeat(); // a stray beat — the ws-state path owns this
    expect(ctrl.status()).toBe('reconnecting');
    expect(timers.pending().length).toBe(liveBefore); // no stale timer armed
    ctrl.dispose();
  });

  it('dispose cancels the heartbeat-stale timer', () => {
    const ws = buildFakeWs();
    const timers = buildFakeTimers();
    const ctrl = createWebclientConnectionStatus({
      ws: ws.ws,
      setTimer: timers.setTimer,
    });
    ws.fireState('connected');
    expect(timers.pending().length).toBe(1); // stale armed
    ctrl.dispose();
    expect(timers.pending().length).toBe(0);
    // A post-dispose beat is inert — it must NOT re-arm a (leaked) timer.
    expect(() => ctrl.noteHeartbeat()).not.toThrow();
    expect(timers.pending().length).toBe(0);
  });
});
