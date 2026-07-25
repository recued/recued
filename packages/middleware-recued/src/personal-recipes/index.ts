/** D-145 PB11 — engine wiring for the Person-Specific Automation primitive.
 *
 *  Per § B.12.3. The dispatcher reads PB6's composed `AIOutput.events[]`
 *  + a per-contact `PersonalRecipeEntry[]` lookup closure, and emits
 *  one `PersonalRecipeMatch` per (event, entry) pair that:
 *
 *    1. Carries `subject_contact_id`
 *    2. Has class `'extraction'` (NOT `'resolution'`, NOT `'derived_effect'`)
 *    3. Surfaces at least one topic via `args.topic_tags[]` / `args.topic`
 *       / `args.fact_type`
 *    4. Has at least one enabled entry on the contact matching the
 *       normalized topic
 *
 *  Matches are deduped by `(contact_id, recipe_id, source_event_index)`
 *  — two entries with the same recipe but different topics that both
 *  match a single event collapse to one fire (recipe.invoke runs once
 *  with the first matched topic).
 *
 *  Channel isolation (§ B.12.5): the dispatcher reads ONLY from PB6's
 *  AIOutput events stream. Memory.recall results and cascade events
 *  do not flow through this entry point. Wiring the dispatcher into
 *  any other channel requires a substrate D-spec change.
 *
 *  Spec: `docs/d-145-spec.md` § B.12.3 + § B.12.5. */

import {
  eventSkipReason,
  matchesPersonalRecipeEntry,
  normalizeTopic,
  resolveEventTopics,
  type ContactTopicMentionTrigger,
  type ExtractionEvent,
  type PersonalRecipeEntry,
  type PersonalRecipeEventSkipReason,
} from '@recued/contracts';

// ── PB11.6 — DispatchPersonalRecipes shapes ─────────────────────────

/** One match emitted by `dispatchPersonalRecipes`. The orchestrator
 *  takes each match through `recipe.invoke` with the constructed
 *  `trigger` payload. */
export interface PersonalRecipeMatch {
  /** Recipe slug (`<publisher>/<recipe-id>`) the engine fires. */
  readonly recipe_id: string;
  /** The contact whose `personal_recipes` blob held the matched
   *  entry. */
  readonly contact_id: string;
  /** The matched topic — verbatim as the user wrote it on the
   *  PersonalRecipeEntry (NOT the normalized lowercased form). */
  readonly topic: string;
  /** The wire-shape trigger payload the orchestrator threads through
   *  `recipe.invoke` so the recipe sees `context.event` populated. */
  readonly trigger: ContactTopicMentionTrigger;
  /** The extraction event kind that surfaced the topic. Useful for
   *  audit + transparency stream rendering. */
  readonly source_event_kind: ExtractionEvent['kind'];
  /** Index into the input events[] array. Stable per turn; the
   *  Transparency Stream cross-references back through this. */
  readonly source_event_index: number;
}

/** One non-match emitted by the dispatcher when callers want to
 *  surface a `transparency.skipped_personal_recipe` event (PB7
 *  Transparency Stream). The dispatcher itself doesn't emit — it
 *  returns the structured data so the orchestrator owns rendering. */
export interface PersonalRecipeSkippedEvent {
  /** Index of the event in the source array. */
  readonly source_event_index: number;
  /** Closed-list reason from `eventSkipReason`. */
  readonly reason: PersonalRecipeEventSkipReason;
}

export interface DispatchPersonalRecipesInput {
  /** PB6 AIOutput events array (post-composer ordering). The
   *  dispatcher reads the array in-order so match indexes match the
   *  composed event indexes. */
  readonly events: ReadonlyArray<ExtractionEvent>;
  /** Per-contact lookup closure. Returns `[]` when the contact has no
   *  entries OR the contact_id is unknown — the dispatcher treats both
   *  cases identically. Storage layer's `getPersonalRecipes` satisfies
   *  the contract. */
  readonly lookupPersonalRecipes: (
    contact_id: string,
  ) => ReadonlyArray<PersonalRecipeEntry>;
}

export interface DispatchPersonalRecipesResult {
  /** Matched (event, entry) pairs, deduped by
   *  `(contact_id, recipe_id, source_event_index)`. Emit order matches
   *  the source event order; within one event, entries fire in their
   *  blob-stored order (matching Settings UI list-order semantics). */
  readonly matches: ReadonlyArray<PersonalRecipeMatch>;
  /** Per-event skip reasons for events that were filtered out before
   *  per-entry walks. Caller can surface these via the Transparency
   *  Stream when the user opts into "explain why nothing fired". */
  readonly skipped: ReadonlyArray<PersonalRecipeSkippedEvent>;
}

/** § B.12.3 — pure dispatcher. No IO, no side effects. The caller
 *  threads the lookup closure (storage `getPersonalRecipes`) and gets
 *  back structured matches the orchestrator routes through the
 *  `recipe.invoke` primitive.
 *
 *  Determinism: same input → same matches in the same order. The
 *  dedupe key is `(contact_id, recipe_id, source_event_index)` — two
 *  entries with the same recipe + different topics matching one
 *  event collapse to one match (the first-encountered entry wins). */
export const dispatchPersonalRecipes = (
  input: DispatchPersonalRecipesInput,
): DispatchPersonalRecipesResult => {
  const matches: PersonalRecipeMatch[] = [];
  const skipped: PersonalRecipeSkippedEvent[] = [];
  // Per-event dedupe key tracks (contact_id, recipe_id) so multi-topic
  // matches collapse to one fire. Codex P2 fold (2026-05-10) — use
  // `JSON.stringify` over a two-element tuple so any literal
  // separator character in `contact_id` / `recipe_id` can't collapse
  // two distinct (contact, recipe) pairs into the same bucket.
  for (let index = 0; index < input.events.length; index++) {
    const event = input.events[index];
    const skip = eventSkipReason(event);
    if (skip !== null) {
      skipped.push({ source_event_index: index, reason: skip });
      continue;
    }
    // Defensive — eventSkipReason guarantees subject_contact_id is
    // a non-empty string when null is returned, but TS narrowing
    // doesn't propagate through the helper.
    const contactId = event.subject_contact_id;
    if (contactId === undefined || contactId.trim() === '') {
      // Should never hit per the skip guard above, but staying
      // defensive — the substrate's "never throw on bad input"
      // invariant covers AI provider drift.
      skipped.push({ source_event_index: index, reason: 'no_subject_contact' });
      continue;
    }
    const entries = input.lookupPersonalRecipes(contactId);
    if (entries.length === 0) continue;
    const eventTopics = resolveEventTopics(event);
    const perEventSeen = new Set<string>();
    for (const entry of entries) {
      if (!matchesPersonalRecipeEntry(entry, eventTopics)) continue;
      const dedupeKey = JSON.stringify([contactId, entry.recipe_id]);
      if (perEventSeen.has(dedupeKey)) continue;
      perEventSeen.add(dedupeKey);
      matches.push({
        recipe_id: entry.recipe_id,
        contact_id: contactId,
        topic: entry.topic,
        trigger: {
          kind: 'contact_topic_mention',
          contact_id: contactId,
          topic: entry.topic,
        },
        source_event_kind: event.kind,
        source_event_index: index,
      });
    }
  }
  return { matches, skipped };
};

// ── PB11.7 — Settings-side helpers ──────────────────────────────────

/** Pure predicate: would adding `(recipe_id, topic)` to the contact's
 *  blob produce a duplicate-entry validation issue? The Settings UI
 *  reads this before enabling the "Add" button so the user gets
 *  feedback before the persist round-trip. */
export const wouldDuplicatePersonalRecipe = (
  entries: ReadonlyArray<PersonalRecipeEntry>,
  recipe_id: string,
  topic: string,
): boolean => {
  const normalizedTopic = normalizeTopic(topic);
  return entries.some(
    (e) => e.recipe_id === recipe_id && normalizeTopic(e.topic) === normalizedTopic,
  );
};
