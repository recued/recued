/** D-335 slice H — one table on a page as rows of text: `core.dom.table`, for an
 *  AI that needs a page's figures without reading the HTML around them.
 *
 *  The rules are `inspectPage`'s: only what a person can see is read (a hidden
 *  or `aria-hidden` element is where injected text hides), and a password,
 *  hidden, sign-in code or card field's value is left out. ⛔ The older
 *  `extract_table` broke both, and had no bound. */

import {
  BRIDGE_INSPECT_MAX_CHARS,
  BRIDGE_INSPECT_MAX_VALUE_CHARS,
  BRIDGE_TABLE_MAX_ROWS,
  isBridgeTableSort,
  isPatternWithinGrantedOrigins,
  type BridgeErrorCode,
  type BridgeTableSort,
} from '@recued/contracts';

import type { ActionExecutorOutcome } from '../queue/dispatcher.js';
import { formatPageHandle, PAGE_CHANGED, type PageInspectScope } from './page-inspect.js';

export interface PageTableLimits {
  max_rows: number;
  /** All of the answer's text: column names and cells. */
  max_chars: number;
  max_value_chars: number;
}

export const PAGE_TABLE_LIMITS: PageTableLimits = {
  max_rows: BRIDGE_TABLE_MAX_ROWS,
  max_chars: BRIDGE_INSPECT_MAX_CHARS,
  max_value_chars: BRIDGE_INSPECT_MAX_VALUE_CHARS,
};

export interface PageTableWalk {
  scroll_scope: PageInspectScope;
  enclosing: number;
  advance?: { table_id: number; scroll_id: number; position: number };
}

interface PageTableWindow {
  table_id: number;
  scroll_id: number;
  first: number;
  total: number;
  position: number;
  limit: number;
}

export type PageTableAnswer =
  | { outputs: { url: string; title: string; columns: string[]; rows: string[][]; truncated: boolean;
      sort?: BridgeTableSort; table_window?: PageTableWindow } }
  | { missing: true }
  | { invalid: true }
  | { stale: true }
  | { blocked: true };

/** The table `scope` names, as columns and rows of the text each cell shows.
 *  - The table: the element a ref or selector names when it is one (`<table>`,
 *    or role `table`, `grid` or `treegrid`), else the first shown table inside
 *    it, else the table it is in; with neither, the page's first shown table.
 *  - Columns: the text of the header rows (`<thead>`, or leading rows of header
 *    cells), joined with " / " where there are several; `column N` without.
 *  - A cell spanning columns or rows fills each place it covers, so every row
 *    reads on its own; a hidden row is left out, and so is an empty one.
 *  - A field in a cell shows its value: a checkbox or radio button `true` or
 *    `false`, a list its chosen options.
 *  - At most `max_rows` rows and `max_chars` characters, `truncated` when cut;
 *    one cell at most `max_value_chars`, then an ellipsis.
 *  Injected, so self-contained. */
export const readPageTable = (scope: PageInspectScope, limits: PageTableLimits, expectedUrl?: string,
  walk?: PageTableWalk): PageTableAnswer => {
  // Chrome passes arguments as JSON, so an absent one can arrive as null.
  if (document.documentElement.hasAttribute('data-recued-owner-surface')
    || (expectedUrl != null && location.href !== expectedUrl)) return { blocked: true };

  const TABLES = 'table, [role="table"], [role="grid"], [role="treegrid"]';
  const roleOf = (element: Element) => (element.getAttribute('role') ?? '').trim().split(/\s+/)[0]!;
  const isTable = (element: Element) => (element.localName === 'table'
    ? !['presentation', 'none'].includes(roleOf(element))
    : ['table', 'grid', 'treegrid'].includes(roleOf(element)));
  const shown = (element: Element) => {
    // ARIA exclusion is inherited, including through component hosts and slots.
    for (let at: Element | null = element; at;) {
      if (at.getAttribute('aria-hidden') === 'true') return false;
      at = at.assignedSlot ?? at.parentElement ?? (at.getRootNode() as ShadowRoot).host ?? null;
    }
    return element.checkVisibility({ checkVisibilityCSS: true })
      || getComputedStyle(element).display === 'contents';
  };
  const firstShownTable = (within: ParentNode) =>
    [...within.querySelectorAll(TABLES)].find(element => isTable(element) && shown(element)) ?? null;

  let named: Element | null = null;
  if (scope.ref != null) {
    const marked = (globalThis as typeof globalThis & { recuedPageRefs?: { byRef: Map<string, Element> } }).recuedPageRefs;
    named = marked?.byRef.get(scope.ref) ?? null;
    if (!named?.isConnected) return { stale: true };
  } else if (scope.selector != null) {
    try {
      named = document.querySelector(scope.selector);
    } catch {
      return { invalid: true };
    }
    if (!named) return { missing: true };
  }
  const table = named === null ? firstShownTable(document)
    : isTable(named) ? named : firstShownTable(named) ?? named.closest(TABLES);
  if (!table || !shown(table)) return { missing: true };

  const SKIPPED = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'frame', 'object', 'embed', 'svg']);
  const PROTECTED = /(^|\s)(current-password|new-password|one-time-code|cc-\S+)(\s|$)/i;
  const isProtected = (element: Element) => {
    const type = element.localName === 'input' ? (element as HTMLInputElement).type : '';
    return type === 'password' || type === 'hidden' || PROTECTED.test(element.getAttribute('autocomplete') ?? '');
  };
  const fieldText = (element: Element): string => {
    if (isProtected(element)) return '';
    if (element.localName === 'select') {
      return [...(element as HTMLSelectElement).selectedOptions].map(option => option.text.trim()).join(', ');
    }
    const field = element as HTMLInputElement;
    if (element.localName === 'input' && (field.type === 'checkbox' || field.type === 'radio')) return String(field.checked);
    if (element.localName === 'input' && ['button', 'submit', 'reset', 'image', 'file'].includes(field.type)) {
      return field.type === 'file' ? '' : field.value;
    }
    return field.value ?? '';
  };

  // The injected reader follows what a component renders, like inspectPage.
  const shadowOf = (element: Element): ShadowRoot | null => {
    try {
      const dom = (globalThis as typeof globalThis & {
        chrome?: { dom?: { openOrClosedShadowRoot?: (host: Element) => ShadowRoot | null | undefined } } }).chrome?.dom;
      return dom?.openOrClosedShadowRoot?.(element) ?? element.shadowRoot;
    } catch {
      return element.shadowRoot;
    }
  };
  const childrenOf = (element: Element): Iterable<Node> => {
    if (element.localName === 'slot') {
      // Walk each slot in turn so its own visibility applies to its contents.
      const assigned = (element as HTMLSlotElement).assignedNodes();
      return assigned.length ? assigned : element.childNodes;
    }
    return (shadowOf(element) ?? element).childNodes;
  };

  // Chrome serializes this reader without its module scope. Keep the CSSOM string decoder local.
  const generatedText = (element: Element, pseudo: '::before' | '::after'): string => {
    const view = element.ownerDocument?.defaultView;
    const style = view?.getComputedStyle(element, pseudo) ?? getComputedStyle(element, pseudo);
    const content = style.content;
    if (!content?.startsWith('"') || style.display === 'none' || style.visibility !== 'visible'
      || style.opacity === '0' || style.contentVisibility === 'hidden' || style.fontSize === '0px') return '';
    if (!element.checkVisibility({ checkOpacity: true })
      && (view?.getComputedStyle(element) ?? getComputedStyle(element)).display !== 'contents') return '';

    // CSSOM serializes visible strings before any accessibility alternative after "/".
    let text = '';
    let end = 0;
    for (const match of content.matchAll(/ *"((?:[^"\\]|\\.)*)"/gy)) {
      text += match[1]!.replace(/\\(?:([\da-f]{1,6}) ?|(.))/gi,
        (_, hex: string | undefined, escaped: string) => hex === undefined ? escaped : String.fromCodePoint(parseInt(hex, 16)));
      end = match.index + match[0].length;
    }
    if (end !== content.length && !content.startsWith(' / ', end)) return '';
    return text && !style.display.startsWith('inline') && style.display !== 'contents' ? ' ' + text + ' ' : text;
  };

  // The text a person sees in a node: a hidden element adds nothing, a field
  // its value, a picture its alt text, and a box that is not inline a space.
  const textOf = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const element = node as Element;
    const tag = element.localName;
    if (SKIPPED.has(tag) || !shown(element)) return '';
    if (tag === 'br') return ' ';
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return ` ${fieldText(element)} `;
    if (tag === 'img') return ` ${element.getAttribute('alt') ?? ''} `;
    let text = generatedText(element, '::before');
    for (const child of childrenOf(element)) text += textOf(child);
    text += generatedText(element, '::after');
    return getComputedStyle(element).display.startsWith('inline') ? text : ` ${text} `;
  };
  const cut = (text: string) => text.length > limits.max_value_chars ? `${text.slice(0, limits.max_value_chars)}…` : text;
  const cellText = (cell: Element) => cut(textOf(cell).replace(/\s+/g, ' ').trim());

  // The table's own rows and cells, never a nested table's.
  const rowsOf = (): Element[] => (table.localName === 'table'
    ? [...(table as HTMLTableElement).rows]
    : [...table.querySelectorAll('[role="row"]')].filter(row => row.closest(TABLES) === table));
  const cellsOf = (row: Element): Element[] => (row.localName === 'tr'
    ? [...(row as HTMLTableRowElement).cells]
    : [...row.querySelectorAll('[role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]')]
      .filter(cell => cell.closest('[role="row"]') === row));
  const isHeaderCell = (cell: Element) => cell.localName === 'th' || roleOf(cell) === 'columnheader';
  const span = (cell: Element, name: 'colspan' | 'rowspan', most: number) => {
    const value = Number(cell.getAttribute(name) ?? cell.getAttribute(`aria-${name}`) ?? 1);
    return Number.isInteger(value) && value >= 1 ? Math.min(value, most) : 1;
  };

  // Lay rows out on a grid: a cell spanning rows carries into the rows below.
  const carried: Array<{ text: string; rows: number } | undefined> = [];
  const sortHeaders: BridgeTableSort[] = [];
  const layout = (cells: Element[]): string[] => {
    const out: string[] = [];
    let column = 0;
    const fillCarried = () => {
      while (carried[column] !== undefined && carried[column]!.rows > 0) {
        out[column] = carried[column]!.text;
        carried[column]!.rows--;
        column++;
      }
    };
    for (const cell of cells) {
      fillCarried();
      const text = cellText(cell);
      const direction = cell.getAttribute('aria-sort')?.trim().toLowerCase();
      if (sortHeaders.length < 2 && (direction === 'ascending' || direction === 'descending' || direction === 'other')
        && (isHeaderCell(cell) || roleOf(cell) === 'rowheader') && shown(cell)) {
        const header = text || cut(cell.getAttribute('aria-label')?.trim() ?? '');
        sortHeaders.push({ header, direction });
      }
      const across = span(cell, 'colspan', 100);
      const down = span(cell, 'rowspan', limits.max_rows);
      for (let i = 0; i < across; i++) {
        out[column] = text;
        carried[column] = down > 1 ? { text, rows: down - 1 } : undefined;
        column++;
      }
    }
    fillCarried();
    return Array.from({ length: out.length }, (_, i) => out[i] ?? '');
  };

  const rows = rowsOf().filter(shown);
  const headerRows: string[][] = [];
  let first = 0;
  for (const row of rows) {
    const cells = cellsOf(row);
    const inHead = row.parentElement?.localName === 'thead';
    if (cells.length === 0 || !(inHead || cells.every(isHeaderCell))) break;
    headerRows.push(layout(cells));
    first++;
  }

  let length = 0;
  let truncated = false;
  const body: string[][] = [];
  const bodyNodes: Element[] = [];
  for (const row of rows.slice(first)) {
    const cells = layout(cellsOf(row));
    if (cells.every(text => text === '')) continue;
    const size = cells.reduce((sum, text) => sum + text.length, 0);
    if (body.length >= limits.max_rows || length + size > limits.max_chars) {
      truncated = true;
      break;
    }
    body.push(cells);
    if (walk) bodyNodes.push(row);
    length += size;
  }

  const width = Math.max(0, ...headerRows.map(row => row.length), ...body.map(row => row.length));
  const labels = Array.from({ length: width }, (_, i) => {
    const names: string[] = [];
    for (const row of headerRows) {
      const name = row[i] ?? '';
      if (name !== '' && !names.includes(name)) names.push(name);
    }
    return names.length > 0 ? names.join(' / ') : `column ${i + 1}`;
  });
  // Headers (including joined names and generated ones) share the cells'
  // budget. Keep complete labels as a prefix, then whole rows within those
  // columns, so a cut never shifts a value under another column's name.
  let chars = 0;
  const columns: string[] = [];
  for (const label of labels) {
    if (chars + label.length > limits.max_chars) {
      truncated = true;
      break;
    }
    columns.push(label);
    chars += label.length;
  }
  const keptRows: string[][] = [];
  if (columns.length > 0) {
    for (const row of body) {
      const cells = Array.from({ length: columns.length }, (_, i) => row[i] ?? '');
      const size = cells.reduce((sum, value) => sum + value.length, 0);
      if (chars + size > limits.max_chars) {
        truncated = true;
        break;
      }
      keptRows.push(cells);
      chars += size;
    }
  }
  const title = document.title.length > 200 ? `${document.title.slice(0, 200)}…` : document.title;
  const sort = sortHeaders.length === 1 ? sortHeaders[0] : undefined;
  const outputs = { url: location.href, title, columns, rows: keptRows, truncated,
    ...(sort?.header && chars + sort.header.length + sort.direction.length <= limits.max_chars ? { sort } : {}) };
  if (!walk || truncated || !keptRows.length || !table.parentNode)
    return walk?.advance ? { stale: true } : { outputs };

  const headerCount = rows.slice(0, first).every((row, i) => row.getAttribute('aria-rowindex') === String(i + 1)) ? first : 0;
  const indices = bodyNodes.map(row => Number(row.getAttribute('aria-rowindex')));
  const ariaTotal = Number(table.getAttribute('aria-rowcount')) - headerCount;
  let rowStart = indices[0]! - headerCount, total = ariaTotal;
  if (rowStart < 1 || !indices.every((index, i) => index === indices[0]! + i)
    || !Number.isSafeInteger(total) || total < rowStart + indices.length - 1) {
    // A visible range can stand in for row indices on an otherwise ordinary
    // table. Bind it to one table and one unambiguous status in the surface.
    const surface = table.closest('main,[role="main"]') ?? document.body;
    const tables = [...surface.querySelectorAll(TABLES)].filter(element => isTable(element) && shown(element));
    const ranges = tables.length === 1 && tables[0] === table
      ? [...surface.querySelectorAll('[role="status"]')].filter(shown).flatMap(element => {
        const match = /^showing\s+(?:rows\s+)?(\d+)\s*[-–—]\s*(\d+)\s+of\s+(\d+)\b/i.exec(element.textContent?.trim().slice(0, 140) ?? '');
        return match ? [match.slice(1).map(Number)] : [];
      }) : [];
    const range = ranges.length === 1 ? ranges[0] : undefined;
    if (!range || range[1]! - range[0]! + 1 !== keptRows.length)
      return walk.advance ? { stale: true } : { outputs };
    rowStart = range[0]!;
    total = range[2]!;
  }
  if (!Number.isSafeInteger(rowStart) || rowStart < 1 || !Number.isSafeInteger(total) || total > limits.max_rows
    || rowStart + keptRows.length - 1 > total) return walk.advance ? { stale: true } : { outputs };

  const parent = (node: Element): Element | null =>
    node.assignedSlot ?? node.parentElement ?? (node.getRootNode() as ShadowRoot).host ?? null;
  const scrolls = (node: Element): boolean => node.clientHeight > 0 && node.scrollHeight > node.clientHeight + 1
    && (node === document.scrollingElement
      ? !/^(hidden|clip)$/.test(getComputedStyle(node).overflowY)
      : /^(auto|scroll|overlay)$/.test(getComputedStyle(node).overflowY));
  let explicit: Element | null = null;
  const target = walk.scroll_scope;
  if (target.ref) {
    const marked = (globalThis as typeof globalThis & { recuedPageRefs?: { byRef: Map<string, Element> } }).recuedPageRefs;
    explicit = marked?.byRef.get(target.ref) ?? null;
  } else if (target.selector) {
    try { explicit = document.querySelector(target.selector); } catch { return { invalid: true }; }
  }
  if ((target.ref || target.selector) && !explicit?.isConnected) return { stale: true };
  const candidates: Element[] = [];
  for (let node: Element | null = table; node; node = parent(node)) {
    if (scrolls(node) && (!explicit || explicit === node)) candidates.push(node);
  }
  const panel = candidates[walk.enclosing];
  if (!panel) return walk.advance ? { stale: true } : { outputs };

  // The table's slot survives a window render that replaces its markup.
  // The slot's parent and chosen scroller have live document-local identities.
  type Bindings = { nodes: WeakMap<Node, Map<string, number>>; serial: number };
  const state = globalThis as typeof globalThis & { recuedTableWalk?: Bindings };
  const bindings = state.recuedTableWalk ??= { nodes: new WeakMap(), serial: 0 };
  const id = (node: Node, slot: string): number => {
    let slots = bindings.nodes.get(node);
    if (!slots) bindings.nodes.set(node, slots = new Map());
    let identity = slots.get(slot);
    if (identity === undefined) slots.set(slot, identity = ++bindings.serial);
    return identity;
  };
  const place = Array.from(table.parentNode.children).indexOf(table);
  const tableId = id(table.parentNode, `${table.localName}:${roleOf(table)}:${place}`);
  const scrollId = id(panel, '');
  const position = Math.max(0, panel.scrollTop);
  const limit = panel.scrollHeight - panel.clientHeight;
  if (walk.advance) {
    if (walk.advance.table_id !== tableId || walk.advance.scroll_id !== scrollId
      || Math.abs(walk.advance.position - position) > 1) return { stale: true };
    panel.scrollTo({ top: Math.min(limit, position + Math.max(1, Math.floor(panel.clientHeight * 0.875))), behavior: 'instant' });
  }
  return {
    outputs: { ...outputs, table_window: { table_id: tableId, scroll_id: scrollId, first: rowStart, total, position, limit } },
  };
};

/** `readPageTable`'s answer from one document: exactly one known key, and
 *  outputs of exactly the types it writes, or it proves nothing. On the
 *  ordinary path a document that moved off the command's grant is not answered. */
export const tableOutcome = (
  answer: unknown,
  document: { tab_id: number; document_id: string },
  options: { pattern?: string; window?: boolean; sort?: boolean },
): ActionExecutorOutcome => {
  const error = (code: BridgeErrorCode, message: string): ActionExecutorOutcome =>
    ({ status: 'error', error: { code, message } });
  const unproven = error('unknown', 'bridge: no readable answer from the page');
  if (!answer || typeof answer !== 'object' || Array.isArray(answer) || Object.keys(answer).length !== 1) return unproven;
  const reply = answer as Record<string, unknown>;
  if (reply.blocked === true) return error('tab_navigation_blocked', 'The owner client cannot be automated.');
  if (reply.missing === true) return error('selector_not_found', 'No table on the page matches.');
  if (reply.invalid === true) return error('selector_not_found', 'The selector is not valid CSS.');
  if (reply.stale === true) return error('selector_not_found', PAGE_CHANGED);
  const outputs = reply.outputs as Record<string, unknown> | undefined;
  const texts = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string');
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)
    || Object.keys(outputs).filter(key => key !== 'sort' && !(options.window && key === 'table_window')).sort().join() !== 'columns,rows,title,truncated,url'
    || Object.hasOwn(outputs, 'sort') && !isBridgeTableSort(outputs.sort)
    || typeof outputs.url !== 'string' || typeof outputs.title !== 'string' || typeof outputs.truncated !== 'boolean'
    || !texts(outputs.columns) || !Array.isArray(outputs.rows) || !outputs.rows.every(texts)) return unproven;
  if (options.pattern !== undefined && !isPatternWithinGrantedOrigins(outputs.url as string, [options.pattern])) {
    return error('tab_navigation_blocked', 'The page is no longer on a site this step may read.');
  }
  const { sort, ...values } = outputs;
  return { status: 'ok', outputs: { page: formatPageHandle(document), ...values, ...(options.sort && sort ? { sort } : {}) } };
};
