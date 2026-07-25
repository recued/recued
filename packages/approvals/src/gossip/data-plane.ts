/** D-113 — Approval gossip data plane.
 *
 *  Pure-logic module. No network, no clocks, no storage — everything
 *  takes (local, remote, self, now) and returns deterministic output.
 *  Wired into the heartbeat loop on each side (extension, server):
 *  callers encrypt local.pending + local.action into the next
 *  heartbeat contribution; worker aggregates; callers decrypt incoming
 *  composites + merge here.
 *
 *  Three core responsibilities:
 *
 *  1. **Merge + match.** On each heartbeat round, merge incoming
 *     pending + action records into local state. For each approval_id
 *     with both a pending and at least one resolution, compute the
 *     effective resolution via a deterministic tiebreaker
 *     (`pickEffective`). Every peer applies the same sort, so every
 *     peer picks the same winner — executor resumes exactly once on
 *     the initiator.
 *
 *  2. **Observer vs stakeholder propagation.** When a matched pair
 *     is observed, peers that are stakeholders (initiator OR action
 *     creator) keep carrying the pair in gossip for PAIR_TTL_MS so
 *     other peers converge; pure observers pop immediately.
 *
 *  3. **TTL sweeps.** Unmatched items drop at ITEM_TTL_MS or
 *     timeout_at (whichever is sooner). Matched pairs drop at
 *     PAIR_TTL_MS. Timeout detection — when a pending outlives its
 *     timeout_at with no action — emits an `executor_timeout`
 *     resolution so the executor side resumes with the chosen
 *     on_timeout policy.
 *
 *  Adoption flow for worker-brokered actions (slash commands, email
 *  link clicks) lives here too: the composition root calls
 *  `adoptWorkerDispatch` on each targeted WorkerDispatch, which
 *  produces a `user_action` resolution record under this peer's
 *  instance id. That record then flows into local.action and rides
 *  the next heartbeat outbound — no ACK, no retry, tiebreaker handles
 *  duplicate dispatches cleanly.
 */

import {
  PAIR_TTL_MS,
  ITEM_TTL_MS,
  OWNER_GRACE_WINDOW_MS,
  type ApprovalPendingRecord,
  type ApprovalResolutionRecord,
  type WorkerDispatch,
  type ApprovalActionPayload,
} from '@recued/contracts';

// ── Local state shape ────────────────────────────────────────────

/** Per-instance in-memory state. `pending` is 1:1 on approval_id;
 *  `action` is 1:many because peers may emit duplicate user_action
 *  records (e.g., both Slack and email click before the gossip
 *  round converges). The tiebreaker picks one effective resolution
 *  from the set. */
export interface LocalApprovalState {
  pending: Map<string, ApprovalPendingRecord>;
  action: Map<string, ApprovalResolutionRecord[]>;
}

export const createLocalState = (): LocalApprovalState => ({
  pending: new Map(),
  action: new Map(),
});

// ── Merge + match ────────────────────────────────────────────────

export interface RemoteContribution {
  pending: ApprovalPendingRecord[];
  action: ApprovalResolutionRecord[];
}

export interface MergeResult {
  state: LocalApprovalState;
  /** Approval IDs that transitioned from "pending, no action" to
   *  "matched" during this merge. Callers fan these out:
   *   - Initiator: resume executor with `effective.effective_decision`.
   *   - Any peer: update UI view / chat message if owning handle. */
  newly_resolved: Array<{
    approval_id: string;
    pending: ApprovalPendingRecord;
    effective: ApprovalResolutionRecord;
  }>;
  /** Approval IDs evicted during this merge (by TTL or observer rule). */
  popped: string[];
}

export interface MergeDeps {
  self: { instance_id: string };
  now: number;
}

/** Merge a remote contribution into local state. Returns the updated
 *  state plus a summary of newly-resolved and evicted approvals so
 *  the caller can drive UI + executor events off the same pass. */
export const mergeRemote = (
  local: LocalApprovalState,
  remote: RemoteContribution,
  deps: MergeDeps,
): MergeResult => {
  const next: LocalApprovalState = {
    pending: new Map(local.pending),
    action: new Map(local.action),
  };
  const previouslyMatched = new Set<string>();
  for (const [id, actions] of next.action) {
    if (actions.length > 0 && next.pending.has(id)) {
      previouslyMatched.add(id);
    }
  }

  // 1. Merge pending — last-write-wins by created_at; ties favour the
  //    incoming record (newer peer view is more likely fresh).
  for (const p of remote.pending) {
    const existing = next.pending.get(p.approval_id);
    if (!existing || p.created_at >= existing.created_at) {
      // Merge channel_handles — additive across peers (each chat
      // adapter contributes its own handle after posting).
      next.pending.set(p.approval_id, mergeChannelHandles(existing, p));
    }
  }

  // 2. Merge action — append if not already present (dedupe by
  //    created_by_instance + resolved_at + decision; exact matches
  //    are treated as the same emission from a re-observed blob).
  for (const a of remote.action) {
    const bucket = next.action.get(a.approval_id) ?? [];
    if (!bucket.some((b) => isSameResolution(b, a))) {
      bucket.push(a);
      next.action.set(a.approval_id, bucket);
    }
  }

  // 3. Identify newly-resolved pairs — pendings now matched that
  //    weren't in previouslyMatched. Compute effective resolution
  //    deterministically.
  const newly_resolved: MergeResult['newly_resolved'] = [];
  for (const [id, pending] of next.pending) {
    const actions = next.action.get(id);
    if (!actions || actions.length === 0) continue;
    if (previouslyMatched.has(id)) continue;
    const effective = pickEffective(actions);
    newly_resolved.push({ approval_id: id, pending, effective });
  }

  // 4. TTL + observer/stakeholder sweep.
  const popped = sweepTtl(next, deps);

  return { state: next, newly_resolved, popped };
};

/** Deterministic tiebreaker — all peers sort identically so everyone
 *  agrees on the winner. Order:
 *   1. earliest resolved_at
 *   2. lexicographically-smallest created_by_instance
 *   3. lexicographically-smallest actor.identifier (empty = '') */
export const pickEffective = (
  matches: readonly ApprovalResolutionRecord[],
): ApprovalResolutionRecord => {
  if (matches.length === 0) {
    throw new Error('pickEffective: empty matches array');
  }
  const sorted = [...matches].sort((a, b) => {
    if (a.resolved_at !== b.resolved_at) return a.resolved_at - b.resolved_at;
    if (a.created_by_instance !== b.created_by_instance) {
      return a.created_by_instance.localeCompare(b.created_by_instance);
    }
    const ai = a.actor?.identifier ?? '';
    const bi = b.actor?.identifier ?? '';
    return ai.localeCompare(bi);
  });
  return sorted[0]!;
};

// ── Observer / stakeholder sweep ─────────────────────────────────

/** Sweep the state for TTL expiry and observer/stakeholder eviction.
 *  Returns the list of approval_ids popped. */
const sweepTtl = (
  state: LocalApprovalState,
  deps: MergeDeps,
): string[] => {
  const popped: string[] = [];
  const selfId = deps.self.instance_id;

  // Pass 1: evaluate matched pairs — stakeholder retains until
  // PAIR_TTL; observer pops immediately on match observation.
  for (const [id, pending] of state.pending) {
    const actions = state.action.get(id);
    if (!actions || actions.length === 0) continue;
    const effective = pickEffective(actions);
    const iAmStakeholder =
      pending.initiator_instance === selfId ||
      actions.some((a) => a.created_by_instance === selfId);
    const pairAge = deps.now - Math.max(pending.created_at, effective.resolved_at);
    if (pairAge > PAIR_TTL_MS) {
      state.pending.delete(id);
      state.action.delete(id);
      popped.push(id);
      continue;
    }
    if (!iAmStakeholder) {
      // Pure observer — we've seen the match, drop from gossip.
      // (UI's recent-resolved tracker picks it up separately.)
      state.pending.delete(id);
      state.action.delete(id);
      popped.push(id);
    }
  }

  // Pass 2: evaluate unmatched pendings — evict at ITEM_TTL_MS or
  // timeout_at (whichever comes first).
  for (const [id, pending] of state.pending) {
    if (state.action.has(id) && (state.action.get(id) ?? []).length > 0) continue;
    const itemAge = deps.now - pending.created_at;
    const pastTimeout = deps.now >= pending.timeout_at;
    if (itemAge > ITEM_TTL_MS || pastTimeout) {
      state.pending.delete(id);
      // Orphan actions (action with no matching pending) get cleaned
      // in pass 3.
      popped.push(id);
    }
  }

  // Pass 3: clean orphan actions — an action arriving before its
  // pending (adoption on one peer + pending gossip from another) is
  // legitimate; keep until ITEM_TTL_MS past the newest contained
  // action's resolved_at so the pending has time to converge. If
  // the pending never arrives, age out.
  for (const [id, actions] of state.action) {
    if (state.pending.has(id)) continue;
    const newest = Math.max(...actions.map((a) => a.resolved_at));
    if (deps.now - newest > ITEM_TTL_MS) {
      state.action.delete(id);
    }
  }

  return popped;
};

// ── Timeout detection ────────────────────────────────────────────

/** Scan for pendings that have outlived their timeout_at with no
 *  matching action. Owner (initiator) emits immediately; peers wait
 *  OWNER_GRACE_WINDOW_MS past timeout_at before taking over.
 *
 *  Returns new `executor_timeout` resolution records to add to
 *  local.action. Caller appends them and they ride the next
 *  heartbeat outbound. */
export const scanForTimeouts = (
  state: LocalApprovalState,
  deps: MergeDeps,
): ApprovalResolutionRecord[] => {
  const out: ApprovalResolutionRecord[] = [];
  const selfId = deps.self.instance_id;

  for (const [id, pending] of state.pending) {
    const existing = state.action.get(id);
    if (existing && existing.length > 0) continue;  // already resolved
    if (deps.now < pending.timeout_at) continue;    // not timed out yet

    const iAmOwner = pending.initiator_instance === selfId;
    const pastGrace = deps.now >= pending.timeout_at + OWNER_GRACE_WINDOW_MS;
    if (!iAmOwner && !pastGrace) continue;  // wait for owner

    out.push({
      approval_id: id,
      created_by_instance: selfId,
      kind: 'executor_timeout',
      resolved_at: pending.timeout_at,
      executor_reason: iAmOwner
        ? 'timeout reached'
        : 'owner silent past grace; peer takeover',
    });
  }

  return out;
};

// ── Timeout policy ───────────────────────────────────────────────

/** Apply the recipe's on_timeout policy to a raw executor_timeout
 *  resolution. Called by the executor on the initiator side to
 *  decide how the step resolves: fail (reject), approve, or reject.
 *  'approve' and 'reject' mirror the user-action decisions; 'fail'
 *  maps to 'expired' so callers can distinguish timeout-failure
 *  from user-rejection. */
export const applyTimeoutPolicy = (
  on_timeout: 'fail' | 'approve' | 'reject',
): 'approve' | 'reject' | 'expired' => {
  switch (on_timeout) {
    case 'approve': return 'approve';
    case 'reject':  return 'reject';
    case 'fail':    return 'expired';
  }
};

/** Compute the final effective_decision field for a resolution record.
 *  Unifies user_action.decision with executor_* kind mapping, plus the
 *  timeout-policy override when kind === 'executor_timeout'. */
export const computeEffectiveDecision = (
  resolution: ApprovalResolutionRecord,
  on_timeout: 'fail' | 'approve' | 'reject',
): 'approve' | 'reject' | 'expired' | 'cancelled' => {
  switch (resolution.kind) {
    case 'user_action':
      switch (resolution.decision) {
        case 'approve': return 'approve';
        case 'reject':  return 'reject';
        case 'cancel':  return 'cancelled';
        default:        return 'cancelled';  // malformed — treat as cancel
      }
    case 'executor_timeout':
      return applyTimeoutPolicy(on_timeout);
    case 'executor_cancelled':
    case 'executor_cascade':
    case 'executor_killed':
      return 'cancelled';
  }
};

// ── Adoption: WorkerDispatch → local.action ─────────────────────

/** Turn a `WorkerDispatch{kind: 'approval_action'}` targeted at this
 *  instance into a user_action resolution record emitted under the
 *  adopting peer's instance id. Returns null for non-action kinds —
 *  those dispatches use the callback path, not adoption.
 *
 *  No ACK, no retry — duplicate dispatches (e.g., double-clicked
 *  email link hitting two live instances) each adopt, and the
 *  effective-resolution tiebreaker collapses them deterministically
 *  on the next heartbeat round. */
export const adoptWorkerDispatch = (
  d: WorkerDispatch,
  deps: MergeDeps,
): ApprovalResolutionRecord | null => {
  if (d.kind !== 'approval_action') return null;
  const p = d.payload as ApprovalActionPayload;
  return {
    approval_id: p.approval_id,
    created_by_instance: deps.self.instance_id,
    kind: 'user_action',
    actor: {
      channel: p.actor_channel,
      identifier: p.actor_identifier,
      user_display: p.actor_identifier,
    },
    decision: p.decision,
    note: p.note,
    resolved_at: d.created_at,
  };
};

// ── Helpers ──────────────────────────────────────────────────────

/** Merge incoming pending.channel_handles with existing local view.
 *  Handles are additive — each chat adapter contributes its own
 *  handle post-post, and peer views converge via gossip. */
const mergeChannelHandles = (
  existing: ApprovalPendingRecord | undefined,
  incoming: ApprovalPendingRecord,
): ApprovalPendingRecord => {
  if (!existing?.channel_handles && !incoming.channel_handles) {
    return incoming;
  }
  const merged: ApprovalPendingRecord = { ...incoming };
  const slack = dedupeHandles(
    existing?.channel_handles?.slack,
    incoming.channel_handles?.slack,
    (h) => `${h.workspace_slug}:${h.channel_id}:${h.message_ts}`,
  );
  const telegram = dedupeHandles(
    existing?.channel_handles?.telegram,
    incoming.channel_handles?.telegram,
    (h) => `${h.chat_slug}:${h.chat_id}:${h.message_id}`,
  );
  if (slack.length > 0 || telegram.length > 0) {
    merged.channel_handles = {};
    if (slack.length > 0) merged.channel_handles.slack = slack;
    if (telegram.length > 0) merged.channel_handles.telegram = telegram;
  }
  return merged;
};

const dedupeHandles = <T>(
  a: readonly T[] | undefined,
  b: readonly T[] | undefined,
  keyOf: (h: T) => string,
): T[] => {
  const seen = new Map<string, T>();
  for (const h of a ?? []) seen.set(keyOf(h), h);
  for (const h of b ?? []) seen.set(keyOf(h), h);
  return [...seen.values()];
};

/** Treat as same emission if instance + resolved_at + kind + decision
 *  all match. Stricter than "same approval_id" — lets peers observe
 *  one peer's re-emission without double-counting, but still admits
 *  multiple legit resolutions (e.g. user_action then executor_cancel
 *  if the recipe gets killed mid-click). */
const isSameResolution = (
  a: ApprovalResolutionRecord,
  b: ApprovalResolutionRecord,
): boolean =>
  a.created_by_instance === b.created_by_instance &&
  a.resolved_at === b.resolved_at &&
  a.kind === b.kind &&
  a.decision === b.decision &&
  (a.actor?.identifier ?? null) === (b.actor?.identifier ?? null);

// ── Contribution extraction ─────────────────────────────────────

/** Extract the local state as the next heartbeat outbound
 *  contribution. Callers encrypt each record into an EncryptedBlob
 *  before posting. */
export const extractContribution = (
  state: LocalApprovalState,
): RemoteContribution => ({
  pending: [...state.pending.values()],
  action: [...state.action.values()].flat(),
});
