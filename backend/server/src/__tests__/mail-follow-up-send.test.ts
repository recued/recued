import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcError, normalizeMailSend, type MailDraftContent, type ServerExecuteResponse } from '@recued/contracts';
import { createMailFollowUpSendStore } from '../storage/mail-follow-up-send-store.js';
import { createMailFollowUpSendService } from '../mail-follow-up-send-service.js';
import { mailRecordIdForSource, type MailSendResult } from '../collections/mail/mail-collection.js';
import { makeMailFollowUpHandlers } from '../mail-follow-up-rpc-handler.js';
import { createMailFollowUpFixture, type MailFollowUpFixture } from './fixtures/mail-follow-up-fixture.js';

const fixtures: MailFollowUpFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
const response = (held = false): ServerExecuteResponse => ({ recipe_id: 'send-composed-mail', recipe_hash: 'fixture', success: !held,
  awaiting_approval: held, output: { render: [], sidebar: [] }, steps: [], errors: [], duration_ms: 1 });
const fixture = () => {
  const f = createMailFollowUpFixture(); fixtures.push(f);
  const store = createMailFollowUpSendStore(f.db, f.codec), runId = randomUUID(); let status = 'awaiting_approval';
  const content: MailDraftContent = { sender_mail_instance: 'work', to: ['alex@example.test'], cc: ['copy@example.test'],
    subject: 'Composer renewal', body: 'Please confirm the revised renewal.', body_format: 'text' };
  const request = { recipe_id: 'send-composed-mail', trigger_source: 'manual', config: content,
    mail_follow_up: { request_id: randomUUID(), after_ms: 3600_000, notify_on_reply: true } };
  const receipt: MailSendResult = { source_id: 'provider-compose-1', message_id: 'provider-compose-1', sent_at: f.now(),
    _id: null, _collection: 'data.mail' };
  const make = () => createMailFollowUpSendService({ store, watches: f.service, mailbox: f.mailbox,
    incarnation: slug => f.instances.getIncarnation!('mail', slug), now: f.now, validateOwner: () => f.principal.validate(),
    runStatus: async () => status });
  const send = make(), provider = vi.fn(async () => receipt);
  const arm = () => send.execute(request, 'paired-owner', () => f.principal.validate(), async before => { await before(runId); return { ...response(true), run_id: runId }; });
  const dispatch = async (service = send, input = content) => {
    const watched = await service.beforeSend({ ...normalizeMailSend(input), run_id: runId });
    if (watched?.cached) return watched.cached;
    const result = await provider(); if (watched) await service.afterSend(watched.id, result); status = 'succeeded'; return result;
  };
  const sync = (patch: Record<string, unknown> = {}) => {
    const record = { ...f.seed, record_id: mailRecordIdForSource(receipt.source_id), source_id: receipt.source_id, received_at: receipt.sent_at,
      hot_fields: { ...f.seed.hot_fields, subject: content.subject, to: content.to, cc: content.cc, thread_id: 'composed-thread', rfc_message_id: '<composed-1@example.test>', ...patch } };
    f.tables.get('work')!.upsert(record); return record;
  };
  return { ...f, send, sendStore: store, makeSend: make, runId, request, content, receipt, provider, arm, dispatch, sync, status: (next: string) => { status = next; } };
};

describe('reply watch chosen in the composer', () => {
  it('waits through approval and Sent sync, then starts exactly one watch that survives a restart and response retry', async () => {
    const f = fixture(), queued = await f.arm(), id = queued.mail_follow_up!.id;
    expect(queued.mail_follow_up!.state).toBe('awaiting_approval'); expect((await f.service.list()).watches).toEqual([]); expect(f.provider).not.toHaveBeenCalled();
    await f.dispatch(); const restarted = f.makeSend();
    expect((await restarted.get(id))!.state).toBe('awaiting_sync'); expect((await f.service.list()).watches).toEqual([]);
    // Same subject and provider id in the other mailbox do not prove this send.
    const wrong = f.sync(); f.tables.get('work')!.delete(wrong.record_id); f.tables.get('personal')!.upsert(wrong);
    expect((await restarted.get(id))!.state).toBe('awaiting_sync'); f.tables.get('work')!.upsert(wrong);
    expect(await restarted.get(id)).toMatchObject({ state: 'armed', watch_id: id });
    const watched = (await f.service.list()).watches[0]!;
    expect(watched).toMatchObject({ id, check_at: f.receipt.sent_at + 3600000, notify_on_reply: true, mail_ref: { slug: 'work', source_id: f.receipt.source_id } });
    const retry = vi.fn(); await restarted.execute(f.request, 'paired-owner', () => {}, retry); expect(retry).not.toHaveBeenCalled();
    await f.dispatch(restarted); expect(f.provider).toHaveBeenCalledTimes(1); expect((await f.service.list()).watches).toHaveLength(1);
    const disk = JSON.stringify(f.db.prepare('SELECT * FROM mail_follow_up_sends').all());
    for (const secret of [f.content.subject, f.content.body, 'alex@example.test', 'paired-owner', f.receipt.source_id]) expect(disk).not.toContain(secret);
  });

  it('recognizes a reply that arrived before Sent sync and handles a deadline that passed while offline', async () => {
    const f = fixture(), id = (await f.arm()).mail_follow_up!.id; await f.dispatch(); f.sync();
    f.add({ record_id: 'early-reply', received_at: f.now() + 1, hot_fields: { thread_id: 'composed-thread' } }); f.due(f.now() + 7200000);
    expect((await f.makeSend().get(id))!.state).toBe('armed');
    expect((await f.service.check(id)).state).toBe('replied'); expect(f.draftCount()).toBe(0);
    const overdue = fixture(), overdueId = (await overdue.arm()).mail_follow_up!.id; await overdue.dispatch(); overdue.sync(); overdue.due(overdue.now() + 7200000);
    expect((await overdue.makeSend().get(overdueId))!.state).toBe('armed'); expect((await overdue.service.check(overdueId)).state).toBe('draft_ready'); expect(overdue.draftCount()).toBe(1);
  });

  it('cancels only the watch request before dispatch or during Sent sync and never reactivates it on retry', async () => {
    for (const afterDispatch of [false, true]) {
      const f = fixture(), id = (await f.arm()).mail_follow_up!.id;
      if (afterDispatch) await f.dispatch();
      const current = (await f.send.get(id))!; await f.send.cancel({ id, expected_revision: current.revision }, () => {});
      if (!afterDispatch) await f.dispatch(); f.sync(); await f.makeSend().sweep();
      expect((await f.send.get(id))!.state).toBe('cancelled'); expect((await f.service.list()).watches).toEqual([]);
      await f.dispatch(f.makeSend());
      expect(f.provider).toHaveBeenCalledTimes(1); const again = vi.fn(); await f.send.execute(f.request, 'paired-owner', () => {}, again); expect(again).not.toHaveBeenCalled();
    }
  });

  it('rejects a changed request even while the original is running and keeps recipient edits from arming an old watch', async () => {
    const f = fixture(); let release!: () => void;
    const pending = f.send.execute(f.request, 'paired-owner', () => {}, async before => { await before(f.runId); await new Promise<void>(done => { release = done; }); return { ...response(true), run_id: f.runId }; });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(f.send.execute({ ...f.request, config: { ...f.content, to: ['other@example.test'] } }, 'paired-owner', () => {}, vi.fn())).rejects.toMatchObject({ code: 'conflict' });
    release(); const id = (await pending).mail_follow_up!.id;
    await f.dispatch(f.send, { ...f.content, to: ['other@example.test'] }); f.sync({ to: ['other@example.test'] });
    expect((await f.send.get(id))!.state).toBe('needs_attention'); expect((await f.service.list()).watches).toEqual([]); expect(f.provider).toHaveBeenCalledTimes(1);
  });

  it('refuses to redispatch an uncertain native attempt after restart and never mistakes a denied run for a sent message', async () => {
    const f = fixture(), id = (await f.arm()).mail_follow_up!.id;
    await f.send.beforeSend({ ...normalizeMailSend(f.content), run_id: f.runId });
    await expect(f.makeSend().beforeSend({ ...normalizeMailSend(f.content), run_id: f.runId })).rejects.toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
    f.status('in_doubt'); expect((await f.send.get(id))!.state).toBe('needs_attention'); expect(f.provider).not.toHaveBeenCalled();
    const current = (await f.send.get(id))!; await f.send.cancel({ id, expected_revision: current.revision }, () => {});
    await expect(f.makeSend().beforeSend({ ...normalizeMailSend(f.content), run_id: f.runId })).rejects.toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
    const denied = fixture(), deniedId = (await denied.arm()).mail_follow_up!.id; denied.status('cancelled');
    expect((await denied.send.get(deniedId))!.state).toBe('not_sent'); expect((await denied.service.list()).watches).toEqual([]);
  });

  it('requires the original mailbox incarnation, sent identity, owner authority and a current cancellation revision', async () => {
    for (const change of ['mailbox', 'identity', 'owner'] as const) {
      const f = fixture(), id = (await f.arm()).mail_follow_up!.id; await f.dispatch();
      if (change === 'mailbox') { const prior = f.instances.get('mail', 'work')!; f.instances.delete('mail', 'work'); f.instances.upsert(prior); f.sync(); }
      if (change === 'identity') f.sync({ to: ['other@example.test'] });
      if (change === 'owner') { f.sync(); f.allow(false); }
      expect((await f.send.get(id))!.state).toBe('needs_attention'); expect((await f.service.list()).watches).toEqual([]);
      await expect(f.send.cancel({ id, expected_revision: 1 }, () => {})).rejects.toMatchObject({ code: 'conflict' });
    }
    const f = fixture(), id = (await f.arm()).mail_follow_up!.id; f.unlock(false); await expect(f.send.get(id)).rejects.toMatchObject({ code: 'server_locked' });
  });

  it('rechecks Sent identity at the encrypted watch write, but permits an unrelated read-state update', async () => {
    const f = fixture(), id = (await f.arm()).mail_follow_up!.id; await f.dispatch(); const sent = f.sync();
    f.beforeWatch(async () => { f.tables.get('work')!.upsert({ ...sent, hot_fields: { ...sent.hot_fields, rfc_message_id: '<changed@example.test>' } }); });
    expect((await f.send.get(id))!.state).toBe('needs_attention'); expect((await f.service.list()).watches).toEqual([]);
    const read = fixture(), readId = (await read.arm()).mail_follow_up!.id; await read.dispatch(); const other = read.sync();
    read.beforeWatch(async () => { read.tables.get('work')!.upsert({ ...other, hot_fields: { ...other.hot_fields, is_read: true } }); });
    expect((await read.send.get(readId))!.state).toBe('armed');
  });

  it('uses owner RPC guards and includes a newly armed watch in the same manager read', async () => {
    const f = fixture(), id = (await f.arm()).mail_follow_up!.id; await f.dispatch(); f.sync();
    const handlers = makeMailFollowUpHandlers({ service: f.service, send: f.send, authorize: () => 'paired-owner' })!.handlers;
    const result = await handlers['mail.follow_up.list'](undefined, {} as never);
    expect(result).toMatchObject({ watches: [{ id }], pending_sends: [] });
    const refused = makeMailFollowUpHandlers({ service: f.service, send: f.send, authorize: () => { throw new RpcError('forbidden', 'Owner only', 403); } })!.handlers;
    await expect(refused['mail.follow_up.send.get']({ id }, {} as never)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(f.send.execute({ ...f.request, recipe_id: 'another-recipe' }, 'paired-owner', () => {}, vi.fn())).rejects.toMatchObject({ code: 'bad_request' });
    await expect(f.send.execute({ ...f.request, dish_id: 'another-dish' }, 'paired-owner', () => {}, vi.fn())).rejects.toMatchObject({ code: 'bad_request' });
    const tooMany = fixture(), invoked = vi.fn();
    await expect(tooMany.send.execute({ ...tooMany.request, config: { ...tooMany.content, to: Array.from({ length: 21 }, (_, n) => `person${n}@example.test`) } },
      'paired-owner', () => {}, invoked)).rejects.toMatchObject({ code: 'bad_request' });
    expect(invoked).not.toHaveBeenCalled(); expect(tooMany.sendStore.activeIds()).toEqual([]);
  });
});
