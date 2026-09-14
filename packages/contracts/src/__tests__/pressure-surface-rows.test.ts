/** The storage read-out's row model.
 *
 *  ⛔ WHY THIS EXISTS. `used_bytes` / `quota_bytes` / `pct` have been on
 *  `server.getStatus` AND the heartbeat envelope since Phase B, and NO client
 *  rendered them. The owner got a coloured dot — "pressure managed on one or
 *  more surfaces" — with no way to learn WHICH surface, how full, or by how
 *  much. Everything was already on the wire; only a renderer was missing.
 *
 *  ⚠ The ordering is the load-bearing part, so it is tested first. The list
 *  answers "what is about to stop working"; sorted by name, that answer is
 *  buried under whichever surface starts with 'a'. */

import { describe, expect, it } from 'vitest';

import {
  formatPressureBytes,
  pressureSurfaceRows,
  type PressureDetails,
} from '../pressure.js';

const detail = (
  surface: string,
  used_bytes: number,
  quota_bytes: number,
  state: PressureDetails['per_surface'][number]['state'] = 'running',
): PressureDetails['per_surface'][number] => ({
  surface,
  state,
  used_bytes,
  quota_bytes,
  pct: quota_bytes === 0 ? 0 : Math.round((used_bytes / quota_bytes) * 1000) / 10,
});

const GB = 1024 ** 3;
const MB = 1024 ** 2;

describe('pressureSurfaceRows', () => {
  it('⛔ orders MOST CONSTRAINED first, not alphabetically', () => {
    const rows = pressureSurfaceRows({
      worst_state: 'running',
      per_surface: [
        detail('audit', 100 * MB, 5 * GB),      // ~2%
        detail('cache', 180 * MB, 200 * MB),    // ~90%
        detail('shared_store', 1 * GB, 5 * GB), // 20%
      ],
    });
    expect(rows.map((r) => r.surface)).toEqual(['cache', 'shared_store', 'audit']);
  });

  it('breaks ties on name so the order does not flicker between heartbeats', () => {
    // The popover re-renders on EVERY heartbeat. An unstable comparator would
    // make equal-percentage rows swap places a few times a second.
    const equal: PressureDetails = {
      worst_state: 'running',
      per_surface: [detail('zeta', 1, 10), detail('alpha', 1, 10), detail('mid', 1, 10)],
    };
    expect(pressureSurfaceRows(equal).map((r) => r.surface))
      .toEqual(['alpha', 'mid', 'zeta']);
    expect(pressureSurfaceRows(equal).map((r) => r.surface))
      .toEqual(pressureSurfaceRows(equal).map((r) => r.surface));
  });

  it('renders used / quota in units the owner reads, at server scale', () => {
    const [row] = pressureSurfaceRows({
      worst_state: 'running',
      per_surface: [detail('audit', 3.5 * GB, 5 * GB)],
    });
    expect(row.size).toBe('3.50 GB / 5.00 GB');
    expect(row.pctLabel).toBe('70%');
  });

  it('⛔ marks a non-running surface for attention', () => {
    const rows = pressureSurfaceRows({
      worst_state: 'writes_blocked',
      per_surface: [
        detail('cache', 199 * MB, 200 * MB, 'writes_blocked'),
        detail('audit', 1 * MB, 5 * GB, 'running'),
      ],
    });
    expect(rows[0]).toMatchObject({ surface: 'cache', attention: true });
    expect(rows[1]).toMatchObject({ surface: 'audit', attention: false });
  });

  it('⛔ CLAMPS THE BAR BUT NOT THE LABEL when a surface is over its ceiling', () => {
    // Over-quota is exactly what the owner needs to see, so the text must keep
    // saying 120%. Only the bar width is clamped, because a >100% width would
    // overflow its container and make the row unreadable.
    const [row] = pressureSurfaceRows({
      worst_state: 'writes_blocked',
      per_surface: [detail('cache', 240 * MB, 200 * MB, 'writes_blocked')],
    });
    expect(row.pct).toBe(100);
    expect(row.pctLabel).toBe('120%');
  });

  it('⛔ labels the state in HUMAN copy, never the enum', () => {
    // Found by looking at the rendered page: the table showed
    // `pressure_managed` / `running` — machine identifiers, next to a task
    // table that correctly said "Complete". No assertion could fail on it
    // because none existed.
    const rows = pressureSurfaceRows({
      worst_state: 'writes_blocked',
      per_surface: [
        detail('a', 1, 10, 'running'),
        detail('b', 9, 10, 'pressure_managed'),
        detail('c', 10, 10, 'writes_blocked'),
        detail('d', 10, 10, 'halted'),
      ],
    });
    const labels = Object.fromEntries(rows.map((r) => [r.surface, r.stateLabel]));
    expect(labels).toEqual({
      a: 'OK', b: 'Under pressure', c: 'Writes blocked', d: 'Halted',
    });
    for (const row of rows) expect(row.stateLabel).not.toContain('_');
  });

  it('⛔ carries the server-reported last_reclaim, not just a click receipt', () => {
    // The column header promised "Last reclaim" and rendered nothing until the
    // owner pressed the button — while `last_reclaim` had been on the wire the
    // whole time.
    const now = 10_000_000;
    const [withReclaim, without] = pressureSurfaceRows({
      worst_state: 'pressure_managed',
      per_surface: [
        { ...detail('cache', 9, 10, 'pressure_managed'),
          last_reclaim: { at: now - 45 * 60_000, bytes_freed: 12 * MB, success: false } },
        detail('audit', 1, 10),
      ],
    }, now);
    expect(withReclaim.lastReclaim).toBe('45m ago · freed 12.0 MB');
    expect(without.lastReclaim).toBe('');   // absence is empty, not "never"
  });

  it('an absent or empty pressure block yields no rows, never a fake one', () => {
    expect(pressureSurfaceRows(undefined)).toEqual([]);
    expect(pressureSurfaceRows({ worst_state: 'running', per_surface: [] })).toEqual([]);
  });

  it('formatPressureBytes covers the range without lying about zero', () => {
    expect(formatPressureBytes(0)).toBe('0 B');
    expect(formatPressureBytes(900)).toBe('900 B');
    expect(formatPressureBytes(40 * 1024)).toBe('40 KB');
    expect(formatPressureBytes(1.5 * MB)).toBe('1.5 MB');
    expect(formatPressureBytes(5 * GB)).toBe('5.00 GB');
    // The top tier is TB — a disk-backed surface over 1024 GB used to print
    // `3072.00 GB`. Pin BOTH sides of the boundary: the last GB value and the
    // first TB one, so a future tier edit cannot slide the cutover unseen.
    expect(formatPressureBytes(1023 * GB)).toBe('1023.00 GB');
    expect(formatPressureBytes(1024 * GB)).toBe('1.00 TB');
    expect(formatPressureBytes(3 * 1024 * GB)).toBe('3.00 TB');
    // A malformed number must not render as '0 B' — that reads as "empty".
    expect(formatPressureBytes(Number.NaN)).toBe('—');
    expect(formatPressureBytes(-1)).toBe('—');
  });
});
