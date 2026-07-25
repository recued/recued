/** D-123 Phase 1 — Contracts: cursor round-trip + preset defaults. */

import { describe, expect, it } from 'vitest';

import {
  HOUSEKEEPING_AGGRESSIVE_IDLE_THRESHOLD_MS,
  HOUSEKEEPING_DEFAULT_PRESET,
  HOUSEKEEPING_PRESET_DEFAULTS,
  type HousekeepingCursor,
} from '@recued/contracts';

describe('HousekeepingCursor JSON round-trip', () => {
  const roundTrip = (c: HousekeepingCursor): HousekeepingCursor =>
    JSON.parse(JSON.stringify(c)) as HousekeepingCursor;

  it('preserves the time variant', () => {
    const c: HousekeepingCursor = { kind: 'time', last_seen_at: 1_700_000_000_000 };
    expect(roundTrip(c)).toEqual(c);
  });

  it('preserves the index variant', () => {
    const c: HousekeepingCursor = { kind: 'index', collection: 'mail', offset: 4_200 };
    expect(roundTrip(c)).toEqual(c);
  });

  it('preserves the auto_id variant', () => {
    const c: HousekeepingCursor = {
      kind: 'auto_id',
      collection: 'data_memory',
      max_id_seen: 99,
    };
    expect(roundTrip(c)).toEqual(c);
  });

  it('preserves the topic variant with optional scope', () => {
    const c: HousekeepingCursor = {
      kind: 'topic',
      topic: 'thread_signals',
      scope: 'mail',
      max_target_id_seen: 'mail_42',
    };
    expect(roundTrip(c)).toEqual(c);
  });

  it('preserves the topic variant without scope', () => {
    const c: HousekeepingCursor = {
      kind: 'topic',
      topic: 'topic_cluster',
      max_target_id_seen: 'tc_zzz',
    };
    expect(roundTrip(c)).toEqual(c);
  });

  it('preserves the complete sentinel', () => {
    const c: HousekeepingCursor = { kind: 'complete' };
    expect(roundTrip(c)).toEqual(c);
  });
});

describe('HOUSEKEEPING_PRESET_DEFAULTS', () => {
  it('exposes light / balanced / aggressive entries', () => {
    expect(Object.keys(HOUSEKEEPING_PRESET_DEFAULTS).sort()).toEqual([
      'aggressive',
      'balanced',
      'light',
    ]);
  });

  it('balanced is the default and has 60s budget / 15min interval', () => {
    expect(HOUSEKEEPING_DEFAULT_PRESET).toBe('balanced');
    expect(HOUSEKEEPING_PRESET_DEFAULTS.balanced).toEqual({
      cycle_budget_ms: 60_000,
      cycle_interval_minutes: 15,
    });
  });

  it('aggressive interval is 0 — gates on idle threshold instead', () => {
    expect(HOUSEKEEPING_PRESET_DEFAULTS.aggressive.cycle_interval_minutes).toBe(0);
    expect(HOUSEKEEPING_AGGRESSIVE_IDLE_THRESHOLD_MS).toBe(5 * 60_000);
  });

  it('light has the longest interval', () => {
    expect(HOUSEKEEPING_PRESET_DEFAULTS.light.cycle_interval_minutes).toBeGreaterThan(
      HOUSEKEEPING_PRESET_DEFAULTS.balanced.cycle_interval_minutes,
    );
  });
});
