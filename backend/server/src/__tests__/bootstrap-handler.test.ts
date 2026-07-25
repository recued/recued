import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createStorageGate } from '@recued/storage-gate';
import type { BootstrapConfig } from '@recued/config';
import { createServerStateStore } from '../server-state.js';
import {
  handleGetBootstrap,
  handleStageBootstrap,
  handleRequestRestart,
  handleGetStatus,
  handleSetPaused,
  handleGetPauseState,
  type BootstrapHandlerDeps,
} from '../bootstrap-handler.js';

const baseBootstrap: BootstrapConfig = {
  data_path: '/var/lib/recued',
  bind_host: '127.0.0.1',
  bind_port: 3001,
  mcp_port: 0,
  webhook_port: 0,
  log_path: '/var/log/recued',
};

const mkDeps = (overrides: Partial<BootstrapHandlerDeps> = {}): BootstrapHandlerDeps => {
  const db = new Database(':memory:');
  const state = overrides.state ?? createServerStateStore(db);
  return {
    bootstrap: { ...baseBootstrap },
    state,
    gates: [],
    version: '0.0.0-test',
    ...overrides,
  };
};

describe('handleGetBootstrap', () => {
  it('returns the loaded config with pending_restart=false when nothing staged', () => {
    const deps = mkDeps();
    expect(handleGetBootstrap(deps).config).toEqual({
      ...baseBootstrap,
      pending_restart: false,
    });
  });

  it('merges staged fields and flags pending_restart', () => {
    const deps = mkDeps();
    deps.state.setStagedBootstrap({ bind_port: 9000, log_path: '/tmp/alt' });
    const view = handleGetBootstrap(deps).config;
    expect(view.bind_port).toBe(9000);
    expect(view.log_path).toBe('/tmp/alt');
    expect(view.pending_restart).toBe(true);
  });
});

describe('handleStageBootstrap', () => {
  let deps: BootstrapHandlerDeps;
  beforeEach(() => { deps = mkDeps(); });

  it('accepts a whitelisted numeric field and stages it', () => {
    const res = handleStageBootstrap(deps, { patch: { bind_port: 9090 } });
    expect(res).toEqual({ valid: true, restart_required: true });
    expect(deps.state.getStagedBootstrap()).toEqual({ bind_port: 9090 });
  });

  it('rejects fields outside the stageable whitelist', () => {
    const res = handleStageBootstrap(deps, { patch: { data_path: '/elsewhere' } });
    expect(res.valid).toBe(false);
    expect(res.errors?.data_path).toMatch(/not stageable/);
    expect(deps.state.getStagedBootstrap()).toBeNull();
  });

  it('rejects prototype-sensitive patch fields without clearing staged state', () => {
    deps.state.setStagedBootstrap({ bind_port: 9090 });
    const res = handleStageBootstrap(deps, {
      patch: JSON.parse('{"__proto__":true}') as Record<string, unknown>,
    });
    expect(res.valid).toBe(false);
    expect(res.errors?.['__proto__']).toMatch(/not stageable/);
    expect(deps.state.getStagedBootstrap()).toEqual({ bind_port: 9090 });
  });

  it('rejects out-of-range ports', () => {
    const res = handleStageBootstrap(deps, { patch: { bind_port: 99999 } });
    expect(res.valid).toBe(false);
    expect(res.errors?.bind_port).toMatch(/\[0, 65535\]/);
  });

  it('rejects empty strings on host/log_path', () => {
    const res = handleStageBootstrap(deps, { patch: { bind_host: '' } });
    expect(res.valid).toBe(false);
    expect(res.errors?.bind_host).toMatch(/non-empty/);
  });

  it('rejects non-object patches', () => {
    const res = handleStageBootstrap(deps, { patch: 'nope' as unknown });
    expect(res.valid).toBe(false);
    expect(res.errors?.['<root>']).toMatch(/JSON object/);
  });

  it('no-op patch clears staged state', () => {
    deps.state.setStagedBootstrap({ bind_port: 9090 });
    const res = handleStageBootstrap(deps, { patch: {} });
    expect(res).toEqual({ valid: true, restart_required: false });
    expect(deps.state.getStagedBootstrap()).toBeNull();
  });

  it('staging the current value does not require a restart', () => {
    const res = handleStageBootstrap(deps, { patch: { bind_port: baseBootstrap.bind_port } });
    expect(res.valid).toBe(true);
    expect(res.restart_required).toBe(false);
  });
});

describe('handleRequestRestart', () => {
  it('returns accepted and invokes the optional hook', () => {
    const hook = vi.fn();
    const deps = mkDeps({ onRestartRequested: hook });
    expect(handleRequestRestart(deps, { reason: 'bind_port change' })).toEqual({ accepted: true });
    expect(hook).toHaveBeenCalledWith('bind_port change');
  });

  it('accepts even when no hook is wired', () => {
    const deps = mkDeps();
    expect(handleRequestRestart(deps, { reason: 'ops' }).accepted).toBe(true);
  });
});

// The `server.setCrashHalt` / `getCrashHalt` rpcs were removed (no
// UI/MCP caller). The kill switch is engaged directly by the crash-loop
// detector, which now halts the gates via the lifecycle's
// `onCrashHaltChange` seam — covered in `lifecycle-index.test.ts`.
// `handleGetStatus` still surfaces the flag (see the getStatus tests below).

describe('handleSetPaused / handleGetPauseState (D-188)', () => {
  it('round-trips active + since', async () => {
    const deps = mkDeps();
    const set = await handleSetPaused(deps, { active: true });
    expect(set.ok).toBe(true);
    expect(typeof set.active_since).toBe('number');
    const read = handleGetPauseState(deps);
    expect(read.active).toBe(true);
    expect(typeof read.since).toBe('number');
  });

  it('omits `since` when not paused', () => {
    const deps = mkDeps();
    expect(handleGetPauseState(deps)).toEqual({ active: false });
  });

  it('fires onPauseChanged + audits ONLY on a real transition (idempotent re-assert is silent)', async () => {
    const onPauseChanged = vi.fn().mockResolvedValue(undefined);
    const logActivity = vi.fn().mockResolvedValue(undefined);
    const deps = mkDeps({
      onPauseChanged,
      auditLog: { logActivity } as unknown as NonNullable<BootstrapHandlerDeps['auditLog']>,
    });
    await handleSetPaused(deps, { active: true });
    expect(onPauseChanged).toHaveBeenCalledWith(true);
    expect(logActivity).toHaveBeenCalledTimes(1);
    expect(logActivity.mock.calls[0][0]).toMatchObject({
      action: 'server_pause_toggle',
      detail: 'paused',
    });
    // Re-assert true — no transition, so no side-effect + no audit.
    await handleSetPaused(deps, { active: true });
    expect(onPauseChanged).toHaveBeenCalledTimes(1);
    expect(logActivity).toHaveBeenCalledTimes(1);
    // Resume — a transition, so the seam fires false + audits 'resumed'.
    await handleSetPaused(deps, { active: false });
    expect(onPauseChanged).toHaveBeenLastCalledWith(false);
    expect(logActivity).toHaveBeenCalledTimes(2);
    expect(logActivity.mock.calls[1][0]).toMatchObject({
      action: 'server_pause_toggle',
      detail: 'resumed',
    });
  });

  it('a side-effect failure does NOT fail the flag flip (the flag is the source of truth)', async () => {
    const onPauseChanged = vi.fn().mockRejectedValue(new Error('scheduler boom'));
    const deps = mkDeps({ onPauseChanged });
    const res = await handleSetPaused(deps, { active: true });
    expect(res.ok).toBe(true);
    expect(deps.state.isPaused()).toBe(true);
  });
});

describe('handleGetStatus', () => {
  it('reports running when no gates + no kill switch', () => {
    const deps = mkDeps();
    const status = handleGetStatus(deps);
    expect(status).toEqual({
      version: '0.0.0-test',
      storage_state: 'running',
      crash_halt_active: false,
      paused: false,
      pressure_details: {
        worst_state: 'running',
        per_surface: [],
      },
    });
  });

  it('picks the worst gate state across registered gates', () => {
    const warm = createStorageGate({
      quota: 100 * 1024 * 1024,
      reservePct: 5,
      surface: 'cache',
    });
    // Push into pressure_managed.
    const info = warm.info();
    warm.setUsed(Math.max(info.pressureAt + 1, info.pressureAt));

    const deps = mkDeps({ gates: [warm] });
    const status = handleGetStatus(deps);
    expect(status.storage_state).toBe('pressure_managed');
    expect(status.pressure_details.worst_state).toBe('pressure_managed');
    expect(status.pressure_details.per_surface).toHaveLength(1);
    expect(status.pressure_details.per_surface[0]).toMatchObject({
      surface: 'cache',
      state: 'pressure_managed',
    });
    // Phase B: richer per-surface shape.
    expect(status.pressure_details.per_surface[0].used_bytes).toBeGreaterThan(0);
    expect(status.pressure_details.per_surface[0].quota_bytes).toBe(100 * 1024 * 1024);
    expect(status.pressure_details.per_surface[0].pct).toBeGreaterThan(0);
  });

  it('sorts per_surface by surface name', () => {
    const cache = createStorageGate({ quota: 100 * 1024 * 1024, reservePct: 5, surface: 'cache' });
    const vault = createStorageGate({ quota: 50 * 1024 * 1024, reservePct: 5, surface: 'vault' });
    const audit = createStorageGate({ quota: 50 * 1024 * 1024, reservePct: 5, surface: 'audit' });
    const deps = mkDeps({ gates: [cache, vault, audit] });
    const status = handleGetStatus(deps);
    const names = status.pressure_details.per_surface.map((d) => d.surface);
    expect(names).toEqual(['audit', 'cache', 'vault']);
  });

  it('kill switch short-circuits to halted regardless of gate state', () => {
    const gate = createStorageGate({
      quota: 100 * 1024 * 1024,
      reservePct: 5,
      surface: 'vault',
    });
    const deps = mkDeps({ gates: [gate] });
    // getStatus short-circuits to 'halted' on the flag alone (crash-loop
    // engages it directly); the flag setter stands in for the removed rpc.
    deps.state.setCrashHalt(true);
    const status = handleGetStatus(deps);
    expect(status.storage_state).toBe('halted');
    expect(status.pressure_details.worst_state).toBe('halted');
    expect(status.crash_halt_active).toBe(true);
  });

  it('Phase B: enriches per_surface with entered_at + last_reclaim from PressureStateStore', async () => {
    const { createPressureStateStore } = await import('../pressure-state.js');
    const db = new Database(':memory:');
    const state = createServerStateStore(db);
    const pressureState = createPressureStateStore(db);
    pressureState.setEnteredAt('cache', 1_700_000_000_000);
    pressureState.setLastReclaim('cache', {
      at: 1_700_000_100_000,
      bytes_freed: 2_500_000,
      success: true,
      steps: ['cache_lru'],
    });

    const gate = createStorageGate({ quota: 100 * 1024 * 1024, reservePct: 5, surface: 'cache' });
    gate.setUsed(gate.info().pressureAt + 1);

    const deps = mkDeps({ state, gates: [gate], pressureState });
    const status = handleGetStatus(deps);
    const cacheSurface = status.pressure_details.per_surface[0];
    expect(cacheSurface.entered_at).toBe(1_700_000_000_000);
    expect(cacheSurface.last_reclaim).toEqual({
      at: 1_700_000_100_000,
      bytes_freed: 2_500_000,
      success: true,
    });
  });

  it('Phase B: pressureState absent → entered_at/last_reclaim omitted (Phase A behaviour)', () => {
    const gate = createStorageGate({ quota: 100 * 1024 * 1024, reservePct: 5, surface: 'cache' });
    const deps = mkDeps({ gates: [gate] });
    const status = handleGetStatus(deps);
    expect(status.pressure_details.per_surface[0].entered_at).toBeUndefined();
    expect(status.pressure_details.per_surface[0].last_reclaim).toBeUndefined();
  });

  it('pct is 0 when quota is 0 (defensive)', () => {
    // Avoid createStorageGate's quota > 0 assertion by stubbing the
    // gate shape directly — real gates never carry a 0 quota, but the
    // builder shouldn't divide-by-zero if the state ever arrives.
    const stub: import('@recued/storage-gate').StorageGate = {
      info: () => ({
        surface: 'stub',
        state: 'running',
        used: 0,
        quota: 0,
        reserve: 0,
        available: 0,
        pressureAt: 0,
        blockedAt: 0,
        haltReason: null,
      }),
      setUsed: () => {},
      addUsed: () => {},
      subUsed: () => {},
      canWrite: () => ({ ok: true, info: stub.info() }),
      reconfigure: () => {},
      halt: () => {},
      resume: () => {},
      onStateChange: () => () => {},
    };
    const deps = mkDeps({ gates: [stub] });
    const status = handleGetStatus(deps);
    expect(status.pressure_details.per_surface[0].pct).toBe(0);
  });
});
