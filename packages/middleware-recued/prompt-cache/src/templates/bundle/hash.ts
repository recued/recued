/** D-164 P4g-1 — bundle entry content hash.
 *
 *  Computes the deterministic content-addressed hash for a bundle
 *  entry. The hash is recued.com's distribution identity: the server
 *  publishes (key → hash) lookup tuples, the client downloads the
 *  template body by hash, and verifies on the client side that the
 *  received content rehashes to the claimed hash. Identical content
 *  → identical hash; any byte change in `body` / `slot_grammar` /
 *  `locale` → a different hash. The local in-memory bundle pool
 *  (this slice) uses the same function to verify that each registered
 *  entry's pre-computed `template_hash` matches its content — a
 *  cheap registration-time consistency check that catches typos in
 *  hand-authored test fixtures + drift between a fetched manifest
 *  and the body it claims to identify.
 *
 *  Hash inputs (everything else excluded):
 *    - `body` — the {{path}} format string.
 *    - `slot_grammar` — sorted *multiset* of slot kinds. Sorted so
 *      authoring order doesn't matter; duplicates preserved so
 *      `[name, name]` and `[name]` hash to different values (matches
 *      the library's multiset match rule).
 *    - `locale` — per-registration locale; same content in different
 *      locales gets different hashes (correct for distribution).
 *
 *  Hash inputs EXCLUDED (constant per RenderTemplate construction):
 *    - `kind` — always `'render_template'` at this scope.
 *    - `action_class` — always `'read'`.
 *    - `short_circuit_eligible` — always `true`.
 *    - `template_hash` — circular if included; this function COMPUTES
 *      it, and the validator compares the result against the entry's
 *      pre-declared value.
 *
 *  Implementation:
 *    - `canonicalJSONStringifyStrict` (`@recued/crypto`) produces a
 *      deterministic byte sequence — sorted object keys, no
 *      whitespace, primitives via JSON.stringify, throws on BigInt /
 *      function / symbol / non-finite numbers (the kinds of values
 *      that would silently coerce in lenient mode).
 *    - `node:crypto`'s `createHash('sha256')` digests the canonical
 *      bytes to a 64-char lowercase hex string. SHA-256 is the project
 *      standard for content-addressing (see backend/server/src/
 *      upstream-merge-handler.ts `sha256Hex`).
 *
 *  See: docs/d-164-prompt-cache-consolidation-pending-design.md
 *  § 1 templates/bundle / § 3 the deterministic gate (bundle path:
 *  recued.com hash-pinned, content-addressed, verifiable). */

import { createHash } from 'node:crypto';

import { canonicalJSONStringifyStrict } from '@recued/crypto';

import type { SlotName } from '../../types.js';

/** Inputs to the hash. Mirrors a `RegisteredTemplate { template, locale }`
 *  but flat — callers can pull the fields they need without constructing
 *  a `RenderTemplate` shell first. */
export interface BundleHashInput {
  readonly body: string;
  readonly slot_grammar: ReadonlyArray<SlotName>;
  readonly locale: string;
}

/** Compute the deterministic content-addressed hash for a bundle
 *  entry. Pure: same inputs → same 64-char lowercase hex string. */
export const computeBundleEntryHash = (input: BundleHashInput): string => {
  const sortedGrammar = [...input.slot_grammar].sort();
  const canonical = canonicalJSONStringifyStrict({
    body: input.body,
    locale: input.locale,
    slot_grammar: sortedGrammar,
  });
  return createHash('sha256').update(canonical).digest('hex');
};
