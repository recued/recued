/** D-145 PA3 — Kernel adapter switch-case tests for the 14
 *  work-entity CRUD ingredients.
 *
 *  Verifies the kernel adapter:
 *    - returns SERVER_NOT_REACHABLE when the dispatcher slot is
 *      missing (the standard ext-only-without-server posture);
 *    - performs input shape validation before reaching the dispatcher;
 *    - stamps `_id` + `_collection` on the returned canonical record
 *      so recipes can read `{{step.task._id}}` / `{{step.task._collection}}`
 *      uniformly (the D-119 P12 stamping discipline applied to PA3
 *      output shapes).
 *
 *  Compose with `createKernelAdapter` from `@recued/ingredients` so the
 *  same code path the production kernel adapter takes is exercised.
 *  Hand-build minimal fakes for each dispatcher so this test stays
 *  decoupled from the storage layer (the dispatcher composer is tested
 *  directly in `d-145-phase-3-ingredients.test.ts`). */

import { describe, expect, it } from 'vitest';

import {
  createKernelAdapter,
  type ResolvedCall,
} from '@recued/ingredients';
import type { Commitment, Note, Project, Task } from '@recued/contracts';

const NOW = 1_700_000_000_000;

const fakeTask = (overrides: Partial<Task> = {}): Task => ({
  id: 't-1',
  title: 'task',
  done: false,
  blocks_task_ids: [],
  source_id: 'recued.task',
  last_seen_at: NOW,
  sync_state: 'live',
  conflict_policy: 'source_wins',
  created_at: NOW,
  updated_at: NOW,
  ...overrides,
});

const fakeNote = (overrides: Partial<Note> = {}): Note => ({
  id: 'n-1',
  body: 'note',
  created_at: NOW,
  updated_at: NOW,
  last_user_action_at: NOW,
  related_contact_ids: [],
  related_calendar_event_ids: [],
  related_mail_thread_ids: [],
  related_project_ids: [],
  source_id: 'recued.note',
  last_seen_at: NOW,
  sync_state: 'live',
  conflict_policy: 'source_wins',
  ...overrides,
});

const fakeCommitment = (overrides: Partial<Commitment> = {}): Commitment => ({
  id: 'c-1',
  direction: 'outbound',
  statement: 'pay',
  promised_at: NOW,
  lifecycle_state: 'pending',
  due_status: 'no_deadline',
  expiry_policy: 'escalate_overdue',
  created_at: NOW,
  updated_at: NOW,
  state_changed_at: NOW,
  lifecycle_changed_at: NOW,
  due_status_changed_at: NOW,
  derivation: 'user_declared',
  blocks_task_ids: [],
  blocks_project_ids: [],
  source_id: 'recued.commitment',
  last_seen_at: NOW,
  sync_state: 'live',
  conflict_policy: 'source_wins',
  ...overrides,
});

const fakeProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'p-1',
  title: 'proj',
  state: 'active',
  created_at: NOW,
  updated_at: NOW,
  last_activity_at: NOW,
  related_contact_ids: [],
  source_id: 'recued.project',
  last_seen_at: NOW,
  sync_state: 'live',
  conflict_policy: 'source_wins',
  ...overrides,
});

const mkCall = (slug: string, input: Record<string, unknown>): ResolvedCall => ({
  slug,
  risk_tier: 'write',
  input,
  output: {},
});

// ────────────────────────────────────────────────────────────────
// SERVER_NOT_REACHABLE — every PA3 slug surfaces the standard error
// when the dispatcher slot is unwired (ext-only / dbless harnesses).
// ────────────────────────────────────────────────────────────────

describe('PA3 slugs surface SERVER_NOT_REACHABLE without dispatchers', () => {
  const slugs = [
    'task-create', 'task-update', 'task-delete', 'task-mark-done',
    'note-create', 'note-update', 'note-delete',
    'commitment-create', 'commitment-update', 'commitment-fulfill', 'commitment-cancel',
    'project-create', 'project-update', 'project-archive',
  ];
  for (const slug of slugs) {
    it(`${slug}`, async () => {
      const adapter = createKernelAdapter({});
      // Use payload that would pass shape validation if the dispatcher
      // were wired (id for update/delete/lifecycle slugs; title /
      // direction+statement+derivation for create).
      const input: Record<string, unknown> = slug.includes('create')
        ? slug.startsWith('commitment-')
          ? { direction: 'outbound', statement: 's', derivation: 'user_declared' }
          : { title: 't', body: 'b' }
        : { id: 'x' };
      await expect(adapter(mkCall(slug, input))).rejects.toThrow(/SERVER_NOT_REACHABLE|unavailable/);
    });
  }
});

// ────────────────────────────────────────────────────────────────
// Input shape validation — runs before reaching the dispatcher
// ────────────────────────────────────────────────────────────────

describe('PA3 input validation', () => {
  it('task-create rejects missing title', async () => {
    const adapter = createKernelAdapter({
      taskCreate: async () => ({ task: fakeTask() }),
    });
    await expect(adapter(mkCall('task-create', {}))).rejects.toThrow(/title is required/);
  });

  it('task-update rejects missing id', async () => {
    const adapter = createKernelAdapter({
      taskUpdate: async () => ({ task: fakeTask() }),
    });
    await expect(adapter(mkCall('task-update', {}))).rejects.toThrow(/id is required/);
  });

  it('note-create rejects missing body', async () => {
    const adapter = createKernelAdapter({
      noteCreate: async () => ({ note: fakeNote() }),
    });
    await expect(adapter(mkCall('note-create', {}))).rejects.toThrow(/body is required/);
  });

  it('commitment-create rejects missing direction', async () => {
    const adapter = createKernelAdapter({
      commitmentCreate: async () => ({ commitment: fakeCommitment() }),
    });
    await expect(
      adapter(mkCall('commitment-create', { statement: 's', derivation: 'user_declared' })),
    ).rejects.toThrow(/direction is required/);
  });

  it('commitment-create rejects missing statement', async () => {
    const adapter = createKernelAdapter({
      commitmentCreate: async () => ({ commitment: fakeCommitment() }),
    });
    await expect(
      adapter(mkCall('commitment-create', { direction: 'outbound', derivation: 'user_declared' })),
    ).rejects.toThrow(/statement is required/);
  });

  it('commitment-create rejects missing derivation', async () => {
    const adapter = createKernelAdapter({
      commitmentCreate: async () => ({ commitment: fakeCommitment() }),
    });
    await expect(
      adapter(mkCall('commitment-create', { direction: 'outbound', statement: 's' })),
    ).rejects.toThrow(/derivation is required/);
  });

  it('project-create rejects missing title', async () => {
    const adapter = createKernelAdapter({
      projectCreate: async () => ({ project: fakeProject() }),
    });
    await expect(adapter(mkCall('project-create', {}))).rejects.toThrow(/title is required/);
  });

  it('commitment-fulfill rejects missing id', async () => {
    const adapter = createKernelAdapter({
      commitmentFulfill: async () => ({ commitment: fakeCommitment() }),
    });
    await expect(adapter(mkCall('commitment-fulfill', {}))).rejects.toThrow(/id is required/);
  });
});

// ────────────────────────────────────────────────────────────────
// Canonical stamping — every output carries _id + _collection
// ────────────────────────────────────────────────────────────────

describe('PA3 canonical stamping (_id + _collection)', () => {
  it('task-create stamps task with _id + _collection', async () => {
    const adapter = createKernelAdapter({
      taskCreate: async () => ({ task: fakeTask({ id: 'task-xyz', title: 'x' }) }),
    });
    const out = (await adapter(mkCall('task-create', { title: 'x' }))) as { task: { _id: string; _collection: string } };
    expect(out.task._id).toBe('task-xyz');
    expect(out.task._collection).toBe('task');
  });

  it('note-create stamps note with _id + _collection', async () => {
    const adapter = createKernelAdapter({
      noteCreate: async () => ({ note: fakeNote({ id: 'note-abc', body: 'x' }) }),
    });
    const out = (await adapter(mkCall('note-create', { body: 'x' }))) as { note: { _id: string; _collection: string } };
    expect(out.note._id).toBe('note-abc');
    expect(out.note._collection).toBe('note');
  });

  it('commitment-create stamps commitment with _id + _collection', async () => {
    const adapter = createKernelAdapter({
      commitmentCreate: async () => ({ commitment: fakeCommitment({ id: 'c-789' }) }),
    });
    const out = (await adapter(mkCall('commitment-create', {
      direction: 'outbound', statement: 's', derivation: 'user_declared',
    }))) as { commitment: { _id: string; _collection: string } };
    expect(out.commitment._id).toBe('c-789');
    expect(out.commitment._collection).toBe('commitment');
  });

  it('project-create stamps project with _id + _collection', async () => {
    const adapter = createKernelAdapter({
      projectCreate: async () => ({ project: fakeProject({ id: 'p-xyz', title: 'x' }) }),
    });
    const out = (await adapter(mkCall('project-create', { title: 'x' }))) as { project: { _id: string; _collection: string } };
    expect(out.project._id).toBe('p-xyz');
    expect(out.project._collection).toBe('project');
  });

  it('task-mark-done stamps the post-update task', async () => {
    const adapter = createKernelAdapter({
      taskMarkDone: async () => ({ task: fakeTask({ done: true, completed_at: NOW }) }),
    });
    const out = (await adapter(mkCall('task-mark-done', { id: 't-1' }))) as { task: { _collection: string; done: boolean } };
    expect(out.task._collection).toBe('task');
    expect(out.task.done).toBe(true);
  });

  it('commitment-fulfill stamps the moved commitment', async () => {
    const adapter = createKernelAdapter({
      commitmentFulfill: async () => ({ commitment: fakeCommitment({ lifecycle_state: 'fulfilled' }) }),
    });
    const out = (await adapter(mkCall('commitment-fulfill', { id: 'c-1' }))) as { commitment: { _collection: string; lifecycle_state: string } };
    expect(out.commitment._collection).toBe('commitment');
    expect(out.commitment.lifecycle_state).toBe('fulfilled');
  });

  it('project-archive stamps the archived project', async () => {
    const adapter = createKernelAdapter({
      projectArchive: async () => ({ project: fakeProject({ state: 'archived' }) }),
    });
    const out = (await adapter(mkCall('project-archive', { id: 'p-1' }))) as { project: { _collection: string; state: string } };
    expect(out.project._collection).toBe('project');
    expect(out.project.state).toBe('archived');
  });
});

// ────────────────────────────────────────────────────────────────
// Delete output passthrough — { ok, id, tombstoned } no stamping
// ────────────────────────────────────────────────────────────────

describe('PA3 delete output shape', () => {
  it('task-delete returns { ok, id, tombstoned }', async () => {
    const adapter = createKernelAdapter({
      taskDelete: async ({ id, tombstone }) => ({ ok: true as const, id, tombstoned: tombstone !== false }),
    });
    const out = await adapter(mkCall('task-delete', { id: 't-1' }));
    expect(out).toEqual({ ok: true, id: 't-1', tombstoned: true });
  });

  it('note-delete with tombstone: false returns tombstoned: false', async () => {
    const adapter = createKernelAdapter({
      noteDelete: async ({ id, tombstone }) => ({ ok: true as const, id, tombstoned: tombstone !== false }),
    });
    const out = await adapter(mkCall('note-delete', { id: 'n-1', tombstone: false }));
    expect(out).toEqual({ ok: true, id: 'n-1', tombstoned: false });
  });
});
