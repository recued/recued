/** D-228 slice 3 — CARRY THE OWNER'S EXISTING TOOL CLASSIFICATION ONTO THE PACK OP.
 *
 *  The chat swap replaces a Tier-3 `<connection>.<tool>` entry with the generated
 *  pack's operation. The two surfaces disagree about one thing that the owner can
 *  feel immediately: the Tier-3 route carried the owner's own `read` / `write`
 *  classification, while every generated op is minted `write` + `ask` by
 *  construction (`GENERATED_RISK` — the conservative tier IS the confirmation,
 *  because at mint time nobody has looked).
 *
 *  ⇒ Without this module the swap would silently add an approval prompt to every
 *  MCP tool the owner had already classified `read`, and would present that
 *  regression as a security improvement. This carries the decision across.
 *
 *  ── ⛔⛔ WHY THIS DOES NOT REOPEN WHAT D-225 SLICE 2f CLOSED ────────────────
 *  Slice 2f settled that `mcpPackCommit` writes NO rulings, and its reasoning was
 *  exact: *"a commit path that wrote rulings itself would either duplicate those
 *  gates (and drift from them) or bypass them, and bypassing is exactly how a
 *  third-party server's tools would end up auto-running without anyone having
 *  confirmed it."*
 *
 *  🔑 **THE HAZARD IS A TOOL NOBODY LOOKED AT. THIS ONLY EVER WRITES FOR A TOOL
 *  THE OWNER LOOKED AT AND CLASSIFIED.** A tool with no override — which is every
 *  tool a third party adds, and every tool on a connection the owner never
 *  tuned — gets nothing, keeps `write` + `ask`, and still has to be confirmed.
 *  So the case slice 2f names cannot occur through this path; what moves is a
 *  decision that already existed, from a store being retired to the one that
 *  replaces it. Owner ruling, 2026-08-14, asked before writing it.
 *
 *  Four constraints hold it to that, and each is enforced rather than intended:
 *
 *  1. **`read` ONLY.** A `write` classification is what the pack already mints,
 *     so there is nothing to carry; writing a redundant row would be noise that
 *     later reads as an owner decision. ⇒ The carry-over can only ever land the
 *     one value the owner explicitly chose, and can never RAISE a tier.
 *  2. **ENABLED only.** A disabled override is the owner having withdrawn the
 *     tool, not classified it.
 *  3. **NEVER CLOBBERS.** An existing owner-operation row is a decision made in
 *     the gated editor, which is newer and better-informed than a presentation-
 *     store value being migrated. It wins; this skips.
 *  4. **AT THE RISK FLOOR, NOT BELOW IT.** `read` floors at `never`
 *     (`RISK_APPROVAL_FLOOR`), so `{risk: 'read', approval: 'never'}` sits
 *     exactly at the floor and `isApprovalBelowRiskFloor` is false for it. This
 *     writes nothing the gated editor would have refused — it is the same value
 *     `mcpPackReviewRows` already offers as `suggested` for a read tool.
 *
 *  ⚠ Rows are stamped with `op_hash` like every other owner ruling, so a re-mint
 *  that changes an operation's body leaves the carried decision behind rather
 *  than silently applying it to a different operation. And `removePackOwnerRulings`
 *  already sweeps them on uninstall, keyed on the pack slug — so nothing here
 *  needs its own teardown.
 */

import {
  OWNER_OPERATION_SCOPE,
  operationSpecHash,
  type IngredientManifest,
} from '@recued/contracts';

import type { ContractStore } from './storage/contract-store.js';
import {
  legacyToolOverrides,
  type ChatConnectionMcpStore,
} from './storage/chat-connection-mcp-store.js';

export interface McpClassificationCarryoverDeps {
  contractStore: ContractStore;
  /** Reads the per-tool overrides being migrated. */
  getAnnotation: ChatConnectionMcpStore['getAnnotation'];
  /** The installed catalog for a pack slug. */
  getManifest: (slug: string) => IngredientManifest | null;
  now?: () => number;
}

export interface McpClassificationCarryoverResult {
  /** Ops that received a carried `read` ruling. */
  carried: string[];
  /** Ops skipped because the owner already ruled on them in the editor. */
  skipped_existing: string[];
}

/** Carry every `read` classification the owner recorded for `connection_name`
 *  onto the matching operations of `pack_slug`.
 *
 *  Idempotent: a second run finds its own rows and skips them as existing. */
export const carryMcpToolClassifications = (
  deps: McpClassificationCarryoverDeps,
  input: { connection_name: string; pack_slug: string },
): McpClassificationCarryoverResult => {
  const result: McpClassificationCarryoverResult = { carried: [], skipped_existing: [] };
  const catalog = deps.getManifest(input.pack_slug);
  if (catalog === null) return result;
  const annotation = deps.getAnnotation(input.connection_name);
  const executes = catalog.surfaces?.api?.executes ?? {};
  const operations = catalog.operations ?? {};

  deps.contractStore.transaction(() => {
    for (const [operation, binding] of Object.entries(executes)) {
      if (binding.kind !== 'mcp') continue;
      const opSpec = operations[operation];
      if (!opSpec) continue;
      // ⛔ READ THROUGH THE LEGACY ACCESSOR. `tool_overrides` left
      // `ConnectionMcpAnnotationState` in slice 4; this migration is the only
      // thing that may still see it, and it sees it by asking for it by name.
      const overrides = legacyToolOverrides(annotation);
      const override = Object.prototype.hasOwnProperty.call(overrides, binding.tool)
        ? overrides[binding.tool]
        : undefined;
      // Constraints 1 + 2 — an enabled, explicitly `read` classification is the
      // only thing there is to carry.
      if (!override || !override.enabled || override.classification !== 'read') continue;
      // ⛔⛔ THE FULLY-QUALIFIED `operation_id`, NEVER THE MAP KEY — and getting
      // this wrong writes a row that NOTHING READS. Operations are keyed in a
      // manifest by SHORT NAME (`echo_probe_827cfe4a`) but carry a qualified
      // `operation_id` (`recued-local.mcp-<hash>.echo_probe_827cfe4a`), and both
      // readers key on the qualified one: the D-166 4d.4 gateway scan
      // (`catalog-gateway.ts` — `manifest.operations[id]?.operation_id ?? id`)
      // and the owner-operation rpc (`ensureDeclaredOperation`, which says so in
      // its own doc). A row under the short key is silently inert.
      //
      // 🔑 IT WAS WRITTEN THE WRONG WAY FIRST, and every unit test stayed green:
      // the fixtures declared no `operation_id`, so the fallback made the two
      // keys identical and the collision could not appear. Only the live drive
      // showed it (`risk=write` at the gateway with the ruling present). The
      // fixtures now carry the qualified id the real producer stamps.
      const operationId = opSpec.operation_id ?? operation;
      const segments = [input.pack_slug, operationId];
      // Constraint 3 — the owner's own editor decision outranks a migration.
      if (deps.contractStore.get(OWNER_OPERATION_SCOPE, segments) !== null) {
        result.skipped_existing.push(operationId);
        continue;
      }
      deps.contractStore.put(OWNER_OPERATION_SCOPE, segments, {
        // Constraint 4 — exactly the floor for `read`, so nothing here is a
        // value the gated write path would have refused.
        risk: 'read',
        approval: 'never',
        op_hash: operationSpecHash(opSpec),
      });
      result.carried.push(operationId);
    }
  });

  return result;
};
