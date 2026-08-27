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
    expect(html).toMatch(/<span class="stats-card__value">all clear<\/span>/);
    expect(html).not.toMatch(/<span class="stats-card__value">—<\/span>/);
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

  it('shows the direction and the version it was computed under', () => {
    const html = render(out());
    expect(html).toContain('higher is better');
    expect(html).toContain('v1');
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
    expect(html).toContain('not tracked yet');
  });

  it('an earned milestone shows when, not what it takes', () => {
    const html = render(out({ milestones: [m({ earned_at: NOW - 3 * 86_400_000 })] }));
    expect(html).toContain('earned 3 days ago');
    expect(html).not.toContain('do a thing');
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
