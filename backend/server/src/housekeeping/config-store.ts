/** D-123 Phase 1 — Housekeeping config singleton store.
 *
 *  Per-server preset choice + cycle budget + cycle interval +
 *  optional custom-window. One row, primary key
 *  `HOUSEKEEPING_CONFIG_PRIMARY_KEY = 'singleton'`. Reads return
 *  default values seeded from `HOUSEKEEPING_DEFAULT_PRESET` if no
 *  row has been written yet — `bin.ts` doesn't need to seed; first
 *  read does it implicitly.
 *
 *  Spec: `docs/d-123-spec.md` §1.2 + §1.4. */

import type Database from 'better-sqlite3';

import {
  HOUSEKEEPING_CONFIG_PRIMARY_KEY,
  HOUSEKEEPING_CYCLE_BUDGET_MAX_MS,
  HOUSEKEEPING_CYCLE_BUDGET_MIN_MS,
  HOUSEKEEPING_DEFAULT_PRESET,
  HOUSEKEEPING_PRESET_DEFAULTS,
  type HousekeepingConfigRow,
  type HousekeepingPreset,
} from '@recued/contracts';

import { ensureHousekeepingSchema } from './schema.js';

export interface HousekeepingConfigWriteInput {
  preset: HousekeepingPreset;
  cycle_budget_ms?: number;
  cycle_interval_minutes?: number;
  custom_window_start_hour?: number;
  custom_window_end_hour?: number;
  /** D-132 — toggles BYOK use for background producers. Optional —
   *  unspecified leaves the persisted value unchanged. */
  allow_byok_background?: boolean;
  /** D-132 — global pause-AI deadline (epoch ms). `null` clears the
   *  pause window. Optional — unspecified leaves the persisted value
   *  unchanged. */
  pause_background_ai_until?: number | null;
}

export interface HousekeepingConfigStore {
  read(): HousekeepingConfigRow;
  write(input: HousekeepingConfigWriteInput, now: number): HousekeepingConfigRow;
}

interface Row {
  id: string;
  preset: string;
  cycle_budget_ms: number;
  cycle_interval_minutes: number;
  custom_window_start_hour: number | null;
  custom_window_end_hour: number | null;
  allow_byok_background: number;
  pause_background_ai_until: number | null;
  updated_at: number;
}

const VALID_PRESETS: ReadonlySet<HousekeepingPreset> = new Set([
  'off',
  'light',
  'balanced',
  'aggressive',
  'custom',
]);

const isHourInRange = (h: number): boolean =>
  Number.isInteger(h) && h >= 0 && h <= 23;

/** Project a write input through the preset-defaults table to fill
 *  in the cycle budget + interval. `custom` requires explicit budget
 *  + interval + window-hours; non-`custom` ignores any user-supplied
 *  budget / interval / window (overwritten by preset defaults). The
 *  D-132 ai-control fields (`allow_byok_background` /
 *  `pause_background_ai_until`) are orthogonal to preset and pass
 *  through unchanged. */
const resolveWrite = (
  input: HousekeepingConfigWriteInput,
  prior: { allow_byok_background: boolean; pause_background_ai_until: number | null },
  now: number,
): HousekeepingConfigRow => {
  if (!VALID_PRESETS.has(input.preset)) {
    throw new Error(`unknown preset '${input.preset}'`);
  }

  // D-132 — caller-omitted fields preserve the prior value; explicit
  // null on `pause_background_ai_until` clears the window.
  const allowByok = input.allow_byok_background ?? prior.allow_byok_background;
  const pauseUntil = input.pause_background_ai_until !== undefined
    ? input.pause_background_ai_until
    : prior.pause_background_ai_until;

  if (input.preset === 'off') {
    return {
      preset: 'off',
      cycle_budget_ms: 0,
      cycle_interval_minutes: 0,
      allow_byok_background: allowByok,
      pause_background_ai_until: pauseUntil,
      updated_at: now,
    };
  }

  if (input.preset === 'custom') {
    const budget = input.cycle_budget_ms;
    const interval = input.cycle_interval_minutes;
    const startHour = input.custom_window_start_hour;
    const endHour = input.custom_window_end_hour;

    if (typeof budget !== 'number' || !Number.isFinite(budget)) {
      throw new Error("custom preset requires 'cycle_budget_ms'");
    }
    if (budget < HOUSEKEEPING_CYCLE_BUDGET_MIN_MS || budget > HOUSEKEEPING_CYCLE_BUDGET_MAX_MS) {
      throw new Error(
        `cycle_budget_ms ${budget} out of range [${HOUSEKEEPING_CYCLE_BUDGET_MIN_MS}, ${HOUSEKEEPING_CYCLE_BUDGET_MAX_MS}]`,
      );
    }
    if (typeof interval !== 'number' || !Number.isFinite(interval) || interval < 0) {
      throw new Error("custom preset requires non-negative 'cycle_interval_minutes'");
    }
    if (typeof startHour !== 'number' || !isHourInRange(startHour)) {
      throw new Error("custom preset requires 'custom_window_start_hour' in [0, 23]");
    }
    if (typeof endHour !== 'number' || !isHourInRange(endHour)) {
      throw new Error("custom preset requires 'custom_window_end_hour' in [0, 23]");
    }
    return {
      preset: 'custom',
      cycle_budget_ms: budget,
      cycle_interval_minutes: interval,
      custom_window_start_hour: startHour,
      custom_window_end_hour: endHour,
      allow_byok_background: allowByok,
      pause_background_ai_until: pauseUntil,
      updated_at: now,
    };
  }

  const defaults = HOUSEKEEPING_PRESET_DEFAULTS[input.preset];
  return {
    preset: input.preset,
    cycle_budget_ms: defaults.cycle_budget_ms,
    cycle_interval_minutes: defaults.cycle_interval_minutes,
    allow_byok_background: allowByok,
    pause_background_ai_until: pauseUntil,
    updated_at: now,
  };
};

const seedDefault = (now: number): HousekeepingConfigRow => {
  const defaults = HOUSEKEEPING_PRESET_DEFAULTS[
    HOUSEKEEPING_DEFAULT_PRESET as Exclude<HousekeepingPreset, 'off' | 'custom'>
  ];
  return {
    preset: HOUSEKEEPING_DEFAULT_PRESET,
    cycle_budget_ms: defaults.cycle_budget_ms,
    cycle_interval_minutes: defaults.cycle_interval_minutes,
    allow_byok_background: false,
    pause_background_ai_until: null,
    updated_at: now,
  };
};

const rowToConfig = (row: Row): HousekeepingConfigRow => ({
  preset: row.preset as HousekeepingPreset,
  cycle_budget_ms: row.cycle_budget_ms,
  cycle_interval_minutes: row.cycle_interval_minutes,
  ...(row.custom_window_start_hour != null
    ? { custom_window_start_hour: row.custom_window_start_hour }
    : {}),
  ...(row.custom_window_end_hour != null
    ? { custom_window_end_hour: row.custom_window_end_hour }
    : {}),
  allow_byok_background: row.allow_byok_background === 1,
  pause_background_ai_until: row.pause_background_ai_until,
  updated_at: row.updated_at,
});

export const createHousekeepingConfigStore = (db: Database.Database): HousekeepingConfigStore => {
  ensureHousekeepingSchema(db);

  const readStmt = db.prepare(
    `SELECT * FROM housekeeping_config WHERE id = ?`,
  );

  const writeStmt = db.prepare(`
    INSERT INTO housekeeping_config (
      id, preset, cycle_budget_ms, cycle_interval_minutes,
      custom_window_start_hour, custom_window_end_hour,
      allow_byok_background, pause_background_ai_until, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      preset = excluded.preset,
      cycle_budget_ms = excluded.cycle_budget_ms,
      cycle_interval_minutes = excluded.cycle_interval_minutes,
      custom_window_start_hour = excluded.custom_window_start_hour,
      custom_window_end_hour = excluded.custom_window_end_hour,
      allow_byok_background = excluded.allow_byok_background,
      pause_background_ai_until = excluded.pause_background_ai_until,
      updated_at = excluded.updated_at
  `);

  const readPriorAi = (): { allow_byok_background: boolean; pause_background_ai_until: number | null } => {
    const row = readStmt.get(HOUSEKEEPING_CONFIG_PRIMARY_KEY) as Row | undefined;
    if (!row) return { allow_byok_background: false, pause_background_ai_until: null };
    return {
      allow_byok_background: row.allow_byok_background === 1,
      pause_background_ai_until: row.pause_background_ai_until,
    };
  };

  return {
    read() {
      const row = readStmt.get(HOUSEKEEPING_CONFIG_PRIMARY_KEY) as Row | undefined;
      return row ? rowToConfig(row) : seedDefault(Date.now());
    },
    write(input, now) {
      const resolved = resolveWrite(input, readPriorAi(), now);
      writeStmt.run(
        HOUSEKEEPING_CONFIG_PRIMARY_KEY,
        resolved.preset,
        resolved.cycle_budget_ms,
        resolved.cycle_interval_minutes,
        resolved.custom_window_start_hour ?? null,
        resolved.custom_window_end_hour ?? null,
        resolved.allow_byok_background ? 1 : 0,
        resolved.pause_background_ai_until,
        resolved.updated_at,
      );
      return resolved;
    },
  };
};
