import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcError, mailFollowUpHref, type MailFollowUp } from '@recued/contracts';
import { createAuditLogStore, createInMemoryCollection, type ActivityEntry, type AuditEntry } from '@recued/storage';
import { createMailFollowUpFixture } from './fixtures/mail-follow-up-fixture.js';
import { createMailFollowUpStore } from '../storage/mail-follow-up-store.js';
import { createMailFollowUpAlertRuntime, createMailFollowUpAlertStore } from '../mail-follow-up-alerts.js';
import { makeMailFollowUpHandlers } from '../mail-follow-up-rpc-handler.js';
import { createSQLiteCollection } from '../sqlite-collection.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const fixture = async () => {
  const f = createMailFollowUpFixture(); cleanup.push(f.dispose);
  const watch = await f.service.start(f.request(), 'paired-owner');
  const activities = createSQLiteCollection<ActivityEntry>(f.db, 'snooze_activities');
  const audit = createAuditLogStore(createInMemoryCollection<AuditEntry>(), activities);
  const notices = createMailFollowUpAlertStore(f.db), notify = vi.fn(async () => {}), update = vi.fn();
  let quiet = false, beforeHistory: (() => Promise<void>) | undefined;
  const makeAlerts = () => createMailFollowUpAlertRuntime({ store: notices, service: f.service, notifier: { notify }, update,
    now: f.now, isQuiet: () => quiet,
    auditLog: { async logActivity(entry) { await beforeHistory?.(); await audit.logActivity(entry); } },
    validateDraft: async value => { await f.drafts.get({ draft_id: value.draft_id }, f.principal); return () => f.principal.validate(); },
  });
  const alerts = makeAlerts();
  return { ...f, watch, notices, activities, audit, notify, update, alerts, makeAlerts,
    quiet: (value: boolean) => { quiet = value; }, beforeHistory: (hook?: typeof beforeHistory) => { beforeHistory = hook; } };
};
const request = (watch: MailFollowUp, at: number) => ({ id: watch.id, expected_revision: watch.revision, request_id: randomUUID(), check_at: at });
const prepare = async (f: Awaited<ReturnType<typeof fixture>>) => { f.due(f.watch.check_at); return f.service.check(f.watch.id); };

describe('reply-watch time changes', () => {
  it('reschedules the same persisted watch and requires a healthy sync at its new time', async () => {
    const f = await fixture(), at = f.watch.check_at + 7200_000;
    const moved = await f.service.reschedule(request(f.watch, at));
    expect(moved).toMatchObject({ id: f.watch.id, state: 'waiting', check_at: at, schedule_version: 1 });
    f.due(f.watch.check_at); await f.makeService().sweep(); expect(f.draftCount()).toBe(0);
    f.time(at); expect((await f.makeService().check(moved.id)).state).toBe('needs_attention'); expect(f.draftCount()).toBe(0);
    f.health.last_indexed_at = at;
    expect((await f.makeService().check(moved.id)).state).toBe('draft_ready'); expect(f.draftCount()).toBe(1);
    expect((await f.service.list()).watches).toHaveLength(1);
    expect(JSON.stringify(f.db.prepare('SELECT * FROM mail_follow_ups').get())).not.toContain('request_id');
  });

  it('snoozes a prepared draft without replacing its identity, edits or RFC context', async () => {
    const f = await fixture(), ready = await prepare(f);
    const saved = await f.drafts.get({ draft_id: ready.draft_id }, f.principal);
    const edited = await f.drafts.update({ draft_id: saved.draft_id, expected_revision: saved.revision,
      content: { ...saved.content, body: 'Please confirm by Friday.', subject: 'Renewal check-in' } }, f.principal);
    const moved = await f.service.reschedule(request(ready, f.now() + 86400_000));
    expect(await f.service.check(moved.id)).toMatchObject({ state: 'waiting', draft_id: edited.draft_id });
    f.due(moved.check_at); const current = await f.makeService().check(moved.id);
    expect(current).toMatchObject({ state: 'draft_ready', draft_id: edited.draft_id });
    expect(await f.drafts.get({ draft_id: current.draft_id }, f.principal)).toEqual(edited);
    expect(f.draftCount()).toBe(1);
  });

  it('retries one immutable time change after a lost response, a deadline and a recipient reply', async () => {
    const f = await fixture(), change = request(f.watch, f.watch.check_at + 3600_000);
    const moved = await f.service.reschedule(change);
    expect(await f.makeService().reschedule(change)).toEqual(moved);
    await expect(f.service.reschedule({ ...change, check_at: change.check_at + 1 })).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.service.reschedule(request(f.watch, change.check_at + 1))).rejects.toMatchObject({ code: 'conflict' });
    f.due(moved.check_at); f.add(); const replied = await f.service.check(moved.id);
    expect(await f.makeService().reschedule(change)).toEqual(replied);
    expect(replied.state).toBe('replied'); expect(replied.schedule_version).toBe(1); expect(f.draftCount()).toBe(0);
    await expect(f.service.reschedule(request(replied, f.now() + 3600_000))).rejects.toMatchObject({ code: 'conflict' });
  });

  it('fences a new reply, pause and owner revocation at the asynchronous write boundary', async () => {
    for (const cause of ['reply', 'pause', 'revoked'] as const) {
      const f = await fixture(); let allowed = true;
      const change = request(f.watch, f.watch.check_at + 3600_000);
      f.beforeWatch(async () => { if (cause === 'reply') f.add(); if (cause === 'pause') f.run(false); if (cause === 'revoked') allowed = false; });
      await expect(f.service.reschedule(change, () => { if (!allowed) throw new RpcError('forbidden', 'Revoked.', 403); }))
        .rejects.toMatchObject({ code: cause === 'reply' ? 'resource_changed' : cause === 'pause' ? 'unavailable' : 'forbidden' });
      expect((await f.store.get(f.watch.id))!.watch).toEqual(f.watch);
      f.beforeWatch(); f.run(true);
      if (cause === 'reply') expect((await f.service.check(f.watch.id)).state).toBe('replied');
    }
  });

  it('rejects malformed times, changed mailbox identity, concurrent edits and unauthorized RPC writes', async () => {
    const f = await fixture();
    for (const at of [f.now(), Number.NaN, f.now() + 367 * 86400_000])
      await expect(f.service.reschedule(request(f.watch, at))).rejects.toMatchObject({ code: 'bad_request' });
    const h = makeMailFollowUpHandlers({ service: f.service, authorize: () => { throw new RpcError('forbidden', 'Pair first.', 403); } })!;
    await expect(h.handlers['mail.follow_up.reschedule'](request(f.watch, f.watch.check_at + 1), {} as never)).rejects.toMatchObject({ code: 'forbidden' });
    const instance = f.instances.get('mail', 'work')!; f.instances.delete('mail', 'work'); f.instances.upsert(instance);
    await expect(f.service.reschedule(request(f.watch, f.watch.check_at + 1))).rejects.toMatchObject({ code: 'resource_changed' });
    const other = await fixture(); let raced = false;
    other.beforeWatch(async () => { if (!raced) { raced = true; other.beforeWatch(); await other.makeService().cancel({ id: other.watch.id, expected_revision: other.watch.revision }); } });
    await expect(other.service.reschedule(request(other.watch, other.watch.check_at + 1))).rejects.toMatchObject({ code: 'conflict' });
    expect((await other.service.list()).watches[0]!.state).toBe('cancelled');
  });

  it('retires an old alert and delivers one fresh alert for each due schedule, even across restart', async () => {
    const f = await fixture(); let watch = await prepare(f); await f.alerts.tick(); expect(f.notify).toHaveBeenCalledTimes(1);
    for (const version of [1, 2]) {
      watch = await f.service.reschedule(request(watch, f.now() + 3600_000)); await f.makeAlerts().tick();
      const old = f.notices.get(watch.id, version - 1)!;
      expect(old.suppressed).toBe(1);
      const row = (await f.activities.list()).find(item => item.activity_id === old.activity_id)!;
      expect(JSON.parse(row.detail!)).toMatchObject({ title: 'Follow-up postponed', link_url: mailFollowUpHref(watch.id) });
      expect(f.notify).toHaveBeenCalledTimes(version);
      f.due(watch.check_at); watch = await f.service.check(watch.id);
      await Promise.all([f.alerts.tick(), f.makeAlerts().tick()]); await f.makeAlerts().tick();
      expect(f.notify).toHaveBeenCalledTimes(version + 1);
      expect(f.notices.get(watch.id, version)!.activity_id).not.toBe(old.activity_id);
    }
    expect(await f.activities.list()).toHaveLength(3); expect(f.draftCount()).toBe(1);
  });

  it('holds the fresh cycle in quiet hours and retires it when a recipient replies before delivery', async () => {
    const f = await fixture(), ready = await prepare(f); await f.alerts.tick();
    const moved = await f.service.reschedule(request(ready, f.now() + 3600_000)); await f.alerts.tick();
    f.due(moved.check_at); await f.service.check(moved.id); f.quiet(true); await f.alerts.tick();
    expect(f.notices.get(moved.id, 1)).toBeUndefined(); expect(f.notify).toHaveBeenCalledTimes(1);
    f.add(); await f.service.sweep(); f.quiet(false); await f.makeAlerts().tick();
    expect(f.notify).toHaveBeenCalledTimes(1); expect(f.draftCount()).toBe(1);
    expect(JSON.parse((await f.activities.list())[0]!.detail!).title).toBe('Follow-up no longer needed');
  });

  it('cannot push an older cycle when a time change wins during history persistence', async () => {
    const f = await fixture(), ready = await prepare(f); let moved!: MailFollowUp;
    f.beforeHistory(async () => { f.beforeHistory(); moved = await f.service.reschedule(request(ready, f.now() + 3600_000)); });
    await f.alerts.tick(); await f.alerts.tick(); expect(f.notify).not.toHaveBeenCalled();
    expect(JSON.parse((await f.activities.list())[0]!.detail!).title).toBe('Follow-up postponed');
    f.due(moved.check_at); await f.service.sweep(); await f.makeAlerts().tick();
    expect(f.notify).toHaveBeenCalledTimes(1); expect(f.notices.get(moved.id, 0)!.claimed_at).toBeNull();
    expect(f.notices.get(moved.id, 1)!.claimed_at).not.toBeNull();
  });

  it('upgrades legacy encrypted watches and notification claims without replaying their original alert', async () => {
    const f = await fixture(), ready = await prepare(f); await f.alerts.tick(); const old = f.notices.get(ready.id)!;
    f.db.exec(`ALTER TABLE mail_follow_ups DROP COLUMN schedule_version;
      ALTER TABLE mail_follow_up_notices RENAME TO old_notice_cycles;
      CREATE TABLE mail_follow_up_notices (watch_id TEXT PRIMARY KEY REFERENCES mail_follow_ups(id) ON DELETE CASCADE,
        draft_id TEXT NOT NULL,activity_id TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL,history_revision INTEGER NOT NULL,
        claimed_at INTEGER,suppressed INTEGER NOT NULL);
      INSERT INTO mail_follow_up_notices SELECT watch_id,draft_id,activity_id,created_at,history_revision,claimed_at,suppressed FROM old_notice_cycles;
      DROP TABLE old_notice_cycles`);
    const upgraded = createMailFollowUpStore(f.db, f.codec), migrated = createMailFollowUpAlertStore(f.db);
    expect((await upgraded.get(ready.id))!.watch).toEqual(ready);
    expect(migrated.get(ready.id)).toMatchObject({ activity_id: old.activity_id, claimed_at: old.claimed_at, schedule_version: 0 });
    await f.makeAlerts().tick(); expect(f.notify).toHaveBeenCalledTimes(1);
    const moved = await f.service.reschedule(request(ready, f.now() + 3600_000)); f.due(moved.check_at);
    await f.service.sweep(); await f.makeAlerts().tick(); expect(f.notify).toHaveBeenCalledTimes(2);
    expect(migrated.get(moved.id, 1)!.activity_id).not.toBe(old.activity_id);
  });
});
