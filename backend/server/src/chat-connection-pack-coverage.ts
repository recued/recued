/** D-228 slice 3 — IS THIS MCP TOOL ALREADY REACHABLE AS A GOVERNED PACK OP?
 *
 *  The chat catalog offered an enrolled MCP tool twice: once as a Tier-3
 *  `<connection>.<tool>` entry gated by the per-tool presentation store, once as
 *  a `recued_op_*` pack op gated by the contract. This module answers the
 *  question that lets the first one stand down.
 *
 *  🔑 **THE JOIN IS `connection_catalog_binding`, AND THAT CHOICE IS THE WHOLE
 *  RELIABILITY ARGUMENT.** The alternative is to re-derive the pack slug from the
 *  connection (`mcpGeneratedPackSlug`, a hash) and look THAT up. Two reasons not
 *  to:
 *
 *    1. it is ASYNC, and the chat catalog builder is synchronous and per-turn —
 *       which would force a cache, and a cache is a second copy of the inventory
 *       that can disagree with the catalog it claims to describe;
 *    2. it answers a DIFFERENT question. The derivation says "what slug WOULD a
 *       generated pack for this connection have"; the binding store says "what
 *       catalog is actually bound to this connection" — and the binding store is
 *       the one the GATEWAY dispatches through. Suppressing a working surface on
 *       the strength of a derivation that the dispatcher does not consult is how
 *       a tool becomes reachable by nothing.
 *
 *  ⇒ Reading the dispatcher's own join means coverage cannot claim a route that
 *  does not exist.
 *
 *  ⚠ **DELIBERATELY NOT GENERATED-PACK-SPECIFIC.** Any composition catalog bound
 *  to an mcp connection dispatches its tools by the same `bind.tool` string, so
 *  an ordinary marketplace pack that covers a tool counts too. The question is
 *  "is there a governed route", not "did we mint it".
 *
 *  ⛔ **ABSENT DEPS ⇒ NO COVERAGE ⇒ NOTHING IS SUPPRESSED.** A partial harness or
 *  a host without the contract substrate keeps the Tier-3 surface exactly as it
 *  was. That direction is chosen: the failure of an absent binding store must be
 *  "the old surface is still there", never "the tool is reachable by nothing".
 */

import {
  mcpToolNamesFromCatalog,
  mcpToolOperationsFromCatalog,
} from '@recued/ingredient-authoring';
import {
  readOwnerOperationOverride,
  type IngredientManifest,
  type OperationRiskTier,
  type ScanFn,
} from '@recued/contracts';

import type { ConnectionCatalogBindingStore } from './storage/connection-catalog-binding-store.js';

export interface ChatConnectionPackCoverageDeps {
  /** The dispatcher's own connection → catalog join. */
  bindingStore?: Pick<ConnectionCatalogBindingStore, 'resolveCatalogSlug'>;
  /** The live manifest registry the install path registers into. */
  getManifest?: (slug: string) => IngredientManifest | null;
  /** D-228 slice 4 — the contract-row scan, so a tool's tier resolves through
   *  the owner's ruling exactly as it does at the door. Absent ⇒ authored tiers
   *  only, which is the conservative reading (a generated op is `write`). */
  contractScan?: ScanFn;
}

/** Build the per-connection coverage lookup the chat catalog + Tier-3 dispatch
 *  both consult.
 *
 *  ⚠ Returns a FRESH lookup each call rather than a memoised one. Both call
 *  sites resolve per turn / per dispatch, and the inventory moves underneath
 *  them — a pack installed mid-session must take effect on the next turn, not on
 *  the next restart. The reads are two map lookups and an object walk over one
 *  catalog; there is nothing here worth caching and a stale cache would suppress
 *  a surface whose replacement no longer exists. */
export const createChatConnectionPackCoverage = (
  deps: ChatConnectionPackCoverageDeps,
): ((connection_name: string) => ReadonlySet<string> | undefined) => {
  const { bindingStore, getManifest } = deps;
  if (!bindingStore || !getManifest) return () => undefined;
  return (connection_name) => {
    const slug = bindingStore.resolveCatalogSlug(connection_name);
    if (slug === undefined) return undefined;
    const catalog = getManifest(slug);
    if (catalog === null) return undefined;
    return mcpToolNamesFromCatalog(catalog);
  };
};

/** D-228 slice 4 — the RESOLVED tier of each upstream tool a bound catalog
 *  dispatches. The replacement for `tool_overrides.classification`.
 *
 *  ⛔⛔ **THIS IS WHAT MAKES DELETING `tool_overrides` SAFE RATHER THAN A HOLE.**
 *  `connection-mcp-read` / `-write` must carry a TRUE tier or a write slips past
 *  the preflight at read tier. That truth used to be a value the owner typed
 *  into a presentation store; it is now the pack operation's declared
 *  `risk_tier`, lowered by the owner's ruling if they made one.
 *
 *  🔑 **THE RULING IS READ ON THE QUALIFIED `operation_id`, the same key the
 *  gateway scans** (`catalog-gateway.ts`: `operations[id]?.operation_id ?? id`).
 *  Reading it any other way returns undefined for every row that exists — the
 *  defect this arc already shipped once and had to correct.
 *
 *  ⚠ Only the RISK is taken from the ruling, never the approval. The gate's
 *  question is "what tier is this tool", and approval is the separate axis the
 *  preflight owns; folding it in here would let an `approval: never` ruling
 *  answer a question nobody asked it. */
export const createChatConnectionPackTiers = (
  deps: ChatConnectionPackCoverageDeps,
): ((connection_name: string) => ReadonlyMap<string, OperationRiskTier> | undefined) => {
  const { bindingStore, getManifest, contractScan } = deps;
  if (!bindingStore || !getManifest) return () => undefined;
  return (connection_name) => {
    const slug = bindingStore.resolveCatalogSlug(connection_name);
    if (slug === undefined) return undefined;
    const catalog = getManifest(slug);
    if (catalog === null) return undefined;
    const out = new Map<string, OperationRiskTier>();
    for (const [tool, { operation, spec }] of mcpToolOperationsFromCatalog(catalog)) {
      const ruling = readOwnerOperationOverride({
        ...(contractScan ? { scan: contractScan } : {}),
        ingredient_id: slug,
        operation_id: spec.operation_id ?? operation,
      });
      out.set(tool, ruling?.risk ?? spec.risk_tier);
    }
    return out;
  };
};
