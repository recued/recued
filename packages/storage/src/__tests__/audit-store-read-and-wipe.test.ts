/** D-161 P3 / D-169 / Phase B — the audit store's READ and WIPE surface.
 *
 *  ⚠ FOUND BY MUTATION (2026-09-18). 20 mutations of the live read/delete
 *  methods in `packages/storage/src/audit.ts`. The bridge-dispatcher scan and
 *  the export ordering were already well defended; these five were not.
 *
 *  ⛔ SCOPE NOTE. Six sibling methods — `clearOlderThan`, `clearByRecipe`,
 *  `clearOldestEntries`, `clearOldestActivities`, `countReserveEntries`,
 *  `countReserveActivities` — are deliberately NOT covered here, because a
 *  call-path census found they have no production caller at all: they are
 *  implemented, forwarded by two wrappers, stubbed in ~15 test doubles, and
 *  invoked by nothing. See the sweep note on the interface in `audit.ts`. */

import { describe, expect, it } from 'vitest';

import {
  buildAuditEntry,
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type AuditEntryInput,
  type AuditLogStore,
} from '../index.js';

const mkLog = (opts?: Parameters<typeof createAuditLogStore>[2]): AuditLogStore =>
  createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
    opts,
  );

const base = (over: Partial<AuditEntryInput> = {}): AuditEntryInput => ({
  recipe_id: 'r',
  recipe_hash: 'h',
  commit_status: 'succeeded',
  duration_ms: 0,
  errors: [],
  ...over,
});

const USER_SOURCE = {
  channel: 'user',
  actor: 'user_self',
  user_id: 'u-1',
  client_token_id: 't-1',
} as const;

describe('listRecent narrows to the lane BEFORE it takes the page', () => {
  /** The store's own comment states the invariant: "narrow to the requested
   *  actor lane(s) BEFORE the slice so the page is `limit` matching rows
   *  (I-9)". Slicing first is the natural way to write it and is wrong in
   *  exactly one situation — when rows outside the lane CROWD THE HEAD. Every
   *  existing fixture had either fewer rows than the limit or no crowding, so
   *  both orders agreed and the invariant was free. */
  const crowded = async (): Promise<AuditLogStore> => {
    const log = mkLog();
    // Six SYSTEM rows, all newer than anything the user did.
    for (let i = 0; i < 6; i++) {
      await log.append(buildAuditEntry(base({ run_id: `sys-${i}`, now: 9_000 + i })));
    }
    // Three USER rows, older — so they sort behind every system row.
    for (let i = 0; i < 3; i++) {
      await log.append({
        ...buildAuditEntry(base({ run_id: `usr-${i}`, now: 1_000 + i })),
        execution_source: USER_SOURCE,
      } as AuditEntry);
    }
    return log;
  };

  it('⛔⛔ a full page of in-lane rows survives out-of-lane rows at the head', async () => {
    const log = await crowded();
    const page = await log.listRecent(3, { origin_actors: ['user_self'] });
    expect(
      page.map((e) => e.run_id),
      'the page was cut from the unfiltered head, so in-lane rows were lost',
    ).toEqual(['usr-2', 'usr-1', 'usr-0']);
  });

  it('⚠ and the page is still capped at the limit', async () => {
    const log = await crowded();
    expect(await log.listRecent(2, { origin_actors: ['user_self'] })).toHaveLength(2);
  });

  it('⚠ an EMPTY lane filter means no filter, not "match nothing"', async () => {
    // A join check, not a branch check: the store's `filter.length > 0` fast
    // path and `originActorPassesTimelineFilter`'s own empty-filter arm each
    // make this true on their own, so neither half alone can break it — which
    // is exactly why it is worth pinning at the composition.
    const log = await crowded();
    const page = await log.listRecent(9, { origin_actors: [] });
    expect(page).toHaveLength(9);
  });

  it('⚠ an absent execution_source reads as the system lane', async () => {
    const log = await crowded();
    const page = await log.listRecent(9, { origin_actors: ['system'] });
    expect(page.map((e) => e.run_id)).toEqual([
      'sys-5', 'sys-4', 'sys-3', 'sys-2', 'sys-1', 'sys-0',
    ]);
  });
});

describe('listActivities treats a zero limit as NONE', () => {
  const withActivities = async (n: number): Promise<AuditLogStore> => {
    const log = mkLog();
    for (let i = 0; i < n; i++) {
      await log.logActivity({
        activity_id: `a-${i}`, timestamp: 1_000 + i, action: 'install', target: 'r',
      });
    }
    return log;
  };

  it('⛔⛔ zero rows requested returns zero rows, not the whole log', async () => {
    // `limit ? … : all` folded 0 in with undefined. A caller computing a
    // budget down to 0 got EVERYTHING — the opposite of what it asked for.
    expect(await (await withActivities(5)).listActivities(0)).toHaveLength(0);
  });

  it('⚠ a negative limit is also none, never a tail-trim', async () => {
    // `slice(0, -1)` would silently drop the last row instead.
    expect(await (await withActivities(5)).listActivities(-1)).toHaveLength(0);
  });

  it('⚠ NO limit still means every row, newest first', async () => {
    const all = await (await withActivities(3)).listActivities();
    expect(all.map((a) => a.activity_id)).toEqual(['a-2', 'a-1', 'a-0']);
  });
});

describe('the wipe returns the byte counter to zero', () => {
  it('⛔⛔ clearAll frees ACTIVITY bytes as well as entry bytes', async () => {
    // `recued-server audit clear` is the only live caller. The gate counter
    // it feeds is never reconciled against the disk, so bytes it fails to
    // give back are lost for the life of the process — leaving the audit gate
    // in pressure over rows that no longer exist.
    const deltas: number[] = [];
    const log = createAuditLogStore(
      createInMemoryCollection<AuditEntry>(),
      createInMemoryCollection<ActivityEntry>(),
      { onBytesChanged: (d) => deltas.push(d) },
    );
    await log.append(buildAuditEntry(base({ run_id: 'run-1' })));
    await log.logActivity({
      activity_id: 'act-1', timestamp: 1_000, action: 'install', target: 'r',
    });
    await log.clearAll();

    expect(
      deltas.reduce((a, b) => a + b, 0),
      'the wipe gave back fewer bytes than the writes took',
    ).toBe(0);
  });
});

describe('lastSuccessfulBridgeDispatch refuses an incomplete question', () => {
  it('⚠ an empty target_pattern returns null rather than matching a blank detail', async () => {
    // The method documents "Empty / mismatched inputs return null".
    //
    // ⛔ THE ROW MUST CARRY `detail: ''`, and the first version of this test
    // did not. With `detail` absent, `undefined !== ''` skips the row on the
    // DETAIL check and the method returns null whether the guard exists or
    // not — the assertion passed while testing nothing. An empty pattern is
    // only dangerous against a row whose detail is ALSO empty, so that is the
    // only fixture that puts the guard on the hook.
    const log = mkLog();
    await log.logActivity({
      activity_id: 'a-1', timestamp: 5_000,
      action: 'bridge_dispatch_succeeded', target: 'bridge-1', detail: '',
    });
    expect(await log.lastSuccessfulBridgeDispatch('bridge-1', '')).toBeNull();
    expect(await log.lastSuccessfulBridgeDispatch('', 'https://x/*')).toBeNull();
  });
});
