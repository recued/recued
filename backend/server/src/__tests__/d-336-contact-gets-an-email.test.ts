/** D-336 slice I — a contact with no address gets its email (`contact.add_email`), from the
 *  contact's Edit form. The store's promotion re-keys the contact: it keeps its id, so its
 *  notes and relationships stay, and the placeholder it was keyed on stays its alias, so a
 *  reference that holds it still opens the contact. Through the registered handlers. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SERVER_RPC_METHODS,
  isMailboxAddress,
  isMentionOnlyEmail,
  isMcpToolName,
  type ContactRecord,
  type MemoryClaim,
} from '@recued/contracts';
import { createInMemoryCollection, type AuditLogStore } from '@recued/storage';

import { makeContactHandlers } from '../contact-handler.js';
import { makeContactMergeHandlers } from '../contact-merge-handler.js';
import { createRemergePromptStore } from '../contact-merge-prompt-store.js';
import { createContactStore } from '../storage/contact-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createUserMemoryStore, USER_MEMORY_ID_PREFIX, type UserMemoryRow } from '../user-memory-store.js';
import { handleMemoryClaims, handleMemoryCreate, type MemoryRedactionRecord, type MemoryRpcDeps } from '../memory-rpc-handler.js';
import { ownerClaimRecords } from '../memory-claim.js';
import type { BlobStore } from '../storage/blob-store.js';

const disposals: Array<() => void> = [];
afterEach(() => { while (disposals.length > 0) disposals.pop()!(); });

const fixture = () => {
  const db = new Database(':memory:');
  disposals.push(() => db.close());
  const updates: ContactRecord[] = [];
  const contacts = createContactStore(db, { onContactUpserted: (record) => { updates.push(record); } });
  const slice = makeContactHandlers({ store: contacts, now: () => 1000 })!;
  const call = <T>(method: string, args: unknown) =>
    (slice.handlers as unknown as Record<string, (a: never, c: never) => Promise<T>>)[method](args as never, undefined as never);
  const named = async (name: string) => (await call<{ contact: ContactRecord }>('contact.create_by_name', { name })).contact;
  const addEmail = (contact_id: string, email: string) => call<{ contact: ContactRecord }>('contact.add_email', { contact_id, email });
  const get = async (email: string) => (await call<{ contact: ContactRecord | null }>('contact.get', { email })).contact;
  return { db, contacts, slice, named, addEmail, get, updates };
};

const blobs = (): BlobStore => {
  const m = new Map<string, Uint8Array>();
  return {
    put: async (b: Uint8Array) => { const h = `h${m.size}`; m.set(h, b); return h; },
    get: async (h: string) => m.get(h) ?? null,
    has: async (h: string) => m.has(h),
    delete: async (h: string) => m.delete(h),
  } as unknown as BlobStore;
};

describe('contact.add_email — a contact with no address gets its email', () => {
  it('re-keys the contact onto the address, the same contact, its name kept', async () => {
    const f = fixture();
    const dana = await f.named('Dana');
    expect(isMentionOnlyEmail(dana.email)).toBe(true);
    const { contact } = await f.addEmail(dana.contact_id!, '  Dana@Example.TEST ');
    expect(contact).toMatchObject({ contact_id: dana.contact_id, email: 'dana@example.test', name: 'Dana', identity_status: 'verified' });
    expect(await f.get('dana@example.test')).toMatchObject({ contact_id: dana.contact_id });
    expect(f.contacts.list({}).length).toBe(1);
    // The address is the owner's own, an alias at their rank.
    expect(f.contacts.listResolvedContactAliases(dana.contact_id!)
      .find((row) => row.kind === 'email_alias' && row.alias_pattern === 'dana@example.test'))
      .toMatchObject({ source: 'manual' });
    // A paired client hears of it, as of any contact update.
    expect(f.updates.at(-1)).toMatchObject({ contact_id: dana.contact_id, email: 'dana@example.test' });
  });

  it('⛔ the placeholder still opens the contact; any other address reads its own row only', async () => {
    const f = fixture();
    const dana = await f.named('Dana');
    const whit = await f.named('Whit');
    await f.addEmail(dana.contact_id!, 'dana@example.test');
    expect(await f.get(dana.email)).toMatchObject({ contact_id: dana.contact_id, email: 'dana@example.test' });
    // Another contact's placeholder is still that contact, and a stranger is nobody.
    expect(await f.get(whit.email)).toMatchObject({ contact_id: whit.contact_id });
    expect(await f.get('nobody@example.test')).toBeNull();
    // A second mailbox is not widened into its owner: `contact.get` reads one row.
    f.contacts.upsertManual({ email: 'bob@example.test', name: 'Bob' });
    f.contacts.upsertContactAlias({
      contact_id: f.contacts.get('bob@example.test')!.contact_id!, kind: 'email_alias',
      alias_pattern: 'bob@home.example.test', source: 'manual',
    });
    expect(await f.get('bob@home.example.test')).toBeNull();
  });

  it('⛔ an address already another contact\'s is refused with their name, and nothing changes', async () => {
    const f = fixture();
    f.contacts.upsertManual({ email: 'dana.whitfield@example.test', name: 'Dana Whitfield' });
    const dana = await f.named('Dana');
    await expect(f.addEmail(dana.contact_id!, 'Dana.Whitfield@example.test')).rejects.toMatchObject({
      code: 'conflict', message: '“dana.whitfield@example.test” is already Dana Whitfield\'s address.',
    });
    expect(isMentionOnlyEmail(f.contacts.getByContactId(dana.contact_id!)!.email)).toBe(true);
    expect(f.contacts.get('dana.whitfield@example.test')).toMatchObject({ name: 'Dana Whitfield' });
    // Their second mailbox is theirs too.
    f.contacts.upsertContactAlias({
      contact_id: f.contacts.get('dana.whitfield@example.test')!.contact_id!, kind: 'email_alias',
      alias_pattern: 'dana@home.example.test', source: 'manual',
    });
    await expect(f.addEmail(dana.contact_id!, 'dana@home.example.test')).rejects.toMatchObject({
      code: 'conflict', message: '“dana@home.example.test” is already Dana Whitfield\'s address.',
    });
    expect(f.contacts.list({}).length).toBe(2);
  });

  it('⛔ a contact that has an address keeps it; the same one again is the contact as it is', async () => {
    const f = fixture();
    const dana = await f.named('Dana');
    await f.addEmail(dana.contact_id!, 'dana@example.test');
    await expect(f.addEmail(dana.contact_id!, 'dana@work.example.test')).rejects.toMatchObject({
      code: 'conflict', message: 'This contact already has an email address.',
    });
    expect((await f.addEmail(dana.contact_id!, 'DANA@example.test')).contact).toMatchObject({ email: 'dana@example.test' });
    f.contacts.upsertManual({ email: 'bob@example.test', name: 'Bob' });
    await expect(f.addEmail(f.contacts.get('bob@example.test')!.contact_id!, 'robert@example.test'))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(f.contacts.get('bob@example.test')).not.toBeNull();
  });

  it('⛔ refuses what is no address, and a contact that is gone, in the owner\'s words', async () => {
    const f = fixture();
    const dana = await f.named('Dana');
    await expect(f.addEmail(dana.contact_id!, '   ')).rejects.toMatchObject({ code: 'bad_request', message: 'Write the email address first.' });
    // Audit 2026-11-01 — `Mia<mia@example.test>` was taken, and an address cannot be changed.
    for (const typed of ['dana', 'dana @example.test', 'a@b@example.test', 'Dana <dana@example.test>', 'Mia<mia@example.test>', dana.email]) {
      await expect(f.addEmail(dana.contact_id!, typed), typed).rejects.toMatchObject({
        code: 'bad_request', message: 'Write the email address alone, like dana@example.com.',
      });
    }
    await expect(f.addEmail('contact-gone', 'dana@example.test')).rejects.toMatchObject({ code: 'not_found', message: 'This contact is no longer there.' });
    expect(isMentionOnlyEmail(f.contacts.getByContactId(dana.contact_id!)!.email)).toBe(true);
    // Brackets around the address alone are taken off (`canonicalizeEmail`), as everywhere.
    expect((await f.addEmail(dana.contact_id!, '<dana@example.test>')).contact.email).toBe('dana@example.test');
  });

  /** Audit 2026-11-01 (second, the owner's ask) — the New contact form took
   *  `Mia <mia@example.test>` whole, as the contact's key for good. */
  it('⛔ a contact the paired client adds takes one address alone; one a contact has already stays editable', async () => {
    const f = fixture();
    const upsert = (args: Record<string, unknown>) => f.slice.handlers['contact.upsert'](args as never, undefined as never);
    for (const typed of ['Mia <mia@example.test>', 'Mia<mia@example.test>', 'mia@example']) {
      await expect(upsert({ email: typed, name: 'Mia' }), typed).rejects.toMatchObject({
        code: 'bad_request', message: 'Write the email address alone, like dana@example.com.',
      });
    }
    expect(f.contacts.list({})).toHaveLength(0);
    expect((await upsert({ email: 'Mia@Example.test', name: 'Mia' })).contact.email).toBe('mia@example.test');
    // A contact keyed on such an address before stays the owner's to edit, under it.
    const legacy = f.contacts.upsertManual({ email: 'old friend <old@example.test>', name: 'Old Friend' });
    expect((await upsert({ email: legacy.email, phone: '+15555550123' })).contact).toMatchObject({ email: legacy.email, phone: '+15555550123' });
    // So does a contact with no address, under its placeholder.
    const dana = await f.named('Dana');
    expect((await upsert({ email: dana.email, phone: '+15555550199' })).contact.contact_id).toBe(dana.contact_id);
  });

  it('a mailbox address is one address and nothing around it', () => {
    for (const ok of ['dana@example.test', 'dana.whitfield+mail@example.co.uk', "o'brien@example.test", 'josé@exämple.de', 'DANA@EXAMPLE.TEST', '1@2.io']) {
      expect(isMailboxAddress(ok), ok).toBe(true);
    }
    for (const bad of [
      'Mia <mia@example.test>', 'Mia<mia@example.test>', '<mia@example.test>', 'mia@example.test>', 'mia@example', 'mia@@example.test',
      // A bracket in the local part alone, which the domain's rule cannot catch.
      'Mia<mia@example.test', 'mia>dana@example.test', 'mia(dana)@example.test',
      'a@b@example.test', 'mia@example..test', '.mia@example.test', 'mia.@example.test', 'mi..a@example.test', 'mia@-example.test',
      'mia@example-.test', 'mia@example.test.', 'mia@exa_mple.test', 'mia,dana@example.test', 'mia dana@example.test', '"mia"@example.test',
      'mention-only-ct-1@_recued.invalid', '', `${'x'.repeat(65)}@example.test`, `mia@${'d'.repeat(60)}.${'e'.repeat(60)}.${'f'.repeat(60)}.${'g'.repeat(70)}.test`,
    ]) {
      expect(isMailboxAddress(bad), bad).toBe(false);
    }
  });

  it('is a paired client\'s rpc of its own, never an AI tool', () => {
    expect(SERVER_RPC_METHODS).toContain('contact.add_email');
    expect(fixture().slice.methods).toContain('contact.add_email');
    expect(isMcpToolName('contact.add_email')).toBe(false);
  });
});

describe('the contact keeps its notes when it gets an address', () => {
  const memoryDeps = (contacts: ReturnType<typeof createContactStore>, db: Database.Database): MemoryRpcDeps => {
    let seq = 0;
    return {
      auditLog: { listWindow: async () => [], listRecent: async () => [], get: async () => null } as unknown as AuditLogStore,
      userMemoryStore: createUserMemoryStore(createSQLiteCollection<UserMemoryRow>(db, 'user_memory'), blobs(), {
        db, now: () => 2000 + seq, mintId: () => `${USER_MEMORY_ID_PREFIX}${(seq += 1)}`,
      }),
      redactionStore: createInMemoryCollection<MemoryRedactionRecord>(),
      claimRecords: ownerClaimRecords({ contacts }),
      now: () => 3000,
    };
  };

  it('its relationships still list the note, and the note\'s link still reaches it', async () => {
    const f = fixture();
    const mia = await f.named('Mia');
    const deps = memoryDeps(f.contacts, f.db);
    const claim: MemoryClaim = { subject: { contact_id: mia.contact_id!, name: 'Mia' }, relation: 'daughter of', object: { text: 'Dana' } };
    const made = await handleMemoryCreate(deps, { kind: 'note', summary: "Mia is Dana's daughter", claim });
    expect(made.provenance_edges_written).toBe(1);
    await f.addEmail(mia.contact_id!, 'mia@example.test');
    const listed = await handleMemoryClaims(deps, { contact: mia.contact_id! });
    expect(listed.claims.map((n) => n.memory_id)).toEqual([made.memory_id]);
    // The note links her by the placeholder it was saved with, which now resolves to her.
    expect(f.contacts.resolveCanonicalEmail(mia.email).canonical_email).toBe('mia@example.test');
  });
});

describe('D-336 slice P — two contacts one address names merge, from its refusal', () => {
  const mergeSlice = (f: ReturnType<typeof fixture>, identity: unknown[] = []) => {
    const slice = makeContactMergeHandlers({
      contactStore: f.contacts, now: () => 2000, newId: () => 'cand-owner',
      onIdentityChanged: (input) => { identity.push(input); },
    })!;
    const pair = (survivor_email: string, other_email: string, name?: string, picks: Record<string, string> = {}) =>
      (slice.handlers as unknown as Record<string, (a: never, c: never) => Promise<{ survivor: ContactRecord; losers: ContactRecord[] }>>)
        ['contact.merge.pair']({ survivor_email, other_email, ...(name !== undefined ? { name } : {}), ...picks } as never, undefined as never);
    return { slice, pair };
  };
  const DANA_W = 'dana.whitfield@example.test';

  it('the refusal names the contact that has the address, so the form can offer the merge', async () => {
    const f = fixture();
    f.contacts.upsertManual({ email: DANA_W, name: 'Dana Whitfield' });
    const dana = await f.named('Dana');
    await expect(f.addEmail(dana.contact_id!, 'Dana.Whitfield@example.test')).rejects.toMatchObject({
      code: 'conflict', details: { reason: 'address_taken', contact_email: DANA_W, contact_name: 'Dana Whitfield' },
    });
  });

  /** As it happens: Dana Whitfield typed in first, then Dana added from her name, so Dana's
   *  name is the newer of two at the owner's rank. */
  const twoDanas = async (f: ReturnType<typeof fixture>) => {
    f.contacts.upsertManual({ email: DANA_W, name: 'Dana Whitfield', company: 'Acme' }, 500);
    const dana = await f.named('Dana');
    f.contacts.upsertManual({ email: dana.email, birthday: '1990-03-04', last_interaction: dana.last_interaction }, 1100);
    return dana;
  };

  it('merges the contact with no address into the one that has it: one contact with both\'s details', async () => {
    const f = fixture();
    const dana = await twoDanas(f);
    const identity: unknown[] = [];
    const { pair } = mergeSlice(f, identity);
    const { survivor, losers } = await pair(DANA_W, dana.email, 'Dana Whitfield');
    // The name the owner picked, though Dana's was the newer.
    expect(survivor).toMatchObject({ email: DANA_W, name: 'Dana Whitfield', company: 'Acme', birthday: '1990-03-04' });
    expect(survivor.projection_provenance?.name).toMatchObject({ source: 'manual' });
    expect(losers.map((loser) => [loser.email, loser.merged_into])).toEqual([[dana.email, DANA_W]]);
    // What named the contact with no address now reaches the one kept.
    expect(f.contacts.resolveCanonicalEmail(dana.email).canonical_email).toBe(DANA_W);
    // Listed in the merge history as the owner's own, so it can be separated again.
    expect(f.contacts.listMergeCandidates({ status: 'merged' }).candidates)
      .toMatchObject([{ id: 'cand-owner', detected_by: 'owner', matched_fields: [], status: 'merged' }]);
    expect(identity).toEqual([{ survivor_email: DANA_W, loser_emails: [dana.email] }]);
  });

  it('without a pick, the newer name wins, as in any merge; the pick may be the other name; a bad one merges nothing', async () => {
    const unpicked = fixture();
    const dana = await twoDanas(unpicked);
    expect((await mergeSlice(unpicked).pair(DANA_W, dana.email)).survivor.name).toBe('Dana');

    const theOther = fixture();
    const other = await twoDanas(theOther);
    expect((await mergeSlice(theOther).pair(DANA_W, other.email, '  Dana ')).survivor.name).toBe('Dana');

    const refused = fixture();
    const again = await twoDanas(refused);
    const { pair } = mergeSlice(refused);
    for (const bad of ['', '   ', 'D'.repeat(201)]) {
      await expect(pair(DANA_W, again.email, bad)).rejects.toMatchObject({ code: 'bad_request' });
    }
    expect(refused.contacts.get(again.email)?.merged_into).toBeUndefined();
  });

  it('⛔ keeps the contact that has the address, and refuses the same contact twice and one gone or merged', async () => {
    const f = fixture();
    f.contacts.upsertManual({ email: DANA_W, name: 'Dana Whitfield' });
    const dana = await f.named('Dana');
    const { pair } = mergeSlice(f);
    await expect(pair(dana.email, DANA_W)).rejects.toMatchObject({
      code: 'bad_request', message: 'Keep the contact that has the email address, and merge this one into it.',
    });
    await expect(pair(DANA_W, 'DANA.Whitfield@example.test')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(pair(DANA_W, 'nobody@example.test')).rejects.toMatchObject({ code: 'not_found' });
    expect(f.contacts.listMergeCandidates({ status: 'merged' }).candidates).toEqual([]);
    expect(f.contacts.get(dana.email)?.merged_into).toBeUndefined();
    await pair(DANA_W, dana.email);
    await expect(pair(DANA_W, dana.email)).rejects.toMatchObject({
      code: 'conflict', message: 'This contact was merged into another already.',
    });
  });

  it('its open item — each other field picked is kept, as the owner\'s where the merge would keep the other; a value neither holds merges nothing', async () => {
    const f = fixture();
    const { pair } = mergeSlice(f);
    f.contacts.upsertManual({
      email: DANA_W, name: 'Dana Whitfield', company: 'Acme', phone: '+15550001111', birthday: '1980-02-03', anniversary: '--06-07',
    }, 500);
    const dana = await f.named('Dana');
    // Dana's details are the newer, so the merge alone would keep each of hers.
    f.contacts.upsertManual({
      email: dana.email, company: 'Bloom', phone: '+15550002222', birthday: '1981-02-03', anniversary: '--07-08',
      last_interaction: dana.last_interaction,
    }, 1100);
    // A value neither holds, in any field asked about, merges nothing.
    const neither: Array<Record<string, string>> = [
      { company: 'Someone else' }, { phone: '+15550009999' }, { birthday: '1999-09-09' }, { anniversary: '--09-09' },
    ];
    for (const picks of neither) {
      await expect(pair(DANA_W, dana.email, undefined, picks)).rejects.toMatchObject({ code: 'bad_request' });
    }
    expect(f.contacts.get(dana.email)!.merged_into).toBeUndefined();
    const { survivor } = await pair(DANA_W, dana.email, 'Dana Whitfield', {
      company: 'Acme', phone: '+15550001111', birthday: '1980-02-03', anniversary: '--07-08',
    });
    expect(survivor).toMatchObject({
      email: DANA_W, name: 'Dana Whitfield', company: 'Acme', phone: '+15550001111', birthday: '1980-02-03', anniversary: '--07-08',
    });
    expect(f.contacts.get(DANA_W)!.phone).toBe('+15550001111');
    // What the merge alone would have taken from Dana is the owner's pick, written then (a
    // company is asserted as the kind `org`); what it keeps of hers is hers still.
    const provenance = f.contacts.get(DANA_W)!.projection_provenance;
    expect(provenance?.org).toMatchObject({ source: 'manual', as_of: 2000 });
    expect(provenance?.birthday).toMatchObject({ source: 'manual', as_of: 2000 });
    expect(provenance?.anniversary).toMatchObject({ as_of: 1100 });
  });

  it('confirms a candidate the scan raised for the pair, keeping what found it', async () => {
    const f = fixture();
    f.contacts.upsertManual({ email: DANA_W, name: 'Dana Whitfield' });
    f.contacts.upsertManual({ email: 'dana@home.example.test', name: 'Dana Whitfield' });
    f.contacts.enqueueMergeCandidate({
      id: 'cand-scan', email_a: 'dana@home.example.test', email_b: DANA_W,
      matched_fields: ['name', 'phone'], detected_at: 1, detected_by: 'housekeeping',
    });
    const { pair } = mergeSlice(f);
    await pair(DANA_W, 'dana@home.example.test');
    expect(f.contacts.listMergeCandidates({ status: 'merged' }).candidates)
      .toMatchObject([{ id: 'cand-scan', detected_by: 'housekeeping' }]);
    expect(f.contacts.listMergeCandidates({ status: 'pending' }).candidates).toEqual([]);
  });

  it('is an owner rpc of its own, never an AI tool', () => {
    expect(SERVER_RPC_METHODS).toContain('contact.merge.pair');
    expect(mergeSlice(fixture()).slice.methods).toContain('contact.merge.pair');
    expect(isMcpToolName('contact.merge.pair')).toBe(false);
  });
});


describe('D-336 slice R — the owner changes a contact\'s saved email; the old one stays its second address', () => {
  const OLD = 'dana@work.example.test';
  const NEW = 'dana@home.example.test';
  const MANUAL = { origin_actor: 'user_self' as const, origin_surface: 'client_rpc' as const };
  /** The registered handlers, with the hook the server gives them recorded. */
  const changing = (hook?: (change: { contact_id: string; from_email: string; to_email: string }) => void) => {
    const f = fixture();
    const changes: Array<{ contact_id: string; from_email: string; to_email: string }> = [];
    const slice = makeContactHandlers({
      store: f.contacts, now: () => 3000,
      onEmailChanged: (change) => { changes.push(change); hook?.(change); },
    })!;
    const call = <T>(method: string, args: unknown) =>
      (slice.handlers as unknown as Record<string, (a: never, c: never) => Promise<T>>)[method](args as never, undefined as never);
    const change = (contact_id: string, email: string) => call<{ contact: ContactRecord }>('contact.change_email', { contact_id, email });
    const get = async (email: string) => call<{ contact: ContactRecord | null; identifiers?: { emails: string[] } }>('contact.get', { email });
    const dana = f.contacts.upsertManual({ email: OLD, name: 'Dana Whitfield', company: 'Acme' }, 1000, MANUAL);
    return { ...f, slice, call, change, get, changes, dana };
  };

  it('re-keys the contact onto the new address: the same contact, its fields kept, the old one its second address', async () => {
    const c = changing();
    const { contact } = await c.change(c.dana.contact_id!, '  Dana@Home.example.TEST ');
    expect(contact).toMatchObject({ contact_id: c.dana.contact_id, email: NEW, name: 'Dana Whitfield', company: 'Acme', identity_status: 'verified' });
    expect((await c.get(NEW)).identifiers?.emails).toEqual([OLD]);
    // A second mailbox reads its own row only, as slice I ruled: the page is found by the new one.
    expect((await c.get(OLD)).contact).toBeNull();
    expect(c.contacts.getByAnyEmail(OLD)).toMatchObject({ contact_id: c.dana.contact_id, email: NEW });
    expect(c.contacts.resolveCanonicalEmail(OLD).canonical_email).toBe(NEW);
    expect(c.changes).toEqual([{ contact_id: c.dana.contact_id, from_email: OLD, to_email: NEW }]);
    // The owner's change, and kept as the owner's: no source's teardown removes the old address.
    const old = c.contacts.listResolvedContactAliases(c.dana.contact_id!).find((row) => row.alias_pattern_normalized === OLD);
    expect(old).toMatchObject({ kind: 'email_alias', source: 'manual' });
  });

  it('mail from the old address still finds the contact, even once the source that found it is gone', async () => {
    const c = changing();
    // Found in mail first, so its own address came from that traffic.
    c.contacts.observeBatch([{ email: 'sam@example.test', name: 'Sam', source: 'email_from', event_at: 1000 }], 1000);
    const sam = c.contacts.get('sam@example.test')!;
    await c.change(sam.contact_id!, 'sam@new.example.test');
    c.contacts.deleteContactAliasesForSource('recued.derived');
    c.contacts.observeBatch([{ email: 'SAM@example.test', source: 'email_from', event_at: 5000 }], 5000);
    expect(c.contacts.list().map((row) => row.email).sort()).toEqual([OLD, 'sam@new.example.test']);
    expect(c.contacts.get('sam@new.example.test')!.last_interaction).toBe(5000);
  });

  it('a contact merged into it still resolves to it, with its history', async () => {
    const c = changing();
    const other = c.contacts.upsertManual({ email: 'd.whitfield@acme.example.test', name: 'D. Whitfield' }, 1000, MANUAL);
    c.contacts.setMergedInto([other], OLD, 1500);
    await c.change(c.dana.contact_id!, NEW);
    expect(c.contacts.resolveCanonicalEmail(other.email).canonical_email).toBe(NEW);
    expect(c.contacts.get(other.email)!.merged_into).toBe(NEW);
    expect(c.contacts.listMergedSourceEmails(NEW)).toEqual([other.email]);
  });

  it('its platform links move with it, and a linker still holding the old address links the contact', async () => {
    const c = changing();
    c.contacts.linkPlatformId({ canonical_email: OLD, vendor: 'hubspot', platform_id: '101', state: 'confirmed', linked_at: 1000, linked_by: 'test' });
    await c.change(c.dana.contact_id!, NEW);
    expect(c.contacts.lookupPlatformLink('hubspot', '101')).toBe(NEW);
    expect(c.contacts.get(NEW)!.platform_ids?.map((link) => link.platform_id)).toEqual(['101']);
    c.contacts.linkPlatformId({ canonical_email: OLD, vendor: 'hubspot', platform_id: '102', state: 'auto', linked_at: 4000, linked_by: 'test' });
    expect(c.contacts.lookupPlatformLink('hubspot', '102')).toBe(NEW);
    expect(c.contacts.get(NEW)!.platform_ids?.map((link) => link.platform_id).sort()).toEqual(['101', '102']);
  });

  it('a pair the owner said is not one person stays said, and merge candidates follow it', async () => {
    const c = changing();
    const sam = c.contacts.upsertManual({ email: 'sam@example.test', name: 'Sam' }, 1000, MANUAL);
    const zoe = c.contacts.upsertManual({ email: 'zoe@example.test', name: 'Zoe' }, 1000, MANUAL);
    c.contacts.addRejection({ email_a: OLD, email_b: sam.email, rejected_at: 1200 });
    c.contacts.enqueueMergeCandidate({ id: 'cand-zoe', email_a: OLD, email_b: zoe.email, matched_fields: ['name'], detected_at: 1300, detected_by: 'housekeeping' });
    await c.change(c.dana.contact_id!, NEW);
    expect(c.contacts.isPairRejected(NEW, sam.email)).toBe(true);
    expect(c.contacts.isPairRejected(OLD, sam.email)).toBe(false);
    expect(c.contacts.get(NEW)!.rejected_pairs).toEqual([sam.email]);
    expect(c.contacts.get(sam.email)!.rejected_pairs).toEqual([NEW]);
    expect(c.contacts.getMergeCandidate('cand-zoe')).toMatchObject({ email_a: NEW, email_b: zoe.email, status: 'pending' });
  });

  it('one of its second addresses can become its first, and the address it has again is the contact as it is', async () => {
    const c = changing();
    c.contacts.upsertContactAlias({ contact_id: c.dana.contact_id!, kind: 'email_alias', alias_pattern: NEW, source: 'manual' });
    const { contact } = await c.change(c.dana.contact_id!, NEW);
    expect(contact.email).toBe(NEW);
    expect((await c.get(NEW)).identifiers?.emails).toEqual([OLD]);
    expect((await c.change(c.dana.contact_id!, 'DANA@home.example.test')).contact).toMatchObject({ email: NEW });
    expect(c.changes).toHaveLength(1);
  });

  it('⛔ refuses an address another contact has, naming them, and changes nothing', async () => {
    const c = changing();
    c.contacts.upsertManual({ email: NEW, name: 'Dana W.' }, 1000, MANUAL);
    await expect(c.change(c.dana.contact_id!, NEW)).rejects.toMatchObject({
      code: 'conflict', message: `“${NEW}” is already Dana W.'s address.`,
      details: { reason: 'address_taken', contact_email: NEW, contact_name: 'Dana W.' },
    });
    // As its second address too.
    const sam = c.contacts.upsertManual({ email: 'sam@example.test', name: 'Sam' }, 1000, MANUAL);
    c.contacts.upsertContactAlias({ contact_id: sam.contact_id!, kind: 'email_alias', alias_pattern: 'sam@home.example.test', source: 'manual' });
    await expect(c.change(c.dana.contact_id!, 'sam@home.example.test')).rejects.toMatchObject({
      code: 'conflict', details: { reason: 'address_taken', contact_email: sam.email, contact_name: 'Sam' },
    });
    expect(c.contacts.get(OLD)).toMatchObject({ contact_id: c.dana.contact_id });
    expect(c.changes).toEqual([]);
  });

  it('⛔ refuses a contact with no address, one gone or merged, and what is no address, in the owner\'s words', async () => {
    const c = changing();
    const mia = await c.named('Mia');
    await expect(c.change(mia.contact_id!, 'mia@example.test')).rejects.toMatchObject({
      code: 'conflict', message: 'This contact has no email address yet. Add one instead.',
    });
    await expect(c.change('no-such-contact', NEW)).rejects.toMatchObject({ code: 'not_found', message: 'This contact is no longer there.' });
    await expect(c.change(c.dana.contact_id!, 'Dana <dana@home.example.test>')).rejects.toMatchObject({
      code: 'bad_request', message: 'Write the email address alone, like dana@example.com.',
    });
    await expect(c.change(c.dana.contact_id!, '   ')).rejects.toMatchObject({ code: 'bad_request', message: 'Write the email address first.' });
    const sam = c.contacts.upsertManual({ email: 'sam@example.test', name: 'Sam' }, 1000, MANUAL);
    c.contacts.setMergedInto([sam], OLD, 1500);
    await expect(c.change(sam.contact_id!, 'sam@new.example.test')).rejects.toMatchObject({
      code: 'conflict', message: 'This contact was merged into another. Change the address there.',
    });
    expect(c.changes).toEqual([]);
  });

  it('a hook that fails does not undo the change', async () => {
    const c = changing(() => { throw new Error('annotation store went away'); });
    const { contact } = await c.change(c.dana.contact_id!, NEW);
    expect(contact.email).toBe(NEW);
    expect(c.contacts.get(NEW)).toMatchObject({ contact_id: c.dana.contact_id });
  });

  it('a first address given carries the same: a contact merged into one with no address still resolves', async () => {
    const c = changing();
    const mia = await c.named('Mia');
    const again = await c.named('Mia W.');
    c.contacts.setMergedInto([again], mia.email, 1500);
    c.contacts.linkPlatformId({ canonical_email: mia.email, vendor: 'telegram', platform_id: '42', state: 'auto', linked_at: 1000, linked_by: 'test' });
    await c.addEmail(mia.contact_id!, 'mia@example.test');
    expect(c.contacts.resolveCanonicalEmail(again.email).canonical_email).toBe('mia@example.test');
    expect(c.contacts.lookupPlatformLink('telegram', '42')).toBe('mia@example.test');
  });

  it('a re-merge prompt fired before the change re-queues the pair under the address the contact has', async () => {
    const c = changing();
    const sam = c.contacts.upsertManual({ email: 'sam@example.test', name: 'Sam' }, 1000, MANUAL);
    const prompts = createRemergePromptStore(c.db);
    prompts.record({ id: 'prompt-1', affected_email: OLD, partner_email: sam.email, vendor: 'hubspot', fired_at: 1500 });
    c.contacts.addRejection({ email_a: OLD, email_b: sam.email, rejected_at: 1200 });
    await c.change(c.dana.contact_id!, NEW);
    const merge = makeContactMergeHandlers({ contactStore: c.contacts, promptStore: prompts, now: () => 4000, newId: () => 'cand-remerge' })!;
    const answer = await (merge.handlers as unknown as Record<string, (a: never, ctx: never) => Promise<unknown>>)
      ['contact.merge.resolve_remerge_prompt']({ prompt_id: 'prompt-1', resolution: 'remerge' } as never, undefined as never);
    expect(answer).toEqual({ result: 'queued_merge_candidate' });
    expect(c.contacts.isPairRejected(NEW, sam.email)).toBe(false);
    expect(c.contacts.getMergeCandidate('cand-remerge')).toMatchObject({ status: 'pending', email_a: NEW, email_b: sam.email });
  });

  it('is an owner rpc of its own, never an AI tool', () => {
    expect(SERVER_RPC_METHODS).toContain('contact.change_email');
    expect(changing().slice.methods).toContain('contact.change_email');
    expect(isMcpToolName('contact.change_email')).toBe(false);
  });
});
