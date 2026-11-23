import type { OutlineElement } from './page-outline.js';

const role = (node: OutlineElement) => String(node.attrs.role ?? '').trim().split(/\s+/)[0];
const table = (node: OutlineElement) => node.tag === 'table' || ['table', 'grid', 'treegrid'].includes(role(node) ?? '');
const text = (node: OutlineElement): string => {
  const pending = [...node.children].reverse(), parts: string[] = [];
  while (pending.length) {
    const child = pending.pop()!;
    if (child.kind === 'text') parts.push(child.text);
    else if (child.tag === 'br' || child.tag === 'hr') parts.push(' ');
    else if (!child.structuralOnly && !['iframe', 'frame', 'input', 'select', 'textarea'].includes(child.tag)) pending.push(...[...child.children].reverse());
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
};

/** Summarize only observed headers. The host marker proves span metadata was
 * preserved; older captures supply header texts without claiming alignment. */
export const browserTableHeaders = (root: OutlineElement, sourceComplete: boolean): {
  headers?: string[]; columns?: string[]; columns_complete?: boolean;
} => {
  const rows: Array<{ node: OutlineElement; inHead: boolean }> = [], pending = [{ node: root, inHead: false }];
  let visited = 0, bounded = true;
  while (pending.length) {
    const { node, inHead } = pending.pop()!;
    if (++visited > 5_000) { bounded = false; break; }
    if (node.structuralOnly || node !== root && table(node)) continue;
    if (node.structuralIncomplete || ['iframe', 'frame', 'input', 'select', 'textarea'].includes(node.tag)) bounded = false;
    if (root.tag === 'table' ? node.tag === 'tr' : role(node) === 'row') rows.push({ node, inHead });
    for (const child of [...node.children].reverse()) if (child.kind === 'element') pending.push({ node: child, inHead: inHead || node.tag === 'thead' });
  }
  const headers: string[] = [], layout: string[][] = [], carried: Array<{ value: string; rows: number } | undefined> = [];
  let width = 0, body = false;
  for (const { node, inHead } of rows) {
    const cells: OutlineElement[] = [];
    const nodes = [...node.children].reverse();
    while (nodes.length) {
      const child = nodes.pop()!;
      if (child.kind !== 'element' || child.structuralOnly || table(child) || child.tag === 'tr' || role(child) === 'row') continue;
      if (root.tag === 'table' ? ['td', 'th'].includes(child.tag) : ['columnheader', 'rowheader', 'cell', 'gridcell'].includes(role(child) ?? '')) cells.push(child);
      else nodes.push(...[...child.children].reverse());
    }
    if (!cells.length) continue;
    const header = !body && (inHead || cells.every(cell => cell.tag === 'th' || role(cell) === 'columnheader'));
    if (!header) body = true;
    if (header && layout.length >= 8) bounded = false;
    const row: string[] = [];
    let column = 0;
    const fill = () => { while (carried[column] && carried[column]!.rows > 0) { row[column] = carried[column]!.value; carried[column]!.rows--; column++; } };
    const span = (cell: OutlineElement, name: string, max: number) => {
      const value = Number(cell.attrs[name] ?? cell.attrs['aria-' + name] ?? 1);
      return Number.isInteger(value) && value >= 1 ? Math.min(max, value) : 1;
    };
    for (const cell of cells) {
      fill();
      const value = header ? text(cell) : '';
      if (header) { if (headers.length < 8 && value.length <= 80) headers.push(value); else bounded = false; }
      const across = span(cell, 'colspan', 100), down = span(cell, 'rowspan', 5_000);
      for (let index = 0; index < across; index++) { row[column] = value; carried[column] = down > 1 ? { value, rows: down - 1 } : undefined; column++; }
    }
    fill(); width = Math.max(width, row.length); if (header && layout.length < 8) layout.push(row);
  }
  const aligned = root.attrs['data-recued-table-layout'] === '1';
  const columns: string[] = [];
  if (aligned && layout.length) for (let index = 0; index < width; index++) {
    const names = [...new Set(layout.map(row => row[index] ?? '').filter(Boolean))];
    const name = names.join(' / ') || `column ${index + 1}`;
    if (columns.length === 8 || name.length > 80) { bounded = false; break; }
    columns.push(name);
  }
  if (!headers.length && !columns.length) return {};
  return { ...(headers.length ? { headers } : {}), ...(columns.length ? { columns } : {}),
    columns_complete: aligned && layout.length > 0 && bounded && sourceComplete };
};
