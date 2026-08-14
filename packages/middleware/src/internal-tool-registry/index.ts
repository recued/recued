/** D-137 P1 § A.1.1 — InternalToolRegistry substrate.
 *
 *  The chat agent's per-turn tool catalog lives behind this registry.
 *  Three tiers (T1 canonical primitives / T2 installed recipes / T3
 *  `connection.mcp.*` passthroughs) unify into one `list()` /
 *  `dispatch()` surface. Tier dispatch is internal — callers don't
 *  need to know tier provenance.
 *
 *  P1 substrate ships:
 *    - The closed-list Tier 1 entry table sourced from
 *      `TIER1_TOOL_DESCRIPTORS` in `@recued/contracts`.
 *    - A `createInternalToolRegistry()` factory that returns an
 *      `InternalToolRegistry` with Tier 1 entries wired in.
 *    - Per-Tier-1 dispatch handler stubs returning `{ ok: false,
 *      reason: 'not_implemented' }` until the per-primitive wiring
 *      lands in subsequent slices.
 *    - The channel-isolation invariant gate (channel ===
 *      'mcp_wire' MUST carry an `mcp_token_id`; channel ===
 *      'internal_function_call' MUST carry a `session_id`).
 *
 *  Tier 2 + Tier 3 surface enumeration lands in Wave 2 per the
 *  path-routing amendment execution order; the registry's public
 *  shape already accommodates them (per `listByTier(2 | 3)`
 *  returning an empty array at P1).
 *
 *  The factory takes no constructor-time configuration; it returns a
 *  registry seeded with the closed Tier 1 set, and the caller wires
 *  per-Tier-1 handlers later via the same factory's overrides
 *  hook (next slice). This keeps P1 narrow and lets the audit /
 *  channel-isolation ratchet sit on a stable surface. */

import {
  CHAT_DISPATCH_CHANNEL_SET,
  CHAT_DISPATCH_REASONS,
  TIER1_TOOL_DESCRIPTORS,
  TIER1_TOOL_NAME_SET,
  TIER1_TOOL_NAMES,
  type ChatDispatchContext,
  type ChatDispatchResult,
  type ConnectionMcpAnnotationState,
  type InternalToolRegistry,
  type Tier1ToolName,
  type ToolEntry,
  type ToolTier,
} from '@recued/contracts';
import {
  buildTier2Catalog,
  type IngredientKindLookup,
  type OpKindLookup,
  type Tier2RecipeEntry,
} from '@recued/recipes';

/** Per-Tier-1 handler signature. Returning a rejected promise is
 *  reserved for engine errors; expected failures (kind-gating, capacity
 *  gaps, classification blocks) resolve `{ ok: false, reason }`. */
export type Tier1Handler = (
  args: unknown,
  ctx: ChatDispatchContext,
) => Promise<ChatDispatchResult>;

/** P1 default handler — every Tier 1 entry resolves
 *  `{ ok: false, reason: 'not_implemented' }` until the per-primitive
 *  landing wires actual logic. The shape is intentionally synchronous
 *  Promise (no I/O) so the registry's substrate-level tests remain
 *  pure. */
const notImplementedHandler: Tier1Handler = async () => ({
  ok: false,
  reason: 'not_implemented',
});

/** Build the immutable Tier 1 catalog from the contract-level
 *  descriptor table. Each entry is a closed-list reference; widening
 *  the catalog requires editing `TIER1_TOOL_DESCRIPTORS` in
 *  `packages/contracts/src/chat.ts`. */
const buildTier1Catalog = (): ReadonlyArray<ToolEntry> =>
  TIER1_TOOL_NAMES.map((name) => {
    const descriptor = TIER1_TOOL_DESCRIPTORS[name];
    return {
      name: descriptor.name,
      tier: 1 as const,
      description: descriptor.description,
      arg_schema: descriptor.arg_schema,
      topic_tags: descriptor.topic_tags,
      classification: descriptor.classification,
      // D-164 § 6 — closed-list per-Tier-1 batch-dispatch safety from
      // `TIER1_CONCURRENCY_SAFE`. The catalog substrate's section
      // assemblers + framework dispatch primitive (P5) read this off
      // the projected entry directly.
      concurrency_safe: descriptor.concurrency_safe,
    } satisfies ToolEntry;
  });

/** D-137 Wave 2.1 — Tier 2 catalog source. Snapshot of currently-
 *  installed recipes (recipe definition + publisher scope) that the
 *  factory re-projects on every catalog read. The caller threads its
 *  recipe-store (server: `RecipeStore.listStored`; tests: a static
 *  fixture). Re-projection is cheap (O(N_recipes); N is bounded — a
 *  user typically has tens of installed recipes), so we don't bother
 *  caching at the registry layer; the chat orchestrator already
 *  scopes its per-turn catalog snapshot to one call. */
export interface Tier2Source {
  /** Synchronous snapshot of installed recipes. */
  listRecipes(): ReadonlyArray<Tier2RecipeEntry>;
}

/** D-137 Wave 2.1 — Tier 2 dispatch handler signature. Tier 2 entries
 *  resolve through the recipe-engine layer in subsequent slices; W2.1
 *  ships the catalog enumeration only and leaves dispatch returning
 *  `{ ok: false, reason: 'not_implemented' }`. */
export type Tier2Handler = (
  toolName: string,
  args: unknown,
  ctx: ChatDispatchContext,
) => Promise<ChatDispatchResult>;

/** Default Tier 2 dispatch — until the per-recipe invocation handler
 *  wires in a later slice, every Tier 2 dispatch resolves
 *  `not_implemented`. Catalog enumeration is still load-bearing for
 *  filter-tools / transparency / main-turn packet composition. */
const tier2NotImplementedHandler: Tier2Handler = async () => ({
  ok: false,
  reason: 'not_implemented',
});

/** D-137 Wave 2.3 — Tier 3 catalog source. Snapshot of Mary's per-
 *  connection MCP tool annotations (cached `tools/list` snapshot +
 *  per-tool overrides + per-connection topic-tag chips). The factory
 *  re-projects on every catalog read so toggle changes in Settings →
 *  Connections surface at the next chat turn without an explicit
 *  refresh signal. Production wires through the
 *  `ChatConnectionMcpStore.listAnnotations`; tests inject a static
 *  fixture. */
export interface Tier3Source {
  /** Synchronous snapshot of every persisted MCP-connection
   *  annotation. */
  listAnnotations(): ReadonlyArray<ConnectionMcpAnnotationState>;
}

/** D-137 Wave 2.3 — Tier 3 dispatch handler signature. Tier 3 entries
 *  resolve through the existing D-125 outbound MCP adapter
 *  (`connection.mcp.*`) in subsequent slices; W2.3 ships the catalog
 *  enumeration only and leaves dispatch returning
 *  `{ ok: false, reason: 'not_implemented' }`. */
export type Tier3Handler = (
  toolName: string,
  args: unknown,
  ctx: ChatDispatchContext,
) => Promise<ChatDispatchResult>;

/** Default Tier 3 dispatch — until the outbound MCP dispatch glue
 *  lands in a later slice (which will route through the D-125
 *  connection adapter), every Tier 3 dispatch resolves
 *  `not_implemented`. Catalog enumeration is still load-bearing for
 *  filter-tools / main-turn packet composition. */
const tier3NotImplementedHandler: Tier3Handler = async () => ({
  ok: false,
  reason: 'not_implemented',
});

/** Factory options. P1 accepts handler overrides keyed on the closed
 *  `Tier1ToolName` set; unspecified entries fall back to the
 *  not-implemented stub. Wave 2.1 adds Tier 2 enumeration sources
 *  (recipe registry + ingredient manifest kind lookup) — Tier 2
 *  dispatch still returns `not_implemented` at this slice. */
export interface CreateInternalToolRegistryOptions {
  /** Per-Tier-1 handler overrides. Missing entries fall back to the
   *  not-implemented stub. */
  tier1Handlers?: Partial<Record<Tier1ToolName, Tier1Handler>>;
  /** ⛔⛔ D-228 slice 5 — THE CONTRACT GATE for Tier-1 primitives, injected
   *  because `packages/` may never import `backend/` (the public boundary) and
   *  the op-admission gate is server-side. The host passes a closure over
   *  `isOpGranted(ctx.execution_source, primitive.<name>)`.
   *
   *  ⚠ ABSENT ⇒ NO GATE, deliberately, and this is NOT the fail-open mistake it
   *  looks like: these are the always-on chat tools, and a registry built
   *  without a host gate (every test harness, and any embedder that has no
   *  contract substrate at all) must keep working. The enforcement point is the
   *  HOST, which always supplies one; the callback's absence means "no contract
   *  substrate here", not "allow".
   *
   *  🔑 On the internal chat channel the resolved principal is the OWNER —
   *  `buildChatExecutionSource` mints `(chat, user_self)` and
   *  `resolveGrantGoverningContractId` maps that to `OWNER_CONTRACT_ID`. The
   *  owner's author-default is permissive AND the boot reconcile seeds an
   *  explicit `granted:true` row per primitive, so wiring this changes nothing
   *  until the owner REVOKES one in Settings → Contracts — which is exactly the
   *  "permissive, tightenable" half that had no enforcement before. */
  admitTier1?: (name: Tier1ToolName, ctx: ChatDispatchContext) => boolean;
  /** Launch-prep audit guard for Tier 1 entries classified
   *  irrelevant/never-ship. Such entries are hidden from catalog
   *  enumeration only while they still resolve to the default
   *  not-implemented handler; a real handler override keeps the tool
   *  visible. */
  hiddenUnbackedTier1Tools?: ReadonlyArray<Tier1ToolName>;
  /** D-137 Wave 2.1 — Tier 2 source. When absent, Tier 2 catalog is
   *  empty (matches P1 behaviour). When present, the factory pulls
   *  fresh recipes on every catalog read, so installing or removing a
   *  recipe surfaces in the catalog at the next `list()` call without
   *  the caller having to mint a new registry. */
  tier2Source?: Tier2Source;
  /** D-137 Wave 2.1 — Ingredient manifest kind lookup. Used by the
   *  Tier 2 builder to derive each recipe's `requires_kinds` from its
   *  step graph (so Mary's per-kind catalog scope toggle can gate
   *  recipes off). Synchronous; the caller is expected to keep its
   *  manifest registry resident or precompute a `Map<slug, kind>`.
   *  When absent (or returns `null` for every slug), Tier 2 entries
   *  surface with an empty `requires_kinds` set — the kind gate
   *  becomes a no-op rather than a hard refusal. */
  manifestLookup?: IngredientKindLookup;
  /** D-182 F2 — resolve a recipe's `op:` steps to their backing kind so the kind
   *  gate also fires for op-migrated recipes. A KERNEL closed-kind op is resolved
   *  inline by `deriveRecipeRequiresKinds`; this covers the rest (canonical →
   *  `connection`, Tier-P → the installed pack's catalog kind), built by the server
   *  via `createOpKindLookup` with its pack inventory. Absent → only the inline
   *  kernel resolution applies (canonical / Tier-P ops contribute no kind). */
  opKindLookup?: OpKindLookup;
  /** D-137 Wave 2.1 — Tier 2 dispatch override. Defaults to the
   *  not-implemented stub; the per-recipe invocation handler plugs in
   *  here when it lands in a subsequent slice. */
  tier2Dispatch?: Tier2Handler;
  /** D-137 Wave 2.3 — Tier 3 source. When absent, Tier 3 catalog is
   *  empty (matches behaviour prior to Mary enrolling any MCP
   *  connection). When present, the factory pulls fresh annotations on
   *  every catalog read, so a Settings → Connections classification
   *  surfaces in the catalog at the next `list()` call without the
   *  caller having to mint a new registry. */
  tier3Source?: Tier3Source;
  /** D-137 Wave 2.3 — Tier 3 dispatch override. Defaults to the
   *  not-implemented stub; the outbound MCP dispatch glue (D-125
   *  connection adapter + per-connection rate-limit + audit) wires
   *  here in a subsequent slice. */
  tier3Dispatch?: Tier3Handler;
}

/** § A.1.1 — channel-isolation invariant guard. Returns
 *  `null` on success, or a `ChatDispatchResult` carrying
 *  `reason: 'channel_denied'` on violation. The error message is
 *  diagnostic-only (never reaches the user prompt). */
const assertChannelInvariants = (
  ctx: ChatDispatchContext,
): ChatDispatchResult | null => {
  if (!CHAT_DISPATCH_CHANNEL_SET.has(ctx.channel)) {
    return {
      ok: false,
      reason: 'channel_denied',
      detail: `unknown dispatch channel: ${String(ctx.channel)}`,
    };
  }
  if (ctx.channel === 'internal_function_call') {
    if (!ctx.session_id) {
      return {
        ok: false,
        reason: 'channel_denied',
        detail: 'internal_function_call channel requires session_id',
      };
    }
    if (ctx.mcp_token_id) {
      return {
        ok: false,
        reason: 'channel_denied',
        detail: 'internal_function_call channel must not carry mcp_token_id',
      };
    }
  } else if (ctx.channel === 'mcp_wire') {
    if (!ctx.mcp_token_id) {
      return {
        ok: false,
        reason: 'channel_denied',
        detail: 'mcp_wire channel requires mcp_token_id',
      };
    }
    if (ctx.session_id) {
      return {
        ok: false,
        reason: 'channel_denied',
        detail: 'mcp_wire channel must not carry session_id',
      };
    }
    if (ctx.turn_id) {
      return {
        ok: false,
        reason: 'channel_denied',
        detail: 'mcp_wire channel must not carry turn_id',
      };
    }
  }
  return null;
};

/** § A.1.1 — registry factory. Returns an `InternalToolRegistry`
 *  seeded with the closed Tier 1 catalog. Tier 2 (installed recipes
 *  with `chat_exposed: true`) enumeration wires through
 *  `options.tier2Source` + `options.manifestLookup` from Wave 2.1
 *  onward; Tier 3 (`connection.mcp.*` passthroughs) lands in Wave
 *  2.3. */
export const createInternalToolRegistry = (
  options: CreateInternalToolRegistryOptions = {},
): InternalToolRegistry => {
  const tier1Catalog = buildTier1Catalog();
  const tier1Index = new Map<string, ToolEntry>(
    tier1Catalog.map((entry) => [entry.name, entry] as const),
  );
  const tier1Handlers: Record<Tier1ToolName, Tier1Handler> = {
    'contact.search': notImplementedHandler,
    'mail.search': notImplementedHandler,
    'calendar.search': notImplementedHandler,
    'memory.search': notImplementedHandler,
    'memory.write': notImplementedHandler,
    'enrichment.search': notImplementedHandler,
    'deal.search': notImplementedHandler,
    'account.search': notImplementedHandler,
    'work.search': notImplementedHandler,
    'work.read': notImplementedHandler,
    'file.search': notImplementedHandler,
    'recipe.run': notImplementedHandler,
  };
  if (options.tier1Handlers) {
    for (const [name, handler] of Object.entries(options.tier1Handlers) as Array<
      [Tier1ToolName, Tier1Handler]
    >) {
      if (TIER1_TOOL_NAME_SET.has(name)) {
        tier1Handlers[name] = handler;
      }
    }
  }
  const hiddenUnbackedTier1Tools = new Set<Tier1ToolName>(
    (options.hiddenUnbackedTier1Tools ?? []).filter((name) =>
      TIER1_TOOL_NAME_SET.has(name),
    ),
  );
  // Tier 2 lookup defaults to a "kind unknown" projection — the
  // registry can still enumerate exposed recipes; their
  // `requires_kinds` will be empty so Mary's per-kind toggle becomes a
  // no-op for those entries (filter-tools still keys other gates off
  // them).
  const manifestLookup: IngredientKindLookup =
    options.manifestLookup ?? (() => null);
  const opKindLookup: OpKindLookup | undefined = options.opKindLookup;
  const tier2Source: Tier2Source = options.tier2Source
    ?? { listRecipes: () => [] };
  const tier2Dispatch: Tier2Handler =
    options.tier2Dispatch ?? tier2NotImplementedHandler;
  // D-137 W2.3 — Tier 3 source defaults to an empty annotation list
  // when no source is wired (matches behaviour prior to enrollment).
  const tier3Source: Tier3Source = options.tier3Source
    ?? { listAnnotations: () => [] };
  const tier3Dispatch: Tier3Handler =
    options.tier3Dispatch ?? tier3NotImplementedHandler;

  const refreshSubscribers = new Set<() => void>();

  /** Build a fresh Tier 2 snapshot. Pulled on every catalog read; the
   *  cost is O(N_installed_recipes) per call. Source-side mutation
   *  (install / uninstall) surfaces at the next call without an
   *  explicit refresh signal. */
  const projectTier2 = (): ReadonlyArray<ToolEntry> =>
    buildTier2Catalog(tier2Source.listRecipes(), manifestLookup, opKindLookup);

  /** ⛔⛔ D-228 slice 4 — ALWAYS EMPTY. Tier 3 projected `<connection>.<tool>`
   *  entries from `tool_overrides`, the chat presentation store D-225 named as
   *  the standing defect; that store is deleted and an enrolled MCP tool now
   *  reaches chat exactly once, as a contract-governed `recued_op_*` pack
   *  operation.
   *
   *  ⚠ The TIER ITSELF IS NOT NARROWED OUT of `ToolEntry`, and the seams around
   *  it (`tier3Source`, `tier3Dispatch`, the prompt-cache's `tier !== 3` filter)
   *  stay. Narrowing a shipped union is the change that breaks a consumer nobody
   *  remembered; an empty producer breaks nothing and reads honestly. */
  const projectTier3 = (): ReadonlyArray<ToolEntry> => {
    void tier3Source;
    return [];
  };

  const projectTier1ForList = (): ReadonlyArray<ToolEntry> => {
    if (hiddenUnbackedTier1Tools.size === 0) return tier1Catalog;
    return tier1Catalog.filter((entry) => {
      const name = entry.name as Tier1ToolName;
      return (
        !hiddenUnbackedTier1Tools.has(name) ||
        tier1Handlers[name] !== notImplementedHandler
      );
    });
  };

  const list = (): ReadonlyArray<ToolEntry> => {
    const tier1 = projectTier1ForList();
    const tier2 = projectTier2();
    const tier3 = projectTier3();
    if (tier2.length === 0 && tier3.length === 0) return tier1;
    return [...tier1, ...tier2, ...tier3];
  };

  const listByTier = (tier: ToolTier): ReadonlyArray<ToolEntry> => {
    if (tier === 1) return projectTier1ForList();
    if (tier === 2) return projectTier2();
    if (tier === 3) return projectTier3();
    return [];
  };

  const getByName = (name: string): ToolEntry | null => {
    const t1 = tier1Index.get(name);
    if (t1) return t1;
    // Tier 2 is keyed on `<publisher>/<recipe_id>`; do an indexed scan
    // of the fresh projection. The N here is the count of currently-
    // installed exposed recipes (bounded; tens at most), so a linear
    // find is fine vs. maintaining a parallel index.
    const tier2 = projectTier2();
    const t2 = tier2.find((entry) => entry.name === name);
    if (t2) return t2;
    // Tier 3 is keyed on `<connection_name>.<tool_name>`. Same
    // bounded-N argument — Mary's MCP enrollments are typically a
    // handful, each advertising tens of tools — linear find is fine.
    const tier3 = projectTier3();
    return tier3.find((entry) => entry.name === name) ?? null;
  };

  const dispatch = async (
    name: string,
    args: unknown,
    ctx: ChatDispatchContext,
  ): Promise<ChatDispatchResult> => {
    const channelError = assertChannelInvariants(ctx);
    if (channelError) return channelError;

    const t1 = tier1Index.get(name);
    if (t1) {
      // D-228 slice 5 — the contract decides before the handler runs. Absent
      // callback ⇒ no contract substrate on this host (see the option's doc).
      if (options.admitTier1 && !options.admitTier1(name as Tier1ToolName, ctx)) {
        return {
          ok: false,
          reason: 'classification_blocked',
          detail:
            `'${name}' is turned off for this contract. `
            + 'Re-enable it in Settings → Contracts → Ops, or tell the user it is unavailable.',
        };
      }
      const handler = tier1Handlers[name as Tier1ToolName];
      return handler(args, ctx);
    }

    const tier2 = projectTier2();
    const t2 = tier2.find((entry) => entry.name === name);
    if (t2) {
      return tier2Dispatch(name, args, ctx);
    }

    const tier3 = projectTier3();
    const t3 = tier3.find((entry) => entry.name === name);
    if (t3) {
      return tier3Dispatch(name, args, ctx);
    }

    return {
      ok: false,
      reason: 'unknown_tool',
      detail: `no Tier 1 / Tier 2 / Tier 3 entry for tool name "${name}"`,
    };
  };

  const subscribeRefresh = (callback: () => void): (() => void) => {
    refreshSubscribers.add(callback);
    return () => refreshSubscribers.delete(callback);
  };

  return {
    list,
    listByTier,
    getByName,
    dispatch,
    subscribeRefresh,
  };
};

/** Re-export the closed-reason list for callers that need to render
 *  failure copy. Mirrors the contract-side export so engine consumers
 *  don't need to import contracts directly. */
export { CHAT_DISPATCH_REASONS };

/** Returns the closed-list set of Tier 1 names. Provided as a
 *  function (not a static export) so substrate-level test ratchets can
 *  assert that the registry's `list().filter(tier===1)` returns the
 *  same set without re-importing the descriptor table. */
export const tier1ToolNames = (): ReadonlyArray<Tier1ToolName> => TIER1_TOOL_NAMES;
