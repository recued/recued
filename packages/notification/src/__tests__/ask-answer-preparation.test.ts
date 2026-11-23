import { describe, expect, it, vi } from 'vitest';
import { createInMemoryCollection } from '@recued/storage';
import { createAskStore, createNotificationBlock, createNotificationSettingsStore,
  type Answer, type AnswerAuditRecord, type Channel, type PendingAsk, type NotificationSettings } from '../index.js';

const NOW = 1_700_000_000_000;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const make = async (note?: 'required', refuse = false) => {
  const asks = createAskStore(createInMemoryCollection<PendingAsk>());
  await asks.create({ ask_id: 'ask-1', message: { text: 'Review' }, options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }],
    handler_kind: 'fixture', handler_payload: {}, created_at: NOW, fanout_channels: ['ui'], ...(note ? { note_prompt: note } : {}) });
  const ui: Channel = { name: 'ui', capability: 'inline', owns_llm_egress: true,
    deliverNotify: async () => {}, deliverAsk: async () => {}, closeAsk: async () => {} };
  const records: AnswerAuditRecord[] = [], answers: Answer[] = [];
  const settingsStore = createNotificationSettingsStore(createInMemoryCollection<NotificationSettings>());
  const build = () => {
    const block = createNotificationBlock({ askStore: asks, settingsStore, channels: [ui], now: () => NOW,
      recordAnswerAudit: async record => { records.push(record); },
      refuseAnswer: async () => refuse ? { code: 'server_paused', message: 'Paused' } : undefined });
    block.registerAskHandler('fixture', async (_payload, answer) => { answers.push(answer); });
    return block;
  };
  return { asks, ui, records, answers, build, block: build() };
};
const reply = (option = 'approve') => ({ ask_id: 'ask-1', option, via: 'ui' as const });

describe('answer preparation shares the winning decision boundary', () => {
  it('serializes preparation with a competing plain answer and keeps only the winner snapshot', async () => {
    const h = await make(), entered = deferred(), release = deferred();
    const first = h.block.submitAnswer(reply(), { prepare: async () => { entered.resolve(); await release.promise; return { title: 'A' }; } });
    await entered.promise;
    const second = h.block.submitAnswer(reply('deny'));
    release.resolve();
    expect(await first).toBe('answered'); expect(await second).toBe('closed');
    expect(h.answers).toStrictEqual([{ option: 'approve', answered_at: NOW, prepared: { title: 'A' } }]);
    expect((await h.asks.get('ask-1'))?.answer?.prepared).toStrictEqual({ title: 'A' });
    expect(h.records).toHaveLength(1);
  });

  it('does not prepare a losing edit after a plain denial', async () => {
    const h = await make(), prepare = vi.fn(async () => ({ title: 'Losing' }));
    expect(await h.block.submitAnswer(reply('deny'))).toBe('answered');
    expect(await h.block.submitAnswer(reply(), { prepare })).toBe('closed');
    expect(prepare).not.toHaveBeenCalled(); expect(h.answers).toHaveLength(1);
    expect(h.answers[0]?.prepared).toBeUndefined();
  });

  it('keeps a failed preparation open and lets a later plain decision proceed without its data', async () => {
    const h = await make();
    await expect(h.block.submitAnswer(reply(), { prepare: async () => { throw new Error('validation failed'); } })).rejects.toThrow('validation failed');
    expect((await h.asks.get('ask-1'))?.status).toBe('open'); expect(h.records).toHaveLength(0); expect(h.answers).toHaveLength(0);
    await h.block.submitAnswer(reply('deny'));
    expect(h.answers).toStrictEqual([{ option: 'deny', answered_at: NOW }]);
  });

  it('rejects invalid, paused and incomplete replies before invoking the preparer', async () => {
    const prepare = vi.fn(async () => ({ title: 'Never prepared' }));
    const invalid = await make(); expect(await invalid.block.submitAnswer(reply('not-offered'), { prepare })).toBe('ignored');
    const required = await make('required'); expect(await required.block.submitAnswer(reply(), { prepare })).toBe('ignored');
    const paused = await make(undefined, true); await expect(paused.block.submitAnswer(reply(), { prepare })).rejects.toMatchObject({ code: 'server_paused' });
    expect(prepare).not.toHaveBeenCalled();
    for (const h of [invalid, required, paused]) { expect((await h.asks.get('ask-1'))?.status).toBe('open'); expect(h.records).toHaveLength(0); }
  });

  it('persists the snapshot while stopping and replays it through a fresh block', async () => {
    const h = await make(); h.block.beginStopping();
    await h.block.submitAnswer(reply(), { prepare: async () => ({ title: 'Saved winner' }) });
    expect(h.answers).toHaveLength(0); expect((await h.asks.get('ask-1'))?.status).toBe('answered');
    await h.build().recoverPendingAsks();
    expect(h.answers).toStrictEqual([{ option: 'approve', answered_at: NOW, prepared: { title: 'Saved winner' } }]);
    expect((await h.asks.get('ask-1'))?.status).toBe('handled');
  });

  it('freezes prepared data before channel closing and dispatch', async () => {
    const h = await make(), closing = deferred(), release = deferred(), data = { title: 'A' };
    h.ui.closeAsk = async () => { closing.resolve(); await release.promise; };
    const answer = h.block.submitAnswer(reply(), { prepare: async () => data });
    await closing.promise; data.title = 'B'; h.records[0]!.prepared!.title = 'audit mutation'; release.resolve(); await answer;
    expect(h.answers[0]?.prepared).toStrictEqual({ title: 'A' });
    h.answers[0]!.prepared!.title = 'handler mutation';
    expect((await h.asks.get('ask-1'))?.answer?.prepared).toStrictEqual({ title: 'A' });
  });

  it('keeps a failed answer write free of dispatched data and recovers an after-write error as recorded', async () => {
    const before = await make(), original = before.asks.recordAnswer.bind(before.asks);
    before.asks.recordAnswer = async () => { throw new Error('write failed'); };
    await expect(before.block.submitAnswer(reply(), { prepare: async () => ({ title: 'A' }) })).rejects.toThrow('write failed');
    expect((await before.asks.get('ask-1'))?.status).toBe('open'); expect(before.records).toHaveLength(0); expect(before.answers).toHaveLength(0);
    before.asks.recordAnswer = original; await before.block.submitAnswer(reply('deny'));
    expect(before.answers[0]?.prepared).toBeUndefined();
    const after = await make(), write = after.asks.recordAnswer.bind(after.asks);
    after.asks.recordAnswer = async (...args) => { await write(...args); throw new Error('committed then disconnected'); };
    expect(await after.block.submitAnswer(reply(), { prepare: async () => ({ title: 'A' }) })).toBe('answered');
    expect(after.answers[0]?.prepared).toStrictEqual({ title: 'A' }); expect(after.records).toHaveLength(1);
  });

  it('does not admit prepared data supplied by an inbound reply', async () => {
    const h = await make();
    await h.block.submitAnswer({ ...reply(), prepared: { title: 'Untrusted' } } as ReturnType<typeof reply>);
    expect(h.answers[0]?.prepared).toBeUndefined();
  });
});
