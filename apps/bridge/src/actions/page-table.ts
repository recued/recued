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
  isPatternWithinGrantedOrigins,
  type BridgeErrorCode,
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

export type PageTableAnswer =
  | { outputs: { url: string; title: string; columns: string[]; rows: string[][]; truncated: boolean } }
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
export const readPageTable = (scope: PageInspectScope, limits: PageTableLimits, expectedUrl?: string): PageTableAnswer => {
  // Chrome passes arguments as JSON, so an absent one can arrive as null.
  if (document.documentElement.hasAttribute('data-recued-owner-surface')
    || (expectedUrl != null && location.href !== expectedUrl)) return { blocked: true };

  const TABLES = 'table, [role="table"], [role="grid"], [role="treegrid"]';
  const roleOf = (element: Element) => (element.getAttribute('role') ?? '').trim().split(/\s+/)[0]!;
  const isTable = (element: Element) => (element.localName === 'table'
    ? !['presentation', 'none'].includes(roleOf(element))
    : ['table', 'grid', 'treegrid'].includes(roleOf(element)));
  const shown = (element: Element) => element.getAttribute('aria-hidden') !== 'true'
    && (element.checkVisibility({ checkVisibilityCSS: true })
      || getComputedStyle(element).display === 'contents');
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
    let text = '';
    for (const child of [...element.childNodes]) text += textOf(child);
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
  for (const row of rows.slice(first)) {
    const cells = layout(cellsOf(row));
    if (cells.every(text => text === '')) continue;
    const size = cells.reduce((sum, text) => sum + text.length, 0);
    if (body.length >= limits.max_rows || length + size > limits.max_chars) {
      truncated = true;
      break;
    }
    body.push(cells);
    length += size;
  }

  const width = Math.max(0, ...headerRows.map(row => row.length), ...body.map(row => row.length));
  const columns = Array.from({ length: width }, (_, i) => {
    const names: string[] = [];
    for (const row of headerRows) {
      const name = row[i] ?? '';
      if (name !== '' && !names.includes(name)) names.push(name);
    }
    return names.length > 0 ? names.join(' / ') : `column ${i + 1}`;
  });
  const title = document.title.length > 200 ? `${document.title.slice(0, 200)}…` : document.title;
  return {
    outputs: {
      url: location.href,
      title,
      columns,
      rows: body.map(row => Array.from({ length: width }, (_, i) => row[i] ?? '')),
      truncated,
    },
  };
};

/** `readPageTable`'s answer from one document: exactly one known key, and
 *  outputs of exactly the types it writes, or it proves nothing. On the
 *  ordinary path a document that moved off the command's grant is not answered. */
export const tableOutcome = (
  answer: unknown,
  document: { tab_id: number; document_id: string },
  options: { pattern?: string },
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
    || Object.keys(outputs).sort().join() !== 'columns,rows,title,truncated,url'
    || typeof outputs.url !== 'string' || typeof outputs.title !== 'string' || typeof outputs.truncated !== 'boolean'
    || !texts(outputs.columns) || !Array.isArray(outputs.rows) || !outputs.rows.every(texts)) return unproven;
  if (options.pattern !== undefined && !isPatternWithinGrantedOrigins(outputs.url as string, [options.pattern])) {
    return error('tab_navigation_blocked', 'The page is no longer on a site this step may read.');
  }
  return { status: 'ok', outputs: { page: formatPageHandle(document), ...outputs } };
};
