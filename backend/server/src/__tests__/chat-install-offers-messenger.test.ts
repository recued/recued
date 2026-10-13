/** D-323 — a Slack or Telegram answer ends with its install offers as plain
 *  lines (ruling P5): a link to the server's own web app when it has a public
 *  address, the names and where to look when it has none. Through the real
 *  messenger bridge, with a scripted vendor. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveSubDEK } from '@recued/crypto';
import type { OutboundMessage } from '@recued/transport';

import { createChatMessengerBridge } from '../chat-messenger-bridge.js';
import { messengerInstallOfferLines } from '../install-offers/messenger-lines.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

const PACK = { kind: 'pack', slug: 'rental-book', name: 'Rental Book', publisher: 'recued-core', recipes: ['Collect the rent'] };
const RECIPE = { kind: 'recipe', slug: 'summarize-pdf', name: 'Summarize a PDF', publisher: 'recued-core', recipes: ['Summarize a PDF'] };
const signature = { server_kind: 'recued' as const, version: '1', instance_id: 'install-offers-messenger' };

describe('the lines', () => {
  it('link each offer to the server’s web app: a pack to its page, a recipe to its install dialog', () => {
    expect(messengerInstallOfferLines([PACK, RECIPE], 'https://home.example')).toBe(
      '\n\nFrom the marketplace, not installed yet:\n'
      + '- Rental Book: https://home.example/#packs/rental-book\n'
      + '- Summarize a PDF: https://home.example/#recipes/install/summarize-pdf',
    );
  });

  it('name them and say where to look, without a public address', () => {
    expect(messengerInstallOfferLines([PACK], null))
      .toBe('\n\nFrom the marketplace, not installed yet. Open Recued to install:\n- Rental Book');
  });

  it('are nothing without offers, or for offers that are not offers', () => {
    expect(messengerInstallOfferLines(undefined, 'https://home.example')).toBe('');
    expect(messengerInstallOfferLines([{ ...PACK, slug: '../x' }], 'https://home.example')).toBe('');
  });
});

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const deliver = async (publicBaseUrl: string | null) => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  const key = deriveSubDEK(Buffer.alloc(32, 5), 'chat');
  const getKey = () => key;
  const store = createChatStore(db, getKey);
  store.createSession({ id: 's' });
  const bridge = createChatMessengerBridge({ db, store, getKey, pollMs: 5, minSendIntervalMs: 0, publicBaseUrl: () => publicBaseUrl });
  cleanups.push(() => bridge.close());
  bridge.bind('slack', 'C123', 'slack:T:B', 's');
  const sends: OutboundMessage[] = [];
  bridge.register('slack', {
    resolve: async () => ({ token: 'fixture', recipient: 'C123', account: 'slack:T:B' }),
    send: async (message) => { sends.push(message); return { ok: true, vendor_message_id: `posted-${String(sends.length)}` }; },
  });
  await store.appendMessage({
    id: 'answer', session_id: 's', role: 'assistant', content: 'Nothing installed collects rent.',
    target_server: 'self', picker_at_send: { display_name: 'Self', signature },
    model_used: { provider: 'fixture', model_id: 'fixture' }, install_offers: [PACK as never],
  });
  await vi.waitFor(() => expect(sends).toHaveLength(1));
  return sends[0]!.text;
};

describe('a Slack answer with offers', () => {
  it('ends with the links, through the real bridge', async () => {
    expect(await deliver('https://home.example')).toBe(
      'Nothing installed collects rent.\n\nFrom the marketplace, not installed yet:\n- Rental Book: https://home.example/#packs/rental-book',
    );
  });

  it('ends with the names when the server has no public address', async () => {
    expect(await deliver(null)).toBe(
      'Nothing installed collects rent.\n\nFrom the marketplace, not installed yet. Open Recued to install:\n- Rental Book',
    );
  });
});
