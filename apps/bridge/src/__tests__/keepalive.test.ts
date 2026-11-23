/** D-148 P3 — keepalive ticker tests.
 *
 *  Covers spec § A.3.3: alarm tick reconnects WS if disconnected,
 *  sweeps idempotency cache, returns telemetry. */

import { describe, it, expect, vi } from 'vitest';
import {
  KEEPALIVE_ALARM_NAME,
  KEEPALIVE_PERIOD_MINUTES,
  KEEPALIVE_PING_INTERVAL_MS,
  installKeepaliveAlarm,
  removeKeepaliveAlarm,
  runKeepaliveTick,
  type ChromeAlarmsApi,
  type KeepaliveTickContext,
} from '../transport/keepalive.js';
import { createInMemoryIdempotencyCache } from '../idempotency/cache.js';
import { BRIDGE_IDEMPOTENCY_TTL_MS, type BridgeResult } from '@recued/contracts';

const buildResult = (id: string): BridgeResult => ({
  command_id: id,
  status: 'ok',
  outputs: {},
  duration_ms: 1,
  bridge_version: '0.0.1',
  idempotency_key_seen: false,
});

const buildFakeWs = (initial_connected: boolean) => {
  const state = { connected: initial_connected, started: 0 };
  return {
    state,
    isConnected: () => state.connected,
    async start() {
      state.started++;
      state.connected = true;
    },
    async stop() {
      state.connected = false;
    },
    currentBackoff: () => 1_000,
    attempts: () => 0,
    send: () => undefined,
  };
};

const buildAlarms = () => {
  const listeners = new Set<(alarm: { name: string }) => void>();
  const scheduled = new Set<string>();
  const alarms: ChromeAlarmsApi = {
    create: name => { scheduled.add(name); },
    clear: name => { scheduled.delete(name); },
    onAlarm: {
      addListener: handler => { listeners.add(handler); },
      removeListener: handler => { listeners.delete(handler); },
    },
  };
  return { alarms, listeners, fire() {
    if (scheduled.has(KEEPALIVE_ALARM_NAME)) {
      for (const listener of [...listeners]) listener({ name: KEEPALIVE_ALARM_NAME });
    }
  } };
};

describe('D-148 P3 — keepalive constants', () => {
  it('alarm name + period + ping interval per spec § A.3.3', () => {
    expect(KEEPALIVE_ALARM_NAME).toBe('recued.bridge.keepalive');
    expect(KEEPALIVE_PERIOD_MINUTES).toBe(0.5);
    expect(KEEPALIVE_PING_INTERVAL_MS).toBe(25_000);
  });
});

describe('D-148 P3 — keepalive tick reconnect', () => {
  it('disconnected WS → tick triggers ws.start + reports reconnected', async () => {
    const ws = buildFakeWs(false);
    const cache = createInMemoryIdempotencyCache();
    const ctx: KeepaliveTickContext = {
      // Cast preserves the WsClient subset the keepalive needs.
      ws: ws as unknown as KeepaliveTickContext['ws'],
      idempotency: cache,
      now: () => 1_000,
    };
    const report = await runKeepaliveTick(ctx);
    expect(report.reconnected).toBe(true);
    expect(report.ws_connected).toBe(true);
    expect(ws.state.started).toBe(1);
  });

  it('connected WS → tick is no-op for connection state', async () => {
    const ws = buildFakeWs(true);
    const cache = createInMemoryIdempotencyCache();
    const ctx: KeepaliveTickContext = {
      ws: ws as unknown as KeepaliveTickContext['ws'],
      idempotency: cache,
      now: () => 1_000,
    };
    const report = await runKeepaliveTick(ctx);
    expect(report.reconnected).toBe(false);
    expect(ws.state.started).toBe(0);
  });
});

describe('D-148 P3 — keepalive sweeps idempotency cache', () => {
  it('expired entries removed during tick', async () => {
    let now = 1_000;
    const ws = buildFakeWs(true);
    const cache = createInMemoryIdempotencyCache({ now: () => now });
    await cache.store('cmd-1', 'idem-1', buildResult('cmd-1'));
    now += BRIDGE_IDEMPOTENCY_TTL_MS + 1;
    const report = await runKeepaliveTick({
      ws: ws as unknown as KeepaliveTickContext['ws'],
      idempotency: cache,
      now: () => now,
    });
    expect(report.expired_swept).toBe(1);
  });

  it('fresh entries survive sweep', async () => {
    const ws = buildFakeWs(true);
    const cache = createInMemoryIdempotencyCache({ now: () => 1_000 });
    await cache.store('cmd-fresh', 'idem-fresh', buildResult('cmd-fresh'));
    const report = await runKeepaliveTick({
      ws: ws as unknown as KeepaliveTickContext['ws'],
      idempotency: cache,
      now: () => 1_500,
    });
    expect(report.expired_swept).toBe(0);
    expect(await cache.list()).toHaveLength(1);
  });

  it('propagates storage failure to a direct tick caller', async () => {
    const cache = createInMemoryIdempotencyCache();
    cache.sweepExpired = async () => { throw new Error('database unavailable'); };
    await expect(runKeepaliveTick({
      ws: buildFakeWs(true) as unknown as KeepaliveTickContext['ws'],
      idempotency: cache, now: () => 1_000,
    })).rejects.toThrow('database unavailable');
  });
});

describe('D-148 P3 — installKeepaliveAlarm registers + tick fires', () => {
  it('handles a failed maintenance tick and runs the next alarm', async () => {
    const listeners: Array<(alarm: { name: string }) => void> = [];
    const tick = vi.fn<() => Promise<{ ws_connected: boolean; reconnected: boolean; expired_swept: number }>>()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue({ ws_connected: true, reconnected: false, expired_swept: 0 });
    installKeepaliveAlarm({ create() {}, clear() {},
      onAlarm: { addListener: listener => { listeners.push(listener); }, removeListener() {} },
    }, { async getPlatformInfo() {} }, tick);
    listeners[0]!({ name: KEEPALIVE_ALARM_NAME });
    await new Promise(resolve => setTimeout(resolve, 0));
    listeners[0]!({ name: KEEPALIVE_ALARM_NAME });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('installs alarm with correct period + responds to fire', async () => {
    const created: Array<{ name: string; period: number }> = [];
    const listener_slot: { current: ((alarm: { name: string }) => void) | null } = { current: null };
    const platform_calls: number[] = [];
    let tick_fires = 0;
    const alarms = {
      create: (name: string, opts: { periodInMinutes: number }) => {
        created.push({ name, period: opts.periodInMinutes });
      },
      clear: () => {},
      onAlarm: {
        addListener: (h: (alarm: { name: string }) => void) => {
          listener_slot.current = h;
        },
        removeListener() {},
      },
    };
    const runtime = {
      async getPlatformInfo() {
        platform_calls.push(Date.now());
      },
    };
    installKeepaliveAlarm(
      alarms,
      runtime,
      async () => {
        tick_fires++;
        return { ws_connected: true, reconnected: false, expired_swept: 0 };
      },
    );
    expect(created).toEqual([{ name: KEEPALIVE_ALARM_NAME, period: KEEPALIVE_PERIOD_MINUTES }]);
    listener_slot.current?.({ name: KEEPALIVE_ALARM_NAME });
    // Allow the void-promise tick to scheduler.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tick_fires).toBe(1);
    expect(platform_calls.length).toBe(1);
  });

  it('ignores alarms with other names', async () => {
    let tick_fires = 0;
    const listener_slot: { current: ((alarm: { name: string }) => void) | null } = { current: null };
    const alarms = {
      create: () => {},
      clear: () => {},
      onAlarm: {
        addListener: (h: (alarm: { name: string }) => void) => {
          listener_slot.current = h;
        },
        removeListener() {},
      },
    };
    installKeepaliveAlarm(
      alarms,
      { async getPlatformInfo() {} },
      async () => {
        tick_fires++;
        return { ws_connected: true, reconnected: false, expired_swept: 0 };
      },
    );
    listener_slot.current?.({ name: 'unrelated_alarm' });
    expect(tick_fires).toBe(0);
  });
});

describe('D-148 P3 — removeKeepaliveAlarm', () => {
  it('clears the named alarm', () => {
    const cleared: string[] = [];
    const alarms = {
      create: () => {},
      clear: (name: string) => cleared.push(name),
      onAlarm: { addListener: () => {}, removeListener() {} },
    };
    removeKeepaliveAlarm(alarms);
    expect(cleared).toEqual([KEEPALIVE_ALARM_NAME]);
  });
});


describe('Keepalive alarm ownership', () => {
  it('retires a replaced callback and old cleanup cannot clear the replacement alarm', () => {
    const { alarms, listeners, fire } = buildAlarms();
    const runtime = { getPlatformInfo: vi.fn(async () => undefined) };
    const report = { ws_connected: true, reconnected: false, expired_swept: 0 };
    const oldTick = vi.fn(async () => report);
    const newTick = vi.fn(async () => report);
    const stopOld = installKeepaliveAlarm(alarms, runtime, oldTick);
    const queuedOld = [...listeners][0]!;
    const stopNew = installKeepaliveAlarm(alarms, runtime, newTick);
    const queuedNew = [...listeners].at(-1)!;
    fire();
    expect(oldTick).not.toHaveBeenCalled();
    expect(newTick).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(1);

    stopOld();
    stopOld();
    queuedOld({ name: KEEPALIVE_ALARM_NAME });
    fire();
    expect(oldTick).not.toHaveBeenCalled();
    expect(newTick).toHaveBeenCalledTimes(2);

    stopNew();
    stopNew();
    queuedNew({ name: KEEPALIVE_ALARM_NAME });
    fire();
    expect(newTick).toHaveBeenCalledTimes(2);
    expect(runtime.getPlatformInfo).toHaveBeenCalledTimes(2);
    expect(listeners.size).toBe(0);
  });

  it('removeKeepaliveAlarm removes the listener and makes an already queued callback inert', () => {
    const { alarms, listeners, fire } = buildAlarms();
    const tick = vi.fn(async () => ({ ws_connected: true, reconnected: false, expired_swept: 0 }));
    const runtime = { getPlatformInfo: vi.fn(async () => undefined) };
    installKeepaliveAlarm(alarms, runtime, tick);
    const queued = [...listeners][0]!;
    removeKeepaliveAlarm(alarms);
    queued({ name: KEEPALIVE_ALARM_NAME });
    fire();
    expect(tick).not.toHaveBeenCalled();
    expect(runtime.getPlatformInfo).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });
});
