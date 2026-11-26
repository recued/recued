import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuditLogStore, createInMemoryCollection, type ActivityEntry, type AuditEntry } from '@recued/storage';
import { mailFollowUpHref, parseMailFollowUpAddress, isMailFollowUpLink, type MailFollowUp } from '@recued/contracts';
import type { NotificationBlock, NotificationMessage } from '@recued/notification';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createMailFollowUpAlertRuntime, createMailFollowUpAlertStore } from '../mail-follow-up-alerts.js';
import { createMailFollowUpFixture } from './fixtures/mail-follow-up-fixture.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); vi.restoreAllMocks(); });
const fixture = async () => {
  const f = createMailFollowUpFixture(); cleanup.push(f.dispose);
  const watch = await f.service.start(f.request(), 'paired-owner'); f.due(watch.check_at);
  const store = createMailFollowUpAlertStore(f.db);
  const activities = createSQLiteCollection<ActivityEntry>(f.db, 'reply_alert_test_activities');
  const audit = createAuditLogStore(createInMemoryCollection<AuditEntry>(), activities);
  const notify = vi.fn<NotificationBlock['notify']>(async () => {});
  const update = vi.fn<(message: NotificationMessage, id: string, hash: string) => void>();
  let quiet = false, enabled = true, failHistory = false;
  let beforeHistory: ((entry: ActivityEntry) => Promise<void>) | undefined;
  const makeRuntime = () => createMailFollowUpAlertRuntime({ store, service: f.service, notifier: { notify }, update,
    now: f.now, isQuiet: () => quiet, canRun: () => enabled,
    getPublicBaseUrl: () => 'https://owner.example.test/',
    auditLog: { async logActivity(entry) {
      await beforeHistory?.(entry);
      if (failHistory) throw new Error('History is unavailable.');
      await audit.logActivity(entry);
    } },
    validateDraft: async (value: MailFollowUp) => {
      await f.drafts.get({ draft_id: value.draft_id }, f.principal);
      return () => f.principal.validate();
    },
  });
  const runtime = makeRuntime();
  return { ...f, watch, store, activities, notify, update, runtime, makeRuntime,
    quiet: (value: boolean) => { quiet = value; }, enabled: (value: boolean) => { enabled = value; },
    failHistory: (value: boolean) => { failHistory = value; }, beforeHistory: (hook?: typeof beforeHistory) => { beforeHistory = hook; },
  };
};
const ready = async (f: Awaited<ReturnType<typeof fixture>>) => f.service.check(f.watch.id);

describe('native reply-watch ready alerts', () => {
  it('persists one alert before delegating to the configured channels and never pushes it again after restart', async () => {
    const f = await fixture(), prepared = await ready(f);
    await Promise.all([f.runtime.tick(), f.makeRuntime().tick()]);
    expect(f.notify).toHaveBeenCalledTimes(1);
    const rows = await f.activities.list(); expect(rows).toHaveLength(1);
    const [message, channels, extras] = f.notify.mock.calls[0]!;
    expect(channels).toBeUndefined(); // NotificationBlock owns the owner's current channel preferences.
    expect(extras).toEqual({ persisted_activity_id: rows[0]!.activity_id, ui_link_url: mailFollowUpHref(prepared.id, prepared.draft_id) });
    expect(message.link_url).toBe('https://owner.example.test/' + extras!.ui_link_url);
    expect(message).toMatchObject({ title: 'Follow-up draft ready' });
    expect(JSON.stringify(rows)).not.toContain('Renewal'); expect(JSON.stringify(rows)).not.toContain('alex@example.test');
    await f.makeRuntime().tick(); expect(f.notify).toHaveBeenCalledTimes(1);
  });

  it('holds new alerts during quiet hours and pause, and skips a quiet-hours draft that has already received a reply', async () => {
    const f = await fixture(); await ready(f); f.quiet(true);
    await f.runtime.tick(); expect(f.notify).not.toHaveBeenCalled(); expect(await f.activities.list()).toEqual([]);
    f.quiet(false); f.enabled(false); await f.runtime.tick(); expect(f.notify).not.toHaveBeenCalled();
    f.enabled(true); await f.runtime.tick(); expect(f.notify).toHaveBeenCalledTimes(1);
    const replied = await fixture(); await ready(replied); replied.quiet(true); await replied.runtime.tick(); replied.add();
    replied.quiet(false); await replied.runtime.tick(); expect(replied.notify).not.toHaveBeenCalled();
    expect((await replied.store.get(replied.watch.id))?.claimed_at).toBeUndefined();
  });

  it('updates the same durable alert on a late reply, including during quiet hours, without sending a second notification', async () => {
    const f = await fixture(); await ready(f); await f.runtime.tick();
    const original = (await f.activities.list())[0]!;
    f.add(); await f.service.sweep(); f.quiet(true); await f.runtime.tick();
    const rows = await f.activities.list(); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ activity_id: original.activity_id, timestamp: original.timestamp });
    expect(JSON.parse(rows[0]!.detail!)).toMatchObject({ title: 'Follow-up no longer needed', text: expect.stringContaining('recipient replied') });
    expect(f.notify).toHaveBeenCalledTimes(1); expect(f.update).toHaveBeenCalledTimes(1);
    expect(f.update.mock.calls[0]![1]).toBe(original.activity_id);
    await f.makeRuntime().tick(); expect(f.notify).toHaveBeenCalledTimes(1); expect(f.update).toHaveBeenCalledTimes(1);
  });

  it('updates a ready alert for source trouble, recovery and a newer sent email without a second push', async () => {
    const f = await fixture(); const prepared = await ready(f); await f.runtime.tick();
    const id = (await f.activities.list())[0]!.activity_id;
    f.health.auth_state = 'expired'; await f.service.sweep(); await f.runtime.tick();
    expect(JSON.parse((await f.activities.list())[0]!.detail!).title).toBe('Follow-up needs review');
    f.health.auth_state = 'healthy'; await f.service.sweep(); await f.runtime.tick();
    expect(JSON.parse((await f.activities.list())[0]!.detail!).title).toBe('Follow-up draft ready');
    expect((await f.service.check(f.watch.id)).draft_id).toBe(prepared.draft_id);
    expect(f.draftCount()).toBe(1);
    f.add({ hot_fields: { from: 'owner@example.test', direction: 'outbound' } });
    await f.service.sweep(); await f.runtime.tick();
    expect((await f.activities.list())[0]!.activity_id).toBe(id);
    expect(JSON.parse((await f.activities.list())[0]!.detail!).title).toBe('Follow-up no longer needed');
    expect(f.notify).toHaveBeenCalledTimes(1); expect(f.update).toHaveBeenCalledTimes(3);
  });

  it('retries failed history under one identity but does not replay an attempted push, even after failure', async () => {
    const f = await fixture(); await ready(f); f.failHistory(true); await f.runtime.tick();
    expect(f.notify).not.toHaveBeenCalled(); const pending = f.store.get(f.watch.id)!;
    expect(pending.claimed_at).toBeNull(); f.failHistory(false);
    f.notify.mockRejectedValueOnce(new Error('Channel interrupted.'));
    await f.makeRuntime().tick(); await f.makeRuntime().tick();
    expect(f.notify).toHaveBeenCalledTimes(1); expect(await f.activities.list()).toHaveLength(1);
    expect(f.store.get(f.watch.id)!.activity_id).toBe(pending.activity_id);
  });

  it('fences a reply and a pause arriving during history persistence before the push claim', async () => {
    const f = await fixture(); await ready(f);
    f.beforeHistory(async () => { f.add(); await f.service.check(f.watch.id); });
    await f.runtime.tick(); expect(f.notify).not.toHaveBeenCalled();
    f.beforeHistory(); await f.runtime.tick();
    expect(JSON.parse((await f.activities.list())[0]!.detail!).title).toBe('Follow-up no longer needed');
    const paused = await fixture(); await ready(paused); paused.beforeHistory(async () => { paused.enabled(false); });
    await paused.runtime.tick(); expect(paused.notify).not.toHaveBeenCalled();
    paused.beforeHistory(); paused.enabled(true); await paused.runtime.tick(); expect(paused.notify).toHaveBeenCalledTimes(1);
  });

  it('does not alert for a deleted draft or revoked authority, including authority revoked while history yields', async () => {
    const f = await fixture(), prepared = await ready(f);
    const saved = await f.drafts.get({ draft_id: prepared.draft_id }, f.principal);
    f.drafts.delete({ draft_id: saved.draft_id, expected_revision: saved.revision }, f.principal);
    await f.runtime.tick(); expect(f.notify).not.toHaveBeenCalled(); expect(await f.activities.list()).toEqual([]);
    const revoked = await fixture(); await ready(revoked);
    revoked.beforeHistory(async () => { revoked.allow(false); }); await revoked.runtime.tick();
    expect(revoked.notify).not.toHaveBeenCalled(); revoked.beforeHistory(); revoked.allow(true);
    await revoked.runtime.tick(); expect(revoked.notify).toHaveBeenCalledTimes(1);
  });

  it('retires a cancellation and repairs a stale history write from an overlapping worker', async () => {
    const f = await fixture(); await ready(f);
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(done => { entered = done; }); let held = false;
    f.beforeHistory(async entry => {
      if (!held && JSON.parse(entry.detail!).title === 'Follow-up draft ready') {
        held = true; entered(); await new Promise<void>(done => { release = done; });
      }
    });
    const first = f.runtime.tick(); await waiting;
    const current = await f.service.check(f.watch.id);
    await f.service.cancel({ id: current.id, expected_revision: current.revision });
    await f.makeRuntime().tick(); release(); await first;
    f.beforeHistory(); await f.makeRuntime().tick();
    const rows = await f.activities.list(); expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.detail!).title).toBe('Follow-up no longer needed'); expect(f.notify).not.toHaveBeenCalled();
  });

  it('keeps one tick in flight and prevents a stopped worker from claiming a held notice', async () => {
    const f = await fixture(); await ready(f);
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(done => { entered = done; });
    f.beforeHistory(async () => { entered(); await new Promise<void>(done => { release = done; }); });
    const checking = f.runtime.tick(); await waiting;
    expect(f.runtime.tick()).toBe(checking);
    const stopping = f.runtime.stop(); release(); await stopping; await checking;
    expect(f.notify).not.toHaveBeenCalled(); expect(f.store.get(f.watch.id)!.claimed_at).toBeNull();
  });

  it('accepts only exact watch/draft addresses and never treats a draft ID as a different watch', () => {
    const id = 'mfw_00000000-0000-4000-8000-000000000001', draftId = 'mad_00000000-0000-4000-8000-000000000002';
    const hash = mailFollowUpHref(id, draftId); expect(isMailFollowUpLink(hash)).toBe(true);
    expect(parseMailFollowUpAddress(hash.slice(6).split('/'))).toEqual({ id, draft_id: draftId });
    const next = mailFollowUpHref(id, draftId, 2);
    expect(next).not.toBe(hash); expect(isMailFollowUpLink(next)).toBe(true);
    expect(parseMailFollowUpAddress(next.slice(6).split('/'))).toEqual({ id, draft_id: draftId, schedule_version: 2 });
    for (const value of [hash + '/extra', hash + '/cycle/0', hash + '/cycle/01', hash + '/cycle/9007199254740992', '#mail/reply-watch/other', '#mail/reply-watch/' + id + '/draft/%3Cscript%3E', 'javascript:alert(1)']) expect(isMailFollowUpLink(value)).toBe(false);
    expect(() => mailFollowUpHref(id, 'other')).toThrow('Invalid reply watch link');
  });
});
