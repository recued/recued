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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { OWNER_CONTRACT_ID } from '@recued/contracts';
import type { ChatDispatchContext, ChatDispatchResult, ExecutionSource } from '@recued/contracts';
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
  type MemoryRedactionRecord,
  type MemoryRpcDeps,
} from '../memory-rpc-handler.js';
import { authoringContractId } from '../grant-governing-contract.js';
import { createDataMemoryLookup } from '../data-memory-lookup.js';

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
