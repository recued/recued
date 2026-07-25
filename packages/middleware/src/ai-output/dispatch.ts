/** D-145 PB6 — confidence-tier dispatch over `ExtractionEvent`.
 *
 *  Per § B.7.7. Three closed dispatch decisions (`auto_save` /
 *  `queue_for_confirm` / `annotate_only`) keyed off the per-event
 *  `confidence` field via the substrate-pinned floors
 *  (`HIGH_CONFIDENCE_FLOOR` / `MEDIUM_CONFIDENCE_FLOOR`).
 *
 *  The engine layer's role: lift the contracts-side helper
 *  (`dispatchKindForConfidence`) into the per-event dispatched-event
 *  shape downstream consumers (composer / undo registry / confirmation
 *  queue / audit emitter) read. PB6 ships:
 *    - typed `DispatchedEvent` carrying the original event + dispatch
 *      kind + a stable per-event undo token (per § B.7.9 — independent
 *      undo across events from the same source message)
 *    - `dispatchEvents(events)` that maps events to `DispatchedEvent`
 *      preserving original order (composer-ordering / noise-control /
 *      confirmation-batching are downstream concerns).
 *
 *  Spec: § B.7.7 + § B.7.9. */

import {
  type EventDispatchKind,
  type ExtractionEvent,
  dispatchKindForConfidence,
} from '@recued/contracts';

/** Per-event undo token. § B.7.9: each inline thought line is
 *  independently undoable. PB6 derives a stable token from the
 *  event's source_message_id (when present) + a per-message index so
 *  duplicate confirmations / undo retries don't collide. The token is
 *  opaque to consumers — they just thread it through their dispatch
 *  pipeline + return it on the user's "undo this" gesture. */
export type EventUndoToken = string;

export interface DispatchedEvent {
  /** The verbatim ExtractionEvent the AI emitted. PB6 never mutates
   *  fields of the original event — downstream surfaces (audit log,
   *  D-120 memory entries) read the same bytes the AI provider
   *  produced. */
  readonly event: ExtractionEvent;
  /** The closed-list dispatch decision — drives where the event
   *  routes (auto-save → entity write; queue_for_confirm → user-
   *  confirmation queue; annotate_only → soft-render). */
  readonly dispatch: EventDispatchKind;
  /** Stable per-event undo token. Format
   *  `<source_message_id>#<event_index_within_message>` when the event
   *  carries a source_message_id; falls back to a deterministic
   *  `<global_index>#unsourced` token when the event has no source
   *  (composer-cascade events without a chat origin). */
  readonly undo_token: EventUndoToken;
}

/** § B.7.9 token format. Codex P2 fold (2026-05-10) — `s:` prefix for
 *  sourced events, `u#` prefix for unsourced. The two prefixes are
 *  unambiguous regardless of `source_message_id` content (an AI
 *  provider returning the literal string `'unsourced'` as a real
 *  source_message_id no longer collides with the unsourced bucket;
 *  the discriminator is in the prefix, not the slug body).
 *
 *  Examples:
 *    sourced  → `'s:<source_message_id>#<index>'`  (e.g. `'s:msg-1#0'`)
 *    unsourced → `'u#<index>'`                     (e.g. `'u#0'`)
 *
 *  The composer invariant: same input → same tokens (deterministic,
 *  audit-replayable). Tokens are opaque to consumers — they thread
 *  the string through their per-event undo / confirmation pipeline
 *  and read it back on the user gesture. */
export const buildUndoToken = (args: {
  source_message_id?: string;
  index_within_source: number;
}): EventUndoToken =>
  args.source_message_id === undefined
    ? `u#${args.index_within_source}`
    : `s:${args.source_message_id}#${args.index_within_source}`;

export interface DispatchEventsResult {
  /** All events with their dispatch decision + undo token. Original
   *  AI-emitted order preserved. Composer-ordering / noise-control /
   *  confirmation-batching run downstream against this array. */
  readonly dispatched: ReadonlyArray<DispatchedEvent>;
}

/** Map a sequence of `ExtractionEvent`s to `DispatchedEvent`s by
 *  reading per-event `confidence` and assigning the closed-list
 *  dispatch kind + a stable undo token. Pure — no side effects, no
 *  IO, deterministic over the same input.
 *
 *  Per-source-message indexing: the composer threads `index_within_source`
 *  per `source_message_id` (independent counters) so two events from
 *  message-A get tokens A#0, A#1; one event from message-B gets B#0.
 *  Events without a source_message_id increment the `unsourced`
 *  counter — same independence semantics, different prefix. */
export const dispatchEvents = (
  events: ReadonlyArray<ExtractionEvent>,
): DispatchEventsResult => {
  const perSourceCounters = new Map<string, number>();
  let unsourcedCounter = 0;

  const dispatched: DispatchedEvent[] = events.map((event) => {
    const dispatch = dispatchKindForConfidence(event.confidence);
    const sourceKey = event.source_message_id;
    let indexWithinSource: number;
    if (sourceKey === undefined) {
      indexWithinSource = unsourcedCounter;
      unsourcedCounter += 1;
    } else {
      indexWithinSource = perSourceCounters.get(sourceKey) ?? 0;
      perSourceCounters.set(sourceKey, indexWithinSource + 1);
    }
    return {
      event,
      dispatch,
      undo_token: buildUndoToken({
        source_message_id: sourceKey,
        index_within_source: indexWithinSource,
      }),
    };
  });

  return { dispatched };
};
