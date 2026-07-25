/** D-145 PA9 — `task_duplicate_candidate` enrichment producer.
 *
 *  Per-task cross-Source duplicate detector. Important once "All Sources"
 *  exists (HubSpot task + Salesforce task + Recued built-in task that
 *  all describe the same work — see spec § A.7.6 #5). Walks `data_task`
 *  via the task source-walker (D-145 PA9 second per-record producer on a
 *  work-entity scope, after [[note_relevance_decay]]). For each focal task:
 *
 *    1. Narrow cross-Source candidates via
 *       `findCrossSourceTaskCandidates` (uses `idx_task_assigned_done`
 *       when assigned, hard-LIMIT scan otherwise).
 *    2. For each candidate, run `computeDedupConfidence` to assign a
 *       band: `'exact' | 'probable' | 'low' | null`.
 *    3. Promote to the highest band reached; emit `duplicate_candidate_set`
 *       restricted to that band (`exact` candidates only when band is
 *       exact, etc.) so downstream consumers see a coherent slate.
 *
 *  Why cross-Source only? Spec § A.7.6 #5 framing: duplicate detection is
 *  for "All Sources" merging — within a single Source the source system's
 *  own UNIQUE constraint already prevents duplicate ids, and the source
 *  system's dedup is its own concern. Comparing across sources catches
 *  the "same conceptual work tracked in HubSpot + Salesforce" case.
 *
 *  Why no AI? Deterministic SQL + string comparison is enough for the
 *  three-band model. Heuristics:
 *
 *    - `'exact'` — normalized title equality + due_at within 24h (or both
 *      null) + assigned_contact_id match (or both null). Highest
 *      confidence; engine can auto-merge with user confirmation.
 *    - `'probable'` — normalized title contains-or-contained-by the other
 *      + due_at within 7 days (or both null). User reviews via the
 *      Duplicates queue.
 *    - `'low'` — same parent_project_id + shared 8-char title prefix.
 *      Lowest-signal band; surfaces to the user as "possibly related".
 *    - `null` (no band) — not a candidate; producer skips.
 *
 *  Sample-floor semantics. Declaration carries `sample_floor: 2` — at
 *  least 2 tasks in the warehouse for pair detection to make sense. No
 *  per-task abstention beyond "no candidates found" → null. The natural
 *  abstention path handles the "only 1 task" case (candidate query
 *  returns nothing → null).
 *
 *  Per-task candidate cap. `TASK_DUPLICATE_CANDIDATE_LIMIT = 100` bounds
 *  the per-call comparison budget. Tasks with extremely high assignment
 *  density (e.g., a workspace admin assigned 10K tasks across sources)
 *  would otherwise blow the housekeeping budget. False-negative cost is
 *  bounded — even at 100-cap, the cross-source dedup queue surfaces the
 *  most-likely duplicates for user review.
 *
 *  Cadence + invalidation. Housekeeping 24h (registry). Cascade fires
 *  on `data.task.created` + `data.task.updated` per the declaration's
 *  `invalidation_triggers`. The `aggregates_from = ['task']` registry
 *  entry keeps cascade on the canonical scope.
 *
 *  Spec: D-145 §§ A.7.2 + A.7.3 + A.7.5 + A.7.6 #5 +
 *        `ENRICHMENT_REGISTRY.task_duplicate_candidate` +
 *        `packages/contracts/src/enrichment-declarations/task-duplicate-candidate.ts`. */

import {
  type Task,
  type TaskDedupeConfidence,
  type TaskDuplicateCandidateValue,
} from '@recued/contracts';

import type { HousekeepingContext } from '../registry.js';
import type { SourceRecord } from '../source-walkers.js';
import type { HousekeepingEnrichmentProducer } from '../enrichment-producer.js';
import type { WorkEntityStore } from '../../storage/work-entity-store.js';
import { contactAddresses } from './_contact-addresses.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Per-task hard cap on cross-Source candidates the matcher inspects.
 *  Bounds the per-call comparison budget — at 100 candidates × 1000
 *  source tasks, the producer makes 100K comparisons per full walk,
 *  each O(title_len) substring scan = trivially under the housekeeping
 *  60s budget even on cold disks. Beyond ~100 the marginal recall is
 *  small + the user-facing Duplicates queue overflows anyway. */
export const TASK_DUPLICATE_CANDIDATE_LIMIT = 100;

/** Window inside which two `due_at` timestamps count as "same day" for
 *  the `exact` band — 24h slop covers timezone normalization +
 *  back-dating in cross-source imports. */
export const TASK_DUPLICATE_EXACT_DUE_WINDOW_MS = 86_400_000;

/** Window inside which two `due_at` timestamps count as "close" for
 *  the `probable` band — a week covers most real cross-source dedupes
 *  where one system has the exact deadline and the other rounded to
 *  end-of-week. */
export const TASK_DUPLICATE_PROBABLE_DUE_WINDOW_MS = 7 * 86_400_000;

/** Title prefix length required for the `low` band's same-project +
 *  shared-prefix path. 8 chars catches "Q3 Plan", "Review PR", "Email
 *  client" — short enough that genuinely-similar work matches but long
 *  enough that "the/a/and" stems don't collide. */
export const TASK_DUPLICATE_LOW_PREFIX_LEN = 8;

/** Pure SQL + string comparison — zero token cost, idle-eligible. */
const TOKEN_ESTIMATE_PER_RECORD = 0;

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

/** Normalize a task title for cross-source matching. Lowercase + trim +
 *  collapse internal whitespace. Source systems vary on casing
 *  ("Send Q3 report" vs "Send q3 report") + spacing ("Foo  Bar" vs
 *  "Foo Bar"); the comparison should treat these as identical. */
export const normalizeTaskTitle = (title: string): string => {
  return title.toLowerCase().trim().replace(/\s+/g, ' ');
};

/** Subset of `Task` the matcher reads — exposed for direct unit
 *  testing without round-tripping through the full Task shape. */
export interface DedupeFields {
  title: string;
  due_at: number | null;
  assigned_contact_id: string | null;
  parent_project_id: string | null;
}

const matchesExactDue = (focal: DedupeFields, candidate: DedupeFields): boolean => {
  if (focal.due_at === null && candidate.due_at === null) return true;
  if (focal.due_at === null || candidate.due_at === null) return false;
  return Math.abs(focal.due_at - candidate.due_at) <= TASK_DUPLICATE_EXACT_DUE_WINDOW_MS;
};

const matchesProbableDue = (focal: DedupeFields, candidate: DedupeFields): boolean => {
  // Probable is the user-reviewed band — null due_at on either side is
  // treated as "no time constraint" so a dated task in one Source +
  // an undated mirror in another still surfaces for review. Distinct
  // from exact's stricter both-null-or-both-within-24h discipline.
  if (focal.due_at === null || candidate.due_at === null) return true;
  return Math.abs(focal.due_at - candidate.due_at) <= TASK_DUPLICATE_PROBABLE_DUE_WINDOW_MS;
};

/** `assignee_addresses` — D-205 #3.5. `assigned_contact_id` holds an EMAIL, and
 *  two different addresses can be the same PERSON once their contacts have been
 *  merged. Without this, widening the candidate SQL to the merge group would be
 *  actively unhelpful: the duplicate pair would finally be FOUND and then
 *  demoted out of the `exact` band on a raw string compare — surfacing the row
 *  with the wrong confidence, for the very reason the two records match.
 *
 *  Optional, and absent means today's strict equality: the pure banding function
 *  stays testable without a database, and a caller with no merge graph in scope
 *  is unchanged. */
const matchesAssignee = (
  focal: DedupeFields,
  candidate: DedupeFields,
  assignee_addresses?: readonly string[],
): boolean => {
  if (focal.assigned_contact_id === null && candidate.assigned_contact_id === null) return true;
  if (focal.assigned_contact_id === null || candidate.assigned_contact_id === null) return false;
  if (focal.assigned_contact_id === candidate.assigned_contact_id) return true;
  return (
    assignee_addresses !== undefined
    && assignee_addresses.includes(focal.assigned_contact_id)
    && assignee_addresses.includes(candidate.assigned_contact_id)
  );
};

/** Compute the dedup confidence between focal + candidate. Pure
 *  function — exposed for direct unit testing. The bands cascade:
 *  `exact` → `probable` → `low`; the first that matches wins.
 *  Returns `null` when no band applies (candidate is not a duplicate).
 *
 *  `assignee_addresses` (D-205 #3.5) — every address the focal's assignee
 *  answers to, so two tasks assigned to the same person under different
 *  addresses still band as `exact`. Omit for strict address equality. */
export const computeDedupConfidence = (
  focal: DedupeFields,
  candidate: DedupeFields,
  assignee_addresses?: readonly string[],
): TaskDedupeConfidence | null => {
  const focalNorm = normalizeTaskTitle(focal.title);
  const candidateNorm = normalizeTaskTitle(candidate.title);
  // Empty / whitespace-only titles can't dedup — both sides need
  // signal to compare.
  if (focalNorm === '' || candidateNorm === '') return null;

  // ── exact ───────────────────────────────────────────────────
  if (
    focalNorm === candidateNorm &&
    matchesExactDue(focal, candidate) &&
    matchesAssignee(focal, candidate, assignee_addresses)
  ) {
    return 'exact';
  }

  // ── probable ────────────────────────────────────────────────
  // Title overlap = one normalized title contains the other in full.
  // Covers prefix-extension ("Send report" vs "Send report to client")
  // + decoration ("Q3 review" vs "[URGENT] Q3 review") in either direction.
  const titleOverlap =
    focalNorm === candidateNorm ||
    focalNorm.includes(candidateNorm) ||
    candidateNorm.includes(focalNorm);
  if (titleOverlap && matchesProbableDue(focal, candidate)) {
    return 'probable';
  }

  // ── low ─────────────────────────────────────────────────────
  // Same project + shared title prefix. The project anchor is the
  // load-bearing requirement here — a shared 8-char prefix alone
  // would have too many false positives ("the project ..." vs
  // "the meeting ..."). Project agreement + prefix is acceptable
  // signal for the user-reviewed Duplicates queue.
  if (
    focal.parent_project_id !== null &&
    focal.parent_project_id === candidate.parent_project_id &&
    focalNorm.length >= TASK_DUPLICATE_LOW_PREFIX_LEN &&
    candidateNorm.length >= TASK_DUPLICATE_LOW_PREFIX_LEN &&
    focalNorm.slice(0, TASK_DUPLICATE_LOW_PREFIX_LEN) ===
      candidateNorm.slice(0, TASK_DUPLICATE_LOW_PREFIX_LEN)
  ) {
    return 'low';
  }

  return null;
};

const DEDUPE_BAND_RANK: Record<TaskDedupeConfidence, number> = {
  exact: 3,
  probable: 2,
  low: 1,
};

/** Pick the strongest band reached across a set of (candidate_id, band)
 *  pairs + return the ids that match at that exact band. Exposed for
 *  direct unit testing — the producer threads it through after
 *  `computeDedupConfidence`. Order is preserved within the chosen-band
 *  bucket so the candidate query's `id ASC` ordering carries through
 *  to the emitted set. */
export const selectStrongestBand = (
  candidates: ReadonlyArray<{ id: string; band: TaskDedupeConfidence }>,
): { duplicate_candidate_set: string[]; dedupe_confidence: TaskDedupeConfidence } | null => {
  if (candidates.length === 0) return null;
  let bestBand: TaskDedupeConfidence = 'low';
  let bestRank = 0;
  for (const c of candidates) {
    const rank = DEDUPE_BAND_RANK[c.band];
    if (rank > bestRank) {
      bestRank = rank;
      bestBand = c.band;
    }
  }
  const duplicate_candidate_set = candidates
    .filter((c) => c.band === bestBand)
    .map((c) => c.id);
  return { duplicate_candidate_set, dedupe_confidence: bestBand };
};

// ────────────────────────────────────────────────────────────────
// Cross-source candidate matcher
// ────────────────────────────────────────────────────────────────

/** Match a focal task against the cross-source candidate set returned
 *  by `findCrossSourceTaskCandidates`. Returns the strongest-band
 *  matches + the band reached. Exposed for direct unit testing
 *  without the harness scaffolding.
 *
 *  The `store` argument is the narrow surface `findCrossSourceTaskCandidates`
 *  + nothing else — keeps the unit-test fixtures small. */
export const matchTaskAgainstCrossSourceCandidates = (
  store: Pick<WorkEntityStore, 'findCrossSourceTaskCandidates'>,
  focal: Task,
  assignee_addresses?: readonly string[],
): { duplicate_candidate_set: string[]; dedupe_confidence: TaskDedupeConfidence } | null => {
  // A task without a source_id can't be matched against cross-source
  // candidates by definition (no "other source" to compare to).
  // Should never happen in practice — every row carries source_id —
  // but defensive.
  if (!focal.source_id) return null;

  const candidates = store.findCrossSourceTaskCandidates({
    exclude_source_id: focal.source_id,
    exclude_task_id: focal.id,
    assigned_contact_id: focal.assigned_contact_id ?? null,
    limit: TASK_DUPLICATE_CANDIDATE_LIMIT,
  });

  const focalFields: DedupeFields = {
    title: focal.title,
    due_at: focal.due_at ?? null,
    assigned_contact_id: focal.assigned_contact_id ?? null,
    parent_project_id: focal.parent_project_id ?? null,
  };

  const ranked: Array<{ id: string; band: TaskDedupeConfidence }> = [];
  for (const candidate of candidates) {
    const candidateFields: DedupeFields = {
      title: candidate.title,
      due_at: candidate.due_at ?? null,
      assigned_contact_id: candidate.assigned_contact_id ?? null,
      parent_project_id: candidate.parent_project_id ?? null,
    };
    const band = computeDedupConfidence(focalFields, candidateFields, assignee_addresses);
    if (band !== null) {
      ranked.push({ id: candidate.id, band });
    }
  }

  return selectStrongestBand(ranked);
};

// ────────────────────────────────────────────────────────────────
// Producer
// ────────────────────────────────────────────────────────────────

export const taskDuplicateCandidateProducer: HousekeepingEnrichmentProducer<Task> = {
  topic: 'task_duplicate_candidate',
  source_scope: 'task',
  scope_read_declaration: [
    {
      collection: 'data.task',
      sample_field_paths: [
        'title',
        'due_at',
        'assigned_contact_id',
        'parent_project_id',
        'source_id',
      ],
    },
  ],
  estimate_per_record_tokens: () => TOKEN_ESTIMATE_PER_RECORD,
  recompute_cadence: '24h',

  async produce(ctx: HousekeepingContext, source_record: SourceRecord<Task>) {
    const focal = source_record.data;
    if (!focal.id) return null;

    const store = ctx.workEntityStore;
    if (!store) {
      // No store wired = nothing to compare against. Stay silent
      // rather than throw — harness tests without a work-entity
      // store should not trip the producer. Production always wires it.
      return null;
    }

    // D-205 #3.5 — every address the assignee answers to, so a duplicate pair
    // split across a since-merged identity still bands as `exact`. Unassigned
    // focal → no address set to build (the store takes the unassigned path).
    const assigneeAddresses = focal.assigned_contact_id
      ? contactAddresses(ctx, focal.assigned_contact_id)
      : undefined;
    const result = matchTaskAgainstCrossSourceCandidates(store, focal, assigneeAddresses);
    if (result === null) return null;

    const value: TaskDuplicateCandidateValue = {
      duplicate_candidate_set: result.duplicate_candidate_set,
      dedupe_confidence: result.dedupe_confidence,
      computed_at: ctx.now(),
    };
    return { value };
  },
};
