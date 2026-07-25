/** D-202 task 4a — the QUALITY-delegation resolver the commit Gateway's
 *  ask-branch consults (the second gate axis, beside the D-177
 *  `SessionGrantResolver`).
 *
 *  Deliberately thinner than the session-grant resolver: a quality delegation is
 *  a STANDING `(recipe, op)`-grain auto-accept (governed by the invalidation
 *  ladder + Switch A/B kill-switch, not a per-call use budget), so there is NO
 *  session index, NO consume, NO mint here — only a live read-side `match` over
 *  the whole quality-delegation set plus the persisted Switch A/B status. The
 *  gateway host closure completes the match context with the run's recipe
 *  identity and composes `resolveQualityGateDecision`.
 *
 *  Stateless beyond the injected clock — every call reads the store live, so a
 *  mid-session revoke / template edit / kill-switch flip takes effect on the next
 *  ask (§3/§4).
 *
 *  Spec: `docs/d-202-spec.md` + `docs/d-202-quality-gate-seams.md` (§4). */

import {
  matchesQualityDelegation,
  type QualityDelegationMatchContext,
  type QualityGateSwitches,
} from '@recued/contracts';

import type { ContractDefinitionStore } from './storage/contract-definition-store.js';

export interface QualityGateResolver {
  /** True iff an ACTIVE quality delegation matches `ctx`'s `(recipe, op)`
   *  (`matchesQualityDelegation` over the live `listQualityDelegations` set).
   *  Read-only. */
  match(ctx: QualityDelegationMatchContext): boolean;
  /** The owner's persisted Switch A/B kill-switch state (§4). */
  switches(): QualityGateSwitches;
}

export interface CreateQualityGateResolverDeps {
  /** The `contract.contract_definition.*` lifecycle store — the quality-grant
   *  list (`listQualityDelegations`) is the only method read. */
  readonly definitionStore: Pick<ContractDefinitionStore, 'listQualityDelegations'>;
  /** Read the persisted Switch A/B kill-switch state (the server-state
   *  `getQualityGateSwitches` accessor). Read on every ask so a pause takes
   *  effect instantly. */
  readonly getSwitches: () => QualityGateSwitches;
  /** Clock for the match-time liveness check (epoch-ms). Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Build a {@link QualityGateResolver} over the contract-definition store +
 *  the persisted Switch A/B state. */
export const createQualityGateResolver = (
  deps: CreateQualityGateResolverDeps,
): QualityGateResolver => {
  const now = deps.now ?? ((): number => Date.now());
  return {
    match(ctx): boolean {
      const nowMs = now();
      for (const grant of deps.definitionStore.listQualityDelegations()) {
        if (matchesQualityDelegation(grant, ctx, nowMs)) return true;
      }
      return false;
    },
    switches(): QualityGateSwitches {
      return deps.getSwitches();
    },
  };
};
