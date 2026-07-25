import { describe, it, expect } from 'vitest';
import {
  STORAGE_STATE_RANK,
  worstStorageState,
  type StorageState,
  type PressureDetails,
  type PressureSurfaceDetail,
  SERVER_RPC_METHODS,
  SERVER_RPC_METHOD_SET,
} from '../index.js';

describe('STORAGE_STATE_RANK', () => {
  it('ranks running < pressure_managed < writes_blocked < halted', () => {
    expect(STORAGE_STATE_RANK.running).toBe(0);
    expect(STORAGE_STATE_RANK.pressure_managed).toBe(1);
    expect(STORAGE_STATE_RANK.writes_blocked).toBe(2);
    expect(STORAGE_STATE_RANK.halted).toBe(3);
  });
});

describe('worstStorageState', () => {
  it('returns running for empty input', () => {
    expect(worstStorageState([])).toBe('running');
  });

  it('returns the most constrained state', () => {
    expect(worstStorageState(['running', 'pressure_managed', 'running'])).toBe('pressure_managed');
    expect(worstStorageState(['running', 'writes_blocked', 'pressure_managed'])).toBe('writes_blocked');
    expect(worstStorageState(['writes_blocked', 'halted', 'pressure_managed'])).toBe('halted');
  });

  it('ignores duplicates and order', () => {
    const inputs: StorageState[] = ['halted', 'running', 'halted'];
    expect(worstStorageState(inputs)).toBe('halted');
  });
});

describe('PressureDetails + PressureSurfaceDetail shape', () => {
  it('accepts the expected structure at the type level', () => {
    const detail: PressureSurfaceDetail = {
      surface: 'cache',
      state: 'pressure_managed',
      used_bytes: 50_000_000,
      quota_bytes: 100_000_000,
      pct: 50,
      entered_at: 1_700_000_000_000,
      last_reclaim: {
        at: 1_700_000_001_000,
        bytes_freed: 10_000_000,
        success: true,
      },
    };
    const details: PressureDetails = {
      worst_state: 'pressure_managed',
      per_surface: [detail],
    };
    expect(details.worst_state).toBe('pressure_managed');
    expect(details.per_surface[0].last_reclaim?.success).toBe(true);
  });

  it('optional fields can be omitted (entered_at, last_reclaim)', () => {
    const detail: PressureSurfaceDetail = {
      surface: 'vault',
      state: 'running',
      used_bytes: 0,
      quota_bytes: 50_000_000,
      pct: 0,
    };
    const details: PressureDetails = {
      worst_state: 'running',
      per_surface: [detail],
    };
    expect(details.per_surface[0].entered_at).toBeUndefined();
    expect(details.per_surface[0].last_reclaim).toBeUndefined();
  });
});

describe('Phase B rpc method registry', () => {
  it('registers server.runPressureReclaim + server.setPressureOverride', () => {
    expect(SERVER_RPC_METHOD_SET.has('server.runPressureReclaim')).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has('server.setPressureOverride')).toBe(true);
  });

  it('runtime method list matches the registry (no duplicates)', () => {
    expect(SERVER_RPC_METHODS.length).toBe(SERVER_RPC_METHOD_SET.size);
  });
});
