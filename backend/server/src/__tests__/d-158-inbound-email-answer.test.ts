/** D-158 P2b inbound-email-answer funnel, with the sender proven (D-318 P23).
 *
 *  An emailed ask is answered by a reply only when the reply is proven the
 *  owner's: (a) the Sent copy, by the provider's own record, in a mailbox
 *  Recued reads, addressed to the notification mailbox; or (b) a message in
 *  the notification mailbox from the owner's notification address with the
 *  receiving provider's `dmarc=pass` for its domain. Before P23 any message in
 *  the notification mailbox with an open ask's tag and an option's text
 *  answered it, whoever sent it — the first case below is that attack.
 *
 *  Driven at the mail upsert hook, with real `mailHeaderMap` headers, so the
 *  first-value rule that keeps a planted stamp from being read is the one the
 *  sync uses. The block is a fake: `getAsk` / `submitAnswer` are all the funnel
 *  touches. */

import { describe, expect, it, vi } from 'vitest';
import type { NotificationBlock, PendingAsk } from '@recued/notification';

import type { MailUpsertContext } from '../collections/mail/mail-collection.js';
import { mailHeaderMap, type CanonicalMessage } from '../collections/mail/provider.js';
import {
  composeInboundEmailAnswer,
  createLateEmailAnswerHook,
  dmarcPassFor,
  emailAnswerProof,
  type EmailAnswerAccounts,
} from '../composition/bin/wire-inbound-email-answer.js';

// ── Fixtures ─────────────────────────────────────────────────────────

const ASK_ID = 'ask-deploy-42';
const NOW = 1_800_000_000_000;

/** Asks go from the `alerts` mailbox to the owner's address; the owner's own
 *  mailbox, `owner`, is also read by Recued. */
const ACCOUNTS: EmailAnswerAccounts = {
  sender_slug: 'alerts',
  sender_address: 'alerts@recued-owner.example',
  recipient_address: 'owner@example.com',
};

const GMAIL_PASS = 'mx.google.com; dkim=pass header.i=@example.com header.s=s1; '
  + 'spf=pass (google.com: domain of owner@example.com designates 1.2.3.4) smtp.mailfrom=owner@example.com; '
  + 'dmarc=pass (p=NONE sp=QUARANTINE dis=NONE) header.from=example.com';

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

/** The owner's reply as it lands in the notification mailbox. */
const inboxReply = (over: Partial<CanonicalMessage> = {}): CanonicalMessage => ({
  source_id: 'reply-1',
  rfc_message_id: '<reply-1@example.com>',
  from: 'Owner <owner@example.com>',
  to: ['Recued alerts <alerts@recued-owner.example>'],
  cc: [],
  subject: `Re: Recued — your input is needed [#${ASK_ID}]`,
  thread_id: 'thread-1',
  folder_or_label: 'INBOX',
  direction: 'inbound',
  is_read: false,
  is_flagged: false,
  has_attachments: false,
  received_at: NOW - 60_000,
  body_text: 'approve\n\nOn Tue, Recued wrote:\n> Approve the deploy?',
  headers: mailHeaderMap([['Authentication-Results', GMAIL_PASS]]),
  ...over,
});

/** The same reply as the owner's own mailbox keeps it: its Sent copy. */
const sentCopy = (over: Partial<CanonicalMessage> = {}): CanonicalMessage =>
  inboxReply({ folder_or_label: 'SENT', direction: 'outbound', headers: {}, ...over });

const ctxIn = (slug: string, over: Partial<MailUpsertContext> = {}): MailUpsertContext => ({
  slug,
  record_id: `${slug}:1`,
  account_email: slug === ACCOUNTS.sender_slug ? ACCOUNTS.sender_address : ACCOUNTS.recipient_address,
  first_seen: true,
  backfill_complete: true,
  backfill_days: 30,
  attachments: [],
  ...over,
});

interface Harness {
  submitAnswer: ReturnType<typeof vi.fn>;
  getAsk: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
  funnel: ReturnType<typeof composeInboundEmailAnswer>;
}

const makeHarness = (opts: {
  ask?: PendingAsk | null;
  accounts?: EmailAnswerAccounts | null;
  getAsk?: ReturnType<typeof vi.fn>;
} = {}): Harness => {
  const submitAnswer = vi.fn(async () => ({ outcome: 'accepted' as const }));
  const getAsk = opts.getAsk ?? vi.fn(async () => (opts.ask === undefined ? openAsk() : opts.ask));
  const block = { getAsk, submitAnswer } as unknown as NotificationBlock;
  const log = vi.fn();
  const accounts = opts.accounts === undefined ? ACCOUNTS : opts.accounts;
  const funnel = composeInboundEmailAnswer({ block, resolveAccounts: () => accounts, now: () => NOW, log });
  return { submitAnswer, getAsk, log, funnel };
};

/** Let the background answer settle. */
const settle = async (funnel: Harness['funnel']): Promise<void> => {
  await funnel.dispose();
};

// ── The proofs ───────────────────────────────────────────────────────

describe('emailAnswerProof — who may answer an emailed ask (D-318 P23)', () => {
  it('⛔ a reply in the notification mailbox with the owner\'s From and no stamp proves nothing', () => {
    expect(emailAnswerProof(inboxReply({ headers: {} }), ctxIn('alerts'), ACCOUNTS)).toBeNull();
    expect(emailAnswerProof(inboxReply({ headers: undefined }), ctxIn('alerts'), ACCOUNTS)).toBeNull();
  });

  it('(a) the Sent copy in a mailbox Recued reads, addressed to the notification mailbox', () => {
    expect(emailAnswerProof(sentCopy(), ctxIn('owner'), ACCOUNTS)).toBe('own_sent_record');
  });

  it('(a) not when the Sent copy is addressed elsewhere, or sits in the notification mailbox itself', () => {
    expect(emailAnswerProof(sentCopy({ to: ['someone@else.example'] }), ctxIn('owner'), ACCOUNTS)).toBeNull();
    expect(emailAnswerProof(sentCopy(), ctxIn('alerts'), ACCOUNTS)).toBeNull();
  });

  it('(a) never Recued\'s own mail or a draft, even in Sent', () => {
    expect(emailAnswerProof(sentCopy({ reconciliation_id: 'rcd-0123456789abcdef' }), ctxIn('owner'), ACCOUNTS))
      .toBeNull();
    expect(emailAnswerProof(sentCopy({ direction: 'draft' }), ctxIn('owner'), ACCOUNTS)).toBeNull();
  });

  it('(b) the owner\'s address with the receiving provider\'s dmarc=pass for its domain', () => {
    expect(emailAnswerProof(inboxReply(), ctxIn('alerts'), ACCOUNTS)).toBe('dmarc_pass');
  });

  it('(b) not from another address, nor in another mailbox', () => {
    expect(emailAnswerProof(inboxReply({ from: 'mallory@example.com' }), ctxIn('alerts'), ACCOUNTS)).toBeNull();
    expect(emailAnswerProof(inboxReply(), ctxIn('owner'), ACCOUNTS)).toBeNull();
  });

  it('⛔ (b) a planted pass below the provider\'s own fail is never the one read', () => {
    const headers = mailHeaderMap([
      ['Authentication-Results', 'mx.google.com; dmarc=fail (p=NONE) header.from=example.com'],
      ['Authentication-Results', 'evil.example; dmarc=pass header.from=example.com'],
    ]);
    expect(emailAnswerProof(inboxReply({ headers }), ctxIn('alerts'), ACCOUNTS)).toBeNull();
  });

  it('nothing without a sender or recipient address to compare', () => {
    expect(emailAnswerProof(inboxReply(), ctxIn('alerts'), { ...ACCOUNTS, recipient_address: '' })).toBeNull();
    expect(emailAnswerProof(sentCopy(), ctxIn('owner'), { ...ACCOUNTS, sender_address: '' })).toBeNull();
  });
});

describe('dmarcPassFor — reading an Authentication-Results stamp', () => {
  it('reads a Gmail stamp, comments and all', () => {
    expect(dmarcPassFor(GMAIL_PASS, 'example.com')).toBe(true);
    expect(dmarcPassFor(GMAIL_PASS, 'EXAMPLE.com')).toBe(true);
  });

  it('reads a Microsoft stamp, which has no authserv-id', () => {
    const outlook = 'spf=pass (sender IP is 1.2.3.4) smtp.mailfrom=example.com; dkim=pass (signature was '
      + 'verified) header.d=example.com;dmarc=pass action=none header.from=example.com;compauth=pass reason=100';
    expect(dmarcPassFor(outlook, 'example.com')).toBe(true);
  });

  it('refuses a fail, a none, another domain, a pass of another method, and no stamp', () => {
    expect(dmarcPassFor('mx.google.com; dmarc=fail header.from=example.com', 'example.com')).toBe(false);
    expect(dmarcPassFor('mx.google.com; dmarc=none header.from=example.com', 'example.com')).toBe(false);
    expect(dmarcPassFor('mx.google.com; dmarc=pass header.from=evil.example', 'example.com')).toBe(false);
    expect(dmarcPassFor('mx.google.com; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com',
      'example.com')).toBe(false);
    expect(dmarcPassFor('mx.google.com; dmarc=pass header.from=sub.example.com', 'example.com')).toBe(false);
    // Only DMARC's verdict counts, even where another method names the From domain.
    expect(dmarcPassFor('mx.example; dmarc=fail header.from=example.com; arc=pass header.from=example.com',
      'example.com')).toBe(false);
    expect(dmarcPassFor(undefined, 'example.com')).toBe(false);
    expect(dmarcPassFor('mx.google.com; dmarc=pass header.from=example.com', '')).toBe(false);
  });
});

// ── The hook ─────────────────────────────────────────────────────────

describe('composeInboundEmailAnswer — the upsert hook', () => {
  it('(a) answers the ask from the owner\'s Sent copy', async () => {
    const h = makeHarness();
    h.funnel.onMessageUpserted(sentCopy(), ctxIn('owner'));
    await settle(h.funnel);
    expect(h.getAsk).toHaveBeenCalledWith(ASK_ID);
    expect(h.submitAnswer).toHaveBeenCalledTimes(1);
    expect(h.submitAnswer.mock.calls[0]![0]).toMatchObject({ ask_id: ASK_ID, option: 'approve' });
  });

  it('(b) answers the ask from a DMARC-passed reply in the notification mailbox', async () => {
    const h = makeHarness();
    h.funnel.onMessageUpserted(inboxReply(), ctxIn('alerts'));
    await settle(h.funnel);
    expect(h.submitAnswer).toHaveBeenCalledTimes(1);
    expect(h.submitAnswer.mock.calls[0]![0]).toMatchObject({ ask_id: ASK_ID, option: 'approve' });
  });

  it('⛔ a forged reply answers nothing, says so, and never loads the ask', async () => {
    const h = makeHarness();
    h.funnel.onMessageUpserted(inboxReply({ headers: {} }), ctxIn('alerts'));
    await settle(h.funnel);
    expect(h.getAsk).not.toHaveBeenCalled();
    expect(h.submitAnswer).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith('warn', expect.stringContaining('not proven'), { ask_id: ASK_ID });
  });

  it('answers nothing from mail that is not news', async () => {
    for (const ctx of [
      ctxIn('owner', { first_seen: false }),
      ctxIn('owner', { backfill_complete: false }),
    ]) {
      const h = makeHarness();
      h.funnel.onMessageUpserted(sentCopy(), ctx);
      await settle(h.funnel);
      expect(h.submitAnswer).not.toHaveBeenCalled();
    }
    const old = makeHarness();
    old.funnel.onMessageUpserted(sentCopy({ received_at: NOW - 31 * 86_400_000 }), ctxIn('owner'));
    await settle(old.funnel);
    expect(old.submitAnswer).not.toHaveBeenCalled();
  });

  it('skips a subject with no ask tag without looking further', async () => {
    const h = makeHarness();
    h.funnel.onMessageUpserted(sentCopy({ subject: 'Re: lunch' }), ctxIn('owner'));
    await settle(h.funnel);
    expect(h.getAsk).not.toHaveBeenCalled();
  });

  it('skips an unknown ask, an ask no longer open, and a reply matching no option', async () => {
    const unknown = makeHarness({ ask: null });
    unknown.funnel.onMessageUpserted(sentCopy(), ctxIn('owner'));
    await settle(unknown.funnel);
    expect(unknown.submitAnswer).not.toHaveBeenCalled();

    const resolved = makeHarness({ ask: { ...openAsk(), status: 'answered' } });
    resolved.funnel.onMessageUpserted(sentCopy(), ctxIn('owner'));
    await settle(resolved.funnel);
    expect(resolved.submitAnswer).not.toHaveBeenCalled();

    const vague = makeHarness();
    vague.funnel.onMessageUpserted(sentCopy({ body_text: 'do not approve' }), ctxIn('owner'));
    await settle(vague.funnel);
    expect(vague.submitAnswer).not.toHaveBeenCalled();
  });

  it('does nothing when email asks are not set up', async () => {
    const h = makeHarness({ accounts: null });
    h.funnel.onMessageUpserted(sentCopy(), ctxIn('owner'));
    await settle(h.funnel);
    expect(h.getAsk).not.toHaveBeenCalled();
  });

  it('is inert without a block, and never throws', () => {
    const funnel = composeInboundEmailAnswer({ resolveAccounts: () => ACCOUNTS });
    expect(() => funnel.onMessageUpserted(sentCopy(), ctxIn('owner'))).not.toThrow();
  });

  it('never throws into the sync when loading the ask fails', async () => {
    const h = makeHarness({ getAsk: vi.fn(async () => { throw new Error('db gone'); }) });
    expect(() => h.funnel.onMessageUpserted(sentCopy(), ctxIn('owner'))).not.toThrow();
    await settle(h.funnel);
    expect(h.log).toHaveBeenCalledWith('warn', expect.stringContaining('answer failed'), { error: 'db gone' });
  });

  it('dispose waits for an answer in flight, and nothing is answered after it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = makeHarness({ getAsk: vi.fn(async () => { await gate; return openAsk(); }) });
    h.funnel.onMessageUpserted(sentCopy(), ctxIn('owner'));
    let disposed = false;
    const done = h.funnel.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    release();
    await done;
    expect(h.submitAnswer).toHaveBeenCalledTimes(1);

    h.funnel.onMessageUpserted(sentCopy({ rfc_message_id: '<reply-2@example.com>' }), ctxIn('owner'));
    await h.funnel.dispose();
    expect(h.submitAnswer).toHaveBeenCalledTimes(1);
  });
});

// ── Bound late ───────────────────────────────────────────────────────

describe('createLateEmailAnswerHook — mail read before the check is bound', () => {
  it('keeps only ask-tagged mail until bound, then hands it over in order and passes the rest straight on', () => {
    const late = createLateEmailAnswerHook();
    const first = sentCopy({ rfc_message_id: '<a@x>' });
    const second = sentCopy({ rfc_message_id: '<b@x>' });
    late.run(first, ctxIn('owner'));
    late.run(sentCopy({ subject: 'Re: lunch' }), ctxIn('owner'));
    late.run(second, ctxIn('owner'));

    const hook = vi.fn();
    late.bind(hook);
    expect(hook.mock.calls.map(([msg]) => (msg as CanonicalMessage).rfc_message_id)).toEqual(['<a@x>', '<b@x>']);

    const third = sentCopy({ subject: 'Re: lunch' });
    late.run(third, ctxIn('owner'));
    expect(hook).toHaveBeenLastCalledWith(third, ctxIn('owner'));
  });

  it('keeps the newest fifty when more arrive before it is bound', () => {
    const late = createLateEmailAnswerHook();
    for (let i = 0; i < 60; i += 1) late.run(sentCopy({ rfc_message_id: `<m${i}@x>` }), ctxIn('owner'));
    const hook = vi.fn();
    late.bind(hook);
    expect(hook).toHaveBeenCalledTimes(50);
    expect((hook.mock.calls[0]![0] as CanonicalMessage).rfc_message_id).toBe('<m10@x>');
  });
});
