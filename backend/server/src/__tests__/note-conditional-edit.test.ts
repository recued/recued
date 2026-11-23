import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { RECUED_BUILTIN_SOURCE_ID } from '@recued/contracts';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { handleWorkEntityGet, handleWorkEntityUpsert } from '../work-entity-crud-handler.js';

const resources: Array<() => void> = [];
afterEach(() => { for (const close of resources.splice(0).reverse()) close(); });
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'note-conditional-')); resources.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Database(join(dir, 'notes.db')); db.pragma('journal_mode = WAL'); resources.push(() => db.close()); ensureWorkEntitySchema(db);
  const store = createWorkEntityStore(db); store.registerSource({ id: RECUED_BUILTIN_SOURCE_ID('note'), top_tier_kind: 'note', source_kind: 'builtin', source_label: 'Notes', write_capable: true });
  const other = new Database(join(dir, 'notes.db')); resources.push(() => other.close()); const peer = createWorkEntityStore(other);
  const resolver = createWorkEntityResolver(store), bus = createWarehouseEventBus(), events: unknown[] = []; bus.subscribe('**', event => { events.push(event); });
  const dispatchers = createWorkEntityDispatchers({ store, resolver, bus, now: () => 1000 });
  const deps = { store, resolver, dispatchers };
  const note = store.writeNote({ id: 'destination', title: 'Project research', body: 'Original text', source_id: RECUED_BUILTIN_SOURCE_ID('note') }, 1000);
  const read = () => handleWorkEntityGet(deps, { kind: 'note', id: note.id });
  return { deps, store, peer, note, read, events };
};

test('a guarded note Save keeps other fields and publishes a new editing revision', async () => {
  const f = setup(), opened = await f.read(); expect(opened.note_edit_revision).toMatch(/^[a-f0-9]{64}$/u);
  const result = await handleWorkEntityUpsert(f.deps, { kind: 'note', id: f.note.id, body: 'Original text\n\n> Captured passage', expected_revision: opened.note_edit_revision! });
  expect(result.entity._kind === 'note' && result.entity.body).toBe('Original text\n\n> Captured passage');
  expect(f.store.readNote(f.note.id)?.title).toBe('Project research'); expect(f.events).toHaveLength(1);
  expect((await f.read()).note_edit_revision).not.toBe(opened.note_edit_revision);
});

test('another SQLite client changing the note in the same millisecond refuses an older draft', async () => {
  const f = setup(), opened = await f.read();
  f.peer.writeNote({ ...f.note, body: 'A colleague changed this', updated_at: f.note.updated_at }, 1000);
  await expect(handleWorkEntityUpsert(f.deps, { kind: 'note', id: f.note.id, body: 'Older draft plus quotation', expected_revision: opened.note_edit_revision! })).rejects.toMatchObject({ code: 'conflict' });
  expect(f.store.readNote(f.note.id)?.body).toBe('A colleague changed this'); expect(f.events).toEqual([]);
});

test('a peer edit during asynchronous write preparation is checked again inside the write transaction', async () => {
  const f = setup(), opened = await f.read();
  const saving = handleWorkEntityUpsert(f.deps, { kind: 'note', id: f.note.id, body: 'Older draft plus quotation', expected_revision: opened.note_edit_revision! });
  f.peer.writeNote({ ...f.note, body: 'Won during preparation', updated_at: f.note.updated_at }, 1000);
  await expect(saving).rejects.toMatchObject({ code: 'conflict' });
  expect(f.store.readNote(f.note.id)?.body).toBe('Won during preparation'); expect(f.events).toEqual([]);
});

test('a conditional store write cannot resurrect a removed note or overwrite its replacement', async () => {
  const f = setup(), opened = await f.read(); f.peer.deleteNote(f.note.id);
  expect(() => f.store.writeNote({ ...f.note, body: 'Stale draft', expected_revision: opened.note_edit_revision! }, 1000)).toThrow('note changed');
  expect(f.store.readNote(f.note.id)).toBeNull();
  f.peer.writeNote({ ...f.note, body: 'Replacement record', created_at: 2000 }, 2000);
  expect(() => f.store.writeNote({ ...f.note, body: 'Stale draft', expected_revision: opened.note_edit_revision! }, 2000)).toThrow('note changed');
  expect(f.store.readNote(f.note.id)?.body).toBe('Replacement record');
});

test('malformed revision guards fail without writing while ordinary updates remain compatible', async () => {
  const f = setup(); await expect(handleWorkEntityUpsert(f.deps, { kind: 'note', id: f.note.id, body: 'Rejected', expected_revision: '' })).rejects.toMatchObject({ code: 'bad_request' });
  expect(f.store.readNote(f.note.id)?.body).toBe('Original text'); expect(f.events).toEqual([]);
  await handleWorkEntityUpsert(f.deps, { kind: 'note', id: f.note.id, body: 'Ordinary editor update' }); expect(f.store.readNote(f.note.id)?.body).toBe('Ordinary editor update');
});

test('a guarded relationship-only Save preserves exact content and all other relationship arrays', async () => {
  const f = setup();
  f.store.writeNote({ ...f.note, body: 'Exact quotation\r\n\r\n> α\n', related_project_ids: ['keep-project'],
    related_contact_ids: ['keep-contact'], related_calendar_event_ids: ['keep-event'], related_mail_thread_ids: ['keep-thread'] }, 1000);
  const opened = await f.read();
  await handleWorkEntityUpsert(f.deps, { kind: 'note', id: f.note.id, expected_revision: opened.note_edit_revision!, related_project_ids: ['keep-project', 'target'] });
  expect(f.store.readNote(f.note.id)).toMatchObject({ title: 'Project research', body: 'Exact quotation\r\n\r\n> α\n',
    related_project_ids: ['keep-project', 'target'], related_contact_ids: ['keep-contact'], related_calendar_event_ids: ['keep-event'], related_mail_thread_ids: ['keep-thread'] });
  expect(f.events).toHaveLength(1);
});

test('a relationship edit during preparation refuses an older relationship patch without losing either array', async () => {
  const f = setup(), opened = await f.read();
  const saving = handleWorkEntityUpsert(f.deps, { kind: 'note', id: f.note.id, expected_revision: opened.note_edit_revision!, related_contact_ids: ['target-contact'] });
  f.peer.writeNote({ ...f.note, related_project_ids: ['peer-project'] }, 1000);
  await expect(saving).rejects.toMatchObject({ code: 'conflict' });
  expect(f.store.readNote(f.note.id)).toMatchObject({ body: 'Original text', related_project_ids: ['peer-project'], related_contact_ids: [] });
  expect(f.events).toEqual([]);
});
