/** D-123 Phase 5 — Housekeeping panel renderer.
 *
 *  Top-level component that hosts mount on Settings → Server →
 *  Housekeeping. Pure HTML — every state input arrives via `props`.
 *  The host wires `data-action` clicks to `housekeeping.config.read /
 *  write` + `housekeeping.status.read` + `housekeeping.task.run_now`
 *  rpcs and patches the panel state back through.
 *
 *  Spec wireframe (`docs/d-123-spec.md` §5.2):
 *
 *    [Housekeeping]
 *      Schedule
 *        ( ) Light       Every 60 min when idle, 30 s budget...
 *        (•) Balanced    Every 15 min when idle, 60 s budget...
 *        ( ) Aggressive  Continuously when idle for 5 min+...
 *        ( ) Custom      Pick budget, interval, and quiet-hours window.
 *
 *      [Save]                                  ⓘ saved 2 m ago
 *
 *      Core tasks
 *        | Task | Cursor | Last run | Status |
 *        ...
 *
 *      Enrichment producers
 *        thread_signals  Deterministic — no cost     [Run now]
 *
 *  Spec: `docs/d-123-spec.md` §5.2. */

import type { HousekeepingTaskStatus } from '@recued/contracts';
import { e } from '../../template.js';
import { button } from '../../primitives/button.js';
import { inlineError } from '../../primitives/message.js';
import { renderHousekeepingPresetPicker } from './preset-picker.js';
import { renderHousekeepingCustomWindowFields } from './custom-window-fields.js';
import { renderHousekeepingEnrichmentProducerSection } from './enrichment-producer-section.js';
import { renderHousekeepingRunNowConfirmDialog } from './run-now-confirm-dialog.js';
import { renderHousekeepingPromotionBanner } from './promotion-banner.js';
import { renderHousekeepingDriftBanner } from './drift-banner.js';
import { renderHousekeepingTopicResetModal } from './topic-reset-modal.js';
import { renderHousekeepingLlmResultCacheCard } from './llm-result-cache-card.js';
import type { HousekeepingProducerCostFilter } from './producer-filter-bar.js';
import type { HousekeepingPanelState } from './state.js';

export interface HousekeepingPanelProps extends HousekeepingPanelState {
  /** "now" passed through to the relative-time formatter on the
   *  producer rows. */
  now: number;
  /** Optional USD per-token cost for the enrichment dollar
   *  estimate row + Run-now dialog. */
  modelUnitCostUsd?: number;
  /** R25 — AI-producer search string. Defaults to '' (no search). */
  producerSearch?: string;
  /** R25 — AI-producer cost-axis filter. Defaults to 'all'. */
  producerCostFilter?: HousekeepingProducerCostFilter;
}

const findTaskById = (
  tasks: ReadonlyArray<HousekeepingTaskStatus>,
  id: string | null,
): HousekeepingTaskStatus | undefined => {
  if (!id) return undefined;
  return tasks.find((t) => t.meta.id === id);
};

export const renderHousekeepingPanel = (props: HousekeepingPanelProps): string => {
  if (props.loading && !props.config) {
    return `<p class="housekeeping-loading">Loading housekeeping config…</p>`;
  }

  if (props.error) {
    return inlineError(props.error);
  }

  if (!props.config) {
    return inlineError('Housekeeping config unavailable.');
  }

  const draftPreset = props.draftPreset ?? props.config.preset;
  const showCustomFields = draftPreset === 'custom';
  const dirty =
    props.draftPreset !== null && props.draftPreset !== props.config.preset;
  const dirtyCustomFields =
    showCustomFields && Object.keys(props.customDraft).length > 0;
  const canSave = (dirty || dirtyCustomFields) && !props.saving;

  return `
    <div class="housekeeping-panel">
      <header class="housekeeping-header">
        <h2>Housekeeping</h2>
        <p class="housekeeping-summary">
          Idle-driven deterministic maintenance. Cleans up cascades you
          initiated, keeps enrichment substrate fresh, never runs AI
          without your explicit click.
        </p>
      </header>

      ${renderHousekeepingPromotionBanner({
        suggestions: props.promotionSuggestions,
        writing: props.promotionWriting,
        writeError: props.promotionWriteError,
      })}

      ${renderHousekeepingDriftBanner({
        signals: props.driftSignals,
        writing: props.driftWriting,
        writeError: props.driftWriteError,
      })}

      ${renderHousekeepingPresetPicker({
        active: props.config.preset,
        draft: props.draftPreset,
        saving: props.saving,
      })}

      ${showCustomFields
        ? renderHousekeepingCustomWindowFields({
            config: props.config,
            draft: props.customDraft,
            saving: props.saving,
          })
        : ''}

      ${props.saveError ? inlineError(props.saveError) : ''}

      <div class="housekeeping-actions">
        ${button({
          label: props.saving ? 'Saving…' : 'Save',
          variant: 'primary',
          size: 'sm',
          action: 'housekeeping-save',
          disabled: !canSave,
        })}
        <span class="housekeeping-current-summary">
          Currently ${e(props.config.preset)}
          ${props.config.preset !== 'off'
            ? `· ${formatBudget(props.config.cycle_budget_ms)} budget`
            : ''}
        </span>
      </div>

      ${renderHousekeepingEnrichmentProducerSection({
        tasks: props.tasks,
        search: props.producerSearch ?? '',
        costFilter: props.producerCostFilter ?? 'all',
        ...(props.modelUnitCostUsd !== undefined
          ? { modelUnitCostUsd: props.modelUnitCostUsd }
          : {}),
        expandedTopic: props.expandedTopic,
        trustRows: props.trustRows,
        recentRuns: props.recentRuns,
        errorHistory: props.errorHistory,
        hasConfidenceField: props.hasConfidenceField,
        trustWriting: props.trustWriting,
        trustWriteError: props.trustWriteError,
        scopeRead: props.scopeRead,
        driftSignals: props.driftSignals,
        coverageEntries: props.coverageEntries,
        now: props.now,
      })}

      ${renderHousekeepingRunNowConfirmDialog({
        state: props.runNow,
        ...((() => {
          const t = findTaskById(props.tasks, props.runNow.task_id);
          return t ? { task: t } : {};
        })()),
        ...(props.modelUnitCostUsd !== undefined
          ? { modelUnitCostUsd: props.modelUnitCostUsd }
          : {}),
      })}

      ${renderHousekeepingTopicResetModal({
        state: props.reset,
        now: props.now,
        ...(props.modelUnitCostUsd !== undefined
          ? { modelUnitCostUsd: props.modelUnitCostUsd }
          : {}),
      })}

      ${renderHousekeepingLlmResultCacheCard({
        state: props.cache,
        now: props.now,
      })}
    </div>
  `;
};

const formatBudget = (ms: number): string => {
  if (ms >= 60_000) return `${Math.round(ms / 1000)}s`;
  return `${ms}ms`;
};
