/** D-205 #3.5 — the producers' view of a contact's ADDRESS SET.
 *
 *  Sibling of `_email-addresses.ts`, and extracted for the same reason: the
 *  contact-scoped producers all need the same shape, and getting it wrong is
 *  silent.
 *
 *  🔑 **Every contact-scoped producer is a REVERSE read.** It is handed one
 *  contact and goes looking for that contact's rows — commitments by
 *  `counterparty_contact_id`, tasks by `assigned_contact_id`, mail and calendar
 *  by an address inside `hot_fields`. Each of those columns holds an **email**,
 *  whatever its name says.
 *
 *  And nothing moves those rows. A merge records an edge (`merged_into`) and
 *  leaves every row keyed on the address it was written under (D-205 rule 2 —
 *  moving would clobber and destroy the un-merge). So a producer that asks for
 *  ONE address sees only the fraction of the person's history that happened to
 *  land on that address, and computes a confident number over it: a
 *  follow-through score over half the commitments, a meeting frequency over
 *  half the calendar. **The row is not missing. It is unreachable from the
 *  survivor's key** — and the resulting figure is an enrichment fact the model
 *  states to the user as truth.
 *
 *  The fix is uniform and it is the whole of this module: **a producer reads
 *  the contact's ADDRESS SET, never its address.**
 *
 *  ⚠ **A merge is only ONE of the two ways an address joins a person**, and this
 *  module said otherwise for a while — it promised "every address the contact
 *  answers to" and passed through a walk that returned only the merged ones. An
 *  IMPORT attaches a second address as an `email_alias` (vendor records are
 *  multi-valued), and a PROMOTION retires the synthetic one as an `email_alias`
 *  too. Neither is a tombstone; both are addresses rows are keyed on.
 *  `contactAddressSet` now returns the union, so every producer here inherited
 *  the wider set for free — which is the whole reason it is one primitive.
 *
 *  ⚠ With no merges and no aliases the set is exactly `[the address]`, so every
 *  producer is behavior-identical until one exists. This widens the reads; it
 *  does not change them.
 *
 *  See `storage/contact-merge-graph.ts` for the walk itself (forward-resolve to
 *  the terminal survivor → reverse-expand → include the survivor → union the
 *  group's alias space). */

import { contactAddressSet } from '../../storage/contact-merge-graph.js';
import type { HousekeepingContext } from '../registry.js';

/** Every address the contact answers to — its own, every address merged away
 *  into it, and every `email_alias` of the whole merge group. Ascending order;
 *  `[]` only for an unusable input.
 *
 *  This is the value a contact-scoped producer should thread into every query
 *  it runs. Pass `source_record.data.email`. */
export const contactAddresses = (
  ctx: HousekeepingContext,
  email: string,
): string[] => contactAddressSet(ctx.db, email);

/** `?, ?, ?` — a bound-parameter list of the right arity, for
 *  `WHERE <col> IN (…)`. Never interpolate the addresses themselves. */
export const sqlInList = (count: number): string =>
  new Array(Math.max(count, 0)).fill('?').join(', ');

/** `(<col> LIKE ? OR <col> LIKE ? …)` — the JSON pre-narrow the mail / calendar
 *  producers run over `hot_fields`, widened across the address set.
 *
 *  ⚠ This is a PRE-NARROW, not the match. `LIKE '%bob@x%'` also hits
 *  `robbob@x.com` and any address merely quoted in a body; every caller
 *  re-checks the parsed row against `matchesAnyAddress` below, which is the
 *  authoritative test. Widening the pre-narrow can only add candidate rows for
 *  that check to reject — it cannot admit a false positive on its own. */
export const sqlLikeAny = (column: string, count: number): string =>
  new Array(Math.max(count, 1))
    .fill(`${column} LIKE ?`)
    .join(' OR ');

/** The `%…%` params for `sqlLikeAny`, in the same order. */
export const likeAnyParams = (addresses: readonly string[]): string[] =>
  addresses.map((a) => `%${a}%`);

/** Does this row's parsed address set involve the contact at all?
 *
 *  The authoritative match behind the `LIKE` pre-narrow. `parsed` is the set of
 *  canonical addresses a producer collected from one row (mail From/To/Cc,
 *  calendar organizer + attendees); `addresses` is the contact's address set.
 *  True iff they intersect — i.e. the row involves the person under ANY of the
 *  addresses they answer to. */
export const matchesAnyAddress = (
  parsed: ReadonlySet<string>,
  addresses: readonly string[],
): boolean => addresses.some((a) => parsed.has(a));
