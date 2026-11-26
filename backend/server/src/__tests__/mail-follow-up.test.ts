import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcError, type MailFollowUp } from '@recued/contracts';
import { createMailFollowUpStore } from '../storage/mail-follow-up-store.js';
import { makeMailFollowUpHandlers } from '../mail-follow-up-rpc-handler.js';
import { createMailFollowUpRuntime } from '../mail-follow-up-runtime.js';
import { createMailFollowUpFixture, type MailFollowUpFixture } from './fixtures/mail-follow-up-fixture.js';

const fixtures: MailFollowUpFixture[] = [];
afterEach(() => { vi.useRealTimers(); for (const f of fixtures.splice(0)) f.dispose(); });
const fixture = () => { const f = createMailFollowUpFixture(); fixtures.push(f); return f; };
const arm = (f: MailFollowUpFixture) => f.service.start(f.request(), 'paired-owner');
const draft = (f: MailFollowUpFixture, watch: MailFollowUp) => f.drafts.get({ draft_id: watch.draft_id }, f.principal);

describe('selected-email reply watches', () => {
  it('resumes a persisted watch and saves one editable draft with RFC reply headers in its original mailbox', async () => {
    const f = fixture(), request = f.request(), watch = await f.service.start(request, 'paired-owner');
    expect((await f.service.check(watch.id)).state).toBe('waiting'); expect(f.draftCount()).toBe(0);
    // Identical record/thread IDs in another mailbox must not retire this watch.
    f.add({}, 'personal');
    f.due(request.check_at);
    const restarted = f.makeService(), checked = await restarted.check(watch.id);
    expect(checked.state).toBe('draft_ready'); expect(f.draftCount()).toBe(1);
    const saved = await draft(f, checked);
    expect(saved.content).toMatchObject({ sender_mail_instance: 'work', to: ['alex@example.test', 'copy@example.test'],
      subject: 'Re: Renewal', in_reply_to: '<sent-1@example.test>', references: ['<sent-1@example.test>'], body_format: 'text' });
    expect(saved.content.bcc).toBeUndefined(); expect(saved.content.body).toContain('send an update');
    const edited = await f.drafts.update({ draft_id: saved.draft_id, expected_revision: saved.revision,
      content: { ...saved.content, body: 'Owner-reviewed follow-up.' } }, f.principal);
    await restarted.sweep();
    expect((await draft(f, checked)).content.body).toBe(edited.content.body);
    expect(await restarted.start(request, 'paired-owner')).toEqual(checked);
    expect(f.draftCount()).toBe(1);
  });

  it('retains a single immutable creation after a lost reply, including a retry after the check time', async () => {
    const f = fixture(), request = f.request(), first = await f.service.start(request, 'paired-owner');
    await expect(f.service.start({ ...request, check_at: request.check_at + 1 }, 'paired-owner')).rejects.toMatchObject({ code: 'conflict' });
    await expect(arm(f)).rejects.toMatchObject({ code: 'conflict' });
    f.due(request.check_at + 1);
    expect(await f.service.start(request, 'paired-owner')).toEqual(first);
    expect((await f.service.list()).watches).toHaveLength(1);
    const stored = JSON.stringify(f.db.prepare('SELECT * FROM mail_follow_ups').get());
    for (const secret of ['Renewal', 'owner@example.test', 'alex@example.test', 'paired-owner', 'renewal-thread']) expect(stored).not.toContain(secret);
  });

  it('closes on an expected participant reply and supersedes on a newer sent email without preparing a draft', async () => {
    const f = fixture(), watch = await arm(f);
    f.add({ received_at: f.seed.received_at - 1 });
    expect((await f.service.check(watch.id)).state).toBe('waiting');
    f.add({ record_id: 'real-reply', hot_fields: { from: 'COPY@example.test' } });
    expect(await f.service.check(watch.id)).toMatchObject({ state: 'replied', reply_record_id: 'real-reply' });
    f.due(); await f.service.sweep(); expect(f.draftCount()).toBe(0);
    const second = fixture(), other = await arm(second);
    second.add({ hot_fields: { from: 'Owner <owner@example.test>', direction: 'outbound' } });
    expect((await second.service.check(other.id)).state).toBe('superseded'); expect(second.draftCount()).toBe(0);
  });

  it('requires review for an unknown participant and does not mistake another thread for a reply', async () => {
    const f = fixture(), watch = await arm(f);
    f.add({ hot_fields: { thread_id: 'unrelated-thread' } });
    expect((await f.service.check(watch.id)).state).toBe('waiting');
    f.add({ record_id: 'unknown', hot_fields: { from: 'stranger@example.test' } }); f.due();
    expect((await f.service.check(watch.id)).state).toBe('needs_attention'); expect(f.draftCount()).toBe(0);
    await expect(arm(f)).rejects.toMatchObject({ code: 'resource_changed' });
  });

  it('waits through stale, queued, failed and pre-deadline syncs, then prepares the draft after a complete healthy sync', async () => {
    const f = fixture(), watch = await arm(f); f.time(watch.check_at);
    for (const patch of [
      { last_indexed_at: watch.check_at - 1 },
      { last_indexed_at: watch.check_at, pending_queue_size: 2 },
      { pending_queue_size: 0, error_count_24h: 1 },
      { error_count_24h: 0, auth_state: 'unauthorized' as const },
    ]) {
      Object.assign(f.health, patch);
      expect((await f.service.check(watch.id)).state).toBe('needs_attention'); expect(f.draftCount()).toBe(0);
    }
    Object.assign(f.health, { auth_state: 'healthy', last_indexed_at: watch.check_at });
    expect((await f.service.check(watch.id)).state).toBe('draft_ready'); expect(f.draftCount()).toBe(1);
  });

  it('refuses to follow a deleted, re-enrolled or changed source identity', async () => {
    for (const change of ['delete', 'reenroll', 'metadata'] as const) {
      const f = fixture(), watch = await arm(f);
      if (change === 'delete') f.tables.get('work')!.delete('sent-1');
      if (change === 'reenroll') { const instance = f.instances.get('mail', 'work')!; f.instances.delete('mail', 'work'); f.instances.upsert(instance); }
      if (change === 'metadata') f.tables.get('work')!.upsert({ ...f.seed, hot_fields: { ...f.seed.hot_fields, to: ['other@example.test'] } });
      f.due(); expect((await f.service.check(watch.id)).state).toBe('needs_attention'); expect(f.draftCount()).toBe(0);
    }
  });

  it('rechecks a reply arriving during draft encryption before the draft can commit', async () => {
    const f = fixture(), watch = await arm(f); f.due();
    f.beforeDraft(async () => { f.add(); });
    expect((await f.service.check(watch.id)).state).toBe('needs_attention'); expect(f.draftCount()).toBe(0);
    expect((await f.service.check(watch.id)).state).toBe('replied'); expect(f.draftCount()).toBe(0);
  });

  it('keeps a prepared draft attached when a reply arrives while its ready status is being sealed', async () => {
    const f = fixture(), watch = await arm(f); f.due();
    f.beforeWatch(async value => { if ((value as { watch: MailFollowUp }).watch.state === 'draft_ready') f.add(); });
    const checked = await f.service.check(watch.id);
    expect(checked).toMatchObject({ state: 'needs_attention', draft_id: expect.any(String) });
    expect(f.draftCount()).toBe(1);
    expect(await f.service.check(watch.id)).toMatchObject({ state: 'replied', draft_id: checked.draft_id });
  });

  it('does not overwrite or resurrect an existing draft after a watch transition was interrupted', async () => {
    const f = fixture(), watch = await arm(f); f.due();
    f.db.exec("CREATE TRIGGER interrupt_watch BEFORE UPDATE ON mail_follow_ups BEGIN SELECT RAISE(ABORT, 'interrupted'); END");
    await expect(f.service.check(watch.id)).rejects.toThrow('interrupted'); expect(f.draftCount()).toBe(1);
    const saved = (await f.drafts.list({}, f.principal)).drafts[0]!;
    f.drafts.delete({ draft_id: saved.draft_id, expected_revision: saved.revision }, f.principal);
    f.db.exec('DROP TRIGGER interrupt_watch');
    expect((await f.makeService().check(watch.id)).state).toBe('needs_attention'); expect(f.draftCount()).toBe(1);
    expect((await f.drafts.list({}, f.principal)).drafts).toEqual([]);
  });

  it('serializes a due check with cancellation, retains the prepared draft and refuses stale revisions', async () => {
    const f = fixture(), watch = await arm(f); f.due();
    let resume!: () => void, entered!: () => void;
    const waiting = new Promise<void>(done => { entered = done; });
    f.beforeDraft(async () => { entered(); await new Promise<void>(done => { resume = done; }); });
    const checking = f.service.check(watch.id); await waiting;
    const cancelling = f.service.cancel({ id: watch.id, expected_revision: watch.revision }); resume();
    const checked = await checking;
    await expect(cancelling).rejects.toMatchObject({ code: 'conflict' });
    const cancelled = await f.service.cancel({ id: watch.id, expected_revision: checked.revision });
    expect(cancelled).toMatchObject({ state: 'cancelled', draft_id: checked.draft_id });
    await f.service.sweep(); expect(f.draftCount()).toBe(1);
    expect((await draft(f, cancelled)).content.body).toContain('following up');
  });

  it('checks pause, vault lock and live draft authority at the asynchronous write boundary', async () => {
    const f = fixture(), watch = await arm(f); f.due(); f.run(false);
    await f.service.sweep(); expect(f.draftCount()).toBe(0);
    f.run(true); f.beforeDraft(async () => { f.allow(false); });
    expect((await f.service.check(watch.id)).state).toBe('needs_attention'); expect(f.draftCount()).toBe(0);
    f.allow(true); f.beforeDraft(); f.unlock(false); await f.service.sweep(); expect(f.draftCount()).toBe(0);
    await expect(f.service.list()).rejects.toMatchObject({ code: 'server_locked' });
    f.unlock(true); expect((await f.service.check(watch.id)).state).toBe('draft_ready');
  });

  it('rejects missing RFC IDs, malformed arguments and ciphertext transplanted between watches', async () => {
    const f = fixture(); f.tables.get('work')!.upsert({ ...f.seed, hot_fields: { ...f.seed.hot_fields, rfc_message_id: undefined } });
    expect(await f.service.get({ mail_ref: f.reference() })).toMatchObject({ eligible: false, watch: null });
    await expect(arm(f)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(f.service.start({ ...f.request(), check_at: f.now() }, 'paired-owner')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(f.service.list({ cursor: { updated_at: 0, id: 4 } })).rejects.toMatchObject({ code: 'bad_request' });
    f.tables.get('work')!.upsert(f.seed);
    const first = await arm(f), second = await f.service.start(f.request(undefined, 'personal'), 'paired-owner');
    f.db.prepare('UPDATE mail_follow_ups SET ciphertext=(SELECT ciphertext FROM mail_follow_ups WHERE id=?) WHERE id=?').run(first.id, second.id);
    await expect(f.store.get(second.id)).rejects.toMatchObject({ code: 'storage_corrupt' });
  });

  it('preserves an in-flight store revision and checks owner authority on every RPC', async () => {
    const f = fixture(), watch = await arm(f);
    const staleStore = createMailFollowUpStore(f.db, { ...f.codec, async open(value) {
      const result = await f.codec.open(value); await f.service.cancel({ id: watch.id, expected_revision: watch.revision }); return result;
    } });
    await expect(staleStore.get(watch.id)).rejects.toMatchObject({ code: 'conflict' });
    let allowed = false;
    const handlers = makeMailFollowUpHandlers({ service: f.service, authorize() {
      if (!allowed) throw new RpcError('forbidden', 'Pair first.', 403); return 'paired-owner';
    } })!.handlers;
    for (const method of Object.values(handlers)) await expect((async () => { await method(undefined as never, {} as never); })()).rejects.toMatchObject({ code: 'forbidden' });
    allowed = true; expect((await handlers['mail.follow_up.list'](undefined, {} as never)).watches).toHaveLength(1);
  });

  it('bounds incomplete thread checks and isolates an unreadable watch during a sweep', async () => {
    const f = fixture(), first = await arm(f);
    const other = await f.service.start(f.request(undefined, 'personal'), 'paired-owner');
    f.db.prepare('UPDATE mail_follow_ups SET ciphertext=? WHERE id=?').run('unreadable', first.id);
    f.due(); await f.service.sweep();
    expect((await f.store.get(other.id))!.watch.state).toBe('draft_ready'); expect(f.draftCount()).toBe(1);
    const large = fixture();
    for (let n = 0; n < 201; n++) large.add({ record_id: 'old-' + n, source_id: 'old-' + n, received_at: large.seed.received_at - n - 1 });
    await expect(arm(large)).rejects.toMatchObject({ code: 'unavailable' }); expect(large.draftCount()).toBe(0);
  });

  it('refuses an arm whose owner proof expires before commit and withholds a read after revocation', async () => {
    const f = fixture();
    await expect(f.service.start(f.request(), 'paired-owner', () => { throw new RpcError('forbidden', 'Revoked.', 403); }))
      .rejects.toMatchObject({ code: 'forbidden' });
    expect((await f.service.list()).watches).toEqual([]);
    await arm(f); let proofs = 0;
    const handlers = makeMailFollowUpHandlers({ service: f.service, authorize() {
      if (++proofs > 1) throw new RpcError('forbidden', 'Revoked.', 403); return 'paired-owner';
    } })!.handlers;
    await expect(handlers['mail.follow_up.list'](undefined, {} as never)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('does not overlap sweeps and drains the active sweep before stopping', async () => {
    vi.useFakeTimers(); let release!: () => void;
    const sweep = vi.fn(() => new Promise<void>(done => { release = done; }));
    const runtime = createMailFollowUpRuntime({ sweep }, 1000); runtime.start();
    await vi.advanceTimersByTimeAsync(5000); expect(sweep).toHaveBeenCalledTimes(1);
    let stopped = false; const stopping = runtime.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false); release(); await stopping;
    await vi.advanceTimersByTimeAsync(5000); expect(sweep).toHaveBeenCalledTimes(1);
  });
});
