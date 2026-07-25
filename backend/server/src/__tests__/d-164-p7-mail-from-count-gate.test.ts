/** D-164 P7 — backend mail from-count lookup wiring.
 *
 *  Exercises `createPromptCacheGateDeps`' mail half end-to-end through the real
 *  public surface (contact lookup → family composer → probe → mail-count
 *  lookup), with a fake ContactStore + CollectionRegistry whose mail
 *  collections expose a stub `countFrom`. Pins the lookup's sum-across-
 *  collections, the lowercase-email normalization the count keys on, the
 *  non-mail-collection filter, the no-mailbox / unresolved-contact / zero-count
 *  pass-throughs, and the non-ASCII-address deferral a Codex review hardened
 *  (SQLite `LOWER` is ASCII-only, so a non-ASCII sender could undercount → the
 *  lookup defers it to the LLM). The exact `countByAddress` SQL precision is
 *  covered in `collection-table.test.ts`. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';

import { MAIL_FROM_COUNT_TEMPLATE } from '@recued/middleware-prompt-cache';

import { createPromptCacheGateDeps } from '../chat-prompt-cache-gate.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createMailCollection, type MailCollection } from '../collections/mail/mail-collection.js';
import type { MailProvider, ProviderHealth } from '../collections/mail/provider.js';
import type { Collection } from '../collections/types.js';
import type { CollectionRegistry } from '../collections/registry.js';
import type { ContactStore } from '../storage/contact-store.js';

const NAME_SLOT = {
  kind: 'entity.name',
  value: 'Pat Lee',
  raw: 'Pat Lee',
  position: 18,
} as const;

/** Fake store: `list` returns the rows; `addressSet` surfaces the contact's
 *  COMPLETE address set — the anchor plus its
 *  per-contact merged-away addresses (default none) — the lookup builds the
 *  complete linked address set (`emails`) from the two, so every row here
 *  carries `emails: [own]` unless `merged` adds more. */
const contactStore = (
  rows: ReadonlyArray<{ email: string; name?: string }>,
  merged: Readonly<Record<string, readonly string[]>> = {},
): ContactStore =>
  ({
    list: () => rows,
    // D-205 #3.5b — the COMPLETE set: anchor UNIONED with its merged-away addresses.
    addressSet: (email: string) => [...new Set([email, ...(merged[email] ?? [])])].sort(),
  }) as unknown as ContactStore;

/** Pat Lee resolves to pat@x.com — the address set the count keys on. */
const PAT_STORE = contactStore([{ email: 'pat@x.com', name: 'Pat Lee' }]);

/** A fake mail collection whose `countFrom(email)` returns a fixed count and
 *  records the email it was asked for (so the normalization is assertable). */
const fakeMail = (
  countFromImpl: (email: string) => number,
  slug = 'mail',
): Collection =>
  ({
    platform: 'mail',
    slug,
    countFrom: vi.fn(countFromImpl),
  }) as unknown as MailCollection as Collection;

/** A non-mail collection — must be ignored by the count lookup's filter. */
const fakeCalendar = (): Collection =>
  ({ platform: 'calendar', slug: 'cal' }) as unknown as Collection;

const registry = (...collections: Collection[]): CollectionRegistry =>
  ({ list: () => collections }) as unknown as CollectionRegistry;

const probeMail = async (
  getRegistry: () => CollectionRegistry | undefined,
  store: ContactStore | undefined = PAT_STORE,
) => {
  const deps = createPromptCacheGateDeps(() => store, getRegistry);
  return await deps.probeData({
    template: MAIL_FROM_COUNT_TEMPLATE,
    slots: [NAME_SLOT],
  });
};

describe('D-164 P7 backend mail from-count lookup', () => {
  it('counts the contact as sender and renders a person-scoped snapshot', async () => {
    const out = await probeMail(() => registry(fakeMail(() => 3)));
    expect(out?.data).toEqual({
      name: 'Pat Lee',
      count: '3',
      count_phrase: '3 emails',
    });
  });

  it('keys the count on the LOWER-CASED resolved contact email', async () => {
    const seen: string[] = [];
    const mail = fakeMail((email) => {
      seen.push(email);
      return 1;
    });
    await probeMail(
      () => registry(mail),
      contactStore([{ email: 'Pat@X.com', name: 'Pat Lee' }]),
    );
    expect(seen).toEqual(['pat@x.com']);
  });

  it('SUMS the count across every mail collection (multiple accounts)', async () => {
    const out = await probeMail(() =>
      registry(fakeMail(() => 2, 'work'), fakeMail(() => 5, 'personal')),
    );
    expect(out?.data.count_phrase).toBe('7 emails');
  });

  it('SUMS the count across every address linked to the contact (merged tombstones)', async () => {
    const seen: string[] = [];
    const mail = fakeMail((email) => {
      seen.push(email);
      return email === 'pat@old.com' ? 2 : 3;
    });
    const out = await probeMail(
      () => registry(mail),
      contactStore(
        [{ email: 'pat@x.com', name: 'Pat Lee' }],
        { 'pat@x.com': ['pat@old.com'] },
      ),
    );
    expect(seen.sort()).toEqual(['pat@old.com', 'pat@x.com']);
    expect(out?.data).toEqual({ name: 'Pat Lee', count: '5', count_phrase: '5 emails' });
  });

  it('defers (null) when ANY linked address is non-ASCII — a partial count would undercount the person total', async () => {
    const mail = fakeMail(() => 2);
    const out = await probeMail(
      () => registry(mail),
      contactStore(
        [{ email: 'pat@x.com', name: 'Pat Lee' }],
        { 'pat@x.com': ['jörg@example.com'] },
      ),
    );
    expect(out).toBeNull();
    expect((mail as unknown as MailCollection).countFrom).not.toHaveBeenCalled();
  });

  it('ignores non-mail collections (only mail is counted)', async () => {
    const out = await probeMail(() => registry(fakeCalendar(), fakeMail(() => 4)));
    expect(out?.data.count_phrase).toBe('4 emails');
  });

  it('defers (null) a ZERO total — no positive count to short-circuit on', async () => {
    expect(await probeMail(() => registry(fakeMail(() => 0)))).toBeNull();
  });

  it('defers (null) a non-ASCII resolved address WITHOUT counting (SQLite LOWER is ASCII-only)', async () => {
    const mail = fakeMail(() => 2);
    const out = await probeMail(
      () => registry(mail),
      contactStore([{ email: 'jörg@example.com', name: 'Pat Lee' }]),
    );
    expect(out).toBeNull();
    expect((mail as unknown as MailCollection).countFrom).not.toHaveBeenCalled();
  });

  it('passes through (null) when no mail collection is registered (nothing synced to count)', async () => {
    expect(await probeMail(() => registry(fakeCalendar()))).toBeNull();
    expect(await probeMail(() => registry())).toBeNull();
  });

  it('passes through (null) when the registry is unavailable', async () => {
    expect(await probeMail(() => undefined)).toBeNull();
  });

  it('passes through (null) when the contact cannot be resolved', async () => {
    const out = await probeMail(() => registry(fakeMail(() => 9)), contactStore([]));
    expect(out).toBeNull();
  });

  it('passes through (null) when a mail collection throws during the count', async () => {
    const out = await probeMail(() =>
      registry(
        fakeMail(() => {
          throw new Error('warehouse read failed');
        }),
      ),
    );
    expect(out).toBeNull();
  });
});

// ── End-to-end over a REAL MailCollection (sender-only guarantee) ─────
// The stub tests above prove the lookup wiring; these prove the GLUE —
// `MailCollection.countFrom` → `countByAddress('from', …)` over a real SQLite
// table — counts the SENDER, not the recipient. A regression to counting `to`
// (or any other field) would answer "how many emails from Pat" with Pat's
// RECEIVED mail; these would fail. Runs through the same
// `createPromptCacheGateDeps` probe, so the whole chain is exercised.

describe('D-164 P7 backend mail from-count — sender-only over a real MailCollection', () => {
  const tmpDirs: string[] = [];
  const dbs: Database.Database[] = [];
  afterEach(() => {
    for (const db of dbs) {
      try { db.close(); } catch { /* swallow */ }
    }
    dbs.length = 0;
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  const stubProvider: MailProvider = {
    kind: 'imap',
    slug: 'work',
    sendCapable: false,
    accountEmail: '',
    async connect() { /* no-op */ },
    async initialScan() { /* no-op */ },
    async startSync() { return async () => {}; },
    async close() { /* no-op */ },
    health(): ProviderHealth {
      return { last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 };
    },
  };

  /** Build a real MailCollection over an in-memory DB and upsert the given
   *  sender/recipient rows (the canonical mail hot-field shape: `from` scalar,
   *  `to` array). Returns the live collection so a registry can fan into it. */
  const realMailCollection = (rows: ReadonlyArray<{ from: string; to: string[] }>): MailCollection => {
    const dir = mkdtempSync(join(tmpdir(), 'p7-mail-count-'));
    tmpDirs.push(dir);
    const db = new Database(':memory:');
    dbs.push(db);
    const quota = 100 * 1024 * 1024;
    const collection = createMailCollection({
      db,
      blobs: createBlobStore(join(dir, 'blobs')),
      gate: createStorageGate({ quota, reservePct: 10, surface: 'collection:mail:work' }),
      bus: createWarehouseEventBus(),
      slug: 'work',
      provider: stubProvider,
      config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: quota }),
    });
    rows.forEach((r, i) => collection.upsert({
      record_id: `m${i}`,
      received_at: 1,
      modified_at: 1,
      hot_fields: { from: r.from, to: r.to, subject: 's' },
      size_bytes: 1,
      source_id: `s${i}`,
      body_inline: 'body',
    }));
    return collection;
  };

  it('counts only mail where the contact is the SENDER, never the recipient', async () => {
    const collection = realMailCollection([
      { from: 'someone@x.com', to: ['pat@x.com'] }, // Pat is the recipient — must NOT count
      { from: 'pat@x.com', to: ['someone@x.com'] }, // Pat is the sender — counts
      { from: 'PAT@X.COM', to: ['other@x.com'] }, // Pat (caps) as sender — counts (ASCII-folded)
    ]);
    const out = await probeMail(() => registry(collection));
    expect(out?.data).toEqual({ name: 'Pat Lee', count: '2', count_phrase: '2 emails' });
  });

  it('sums sender mail across a MERGED-AWAY address over the real table (person-scoped total)', async () => {
    const collection = realMailCollection([
      { from: 'pat@x.com', to: ['someone@x.com'] }, // canonical address — counts
      { from: 'pat@old.com', to: ['someone@x.com'] }, // merged-away address — counts
      { from: 'someone@x.com', to: ['pat@old.com'] }, // recipient only — must NOT count
    ]);
    const out = await probeMail(
      () => registry(collection),
      contactStore(
        [{ email: 'pat@x.com', name: 'Pat Lee' }],
        { 'pat@x.com': ['pat@old.com'] },
      ),
    );
    expect(out?.data).toEqual({ name: 'Pat Lee', count: '2', count_phrase: '2 emails' });
  });

  it('defers (null) when the contact appears ONLY as a recipient (zero sender count)', async () => {
    const collection = realMailCollection([
      { from: 'someone@x.com', to: ['pat@x.com'] },
      { from: 'another@x.com', to: ['pat@x.com', 'cc@x.com'] },
    ]);
    expect(await probeMail(() => registry(collection))).toBeNull();
  });
});
