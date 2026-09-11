import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuditLogStore, createInMemoryCollection, type ActivityEntry, type AuditEntry } from '@recued/storage';
import type { SavedDataView, SavedDataViewDefinition } from '@recued/contracts';
import type { NotificationBlock } from '@recued/notification';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createSavedDataViewStore } from '../saved-data-view-store.js';
import { createSavedTaskViewReader, resolveAlertTaskFilter } from '../saved-data-view-task-reader.js';
import { createSavedDataViewAlertRuntime } from '../saved-data-view-alert-runtime.js';
import { createWorkEntityStore, ensureWorkEntitySchema, type WorkEntityStore } from '../storage/work-entity-store.js';

const definition: SavedDataViewDefinition = { tab: 'task', query: '', source_id: 'recued.task', booking_lifecycle: 'all',
  task_filters: { completion: 'open', due: 'overdue', sort: 'due_asc' } };
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); vi.restoreAllMocks(); vi.useRealTimers(); });
const open = (path = ':memory:') => {
  const db = new Database(path);
  cleanup.push(() => { if (db.open) db.close(); });
  ensureWorkEntitySchema(db);
  const tasks = createWorkEntityStore(db);
  tasks.registerSource({ id: 'recued.task', top_tier_kind: 'task', source_kind: 'builtin', source_label: 'Tasks', write_capable: true });
  let now = 1_000;
  const views = createSavedDataViewStore(db, { readTasks: createSavedTaskViewReader(tasks), now: () => now });
  const activities = createSQLiteCollection<ActivityEntry>(db, 'saved_alert_test_activities');
  const auditLog = createAuditLogStore(createInMemoryCollection<AuditEntry>(), activities);
  const notify = vi.fn<NotificationBlock['notify']>(async () => {});
  const runtime = createSavedDataViewAlertRuntime({ store: views.alerts, auditLog, notifier: { notify } });
  cleanup.push(() => { void runtime.stop(); });
  const configure = (view: SavedDataView, enabled: boolean) => views.update({ id: view.id, expected_revision: view.revision,
    alert: { enabled, time_zone: 'America/Los_Angeles' } });
  return { db, tasks, views, activities, auditLog, notify, runtime, configure, setNow: (value: number) => { now = value; } };
};
const task = (store: WorkEntityStore, id: string, input: Partial<Parameters<WorkEntityStore['writeTask']>[0]> = {}) =>
  store.writeTask({ id, title: id, source_id: 'recued.task', due_at: 500, ...input });

describe('saved task view alerts through real task queries, SQLite and notification history', () => {
  it('baselines every page, detects time alone and actual new matches, and deduplicates repeated evaluation', async () => {
    const h = open();
    for (let i = 0; i < 1005; i++) task(h.tasks, `existing-${i}`);
    task(h.tasks, 'becomes-overdue', { due_at: 1_500 });
    task(h.tasks, 'completed', { done: true });
    h.configure(h.views.create({ name: 'Overdue', definition }), true);
    await h.runtime.tick();
    expect(h.notify).not.toHaveBeenCalled();
    task(h.tasks, 'new');
    h.setNow(2_000);
    await Promise.all([h.runtime.tick(), h.runtime.tick()]);
    await h.runtime.tick();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]?.[0]).toMatchObject({ text: expect.stringContaining('2 tasks now match') });
    const entries = await h.activities.list();
    expect(entries).toHaveLength(1);
    expect(h.notify.mock.calls[0]?.[2]).toMatchObject({ persisted_activity_id: entries[0]!.activity_id,
      ui_link_url: expect.stringMatching(/^#data\/view\/view_/) });
    expect(h.views.list()[0]?.alert).toMatchObject({ status: 'watching', last_notified_at: 2_000 });
    task(h.tasks, 'new', { done: true });
    await h.runtime.tick();
    task(h.tasks, 'new', { done: false });
    await h.runtime.tick();
    expect(h.notify).toHaveBeenCalledTimes(2); // a new entry after leaving
  });

  it('keeps search, source, completion and read-through exclusions identical to the task view', () => {
    const h = open();
    h.tasks.registerSource({ id: 'other', top_tier_kind: 'task', source_kind: 'builtin', source_label: 'Other', write_capable: true });
    h.tasks.registerSource({ id: 'remote', top_tier_kind: 'task', source_kind: 'connection', source_label: 'Remote',
      write_capable: false, sync_posture: 'read_through' });
    const view = h.configure(h.views.create({ name: 'Invoices', definition: { ...definition, query: 'ÉCOLE_100%' } }), true);
    task(h.tasks, 'good', { body: 'Invoice école_100%' });
    task(h.tasks, 'wrong', { body: 'Invoice écoleX100x' });
    task(h.tasks, 'done', { body: 'Invoice école_100%', done: true });
    task(h.tasks, 'other', { body: 'Invoice école_100%', source_id: 'other' });
    task(h.tasks, 'remote', { body: 'Invoice école_100%', source_id: 'remote' });
    h.views.alerts.evaluate();
    expect(h.views.alerts.pending()).toEqual([expect.objectContaining({ view_id: view.id, count: 1 })]);
    const all = h.views.create({ name: 'All', definition: { ...definition, source_id: null } });
    h.configure(all, true);
    task(h.tasks, 'remote-late', { source_id: 'remote' });
    h.views.alerts.evaluate();
    expect(h.views.alerts.pending()).toHaveLength(1);
  });

  it('persists pause/resume, resets changed filters, and cancels pending delivery on pause or deletion', async () => {
    const h = open();
    let view = h.configure(h.views.create({ name: 'Overdue', definition }), true);
    task(h.tasks, 'first');
    h.views.alerts.evaluate();
    expect(h.views.alerts.pending()).toHaveLength(1);
    view = h.configure(view, false);
    await h.runtime.tick();
    task(h.tasks, 'during-pause');
    view = h.configure(view, true);
    await h.runtime.tick();
    expect(h.notify).not.toHaveBeenCalled();
    view = h.views.update({ id: view.id, expected_revision: view.revision, definition: { ...definition, query: 'later' } });
    task(h.tasks, 'later');
    h.views.alerts.evaluate();
    expect(h.views.alerts.pending()).toHaveLength(1);
    h.views.delete({ id: view.id, expected_revision: view.revision });
    await h.runtime.tick();
    expect(h.views.alerts.pending()).toEqual([]);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('retains the last successful baseline through a missing source', async () => {
    const h = open();
    task(h.tasks, 'old');
    const view = h.configure(h.views.create({ name: 'Overdue', definition }), true);
    h.tasks.unregisterSource('recued.task');
    await h.runtime.tick();
    expect(h.views.get(view.id)?.alert?.status).toBe('unavailable');
    h.tasks.registerSource({ id: 'recued.task', top_tier_kind: 'task', source_kind: 'builtin', source_label: 'Tasks', write_capable: true });
    task(h.tasks, 'old');
    task(h.tasks, 'new');
    await h.runtime.tick();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]?.[0]).toMatchObject({ text: expect.stringContaining('A task now matches') });
  });

  it('recovers pending alerts and deduplication from a reopened database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'saved-alerts-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'realm.db');
    const first = open(path);
    const view = first.configure(first.views.create({ name: 'Overdue', definition }), true);
    task(first.tasks, 'new');
    first.views.alerts.evaluate();
    const notice = first.views.alerts.pending()[0]!;
    // Simulate a crash after history persistence but before the push claim.
    await first.auditLog.logActivity({ activity_id: notice.id, timestamp: notice.created_at,
      action: 'notification_fired', target: view.id, detail: 'before restart' });
    await first.runtime.stop(); first.db.close();
    const second = open(path);
    await second.runtime.tick(); await second.runtime.tick();
    expect(second.notify).toHaveBeenCalledTimes(1);
    expect(await second.activities.list()).toHaveLength(1);
    expect(second.views.alerts.pending()).toEqual([]);
    await second.runtime.stop(); second.db.close();
    const third = open(path);
    await third.runtime.tick();
    expect(third.notify).not.toHaveBeenCalled();
    expect(third.views.get(view.id)?.alert?.enabled).toBe(true);
  });

  it('retries history write failures without losing the transition or pushing duplicates', async () => {
    const h = open();
    h.configure(h.views.create({ name: 'Overdue', definition }), true);
    task(h.tasks, 'new');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(h.auditLog, 'logActivity').mockRejectedValueOnce(new Error('disk unavailable'));
    await h.runtime.tick();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.views.alerts.pending()).toHaveLength(1);
    await h.runtime.tick();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(await h.activities.list()).toHaveLength(1);
  });

  it('lets only one overlapping worker claim a notification', async () => {
    const h = open();
    h.configure(h.views.create({ name: 'Overdue', definition }), true);
    task(h.tasks, 'new');
    const other = createSavedDataViewAlertRuntime({ store: h.views.alerts, auditLog: h.auditLog, notifier: { notify: h.notify } });
    await Promise.all([h.runtime.tick(), other.tick()]);
    await other.stop();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(await h.activities.list()).toHaveLength(1);
  });

  it('prevents a paused view from pushing while notification history is being saved', async () => {
    const h = open();
    const view = h.configure(h.views.create({ name: 'Overdue', definition }), true);
    task(h.tasks, 'new');
    const original = h.auditLog.logActivity.bind(h.auditLog);
    vi.spyOn(h.auditLog, 'logActivity').mockImplementationOnce(async entry => {
      h.configure(view, false);
      await original(entry);
    });
    await h.runtime.tick();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('starts polling with no browser, and drains and stops its timer on shutdown', async () => {
    vi.useFakeTimers();
    const h = open();
    h.configure(h.views.create({ name: 'Overdue', definition }), true);
    h.runtime.start(); await h.runtime.tick();
    task(h.tasks, 'new');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.notify).toHaveBeenCalledTimes(1);
    await h.runtime.stop();
    task(h.tasks, 'after-stop');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('validates task-only settings, timezone, and revision without changing the prior state', () => {
    const h = open();
    const view = h.views.create({ name: 'Contacts', definition: { tab: 'contact', query: '' } });
    expect(() => h.configure(view, true)).toThrow(/task views only/);
    const tasks = h.views.create({ name: 'Tasks', definition });
    expect(() => h.views.update({ id: tasks.id, expected_revision: 1, alert: { enabled: true, time_zone: 'Not/AZone' } })).toThrow(/Invalid task alert/);
    const enabled = h.configure(tasks, true);
    expect(() => h.configure(tasks, false)).toThrow(/another browser/);
    expect(h.views.get(tasks.id)).toEqual(enabled);
  });
});

describe('alert calendars use the saved owner zone rather than the server zone', () => {
  it.each([
    ['2026-03-08T20:00:00Z', '2026-03-08T08:00:00Z', '2026-03-09T07:00:00Z'],
    ['2026-11-01T20:00:00Z', '2026-11-01T07:00:00Z', '2026-11-02T08:00:00Z'],
  ])('handles daylight saving boundaries at %s', (now, from, before) => {
    expect(resolveAlertTaskFilter({ completion: 'open', sort: 'default', due: 'today' }, Date.parse(now), 'America/Los_Angeles'))
      .toMatchObject({ due: { kind: 'range', from: Date.parse(from), before: Date.parse(before) } });
  });
});
