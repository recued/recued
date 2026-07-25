/** D-145 PA11 — "LLM result cache" Settings card render tests.
 *
 *  Pure-render coverage for the card's six branches:
 *    - loading (first read in flight, no prior snapshot)
 *    - load-error before first successful read
 *    - empty cache (DD#5 — skip table + Clear button)
 *    - populated cache (rollup dl + per-topic table + Clear button)
 *    - clear-confirm strip (two-stage; mirror SI Slice 1.5 + packs)
 *    - clearing-in-flight (Confirm disabled, label swaps)
 *
 *  Plus the two small format helpers:
 *    - `formatCacheHitRate(entry, hit)` — derives the user-visible
 *      percent; the math is load-bearing for the per-topic table.
 *    - `formatCacheRelativeTime(ts, now)` — relative-time string for
 *      `last_gc_at`; the formatter mirrors task-status-table's helper. */

import { describe, expect, it } from 'vitest';
import {
  formatCacheHitRate,
  formatCacheRelativeTime,
  initialHousekeepingCacheCardState,
  renderHousekeepingLlmResultCacheCard,
  type HousekeepingCacheCardState,
} from '../server-settings/housekeeping/index.js';

const NOW = 1_700_000_000_000;

const baseCacheState = (
  overrides: Partial<HousekeepingCacheCardState> = {},
): HousekeepingCacheCardState => ({
  ...initialHousekeepingCacheCardState(),
  ...overrides,
});

const populatedStats = () => ({
  total_entries: 12,
  total_hits: 36,
  per_topic: [
    { topic: 'summary', entry_count: 8, hit_count: 24 },
    { topic: 'embedding', entry_count: 4, hit_count: 12 },
  ],
  last_gc_at: NOW - 3 * 60 * 60 * 1000,
});

// ────────────────────────────────────────────────────────────────
// formatCacheHitRate
// ────────────────────────────────────────────────────────────────

describe('D-145 PA11 — formatCacheHitRate', () => {
  it('returns "—" when both entry_count and hit_count are zero', () => {
    expect(formatCacheHitRate(0, 0)).toBe('—');
  });

  it('returns "0%" when there are entries but no hits', () => {
    expect(formatCacheHitRate(5, 0)).toBe('0%');
  });

  it('rounds the share of hits over (entries + hits)', () => {
    // 24 hits / (8 entries + 24 hits) = 0.75 → 75%
    expect(formatCacheHitRate(8, 24)).toBe('75%');
    // 1 / 11 = 9.09% → 9%
    expect(formatCacheHitRate(10, 1)).toBe('9%');
  });

  it('floors a non-zero ratio at 1% so a single hit stays visible', () => {
    // 1 / 1001 ≈ 0.0999% would round to 0% — clamp up so the user can
    // see the producer is doing something.
    expect(formatCacheHitRate(1000, 1)).toBe('1%');
  });
});

// ────────────────────────────────────────────────────────────────
// formatCacheRelativeTime
// ────────────────────────────────────────────────────────────────

describe('D-145 PA11 — formatCacheRelativeTime', () => {
  it('returns "—" when the timestamp is null', () => {
    expect(formatCacheRelativeTime(null, NOW)).toBe('—');
  });

  it('formats seconds / minutes / hours / days', () => {
    expect(formatCacheRelativeTime(NOW - 30_000, NOW)).toBe('30s ago');
    expect(formatCacheRelativeTime(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(formatCacheRelativeTime(NOW - 2 * 60 * 60_000, NOW)).toBe('2h ago');
    expect(formatCacheRelativeTime(NOW - 3 * 24 * 60 * 60_000, NOW)).toBe(
      '3d ago',
    );
  });

  it('clamps to "0s ago" when the timestamp is in the future', () => {
    // Defensive: clock skew could land event_at slightly past now.
    expect(formatCacheRelativeTime(NOW + 5_000, NOW)).toBe('0s ago');
  });
});

// ────────────────────────────────────────────────────────────────
// renderHousekeepingLlmResultCacheCard
// ────────────────────────────────────────────────────────────────

describe('D-145 PA11 — renderHousekeepingLlmResultCacheCard', () => {
  it('renders the loading placeholder when first read is in flight', () => {
    const html = renderHousekeepingLlmResultCacheCard({
      state: baseCacheState({ loading: true }),
      now: NOW,
    });
    expect(html).toContain('Loading cache stats…');
    expect(html).not.toContain('Clear cache');
  });

  it('renders the load error on first read failure', () => {
    const html = renderHousekeepingLlmResultCacheCard({
      state: baseCacheState({
        loading: false,
        loadError: 'cache unsupported on this server',
      }),
      now: NOW,
    });
    expect(html).toContain('cache unsupported on this server');
    expect(html).not.toContain('Clear cache');
  });

  it('renders the empty-cache short note (no table, no Clear button)', () => {
    const html = renderHousekeepingLlmResultCacheCard({
      state: baseCacheState({
        stats: {
          total_entries: 0,
          total_hits: 0,
          per_topic: [],
          last_gc_at: null,
        },
      }),
      now: NOW,
    });
    expect(html).toContain('Currently empty');
    expect(html).toContain('Last GC sweep: —');
    expect(html).not.toContain('Clear cache');
    expect(html).not.toContain('<table');
  });

  it('renders the rollup dl + per-topic table + Clear button when populated', () => {
    const html = renderHousekeepingLlmResultCacheCard({
      state: baseCacheState({ stats: populatedStats() }),
      now: NOW,
    });
    expect(html).toContain('LLM result cache');
    // Rollup numbers.
    expect(html).toContain('<dt>Entries</dt>');
    expect(html).toContain('<dd>12</dd>');
    expect(html).toContain('<dt>Total hits</dt>');
    expect(html).toContain('<dd>36</dd>');
    // Per-topic rows.
    expect(html).toContain('<code>summary</code>');
    expect(html).toContain('<code>embedding</code>');
    // Last GC formatted relative.
    expect(html).toContain('3h ago');
    // Clear button rendered + NOT in confirm strip yet.
    expect(html).toContain('Clear cache');
    expect(html).not.toContain('Confirm clear');
  });

  it('renders the two-stage confirm strip when confirmingClear is true', () => {
    const html = renderHousekeepingLlmResultCacheCard({
      state: baseCacheState({
        stats: populatedStats(),
        confirmingClear: true,
      }),
      now: NOW,
    });
    expect(html).toContain('Confirm clear');
    expect(html).toContain('Cancel');
    // The plain "Clear cache" button is gone while the strip is open
    // — verify by checking that the button-actioning attribute for the
    // initial Clear click is absent.
    expect(html).not.toContain('data-action="housekeeping-cache-clear"');
    expect(html).toContain('data-action="housekeeping-cache-clear-confirm"');
    expect(html).toContain('data-action="housekeeping-cache-clear-cancel"');
  });

  it('swaps Confirm label + disables both buttons while clearing in flight', () => {
    const html = renderHousekeepingLlmResultCacheCard({
      state: baseCacheState({
        stats: populatedStats(),
        confirmingClear: true,
        clearing: true,
      }),
      now: NOW,
    });
    expect(html).toContain('Clearing…');
    // Both confirm + cancel disabled — primitive emits `disabled`
    // attribute when the prop is true.
    expect(html.match(/disabled/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('surfaces the clearError inline alongside the populated card', () => {
    const html = renderHousekeepingLlmResultCacheCard({
      state: baseCacheState({
        stats: populatedStats(),
        clearError: 'permission denied — re-pair the device',
      }),
      now: NOW,
    });
    expect(html).toContain('permission denied — re-pair the device');
    // Clear button is still present (the user can retry).
    expect(html).toContain('Clear cache');
  });
});
