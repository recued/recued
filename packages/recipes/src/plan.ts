/** Recipe execution plan builder.
 *
 *  Takes a (valid) recipe and produces the structure the engine iterates
 *  to run it: prefetch batch (parallel dispatch), sequential order (strict
 *  JSON order), precomputed dependency edges per step, and the canonical
 *  recipe hash for cache keying.
 *
 *  This function is pure COMPOSITION over existing primitives:
 *    - `buildStepGraph` → dependency edges
 *    - `hashRecipe`     → cache key
 *    - local walker     → output.render / legacy output.sidebar source ids
 *
 *  The plan does not duplicate raw step data. Engine consumers look up the
 *  step body via `recipe.prefetch_steps[plan.index]` or
 *  `recipe.steps[plan.index]`. This keeps the plan lean and makes stale-
 *  plan detection straightforward: re-hash the recipe and compare to
 *  `plan.recipe_hash`.
 *
 *  CONTRACT: trusts input. Run validateRecipe first if correctness matters.
 */

import { buildStepGraph, type StepGraph, type StepNode, type StepPhase } from './graph.js';
import { hashRecipe } from './canonical.js';

/** One entry per step in the recipe, enriched with everything the engine
 *  needs to route the step without re-walking the recipe JSON. */
export interface StepPlan {
  id: string;
  phase: StepPhase;
  /** Position within the phase (prefetch array index or steps array index). */
  index: number;
  /** Step ids this step's inputs reference via `{{step.X}}`. Sorted, unique.
   *  For prefetch steps this must always be empty — a non-empty array here
   *  means the recipe has a forward reference the validator should have
   *  caught. The plan builder leaves the data intact so diagnostics can
   *  surface the issue rather than silently dropping it. */
  depends_on: string[];
  /** Step ids whose inputs reference this step's output. Sorted, unique. */
  depended_by: string[];
  /** What kind of work this step performs. `unknown` means the step
   *  doesn't carry any of the three discriminators — validator would have
   *  flagged it, but the plan builder tolerates malformed input. */
  kind: 'ingredient' | 'transform' | 'guard' | 'unknown';
}

export interface ExecutionPlan {
  /** FNV-1a 32-bit hash of the canonical recipe. Use as a cache key and
   *  to detect stale plans (re-hash current recipe; if it differs,
   *  rebuild the plan). */
  recipe_hash: string;
  /** Prefetch steps in declared order. The engine dispatches all of these
   *  in parallel and waits for all to settle before starting sequential. */
  prefetch_batch: StepPlan[];
  /** Sequential steps in declared execution order. The engine runs them
   *  strictly one-at-a-time in this order. */
  sequential_order: StepPlan[];
  /** Step ids whose outputs are consumed by `output.render` sections.
   *  The engine can use this to know which steps' results must be retained
   *  for rendering and which can be released after their last dependent
   *  consumer has finished (intermediate steps). */
  output_sources: string[];
}

const hasOwn = (obj: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

const own = (obj: Record<string, unknown>, key: string): unknown =>
  hasOwn(obj, key) ? obj[key] : undefined;

/** Build an execution plan from a recipe. Pure, synchronous. */
export const planExecution = (input: unknown): ExecutionPlan => {
  const recipe_hash = hashRecipe(input);

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { recipe_hash, prefetch_batch: [], sequential_order: [], output_sources: [] };
  }
  const r = input as Record<string, unknown>;

  const graph = buildStepGraph(r);
  const rawPrefetch = own(r, 'prefetch_steps');
  const rawSteps = own(r, 'steps');
  const prefetch = Array.isArray(rawPrefetch)
    ? (rawPrefetch as Array<Record<string, unknown>>)
    : [];
  const steps = Array.isArray(rawSteps)
    ? (rawSteps as Array<Record<string, unknown>>)
    : [];

  const prefetch_batch = graph.prefetch_ids
    .map((id) => buildStepPlan(id, graph, prefetch))
    .filter((p): p is StepPlan => p !== null);

  const sequential_order = graph.sequential_order
    .map((id) => buildStepPlan(id, graph, steps))
    .filter((p): p is StepPlan => p !== null);

  const output_sources = extractOutputSources(r);

  return { recipe_hash, prefetch_batch, sequential_order, output_sources };
};

/** Look up the node in the graph and combine it with the raw step's
 *  discriminator kind. Returns null if the graph doesn't have the node
 *  (shouldn't happen if input is consistent, but tolerated). */
const buildStepPlan = (
  id: string,
  graph: StepGraph,
  rawSteps: Array<Record<string, unknown>>,
): StepPlan | null => {
  const node: StepNode | undefined = graph.nodes[id];
  if (!node) return null;
  const raw = rawSteps[node.index];
  return {
    id: node.id,
    phase: node.phase,
    index: node.index,
    depends_on: [...node.depends_on],
    depended_by: [...node.depended_by],
    kind: discriminateStep(raw),
  };
};

const discriminateStep = (raw: unknown): StepPlan['kind'] => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'unknown';
  const s = raw as Record<string, unknown>;
  if (hasOwn(s, 'ingredient')) return 'ingredient';
  if (hasOwn(s, 'transform')) return 'transform';
  if (hasOwn(s, 'guard')) return 'guard';
  return 'unknown';
};

/** Extract the step ids that `output.render[].source` references, falling back
 *  to legacy `output.sidebar` when render is absent. The
 *  source is of the form `step.X` or `step.X.path` — we take the first
 *  segment after `step.`. */
const extractOutputSources = (r: Record<string, unknown>): string[] => {
  const output = own(r, 'output');
  if (!output || typeof output !== 'object' || Array.isArray(output)) return [];
  const out = output as Record<string, unknown>;
  const render = own(out, 'render');
  const sidebar = own(out, 'sidebar');
  const sections = Array.isArray(render) ? render : sidebar;
  if (!Array.isArray(sections)) return [];
  const found = new Set<string>();
  for (const section of sections) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) continue;
    const s = section as Record<string, unknown>;
    const source = own(s, 'source');
    if (typeof source !== 'string' || !source) continue;
    const id = parseStepSourceId(source);
    if (id) found.add(id);
  }
  return [...found].sort();
};

/** Extract the step id from "step.X" or "step.X.path" form. */
const parseStepSourceId = (source: string): string | null => {
  const trimmed = source.trim();
  const prefix = 'step.';
  if (!trimmed.startsWith(prefix)) return null;
  const rest = trimmed.slice(prefix.length);
  if (!rest) return null;
  const firstDot = rest.indexOf('.');
  return firstDot === -1 ? rest : rest.slice(0, firstDot);
};

/** True if a plan's recipe_hash matches the current recipe. Use this to
 *  detect when a cached plan has gone stale after the recipe was edited. */
export const isPlanCurrent = (plan: ExecutionPlan, recipe: unknown): boolean =>
  plan.recipe_hash === hashRecipe(recipe);
