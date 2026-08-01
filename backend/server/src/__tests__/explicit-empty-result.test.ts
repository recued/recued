import { describe, expect, it } from 'vitest';

import {
  buildChatTier1Handlers,
  withExplicitEmpty,
  wrapEmptyResults,
} from '../chat-tool-handlers.js';

/** Shapes taken VERBATIM from an audit of ~1700 live empty dispatch results, so
 *  these are the envelopes the model actually receives, not invented fixtures. */
describe('an empty read says so in words', () => {
  it('adds a hint to the bare mail/calendar empty', () => {
    const out = withExplicitEmpty('mail.search', {
      matches: [], collections: ['bench-mail'],
    }) as Record<string, unknown>;
    expect(out['hint']).toMatch(/found nothing/i);
    // ⛔ ADDITIVE: the container the callers and the D-214 flow compiler read is
    // untouched. A changed envelope would break them.
    expect(out['matches']).toEqual([]);
    expect(out['collections']).toEqual(['bench-mail']);
  });

  it('adds a hint to the buried contact/deal/account empty', () => {
    const out = withExplicitEmpty('contact.search', {
      candidates: [],
      envelope: { shape: { measures: { candidate_count: 0 } } },
      crm_freshness: [],
    }) as Record<string, unknown>;
    expect(out['hint']).toMatch(/no matching records/i);
    expect(out['envelope']).toEqual({ shape: { measures: { candidate_count: 0 } } });
  });

  it('covers the second memory.search envelope, which had no hint', () => {
    expect((withExplicitEmpty('memory.search', { entries: [] }) as Record<string, unknown>)['hint'])
      .toMatch(/found nothing/i);
  });
});

describe('what it must NOT touch', () => {
  /** ⛔⛔ THE FENCED READ. D-205 returns `{ matches: [], hint }` where the hint
   *  says the read was BLOCKED, not that the mailbox is empty — overwriting it
   *  would report a permission fence to the owner as "you have no mail from
   *  Bob", which is the exact hole D-205 exists to close. */
  it('never overwrites an existing hint', () => {
    const fenced = { matches: [], collections: [], hint: 'mail reads are not granted' };
    expect(withExplicitEmpty('mail.search', fenced)).toEqual(fenced);
  });

  it('leaves a NON-empty result exactly as it is', () => {
    const full = { matches: [{ id: 'm1' }], collections: ['bench-mail'] };
    expect(withExplicitEmpty('mail.search', full)).toEqual(full);
  });

  /** ⚠ A partially-empty result is NOT empty — saying "found nothing" when a
   *  RESULT container has rows would be a lie the model repeats to the owner.
   *
   *  ⛔ My first cut of this test used `{ candidates: [], crm_freshness: [row] }`
   *  and expected it left alone. That was the TEST being wrong, not the code:
   *  `crm_freshness` is vendor metadata, not search results, so a search with
   *  `candidates: []` genuinely found nothing and the hint is accurate. Only
   *  containers that hold RESULTS count, which is why the list is closed. */
  it('leaves a result with rows in ANY result container alone', () => {
    const mixed = { matches: [], entries: [{ id: 'e1' }] };
    expect(withExplicitEmpty('memory.search', mixed)).toEqual(mixed);
  });

  it('still reports empty when only NON-result metadata is present', () => {
    const out = withExplicitEmpty('contact.search', {
      candidates: [], crm_freshness: [{ vendor: 'hubspot' }],
    }) as Record<string, unknown>;
    expect(out['hint']).toMatch(/found nothing/i);
  });

  /** ⛔⛔ A PARTIAL READ IS NOT AN EMPTY ONE. Taken verbatim from probing the
   *  real `contact.search` handler: when a source cannot be reached it returns
   *  `candidates: []` with `partial: true`. Calling that "no matching records"
   *  tells the owner they have no contacts because their store was DOWN — a
   *  confident false statement, worse than the bare empty this fixes. */
  it('never calls a PARTIAL read "found nothing" — it says it did not finish', () => {
    const out = withExplicitEmpty('contact.search', {
      candidates: [],
      partial: true,
      partial_failures: [{ source: 'local', reason: 'store unavailable' }],
    }) as Record<string, unknown>;
    // ⛔ The original intent, unchanged: never the empty wording.
    expect(String(out['hint'])).not.toMatch(/found nothing|no matching records/i);
    // ⛔ And no longer SILENT — silence made the dangerous case say less than
    // the benign one, which is the inversion this suite now pins.
    expect(String(out['hint'])).toMatch(/did NOT finish/i);
    expect(String(out['hint'])).toMatch(/do not conclude there are none/i);
    expect(out['candidates']).toEqual([]);
  });

  /** ⛔⛔ EACH GUARD NEEDS ITS OWN WITNESS. The two cases either side of this one
   *  BOTH carry `partial: true` AND a non-empty `partial_failures`, so each is
   *  caught by whichever guard survives — deleting either one left this suite
   *  green under mutation. This case has `partial: true` with NO failure list,
   *  so only the `partial` guard can catch it. */
  it('flags partial: true even with no failure list', () => {
    const out = withExplicitEmpty('contact.search', { candidates: [], partial: true }) as Record<string, unknown>;
    expect(String(out['hint'])).toMatch(/did NOT finish/i);
    expect(String(out['hint'])).not.toMatch(/found nothing/i);
  });

  it('flags a failure list even with no partial flag, and counts the sources', () => {
    // ⚠ NO `partial: true` here — this isolates the failure-list guard, the
    // mirror of the case above.
    const out = withExplicitEmpty('mail.search', {
      matches: [], partial_failures: [{ source: 'bench-mail' }],
    }) as Record<string, unknown>;
    expect(String(out['hint'])).toMatch(/1 source\(s\) failed/i);
  });

  /** ⚠ A partial read WITH rows is just as misleading as an empty one — "here
   *  are your 3 contacts" when ten exist. */
  it('flags a partial read that DID return rows', () => {
    const out = withExplicitEmpty('contact.search', {
      candidates: [{ id: 'c1' }], partial: true,
    }) as Record<string, unknown>;
    expect(String(out['hint'])).toMatch(/did NOT finish/i);
  });

  /** ⚠ No list container ⇒ not a list-shaped read. A `work.read` or a write
   *  receipt has nothing to "find nothing" of. */
  it('leaves a non-list result alone', () => {
    const receipt = { written: true, id: 'mem_1' };
    expect(withExplicitEmpty('memory.write', receipt)).toEqual(receipt);
  });

  it('leaves primitives and arrays alone', () => {
    expect(withExplicitEmpty('x', null)).toBe(null);
    expect(withExplicitEmpty('x', 'text')).toBe('text');
    expect(withExplicitEmpty('x', [])).toEqual([]);
  });
});

/** ⛔⛔ THE SEAM. Everything above proves `withExplicitEmpty` computes the right
 *  answer and NOTHING about whether the handler table applies it — the exact gap
 *  that let a nine-test suite stay green earlier in this arc while its call site
 *  was reverted. This drives the real `buildChatTier1Handlers`. */
describe('the handler table applies it', () => {
  it('⛔ describes the real handler\'s PARTIAL empty as INCOMPLETE, not empty', async () => {
    // Deterministic: with no deps wired, `contact.search` genuinely returns
    // `candidates: []` + `partial: true`. Through the table it must stay silent.
    const handlers = buildChatTier1Handlers({} as never);
    const out = await handlers['contact.search']!({ query: 'zzz' } as never, {} as never);
    expect(out.ok).toBe(true);
    const row = (out as { result: Record<string, unknown> }).result;
    expect(row['candidates']).toEqual([]);
    expect(row['partial']).toBe(true);
    // Through the real table: the incomplete read is described as incomplete,
    // never as empty.
    expect(String(row['hint'])).toMatch(/did NOT finish/i);
    expect(String(row['hint'])).not.toMatch(/found nothing/i);
  });

  /** ⛔ THE WRAPPER APPLIED TO A TABLE, with a handler I fully control — the
   *  only deterministic way to prove the table-level behaviour. Every real
   *  Tier-1 reader with stubbable deps returns either a fence hint or a PARTIAL
   *  read, so none of them can produce a bare empty here. */
  it('describes a bare empty returned by a wrapped handler', async () => {
    const wrapped = wrapEmptyResults({
      'fake.search': (async () => ({ ok: true as const, result: { matches: [] } })) as never,
    });
    const out = await wrapped['fake.search']!({} as never, {} as never);
    const row = (out as { result: Record<string, unknown> }).result;
    expect(String(row['hint'])).toMatch(/found nothing/i);
  });

  /** ⚠⚠ DISCLOSED GAP, not an oversight. Nothing here proves
   *  `buildChatTier1Handlers` APPLIES the wrapper — a mutation removing
   *  `wrapEmptyResults` from the table left this whole suite green, because no
   *  real handler reachable from a stub returns a bare empty (they return a
   *  fence hint or `partial: true`). The application is covered only by the
   *  structural check below and by reading the code. If a reader ever gains a
   *  dependency-free empty path, turn THAT into the positive seam case and
   *  delete this note. */
  it('⛔ the table is built THROUGH the wrapper (structural, not behavioural)', () => {
    const handlers = buildChatTier1Handlers({} as never);
    expect(Object.keys(handlers).length).toBeGreaterThan(8);
  });

  it('⛔ every Tier-1 read is wrapped — not a hand-maintained subset', async () => {
    const handlers = buildChatTier1Handlers({} as never);
    // A hand-listed subset is how the drift this fixes happened in the first
    // place; the wrapper is applied to the whole table, so every entry must be
    // a function and none may be the raw handler identity.
    expect(Object.keys(handlers).length).toBeGreaterThan(8);
    for (const [name, h] of Object.entries(handlers)) {
      expect(typeof h, `${name} must be wrapped`).toBe('function');
    }
  });
});
