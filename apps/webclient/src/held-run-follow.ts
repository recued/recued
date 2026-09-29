/** A held run, followed to its end, so the page that was told "held" shows what
 * the run did.
 *
 * A run the owner starts from a page and that stops at an approval answers
 * "held". The approval is given somewhere else — the attention tray, another
 * device — and the run finishes on the server. The page never heard: it kept
 * "held for approval", and the recipe's own result card was never seen on that
 * path.
 *
 * This follows one held result. It finds the run behind the result's
 * `action_ref`, wakes on that run's events, and reads the result the server
 * kept for the page (`execution.get` → `result`). A declined hold has no result;
 * the page is told it was declined. A run held again further on is delivered
 * held and followed on. From a server too old to keep results nothing arrives,
 * and the page keeps its note, as before.
 *
 * ⚠ A run's broadcast `run_id` is not always its audit id — a run without
 * provenance broadcasts an `inflight:` id — so a terminal event for the same
 * recipe wakes the check too. The read itself is keyed by the real id, off the
 * receipt.
 *
 * ⚠ Events wake a read; they are never the answer. The result lands on the
 * server just AFTER the run's terminal event (it is kept once the resume
 * returns), so a read that finds nothing yet asks again a few times. */

import type {
  ExecutionGetResponse,
  GatedActionGetResponse,
  GatedActionStatus,
  ServerExecuteResponse,
} from '@recued/contracts';
import type { BroadcastSubscriber } from './realtime/subscriber.js';

/** Delays between reads after an event, while the answer is not there yet. */
export const HELD_RUN_READ_DELAYS_MS: readonly number[] = [250, 500, 1_000, 2_000, 4_000];
/** A page left open on a hold nobody answers stops following it after this. */
export const HELD_RUN_FOLLOW_MAX_MS = 12 * 60 * 60 * 1_000;

/** Said on the page for a hold that did not go ahead. */
export const HELD_RUN_DECLINED_MESSAGE = 'You declined this, so it did not go ahead.';
export const HELD_RUN_CANCELLED_MESSAGE = 'This was cancelled before it went ahead.';

/** Handed with a later result: the one it replaces. A page shows the later
 *  result only while `replaces` is still the one on screen — an owner who has
 *  moved on is not pulled back. */
export interface LaterRunResult {
  replaces: ServerExecuteResponse;
}

export type HeldRunDelivery = (
  next: ServerExecuteResponse,
  later: LaterRunResult,
) => void;

export interface HeldRunFollowerOptions {
  subscribe: BroadcastSubscriber['on'];
  getAction: (args: { action_ref: string }) => Promise<GatedActionGetResponse>;
  getRun: (args: { run_id: string }) => Promise<ExecutionGetResponse>;
  setTimer?: (handler: () => void, delayMs: number) => { cancel: () => void };
  maxFollowMs?: number;
}

export interface HeldRunFollower {
  /** Follow one result the page was shown. A result that is not held is not
   *  followed. Returns a stop. */
  follow(held: ServerExecuteResponse, deliver: HeldRunDelivery): () => void;
  /** Read every followed run again — after a reconnect, when events were
   *  missed. */
  recheck(): void;
  dispose(): void;
}

interface Followed {
  /** What the page was last handed, and so what the next result replaces. */
  current: ServerExecuteResponse;
  runId: string | null;
  deliver: HeldRunDelivery;
  reading: boolean;
  readAgain: boolean;
  attempt: number;
  timer: { cancel: () => void } | null;
  expiry: { cancel: () => void };
}

const defaultTimer = (handler: () => void, delayMs: number): { cancel: () => void } => {
  const id = setTimeout(handler, delayMs);
  return { cancel: () => clearTimeout(id) };
};

const isHeld = (result: ServerExecuteResponse): boolean =>
  result.awaiting_approval === true
  && typeof result.action_ref === 'string'
  && result.action_ref.length > 0;

/** The page's note for a hold that did not go ahead, in the result's own shape
 *  so every page renders it where the held note was. */
const notGoneAhead = (
  held: ServerExecuteResponse,
  status: Extract<GatedActionStatus, 'denied' | 'cancelled'>,
): ServerExecuteResponse => {
  const ended: ServerExecuteResponse = {
    ...held,
    success: false,
    errors: [{
      message: status === 'denied' ? HELD_RUN_DECLINED_MESSAGE : HELD_RUN_CANCELLED_MESSAGE,
    }],
  };
  delete ended.awaiting_approval;
  delete ended.action_ref;
  return ended;
};

/** The events that can change the answer. A run's `progress` frames can come
 *  many times a second and change nothing a read would find. */
const WAKING_OPS: ReadonlySet<string> = new Set([
  'action_changed',
  'complete',
  'error',
  'cancelled',
  'killed',
  'retired',
]);
const ENDING_OPS: ReadonlySet<string> = new Set(['complete', 'error', 'cancelled', 'killed']);

export const createHeldRunFollower = (
  options: HeldRunFollowerOptions,
): HeldRunFollower => {
  const setTimer = options.setTimer ?? defaultTimer;
  const maxFollowMs = options.maxFollowMs ?? HELD_RUN_FOLLOW_MAX_MS;
  const followed = new Set<Followed>();
  let disposed = false;

  const stop = (entry: Followed): void => {
    if (!followed.delete(entry)) return;
    entry.timer?.cancel();
    entry.timer = null;
    entry.expiry.cancel();
  };

  const readLater = (entry: Followed): void => {
    if (entry.timer !== null || entry.attempt >= HELD_RUN_READ_DELAYS_MS.length) return;
    const delay = HELD_RUN_READ_DELAYS_MS[entry.attempt]!;
    entry.attempt += 1;
    entry.timer = setTimer(() => {
      entry.timer = null;
      void read(entry);
    }, delay);
  };

  /** One read: is the answer there? Wakes are coalesced — a wake during a read
   *  runs one more read after it. */
  const read = async (entry: Followed): Promise<void> => {
    if (disposed || !followed.has(entry) || entry.runId === null) return;
    if (entry.reading) {
      entry.readAgain = true;
      return;
    }
    entry.reading = true;
    try {
      const shown = entry.current;
      const run = await options.getRun({ run_id: entry.runId });
      if (!followed.has(entry) || entry.current !== shown) return;
      const result = run.result;
      if (result !== undefined && !(isHeld(result) && result.action_ref === shown.action_ref)) {
        entry.deliver(result, { replaces: shown });
        if (isHeld(result)) {
          // Held again further on: follow the new hold from here.
          entry.current = result;
          entry.attempt = 0;
        } else {
          stop(entry);
        }
        return;
      }
      const action = await options.getAction({ action_ref: shown.action_ref! });
      if (!followed.has(entry) || entry.current !== shown) return;
      const status = action.receipt.status;
      if (status === 'awaiting_approval') return;
      if (status === 'denied' || status === 'cancelled') {
        entry.deliver(notGoneAhead(shown, status), { replaces: shown });
        stop(entry);
        return;
      }
      // Answered and moving, or finished a moment ago: the result is kept just
      // after the run's own events, so ask again shortly.
      readLater(entry);
    } catch {
      // A failed read is not an answer. The next event, a reconnect, or the
      // next scheduled read asks again.
      readLater(entry);
    } finally {
      entry.reading = false;
      if (entry.readAgain) {
        entry.readAgain = false;
        void read(entry);
      }
    }
  };

  /** An event, a reconnect or the start: a fresh run of reads. */
  const wake = (entry: Followed): void => {
    entry.attempt = 0;
    entry.timer?.cancel();
    entry.timer = null;
    void read(entry);
  };

  const unsubscribe = options.subscribe('execution', (event) => {
    if (disposed) return;
    if (!WAKING_OPS.has(event.op)) return;
    for (const entry of [...followed]) {
      if (entry.runId === null) continue;
      const sameRun = event.run_id === entry.runId;
      const sameRecipeEnded = event.recipe_id === entry.current.recipe_id
        && ENDING_OPS.has(event.op);
      if (sameRun || sameRecipeEnded) wake(entry);
    }
  });

  return {
    follow(held, deliver) {
      if (disposed || !isHeld(held)) return () => {};
      const entry: Followed = {
        current: held,
        runId: null,
        deliver,
        reading: false,
        readAgain: false,
        attempt: 0,
        timer: null,
        expiry: { cancel: () => {} },
      };
      entry.expiry = setTimer(() => stop(entry), maxFollowMs);
      followed.add(entry);
      void options.getAction({ action_ref: held.action_ref! })
        .then((action) => {
          if (disposed || !followed.has(entry)) return;
          entry.runId = action.receipt.run_id;
          // It may have been answered already, before this page was listening.
          if (action.receipt.status !== 'awaiting_approval') wake(entry);
        })
        .catch(() => {
          // No receipt to follow (a server without receipts): nothing will
          // ever wake this, so let it go now.
          stop(entry);
        });
      return () => stop(entry);
    },
    recheck() {
      if (disposed) return;
      for (const entry of [...followed]) {
        if (entry.runId !== null) wake(entry);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const entry of [...followed]) stop(entry);
    },
  };
};
