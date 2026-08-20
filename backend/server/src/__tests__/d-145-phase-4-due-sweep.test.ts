/** D-145 PA4 — Due-status sweep tests.
 *
 *  Per § Phase PA4 + § A.1.3 — periodic deadline-crossing sweep that
 *  drives `task_due_soon` / `task_overdue` / `commitment_due_soon` /
 *  `commitment_overdue` events + flips `strict_expire` commitments to
 *  `lifecycle: expired`. Tests exercise the sweep against a fixture
 *  store + a stubbed bus + cascade so every transition path stays
 *  observable. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RECUED_BUILTIN_SOURCE_ID,
  WORK_ENTITY_DUE_SOON_WINDOW_MS,
  WORK_ENTITY_KINDS,
} from '@recued/contracts';
import {
  createWarehouseEventBus,
  type WarehouseEvent,
  type WarehouseEventBus,
} from '@recued/warehouse-events';

import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import {
  classifyCommitmentDueStatus,
  classifyTaskDueWindow,
  createTaskEmissionLedger,
  runDueStatusSweep,
} from '../work-entity-due-status-sweep.js';
import type { CascadeEngine } from '../storage/enrichment-cascade.js';

let dir: string;
let db: Database.Database;
let store: WorkEntityStore;
let bus: WarehouseEventBus;
let events: WarehouseEvent[];
let cascadeCalls: Array<{ method: string; scope: string; id: string }>;
let cascade: CascadeEngine;

const NOW = 1_700_000_000_000;

const registerBuiltins = (s: WorkEntityStore): void => {
  for (const kind of WORK_ENTITY_KINDS) {
    s.registerSource({
      id: RECUED_BUILTIN_SOURCE_ID(kind),
      top_tier_kind: kind,
      source_kind: 'builtin',
      source_label: 'Recued built-in',
      write_capable: true,
      registered_at: NOW,
    });
  }
};

const emptyResult = (): ReturnType<CascadeEngine['cascadeForSourceUpdate']> => ({
  rows_deleted: 0,
  rows_marked_stale: 0,
  members_trimmed: 0,
  members_emptied_deleted: 0,
  rows_lifecycle_action_enqueued: 0,
  rows_tombstoned: 0,
  rows_rate_limited: 0,
  rows_queue_depth_capped: 0,
});

const buildSpyCascade = (): CascadeEngine => ({
  cascadeForSourceDelete(scope, id) {
    cascadeCalls.push({ method: 'cascadeForSourceDelete', scope, id });
    return emptyResult();
  },
  cascadeForSourceUpdate(scope, id) {
    cascadeCalls.push({ method: 'cascadeForSourceUpdate', scope, id });
    return emptyResult();
  },
  cascadeForRecipeUpgrade() { return emptyResult(); },
  cascadeForProducerUpgrade() { return emptyResult(); },
  cascadeForUpstreamEnrichment() { return emptyResult(); },
  cascadeForIdentityChange() { return emptyResult(); },
  cascadeForConnectionDelete() { return emptyResult(); },
  cascadeForExternalContextPulseChange() { return emptyResult(); },
  cascadeForEngagementEvent() { return emptyResult(); },
  reserveTopicRecomputeAdmission() { return { admitted: true, candidates: 0, dropped: 0 }; },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd145-pa4-due-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureWorkEntitySchema(db);
  store = createWorkEntityStore(db);
  registerBuiltins(store);
  bus = createWarehouseEventBus();
  events = [];
  bus.subscribe('**', (ev) => {
    events.push(ev);
  });
  cascadeCalls = [];
  cascade = buildSpyCascade();
});

afterEach(() => {
  bus.dispose();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const findEvents = (path: string): WarehouseEvent[] =>
  events.filter(
    (e) => `data.${e.platform}.${e.slug}.${e.entity_type}.${e.event_kind}` === path,
  );

// ────────────────────────────────────────────────────────────────
// Pure classifier helpers
// ────────────────────────────────────────────────────────────────

describe('classifyCommitmentDueStatus', () => {
  it('returns no_deadline when promised_for_at is undefined', () => {
    expect(
      classifyCommitmentDueStatus({ due_status: 'not_due' }, NOW),
    ).toBe('no_deadline');
  });

  it('returns not_due when more than 24h before deadline', () => {
    expect(
      classifyCommitmentDueStatus(
        {
          promised_for_at: NOW + WORK_ENTITY_DUE_SOON_WINDOW_MS + 1000,
          due_status: 'not_due',
        },
        NOW,
      ),
    ).toBe('not_due');
  });

  it('returns due_soon when within 24h before deadline', () => {
    expect(
      classifyCommitmentDueStatus(
        {
          promised_for_at: NOW + WORK_ENTITY_DUE_SOON_WINDOW_MS - 1,
          due_status: 'not_due',
        },
        NOW,
      ),
    ).toBe('due_soon');
  });

  it('returns overdue at-or-after the deadline', () => {
    expect(
      classifyCommitmentDueStatus(
        { promised_for_at: NOW, due_status: 'not_due' },
        NOW,
      ),
    ).toBe('overdue');
    expect(
      classifyCommitmentDueStatus(
        { promised_for_at: NOW - 1, due_status: 'not_due' },
        NOW,
      ),
    ).toBe('overdue');
  });
});

describe('classifyTaskDueWindow', () => {
  it('returns no_deadline when done', () => {
    expect(classifyTaskDueWindow({ due_at: NOW - 1000, done: true }, NOW)).toBe('no_deadline');
  });

  it('returns no_deadline when due_at is undefined', () => {
    expect(classifyTaskDueWindow({ done: false }, NOW)).toBe('no_deadline');
  });

  it('classifies the same forward windows as commitments', () => {
    expect(
      classifyTaskDueWindow(
        { due_at: NOW + WORK_ENTITY_DUE_SOON_WINDOW_MS + 1000, done: false },
        NOW,
      ),
    ).toBe('not_due');
    expect(
      classifyTaskDueWindow(
        { due_at: NOW + WORK_ENTITY_DUE_SOON_WINDOW_MS - 1, done: false },
        NOW,
      ),
    ).toBe('due_soon');
    expect(classifyTaskDueWindow({ due_at: NOW, done: false }, NOW)).toBe('overdue');
  });
});

// ────────────────────────────────────────────────────────────────
// Sweep — task path
// ────────────────────────────────────────────────────────────────

describe('runDueStatusSweep — task path', () => {
  it('emits task_due_soon for pending tasks with due_at in the next 24h', () => {
    const dueAt = NOW + WORK_ENTITY_DUE_SOON_WINDOW_MS - 1000;
    store.writeTask(
      { source_id: RECUED_BUILTIN_SOURCE_ID('task'), title: 't', due_at: dueAt },
      NOW - 1000,
    );
    runDueStatusSweep({ store, bus, cascade, now: () => NOW });
    expect(findEvents('data.work.task.item.due_soon')).toHaveLength(1);
    expect(findEvents('data.work.task.item.overdue')).toHaveLength(0);
  });

  it('emits task_overdue for pending tasks past due_at', () => {
    const dueAt = NOW - 1000;
    store.writeTask(
      { source_id: RECUED_BUILTIN_SOURCE_ID('task'), title: 't', due_at: dueAt },
      NOW - 100_000,
    );
    runDueStatusSweep({ store, bus, cascade, now: () => NOW });
    expect(findEvents('data.work.task.item.overdue')).toHaveLength(1);
    expect(findEvents('data.work.task.item.due_soon')).toHaveLength(0);
  });

  it('skips done tasks (no event)', () => {
    store.writeTask(
      {
        source_id: RECUED_BUILTIN_SOURCE_ID('task'),
        title: 't',
        due_at: NOW - 1000,
        done: true,
        completed_at: NOW - 500,
      },
      NOW - 100_000,
    );
    const result = runDueStatusSweep({ store, bus, cascade, now: () => NOW });
    expect(result.tasks_visited).toBe(0);
    expect(events).toHaveLength(0);
  });

  it('skips tasks without due_at', () => {
    store.writeTask({ source_id: RECUED_BUILTIN_SOURCE_ID('task'), title: 't' }, NOW);
    const result = runDueStatusSweep({ store, bus, cascade, now: () => NOW });
    expect(result.tasks_visited).toBe(0);
  });

  it('skips tombstoned tasks (sync_state filter excludes tombstoned by default)', () => {
    store.writeTask(
      {
        source_id: RECUED_BUILTIN_SOURCE_ID('task'),
        title: 't',
        due_at: NOW - 1000,
        sync_state: 'tombstoned',
      },
      NOW - 1000,
    );
    const result = runDueStatusSweep({ store, bus, cascade, now: () => NOW });
    expect(result.tasks_visited).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Sweep — commitment path
// ────────────────────────────────────────────────────────────────

describe('runDueStatusSweep — commitment path', () => {
  const baseInput = {
    direction: 'inbound' as const,
    statement: 'Bob to deliver',
    derivation: 'user_declared' as const,
    source_id: RECUED_BUILTIN_SOURCE_ID('commitment'),
  };

  it('flips not_due → due_soon when within 24h of deadline + emits commitment_due_soon', () => {
    const promised = NOW + WORK_ENTITY_DUE_SOON_WINDOW_MS - 1000;
    const created = store.writeCommitment(
      { ...baseInput, promised_for_at: promised },
      NOW - 100_000,
    );
    const result = runDueStatusSweep({ store, bus, cascade, now: () => NOW });
    const reread = store.readCommitment(created.id);
    expect(reread?.due_status).toBe('due_soon');
    expect(reread?.due_status_changed_at).toBe(NOW);
    expect(reread?.lifecycle_state).toBe('pending');
    expect(findEvents('data.work.commitment.item.due_soon')).toHaveLength(1);
    expect(result.commitment_due_soon_emitted).toBe(1);
    expect(result.commitments_due_status_updated).toBe(1);
  });

  it('flips not_due → overdue when past deadline (escalate_overdue keeps lifecycle: pending)', () => {
    const promised = NOW - 1000;
    const created = store.writeCommitment(
      { ...baseInput, promised_for_at: promised, expiry_policy: 'escalate_overdue' },
      NOW - 100_000,
    );
    runDueStatusSweep({ store, bus, cascade, now: () => NOW });
    const reread = store.readCommitment(created.id);
    expect(reread?.due_status).toBe('overdue');
    expect(reread?.lifecycle_state).toBe('pending');
    expect(findEvents('data.work.commitment.item.overdue')).toHaveLength(1);
    expect(findEvents('data.work.commitment.item.state_changed')).toHaveLength(0);
  });

  it('flips lifecycle: pending → expired under strict_expire on overdue + emits state_changed', () => {
    const promised = NOW - 1000;
    const created = store.writeCommitment(
      { ...baseInput, promised_for_at: promised, expiry_policy: 'strict_expire' },
      NOW - 100_000,
    );
    const result = runDueStatusSweep({ store, bus, cascade, now: () => NOW });
    const reread = store.readCommitment(created.id);
    expect(reread?.due_status).toBe('overdue');
    expect(reread?.lifecycle_state).toBe('expired');
    expect(findEvents('data.work.commitment.item.overdue')).toHaveLength(1);
    expect(findEvents('data.work.commitment.item.state_changed')).toHaveLength(1);
    expect(result.commitments_expired).toBe(1);
  });

  it('advances due_status under indefinite policy but keeps lifecycle pending (Codex P1 fold)', () => {
    // Per spec § A.1.3 transition table: due_status: due_soon →
    // overdue fires for any pending commitment regardless of policy;
    // only the LIFECYCLE pending → expired transition is gated on
    // strict_expire. The dispatcher comment used to say indefinite
    // "skips" — that was a doc-vs-code mismatch. The fold updates
    // the comment to match the spec-correct behavior tested here.
    const promised = NOW - 1000;
    store.writeCommitment(
      { ...baseInput, promised_for_at: promised, expiry_policy: 'indefinite' },
      NOW - 100_000,
    );
    const result = runDueStatusSweep({ store, bus, cascade, now: () => NOW });
    expect(result.commitment_overdue_emitted).toBe(1);
    expect(result.commitments_expired).toBe(0);
    const stored = store.findCommitment(() => true);
    expect(stored?.lifecycle_state).toBe('pending');
    expect(stored?.due_status).toBe('overdue');
    // No state_changed event for indefinite (lifecycle stayed pending).
    expect(findEvents('data.work.commitment.item.state_changed')).toHaveLength(0);
  });

  it('flips due_soon → overdue on a second sweep after the deadline', () => {
    const promised = NOW + 5_000;
    store.writeCommitment(
      { ...baseInput, promised_for_at: promised, due_status: 'due_soon' },
      NOW - 100_000,
    );
    runDueStatusSweep({ store, bus, cascade, now: () => NOW + 10_000 });
    expect(findEvents('data.work.commitment.item.overdue')).toHaveLength(1);
  });

  it('is idempotent on the steady-state set — re-firing on rows already at target due_status is a no-op', () => {
    const promised = NOW - 1000;
    store.writeCommitment(
      {
        ...baseInput,
        promised_for_at: promised,
        due_status: 'overdue',
        due_status_changed_at: NOW - 1000,
      },
      NOW - 1000,
    );
    const result = runDueStatusSweep({ store, bus, cascade, now: () => NOW });
    expect(result.commitments_due_status_updated).toBe(0);
    expect(events).toHaveLength(0);
  });

  it('skips fulfilled / cancelled / expired commitments (lifecycle filter)', () => {
    const promised = NOW - 1000;
    for (const lifecycle_state of ['fulfilled', 'cancelled', 'expired'] as const) {
      store.writeCommitment(
        {
          ...baseInput,
          statement: `s-${lifecycle_state}`,
          promised_for_at: promised,
          lifecycle_state,
        },
        NOW - 1000,
      );
    }
    const result = runDueStatusSweep({ store, bus, cascade, now: () => NOW });
    expect(result.commitments_visited).toBe(0);
  });

  it('does NOT back-transition overdue → due_soon when promised_for_at moves forward', () => {
    // Back-transitions are dispatcher-driven (`commitment-update`),
    // not sweep-driven. The sweep only emits forward edges so a
    // legitimate back-transition coming through the dispatcher path
    // doesn't get fought by the sweep on the next cycle.
    const promised = NOW + WORK_ENTITY_DUE_SOON_WINDOW_MS - 1000;
    store.writeCommitment(
      {
        ...baseInput,
        promised_for_at: promised,
        due_status: 'overdue',
        due_status_changed_at: NOW - 1000,
      },
      NOW - 1000,
    );
    const result = runDueStatusSweep({ store, bus, cascade, now: () => NOW });
    expect(result.commitments_due_status_updated).toBe(0);
    expect(events).toHaveLength(0);
  });

  it('fires cascade.cascadeForSourceUpdate(commitment, id) on every transitioned row', () => {
    const promised = NOW - 1000;
    const created = store.writeCommitment(
      { ...baseInput, promised_for_at: promised },
      NOW - 100_000,
    );
    runDueStatusSweep({ store, bus, cascade, now: () => NOW });
    expect(cascadeCalls).toEqual([
      { method: 'cascadeForSourceUpdate', scope: 'commitment', id: created.id },
    ]);
  });

  it('payload carries the canonical commitment record + prior under prev', () => {
    const promised = NOW - 1000;
    const created = store.writeCommitment(
      { ...baseInput, promised_for_at: promised },
      NOW - 100_000,
    );
    runDueStatusSweep({ store, bus, cascade, now: () => NOW });
    const fired = findEvents('data.work.commitment.item.overdue');
    const prev = fired[0]!.prev as Record<string, unknown>;
    expect((prev.record as Record<string, unknown>).id).toBe(created.id);
    expect((prev.record as Record<string, unknown>).due_status).toBe('overdue');
    expect((prev.prior as Record<string, unknown>).due_status).toBe('not_due');
  });
});

// ────────────────────────────────────────────────────────────────
// Sweep — bus + cascade plumbing edge cases
// ────────────────────────────────────────────────────────────────

describe('runDueStatusSweep — plumbing', () => {
  it('runs successfully without bus + cascade', () => {
    store.writeCommitment(
      {
        direction: 'inbound',
        statement: 's',
        derivation: 'user_declared',
        source_id: RECUED_BUILTIN_SOURCE_ID('commitment'),
        promised_for_at: NOW - 1000,
      },
      NOW - 100_000,
    );
    const result = runDueStatusSweep({ store, now: () => NOW });
    expect(result.commitments_due_status_updated).toBe(1);
  });

  it('does not abort when the bus throws', () => {
    const angryBus: WarehouseEventBus = {
      emit() { throw new Error('down'); },
      subscribe() { return () => {}; },
      dispose() {},
    };
    store.writeCommitment(
      {
        direction: 'inbound',
        statement: 's',
        derivation: 'user_declared',
        source_id: RECUED_BUILTIN_SOURCE_ID('commitment'),
        promised_for_at: NOW - 1000,
      },
      NOW - 100_000,
    );
    expect(() =>
      runDueStatusSweep({ store, bus: angryBus, now: () => NOW }),
    ).not.toThrow();
  });

  it('does not abort when the cascade throws', () => {
    const angryCascade: CascadeEngine = {
      ...buildSpyCascade(),
      cascadeForSourceUpdate() {
        throw new Error('cascade down');
      },
    };
    store.writeCommitment(
      {
        direction: 'inbound',
        statement: 's',
        derivation: 'user_declared',
        source_id: RECUED_BUILTIN_SOURCE_ID('commitment'),
        promised_for_at: NOW - 1000,
      },
      NOW - 100_000,
    );
    expect(() =>
      runDueStatusSweep({ store, bus, cascade: angryCascade, now: () => NOW }),
    ).not.toThrow();
  });

  it('paginates beyond 1000 rows (Codex P1 fold)', () => {
    // Insert 1500 pending overdue tasks. Without pagination the
    // sweep would only visit the first 1000; with the fold all
    // 1500 emit `task.item.overdue`.
    for (let i = 0; i < 1500; i++) {
      store.writeTask(
        {
          source_id: RECUED_BUILTIN_SOURCE_ID('task'),
          title: `t-${i}`,
          due_at: NOW - 1000,
        },
        NOW - 100_000,
      );
    }
    const result = runDueStatusSweep({ store, bus, cascade, now: () => NOW });
    expect(result.tasks_visited).toBe(1500);
    expect(result.task_overdue_emitted).toBe(1500);
  });
});

describe('runDueStatusSweep — task emission ledger (Codex P1 fold)', () => {
  it('without ledger: re-emits on every sweep for the same task (pre-fold behavior)', () => {
    store.writeTask(
      {
        source_id: RECUED_BUILTIN_SOURCE_ID('task'),
        title: 't',
        due_at: NOW - 1000,
      },
      NOW - 100_000,
    );
    runDueStatusSweep({ store, bus, cascade, now: () => NOW });
    runDueStatusSweep({ store, bus, cascade, now: () => NOW });
    runDueStatusSweep({ store, bus, cascade, now: () => NOW });
    expect(findEvents('data.work.task.item.overdue')).toHaveLength(3);
  });

  it('with ledger: emits once per task per classified state across cycles', () => {
    const ledger = createTaskEmissionLedger();
    store.writeTask(
      {
        source_id: RECUED_BUILTIN_SOURCE_ID('task'),
        title: 't',
        due_at: NOW - 1000,
      },
      NOW - 100_000,
    );
    runDueStatusSweep({
      store, bus, cascade, taskEmissionLedger: ledger, now: () => NOW,
    });
    runDueStatusSweep({
      store, bus, cascade, taskEmissionLedger: ledger, now: () => NOW,
    });
    runDueStatusSweep({
      store, bus, cascade, taskEmissionLedger: ledger, now: () => NOW,
    });
    expect(findEvents('data.work.task.item.overdue')).toHaveLength(1);
    expect(ledger.size()).toBe(1);
  });

  it('ledger lets a task transition due_soon → overdue across cycles (one fire per state)', () => {
    const ledger = createTaskEmissionLedger();
    const dueAt = NOW + WORK_ENTITY_DUE_SOON_WINDOW_MS - 10_000;
    const task = store.writeTask(
      { source_id: RECUED_BUILTIN_SOURCE_ID('task'), title: 't', due_at: dueAt },
      NOW - 100_000,
    );
    // First sweep — emits due_soon.
    runDueStatusSweep({
      store, bus, cascade, taskEmissionLedger: ledger, now: () => NOW,
    });
    expect(findEvents('data.work.task.item.due_soon')).toHaveLength(1);
    expect(findEvents('data.work.task.item.overdue')).toHaveLength(0);

    // Second sweep AFTER the deadline — emits overdue, no second
    // due_soon (ledger remembers the prior emission).
    events.length = 0;
    runDueStatusSweep({
      store, bus, cascade, taskEmissionLedger: ledger, now: () => dueAt + 1000,
    });
    expect(findEvents('data.work.task.item.due_soon')).toHaveLength(0);
    expect(findEvents('data.work.task.item.overdue')).toHaveLength(1);
    expect(ledger.get(task.id)).toBe('overdue');
  });

  it('ledger entry clears when the task transitions back into not_due', () => {
    const ledger = createTaskEmissionLedger();
    const written = store.writeTask(
      {
        source_id: RECUED_BUILTIN_SOURCE_ID('task'),
        title: 't',
        due_at: NOW - 1000,
      },
      NOW - 100_000,
    );
    runDueStatusSweep({
      store, bus, cascade, taskEmissionLedger: ledger, now: () => NOW,
    });
    expect(ledger.get(written.id)).toBe('overdue');

    // Reschedule far forward — sweep runs at clock that puts the
    // task back into `not_due`. Ledger entry should clear so a
    // subsequent forward crossing fires again.
    store.writeTask(
      {
        id: written.id,
        title: written.title,
        source_id: written.source_id,
        created_at: written.created_at,
        due_at: NOW + 30 * WORK_ENTITY_DUE_SOON_WINDOW_MS,
        sync_state: written.sync_state,
        conflict_policy: written.conflict_policy,
        blocks_task_ids: written.blocks_task_ids,
        done: written.done,
      },
      NOW + 1,
    );
    events.length = 0;
    runDueStatusSweep({
      store, bus, cascade, taskEmissionLedger: ledger, now: () => NOW,
    });
    expect(ledger.get(written.id)).toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it('ledger entry clears when the task is marked done', () => {
    const ledger = createTaskEmissionLedger();
    const written = store.writeTask(
      {
        source_id: RECUED_BUILTIN_SOURCE_ID('task'),
        title: 't',
        due_at: NOW - 1000,
      },
      NOW - 100_000,
    );
    runDueStatusSweep({
      store, bus, cascade, taskEmissionLedger: ledger, now: () => NOW,
    });
    expect(ledger.get(written.id)).toBe('overdue');
    // Flip done — sweep on next cycle drops the ledger entry.
    store.writeTask(
      {
        id: written.id,
        title: written.title,
        source_id: written.source_id,
        created_at: written.created_at,
        due_at: written.due_at,
        sync_state: written.sync_state,
        conflict_policy: written.conflict_policy,
        blocks_task_ids: written.blocks_task_ids,
        done: true,
        completed_at: NOW + 1,
      },
      NOW + 1,
    );
    runDueStatusSweep({
      store, bus, cascade, taskEmissionLedger: ledger, now: () => NOW + 2,
    });
    expect(ledger.get(written.id)).toBeUndefined();
  });
});

describe('runDueStatusSweep — counters', () => {
  it('result counters reflect distinct task + commitment paths', () => {
    store.writeTask(
      {
        source_id: RECUED_BUILTIN_SOURCE_ID('task'),
        title: 't1',
        due_at: NOW - 1000,
      },
      NOW - 100_000,
    );
    store.writeTask(
      {
        source_id: RECUED_BUILTIN_SOURCE_ID('task'),
        title: 't2',
        due_at: NOW + WORK_ENTITY_DUE_SOON_WINDOW_MS - 1000,
      },
      NOW - 100_000,
    );
    store.writeCommitment(
      {
        direction: 'inbound',
        statement: 'c1',
        derivation: 'user_declared',
        source_id: RECUED_BUILTIN_SOURCE_ID('commitment'),
        promised_for_at: NOW - 1000,
      },
      NOW - 100_000,
    );
    store.writeCommitment(
      {
        direction: 'inbound',
        statement: 'c2',
        derivation: 'user_declared',
        source_id: RECUED_BUILTIN_SOURCE_ID('commitment'),
        promised_for_at: NOW + WORK_ENTITY_DUE_SOON_WINDOW_MS - 1000,
      },
      NOW - 100_000,
    );
    const result = runDueStatusSweep({ store, bus, cascade, now: () => NOW });
    expect(result.tasks_visited).toBe(2);
    expect(result.task_due_soon_emitted).toBe(1);
    expect(result.task_overdue_emitted).toBe(1);
    expect(result.commitments_visited).toBe(2);
    expect(result.commitment_due_soon_emitted).toBe(1);
    expect(result.commitment_overdue_emitted).toBe(1);
    expect(result.commitments_due_status_updated).toBe(2);
  });
});
