/** D-145 PB6 — confirmation queue batching for medium-confidence
 *  events.
 *
 *  Per § B.7.11. "If a message produces multiple medium-confidence
 *  events, they appear as a **related group** in the confirmation
 *  queue with a shared source-message reference, but each is
 *  independently confirmable. User can confirm all in one click
 *  ('looks right') or per-event."
 *
 *  PB6 ships the substrate-side batcher: given a list of dispatched
 *  events, group medium-confidence (`queue_for_confirm`) entries by
 *  source_message_id into `ConfirmationGroup`s, while passing
 *  high-confidence (`auto_save`) and low-confidence (`annotate_only`)
 *  events through unchanged.
 *
 *  The grouping key is `source_message_id` — when a queue_for_confirm
 *  event has no source_message_id, it lands in its own singleton
 *  group (no batching across un-tethered events).
 *
 *  Spec: § B.7.11. */

import type { DispatchedEvent } from './dispatch.js';

/** § B.7.11 — group of medium-confidence events from the same source
 *  message, each independently confirmable. */
export interface ConfirmationGroup {
  /** Shared source-message reference (always present for batched
   *  groups; singleton-via-no-source groups carry `null`). */
  readonly source_message_id: string | null;
  /** Members in original order. Each retains its own `undo_token` so
   *  the renderer can wire per-event confirm + bulk "looks right"
   *  semantics. */
  readonly events: ReadonlyArray<DispatchedEvent>;
}

export interface BatchForConfirmationResult {
  /** Groups of medium-confidence events. § B.7.11 — singleton groups
   *  for entries without a source_message_id; multi-entry groups for
   *  entries that share one. */
  readonly groups: ReadonlyArray<ConfirmationGroup>;
  /** Pass-through events — all entries that were NOT
   *  queue_for_confirm (auto-save + annotate-only). Order preserved
   *  from the input. */
  readonly passthrough: ReadonlyArray<DispatchedEvent>;
}

/** Build confirmation groups from dispatched events. Pure — returns
 *  new shape; never mutates input. § B.7.11 grouping rule: same
 *  `source_message_id` + `dispatch === 'queue_for_confirm'` →
 *  same group. Group order = first-occurrence in input.
 *
 *  Singleton fallback: queue_for_confirm events without a
 *  source_message_id each get their own group with `source_message_id:
 *  null` — the renderer treats these as standalone "added to your
 *  review queue" entries (no shared reference to confirm together). */
export const batchForConfirmation = (
  dispatched: ReadonlyArray<DispatchedEvent>,
): BatchForConfirmationResult => {
  const groupBuckets = new Map<string, DispatchedEvent[]>();
  const orderedSourceKeys: string[] = [];
  const singletons: ConfirmationGroup[] = [];
  const passthrough: DispatchedEvent[] = [];

  for (const item of dispatched) {
    if (item.dispatch !== 'queue_for_confirm') {
      passthrough.push(item);
      continue;
    }
    const sourceKey = item.event.source_message_id;
    if (sourceKey === undefined) {
      singletons.push({ source_message_id: null, events: [item] });
      continue;
    }
    if (!groupBuckets.has(sourceKey)) {
      groupBuckets.set(sourceKey, []);
      orderedSourceKeys.push(sourceKey);
    }
    groupBuckets.get(sourceKey)!.push(item);
  }

  const sourcedGroups: ConfirmationGroup[] = orderedSourceKeys.map((key) => ({
    source_message_id: key,
    events: groupBuckets.get(key)!,
  }));

  // Output order: sourced groups (in first-occurrence order) followed
  // by singletons (in original encounter order). Stable + deterministic
  // — audit replay reads the same group sequence on every replay.
  return {
    groups: [...sourcedGroups, ...singletons],
    passthrough,
  };
};
