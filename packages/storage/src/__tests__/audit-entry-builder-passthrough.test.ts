/** `buildAuditEntry` IS AN ENUMERATING COPIER, AND THAT IS ITS FAILURE MODE.
 *
 *  ⛔⛔ It does not spread the input. Every field is named individually, so a
 *  field the builder does not name simply VANISHES — with no type error, since
 *  `AuditEntryInput` carrying a key the output omits is perfectly legal
 *  TypeScript. The row just comes back without it.
 *
 *  The builder's own comment records that this has happened, and calls
 *  `exchange_ref` "the third time this session a field reached a builder that
 *  does not name it, and the only one that failed SILENTLY". It was fixed and
 *  never pinned: mutation (2026-09-18) shows that deleting that line again —
 *  and the lines for `dish_id`, `backfill` and `degraded` — reddens nothing.
 *
 *  ⇒ This test is about the CLASS, not the four instances. It builds a maximal
 *  input with every optional field populated and asserts each one survives, so
 *  the next field to go missing has somewhere to fail. ⚠ It cannot force a
 *  FUTURE field to be listed here — TypeScript will not demand it for an
 *  optional key — so the header above is the other half of the guard: anyone
 *  adding a field to this builder should add it below.
 *
 *  ⚠ Values are chosen to be individually identifiable and, where it matters,
 *  FALSY-BUT-PRESENT: `budget_ms: 0` is a real budget and a truthiness test
 *  would drop it. */

import { describe, expect, it } from 'vitest';

import { buildAuditEntry } from '../audit.js';
import type { AuditEntryInput } from '../audit.js';

const maximalInput = (): AuditEntryInput => ({
  recipe_id: 'recipe-1',
  recipe_hash: 'hash-1',
  duration_ms: 1_500,
  commit_status: 'succeeded',
  errors: [],
  now: 1_700_000_000_000,
  run_id: 'run-supplied-1',
  config_snapshot: { cfg: 'value' },
  context_snapshot: { ctx: 'value' },
  degraded: ['audit_unwritten'],
  trigger_url: 'https://example.test/hook',
  trigger_source: 'webhook',
  instance_id: 'inst-1',
  budget_ms: 0,
  backfill: { missed_cycles: 3, last_run_at_before: 1_699_000_000_000 },
  process_id: 'proc-1',
  dish_id: 'dish-1',
  exchange_ref: 'exchange-1',
});

describe('buildAuditEntry — no field vanishes in the copier', () => {
  it('⛔⛔ every populated input field reaches the entry', () => {
    const input = maximalInput();
    const entry = buildAuditEntry(input) as unknown as Record<string, unknown>;
    for (const [field, expected] of [
      ['run_id', 'run-supplied-1'],
      ['recipe_id', 'recipe-1'],
      ['recipe_hash', 'hash-1'],
      ['duration_ms', 1_500],
      ['commit_status', 'succeeded'],
      ['trigger_url', 'https://example.test/hook'],
      ['trigger_source', 'webhook'],
      ['instance_id', 'inst-1'],
      // ⛔ ZERO, ON PURPOSE. A truthiness test drops a real budget of 0.
      ['budget_ms', 0],
      ['backfill', { missed_cycles: 3, last_run_at_before: 1_699_000_000_000 }],
      ['process_id', 'proc-1'],
      ['dish_id', 'dish-1'],
      // ⛔ THE NAMED PAST BUG. It vanished once already, silently.
      ['exchange_ref', 'exchange-1'],
    ] as const) {
      expect(entry[field], `${field} did not survive the builder`).toEqual(expected);
    }
    expect(entry.config_snapshot).toEqual({ cfg: 'value' });
    expect(entry.context_snapshot).toEqual({ ctx: 'value' });
    expect(entry.degraded).toEqual(['audit_unwritten']);
    // Derived, not asserted twice: started_at is finished_at MINUS the duration.
    expect(entry.finished_at).toBe(1_700_000_000_000);
    expect(entry.started_at).toBe(1_700_000_000_000 - 1_500);
  });

  it('⛔ the entry shares no mutable structure with its input', () => {
    // The input objects belong to the caller and outlive the call — the engine
    // reuses its snapshot maps across a run. A shared array or object means a
    // later write edits a row that was already recorded.
    const input = maximalInput();
    const entry = buildAuditEntry(input);
    (input.config_snapshot as Record<string, unknown>).cfg = 'mutated';
    (input.context_snapshot as Record<string, unknown>).ctx = 'mutated';
    (input.degraded as string[]).push('provenance_incomplete');
    expect(entry.config_snapshot).toEqual({ cfg: 'value' });
    expect(entry.context_snapshot).toEqual({ ctx: 'value' });
    expect(entry.degraded).toEqual(['audit_unwritten']);
  });

  it('⚠ the empty-valued optionals are OMITTED, not emitted empty', () => {
    // The complement. `audit-entry-omits-empties.test.ts` pins the two fields
    // stripped on every row; these are the ones omitted only when empty, and
    // emitting them would undo that saving on every row that has none.
    const entry = buildAuditEntry({
      ...maximalInput(),
      degraded: [],
      context_snapshot: {},
    } as AuditEntryInput) as unknown as Record<string, unknown>;
    expect('degraded' in entry, 'an empty degraded list was emitted').toBe(false);
    expect('context_snapshot' in entry, 'an empty context_snapshot was emitted').toBe(false);
  });
});
