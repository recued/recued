/** D-339 slices 7b and 9 (2026-11-17) — a reading's recent days as a sparkline in plain SVG, with
 *  what it shows written beside it: the days it covers, and the lenses the server sent (usual, trend,
 *  average). The owner's fence: a sparkline only (no axes, hover or zoom). Drawn on the Yours page in
 *  real Chrome by the slices' browser checks; here, its geometry and words. */
import { describe, expect, it } from 'vitest';
import type { YoursReadingTrend } from '@recued/contracts';
import { renderReadingSparkline, trendNumber } from '../yours/reading-sparkline.js';
import { readingAverageWords, readingTrendWords } from '../yours/reading-words.js';

interface FakeNode {
  tag: string; ns?: string; attrs: Record<string, string>; children: FakeNode[]; textContent: string;
  className: string; dataset: Record<string, string>; ownerDocument: FakeDocument;
  setAttribute(name: string, value: string): void; append(...nodes: FakeNode[]): void;
}
interface FakeDocument { createElement(tag: string): FakeNode; createElementNS(ns: string, tag: string): FakeNode }
const fakeDocument = (): FakeDocument => {
  const doc: FakeDocument = {
    createElement: tag => node(tag),
    createElementNS: (ns, tag) => node(tag, ns),
  };
  const node = (tag: string, ns?: string): FakeNode => ({
    tag, ...(ns ? { ns } : {}), attrs: {}, children: [], textContent: '', className: '', dataset: {}, ownerDocument: doc,
    setAttribute(name, value) { this.attrs[name] = value; },
    append(...nodes) { this.children.push(...nodes); },
  });
  return doc;
};
const draw = (trend: YoursReadingTrend) => {
  const parent = fakeDocument().createElement('article');
  const box = renderReadingSparkline(parent as unknown as HTMLElement, 'Sleep', trend) as unknown as FakeNode;
  const svg = box.children[0]!;
  const byClass = (name: string) => svg.children.find(child => child.attrs.class === name);
  const points = (byClass('yours-reading-trend-line')!.attrs.points ?? '').split(' ').map(pair => pair.split(',').map(Number) as [number, number]);
  // Beside the line: the caption the days get without a trend, and each lens as its term and lines.
  const words = box.children[1]!;
  const caption = words.children.find(child => child.tag === 'small')?.textContent;
  const lenses: string[][] = [];
  for (const child of words.children.find(node => node.tag === 'dl')?.children ?? []) {
    if (child.tag === 'dt') lenses.push([child.textContent]); else lenses.at(-1)!.push(child.textContent);
  }
  return { parent: parent as FakeNode, box, svg, byClass, points, words, caption, lenses };
};

const DAY = 86_400_000;
const at = Date.parse('2026-11-17T15:00:00Z');
const trend = (values: number[], usual?: YoursReadingTrend['usual']): YoursReadingTrend => ({
  field: 'sleep_minutes', unit: 'min', points: values.map((value, i) => ({ at: at - (values.length - 1 - i) * DAY, value })),
  ...(usual ? { usual } : {}) });

describe('D-339 slice 7b — the reading\'s sparkline', () => {
  it('is plain SVG in the reading\'s row: a line oldest to newest, its newest point marked, an image with words', () => {
    const { parent, box, svg, byClass, points } = draw(trend([400, 450, 420]));
    expect(parent.children).toEqual([box]);
    expect(box.dataset.yoursReadingTrend).toBe('sleep_minutes');
    expect(svg).toMatchObject({ tag: 'svg', ns: 'http://www.w3.org/2000/svg' });
    expect(svg.attrs).toMatchObject({ viewBox: '0 0 120 28', role: 'img',
      'aria-label': 'Sleep over the last 30 days: from 6 h 40 to 7 h 30, 3 days' });
    // Time runs left to right, and a larger value sits higher.
    expect(points.map(([x]) => x)).toEqual([3, 60, 117]);
    expect(points[1]![1]).toBeLessThan(points[2]![1]);
    expect(points[2]![1]).toBeLessThan(points[0]![1]);
    expect(byClass('yours-reading-trend-latest')!.attrs).toMatchObject({ cx: '117.0', cy: points[2]![1].toFixed(1) });
    // ⛔ The fence: nothing but the line, its newest point and the usual band.
    expect(svg.children.map(child => child.tag)).toEqual(['polyline', 'circle']);
  });

  it('shades the usual range and writes it beside the line', () => {
    const { svg, byClass, caption, lenses } = draw(trend([400, 450, 420], { median: 425, low: 412.5, high: 437.5 }));
    expect(svg.children.map(child => child.tag)).toEqual(['rect', 'polyline', 'circle']);
    const band = byClass('yours-reading-trend-usual')!.attrs;
    expect(Number(band.height)).toBeGreaterThan(0);
    // D-339 slice 7a: minutes in hours and minutes, as the reading's value is written.
    // An older server's: no days anywhere, so the 30 it drew.
    expect(caption).toBe('Last 30 days');
    expect(lenses).toEqual([['Usual', '6 h 53–7 h 18 · last 30 days']]);
    expect(draw(trend([400, 450]))).toMatchObject({ caption: 'Last 30 days', lenses: [] });
    expect(draw(trend([400, 450])).words.children.map(child => child.tag)).toEqual(['small']);
    // Every other unit keeps its numbers.
    const hrv = draw({ field: 'hrv_rmssd', unit: 'ms', points: [{ at: at - DAY, value: 40 }, { at, value: 52 }], usual: { median: 44, low: 41, high: 47.25 } });
    expect(hrv.lenses).toEqual([['Usual', '41–47.3 ms · last 30 days']]);
    expect(hrv.svg.attrs['aria-label']).toBe('Sleep over the last 30 days: from 40 to 52 ms, 2 days');
  });

  it('keeps a flat line in the middle, and a usual wider than the days inside the picture', () => {
    expect(draw(trend([7, 7, 7])).points.every(([, y]) => y === 14)).toBe(true);
    const wide = draw(trend([400, 410], { median: 405, low: 300, high: 500 }));
    for (const [, y] of wide.points) expect(y).toBeGreaterThanOrEqual(3);
    const band = wide.byClass('yours-reading-trend-usual')!.attrs;
    expect(Number(band.y)).toBeGreaterThanOrEqual(3);
    expect(Number(band.y) + Number(band.height)).toBeLessThanOrEqual(25);
  });

  it('writes a whole number as it is, and one decimal otherwise', () => {
    expect([trendNumber(425), trendNumber(41.25), trendNumber(7.04), trendNumber(-2)]).toEqual(['425', '41.3', '7', '-2']);
  });
});

describe('D-339 slice 9 — the lenses beside the line', () => {
  it('writes the usual with its days, which way the line goes and the averages, in that order', () => {
    const lensed: YoursReadingTrend = { ...trend([400, 450, 420], { median: 425, low: 412.5, high: 437.5, days: 14 }), days: 30,
      trend: { direction: 'rising', per_week: 9.4, days: 30 },
      averages: [{ days: 7, value: 422.4, previous: 408 }, { days: 30, value: 411 }] };
    const { caption, lenses, svg } = draw(lensed);
    expect(lenses).toEqual([
      ['Usual', '6 h 53–7 h 18 · last 14 days'],
      ['Trend', 'Rising, about 9 min a week · last 30 days'],
      ['Average', '7 h 02 over the last 7 days, 14 min more than the 7 days before', '6 h 51 over the last 30 days'],
    ]);
    // The trend says the days the line covers, so no caption repeats them.
    expect(caption).toBeUndefined();
    expect(svg.attrs['aria-label']).toBe('Sleep over the last 30 days: from 6 h 40 to 7 h 30, 3 days');
    const short = draw({ ...trend([400, 450]), days: 14 });
    expect(short).toMatchObject({ caption: 'Last 14 days', lenses: [] });
    expect(short.svg.attrs['aria-label']).toBe('Sleep over the last 14 days: from 6 h 40 to 7 h 30, 2 days');
  });

  it('words a trend in the reading\'s unit, never as 0, and a steady one without a size', () => {
    expect(readingTrendWords({ direction: 'steady', per_week: 0.2, days: 30 }, 'ms')).toBe('Steady · last 30 days');
    expect(readingTrendWords({ direction: 'falling', per_week: -2.46, days: 21 }, 'ms')).toBe('Falling, about 2.5 ms a week · last 21 days');
    expect(readingTrendWords({ direction: 'rising', per_week: 75.4, days: 30 }, 'min')).toBe('Rising, about 1 h 15 a week · last 30 days');
    expect(readingTrendWords({ direction: 'falling', per_week: -0.043, days: 30 }, 'kg')).toBe('Falling, about 0.043 kg a week · last 30 days');
    expect(readingTrendWords({ direction: 'rising', per_week: 452.7, days: 30 }, 'steps')).toBe('Rising, about 453 steps a week · last 30 days');
  });

  it('words an average against the period before it: more, less, or the same once both read alike', () => {
    expect(readingAverageWords({ days: 7, value: 72.38, previous: 72.71 }, 'kg')).toBe('72.4 kg over the last 7 days, 0.33 kg less than the 7 days before');
    expect(readingAverageWords({ days: 30, value: 41.96, previous: 42.04 }, 'ms')).toBe('42 ms over the last 30 days, the same as the 30 days before');
    expect(readingAverageWords({ days: 7, value: 422.4, previous: 421.6 }, 'min')).toBe('7 h 02 over the last 7 days, the same as the 7 days before');
    expect(readingAverageWords({ days: 7, value: 9120.4, previous: 8000 }, 'steps')).toBe('9120 steps over the last 7 days, 1120 steps more than the 7 days before');
    expect(readingAverageWords({ days: 30, value: 50 }, 'ms')).toBe('50 ms over the last 30 days');
  });
});
