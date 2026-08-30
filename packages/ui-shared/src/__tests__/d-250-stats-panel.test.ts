/** D-250 § D7 — the `#stats` panel.
 *
 *  🔑 EVERY CASE IS ABOUT A NUMBER MEANING SOMETHING OTHER THAN ITSELF: absent vs zero,
 *  unbounded vs error, a share vs a rate, a record vs a window value, and an undetectable
 *  milestone vs an unearned one. The layout is not what goes wrong here.
 */

import { describe, expect, it } from 'vitest';
import { METRIC_ABSENT, METRIC_UNBOUNDED, metricValue, type MetricReadOutput } from '@recued/contracts';

import { renderStatsPanel } from '../stats/stats-panel.js';

const NOW = 1_700_000_000_000;

const out = (over: Partial<MetricReadOutput> = {}): MetricReadOutput => ({
  snapshot: {
    computed_at: NOW - 600_000,
    window: { from: NOW - 86_400_000, to: NOW },
    metrics: [
      { metric_id: 'autopilot', metric_version: 1, reading: metricValue(0.625),
        label: 'Autopilot', shape: 'share', direction: 'higher', publishable: true },
    ],
  },
  artifacts: [],
  milestones: [],
  publications: [],
  ...over,
});

const render = (o: MetricReadOutput) => renderStatsPanel({ data: o, now: NOW });

describe('D-250 § D7 — nothing measured yet', () => {
  it('⛔⛔ AN EMPTY SNAPSHOT IS NOT A GRID OF ZEROS', () => {
    // A brand-new server would otherwise read as a failing one.
    const html = render(out({ snapshot: null }));
    expect(html).toContain('Nothing measured yet');
    expect(html).not.toContain('0%');
  });
});

describe('D-250 § D7 — a reading means what it says', () => {
  it('⛔⛔ ABSENT RENDERS AS A DASH, NEVER 0%', () => {
    // On a share, 0 is a real and bad number ("nothing ran unattended"). Showing it for
    // a window that held no data reports a healthy server as idle.
    const html = render(out({ snapshot: { ...out().snapshot!, metrics: [
      { metric_id: 'economy', metric_version: 1, reading: METRIC_ABSENT,
        label: 'Economy', shape: 'ratio', direction: 'higher', publishable: true },
    ] } }));
    expect(html).toContain('—');
    expect(html).not.toMatch(/>0(\.0)?%?</);
  });

  it('⛔⛔ UNBOUNDED READS AS THE BEST CASE, not an error or a dash', () => {
    // § D5.3: "zero decisions is the BEST case". It ranks above every finite value.
    const html = render(out({ snapshot: { ...out().snapshot!, metrics: [
      { metric_id: 'waved_through', metric_version: 1, reading: METRIC_UNBOUNDED,
        label: 'Waved through', shape: 'ratio', direction: 'higher', publishable: true },
    ] } }));
    expect(html).toContain('all clear');
    // ⚠ SCOPED TO THE CARD VALUE. A bare `not.toContain('—')` fails on the page's own
    // prose em-dashes — an over-broad negative that would have to be weakened later,
    // which is how a real assertion gets quietly deleted.
    expect(html).toMatch(/<td class="stats-table__value">all clear<\/td>/);
    expect(html).not.toMatch(/<td class="stats-table__value">—<\/td>/);
  });

  it('⛔ A SHARE IS A PERCENTAGE AND A RATIO IS NOT — 100x apart', () => {
    // § D5.4's Economy band is ~0.5 to ~5 items per 1k tokens. Rendered as a share that
    // becomes "50%", which is not merely ugly — it is a different claim.
    expect(render(out())).toContain('62.5%');
    const ratio = render(out({ snapshot: { ...out().snapshot!, metrics: [
      { metric_id: 'economy', metric_version: 1, reading: metricValue(4.75),
        label: 'Economy', shape: 'ratio', direction: 'higher', publishable: true },
    ] } }));
    expect(ratio).toContain('4.75');
    expect(ratio).not.toContain('475');
  });

  it('shows the direction, as a sentence rather than a fragment', () => {
    const html = render(out());
    // ⚠ `62.5% · Autopilot · higher is better · v1` was four pieces that assumed the
    // reader already knew the schema.
    expect(html).toContain('Higher is better.');
  });

  it('⛔ THE DEFINITION VERSION IS NOT ON THE DASHBOARD ROW', () => {
    // ⛔ AND `metric_version` STAYS ON THE WIRE — this is a display decision, not a
    // retirement. § D3.1a puts the version on a BOARD row, whose audience is *"strangers
    // reading a leaderboard"* comparing servers that upgraded at different rates; the
    // publish dialog still renders it in the payload preview, which is where a number
    // actually leaves this server. Your own page has one server and one answer to
    // "which arithmetic am I reading".
    expect(render(out())).not.toContain('stats-table__ver');
  });

  it('⛔ EVERY ROW CARRIES A PLAIN SENTENCE SAYING WHAT THE NUMBER MEANS', () => {
    // The description travels on the wire rather than being looked up client-side, for
    // the same reason `direction` does: a client and the server it is paired to version
    // independently, so a locally-held description would eventually describe a rule the
    // server no longer runs.
    const html = render(out({ snapshot: { ...out().snapshot!, metrics: [
      { metric_id: 'autopilot', metric_version: 1, reading: metricValue(0.625),
        label: 'Autopilot', description: 'Share of runs that started on their own.',
        shape: 'share', direction: 'higher', publishable: true },
    ] } }));
    expect(html).toContain('Share of runs that started on their own.');
  });

  it('⛔ A HEADERS-ONLY TABLE IS NOT RENDERED — a snapshot can hold no displayable row', () => {
    // The handler drops a metric the registry no longer knows, so a stored snapshot that
    // outlived a release can arrive with an empty list. A table of column headings over
    // nothing reads as a broken page rather than as an explained one.
    const html = render(out({ snapshot: { ...out().snapshot!, metrics: [] } }));
    expect(html).not.toContain('What it means');
    expect(html).toContain('still knows how');
  });

  it('⛔ A ROW FROM AN OLDER SERVER RENDERS WITHOUT ONE, rather than inventing it', () => {
    // `description` is optional on the wire precisely so this degrades instead of
    // breaking, and the client must not substitute its own registry's copy.
    const html = render(out());
    expect(html).toContain('Autopilot');
    expect(html).toContain('62.5%');
  });

  it('⛔ AN ABSENT CARD SAYS SO INSTEAD OF RANKING A NUMBER IT DOES NOT HAVE', () => {
    // "— Autopilot · higher is better · v1" tells the reader how to read a value that
    // is not there. The dash already means "not measured"; the meta should agree.
    const html = render(out({ snapshot: {
      computed_at: NOW - 600_000,
      window: { from: NOW - 86_400_000, to: NOW },
      metrics: [
        { metric_id: 'autopilot', metric_version: 1, reading: METRIC_ABSENT,
          label: 'Autopilot', shape: 'share', direction: 'higher', publishable: true },
      ],
    } }));
    expect(html).toMatch(/<td class="stats-table__value">—<\/td>/);
    // ⛔ NO RANKING ON A MISSING NUMBER. "Higher is better" tells the reader how to read
    // a value that is not there.
    expect(html).not.toContain('Higher is better.');
  });
});

describe('D-250 amendment 17 — records read differently from window values', () => {
  it('⛔⛔ RECORDS GET THEIR OWN SECTION AND SAY THEY ONLY GO UP', () => {
    // Mixed into the cards, a record that survives a quiet week looks like a stuck number.
    const html = render(out({ artifacts: [
      { key: 'burst', kind: 'record', value: 47, updated_at: NOW - 5 * 86_400_000 },
    ] }));
    expect(html).toContain('Best burst');
    expect(html).toContain('only ever go up');
    expect(html).toContain('5 days ago');
  });

  it('the records section is absent when there are none, not an empty heading', () => {
    expect(render(out())).not.toContain('Records');
  });

  it('a streak counter and its record both show', () => {
    const html = render(out({ artifacts: [
      { key: 'hands_off.current', kind: 'counter', value: 0, updated_at: NOW },
      { key: 'hands_off.longest', kind: 'record', value: 31, updated_at: NOW },
    ] }));
    expect(html).toContain('Hands-off streak');
    expect(html).toContain('Longest hands-off streak');
  });

  it('⛔ THE NUMBER CARRIES ITS UNIT, and the unit is singular at exactly one', () => {
    // A bare number in a table of mixed quantities reads as whatever the row above it
    // was — `12` next to `47` gives no hint that one is days and the other is actions.
    const html = render(out({ artifacts: [
      { key: 'hands_off.current', kind: 'counter', value: 1, updated_at: NOW },
      { key: 'hands_off.longest', kind: 'record', value: 12, updated_at: NOW },
      { key: 'burst', kind: 'record', value: 47, updated_at: NOW },
    ] }));
    expect(html).toContain('1 day<');
    expect(html).toContain('12 days<');
    expect(html).toContain('47 actions<');
  });

  it('⛔⛔ AN ARTIFACT THE PANEL DOES NOT NAME IS NOT RENDERED AT ALL', () => {
    // Reported from a live server: `20693 · hands_off.last_day · set just now`. That is
    // the producers' fold CURSOR — an epoch day index — rendered as a score, because the
    // label lookup fell back to the raw key. Per-recipe run accumulators leaked the same
    // way, one row each.
    const html = render(out({ artifacts: [
      { key: 'hands_off.last_day', kind: 'counter', value: 20_693, updated_at: NOW },
      { key: 'recipe_runs.recued-core/inbox-triage', kind: 'counter', value: 47, updated_at: NOW },
      { key: 'burst', kind: 'record', value: 9, updated_at: NOW },
    ] }));
    expect(html).not.toContain('20693');
    expect(html).not.toContain('hands_off.last_day');
    expect(html).not.toContain('recipe_runs');
    expect(html).toContain('Best burst'); // ...and the real record still shows
  });

  it('⛔⛔ THE ONLY-GO-UP PROMISE IS NOT MADE ABOUT A STREAK, WHICH RESETS', () => {
    const streakOnly = render(out({ artifacts: [
      { key: 'hands_off.current', kind: 'counter', value: 3, updated_at: NOW },
    ] }));
    expect(streakOnly).toContain('Streaks');
    expect(streakOnly).not.toContain('only ever go up');
    // ⚠ And a streak carries no "set just now" — it is rewritten every cycle, so the
    // timestamp reported that the server was awake, not that anything was achieved.
    expect(streakOnly).not.toContain('set just now');

    const recordOnly = render(out({ artifacts: [
      { key: 'burst', kind: 'record', value: 9, updated_at: NOW },
    ] }));
    expect(recordOnly).toContain('only ever go up');
    expect(recordOnly).not.toContain('Streaks');
  });
});

describe('D-250 § D5.3 — milestones have THREE states', () => {
  const m = (over: Record<string, unknown>) => ({
    milestone_id: 'x', label: 'X', description: 'do a thing',
    earned_at: null, detectable: true, ...over,
  }) as MetricReadOutput['milestones'][number];

  it('⛔⛔ UNTRACKED IS NOT THE SAME AS UNEARNED', () => {
    // Rendered alike, an unhooked milestone tells the owner "you have not done this"
    // when the truth is "we are not looking" — the reason `detectable` is on the wire.
    const html = render(out({ milestones: [
      m({ milestone_id: 'earned_one', label: 'Earned', earned_at: NOW - 86_400_000 }),
      m({ milestone_id: 'pending_one', label: 'Pending' }),
      m({ milestone_id: 'untracked_one', label: 'Untracked', detectable: false }),
    ] }));
    expect(html).toContain('stats-milestone--earned');
    expect(html).toContain('stats-milestone--pending');
    expect(html).toContain('stats-milestone--untracked');
    expect(html).toContain('Not tracked yet');
    // ⚠ ...and it says WHY, rather than leaving "not tracked" to be read as "not done".
    expect(html).toContain('This build cannot detect it yet.');
  });

  it('⛔⛔ AN EARNED MILESTONE SHOWS BOTH WHEN AND WHAT IT TOOK', () => {
    // ⛔ INVERTED DELIBERATELY. This read `expect(html).not.toContain('do a thing')`:
    // the description was REPLACED by the status once earned, so the page could tell
    // you that you had achieved something without ever saying what it was — and the
    // owner reading a row has no other place to find out. The status moved to its own
    // column, so there is no longer a slot being competed for.
    const html = render(out({ milestones: [m({ earned_at: NOW - 3 * 86_400_000 })] }));
    expect(html).toContain('Earned 3 days ago');
    expect(html).toContain('do a thing');
  });
});

describe('D-250 § D7 — coverage is shown, not assumed', () => {
  it('⛔ DIAGNOSTICS ARE PRESENT AND EXPLAIN WHAT A DASH MEANS', () => {
    const html = render(out({ snapshot: { ...out().snapshot!,
      diagnostics: { unclassified_runs: 2, streak_reset_for_gap: true } } }));
    expect(html).toContain('Coverage and diagnostics');
    expect(html).toContain('unclassified runs');
    expect(html).toContain('not zero');
  });

  it('says so plainly when there are no gaps', () => {
    expect(render(out())).toContain('No coverage gaps recorded');
  });

  it('⛔ RAW COUNTS ARE BEHIND A DISCLOSURE, not the headline (§ D5.1)', () => {
    const html = render(out({ snapshot: { ...out().snapshot!, diagnostics: { unclassified_runs: 2 } } }));
    expect(html).toContain('<details');
    expect(html.indexOf('stats-cards')).toBeLessThan(html.indexOf('<details'));
  });
});

describe('D-250 — escaping', () => {
  it('escapes a label and a milestone id', () => {
    const html = render(out({ snapshot: { ...out().snapshot!, metrics: [
      { metric_id: '<script>', metric_version: 1, reading: metricValue(1),
        label: '<img onerror=x>', shape: 'share', direction: 'higher', publishable: true },
    ] } }));
    expect(html).not.toContain('<img onerror');
    expect(html).toContain('&lt;');
  });
});
