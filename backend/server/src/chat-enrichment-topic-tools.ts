/** D-164 — per-topic enrichment entries in the LIVE chat catalog.
 *
 *  Replaces the `enrichment.search` umbrella in the chat-facing
 *  `available_tools` with one entry per warehouse-backed enrichment
 *  topic (`enrichment.deal_health_score`, …), so a topic-named query
 *  routes unambiguously. This wires the designed-but-dead enrichment
 *  section's semantics (`packages/middleware-recued/prompt-cache/src/
 *  catalog/sections/enrichment.ts` + `entity-query.ts` "intentionally
 *  absent" note) into the live projection — evidence: bench task 76
 *  ("deal health" was legitimately torn between `deal.search` and
 *  `enrichment.search`, ~40-50% batch-reliable); the lab's two-section
 *  framing with per-topic ENRICHMENT TOOLS lifted target-topic intent
 *  0% → 67-100% on smoke (internal benchmarks
 *  harness/compose-agent.ts` + HANDOFF §1).
 *
 *  Shape: a wrapper around the chat orchestrator's view of the
 *  `InternalToolRegistry`. CHAT-ONLY — the raw registry instance keeps
 *  serving the MCP surfaces (`mcp-server.ts` via `chatBundle.
 *  internalRegistry`), where the umbrella + its per-token visibility
 *  gates stay exactly as shipped. The wrapper:
 *
 *    - `list()` — drops `enrichment.search` (one-canonical-name rule:
 *      shipping both the umbrella and per-topic entries re-creates the
 *      ambiguity, per the bench v3/v5 alias finding) and appends one
 *      Tier-1-shaped `ToolEntry` per member topic.
 *    - `getByName()` — resolves per-topic names so tier attribution,
 *      the plan-approval gate (read-class → bypass), and
 *      `concurrency_safe` resolution in the tool loop all see a real
 *      entry.
 *    - `dispatch()` — rewrites `enrichment.<topic>` onto the inner
 *      `enrichment.search` Tier-1 handler with `topic` PINNED, so the
 *      guided-empty (missing-topic), unknown-topic-`[]`, and
 *      MCP-private behaviors stay in one place (the handler is
 *      untouched). The umbrella NAME stays dispatchable through the
 *      delegate path — a model that habit-calls `enrichment.search`
 *      gets the calibrated handler, never `unknown_tool`.
 *
 *  Membership = topics that hold ≥1 chain-head warehouse row
 *  (`EnrichmentStore.listTopicsWithRows`) AND effective D-132 trust
 *  state ≠ 'off' AND a registry-closed topic (`isEnrichmentTopic`).
 *  The data-presence gate is a deliberate DIVERGENCE from the designed
 *  assembler's trust-only filter: trust-only surfaces all ~62 registry
 *  topics (+~3k catalog tokens, +60 distractors — the catalog
 *  count-shrink round measured that distractor count itself degrades
 *  routing), while data-presence keeps the catalog a projection of
 *  what the warehouse actually knows (bench seed: exactly 2 topics;
 *  fresh install: none). The design § 4 rule "NO data-availability
 *  filter" concerns per-ENTITY visibility within a topic and is
 *  preserved — a topic with any row is visible for EVERY entity, and a
 *  per-entity miss returns the guided empty result at runtime.
 *  Membership only moves on first-write / total-delete / trust-write
 *  events — rare structural events in the D-164 cacheable-prefix sense
 *  (same class as a recipe install), never per-turn flapping. */

import {
  ENRICHMENT_REGISTRY,
  isEnrichmentTopic,
  TIER1_CLASSIFICATIONS,
  TIER1_CONCURRENCY_SAFE,
  TIER1_TOPIC_TAGS,
  type ChatDispatchContext,
  type ChatDispatchResult,
  type EnrichmentTrustState,
  type InternalToolRegistry,
  type ToolEntry,
  type ToolTier,
} from '@recued/contracts';

/** Chat-catalog name for a per-topic entry. The `enrichment.` prefix is
 *  the lab's bench-validated naming (`enrichmentToolName` in
 *  `enrichment-farm/harness/tool-catalog.ts` — the 0% → 67-100% smoke
 *  result ran on `enrichment.<topic>` names); bare topic ids
 *  (`summary`, `role`, `company`) are collision-prone as flat-catalog
 *  tool names. */
export const ENRICHMENT_TOPIC_TOOL_PREFIX = 'enrichment.';

/** The umbrella Tier-1 name the chat catalog drops (and the dispatch
 *  rewrite targets). */
const ENRICHMENT_UMBRELLA_TOOL = 'enrichment.search';

export const enrichmentTopicToolName = (topic: string): string =>
  `${ENRICHMENT_TOPIC_TOOL_PREFIX}${topic}`;

/** Inverse of `enrichmentTopicToolName` — `null` for anything that is
 *  not a per-topic name (including the umbrella itself and dotted
 *  names whose suffix is not a registry topic, e.g. a Tier-3 MCP
 *  connection that happens to be named `enrichment`). */
export const topicOfEnrichmentToolName = (name: string): string | null => {
  if (!name.startsWith(ENRICHMENT_TOPIC_TOOL_PREFIX)) return null;
  if (name === ENRICHMENT_UMBRELLA_TOOL) return null;
  const topic = name.slice(ENRICHMENT_TOPIC_TOOL_PREFIX.length);
  return isEnrichmentTopic(topic) ? topic : null;
};

/** Membership inputs, late-bound so the wrapper composes before the
 *  stores are built (mirrors `buildChatToolRegistryInputs`'s getter
 *  discipline). A `null`/throwing source resolves to NO per-topic
 *  entries for that turn — the umbrella still leaves the catalog
 *  (one-canonical-name is unconditional), and raw-record searches
 *  remain the fallback surface. */
export interface EnrichmentTopicToolDeps {
  /** Distinct topics with ≥1 chain-head warehouse row, alphabetical
   *  (`EnrichmentStore.listTopicsWithRows`). */
  readonly listTopicsWithRows: () => ReadonlyArray<string> | null;
  /** Effective D-132 trust state for a topic (registry default folded
   *  in — `TrustStore.resolve(topic).trust_state`). `'off'` hides the
   *  topic from the catalog; reads stay umbrella-equivalent (the read
   *  path was never trust-gated). */
  readonly resolveTrustState: (topic: string) => EnrichmentTrustState;
}

/** First sentence of the registry description — the per-entry terse
 *  copy (§ A.13: domain meaning, no spec refs). The registry's
 *  `description` is the single source of truth; topics whose copy is
 *  one long sentence ship it whole rather than truncated mid-clause. */
const firstSentence = (text: string): string => {
  const match = /^[^.]*\./.exec(text);
  return (match ? match[0] : text).trim();
};

/** The bench-validated section framing, carried per-entry since the
 *  live catalog is a flat JSON array with no section headers. "Pre-
 *  computed fact" is the load-bearing discriminator vs the raw-record
 *  `*.search` primitives (`ENRICHMENT_SECTION_DESCRIPTION` in the
 *  designed assembler: "Pre-computed facts (rates, patterns, scores).
 *  If one enrichment answers the question, call it and answer."). */
const topicDescription = (topic: string): string => {
  const entry = (ENRICHMENT_REGISTRY as Record<
    string,
    { description?: string }
  >)[topic];
  const copy = entry?.description ? firstSentence(entry.description) : '';
  return copy.length > 0 ? `Pre-computed fact — ${copy}` : 'Pre-computed fact.';
};

/** Shared per-topic args surface. `topic` is pinned by the dispatch
 *  rewrite, `scope` is deliberately NOT advertised (internal
 *  `connection.api.<vendor>.<entity>` strings the model should not
 *  guess; the handler still accepts one if passed). */
const TOPIC_ARG_SCHEMA = {
  type: 'object',
  properties: {
    target_id: {
      type: 'string',
      description:
        'Entity id the fact is keyed on (e.g. contact email / deal id). Omit to list recent rows.',
    },
    limit: { type: 'number', description: 'Max rows to return.' },
  },
} as const;

/** Project one member topic to a Tier-1-shaped `ToolEntry`. Tier 1 is
 *  the honest taxonomy slot: the entry dispatches through a Tier-1
 *  handler, is read-classified, and is a local warehouse read →
 *  concurrency-safe (all mirrored off the umbrella's closed-list
 *  declarations so the two surfaces can never drift apart). */
const buildTopicEntry = (topic: string): ToolEntry => ({
  name: enrichmentTopicToolName(topic),
  tier: 1,
  description: topicDescription(topic),
  arg_schema: TOPIC_ARG_SCHEMA,
  topic_tags: TIER1_TOPIC_TAGS[ENRICHMENT_UMBRELLA_TOOL],
  classification: TIER1_CLASSIFICATIONS[ENRICHMENT_UMBRELLA_TOOL],
  concurrency_safe: TIER1_CONCURRENCY_SAFE[ENRICHMENT_UMBRELLA_TOOL],
});

/** Resolve the current member topics. Defensive around both sources:
 *  a missing store / read error yields no per-topic entries (pass-
 *  through turn), never a thrown catalog build. Output order is the
 *  store's (alphabetical) — deterministic so the serialized catalog
 *  stays byte-stable between membership events. */
const resolveMemberTopics = (deps: EnrichmentTopicToolDeps): string[] => {
  let topics: ReadonlyArray<string> | null;
  try {
    topics = deps.listTopicsWithRows();
  } catch {
    return [];
  }
  if (!topics) return [];
  const members: string[] = [];
  for (const topic of topics) {
    if (!isEnrichmentTopic(topic)) continue;
    try {
      if (deps.resolveTrustState(topic) === 'off') continue;
    } catch {
      continue;
    }
    members.push(topic);
  }
  return members;
};

/** Merge the pinned topic into the model-supplied args. A non-object
 *  payload (string/array/number) passes through unchanged so the
 *  handler's own `invalid_args` feedback fires; an absent payload
 *  becomes the bare `{ topic }` list-recent call. The pin is LAST so a
 *  stray model-supplied `topic` arg never beats the tool name the
 *  model actually picked. */
const pinTopicArgs = (args: unknown, topic: string): unknown => {
  if (args === undefined || args === null) return { topic };
  if (typeof args !== 'object' || Array.isArray(args)) return args;
  return { ...(args as Record<string, unknown>), topic };
};

/** Wrap the chat orchestrator's registry view with the per-topic
 *  enrichment projection. The inner registry is untouched — MCP
 *  surfaces keep consuming it directly. */
export const wrapRegistryWithEnrichmentTopicTools = (
  inner: InternalToolRegistry,
  deps: EnrichmentTopicToolDeps,
): InternalToolRegistry => {
  const projectTopicEntries = (): ToolEntry[] =>
    resolveMemberTopics(deps).map(buildTopicEntry);

  /** Names parsing as `enrichment.<registry topic>` are a RESERVED
   *  first-party namespace on the chat surface — the synthetic
   *  warehouse-read entry wins on EVERY surface (list / getByName /
   *  dispatch), consistently. Without this, an inner entry colliding on
   *  a per-topic name (a Tier-3 MCP connection the user named
   *  `enrichment` whose server advertises a tool named exactly a
   *  registry topic) would surface in the catalog and drive
   *  tier/approval/concurrency decisions while `dispatch()` silently
   *  performed the warehouse read — and the fail-open alternative
   *  (inner wins at dispatch) would let an external MCP server SQUAT a
   *  warehouse-fact name and intercept those reads (codex review
   *  fold). Hiding the exotic collision is the fail-safe; the remedy
   *  is renaming the MCP connection. */
  const isReservedTopicName = (name: string): boolean =>
    topicOfEnrichmentToolName(name) !== null;

  /** Replace the umbrella IN PLACE with the per-topic entries so the
   *  enrichment surface keeps the umbrella's Tier-1 slot at the front
   *  of the catalog — the designed section order puts enrichment
   *  first (`SectionedCatalog`: "enrichment first (fast track)");
   *  appending after the ~27 Tier-2 recipes weakens salience (codex
   *  review fold). Falls back to appending when the inner list
   *  carries no umbrella. */
  const projectList = (base: ReadonlyArray<ToolEntry>): ToolEntry[] => {
    const topicEntries = projectTopicEntries();
    const out: ToolEntry[] = [];
    let spliced = false;
    for (const entry of base) {
      if (entry.name === ENRICHMENT_UMBRELLA_TOOL) {
        if (!spliced) {
          out.push(...topicEntries);
          spliced = true;
        }
        continue;
      }
      if (isReservedTopicName(entry.name)) continue;
      out.push(entry);
    }
    if (!spliced) out.push(...topicEntries);
    return out;
  };

  const list = (): ReadonlyArray<ToolEntry> => projectList(inner.list());

  const listByTier = (tier: ToolTier): ReadonlyArray<ToolEntry> => {
    if (tier === 1) return projectList(inner.listByTier(1));
    // Reserved-namespace collisions are hidden per-tier too — an entry
    // invisible to dispatch must not surface through the tier view.
    return inner.listByTier(tier).filter((e) => !isReservedTopicName(e.name));
  };

  const getByName = (name: string): ToolEntry | null => {
    // Reserved namespace first — consistent with dispatch(), which
    // rewrites these names unconditionally. Non-member topics resolve
    // too (the read stays umbrella-equivalent; see dispatch note).
    const topic = topicOfEnrichmentToolName(name);
    if (topic !== null) return buildTopicEntry(topic);
    return inner.getByName(name);
  };

  const dispatch = async (
    name: string,
    args: unknown,
    ctx: ChatDispatchContext,
  ): Promise<ChatDispatchResult> => {
    const topic = topicOfEnrichmentToolName(name);
    if (topic === null) return inner.dispatch(name, args, ctx);
    // Membership is deliberately NOT re-checked here: read semantics
    // stay umbrella-equivalent (any registry topic readable), so a
    // model replaying a tool name across a membership change gets the
    // store's graceful `[]`, not `unknown_tool`.
    return inner.dispatch(
      ENRICHMENT_UMBRELLA_TOOL,
      pinTopicArgs(args, topic),
      ctx,
    );
  };

  return {
    list,
    listByTier,
    getByName,
    dispatch,
    subscribeRefresh: (callback) => inner.subscribeRefresh(callback),
  };
};
