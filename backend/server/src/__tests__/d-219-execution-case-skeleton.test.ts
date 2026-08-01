/** D-219 — skeleton matching: the pairs it must accept, and the ones that make
 *  it dangerous if it does.
 *
 *  Every fixture here came out of a measurement rather than imagination —
 *  internal benchmarks ran these through five
 *  candidate permission rules and reported which pairs each one wrongly
 *  accepted. The DIFFERENT-procedure cases below are exactly the ones that
 *  defeated the cheap rules. */
import { describe, expect, it } from 'vitest';

import {
  alignSkeleton,
  isSkeletonMatch,
  SKELETON_MAX_HOLES,
} from '../execution-case-skeleton.js';
import { promoteSkeletonMatchesForTest } from '../execution-case-precedent.js';

const terms = (s: string): string[] => s.split(/\s+/u).filter(Boolean);

/** The rule this module exists to make possible: a hole is a value only when
 *  something types BOTH sides. Here, a stand-in "contact index". */
const KNOWN_NAMES = new Set(['mary', 'john', 'petra', 'orla', 'acme', 'zenith']);
const typedByIndex = ([a, b]: readonly [string, string]): boolean =>
  KNOWN_NAMES.has(a) && KNOWN_NAMES.has(b);

const match = (
  stored: string,
  prompt: string,
  isValueHole = typedByIndex,
  storedIsComplete = true,
): boolean => isSkeletonMatch({
  storedTerms: terms(stored),
  promptTerms: terms(prompt),
  isValueHole,
  storedIsComplete,
});

describe('D-219 — skeleton alignment', () => {
  it('finds the substituted position and reports no drift', () => {
    const { holes, shapeDrift } = alignSkeleton(
      terms('send mary an email'),
      terms('send john an email'),
    );
    expect(holes).toEqual([['mary', 'john']]);
    expect(shapeDrift).toBe(0);
  });

  it('reports drift when one side carries extra words', () => {
    // Not the same shape, so not the same request — whatever else it shares.
    const { shapeDrift } = alignSkeleton(
      terms('send mary an email'),
      terms('send mary an email tomorrow'),
    );
    expect(shapeDrift).toBeGreaterThan(0);
  });
});

describe('D-219 — skeleton match: what it accepts', () => {
  it('accepts the same request with a typed value swapped', () => {
    expect(match('send mary an email', 'send john an email')).toBe(true);
  });

  it('accepts two typed holes, and refuses a third', () => {
    // The cap is what stops "same shape, everything different" reading as one
    // pattern. Asserted as behaviour at the boundary, with the constant only as
    // the witness that the boundary is where it claims to be.
    expect(SKELETON_MAX_HOLES).toBe(2);
    expect(match('email mary about acme', 'email john about zenith')).toBe(true);
    expect(match('email mary about acme', 'call john about zenith')).toBe(false);
  });
});

describe('D-219 — skeleton match: what it must refuse', () => {
  it('⛔ refuses a VERB substitution — the pair that makes this dangerous', () => {
    // `delete the invoice` and `send the invoice` are structurally identical to
    // `send mary an email` / `send john an email`: same length, one hole. A
    // matcher that reads structure alone accepts both, and this one is the
    // reason the permission predicate is not optional.
    expect(match('delete the invoice', 'send the invoice')).toBe(false);
    expect(match('archive the onboarding doc', 'delete the onboarding doc'))
      .toBe(false);
  });

  it('⛔ refuses an OBJECT substitution even when both sides look value-ish', () => {
    // The pair that defeated the best cheap rule ("both tokens rare, not in
    // first position"). Emailing an invoice and emailing a contract are
    // different requests, and nothing structural distinguishes this from a
    // recipient swap.
    expect(match('email the invoice to acme', 'email the contract to acme'))
      .toBe(false);
  });

  it('⛔ an always-true predicate is the MEASURED-UNSAFE rule, not a lax default', () => {
    // Documents the finding in executable form: permitting any substitution
    // accepted 6 of 6 different-procedure pairs. If a future edit makes the
    // predicate optional and defaults it to true, this goes red.
    const permitAnything = (): boolean => true;
    expect(match('delete the invoice', 'send the invoice', permitAnything))
      .toBe(true);
  });

  it('⛔ refuses when ANY hole is untyped, not merely when all are', () => {
    // `every` vs `some` is invisible to a single-hole fixture, because one
    // untyped hole fails both. This pair has one typed hole and one untyped, so
    // it separates them — and the permissive reading is the unsafe one: it
    // would accept a recipient swap that also quietly changed the subject.
    expect(match('email mary about acme', 'email john about pears')).toBe(false);
    // The permitting witness: make the second hole typed and it matches.
    expect(match('email mary about acme', 'email john about zenith')).toBe(true);
  });

  it('refuses a shape change, however small', () => {
    expect(match('send mary an email', 'send mary an email tomorrow')).toBe(false);
    expect(match('send mary an email', 'email mary')).toBe(false);
  });

  it('⛔ refuses a POSSIBLY-TRUNCATED stored intent at the cap', () => {
    // `inferredIntent` caps at 8 terms, so a stored facet at the cap may be a
    // PREFIX. A prefix can align perfectly with a prompt that then goes
    // somewhere else entirely, which would be a confident wrong answer — the
    // worst outcome for a signal whose whole value is confidence.
    const eight = 'send mary an email about the quarterly report';
    expect(terms(eight)).toHaveLength(8);
    expect(match(eight, eight, typedByIndex, false)).toBe(false);
    // ⛔ …and the SAME text matches when the caller knows it is complete. The
    // cap guards a possibly-truncated SOURCE, not length: refusing long
    // requests outright would exclude 77% of real traffic (median 9 distinct
    // terms) for a hazard that does not apply once the whole prompt is in hand.
    expect(match(eight, eight, typedByIndex, true)).toBe(true);
    // …and the permitting witness: one term shorter, it is known-complete and
    // matches. Without this the guard could be refusing everything long.
    const seven = 'send mary an email about the report';
    expect(terms(seven)).toHaveLength(7);
    expect(match(seven, seven, typedByIndex, false)).toBe(true);
  });

  it('refuses an empty side rather than matching everything', () => {
    expect(match('', 'send john an email')).toBe(false);
    expect(match('send mary an email', '')).toBe(false);
  });
});

describe('D-219 — skeleton promotion in the retrieval gate', () => {
  const row = (case_id: string) => ({ case_id }) as never;
  const ranked = (...ids: string[]) =>
    ids.map((case_id, i) => ({ row: row(case_id), score: 10 - i }));
  const CONTACTS = new Set(['mary', 'john']);

  it('promotes an exact-shape match over higher-scoring lexical matches', async () => {
    // `c-skeleton` ranks LAST on lexical score. It is the same request with a
    // typed value swapped, which lexical overlap cannot distinguish from "two
    // words in common" — that is the whole reason the signal exists.
    const out = await promoteSkeletonMatchesForTest(
      ranked('c-lex1', 'c-lex2', 'c-skeleton'),
      'send john an email about the report',
      {
        'c-lex1': 'find the report and archive it somewhere safe',
        'c-lex2': 'email the report to legal for review please',
        'c-skeleton': 'send mary an email about the report',
      },
      async (tokens) => new Set(tokens.filter((t) => CONTACTS.has(t))),
    );
    expect(out.map((x) => x.row.case_id)).toEqual(['c-skeleton', 'c-lex1']);
  });

  it('⛔ does not promote when the hole is a VERB, not a value', async () => {
    // The pair the whole predicate exists for. Without the contact-index gate
    // this is structurally identical to the recipient swap above.
    const out = await promoteSkeletonMatchesForTest(
      ranked('c-lex1', 'c-lex2', 'c-verb'),
      'send the invoice',
      {
        'c-lex1': 'find the report and archive it somewhere safe',
        'c-lex2': 'email the report to legal for review please',
        'c-verb': 'delete the invoice',
      },
      async (tokens) => new Set(tokens.filter((t) => CONTACTS.has(t))),
    );
    expect(out.map((x) => x.row.case_id)).toEqual(['c-lex1', 'c-lex2']);
  });

  it('asks the contact index ONCE, with every hole token', async () => {
    // ⛔ Per-hole lookups would be ~32 index reads before the model call on
    // every owner chat turn. Batching is the reason this is affordable at all.
    const calls: string[][] = [];
    await promoteSkeletonMatchesForTest(
      ranked('a', 'b'),
      'send john an email',
      { a: 'send mary an email', b: 'send petra an email' },
      async (tokens) => { calls.push([...tokens]); return new Set(); },
    );
    expect(calls).toHaveLength(1);
    expect([...calls[0]!].sort()).toEqual(['john', 'mary', 'petra']);
  });

  it('stays inert without an index, and survives one that throws', async () => {
    const noIndex = await promoteSkeletonMatchesForTest(
      ranked('c-lex1', 'c-skeleton'),
      'send john an email about the report',
      { 'c-skeleton': 'send mary an email about the report' },
      undefined,
    );
    expect(noIndex.map((x) => x.row.case_id)).toEqual(['c-lex1', 'c-skeleton']);

    // A failed index read must cost the ranking nothing — advisory context can
    // never be the reason a turn loses its card.
    const threw = await promoteSkeletonMatchesForTest(
      ranked('c-lex1', 'c-skeleton'),
      'send john an email about the report',
      { 'c-skeleton': 'send mary an email about the report' },
      async () => { throw new Error('index down'); },
    );
    expect(threw.map((x) => x.row.case_id)).toEqual(['c-lex1', 'c-skeleton']);
  });
});
