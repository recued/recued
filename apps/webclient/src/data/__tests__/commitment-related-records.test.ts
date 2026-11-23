import { expect, it, vi } from 'vitest';
import type { Commitment, ContactRecord, SourceRegistration, WorkEntity } from '@recued/contracts';
import { createCommitmentRelatedRecords } from '../commitment-related-records.js';

const base = { created_at: 100, updated_at: 200, last_seen_at: 200, sync_state: 'live' as const, conflict_policy: 'recued_wins' as const };
const person: ContactRecord = { _id: 'person@example.test', _collection: 'contact', email: 'person@example.test', contact_id: 'contact-one', name: 'Riley', company: 'Example <team>', source: 'manual',
  created_at: 100, updated_at: 200, first_seen: 100, last_interaction: 200, interaction_count: 0 };
const project: Extract<WorkEntity, { _kind: 'project' }> = { ...base, _kind: 'project', id: 'project-one', source_id: 'recued.project',
  title: 'Launch project', description: 'The launch plan.', state: 'active', related_contact_ids: [], last_activity_at: 200 };
const task: Extract<WorkEntity, { _kind: 'task' }> = { ...base, _kind: 'task', id: 'promise-one', source_id: 'recued.task', title: 'A task with the same ID as the promise',
  body: 'Keep these notes.', done: false, blocks_task_ids: [] };
const promise: Commitment = { ...base, id: 'promise-one', source_id: 'recued.commitment', statement: 'Send the proposal', direction: 'outbound',
  promised_at: 100, lifecycle_state: 'pending', due_status: 'no_deadline', expiry_policy: 'indefinite', derivation: 'user_declared',
  state_changed_at: 100, lifecycle_changed_at: 100, due_status_changed_at: 100, counterparty_contact_id: 'contact-one',
  blocks_project_ids: ['project-one'], blocks_task_ids: ['promise-one'] };
const sources: SourceRegistration[] = (['task', 'project', 'commitment'] as const).map(kind => ({ id: `recued.${kind}`, top_tier_kind: kind,
  source_kind: 'builtin', source_label: 'Recued', write_capable: true, mcp_exposed: false, enabled: true, registered_at: 1 }));
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const make = (extra: Partial<Parameters<typeof createCommitmentRelatedRecords>[0]> = {}) => createCommitmentRelatedRecords({
  contact: async () => ({ contact: person }), work: async ({ kind }) => ({ entity: kind === 'task' ? task : project }),
  sources: () => sources, now: () => 200, active: () => true, changed() {}, ...extra,
});

it('reads stored links lazily, deduplicates them, and keeps task IDs in their own namespace', async () => {
  const get = vi.fn(async ({ kind }: { kind: string; id: string }) => ({ entity: kind === 'task' ? task : project }));
  const model = make({ work: get }); model.open({ ...promise, blocks_task_ids: [task.id, task.id] });
  expect(get).not.toHaveBeenCalled(); await model.load();
  expect(model.view().records).toMatchObject([{ kind: 'contact', label: 'Riley', state: 'ready' },
    { kind: 'project', label: 'Launch project', status: 'active' }, { kind: 'task', label: task.title, status: 'Open' }]);
  expect(await model.activate(`task:${task.id}`)).toMatchObject({ kind: 'task', task: { id: promise.id } });
  expect(promise.blocks_task_ids).toEqual([task.id]);
});

it('bounds pages across projects and tasks and limits concurrent reads', async () => {
  let active = 0, maximum = 0; const held = deferred<void>();
  const get = vi.fn(async ({ id }: { kind: string; id: string }) => {
    active++; maximum = Math.max(maximum, active); await held.promise; active--;
    return { entity: { ...project, id } };
  });
  const model = make({ work: get }); model.open({ ...promise, counterparty_contact_id: undefined, blocks_task_ids: [],
    blocks_project_ids: Array.from({ length: 25 }, (_, i) => `project-${i}`) });
  const loading = model.load(); await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(4)); held.resolve(); await loading;
  expect(model.view().records).toHaveLength(20); expect(get).toHaveBeenCalledTimes(20); expect(maximum).toBeLessThanOrEqual(4);
  model.more(); await vi.waitFor(() => expect(model.view().records.at(-1)?.state).toBe('ready'));
  expect(get).toHaveBeenCalledTimes(25); expect(model.view().more).toBe(false);
});

it('freshly checks previews and opens, and refuses a reused target identity', async () => {
  let current = project;
  const get = vi.fn(async () => ({ entity: current }));
  const model = make({ work: get }); model.open({ ...promise, counterparty_contact_id: undefined, blocks_task_ids: [] }); await model.load();
  current = { ...project, description: 'Updated saved details.' }; await model.preview('project:project-one');
  expect(get).toHaveBeenCalledTimes(2); expect(model.view().records[0]?.preview?.fields).toContainEqual(['Summary', 'Updated saved details.']);
  current = { ...project, created_at: 999 }; expect(await model.activate('project:project-one')).toBeNull();
  expect(model.view().records[0]).toMatchObject({ state: 'unavailable', can_open: false });
  expect(model.view().records[0]?.preview).toBeUndefined();
});

it('refreshes saved names and preview details on return without treating pending completion as confirmed', async () => {
  let current = task;
  const model = make({ work: async () => ({ entity: current }) });
  model.open({ ...promise, counterparty_contact_id: undefined, blocks_project_ids: [] }); await model.load(); await model.preview(`task:${task.id}`);
  current = { ...task, title: 'Updated task', done: true, pending_write: { operation: 'update', staged_at: 200, dirty_fields: ['done'], state: 'pending' } };
  model.refresh(); await model.load();
  expect(model.view().records[0]).toMatchObject({ label: 'Updated task', expanded: true, status: 'Status unconfirmed' });
  expect(model.view().records[0]?.preview?.fields).toContainEqual(['Saved status', 'Completed']);
  expect(model.view().records[0]?.preview?.notice).toContain('status is unconfirmed');
});

it('keeps missing and failed links retryable without navigation or invented names', async () => {
  let recovered = false;
  const model = make({ contact: async () => ({ contact: recovered ? person : null }), work: async () => { if (!recovered) throw new Error('Interrupted.'); return { entity: project }; } });
  model.open({ ...promise, blocks_task_ids: [] }); await model.load();
  expect(model.view().records).toMatchObject([{ label: 'Linked contact 1', state: 'missing' }, { label: 'Linked project 1', state: 'unavailable' }]);
  recovered = true; model.retry('contact:contact-one'); model.retry('project:project-one');
  await vi.waitFor(() => expect(model.view().records.every(row => row.state === 'ready')).toBe(true));
  expect(await model.activate('contact:contact-one')).toMatchObject({ contact: { contact_id: 'contact-one' } });
});

it('does not silently adopt a replacement during a return refresh; retry requires a new review', async () => {
  let current = project;
  const model = make({ work: async () => ({ entity: current }) });
  model.open({ ...promise, counterparty_contact_id: undefined, blocks_task_ids: [] }); await model.load(); await model.preview('project:project-one');
  current = { ...project, created_at: 999, title: 'Replacement project' }; model.refresh(); await model.load();
  expect(model.view().records[0]).toMatchObject({ label: 'Launch project', state: 'unavailable', expanded: true, can_open: false });
  expect(model.view().records[0]?.preview).toBeUndefined(); expect(await model.activate('project:project-one')).toBeNull();
  model.retry('project:project-one'); await vi.waitFor(() => expect(model.view().records[0]?.state).toBe('ready'));
  expect(model.view().records[0]?.label).toBe('Replacement project');
});

it('retires a delayed preview and its disclosure when a different promise owns the reader', async () => {
  let hold = false; const held = deferred<{ entity: WorkEntity }>();
  const model = make({ work: async () => hold ? held.promise : { entity: project } });
  model.open({ ...promise, counterparty_contact_id: undefined, blocks_task_ids: [] }); await model.load(); hold = true;
  const preview = model.preview('project:project-one');
  model.open({ ...promise, id: 'promise-two', counterparty_contact_id: undefined, blocks_task_ids: [], blocks_project_ids: [] });
  held.resolve({ entity: project }); await preview;
  expect(model.view().records).toEqual([]); expect(model.expandedKey()).toBeNull();
});
