/** D-120 Phase 3 — engine-side link classification helpers.
 *
 *  Two pure functions plus one descriptor type:
 *
 *    - `inferExternalCallHost(manifest)` — derives the host string an
 *      ingredient calls into from its declared HTTP / chat / MCP
 *      shape. Mirrors the `flatten.ts` `deriveExternalCall` heuristic
 *      so flatten-time recipe shape and runtime touch classification
 *      agree on the same hostname for the same ingredient.
 *
 *    - `stepEmitsLinks(desc)` — gate that decides whether the step is
 *      side-effecting enough to record provenance edges. Pure
 *      transforms / guards / `category: 'data'` reads stay silent;
 *      external calls and `category: 'action'` ingredients emit.
 *
 *    - `classifyKind(desc, touch)` — picks the `LinkKind` for a
 *      single (step, touch) pair under the spec's three-way split:
 *      external-call → `execution.action`; cross-collection write →
 *      `execution.derived`; default → `execution.write`.
 *
 *  None of these helpers reach for storage. The engine emits
 *  classified links via `ctx.linkSink`; the caller (server's
 *  execute-handler) writes them out post-run.
 *
 *  Spec: docs/d-120-spec.md.
 */

import type {
  EntityTouch,
  IngredientManifest,
  LinkKind,
} from '@recued/contracts';

/** Per-step inputs to `stepEmitsLinks` and `classifyKind`. Built once
 *  at the start of each ingredient step from the manifest + the
 *  step's first observed `data.<col>.<id>` read.
 *
 *  Transforms and guards never need a descriptor — `stepEmitsLinks`
 *  rejects them on `manifest === undefined`. */
export interface StepTouchDescriptor {
  /** Resolved ingredient slug, including kernel-resolved
   *  `run-ingredient` targets. Empty string when the step couldn't
   *  resolve a slug (kernel forwarding gone wrong) — descriptor is
   *  built but `stepEmitsLinks` returns `false` since manifest will
   *  also be undefined. */
  ingredient_slug: string;
  manifest?: IngredientManifest;
  /** Host derived from manifest input shape. Set when the ingredient
   *  is an external-side-effect call (HTTP, chat, MCP). Drives the
   *  first branch of `classifyKind`. */
  external_call?: string;
  /** First `data.<collection>` segment the step read at resolution
   *  time. Used only for the `execution.derived` cross-collection
   *  branch — the engine compares `touch.collection` against this
   *  to surface "ingredient created an entity in a different
   *  collection." Undefined when the step read no warehouse data. */
  source_collection?: string;
}

/** Derive the host an ingredient calls into from its manifest input
 *  shape. Returns undefined when the manifest doesn't declare a
 *  reachable host (transforms, guards, AI ingredients routed at
 *  runtime, manifests without literal URLs).
 *
 *  Mirrors `packages/recipes/src/flatten.ts:deriveExternalCall` so
 *  flatten-time `external_call` and runtime classifier agree byte-
 *  for-byte for the same ingredient. */
export const inferExternalCallHost = (
  manifest: IngredientManifest | undefined,
): string | undefined => {
  if (!manifest) return undefined;
  const input = manifest.input as Record<string, unknown> | undefined;
  if (!input) return undefined;
  const url = input.url;
  if (typeof url === 'string') {
    const host = parseHost(url);
    if (host) return host;
  }
  // chat.tab is itself the host-of-interest (gemini / chatgpt / …).
  // Surface the literal tab name so cross-channel queries can group
  // calls by chat surface — same shape flatten.ts uses.
  const chat = input.chat as { tab?: string } | undefined;
  if (chat && typeof chat.tab === 'string') return chat.tab;
  // MCP server URLs land in input.mcp.server_url. Recipe-step input
  // (D-112 lock list) cannot override the manifest's choice for
  // these paths, so the manifest-side value is authoritative.
  const mcp = input.mcp as { server_url?: string } | undefined;
  if (mcp && typeof mcp.server_url === 'string') return parseHost(mcp.server_url);
  return undefined;
};

const parseHost = (url: string): string | undefined => {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
};

/** Step-level emit gate. Pure transforms / guards / `category: 'data'`
 *  reads are observational — they don't represent causal edges, so
 *  they emit nothing regardless of which entities they touched. The
 *  three side-effecting shapes that DO emit:
 *
 *    1. Manifest declares an external call (HTTP / chat / MCP).
 *    2. Manifest is `category: 'action'` (write or destructive risk
 *       tier) — the recipe modifies warehouse state.
 *    3. Manifest is `category: 'ai'` and the slug is `ai-prompt` —
 *       custom prompts are an escape hatch with arbitrary side
 *       effects (web search, memory writes via system prompt, …);
 *       they get tracked as `execution.action`. Contracted
 *       `ai-classify` / `ai-score` / etc. are deterministic
 *       analyses — observational, not causal — so they stay silent.
 *
 *  Returning `false` lets `step.touches` be discarded entirely
 *  before the per-touch `shouldLink` filter runs — saves work on
 *  read-heavy recipes. */
export const stepEmitsLinks = (desc: StepTouchDescriptor): boolean => {
  if (desc.external_call) return true;
  const cat = desc.manifest?.category;
  if (cat === 'action') return true;
  if (cat === 'ai' && desc.ingredient_slug === 'ai-prompt') return true;
  return false;
};

/** Classify a single (step, touch) pair into a `LinkKind`.
 *
 *  Three-way decision per spec:
 *    1. External-call ingredient → `execution.action`. The warehouse
 *       has no other trace; the link IS the proof the call happened.
 *    2. Touch is a write into a collection different from the step's
 *       source → `execution.derived`. Captures cross-collection
 *       causality (calendar event from email, deal from contact)
 *       the warehouse can't show on its own. Phase 3 doesn't track
 *       write-touches yet — this branch stays dormant until a
 *       future enrichment surfaces them.
 *    3. Default → `execution.write`. Recipe modified an existing
 *       entity; warehouse already shows the result, the link
 *       answers "why".
 *
 *  Caller is responsible for already having filtered the touch via
 *  `shouldLink` and verified the step is side-effecting via
 *  `stepEmitsLinks`. */
export const classifyKind = (
  desc: StepTouchDescriptor,
  touch: EntityTouch,
): LinkKind => {
  if (desc.external_call) return 'execution.action';
  if (
    touch.access === 'write' &&
    desc.source_collection &&
    touch.collection !== desc.source_collection
  ) {
    return 'execution.derived';
  }
  return 'execution.write';
};
