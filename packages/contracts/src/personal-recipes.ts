/** D-145 PB11 — Person-Specific Automation primitive (contracts).
 *
 *  Per § B.12. A `PersonalRecipeEntry` binds a recipe_id + topic to a
 *  specific contact. When PB6's AIOutput dispatch surfaces an
 *  `ExtractionEvent` carrying `subject_contact_id` for that contact AND
 *  the event's topic surface matches the entry's `topic`, the engine
 *  fires the bound recipe via the `recipe.invoke` primitive (PB3).
 *
 *  Privacy invariants (§ B.12.5):
 *    - Per-pair only — never broadcast cross-cloud (D-097 / D-168);
 *      never serializes through MCP responses (per-pair private
 *      vocabulary).
 *    - Fires only on chat-event extraction — never on `memory.recall`
 *      results or cascade `derived_effect` events. The matcher
 *      structurally restricts to the `'extraction'` event class (the
 *      `'resolution'` events that resolved the contact aren't
 *      themselves fired against).
 *
 *  Storage discipline (§ B.12.1):
 *    - JSON column on the contacts table: `personal_recipes TEXT`,
 *      blob shape `Array<{ recipe_id, topic, enabled, created_at }>`.
 *    - Per-pair only — same per-pair-only invariant as
 *      `standing_instructions` (PB10).
 *
 *  Spec: D-145 § B.12. */

import {
  EXTRACTION_EVENT_KIND_SET,
  classForExtractionEventKind,
  type ExtractionEvent,
  type ExtractionEventKind,
} from './extraction-events.js';

// ── PB11.1 — PersonalRecipeEntry shape ──────────────────────────────

/** § B.12.1 — one row in a contact's `personal_recipes` JSON column.
 *  The entry binds a recipe install to a topic; the matcher (§ B.12.3)
 *  fires the recipe when an extraction event carrying the contact's
 *  id surfaces that topic.
 *
 *  Stable shape — adding a field requires a substrate D-spec change so
 *  the JSON-blob round-trip stays compatible with the validator
 *  (`validatePersonalRecipeEntry`). */
export interface PersonalRecipeEntry {
  /** Installed-recipe slug (`<publisher>/<recipe-id>`). The orchestrator
   *  resolves the slug through the recipe registry at fire time —
   *  uninstalled recipes raise a soft-warn + skip the dispatch (the
   *  entry stays in the blob so the user can re-install the recipe
   *  without losing the binding). */
  readonly recipe_id: string;
  /** Topic the entry watches for. Case-insensitive match against the
   *  per-event topic surfaces (`args.topic_tags[]` / `args.topic` /
   *  `args.fact_type`); the matcher normalizes both sides to lower-case
   *  trimmed strings. Empty / whitespace-only topics are validator-
   *  rejected — the substrate refuses to persist an always-matching
   *  rule. */
  readonly topic: string;
  /** False disables the entry without removing it. Settings UI exposes
   *  the toggle; pack-installed entries respect the user toggle even
   *  when the body is immutable (parallel to Standing Instructions). */
  readonly enabled: boolean;
  /** Unix-ms of the INSERT. Stable across mutations (the store
   *  preserves `created_at` on update). */
  readonly created_at: number;
}

// ── PB11.2 — Closed-list validation issues ──────────────────────────

/** § B.12.1 validation issue kinds. Every membership check the
 *  validator performs has a matching closed-list kind so the
 *  ratchet test pins the surface. */
export const PERSONAL_RECIPE_VALIDATION_ISSUE_KINDS = [
  /** `recipe_id` missing / not a string / empty. */
  'recipe_id_invalid',
  /** `topic` missing / not a string / empty / whitespace-only. */
  'topic_invalid',
  /** `enabled` missing / not boolean. */
  'enabled_invalid',
  /** `created_at` missing / not finite number / negative. */
  'created_at_invalid',
  /** Duplicate `(recipe_id, topic)` pair within the same contact's
   *  blob. The substrate refuses to persist two rows that would always
   *  fire together — the user must remove one before adding the
   *  duplicate. The matcher already dedupes per fire, but the storage
   *  gate keeps the blob legible. */
  'duplicate_entry',
] as const;
export type PersonalRecipeValidationIssueKind =
  (typeof PERSONAL_RECIPE_VALIDATION_ISSUE_KINDS)[number];
export const PERSONAL_RECIPE_VALIDATION_ISSUE_KIND_SET: ReadonlySet<PersonalRecipeValidationIssueKind> =
  new Set(PERSONAL_RECIPE_VALIDATION_ISSUE_KINDS);

export interface PersonalRecipeValidationIssue {
  readonly kind: PersonalRecipeValidationIssueKind;
  /** Per-entry index when validating a blob array (omitted for
   *  duplicate_entry — duplicates report the second-position index). */
  readonly index?: number;
  readonly detail?: string;
}

/** Pure validation of a single entry. Returns a closed-list issue
 *  array (empty = valid). Never throws. */
export const validatePersonalRecipeEntry = (
  entry: unknown,
  index?: number,
): ReadonlyArray<PersonalRecipeValidationIssue> => {
  const issues: PersonalRecipeValidationIssue[] = [];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    issues.push({ kind: 'recipe_id_invalid', ...(index !== undefined ? { index } : {}), detail: String(entry) });
    issues.push({ kind: 'topic_invalid', ...(index !== undefined ? { index } : {}), detail: String(entry) });
    issues.push({ kind: 'enabled_invalid', ...(index !== undefined ? { index } : {}), detail: String(entry) });
    issues.push({ kind: 'created_at_invalid', ...(index !== undefined ? { index } : {}), detail: String(entry) });
    return issues;
  }
  const e = entry as Record<string, unknown>;
  if (typeof e.recipe_id !== 'string' || e.recipe_id.trim() === '') {
    issues.push({ kind: 'recipe_id_invalid', ...(index !== undefined ? { index } : {}), detail: String(e.recipe_id) });
  }
  if (typeof e.topic !== 'string' || e.topic.trim() === '') {
    issues.push({ kind: 'topic_invalid', ...(index !== undefined ? { index } : {}), detail: String(e.topic) });
  }
  if (typeof e.enabled !== 'boolean') {
    issues.push({ kind: 'enabled_invalid', ...(index !== undefined ? { index } : {}), detail: String(e.enabled) });
  }
  if (typeof e.created_at !== 'number' || !Number.isFinite(e.created_at) || e.created_at < 0) {
    issues.push({ kind: 'created_at_invalid', ...(index !== undefined ? { index } : {}), detail: String(e.created_at) });
  }
  return issues;
};

/** Validate a full blob array — every entry + cross-entry duplicate
 *  check. The duplicate key is `(recipe_id, normalized topic)` — two
 *  entries with the same recipe + same topic (case-insensitive)
 *  always fire together and are storage-rejected so the blob stays
 *  legible. */
export const validatePersonalRecipesBlob = (
  blob: ReadonlyArray<unknown>,
): ReadonlyArray<PersonalRecipeValidationIssue> => {
  const issues: PersonalRecipeValidationIssue[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < blob.length; i++) {
    const perEntry = validatePersonalRecipeEntry(blob[i], i);
    for (const issue of perEntry) issues.push(issue);
    // Only check duplicates for entries that passed structural
    // validation — comparing recipe_id / topic on invalid rows would
    // raise spurious duplicate_entry issues that mask the real cause.
    if (perEntry.length === 0) {
      const e = blob[i] as PersonalRecipeEntry;
      // Codex P2 fold (2026-05-10) — use `JSON.stringify` over a
      // two-element tuple as the collision key so a literal pipe (or
      // any other separator) inside `recipe_id` / `topic` can't make
      // two distinct entries falsely collide. A `recipe_id` of
      // `'a|b'` with topic `'c'` and a recipe_id of `'a'` with topic
      // `'b|c'` were ambiguous under the previous pipe-separator key.
      const key = JSON.stringify([e.recipe_id, normalizeTopic(e.topic)]);
      const prior = seen.get(key);
      if (prior !== undefined) {
        issues.push({
          kind: 'duplicate_entry',
          index: i,
          detail: `duplicate (recipe_id='${e.recipe_id}', topic='${normalizeTopic(e.topic)}') of index ${prior}`,
        });
      } else {
        seen.set(key, i);
      }
    }
  }
  return issues;
};

/** Distinguishable error thrown by the storage layer when a blob fails
 *  validation at insert / update time. Carries the closed-list issue
 *  array so callers can surface specific problems. */
export class PersonalRecipeValidationError extends Error {
  readonly code = 'PERSONAL_RECIPE_VALIDATION_ERROR' as const;
  constructor(public readonly issues: ReadonlyArray<PersonalRecipeValidationIssue>) {
    super(
      `personal_recipes blob failed validation: ${issues
        .map((i) => `${i.kind}${i.index !== undefined ? `@${i.index}` : ''}`)
        .join(', ')}`,
    );
    this.name = 'PersonalRecipeValidationError';
  }
}

/** Throwing variant of `validatePersonalRecipesBlob` for storage paths
 *  that prefer hard-fail over soft-issue arrays. */
export const assertValidPersonalRecipesBlob = (blob: ReadonlyArray<unknown>): void => {
  const issues = validatePersonalRecipesBlob(blob);
  if (issues.length > 0) throw new PersonalRecipeValidationError(issues);
};

// ── PB11.3 — ContactTopicMentionTrigger ─────────────────────────────

/** § B.12.2 — closed-list trigger kind a recipe declares when it
 *  wants per-contact + per-topic firing. Distinct from `EventTrigger`
 *  (warehouse-bus pattern).
 *
 *  This is the wire shape recipes carry on `RecipeDefinition.trigger`;
 *  the engine matches it against an extraction event by reading
 *  `subject_contact_id` + the per-event topic surface. */
export interface ContactTopicMentionTrigger {
  readonly kind: 'contact_topic_mention';
  /** Substrate-stable contact identifier (D-145 PA8 `contact_id`). */
  readonly contact_id: string;
  /** Topic label. Same normalization rules as `PersonalRecipeEntry.topic`. */
  readonly topic: string;
}

/** Membership test — used by the recipe validator + the engine
 *  dispatcher to narrow `unknown` trigger payloads. */
export const isContactTopicMentionTrigger = (
  value: unknown,
): value is ContactTopicMentionTrigger => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.kind !== 'contact_topic_mention') return false;
  if (typeof v.contact_id !== 'string' || v.contact_id.trim() === '') return false;
  if (typeof v.topic !== 'string' || v.topic.trim() === '') return false;
  return true;
};

// ── PB11.4 — Topic resolver + matcher (pure functions) ──────────────

/** Normalize a topic string for comparison — trim + lowercase. The
 *  matcher applies this to both sides so case / whitespace variations
 *  don't cause silent misses. */
export const normalizeTopic = (s: string): string => s.trim().toLowerCase();

/** Closed list of `ExtractionEvent.args` field names the resolver
 *  reads to extract per-event topic strings. Adding a field requires
 *  a substrate D-spec change + ratchet entry (§ B.12.3). */
export const PERSONAL_RECIPE_TOPIC_ARG_FIELDS = [
  /** Array of topic tag strings. */
  'topic_tags',
  /** Single topic on per-event surfaces that emit one label. */
  'topic',
  /** § B.12.3 narrative — the AI may emit `fact_type` on
   *  `extraction.*` events; the resolver reads it as a topic. */
  'fact_type',
] as const;
export type PersonalRecipeTopicArgField =
  (typeof PERSONAL_RECIPE_TOPIC_ARG_FIELDS)[number];

/** Extract the set of normalized topic strings from an extraction
 *  event's args. Pure — no IO, no side effects. Reads the closed
 *  list of arg fields (`topic_tags[]` / `topic` / `fact_type`) and
 *  emits the normalized superset.
 *
 *  Non-string / non-array values for the closed fields are silently
 *  ignored (the AI provider may emit a malformed arg; the resolver
 *  refuses to throw — defensive symmetry with PB6's
 *  `validateExtractionEvent`).
 *
 *  Codex P1 fold (2026-05-10) — `event.args` is typed
 *  `Readonly<Record<string, unknown>>`, but an AI provider could
 *  return `null` / non-object that slipped past the validator. The
 *  resolver coerces missing / non-object args to `{}` so reads of
 *  the closed-list fields never throw on bad input. The substrate's
 *  "never throw on bad input" invariant covers AI provider drift. */
export const resolveEventTopics = (event: ExtractionEvent): ReadonlySet<string> => {
  const topics = new Set<string>();
  const rawArgs = event.args as unknown;
  // Defensive — args is contract-typed as a record but malformed AI
  // output could carry `null` / a primitive / an array. The
  // substrate's malformed-input gate treats those as "no topic
  // surface" rather than throwing.
  if (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return topics;
  }
  const args = rawArgs as Record<string, unknown>;
  for (const field of PERSONAL_RECIPE_TOPIC_ARG_FIELDS) {
    const value = args[field];
    if (typeof value === 'string') {
      const t = normalizeTopic(value);
      if (t.length > 0) topics.add(t);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') {
          const t = normalizeTopic(item);
          if (t.length > 0) topics.add(t);
        }
      }
    }
  }
  return topics;
};

/** § B.12.5 — closed-list reasons an event is *structurally
 *  ineligible* to fire personal recipes. Used by the dispatcher to
 *  filter the event stream and (optionally) by the orchestrator's
 *  transparency stream to explain why a fire didn't happen. */
export const PERSONAL_RECIPE_EVENT_SKIP_REASONS = [
  /** Event has no `subject_contact_id` — nothing to look up. */
  'no_subject_contact',
  /** Event class is `'resolution'` — resolution events surface the
   *  contact but the matcher fires only on extraction.* (which carry
   *  the topic). § B.12.3 narrative. */
  'resolution_class',
  /** Event class is `'derived_effect'` — cascade events from a prior
   *  fire never fire personal recipes (§ B.12.5 "no-fire on cascade"
   *  invariant). PB6 has no derived_effect kinds yet; the kind list
   *  widens once cascade events land and this guard becomes active. */
  'cascade_event',
  /** Event args carry no topic surface (topic / topic_tags /
   *  fact_type all absent or non-string). No match is structurally
   *  possible. */
  'no_topic_surface',
] as const;
export type PersonalRecipeEventSkipReason =
  (typeof PERSONAL_RECIPE_EVENT_SKIP_REASONS)[number];
export const PERSONAL_RECIPE_EVENT_SKIP_REASON_SET: ReadonlySet<PersonalRecipeEventSkipReason> =
  new Set(PERSONAL_RECIPE_EVENT_SKIP_REASONS);

/** Returns the reason the event can't fire personal recipes, or
 *  `null` if the event is eligible for per-entry matching. Pure —
 *  the dispatcher reads this once per event before per-entry walks.
 *
 *  Codex P1 fold (2026-05-10) — defensive `typeof` guard on
 *  `subject_contact_id`. The contract types it as `string |
 *  undefined`, but the substrate's malformed-AI-output invariant
 *  means runtime callers may pass a non-string (parsed JSON from a
 *  drifting AI provider). The gate maps any non-string to
 *  `'no_subject_contact'` rather than crashing on `.trim()`. */
export const eventSkipReason = (
  event: ExtractionEvent,
): PersonalRecipeEventSkipReason | null => {
  const contactId = event.subject_contact_id as unknown;
  if (typeof contactId !== 'string') return 'no_subject_contact';
  if (contactId.trim() === '') return 'no_subject_contact';
  const cls = classForExtractionEventKind(event.kind);
  if (cls === 'resolution') return 'resolution_class';
  if (cls === 'derived_effect') return 'cascade_event';
  const topics = resolveEventTopics(event);
  if (topics.size === 0) return 'no_topic_surface';
  return null;
};

/** Match predicate — true iff the entry should fire on the event.
 *  Pure. The caller supplies the pre-resolved topic set so a tight
 *  per-contact loop doesn't recompute the resolver per entry. */
export const matchesPersonalRecipeEntry = (
  entry: PersonalRecipeEntry,
  eventTopics: ReadonlySet<string>,
): boolean => {
  if (!entry.enabled) return false;
  return eventTopics.has(normalizeTopic(entry.topic));
};

// ── PB11.5 — Substrate self-check ───────────────────────────────────

/** Defensive runtime check — every closed-list constant is non-empty
 *  + frozen + unique. The orchestrator calls this at boot; ratchet
 *  asserts on the same invariants.
 *
 *  Length comparisons go through a `number` widening so TS doesn't
 *  narrow the literal-tuple `length` to its compile-time value
 *  (mirrors the pattern in `extraction-events.ts`'s
 *  `assertExtractionEventInvariants`). */
export const assertPersonalRecipeInvariants = (): void => {
  const issueKindLen = PERSONAL_RECIPE_VALIDATION_ISSUE_KINDS.length as number;
  if (issueKindLen === 0) {
    throw new Error('PERSONAL_RECIPE_VALIDATION_ISSUE_KINDS must be non-empty');
  }
  if (PERSONAL_RECIPE_VALIDATION_ISSUE_KIND_SET.size !== issueKindLen) {
    throw new Error('PERSONAL_RECIPE_VALIDATION_ISSUE_KINDS contains duplicates');
  }
  const argFieldLen = PERSONAL_RECIPE_TOPIC_ARG_FIELDS.length as number;
  if (argFieldLen === 0) {
    throw new Error('PERSONAL_RECIPE_TOPIC_ARG_FIELDS must be non-empty');
  }
  const argFieldSet = new Set(PERSONAL_RECIPE_TOPIC_ARG_FIELDS);
  if (argFieldSet.size !== argFieldLen) {
    throw new Error('PERSONAL_RECIPE_TOPIC_ARG_FIELDS contains duplicates');
  }
  const skipReasonLen = PERSONAL_RECIPE_EVENT_SKIP_REASONS.length as number;
  if (skipReasonLen === 0) {
    throw new Error('PERSONAL_RECIPE_EVENT_SKIP_REASONS must be non-empty');
  }
  if (PERSONAL_RECIPE_EVENT_SKIP_REASON_SET.size !== skipReasonLen) {
    throw new Error('PERSONAL_RECIPE_EVENT_SKIP_REASONS contains duplicates');
  }
};

// Re-export `ExtractionEventKind` for callers that route through PB11
// without pulling extraction-events directly (e.g. test harness).
export type { ExtractionEventKind };
export { EXTRACTION_EVENT_KIND_SET };
