import { FILE_PREVIEW_TEXT_CHARACTERS } from '@recued/contracts';

export interface PdfTextRun { start: number; end: number }
export interface PdfSearchPage { text: string; truncated: boolean }
export interface PdfSearchMatch extends PdfTextRun { page: number }
export interface PdfSearchState {
  query: string;
  phase: 'idle' | 'searching' | 'done' | 'stopped';
  searched: number;
  total: number;
  textPages: number;
  unreadable: number;
  limited: boolean;
  matches: readonly PdfSearchMatch[];
  active: number;
}

/** PDF.js already supplies spaces between words. Do not insert spaces between
 * runs: a single word can span multiple font or positioning runs. */
export const buildPdfText = <T extends { str: string; hasEOL?: boolean }>(source: readonly T[]) => {
  let text = '', truncated = false;
  const items: T[] = [], runs: PdfTextRun[] = [];
  for (const item of source) {
    if (items.length >= 10_000 || text.length >= FILE_PREVIEW_TEXT_CHARACTERS) { truncated = true; break; }
    const room = FILE_PREVIEW_TEXT_CHARACTERS - text.length;
    const str = item.str.length > room ? item.str.slice(0, room).replace(/[\uD800-\uDBFF]$/, '') : item.str;
    const start = text.length; text += str;
    items.push({ ...item, str }); runs.push({ start, end: text.length });
    if (str.length < item.str.length) { truncated = true; break; }
    if (item.hasEOL && text.length < FILE_PREVIEW_TEXT_CHARACTERS) text += '\n';
  }
  return { text, items, runs, truncated };
};

const normalize = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/ς/gu, 'σ').replace(/\s+/gu, ' ');
const graphemes = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const segments = function* (text: string) {
  if (graphemes) yield* graphemes.segment(text);
  else for (const match of text.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) yield { segment: match[0], index: match.index };
};

/** Case-insensitive literal phrases, including line breaks and canonical
 * Unicode equivalents, with offsets into the original text for highlighting. */
export const findPdfMatches = (text: string, query: string, limit: number): PdfTextRun[] => {
  const needle = normalize(query).trim();
  if (!needle || limit <= 0) return [];
  const pieces: string[] = []; let space = false;
  const starts: number[] = [], ends: number[] = [];
  for (const { segment, index } of segments(text)) {
    for (const point of normalize(segment)) {
      if (point === ' ' && space) { ends[ends.length - 1] = index + segment.length; continue; }
      pieces.push(point); space = point === ' ';
      for (let i = 0; i < point.length; i++) { starts.push(index); ends.push(index + segment.length); }
    }
  }
  const folded = pieces.join('');
  const matches: PdfTextRun[] = [];
  let from = 0;
  while (matches.length < limit) {
    const at = folded.indexOf(needle, from);
    if (at < 0) break;
    const start = starts[at]!, end = ends[at + needle.length - 1]!;
    if (start >= (matches.at(-1)?.end ?? 0)) matches.push({ start, end });
    from = at + needle.length;
  }
  return matches;
};

export const createPdfSearch = (opts: {
  total: number;
  read(page: number): Promise<PdfSearchPage>;
  changed(state: PdfSearchState): void;
  selected(match: PdfSearchMatch): void;
  /** An event-loop turn between pages keeps cancellation and paging responsive. */
  yieldPage?: () => Promise<void>;
  limits?: { pages?: number; characters?: number; matches?: number };
}) => {
  const maxPages = opts.limits?.pages ?? 1000, maxCharacters = opts.limits?.characters ?? 2_000_000;
  const maxMatches = opts.limits?.matches ?? 2000;
  const cache = new Map<number, PdfSearchPage>(); let cachedCharacters = 0;
  const idle = (query: string): PdfSearchState => ({ query, phase: 'idle', searched: 0, total: opts.total,
    textPages: 0, unreadable: 0, limited: false, matches: [], active: -1 });
  let state = idle(''), generation = 0, disposed = false;
  const publish = () => { if (!disposed) opts.changed(state); };
  const setQuery = (query: string): void => { generation++; state = idle(query.slice(0, 512)); publish(); };
  const start = async (): Promise<void> => {
    if (disposed || !state.query.trim()) return;
    const own = ++generation, query = state.query;
    state = { ...idle(query), phase: 'searching' }; publish();
    let characters = 0;
    for (let page = 1; page <= Math.min(opts.total, maxPages); page++) {
      if (disposed || own !== generation) return;
      try {
        const content = cache.get(page) ?? await opts.read(page);
        if (disposed || own !== generation) return;
        if (!cache.has(page) && cache.size < maxPages && cachedCharacters + content.text.length <= maxCharacters) {
          cache.set(page, { text: content.text, truncated: content.truncated }); cachedCharacters += content.text.length;
        }
        const room = maxCharacters - characters, text = content.text.slice(0, room);
        const found = findPdfMatches(text, query, maxMatches - state.matches.length + 1);
        const overflow = found.length + state.matches.length > maxMatches;
        state = { ...state, searched: page, textPages: state.textPages + (text.trim() ? 1 : 0),
          limited: state.limited || content.truncated || text.length < content.text.length || overflow,
          matches: [...state.matches, ...found.slice(0, maxMatches - state.matches.length).map(match => ({ ...match, page }))] };
        characters += text.length;
        if (characters >= maxCharacters || overflow) { state = { ...state, limited: state.limited || overflow || page < opts.total }; break; }
      } catch {
        if (disposed || own !== generation) return;
        state = { ...state, searched: page, unreadable: state.unreadable + 1 };
      }
      publish();
      await (opts.yieldPage?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0)));
    }
    if (disposed || own !== generation) return;
    state = { ...state, phase: 'done', limited: state.limited || state.searched < opts.total }; publish();
  };
  const select = (index: number): void => {
    if (disposed || !state.matches.length) return;
    const active = (index + state.matches.length) % state.matches.length;
    state = { ...state, active }; publish(); opts.selected(state.matches[active]!);
  };
  return {
    state: () => state, setQuery, start, select,
    next: () => select(state.active + 1),
    previous: () => select(state.active < 0 ? state.matches.length - 1 : state.active - 1),
    stop() { generation++; if (state.phase === 'searching') { state = { ...state, phase: 'stopped' }; publish(); } },
    dispose() { disposed = true; generation++; cache.clear(); },
  };
};
