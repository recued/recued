/** D-123 Phase 5 + D-132 Phase 6 — Run-now confirm dialog.
 *
 *  Two-button modal that asks the user to confirm before firing the
 *  `housekeeping.task.run_now` rpc. Shows the per-record token
 *  estimate × source-collection count alongside the dollar estimate
 *  (when the model's unit cost is known). Deterministic producers
 *  render the "no token cost" inline copy and skip the dollar row.
 *
 *  D-132 P6 widens the body with the scope-of-read display
 *  (`enrichment.scope_read` — collections + sample fields + record
 *  counts) plus an effective-pool-policy badge so the user sees both
 *  *what* the producer reads and *which AI tier* will service the
 *  call. The widening is purely additive on the cost preview path —
 *  deterministic + AI-blocked branches inherit the scope footprint
 *  unchanged.
 *
 *  Spec: `docs/d-123-spec.md` §5.3 + `docs/d-132-spec.md` §A.6. */

import type {
  EnrichmentPoolPolicy,
  HousekeepingScopeReadEntry,
  HousekeepingTaskStatus,
} from '@recued/contracts';
import { e } from '../../template.js';
import { button } from '../../primitives/button.js';
import { inlineError } from '../../primitives/message.js';
import { computeHousekeepingCostPreview } from './cost-preview.js';
import type { HousekeepingRunNowDialogState } from './state.js';

const POOL_POLICY_LABELS: Record<EnrichmentPoolPolicy, string> = {
  free_only: 'Free pool only',
  free_then_byok: 'Free, then BYOK',
  byok_only: 'BYOK only',
};

const renderScopeOfReadSection = (
  entries: ReadonlyArray<HousekeepingScopeReadEntry>,
): string => {
  if (entries.length === 0) return '';
  return `
    <section class="housekeeping-runnow-scope" aria-label="Scope of read">
      <h4 class="housekeeping-runnow-scope-title">What this reads</h4>
      <ul class="housekeeping-runnow-scope-list">
        ${entries.map((entry) => {
          const count = entry.record_count;
          const countLine = count !== undefined
            ? `<span class="housekeeping-runnow-scope-count">${count} records</span>`
            : '';
          return `
            <li class="housekeeping-runnow-scope-entry">
              <code class="housekeeping-runnow-scope-collection">${e(entry.collection)}</code>
              ${countLine}
              <ul class="housekeeping-runnow-scope-fields">
                ${entry.sample_field_paths.map((p) => `<li><code>${e(p)}</code></li>`).join('')}
              </ul>
            </li>
          `;
        }).join('')}
      </ul>
    </section>
  `;
};

const renderPoolPolicyBadge = (
  policy: EnrichmentPoolPolicy | undefined,
  globalByokAllowed: boolean | undefined,
): string => {
  if (!policy) return '';
  const collapsed = globalByokAllowed === false && policy !== 'free_only';
  const label = collapsed
    ? `${POOL_POLICY_LABELS.free_only} (global BYOK off)`
    : POOL_POLICY_LABELS[policy];
  return `
    <p class="housekeeping-runnow-pool-policy" data-policy="${e(policy)}" data-collapsed="${collapsed ? 'true' : 'false'}">
      <span class="housekeeping-runnow-pool-policy-label">AI routing:</span>
      <span class="housekeeping-runnow-pool-policy-value">${e(label)}</span>
    </p>
  `;
};

export interface HousekeepingRunNowConfirmDialogProps {
  /** When null the dialog is closed. The renderer returns ''. */
  state: HousekeepingRunNowDialogState;
  /** The matching status row for `state.task_id`. The dialog reads
   *  meta.kind + enrichment off this. */
  task?: HousekeepingTaskStatus;
  /** Optional USD per-token cost for the dollar estimate row. */
  modelUnitCostUsd?: number;
}

export const renderHousekeepingRunNowConfirmDialog = (
  props: HousekeepingRunNowConfirmDialogProps,
): string => {
  if (!props.state.task_id) return '';
  const { task } = props;
  if (!task) {
    // Stale dialog — task disappeared from the registry between open
    // and render. Fail safe.
    return '';
  }

  const isEnrichment = task.meta.kind === 'enrichment';
  const enrichment = task.enrichment;

  // Pre-confirm AI-availability gate. When the producer requires an
  // AI path and the live probe couldn't resolve one, render the
  // warning state instead of the cost preview and disable Run Now —
  // the user must configure AI in Settings → AI before the call has
  // any chance of succeeding. The race-window safety net in the
  // producer still applies if a key is removed between probe and
  // confirm; this gate just keeps the common "user hasn't set up AI"
  // case out of the per-task error counter.
  let aiBlocked = false;
  let aiBlockedCopy = '';
  let body = '';
  if (isEnrichment && enrichment) {
    const preview = computeHousekeepingCostPreview({
      enrichment,
      ...(props.modelUnitCostUsd !== undefined
        ? { model_unit_cost_usd: props.modelUnitCostUsd }
        : {}),
    });
    // D-132 P6 — scope-of-read + pool-policy widening. Both sections
    // render across all three branches (deterministic / AI-blocked /
    // AI-runnable) so the user sees the producer's read footprint
    // even when the run won't fire (AI-blocked path) or when no AI
    // is involved at all (deterministic path).
    const scopeSection = renderScopeOfReadSection(enrichment.scope_read ?? []);
    const poolBadge = preview.ai_required
      ? renderPoolPolicyBadge(enrichment.effective_pool_policy, enrichment.global_byok_allowed)
      : '';
    if (preview.deterministic) {
      body = `
        <p>This producer is deterministic — pure SQL aggregation, no token cost.</p>
        <p>Sweeps ${enrichment.source_collection_count} source records.</p>
        ${scopeSection}
      `;
    } else if (preview.ai_required && preview.ai_path_available === false) {
      aiBlocked = true;
      aiBlockedCopy =
        preview.ai_path_reason === 'quota_exhausted'
          ? 'AI quota is exhausted — wait for the daily reset, or add another key in Settings → AI.'
          : 'No AI configured — set up a BYOK slot or a free-pool key in Settings → AI before running this producer.';
      body = `
        <p class="housekeeping-runnow-dialog-warn">${e(aiBlockedCopy)}</p>
        <p>This producer needs an AI call against ${enrichment.source_collection_count} source records.</p>
        ${scopeSection}
        ${poolBadge}
      `;
    } else {
      const costLine =
        preview.estimated_cost_usd !== undefined
          ? `Estimated cost: ~${preview.estimated_tokens.toLocaleString()} tokens ≈ $${preview.estimated_cost_usd.toFixed(2)}.`
          : `Estimated cost: ~${preview.estimated_tokens.toLocaleString()} tokens.`;
      body = `
        <p>${e(costLine)}</p>
        <p>This will fire AI calls against ${enrichment.source_collection_count} source records and consume your free-pool quota / BYOK budget.</p>
        ${scopeSection}
        ${poolBadge}
      `;
    }
  } else {
    body = `
      <p>Run task <code>${e(task.meta.id)}</code> now? This bypasses the idle gate but honours the cycle budget.</p>
    `;
  }

  const errorBlock = props.state.error ? inlineError(props.state.error) : '';

  return `
    <div class="housekeeping-runnow-dialog" role="dialog" aria-modal="true">
      <div class="housekeeping-runnow-dialog-card">
        <h3 class="housekeeping-runnow-dialog-title">Run "${e(task.meta.description)}"?</h3>
        <div class="housekeeping-runnow-dialog-body">${body}</div>
        ${errorBlock}
        <div class="housekeeping-runnow-dialog-actions">
          ${button({
            label: 'Cancel',
            variant: 'secondary',
            action: 'housekeeping-run-now-cancel',
            disabled: props.state.running,
          })}
          ${button({
            label: props.state.running ? 'Running…' : 'Run now',
            variant: 'primary',
            action: 'housekeeping-run-now-confirm',
            data: { taskId: task.meta.id },
            disabled: props.state.running || aiBlocked,
          })}
        </div>
      </div>
    </div>
  `;
};
