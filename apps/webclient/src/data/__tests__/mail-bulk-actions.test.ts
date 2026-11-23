import { describe, expect, it, vi } from 'vitest';
import type { CollectionRecord, MailMessageSnapshot, MailMessageState } from '@recued/contracts';
import { createMailBulkActions, MAIL_BULK_LIMIT } from '../mail-bulk-actions.js';
import type { MailMessageCallers } from '../mail-message-surface.js';
import type { DataCollectionGetCaller } from '../bootstrap-data-route.js';

const row = (id: string): CollectionRecord => ({ record_id: id, source_id: `provider-${id}`, received_at: 10, modified_at: 20,
  size_bytes: 5, body_inline: 'Original body', hot_fields: { subject: `Email ${id}`, from: 'sender@example.test',
    rfc_message_id: `${id}@example.test`, thread_id: 'thread', is_read: false, is_flagged: false } });
const writable = (): MailMessageState => ({ identity: 'a'.repeat(64), is_read: false, is_flagged: false, verified: true, can_mark: true, can_flag: true });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const rig = (records = [row('a'), row('b')]) => {
  const stored = new Map(records.map(record => [record.record_id, structuredClone(record)]));
  const states = new Map(records.map(record => [record.record_id, writable()]));
  let visible = records, scope = 'work:all:all', ready = true;
  const get = vi.fn<DataCollectionGetCaller>(async ({ record_id }) => ({ record: structuredClone(stored.get(record_id) ?? null) }));
  const message = vi.fn<NonNullable<MailMessageCallers['get']>>(async ({ slug, record_id }) => ({ slug, record_id,
    from: 'sender@example.test', to: [], cc: [], subject: 'Email ' + record_id, received_at: 10,
    body: 'A provider body that selection must not retain', body_truncated: false, read: 'provider', reply: null,
    state: structuredClone(states.get(record_id)) }));
  const update = vi.fn<NonNullable<MailMessageCallers['updateState']>>(async args => {
    const state = { ...states.get(args.record_id)!, [args.change.kind === 'read' ? 'is_read' : 'is_flagged']: args.change.value };
    const record = { ...stored.get(args.record_id)!, hot_fields: { ...stored.get(args.record_id)!.hot_fields, is_read: state.is_read, is_flagged: state.is_flagged } };
    states.set(args.record_id, state); stored.set(args.record_id, record);
    return { slug: args.slug, record_id: args.record_id, state, record };
  });
  const confirmed = vi.fn<(record: CollectionRecord) => void>(), begin = vi.fn(), render = vi.fn();
  const controller = createMailBulkActions({ view: () => ({ scope, slug: 'work', records: visible, ready }), get,
    mail: { get: message, updateState: update }, render, begin, confirmed });
  const select = async () => { controller.handleAction('mail-bulk-all'); await controller.whenSettled(); };
  return { controller, select, stored, states, get, message, update, confirmed, begin, render,
    visible: (rows: CollectionRecord[]) => { visible = rows; }, scope: (value: string) => { scope = value; }, ready: (value: boolean) => { ready = value; } };
};

describe('selected inbox triage', () => {
  it.each([{ kind: 'read', value: true }, { kind: 'read', value: false }, { kind: 'star', value: true }, { kind: 'star', value: false }] as const)(
    'sets an explicit $kind=$value and preserves newer email content', async change => {
      const r = rig();
      for (const state of r.states.values()) state[change.kind === 'read' ? 'is_read' : 'is_flagged'] = !change.value;
      await r.select();
      r.stored.set('a', { ...r.stored.get('a')!, modified_at: 30, body_inline: 'Newer body', hot_fields: { ...r.stored.get('a')!.hot_fields, subject: 'Newer subject' } });
      await r.controller.submit(change);
      expect(r.update.mock.calls.map(([input]) => input)).toEqual(['a', 'b'].map(record_id => ({ slug: 'work', record_id, expected_identity: 'a'.repeat(64), change })));
      expect(r.stored.get('a')).toMatchObject({ body_inline: 'Newer body', hot_fields: { subject: 'Newer subject' } });
      expect(r.controller.snapshot().map(outcome => outcome.state)).toEqual(['confirmed', 'confirmed']);
      await r.controller.retry(); expect(r.update).toHaveBeenCalledTimes(2);
    });

  it('confirms an already achieved status from a fresh provider check without writing', async () => {
    const r = rig(); await r.select();
    r.states.get('a')!.is_read = true; r.states.get('a')!.is_flagged = true;
    await r.controller.submit({ kind: 'read', value: true });
    expect(r.update.mock.calls.map(([args]) => args.record_id)).toEqual(['b']);
    expect(r.confirmed.mock.calls[0]![0]).toMatchObject({ record_id: 'a', hot_fields: { is_read: true, is_flagged: true } });
    expect(r.controller.snapshot().map(outcome => outcome.state)).toEqual(['confirmed', 'confirmed']);
  });

  it('selects only displayed rows, caps a batch, and retires selection on a mailbox/filter/sphere change', async () => {
    const records = Array.from({ length: MAIL_BULK_LIMIT + 2 }, (_, i) => row(String(i)));
    const r = rig(records); r.ready(false); await r.select(); expect(r.controller.holdsList()).toBe(false);
    r.ready(true); r.visible(records.slice(0, 2)); await r.select();
    r.visible(records); expect(r.controller.checkbox(records[2]!)).not.toContain(' checked');
    await r.select(); expect(r.controller.render()).toContain(`${MAIL_BULK_LIMIT} emails selected`);
    await r.controller.submit({ kind: 'star', value: true }); expect(r.update).toHaveBeenCalledTimes(MAIL_BULK_LIMIT);
    r.scope('other:unread:personal'); r.controller.render(); expect(r.controller.holdsList()).toBe(false);
    expect(r.controller.snapshot()).toEqual([]); await r.controller.retry(); expect(r.update).toHaveBeenCalledTimes(MAIL_BULK_LIMIT);
  });

  it('requires per-email verified access and keeps the captured identity when rechecking', async () => {
    const r = rig(); r.states.get('b')!.can_flag = false; await r.select();
    await r.controller.submit({ kind: 'star', value: true }); expect(r.update).not.toHaveBeenCalled();
    r.states.get('b')!.can_flag = true; r.states.get('a')!.identity = 'b'.repeat(64);
    r.controller.handleAction('mail-bulk-recheck'); await r.controller.whenSettled();
    await r.controller.submit({ kind: 'read', value: true }); expect(r.update).not.toHaveBeenCalled();
    r.controller.handleAction('mail-bulk-review'); expect(r.controller.render()).toContain('Clear this selection');
    r.controller.reset(); await r.select(); await r.controller.submit({ kind: 'star', value: true });
    expect(r.update.mock.calls[0]![0].expected_identity).toBe('b'.repeat(64));
  });

  it('continues after access is withdrawn and retries only that failure after fresh checks', async () => {
    const r = rig(); await r.select(); r.states.get('a')!.can_mark = false;
    await r.controller.submit({ kind: 'read', value: true });
    expect(r.controller.snapshot().map(outcome => outcome.state)).toEqual(['failed', 'confirmed']);
    expect(r.update.mock.calls.map(([input]) => input.record_id)).toEqual(['b']);
    r.states.get('a')!.can_mark = true; await r.controller.retry();
    expect(r.update.mock.calls.map(([input]) => input.record_id)).toEqual(['b', 'a']);
    expect(r.message.mock.calls.filter(([input]) => input.record_id === 'a')).toHaveLength(3);
  });

  it.each(['source', 'incarnation', 'rfc', 'received'] as const)('rejects a replaced %s binding before dispatch', async field => {
    const r = rig([row('a')]); await r.select(); const record = r.stored.get('a')!;
    if (field === 'source') record.source_id = 'other-provider';
    if (field === 'incarnation') r.states.get('a')!.identity = 'b'.repeat(64);
    if (field === 'rfc') record.hot_fields.rfc_message_id = 'replacement@example.test';
    if (field === 'received') record.received_at++;
    await r.controller.submit({ kind: 'read', value: true }); await r.controller.retry();
    expect(r.update).not.toHaveBeenCalled(); expect(r.controller.snapshot()[0]).toMatchObject({ state: 'failed', message: expect.stringContaining('changed') });
  });

  it('does not retry dispatched errors; checking confirms an applied write and releases an unapplied write for explicit retry', async () => {
    const r = rig(), save = r.update.getMockImplementation()!; await r.select();
    r.update.mockImplementation(async args => {
      if (args.record_id === 'a') await save(args);
      throw new Error('Reply lost');
    });
    await r.controller.submit({ kind: 'star', value: true }); await r.controller.retry();
    expect(r.update).toHaveBeenCalledTimes(2); expect(r.controller.snapshot().map(outcome => outcome.state)).toEqual(['unconfirmed', 'unconfirmed']);
    await r.controller.retry(true);
    expect(r.update).toHaveBeenCalledTimes(2); expect(r.controller.snapshot().map(outcome => outcome.state)).toEqual(['confirmed', 'failed']);
    r.update.mockImplementation(save); await r.controller.retry();
    expect(r.update.mock.calls.map(([args]) => args.record_id)).toEqual(['a', 'b', 'b']);
    expect(r.controller.snapshot().map(outcome => outcome.state)).toEqual(['confirmed', 'confirmed']);
  });

  it('keeps a mismatched receipt or unavailable status unconfirmed until a verified check succeeds', async () => {
    const r = rig([row('a')]), save = r.update.getMockImplementation()!; await r.select();
    r.update.mockImplementation(async args => ({ ...await save(args), record_id: 'wrong-email' }));
    await r.controller.submit({ kind: 'read', value: true }); expect(r.controller.snapshot()[0]?.state).toBe('unconfirmed');
    r.states.get('a')!.verified = false; await r.controller.retry(true);
    expect(r.controller.snapshot()[0]?.state).toBe('unconfirmed'); expect(r.update).toHaveBeenCalledTimes(1);
    r.states.get('a')!.verified = true; await r.controller.retry(true);
    expect(r.controller.snapshot()[0]?.state).toBe('confirmed'); expect(r.update).toHaveBeenCalledTimes(1);
  });

  it('stops after the current email and suppresses duplicate submits while a write is held', async () => {
    const r = rig(), save = r.update.getMockImplementation()!, gate = deferred<void>(), entered = deferred<void>(); await r.select();
    r.update.mockImplementation(async args => { entered.resolve(); await gate.promise; return save(args); });
    const first = r.controller.submit({ kind: 'read', value: true }); await entered.promise;
    void r.controller.submit({ kind: 'star', value: true }); r.controller.handleAction('mail-bulk-stop');
    gate.resolve(); await first;
    expect(r.update.mock.calls.map(([input]) => input.record_id)).toEqual(['a']);
    expect(r.controller.snapshot().map(outcome => outcome.state)).toEqual(['confirmed', 'failed']);
    await r.controller.retry(); expect(r.update.mock.calls.map(([input]) => input.record_id)).toEqual(['a', 'b']);
  });

  it('discards late readiness reads after clearing selection and limits outstanding provider reads', async () => {
    const r = rig(Array.from({ length: 6 }, (_, i) => row(String(i))));
    const original = r.message.getMockImplementation()!, gate = deferred<void>();
    r.message.mockImplementation(async args => { await gate.promise; return original(args); });
    r.controller.handleAction('mail-bulk-all'); expect(r.message).toHaveBeenCalledTimes(3);
    await r.controller.submit({ kind: 'read', value: true }); expect(r.update).not.toHaveBeenCalled();
    r.controller.reset(); gate.resolve(); await r.controller.whenSettled();
    expect(r.message).toHaveBeenCalledTimes(3); expect(r.controller.holdsList()).toBe(false);
    expect(r.controller.render()).not.toContain('emails selected');
  });

  it('does not dispatch a queued email after disposal, even when a previous write completes', async () => {
    const r = rig(), gate = deferred<void>(), entered = deferred<void>(), save = r.update.getMockImplementation()!; await r.select();
    r.update.mockImplementation(async args => { entered.resolve(); await gate.promise; return save(args); });
    const work = r.controller.submit({ kind: 'star', value: true }); await entered.promise;
    r.controller.dispose(); gate.resolve(); await work;
    expect(r.update.mock.calls.map(([input]) => input.record_id)).toEqual(['a']); expect(r.confirmed).not.toHaveBeenCalled();
  });

  it('leaves older servers and unverified provider states unavailable for batch changes', async () => {
    const r = rig([row('a')]); r.message.mockResolvedValue({ slug: 'work', record_id: 'a' } as MailMessageSnapshot);
    await r.select(); await r.controller.submit({ kind: 'read', value: true }); expect(r.update).not.toHaveBeenCalled();
    r.message.mockResolvedValue({ slug: 'work', record_id: 'a', state: { ...writable(), verified: false } } as MailMessageSnapshot);
    r.controller.handleAction('mail-bulk-recheck'); await r.controller.whenSettled();
    await r.controller.submit({ kind: 'star', value: true }); expect(r.update).not.toHaveBeenCalled();
    const unavailable = createMailBulkActions({ view: () => null, render: vi.fn(), begin: vi.fn(), confirmed: vi.fn() });
    expect(unavailable.enabled()).toBe(false); expect(unavailable.render()).toBe('');
  });
});
