/** D-123 Phase 1 — `housekeeping_config` singleton store tests. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HOUSEKEEPING_CYCLE_BUDGET_MAX_MS,
  HOUSEKEEPING_CYCLE_BUDGET_MIN_MS,
  HOUSEKEEPING_DEFAULT_PRESET,
} from '@recued/contracts';

import { createHousekeepingConfigStore } from '../housekeeping/config-store.js';

const NOW = 1_700_000_000_000;

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-123-config-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('createHousekeepingConfigStore', () => {
  it('seeds the default preset on a fresh DB', () => {
    const store = createHousekeepingConfigStore(db);
    const config = store.read();
    expect(config.preset).toBe(HOUSEKEEPING_DEFAULT_PRESET);
    expect(config.cycle_budget_ms).toBe(60_000);
    expect(config.cycle_interval_minutes).toBe(15);
  });

  it('persists a write across re-reads', () => {
    const store = createHousekeepingConfigStore(db);
    store.write({ preset: 'light' }, NOW);
    const config = store.read();
    expect(config.preset).toBe('light');
    expect(config.cycle_budget_ms).toBe(30_000);
    expect(config.cycle_interval_minutes).toBe(60);
    expect(config.updated_at).toBe(NOW);
  });

  it('overwrites preset on subsequent writes', () => {
    const store = createHousekeepingConfigStore(db);
    store.write({ preset: 'light' }, NOW);
    store.write({ preset: 'aggressive' }, NOW + 1_000);
    const config = store.read();
    expect(config.preset).toBe('aggressive');
    expect(config.cycle_budget_ms).toBe(120_000);
    expect(config.updated_at).toBe(NOW + 1_000);
  });

  it("ignores caller-supplied budget for non-'custom' presets", () => {
    const store = createHousekeepingConfigStore(db);
    store.write({ preset: 'balanced', cycle_budget_ms: 999 }, NOW);
    const config = store.read();
    expect(config.cycle_budget_ms).toBe(60_000);
  });

  it("'off' preset writes zeroed budget + interval", () => {
    const store = createHousekeepingConfigStore(db);
    store.write({ preset: 'off' }, NOW);
    const config = store.read();
    expect(config.preset).toBe('off');
    expect(config.cycle_budget_ms).toBe(0);
    expect(config.cycle_interval_minutes).toBe(0);
  });

  it('rejects unknown preset', () => {
    const store = createHousekeepingConfigStore(db);
    expect(() => store.write({ preset: 'turbo' as never }, NOW)).toThrow(
      /unknown preset/i,
    );
  });

  describe("'custom' preset validation", () => {
    it('requires cycle_budget_ms', () => {
      const store = createHousekeepingConfigStore(db);
      expect(() =>
        store.write(
          {
            preset: 'custom',
            cycle_interval_minutes: 30,
            custom_window_start_hour: 2,
            custom_window_end_hour: 5,
          },
          NOW,
        ),
      ).toThrow(/cycle_budget_ms/);
    });

    it('rejects budget below min', () => {
      const store = createHousekeepingConfigStore(db);
      expect(() =>
        store.write(
          {
            preset: 'custom',
            cycle_budget_ms: HOUSEKEEPING_CYCLE_BUDGET_MIN_MS - 1,
            cycle_interval_minutes: 30,
            custom_window_start_hour: 2,
            custom_window_end_hour: 5,
          },
          NOW,
        ),
      ).toThrow(/out of range/);
    });

    it('rejects budget above max', () => {
      const store = createHousekeepingConfigStore(db);
      expect(() =>
        store.write(
          {
            preset: 'custom',
            cycle_budget_ms: HOUSEKEEPING_CYCLE_BUDGET_MAX_MS + 1,
            cycle_interval_minutes: 30,
            custom_window_start_hour: 2,
            custom_window_end_hour: 5,
          },
          NOW,
        ),
      ).toThrow(/out of range/);
    });

    it('rejects out-of-range hour values', () => {
      const store = createHousekeepingConfigStore(db);
      expect(() =>
        store.write(
          {
            preset: 'custom',
            cycle_budget_ms: 60_000,
            cycle_interval_minutes: 30,
            custom_window_start_hour: 24,
            custom_window_end_hour: 5,
          },
          NOW,
        ),
      ).toThrow(/start_hour/);
    });

    it('persists valid custom config', () => {
      const store = createHousekeepingConfigStore(db);
      store.write(
        {
          preset: 'custom',
          cycle_budget_ms: 90_000,
          cycle_interval_minutes: 5,
          custom_window_start_hour: 22,
          custom_window_end_hour: 5,
        },
        NOW,
      );
      const config = store.read();
      expect(config).toMatchObject({
        preset: 'custom',
        cycle_budget_ms: 90_000,
        cycle_interval_minutes: 5,
        custom_window_start_hour: 22,
        custom_window_end_hour: 5,
        updated_at: NOW,
      });
    });
  });
});
