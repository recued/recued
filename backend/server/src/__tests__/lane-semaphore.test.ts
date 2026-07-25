/** D-181 Slice 2 — the two-lane concurrency semaphore.
 *
 *  Covers the acceptance criteria + the codex-review edge cases:
 *   - bypass (fast-path / ai-governor) consumes no capacity;
 *   - `[fast, fast, slow, slow]` → 2 bypass, 2 acquire (1 slot + 1 queued);
 *   - release-on-settle frees a queued waiter (FIFO); release is idempotent;
 *   - a crashed/failed release still frees the slot (no leak);
 *   - held-lane inheritance: a nested same-lane call inherits instead of
 *     deadlocking at N = 1;
 *   - invalid capacity overrides (NaN / Infinity / fractional / 0 / negative)
 *     are sanitized to a finite positive integer. */

import { describe, expect, it } from 'vitest';
import type { CallClass, SlotLease, SlotRequest } from '@recued/contracts';
import { LaneSemaphore, autoLocalHeavyCapacity } from '../execution/lane-semaphore.js';

const req = (call_class: CallClass, held?: SlotRequest['held_lanes']): SlotRequest => ({
  call_class,
  descriptor: { recipe_id: 'r', slug: 's' },
  ...(held ? { held_lanes: held } : {}),
});

/** Flush the microtask + macrotask queues so any synchronously-resolvable
 *  acquire() has settled; a still-queued waiter stays pending. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** Whether a promise has settled (resolved or rejected) yet. */
const tracker = (p: Promise<unknown>) => {
  let settledFlag = false;
  void p.then(
    () => {
      settledFlag = true;
    },
    () => {
      settledFlag = true;
    },
  );
  return () => settledFlag;
};

const occ = (sem: LaneSemaphore, lane: 'local-heavy' | 'external-io') =>
  sem.occupancy().find((o) => o.lane === lane)!;

describe('LaneSemaphore — bypass', () => {
  it('fast-path and ai-governor consume no capacity', async () => {
    const sem = new LaneSemaphore({ local_heavy_n: 1, external_io_n: 1 });
    const fast = await sem.acquire(req('fast-path'));
    const ai = await sem.acquire(req('ai-governor'));
    expect(fast.lane).toBeNull();
    expect(ai.lane).toBeNull();
    expect(occ(sem, 'local-heavy').in_use).toBe(0);
    expect(occ(sem, 'external-io').in_use).toBe(0);
    // releasing a bypass lease is a harmless no-op
    fast.release('succeeded');
    expect(occ(sem, 'local-heavy').in_use).toBe(0);
  });
});

describe('LaneSemaphore — [fast, fast, slow, slow]', () => {
  it('2 bypass, 2 acquire (1 slot + 1 queued), queued resolves on release', async () => {
    const sem = new LaneSemaphore({ external_io_n: 1 });
    const fast1 = await sem.acquire(req('fast-path'));
    const fast2 = await sem.acquire(req('fast-path'));
    expect(fast1.lane).toBeNull();
    expect(fast2.lane).toBeNull();

    const slow1 = await sem.acquire(req('external-io')); // takes the only slot
    const p2 = sem.acquire(req('external-io')); // queues
    const isSettled = tracker(p2);
    await flush();

    expect(slow1.lane).toBe('external-io');
    expect(isSettled()).toBe(false); // still queued behind slow1
    expect(occ(sem, 'external-io').in_use).toBe(1);
    expect(occ(sem, 'external-io').queued).toBe(1);

    slow1.release('succeeded'); // frees the slot → pumps the queue
    const slow2 = await p2;
    expect(slow2.lane).toBe('external-io');
    expect(occ(sem, 'external-io').in_use).toBe(1);
    expect(occ(sem, 'external-io').queued).toBe(0);
  });
});

describe('LaneSemaphore — queue + release', () => {
  it('grants queued waiters FIFO and never exceeds capacity', async () => {
    const sem = new LaneSemaphore({ local_heavy_n: 2 });
    const a = await sem.acquire(req('local-heavy'));
    const b = await sem.acquire(req('local-heavy'));
    const pc = sem.acquire(req('local-heavy'));
    const pd = sem.acquire(req('local-heavy'));
    await flush();
    expect(occ(sem, 'local-heavy').in_use).toBe(2); // capped
    expect(occ(sem, 'local-heavy').queued).toBe(2);

    a.release('succeeded');
    const c = await pc; // first queued wins (FIFO)
    expect(c.lane).toBe('local-heavy');
    expect(occ(sem, 'local-heavy').in_use).toBe(2);
    expect(occ(sem, 'local-heavy').queued).toBe(1);

    b.release('succeeded');
    const d = await pd;
    expect(d.lane).toBe('local-heavy');
    expect(occ(sem, 'local-heavy').queued).toBe(0);
    c.release('succeeded');
    d.release('succeeded');
    expect(occ(sem, 'local-heavy').in_use).toBe(0);
  });

  it('release is idempotent (double release does not over-free)', async () => {
    const sem = new LaneSemaphore({ local_heavy_n: 1 });
    const a = await sem.acquire(req('local-heavy'));
    const pb = sem.acquire(req('local-heavy'));
    a.release('succeeded');
    a.release('succeeded'); // second release: no-op
    const b = await pb;
    expect(occ(sem, 'local-heavy').in_use).toBe(1); // exactly b holds it, not -1/over-granted
    b.release('succeeded');
    b.release('failed'); // idempotent regardless of outcome
    expect(occ(sem, 'local-heavy').in_use).toBe(0);
  });

  it('a failed/crashed settle still frees the slot (no leak)', async () => {
    const sem = new LaneSemaphore({ local_heavy_n: 1 });
    const a = await sem.acquire(req('local-heavy'));
    const pb = sem.acquire(req('local-heavy'));
    a.release('failed'); // crash path reports 'failed' — must still pump
    const b = await pb;
    expect(b.lane).toBe('local-heavy');
    b.release('killed'); // even a kill outcome frees
    expect(occ(sem, 'local-heavy').in_use).toBe(0);
  });
});

describe('LaneSemaphore — held-lane inheritance (no N=1 deadlock)', () => {
  it('a nested same-lane call inherits the ancestor slot instead of queueing', async () => {
    const sem = new LaneSemaphore({ local_heavy_n: 1 });
    const ancestor = await sem.acquire(req('local-heavy')); // holds the only slot
    expect(ancestor.lane).toBe('local-heavy');

    // The nested call declares the ancestor's held lane. Without inheritance it
    // would queue behind the ancestor (which is awaiting it) → deadlock.
    const nested = await sem.acquire(req('local-heavy', new Set(['local-heavy'])));
    expect(nested.lane).toBeNull(); // inherited — no second slot
    expect(occ(sem, 'local-heavy').in_use).toBe(1); // ancestor only
    expect(occ(sem, 'local-heavy').queued).toBe(0); // nobody queued

    nested.release('succeeded'); // inherited release frees nothing
    expect(occ(sem, 'local-heavy').in_use).toBe(1);
    ancestor.release('succeeded');
    expect(occ(sem, 'local-heavy').in_use).toBe(0);
  });

  it('a held lane does not leak inheritance to a different lane', async () => {
    const sem = new LaneSemaphore({ external_io_n: 1 });
    // Holding local-heavy must NOT let an external-io call bypass.
    const a = await sem.acquire(req('external-io'));
    const p = sem.acquire(req('external-io', new Set(['local-heavy'])));
    const isSettled = tracker(p);
    await flush();
    expect(isSettled()).toBe(false); // gated normally — different lane, no inherit
    a.release('succeeded');
    const b = await p;
    expect(b.lane).toBe('external-io');
    b.release('succeeded');
  });
});

describe('LaneSemaphore — capacity sanitization', () => {
  const capacityOf = (n: number | undefined) =>
    occ(new LaneSemaphore({ external_io_n: n }), 'external-io').capacity;

  it('NaN / Infinity fall back to the default', () => {
    expect(capacityOf(Number.NaN)).toBe(64);
    expect(capacityOf(Number.POSITIVE_INFINITY)).toBe(64);
    expect(capacityOf(undefined)).toBe(64);
  });

  it('fractional floors, sub-1 clamps to 1', () => {
    expect(capacityOf(1.5)).toBe(1);
    expect(capacityOf(2.9)).toBe(2);
    expect(capacityOf(0)).toBe(1);
    expect(capacityOf(-5)).toBe(1);
  });

  it('a valid integer override is honored', () => {
    expect(capacityOf(3)).toBe(3);
  });

  it('autoLocalHeavyCapacity is always a finite integer ≥ 1', () => {
    expect(autoLocalHeavyCapacity(1, 16 * 1024 ** 3)).toBe(1); // single core
    expect(autoLocalHeavyCapacity(8, 0)).toBe(1); // no free RAM → floor at 1
    const v = autoLocalHeavyCapacity(8, 16 * 1024 ** 3);
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(1);
  });

  it('autoLocalHeavyCapacity floors a poisoned (NaN/Infinity) probe, never NaN', () => {
    expect(autoLocalHeavyCapacity(8, Number.NaN)).toBe(1); // NaN free RAM → 1, not NaN
    expect(autoLocalHeavyCapacity(Number.NaN, 16 * 1024 ** 3)).toBe(1); // NaN cores → 1
    expect(autoLocalHeavyCapacity(8, Number.POSITIVE_INFINITY)).toBe(7); // ∞ RAM → core-bound
  });
});

describe('LaneSemaphore — local-heavy re-baselines its RAM reservation at the idle→busy edge', () => {
  const GB = 1024 ** 3;
  // cores: () => 8 ⇒ byCore = 7, so free RAM is the binding constraint and the
  // assertions stay deterministic regardless of the host's real core count.
  const dyn = (free: { v: number }) =>
    new LaneSemaphore({ cores: () => 8, freemem: () => free.v });

  it('boots from the injected freemem — floor(free / 1.5 GB), capped by cores', () => {
    expect(occ(dyn({ v: 6 * GB }), 'local-heavy').capacity).toBe(4);
    expect(occ(dyn({ v: 1.5 * GB }), 'local-heavy').capacity).toBe(1);
  });

  it('bounds a burst that starts after a daemon grew RAM while the lane was idle', async () => {
    // codex MEDIUM: the re-baseline must fire at the idle→busy edge, not only on a
    // later release — else the FIRST burst after idle-time daemon growth grants
    // against the stale boot capacity (4) instead of the live one (1).
    const free = { v: 6 * GB }; // boot cap 4
    const sem = dyn(free);
    free.v = 1.5 * GB; // a supervised daemon lazy-loads its model; lane still idle

    const a = await sem.acquire(req('local-heavy')); // idle→busy edge → re-baseline to 1
    const pb = sem.acquire(req('local-heavy'));
    const pc = sem.acquire(req('local-heavy'));
    const pd = sem.acquire(req('local-heavy'));
    await flush();
    expect(occ(sem, 'local-heavy').capacity).toBe(1);
    expect(a.lane).toBe('local-heavy');
    expect(occ(sem, 'local-heavy').in_use).toBe(1); // only one runs, NOT four
    expect(occ(sem, 'local-heavy').queued).toBe(3);

    a.release('succeeded'); // queue drains one at a time under the shrunk reservation
    const b = await pb;
    expect(occ(sem, 'local-heavy').in_use).toBe(1);
    expect(occ(sem, 'local-heavy').queued).toBe(2);
    b.release('succeeded');
    const c = await pc;
    c.release('succeeded');
    const d = await pd;
    d.release('succeeded');
    expect(occ(sem, 'local-heavy').in_use).toBe(0);
  });

  it('grows capacity back at the next idle→busy edge when a daemon frees RAM', async () => {
    const free = { v: 1.5 * GB }; // boot cap 1
    const sem = dyn(free);
    const a = await sem.acquire(req('local-heavy')); // idle edge → re-baseline (still 1)
    expect(occ(sem, 'local-heavy').capacity).toBe(1);
    a.release('succeeded'); // lane idle again
    free.v = 6 * GB; // daemon exited, RAM freed
    const b = await sem.acquire(req('local-heavy')); // next idle→busy edge → re-baseline up
    expect(occ(sem, 'local-heavy').capacity).toBe(4);
    b.release('succeeded');
  });

  it('does NOT re-read freemem mid-burst — the reservation is fixed once busy', async () => {
    // The synchronous-reservation property: free RAM dropping mid-burst must not
    // shrink the in-force capacity (no per-acquire freemem read → no double-count
    // / allocation-lag over-commit). Only an idle→busy edge re-measures.
    const free = { v: 6 * GB }; // boot cap 4
    const sem = dyn(free);
    const a = await sem.acquire(req('local-heavy')); // idle edge → cap 4
    free.v = 1.5 * GB; // a daemon grows WHILE the lane is busy
    const b = await sem.acquire(req('local-heavy')); // inUse 1 ≠ 0 → no re-baseline
    expect(occ(sem, 'local-heavy').capacity).toBe(4); // reservation held
    expect(b.lane).toBe('local-heavy'); // granted against the fixed reservation
    a.release('succeeded');
    b.release('succeeded');
  });

  it('floors at 1 under heavy pressure — re-baseline never deadlocks the lane', async () => {
    const sem = dyn({ v: 0.2 * GB }); // less than one slot's reservation
    const a = await sem.acquire(req('local-heavy')); // idle edge → cap floored to 1
    expect(occ(sem, 'local-heavy').capacity).toBe(1);
    expect(a.lane).toBe('local-heavy'); // the floor slot still grants
    a.release('succeeded');
  });

  it('a NaN freemem probe cannot poison capacity into a permanent deadlock', async () => {
    // codex LOW: Math.max(1, NaN) === NaN would wedge the lane (inUse < NaN always
    // false). autoLocalHeavyCapacity floors NaN/Infinity to 1.
    const sem = new LaneSemaphore({ cores: () => 8, freemem: () => Number.NaN });
    expect(occ(sem, 'local-heavy').capacity).toBe(1); // NaN floored, not NaN
    const a = await sem.acquire(req('local-heavy')); // still grantable, not wedged
    expect(a.lane).toBe('local-heavy');
    a.release('succeeded');
  });

  it('an explicit local_heavy_n pin disables re-baselining (stays static)', async () => {
    const free = { v: 6 * GB };
    const sem = new LaneSemaphore({ local_heavy_n: 3, cores: () => 8, freemem: () => free.v });
    expect(occ(sem, 'local-heavy').capacity).toBe(3);
    free.v = 1.5 * GB;
    const a = await sem.acquire(req('local-heavy')); // idle edge, but pinned → no re-baseline
    expect(occ(sem, 'local-heavy').capacity).toBe(3);
    a.release('succeeded');
  });

  it('external-io is never re-baselined by the freemem seam', async () => {
    const sem = new LaneSemaphore({ cores: () => 8, freemem: () => 1.5 * GB });
    expect(occ(sem, 'external-io').capacity).toBe(64);
  });
});
