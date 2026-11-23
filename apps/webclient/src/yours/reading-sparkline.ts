/** D-339 slice 7b (2026-11-17) — a reading's recent days as a sparkline, in plain SVG with no
 *  library: the app's first chart.
 *
 *  The owner's fence (ruling 10): a sparkline only. No axes, no hover, no zoom; what it says is
 *  written beside it as text. The line is the server's points (`YoursReadingTrend`, a point a day),
 *  and the shaded band is the usual range, median ± MAD.
 *
 *  Slice 9 writes three lenses beside it, each when the server sent it: **Usual**, the range the
 *  latest is read against and its days; **Trend**, which way the line goes; **Average**, the last 7
 *  and 30 days against the periods before them. Without a trend, a caption says the days the line
 *  covers. */
import type { YoursReadingTrend } from '@recued/contracts';
import { readingAverageWords, readingSpanWords, readingTrendWords } from './reading-words.js';

const SVG = 'http://www.w3.org/2000/svg';
const WIDTH = 120;
const HEIGHT = 28;
const PAD = 3;

/** A value as the page writes one: a whole number as it is, else one decimal. */
export const trendNumber = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/u, '');

export const renderReadingSparkline = (parent: HTMLElement, label: string, trend: YoursReadingTrend): HTMLElement => {
  const doc = parent.ownerDocument;
  const box = doc.createElement('div');
  box.className = 'yours-reading-trend';
  box.dataset.yoursReadingTrend = trend.field;
  const values = trend.points.map(point => point.value);
  const bands = trend.usual ? [trend.usual.low, trend.usual.high] : [];
  const low = Math.min(...values, ...bands);
  const high = Math.max(...values, ...bands);
  const first = trend.points[0]!.at;
  const last = trend.points[trend.points.length - 1]!.at;
  const x = (at: number) => PAD + (WIDTH - 2 * PAD) * (last === first ? 1 : (at - first) / (last - first));
  // A flat line sits in the middle rather than on an edge.
  const y = (value: number) => HEIGHT / 2 + (high === low ? 0 : (HEIGHT / 2 - PAD) * (1 - 2 * (value - low) / (high - low)));

  const svg = doc.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`);
  svg.setAttribute('width', String(WIDTH));
  svg.setAttribute('height', String(HEIGHT));
  svg.setAttribute('role', 'img');
  // Its values in the reading's own words (D-339 slice 7a): minutes as hours and minutes.
  // An older server drew 30 days and said nothing of them.
  const days = trend.days ?? 30;
  svg.setAttribute('aria-label', `${label} over the last ${days} days: from ${
    readingSpanWords(Math.min(...values), Math.max(...values), trend.unit, ' to ', trendNumber)}, ${trend.points.length} days`);
  if (trend.usual) {
    const band = doc.createElementNS(SVG, 'rect');
    band.setAttribute('class', 'yours-reading-trend-usual');
    band.setAttribute('x', '0');
    band.setAttribute('width', String(WIDTH));
    band.setAttribute('y', String(y(trend.usual.high)));
    band.setAttribute('height', String(Math.max(1, y(trend.usual.low) - y(trend.usual.high))));
    svg.append(band);
  }
  const line = doc.createElementNS(SVG, 'polyline');
  line.setAttribute('class', 'yours-reading-trend-line');
  line.setAttribute('points', trend.points.map(point => `${x(point.at).toFixed(1)},${y(point.value).toFixed(1)}`).join(' '));
  svg.append(line);
  const end = trend.points[trend.points.length - 1]!;
  const dot = doc.createElementNS(SVG, 'circle');
  dot.setAttribute('class', 'yours-reading-trend-latest');
  dot.setAttribute('cx', x(end.at).toFixed(1));
  dot.setAttribute('cy', y(end.value).toFixed(1));
  dot.setAttribute('r', '2');
  svg.append(dot);
  box.append(svg);

  const words = doc.createElement('div');
  words.className = 'yours-reading-words';
  if (!trend.trend) {
    const caption = doc.createElement('small');
    caption.textContent = `Last ${days} days`;
    words.append(caption);
  }
  const lenses = doc.createElement('dl');
  lenses.className = 'yours-reading-lenses';
  const lens = (term: string, ...lines: string[]) => {
    const name = doc.createElement('dt');
    name.textContent = term;
    lenses.append(name);
    for (const line of lines) {
      const value = doc.createElement('dd');
      value.textContent = line;
      lenses.append(value);
    }
  };
  if (trend.usual) {
    lens('Usual', `${readingSpanWords(trend.usual.low, trend.usual.high, trend.unit, '–', trendNumber)} · last ${trend.usual.days ?? 30} days`);
  }
  if (trend.trend) lens('Trend', readingTrendWords(trend.trend, trend.unit));
  if (trend.averages?.length) lens('Average', ...trend.averages.map(average => readingAverageWords(average, trend.unit)));
  if (lenses.children.length) words.append(lenses);
  box.append(words);
  parent.append(box);
  return box;
};
