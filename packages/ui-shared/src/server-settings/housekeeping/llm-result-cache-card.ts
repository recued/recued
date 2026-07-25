/** D-145 PA11 — "LLM result cache" Settings card.
 *
 *  Surfaces the per-pair `llm_result_cache` substrate (D-145 § A.7.10)
 *  inside the Settings → Server → Housekeeping panel. Shows three
 *  things the user actually cares about: how much the cache is doing
 *  for them (total entries + per-topic hit-rate), when housekeeping
 *  last swept dangling refs, and a deliberate "Clear cache" escape
 *  hatch behind a two-stage inline confirm (mirrors devices DD#2 + SI
 *  Slice 1.5 + packs Slice B patterns).
 *
 *  Driving rpcs (wired by the host on mount + on action clicks):
 *
 *    housekeeping.cache.stats   — read; refreshed after every clear.
 *    housekeeping.cache.clear   — write; gated on paired-client (D-121).
 *
 *  ## Key decisions
 *
 *  DD#1 — Two-stage Clear confirm, not a modal. Modals would interrupt
 *  the user mid-scroll; the strip stays inline so the card collapses
 *  back to its read-only summary on Cancel without scroll-thrash.
 *  Mirrors the SI Slice 1.5 + packs Slice B + devices DD#2 patterns
 *  the user already knows.
 *
 *  DD#2 — Per-topic table renders `entry_count` + `hit_count` + a
 *  derived hit-rate percent (`hit_count / (hit_count + entry_count)`).
 *  Rationale: an entry's `entry_count` represents *one* unique input;
 *  every additional matching producer call bumps `hit_count` instead
 *  of `entry_count`. So `hit_count / (hit_count + entry_count)` is the
 *  share of requests served from cache vs forced through the LLM —
 *  the user-visible "what fraction of LLM calls did the cache save?"
 *  number. The first writer for a unique input is always a miss
 *  (denominator includes the misses); subsequent matching calls are
 *  hits. A 0/0 cache renders "—" (no requests yet); zero-hit topics
 *  render "0%" so the user can see the producer is cached but no
 *  duplicates have arrived.
 *
 *  DD#3 — Last-GC timestamp formatted relative to `now`. The card
 *  carries `last_gc_at: null` cleanly — the GC task may not have run
 *  yet on fresh boots; the renderer surfaces "—" then.
 *
 *  DD#4 — `_malformed` bucket surfaces residue. Rows whose
 *  `result_path` no longer parses (schema drift, registry retraction)
 *  bucket under `_malformed`; the card renders the bucket name as-is
 *  so the user can see why total_entries > sum(known topics).
 *
 *  DD#5 — Empty state. When `total_entries === 0`, the card renders
 *  a short "No cached results yet." note instead of the per-topic
 *  table + Clear button. The Clear button serves no purpose against
 *  an empty cache; surfacing it would render an enabled control whose
 *  rpc is a no-op + waste a click.
 *
 *  Spec: docs/d-145-spec.md § A.7.10 + PA11 widening note. */

import { e } from '../../template.js';
import { button } from '../../primitives/button.js';
import { inlineError } from '../../primitives/message.js';
import type { HousekeepingCacheCardState } from './state.js';

export interface HousekeepingLlmResultCacheCardProps {
  state: HousekeepingCacheCardState;
  /** "now" for relative-time formatting on `last_gc_at`. Tests pass a
   *  fixed epoch ms for deterministic output. */
  now: number;
}

/** Format a per-topic hit-rate as a `xx%` string. Returns `'—'` when
 *  the denominator is zero (cache entries exist but no reads yet).
 *  Sub-percent ratios round up to `1%` so a single hit against a large
 *  cache stays visible. */
export const formatCacheHitRate = (
  entry_count: number,
  hit_count: number,
): string => {
  const denominator = entry_count + hit_count;
  if (denominator <= 0) return '—';
  const ratio = hit_count / denominator;
  if (ratio <= 0) return '0%';
  const percent = Math.max(1, Math.round(ratio * 100));
  return `${percent}%`;
};

/** Format an epoch ms timestamp as a short relative-time string. Falls
 *  back to `'—'` when the timestamp is null (GC has never run). The
 *  format mirrors `task-status-table.ts`'s helper. */
export const formatCacheRelativeTime = (
  then: number | null,
  now: number,
): string => {
  if (then == null) return '—';
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

const renderPerTopicTable = (
  per_topic: ReadonlyArray<{ topic: string; entry_count: number; hit_count: number }>,
): string => {
  if (per_topic.length === 0) return '';
  return `
    <table class="housekeeping-cache-card-topics">
      <thead>
        <tr>
          <th scope="col">Topic</th>
          <th scope="col">Entries</th>
          <th scope="col">Hits</th>
          <th scope="col">Hit rate</th>
        </tr>
      </thead>
      <tbody>
        ${per_topic
          .map(
            (row) => `
          <tr data-topic="${e(row.topic)}">
            <td><code>${e(row.topic)}</code></td>
            <td>${row.entry_count.toLocaleString()}</td>
            <td>${row.hit_count.toLocaleString()}</td>
            <td>${e(formatCacheHitRate(row.entry_count, row.hit_count))}</td>
          </tr>
        `,
          )
          .join('')}
      </tbody>
    </table>
  `;
};

const renderClearControls = (state: HousekeepingCacheCardState): string => {
  if (state.confirmingClear) {
    const confirmLabel = state.clearing ? 'Clearing…' : 'Confirm clear';
    return `
      <div class="housekeeping-cache-card-clear-confirm" role="group"
           aria-label="Confirm clear cache">
        ${button({
          label: confirmLabel,
          variant: 'danger',
          size: 'sm',
          action: 'housekeeping-cache-clear-confirm',
          disabled: state.clearing,
        })}
        ${button({
          label: 'Cancel',
          variant: 'secondary',
          size: 'sm',
          action: 'housekeeping-cache-clear-cancel',
          disabled: state.clearing,
        })}
      </div>
    `;
  }
  return button({
    label: 'Clear cache',
    variant: 'secondary',
    size: 'sm',
    action: 'housekeeping-cache-clear',
  });
};

export const renderHousekeepingLlmResultCacheCard = (
  props: HousekeepingLlmResultCacheCardProps,
): string => {
  const { state, now } = props;

  // Loading state on first read — same shape the rest of the panel
  // uses ("Loading X…" then swap in the real card on first response).
  if (state.loading && state.stats === null) {
    return `
      <section class="housekeeping-cache-card"
               aria-label="LLM result cache">
        <h3>LLM result cache</h3>
        <p class="housekeeping-cache-card-loading">Loading cache stats…</p>
      </section>
    `;
  }

  // Persistent load error before first successful snapshot. After the
  // first successful read the prior snapshot stays visible + the error
  // chip surfaces inline so the user keeps context.
  if (state.loadError !== null && state.stats === null) {
    return `
      <section class="housekeeping-cache-card"
               aria-label="LLM result cache">
        <h3>LLM result cache</h3>
        ${inlineError(state.loadError)}
      </section>
    `;
  }

  const stats = state.stats;
  if (stats === null) {
    // Pre-mount placeholder — the host hasn't fired the first read yet
    // (component reachable in a story / fixture). Render a quiet
    // placeholder so the panel layout reserves the space.
    return `
      <section class="housekeeping-cache-card"
               aria-label="LLM result cache">
        <h3>LLM result cache</h3>
        <p class="housekeeping-cache-card-loading">Loading cache stats…</p>
      </section>
    `;
  }

  const refreshError = state.loadError !== null ? inlineError(state.loadError) : '';
  const clearError = state.clearError !== null ? inlineError(state.clearError) : '';
  const lastGc = formatCacheRelativeTime(stats.last_gc_at, now);

  // Empty cache — surface the rollup line + skip the table + Clear
  // button (DD#5). Last-GC stays visible so the user can confirm the
  // task is running even before the first hit lands.
  if (stats.total_entries === 0) {
    return `
      <section class="housekeeping-cache-card"
               aria-label="LLM result cache">
        <h3>LLM result cache</h3>
        <p class="housekeeping-cache-card-summary">
          Identical AI inputs across records skip the model call and reuse
          a prior enrichment row. Currently empty — the next AI producer
          run will start populating it.
        </p>
        <p class="housekeeping-cache-card-meta">
          Last GC sweep: ${e(lastGc)}.
        </p>
        ${refreshError}
      </section>
    `;
  }

  const overallHitRate = formatCacheHitRate(stats.total_entries, stats.total_hits);

  return `
    <section class="housekeeping-cache-card"
             aria-label="LLM result cache">
      <h3>LLM result cache</h3>
      <p class="housekeeping-cache-card-summary">
        Identical AI inputs across records skip the model call and reuse
        a prior enrichment row.
      </p>
      <dl class="housekeeping-cache-card-rollup">
        <div>
          <dt>Entries</dt>
          <dd>${stats.total_entries.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Total hits</dt>
          <dd>${stats.total_hits.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Hit rate</dt>
          <dd>${e(overallHitRate)}</dd>
        </div>
        <div>
          <dt>Last GC</dt>
          <dd>${e(lastGc)}</dd>
        </div>
      </dl>
      ${renderPerTopicTable(stats.per_topic)}
      ${refreshError}
      ${clearError}
      <div class="housekeeping-cache-card-actions">
        ${renderClearControls(state)}
      </div>
    </section>
  `;
};
