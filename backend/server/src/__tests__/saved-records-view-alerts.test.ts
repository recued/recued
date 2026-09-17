import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuditLogStore, createInMemoryCollection, type ActivityEntry, type AuditEntry } from '@recued/storage';
import type { RecordsExecutionBinding, RecordsPackRef, RecordsSchemaSnapshot, SavedDataView } from '@recued/contracts';
import { createRecordsStore } from '../records/store.js';
import { createSavedRecordsViewReader } from '../saved-data-view-records-reader.js';
import { createSavedDataViewStore } from '../saved-data-view-store.js';
import { createSavedDataViewAlertRuntime } from '../saved-data-view-alert-runtime.js';
import { makeSavedDataViewHandlers } from '../saved-data-view-handler.js';
import type { WsClient } from '../ws-server.js';

const owner: RecordsPackRef = { publisher: 'owner.example', pack_slug: 'jobs' };
const schema: RecordsSchemaSnapshot = { decimal_scale: 4, entities: { job: { kind: 'job', fields: [
  { key: 'id', slot: 'pk', kind: 'id', required: true },
  { key: 'title', slot: 's1', kind: 'string', required: true, privacy: 'content' },
  { key: 'status', slot: 's2', kind: 'string', required: true },
  { key: 'amount', slot: 'n1', kind: 'number', required: true },
] } } };
const binding = (action: RecordsExecutionBinding['action'], pack = owner): RecordsExecutionBinding => ({
  kind: 'core.records', action, entity: 'job', owner: pack, pack_version: 1,
  storage_schema_hash: 'a'.repeat(64), declaration_hash: 'b'.repeat(64), operation_digest: `digest:${action}`,
});
const databases: Database.Database[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });
const setup = () => {
  const db = new Database(':memory:'); databases.push(db);
  const records = createRecordsStore(db);
  const install = (pack = owner) => records.installNamespace({ owner: pack, version: 1,
    storage_schema_hash: 'a'.repeat(64), declaration_hash: 'b'.repeat(64), artifact_digest: 'artifact-1', schema,
    bindings: { create: binding('create', pack), update: binding('update', pack) } });
  install();
  const views = createSavedDataViewStore(db, { readRecords: createSavedRecordsViewReader(records) });
  const paired = { instance_id: 'owner-device' } as WsClient;
  const handlers = makeSavedDataViewHandlers(views)!.handlers;
  const create = (id: string, status = 'open', pack = owner) => records.execute({
    binding: binding('create', pack), principal: 'user_self', args: { id, values: { title: 'Private customer content', status, amount: 5 } },
  });
  const setStatus = (id: string, status: string) => {
    const row = records.ownerGet(owner, 'job', id)!;
    records.execute({ binding: binding('update'), principal: 'user_self',
      args: { id, expected_version: row._record.version, expected_revision: row._record.revision, set: { status } } });
  };
  const newView = () => views.create({ name: 'Open jobs', definition: { tab: 'records', owner, entity: 'job',
    filters: { status: { op: 'eq', value: 'open' } }, sort: '-amount' } });
  const configure = (view: SavedDataView, enabled: boolean) => views.update({ id: view.id,
    expected_revision: view.revision, alert: { enabled, time_zone: 'UTC' } });
  const activities = createInMemoryCollection<ActivityEntry>();
  const auditLog = createAuditLogStore(createInMemoryCollection<AuditEntry>(), activities);
  const notify = vi.fn(async () => {});
  const runtime = createSavedDataViewAlertRuntime({ store: views.alerts, auditLog, notifier: { notify } });
  return { db, records, views, handlers, paired, create, setStatus, newView, configure, install, runtime, notify, activities };
};

describe('Records saved-view alerts through real paged queries and notification delivery', () => {
  it('baselines all pages, observes inserts and filter transitions, and keeps record content out of notifications', async () => {
    const h = setup();
    for (let i = 0; i < 205; i++) h.create(`old-${i}`);
    h.create('was-closed', 'closed');
    const view = h.newView();
    await h.handlers['data_views.update']({ id: view.id, expected_revision: 1,
      alert: { enabled: true, time_zone: 'UTC' } }, h.paired);
    await h.runtime.tick();
    expect(h.notify).not.toHaveBeenCalled();
    const other = { ...owner, publisher: 'another.example' };
    h.install(other); h.create('other-pack', 'open', other);
    h.create('new'); h.create('excluded', 'closed'); h.setStatus('was-closed', 'open');
    await h.runtime.tick(); await h.runtime.tick();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({
      title: 'New records in “Open jobs”', text: expect.stringContaining('2 records now match'),
    }), undefined, expect.objectContaining({ ui_link_url: `#data/view/${view.id}` }));
    expect(JSON.stringify(h.notify.mock.calls)).not.toContain('Private customer content');
    expect(await h.activities.list()).toHaveLength(1);
    h.setStatus('new', 'closed'); await h.runtime.tick();
    h.setStatus('new', 'open'); await h.runtime.tick();
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it('preserves durable notices and membership when the saved-view store is recreated', () => {
    const h = setup(); const view = h.configure(h.newView(), true);
    h.create('new'); h.views.alerts.evaluate();
    const notice = h.views.alerts.pending()[0];
    const reopened = createSavedDataViewStore(h.db, { readRecords: createSavedRecordsViewReader(h.records) });
    reopened.alerts.evaluate();
    expect(reopened.alerts.pending()).toEqual([notice]);
    expect(notice).toMatchObject({ kind: 'records', view_id: view.id, count: 1, titles: [] });
  });

  it('pauses, resumes and updates saved filters with a fresh baseline and revision checks', async () => {
    const h = setup(); let view = h.configure(h.newView(), true);
    h.create('before-pause'); h.views.alerts.evaluate();
    view = h.configure(view, false);
    expect(h.views.alerts.pending()).toEqual([]);
    h.create('during-pause'); view = h.configure(view, true);
    await h.runtime.tick(); expect(h.notify).not.toHaveBeenCalled();
    h.create('already-closed', 'closed');
    const previous = view;
    view = h.views.update({ id: view.id, expected_revision: view.revision,
      definition: { tab: 'records', owner, entity: 'job', filters: { status: { op: 'eq', value: 'closed' } } } });
    await h.runtime.tick(); expect(h.notify).not.toHaveBeenCalled();
    expect(() => h.configure(previous, false)).toThrow(/another browser/);
    h.create('new-closed', 'closed'); h.views.alerts.evaluate();
    expect(h.views.alerts.pending()).toHaveLength(1);
    h.views.delete({ id: view.id, expected_revision: view.revision });
    await h.runtime.tick(); expect(h.notify).not.toHaveBeenCalled();
  });

  it('keeps the baseline through pack unavailability and rejects missing fields without altering the saved rule', async () => {
    const h = setup(); h.create('old'); const view = h.configure(h.newView(), true);
    h.records.orphanNamespace(owner);
    await h.runtime.tick();
    expect(h.views.get(view.id)?.alert?.status).toBe('unavailable');
    expect(h.notify).not.toHaveBeenCalled();
    h.install(); h.create('new'); await h.runtime.tick();
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('A record now matches') }), undefined, expect.anything());
    expect(() => h.views.update({ id: view.id, expected_revision: view.revision,
      definition: { tab: 'records', owner, entity: 'job', filters: { missing: { op: 'eq', value: 'open' } } },
    })).toThrow(/cannot be checked/);
    expect(h.views.get(view.id)?.definition).toEqual(view.definition);
  });

  it('does not adopt a partial baseline when a later Records page fails', async () => {
    const h = setup();
    for (let i = 0; i < 205; i++) h.create(`old-${i}`);
    const view = h.configure(h.newView(), true);
    const search = h.records.ownerSearch.bind(h.records);
    const spy = vi.spyOn(h.records, 'ownerSearch').mockImplementation(input => {
      if (input.cursor) throw new Error('Page unavailable');
      return search(input);
    });
    await h.runtime.tick();
    expect(h.views.get(view.id)?.alert?.status).toBe('unavailable');
    spy.mockRestore();
    h.create('new'); await h.runtime.tick();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('A record now matches') }), undefined, expect.anything());
  });

  it('requires a paired owner and a concrete Records scope', async () => {
    const h = setup(); const view = h.newView();
    await expect(h.handlers['data_views.update']({ id: view.id, expected_revision: 1,
      alert: { enabled: true, time_zone: 'UTC' } }, { instance_id: null } as WsClient)).rejects.toMatchObject({ code: 'unauthorized' });
    const unselected = h.views.create({ name: 'Records', definition: { tab: 'records', owner: null, entity: null } });
    expect(() => h.configure(unselected, true)).toThrow(/pack and kind selected/);
    expect(h.views.get(view.id)?.alert).toBeUndefined();
  });
});
