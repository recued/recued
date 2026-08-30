/** `core.recall.search` — the grant handle that finally makes interaction recall
 *  revocable by the OWNER.
 *
 *  ⛔⛔ THE LOAD-BEARING TEST IS THE WIRE ONE. `recall.search` is hand-built into the
 *  CHAT registry view precisely so it never enters the raw MCP registry — its own
 *  header records that this is what keeps it undiscoverable to doors. Buying it a grant
 *  row by adding it to `TIER1_TOOL_NAMES` would have bought the row by ALSO exposing
 *  it, inverting D-213. A kernel op id buys the row alone, and "alone" is the claim
 *  that needs proving, not asserting. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  KERNEL_OP_REGISTRY,
  OP_ENTITY_LABEL,
  OWNER_CONTRACT_ID,
  TIER1_TOOL_NAMES,
  opGrantEntry,
  type ChatDispatchContext,
  type ChatDispatchResult,
  type InternalToolRegistry,
  type ToolEntry,
} from '@recued/contracts';

import {
  RECALL_SEARCH_TOOL_NAME,
  wrapRegistryWithRecallSearch,
} from '../chat-recall-search-tool.js';
import { reconcileOwnerGrants } from '../owner-grant-reconcile.js';
import { createContractStore } from '../storage/contract-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';

const RECALL_OP = 'core.recall.search';

/** A raw registry that knows nothing of recall — the MCP-facing shape. */
const rawRegistry = (): InternalToolRegistry => ({
  list: () => [] as ToolEntry[],
  listByTier: () => [] as ToolEntry[],
  getByName: () => undefined,
  dispatch: async () => ({ ok: true, result: { from: 'inner' } }) as ChatDispatchResult,
  subscribeRefresh: () => () => {},
}) as unknown as InternalToolRegistry;

const ctx = (): ChatDispatchContext => ({
  channel: 'internal_function_call',
  session_id: 's1',
  turn_id: 't1',
  turn_state: new Map(),
});

describe('core.recall.search — the row', () => {
  it('is a registered kernel op, so the owner reconcile seeds a revocable row', () => {
    const entry = KERNEL_OP_REGISTRY.find((e) => e.op === RECALL_OP);
    expect(entry).toBeDefined();
    expect(entry?.native).toBe(true);
    // Own entity ⇒ own panel heading, not buried under Memory.
    expect(entry?.entity).toBe('recall');
    expect(OP_ENTITY_LABEL.recall).toBe('Conversation history');

    const db = new Database(':memory:');
    try {
      const store = createContractStore(db);
      reconcileOwnerGrants(store, () => 1_750_000_000_000);
      expect(createContractGrantEntryStore(store)
        .get(OWNER_CONTRACT_ID, opGrantEntry(RECALL_OP))).toBe(true);
    } finally {
      db.close();
    }
  });

  /** ⛔⛔ THE CLAIM THAT MATTERS. The row must not have widened the surface. */
  it('did NOT join TIER1_TOOL_NAMES — no door gains the tool', () => {
    expect(TIER1_TOOL_NAMES).not.toContain(RECALL_SEARCH_TOOL_NAME);
  });

  it('stays absent from the RAW registry and present only in the chat view', () => {
    const raw = rawRegistry();
    // The MCP-facing registry: recall is not there, before or after wrapping.
    expect(raw.getByName(RECALL_SEARCH_TOOL_NAME)).toBeUndefined();
    const chat = wrapRegistryWithRecallSearch(raw, {
      backend: { search: async () => [] } as never,
      getContractDefinitionStore: () => undefined,
    });
    expect(chat.getByName(RECALL_SEARCH_TOOL_NAME)).toBeDefined();
    // ⚠ And the wrapper did not mutate the raw one — a shared-object leak here would
    // put the tool on the wire while every assertion above still passed.
    expect(raw.getByName(RECALL_SEARCH_TOOL_NAME)).toBeUndefined();
  });
});

describe('core.recall.search — the gate', () => {
  const dispatchWith = async (
    isRecallGranted?: (source: unknown) => boolean,
  ): Promise<ChatDispatchResult> => {
    const chat = wrapRegistryWithRecallSearch(rawRegistry(), {
      backend: { search: async () => [] } as never,
      getContractDefinitionStore: () => undefined,
      ...(isRecallGranted ? { isRecallGranted } : {}),
    });
    return chat.dispatch(RECALL_SEARCH_TOOL_NAME, { query: 'kestrel' }, ctx());
  };

  it('a revoke returns a guided EMPTY that names the permission, never ok:false', async () => {
    const out = await dispatchWith(() => false);
    // ⛔ `ok:false` would send a reasoning model into retry-to-timeout — this file's
    // own anti-loop invariant. The refusal has to be a RESULT that says why.
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const r = out.result as { matches?: unknown[]; hint?: string };
    expect(r.matches).toEqual([]);
    expect(r.hint).toContain('core.recall.search');
    // ⚠ It must not read as "nothing found" — that is a false statement about data the
    // owner still holds.
    expect(r.hint).toContain('not an empty result');
  });

  it('a grant lets the call through to the handler', async () => {
    const out = await dispatchWith(() => true);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const hint = (out.result as { hint?: string }).hint ?? '';
    expect(hint).not.toContain('core.recall.search');
  });

  it('no predicate wired ⇒ admits (additive, like every other grant seam here)', async () => {
    const out = await dispatchWith(undefined);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect((out.result as { hint?: string }).hint ?? '').not.toContain('core.recall.search');
  });
});
