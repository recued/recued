import { savedTextUrls } from '@recued/contracts';
import { e } from '../template.js';

const recordAddress = /#data\/(?:(?:mail|calendar)\/record|contact|task|note)\//u;

/** Keep saved notes as text, adding links without interpreting markup. */
export const renderTaskNotes = (body: string, reader: 'task' | 'note' = 'task'): string => {
  let html = '', cursor = 0, index = 0;
  const occurrences = new Map<string, number>();
  for (const { href, start, end } of savedTextUrls(body)) {
    if (reader === 'note' && !recordAddress.test(href)) continue;
    try { const url = new URL(href, 'https://recued.invalid/'); if (!['http:', 'https:'].includes(url.protocol)) continue; }
    catch { continue; }
    const occurrence = occurrences.get(href) ?? 0; occurrences.set(href, occurrence + 1);
    html += e(body.slice(cursor, start)) + `<a href="${e(href)}" target="_blank" rel="noopener noreferrer" data-${reader}-note-link="${index}" data-${reader}-focus="note-link:${e(href)}:${occurrence}">${e(href)}</a>`;
    cursor = end; index++;
  }
  return html + e(body.slice(cursor));
};
