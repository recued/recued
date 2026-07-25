/** D-158 P2b inbound-email-answer funnel tests.
 *
 *  Pins the contract for `composeInboundEmailAnswer` — the reply-by-email
 *  path: a synced `data.mail` record in the notification account's mailbox
 *  → extract the `[#ask-…]` tag → load the ask's options → exact-match the
 *  reply → `block.submitAnswer`.
 *
 *  Uses the REAL warehouse-event bus so the `data.mail.**` subscription +
 *  pattern matching are exercised (not a fake), and a minimal fake block
 *  (`getAsk` / `submitAnswer` are the only methods the funnel touches). */

import { describe, expect, it, vi } from 'vitest';
import type {
  InboundReply,
  NotificationBlock,
  PendingAsk,
} from '@recued/notification';
import {
  createWarehouseEventBus,
  type WarehouseEvent,
} from '@recued/warehouse-events';

import {
  composeInboundEmailAnswer,
  type ComposeInboundEmailAnswerDeps,
  type InboundMailRecord,
} from '../composition/bin/wire-inbound-email-answer.js';

// ── Fixtures ─────────────────────────────────────────────────────────

const ACCOUNT_SLUG = 'work';
const ASK_ID = 'ask-deploy-42';

const openAsk = (ask_id = ASK_ID): PendingAsk => ({
  ask_id,
  message: { text: 'Approve the deploy?' },
  options: [
    { id: 'approve', label: 'Approve' },
    { id: 'reject', label: 'Reject' },
  ],
  handler_kind: 'test.handler',
  handler_payload: {},
  fanout_channels: ['email'],
  status: 'open',
  created_at: 0,
});

/** A tagged inbound reply record — subject carries `[#ask-…]`, body is the
 *  user's typed option above the quoted original. */
const inboundReplyRecord = (
  over: Partial<InboundMailRecord> = {},
): InboundMailRecord => ({
  subject: `Re: Recued — your input is needed [#${ASK_ID}]`,
  folder: 'INBOX',
  from: 'owner@example.com',
  body_text: 'approve\n\nOn Tue, someone wrote:\n> Approve the deploy?',
  ...over,
});

const mailCreated = (over: Partial<WarehouseEvent> = {}): WarehouseEvent => ({
  platform: 'mail',
  slug: ACCOUNT_SLUG,
  entity_type: 'message',
  event_kind: 'created',
  record_id: 'msg-1',
  at: 1,
  ...over,
});

interface Harness {
  submitAnswer: ReturnType<typeof vi.fn>;
  getAsk: ReturnType<typeof vi.fn>;
  readInboundMail: NonNullable<ComposeInboundEmailAnswerDeps['readInboundMail']>;
  block: NotificationBlock;
}

const makeHarness = (opts: {
  ask?: PendingAsk | null;
  record?: InboundMailRecord | null;
} = {}): Harness => {
  const submitAnswer = vi.fn(async (_reply: InboundReply) => {});
  const getAsk = vi.fn(async (_id: string) =>
    opts.ask === undefined ? openAsk() : opts.ask,
  );
  const readInboundMailSpy = vi.fn(
    async (_slug: string, _id: string): Promise<InboundMailRecord | null> =>
      opts.record === undefined ? inboundReplyRecord() : opts.record,
  );
  // The spy is the runtime seam; the precise-signature cast lets it slot
  // into `ComposeInboundEmailAnswerDeps.readInboundMail` while `expect(...)`
  // still reads its call record.
  const readInboundMail =
    readInboundMailSpy as unknown as NonNullable<
      ComposeInboundEmailAnswerDeps['readInboundMail']
    >;
  const block = { getAsk, submitAnswer } as unknown as NotificationBlock;
  return { submitAnswer, getAsk, readInboundMail, block };
};

/** Let the fire-and-forget handler's promise chain drain after an emit. */
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

// ── Tests ────────────────────────────────────────────────────────────

describe('composeInboundEmailAnswer', () => {
  it('records an inbound reply → submitAnswer with the matched option', async () => {
    const bus = createWarehouseEventBus();
    const h = makeHarness();
    const funnel = composeInboundEmailAnswer({
      block: h.block,
      bus,
      resolveEmailAccountSlug: () => ACCOUNT_SLUG,
      readInboundMail: h.readInboundMail,
    });
    funnel.start();

    bus.emit(mailCreated());
    await flush();

    expect(h.readInboundMail).toHaveBeenCalledWith(ACCOUNT_SLUG, 'msg-1');
    expect(h.getAsk).toHaveBeenCalledWith(ASK_ID);
    expect(h.submitAnswer).toHaveBeenCalledTimes(1);
    expect(h.submitAnswer).toHaveBeenCalledWith({
      ask_id: ASK_ID,
      option: 'approve',
      via: 'email',
    });
    funnel.dispose();
  });

  it('ignores a non-created event (an is-read flip / re-sync updated)', async () => {
    const bus = createWarehouseEventBus();
    const h = makeHarness();
    composeInboundEmailAnswer({
      block: h.block,
      bus,
      resolveEmailAccountSlug: () => ACCOUNT_SLUG,
      readInboundMail: h.readInboundMail,
    }).start();

    bus.emit(mailCreated({ event_kind: 'updated' }));
    await flush();

    expect(h.readInboundMail).not.toHaveBeenCalled();
    expect(h.submitAnswer).not.toHaveBeenCalled();
  });

  it('ignores mail in a different account than the notification mailbox', async () => {
    const bus = createWarehouseEventBus();
    const h = makeHarness();
    composeInboundEmailAnswer({
      block: h.block,
      bus,
      resolveEmailAccountSlug: () => ACCOUNT_SLUG,
      readInboundMail: h.readInboundMail,
    }).start();

    bus.emit(mailCreated({ slug: 'personal' }));
    await flush();

    expect(h.readInboundMail).not.toHaveBeenCalled();
    expect(h.submitAnswer).not.toHaveBeenCalled();
  });

  it('does nothing when no email account is enrolled (null slug)', async () => {
    const bus = createWarehouseEventBus();
    const h = makeHarness();
    composeInboundEmailAnswer({
      block: h.block,
      bus,
      resolveEmailAccountSlug: () => null,
      readInboundMail: h.readInboundMail,
    }).start();

    bus.emit(mailCreated());
    await flush();

    expect(h.readInboundMail).not.toHaveBeenCalled();
    expect(h.submitAnswer).not.toHaveBeenCalled();
  });

  it("skips the server's own sent ask-copy (sent-like folder)", async () => {
    const bus = createWarehouseEventBus();
    const h = makeHarness({ record: inboundReplyRecord({ folder: 'SENT' }) });
    composeInboundEmailAnswer({
      block: h.block,
      bus,
      resolveEmailAccountSlug: () => ACCOUNT_SLUG,
      readInboundMail: h.readInboundMail,
    }).start();

    bus.emit(mailCreated());
    await flush();

    expect(h.getAsk).not.toHaveBeenCalled();
    expect(h.submitAnswer).not.toHaveBeenCalled();
  });

  it('skips a subject with no ask tag', async () => {
    const bus = createWarehouseEventBus();
    const h = makeHarness({
      record: inboundReplyRecord({ subject: 'Re: lunch?' }),
    });
    composeInboundEmailAnswer({
      block: h.block,
      bus,
      resolveEmailAccountSlug: () => ACCOUNT_SLUG,
      readInboundMail: h.readInboundMail,
    }).start();

    bus.emit(mailCreated());
    await flush();

    expect(h.getAsk).not.toHaveBeenCalled();
    expect(h.submitAnswer).not.toHaveBeenCalled();
  });

  it('skips an unknown ask (getAsk null)', async () => {
    const bus = createWarehouseEventBus();
    const h = makeHarness({ ask: null });
    composeInboundEmailAnswer({
      block: h.block,
      bus,
      resolveEmailAccountSlug: () => ACCOUNT_SLUG,
      readInboundMail: h.readInboundMail,
    }).start();

    bus.emit(mailCreated());
    await flush();

    expect(h.getAsk).toHaveBeenCalledWith(ASK_ID);
    expect(h.submitAnswer).not.toHaveBeenCalled();
  });

  it('skips an ask that is no longer open', async () => {
    const bus = createWarehouseEventBus();
    const h = makeHarness({ ask: { ...openAsk(), status: 'answered' } });
    composeInboundEmailAnswer({
      block: h.block,
      bus,
      resolveEmailAccountSlug: () => ACCOUNT_SLUG,
      readInboundMail: h.readInboundMail,
    }).start();

    bus.emit(mailCreated());
    await flush();

    expect(h.submitAnswer).not.toHaveBeenCalled();
  });

  it('skips a reply that matches no option (exact-match safety)', async () => {
    const bus = createWarehouseEventBus();
    const h = makeHarness({
      record: inboundReplyRecord({
        body_text: "maybe, I'm not sure\n\nOn Tue, someone wrote:\n> ...",
      }),
    });
    composeInboundEmailAnswer({
      block: h.block,
      bus,
      resolveEmailAccountSlug: () => ACCOUNT_SLUG,
      readInboundMail: h.readInboundMail,
    }).start();

    bus.emit(mailCreated());
    await flush();

    expect(h.submitAnswer).not.toHaveBeenCalled();
  });

  it('skips a missing / unreadable record (readInboundMail null)', async () => {
    const bus = createWarehouseEventBus();
    const h = makeHarness({ record: null });
    composeInboundEmailAnswer({
      block: h.block,
      bus,
      resolveEmailAccountSlug: () => ACCOUNT_SLUG,
      readInboundMail: h.readInboundMail,
    }).start();

    bus.emit(mailCreated());
    await flush();

    expect(h.getAsk).not.toHaveBeenCalled();
    expect(h.submitAnswer).not.toHaveBeenCalled();
  });

  it('is inert when a required dep is absent (no subscription)', async () => {
    const bus = createWarehouseEventBus();
    const h = makeHarness();
    // No `block` ⇒ inert; start() must not subscribe.
    composeInboundEmailAnswer({
      bus,
      resolveEmailAccountSlug: () => ACCOUNT_SLUG,
      readInboundMail: h.readInboundMail,
    }).start();

    bus.emit(mailCreated());
    await flush();

    expect(h.readInboundMail).not.toHaveBeenCalled();
  });

  it('never throws into the bus emit when the handler rejects', async () => {
    const bus = createWarehouseEventBus();
    const h = makeHarness();
    h.submitAnswer.mockRejectedValueOnce(new Error('storage down'));
    const warn = vi.fn();
    composeInboundEmailAnswer({
      block: h.block,
      bus,
      resolveEmailAccountSlug: () => ACCOUNT_SLUG,
      readInboundMail: h.readInboundMail,
      log: warn,
    }).start();

    // A synchronous emit must not throw even though submitAnswer rejects.
    expect(() => bus.emit(mailCreated())).not.toThrow();
    await flush();

    expect(warn).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('handler threw'),
      expect.objectContaining({ error: 'storage down' }),
    );
  });

  it('never throws into the bus emit when a seam throws (async-caught)', async () => {
    const bus = createWarehouseEventBus();
    const h = makeHarness();
    const warn = vi.fn();
    composeInboundEmailAnswer({
      block: h.block,
      bus,
      // A seam that throws in `handle`'s pre-await prefix — because `handle`
      // is async this surfaces as a promise rejection, so the `.catch` guard
      // still keeps it out of the synchronous emit path (which would break
      // the reactive trigger dispatcher + every other subscriber).
      resolveEmailAccountSlug: () => {
        throw new Error('vault locked');
      },
      readInboundMail: h.readInboundMail,
      log: warn,
    }).start();

    expect(() => bus.emit(mailCreated())).not.toThrow();
    await flush();

    expect(warn).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('handler threw'),
      expect.objectContaining({ error: 'vault locked' }),
    );
    expect(h.submitAnswer).not.toHaveBeenCalled();
  });

  it('stops firing after dispose()', async () => {
    const bus = createWarehouseEventBus();
    const h = makeHarness();
    const funnel = composeInboundEmailAnswer({
      block: h.block,
      bus,
      resolveEmailAccountSlug: () => ACCOUNT_SLUG,
      readInboundMail: h.readInboundMail,
    });
    funnel.start();
    funnel.dispose();

    bus.emit(mailCreated());
    await flush();

    expect(h.submitAnswer).not.toHaveBeenCalled();
  });
});
