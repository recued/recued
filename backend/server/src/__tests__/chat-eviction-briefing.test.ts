/** ⛔ THE BRIEFING ITSELF — the pure function the eviction rung calls.
 *
 *  `chat-tail-eviction-sweep` covers it THROUGH the executor, which proves it
 *  is wired and bounded in situ but exercises only the shapes a real tail
 *  happens to produce. These are the shapes it does not: an empty eviction,
 *  content that is only whitespace, a body so small the fixed parts cannot fit,
 *  and the boundary where the cap binds. Each of those returns something to a
 *  model, and each has a wrong answer that would look reasonable. */
import { describe, expect, it } from 'vitest';
import {
  BRIEFING_MAX_CHARS,
  BRIEFING_MAX_SHARE_OF_EVICTED,
  CONTEXT_OMISSION_NOTICE,
  buildEvictionBriefing,
} from '../chat-eviction-briefing.js';

const turn = (role: 'user' | 'assistant', content: string) => ({ role, content });
/** Evicted content large enough that the 25% share is not the binding limit. */
const bulk = (n: number) => Array.from({ length: n }, (_, i) =>
  turn(i % 2 === 0 ? 'user' : 'assistant', `${i % 2 === 0 ? 'ask' : 'reply'} ${i} ${'z'.repeat(300)}`));

describe('buildEvictionBriefing', () => {
  it('names what went, and says what the absence MEANS', () => {
    // ⚠ Padded deliberately: the 25% share means a SMALL eviction earns no
    //   briefing at all (see the test below). A two-line fixture would return
    //   the bare notice and this test would be asserting the wrong thing.
    const out = buildEvictionBriefing([
      turn('user', `what is the Kestrel rollback window ${'p'.repeat(600)}`),
      turn('assistant', `Saturday 02:00-04:00 UTC ${'p'.repeat(600)}`),
    ]);
    expect(out, 'opens with the shipped notice').toContain(CONTEXT_OMISSION_NOTICE);
    expect(out, 'quotes the question').toContain('Kestrel rollback window');
    expect(out, 'labels each side').toMatch(/you were asked|you answered/);
    // ⛔ The sentence the whole feature exists for. A live model lost its own
    //   history and concluded the DATA was missing; naming the loss is half the
    //   fix, saying what the absence means is the other half.
    expect(out, 'the misattribution guard').toContain('not missing data');
  });

  it('⛔ defers entirely when the provider compacts its own context', () => {
    const out = buildEvictionBriefing(bulk(6), { providerCompacts: true });
    expect(out, 'bare notice, nothing added').toBe(CONTEXT_OMISSION_NOTICE);
  });

  it('returns the bare notice when nothing was evicted', () => {
    // A briefing that names no loss is a claim that something was lost.
    expect(buildEvictionBriefing([])).toBe(CONTEXT_OMISSION_NOTICE);
  });

  it('⛔ never exceeds the cap, at any eviction size', () => {
    for (const n of [2, 4, 8, 16, 40]) {
      const out = buildEvictionBriefing(bulk(n));
      expect(
        out.length - CONTEXT_OMISSION_NOTICE.length,
        `n=${n} added ${out.length - CONTEXT_OMISSION_NOTICE.length} chars`,
      ).toBeLessThanOrEqual(BRIEFING_MAX_CHARS);
    }
  });

  it('⛔⛔ never costs more than its share of what it replaced', () => {
    // The property that keeps it from raising the ladder's floor: at the floor
    // the tail IS the briefing, so an unbounded one turns an evict-and-fit into
    // an abandon — measured once, on the first cut of this feature.
    for (const n of [1, 2, 3, 6, 12, 30]) {
      const evicted = bulk(n);
      const evictedChars = evicted.reduce((t, m) => t + m.content.length, 0);
      const out = buildEvictionBriefing(evicted);
      const added = out.length - CONTEXT_OMISSION_NOTICE.length;
      expect(
        added <= Math.max(0, Math.floor(evictedChars * BRIEFING_MAX_SHARE_OF_EVICTED)),
        `n=${n}: added ${added} chars against ${evictedChars} evicted `
        + `(${((added / evictedChars) * 100).toFixed(1)}%)`,
      ).toBe(true);
    }
  });

  it('⛔ a SMALL eviction earns no briefing — it is not worth its own bytes', () => {
    // 25% of a tiny eviction cannot cover the fixed lead + guidance, and a
    // half-rendered briefing ("Omitted, newest first —" with nothing after it)
    // would be worse than saying only that something went. The threshold is a
    // consequence of the share rule rather than a separate knob: roughly 324
    // chars must go before a briefing is affordable, which is about one medium
    // turn. Losing less than that is not the failure this feature addresses.
    expect(buildEvictionBriefing([turn('user', 'hi'), turn('assistant', 'ok')]))
      .toBe(CONTEXT_OMISSION_NOTICE);
    // ⚠ MEASURED, not derived. I reasoned the threshold was ~324 chars from
    //   the fixed lead + guidance and was wrong: the first ANCHOR has to fit
    //   too, so the real boundary sits between 604 and 1204 evicted chars.
    //   Both sides are pinned so a change to the lead, the guidance or the
    //   anchor width moves this test rather than passing silently.
    expect(
      buildEvictionBriefing([turn('user', `q ${'s'.repeat(600)}`)]),
      '~600 chars evicted is still under the threshold',
    ).toBe(CONTEXT_OMISSION_NOTICE);
    expect(
      buildEvictionBriefing([
        turn('user', `q ${'s'.repeat(600)}`),
        turn('assistant', `a ${'s'.repeat(600)}`),
      ]),
      '~1200 chars earns one — the rule is a threshold, not a refusal',
    ).not.toBe(CONTEXT_OMISSION_NOTICE);
  });

  it('reports how many it could not show, rather than implying it showed all', () => {
    const out = buildEvictionBriefing(bulk(40));
    expect(out, 'accounts for the remainder').toMatch(/\+\d+ earlier/);
  });

  it('⛔ renders oldest→newest, but DROPS the oldest first when space runs out', () => {
    const evicted = [
      turn('user', `OLDESTMARK question ${'y'.repeat(700)}`),
      turn('assistant', `filler ${'y'.repeat(700)}`),
      turn('user', `NEWESTMARK question ${'y'.repeat(700)}`),
    ];
    // Enough evicted bulk to earn a briefing, then an explicit cap sized so
    // exactly ONE anchor fits: fixed parts are 81 chars and an anchor is ~115,
    // so 220 admits one and refuses the second. (190 admits none — the first
    // cut of this test asserted an ordering on an empty briefing.)
    const out = buildEvictionBriefing(evicted, { maxChars: 220 });
    // Nearest the current turn is the most load-bearing, so it is the one kept.
    expect(out, 'keeps the newest').toContain('NEWESTMARK');
    expect(out, 'sheds the oldest').not.toContain('OLDESTMARK');
  });

  it('collapses whitespace so a multi-line turn stays one anchor line', () => {
    const out = buildEvictionBriefing([
      turn('user', `line one\n\n   line two\ttabbed ${'w'.repeat(700)}`),
      turn('assistant', `answer ${'w'.repeat(700)}`),
    ]);
    expect(out, 'no raw newlines in the anchor').not.toContain('\n');
    expect(out).toContain('line one line two');
  });

  it('skips content that is only whitespace instead of emitting an empty anchor', () => {
    const out = buildEvictionBriefing([
      turn('user', `   \n\t  `),
      turn('assistant', `real answer ${'v'.repeat(1200)}`),
    ]);
    expect(out).toContain('real answer');
    expect(out, 'no empty label').not.toMatch(/you were asked:\s*(\||$)/);
  });

  it('marks a truncated quote so the model does not read it as complete', () => {
    const out = buildEvictionBriefing([
      turn('user', `start ${'t'.repeat(700)} end`),
      turn('assistant', `reply ${'t'.repeat(700)}`),
    ]);
    expect(out, 'truncation is visible').toContain('…');
    expect(out, 'the tail of a cut quote is gone').not.toContain('end');
  });
});
