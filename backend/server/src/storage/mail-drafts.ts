/** Encrypted local drafts with per-origin ownership and revision CAS. */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RpcError, parseMailDraftContent, parseMailDraftCreate, parseMailDraftUpdate, parseMailDraftDelete,
  parseMailDraftGet, parseMailDraftList, type MailDraft, type MailDraftSummary } from '@recued/contracts';
import type { PreapprovalCodec } from './preapproval-codec.js';
import { initializePreapprovalLifecycle, synchronizePreapprovalIdentity } from './preapproval-lifecycle.js';
import { preapprovalHash } from '../preapproval-invocations.js';
import type { PreapprovalDependency } from '../preapproval-model.js';

/** Host-derived principal. The owner can manage drafts from every contract;
 * contract callers can access only their own drafts. Never a wire argument. */
export interface MailDraftPrincipal {
  owner_id: string; contract_id: string | null;
  validate(): void;
}
interface Row {
  draft_id: string; incarnation: string; revision: number; owner_id: string; contract_id: string | null;
  principal: string; idempotency_key: string; request_hash: string; content_hash: string; ciphertext: string | null;
  created_at: number; updated_at: number; deleted_at: number | null;
  /** D-264 — the provider-side id of the last successful export of this draft,
   *  or NULL. Handed back as `prior` on a re-export so the mailbox is updated
   *  rather than accumulating copies. */
  mailbox_copy_id: string | null;
  /** D-264 — the mail instance that id belongs to.
   *
   *  ⛔ A provider id is only meaningful inside the account that issued it. The
   *  draft's `sender_mail_instance` is editable, so a draft saved to mailbox
   *  A and then re-pointed at B would otherwise hand A's id to B, where it can
   *  name an unrelated message. Stored and compared, never assumed. */
  mailbox_copy_instance: string | null;
}
const missing = (): never => { throw new RpcError('mail_draft_not_found', 'The saved draft is unavailable.', 404); };
const stale = (): never => { throw new RpcError('mail_draft_stale', 'The draft changed. Reload before saving or scheduling.', 409); };
export const createMailDraftStore = (db: Database.Database, codec: PreapprovalCodec, now: () => number = Date.now) => {
  initializePreapprovalLifecycle(db);
  db.exec(`CREATE TABLE IF NOT EXISTS mail_drafts (
    draft_id TEXT PRIMARY KEY, incarnation TEXT NOT NULL, revision INTEGER NOT NULL,
    owner_id TEXT NOT NULL, contract_id TEXT, principal TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL, content_hash TEXT NOT NULL, ciphertext TEXT, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, deleted_at INTEGER, UNIQUE(principal,idempotency_key))`);
  // D-264 — additive, nullable, migrated in place. `CREATE TABLE IF NOT EXISTS`
  // is a no-op on a database that already has this table, so a shipped server
  // needs the ALTER to ever see the column. Nullable with no default: a draft
  // that has never been exported has no provider id, and `NULL` says exactly
  // that where `''` would be a value the re-export path had to special-case.
  {
    const columns = (db.prepare('PRAGMA table_info(mail_drafts)').all() as Array<{ name: string }>)
      .map((column) => column.name);
    if (!columns.includes('mailbox_copy_id')) {
      db.exec('ALTER TABLE mail_drafts ADD COLUMN mailbox_copy_id TEXT');
    }
    if (!columns.includes('mailbox_copy_instance')) {
      db.exec('ALTER TABLE mail_drafts ADD COLUMN mailbox_copy_instance TEXT');
    }
  }
  const principalKey = (principal: MailDraftPrincipal): string => preapprovalHash([principal.owner_id, principal.contract_id]);
  const authorize = (principal: MailDraftPrincipal): void => { codec.assertUnlocked(); principal.validate(); };
  const read = (id: string, principal: MailDraftPrincipal): Row => {
    authorize(principal);
    const row = db.prepare('SELECT * FROM mail_drafts WHERE draft_id=?').get(id) as Row | undefined;
    if (!row || row.deleted_at !== null || row.owner_id !== principal.owner_id
      || (principal.contract_id !== null && row.contract_id !== principal.contract_id)) return missing();
    return row;
  };
  const pin = (row: Row): PreapprovalDependency => {
    const identity = synchronizePreapprovalIdentity(db, 'mail_draft', row.draft_id,
      { incarnation: row.incarnation, revision: row.revision, content_hash: row.content_hash, contract_id: row.contract_id })!;
    return { kind: identity.kind, key: identity.key, incarnation: identity.incarnation, revision: identity.revision,
      content_hash: identity.content_hash, until_phase: 'decision' };
  };
  const get = async (raw: unknown, principal: MailDraftPrincipal): Promise<MailDraft> => {
    const { draft_id } = parseMailDraftGet(raw); const row = read(draft_id, principal);
    const content = parseMailDraftContent(await codec.open(row.ciphertext!));
    const fresh = read(draft_id, principal);
    if (fresh.revision !== row.revision || fresh.incarnation !== row.incarnation || preapprovalHash(content) !== row.content_hash) stale();
    return { draft_id, incarnation: row.incarnation, revision: row.revision, content,
      origin_contract_id: row.contract_id, created_at: row.created_at, updated_at: row.updated_at };
  };
  return {
    get,
    /** D-264 — the provider id of this draft's last export INTO `instance`, or
     *  `null` when it was never exported there.
     *
     *  ⛔ Scoped on purpose. A caller that asked "what id does this draft have"
     *  without naming the account would get A's id for a draft now pointed at B,
     *  and B would resolve it against its own mailbox. The instance is part of
     *  the question, so it is part of the signature. */
    mailboxCopyId(draftId: string, instance: string, principal: MailDraftPrincipal): string | null {
      const row = read(draftId, principal);
      return row.mailbox_copy_instance === instance ? row.mailbox_copy_id : null;
    },
    /** D-264 — record what the provider returned.
     *
     *  ⛔ Its own column, NOT a field on the content. The content hash is pinned
     *  as a pre-approval dependency (`pin` above); folding an export id into it
     *  would bump the revision and invalidate a pending review of the SAME
     *  message, because the message did not change — only where a copy of it now
     *  lives. So this write touches neither `revision` nor `content_hash`, and a
     *  reviewed draft survives being exported. */
    /** Returns the id this export SUPERSEDED, or `null` when it did not
     *  supersede one — including when a concurrent export won the race.
     *
     *  ⚠ Compare-and-set on `expected`, not a blind UPDATE. Two authorized
     *  callers exporting the same draft concurrently both read a `null` prior,
     *  both create a mailbox copy, and a blind write would let the second
     *  silently overwrite the first's id — leaving one copy untracked in the
     *  owner's mailbox forever, with neither result mentioning it. The loser now
     *  learns it lost and can say so. */
    recordMailboxCopy(
      draftId: string, instance: string, sourceId: string,
      expected: string | null, principal: MailDraftPrincipal,
    ): { recorded: boolean } {
      const row = read(draftId, principal);
      const result = expected === null
        ? db.prepare(`UPDATE mail_drafts SET mailbox_copy_id=?, mailbox_copy_instance=?, updated_at=?
            WHERE draft_id=? AND mailbox_copy_id IS NULL`)
          .run(sourceId, instance, now(), row.draft_id)
        : db.prepare(`UPDATE mail_drafts SET mailbox_copy_id=?, mailbox_copy_instance=?, updated_at=?
            WHERE draft_id=? AND mailbox_copy_id=? AND mailbox_copy_instance=?`)
          .run(sourceId, instance, now(), row.draft_id, expected, instance);
      return { recorded: result.changes > 0 };
    },
    assertRevision(draftId: string, revision: number, principal: MailDraftPrincipal): PreapprovalDependency {
      const row = read(draftId, principal); if (row.revision !== revision) stale();
      return db.transaction(() => pin(row)).immediate();
    },
    async create(raw: unknown, principal: MailDraftPrincipal): Promise<MailDraft> {
      const request = parseMailDraftCreate(raw); authorize(principal);
      const key = principalKey(principal); const hash = preapprovalHash(request.content);
      const prior = (): Row | undefined => db.prepare('SELECT * FROM mail_drafts WHERE principal=? AND idempotency_key=?')
        .get(key, request.idempotency_key) as Row | undefined;
      const reuse = (row: Row): string => {
        if (row.request_hash !== hash) throw new RpcError('mail_draft_conflict', 'Use a new save request key for different content.', 409);
        return row.draft_id;
      };
      const existing = prior(); if (existing) return get({ draft_id: reuse(existing) }, principal);
      const ciphertext = await codec.seal(request.content);
      const id = db.transaction(() => {
        authorize(principal); const concurrent = prior(); if (concurrent) return reuse(concurrent);
        const timestamp = now(); const row: Row = { draft_id: `mad_${randomUUID()}`, incarnation: randomUUID(), revision: 1,
          owner_id: principal.owner_id, contract_id: principal.contract_id, principal: key, idempotency_key: request.idempotency_key,
          request_hash: hash, content_hash: hash, ciphertext, created_at: timestamp, updated_at: timestamp, deleted_at: null,
          mailbox_copy_id: null, mailbox_copy_instance: null };
        // ⚠ COLUMNS NAMED EXPLICITLY since D-264. A bare `VALUES(...)` binds by
        // POSITION against every column the table has, so the ALTER above would
        // have broken this INSERT the moment it ran — on a fresh database as
        // much as a migrated one. Naming them makes the next additive column a
        // no-op here instead of a runtime failure.
        db.prepare(`INSERT INTO mail_drafts (draft_id,incarnation,revision,owner_id,contract_id,principal,
          idempotency_key,request_hash,content_hash,ciphertext,created_at,updated_at,deleted_at,mailbox_copy_id,mailbox_copy_instance)
          VALUES(@draft_id,@incarnation,@revision,@owner_id,@contract_id,@principal,
          @idempotency_key,@request_hash,@content_hash,@ciphertext,@created_at,@updated_at,@deleted_at,@mailbox_copy_id,@mailbox_copy_instance)`).run(row);
        pin(row); return row.draft_id;
      }).immediate();
      return get({ draft_id: id }, principal);
    },
    async update(raw: unknown, principal: MailDraftPrincipal): Promise<MailDraft> {
      const request = parseMailDraftUpdate(raw); const current = read(request.draft_id, principal);
      if (current.revision !== request.expected_revision) stale();
      const ciphertext = await codec.seal(request.content); const hash = preapprovalHash(request.content);
      db.transaction(() => {
        const row = read(request.draft_id, principal); if (row.revision !== request.expected_revision || row.incarnation !== current.incarnation) stale();
        db.prepare('UPDATE mail_drafts SET revision=revision+1, content_hash=?, ciphertext=?, updated_at=? WHERE draft_id=? AND revision=?')
          .run(hash, ciphertext, now(), row.draft_id, row.revision);
        pin(read(request.draft_id, principal));
      }).immediate();
      return get({ draft_id: request.draft_id }, principal);
    },
    delete(raw: unknown, principal: MailDraftPrincipal): { deleted: true } {
      const request = parseMailDraftDelete(raw);
      return db.transaction(() => {
        const row = read(request.draft_id, principal); if (row.revision !== request.expected_revision) stale();
        synchronizePreapprovalIdentity(db, 'mail_draft', row.draft_id, null);
        db.prepare('UPDATE mail_drafts SET deleted_at=?, updated_at=?, revision=revision+1, ciphertext=NULL WHERE draft_id=?')
          .run(now(), now(), row.draft_id);
        return { deleted: true as const };
      }).immediate();
    },
    async list(raw: unknown, principal: MailDraftPrincipal): Promise<{ drafts: MailDraftSummary[]; next_cursor: string | null }> {
      const { cursor, limit } = parseMailDraftList(raw); authorize(principal);
      const rows = db.prepare(`SELECT draft_id FROM mail_drafts WHERE deleted_at IS NULL AND owner_id=?
        AND (? IS NULL OR contract_id=?) AND draft_id > ? ORDER BY draft_id LIMIT ?`)
        .all(principal.owner_id, principal.contract_id, principal.contract_id, cursor, limit + 1) as Array<{ draft_id: string }>;
      const drafts: MailDraftSummary[] = [];
      for (const row of rows.slice(0, limit)) {
        const { content, ...draft } = await get({ draft_id: row.draft_id }, principal);
        drafts.push({ ...draft, subject: content.subject, sender_mail_instance: content.sender_mail_instance });
      }
      return { drafts, next_cursor: rows.length > limit ? rows[limit - 1]!.draft_id : null };
    },
  };
};
export type MailDraftStore = ReturnType<typeof createMailDraftStore>;
