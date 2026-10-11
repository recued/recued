/** D-320 audit — the door a webhook run waiting for the owner's approval resumes under.
 *
 *  A webhook door governs what a delivery may make the server do; the owner's approval
 *  of a held step comes later, from the owner. A door is never edited: a re-derive (a
 *  pack's connections, a reinstall, a dish's choice, the boot re-derive) mints a new
 *  door, re-stamps the trigger rows with it and revokes the old one. A run waiting for
 *  approval when that happened resumed under the revoked door, was refused at the step
 *  the owner had just approved, and its delivery was closed as failed: the owner's
 *  answer was lost to a change they made elsewhere.
 *
 *  It now resumes under the door its trigger row carries now, which still decides what
 *  the run may do: the approved step runs only if that door grants it. An owner's
 *  revoke leaves the revoked door stamped on the row (D-295), so a run under a door
 *  the owner shut has no successor and stays refused; so does one whose rows were
 *  unbound. Resolved at the moment of resume, like the bearer authority of an MCP or
 *  contracted chat resume (`approvalResumeAuthority`). */

import {
  contractPermitsDoorType,
  isContractActive,
  type ContractSnapshot,
  type ExecutionSource,
} from '@recued/contracts';

import type { ContractDefinitionStore } from './storage/contract-definition-store.js';
import type { WebhookConsumerStore } from './storage/webhook-consumer-store.js';
import { buildWebhookContractSnapshot } from './webhook-contract-snapshot.js';

export interface WebhookResumeDoorResolver {
  /** The source and snapshot a waiting webhook run resumes under when the door it
   *  started under was replaced; `undefined` to resume as persisted (its own door is
   *  live, or nothing replaced it). */
  successor(run_id: string, source: ExecutionSource): {
    execution_source: ExecutionSource;
    contract_snapshot: ContractSnapshot;
  } | undefined;
}

export const createWebhookResumeDoorResolver = (deps: {
  consumerStore: Pick<WebhookConsumerStore, 'currentDoorForRun'>;
  definitionStore: Pick<ContractDefinitionStore, 'get'>;
  now?: () => number;
}): WebhookResumeDoorResolver => {
  const now = deps.now ?? Date.now;
  return {
    successor(run_id, source) {
      if (source.channel !== 'webhook' || source.actor !== 'anonymous') return undefined;
      const ranUnder = source.contract_id;
      if (ranUnder === undefined) return undefined;
      const own = deps.definitionStore.get(ranUnder);
      // Only a door that was revoked has a successor: a live one resumes as it is,
      // and an expired or missing one is not a replacement.
      if (own === null || own.revoked_at === undefined || own.revoked_at === null) return undefined;
      const current = deps.consumerStore.currentDoorForRun(run_id);
      if (current === null || current === ranUnder) return undefined;
      const door = deps.definitionStore.get(current);
      const at = now();
      if (door === null || !isContractActive(door, at) || !contractPermitsDoorType(door, 'webhook')) {
        return undefined;
      }
      const execution_source = { ...source, contract_id: current } as ExecutionSource;
      return {
        execution_source,
        // `'recipe'` — as the webhook runner builds it: a recipe run does not borrow
        // the door's authored ceiling (`webhook-recipe-runner.ts`).
        contract_snapshot: buildWebhookContractSnapshot(
          execution_source,
          { definitionStore: deps.definitionStore, now },
          'recipe',
        ),
      };
    },
  };
};
