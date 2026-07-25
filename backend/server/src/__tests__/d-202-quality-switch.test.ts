/** D-202 Slice 0 — the Switch A/B quality kill-switch control plane: the
 *  persisted two-switch state (server-state.ts) + the owner-only rpc handlers
 *  (bootstrap-handler.ts). Exercised through the REAL SQLite-backed state store
 *  (only the DB is in-memory), including persistence across a simulated restart
 *  and the audit-only-on-transition behaviour (mirrors the D-188 master pause).
 *
 *  The switch is a GATE-OVERRIDE (§12.12): the persisted flag is the whole
 *  mechanism; it never touches learner state. The gate consumption of this flag
 *  is the deferred step (needs D-200 Slice 4). */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { BootstrapConfig } from '@recued/config';

import { createServerStateStore } from '../server-state.js';
import {
  handleGetQualitySwitches,
  handleSetQualitySwitch,
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

// ════════════════════════════════════════════════════════════════
// Persisted state store
// ════════════════════════════════════════════════════════════════

describe('D-202 server-state Switch A/B', () => {
  it('defaults both switches OFF, no since timestamps', () => {
    const state = createServerStateStore(new Database(':memory:'));
    expect(state.getQualityGateSwitches()).toEqual({
      all_paused: false,
      all_since: null,
      quality_paused: false,
      quality_since: null,
    });
  });

  it('toggles Switch A and Switch B independently', () => {
    const state = createServerStateStore(new Database(':memory:'));

    const afterB = state.setQualityGateSwitch('quality', true);
    expect(afterB.quality_paused).toBe(true);
    expect(typeof afterB.quality_since).toBe('number');
    expect(afterB.all_paused).toBe(false); // Switch B never touches Switch A.

    const afterA = state.setQualityGateSwitch('all', true);
    expect(afterA.all_paused).toBe(true);
    expect(afterA.quality_paused).toBe(true); // B still engaged.

    const releaseA = state.setQualityGateSwitch('all', false);
    expect(releaseA.all_paused).toBe(false);
    expect(releaseA.all_since).toBeNull();
    expect(releaseA.quality_paused).toBe(true); // releasing A leaves B alone.
  });

  it('preserves the rising-edge `since` on idempotent re-assert', () => {
    const state = createServerStateStore(new Database(':memory:'));
    const first = state.setQualityGateSwitch('all', true, 1_000);
    const second = state.setQualityGateSwitch('all', true, 5_000);
    expect(first.all_since).toBe(1_000);
    expect(second.all_since).toBe(1_000); // unchanged — the clock did not reset.
  });

  it('PERSISTS across a restart (a new store over the same db stays paused)', () => {
    const db = new Database(':memory:');
    createServerStateStore(db).setQualityGateSwitch('quality', true, 42);
    // Simulate a process restart: a fresh store over the same SQLite file.
    const rebooted = createServerStateStore(db);
    expect(rebooted.getQualityGateSwitches()).toMatchObject({
      quality_paused: true,
      quality_since: 42,
      all_paused: false,
    });
  });
});

// ════════════════════════════════════════════════════════════════
// RPC handlers
// ════════════════════════════════════════════════════════════════

describe('D-202 handleSetQualitySwitch / handleGetQualitySwitches', () => {
  it('reads and writes through the rpc surface', async () => {
    const deps = mkDeps();
    expect(handleGetQualitySwitches(deps).quality_paused).toBe(false);
    const set = await handleSetQualitySwitch(deps, { which: 'quality', active: true });
    expect(set.quality_paused).toBe(true);
    expect(handleGetQualitySwitches(deps).quality_paused).toBe(true);
  });

  it('audits ONLY on a real transition (idempotent re-assert is silent)', async () => {
    const logActivity = vi.fn().mockResolvedValue(undefined);
    const deps = mkDeps({
      auditLog: { logActivity } as unknown as NonNullable<BootstrapHandlerDeps['auditLog']>,
    });

    await handleSetQualitySwitch(deps, { which: 'all', active: true });
    expect(logActivity).toHaveBeenCalledTimes(1);
    expect(logActivity.mock.calls[0][0]).toMatchObject({
      action: 'quality_gate_switch_toggle',
      detail: 'all:paused',
    });

    // Re-assert — no transition, no audit.
    await handleSetQualitySwitch(deps, { which: 'all', active: true });
    expect(logActivity).toHaveBeenCalledTimes(1);

    // Release — a real transition, audited.
    await handleSetQualitySwitch(deps, { which: 'all', active: false });
    expect(logActivity).toHaveBeenCalledTimes(2);
    expect(logActivity.mock.calls[1][0]).toMatchObject({
      action: 'quality_gate_switch_toggle',
      detail: 'all:resumed',
    });
  });

  it('rejects an unknown `which` (no safe default for a kill-switch axis)', async () => {
    const deps = mkDeps();
    await expect(
      handleSetQualitySwitch(
        deps,
        { which: 'both', active: true } as unknown as { which: 'all' | 'quality'; active: boolean },
      ),
    ).rejects.toThrow(/which/);
    // ...and the state is untouched.
    expect(handleGetQualitySwitches(deps)).toMatchObject({
      all_paused: false,
      quality_paused: false,
    });
  });
});
