/** D-269 step 2 — the per-kind notification policy, and the sweep reading it.
 *
 *  ⛔⛔ THE DEFECT THIS SLICE COULD EASILY HAVE INTRODUCED, AND THE REASON MOST
 *  OF THESE TESTS EXIST. The due-status sweep does TWO things at once: it
 *  classifies (a notification concern) and, for commitments, it WRITES —
 *  advancing the persisted `due_status` column and flipping
 *  `lifecycle_state → expired` under `strict_expire`. The obvious
 *  implementation of "let the owner turn reminders off" is to skip the row, and
 *  that would make a settings toggle stop commitments expiring: silent data
 *  corruption wearing a preference. So `enabled` is asserted to gate the
 *  EMISSION and to leave every write alone.
 *
 *  🔑 AND ONE THE POLICY CREATED. `due_soon` used to mean "inside the shared 24h
 *  constant", so nothing but a moved deadline could take a row back out of it —
 *  which is why the sweep only walked forward. It now means "inside the owner's
 *  horizon", and SHRINKING that horizon strands rows at `due_soon` until they go
 *  overdue. Forward-only was safe when the window was a constant; it stops being
 *  safe the moment the window is a setting. */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  defaultNotificationKindPolicy,
  isValidNotificationOffsetMs,
  NOTIFICATION_ANCHORED_KINDS,
  NOTIFICATION_KIND_MAX_OFFSET_MS,
  WORK_ENTITY_DUE_SOON_WINDOW_MS,
  type Commitment,
  type Task,
} from '@recued/contracts';
import { createNotificationKindPolicyStore } from '../storage/notification-kind-policy-store.js';
import {
  classifyCommitmentDueStatus,
  classifyTaskDueWindow,
  createTaskEmissionLedger,
  runDueStatusSweep,
} from '../work-entity-due-status-sweep.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { RECUED_BUILTIN_SOURCE_ID } from '@recued/contracts';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-06-15T12:00:00Z');

describe('D-269 step 2 — the policy shape', () => {
  it('⛔ task and commitment default to TODAY\'S 24h — an upgrade must reclassify nothing', () => {
    // These ship to servers with live rows already classified against the
    // shared constant. A different default would silently move every one of
    // them: a data change dressed as a preference.
    expect(defaultNotificationKindPolicy('task').offset_ms)
      .toBe(WORK_ENTITY_DUE_SOON_WINDOW_MS);
    expect(defaultNotificationKindPolicy('commitment').offset_ms)
      .toBe(WORK_ENTITY_DUE_SOON_WINDOW_MS);
  });

  it('the kinds with no emitter yet get the default their SHAPE argues for', () => {
    // A booking is an appointment you travel to; a calendar reminder a day
    // early is the one everybody switches off. Inheriting 24h here would be
    // copying a number rather than choosing one.
    expect(defaultNotificationKindPolicy('booking').offset_ms).toBe(2 * HOUR);
    expect(defaultNotificationKindPolicy('calendar').offset_ms).toBe(15 * 60 * 1000);
  });

  it('⛔ `project` carries NO policy — the owner ruled it out, it is not an oversight', () => {
    // It has a real anchor (`target_completion_at`). The owner: "more manual".
    // A project deadline is a thing you MOVE, not a thing that arrives.
    expect(NOTIFICATION_ANCHORED_KINDS).toEqual(['task', 'commitment', 'booking', 'calendar']);
    expect((NOTIFICATION_ANCHORED_KINDS as readonly string[])).not.toContain('project');
    expect((NOTIFICATION_ANCHORED_KINDS as readonly string[])).not.toContain('note');
  });

  it('⚠ reminders default ON, unlike quiet hours — off would be a silent REMOVAL', () => {
    // The inverse of the quiet-hours default. These reminders are behaviour the
    // server already has for task/commitment, so shipping them off would delete
    // a feature on upgrade; quiet hours ships off because on would add one.
    for (const kind of NOTIFICATION_ANCHORED_KINDS) {
      expect(defaultNotificationKindPolicy(kind).enabled).toBe(true);
    }
  });

  it('⛔ a NEGATIVE offset is refused, not clamped — it is a different feature', () => {
    // "Tell me an hour AFTER it was due" is an escalation, and the sweep's
    // forward classification cannot express it. Clamping to zero would accept
    // the request and do something else.
    expect(isValidNotificationOffsetMs(-1)).toBe(false);
    expect(isValidNotificationOffsetMs(0)).toBe(true);
    expect(isValidNotificationOffsetMs(NOTIFICATION_KIND_MAX_OFFSET_MS)).toBe(true);
    // ⚠ Bounded above because the sweep calls everything inside the window
    // `due_soon`: a 10-year offset makes every future task permanently due-soon,
    // which reads as a broken feature rather than a setting.
    expect(isValidNotificationOffsetMs(NOTIFICATION_KIND_MAX_OFFSET_MS + 1)).toBe(false);
    expect(isValidNotificationOffsetMs(1.5)).toBe(false);
    expect(isValidNotificationOffsetMs('86400000')).toBe(false);
  });
});

describe('D-269 step 2 — the store', () => {
  const fresh = () => createNotificationKindPolicyStore(new Database(':memory:'));

  it('returns a policy for every kind before anything is written', () => {
    // ⚠ Unlike the timezone store, "unset" is NOT a state a caller must see:
    // every anchored kind HAS a policy the moment the feature exists, and the
    // row is only the owner's deviation. A caller made to remember the default
    // would be a second place the 24h window lives.
    const list = fresh().list();
    expect(list.map((p) => p.kind)).toEqual([...NOTIFICATION_ANCHORED_KINDS]);
    expect(list.every((p) => p.enabled)).toBe(true);
  });

  it('⚠ a patch merges over the EFFECTIVE value, not over a row that may not exist', () => {
    const store = fresh();
    store.write('task', { offset_ms: HOUR }, 10);
    // `enabled` was never written; it must come from the default, not undefined.
    expect(store.get('task')).toEqual({
      kind: 'task', enabled: true, offset_ms: HOUR, updated_at: 10,
    });
    store.write('task', { enabled: false }, 20);
    expect(store.get('task')).toEqual({
      kind: 'task', enabled: false, offset_ms: HOUR, updated_at: 20,
    });
  });

  it('one row per kind, however many writes', () => {
    const store = fresh();
    store.write('booking', { offset_ms: HOUR }, 10);
    store.write('booking', { offset_ms: 2 * HOUR }, 20);
    expect(store.list().filter((p) => p.kind === 'booking')).toHaveLength(1);
    expect(store.get('commitment').offset_ms).toBe(WORK_ENTITY_DUE_SOON_WINDOW_MS);
  });
});

describe('D-269 step 2 — offset_ms replaces the constant in the classifiers', () => {
  const task = (due_at: number): Pick<Task, 'due_at' | 'done'> => ({ due_at, done: false });

  it('🔑 a one-hour horizon calls a task due-soon one hour out, not a day', () => {
    const dueIn3h = task(NOW + 3 * HOUR);
    expect(classifyTaskDueWindow(dueIn3h, NOW)).toBe('due_soon');            // 24h default
    expect(classifyTaskDueWindow(dueIn3h, NOW, HOUR)).toBe('not_due');       // 1h horizon
    expect(classifyTaskDueWindow(task(NOW + 30 * 60 * 1000), NOW, HOUR)).toBe('due_soon');
  });

  it('⚠ the default argument preserves every existing caller', () => {
    // The classifiers are exported and called from `work-entity-ingredients`
    // and from tests that predate this. Omitting the offset must mean exactly
    // what it meant before.
    const c = { promised_for_at: NOW + 3 * HOUR } as Pick<Commitment, 'promised_for_at' | 'due_status'>;
    expect(classifyCommitmentDueStatus(c, NOW)).toBe('due_soon');
    expect(classifyCommitmentDueStatus(c, NOW, WORK_ENTITY_DUE_SOON_WINDOW_MS)).toBe('due_soon');
  });

  it('the overdue boundary is unaffected by the horizon — it is the anchor itself', () => {
    const past = task(NOW - 1);
    expect(classifyTaskDueWindow(past, NOW, 0)).toBe('overdue');
    expect(classifyTaskDueWindow(past, NOW, NOTIFICATION_KIND_MAX_OFFSET_MS)).toBe('overdue');
  });
});

describe('D-269 step 2 — ⛔⛔ enabled gates TELLING, never STATE', () => {
  /** ⚠ DRIVEN, NOT READ. The first version of these assertions checked WHERE the
   *  gate sits in the source — and a mutation that inserted a SECOND, earlier
   *  gate (`if (!enabled) continue;` before the classification, i.e. the exact
   *  data-corruption trap) passed all of them. A source-position assertion can
   *  see the line it names and is blind to a line added above it. So the sweep
   *  is run for real, with the policy off, against a real store. */
  const build = () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureWorkEntitySchema(db);
    const store = createWorkEntityStore(db);
    for (const kind of ['task', 'commitment'] as const) {
      store.registerSource({
        id: RECUED_BUILTIN_SOURCE_ID(kind),
        top_tier_kind: kind,
        source_kind: 'builtin',
        source_label: `Recued ${kind}`,
        write_capable: true,
        registered_at: NOW,
      });
    }
    return { db, store };
  };

  const overdueCommitment = (
    store: ReturnType<typeof createWorkEntityStore>,
    expiry_policy: Commitment['expiry_policy'],
  ): void => {
    store.writeCommitment({
      id: 'c-1',
      source_id: RECUED_BUILTIN_SOURCE_ID('commitment'),
      direction: 'outbound',
      statement: 'deliver report',
      derivation: 'user_declared',
      promised_for_at: NOW - 1,
      due_status: 'not_due',
      expiry_policy,
    }, NOW - 20_000);
  };

  it('⛔⛔ a DISABLED kind still advances due_status — the toggle is not a data change', () => {
    const { store } = build();
    overdueCommitment(store, 'escalate_overdue');
    const emitted: string[] = [];
    runDueStatusSweep({
      store,
      bus: { emit: (e: { event_kind: string }) => { emitted.push(e.event_kind); } } as never,
      policy: () => ({ enabled: false, offset_ms: WORK_ENTITY_DUE_SOON_WINDOW_MS }),
      now: () => NOW,
    });
    // The state moved...
    expect(store.readCommitment('c-1')?.due_status).toBe('overdue');
    // ...and the owner was not told.
    expect(emitted).toEqual([]);
  });

  it('⛔⛔ a DISABLED kind still EXPIRES a strict_expire commitment', () => {
    // The sharpest form of the trap: "don't remind me about deadlines" must not
    // become "commitments never expire". Lifecycle is not a notification.
    const { store } = build();
    overdueCommitment(store, 'strict_expire');
    runDueStatusSweep({
      store,
      policy: () => ({ enabled: false, offset_ms: WORK_ENTITY_DUE_SOON_WINDOW_MS }),
      now: () => NOW,
    });
    expect(store.readCommitment('c-1')?.lifecycle_state).toBe('expired');
  });

  it('an ENABLED kind emits, so the gate is doing something', () => {
    const { store } = build();
    overdueCommitment(store, 'escalate_overdue');
    const emitted: string[] = [];
    runDueStatusSweep({
      store,
      bus: { emit: (e: { event_kind: string }) => { emitted.push(e.event_kind); } } as never,
      policy: () => ({ enabled: true, offset_ms: WORK_ENTITY_DUE_SOON_WINDOW_MS }),
      now: () => NOW,
    });
    expect(emitted).toContain('overdue');
  });

  it('🔑 the task LEDGER advances while disabled — the toggle is not a queue', () => {
    // The ledger records what the task's state IS, not what was sent. If it
    // only moved on emission, re-enabling the kind would replay every crossing
    // that happened while it was off.
    const { store } = build();
    store.writeTask({
      id: 't-1',
      source_id: RECUED_BUILTIN_SOURCE_ID('task'),
      title: 'ship it',
      done: false,
      due_at: NOW - 1,
    }, NOW - 20_000);
    const ledger = createTaskEmissionLedger();
    const emitted: string[] = [];
    const bus = { emit: (e: { event_kind: string }) => { emitted.push(e.event_kind); } } as never;

    runDueStatusSweep({
      store, bus, taskEmissionLedger: ledger,
      policy: () => ({ enabled: false, offset_ms: WORK_ENTITY_DUE_SOON_WINDOW_MS }),
      now: () => NOW,
    });
    expect(emitted).toEqual([]);
    expect(ledger.get('t-1')).toBe('overdue');

    // Re-enabled: the crossing already happened and is NOT replayed.
    runDueStatusSweep({
      store, bus, taskEmissionLedger: ledger,
      policy: () => ({ enabled: true, offset_ms: WORK_ENTITY_DUE_SOON_WINDOW_MS }),
      now: () => NOW,
    });
    expect(emitted).toEqual([]);
  });

  it('🔑 the OFFSET reaches the sweep — a narrow horizon stops a far task firing', () => {
    const { store } = build();
    store.writeTask({
      id: 't-far',
      source_id: RECUED_BUILTIN_SOURCE_ID('task'),
      title: 'later',
      done: false,
      due_at: NOW + 3 * HOUR,
    }, NOW - 20_000);
    const emitted: string[] = [];
    const bus = { emit: (e: { event_kind: string }) => { emitted.push(e.event_kind); } } as never;

    runDueStatusSweep({
      store, bus, policy: () => ({ enabled: true, offset_ms: HOUR }), now: () => NOW,
    });
    expect(emitted).toEqual([]);

    runDueStatusSweep({
      store, bus, policy: () => ({ enabled: true, offset_ms: WORK_ENTITY_DUE_SOON_WINDOW_MS }),
      now: () => NOW,
    });
    expect(emitted).toEqual(['due_soon']);
  });
});

describe('D-269 step 2 — the back-transition the policy created', () => {
  /** ⛔⛔ THIS WAS ASSERTED BY GREPPING THE SWEEP FOR ITS OWN `if` CONDITION —
   *  a BEHAVIOUR claim proved by reading source. It would have survived the
   *  branch being made unreachable by anything above it, and reds on a rename
   *  that changes nothing. Driven now. */
  const HOUR = 60 * 60 * 1000;

  const build = () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureWorkEntitySchema(db);
    const store = createWorkEntityStore(db);
    store.registerSource({
      id: RECUED_BUILTIN_SOURCE_ID('commitment'), top_tier_kind: 'commitment',
      source_kind: 'builtin', source_label: 'Recued commitment',
      write_capable: true, registered_at: NOW,
    });
    return { store };
  };

  const commitmentDueIn = (
    store: ReturnType<typeof createWorkEntityStore>,
    ms: number,
  ): void => {
    store.writeCommitment({
      id: 'c-back', source_id: RECUED_BUILTIN_SOURCE_ID('commitment'),
      direction: 'outbound', statement: 'send the deck',
      derivation: 'user_declared', promised_for_at: NOW + ms,
      due_status: 'not_due', expiry_policy: 'escalate_overdue',
    }, NOW - 20_000);
  };

  it('⛔ narrowing the horizon takes a commitment back OUT of due_soon', () => {
    // Forward-only was correct while the window was a constant. With a setting,
    // an owner who narrows their horizon would otherwise leave every already-
    // due_soon row stuck there until it went overdue.
    const { store } = build();
    commitmentDueIn(store, 12 * HOUR);

    runDueStatusSweep({
      store, policy: () => ({ enabled: true, offset_ms: 24 * HOUR }), now: () => NOW,
    });
    expect(store.readCommitment('c-back')?.due_status).toBe('due_soon');

    // The owner narrows the horizon to two hours; the row is no longer near.
    runDueStatusSweep({
      store, policy: () => ({ enabled: true, offset_ms: 2 * HOUR }), now: () => NOW,
    });
    expect(store.readCommitment('c-back')?.due_status).toBe('not_due');
  });

  it('⚠ and a POLICY change can never produce due_soon for a past anchor', () => {
    // ⛔⛔ MY FIRST VERSION OF THIS WAS VACUOUS AND A MUTATION PROVED IT. It
    // widened the horizon over an overdue row and asserted the row stayed
    // overdue — which it does whatever the guard says, because the CLASSIFIER
    // never returns `due_soon` for a past anchor. So the test passed with the
    // `overdue → due_soon` guard removed, exactly as the old `not.toContain`
    // would have.
    //
    // 🔑 The checkable fact is the one that makes the guard unreachable from
    // policy at all: widening a window cannot un-miss a deadline. The way back
    // is the ANCHOR moving, which is a commitment update, not a setting.
    for (const offset of [HOUR, 24 * HOUR, 90 * 24 * HOUR]) {
      expect(classifyCommitmentDueStatus(
        { promised_for_at: NOW - 1, due_status: 'overdue' }, NOW, offset,
      )).toBe('overdue');
    }
    // …and once the anchor MOVES, the same classifier says due_soon again.
    expect(classifyCommitmentDueStatus(
      { promised_for_at: NOW + HOUR, due_status: 'overdue' }, NOW, 24 * HOUR,
    )).toBe('due_soon');
  });
});

describe('D-269 step 2 — the policy is SUPPLIED, not merely accepted', () => {
  const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8');

  it('⛔ the policy-store FORWARD survives; the reader itself is driven', () => {
    // Reading the policy's `enabled` from the wrong place left this green when
    // it grepped the composer — `d-269-reminder-composition-drive.test.ts` reds.
    expect(read('backend/server/src/serve/start-schedulers.ts'))
      .toContain('notificationKindPolicyStore');
  });

  it('⛔ the sweep still works with no policy at all — DRIVEN, not grepped', () => {
    // ⚠ This asserted the fallback by searching the SOURCE for its literal text,
    // which is the weak form: it passes against a second, earlier fallback added
    // above it, and it breaks on a reformat that changes nothing. Driven instead,
    // against a real store, with no `policy` supplied at all.
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureWorkEntitySchema(db);
    const store = createWorkEntityStore(db);
    store.registerSource({
      id: RECUED_BUILTIN_SOURCE_ID('task'), top_tier_kind: 'task', source_kind: 'builtin',
      source_label: 'Recued task', write_capable: true, registered_at: 1,
    });
    const now = Date.parse('2026-06-15T12:00:00Z');
    // Inside the SHARED 24h default, outside any shorter one.
    store.writeTask({
      id: 't-fallback', source_id: RECUED_BUILTIN_SOURCE_ID('task'),
      title: 'due in 20h', done: false, due_at: now + 20 * 60 * 60 * 1000,
    }, now - 1000);

    const events: string[] = [];
    runDueStatusSweep({
      store,
      taskEmissionLedger: createTaskEmissionLedger(),
      bus: { emit: (e: { event_kind: string }) => { events.push(e.event_kind); } } as never,
      now: () => now,
    });
    expect(events).toContain('due_soon');
  });
});

describe('D-269 step 2 — the handler', () => {
  it('refuses `project` with a message naming WHY, not just "unknown"', async () => {
    // A bare "unknown kind" reads as an oversight to fix. `project` has an
    // anchor and was ruled out on judgement, so the refusal has to say so or
    // the next reader will "fix" it.
    const { makeNotificationKindPolicyHandlers } = await import(
      '../notification-kind-policy-handler.js'
    );
    const slice = makeNotificationKindPolicyHandlers({
      store: createNotificationKindPolicyStore(new Database(':memory:')),
      now: () => NOW,
    })!;
    const client = { instance_id: 'inst' } as never;
    await expect(
      slice.handlers['notification.kind_policy.set']({ kind: 'project', enabled: false } as never, client),
    ).rejects.toThrow(/project has a deadline but deliberately carries no reminder policy/);
  });
});
