/** D-210 — the answer-audit row + the terminal-ask retention sweep.
 *
 *  These two are ONE change and the order between them is the point. The
 *  ask row used to be the only record of what the owner was shown, which
 *  option they picked, which channel they answered on, and when — no audit
 *  row referenced a terminal ask at all. So the audit write is the
 *  PRECONDITION for the prune, and the prune's `handled`-only rule is what
 *  keeps it from eating the retry queue. */

import { createInMemoryCollection } from '@recued/storage';
import { describe, expect, it, vi } from 'vitest';
import {
  HANDLED_ASK_RETENTION_MS,
  createAskStore,
  createNotificationBlock,
  createNotificationSettings,
  createNotificationSettingsStore,
  type AnswerAuditRecord,
  type Channel,
  type NotificationSettings,
  type PendingAsk,
} from '@recued/notification';

const NOW = 1_700_000_000_000;

const makeBlock = (over: { audit?: (r: AnswerAuditRecord) => Promise<void> } = {}) => {
  const collection = createInMemoryCollection<PendingAsk>();
  const askStore = createAskStore(collection);
  const settingsStore = createNotificationSettingsStore(
    createInMemoryCollection<NotificationSettings>(),
  );
  void createNotificationSettings({ store: settingsStore });
  const ui: Channel = {
    name: 'ui',
    capability: 'inline',
    owns_llm_egress: true,
    deliverNotify: vi.fn(async () => undefined),
    deliverAsk: vi.fn(async () => undefined),
    closeAsk: vi.fn(async () => undefined),
  };
  const records: AnswerAuditRecord[] = [];
  const recordAnswerAudit = vi.fn(
    over.audit ??
      (async (r: AnswerAuditRecord) => {
        records.push(r);
      }),
  );
  const block = createNotificationBlock({
    askStore,
    settingsStore,
    channels: [ui],
    now: () => NOW,
    recordAnswerAudit,
  });
  return { block, askStore, collection, records, recordAnswerAudit, settingsStore };
};

/** `ui` is always-on (D-158 N.4 forces it true on every read), so the
 *  default record already enables the one channel these tests fan out to —
 *  no seeding needed. */
const raise = async (h: ReturnType<typeof makeBlock>): Promise<string> => {
  const { ask_id } = await h.block.ask(
    { title: 'Approve scheduling.materialize', text: 'Approve?' },
    [
      { id: 'approve', label: 'Approve' },
      { id: 'deny', label: 'Deny' },
    ],
    { kind: 'gateway.preflight', payload: { checkpoint_id: 'cp-1' } },
  );
  return ask_id;
};

// ────────────────────────────────────────────────────────────────
// Step 1 — the answer becomes a durable record
// ────────────────────────────────────────────────────────────────

describe('D-210 — answer audit', () => {
  it('records the decision facts, including the CHANNEL the answer came on', async () => {
    // `answered_via` is the one fact no downstream layer can recover:
    // `dispatchAnswer` strips channel identity before the handler runs
    // (I-10), so an audit written there could never carry it.
    const h = makeBlock();
    const ask_id = await raise(h);
    await h.block.submitAnswer({ ask_id, option: 'approve', via: 'slack' });
    expect(h.records).toEqual([
      {
        ask_id,
        handler_kind: 'gateway.preflight',
        option: 'approve',
        option_label: 'Approve',
        title: 'Approve scheduling.materialize',
        answered_at: NOW,
        answered_via: 'slack',
      },
    ]);
  });

  it('writes EXACTLY ONE row per ask, and the replay is a SILENT no-op', async () => {
    // ⚠ TWO layers enforce once-only and only one of them is under test here.
    // `AskStore.recordAnswer` THROWS on a non-open ask, so "one record" alone
    // passes even with the block's own `status !== 'open'` guard deleted —
    // the store's throw carries it, and the mutation survived.
    //
    // The block's guard does something the store cannot: it makes the second
    // reply a *quiet* no-op (I-6), rather than a rejected `submitAnswer` for
    // a decision that was already recorded. So the resolution IS the
    // assertion, alongside the count.
    const h = makeBlock();
    const ask_id = await raise(h);
    await h.block.submitAnswer({ ask_id, option: 'approve', via: 'ui' });
    await expect(
      h.block.submitAnswer({ ask_id, option: 'deny', via: 'email' }),
    ).resolves.toBeUndefined();
    expect(h.records).toHaveLength(1);
    expect(h.records[0]!.option).toBe('approve');
    expect(h.records[0]!.answered_via).toBe('ui');
  });

  it('writes NO row for a reply that was never a valid answer', async () => {
    const h = makeBlock();
    const ask_id = await raise(h);
    // An option the ask never offered is not an answer (and `submitAnswer`
    // silently no-ops it) — auditing it would record a decision nobody made.
    await h.block.submitAnswer({ ask_id, option: 'allow_session', via: 'ui' });
    await h.block.submitAnswer({ ask_id: 'no-such-ask', option: 'approve', via: 'ui' });
    expect(h.records).toEqual([]);
  });

  it('never loses the answer when the audit seam THROWS', async () => {
    // At the call site the decision is already durable, and TR-4's forbidden
    // failure is silently dropping a decision the user made. So an audit
    // fault must not reject `submitAnswer`.
    const h = makeBlock({
      audit: async () => {
        throw new Error('audit store down');
      },
    });
    const ask_id = await raise(h);
    await expect(
      h.block.submitAnswer({ ask_id, option: 'approve', via: 'ui' }),
    ).resolves.toBeUndefined();
    const ask = await h.block.getAsk(ask_id);
    expect(ask?.status).not.toBe('open');
    expect(ask?.answer?.option).toBe('approve');
  });

  it('falls back to the raw option id when the label is gone', async () => {
    const h = makeBlock();
    const { ask_id } = await h.block.ask(
      { text: 'no title here' },
      [{ id: 'approve', label: 'Approve' }],
      { kind: 'gateway.preflight', payload: {} },
    );
    await h.block.submitAnswer({ ask_id, option: 'approve', via: 'ui' });
    // No title on the message ⇒ the field is absent, not an empty string.
    expect(Object.hasOwn(h.records[0]!, 'title')).toBe(false);
    expect(h.records[0]!.option_label).toBe('Approve');
  });
});

// ────────────────────────────────────────────────────────────────
// Step 2 — the terminal-ask sweep
// ────────────────────────────────────────────────────────────────

const seedRow = async (
  h: ReturnType<typeof makeBlock>,
  ask_id: string,
  status: PendingAsk['status'],
  created_at: number,
): Promise<void> => {
  await h.collection.set(ask_id, {
    ask_id,
    message: { text: 'x' },
    options: [{ id: 'approve', label: 'Approve' }],
    handler_kind: 'gateway.preflight',
    handler_payload: {},
    fanout_channels: ['ui'],
    status,
    created_at,
  });
};

describe('D-210 — handled-ask retention', () => {
  const OLD = NOW - HANDLED_ASK_RETENTION_MS - 1;
  const FRESH = NOW - 1000;

  it('drops handled rows past the window and keeps fresh ones', async () => {
    const h = makeBlock();
    await seedRow(h, 'old', 'handled', OLD);
    await seedRow(h, 'fresh', 'handled', FRESH);
    expect(await h.block.pruneHandledAsks(NOW - HANDLED_ASK_RETENTION_MS)).toBe(1);
    expect(await h.block.getAsk('old')).toBeNull();
    expect(await h.block.getAsk('fresh')).not.toBeNull();
  });

  it('⛔ NEVER drops an `answered` row — that is the retry queue, not history', async () => {
    // `recoverPendingAsks` re-dispatches answered-but-unhandled asks after a
    // crash, and `checkpoint-retention` refuses to expire a checkpoint whose
    // ask is `answered`. Deleting one drops a decision the user made.
    const h = makeBlock();
    await seedRow(h, 'answered-ancient', 'answered', 0);
    expect(await h.block.pruneHandledAsks(NOW)).toBe(0);
    expect(await h.block.getAsk('answered-ancient')).not.toBeNull();
  });

  it('⛔ NEVER drops an `open` row — that is a live decision', async () => {
    // An unanswered ask's expiry is `preflight.stale_after_days`, which
    // cancels it deliberately; this sweep must not race that policy.
    const h = makeBlock();
    await seedRow(h, 'open-ancient', 'open', 0);
    expect(await h.block.pruneHandledAsks(NOW)).toBe(0);
    expect(await h.block.getAsk('open-ancient')).not.toBeNull();
  });

  it('keeps a row exactly AT the boundary', async () => {
    const h = makeBlock();
    const cutoff = NOW - HANDLED_ASK_RETENTION_MS;
    await seedRow(h, 'boundary', 'handled', cutoff);
    expect(await h.block.pruneHandledAsks(cutoff)).toBe(0);
    expect(await h.block.getAsk('boundary')).not.toBeNull();
  });

  it('a full answer→handled lifecycle leaves a prunable row AND an audit record', async () => {
    // The end-to-end shape the slice exists for: after the decision is
    // dispatched, the ask row is residue and the activity row is the record.
    const h = makeBlock();
    const ask_id = await raise(h);
    h.block.registerAskHandler('gateway.preflight', async () => {});
    await h.block.submitAnswer({ ask_id, option: 'approve', via: 'telegram' });
    expect((await h.block.getAsk(ask_id))?.status).toBe('handled');
    expect(h.records).toHaveLength(1);
    expect(h.records[0]!.answered_via).toBe('telegram');
    expect(await h.block.pruneHandledAsks(NOW + 1)).toBe(1);
    expect(await h.block.getAsk(ask_id)).toBeNull();
    // The decision survives the row.
    expect(h.records[0]!.option).toBe('approve');
  });
});
