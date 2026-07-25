/** D-113 — Chat adapter contract + coordination helpers.
 *
 *  Pure module. Defines the interface every chat surface (Slack,
 *  Telegram) implements, plus the owner-first-with-grace logic that
 *  decides which peer is responsible for editing the chat message on
 *  resolution. No network, no storage, no adapter-specific state.
 *
 *  Three responsibilities:
 *
 *  1. **Adapter contract.** `ApprovalChatAdapter<C, H>` — each surface
 *     knows how to post + update + timeout a single chat message. Handle
 *     type `H` (SlackChannelHandle / TelegramChannelHandle) stamps the
 *     coordinates that the data plane carries through gossip so peers
 *     converge on the same thread.
 *
 *  2. **Owner-first-with-grace.** `shouldUpdateChannel` — initiator
 *     updates immediately on resolution; peers wait OWNER_GRACE_WINDOW_MS
 *     past resolved_at before taking over. Idempotent on chat side
 *     (chat.update / editMessageText accept the same payload twice), so
 *     even a double-update from two peers racing past grace is harmless.
 *
 *  3. **Record mutation helpers.** `appendSlackHandle` / `appendTelegramHandle`
 *     additively merge a freshly-posted handle into the pending record;
 *     `markChannelUpdateDone` stamps a resolution record so other peers
 *     skip the redundant chat update on the next gossip round.
 */

import {
  OWNER_GRACE_WINDOW_MS,
  type ApprovalPendingRecord,
  type ApprovalResolutionRecord,
  type MessengerVendorSlug,
  type SlackChannelHandle,
  type TelegramChannelHandle,
} from '@recued/contracts';

// ── Adapter contract ─────────────────────────────────────────────

/** D-192 seam 10 — a chat transport, so the declared vendor slugs. Deliberately
 *  NOT the wider channel list: `email` / `ui` / `bridge` never relay a chat
 *  message. A newly declared transport becomes relayable here with no edit. */
export type ChatChannel = MessengerVendorSlug;

export type ChatHandle = SlackChannelHandle | TelegramChannelHandle;

/** Generic chat adapter. One instance per configured channel
 *  (e.g. one Slack workspace × one channel_id → one adapter). The
 *  composition root spawns adapters lazily when a pending arrives for
 *  a channel type this instance has enabled. */
export interface ApprovalChatAdapter<C extends ChatChannel, H extends ChatHandle> {
  readonly channel: C;
  /** Post the initial approval message. Returns a handle that uniquely
   *  identifies the posted chat message so later edits can target it. */
  post(approval: ApprovalPendingRecord): Promise<H>;
  /** Rewrite the message to show the resolution + remove the action
   *  buttons. Idempotent on the chat side — safe to run twice if two
   *  peers race past the grace window. */
  markResolved(handle: H, resolution: ApprovalResolutionRecord): Promise<void>;
  /** Rewrite the message to show "channel expired — still actionable
   *  elsewhere". Called when the per-channel ttl_ms elapses without
   *  resolution. The approval stays open on other surfaces. */
  markChannelTimedOut(handle: H): Promise<void>;
}

// ── Owner-first-with-grace coordination ──────────────────────────

export interface ShouldUpdateDeps {
  self: { instance_id: string };
  now: number;
}

/** Decide whether this peer should perform the chat-update on a
 *  newly-resolved approval. Rule order:
 *
 *    1. If some peer has already marked this channel done → skip.
 *    2. If I am the pending's initiator → I'm authoritative, update now.
 *    3. If past OWNER_GRACE_WINDOW_MS since resolved_at → peer takeover.
 *    4. Else wait for the owner.
 *
 *  Two peers that pass (3) simultaneously both update — that's the
 *  documented "acceptable edge-case double-update" the spec calls out.
 *  Chat.update / editMessageText are idempotent on identical payloads. */
export const shouldUpdateChannel = (
  pending: ApprovalPendingRecord,
  resolution: ApprovalResolutionRecord,
  channel: ChatChannel,
  deps: ShouldUpdateDeps,
): boolean => {
  if (resolution.channel_updates_done?.[channel]) return false;
  if (pending.initiator_instance === deps.self.instance_id) return true;
  return (deps.now - resolution.resolved_at) > OWNER_GRACE_WINDOW_MS;
};

// ── Record-mutation helpers ──────────────────────────────────────

/** Return a new pending record with the Slack handle appended to
 *  channel_handles.slack. Additive — existing handles are preserved.
 *  Data-plane merge dedupes by (workspace_slug, channel_id, message_ts)
 *  so multiple peers converging on the same handle collapse cleanly. */
export const appendSlackHandle = (
  pending: ApprovalPendingRecord,
  handle: SlackChannelHandle,
): ApprovalPendingRecord => ({
  ...pending,
  channel_handles: {
    ...pending.channel_handles,
    slack: [...(pending.channel_handles?.slack ?? []), handle],
  },
});

/** Telegram counterpart of `appendSlackHandle`. */
export const appendTelegramHandle = (
  pending: ApprovalPendingRecord,
  handle: TelegramChannelHandle,
): ApprovalPendingRecord => ({
  ...pending,
  channel_handles: {
    ...pending.channel_handles,
    telegram: [...(pending.channel_handles?.telegram ?? []), handle],
  },
});

/** Return a new resolution record flagged as having been rendered to
 *  `channel`. The caller writes this back into local.action + the next
 *  heartbeat carries it to peers so they skip the redundant update. */
export const markChannelUpdateDone = (
  resolution: ApprovalResolutionRecord,
  channel: ChatChannel,
): ApprovalResolutionRecord => ({
  ...resolution,
  channel_updates_done: {
    ...resolution.channel_updates_done,
    [channel]: true,
  },
});

// ── Resolution formatting (shared across adapters) ──────────────

/** Human-readable one-line summary of a resolution. Used as the
 *  message text (notifications / legacy clients) and as the heading
 *  of the rewritten post-resolution block/message. Adapter-agnostic
 *  — same string on Slack, Telegram, email landing pages. */
export const resolvedSummary = (r: ApprovalResolutionRecord): string => {
  if (r.kind === 'user_action') {
    switch (r.decision) {
      case 'approve': return 'Approved';
      case 'reject':  return 'Rejected';
      case 'cancel':  return 'Run cancelled';
      default:        return 'Resolved';
    }
  }
  switch (r.kind) {
    case 'executor_timeout':   return 'Expired (no response)';
    case 'executor_cancelled': return 'Cancelled';
    case 'executor_cascade':   return 'Cancelled (cascade)';
    case 'executor_killed':    return 'Cancelled (engine shutdown)';
  }
};

/** Context-line attribution. User actions → "via slack: Alice";
 *  executor actions → "Reason: timeout reached". Same line shape on
 *  every chat surface so audit trails + user recognition are uniform. */
export const actorLine = (r: ApprovalResolutionRecord): string => {
  if (r.kind === 'user_action' && r.actor) {
    const who = r.actor.user_display ?? r.actor.identifier ?? 'unknown';
    return `via ${r.actor.channel}: ${who}`;
  }
  if (r.executor_reason) return `Reason: ${r.executor_reason}`;
  return r.kind;
};
