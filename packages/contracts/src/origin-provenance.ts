/** D-161 Part B (P1) — the `origin_actor` provenance facet.
 *
 *  D-161 Part A collapsed the `Actor` enum to identity-only and stops
 *  at the Gateway (it governs *execution*). Part B propagates that one
 *  actor model into the data substrate as a provenance facet stamped on
 *  every `data.*` warehouse row, `data.memory` entry, provenance link,
 *  and `data_enrichment` row — so outside-actor content (Reception
 *  `anonymous`, MCP `contracted_user`) is no longer indistinguishable
 *  from the user's own.
 *
 *  This is a **propagation, not a parallel model** (I-6 / N.7): the
 *  facet's `origin_actor` is *copied* from the writing run's
 *  `ExecutionSource.actor` — never re-derived from a second data-side
 *  enum. The same `Actor` type from `commits.ts` is the single source of
 *  truth. D-120's per-row `event_at` / `run_mode` stamping is the
 *  precedent; `origin_actor` is the same kind of move, stamped at the
 *  same write time.
 *
 *  `origin_actor` is the **warehouse-write actor** (A.5 / TR-11) — the
 *  actor of the execution that *wrote the row*. A mail row written by
 *  the mail adapter during a `schedule` sync run carries
 *  `origin_actor = 'system'`; a contact annotation an MCP agent writes
 *  carries `'contracted_user'`; a Reception form submission — and, since
 *  D-209 #1 W3, a webhook-fired recipe's writes — carry `'anonymous'`
 *  (an outside party's dispatch, under a door contract). It is NOT the
 *  content's authorship (an email's human `From:` sender) — that is
 *  D-139's separate `authorship` classifier.
 *
 *  Spec: docs/d-161-spec.md § N.7 / A.4 / A.5 / I-5 / I-6.
 */

import type { Actor, ExecutionSource } from './commits.js';
import { executionSourceContractId, isActor } from './commits.js';

/** The provenance facet stamped on every warehouse / memory / link /
 *  enrichment row. `origin_actor` is the actor of the execution that
 *  WROTE the row; `origin_contract_id` is the contract in force on that
 *  execution, present exactly when the source carried a `contract_id`
 *  (the same condition that governs `contract_snapshot` presence on a
 *  commit — D-161 N.4). */
export interface OriginProvenance {
  /** The write-actor — propagated from the run's `ExecutionSource.actor`
   *  (or `'system'` for engine-internal sync / housekeeping writes that
   *  carry no execution source). Never re-derived from a data-side enum
   *  (I-6). */
  origin_actor: Actor;
  /** The contract in force on the writing execution, when contracted.
   *  Present iff the source carried a `contract_id` (a `contracted_user`,
   *  or a self-restricted `user_self`); absent otherwise. */
  origin_contract_id?: string;
}

/** Derive the facet from a run's `ExecutionSource` — the canonical
 *  propagation (I-6: copy `source.actor`, never re-derive).
 *  `origin_contract_id` is included exactly when the source carries a
 *  `contract_id` (read variant-agnostically via
 *  `executionSourceContractId`, so a self-restricted `user_self` is
 *  covered — not just `contracted_user`). */
export const originProvenanceFromSource = (
  source: ExecutionSource,
): OriginProvenance => {
  const contract_id = executionSourceContractId(source);
  return contract_id !== undefined
    ? { origin_actor: source.actor, origin_contract_id: contract_id }
    : { origin_actor: source.actor };
};

/** The canonical origin for engine-internal writes that carry no
 *  `ExecutionSource` — adapter sync loops, housekeeping producers,
 *  vendor reconcilers. These are `'system'` by construction (the
 *  `schedule` / `reactive` / `housekeeping` channels all pin
 *  `actor: 'system'`; a webhook-fired RECIPE run carries its typed
 *  `(webhook, anonymous)` source, D-209 #1 W3 — never this default),
 *  so an absent source resolves to `system` — the spec's stated
 *  mail-sync example (A.5). Frozen so the shared reference can be
 *  spread safely without risk of mutation. */
export const SYSTEM_ORIGIN: OriginProvenance = Object.freeze({
  origin_actor: 'system',
});

/** Derive the facet from an optional `ExecutionSource`, defaulting to
 *  `SYSTEM_ORIGIN` when absent. The convenience the write sites use:
 *  a recipe-driven write threads its run source → the run's actor; a
 *  sync / housekeeping write omits it → `system`. */
export const originProvenanceFromOptionalSource = (
  source: ExecutionSource | undefined,
): OriginProvenance =>
  source !== undefined ? originProvenanceFromSource(source) : SYSTEM_ORIGIN;

/** Build the facet from a loose `(actor, contract_id?)` pair rather than
 *  a full `ExecutionSource`. The write-handler path threads the run's
 *  actor + contract_id through `StepMeta` (mirroring `trigger_source`),
 *  not the whole source object; this composes the facet from those two
 *  threaded fields. An absent `actor` resolves to `SYSTEM_ORIGIN` — a
 *  dispatch path that carried no typed source (legacy direct-rpc, dbless
 *  tests) is treated as engine-internal `system`, the conservative
 *  default. `contract_id` is only attached when `actor` is present (a
 *  contract with no actor is incoherent). */
export const originProvenanceFromActor = (
  actor: Actor | undefined,
  contract_id?: string,
): OriginProvenance => {
  if (actor === undefined) return SYSTEM_ORIGIN;
  return contract_id !== undefined
    ? { origin_actor: actor, origin_contract_id: contract_id }
    : { origin_actor: actor };
};

/** Structural predicate — true when `value` matches `OriginProvenance`:
 *  `origin_actor` is a known `Actor` and `origin_contract_id`, when
 *  present, is a string. Narrows untyped JSON read back from a row. */
export const isOriginProvenance = (value: unknown): value is OriginProvenance => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!isActor(v.origin_actor)) return false;
  if (
    v.origin_contract_id !== undefined
    && typeof v.origin_contract_id !== 'string'
  ) {
    return false;
  }
  return true;
};

// ────────────────────────────────────────────────────────────────
// D-177 N.11 rule 1 — the origin SURFACE facet + stored-cleanliness
// ────────────────────────────────────────────────────────────────

/** D-177 N.11 rule 1 follow-on — the write SURFACE facet, stamped
 *  alongside `origin_actor` on the user-writable warehouse families
 *  (`data.contact` rows, annotation rows).
 *
 *  `origin_actor` alone cannot carry rule 1's intent ("the model can
 *  never re-aim a destination it — or its agent turns — authored"):
 *  the built-in chat agent and the messenger surface both run as
 *  `(channel, actor: 'user_self')`, so a chat-tool-driven
 *  `contact-upsert` / `data-annotate` write stamps `user_self` even
 *  though the CONTENT is model-authored. The surface facet records the
 *  statically-known injection site instead:
 *
 *  - `'client_rpc'` — the direct paired-client rpc (`contact.upsert`,
 *    `annotation.write`): a human typing into their own webclient /
 *    Bridge over the `user` channel. The ONLY surface whose `user_self`
 *    rows read user-clean.
 *  - `'engine'` — any recipe-run write (kernel `contact-upsert` /
 *    `data-annotate` dispatch), whatever channel drove the run. The
 *    content is recipe- or model-computed even on a user-channel
 *    manual run — never user-clean.
 *  - `'system'` — engine-internal sync / derive / housekeeping writes
 *    (and the column default for every legacy or unstamped path).
 *
 *  Like `origin_actor`, the facet is SERVER-INJECTED at the write
 *  handler (never read from caller args) — each injection site knows
 *  statically which surface it is. */
export const ORIGIN_SURFACES = ['client_rpc', 'engine', 'system'] as const;
export type OriginSurface = (typeof ORIGIN_SURFACES)[number];

/** Predicate — true when `value` is a known `OriginSurface`. */
export const isOriginSurface = (value: unknown): value is OriginSurface =>
  (ORIGIN_SURFACES as readonly unknown[]).includes(value);

/** The provenance facets of one stored warehouse row, as read back for
 *  the D-177 N.11 rule-1 stored-cleanliness gate. A host's
 *  `resolveStoredRowOrigin` (open-projection walk) returns this shape;
 *  `isUserCleanStoredRow` is the one predicate that decides clean. */
export interface StoredRowProvenance {
  /** The row's stamped write-actor (D-161). */
  origin_actor: Actor;
  /** The contract in force on the writing execution, when contracted. */
  origin_contract_id?: string;
  /** The write surface (see `ORIGIN_SURFACES`). Absent on rows written
   *  before the facet existed or by stores that don't stamp it — reads
   *  as NOT user-clean (fail closed). */
  origin_surface?: OriginSurface;
}

/** D-177 N.11 rule 1 — the stored-cleanliness predicate. A stored row
 *  is user-clean (its value may feed a CLEAN open-grant root that
 *  VARIES across fires) iff ALL of:
 *
 *  1. `origin_actor === 'user_self'` — the spec's rule-1 letter;
 *  2. `origin_surface === 'client_rpc'` — the human typed it into
 *     their own paired client. This closes the two launderings the
 *     actor alone admits: the chat/messenger agent writes rows as
 *     `(chat|messenger, 'user_self')`, and a user-channel manual
 *     recipe run writes recipe-/AI-computed content as
 *     `('user', 'user_self')` — both are `'engine'`-surface writes;
 *  3. no `origin_contract_id` — a contracted (self-restricted) write
 *     operates under delegated policy, not the unmediated human.
 *
 *  Everything else — `contracted_user` / `anonymous` / `system`
 *  actors, engine/system surfaces, missing or unknown facets — is NOT
 *  user-clean and the root stays `'stored'` (tainted → pinned), the
 *  fail-closed default the N.11 origin table prescribes. */
export const isUserCleanStoredRow = (row: StoredRowProvenance): boolean =>
  isActor(row.origin_actor)
  && row.origin_actor === 'user_self'
  && row.origin_surface === 'client_rpc'
  && row.origin_contract_id === undefined;
