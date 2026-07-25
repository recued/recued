/** D-164 P4c — intention router public surface.
 *
 *  Composes `detectAnaphora` (over the latest user message) and
 *  `findReferentCandidate` (over the conversation history). When an
 *  anaphor matches, `attach` writes an `IntentionResult` to
 *  `ctx.state` keyed by `INTENTION_RESULT_STATE_KEY`. Absent any
 *  anaphor the function is a faithful no-op — the router writes
 *  nothing and the deterministic gate / catalog assembly proceed
 *  unchanged.
 *
 *  The router is "barely more than a context-attachment helper"
 *  (design § 2). It does NOT resolve the entity — that's P4d's NER
 *  pass. It only narrows the work: which span of history NER should
 *  scan, given the anaphor at hand.
 *
 *  See: D-164 § 2.
 */

import type { TurnContext } from '@recued/middleware';

import { detectAnaphora, type AnaphoraSignal } from './anaphora.js';
import {
  findReferentCandidate,
  type ReferentCandidate,
} from './session-attach.js';

export { detectAnaphora, type AnaphoraKind, type AnaphoraSignal } from './anaphora.js';
export { findReferentCandidate, type ReferentCandidate } from './session-attach.js';

/** `ctx.state` key the router writes its result under. Stable string;
 *  downstream gate / NER reads this exact key. */
export const INTENTION_RESULT_STATE_KEY = 'prompt-cache:intention';

/** What the router records when an anaphor is detected. `referent` is
 *  `null` when the history has no assistant turn yet — the gate then
 *  knows there's nothing in-session to attach to and falls through to
 *  cross-session memory recall (LLM-driven, design § 2 / § 4). */
export interface IntentionResult {
  readonly signal: AnaphoraSignal;
  readonly referent: ReferentCandidate | null;
}

/** Extract the latest user-authored text from the turn's history. The
 *  framework records the inbound user message before the stream runs
 *  (per D-160 N.5), so the history's tail is the message this turn is
 *  decoding. An empty string is the no-history guard. */
const latestUserText = (history: TurnContext['history']): string => {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.role === 'user') return entry.text;
  }
  return '';
};

/** Attach session intention to the turn context.
 *
 *  - Runs `detectAnaphora` over the latest user text.
 *  - If no anaphor matches, *clears* `INTENTION_RESULT_STATE_KEY`
 *    from `ctx.state` and returns. The clear is load-bearing:
 *    `ctx.state` is stream-scoped (D-160 `TurnContext.state`), so a
 *    prior turn's intention would otherwise leak into a later
 *    non-anaphoric turn and the gate orchestrator (P4e) would read a
 *    stale referent.
 *  - Otherwise, runs `findReferentCandidate` over the full history
 *    and writes `{ signal, referent }` to
 *    `ctx.state[INTENTION_RESULT_STATE_KEY]`.
 *
 *  The post-condition is: after `attach` returns, the key is present
 *  iff this turn carries anaphora. Downstream readers can treat the
 *  key's presence as "current-turn signal" without checking turn ids.
 *
 *  Idempotent: re-running over the same context overwrites (or
 *  re-clears) the same key with the same result (deterministic
 *  inputs → deterministic output). */
export const attach = (ctx: TurnContext): void => {
  const userText = latestUserText(ctx.history);
  const signal = detectAnaphora(userText);
  if (signal === null) {
    ctx.state.delete(INTENTION_RESULT_STATE_KEY);
    return;
  }
  const referent = findReferentCandidate(ctx.history);
  const result: IntentionResult = { signal, referent };
  ctx.state.set(INTENTION_RESULT_STATE_KEY, result);
};
