/** D-269 step 4 — the release card is a QUERY, not a replayed queue.
 *
 *  ⛔⛔ NOTHING IS HELD DURING THE WINDOW, AND THAT IS THE DESIGN RATHER THAN AN
 *  OPTIMISATION. `durable-outbox` states the test for whether a message needs
 *  storing — *"would the receiver be unable to RECONSTRUCT it"* — and a reminder
 *  is fully reconstructable from its anchor plus the kind's offset. **The anchor
 *  rows are the queue.** The only thing stored is ONE INTEGER: the last instant
 *  a sweep saw the window active, because knowing the window CLOSED is the one
 *  fact no anchor row records.
 *
 *  🔑 AND RECOMPUTING IS MORE CORRECT THAN REPLAYING, WHICH IS THE TEST THAT
 *  MATTERS MOST HERE: a held queue delivers a reminder for a commitment
 *  cancelled at 03:00. Recomputation cannot, and that is driven below. */

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  buildQuietHoursDigest,
  isQuietHoursDigestEmpty,
  RECUED_BUILTIN_SOURCE_ID,
  renderQuietHoursDigest,
  WORK_ENTITY_DUE_SOON_WINDOW_MS,
  type QuietHoursDigest,
} from '@recued/contracts';
import { createQuietHoursStore } from '../storage/quiet-hours-store.js';
import { createTaskEmissionLedger, runDueStatusSweep } from '../work-entity-due-status-sweep.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';

const NIGHT = Date.parse('2026-06-15T18:00:00Z');
const MORNING = Date.parse('2026-06-16T02:00:00Z');
const HOUR = 60 * 60 * 1000;

describe('D-269 step 4 — the split is the message', () => {
  const item = (id: string, anchor_at: number) =>
    ({ kind: 'task', id, title: id, anchor_at });

  it('⛔ still-ahead is LISTED, already-passed is COUNTED', () => {
    // "Catch up" for a reminder is NOT "fire it now". Replaying a 07:00
    // reminder for an 08:00 meeting is useful; replaying one for a meeting at
    // 23:00 last night is noise pretending to be diligence.
    const d = buildQuietHoursDigest(
      [item('gone', MORNING - HOUR), item('soon', MORNING + HOUR), item('later', MORNING + 5 * HOUR)],
      { from: NIGHT, to: MORNING }, MORNING,
    );
    expect(d.still_ahead.map((i) => i.id)).toEqual(['soon', 'later']);
    expect(d.already_passed).toBe(1);
  });

  it('⚠ and the COUNT is kept — it is the record of what the window cost', () => {
    // The same role the miss count plays in D-266, and the only way an owner
    // learns the window took something from them.
    const d = buildQuietHoursDigest(
      [item('a', MORNING - 1), item('b', MORNING - 2)], { from: NIGHT, to: MORNING }, MORNING,
    );
    expect(d.still_ahead).toEqual([]);
    expect(d.already_passed).toBe(2);
    expect(isQuietHoursDigestEmpty(d)).toBe(false);
  });

  it('soonest first — the owner reads the top of a card', () => {
    const d = buildQuietHoursDigest(
      [item('late', MORNING + 9 * HOUR), item('next', MORNING + HOUR)],
      { from: NIGHT, to: MORNING }, MORNING,
    );
    expect(d.still_ahead.map((i) => i.id)).toEqual(['next', 'late']);
  });

  it('⛔ an EMPTY digest is empty — a nightly "nothing happened" is the card people switch off', () => {
    expect(isQuietHoursDigestEmpty(
      buildQuietHoursDigest([], { from: NIGHT, to: MORNING }, MORNING),
    )).toBe(true);
  });

  it('renders the split, naming the passed ones rather than listing them', () => {
    const d: QuietHoursDigest = {
      from: NIGHT, to: MORNING,
      still_ahead: [item('Dentist', MORNING + HOUR)],
      already_passed: 2,
    };
    const text = renderQuietHoursDigest(d, 'UTC');
    expect(text).toContain('Still ahead:');
    expect(text).toContain('Dentist');
    expect(text).toContain('2 deadlines passed while you were away.');
  });
});

describe('D-269 step 4 — driven: the edge, and what the card actually says', () => {
  const build = () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureWorkEntitySchema(db);
    const store = createWorkEntityStore(db);
    for (const kind of ['task', 'commitment'] as const) {
      store.registerSource({
        id: RECUED_BUILTIN_SOURCE_ID(kind), top_tier_kind: kind, source_kind: 'builtin',
        source_label: `Recued ${kind}`, write_capable: true, registered_at: NIGHT,
      });
    }
    const quiet = createQuietHoursStore(new Database(':memory:'));
    return { store, quiet };
  };

  const sweep = (
    ctx: ReturnType<typeof build>,
    at: number,
    isQuiet: boolean,
    released: QuietHoursDigest[],
    ledger = createTaskEmissionLedger(),
  ) => runDueStatusSweep({
    store: ctx.store,
    taskEmissionLedger: ledger,
    policy: () => ({
      enabled: true, offset_ms: WORK_ENTITY_DUE_SOON_WINDOW_MS,
    }),
    isQuiet: () => isQuiet,
    wasQuiet: () => ctx.quiet.readLastActiveAt(),
    markQuiet: (v) => ctx.quiet.writeLastActiveAt(v),
    onReleased: (d) => { released.push(d); },
    now: () => at,
  });

  it('⛔ the EDGE fires once, not every cycle of the night', () => {
    // "Quiet now" is true all night; what the owner gets one card for is the
    // transition out of it.
    const ctx = build();
    ctx.store.writeTask({
      id: 't-1', source_id: RECUED_BUILTIN_SOURCE_ID('task'),
      title: 'ship it', done: false, due_at: MORNING + HOUR,
    }, NIGHT - 1000);
    const released: QuietHoursDigest[] = [];

    sweep(ctx, NIGHT, true, released);
    sweep(ctx, NIGHT + HOUR, true, released);
    expect(released).toHaveLength(0);          // still inside

    sweep(ctx, MORNING, false, released);
    expect(released).toHaveLength(1);          // the edge

    sweep(ctx, MORNING + HOUR, false, released);
    expect(released).toHaveLength(1);          // ...and only once
  });

  it('⛔⛔ RECOMPUTED, NOT REPLAYED — a commitment cancelled during the night is NOT in the card', () => {
    // The property a held queue cannot have. This is the whole argument for the
    // anchor rows being the queue.
    const ctx = build();
    ctx.store.writeCommitment({
      id: 'c-1', source_id: RECUED_BUILTIN_SOURCE_ID('commitment'),
      direction: 'outbound', statement: 'send the draft', derivation: 'user_declared',
      promised_for_at: MORNING + HOUR, due_status: 'due_soon',
    }, NIGHT - 1000);
    const released: QuietHoursDigest[] = [];

    sweep(ctx, NIGHT, true, released);
    // The owner cancels it at 03:00, inside the window.
    const row = ctx.store.readCommitment('c-1')!;
    ctx.store.writeCommitment({ ...row, lifecycle_state: 'cancelled' }, NIGHT + HOUR);

    sweep(ctx, MORNING, false, released);
    // Either no card at all, or a card that does not mention it — never a
    // reminder for something that stopped being true.
    const mentioned = released.flatMap((d) => d.still_ahead.map((i) => i.id));
    expect(mentioned).not.toContain('c-1');
  });

  it('🔑 the card carries what a commitment CANNOT re-emit for itself', () => {
    // A task defers naturally (step 3 leaves its ledger un-advanced). A
    // commitment's `due_status` has already advanced, so it will never diverge
    // again — the card is the only place it can appear.
    const ctx = build();
    ctx.store.writeCommitment({
      id: 'c-live', source_id: RECUED_BUILTIN_SOURCE_ID('commitment'),
      direction: 'outbound', statement: 'pay the invoice', derivation: 'user_declared',
      promised_for_at: MORNING + 2 * HOUR, due_status: 'due_soon',
    }, NIGHT - 1000);
    const released: QuietHoursDigest[] = [];

    sweep(ctx, NIGHT, true, released);
    sweep(ctx, MORNING, false, released);

    expect(released).toHaveLength(1);
    expect(released[0]!.still_ahead.map((i) => i.title)).toContain('pay the invoice');
  });

  it('⚠ no card when there is nothing to say, even at a real edge', () => {
    const ctx = build();
    const released: QuietHoursDigest[] = [];
    sweep(ctx, NIGHT, true, released);
    sweep(ctx, MORNING, false, released);
    expect(released).toHaveLength(0);
  });

  it('⛔ nothing is STORED during the window but one integer', () => {
    // The marker is the edge detector; the content is recomputed. If this ever
    // grows a payload, the design has become the queue it refuses.
    const ctx = build();
    const released: QuietHoursDigest[] = [];
    sweep(ctx, NIGHT, true, released);
    expect(ctx.quiet.readLastActiveAt()).toBe(NIGHT);
    sweep(ctx, MORNING, false, released);
    expect(ctx.quiet.readLastActiveAt()).toBeNull();
  });
});
