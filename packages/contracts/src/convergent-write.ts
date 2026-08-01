/** The convergent-write primitive — the reusable shape behind the seller pack's
 *  paired procedural recipes (D-196), extracted 2026-07-27 so a second op can
 *  adopt it by construction instead of re-deriving it.
 *
 *  ── What it is ────────────────────────────────────────────────────────
 *  A write that is **replay-safe on a domain key**: called twice with the same
 *  identity it does not duplicate anything, it advances a field. The return
 *  value says which branch the RECORD took, not which caller ran:
 *
 *    - `'created'`  — no record existed for that key; it was minted, and any
 *                     one-shot side effects (a token, a claim, an email) fired
 *                     exactly here.
 *    - `'extended'` — a record existed; only the advancing field moved. **No
 *                     one-shot side effect may fire on this branch.**
 *
 *  `core.seller.customer-access.issue` is the reference implementation:
 *  `findCustomerBySource(...)` → found ⇒ extend `current_period_end`; not found
 *  ⇒ stamp the customer-instance contract from the tier template, mint the bound
 *  inbound token, issue the one-time claim.
 *
 *  ── Why it exists: continuity without a continuity store ──────────────
 *  This is what lets a pair of recipes carry a cycle across its boundary with
 *  NO engine-held state — the seller pack's procedural recipes reference no
 *  `context.recipe.*`, no `data.shared`, no enrichment row:
 *
 *    1. a PROCEDURAL recipe fires at the boundary (a webhook, an event) and
 *       calls the convergent op with the new cursor value;
 *    2. a RECONCILE recipe re-derives the same state from the source of truth
 *       and calls the SAME op — safe at any time, because a replay converges.
 *
 *  The cursor is supplied by whoever owns the boundary (Stripe's
 *  `current_period_end`), so neither recipe has to remember anything. Contrast
 *  `context.recipe.*` (manual/cron run-to-run snapshots) and a `data.shared`
 *  cursor: both are RESUMPTION — "where was I?" — and both fail SILENTLY when
 *  the state is missing or stale, redoing or skipping work at `success: true`.
 *  A convergent write has no silent-redo mode: re-derivation IS the recovery
 *  path. Prefer it whenever there is a per-record identity to key on.
 *  See internal design notes.
 *
 *  ── ⛔ The safety rule that must travel with the pattern ──────────────
 *  **Converge on the advancing field; REFUSE on an identity change.** The
 *  reference op throws rather than converging when the requested tier differs
 *  from the stored one (*"issue cannot change an existing customer tier; use
 *  swapCustomerTier"*) — a tier move is a different operation with different
 *  consequences, and silently absorbing it into an "extend" would re-tier a
 *  paying customer with no audit of the change. An adopter that widens this to
 *  "upsert whatever I was given" loses the property the shape is named for.
 *
 *  Two more invariants, both learned from the reference implementation:
 *   - **One-shot effects belong to `'created'` only.** If a side effect can be
 *     observed twice (a second token, a duplicate email), the write is not
 *     convergent no matter what it returns.
 *   - **The advancing field must be monotonic in the source's terms.** The
 *     caller passes the boundary value it read; the op does not invent one. */

/** Which branch a convergent write took — `'created'` on first write for the
 *  key (one-shot side effects fire here and only here), `'extended'` on a
 *  replay (the advancing field moved; nothing else did). */
export type ConvergentWriteResult = 'created' | 'extended';

/** Every value {@link ConvergentWriteResult} admits — for exhaustiveness tests
 *  and any UI that labels the outcome. Derive from this rather than re-typing
 *  the union at a second site. */
export const CONVERGENT_WRITE_RESULTS: readonly ConvergentWriteResult[] = [
  'created',
  'extended',
];
