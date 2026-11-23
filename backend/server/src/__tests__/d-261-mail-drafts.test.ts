import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMailDraftStore, type MailDraftPrincipal } from '../storage/mail-drafts.js';
import { createPreapprovalCodec } from '../storage/preapproval-codec.js';
import { preapprovalHash } from '../preapproval-invocations.js';

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
  it('searches subjects and recipients beyond an empty scan page, retaining ownership and match cursors', async () => {
    const f = fixture();
    const saved = [];
    for (let n = 0; n < 105; n++) saved.push(await f.store.create({ idempotency_key: `draft-${n}`, content }, contract));
    saved.sort((a, b) => a.draft_id.localeCompare(b.draft_id));
    const first = saved[103]!, last = saved[104]!;
    await f.store.update({ draft_id: first.draft_id, expected_revision: 1,
      content: { ...content, subject: 'Ｑｕｏｔｅ 100%', bcc: ['private@example.test'] } }, contract);
    await f.store.update({ draft_id: last.draft_id, expected_revision: 1,
      content: { ...content, cc: ['QUOTE@example.test'] } }, contract);
    await f.store.create({ idempotency_key: 'other-contract', content: { ...content, subject: 'Quote' } }, principal('contract-b'));
    await f.store.create({ idempotency_key: 'other-owner', content: { ...content, subject: 'Quote' } }, { ...owner, owner_id: 'other-realm' });
    const empty = await f.store.list({ query: 'quote', limit: 1 }, contract);
    expect(empty).toEqual({ drafts: [], next_cursor: saved[99]!.draft_id });
    const page = await f.store.list({ query: 'quote', limit: 1, cursor: empty.next_cursor }, contract);
    expect(page.drafts).toEqual([expect.objectContaining({ draft_id: first.draft_id, to: content.to, bcc: ['private@example.test'] })]);
    expect(page.next_cursor).toBe(first.draft_id);
    const final = await f.store.list({ query: 'quote', limit: 1, cursor: page.next_cursor }, contract);
    expect(final.drafts.map(row => row.draft_id)).toEqual([last.draft_id]);
    expect(final.next_cursor).toBeNull();
    expect(final.drafts[0]).not.toHaveProperty('content');
    expect(final.drafts[0]).not.toHaveProperty('body');
  });
  it('combines an exact sender with literal recipient or subject matching, excluding message bodies and deleted drafts', async () => {
    const f = fixture();
    const work = await f.store.create({ idempotency_key: 'work', content: { ...content, subject: '100% renewal', bcc: ['Secret@example.test'] } }, owner);
    await f.store.create({ idempotency_key: 'personal', content: { ...content, subject: '100% renewal', sender_mail_instance: 'personal' } }, owner);
    const deleted = await f.store.create({ idempotency_key: 'deleted', content: { ...content, subject: '100% renewal' } }, owner);
    f.store.delete({ draft_id: deleted.draft_id, expected_revision: 1 }, owner);
    for (const query of ['%', 'SECRET@']) {
      const result = await f.store.list({ query, sender_mail_instance: 'work' }, owner);
      expect(result.drafts.map(row => row.draft_id)).toEqual([work.draft_id]);
    }
    expect((await f.store.list({ query: 'Private complete' }, owner)).drafts).toEqual([]);
    for (const request of [{ query: 4 }, { query: 'x'.repeat(201) }, { sender_mail_instance: '' },
      { sender_mail_instance: 4 }, { owner_id: 'other-realm' }, { cursor: 'bogus' }]) {
      await expect(f.store.list(request, owner)).rejects.toMatchObject({ code: 'BAD_INPUT' });
    }
  });
  it.each(['edit', 'delete', 'revoke'] as const)('does not return an earlier match after a later decrypt yields to %s', async action => {
    const f = fixture(); let live = true, opened = 0;
    const saved = await Promise.all(['one', 'two'].map(idempotency_key => f.store.create({ idempotency_key, content }, owner)));
    saved.sort((a, b) => a.draft_id.localeCompare(b.draft_id));
    const actor = { ...owner, validate() { if (!live) throw new Error('Read grant revoked'); } };
    const store = createMailDraftStore(f.db, { ...f.codec, async open(value) {
      const result = await f.codec.open(value);
      if (++opened === 2) {
        const target = { draft_id: saved[0]!.draft_id, expected_revision: 1 };
        if (action === 'edit') await f.store.update({ ...target, content: { ...content, subject: 'Changed' } }, owner);
        if (action === 'delete') f.store.delete(target, owner);
        if (action === 'revoke') live = false;
      }
      return result;
    } });
    const pending = store.list({ query: 'report' }, actor);
    if (action === 'revoke') await expect(pending).rejects.toThrow('Read grant revoked');
    else await expect(pending).rejects.toMatchObject({ code: action === 'edit' ? 'mail_draft_stale' : 'mail_draft_not_found' });
  });
  it('opens, lists and deletes a draft saved before one address per entry, and saves it once each recipient has an entry', async () => {
    const f = fixture();
    // What a server before the rule stored: two addresses in one entry, sealed and hashed as any save is.
    const legacy = { ...content, to: ['ann@example.test, bob@example.test'] };
    const stored = async (key: string) => {
      const saved = await f.store.create({ idempotency_key: key, content }, owner);
      f.db.prepare('UPDATE mail_drafts SET ciphertext=?, content_hash=? WHERE draft_id=?')
        .run(await f.codec.seal(legacy), preapprovalHash(legacy), saved.draft_id);
      return saved;
    };
    const kept = await stored('keep'); const dropped = await stored('drop');
    await expect(f.store.get({ draft_id: kept.draft_id }, owner)).resolves.toMatchObject({ content: legacy });
    expect((await f.store.list({}, owner)).drafts.map(draft => draft.draft_id).sort())
      .toEqual([kept.draft_id, dropped.draft_id].sort());
    expect((await f.store.list({ query: 'BOB@example.test' }, owner)).drafts.map(draft => draft.draft_id).sort())
      .toEqual([kept.draft_id, dropped.draft_id].sort());
    expect(f.store.delete({ draft_id: dropped.draft_id, expected_revision: dropped.revision }, owner)).toEqual({ deleted: true });
    await expect(f.store.update({ draft_id: kept.draft_id, expected_revision: kept.revision, content: legacy }, owner))
      .rejects.toThrow('mail-send: to[0] holds more than one address; give each recipient its own entry');
    const fixed = await f.store.update({ draft_id: kept.draft_id, expected_revision: kept.revision,
      content: { ...legacy, to: ['ann@example.test', 'bob@example.test'] } }, owner);
    expect(fixed.content.to).toEqual(['ann@example.test', 'bob@example.test']);
  });
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
