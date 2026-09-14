/** D-266 — the one-per-wake missed-run card.
 *
 *  ⛔ ONE CARD, NOT ONE PROMPT PER MISS. Per-miss asks are what make
 *  the strongest policy the first one an owner switches off: a laptop
 *  sleeping nightly with six schedules would produce six prompts every
 *  morning, and a weekend outage dozens. So everything waiting is one
 *  card, one line per recipe, three buttons.
 *
 *  🔑 AND THE COUNT IS NOT AN OFFER. "missed 3" does not mean three
 *  runs are on the table — only the most recent cycle runs, because a
 *  brief supersedes a brief. The count is the RECORD OF THE OUTAGE,
 *  and it is the only place the owner learns the machine was off for
 *  three days.
 *
 *  Pure string renderer, like every other shared surface here: the
 *  hosting route owns the DOM, the fetch and the repaint. The report
 *  it renders is recomputed server-side on every read — there is no
 *  stored ask behind this card, so it cannot outlive what it describes.
 */

import { e } from './template.js';

/** Marks the card's action buttons. The value is the answer, optionally
 *  scoped to one recipe: `run` / `skip` answer everything waiting,
 *  `run:<recipe_id>` / `skip:<recipe_id>` answer one line. */
export const MISSED_RUNS_ACTION_ATTR = 'data-recued-missed-runs-action';
/** Marks the card root, for hosts that need to find or replace it. */
export const MISSED_RUNS_CARD_ATTR = 'data-recued-missed-runs-card';

export interface MissedRunsCardEntry {
  recipe_id: string;
  recipe_name?: string;
  missed_cycles: number | 'unknown';
  /** The server's count stopped at its scan limit. Render "N+". */
  missed_cycles_capped?: boolean;
  last_run_at: number;
}

export interface MissedRunsCardReport {
  outage_from: number | null;
  outage_to: number;
  entries: readonly MissedRunsCardEntry[];
}

export type MissedRunsAnswer = 'run' | 'skip';

export const isMissedRunsAnswer = (value: unknown): value is MissedRunsAnswer =>
  value === 'run' || value === 'skip';

/** Split an action-attribute value into its answer and optional recipe
 *  scope. Returns null for anything that is not one of the four shapes,
 *  so a host can probe without trusting the attribute.
 *
 *  ⚠ Splits on the FIRST colon only — a recipe id may contain one, and
 *  `split(':')[1]` would silently truncate it. */
export const parseMissedRunsAction = (
  value: string | null | undefined,
): { answer: MissedRunsAnswer; recipe_id?: string } | null => {
  if (typeof value !== 'string' || value.length === 0) return null;
  const colon = value.indexOf(':');
  if (colon < 0) return isMissedRunsAnswer(value) ? { answer: value } : null;
  const answer = value.slice(0, colon);
  const recipe_id = value.slice(colon + 1);
  if (!isMissedRunsAnswer(answer) || recipe_id.length === 0) return null;
  return { answer, recipe_id };
};

/** "2d 14h" / "3h" / "25m" — coarse on purpose. The owner is deciding
 *  whether a backlog is still worth running, and minutes past the first
 *  hour never change that answer. */
export const formatOutage = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
};

const entryLine = (entry: MissedRunsCardEntry, busyAttrs: string): string => {
  const name = entry.recipe_name ?? entry.recipe_id;
  // 'unknown' means no cadence could be sampled — say so rather than
  // printing a number we did not measure.
  // ⛔ "N+" WHEN THE COUNT WAS CAPPED, NEVER A BARE N. The server stops
  // scanning at a bound, so an hourly schedule down a week reports the
  // bound — printing it plain would state a precise figure for an outage
  // of any length above it.
  const missed = entry.missed_cycles === 'unknown'
    ? 'missed at least one'
    : `missed ${entry.missed_cycles + 1}${entry.missed_cycles_capped ? '+' : ''}`;
  // "Decide each" without a mode: the per-line buttons are simply always
  // there. A disclosure would add a state the card has no other use for,
  // and hide the choice behind a click for the case — a handful of
  // recipes answered differently — that it exists to serve.
  const scoped = (answer: MissedRunsAnswer, label: string): string =>
    `<button type="button" class="automation-button missed-runs-entry-action"
      ${MISSED_RUNS_ACTION_ATTR}="${answer}:${e(entry.recipe_id)}"
      aria-label="${e(`${label} ${name}`)}"${busyAttrs}>${e(label)}</button>`;
  return `<li class="missed-runs-entry">
      <span><strong>${e(name)}</strong> — ${e(missed)} · last ran ${
        e(new Date(entry.last_run_at).toLocaleString())
      }</span>
      <span class="missed-runs-entry-actions">${scoped('run', 'Run')}${scoped('skip', 'Skip')}</span>
    </li>`;
};

export interface RenderMissedRunsCardOptions {
  /** Disables the buttons while an answer is in flight. */
  busy?: boolean;
  /** Shown in place of the buttons' normal state after a failure. */
  error?: string | null;
}

/** Render the card, or the empty string when nothing is waiting — the
 *  host can splice the result in unconditionally. */
export const renderMissedRunsCard = (
  report: MissedRunsCardReport | null,
  options: RenderMissedRunsCardOptions = {},
): string => {
  if (report === null || report.entries.length === 0) return '';
  const busy = options.busy === true;
  const busyAttrs = busy ? ' aria-disabled="true" aria-busy="true"' : '';
  const window = report.outage_from === null
    ? ''
    : `<p class="missed-runs-window">I was off ${
      e(new Date(report.outage_from).toLocaleString())
    } → ${e(new Date(report.outage_to).toLocaleString())} (${
      e(formatOutage(report.outage_to - report.outage_from))
    })</p>`;
  const error = options.error
    ? `<p class="missed-runs-error" role="alert">${e(options.error)}</p>`
    : '';
  const button = (answer: MissedRunsAnswer, label: string): string =>
    `<button type="button" class="automation-button"
      ${MISSED_RUNS_ACTION_ATTR}="${answer}"${busyAttrs}>${e(label)}</button>`;
  return `
    <section class="missed-runs-card" ${MISSED_RUNS_CARD_ATTR} role="group"
      aria-label="Schedules that did not run">
      <h3 class="missed-runs-title">While I was off</h3>
      ${window}
      <ul class="missed-runs-entries" role="list">${
        report.entries.map((entry) => entryLine(entry, busyAttrs)).join('')
      }</ul>
      <p class="missed-runs-note">Only the most recent run of each is offered —
        a later run supersedes an earlier one.</p>
      ${error}
      <div class="missed-runs-actions">
        ${button('run', busy ? 'Working…' : 'Run them')}
        ${button('skip', 'Skip them')}
      </div>
    </section>`;
};
