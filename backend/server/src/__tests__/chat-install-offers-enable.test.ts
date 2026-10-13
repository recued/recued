/** D-323 — the owner's switch for chat's install offers (ruling P7): on unless
 *  turned off, server-scoped in `chat_config`, with the rolling brief's opt-out
 *  shape. Unlike the brief, an unreadable value reads ON: offers carry nothing
 *  of the owner's anywhere, and the ruling is "on by default". */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { deriveSubDEK } from '@recued/crypto';

import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

const store = () => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  const key = deriveSubDEK(Buffer.alloc(32, 1), 'chat');
  return { db, store: createChatStore(db, () => key, () => undefined) };
};

describe('install offers — server-scoped chat_config', () => {
  it('is on until the owner turns it off, and back on again', () => {
    const { store: chat } = store();
    expect(chat.getInstallOffersEnabled?.()).toBe(true);
    expect(chat.setInstallOffersEnabled?.(false)).toBe(false);
    expect(chat.getInstallOffersEnabled?.()).toBe(false);
    chat.setInstallOffersEnabled?.(true);
    expect(chat.getInstallOffersEnabled?.()).toBe(true);
  });

  it('only a stored "0" turns it off', () => {
    const { db, store: chat } = store();
    for (const [value, enabled] of [['0', false], ['1', true], ['', true], ['no', true]] as const) {
      db.prepare(`INSERT OR REPLACE INTO chat_config (key, value) VALUES ('install_offers_enabled', ?)`).run(value);
      expect(chat.getInstallOffersEnabled?.(), value).toBe(enabled);
    }
  });

  it('is its own switch: turning offers off leaves the rolling brief alone', () => {
    const { store: chat } = store();
    chat.setInstallOffersEnabled?.(false);
    expect(chat.getRollingBriefEnabled()).toBe(true);
  });
});

describe('chat.install_offers.get / set', () => {
  it('read and write the switch, and refuse anything but a boolean', async () => {
    const { handleGetInstallOffers, handleSetInstallOffers } = await import('../chat-handler.js');
    const { store: chat } = store();
    const deps = { store: chat } as never;
    expect(handleGetInstallOffers(deps)).toEqual({ enabled: true });
    expect(handleSetInstallOffers(deps, { enabled: false })).toEqual({ enabled: false });
    expect(handleGetInstallOffers(deps)).toEqual({ enabled: false });
    expect(() => handleSetInstallOffers(deps, { enabled: 'no' })).toThrow('enabled must be a boolean');
  });

  it('are served by the chat handlers, and listed with the chat methods', async () => {
    const { makeChatHandlers } = await import('../chat-handler.js');
    const { CHAT_RPC_METHODS } = await import('@recued/contracts');
    const { store: chat } = store();
    const slice = makeChatHandlers({ store: chat } as never)!;
    expect(slice.methods).toEqual(expect.arrayContaining(['chat.install_offers.get', 'chat.install_offers.set']));
    const handlers = slice.handlers as unknown as Record<string, (args: unknown) => Promise<unknown>>;
    await expect(handlers['chat.install_offers.set']!({ enabled: false })).resolves.toEqual({ enabled: false });
    await expect(handlers['chat.install_offers.get']!(undefined)).resolves.toEqual({ enabled: false });
    expect(CHAT_RPC_METHODS).toEqual(expect.arrayContaining(['chat.install_offers.get', 'chat.install_offers.set']));
  });
});
