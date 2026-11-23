import { browserFieldEvidence } from './browser-field-evidence.js';
import { browserControlEvidence } from './browser-control-evidence.js';
import { browserExtractionTargets } from './browser-extraction-targets.js';
import type { OutlinePart, PageChanges } from './page-outline.js';
import { BROWSER_PAGE_OBSERVATION_CHARS, type BrowserPageObservation } from '@recued/contracts';
export { BROWSER_PAGE_OBSERVATION_CHARS, type BrowserPageObservation } from '@recued/contracts';

/** Companion facts from the post-action read already made by the adapter. */
const MAX_CHANGE_ITEMS = 16;
const MAX_CHANGE_TEXT = 200;
const MAX_CHANGES_CHARS = 1_200;
interface ChangedLine { line?: number; text: string; truncated?: true }
export interface BrowserPageChangeAnswer {
  changes?: string;
  page_observation: BrowserPageObservation;
}
const clip = (text: string, max: number): string => {
  let end = Math.min(text.length, max);
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  return text.slice(0, end);
};
const changedLine = (text: string, line?: number): ChangedLine => ({ ...(line !== undefined ? { line } : {}),
  text: clip(text, MAX_CHANGE_TEXT), ...(text.length > MAX_CHANGE_TEXT ? { truncated: true as const } : {}) });

/** The batch charges this serialized object to its existing read budget. Never
 * shorten an actionable page handle or URL to make it fit. */
export const limitPageObservation = (value: BrowserPageObservation, maxChars = BROWSER_PAGE_OBSERVATION_CHARS): BrowserPageObservation | undefined => {
  const limit = Number.isFinite(maxChars) ? Math.min(BROWSER_PAGE_OBSERVATION_CHARS, Math.max(0, Math.floor(maxChars))) : 0;
  const out: BrowserPageObservation = { ...value,
    ...(value.control_evidence ? { control_evidence: { ...value.control_evidence, items: [...value.control_evidence.items],
      ...(value.control_evidence.incomplete ? { incomplete: [...value.control_evidence.incomplete] } : {}) } } : {}),
    ...(value.omitted ? { omitted: [...value.omitted] } : {}),
    ...(value.changes ? { changes: { ...value.changes, added: [...value.changes.added], removed: [...value.changes.removed] } } : {}),
    ...(value.field_evidence ? { field_evidence: { ...value.field_evidence, items: [...value.field_evidence.items],
      ...(value.field_evidence.incomplete ? { incomplete: [...value.field_evidence.incomplete] } : {}) } } : {}) };
  const fits = () => JSON.stringify(out).length <= limit;
  const omitted = (field: string) => { out.truncated = true; out.omitted = [...new Set([...(out.omitted ?? []), field])]; };
  if (!fits() && out.extraction_targets) { delete out.extraction_targets; omitted('extraction_targets'); }
  while (!fits() && out.field_evidence?.items.length) {
    out.field_evidence.items.pop(); out.field_evidence.complete = false;
    out.field_evidence.incomplete = [...new Set([...(out.field_evidence.incomplete ?? []), 'observation_limit'])];
    out.truncated = true;
  }
  if (!fits() && out.field_evidence) { delete out.field_evidence; omitted('field_evidence'); }
  while (!fits() && out.control_evidence?.items.length) {
    out.control_evidence.items.pop(); out.control_evidence.complete = false;
    out.control_evidence.incomplete = [...new Set([...(out.control_evidence.incomplete ?? []), 'observation_limit'])];
    out.truncated = true;
  }
  if (!fits() && out.control_evidence) { delete out.control_evidence; omitted('control_evidence'); }
  while (!fits() && out.changes && (out.changes.removed.length || out.changes.added.length)) {
    if (out.changes.removed.length) out.changes.removed.pop();
    else {
      const removed = out.changes.added.pop()!;
      if (removed.line !== undefined) out.changes.next_line = removed.line;
    }
    out.changes.complete = false; out.truncated = true;
  }
  if (!fits() && out.changes) { delete out.changes; omitted('changes'); }
  if (!fits() && out.url) { delete out.url; omitted('url'); }
  if (!fits() && out.title) { delete out.title; omitted('title'); }
  if (!fits() && out.range) { delete out.range; omitted('range'); }
  return fits() ? out : undefined;
};

export const unavailablePageObservation = (page: string, reason: 'read_failed' | 'missing_html'): BrowserPageObservation =>
  ({ state: 'unavailable', ...(page.length <= 128 ? { requested_page: page } : {}), reason });

export const browserPageObservation = (input: {
  page: string; url: string; title: string; html: string; loading: boolean; source_truncated: boolean;
  state: 'changed' | 'unchanged' | 'snapshot'; changes?: PageChanges; part?: OutlinePart;
}): BrowserPageObservation => {
  const { page, url, title, state, loading, source_truncated: sourceTruncated, changes, part } = input;
  const omitted: string[] = [];
  if (page.length > 128) omitted.push('page');
  if (url.length > 2_048) omitted.push('url');
  if (title.length > 200) omitted.push('title_suffix');
  const delta: BrowserPageObservation['changes'] = changes ? { added: [], removed: [], added_total: changes.added.length,
    removed_total: changes.gone.length, complete: false } : undefined;
  if (changes && delta) {
    for (const item of changes.added.slice(0, MAX_CHANGE_ITEMS)) {
      delta.added.push(changedLine(item.shown, item.number));
      if (JSON.stringify(delta).length > MAX_CHANGES_CHARS - 100) { delta.added.pop(); break; }
    }
    for (const text of changes.gone.slice(0, MAX_CHANGE_ITEMS)) {
      delta.removed.push(changedLine(text));
      if (JSON.stringify(delta).length > MAX_CHANGES_CHARS - 100) { delta.removed.pop(); break; }
    }
    delta.complete = !loading && !sourceTruncated && delta.added.length === changes.added.length
      && delta.removed.length === changes.gone.length && [...delta.added, ...delta.removed].every(line => !line.truncated);
    if (delta.added.length < changes.added.length) delta.next_line = changes.added[delta.added.length]!.number;
  }
  const fields = !loading ? browserFieldEvidence(input.html, { whole: true, truncated: sourceTruncated }) : undefined;
  const controls = !loading ? browserControlEvidence(input.html, { whole: true, truncated: sourceTruncated }) : undefined;
  const out: BrowserPageObservation = { state, ...(state !== 'snapshot' ? { comparison: 'outline' } : {}),
    ...(page.length <= 128 ? { page } : {}), ...(url.length <= 2_048 ? { url } : {}),
    title: clip(title, 200), loading, source_truncated: sourceTruncated,
    ...(delta ? { changes: delta } : {}),
    ...(part ? { range: { from: part.from, to: part.to, total: part.total, ...(part.more ? { next: part.to + 1 } : {}) } } : {}),
    ...(fields ? { field_evidence: fields } : {}), ...(omitted.length ? { truncated: true, omitted } : {}) };
  out.extraction_targets = browserExtractionTargets(input.html, { url, whole: true, complete: !loading && !sourceTruncated });
  if (controls) out.control_evidence = controls;
  return limitPageObservation(out) ?? unavailablePageObservation(page, 'missing_html');
};
