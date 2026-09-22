/** D-269 — the reminder sweep as the COMPOSITION ROOT actually builds it.
 *
 *  ⛔⛔⛔ WRITTEN BECAUSE AN AUDIT MUTATION PASSED. Rewiring
 *  `listTasks: () => workEntityStore.listTasks(...)` to `() => []`, and making
 *  the quiet-hours `isQuiet` never suppress, BOTH left the entire suite green.
 *  Every existing test drives `runReminderSweep` with injected fakes, and
 *  `wire-housekeeping-substrate.test.ts` MOCKS the task builders — so it proves
 *  the composer CALLS the builder and nothing proves WHAT IT PASSES.
 *
 *  ⇒ The gap is not in the sweep and not in the panel: it is in the join, which
 *  is the fifth time this arc has produced exactly that shape (an unmounted
 *  panel, a receiverless emitter, an unbundled stylesheet, an unpassed caller).
 *  **A dependency supplied by the composition root is only proved by running the
 *  composition root.**
 *
 *  So this file composes for real — real sqlite, real work-entity store, real
 *  policy/quiet-hours/timezone stores, no builder mocks — then reaches into the
 *  registry for the task that actually registered and RUNS it. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { RECUED_BUILTIN_SOURCE_ID } from '@recued/contracts';
import {
  composeHousekeepingScheduler,
  composeHousekeepingStores,
} from '../composition/bin/wire-housekeeping-substrate.js';
import {
  clearDefaultHousekeepingRegistry,
  getHousekeepingTask,
} from '../housekeeping/registry.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createNotificationKindPolicyStore } from '../storage/notification-kind-policy-store.js';
import { createQuietHoursStore } from '../storage/quiet-hours-store.js';
import { createServerTimeZoneStore } from '../storage/server-timezone-store.js';

const TASK_ID = 'work-entity-reminder-sweep';
const DUE_TASK_ID = 'work-entity-due-status-sweep';
const NOW = Date.parse('2026-06-15T12:00:00Z');
const HOUR = 60 * 60 * 1000;

// ⚠ The registry is a module-level singleton and the composer registers a dozen
// tasks, not just this one — so the whole thing resets, or the second compose
// throws "already registered" and the test reads as a code failure.
beforeEach(clearDefaultHousekeepingRegistry);
afterEach(clearDefaultHousekeepingRegistry);

/** Compose the real substrate over a real db, with one task due inside the
 *  horizon, and hand back the notify sink the composer wired. */
const compose = async (over: { quiet?: { from: number; to: number }; zone?: string } = {}) => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  ensureWorkEntitySchema(db);
  const workEntityStore = createWorkEntityStore(db);
  workEntityStore.registerSource({
    id: RECUED_BUILTIN_SOURCE_ID('task'), top_tier_kind: 'task', source_kind: 'builtin',
    source_label: 'Recued task', write_capable: true, registered_at: NOW - HOUR,
  });
  workEntityStore.writeTask({
    id: 't-compose', source_id: RECUED_BUILTIN_SOURCE_ID('task'),
    title: 'renew the domain', done: false, due_at: NOW + 6 * HOUR,
  }, NOW - HOUR);

  const notificationKindPolicyStore = createNotificationKindPolicyStore(db);
  const quietHoursStore = createQuietHoursStore(db);
  const serverTimeZoneStore = createServerTimeZoneStore(db);
  // ⚠ A DECLARED zone, not `follows_host`: the window is a wall clock and the
  // composition only wires `isQuiet` when the zone resolves.
  serverTimeZoneStore.write('fixed', over.zone ?? 'UTC', NOW);
  if (over.quiet) {
    quietHoursStore.write({
      enabled: true, from_minute: over.quiet.from, to_minute: over.quiet.to,
      applies_to: ['notification'],
    }, NOW);
  }

  const sent: Array<{ title: string; text: string }> = [];
  const cards: unknown[] = [];
  await composeHousekeepingScheduler({
    db,
    stores: composeHousekeepingStores({ db }),
    enrichmentProducers: new Map(),
    // ⚠ Everything the reminder path does NOT touch is a placeholder — the point
    // of this file is the REAL wiring of the four stores above, not a second
    // copy of the composer's whole dependency surface.
    enrichmentStore: {}, recipeStore: {}, collectionRegistry: {}, cacheBlobs: {},
    eventBus: { emit: () => {} }, warehouseBus: { emit: () => {} },
    auditLog: undefined,
    now: () => NOW,
    llmCallables: {
      llm: () => {}, llmWithMeta: () => {},
      embed: () => {}, probeAiPath: () => {},
    },
    workEntityStore,
    notificationKindPolicyStore,
    quietHoursStore,
    serverTimeZoneStore,
    notifyReminder: (m: { title: string; text: string }) => { sent.push(m); },
    onQuietHoursReleased: (d: unknown) => { cards.push(d); },
  } as never);

  return {
    sent, cards,
    task: getHousekeepingTask(TASK_ID),
    dueTask: getHousekeepingTask(DUE_TASK_ID),
  };
};

const runTask = async (
  task: ReturnType<typeof getHousekeepingTask>,
  at: number = NOW,
): Promise<void> => {
  expect(task).toBeDefined();
  await task!.step({ now: () => at } as never, { kind: 'start' } as never, 1000);
};

describe('D-269 — the composition root wires the reminder sweep to REAL rows', () => {
  it('⛔⛔ a task in the store reaches the notify sink the composer supplied', async () => {
    // The assertion an audit mutation defeated: `listTasks: () => []` left every
    // other test green while the owner would have been told nothing.
    const { sent, task } = await compose();
    await runTask(task);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toBe('Task due soon');
    expect(sent[0]!.text).toContain('renew the domain');
  });

  it('⛔⛔ and an armed window HOLDS it — quiet hours is wired, not merely present', async () => {
    // The second mutation that passed: making `isQuiet` never suppress. Quiet
    // hours would have been inert at the only place it runs.
    const { sent, task } = await compose({ quiet: { from: 0, to: 23 * 60 + 59 } });
    await runTask(task);
    expect(sent).toEqual([]);
  });

  it('⚠ and with the window OUTSIDE the moment, it delivers again', async () => {
    // Pins that the hold above came from the CLOCK and not from the window
    // merely existing — otherwise arming anything would look like it worked.
    const { sent, task } = await compose({ quiet: { from: 13 * 60, to: 14 * 60 } });
    await runTask(task);
    expect(sent).toHaveLength(1);
  });
});


describe('D-269 — the release card and the per-item reminder share ONE ledger', () => {
  /** ⛔⛔ ALSO WRITTEN BECAUSE A MUTATION PASSED. Deleting the line that hands the
   *  due-status sweep the SAME ledger the reminder sweep marks left 111 tests
   *  green — and the owner would be told twice at every release edge: once by
   *  the card, once by the reminder it summarised. The exclusivity is a property
   *  of the WIRING, so only the wiring can prove it. */
  it('⛔⛔ the card claims the row, so the reminder that follows stays silent', async () => {
    // ⚠ A window that CONTAINS 12:00 and ENDS before 18:00. A whole-day window
    // never releases, so the edge never fires and the test reads 0 tellings —
    // which is the fixture being wrong, not the behaviour.
    const ctx = await compose({ quiet: { from: 10 * 60, to: 14 * 60 } });
    await runTask(ctx.dueTask, NOW);            // inside ⇒ marks the window active
    expect(ctx.cards).toHaveLength(0);
    expect(ctx.sent).toEqual([]);

    // …and the next one is a day later, with the window no longer active at that
    // instant only because we step outside it.
    const release = NOW + 6 * HOUR;
    await runTask(ctx.dueTask, release);
    await runTask(ctx.task, release);

    // ⚠ Exactly one telling between the two surfaces, whichever spoke.
    expect(ctx.cards.length + ctx.sent.length).toBe(1);
  });
});
