/** D-169 P2 Slice 2 — bus-buffer `seed()` (authoritative historical
 *  replace) + the `run_id` dedup on the live execution apply. */

import { describe, expect, it } from 'vitest';

import type { ServerEvent } from '@recued/contracts';
import {
  createBridgeBusBuffer,
  type BridgeBusBufferSnapshot,
} from '../bus-buffer.js';

/** A terminal `execution` bus event for the live-apply path. */
const execEvent = (
  run_id: string,
  recipe_id: string,
  op: 'complete' | 'error',
  cursor: number,
): ServerEvent =>
  ({ kind: 'execution', recipe_id, run_id, op, cursor }) as ServerEvent;

/** A historical snapshot with one row in each section. */
const snapshot = (
  patch: Partial<BridgeBusBufferSnapshot> = {},
): BridgeBusBufferSnapshot => ({
  recipe_results: [
    {
      run_id: 'hist-run',
      recipe_id: 'hist-recipe',
      status: 'ok',
      started_at: 100,
      duration_ms: 42,
    },
  ],
  notifications: [{ id: 'hist-notif', text: 'historical', fired_at: 90 }],
  approvals: [
    {
      ask_id: 'hist-ask',
      text: 'historical ask',
      options: [{ id: 'ok', label: 'OK' }],
      created_at: 80,
    },
  ],
  ...patch,
});

describe('D-169 P2 Slice 2 bus-buffer seed + run_id dedup', () => {
  it('seed() REPLACES all three sections, dropping prior live rows', () => {
    const buffer = createBridgeBusBuffer({ now: () => 1_000 });
    // Accumulate a live row in each section first.
    buffer.apply(execEvent('live-run', 'live-recipe', 'complete', 1));
    buffer.apply({
      kind: 'notification.notify',
      text: 'live notify',
      cursor: 2,
    } as ServerEvent);
    buffer.apply({
      kind: 'notification.ask',
      ask_id: 'live-ask',
      text: 'live ask',
      options: [{ id: 'y', label: 'Y' }],
      cursor: 3,
    } as ServerEvent);
    expect(buffer.snapshot().recipe_results).toHaveLength(1);

    buffer.seed(snapshot());

    const snap = buffer.snapshot();
    // Each section is exactly the seeded row — the live rows are gone.
    expect(snap.recipe_results).toEqual([
      {
        run_id: 'hist-run',
        recipe_id: 'hist-recipe',
        status: 'ok',
        started_at: 100,
        duration_ms: 42,
      },
    ]);
    expect(snap.notifications).toEqual([
      { id: 'hist-notif', text: 'historical', fired_at: 90 },
    ]);
    expect(snap.approvals).toEqual([
      {
        ask_id: 'hist-ask',
        text: 'historical ask',
        options: [{ id: 'ok', label: 'OK' }],
        created_at: 80,
      },
    ]);
  });

  it('seed() caps each section to the configured cap', () => {
    const buffer = createBridgeBusBuffer({ cap: 2, now: () => 1_000 });
    buffer.seed({
      recipe_results: [
        { run_id: 'r1', recipe_id: 'a', status: 'ok', started_at: 3, duration_ms: 1 },
        { run_id: 'r2', recipe_id: 'b', status: 'ok', started_at: 2, duration_ms: 1 },
        { run_id: 'r3', recipe_id: 'c', status: 'ok', started_at: 1, duration_ms: 1 },
      ],
      notifications: [
        { id: 'n1', text: '1', fired_at: 3 },
        { id: 'n2', text: '2', fired_at: 2 },
        { id: 'n3', text: '3', fired_at: 1 },
      ],
      approvals: [
        { ask_id: 'a1', text: '1', options: [], created_at: 3 },
        { ask_id: 'a2', text: '2', options: [], created_at: 2 },
        { ask_id: 'a3', text: '3', options: [], created_at: 1 },
      ],
    });
    const snap = buffer.snapshot();
    // Cap=2 keeps the first two of each (the historical slice is already
    // newest-first, so seed keeps the newest two).
    expect(snap.recipe_results.map((r) => r.run_id)).toEqual(['r1', 'r2']);
    expect(snap.notifications.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(snap.approvals.map((a) => a.ask_id)).toEqual(['a1', 'a2']);
  });

  it('seed() copies the snapshot arrays — later mutation of the input does not leak into the buffer', () => {
    const buffer = createBridgeBusBuffer({ now: () => 1_000 });
    // Mutable local arrays so the test can mutate them post-seed (the
    // snapshot type is ReadonlyArray; seed must copy, not alias).
    const recipeRows = [
      {
        run_id: 'hist-run',
        recipe_id: 'hist-recipe',
        status: 'ok' as const,
        started_at: 100,
        duration_ms: 42,
      },
    ];
    const notifRows = [{ id: 'hist-notif', text: 'historical', fired_at: 90 }];
    buffer.seed({ recipe_results: recipeRows, notifications: notifRows, approvals: [] });
    // Mutate the caller's arrays after seeding.
    recipeRows.length = 0;
    notifRows.push({ id: 'sneaky', text: 'x', fired_at: 1 });
    expect(buffer.snapshot().recipe_results).toHaveLength(1);
    expect(buffer.snapshot().notifications).toHaveLength(1);
    expect(buffer.snapshot().notifications[0]!.id).toBe('hist-notif');
  });

  it('live execution apply dedups by run_id (upsert, newest-first)', () => {
    let tick = 1_000;
    const buffer = createBridgeBusBuffer({ now: () => tick++ });
    buffer.apply(execEvent('run-A', 'recipe-A', 'complete', 1));
    buffer.apply(execEvent('run-B', 'recipe-B', 'complete', 2));
    // Re-fire run-A as a terminal error — upsert: one row, newest-first.
    buffer.apply(execEvent('run-A', 'recipe-A', 'error', 3));

    const rows = buffer.snapshot().recipe_results;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.run_id)).toEqual(['run-A', 'run-B']);
    expect(rows[0]).toMatchObject({ run_id: 'run-A', status: 'error' });
  });

  it('seed then live execution with a seeded run_id dedups by run_id', () => {
    let tick = 1_000;
    const buffer = createBridgeBusBuffer({ now: () => tick++ });
    buffer.seed(
      snapshot({
        recipe_results: [
          {
            run_id: 'run-seed',
            recipe_id: 'seed-recipe',
            status: 'ok',
            started_at: 100,
            duration_ms: 42,
          },
        ],
      }),
    );
    // A terminal live event for the same run that was seeded.
    buffer.apply(execEvent('run-seed', 'seed-recipe', 'complete', 9));

    const rows = buffer.snapshot().recipe_results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ run_id: 'run-seed', duration_ms: null });
  });

  it('different run_ids are kept as distinct rows', () => {
    let tick = 1_000;
    const buffer = createBridgeBusBuffer({ now: () => tick++ });
    buffer.apply(execEvent('run-1', 'recipe-1', 'complete', 1));
    buffer.apply(execEvent('run-2', 'recipe-2', 'complete', 2));
    expect(buffer.snapshot().recipe_results.map((r) => r.run_id)).toEqual([
      'run-2',
      'run-1',
    ]);
  });
});
