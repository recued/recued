/** D-200 Slice 6g.2 — durable intake-form/recipe pair registry.
 *
 * One endpoint owns at most one compact `ReceptionPairBinding`.
 * The row is a locator, never hash authority: the authoring writer must derive
 * it from the exact saved form + recipe snapshots, and the visitor render path
 * re-derives it before use. No Seller row, provider URL, visitor PII, item list,
 * or transaction state lives here.
 *
 * ⚠ THE NAME IS NARROWER THAN THE BEHAVIOUR. Since D-210 R-2 this store holds
 * EVERY endpoint→recipe pair, not just intake ones: form pairs (v1/v2) and
 * scheduling pairs (v3). The `intake` in the table + type name is legacy — the
 * table is keyed `endpoint_id` and always was the general shape. Renaming it
 * would touch a contracts closed union (`ReceptionTableName` / `RECEPTION_TABLES`)
 * for no behavioural gain, so the name stays and this comment carries the truth.
 * Do not infer from the name that a v3 cannot be here.
 *
 * `form_definition_id` is NULL for exactly the scheduling pairs (owner-ruled
 * rebuild, 2026-07-17); for form pairs it stays the integrity cross-check
 * against the blob. Nothing queries by it.
 */

import type Database from 'better-sqlite3';
import {
  isReceptionPairBinding,
  isReceptionPairRevision,
  receptionPairBindingEquals,
  type ReceptionPairBinding,
  type ReceptionIntakeRecipePairStatus,
} from '@recued/contracts';

interface IntakeRecipePairRow {
  endpoint_id: string;
  form_definition_id: string | null;
  binding_blob: string;
  contract_id: string | null;
  created_at: number;
  updated_at: number;
}

/** The column's value for a binding — the form id for a form pair, `null` for a
 *  scheduling pair, which has no form to name.
 *
 *  ⛔ Derived from the binding, never passed in beside it. The column and the blob
 *  must not be able to disagree: `rowToSummary` re-checks them against each other,
 *  and a caller-supplied id could satisfy that check while naming a different form
 *  than the one the blob was hashed over. */
const formDefinitionIdColumn = (binding: ReceptionPairBinding): string | null =>
  'form_definition_id' in binding ? binding.form_definition_id : null;

export interface ReceptionIntakeRecipePairSummary {
  readonly endpoint_id: string;
  readonly binding: ReceptionPairBinding;
  readonly created_at: number;
  readonly updated_at: number;
  /** D-207 slice 1b — the door contract minted for this pair, or `null` when no door has
   *  been minted yet. This is the ONLY route from a dispatch's `reception_id` back to its
   *  authority (`mint()` generates the contract id, so it cannot be re-derived).
   *
   *  `null` is SAFE, not open: the dispatch then carries no `contract_id`, and
   *  `resolveGrantGoverningContractId` floors an anonymous source to `PUBLIC_CONTRACT_ID`
   *  (which grants nothing) rather than to "contract-free" (which would skip the gate). */
  readonly contract_id: string | null;
}

export type ReceptionIntakeRecipePairCompareAndSetResult =
  | {
      readonly kind: 'created' | 'updated' | 'unchanged';
      readonly pair: ReceptionIntakeRecipePairSummary;
    }
  | {
      readonly kind: 'conflict';
      readonly current: ReceptionIntakeRecipePairSummary | null;
    };

export type ReceptionIntakeRecipePairCompareAndDeleteResult =
  | {
      readonly kind: 'deleted';
      readonly prior: ReceptionIntakeRecipePairSummary;
      readonly prior_invalid: false;
    }
  | {
      readonly kind: 'deleted';
      /** A corrupt row was removed without exposing it as pair authority. */
      readonly prior: null;
      readonly prior_invalid: true;
    }
  | { readonly kind: 'unchanged' }
  | {
      readonly kind: 'conflict';
      readonly current: ReceptionIntakeRecipePairSummary;
      readonly current_invalid: false;
    }
  | {
      readonly kind: 'conflict';
      readonly current: null;
      readonly current_invalid: true;
    };

export interface ReceptionIntakeRecipePairStore {
  upsert(input: {
    endpoint_id: string;
    binding: ReceptionPairBinding;
    now: number;
  }): ReceptionIntakeRecipePairSummary;
  compareAndSet(input: {
    endpoint_id: string;
    binding: ReceptionPairBinding;
    expected_updated_at: number | null;
    now: number;
  }): ReceptionIntakeRecipePairCompareAndSetResult;
  compareAndDelete(input: {
    endpoint_id: string;
    expected_status: ReceptionIntakeRecipePairStatus;
    expected_updated_at: number | null;
    expected_pair_revision: string | null;
  }): ReceptionIntakeRecipePairCompareAndDeleteResult;
  /** D-207 slice 1b — link a minted door contract to this pair. Returns false when the
   *  endpoint has no pair row.
   *
   *  Deliberately a SEPARATE write from the binding upsert, and safe to be: if a crash
   *  lands between the mint and this call, the pair keeps `contract_id: NULL`, the
   *  dispatch is floored to `PUBLIC_CONTRACT_ID` (grants nothing), and the door DENIES
   *  everything until the owner re-binds. The intermediate state is fail-CLOSED, which is
   *  exactly what the §5.1 floor exists to guarantee.
   *
   *  ⚠ Does NOT move `updated_at`. That column is the BINDING's optimistic-concurrency
   *  token — the `expected_updated_at` every `compareAndSet` / `compareAndDelete` is
   *  checked against — and the door is DERIVED from the binding, not part of it. Bumping it
   *  here would mean a door mint invalidates every outstanding observation of the pair,
   *  which is false, and which made the bind rpc conflict with ITSELF: bind →
   *  `needs_consent` → owner confirms with the token they were handed → the mint moves the
   *  token → the bind's own post-write currency check sees a "changed" pair and 409s. The
   *  door would be minted and the owner told it failed. */
  setContractId(input: {
    endpoint_id: string;
    contract_id: string | null;
  }): boolean;
  /** D-207 slice 1c — the door's contract id ALONE, without decoding the binding blob.
   *
   *  `findByEndpoint` validates the whole row and THROWS on a corrupt binding — which is
   *  correct for a reader that must not hand back garbage as pair authority, and useless
   *  for the one caller that needs to shut a door on a row it is deleting *because* it is
   *  corrupt. The contract id is its own column; it is readable even when the blob is not,
   *  and a corrupt pair is exactly when you most want the public's grants revoked rather
   *  than orphaned. Never a substitute for `findByEndpoint` — it proves nothing about the
   *  pair. */
  readContractId(endpoint_id: string): string | null;
  findByEndpoint(endpoint_id: string): ReceptionIntakeRecipePairSummary | null;
  /** Every valid pair row currently naming this recipe. Used for
   * invalidation fan-out after a recipe-local configuration change. */
  listByRecipeId(recipe_id: string): ReceptionIntakeRecipePairSummary[];
}

export class ReceptionIntakeRecipePairStoreError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'invalid_stored_binding',
    message: string,
  ) {
    super(message);
    this.name = 'ReceptionIntakeRecipePairStoreError';
  }
}

const isEndpointId = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= 256
  && value.trim() === value
  && !/[\u0000-\u001f\u007f]/.test(value);

const isRecipeId = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= 256
  && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value);

const isTimestamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const bindingsEqual = (
  left: ReceptionPairBinding,
  right: ReceptionPairBinding,
): boolean => receptionPairBindingEquals(left, right);

const isExpectedDeleteObservation = (input: {
  expected_status: ReceptionIntakeRecipePairStatus;
  expected_updated_at: number | null;
  expected_pair_revision: string | null;
}): boolean => {
  if (input.expected_status !== 'unpaired'
    && input.expected_status !== 'ready'
    && input.expected_status !== 'stale') return false;
  const hasValidLocators = isTimestamp(input.expected_updated_at)
    && isReceptionPairRevision(input.expected_pair_revision);
  const hasNullLocators = input.expected_updated_at === null
    && input.expected_pair_revision === null;
  if (input.expected_status === 'unpaired') return hasNullLocators;
  if (input.expected_status === 'ready') return hasValidLocators;
  return hasValidLocators || hasNullLocators;
};

const rowToSummary = (row: IntakeRecipePairRow): ReceptionIntakeRecipePairSummary => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.binding_blob) as unknown;
  } catch {
    throw new ReceptionIntakeRecipePairStoreError(
      'invalid_stored_binding',
      `intake recipe pair '${row.endpoint_id}' contains malformed JSON`,
    );
  }
  // The blob is the truth; the column must agree with it. `formDefinitionIdColumn`
  // derives the expected value from the PARSED binding, so this stays one rule for
  // both variants: a form pair must match its stored id, and a scheduling pair must
  // carry NULL. That rejects both halves of a variant/column mismatch — a v3 beside
  // a leftover form id, and a v1 whose id was cleared — rather than reading either
  // as a valid pair.
  if (!isReceptionPairBinding(parsed)
    || formDefinitionIdColumn(parsed) !== row.form_definition_id
    || !isEndpointId(row.endpoint_id)
    || !isTimestamp(row.created_at)
    || !isTimestamp(row.updated_at)
    || row.updated_at < row.created_at) {
    throw new ReceptionIntakeRecipePairStoreError(
      'invalid_stored_binding',
      `intake recipe pair '${row.endpoint_id}' failed its closed row contract`,
    );
  }
  return {
    endpoint_id: row.endpoint_id,
    binding: { ...parsed },
    created_at: row.created_at,
    updated_at: row.updated_at,
    contract_id:
      typeof row.contract_id === 'string' && row.contract_id.length > 0
        ? row.contract_id
        : null,
  };
};

export const createReceptionIntakeRecipePairStore = (
  db: Database.Database,
): ReceptionIntakeRecipePairStore => {
  const upsertStmt = db.prepare(`
    INSERT INTO reception_intake_recipe_pair (
      endpoint_id, form_definition_id, binding_blob, created_at, updated_at
    ) VALUES (
      @endpoint_id, @form_definition_id, @binding_blob, @created_at, @updated_at
    )
    ON CONFLICT(endpoint_id) DO UPDATE SET
      form_definition_id = excluded.form_definition_id,
      binding_blob = excluded.binding_blob,
      updated_at = excluded.updated_at
  `);
  const findStmt = db.prepare(`
    SELECT * FROM reception_intake_recipe_pair WHERE endpoint_id = @endpoint_id
  `);
  const listStmt = db.prepare(`
    SELECT * FROM reception_intake_recipe_pair ORDER BY endpoint_id ASC
  `);
  const deleteStmt = db.prepare(`
    DELETE FROM reception_intake_recipe_pair WHERE endpoint_id = @endpoint_id
  `);

  const compareAndSet = db.transaction((input: {
    endpoint_id: string;
    binding: ReceptionPairBinding;
    expected_updated_at: number | null;
    now: number;
  }): ReceptionIntakeRecipePairCompareAndSetResult => {
    if (!isEndpointId(input.endpoint_id)
      || !isReceptionPairBinding(input.binding)
      || (input.expected_updated_at !== null
        && !isTimestamp(input.expected_updated_at))
      || !isTimestamp(input.now)) {
      throw new ReceptionIntakeRecipePairStoreError(
        'invalid_input',
        'intake recipe pair compare-and-set requires safe sources, token, and timestamp',
      );
    }
    const stored = findStmt.get({ endpoint_id: input.endpoint_id }) as
      | IntakeRecipePairRow
      | undefined;
    const current = stored === undefined ? null : rowToSummary(stored);
    if (current !== null && bindingsEqual(current.binding, input.binding)) {
      return { kind: 'unchanged', pair: current };
    }
    if (current === null) {
      if (input.expected_updated_at !== null) {
        return { kind: 'conflict', current: null };
      }
      upsertStmt.run({
        endpoint_id: input.endpoint_id,
        form_definition_id: formDefinitionIdColumn(input.binding),
        binding_blob: JSON.stringify(input.binding),
        created_at: input.now,
        updated_at: input.now,
      });
      const created = findStmt.get({ endpoint_id: input.endpoint_id }) as
        | IntakeRecipePairRow
        | undefined;
      if (created === undefined) {
        throw new Error(
          'ReceptionIntakeRecipePairStore.compareAndSet: row missing after create',
        );
      }
      return { kind: 'created', pair: rowToSummary(created) };
    }
    if (input.expected_updated_at !== current.updated_at) {
      return { kind: 'conflict', current };
    }
    if (current.updated_at === Number.MAX_SAFE_INTEGER) {
      throw new ReceptionIntakeRecipePairStoreError(
        'invalid_input',
        'intake recipe pair updated_at cannot advance beyond the safe-integer ceiling',
      );
    }
    const updatedAt = Math.max(input.now, current.updated_at + 1);
    upsertStmt.run({
      endpoint_id: input.endpoint_id,
      form_definition_id: formDefinitionIdColumn(input.binding),
      binding_blob: JSON.stringify(input.binding),
      created_at: current.created_at,
      updated_at: updatedAt,
    });
    const updated = findStmt.get({ endpoint_id: input.endpoint_id }) as
      | IntakeRecipePairRow
      | undefined;
    if (updated === undefined) {
      throw new Error(
        'ReceptionIntakeRecipePairStore.compareAndSet: row missing after update',
      );
    }
    return { kind: 'updated', pair: rowToSummary(updated) };
  });

  const compareAndDelete = db.transaction((input: {
    endpoint_id: string;
    expected_status: ReceptionIntakeRecipePairStatus;
    expected_updated_at: number | null;
    expected_pair_revision: string | null;
  }): ReceptionIntakeRecipePairCompareAndDeleteResult => {
    if (!isEndpointId(input.endpoint_id)
      || !isExpectedDeleteObservation(input)) {
      throw new ReceptionIntakeRecipePairStoreError(
        'invalid_input',
        'intake recipe pair compare-and-delete requires one exact observed state',
      );
    }
    const stored = findStmt.get({ endpoint_id: input.endpoint_id }) as
      | IntakeRecipePairRow
      | undefined;
    // Replaying a successful clear is an idempotent no-op. No active row can
    // be lost when the current state is already absent.
    if (stored === undefined) return { kind: 'unchanged' };

    let current: ReceptionIntakeRecipePairSummary | null = null;
    let currentInvalid = false;
    try {
      current = rowToSummary(stored);
    } catch (error) {
      if (error instanceof ReceptionIntakeRecipePairStoreError
        && error.code === 'invalid_stored_binding') {
        currentInvalid = true;
      } else {
        throw error;
      }
    }

    if (currentInvalid) {
      // Only a caller that observed the explicit corrupt-row shape may remove
      // it. An `unpaired` null observation must not become force-delete power.
      if (input.expected_status !== 'stale'
        || input.expected_updated_at !== null
        || input.expected_pair_revision !== null) {
        return { kind: 'conflict', current: null, current_invalid: true };
      }
      deleteStmt.run({ endpoint_id: input.endpoint_id });
      return { kind: 'deleted', prior: null, prior_invalid: true };
    }

    if (current === null) {
      throw new Error(
        'ReceptionIntakeRecipePairStore.compareAndDelete: valid row missing after decode',
      );
    }
    if (input.expected_updated_at !== current.updated_at
      || input.expected_pair_revision !== current.binding.pair_revision) {
      return { kind: 'conflict', current, current_invalid: false };
    }
    deleteStmt.run({ endpoint_id: input.endpoint_id });
    return { kind: 'deleted', prior: current, prior_invalid: false };
  });

  return {
    upsert(input) {
      if (!isEndpointId(input.endpoint_id)
        || !isReceptionPairBinding(input.binding)
        || !isTimestamp(input.now)) {
        throw new ReceptionIntakeRecipePairStoreError(
          'invalid_input',
          'intake recipe pair upsert requires a safe endpoint, binding, and timestamp',
        );
      }
      const existing = findStmt.get({ endpoint_id: input.endpoint_id }) as
        | IntakeRecipePairRow
        | undefined;
      const existingSummary = existing === undefined ? null : rowToSummary(existing);
      const createdAt = existingSummary?.created_at ?? input.now;
      if (existingSummary !== null && input.now < existingSummary.updated_at) {
        throw new ReceptionIntakeRecipePairStoreError(
          'invalid_input',
          'intake recipe pair updated_at cannot move backwards',
        );
      }
      upsertStmt.run({
        endpoint_id: input.endpoint_id,
        form_definition_id: formDefinitionIdColumn(input.binding),
        binding_blob: JSON.stringify(input.binding),
        created_at: createdAt,
        updated_at: input.now,
      });
      const row = findStmt.get({ endpoint_id: input.endpoint_id }) as
        | IntakeRecipePairRow
        | undefined;
      if (row === undefined) {
        throw new Error('ReceptionIntakeRecipePairStore.upsert: row missing after write');
      }
      return rowToSummary(row);
    },

    compareAndSet,

    compareAndDelete,

    setContractId(input) {
      if (!isEndpointId(input.endpoint_id)) return false;
      // `updated_at` is deliberately untouched — see the interface comment. It is the
      // BINDING's concurrency token, and the door is derived from the binding.
      const res = db.prepare(`
        UPDATE reception_intake_recipe_pair
           SET contract_id = @contract_id
         WHERE endpoint_id = @endpoint_id
      `).run({
        endpoint_id: input.endpoint_id,
        contract_id: input.contract_id,
      });
      return res.changes > 0;
    },

    readContractId(endpoint_id) {
      if (!isEndpointId(endpoint_id)) return null;
      const row = findStmt.get({ endpoint_id }) as IntakeRecipePairRow | undefined;
      // Deliberately NOT `rowToSummary` — that validates the binding blob and throws on a
      // corrupt row, and a corrupt row still has a door that must be shut.
      if (row === undefined) return null;
      return typeof row.contract_id === 'string' && row.contract_id.length > 0
        ? row.contract_id
        : null;
    },

    findByEndpoint(endpoint_id) {
      if (!isEndpointId(endpoint_id)) return null;
      const row = findStmt.get({ endpoint_id }) as IntakeRecipePairRow | undefined;
      return row === undefined ? null : rowToSummary(row);
    },

    listByRecipeId(recipe_id) {
      if (!isRecipeId(recipe_id)) return [];
      const pairs: ReceptionIntakeRecipePairSummary[] = [];
      for (const row of listStmt.all() as IntakeRecipePairRow[]) {
        try {
          const pair = rowToSummary(row);
          if (pair.binding.recipe_id === recipe_id) pairs.push(pair);
        } catch (error) {
          // Corrupt unrelated rows are already surfaced as stale by the exact
          // endpoint reader; they cannot become fan-out authority or block a
          // valid originating configuration write.
          if (!(error instanceof ReceptionIntakeRecipePairStoreError)
            || error.code !== 'invalid_stored_binding') throw error;
        }
      }
      return pairs;
    },

  };
};
