/** D-198 Slice 4 — `memory.write` chat tool + `memory.search` union.
 *
 *  The live collective-memory write path (Fork 2 = A) + the shared-read half:
 *    - memory.write: grant-gated (`core.memory.write`), stamps `contracted_user`
 *      + session provenance, writes into the ONE pool via the store-backed
 *      adapter; fails closed (classification_blocked) when ungranted / no gate.
 *    - memory.search: UNIONs the `user_memory` pool in when read-granted
 *      (`core.memory.read`); additive `memories` alongside the audit `entries`. */

import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import type { AuditEntry } from '@recued/storage';
import type { ChatDispatchContext, ExecutionSource } from '@recued/contracts';
import { createInMemoryCollection } from '@recued/storage';
import type { BlobStore } from '../storage/blob-store.js';
import {
  createUserMemoryStore,
  USER_MEMORY_ID_PREFIX,
  type UserMemoryRow,
  type UserMemoryStore,
} from '../user-memory-store.js';
import {
  buildChatTier1Handlers,
  type ChatToolHandlerDeps,
} from '../chat-tool-handlers.js';
import type { MemoryRedactionRecord } from '../memory-rpc-handler.js';
import { createInternalToolRegistry } from '@recued/middleware/internal-tool-registry/index.js';

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

const makeUserMemoryStore = (): UserMemoryStore => {
  let seq = 0;
  return createUserMemoryStore(createInMemoryCollection<UserMemoryRow>(), fakeBlobs(), {
    now: () => 1000,
    mintId: () => `${USER_MEMORY_ID_PREFIX}${(seq += 1)}`,
  });
};

/** OpAdmissionGate stub — `isOpGranted` returns `grant` for every op; the tool's
 *  admit helpers only consult `isOpGranted`, but the dep getter's return type
 *  requires `isFrozenByPause` too. */
const gateThatGrants = (grant: boolean) => ({
  isFrozenByPause: () => false,
  isOpGranted: vi.fn().mockReturnValue(grant),
  // D-247 — the owner axis. These suites drive the OWNER's chat, so
  // `isOwnerGoverned` is true; the recipe grant is irrelevant to memory tools
  // and answers false rather than pretending otherwise.
  isOwnerGoverned: () => true,
  isOwnerRecipeGranted: () => false,
});

const ownerSource = (contract_id?: string): ExecutionSource => ({
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'sess-1',
  user_id: 'local',
  ...(contract_id !== undefined ? { contract_id } : {}),
});

const doorSource: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'agent-1',
  tool_call_id: 'tc-1',
  mcp_token_id: 'tok-1',
  contract_id: 'door-contract',
};

const ctxInternal = (execution_source?: ExecutionSource): ChatDispatchContext => ({
  channel: 'internal_function_call',
  session_id: 'sess-1',
  turn_id: 'turn-1',
  ...(execution_source !== undefined ? { execution_source } : {}),
});

const auditEntry = (): AuditEntry =>
  ({
    run_id: 'run-1',
    recipe_id: 'recued-core/x',
    recipe_hash: 'h',
    started_at: 500,
    finished_at: 600,
    duration_ms: 100,
    commit_status: 'success',
    errors: [],
    trigger_url: '',
    trigger_source: 'manual',
    instance_id: 'i',
  }) as unknown as AuditEntry;

const buildDeps = (
  overrides: Partial<ChatToolHandlerDeps> = {},
): ChatToolHandlerDeps => ({
  getContactStore: () => undefined,
  getCollectionRegistry: () => undefined,
  getAuditLog: () => undefined,
  getEnrichmentStore: () => undefined,
  getRecipeStore: () => ({ ids: () => [], get: () => null, getStored: () => null, listStored: () => [] }) as never,
  getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
  getExecuteRecipe: () => undefined,
  ...overrides,
});

// ── memory.write ────────────────────────────────────────────────────

describe('memory.write chat tool', () => {
  it('owner-chat: writes a contracted_user row (origin + session stamped) + fans a memory event', async () => {
    const store = makeUserMemoryStore();
    const gate = gateThatGrants(true);
    const events: Array<{ kind: string; subkind?: string; id?: string }> = [];
    const bus = { emit: (e: typeof events[number]) => { events.push(e); } } as never;
    const handlers = buildChatTier1Handlers(
      buildDeps({
        getUserMemoryStore: () => store,
        getOpAdmissionGate: () => gate,
        getEventBus: () => bus,
      }),
    );
    const res = await handlers['memory.write']!(
      { summary: 'refund window is 30 days', body: 'Refunds within 30 days.' },
      ctxInternal(ownerSource('owner-contract')),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const memory_id = (res.result as { memory_id: string }).memory_id;
    expect(memory_id).toBe(`${USER_MEMORY_ID_PREFIX}1`);
    // Gate consulted with the write op id.
    expect(gate.isOpGranted).toHaveBeenCalledWith(expect.anything(), 'core.memory.write');
    const resolved = await store.get(memory_id);
    expect(resolved?.row.origin_actor).toBe('contracted_user'); // never user_self
    expect(resolved?.row.channel_session_id).toBe('sess-1');
    expect(resolved?.row.contract_id).toBe('owner-contract');
    expect(resolved?.row.summary).toBe('refund window is 30 days');
    expect(resolved?.body).toBe('Refunds within 30 days.');
    // Live-refresh broadcast (§7.7).
    expect(events).toContainEqual({ kind: 'memory', subkind: 'user', id: memory_id });
  });

  it('reports provenance edges from provenance_entity_ids', async () => {
    const store = makeUserMemoryStore();
    const handlers = buildChatTier1Handlers(
      buildDeps({ getUserMemoryStore: () => store, getOpAdmissionGate: () => gateThatGrants(true) }),
    );
    const res = await handlers['memory.write']!(
      { summary: 's', provenance_entity_ids: ['a@b.com', 'c@d.com'] },
      ctxInternal(ownerSource()),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.result as { provenance_edges_written: number }).provenance_edges_written).toBe(2);
  });

  it('a door WITHOUT the grant is rejected (classification_blocked)', async () => {
    const store = makeUserMemoryStore();
    const handlers = buildChatTier1Handlers(
      buildDeps({ getUserMemoryStore: () => store, getOpAdmissionGate: () => gateThatGrants(false) }),
    );
    const res = await handlers['memory.write']!({ summary: 's' }, ctxInternal(doorSource));
    expect(res).toMatchObject({ ok: false, reason: 'classification_blocked' });
    expect(await store.list()).toHaveLength(0); // nothing written
  });

  it('fails closed when no admission gate is wired', async () => {
    const store = makeUserMemoryStore();
    const handlers = buildChatTier1Handlers(buildDeps({ getUserMemoryStore: () => store }));
    const res = await handlers['memory.write']!({ summary: 's' }, ctxInternal(ownerSource()));
    expect(res).toMatchObject({ ok: false, reason: 'classification_blocked' });
  });

  it('reports execution_error when no store is wired', async () => {
    const handlers = buildChatTier1Handlers(
      buildDeps({ getOpAdmissionGate: () => gateThatGrants(true) }),
    );
    const res = await handlers['memory.write']!({ summary: 's' }, ctxInternal(ownerSource()));
    expect(res).toMatchObject({ ok: false, reason: 'execution_error' });
  });

  it('rejects a blank summary (invalid_args)', async () => {
    const store = makeUserMemoryStore();
    const handlers = buildChatTier1Handlers(
      buildDeps({ getUserMemoryStore: () => store, getOpAdmissionGate: () => gateThatGrants(true) }),
    );
    const res = await handlers['memory.write']!({ summary: '   ' }, ctxInternal(ownerSource()));
    expect(res).toMatchObject({ ok: false, reason: 'invalid_args' });
  });

  it('dispatches end-to-end through the real InternalToolRegistry (channel guard + lookup)', async () => {
    const store = makeUserMemoryStore();
    const registry = createInternalToolRegistry({
      tier1Handlers: buildChatTier1Handlers(
        buildDeps({ getUserMemoryStore: () => store, getOpAdmissionGate: () => gateThatGrants(true) }),
      ),
    });
    const res = await registry.dispatch(
      'memory.write',
      { summary: 'via the registry' },
      ctxInternal(ownerSource()),
    );
    expect(res.ok).toBe(true);
    expect(await store.list()).toHaveLength(1);
  });
});

// ── memory.search union — RETIRED (4 tests) ─────────────────────────
//
// These asserted the OLD shape: `memory.search` returned audit rows UNIONed
// with the pool. All four are obsolete because the AUDIT HALF IS GONE:
//
//   • "unions the pool rows in alongside the audit entries"
//   • "NOT read-granted: memories are empty, AUDIT ENTRIES STILL FLOW
//      (non-regressive)"   ← this one ENCODED THE LEAK AS INTENDED BEHAVIOR.
//      The audit read consulted no grant at all, while the MCP door gates the
//      same data behind `core.memory.audit.read`. Same data, two doors, one
//      gated. The test that should have caught it asserted it instead.
//   • "recipe_id filter skips the pool union"  (`recipe_id` is gone)
//   • "a REDACTED audit run is omitted from the recall entries too"
//      (redaction still applies — to POOL rows; covered in the new file)
//
// `memory.search` is now pool-only, FTS5 query-matched recall with a byte
// budget. Its behavior — including that it NEVER touches the audit log, that
// the grant now gates the WHOLE tool, and that redaction is honored — is
// covered by `d-198-memory-search-recall.test.ts`.
//
// The `memory.write` tests above are unaffected and stay.
// ────────────────────────────────────────────────────────────────────
