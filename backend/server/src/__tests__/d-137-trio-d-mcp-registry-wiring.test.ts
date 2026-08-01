/** D-137 Trio #D — InternalToolRegistry union catalog wired through
 *  `mcp-server.ts`.
 *
 *  Acceptance per § A.1 + § A.1.1 + the Trio #D handover:
 *    - `tools/list` projection appends Tier 1 + Tier 2 + Tier 3
 *      entries alongside the legacy `recued_*` + `recued_ingredient_*`
 *      catalog when an `InternalToolRegistry` is wired.
 *    - `tools/list` projection falls back to legacy-only when no
 *      registry is wired (pre-Trio-D shape preserved).
 *    - `tools/call` for registry-known names routes through the
 *      `mcp_wire` channel — every dispatch carries
 *      `channel: 'mcp_wire'` + the stdio synthetic token id;
 *      `session_id` is NEVER set (channel-isolation invariant).
 *    - `tools/call` for legacy names continues to traverse the legacy
 *      switch — registry-routing is additive, not replacing.
 *    - Successful registry dispatch surfaces the result via the `text`
 *      MCP envelope; failure surfaces via `err` + `formatMcpDispatchError`.
 *    - A `mcp_dispatch` audit receipt is logged per registry-routed
 *      call (`via=registry,status=ok|failed`).
 *    - Custom `mcpTokenId` (HTTP-transport path) overrides the stdio
 *      default in dispatch ctx. */

import { describe, it, expect } from 'vitest';
import type {
  ChatDispatchContext,
  ChatDispatchResult,
  InternalToolRegistry,
  ToolEntry,
} from '@recued/contracts';
import { _testing } from '../mcp-server.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';

const mkTool = (
  name: string,
  tier: 1 | 2 | 3,
  classification: ToolEntry['classification'] = 'read',
): ToolEntry => ({
  name,
  tier,
  description: `desc for ${name}`,
  arg_schema: { type: 'object' },
  topic_tags: ['mail'],
  classification,
  concurrency_safe: tier === 1 && classification === 'read',
});

const mkRegistry = (
  catalog: ReadonlyArray<ToolEntry>,
  dispatchImpl?: (
    name: string,
    args: unknown,
    ctx: ChatDispatchContext,
  ) => Promise<ChatDispatchResult>,
): InternalToolRegistry => ({
  list: () => catalog,
  listByTier: (tier) => catalog.filter((e) => e.tier === tier),
  getByName: (name) => catalog.find((e) => e.name === name) ?? null,
  dispatch:
    dispatchImpl ?? (async () => ({ ok: false, reason: 'not_implemented' })),
  subscribeRefresh: () => () => undefined,
});

const mkAuditLog = () => {
  const activities: Array<{
    action: string;
    target: string;
    detail?: string;
  }> = [];
  return {
    activities,
    store: {
      append: async () => {},
      listRecent: async () => [],
      listByRecipe: async () => [],
      get: async () => null,
      clearOlderThan: async () => 0,
      clearByRecipe: async () => 0,
      exportAll: async () => [],
      size: async () => 0,
      clearAll: async () => {},
      logActivity: async (e: {
        action: string;
        target: string;
        detail?: string;
      }) => {
        activities.push({ action: e.action, target: e.target, detail: e.detail });
      },
      listActivities: async () => [],
      exportActivities: async () => [],
    },
  };
};

const mkDeps = (overrides: {
  registry?: InternalToolRegistry;
  audit?: ReturnType<typeof mkAuditLog>['store'];
  mcpTokenId?: string;
}) => {
  const manifests = createManifestRegistry('/nonexistent');
  const recipeStore = createRecipeStore('/nonexistent');
  return {
    recipeStore,
    executorConfig: { manifests },
    baseVault: {},
    // D-228 slice 6 — this suite models the OWNER (no per-tool checklist);
    // absent now DENIES, so the principal is stated positively.
    ownerAdmitAll: true,
    ...(overrides.registry ? { internalRegistry: overrides.registry } : {}),
    ...(overrides.audit ? { auditLog: overrides.audit } : {}),
    ...(overrides.mcpTokenId !== undefined
      ? { mcpTokenId: overrides.mcpTokenId }
      : {}),
  } as unknown as Parameters<typeof _testing.handleToolCall>[1];
};

describe('D-137 Trio #D — handleToolsList union catalog', () => {
  it('appends Tier 1 + Tier 2 entries to the legacy catalog when registry is wired (Tier 3 filtered by P1 fold)', async () => {
    const registry = mkRegistry([
      mkTool('contact.search', 1),
      mkTool('recued-core/draft-email', 2),
      mkTool('exa.web_search', 3),
    ]);
    const deps = mkDeps({ registry });
    const result = (await _testing.handleToolsList(deps)) as {
      tools: Array<{ name: string }>;
    };
    const names = result.tools.map((t) => t.name);
    // Legacy tools still present.
    expect(names).toContain('recued_listRecipes');
    expect(names).toContain('recued_runRecipe');
    expect(names).toContain('recued_dataTimeline');
    // Tier 1 + Tier 2 appended.
    expect(names).toContain('contact.search');
    expect(names).toContain('recued-core/draft-email');
    // Tier 3 filtered out — see `D-137 Trio #D — Codex P1 fold: Tier 3
    // filtered from MCP wire` describe block below.
    expect(names).not.toContain('exa.web_search');
  });

  it('falls back to legacy-only catalog when no registry is wired', async () => {
    const deps = mkDeps({});
    const result = (await _testing.handleToolsList(deps)) as {
      tools: Array<{ name: string }>;
    };
    const names = result.tools.map((t) => t.name);
    // Legacy tools present.
    expect(names).toContain('recued_listRecipes');
    expect(names).toContain('recued_runRecipe');
    // No registry tools.
    expect(names).not.toContain('contact.search');
    expect(names.some((n) => n.includes('/'))).toBe(false);
    expect(names.some((n) => n.startsWith('exa.'))).toBe(false);
  });

  it('surfaces _meta tier + classification + topic_tags on registry entries', async () => {
    const registry = mkRegistry([
      {
        ...mkTool('mail.search', 1),
        topic_tags: ['mail', 'communication'],
      },
    ]);
    const deps = mkDeps({ registry });
    const result = (await _testing.handleToolsList(deps)) as {
      tools: Array<{
        name: string;
        _meta?: {
          tier: number;
          classification: string;
          topic_tags: ReadonlyArray<string>;
        };
      }>;
    };
    const tool = result.tools.find((t) => t.name === 'mail.search');
    expect(tool).toBeDefined();
    expect(tool?._meta?.tier).toBe(1);
    expect(tool?._meta?.classification).toBe('read');
    expect(tool?._meta?.topic_tags).toEqual(['mail', 'communication']);
  });
});

describe('D-137 Trio #D — handleToolCall channel isolation', () => {
  it('routes registry-known names through channel: mcp_wire + stdio token id', async () => {
    const captured: ChatDispatchContext[] = [];
    const registry = mkRegistry(
      [mkTool('contact.search', 1)],
      async (_name, _args, ctx) => {
        captured.push(ctx);
        return { ok: true, result: { hits: [{ id: 'c-1' }] } };
      },
    );
    const audit = mkAuditLog();
    const deps = mkDeps({ registry, audit: audit.store });

    const res = await _testing.handleToolCall(
      { name: 'contact.search', arguments: { q: 'peter' } },
      deps,
    );

    expect((res as { isError?: boolean }).isError).toBeUndefined();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.channel).toBe('mcp_wire');
    // Stdio fallback synthetic token id.
    expect(captured[0]?.mcp_token_id).toBe(_testing.STDIO_MCP_TOKEN_ID);
    // Channel-isolation invariant — session_id NEVER on mcp_wire.
    expect(captured[0]?.session_id).toBeUndefined();
  });

  it('honours an explicit mcpTokenId override (HTTP-transport path)', async () => {
    const captured: ChatDispatchContext[] = [];
    const registry = mkRegistry(
      [mkTool('contact.search', 1)],
      async (_name, _args, ctx) => {
        captured.push(ctx);
        return { ok: true, result: { hits: [] } };
      },
    );
    const deps = mkDeps({ registry, mcpTokenId: 'mary-pair-token-42' });

    await _testing.handleToolCall(
      { name: 'contact.search', arguments: {} },
      deps,
    );

    expect(captured[0]?.mcp_token_id).toBe('mary-pair-token-42');
  });

  it('returns the registry result via the text envelope on success', async () => {
    const registry = mkRegistry(
      [mkTool('mail.search', 1)],
      async () => ({ ok: true, result: { hits: [{ id: 'msg-1', subject: 'hi' }] } }),
    );
    const deps = mkDeps({ registry });

    const res = await _testing.handleToolCall(
      { name: 'mail.search', arguments: { q: 'hi' } },
      deps,
    );

    expect((res as { isError?: boolean }).isError).toBeUndefined();
    const payload = (res as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(payload);
    expect(parsed.hits[0].subject).toBe('hi');
  });

  it('maps registry failure reasons through formatMcpDispatchError', async () => {
    const registry = mkRegistry(
      [mkTool('memory.search', 1)],
      async () => ({
        ok: false,
        reason: 'classification_blocked',
        detail: 'write tool gated by per-token grant',
      }),
    );
    const deps = mkDeps({ registry });

    const res = await _testing.handleToolCall(
      { name: 'memory.search', arguments: {} },
      deps,
    );

    expect((res as { isError?: boolean }).isError).toBe(true);
    const text = (res as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('classification gate blocked');
    expect(text).toContain('write tool gated');
  });
});

describe('D-137 Trio #D — handleToolCall audit emission', () => {
  it('writes a mcp_dispatch receipt with via=registry,status=ok on success', async () => {
    const registry = mkRegistry(
      [mkTool('contact.search', 1)],
      async () => ({ ok: true, result: {} }),
    );
    const audit = mkAuditLog();
    const deps = mkDeps({ registry, audit: audit.store });

    await _testing.handleToolCall(
      { name: 'contact.search', arguments: {} },
      deps,
    );

    expect(audit.activities).toHaveLength(1);
    expect(audit.activities[0].action).toBe('mcp_dispatch');
    expect(audit.activities[0].target).toBe('contact.search');
    expect(audit.activities[0].detail).toMatch(/via=registry/);
    expect(audit.activities[0].detail).toMatch(/status=ok/);
    expect(audit.activities[0].detail).toMatch(/elapsed_ms=\d+/);
  });

  it('writes status=failed when the registry dispatch returns ok:false', async () => {
    const registry = mkRegistry(
      [mkTool('memory.search', 1)],
      async () => ({ ok: false, reason: 'capacity_gap' }),
    );
    const audit = mkAuditLog();
    const deps = mkDeps({ registry, audit: audit.store });

    await _testing.handleToolCall(
      { name: 'memory.search', arguments: {} },
      deps,
    );

    expect(audit.activities).toHaveLength(1);
    expect(audit.activities[0].detail).toMatch(/status=failed/);
  });

  it('writes status=failed when the registry throws synchronously', async () => {
    const registry = mkRegistry([mkTool('contact.search', 1)], async () => {
      throw new Error('boom');
    });
    const audit = mkAuditLog();
    const deps = mkDeps({ registry, audit: audit.store });

    const res = await _testing.handleToolCall(
      { name: 'contact.search', arguments: {} },
      deps,
    );

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(audit.activities[0].detail).toMatch(/status=failed/);
  });

  it('does not emit a registry mcp_dispatch receipt for legacy tools', async () => {
    const registry = mkRegistry([mkTool('contact.search', 1)]);
    const audit = mkAuditLog();
    const deps = mkDeps({ registry, audit: audit.store });

    // Hit the legacy `recued_listRecipes` path (no recipes registered;
    // returns an empty list).
    const res = await _testing.handleToolCall(
      { name: 'recued_listRecipes', arguments: {} },
      deps,
    );
    expect((res as { isError?: boolean }).isError).toBeUndefined();
    // Legacy switch doesn't write `mcp_dispatch` for read-only meta tools.
    const registryReceipts = audit.activities.filter(
      (a) => a.action === 'mcp_dispatch' && a.detail?.includes('via=registry'),
    );
    expect(registryReceipts).toHaveLength(0);
  });
});

describe('D-137 Trio #D — legacy + registry coexistence', () => {
  it('registry-routing does NOT short-circuit legacy names', async () => {
    let registryDispatchCalls = 0;
    const registry = mkRegistry(
      [mkTool('contact.search', 1)],
      async () => {
        registryDispatchCalls += 1;
        return { ok: true, result: {} };
      },
    );
    const deps = mkDeps({ registry });

    // Legacy `recued_listRecipes` is not in the registry; should NOT
    // dispatch through it.
    await _testing.handleToolCall(
      { name: 'recued_listRecipes', arguments: {} },
      deps,
    );
    expect(registryDispatchCalls).toBe(0);
  });

  it('falls back to legacy switch for unknown names when registry is wired but has no match', async () => {
    const registry = mkRegistry([mkTool('contact.search', 1)]);
    const deps = mkDeps({ registry });

    // `recued_dataTimeline` is a legacy tool, not in the registry.
    // Without annotation/loadCollectionRecord deps, it should still
    // execute the legacy branch (returning an empty page, not falling
    // through to the registry's unknown-tool path).
    const res = await _testing.handleToolCall(
      { name: 'recued_dataTimeline', arguments: { entity_id: 'mail:x' } },
      deps,
    );
    // The legacy timeline handler runs; the actual data layer is empty
    // in this harness, but the legacy switch case fired (not the
    // registry path).
    expect(res).toBeDefined();
  });
});

describe('D-137 Trio #D — Codex P1 fold: channel-aware handler gates', () => {
  it('enrichment.search rejects mcp_exposed: \'private\' topics on mcp_wire (per-pair override)', async () => {
    const { buildChatToolRegistryInputs } = await import(
      '../chat-tool-handlers.js'
    );
    const { createInternalToolRegistry } = await import(
      '@recued/middleware/internal-tool-registry/index.js'
    );
    let listCalls = 0;
    const fakeEnrichmentStore = {
      list: () => {
        listCalls += 1;
        return [];
      },
    } as never;
    // D-187 AMENDMENT — the chat mcp_wire reject resolves the topic's read-grant against
    // the chat's BOUND CONTRACT via the gated resolver's SOURCE entry point
    // (`resolveForSource(ctx.execution_source)` — the seam chat-tool-handlers actually
    // calls), which returns a checker NOT granting `purpose` under door contract `ct-door`
    // (an explicit revoke). Other contracts fall to the author-default checker.
    const fakeResolver = {
      resolveForSource: (source: { contract_id?: string }) =>
        source.contract_id === 'ct-door'
          ? {
              isTopicReadGranted: (t: string) => t !== 'purpose',
              isCollectionReadGranted: () => true,
              isVerbOpGranted: () => true,
            }
          : undefined,
    } as never;
    const inputs = buildChatToolRegistryInputs({
      getContactStore: () => undefined,
      getCollectionRegistry: () => undefined,
      getAuditLog: () => undefined,
      getEnrichmentStore: () => fakeEnrichmentStore,
      getRecipeStore: () =>
        ({ get: () => null, ids: () => [], listStored: () => [] }) as never,
      getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
      getExecuteRecipe: () => undefined,
      getReadGrantResolver: () => fakeResolver,
    });
    const registry = createInternalToolRegistry({
      tier1Handlers: inputs.tier1Handlers,
    });

    // mcp_wire channel + topic private under the bound contract → rejected without
    // hitting store.
    const mcpResult = await registry.dispatch(
      'enrichment.search',
      { topic: 'purpose' },
      {
        channel: 'mcp_wire',
        mcp_token_id: 'tok-1',
        execution_source: {
          channel: 'mcp',
          actor: 'contracted_user',
          agent_id: 'a',
          tool_call_id: 't',
          mcp_token_id: 'tok-1',
          contract_id: 'ct-door',
        },
      },
    );
    expect(mcpResult.ok).toBe(false);
    if (!mcpResult.ok) {
      expect(mcpResult.reason).toBe('classification_blocked');
      expect(mcpResult.detail).toMatch(/not read-granted/);
    }
    expect(listCalls).toBe(0); // store.list NEVER called when gated.
  });

  it('enrichment.search allows mcp_exposed: \'private\' topics on internal_function_call channel', async () => {
    const { buildChatToolRegistryInputs } = await import(
      '../chat-tool-handlers.js'
    );
    const { createInternalToolRegistry } = await import(
      '@recued/middleware/internal-tool-registry/index.js'
    );
    let listCalls = 0;
    const fakeEnrichmentStore = {
      list: () => {
        listCalls += 1;
        return [];
      },
    } as never;
    // D-187 AMENDMENT — even a resolver that WOULD reject `purpose` under any contract is
    // never consulted on the internal channel (the gate skips before the lookup). Uses the
    // `resolveForSource` seam — the internal channel has no `execution_source`, so the
    // handler short-circuits to the author-default checker and this is never called.
    const fakeResolver = {
      resolveForSource: () => ({
        isTopicReadGranted: (t: string) => t !== 'purpose',
        isCollectionReadGranted: () => true,
        isVerbOpGranted: () => true,
      }),
    } as never;
    const inputs = buildChatToolRegistryInputs({
      getContactStore: () => undefined,
      getCollectionRegistry: () => undefined,
      getAuditLog: () => undefined,
      getEnrichmentStore: () => fakeEnrichmentStore,
      getRecipeStore: () =>
        ({ get: () => null, ids: () => [], listStored: () => [] }) as never,
      getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
      getExecuteRecipe: () => undefined,
      getReadGrantResolver: () => fakeResolver,
    });
    const registry = createInternalToolRegistry({
      tier1Handlers: inputs.tier1Handlers,
    });

    // internal channel + private topic → allowed; store.list fires
    // (Mary's own chat agent is user-permissive by construction).
    const internalResult = await registry.dispatch(
      'enrichment.search',
      { topic: 'purpose' },
      { channel: 'internal_function_call', session_id: 's-1' },
    );
    expect(internalResult.ok).toBe(true);
    expect(listCalls).toBe(1);
  });

  it('recipe.run propagates trigger_source from channel', async () => {
    const { buildChatToolRegistryInputs } = await import(
      '../chat-tool-handlers.js'
    );
    const { createInternalToolRegistry } = await import(
      '@recued/middleware/internal-tool-registry/index.js'
    );
    const capturedRequests: Array<{ trigger_source?: string }> = [];
    const fakeExecute = async (req: { trigger_source?: string }) => {
      capturedRequests.push(req);
      return { success: true } as never;
    };
    const fakeRecipeStore = {
      get: (_id: string) => ({ recipe_id: _id, version: 1 } as never),
      ids: () => ['r-1'],
      listStored: () => [],
    } as never;
    const inputs = buildChatToolRegistryInputs({
      getContactStore: () => undefined,
      getCollectionRegistry: () => undefined,
      getAuditLog: () => undefined,
      getEnrichmentStore: () => undefined,
      getRecipeStore: () => fakeRecipeStore,
      getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
      getExecuteRecipe: () => fakeExecute as never,
    });
    const registry = createInternalToolRegistry({
      tier1Handlers: inputs.tier1Handlers,
    });

    // mcp_wire → trigger_source: 'mcp'
    await registry.dispatch(
      'recipe.run',
      { recipe_id: 'r-1' },
      { channel: 'mcp_wire', mcp_token_id: 'tok-1' },
    );
    expect(capturedRequests[0]?.trigger_source).toBe('mcp');

    // internal → trigger_source: 'chat'
    await registry.dispatch(
      'recipe.run',
      { recipe_id: 'r-1' },
      { channel: 'internal_function_call', session_id: 's-1' },
    );
    expect(capturedRequests[1]?.trigger_source).toBe('chat');
  });
});

describe('D-137 Trio #D — Codex P1 fold: Tier 3 filtered from MCP wire', () => {
  it('handleToolsList filters Tier 3 entries from the projection', async () => {
    const registry = mkRegistry([
      mkTool('contact.search', 1),
      mkTool('recued-core/draft-email', 2),
      mkTool('exa.web_search', 3),
      mkTool('github.create_issue', 3),
    ]);
    const deps = mkDeps({ registry });
    const result = (await _testing.handleToolsList(deps)) as {
      tools: Array<{ name: string }>;
    };
    const names = result.tools.map((t) => t.name);
    // Tier 1 + Tier 2 present.
    expect(names).toContain('contact.search');
    expect(names).toContain('recued-core/draft-email');
    // Tier 3 filtered out — Mary's outbound MCP credentials are not
    // for external agents to invoke through her server.
    expect(names).not.toContain('exa.web_search');
    expect(names).not.toContain('github.create_issue');
  });

  it('handleToolCall refuses Tier 3 dispatches even if the tool name leaks past the catalog filter', async () => {
    let dispatchCalls = 0;
    const registry = mkRegistry([mkTool('exa.web_search', 3)], async () => {
      dispatchCalls += 1;
      return { ok: true, result: {} };
    });
    const deps = mkDeps({ registry });

    const res = await _testing.handleToolCall(
      { name: 'exa.web_search', arguments: { q: 'test' } },
      deps,
    );

    expect((res as { isError?: boolean }).isError).toBe(true);
    const errText = (res as { content: Array<{ text: string }> }).content[0]
      .text;
    expect(errText).toMatch(/connection\.mcp\.\* passthrough/);
    expect(errText).toMatch(/not exposed on the MCP wire/);
    // Registry dispatch never fires.
    expect(dispatchCalls).toBe(0);
  });
});
