/** D-343 — closing the day by replying to its email (owner, 2026-11-14: "do the email reply close the
 *  day"). A proven reply to an Agenda, evening notice or stream email that is no option's answer
 *  opens a conversation holding that notice and runs the owner's lines as a reply to it, once per
 *  email. Driven at the mail upsert hook with real headers; the close is the real module over a real
 *  database and Chat queue. Stream routing also uses the real reminder store and parser. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAskDeliveryStore, createAskStore, createEmailChannel, createNotificationBlock, createNotificationSettingsStore, createUiChannel,
  type AskDeliveryRecord, type NotificationBlock, type NotificationSettings, type PendingAsk } from '@recued/notification';

import type { MailUpsertContext } from '../collections/mail/mail-collection.js';
import { mailHeaderMap, type CanonicalMessage } from '../collections/mail/provider.js';
import { composeInboundEmailAnswer, type EmailAnswerAccounts } from '../composition/bin/wire-inbound-email-answer.js';
import { quotedClosingDay, repliedClosingTitle } from '../chat-closing-day.js';
import { createEmailCloseDay, emailQuotedLines } from '../email-close-day.js';
import { APP_DAY_SESSION_ID, createNoticeConversationOpener } from '../chat-notices.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createChatTurnQueueStore } from '../storage/chat-turn-queue-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';

const NOW = 1_800_000_000_000;
const ACCOUNTS: EmailAnswerAccounts = { sender_slug: 'alerts', sender_address: 'alerts@recued-owner.example', recipient_address: 'owner@example.com' };
const DMARC_PASS = 'mx.google.com; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=owner@example.com; '
  + 'dmarc=pass (p=NONE) header.from=example.com';
const STREAM_BODY = 'Did the call with Ana, skipped Spanish.\n\nOn Fri, Recued wrote:\n> Your day · Fri 13 Nov\n>\n> 10:00 Call with Ana\n> 18:00 Spanish, unit 5\n';

const reply = (over: Partial<CanonicalMessage> = {}): CanonicalMessage => ({
  source_id: 'reply-1', rfc_message_id: '<reply-1@example.com>', from: 'Owner <owner@example.com>',
  to: ['Recued alerts <alerts@recued-owner.example>'], cc: [], subject: 'Re: Your day · Fri 13 Nov', thread_id: 't1',
  folder_or_label: 'INBOX', direction: 'inbound', is_read: false, is_flagged: false, has_attachments: false,
  received_at: NOW - 60_000, body_text: STREAM_BODY,
  headers: mailHeaderMap([['Authentication-Results', DMARC_PASS]]), ...over,
});
const ctx = (over: Partial<MailUpsertContext> = {}): MailUpsertContext => ({
  slug: 'alerts', record_id: 'alerts:1', account_email: ACCOUNTS.sender_address, first_seen: true,
  backfill_complete: true, backfill_days: 30, attachments: [], ...over,
});

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

const harness = (opts: { ask?: PendingAsk; bundleReply?: unknown } = {}) => {
  const db = new Database(':memory:'); dbs.push(db); ensureChatSchema(db);
  const journal = createChatTurnQueueStore(db);
  const opener = createNoticeConversationOpener({ chatStore: createChatStore(db),
    signature: { server_kind: 'recued', version: '1', instance_id: 'd343' } });
  const opened: Array<{ title: string; text: string }> = [];
  const turns: Array<Record<string, unknown>> = [];
  const closeDay = createEmailCloseDay({
    db, now: () => NOW,
    openNoticeConversation: () => async (notice, identity) => { opened.push(notice); return opener(notice, identity); },
    queue: () => ({ routing: () => undefined, submit: async (command, id, repeat, beforeInsert) => {
      const ack = await journal.admit(command, id, repeat, beforeInsert); turns.push(command.input); return ack;
    } }),
    readReply: async () => null,
  });
  const submitAnswer = vi.fn(async () => 'accepted');
  const block = {
    getAsk: async () => opts.ask ?? null, submitAnswer, restoreAskDeliveries: async () => {},
    getAskDeliveryDestinations: async () => [],
    parseAskBundleReply: async () => opts.bundleReply ?? null,
  } as unknown as NotificationBlock;
  const funnel = composeInboundEmailAnswer({ block, resolveAccounts: () => ACCOUNTS, now: () => NOW, closeDay });
  const deliver = async (msg: CanonicalMessage, c: MailUpsertContext = ctx()) => { funnel.onMessageUpserted(msg, c); await funnel.dispose(); };
  return { opened, turns, submitAnswer, deliver, closeDay };
};

/** The real reminder parser, delivery retention and closing handoff; email I/O is local. */
const streamHarness = async (count = 2) => {
  const db = new Database(':memory:'); dbs.push(db); ensureChatSchema(db);
  const journal = createChatTurnQueueStore(db);
  let clock = NOW;
  let sequence = 0;
  let accounts = { ...ACCOUNTS, connection_name: 'personal-email', connection_enrolled_at: 200 };
  const asks = createAskStore(createSQLiteCollection<PendingAsk>(db, 'routing_asks'));
  const deliveryStore = createAskDeliveryStore(createSQLiteCollection<AskDeliveryRecord>(db, 'routing_deliveries'));
  const handled = vi.fn(async () => {});
  const block = createNotificationBlock({ askStore: asks, deliveryStore,
    settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'routing_settings')),
    channels: [createUiChannel({ busSink: () => {} }), createEmailChannel({ sendEmail: async () => {},
      sendEmailDelivery: async () => ({ outcome: 'delivered', provider_message_id: 'stream-email' }) })],
    now: () => clock, mintAskId: () => `ask-routing-${++sequence}`, isVaultUnlocked: () => true });
  block.registerAskHandler('routing-test', handled);
  const plan = { group_id: 'stream', destinations: [{ id: 'owner-email', channel: 'email' as const,
    connection_name: accounts.connection_name, connection_enrolled_at: accounts.connection_enrolled_at,
    recipient: ACCOUNTS.recipient_address, expected_sender: ACCOUNTS.recipient_address, sender_source: ACCOUNTS.sender_slug }],
    asks: Array.from({ length: count }, (_, index) => ({ ask_id: `ask-stream-${index + 1}`,
      message: { title: `Reminder ${index + 1}`, text: 'Due soon.' }, options: [{ id: 'done', label: 'Done' }],
      handler: { kind: 'routing-test', payload: {} } })) };
  await block.askBundle(plan);
  const opener = createNoticeConversationOpener({ chatStore: createChatStore(db),
    signature: { server_kind: 'recued', version: '1', instance_id: 'email-routing' } });
  const closeDay = createEmailCloseDay({ db, now: () => clock, openNoticeConversation: () => opener,
    queue: () => ({ routing: () => undefined, submit: journal.admit }), readReply: async () => null });
  const deliver = async (body = STREAM_BODY, over: Partial<CanonicalMessage> = {}) => {
    const funnel = composeInboundEmailAnswer({ block, resolveAccounts: () => accounts, now: () => clock, closeDay });
    funnel.onMessageUpserted(reply({ subject: 'Re: Your day · Fri 13 Nov [#ask-stream-1]',
      received_at: clock - 60_000, body_text: body, ...over }), ctx());
    await funnel.dispose();
  };
  const closeReminders = async () => {
    for (const ask of plan.asks) await block.submitAnswer({ ask_id: ask.ask_id, option: 'done', via: 'ui' });
  };
  const pruneReminders = async () => {
    await closeReminders(); clock += 8 * 86_400_000;
    expect(await block.pruneHandledAsks(clock - 7 * 86_400_000)).toBe(count);
    expect(await block.getAsk(plan.asks[0]!.ask_id)).toBeNull();
  };
  return { db, block, handled, deliver, closeReminders, pruneReminders,
    unmatched: () => block.listUnmatchedAskReplies(),
    queued: () => (db.prepare('SELECT count(*) AS n FROM chat_turn_queue').get() as { n: number }).n,
    changeAccounts: (patch: Partial<typeof accounts>) => { accounts = { ...accounts, ...patch }; } };
};

describe('which subject replies to a closing notice', () => {
  it('reads an Agenda, evening notice or stream title off a reply, its tag and "Repeat:" dropped', () => {
    expect(repliedClosingTitle('Re: Your day · Fri 13 Nov')).toBe('Your day · Fri 13 Nov');
    expect(repliedClosingTitle('RE: Re: Close the day · Thu 12 Nov')).toBe('Close the day · Thu 12 Nov');
    expect(repliedClosingTitle('AW: Your day · Fri 13 Nov [#ask-abc123]')).toBe('Your day · Fri 13 Nov');
    expect(repliedClosingTitle('Re: Repeat: Agenda · Mon 9 Nov')).toBe('Agenda · Mon 9 Nov');
    expect(repliedClosingTitle('Re: Your week · Mon 9 Nov to Sun 15 Nov')).toBe('Your week · Mon 9 Nov to Sun 15 Nov');
  });
  it('is nothing for a subject that is not a reply, or names another notice', () => {
    expect(repliedClosingTitle('Your day · Fri 13 Nov')).toBeUndefined();
    expect(repliedClosingTitle('Fwd: Your day · Fri 13 Nov')).toBeUndefined();
    expect(repliedClosingTitle('Re: Recued — your input is needed [#ask-1]')).toBeUndefined();
  });
  it('keeps what the reply quotes of the notice, which then reads as a closing quote', () => {
    const quoted = emailQuotedLines(STREAM_BODY);
    expect(quoted).toBe('Your day · Fri 13 Nov\n\n10:00 Call with Ana\n18:00 Spanish, unit 5');
    expect(quotedClosingDay(JSON.stringify({ reply_to: { role: 'notice', text: quoted }, message: 'x' }), '2026-11-13'))
      .toMatchObject({ from: '2026-11-13', to: '2026-11-13' });
  });
});

describe('a reply to the day\'s email closes it', () => {
  it('adds the notice to the app\'s "Your day" conversation and runs the owner\'s lines as a reply to it', async () => {
    const h = harness();
    await h.deliver(reply());
    expect(h.opened).toEqual([{ title: 'Your day · Fri 13 Nov', text: 'Your day · Fri 13 Nov\n\n10:00 Call with Ana\n18:00 Spanish, unit 5' }]);
    expect(h.turns).toEqual([expect.objectContaining({ session_id: APP_DAY_SESSION_ID, message: 'Did the call with Ana, skipped Spanish.',
      reply_to_message_id: expect.stringMatching(/^notice:/u), picker_state: { current: 'self' } })]);
  });

  it('opens each email once, however often it is seen', async () => {
    const h = harness();
    await h.deliver(reply());
    await h.deliver(reply());
    expect(await h.closeDay({ title: 'Your day · Fri 13 Nov', text: 'again', quoted: '', rfc_message_id: '<reply-1@example.com>',
      source: { slug: 'alerts', record_id: 'alerts:1' } })).toBe('seen');
    expect(h.opened).toHaveLength(1);
    expect(h.turns).toHaveLength(1);
  });

  it('does nothing for a reply not proven the owner\'s, one that is not news, or one with nothing of its own', async () => {
    const h = harness();
    await h.deliver(reply({ headers: {} }));
    await h.deliver(reply({ from: 'someone@else.example', rfc_message_id: '<x@else>' }));
    await h.deliver(reply({ rfc_message_id: '<old@example.com>' }), ctx({ first_seen: false }));
    await h.deliver(reply({ rfc_message_id: '<empty@example.com>', body_text: '\n> Your day · Fri 13 Nov\n' }));
    expect(h.opened).toEqual([]);
  });

  it('a stream reply that answers a reminder answers it; one that answers none closes the day', async () => {
    const ask: PendingAsk = { ask_id: 'ask-7', message: { text: 'Your day' }, options: [{ id: 'done', label: 'Done' }],
      handler_kind: 'test', handler_payload: {}, fanout_channels: ['email'], status: 'open', created_at: 0 };
    const answered = harness({ ask });
    await answered.deliver(reply({ subject: 'Re: Your day · Fri 13 Nov [#ask-7]', body_text: 'Done\n\n> Your day · Fri 13 Nov' }));
    expect(answered.submitAnswer).toHaveBeenCalledTimes(1);
    expect(answered.opened).toEqual([]);
    const closed = harness({ ask });
    await closed.deliver(reply({ subject: 'Re: Your day · Fri 13 Nov [#ask-7]' }));
    expect(closed.submitAnswer).not.toHaveBeenCalled();
    expect(closed.opened).toHaveLength(1);
  });

  it('a legacy closed ask does not swallow a day report or repeat its already-answered option', async () => {
    const ask: PendingAsk = { ask_id: 'ask-7', message: { text: 'Your day' }, options: [{ id: 'done', label: 'Done' }],
      handler_kind: 'test', handler_payload: {}, fanout_channels: ['email'], status: 'handled', created_at: 0 };
    const reported = harness({ ask });
    await reported.deliver(reply({ subject: 'Re: Your day · Fri 13 Nov [#ask-7]' }));
    expect(reported.turns).toHaveLength(1); expect(reported.submitAnswer).not.toHaveBeenCalled();
    const answered = harness({ ask });
    await answered.deliver(reply({ subject: 'Re: Your day · Fri 13 Nov [#ask-7]', body_text: 'Done' }));
    expect(answered.turns).toHaveLength(0); expect(answered.submitAnswer).not.toHaveBeenCalled();
  });
});

describe('a daily stream reply chooses one route', () => {
  it.each([1, 2])('a day report with %i reminder(s) closes the day without an unmatched-reply warning', async count => {
    const h = await streamHarness(count);
    await h.deliver();
    expect(h.queued()).toBe(1);
    expect(await h.unmatched()).toEqual([]);
    expect(h.handled).not.toHaveBeenCalled();
  });

  it('keeps a day report free of reminder warnings after its reminders are answered', async () => {
    const h = await streamHarness();
    await h.closeReminders();
    await h.deliver();
    expect(h.queued()).toBe(1); expect(await h.unmatched()).toEqual([]);
    expect(h.handled).toHaveBeenCalledTimes(2);
  });

  it('keeps closing available after reminder retention removes the old tag, once per email', async () => {
    const h = await streamHarness();
    // The same email still names the old ask after normal seven-day retention removes it.
    await h.pruneReminders();
    await h.deliver(STREAM_BODY, { rfc_message_id: '<later-reply@example.com>' });
    await h.deliver(STREAM_BODY, { rfc_message_id: '<later-reply@example.com>' });
    expect(h.queued()).toBe(1); expect(await h.unmatched()).toEqual([]);
    expect(h.handled).toHaveBeenCalledTimes(2);
  });

  it('answers a numbered reminder without opening Chat, and retains a genuinely late reminder answer', async () => {
    const h = await streamHarness();
    await h.deliver('2 Done\n\n> Your day · Fri 13 Nov');
    expect(h.queued()).toBe(0); expect(h.handled).toHaveBeenCalledOnce();
    expect((await h.block.getAsk('ask-stream-1'))?.status).toBe('open');
    expect((await h.block.getAsk('ask-stream-2'))?.status).toBe('handled');
    expect(await h.unmatched()).toEqual([]);
    await h.deliver('2 Done\n\n> Your day · Fri 13 Nov', { rfc_message_id: '<late-reminder@example.com>' });
    expect(h.queued()).toBe(0); expect(h.handled).toHaveBeenCalledOnce();
    expect((await h.unmatched()).map(row => row.reason)).toEqual(['already_closed']);
  });

  it('still records an invalid reminder reply to an email that has no day-closing route', async () => {
    const h = await streamHarness();
    await h.deliver('3 Done', { subject: 'Re: Recued reminder [#ask-stream-1]' });
    expect(h.queued()).toBe(0); expect(h.handled).not.toHaveBeenCalled();
    expect((await h.unmatched()).map(row => row.reason)).toEqual(['unknown_item']);
  });

  it('checks a day report against the current owner while a reminder answer remains bound to its original delivery', async () => {
    const h = await streamHarness(); h.changeAccounts({ connection_enrolled_at: 201 });
    await h.deliver();
    expect(h.queued()).toBe(1); expect(await h.unmatched()).toEqual([]);
    await h.deliver('2 Done', { rfc_message_id: '<stale-reminder@example.com>' });
    expect(h.queued()).toBe(1); expect(h.handled).not.toHaveBeenCalled();
    expect(await h.unmatched()).toEqual([]);
  });

  it('does not open a pruned stream reply if the owner changes while the original reminder is being looked up', async () => {
    const h = await streamHarness(); await h.pruneReminders();
    const restore = h.block.restoreAskDeliveries.bind(h.block);
    vi.spyOn(h.block, 'restoreAskDeliveries').mockImplementation(async () => {
      await restore(); h.changeAccounts({ recipient_address: 'someone-else@example.com' });
    });
    await h.deliver();
    expect(h.queued()).toBe(0); expect(await h.unmatched()).toEqual([]);
  });

});
