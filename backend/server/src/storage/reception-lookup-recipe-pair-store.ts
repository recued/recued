/** D-240 slice 3b — the endpoint → LOOKUP-recipe binding.
 *
 *  A second recipe on the same endpoint, bound separately from the submit one
 *  and running on the visitor's GET rather than their POST.
 *
 *  ## ⛔⛔ WHY THIS IS ITS OWN TABLE AND NOT A SECOND SLOT ON THE PAIR ROW
 *
 *  `reception_intake_recipe_pair` looked like the obvious home — it is already
 *  "every endpoint→recipe pair" and keyed `endpoint_id`. But its binding is a
 *  `ReceptionPairBinding` union carrying three revisions, a `form_definition_id`
 *  integrity cross-check, and paid-checkout claim-configuration readiness and
 *  authoring arms. A read-only lookup recipe has NONE of that, and putting it
 *  there would have dragged every one of those fields into a shape that cannot
 *  use them — the well-worn machinery re-importing what the design removed.
 *
 *  It also has ONE `contract_id` column, and D-207 §5.1c is explicit that the
 *  contract is per-RECIPE. Two recipes need two contracts, which is two rows
 *  however they are stored.
 *
 *  ⇒ A narrow table with exactly the four things a lookup door is: which
 *  endpoint, which recipe, which bytes of it were consented to, and which
 *  contract that consent minted.
 *
 *  ## The shape it DOES share
 *
 *  `findByEndpoint` / `setContractId` satisfy {@link ReceptionDoorContractLink},
 *  so `bindReceptionDoor` drives this table unchanged — including the §3c rule
 *  that a door owing the visitor a synchronous response cannot write, which is
 *  the rule a viewback door most needs and the one a bespoke bind would most
 *  plausibly have dropped.
 *
 *  Spec: D-240 § D12. */

import type Database from 'better-sqlite3';

export const RECEPTION_LOOKUP_RECIPE_PAIR_TABLE = 'reception_lookup_recipe_pair';

export interface ReceptionLookupRecipePairSummary {
  readonly endpoint_id: string;
  readonly recipe_id: string;
  /** The recipe's content hash AT BIND — a RECORD of which bytes the owner saw,
   *  for display and audit.
   *
   *  ⛔⛔ NOT A DISPATCH GATE, and an earlier version of this comment said it was
   *  — citing D-177 N.3, where pinning `recipe_hash` "makes recipe-content drift
   *  invalidate the grant naturally". That is the SESSION-GRANT posture, and this
   *  is a DOOR. The reception door's rule is the opposite and is deliberate:
   *  `bindReceptionDoor` re-binds silently when `doorCapabilityChanged` reports
   *  no change, *"however much the recipe's bytes changed — this is the case that
   *  keeps the consent surface trustworthy"*.
   *
   *  ⇒ Gating dispatch on the exact hash would break a live viewback link on any
   *  cosmetic edit — a relabelled block, a reworded string — and it would make
   *  THIS door behave differently from the submit door beside it on the same
   *  endpoint. The runner checks AUTHORITY drift (`doorCapabilityChanged`), the
   *  same as the submit side. */
  readonly recipe_hash: string;
  /** `null` until a door is minted. SAFE, not open: the dispatch then carries no
   *  `contract_id` and an anonymous source floors to `PUBLIC_CONTRACT_ID`, which
   *  grants nothing — the same reasoning the intake pair row records. */
  readonly contract_id: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface ReceptionLookupRecipePairStore {
  findByEndpoint(endpoint_id: string): ReceptionLookupRecipePairSummary | null;
  upsert(input: {
    readonly endpoint_id: string;
    readonly recipe_id: string;
    readonly recipe_hash: string;
    readonly now: number;
  }): ReceptionLookupRecipePairSummary;
  setContractId(input: { endpoint_id: string; contract_id: string | null }): void;
  /** Remove the binding entirely. Returns whether a row was there. */
  clear(endpoint_id: string): boolean;
}

interface LookupPairRow {
  endpoint_id: string;
  recipe_id: string;
  recipe_hash: string;
  contract_id: string | null;
  created_at: number;
  updated_at: number;
}

export class ReceptionLookupRecipePairStoreError extends Error {
  constructor(detail: string) {
    super(`reception_lookup_recipe_pair_invalid: ${detail}`);
    this.name = 'ReceptionLookupRecipePairStoreError';
  }
}

export const ensureReceptionLookupRecipePairSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${RECEPTION_LOOKUP_RECIPE_PAIR_TABLE} (
      endpoint_id  TEXT PRIMARY KEY,
      recipe_id    TEXT NOT NULL,
      recipe_hash  TEXT NOT NULL,
      contract_id  TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
  `);
};

const cleanId = (value: unknown, field: string): string => {
  if (typeof value !== 'string') {
    throw new ReceptionLookupRecipePairStoreError(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ReceptionLookupRecipePairStoreError(`${field} must be non-empty`);
  }
  if (trimmed.length > 256) {
    throw new ReceptionLookupRecipePairStoreError(`${field} is too long`);
  }
  return trimmed;
};

export const createReceptionLookupRecipePairStore = (
  db: Database.Database,
): ReceptionLookupRecipePairStore => {
  ensureReceptionLookupRecipePairSchema(db);

  const selectStmt = db.prepare(
    `SELECT endpoint_id, recipe_id, recipe_hash, contract_id, created_at, updated_at
     FROM ${RECEPTION_LOOKUP_RECIPE_PAIR_TABLE} WHERE endpoint_id = ?`,
  );
  // ⛔⛔ `contract_id` IS NOT IN THE UPDATE SET, SO A RE-BIND PRESERVES IT — and
  // that is REQUIRED, not incidental. `bindReceptionDoor` runs AFTER this upsert
  // and reads the existing `contract_id` off the row to do two things: compute
  // the widening-consent diff against the stored contract, and RETIRE the old
  // door before minting the new one. Clearing it here would make every re-bind
  // look like a first bind — so the diff would always ask for consent, and the
  // previous contract would never be revoked. A live contract granting the
  // public authority, with no row pointing at it.
  //
  // ⚠ The window this leaves is real and is closed one layer up: between the
  // upsert and the mint the row names the NEW recipe and the OLD contract. The
  // bind's own retire-then-mint ordering closes it on success, and
  // `bindReceptionLookupDoor` rolls the row back on every non-bound outcome.
  // ⇒ A caller that upserts without then binding is the unsafe path; there is
  // exactly one caller, and it does both.
  const upsertStmt = db.prepare(
    `INSERT INTO ${RECEPTION_LOOKUP_RECIPE_PAIR_TABLE}
       (endpoint_id, recipe_id, recipe_hash, contract_id, created_at, updated_at)
     VALUES (@endpoint_id, @recipe_id, @recipe_hash, NULL, @now, @now)
     ON CONFLICT(endpoint_id) DO UPDATE SET
       recipe_id = @recipe_id,
       recipe_hash = @recipe_hash,
       updated_at = @now`,
  );
  // ⛔⛔ `updated_at` IS DELIBERATELY UNTOUCHED, and the reason is inherited rather
  // than invented: `reception-intake-recipe-pair-store` records that it is the
  // BINDING's concurrency token, and moving it on a contract link made the bind
  // rpc CONFLICT WITH ITSELF — bind → `needs_consent` → the owner confirms with
  // the token they were handed → the mint moves the token → the bind's own
  // post-write currency check sees a changed pair and 409s. The door would be
  // minted and the owner told it failed. The door is DERIVED from the binding;
  // linking it is not a change to the binding.
  const setContractStmt = db.prepare(
    `UPDATE ${RECEPTION_LOOKUP_RECIPE_PAIR_TABLE}
     SET contract_id = @contract_id WHERE endpoint_id = @endpoint_id`,
  );
  const deleteStmt = db.prepare(
    `DELETE FROM ${RECEPTION_LOOKUP_RECIPE_PAIR_TABLE} WHERE endpoint_id = ?`,
  );

  const read = (endpoint_id: string): ReceptionLookupRecipePairSummary | null => {
    const row = selectStmt.get(endpoint_id) as LookupPairRow | undefined;
    return row === undefined
      ? null
      : {
          endpoint_id: row.endpoint_id,
          recipe_id: row.recipe_id,
          recipe_hash: row.recipe_hash,
          contract_id: row.contract_id,
          created_at: row.created_at,
          updated_at: row.updated_at,
        };
  };

  return {
    findByEndpoint: (endpoint_id) => read(cleanId(endpoint_id, 'endpoint_id')),

    upsert(input) {
      const endpoint_id = cleanId(input.endpoint_id, 'endpoint_id');
      const recipe_id = cleanId(input.recipe_id, 'recipe_id');
      const recipe_hash = cleanId(input.recipe_hash, 'recipe_hash');
      if (!Number.isFinite(input.now)) {
        throw new ReceptionLookupRecipePairStoreError('now must be a finite number');
      }
      upsertStmt.run({ endpoint_id, recipe_id, recipe_hash, now: input.now });
      const stored = read(endpoint_id);
      if (stored === null) {
        throw new ReceptionLookupRecipePairStoreError('upsert wrote no row');
      }
      return stored;
    },

    setContractId(input) {
      const endpoint_id = cleanId(input.endpoint_id, 'endpoint_id');
      const contract_id =
        input.contract_id === null ? null : cleanId(input.contract_id, 'contract_id');
      setContractStmt.run({ endpoint_id, contract_id });
    },

    clear(endpoint_id) {
      return deleteStmt.run(cleanId(endpoint_id, 'endpoint_id')).changes > 0;
    },
  };
};
