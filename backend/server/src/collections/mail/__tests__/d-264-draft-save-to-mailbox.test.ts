/** D-264 slice 4b — `core.mail.draft.save-to-mailbox`.
 *
 *  Three properties the wiring exists to hold, each of which fails silently if
 *  it breaks:
 *
 *    1. **The caller names a draft; it never supplies content.** The exported
 *       bytes come from the stored row, so the exported message and the
 *       reviewed message are the same by construction. A handler that accepted
 *       a message would export something the owner never saved, under the
 *       authority of a draft they did.
 *    2. **A re-export SUPERSEDES.** The stored `mailbox_copy_id` goes back to
 *       the provider as `prior`. Lose that and every export leaves another copy
 *       in the owner's mailbox, which looks like success from every angle.
 *    3. **The stored id advances only on the provider's own answer**, and only
 *       on success — a failed export must leave the prior id in place so the
 *       next attempt still tries to supersede.
 */

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { RpcError } from '@recued/contracts';
import { handleMailDraftSaveToMailbox } from '../draft-save-to-mailbox.js';
import { createMailDraftStore, type MailDraftPrincipal } from '../../../storage/mail-drafts.js';
import type { SavedDraftMeta } from '../provider.js';
import type { CollectionRegistry } from '../../registry.js';

/** The codec the draft store seals through. Plain JSON here — encryption is
 *  not what this file is testing, and a real codec would need a vault. */
const codec = {
  assertUnlocked() { /* always */ },
  async seal(value: unknown) { return JSON.stringify(value); },
  async open(cipher: string) { return JSON.parse(cipher) as unknown; },
} as unknown as Parameters<typeof createMailDraftStore>[1];

const principal: MailDraftPrincipal = {
  owner_id: 'owner', contract_id: null, validate() { /* granted */ },
};

interface SaveCall {
  to: string[]; subject: string; prior_source_id?: string;
}

const harness = async (opts: {
  saved?: Partial<SavedDraftMeta>;
  throws?: Error;
  draftCapable?: boolean;
  attachments?: string[];
} = {}) => {
  const db = new Database(':memory:');
  const drafts = createMailDraftStore(db, codec);
  const calls: SaveCall[] = [];
  const collection = {
    platform: 'mail' as const,
    draftCapable: opts.draftCapable !== false,
    async saveDraft(args: SaveCall): Promise<SavedDraftMeta> {
      calls.push(args);
      if (opts.throws) throw opts.throws;
      return {
        source_id: 'provider-1', saved_at: 1_700_000_000_000, replaced: false,
        ...opts.saved,
      };
    },
  };
  const registry = {
    get: (platform: string, slug: string) =>
      platform === 'mail' && slug === 'work' ? collection : undefined,
  } as unknown as CollectionRegistry;

  const draft = await drafts.create({
    idempotency_key: 'k1',
    content: {
      sender_mail_instance: 'work', to: ['them@example.com'],
      subject: 'Subject', body: 'Body', body_format: 'text' as const,
      ...(opts.attachments ? { attachments: opts.attachments } : {}),
    },
  }, principal);

  return { db, drafts, registry, calls, draft_id: draft.draft_id };
};

describe('D-264 — the export reads the STORED draft', () => {
  it('exports the row’s own bytes from a draft_id alone', async () => {
    const h = await harness();
    const result = await handleMailDraftSaveToMailbox(
      { registry: h.registry, drafts: h.drafts }, { draft_id: h.draft_id }, principal,
    );
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.to).toEqual(['them@example.com']);
    expect(h.calls[0]?.subject).toBe('Subject');
    expect(result.source_id).toBe('provider-1');
    expect(result.draft_id).toBe(h.draft_id);
    h.db.close();
  });

  it('refuses a draft whose mail instance is not enrolled, rather than guessing one', async () => {
    const h = await harness();
    const registry = { get: () => undefined } as unknown as CollectionRegistry;
    await expect(handleMailDraftSaveToMailbox(
      { registry, drafts: h.drafts }, { draft_id: h.draft_id }, principal,
    )).rejects.toBeInstanceOf(RpcError);
    h.db.close();
  });

  it('refuses a missing draft_id', async () => {
    const h = await harness();
    await expect(handleMailDraftSaveToMailbox(
      { registry: h.registry, drafts: h.drafts }, {}, principal,
    )).rejects.toBeInstanceOf(RpcError);
    expect(h.calls).toEqual([]);
    h.db.close();
  });
});

describe('D-264 — a re-export supersedes', () => {
  it('passes NO prior on the first export and the stored id on the second', async () => {
    const h = await harness({ saved: { source_id: 'p1' } });
    const deps = { registry: h.registry, drafts: h.drafts };

    await handleMailDraftSaveToMailbox(deps, { draft_id: h.draft_id }, principal);
    expect(h.calls[0]?.prior_source_id).toBeUndefined();

    await handleMailDraftSaveToMailbox(deps, { draft_id: h.draft_id }, principal);
    // Without this the owner accumulates a copy per export, and every layer
    // still reports success.
    expect(h.calls[1]?.prior_source_id).toBe('p1');
    h.db.close();
  });

  it('advances the stored id to what the PROVIDER returned, not to what was sent', async () => {
    const h = await harness({ saved: { source_id: 'server-assigned' } });
    await handleMailDraftSaveToMailbox(
      { registry: h.registry, drafts: h.drafts }, { draft_id: h.draft_id }, principal,
    );
    expect(h.drafts.mailboxCopyId(h.draft_id, 'work', principal)).toBe('server-assigned');
    h.db.close();
  });

  it('advances to the NEW id when the provider could not update in place', async () => {
    // IMAP appends a fresh UID rather than updating. Recording the prior id
    // here would make the next export try to supersede a draft that is gone,
    // and it would look correct at every layer — the first export's assertion
    // above passes either way, because `prior` is null there.
    const db = new Database(':memory:');
    const drafts = createMailDraftStore(db, codec);
    let nth = 0;
    const registry = {
      get: () => ({
        platform: 'mail' as const, draftCapable: true,
        async saveDraft(): Promise<SavedDraftMeta> {
          nth += 1;
          return { source_id: `uid-${nth}`, saved_at: 1, replaced: false };
        },
      }),
    } as unknown as CollectionRegistry;
    const draft = await drafts.create({
      idempotency_key: 'k', content: {
        sender_mail_instance: 'work', to: ['a@b.c'], subject: 's', body: 'b',
        body_format: 'text' as const,
      },
    }, principal);

    await handleMailDraftSaveToMailbox({ registry, drafts }, { draft_id: draft.draft_id }, principal);
    expect(drafts.mailboxCopyId(draft.draft_id, 'work', principal)).toBe('uid-1');
    await handleMailDraftSaveToMailbox({ registry, drafts }, { draft_id: draft.draft_id }, principal);
    expect(drafts.mailboxCopyId(draft.draft_id, 'work', principal)).toBe('uid-2');
    db.close();
  });

  it('reports the provider’s own `replaced`, never inferring it from `prior`', async () => {
    // IMAP can fail to remove the old copy. Two copies is an honest outcome;
    // claiming a replacement that did not happen is not.
    const h = await harness({
      saved: { source_id: 'p2', replaced: false,
        warnings: [{ code: 'MAIL_DRAFT_PRIOR_NOT_REMOVED', message: 'still there' }] },
    });
    const deps = { registry: h.registry, drafts: h.drafts };
    await handleMailDraftSaveToMailbox(deps, { draft_id: h.draft_id }, principal);
    const second = await handleMailDraftSaveToMailbox(deps, { draft_id: h.draft_id }, principal);
    expect(second.replaced).toBe(false);
    expect(second.warnings?.some((w) => w.code === 'MAIL_DRAFT_PRIOR_NOT_REMOVED')).toBe(true);
    h.db.close();
  });

  it('leaves the prior id in place when the export FAILS', async () => {
    // Otherwise the next attempt starts a fresh chain and the old copy is
    // orphaned in the mailbox forever.
    const ok = await harness({ saved: { source_id: 'p1' } });
    await handleMailDraftSaveToMailbox(
      { registry: ok.registry, drafts: ok.drafts }, { draft_id: ok.draft_id }, principal,
    );
    expect(ok.drafts.mailboxCopyId(ok.draft_id, 'work', principal)).toBe('p1');

    const failing = {
      get: () => ({
        platform: 'mail' as const, draftCapable: true,
        async saveDraft(): Promise<SavedDraftMeta> { throw new Error('provider down'); },
      }),
    } as unknown as CollectionRegistry;
    await expect(handleMailDraftSaveToMailbox(
      { registry: failing, drafts: ok.drafts }, { draft_id: ok.draft_id }, principal,
    )).rejects.toThrow('provider down');
    expect(ok.drafts.mailboxCopyId(ok.draft_id, 'work', principal)).toBe('p1');
    ok.db.close();
  });
});

describe('D-264 — the export is honest about what it left behind', () => {
  it('warns that attachments stayed in Recued rather than silently dropping them', async () => {
    const h = await harness({ attachments: ['data.file.received.a', 'data.file.received.b'] });
    const result = await handleMailDraftSaveToMailbox(
      { registry: h.registry, drafts: h.drafts }, { draft_id: h.draft_id }, principal,
    );
    const omitted = result.warnings?.find((w) => w.code === 'MAIL_DRAFT_ATTACHMENTS_OMITTED');
    expect(omitted).toBeDefined();
    expect(omitted?.message).toContain('2 attachment');
    h.db.close();
  });

  it('adds no attachment warning when the draft has none', async () => {
    const h = await harness();
    const result = await handleMailDraftSaveToMailbox(
      { registry: h.registry, drafts: h.drafts }, { draft_id: h.draft_id }, principal,
    );
    expect(result.warnings?.some((w) => w.code === 'MAIL_DRAFT_ATTACHMENTS_OMITTED')).not.toBe(true);
    h.db.close();
  });
});

describe('D-264 — the store migration', () => {
  it('adds mailbox_copy_id to a table created before D-264', () => {
    const db = new Database(':memory:');
    // The pre-D-264 DDL, verbatim in column order.
    db.exec(`CREATE TABLE mail_drafts (
      draft_id TEXT PRIMARY KEY, incarnation TEXT NOT NULL, revision INTEGER NOT NULL,
      owner_id TEXT NOT NULL, contract_id TEXT, principal TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL, content_hash TEXT NOT NULL, ciphertext TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, deleted_at INTEGER, UNIQUE(principal,idempotency_key))`);
    createMailDraftStore(db, codec);
    const columns = (db.prepare('PRAGMA table_info(mail_drafts)').all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(columns).toContain('mailbox_copy_id');
    expect(columns).toContain('mailbox_copy_instance');
    db.close();
  });

  it('still inserts on a MIGRATED table — the INSERT names its columns', async () => {
    // A positional `VALUES(...)` binds against every column the table has, so
    // the ALTER would break creates the moment it ran.
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE mail_drafts (
      draft_id TEXT PRIMARY KEY, incarnation TEXT NOT NULL, revision INTEGER NOT NULL,
      owner_id TEXT NOT NULL, contract_id TEXT, principal TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL, content_hash TEXT NOT NULL, ciphertext TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, deleted_at INTEGER, UNIQUE(principal,idempotency_key))`);
    const drafts = createMailDraftStore(db, codec);
    const draft = await drafts.create({
      idempotency_key: 'k', content: {
        sender_mail_instance: 'work', to: ['a@b.c'], subject: 's', body: 'b',
        body_format: 'text' as const,
      },
    }, principal);
    expect(drafts.mailboxCopyId(draft.draft_id, 'work', principal)).toBeNull();
    db.close();
  });
});


describe('D-264 — the export id is scoped to the mailbox that issued it', () => {
  /** A provider id only means something inside the account that issued it, and
   *  `sender_mail_instance` is editable. Without scoping, a draft saved into A
   *  and then re-pointed at B hands A's id to B — where, on IMAP, it can name an
   *  unrelated message. */
  it('does not hand mailbox A’s id to mailbox B', async () => {
    const db = new Database(':memory:');
    const drafts = createMailDraftStore(db, codec);
    const draft = await drafts.create({
      idempotency_key: 'k', content: {
        sender_mail_instance: 'work', to: ['a@b.c'], subject: 's', body: 'b',
        body_format: 'text' as const,
      },
    }, principal);
    drafts.recordMailboxCopy(draft.draft_id, 'work', 'uid-7', null, principal);

    expect(drafts.mailboxCopyId(draft.draft_id, 'work', principal)).toBe('uid-7');
    expect(drafts.mailboxCopyId(draft.draft_id, 'other', principal)).toBeNull();
    db.close();
  });

  it('refuses a second blind write — a concurrent export cannot silently win', async () => {
    const db = new Database(':memory:');
    const drafts = createMailDraftStore(db, codec);
    const draft = await drafts.create({
      idempotency_key: 'k', content: {
        sender_mail_instance: 'work', to: ['a@b.c'], subject: 's', body: 'b',
        body_format: 'text' as const,
      },
    }, principal);

    // Both callers read a null prior, both export, both try to record.
    expect(drafts.recordMailboxCopy(draft.draft_id, 'work', 'first', null, principal).recorded).toBe(true);
    expect(drafts.recordMailboxCopy(draft.draft_id, 'work', 'second', null, principal).recorded).toBe(false);
    expect(drafts.mailboxCopyId(draft.draft_id, 'work', principal)).toBe('first');
    db.close();
  });

  it('warns the loser of that race that the mailbox has an extra copy', async () => {
    const db = new Database(':memory:');
    const drafts = createMailDraftStore(db, codec);
    const registry = {
      get: () => ({
        platform: 'mail' as const, draftCapable: true,
        async saveDraft(): Promise<SavedDraftMeta> {
          // Simulate the peer landing while this export was in flight.
          drafts.recordMailboxCopy(draftId, 'work', 'peer', null, principal);
          return { source_id: 'mine', saved_at: 1, replaced: false };
        },
      }),
    } as unknown as CollectionRegistry;
    const draft = await drafts.create({
      idempotency_key: 'k', content: {
        sender_mail_instance: 'work', to: ['a@b.c'], subject: 's', body: 'b',
        body_format: 'text' as const,
      },
    }, principal);
    const draftId = draft.draft_id;

    const result = await handleMailDraftSaveToMailbox({ registry, drafts }, { draft_id: draftId }, principal);
    expect(result.warnings?.some((w) => w.code === 'MAIL_DRAFT_PRIOR_NOT_REMOVED')).toBe(true);
    db.close();
  });
});
