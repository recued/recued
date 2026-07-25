/** Step dependency graph for recipes.
 *
 *  The engine executes a recipe in two phases:
 *    - prefetch_steps[]: all dispatched in parallel, any order, race-safe
 *    - steps[]: strict JSON-declaration order, one at a time
 *
 *  Because sequential execution is strictly JSON order, a sequential step
 *  that references a LATER-declared step id will always resolve to `null`
 *  at runtime — the referenced step hasn't run yet. This is a latent bug
 *  that phase-1 reference validation doesn't catch (phase 1 only checks
 *  that the referenced id exists somewhere in the recipe).
 *
 *  This module:
 *    1. Builds a dependency graph from a recipe's step references.
 *    2. Provides a forward-reference finder that the validator uses to
 *       emit `forward_step_ref` errors.
 *    3. Exposes the graph itself for consumers that need to reason about
 *       which steps feed which (engine preflight, Kitchen UI "why is this
 *       step here?", marketplace dependency visualization).
 *
 *  CONTRACT: trusts input like analyzeRecipe. Run validateRecipe first if
 *  correctness matters — malformed steps produce an empty graph entry.
 */

export type StepPhase = 'prefetch' | 'sequential';

export interface StepNode {
  id: string;
  phase: StepPhase;
  /** Declared position within its phase (prefetch array index or steps array index). */
  index: number;
  /** Step ids this step directly references via `{{step.X}}` or `{{step.X.path}}`.
   *  Sorted, unique. References to unknown step ids are dropped (phase-1
   *  `undeclared_step_ref` catches those separately). */
  depends_on: string[];
  /** Reverse edge: step ids that reference this step's output. Sorted, unique. */
  depended_by: string[];
}

export interface StepGraph {
  /** All nodes keyed by step id. */
  nodes: Record<string, StepNode>;
  /** Prefetch ids in declared order (execution is parallel, so order is
   *  presentational only). */
  prefetch_ids: string[];
  /** Sequential ids in declared order — this is the engine's execution order. */
  sequential_order: string[];
}

export interface ForwardRef {
  /** The step making the reference. */
  from: string;
  /** The step being referenced (which will not have run yet). */
  to: string;
  from_index: number;
  to_index: number;
}

/** Step reference pattern. Same shape as validate.ts but narrower — we only
 *  care about the step id (first segment after `step.`). Format hints
 *  (`:currency`, etc.) are stripped. */
const STEP_REF_RE = /\{\{\s*step\.([a-zA-Z_][a-zA-Z0-9_]*)(?:\.[a-zA-Z0-9_.]*)?(?::[a-z]+)?\s*\}\}/g;

const hasNode = (nodes: Record<string, StepNode>, id: string): boolean =>
  Object.prototype.hasOwnProperty.call(nodes, id);

const hasOwn = (obj: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

const own = (obj: Record<string, unknown>, key: string): unknown =>
  hasOwn(obj, key) ? obj[key] : undefined;

const setNode = (
  nodes: Record<string, StepNode>,
  id: string,
  node: StepNode,
): void => {
  Object.defineProperty(nodes, id, {
    value: node,
    enumerable: true,
    configurable: true,
    writable: true,
  });
};

/** Extract unique step ids referenced anywhere in a step's JSON blob.
 *  We serialize the step (minus its own id) and walk with a regex — this
 *  catches refs in any field depth without special-casing each transform. */
const extractStepRefs = (step: Record<string, unknown>): Set<string> => {
  const { id: _id, ...rest } = step;
  const refs = new Set<string>();
  const serialized = JSON.stringify(rest);
  let match: RegExpExecArray | null;
  while ((match = STEP_REF_RE.exec(serialized)) !== null) {
    refs.add(match[1]);
  }
  return refs;
};

const readStepId = (step: unknown): string | null => {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return null;
  const id = own(step as Record<string, unknown>, 'id');
  return typeof id === 'string' && id ? id : null;
};

/** Build the full dependency graph from a recipe.
 *  Deterministic — same input yields identical output. */
export const buildStepGraph = (input: unknown): StepGraph => {
  const empty: StepGraph = { nodes: {}, prefetch_ids: [], sequential_order: [] };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return empty;
  const r = input as Record<string, unknown>;

  const rawPrefetch = own(r, 'prefetch_steps');
  const rawSteps = own(r, 'steps');
  const prefetch = Array.isArray(rawPrefetch)
    ? (rawPrefetch as Array<Record<string, unknown>>)
    : [];
  const steps = Array.isArray(rawSteps)
    ? (rawSteps as Array<Record<string, unknown>>)
    : [];

  // First pass — declare every node with empty edges. We need the full id
  // set before resolving edges so we can ignore refs to unknown ids.
  const nodes: Record<string, StepNode> = {};
  const prefetchIds: string[] = [];
  const sequentialOrder: string[] = [];

  for (let i = 0; i < prefetch.length; i++) {
    const s = prefetch[i];
    const id = readStepId(s);
    if (!id) continue;
    if (hasNode(nodes, id)) continue; // duplicate — phase 1 catches it
    setNode(nodes, id, { id, phase: 'prefetch', index: i, depends_on: [], depended_by: [] });
    prefetchIds.push(id);
  }

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const id = readStepId(s);
    if (!id) continue;
    if (hasNode(nodes, id)) continue;
    setNode(nodes, id, { id, phase: 'sequential', index: i, depends_on: [], depended_by: [] });
    sequentialOrder.push(id);
  }

  // Second pass — walk refs and fill edges. Refs to ids not in the node
  // set are silently dropped (validate.ts reports them via
  // `undeclared_step_ref`; the graph represents the valid subset).
  const fillEdges = (s: Record<string, unknown>): void => {
    const id = readStepId(s);
    if (!id) return;
    const node = nodes[id];
    if (!node) return;
    const refs = extractStepRefs(s);
    const deps: string[] = [];
    for (const ref of refs) {
      if (ref === id) continue; // self-ref — ignore (phase-1 will flag if meaningful)
      if (!hasNode(nodes, ref)) continue;
      deps.push(ref);
    }
    deps.sort();
    node.depends_on = deps;
    for (const dep of deps) {
      const depNode = nodes[dep];
      if (depNode && !depNode.depended_by.includes(id)) {
        depNode.depended_by.push(id);
      }
    }
  };

  for (const s of prefetch) fillEdges(s);
  for (const s of steps) fillEdges(s);

  // Sort depended_by lists for determinism
  for (const id of Object.keys(nodes)) {
    nodes[id].depended_by.sort();
  }

  return { nodes, prefetch_ids: prefetchIds, sequential_order: sequentialOrder };
};

/** Find all forward references in a step graph. A forward reference is an
 *  edge whose target hasn't been computed by the time the source runs.
 *
 *  Engine execution model:
 *    1. All prefetch steps dispatched in parallel, engine waits for all
 *       to settle before starting sequential.
 *    2. Sequential steps run one-at-a-time in JSON-declaration order.
 *
 *  Given that model, edges classify as:
 *    - sequential → sequential, to.index > from.index   → FORWARD (bug)
 *    - sequential → sequential, to.index < from.index   → ok
 *    - sequential → prefetch                            → ok (prefetch done)
 *    - prefetch   → prefetch                            → FORWARD (parallel,
 *                                                         no ordering guarantee)
 *    - prefetch   → sequential                          → FORWARD (sequential
 *                                                         not started)
 *
 *  Prefetch-to-prefetch is a forward ref because prefetch is parallel —
 *  there's no guarantee another prefetch step has finished when this one
 *  reads its output. Prefetch steps must be independent.
 */
export const findForwardReferences = (graph: StepGraph): ForwardRef[] => {
  const forwards: ForwardRef[] = [];

  for (const fromId of Object.keys(graph.nodes)) {
    const from = graph.nodes[fromId];
    for (const toId of from.depends_on) {
      const to = graph.nodes[toId];
      if (!to) continue;

      const isForward =
        // Sequential step referencing a later-declared sequential step
        (from.phase === 'sequential' && to.phase === 'sequential' && to.index > from.index) ||
        // Prefetch referencing another prefetch (parallel, no ordering)
        (from.phase === 'prefetch' && to.phase === 'prefetch') ||
        // Prefetch referencing a sequential step (sequential hasn't started)
        (from.phase === 'prefetch' && to.phase === 'sequential');

      if (isForward) {
        forwards.push({
          from: fromId,
          to: toId,
          from_index: from.index,
          to_index: to.index,
        });
      }
    }
  }

  // Stable ordering — sort by source phase (prefetch first), then source
  // index, then target index, then lexicographically.
  forwards.sort((a, b) => {
    const aFromPhase = graph.nodes[a.from]?.phase ?? 'sequential';
    const bFromPhase = graph.nodes[b.from]?.phase ?? 'sequential';
    if (aFromPhase !== bFromPhase) return aFromPhase === 'prefetch' ? -1 : 1;
    return (
      a.from_index - b.from_index ||
      a.to_index - b.to_index ||
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to)
    );
  });
  return forwards;
};
