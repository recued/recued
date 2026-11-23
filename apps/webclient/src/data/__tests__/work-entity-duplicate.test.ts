import { describe, expect, it } from 'vitest';
import type { SourceRegistration, WorkEntity } from '@recued/contracts';
import { duplicateDestinations, duplicateWorkValues, isDuplicateEntity, sameDuplicateEntity } from '../work-entity-duplicate.js';

const base = { id: 'original', source_id: 'recued.task', source_record_id: 'native-original', created_at: 100, updated_at: 200,
  last_seen_at: 200, sync_state: 'live' as const, conflict_policy: 'recued_wins' as const, source_extension_blob: { private: 'do not copy' } };
const task: Extract<WorkEntity, { _kind: 'task' }> = { ...base, _kind: 'task', title: 'Original task', body: 'Task notes', done: true, due_at: 300, completed_at: 250,
  priority: 'high', assigned_contact_id: 'person@example.test', parent_calendar_event_id: 'event', linked_mail_thread_id: 'thread',
  parent_project_id: 'project', blocks_task_ids: ['blocked'] };
const note: Extract<WorkEntity, { _kind: 'note' }> = { ...base, _kind: 'note', source_id: 'recued.note', title: 'Original note', body: '\n  # Café 🧾\n<script>literal</script>\nTrailing spaces  \n',
  last_user_action_at: 200, related_contact_ids: ['contact'], related_calendar_event_ids: ['event'], related_mail_thread_ids: ['thread'], related_project_ids: ['project'] };

describe('new task and note drafts from canonical originals', () => {
  it('whitelists task content and links while resetting completion and deadline', () => {
    const values = duplicateWorkValues(task);
    expect(values).toEqual({ title: task.title, body: task.body, done: false, due_at: null, priority: 'high',
      assigned_contact: 'person@example.test', parent_calendar_event: 'event', linked_mail_thread: 'thread', parent_project: 'project', blocks_task: ['blocked'] });
    (values.blocks_task as string[]).push('local edit'); expect(task.blocks_task_ids).toEqual(['blocked']);
  });

  it('preserves raw note Markdown and every canonical relationship without sharing mutable arrays', () => {
    const values = duplicateWorkValues(note);
    expect(values).toEqual({ title: note.title, body: note.body, related_contact: ['contact'], related_calendar_event: ['event'],
      related_mail_thread: ['thread'], related_project: ['project'] });
    (values.related_project as string[]).push('local edit'); expect(note.related_project_ids).toEqual(['project']);
  });

  it('allows fresh content but refuses changed identity and non-live originals', () => {
    expect(sameDuplicateEntity(task, { ...task, title: 'Latest saved title', updated_at: 400 })).toBe(true);
    for (const fresh of [null, note, { ...task, id: 'other' }, { ...task, source_id: 'other' }, { ...task, source_record_id: 'reused' },
      { ...task, created_at: 101 }, { ...task, deleted_at: 201 }, { ...task, sync_state: 'stale_unreachable' },
      { ...task, pending_write: { staged_at: 201, operation: 'update', dirty_fields: ['title'], state: 'awaiting_verify' } }] as Array<WorkEntity | null>) {
      expect(sameDuplicateEntity(task, fresh)).toBe(false);
    }
    expect(isDuplicateEntity(null)).toBe(false);
  });

  it('offers only current writable destinations of the correct kind', () => {
    const source: SourceRegistration = { id: 'recued.task', source_kind: 'builtin', top_tier_kind: 'task', source_label: 'Recued', write_capable: true, registered_at: 100 };
    expect(duplicateDestinations([source, { ...source, id: 'readonly', write_capable: false },
      { ...source, id: 'through', sync_posture: 'read_through' }, { ...source, id: 'note', top_tier_kind: 'note' }], 'task')).toEqual([source]);
  });
});
