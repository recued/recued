/** D-145 PB6 — multi-event noise control.
 *
 *  Per § B.7.10. "If a single message produces 6+ events, the inline
 *  thought stream collapses to a single summary line (`detected 7
 *  things in your message — expand to see / undo each`) with
 *  click-to-expand."
 *
 *  PB6 ships the substrate-side discriminator: given a list of
 *  dispatched events, returns either an inline stream OR a collapsed
 *  summary + the underlying events available behind click-to-expand.
 *
 *  The threshold (`MULTI_EVENT_COLLAPSE_THRESHOLD = 6`) is
 *  substrate-pinned in `@recued/contracts`. Drift requires a
 *  substrate D-spec change.
 *
 *  Important: noise control collapses ONLY events sharing the same
 *  `source_message_id`. Events from different source messages are
 *  independent inline streams (they were emitted across multiple
 *  user turns or user messages). Events without a source_message_id
 *  fall in the "unsourced" group — they're treated as one bucket so
 *  cascade-storm events still benefit from collapse.
 *
 *  Spec: § B.7.10. */

import { MULTI_EVENT_COLLAPSE_THRESHOLD } from '@recued/contracts';

import type { DispatchedEvent } from './dispatch.js';

/** Per-source-message rendering decision. § B.7.10 — when the count
 *  hits the threshold, the inline rendering collapses to a single
 *  summary line; the events themselves are still available behind
 *  click-to-expand (the renderer holds the bucket; the substrate
 *  emits the count + bucket reference). */
export type NoiseGroup =
  | {
      readonly source_message_id: string | null;
      readonly mode: 'inline';
      readonly events: ReadonlyArray<DispatchedEvent>;
    }
  | {
      readonly source_message_id: string | null;
      readonly mode: 'collapsed_summary';
      readonly count: number;
      readonly events: ReadonlyArray<DispatchedEvent>;
    };

export interface NoiseControlResult {
  /** One group per source_message_id (plus an `unsourced` bucket if
   *  present). Each group either renders inline OR collapsed —
   *  threshold per `MULTI_EVENT_COLLAPSE_THRESHOLD`. */
  readonly groups: ReadonlyArray<NoiseGroup>;
}

/** Group dispatched events by `source_message_id` and apply the
 *  collapse threshold per group. Pure — returns a new shape; never
 *  mutates input. The caller decides what to do with each group
 *  (inline render vs collapsed render).
 *
 *  Group-key semantics:
 *    - source_message_id present → group key = source_message_id
 *    - source_message_id absent  → group key = `null` ("unsourced"
 *      bucket; cascade-storm events still benefit from collapse).
 *
 *  Group order: first-occurrence in the dispatched list (stable). */
export const applyNoiseControl = (
  dispatched: ReadonlyArray<DispatchedEvent>,
): NoiseControlResult => {
  const buckets = new Map<string | null, DispatchedEvent[]>();
  const orderKeys: Array<string | null> = [];
  for (const item of dispatched) {
    const key = item.event.source_message_id ?? null;
    if (!buckets.has(key)) {
      buckets.set(key, []);
      orderKeys.push(key);
    }
    buckets.get(key)!.push(item);
  }
  const groups: NoiseGroup[] = orderKeys.map((key) => {
    const events = buckets.get(key)!;
    if (events.length >= MULTI_EVENT_COLLAPSE_THRESHOLD) {
      return {
        source_message_id: key,
        mode: 'collapsed_summary',
        count: events.length,
        events,
      };
    }
    return {
      source_message_id: key,
      mode: 'inline',
      events,
    };
  });
  return { groups };
};
