/** D-214 piece 1 — REQUEST MATCH, benched on its own.
 *
 * The A/B measures the composition of four unvalidated components, so a null
 * result there is uninterpretable: it can mean "precedent does not help", or
 * the shape missed, or the case never admitted, or the polarity was inverted.
 * (The last one was actually happening — see `d-214-recipe-run-pairing`.) This
 * file benches the first component alone, deterministically and with no
 * provider.
 *
 * WHAT THE MATCH ACTUALLY IS, read off the code rather than assumed:
 *
 *   requestShapeHash = hash({
 *     intent:      normalizeExecutionCaseText(shape.intent_facets[0]),
 *     constraints: SERVER_CONSTRAINT_FACETS ∩ present,
 *   })
 *
 * So case identity is an EXACT hash equality on one normalized intent string
 * plus a filtered constraint set — not a similarity score. And the intent has
 * two regimes:
 *
 *   GROUNDED — a model dissection that passes `isExecutionCaseIntentGrounded`
 *              supplies the intent.
 *   FALLBACK — otherwise `inferredIntent(prompt)` = the FIRST 8 WORD TOKENS of
 *              the normalized prompt.
 *
 * The fallback regime is not hypothetical, and it is not rare. Measured
 * `request_shape_source_reports` from the live A/B runs:
 *
 *   155 run 2   grounded 5   fallback 27   → 84% fallback
 *   155 run 3   grounded 3   fallback 29   → 91% fallback
 *   153 powered grounded 31  fallback 29   → 48% fallback
 *
 * So the A/B has been measuring THROUGH a matcher that, in the regime it
 * actually ran in, misses the majority of same-intent pairs. Nothing on the
 * card or in the report surfaces which regime produced a given shape.
 *
 * ⚠ This file ASSERTS only what is unambiguous (reflexivity, documented
 * normalization, and separation of plainly different requests) and MEASURES
 * the rest, printing a confusion matrix and every disagreement. Whether
 * "email Alice the report" and "email Bob the report" *should* share a case is
 * a judgement about precedent, not a fact about the code, and a bench that
 * asserted its author's opinion there would be smuggling in a verdict.
 */

import { describe, expect, it } from 'vitest';
import type { RequestDissection } from '@recued/contracts';

import {
  analyzeExecutionCaseRequest,
  isExecutionCaseIntentGrounded,
  requestShapeHash,
} from '../execution-case-core.js';

/** `undefined` dissection ⇒ the FALLBACK regime (first-8-tokens intent). */
const shapeHash = (
  prompt: string,
  dissection?: RequestDissection,
): string =>
  requestShapeHash(
    analyzeExecutionCaseRequest(prompt, dissection).request_shape!,
  );

type Label = 'same' | 'different';

interface Pair {
  /** Why a reasonable reader would call these the same request, or not. */
  readonly why: string;
  readonly label: Label;
  readonly a: string;
  readonly b: string;
}

/** Labelled by MEANING, before looking at any hash. The labels are the ground
 * truth the matcher is scored against; they are deliberately conservative —
 * only pairs whose reading is uncontroversial. */
const CORPUS: readonly Pair[] = [
  // ── same request, cosmetic difference only ───────────────────────
  { label: 'same', why: 'letter case', a: 'Email the quarterly report to the customer', b: 'email the QUARTERLY report to the CUSTOMER' },
  { label: 'same', why: 'trailing punctuation', a: 'Email the quarterly report to the customer', b: 'Email the quarterly report to the customer.' },
  { label: 'same', why: 'internal punctuation', a: 'Email the quarterly report to the customer', b: 'Email the quarterly report — to the customer' },
  { label: 'same', why: 'collapsed whitespace', a: 'Email the quarterly report to the customer', b: 'Email  the   quarterly report to the customer' },
  { label: 'same', why: 'unicode NFKC form', a: 'Email the quarterly report to the customer', b: 'Ｅmail the quarterly report to the customer' },

  // ── same request, ordinary human variation ───────────────────────
  { label: 'same', why: 'politeness prefix', a: 'Email the quarterly report to the customer', b: 'Please email the quarterly report to the customer' },
  { label: 'same', why: 'polite frame', a: 'Email the quarterly report to the customer', b: 'Could you email the quarterly report to the customer' },
  { label: 'same', why: 'filler opener', a: 'Email the quarterly report to the customer', b: 'Hey, email the quarterly report to the customer' },
  { label: 'same', why: 'clause order', a: 'Email the quarterly report to the customer', b: 'To the customer, email the quarterly report' },
  { label: 'same', why: 'verb synonym', a: 'Email the quarterly report to the customer', b: 'Send the quarterly report to the customer by email' },
  { label: 'same', why: 'trailing courtesy', a: 'Email the quarterly report to the customer', b: 'Email the quarterly report to the customer, thanks' },

  // ── genuinely different requests ─────────────────────────────────
  { label: 'different', why: 'opposite action', a: 'Email the quarterly report to the customer', b: 'Delete the quarterly report' },
  { label: 'different', why: 'different object', a: 'Email the quarterly report to the customer', b: 'Email the onboarding checklist to the customer' },
  { label: 'different', why: 'different action entirely', a: 'Email the quarterly report to the customer', b: 'Schedule a meeting with the customer' },
  { label: 'different', why: 'read vs write', a: 'Email the quarterly report to the customer', b: 'Find the quarterly report' },
  { label: 'different', why: 'unrelated domain', a: 'Email the quarterly report to the customer', b: 'Archive last year invoices' },

  // ── the adversarial half: long shared prefix, divergent tail ─────
  // `inferredIntent` reads the FIRST 8 TOKENS, so a pair that agrees for eight
  // tokens and then contradicts itself is where a prefix matcher is weakest.
  { label: 'different', why: 'shared 8-token prefix, opposite tail', a: 'Please go ahead and update the customer record with the new address', b: 'Please go ahead and update the customer record and then delete it' },
  { label: 'different', why: 'shared prefix, different recipient class', a: 'Send the signed contract over to the legal team for review today', b: 'Send the signed contract over to the legal team competitor by mistake' },
  { label: 'different', why: 'shared prefix, negated tail', a: 'Email the quarterly revenue summary to every regional manager immediately', b: 'Email the quarterly revenue summary to every regional manager except finance' },
];

/** The intent a competent model would emit for a prompt: its canonical action,
 * written in the prompt's own words. Same string for same-meaning prompts —
 * i.e. the CEILING of the grounded regime, where the model canonicalizes
 * paraphrases perfectly. */
const CANONICAL_INTENT: Readonly<Record<string, string>> = {
  email: 'email the quarterly report to the customer',
  update: 'update the customer record',
  contract: 'send the signed contract to the legal team',
  revenue: 'email the quarterly revenue summary to every regional manager',
  delete: 'delete the quarterly report',
  checklist: 'email the onboarding checklist to the customer',
  schedule: 'schedule a meeting with the customer',
  find: 'find the quarterly report',
  archive: 'archive last year invoices',
};

/** Which canonical intent belongs to a prompt.
 *
 * ⚠ The adversarial pairs get DISTINCT intents on purpose. A competent model
 * reading "…to the legal team for review" and "…to the legal team competitor by
 * mistake" would not emit one string for both. An earlier version of this table
 * keyed only on the shared prefix, handed both halves the same intent, and the
 * grounded column duly reported two false merges — which were the fixture's,
 * not the substrate's. The bench has to give the grounded regime its honest
 * best case or it measures its own author. */
const intentFor = (prompt: string): string => {
  const p = prompt.toLowerCase();
  if (p.includes('onboarding checklist')) return CANONICAL_INTENT.checklist!;
  if (p.includes('delete the quarterly')) return CANONICAL_INTENT.delete!;
  if (p.includes('schedule a meeting')) return CANONICAL_INTENT.schedule!;
  if (p.includes('find the quarterly')) return CANONICAL_INTENT.find!;
  if (p.includes('archive last year')) return CANONICAL_INTENT.archive!;
  // Adversarial pairs — the tail is what distinguishes them, so the intent must.
  if (p.includes('customer record')) {
    return p.includes('delete')
      ? 'update the customer record and then delete it'
      : 'update the customer record with the new address';
  }
  if (p.includes('signed contract')) {
    return p.includes('competitor')
      ? 'send the signed contract to the legal team competitor'
      : 'send the signed contract to the legal team for review';
  }
  if (p.includes('revenue summary')) {
    return p.includes('except')
      ? 'email the quarterly revenue summary to every regional manager except finance'
      : 'email the quarterly revenue summary to every regional manager';
  }
  return CANONICAL_INTENT.email!;
};

const dissectionFor = (prompt: string): RequestDissection => ({
  schema_version: 1,
  intent: intentFor(prompt),
  objects: [],
  entities: [],
  constraints: [],
  outcome_sought: '',
});

interface Scored {
  pair: Pair;
  collided: boolean;
  correct: boolean;
}

type Regime = 'fallback' | 'grounded';

const score = (regime: Regime): {
  rows: Scored[];
  tp: number; fp: number; fn: number; tn: number;
} => {
  const rows = CORPUS.map((pair): Scored => {
    const h = (prompt: string) => shapeHash(
      prompt,
      regime === 'grounded' ? dissectionFor(prompt) : undefined,
    );
    const collided = h(pair.a) === h(pair.b);
    return { pair, collided, correct: collided === (pair.label === 'same') };
  });
  return {
    rows,
    tp: rows.filter((r) => r.pair.label === 'same' && r.collided).length,
    fn: rows.filter((r) => r.pair.label === 'same' && !r.collided).length,
    fp: rows.filter((r) => r.pair.label === 'different' && r.collided).length,
    tn: rows.filter((r) => r.pair.label === 'different' && !r.collided).length,
  };
};

const report = (label: string, s: ReturnType<typeof score>): string => {
  const precision = s.tp + s.fp === 0 ? NaN : s.tp / (s.tp + s.fp);
  const recall = s.tp + s.fn === 0 ? NaN : s.tp / (s.tp + s.fn);
  const lines = [
    `── ${label} ──`,
    `  merged-correctly ${s.tp}  missed-match ${s.fn}  wrongly-merged ${s.fp}  separated-correctly ${s.tn}`,
    `  precision ${(precision * 100).toFixed(0)}%  recall ${(recall * 100).toFixed(0)}%`,
  ];
  for (const r of s.rows.filter((x) => !x.correct)) {
    lines.push(`  ${r.pair.label === 'same' ? 'MISSED  ' : 'MERGED  '}(${r.pair.why})`);
  }
  return lines.join('\n');
};

describe('D-214 request match — component bench', () => {
  it('measures the GROUNDING GATE, which decides which regime you land in', () => {
    // The gate is what silently routes a request into the first-8-tokens
    // fallback. It requires the model intent to BEGIN with the prompt's first
    // content term and to be an ordered subsequence of it. So a canonical
    // intent can be perfectly correct and still be REJECTED — by a politeness
    // word — and nothing downstream signals that it happened.
    const prompts = [...new Set(CORPUS.flatMap((p) => [p.a, p.b]))];
    const rejected = prompts.filter((prompt) =>
      !isExecutionCaseIntentGrounded(prompt, intentFor(prompt)));
    // eslint-disable-next-line no-console
    console.log([
      '',
      '── GROUNDING GATE (canonical model intent vs its own prompt) ──',
      `  accepted ${prompts.length - rejected.length}/${prompts.length}`
      + `  rejected ${rejected.length} → silently FALLS BACK to first-8-tokens`,
      ...rejected.map((prompt) => `  REJECTED  "${prompt.slice(0, 60)}"`),
    ].join('\n'));

    // Non-vacuity: the gate is genuinely exercised, and in both directions.
    expect(prompts.length).toBeGreaterThan(10);
    expect(rejected.length).toBeLessThan(prompts.length);
  });

  it('measures match quality in both intent regimes', () => {
    const fallback = score('fallback');
    const grounded = score('grounded');
    // eslint-disable-next-line no-console
    console.log([
      report('FALLBACK regime (inferredIntent = first 8 tokens)', fallback),
      report('GROUNDED regime (model dissection supplies intent)', grounded),
    ].join('\n\n'));

    // Non-vacuity: the corpus actually exercises both outcomes.
    expect(fallback.tp + fallback.fn).toBeGreaterThan(0);
    expect(fallback.fp + fallback.tn).toBeGreaterThan(0);
  });

  // ── The only assertions. Each is a documented property of the code, not an
  // opinion about what precedent ought to group. ───────────────────────────

  it('is reflexive — an identical prompt always matches itself', () => {
    for (const pair of CORPUS) {
      expect(shapeHash(pair.a)).toBe(shapeHash(pair.a));
      expect(shapeHash(pair.b)).toBe(shapeHash(pair.b));
    }
  });

  it('honours the normalization it documents (case, punctuation, whitespace, NFKC)', () => {
    // `normalizeExecutionCaseText` explicitly does NFKC + lowercase + strip
    // punctuation/symbols + collapse whitespace. A cosmetic difference that
    // survived it would be a defect in a stated contract, not a judgement call.
    const cosmetic = CORPUS.filter((p) =>
      p.label === 'same'
      && ['letter case', 'trailing punctuation', 'internal punctuation',
        'collapsed whitespace', 'unicode NFKC form'].includes(p.why));
    expect(cosmetic).toHaveLength(5);
    for (const pair of cosmetic) {
      expect(shapeHash(pair.a), `cosmetic variant must match: ${pair.why}`)
        .toBe(shapeHash(pair.b));
    }
  });

  it('separates requests whose action or object plainly differs', () => {
    const plainly = CORPUS.filter((p) =>
      p.label === 'different'
      && ['opposite action', 'different object', 'different action entirely',
        'read vs write', 'unrelated domain'].includes(p.why));
    expect(plainly).toHaveLength(5);
    for (const pair of plainly) {
      expect(shapeHash(pair.a), `must not merge: ${pair.why}`)
        .not.toBe(shapeHash(pair.b));
    }
  });
});
