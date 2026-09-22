/** D-278 (producer side) — an AI producer that emits a confidence must tell
 *  the model when to answer 0.
 *
 *  The recipe corpus has `confidence_without_zero_anchor` in the validator.
 *  Housekeeping producers are TypeScript, so nothing validated them — and
 *  `purpose` was the one that needed it.
 *
 *  ⛔⛔ MEASURED on the shipped prompt, 6 mail bodies x 2 runs:
 *
 *      before  distinct [0.6, 0.9, 0.95, 1]   separation 0.117
 *              a body of "ok" — filed under `other` because nothing fits —
 *              scored 0.6-0.9, clearing the `purpose.confidence greater 0.7`
 *              gate the producer's own header documents
 *      after   distinct [0, 0.9, 0.95, 1]     separation 0.642
 *              all four `other` fallbacks answered exactly 0
 *
 *  🔑 AND HALF THE ANCHOR WAS DROPPED FOR MEASURING NOTHING. A second clause,
 *  "below 0.5 when two or more categories fit equally well", changed nothing:
 *  a double-charge-plus-cannot-log-in mail still scored 0.95-1.0 while
 *  FLIPPING between `billing` and `support_request` across runs. ⇒ **An anchor
 *  works when it names an observable condition the model already commits to
 *  — falling back to "other" — and not when it asks for a graded
 *  self-assessment.** Shipping the dead clause would have been an instruction
 *  with no effect.
 *
 *  ⚠ THE THREE OTHER PSI TOPICS ARE EXEMPT BY CONSTRUCTION, NOT BY OVERSIGHT.
 *  `commitment_followthrough_score`, `task_completion_velocity` and
 *  `project_velocity` compute `confidence = clamp(sample_count / 100, 0, 1)`
 *  — a sample-size ramp, no model and no prompt, so there is nothing to
 *  anchor. Their confidence is the best-defined in the codebase, and PSI over
 *  it measures something real: whether rows are suddenly derived from thinner
 *  evidence. The assertion below scopes itself to producers that actually ask
 *  a model. */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const PRODUCERS = join(__dirname, '..', 'housekeeping', 'producers');

/** Same shape as the recipe-side rule, over source text rather than JSON. */
const ZERO_ANCHOR = /(use|return|set|give)\s+[^.]{0,40}\b0\b[^.]{0,20}\bwhen\b|confidence\s+0\s+when|\b0\s+when\b/i;

/** Source with `//` comment lines removed — the anchor must live in the
 *  PROMPT, not in a comment about the prompt. ⚠ This file's own header would
 *  otherwise satisfy every check in it. */
const promptText = (src: string): string =>
  src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

interface Producer { file: string; src: string; prompt: string }

const aiProducersEmittingConfidence = (): Producer[] => {
  const out: Producer[] = [];
  for (const f of readdirSync(PRODUCERS)) {
    if (!f.endsWith('.ts') || f.startsWith('_')) continue;
    const src = readFileSync(join(PRODUCERS, f), 'utf8');
    const prompt = promptText(src);
    // Asks a model AND carries a confidence through to the stored value.
    const asksModel = /'(ai-classify|ai-extract|ai-score|ai-summarize|ai-sentiment|ai-prompt)'/.test(prompt);
    const emits = /confidence:\s*(result|o|v|parsed)\.confidence|confidence:\s*'confidence'/.test(prompt);
    if (asksModel && emits) out.push({ file: f, src, prompt });
  }
  return out;
};

describe('D-278 producer side — AI confidence carries a zero-anchor', () => {
  const producers = aiProducersEmittingConfidence();

  it('finds the AI producers at all, so the check below is not vacuous', () => {
    // ⚠ If this drops to 0 the suite silently stops testing anything — the
    // detector keys on source patterns, and a producer refactor can move them.
    expect(producers.map((p) => p.file)).toContain('purpose.ts');
  });

  it.each(aiProducersEmittingConfidence().map((p) => p.file))(
    '%s tells the model when to answer 0',
    (file) => {
      const p = producers.find((x) => x.file === file)!;
      expect(
        ZERO_ANCHOR.test(p.prompt),
        `${file} asks a model for a confidence but never names the case that scores zero. `
        + 'Measured, a self-rating without one clusters at 0.6-1.0 and any floor beneath it '
        + 'passes every row. Name a condition the model already commits to — see '
        + "purpose.ts's fallback to \"other\".",
      ).toBe(true);
    },
  );

  it('⚠ the anchor is in the PROMPT, not in a comment about the prompt', () => {
    // The stripped text is what reaches the model. A reviewer reading the file
    // sees both and cannot tell them apart; this can.
    const purpose = producers.find((p) => p.file === 'purpose.ts')!;
    expect(ZERO_ANCHOR.test(purpose.prompt)).toBe(true);
    expect(purpose.prompt).toContain('Use a confidence of 0 when you fall back to "other"');
  });
});

describe('D-278 producer side — the deterministic PSI topics need no anchor', () => {
  it.each(['commitment-followthrough-score.ts', 'task-completion-velocity.ts', 'project-velocity.ts'])(
    '%s computes confidence from sample size rather than asking a model',
    (file) => {
      const src = readFileSync(join(PRODUCERS, file), 'utf8');
      // 🔑 Documents WHY these are exempt, so a later reader does not "fix"
      // them by adding a prompt anchor to a producer that has no prompt.
      expect(src).toMatch(/sample_count\s*\/\s*100|SATURATION/);
      expect(promptText(src)).not.toMatch(/'(ai-classify|ai-extract|ai-score)'/);
    },
  );
});
