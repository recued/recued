/** D-207 slice 3d — the fence is reachable from `mail-post`, proven at the JOIN.
 *
 *  ## Why this file exists at all
 *
 *  Two suites already covered the two halves and covered nothing between them:
 *  `d-127-phase-3-1-…-email` drives the notification façade with a STUBBED
 *  `mailRpc`, and `d-207-slice3d-…-wiring` drives the real collection with a
 *  STUBBED provider. Both green, and neither ever ran the composition — so a
 *  façade that quietly dropped `reconciliation_id` on the floor (which is what
 *  it did) passed both.
 *
 *  This suite wires the join the boot site wires: the real
 *  `createConnectionNotificationHandler`, whose `mailRpc.send` closes over the
 *  real `handleCollectionMailSend` over a real `MailCollection` with a real
 *  claim store — exactly `wire-connection-notification.ts`. Only the provider
 *  is stubbed, because it is the outside world.
 *
 *  ## What was actually wrong
 *
 *  AUD-5 recorded that `mail-post` "writes no send claim", on the evidence that
 *  `connection-notification.ts` contains no reference to the claim store. It
 *  does not need one: it is a façade over `MailCollection.send`, which owns the
 *  fence. The real defect was narrower and invisible to that grep — the façade
 *  built its send args WITHOUT `reconciliation_id`, so the fence is opt-in per
 *  call by design and no `mail-post` recipe could ever opt in.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createConnectionNotificationHandler } from '@recued/ingredients';
import { createBlobStore } from '../storage/blob-store.js';
import { createMailCollection } from '../collections/mail/mail-collection.js';
import { createMailSendClaimStore } from '../storage/mail-send-claim-store.js';
import { handleCollectionMailSend } from '../collections/collection-handler.js';
import type { CollectionRegistry } from '../collections/registry.js';
import type { MailCollection } from '../collections/mail/mail-collection.js';

const RID = 'ord:paid-doc:sub_1:delivery';
const SLUG = 'work';

let db: Database.Database;
let blobsDir: string;

const stubProvider = (send: ReturnType<typeof vi.fn>) =>
  ({
    kind: 'imap',
    sendCapable: true,
    accountEmail: 'owner@example.com',
    send,
    initialScan: async () => {},
    poll: async () => {},
    stop: async () => {},
  }) as never;

const stubRegistry = (mailCollection: MailCollection): CollectionRegistry => ({
  register() { /* no-op */ },
  get(platform: string, slug: string) {
    if (platform === 'mail' && slug === mailCollection.slug) return mailCollection;
    return null;
  },
  list() { return [mailCollection]; },
  unregister() { return false; },
  dispose: async () => { /* no-op */ },
} as unknown as CollectionRegistry);

/** The boot site, verbatim: `wire-connection-notification.ts` closes
 *  `mailRpc.send` over `handleCollectionMailSend` on the live registry. */
const wireLikeBoot = (send: ReturnType<typeof vi.fn>) => {
  const collection = createMailCollection({
    db,
    blobs: createBlobStore(blobsDir),
    gate: { addUsed: () => {}, getUsed: () => 0 } as never,
    bus: createWarehouseEventBus(),
    slug: SLUG,
    provider: stubProvider(send),
    config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 1024 * 1024 }),
  });
  const registry = stubRegistry(collection);
  return createConnectionNotificationHandler({
    decodeAuth: vi.fn(),
    mailRpc: {
      // ⚠ `args` needs its own annotation: the object is `as never`, so there is
      // no contextual type to infer it from and it lands as an implicit any.
      send: (args: Parameters<typeof handleCollectionMailSend>[1]) =>
        handleCollectionMailSend({ registry } as never, args) as never,
    },
  } as never);
};

const row = () => ({
  kind: 'notification',
  name: 'billing-email',
  subtype: 'email',
  config_json: JSON.stringify({ sender_mail_instance: SLUG }),
  auth_ciphertext: null,
}) as never;

const okSend = () =>
  vi.fn(async () => ({
    source_id: 'src_1',
    message_id: '<abc@mail>',
    sent_at: 1_700_000_000_500,
  }));

const call = () => ({ setBytes: () => {} }) as never;

beforeEach(() => {
  db = new Database(':memory:');
  blobsDir = mkdtempSync(join(tmpdir(), 'd207-3d-join-'));
});

afterEach(() => {
  rmSync(blobsDir, { recursive: true, force: true });
});

describe('D-207 3d — mail-post reaches the fence', () => {
  it('🔴 a mail-post send carrying a reconciliation_id writes a real claim row', async () => {
    // The whole point. Before the fix this passed no id down, so the store
    // stayed empty however the recipe was authored.
    const send = okSend();
    const handler = wireLikeBoot(send);
    await handler(
      row(),
      { to: ['customer@example.com'], subject: 'Brief', body: 'Attached.', reconciliation_id: RID },
      call(),
    );
    const claim = createMailSendClaimStore(db).get(RID);
    expect(claim).not.toBeNull();
    expect(claim?.status).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('🔴 a second identical mail-post send does NOT reach the provider again', async () => {
    const send = okSend();
    const handler = wireLikeBoot(send);
    const params = {
      to: ['customer@example.com'],
      subject: 'Brief',
      body: 'Attached.',
      reconciliation_id: RID,
    };
    await handler(row(), params, call());
    const second = await handler(row(), params, call());

    // One dispatch, two calls — the fence answered the second.
    expect(send).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({
      status: 'ok',
      result: { already_sent: true, message_id: '<abc@mail>' },
    });
  });

  it('an ordinary mail-post send still pays for no fence and writes no claim', async () => {
    const send = okSend();
    const handler = wireLikeBoot(send);
    await handler(
      row(),
      { to: ['customer@example.com'], subject: 'Brief', body: 'Attached.' },
      call(),
    );
    expect(createMailSendClaimStore(db).get(RID)).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
