import { expect, it } from 'vitest';
import { TASK_TITLE_MAX, type Note } from '@recued/contracts';
import { noteTaskValues, sameNoteTaskRecord } from '../note-task.js';
import { parseShellRoute } from '../../shell/route.js';

const note: Note = { id: "shared/id?二.)!'*", source_id: 'recued.note', title: 'Meeting <img src=x>', body: '  Exact text 二\n<script>raw</script>  ',
  created_at: 1, updated_at: 1, last_seen_at: 1, last_user_action_at: 1, sync_state: 'live', conflict_policy: 'recued_wins',
  related_contact_ids: ['contact-one'], related_project_ids: ['project-one'], related_mail_thread_ids: ['thread-one'], related_calendar_event_ids: ['event-one'] };

it('seeds an editable task from saved note text and an exact deployment-path link', () => {
  const before = structuredClone(note), values = noteTaskValues(note, 'https://user:password@app.test/recued/index.html?code=private#views/private');
  expect(values).toEqual({ title: note.title, done: false, due_at: null,
    body: `Note: https://app.test/recued/index.html#data/note/shared%2Fid%3F%E4%BA%8C.)!'*\n\nNote excerpt:\nExact text 二\n<script>raw</script>` });
  expect(parseShellRoute(new URL(String(values.body).split('\n')[0]!.slice(6)).hash).segments).toEqual(['note', note.id]);
  expect(note).toEqual(before); expect(values).not.toHaveProperty('assigned_contact'); expect(values).not.toHaveProperty('parent_project');
});

it('bounds titles and excerpts without cutting an emoji and labels partial quotations', () => {
  const values = noteTaskValues({ ...note, title: '📝'.repeat(TASK_TITLE_MAX), body: 'x'.repeat(599) + '📝rest' }, 'https://app.test/');
  expect(String(values.title).length).toBeLessThanOrEqual(TASK_TITLE_MAX); expect(String(values.title)).not.toMatch(/[\ud800-\udbff]$/u);
  expect(values.body).toBe(`Note: https://app.test/#data/note/shared%2Fid%3F%E4%BA%8C.)!'*\n\nNote excerpt (partial):\n${'x'.repeat(599)}`);
});

it('keeps empty notes useful and identifies unconfirmed source snapshots', () => {
  expect(noteTaskValues({ ...note, title: ' ', body: ' ' }, 'https://app.test/')).toMatchObject({ title: 'Follow up on note', due_at: null });
  expect(noteTaskValues({ ...note, body: '' }, 'https://app.test/').body).toContain('The note has no text.');
  for (const value of [{ ...note, sync_state: 'stale_unreachable' as const }, { ...note, deleted_at: 2 },
    { ...note, pending_write: { staged_at: 2, operation: 'update' as const, dirty_fields: ['body'], state: 'awaiting_verify' as const } }]) {
    expect(noteTaskValues(value, 'https://app.test/').body).toContain('source is unconfirmed');
  }
});

it('refuses unusable source addresses before a task draft can be seeded', () => {
  expect(() => noteTaskValues(note, 'file:///app.html')).toThrow('source note link is unavailable');
  expect(() => noteTaskValues(note, 'not a URL')).toThrow();
});

it('keeps source status separate from identity and rejects reused note addresses', () => {
  const original = { ...note, _kind: 'note' as const };
  expect(sameNoteTaskRecord(original, { ...original, sync_state: 'stale_unreachable' })).toBe(true);
  expect(sameNoteTaskRecord(original, { ...original, created_at: 2 })).toBe(false);
  expect(sameNoteTaskRecord(original, { ...original, source_id: 'other.note' })).toBe(false);
  expect(sameNoteTaskRecord(original, { ...original, source_record_id: 'reused-native-id' })).toBe(false);
  expect(sameNoteTaskRecord(original, null)).toBe(false);
});
