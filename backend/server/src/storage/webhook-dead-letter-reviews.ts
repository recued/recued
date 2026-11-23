/** D-201 Slice 10B — the record of every owner (or limit) decision on a
 *  webhook dead letter: who, when, why, and what.
 *
 *  A dead letter is an event whose handoff to its recipes kept failing (its
 *  `webhook_event_outbox` row) or one recipe's run of an event that spent its
 *  attempts (its `webhook_recipe_dispatches` row). Both stores write here in
 *  the same transaction as the transition it records, so the table is shared:
 *  one definition, created by whichever store opens first.
 *
 *  Append-only. A dead letter tried again can dead-letter again and be tried
 *  again; each decision is its own row. It holds identifiers, the attempts
 *  spent, a short owner-written reason and the acting client's instance id:
 *  never a payload, a credential or a provider body. */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type WebhookDeadLetterReviewKind = 'event' | 'target';

/** `requeue`: the owner tried it again. `resolve`: the owner closed it, a
 *  reviewed end that claims nothing about the recipe. `expire`: the server
 *  closed it; `reason` names why (`WebhookDeadLetterServerReason`: the review
 *  limit, or, since Slice 10F, a retired webhook or a recipe removed, switched
 *  off or saved with a different webhook setup). */
export type WebhookDeadLetterReviewAction = 'requeue' | 'resolve' | 'expire';

export interface WebhookDeadLetterReviewRow {
  review_id: string;
  subject_kind: WebhookDeadLetterReviewKind;
  subject_id: string;
  event_id: string;
  ingress_id: string;
  action: WebhookDeadLetterReviewAction;
  /** `owner` for an owner's action, `server` for one Recued took itself. */
  actor_kind: 'owner' | 'server';
  /** The owner's client instance, when the action came from one. */
  actor_instance_id: string | null;
  reason: string | null;
  /** Attempts the dead letter had spent when the decision was made. */
  attempt_count: number;
  created_at: number;
}

export const ensureWebhookDeadLetterReviewSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_dead_letter_reviews (
      review_id TEXT PRIMARY KEY,
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('event', 'target')),
      subject_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      ingress_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('requeue', 'resolve', 'expire')),
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner', 'server')),
      actor_instance_id TEXT,
      reason TEXT,
      attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_dead_letter_reviews_subject
      ON webhook_dead_letter_reviews(subject_kind, subject_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_webhook_dead_letter_reviews_ingress
      ON webhook_dead_letter_reviews(ingress_id, created_at);
  `);
};

export const insertWebhookDeadLetterReview = (
  db: Database.Database,
  row: Omit<WebhookDeadLetterReviewRow, 'review_id'> & { review_id?: string },
): WebhookDeadLetterReviewRow => {
  const stored: WebhookDeadLetterReviewRow = {
    ...row,
    review_id: row.review_id ?? `whv_${randomUUID().replace(/-/g, '')}`,
  };
  db.prepare(`
    INSERT INTO webhook_dead_letter_reviews (
      review_id, subject_kind, subject_id, event_id, ingress_id, action,
      actor_kind, actor_instance_id, reason, attempt_count, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    stored.review_id,
    stored.subject_kind,
    stored.subject_id,
    stored.event_id,
    stored.ingress_id,
    stored.action,
    stored.actor_kind,
    stored.actor_instance_id,
    stored.reason,
    stored.attempt_count,
    stored.created_at,
  );
  return stored;
};

export const listWebhookDeadLetterReviews = (
  db: Database.Database,
  subject: { kind: WebhookDeadLetterReviewKind; id: string },
): WebhookDeadLetterReviewRow[] => db.prepare(`
  SELECT * FROM webhook_dead_letter_reviews
  WHERE subject_kind = ? AND subject_id = ?
  ORDER BY created_at ASC, rowid ASC
`).all(subject.kind, subject.id) as WebhookDeadLetterReviewRow[];

/** D-201 Slice 10F — who closed a dead letter, when and why: the latest
 *  closing decision on it (`resolve` or `expire`). Null when none is recorded
 *  (closed before 10B kept records). */
export const closingWebhookDeadLetterReview = (
  db: Database.Database,
  subject: { kind: WebhookDeadLetterReviewKind; id: string },
): Pick<WebhookDeadLetterReviewRow, 'actor_kind' | 'reason' | 'created_at'> | null => (db.prepare(`
  SELECT actor_kind, reason, created_at FROM webhook_dead_letter_reviews
  WHERE subject_kind = ? AND subject_id = ? AND action IN ('resolve', 'expire')
  ORDER BY created_at DESC, rowid DESC
  LIMIT 1
`).get(subject.kind, subject.id) as
  Pick<WebhookDeadLetterReviewRow, 'actor_kind' | 'reason' | 'created_at'> | undefined) ?? null;

/** D-201 Slice 10F — a review record lasts as long as the event it is about:
 *  retention deletes those whose event is gone. Returns how many. */
export const pruneWebhookDeadLetterReviews = (db: Database.Database): number => db.prepare(`
  DELETE FROM webhook_dead_letter_reviews
  WHERE NOT EXISTS (
    SELECT 1 FROM webhook_accepted_events event
    WHERE event.event_id = webhook_dead_letter_reviews.event_id
  )
`).run().changes;

/** Why an owner action on a dead letter was refused. `no_recipe` (Slice 10F):
 *  trying it again would reach no recipe (its recipe was removed, switched off
 *  or saved with a different webhook setup since). `door_missing` /
 *  `door_closed` (Slice 10U): its recipe's webhook has no door, or its door is
 *  switched off, so it could not run. */
export type WebhookDeadLetterActionErrorCode =
  | 'not_found'
  | 'not_dead_letter'
  | 'stale'
  | 'no_recipe'
  | 'door_missing'
  | 'door_closed';

export class WebhookDeadLetterActionError extends Error {
  constructor(
    readonly code: WebhookDeadLetterActionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WebhookDeadLetterActionError';
  }
}

/** Where a page of dead letters ends, for the next one: newest first, by
 *  `dead_lettered_at`, then event dead letters before target ones, then id
 *  (both descending). A store reads rows past it for its own kind. */
export interface WebhookDeadLetterPageBound {
  dead_lettered_at: number;
  /** `none`: only rows strictly older. `all`: rows at the same time too.
   *  `below_id`: rows at the same time with a smaller id. */
  tie: 'none' | 'all' | { below_id: string };
}

/** The SQL condition and parameters for a page bound over `column` and `id`. */
export const deadLetterPageCondition = (
  bound: WebhookDeadLetterPageBound | undefined,
  column: string,
  idColumn: string,
): { sql: string; params: Record<string, unknown> } => {
  if (bound === undefined) return { sql: '1 = 1', params: {} };
  if (bound.tie === 'none') {
    return { sql: `${column} < @bound_at`, params: { bound_at: bound.dead_lettered_at } };
  }
  if (bound.tie === 'all') {
    return { sql: `${column} <= @bound_at`, params: { bound_at: bound.dead_lettered_at } };
  }
  return {
    sql: `(${column} < @bound_at OR (${column} = @bound_at AND ${idColumn} < @bound_id))`,
    params: { bound_at: bound.dead_lettered_at, bound_id: bound.tie.below_id },
  };
};

/** The shared shape of an owner (or limit) decision the stores carry out. */
export interface WebhookDeadLetterDecision {
  /** Which ingress the caller is acting through: a dead letter of another
   *  ingress is `not_found`, never acted on. */
  ingress_id: string;
  /** The `dead_lettered_at` the caller saw. A dead letter that changed since
   *  (tried again and failed again, say) is `stale`. */
  dead_lettered_at: number;
  actor_kind: 'owner' | 'server';
  actor_instance_id: string | null;
  reason: string | null;
}
