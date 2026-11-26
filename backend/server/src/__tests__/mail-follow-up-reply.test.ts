import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcError, mailFollowUpReplyHref, parseMailFollowUpAddress, isMailFollowUpLink, type MailFollowUp } from '@recued/contracts';
import { createAuditLogStore, createInMemoryCollection, type ActivityEntry, type AuditEntry } from '@recued/storage';
import type { NotificationBlock } from '@recued/notification';
import { createMailFollowUpFixture } from './fixtures/mail-follow-up-fixture.js';
import { makeMailFollowUpHandlers } from '../mail-follow-up-rpc-handler.js';
import { createMailFollowUpStore } from '../storage/mail-follow-up-store.js';
import { createMailFollowUpReplyAlertRuntime, createMailFollowUpReplyAlertStore } from '../mail-follow-up-reply-alerts.js';
import { createSQLiteCollection } from '../sqlite-collection.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const fixture = async (optIn = true) => {
  const f = createMailFollowUpFixture(); cleanup.push(f.dispose);
  const request = { ...f.request(), ...(optIn ? { notify_on_reply: true } : {}) };
  const watch = await f.service.start(request, 'paired-owner');
  const activities = createSQLiteCollection<ActivityEntry>(f.db, 'reply_handoff_activities');
  const audit = createAuditLogStore(createInMemoryCollection<AuditEntry>(), activities);
  const notices = createMailFollowUpReplyAlertStore(f.db), notify = vi.fn<NotificationBlock['notify']>(async () => {}), update = vi.fn();
  let quiet = false, enabled = true, historyFails = false, beforeHistory: (() => Promise<void>) | undefined;
  const makeRuntime = () => createMailFollowUpReplyAlertRuntime({ store: notices, service: f.service, notifier: { notify }, update,
    now: f.now, isQuiet: () => quiet, canRun: () => enabled, getPublicBaseUrl: () => 'https://owner.example.test/',
    auditLog: { async logActivity(entry) { await beforeHistory?.(); if (historyFails) throw new Error('History unavailable.'); await audit.logActivity(entry); } },
    validateOwner: async () => { f.principal.validate(); return () => f.principal.validate(); },
  });
  const runtime = makeRuntime();
  return { ...f, request, watch, notices, activities, audit, notify, update, runtime, makeRuntime,
    quiet: (value: boolean) => { quiet = value; }, enabled: (value: boolean) => { enabled = value; },
    historyFails: (value: boolean) => { historyFails = value; }, beforeHistory: (hook?: typeof beforeHistory) => { beforeHistory = hook; } };
};
const receive = async (f: Awaited<ReturnType<typeof fixture>>) => { f.add(); return f.service.check(f.watch.id); };

describe('received reply handoff', () => {
  it('retains a full mailbox-qualified reply reference before the deadline and opens only that received message', async () => {
    const f = await fixture(); f.add({}, 'personal'); const replied = await receive(f);
    expect(replied).toMatchObject({ state: 'replied', reply_record_id: 'reply-1', reply_ref: f.reference('work', 'reply-1') });
    expect((await f.service.getReply({ id: replied.id })).mail_ref).toEqual(replied.reply_ref);
    expect(f.now()).toBeLessThan(replied.check_at); expect(f.draftCount()).toBe(0);
    const raw = JSON.stringify(f.db.prepare('SELECT * FROM mail_follow_ups').get());
    expect(raw).not.toContain('reply-1'); expect(raw).not.toContain('alex@example.test');
  });

  it('rejects a removed, replaced, re-enrolled or reclassified reply, including through an already captured guard', async () => {
    for (const change of ['delete', 'replace', 'reenroll', 'thread', 'participant'] as const) {
      const f = await fixture(), replied = await receive(f), guard = await f.service.replyGuard(replied.id);
      const table = f.tables.get('work')!, row = table.get('reply-1')!;
      if (change === 'delete') table.delete('reply-1');
      if (change === 'replace') table.upsert({ ...row, source_id: 'different-message', received_at: row.received_at + 1 });
      if (change === 'reenroll') { const original = f.instances.get('mail', 'work')!; f.instances.delete('mail', 'work'); f.instances.upsert(original); }
      if (change === 'thread') table.upsert({ ...row, hot_fields: { ...row.hot_fields, thread_id: 'different-conversation' } });
      if (change === 'participant') table.upsert({ ...row, hot_fields: { ...row.hot_fields, from: 'other@example.test' } });
      await expect(f.service.getReply({ id: replied.id })).rejects.toMatchObject({ code: 'resource_changed' });
      expect(() => guard()).toThrow('removed or replaced');
    }
  });

  it('never commits a received identity replaced while its encrypted watch update yields', async () => {
    const f = await fixture(); f.add();
    f.beforeWatch(async value => { if ((value as { watch: MailFollowUp }).watch.state === 'replied') f.tables.get('work')!.delete('reply-1'); });
    expect((await f.service.check(f.watch.id)).state).toBe('needs_attention');
    expect((await f.store.get(f.watch.id))!.watch.reply_ref).toBeUndefined();
    await f.runtime.tick(); expect(f.notify).not.toHaveBeenCalled();
  });

  it('keeps old watches opted out and refuses to infer a legacy reply from its reusable row id', async () => {
    const f = await fixture(false), replied = await receive(f);
    const stored = (await f.store.get(replied.id))!; delete stored.watch.reply_ref; stored.watch.revision++;
    await f.store.put(stored, replied.revision);
    f.db.exec('ALTER TABLE mail_follow_ups DROP COLUMN notify_on_reply');
    const upgraded = createMailFollowUpStore(f.db, f.codec);
    expect((await upgraded.get(replied.id))!.watch.notify_on_reply).toBeUndefined();
    await expect(f.service.getReply({ id: replied.id })).rejects.toMatchObject({ code: 'unavailable' });
    await f.runtime.tick(); expect(f.notify).not.toHaveBeenCalled();
  });

  it('saves an opt-in idempotently and lets an owner stop a queued reply alert without enabling historical replies', async () => {
    const f = await fixture(false); expect(await f.service.start(f.request, 'paired-owner')).toEqual(f.watch);
    await expect(f.service.start({ ...f.request, notify_on_reply: true }, 'paired-owner')).rejects.toMatchObject({ code: 'conflict' });
    const enabled = await f.service.setReplyNotification({ id: f.watch.id, expected_revision: f.watch.revision, enabled: true }, () => {}, 'newly-paired-owner');
    expect(await f.store.get(f.watch.id)).toMatchObject({ owner_token_id: 'paired-owner', reply_notification_owner_token_id: 'newly-paired-owner' });
    expect(JSON.stringify(f.db.prepare('SELECT * FROM mail_follow_ups').get())).not.toContain('newly-paired-owner');
    expect(await f.service.setReplyNotification({ id: f.watch.id, expected_revision: f.watch.revision, enabled: true })).toEqual(enabled);
    const replied = await receive(f), stopped = await f.service.setReplyNotification({ id: replied.id, expected_revision: replied.revision, enabled: false });
    expect(stopped).toMatchObject({ state: 'replied', notify_on_reply: false, reply_ref: replied.reply_ref });
    await expect(f.service.setReplyNotification({ id: stopped.id, expected_revision: stopped.revision, enabled: true })).rejects.toMatchObject({ code: 'conflict' });
    await f.runtime.tick(); expect(f.notify).not.toHaveBeenCalled();
  });

  it('checks owner authorization across both new RPCs and at the preference write boundary', async () => {
    const f = await fixture(false); let allowed = false;
    const h = makeMailFollowUpHandlers({ service: f.service, authorize() { if (!allowed) throw new RpcError('forbidden', 'Revoked.', 403); return 'paired-owner'; } })!.handlers;
    await expect(h['mail.follow_up.reply.get']({ id: f.watch.id }, {} as never)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(h['mail.follow_up.reply_notification.set']({ id: f.watch.id, expected_revision: f.watch.revision, enabled: true }, {} as never)).rejects.toMatchObject({ code: 'forbidden' });
    allowed = true; f.beforeWatch(async () => { allowed = false; });
    await expect(h['mail.follow_up.reply_notification.set']({ id: f.watch.id, expected_revision: f.watch.revision, enabled: true }, {} as never)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await f.store.get(f.watch.id))!.watch.notify_on_reply).toBeUndefined();
    f.beforeWatch(); const replied = await receive(f); let proofs = 0;
    const reading = makeMailFollowUpHandlers({ service: f.service, authorize() { if (++proofs > 1) throw new RpcError('forbidden', 'Revoked.', 403); return 'paired-owner'; } })!.handlers;
    await expect(reading['mail.follow_up.reply.get']({ id: replied.id }, {} as never)).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('opt-in reply-arrived alerts', () => {
  it('does not notify for automatic or unverified replies, then delivers the ordinary reply once', async () => {
    const f = await fixture(); f.add({ hot_fields: { reply_automation: 'v1:automatic' } });
    expect((await f.service.check(f.watch.id)).state).toBe('waiting'); await f.runtime.tick(); expect(f.notify).not.toHaveBeenCalled();
    f.add({ record_id: 'uncertain', source_id: 'uncertain-source', hot_fields: { reply_automation: 'v1:unknown' }, received_at: f.now() + 1 });
    await f.service.check(f.watch.id); await f.runtime.tick(); expect(f.notify).not.toHaveBeenCalled(); expect(f.draftCount()).toBe(0);
    f.add({ record_id: 'ordinary', source_id: 'ordinary-source', received_at: f.now() + 2 });
    await f.service.check(f.watch.id); await f.runtime.tick(); await f.makeRuntime().tick(); expect(f.notify).toHaveBeenCalledTimes(1);
    expect((await f.service.getReply({ id: f.watch.id })).mail_ref.record_id).toBe('ordinary');
  });
  it('honors quiet hours and pause, then persists one private alert and delegates channels once across restarts', async () => {
    const f = await fixture(), replied = await receive(f); f.quiet(true); await f.runtime.tick();
    expect(await f.activities.list()).toEqual([]); f.quiet(false); f.enabled(false); await f.runtime.tick();
    expect(f.notify).not.toHaveBeenCalled(); f.enabled(true);
    await Promise.all([f.runtime.tick(), f.makeRuntime().tick()]); await f.makeRuntime().tick();
    expect(f.notify).toHaveBeenCalledTimes(1); expect(f.draftCount()).toBe(0);
    const rows = await f.activities.list(); expect(rows).toHaveLength(1);
    const [body, channels, extras] = f.notify.mock.calls[0]!;
    expect(body.title).toBe('Reply received'); expect(channels).toBeUndefined();
    expect(extras).toEqual({ persisted_activity_id: rows[0]!.activity_id, ui_link_url: mailFollowUpReplyHref(replied.id) });
    expect(body.link_url).toBe('https://owner.example.test/' + extras!.ui_link_url);
    expect(JSON.stringify(rows)).not.toContain('Renewal'); expect(JSON.stringify(rows)).not.toContain('alex@example.test');
  });

  it('does not push a reply removed during history persistence and retries the exact reference if it returns', async () => {
    const f = await fixture(), replied = await receive(f), row = f.tables.get('work')!.get('reply-1')!;
    f.beforeHistory(async () => { f.beforeHistory(); f.tables.get('work')!.delete('reply-1'); });
    await f.runtime.tick(); expect(f.notify).not.toHaveBeenCalled();
    expect(JSON.parse((await f.activities.list())[0]!.detail!).title).toBe('Reply needs review');
    const id = f.notices.get(replied.id)!.activity_id;
    f.tables.get('work')!.upsert(row); await f.makeRuntime().tick();
    expect(f.notify).toHaveBeenCalledTimes(1); expect(f.notices.get(replied.id)!.activity_id).toBe(id);
    expect(f.update.mock.calls.at(-1)?.[0].title).toBe('Reply received');
  });

  it('fences opt-out, credential revocation and pause while history yields', async () => {
    for (const cause of ['opt-out', 'credential', 'pause'] as const) {
      const f = await fixture(), replied = await receive(f);
      f.beforeHistory(async () => {
        f.beforeHistory();
        if (cause === 'opt-out') await f.service.setReplyNotification({ id: replied.id, expected_revision: replied.revision, enabled: false });
        if (cause === 'credential') f.allow(false);
        if (cause === 'pause') f.enabled(false);
      });
      await f.runtime.tick(); expect(f.notify).not.toHaveBeenCalled();
      if (cause === 'opt-out') { await f.runtime.tick(); expect(JSON.parse((await f.activities.list())[0]!.detail!).title).toBe('Reply alert stopped'); }
      else { f.allow(true); f.enabled(true); await f.makeRuntime().tick(); expect(f.notify).toHaveBeenCalledTimes(1); }
    }
  });

  it('retries failed persistence under one identity but never repeats an attempted push, including a later opt-out correction', async () => {
    const f = await fixture(), replied = await receive(f); f.historyFails(true); await f.runtime.tick();
    expect(f.notify).not.toHaveBeenCalled(); const id = f.notices.get(replied.id)!.activity_id;
    f.historyFails(false); f.notify.mockRejectedValueOnce(new Error('Channel interrupted.'));
    await f.makeRuntime().tick(); await f.makeRuntime().tick(); expect(f.notify).toHaveBeenCalledTimes(1);
    await f.service.setReplyNotification({ id: replied.id, expected_revision: replied.revision, enabled: false }); await f.runtime.tick();
    expect(await f.activities.list()).toHaveLength(1); expect(f.notices.get(replied.id)!.activity_id).toBe(id);
    expect(f.update.mock.calls.at(-1)?.[0].title).toBe('Reply alert stopped'); expect(f.notify).toHaveBeenCalledTimes(1);
  });

  it('repairs an older overlapping history write after opt-out', async () => {
    const f = await fixture(), replied = await receive(f); let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(done => { entered = done; });
    f.beforeHistory(async () => { f.beforeHistory(); entered(); await new Promise<void>(done => { release = done; }); });
    const first = f.runtime.tick(); await waiting;
    await f.service.setReplyNotification({ id: replied.id, expected_revision: replied.revision, enabled: false });
    await f.makeRuntime().tick(); release(); await first; await f.makeRuntime().tick();
    expect(f.notify).not.toHaveBeenCalled(); expect(JSON.parse((await f.activities.list())[0]!.detail!).title).toBe('Reply alert stopped');
  });

  it('shares an active pass, drains on stop, and accepts only an exact reply-watch link', async () => {
    const f = await fixture(), replied = await receive(f); let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(done => { entered = done; });
    f.beforeHistory(async () => { entered(); await new Promise<void>(done => { release = done; }); });
    const first = f.runtime.tick(); await waiting; expect(f.runtime.tick()).toBe(first);
    const stopped = f.runtime.stop(); release(); await first; await stopped; expect(f.notify).not.toHaveBeenCalled();
    const hash = mailFollowUpReplyHref(replied.id); expect(isMailFollowUpLink(hash)).toBe(true);
    expect(parseMailFollowUpAddress(hash.slice(6).split('/'))).toEqual({ id: replied.id, open_reply: true });
    for (const value of [hash + '/extra', hash + '?draft=other', '#mail/reply-watch/invalid/reply']) expect(isMailFollowUpLink(value)).toBe(false);
  });
});
