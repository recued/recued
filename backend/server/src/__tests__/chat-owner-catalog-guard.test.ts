/** D-247 D9 — the owner tool catalog is not servable to a contracted source.
 *
 *  ⛔⛔ THE AUDIT THIS CAME FROM. `buildCatalog`'s own comment names THREE
 *  exposure surfaces — chat catalog / `tools.search` / the MCP door's
 *  `tools/list` — and says "they fail independently". Traced end to end, they
 *  do, and in opposite directions: `tools/list` denies on a missing gate
 *  (`isCheckedListGranted`: `gate === undefined → false`), while the two chat
 *  surfaces ADMIT on one — `createChatTier2GrantFilter` returns `() => true`
 *  for anything not owner-governed, and `buildCatalog`'s last branch is a bare
 *  unfiltered `registryEntries`.
 *
 *  ⚠ That is not currently exploitable, and the reason matters: the ONLY
 *  producer of a `chat` + `contracted_user` source is `runLlmGatewayTurn`,
 *  which never calls `buildCatalog` (it builds its own catalog from
 *  `allowed_tool_names`) and omits `tools.search` entirely. So the isolation is
 *  structural — safe by ROUTING, not enforced. The day a contracted source
 *  reaches the ordinary chat path, both surfaces hand over the owner's whole
 *  installed catalog: names, descriptions, arg schemas. Nothing would be
 *  dispatchable and nothing would fail; the inventory would just be readable.
 *
 *  These tests pin the refusal so that day is a denial instead. */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createChatOwnerCatalogGuard } from '../chat-tool-handlers.js';
import { wrapChatRegistryForCatalogModes } from '../chat-tools-search.js';

const ownerSource = {
  channel: 'chat', actor: 'user_self',
  chat_session_id: 's1', user_id: 'owner',
} as never;
const doorSource = {
  channel: 'chat', actor: 'contracted_user',
  chat_session_id: 's1', user_id: 'customer', contract_id: 'door-alice',
} as never;

const gated = (isOwnerGoverned: boolean) => createChatOwnerCatalogGuard({
  getOpAdmissionGate: () => ({ isOwnerGoverned: () => isOwnerGoverned }),
} as never);

describe('createChatOwnerCatalogGuard', () => {
  it('⛔ REFUSES a source the admission gate says is not owner-governed', () => {
    expect(() => gated(false)(doorSource))
      .toThrow(/not servable to a contracted source/);
  });

  it('admits the owner', () => {
    expect(() => gated(true)(ownerSource)).not.toThrow();
  });

  it('⚠ no gate wired ⇒ proceeds, so a dbless / partial harness is untouched', () => {
    // Deliberate, and mirrors `createChatTier2GrantFilter`'s own "No gate wired
    // ⇒ UNFILTERED" default. Pinned so it stays a decision someone reads.
    const guard = createChatOwnerCatalogGuard({} as never);
    expect(() => guard(doorSource)).not.toThrow();
  });

  it('⚠ no source ⇒ proceeds — this must be a no-op on every path that works today', () => {
    // The guard exists to catch a ROUTING change, not to tighten the owner
    // path. Denying an absent source would break harnesses that never mint one
    // while catching nothing that is actually reachable.
    expect(() => gated(false)(undefined)).not.toThrow();
  });
});

/** ⛔⛔ THROUGH THE REAL CONSTRUCTOR, because the guard being correct proves
 *  nothing about whether the surface reaches it — and this test caught exactly
 *  that while it was being written. The option was declared on
 *  `ToolsSearchWrapOptions` and supplied at the orchestrator, which reaches
 *  `buildCatalog` only; `wrapChatRegistryForCatalogModes` is the ONLY
 *  constructor of the search surface and took its arguments positionally, so
 *  search stayed unguarded. That is the same failure this file's subject
 *  already recorded once — "accepted and threaded but UNREAD". */
describe('tools.search — the surface, not the guard', () => {
  const emptyRegistry = {
    list: () => [],
    listByTier: () => [],
    getByName: () => null,
    dispatch: async () => ({ ok: true as const, result: {} }),
    subscribeRefresh: () => () => undefined,
  } as never;

  const registryWithGuard = (isOwnerGoverned: boolean) =>
    wrapChatRegistryForCatalogModes(
      emptyRegistry,
      ['lean-core'],
      undefined,
      undefined,
      gated(isOwnerGoverned),
    );

  it('⛔ a contracted source is REFUSED by the dispatch, not merely filtered', async () => {
    const registry = registryWithGuard(false);
    await expect(registry.dispatch(
      'tools.search', { query: 'invoice' }, { execution_source: doorSource } as never,
    )).rejects.toThrow(/not servable to a contracted source/);
  });

  it('the owner still searches', async () => {
    const registry = registryWithGuard(true);
    await expect(registry.dispatch(
      'tools.search', { query: 'invoice' }, { execution_source: ownerSource } as never,
    )).resolves.toBeDefined();
  });
});

/** ⛔⛔ SURFACE 1 CANNOT BE DRIVEN TO ITS REFUSAL, AND THAT IS THE FINDING.
 *  `runTurn` mints its own source via `buildChatExecutionSource` — always
 *  `user_self`, never a contract — and the sole producer of a contracted chat
 *  source (`runLlmGatewayTurn`) does not call `buildCatalog` at all. So no
 *  reachable path can hand `buildCatalog` the source it refuses; the guard is a
 *  fence against a FUTURE routing change, not a live denial.
 *
 *  What can still be proven, and is the failure that actually happens, is that
 *  the surface REACHES the guard. A declared-but-uncalled option is exactly
 *  what `tools.search` shipped with for four months, and what this very change
 *  nearly repeated. */
describe('buildCatalog — the surface reaches the guard', () => {
  it('an ordinary owner turn passes through ownerCatalogGuard', async () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    const store = createChatStore(db);
    store.createSession({ id: 'sess-1', now: 1_000 });
    const ownerCatalogGuard = vi.fn();
    const registry = {
      list: () => [], listByTier: () => [], getByName: () => null,
      dispatch: async () => ({ ok: true as const, result: {} }),
      subscribeRefresh: () => () => undefined,
    } as never;
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry,
      selfSignature: {
        server_id: 'srv', name: 'test', public_key: 'k',
      } as never,
      ownerCatalogGuard,
      now: () => 2_000,
    } as never);
    await orchestrator.runTurn({
      session_id: 'sess-1',
      message: 'find my mail',
      picker_state: { current: 'self' },
    } as never);
    expect(ownerCatalogGuard).toHaveBeenCalled();
    // And with the turn's real source, not a synthesised one — a guard handed
    // `undefined` proceeds by design, so calling it with nothing would be
    // indistinguishable from not calling it at all.
    expect(ownerCatalogGuard.mock.calls[0]?.[0]).toMatchObject({
      channel: 'chat', actor: 'user_self',
    });
    db.close();
  });
});
