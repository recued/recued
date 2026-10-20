/** `mail.search` tells the model which address each mailbox is.
 *
 *  ⛔ A mailbox's slug is whatever it was connected under, and the owner says
 *  "my Outlook" or an address. With slugs alone, Chat asked an owner who had
 *  written "from my Gmail" which mailbox was their Gmail (live, 2026-10-18).
 *  Every answer that names the mailboxes it covers also gives each one's
 *  address and provider, by the `collection_slug` its matches carry.
 *
 *  Through real mail collections over a real table, so the address is read from
 *  the collection the server registers, not from a double that holds one. */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createWarehouseEventBus } from '@recued/warehouse-events';

import { buildChatTier1Handlers } from '../chat-tool-handlers.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { createMailCollection } from '../collections/mail/mail-collection.js';
import type { MailProvider } from '../collections/mail/provider.js';
import { createBlobStore } from '../storage/blob-store.js';

const GMAIL = { collection_slug: 'recueddev', address: 'recued.dev@gmail.com', provider: 'Gmail' };
const OUTLOOK = { collection_slug: 'outlook', address: 'recued.dev@outlook.com', provider: 'Outlook' };

const cleanups: Array<() => void> = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const world = () => {
  const db = new Database(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'mailbox-addresses-'));
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const registry = createCollectionRegistry();
  const mailbox = (slug: string, kind: MailProvider['kind'], accountEmail: string) => {
    const mail = createMailCollection({
      db, blobs: createBlobStore(join(dir, slug)),
      gate: { addUsed: () => {}, getUsed: () => 0 } as never,
      bus: createWarehouseEventBus(), slug,
      provider: { kind, slug, accountEmail, sendCapable: true, mutationCapable: false } as never,
      config: () => ({ backfill_days: 3650, retention_days: 3650, quota_bytes: 1 << 26 }),
    });
    // The same record id in both mailboxes, and one of each mailbox's own.
    for (const [record_id, at] of [['mail:1', 1000], [`mail:${slug}`, 2000]] as const) {
      mail.upsert({
        record_id,
        hot_fields: { subject: 'Invoice', from: 'billing@vendor.test', to: [accountEmail], cc: [], thread_id: `T-${slug}` },
        received_at: at, modified_at: at,
        body_inline: 'Your invoice is attached.', size_bytes: 25, source_id: slug,
      } as never);
    }
    registry.register(mail as never);
  };
  mailbox('recueddev', 'gmail', 'recued.dev@gmail.com');
  mailbox('outlook', 'graph', 'recued.dev@outlook.com');
  const handlers = buildChatTier1Handlers({
    getContactStore: () => undefined,
    getCollectionRegistry: () => registry,
    getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined,
    getRecipeStore: () => ({
      ids: () => [], get: () => null, getStored: () => null, listStored: () => [],
    }) as never,
    getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
    getExecuteRecipe: () => undefined,
  } as never);
  const ctx = { channel: 'internal_function_call', session_id: 'S', turn_id: 'T' } as never;
  return async (args: Record<string, unknown>) => {
    const h = (handlers as Record<string, (a: unknown, c: unknown) => Promise<unknown>>)['mail.search'];
    const r = await h({ limit: 20, ...args }, ctx) as { ok: boolean; result: Record<string, unknown> };
    expect(r.ok).toBe(true);
    return r.result as {
      matches: Array<{ collection_slug: string }>;
      mailbox_addresses?: unknown;
      [k: string]: unknown;
    };
  };
};

describe('mail.search names each mailbox by its address', () => {
  it('a search across mailboxes: each one, and every match joins to one', async () => {
    const search = world();
    for (const args of [{ query: 'invoice' }, {}]) {
      const result = await search(args);
      expect(result.mailbox_addresses).toEqual([GMAIL, OUTLOOK]);
      expect(result.matches.length).toBeGreaterThan(0);
      for (const match of result.matches) {
        expect([GMAIL.collection_slug, OUTLOOK.collection_slug]).toContain(match.collection_slug);
      }
    }
  });

  it('one mailbox searched: that one', async () => {
    const result = await world()({ slug: 'outlook', query: 'invoice' });
    expect(result.mailbox_addresses).toEqual([OUTLOOK]);
    expect(result.matches.every((m) => m.collection_slug === 'outlook')).toBe(true);
  });

  it('a slug no mailbox has: every mailbox there is, so the model can pick by address', async () => {
    const result = await world()({ slug: 'gmail' });
    expect(result.mailbox_not_found).toBe('gmail');
    expect(result.mailbox_addresses).toEqual([GMAIL, OUTLOOK]);
  });

  it('stepping through a conversation, and each way that can fail', async () => {
    const search = world();
    const stepped = await search({ slug: 'recueddev', near_id: 'mail:1', next: 1 });
    expect(stepped.matches.map((m) => m.collection_slug)).toEqual(['recueddev']);
    expect(stepped.mailbox_addresses).toEqual([GMAIL]);

    const missing = await search({ near_id: 'mail:none', next: 1 });
    expect(missing.anchor_not_found).toBe('mail:none');
    expect(missing.mailbox_addresses).toEqual([GMAIL, OUTLOOK]);

    // The same record id in both: the model is told which mailbox is which.
    const ambiguous = await search({ near_id: 'mail:1', next: 1 });
    expect(ambiguous.anchor_ambiguous).toBe('mail:1');
    expect(ambiguous.mailboxes).toEqual(['recueddev', 'outlook']);
    expect(ambiguous.mailbox_addresses).toEqual([GMAIL, OUTLOOK]);
  });
});
