/** Contact-backed entity-search adapter for the prompt-cache prefetch
 *  middleware (docs/prefetch-middleware-pending-design.md).
 *
 *  Implements `EntitySearchPort` over the per-pair contact warehouse using the
 *  D-167 §1.A prefetch INDEX (not a whole-warehouse scan). The store's
 *  `prefetchCandidates` returns the union of:
 *    · FTS5(name, company) MATCH — fuzzy, accent/casing-folded
 *      (`unicode61 remove_diacritics 2`) token candidates, bm25-ranked;
 *    · exact email-PK matches (`emailRuns`, D-167 B1); and
 *    · `contact_phone_forms` matches — contacts whose phone reduces to a typed
 *      phone form (full E.164 / national / trunk).
 *  That union is a SUPERSET of every contact that could score > 0, so the pure
 *  `scorePrefetchCandidates` re-scores it authoritatively — identical output to an
 *  uncapped brute scan, but at index latency (~0.04ms vs ~42ms@50k) and STORE-WIDE
 *  + COMPLETE at any warehouse size. Two consequences vs the prior recency-capped
 *  scan (`docs/d-167-prefetch-index-and-recall-collision-design.md` §1.A):
 *    1. The §2 ambiguity gate runs on a STORE-WIDE candidate set (no recency-page
 *       truncation), so confident fuzzy name/org wins are restored above 10k
 *       contacts. Retrieval is PER TOKEN, so a flooding token never starves a rarer
 *       one and each token's contention stays exact even past `PREFETCH_FTS_LIMIT`
 *       (it still yields ≥2 matchers → correctly ambiguous) — the adapter passes
 *       `fuzzyComplete: true`.
 *    2. Phone-form uniqueness is STORE-WIDE via `countPhoneForm` (replacing the old
 *       page-local `buildPhoneFormCount`), so `phoneFormsComplete` is always true and
 *       phone-identifier matching stays enabled regardless of warehouse size OR a
 *       capped fuzzy leg (the two completeness signals are independent).
 *  The index lives in the contact store (FTS5 + `contact_phone_forms`, both
 *  trigger-maintained); this adapter only parses the query + wires the store's
 *  retrieval into the scorer. The recall known-value index
 *  (`chat-recall-index.ts`) still uses the capped `listForPrefetchScan` — migrating
 *  it is a separate follow-on (an enumerate-all-for-aliasing shape, not a search).
 *
 *  Read scope (D-157): reads only the per-pair contact list the server already
 *  holds locally. PII (D-167 N.10.1): this port only SCORES + returns candidates;
 *  the prompt-cache middleware contributes them as a STRUCTURED `entity` PromptPart,
 *  and the chat-egress gather aliases that payload against the turn's shared ledger
 *  BEFORE rendering it to prompt text — so the cloud LLM sees the same alias the
 *  matching `contact.search` tool result carries, never the raw email/name.
 */

import { buildQueryContext, scorePrefetchCandidates } from './chat-prefetch-score.js';

import type { EntitySearchPort } from '@recued/middleware-prompt-cache';

import type { ContactStore } from './storage/contact-store.js';

/** Build an `EntitySearchPort` from a late-bound contact-store getter
 *  (the boot wiring already threads `getContactStore`). Returns `[]`
 *  whenever the store is absent (pre-boot / no warehouse) — the prefetch
 *  middleware then contributes nothing (zero-harm). */
export const createContactPrefetchSearch = (
  getContactStore: () => ContactStore | undefined,
): EntitySearchPort => (query) => {
  const store = getContactStore();
  if (store === undefined) return [];

  // Parse the query once (normalised tokens + phone/email identifier runs).
  const qctx = buildQueryContext(query);
  if (qctx.isEmpty) return [];

  // Phone-form lookup keys = the query's digit-strings (bare numeric tokens ∪
  // reconstructed phone runs). A non-digit name token can't equal a stored phone
  // form, so it's filtered out — keeping the form `IN (...)` lookup lean. This is a
  // superset of what the scorer's phone block can hit (full matches a bare token OR
  // a run; national matches a run); the scorer re-applies the precise rules.
  const forms = [...new Set(
    [...qctx.queryTokens, ...qctx.phoneRunSet].filter((t) => /^\d+$/.test(t)),
  )];

  let rows: ReturnType<ContactStore['prefetchCandidates']>;
  try {
    rows = store.prefetchCandidates({
      tokens: [...qctx.queryTokens],
      forms,
      emails: [...qctx.emailRunSet],
    });
  } catch {
    return [];
  }

  // Both completeness signals are true: retrieval is store-wide and per-token capping
  // keeps each token's §2 contention EXACT (a token over its cap still retrieves ≥2
  // matchers → correctly ambiguous), so the fuzzy set never needs a global
  // fail-closed; and phone-form uniqueness is store-wide via `countPhoneForm` (the
  // FULL E.164 is unique absent a duplicate row; national/trunk forms can collide
  // across countries, so the scorer still gates on this oracle). The scorer's cheap
  // query-membership check guards each `countPhoneForm`, so a non-phone query issues
  // no counts. A contact carrying no email is skipped inside the scorer.
  const isUnique = (digits: string): boolean => store.countPhoneForm(digits) === 1;

  return scorePrefetchCandidates(rows, {
    ...qctx,
    limit: query.limit,
    fuzzyComplete: true,
    phoneFormsComplete: true,
    isUnique,
  });
};
