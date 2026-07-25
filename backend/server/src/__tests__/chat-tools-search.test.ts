/** Lever-2 (2026-07-02) — `wrapRegistryWithToolsSearch` ratchets.
 *
 * The chat-only, index-mode-only injection of the `tools.search`
 * catalog-recall meta-tool. Pins: full inertness when disabled, correct
 * injection + dispatch when enabled, the kind-scope gate on the search
 * corpus, and the anti-loop result shapes.
 */

import { describe, expect, it } from 'vitest';
import type {
  ChatDispatchContext,
  ChatDispatchResult,
  ChatToolCatalogScopeState,
  InternalToolRegistry,
  ToolEntry,
} from '@recued/contracts';
import {
  TOOLS_SEARCH_TOOL_ENTRY,
  TOOLS_SEARCH_TOOL_NAME,
  wrapChatRegistryForCatalogMode,
  wrapChatRegistryForCatalogModes,
  wrapRegistryWithToolsSearch,
} from '../chat-tools-search.js';
import type { ChatCatalogDeliveryMode } from '../chat-orchestrator.js';

const mkEntry = (
  name: string,
  tier: 1 | 2 | 3,
  overrides: Partial<ToolEntry> = {},
): ToolEntry => ({
  name,
  tier,
  description: `desc for ${name}`,
  arg_schema: { type: 'object' },
  topic_tags: [name.split('/').pop() ?? name],
  classification: tier === 1 ? 'read' : 'unknown',
  concurrency_safe: tier === 1,
  ...overrides,
});

const CTX: ChatDispatchContext = { channel: 'internal_function_call' };

const mkInner = (
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
    dispatchImpl ??
    (async (name) => ({ ok: false, reason: 'unknown_tool', detail: name })),
  subscribeRefresh: () => () => undefined,
});

const CATALOG: ReadonlyArray<ToolEntry> = [
  mkEntry('contact.search', 1),
  mkEntry('recipe.run', 1),
  mkEntry('recued-core/draft-followup-email', 2, {
    topic_tags: ['email', 'draft'],
    description: 'Draft a follow-up email',
  }),
  mkEntry('recued-core/summarize-pdf', 2, {
    topic_tags: ['pdf', 'summary'],
    description: 'Summarize a PDF',
  }),
  mkEntry('peer.tool', 3),
];

const scope = (kinds: string[]): ChatToolCatalogScopeState => ({
  enabled_kinds: kinds as ChatToolCatalogScopeState['enabled_kinds'],
  updated_at: 1,
});

describe('TOOLS_SEARCH_TOOL_ENTRY description is mode-agnostic (index AND lean-core)', () => {
  // The one entry is injected in BOTH thinning modes, so its self-describing
  // copy must be true in both: index leaves recipes listed-without-schema,
  // lean-core drops the listing entirely. A description asserting only the
  // index premise ("the catalog lists each recipe") would contradict the
  // lean-core system-prompt guidance and under-prime discovery (codex MEDIUM).
  const d = TOOLS_SEARCH_TOOL_ENTRY.description ?? '';

  it('names both the leaned-listing and the dropped-listing cases', () => {
    expect(d).toContain('index mode');
    expect(d).toContain('lean-core mode');
    expect(d).toContain('not listed at all');
  });

  it('does not assert the index-only "catalog lists each recipe" premise', () => {
    expect(d).not.toContain('the catalog lists each recipe');
  });

  it('names work read among the already-defined core tools (kept in sync with Tier-1)', () => {
    expect(d).toContain('work search + read');
    expect(d).toContain('never search for those');
  });

  it('keeps the anti-loop no-match stop', () => {
    expect(d).toContain('no match');
    expect(d).toContain('do NOT retry');
  });
});

describe('wrapChatRegistryForCatalogMode — the wire seam maps mode → injection', () => {
  // This is the gate the composition wire actually uses (it passes the catalog
  // mode, not a raw boolean). Locking it here kills the codex HIGH mutation:
  // a regression to `mode === 'index'` would drop tools.search in lean-core
  // while the system prompt still tells the model to call it.
  const getScope = () => null;
  const catalog: ReadonlyArray<ToolEntry> = [mkEntry('mail.search', 1), mkEntry('recued/recipe.a', 2)];

  it('injects tools.search for BOTH thinning modes (index AND lean-core)', () => {
    for (const mode of ['index', 'lean-core'] as ReadonlyArray<ChatCatalogDeliveryMode>) {
      const reg = wrapChatRegistryForCatalogMode(mkInner(catalog), mode, getScope);
      expect(reg.getByName(TOOLS_SEARCH_TOOL_NAME)).not.toBeNull();
      expect(reg.list().some((e) => e.name === TOOLS_SEARCH_TOOL_NAME)).toBe(true);
      expect(reg.listByTier(1).some((e) => e.name === TOOLS_SEARCH_TOOL_NAME)).toBe(true);
    }
  });

  it('leaves full mode fully inert (tools.search absent, unknown_tool on dispatch)', async () => {
    const reg = wrapChatRegistryForCatalogMode(mkInner(catalog), 'full', getScope);
    expect(reg.getByName(TOOLS_SEARCH_TOOL_NAME)).toBeNull();
    expect(reg.list().some((e) => e.name === TOOLS_SEARCH_TOOL_NAME)).toBe(false);
    expect(await reg.dispatch(TOOLS_SEARCH_TOOL_NAME, { query: 'x' }, CTX)).toMatchObject({
      ok: false,
      reason: 'unknown_tool',
    });
  });
});

describe('wrapChatRegistryForCatalogModes — per-slot enable-if-any-source-thins', () => {
  // The per-slot wire seam: the wrapper is construction-time (can't be per-turn),
  // and per-source modes are LIVE, so it enables tools.search whenever ANY source
  // could thin (a superset dispatch; presentation drops it on full turns).
  const getScope = () => null;
  const catalog: ReadonlyArray<ToolEntry> = [mkEntry('mail.search', 1), mkEntry('recued/recipe.a', 2)];

  it('injects tools.search if ANY of the possible per-source modes thins', () => {
    // free_pool → index while BYOK slots stay full: some source thins → enabled.
    const reg = wrapChatRegistryForCatalogModes(mkInner(catalog), ['full', 'index'], getScope);
    expect(reg.getByName(TOOLS_SEARCH_TOOL_NAME)).not.toBeNull();
    expect(reg.list().some((e) => e.name === TOOLS_SEARCH_TOOL_NAME)).toBe(true);
  });

  it('stays inert when EVERY possible mode is full (no source thins)', () => {
    const reg = wrapChatRegistryForCatalogModes(mkInner(catalog), ['full', 'full'], getScope);
    expect(reg.getByName(TOOLS_SEARCH_TOOL_NAME)).toBeNull();
    expect(reg.list().some((e) => e.name === TOOLS_SEARCH_TOOL_NAME)).toBe(false);
  });
});

describe('wrapRegistryWithToolsSearch — disabled (full mode) is fully inert', () => {
  it('returns the inner registry untouched', async () => {
    const inner = mkInner(CATALOG);
    const wrapped = wrapRegistryWithToolsSearch(inner, {
      enabled: false,
      getScope: () => null,
    });
    expect(wrapped).toBe(inner);
    expect(wrapped.list().map((e) => e.name)).not.toContain(TOOLS_SEARCH_TOOL_NAME);
    expect(wrapped.getByName(TOOLS_SEARCH_TOOL_NAME)).toBeNull();
    // Dispatch resolves unknown_tool exactly as before the slice.
    await expect(wrapped.dispatch(TOOLS_SEARCH_TOOL_NAME, { query: 'x' }, CTX)).resolves.toEqual({
      ok: false,
      reason: 'unknown_tool',
      detail: TOOLS_SEARCH_TOOL_NAME,
    });
  });
});

describe('wrapRegistryWithToolsSearch — enabled (index mode) injection', () => {
  const wrapped = (
    catalog: ReadonlyArray<ToolEntry> = CATALOG,
    getScope: () => ChatToolCatalogScopeState | null = () => null,
  ): InternalToolRegistry =>
    wrapRegistryWithToolsSearch(mkInner(catalog), { enabled: true, getScope });

  it('injects tools.search immediately after the last Tier-1 entry', () => {
    const names = wrapped().list().map((e) => e.name);
    expect(names).toContain(TOOLS_SEARCH_TOOL_NAME);
    // After recipe.run (last Tier-1), before the first Tier-2 entry.
    expect(names).toEqual([
      'contact.search',
      'recipe.run',
      TOOLS_SEARCH_TOOL_NAME,
      'recued-core/draft-followup-email',
      'recued-core/summarize-pdf',
      'peer.tool',
    ]);
  });

  it('surfaces tools.search in listByTier(1) and getByName', () => {
    const reg = wrapped();
    expect(reg.listByTier(1).map((e) => e.name)).toContain(TOOLS_SEARCH_TOOL_NAME);
    expect(reg.listByTier(2).map((e) => e.name)).not.toContain(TOOLS_SEARCH_TOOL_NAME);
    const entry = reg.getByName(TOOLS_SEARCH_TOOL_NAME);
    expect(entry?.tier).toBe(1);
    expect(entry?.classification).toBe('read');
    expect(entry?.concurrency_safe).toBe(true);
  });

  it('delegates non-tools.search dispatch to the inner registry with args + ctx intact', async () => {
    const seen: Array<{ name: string; args: unknown; ctx: ChatDispatchContext }> = [];
    const inner = mkInner(CATALOG, async (name, args, ctx) => {
      seen.push({ name, args, ctx });
      return { ok: true, result: { ran: name } };
    });
    const reg = wrapRegistryWithToolsSearch(inner, { enabled: true, getScope: () => null });
    const args = { q: 'x', limit: 3 };
    await expect(reg.dispatch('contact.search', args, CTX)).resolves.toEqual({
      ok: true,
      result: { ran: 'contact.search' },
    });
    // Args + ctx forwarded verbatim (not dropped or rewritten by the wrapper).
    expect(seen).toEqual([{ name: 'contact.search', args, ctx: CTX }]);
  });
});

describe('wrapRegistryWithToolsSearch — dispatch search', () => {
  const reg = (
    getScope: () => ChatToolCatalogScopeState | null = () => null,
  ): InternalToolRegistry =>
    wrapRegistryWithToolsSearch(mkInner(CATALOG), { enabled: true, getScope });

  it('returns matching Tier-2 entries with full args_schema + match guidance', async () => {
    const res = await reg().dispatch(TOOLS_SEARCH_TOOL_NAME, { query: 'follow-up email' }, CTX);
    expect(res.ok).toBe(true);
    const result = (res as { result: Record<string, unknown> }).result;
    expect(result.match_count).toBe(1);
    expect(result.matches).toEqual([
      {
        recipe_slug: 'recued-core/draft-followup-email',
        description: 'Draft a follow-up email',
        args_schema: { type: 'object' },
      },
    ]);
    expect(String(result.guidance)).toContain('Call the one you need');
    // 2nd-iteration dispatch nudge: the model searched, found the recipe, then
    // narrated instead of dispatching (bench 81 p2/p4). Lock the emit-now /
    // don't-describe follow-through at the exact point the model reads results.
    expect(String(result.guidance)).toMatch(/EMIT that tool call/);
    expect(String(result.guidance)).toContain('do not describe or summarize the recipe');
  });

  it('searches ONLY the Tier-2 corpus — a Tier-1 tool name is never a match', async () => {
    // 'contact.search' is a Tier-1 entry whose tag + description contain
    // "contact". Searching inner.list() (all tiers) would surface it; the
    // corpus is inner.listByTier(2) only, so it must not appear.
    const res = await reg().dispatch(TOOLS_SEARCH_TOOL_NAME, { query: 'contact' }, CTX);
    const result = (res as { result: Record<string, unknown> }).result;
    const slugs = (result.matches as Array<{ recipe_slug: string }>).map((m) => m.recipe_slug);
    expect(slugs).not.toContain('contact.search');
    expect(result.match_count).toBe(0);
  });

  it('returns ok:true with STOP-search guidance on no match (anti-loop)', async () => {
    const res = await reg().dispatch(TOOLS_SEARCH_TOOL_NAME, { query: 'quantum blockchain' }, CTX);
    expect(res.ok).toBe(true);
    const result = (res as { result: Record<string, unknown> }).result;
    expect(result.match_count).toBe(0);
    expect(result.matches).toEqual([]);
    expect(String(result.guidance)).toContain('Do NOT retry');
  });

  it('rejects a missing/blank query as invalid_args (a correction, not a loop)', async () => {
    await expect(reg().dispatch(TOOLS_SEARCH_TOOL_NAME, {}, CTX)).resolves.toMatchObject({
      ok: false,
      reason: 'invalid_args',
    });
    await expect(
      reg().dispatch(TOOLS_SEARCH_TOOL_NAME, { query: '   ' }, CTX),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid_args' });
  });

  it('honors Mary per-kind catalog scope — a disabled-kind recipe is not rediscoverable', async () => {
    // draft-followup requires the 'http' kind; summarize-pdf requires 'storage'.
    const catalog: ReadonlyArray<ToolEntry> = [
      mkEntry('contact.search', 1),
      mkEntry('recued-core/draft-followup-email', 2, {
        topic_tags: ['email'],
        description: 'Draft a follow-up email',
        requires_kinds: ['http'],
      }),
      mkEntry('recued-core/summarize-pdf', 2, {
        topic_tags: ['pdf'],
        description: 'Summarize a PDF email attachment',
        requires_kinds: ['storage'],
      }),
    ];
    // Scope enables only 'storage' → the 'http' recipe is kind-gated out.
    const reg = wrapRegistryWithToolsSearch(mkInner(catalog), {
      enabled: true,
      getScope: () => scope(['storage']),
    });
    const res = await reg.dispatch(TOOLS_SEARCH_TOOL_NAME, { query: 'email' }, CTX);
    const result = (res as { result: Record<string, unknown> }).result;
    const slugs = (result.matches as Array<{ recipe_slug: string }>).map((m) => m.recipe_slug);
    // Both descriptions contain "email", but the http-kind recipe is gated out.
    expect(slugs).toContain('recued-core/summarize-pdf');
    expect(slugs).not.toContain('recued-core/draft-followup-email');
  });
});
