/** D-145 PA4 — Reactive trigger emission tests.
 *
 *  Per § Phase PA4 acceptance — every PA3 dispatcher fires the right
 *  warehouse-bus events on the right paths with the right payload
 *  shape, and the D-136 cascade engine sees the right primitive call
 *  on every successful update / delete. Tests exercise the dispatcher
 *  composer with a stubbed bus + cascade so the emit + cascade paths
 *  stay observable even when production wires the real implementations
 *  via bin.ts. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RECUED_BUILTIN_SOURCE_ID,
  WORK_ENTITY_BUS_ENTITY_TYPE,
  WORK_ENTITY_BUS_PLATFORM,
  WORK_ENTITY_DERIVED_EVENT_KINDS,
  WORK_ENTITY_DUE_SOON_WINDOW_MS,
  WORK_ENTITY_KINDS,
  composeWorkEntityBusPath,
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
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import {
  createWorkEntityDispatchers,
} from '../work-entity-ingredients.js';
import type { CascadeEngine } from '../storage/enrichment-cascade.js';

let dir: string;
let db: Database.Database;
let store: WorkEntityStore;
let bus: WarehouseEventBus;
let events: WarehouseEvent[];
let cascadeCalls: Array<{ method: string; scope: string; id: string }>;
let cascade: CascadeEngine;
let dispatchers: ReturnType<typeof createWorkEntityDispatchers>;

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

const emptyCascadeResult = (): ReturnType<CascadeEngine['cascadeForSourceUpdate']> => ({
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
    return emptyCascadeResult();
  },
  cascadeForSourceUpdate(scope, id) {
    cascadeCalls.push({ method: 'cascadeForSourceUpdate', scope, id });
    return emptyCascadeResult();
  },
  cascadeForRecipeUpgrade(recipe_id) {
    cascadeCalls.push({ method: 'cascadeForRecipeUpgrade', scope: '', id: recipe_id });
    return emptyCascadeResult();
  },
  cascadeForProducerUpgrade(_pk, pn, _hash) {
    cascadeCalls.push({ method: 'cascadeForProducerUpgrade', scope: '', id: pn });
    return emptyCascadeResult();
  },
  cascadeForUpstreamEnrichment(upstream_row_id) {
    cascadeCalls.push({ method: 'cascadeForUpstreamEnrichment', scope: '', id: upstream_row_id });
    return emptyCascadeResult();
  },
  cascadeForIdentityChange(scope, source_id, _identity_keys) {
    cascadeCalls.push({ method: 'cascadeForIdentityChange', scope, id: source_id });
    return emptyCascadeResult();
  },
  cascadeForConnectionDelete(_kind, name) {
    cascadeCalls.push({ method: 'cascadeForConnectionDelete', scope: '', id: name });
    return emptyCascadeResult();
  },
  cascadeForExternalContextPulseChange(context_id) {
    cascadeCalls.push({
      method: 'cascadeForExternalContextPulseChange',
      scope: '',
      id: context_id,
    });
    return emptyCascadeResult();
  },
  cascadeForEngagementEvent(scope, target_id, _connection_id) {
    cascadeCalls.push({ method: 'cascadeForEngagementEvent', scope, id: target_id });
    return emptyCascadeResult();
  },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd145-pa4-triggers-'));
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
  const resolver = createWorkEntityResolver(store);
  dispatchers = createWorkEntityDispatchers({
    store,
    resolver,
    bus,
    cascade,
    now: () => NOW,
  });
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
// Path + constant invariants
// ────────────────────────────────────────────────────────────────

describe('PA4 path conventions', () => {
  it('exports the work-entity bus platform + entity_type constants', () => {
    expect(WORK_ENTITY_BUS_PLATFORM).toBe('work');
    expect(WORK_ENTITY_BUS_ENTITY_TYPE).toBe('item');
  });

  it('composeWorkEntityBusPath emits the expected shape per kind', () => {
    expect(composeWorkEntityBusPath('task', 'created')).toBe(
      'data.work.task.item.created',
    );
    expect(composeWorkEntityBusPath('commitment', 'state_changed')).toBe(
      'data.work.commitment.item.state_changed',
    );
  });

  it('exposes the closed list of derived event kinds', () => {
    expect([...WORK_ENTITY_DERIVED_EVENT_KINDS].sort()).toEqual(
      ['completed', 'due_soon', 'overdue', 'state_changed'].sort(),
    );
  });

  it('due-soon window is exactly 24h in ms', () => {
    expect(WORK_ENTITY_DUE_SOON_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
});

// ────────────────────────────────────────────────────────────────
// task — created / updated / deleted / completed
// ────────────────────────────────────────────────────────────────

describe('task triggers', () => {
  it('task-create fires `task.item.created` with canonical record + source_id payload', async () => {
    const out = await dispatchers.taskCreate({ title: 'pick up groceries' });
    const fired = findEvents('data.work.task.item.created');
    expect(fired).toHaveLength(1);
    expect(fired[0]!.record_id).toBe(out.task.id);
    expect(fired[0]!.at).toBe(NOW);
    const prev = fired[0]!.prev as Record<string, unknown>;
    expect((prev.record as Record<string, unknown>).id).toBe(out.task.id);
    expect((prev.record as Record<string, unknown>)._kind).toBe('task');
    expect((prev.record as Record<string, unknown>).title).toBe('pick up groceries');
    expect(prev.source_id).toBe(RECUED_BUILTIN_SOURCE_ID('task'));
    expect(prev.prior).toBeUndefined();
  });

  it('task-update fires `task.item.updated` with prev.prior canonical record', async () => {
    const created = await dispatchers.taskCreate({ title: 'walk the dog' });
    events.length = 0;
    await dispatchers.taskUpdate({ id: created.task.id, title: 'walk the dog this morning' });
    const fired = findEvents('data.work.task.item.updated');
    expect(fired).toHaveLength(1);
    const prev = fired[0]!.prev as Record<string, unknown>;
    expect((prev.record as Record<string, unknown>).title).toBe('walk the dog this morning');
    expect((prev.prior as Record<string, unknown>).title).toBe('walk the dog');
  });

  it('task-update emits state_changed only for genuine state transitions', async () => {
    const created = await dispatchers.taskCreate({
      title: 'codex run',
      state: 'queued',
      progress: 35,
    });

    events.length = 0;
    const transitioned = await dispatchers.taskUpdate({
      id: created.task.id,
      state: 'running',
    });
    expect(transitioned.task.progress).toBe(35);
    expect(findEvents('data.work.task.item.updated')).toHaveLength(1);
    const stateChanged = findEvents('data.work.task.item.state_changed');
    expect(stateChanged).toHaveLength(1);
    expect(((stateChanged[0]!.prev as Record<string, unknown>).prior as Record<string, unknown>).state).toBe('queued');
    expect(((stateChanged[0]!.prev as Record<string, unknown>).record as Record<string, unknown>).state).toBe('running');

    events.length = 0;
    await dispatchers.taskUpdate({ id: created.task.id, body: 'no state move' });
    expect(findEvents('data.work.task.item.updated')).toHaveLength(1);
    expect(findEvents('data.work.task.item.state_changed')).toHaveLength(0);
  });

  it('task-update fires cascadeForSourceUpdate with scope=task', async () => {
    const created = await dispatchers.taskCreate({ title: 't' });
    cascadeCalls.length = 0;
    await dispatchers.taskUpdate({ id: created.task.id, body: 'b' });
    expect(cascadeCalls).toEqual([
      { method: 'cascadeForSourceUpdate', scope: 'task', id: created.task.id },
    ]);
  });

  it('task-delete fires `task.item.deleted` + cascadeForSourceDelete', async () => {
    const created = await dispatchers.taskCreate({ title: 't' });
    events.length = 0;
    cascadeCalls.length = 0;
    await dispatchers.taskDelete({ id: created.task.id });
    const fired = findEvents('data.work.task.item.deleted');
    expect(fired).toHaveLength(1);
    expect(cascadeCalls).toEqual([
      { method: 'cascadeForSourceDelete', scope: 'task', id: created.task.id },
    ]);
  });

  it('task-mark-done fires both `task.item.updated` and `task.item.completed` on the false → true transition', async () => {
    const created = await dispatchers.taskCreate({ title: 't' });
    events.length = 0;
    cascadeCalls.length = 0;
    await dispatchers.taskMarkDone({ id: created.task.id });
    const updated = findEvents('data.work.task.item.updated');
    const completed = findEvents('data.work.task.item.completed');
    expect(updated).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect((completed[0]!.prev as Record<string, unknown>).prior).toBeDefined();
    expect(((completed[0]!.prev as Record<string, unknown>).prior as Record<string, unknown>).done).toBe(false);
    expect(((completed[0]!.prev as Record<string, unknown>).record as Record<string, unknown>).done).toBe(true);
    expect(cascadeCalls).toEqual([
      { method: 'cascadeForSourceUpdate', scope: 'task', id: created.task.id },
    ]);
  });

  it('task-mark-done fires `updated` only on the true → false (un-complete) transition', async () => {
    const created = await dispatchers.taskCreate({ title: 't' });
    await dispatchers.taskMarkDone({ id: created.task.id });
    events.length = 0;
    await dispatchers.taskMarkDone({ id: created.task.id, done: false });
    expect(findEvents('data.work.task.item.updated')).toHaveLength(1);
    expect(findEvents('data.work.task.item.completed')).toHaveLength(0);
  });

  it('task-mark-done re-firing on already-done does NOT re-emit `completed`', async () => {
    const created = await dispatchers.taskCreate({ title: 't' });
    await dispatchers.taskMarkDone({ id: created.task.id });
    events.length = 0;
    await dispatchers.taskMarkDone({ id: created.task.id });
    expect(findEvents('data.work.task.item.completed')).toHaveLength(0);
  });

  it('task-create against a non-builtin adapter Source carries that Source id in payload', async () => {
    // Adapter Sources follow the non-connection 2-segment shape (same
    // family as `recued.task`); 3+ segments would be parsed as a
    // connection Source and hit the vendor-hook path.
    store.registerSource({
      id: 'fake.task',
      top_tier_kind: 'task',
      source_kind: 'adapter',
      source_label: 'Fake adapter',
      write_capable: true,
      registered_at: NOW,
    });
    await dispatchers.taskCreate({
      title: 't',
      source_id: 'fake.task',
    });
    const fired = findEvents('data.work.task.item.created');
    expect(fired).toHaveLength(1);
    const prev = fired[0]!.prev as Record<string, unknown>;
    expect(prev.source_id).toBe('fake.task');
  });
});

// ────────────────────────────────────────────────────────────────
// note — created / updated / deleted
// ────────────────────────────────────────────────────────────────

describe('note triggers', () => {
  it('note-create fires `note.item.created`', async () => {
    const out = await dispatchers.noteCreate({ body: 'hello' });
    const fired = findEvents('data.work.note.item.created');
    expect(fired).toHaveLength(1);
    expect(fired[0]!.record_id).toBe(out.note.id);
  });

  it('note-update fires `note.item.updated` + cascade', async () => {
    const created = await dispatchers.noteCreate({ body: 'a' });
    events.length = 0;
    cascadeCalls.length = 0;
    await dispatchers.noteUpdate({ id: created.note.id, body: 'b' });
    expect(findEvents('data.work.note.item.updated')).toHaveLength(1);
    expect(cascadeCalls).toEqual([
      { method: 'cascadeForSourceUpdate', scope: 'note', id: created.note.id },
    ]);
  });

  it('note-delete fires `note.item.deleted` + cascadeForSourceDelete', async () => {
    const created = await dispatchers.noteCreate({ body: 'n' });
    events.length = 0;
    cascadeCalls.length = 0;
    await dispatchers.noteDelete({ id: created.note.id });
    expect(findEvents('data.work.note.item.deleted')).toHaveLength(1);
    expect(cascadeCalls).toEqual([
      { method: 'cascadeForSourceDelete', scope: 'note', id: created.note.id },
    ]);
  });
});

// ────────────────────────────────────────────────────────────────
// commitment — created / updated / state_changed
// ────────────────────────────────────────────────────────────────

describe('commitment triggers', () => {
  const baseCreate = {
    direction: 'inbound' as const,
    statement: 'Bob to send the deck',
    derivation: 'user_declared' as const,
  };

  it('commitment-create fires `commitment.item.created`', async () => {
    const out = await dispatchers.commitmentCreate(baseCreate);
    expect(findEvents('data.work.commitment.item.created')).toHaveLength(1);
    expect(findEvents('data.work.commitment.item.state_changed')).toHaveLength(0);
    expect(findEvents('data.work.commitment.item.created')[0]!.record_id).toBe(out.commitment.id);
  });

  it('commitment-update (metadata-only) fires `updated` but NOT `state_changed`', async () => {
    const created = await dispatchers.commitmentCreate(baseCreate);
    events.length = 0;
    cascadeCalls.length = 0;
    await dispatchers.commitmentUpdate({
      id: created.commitment.id,
      statement: 'Bob to send the revised deck',
    });
    expect(findEvents('data.work.commitment.item.updated')).toHaveLength(1);
    expect(findEvents('data.work.commitment.item.state_changed')).toHaveLength(0);
    expect(cascadeCalls).toEqual([
      { method: 'cascadeForSourceUpdate', scope: 'commitment', id: created.commitment.id },
    ]);
  });

  it('commitment-fulfill fires both `updated` and `state_changed`', async () => {
    const created = await dispatchers.commitmentCreate(baseCreate);
    events.length = 0;
    cascadeCalls.length = 0;
    await dispatchers.commitmentFulfill({ id: created.commitment.id });
    expect(findEvents('data.work.commitment.item.updated')).toHaveLength(1);
    const stateChanged = findEvents('data.work.commitment.item.state_changed');
    expect(stateChanged).toHaveLength(1);
    const prev = stateChanged[0]!.prev as Record<string, unknown>;
    expect((prev.record as Record<string, unknown>).lifecycle_state).toBe('fulfilled');
    expect((prev.prior as Record<string, unknown>).lifecycle_state).toBe('pending');
    expect(cascadeCalls).toEqual([
      { method: 'cascadeForSourceUpdate', scope: 'commitment', id: created.commitment.id },
    ]);
  });

  it('commitment-cancel fires both `updated` and `state_changed`', async () => {
    const created = await dispatchers.commitmentCreate(baseCreate);
    events.length = 0;
    await dispatchers.commitmentCancel({ id: created.commitment.id });
    expect(findEvents('data.work.commitment.item.state_changed')).toHaveLength(1);
  });

  it('commitment-update reschedule forward-from-overdue back-transitions to due_soon (Codex P1 fold)', async () => {
    // Reschedule path is the only way back-transitions happen — the
    // sweep is forward-only. The dispatcher recomputes due_status
    // when `promised_for_at` shifts AND emits the matching reactive
    // kind so subscribers see the transition immediately.
    const promised = NOW - 1000;
    const created = await dispatchers.commitmentCreate({
      ...baseCreate,
      promised_for_at: promised,
    });
    // First mark as overdue at the storage level (sweep would do this
    // in production; we set it directly so the test focuses on the
    // dispatcher's recompute path).
    store.writeCommitment(
      {
        id: created.commitment.id,
        direction: created.commitment.direction,
        statement: created.commitment.statement,
        derivation: created.commitment.derivation,
        source_id: created.commitment.source_id,
        created_at: created.commitment.created_at,
        promised_at: created.commitment.promised_at,
        promised_for_at: created.commitment.promised_for_at,
        lifecycle_state: 'pending',
        due_status: 'overdue',
        expiry_policy: created.commitment.expiry_policy,
        state_changed_at: NOW,
        lifecycle_changed_at: created.commitment.lifecycle_changed_at,
        due_status_changed_at: NOW,
        sync_state: created.commitment.sync_state,
        conflict_policy: created.commitment.conflict_policy,
        blocks_task_ids: created.commitment.blocks_task_ids,
        blocks_project_ids: created.commitment.blocks_project_ids,
      },
      NOW,
    );

    events.length = 0;
    // Reschedule forward by 12h → due_soon range.
    const newDeadline = NOW + WORK_ENTITY_DUE_SOON_WINDOW_MS / 2;
    const updated = await dispatchers.commitmentUpdate({
      id: created.commitment.id,
      promised_for_at: newDeadline,
    });
    expect(updated.commitment.due_status).toBe('due_soon');
    expect(updated.commitment.due_status_changed_at).toBe(NOW);
    expect(findEvents('data.work.commitment.item.updated')).toHaveLength(1);
    expect(findEvents('data.work.commitment.item.due_soon')).toHaveLength(1);
    // Lifecycle didn't move so no state_changed.
    expect(findEvents('data.work.commitment.item.state_changed')).toHaveLength(0);
  });

  it('commitment-update reschedule forward-from-overdue clears all the way to not_due', async () => {
    const created = await dispatchers.commitmentCreate({
      ...baseCreate,
      promised_for_at: NOW - 1000,
    });
    store.writeCommitment(
      {
        id: created.commitment.id,
        direction: created.commitment.direction,
        statement: created.commitment.statement,
        derivation: created.commitment.derivation,
        source_id: created.commitment.source_id,
        created_at: created.commitment.created_at,
        promised_at: created.commitment.promised_at,
        promised_for_at: created.commitment.promised_for_at,
        lifecycle_state: 'pending',
        due_status: 'overdue',
        expiry_policy: created.commitment.expiry_policy,
        state_changed_at: NOW,
        lifecycle_changed_at: created.commitment.lifecycle_changed_at,
        due_status_changed_at: NOW,
        sync_state: created.commitment.sync_state,
        conflict_policy: created.commitment.conflict_policy,
        blocks_task_ids: created.commitment.blocks_task_ids,
        blocks_project_ids: created.commitment.blocks_project_ids,
      },
      NOW,
    );

    events.length = 0;
    // Reschedule far forward (> 24h) → not_due.
    const updated = await dispatchers.commitmentUpdate({
      id: created.commitment.id,
      promised_for_at: NOW + 7 * WORK_ENTITY_DUE_SOON_WINDOW_MS,
    });
    expect(updated.commitment.due_status).toBe('not_due');
    expect(findEvents('data.work.commitment.item.updated')).toHaveLength(1);
    // No discrete back-transition reactive event for not_due — the
    // recipe layer can listen on `updated` and diff via prev.prior.
    expect(findEvents('data.work.commitment.item.due_soon')).toHaveLength(0);
    expect(findEvents('data.work.commitment.item.overdue')).toHaveLength(0);
  });

  it('commitment-update with same promised_for_at does NOT re-stamp due_status_changed_at', async () => {
    const created = await dispatchers.commitmentCreate({
      ...baseCreate,
      promised_for_at: NOW + WORK_ENTITY_DUE_SOON_WINDOW_MS * 7,
    });
    const beforeStamp = created.commitment.due_status_changed_at;
    events.length = 0;
    // Update an unrelated field — due_status_changed_at must not
    // move (no due axis transition occurred).
    const updated = await dispatchers.commitmentUpdate({
      id: created.commitment.id,
      statement: 'revised',
    });
    expect(updated.commitment.due_status).toBe(created.commitment.due_status);
    expect(updated.commitment.due_status_changed_at).toBe(beforeStamp);
  });

  it('commitment-update reschedule on terminal lifecycle_state does NOT recompute', async () => {
    const created = await dispatchers.commitmentCreate({
      ...baseCreate,
      promised_for_at: NOW + WORK_ENTITY_DUE_SOON_WINDOW_MS * 7,
    });
    await dispatchers.commitmentFulfill({ id: created.commitment.id });
    events.length = 0;
    // Reschedule on a fulfilled commitment — the dispatcher allows
    // metadata edits but the due axis stays frozen at the lifecycle
    // transition stamp.
    const updated = await dispatchers.commitmentUpdate({
      id: created.commitment.id,
      promised_for_at: NOW - 1000, // would be overdue if pending
    });
    expect(updated.commitment.lifecycle_state).toBe('fulfilled');
    expect(updated.commitment.due_status).toBe(created.commitment.due_status);
    expect(findEvents('data.work.commitment.item.overdue')).toHaveLength(0);
  });

  it('payload carries the canonical commitment record under prev.record', async () => {
    const created = await dispatchers.commitmentCreate({
      ...baseCreate,
      promised_for_at: NOW + WORK_ENTITY_DUE_SOON_WINDOW_MS * 7,
    });
    const fired = findEvents('data.work.commitment.item.created');
    const prev = fired[0]!.prev as Record<string, unknown>;
    const record = prev.record as Record<string, unknown>;
    expect(record._kind).toBe('commitment');
    expect(record.statement).toBe('Bob to send the deck');
    expect(record.lifecycle_state).toBe('pending');
    expect(record.due_status).toBe('not_due');
    expect(record.expiry_policy).toBe('escalate_overdue');
  });
});

// ────────────────────────────────────────────────────────────────
// project — created / updated / state_changed
// ────────────────────────────────────────────────────────────────

describe('project triggers', () => {
  it('project-create fires `project.item.created`', async () => {
    const out = await dispatchers.projectCreate({ title: 'Migration' });
    expect(findEvents('data.work.project.item.created')).toHaveLength(1);
    expect(findEvents('data.work.project.item.created')[0]!.record_id).toBe(out.project.id);
  });

  it('project-update fires `updated` only when state is unchanged', async () => {
    const created = await dispatchers.projectCreate({ title: 'p' });
    events.length = 0;
    await dispatchers.projectUpdate({ id: created.project.id, description: 'x' });
    expect(findEvents('data.work.project.item.updated')).toHaveLength(1);
    expect(findEvents('data.work.project.item.state_changed')).toHaveLength(0);
  });

  it('project-update fires both `updated` and `state_changed` when state moves', async () => {
    const created = await dispatchers.projectCreate({ title: 'p' });
    events.length = 0;
    await dispatchers.projectUpdate({ id: created.project.id, state: 'paused' });
    expect(findEvents('data.work.project.item.updated')).toHaveLength(1);
    expect(findEvents('data.work.project.item.state_changed')).toHaveLength(1);
  });

  it('project-archive fires both `updated` and `state_changed`', async () => {
    const created = await dispatchers.projectCreate({ title: 'p' });
    events.length = 0;
    cascadeCalls.length = 0;
    await dispatchers.projectArchive({ id: created.project.id });
    expect(findEvents('data.work.project.item.updated')).toHaveLength(1);
    expect(findEvents('data.work.project.item.state_changed')).toHaveLength(1);
    expect(cascadeCalls).toEqual([
      { method: 'cascadeForSourceUpdate', scope: 'project', id: created.project.id },
    ]);
  });

  it('project-archive on already-archived project is fully idempotent (no events, no cascade)', async () => {
    const created = await dispatchers.projectCreate({ title: 'p' });
    await dispatchers.projectArchive({ id: created.project.id });
    events.length = 0;
    cascadeCalls.length = 0;
    await dispatchers.projectArchive({ id: created.project.id });
    expect(events).toHaveLength(0);
    expect(cascadeCalls).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// Bus + cascade plumbing edge cases
// ────────────────────────────────────────────────────────────────

describe('bus + cascade plumbing', () => {
  it('dispatcher composer without bus + cascade still writes successfully (silent path)', async () => {
    const resolver = createWorkEntityResolver(store);
    const silent = createWorkEntityDispatchers({ store, resolver, now: () => NOW });
    const out = await silent.taskCreate({ title: 't' });
    expect(out.task.id).toBeTruthy();
    expect(events).toHaveLength(0);
    expect(cascadeCalls).toEqual([]);
  });

  it('bus emit failure is swallowed — write is not rolled back', async () => {
    const angryBus: WarehouseEventBus = {
      emit() {
        throw new Error('bus down');
      },
      subscribe() {
        return () => {};
      },
      dispose() {},
    };
    const resolver = createWorkEntityResolver(store);
    const angry = createWorkEntityDispatchers({
      store,
      resolver,
      bus: angryBus,
      now: () => NOW,
    });
    const out = await angry.taskCreate({ title: 't' });
    expect(out.task.id).toBeTruthy();
    expect(store.readTask(out.task.id)).not.toBeNull();
  });

  it('cascade engine throw is swallowed — write is not rolled back', async () => {
    const angryCascade: CascadeEngine = {
      ...buildSpyCascade(),
      cascadeForSourceUpdate() {
        throw new Error('cascade down');
      },
    };
    const resolver = createWorkEntityResolver(store);
    const angry = createWorkEntityDispatchers({
      store,
      resolver,
      bus,
      cascade: angryCascade,
      now: () => NOW,
    });
    const created = await angry.taskCreate({ title: 't' });
    const out = await angry.taskUpdate({ id: created.task.id, body: 'b' });
    expect(out.task.body).toBe('b');
    expect(store.readTask(created.task.id)?.body).toBe('b');
  });

  it('create paths do NOT fan cascade (no downstream rows yet for new ids)', async () => {
    cascadeCalls.length = 0;
    await dispatchers.taskCreate({ title: 't' });
    await dispatchers.noteCreate({ body: 'n' });
    await dispatchers.commitmentCreate({
      direction: 'outbound',
      statement: 's',
      derivation: 'user_declared',
    });
    await dispatchers.projectCreate({ title: 'p' });
    expect(cascadeCalls).toEqual([]);
  });
});
