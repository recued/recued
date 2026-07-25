/** D-113 — Gossip view plane.
 *
 *  The data plane (`data-plane.ts`) holds the raw gossip state —
 *  everything we exchange across heartbeats. The view plane derives
 *  presentation-layer shapes from that state for the UI:
 *
 *   - **Pending projection** — what the user sees in the "pending
 *     approvals" card. A pending with a matching action is visually
 *     resolved and drops from the card immediately, even though the
 *     data plane may still carry the pair for stakeholder
 *     propagation (see §observer-stakeholder in the spec).
 *
 *   - **Recent-resolved tracker** — event-driven side-panel ("last
 *     resolved in the last 5 min") decoupled from gossip TTL. When
 *     the data plane emits a `newly_resolved`, the view plane
 *     records it with its own RECENT_RESOLVED_WINDOW_EXT_MS
 *     expiry, so the UI shows recent activity long after the pair
 *     has dropped from gossip.
 *
 *  Pure presentation. No subscriptions, no rendering — that's for
 *  the extension / server UI modules that wrap this.
 */

import {
  RECENT_RESOLVED_WINDOW_EXT_MS,
  type ApprovalPendingRecord,
  type ApprovalResolutionRecord,
} from '@recued/contracts';
import type { LocalApprovalState } from './data-plane.js';

// ── Pending projection ──────────────────────────────────────────

/** Return pendings the user should see in the "pending" card.
 *  Matched pairs are hidden from the projection even though the
 *  data plane may still carry them for PAIR_TTL. */
export const visiblePendings = (
  state: LocalApprovalState,
): ApprovalPendingRecord[] => {
  const out: ApprovalPendingRecord[] = [];
  for (const [id, pending] of state.pending) {
    const actions = state.action.get(id);
    if (actions && actions.length > 0) continue;  // matched → hidden
    out.push(pending);
  }
  return out;
};

// ── Recent-resolved tracker ─────────────────────────────────────

/** Per-approval entry retained for the recent-resolved pane. */
export interface RecentResolvedEntry {
  approval_id: string;
  pending: ApprovalPendingRecord;
  effective: ApprovalResolutionRecord;
  /** Epoch ms when this entry was registered — the window timer
   *  uses this (not the underlying resolution.resolved_at) so peers
   *  that observe a resolution late still show it for the full
   *  RECENT_RESOLVED_WINDOW_EXT_MS. */
  registered_at: number;
}

export interface RecentResolvedTracker {
  /** Register a newly-resolved pair. Idempotent — a second call for
   *  the same approval_id overwrites the prior entry (newer effective
   *  wins, e.g. if the tiebreaker changes after more peers gossip in). */
  add(
    pending: ApprovalPendingRecord,
    effective: ApprovalResolutionRecord,
    now: number,
  ): void;
  /** List current entries whose registered_at is within
   *  RECENT_RESOLVED_WINDOW_EXT_MS of `now`. Filters by the `now`
   *  the caller passes so the tracker stays stateless on clock. */
  list(now: number): RecentResolvedEntry[];
  /** Drop expired entries. Callers typically invoke this when
   *  rebuilding the UI or on a cadence timer; not called by `list`
   *  itself so listing is a pure read. */
  sweep(now: number): number;
  /** Drop everything — used when the user changes identity or the
   *  paired server flips. */
  clear(): void;
}

export const createRecentResolvedTracker = (): RecentResolvedTracker => {
  const entries = new Map<string, RecentResolvedEntry>();
  return {
    add(pending, effective, now) {
      entries.set(pending.approval_id, {
        approval_id: pending.approval_id,
        pending,
        effective,
        registered_at: now,
      });
    },
    list(now) {
      const out: RecentResolvedEntry[] = [];
      for (const entry of entries.values()) {
        if (now - entry.registered_at > RECENT_RESOLVED_WINDOW_EXT_MS) continue;
        out.push(entry);
      }
      // Newest first — matches what the UI typically wants to render.
      return out.sort((a, b) => b.registered_at - a.registered_at);
    },
    sweep(now) {
      let removed = 0;
      for (const [id, entry] of entries) {
        if (now - entry.registered_at > RECENT_RESOLVED_WINDOW_EXT_MS) {
          entries.delete(id);
          removed++;
        }
      }
      return removed;
    },
    clear() {
      entries.clear();
    },
  };
};
