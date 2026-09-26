/** Unit tests for the catastrophic-backtracking probe. The WIRING is asserted
 *  separately in `packages/ingredients/src/__tests__/request-schema-redos-install-gate.test.ts`
 *  — this file is only about whether the probe can see, and whether it can be
 *  trusted not to refuse a legitimate pattern.
 *
 *  ⚠ A TIMING CHECK THAT RUNS AT INSTALL TIME HAS TWO WAYS TO BE WRONG, and the
 *  expensive one is the false positive: refusing a legitimate pack on a loaded
 *  machine. This header used to say the margin made that safe — "one measurement
 *  is ~3 MICROSECONDS against a 50 ms bar" — which described the median and not
 *  the tail. On 2026-09-23 the worst shipped pattern measured 27 ms in one scan
 *  and 63 ms in another: OVER the old bar, i.e. an outright refusal of a
 *  legitimate mongodb-atlas pack. The bar is now 250 ms; see `per_probe_ms` for
 *  the corpus measurement, and `npm run check:pattern-redos` for the standing
 *  headroom report.
 *
 *  ⚠ AND THE RE-MEASURE IS NOT THE ANSWER. A suspect is measured twice, on the
 *  premise that a scheduling blip does not repeat on demand — true of a blip,
 *  false of sustained load, where both measurements come from the same slow
 *  regime. The margin does the work; the retry only catches the easy case. */

import { describe, expect, it } from 'vitest';
import {
  closedRequestSchemaBacktrackingIssues,
  probePatternForBacktracking,
} from '../closed-request-schema.js';

/** Real shapes from `community/`, where 297 distinct patterns ship. */
const SHIPPED_BENIGN = [
  '^[a-z]+$',
  '^-?(?:0|[1-9][0-9]*)$',
  '^\\s*\\{[\\s\\S]*\\}\\s*$',
  '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$',
  '^AC[0-9a-fA-F]{32}$',
  '^(?!-).+',
  '^[A-Za-z0-9][A-Za-z0-9._:-]{7,254}$',
  '^[^/?#]+$',
];

const schemaWith = (pattern: string): unknown => ({
  type: 'object',
  additionalProperties: false,
  required: ['q'],
  properties: { q: { type: 'string', maxLength: 100, pattern } },
});

describe('probePatternForBacktracking', () => {
  it('sees the nested-quantifier shape', () => {
    const finding = probePatternForBacktracking('^(a+)+$');
    expect(finding).not.toBeNull();
    expect(finding!.pattern).toBe('^(a+)+$');
    expect(finding!.input_length).toBeGreaterThan(0);
  });

  it('sees AMBIGUOUS ALTERNATION — star height ONE', () => {
    // 🔑 The whole reason this is a measurement and not a syntax check: the
    //   obvious static rule ("reject nested quantifiers") misses this one, and
    //   it took 19 seconds through the real validator.
    expect(probePatternForBacktracking('^(a|a)*$')).not.toBeNull();
  });

  it('sees the textbook pair', () => {
    expect(probePatternForBacktracking('^(x+x+)+y$')).not.toBeNull();
  });

  it('CONTROL: clears every pattern actually shipped in community/', () => {
    // ⛔ A prober that flagged everything would satisfy the three tests above.
    //   A false refusal here is the expensive failure — it blocks a good pack.
    const flagged = SHIPPED_BENIGN
      .filter((p) => probePatternForBacktracking(p) !== null);
    expect(flagged, `false positives: ${flagged.join(', ')}`).toEqual([]);
  });

  it('⛔ measures at the property’s own bound, not only at the rung below it', () => {
    // The long rungs are 64, 256 … 65,536. A property bounded between two of them
    // was measured only up to the rung below its bound, where a quadratic pattern
    // is up to 16x cheaper, so this one was admitted at `maxLength: 16_383`
    // (2026-09-24 audit). The bar is set between what the pattern costs at the
    // last rung and at the bound ON THIS MACHINE, so the verdict turns on where
    // it was measured, not on how fast the machine is.
    const pattern = '^\\s*(?:a|b)*a(?:a|b)*\\s*c$';
    const re = new RegExp(pattern);
    const cost = (length: number): number => {
      const input = `${'a'.repeat(length)}!`;
      let best = Infinity;
      for (let i = 0; i < 2; i += 1) {
        const started = performance.now();
        re.test(input);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    const atLastRung = cost(4_096);
    const atBound = cost(16_383);
    expect(atBound / atLastRung, 'the test needs a pattern that grows with length').toBeGreaterThan(6);
    const finding = probePatternForBacktracking(pattern, {
      max_length: 16_383,
      per_probe_ms: Math.sqrt(atLastRung * atBound),
    });
    expect(finding, 'admitted: nothing measured it at its own bound').not.toBeNull();
    expect(finding!.input_length).toBeGreaterThanOrEqual(16_383);
  });

  it('an uncompilable pattern is not this check’s problem', () => {
    // The definition check owns that; returning a finding here would report the
    // same fault twice in different words.
    expect(probePatternForBacktracking('([unterminated')).toBeNull();
  });

  it('the benign sweep is fast enough to run at install time', () => {
    // ⚠ Not a threshold anyone should tune — a bound loose enough to survive a
    //   loaded CI box while still failing if the sweep became seconds-long.
    const started = Date.now();
    for (const p of SHIPPED_BENIGN) probePatternForBacktracking(p);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('closedRequestSchemaBacktrackingIssues', () => {
  it('reports the offending property, the fuel and the measurement', () => {
    const issues = closedRequestSchemaBacktrackingIssues(schemaWith('^(a+)+$'));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("property 'q'");
    expect(issues[0]).toContain('backtracks catastrophically');
    expect(issues[0]).toContain('cannot be interrupted');
  });

  it('says nothing about a schema whose patterns are fine', () => {
    for (const p of SHIPPED_BENIGN) {
      expect(closedRequestSchemaBacktrackingIssues(schemaWith(p)), p).toEqual([]);
    }
  });

  it('a schema with no patterns, or no schema at all, is silent', () => {
    expect(closedRequestSchemaBacktrackingIssues({
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: { q: { type: 'string', maxLength: 10 } },
    })).toEqual([]);
    expect(closedRequestSchemaBacktrackingIssues(undefined)).toEqual([]);
    expect(closedRequestSchemaBacktrackingIssues('not a schema')).toEqual([]);
  });

  it('a spent budget REFUSES rather than passing quietly', () => {
    // ⛔ The failure mode worth designing against: being too slow to check must
    //   not read as "checked and clean". A zero budget is the degenerate case of
    //   a schema carrying more patterns than the deadline allows.
    const issues = closedRequestSchemaBacktrackingIssues(schemaWith('^[a-z]+$'), {
      budget_ms: 0,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('could not be checked');
  });

  it('MUTATION: the verdict follows the CLOCK, not the pattern string', () => {
    // ⚠ Pins that every assertion above depends on the MEASUREMENT rather than
    //   on something incidental about the pattern text. Driven through the
    //   injected clock, so it is deterministic and costs no real time — the
    //   first cut of this test raised the threshold on a real catastrophic
    //   pattern instead, which made the probe run its whole escalation and take
    //   26 seconds before hitting the budget (and returning a finding, which is
    //   correct behaviour and the opposite of what it asserted).
    const benign = '^[a-z]+$';
    let t = 0;
    const jumping = (): number => { t += 1_000; return t; };
    expect(
      probePatternForBacktracking(benign, { now: jumping, budget_ms: Number.MAX_SAFE_INTEGER }),
      'a clock that makes every measurement look slow must produce a finding',
    ).not.toBeNull();
    expect(
      probePatternForBacktracking(benign, { now: () => 0 }),
      'a clock that never advances must produce none',
    ).toBeNull();
  });
});
