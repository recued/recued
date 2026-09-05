import { describe, expect, it } from 'vitest';

import {
  computeContextInputTokenBudget,
  ESTIMATED_BYTES_PER_TOKEN,
  estimateConservativeMessageTokens,
  estimateConservativeMessagesTokens,
  estimateConservativeTextTokens,
} from '../context-budget.js';

describe('context budget', () => {
  it('reserves output and safety capacity from the declared model window', () => {
    expect(computeContextInputTokenBudget(8_192, 4_000)).toBe(3_936);
    expect(computeContextInputTokenBudget(8_192, 4_000, 192)).toBe(4_000);
  });

  it('rejects invalid metadata and windows with no input capacity', () => {
    expect(computeContextInputTokenBudget(0, 1)).toBeNull();
    expect(computeContextInputTokenBudget(8_192.5, 1)).toBeNull();
    expect(computeContextInputTokenBudget(8_192, -1)).toBeNull();
    expect(computeContextInputTokenBudget(4_000, 4_000)).toBeNull();
  });

  it('measures UTF-8 bytes, converted to tokens', () => {
    // ⛔ THIS USED TO ASSERT 5 — one token per byte. That reads as the safe
    //   choice (a token is never fewer than one byte) and is why it stood, but
    //   nothing consumed the budget so nothing exposed the cost. Once chat
    //   became budgeted it did: a 32,768-token window yielded a 24,512 budget
    //   while the tool catalog alone is ~29,064 bytes, so the trim ran to
    //   exhaustion and destroyed the conversation on a prompt the provider
    //   then counted at ~7,000 tokens and accepted.
    expect(estimateConservativeTextTokens('plain'))
      .toBe(Math.ceil(5 / ESTIMATED_BYTES_PER_TOKEN));
    // ⚠ The old second assertion compared against JS `.length`, which is a
    //   meaningless baseline (UTF-16 units, not bytes and not tokens). What
    //   actually matters is that multi-byte content costs MORE than ASCII of
    //   the same visual length — that is the property a chars-per-token
    //   heuristic gets wrong and this does not.
    expect(estimateConservativeTextTokens('👩‍💻'))
      .toBeGreaterThan(estimateConservativeTextTokens('abcde'));
  });

  /** ⛔⛔ THE CALIBRATION, PINNED. `ESTIMATED_BYTES_PER_TOKEN` was picked by
   *  measuring a real BPE tokenizer (`o200k_base`) over every model-bound
   *  string in all 1,546 stored bench reports — 20,008 samples — plus
   *  constructed payloads for the content classes that corpus does not
   *  contain. The tokenizer is NOT a dependency of this repo, so the numbers
   *  cannot be recomputed here; they are recorded so that changing the constant
   *  is a deliberate act against stated evidence rather than a tuning guess.
   *
   *  ⛔ THE BENCH CORPUS ALONE WOULD HAVE CALIBRATED IT WRONG. Its minimum is
   *  3.95, which makes 3 look safe — but every one of those packets is
   *  prose-heavy, because the bench asks conversational questions. Real tool
   *  results often are not, and the binding case is a thinned catalog beside an
   *  id-dense listing at 2.15. A corpus that never exercises a content class
   *  reports it as absent, not as safe. */
  it('⛔ stays at or below the WORST measured whole-packet ratio', () => {
    // Measured 2026-09-03, o200k_base, whole packets (what `promptFits` sees):
    //   round 1, no tool calls .......... 4.82
    //   typical, prose tool result ...... 4.47
    //   bench corpus (20,008), minimum .. 3.95
    //   worst realistic, id-only result . 2.82
    //   extreme, thinned catalog + ids .. 2.15   ← binding
    const WORST_MEASURED_BYTES_PER_TOKEN = 2.15;
    expect(ESTIMATED_BYTES_PER_TOKEN).toBeLessThanOrEqual(WORST_MEASURED_BYTES_PER_TOKEN);
    // ⚠ And not absurdly below it — an over-count is what made the byte-era
    // rule destroy context, so the conservatism has to stay bounded too.
    expect(ESTIMATED_BYTES_PER_TOKEN).toBeGreaterThan(WORST_MEASURED_BYTES_PER_TOKEN / 2);
  });

  it('⛔ never returns zero for non-empty content, however short', () => {
    // A rounding scheme that floors would make a short message free, and a
    // list of short messages free forever.
    for (const v of ['a', 'ab', '.', '\u00e9']) {
      expect(estimateConservativeTextTokens(v), v).toBeGreaterThan(0);
    }
    expect(estimateConservativeTextTokens('')).toBe(0);
  });

  it('adds stable per-message framing and sums message lists', () => {
    const messages = [
      { role: 'system' as const, content: 'rules' },
      { role: 'user' as const, content: 'hello' },
    ];
    expect(estimateConservativeMessagesTokens(messages)).toBe(
      messages.reduce(
        (total, message) => total + estimateConservativeMessageTokens(message),
        0,
      ),
    );
  });
});
