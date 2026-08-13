/** RUNG 4's query embedder — the one LLM call in `memory.search`.
 *
 *  `memory.search` is otherwise pure SQL: zero token cost, no provider
 *  dependency, instant. This module is what breaks that, deliberately and
 *  narrowly, so a query sharing NO token with its answer can still find it —
 *  "How do I turn on 2FA?" against an entry saying "two-factor authentication",
 *  which matches at no lexical rung because the words are simply not there.
 *
 *  ⛔ THE CALL IS CONDITIONAL AT THE CALL SITE, NOT HERE. The handler invokes
 *  this only after rungs 1–3 return nothing (~3% of queries on the pilot
 *  corpus). Nothing in this module enforces that; if a future caller reaches
 *  for it eagerly, the zero-cost read is gone and no test will say so.
 *
 *  ⚠ Anthropic publishes no embeddings model, so a pure-Anthropic server has no
 *  embeddings path at all. That is a supported configuration, not a fault: the
 *  factory returns `undefined`, rung 4 stays off, and the handler's empty says
 *  meaning-based recall is unavailable rather than claiming the knowledge is
 *  absent. */

import type { IngredientManifest } from '@recued/contracts';

import type { MemoryEmbedder } from './user-memory-store.js';

/** Inline manifest for the `ai-embed` kernel ingredient. Mirrors the copy in
 *  `housekeeping/producers/embedding.ts` — both exist because the executor
 *  takes a manifest, and neither path loads the marketplace JSON at runtime.
 *  ⚠ Keep the `input` / `output` keys in step with `kernel-manifests.ts`; the
 *  executor reads `llm.data` and returns `{ vector, dimensions, model }`. */
const AI_EMBED_MANIFEST: IngredientManifest = {
  slug: 'ai-embed',
  name: 'AI Embed',
  description: 'Compute an embedding vector for input text.',
  author: 'recued',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  version: 1,
  tags: ['kernel', 'ai', 'embeddings', 'vector'],
  input: { 'llm.data': null, 'llm.dimensions': null },
  output: { vector: 'vector', dimensions: 'dimensions', model: 'model' },
};

/** The embeddings executor as the housekeeping substrate exposes it. Narrowed
 *  to what this module needs so the memory path does not depend on the whole
 *  housekeeping callable bundle. */
export type EmbedExecute = (
  manifest: IngredientManifest,
  input: Record<string, unknown>,
) => Promise<{ vector: number[]; dimensions: number; model: string }>;

/** Cap on the text handed to the provider. Embedding models truncate at their
 *  own context limit anyway; clamping here makes the cost predictable and keeps
 *  a 64 KB CAS body from becoming one enormous call. The head of an entry
 *  carries its topic, which is what a similarity probe needs. */
export const MEMORY_EMBED_MAX_CHARS = 8_000;

/** Wrap an embeddings executor as a `MemoryEmbedder`.
 *
 *  Returns `undefined` when no executor is available, which is the signal the
 *  handler reads to leave rung 4 off — an absent embedder must be a quiet,
 *  declared no-op, never a thrown error on a read path whose whole contract is
 *  that it never errors. */
export const createMemoryEmbedder = (
  embed: EmbedExecute | undefined,
): MemoryEmbedder | undefined => {
  if (embed === undefined) return undefined;
  return async (text: string) => {
    const clamped = text.length > MEMORY_EMBED_MAX_CHARS
      ? text.slice(0, MEMORY_EMBED_MAX_CHARS)
      : text;
    const result = await embed(AI_EMBED_MANIFEST, { 'llm.data': clamped });
    return { vector: result.vector, model: result.model };
  };
};
