/** D-123 Phase 5 — Enrichment (AI) producer section.
 *
 *  Lists `kind: 'enrichment'` tasks. R25 reshapes the D-132 table:
 *
 *    Producer (name + LLM badge + one-liner) | Run policy | Last run | Actions
 *
 *  The **Run policy** (Off / Manual / Auto) is a segmented control
 *  INLINE on the row (was two clicks deep in the drawer under the
 *  "Trust" label; the `trust_state` substrate is unchanged — only the
 *  label + placement move). The row one-liner renders the registry's
 *  `user_value` copy, not the engineering `description`. A one-line
 *  search + a cost toggle (All / LLM / Computed) replace the old
 *  8-namespace chip wall. Clicking `⋯` toggles the per-topic drawer
 *  (model pool · coverage · runs · confidence · drift · errors · reset).
 *
 *  The host wires `data-action="housekeeping-drawer-toggle"`,
 *  `data-action="housekeeping-trust-state-pick"` (the inline run-policy
 *  radios), and the filter-bar actions back to the matching
 *  `housekeeping.*` rpcs / mount-local filter state.
 *
 *  Spec: D-123 §5.2/§5.3 + D-132 §A.7 +
 *  internal design notes §R25 (LOCKED). */

import type {
  ConfidenceDriftSignal,
  EnrichmentTrustRow,
  EnrichmentTrustState,
  HousekeepingErrorEntry,
  HousekeepingLastStatus,
  HousekeepingTaskStatus,
  RegistryDescribeTopicEntry,
} from '@recued/contracts';
import {
  ALL_ENRICHMENT_TRUST_STATES,
  TRUST_DEFAULT_AI,
  TRUST_DEFAULT_DETERMINISTIC,
} from '@recued/contracts';
import { e } from '../../template.js';
import { button } from '../../primitives/button.js';
import { inlineError } from '../../primitives/message.js';
import { computeHousekeepingCostPreview } from './cost-preview.js';
import {
  renderHousekeepingDetailDrawer,
  topicFromTaskId,
} from './detail-drawer.js';
import {
  filterProducers,
  producerOneLiner,
  renderHousekeepingProducerFilterBar,
  type HousekeepingProducerCostFilter,
} from './producer-filter-bar.js';
import type {
  HousekeepingDrawerRunEntry,
  HousekeepingDrawerScopeRead,
} from './state.js';

export interface HousekeepingEnrichmentProducerSectionProps {
  tasks: ReadonlyArray<HousekeepingTaskStatus>;
  /** R25 — mount-local search string. Case-insensitive substring over
   *  topic slug + `user_value`. Empty = no search filter. */
  search: string;
  /** R25 — mount-local cost-axis choice (All / LLM / Computed). */
  costFilter: HousekeepingProducerCostFilter;
  /** Optional USD per-token cost for the dollar estimate row. The
   *  sidebar / webapp wires this from the active model's price
   *  card; absent → cost row hidden. */
  modelUnitCostUsd?: number;
  /** D-132 P5 — Topic of the row currently expanded into the detail
   *  drawer. Null when no row is expanded. */
  expandedTopic: string | null;
  /** D-132 P5 — Per-topic trust rows. Topics absent fall back to
   *  registry defaults. */
  trustRows: Record<string, EnrichmentTrustRow>;
  /** D-132 P5 — Per-topic recent-runs feed for the drawer. */
  recentRuns: Record<string, ReadonlyArray<HousekeepingDrawerRunEntry>>;
  /** D-132 P5 — Per-topic last-N error feed for the drawer. */
  errorHistory: Record<string, ReadonlyArray<HousekeepingErrorEntry>>;
  /** D-132 P5 — Per-topic confidence-field flag. */
  hasConfidenceField: Record<string, boolean>;
  /** D-132 P5 — Per-topic trust-write in-flight flag. Disables the
   *  inline run-policy radios (+ the drawer's model-pool radios). */
  trustWriting: Record<string, boolean>;
  /** D-132 P5 — Per-topic last write error. */
  trustWriteError: Record<string, string>;
  /** D-132 P5 — Per-topic producer scope-of-read declaration. The
   *  host derives from the producer manifest cache. Absent → drawer
   *  renders the "no scope declared" empty hint. */
  scopeRead: Record<string, ReadonlyArray<HousekeepingDrawerScopeRead>>;
  /** D-133 — Drift signals keyed by source topic. Drawer reads
   *  `driftSignals[topic]` to render the Drift section; topics
   *  absent skip the section. */
  driftSignals: Record<string, ConfidenceDriftSignal>;
  /** D-136 P7.G — per-topic registry describe slice. Drawer reads
   *  `coverageEntries[topic]` to render the Coverage panel. */
  coverageEntries: Record<string, RegistryDescribeTopicEntry>;
  /** When false, the drawer omits the destructive "Reset topic"
   *  section (passed through to the detail drawer). Defaults to true. */
  showResetSection?: boolean;
  /** "now" passed through to the relative-time formatter. */
  now: number;
}

const TRUST_LABELS_SHORT: Record<EnrichmentTrustState, string> = {
  off: 'Off',
  manual: 'Manual',
  auto: 'Auto',
};

const STATUS_LABELS: Record<HousekeepingLastStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  complete: 'Complete',
  error: 'Error',
};

const formatRelative = (then: number, now: number): string => {
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

const trustStateForRow = (
  topic: string,
  rows: Record<string, EnrichmentTrustRow>,
  isAiSurface: boolean,
): EnrichmentTrustState => {
  const persisted = rows[topic];
  if (persisted) return persisted.trust_state;
  return isAiSurface ? TRUST_DEFAULT_AI : TRUST_DEFAULT_DETERMINISTIC;
};

/** R25 — the inline Run-policy segmented control. Three radios styled
 *  as a segmented toggle; each writes `trust_state` through the same
 *  `housekeeping-trust-state-pick` action the drawer used, so the D-132
 *  substrate + host handler are untouched. Disabled while a write for
 *  the topic is in flight. */
const renderRunPolicyControl = (
  topic: string,
  selected: EnrichmentTrustState,
  writing: boolean,
): string => `
  <fieldset
    class="housekeeping-producer-runpolicy"
    data-topic="${e(topic)}"
    aria-label="Run policy for ${e(topic)}"
  >
    ${ALL_ENRICHMENT_TRUST_STATES.map((value) => `
      <label class="housekeeping-producer-runpolicy-seg" data-active="${selected === value ? 'true' : 'false'}">
        <input
          type="radio"
          name="runpolicy-${e(topic)}"
          value="${e(value)}"
          data-action="housekeeping-trust-state-pick"
          data-topic="${e(topic)}"
          data-trust-state="${e(value)}"
          ${selected === value ? 'checked' : ''}
          ${writing ? 'disabled' : ''}
        />
        <span>${e(TRUST_LABELS_SHORT[value])}</span>
      </label>
    `).join('')}
  </fieldset>
`;

const renderRow = (
  status: HousekeepingTaskStatus,
  props: HousekeepingEnrichmentProducerSectionProps,
): string => {
  const enrichment = status.enrichment;
  const topic = topicFromTaskId(status.meta.id);
  const isAiSurface = enrichment ? enrichment.token_estimate_per_record > 0 : false;
  const trustState = trustStateForRow(topic, props.trustRows, isAiSurface);
  const lastStatus: HousekeepingLastStatus = status.state?.last_status ?? 'pending';
  const lastRun =
    status.state?.last_run_at != null
      ? formatRelative(status.state.last_run_at, props.now)
      : '—';
  const expanded = props.expandedTopic === topic;
  const runNowDisabled = !enrichment || trustState === 'off';
  const writing = props.trustWriting[topic] ?? false;
  const writeError = props.trustWriteError[topic] ?? null;
  const oneLiner = producerOneLiner(status);

  // Cost line for the drawer's expanded view (unchanged D-123 behaviour).
  const costLine = (() => {
    if (!enrichment) return 'producer info not loaded';
    const preview = computeHousekeepingCostPreview({
      enrichment,
      ...(props.modelUnitCostUsd !== undefined
        ? { model_unit_cost_usd: props.modelUnitCostUsd }
        : {}),
    });
    if (preview.deterministic) {
      return `Deterministic — no token cost (${enrichment.source_collection_count} source records).`;
    }
    if (preview.estimated_cost_usd !== undefined) {
      return `~${preview.estimated_tokens.toLocaleString()} tokens × ${enrichment.source_collection_count} records ≈ $${preview.estimated_cost_usd.toFixed(2)}`;
    }
    return `~${preview.estimated_tokens.toLocaleString()} tokens (across ${enrichment.source_collection_count} source records)`;
  })();

  // D-132 P6 — prefer the rpc-side scope-of-read over the state-side
  // fallback the host plumbs through during boot.
  const scopeReadEntries = enrichment?.scope_read?.length
    ? enrichment.scope_read
    : (props.scopeRead[topic] ?? []);

  const drawer = expanded
    ? renderHousekeepingDetailDrawer({
        task: status,
        scopeRead: scopeReadEntries,
        trustRow: props.trustRows[topic] ?? null,
        recentRuns: props.recentRuns[topic] ?? [],
        errorHistory: props.errorHistory[topic] ?? [],
        hasConfidenceField: props.hasConfidenceField[topic] ?? false,
        driftSignal: props.driftSignals[topic] ?? null,
        writing,
        writeError,
        coverageEntry: props.coverageEntries[topic] ?? null,
        ...(props.showResetSection !== undefined
          ? { showResetSection: props.showResetSection }
          : {}),
        now: props.now,
      })
    : '';

  return `
    <tbody class="housekeeping-producer-row-group" data-topic="${e(topic)}" data-task-id="${e(status.meta.id)}" data-expanded="${expanded ? 'true' : 'false'}">
      <tr class="housekeeping-producer-row" data-task-status="${e(lastStatus)}">
        <td class="housekeeping-producer-topic">
          <div class="housekeeping-producer-topic-head">
            <code>${e(topic)}</code>
            ${isAiSurface ? `<span class="housekeeping-producer-llm-badge" title="Uses an LLM call">LLM</span>` : ''}
            ${lastStatus === 'error' ? `<span class="housekeeping-producer-status-flag" title="Last run errored">${e(STATUS_LABELS.error)}</span>` : ''}
          </div>
          <div class="housekeeping-producer-oneliner">${e(oneLiner)}</div>
        </td>
        <td class="housekeeping-producer-runpolicy-cell">
          ${renderRunPolicyControl(topic, trustState, writing)}
          ${writeError ? `<div class="housekeeping-producer-runpolicy-error">${inlineError(writeError)}</div>` : ''}
        </td>
        <td class="housekeeping-producer-last-run">${e(lastRun)}</td>
        <td class="housekeeping-producer-action">
          ${button({
            label: 'Run now',
            ariaLabel: `Run ${status.meta.id} now`,
            size: 'xs',
            action: 'housekeeping-run-now-open',
            data: { 'task-id': status.meta.id },
            disabled: runNowDisabled,
            ...(trustState === 'off'
              ? { title: 'Run policy is Off — set Manual or Auto to enable Run now.' }
              : {}),
          })}
          ${button({
            label: expanded ? '×' : '⋯',
            size: 'xs',
            action: 'housekeeping-drawer-toggle',
            data: { topic },
            extraClass: 'housekeeping-drawer-toggle-button',
            ariaLabel: expanded ? `Collapse ${topic} details` : `Expand ${topic} details`,
          })}
        </td>
      </tr>
      ${expanded ? `
        <tr class="housekeeping-producer-drawer-row">
          <td colspan="4" class="housekeeping-producer-drawer-cell">
            <div class="housekeeping-producer-cost-line">${e(costLine)}</div>
            ${drawer}
          </td>
        </tr>
      ` : ''}
    </tbody>
  `;
};

export const renderHousekeepingEnrichmentProducerSection = (
  props: HousekeepingEnrichmentProducerSectionProps,
): string => {
  const enrichments = props.tasks.filter((t) => t.meta.kind === 'enrichment');
  const filterBar = renderHousekeepingProducerFilterBar({
    search: props.search,
    cost: props.costFilter,
  });
  // The single "AI producers" heading + filter bar own this surface —
  // the mount no longer wraps it in a second heading (R25 double-heading
  // fix). Render the bar even when the list is empty so the search box
  // that produced a zero-result filter stays reachable.
  const body = (() => {
    if (enrichments.length === 0) {
      return `<p class="housekeeping-producer-empty">No enrichment producers registered yet.</p>`;
    }
    const visible = filterProducers(enrichments, props.search, props.costFilter);
    if (visible.length === 0) {
      return `<p class="housekeeping-producer-empty">No producers match the current filter.</p>`;
    }
    return `
      <table class="housekeeping-producer-table">
        <thead>
          <tr>
            <th>Producer</th>
            <th>Run policy</th>
            <th>Last run</th>
            <th></th>
          </tr>
        </thead>
        ${visible.map((t) => renderRow(t, props)).join('')}
      </table>
    `;
  })();

  return `
    <section class="housekeeping-producers" aria-label="AI producers">
      <h3>AI producers</h3>
      ${filterBar}
      ${body}
    </section>
  `;
};
