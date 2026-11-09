/** D-148 § A.3.2 — FIFO queue with bounded depth + backpressure.
 *
 *  The bridge executes commands strictly in receipt order. No
 *  parallelism — DOM operations against the same browser session race
 *  in non-obvious ways across tabs of the same origin, so serial
 *  execution makes idempotency reasoning tractable.
 *
 *  Bound at `BRIDGE_MAX_QUEUE_DEPTH = 32`. Overflow returns 429 to
 *  the server; the server-side dispatch scheduler retries with
 *  exponential backoff (200 ms initial, doubling to 5 s max).
 *
 *  Pure data structure — no chrome.* dependencies, fully unit
 *  testable.
 */

import {
  BRIDGE_MAX_QUEUE_DEPTH,
  type BridgeCommand,
} from '@recued/contracts';

export type EnqueueOutcome =
  | { ok: true; depth: number }
  | { ok: false; reason: 'queue_full'; depth: number; max: number };

export interface FifoQueueState {
  current_command_id: string | null;
  pending: BridgeCommand[];
  paused: boolean;
}

export interface BridgeFifoQueue {
  /** Push to the tail. Returns 429-shaped outcome on overflow. */
  enqueue(command: BridgeCommand): EnqueueOutcome;
  /** Drop the next command and mark it as the running one. Returns
   *  null when queue empty or paused. */
  dequeue(): BridgeCommand | null;
  /** Mark the running command done — clears `current_command_id`. */
  complete(command_id: string): void;
  /** Best-effort cancel. If the command_id is currently executing,
   *  returns `running` so the caller can flip the cooperative-cancel
   *  flag. If queued, removes from the queue and returns `dropped`.
   *  If unknown, returns `unknown`. */
  cancel(command_id: string): 'running' | 'dropped' | 'unknown';
  /** Snapshot for telemetry / popup-inspector / server visibility. */
  state(): FifoQueueState;
  /** Toggle pause — queued commands stay queued; in-flight command
   *  completes. */
  setPaused(paused: boolean): void;
  /** Wipe all queued commands (disconnect-bridge flow). */
  clear(): void;
  /** Current depth (queued; excludes running). */
  depth(): number;
  /** Max depth (constant from spec). */
  maxDepth(): number;
}

export const createFifoQueue = (
  options: { max_depth?: number } = {},
): BridgeFifoQueue => {
  const max = options.max_depth ?? BRIDGE_MAX_QUEUE_DEPTH;
  let pending: BridgeCommand[] = [];
  let current: string | null = null;
  let paused = false;

  return {
    enqueue(command) {
      if (pending.length >= max) {
        return { ok: false, reason: 'queue_full', depth: pending.length, max };
      }
      pending.push(command);
      return { ok: true, depth: pending.length };
    },
    dequeue() {
      if (paused) return null;
      if (current !== null) return null;
      const next = pending.shift();
      if (!next) return null;
      current = next.command_id;
      return next;
    },
    complete(command_id) {
      if (current === command_id) {
        current = null;
      }
    },
    cancel(command_id) {
      if (current === command_id) return 'running';
      const idx = pending.findIndex((c) => c.command_id === command_id);
      if (idx >= 0) {
        pending.splice(idx, 1);
        return 'dropped';
      }
      return 'unknown';
    },
    state() {
      return {
        current_command_id: current,
        pending: [...pending],
        paused,
      };
    },
    setPaused(next) {
      paused = next;
    },
    clear() {
      pending = [];
    },
    depth() {
      return pending.length;
    },
    maxDepth() {
      return max;
    },
  };
};
