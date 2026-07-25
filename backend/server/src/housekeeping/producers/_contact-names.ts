/** Bench harvest (internal benchmarks P1 v6–v12) — the producers'
 *  view of a contact's DISPLAY NAME, for producer-time REF<contacts>
 *  denormalization.
 *
 *  Sibling of `_contact-addresses.ts`, extracted for the same reason: several
 *  contact-touching producers need the same lookup, and each hand-rolled copy
 *  would miss the merge/alias walk.
 *
 *  🔑 **Why producers resolve names at all.** The bench measured the
 *  alternative: values carrying bare emails force the consuming agent into a
 *  per-question `entity.query` resolution loop (enrichment → batched lookups →
 *  answer). Pre-resolving `{ entity, name }` pairs at producer-run time lifted
 *  answer intent 77.9% → 93.3% while cutting mean agent hops 2.18 → 1.13 —
 *  the resolution work happens ONCE per row instead of once per question.
 *
 *  ⚠ A missing name is OMITTED, never fabricated — the resolved-name arrays
 *  carry only the contacts the directory actually names (the validators
 *  require `{ entity, name }` pairs), and subject-level `name` fields are
 *  simply absent when unknown. A consumer that needs the rest still has the
 *  parallel raw-email field (`contacts`, `top_co_attendees[].email`, …). */

import { contactDisplayName } from '../../storage/contact-merge-graph.js';
import { canonicalizeEmail } from '@recued/contracts';
import type { HousekeepingContext } from '../registry.js';

/** One resolved `{ entity, name }` pair — the shape the harvest fields
 *  (`contacts_resolved`, `participant_contacts`) carry per entry. */
export interface ResolvedContactPair {
  entity: string;
  name: string;
}

/** Display name for `email` (merge/alias-aware; see `contactDisplayName`).
 *  `undefined` when the directory has no name for the person. */
export const contactName = (
  ctx: HousekeepingContext,
  email: string,
): string | undefined => contactDisplayName(ctx.db, email);

/** Resolve a set of addresses into the `[{ entity, name }]` surface: one
 *  entry per address the directory NAMES, `entity` canonicalized, sorted by
 *  `entity` for deterministic JSON output. Addresses without a name (or
 *  un-canonicalizable input) are dropped — the caller's parallel raw field
 *  still carries them. */
export const resolvedContactPairs = (
  ctx: HousekeepingContext,
  emails: Iterable<string>,
): ResolvedContactPair[] => {
  const pairs = new Map<string, string>();
  for (const email of emails) {
    const entity = canonicalizeEmail(email);
    if (entity === '' || pairs.has(entity)) continue;
    const name = contactDisplayName(ctx.db, entity);
    if (name !== undefined) pairs.set(entity, name);
  }
  return [...pairs.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([entity, name]) => ({ entity, name }));
};
