/** D-239 — mail write-back dispatcher.
 *
 *  Four kernel ingredients route through this module. They are the first ops
 *  that change the state of a mail message that ALREADY EXISTS —
 *  `mail-send` creates a new one, and every other `data.mail` op reads.
 *
 *    Writes (verified-then-reflected — the adapter must confirm before the
 *    warehouse moves):
 *      mail-mark   → provider.markMessage   → applyVerifiedMutation
 *      mail-flag   → provider.flagMessage   → applyVerifiedMutation
 *      mail-move   → provider.moveMessage   → applyVerifiedMutation | drop
 *      mail-delete → provider.deleteMessage → deleteLocalRecord
 *
 *  The dispatcher enforces three gates before the adapter call:
 *    1. A live collection exists for `(platform='mail', slug)`.
 *    2. `collection.mutationCapable` — the grant (gmail `gmail.modify`,
 *       graph `Mail.ReadWrite`) or the IMAP client actually permits writes.
 *    3. The warehouse row exists, so the caller's `record_id` resolves to a
 *       provider-native `source_id` we can name.
 *
 *  ⛔ THE ORDER OF THE LAST TWO STEPS IS THE WHOLE CONTRACT. Adapter first,
 *  warehouse second, ALWAYS — and on `MAIL_IO_ERROR` (outcome unknown) the
 *  warehouse is not touched at all. Reversing it, or writing optimistically
 *  and rolling back, produces a mirror that claims a state the provider
 *  never reached; the next sync would silently contradict it and the user
 *  would see a flag flicker on and off with no explanation. D-117 decision 3
 *  pinned this for calendar; mail inherits it unchanged.
 */

import { RpcError } from '@recued/contracts';
import type {
  CollectionRecord,
  MailMoveDestination,
  MailMutationResult,
} from '@recued/contracts';
import type { CollectionRegistry } from '../registry.js';
import { pickPrimaryFolder, type MailCollection } from './mail-collection.js';
import { callMailAdapter } from './mail-errors.js';

export interface MailDispatcherDeps {
  registry: CollectionRegistry;
  /** Remove the local warehouse row after a provider-verified delete, or
   *  after a move whose result the provider could not name.
   *
   *  ⛔ REQUIRED, NOT OPTIONAL, and the difference is a real defect class. A
   *  successful provider delete with no local removal leaves the warehouse
   *  advertising a message that no longer exists — a fail-OPEN, and one that
   *  looks like success from every angle: the op returns ok, the audit row
   *  is clean, and the stale row keeps answering reads. An unwired optional
   *  dep would have produced exactly that.
   *
   *  Wired to `handleCollectionDeleteRecord` so the annotation cascade AND
   *  the enrichment delete cascade fire through the SAME implementation the
   *  `collection.deleteRecord` rpc uses. That reuse is load-bearing:
   *  `bridgeEnrichmentCascade` deliberately filters `deleted` events to
   *  calendar + platform-reference scopes, so a mail delete that only
   *  emitted a warehouse event would run NO cascade and orphan every
   *  enrichment row keyed to the message. */
  deleteLocalRecord: (slug: string, record_id: string) => Promise<void>;
}

// ────────────────────────────────────────────────────────────────
// Gates
// ────────────────────────────────────────────────────────────────

const requireCollection = (
  deps: MailDispatcherDeps,
  slug: string,
): MailCollection => {
  const collection = deps.registry.get('mail', slug) as MailCollection | undefined;
  if (!collection) {
    throw new RpcError(
      'collection_not_found',
      `MAIL_INSTANCE_NOT_FOUND: no mail instance '${slug}'`,
      404,
    );
  }
  return collection;
};

/** Collection + the capability gate + the resolved row, in the order a
 *  mutation needs them.
 *
 *  ⚠ The capability check comes BEFORE the row lookup on purpose: "this
 *  mailbox is read-only" is a stable fact about the enrollment, and
 *  reporting it is more useful than "no such record" from a caller who
 *  would have been refused anyway. The reverse order makes a
 *  permission problem look like a data problem. */
const requireMutable = (
  deps: MailDispatcherDeps,
  slug: string,
  record_id: string,
): { collection: MailCollection; record: CollectionRecord; source_id: string } => {
  const collection = requireCollection(deps, slug);
  if (!collection.mutationCapable) {
    throw new RpcError(
      'forbidden',
      `MAIL_MUTATION_UNSUPPORTED: mail instance '${slug}' is enrolled read-only `
        + `— re-enroll granting write access (gmail: gmail.modify, `
        + `microsoft: Mail.ReadWrite, imap: a read-write mailbox)`,
      403,
    );
  }
  const record = collection.get(record_id);
  if (!record) {
    throw new RpcError(
      'not_found',
      `MAIL_RECORD_NOT_FOUND: no record '${record_id}' in mail:${slug}`,
      404,
    );
  }
  // The warehouse row's `source_id` is the provider-native identity
  // (`UID@folder` for IMAP, the message id for gmail / graph). Callers
  // address records by `record_id` — a local hash — and never see this, so
  // the translation belongs here rather than in every caller.
  return { collection, record, source_id: record.source_id };
};

/** Every mutation verb is missing on a provider that reported itself
 *  capable only if the two have drifted; this turns that into a legible
 *  refusal instead of a `TypeError` at call time. */
const requireVerb = <T>(verb: T | undefined, slug: string, name: string): T => {
  if (!verb) {
    throw new RpcError(
      'forbidden',
      `MAIL_MUTATION_UNSUPPORTED: mail instance '${slug}' does not implement '${name}'`,
      403,
    );
  }
  return verb;
};

// ────────────────────────────────────────────────────────────────
// Write handlers — verified-then-reflected
// ────────────────────────────────────────────────────────────────

/** The shape every state-changing verb returns. `record_id` is echoed
 *  because a move can RE-KEY the row, so the id the caller passed in may no
 *  longer resolve — a recipe that chains two steps on one message must read
 *  the id back rather than reuse its own. */
export interface MailMutationOutcome {
  record_id: string;
  is_read: boolean;
  is_flagged: boolean;
  folder: string;
}

const outcomeOf = (
  record: CollectionRecord,
  result: MailMutationResult,
): MailMutationOutcome => ({
  record_id: record.record_id,
  is_read: result.is_read,
  is_flagged: result.is_flagged,
  folder:
    typeof record.hot_fields.folder === 'string' ? record.hot_fields.folder : '',
});

/** A mutation that verified at the provider but whose row vanished locally
 *  (concurrent retention, a delete arriving on the sync channel mid-call).
 *  The provider state is real and is what we report; there is simply no
 *  local row left to name, and inventing one from a state fragment would
 *  create a bodiless row that reads as a real message. */
const detachedOutcome = (result: MailMutationResult): MailMutationOutcome => ({
  record_id: '',
  is_read: result.is_read,
  is_flagged: result.is_flagged,
  // Same fold the ingest path and `applyVerifiedMutation` use — imported,
  // not re-derived, so a Gmail message reports one folder regardless of
  // which of the three paths last computed it.
  folder: pickPrimaryFolder(result.folder_or_label, result.labels),
});

export const handleMailMark = async (
  deps: MailDispatcherDeps,
  input: { slug: string; record_id: string; read: boolean },
): Promise<MailMutationOutcome> => {
  const { collection, source_id } = requireMutable(deps, input.slug, input.record_id);
  const mark = requireVerb(
    collection.provider.markMessage?.bind(collection.provider),
    input.slug,
    'mail-mark',
  );
  const result = await callMailAdapter(input.slug, 'mail-mark', () =>
    mark({ source_id, read: input.read }));
  const updated = collection.applyVerifiedMutation(input.record_id, result);
  return updated ? outcomeOf(updated, result) : detachedOutcome(result);
};

export const handleMailFlag = async (
  deps: MailDispatcherDeps,
  input: { slug: string; record_id: string; flagged: boolean },
): Promise<MailMutationOutcome> => {
  const { collection, source_id } = requireMutable(deps, input.slug, input.record_id);
  const flag = requireVerb(
    collection.provider.flagMessage?.bind(collection.provider),
    input.slug,
    'mail-flag',
  );
  const result = await callMailAdapter(input.slug, 'mail-flag', () =>
    flag({ source_id, flagged: input.flagged }));
  const updated = collection.applyVerifiedMutation(input.record_id, result);
  return updated ? outcomeOf(updated, result) : detachedOutcome(result);
};

/** Relocate a message.
 *
 *  Two success shapes, and conflating them is the trap this handler exists
 *  to avoid. When the provider names the message's new identity we re-key
 *  the row and report it. When it CANNOT (IMAP without UIDPLUS — see
 *  `MailMoveOutcome`), the move still happened, so we DROP the local row
 *  and let the destination folder's sync re-ingest it under its real id.
 *  Reporting the second case as a failure would invite a retry of a move
 *  that already succeeded; keeping the row would leave it keyed to a UID
 *  that no longer exists in the source folder. */
export const handleMailMove = async (
  deps: MailDispatcherDeps,
  input: {
    slug: string;
    record_id: string;
    destination: MailMoveDestination;
  },
): Promise<MailMutationOutcome & { rekeyed: boolean }> => {
  const { collection, record, source_id } = requireMutable(
    deps,
    input.slug,
    input.record_id,
  );
  const move = requireVerb(
    collection.provider.moveMessage?.bind(collection.provider),
    input.slug,
    'mail-move',
  );
  // ⚠ Read the pre-move state BEFORE the adapter call, not after the local
  // row is dropped below. `record` is that snapshot. Reaching for
  // `collection.get(record_id)` in the null branch would query a row this
  // handler had just deleted and report `false` for everything — a lie
  // shaped exactly like a real reading.
  const priorRead = record.hot_fields.is_read === true;
  const priorFlagged = record.hot_fields.is_flagged === true;
  const result = await callMailAdapter(input.slug, 'mail-move', () =>
    move({ source_id, destination: input.destination }));

  if (result === null) {
    // Verified moved, identity unnameable. The row must go — and it goes
    // through the SAME cascade-firing path as a delete, because from this
    // collection's point of view the record really is gone: every
    // enrichment and annotation keyed to it is now orphaned.
    await deps.deleteLocalRecord(input.slug, input.record_id);
    return {
      record_id: '',
      // IMAP preserves flags across a MOVE (RFC 6851 §3.3) but does not
      // restate them, and we did not pay a round-trip into the destination
      // mailbox to re-read what its own sync will report shortly. The
      // pre-move values we already held are the honest answer.
      is_read: priorRead,
      is_flagged: priorFlagged,
      folder: input.destination.folder ?? '',
      rekeyed: true,
    };
  }

  const updated = collection.applyVerifiedMutation(input.record_id, result);
  const outcome = updated ? outcomeOf(updated, result) : detachedOutcome(result);
  return { ...outcome, rekeyed: outcome.record_id !== input.record_id };
};

/** Remove a message at the provider, then locally.
 *
 *  ⛔ ADAPTER FIRST. If the local row went first and the provider call then
 *  failed, the message would still be in the user's mailbox with no
 *  warehouse row — invisible to every recipe, and re-ingested as NEW on the
 *  next sync, re-firing any reactive trigger watching that folder. */
export const handleMailDelete = async (
  deps: MailDispatcherDeps,
  input: { slug: string; record_id: string },
): Promise<{ deleted: true; record_id: string }> => {
  const { collection, source_id } = requireMutable(deps, input.slug, input.record_id);
  const remove = requireVerb(
    collection.provider.deleteMessage?.bind(collection.provider),
    input.slug,
    'mail-delete',
  );
  await callMailAdapter(input.slug, 'mail-delete', () => remove({ source_id }));
  await deps.deleteLocalRecord(input.slug, input.record_id);
  // Echo the id so the D-120 provenance link can name what was removed
  // after the row is gone — the same reason `calendar-delete` echoes its
  // `source_id`.
  return { deleted: true, record_id: input.record_id };
};
