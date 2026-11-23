import { expect, it } from 'vitest';
import { createRecentWorkRecords, recentWorkRecord, recentSourceRecord, type RecentWorkRecord, type RecentWorkEntityRecord } from '../recent-work-records.js';
import type { RecentSearchStorage } from '../recent-searches.js';

const record = (id: string, kind: 'task' | 'note' = 'task'): RecentWorkEntityRecord => ({ kind, id, title: `Record ${id}`,
  source_id: `recued.${kind}`, source_label: 'Recued', created_at: 1 });
const memory = () => {
  const data = new Map<string, string>();
  const storage: RecentSearchStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } };
  return { storage, data };
};

it('keeps eight exact identities, promotes reopened records, refreshes labels, and stores references', () => {
  const { storage, data } = memory(), recent = createRecentWorkRecords({ scope: 'pair', storage });
  for (let i = 0; i < 10; i++) recent.remember(record(`${i}`));
  recent.remember({ ...record('5'), title: 'Revised title' }); recent.remember(record('5', 'note'));
  expect(recent.list().map(row => [row.kind, row.id])).toEqual([['note', '5'], ['task', '5'], ...['9', '8', '7', '6', '4', '3'].map(id => ['task', id])]);
  expect(recent.list()[1]!.title).toBe('Revised title');
  const exposed = recent.list() as RecentWorkRecord[]; exposed[0]!.title = 'Changed outside'; exposed.length = 0;
  expect(createRecentWorkRecords({ scope: 'pair', storage }).list()).toEqual(recent.list());
  const entity = { _kind: 'note' as const, id: 'note', body: 'Private body', title: '', source_id: 'recued.note', created_at: 4,
    updated_at: 4, last_seen_at: 4, last_user_action_at: 4, sync_state: 'live' as const, conflict_policy: 'recued_wins' as const,
    related_contact_ids: [], related_calendar_event_ids: [], related_mail_thread_ids: [], related_project_ids: [] };
  recent.remember(recentWorkRecord(entity, 'Recued'));
  expect(recent.list()[0]!.title).toBe('Note'); expect([...data.values()].join('')).not.toContain('Private body');
});

it('isolates pairings and persists exact removal and clearing without affecting another scope', () => {
  const { storage } = memory(), first = createRecentWorkRecords({ scope: 'server/pair1', storage }), other = createRecentWorkRecords({ scope: 'other/pair1', storage });
  first.remember(record('same')); first.remember(record('same', 'note')); other.remember(record('same'));
  expect(first.remove('task', 'same')).toBe(true); expect(createRecentWorkRecords({ scope: 'server/pair1', storage }).list()).toEqual([record('same', 'note')]);
  expect(createRecentWorkRecords({ scope: 'server/pair2', storage }).list()).toEqual([]);
  expect(first.clear()).toBe(true); expect(createRecentWorkRecords({ scope: 'server/pair1', storage }).list()).toEqual([]); expect(other.list()).toEqual([record('same')]);
});

it('validates and bounds restored data while preserving opaque identifiers', () => {
  const { storage, data } = memory(), recent = createRecentWorkRecords({ scope: 'pair', storage }); recent.remember(record('initial'));
  const key = [...data.keys()][0]!;
  data.set(key, JSON.stringify([null, { ...record('bad'), kind: 'project' }, { ...record('bad'), id: 'bad\u0000id' }, { ...record('bad'), created_at: '1' },
    { ...record("shared/id?二!'*"), title: '  <img src=x>\nlabel  ', source_label: 'x'.repeat(1000), body: 'Ignored private body' }, record('same'), record('same'), ...Array.from({ length: 20 }, (_, i) => record(`${i}`))]));
  const restored = createRecentWorkRecords({ scope: 'pair', storage });
  expect(restored.list()).toHaveLength(8); expect(restored.list()[0]).toEqual({ ...record("shared/id?二!'*"), title: '<img src=x> label', source_label: 'x'.repeat(160) });
  expect(restored.list().filter(row => row.id === 'same')).toHaveLength(1);
  for (const raw of ['{broken', '{}', 'x'.repeat(65_537)]) { data.set(key, raw); expect(createRecentWorkRecords({ scope: 'pair', storage }).list()).toEqual([]); }
  const large = createRecentWorkRecords({ scope: 'large', storage });
  for (let i = 0; i < 8; i++) large.remember({ ...record(`${i}` + '"'.repeat(2047)), source_id: '\\'.repeat(2048), title: '"'.repeat(480), source_label: '"'.repeat(160) });
  expect(createRecentWorkRecords({ scope: 'large', storage }).list()).toEqual(large.list());
});

it('keeps failed removal retryable and continues in memory when browser storage is unavailable', () => {
  const { storage } = memory(); let fail = false;
  const recent = createRecentWorkRecords({ scope: 'pair', storage: { ...storage,
    setItem(key, value) { if (fail) throw Error('Blocked'); storage.setItem(key, value); },
    removeItem(key) { if (fail) throw Error('Blocked'); storage.removeItem(key); } } });
  recent.remember(record('one')); fail = true;
  expect(recent.remove('task', 'one')).toBe(false); expect(recent.clear()).toBe(false); expect(recent.list()).toEqual([record('one')]);
  recent.remember(record('two')); expect(recent.list().map(row => row.id)).toEqual(['two', 'one']);
  fail = false; expect(recent.remove('task', 'two')).toBe(true); expect(recent.clear()).toBe(true);
  const transient = createRecentWorkRecords({ scope: 'pair', storage: null }); transient.remember(record('one')); expect(transient.clear()).toBe(true);
});

it('keeps mailbox-qualified identities separate, strips private payloads, and copies nested metadata on every read', () => {
  const { storage, data } = memory(), recent = createRecentWorkRecords({ scope: 'pair', storage });
  const origin = { kind: 'mail' as const, slug: 'work', recordId: "shared/id?二.)!'*", receivedAt: 10, identity: 'work-enrollment', label: 'Selected email' };
  const work = recentSourceRecord(origin, 'Work mailbox')!, home = recentSourceRecord({ ...origin, slug: 'home' }, 'Personal mailbox')!;
  recent.remember({ ...work, body: 'Never store this body', origin: { ...origin, access_token: 'Never store this token' } } as RecentWorkRecord);
  recent.remember(home);
  expect(recent.list().map(row => row.id)).toEqual([home.id, work.id]);
  const exposed = recent.list()[0]!; if ('origin' in exposed) exposed.origin.label = 'External mutation';
  expect(recent.list()[0]!.title).toBe('Selected email');
  expect(createRecentWorkRecords({ scope: 'pair', storage }).list()).toEqual(recent.list());
  expect([...data.values()].join('')).not.toContain('Never store');
  recent.remove('mail', work.id); expect(recent.list()).toEqual([home]);
});

it('restores validated contact and occurrence references but rejects forged kinds, ids and incomplete identity data', () => {
  const { storage, data } = memory(), recent = createRecentWorkRecords({ scope: 'pair', storage });
  const contact = recentSourceRecord({ kind: 'contact', id: 'person', createdAt: 5, label: 'Riley <img src=x>' }, 'riley@example.test')!;
  const event = recentSourceRecord({ kind: 'calendar', slug: 'work', recordId: 'one/occurrence', sourceId: 'provider-event', receivedAt: 4, incarnation: 'calendar-1', label: 'Planning' }, 'Planning · work')!;
  recent.remember(contact); recent.remember(event); const key = [...data.keys()][0]!;
  data.set(key, JSON.stringify([{ ...event, id: 'forged' }, { ...contact, origin: event.origin }, { ...event, origin: { ...event.origin, incarnation: undefined } }, event, contact]));
  expect(createRecentWorkRecords({ scope: 'pair', storage }).list()).toEqual([event, contact]);
  expect(createRecentWorkRecords({ scope: 'other-pair', storage }).list()).toEqual([]);
});
