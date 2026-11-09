/** D-323 — an answer's install offers are kept with it and come back on every
 *  read, so a reload shows what the turn offered. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { deriveSubDEK } from '@recued/crypto';

import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

const OFFER = { kind: 'pack' as const, slug: 'rental-book', name: 'Rental Book', publisher: 'recued-core', recipes: ['Collect the rent'] };
const signature = { server_kind: 'recued' as const, version: '1', instance_id: 'install-offers' };

const fixture = () => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  const key = deriveSubDEK(Buffer.alloc(32, 3), 'chat');
  const store = createChatStore(db, () => key, () => undefined);
  store.createSession({ id: 's', title: 'A conversation' });
  const append = (id: string, extra: Record<string, unknown> = {}) => store.appendMessage({
    id, session_id: 's', role: 'assistant', content: 'Nothing installed does that.',
    target_server: 'self', picker_at_send: { display_name: 'Self', signature },
    model_used: { provider: 'fixture', model_id: 'fixture' }, ...extra,
  });
  return { db, store, append };
};

// D-346 follow-up (2026-11-08) — the fixes stamped on an answer are kept beside its offers.
describe('an answer’s fixes', () => {
  const FIX = { kind: 'switch' as const, entry_key: 'data.task', label: 'Your tasks' };
  it('are returned with the answer and read back with it; a malformed one is dropped', async () => {
    const f = fixture();
    const written = await f.append('f1', { fixes: [FIX, { kind: 'switch', entry_key: 'pub/cat.op', label: 'x' }] });
    expect(written.fixes).toEqual([FIX]);
    const page = await f.store.listMessagePage('s', 10);
    expect(page.messages.find((message) => message.id === 'f1')?.fixes).toEqual([FIX]);
    expect(await f.append('f2')).not.toHaveProperty('fixes');
  });
});

describe('an answer’s install offers', () => {
  it('are returned with the answer and read back with it', async () => {
    const f = fixture();
    const written = await f.append('a1', { install_offers: [OFFER] });
    expect(written.install_offers).toEqual([OFFER]);
    const page = await f.store.listMessagePage('s', 10);
    expect(page.messages.find((message) => message.id === 'a1')?.install_offers).toEqual([OFFER]);
  });

  it('an answer without offers carries no field', async () => {
    const f = fixture();
    expect(await f.append('a2')).not.toHaveProperty('install_offers');
    const page = await f.store.listMessagePage('s', 10);
    expect(page.messages[0]).not.toHaveProperty('install_offers');
  });

  it('⛔ a stored offer that is not one is dropped on the way out', async () => {
    const f = fixture();
    await f.append('a3', { install_offers: [OFFER] });
    f.db.prepare(`UPDATE chat_messages SET metadata_blob = ? WHERE message_id = 'a3'`)
      .run(JSON.stringify({ install_offers: [OFFER, { ...OFFER, slug: 'javascript:alert(1)' }] }));
    const page = await f.store.listMessagePage('s', 10);
    expect(page.messages[0]?.install_offers).toEqual([OFFER]);
  });
});
