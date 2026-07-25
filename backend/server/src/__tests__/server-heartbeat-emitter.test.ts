/** Server heartbeat emitter (Tier 3) acceptance.
 *
 *  Drives `composeServerHeartbeatEmitter` over a capturing registry (so the
 *  registered tick can be fired by hand) and asserts the load-bearing rule:
 *  the tick emits a `server_heartbeat` ONLY while the lifecycle is ready
 *  (`running`) — a booting / draining / no-lifecycle server stays silent, so
 *  a client detects a half-open server purely by the absence of beats. */

import { describe, expect, it, vi } from 'vitest';

import {
  SERVER_HEARTBEAT_INTERVAL_MS,
  type LifecycleState,
  type LifecycleStatus,
  type PressureDetails,
  type ServerHeartbeatSnapshot,
} from '@recued/contracts';
import type {
  BackgroundServiceRegistry,
  IntervalServiceSpec,
} from '../composition/bin/wire-background-services.js';
import {
  composeServerHeartbeatEmitter,
  type ServerHealthSnapshot,
} from '../composition/bin/wire-server-heartbeat-emitter.js';

const pressureDetails = (
  worst_state: PressureDetails['worst_state'] = 'running',
): PressureDetails => ({ worst_state, per_surface: [] });

const lifecycleStatus = (
  state: LifecycleState,
  over: Partial<LifecycleStatus> = {},
): LifecycleStatus => ({
  state,
  boot_at: 1_000,
  uptime_s: 42,
  restart_count: 1,
  restart_pending: false,
  supervisor_mode: 'native',
  ...over,
});

const createCapturingRegistry = (): {
  registry: BackgroundServiceRegistry;
  interval: () => IntervalServiceSpec;
} => {
  let captured: IntervalServiceSpec | null = null;
  const registry: BackgroundServiceRegistry = {
    register: vi.fn(),
    registerInterval: vi.fn((spec: IntervalServiceSpec) => {
      captured = spec;
      return vi.fn();
    }),
    stopAll: vi.fn(async () => {}),
    list: vi.fn(() => (captured ? [captured.name] : [])),
  };
  return {
    registry,
    interval: () => {
      if (!captured) throw new Error('interval was not registered');
      return captured;
    },
  };
};

const harness = (opts: {
  snapshot?: LifecycleStatus | undefined;
  getLifecycleSnapshot?: () => LifecycleStatus | undefined;
  serverId?: string | null;
  serverHealth?: () => ServerHealthSnapshot | undefined;
  broadcast?: (p: ServerHeartbeatSnapshot) => void;
  now?: () => number;
  intervalMs?: number;
}) => {
  const capture = createCapturingRegistry();
  const broadcast =
    opts.broadcast ?? vi.fn<(p: ServerHeartbeatSnapshot) => void>();
  composeServerHeartbeatEmitter({
    registry: capture.registry,
    broadcast,
    getLifecycleSnapshot:
      opts.getLifecycleSnapshot ?? (() => opts.snapshot),
    getServerId: () => opts.serverId ?? null,
    ...(opts.serverHealth !== undefined
      ? { getServerHealth: opts.serverHealth }
      : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.intervalMs !== undefined ? { intervalMs: opts.intervalMs } : {}),
  });
  return { ...capture, broadcast };
};

describe('composeServerHeartbeatEmitter', () => {
  it('registers a server-heartbeat-emitter timer at the default cadence, fireImmediate off', () => {
    const h = harness({ snapshot: lifecycleStatus('running') });
    const spec = h.interval();
    expect(spec.name).toBe('server-heartbeat-emitter');
    expect(spec.intervalMs).toBe(SERVER_HEARTBEAT_INTERVAL_MS);
    // fireImmediate would run a tick before markBooted (a no-op via the ready
    // gate), so it stays off — the first beat lands on the first interval.
    expect(spec.fireImmediate).toBe(false);
  });

  it('emits a well-formed snapshot while running (no health source → no health fields)', () => {
    const broadcast = vi.fn<(p: ServerHeartbeatSnapshot) => void>();
    const h = harness({
      snapshot: lifecycleStatus('running', { uptime_s: 99, restart_count: 2 }),
      serverId: 'sha256:abc',
      broadcast,
      now: () => 5_000,
    });
    h.interval().tick();
    expect(broadcast).toHaveBeenCalledTimes(1);
    // supervisor_mode rides the lifecycle snapshot; with no `getServerHealth`
    // wired, the kill-switch / pressure fields are absent (pill stays green).
    expect(broadcast.mock.calls[0]![0]).toEqual({
      server_id: 'sha256:abc',
      last_seen_at: 5_000,
      lifecycle_state: 'running',
      uptime_s: 99,
      restart_count: 2,
      supervisor_mode: 'native',
    });
  });

  it('A2 — merges kill-switch + pressure from getServerHealth (the pill paused/attention source)', () => {
    const broadcast = vi.fn<(p: ServerHeartbeatSnapshot) => void>();
    const health: ServerHealthSnapshot = {
      crash_halt_active: true,
      pressure_details: pressureDetails('writes_blocked'),
    };
    harness({
      snapshot: lifecycleStatus('running'),
      serverId: 'sha256:abc',
      serverHealth: () => health,
      broadcast,
      now: () => 5_000,
    }).interval().tick();
    const payload = broadcast.mock.calls[0]![0]!;
    expect(payload.crash_halt_active).toBe(true);
    expect(payload.pressure_details).toEqual(pressureDetails('writes_blocked'));
  });

  it('A2 — includes crash_halt_active even when false (NOT killed is meaningful)', () => {
    const broadcast = vi.fn<(p: ServerHeartbeatSnapshot) => void>();
    harness({
      snapshot: lifecycleStatus('running'),
      serverHealth: () => ({
        crash_halt_active: false,
        pressure_details: pressureDetails('running'),
      }),
      broadcast,
    }).interval().tick();
    const payload = broadcast.mock.calls[0]![0]!;
    expect(payload.crash_halt_active).toBe(false); // present, not omitted
    expect(payload).toHaveProperty('pressure_details');
  });

  it('A2 — a THROWING getServerHealth still emits the base liveness beat (best-effort)', () => {
    // The health read must never suppress the Tier 3 beat — else a non-critical
    // status-read hiccup would falsely stall a healthy server.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broadcast = vi.fn<(p: ServerHeartbeatSnapshot) => void>();
    harness({
      snapshot: lifecycleStatus('running', { uptime_s: 50 }),
      serverId: 'sha256:abc',
      serverHealth: () => {
        throw new Error('gate read exploded');
      },
      broadcast,
      now: () => 5_000,
    }).interval().tick();
    expect(broadcast).toHaveBeenCalledTimes(1); // base beat still sent
    const payload = broadcast.mock.calls[0]![0]!;
    expect(payload.uptime_s).toBe(50);
    expect(payload).not.toHaveProperty('crash_halt_active');
    expect(payload).not.toHaveProperty('pressure_details');
    warn.mockRestore();
  });

  it('A2 — omits health fields when getServerHealth resolves undefined', () => {
    const broadcast = vi.fn<(p: ServerHeartbeatSnapshot) => void>();
    harness({
      snapshot: lifecycleStatus('running'),
      serverHealth: () => undefined,
      broadcast,
    }).interval().tick();
    const payload = broadcast.mock.calls[0]![0]!;
    expect(payload).not.toHaveProperty('crash_halt_active');
    expect(payload).not.toHaveProperty('pressure_details');
  });

  it('READY gate: does NOT emit while booting', () => {
    const h = harness({ snapshot: lifecycleStatus('booting') });
    h.interval().tick();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it('READY gate: does NOT emit while draining / restarting / shutting_down / crashed', () => {
    for (const state of [
      'draining',
      'restarting',
      'shutting_down',
      'crashed',
    ] as const) {
      const h = harness({ snapshot: lifecycleStatus(state) });
      h.interval().tick();
      expect(h.broadcast, `state=${state}`).not.toHaveBeenCalled();
    }
  });

  it('does NOT emit when the lifecycle snapshot is undefined (no-lifecycle boot)', () => {
    const h = harness({ snapshot: undefined });
    h.interval().tick();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it('tolerates a null server_id (the webclient ignores it; the pill hides)', () => {
    const broadcast = vi.fn<(p: ServerHeartbeatSnapshot) => void>();
    harness({
      snapshot: lifecycleStatus('running'),
      serverId: null,
      broadcast,
    }).interval().tick();
    expect(broadcast.mock.calls[0]![0]!.server_id).toBeNull();
  });

  it('swallows a throwing broadcast — a tick never bubbles to setInterval', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness({
      snapshot: lifecycleStatus('running'),
      broadcast: () => {
        throw new Error('socket exploded');
      },
    });
    expect(() => h.interval().tick()).not.toThrow();
    warn.mockRestore();
  });

  it('honours a custom intervalMs override', () => {
    const h = harness({ snapshot: lifecycleStatus('running'), intervalMs: 250 });
    expect(h.interval().intervalMs).toBe(250);
  });
});
