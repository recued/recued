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

import type { MetricReadOutput, MetricSubmitSkipReason } from '@recued/contracts';

import {
  renderPublishDialog,
  renderPublishStart,
  renderStopPublishing,
  renderSubmitNow,
} from './publish-dialog.js';

import { e } from '../template.js';

export interface StatsPanelProps {
  readonly data: MetricReadOutput;
  /** § D7 — the metric whose publish preview is open, and the tag typed for it. Held by
   *  the caller so this render stays pure. */
  readonly pendingPublish?: { readonly metric_id: string; readonly tag: string; readonly season_id: string };
  /** § B3.3 — what the owner's last press of "send now" actually did. Held by the caller
   *  so this render stays pure; absent until they have pressed it. */
  readonly submitOutcome?:
    | {
        readonly sent: true;
        readonly ranked: number;
        readonly withdrawn: number;
        readonly rejected: number;
        readonly rejectedReasons: readonly string[];
      }
    | { readonly sent: false; readonly reason: MetricSubmitSkipReason };
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

/** ⛔⛔ AN ARTIFACT THIS DOES NOT NAME IS NOT RENDERED AT ALL.
 *
 *  The artifact store is also the producers' BOOKKEEPING: a fold cursor, a per-recipe
 *  run accumulator, an unattended-run counter. `?? a.key` published every one of them as
 *  an owner-facing "Record" under its internal key — a live server showed
 *  `20693 · hands_off.last_day · set just now`, which is an epoch DAY INDEX rendered as
 *  a score. There is no formatting fix for that row; it should not exist.
 *
 *  ⚠ SO THE FALLBACK IS SILENCE, and silence hides a genuinely new record just as
 *  quietly as it hides a cursor. That is why `d-250-artifact-keys.test.ts` in the SERVER
 *  suite — the only place that can see both the producers and this map — fails when a
 *  key is written that is neither named here nor declared internal there. Adding a
 *  producer key without deciding which it is turns red, not invisible. */
interface ArtifactCopy {
  readonly label: string;
  /** ⚠ PLURAL FORM. `2 days`, `1 day` — a bare number in a table of mixed quantities
   *  reads as whatever the row above it was. */
  readonly unit: string;
  readonly meaning: string;
}

const ARTIFACT_COPY: Readonly<Record<string, ArtifactCopy>> = {
  burst: {
    label: 'Best burst',
    unit: 'actions',
    meaning: 'The most actions Recued took in one unbroken stretch.',
  },
  'hands_off.longest': {
    label: 'Longest hands-off streak',
    unit: 'days',
    meaning: 'The longest run of working days that never needed a decision from you.',
  },
  'hands_off.current': {
    label: 'Hands-off streak',
    unit: 'days',
    meaning: 'Days in a row Recued ran and never needed a decision from you.',
  },
  'unattended_days.current': {
    label: 'Days fully on autopilot',
    unit: 'days',
    meaning: 'Days in a row where everything that ran, ran without you starting it.',
  },
};

export const artifactLabel = (key: string): string | undefined => ARTIFACT_COPY[key]?.label;

/** `2 days` / `1 day` — the unit is singular at exactly one. */
const withUnit = (value: number, unit: string): string =>
  `${value} ${value === 1 ? unit.replace(/s$/, '') : unit}`;

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

  // ⛔ NO VERSION ON THE ROW. `metric_version` stays on the wire and is still rendered
  // where it decides something — the publish dialog's payload preview — because § D3.1a
  // puts it on a BOARD row, whose audience is *"strangers reading a leaderboard"*
  // comparing servers that upgraded at different rates. Your own page has one server and
  // one answer to "which arithmetic am I reading", so here it was decoration.
  // ⛔ EVERY ROW SAYS WHAT IT MEANS, IN A SENTENCE. `62.5% · Autopilot · higher is
  // better · v1` is four fragments that assume the reader already knows the schema —
  // and on an absent reading it explained how to rank a number that was not there.
  // ⚠ The direction is appended to the MEANING rather than standing alone, and only
  // when there is a value to rank.
  const cards = data.snapshot.metrics
    .map((m) => {
      const ranked = m.reading.kind === 'absent'
        ? ''
        : ` ${m.direction === 'higher' ? 'Higher is better.' : 'Lower is better.'}`;
      return `
      <tr data-metric="${e(m.metric_id)}">
        <th scope="row" class="stats-table__name">${e(m.label)}</th>
        <td class="stats-table__value">${e(formatReading(m.reading, m.shape))}</td>
        <td class="stats-table__meaning">${e((m.description ?? '') + ranked).trim()}</td>
      </tr>`;
    })
    .join('');

  // ⛔ RECORDS AND STREAKS ARE NOT ONE LIST. "These only ever go up — a quiet day never
  // takes one away" is TRUE of a record and FALSE of `hands_off.current`, which resets
  // to zero the moment a decision is answered. One heading over both made the page
  // promise something about a number that does not keep it.
  const named = data.artifacts.filter((a) => a.kind !== 'once' && ARTIFACT_COPY[a.key] !== undefined);
  const artifactRow = (a: typeof named[number], trailer: string): string => {
    const copy = ARTIFACT_COPY[a.key]!;
    return `
      <tr data-artifact="${e(a.key)}">
        <th scope="row" class="stats-table__name">${e(copy.label)}</th>
        <td class="stats-table__value">${e(withUnit(Math.round(a.value), copy.unit))}</td>
        <td class="stats-table__meaning">${e(copy.meaning + trailer)}</td>
      </tr>`;
  };
  const records = named
    .filter((a) => a.kind === 'record')
    .map((a) => artifactRow(a, ` Set ${ago(a.updated_at, now)}.`))
    .join('');
  // ⚠ NO TIMESTAMP ON A STREAK. It is rewritten every cycle, so "set just now" says
  // only that the server is awake — which the reader already knows, and which read as
  // if the streak had just been achieved.
  const streaks = named
    .filter((a) => a.kind === 'counter')
    .map((a) => artifactRow(a, ''))
    .join('');

  /** One table shape for every section, so a row reads the same way wherever it is. */
  const table = (nowHeading: string, rows: string): string => `
      <div class="stats-table-wrap">
        <table class="stats-table">
          <thead><tr>
            <th scope="col">Measure</th>
            <th scope="col">${e(nowHeading)}</th>
            <th scope="col">What it means</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

  const milestones = data.milestones
    .map((m) => {
      // ⛔⛔ THREE STATES, NOT TWO. An undetectable milestone rendered like an unearned
      // one tells the owner "you have not done this" when the truth is "we are not
      // looking" — which is why `detectable` is on the wire at all.
      const state = m.earned_at !== null ? 'earned' : m.detectable ? 'pending' : 'untracked';
      const status =
        state === 'earned' ? `Earned ${ago(m.earned_at!, now)}`
          : state === 'pending' ? 'Not yet'
          : 'Not tracked yet';
      // ⚠ THE DESCRIPTION SHOWS IN ALL THREE STATES. v1 replaced it with the status for
      // an earned one, so the page could tell you that you had done something without
      // ever saying what it was.
      const meaning = state === 'untracked'
        ? `${m.description} This build cannot detect it yet.`
        : m.description;
      return `
        <tr class="stats-milestone stats-milestone--${state}" data-milestone="${e(m.milestone_id)}">
          <th scope="row" class="stats-table__name">${e(m.label)}</th>
          <td class="stats-table__value stats-milestone__status">${e(status)}</td>
          <td class="stats-table__meaning">${e(meaning)}</td>
        </tr>`;
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

      ${cards === '' ? `
      <p class="stats-note">No metric in this snapshot is one this build still knows how
      to display.</p>` : table('Today', cards)}

      ${streaks === '' ? '' : `
      <h3>Streaks</h3>
      <p class="stats-note">Counted in whole days, and only days Recued actually ran —
      a day off ends the run.</p>
      ${table('Now', streaks)}`}

      ${records === '' ? '' : `
      <h3>Records</h3>
      <p class="stats-note">These only ever go up — a quiet day never takes one away.</p>
      ${table('Best', records)}`}

      ${renderPublications(data)}

      <h3>Publish a score</h3>
      <p class="stats-note">Nothing leaves this server until you publish it, and only the
      ratio leaves — never the figures it came from.</p>
      ${data.snapshot.metrics
        .filter((m) => m.publishable)
        .map((m) => renderPublishStart({
          metric: m,
          ...(props.pendingPublish?.metric_id === m.metric_id
            ? { pending: { tag: props.pendingPublish.tag, season_id: props.pendingPublish.season_id } }
            : {}),
        }))
        .join('')}
      ${renderSubmitNow({
        publications: data.publications.length,
        ...(props.submitOutcome !== undefined ? { outcome: props.submitOutcome } : {}),
      })}

      <h3>Milestones</h3>
      <div class="stats-table-wrap">
        <table class="stats-table stats-milestones">
          <thead><tr>
            <th scope="col">Milestone</th>
            <th scope="col">Status</th>
            <th scope="col">What it takes</th>
          </tr></thead>
          <tbody>${milestones}</tbody>
        </table>
      </div>

      <details class="stats-coverage">
        <summary>Coverage and diagnostics</summary>
        <p class="stats-note">A dash means nothing was measured in this window — not zero.</p>
        ${diagRows === '' ? '<p class="stats-note">No coverage gaps recorded.</p>'
          : `<table class="stats-diag"><tbody>${diagRows}</tbody></table>`}
      </details>
    </section>`;
};
