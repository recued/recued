/** D-226 — rendering per-pack rollups in the entity detail panel.
 *
 *  Two things are worth testing here and the markup is not one of them:
 *
 *  ⛔ A rollup must render ABOVE the feed and never inside it. It has no event
 *  time; in the chronology it would either claim a moment it did not happen at
 *  or sit permanently at the top.
 *
 *  ⛔ `complete: false` must be LOUD. The numbers are a floor, not a total, and
 *  a partial figure that looks like an ordinary value is the precise failure
 *  this whole path exists to prevent — the same "Bob has 3 deals when he has
 *  240" shape, one layer out.
 *
 *  ⚠ CSS is invisible to a render test, so the loudness is asserted on the
 *  TEXT and the modifier class, not on colour. */
import { describe, expect, it } from 'vitest';
import type { TimelineRollup } from '@recued/contracts';
import { renderEntityDetailPanel, renderRollupsSection } from '../memory/entity-detail-panel.js';

const COMPLETE: TimelineRollup = {
  publisher: 'recued-core', pack_slug: 'billable-hours', label: 'Unbilled time',
  value: { unbilled_minutes: 135, entry_count: 3, last_task: 'ENG-502' }, complete: true,
};
const PARTIAL: TimelineRollup = {
  publisher: 'recued-core', pack_slug: 'job-status-board', label: 'Open jobs',
  value: { job_count: 2 }, complete: false,
  incomplete_reason: 'more than 100 job rows reach this root',
};

describe('renderRollupsSection', () => {
  it('renders one card per declaring pack, with its values', () => {
    const html = renderRollupsSection([COMPLETE]);
    expect(html).toContain('Unbilled time');
    expect(html).toContain('unbilled_minutes');
    expect(html).toContain('135');
    expect(html).toContain('recued-core/billable-hours');
  });

  it('⛔ marks an incomplete rollup as a FLOOR, in words a person reads', () => {
    const html = renderRollupsSection([PARTIAL]);
    expect(html).toContain('Partial');
    expect(html).toContain('at least this much');
    expect(html).toContain('more than 100 job rows');
    expect(html).toContain('memory-rollup-card--partial');
    expect(html).toContain('floor');
  });

  it('a COMPLETE rollup carries none of that — the warning must discriminate', () => {
    const html = renderRollupsSection([COMPLETE]);
    expect(html).not.toContain('Partial');
    expect(html).not.toContain('memory-rollup-card--partial');
    expect(html).not.toContain('floor');
  });

  it('still names the pack when it declared no label', () => {
    const { label: _drop, ...unlabelled } = COMPLETE;
    expect(renderRollupsSection([unlabelled as TimelineRollup])).toContain('billable-hours');
  });

  it('undefined renders NOTHING — the collection has no rollup surface', () => {
    expect(renderRollupsSection(undefined)).toBe('');
  });

  it('an empty array SAYS so — different answer from "not applicable"', () => {
    const html = renderRollupsSection([]);
    expect(html).toContain('Where things stand');
    expect(html).toContain('No installed pack tracks anything');
  });

  it('escapes pack-supplied text rather than trusting it', () => {
    const hostile: TimelineRollup = {
      publisher: 'x', pack_slug: 'y', label: '<img src=x onerror=alert(1)>',
      value: { '<script>': '</script>' }, complete: true,
    };
    const html = renderRollupsSection([hostile]);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;');
  });
});

describe('placement inside the panel', () => {
  const panel = (rollups?: TimelineRollup[]) => renderEntityDetailPanel({
    scope: 'contact', target_id: 'bob@acme.test', vendorEntity: null,
    metaSnapshot: null, enrichments: [], now: 1_800_000_000_000,
    timelineEntries: [],
    ...(rollups === undefined ? {} : { rollups }),
  });

  it('⛔ sits ABOVE the timeline, not inside it', () => {
    const html = panel([COMPLETE]);
    const rollupAt = html.indexOf('Where things stand');
    const timelineAt = html.indexOf('>Timeline<');
    expect(rollupAt).toBeGreaterThan(-1);
    expect(timelineAt).toBeGreaterThan(-1);
    expect(rollupAt, 'rollups must precede the feed').toBeLessThan(timelineAt);
  });

  it('⛔ never lands in the feed markup itself', () => {
    const html = panel([COMPLETE]);
    const feed = html.slice(html.indexOf('memory-timeline-feed'));
    expect(feed).not.toContain('unbilled_minutes');
    expect(feed).not.toContain('memory-rollup-card');
  });

  it('a panel with no rollups is unchanged — no empty section appears', () => {
    const html = panel(undefined);
    expect(html).not.toContain('Where things stand');
    expect(html).not.toContain('memory-rollup');
  });
});
