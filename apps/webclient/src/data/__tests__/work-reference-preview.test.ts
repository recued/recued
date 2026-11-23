import { expect, it, vi } from 'vitest';
import type { ContactRecord, SourceRegistration, WorkEntity, WorkEntityPendingWrite } from '@recued/contracts';
import { loadContactReferencePreview, loadWorkReferencePreview } from '../work-reference-preview.js';

const project: Extract<WorkEntity, { _kind: 'project' }> = { _kind: 'project', id: 'p1', title: 'Launch', description: 'A project summary', state: 'active',
  source_id: 'recued.project', sync_state: 'live', conflict_policy: 'recued_wins', created_at: 1, updated_at: 1, last_seen_at: 1, last_activity_at: 1, related_contact_ids: [] };
const sources: SourceRegistration[] = [{ id: 'recued.project', top_tier_kind: 'project', source_kind: 'builtin', source_label: 'Recued', write_capable: true, registered_at: 1 }];
const person: ContactRecord = { _id: 'riley@example.test', _collection: 'contact', email: 'riley@example.test', contact_id: 'person-id', name: 'Riley', company: 'Example <team>',
  phone: '+14155550123', source: 'manual', first_seen: 1, last_interaction: 1, interaction_count: 0, created_at: 1, updated_at: 1 };

it('previews merged contact details without changing the reference or exposing mention-only addresses', async () => {
  const get = vi.fn(async ({ email }: { email: string }) => ({ contact: email === 'old@example.test' ? { ...person, email, merged_into: person.email } : person }));
  expect(await loadContactReferencePreview(get, 'old@example.test')).toEqual({ state: 'ready', title: 'Riley',
    fields: [['Email', person.email], ['Company', 'Example <team>'], ['Phone', person.phone!]], notice: 'Merged contact. The saved reference is unchanged.' });
  expect(get.mock.calls.map(([args]) => args.email)).toEqual(['old@example.test', person.email]);
  const email = 'mention-only-01ARZ3NDEKTSV4RRFFQ69G5FAV@_recued.invalid';
  const preview = await loadContactReferencePreview(async () => ({ contact: { ...person, email, name: undefined } }), email);
  expect(preview.title).toBe('Unnamed contact'); expect(preview.fields).toContainEqual(['Email', 'No email address']); expect(JSON.stringify(preview)).not.toContain(email);
});

it('reads only the selected work identity, retaining source warnings and a bounded Unicode summary', async () => {
  const pending: WorkEntityPendingWrite = { staged_at: 1, operation: 'update', dirty_fields: ['description'], state: 'pending' };
  const get = vi.fn(async () => ({ entity: { ...project, sync_state: 'stale_unreachable' as const, pending_write: pending, description: '🚀'.repeat(1201) } }));
  const preview = await loadWorkReferencePreview(get, 'project', 'p1', sources);
  expect(get).toHaveBeenCalledExactlyOnceWith({ kind: 'project', id: 'p1' });
  expect(preview).toMatchObject({ state: 'ready', title: 'Launch', notice: expect.stringMatching(/last synced.*changes waiting/) });
  expect(preview.fields).toEqual([['Status', 'active'], ['Source', 'Recued'], ['Summary', '🚀'.repeat(1200) + '…']]);
  await expect(loadWorkReferencePreview(get, 'project', 'other', sources)).rejects.toThrow('could not be confirmed');
  await expect(loadWorkReferencePreview(get, 'task', 'p1', sources)).rejects.toThrow('could not be confirmed');
});

it('keeps missing records distinct from failed reads and refuses obsolete contact redirects', async () => {
  expect(await loadWorkReferencePreview(async () => ({ entity: { ...project, deleted_at: 2 } }), 'project', 'p1', sources))
    .toMatchObject({ state: 'missing', fields: [], notice: expect.stringContaining('link is kept') });
  expect(await loadContactReferencePreview(async () => ({ contact: null }), person.contact_id!)).toMatchObject({ state: 'missing', fields: [] });
  await expect(loadWorkReferencePreview(async () => { throw new Error('Read interrupted'); }, 'project', 'p1', sources)).rejects.toThrow('Read interrupted');
  const get = vi.fn(async () => ({ contact: { ...person, merged_into: 'other@example.test' } }));
  await expect(loadContactReferencePreview(get, person.email, () => false)).rejects.toThrow('retired'); expect(get).not.toHaveBeenCalled();
});

it('shows task completion, notes and due date and refuses malformed dates', async () => {
  const task: Extract<WorkEntity, { _kind: 'task' }> = { ...project, _kind: 'task', done: true, blocks_task_ids: [], body: 'Review this checklist', priority: 'high', due_at: Date.UTC(2026, 10, 21, 18) };
  const preview = await loadWorkReferencePreview(async () => ({ entity: task }), 'task', 'p1', sources);
  expect(preview.fields).toContainEqual(['Status', 'Completed']); expect(preview.fields).toContainEqual(['Notes', task.body]);
  expect(preview.fields.find(([label]) => label === 'Due')?.[1]).toMatch(/2026/);
  await expect(loadWorkReferencePreview(async () => ({ entity: { ...task, due_at: NaN } }), 'task', 'p1', sources)).rejects.toThrow('due date could not be confirmed');
});
