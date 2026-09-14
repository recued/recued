/** D-266 — the one-per-wake missed-run card. */
import { describe, expect, it } from 'vitest';
import {
  renderMissedRunsCard,
  parseMissedRunsAction,
  formatOutage,
  MISSED_RUNS_ACTION_ATTR,
  type MissedRunsCardReport,
} from '../missed-runs-card.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 3, 20, 8, 10, 0);

const report = (over: Partial<MissedRunsCardReport> = {}): MissedRunsCardReport => ({
  outage_from: NOW - (2 * DAY + 14 * HOUR),
  outage_to: NOW,
  entries: [
    { recipe_id: 'brief', recipe_name: 'Morning brief', missed_cycles: 2, last_run_at: NOW - 3 * DAY },
    { recipe_id: 'sweep', recipe_name: 'Invoice sweep', missed_cycles: 0, last_run_at: NOW - DAY },
  ],
  ...over,
});

describe('D-266 — the card', () => {
  it('renders ONE card for everything waiting, one line per recipe', () => {
    const html = renderMissedRunsCard(report());
    expect(html.match(/class="missed-runs-card"/g)).toHaveLength(1);
    expect(html).toContain('Morning brief');
    expect(html).toContain('Invoice sweep');
  });

  it('shows the outage window, so the owner learns the machine was off', () => {
    expect(renderMissedRunsCard(report())).toContain('2d 14h');
  });

  it('states the missed COUNT but promises only one run each', () => {
    const html = renderMissedRunsCard(report());
    // missed_cycles counts FULL cycles beyond the catch-up on offer, so a
    // reading of 2 is three missed runs.
    expect(html).toContain('missed 3');
    expect(html).toContain('missed 1');
    expect(html).toMatch(/supersedes/i);
  });

  it('⛔ renders a CAPPED count as "N+" — never a precise figure it does not have', () => {
    const html = renderMissedRunsCard(report({
      entries: [{
        recipe_id: 'hourly-sweep',
        missed_cycles: 98,
        missed_cycles_capped: true,
        last_run_at: NOW - 9 * DAY,
      }],
    }));
    // An hourly schedule down nine days passed ~216 occurrences; the
    // server stopped counting at its bound. "missed 99" would be a
    // precise claim about an outage of any length above it.
    expect(html).toContain('missed 99+');
    expect(html).not.toMatch(/missed 99(?!\+)/);
  });

  it('says "at least one" rather than inventing a number it never measured', () => {
    const html = renderMissedRunsCard(report({
      entries: [{ recipe_id: 'x', missed_cycles: 'unknown', last_run_at: NOW - DAY }],
    }));
    expect(html).toContain('missed at least one');
    expect(html).not.toContain('NaN');
  });

  it('falls back to the recipe id when the recipe is gone', () => {
    const html = renderMissedRunsCard(report({
      entries: [{ recipe_id: 'uninstalled-thing', missed_cycles: 0, last_run_at: NOW - DAY }],
    }));
    expect(html).toContain('uninstalled-thing');
  });

  it('offers both bulk answers and a per-recipe pair — "decide each" with no mode', () => {
    const html = renderMissedRunsCard(report());
    expect(html).toContain(`${MISSED_RUNS_ACTION_ATTR}="run"`);
    expect(html).toContain(`${MISSED_RUNS_ACTION_ATTR}="skip"`);
    expect(html).toContain(`${MISSED_RUNS_ACTION_ATTR}="run:brief"`);
    expect(html).toContain(`${MISSED_RUNS_ACTION_ATTR}="skip:sweep"`);
  });

  it('renders NOTHING when nothing is waiting — the host can splice unconditionally', () => {
    expect(renderMissedRunsCard(null)).toBe('');
    expect(renderMissedRunsCard(report({ entries: [] }))).toBe('');
  });

  it('escapes a hostile recipe name rather than rendering it as markup', () => {
    const html = renderMissedRunsCard(report({
      entries: [{ recipe_id: 'x', recipe_name: '<img src=x onerror=alert(1)>', missed_cycles: 0, last_run_at: NOW }],
    }));
    expect(html).not.toContain('<img');
  });
});

describe('D-266 — parseMissedRunsAction', () => {
  it('reads both bulk and scoped answers', () => {
    expect(parseMissedRunsAction('run')).toEqual({ answer: 'run' });
    expect(parseMissedRunsAction('skip:brief')).toEqual({ answer: 'skip', recipe_id: 'brief' });
  });

  it('⛔ keeps a recipe id containing a colon whole', () => {
    // `split(':')[1]` would answer for `a` and silently leave `a:b` waiting.
    expect(parseMissedRunsAction('run:vendor:daily'))
      .toEqual({ answer: 'run', recipe_id: 'vendor:daily' });
  });

  it('rejects anything that is not one of the four shapes', () => {
    for (const bad of ['', 'maybe', 'run:', ':brief', null, undefined, 'delete:brief']) {
      expect(parseMissedRunsAction(bad as string), String(bad)).toBeNull();
    }
  });
});

describe('D-266 — formatOutage', () => {
  it('is coarse on purpose — the decision never turns on minutes past the first hour', () => {
    expect(formatOutage(25 * 60_000)).toBe('25m');
    expect(formatOutage(3 * HOUR + 40 * 60_000)).toBe('3h');
    expect(formatOutage(2 * DAY + 14 * HOUR)).toBe('2d 14h');
    expect(formatOutage(3 * DAY)).toBe('3d');
  });

  it('never renders a negative or nonsense window', () => {
    expect(formatOutage(-5)).toBe('0m');
    expect(formatOutage(Number.NaN)).toBe('0m');
  });
});
