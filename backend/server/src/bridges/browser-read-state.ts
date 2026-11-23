import { isBrowserReadState, type BrowserReadState } from '@recued/contracts';

/** Only values supported by this actual response enter the model's scope header.
 * The header neither grants action authority nor changes stored source coverage. */
export const withBrowserReadState = (read: Record<string, unknown>, input: Record<string, unknown>,
  reportedLoading?: boolean, source?: BrowserReadState['source']): Record<string, unknown> => {
  if (!['outline', 'text', 'lines'].some(key => typeof read[key] === 'string')) return read;
  const form = input.form === 'text' ? 'text' : 'outline';
  const string = (v: unknown, max = 256) => typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v : undefined;
  const previous = isBrowserReadState(read.read_state) ? read.read_state : undefined;
  let scope: BrowserReadState['scope'] = { kind: form === 'text' ? 'page_text' : 'page', form };
  const ref = string(input.ref), selector = string(input.selector, 1_000), block = string(input.block);
  const find = string(read.find ?? input.find);
  const from = typeof input.from === 'number' ? input.from : typeof input.from === 'string' ? Number(input.from) : undefined;
  if (ref || selector) scope = { kind: 'element', form, ...(ref ? { ref } : { selector, first_match: true }) };
  else if (input.ref || input.selector) scope = { kind: 'unknown', form };
  else if (block) scope = { kind: 'block', form, block };
  else if (find) scope = typeof read.sections === 'number' ? { kind: 'section', form, find }
    : typeof read.matches === 'number' ? { kind: 'search', form, find }
      : { kind: 'element', form, selector: find, first_match: true };
  else if (input.find || input.block) scope = { kind: 'unknown', form };
  else if (from !== undefined && from > 0 || read.next !== undefined || read.truncated === true) {
    scope = { kind: 'page_part', form, ...(from !== undefined && Number.isSafeInteger(from) && from > 0 ? { from } : { from: 1 }) };
  }
  const matches = read.selector_matches, selected = read.selected_index;
  if (scope.kind === 'element' && scope.selector && Number.isSafeInteger(matches) && Number(matches) > 0
    && Number.isSafeInteger(selected) && Number(selected) > 0 && Number(selected) <= Number(matches)) {
    const { first_match: _first, ...rest } = scope;
    scope = { ...rest, ...(Number(selected) === 1 ? { first_match: true } : {}), matched_count: Number(matches), selected_index: Number(selected) };
  } else if (scope.kind === 'element' && previous?.scope.kind === 'element' && scope.selector === previous.scope.selector
    && previous.scope.matched_count !== undefined) scope = { ...scope, matched_count: previous.scope.matched_count, selected_index: previous.scope.selected_index };
  const state: BrowserReadState = { source: source ?? previous?.source ?? 'kept_snapshot', scope,
    loading: typeof read.loading === 'boolean' ? read.loading : previous?.loading ?? reportedLoading ?? 'unknown',
    complete: typeof read.complete === 'boolean' ? read.complete : previous?.complete ?? 'unknown',
    truncated: typeof read.truncated === 'boolean' ? read.truncated : previous?.truncated ?? 'unknown',
    // 2026-11-20 — whether the page had stopped changing when it was read: only from a read that waited for it.
    ...(typeof read.settled === 'boolean' ? { settled: read.settled }
      : previous?.settled !== undefined ? { settled: previous.settled } : {}) };
  const { read_state: _previous, ...content } = read;
  return { read_state: state, ...content };
};
