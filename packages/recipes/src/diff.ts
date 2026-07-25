/** Structured recipe diffing.
 *
 *  `diffRecipes(before, after)` produces a change list the Kitchen fork UI
 *  and Marketplace version-compare view can render. Consumers:
 *    - Kitchen: "here's what changed in your fork relative to upstream"
 *    - Kitchen: "here's what upstream changed since you forked"
 *    - Marketplace: version history display
 *    - Audit log: track what a published update altered
 *
 *  Design:
 *    - Steps are identified by id, not position. A moved-but-unchanged
 *      step is `reordered`, not `modified`. A step with a new id in `after`
 *      is `added`, and an id-only-in-before is `removed`.
 *    - Inside a step, the diff is binary (modified or not). Consumers can
 *      render a before/after JSON view; trying to diff inside a step opens
 *      recursive diffing with no clean stopping point.
 *    - Top-level scalars, metadata, variables, and output are compared
 *      field-by-field with before/after values surfaced.
 *    - Arrays like tags and trigger are compared as single field values —
 *      consumers can do set-diff themselves if they need it.
 *
 *  CONTRACT: pure function. Trusts input. If either side is null/malformed,
 *  it's treated as an empty recipe (so a null `before` yields a diff where
 *  everything is `added`, and vice versa).
 */

import { canonicalJsonString, hashRecipe } from './canonical.js';

export interface FieldChange {
  path: string;
  before: unknown;
  after: unknown;
}

export type StepPhase = 'prefetch' | 'sequential';

export interface StepAddition {
  id: string;
  phase: StepPhase;
  /** Index of the new step in the `after` recipe. */
  index: number;
}

export interface StepRemoval {
  id: string;
  phase: StepPhase;
  /** Index the removed step had in the `before` recipe. */
  index: number;
}

export interface StepModification {
  id: string;
  phase: StepPhase;
  before_index: number;
  after_index: number;
}

export interface StepReorder {
  id: string;
  phase: StepPhase;
  before_index: number;
  after_index: number;
}

export interface VariableModification {
  name: string;
  before: unknown;
  after: unknown;
}

export interface RecipeDiff {
  /** True iff the two recipes are structurally identical (canonical form). */
  equal: boolean;
  hash_before: string;
  hash_after: string;
  top_level: FieldChange[];
  metadata: FieldChange[];
  variables: {
    added: string[];
    removed: string[];
    modified: VariableModification[];
  };
  steps: {
    added: StepAddition[];
    removed: StepRemoval[];
    modified: StepModification[];
    reordered: StepReorder[];
  };
  output: FieldChange[];
}

/** Top-level scalar fields that are diffed one-by-one. `metadata`,
 *  `variables`, `prefetch_steps`, `steps`, and `output` get their own
 *  structured diffs below. */
const TOP_LEVEL_FIELDS = [
  'recipe_id', 'version', 'ttl', 'trigger',
] as const;

/** Metadata fields that are diffed one-by-one. Any other metadata key
 *  still gets caught by the catch-all sweep below. */
const METADATA_FIELDS = [
  'name', 'description', 'author', 'type', 'supported_platforms',
  'tags', 'variant_group', 'fork_of',
] as const;

/** Diff two recipes and return a structured change list. Pure. */
export const diffRecipes = (before: unknown, after: unknown): RecipeDiff => {
  const hashBefore = hashRecipe(before);
  const hashAfter = hashRecipe(after);
  const equal = hashBefore === hashAfter;

  const diff: RecipeDiff = {
    equal,
    hash_before: hashBefore,
    hash_after: hashAfter,
    top_level: [],
    metadata: [],
    variables: { added: [], removed: [], modified: [] },
    steps: { added: [], removed: [], modified: [], reordered: [] },
    output: [],
  };

  if (equal) return diff;

  const b = asObject(before);
  const a = asObject(after);

  diffTopLevel(b, a, diff);
  diffMetadata(b, a, diff);
  diffVariables(b, a, diff);
  diffPhase(b, a, 'prefetch_steps', 'prefetch', diff);
  diffPhase(b, a, 'steps', 'sequential', diff);
  diffOutput(b, a, diff);

  return diff;
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const asObject = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return v as Record<string, unknown>;
};

/** True when two values differ after canonicalization. Handles objects,
 *  arrays, and primitives uniformly. */
const differs = (a: unknown, b: unknown): boolean =>
  canonicalJsonString(a) !== canonicalJsonString(b);

// ────────────────────────────────────────────────────────────────
// Top-level / metadata / variables
// ────────────────────────────────────────────────────────────────

const diffTopLevel = (
  b: Record<string, unknown>,
  a: Record<string, unknown>,
  diff: RecipeDiff,
): void => {
  for (const field of TOP_LEVEL_FIELDS) {
    if (differs(b[field], a[field])) {
      diff.top_level.push({ path: field, before: b[field], after: a[field] });
    }
  }
};

const diffMetadata = (
  b: Record<string, unknown>,
  a: Record<string, unknown>,
  diff: RecipeDiff,
): void => {
  const bMeta = asObject(b.metadata);
  const aMeta = asObject(a.metadata);
  const seen = new Set<string>();

  for (const field of METADATA_FIELDS) {
    seen.add(field);
    if (differs(bMeta[field], aMeta[field])) {
      diff.metadata.push({
        path: `metadata.${field}`,
        before: bMeta[field],
        after: aMeta[field],
      });
    }
  }

  // Catch-all sweep for any metadata key we don't have in the known list.
  // We don't want to silently drop a custom field change.
  const allKeys = new Set([...Object.keys(bMeta), ...Object.keys(aMeta)]);
  for (const key of allKeys) {
    if (seen.has(key)) continue;
    if (differs(bMeta[key], aMeta[key])) {
      diff.metadata.push({
        path: `metadata.${key}`,
        before: bMeta[key],
        after: aMeta[key],
      });
    }
  }

  // Sort by path for deterministic output
  diff.metadata.sort((x, y) => x.path.localeCompare(y.path));
};

const diffVariables = (
  b: Record<string, unknown>,
  a: Record<string, unknown>,
  diff: RecipeDiff,
): void => {
  const bVars = asObject(b.variables);
  const aVars = asObject(a.variables);
  const bKeys = new Set(Object.keys(bVars));
  const aKeys = new Set(Object.keys(aVars));

  const added: string[] = [];
  const removed: string[] = [];
  const modified: VariableModification[] = [];

  for (const key of aKeys) {
    if (!bKeys.has(key)) added.push(key);
    else if (differs(bVars[key], aVars[key])) {
      modified.push({ name: key, before: bVars[key], after: aVars[key] });
    }
  }
  for (const key of bKeys) {
    if (!aKeys.has(key)) removed.push(key);
  }

  diff.variables.added = added.sort();
  diff.variables.removed = removed.sort();
  diff.variables.modified = modified.sort((x, y) => x.name.localeCompare(y.name));
};

// ────────────────────────────────────────────────────────────────
// Step phase diff (prefetch + sequential share this logic)
// ────────────────────────────────────────────────────────────────

interface StepIndex {
  id: string;
  index: number;
  bodyWithoutId: string; // canonical JSON of the step minus its id
}

/** Index an array of steps by id for fast lookup + content comparison. */
const indexSteps = (steps: Array<Record<string, unknown>>): Map<string, StepIndex> => {
  const map = new Map<string, StepIndex>();
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
    const rec = s as Record<string, unknown>;
    const id = rec.id;
    if (typeof id !== 'string' || !id) continue;
    if (map.has(id)) continue; // duplicate — keep first (validator catches it)
    const { id: _id, ...rest } = rec;
    map.set(id, {
      id,
      index: i,
      bodyWithoutId: canonicalJsonString(rest),
    });
  }
  return map;
};

const diffPhase = (
  b: Record<string, unknown>,
  a: Record<string, unknown>,
  key: 'prefetch_steps' | 'steps',
  phase: StepPhase,
  diff: RecipeDiff,
): void => {
  const bArr = Array.isArray(b[key]) ? (b[key] as Array<Record<string, unknown>>) : [];
  const aArr = Array.isArray(a[key]) ? (a[key] as Array<Record<string, unknown>>) : [];
  const bIdx = indexSteps(bArr);
  const aIdx = indexSteps(aArr);

  for (const [id, aStep] of aIdx) {
    const bStep = bIdx.get(id);
    if (!bStep) {
      diff.steps.added.push({ id, phase, index: aStep.index });
      continue;
    }
    const contentChanged = bStep.bodyWithoutId !== aStep.bodyWithoutId;
    const positionChanged = bStep.index !== aStep.index;
    if (contentChanged) {
      // Content change takes precedence over reordering — a modified step
      // that also moved is just "modified" (the UI can show index delta
      // from before_index → after_index).
      diff.steps.modified.push({
        id, phase,
        before_index: bStep.index,
        after_index: aStep.index,
      });
    } else if (positionChanged) {
      diff.steps.reordered.push({
        id, phase,
        before_index: bStep.index,
        after_index: aStep.index,
      });
    }
  }

  for (const [id, bStep] of bIdx) {
    if (!aIdx.has(id)) {
      diff.steps.removed.push({ id, phase, index: bStep.index });
    }
  }

  // Stable sort for deterministic output: by phase then by index then by id
  const sortByIndex = <T extends { index: number; id: string; phase: StepPhase }>(
    arr: T[],
  ): void => {
    arr.sort((x, y) =>
      x.phase.localeCompare(y.phase) ||
      x.index - y.index ||
      x.id.localeCompare(y.id),
    );
  };
  const sortByBeforeIndex = <T extends {
    before_index: number; after_index: number; id: string; phase: StepPhase;
  }>(arr: T[]): void => {
    arr.sort((x, y) =>
      x.phase.localeCompare(y.phase) ||
      x.before_index - y.before_index ||
      x.after_index - y.after_index ||
      x.id.localeCompare(y.id),
    );
  };
  sortByIndex(diff.steps.added);
  sortByIndex(diff.steps.removed);
  sortByBeforeIndex(diff.steps.modified);
  sortByBeforeIndex(diff.steps.reordered);
};

// ────────────────────────────────────────────────────────────────
// Output block diff
// ────────────────────────────────────────────────────────────────

/** Output is a single object with a `sidebar` array. Consumers usually
 *  want to see "did the output block change at all?" at section
 *  granularity. We surface the whole sidebar as one field if it differs —
 *  Kitchen can render the before/after list view. */
const diffOutput = (
  b: Record<string, unknown>,
  a: Record<string, unknown>,
  diff: RecipeDiff,
): void => {
  if (differs(b.output, a.output)) {
    diff.output.push({
      path: 'output',
      before: b.output,
      after: a.output,
    });
  }
};

// ────────────────────────────────────────────────────────────────
// Convenience
// ────────────────────────────────────────────────────────────────

/** Total count of detected changes across all categories. Useful as a
 *  quick boolean/count for change summary displays. */
export const changeCount = (diff: RecipeDiff): number =>
  diff.top_level.length +
  diff.metadata.length +
  diff.variables.added.length +
  diff.variables.removed.length +
  diff.variables.modified.length +
  diff.steps.added.length +
  diff.steps.removed.length +
  diff.steps.modified.length +
  diff.steps.reordered.length +
  diff.output.length;
