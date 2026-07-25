/** D-149 § A.5 + § Must Hold I-12 — reception submission drain backbone.
 *
 *  Reception visitor handlers persist a row (form submission / drop blob /
 *  approval intent / booking request) + return the visitor's success page
 *  SYNCHRONOUSLY — the promised downstream effect (materialize an entity,
 *  fire a recipe, notify) runs AFTER, off the request thread. The spec
 *  names this an "engine reaction via reactive trigger (D-115) on the new
 *  row" and also requires "submission queues for engine catch-up on
 *  restart" (§ A.21). A periodic drain satisfies both: it sweeps pending
 *  rows on a fixed cadence (steady state) and on boot (`fireImmediate` →
 *  restart catch-up), without coupling an `eventBus.emit` into every
 *  visitor handler.
 *
 *  This module is the kind-agnostic backbone. Each submission kind plugs
 *  in a `ReceptionSubmissionProcessor`; Phase 2 registers the intake_form
 *  processor, later phases add drop_link / approval_link / scheduling.
 *
 *  Constraints honoured:
 *    - `IntervalServiceSpec.tick` is SYNC + a throwing tick bubbles to
 *      `setInterval`'s default handler. The tick here kicks off the async
 *      drain fire-and-forget, guards against overlap (a slow drain never
 *      runs concurrently with itself), and swallows all errors.
 *    - Per-processor failures are isolated: one processor throwing does
 *      not skip the others in the same tick. */

import type { BackgroundServiceRegistry } from '../../composition/bin/wire-background-services.js';

/** Default cadence — responsive enough that a form submission becomes a
 *  task within seconds, infrequent enough that enumerating the handful of
 *  reception endpoints per tick is negligible. */
export const RECEPTION_DRAIN_INTERVAL_MS = 15_000;

/** Per-processor per-tick row budget. Bounds the work a single tick does
 *  so a backlog drains across several ticks rather than blocking one tick
 *  for a long time. */
export const RECEPTION_DRAIN_BATCH_LIMIT = 50;

export interface ReceptionDrainTickInput {
  readonly now: number;
  readonly limit: number;
}

export interface ReceptionDrainResult {
  readonly processed: number;
  readonly failed: number;
}

/** A per-kind submission processor. `drainOnce` consumes up to `limit`
 *  pending rows and returns counts for diagnostics. It MUST be safe to
 *  call repeatedly (idempotent on already-drained rows — it only reads
 *  rows still in the `pending` outcome). */
export interface ReceptionSubmissionProcessor {
  /** Stable label for diagnostics / drain logs (e.g. `'intake_form'`). */
  readonly label: string;
  drainOnce(input: ReceptionDrainTickInput): Promise<ReceptionDrainResult>;
}

/** D-173 P3 § A.7 — the review-then-approve dispatch seam (the SINGLE path).
 *
 *  Reframes the drain from an *auto-materializer* into the *intake →
 *  review-then-approve* dispatch step. For a REVIEW-mode endpoint (the
 *  default — D3) the drain processor hands a pending submission's
 *  projection-shaped payload to this seam, which fires the kind's compiled
 *  `review-then-approve` recipe (D-170 N.18) with `context.event.payload =
 *  payload`. The recipe's materialize op is `approval_required`, so the
 *  D-157 gate HOLDS it pending → the Reception Inbox shows it → the user
 *  approves (editing the args) or rejects. The processor itself NEVER
 *  materializes in review mode (no ambient warehouse write — I-1).
 *
 *  ⛔ D-210 Phase C — this is now the ONLY path. The `auto_accept` pre-grant,
 *  which materialized straight through the local projection without ever
 *  parking at the gate, was RETIRED (owner ruling, 2026-07-18) on all three
 *  reception kinds at once.
 *
 *  Injected (not constructed in the processor) so the boot wire binds it to
 *  the per-kind compiled recipe id + the live `handleExecute`; absent (boot
 *  phase before the engine composes, or a deployment that never installed the
 *  reception core-pack) the processor leaves the row pending so it dispatches
 *  once the seam lands — it MUST NOT materialize as a fallback (that would
 *  bypass review). */
export interface ReceptionWorkflowDispatch {
  /** The reception kind (`'intake_form'` / `'approval_link'` /
   *  `'scheduling_link'` / `'drop_link'`) — selects the compiled recipe at the
   *  boot-wire binding site. */
  readonly kind: 'intake_form' | 'approval_link' | 'scheduling_link' | 'drop_link';
  /** The projection-shaped trigger payload — the shape the reception
   *  projection consumes (`{ top_tier_kind, id, title, body?, metadata?,
   *  source_id?, ... }`). Forwarded verbatim as `context.event.payload`; the
   *  compiled recipe's gated step carries `args: '{{context.event.payload}}'`. */
  readonly payload: Record<string, unknown>;
  /** A stable provenance ref for the originating reception row (the
   *  `submission_id` / `intent_id`) — feeds the synthetic run anchor's
   *  identity so a re-dispatch is traceable. */
  readonly source_ref: string;
  /** The originating endpoint id (provenance). */
  readonly endpoint_id: string;
}

/** Fire a review-then-approve workflow for one pending reception row.
 *  Returns `{ dispatched: true }` when the seam fired the compiled recipe
 *  (the row may then be marked `processed` — handed off), or
 *  `{ dispatched: false }` when no compiled recipe is wired for the kind
 *  (the row stays pending to retry once the recipe installs). NEVER throws
 *  the drain down — a dispatch failure surfaces as `dispatched: false`
 *  (the processor leaves the row pending) or is swallowed by the seam. */
export type FireReceptionWorkflow = (
  dispatch: ReceptionWorkflowDispatch,
) => Promise<{ dispatched: boolean }>;

/** The schedulable core of the drain, decoupled from the timer + registry
 *  so it is directly unit-testable. `tick` is the sync fire-and-forget body
 *  (overlap-guarded); `stop` prevents further ticks and AWAITS any in-flight
 *  drain so the caller can gate shutdown on it. */
export interface ReceptionDrainRunner {
  /** Kick off a drain pass unless one is already running or the runner has
   *  been stopped. Returns immediately (the work runs detached). */
  tick(): void;
  /** Stop accepting new ticks + resolve once the in-flight drain (if any)
   *  has settled. Idempotent. */
  stop(): Promise<void>;
}

export interface CreateReceptionDrainRunnerDeps {
  readonly processors: ReadonlyArray<ReceptionSubmissionProcessor>;
  readonly now: () => number;
  readonly batchLimit?: number;
}

/** Build the drain runner. The overlap guard tracks the in-flight promise
 *  (not just a boolean) so `stop` can await it — double-processing is also
 *  prevented at the row level by the `pending`→`processed`/`failed` flip,
 *  but skipping re-entry avoids redundant work + log noise. */
export const createReceptionDrainRunner = (
  deps: CreateReceptionDrainRunnerDeps,
): ReceptionDrainRunner => {
  const batchLimit = deps.batchLimit ?? RECEPTION_DRAIN_BATCH_LIMIT;
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  const runDrain = async (): Promise<void> => {
    for (const processor of deps.processors) {
      try {
        await processor.drainOnce({ now: deps.now(), limit: batchLimit });
      } catch (e) {
        console.warn(`[d-149] reception drain '${processor.label}' tick failed`, e);
      }
    }
  };

  return {
    tick: () => {
      if (stopped || inFlight) return;
      inFlight = runDrain().finally(() => {
        inFlight = null;
      });
    },
    stop: async () => {
      stopped = true;
      if (inFlight) {
        // Errors are already swallowed inside runDrain; guard anyway so a
        // stop never rejects.
        try {
          await inFlight;
        } catch {
          /* unreachable — runDrain swallows */
        }
      }
    },
  };
};

export interface RegisterReceptionDrainDeps {
  readonly backgroundServices: BackgroundServiceRegistry;
  readonly processors: ReadonlyArray<ReceptionSubmissionProcessor>;
  readonly now: () => number;
  /** Override the 15s default (tests pin a fast cadence; never used in prod). */
  readonly intervalMs?: number;
  readonly batchLimit?: number;
}

/** Register the single `reception-drain` background timer. No-op when no
 *  processors are wired (boot phase before the stores are composed) so the
 *  timer registry stays clean.
 *
 *  Registered via `register({ kind: 'timer', stop })` rather than
 *  `registerInterval` because the stop hook must be ASYNC: at shutdown the
 *  lifecycle's `stop_timers` step (which runs before `close_db`) awaits each
 *  service's `stop`, so awaiting the in-flight drain here guarantees a tick
 *  that's mid-decrypt/write finishes (or settles) before the DB closes
 *  underneath it. The timer is `unref`'d so it never keeps the loop alive. */
export const registerReceptionDrain = (deps: RegisterReceptionDrainDeps): void => {
  if (deps.processors.length === 0) return;
  const intervalMs = deps.intervalMs ?? RECEPTION_DRAIN_INTERVAL_MS;
  const runner = createReceptionDrainRunner({
    processors: deps.processors,
    now: deps.now,
    ...(deps.batchLimit !== undefined ? { batchLimit: deps.batchLimit } : {}),
  });

  const handle = setInterval(() => runner.tick(), intervalMs);
  (handle as { unref?: () => void }).unref?.();
  // Sweep once at boot so pending rows that arrived before a restart (or
  // while the engine was down) drain without waiting a full cycle.
  runner.tick();

  deps.backgroundServices.register({
    name: 'reception-drain',
    kind: 'timer',
    stop: async () => {
      clearInterval(handle);
      await runner.stop();
    },
  });
};
