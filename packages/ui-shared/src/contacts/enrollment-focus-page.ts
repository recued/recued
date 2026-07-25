/** D-138 Phase 2 — enrollment-time focus page.
 *
 *  Inserted into the connection-creation flow after a vendor (or any
 *  api/mcp/notification) connection saves successfully and the
 *  reconciler kicks off its first sync. The page covers the user's
 *  attention with three sub-stages so they don't navigate away while
 *  the substrate is still detecting duplicates:
 *
 *    1. `syncing-contacts`      — live `Syncing contacts X/Y` counter
 *                                 driven by reconciler progress events
 *                                 the host streams in.
 *    2. `resolving-duplicates`  — predicate-evaluation pass; counter
 *                                 `Comparing X/N` + ETA renders only
 *                                 after the first ~5% of iterations
 *                                 produce timing samples (so we don't
 *                                 flash a flaky early estimate).
 *    3. `review`                — `<MergeReviewDialog>` opens with the
 *                                 batch of new candidates from this
 *                                 connection's resolving-duplicates
 *                                 pass.
 *
 *  Pure render module — the host:
 *    - Streams reconciler `synced/total` counts into `sync_progress`
 *    - Streams predicate-scan `compared/total` + sampled-time counts
 *      into `scan_progress` and flips stages
 *    - Hands `dialog` to `<MergeReviewDialog>` once stage = `'review'`
 *    - Wires `data-action`s `enrollment-focus-defer` / `-cancel` /
 *      `-complete` for the three exit paths.
 *
 *  Same component used at all three client surfaces (extension /
 *  webapp / options page) — every surface that drives a connection
 *  enrollment also drives this. */

import { e } from '../template.js';
import { button } from '../primitives/button.js';
import { panel } from '../primitives/panel.js';
import { inlineError, inlineHint } from '../primitives/message.js';
import {
  renderMergeReviewDialog,
  type MergeReviewDialogState,
  type MergeReviewItem,
} from './merge-review-dialog.js';

/** Three discrete sub-stages of the focus page. The host advances
 *  through the sequence as the reconciler progresses; the user can
 *  exit early via "Cancel" (which leaves the candidates `pending` —
 *  they surface in the post-enrollment notification queue per spec). */
export type EnrollmentFocusStage =
  | 'syncing-contacts'
  | 'resolving-duplicates'
  | 'review'
  | 'complete';

/** Counter pair for the syncing-contacts stage. Both fields are
 *  unknown until the reconciler reports its first page; the renderer
 *  surfaces an indeterminate spinner until `total` lands. */
export interface SyncProgress {
  /** Contacts ingested so far in this enrollment cycle. */
  synced: number;
  /** Total contacts the reconciler estimates exist on the vendor.
   *  Null while still discovering the vendor's pagination size. */
  total: number | null;
}

/** Counter pair + sampled timing for resolving-duplicates stage. ETA
 *  only renders once the host has accumulated enough timing samples
 *  to render a stable estimate (sample threshold: first ~5% of
 *  `total_iterations`, minimum 5 samples, whichever is larger). */
export interface ScanProgress {
  /** Predicate evaluations completed in this cycle. */
  compared: number;
  /** Total predicate evaluations expected this cycle (equal to the
   *  number of blocking-key-bucketed contact pairs). */
  total_iterations: number;
  /** Number of timing samples the host has collected so far. The ETA
   *  is suppressed while this is below `eta_min_samples`. */
  samples: number;
  /** Average milliseconds per iteration across the samples; null
   *  before the first sample lands. */
  ms_per_iteration: number | null;
}

/** Configuration knobs for the ETA gate. Defaults match spec § P2
 *  acceptance ("first ~5% of iterations produce timing samples; ETA
 *  renders only after the sample is large enough to be meaningful").
 *  Overridable so housekeeping's "Scan now" full-scan path (which
 *  may have very different iteration counts) can dial the threshold. */
export interface EtaConfig {
  /** Lower bound on absolute samples — protects very small batches
   *  where 5% wouldn't be enough. Default: 5. */
  eta_min_samples: number;
  /** Fraction of `total_iterations` to wait for before showing ETA.
   *  Default: 0.05 (5%). */
  eta_min_fraction: number;
}

export const DEFAULT_ETA_CONFIG: EtaConfig = {
  eta_min_samples: 5,
  eta_min_fraction: 0.05,
};

/** True when the host has accumulated enough timing samples to
 *  publish a stable ETA. Pure helper so the test suite can pin the
 *  acceptance check without re-implementing the threshold. */
export const isEtaEligible = (
  scan: ScanProgress,
  config: EtaConfig = DEFAULT_ETA_CONFIG,
): boolean => {
  if (scan.ms_per_iteration == null) return false;
  if (scan.samples < config.eta_min_samples) return false;
  const fractionThreshold = Math.ceil(
    scan.total_iterations * config.eta_min_fraction,
  );
  return scan.samples >= Math.max(config.eta_min_samples, fractionThreshold);
};

/** Estimated milliseconds remaining; returns null when ETA isn't
 *  yet eligible. Linear extrapolation across remaining iterations. */
export const remainingMillis = (
  scan: ScanProgress,
  config: EtaConfig = DEFAULT_ETA_CONFIG,
): number | null => {
  if (!isEtaEligible(scan, config)) return null;
  if (scan.ms_per_iteration == null) return null;
  const remaining = Math.max(0, scan.total_iterations - scan.compared);
  return Math.round(remaining * scan.ms_per_iteration);
};

/** Render a millisecond duration as a coarse human label —
 *  `"<1s"` / `"~3s"` / `"~12s"` / `"~2m"` / `"~7m"`. Stays coarse
 *  on purpose: ETA is approximate by construction. */
export const formatRemaining = (ms: number): string => {
  if (ms < 1_000) return '<1s';
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `~${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `~${minutes}m`;
};

export interface EnrollmentFocusPageState {
  /** Vendor / connection name for the page title (e.g. `"HubSpot"`). */
  connection_label: string;
  /** Active sub-stage. */
  stage: EnrollmentFocusStage;
  /** Sync counter — populated during `'syncing-contacts'`. */
  sync_progress: SyncProgress;
  /** Scan counter + timing — populated during `'resolving-duplicates'`. */
  scan_progress: ScanProgress;
  /** Review-dialog state — relevant during `'review'`. The host
   *  builds this from `contact.merge.list` filtered to the candidates
   *  detected during this enrollment cycle. */
  dialog: MergeReviewDialogState;
  /** Inline error if the reconciler / scan failed. The user can
   *  still exit via the "Cancel" or "Continue without merge review"
   *  affordances. */
  error: string | null;
  /** Optional ETA-config override (test surfaces / housekeeping
   *  scans). Defaults to `DEFAULT_ETA_CONFIG`. */
  eta_config?: EtaConfig;
}

export interface EnrollmentFocusPageProps extends EnrollmentFocusPageState {
  /** Surface label propagated to the dialog body. Defaults to
   *  `'enrollment'` — set to `'notification'` when reusing this page
   *  shell for the housekeeping "Scan now" full-scan UX (P3). */
  surface?: 'enrollment' | 'notification';
}

export const initialEnrollmentFocusPageState = (
  connection_label: string,
): EnrollmentFocusPageState => ({
  connection_label,
  stage: 'syncing-contacts',
  sync_progress: { synced: 0, total: null },
  scan_progress: {
    compared: 0,
    total_iterations: 0,
    samples: 0,
    ms_per_iteration: null,
  },
  dialog: {
    items: [],
    cursor: 0,
    survivor_overrides: {},
    saving: false,
    error: null,
    surface: 'enrollment',
  },
  error: null,
});

/** Bar fill percentage for the indeterminate stages — capped to
 *  `[0, 100]`. Returns null when total is unknown (renderer falls
 *  through to indeterminate spinner). */
const percentOrNull = (current: number, total: number | null): number | null => {
  if (total == null || total <= 0) return null;
  return Math.min(100, Math.round((current / total) * 100));
};

const renderProgressBar = (percent: number | null): string => {
  if (percent == null) {
    return `
      <div class="focus-page-progress-bar focus-page-progress-bar--indeterminate"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100">
        <div class="focus-page-progress-bar-inner"></div>
      </div>
    `;
  }
  return `
    <div class="focus-page-progress-bar"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow="${percent}">
      <div class="focus-page-progress-bar-inner"
        style="width: ${percent}%"></div>
    </div>
  `;
};

const renderStageRow = (
  stage: EnrollmentFocusStage,
  active: EnrollmentFocusStage,
  label: string,
): string => {
  const stageClass = stage === active
    ? 'focus-page-stage-row--active'
    : isStageBefore(stage, active)
      ? 'focus-page-stage-row--done'
      : 'focus-page-stage-row--pending';
  const marker = stage === active
    ? '●'
    : isStageBefore(stage, active)
      ? '✓'
      : '○';
  return `
    <li class="focus-page-stage-row ${stageClass}">
      <span class="focus-page-stage-marker" aria-hidden="true">${e(marker)}</span>
      <span class="focus-page-stage-label">${e(label)}</span>
    </li>
  `;
};

const STAGE_ORDER: readonly EnrollmentFocusStage[] = [
  'syncing-contacts',
  'resolving-duplicates',
  'review',
  'complete',
];

const isStageBefore = (
  a: EnrollmentFocusStage,
  b: EnrollmentFocusStage,
): boolean => {
  return STAGE_ORDER.indexOf(a) < STAGE_ORDER.indexOf(b);
};

const renderStageTracker = (active: EnrollmentFocusStage): string => `
  <ol class="focus-page-stages" aria-label="Enrollment progress">
    ${renderStageRow('syncing-contacts', active, 'Syncing contacts')}
    ${renderStageRow('resolving-duplicates', active, 'Resolving duplicates')}
    ${renderStageRow('review', active, 'Review')}
  </ol>
`;

const renderSyncingStage = (props: EnrollmentFocusPageProps): string => {
  const { synced, total } = props.sync_progress;
  const percent = percentOrNull(synced, total);
  const counter = total == null
    ? `Syncing contacts ${synced}…`
    : `Syncing contacts ${synced}/${total}`;
  return `
    <div class="focus-page-stage-body" data-stage="syncing-contacts">
      <p class="focus-page-stage-counter">${e(counter)}</p>
      ${renderProgressBar(percent)}
      <p class="focus-page-stage-hint">
        ${e('We pull every contact this connection holds before scanning for duplicates. Pages stream in as the vendor yields them.')}
      </p>
    </div>
  `;
};

const renderResolvingStage = (props: EnrollmentFocusPageProps): string => {
  const scan = props.scan_progress;
  const percent = percentOrNull(scan.compared, scan.total_iterations);
  const counter = scan.total_iterations === 0
    ? 'Comparing contacts…'
    : `Comparing ${scan.compared}/${scan.total_iterations}`;
  const cfg = props.eta_config ?? DEFAULT_ETA_CONFIG;
  const remaining = remainingMillis(scan, cfg);
  const etaLine = remaining == null
    ? '<span class="focus-page-eta focus-page-eta--pending">ETA arriving once we have enough samples…</span>'
    : `<span class="focus-page-eta">ETA: ${e(formatRemaining(remaining))}</span>`;
  return `
    <div class="focus-page-stage-body" data-stage="resolving-duplicates">
      <p class="focus-page-stage-counter">${e(counter)}</p>
      ${renderProgressBar(percent)}
      <p class="focus-page-stage-eta-row">${etaLine}</p>
      <p class="focus-page-stage-hint">
        ${e('No vendor calls — predicate match runs locally over the contact graph. Nickname-aware name compare; phone in E.164; address structured.')}
      </p>
    </div>
  `;
};

const renderReviewStage = (props: EnrollmentFocusPageProps): string => {
  return renderMergeReviewDialog({
    ...props.dialog,
    surface: props.surface ?? 'enrollment',
    allow_defer: true,
  });
};

const renderCompleteStage = (props: EnrollmentFocusPageProps): string => {
  const items = props.dialog.items.length;
  const body = items === 0
    ? 'No duplicates found. Connection is ready to use.'
    : 'All candidates resolved. Connection is ready to use.';
  return panel({
    tone: 'info',
    title: 'Enrollment complete',
    body: `<p>${e(body)}</p>${button({
      label: 'Done',
      variant: 'primary',
      size: 'sm',
      action: 'enrollment-focus-complete',
    })}`,
  });
};

const renderStageBody = (props: EnrollmentFocusPageProps): string => {
  switch (props.stage) {
    case 'syncing-contacts':     return renderSyncingStage(props);
    case 'resolving-duplicates': return renderResolvingStage(props);
    case 'review':               return renderReviewStage(props);
    case 'complete':             return renderCompleteStage(props);
  }
};

const renderControls = (props: EnrollmentFocusPageProps): string => {
  if (props.stage === 'complete') return '';
  const cancelLabel = props.stage === 'review'
    ? 'Review later'
    : 'Cancel — leave duplicates for later';
  return `
    <div class="focus-page-controls">
      ${button({
        label: cancelLabel,
        size: 'sm',
        action: 'enrollment-focus-defer',
      })}
    </div>
  `;
};

const renderHeader = (props: EnrollmentFocusPageProps): string => {
  return `
    <header class="focus-page-header">
      <h2 class="focus-page-title">${e(`Setting up ${props.connection_label}`)}</h2>
      <p class="focus-page-subtitle">
        ${e('We sync contacts, look for duplicates, then hand you a quick review. Stay here — exiting puts the duplicates in your notification queue for later.')}
      </p>
    </header>
  `;
};

const renderError = (props: EnrollmentFocusPageProps): string => {
  if (!props.error) return '';
  return inlineError(props.error);
};

const renderHintForStage = (props: EnrollmentFocusPageProps): string => {
  if (props.stage !== 'review') return '';
  return inlineHint(
    'Each item resolves on its own. Use "Skip →" to defer a single candidate, or "Review later" to finish enrollment now.',
  );
};

export const renderEnrollmentFocusPage = (
  props: EnrollmentFocusPageProps,
): string => {
  return `
    <section class="focus-page" role="dialog" aria-label="Connection enrollment"
      data-stage="${e(props.stage)}">
      ${renderHeader(props)}
      ${renderStageTracker(props.stage)}
      ${renderError(props)}
      ${renderHintForStage(props)}
      <div class="focus-page-body">
        ${renderStageBody(props)}
      </div>
      ${renderControls(props)}
    </section>
  `;
};

export const ENROLLMENT_FOCUS_PAGE_STYLES = `
.focus-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px;
  max-width: 720px;
  margin: 0 auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.focus-page-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.focus-page-title {
  font-size: 18px;
  font-weight: 600;
  margin: 0;
}
.focus-page-subtitle {
  font-size: 12px;
  color: var(--fg-muted);
  margin: 0;
}
.focus-page-stages {
  display: flex;
  list-style: none;
  margin: 0;
  padding: 0;
  gap: 12px;
}
.focus-page-stage-row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--fg-muted);
}
.focus-page-stage-row--done .focus-page-stage-marker {
  color: var(--fg);
}
.focus-page-stage-row--active {
  color: var(--fg);
  font-weight: 600;
}
.focus-page-stage-row--active .focus-page-stage-marker {
  color: var(--accent);
}
.focus-page-stage-marker {
  font-size: 14px;
  line-height: 1;
}
.focus-page-stage-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.focus-page-stage-counter {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
}
.focus-page-stage-hint {
  font-size: 12px;
  color: var(--fg-muted);
  margin: 0;
}
.focus-page-stage-eta-row {
  margin: 0;
}
.focus-page-eta {
  font-size: 12px;
  color: var(--fg-muted);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.focus-page-eta--pending {
  font-style: italic;
}
.focus-page-progress-bar {
  position: relative;
  height: 8px;
  border-radius: 999px;
  background: var(--surface-sunk);
  overflow: hidden;
}
.focus-page-progress-bar-inner {
  height: 100%;
  background: var(--accent);
  transition: width 0.2s ease-out;
}
.focus-page-progress-bar--indeterminate .focus-page-progress-bar-inner {
  width: 30%;
  animation: focus-page-progress-slide 1.6s ease-in-out infinite;
}
@keyframes focus-page-progress-slide {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(330%); }
}
.focus-page-controls {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}
`;
