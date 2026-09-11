/** ⛔⛔ THE ROLLING-BRIEF ENABLE AND THE AUTHORITATIVE RECALL SIGNAL TRAVEL AS A
 *  PAIR. A `runChatTurn` call site that can FOLD must also be able to tell the
 *  fold whether the turn is recall-bearing.
 *
 *  🔑 WHY THIS EXISTS, AND WHY A GREEN SUITE DID NOT CATCH IT. `runChatTurn`
 *  takes both as OPTIONAL deps, so passing one without the other compiles, runs,
 *  and passes every test — the failure only appears on a live turn that both
 *  recalls and folds. Without `hasRegisteredRecall` the brief falls back to a
 *  slice approximation measured to UNDER-trigger: four forced-budget runs of
 *  bench 343 produced SEVEN tool-loop aborts (`recall-bearing packet has invalid
 *  recall_context`), each surfaced to the caller as `provider_failure`.
 *
 *  ⛔ AND IT WENT LIVE THE MOMENT THE DEFAULT FLIPPED. While the brief was off
 *  by default the gateway path never folded, so the missing signal there was
 *  latent. Wiring the enable at that call site alongside a default of ON turned
 *  it into a reachable abort for every external-agent turn — introduced and
 *  caught inside one session, which is exactly the window a source-level pin is
 *  for.
 *
 *  ⚠ THIS IS A SOURCE-SHAPE ASSERTION, WITH ITS LIMITS STATED. It reads the
 *  composition file rather than driving a turn, because the defect lives in
 *  WIRING, not behaviour — there is nothing to observe until a live recall+fold
 *  coincide. It cannot prove the wiring is correct, only that the two deps are
 *  never named apart. Prefer a behavioural test the day the gateway grows a
 *  turn-state; this is the cheap guard until then. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  join(import.meta.dirname, '..', 'chat-orchestrator.ts'),
  'utf8',
);

/** Every `runChatTurn(` invocation's argument region, sliced to the next call
 *  or end of file. Crude on purpose: the property under test is which
 *  identifiers appear together, not the AST. */
const callSites = (): readonly string[] => {
  const out: string[] = [];
  const re = /runChatTurn\(/g;
  let m: RegExpExecArray | null;
  const starts: number[] = [];
  while ((m = re.exec(SOURCE)) !== null) starts.push(m.index);
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i] as number;
    const end = i + 1 < starts.length ? (starts[i + 1] as number) : SOURCE.length;
    // A call site's deps object is well inside 400 lines of its opening.
    out.push(SOURCE.slice(start, Math.min(end, start + 20000)));
  }
  return out;
};

describe('rolling brief + recall signal are wired as a pair', () => {
  it('finds the runChatTurn call sites at all', () => {
    // Guards the guard: a rename that broke the scan would otherwise make every
    // assertion below vacuously true.
    expect(callSites().length).toBeGreaterThanOrEqual(2);
  });

  it('no call site enables the brief without the authoritative recall signal', () => {
    for (const site of callSites()) {
      // ⛔ Only a REAL wiring counts. The gateway carries the identifier inside
      //    a comment explaining why it is absent, so match the property form.
      const enables = /^\s*rollingBriefEnabled:/m.test(site);
      if (!enables) continue;
      expect(/^\s*hasRegisteredRecall:/m.test(site)).toBe(true);
    }
  });

  it('at least one call site DOES enable it — the pin is not vacuous', () => {
    const enabling = callSites().filter((s) =>
      /^\s*rollingBriefEnabled:/m.test(s),
    );
    expect(enabling.length).toBeGreaterThanOrEqual(1);
  });
});
