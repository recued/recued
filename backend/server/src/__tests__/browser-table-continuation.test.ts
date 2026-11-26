import { expect, it, vi } from 'vitest';
import type { BrowserActStep } from '@recued/contracts';
import { collectTableWindows, tableReadAfterScroll, withBrowserTableGoal,
  type WindowedTable } from '../bridges/browser-table-continuation.js';

const view = (first: number, rows: string[], position: number, scrollId = 7, limit = 400): WindowedTable => ({
  page: 'bridge:tab:doc', url: 'https://example.org/stock', columns: ['Bin'],
  rows: rows.map(row => [row]), table_window: { table_id: 3, scroll_id: scrollId, first, total: 5, position, limit },
});

it('pairs a forward scroll with a table only for a whole-collection request in the same tab', () => {
  const steps = [{ do: 'scroll', to: 'bottom' }, { do: 'wait', seconds: 2 }, { do: 'table', selector: 'table' }] as const;
  const pick = (plan: readonly BrowserActStep[] = steps) => tableReadAfterScroll(plan, 0, 'current');
  expect(withBrowserTableGoal('Read the full stock ledger.', pick)).toEqual({ index: 2, scope: { selector: 'table' } });
  expect(withBrowserTableGoal('Go to the bottom and read the last window.', pick)).toBeUndefined();
  expect(withBrowserTableGoal('Read the full table.', () => pick([
    steps[0], { do: 'wait', selector: '.ready' }, steps[2],
  ]))).toBeUndefined();
  expect(withBrowserTableGoal('Read the full table.', () => pick([
    steps[0], { ...steps[2], page: 'different' },
  ]))).toBeUndefined();
  expect(withBrowserTableGoal('Read the full table.', () => pick([
    { do: 'scroll', to: 'right' }, steps[1], steps[2],
  ]))).toBeUndefined();
});

it('merges overlaps by position and preserves duplicate values at distinct positions', async () => {
  const advance = vi.fn().mockResolvedValue(view(3, ['B', 'C', 'D'], 300));
  const result = await collectTableWindows({ initial: view(1, ['A', 'A', 'B'], 0), advance });
  expect(result).toEqual({ rows: [['A'], ['A'], ['B'], ['C'], ['D']], complete: true, moves: 1, reason: 'all_rows' });
});

it('keeps the observed prefix when the table changes sort between scroll windows', async () => {
  const initial = { ...view(1, ['A', 'A', 'A'], 0), sort: { header: 'Bin', direction: 'ascending' as const } };
  const next = { ...view(3, ['A', 'C', 'D'], 300), sort: { header: 'Bin', direction: 'descending' as const } };
  expect(await collectTableWindows({ initial, advance: async () => next })).toEqual({
    rows: [['A'], ['A'], ['A']], complete: false, moves: 1, reason: 'window_unavailable',
  });
});

it('reports a gap or an inconsistent overlap with the proven prefix', async () => {
  const initial = view(1, ['A', 'B'], 0);
  for (const [next, reason] of [
    [view(4, ['D', 'E'], 200), 'row_gap'],
    [view(2, ['changed', 'C'], 200), 'row_overlap_changed'],
    [{ ...view(2, ['B', 'C'], 200), page: 'changed' }, 'window_unavailable'],
  ] as const) {
    expect(await collectTableWindows({ initial, advance: async () => next })).toEqual({
      rows: [['A'], ['B']], complete: false, moves: 1, reason,
    });
  }
});

it('tries an enclosing panel after exhausting incidental overflow when inference is permitted', async () => {
  const initial = view(1, ['A', 'B', 'C'], 0, 1, 5);
  const narrow = view(1, ['A', 'B', 'C'], 5, 1, 5);
  const panel = view(1, ['A', 'B', 'C'], 0, 2);
  const last = view(3, ['C', 'D', 'E'], 180, 2);
  const advance = vi.fn().mockResolvedValueOnce(narrow).mockResolvedValueOnce(last);
  const nextScroller = vi.fn().mockResolvedValue(panel);
  expect(await collectTableWindows({ initial, advance, nextScroller })).toMatchObject({ complete: true, moves: 2 });
  expect(nextScroller).toHaveBeenCalledExactlyOnceWith(1);
  expect(await collectTableWindows({ initial, advance: async () => narrow })).toMatchObject({
    complete: false, moves: 1, reason: 'scroll_end',
  });
});
