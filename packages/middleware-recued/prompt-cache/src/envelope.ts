import type { EnvelopeId } from './types.js';

/** Default intent-burst window in milliseconds (60 seconds). */
export const DEFAULT_INTENT_BURST_MS = 60_000;

/** Default retention window for CLOSED envelopes (5 minutes). A close
 *  stays readable this long for late `request_end` correlation, then is
 *  evicted so a long-lived per-stream store stays bounded. Aligns with
 *  the AI cache-TTL floor (`MIN_TTL.ai = 300s`). */
export const DEFAULT_CLOSED_RETENTION_MS = 5 * 60_000;

/** In-flight envelope state. */
export interface EnvelopeState {
  readonly id: EnvelopeId;
  readonly prompt: string;
  readonly opened_at: number;
  closed_at?: number;
  result?: string;
}

export class EnvelopeStore {
  // Closed envelopes are pruned by `evictClosedEnvelopes` (retention
  // window) so the per-stream store stays bounded over its lifetime.
  private readonly map = new Map<EnvelopeId, EnvelopeState>();

  /** Opens a new envelope. Throws if id is already open. */
  openEnvelope(id: EnvelopeId, prompt: string, now: number): void {
    if (this.map.has(id)) {
      throw new Error(`EnvelopeStore: envelope already open: ${id}`);
    }
    this.map.set(id, { id, prompt, opened_at: now });
  }

  /** Closes an envelope with an optional result. Idempotent — re-close is a no-op. */
  closeEnvelope(id: EnvelopeId, result: string | undefined, now: number): void {
    const state = this.map.get(id);
    if (!state || state.closed_at !== undefined) return;
    state.closed_at = now;
    state.result = result;
  }

  /** Returns the envelope state or undefined if not found. */
  getEnvelope(id: EnvelopeId): EnvelopeState | undefined {
    return this.map.get(id);
  }

  /** Closes any envelope older than intent_burst_ms that is still open.
   *  Returns the list of swept envelope ids. */
  sweepDanglingEnvelopes(
    now: number,
    intent_burst_ms: number = DEFAULT_INTENT_BURST_MS,
  ): EnvelopeId[] {
    const swept: EnvelopeId[] = [];
    for (const state of this.map.values()) {
      if (state.closed_at === undefined && now - state.opened_at > intent_burst_ms) {
        state.closed_at = now;
        swept.push(state.id);
      }
    }
    return swept;
  }

  /** Evicts CLOSED envelopes whose close is older than retention_ms,
   *  freeing the store so a long-lived per-stream lifetime stays
   *  bounded. Open envelopes are never evicted here — the dangling
   *  sweep closes stale-open ones first. Returns the evicted ids; an
   *  evicted id may be re-opened afterward. */
  evictClosedEnvelopes(
    now: number,
    retention_ms: number = DEFAULT_CLOSED_RETENTION_MS,
  ): EnvelopeId[] {
    const evicted: EnvelopeId[] = [];
    for (const [id, state] of this.map) {
      if (
        state.closed_at !== undefined &&
        now - state.closed_at > retention_ms
      ) {
        this.map.delete(id);
        evicted.push(id);
      }
    }
    return evicted;
  }
}
