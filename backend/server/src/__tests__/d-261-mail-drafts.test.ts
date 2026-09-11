import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMailDraftStore, type MailDraftPrincipal } from '../storage/mail-drafts.js';
import { createPreapprovalCodec } from '../storage/preapproval-codec.js';

const databases: Database.Database[] = []; const directories: string[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const principal = (contract_id: string | null): MailDraftPrincipal => ({ owner_id: 'realm', contract_id, validate() {} });
const owner = principal(null); const contract = principal('contract-a');
const content = { sender_mail_instance: 'work', to: ['person@example.test'], cc: ['copy@example.test'],
  subject: 'Saved report', body: 'Private complete draft content.', body_format: 'text' as const, attachments: ['file:report'] };
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'd261-drafts-')); directories.push(dir);
  const open = () => { const db = new Database(join(dir, 'realm.db')); databases.push(db); db.pragma('journal_mode = WAL'); return db; };
  const codec = createPreapprovalCodec(() => new Uint8Array(32).fill(8)); const db = open();
  return { db, codec, store: createMailDraftStore(db, codec), open };
};

describe('D-261 encrypted governed draft storage', () => {
  it('preserves ownership, excludes plaintext at rest and converges concurrent save requests across connections', async () => {
    const f = fixture(); const other = createMailDraftStore(f.open(), f.codec);
    const request = { idempotency_key: 'same-save', content };
    const saved = await Promise.all([f.store.create(request, contract), other.create(request, contract)]);
    expect(saved[1]).toEqual(saved[0]); expect(saved[0]!.origin_contract_id).toBe('contract-a');
    expect(f.db.prepare('SELECT count(*) AS count FROM mail_drafts').get()).toEqual({ count: 1 });
    expect(JSON.stringify(f.db.prepare('SELECT * FROM mail_drafts').get())).not.toContain(content.body);
    const target = { draft_id: saved[0]!.draft_id };
    await expect(f.store.get(target, principal('contract-b'))).rejects.toMatchObject({ code: 'mail_draft_not_found' });
    await expect(f.store.get(target, owner)).resolves.toMatchObject({ content });
    expect(await f.store.list({}, principal('contract-b'))).toEqual({ drafts: [], next_cursor: null });
    const listed = await f.store.list({}, owner); expect(listed.drafts).toHaveLength(1);
    expect(listed.drafts[0]).not.toHaveProperty('content');
    await expect(other.create({ ...request, content: { ...content, body: 'Different' } }, contract))
      .rejects.toMatchObject({ code: 'mail_draft_conflict' });
  });
  it('allows one revision-CAS writer and retains a deletion tombstone without recreating from an old request', async () => {
    const f = fixture(); const other = createMailDraftStore(f.open(), f.codec);
    const saved = await f.store.create({ idempotency_key: 'save', content }, contract);
    const request = { draft_id: saved.draft_id, expected_revision: saved.revision, content: { ...content, subject: 'Updated' } };
    const results = await Promise.allSettled([f.store.update(request, contract), other.update(request, owner)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const current = await f.store.get({ draft_id: saved.draft_id }, owner);
    expect(current).toMatchObject({ revision: 2, incarnation: saved.incarnation, content: { subject: 'Updated' } });
    expect(() => f.store.delete({ draft_id: current.draft_id, expected_revision: 1 }, owner)).toThrow('draft changed');
    f.store.delete({ draft_id: current.draft_id, expected_revision: current.revision }, owner);
    expect(f.db.prepare('SELECT ciphertext, deleted_at FROM mail_drafts').get()).toMatchObject({ ciphertext: null, deleted_at: expect.any(Number) });
    await expect(other.create({ idempotency_key: 'save', content }, contract)).rejects.toMatchObject({ code: 'mail_draft_not_found' });
  });
  it('rechecks authority after encryption and rejects approval-shaped fields', async () => {
    const f = fixture(); let live = true;
    const actor = { ...contract, validate() { if (!live) throw new Error('The contract was revoked'); } };
    const store = createMailDraftStore(f.db, { ...f.codec, async seal(value) { const sealed = await f.codec.seal(value); live = false; return sealed; } });
    await expect(store.create({ idempotency_key: 'save', content }, actor)).rejects.toThrow('contract was revoked');
    expect(f.db.prepare('SELECT count(*) AS count FROM mail_drafts').get()).toEqual({ count: 0 });
    await expect(f.store.create({ idempotency_key: 'forged', content, approved: true }, owner)).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(f.store.create({ idempotency_key: 'forged', content: { ...content, grant_id: 'anything' } }, owner)).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });
});
