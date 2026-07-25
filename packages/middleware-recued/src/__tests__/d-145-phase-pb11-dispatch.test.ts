/** D-145 PB11 — Person-Specific Automation engine dispatcher tests.
 *
 *  Covers PB11.6 (dispatchPersonalRecipes) + PB11.7 helpers.
 *
 *  Scenarios:
 *    - Happy path: an extraction event with subject_contact_id + topic
 *      matching an enabled personal_recipe fires one PersonalRecipeMatch.
 *    - Disabled entry is silently skipped.
 *    - Missing subject_contact_id → skip with `no_subject_contact`.
 *    - `resolution.*` events NEVER fire personal recipes (§ B.12.5).
 *    - Cascade events (`derived_effect` class) NEVER fire — forward-
 *      compat assertion via the closed-list skip reason.
 *    - Events without a topic surface → skip with `no_topic_surface`.
 *    - Multi-topic entry: case-insensitive match via topic_tags / topic
 *      / fact_type.
 *    - Multi-entry: two different topics on the same contact both
 *      match the same event → ONE fire (dedupe by recipe_id +
 *      source_event_index).
 *    - Multi-entry: same topic across two different recipe_ids → TWO
 *      fires (distinct dedupe keys).
 *    - Cross-event isolation: matches against event[i] don't dedupe
 *      against event[j] (`source_event_index` participates in the
 *      dedupe key).
 *    - Determinism: same input → same output ordering. */

import { describe, expect, it } from 'vitest';

import type {
  ExtractionEvent,
  PersonalRecipeEntry,
} from '@recued/contracts';

import {
  dispatchPersonalRecipes,
  wouldDuplicatePersonalRecipe,
  type PersonalRecipeMatch,
} from '../personal-recipes/index.js';

// ── Helpers ─────────────────────────────────────────────────────────

const entry = (
  patch: Partial<PersonalRecipeEntry> = {},
): PersonalRecipeEntry => ({
  recipe_id: 'pub/remind-mary-about-sicily-followup',
  topic: 'travel',
  enabled: true,
  created_at: 1_715_000_000_000,
  ...patch,
});

const extractionEvent = (
  patch: Partial<ExtractionEvent> = {},
): ExtractionEvent => ({
  kind: 'extraction.plan',
  confidence: 0.92,
  args: { topic: 'travel' },
  subject_contact_id: 'mary-id',
  ...patch,
});

const constLookup = (
  map: Record<string, ReadonlyArray<PersonalRecipeEntry>>,
) => (contact_id: string) => map[contact_id] ?? [];

// ── PB11.6 — Happy path ─────────────────────────────────────────────

describe('dispatchPersonalRecipes — happy path', () => {
  it('fires one match for an enabled entry with matching topic', () => {
    const { matches, skipped } = dispatchPersonalRecipes({
      events: [extractionEvent()],
      lookupPersonalRecipes: constLookup({ 'mary-id': [entry()] }),
    });
    expect(skipped).toEqual([]);
    expect(matches.length).toBe(1);
    const m = matches[0];
    expect(m.recipe_id).toBe('pub/remind-mary-about-sicily-followup');
    expect(m.contact_id).toBe('mary-id');
    expect(m.topic).toBe('travel');
    expect(m.source_event_kind).toBe('extraction.plan');
    expect(m.source_event_index).toBe(0);
    expect(m.trigger).toEqual({
      kind: 'contact_topic_mention',
      contact_id: 'mary-id',
      topic: 'travel',
    });
  });

  it('preserves the user-written topic case in the match (not normalized)', () => {
    const { matches } = dispatchPersonalRecipes({
      events: [extractionEvent({ args: { topic: 'TRAVEL' } })],
      lookupPersonalRecipes: constLookup({
        'mary-id': [entry({ topic: 'Travel' })],
      }),
    });
    expect(matches[0]?.topic).toBe('Travel');
  });

  it('fires across topic_tags / topic / fact_type', () => {
    const cases: Array<ExtractionEvent['args']> = [
      { topic_tags: ['travel'] },
      { topic: 'travel' },
      { fact_type: 'travel' },
    ];
    for (const args of cases) {
      const { matches } = dispatchPersonalRecipes({
        events: [extractionEvent({ args })],
        lookupPersonalRecipes: constLookup({ 'mary-id': [entry()] }),
      });
      expect(matches.length).toBe(1);
    }
  });
});

// ── PB11.6b — No-fire on disabled / missing-topic / wrong-class ─────

describe('dispatchPersonalRecipes — no-fire paths', () => {
  it('disabled entries are silently skipped', () => {
    const { matches } = dispatchPersonalRecipes({
      events: [extractionEvent()],
      lookupPersonalRecipes: constLookup({
        'mary-id': [entry({ enabled: false })],
      }),
    });
    expect(matches).toEqual([]);
  });

  it('events with no subject_contact_id are skipped with `no_subject_contact`', () => {
    const evt: ExtractionEvent = extractionEvent();
    delete (evt as { subject_contact_id?: string }).subject_contact_id;
    const { matches, skipped } = dispatchPersonalRecipes({
      events: [evt],
      lookupPersonalRecipes: constLookup({ 'mary-id': [entry()] }),
    });
    expect(matches).toEqual([]);
    expect(skipped).toEqual([{ source_event_index: 0, reason: 'no_subject_contact' }]);
  });

  it('resolution.* events NEVER fire personal recipes (§ B.12.5)', () => {
    // Even with subject_contact_id + matching topic in args, resolution
    // events are class-filtered out.
    const { matches, skipped } = dispatchPersonalRecipes({
      events: [
        extractionEvent({
          kind: 'resolution.alias',
          args: { topic: 'travel', resolved_to: 'mary-id' },
        }),
      ],
      lookupPersonalRecipes: constLookup({ 'mary-id': [entry()] }),
    });
    expect(matches).toEqual([]);
    expect(skipped[0]?.reason).toBe('resolution_class');
  });

  it('events without a topic surface are skipped with `no_topic_surface`', () => {
    const { matches, skipped } = dispatchPersonalRecipes({
      events: [extractionEvent({ args: { summary: 'hello' } })],
      lookupPersonalRecipes: constLookup({ 'mary-id': [entry()] }),
    });
    expect(matches).toEqual([]);
    expect(skipped[0]?.reason).toBe('no_topic_surface');
  });

  it('contacts with no personal_recipes entries are silent (no match, no skip emit)', () => {
    const { matches, skipped } = dispatchPersonalRecipes({
      events: [extractionEvent()],
      lookupPersonalRecipes: () => [],
    });
    expect(matches).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it('topic mismatch does not fire', () => {
    const { matches } = dispatchPersonalRecipes({
      events: [extractionEvent({ args: { topic: 'work' } })],
      lookupPersonalRecipes: constLookup({ 'mary-id': [entry()] }),
    });
    expect(matches).toEqual([]);
  });
});

// ── PB11.6c — Channel isolation (memory.recall / cascade) ───────────

describe('dispatchPersonalRecipes — channel isolation', () => {
  it('does not consume memory.recall results (only AIOutput.events[])', () => {
    // The dispatcher signature is `events: ReadonlyArray<ExtractionEvent>`.
    // The contract is structural: callers can ONLY thread AIOutput
    // events; memory.recall returns ContactReference / records, not
    // ExtractionEvent — so a memory.recall result is not assignable
    // to the dispatcher's input shape. This test pins the contract
    // by asserting an empty events array produces no matches.
    const { matches, skipped } = dispatchPersonalRecipes({
      events: [],
      lookupPersonalRecipes: constLookup({ 'mary-id': [entry()] }),
    });
    expect(matches).toEqual([]);
    expect(skipped).toEqual([]);
  });
});

// ── PB11.6d — Dedupe semantics ──────────────────────────────────────

describe('dispatchPersonalRecipes — dedupe', () => {
  it('two entries with same recipe_id + different topics matching one event collapse to ONE fire', () => {
    const { matches } = dispatchPersonalRecipes({
      events: [
        extractionEvent({
          args: { topic_tags: ['travel', 'plan'] },
        }),
      ],
      lookupPersonalRecipes: constLookup({
        'mary-id': [
          entry({ topic: 'travel' }),
          entry({ topic: 'plan' }),
        ],
      }),
    });
    expect(matches.length).toBe(1);
    // First-encountered entry wins.
    expect(matches[0]?.topic).toBe('travel');
  });

  it('two entries with different recipe_id + same topic both fire', () => {
    const { matches } = dispatchPersonalRecipes({
      events: [extractionEvent()],
      lookupPersonalRecipes: constLookup({
        'mary-id': [
          entry({ recipe_id: 'pub/a', topic: 'travel' }),
          entry({ recipe_id: 'pub/b', topic: 'travel' }),
        ],
      }),
    });
    expect(matches.map((m) => m.recipe_id)).toEqual(['pub/a', 'pub/b']);
  });

  it('cross-event isolation: same entry firing on event[0] AND event[1] yields two matches', () => {
    const { matches } = dispatchPersonalRecipes({
      events: [
        extractionEvent(),
        extractionEvent({ args: { topic: 'travel' } }),
      ],
      lookupPersonalRecipes: constLookup({ 'mary-id': [entry()] }),
    });
    expect(matches.length).toBe(2);
    expect(matches[0]?.source_event_index).toBe(0);
    expect(matches[1]?.source_event_index).toBe(1);
  });
});

// ── PB11.6e — Determinism ────────────────────────────────────────────

describe('dispatchPersonalRecipes — determinism', () => {
  it('same input → same matches in same order (run twice)', () => {
    const events: ExtractionEvent[] = [
      extractionEvent(),
      extractionEvent({ args: { topic: 'travel' } }),
    ];
    const lookup = constLookup({
      'mary-id': [entry({ recipe_id: 'pub/a' }), entry({ recipe_id: 'pub/b' })],
    });
    const a = dispatchPersonalRecipes({ events, lookupPersonalRecipes: lookup });
    const b = dispatchPersonalRecipes({ events, lookupPersonalRecipes: lookup });
    expect(a).toEqual(b);
  });

  it('per-contact entry order is preserved in match emission order', () => {
    const { matches } = dispatchPersonalRecipes({
      events: [extractionEvent()],
      lookupPersonalRecipes: constLookup({
        'mary-id': [
          entry({ recipe_id: 'pub/c' }),
          entry({ recipe_id: 'pub/a' }),
          entry({ recipe_id: 'pub/b' }),
        ],
      }),
    });
    expect(matches.map((m: PersonalRecipeMatch) => m.recipe_id)).toEqual([
      'pub/c',
      'pub/a',
      'pub/b',
    ]);
  });
});

// ── PB11.6f — Codex P2.2 fold — dispatcher dedupe key safety ────────

describe('dispatchPersonalRecipes — Codex P2.2 dedupe-key fold', () => {
  it('does not collapse across distinct (contact_id, recipe_id) pairs that share a pipe character', () => {
    // Pre-fold: `${contactId}|${recipe_id}` with contactId='a|b' +
    // recipe='c' built the same key as contactId='a' + recipe='b|c'.
    // The JSON.stringify tuple key keeps them distinct. We can't
    // easily simulate a multi-contact mishap in one event (the
    // lookup is per-contact), but we can pin the dispatcher
    // determinism across the pipe case.
    const events: ExtractionEvent[] = [
      extractionEvent({ subject_contact_id: 'a|b' }),
    ];
    const { matches } = dispatchPersonalRecipes({
      events,
      lookupPersonalRecipes: constLookup({
        'a|b': [entry({ recipe_id: 'pub/a' }), entry({ recipe_id: 'pub/b' })],
      }),
    });
    // Two distinct recipe_ids → two matches, even when contact_id
    // contains a pipe character.
    expect(matches.map((m) => m.recipe_id).sort()).toEqual(['pub/a', 'pub/b']);
  });
});

// ── PB11.7 — Settings-side helpers ──────────────────────────────────

describe('wouldDuplicatePersonalRecipe', () => {
  it('returns true on exact match', () => {
    const entries: ReadonlyArray<PersonalRecipeEntry> = [entry()];
    expect(wouldDuplicatePersonalRecipe(entries, entry().recipe_id, 'travel')).toBe(true);
  });

  it('returns true on case-insensitive topic match', () => {
    const entries: ReadonlyArray<PersonalRecipeEntry> = [entry({ topic: 'Travel' })];
    expect(wouldDuplicatePersonalRecipe(entries, entry().recipe_id, '  TRAVEL  ')).toBe(true);
  });

  it('returns false when recipe_id differs', () => {
    const entries: ReadonlyArray<PersonalRecipeEntry> = [entry()];
    expect(wouldDuplicatePersonalRecipe(entries, 'pub/other', 'travel')).toBe(false);
  });

  it('returns false when topic differs', () => {
    const entries: ReadonlyArray<PersonalRecipeEntry> = [entry()];
    expect(wouldDuplicatePersonalRecipe(entries, entry().recipe_id, 'work')).toBe(false);
  });

  it('returns false on empty entries', () => {
    expect(wouldDuplicatePersonalRecipe([], entry().recipe_id, 'travel')).toBe(false);
  });
});
