/** Phase G (D-109) — server status pill logic.
 *
 *  `computePillState` is a pure severity-ranking function consumed by
 *  the popup + sidebar renderers. The test grid covers every
 *  severity tier + tie-breaking so any future regression (e.g. a new
 *  lifecycle state added but missing from the pill table) surfaces
 *  here instead of in live UI. */

import { describe, expect, it } from 'vitest';
import {
  computePillState,
  formatPillUptime,
  HEARTBEAT_STALE_MS,
  type ServerHeartbeatSnapshot,
} from '../server-pill.js';

const baseSnapshot = (over: Partial<ServerHeartbeatSnapshot> = {}): ServerHeartbeatSnapshot => ({
  server_id: 'srv-1',
  server_name: 'Home',
  last_seen_at: 1_000_000,
  lifecycle_state: 'running',
  uptime_s: 7200, // 2h
  supervisor_mode: 'systemd',
  crash_halt_active: false,
  pressure_details: {
    worst_state: 'running',
    per_surface: [],
  },
  collections: [],
  ...over,
});

describe('computePillState', () => {
  const NOW = 1_000_000 + 1_000; // 1s after heartbeat

  it('green/running — steady state produces the normal pill', () => {
    const state = computePillState(baseSnapshot(), NOW);
    expect(state.dot).toBe('green');
    expect(state.label).toBe('running');
    expect(state.uptime_s).toBe(7200);
  });

  it('gray/offline — stale heartbeat wins over all other signals', () => {
    const state = computePillState(
      baseSnapshot({
        crash_halt_active: true, // would normally be red
        last_seen_at: NOW - HEARTBEAT_STALE_MS - 1,
      }),
      NOW,
    );
    expect(state.dot).toBe('gray');
    expect(state.label).toBe('offline');
  });

  it('gray/offline — `last_seen_at = 0` always offline', () => {
    const state = computePillState(baseSnapshot({ last_seen_at: 0 }), NOW);
    expect(state.dot).toBe('gray');
    expect(state.label).toBe('offline');
  });

  it('red/paused — kill switch active (user)', () => {
    const state = computePillState(
      baseSnapshot({ crash_halt_active: true, crash_halt_reason: 'user' }),
      NOW,
    );
    expect(state.dot).toBe('red');
    expect(state.label).toBe('paused');
    expect(state.aria).toContain('kill switch');
  });

  it('red/paused — kill switch active (crash_loop) gets dedicated copy', () => {
    const state = computePillState(
      baseSnapshot({ crash_halt_active: true, crash_halt_reason: 'crash_loop' }),
      NOW,
    );
    expect(state.dot).toBe('red');
    expect(state.aria).toContain('crash loop');
  });

  it('red/paused — lifecycle_state = crashed', () => {
    const state = computePillState(
      baseSnapshot({ lifecycle_state: 'crashed' }),
      NOW,
    );
    expect(state.dot).toBe('red');
    expect(state.label).toBe('paused');
  });

  it('red/attention — gate halted (non-kill-switch)', () => {
    const state = computePillState(
      baseSnapshot({
        pressure_details: {
          worst_state: 'halted',
          per_surface: [],
        },
      }),
      NOW,
    );
    expect(state.dot).toBe('red');
    expect(state.label).toBe('attention');
  });

  it('paused (D-188) — master pause renders a neutral glyph, NOT red', () => {
    const state = computePillState(baseSnapshot({ paused: true }), NOW);
    expect(state.label).toBe('paused');
    expect(state.glyph).toBe('pause');
    expect(state.dot).not.toBe('red'); // red is reserved for kill switch / crash / halt
    expect(state.aria).toContain('paused');
  });

  it('paused ranks BELOW the red failure tier — a crash while paused still shows red', () => {
    const state = computePillState(
      baseSnapshot({ paused: true, crash_halt_active: true }),
      NOW,
    );
    expect(state.dot).toBe('red');
    expect(state.glyph).toBeUndefined(); // the kill-switch (crash) red wins, no pause glyph
  });

  it('paused ranks ABOVE pressure attention — a paused server reads as paused first', () => {
    const state = computePillState(
      baseSnapshot({
        paused: true,
        pressure_details: { worst_state: 'pressure_managed', per_surface: [] },
      }),
      NOW,
    );
    expect(state.label).toBe('paused');
    expect(state.glyph).toBe('pause');
  });

  it('paused is hidden behind offline — a stale heartbeat still wins', () => {
    const state = computePillState(
      baseSnapshot({ paused: true, last_seen_at: NOW - HEARTBEAT_STALE_MS - 1 }),
      NOW,
    );
    expect(state.label).toBe('offline');
    expect(state.glyph).toBeUndefined();
  });

  it('orange/busy — lifecycle draining', () => {
    const state = computePillState(
      baseSnapshot({ lifecycle_state: 'draining' }),
      NOW,
    );
    expect(state.dot).toBe('orange');
    expect(state.label).toBe('busy');
  });

  it('orange/busy — lifecycle restarting', () => {
    const state = computePillState(
      baseSnapshot({ lifecycle_state: 'restarting' }),
      NOW,
    );
    expect(state.dot).toBe('orange');
    expect(state.label).toBe('busy');
  });

  it('orange/busy — lifecycle shutting_down', () => {
    const state = computePillState(
      baseSnapshot({ lifecycle_state: 'shutting_down' }),
      NOW,
    );
    expect(state.dot).toBe('orange');
    expect(state.label).toBe('busy');
  });

  it('orange/attention — writes_blocked without kill switch', () => {
    const state = computePillState(
      baseSnapshot({
        pressure_details: {
          worst_state: 'writes_blocked',
          per_surface: [],
        },
      }),
      NOW,
    );
    expect(state.dot).toBe('orange');
    expect(state.label).toBe('attention');
  });

  it('amber/attention — pressure_managed', () => {
    const state = computePillState(
      baseSnapshot({
        pressure_details: {
          worst_state: 'pressure_managed',
          per_surface: [],
        },
      }),
      NOW,
    );
    expect(state.dot).toBe('amber');
    expect(state.label).toBe('attention');
  });

  it('amber/attention — collection in error state', () => {
    const state = computePillState(
      baseSnapshot({
        collections: [
          {
            platform: 'mail',
            slug: 'work',
            last_indexed_at: NOW - 60_000,
            pending_queue_size: 0,
            error_count_24h: 4,
            state: 'error',
          },
        ],
      }),
      NOW,
    );
    expect(state.dot).toBe('amber');
    expect(state.label).toBe('attention');
  });

  it('kill switch beats lifecycle — both set, red wins over orange', () => {
    const state = computePillState(
      baseSnapshot({
        crash_halt_active: true,
        lifecycle_state: 'draining',
      }),
      NOW,
    );
    expect(state.dot).toBe('red');
    expect(state.label).toBe('paused');
  });

  it('lifecycle beats pressure — both orange, lifecycle copy wins', () => {
    const state = computePillState(
      baseSnapshot({
        lifecycle_state: 'draining',
        pressure_details: {
          worst_state: 'writes_blocked',
          per_surface: [],
        },
      }),
      NOW,
    );
    expect(state.label).toBe('busy');
  });

  it('pressure beats collection-error at the same tier', () => {
    const state = computePillState(
      baseSnapshot({
        pressure_details: {
          worst_state: 'pressure_managed',
          per_surface: [],
        },
        collections: [
          {
            platform: 'file',
            slug: 'docs',
            last_indexed_at: NOW - 60_000,
            pending_queue_size: 0,
            error_count_24h: 1,
            state: 'error',
          },
        ],
      }),
      NOW,
    );
    expect(state.dot).toBe('amber');
    expect(state.aria).toContain('pressure');
  });

  it('heartbeat exactly at stale boundary rounds to offline', () => {
    const state = computePillState(
      baseSnapshot({ last_seen_at: NOW - HEARTBEAT_STALE_MS }),
      NOW,
    );
    expect(state.dot).toBe('gray');
  });
});

describe('formatPillUptime', () => {
  it('seconds below 60', () => {
    expect(formatPillUptime(0)).toBe('0s');
    expect(formatPillUptime(45)).toBe('45s');
  });

  it('minutes between 60 and 3600', () => {
    expect(formatPillUptime(60)).toBe('1m');
    expect(formatPillUptime(600)).toBe('10m');
  });

  it('hours between 3600 and 86400', () => {
    expect(formatPillUptime(3600)).toBe('1h');
    expect(formatPillUptime(43_200)).toBe('12h');
  });

  it('days over 86400', () => {
    expect(formatPillUptime(86_400)).toBe('1d');
    expect(formatPillUptime(259_200)).toBe('3d');
  });

  it('negative uptime clamps to 0s', () => {
    expect(formatPillUptime(-1)).toBe('0s');
  });
});
