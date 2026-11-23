/** D-348 — the request a chain is learned under is the owner's own words (Q2), and a call is what it
 *  does and to whom (Q3). */

import { describe, expect, it } from 'vitest';

import {
  chainCallSignatureHash,
  chainMayStandIn,
  chainRequestKeyHash,
  evaluateChainEvidence,
  isChainCallAnswer,
  isChainCallOutcome,
  normalizeChainRequestWords,
  type ChainEvidenceCall,
  type ChainEvidenceRequest,
} from '../chain-rule.js';

describe('D-348 — a request is its words, case, spacing and punctuation aside (Q2)', () => {
  it('folds what Q2 names, and nothing else', () => {
    expect(normalizeChainRequestWords('  Run my  morning routine. ')).toBe('run my morning routine');
    expect(normalizeChainRequestWords('RUN MY MORNING ROUTINE!!!')).toBe('run my morning routine');
    expect(normalizeChainRequestWords('Don’t forget: water the plants')).toBe('dont forget water the plants');
    // A full-width letter is its letter.
    expect(normalizeChainRequestWords('Ｒun')).toBe('run');
    // Another wording is another request.
    expect(normalizeChainRequestWords('run my routine')).not.toBe(normalizeChainRequestWords('run my morning routine'));
    // Words in another script are kept as words.
    expect(normalizeChainRequestWords('Envoie le rapport, s’il te plaît')).toBe('envoie le rapport sil te plaît');
  });

  it('a message of punctuation only is no request', () => {
    expect(normalizeChainRequestWords('?!…')).toBe('');
    expect(normalizeChainRequestWords('   ')).toBe('');
  });

  it('one key for one wording, another for another', () => {
    const key = (text: string) => chainRequestKeyHash(normalizeChainRequestWords(text));
    expect(key('Run my morning routine.')).toBe(key('run my morning routine'));
    expect(key('run my morning routine')).not.toBe(key('run my evening routine'));
    expect(key('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('D-348 — a call is what it does and to whom (Q3)', () => {
  it('its operation and its pins name it; a delete is another call', () => {
    const send = { op: 'step:send@h|mail-send||', pins: { to: ['ann@example.com'] } };
    expect(chainCallSignatureHash(send)).toBe(chainCallSignatureHash({ ...send, pins: { to: ['ann@example.com'] } }));
    expect(chainCallSignatureHash(send)).not.toBe(chainCallSignatureHash({ ...send, pins: { to: ['ben@example.com'] } }));
    expect(chainCallSignatureHash({ op: 'op:x|y|', pins: {} }))
      .not.toBe(chainCallSignatureHash({ op: 'op:x|y|', pins: {}, delete: true }));
  });

  it('reads its answers and outcomes from a closed list', () => {
    expect(['approved', 'approved_changed', 'refused'].every(isChainCallAnswer)).toBe(true);
    expect(isChainCallAnswer('expired')).toBe(false);
    expect(['ran', 'failed', 'unknown'].every(isChainCallOutcome)).toBe(true);
    expect(isChainCallOutcome('succeeded')).toBe(false);
    // An undo is not how a call ended: it comes later, with its own time.
    expect(isChainCallOutcome('undone')).toBe(false);
  });
});

describe('D-348 — what a request\'s occasions teach (Q4, Q7)', () => {
  const DAY = 86_400_000;
  const NOW = 100 * DAY;
  const ran = (signature_hash: string | null, over: Partial<ChainEvidenceCall> = {}): ChainEvidenceCall =>
    ({ signature_hash, delete: false, answer: 'approved', outcome: 'ran', ...over });
  /** A request on day `day` (its occasion that day's), holding one run per call, each answered. */
  const on = (day: number, calls: ChainEvidenceCall[], over: Partial<ChainEvidenceRequest> = {}): ChainEvidenceRequest =>
    ({ occasion: `chat:a|${String(day)}`, at: NOW - (100 - day) * DAY, held_runs: calls.length, answered_runs: calls.length, calls, ...over });

  it('a call is on the chain once it ran, as proposed, on 3 occasions', () => {
    expect(evaluateChainEvidence([on(97, [ran('send')]), on(98, [ran('send')])], NOW).members).toEqual([]);
    const learned = evaluateChainEvidence([on(97, [ran('send'), ran('task')]), on(98, [ran('send')]), on(99, [ran('send')])], NOW);
    expect(learned).toMatchObject({ occasions: 3, members: ['send'], deletes: [] });
  });

  it('one occasion counts once, however often the request came that day', () => {
    expect(evaluateChainEvidence([on(97, [ran('send')]), on(97, [ran('send')]), on(98, [ran('send')])], NOW).members)
      .toEqual([]);
  });

  it('a refusal, a failure or "not sure it finished" resets: nothing before it counts', () => {
    const before = [on(90, [ran('send')]), on(91, [ran('send')]), on(92, [ran('send')])];
    for (const spoiled of [
      ran('send', { answer: 'refused', outcome: null }), ran('send', { outcome: 'failed' }),
      ran('send', { outcome: 'unknown' }),
    ]) {
      const learned = evaluateChainEvidence([...before, on(93, [spoiled])], NOW);
      expect(learned).toMatchObject({ members: [], occasions: 0, spoiled_at: NOW - 7 * DAY });
      // And after it, the count starts again.
      expect(evaluateChainEvidence([...before, on(93, [spoiled]), on(94, [ran('send')]), on(95, [ran('send')]),
        on(96, [ran('send')])], NOW).members).toEqual(['send']);
    }
  });

  it('an undo resets as of when the owner undid the change: nothing before then counts, however recent', () => {
    const three = [on(90, [ran('send')]), on(91, [ran('send')]), on(92, [ran('send')])];
    expect(evaluateChainEvidence(three, NOW).members).toEqual(['send']);
    // Day 90's change, undone on day 93: days 91 and 92 no longer count either.
    const undone = NOW - 7 * DAY;
    expect(evaluateChainEvidence(three, NOW, undone)).toMatchObject({ members: [], occasions: 0, spoiled_at: undone });
    expect(evaluateChainEvidence([...three, on(94, [ran('send')]), on(95, [ran('send')])], NOW, undone))
      .toMatchObject({ members: [], occasions: 2 });
    // After it, the count starts again.
    expect(evaluateChainEvidence([...three, on(94, [ran('send')]), on(95, [ran('send')]), on(96, [ran('send')])], NOW, undone))
      .toMatchObject({ members: ['send'], occasions: 3 });
    // A request made the moment of the undo, or before it, is not after it.
    expect(evaluateChainEvidence([on(94, [ran('send')], { at: undone }), on(95, [ran('send')]), on(96, [ran('send')])],
      NOW, undone).occasions).toBe(2);
  });

  it('an undo older than 30 days resets nothing, as an older spoil does not', () => {
    const three = [on(97, [ran('send')]), on(98, [ran('send')]), on(99, [ran('send')])];
    const learned = evaluateChainEvidence(three, NOW, NOW - 31 * DAY);
    expect(learned).toMatchObject({ members: ['send'], occasions: 3 });
    expect(learned.spoiled_at).toBeUndefined();
  });

  it('a change before approving, an approval still waiting or one never answered counts for nothing and spoils nothing', () => {
    const two = [on(97, [ran('send')]), on(98, [ran('send')])];
    for (const neutral of [
      on(99, [ran('send', { answer: 'approved_changed' })]),
      on(99, [ran('send', { outcome: null })]),
      on(99, [ran('send')], { held_runs: 2, answered_runs: 1 }),
    ]) {
      expect(evaluateChainEvidence([...two, neutral], NOW)).toMatchObject({ members: [], occasions: 2 });
      expect(evaluateChainEvidence([...two, neutral], NOW).spoiled_at).toBeUndefined();
    }
  });

  it('a delete is on the chain after 5 occasions (Q7)', () => {
    const del = (day: number) => on(day, [ran('send'), ran('clear', { delete: true })]);
    const four = [del(94), del(95), del(96), del(97)];
    expect(evaluateChainEvidence(four, NOW)).toMatchObject({ members: ['send'], deletes: [] });
    expect(evaluateChainEvidence([...four, del(98)], NOW)).toMatchObject({ members: ['send'], deletes: ['clear'] });
  });

  it('counts in the last 30 days, and a spoil older than that resets nothing', () => {
    const old = { at: NOW - 31 * DAY, occasion: 'chat:a|69' };
    expect(evaluateChainEvidence([on(1, [ran('send')], old), on(98, [ran('send')]), on(99, [ran('send')])], NOW).members)
      .toEqual([]);
    expect(evaluateChainEvidence([on(1, [ran('send', { answer: 'refused', outcome: null })], old),
      on(97, [ran('send')]), on(98, [ran('send')]), on(99, [ran('send')])], NOW).members).toEqual(['send']);
  });

  it('a call it could not name is on no chain, and does not stop the rest', () => {
    expect(evaluateChainEvidence([97, 98, 99].map((day) => on(day, [ran(null), ran('send')])), NOW).members).toEqual(['send']);
  });
});

describe('D-348 §5.1 — where a chain may stand in for the owner\'s answer (one check, for the gates and the evidence)', () => {
  const call = (provenance: Parameters<typeof chainMayStandIn>[0]['provenance'], over: Partial<Parameters<typeof chainMayStandIn>[0]> = {}) =>
    chainMayStandIn({ slug: 'hubspot-catalog', risk_tier: 'write', provenance, args: { deal_id: '9001' }, ...over });

  it('an op set to ask, or to never and raised to ask by its tier: yes', () => {
    expect(call({ pre_lift_approval: 'ask' })).toBe(true);
    expect(call({ pre_lift_approval: 'never' })).toBe(true);
  });

  it('⛔ an action set to "always ask", a review, any lift, or a hold that does not say why: no', () => {
    expect(call({ pre_lift_approval: 'always' })).toBe(false);
    expect(call({ pre_lift_approval: 'ask', lift_reason: 'review_customer_payment' })).toBe(false);
    expect(call({ pre_lift_approval: 'never', lift_reason: 'quality' })).toBe(false);
    expect(call(undefined)).toBe(false);
  });

  it('⛔ a browser batch putting one of the owner\'s files into a page: no; the same page clicked: yes', () => {
    const steps = (s: Array<Record<string, unknown>>) => ({ target: '*://example.test/*', page: '7:ABCDEF0123', steps: s });
    expect(call({ pre_lift_approval: 'ask' }, { slug: 'core-dom-act', args: steps([{ do: 'upload', ref: 'e7', file: `file:${'b'.repeat(32)}` }]) }))
      .toBe(false);
    expect(call({ pre_lift_approval: 'ask' }, { slug: 'core-dom-act', args: steps([{ do: 'click', ref: 'e12' }]) })).toBe(true);
  });

  it('a delete\'s "always" is its tier\'s floor, so Q7\'s rule decides it; a review still keeps it off', () => {
    expect(call({ pre_lift_approval: 'always' }, { risk_tier: 'destructive' })).toBe(true);
    expect(call({ pre_lift_approval: 'always', lift_reason: 'review_customer_payment' }, { risk_tier: 'destructive' })).toBe(false);
  });
});
