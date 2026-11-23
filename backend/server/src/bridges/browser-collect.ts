import {
  BROWSER_COLLECT_MAX_CHARS, BROWSER_COLLECT_MAX_ITEMS, BROWSER_COLLECT_MAX_PAGES, BROWSER_COLLECT_MAX_SECONDS,
  BROWSER_COLLECT_VALUE_CHARS, browserCollectNeedsStructure, parseBrowserCollectSelector,
  type BrowserCollectSpec, type BrowserCollectSelectorPart,
} from '@recued/contracts';
import { parseInspectHtml, type OutlineElement } from './page-outline.js';

type Value = string | string[] | null;
type Values = Record<string, Value>;
export interface BrowserCollectPage {
  page: string; url: string; title: string; html: string; truncated: boolean; loading?: boolean;
  structure_complete?: boolean;
  /** All transformed branches are explicitly marked in this preserved tree. */
  structure_scoped?: boolean;
  /** index, sibling count, type index, type count of the serialized root. */
  structure_root?: string;
}
export interface BrowserCollection {
  records: Array<{ values: Values; sources: Array<{ page: number; item: number }> }>;
  pages: Array<{ page: string; url: string; title: string; items: number }>;
  count: number;
  scanned: number;
  duplicates: number;
  complete: boolean;
  stop_reason: string;
  field_failure?: {
    field: string; selector?: string; many: boolean; required: boolean; matches: number; empty_values: number;
    page: number; item: number; restart_url?: string;
    read_step?: { do: 'read'; page: string; form: 'outline' };
    note: string;
  };
  structural_failure?: {
    cause: 'missing_structure_evidence' | 'missing_scope_evidence' | 'whole_page_required' | 'invalid_root_evidence' | 'target_subtree_incomplete';
    required_for: 'item_positions' | 'field_positions' | 'pagination_positions';
    loading: boolean | 'unknown';
    item?: number;
    read_step?: { do: 'read'; page: string };
    note: string;
  };
  next_url?: string;
  pagination_recovery?: {
    reason: 'same_page_address' | 'non_link_control';
    page: string;
    control: { tag: string; label: string; href?: string; submission_possible: boolean };
    read_step: { do: 'read'; page: string };
    steps?: Array<Record<string, unknown>>;
    note: string;
  };
  /** Processing coverage within the caller's page bound, distinct from global
   * list exhaustion (`complete`). Loading snapshots cannot establish coverage. */
  coverage: {
    page_limit: number;
    pages_processed: number;
    items_processed: number;
    loading_pages: number;
    complete: boolean;
    stopped_at?: { page: number; item: number; field?: string };
  };
  note?: string;
  /** 2026-11-21 (D-402, benchmark task I, live) — the bounds the step asked for above their maxima, and what it read at. */
  bounds?: { asked: NonNullable<BrowserCollectSpec['asked']>; read_at_most: NonNullable<BrowserCollectSpec['asked']>; note: string };
}

/** 2026-11-21 (D-402, benchmark task I, live) — the longest a collect waits for a page it read while it still loaded, and
 *  that showed no Next link, to be ready before it says whether the page has one. */
export const BROWSER_COLLECT_READY_WAIT_MS = 10_000;

const attribute = (node: OutlineElement, name: string): string | undefined => {
  const value = node.attrs[name]; return typeof value === 'string' ? value : value === true ? '' : undefined;
};
const words = (value: string) => value.replace(/\s+/g, ' ').trim();
const textOf = (node: OutlineElement): string => {
  const parts: string[] = [], pending = [...node.children].reverse();
  while (pending.length) {
    const child = pending.pop()!;
    if (child.kind === 'text') parts.push(child.text);
    else if (child.structuralOnly) continue;
    else if (['br', 'hr'].includes(child.tag)) parts.push(' ');
    else pending.push(...[...child.children].reverse());
  }
  return words(parts.join(' '));
};

/** Select only within a cleaned-tree scope. No DOM execution or network access. */
type Position = readonly [number, number, number, number];
type Positions = WeakMap<OutlineElement, Position>;
const siblingPositions = (root: OutlineElement): Positions => {
  const positions: Positions = new WeakMap(), pending = [root];
  while (pending.length) {
    const children = pending.pop()!.children.filter((child): child is OutlineElement => child.kind === 'element');
    const counts = new Map<string, number>(), seen = new Map<string, number>();
    for (const child of children) counts.set(child.tag, (counts.get(child.tag) ?? 0) + 1);
    children.forEach((child, index) => {
      const typed = (seen.get(child.tag) ?? 0) + 1; seen.set(child.tag, typed);
      positions.set(child, [index + 1, children.length, typed, counts.get(child.tag)!]);
      if (!child.structuralOnly) pending.push(child);
    });
  }
  return positions;
};
/** Field selectors are evaluated within one item. Its subtree and containing
 * branches must be faithful; an opaque frame elsewhere is irrelevant. Parents
 * of a marked branch are unsafe scopes, without tainting their other children. */
const incompleteScopes = (root: OutlineElement): { unsafe: WeakSet<OutlineElement>; marked: boolean } => {
  const unsafe = new WeakSet<OutlineElement>();
  const pending = [{ node: root, ancestors: [] as OutlineElement[], within: false }];
  let visited = 0, marked = false;
  while (pending.length) {
    const { node, ancestors, within } = pending.pop()!;
    if (++visited > 20_000 || ancestors.length > 128) throw new Error('Collection page is too complex');
    if (node.structuralIncomplete) {
      marked = true;
      for (const ancestor of ancestors) unsafe.add(ancestor);
    }
    const affected = within || node.structuralIncomplete === true;
    if (affected) unsafe.add(node);
    for (const child of node.children) if (child.kind === 'element') {
      pending.push({ node: child, ancestors: [...ancestors, node], within: affected });
    }
  }
  return { unsafe, marked };
};
const query = (scope: OutlineElement, selector: string, skipDisabled = false, positions?: Positions): OutlineElement[] => {
  const groups = parseBrowserCollectSelector(selector);
  if (!groups) throw new Error('Unsupported collection selector');
  const found: OutlineElement[] = [];
  const pending: Array<{ node: OutlineElement; ancestors: OutlineElement[] }> = [{ node: scope, ancestors: [] }];
  const matches = (node: OutlineElement, part: BrowserCollectSelectorPart): boolean =>
    !node.structuralOnly && (!part.scope || node === scope) && (part.tag === undefined || part.tag === '*' || node.tag === part.tag)
    && (part.id === undefined || attribute(node, 'id') === part.id)
    && part.classes.every(name => (attribute(node, 'class') ?? '').split(/\s+/).includes(name))
    && part.attributes.every(entry => Object.hasOwn(node.attrs, entry.name)
      && (entry.value === undefined || attribute(node, entry.name) === entry.value))
    && (part.positions ?? []).every(test => {
      const position = positions?.get(node);
      if (!position) return false;
      const offset = test.siblings === 'all' ? 0 : 2;
      const index = test.from === 'start' ? position[offset]! : position[offset + 1]! - position[offset]! + 1;
      const delta = index - test.b;
      return test.a === 0 ? delta === 0 : delta % test.a === 0 && delta / test.a >= 0;
    });
  let comparisons = 0;
  const pathMatches = (path: OutlineElement[], parts: readonly BrowserCollectSelectorPart[], at: number, index: number): boolean => {
    if (++comparisons > 200_000) throw new Error('Collection selector is too complex for this page');
    if (at < 0 || !matches(path[at]!, parts[index]!)) return false;
    if (index === 0) return true;
    if (parts[index]!.relation === 'child') return pathMatches(path, parts, at - 1, index - 1);
    for (let before = at - 1; before >= 0; before--) if (pathMatches(path, parts, before, index - 1)) return true;
    return false;
  };
  let visited = 0;
  while (pending.length) {
    if (++visited > 20_000) throw new Error('Collection page has too many elements');
    const { node, ancestors } = pending.pop()!;
    if (ancestors.length > 128) throw new Error('Collection page is too deeply nested');
    if (node.structuralOnly || skipDisabled && disabled(node)) continue;
    const path = [...ancestors, node];
    if (node !== scope || groups.some(parts => parts.at(-1)?.scope)) {
      if (groups.some(parts => pathMatches(path, parts, path.length - 1, parts.length - 1))) found.push(node);
    }
    for (const child of [...node.children].reverse()) if (child.kind === 'element') pending.push({ node: child, ancestors: path });
  }
  return found;
};

const pageAddress = (value: string, base?: string): URL | undefined => {
  if (value.length > 4_096) return undefined;
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    url.hash = ''; return url;
  } catch { return undefined; }
};
const disabled = (node: OutlineElement) => Object.hasOwn(node.attrs, 'disabled') || attribute(node, 'aria-disabled') === 'true'
  || (attribute(node, 'class') ?? '').split(/\s+/).includes('disabled');
const linkName = (node: OutlineElement) => words(attribute(node, 'aria-label') ?? textOf(node) ?? '').toLowerCase()
  .replace(/\s*[→›»]+\s*$/u, '').trim();

/** A grounded starting point for the existing collector, never an execution plan.
 * Every suggested selector is checked on the current cleaned snapshot. No AI,
 * navigation, task-specific site knowledge or newly invented selectors. */
export const browserCollectHint = (html: string, url: string): {
  step: BrowserCollectSpec & { do: 'collect' };
  rows_in_snapshot: number;
  note: string;
} | undefined => {
  try {
    const root = parseInspectHtml(html), address = pageAddress(url);
    if (!address) return undefined;
    const links = query(root, 'a[href]', true).filter(node => ['next', 'next page'].includes(linkName(node)));
    if (links.length > 1) return undefined;
    const next = links[0] ? pageAddress(attribute(links[0], 'href') ?? '', url) : undefined;
    if (links.length && (!next || next.origin !== address.origin || next.href === address.href)) return undefined;
    const safe = (value: string) => /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(value);
    const classes = (node: OutlineElement) => (attribute(node, 'class') ?? '').split(/\s+/).filter(safe);
    const selectors = new Set<string>();
    const pending = [root];
    let visited = 0;
    while (pending.length) {
      const node = pending.pop()!;
      if (++visited > 5_000) return undefined;
      if (['nav', 'header', 'footer'].includes(node.tag)) continue;
      if (['article', 'li', 'tr', 'div', 'section'].includes(node.tag) && selectors.size < 24) {
        for (const name of classes(node).slice(0, 2)) if (selectors.size < 24) selectors.add(`${node.tag}.${name}`);
        if (['article', 'tr'].includes(node.tag)) selectors.add(node.tag);
      }
      pending.push(...node.children.filter((child): child is OutlineElement => child.kind === 'element').reverse());
    }
    let best: { step: BrowserCollectSpec & { do: 'collect' }; rows_in_snapshot: number; score: number } | undefined;
    for (const items of selectors) {
      const rows = query(root, items);
      if (rows.length < 3 || rows.length > 50) continue;
      const fields: Record<string, BrowserCollectSpec['fields'][string]> = {};
      const offer = (name: string, selector: string, fieldAttribute?: BrowserCollectSpec['fields'][string]['attribute']) => {
        if (Object.keys(fields).length >= 4) return;
        const matches = rows.map(row => query(row, selector));
        const read = (node: OutlineElement) => fieldAttribute ? attribute(node, fieldAttribute) ?? '' : textOf(node);
        if (matches.some(nodes => nodes.length === 0 || nodes.length > 20
          || nodes.some(field => !read(field) || read(field).length > BROWSER_COLLECT_VALUE_CHARS || read(field).endsWith('…')))) return;
        const many = matches.some(nodes => nodes.length > 1);
        const key = (many && !name.endsWith('s') ? `${name}s` : name).replace(/-/g, '_');
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(key) || key in fields) return;
        fields[key] = { selector, ...(fieldAttribute ? { attribute: fieldAttribute } : {}), ...(many ? { many: true, required: false } : {}) };
      };
      const children = [...rows[0]!.children].reverse();
      let examined = 0;
      while (children.length && Object.keys(fields).length < 4 && examined++ < 100) {
        const node = children.pop()!;
        if (node.kind !== 'element') continue;
        children.push(...[...node.children].reverse());
        // Prefer the leaf fields over a wrapper that repeats their joined text.
        if (node.children.some(child => child.kind === 'element' && classes(child).length > 0)) continue;
        const name = classes(node)[0], selector = name ? `${node.tag}.${name}` : node.tag;
        if (name) offer(name, selector);
        if (attribute(node, 'title')) {
          offer(name ? `${name}_title_attribute` : 'title_attribute', `${selector}[title]`, 'title');
        }
        if (node.tag === 'img' && attribute(node, 'alt')) offer('alt_attribute', `${selector}[alt]`, 'alt');
        if (attribute(node, 'aria-label')) offer('aria_label_attribute', `${selector}[aria-label]`, 'aria-label');
      }
      if (Object.keys(fields).length < 2 || !Object.values(fields).some(field => field.required !== false)) continue;
      const score = rows.length * Object.keys(fields).length;
      if (!best || score > best.score) best = { step: { do: 'collect', items, fields,
        ...(links[0] ? { next: { text: linkName(links[0]) } } : {}), max_pages: 1, max_items: 200, max_seconds: 60 }, rows_in_snapshot: rows.length, score };
    }
    return best ? { step: best.step, rows_in_snapshot: best.rows_in_snapshot,
      note: 'For requested fields across repeated rows, use a collect step in Act on web pages. Set max_pages to the requested bound '
        + '(1 reads this page only), choose fields and any where filter. Attribute fields name their source; displayed text can be abbreviated. '
        + 'These selectors were checked on this snapshot; later layouts may differ. No Next in this hint is not proof that no other page exists.' } : undefined;
  } catch { return undefined; }
};

/** A value as one number in one format: an optional unit before or after it (a currency sign, a percent), digits with
 *  comma thousands, an optional decimal part. Anything else, a range or another locale's separators included, is not
 *  read as a number. ⚠ A dot before exactly three digits with no comma (`1.250`) is a thousands dot in much of Europe
 *  and a decimal elsewhere, so it is not read: the facts are left out rather than wrong. */
const NUMERIC = /^([^\d\s.,+-]{0,3})\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?([^\d\s.,]{0,3})$/u;
const numberIn = (text: string): { unit: string; value: number } | undefined => {
  const match = NUMERIC.exec(text.trim());
  if (!match) return undefined;
  if (match[3]?.length === 4 && !match[2]!.includes(',')) return undefined;
  const value = Number(match[2]!.replace(/,/g, '') + (match[3] ?? ''));
  return Number.isFinite(value) ? { unit: `${match[1]}|${match[4]}`, value } : undefined;
};
export interface BrowserCollectionFact { value: string; row: number; name?: string; rows_with_value?: number }
export interface BrowserCollectionFacts {
  rows: number;
  fields: Record<string, { lowest: BrowserCollectionFact; highest: BrowserCollectionFact }>;
  more_pages?: true;
  note: string;
}

/** 2026-11-20 — the lowest and highest of each field of the collection a read found, where every value of the field
 *  reads as one number in one format, each with its row and that row's name. On task I (the cheapest of 11 books) the
 *  model comparing prices by eye answered right 3 times in 6, and 3 times in 3 when it asked for a computation. The
 *  facts are computed from this read's rows only, and say so. */
export const browserCollectionFacts = (html: string, hint: { step: BrowserCollectSpec }): BrowserCollectionFacts | undefined => {
  try {
    const rows = query(parseInspectHtml(html), hint.step.items);
    if (rows.length < 3 || rows.length > 50) return undefined;
    const columns = Object.entries(hint.step.fields).filter(([, field]) => field.many !== true).map(([key, field]) => ({ key,
      values: rows.map((row) => {
        const nodes = query(row, field.selector);
        return nodes.length === 1 ? (field.attribute ? attribute(nodes[0]!, field.attribute) ?? '' : textOf(nodes[0]!)).trim() : '';
      }) }));
    const numeric = columns.flatMap((column) => {
      const parsed = column.values.map(numberIn);
      if (parsed.some((value) => value === undefined) || new Set(parsed.map((value) => value!.unit)).size !== 1) return [];
      return [{ ...column, numbers: parsed.map((value) => value!.value) }];
    });
    if (numeric.length === 0) return undefined;
    // The row's name: a text field with a value in every row, one called a title or a name first.
    const texts = columns.filter((column) => !numeric.some((n) => n.key === column.key) && column.values.every(Boolean));
    const name = texts.find((column) => /title|name/i.test(column.key)) ?? texts.find((column) => /alt/i.test(column.key)) ?? texts[0];
    const fields = Object.fromEntries(numeric.map((column) => {
      const at = (target: number): BrowserCollectionFact => {
        const index = column.numbers.indexOf(target), count = column.numbers.filter((n) => n === target).length;
        return { value: column.values[index]!, row: index + 1, ...(name ? { name: name.values[index]! } : {}),
          ...(count > 1 ? { rows_with_value: count } : {}) };
      };
      return [column.key, { lowest: at(Math.min(...column.numbers)), highest: at(Math.max(...column.numbers)) }];
    }));
    return { rows: rows.length, fields, ...(hint.step.next ? { more_pages: true as const } : {}),
      note: `Computed from the ${String(rows.length)} rows of this read: the lowest and highest of each field whose every value is a `
        + `number in one format, with the row it is in.${hint.step.next ? ' More rows are on further pages, not counted here.' : ''}` };
  } catch { return undefined; }
};

/** Follow declared next-page links with existing browser navigation. Every read is fresh;
 * unexpected layouts, ambiguous fields, redirects and bounds return partial data. Permission,
 * provider-handoff and cancellation failures from the dispatcher propagate to the batch. */
export const collectBrowserPages = async (options: {
  spec: BrowserCollectSpec;
  /** `again`: the page read once more after it was ready, a read of its own (never the first read's answer replayed). */
  read: (iteration: number, remainingMs: number, again?: boolean) => Promise<BrowserCollectPage>;
  navigate: (address: string, iteration: number, remainingMs: number) => Promise<{ page?: string; url?: string }>;
  /** 2026-11-21 (task I, live) — waits, at most `ms`, for the page to be ready; whether it was. */
  ready?: (ms: number) => Promise<boolean>;
  assertActive: () => void;
  now?: () => number;
  maxChars?: number;
  /** Host-owned retention budget when a following data step consumes the rows.
   * Never accepted from a model-authored collection specification. */
  retainForData?: boolean;
}): Promise<BrowserCollection> => {
  const { spec } = options, now = options.now ?? Date.now, positional = browserCollectNeedsStructure(spec);
  // Positioning the items themselves or Next needs whole-page evidence. The
  // scoped relaxation applies only to fields within already identified items.
  const positionsIn = (selector: string) => parseBrowserCollectSelector(selector)?.some(group => group.some(part => part.positions?.length));
  const itemPositions = positionsIn(spec.items), nextPositions = spec.next && 'selector' in spec.next && positionsIn(spec.next.selector);
  const outerPositions = itemPositions || nextPositions;
  const deadline = now() + spec.max_seconds * 1000;
  const result: BrowserCollection = { records: [], pages: [], count: 0, scanned: 0, duplicates: 0, complete: false, stop_reason: 'not_started',
    coverage: { page_limit: spec.max_pages, pages_processed: 0, items_processed: 0, loading_pages: 0, complete: false } };
  if (spec.asked !== undefined) {
    const read_at_most = Object.fromEntries(Object.keys(spec.asked).map((key) => [key, spec[key as keyof typeof spec.asked]]));
    result.bounds = { asked: spec.asked, read_at_most, note: `A collection reads at most ${String(BROWSER_COLLECT_MAX_PAGES)} pages, `
      + `${String(BROWSER_COLLECT_MAX_ITEMS)} items and ${String(BROWSER_COLLECT_MAX_SECONDS)} seconds; this one asked for more, so it read up to those.` };
  }
  let currentItem: { page: number; item: number } | undefined;
  const seenPages = new Set<string>(), kept = new Map<string, number>();
  const ceiling = options.retainForData ? 4_000_000 : BROWSER_COLLECT_MAX_CHARS;
  const limit = Math.min(options.maxChars ?? ceiling, ceiling);
  const fits = () => JSON.stringify(result).length <= limit - 256;
  const remaining = () => Math.max(0, deadline - now());
  const stop = (reason: string, complete = false, next?: string, recovery?: BrowserCollection['pagination_recovery']) => {
    result.count = result.records.length; result.stop_reason = reason; result.complete = complete;
    result.coverage.complete = result.coverage.loading_pages === 0 && result.coverage.pages_processed > 0
      && (complete || reason === 'max_pages' && result.coverage.pages_processed === spec.max_pages);
    const field = /^(?:missing_field|ambiguous_field|field_truncated):(.+)$/.exec(reason)?.[1];
    if (currentItem) result.coverage.stopped_at = { ...currentItem, ...(field ? { field } : {}) };
    if (reason.startsWith('missing_field:')) {
      result.note = 'Fields are required even with many:true. A missing required field stopped capture. count is returned records after filtering and deduplication; source coverage is partial.';
      if (JSON.stringify(result).length > limit) delete result.note;
    }
    if (next !== undefined) {
      result.next_url = next;
      if (JSON.stringify(result).length > limit) delete result.next_url;
    }
    if (recovery) {
      result.pagination_recovery = recovery;
      if (JSON.stringify(result).length > limit) delete result.pagination_recovery;
    }
    if (result.structural_failure && JSON.stringify(result).length > limit) delete result.structural_failure;
    if (result.field_failure && JSON.stringify(result).length > limit) delete result.field_failure;
    // Coverage and recovery precede potentially long records in agent previews.
    const { records, pages, ...summary } = result;
    return { ...summary, pages, records };
  };
  const structuralStop = (cause: NonNullable<BrowserCollection['structural_failure']>['cause'], page: BrowserCollectPage, item?: number) => {
    const note = cause === 'missing_structure_evidence' || cause === 'missing_scope_evidence'
      ? 'The Bridge did not supply the structural evidence required by the requested positional selectors.'
      : cause === 'whole_page_required'
        ? 'This selector positions whole items or Next and requires whole-page sibling fidelity, which the snapshot does not establish.'
        : cause === 'invalid_root_evidence' ? 'The snapshot does not establish the serialized root\'s original sibling position.'
          : 'A selected item or its containing branch was structurally transformed or omitted.';
    result.structural_failure = { cause, required_for: itemPositions ? 'item_positions' : nextPositions ? 'pagination_positions' : 'field_positions',
      loading: typeof page.loading === 'boolean' ? page.loading : 'unknown', ...(item !== undefined ? { item } : {}),
      ...(page.page.length > 0 && page.page.length <= 512 ? { read_step: { do: 'read', page: page.page } } : {}),
      note: `${note} Document loading and structural fidelity are separate; a wait is not a substitute for structural evidence.` };
    return stop('structural_snapshot_required');
  };
  const recoveryFor = (page: BrowserCollectPage, nodes: OutlineElement[], reason: 'same_page_address' | 'non_link_control'): BrowserCollection['pagination_recovery'] => {
    if (nodes.length !== 1 || !page.page || page.page.length > 512) return;
    const node = nodes[0]!, label = words(attribute(node, 'aria-label') ?? textOf(node));
    if (!label || label.length > 200) return;
    const submissionPossible = node.tag !== 'a' && !(node.tag === 'button' && (attribute(node, 'type') ?? '').toLowerCase() === 'button');
    const selector = spec.next && 'selector' in spec.next ? spec.next.selector : undefined;
    const steps = !submissionPossible && !page.loading && result.pages.length < spec.max_pages && result.scanned < spec.max_items && remaining() > 0 ? [{ do: 'click', page: page.page,
      ...(selector ? { selector } : { text: label, role: node.tag === 'a' ? 'link' : 'button' }) }, { do: 'read' }] : undefined;
    const href = node.tag === 'a' ? attribute(node, 'href') : undefined;
    return { reason, page: page.page, control: { tag: node.tag, label, ...(href && href.length <= 256 ? { href } : {}), submission_possible: submissionPossible },
      read_step: { do: 'read', page: page.page }, ...(steps ? { steps } : {}),
      note: 'This Next control was not followed. Collection follows distinct same-origin page URLs; repeating this collection cannot advance this control. '
        + (steps ? 'An optional ordinary one-click/read plan is recorded for this observed control; it has not executed.'
          : 'A click plan is omitted for a possible form submission, a loading snapshot or an exhausted collection bound.') };
  };
  /** The page's Next links that are not disabled: none when the step names no Next; undefined when too complex to read. */
  const nextOn = (tree: ReturnType<typeof parseInspectHtml>, positions: ReturnType<typeof siblingPositions> | undefined): OutlineElement[] | undefined => {
    if (!spec.next) return [];
    let found: OutlineElement[];
    try {
      found = 'selector' in spec.next ? query(tree, spec.next.selector, true, positions)
        : query(tree, 'a, button', true, positions).filter(node => linkName(node) === words(spec.next && 'text' in spec.next ? spec.next.text : '').toLowerCase());
    } catch { return undefined; }
    return found.filter(node => !disabled(node));
  };
  let origin: string | undefined, expected: string | undefined;
  if (limit < 512) return stop('output_limit');
  for (let iteration = 1; iteration <= spec.max_pages; iteration++) {
    options.assertActive();
    if (remaining() === 0) return stop('max_seconds');
    let page: BrowserCollectPage;
    try { page = await options.read(iteration, remaining()); }
    catch (error) { options.assertActive(); if (remaining() === 0) return stop('max_seconds'); throw error; }
    options.assertActive();
    if (remaining() === 0) return stop('max_seconds');
    // 2026-11-21 (D-402, benchmark task I, live) — a page read while it still loads, showing no Next link: a Next link may not
    //   be drawn yet, which `page_loading` says. So the collect first waits for the page to be ready and reads it again,
    //   within its time, and a page with no Next link is known to have none. Travel's one page of 11 books was collected as
    //   partial in 14 of 57 runs, and the model sometimes collected it again. A page still loading after the wait stops as
    //   before. Positional selectors need whole-page evidence of their own, so their reads are left as they come.
    // ⚠ Only for a collect that follows Next, and at most half its time, keeping the read it has: a collect of a page's own
    //   links (max_pages 1, no Next, 10 s) on a page its ads keep loading spent its whole time waiting and returned no links,
    //   and task M's page loop had none to turn (live, 2026-11-21).
    if (page.loading === true && options.ready !== undefined && !positional && spec.next !== undefined) {
      let shown: OutlineElement[] | undefined;
      try { shown = nextOn(parseInspectHtml(page.html, false), undefined); } catch { shown = undefined; }
      const waitMs = Math.min(BROWSER_COLLECT_READY_WAIT_MS, Math.floor(remaining() / 2));
      if (shown !== undefined && shown.length === 0 && waitMs > 0 && await options.ready(waitMs)) {
        options.assertActive();
        if (remaining() > 0) {
          try { page = await options.read(iteration, remaining(), true); } catch { /* the read before stands */ }
          options.assertActive();
        }
      }
    }
    const address = pageAddress(page.url);
    if (!address || expected !== undefined && address.href !== expected) return stop('unexpected_page');
    origin ??= address.origin;
    if (address.origin !== origin) return stop('different_site');
    if (seenPages.has(address.href)) return stop('repeated_page');
    if (page.truncated) return stop('page_truncated');
    seenPages.add(address.href);
    const scoped = positional && page.structure_complete === false && page.structure_scoped === true && !outerPositions;
    if (positional && page.structure_complete !== true && !scoped) return structuralStop(page.structure_complete === undefined
      ? 'missing_structure_evidence' : page.structure_scoped === true && outerPositions ? 'whole_page_required' : 'missing_scope_evidence', page);
    const tree = parseInspectHtml(page.html, positional);
    const positions = positional ? siblingPositions(tree) : undefined;
    let scopes: ReturnType<typeof incompleteScopes> | undefined;
    if (positions) {
      const elements = tree.children.filter((child): child is OutlineElement => child.kind === 'element');
      const parts = page.structure_root?.split(',').map(Number);
      if (elements.length !== 1 || !parts || parts.length !== 4
        || parts.some(n => !Number.isSafeInteger(n) || n < 1)
        || parts[0]! > parts[1]! || parts[2]! > parts[3]! || parts[3]! > parts[1]! || parts[2]! > parts[0]!) return structuralStop('invalid_root_evidence', page);
      positions.set(elements[0]!, [parts[0]!, parts[1]!, parts[2]!, parts[3]!]);
      try { scopes = incompleteScopes(tree); } catch { return stop('page_too_complex'); }
      // An incomplete legacy/unknown read cannot opt in without identifying
      // where fidelity was lost. Never infer positive scope from absent data.
      if (scoped && !scopes.marked) return structuralStop('missing_scope_evidence', page);
    }
    let items: OutlineElement[];
    try { items = query(tree, spec.items, false, positions); } catch { return stop('page_too_complex'); }
    if (items.length === 0) return stop('items_not_found');
    const incompleteItem = scopes ? items.findIndex(item => scopes!.unsafe.has(item)) : -1;
    if (incompleteItem >= 0) return structuralStop('target_subtree_incomplete', page, incompleteItem + 1);
    result.pages.push({ page: page.page, url: address.href, title: page.title.slice(0, 200), items: items.length });
    if (!fits()) { result.pages.pop(); return stop('output_limit'); }
    if (page.loading) result.coverage.loading_pages++;
    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      currentItem = { page: iteration, item: itemIndex + 1 };
      options.assertActive();
      if (remaining() === 0) return stop('max_seconds');
      if (result.scanned >= spec.max_items) return stop('max_items');
      const item = items[itemIndex]!, values: Values = {};
      result.scanned++;
      for (const [name, field] of Object.entries(spec.fields)) {
        let nodes: OutlineElement[];
        try { nodes = query(item, field.selector, false, positions); } catch { return stop('page_too_complex'); }
        const fieldStop = (cause: 'missing_field' | 'ambiguous_field' | 'field_truncated', empty = 0) => {
          result.field_failure = { field: name, ...(field.selector.length <= 128 ? { selector: field.selector } : {}),
            many: field.many === true, required: field.required !== false, matches: nodes.length, empty_values: empty,
            page: iteration, item: itemIndex + 1,
            ...(result.pages[0]!.url.length <= 2_048 ? { restart_url: result.pages[0]!.url } : {}),
            ...(page.page.length > 0 && page.page.length <= 512 ? { read_step: { do: 'read', page: page.page, form: 'outline' } } : {}),
            note: cause === 'missing_field' ? 'The declared required field has no captured value. Returned records and coverage are partial; field settings, match count and source locations are recorded.'
              : 'The declared field could not be captured unambiguously and completely. Returned records and coverage are partial; field settings, match count and source locations are recorded.' };
          return stop(`${cause}:${name}`);
        };
        if (!field.many && nodes.length > 1) return fieldStop('ambiguous_field');
        const extracted = nodes.map(node => field.attribute !== undefined ? attribute(node, field.attribute) ?? '' : textOf(node));
        if (field.required !== false && (extracted.length === 0 || extracted.some(value => value === ''))) return fieldStop('missing_field', extracted.filter(value => value === '').length);
        if (extracted.some(value => value.length > BROWSER_COLLECT_VALUE_CHARS || value.endsWith('…'))) return fieldStop('field_truncated');
        values[name] = field.many ? extracted : extracted[0] ?? null;
      }
      if (spec.where) {
        const value = values[spec.where.field];
        if (!(Array.isArray(value) ? value.includes(spec.where.equals) : value === spec.where.equals)) {
          result.coverage.items_processed++; continue;
        }
      }
      const key = JSON.stringify(spec.dedupe_by ? spec.dedupe_by.map(name => values[name]) : values);
      const previous = kept.get(key), source = { page: iteration, item: itemIndex + 1 };
      if (previous !== undefined) {
        const row = result.records[previous]!;
        if (JSON.stringify(row.values) !== JSON.stringify(values)) return stop('conflicting_duplicate');
        row.sources.push(source);
        if (!fits()) { row.sources.pop(); return stop('output_limit'); }
        result.duplicates++; result.coverage.items_processed++; continue;
      }
      result.records.push({ values, sources: [source] });
      if (!fits()) { result.records.pop(); return stop('output_limit'); }
      kept.set(key, result.records.length - 1);
      result.coverage.items_processed++;
    }
    currentItem = undefined;
    result.coverage.pages_processed++;
    const next = nextOn(tree, positions);
    if (next === undefined) return stop('page_too_complex');
    if (next.length === 0) return page.loading ? stop('page_loading') : stop(spec.next ? 'next_not_found' : 'single_page', true);
    if (next.some(node => node.tag !== 'a' || !attribute(node, 'href'))) return stop('next_not_a_link', false, undefined, recoveryFor(page, next, 'non_link_control'));
    const urls = next.map(node => pageAddress(attribute(node, 'href')!, address.href));
    if (urls.some(url => !url)) return stop('invalid_next_address');
    const addresses = [...new Set(urls.map(url => url!.href))];
    if (addresses.length !== 1) return stop('ambiguous_next');
    const nextUrl = urls[0]!;
    if (nextUrl.origin !== origin) return stop('different_site');
    if (seenPages.has(nextUrl.href)) return stop('repeated_page', false, undefined,
      nextUrl.href === address.href ? recoveryFor(page, next, 'same_page_address') : undefined);
    if (iteration === spec.max_pages) return stop('max_pages', false, nextUrl.href);
    if (result.scanned >= spec.max_items) return stop('max_items', false, nextUrl.href);
    if (remaining() === 0) return stop('max_seconds');
    options.assertActive();
    let moved: { page?: string; url?: string };
    try { moved = await options.navigate(nextUrl.href, iteration, remaining()); }
    catch (error) { options.assertActive(); if (remaining() === 0) return stop('max_seconds'); throw error; }
    if (!moved.page || !moved.url || pageAddress(moved.url)?.href !== nextUrl.href) return stop('unexpected_page');
    expected = nextUrl.href;
  }
  return stop('max_pages');
};
