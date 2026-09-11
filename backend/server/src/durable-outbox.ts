/** The durable outbox: one delivery loop, many message families, many transports.
 *
 *  A recipe writes a coalescing hint for an MCP token; a peer ask waits for its
 *  answer; a fleet job waits for the worker's client to look. All three are the
 *  same problem — **a message that must survive a disconnect, arrive at least
 *  once, be deduped by the receiver, and be authorised at DELIVERY rather than
 *  at enqueue** — and all three differ only in what the row says and where the
 *  bytes go. This module owns the part that is the same.
 *
 *  ── Why the family supplies ACCESSORS and not a row shape ─────────
 *  ⛔ THE ROWS ARE ALREADY IN LIVE STORES. A generic wrapper — `{ envelope,
 *  payload }`, a renamed `dedupe_ref` field — would be a migration of every
 *  persisted mailbox on every server, dressed up as a refactor. So a family
 *  keeps its own value shape verbatim and tells the loop how to READ it
 *  (`principalOf`, `dedupeRefOf`, …) and how to REWRITE it
 *  (`retiredValue`, `deliveredValue`). Nothing about the bytes changes when a
 *  family adopts this, which is what makes adoption provable rather than
 *  hopeful: the family's existing tests are the proof.
 *
 *  ── The five rules the loop owns, and why each exists ─────────────
 *  1. **Authority is re-derived per delivery, never captured.** A channel
 *     outlives the request that opened it: a token revoked, a contract expired
 *     or a grant withdrawn one minute after the stream opened must silence the
 *     NEXT notification. `authorize` is called for every row, every poll.
 *     ⛔ A failed authorisation SKIPS, it does not retire — authority can come
 *     back, and retiring would turn a temporary refusal into permanent loss.
 *     ⚠ THIS RULE GOVERNS DELIVERY, NOT RETENTION, AND THE FIRST ADOPTER DOES
 *     THE OPPOSITE IN ITS OTHER PATH — which a reader of rule 1 alone would get
 *     wrong. `sweepMcpRecipeCallbackRetention` RETIRES on the same denial, and
 *     that is deliberate: retention is data minimisation, it is invoked
 *     explicitly on grant/revoke/delete, and the point is to stop STORING a
 *     payload addressed to a principal who may no longer receive it. Delivery
 *     asks "may I send this now"; retention asks "may I still keep this". The
 *     answers differ, and both are right — but only if the difference is
 *     written down, so nobody "fixes" one into the other.
 *  2. **Send, then mark.** The durable marker advances only after the transport
 *     confirms its write, so a thrown send leaves the row exactly as it was and
 *     the next poll retries the same `dedupe_ref`. That is the at-least-once
 *     edge the receiver's dedupe token exists to absorb.
 *  3. **A losing CAS is not an error.** A concurrent enqueue advancing the row
 *     WINS; the delivery marker must never overwrite a fresher message. Both
 *     writes swallow their conflict for that reason and only that reason.
 *  4. **A row addressed elsewhere, unparseable, or expired RETIRES** to the
 *     family's minimal terminal value — keeping the revision fence so a
 *     delete/recreate cannot ABA past it, while dropping the content.
 *  5. **Readiness gates delivery, and is not authority.** A transport that has
 *     not finished its handshake cannot receive; that is a liveness fact about
 *     the wire, so it is a separate gate from `authorize` and neither stands in
 *     for the other.
 *
 *  ⚠ WHAT THIS DELIBERATELY DOES NOT DO. No retry counters, no backoff, no
 *  batching, no ordering guarantee, no ack round-trip. Every one of those is a
 *  thing the current families do not have, and a delivery loop that grows them
 *  speculatively is how a coalescing hint quietly becomes a queue with
 *  semantics nobody chose. Add one only with the family that needs it.
 *
 *  First adopter: `mcp-recipe-callback.ts`. ⛔ AND THE PREDICTED SECOND WAS
 *  WRONG — recorded because the reasoning is the useful part. This header used
 *  to name an MCP `subscriptions/listen` projection as the natural next family.
 *  That projection shipped (`mcp-subscriptions.ts`) and correctly uses NOTHING
 *  from this module: what it sends is `tools/list_changed`, a hint that the
 *  receiver's catalog is stale. A hint whose only content is "re-read" is
 *  RECOMPUTABLE — the client re-lists on reconnect anyway — so it needs no
 *  durability, no dedupe ref, and no delivery marker. Re-sending it is free and
 *  losing it costs a refresh, not a fact.
 *
 *  🔑 The test this module is for is not "does a message cross a disconnect"
 *  but "would the receiver be unable to RECONSTRUCT it". A coalescing pointer
 *  to durable state passes; a stale-cache hint does not.
 *
 *  ⛔ **THE PEER ASK OUTBOX WAS EXAMINED AND DOES NOT FIT — do not attempt the
 *  port.** It shares the word and the doctrine, not the shape:
 *    · **Storage.** `peer-ask-outbox-store.ts` is its own SQLite table behind a
 *      typed 5-method API (`open`/`stage`/`activate`/`markDelivered`/
 *      `markRefused`), not CAS rows in `data.shared`. Adapting it means either
 *      migrating live peer state or widening this module's store port until it
 *      is a union of two shapes with extra steps.
 *    · **"Delivered" is a RECEIPT, not a marker.** Peer runs
 *      `staged → pending → delivered | refused` and carries `continuation_claimed`
 *      as a no-replay fence, because it waits for the receiver's explicit
 *      durable-ask receipt or a refusal WITH A REASON. Rule 2 above is weaker
 *      than that on purpose; making it stronger for one family would hand every
 *      other family an ack round-trip it never asked for.
 *    · **The trigger is inverted.** Here the sweep IS delivery. There, delivery is
 *      inline at ask time in `execute-handler`, and the `listDeliveries()` loop in
 *      `peer-ask-delivery-recovery.ts` is CRASH RECOVERY. Same code shape,
 *      opposite role.
 *
 *  🔑 What the two genuinely share is the DOCTRINE, and both already implement
 *  it independently: authority re-derived at delivery (peer gates exposure going
 *  out and correlation coming back), at-least-once with receiver-side dedupe on
 *  an immutable ref (`exchange_ref` ↔ `callback_ref`), and a losing write that
 *  never clobbers a fresher one (`markRefused` "atomically loses to an
 *  already-recorded answer"). Writing the doctrine down once is the unification
 *  that was available; a shared loop was not. */

import {
  SharedCompareAndSetConflictError,
  type SharedRecord,
  type SharedStore,
} from './storage/shared-store.js';

/** How the loop reads and rewrites one family's rows.
 *
 *  Every member exists because the loop performs exactly one behaviour that
 *  needs it; there is no member here that a family may leave unimplemented and
 *  no behaviour the loop performs that is not visible in this list. */
export interface OutboxFamily<Entry, Payload> {
  /** CAS author for every write the loop makes on this family's behalf. Also
   *  the guard that stops the loop retiring a row it does not own. */
  readonly author_id: string;
  /** Key namespace holding one principal's rows. */
  prefix(principal: string): string;
  /** Parse one stored row, or `null` when it is not this family's, is
   *  malformed, or is already terminal. */
  parse(record: SharedRecord): Entry | null;
  /** True when the row already holds this family's terminal shape — checked so
   *  a retire pass never rewrites a retired row and burns a revision. */
  isRetired(record: SharedRecord): boolean;
  /** Who the row is addressed to. A mismatch against the channel's principal
   *  retires it: a row addressed elsewhere in this principal's namespace is
   *  injected or replayed, never merely stale. */
  principalOf(entry: Entry): string;
  /** The receiver-visible token that distinguishes "a new message" from "the
   *  one you already have". */
  dedupeRefOf(entry: Entry): string;
  /** The dedupe token this row was last DELIVERED with, when it has been. */
  deliveredRefOf(entry: Entry): string | undefined;
  /** Terminal instant. At or past it the row retires instead of delivering. */
  expiresAtOf(entry: Entry): number;
  /** The minimal terminal value: revision fence kept, content dropped. */
  retiredValue(revision: number, retired_at: number): unknown;
  /** The row rewritten with its delivery marker, in the family's own shape. */
  deliveredValue(entry: Entry, revision: number, delivered_at: number): unknown;
  /** What the transport actually sends. One family may have several — an MCP
   *  notification and a peer envelope carry the same row differently. */
  project(entry: Entry): Payload;
}

/** One open channel to one principal over one transport. */
export interface OutboxDeliveryDeps<Entry, Payload> {
  store: Pick<SharedStore, 'list' | 'read' | 'compareAndSet'>;
  /** The addressee this channel serves — an MCP token id today. */
  principal: string;
  /** Re-derived per delivery. See rule 1. */
  authorize(entry: Entry): boolean;
  /** Resolves only when the transport has accepted the bytes; a rejection
   *  leaves the row undelivered and retryable. See rule 2. */
  send(payload: Payload): Promise<void> | void;
  now?: () => number;
  /** Called when a delivery marker could not be written for a reason that is
   *  NOT a CAS conflict — a storage fault, not contention. Advisory: the send
   *  already happened and the receiver's dedupe absorbs the retry. */
  onMarkerWriteFailed?(key: string, error: unknown): void;
}

export interface OutboxDelivery {
  /** Sweep this principal's rows once. Re-entrant calls collapse. */
  poll(): Promise<void>;
  /** The transport finished its handshake and can receive. See rule 5. */
  setReady(): void;
}

export const createOutboxDelivery = <Entry, Payload>(
  family: OutboxFamily<Entry, Payload>,
  deps: OutboxDeliveryDeps<Entry, Payload>,
): OutboxDelivery => {
  const prefix = family.prefix(deps.principal);
  /** Dedupe within this process, so a marker whose CAS lost to a concurrent
   *  enqueue does not re-send the same ref on the next poll. */
  const locallyDelivered = new Map<string, string>();
  let ready = false;
  let pollInFlight = false;

  const markDelivered = async (
    key: string,
    record: SharedRecord,
    entry: Entry,
    delivered_at: number,
  ): Promise<void> => {
    if (record.cas_revision === null) return;
    try {
      await deps.store.compareAndSet(
        key,
        record.cas_revision,
        family.deliveredValue(entry, record.cas_revision + 1, delivered_at),
        { author_id: family.author_id },
      );
    } catch (error) {
      // Rule 3 — a concurrent enqueue advancing the row is not a delivery
      // failure. The next poll observes the fresh ref; never overwrite it with
      // the old delivery marker.
      //
      // ⚠ A CONFLICT AND A STORAGE FAULT ARE NOT THE SAME EVENT, and this used
      // to swallow both identically. They diverge in what happens next: after a
      // conflict the row already carries a FRESHER ref, so skipping is right;
      // after an I/O fault the row still carries the ref we just delivered and
      // no marker, so the process-local dedupe is now the only thing preventing
      // a re-send — and it dies with the process. That is still within the
      // at-least-once contract (the receiver dedupes on `dedupe_ref`), so it is
      // not escalated — but a silent storage fault deserves to be visible
      // rather than indistinguishable from ordinary contention.
      if (!(error instanceof SharedCompareAndSetConflictError)) {
        deps.onMarkerWriteFailed?.(key, error);
      }
    }
  };

  const retire = async (
    key: string,
    record: SharedRecord,
    retired_at: number,
  ): Promise<void> => {
    if (
      record.author_id !== family.author_id
      || record.cas_revision === null
      || family.isRetired(record)
    ) return;
    try {
      await deps.store.compareAndSet(
        key,
        record.cas_revision,
        family.retiredValue(record.cas_revision + 1, retired_at),
        { author_id: family.author_id },
      );
    } catch {
      // Rule 3 again — a concurrent enqueue or retention pass advanced the
      // row. The next poll evaluates the fresh revision; never overwrite it.
    }
  };

  const poll = async (): Promise<void> => {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      const rows = await deps.store.list(prefix);
      // A4 — drop marks for keys the listing no longer carries. Without this
      // the map keeps one entry per key ever delivered, for the life of the
      // watcher: a long-lived channel whose rows keep expiring into tombstones
      // grows it without bound, because nothing else ever removed a key.
      const present = new Set(rows.map((row) => row.key));
      for (const key of [...locallyDelivered.keys()]) {
        if (!present.has(key)) locallyDelivered.delete(key);
      }
      for (const row of rows) {
        const record = await deps.store.read(row.key);
        if (record === null) continue;
        const entry = family.parse(record);
        const now = deps.now?.() ?? Date.now();
        if (
          entry === null
          || record.cas_revision === null
          || family.principalOf(entry) !== deps.principal
        ) {
          await retire(row.key, record, now);
          continue;
        }
        if (family.expiresAtOf(entry) <= now) {
          await retire(row.key, record, now);
          continue;
        }
        const ref = family.dedupeRefOf(entry);
        if (family.deliveredRefOf(entry) === ref) continue;
        if (locallyDelivered.get(row.key) === ref) continue;
        // Rule 1 + rule 5. A refusal SKIPS — the row stays deliverable for the
        // moment authority or readiness returns.
        if (!ready || !deps.authorize(entry)) continue;

        // Rule 2 — the markers advance only after the transport confirms.
        await deps.send(family.project(entry));
        locallyDelivered.set(row.key, ref);
        await markDelivered(row.key, record, entry, now);
      }
    } finally {
      pollInFlight = false;
    }
  };

  return {
    poll,
    setReady() {
      ready = true;
    },
  };
};
