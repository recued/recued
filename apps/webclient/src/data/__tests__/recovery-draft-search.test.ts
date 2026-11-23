import { expect, it } from 'vitest';
import type { CalendarCreateDraft } from '../calendar-create-surface.js';
import { createCalendarRecoveryStore } from '../calendar-draft-recovery.js';
import { createNoteRecoveryStore, noteDraftValues } from '../note-draft-recovery.js';
import { createWorkRecoveryStore } from '../work-draft-recovery.js';
import { searchRecoveryDrafts, resolveRecoveryDraft, type RecoveryDraftStores } from '../recovery-draft-search.js';
import { renderUniversalSearch, type UniversalSearchProps } from '../universal-search.js';
import { filterUniversalSearch, searchTypeCounts } from '../universal-search-filter.js';

const initial = Date.parse('2026-11-20T12:00Z');
const setup = () => {
  const raw = new Map<string, string>(); let clock = initial, blocked = false;
  const storage = { getItem: (key: string) => { if (blocked) throw Error('Storage blocked'); return raw.get(key) ?? null; },
    setItem: (key: string, value: string) => { raw.set(key, value); }, removeItem: (key: string) => { raw.delete(key); } };
  const note = createNoteRecoveryStore({ scope: 'server-one', storage, now: () => clock });
  const task = createWorkRecoveryStore({ scope: 'server-one', kind: 'task', storage, now: () => clock });
  const project = createWorkRecoveryStore({ scope: 'server-one', kind: 'project', storage, now: () => clock });
  const calendar = createCalendarRecoveryStore({ scope: 'server-one', storage, now: () => clock });
  const base = (prefix: string, sourceId: string) => ({ id: prefix + crypto.randomUUID(), revision: 1, updatedAt: initial, sourceId, original: null, status: 'editing' as const });
  const noteRow = { ...base('ndr_', 'recued.note'), values: noteDraftValues({ title: 'Launch notes', body: 'Café agenda\nKeep the customer context.' }) };
  const taskRow = { ...base('wdr_', 'recued.task'), values: { title: 'Launch task', body: 'Review the invoice.' } };
  const projectRow = { ...base('wdr_', 'recued.project'), values: { title: 'Launch project', description: 'Review the contract.' } };
  const draft: CalendarCreateDraft = { destination: '', summary: 'Launch meeting', description: 'Meeting agenda', location: 'Room Two',
    start: '', end: '', startChoice: '', endChoice: '', allDay: false, guests: [], guestQuery: '' };
  const creationId = crypto.randomUUID();
  const calendarRow = { ...base('cdr_', 'calendar'), values: { draft, zone: 'UTC', calendarName: 'Work calendar', incarnation: null, creationId, request: null } };
  expect(note.save(noteRow)).toBe(true); expect(task.save(taskRow)).toBe(true); expect(project.save(projectRow)).toBe(true); expect(calendar.save(calendarRow)).toBe(true);
  return { raw, storage, note, task, project, calendar, noteRow, taskRow, projectRow, calendarRow, creationId,
    stores: { note, task, project, calendar } satisfies RecoveryDraftStores,
    block: () => { blocked = true; }, advance: () => { clock += 8 * 86_400_000; } };
};

it('searches current titles and text across all four codecs and excludes request metadata', () => {
  const f = setup();
  expect(searchRecoveryDrafts(f.stores, 'launch').matches.map(row => row.kind).sort()).toEqual(['calendar', 'note', 'project', 'task']);
  expect(searchRecoveryDrafts(f.stores, ' LAUNCH   cafe\u0301 ').matches.map(row => row.kind)).toEqual(['note']);
  expect(searchRecoveryDrafts(f.stores, 'invoice').matches[0]!.excerpt).toContain('invoice');
  expect(searchRecoveryDrafts(f.stores, 'contract').matches[0]!.kind).toBe('project');
  expect(searchRecoveryDrafts(f.stores, 'room two').matches[0]!.kind).toBe('calendar');
  expect(searchRecoveryDrafts(f.stores, f.creationId).matches).toEqual([]);
  expect(searchRecoveryDrafts(f.stores, '').matches).toHaveLength(4);
  const first = searchRecoveryDrafts(f.stores, 'invoice').matches[0]!, next = searchRecoveryDrafts(f.stores, 'invoice').matches[0]!;
  expect(next.key).toBe(first.key); expect(next.token).not.toBe(first.token);
  expect(f.note.save({ ...f.noteRow, revision: 2, values: noteDraftValues({ title: 'Long Unicode note', body: 'E\u0301'.repeat(300) + 'İ'.repeat(300) + ' cobalt target' }) })).toBe(true);
  expect(searchRecoveryDrafts(f.stores, 'cobalt').matches[0]!.excerpt).toContain('cobalt target');
});

it('uses only supplied pairing scopes and neither reads nor admits another server recovery', () => {
  const f = setup(), foreign = createNoteRecoveryStore({ scope: 'server-two', storage: f.storage, now: () => initial });
  expect(foreign.save({ ...f.noteRow, values: noteDraftValues({ title: 'Other server secret', body: 'Foreign body' }) })).toBe(true);
  expect(searchRecoveryDrafts(f.stores, 'secret').matches).toEqual([]);
  const match = searchRecoveryDrafts({ note: foreign }, 'secret').matches[0]!;
  expect(resolveRecoveryDraft(f.stores, match)).toBeNull();
  expect(searchRecoveryDrafts({ note: foreign }, 'customer').matches).toEqual([]);
});

it('rechecks revision, status, source and expiration instead of replacing an older search choice with a newer draft', () => {
  const f = setup(), old = searchRecoveryDrafts(f.stores, 'invoice').matches[0]!;
  expect(resolveRecoveryDraft(f.stores, old)).toEqual(f.taskRow);
  expect(f.task.save({ ...f.taskRow, revision: 2, values: { title: 'Changed draft', body: 'New text' } })).toBe(true);
  expect(resolveRecoveryDraft(f.stores, old)).toBeNull();
  const current = searchRecoveryDrafts(f.stores, 'Changed').matches[0]!;
  expect(f.task.save({ ...f.taskRow, revision: 2, sourceId: 'other.task' })).toBe(true);
  expect(resolveRecoveryDraft(f.stores, current)).toBeNull();
  const noteMatch = searchRecoveryDrafts(f.stores, 'notes').matches[0]!;
  f.advance(); expect(searchRecoveryDrafts(f.stores, '').matches).toEqual([]);
  expect(resolveRecoveryDraft(f.stores, noteMatch)).toBeNull();
});

it('reports unreadable stores separately from empty stores, preserving readable groups', () => {
  const f = setup(), empty = createNoteRecoveryStore({ scope: 'empty', storage: f.storage, now: () => initial });
  expect(searchRecoveryDrafts({ note: empty }, '')).toMatchObject({ available: true, matches: [], issues: [] });
  f.block(); const failed = searchRecoveryDrafts({ note: f.note }, '');
  expect(failed.matches).toEqual([]); expect(failed.issues).toHaveLength(1);
  const partial = searchRecoveryDrafts({ note: f.note, task: { list: () => [f.taskRow], get: () => f.taskRow } }, 'launch');
  expect(partial.matches.map(row => row.kind)).toEqual(['task']); expect(partial.issues).toHaveLength(1);
  expect(searchRecoveryDrafts({}, '')).toMatchObject({ available: false, matches: [], issues: [] });
});

it('combines saved mail and tab recoveries under Drafts with correct counts, scoping and an empty-query browse', () => {
  const f = setup();
  const props: UniversalSearchProps = { query: 'launch', actionAttr: 'data-action', resultType: 'draft', groups: [], workGroups: [],
    recoveryDraftSearch: searchRecoveryDrafts(f.stores, 'launch'),
    draftSearch: { query: 'launch', loading: false, next_cursor: null, matches: [{ draft_id: 'mad_' + crypto.randomUUID(), subject: 'Launch email',
      updated_at: initial, created_at: initial, sender_mail_instance: 'work', incarnation: 'mail-one', revision: 1, origin_contract_id: null, to: [], cc: [], bcc: [] }] } };
  expect(searchTypeCounts(props).draft).toEqual({ loaded: 5, pending: false, unavailable: false, more: false });
  const html = renderUniversalSearch(props); expect(html).toContain('5 in 2 places'); expect(html).toContain('Saved mail drafts');
  expect(html).toContain('Unfinished work in this tab'); expect(html).toContain('this server and this browser tab');
  expect(filterUniversalSearch(props, 'task').recoveryDraftSearch).toBeUndefined();
  expect(renderUniversalSearch({ ...props, query: '' })).toContain('Resume task draft Launch task');
});

it('labels unconfirmed entries for review and escapes user text while retaining available results during storage failure', () => {
  const f = setup();
  expect(f.task.save({ ...f.taskRow, status: 'unknown', attempt: crypto.randomUUID(), values: { title: '<img src=x> Launch', body: '<script>bad()</script>' } })).toBe(true);
  const state = searchRecoveryDrafts(f.stores, 'launch');
  const html = renderUniversalSearch({ query: 'launch', actionAttr: 'data-action', resultType: 'draft', recoveryDraftSearch: state });
  expect(html).toContain('Review unconfirmed task draft &lt;img src=x&gt; Launch'); expect(html).toContain('Save not confirmed');
  expect(html).not.toContain('<img src=x>'); expect(html).not.toContain('<script>');
  const failed = renderUniversalSearch({ query: 'launch', actionAttr: 'data-action', resultType: 'draft', recoveryDraftSearch: { ...state, issues: ['Note recovery copies could not be read.'] } });
  expect(failed).toContain('Note recovery copies could not be read.'); expect(failed).not.toContain('No Drafts results');
});
