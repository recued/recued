/** D-336 slice H — the picker makes the contact (§3.6). Where a relationship's "Link to a
 *  contact" finds nobody, the owner adds the name as a contact (`contact.create_by_name`): a
 *  mention-only contact, the owner's own, which the relationship then links. Through the
 *  registered handler, so the origin is the one the server injects, never the call's. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MEMORY_CLAIM_PART_MAX,
  SERVER_RPC_METHODS,
  isMentionOnlyEmail,
  isMcpToolName,
  type ChatPlanProposal,
  type MemoryClaim,
} from '@recued/contracts';
import { createInMemoryCollection, type AuditLogStore } from '@recued/storage';
import { planApproval } from '@recued/gateway';

import { makeContactHandlers, handleContactContributions } from '../contact-handler.js';
import { createContactStore, isMentionOnlyEmail as storeIsMentionOnlyEmail } from '../storage/contact-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createUserMemoryStore, USER_MEMORY_ID_PREFIX, type UserMemoryRow } from '../user-memory-store.js';
import { handleMemoryClaims, handleMemoryCreate, type MemoryRedactionRecord, type MemoryRpcDeps } from '../memory-rpc-handler.js';
import { claimContactEmails, ownerClaim, ownerClaimRecords } from '../memory-claim.js';
import { readHeldPlanEdit } from '../chat-plan-edits.js';
import type { BlobStore } from '../storage/blob-store.js';

const disposals: Array<() => void> = [];
afterEach(() => { while (disposals.length > 0) disposals.pop()!(); });

const fixture = () => {
  const db = new Database(':memory:');
  disposals.push(() => db.close());
  const contacts = createContactStore(db);
  const slice = makeContactHandlers({ store: contacts, now: () => 1000 })!;
  const create = (args: unknown) => slice.handlers['contact.create_by_name'](args as never, undefined as never);
  return { db, contacts, slice, create };
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

describe('contact.create_by_name — the owner adds a contact from a name alone', () => {
  it('adds a mention-only contact, the owner\'s own, its name at their rank, keyed on a placeholder', async () => {
    const f = fixture();
    const { contact } = await f.create({ name: '  Mia  ' });
    expect(contact).toMatchObject({ name: 'Mia', identity_status: 'mention_only', origin_actor: 'user_self', origin_surface: 'client_rpc' });
    expect(contact.contact_id).toBeTruthy();
    // The store's placeholder is the one contracts reads as no address: one test, both ends.
    expect(isMentionOnlyEmail(contact.email)).toBe(true);
    expect(storeIsMentionOnlyEmail).toBe(isMentionOnlyEmail);
    const { contributions } = await handleContactContributions({ store: f.contacts }, { email: contact.email });
    expect(contributions.find((c) => c.kind === 'name')).toMatchObject({ value: 'Mia', source: 'manual' });
    expect(f.contacts.getByContactId(contact.contact_id!)?.name).toBe('Mia');
  });

  it('⛔ takes no origin from the call', async () => {
    const f = fixture();
    const { contact } = await f.create({ name: 'Mia', origin_actor: 'contracted_user', origin_contract_id: 'door-a', origin_surface: 'engine' });
    expect(contact).toMatchObject({ origin_actor: 'user_self', origin_surface: 'client_rpc' });
    expect(contact.origin_contract_id ?? null).toBeNull();
  });

  it('never merges a name into a contact already there: the same name twice is two contacts', async () => {
    const f = fixture();
    f.contacts.upsertManual({ email: 'mia.whitfield@example.test', name: 'Mia' });
    const first = (await f.create({ name: 'Mia' })).contact;
    const second = (await f.create({ name: 'Mia' })).contact;
    expect(new Set([first.contact_id, second.contact_id]).size).toBe(2);
    expect(f.contacts.list({ name_contains: 'Mia' }).length).toBe(3);
  });

  it('⛔ refuses an empty name or one longer than a relationship\'s part, in the owner\'s words, and adds nothing', async () => {
    const f = fixture();
    await expect(f.create({ name: '   ' })).rejects.toMatchObject({ code: 'bad_request', message: 'Write the name first.' });
    await expect(f.create({})).rejects.toMatchObject({ code: 'bad_request' });
    await expect(f.create({ name: 'x'.repeat(MEMORY_CLAIM_PART_MAX + 1) }))
      .rejects.toMatchObject({ code: 'bad_request', message: `A name can be at most ${MEMORY_CLAIM_PART_MAX} characters.` });
    expect((await f.create({ name: 'x'.repeat(MEMORY_CLAIM_PART_MAX) })).contact.name).toHaveLength(MEMORY_CLAIM_PART_MAX);
    expect(f.contacts.list({}).length).toBe(1);
  });

  it('is a paired client\'s rpc of its own, never an AI tool', () => {
    expect(SERVER_RPC_METHODS).toContain('contact.create_by_name');
    expect(fixture().slice.methods).toContain('contact.create_by_name');
    expect(isMcpToolName('contact.create_by_name')).toBe(false);
  });
});

describe('the contact it adds is linked by the relationship, on the Memory form and the card', () => {
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

  it("links the new contact on the owner's form, and the contact's page lists the note", async () => {
    const f = fixture();
    const mia = (await f.create({ name: 'Mia' })).contact;
    const deps = memoryDeps(f.contacts, f.db);
    const claim: MemoryClaim = { subject: { contact_id: mia.contact_id!, name: 'Mia' }, relation: 'daughter of', object: { text: 'Dana' } };
    expect(ownerClaim(claim, ownerClaimRecords({ contacts: f.contacts }))).toMatchObject({ ok: true, value: claim });
    const made = await handleMemoryCreate(deps, { kind: 'note', summary: "Mia is Dana's daughter", claim });
    // As any linked contact does, it links the note to her by her key, here the placeholder.
    expect(claimContactEmails(claim, ownerClaimRecords({ contacts: f.contacts }))).toEqual([mia.email]);
    expect(made.provenance_edges_written).toBe(1);
    const listed = await handleMemoryClaims(deps, { contact: mia.contact_id! });
    expect(listed.claims.map((n) => n.memory_id)).toEqual([made.memory_id]);
  });

  it('a held save\'s card takes the new contact as the owner\'s change', async () => {
    const f = fixture();
    const mia = (await f.create({ name: 'Mia' })).contact;
    const args = { summary: "Mia is Dana's daughter", claim: { subject: 'Mia', relation: 'daughter of', object: 'Dana' } };
    const plan: ChatPlanProposal = {
      plan_id: 'plan-1', session_id: 's', turn_id: 't', tool: 'memory.write', tier: 1, classification: 'write',
      args, args_hash: planApproval.computePlanArgsHash(args), status: 'proposed', created_at: 1, hold: { run_id: 'run-1' },
    };
    const linked = { subject: { contact_id: mia.contact_id!, name: 'Mia' }, relation: 'daughter of', object: { text: 'Dana' } };
    expect(readHeldPlanEdit(plan, { claim: linked }, ownerClaimRecords({ contacts: f.contacts }))).toMatchObject({
      overrides: { claim: linked }, args: { summary: args.summary, claim: linked },
    });
  });
});
