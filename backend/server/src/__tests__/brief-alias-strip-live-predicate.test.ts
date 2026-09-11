/** The alias-strip safety path, exercised with the REAL egress predicate.
 *
 *  ⛔⛔ WHY THIS EXISTS. `stripAliasBearing` is what makes a recall-bearing turn
 *  briefable at all: the brief READS recalled content and must REMEMBER none of
 *  it. `chat-pii-slot-ordering.ts` is explicit that live turns were safe because
 *  *"no alias ever crossed a restart boundary in a resolvable position"* — a
 *  persisted brief holding `pii.Person1` would be the first thing in the system
 *  to break that.
 *
 *  🔑 IT HAS NEVER FIRED IN A BENCH RUN. Measured across every stored report:
 *  37 of 127 captured brief outputs contain a PII alias literal, and
 *  `alias_stripped` appears in the trail ZERO times. That is consistent with the
 *  benign reading — the PII layer RESTORES aliases to real names before the
 *  brief reaches persistence, so by the time `stripAliasBearing` sees it there
 *  is nothing to strip, and the bench captures the pre-restore view. But an
 *  untested guard and a dead guard look identical from the outside, and the
 *  existing coverage used a hand-written `/pii\.Person\d/` stand-in rather than
 *  the predicate the executor actually passes.
 *
 *  ⚠ So this pins the MECHANISM, not the live rate: given an alias-bearing
 *  brief and the real `hasPotentialPiiAliasLiteral`, entries are dropped. If
 *  restore ever regresses, this is the net.
 */
import { describe, expect, it } from 'vitest';
import { piiEgress } from '@recued/gateway';
import { stripAliasBearing, type RollingBrief } from '../chat-rolling-brief.js';

const brief = (over: Partial<RollingBrief>): RollingBrief => ({
  intent: 'audit the rings', constraints: [], pending: [], findings: [], completed: [], ...over,
});

describe('alias strip — with the predicate the executor really uses', () => {
  it('the real predicate recognises the alias shapes the model echoes', () => {
    // Exactly the forms observed in 37 captured brief outputs.
    expect(piiEgress.hasPotentialPiiAliasLiteral('pii.Person1 requested an audit')).toBe(true);
    expect(piiEgress.hasPotentialPiiAliasLiteral('reply to m4@d1.invalid')).toBe(true);
    expect(piiEgress.hasPotentialPiiAliasLiteral('Dana Reyes requested an audit')).toBe(false);
  });

  it('🔑 drops an alias-bearing FINDING before it can persist', () => {
    const { brief: clean, dropped } = stripAliasBearing(
      brief({ findings: ['Ring 01 cost: 137 units.', 'pii.Person1 owns the audit'] }),
      piiEgress.hasPotentialPiiAliasLiteral,
    );
    expect(clean.findings).toEqual(['Ring 01 cost: 137 units.']);
    expect(dropped).toBe(1);
  });

  it('drops an alias-bearing CONSTRAINT — the highest-value field is not exempt', () => {
    const { brief: clean, dropped } = stripAliasBearing(
      brief({ constraints: ['surcharge is 252 units', 'pii.Person1 asked for it'] }),
      piiEgress.hasPotentialPiiAliasLiteral,
    );
    expect(clean.constraints).toEqual(['surcharge is 252 units']);
    expect(dropped).toBe(1);
  });

  it('empties an alias-bearing INTENT rather than discarding the brief', () => {
    // The facts are still worth keeping; only the alias-bearing line goes.
    const { brief: clean, dropped } = stripAliasBearing(
      brief({ intent: 'audit for pii.Person1', findings: ['Ring 01 cost: 137 units.'] }),
      piiEgress.hasPotentialPiiAliasLiteral,
    );
    expect(clean.intent).toBe('');
    expect(clean.findings).toEqual(['Ring 01 cost: 137 units.']);
    expect(dropped).toBe(1);
  });

  it('drops an alias-bearing COMPLETED record — server-authored is not alias-free', () => {
    // The measured case: the model wrote `pii.Person1.dana.reyes` into its own
    // memory.write summary, which is what the completed record quotes.
    const { brief: clean, dropped } = stripAliasBearing(
      brief({ completed: ['memory.write — completed: held for pii.Person1'] }),
      piiEgress.hasPotentialPiiAliasLiteral,
    );
    expect(clean.completed).toEqual([]);
    expect(dropped).toBe(1);
  });

  it('leaves a brief with no aliases byte-identical and reports zero drops', () => {
    const b = brief({ constraints: ['surcharge is 252 units'], findings: ['Ring 01: 137'] });
    const { brief: clean, dropped } = stripAliasBearing(b, piiEgress.hasPotentialPiiAliasLiteral);
    expect(dropped).toBe(0);
    expect(clean).toEqual(b);
  });
});

describe('fail-closed: an alias that survives the strip must not persist', () => {
  // ⛔ `stripAliasBearing` drops whole ENTRIES, so a survivor means a shape it
  //   does not walk. The executor now refuses to persist such a brief rather
  //   than storing it: losing a carry is a degradation, persisting an alias is
  //   a leak — and a brief outlives its turn, which is exactly the restart
  //   boundary `chat-pii-slot-ordering.ts` says no alias has ever crossed.
  it('the strip walks every field a brief carries', () => {
    // If a field is ever added to RollingBrief and NOT walked, an alias in it
    // survives — which is the only way the executor's fail-closed check fires.
    const dirty: RollingBrief = {
      intent: 'pii.Person1', constraints: ['pii.Person2'], pending: ['pii.Person3'],
      findings: ['pii.Person4'], completed: ['pii.Person5'],
    };
    const { brief: clean } = stripAliasBearing(dirty, piiEgress.hasPotentialPiiAliasLiteral);
    // Nothing alias-bearing anywhere in the result.
    expect(piiEgress.hasPotentialPiiAliasLiteral(JSON.stringify(clean))).toBe(false);
  });

  it('a brief with an alias in EVERY field survives as an empty shell, not a leak', () => {
    const { brief: clean, dropped } = stripAliasBearing(
      { intent: 'pii.Person1', constraints: ['pii.Person1'], pending: ['pii.Person1'],
        findings: ['pii.Person1'], completed: ['pii.Person1'] },
      piiEgress.hasPotentialPiiAliasLiteral,
    );
    expect(dropped).toBe(5);
    expect(clean).toEqual({ intent: '', constraints: [], pending: [], findings: [], completed: [] });
  });
});
