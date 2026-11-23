/** D-201 Slice 10B — the owner's review of webhook dead letters, over both
 *  stores that hold them.
 *
 *  An `event` dead letter is an event whose handoff to its recipes spent its
 *  attempts (the delivery store's outbox row); a `target` one is one recipe's
 *  run of an event that spent its attempts (the consumer store's dispatch row).
 *  The owner sees them as one list, newest first, and can try one again or
 *  close it with a reason. Both keep the dead letter's identities: trying again
 *  re-runs the same event, target and run ids, and the dispatch re-derives
 *  their authority when it runs. Closing is a reviewed end: nothing is deleted,
 *  and nothing claims a recipe ran.
 *
 *  Dead letters no longer count against intake (they once could stop it for
 *  good). They are bounded on their own: past `WEBHOOK_DEAD_LETTER_REVIEW_LIMIT`
 *  unresolved ones, `enforceReviewLimit` closes the oldest, recording that the
 *  limit did, so new deliveries are still accepted and storage stays bounded. */

import {
  WEBHOOK_DEAD_LETTER_REVIEW_LIMIT,
  type WebhookDeadLetterActionResponse,
  type WebhookDeadLetterServerReason,
  type WebhookDeadLetterKind,
  type WebhookDeadLetterListCursor,
  type WebhookDeadLetterRef,
  type WebhookDeadLetterReviewSummary,
  type WebhookDeadLetterView,
} from '@recued/contracts';
import type { WebhookDeliveryStore } from './storage/webhook-delivery-store.js';
import type { WebhookConsumerStore } from './storage/webhook-consumer-store.js';
import {
  WebhookDeadLetterActionError,
  type WebhookDeadLetterPageBound,
  type WebhookDeadLetterReviewRow,
} from './storage/webhook-dead-letter-reviews.js';

/** The reason the server records when the review limit closes a dead letter. */
export const WEBHOOK_DEAD_LETTER_LIMIT_REASON: WebhookDeadLetterServerReason = 'review_limit';

export interface WebhookDeadLetterService {
  list(input: {
    ingress_id: string;
    limit: number;
    cursor?: WebhookDeadLetterListCursor;
    /** Slice 10F — the closed ones instead, each with its closure. */
    closed?: boolean;
  }): {
    dead_letters: WebhookDeadLetterView[];
    next_cursor: WebhookDeadLetterListCursor | null;
  };
  summary(): WebhookDeadLetterReviewSummary;
  unresolvedForIngress(ingressId: string): number;
  requeue(input: WebhookDeadLetterOwnerAction): WebhookDeadLetterActionResponse;
  resolve(input: WebhookDeadLetterOwnerAction & { reason: string }): WebhookDeadLetterActionResponse;
  /** Close the oldest unresolved dead letters past the limit, recording that
   *  the limit did. Returns how many it closed. Its first run also closes
   *  any left open on a retired webhook (Slice 10F: a stop between the retire
   *  and its closing). */
  enforceReviewLimit(): number;
  /** D-201 Slice 10F — retiring a webhook closes its open dead letters, with a
   *  record that Recued did because it was retired. Returns how many. */
  closeForRetiredIngress(ingressId: string): number;
}

export interface WebhookDeadLetterOwnerAction {
  ingress_id: string;
  dead_letter: WebhookDeadLetterRef;
  dead_lettered_at: number;
  reason: string | null;
  /** The owner client that acted. */
  actor_instance_id: string | null;
}

export interface WebhookDeadLetterServiceDeps {
  deliveryStore: Pick<
    WebhookDeliveryStore,
    | 'listDeadLetterEvents'
    | 'countUnresolvedDeadLetterEvents'
    | 'oldestUnresolvedDeadLetterEvents'
    | 'requeueDeadLetterEvent'
    | 'resolveDeadLetterEvent'
    | 'closeDeadLetterEventsForIngress'
  >;
  consumerStore: Pick<
    WebhookConsumerStore,
    | 'listDeadLetterTargets'
    | 'countUnresolvedDeadLetterTargets'
    | 'oldestUnresolvedDeadLetterTargets'
    | 'oldestUnresolvedDoorlessDeadLetterTargets'
    | 'requeueDeadLetterTarget'
    | 'resolveDeadLetterTarget'
    | 'closeDeadLetterTargetsForIngress'
    | 'closeStrandedTargets'
  >;
  /** Slice 10F — whether an ingress is retired, for the first run's pass over
   *  dead letters left open on one. Absent: no such pass. */
  isIngressRetired?: (ingressId: string) => boolean;
  /** D-201 Slice 10U (10Q finding 9) — whether the door stamped on a trigger is
   *  live (`webhookDoorState` over the store the runner reads). A target dead
   *  letter is tried again only through a live door; otherwise it stays, and
   *  the owner is told which door to make or open. Absent: not checked. */
  doorState?: (contractId: string | null) => 'live' | 'missing' | 'closed';
  /** Defaults to `WEBHOOK_DEAD_LETTER_REVIEW_LIMIT`. */
  limit?: number;
  /** D-201 Slice 10W — the step an `approved_run_in_doubt` dead letter's try
   *  again goes on from (`ApprovalRestartHeldRun`), so the owner is told which
   *  one can run twice. Absent, or none held: not named. */
  heldStepOf?: (runId: string) => NonNullable<WebhookDeadLetterView['held_try_again']> | null;
  /** After a dead letter is tried again, so its runner looks now rather than
   *  at its next poll. Never throws into the action. */
  onRequeue?: (kind: WebhookDeadLetterKind) => void;
  /** D-201 Slice 10AB (10AA finding 14) — after the owner closes a target dead
   *  letter, or the review limit or a retired webhook's pass closes any, so
   *  what a held run kept goes with it (`HeldRunPass.sweep`). Never throws into
   *  the action. */
  onClosed?: () => void;
}

/** Event dead letters sort before target ones at the same moment. */
const kindRank = (kind: WebhookDeadLetterKind): number => (kind === 'event' ? 1 : 0);

const newestFirst = (left: WebhookDeadLetterView, right: WebhookDeadLetterView): number =>
  (right.dead_lettered_at - left.dead_lettered_at)
  || (kindRank(right.kind) - kindRank(left.kind))
  || (left.dead_letter_id < right.dead_letter_id ? 1 : left.dead_letter_id > right.dead_letter_id ? -1 : 0);

/** Each store's rows past a cursor in the merged order (see `newestFirst`). */
const boundFor = (
  kind: WebhookDeadLetterKind,
  cursor: WebhookDeadLetterListCursor | undefined,
): WebhookDeadLetterPageBound | undefined => {
  if (cursor === undefined) return undefined;
  if (cursor.kind === kind) {
    return { dead_lettered_at: cursor.dead_lettered_at, tie: { below_id: cursor.dead_letter_id } };
  }
  // At the cursor's moment, events come first: past an event cursor every
  // target at that moment is still to come; past a target cursor, no event is.
  return {
    dead_lettered_at: cursor.dead_lettered_at,
    tie: cursor.kind === 'event' ? 'all' : 'none',
  };
};

export const createWebhookDeadLetterService = (
  deps: WebhookDeadLetterServiceDeps,
): WebhookDeadLetterService => {
  const limit = deps.limit ?? WEBHOOK_DEAD_LETTER_REVIEW_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('webhook dead letters: the review limit must be a positive integer');
  }
  const { deliveryStore, consumerStore } = deps;
  /** Whether the pass over retired webhooks has happened: once per start, and
   *  again after a retire's own close failed. */
  let retiredSwept = false;
  const closeForRetiredIngress = (ingressId: string): number => {
    try {
      return deliveryStore.closeDeadLetterEventsForIngress(ingressId, 'webhook_retired')
        + consumerStore.closeDeadLetterTargetsForIngress(ingressId, 'webhook_retired');
    } catch (error) {
      // The next poll's pass closes what this one left.
      retiredSwept = false;
      throw error;
    }
  };

  /** D-201 Slice 10AB — what a held run kept goes with its dead letter. */
  const closed = (): void => {
    try {
      deps.onClosed?.();
    } catch {
      // The next pass sweeps again.
    }
  };

  const unresolved = (ingressId?: string): number =>
    deliveryStore.countUnresolvedDeadLetterEvents(ingressId)
    + consumerStore.countUnresolvedDeadLetterTargets(ingressId);

  const responseFrom = (
    ref: WebhookDeadLetterRef,
    outcome: WebhookDeadLetterActionResponse['outcome'],
    review: WebhookDeadLetterReviewRow,
  ): WebhookDeadLetterActionResponse => ({
    dead_letter: { kind: ref.kind, dead_letter_id: ref.dead_letter_id },
    outcome,
    review_id: review.review_id,
    acted_at: review.created_at,
  });

  return {
    list(input) {
      const closed = input.closed === true ? { closed: true } : {};
      const events = deliveryStore.listDeadLetterEvents({
        ingress_id: input.ingress_id,
        limit: input.limit + 1,
        ...closed,
        ...(input.cursor === undefined ? {} : { before: boundFor('event', input.cursor)! }),
      });
      const targets = consumerStore.listDeadLetterTargets({
        ingress_id: input.ingress_id,
        limit: input.limit + 1,
        ...closed,
        ...(input.cursor === undefined ? {} : { before: boundFor('target', input.cursor)! }),
      });
      const merged: WebhookDeadLetterView[] = [
        ...events.map((row): WebhookDeadLetterView => ({
          kind: 'event',
          dead_letter_id: row.outbox_id,
          ingress_id: row.ingress_id,
          delivery_id: row.delivery_id,
          event_id: row.event_id,
          provider_event_type: row.provider_event_type,
          received_at: row.received_at,
          recipe_id: null,
          attempt_count: row.attempt_count,
          last_error_code: row.last_error_code,
          dead_lettered_at: row.dead_lettered_at,
          payload_retained: row.payload_retained,
          ...(row.closure === undefined ? {} : { closure: { ...row.closure } }),
        })),
        ...targets.map((row): WebhookDeadLetterView => ({
          kind: 'target',
          dead_letter_id: row.dispatch_id,
          ingress_id: row.ingress_id,
          delivery_id: row.delivery_id,
          event_id: row.event_id,
          provider_event_type: row.provider_event_type,
          received_at: row.received_at,
          recipe_id: row.recipe_id,
          attempt_count: row.attempt_count,
          last_error_code: row.last_error_code,
          dead_lettered_at: row.dead_lettered_at,
          payload_retained: row.payload_retained,
          ...(row.closure === undefined ? {} : { closure: { ...row.closure } }),
          ...(() => {
            if (row.last_error_code !== 'approved_run_in_doubt' || deps.heldStepOf === undefined) return {};
            try {
              const held = deps.heldStepOf(row.run_id);
              if (held === null) return {};
              // D-201 Slice 10AG (10AE finding 11) — every state in its own
              // field; `step_in_doubt` only for those a 10W Settings words
              // right, so an older one never says a failed step goes on alone,
              // nor that it asks again.
              // D-201 Slice 10BC (10AY findings 2 and 9) — nor that only that
              // step runs twice of one whose later steps run again too.
              const tenW = held.failed !== true && held.recipe_changed !== true
                && !(held.progress_unknown === true && held.asks_again !== true)
                && held.later_run_again !== true;
              // D-201 Slice 10BI (10BF finding 5) — `step_in_doubt` carries only
              // the fields its contract lists, never the hand-off's.
              const { handoff_unproven: _handoff, ...tenWFields } = held;
              return {
                held_try_again: { ...held },
                ...(tenW ? { step_in_doubt: tenWFields } : {}),
              };
            } catch {
              return {};
            }
          })(),
        })),
      ].sort(newestFirst);
      const page = merged.slice(0, input.limit);
      const last = page.at(-1);
      return {
        dead_letters: page,
        next_cursor: merged.length > input.limit && last !== undefined
          ? {
              dead_lettered_at: last.dead_lettered_at,
              kind: last.kind,
              dead_letter_id: last.dead_letter_id,
            }
          : null,
      };
    },
    summary: () => ({ unresolved: unresolved(), limit }),
    unresolvedForIngress: (ingressId) => unresolved(ingressId),
    requeue(input) {
      const decision = {
        ingress_id: input.ingress_id,
        dead_lettered_at: input.dead_lettered_at,
        actor_kind: 'owner' as const,
        actor_instance_id: input.actor_instance_id,
        reason: input.reason,
      };
      const review = input.dead_letter.kind === 'event'
        ? deliveryStore.requeueDeadLetterEvent({ outbox_id: input.dead_letter.dead_letter_id, ...decision })
        : consumerStore.requeueDeadLetterTarget({
            dispatch_id: input.dead_letter.dead_letter_id,
            ...decision,
            ...(deps.doorState !== undefined ? { door: deps.doorState } : {}),
          });
      try {
        deps.onRequeue?.(input.dead_letter.kind);
      } catch {
        // A wake-up only: the next poll finds the work regardless.
      }
      return responseFrom(input.dead_letter, 'requeued', review);
    },
    resolve(input) {
      const decision = {
        ingress_id: input.ingress_id,
        dead_lettered_at: input.dead_lettered_at,
        actor_kind: 'owner' as const,
        actor_instance_id: input.actor_instance_id,
        reason: input.reason,
      };
      const review = input.dead_letter.kind === 'event'
        ? deliveryStore.resolveDeadLetterEvent({
            outbox_id: input.dead_letter.dead_letter_id,
            action: 'resolve',
            ...decision,
          })
        : consumerStore.resolveDeadLetterTarget({
            dispatch_id: input.dead_letter.dead_letter_id,
            action: 'resolve',
            ...decision,
          });
      if (input.dead_letter.kind === 'target') closed();
      return responseFrom(input.dead_letter, 'resolved', review);
    },
    closeForRetiredIngress,
    enforceReviewLimit() {
      let closedForRetired = 0;
      if (!retiredSwept && deps.isIngressRetired !== undefined) {
        retiredSwept = true;
        // D-201 Slice 10X (10V finding 28) — a throw anywhere in this pass
        // leaves it for the next poll's: 10U covered only the stranded sweep's.
        try {
          // Every open one, not the oldest few: a retired webhook's can be the
          // newest, behind more than the limit (an upgrade's backlog).
          const open = [
            ...deliveryStore.oldestUnresolvedDeadLetterEvents(deliveryStore.countUnresolvedDeadLetterEvents()),
            ...consumerStore.oldestUnresolvedDeadLetterTargets(consumerStore.countUnresolvedDeadLetterTargets()),
          ];
          for (const ingressId of new Set(open.map((row) => row.ingress_id))) {
            if (deps.isIngressRetired(ingressId)) {
              closedForRetired += closeForRetiredIngress(ingressId);
            }
          }
          // D-201 Slice 10I (10H finding 5) — then rows no claim can reach, their
          // trigger gone (a delete before 10I, or a stop mid-save). After the
          // retired sweep, so a retired webhook's say it was retired.
          closedForRetired += consumerStore.closeStrandedTargets();
        } catch (error) {
          retiredSwept = false;
          throw error;
        }
      }
      const excess = unresolved() - limit;
      if (excess <= 0) {
        if (closedForRetired > 0) closed();
        return closedForRetired;
      }
      // D-201 Slice 10X (10V finding 11) — first the dead letters no recipe ran
      // for want of a live door, so a webhook with no door never crowds
      // another's out of the limit. Before 10U they were cancelled and took no
      // place; then they did.
      const doorless = consumerStore.oldestUnresolvedDoorlessDeadLetterTargets(excess)
        .map((row) => ({ kind: 'target' as const, ...row }));
      const doorlessIds = new Set(doorless.map((row) => row.id));
      const others = excess - doorless.length;
      const oldest = [
        ...doorless,
        ...(others <= 0 ? [] : [
          ...deliveryStore.oldestUnresolvedDeadLetterEvents(excess)
            .map((row) => ({ kind: 'event' as const, ...row })),
          ...consumerStore.oldestUnresolvedDeadLetterTargets(excess)
            .map((row) => ({ kind: 'target' as const, ...row }))
            .filter((row) => !doorlessIds.has(row.id)),
        ].sort((left, right) => (left.dead_lettered_at - right.dead_lettered_at)
          || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
          .slice(0, others)),
      ];
      let expired = 0;
      for (const row of oldest) {
        const decision = {
          ingress_id: row.ingress_id,
          dead_lettered_at: row.dead_lettered_at,
          actor_kind: 'server' as const,
          actor_instance_id: null,
          reason: WEBHOOK_DEAD_LETTER_LIMIT_REASON,
        };
        try {
          if (row.kind === 'event') {
            deliveryStore.resolveDeadLetterEvent({ outbox_id: row.id, action: 'expire', ...decision });
          } else {
            consumerStore.resolveDeadLetterTarget({ dispatch_id: row.id, action: 'expire', ...decision });
          }
          expired += 1;
        } catch (error) {
          // The owner acted on it in between: it is no longer unresolved.
          if (!(error instanceof WebhookDeadLetterActionError)) throw error;
        }
      }
      if (expired + closedForRetired > 0) closed();
      return expired + closedForRetired;
    },
  };
};
