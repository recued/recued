/** D-116 — Timing transforms.
 *
 *  `wait` is the only member so far: an async Tier 1 transform that
 *  pauses for `ms` milliseconds and writes `{ waited_ms }` to
 *  `step.{id}`. Downstream steps can attest the pause occurred, which
 *  helps when debugging long chains.
 *
 *  Async is deliberate — the engine awaits transform results (see
 *  `step-runner.ts`), so returning a Promise is safe. The validator
 *  enforces `ms <= WAIT_TRANSFORM_MAX_MS` before the recipe even
 *  reaches the engine.
 *
 *  Budget treatment: same as D-094 approval waits. `wait` informs the
 *  engine via `ctx.extendBudget(ms)` before sleeping; the engine
 *  extends its wall-clock timer by that amount so a deliberate pause
 *  doesn't count toward `metadata.budget_ms`. Hosts that don't enforce
 *  a budget simply omit `extendBudget` and the transform still works.
 */

import type { TransformFn } from './types.js';

export const wait: TransformFn = async (p, c) => {
  const ms = Number(p.ms);
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error('wait: ms must be a non-negative finite number');
  }
  c.extendBudget?.(ms);
  if (ms > 0) {
    await new Promise<void>((r) => setTimeout(r, ms));
  }
  return { waited_ms: ms };
};
