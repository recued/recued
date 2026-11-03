/** D-336 slice A — a saved fact names its relation, so one fact is one key in any wording.
 *
 *  Driven through the real chat tool handlers and owner rpc handlers over real stores: the
 *  memory pool on SQLite (so `claim_key`'s index is the one that ships), and the contacts
 *  and things the owner keeps. What is pinned:
 *    - `memory.relations` lists the groups, or one group's relations with how to write them;
 *    - `memory.write` stores a claim and its key beside the summary, and one fact said three
 *      ways (reworded, in Chinese) is one key;
 *    - the check: a relation the list lacks, an end of the wrong kind, a part too long and a
 *      linked end that names no record, or one the caller may not read, each refuse the
 *      save, before the owner is asked too;
 *    - a contact end keys by the contact's id and links the note to the contact;
 *    - the owner's feed and detail show the claim; Delete erases it with the text; a hidden
 *      note shows none;
 *    - import brings a claim in, keeping a linked end whose record is here. */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MEMORY_RELATION_INDEX,
  memoryClaimKey,
  tier1CallDetails,
  type ChatDispatchContext,
  type ChatDispatchResult,
  type ChatMessage,
  type ExecutionSource,
  type MemoryClaim,
} from '@recued/contracts';
import { createInMemoryCollection, type AuditLogStore } from '@recued/storage';
import { planApproval } from '@recued/gateway';

import type { BlobStore } from '../storage/blob-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createUserMemoryStore, USER_MEMORY_ID_PREFIX, type UserMemoryRow } from '../user-memory-store.js';
import {
  buildChatTier1Handlers,
  buildChatToolRegistryInputs,
  memoryAskLabels,
  type ChatToolHandlerDeps,
} from '../chat-tool-handlers.js';
import {
  handleMemoryDelete,
  handleMemoryGet,
  handleMemoryClaimCounts,
  handleMemoryClaims,
  handleMemoryCreate,
  handleMemoryImport,
  handleMemoryList,
  handleMemoryReplace,
  handleMemoryRevoke,
  handleMemorySaves,
  handleMemoryUpdate,
  type MemoryRedactionRecord,
  type MemoryRpcDeps,
} from '../memory-rpc-handler.js';
import { claimContactEmails, claimKeyOfCall, contactClaimEnds, ownerClaimRecords } from '../memory-claim.js';
import type { WaitingTier1Call } from '../raw-op-dispatch.js';
import { savesInMessages, savesOnCards, type ChatSavesReader } from '../memory-save-count.js';
import { readHeldPlanEdit } from '../chat-plan-edits.js';
import { renderToolRow } from '../chat-tool-row.js';
import { stripSourceComments } from './helpers/source-guards.js';
import { createContactStore } from '../storage/contact-store.js';
import { createReadGrantChecker } from '../read-grant-checker.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';

// ── fixtures ────────────────────────────────────────────────────────

const disposals: Array<() => void> = [];
afterEach(() => { disposals.splice(0).forEach((close) => close()); });

const fakeBlobs = (): BlobStore => {
  const map = new Map<string, Buffer>();
  return {
    root: '/fake',
    async put(data) {
      const hash = createHash('sha256').update(data).digest('hex');
      map.set(hash, Buffer.from(data));
      return hash;
    },
    async get(h) { return map.get(h) ?? null; },
    async has(h) { return map.has(h); },
    async delete(h) { map.delete(h); },
    async sizeOf(h) { return map.get(h)?.length ?? null; },
    async sweepOrphans() { return 0; },
    async totalBytes() { return 0; },
  };
};

const ownerChat: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 'sess-1', user_id: 'local' };
const door: ExecutionSource = {
  channel: 'mcp', actor: 'contracted_user', agent_id: 'agent-1', tool_call_id: 'tc-1', mcp_token_id: 'tok-1', contract_id: 'door-a',
};
const ctx = (execution_source: ExecutionSource = ownerChat, session_id = 'sess-1'): ChatDispatchContext => ({
  channel: 'internal_function_call', session_id, turn_id: 'turn-1', execution_source,
});

const fixture = (opts: {
  grant?: boolean;
  contactsReadable?: boolean;
  granted?: (op: string) => boolean;
  /** D-336 slice O — the held saves still waiting, and the owner's lookups, as the server wires them. */
  waiting?: () => readonly WaitingTier1Call[];
} = {}) => {
  const db = new Database(':memory:');
  disposals.push(() => db.close());
  let seq = 0;
  let clock = 1000;
  const store = createUserMemoryStore(createSQLiteCollection<UserMemoryRow>(db, 'user_memory'), fakeBlobs(), {
    db, now: () => (clock += 10), mintId: () => `${USER_MEMORY_ID_PREFIX}${(seq += 1)}`,
    // As the server wires it: a claim's contact end is its merge group.
    sameClaimEnd: (end_key) => contactClaimEnds(contacts)(end_key),
  });
  const redactions = createInMemoryCollection<MemoryRedactionRecord>();
  const contacts = createContactStore(db);
  ensureWorkEntitySchema(db);
  const work = createWorkEntityStore(db);
  autoRegisterRecuedBuiltinSources(work);
  const contactsReadable = opts.contactsReadable ?? true;
  const checker = (contract: string | undefined) => createReadGrantChecker(
    { isGranted: (_id, entry, authorDefault) => (entry === 'data.contact' ? contactsReadable : authorDefault) },
    contract,
  );
  const deps: ChatToolHandlerDeps = {
    getContactStore: () => contacts,
    getCollectionRegistry: () => undefined,
    getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined,
    getRecipeStore: () => ({ ids: () => [], get: () => null, getStored: () => null, listStored: () => [] }) as never,
    getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
    getExecuteRecipe: () => undefined,
    getUserMemoryStore: () => store,
    getMemoryRedactionStore: () => redactions,
    getWorkEntityResolver: () => createWorkEntityResolver(work),
    getReadGrantResolver: () => ({ resolveForSource: () => checker('owner'), resolveForContract: (id: string) => checker(id) }) as never,
    getOpAdmissionGate: () => ({
      isFrozenByPause: () => false,
      isOpGranted: (_source, op) => (op !== undefined ? opts.granted?.(op) : undefined) ?? opts.grant ?? true,
      isOwnerGoverned: () => true,
      isOwnerRecipeGranted: () => false,
    }),
    now: () => 5000,
    ...(opts.waiting !== undefined
      ? {
          getWaitingCalls: async (tool: string) => (tool === 'memory.write' ? opts.waiting!() : []),
          getOwnerClaimRecords: () => ownerClaimRecords({ contacts, work }),
        }
      : {}),
  };
  const handlers = buildChatTier1Handlers(deps) as Record<string, (raw: unknown, c: ChatDispatchContext) => Promise<ChatDispatchResult>>;
  const rpcDeps: MemoryRpcDeps = {
    auditLog: { listWindow: async () => [], listRecent: async () => [], get: async () => null } as unknown as AuditLogStore,
    userMemoryStore: store,
    redactionStore: redactions,
    claimRecords: ownerClaimRecords({ contacts, work }),
    now: () => 6000,
  };
  return {
    db, deps, store, contacts, work, redactions, rpcDeps,
    call: (tool: string, args: unknown, source: ExecutionSource = ownerChat, session = 'sess-1') =>
      handlers[tool]!(args, ctx(source, session)),
    /** D-336 slice G — what a held save meets, as the registry asks it when it holds one. */
    notices: (args: unknown, source: ExecutionSource = ownerChat) =>
      buildChatToolRegistryInputs(deps).tier1AskNotices['memory.write'](args, ctx(source)),
    /** The D-329 check: a refusal, or `null` when the call would run. */
    check: async (args: unknown, source: ExecutionSource = ownerChat) =>
      buildChatToolRegistryInputs(deps).tier1Checks['memory.write'](args, ctx(source)) as Promise<ChatDispatchResult>,
  };
};

const okResult = <T = Record<string, unknown>>(r: ChatDispatchResult): T => {
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return (r as { result: T }).result;
};
const refusal = (r: ChatDispatchResult): string => {
  expect(r.ok, JSON.stringify(r)).toBe(false);
  return String((r as { detail?: unknown }).detail);
};
const DAUGHTER = { subject: 'Mia', relation: 'daughter of', object: 'Dana Whitfield' } as const;
const savedClaim = (summary: string, claim: unknown) => ({ summary, claim });

// ── the guide ───────────────────────────────────────────────────────

describe('memory.relations — the list a claim is written from', () => {
  it('lists the groups, a line each, and sends a birthday to the contact', async () => {
    const f = fixture();
    const listed = okResult<{ groups: Array<{ group: string; covers: string }>; note: string }>(await f.call('memory.relations', {}));
    expect(listed.groups.map((g) => g.group)).toEqual(['family', 'ties', 'work', 'services', 'places', 'names', 'things', 'preferences']);
    expect(listed.groups.every((g) => g.covers.length > 0)).toBe(true);
    expect(listed.note).toMatch(/birthday or an anniversary is not saved to memory/);
    expect(listed.note).toMatch(/contact/);
    // No arguments at all reads as no group.
    expect(okResult<{ groups: unknown[] }>(await f.call('memory.relations', undefined)).groups).toHaveLength(8);
  });

  it("lists one group's relations, which way round each is written, and how to fill a claim", async () => {
    const f = fixture();
    const family = okResult<{ group: string; relations: Array<Record<string, unknown>>; how: string }>(
      await f.call('memory.relations', { group: 'Family' }),
    );
    expect(family.group).toBe('family');
    expect(family.relations[0]).toEqual({
      relations: ['mother of', 'father of'], general: 'parent of', subject: 'person', object: 'person',
      example: '"Dana is Mia\'s mother": Dana, mother of, Mia',
    });
    expect(family.how).toMatch(/never turned round/);
    expect(family.how).toMatch(/"Dana's daughter is called Mia" is Mia, daughter of, Dana/);
    expect(family.how).toMatch(/"owner" for the user/);
    // ⛔ What to save stays memory.write's rule (owner, 2026-10-31): a lasting preference or
    // habit is saved, one for this conversation is not, and a figure only as its event.
    expect(family.how).toMatch(/a lasting preference or habit is worth saving \("Dana is vegetarian": Dana, avoids, meat\)/);
    expect(family.how).toMatch(/one for this conversation alone is not/);
    expect(family.how).toMatch(/a price, a rate or a deadline is saved only as the event that set it/);
    const names = okResult<{ relations: Array<{ note?: string }> }>(await f.call('memory.relations', { group: 'names' }));
    expect(names.relations[0]!.note).toMatch(/"Dana's daughter is called Mia" is Mia, daughter of, Dana/);
  });

  it('refuses a group the list lacks, naming the groups, and a caller that may not save', async () => {
    expect(refusal(await fixture().call('memory.relations', { group: 'pets' }))).toMatch(/family, ties, work/);
    const blocked = await fixture({ grant: false }).call('memory.relations', {});
    expect(blocked).toMatchObject({ ok: false, reason: 'classification_blocked' });
  });
});

// ── the claim on a save ─────────────────────────────────────────────

describe('memory.write — a claim beside the summary', () => {
  it('stores the claim and its key, and one fact said three ways is one key', async () => {
    const f = fixture();
    const wordings = [
      ["Dana Whitfield's daughter is called Mia", DAUGHTER],
      ["Mia is Dana Whitfield's daughter", { subject: ' mia ', relation: 'Daughter  of', object: 'dana whitfield' }],
      ['Dana Whitfield 的女儿叫 Mia', { subject: 'Mia', relation: 'daughter of', object: 'Dana  Whitfield' }],
    ] as const;
    const ids: string[] = [];
    for (const [summary, claim] of wordings) {
      ids.push(okResult<{ memory_id: string }>(await f.call('memory.write', savedClaim(summary, claim))).memory_id);
    }
    const rows = await Promise.all(ids.map(async (id) => (await f.store.getRow(id))!));
    expect(new Set(rows.map((r) => r.claim_key)).size).toBe(1);
    expect(rows[0]!.claim_key).toBe(JSON.stringify(['text:mia', 'daughter of', 'text:dana whitfield']));
    // Stored as written, the relation as the list spells it; the summaries stay as said.
    expect(rows[1]!.claim).toEqual({ subject: { text: 'mia' }, relation: 'daughter of', object: { text: 'dana whitfield' } });
    expect(rows.map((r) => r.summary)).toEqual(wordings.map(([summary]) => summary));
    // The key is indexed, and finds all three.
    expect((await f.store.listClaim(rows[0]!.claim_key!)).map((r) => r.memory_id).sort()).toEqual([...ids].sort());
    const indexes = f.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'user_memory'").all() as Array<{ sql: string | null }>;
    expect(indexes.some((i) => i.sql?.includes('claim_key') === true)).toBe(true);
  });

  it('keys two values apart: "called Maya" is not "called Mia"', async () => {
    const f = fixture();
    const a = okResult<{ memory_id: string }>(await f.call('memory.write', savedClaim('Margaret goes by Mia', { subject: 'Margaret', relation: 'called', object: 'Mia' })));
    const b = okResult<{ memory_id: string }>(await f.call('memory.write', savedClaim('Margaret goes by Maya', { subject: 'Margaret', relation: 'called', object: 'Maya' })));
    expect((await f.store.getRow(a.memory_id))!.claim_key).not.toBe((await f.store.getRow(b.memory_id))!.claim_key);
  });

  it('saves a note with no claim as before', async () => {
    const f = fixture();
    const saved = okResult<{ memory_id: string }>(await f.call('memory.write', { summary: 'The Dublin office moved to Pearse Street in March 2026' }));
    const row = (await f.store.getRow(saved.memory_id))!;
    expect(row.claim).toBeUndefined();
    expect(row.claim_key).toBeUndefined();
  });

  it('⛔ refuses a relation the list lacks, naming memory.relations, and writes nothing', async () => {
    const f = fixture();
    for (const relation of ['is', 'kid of', 'birthday of']) {
      const why = refusal(await f.call('memory.write', savedClaim("Mia is Dana's kid", { ...DAUGHTER, relation })));
      expect(why).toMatch(/is not a relation memory\.relations lists/);
      expect(why).toMatch(/save without a claim when none fits/);
    }
    expect(await f.store.list()).toEqual([]);
  });

  it('⛔ refuses an end of the wrong kind, a part too long, and a claim that is not one', async () => {
    const f = fixture();
    const refused = async (claim: unknown) => refusal(await f.call('memory.write', savedClaim('A fact', claim)));
    expect(await refused({ subject: { asset: 'a-1' }, relation: 'daughter of', object: 'Dana' })).toMatch(/subject of "daughter of" is a person, so it cannot be an asset/);
    expect(await refused({ subject: 'Mia', relation: 'owns', object: { contact: 'dana@example.test' } })).toMatch(/object of "owns" is a thing, so it cannot be a contact/);
    expect(await refused({ subject: 'Mia', relation: 'likes', object: 'owner' })).toMatch(/object of "likes" is words, so it cannot be the owner/);
    expect(await refused({ ...DAUGHTER, object: 'x'.repeat(201) })).toMatch(/longer than 200 characters/);
    expect(await refused({ ...DAUGHTER, object: '  ' })).toMatch(/object is empty/);
    expect(await refused({ ...DAUGHTER, object: { name: 'Dana' } })).toMatch(/must be a name or short phrase/);
    expect(await refused('Mia, daughter of, Dana')).toMatch(/claim must be an object/);
    expect(await refused({ subject: 'Mia', object: 'Dana' })).toMatch(/needs a relation/);
    expect(await f.store.list()).toEqual([]);
  });

  it('writes "my" as the owner', async () => {
    const f = fixture();
    const saved = okResult<{ memory_id: string }>(await f.call('memory.write', savedClaim('Mia is my daughter', { subject: 'Mia', relation: 'daughter of', object: 'Owner' })));
    const row = (await f.store.getRow(saved.memory_id))!;
    expect(row.claim?.object).toEqual({ owner: true });
    expect(row.claim_key).toBe(JSON.stringify(['text:mia', 'daughter of', 'owner']));
  });

  it('keys a contact end by its id, however the call names it, and links the note to the contact', async () => {
    const f = fixture();
    const dana = f.contacts.upsertManual({ email: 'dana@example.test', name: 'Dana Whitfield' });
    const byEmail = okResult<{ memory_id: string; provenance_edges_written: number }>(await f.call('memory.write',
      savedClaim("Mia is Dana Whitfield's daughter", { ...DAUGHTER, object: { contact: 'Dana@Example.test' } })));
    const byId = okResult<{ memory_id: string }>(await f.call('memory.write',
      savedClaim("Dana Whitfield's daughter is Mia", { ...DAUGHTER, object: { contact: dana.contact_id! } })));
    const first = (await f.store.getRow(byEmail.memory_id))!;
    expect(first.claim?.object).toEqual({ contact_id: dana.contact_id, name: 'Dana Whitfield' });
    expect(first.claim_key).toBe(JSON.stringify(['text:mia', 'daughter of', `contact:${dana.contact_id}`]));
    expect((await f.store.getRow(byId.memory_id))!.claim_key).toBe(first.claim_key);
    expect(first.provenance_entity_ids).toEqual(['dana@example.test']);
    expect(byEmail.provenance_edges_written).toBe(1);
  });

  it('⛔ refuses a contact that does not exist, and one the caller may not read', async () => {
    const f = fixture();
    expect(refusal(await f.call('memory.write', savedClaim('A fact', { ...DAUGHTER, object: { contact: 'nobody@example.test' } }))))
      .toMatch(/no contact has target_id 'nobody@example\.test'; find them with contact\.search/);
    const fenced = fixture({ contactsReadable: false });
    fenced.contacts.upsertManual({ email: 'dana@example.test', name: 'Dana Whitfield' });
    expect(refusal(await fenced.call('memory.write', savedClaim('A fact', { ...DAUGHTER, object: { contact: 'dana@example.test' } }), door)))
      .toMatch(/cannot read contacts, so the claim cannot link one/);
    expect(await f.store.list()).toEqual([]);
    expect(await fenced.store.list()).toEqual([]);
  });

  it('keys a thing end by the id work.read gives it, and refuses one that is not there', async () => {
    const f = fixture();
    const bike = f.work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, name: 'Blue bicycle' });
    const saved = okResult<{ memory_id: string }>(await f.call('memory.write',
      savedClaim('Mia owns the blue bicycle', { subject: 'Mia', relation: 'owns', object: { asset: bike.id } })));
    const claim = (await f.store.getRow(saved.memory_id))!.claim!;
    expect(claim.object).toMatchObject({ name: 'Blue bicycle' });
    expect((claim.object as { asset_id: string }).asset_id).toContain(bike.id);
    expect(refusal(await f.call('memory.write', savedClaim('Mia owns a kite', { subject: 'Mia', relation: 'owns', object: { asset: 'no-such-thing' } }))))
      .toMatch(/owns no thing with id 'no-such-thing'; find it with work\.search/);
  });

  it('⛔ the check before the owner is asked refuses what the save refuses, and writes nothing', async () => {
    const f = fixture();
    expect(refusal(await f.check(savedClaim("Mia is Dana's kid", { ...DAUGHTER, relation: 'kid of' })))).toMatch(/memory\.relations lists/);
    expect(refusal(await f.check(savedClaim('A fact', { ...DAUGHTER, object: { contact: 'nobody@example.test' } })))).toMatch(/no contact/);
    // `null`: nothing refuses it, so the owner is asked.
    expect(await f.check(savedClaim("Mia is Dana Whitfield's daughter", DAUGHTER))).toBeNull();
    expect(await f.store.list()).toEqual([]);
  });

  it("shows the owner the claim on the card as one line, a contact by its name", async () => {
    const f = fixture();
    f.contacts.upsertManual({ email: 'dana@example.test', name: 'Dana Whitfield' });
    const args = savedClaim("Mia is Dana Whitfield's daughter", { ...DAUGHTER, object: { contact: 'dana@example.test' } });
    const labels = await memoryAskLabels(f.deps, args, ctx());
    expect(labels).toEqual({ claim: { 'dana@example.test': 'Dana Whitfield' } });
    expect(tier1CallDetails('memory.write', args, labels).args).toEqual({
      summary: "Mia is Dana Whitfield's daughter", relationship: 'Mia, daughter of, Dana Whitfield',
    });
    expect(tier1CallDetails('memory.write', savedClaim('Mia is my daughter', { ...DAUGHTER, object: 'owner' })).args.relationship)
      .toBe('Mia, daughter of, you');
  });
});

// ── the owner's reads, Delete and import ────────────────────────────

describe("the claim in the owner's feed, through Delete, and in and out of a file", () => {
  it('shows on the feed and the detail, and is gone with the text when the owner deletes the note', async () => {
    const f = fixture();
    const saved = okResult<{ memory_id: string }>(await f.call('memory.write', savedClaim("Dana Whitfield's daughter is called Mia", DAUGHTER)));
    const stored: MemoryClaim = { subject: { text: 'Mia' }, relation: 'daughter of', object: { text: 'Dana Whitfield' } };
    const key = memoryClaimKey(stored);
    expect((await handleMemoryList(f.rpcDeps, {})).entries[0]?.claim).toEqual(stored);
    expect((await handleMemoryGet(f.rpcDeps, { memory_id: saved.memory_id })).claim).toEqual(stored);

    await handleMemoryDelete(f.rpcDeps, { memory_id: saved.memory_id });
    const row = (await f.store.getRow(saved.memory_id))!;
    expect(row.claim).toBeUndefined();
    expect(row.claim_key).toBeUndefined();
    expect(await f.store.listClaim(key)).toEqual([]);
    expect((await handleMemoryList(f.rpcDeps, {})).entries[0]?.claim).toBeUndefined();
  });

  it('shows no claim on a note the owner hid', async () => {
    const f = fixture();
    const saved = okResult<{ memory_id: string }>(await f.call('memory.write', savedClaim("Dana Whitfield's daughter is called Mia", DAUGHTER)));
    await f.redactions.set(saved.memory_id, { memory_id: saved.memory_id, redacted_at: 6000 } as MemoryRedactionRecord);
    expect((await handleMemoryList(f.rpcDeps, {})).entries[0]).toMatchObject({ redacted: true });
    expect((await handleMemoryList(f.rpcDeps, {})).entries[0]?.claim).toBeUndefined();
    expect((await handleMemoryGet(f.rpcDeps, { memory_id: saved.memory_id })).claim).toBeUndefined();
  });

  it('round-trips through export and import: the same key, a linked end kept where its record is', async () => {
    const f = fixture();
    const dana = f.contacts.upsertManual({ email: 'dana@example.test', name: 'Dana Whitfield' });
    await f.call('memory.write', savedClaim("Mia is Dana Whitfield's daughter", { ...DAUGHTER, object: { contact: 'dana@example.test' } }));
    // What the Memory view's export writes from the feed (`exportMemory`).
    const entries = (await handleMemoryList(f.rpcDeps, {})).entries.map((row) => ({
      memory_id: row.memory_id, origin_actor: row.origin_actor, kind: row.kind, ts: row.ts,
      ...(row.summary !== undefined ? { summary: row.summary } : {}),
      ...(row.claim !== undefined ? { claim: row.claim } : {}),
    }));
    const keyed = (await f.store.list())[0]!.claim_key;

    // The same server, its pool restored: the contact is here, so the end keeps it.
    const restored = fixture();
    await handleMemoryImport({ ...restored.rpcDeps, claimRecords: ownerClaimRecords({ contacts: f.contacts }) }, { entries });
    const kept = (await restored.store.list())[0]!;
    expect(kept.claim?.object).toEqual({ contact_id: dana.contact_id, name: 'Dana Whitfield' });
    expect(kept.claim_key).toBe(keyed);

    // Another server, where Dana is no contact: the end becomes her name.
    const elsewhere = fixture();
    await handleMemoryImport(elsewhere.rpcDeps, { entries });
    const named = (await elsewhere.store.list())[0]!;
    expect(named.claim).toEqual({ subject: { text: 'Mia' }, relation: 'daughter of', object: { text: 'Dana Whitfield' } });
    expect(named.claim_key).toBe(JSON.stringify(['text:mia', 'daughter of', 'text:dana whitfield']));
  });

  /** Audit 2026-10-31 — an import matched a note by its words alone, so two notes in the same
   *  words about two different people came back as one, the second relationship dropped. */
  it('restores two notes in the same words about two different contacts as two, and adds nothing on a second import', async () => {
    const f = fixture();
    const alder = f.contacts.upsertManual({ email: 'sam.alder@example.test', name: 'Sam' });
    const birch = f.contacts.upsertManual({ email: 'sam.birch@example.test', name: 'Sam' });
    const likes = (contact_id: string): MemoryClaim =>
      ({ subject: { contact_id, name: 'Sam' }, relation: 'likes', object: { text: 'cycling' } });
    const note = (claim?: MemoryClaim) => ({ origin_actor: 'contracted_user' as const, kind: 'chat_memory',
      summary: 'Sam likes cycling', ...(claim !== undefined ? { claim } : {}) });
    const entries = [note(likes(alder.contact_id!)), note(likes(birch.contact_id!))];

    expect(await handleMemoryImport(f.rpcDeps, { entries })).toMatchObject({ inserted: 2, deduped: 0 });
    expect((await f.store.list()).map((r) => r.claim_key).sort()).toEqual([
      memoryClaimKey(likes(alder.contact_id!)), memoryClaimKey(likes(birch.contact_id!)),
    ].sort());
    // The same file again, and the same note from a file saved before it had a claim.
    expect(await handleMemoryImport(f.rpcDeps, { entries })).toMatchObject({ inserted: 0, deduped: 2 });
    expect(await handleMemoryImport(f.rpcDeps, { entries: [note()] })).toMatchObject({ inserted: 0, deduped: 1 });
    expect(await f.store.list()).toHaveLength(2);
  });

  it("keeps an owner's own relation as written, and leaves out a claim that is not one, never the note", async () => {
    const f = fixture();
    const bike = f.work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, name: 'Blue bicycle' });
    const result = await handleMemoryImport(f.rpcDeps, { entries: [
      { origin_actor: 'contracted_user', kind: 'chat_memory', summary: "Lena is my cousin Sara's boyfriend's mother",
        claim: { subject: { text: 'Lena' }, relation: 'mother of my cousin’s boyfriend', object: { text: 'cousin Sara' } } },
      { origin_actor: 'contracted_user', kind: 'chat_memory', summary: 'Mia is Dana’s daughter',
        claim: { subject: { text: 'Mia' }, relation: 'daughter of' } as unknown as MemoryClaim },
      { origin_actor: 'contracted_user', kind: 'chat_memory', summary: 'Rex is a dog',
        claim: { subject: { contact_id: 'c-1', name: 'Rex' }, relation: 'owns', object: { text: 'a ball' } } },
      { origin_actor: 'contracted_user', kind: 'chat_memory', summary: 'The bicycle is a daughter',
        claim: { subject: { asset_id: bike.id, name: 'Blue bicycle' }, relation: 'daughter of', object: { text: 'Dana' } } },
    ] });
    expect(result).toMatchObject({ inserted: 4, skipped: 0 });
    const bySummary = new Map((await f.store.list()).map((r) => [r.summary, r]));
    expect(bySummary.get("Lena is my cousin Sara's boyfriend's mother")?.claim?.relation).toBe('mother of my cousin’s boyfriend');
    expect(bySummary.get('Mia is Dana’s daughter')?.claim).toBeUndefined();
    // A contact that is not here became its name, which fits any end.
    expect(bySummary.get('Rex is a dog')?.claim?.subject).toEqual({ text: 'Rex' });
    // A thing that is here kept its record, which cannot stand where a person goes.
    expect(bySummary.get('The bicycle is a daughter')?.claim).toBeUndefined();
    expect(bySummary.get('The bicycle is a daughter')?.summary).toBe('The bicycle is a daughter');
  });
});

// ── slice B: an equal key is the same claim ─────────────────────────

describe('slice B — an equal claim key is the same claim, in any wording or language', () => {
  const ENGLISH = "Dana Whitfield's daughter is called Mia";
  const CHINESE = 'Dana Whitfield 的女儿叫 Mia';
  const REWORDED = "Mia is Dana Whitfield's daughter";
  const saveIn = async (f: ReturnType<typeof fixture>, chat: string, summary: string, claim?: unknown) =>
    okResult<{ memory_id: string }>(await f.call('memory.write', { summary, ...(claim !== undefined ? { claim } : {}) }, ownerChat, chat)).memory_id;
  /** What each chat records of its saves, read back as `createChatSavesReader` reads a
   *  chat's call rows: the arguments `memory.write` ran with. */
  const recorded = (calls: Record<string, Array<{ summary: string; claim?: unknown }>>): ChatSavesReader => async (ids) =>
    new Map(ids.filter((id) => id in calls).map((id) => [id, savesInMessages(calls[id]!.map((args, i) => ({
      id: `${id}-${i}`, session_id: id, role: 'tool', content: renderToolRow('memory.write', args, undefined),
      tool_call: { message_id: `${id}-${i}`, session_id: id, turn_id: 't', tool_name: 'memory.write', state: 'succeeded', started_at: 1, updated_at: 2 },
    }) as unknown as ChatMessage))]));

  it('refuses a save whose claim the owner revoked, said in Chinese, which the words cannot match', async () => {
    const words = fixture();
    const revoked = await saveIn(words, 'c0', ENGLISH, DAUGHTER);
    await handleMemoryRevoke(words.rpcDeps, { memory_id: revoked });
    // With no claim, the words are all the match has, and they cannot read Chinese.
    okResult(await words.call('memory.write', { summary: CHINESE }, ownerChat, 'c1'));

    const keyed = fixture();
    const first = await saveIn(keyed, 'c0', ENGLISH, DAUGHTER);
    await handleMemoryRevoke(keyed.rpcDeps, { memory_id: first });
    const why = refusal(await keyed.call('memory.write', { summary: CHINESE, claim: DAUGHTER }, ownerChat, 'c1'));
    expect(why).toMatch(new RegExp(`the owner marked a memory like this wrong on .*: "${ENGLISH}" \\('${first}'\\)`));
    expect(why).toMatch(/call memory\.write again with despite_revoked/);
    // The check before the owner is asked refuses it too.
    expect(refusal(await keyed.check({ summary: CHINESE, claim: DAUGHTER }))).toMatch(/marked a memory like this wrong/);
    expect((await keyed.store.list()).map((r) => r.memory_id)).toEqual([first]);
  });

  it('is not the revoked claim with another value, and a removed revoke matches nothing', async () => {
    const f = fixture();
    const revoked = await saveIn(f, 'c0', ENGLISH, DAUGHTER);
    await handleMemoryRevoke(f.rpcDeps, { memory_id: revoked });
    okResult(await f.call('memory.write', { summary: 'Dana Whitfield 的女儿叫 Maya', claim: { ...DAUGHTER, subject: 'Maya' } }, ownerChat, 'c1'));
    // The other way round is another key, and these words share too little to match.
    okResult(await f.call('memory.write', { summary: 'Dana Whitfield 是 Mia 的母亲', claim: { subject: 'Dana Whitfield', relation: 'mother of', object: 'Mia' } }, ownerChat, 'c2'));
  });

  it('matches a linked contact by its record, however the save names her', async () => {
    const f = fixture();
    const dana = f.contacts.upsertManual({ email: 'dana@example.test', name: 'Dana Whitfield' });
    const revoked = await saveIn(f, 'c0', ENGLISH, { ...DAUGHTER, object: { contact: 'dana@example.test' } });
    await handleMemoryRevoke(f.rpcDeps, { memory_id: revoked });
    expect(refusal(await f.call('memory.write', { summary: CHINESE, claim: { ...DAUGHTER, object: { contact: dana.contact_id! } } }, ownerChat, 'c1')))
      .toMatch(/marked a memory like this wrong/);
  });

  it("counts a deleted save in another language, its claim read back from the chat that saved it", async () => {
    const f = fixture();
    const english = await saveIn(f, 'c0', ENGLISH, DAUGHTER);
    await handleMemoryDelete(f.rpcDeps, { memory_id: english });
    const chinese = await saveIn(f, 'c1', CHINESE, DAUGHTER);
    await handleMemoryDelete(f.rpcDeps, { memory_id: chinese });
    const note = await saveIn(f, 'c2', REWORDED, DAUGHTER);
    const chats = { c0: [{ summary: ENGLISH, claim: DAUGHTER }], c1: [{ summary: CHINESE, claim: DAUGHTER }], c2: [{ summary: REWORDED, claim: DAUGHTER }] };
    expect(await handleMemorySaves({ ...f.rpcDeps, readChatSaves: recorded(chats) }, { memory_id: note }))
      .toEqual({ memory_id: note, saves: 3, agents: 1 });
    // The same saves with no claims: the English one matches by its words, the Chinese one cannot.
    const unclaimed = { c0: [{ summary: ENGLISH }], c1: [{ summary: CHINESE }], c2: [{ summary: REWORDED }] };
    expect((await handleMemorySaves({ ...f.rpcDeps, readChatSaves: recorded(unclaimed) }, { memory_id: note })).saves).toBe(2);
  });

  it('counts a removed note still holding its claim, and a deleted save that linked the contact by email', async () => {
    const f = fixture();
    f.contacts.upsertManual({ email: 'dana@example.test', name: 'Dana Whitfield' });
    const linked = { ...DAUGHTER, object: { contact: 'dana@example.test' } };
    const hidden = await saveIn(f, 'c0', CHINESE, linked);
    await f.redactions.set(hidden, { memory_id: hidden, redacted_at: 1 } as MemoryRedactionRecord);
    const deleted = await saveIn(f, 'c1', 'Dana Whitfield 有一个女儿叫 Mia', linked);
    await handleMemoryDelete(f.rpcDeps, { memory_id: deleted });
    const note = await saveIn(f, 'c2', REWORDED, linked);
    const chats = recorded({ c1: [{ summary: 'Dana Whitfield 有一个女儿叫 Mia', claim: linked }] });
    expect((await handleMemorySaves({ ...f.rpcDeps, readChatSaves: chats }, { memory_id: note })).saves).toBe(3);
    // Without this server's contacts the deleted save's end cannot be keyed: its words alone, then.
    const { claimRecords: _dropped, ...noRecords } = f.rpcDeps;
    expect((await handleMemorySaves({ ...noRecords, readChatSaves: chats }, { memory_id: note })).saves).toBe(2);
  });

  it("works a call's claim key out again as the save made it, or gives none", () => {
    const f = fixture();
    const dana = f.contacts.upsertManual({ email: 'dana@example.test', name: 'Dana Whitfield' });
    const records = ownerClaimRecords({ contacts: f.contacts, work: f.work });
    expect(claimKeyOfCall(DAUGHTER)).toBe(JSON.stringify(['text:mia', 'daughter of', 'text:dana whitfield']));
    expect(claimKeyOfCall({ ...DAUGHTER, object: 'owner' })).toBe(JSON.stringify(['text:mia', 'daughter of', 'owner']));
    expect(claimKeyOfCall({ ...DAUGHTER, object: { contact: 'Dana@Example.test' } }, records))
      .toBe(JSON.stringify(['text:mia', 'daughter of', `contact:${dana.contact_id}`]));
    // A linked end it cannot look up, a relation the save would refuse, or no claim: no key.
    expect(claimKeyOfCall({ ...DAUGHTER, object: { contact: 'dana@example.test' } })).toBeUndefined();
    expect(claimKeyOfCall({ ...DAUGHTER, object: { contact: 'nobody@example.test' } }, records)).toBeUndefined();
    expect(claimKeyOfCall({ ...DAUGHTER, relation: 'kid of' })).toBeUndefined();
    expect(claimKeyOfCall(undefined)).toBeUndefined();
  });

  it('keys a thing the call named as the save stored it', async () => {
    const f = fixture();
    const bike = f.work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, name: 'Blue bicycle' });
    const call = { subject: 'Mia', relation: 'owns', object: { asset: bike.id } };
    const saved = await saveIn(f, 'c0', 'Mia owns the blue bicycle', call);
    expect(claimKeyOfCall(call, ownerClaimRecords({ work: f.work }))).toBe((await f.store.getRow(saved))!.claim_key);
  });
});

// ── slice C: recall by key ───────────────────────────────────────────

describe('slice C — recall by a claim: `about` finds notes by their claim, either way round', () => {
  const recall = async (f: ReturnType<typeof fixture>, args: Record<string, unknown>, source: ExecutionSource = ownerChat) =>
    okResult<{ memories: Array<{ memory_id: string; summary?: string }>; match?: string; rejected?: Array<{ memory_id: string }>; hint?: string }>(
      await f.call('memory.search', args, source));
  const save = async (f: ReturnType<typeof fixture>, summary: string, claim?: unknown) =>
    okResult<{ memory_id: string }>(await f.call('memory.write', { summary, ...(claim !== undefined ? { claim } : {}) })).memory_id;

  it('finds a note saved in Chinese for an English recall, by its claim', async () => {
    const f = fixture();
    const chinese = await save(f, 'Dana Whitfield 的女儿叫 Mia', DAUGHTER);
    await save(f, 'The Dublin office moved to Pearse Street in March 2026');
    const found = await recall(f, { about: ['Dana Whitfield'] });
    expect(found.match).toBe('claim');
    expect(found.memories.map((m) => m.memory_id)).toEqual([chinese]);
  });

  it('joins two ends either way round, and one end as subject or object', async () => {
    const f = fixture();
    const daughter = await save(f, "Mia is Dana's daughter", { subject: 'Mia', relation: 'daughter of', object: 'Dana' });
    const mother = await save(f, "Dana is Mia's mother", { subject: 'Dana', relation: 'mother of', object: 'Mia' });
    const work = await save(f, 'Dana works at Acme', { subject: 'Dana', relation: 'works at', object: 'Acme' });
    await save(f, "Leo is Dana's son", { subject: 'Leo', relation: 'son of', object: 'Dana' });
    expect((await recall(f, { about: ['Mia', 'Dana'] })).memories.map((m) => m.memory_id).sort()).toEqual([daughter, mother].sort());
    expect((await recall(f, { about: ['dana', 'MIA'] })).memories).toHaveLength(2);
    expect((await recall(f, { about: ['Acme'] })).memories.map((m) => m.memory_id)).toEqual([work]);
    expect((await recall(f, { about: ['Dana'] })).memories).toHaveLength(4);
    // Newest first: an unranked recall reads as the feed does.
    expect((await recall(f, { about: 'Mia' })).memories.map((m) => m.memory_id)).toEqual([mother, daughter]);
  });

  it("⛔ lists a revoked note about them under rejected, in any language, and never as a fact", async () => {
    const f = fixture();
    const revoked = await save(f, "Dana Whitfield's daughter is called Mia", DAUGHTER);
    await handleMemoryRevoke(f.rpcDeps, { memory_id: revoked });
    // Words alone: a Chinese query carries no rejection, since none of its words reach the note.
    const byWords = await recall(f, { query: 'Dana Whitfield 的女儿' });
    expect(byWords.rejected).toBeUndefined();
    const byClaim = await recall(f, { about: ['Mia', 'Dana Whitfield'] });
    expect(byClaim.memories).toEqual([]);
    expect(byClaim.rejected?.map((r) => r.memory_id)).toEqual([revoked]);
    expect(byClaim.hint).toMatch(/the owner marked a memory about them wrong/);
  });

  it('leaves out removed notes and earlier versions, as a word search does', async () => {
    const f = fixture();
    const hidden = await save(f, 'Dana Whitfield 的女儿叫 Mia', DAUGHTER);
    await f.redactions.set(hidden, { memory_id: hidden, redacted_at: 1 } as MemoryRedactionRecord);
    const first = await save(f, "Mia is Dana Whitfield's daughter", DAUGHTER);
    const second = okResult<{ memory_id: string }>(await f.call('memory.write', {
      summary: "Mia is Dana Whitfield's eldest daughter", claim: DAUGHTER, replaces: first,
    })).memory_id;
    const deleted = await save(f, "Dana Whitfield's daughter is called Mia", DAUGHTER);
    await handleMemoryDelete(f.rpcDeps, { memory_id: deleted });
    expect((await recall(f, { about: ['Dana Whitfield'] })).memories.map((m) => m.memory_id)).toEqual([second]);
    // A version replaced by one saved with no claim is not current either, though the
    // claim recall never sees its replacement.
    const third = okResult<{ memory_id: string }>(await f.call('memory.write', {
      summary: "Mia is Dana Whitfield's stepdaughter", replaces: second,
    })).memory_id;
    expect((await recall(f, { about: ['Dana Whitfield'] })).memories).toEqual([]);
    expect((await f.store.getRow(third))?.claim).toBeUndefined();
    // Delete erased the deleted note's ends with its claim.
    expect((await f.store.getRow(deleted))).not.toHaveProperty('claim_subject');
    expect((await f.store.getRow(deleted))).not.toHaveProperty('claim_object');
  });

  it('lets the words answer when no claim names them, and says so', async () => {
    const f = fixture();
    const plain = await save(f, "Dana Whitfield's daughter is called Mia");
    const withQuery = await recall(f, { about: ['Dana Whitfield'], query: 'Dana Whitfield daughter' });
    expect(withQuery.memories.map((m) => m.memory_id)).toEqual([plain]);
    expect(withQuery.match).toBe('exact');
    expect(withQuery.hint).toMatch(/no claim on a current note names what you passed in `about`; these matched your query by its words/);
    const alone = await recall(f, { about: ['Dana Whitfield'] });
    expect(alone.memories).toEqual([]);
    expect(alone.hint).toMatch(/no claim on a current note names them\. A note saved without a claim is found only by its words, so search with `query` too/);
  });

  /** Audit 2026-10-31 — the words answered only when the claim index held nothing about them,
   *  so a claimed note that was replaced, removed or out of range still answered `about`, with
   *  nothing current, and the words of a correction saved without a claim went unread. */
  it('lets the words answer when the notes that name them are replaced, removed or out of range', async () => {
    const f = fixture();
    const LIVES = (object: string) => ({ subject: 'Dana', relation: 'lives in', object });
    const dublin = await save(f, 'Dana lives in Dublin', LIVES('Dublin'));
    const cork = okResult<{ memory_id: string }>(await f.call('memory.write',
      { summary: 'Dana moved to Cork', replaces: dublin })).memory_id;
    const replaced = await recall(f, { about: 'Dana', query: 'Dana Cork' });
    expect(replaced.memories.map((m) => m.memory_id)).toEqual([cork]);
    expect(replaced.hint).toMatch(/no claim on a current note names what you passed in `about`; these matched your query by its words/);
    // Alone, `about` finds nothing current, and says to search by the words.
    expect((await recall(f, { about: 'Dana' })).hint).toMatch(/^no claim on a current note names them\. .*search with `query` too/);

    // A revoked note answers no fact, and is still told as the owner's rejection.
    const g = fixture();
    const wrong = await save(g, 'Dana lives in Dublin', LIVES('Dublin'));
    await handleMemoryRevoke(g.rpcDeps, { memory_id: wrong });
    const plain = await save(g, 'Dana moved to Cork');
    const revoked = await recall(g, { about: 'Dana', query: 'Dana Cork' });
    expect(revoked.memories.map((m) => m.memory_id)).toEqual([plain]);
    expect(revoked.rejected?.map((r) => r.memory_id)).toEqual([wrong]);
    const unmatched = await recall(g, { about: 'Dana', query: 'Paris' });
    expect(unmatched.memories).toEqual([]);
    expect(unmatched.rejected?.map((r) => r.memory_id)).toEqual([wrong]);
    expect(unmatched.hint).toMatch(/nothing current is saved about them, but the owner marked a memory about them wrong/);

    // A note before `since` is not on the page, so the words answer, and the hint says when.
    const h = fixture();
    await save(h, 'Dana works at Acme', { subject: 'Dana', relation: 'works at', object: 'Acme' });
    const later = await save(h, 'Dana started at Initech');
    const since = (await h.store.getRow(later))!.ts;
    const ranged = await recall(h, { about: 'Dana', query: 'Dana Initech', since });
    expect(ranged.memories.map((m) => m.memory_id)).toEqual([later]);
    expect(ranged.hint).toMatch(/no claim on a current note in that time names what you passed in `about`/);
    // With a current note in range, the claim answers as before.
    expect((await recall(h, { about: 'Dana', query: 'Dana Initech' })).match).toBe('claim');
  });

  it('finds a linked contact however the recall names her, and never one the caller may not read', async () => {
    const f = fixture();
    const dana = f.contacts.upsertManual({ email: 'dana@example.test', name: 'Dana Whitfield' });
    const linked = await save(f, "Mia is Dana Whitfield's daughter", { ...DAUGHTER, object: { contact: 'dana@example.test' } });
    expect((await recall(f, { about: [{ contact: dana.contact_id! }] })).memories.map((m) => m.memory_id)).toEqual([linked]);
    expect((await recall(f, { about: [{ contact: 'Dana@Example.test' }, 'Mia'] })).memories).toHaveLength(1);
    const fenced = fixture({ contactsReadable: false });
    const why = await recall(fenced, { about: [{ contact: 'dana@example.test' }] }, door);
    expect(why.memories).toEqual([]);
    expect(why.hint).toMatch(/cannot read contacts/);
  });

  it('answers a malformed `about` with a guided empty, never an error', async () => {
    const f = fixture();
    expect((await recall(f, { about: ['a', 'b', 'c'] })).hint).toMatch(/`about` takes one name, or two names/);
    expect((await recall(f, { about: [{ name: 'Dana' }] })).hint).toMatch(/each name in `about` must be a name or short phrase/);
    expect((await recall(f, { about: [] })).hint).toMatch(/`about` takes one name/);
  });

  it('indexes each end, and an old store finds them by scanning', async () => {
    const f = fixture();
    await save(f, "Mia is Dana Whitfield's daughter", DAUGHTER);
    const indexes = f.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'user_memory'").all() as Array<{ sql: string | null }>;
    expect(indexes.some((i) => i.sql?.includes('claim_subject') === true)).toBe(true);
    expect(indexes.some((i) => i.sql?.includes('claim_object') === true)).toBe(true);
    const harness = createUserMemoryStore(createInMemoryCollection<UserMemoryRow>(), fakeBlobs());
    await harness.writeAuthored({ origin_actor: 'contracted_user', kind: 'chat_memory', summary: 'x', claim: {
      subject: { text: 'Mia' }, relation: 'daughter of', object: { text: 'Dana Whitfield' } } });
    expect(await harness.listClaimEnd('text:dana whitfield')).toHaveLength(1);
    expect(await harness.listClaimEnd('text:mia')).toHaveLength(1);
    expect(await harness.listClaimEnd('text:leo')).toHaveLength(0);
  });
});

// ── audit 2026-11-01: a merged contact keeps its claims ─────────────

describe('audit 2026-11-01 — a contact merged into another keeps the claims that name it', () => {
  const ENGLISH = "Mia is Dana Whitfield's daughter";
  const CHINESE = 'Dana 的女儿叫 Mia';
  const save = async (f: ReturnType<typeof fixture>, summary: string, claim: unknown, chat = 'sess-1') =>
    okResult<{ memory_id: string }>(await f.call('memory.write', { summary, claim }, ownerChat, chat)).memory_id;
  /** Dana, a contact of her own, and Dana Whitfield, the contact she is merged into (D-138:
   *  the absorbed row stays, a tombstone pointing at the survivor). */
  const twoDanas = (f: ReturnType<typeof fixture>) => {
    const dana = f.contacts.upsertManual({ email: 'dana@example.test', name: 'Dana' });
    const whitfield = f.contacts.upsertManual({ email: 'dana.whitfield@example.test', name: 'Dana Whitfield' });
    const merge = () => f.contacts.setMergedInto([f.contacts.get('dana@example.test')!], 'dana.whitfield@example.test', 7000);
    return { dana, whitfield, merge };
  };
  const ofDana = { subject: 'Mia', relation: 'daughter of', object: { contact: 'dana@example.test' } };
  const ofWhitfield = (whitfield: { contact_id?: string }) => ({ ...ofDana, object: { contact: whitfield.contact_id! } });

  it('a merge group is the survivor and every contact merged into it, at any depth; a split ends it', () => {
    const f = fixture();
    const { dana, whitfield, merge } = twoDanas(f);
    const ends = contactClaimEnds(f.contacts);
    const key = (c: { contact_id?: string }) => `contact:${c.contact_id}`;
    expect(ends(key(dana))).toEqual([key(dana)]);
    merge();
    expect(new Set(ends(key(dana)))).toEqual(new Set([key(dana), key(whitfield)]));
    expect(new Set(ends(key(whitfield)))).toEqual(new Set([key(dana), key(whitfield)]));
    const third = f.contacts.upsertManual({ email: 'd.whitfield@example.test', name: 'D. Whitfield' });
    f.contacts.setMergedInto([f.contacts.get('dana.whitfield@example.test')!], 'd.whitfield@example.test', 7100);
    expect(new Set(ends(key(dana)))).toEqual(new Set([key(dana), key(whitfield), key(third)]));
    f.contacts.setMergedInto([f.contacts.get('dana.whitfield@example.test')!, f.contacts.get('dana@example.test')!], null, 7200);
    expect(ends(key(dana))).toEqual([key(dana)]);
    expect(ends('text:dana')).toEqual(['text:dana']);
    expect(ends('contact:nobody')).toEqual(['contact:nobody']);
  });

  it('recall by `about` and the survivor\'s Relationships still find a note that named the contact merged away', async () => {
    const f = fixture();
    const { whitfield, merge } = twoDanas(f);
    const note = await save(f, ENGLISH, ofDana);
    merge();
    const recalled = async (about: unknown) =>
      okResult<{ memories: Array<{ memory_id: string }> }>(await f.call('memory.search', { about })).memories.map((m) => m.memory_id);
    expect(await recalled([{ contact: whitfield.contact_id! }])).toEqual([note]);
    expect(await recalled([{ contact: 'dana@example.test' }])).toEqual([note]);
    expect(await recalled([{ contact: 'dana.whitfield@example.test' }, 'Mia'])).toEqual([note]);
    const listed = await handleMemoryClaims(f.rpcDeps, { contact: whitfield.contact_id! });
    expect(listed.claims.map((c) => [c.memory_id, c.by])).toEqual([[note, 'record']]);
  });

  it('⛔ a revoked claim stays refused after the merge, said in another language and naming the survivor', async () => {
    const f = fixture();
    const { whitfield, merge } = twoDanas(f);
    const revoked = await save(f, CHINESE, ofDana, 'c0');
    await handleMemoryRevoke(f.rpcDeps, { memory_id: revoked });
    // Before the merge they are two people, and the words cannot match: the save would run.
    expect(await f.check({ summary: ENGLISH, claim: ofWhitfield(whitfield) })).toBeNull();
    merge();
    expect(refusal(await f.check({ summary: ENGLISH, claim: ofWhitfield(whitfield) }))).toMatch(/marked a memory like this wrong/);
    expect(refusal(await f.call('memory.write', { summary: ENGLISH, claim: ofWhitfield(whitfield) }, ownerChat, 'c1')))
      .toMatch(/marked a memory like this wrong/);
    expect((await f.store.list()).map((r) => r.memory_id)).toEqual([revoked]);
  });

  it('a save is told the note it contradicts, which named the contact merged away', async () => {
    const f = fixture();
    const { whitfield, merge } = twoDanas(f);
    const daughter = await save(f, ENGLISH, ofDana);
    merge();
    const told = await f.notices(savedClaim("Mia is Dana Whitfield's sister.", { ...ofWhitfield(whitfield), relation: 'sister of' }));
    expect(told?.memory_conflicts).toEqual([{ kind: 'contradicts', memory_id: daughter, summary: ENGLISH }]);
  });

  it('slice J — a save is told its fact is saved already, under the contact merged away', async () => {
    const f = fixture();
    const { whitfield, merge } = twoDanas(f);
    const daughter = await save(f, ENGLISH, ofDana);
    // Until they are merged, two contacts are two objects: another note on the same thing (a
    // second parent). Merged, they are one, and it is the same fact.
    expect((await f.notices(savedClaim(CHINESE, ofWhitfield(whitfield))))?.memory_conflicts)
      .toEqual([{ kind: 'also_in_memory', memory_id: daughter, summary: ENGLISH }]);
    merge();
    expect((await f.notices(savedClaim(CHINESE, ofWhitfield(whitfield))))?.memory_conflicts)
      .toEqual([{ kind: 'saved_already', memory_id: daughter, summary: ENGLISH }]);
  });

  /** Audit 2026-11-01 (second) — an import gave a note the survivor's id for the contact it
   *  named: after a split the note named the wrong person, and the same file again added a copy. */
  it('an import keeps the id of a contact merged away: the same file again adds nothing, and a split gives the notes back', async () => {
    const f = fixture();
    const { dana, whitfield, merge } = twoDanas(f);
    const owners = await handleMemoryCreate(f.rpcDeps, { kind: 'note', summary: "Mia is Dana's daughter", claim: {
      subject: { text: 'Mia' }, relation: 'daughter of', object: { contact_id: dana.contact_id!, name: 'Dana' } } });
    const agents = await save(f, CHINESE, ofDana);
    // What the Memory view's export writes from the feed (`exportMemory`).
    const file = (await handleMemoryList(f.rpcDeps, {})).entries.map((row) => ({
      memory_id: row.memory_id, origin_actor: row.origin_actor, kind: row.kind, ts: row.ts,
      ...(row.summary !== undefined ? { summary: row.summary } : {}),
      ...(row.claim !== undefined ? { claim: row.claim } : {}),
    }));
    // Brought in once, before the merge: the owner's note restored by its id, the agent's
    // note kept beside its copy (a note this server wrote has no import key).
    expect(await handleMemoryImport(f.rpcDeps, { entries: file })).toMatchObject({ merged: 1, inserted: 1 });
    merge();
    // The same file again after the merge adds nothing, and changes whom no note names.
    expect(await handleMemoryImport(f.rpcDeps, { entries: file })).toMatchObject({ merged: 1, inserted: 0, deduped: 1 });
    const rows = await f.store.list();
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.claim?.object, row.memory_id).toMatchObject({ contact_id: dana.contact_id });
    // Split: Dana is a contact of her own again, and every note is still about her.
    f.contacts.setMergedInto([f.contacts.get('dana@example.test')!], null, 7300);
    const hers = await handleMemoryClaims(f.rpcDeps, { contact: dana.contact_id! });
    expect(hers.claims.map((c) => c.memory_id).sort()).toEqual(rows.map((r) => r.memory_id).sort());
    expect(hers.claims.every((c) => c.by === 'record')).toBe(true);
    expect(hers.claims.map((c) => c.memory_id)).toEqual(expect.arrayContaining([owners.memory_id, agents]));
    expect((await handleMemoryClaims(f.rpcDeps, { contact: whitfield.contact_id! })).claims).toEqual([]);
  });

  it('the Delete count counts an earlier save that named the contact merged away', async () => {
    const f = fixture();
    const { whitfield, merge } = twoDanas(f);
    const hidden = await save(f, CHINESE, ofDana, 'c0');
    await f.redactions.set(hidden, { memory_id: hidden, redacted_at: 1 } as MemoryRedactionRecord);
    merge();
    const note = await save(f, ENGLISH, ofWhitfield(whitfield), 'c1');
    expect((await handleMemorySaves(f.rpcDeps, { memory_id: note })).saves).toBe(2);
  });
});

// ── slice D: the relationship view's read ───────────────────────────

describe("slice D — memory.claims: the notes whose claim names a contact or a thing", () => {
  const save = async (f: ReturnType<typeof fixture>, summary: string, claim?: unknown) =>
    okResult<{ memory_id: string }>(await f.call('memory.write', { summary, ...(claim !== undefined ? { claim } : {}) })).memory_id;

  it("lists a contact's notes, by its record and by its name, newest first", async () => {
    const f = fixture();
    const dana = f.contacts.upsertManual({ email: 'dana@example.test', name: 'Dana Whitfield' });
    const linked = await save(f, "Mia is Dana Whitfield's daughter", { ...DAUGHTER, object: { contact: 'dana@example.test' } });
    const named = await save(f, 'Dana Whitfield works at Acme', { subject: 'Dana Whitfield', relation: 'works at', object: 'Acme' });
    await save(f, 'Leo is Sara’s son', { subject: 'Leo', relation: 'son of', object: 'Sara' });
    const found = await handleMemoryClaims(f.rpcDeps, { contact: 'dana@example.test' });
    expect(found.claims.map((c) => [c.memory_id, c.by])).toEqual([[named, 'name'], [linked, 'record']]);
    expect(found.claims[1]!.claim.object).toEqual({ contact_id: dana.contact_id, name: 'Dana Whitfield' });
    // By its contact id too.
    expect((await handleMemoryClaims(f.rpcDeps, { contact: dana.contact_id! })).claims).toHaveLength(2);
  });

  it('lists a thing by its record and by its name', async () => {
    const f = fixture();
    const bike = f.work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, name: 'Blue bicycle' });
    const linked = await save(f, 'Mia owns the blue bicycle', { subject: 'Mia', relation: 'owns', object: { asset: bike.id } });
    const named = await save(f, 'The blue bicycle is kept at the boat club', { subject: 'blue bicycle', relation: 'kept at', object: 'the boat club' });
    const found = await handleMemoryClaims(f.rpcDeps, { asset: bike.id });
    expect(found.claims.map((c) => [c.memory_id, c.by]).sort()).toEqual([[linked, 'record'], [named, 'name']].sort());
  });

  it('⛔ leaves out removed, revoked and replaced notes', async () => {
    const f = fixture();
    f.contacts.upsertManual({ email: 'dana@example.test', name: 'Dana Whitfield' });
    const hidden = await save(f, 'Dana Whitfield 的女儿叫 Mia', DAUGHTER);
    await f.redactions.set(hidden, { memory_id: hidden, redacted_at: 1 } as MemoryRedactionRecord);
    const revoked = await save(f, "Dana Whitfield's daughter is called Mia", DAUGHTER);
    await handleMemoryRevoke(f.rpcDeps, { memory_id: revoked });
    const first = await save(f, 'Dana Whitfield works at Acme', { subject: 'Dana Whitfield', relation: 'works at', object: 'Acme' });
    const second = okResult<{ memory_id: string }>(await f.call('memory.write', {
      summary: 'Dana Whitfield works at Acme Ltd', claim: { subject: 'Dana Whitfield', relation: 'works at', object: 'Acme Ltd' }, replaces: first,
    })).memory_id;
    const deleted = await save(f, 'Dana Whitfield lives in Cork', { subject: 'Dana Whitfield', relation: 'lives in', object: 'Cork' });
    await handleMemoryDelete(f.rpcDeps, { memory_id: deleted });
    expect((await handleMemoryClaims(f.rpcDeps, { contact: 'dana@example.test' })).claims.map((c) => c.memory_id)).toEqual([second]);
  });

  it('finds nothing to link for a contact that is not here, and refuses a call naming neither or both', async () => {
    const f = fixture();
    await save(f, "Mia is Dana Whitfield's daughter", DAUGHTER);
    expect(await handleMemoryClaims(f.rpcDeps, { contact: 'nobody@example.test' })).toEqual({ claims: [] });
    await expect(handleMemoryClaims(f.rpcDeps, {})).rejects.toThrow(/a contact or an asset/);
    await expect(handleMemoryClaims(f.rpcDeps, { contact: 'a@b.c', asset: 'x' })).rejects.toThrow(/a contact or an asset/);
  });

  it('shows the newest 50 and says there are more', async () => {
    const f = fixture();
    f.contacts.upsertManual({ email: 'dana@example.test', name: 'Dana Whitfield' });
    for (let i = 0; i < 51; i += 1) {
      await f.store.writeAuthored({ origin_actor: 'contracted_user', kind: 'chat_memory', summary: `fact ${i}`,
        claim: { subject: { text: `Child ${i}` }, relation: 'child of', object: { text: 'Dana Whitfield' } } });
    }
    const found = await handleMemoryClaims(f.rpcDeps, { contact: 'dana@example.test' });
    expect(found.claims).toHaveLength(50);
    expect(found.more).toBe(true);
    expect(found.claims[0]!.summary).toBe('fact 50');
  });
});

// ── slice E: the owner writes a relationship ────────────────────────

describe("slice E — the owner's add, edit and Replace carry a relationship", () => {
  const STORED: MemoryClaim = { subject: { text: 'Mia' }, relation: 'daughter of', object: { text: 'Dana Whitfield' } };

  it('adds a note with a relationship, a linked contact keyed by its record and named as it is now', async () => {
    const f = fixture();
    const dana = f.contacts.upsertManual({ email: 'dana@example.test', name: 'Dana Whitfield' });
    const made = await handleMemoryCreate(f.rpcDeps, { kind: 'note', summary: "Mia is Dana's daughter",
      claim: { ...STORED, object: { contact_id: dana.contact_id!, name: 'Dana' } } });
    const row = (await f.store.getRow(made.memory_id))!;
    expect(row.claim?.object).toEqual({ contact_id: dana.contact_id, name: 'Dana Whitfield' });
    expect(row.claim_key).toBe(JSON.stringify(['text:mia', 'daughter of', `contact:${dana.contact_id}`]));
    expect(row.origin_actor).toBe('user_self');
  });

  it("keeps a relation of the owner's own as written, and the owner as an end", async () => {
    const f = fixture();
    const own = await handleMemoryCreate(f.rpcDeps, { kind: 'note', summary: "Lena is my cousin Sara's boyfriend's mother",
      claim: { subject: { text: 'Lena' }, relation: "mother of my cousin's boyfriend", object: { text: 'cousin Sara' } } });
    expect((await f.store.getRow(own.memory_id))!.claim?.relation).toBe("mother of my cousin's boyfriend");
    const mine = await handleMemoryCreate(f.rpcDeps, { kind: 'note', claim: { ...STORED, object: { owner: true } } });
    expect((await f.store.getRow(mine.memory_id))!.claim_key).toBe(JSON.stringify(['text:mia', 'daughter of', 'owner']));
  });

  it('⛔ refuses an end of the wrong kind or a contact no longer there, in the owner\'s words, and writes nothing', async () => {
    const f = fixture();
    const dana = f.contacts.upsertManual({ email: 'dana@example.test', name: 'Dana Whitfield' });
    await expect(handleMemoryCreate(f.rpcDeps, { kind: 'note',
      claim: { subject: { text: 'Mia' }, relation: 'owns', object: { contact_id: dana.contact_id!, name: 'Dana Whitfield' } } }))
      .rejects.toThrow('“owns” takes a thing as its second part, not a contact.');
    await expect(handleMemoryCreate(f.rpcDeps, { kind: 'note',
      claim: { ...STORED, object: { contact_id: 'ct-gone', name: 'Dana Whitfield' } } }))
      .rejects.toThrow('Dana Whitfield is not in your contacts any more. Choose another contact, or write the name.');
    await expect(handleMemoryCreate(f.rpcDeps, { kind: 'note',
      claim: { subject: { text: 'Mia' }, relation: 'daughter of' } as unknown as MemoryClaim }))
      .rejects.toThrow(/needs a first part, a relation and a second part/);
    expect(await f.store.list()).toEqual([]);
  });

  it('edits the relationship apart from the summary: a claim replaces it, null drops it, nothing leaves it', async () => {
    const f = fixture();
    const made = await handleMemoryCreate(f.rpcDeps, { kind: 'note', summary: "Mia is Dana's daughter", claim: STORED });
    await handleMemoryUpdate(f.rpcDeps, { memory_id: made.memory_id, summary: 'Mia, Dana’s eldest' });
    expect((await f.store.getRow(made.memory_id))!.claim).toEqual(STORED);
    await handleMemoryUpdate(f.rpcDeps, { memory_id: made.memory_id, claim: { ...STORED, relation: 'stepdaughter of' } });
    const changed = (await f.store.getRow(made.memory_id))!;
    expect(changed.claim?.relation).toBe('stepdaughter of');
    expect(changed.summary).toBe('Mia, Dana’s eldest');
    await handleMemoryUpdate(f.rpcDeps, { memory_id: made.memory_id, claim: null });
    const dropped = (await f.store.getRow(made.memory_id))!;
    expect(dropped.claim).toBeUndefined();
    expect(dropped.claim_key).toBeUndefined();
    expect(dropped.claim_subject).toBeUndefined();
    expect(await f.store.listClaim(changed.claim_key!)).toEqual([]);
  });

  it("puts the owner's version in an agent note's place with the agent's claim, a name now linked", async () => {
    const f = fixture();
    const dana = f.contacts.upsertManual({ email: 'dana@example.test', name: 'Dana Whitfield' });
    const agents = okResult<{ memory_id: string }>(await f.call('memory.write', { summary: "Dana Whitfield's daughter is called Mia", claim: DAUGHTER })).memory_id;
    const theirs = await handleMemoryReplace(f.rpcDeps, { memory_id: agents, kind: 'note', summary: "Dana Whitfield's daughter is called Mia",
      claim: { ...STORED, object: { contact_id: dana.contact_id!, name: 'Dana Whitfield' } } });
    const row = (await f.store.getRow(theirs.memory_id))!;
    expect(row.replaces).toBe(agents);
    expect(row.claim?.object).toEqual({ contact_id: dana.contact_id, name: 'Dana Whitfield' });
    expect((await f.store.getRow(agents))!.claim?.object).toEqual({ text: 'Dana Whitfield' });
  });

  /** Audit 2026-10-31 — an agent's save links the note to a contact its claim links (§3.2),
   *  and so does a card's change; the owner's own forms did not, so the note's links in the
   *  feed, and the export written from them, left the contact out. */
  it("links the note to a contact its relationship links, on add, edit and Replace, as an agent's save does", async () => {
    const f = fixture();
    const dana = f.contacts.upsertManual({ email: 'dana@example.test', name: 'Dana Whitfield' });
    const mia = f.contacts.upsertManual({ email: 'mia@example.test', name: 'Mia Whitfield' });
    const toDana: MemoryClaim = { ...STORED, object: { contact_id: dana.contact_id!, name: 'Dana Whitfield' } };
    // The feed's links, which the Memory view's export writes.
    const linksOf = async (memory_id: string) => (await handleMemoryList(f.rpcDeps, {})).entries
      .find((e) => e.memory_id === memory_id)?.links?.map((l) => l.entity_id);

    const made = await handleMemoryCreate(f.rpcDeps, { kind: 'note', summary: "Mia is Dana's daughter", claim: toDana });
    expect(made.provenance_edges_written).toBe(1);
    expect(await linksOf(made.memory_id)).toEqual(['dana@example.test']);
    // Beside the links the form sent, once each.
    const both = await handleMemoryCreate(f.rpcDeps, { kind: 'note', summary: "Mia is Dana's daughter",
      provenance_entity_ids: ['deal-7', 'dana@example.test'], claim: toDana });
    expect(both.provenance_edges_written).toBe(2);
    expect(await linksOf(both.memory_id)).toEqual(['deal-7', 'dana@example.test']);

    // An edit adds the contacts it links; one it no longer links keeps its link, since the
    // note's links cannot tell a link the claim made from one sent beside it.
    const plain = await handleMemoryCreate(f.rpcDeps, { kind: 'note', summary: "Mia is Dana's daughter", claim: STORED });
    expect(await linksOf(plain.memory_id)).toBeUndefined();
    const edited = await handleMemoryUpdate(f.rpcDeps, { memory_id: plain.memory_id,
      claim: { ...STORED, subject: { contact_id: mia.contact_id!, name: 'Mia Whitfield' } } });
    expect(edited.provenance_edges_written).toBe(1);
    expect(await linksOf(plain.memory_id)).toEqual(['mia@example.test']);
    await handleMemoryUpdate(f.rpcDeps, { memory_id: plain.memory_id, claim: null });
    expect(await linksOf(plain.memory_id)).toEqual(['mia@example.test']);
    await handleMemoryUpdate(f.rpcDeps, { memory_id: plain.memory_id, claim: toDana });
    expect(await linksOf(plain.memory_id)).toEqual(['mia@example.test', 'dana@example.test']);

    // Replace keeps the agent note's links, and adds the contacts the owner's version links.
    const agents = okResult<{ memory_id: string }>(await f.call('memory.write',
      { summary: "Dana Whitfield's daughter is called Mia", claim: DAUGHTER, provenance_entity_ids: ['deal-7'] })).memory_id;
    const theirs = await handleMemoryReplace(f.rpcDeps, { memory_id: agents, kind: 'note',
      summary: "Dana Whitfield's daughter is called Mia", claim: toDana });
    expect(theirs.provenance_edges_written).toBe(2);
    expect(await linksOf(theirs.memory_id)).toEqual(['deal-7', 'dana@example.test']);
  });
});

/** ⛔ The tests above hand the memory rpc its lookups themselves, so they prove the import
 *  and the count use them, and nothing about whether the server supplies them. Without
 *  them an imported link becomes a name and a deleted save that linked a contact is never
 *  keyed, and every test above would still pass. */
describe('the server gives the memory rpc its contacts and things to look claims up in', () => {
  it('compose-listeners builds the owner lookups over the contact store and the work store', () => {
    const source = stripSourceComments(readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'serve/compose-listeners.ts'), 'utf-8',
    ));
    const memoryDeps = source.slice(source.indexOf('memoryRpcDeps: {'), source.indexOf('timelineRpcDeps: {'));
    expect(memoryDeps).toMatch(/claimRecords: ownerClaimRecords\(\{\s*\.\.\.\(app\.contactStoreRef \? \{ contacts: app\.contactStoreRef \} : \{\}\),\s*\.\.\.\(storage\.workEntityStoreRef \? \{ work: storage\.workEntityStoreRef \} : \{\}\),/);
  });
});

// ── slice E2: the card changes a held save's relationship while approving ──

describe("slice E2 — a held save's relationship changed on its card", () => {
  const STORED: MemoryClaim = { subject: { text: 'Mia' }, relation: 'daughter of', object: { contact_id: 'ct-dana', name: 'Dana Whitfield' } };
  const held = (args: unknown, tool = 'memory.write') => ({
    plan_id: 'plan-1', session_id: 's', turn_id: 't', tool, tier: 1 as const, classification: 'write' as const,
    args, args_hash: planApproval.computePlanArgsHash(args), status: 'proposed' as const, created_at: 1,
    hold: { run_id: 'run-1' },
  });
  const lookups = { contact: (id: string) => (id === 'ct-dana' ? { contact_id: 'ct-dana', name: 'Dana Whitfield', email: 'dana@example.test' } : null) };

  it('keys a deleted save by the claim the owner approved, recorded as their forms write it', () => {
    expect(claimKeyOfCall(STORED)).toBe(JSON.stringify(['text:mia', 'daughter of', 'contact:ct-dana']));
    // A relation of the owner's own is keyed as written.
    expect(claimKeyOfCall({ ...STORED, relation: 'Goddaughter of' })).toBe(JSON.stringify(['text:mia', 'goddaughter of', 'contact:ct-dana']));
    const card = { plan: { ...held({ summary: 'Mia', claim: STORED }), status: 'approved' as const }, execution: { status: 'completed' as const, turn_id: 't', result_ref: 'r' } };
    expect(savesOnCards([card as never])).toEqual([{ summary: 'Mia', claim: STORED }]);
  });

  it('reads the change: the owner\'s claim or none, nothing when it changes nothing, refused when the card takes none', () => {
    const plan = held({ summary: 'Mia', claim: { subject: 'Mia', relation: 'daughter of', object: 'Dana' } });
    expect(readHeldPlanEdit(plan as never, { claim: STORED }, lookups)).toEqual({
      overrides: { claim: STORED }, args: { summary: 'Mia', claim: STORED },
    });
    expect(readHeldPlanEdit(plan as never, { claim: null }, lookups)).toEqual({ overrides: { claim: null }, args: { summary: 'Mia' } });
    expect(readHeldPlanEdit(plan as never, undefined, lookups)).toBeUndefined();
    expect(readHeldPlanEdit(plan as never, {}, lookups)).toBeUndefined();
    expect(readHeldPlanEdit(held({ summary: 'Mia' }) as never, { claim: null }, lookups)).toBeUndefined();
    expect(() => readHeldPlanEdit(plan as never, [STORED], lookups)).toThrow('edited_args must be an object');
    expect(() => readHeldPlanEdit(held({ summary: 'x' }, 'calendar.create') as never, { claim: null }, lookups))
      .toThrow("'claim' cannot be changed while approving this");
    const { hold: _hold, ...plain } = plan;
    expect(() => readHeldPlanEdit(plain as never, { claim: null }, lookups)).toThrow("'claim' cannot be changed");
  });

  it('links the note to the contacts the claim names, by the email the owner\'s lookups give', () => {
    expect(claimContactEmails(STORED, lookups)).toEqual(['dana@example.test']);
    expect(claimContactEmails({ ...STORED, object: { text: 'Dana' } }, lookups)).toEqual([]);
    expect(claimContactEmails({ ...STORED, object: { contact_id: 'ct-gone', name: 'Gone' } }, lookups)).toEqual([]);
    const f = fixture();
    const dana = f.contacts.upsertManual({ email: 'dana@example.test', name: 'Dana Whitfield' });
    expect(ownerClaimRecords({ contacts: f.contacts }).contact!(dana.contact_id!)).toEqual({
      contact_id: dana.contact_id, name: 'Dana Whitfield', email: 'dana@example.test',
    });
  });
});

/** ⛔ The E2 tests hand the card and the save their lookups and their writer themselves, so
 *  they prove those are used and nothing about whether the server supplies them. Absent,
 *  a card's change is refused as not wired, and a save the owner changed refuses its own
 *  linked ends: every one of those tests would still pass. */
describe('the server gives the card its writer and lookups, and the save its lookups', () => {
  const read = (path: string) => stripSourceComments(readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '..', path), 'utf-8',
  ));

  it('compose-listeners gives the chat rpc the owner lookups and the held-plan writer', () => {
    const source = read('serve/compose-listeners.ts');
    expect(source).toMatch(/app\.chatDeps\.claimRecords = ownerClaimRecords\(\{\s*\.\.\.\(app\.contactStoreRef \? \{ contacts: app\.contactStoreRef \} : \{\}\),\s*\.\.\.\(storage\.workEntityStoreRef \? \{ work: storage\.workEntityStoreRef \} : \{\}\),/);
    expect(source).toMatch(/app\.chatDeps\.editHeldPlan = createHeldPlanEditor\(\{\s*checkpointStore: execution\.executeDeps\.checkpointStore,\s*plans,/);
  });

  /** Audit 2026-11-01 — the fixture above wires the merge group itself, so it proves the
   *  store; this proves the server does too. */
  it('the server\'s memory store reads a claim\'s contact end as its merge group', () => {
    expect(read('serve/compose-app-context.ts')).toMatch(
      /createUserMemoryStore\([\s\S]{0,600}?sameClaimEnd: \(end_key\) => \(contactStoreRef === undefined \? \[end_key\] : contactClaimEnds\(contactStoreRef\)\(end_key\)\)/,
    );
  });

  it('the chat tools get the owner lookups, through the orchestrator wiring', () => {
    expect(read('serve/compose-app-context.ts')).toMatch(/getOwnerClaimRecords: \(\) => ownerClaimRecords\(\{\s*\.\.\.\(contactStoreRef \? \{ contacts: contactStoreRef \} : \{\}\),\s*\.\.\.\(workEntityStore \? \{ work: workEntityStore \} : \{\}\),/);
    expect(read('composition/bin/wire-chat-orchestrator.ts')).toMatch(/\.\.\.\(getOwnerClaimRecords \? \{ getOwnerClaimRecords \} : \{\}\)/);
  });
});

// ── slice G — contradictions, and another note on the same thing ────

describe('slice G — a save is told the notes it contradicts, and the others on the same thing', () => {
  const SISTER = { subject: 'Mia', relation: 'sister of', object: 'Dana Whitfield' } as const;
  const DUBLIN = { subject: 'Dana', relation: 'lives in', object: 'Dublin' } as const;
  const CORK = { subject: 'Dana', relation: 'lives in', object: 'Cork' } as const;
  const save = async (f: ReturnType<typeof fixture>, summary: string, claim: unknown, source: ExecutionSource = ownerChat, extra: Record<string, unknown> = {}) =>
    okResult<{ memory_id: string }>(await f.call('memory.write', { summary, claim, ...extra }, source)).memory_id;

  it('flags a relation the list excludes between the same two ends, and nothing a general form agrees with', async () => {
    const f = fixture();
    const daughter = await save(f, "Mia is Dana Whitfield's daughter.", DAUGHTER);
    // "child of" is "daughter of"'s general form, so neither contradicts the other. A
    // restatement is the same claim: saved already (slice J), never a contradiction.
    expect(await f.notices(savedClaim('Mia is a child of Dana Whitfield.', { ...DAUGHTER, relation: 'child of' }))).toBeUndefined();
    expect((await f.notices(savedClaim("Mia is Dana Whitfield's daughter", DAUGHTER)))?.memory_conflicts?.map((c) => c.kind))
      .toEqual(['saved_already']);
    const told = await f.notices(savedClaim("Mia is Dana Whitfield's sister.", SISTER));
    expect(told?.memory_conflicts).toEqual([{ kind: 'contradicts', memory_id: daughter, summary: "Mia is Dana Whitfield's daughter." }]);
    // The agent's own note is corrected by forgetting it, which combines with the save that
    // waits whatever the owner approves (a second save with `replaces` did not, live).
    expect(told?.agent).toBe(`It contradicts "Mia is Dana Whitfield's daughter." ('${daughter}'), which you saved. `
      + 'If this corrects it, forget that one with memory.forget.');
  });

  it('tells another note on the same thing: the same subject and relation, another object', async () => {
    const f = fixture();
    const dublin = await save(f, 'Dana lives in Dublin.', DUBLIN);
    const told = await f.notices(savedClaim('Dana moved to Cork.', CORK));
    expect(told?.memory_conflicts).toEqual([{ kind: 'also_in_memory', memory_id: dublin, summary: 'Dana lives in Dublin.' }]);
    expect(told?.agent).toBe(`Memory also holds "Dana lives in Dublin." ('${dublin}'), which you saved, with the same relation. `
      + 'If this replaces it, forget that one with memory.forget; if both are true, nothing more is needed.');
    // Another relation between the same two is neither.
    expect(await f.notices(savedClaim('Dana is from Dublin.', { ...DUBLIN, relation: 'from' }))).toBeUndefined();
  });

  it("names the owner's own note as theirs, which wins, and another agent's as one it cannot change", async () => {
    const f = fixture();
    const owners = await handleMemoryCreate(f.rpcDeps, {
      kind: 'note', summary: "Mia is Dana Whitfield's daughter.",
      claim: { subject: { text: 'Mia' }, relation: 'daughter of', object: { text: 'Dana Whitfield' } },
    });
    const theirs = await save(f, 'Mia is Dana Whitfield\'s stepdaughter.', { ...DAUGHTER, relation: 'stepdaughter of' }, door);
    const told = await f.notices(savedClaim("Mia is Dana Whitfield's sister.", SISTER));
    expect(told?.memory_conflicts?.map((c) => ('memory_id' in c ? c.memory_id : c.kind)).sort()).toEqual([owners.memory_id, theirs].sort());
    expect(told?.agent).toContain(`It contradicts the user's own note "Mia is Dana Whitfield's daughter." ('${owners.memory_id}'). `
      + 'Their note wins: tell them, and ask which is right; they can change it in the Memory view.');
    expect(told?.agent).toContain(`It contradicts "Mia is Dana Whitfield's stepdaughter." ('${theirs}'), which another agent saved `
      + 'and you cannot change. Tell the user; they can change it in the Memory view.');
  });

  it('compares only what memory holds: no removed note, no replaced version, not the note a save replaces', async () => {
    const f = fixture();
    const revoked = await save(f, 'Mia is the stepdaughter of Dana Whitfield.', { ...DAUGHTER, relation: 'stepdaughter of' });
    await handleMemoryRevoke(f.rpcDeps, { memory_id: revoked });
    const hidden = await save(f, 'Mia is the niece of Dana Whitfield.', { ...DAUGHTER, relation: 'niece of' });
    await f.redactions.set(hidden, { memory_id: hidden, redacted_at: 1 });
    const deleted = await save(f, 'Mia is the cousin of Dana Whitfield.', { ...DAUGHTER, relation: 'cousin of' });
    await handleMemoryDelete(f.rpcDeps, { memory_id: deleted });
    const forgotten = await save(f, 'Mia is the aunt of Dana Whitfield.', { ...DAUGHTER, relation: 'aunt of' });
    okResult(await f.call('memory.forget', { memory_id: forgotten }));
    const first = await save(f, "Mia is Dana Whitfield's daughter, I think.", DAUGHTER);
    const current = await save(f, "Mia is Dana Whitfield's daughter.", DAUGHTER, ownerChat, { replaces: first });
    const told = await f.notices(savedClaim("Mia is Dana Whitfield's sister.", SISTER));
    expect(told?.memory_conflicts).toEqual([{ kind: 'contradicts', memory_id: current, summary: "Mia is Dana Whitfield's daughter." }]);
    // A save that replaces the note is no contradiction of it, nor of its earlier versions.
    expect(await f.notices({ ...savedClaim("Mia is Dana Whitfield's sister.", SISTER), replaces: current })).toBeUndefined();
  });

  it('compares ends by their key: a name and a linked contact are two ends, and the other way round is not compared', async () => {
    const f = fixture();
    f.contacts.upsertManual({ email: 'dana@example.test', name: 'Dana Whitfield' });
    await save(f, "Mia is Dana Whitfield's daughter.", { ...DAUGHTER, object: { contact: 'dana@example.test' } });
    await save(f, "Dana Whitfield is Mia's mother.", { subject: 'Dana Whitfield', relation: 'mother of', object: 'Mia' });
    expect(await f.notices(savedClaim("Mia is Dana Whitfield's sister.", SISTER))).toBeUndefined();
    const linked = await f.notices(savedClaim("Mia is Dana Whitfield's sister.", { ...SISTER, object: { contact: 'dana@example.test' } }));
    expect(linked?.memory_conflicts?.map((c) => c.kind)).toEqual(['contradicts']);
  });

  it('quotes a note to a caller only if it may read memory; the owner is told either way', async () => {
    const f = fixture({ granted: (op) => op !== 'core.memory.read' });
    const daughter = await save(f, "Mia is Dana Whitfield's daughter.", DAUGHTER);
    const told = await f.notices(savedClaim("Mia is Dana Whitfield's sister.", SISTER));
    expect(told?.agent).toBeUndefined();
    expect(told?.memory_conflicts).toEqual([{ kind: 'contradicts', memory_id: daughter, summary: "Mia is Dana Whitfield's daughter." }]);
    const ran = okResult<Record<string, unknown>>(await f.call('memory.write', savedClaim("Mia is Dana Whitfield's sister.", SISTER)));
    expect(ran).not.toHaveProperty('contradicts');
    expect(ran).not.toHaveProperty('note');
  });

  it("memory.write's result says what the save met once it has run, and never refuses it", async () => {
    const f = fixture();
    const daughter = await save(f, "Mia is Dana Whitfield's daughter.", DAUGHTER);
    const dublin = await save(f, 'Dana lives in Dublin.', DUBLIN);
    expect(await f.check(savedClaim("Mia is Dana Whitfield's sister.", SISTER))).toBeNull();
    const ran = okResult<Record<string, unknown>>(await f.call('memory.write', savedClaim("Mia is Dana Whitfield's sister.", SISTER)));
    expect(ran.contradicts).toEqual([{ memory_id: daughter, summary: "Mia is Dana Whitfield's daughter." }]);
    expect(ran.note).toBe(`It contradicts "Mia is Dana Whitfield's daughter." ('${daughter}'), which you saved. If this corrects it, forget that one with memory.forget.`);
    const moved = okResult<Record<string, unknown>>(await f.call('memory.write', savedClaim('Dana moved to Cork.', CORK)));
    expect(moved.also_in_memory).toEqual([{ memory_id: dublin, summary: 'Dana lives in Dublin.' }]);
    expect(moved).not.toHaveProperty('contradicts');
    expect((await f.store.list()).length).toBe(4);
  });

  it('marks both contradicting notes in the Memory view until one is replaced or removed, and never another note on the same thing', async () => {
    const f = fixture();
    const daughter = await save(f, "Mia is Dana Whitfield's daughter.", DAUGHTER);
    const sister = await save(f, "Mia is Dana Whitfield's sister.", SISTER);
    await save(f, 'Dana lives in Dublin.', DUBLIN);
    await save(f, 'Dana lives in Cork.', CORK);
    const marks = async () => Object.fromEntries((await handleMemoryList(f.rpcDeps, {})).entries
      .filter((e) => e.contradicts !== undefined).map((e) => [e.memory_id, e.contradicts]));
    expect(await marks()).toEqual({
      [daughter]: [{ memory_id: sister, summary: "Mia is Dana Whitfield's sister." }],
      [sister]: [{ memory_id: daughter, summary: "Mia is Dana Whitfield's daughter." }],
    });
    expect((await handleMemoryGet(f.rpcDeps, { memory_id: sister })).contradicts)
      .toEqual([{ memory_id: daughter, summary: "Mia is Dana Whitfield's daughter." }]);
    // The owner marks one wrong: neither is marked any more.
    await handleMemoryRevoke(f.rpcDeps, { memory_id: sister });
    expect(await marks()).toEqual({});
    expect((await handleMemoryGet(f.rpcDeps, { memory_id: daughter })).contradicts).toBeUndefined();
  });

  it('marks the current version only: a version replaced by a newer one is history', async () => {
    const f = fixture();
    const first = await save(f, "Mia is Dana Whitfield's daughter, I think.", DAUGHTER);
    const current = await save(f, "Mia is Dana Whitfield's daughter.", DAUGHTER, ownerChat, { replaces: first });
    const sister = await save(f, "Mia is Dana Whitfield's sister.", SISTER);
    const listed = (await handleMemoryList(f.rpcDeps, {})).entries;
    expect(listed.find((e) => e.memory_id === first)?.contradicts).toBeUndefined();
    expect(listed.find((e) => e.memory_id === current)?.contradicts?.map((c) => c.memory_id)).toEqual([sister]);
    expect(listed.find((e) => e.memory_id === sister)?.contradicts?.map((c) => c.memory_id)).toEqual([current]);
    expect((await handleMemoryGet(f.rpcDeps, { memory_id: first })).contradicts).toBeUndefined();
  });

  it('is asked of the registry for every held save, through the chat registry inputs', () => {
    expect(typeof buildChatToolRegistryInputs(fixture().deps).tier1AskNotices['memory.write']).toBe('function');
  });
});

// ── D-336 slice J: a fact saved already ─────────────────────────────

describe('slice J — a save of a fact saved already is told so, and never refused', () => {
  const SISTER = { subject: 'Mia', relation: 'sister of', object: 'Dana Whitfield' } as const;
  const CALLED = "Dana Whitfield's daughter is called Mia.";
  const save = async (f: ReturnType<typeof fixture>, summary: string, claim: unknown) =>
    okResult<{ memory_id: string }>(await f.call('memory.write', { summary, claim })).memory_id;

  it('tells a held save its fact is saved already, in another wording or language; the owner can say no', async () => {
    const f = fixture();
    const first = await save(f, CALLED, DAUGHTER);
    const told = await f.notices(savedClaim("Mia is Dana Whitfield's daughter.", DAUGHTER));
    expect(told?.memory_conflicts).toEqual([{ kind: 'saved_already', memory_id: first, summary: CALLED }]);
    expect(told?.agent).toBe(`Memory already holds this fact, as "${CALLED}" ('${first}'). `
      + 'Tell the user it is saved already: they can say no to this save.');
    // The claim is the key, whatever language the summary is in.
    expect((await f.notices(savedClaim('Dana Whitfield 的女儿叫 Mia。', DAUGHTER)))?.memory_conflicts)
      .toEqual([{ kind: 'saved_already', memory_id: first, summary: CALLED }]);
  });

  it('names each note of it in one sentence, newest first, between what it contradicts and what else memory holds', async () => {
    const f = fixture();
    const sister = await save(f, "Mia is Dana Whitfield's sister.", SISTER);
    const older = await save(f, "Mia is Dana Whitfield's daughter.", DAUGHTER);
    const newer = await save(f, CALLED, DAUGHTER);
    const sam = await save(f, "Mia is Sam Whitfield's daughter.", { ...DAUGHTER, object: 'Sam Whitfield' });
    const told = await f.notices(savedClaim('Dana Whitfield 的女儿叫 Mia。', DAUGHTER));
    expect(told?.memory_conflicts?.map((c) => [c.kind, 'memory_id' in c ? c.memory_id : undefined])).toEqual([
      ['contradicts', sister], ['saved_already', newer], ['saved_already', older], ['also_in_memory', sam],
    ]);
    expect(told?.agent).toContain(`Memory already holds this fact, as "${CALLED}" ('${newer}') and `
      + `"Mia is Dana Whitfield's daughter." ('${older}'). Tell the user it is saved already: they can say no to this save.`);
  });

  it("says once the save has run that its fact was saved already, and keeps the save", async () => {
    const f = fixture();
    const first = await save(f, CALLED, DAUGHTER);
    expect(await f.check(savedClaim("Mia is Dana Whitfield's daughter.", DAUGHTER))).toBeNull();
    const ran = okResult<Record<string, unknown>>(await f.call('memory.write', savedClaim("Mia is Dana Whitfield's daughter.", DAUGHTER)));
    expect(ran.saved_already).toEqual([{ memory_id: first, summary: CALLED }]);
    expect(ran.note).toBe(`Memory already held this fact, as "${CALLED}" ('${first}'). Tell the user it was saved already.`);
    expect(ran).not.toHaveProperty('contradicts');
    expect((await f.store.list()).length).toBe(2);
  });

  it('compares only what memory holds, and a save never meets the note it replaces', async () => {
    const f = fixture();
    const deleted = await save(f, "Mia is Dana Whitfield's daughter, I think.", DAUGHTER);
    await handleMemoryDelete(f.rpcDeps, { memory_id: deleted });
    const forgotten = await save(f, "Mia is Dana Whitfield's daughter.", DAUGHTER);
    okResult(await f.call('memory.forget', { memory_id: forgotten }));
    expect(await f.notices(savedClaim(CALLED, DAUGHTER))).toBeUndefined();
    const current = await save(f, CALLED, DAUGHTER);
    // A correction of it, with `replaces`, meets neither it nor its earlier versions.
    expect(await f.notices({ ...savedClaim("Mia, who is 7, is Dana Whitfield's daughter.", DAUGHTER), replaces: current })).toBeUndefined();
  });

  it('quotes the note only to a caller that may read memory; the owner is told either way', async () => {
    const f = fixture({ granted: (op) => op !== 'core.memory.read' });
    const first = await save(f, CALLED, DAUGHTER);
    const told = await f.notices(savedClaim("Mia is Dana Whitfield's daughter.", DAUGHTER));
    expect(told?.agent).toBeUndefined();
    expect(told?.memory_conflicts).toEqual([{ kind: 'saved_already', memory_id: first, summary: CALLED }]);
    const ran = okResult<Record<string, unknown>>(await f.call('memory.write', savedClaim("Mia is Dana Whitfield's daughter.", DAUGHTER)));
    expect(ran).not.toHaveProperty('saved_already');
    expect(ran).not.toHaveProperty('note');
  });
});

// ── D-336 slice O: saves of one fact waiting at once ─────────────────

describe('slice O — a held save is told of its own saves of the fact still waiting; the owner sees every one', () => {
  const MINE = "Dana Whitfield's daughter is called Mia.";
  const THEIRS = "Mia is Dana Whitfield's girl.";
  const waitingSave = (summary: string, claim: unknown, execution_source: ExecutionSource, created_at: number): WaitingTier1Call =>
    ({ run_id: `run-${String(created_at)}`, args: { summary, claim }, execution_source, created_at });
  const ASKED = (summary: string) =>
    `You asked to save this fact already, as "${summary}", still waiting for the owner. `
    + 'Tell the user it was asked already: they can say no to this one.';

  it('lists every waiting save of the fact for the owner, and tells each caller only of its own', async () => {
    const f = fixture({ waiting: () => [
      waitingSave(MINE, DAUGHTER, ownerChat, 1),
      waitingSave(THEIRS, DAUGHTER, door, 2),
      // Another fact, which can hold beside it (slice S compares a contradiction).
      waitingSave("Mia is Dana Whitfield's goddaughter.", { ...DAUGHTER, relation: 'goddaughter of' }, ownerChat, 3),
    ] });
    const told = await f.notices(savedClaim("Mia is Dana Whitfield's daughter.", DAUGHTER));
    expect(told?.memory_conflicts).toEqual([{ kind: 'asked_already', summary: MINE }, { kind: 'asked_already', summary: THEIRS }]);
    expect(told?.agent).toBe(ASKED(MINE));
    // The app over the door is told of its own, and never of the owner's chat's.
    const fromDoor = await f.notices(savedClaim('Dana Whitfield 的女儿叫 Mia。', DAUGHTER), door);
    expect(fromDoor?.agent).toBe(ASKED(THEIRS));
    expect(fromDoor?.memory_conflicts).toHaveLength(2);
  });

  it('follows what memory holds, and a caller that cannot read memory is still told of its own save', async () => {
    const f = fixture({ granted: (op) => op !== 'core.memory.read', waiting: () => [waitingSave(MINE, DAUGHTER, ownerChat, 1)] });
    const first = okResult<{ memory_id: string }>(await f.call('memory.write', savedClaim(THEIRS, DAUGHTER))).memory_id;
    const told = await f.notices(savedClaim("Mia is Dana Whitfield's daughter.", DAUGHTER));
    expect(told?.memory_conflicts).toEqual([
      { kind: 'saved_already', memory_id: first, summary: THEIRS },
      { kind: 'asked_already', summary: MINE },
    ]);
    // Memory's note is not quoted to it; its own waiting save is.
    expect(told?.agent).toBe(ASKED(MINE));
  });

  it('keys a waiting save as it will run, by the owner\'s lookups: a linked contact is not the same end as a name', async () => {
    let dana = '';
    const f = fixture({ waiting: () => [
      waitingSave(MINE, { ...DAUGHTER, object: { contact: dana } }, ownerChat, 1),
      waitingSave(THEIRS, DAUGHTER, ownerChat, 2),
    ] });
    dana = f.contacts.upsertManual({ email: 'dana.whitfield@example.test', name: 'Dana Whitfield' }).contact_id!;
    const linked = await f.notices(savedClaim("Mia is Dana Whitfield's daughter.", { ...DAUGHTER, object: { contact: dana } }));
    expect(linked?.memory_conflicts).toEqual([{ kind: 'asked_already', summary: MINE }]);
  });

  it('compares none when the waiting saves cannot be read, and tells nothing when none is of the fact', async () => {
    const broken = fixture({ waiting: () => { throw new Error('store went away'); } });
    expect(await broken.notices(savedClaim("Mia is Dana Whitfield's daughter.", DAUGHTER))).toBeUndefined();
    const other = fixture({ waiting: () => [waitingSave(MINE, { ...DAUGHTER, object: 'Sam Whitfield' }, ownerChat, 1)] });
    expect(await other.notices(savedClaim("Mia is Dana Whitfield's daughter.", DAUGHTER))).toBeUndefined();
  });
});

// ── D-336 slice S: a save contradicting one still waiting ─────────────

describe('slice S — a held save is told of its own waiting saves it contradicts; the owner sees every one', () => {
  const waitingSave = (summary: string, claim: unknown, execution_source: ExecutionSource, created_at: number): WaitingTier1Call =>
    ({ run_id: `run-${String(created_at)}`, args: { summary, claim }, execution_source, created_at });
  const SISTER = { ...DAUGHTER, relation: 'sister of' } as const;
  const MINE = "Mia is Dana Whitfield's sister.";
  const THEIRS = "Dana Whitfield's sister is called Mia.";
  const CONTRADICTS = (summary: string) =>
    `It contradicts "${summary}", which you asked to save, still waiting for the owner. `
    + 'Tell the user, and ask which is right: they can say no to the wrong one.';

  it('lists every waiting save it contradicts for the owner, and tells each caller only of its own', async () => {
    const f = fixture({ waiting: () => [
      waitingSave(MINE, SISTER, ownerChat, 1),
      waitingSave(THEIRS, SISTER, door, 2),
      // A tie that can hold beside it contradicts nothing, nor does someone else's tie.
      waitingSave("Mia is Dana Whitfield's goddaughter.", { ...DAUGHTER, relation: 'goddaughter of' }, ownerChat, 3),
      waitingSave("Sam is Dana Whitfield's sister.", { ...SISTER, subject: 'Sam' }, ownerChat, 4),
    ] });
    const told = await f.notices(savedClaim("Mia is Dana Whitfield's daughter.", DAUGHTER));
    expect(told?.memory_conflicts).toEqual([
      { kind: 'contradicts_asked', summary: MINE }, { kind: 'contradicts_asked', summary: THEIRS },
    ]);
    expect(told?.agent).toBe(CONTRADICTS(MINE));
    const fromDoor = await f.notices(savedClaim('Dana Whitfield 的女儿叫 Mia。', DAUGHTER), door);
    expect(fromDoor?.agent).toBe(CONTRADICTS(THEIRS));
    expect(fromDoor?.memory_conflicts).toHaveLength(2);
  });

  it('beside a note in memory it contradicts and a save of the fact asked already, each listed and told', async () => {
    const f = fixture({ waiting: () => [
      waitingSave(MINE, SISTER, ownerChat, 1),
      waitingSave("Dana Whitfield's daughter is called Mia.", DAUGHTER, ownerChat, 2),
    ] });
    const noted = okResult<{ memory_id: string }>(await f.call('memory.write', savedClaim("Mia is Dana Whitfield's stepdaughter.", {
      ...DAUGHTER, relation: 'stepdaughter of',
    }))).memory_id;
    const told = await f.notices(savedClaim("Mia is Dana Whitfield's daughter.", DAUGHTER));
    expect(told?.memory_conflicts).toEqual([
      { kind: 'contradicts', memory_id: noted, summary: "Mia is Dana Whitfield's stepdaughter." },
      { kind: 'asked_already', summary: "Dana Whitfield's daughter is called Mia." },
      { kind: 'contradicts_asked', summary: MINE },
    ]);
    expect(told?.agent).toContain(`It contradicts "Mia is Dana Whitfield's stepdaughter." ('${noted}'), which you saved.`);
    expect(told?.agent).toContain('You asked to save this fact already');
    expect(told?.agent?.endsWith(CONTRADICTS(MINE))).toBe(true);
  });

  it('reads a waiting save as it will run: a linked contact and a name are two ends, so they contradict nothing', async () => {
    let dana = '';
    const f = fixture({ waiting: () => [waitingSave(MINE, { ...SISTER, object: { contact: dana } }, ownerChat, 1)] });
    dana = f.contacts.upsertManual({ email: 'dana.whitfield@example.test', name: 'Dana Whitfield' }).contact_id!;
    expect(await f.notices(savedClaim("Mia is Dana Whitfield's daughter.", DAUGHTER))).toBeUndefined();
    const linked = await f.notices(savedClaim("Mia is Dana Whitfield's daughter.", { ...DAUGHTER, object: { contact: dana } }));
    expect(linked?.memory_conflicts).toEqual([{ kind: 'contradicts_asked', summary: MINE }]);
  });

  it('a waiting save written the other way round is not compared, as a note in memory is not', async () => {
    const f = fixture({ waiting: () => [
      waitingSave("Dana Whitfield is Mia's sister.", { subject: 'Dana Whitfield', relation: 'sister of', object: 'Mia' }, ownerChat, 1),
    ] });
    expect(await f.notices(savedClaim("Mia is Dana Whitfield's daughter.", DAUGHTER))).toBeUndefined();
  });
});

// ── D-336 slice K: what the relation list misses ────────────────────

describe('slice K — the Memory view counts what the relation list misses', () => {
  const ofLena = (relation: string, object = 'Mia') =>
    ({ subject: { text: 'Lena' }, relation, object: { text: object } });
  const ownNote = async (f: ReturnType<typeof fixture>, summary: string, claim: unknown) =>
    (await handleMemoryCreate(f.rpcDeps, { kind: 'note', summary, claim } as never)).memory_id;
  const aiNote = async (f: ReturnType<typeof fixture>, summary: string, claim?: unknown) =>
    okResult<{ memory_id: string }>(await f.call('memory.write', { summary, ...(claim !== undefined ? { claim } : {}) })).memory_id;

  it("counts the notes an AI saved without a relationship, and the relations in the owner's own words", async () => {
    const f = fixture();
    await aiNote(f, 'Dana prefers mornings.');
    await aiNote(f, 'Sam likes jazz.');
    await aiNote(f, "Mia is Dana's daughter.", DAUGHTER);
    await ownNote(f, 'Lena taught Mia piano.', ofLena('Taught  Piano to'));
    await ownNote(f, 'Lena taught Sam piano.', ofLena('taught piano to', 'Sam'));
    await ownNote(f, 'Lena walks Rex.', ofLena('walks the dog of', 'Rex'));
    // A relation from the list is no relation of the owner's own.
    await ownNote(f, "Mia is Dana's daughter.", { ...ofLena('daughter of', 'Dana'), subject: { text: 'Mia' } });
    expect(await handleMemoryClaimCounts(f.rpcDeps)).toEqual({
      agent_notes: 3,
      agent_notes_without_claim: 2,
      // One key however it is spaced or cased, in the newest note's words; the most used first.
      own_relations: [{ relation: 'taught piano to', notes: 2 }, { relation: 'walks the dog of', notes: 1 }],
    });
    // The list lacks them, which is what makes them the owner's (the list may grow).
    for (const words of ['taught piano to', 'walks the dog of']) expect(MEMORY_RELATION_INDEX.has(words)).toBe(false);
  });

  it('counts only the notes that stand: none forgotten, hidden, revoked or deleted, and none replaced', async () => {
    const f = fixture();
    const forgotten = await aiNote(f, 'Dana prefers mornings.');
    const hidden = await aiNote(f, 'Sam likes jazz.');
    const revoked = await aiNote(f, 'Tom plays chess.');
    const replaced = await aiNote(f, 'Lena knows Mia.');
    await aiNote(f, 'Rex is a terrier.');
    const deleted = await ownNote(f, 'Lena taught Mia piano.', ofLena('taught piano to'));
    expect((await handleMemoryClaimCounts(f.rpcDeps)).agent_notes_without_claim).toBe(5);
    okResult(await f.call('memory.forget', { memory_id: forgotten }));
    await f.redactions.set(hidden, { memory_id: hidden, redacted_at: 1 });
    await handleMemoryRevoke(f.rpcDeps, { memory_id: revoked });
    await handleMemoryDelete(f.rpcDeps, { memory_id: deleted });
    // The owner's version of an AI's note, with a relation of their own, takes its place.
    await handleMemoryReplace(f.rpcDeps, { memory_id: replaced, kind: 'note', summary: 'Lena lent Mia a ladder.', claim: ofLena('lent a ladder to') } as never);
    expect(await handleMemoryClaimCounts(f.rpcDeps)).toEqual({
      agent_notes: 1,
      agent_notes_without_claim: 1,
      own_relations: [{ relation: 'lent a ladder to', notes: 1 }],
    });
  });

  it('reads each note\'s few fields, never a body: the projection the db-backed store answers with', async () => {
    const f = fixture();
    await aiNote(f, 'A long note.');
    const tally = await f.store.claimTally();
    expect(tally).toHaveLength(1);
    expect(Object.keys(tally[0]!).sort()).toEqual(['memory_id', 'origin_actor', 'ts']);
  });
});
