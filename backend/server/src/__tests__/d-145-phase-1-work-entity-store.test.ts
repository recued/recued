/** D-145 PA1 — work entity store tests.
 *
 *  Storage round-trip for the four kinds + Source registry + note
 *  access ledger + sync_state filter + tombstone + composite source
 *  uniqueness + project hierarchy depth + monetary_value coupled
 *  validation. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TASK_STATE_MAX } from '@recued/contracts';

import {
  COMMITMENT_TABLE,
  NOTE_ACCESS_LEDGER_TABLE,
  NOTE_FTS_TABLE,
  NOTE_TABLE,
  PROJECT_TABLE,
  SOURCE_REGISTRY_TABLE,
  SourceRegistrationError,
  TASK_TABLE,
  WorkEntityValidationError,
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';

let dir: string;
let db: Database.Database;
let store: WorkEntityStore;

const NOW = 1_700_000_000_000;

const registerBuiltinSources = (s: WorkEntityStore): void => {
  s.registerSource({
    id: 'recued.task',
    top_tier_kind: 'task',
    source_kind: 'builtin',
    source_label: 'Recued built-in (tasks)',
    write_capable: true,
    mcp_exposed: false,
  });
  s.registerSource({
    id: 'recued.note',
    top_tier_kind: 'note',
    source_kind: 'builtin',
    source_label: 'Recued built-in (notes)',
    write_capable: true,
    mcp_exposed: false,
  });
  s.registerSource({
    id: 'recued.commitment',
    top_tier_kind: 'commitment',
    source_kind: 'builtin',
    source_label: 'Recued built-in (commitments)',
    write_capable: true,
    mcp_exposed: false,
  });
  s.registerSource({
    id: 'recued.project',
    top_tier_kind: 'project',
    source_kind: 'builtin',
    source_label: 'Recued built-in (projects)',
    write_capable: true,
    mcp_exposed: false,
  });
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd145-pa1-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureWorkEntitySchema(db);
  store = createWorkEntityStore(db);
  registerBuiltinSources(store);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// Schema / migrations
// ────────────────────────────────────────────────────────────────

describe('ensureWorkEntitySchema', () => {
  it('creates all five PA1 tables idempotently', () => {
    ensureWorkEntitySchema(db);
    ensureWorkEntitySchema(db);
    const tables = (db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )
      .all() as { name: string }[]).map((r) => r.name);
    expect(tables).toContain(SOURCE_REGISTRY_TABLE);
    expect(tables).toContain(TASK_TABLE);
    expect(tables).toContain(NOTE_TABLE);
    expect(tables).toContain(COMMITMENT_TABLE);
    expect(tables).toContain(PROJECT_TABLE);
    expect(tables).toContain(NOTE_ACCESS_LEDGER_TABLE);
  });

  it('ALTERs task state/progress idempotently when the store is constructed twice', () => {
    ensureWorkEntitySchema(db);
    const reopened = createWorkEntityStore(db);
    const reopenedAgain = createWorkEntityStore(db);

    const written = reopened.writeTask(
      {
        id: 'task-state-alter',
        title: 'tracks state',
        source_id: 'recued.task',
        state: 'queued',
        progress: 0,
      },
      NOW,
    );
    expect(written.state).toBe('queued');
    expect(reopenedAgain.readTask('task-state-alter')?.progress).toBe(0);
  });

  it('creates the FTS5 mirror table + write-side triggers on data_note (§ A.1.2)', () => {
    const tables = (db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      )
      .all(NOTE_FTS_TABLE) as { name: string }[]).map((r) => r.name);
    expect(tables).toContain(NOTE_FTS_TABLE);
    const triggers = (db
      .prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`)
      .all() as { name: string }[]).map((r) => r.name);
    expect(triggers).toContain(`trg_${NOTE_TABLE}_ai_fts`);
    expect(triggers).toContain(`trg_${NOTE_TABLE}_au_fts`);
    expect(triggers).toContain(`trg_${NOTE_TABLE}_ad_fts`);
  });

  it('FTS5 round-trip — insert / update / delete keep the index in sync', () => {
    const n = store.writeNote(
      { body: 'haystack with needle inside', source_id: 'recued.note' },
      NOW,
    );
    const hit1 = db
      .prepare(`SELECT rowid FROM ${NOTE_FTS_TABLE} WHERE ${NOTE_FTS_TABLE} MATCH 'needle'`)
      .all() as { rowid: number }[];
    expect(hit1.length).toBe(1);
    store.writeNote(
      { id: n.id, body: 'haystack only now', source_id: 'recued.note' },
      NOW + 1,
    );
    const hit2 = db
      .prepare(`SELECT rowid FROM ${NOTE_FTS_TABLE} WHERE ${NOTE_FTS_TABLE} MATCH 'needle'`)
      .all() as { rowid: number }[];
    expect(hit2.length).toBe(0);
    expect(store.deleteNote(n.id)).toBe(true);
    const hit3 = db
      .prepare(`SELECT rowid FROM ${NOTE_FTS_TABLE} WHERE ${NOTE_FTS_TABLE} MATCH 'haystack'`)
      .all() as { rowid: number }[];
    expect(hit3.length).toBe(0);
  });

  it('creates the per-kind indices on data_task / data_note / data_commitment / data_project', () => {
    const indexes = (db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index'`)
      .all() as { name: string }[]).map((r) => r.name);
    // Task
    expect(indexes).toContain('idx_task_done_due');
    expect(indexes).toContain('idx_task_assigned_done');
    expect(indexes).toContain('idx_task_project_done');
    expect(indexes).toContain('idx_task_source_record');
    expect(indexes).toContain('idx_task_sync_state');
    // Note
    expect(indexes).toContain('idx_note_last_user_action');
    expect(indexes).toContain('idx_note_source_record');
    // Commitment
    expect(indexes).toContain('idx_commitment_lifecycle_due');
    expect(indexes).toContain('idx_commitment_due_status');
    // Project
    expect(indexes).toContain('idx_project_state_activity');
    expect(indexes).toContain('idx_project_parent');
    // Note access ledger
    expect(indexes).toContain('idx_nal_note_time');
  });
});

// ────────────────────────────────────────────────────────────────
// Source registry
// ────────────────────────────────────────────────────────────────

describe('Source registry', () => {
  it('round-trips a registration', () => {
    const reg = store.registerSource({
      id: 'hubspot.conn_1.task',
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'HubSpot tasks (conn_1)',
      write_capable: false,
      mcp_exposed: true,
      registered_at: NOW,
      schema_extension_blob: { extra_field: { type: 'text' } },
      config_blob: { connection_id: 'conn_1' },
    });
    expect(reg.registered_at).toBe(NOW);
    const fetched = store.getSource('hubspot.conn_1.task');
    expect(fetched).toMatchObject({
      id: 'hubspot.conn_1.task',
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'HubSpot tasks (conn_1)',
      write_capable: false,
      mcp_exposed: true,
      schema_extension_blob: { extra_field: { type: 'text' } },
      config_blob: { connection_id: 'conn_1' },
    });
  });

  it('lists by top_tier_kind', () => {
    const tasks = store.listSources('task');
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.id).toBe('recued.task');
  });

  it('rejects unknown top_tier_kind', () => {
    expect(() =>
      store.registerSource({
        id: 'rogue.bogus',
        // @ts-expect-error — testing runtime guard
        top_tier_kind: 'bogus',
        source_kind: 'builtin',
        source_label: 'rogue',
        write_capable: false,
        mcp_exposed: false,
      }),
    ).toThrow(SourceRegistrationError);
  });

  it('unregisterSource returns true on success, false on miss', () => {
    expect(store.unregisterSource('hubspot.missing')).toBe(false);
    store.registerSource({
      id: 'hubspot.conn_2.task',
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'hubspot conn_2',
      write_capable: false,
      mcp_exposed: false,
    });
    expect(store.unregisterSource('hubspot.conn_2.task')).toBe(true);
    expect(store.getSource('hubspot.conn_2.task')).toBeNull();
  });

  it('unregisterSource flips dependent rows to sync_state=orphaned (§ A.1.6)', () => {
    store.registerSource({
      id: 'hubspot.conn_3.task',
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'hubspot conn_3',
      write_capable: false,
      mcp_exposed: false,
    });
    const t = store.writeTask(
      {
        title: 'will be orphaned',
        source_id: 'hubspot.conn_3.task',
        source_record_id: 'hs_99',
      },
      NOW,
    );
    expect(store.unregisterSource('hubspot.conn_3.task')).toBe(true);
    const orphaned = store.readTask(t.id);
    expect(orphaned?.sync_state).toBe('orphaned');
    // Default list filter excludes orphaned per § A.1.6
    expect(store.listTasks().some((row) => row.id === t.id)).toBe(false);
    // Explicit orphaned filter resurfaces the row
    expect(
      store.listTasks({ sync_states: ['orphaned'] }).some((row) => row.id === t.id),
    ).toBe(true);
  });

  it('unregisterSource preserves tombstoned rows (no overwrite of deleted_at)', () => {
    store.registerSource({
      id: 'hubspot.conn_4.task',
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'hubspot conn_4',
      write_capable: false,
      mcp_exposed: false,
    });
    const t = store.writeTask(
      { title: 'tombstoned then orphaned', source_id: 'hubspot.conn_4.task' },
      NOW,
    );
    store.deleteTask(t.id, { tombstone: true, now: NOW + 1 });
    store.unregisterSource('hubspot.conn_4.task');
    const final = store
      .listTasks({ include_deleted: true, sync_states: ['tombstoned'] })
      .find((r) => r.id === t.id);
    expect(final?.sync_state).toBe('tombstoned');
    expect(final?.deleted_at).toBe(NOW + 1);
  });
});

describe('Source kind matching (§ A.2)', () => {
  it('writing a task against a note Source raises validation error', () => {
    expect(() =>
      store.writeTask(
        { title: 'wrong source', source_id: 'recued.note' },
        NOW,
      ),
    ).toThrow(/'note', not 'task'/);
  });

  it('writing a commitment against a project Source raises validation error', () => {
    expect(() =>
      store.writeCommitment(
        {
          direction: 'outbound',
          statement: 'wrong',
          derivation: 'user_declared',
          source_id: 'recued.project',
        },
        NOW,
      ),
    ).toThrow(/'project', not 'commitment'/);
  });

  it('writing a project against a task Source raises validation error', () => {
    expect(() =>
      store.writeProject(
        { title: 'wrong source', source_id: 'recued.task' },
        NOW,
      ),
    ).toThrow(/'task', not 'project'/);
  });
});

// ────────────────────────────────────────────────────────────────
// Task storage round-trip
// ────────────────────────────────────────────────────────────────

describe('writeTask + readTask', () => {
  it('persists a task with defaults + reads it back', () => {
    const t = store.writeTask(
      {
        title: 'Pay invoice',
        source_id: 'recued.task',
        priority: 'high',
        due_at: NOW + 86_400_000,
        blocks_task_ids: ['t-other'],
      },
      NOW,
    );
    expect(t.title).toBe('Pay invoice');
    expect(t.done).toBe(false);
    expect(t.priority).toBe('high');
    expect(t.created_at).toBe(NOW);
    expect(t.updated_at).toBe(NOW);
    expect(t.last_seen_at).toBe(NOW);
    expect(t.sync_state).toBe('live');
    expect(t.conflict_policy).toBe('source_wins');
    expect(t.blocks_task_ids).toEqual(['t-other']);
    expect(store.readTask(t.id)).toMatchObject({ id: t.id, title: 'Pay invoice' });
  });

  it('round-trips state/progress and omits absent task fields from row projection', () => {
    const t = store.writeTask(
      {
        title: 'Build release',
        source_id: 'recued.task',
        state: 'running',
        progress: 42,
      },
      NOW,
    );
    expect(t.state).toBe('running');
    expect(t.progress).toBe(42);
    expect(store.readTask(t.id)).toMatchObject({
      id: t.id,
      state: 'running',
      progress: 42,
    });

    const absent = store.writeTask({ title: 'No state yet', source_id: 'recued.task' }, NOW);
    const fetched = store.readTask(absent.id)!;
    expect('state' in fetched).toBe(false);
    expect('progress' in fetched).toBe(false);
  });

  it('rejects writes against an unregistered source', () => {
    expect(() =>
      store.writeTask({ title: 'x', source_id: 'rogue.unregistered' }, NOW),
    ).toThrow(WorkEntityValidationError);
  });

  it('rejects empty title', () => {
    expect(() =>
      store.writeTask({ title: '', source_id: 'recued.task' }, NOW),
    ).toThrow(/title is required/);
  });

  it('rejects title exceeding TASK_TITLE_MAX', () => {
    const long = 'x'.repeat(201);
    expect(() =>
      store.writeTask({ title: long, source_id: 'recued.task' }, NOW),
    ).toThrow(/exceeds max length 200/);
  });

  it('rejects an unknown priority', () => {
    expect(() =>
      store.writeTask(
        // @ts-expect-error — runtime guard
        { title: 'x', source_id: 'recued.task', priority: 'urgent' },
        NOW,
      ),
    ).toThrow(/unknown priority/);
  });

  it('validates task state and progress bounds', () => {
    expect(() =>
      store.writeTask({ title: 'x', source_id: 'recued.task', state: '' }, NOW),
    ).toThrow(/state is required/);

    expect(() =>
      store.writeTask(
        {
          title: 'x',
          source_id: 'recued.task',
          state: 'x'.repeat(TASK_STATE_MAX + 1),
        },
        NOW,
      ),
    ).toThrow(/state exceeds max length 100/);

    for (const progress of [50.5, -1, 101]) {
      expect(() =>
        store.writeTask(
          { title: 'x', source_id: 'recued.task', progress },
          NOW,
        ),
      ).toThrow(/progress must be an integer between 0 and 100/);
    }

    expect(
      store.writeTask(
        { title: 'zero', source_id: 'recued.task', progress: 0 },
        NOW,
      ).progress,
    ).toBe(0);
    expect(
      store.writeTask(
        { title: 'done', source_id: 'recued.task', progress: 100 },
        NOW,
      ).progress,
    ).toBe(100);
  });

  it('upsert via fixed id replaces the row', () => {
    const id = 'task-fixed-1';
    store.writeTask({ id, title: 'first', source_id: 'recued.task' }, NOW);
    store.writeTask({ id, title: 'second', source_id: 'recued.task' }, NOW + 1);
    const fetched = store.readTask(id);
    expect(fetched?.title).toBe('second');
    expect(fetched?.updated_at).toBe(NOW + 1);
  });
});

describe('listTasks / countTasks', () => {
  it('returns rows ordered by updated_at desc, sync_state default-filtered', () => {
    store.writeTask({ id: 't1', title: 'A', source_id: 'recued.task' }, NOW);
    store.writeTask({ id: 't2', title: 'B', source_id: 'recued.task' }, NOW + 1);
    store.writeTask(
      {
        id: 't3',
        title: 'orphaned',
        source_id: 'recued.task',
        sync_state: 'orphaned',
      },
      NOW + 2,
    );
    const all = store.listTasks();
    expect(all.map((t) => t.id)).toEqual(['t2', 't1']);
    expect(store.countTasks()).toBe(2);
  });

  it('respects explicit sync_states filter', () => {
    store.writeTask({ id: 't1', title: 'A', source_id: 'recued.task' }, NOW);
    store.writeTask(
      { id: 't2', title: 'O', source_id: 'recued.task', sync_state: 'orphaned' },
      NOW,
    );
    expect(
      store.listTasks({ sync_states: ['orphaned'] }).map((t) => t.id),
    ).toEqual(['t2']);
  });

  it('findTask matches the first predicate hit', () => {
    store.writeTask({ id: 't1', title: 'A', source_id: 'recued.task' }, NOW);
    store.writeTask({ id: 't2', title: 'B', source_id: 'recued.task' }, NOW + 1);
    const found = store.findTask((t) => t.title === 'A');
    expect(found?.id).toBe('t1');
    expect(store.findTask((t) => t.title === 'Z')).toBeNull();
  });
});

describe('deleteTask', () => {
  it('hard-delete removes the row', () => {
    const t = store.writeTask({ title: 'x', source_id: 'recued.task' }, NOW);
    expect(store.deleteTask(t.id)).toBe(true);
    expect(store.readTask(t.id)).toBeNull();
    expect(store.deleteTask('nope')).toBe(false);
  });

  it('tombstone keeps the row but flips sync_state + populates deleted_at', () => {
    const t = store.writeTask({ title: 'x', source_id: 'recued.task' }, NOW);
    expect(store.deleteTask(t.id, { tombstone: true, now: NOW + 5 })).toBe(true);
    expect(store.readTask(t.id)?.sync_state).toBe('tombstoned');
    expect(store.readTask(t.id)?.deleted_at).toBe(NOW + 5);
    // Default list excludes tombstoned + deleted_at IS NOT NULL
    expect(store.listTasks().some((row) => row.id === t.id)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// Note storage + access ledger
// ────────────────────────────────────────────────────────────────

describe('writeNote + readNote', () => {
  it('persists a note with last_user_action_at default to now', () => {
    const n = store.writeNote(
      {
        title: 'Brainstorm',
        body: 'Some plain text',
        source_id: 'recued.note',
        related_contact_ids: ['bob@x.com'],
      },
      NOW,
    );
    expect(n.body).toBe('Some plain text');
    expect(n.last_user_action_at).toBe(NOW);
    expect(n.related_contact_ids).toEqual(['bob@x.com']);
  });

  it('rejects empty body (required field)', () => {
    expect(() =>
      store.writeNote(
        // @ts-expect-error — testing runtime guard
        { title: 't', source_id: 'recued.note' },
        NOW,
      ),
    ).toThrow(/body is required/);
  });

  it('list orders by last_user_action_at desc', () => {
    store.writeNote(
      { id: 'n1', body: 'a', source_id: 'recued.note', last_user_action_at: NOW },
      NOW,
    );
    store.writeNote(
      {
        id: 'n2',
        body: 'b',
        source_id: 'recued.note',
        last_user_action_at: NOW + 100,
      },
      NOW,
    );
    const list = store.listNotes();
    expect(list.map((r) => r.id)).toEqual(['n2', 'n1']);
  });
});

describe('Note access ledger', () => {
  it('records access without mutating the canonical row', () => {
    const n = store.writeNote(
      { body: 'hello', source_id: 'recued.note' },
      NOW,
    );
    const lastUserAction = n.last_user_action_at;
    store.recordNoteAccess({
      note_id: n.id,
      accessed_at: NOW + 1000,
      access_kind: 'mcp_read',
      access_actor: 'agent-claude',
    });
    expect(store.readNote(n.id)?.last_user_action_at).toBe(lastUserAction);
    const ledger = store.listNoteAccess(n.id);
    expect(ledger.length).toBe(1);
    expect(ledger[0]).toMatchObject({
      note_id: n.id,
      access_kind: 'mcp_read',
      access_actor: 'agent-claude',
    });
  });

  it('rejects unknown access_kind', () => {
    const n = store.writeNote({ body: 'h', source_id: 'recued.note' }, NOW);
    expect(() =>
      store.recordNoteAccess({
        note_id: n.id,
        accessed_at: NOW,
        // @ts-expect-error — runtime guard
        access_kind: 'rogue',
      }),
    ).toThrow(/unknown access_kind/);
  });

  it('hard-deleting a note clears its ledger entries', () => {
    const n = store.writeNote({ body: 'h', source_id: 'recued.note' }, NOW);
    store.recordNoteAccess({
      note_id: n.id,
      accessed_at: NOW,
      access_kind: 'user_open',
    });
    expect(store.deleteNote(n.id)).toBe(true);
    expect(store.listNoteAccess(n.id).length).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Commitment storage
// ────────────────────────────────────────────────────────────────

describe('writeCommitment + readCommitment', () => {
  it('persists with defaults — pending lifecycle, no_deadline due, escalate_overdue policy', () => {
    const c = store.writeCommitment(
      {
        direction: 'outbound',
        statement: 'Send draft Friday',
        derivation: 'user_declared',
        source_id: 'recued.commitment',
      },
      NOW,
    );
    expect(c.lifecycle_state).toBe('pending');
    expect(c.due_status).toBe('no_deadline');
    expect(c.expiry_policy).toBe('escalate_overdue');
    expect(c.promised_at).toBe(NOW);
    expect(c.state_changed_at).toBe(NOW);
  });

  it('flips due_status default to not_due when promised_for_at is set', () => {
    const c = store.writeCommitment(
      {
        direction: 'inbound',
        statement: 'Bob owes me $5K',
        derivation: 'mail_extracted',
        source_id: 'recued.commitment',
        promised_for_at: NOW + 86_400_000,
      },
      NOW,
    );
    expect(c.due_status).toBe('not_due');
  });

  it('round-trips monetary_value coupled (amount + currency)', () => {
    const c = store.writeCommitment(
      {
        direction: 'inbound',
        statement: 'Bob owes me $5K',
        derivation: 'user_declared',
        source_id: 'recued.commitment',
        monetary_value: { amount: '5000.00', currency: 'USD' },
      },
      NOW,
    );
    expect(c.monetary_value).toEqual({ amount: '5000.00', currency: 'USD' });
  });

  it('rejects monetary_value with non-decimal amount', () => {
    expect(() =>
      store.writeCommitment(
        {
          direction: 'inbound',
          statement: 'x',
          derivation: 'user_declared',
          source_id: 'recued.commitment',
          monetary_value: { amount: '5,000', currency: 'USD' },
        },
        NOW,
      ),
    ).toThrow(/decimal string/);
  });

  it('rejects monetary_value with bad currency code', () => {
    expect(() =>
      store.writeCommitment(
        {
          direction: 'outbound',
          statement: 'x',
          derivation: 'user_declared',
          source_id: 'recued.commitment',
          monetary_value: { amount: '5.00', currency: 'usd' },
        },
        NOW,
      ),
    ).toThrow(/ISO 4217/);
  });

  it('rejects unknown direction', () => {
    expect(() =>
      store.writeCommitment(
        // @ts-expect-error — runtime guard
        { direction: 'sideways', statement: 'x', derivation: 'user_declared', source_id: 'recued.commitment' },
        NOW,
      ),
    ).toThrow(/unknown direction/);
  });

  it('rejects derivation_confidence out of [0,1]', () => {
    expect(() =>
      store.writeCommitment(
        {
          direction: 'outbound',
          statement: 'x',
          derivation: 'mail_extracted',
          source_id: 'recued.commitment',
          derivation_confidence: 1.5,
        },
        NOW,
      ),
    ).toThrow(/derivation_confidence/);
  });

  it('orthogonal axes — lifecycle stays pending when due_status crosses to overdue', () => {
    const c = store.writeCommitment(
      {
        direction: 'inbound',
        statement: 'overdue test',
        derivation: 'user_declared',
        source_id: 'recued.commitment',
        promised_for_at: NOW - 1,
        lifecycle_state: 'pending',
        due_status: 'overdue',
      },
      NOW,
    );
    expect(c.lifecycle_state).toBe('pending');
    expect(c.due_status).toBe('overdue');
    // Per § A.1.3 — monetary commitments must NOT silently expire when
    // the deadline crosses; only `expiry_policy: 'strict_expire'` would
    // ever flip lifecycle to 'expired'.
    expect(c.expiry_policy).toBe('escalate_overdue');
  });
});

// ────────────────────────────────────────────────────────────────
// Project storage + hierarchy depth check
// ────────────────────────────────────────────────────────────────

describe('writeProject + readProject', () => {
  it('persists with default state active', () => {
    const p = store.writeProject(
      { title: 'Wagner event', source_id: 'recued.project' },
      NOW,
    );
    expect(p.state).toBe('active');
    expect(p.last_activity_at).toBe(NOW);
  });

  it('rejects unknown state', () => {
    expect(() =>
      store.writeProject(
        // @ts-expect-error — runtime guard
        { title: 'x', source_id: 'recued.project', state: 'pending' },
        NOW,
      ),
    ).toThrow(/unknown state/);
  });

  it('enforces parent_project hierarchy depth ≤ 3', () => {
    const root = store.writeProject({ title: 'L0', source_id: 'recued.project' }, NOW);
    const l1 = store.writeProject(
      { title: 'L1', source_id: 'recued.project', parent_project_id: root.id },
      NOW + 1,
    );
    const l2 = store.writeProject(
      { title: 'L2', source_id: 'recued.project', parent_project_id: l1.id },
      NOW + 2,
    );
    expect(() =>
      store.writeProject(
        { title: 'L3', source_id: 'recued.project', parent_project_id: l2.id },
        NOW + 3,
      ),
    ).toThrow(/exceeds depth 3/);
  });

  it('detects parent_project cycle', () => {
    const a = store.writeProject({ title: 'A', source_id: 'recued.project' }, NOW);
    const b = store.writeProject(
      { title: 'B', source_id: 'recued.project', parent_project_id: a.id },
      NOW + 1,
    );
    // Now point a → b — closes the cycle.
    expect(() =>
      store.writeProject(
        { id: a.id, title: 'A', source_id: 'recued.project', parent_project_id: b.id },
        NOW + 2,
      ),
    ).toThrow(/cycle/);
  });
});

// ────────────────────────────────────────────────────────────────
// Source row identity — composite uniqueness + sync_state filter
// ────────────────────────────────────────────────────────────────

describe('Source row identity (§ A.1.6)', () => {
  it('composite uniqueness on (source_id, source_record_id)', () => {
    store.registerSource({
      id: 'hubspot.conn_x.task',
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'HubSpot tasks (conn_x)',
      write_capable: false,
      mcp_exposed: false,
    });
    store.writeTask(
      {
        title: 'first',
        source_id: 'hubspot.conn_x.task',
        source_record_id: 'hs_42',
      },
      NOW,
    );
    expect(() =>
      store.writeTask(
        {
          title: 'duplicate',
          source_id: 'hubspot.conn_x.task',
          source_record_id: 'hs_42',
        },
        NOW + 1,
      ),
    ).toThrow();
  });

  it('default list filter excludes tombstoned + orphaned', () => {
    store.writeTask({ id: 'live', title: 'A', source_id: 'recued.task' }, NOW);
    store.writeTask(
      {
        id: 'tomb',
        title: 'B',
        source_id: 'recued.task',
        sync_state: 'tombstoned',
      },
      NOW,
    );
    store.writeTask(
      {
        id: 'orph',
        title: 'C',
        source_id: 'recued.task',
        sync_state: 'orphaned',
      },
      NOW,
    );
    expect(store.listTasks().map((t) => t.id)).toEqual(['live']);
  });

  it('include_deleted=true surfaces tombstoned rows', () => {
    const t = store.writeTask({ title: 'x', source_id: 'recued.task' }, NOW);
    store.deleteTask(t.id, { tombstone: true, now: NOW + 1 });
    const all = store.listTasks({ include_deleted: true, sync_states: ['tombstoned'] });
    expect(all.length).toBe(1);
    expect(all[0]!.deleted_at).toBe(NOW + 1);
  });

  it('rejects unknown sync_state on input', () => {
    expect(() =>
      store.writeTask(
        // @ts-expect-error — runtime guard
        { title: 'x', source_id: 'recued.task', sync_state: 'rotten' },
        NOW,
      ),
    ).toThrow(/unknown sync_state/);
  });
});

// ────────────────────────────────────────────────────────────────
// Polymorphic + count-by-kind
// ────────────────────────────────────────────────────────────────

describe('readByKind + countByKind', () => {
  it('readByKind tags rows with `_kind` discriminator', () => {
    const t = store.writeTask({ title: 'x', source_id: 'recued.task' }, NOW);
    const tagged = store.readByKind('task', t.id);
    expect(tagged?._kind).toBe('task');
    expect(tagged?.id).toBe(t.id);
  });

  it('readByKind returns null for unknown kind input', () => {
    // @ts-expect-error — runtime guard
    expect(store.readByKind('memo', 'nope')).toBeNull();
  });

  it('countByKind dispatches to per-kind count', () => {
    store.writeTask({ title: 'a', source_id: 'recued.task' }, NOW);
    store.writeNote({ body: 'b', source_id: 'recued.note' }, NOW);
    expect(store.countByKind('task')).toBe(1);
    expect(store.countByKind('note')).toBe(1);
    expect(store.countByKind('commitment')).toBe(0);
    expect(store.countByKind('project')).toBe(0);
  });
});
