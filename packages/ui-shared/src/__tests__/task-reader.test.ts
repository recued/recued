import { describe, expect, it } from 'vitest';
import { timedDueMs, type WorkEntity } from '@recued/contracts';
import { renderTaskReader, taskDeadlineLabel } from '../work-entity-page/task-reader.js';

type Task = Extract<WorkEntity, { _kind: 'task' }>;
const task: Task = { _kind: 'task', id: 'task-one', title: 'Launch <img src=x>', body: 'First line\n<script>unsafe()</script>',
  source_id: 'recued.task', sync_state: 'live', conflict_policy: 'recued_wins', created_at: 1, updated_at: 1, last_seen_at: 1,
  done: false, priority: 'high', blocks_task_ids: [] };

describe('task reader', () => {
  it('reads saved fields as escaped text without creating an editable form', () => {
    const html = renderTaskReader({ entity: task, mode: 'read', can_edit: true }, { source_label: 'Recued', completion: { can_change: true } });
    expect(html).toContain('Launch &lt;img src=x&gt;');
    expect(html).toContain('First line\n&lt;script&gt;unsafe()&lt;/script&gt;');
    expect(html).toContain('No due date'); expect(html).toContain('High');
    expect(html).toContain('data-action="edit-task"'); expect(html).toContain('data-action="complete-work-entity-task"');
    expect(html).not.toMatch(/<form|<input|<textarea|<script|<img/u);
  });

  it('keeps whole-day deadlines in their calendar date and distinguishes timed midnight', () => {
    const day = Date.parse('2030-11-01T00:00:00Z');
    expect(taskDeadlineLabel({ due_at: day })).toBe(new Date(day).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' }));
    const timed = timedDueMs(day);
    expect(taskDeadlineLabel({ due_at: timed })).toBe(new Date(timed).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }));
  });

  it('makes only verified related records actionable and leaves unavailable records retryable', () => {
    const html = renderTaskReader({ entity: task, mode: 'read', can_edit: false, related: { more: false, records: [
      { key: 'contact:opaque-id', kind: 'contact', label: 'Riley <img>', state: 'ready' },
      { key: 'project:opaque-id', kind: 'project', label: 'Project', state: 'missing', message: 'This project is no longer available.' },
    ] } }, { source_label: 'Read only' });
    expect(html).toContain('aria-label="Open contact Riley &lt;img&gt;"');
    expect(html).toContain('data-action="retry-task-related"'); expect(html).toContain('This project is no longer available.');
    expect(html).not.toContain('data-action="edit-task"'); expect(html).not.toContain('data-action="open-task-related" data-task-related-key="project:');
    expect(html).not.toContain('work-entity-task-due-today');
  });

  it('shows uncertainty and errors without a completion or edit action', () => {
    const html = renderTaskReader({ entity: { ...task, sync_state: 'stale_unreachable' }, mode: 'read', can_edit: false },
      { source_label: 'Offline', error: 'Could not confirm <change>', close_label: 'Back to Today' });
    expect(html).toContain('task may be out of date'); expect(html).toContain('role="alert"');
    expect(html).toContain('Could not confirm &lt;change&gt;'); expect(html).toContain('Back to Today');
    expect(html).not.toContain('data-action="complete-work-entity-task"');
  });
});

it('renders dependency status separately, escapes linked names, and keeps a refreshing return target focusable', () => {
  const html = renderTaskReader({ entity: task, mode: 'read', can_edit: true, dependency_summary: 'Waiting on 1 task · Some status unconfirmed',
    dependency_list_uncertain: true, related: { more: true, records: [
      { key: 'task:opaque-id', kind: 'task', label: 'Review <img>', state: 'ready', task: { source: 'Recued', done: false, current: true, pending: false } },
      { key: 'task:held', kind: 'task', label: 'Previously read', state: 'loading', can_open: true },
      { key: 'task:missing', kind: 'task', label: 'Linked task', state: 'missing', message: 'This task is no longer available.' },
    ] } }, { source_label: 'Recued' });
  expect(html).toContain('Depends on'); expect(html).toContain('Waiting on 1 task · Some status unconfirmed');
  expect(html).toContain('saved dependency list may be out of date'); expect(html).toContain('Recued · Open');
  expect(html).toContain('aria-label="Open task Review &lt;img&gt;"');
  expect(html).toMatch(/data-task-related-key="task:held"[^>]*aria-disabled="true"/u);
  expect(html).not.toMatch(/data-task-related-key="task:held"[^>]* disabled/u);
  expect(html).toContain('More dependencies'); expect(html).toContain('Check dependencies again');
  expect(html).not.toContain('aria-label="Related records"');
  expect(renderTaskReader({ entity: task, mode: 'read', can_edit: true }, { source_label: 'Recued' })).not.toContain('Depends on');
});

it('opens saved note URLs as links while retaining the full task text and read mode', () => {
  const html = renderTaskReader({ entity: { ...task, body: 'Email: https://recued.test/#data/mail/record/work/mail-one\nKeep the quoted context.' }, mode: 'read', can_edit: true }, { source_label: 'Recued' });
  expect(html).toContain('href="https://recued.test/#data/mail/record/work/mail-one"');
  expect(html).toContain('data-task-note-link="0"'); expect(html).toContain('Keep the quoted context.'); expect(html).not.toContain('<textarea');
});

it('offers task Find with an escaped query and exposes broader search only when supported', () => {
  const context = { source_label: 'Recued' };
  const view = { entity: task, mode: 'read' as const, can_edit: false, find: { open: true, query: '"><img src=x>', can_search_everywhere: true } };
  const html = renderTaskReader(view, context);
  expect(html).toContain('aria-label="Find in this task"'); expect(html).toContain('value="&quot;&gt;&lt;img src=x&gt;"');
  expect(html).toContain('aria-label="Previous match"'); expect(html).toContain('aria-label="Next match"');
  expect(html).toContain('data-action="task-find-everywhere"'); expect(html).not.toContain('<img');
  expect(renderTaskReader({ ...view, find: { open: true, query: '' } }, context)).not.toContain('task-find-everywhere');
});
