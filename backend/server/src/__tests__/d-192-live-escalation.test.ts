/** D-192 live escalation - generic stale/narrow miss replace-merge behavior. */

import { describe, expect, it, vi } from 'vitest';

import {
  applySourceLiveEscalation,
  type SourceLiveEscalationUnit,
} from '../source-mirror/live-escalation.js';

interface Candidate {
  id: string;
  source: string;
  label: string;
}

const candidate = (id: string, source: string, label = id): Candidate => ({
  id,
  source,
  label,
});

const unit = (
  key: string,
  overrides: Partial<SourceLiveEscalationUnit<Candidate>> = {},
): SourceLiveEscalationUnit<Candidate> => ({
  key,
  stale: false,
  presentInBase: true,
  owns: (c) => c.source === key,
  fetchLive: async () => [candidate(`${key}-live`, key)],
  ...overrides,
});

describe('applySourceLiveEscalation', () => {
  it('returns the base candidates unchanged and no escalated keys when there are no units', async () => {
    const base = [candidate('a', 'one'), candidate('b', 'two')];

    const out = await applySourceLiveEscalation(base, [], { narrowLookup: false });

    expect(out.candidates).toEqual(base);
    expect([...out.escalated]).toEqual([]);
  });

  it('does not fetch a fresh unit already present in the base result', async () => {
    const fetchLive = vi.fn(async () => [candidate('one-live', 'one')]);

    const out = await applySourceLiveEscalation(
      [candidate('one-old', 'one')],
      [unit('one', { stale: false, presentInBase: true, fetchLive })],
      { narrowLookup: false },
    );

    expect(fetchLive).not.toHaveBeenCalled();
    expect(out.candidates).toEqual([candidate('one-old', 'one')]);
    expect([...out.escalated]).toEqual([]);
  });

  it('fetches stale units and replaces only their owned mirror candidates', async () => {
    const base = [
      candidate('one-old-a', 'one'),
      candidate('two-old', 'two'),
      candidate('one-old-b', 'one'),
    ];

    const out = await applySourceLiveEscalation(
      base,
      [
        unit('one', {
          stale: true,
          fetchLive: async () => [candidate('one-live', 'one')],
        }),
      ],
      { narrowLookup: false },
    );

    expect(out.candidates).toEqual([
      candidate('two-old', 'two'),
      candidate('one-live', 'one'),
    ]);
    expect([...out.escalated]).toEqual(['one']);
  });

  it('fetches narrow misses but not narrow hits or fresh broad units', async () => {
    const fetchMiss = vi.fn(async () => [candidate('miss-live', 'miss')]);
    const fetchHit = vi.fn(async () => [candidate('hit-live', 'hit')]);
    const fetchBroad = vi.fn(async () => [candidate('broad-live', 'broad')]);

    const narrow = await applySourceLiveEscalation(
      [candidate('hit-old', 'hit')],
      [
        unit('miss', { stale: false, presentInBase: false, fetchLive: fetchMiss }),
        unit('hit', { stale: false, presentInBase: true, fetchLive: fetchHit }),
      ],
      { narrowLookup: true },
    );
    const broad = await applySourceLiveEscalation(
      [candidate('broad-old', 'broad')],
      [unit('broad', { stale: false, presentInBase: false, fetchLive: fetchBroad })],
      { narrowLookup: false },
    );

    expect(fetchMiss).toHaveBeenCalledTimes(1);
    expect(fetchHit).not.toHaveBeenCalled();
    expect(fetchBroad).not.toHaveBeenCalled();
    expect(narrow.candidates).toEqual([
      candidate('hit-old', 'hit'),
      candidate('miss-live', 'miss'),
    ]);
    expect([...narrow.escalated]).toEqual(['miss']);
    expect(broad.candidates).toEqual([candidate('broad-old', 'broad')]);
  });

  it('keeps mirror candidates and does not mark the unit escalated when fetchLive returns null', async () => {
    const base = [candidate('one-old', 'one'), candidate('two-old', 'two')];

    const out = await applySourceLiveEscalation(
      base,
      [unit('one', { stale: true, fetchLive: async () => null })],
      { narrowLookup: false },
    );

    expect(out.candidates).toEqual(base);
    expect([...out.escalated]).toEqual([]);
  });

  it('uses the owns predicate instead of id-prefix coincidence when replacing mirror rows', async () => {
    const base = [
      candidate('one:remote-looking', 'other'),
      candidate('one-owned', 'one'),
    ];

    const out = await applySourceLiveEscalation(
      base,
      [
        unit('one', {
          stale: true,
          owns: (c) => c.source === 'one',
          fetchLive: async () => [],
        }),
      ],
      { narrowLookup: false },
    );

    expect(out.candidates).toEqual([candidate('one:remote-looking', 'other')]);
    expect([...out.escalated]).toEqual(['one']);
  });

  it('runs live fetches sequentially in unit order', async () => {
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const sequentialUnit = (key: string): SourceLiveEscalationUnit<Candidate> =>
      unit(key, {
        stale: true,
        fetchLive: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          order.push(`start:${key}`);
          await Promise.resolve();
          order.push(`end:${key}`);
          active -= 1;
          return [candidate(`${key}-live`, key)];
        },
      });

    const out = await applySourceLiveEscalation(
      [],
      [sequentialUnit('one'), sequentialUnit('two')],
      { narrowLookup: false },
    );

    expect(order).toEqual(['start:one', 'end:one', 'start:two', 'end:two']);
    expect(maxActive).toBe(1);
    expect(out.candidates).toEqual([
      candidate('one-live', 'one'),
      candidate('two-live', 'two'),
    ]);
    expect([...out.escalated]).toEqual(['one', 'two']);
  });

  it('reports the exact successful escalated keys', async () => {
    const out = await applySourceLiveEscalation(
      [candidate('one-old', 'one'), candidate('two-old', 'two')],
      [
        unit('one', { stale: true, fetchLive: async () => [candidate('one-live', 'one')] }),
        unit('two', { stale: true, fetchLive: async () => null }),
        unit('three', { stale: true, fetchLive: async () => [candidate('three-live', 'three')] }),
      ],
      { narrowLookup: false },
    );

    expect([...out.escalated]).toEqual(['one', 'three']);
    expect(out.candidates).toEqual([
      candidate('two-old', 'two'),
      candidate('one-live', 'one'),
      candidate('three-live', 'three'),
    ]);
  });

  it('treats an empty live array as a successful replacement that drops owned mirror rows', async () => {
    const out = await applySourceLiveEscalation(
      [candidate('one-old', 'one'), candidate('two-old', 'two')],
      [unit('one', { stale: true, fetchLive: async () => [] })],
      { narrowLookup: false },
    );

    expect(out.candidates).toEqual([candidate('two-old', 'two')]);
    expect([...out.escalated]).toEqual(['one']);
  });
});
