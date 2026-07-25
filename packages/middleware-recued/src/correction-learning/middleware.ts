/** D-160 P2 — the `correction-learning` stream-middleware adapter (§ P2).
 *
 *  Registers the D-145 PB14 Correction Learning hooks as a D-160 stream
 *  middleware. Lifecycle footprint: `prompt` (`before-turn`) — § B.14.3
 *  step 3 is "AI synthesis prompt augmentation", a pre-AI-call hook. The
 *  adapter runs `buildCorrectionSummary` (pure, no AI call) over the
 *  recent correction stream and contributes the flat aggregate summary
 *  to the turn's prompt draft.
 *
 *  Scaffold scope (D-160 P2): the per-pair `CorrectionEventRow[]`
 *  snapshot rides `ctx.state` (`CORRECTION_LEARNING_EVENTS_STATE_KEY`).
 *  A future producer / the deferred D-137-chat refactor (D-160 O-5)
 *  threads `listRecentCorrectionEvents()` in; absent one the hook is a
 *  faithful no-op (the correction stream is per-pair state the
 *  framework cannot synthesize).
 *
 *  Spec: docs/d-160-spec.md § P2.
 */

import type { Middleware, TurnContext } from '@recued/middleware';

import { buildCorrectionSummary, type CorrectionEventRow } from './index.js';

/** `ctx.state` key — the per-pair `CorrectionEventRow[]` snapshot (with
 *  an optional `now` override for deterministic recency windows). */
export const CORRECTION_LEARNING_EVENTS_STATE_KEY = 'correction-learning:events';
/** `ctx.state` key — where the adapter writes the `CorrectionSummary`. */
export const CORRECTION_LEARNING_SUMMARY_STATE_KEY = 'correction-learning:summary';

/** The `ctx.state` snapshot the adapter consumes. */
interface CorrectionLearningSnapshot {
  readonly rows: readonly CorrectionEventRow[];
  /** Wallclock override (Unix ms) for the recency window — defaults to
   *  `Date.now()`. Producers / tests pin it for determinism. */
  readonly now?: number;
}

/** Read the correction snapshot off `ctx.state`. Requires a `rows`
 *  array; anything else (or an absent key) yields `undefined` and the
 *  hook no-ops. */
const readSnapshot = (
  state: TurnContext['state'],
): CorrectionLearningSnapshot | undefined => {
  const raw = state.get(CORRECTION_LEARNING_EVENTS_STATE_KEY);
  if (raw === null || typeof raw !== 'object') return undefined;
  const snapshot = raw as { rows?: unknown };
  if (!Array.isArray(snapshot.rows)) return undefined;
  return raw as CorrectionLearningSnapshot;
};

/** The `correction-learning` middleware — registers enabled (D-160 P2). */
export const correctionLearningMiddleware: Middleware = {
  id: 'correction-learning',
  prompt(ctx: TurnContext): void {
    const snapshot = readSnapshot(ctx.state);
    if (snapshot === undefined) return; // faithful no-op — no snapshot
    const summary = buildCorrectionSummary({
      rows: snapshot.rows,
      now: snapshot.now ?? Date.now(),
    });
    ctx.state.set(CORRECTION_LEARNING_SUMMARY_STATE_KEY, summary);
    const counts = Object.entries(summary as Record<string, number>);
    if (counts.length > 0) {
      ctx.prompt.contribute({
        role: 'context',
        text: `recent corrections — ${counts
          .map(([key, count]) => `${key}=${count}`)
          .join(', ')}`,
      });
    }
  },
};
