/** D-250 § D7 — the `#stats` surface: the owner's OWN numbers.
 *
 *  🔑 ACHIEVEMENTS ARE THE HEADLINE; RAW COUNTS ARE EXPANDABLE UNDERNEATH. § D5.1 ruled
 *  this an achievements surface rather than a report card, and the owner's own words set
 *  it: *"the metrics should make people feel useful rather than tracking failure."* A
 *  page that led with diagnostics would quietly become the thing that was rejected.
 *
 *  ⛔⛔ ABSENT IS RENDERED AS ABSENT, NEVER AS ZERO. `MetricReading` has three states for
 *  this reason: on a share, 0 is a real and bad number ("nothing ran unattended"), so
 *  showing it for a window that simply held no data would report a healthy server as
 *  idle. And `unbounded` is the BEST case (§ D5.3 — askable work with zero decisions
 *  answered), so it must read as better than any figure, not as an error.
 *
 *  ⛔ THE TWO STORES STAY VISIBLY DIFFERENT. Snapshot metrics are recomputed each cycle
 *  and CAN GO DOWN; records and streaks ADVANCE and survive a quiet week (amendment 17).
 *  Rendering them in one list would make a surviving record look like a stuck number.
 *
 *  ⚠ WHAT § D7 DESCRIBES AND THIS DOES NOT BUILD, stated so it is not read as an
 *  oversight: *"pick a day"* and own-history percentile both need retained daily history,
 *  which amendment 16 ruled OUT (one snapshot, replaced).
 *
 *  ✅ THE PUBLISH SECTION LANDED once § D4's grant existed. ⛔ It renders ONLY for tags
 *  the owner has already opted into — there is no "publish this" affordance here, because
 *  choosing a tag is a distinct act and § D4's whole point is that publishing starts from
 *  an owner gesture, not from a button sitting next to a number.
 */

import type { MetricReadOutput } from '@recued/contracts';

import { renderPublishDialog, renderStopPublishing } from './publish-dialog.js';

import { e } from '../template.js';

export interface StatsPanelProps {
  readonly data: MetricReadOutput;
  /** For the "as of" phrasing. Injected so the render stays pure. */
  readonly now: number;
}

const ago = (then: number, now: number): string => {
  const mins = Math.max(0, Math.round((now - then) / 60_000));
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} minutes ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

/** ⛔ SHAPE DECIDES THE UNIT, and getting it wrong misreports by 100x. A `share` is a
 *  0..1 fraction and reads as a percentage; a `ratio` is an unbounded rate and must not
 *  be multiplied. § D5.4's Economy band (~0.5 to ~5 items per 1k tokens) becomes
 *  nonsense rendered as "50%". */
const formatReading = (
  reading: MetricReadOutput['snapshot'] extends null ? never
    : NonNullable<MetricReadOutput['snapshot']>['metrics'][number]['reading'],
  shape: string,
): string => {
  if (reading.kind === 'absent') return '—';
  // § D5.3 — "zero decisions is the BEST case, not an error": it ranks above every
  // finite value, so it must not render as a dash beside them.
  if (reading.kind === 'unbounded') return 'all clear';
  if (shape === 'share') return `${Math.round(reading.value * 1000) / 10}%`;
  if (shape === 'count' || shape === 'record') return `${Math.round(reading.value)}`;
  return `${Math.round(reading.value * 100) / 100}`;
};

const ARTIFACT_LABELS: Readonly<Record<string, string>> = {
  burst: 'Best burst',
  'hands_off.current': 'Hands-off streak',
  'hands_off.longest': 'Longest hands-off streak',
};

/** § D4 / § D7 — what this server publishes, and how to stop.
 *
 *  ⛔ THE ERASE IS RENDERED FOR EVERY PUBLICATION, not tucked behind a settings page —
 *  § D7: *"'Stop publishing and erase my entry' is a PROMINENT action"*, and § C4 ruled
 *  the erase, so burying it makes the ruling decorative. */
const renderPublications = (data: MetricReadOutput): string => {
  if (data.publications.length === 0) return '';
  const byId = new Map((data.snapshot?.metrics ?? []).map((m) => [m.metric_id, m]));
  const blocks = data.publications
    .map((p) => {
      const metric = byId.get(p.metric_id);
      // ⚠ A publication whose metric has no CURRENT reading still shows its stop action.
      // The owner is on that board either way, and the one thing they must always be able
      // to do is leave.
      const dialog = metric === undefined ? '' : renderPublishDialog({
        metric,
        tag: p.tag,
        season_id: p.season_id,
        destination: `https://recued.com/explore/${p.tag}`,
      });
      return dialog + renderStopPublishing({ tag: p.tag, withdrawing: p.state === 'withdrawing' });
    })
    .join('');
  return `<h3>Published</h3>${blocks}`;
};

export const renderStatsPanel = (props: StatsPanelProps): string => {
  const { data, now } = props;

  if (data.snapshot === null) {
    // ⛔ NOT AN EMPTY GRID OF ZEROS. "Nothing has computed yet" is a different fact from
    // "everything measured zero", and a new server would otherwise read as a failing one.
    return `
      <section class="stats-panel stats-panel--empty">
        <h2>Your stats</h2>
        <p class="stats-empty">Nothing measured yet. These fill in after the next
        housekeeping cycle — no setup needed.</p>
      </section>`;
  }

  const cards = data.snapshot.metrics
    .map((m) => `
      <li class="stats-card" data-metric="${e(m.metric_id)}">
        <span class="stats-card__value">${e(formatReading(m.reading, m.shape))}</span>
        <span class="stats-card__label">${e(m.label)}</span>
        <span class="stats-card__meta">${m.direction === 'higher' ? 'higher is better' : 'lower is better'} · v${m.metric_version}</span>
      </li>`)
    .join('');

  const records = data.artifacts
    .filter((a) => a.kind !== 'once')
    .map((a) => `
      <li class="stats-record" data-artifact="${e(a.key)}">
        <span class="stats-record__value">${e(String(Math.round(a.value)))}</span>
        <span class="stats-record__label">${e(ARTIFACT_LABELS[a.key] ?? a.key)}</span>
        <span class="stats-record__meta">set ${e(ago(a.updated_at, now))}</span>
      </li>`)
    .join('');

  const milestones = data.milestones
    .map((m) => {
      // ⛔⛔ THREE STATES, NOT TWO. An undetectable milestone rendered like an unearned
      // one tells the owner "you have not done this" when the truth is "we are not
      // looking" — which is why `detectable` is on the wire at all.
      const state = m.earned_at !== null ? 'earned' : m.detectable ? 'pending' : 'untracked';
      const note =
        state === 'earned' ? `earned ${e(ago(m.earned_at!, now))}`
          : state === 'pending' ? e(m.description)
          : 'not tracked yet';
      return `
        <li class="stats-milestone stats-milestone--${state}" data-milestone="${e(m.milestone_id)}">
          <span class="stats-milestone__label">${e(m.label)}</span>
          <span class="stats-milestone__note">${note}</span>
        </li>`;
    })
    .join('');

  // ⛔ COVERAGE IS SHOWN, NOT ASSUMED (§ D7). An absent reading is ambiguous — no AI ran,
  // or the rows predate instrumentation — so a page that hides its window silently
  // averages over rows that could not have carried a value.
  const diag = data.snapshot.diagnostics ?? {};
  const diagRows = Object.entries(diag)
    .filter(([, v]) => typeof v === 'number' || typeof v === 'boolean')
    .map(([k, v]) => `<tr><th>${e(k.replace(/_/g, ' '))}</th><td>${e(String(v))}</td></tr>`)
    .join('');

  return `
    <section class="stats-panel">
      <h2>Your stats</h2>
      <p class="stats-asof">Measured over the current UTC day · computed ${e(ago(data.snapshot.computed_at, now))}</p>

      <ul class="stats-cards">${cards}</ul>

      ${records === '' ? '' : `
      <h3>Records</h3>
      <p class="stats-note">These only ever go up — a quiet day never takes one away.</p>
      <ul class="stats-records">${records}</ul>`}

      ${renderPublications(data)}

      <h3>Milestones</h3>
      <ul class="stats-milestones">${milestones}</ul>

      <details class="stats-coverage">
        <summary>Coverage and diagnostics</summary>
        <p class="stats-note">A dash means nothing was measured in this window — not zero.</p>
        ${diagRows === '' ? '<p class="stats-note">No coverage gaps recorded.</p>'
          : `<table class="stats-diag"><tbody>${diagRows}</tbody></table>`}
      </details>
    </section>`;
};
