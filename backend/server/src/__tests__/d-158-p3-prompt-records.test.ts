/** D-158 P3 — what a messenger channel sent outlives a restart.
 *
 *  Through the builder the server uses (`buildMessengerRemoteChannels`, its
 *  `messenger_prompt_records` table) and the real Telegram transport, against a stand-in for
 *  the Bot API. Before, the record of a sent prompt lived in the process: after a restart the
 *  boot sweep sent every open approval again, and an approval sent before it kept its buttons
 *  once it was answered or expired (found driving D-337 slice T, 2026-11-02). */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionAuth, ConnectionRow } from '@recued/contracts';
import type { AskOption, NotificationMessage } from '@recued/notification';

import { buildMessengerRemoteChannels } from '../composition/bin/messenger-transport-leaves.js';
import { createConnectionStore } from '../storage/connection-store.js';

const blob = (auth: ConnectionAuth) => Buffer.from(JSON.stringify(auth)).toString('base64');
const telegram: Omit<ConnectionRow, 'pk'> = {
  kind: 'notification', subtype: 'telegram', name: 'telegram', display_name: 'Telegram', enrolled_at: 1,
  updated_at: 1, config_json: JSON.stringify({ chat_id: 'owner-chat', principal_id: '1001' }),
  auth_ciphertext: blob({ type: 'bearer', token: 'token-telegram' }),
};
const approval: NotificationMessage = { title: 'Approve: Remove a calendar event', text: '"Dentist" is waiting for your approval.' };
const options: readonly AskOption[] = [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }];

/** The Bot API, numbering the messages it is sent as Telegram does: never twice in a chat. */
let nextMessageId = 100;
const botApi = () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ method: String(url).split('/').pop() ?? '', body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    nextMessageId += 1;
    return new Response(JSON.stringify({ ok: true, result: { message_id: nextMessageId } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
};

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const world = () => {
  const db = new Database(':memory:'); dbs.push(db);
  const store = createConnectionStore(db);
  store.upsert(telegram);
  return { db, store };
};

describe('D-158 P3 — an approval sent to Telegram, across a restart', () => {
  it('is not sent again by the boot sweep, and loses its buttons when it closes', async () => {
    const { db, store } = world();
    const first = botApi();
    const before = buildMessengerRemoteChannels({ connectionStore: store, transportOptions: { fetchImpl: first.fetchImpl }, db });
    await before.telegram!.deliverAsk('ask-1', approval, options);
    expect(first.calls.map((c) => c.method)).toEqual(['sendMessage']);
    const sent = nextMessageId;

    // The restart: the same database, new channels. The boot sweep delivers every open ask again.
    const second = botApi();
    const after = buildMessengerRemoteChannels({ connectionStore: store, transportOptions: { fetchImpl: second.fetchImpl }, db });
    await after.telegram!.deliverAsk('ask-1', approval, options);
    expect(second.calls).toEqual([]);

    // Answered, or expired: its buttons go, on the message the earlier process sent.
    await after.telegram!.closeAsk('ask-1');
    expect(second.calls.map((c) => c.method)).toEqual(['editMessageText']);
    expect(Number(second.calls[0]!.body.message_id)).toBe(sent);
    expect(second.calls[0]!.body).toMatchObject({ reply_markup: { inline_keyboard: [] } });
    expect(db.prepare('SELECT COUNT(*) AS n FROM messenger_prompt_records').get()).toEqual({ n: 0 });
  });

  it('⛔ CONTROL: with no database the channel keeps nothing, so a restart sends it again', async () => {
    const { store } = world();
    const first = botApi();
    await buildMessengerRemoteChannels({ connectionStore: store, transportOptions: { fetchImpl: first.fetchImpl } })
      .telegram!.deliverAsk('ask-1', approval, options);
    const second = botApi();
    const after = buildMessengerRemoteChannels({ connectionStore: store, transportOptions: { fetchImpl: second.fetchImpl } });
    await after.telegram!.deliverAsk('ask-1', approval, options);
    expect(second.calls.map((c) => c.method)).toEqual(['sendMessage']);
  });
});
