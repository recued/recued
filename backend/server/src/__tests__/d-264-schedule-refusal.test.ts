/** D-264 slice 5 — scheduling a send from a mailbox that cannot send.
 *
 *  Reachable only since D-264: compose now opens for a draft-only mailbox, so a
 *  draft can exist against an instance with no outbound path. The dialog
 *  disables Schedule for that sender — but the dialog is DISPLAY. A caller
 *  reaching `preapproval.prepare` directly would otherwise walk away with a
 *  reviewed execution that cannot run, and find out at `run_at`.
 *
 *  ⚠ Prepare-time only. The dispatch-time gate in `MailCollection.send` stays
 *  load-bearing and is NOT duplicated here: a grant can be revoked between
 *  approval and `run_at`, and two capability predicates over one fact is how a
 *  bind-time refusal and a runtime gate come to disagree. Both ends read
 *  `sendCapable`; only one of them is new.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { RpcError } from '@recued/contracts';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createPreapprovalMail } from '../preapproval-mail.js';
import { createMailCollection } from '../collections/mail/mail-collection.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { createBlobStore } from '../storage/blob-store.js';
import type { MailProvider } from '../collections/mail/provider.js';

const mailWith = (sendCapable: boolean, slug = 'work') => {
  const db = new Database(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'd264-sched-'));
  const blobs = createBlobStore(join(dir, 'blobs'));
  const registry = createCollectionRegistry();
  const provider: MailProvider = {
    kind: 'imap', slug, sendCapable, mutationCapable: false, draftCapable: true,
    accountEmail: 'owner@example.test',
    async connect() {}, async initialScan() {}, async startSync() { return async () => {}; },
    async close() {},
    health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 }),
    ...(sendCapable
      ? { async send() { return { source_id: 's', message_id: '<s@x>', sent_at: 1 }; } }
      : {}),
  };
  registry.register(createMailCollection({
    db, blobs, bus: createWarehouseEventBus(), slug, provider,
    gate: createStorageGate({ quota: 20_000_000, reservePct: 10, surface: `collection:mail:${slug}` }),
    config: () => ({ quota_bytes: 20_000_000, backfill_days: 1, retention_days: 30 }),
  }));
  const mail = createPreapprovalMail({
    db, registry, instances: createInstanceStore({ db }), blobs, manifest: () => null,
  });
  return { db, mail };
};

describe('D-264 — a draft-only mailbox cannot be scheduled', () => {
  it('refuses, and names the fix rather than the symptom', () => {
    const { db, mail } = mailWith(false);
    try {
      mail.assertCanSend('work');
      expect.fail('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      const message = (err as RpcError).message;
      // The owner can act on this. "The installed mail carrier cannot preserve
      // this saved draft" — the message this path used to fall into — would
      // send them to edit a draft that is perfectly fine.
      expect(message).toContain('cannot send');
      expect(message).toContain('Connections');
    }
    db.close();
  });

  it('accepts a send-capable mailbox', () => {
    const { db, mail } = mailWith(true);
    expect(() => mail.assertCanSend('work')).not.toThrow();
    db.close();
  });

  it('distinguishes "not connected" from "cannot send"', () => {
    // Two different repairs: reconnect the mailbox, versus add outbound to a
    // mailbox that is already there. One message for both would send half the
    // owners to the wrong screen.
    const { db, mail } = mailWith(true);
    try {
      mail.assertCanSend('gone');
      expect.fail('expected a refusal');
    } catch (err) {
      expect((err as RpcError).message).toContain('no longer connected');
      expect((err as RpcError).message).not.toContain('cannot send');
    }
    db.close();
  });

  it('reads the same capability the dispatch-time gate reads', () => {
    // `MailCollection.send` refuses with MAIL_SEND_NOT_CAPABLE off
    // `provider.sendCapable`; this refuses off the collection's mirror of it.
    // One fact, two readers — never two predicates.
    const draftOnly = mailWith(false);
    const sending = mailWith(true);
    expect(() => draftOnly.mail.assertCanSend('work')).toThrow();
    expect(() => sending.mail.assertCanSend('work')).not.toThrow();
    draftOnly.db.close(); sending.db.close();
  });
});
