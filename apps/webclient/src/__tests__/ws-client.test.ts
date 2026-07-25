/** D-148 P4 — WS client lifecycle + exponential-backoff reconnect +
 *  401 reauth + offline send queue + jitter + listener re-attach. */

import { describe, expect, it } from 'vitest';
import {
  WEBCLIENT_WS_RECONNECT_INITIAL_MS,
  WEBCLIENT_WS_RECONNECT_JITTER_RATIO,
  WEBCLIENT_WS_RECONNECT_MAX_MS,
  WebclientReauthRequiredError,
  createWebclientWsClient,
  type WebclientWsState,
  type WebclientWsTransport,
} from '../realtime/ws-client.js';

interface FakeTransportControls {
  readonly transport: WebclientWsTransport;
  fireMessage(msg: unknown): void;
  fireState(state: WebclientWsState): void;
  /** Number of `open()` calls received. */
  openCount(): number;
  lastOpenArgs(): { server_url: string; bearer: string } | null;
  /** Force the next open call to reject with the given error. */
  failNextOpen(reason: Error): void;
  /** Captured `send()` payloads. */
  sentMessages(): unknown[];
  /** Force the next send to reject. */
  failNextSend(reason: Error): void;
}

const buildFakeTransport = (): FakeTransportControls => {
  const messageListeners = new Set<(m: unknown) => void>();
  const stateListeners = new Set<(s: WebclientWsState) => void>();
  let opens = 0;
  let last: { server_url: string; bearer: string } | null = null;
  let nextOpenErr: Error | null = null;
  const sent: unknown[] = [];
  let nextSendErr: Error | null = null;
  return {
    transport: {
      async open(args) {
        opens += 1;
        last = args;
        if (nextOpenErr) {
          const err = nextOpenErr;
          nextOpenErr = null;
          throw err;
        }
      },
      async close() {},
      async send(msg) {
        if (nextSendErr) {
          const err = nextSendErr;
          nextSendErr = null;
          throw err;
        }
        sent.push(msg);
      },
      onMessage(listener) {
        messageListeners.add(listener);
        return () => messageListeners.delete(listener);
      },
      onState(listener) {
        stateListeners.add(listener);
        return () => stateListeners.delete(listener);
      },
    },
    fireMessage(msg) {
      messageListeners.forEach((l) => l(msg));
    },
    fireState(state) {
      stateListeners.forEach((l) => l(state));
    },
    openCount: () => opens,
    lastOpenArgs: () => last,
    failNextOpen(err) {
      nextOpenErr = err;
    },
    sentMessages: () => sent,
    failNextSend(err) {
      nextSendErr = err;
    },
  };
};

interface FakeTimerControls {
  readonly setTimer: (handler: () => void, delay_ms: number) => { cancel: () => void };
  pending(): Array<{ handler: () => void; delay_ms: number }>;
  fire(idx?: number): void;
}

const buildFakeTimers = (): FakeTimerControls => {
  let arr: Array<{ handler: () => void; delay_ms: number; cancelled: boolean }> = [];
  return {
    setTimer(handler, delay_ms) {
      const slot = { handler, delay_ms, cancelled: false };
      arr.push(slot);
      return {
        cancel: () => {
          slot.cancelled = true;
        },
      };
    },
    pending: () => arr.filter((e) => !e.cancelled).map((e) => ({ handler: e.handler, delay_ms: e.delay_ms })),
    fire(idx = 0) {
      const live = arr.filter((e) => !e.cancelled);
      const target = live[idx];
      if (!target) throw new Error(`ws-client.test: no pending timer at index ${idx}`);
      target.cancelled = true;
      target.handler();
    },
  };
};

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('D-148 P4 — webclient WS lifecycle', () => {
  it('exports the documented backoff bounds + jitter ratio', () => {
    expect(WEBCLIENT_WS_RECONNECT_INITIAL_MS).toBe(1_000);
    expect(WEBCLIENT_WS_RECONNECT_MAX_MS).toBe(30_000);
    expect(WEBCLIENT_WS_RECONNECT_JITTER_RATIO).toBeCloseTo(0.2);
  });

  it('connect → connected → message dispatch', async () => {
    const ctl = buildFakeTransport();
    const timers = buildFakeTimers();
    const states: WebclientWsState[] = [];
    const messages: unknown[] = [];
    const client = createWebclientWsClient({
      transport: ctl.transport,
      resolveServerUrl: async () => 'wss://x',
      resolveBearer: async () => 'bearer-1',
      setTimer: timers.setTimer,
      random: () => 0.5, // jitter midpoint
    });
    client.onState((s) => states.push(s));
    client.onMessage((m) => messages.push(m));
    await client.connect();
    expect(ctl.openCount()).toBe(1);
    expect(ctl.lastOpenArgs()).toEqual({ server_url: 'wss://x', bearer: 'bearer-1' });
    ctl.fireState('connected');
    expect(states).toContain('connected');
    ctl.fireMessage({ kind: 'execution', recipe_id: 'r1', run_id: 'u1', op: 'progress', cursor: 1 });
    expect(messages.length).toBe(1);
  });

  it('disconnect after success → exponential backoff until reconnect succeeds', async () => {
    const ctl = buildFakeTransport();
    const timers = buildFakeTimers();
    const client = createWebclientWsClient({
      transport: ctl.transport,
      resolveServerUrl: async () => 'wss://x',
      resolveBearer: async () => 'b',
      setTimer: timers.setTimer,
      random: () => 0.5, // no jitter
      reconnect_schedule_ms: [1_000, 2_000, 4_000, 8_000],
    });
    await client.connect();
    ctl.fireState('connected');
    ctl.fireState('disconnected');
    let pending = timers.pending();
    expect(pending.length).toBe(1);
    expect(pending[0].delay_ms).toBe(1_000);
    ctl.failNextOpen(new Error('still down'));
    timers.fire();
    await tick();
    pending = timers.pending();
    expect(pending.length).toBe(1);
    expect(pending[0].delay_ms).toBe(2_000);
    timers.fire();
    await tick();
    expect(ctl.openCount()).toBe(3);
    ctl.fireState('connected');
    ctl.fireState('disconnected');
    pending = timers.pending();
    expect(pending[pending.length - 1].delay_ms).toBe(1_000);
  });

  it('Codex P3 #4 fold — backoff includes ±20% jitter', async () => {
    const ctl = buildFakeTransport();
    const timers = buildFakeTimers();
    const client = createWebclientWsClient({
      transport: ctl.transport,
      resolveServerUrl: async () => 'wss://x',
      resolveBearer: async () => 'b',
      setTimer: timers.setTimer,
      random: () => 1.0, // → +20% jitter
      reconnect_schedule_ms: [1_000, 2_000],
    });
    await client.connect();
    ctl.fireState('connected');
    ctl.fireState('disconnected');
    const pending = timers.pending();
    expect(pending[0].delay_ms).toBe(1_200);
  });

  it('Codex P2 #1 fold — 401 / reauth-required halts reconnect loop', async () => {
    const ctl = buildFakeTransport();
    const timers = buildFakeTimers();
    const client = createWebclientWsClient({
      transport: ctl.transport,
      resolveServerUrl: async () => 'wss://x',
      resolveBearer: async () => 'stale-bearer',
      setTimer: timers.setTimer,
      random: () => 0.5,
    });
    ctl.failNextOpen(new WebclientReauthRequiredError('bearer expired'));
    await client.connect();
    expect(client.state()).toBe('reauth_required');
    expect(timers.pending().length).toBe(0);
  });

  it('Codex P2 #1 fold — applyRotatedBearer resumes from reauth_required', async () => {
    const ctl = buildFakeTransport();
    const timers = buildFakeTimers();
    let bearer = 'stale';
    const client = createWebclientWsClient({
      transport: ctl.transport,
      resolveServerUrl: async () => 'wss://x',
      resolveBearer: async () => bearer,
      setTimer: timers.setTimer,
      random: () => 0.5,
    });
    ctl.failNextOpen(new WebclientReauthRequiredError());
    await client.connect();
    expect(client.state()).toBe('reauth_required');
    bearer = 'fresh';
    client.applyRotatedBearer();
    expect(client.state()).toBe('reconnecting');
    expect(timers.pending().length).toBe(1);
    timers.fire();
    await tick();
    ctl.fireState('connected');
    expect(client.state()).toBe('connected');
    expect(ctl.lastOpenArgs()?.bearer).toBe('fresh');
  });

  it('Codex P1 #2 fold — applyRotatedBearer always calls transport.clearAuthBlock (drains sticky reauth from prior auth close)', async () => {
    const ctl = buildFakeTransport();
    let clearCount = 0;
    // Extend the fake transport with a clearAuthBlock impl.
    (ctl.transport as { clearAuthBlock?: () => void }).clearAuthBlock = () => {
      clearCount += 1;
    };
    const timers = buildFakeTimers();
    const client = createWebclientWsClient({
      transport: ctl.transport,
      resolveServerUrl: async () => 'wss://x',
      resolveBearer: async () => 'b',
      setTimer: timers.setTimer,
      random: () => 0.5,
    });
    // Drive into `connected` state.
    await client.connect();
    ctl.fireState('connected');
    expect(client.state()).toBe('connected');
    // Rotation arrives while still connected — the sticky auth-block
    // could be set by the imminent OLD-WS auth close. The fix: always
    // clear, regardless of state, so the next reconnect succeeds.
    client.applyRotatedBearer();
    expect(clearCount).toBe(1);
    // applyRotatedBearer is otherwise a no-op when connected — state
    // unchanged, no new reconnect queued (the WS stays alive; the
    // fresh bearer rides through on the next natural reconnect via
    // resolveBearer).
    expect(client.state()).toBe('connected');
  });

  it('Codex P1 #2 fold — applyRotatedBearer in reauth_required clears the sticky flag AND queues reconnect', async () => {
    const ctl = buildFakeTransport();
    let clearCount = 0;
    (ctl.transport as { clearAuthBlock?: () => void }).clearAuthBlock = () => {
      clearCount += 1;
    };
    const timers = buildFakeTimers();
    const client = createWebclientWsClient({
      transport: ctl.transport,
      resolveServerUrl: async () => 'wss://x',
      resolveBearer: async () => 'b',
      setTimer: timers.setTimer,
      random: () => 0.5,
    });
    // Land in reauth_required (typical "old bearer rejected" path).
    ctl.failNextOpen(new WebclientReauthRequiredError());
    await client.connect();
    expect(client.state()).toBe('reauth_required');
    // Rotation handler persists fresh bearer + calls applyRotatedBearer.
    client.applyRotatedBearer();
    expect(clearCount).toBe(1);
    expect(client.state()).toBe('reconnecting');
    expect(timers.pending().length).toBe(1);
  });

  it('Codex P1 #2 fold — applyRotatedBearer survives a transport that lacks clearAuthBlock entirely', async () => {
    const ctl = buildFakeTransport();
    // The fake transport from buildFakeTransport() has no clearAuthBlock
    // — that mirrors a transport that hasn't opted into the optional
    // method. applyRotatedBearer must not throw.
    const timers = buildFakeTimers();
    const client = createWebclientWsClient({
      transport: ctl.transport,
      resolveServerUrl: async () => 'wss://x',
      resolveBearer: async () => 'b',
      setTimer: timers.setTimer,
      random: () => 0.5,
    });
    ctl.failNextOpen(new WebclientReauthRequiredError());
    await client.connect();
    expect(client.state()).toBe('reauth_required');
    expect(() => client.applyRotatedBearer()).not.toThrow();
    expect(client.state()).toBe('reconnecting');
  });

  it('Codex P2 #2 fold — send while disconnected enqueues + drains on reconnect', async () => {
    const ctl = buildFakeTransport();
    const timers = buildFakeTimers();
    const client = createWebclientWsClient({
      transport: ctl.transport,
      resolveServerUrl: async () => 'wss://x',
      resolveBearer: async () => 'b',
      setTimer: timers.setTimer,
      random: () => 0.5,
    });
    await client.send({ id: 'one' });
    await client.send({ id: 'two' });
    expect(client.queuedSends()).toBe(2);
    expect(ctl.sentMessages()).toEqual([]);
    await client.connect();
    ctl.fireState('connected');
    await tick();
    expect(ctl.sentMessages()).toEqual([{ id: 'one' }, { id: 'two' }]);
    expect(client.queuedSends()).toBe(0);
  });

  it('Codex P2 #2 fold — reauth_required throws + clears queued sends', async () => {
    const ctl = buildFakeTransport();
    const timers = buildFakeTimers();
    const client = createWebclientWsClient({
      transport: ctl.transport,
      resolveServerUrl: async () => 'wss://x',
      resolveBearer: async () => 'stale',
      setTimer: timers.setTimer,
      random: () => 0.5,
    });
    await client.send({ id: 'queued-pre-auth' });
    ctl.failNextOpen(new WebclientReauthRequiredError());
    await client.connect();
    expect(client.queuedSends()).toBe(0);
    await expect(client.send({ id: 'after-401' })).rejects.toBeInstanceOf(
      WebclientReauthRequiredError,
    );
  });

  it('disconnect() stops backoff + closes the transport', async () => {
    const ctl = buildFakeTransport();
    const timers = buildFakeTimers();
    const client = createWebclientWsClient({
      transport: ctl.transport,
      resolveServerUrl: async () => 'wss://x',
      resolveBearer: async () => 'b',
      setTimer: timers.setTimer,
      random: () => 0.5,
    });
    await client.connect();
    ctl.fireState('connected');
    ctl.fireState('disconnected');
    expect(timers.pending().length).toBe(1);
    await client.disconnect();
    expect(timers.pending().length).toBe(0);
    expect(client.state()).toBe('closed');
  });

  it('Codex P3 #5 fold — connect after disconnect re-registers transport listeners', async () => {
    const ctl = buildFakeTransport();
    const timers = buildFakeTimers();
    const client = createWebclientWsClient({
      transport: ctl.transport,
      resolveServerUrl: async () => 'wss://x',
      resolveBearer: async () => 'b',
      setTimer: timers.setTimer,
      random: () => 0.5,
    });
    await client.connect();
    ctl.fireState('connected');
    await client.disconnect();
    // Re-connect — should re-register and observe state changes.
    let last_state: WebclientWsState | null = null;
    client.onState((s) => (last_state = s));
    await client.connect();
    ctl.fireState('connected');
    expect(last_state).toBe('connected');
  });
});
