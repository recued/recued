/** D-198 §10 — an agent replaces or forgets its OWN memory entries.
 *
 *  Driven through the real chat tool handlers, the real owner rpc handlers and
 *  the real stores (the in-memory collection, and SQLite where the `replaces`
 *  index matters). What is pinned:
 *    - authorship: the contract the agent wrote under, by provenance; the owner
 *      chat's earlier rows have no provable author;
 *    - replace: a NEW row that points at the old one, which is never touched;
 *      refused for anything that is not the caller's own live current entry;
 *    - forget: the redaction overlay over the entry and the versions it
 *      replaced, recorded with the forgetting contract, never overwriting the
 *      owner's own redaction;
 *    - reads: recall skips replaced entries and marks `by_you`; the owner's feed
 *      shows every mark; `memory.restore` lifts one agent forget; a recipe's
 *      `data.memory.<id>` no longer reads a forgotten entry.
 *    - §12: the OWNER replaces an agent's entry with their own version
 *      (`memory.replace`) — a new `user_self` row in its place, refused for
 *      anything but a live current agent entry, undone by deleting it, and not
 *      something an agent can override. */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { OWNER_CONTRACT_ID } from '@recued/contracts';
import type { ChatDispatchContext, ChatDispatchResult, ChatMessage, ChatPlanRecord, ExecutionSource } from '@recued/contracts';
import { createInMemoryCollection, type AuditLogStore, type Collection } from '@recued/storage';
import type { BlobStore } from '../storage/blob-store.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import {
  createUserMemoryStore,
  USER_MEMORY_ID_PREFIX,
  type UserMemoryRow,
  type UserMemoryStore,
} from '../user-memory-store.js';
import { buildChatTier1Handlers, buildChatToolRegistryInputs, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import {
  handleMemoryCreate,
  handleMemoryDelete,
  handleMemoryGet,
  handleMemoryList,
  handleMemoryReplace,
  handleMemoryRestore,
  handleMemoryRevoke,
  handleMemorySaves,
  handleMemoryUnrevoke,
  handleMemoryUpdate,
  type MemoryRedactionRecord,
  type MemoryRpcDeps,
} from '../memory-rpc-handler.js';
import {
  createChatSavesReader,
  savesInMessages,
  savesOnCards,
  type ChatSave,
  type ChatSavesReader,
} from '../memory-save-count.js';
import { renderToolRow, toolCallArgsFromRow } from '../chat-tool-row.js';
import { stripSourceComments } from './helpers/source-guards.js';
import { authoringContractId } from '../grant-governing-contract.js';
import { createDataMemoryLookup } from '../data-memory-lookup.js';
import { claimWords, describeMemoryNow } from '../memory-revision.js';
import { useWriteRule } from '../write-rules.js';
import type { WriteRuleStore } from '../storage/write-rule-store.js';

// ── fixtures ────────────────────────────────────────────────────────

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

/** A pool whose clock advances per write, so "newest" is well defined. */
const makePool = (): UserMemoryStore => {
  let seq = 0;
  let clock = 1000;
  return createUserMemoryStore(createInMemoryCollection<UserMemoryRow>(), fakeBlobs(), {
    now: () => (clock += 10),
    mintId: () => `${USER_MEMORY_ID_PREFIX}${(seq += 1)}`,
  });
};

const gateThatGrants = (grant: boolean) => ({
  isFrozenByPause: () => false,
  isOpGranted: vi.fn().mockReturnValue(grant),
  isOwnerGoverned: () => true,
  isOwnerRecipeGranted: () => false,
});

const ownerChat: ExecutionSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'sess-1',
  user_id: 'local',
};
const door = (contract_id: string): ExecutionSource => ({
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'agent-1',
  tool_call_id: 'tc-1',
  mcp_token_id: 'tok-1',
  contract_id,
});

const ctx = (execution_source: ExecutionSource): ChatDispatchContext => ({
  channel: 'internal_function_call',
  session_id: 'sess-1',
  turn_id: 'turn-1',
  execution_source,
});

interface Harness {
  deps: ChatToolHandlerDeps;
  store: UserMemoryStore;
  redactions: Collection<MemoryRedactionRecord>;
  call: (tool: string, args: unknown, source: ExecutionSource) => Promise<ChatDispatchResult>;
  rpcDeps: MemoryRpcDeps;
}

const harness = (store: UserMemoryStore = makePool(), grant = true): Harness => {
  const redactions = createInMemoryCollection<MemoryRedactionRecord>();
  const deps: ChatToolHandlerDeps = {
    getContactStore: () => undefined,
    getCollectionRegistry: () => undefined,
    getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined,
    getRecipeStore: () => ({ ids: () => [], get: () => null, getStored: () => null, listStored: () => [] }) as never,
    getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
    getExecuteRecipe: () => undefined,
    getUserMemoryStore: () => store,
    getMemoryRedactionStore: () => redactions,
    getOpAdmissionGate: () => gateThatGrants(grant),
    now: () => 5000,
  };
  const handlers = buildChatTier1Handlers(deps) as Record<
    string,
    (raw: unknown, c: ChatDispatchContext) => Promise<ChatDispatchResult>
  >;
  return {
    deps,
    store,
    redactions,
    call: (tool, args, source) => handlers[tool]!(args, ctx(source)),
    rpcDeps: {
      auditLog: { listWindow: async () => [], listRecent: async () => [], get: async () => null } as unknown as AuditLogStore,
      userMemoryStore: store,
      redactionStore: redactions,
      now: () => 6000,
    },
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
const write = async (h: Harness, source: ExecutionSource, summary: string, replaces?: string) =>
  h.call('memory.write', { summary, ...(replaces !== undefined ? { replaces } : {}) }, source);
const recalled = async (h: Harness, source: ExecutionSource, args: Record<string, unknown> = {}) =>
  okResult<{ memories: Array<Record<string, unknown>> }>(await h.call('memory.search', args, source)).memories;
/** "Dana Whitfield's daughter is called Mia", in each of the words the claim test reads as one. */
const daughterClaim = (as: 'called' | 'named' | 'name' | 'known as', who: string, whose = "Dana Whitfield's") =>
  as === 'name' ? `${whose} daughter's name is ${who}` : `${whose} daughter is ${as} ${who}`;

// ── authorship ──────────────────────────────────────────────────────

describe('authoringContractId — who wrote an entry, by provenance', () => {
  it('names the owner contract for the owner chat and a door its own contract', () => {
    expect(authoringContractId(ownerChat)).toBe(OWNER_CONTRACT_ID);
    expect(authoringContractId({ channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' })).toBe(OWNER_CONTRACT_ID);
    expect(authoringContractId(door('door-a'))).toBe('door-a');
  });

  it('⛔ names no author for the owner sentinel spelled on a source, an anonymous source, or the owner outside an AI surface', () => {
    expect(authoringContractId(door(OWNER_CONTRACT_ID))).toBeUndefined();
    expect(authoringContractId({ channel: 'reception', actor: 'anonymous', contract_id: 'door-a' } as unknown as ExecutionSource)).toBeUndefined();
    expect(authoringContractId({ channel: 'user', actor: 'user_self', user_id: 'local' } as unknown as ExecutionSource)).toBeUndefined();
  });
});

// ── replace ─────────────────────────────────────────────────────────

describe('memory.write replaces — an agent corrects an entry it saved', () => {
  it('writes a NEW row pointing at the old one, leaves the old row untouched, and recall returns only the new one', async () => {
    const h = harness();
    const first = okResult<{ memory_id: string }>(await write(h, ownerChat, 'The Dublin office is on Baggot Street'));
    const before = await h.store.getRow(first.memory_id);
    expect(before?.author_contract_id).toBe(OWNER_CONTRACT_ID);

    const second = okResult<{ memory_id: string; replaces: string }>(
      await write(h, ownerChat, 'The Dublin office moved to Pearse Street in March 2026', first.memory_id),
    );
    expect(second.replaces).toBe(first.memory_id);
    expect((await h.store.getRow(second.memory_id))?.replaces).toBe(first.memory_id);
    expect(await h.store.getRow(first.memory_id)).toEqual(before);

    const memories = await recalled(h, ownerChat);
    expect(memories.map((m) => m.memory_id)).toEqual([second.memory_id]);
  });

  it('⛔ refuses an entry another contract wrote, and writes nothing', async () => {
    const h = harness();
    const theirs = okResult<{ memory_id: string }>(await write(h, door('door-a'), 'Door A saved this'));
    const detail = refusal(await write(h, door('door-b'), 'Door B tries to overwrite it', theirs.memory_id));
    expect(detail).toMatch(/was not saved by you/);
    const ownerTry = refusal(await write(h, ownerChat, 'The owner chat tries too', theirs.memory_id));
    expect(ownerTry).toMatch(/was not saved by you/);
    expect((await h.store.list()).map((r) => r.memory_id)).toEqual([theirs.memory_id]);
  });

  it("⛔ refuses the owner's own entry", async () => {
    const h = harness();
    const owners = await h.store.create({ kind: 'note', summary: 'Owner wrote this' });
    expect(refusal(await write(h, ownerChat, 'AI rewrite', owners.memory_id))).toMatch(/owner's own entry/);
  });

  it('refuses an entry already replaced, naming the version to replace instead', async () => {
    const h = harness();
    const a = okResult<{ memory_id: string }>(await write(h, ownerChat, 'v1'));
    const b = okResult<{ memory_id: string }>(await write(h, ownerChat, 'v2', a.memory_id));
    const detail = refusal(await write(h, ownerChat, 'v3 against v1', a.memory_id));
    expect(detail).toContain(`already replaced by '${b.memory_id}'`);
  });

  it('refuses a forgotten entry', async () => {
    const h = harness();
    const a = okResult<{ memory_id: string }>(await write(h, ownerChat, 'soon forgotten'));
    okResult(await h.call('memory.forget', { memory_id: a.memory_id }, ownerChat));
    expect(refusal(await write(h, ownerChat, 'replacement', a.memory_id))).toMatch(/was forgotten/);
  });

  it("a door's earlier entry (contract_id only) is still its own; the owner chat's earlier entry has no author", async () => {
    const h = harness();
    const doorEarlier = await h.store.writeAuthored({
      origin_actor: 'contracted_user', kind: 'chat_memory', summary: 'door, before §10',
      session: { contract_id: 'door-a' },
    });
    const chatEarlier = await h.store.writeAuthored({
      origin_actor: 'contracted_user', kind: 'chat_memory', summary: 'owner chat, before §10',
      session: { channel_session_id: 'sess-0' },
    });
    okResult(await write(h, door('door-a'), 'door, corrected', doorEarlier.memory_id));
    expect(refusal(await write(h, ownerChat, 'chat, corrected', chatEarlier.memory_id))).toMatch(/was not saved by you/);
  });

  it('two replaces of one entry batched into one turn: exactly one wins', async () => {
    const h = harness();
    const a = okResult<{ memory_id: string }>(await write(h, ownerChat, 'v1'));
    const [x, y] = await Promise.all([
      write(h, ownerChat, 'v2a', a.memory_id),
      write(h, ownerChat, 'v2b', a.memory_id),
    ]);
    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
    expect((await h.store.replacementsOf(a.memory_id))).toHaveLength(1);
  });
});

// ── forget ──────────────────────────────────────────────────────────

describe('memory.forget — an agent drops an entry it saved', () => {
  it('forgets the entry and the versions it replaced, recorded with the forgetting contract and reason', async () => {
    const h = harness();
    const a = okResult<{ memory_id: string }>(await write(h, door('door-a'), 'v1'));
    const b = okResult<{ memory_id: string }>(await write(h, door('door-a'), 'v2', a.memory_id));
    const result = okResult<{ versions: number }>(
      await h.call('memory.forget', { memory_id: b.memory_id, reason: 'the user asked me to' }, door('door-a')),
    );
    expect(result.versions).toBe(2);
    for (const id of [a.memory_id, b.memory_id]) {
      expect(await h.redactions.get(id)).toMatchObject({
        memory_id: id, by_contract_id: 'door-a', forget_of: b.memory_id, reason: 'the user asked me to',
      });
    }
    expect(await recalled(h, door('door-a'))).toEqual([]);
  });

  it("keeps the owner's earlier redaction of a version rather than overwriting it", async () => {
    const h = harness();
    const a = okResult<{ memory_id: string }>(await write(h, ownerChat, 'v1'));
    const b = okResult<{ memory_id: string }>(await write(h, ownerChat, 'v2', a.memory_id));
    await h.redactions.set(a.memory_id, { memory_id: a.memory_id, redacted_at: 1 });
    expect(okResult<{ versions: number }>(await h.call('memory.forget', { memory_id: b.memory_id }, ownerChat)).versions).toBe(1);
    expect(await h.redactions.get(a.memory_id)).toEqual({ memory_id: a.memory_id, redacted_at: 1 });
  });

  it('forgetting a forgotten entry reports it and writes nothing', async () => {
    const h = harness();
    const a = okResult<{ memory_id: string }>(await write(h, ownerChat, 'once'));
    okResult(await h.call('memory.forget', { memory_id: a.memory_id }, ownerChat));
    expect(okResult(await h.call('memory.forget', { memory_id: a.memory_id }, ownerChat))).toMatchObject({ already: true, versions: 0 });
  });

  it("⛔ refuses another contract's entry", async () => {
    const h = harness();
    const a = okResult<{ memory_id: string }>(await write(h, ownerChat, 'the owner chat saved this'));
    expect(refusal(await h.call('memory.forget', { memory_id: a.memory_id }, door('door-a')))).toMatch(/was not saved by you/);
    expect(await h.redactions.get(a.memory_id)).toBeNull();
  });

  it('fails closed without the memory write grant', async () => {
    const h = harness(makePool(), false);
    const r = await h.call('memory.forget', { memory_id: 'umem_1' }, ownerChat);
    expect(r).toMatchObject({ ok: false, reason: 'classification_blocked' });
  });
});

// ── the check before asking ─────────────────────────────────────────

describe('D-329 — a memory write is checked before the owner is asked', () => {
  // ⛔ A held write's own refusal must answer before the ask: the owner would approve it
  // and then read that it did not run.
  const check = (h: Harness, tool: 'memory.write' | 'memory.forget', args: unknown, source: ExecutionSource) =>
    buildChatToolRegistryInputs(h.deps).tier1Checks[tool]!(args, ctx(source));

  it('memory.write: refuses what the write would refuse, replaces included, and writes nothing', async () => {
    const h = harness();
    const theirs = okResult<{ memory_id: string }>(await write(h, door('door-a'), 'Door A saved this'));
    const a = okResult<{ memory_id: string }>(await write(h, ownerChat, 'v1'));
    const b = okResult<{ memory_id: string }>(await write(h, ownerChat, 'v2', a.memory_id));
    const before = (await h.store.list()).map((row) => row.memory_id);
    expect(await check(h, 'memory.write', { summary: 'Mine', replaces: theirs.memory_id }, ownerChat))
      .toMatchObject({ ok: false, reason: 'invalid_args', detail: expect.stringMatching(/was not saved by you/) });
    expect(await check(h, 'memory.write', { summary: 'v3', replaces: a.memory_id }, ownerChat))
      .toMatchObject({ ok: false, detail: expect.stringContaining(`already replaced by '${b.memory_id}'`) });
    expect(await check(h, 'memory.write', { summary: '  ' }, ownerChat)).toMatchObject({ ok: false, reason: 'invalid_args' });
    // What would run, runs nothing yet.
    expect(await check(h, 'memory.write', { summary: 'v3', replaces: b.memory_id }, ownerChat)).toBeNull();
    expect(await check(h, 'memory.write', { summary: 'A new one' }, ownerChat)).toBeNull();
    expect((await h.store.list()).map((row) => row.memory_id)).toEqual(before);
  });

  it('memory.forget: refuses another contract\'s entry, and marks nothing either way', async () => {
    const h = harness();
    const mine = okResult<{ memory_id: string }>(await write(h, door('door-a'), 'mine'));
    const owners = okResult<{ memory_id: string }>(await write(h, ownerChat, 'the owner chat saved this'));
    expect(await check(h, 'memory.forget', { memory_id: owners.memory_id }, door('door-a')))
      .toMatchObject({ ok: false, reason: 'invalid_args', detail: expect.stringMatching(/was not saved by you/) });
    expect(await check(h, 'memory.forget', { memory_id: 'umem_404' }, door('door-a')))
      .toMatchObject({ ok: false, detail: expect.stringMatching(/no memory with id/) });
    expect(await check(h, 'memory.forget', { memory_id: mine.memory_id }, door('door-a'))).toBeNull();
    expect(await h.redactions.list()).toEqual([]);
  });
});

// ── recall ──────────────────────────────────────────────────────────

describe('recall after a revision', () => {
  it("marks by_you on the caller's own entries only", async () => {
    const h = harness();
    okResult(await write(h, ownerChat, 'chat entry'));
    okResult(await write(h, door('door-a'), 'door entry'));
    const mine = await recalled(h, door('door-a'));
    expect(mine.find((m) => m.summary === 'door entry')?.by_you).toBe(true);
    expect(mine.find((m) => m.summary === 'chat entry')).not.toHaveProperty('by_you');
  });

  it('a by-id fetch of a replaced entry names the current version', async () => {
    const h = harness();
    const a = okResult<{ memory_id: string }>(await write(h, ownerChat, 'v1'));
    const b = okResult<{ memory_id: string }>(await write(h, ownerChat, 'v2', a.memory_id));
    const c = okResult<{ memory_id: string }>(await write(h, ownerChat, 'v3', b.memory_id));
    const [fetched] = await recalled(h, ownerChat, { memory_id: a.memory_id });
    expect(fetched).toMatchObject({ memory_id: a.memory_id, replaced_by: c.memory_id });
  });

  it('the owner forgetting the newer version makes the older one current again', async () => {
    const h = harness();
    const a = okResult<{ memory_id: string }>(await write(h, ownerChat, 'the right one'));
    const b = okResult<{ memory_id: string }>(await write(h, ownerChat, 'a wrong correction', a.memory_id));
    await h.redactions.set(b.memory_id, { memory_id: b.memory_id, redacted_at: 1 });
    expect((await recalled(h, ownerChat)).map((m) => m.memory_id)).toEqual([a.memory_id]);
  });

  it('ranked recall skips a replaced entry on the SQLite store, through the replaces index', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'd198-10-'));
    const db = new Database(join(dir, 'm.db'));
    try {
      const store = createUserMemoryStore(
        createSQLiteCollection<UserMemoryRow>(db, 'user_memory'),
        createBlobStore(join(dir, 'memory_blobs')),
        { db },
      );
      const h = harness(store);
      const a = okResult<{ memory_id: string }>(await write(h, ownerChat, 'Parking at the Pearse Street office is free'));
      const b = okResult<{ memory_id: string }>(
        await write(h, ownerChat, 'Parking at the Pearse Street office costs a day pass since May', a.memory_id),
      );
      expect((await store.replacementsOf(a.memory_id)).map((r) => r.memory_id)).toEqual([b.memory_id]);
      const ranked = await recalled(h, ownerChat, { query: 'Pearse Street parking' });
      expect(ranked.map((m) => m.memory_id)).toEqual([b.memory_id]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── the owner's feed and restore ────────────────────────────────────

describe("the owner's feed, detail and restore", () => {
  it('marks both ends of a replacement and who forgot what', async () => {
    const h = harness();
    const a = okResult<{ memory_id: string }>(await write(h, ownerChat, 'v1'));
    const b = okResult<{ memory_id: string }>(await write(h, ownerChat, 'v2', a.memory_id));
    const c = okResult<{ memory_id: string }>(await write(h, door('door-a'), 'door note'));
    okResult(await h.call('memory.forget', { memory_id: c.memory_id, reason: 'duplicate' }, door('door-a')));

    const byId = new Map((await handleMemoryList(h.rpcDeps, {})).entries.map((e) => [e.memory_id, e]));
    expect(byId.get(a.memory_id)).toMatchObject({ replaced_by: b.memory_id });
    expect(byId.get(b.memory_id)).toMatchObject({ replaces: a.memory_id });
    expect(byId.get(c.memory_id)).toMatchObject({
      redacted: true, forgotten_by: 'an agent, under contract door-a', forgotten_reason: 'duplicate',
    });
    expect(await handleMemoryGet(h.rpcDeps, { memory_id: a.memory_id })).toMatchObject({ replaced_by: b.memory_id });
  });

  it('names the owner chat as "your chat"', async () => {
    const h = harness();
    const a = okResult<{ memory_id: string }>(await write(h, ownerChat, 'chat note'));
    okResult(await h.call('memory.forget', { memory_id: a.memory_id }, ownerChat));
    expect(await handleMemoryGet(h.rpcDeps, { memory_id: a.memory_id })).toMatchObject({
      redacted: true, forgotten_by: 'your chat',
    });
  });

  it('memory.restore lifts every mark of one forget, named by any version it covered', async () => {
    const h = harness();
    const a = okResult<{ memory_id: string }>(await write(h, ownerChat, 'v1'));
    const b = okResult<{ memory_id: string }>(await write(h, ownerChat, 'v2', a.memory_id));
    okResult(await h.call('memory.forget', { memory_id: b.memory_id }, ownerChat));
    expect(await handleMemoryRestore(h.rpcDeps, { memory_id: a.memory_id })).toEqual({ memory_id: a.memory_id, restored: 2 });
    expect(await h.redactions.list()).toEqual([]);
    expect((await recalled(h, ownerChat)).map((m) => m.memory_id)).toEqual([b.memory_id]);
  });

  it("⛔ the owner's own redaction is not restorable through memory.restore", async () => {
    const h = harness();
    const a = okResult<{ memory_id: string }>(await write(h, ownerChat, 'redacted by the owner'));
    await h.redactions.set(a.memory_id, { memory_id: a.memory_id, redacted_at: 1 });
    await expect(handleMemoryRestore(h.rpcDeps, { memory_id: a.memory_id })).rejects.toThrow(/no agent forgot that memory/);
    expect(await h.redactions.get(a.memory_id)).not.toBeNull();
  });
});

// ── recipes ─────────────────────────────────────────────────────────

describe('recipes — data.memory.<id>', () => {
  it('resolves a forgotten entry absent and a live one in full', async () => {
    const h = harness();
    const live = okResult<{ memory_id: string }>(await write(h, ownerChat, 'still here'));
    const gone = okResult<{ memory_id: string }>(await write(h, ownerChat, 'forgotten'));
    okResult(await h.call('memory.forget', { memory_id: gone.memory_id }, ownerChat));
    const scope = vi.fn();
    const lookup = createDataMemoryLookup(h.store, h.redactions, scope);
    expect(await lookup(live.memory_id)).toMatchObject({ memory_id: live.memory_id, summary: 'still here' });
    expect(await lookup(gone.memory_id)).toBeNull();
    expect(scope).toHaveBeenCalled();
  });
});

// ── §12: the owner replaces an agent's entry ───────────────────────────

describe('memory.replace — the owner puts their own version in an agent entry\'s place (§12)', () => {
  const replace = (h: Harness, memory_id: string, summary: string) =>
    handleMemoryReplace(h.rpcDeps, { memory_id, kind: 'note', summary, body: `${summary}, in full` });

  it('writes a NEW note of yours that replaces it; the agent row is untouched; recall and the feed follow', async () => {
    const h = harness();
    const agents = okResult<{ memory_id: string }>(await write(h, ownerChat, 'Dana prefers phone calls'));
    const before = await h.store.getRow(agents.memory_id);

    const mine = await replace(h, agents.memory_id, 'Dana prefers email');
    const row = await h.store.getRow(mine.memory_id);
    expect(row).toMatchObject({ origin_actor: 'user_self', replaces: agents.memory_id, summary: 'Dana prefers email' });
    expect(await h.store.getRow(agents.memory_id)).toEqual(before);

    expect((await recalled(h, ownerChat)).map((m) => m.memory_id)).toEqual([mine.memory_id]);
    const feed = (await handleMemoryList(h.rpcDeps, {})).entries;
    expect(feed.find((e) => e.memory_id === agents.memory_id)?.replaced_by).toBe(mine.memory_id);
    expect(feed.find((e) => e.memory_id === mine.memory_id)?.replaces).toBe(agents.memory_id);
  });

  it("keeps the replaced entry's links and event time, unless you give a time", async () => {
    const h = harness();
    const agents = await h.store.writeAuthored({
      origin_actor: 'contracted_user', author_contract_id: 'door-a', kind: 'fact', summary: 'met at the expo',
      event_at: 111, provenance_entity_ids: ['contact:dana@example.com'],
    });
    const kept = await replace(h, agents.memory_id, 'met at the trade fair');
    expect(kept.provenance_edges_written).toBe(1);
    expect(await h.store.getRow(kept.memory_id)).toMatchObject({
      event_at: 111, provenance_entity_ids: ['contact:dana@example.com'],
    });

    const other = await h.store.writeAuthored({ origin_actor: 'contracted_user', author_contract_id: 'door-a', kind: 'fact', summary: 'x', event_at: 111 });
    const timed = await handleMemoryReplace(h.rpcDeps, { memory_id: other.memory_id, kind: 'fact', summary: 'y', event_at: 222 });
    expect((await h.store.getRow(timed.memory_id))?.event_at).toBe(222);
  });

  it("deleting your version makes the agent's entry current again", async () => {
    const h = harness();
    const agents = okResult<{ memory_id: string }>(await write(h, ownerChat, 'the gate code is 1234'));
    const mine = await replace(h, agents.memory_id, 'the gate code is 4321');
    expect(await handleMemoryDelete(h.rpcDeps, { memory_id: mine.memory_id })).toMatchObject({ deleted: true });
    expect((await recalled(h, ownerChat)).map((m) => m.memory_id)).toEqual([agents.memory_id]);
  });

  it('⛔ refuses your own note, a forgotten entry, one a newer version replaced, and a run — and writes nothing', async () => {
    const h = harness();
    const own = await handleMemoryCreate(h.rpcDeps, { kind: 'note', summary: 'mine' });
    const forgotten = okResult<{ memory_id: string }>(await write(h, ownerChat, 'old'));
    okResult(await h.call('memory.forget', { memory_id: forgotten.memory_id }, ownerChat));
    const v1 = okResult<{ memory_id: string }>(await write(h, ownerChat, 'v1'));
    okResult(await write(h, ownerChat, 'v2', v1.memory_id));
    const rows = (await h.store.list()).length;

    await expect(replace(h, own.memory_id, 'x')).rejects.toThrow(/your own memory\. Edit it instead/);
    await expect(replace(h, forgotten.memory_id, 'x')).rejects.toThrow(/was forgotten\. Restore it first/);
    await expect(replace(h, v1.memory_id, 'x')).rejects.toThrow(/A newer version already replaced this memory/);
    await expect(replace(h, `${USER_MEMORY_ID_PREFIX}missing`, 'x')).rejects.toThrow(/not found/);
    const withRun: MemoryRpcDeps = {
      ...h.rpcDeps,
      auditLog: { get: async (id: string) => (id === 'run-1' ? { run_id: 'run-1' } : null) } as unknown as AuditLogStore,
    };
    await expect(handleMemoryReplace(withRun, { memory_id: 'run-1', kind: 'note', summary: 'x' }))
      .rejects.toThrow(/A run can’t be replaced\. Forget it instead/);
    expect((await h.store.list()).length).toBe(rows);
  });

  it("⛔ an agent cannot override it: its own corrected entry and your note are both refused, in words that say you corrected it", async () => {
    const h = harness();
    const agents = okResult<{ memory_id: string }>(await write(h, ownerChat, 'the office closes at 5'));
    const mine = await replace(h, agents.memory_id, 'the office closes at 6');

    const onCorrected = refusal(await write(h, ownerChat, 'the office closes at 4', agents.memory_id));
    expect(onCorrected).toMatch(/the owner replaced .* with their own version/);
    expect(onCorrected).not.toMatch(/as replaces instead/);
    expect(refusal(await write(h, ownerChat, 'the office closes at 4', mine.memory_id))).toMatch(/the owner's own entry/);
    expect((await recalled(h, ownerChat)).map((m) => m.memory_id)).toEqual([mine.memory_id]);
  });

  it("an agent forgetting its corrected entry leaves your version in recall", async () => {
    const h = harness();
    const agents = okResult<{ memory_id: string }>(await write(h, ownerChat, 'parking is on level 2'));
    const mine = await replace(h, agents.memory_id, 'parking is on level 3');
    okResult(await h.call('memory.forget', { memory_id: agents.memory_id }, ownerChat));
    expect((await recalled(h, ownerChat)).map((m) => m.memory_id)).toEqual([mine.memory_id]);
    expect(await h.redactions.get(mine.memory_id)).toBeNull();
  });

  it('your replace and an agent replace of one entry in the same tick: exactly one wins', async () => {
    const h = harness();
    const agents = okResult<{ memory_id: string }>(await write(h, ownerChat, 'v1'));
    const [owner, agent] = await Promise.allSettled([
      replace(h, agents.memory_id, 'yours'),
      write(h, ownerChat, 'theirs', agents.memory_id),
    ]);
    const agentWon = agent.status === 'fulfilled' && agent.value.ok;
    expect([owner.status === 'fulfilled', agentWon].filter(Boolean)).toHaveLength(1);
    expect(await h.store.replacementsOf(agents.memory_id)).toHaveLength(1);
  });
});

// ── the owner's edit ──────────────────────────────────────────────────

describe("memory.update — the owner edits only the notes they wrote", () => {
  it("⛔ refuses an agent's note and leaves it exactly as the agent wrote it, pointing at Replace", async () => {
    const h = harness();
    const agents = okResult<{ memory_id: string }>(await write(h, ownerChat, 'Dana prefers phone calls'));
    const before = await h.store.getRow(agents.memory_id);

    await expect(handleMemoryUpdate(h.rpcDeps, { memory_id: agents.memory_id, summary: 'Dana prefers email' }))
      .rejects.toThrow(/An agent saved this memory, so it can’t be edited\. Replace it with your version instead/);
    expect(await h.store.getRow(agents.memory_id)).toEqual(before);
    // the agent still sees its own words as its own, not the owner's
    const mine = (await recalled(h, ownerChat)).find((m) => m.memory_id === agents.memory_id);
    expect(mine).toMatchObject({ summary: 'Dana prefers phone calls', by_you: true });
  });

  it('edits your own note, and refuses an id that is not there', async () => {
    const h = harness();
    const own = await handleMemoryCreate(h.rpcDeps, { kind: 'note', summary: 'the gate code is 1234' });
    await handleMemoryUpdate(h.rpcDeps, { memory_id: own.memory_id, summary: 'the gate code is 4321' });
    expect((await h.store.getRow(own.memory_id))?.summary).toBe('the gate code is 4321');
    await expect(handleMemoryUpdate(h.rpcDeps, { memory_id: `${USER_MEMORY_ID_PREFIX}missing`, summary: 'x' }))
      .rejects.toThrow(/not found/);
  });
});

// ── §13: the owner deletes an agent's note ─────────────────────────────

describe("memory.delete on an agent's note — its text leaves the server (§13)", () => {
  it('erases the note and the earlier versions it replaced, keeps who and when, and no reader returns it', async () => {
    const h = harness();
    const v1 = okResult<{ memory_id: string }>(await write(h, ownerChat, 'The Dublin office is on Baggot Street'));
    const v2 = okResult<{ memory_id: string }>(await write(h, ownerChat, 'The Dublin office moved to Pearse Street', v1.memory_id));

    expect(await handleMemoryDelete(h.rpcDeps, { memory_id: v2.memory_id }))
      .toEqual({ memory_id: v2.memory_id, deleted: true, redacted: false });

    for (const id of [v1.memory_id, v2.memory_id]) {
      const row = await h.store.getRow(id);
      expect(row).toMatchObject({ memory_id: id, origin_actor: 'contracted_user', kind: 'chat_memory', size_bytes: 0 });
      expect(row?.author_contract_id).toBe(OWNER_CONTRACT_ID);
      for (const field of ['summary', 'body_inline', 'blob_hash', 'body_preview', 'content_hash', 'provenance_entity_ids'] as const) {
        expect(row?.[field], `${id}.${field}`).toBeUndefined();
      }
      expect(await h.redactions.get(id)).toEqual({ memory_id: id, redacted_at: 6000, deleted: true });
    }
    expect((await h.store.getRow(v2.memory_id))?.replaces).toBe(v1.memory_id);

    expect(await recalled(h, ownerChat)).toEqual([]);
    expect(await recalled(h, ownerChat, { query: 'Dublin office' })).toEqual([]);
    const feed = (await handleMemoryList(h.rpcDeps, {})).entries;
    expect(feed.find((e) => e.memory_id === v2.memory_id)).toMatchObject({ redacted: true, deleted_at: 6000 });
    expect(JSON.stringify(feed)).not.toMatch(/Baggot|Pearse/);
    expect(await handleMemoryGet(h.rpcDeps, { memory_id: v2.memory_id })).toMatchObject({ redacted: true, deleted_at: 6000 });
    expect(await createDataMemoryLookup(h.store, h.redactions, vi.fn())(v2.memory_id)).toBeNull();

    // Nothing brings it back, and nothing builds on it.
    await expect(handleMemoryRestore(h.rpcDeps, { memory_id: v2.memory_id })).rejects.toThrow(/no agent forgot/);
    await expect(handleMemoryReplace(h.rpcDeps, { memory_id: v2.memory_id, kind: 'note', summary: 'x' }))
      .rejects.toThrow(/You deleted this memory\. Add a new memory instead/);
    expect(refusal(await write(h, ownerChat, 'Pearse Street, again', v2.memory_id)))
      .toMatch(/was deleted by the owner, so there is nothing to replace; save a new memory instead/);
  });

  it('is neutral: the agent may save the same thing again, and it is live', async () => {
    const h = harness();
    const first = okResult<{ memory_id: string }>(await write(h, ownerChat, 'Dana prefers phone calls'));
    await handleMemoryDelete(h.rpcDeps, { memory_id: first.memory_id });
    const again = okResult<{ memory_id: string }>(await write(h, ownerChat, 'Dana prefers phone calls'));
    expect((await recalled(h, ownerChat)).map((m) => m.memory_id)).toEqual([again.memory_id]);
  });

  it('turns an earlier hide of the note into a delete, and leaves your Replace of it standing', async () => {
    const h = harness();
    const hidden = okResult<{ memory_id: string }>(await write(h, ownerChat, 'the old gate code is 1234'));
    await h.redactions.set(hidden.memory_id, { memory_id: hidden.memory_id, redacted_at: 1 });
    await handleMemoryDelete(h.rpcDeps, { memory_id: hidden.memory_id });
    expect((await h.store.getRow(hidden.memory_id))?.summary).toBeUndefined();
    expect(await h.redactions.get(hidden.memory_id)).toMatchObject({ deleted: true });

    const agents = okResult<{ memory_id: string }>(await write(h, ownerChat, 'the office closes at 5'));
    const mine = await handleMemoryReplace(h.rpcDeps, { memory_id: agents.memory_id, kind: 'note', summary: 'the office closes at 6' });
    await handleMemoryDelete(h.rpcDeps, { memory_id: agents.memory_id });
    expect((await h.store.getRow(mine.memory_id))?.summary).toBe('the office closes at 6');
    expect(await h.redactions.get(mine.memory_id)).toBeNull();
    expect((await recalled(h, ownerChat)).map((m) => m.memory_id)).toEqual([mine.memory_id]);
  });

  it("on the SQLite store: its words leave the search index, and a large body's blob is freed unless another note shares it", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'd198-13-'));
    const db = new Database(join(dir, 'm.db'));
    try {
      const blobs = createBlobStore(join(dir, 'memory_blobs'));
      const store = createUserMemoryStore(createSQLiteCollection<UserMemoryRow>(db, 'user_memory'), blobs, { db });
      const h = harness(store);
      const big = `Quarterly figures for Baggot Street. ${'x'.repeat(70_000)}`;
      const a = await store.writeAuthored({ origin_actor: 'contracted_user', author_contract_id: 'door-a', kind: 'fact', summary: 'Baggot Street figures', body: big });
      const b = await store.writeAuthored({ origin_actor: 'contracted_user', author_contract_id: 'door-a', kind: 'fact', summary: 'the same figures', body: big });
      const shared = (await store.getRow(a.memory_id))?.blob_hash;
      expect(shared).toBeDefined();
      expect((await store.getRow(b.memory_id))?.blob_hash).toBe(shared);

      await handleMemoryDelete(h.rpcDeps, { memory_id: a.memory_id });
      expect(await blobs.has(shared!)).toBe(true); // b still holds that text
      expect((await store.search('Baggot', 10)).hits.map((x) => x.memory_id)).not.toContain(a.memory_id);

      await handleMemoryDelete(h.rpcDeps, { memory_id: b.memory_id });
      expect(await blobs.has(shared!)).toBe(false);
      expect((await store.search('figures', 10)).hits).toEqual([]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── §13: what a model is told about a past memory.* row ───────────────

describe("describeMemoryNow — where the notes a past memory.* row names stand now (§13)", () => {
  it('one line per note that changed — removed with its date, replaced and by whom — and none for one still current', async () => {
    const h = harness();
    const current = okResult<{ memory_id: string }>(await write(h, ownerChat, 'still true'));
    const old = okResult<{ memory_id: string }>(await write(h, ownerChat, 'v1'));
    const newer = okResult<{ memory_id: string }>(await write(h, ownerChat, 'v2', old.memory_id));
    const corrected = okResult<{ memory_id: string }>(await write(h, ownerChat, 'closes at 5'));
    const yours = await handleMemoryReplace(h.rpcDeps, { memory_id: corrected.memory_id, kind: 'note', summary: 'closes at 6' });
    const forgotten = okResult<{ memory_id: string }>(await write(h, ownerChat, 'forget me'));
    okResult(await h.call('memory.forget', { memory_id: forgotten.memory_id }, ownerChat));
    const deleted = okResult<{ memory_id: string }>(await write(h, ownerChat, 'delete me'));
    await handleMemoryDelete(h.rpcDeps, { memory_id: deleted.memory_id });
    const mine = await handleMemoryCreate(h.rpcDeps, { kind: 'note', summary: 'mine' });
    await handleMemoryDelete(h.rpcDeps, { memory_id: mine.memory_id });

    const ids = [current, old, corrected, forgotten, deleted, mine].map((x) => x.memory_id);
    expect(Object.fromEntries(await describeMemoryNow(h.store, h.redactions, ids))).toEqual({
      [old.memory_id]: `${old.memory_id}: a newer version replaced it, ${newer.memory_id}.`,
      [corrected.memory_id]: `${corrected.memory_id}: the owner replaced it with their own version, ${yours.memory_id}.`,
      [forgotten.memory_id]: `${forgotten.memory_id}: no longer in memory (removed 1970-01-01).`,
      [deleted.memory_id]: `${deleted.memory_id}: no longer in memory (removed 1970-01-01).`,
      [mine.memory_id]: `${mine.memory_id}: no longer in memory.`,
    });
    // ⛔ neutral: nothing in a removal line reads as a rule about saving it again
    for (const line of (await describeMemoryNow(h.store, h.redactions, ids)).values()) {
      expect(line).not.toMatch(/don't|do not|never|ask/i);
    }
  });
});

// ── §13: the owner revokes an agent's note ─────────────────────────────

describe("memory.revoke — the owner marks an agent's note wrong (§13)", () => {
  it('keeps the text for the owner, takes it and its earlier versions out of recall as facts, and un-revoke puts them back', async () => {
    const h = harness();
    const v1 = okResult<{ memory_id: string }>(await write(h, ownerChat, 'Dana prefers phone calls'));
    const v2 = okResult<{ memory_id: string }>(await write(h, ownerChat, 'Dana prefers phone calls, in the morning', v1.memory_id));

    expect(await handleMemoryRevoke(h.rpcDeps, { memory_id: v2.memory_id })).toEqual({ memory_id: v2.memory_id, versions: 2 });
    for (const id of [v1.memory_id, v2.memory_id]) {
      expect(await h.redactions.get(id)).toEqual({ memory_id: id, redacted_at: 6000, revoked: true, revoke_of: v2.memory_id });
    }
    expect((await h.store.getRow(v2.memory_id))?.summary).toBe('Dana prefers phone calls, in the morning');

    // Out of recall as a fact — and revoking the newer wording does not bring the older one back.
    expect(await recalled(h, ownerChat)).toEqual([]);
    expect(await createDataMemoryLookup(h.store, h.redactions, vi.fn())(v2.memory_id)).toBeNull();
    // The owner still sees what they revoked.
    const feed = (await handleMemoryList(h.rpcDeps, {})).entries.find((e) => e.memory_id === v2.memory_id);
    expect(feed).toMatchObject({ summary: 'Dana prefers phone calls, in the morning', revoked_at: 6000 });
    expect(feed?.redacted).toBeUndefined();
    expect(await handleMemoryGet(h.rpcDeps, { memory_id: v2.memory_id }))
      .toMatchObject({ summary: 'Dana prefers phone calls, in the morning', revoked_at: 6000 });

    // Un-revoke, named by ANY version it covered.
    expect(await handleMemoryUnrevoke(h.rpcDeps, { memory_id: v1.memory_id })).toEqual({ memory_id: v1.memory_id, versions: 2 });
    expect(await h.redactions.list()).toEqual([]);
    expect((await recalled(h, ownerChat)).map((m) => m.memory_id)).toEqual([v2.memory_id]);
  });

  it('⛔ refuses your own note, a run, a removed note, one already revoked, and a replaced version — and marks nothing', async () => {
    const h = harness();
    const own = await handleMemoryCreate(h.rpcDeps, { kind: 'note', summary: 'mine' });
    const gone = okResult<{ memory_id: string }>(await write(h, ownerChat, 'old'));
    okResult(await h.call('memory.forget', { memory_id: gone.memory_id }, ownerChat));
    const v1 = okResult<{ memory_id: string }>(await write(h, ownerChat, 'v1'));
    const v2 = okResult<{ memory_id: string }>(await write(h, ownerChat, 'v2', v1.memory_id));
    await handleMemoryRevoke(h.rpcDeps, { memory_id: v2.memory_id });
    const marksBefore = await h.redactions.list();

    await expect(handleMemoryRevoke(h.rpcDeps, { memory_id: own.memory_id })).rejects.toThrow(/your own memory\. Edit or delete it instead/);
    await expect(handleMemoryRevoke(h.rpcDeps, { memory_id: gone.memory_id })).rejects.toThrow(/was removed, so there is nothing to revoke/);
    await expect(handleMemoryRevoke(h.rpcDeps, { memory_id: v2.memory_id })).rejects.toThrow(/You already revoked this memory/);
    const v3 = okResult<{ memory_id: string }>(await write(h, ownerChat, 'w1'));
    okResult(await write(h, ownerChat, 'w2', v3.memory_id));
    await expect(handleMemoryRevoke(h.rpcDeps, { memory_id: v3.memory_id })).rejects.toThrow(/A newer version already replaced this memory\. Revoke that one instead/);
    const withRun: MemoryRpcDeps = {
      ...h.rpcDeps,
      auditLog: { get: async (id: string) => (id === 'run-1' ? { run_id: 'run-1' } : null) } as unknown as AuditLogStore,
    };
    await expect(handleMemoryRevoke(withRun, { memory_id: 'run-1' })).rejects.toThrow(/A run can’t be revoked\. Hide it from AI instead/);
    await expect(handleMemoryUnrevoke(h.rpcDeps, { memory_id: gone.memory_id })).rejects.toThrow(/not revoked/);
    expect(await h.redactions.list()).toEqual(marksBefore);
  });

  it('a revoked note can still get your version, which recall then returns, and it stays revoked', async () => {
    const h = harness();
    const agents = okResult<{ memory_id: string }>(await write(h, ownerChat, 'the office closes at 5'));
    await handleMemoryRevoke(h.rpcDeps, { memory_id: agents.memory_id });
    const mine = await handleMemoryReplace(h.rpcDeps, { memory_id: agents.memory_id, kind: 'note', summary: 'the office closes at 6' });
    expect((await recalled(h, ownerChat)).map((m) => m.memory_id)).toEqual([mine.memory_id]);
    expect(await h.redactions.get(agents.memory_id)).toMatchObject({ revoked: true });
    const feed = (await handleMemoryList(h.rpcDeps, {})).entries.find((e) => e.memory_id === agents.memory_id);
    expect(feed).toMatchObject({ revoked_at: 6000, replaced_by: mine.memory_id });
  });

  it('Delete on a revoked note erases it and ends the revoke; Restore never lifts one', async () => {
    const h = harness();
    const agents = okResult<{ memory_id: string }>(await write(h, ownerChat, 'the gate code is 1234'));
    await handleMemoryRevoke(h.rpcDeps, { memory_id: agents.memory_id });
    await expect(handleMemoryRestore(h.rpcDeps, { memory_id: agents.memory_id })).rejects.toThrow(/no agent forgot/);
    await handleMemoryDelete(h.rpcDeps, { memory_id: agents.memory_id });
    expect(await h.redactions.get(agents.memory_id)).toMatchObject({ deleted: true });
    expect((await h.redactions.get(agents.memory_id))?.revoked).toBeUndefined();
    expect((await h.store.getRow(agents.memory_id))?.summary).toBeUndefined();
  });

  it("the agent is told its revoked note was marked wrong, and a recalled save of it carries the owner's rule", async () => {
    const h = harness();
    const agents = okResult<{ memory_id: string }>(await write(h, ownerChat, 'Dana prefers phone calls'));
    await handleMemoryRevoke(h.rpcDeps, { memory_id: agents.memory_id });
    expect(refusal(await write(h, ownerChat, 'Dana prefers calls', agents.memory_id)))
      .toMatch(/the owner marked '.*' wrong, so there is nothing to replace; if you have the correct version, save it as a new memory/);
    expect(Object.fromEntries(await describeMemoryNow(h.store, h.redactions, [agents.memory_id]))).toEqual({
      [agents.memory_id]: `${agents.memory_id}: the owner marked it wrong on 1970-01-01. Don't rely on it; ask before saving it again.`,
    });
  });
});

// ── §13 slice 3b: saving a revoked claim again ─────────────────────────

describe('the claim words — a naming word reads as "called" (§13)', () => {
  it('reads "named", "name", "names" and "known as" as "called", and "known" alone as itself', () => {
    const called = claimWords("Dana's daughter is called Mia");
    for (const text of ["Dana's daughter is named Mia", "Dana's daughter's name is Mia", "Dana's daughter is known as Mia"]) {
      expect(claimWords(text)).toEqual(called);
    }
    expect(claimWords("Dana's daughters' names are Mia and Leo"))
      .toEqual(claimWords("Dana's daughters are called Mia and Leo"));
    expect(claimWords('Dana is known for her cooking')).toEqual(new Set(['dana', 'known', 'cooking']));
  });
});

describe('saving a claim the owner revoked, again (§13 slice 3b)', () => {
  const check = (h: Harness, args: unknown, source: ExecutionSource) =>
    buildChatToolRegistryInputs(h.deps).tier1Checks['memory.write']!(args, ctx(source));
  const revokedClaim = async (h: Harness) => {
    const wrong = okResult<{ memory_id: string }>(await write(h, ownerChat, 'Dana prefers phone calls'));
    await handleMemoryRevoke(h.rpcDeps, { memory_id: wrong.memory_id });
    return wrong.memory_id;
  };

  it('is refused once, quoting the rejection — before the owner is asked and in the write itself — and writes nothing', async () => {
    const h = harness();
    const wrongId = await revokedClaim(h);
    const rows = (await h.store.list()).length;
    const quoted = new RegExp(
      `the owner marked a memory like this wrong on 1970-01-01: "Dana prefers phone calls" \\('${wrongId}'\\)\\. Don't save it\\.`
      + `.*despite_revoked: '${wrongId}'`,
    );
    expect(await check(h, { summary: 'Dana prefers phone calls' }, ownerChat)).toMatchObject({ ok: false, detail: expect.stringMatching(quoted) });
    expect(refusal(await write(h, ownerChat, 'Dana prefers phone calls'))).toMatch(quoted);
    // the same claim with more around it, which the search cannot see from the save's side
    expect(refusal(await write(h, door('door-a'), 'Dana prefers phone calls in the morning'))).toMatch(quoted);
    expect((await h.store.list()).length).toBe(rows);
  });

  it('lets an unrelated save through, and a claim that only shares a word with it', async () => {
    const h = harness();
    await revokedClaim(h);
    expect(await check(h, { summary: "Dana's birthday is in May" }, ownerChat)).toBeNull();
    okResult(await write(h, ownerChat, 'Phone calls go to the front desk'));
  });

  it('the naming words are one word to it, both ways round; another name is another claim', async () => {
    const pairs = [
      ['called', 'named'], ['named', 'called'], ['called', 'name'], ['name', 'named'],
      ['called', 'known as'], ['known as', 'called'],
    ] as const;
    for (const [revokedAs, savedAs] of pairs) {
      const h = harness();
      const revokedText = daughterClaim(revokedAs, 'Mia');
      const wrong = okResult<{ memory_id: string }>(await write(h, ownerChat, revokedText));
      await handleMemoryRevoke(h.rpcDeps, { memory_id: wrong.memory_id });
      const quoted = `"${revokedText}" ('${wrong.memory_id}')`;
      // the revoked note's words all in the save
      expect(refusal(await write(h, ownerChat, `${daughterClaim(savedAs, 'Mia')}, and she is seven`)))
        .toContain(quoted);
      // the save's words all in the revoked note, which the search reads only as spelled
      expect(refusal(await write(h, ownerChat, daughterClaim(savedAs, 'Mia', "Dana's")))).toContain(quoted);
      expect(await check(h, { summary: daughterClaim(savedAs, 'Maya') }, ownerChat)).toBeNull();
    }
  });

  it('despite_revoked saves it on purpose: the new note takes the revoked one\'s place and the revoke closes', async () => {
    const h = harness();
    const wrongId = await revokedClaim(h);
    expect(await check(h, { summary: 'Dana prefers phone calls', despite_revoked: wrongId }, ownerChat)).toBeNull();
    const again = okResult<{ memory_id: string; revoke_closed: string }>(
      await h.call('memory.write', { summary: 'Dana prefers phone calls', despite_revoked: wrongId }, ownerChat),
    );
    expect(again.revoke_closed).toBe(wrongId);
    expect((await h.store.getRow(again.memory_id))?.replaces).toBe(wrongId);
    expect(await h.redactions.get(wrongId)).toBeNull();
    expect((await recalled(h, ownerChat)).map((m) => m.memory_id)).toEqual([again.memory_id]);
    // closed: the claim no longer trips anything
    expect(await check(h, { summary: 'Dana prefers phone calls' }, ownerChat)).toBeNull();
  });

  it('⛔ where the owner also wrote their own version, no save goes over it: the agent is told to leave it', async () => {
    const h = harness();
    const wrongId = await revokedClaim(h);
    const theirs = await handleMemoryReplace(h.rpcDeps, { memory_id: wrongId, kind: 'note', summary: 'Dana prefers email' });
    const refused = refusal(await write(h, ownerChat, 'Dana prefers phone calls'));
    expect(refused).toBe(
      `the owner marked a memory like this wrong on 1970-01-01: "Dana prefers phone calls" ('${wrongId}'), and wrote their `
      + `own version ('${theirs.memory_id}'). Don't save it; if it looks wrong, tell the user`,
    );
    const owners = `the owner replaced '${wrongId}' with their own version ('${theirs.memory_id}'). Leave it as it is; if it looks wrong, tell the user`;
    expect(await check(h, { summary: 'Dana prefers phone calls', despite_revoked: wrongId }, ownerChat))
      .toMatchObject({ ok: false, detail: expect.stringContaining(owners) });
    expect(refusal(await h.call('memory.write', { summary: 'Dana prefers phone calls', despite_revoked: wrongId }, ownerChat)))
      .toContain(owners);
    expect(await h.redactions.get(wrongId)).toMatchObject({ revoked: true });
    expect(Object.fromEntries(await describeMemoryNow(h.store, h.redactions, [wrongId]))).toEqual({
      [wrongId]: `${wrongId}: the owner marked it wrong on 1970-01-01 and replaced it with their own version, ${theirs.memory_id}.`,
    });
  });

  it('the same when the save matches an older version of the note the owner revoked', async () => {
    const h = harness();
    const first = okResult<{ memory_id: string }>(await write(h, ownerChat, 'Dana prefers phone calls'));
    const second = okResult<{ memory_id: string }>(await write(h, ownerChat, 'Dana likes a morning call', first.memory_id));
    await handleMemoryRevoke(h.rpcDeps, { memory_id: second.memory_id });
    const theirs = await handleMemoryReplace(h.rpcDeps, { memory_id: second.memory_id, kind: 'note', summary: 'Dana prefers email' });
    expect(refusal(await write(h, ownerChat, 'Dana prefers phone calls')))
      .toContain(`('${first.memory_id}'), and wrote their own version ('${theirs.memory_id}')`);
    expect(refusal(await h.call('memory.write', { summary: 'Dana prefers phone calls', despite_revoked: first.memory_id }, ownerChat)))
      .toContain(`with their own version ('${theirs.memory_id}'). Leave it as it is`);
  });

  it('⛔ refuses despite_revoked naming a note that is not revoked, and despite_revoked with replaces', async () => {
    const h = harness();
    const live = okResult<{ memory_id: string }>(await write(h, ownerChat, 'Parking is on level 2'));
    expect(refusal(await h.call('memory.write', { summary: 'x', despite_revoked: live.memory_id }, ownerChat)))
      .toMatch(/is not a memory the owner revoked/);
    expect(refusal(await h.call('memory.write', { summary: 'x', despite_revoked: live.memory_id, replaces: live.memory_id }, ownerChat)))
      .toMatch(/pass replaces or despite_revoked, not both/);
  });

  it('⛔ no standing write rule stands in for a save naming despite_revoked — it always reaches the owner', () => {
    const rule = { rule_id: 'r1', uses_remaining: 3 };
    const store = { use: vi.fn(() => rule) } as unknown as WriteRuleStore;
    expect(useWriteRule(store, ownerChat, 'memory.write', { summary: 'Dana prefers phone calls' })).toBe(rule);
    expect(useWriteRule(store, ownerChat, 'memory.write', { summary: 'Dana prefers phone calls', despite_revoked: 'umem_1' }))
      .toBeUndefined();
    expect(store.use).toHaveBeenCalledTimes(1);
  });
});

// ── §13 slice 3c: recall tells an agent what the owner revoked ──────────

describe('memory.search returns a revoked note as the owner\'s rejection (§13 slice 3c)', () => {
  type SearchResult = {
    memories: Array<Record<string, unknown>>;
    rejected?: Array<{ memory_id: string; summary?: string; revoked_at: number; note: string }>;
    hint?: string;
    next_cursor?: string;
  };
  const search = async (h: Harness, args: Record<string, unknown>) =>
    okResult<SearchResult>(await h.call('memory.search', args, ownerChat));

  it('a query reaching only a revoked note gets it back as rejected, never as a memory', async () => {
    const h = harness();
    const wrong = okResult<{ memory_id: string }>(await write(h, ownerChat, 'Dana prefers phone calls'));
    await handleMemoryRevoke(h.rpcDeps, { memory_id: wrong.memory_id });
    const got = await search(h, { query: 'Dana phone calls' });
    expect(got.memories).toEqual([]);
    expect(got.rejected).toEqual([{
      memory_id: wrong.memory_id,
      summary: 'Dana prefers phone calls',
      revoked_at: 6000,
      note: 'The owner marked this wrong. Do not state it as true, and ask them before saving it again.',
    }]);
    expect(got.hint).toMatch(/the owner marked a matching memory wrong/);
  });

  it('sits beside the live answer; a listing and a loose match carry none', async () => {
    const h = harness();
    const wrong = okResult<{ memory_id: string }>(await write(h, ownerChat, 'Dana prefers phone calls'));
    await handleMemoryRevoke(h.rpcDeps, { memory_id: wrong.memory_id });
    const right = await handleMemoryCreate(h.rpcDeps, { kind: 'note', summary: 'Dana prefers phone calls in writing first' });
    const both = await search(h, { query: 'Dana phone calls' });
    expect(both.memories.map((m) => m.memory_id)).toEqual([right.memory_id]);
    expect(both.rejected?.map((r) => r.memory_id)).toEqual([wrong.memory_id]);
    expect((await search(h, {})).rejected).toBeUndefined();
    expect((await search(h, { query: 'Dana birthday party' })).rejected).toBeUndefined();
    expect((await search(h, { query: 'Dana phone calls', until: 1 })).rejected).toBeUndefined();
    expect((await search(h, { query: 'Dana phone calls', since: 1e12 })).rejected).toBeUndefined();
  });

  it('the naming words are one word to it: a query worded any of the ways reaches the note', async () => {
    const pairs = [
      ['called', 'named'], ['named', 'called'], ['called', 'name'], ['name', 'called'],
      ['called', 'known as'], ['known as', 'called'],
    ] as const;
    for (const [revokedAs, askedAs] of pairs) {
      const h = harness();
      const wrong = okResult<{ memory_id: string }>(await write(h, ownerChat, daughterClaim(revokedAs, 'Mia')));
      await handleMemoryRevoke(h.rpcDeps, { memory_id: wrong.memory_id });
      const got = await search(h, { query: `Dana Whitfield daughter ${askedAs}` });
      expect(got.memories).toEqual([]);
      expect(got.rejected?.map((r) => r.memory_id)).toEqual([wrong.memory_id]);
      expect(got.hint).toMatch(/the owner marked a matching memory wrong/);
      expect((await search(h, { query: `daughter ${askedAs} Maya` })).rejected).toBeUndefined();
      expect((await search(h, { query: `Dana Whitfield daughter ${askedAs}`, until: 1 })).rejected).toBeUndefined();
    }
  });

  it('one entry per revoke, though every version it covers matches', async () => {
    const h = harness();
    const first = okResult<{ memory_id: string }>(await write(h, ownerChat, 'Dana prefers phone calls'));
    const second = okResult<{ memory_id: string }>(
      await write(h, ownerChat, 'Dana prefers phone calls after five', first.memory_id),
    );
    expect((await handleMemoryRevoke(h.rpcDeps, { memory_id: second.memory_id })).versions).toBe(2);
    const got = await search(h, { query: 'Dana phone calls' });
    expect(got.rejected).toHaveLength(1);
    expect([first.memory_id, second.memory_id]).toContain(got.rejected![0]!.memory_id);
  });

  it('at most three, and only on the first page', async () => {
    const h = harness();
    for (let i = 0; i < 4; i += 1) {
      const wrong = okResult<{ memory_id: string }>(await write(h, ownerChat, `Dana prefers phone calls ${i}`));
      await handleMemoryRevoke(h.rpcDeps, { memory_id: wrong.memory_id });
    }
    for (let i = 0; i < 21; i += 1) {
      await handleMemoryCreate(h.rpcDeps, { kind: 'note', summary: `Dana prefers phone calls, noted ${i}` });
    }
    const first = await search(h, { query: 'Dana phone calls' });
    expect(first.rejected).toHaveLength(3);
    expect(first.next_cursor).toBeDefined();
    expect((await search(h, { query: 'Dana phone calls', cursor: first.next_cursor })).rejected).toBeUndefined();
  });

  it('a meaning-only match carries none', async () => {
    const pool = makePool();
    let neighbour = '';
    const h = harness({
      ...pool,
      vectorCoverage: () => ({ embedded: 1, model: 'm' }),
      semanticSearch: () => [{ memory_id: neighbour, rank: -0.9 }],
    });
    h.deps.getMemoryEmbedder = () => async () => ({ vector: [1], model: 'm' });
    neighbour = okResult<{ memory_id: string }>(await write(h, ownerChat, 'Dana prefers phone calls')).memory_id;
    await handleMemoryRevoke(h.rpcDeps, { memory_id: neighbour });
    const got = await search(h, { query: 'reaching her quickly' });
    expect(got.memories).toEqual([]);
    expect(got.rejected).toBeUndefined();
  });

  it('fetched by its id, a revoked note comes back as the rejection, not as forgotten', async () => {
    const h = harness();
    const wrong = okResult<{ memory_id: string }>(await write(h, ownerChat, 'Dana prefers phone calls'));
    await handleMemoryRevoke(h.rpcDeps, { memory_id: wrong.memory_id });
    const got = await search(h, { memory_id: wrong.memory_id });
    expect(got.memories).toEqual([]);
    expect(got.rejected?.map((r) => [r.memory_id, r.summary])).toEqual([[wrong.memory_id, 'Dana prefers phone calls']]);
    expect(got.hint).toBe(`the owner marked '${wrong.memory_id}' wrong — see rejected`);
    // A forget is still a forget.
    const gone = okResult<{ memory_id: string }>(await write(h, ownerChat, 'Dana has a dog'));
    okResult(await h.call('memory.forget', { memory_id: gone.memory_id }, ownerChat));
    const forgotten = await search(h, { memory_id: gone.memory_id });
    expect(forgotten.rejected).toBeUndefined();
    expect(forgotten.hint).toBe('that memory was forgotten');
  });
});

// ── §13: the Delete confirm's count ────────────────────────────────────

describe("memory.saves — how many times an agent saved a note's claim, for the Delete confirm (§13)", () => {
  const MIA = "Dana Whitfield's daughter is called Mia";
  /** An agent's note, saved in chat `chat`, as the chat tool saves one. */
  const saved = (h: Harness, summary: string, chat = 'sess-1', author: string = OWNER_CONTRACT_ID) =>
    h.store.writeAuthored({
      origin_actor: 'contracted_user', author_contract_id: author, kind: 'chat_memory', summary,
      session: { channel_session_id: chat },
    });
  /** What each chat records of its saves, as `createChatSavesReader` reads it. */
  const chats = (records: Record<string, string[]>): ChatSavesReader => async (ids) =>
    new Map(ids.filter((id) => id in records).map((id) => [id, records[id]!.map((summary) => ({ summary }))]));
  const savesOf = (h: Harness, memory_id: string, readChatSaves?: ChatSavesReader) =>
    handleMemorySaves({ ...h.rpcDeps, ...(readChatSaves !== undefined ? { readChatSaves } : {}) }, { memory_id });

  it('saved once, it says once', async () => {
    const h = harness();
    const note = await saved(h, MIA);
    expect(await savesOf(h, note.memory_id)).toEqual({ memory_id: note.memory_id, saves: 1, agents: 1 });
  });

  it('counts each earlier save the owner deleted, its words read back from the chat that saved it', async () => {
    // Saved, deleted, saved again (restated with more around it), deleted, saved again.
    const h = harness();
    const first = await saved(h, MIA, 'chat-a');
    await handleMemoryDelete(h.rpcDeps, { memory_id: first.memory_id });
    const restated = `${MIA}; she is seven`;
    const second = await saved(h, restated, 'chat-b');
    await handleMemoryDelete(h.rpcDeps, { memory_id: second.memory_id });
    const third = await saved(h, MIA, 'chat-c');
    const records = chats({ 'chat-a': [MIA], 'chat-b': [restated], 'chat-c': [MIA] });
    expect(await savesOf(h, third.memory_id, records)).toEqual({ memory_id: third.memory_id, saves: 3, agents: 1 });
    // Its words are in no note any more: without the chats, it counts the one it can see.
    expect((await savesOf(h, third.memory_id)).saves).toBe(1);
  });

  it('counts the earlier saves still holding their words — forgotten, hidden, revoked — and not a copy still in memory', async () => {
    const h = harness();
    const forgotten = okResult<{ memory_id: string }>(await write(h, ownerChat, MIA));
    okResult(await h.call('memory.forget', { memory_id: forgotten.memory_id }, ownerChat));
    const hidden = await saved(h, `${MIA}, and she is seven`);
    await h.redactions.set(hidden.memory_id, { memory_id: hidden.memory_id, redacted_at: 1 });
    const revoked = await saved(h, MIA);
    await handleMemoryRevoke(h.rpcDeps, { memory_id: revoked.memory_id });
    await saved(h, MIA); // a copy still in memory
    const elsewhere = okResult<{ memory_id: string }>(await write(h, ownerChat, 'Dana prefers phone calls'));
    okResult(await h.call('memory.forget', { memory_id: elsewhere.memory_id }, ownerChat));
    const note = await saved(h, `${MIA}. She is seven`);
    expect((await savesOf(h, note.memory_id)).saves).toBe(4);
  });

  it('the naming words are one word to it: two live runs\' saves, each counted 2 of 3 before', async () => {
    // Bench task 405, 2026-10-31, qwen3.7-plus: the claim saved in three chats, the first
    // two deleted. Each run wrote "named" in some saves and "called" in the others. The
    // third is made up: no run has written "her name is" or "known as" yet.
    const CALLED = `${MIA}.`;
    const NAMED = "Dana Whitfield's daughter is named Mia.";
    const NAME = "Dana Whitfield's daughter's name is Mia.";
    const KNOWN_AS = "Dana Whitfield's daughter is known as Mia.";
    const runs: ChatSave[][] = [
      [{ summary: CALLED, body: 'User noted that Dana Whitfield has a daughter named Mia.' }, { summary: CALLED }, { summary: NAMED }],
      [{ summary: NAMED }, { summary: CALLED }, { summary: NAMED }],
      [{ summary: NAME }, { summary: KNOWN_AS }, { summary: CALLED }],
    ];
    for (const run of runs) {
      const h = harness();
      const notes: UserMemoryRow[] = [];
      for (const [i, save] of run.entries()) {
        // The save's words only: a chat records a call's `claim` as the call wrote it, which
        // is not the claim a note stores (D-336).
        notes.push(await h.store.writeAuthored({
          origin_actor: 'contracted_user', author_contract_id: OWNER_CONTRACT_ID, kind: 'chat_memory',
          summary: save.summary, ...(save.body !== undefined ? { body: save.body } : {}),
          session: { channel_session_id: `chat-${i}` },
        }));
        if (i < 2) await handleMemoryDelete(h.rpcDeps, { memory_id: notes[i]!.memory_id });
      }
      const records: ChatSavesReader = async (ids) =>
        new Map(ids.map((id) => [id, [run[Number(id.slice('chat-'.length))]!]]));
      expect((await savesOf(h, notes[2]!.memory_id, records)).saves).toBe(3);
    }
  });

  it("reads a note's body and a save's body too, but one word in common is no claim", async () => {
    const h = harness();
    const inBody = await h.store.writeAuthored({
      origin_actor: 'contracted_user', author_contract_id: OWNER_CONTRACT_ID, kind: 'chat_memory',
      summary: 'Dana’s family', body: `${MIA}, and her son is called Leo`,
    });
    await h.redactions.set(inBody.memory_id, { memory_id: inBody.memory_id, redacted_at: 1 });
    const deleted = await saved(h, 'Dana’s family', 'chat-a');
    await handleMemoryDelete(h.rpcDeps, { memory_id: deleted.memory_id });
    const oneWord = await saved(h, 'Mia');
    await h.redactions.set(oneWord.memory_id, { memory_id: oneWord.memory_id, redacted_at: 1 });
    const note = await saved(h, MIA);
    const records: ChatSavesReader = async () =>
      new Map([['chat-a', [{ summary: 'Dana’s family', body: `${MIA}; she is seven` }]]]);
    expect((await savesOf(h, note.memory_id, records)).saves).toBe(3);
  });

  it("in one chat, a save of the claim goes first to a note from that chat still holding its words", async () => {
    const h = harness();
    const deleted = await saved(h, MIA, 'chat-a');
    await handleMemoryDelete(h.rpcDeps, { memory_id: deleted.memory_id });
    await saved(h, MIA, 'chat-a'); // a copy, still in memory
    const office = await saved(h, 'The Dublin office closes at five', 'chat-a');
    await handleMemoryDelete(h.rpcDeps, { memory_id: office.memory_id });
    const note = await saved(h, MIA, 'chat-a');
    // The chat records four saves: the deleted note's, the copy's, the office note's and this one's.
    const records = chats({ 'chat-a': [MIA, MIA, 'The Dublin office closes at five', MIA] });
    expect((await savesOf(h, note.memory_id, records)).saves).toBe(2);
  });

  it("never counts more of a chat's saves than notes were deleted there, nor a deleted note of something else", async () => {
    const h = harness();
    const deleted = await saved(h, MIA, 'chat-a');
    await handleMemoryDelete(h.rpcDeps, { memory_id: deleted.memory_id });
    const office = await saved(h, 'The Dublin office closes at five', 'chat-b');
    await handleMemoryDelete(h.rpcDeps, { memory_id: office.memory_id });
    const note = await saved(h, MIA, 'chat-c');
    const records = chats({ 'chat-a': [MIA, MIA], 'chat-b': ['The Dublin office closes at five'] });
    expect((await savesOf(h, note.memory_id, records)).saves).toBe(2);
  });

  it("⛔ a lower bound: a deleted note whose save it cannot read back is not counted", async () => {
    const h = harness();
    const noChat = await h.store.writeAuthored({
      origin_actor: 'contracted_user', author_contract_id: OWNER_CONTRACT_ID, kind: 'chat_memory', summary: MIA,
    });
    await handleMemoryDelete(h.rpcDeps, { memory_id: noChat.memory_id });
    const unread = await saved(h, MIA, 'chat-locked');
    await handleMemoryDelete(h.rpcDeps, { memory_id: unread.memory_id });
    const note = await saved(h, MIA, 'chat-c');
    expect((await savesOf(h, note.memory_id, chats({}))).saves).toBe(1);
    expect((await savesOf(h, note.memory_id, async () => { throw new Error('the vault is locked'); })).saves).toBe(1);
  });

  it('says how many different agents made the saves', async () => {
    const h = harness();
    const byApp = await saved(h, MIA, 'mcp-session', 'door-claude');
    await h.redactions.set(byApp.memory_id, { memory_id: byApp.memory_id, redacted_at: 1 });
    const note = await saved(h, MIA);
    expect(await savesOf(h, note.memory_id)).toMatchObject({ saves: 2, agents: 2 });
  });

  it('⛔ only for an agent note still in memory', async () => {
    const h = harness();
    const own = await handleMemoryCreate(h.rpcDeps, { kind: 'note', summary: MIA });
    await expect(savesOf(h, own.memory_id)).rejects.toThrow(/Only a memory an agent saved/);
    const revoked = await saved(h, MIA);
    await handleMemoryRevoke(h.rpcDeps, { memory_id: revoked.memory_id });
    await expect(savesOf(h, revoked.memory_id)).rejects.toThrow(/no longer in memory/);
    await expect(savesOf(h, 'umem_missing')).rejects.toThrow(/not found/);
    await expect(savesOf(h, 'run-1')).rejects.toThrow(/not found/);
  });
});

/** ⛔ The tests above hand `memory.saves` its chat reader themselves, so they prove the
 *  count uses one and nothing about whether the server supplies one. Without it a deleted
 *  note is never counted, and every test here would still pass. */
describe('the server gives memory.saves the chats to read (§13)', () => {
  it('compose-listeners builds the chat reader over the chat store and its approval cards', () => {
    const source = stripSourceComments(readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'serve/compose-listeners.ts'), 'utf-8',
    ));
    const memoryDeps = source.slice(source.indexOf('memoryRpcDeps: {'), source.indexOf('timelineRpcDeps: {'));
    expect(memoryDeps).toMatch(/readChatSaves: createChatSavesReader\(\{\s*chatStore: app\.chatDeps\.store,/);
    expect(memoryDeps).toMatch(/\{ plans: app\.chatDeps\.planApprovalStore \}/);
  });
});

describe('the saves a chat records, read back (§13)', () => {
  const call = (tool_name: string, args: unknown, state: 'succeeded' | 'failed' | 'held'): ChatMessage => ({
    id: `tool:${tool_name}:${state}`, session_id: 's', role: 'tool', content: renderToolRow(tool_name, args, undefined),
    tool_call: { message_id: `tool:${tool_name}:${state}`, session_id: 's', turn_id: 't', tool_name, state, started_at: 1, updated_at: 2 },
  } as unknown as ChatMessage);
  const card = (tool: string, args: unknown, hold: boolean, execution?: 'completed' | 'failed'): ChatPlanRecord => ({
    plan: { plan_id: 'p', session_id: 's', turn_id: 't', tool, tier: 1, classification: 'write', args, args_hash: 'h',
      status: 'approved', created_at: 1, ...(hold ? { hold: { run_id: 'run-1' } } : {}) },
    ...(execution === 'completed' ? { execution: { status: 'completed', turn_id: 't', result_ref: 'r' } } : {}),
    ...(execution === 'failed' ? { execution: { status: 'failed', turn_id: 't', reason: 'execution_error' } } : {}),
    payload_available: args !== null,
  } as unknown as ChatPlanRecord);

  it('from the rows, a memory.write call that ran and succeeded, with its words', () => {
    expect(savesInMessages([
      call('memory.write', { summary: ' Dana prefers calls ', body: 'in the morning' }, 'succeeded'),
      call('memory.write', { summary: 'refused' }, 'failed'),
      call('memory.write', { summary: 'waiting' }, 'held'),
      call('memory.forget', { memory_id: 'umem_1' }, 'succeeded'),
      { ...call('memory.write', { summary: 'x' }, 'succeeded'), content: renderToolRow('memory.write', undefined, { memory_id: 'umem_1' }) },
      { ...call('memory.write', { summary: 'x' }, 'succeeded'), content: 'memory.write({not json)' },
    ])).toEqual([{ summary: 'Dana prefers calls', body: 'in the morning' }]);
  });

  it('from the approval cards, a held memory.write that then ran; a card spent by its call made again is its row', () => {
    expect(savesOnCards([
      card('memory.write', { summary: 'Dana prefers calls' }, true, 'completed'),
      card('memory.write', { summary: 'refused' }, true, 'failed'),
      card('memory.write', { summary: 'not answered' }, true),
      card('memory.write', { summary: 'a plain card' }, false, 'completed'),
      card('calendar.create', { summary: 'Dentist' }, true, 'completed'),
      card('memory.write', null, true, 'completed'),
    ])).toEqual([{ summary: 'Dana prefers calls' }]);
  });

  it('reads each chat once; a chat it cannot read is absent', async () => {
    const listMessages = vi.fn(async (session_id: string) => {
      if (session_id === 'locked') throw new Error('the vault is locked');
      return [call('memory.write', { summary: `saved in ${session_id}` }, 'succeeded')];
    });
    const read = createChatSavesReader({
      chatStore: { listMessages },
      plans: { listForSession: async () => [card('memory.write', { summary: 'held, then run' }, true, 'completed')] },
    });
    expect(Object.fromEntries(await read(['a', 'locked', 'a']))).toEqual({
      a: [{ summary: 'saved in a' }, { summary: 'held, then run' }],
    });
    expect(listMessages).toHaveBeenCalledTimes(2);
  });
});

describe('toolCallArgsFromRow — the inverse of a call row (§13)', () => {
  it("reads back the arguments renderToolRow wrote, and nothing else", () => {
    const args = { summary: 'Dana (Whitfield) said "call me)"', body: 'x' };
    expect(toolCallArgsFromRow(renderToolRow('memory.write', args, undefined), 'memory.write')).toEqual(args);
    expect(toolCallArgsFromRow(renderToolRow('memory.write', undefined, { memory_id: 'umem_1' }), 'memory.write')).toBeUndefined();
    expect(toolCallArgsFromRow(renderToolRow('memory.forget', { memory_id: 'umem_1' }, undefined), 'memory.write')).toBeUndefined();
    expect(toolCallArgsFromRow(renderToolRow('memory.write', {}, undefined), 'memory.write')).toBeUndefined();
    expect(toolCallArgsFromRow(renderToolRow('memory.write', 'a bare string', undefined), 'memory.write')).toBeUndefined();
    expect(toolCallArgsFromRow(renderToolRow('memory.write', [1, 2], undefined), 'memory.write')).toBeUndefined();
    expect(toolCallArgsFromRow('memory.write({"summary":"x"}}', 'memory.write')).toBeUndefined();
  });
});
