import type { EnrichmentScope, NamespaceStores } from '@recued/contracts';
import { resolveValue } from '@recued/contracts';
import type {
  TransformContext,
  EnrichmentRowSnapshot,
  PiiKnownValueSource,
  PiiLedgerStore,
} from '@recued/transforms';
import { getTransform } from '@recued/transforms';
import { evaluateCondition } from './condition.js';

/** Optional extras the host may inject into every TransformContext.
 *  The recued-server engine wires the warehouse-resident
 *  `readEnrichmentRow` hook so the D-125 P6.2 `enrichment-or-fetch`
 *  transform resolves through the `data_enrichment` table without
 *  going through the rpc surface. */
export interface TransformContextExtras {
  extendBudget?: (ms: number) => void;
  readEnrichmentRow?: (
    topic: string,
    scope: EnrichmentScope,
    target_id: string,
  ) => EnrichmentRowSnapshot | null;
  /** D-167 P4 — run-local PII alias ledger store for the recipe-mode
   *  `pii-protect` / `pii-restore` transforms. Minted per run by the engine. */
  piiLedgerStore?: PiiLedgerStore;
  /** D-316 amendment — the host's known-value matcher for `content` tags. */
  piiKnownValues?: () => PiiKnownValueSource | undefined;
}

/** Build the TransformContext that every transform function receives.
 *  `extras.extendBudget` propagates the D-116 deliberate-pause hook so
 *  transforms like `wait` can exclude their sleep from
 *  `metadata.budget_ms`. `extras.readEnrichmentRow` is the D-125 P6.2
 *  warehouse hook for `enrichment-or-fetch`. Omit fields on hosts that
 *  don't expose the corresponding capability. */
export const createTransformContext = (
  stores: NamespaceStores,
  extras?: TransformContextExtras,
): TransformContext => ({
  resolve: (ref: string) => resolveValue(ref, stores),
  evaluate: (cond) => evaluateCondition(cond, stores),
  now: () => new Date(),
  getTransform,
  extendBudget: extras?.extendBudget,
  readEnrichmentRow: extras?.readEnrichmentRow,
  piiLedgerStore: extras?.piiLedgerStore,
  piiKnownValues: extras?.piiKnownValues,
});
