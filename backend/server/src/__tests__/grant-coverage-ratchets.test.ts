/** THE TWO RATCHETS THIS ARC KEPT PROMISING, WRITTEN.
 *
 *  ⛔⛔ BOTH EXIST BECAUSE A DOC COMMENT IS NOT AN ASSERTION. `FENCED_EMPTY_CONTAINER`
 *  said "asserted by test" and no such test existed; `recall.search` had no grant row
 *  for its whole life and was found by hand, not by anything failing. Each ratchet
 *  below derives its expectation from the REGISTRY, never a hand-written list — a
 *  hand-listed expectation is the thing that goes stale in exactly the case it exists
 *  to catch. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  KERNEL_OP_REGISTRY,
  OP_ENTITY_COLLECTION,
  OWNER_CONTRACT_ID,
  TIER1_CLASSIFICATIONS,
  TIER1_TOOL_ENTITY,
  TIER1_TOOL_NAMES,
  isReadableCollection,
  opGrantEntry,
  primitiveGrantEntry,
} from '@recued/contracts';

import {
  FENCED_EMPTY_CONTAINER,
  buildChatTier1Handlers,
} from '../chat-tool-handlers.js';
import { RECALL_SEARCH_TOOL_NAME } from '../chat-recall-search-tool.js';
import { reconcileOwnerGrants } from '../owner-grant-reconcile.js';
import { createContractStore } from '../storage/contract-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';

/** The tools `wrapCollectionFence` actually wraps — derived by the SAME rule the
 *  wrapper uses, so this cannot drift from it. */
const tableFencedTools = (): string[] =>
  TIER1_TOOL_NAMES.filter((name) => {
    if (TIER1_CLASSIFICATIONS[name] !== 'read') return false;
    const entity = TIER1_TOOL_ENTITY[name];
    if (entity === 'work' || name === 'contact.search') return false;
    const collection = OP_ENTITY_COLLECTION[entity];
    return collection !== undefined && isReadableCollection(collection);
  });

describe('every table-fenced tool has an empty container', () => {
  it('FENCED_EMPTY_CONTAINER covers exactly the fenced set', () => {
    const fenced = tableFencedTools().sort();
    expect(fenced.length).toBeGreaterThan(0);
    // ⛔ A MISSING ENTRY DOES NOT THROW — the fenced result would just come back as a
    // bare `{hint}` with no array field, a third state that is neither "denied" nor
    // "empty" and that the tool's own schema does not describe.
    const missing = fenced.filter((t) => FENCED_EMPTY_CONTAINER[t] === undefined);
    expect(missing).toEqual([]);
    // And no stale entry for a tool that is no longer fenced.
    expect(Object.keys(FENCED_EMPTY_CONTAINER).sort()).toEqual(fenced);
  });
});

describe('every AI-dispatchable tool has a grant row', () => {
  /** ⛔⛔ THE GENERAL FORM OF THE `recall.search` FINDING. That tool was reachable by
   *  the owner's assistant with NO grant handle at all — not revocable, not visible in
   *  Contracts — and nothing failed, because nothing asserted the relationship between
   *  "can be dispatched" and "can be governed". */
  it('every Tier-1 primitive is seeded on the owner contract', () => {
    const db = new Database(':memory:');
    try {
      const store = createContractStore(db);
      reconcileOwnerGrants(store, () => 1_750_000_000_000);
      const grants = createContractGrantEntryStore(store);
      const ungoverned = TIER1_TOOL_NAMES.filter(
        (n) => grants.get(OWNER_CONTRACT_ID, primitiveGrantEntry(n)) === undefined,
      );
      expect(ungoverned).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('every handler in the built chat table is a governable name', () => {
    // Derived from the built table, not a list: a handler added without a descriptor
    // entry is exactly the shape that ships ungoverned.
    const handlers = Object.keys(buildChatTier1Handlers({
      getContactStore: () => undefined,
      getCollectionRegistry: () => undefined,
      getAuditLog: () => undefined,
      getEnrichmentStore: () => undefined,
      getRecipeStore: () => ({ ids: () => [], get: () => null, getStored: () => null, listStored: () => [] }),
      getExecutorConfig: () => ({ manifests: { get: () => null } }),
      getExecuteRecipe: () => undefined,
      getBoundCrmMirrorSources: () => [],
    } as never));
    const notGovernable = handlers.filter(
      (h) => !(TIER1_TOOL_NAMES as readonly string[]).includes(h),
    );
    expect(notGovernable).toEqual([]);
  });

  /** ⛔ The chat-only broker is NOT in `TIER1_TOOL_NAMES` — deliberately, so it stays
   *  off the MCP wire — which is precisely why it needs its own assertion here. Its
   *  grant handle is a KERNEL op instead, and this is the check that would have caught
   *  the original gap. */
  it('recall.search — off the primitive list, but NOT ungoverned', () => {
    expect(TIER1_TOOL_NAMES).not.toContain(RECALL_SEARCH_TOOL_NAME);
    const op = KERNEL_OP_REGISTRY.find((e) => e.op === 'core.recall.search');
    expect(op).toBeDefined();

    const db = new Database(':memory:');
    try {
      const store = createContractStore(db);
      reconcileOwnerGrants(store, () => 1_750_000_000_000);
      expect(createContractGrantEntryStore(store)
        .get(OWNER_CONTRACT_ID, opGrantEntry('core.recall.search'))).toBe(true);
    } finally {
      db.close();
    }
  });
});
