/** D-132 Phase 5 — Per-topic detail drawer.
 *
 *  Expand-on-click drawer rendered inline beneath an enrichment
 *  producer row. Shows the producer's scope-of-read, the last 5 runs
 *  with timestamp / status / duration / tokens, an optional confidence
 *  sparkline (when the topic's value_schema declares `confidence:
 *  number`), the last 3 errors from the producer-side ring buffer, the
 *  **Model pool** radios (free_only / free_then_byok / byok_only), the
 *  topic-reset entry-point, and a cross-link to Contracts for read-access
 *  governance.
 *
 *  R25 moved the Run policy (`trust_state`) out to an inline segmented
 *  control ON the producer row, and removed the per-topic MCP-visibility
 *  checkbox — MCP read exposure is now governed per-contract in Contracts,
 *  not per-topic here. So the only write the drawer still issues is the
 *  Model-pool `pool_policy` radio group, through `housekeeping.trust.write`
 *  (`data-action="housekeeping-pool-policy-pick"`); everything else is
 *  read-only.
 *
 *  Spec: D-132 §A.7 + §A.11 +
 *  internal design notes §R25 (LOCKED). */

import {
  ALL_ENRICHMENT_POOL_POLICIES,
  POOL_POLICY_DEFAULT,
  TRUST_ERROR_HISTORY_SIZE,
  type ConfidenceDriftSignal,
  type DriftSeverity,
  type EnrichmentPoolPolicy,
  type EnrichmentTrustRow,
  type HousekeepingErrorEntry,
  type HousekeepingTaskStatus,
  type RegistryDescribeTopicEntry,
} from '@recued/contracts';
import { e } from '../../template.js';
import { button } from '../../primitives/button.js';
import { inlineError } from '../../primitives/message.js';
import type {
  HousekeepingDrawerRunEntry,
  HousekeepingDrawerScopeRead,
} from './state.js';

/** Derive the bare enrichment topic from a scheduler task id. The trust
 *  store + `ENRICHMENT_REGISTRY` + `housekeeping.trust.*` rpc all key on
 *  the bare topic; the drawer / row derive it from the task meta so the
 *  host doesn't thread an extra prop.
 *
 *  `buildEnrichmentProducerTask` shapes ids as `enrichment.<topic>` or —
 *  for producers registered with a `task_id_suffix` — `enrichment.<topic>
 *  .<suffix>` (e.g. `enrichment.open_loop_pressure.project`). Both the
 *  topic and the suffix are dot-free (snake_case / `[a-z0-9_]`), so the
 *  bare topic is the first segment after the prefix. Stripping ONLY the
 *  prefix would leave `open_loop_pressure.project`, which is not a
 *  registry / trust-store key — the run-policy write would target an
 *  unknown topic and the one-liner would miss its `user_value`. */
export const topicFromTaskId = (id: string): string => {
  const withoutPrefix = id.startsWith('enrichment.')
    ? id.slice('enrichment.'.length)
    : id;
  const dot = withoutPrefix.indexOf('.');
  return dot === -1 ? withoutPrefix : withoutPrefix.slice(0, dot);
};

export interface HousekeepingDetailDrawerProps {
  /** The expanded enrichment task. Drawer reads description + scope
   *  + topic off it. */
  task: HousekeepingTaskStatus;
  /** Producer-declared scope-of-read. Empty array → "no scope
   *  declared" hint (only happens during boot races; the registry
   *  validator enforces non-empty at producer registration). */
  scopeRead: ReadonlyArray<HousekeepingDrawerScopeRead>;
  /** Per-topic trust row from `housekeeping.trust.read`. Null →
   *  fall back to the registry default `pool_policy`. Only the
   *  `pool_policy` field is read here (R25 moved `trust_state` to the
   *  inline row control). */
  trustRow: EnrichmentTrustRow | null;
  /** Last-N runs for the per-task table, newest first. Empty →
   *  "Not run yet". */
  recentRuns: ReadonlyArray<HousekeepingDrawerRunEntry>;
  /** Last-N errors from `housekeeping_state.last_errors_json`. Empty
   *  → no error block rendered. */
  errorHistory: ReadonlyArray<HousekeepingErrorEntry>;
  /** True iff the topic's value_schema declares `confidence: number`.
   *  Drives the sparkline-section visibility gate. */
  hasConfidenceField: boolean;
  /** D-133 — drift signal for this topic, populated from
   *  `state.driftSignals[topic]` when the housekeeping cycle has
   *  computed PSI for it. Null/undefined → drift section hidden
   *  (no row yet — sparse / new producer). */
  driftSignal?: ConfidenceDriftSignal | null;
  /** Model-pool-write rpc in flight for this topic. Disables the
   *  Model-pool radios while true. */
  writing: boolean;
  /** Last write error for this topic, cleared on next write. */
  writeError: string | null;
  /** D-136 §A.13.1 + §A.14.4 P7.G — registry describe slice for this
   *  topic. Drives the Coverage panel (band + reasoning + per-axis
   *  numbers). Absent → Coverage panel hidden (boot race before
   *  `housekeeping.registry.describe` returned). */
  coverageEntry?: RegistryDescribeTopicEntry | null;
  /** When false, the destructive "Reset topic" section is omitted from
   *  the drawer — lets a host mount the trust controls without wiring
   *  the topic-reset flow (no dead button). Defaults to true; the
   *  canonical panel shows it. */
  showResetSection?: boolean;
  /** "now" for the relative-time formatter. Tests pass a fixed
   *  timestamp so renders are deterministic. */
  now: number;
}

const POOL_LABELS: Record<EnrichmentPoolPolicy, { label: string; description: string }> = {
  free_only: { label: 'Free only', description: 'Skip when free pool is exhausted; never use BYOK.' },
  free_then_byok: { label: 'Free then BYOK', description: 'Try free pool first, fall back to BYOK.' },
  byok_only: { label: 'BYOK only', description: 'Bypass free pool, use BYOK directly.' },
};

const RUN_STATUS_LABELS: Record<HousekeepingDrawerRunEntry['status'], string> = {
  complete: 'Complete',
  yield: 'Yielded',
  error: 'Error',
};

const SPARK_BLOCKS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇'] as const;

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

const renderRunHistory = (
  runs: ReadonlyArray<HousekeepingDrawerRunEntry>,
  now: number,
): string => {
  if (runs.length === 0) {
    return `<p class="housekeeping-drawer-empty">Not run yet.</p>`;
  }
  return `
    <table class="housekeeping-drawer-runs">
      <thead>
        <tr>
          <th>When</th>
          <th>Status</th>
          <th>Duration</th>
          <th>Tokens</th>
        </tr>
      </thead>
      <tbody>
        ${runs.map((r) => `
          <tr>
            <td>${e(formatRelative(r.ts, now))}</td>
            <td class="housekeeping-drawer-run-status" data-status="${e(r.status)}">${e(RUN_STATUS_LABELS[r.status])}</td>
            <td>${r.duration_ms}ms</td>
            <td>${r.tokens != null ? r.tokens.toLocaleString() : '—'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
};

const DRIFT_SEVERITY_LABELS: Record<DriftSeverity, string> = {
  none: 'None',
  moderate: 'Moderate',
  significant: 'Significant',
};

const formatWindow = (window: { start_at: number; end_at: number; sample_count: number }): string => {
  const start = new Date(window.start_at).toISOString().slice(0, 10);
  const end = new Date(window.end_at).toISOString().slice(0, 10);
  return `${start} → ${end} (${window.sample_count} samples)`;
};

const renderDriftSignalSection = (signal: ConfidenceDriftSignal): string => {
  const psi = signal.psi.toFixed(3);
  // ⛔ D-281 — lead with what DECIDED. `shift` is absent on pre-D-281 rows
  // and on rows where the cut partitioned nothing and PSI decided, so the
  // PSI figure stays — labelled as the diagnostic it is.
  const s = signal.shift;
  const headline = s === undefined
    ? `PSI=${e(psi)}`
    : `low confidence ${e((s.baseline_rate * 100).toFixed(0))}% → `
      + `${e((s.recent_rate * 100).toFixed(0))}% `
      + `(n=${e(String(s.recent_n))}, p=${e(s.p_value < 0.001 ? '<0.001' : s.p_value.toFixed(3))})`;
  const label = DRIFT_SEVERITY_LABELS[signal.severity];
  return `
    <div class="housekeeping-drawer-drift" data-source-topic="${e(signal.source_topic)}" data-severity="${e(signal.severity)}">
      <div class="housekeeping-drawer-drift-headline">
        <span class="housekeeping-drawer-drift-psi">${headline}</span>
        <span class="housekeeping-drawer-drift-severity-badge" data-severity="${e(signal.severity)}">${e(label)}</span>
      </div>
      <dl class="housekeeping-drawer-drift-windows">
        <dt>Recent</dt>
        <dd>${e(formatWindow(signal.recent_window))}</dd>
        <dt>Baseline</dt>
        <dd>${e(formatWindow(signal.baseline_window))}</dd>
      </dl>
    </div>
  `;
};

const renderConfidenceSparkline = (
  runs: ReadonlyArray<HousekeepingDrawerRunEntry>,
): string => {
  const samples = runs
    .filter((r) => typeof r.confidence === 'number')
    .map((r) => r.confidence as number);
  if (samples.length === 0) {
    return `<p class="housekeeping-drawer-empty">No confidence data yet.</p>`;
  }
  const max = Math.max(0.0001, ...samples);
  const blocks = samples
    .map((v) => {
      const ratio = Math.min(1, Math.max(0, v / max));
      const idx = Math.min(SPARK_BLOCKS.length - 1, Math.max(0, Math.round(ratio * (SPARK_BLOCKS.length - 1))));
      return SPARK_BLOCKS[idx];
    })
    .join('');
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  return `
    <div class="housekeeping-drawer-confidence">
      <span class="housekeeping-drawer-confidence-spark" aria-label="confidence sparkline">${blocks}</span>
      <span class="housekeeping-drawer-confidence-meta">avg ${avg.toFixed(2)} (${samples.length} runs)</span>
    </div>
  `;
};

const renderErrorHistory = (
  errors: ReadonlyArray<HousekeepingErrorEntry>,
  now: number,
): string => {
  if (errors.length === 0) {
    return `<p class="housekeeping-drawer-empty">No recent errors.</p>`;
  }
  return `
    <ul class="housekeeping-drawer-errors">
      ${errors.slice(0, TRUST_ERROR_HISTORY_SIZE).map((err) => `
        <li class="housekeeping-drawer-error">
          <span class="housekeeping-drawer-error-time">${e(formatRelative(err.ts, now))}</span>
          <code class="housekeeping-drawer-error-msg">${e(err.message)}</code>
        </li>
      `).join('')}
    </ul>
  `;
};

const renderRadios = <T extends string>(
  group: string,
  topic: string,
  options: ReadonlyArray<T>,
  selected: T,
  labels: Record<T, { label: string; description: string }>,
  action: string,
  dataField: string,
  disabled: boolean,
): string => `
  <fieldset class="housekeeping-drawer-radios" data-group="${e(group)}" data-topic="${e(topic)}">
    ${options.map((value) => `
      <label class="housekeeping-drawer-radio">
        <input
          type="radio"
          name="${e(group)}-${e(topic)}"
          value="${e(value)}"
          data-action="${e(action)}"
          data-topic="${e(topic)}"
          data-${e(dataField)}="${e(value)}"
          ${selected === value ? 'checked' : ''}
          ${disabled ? 'disabled' : ''}
        />
        <span class="housekeeping-drawer-radio-label">${e(labels[value].label)}</span>
        <span class="housekeeping-drawer-radio-desc">${e(labels[value].description)}</span>
      </label>
    `).join('')}
  </fieldset>
`;

const renderScopeRead = (
  scopeRead: ReadonlyArray<HousekeepingDrawerScopeRead>,
  recordTotal: number | undefined,
): string => {
  if (scopeRead.length === 0) {
    return `<p class="housekeeping-drawer-empty">No scope-of-read declared.</p>`;
  }
  return `
    <ul class="housekeeping-drawer-scope-list">
      ${scopeRead.map((entry) => {
        // P6 — prefer the per-entry record_count populated by the
        // server's preview-time count; fall back to the producer's
        // primary source-collection total when the entry doesn't
        // carry its own count (e.g. P5-era state-side scope rows or
        // pre-walker boot races).
        const count = entry.record_count ?? recordTotal;
        const countLine = count !== undefined
          ? `<span class="housekeeping-drawer-scope-count">${count} records</span>`
          : '';
        return `
          <li class="housekeeping-drawer-scope-entry">
            <code class="housekeeping-drawer-scope-collection">${e(entry.collection)}</code>
            ${countLine}
            <ul class="housekeeping-drawer-scope-fields">
              ${entry.sample_field_paths.map((p) => `<li><code>${e(p)}</code></li>`).join('')}
            </ul>
          </li>
        `;
      }).join('')}
    </ul>
  `;
};

// ──────────────────────────────────────────────────────────────────
// D-136 §A.14.4 P7.G — Coverage panel
// ──────────────────────────────────────────────────────────────────

const COVERAGE_BAND_LABELS: Record<
  RegistryDescribeTopicEntry['coverage_quality'],
  string
> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  novel_query_likely_uncovered: 'Novel — likely uncovered',
};

const formatRelativeAge = (then: number, now: number): string => {
  const ms = Math.max(0, now - then);
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

const renderCoveragePanel = (
  entry: RegistryDescribeTopicEntry,
  now: number,
): string => {
  const cov = entry.coverage;
  const lastEvent = cov.latest_event_at !== null
    ? formatRelativeAge(cov.latest_event_at, now)
    : 'never';
  const failurePct = (cov.producer_failure_rate_24h * 100).toFixed(1);
  return `
    <div class="housekeeping-drawer-coverage" data-band="${e(entry.coverage_quality)}">
      <div class="housekeeping-drawer-coverage-headline">
        <span class="housekeeping-drawer-coverage-band-badge" data-band="${e(entry.coverage_quality)}">
          ${e(COVERAGE_BAND_LABELS[entry.coverage_quality])}
        </span>
        <span class="housekeeping-drawer-coverage-reasoning">${e(entry.coverage_quality_reasoning)}</span>
      </div>
      <dl class="housekeeping-drawer-coverage-stats">
        <dt>Rows in warehouse</dt>
        <dd>${cov.row_count.toLocaleString()}</dd>
        <dt>Latest event</dt>
        <dd>${e(lastEvent)}</dd>
        <dt>Producer failure rate (24h)</dt>
        <dd>${failurePct}%</dd>
        <dt>Compression class</dt>
        <dd>${e(entry.compression_class)}</dd>
      </dl>
      ${entry.prompt_bias_hints.length > 0 ? `
        <details class="housekeeping-drawer-coverage-bias">
          <summary>Prompt bias hints (${entry.prompt_bias_hints.length})</summary>
          <ul>
            ${entry.prompt_bias_hints.map((h) => `<li><code>${e(h)}</code></li>`).join('')}
          </ul>
        </details>
      ` : ''}
    </div>
  `;
};

// ──────────────────────────────────────────────────────────────────
// D-136 §A.13.5 P7.G — MCP visibility toggle
// ──────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────
// R25 — Read-access cross-link
// ──────────────────────────────────────────────────────────────────

// R25 point 7C — the per-topic MCP-visibility checkbox was removed. Which
// AI agents can read this topic is now governed per-contract; the drawer
// links out to Contracts rather than exposing a global override here. The
// anchor uses the app-wide `#contracts` hash route (the shell's hash
// router picks it up); ui-shared stays decoupled from the webclient's
// route-attr constants.
const renderReadAccessSection = (): string => `
  <p class="housekeeping-drawer-read-access-note">
    Which AI agents can read this topic over MCP is granted per contract.
  </p>
  <a class="housekeeping-drawer-read-access-link" href="#contracts">Manage read access in Contracts →</a>
`;

// ──────────────────────────────────────────────────────────────────
// D-136 §A.12 P7.G — Reset entry-point
// ──────────────────────────────────────────────────────────────────

const renderResetSection = (topic: string): string => `
  <div class="housekeeping-drawer-reset">
    <p class="housekeeping-drawer-reset-warning">
      Tombstone every non-pinned row for this topic + enqueue a recompute on
      the next housekeeping cycle. Substrate panic button — use sparingly.
    </p>
    ${button({
      label: 'Reset topic…',
      variant: 'danger',
      size: 'sm',
      action: 'housekeeping-reset-open',
      data: { topic },
    })}
  </div>
`;

export const renderHousekeepingDetailDrawer = (
  props: HousekeepingDetailDrawerProps,
): string => {
  const topic = topicFromTaskId(props.task.meta.id);
  const poolPolicy: EnrichmentPoolPolicy =
    props.trustRow?.pool_policy ?? POOL_POLICY_DEFAULT;
  const errorBlock = props.writeError ? inlineError(props.writeError) : '';
  const recordTotal = props.task.enrichment?.source_collection_count;

  return `
    <div class="housekeeping-drawer" data-topic="${e(topic)}" role="region" aria-label="Detail drawer for ${e(topic)}">
      <section class="housekeeping-drawer-section housekeeping-drawer-description">
        <h4>About</h4>
        <p>${e(props.task.meta.description)}</p>
      </section>

      ${props.coverageEntry ? `
        <section class="housekeeping-drawer-section housekeeping-drawer-coverage-section">
          <h4>Coverage</h4>
          ${renderCoveragePanel(props.coverageEntry, props.now)}
        </section>
      ` : ''}

      <section class="housekeeping-drawer-section housekeeping-drawer-scope">
        <h4>What this reads</h4>
        ${renderScopeRead(props.scopeRead, recordTotal)}
      </section>

      <section class="housekeeping-drawer-section housekeeping-drawer-recent-runs">
        <h4>Last ${Math.max(1, props.recentRuns.length)} run${props.recentRuns.length === 1 ? '' : 's'}</h4>
        ${renderRunHistory(props.recentRuns, props.now)}
      </section>

      ${props.hasConfidenceField ? `
        <section class="housekeeping-drawer-section housekeeping-drawer-confidence-section">
          <h4>Confidence</h4>
          ${renderConfidenceSparkline(props.recentRuns)}
        </section>
      ` : ''}

      ${props.driftSignal ? `
        <section class="housekeeping-drawer-section housekeeping-drawer-drift-section">
          <h4>Drift</h4>
          ${renderDriftSignalSection(props.driftSignal)}
        </section>
      ` : ''}

      <section class="housekeeping-drawer-section housekeeping-drawer-error-history">
        <h4>Recent errors</h4>
        ${renderErrorHistory(props.errorHistory, props.now)}
      </section>

      <section class="housekeeping-drawer-section housekeeping-drawer-pool">
        <h4>Model pool</h4>
        ${renderRadios(
          'housekeeping-pool',
          topic,
          ALL_ENRICHMENT_POOL_POLICIES,
          poolPolicy,
          POOL_LABELS,
          'housekeeping-pool-policy-pick',
          'poolPolicy',
          props.writing,
        )}
      </section>

      ${errorBlock}

      <section class="housekeeping-drawer-section housekeeping-drawer-read-access">
        <h4>Read access</h4>
        ${renderReadAccessSection()}
      </section>

      ${props.showResetSection === false ? '' : `
      <section class="housekeeping-drawer-section housekeeping-drawer-reset-section">
        <h4>Reset topic</h4>
        ${renderResetSection(topic)}
      </section>`}

      <p class="housekeeping-drawer-wipe-note">
        Disabling preserves prior enrichment data — re-enable any time. Uninstall the pack to remove rows.
      </p>
    </div>
  `;
};
