/** Lever-2 (2026-07-02) — `tools.search`, the index-mode catalog-recall
 *  meta-tool, injected as a CHAT-ONLY synthetic Tier-1 tool.
 *
 *  Index mode (slice 1) ships the Tier-2 recipe catalog as slug + one-line
 *  summary only — the arg schemas are withheld to shrink the cacheable
 *  prefix. `tools.search` lets the model recover the full, invocable
 *  definitions on demand: query → top-K exposed Tier-2 entries WITH their
 *  `args_schema`.
 *
 *  Why a chat-registry wrapper rather than a closed-list `Tier1ToolName`
 *  (the same shape as `wrapRegistryWithEnrichmentTopicTools`): a closed-list
 *  tool is dispatchable on EVERY registry surface (the MCP wire, the door
 *  grant catalog, full-mode chat), and merely hiding it from a `list()`
 *  projection does not stop dispatch-by-name. Injecting it into ONLY the
 *  chat registry view, ONLY when index mode is enabled, makes it:
 *    - absent from the raw registry the MCP wire + door grant catalog read
 *      (never MCP-callable, never grantable — no per-token-grant bypass);
 *    - completely inert in full mode / when the knob is off — the wrapper
 *      returns `inner` untouched, so a stray call resolves `unknown_tool`
 *      exactly as before this slice;
 *    - grant honest — the dispatch closure narrows the search corpus to the
 *      Tier-2 set the turn's grant admits (D-247), the same set the main
 *      catalog shows, so search can never surface a recipe the catalog would
 *      not. (The per-kind scope it also applied is retired — D-137 W2.2.)
 *
 *  It stays read-only (classification `'read'`, no risk tier, no vault, no
 *  writes) so dispatch bypasses the plan-approval gate like the other
 *  `*.search` primitives. */

import {
  type ChatDispatchContext,
  type ChatDispatchResult,
  type ExecutionSource,
  type InternalToolRegistry,
  type ToolEntry,
  type ToolTier,
} from '@recued/contracts';
import { searchToolCatalog } from '@recued/recipes';
import {
  anyCatalogModeUsesToolsSearch,
  catalogModeUsesToolsSearch,
  type ChatCatalogDeliveryMode,
} from './chat-orchestrator.js';
import {
  DOC_MATCHES_GUIDANCE,
  searchDocIndex,
} from './chat-doc-search.js';
import { TOOLS_SEARCH_TOOL_NAME } from './chat-tools-search-name.js';

// Re-exported so existing importers (`chat-tool-handlers.ts`, tests) resolve it
// unchanged; the canonical declaration is the leaf `chat-tools-search-name.ts`
// (imported by `chat-orchestrator.ts`'s per-turn presentation drop, cycle-free).
export { TOOLS_SEARCH_TOOL_NAME };

/** No imposed result cap (owner decision, 2026-08-20). A cap turned the
 *  equal-score name tie-break in `searchToolCatalog` into an EXCLUSION
 *  channel: with `limit` slots, a publisher who names a recipe `aaa-…` can
 *  push an equal-scoring rival out of the result set entirely (round-13
 *  audit, T4 § 6.4). Uncapped, ties still order the list but nothing is
 *  hidden. The model may still bound the count itself via `limit`. */

/** The synthetic Tier-1 catalog entry. Hand-built (not a closed-list
 *  `Tier1ToolName`) because this tool is chat-index-mode-only. */
export const TOOLS_SEARCH_TOOL_ENTRY: ToolEntry = {
  name: TOOLS_SEARCH_TOOL_NAME,
  tier: 1,
  description:
    "Find installed recipe tools and pack actions by capability. Recipe tools and actions that \"available_tools\" does not fully show — listed with only a one-line summary and no argument schema (index mode), or not listed at all (lean-core mode) — are recovered here: pass a short `query` of KEYWORDS describing the capability — the nouns and verbs that name it, not the user's sentence (\"follow-up email draft\", \"summarize PDF\", \"overdue invoices\", \"buildings properties\") and it returns every matching tool, each with the `args_schema` you then call directly by `recipe_slug` (pass `limit` only if you want fewer). The always-listed core tools (contact / mail / calendar / memory / enrichment / deal / account / work search + read, recipe.run) are ALREADY fully defined — never search for those. This ALSO searches the documentation for THIS server and returns any matching sections as `doc_matches` — use it for \"how does X work\" / \"where do I set X up\" questions, which nothing in your own knowledge can answer about this product — but still search it by KEYWORDS (\"connection enrol\", \"pack version pin\"), not by typing the question in. If a search returns no match at all, do NOT retry with reworded queries: satisfy the request with the core tools, or tell the user that no matching recipe or action is installed and the documentation does not cover it.",
  arg_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Short natural-language description of the capability you need (e.g. "draft a follow-up email", "summarize a PDF").',
      },
      limit: {
        type: 'number',
        description: 'Optional: bound the number of tools returned. Default: all matches.',
      },
    },
    required: ['query'],
  },
  topic_tags: ['tool', 'recipe', 'catalog', 'capability', 'find', 'lookup'],
  classification: 'read',
  concurrency_safe: true,
};

// The matches-guidance rides on every non-empty tools.search result — the copy
// the model reads at the exact moment it decides to dispatch or narrate. The
// discovery bench (2026-07-03, second iteration) caught the model searching,
// finding the recipe, then ANSWERING IN PROSE instead of dispatching it (81
// p2/p4). So this nails the follow-through: emit the call NOW, do not describe
// the found recipe to the user instead.
const TOOLS_SEARCH_MATCHES_GUIDANCE =
  'These are invocable tool definitions. Call the one you need NOW by its `recipe_slug` with args matching its `args_schema` — EMIT that tool call; do not describe or summarize the recipe to the user instead of running it. You already have everything required; do not search again for it.';
/** No recipe does it, but the manual explains it. Deliberately does NOT repeat
 *  the "answer from your own knowledge" clause: the model has no prior
 *  knowledge of this product, so improvising here is how a plausible, wrong set
 *  of menu steps gets stated with confidence. */
const TOOLS_SEARCH_DOCS_ONLY_GUIDANCE =
  'No installed recipe tool or action matches this request, but the documentation below '
  + 'covers it. Answer from those sections and cite the `url`. Do NOT retry '
  + 'tools.search with reworded queries, and do NOT describe menus, settings or '
  + 'steps that the sections do not actually mention.';

const TOOLS_SEARCH_NO_MATCH_GUIDANCE =
  'No installed recipe tool or action matches this request. Do NOT retry tools.search with reworded queries. Handle it with the core tools already listed, answer the user from your own knowledge, or tell the user that no matching recipe or action is installed.';

const resolveToolsSearchLimit = (raw: unknown): number => {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return Number.POSITIVE_INFINITY;
  const n = Math.floor(raw);
  return n <= 0 ? Number.POSITIVE_INFINITY : n;
};

const asObject = (raw: unknown): Record<string, unknown> | null => {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
};

export interface ToolsSearchWrapOptions {
  /** True in index mode. False → the wrapper returns `inner` untouched, so
   *  tools.search is absent everywhere and resolves `unknown_tool`. */
  enabled: boolean;
  /** D-247 D9 — Tier-2 reachability for the turn's source. */
  tier2GrantFilter?: (source?: ExecutionSource) => (toolName: string) => boolean;
  /** D-247 D9 — see `createChatOwnerCatalogGuard`. Refuses rather than filters:
   *  `tools.search` reads the owner's registry, and a door reaching it is a
   *  routing error. */
  ownerCatalogGuard?: (source?: ExecutionSource) => void;
  /** D-247 D8 — the owner's unfiltered-then-granted Tier-2 set. */
  tier2OwnerCatalog?: (source?: ExecutionSource) => ReadonlyArray<ToolEntry> | null;
  /** The turn's granted raw pack actions (`recued_op_*`) — the SAME source the
   *  main catalog presents and the dispatch resolves by name. See
   *  `dispatchToolsSearch` for why search must read it. */
  rawOpSource?: (source?: ExecutionSource) => ReadonlyArray<ToolEntry>;
}

/** Dispatch the search over the registry's OWN exposed Tier-2 set (so the
 *  corpus is identical to the main-turn projection — same exposure filter,
 *  same grant). Returns full entries (with `args_schema`).
 *
 *  Anti-loop (substrate-support): a no-match still returns `ok: true` — an
 *  `ok: false` reads to a weak model as a failure it retries. Only a
 *  structurally malformed call (missing `query`) is `invalid_args`; that is
 *  a correction signal, not a retry-loop trigger. */
const dispatchToolsSearch = (
  inner: InternalToolRegistry,
  /** D-247 D9 — Tier-2 reachability for this turn's source. ⛔ `tools.search`
   *  RETURNS Tier-2 matches straight to the model, so it is an EXPOSURE surface
   *  in its own right: filtering only the main catalog would leave a revoked
   *  recipe one search away. Absent ⇒ unfiltered (partial harnesses). */
  tier2GrantFilter?: (source?: ExecutionSource) => (toolName: string) => boolean,
  /** D-247 D8 — the owner's Tier-2 set projected WITHOUT the `chat_exposed`
   *  filter. Search is an exposure surface in its own right, so a hidden recipe
   *  the owner granted has to be findable here too — otherwise the grant works in
   *  the catalog and silently does not in search. */
  tier2OwnerCatalog?: (source?: ExecutionSource) => ReadonlyArray<ToolEntry> | null,
  /** D-247 D9 — refuse a non-owner-governed source outright. `tools.search`
   *  reads the OWNER's registry, and `tier2GrantFilter` returns `() => true`
   *  for a door by design, so the filter below cannot narrow one. */
  ownerCatalogGuard?: (source?: ExecutionSource) => void,
  /** ⛔ A raw pack action is Tier 2, so lean-core drops it from the listing
   *  like any recipe — but it is not a REGISTRY entry, so the recipe corpus
   *  above never held it either. Granted, dispatchable by name, and findable
   *  nowhere: live, "take a snapshot of the camera" searched three times and
   *  concluded no installed tool could. The contract granted it; lean-core is a
   *  presentation choice and must not withdraw the grant. Already grant-filtered
   *  per source, so search widens nothing the dispatch would refuse. */
  rawOpSource?: (source?: ExecutionSource) => ReadonlyArray<ToolEntry>,
): ((raw: unknown, ctx: ChatDispatchContext) => Promise<ChatDispatchResult>) =>
  async (raw, ctx) => {
    // ⛔ FIRST, before the query is even parsed — a door must not learn what a
    // malformed query looks like on a surface it may not read at all.
    ownerCatalogGuard?.(ctx?.execution_source);
    const args = asObject(raw);
    if (!args) {
      return { ok: false, reason: 'invalid_args', detail: 'args must be an object' };
    }
    if (typeof args.query !== 'string' || args.query.trim().length === 0) {
      return {
        ok: false,
        reason: 'invalid_args',
        detail: 'query is required — a short description of the capability you need',
      };
    }
    const limit = resolveToolsSearchLimit(args.limit);
    // D-247 D8 — for an OWNER-governed turn the Tier-2 corpus is REPLACED by
    // the grant-decided projection (which sees hidden recipes, so a grant can
    // widen past `chat_exposed`), mirroring the main-catalog `buildCatalog` in
    // chat-orchestrator.ts. That projection is already grant-decided, so the
    // reachability filter applies only to the registry's own exposed entries.
    // ⚠ The param was accepted and threaded but UNREAD before 2026-08-20 —
    // exactly the failure its own contract names: the grant worked in the
    // catalog and silently did not in search.
    const ownerTier2 = tier2OwnerCatalog?.(ctx?.execution_source) ?? null;
    const tier2 = ownerTier2 ?? inner.listByTier(2);
    // ⚠ `ctx?.` — a handler invoked by a bare harness may pass none, and a
    // throw here would turn a missing fixture into a failed search.
    const reachable = ownerTier2 !== null ? undefined : tier2GrantFilter?.(ctx?.execution_source);
    const visible = reachable === undefined ? tier2 : tier2.filter((entry) => reachable(entry.name));
    const rawOps = rawOpSource?.(ctx?.execution_source) ?? [];
    const matches = searchToolCatalog([...visible, ...rawOps], args.query, limit);
    // ⛔ SEARCHED ALWAYS, RETURNED SECOND. The docs answer "how does this work"
    // where the catalog answers "what can I run", and a question often wants
    // both — but a tool is a thing the model can DO, so it leads. Doc hits are
    // capped hard (`DOC_MATCH_LIMIT`) so they can never crowd the matches that
    // let the turn actually accomplish something.
    const docs = searchDocIndex(args.query);
    return {
      ok: true,
      result: {
        query: args.query,
        match_count: matches.length,
        matches: matches.map((entry) => ({
          recipe_slug: entry.name,
          description: entry.description,
          args_schema: entry.arg_schema,
        })),
        // ⚠ Omitted entirely when empty rather than sent as `[]`. An empty key
        // still costs packet budget on every no-doc search, and an absent one
        // cannot be misread as "the docs say nothing about this".
        ...(docs.length > 0
          ? { doc_matches: docs, doc_guidance: DOC_MATCHES_GUIDANCE }
          : {}),
        guidance:
          matches.length > 0
            ? TOOLS_SEARCH_MATCHES_GUIDANCE
            : docs.length > 0
              // ⛔ NOT the no-match copy. That copy tells the model to fall back
              // on "your own knowledge", which for a private product is the
              // confidently-wrong answer this whole feature exists to prevent —
              // and here it would be saying so while holding the documentation
              // that answers the question.
              ? TOOLS_SEARCH_DOCS_ONLY_GUIDANCE
              : TOOLS_SEARCH_NO_MATCH_GUIDANCE,
      },
    };
  };

/** Insert `entry` immediately after the last Tier-1 entry so a synthetic
 *  chat-only tool sits with the core tools rather than trailing the Tier-2/3
 *  lists. Deterministic (no reordering of existing entries). Exported because
 *  `chat-recall-search-tool.ts` wraps the same registry the same way — it held a
 *  verbatim copy, which is one edit away from two orderings. */
export const insertToolEntryAfterTier1 = (
  base: ReadonlyArray<ToolEntry>,
  entry: ToolEntry,
): ToolEntry[] => {
  let lastTier1 = -1;
  for (let i = 0; i < base.length; i += 1) {
    if (base[i]!.tier === 1) lastTier1 = i;
  }
  return [...base.slice(0, lastTier1 + 1), entry, ...base.slice(lastTier1 + 1)];
};

/** Wrap a chat registry view so `tools.search` surfaces + dispatches ONLY
 *  in index mode. Compose it OUTSIDE the enrichment-topic wrapper (over the
 *  chat registry the orchestrator consumes); the raw registry the MCP wire
 *  + door catalog read is left untouched. */
/** Wire seam — apply the tools.search wrapper for a catalog delivery MODE
 *  rather than a raw boolean, so the mode→`enabled` mapping lives in ONE tested
 *  place instead of an inline `mode === …` expression in the composition wire.
 *  The wrapper's own API stays the mode-agnostic `enabled` boolean; this helper
 *  is the single point that maps a mode through `catalogModeUsesToolsSearch`
 *  (index / lean-core → injected; full → `inner` untouched). Codex test-review
 *  HIGH: an inline gate in the wire was un-unit-testable and could silently
 *  regress to `=== 'index'`, dropping tools.search in lean-core while the system
 *  prompt still told the model to call it. The wire now passes the mode; a
 *  regression has to happen INSIDE this tested helper. */
export const wrapChatRegistryForCatalogMode = (
  inner: InternalToolRegistry,
  mode: ChatCatalogDeliveryMode,
): InternalToolRegistry =>
  wrapRegistryWithToolsSearch(inner, {
    enabled: catalogModeUsesToolsSearch(mode),
  });

/** Per-slot wire seam — enable `tools.search` if ANY of the possible per-source
 *  modes thins. The wrapper is applied ONCE at construction and can't be
 *  per-turn, and per-source modes are read LIVE (a user can flip a source
 *  full→index mid-session), so a boot snapshot of the modes would go stale and
 *  strand a leaned turn with an un-dispatchable tool. Enabling whenever any
 *  source could thin makes `tools.search` DISPATCHABLE on the chat path (a
 *  read-only, chat-only superset); `buildChatMainTurnTools` then drops it from
 *  PRESENTATION on `full` turns so a full turn stays byte-identical. Callers
 *  pass a mode set that includes a thinning mode whenever the feature can thin
 *  any source (see the wire). */
export const wrapChatRegistryForCatalogModes = (
  inner: InternalToolRegistry,
  modes: Iterable<ChatCatalogDeliveryMode>,
  /** D-247 D9 — threaded through to the `tools.search` handler, which is the
   *  second of three Tier-2 exposure surfaces. */
  tier2GrantFilter?: (source?: ExecutionSource) => (toolName: string) => boolean,
  tier2OwnerCatalog?: (source?: ExecutionSource) => ReadonlyArray<ToolEntry> | null,
  /** ⛔ POSITIONAL, AND IT HAS TO BE THREADED HERE. This is the ONLY
   *  constructor of the `tools.search` surface — declaring the option on
   *  `ToolsSearchWrapOptions` and wiring it at the orchestrator reaches
   *  `buildCatalog` only, leaving search unguarded. That is the exact shape
   *  this file already records once: `tier2GrantFilter` was "accepted and
   *  threaded but UNREAD before 2026-08-20 — the grant worked in the catalog
   *  and silently did not in search". */
  ownerCatalogGuard?: (source?: ExecutionSource) => void,
  /** The turn's granted raw pack actions — POSITIONAL for the same reason as
   *  the guard above: this is the only constructor of the search surface. */
  rawOpSource?: (source?: ExecutionSource) => ReadonlyArray<ToolEntry>,
): InternalToolRegistry =>
  wrapRegistryWithToolsSearch(inner, {
    enabled: anyCatalogModeUsesToolsSearch(modes),
    ...(tier2GrantFilter ? { tier2GrantFilter } : {}),
    ...(tier2OwnerCatalog ? { tier2OwnerCatalog } : {}),
    ...(ownerCatalogGuard ? { ownerCatalogGuard } : {}),
    ...(rawOpSource ? { rawOpSource } : {}),
  });

export const wrapRegistryWithToolsSearch = (
  inner: InternalToolRegistry,
  opts: ToolsSearchWrapOptions,
): InternalToolRegistry => {
  if (!opts.enabled) return inner;
  const entry = TOOLS_SEARCH_TOOL_ENTRY;
  const dispatchSearch = dispatchToolsSearch(
    inner, opts.tier2GrantFilter, opts.tier2OwnerCatalog, opts.ownerCatalogGuard, opts.rawOpSource,
  );
  return {
    list: () => insertToolEntryAfterTier1(inner.list(), entry),
    listByTier: (tier: ToolTier) =>
      tier === 1 ? [...inner.listByTier(1), entry] : inner.listByTier(tier),
    getByName: (name: string) =>
      name === TOOLS_SEARCH_TOOL_NAME ? entry : inner.getByName(name),
    dispatch: (name: string, args: unknown, ctx: ChatDispatchContext) =>
      name === TOOLS_SEARCH_TOOL_NAME
        ? dispatchSearch(args, ctx)
        : inner.dispatch(name, args, ctx),
    subscribeRefresh: (callback: () => void) => inner.subscribeRefresh(callback),
  };
};
