/** Boot backfill — give every UNBOUND inbound MCP token a contract.
 *
 *  ## Why this exists
 *
 *  A token used to be unbound by default: the Advanced panel minted a contract
 *  only when the owner switched on a cap or expiry, and unbound again when they
 *  switched the last one off — *"a contract exists ONLY while a limit is on"*.
 *  Issuance is now always-contracted, but that was forward-only: tokens already
 *  in the field carry no contract, and the wire papers over it by synthesising
 *  `contract_id = mcp_token_id`, an id that names no row.
 *
 *  Those tokens are exactly the ones nobody is watching. Until they are
 *  contracted, `shouldMeterUse` is false for them (it requires a MINTED
 *  contract), so the contract enforces nothing and their lifetime lives only in
 *  the token's own `expires_at` / `revoked_at`.
 *
 *  ## ⛔⛔ IT TRANSFERS THE LIFECYCLE, IT DOES NOT JUST MINT A CARRIER
 *
 *  This is the part that makes retiring the token-side fields SAFE later, and
 *  the part a naive "mint an empty contract for each" would get wrong in two
 *  directions:
 *
 *    - an EXPIRED token whose carrier had no `expiry_at` would come back to
 *      life the moment the contract became the authority;
 *    - a REVOKED token whose carrier was never revoked would do the same, and
 *      that one is a live bearer someone deliberately killed.
 *
 *  So `expires_at > 0` becomes the carrier's `expiry_at`, and a revoked token's
 *  carrier is minted AND revoked in the same pass. A backfill that resurrects
 *  credentials is worse than no backfill.
 *
 *  ⚠ `max_uses` is NOT invented. The token never had a use cap, so neither does
 *  its carrier — absent means unbounded, and minting a limit the owner never
 *  set would silently start refusing calls that used to work.
 *
 *  Idempotent: only rows with `contract_id IS NULL` are touched, so a second
 *  boot is a no-op. Best-effort per row — one bad row must not block startup or
 *  abandon the rest. */

import type Database from 'better-sqlite3';

import type { ContractDefinitionStore } from './contract-definition-store.js';

export interface InboundTokenContractBackfillResult {
  /** Rows that had no contract when the sweep started. */
  readonly unbound: number;
  /** Rows given a carrier. */
  readonly bound: number;
  /** Carriers minted and immediately revoked (the token was already revoked). */
  readonly revoked: number;
  /** Rows that threw — left unbound, so the next boot retries them. */
  readonly failed: number;
}

interface UnboundRow {
  token_id: string;
  label: string;
  expires_at: number;
  revoked_at: number | null;
}

export const backfillInboundTokenContracts = (
  db: Database.Database,
  definitionStore: ContractDefinitionStore,
): InboundTokenContractBackfillResult => {
  let rows: UnboundRow[];
  try {
    rows = db.prepare(`
      SELECT token_id, label, expires_at, revoked_at
        FROM chat_inbound_tokens
       WHERE contract_id IS NULL
    `).all() as UnboundRow[];
  } catch {
    // No table yet (fresh db, pre-schema boot ordering) ⇒ nothing to backfill.
    return { unbound: 0, bound: 0, revoked: 0, failed: 0 };
  }
  if (rows.length === 0) {
    return { unbound: 0, bound: 0, revoked: 0, failed: 0 };
  }

  const bindStmt = db.prepare(`
    UPDATE chat_inbound_tokens
       SET contract_id = @contract_id
     WHERE token_id    = @token_id
       AND contract_id IS NULL
  `);

  let bound = 0;
  let revoked = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const definition = definitionStore.mint({
        minted_by: 'backfill',
        display_name: `MCP door — ${row.label}`,
        // The same carrier shape issuance and the Advanced panel mint.
        scope: { channels: ['mcp'] },
        door_types: ['mcp'],
        // ⛔ `expires_at: 0` is the token's "never expires" sentinel, so it maps
        // to an ABSENT `expiry_at` — not to `0`, which would be an epoch in
        // 1970 and would kill every token this sweep touched.
        ...(row.expires_at > 0 ? { expiry_at: row.expires_at } : {}),
      });
      if (row.revoked_at !== null) {
        // ⛔⛔ REVOKE BEFORE BIND, and the ORDER is the whole point. Binding
        // first and revoking second looks equivalent and is not: if the revoke
        // throws, the row is ALREADY bound, so the next boot skips it
        // (`contract_id IS NULL` no longer matches) and it sits bound to a LIVE
        // carrier forever — a revoked bearer resurrected by the very sweep
        // meant to preserve its death. Revoking first means a failure leaves
        // the row unbound and the retry is real.
        //
        // A DEAD TOKEN STAYS DEAD: the carrier carries the kill the owner
        // already made, so it survives the contract becoming the authority.
        definitionStore.revoke(
          definition.contract_id,
          'backfilled from an already-revoked inbound token',
        );
        revoked += 1;
      }
      // ⚠ `changes === 0` means another process bound this row between the
      // SELECT and here (the UPDATE is conditional on `contract_id IS NULL`).
      // Count it as failed rather than bound: our carrier is an orphan, and
      // reporting it as bound would make the summary claim work it did not do.
      const result = bindStmt.run({
        contract_id: definition.contract_id,
        token_id: row.token_id,
      });
      if (result.changes === 0) {
        failed += 1;
        continue;
      }
      bound += 1;

    } catch {
      // Leave the row unbound; the next boot retries it. Failing loudly here
      // would block startup over one row, and skipping silently forever would
      // leave exactly the untracked token this sweep exists to find.
      failed += 1;
    }
  }
  return { unbound: rows.length, bound, revoked, failed };
};
