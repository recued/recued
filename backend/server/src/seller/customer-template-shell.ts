/** D-196 — the single authoring point for the zero-grant `customer_template`
 *  shell: an empty operation scope restricted to one door type. Both the Stripe
 *  entitlement sync (S4) and the manual pass-tier seed (1d Phase 2) mint through
 *  here, so the "zero-grant" security shape can never drift between the two
 *  paths — a copy in each would let one silently mint a non-empty scope. The
 *  owner authors the actual grants (which tools/data the template permits) onto
 *  the returned template in #contracts afterward, keeping I-1 intact: a recipe
 *  (or any UI RPC) never authors or names grants; it only mints the empty shell
 *  the human then fills.
 */

import type { ContractDefinition, DoorType } from '@recued/contracts';

import type { ContractDefinitionStore } from '../storage/contract-definition-store.js';

export interface MintCustomerTemplateShellInput {
  /** Provenance — who minted the template (a server identity). */
  readonly minted_by: string;
  /** Human-facing label for the owner Contracts row. */
  readonly display_name: string;
  /** The level-1 door type the template is restricted to (least privilege). */
  readonly door_type: DoorType;
}

/** Mint a fresh zero-grant `customer_template` contract for one door type. */
export const mintCustomerTemplateShell = (
  definitionStore: Pick<ContractDefinitionStore, 'mint'>,
  input: MintCustomerTemplateShellInput,
): ContractDefinition =>
  definitionStore.mint({
    minted_by: input.minted_by,
    display_name: input.display_name,
    grant_kind: 'customer_template',
    scope: { operation_ids: [] },
    door_types: [input.door_type],
  });
