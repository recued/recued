/** D-239 — mail write-back.
 *
 *  The four properties worth testing here are the ones a plausible-looking
 *  implementation gets wrong while every other test stays green:
 *
 *   1. THE FLAG SURVIVES A SYNC. `mail-flag` writes `is_flagged`; if a
 *      provider's canonicalizer does not READ it, the write lands and the
 *      next sync silently reverts it. The round-trip is driven through each
 *      REAL canonicalizer, not through a fixture that already contains the
 *      field — a fixture would prove only that the type has a slot.
 *   2. AN AMBIGUOUS FAILURE LEAVES THE WAREHOUSE ALONE. `io_error` means the
 *      mutation may have landed; writing the row on it would make the mirror
 *      assert a state the provider never confirmed.
 *   3. A MOVE RE-KEYS, AND SOMETIMES CANNOT BE NAMED AT ALL. Both branches
 *      must leave the warehouse consistent — no row keyed to a dead id.
 *   4. A DELETE CASCADES. `bridgeEnrichmentCascade` filters `deleted` events
 *      away from mail, so a delete that only dropped the row would orphan
 *      every enrichment keyed to the message and nothing would report it.
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { MailAdapterError } from '@recued/contracts';

import { createBlobStore } from '../../../storage/blob-store.js';
import { createMailCollection } from '../mail-collection.js';
import { canonicalizeGmail } from '../gmail-provider.js';
import { canonicalizeGraph, GRAPH_MESSAGE_SELECT } from '../graph-provider.js';
import { canonicalizeImap } from '../imap-provider.js';
import {
  handleMailDelete,
  handleMailFlag,
  handleMailMark,
  handleMailMove,
} from '../mail-dispatcher.js';
import type { CanonicalMessage, MailProvider } from '../provider.js';
import type { CollectionRegistry } from '../../registry.js';

// ════════════════════════════════════════════════════════════════
// 1 — the flag survives a sync, per provider
// ════════════════════════════════════════════════════════════════

const RFC822 = [
  'From: alice@example.com',
  'To: bob@example.com',
  'Subject: Q3 review',
  'Message-ID: <m1@example.com>',
  'Date: Tue, 14 Nov 2023 22:13:20 +0000',
  '',
  'body text',
].join('\r\n');

describe('D-239 — is_flagged is read back by every provider canonicalizer', () => {
  // ⛔ THIS IS THE TEST THE WHOLE `is_flagged` READ-SIDE EXISTS FOR. Ship
  // `mail-flag` without it and the write is real, provider-side, and then
  // reverted by the mailbox's own next sync — a bug that reproduces only
  // after a poll interval and looks like "the flag didn't stick sometimes".

  it('imap reads \\Flagged from the FETCH flag set', async () => {
    const flagged = await canonicalizeImap(Buffer.from(RFC822), {
      uid: 7,
      folder: 'INBOX',
      flags: new Set(['\\Seen', '\\Flagged']),
      internalDate: new Date(1_700_000_000_000),
    });
    const plain = await canonicalizeImap(Buffer.from(RFC822), {
      uid: 8,
      folder: 'INBOX',
      flags: new Set(['\\Seen']),
      internalDate: new Date(1_700_000_000_000),
    });
    expect(flagged.is_flagged).toBe(true);
    expect(plain.is_flagged).toBe(false);
  });

  it('gmail reads the STARRED system label', async () => {
    const raw = Buffer.from(RFC822, 'utf8').toString('base64url');
    const flagged = await canonicalizeGmail({
      id: 'g1',
      threadId: 't1',
      labelIds: ['INBOX', 'STARRED'],
      raw,
      internalDate: '1700000000000',
    });
    const plain = await canonicalizeGmail({
      id: 'g2',
      threadId: 't1',
      labelIds: ['INBOX'],
      raw,
      internalDate: '1700000000000',
    });
    expect(flagged.is_flagged).toBe(true);
    expect(plain.is_flagged).toBe(false);
    // The two bits have OPPOSITE polarity on Gmail (UNREAD present ⇒ unread,
    // STARRED present ⇒ flagged) and swapping them is the easy mistake.
    expect(flagged.is_read).toBe(true);
  });

  it('graph reads flag.flagStatis === "flagged", and treats "complete" as not flagged', () => {
    const base = {
      id: 'x1',
      subject: 's',
      from: { emailAddress: { address: 'a@example.com' } },
      receivedDateTime: '2023-11-14T22:13:20Z',
      body: { contentType: 'text' as const, content: 'b' },
    };
    expect(canonicalizeGraph({ ...base, flag: { flagStatus: 'flagged' } }).is_flagged)
      .toBe(true);
    expect(canonicalizeGraph({ ...base, flag: { flagStatus: 'notFlagged' } }).is_flagged)
      .toBe(false);
    // A `complete` follow-up is finished, not pending — reporting it as
    // flagged would resurface mail the user already dealt with.
    expect(canonicalizeGraph({ ...base, flag: { flagStatus: 'complete' } }).is_flagged)
      .toBe(false);
    // Absent `flag` (a message that was never flagged) is not flagged.
    expect(canonicalizeGraph(base).is_flagged).toBe(false);
  });

  it('graph REQUESTS the flag field in its projection', () => {
    // ⛔ The canonicalizer above passes with `flag` missing from `$select`,
    // because a fixture supplies the field the wire never would. That is
    // exactly the shape of a green test over a broken feature: Graph returns
    // 200 with `flag` absent, every message reads unflagged, and nothing
    // anywhere reports an error. Pin the projection itself.
    expect(GRAPH_MESSAGE_SELECT.split(',')).toContain('flag');
  });
});

// ════════════════════════════════════════════════════════════════
// Harness — a real collection over a real table, a scripted provider
// ════════════════════════════════════════════════════════════════

const BIG_QUOTA = 100 * 1024 * 1024;

const mkMessage = (o: Partial<CanonicalMessage> = {}): CanonicalMessage => ({
  source_id: 'msg-1',
  from: 'alice@example.com',
  to: ['bob@example.com'],
  cc: [],
  subject: 'Q3 review',
  thread_id: 'T-1',
  folder_or_label: 'INBOX',
  direction: 'inbound',
  is_read: false,
  is_flagged: false,
  has_attachments: false,
  received_at: 1_700_000_000_000,
  body_text: 'body text contents',
  ...o,
});

interface Harness {
  collection: ReturnType<typeof createMailCollection>;
  registry: CollectionRegistry;
  deleted: Array<{ slug: string; record_id: string }>;
  deleteLocalRecord: (slug: string, record_id: string) => Promise<void>;
  cleanup: () => void;
}

const makeHarness = (
  providerOverrides: Partial<MailProvider> & { mutationCapable?: boolean } = {},
  message: CanonicalMessage = mkMessage(),
): Harness => {
  const dir = mkdtempSync(join(tmpdir(), 'd238-'));
  mkdirSync(join(dir, 'cas'), { recursive: true });
  const db = new Database(':memory:');
  const blobs = createBlobStore(join(dir, 'cas'));
  const gate = createStorageGate({
    quota: BIG_QUOTA,
    reservePct: 10,
    surface: 'collection:mail:inbox',
  });

  const provider: MailProvider = {
    kind: 'imap',
    slug: 'inbox',
    sendCapable: false,
    mutationCapable: true,
    accountEmail: 'owner@example.com',
    async connect() { /* no-op */ },
    async initialScan(opts) { await opts.onMessage(message); },
    async startSync() { return async () => {}; },
    async close() { /* no-op */ },
    health() {
      return { last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 };
    },
    ...providerOverrides,
  };

  const collection = createMailCollection({
    db,
    blobs,
    gate,
    bus: createWarehouseEventBus(),
    slug: 'inbox',
    provider,
    config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: BIG_QUOTA }),
  });

  const deleted: Array<{ slug: string; record_id: string }> = [];
  const registry = {
    get: (platform: string, slug: string) =>
      platform === 'mail' && slug === 'inbox' ? collection : undefined,
  } as unknown as CollectionRegistry;

  return {
    collection,
    registry,
    deleted,
    deleteLocalRecord: async (slug, record_id) => {
      deleted.push({ slug, record_id });
      // Mirrors what `handleCollectionDeleteRecord` does to the row, so the
      // assertions below see the same warehouse state production would.
      collection.delete(record_id);
    },
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

/** Ingest the scripted message and return its warehouse record. */
const seed = async (h: Harness) => {
  await h.collection.sync.start();
  const rows = h.collection.list({ platform: 'mail', slug: 'inbox' });
  expect(rows).toHaveLength(1);
  return rows[0]!;
};

// ════════════════════════════════════════════════════════════════
// 2 — verified-then-reflected
// ════════════════════════════════════════════════════════════════

describe('D-239 — the warehouse moves only on a verified provider answer', () => {
  it('reflects a confirmed mark into the row', async () => {
    const h = makeHarness({
      markMessage: async ({ source_id }) => ({
        source_id,
        is_read: true,
        is_flagged: false,
        folder_or_label: 'INBOX',
      }),
    });
    try {
      const row = await seed(h);
      expect(row.hot_fields.is_read).toBe(false);

      const out = await handleMailMark(
        { registry: h.registry, deleteLocalRecord: h.deleteLocalRecord },
        { slug: 'inbox', record_id: row.record_id, read: true },
      );

      expect(out.is_read).toBe(true);
      expect(h.collection.get(row.record_id)!.hot_fields.is_read).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('leaves the row UNTOUCHED when the outcome is unknown (io_error)', async () => {
    const h = makeHarness({
      markMessage: async () => {
        throw new MailAdapterError('io_error', 'connection reset mid-command');
      },
    });
    try {
      const row = await seed(h);
      const before = JSON.stringify(h.collection.get(row.record_id));

      await expect(
        handleMailMark(
          { registry: h.registry, deleteLocalRecord: h.deleteLocalRecord },
          { slug: 'inbox', record_id: row.record_id, read: true },
        ),
      ).rejects.toThrow(/MAIL_IO_ERROR/);

      // ⛔ Byte-identical, not merely "still unread". An `io_error` must not
      // move `modified_at` either — a mirror that stamps a fresh modified
      // time for a change it never confirmed makes the row look freshly
      // synced to everything downstream that reads that field.
      expect(JSON.stringify(h.collection.get(row.record_id))).toBe(before);
    } finally {
      h.cleanup();
    }
  });

  it('reflects a flag without rewriting the message body', async () => {
    // A 100 KB body spills to CAS. Marking it flagged must not re-write that
    // blob — the whole reason the mutation result is narrow rather than a
    // full CanonicalMessage.
    const big = 'x'.repeat(100 * 1024);
    const h = makeHarness(
      {
        flagMessage: async ({ source_id }) => ({
          source_id,
          is_read: false,
          is_flagged: true,
          folder_or_label: 'INBOX',
        }),
      },
      mkMessage({ body_text: big }),
    );
    try {
      const row = await seed(h);
      expect(row.blob_hash).toBeTruthy();
      expect(row.body_inline).toBeUndefined();

      await handleMailFlag(
        { registry: h.registry, deleteLocalRecord: h.deleteLocalRecord },
        { slug: 'inbox', record_id: row.record_id, flagged: true },
      );

      const after = h.collection.get(row.record_id)!;
      expect(after.hot_fields.is_flagged).toBe(true);
      expect(after.blob_hash).toBe(row.blob_hash);
      expect(after.size_bytes).toBe(row.size_bytes);
      expect(after.received_at).toBe(row.received_at);
    } finally {
      h.cleanup();
    }
  });

  it('refuses on a read-only enrollment instead of pretending to write', async () => {
    const mark = vi.fn();
    const h = makeHarness({ mutationCapable: false, markMessage: mark as never });
    try {
      const row = await seed(h);
      await expect(
        handleMailMark(
          { registry: h.registry, deleteLocalRecord: h.deleteLocalRecord },
          { slug: 'inbox', record_id: row.record_id, read: true },
        ),
      ).rejects.toThrow(/MAIL_MUTATION_UNSUPPORTED/);
      expect(mark).not.toHaveBeenCalled();
    } finally {
      h.cleanup();
    }
  });
});

// ════════════════════════════════════════════════════════════════
// 3 — move
// ════════════════════════════════════════════════════════════════

describe('D-239 — a move never leaves a row keyed to a dead id', () => {
  it('re-keys the row when the provider names the new identity', async () => {
    const h = makeHarness({
      moveMessage: async () => ({
        // IMAP re-keys: new UID, new folder.
        source_id: '99@INBOX/Archive',
        is_read: false,
        is_flagged: false,
        folder_or_label: 'INBOX/Archive',
      }),
    });
    try {
      const row = await seed(h);

      const out = await handleMailMove(
        { registry: h.registry, deleteLocalRecord: h.deleteLocalRecord },
        { slug: 'inbox', record_id: row.record_id, destination: { folder: 'INBOX/Archive' } },
      );

      expect(out.rekeyed).toBe(true);
      expect(out.record_id).not.toBe(row.record_id);
      // The OLD id must be gone — a row under a UID the provider no longer
      // has would 404 every later mutation on that message.
      expect(h.collection.get(row.record_id)).toBeNull();
      const moved = h.collection.get(out.record_id)!;
      expect(moved.hot_fields.folder).toBe('INBOX/Archive');
      expect(moved.source_id).toBe('99@INBOX/Archive');
      // Exactly one row survives — a re-key that forgot to drop the old row
      // would leave the message duplicated in every list query.
      expect(h.collection.list({ platform: 'mail', slug: 'inbox' })).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it('drops the row when the move is confirmed but unnameable (no UIDPLUS)', async () => {
    const h = makeHarness({ moveMessage: async () => null });
    try {
      const row = await seed(h);

      const out = await handleMailMove(
        { registry: h.registry, deleteLocalRecord: h.deleteLocalRecord },
        { slug: 'inbox', record_id: row.record_id, destination: { folder: 'INBOX/Archive' } },
      );

      // A success, not a failure: the move happened.
      expect(out.rekeyed).toBe(true);
      expect(out.record_id).toBe('');
      expect(out.folder).toBe('INBOX/Archive');
      // It goes through the SAME cascade-firing removal a delete uses,
      // because from this collection's view the record really is gone.
      expect(h.deleted).toEqual([{ slug: 'inbox', record_id: row.record_id }]);
      expect(h.collection.get(row.record_id)).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it('reports the PRE-move flags, read before the row was dropped', async () => {
    // Regression guard: reading them after `deleteLocalRecord` queries a row
    // this handler just deleted and yields `false` for everything — a lie
    // shaped exactly like a real reading.
    const h = makeHarness(
      { moveMessage: async () => null },
      mkMessage({ is_read: true, is_flagged: true }),
    );
    try {
      const row = await seed(h);
      const out = await handleMailMove(
        { registry: h.registry, deleteLocalRecord: h.deleteLocalRecord },
        { slug: 'inbox', record_id: row.record_id, destination: { folder: 'Archive' } },
      );
      expect(out.is_read).toBe(true);
      expect(out.is_flagged).toBe(true);
    } finally {
      h.cleanup();
    }
  });
});

// ════════════════════════════════════════════════════════════════
// 4 — delete
// ════════════════════════════════════════════════════════════════

describe('D-239 — delete goes to the provider first and cascades locally', () => {
  it('removes the row through the cascade-firing path', async () => {
    const h = makeHarness({ deleteMessage: async () => { /* confirmed */ } });
    try {
      const row = await seed(h);

      const out = await handleMailDelete(
        { registry: h.registry, deleteLocalRecord: h.deleteLocalRecord },
        { slug: 'inbox', record_id: row.record_id },
      );

      expect(out).toEqual({ deleted: true, record_id: row.record_id });
      // ⛔ NOT `collection.delete(...)` directly. `bridgeEnrichmentCascade`
      // filters `deleted` events away from mail, so the ONLY thing that runs
      // the annotation + enrichment cascades for a mail row is this path.
      // Asserting the row is gone would pass either way; asserting WHICH
      // path removed it is what pins the cascade.
      expect(h.deleted).toEqual([{ slug: 'inbox', record_id: row.record_id }]);
      expect(h.collection.get(row.record_id)).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it('keeps the row when the provider refuses', async () => {
    const h = makeHarness({
      deleteMessage: async () => {
        throw new MailAdapterError('permission_denied', 'mailbox is read-only');
      },
    });
    try {
      const row = await seed(h);

      await expect(
        handleMailDelete(
          { registry: h.registry, deleteLocalRecord: h.deleteLocalRecord },
          { slug: 'inbox', record_id: row.record_id },
        ),
      ).rejects.toThrow(/MAIL_PERMISSION_DENIED/);

      // A local row dropped ahead of a failed provider delete would make the
      // message invisible to every recipe AND re-ingest as new on the next
      // sync, re-firing any watcher on that folder.
      expect(h.deleted).toEqual([]);
      expect(h.collection.get(row.record_id)).not.toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it('surfaces a missing record without calling the provider', async () => {
    const remove = vi.fn();
    const h = makeHarness({ deleteMessage: remove as never });
    try {
      await seed(h);
      await expect(
        handleMailDelete(
          { registry: h.registry, deleteLocalRecord: h.deleteLocalRecord },
          { slug: 'inbox', record_id: 'mail:does-not-exist' },
        ),
      ).rejects.toThrow(/MAIL_RECORD_NOT_FOUND/);
      expect(remove).not.toHaveBeenCalled();
    } finally {
      h.cleanup();
    }
  });
});
