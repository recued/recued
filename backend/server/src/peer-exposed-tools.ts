/** D-225 auto-mint — WHAT DO WE EXPOSE TO THIS PEER?
 *
 *  The loopback diff (`subtractReflectedMcpTools`) needs one input and only one:
 *  the set of tool names THIS server offers to the peer on the other end of an
 *  mcp connection. Everything else about the filter is pure.
 *
 *  🔑 **THE JOIN IS THE CONNECTION'S OWN CONFIG.** `MCP_PEER_CONTRACT_CONFIG_KEY`
 *  (`config.peer_contract_id`) is the contract that peer presents when it calls
 *  US — already declared, already used by `peerConnectionForContract` to route a
 *  peer's answers back down the right connection. Reading it the other way round
 *  turns "which connection is this peer" into "what may this peer see", with no
 *  new record and no name heuristic.
 *
 *  ⛔ **TWO AXES, AND BOTH ARE NEEDED — reading one is how a filter goes half-
 *  blind.** A door's tools come from two different stores and neither knows about
 *  the other:
 *
 *    1. **raw pack ops** — governed by `contract_grant` rows. § 234.4p.16e made
 *       every Tier-P op owner-default-only ("an op reaches a door by an EXPLICIT
 *       ROW, never by an author default"), so the rows are COMPLETE for this axis
 *       — there is no permissive default to enumerate around.
 *    2. **static `recued_*` verbs** — governed by the inbound token's per-tool
 *       checklist, which lives on the token record, not on the contract. D-228
 *       slice 6 made an absent checklist DENY, so the checklist is likewise
 *       complete for its axis.
 *
 *  Read only axis 1 and every native verb we expose reflects back unfiltered.
 *
 *  ⚠ **TOKEN LIVENESS IS DELIBERATELY IGNORED.** A revoked or expired token
 *  cannot call us any more, but the peer's pack was minted while it could and
 *  still lists those tools — so the reflection outlives the token. Filtering on
 *  liveness would stop subtracting exactly the stale reflections that have the
 *  longest lifetime. This asks "what did we ever expose to this peer", which is
 *  the right question for recognising something coming back at us.
 *
 *  ⚠ Both reads are whole-scope scans over an owner's own rows. This runs at
 *  enroll and on the idle cadence, never on a dispatch hot path.
 */

import {
  RAW_OP_TOOL_PREFIX,
  mcpToolForKernelOp,
} from '@recued/contracts';

import { MCP_ACTION_STATUS_TOOL_NAME } from './mcp-action-store.js';
import type { ContractGrantEntryStore } from './storage/contract-grant-entry-store.js';
import type { ChatInboundTokenStore } from './storage/chat-inbound-token-store.js';

/** Tools every live principal sees regardless of any grant.
 *
 *  ⛔ FOUND BY A LIVE TWO-SERVER DRIVE, NOT BY READING. `recued_actionStatus`
 *  short-circuits BOTH gates in `handleToolsList` — it is *"an authenticated
 *  protocol utility, not a new business capability"*, admitted on principal
 *  liveness alone — so it appears in every peer's probe of us while appearing in
 *  no grant row and no token checklist. A set built only from those two stores
 *  therefore reports "we expose nothing like that" about a tool we always expose,
 *  and its reflection would mint straight back into our own pack.
 *
 *  ⚠ Adding it CANNOT over-subtract a peer's own copy. The loopback predicate
 *  requires the RELAY SHAPE (`recued_op_recued-local.mcp-<hash>.…`) before it
 *  ever looks at a label, and a peer's own `recued_actionStatus` is a bare name —
 *  so the peer's stays, and only a relayed one is removed. */
const ALWAYS_EXPOSED_TOOL_NAMES: readonly string[] = [MCP_ACTION_STATUS_TOOL_NAME];

/** Narrow reads only — the two `list` verbs, nothing that can write. A wider
 *  surface here would let a future edit grant from the module whose entire job
 *  is to observe what was granted elsewhere. */
export interface PeerExposedToolsDeps {
  grantEntryStore?: Pick<ContractGrantEntryStore, 'listForContract'>;
  inboundTokenStore?: Pick<ChatInboundTokenStore, 'listTokens'>;
}

/** A `contract_grant` entry key is either a bare op id (`<publisher>.<pack>.<op>`
 *  or `core.<domain>.<verb>`) or a collection read (`data.<collection>`). Only
 *  the first names something a peer can see in `tools/list`. */
const isCollectionEntry = (entryKey: string): boolean => entryKey.startsWith('data.');

/** Every tool name this server exposes to `contract_id`, in the peer's own
 *  vocabulary (wire names).
 *
 *  Empty for an unknown / absent contract — which is the ordinary case for a
 *  third-party MCP server and is what makes the loopback filter degrade to
 *  "mint everything". */
export const exposedToolNamesForPeerContract = (
  deps: PeerExposedToolsDeps,
  contract_id: string,
): string[] => {
  const out = new Set<string>();
  if (contract_id === '') return [];
  for (const name of ALWAYS_EXPOSED_TOOL_NAMES) out.add(name);

  // Axis 1 — the contract's own grant rows. An entry key is an OP ID; the door
  // prefixes it to reach the wire name a peer actually sees.
  for (const row of deps.grantEntryStore?.listForContract(contract_id) ?? []) {
    if (!row.granted || isCollectionEntry(row.entry_key)) continue;
    out.add(`${RAW_OP_TOOL_PREFIX}${row.entry_key}`);
    // A kernel op grant is reached through a STATIC tool, not a raw-op name.
    const staticTool = mcpToolForKernelOp(row.entry_key);
    if (staticTool !== undefined) out.add(staticTool);
  }

  // Axis 2 — the per-token checklist. Its keys are already wire names, EXCEPT
  // that the gate deliberately accepts either name for a native verb-op
  // (`kernelOpForMcpTool` is that join), so an owner may have granted the op id.
  // Resolve both readings rather than assuming which one was written.
  for (const token of deps.inboundTokenStore?.listTokens() ?? []) {
    if (token.contract_id !== contract_id) continue;
    for (const [key, granted] of Object.entries(token.grants)) {
      if (!granted) continue;
      if (key.startsWith('recued_')) out.add(key);
      const staticTool = mcpToolForKernelOp(key);
      if (staticTool !== undefined) out.add(staticTool);
      // ⛔⛔ THE THIRD KIND OF KEY, AND THE HEADER ABOVE CALLS AXIS 2 COMPLETE
      // WITHOUT IT. A token grants three shapes, not two: `recued_*` static
      // verbs, kernel op ids — and TIER-2 RECIPES, named `<publisher>/<recipe>`,
      // which are neither. A peer calls one by exactly that string
      // (`tools/call` → `recued-core/peer-apply-project-update`), so the grant
      // key IS the wire name and no join is needed; it was simply never added.
      //
      // 🔑 THE HEADER'S OWN SENTENCE IS THE PROOF: *"Read only axis 1 and every
      // native verb we expose reflects back unfiltered."* Exactly that, for
      // recipes — and recipes are what a Recued↔Recued relationship is MADE of,
      // so the miss lands hardest on the case the loopback diff exists for.
      //
      // ⛔ AND IT DOES NOT STOP AT A DUPLICATE OP. The reflected recipe mints
      // into our own generated pack, so the tool name is now bound by TWO
      // installed catalogs — the generated one and the pack that actually
      // declares it — and `resolveExchangeFireTarget` refuses an ambiguous
      // `deliver_to` rather than letting install order decide who answers. The
      // receiver's answer then never leaves, which reads as "peer exchange does
      // not work" and is really two correct rules composing: mint the peer's
      // tools, and never guess between two bindings.
      //
      // ⚠ Shape-tested the way every other reader of a Tier-2 tool name tests
      // it — a slash that is neither first nor last — rather than by looking the
      // recipe up. This module observes what was granted; a registry read here
      // would make a stale/uninstalled recipe silently stop being subtracted,
      // which is the direction that re-opens the defect.
      const slash = key.indexOf('/');
      if (slash > 0 && slash !== key.length - 1) out.add(key);
    }
  }

  return [...out];
};
