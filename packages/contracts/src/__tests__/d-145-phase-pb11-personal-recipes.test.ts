/** D-145 PB11 — Person-Specific Automation contract tests.
 *
 *  Covers PB11.1-PB11.5 against § B.12.
 *
 *  Slices:
 *    - Closed-list discipline (validation issue kinds / topic arg
 *      fields / event skip reasons).
 *    - PersonalRecipeEntry validator coverage — every issue-kind has
 *      a triggering case; happy-path validates clean.
 *    - Duplicate-entry detection across `(recipe_id, normalized topic)`.
 *    - ContactTopicMentionTrigger membership test.
 *    - Topic resolver: closed-list arg-field reads + normalization.
 *    - `eventSkipReason` per closed-list reasons.
 *    - Matcher pure-function correctness.
 *    - Substrate self-check (`assertPersonalRecipeInvariants`). */

import { describe, expect, it } from 'vitest';

import {
  PERSONAL_RECIPE_VALIDATION_ISSUE_KINDS,
  PERSONAL_RECIPE_VALIDATION_ISSUE_KIND_SET,
  PERSONAL_RECIPE_TOPIC_ARG_FIELDS,
  PERSONAL_RECIPE_EVENT_SKIP_REASONS,
  PERSONAL_RECIPE_EVENT_SKIP_REASON_SET,
  PersonalRecipeValidationError,
  assertPersonalRecipeInvariants,
  assertValidPersonalRecipesBlob,
  eventSkipReason,
  isContactTopicMentionTrigger,
  matchesPersonalRecipeEntry,
  normalizeTopic,
  resolveEventTopics,
  validatePersonalRecipeEntry,
  validatePersonalRecipesBlob,
  type ContactTopicMentionTrigger,
  type ExtractionEvent,
  type PersonalRecipeEntry,
  type PersonalRecipeValidationIssue,
} from '../index.js';

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

// ── PB11.1 — Closed-list discipline ─────────────────────────────────

describe('PB11 closed lists', () => {
  it('PERSONAL_RECIPE_VALIDATION_ISSUE_KINDS membership matches set', () => {
    expect(PERSONAL_RECIPE_VALIDATION_ISSUE_KIND_SET.size).toBe(
      PERSONAL_RECIPE_VALIDATION_ISSUE_KINDS.length,
    );
    for (const kind of PERSONAL_RECIPE_VALIDATION_ISSUE_KINDS) {
      expect(PERSONAL_RECIPE_VALIDATION_ISSUE_KIND_SET.has(kind)).toBe(true);
    }
  });

  it('PERSONAL_RECIPE_TOPIC_ARG_FIELDS is non-empty + deduped', () => {
    expect(PERSONAL_RECIPE_TOPIC_ARG_FIELDS.length).toBeGreaterThan(0);
    expect(new Set(PERSONAL_RECIPE_TOPIC_ARG_FIELDS).size).toBe(
      PERSONAL_RECIPE_TOPIC_ARG_FIELDS.length,
    );
  });

  it('PERSONAL_RECIPE_EVENT_SKIP_REASONS membership matches set', () => {
    expect(PERSONAL_RECIPE_EVENT_SKIP_REASON_SET.size).toBe(
      PERSONAL_RECIPE_EVENT_SKIP_REASONS.length,
    );
    for (const reason of PERSONAL_RECIPE_EVENT_SKIP_REASONS) {
      expect(PERSONAL_RECIPE_EVENT_SKIP_REASON_SET.has(reason)).toBe(true);
    }
  });

  it('PERSONAL_RECIPE_TOPIC_ARG_FIELDS pins the closed list verbatim (ratchet)', () => {
    expect([...PERSONAL_RECIPE_TOPIC_ARG_FIELDS]).toEqual([
      'topic_tags',
      'topic',
      'fact_type',
    ]);
  });

  it('PERSONAL_RECIPE_EVENT_SKIP_REASONS pins the closed list (ratchet)', () => {
    expect([...PERSONAL_RECIPE_EVENT_SKIP_REASONS].sort()).toEqual([
      'cascade_event',
      'no_subject_contact',
      'no_topic_surface',
      'resolution_class',
    ]);
  });

  it('PERSONAL_RECIPE_VALIDATION_ISSUE_KINDS pins membership (ratchet)', () => {
    expect([...PERSONAL_RECIPE_VALIDATION_ISSUE_KINDS].sort()).toEqual([
      'created_at_invalid',
      'duplicate_entry',
      'enabled_invalid',
      'recipe_id_invalid',
      'topic_invalid',
    ]);
  });

  it('assertPersonalRecipeInvariants passes for the substrate', () => {
    expect(() => assertPersonalRecipeInvariants()).not.toThrow();
  });
});

// ── PB11.2 — Validator coverage ─────────────────────────────────────

describe('validatePersonalRecipeEntry', () => {
  it('returns empty issues on the happy path', () => {
    expect(validatePersonalRecipeEntry(entry())).toEqual([]);
  });

  it('flags `recipe_id_invalid` on missing string', () => {
    const issues = validatePersonalRecipeEntry({ ...entry(), recipe_id: 42 });
    expect(issues.map((i) => i.kind)).toContain('recipe_id_invalid');
  });

  it('flags `recipe_id_invalid` on empty / whitespace-only string', () => {
    const a = validatePersonalRecipeEntry({ ...entry(), recipe_id: '' });
    const b = validatePersonalRecipeEntry({ ...entry(), recipe_id: '   ' });
    expect(a.map((i) => i.kind)).toContain('recipe_id_invalid');
    expect(b.map((i) => i.kind)).toContain('recipe_id_invalid');
  });

  it('flags `topic_invalid` on empty / whitespace-only string', () => {
    const a = validatePersonalRecipeEntry({ ...entry(), topic: '' });
    const b = validatePersonalRecipeEntry({ ...entry(), topic: '   ' });
    expect(a.map((i) => i.kind)).toContain('topic_invalid');
    expect(b.map((i) => i.kind)).toContain('topic_invalid');
  });

  it('flags `enabled_invalid` on non-boolean', () => {
    const issues = validatePersonalRecipeEntry({ ...entry(), enabled: 'yes' });
    expect(issues.map((i) => i.kind)).toContain('enabled_invalid');
  });

  it('flags `created_at_invalid` on NaN / negative / non-number', () => {
    const a = validatePersonalRecipeEntry({ ...entry(), created_at: Number.NaN });
    const b = validatePersonalRecipeEntry({ ...entry(), created_at: -1 });
    const c = validatePersonalRecipeEntry({ ...entry(), created_at: 'now' });
    for (const issues of [a, b, c]) {
      expect(issues.map((i) => i.kind)).toContain('created_at_invalid');
    }
  });

  it('returns structured issues on null / non-object', () => {
    for (const value of [null, undefined, 42, 'foo', []]) {
      const issues = validatePersonalRecipeEntry(value);
      expect(issues.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('every closed-list issue kind has at least one triggering case (ratchet)', () => {
    // Mirrors the standing-instructions registry-completeness ratchet.
    const triggered = new Set<string>();
    const cases: Array<unknown> = [
      { ...entry(), recipe_id: '' },
      { ...entry(), topic: '' },
      { ...entry(), enabled: 'no' },
      { ...entry(), created_at: -1 },
    ];
    for (const c of cases) {
      for (const i of validatePersonalRecipeEntry(c)) triggered.add(i.kind);
    }
    // duplicate_entry only emits from the blob-level validator.
    const blob: ReadonlyArray<PersonalRecipeEntry> = [entry(), entry()];
    for (const i of validatePersonalRecipesBlob(blob)) triggered.add(i.kind);
    for (const kind of PERSONAL_RECIPE_VALIDATION_ISSUE_KINDS) {
      expect(triggered.has(kind)).toBe(true);
    }
  });

  it('propagates `index` when supplied for blob-position context', () => {
    const issues = validatePersonalRecipeEntry({ ...entry(), recipe_id: '' }, 3);
    const recipeIdIssue = issues.find((i) => i.kind === 'recipe_id_invalid');
    expect(recipeIdIssue?.index).toBe(3);
  });
});

// ── PB11.2b — Blob-level duplicate detection ────────────────────────

describe('validatePersonalRecipesBlob', () => {
  it('accepts a blob with distinct entries', () => {
    const blob: ReadonlyArray<PersonalRecipeEntry> = [
      entry({ recipe_id: 'a', topic: 'travel' }),
      entry({ recipe_id: 'b', topic: 'work' }),
    ];
    expect(validatePersonalRecipesBlob(blob)).toEqual([]);
  });

  it('flags `duplicate_entry` on identical (recipe_id, topic)', () => {
    const blob: ReadonlyArray<PersonalRecipeEntry> = [entry(), entry()];
    const issues = validatePersonalRecipesBlob(blob);
    expect(issues.map((i) => i.kind)).toContain('duplicate_entry');
    expect(issues.find((i) => i.kind === 'duplicate_entry')?.index).toBe(1);
  });

  it('flags `duplicate_entry` ignoring case + whitespace in topic', () => {
    const blob: ReadonlyArray<PersonalRecipeEntry> = [
      entry({ topic: 'Travel' }),
      entry({ topic: '  TRAVEL ' }),
    ];
    const issues = validatePersonalRecipesBlob(blob);
    expect(issues.map((i) => i.kind)).toContain('duplicate_entry');
  });

  it('does NOT raise duplicate_entry against entries with their own structural issues', () => {
    // An entry that fails recipe_id validation must not also trigger a
    // duplicate_entry against a sibling — that would mask the real cause.
    const blob = [
      { ...entry(), recipe_id: '' },
      entry(),
    ] as unknown as ReadonlyArray<PersonalRecipeEntry>;
    const issues = validatePersonalRecipesBlob(blob);
    expect(issues.some((i: PersonalRecipeValidationIssue) => i.kind === 'duplicate_entry'))
      .toBe(false);
  });

  it('assertValidPersonalRecipesBlob throws PersonalRecipeValidationError', () => {
    const blob: ReadonlyArray<PersonalRecipeEntry> = [entry(), entry()];
    expect(() => assertValidPersonalRecipesBlob(blob)).toThrowError(
      PersonalRecipeValidationError,
    );
  });

  it('assertValidPersonalRecipesBlob preserves issues on the thrown error', () => {
    const blob: ReadonlyArray<PersonalRecipeEntry> = [entry(), entry()];
    try {
      assertValidPersonalRecipesBlob(blob);
      throw new Error('expected throw');
    } catch (e) {
      if (e instanceof PersonalRecipeValidationError) {
        expect(e.issues.map((i) => i.kind)).toContain('duplicate_entry');
      } else {
        throw e;
      }
    }
  });
});

// ── PB11.3 — Trigger registration ───────────────────────────────────

describe('ContactTopicMentionTrigger', () => {
  it('isContactTopicMentionTrigger accepts a valid payload', () => {
    const t: ContactTopicMentionTrigger = {
      kind: 'contact_topic_mention',
      contact_id: 'mary-id',
      topic: 'travel',
    };
    expect(isContactTopicMentionTrigger(t)).toBe(true);
  });

  it('isContactTopicMentionTrigger rejects wrong kind', () => {
    expect(
      isContactTopicMentionTrigger({
        kind: 'warehouse-event',
        contact_id: 'mary-id',
        topic: 'travel',
      }),
    ).toBe(false);
  });

  it('isContactTopicMentionTrigger rejects missing fields', () => {
    expect(isContactTopicMentionTrigger({ kind: 'contact_topic_mention' })).toBe(false);
    expect(
      isContactTopicMentionTrigger({
        kind: 'contact_topic_mention',
        contact_id: 'mary',
      }),
    ).toBe(false);
  });

  it('isContactTopicMentionTrigger rejects empty / whitespace fields', () => {
    expect(
      isContactTopicMentionTrigger({
        kind: 'contact_topic_mention',
        contact_id: '',
        topic: 'travel',
      }),
    ).toBe(false);
    expect(
      isContactTopicMentionTrigger({
        kind: 'contact_topic_mention',
        contact_id: 'mary',
        topic: '   ',
      }),
    ).toBe(false);
  });

  it('isContactTopicMentionTrigger rejects null / non-object', () => {
    expect(isContactTopicMentionTrigger(null)).toBe(false);
    expect(isContactTopicMentionTrigger(undefined)).toBe(false);
    expect(isContactTopicMentionTrigger('contact_topic_mention')).toBe(false);
    expect(isContactTopicMentionTrigger([])).toBe(false);
  });
});

// ── PB11.4 — Topic resolver ─────────────────────────────────────────

describe('resolveEventTopics', () => {
  it('returns lower-cased trimmed string from args.topic', () => {
    const e = extractionEvent({ args: { topic: '  Travel ' } });
    expect([...resolveEventTopics(e)]).toEqual(['travel']);
  });

  it('returns lower-cased entries from args.topic_tags[]', () => {
    const e = extractionEvent({
      args: { topic_tags: ['Travel', 'WORK', '  family  '] },
    });
    expect([...resolveEventTopics(e)].sort()).toEqual([
      'family',
      'travel',
      'work',
    ]);
  });

  it('returns lower-cased value from args.fact_type', () => {
    const e = extractionEvent({ args: { fact_type: 'TRAVEL_EVENT' } });
    expect([...resolveEventTopics(e)]).toEqual(['travel_event']);
  });

  it('unions across topic / topic_tags / fact_type', () => {
    const e = extractionEvent({
      args: {
        topic: 'plan',
        topic_tags: ['travel'],
        fact_type: 'commitment',
      },
    });
    expect([...resolveEventTopics(e)].sort()).toEqual([
      'commitment',
      'plan',
      'travel',
    ]);
  });

  it('returns empty set when no topic surface present', () => {
    const e = extractionEvent({ args: { summary: 'hello' } });
    expect(resolveEventTopics(e).size).toBe(0);
  });

  it('silently skips non-string entries in topic_tags[]', () => {
    const e = extractionEvent({
      args: { topic_tags: ['travel', 42, null, 'work'] },
    });
    expect([...resolveEventTopics(e)].sort()).toEqual(['travel', 'work']);
  });

  it('silently skips whitespace-only entries', () => {
    const e = extractionEvent({
      args: { topic: '   ', topic_tags: ['', '  ', 'work'] },
    });
    expect([...resolveEventTopics(e)]).toEqual(['work']);
  });

  it('normalizeTopic is the substrate normalization rule', () => {
    expect(normalizeTopic('  Travel ')).toBe('travel');
    expect(normalizeTopic('WORK')).toBe('work');
  });
});

// ── PB11.4b — eventSkipReason classification ────────────────────────

describe('eventSkipReason', () => {
  it('returns `no_subject_contact` when subject_contact_id is missing', () => {
    const e = extractionEvent();
    delete (e as { subject_contact_id?: string }).subject_contact_id;
    expect(eventSkipReason(e)).toBe('no_subject_contact');
  });

  it('returns `no_subject_contact` when subject_contact_id is whitespace', () => {
    const e = extractionEvent({ subject_contact_id: '   ' });
    expect(eventSkipReason(e)).toBe('no_subject_contact');
  });

  it('returns `resolution_class` for resolution.* events (NEVER fires)', () => {
    const e = extractionEvent({ kind: 'resolution.alias' });
    expect(eventSkipReason(e)).toBe('resolution_class');
  });

  it('returns `no_topic_surface` when args has no topic indicators', () => {
    const e = extractionEvent({ args: { summary: 'foo' } });
    expect(eventSkipReason(e)).toBe('no_topic_surface');
  });

  it('returns null on the happy path', () => {
    const e = extractionEvent();
    expect(eventSkipReason(e)).toBeNull();
  });
});

// ── PB11.5 — Matcher pure-function ──────────────────────────────────

describe('matchesPersonalRecipeEntry', () => {
  it('matches when entry.topic is in eventTopics', () => {
    const topics = new Set(['travel']);
    expect(matchesPersonalRecipeEntry(entry(), topics)).toBe(true);
  });

  it('returns false for disabled entries even when topic matches', () => {
    const topics = new Set(['travel']);
    expect(matchesPersonalRecipeEntry(entry({ enabled: false }), topics)).toBe(false);
  });

  it('returns false when entry.topic is not in eventTopics', () => {
    const topics = new Set(['work']);
    expect(matchesPersonalRecipeEntry(entry(), topics)).toBe(false);
  });

  it('returns false when eventTopics is empty', () => {
    expect(matchesPersonalRecipeEntry(entry(), new Set())).toBe(false);
  });

  it('case-insensitive topic match', () => {
    const topics = new Set(['travel']);
    expect(matchesPersonalRecipeEntry(entry({ topic: 'Travel' }), topics)).toBe(true);
    expect(matchesPersonalRecipeEntry(entry({ topic: '  TRAVEL  ' }), topics)).toBe(true);
  });
});

// ── PB11.5b — Codex P1 + P2 folds ───────────────────────────────────

describe('PB11 Codex P1.1 fold — defensive typeof guards', () => {
  it('eventSkipReason returns no_subject_contact on non-string subject_contact_id', () => {
    // Malformed AI output bypassing the validator: subject_contact_id
    // is a number / null / object. The substrate's "never throw on
    // bad input" gate must surface 'no_subject_contact', not crash.
    const cases: Array<unknown> = [42, null, { id: 'mary' }, ['mary']];
    for (const bad of cases) {
      const evt: ExtractionEvent = {
        ...extractionEvent(),
        subject_contact_id: bad as unknown as string,
      };
      expect(() => eventSkipReason(evt)).not.toThrow();
      expect(eventSkipReason(evt)).toBe('no_subject_contact');
    }
  });

  it('resolveEventTopics returns empty set on non-object args', () => {
    // event.args is contract-typed as Record<string, unknown> but a
    // drifting AI provider could emit null / a primitive / an array.
    const cases: Array<unknown> = [null, 'topic', 42, ['travel']];
    for (const bad of cases) {
      const evt: ExtractionEvent = {
        ...extractionEvent(),
        args: bad as unknown as Record<string, unknown>,
      };
      expect(() => resolveEventTopics(evt)).not.toThrow();
      expect(resolveEventTopics(evt).size).toBe(0);
    }
  });
});

describe('PB11 Codex P2.2 fold — JSON.stringify dedupe keys', () => {
  it('pipe-character in recipe_id does not collide with pipe in topic', () => {
    // Pre-fold collision case: `recipe_id='a|b', topic='c'` and
    // `recipe_id='a', topic='b|c'` would build the same pipe-joined
    // key and falsely raise duplicate_entry. The JSON.stringify
    // tuple key keeps them distinct.
    const blob: ReadonlyArray<PersonalRecipeEntry> = [
      entry({ recipe_id: 'a|b', topic: 'c' }),
      entry({ recipe_id: 'a', topic: 'b|c' }),
    ];
    const issues = validatePersonalRecipesBlob(blob);
    expect(issues.some((i) => i.kind === 'duplicate_entry')).toBe(false);
  });

  it('genuine duplicates still raise duplicate_entry', () => {
    const blob: ReadonlyArray<PersonalRecipeEntry> = [
      entry({ recipe_id: 'a|b', topic: 'c' }),
      entry({ recipe_id: 'a|b', topic: 'C' }),
    ];
    const issues = validatePersonalRecipesBlob(blob);
    expect(issues.some((i) => i.kind === 'duplicate_entry')).toBe(true);
  });
});

