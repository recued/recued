/** D-145 PA10 - work-entity create dispatcher null normalization.
 *
 *  These tests call the dispatcher closures directly and assert the
 *  persisted runtime records. Recipe interpolation can produce null
 *  for skipped optional branches, so the create dispatchers must treat
 *  null like absence before handing write inputs to the store. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RECUED_BUILTIN_SOURCE_ID,
  type CommitmentExpiryPolicy,
  type MonetaryValue,
  type TaskPriority,
} from '@recued/contracts';

import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';

const NOW = 1_700_000_000_000;
const REGISTERED_KINDS = ['task', 'commitment'] as const;

let db: Database.Database;
let store: WorkEntityStore;
let dispatchers: ReturnType<typeof createWorkEntityDispatchers>;
let nextId: number;

const runtime = <T>(value: unknown): T => value as T;

const registerDefaultSources = (s: WorkEntityStore): void => {
  for (const kind of REGISTERED_KINDS) {
    const sourceId = RECUED_BUILTIN_SOURCE_ID(kind);
    s.registerSource({
      id: sourceId,
      top_tier_kind: kind,
      source_kind: 'builtin',
      source_label: `Recued built-in (${kind})`,
      write_capable: true,
      mcp_exposed: false,
      registered_at: NOW,
    });
    s.setDefaultSource(kind, sourceId, NOW);
  }
};

const readStoredTask = (id: string) => {
  const task = store.readTask(id);
  if (!task) throw new Error(`task ${id} missing`);
  return task;
};

const readStoredCommitment = (id: string) => {
  const commitment = store.readCommitment(id);
  if (!commitment) throw new Error(`commitment ${id} missing`);
  return commitment;
};

beforeEach(() => {
  nextId = 0;
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  ensureWorkEntitySchema(db);
  store = createWorkEntityStore(db, { newId: () => `d145-pa10-${++nextId}` });
  registerDefaultSources(store);
  dispatchers = createWorkEntityDispatchers({
    store,
    resolver: createWorkEntityResolver(store),
    now: () => NOW,
  });
});

afterEach(() => {
  db.close();
});

describe('task-create null and empty-string normalization', () => {
  it('commits due_at: null as no due date', async () => {
    const out = await dispatchers.taskCreate({
      title: 'task without due date',
      due_at: runtime<number>(null),
    });

    const stored = readStoredTask(out.task.id);
    expect(stored).not.toHaveProperty('due_at');
    expect(stored.due_at).toBeUndefined();
  });

  it('commits linked_mail_thread_id: "" without setting a thread link', async () => {
    const out = await dispatchers.taskCreate({
      title: 'task from unthreaded provider mail',
      linked_mail_thread_id: '',
    });

    const stored = readStoredTask(out.task.id);
    expect(stored).not.toHaveProperty('linked_mail_thread_id');
    expect(stored.linked_mail_thread_id).toBeUndefined();
  });

  it('treats null task optional fields as absent at write time', async () => {
    const out = await dispatchers.taskCreate({
      title: 'task with skipped optional branches',
      body: runtime<string>(null),
      due_at: runtime<number>(null),
      priority: runtime<TaskPriority>(null),
      done: runtime<boolean>(null),
      completed_at: runtime<number>(null),
      assigned_contact_id: runtime<string>(null),
      parent_calendar_event_id: runtime<string>(null),
      linked_mail_thread_id: runtime<string>(null),
      parent_project_id: runtime<string>(null),
      blocks_task_ids: runtime<readonly string[]>(null),
    });

    const stored = readStoredTask(out.task.id);
    expect(stored.body).toBeUndefined();
    expect(stored.due_at).toBeUndefined();
    expect(stored.priority).toBeUndefined();
    expect(stored.done).toBe(false);
    expect(stored.completed_at).toBeUndefined();
    expect(stored.assigned_contact_id).toBeUndefined();
    expect(stored.parent_calendar_event_id).toBeUndefined();
    expect(stored.linked_mail_thread_id).toBeUndefined();
    expect(stored.parent_project_id).toBeUndefined();
    expect(stored.blocks_task_ids).toEqual([]);
  });

  it('persists a unix-ms due_at value', async () => {
    const dueAt = 1_735_689_600_000;
    const out = await dispatchers.taskCreate({
      title: 'task with real due date',
      due_at: dueAt,
    });

    const stored = readStoredTask(out.task.id);
    expect(stored.due_at).toBe(dueAt);
  });
});

describe('commitment-create null and empty-string normalization', () => {
  it('commits monetary_value: null as a non-monetary commitment', async () => {
    const out = await dispatchers.commitmentCreate({
      direction: 'inbound',
      statement: 'Send signed quote',
      derivation: 'mail_extracted',
      monetary_value: runtime<MonetaryValue>(null),
    });

    const stored = readStoredCommitment(out.commitment.id);
    expect(stored).not.toHaveProperty('monetary_value');
    expect(stored.monetary_value).toBeUndefined();
  });

  it('commits promised_for_at: null as no deadline', async () => {
    const out = await dispatchers.commitmentCreate({
      direction: 'outbound',
      statement: 'Follow up when ready',
      derivation: 'user_declared',
      promised_for_at: runtime<number>(null),
    });

    const stored = readStoredCommitment(out.commitment.id);
    expect(stored.promised_for_at).toBeUndefined();
    expect(stored.due_status).toBe('no_deadline');
  });

  it('commits derived_from_mail_thread_id: "" without setting a thread link', async () => {
    const out = await dispatchers.commitmentCreate({
      direction: 'inbound',
      statement: 'Customer will send details',
      derivation: 'mail_extracted',
      derived_from_mail_thread_id: '',
    });

    const stored = readStoredCommitment(out.commitment.id);
    expect(stored).not.toHaveProperty('derived_from_mail_thread_id');
    expect(stored.derived_from_mail_thread_id).toBeUndefined();
  });

  it('treats null commitment optional fields as absent at write time', async () => {
    const out = await dispatchers.commitmentCreate({
      direction: 'internal',
      statement: 'Review skipped optional branches',
      derivation: 'recipe_emitted',
      promised_at: runtime<number>(null),
      promised_for_at: runtime<number>(null),
      expiry_policy: runtime<CommitmentExpiryPolicy>(null),
      derivation_confidence: runtime<number>(null),
      monetary_value: runtime<MonetaryValue>(null),
      counterparty_contact_id: runtime<string>(null),
      derived_from_mail_thread_id: runtime<string>(null),
      derived_from_meeting_id: runtime<string>(null),
      blocks_task_ids: runtime<readonly string[]>(null),
      blocks_project_ids: runtime<readonly string[]>(null),
    });

    const stored = readStoredCommitment(out.commitment.id);
    expect(stored.promised_at).toBe(NOW);
    expect(stored.promised_for_at).toBeUndefined();
    expect(stored.due_status).toBe('no_deadline');
    expect(stored.expiry_policy).toBe('escalate_overdue');
    expect(stored.derivation_confidence).toBeUndefined();
    expect(stored.monetary_value).toBeUndefined();
    expect(stored.counterparty_contact_id).toBeUndefined();
    expect(stored.derived_from_mail_thread_id).toBeUndefined();
    expect(stored.derived_from_meeting_id).toBeUndefined();
    expect(stored.blocks_task_ids).toEqual([]);
    expect(stored.blocks_project_ids).toEqual([]);
  });

  it('persists monetary amount and currency when monetary_value is present', async () => {
    const out = await dispatchers.commitmentCreate({
      direction: 'inbound',
      statement: 'Customer owes setup fee',
      derivation: 'mail_extracted',
      monetary_value: { amount: '500.00', currency: 'USD' },
    });

    const stored = readStoredCommitment(out.commitment.id);
    expect(stored.monetary_value).toEqual({ amount: '500.00', currency: 'USD' });
  });
});
