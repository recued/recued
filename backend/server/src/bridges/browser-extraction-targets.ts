import type { BrowserExtractionTargets } from '@recued/contracts';
import { parseInspectHtml, type OutlineElement } from './page-outline.js';
import { browserCollectHint } from './browser-collect.js';
import { browserTableHeaders } from './browser-table-headers.js';

/** Reuses the captured source. Frames and structural placeholders never become page-level CSS
 * targets. A selector is an observed first-match locator, not a guessed positional path. */
export const browserExtractionTargets = (html: string, input: {
  url: string; whole: boolean; complete: boolean; target?: { ref?: string; selector?: string };
  collection?: ReturnType<typeof browserCollectHint>;
}): BrowserExtractionTargets => {
  const root = parseInspectHtml(html);
  const pending = [root];
  const tables: OutlineElement[] = [], ids = new Map<string, number>();
  const files: NonNullable<BrowserExtractionTargets['files']> = [];
  let visited = 0, complete = true;
  while (pending.length) {
    const node = pending.pop()!;
    if (++visited > 5_000) { complete = false; break; }
    if (['iframe', 'frame'].includes(node.tag)) { complete = false; continue; }
    const id = node.attrs.id;
    if (typeof id === 'string') ids.set(id, (ids.get(id) ?? 0) + 1);
    if (node.structuralOnly) continue;
    if (node.tag === 'a' && typeof node.attrs.ref === 'string' && /^e[1-9]\d{0,8}$/.test(node.attrs.ref) && typeof node.attrs.href === 'string') {
      try {
        const address = new URL(node.attrs.href, input.url);
        if (['http:', 'https:'].includes(address.protocol) && !address.username && !address.password
          && (Object.hasOwn(node.attrs, 'data-recued-download') || /\.(?:zip|pdf|csv|xlsx?|docx?|pptx?|tar|gz|tgz|exe|msi|dmg|pkg|deb|rpm|apk|json|txt)$/i.test(address.pathname))) {
          const parts: string[] = [], children = [...node.children].reverse();
          while (children.length) { const child = children.pop()!; if (child.kind === 'text') parts.push(child.text);
            else if (!child.structuralOnly && !['input', 'textarea', 'select', 'iframe', 'frame'].includes(child.tag)) children.push(...[...child.children].reverse()); }
          const label = (typeof node.attrs['aria-label'] === 'string' ? node.attrs['aria-label'] : parts.join('')).replace(/\s+/g, ' ').trim();
          files.push({ step: { do: 'download', ref: node.attrs.ref }, ...(label ? { label: label.slice(0, 80), ...(label.length > 80 ? { label_truncated: true as const } : {}) } : {}) });
        }
      } catch { /* Invalid or active-scheme links never acquire a save example. */ }
    }
    const role = typeof node.attrs.role === 'string' ? node.attrs.role.trim().split(/\s+/)[0] : '';
    if (node.tag === 'table' ? !['presentation', 'none'].includes(role ?? '') : ['table', 'grid', 'treegrid'].includes(role ?? '')) tables.push(node);
    pending.push(...node.children.filter((child): child is OutlineElement => child.kind === 'element').reverse());
  }
  const out: BrowserExtractionTargets = { source: 'captured_dom', scope: input.whole ? 'page' : 'element', source_complete: input.complete,
    tables_complete: input.complete && complete && tables.length <= 3,
    tables: tables.slice(0, 3).map((node, index) => {
      const id = typeof node.attrs.id === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(node.attrs.id) && ids.get(node.attrs.id) === 1 ? node.attrs.id : undefined;
      const ref = typeof node.attrs.ref === 'string' && /^e[1-9]\d{0,8}$/.test(node.attrs.ref) ? node.attrs.ref : undefined;
      const label = typeof node.attrs['aria-label'] === 'string' ? node.attrs['aria-label'].trim() : '';
      // The existing table reader's descendant/default query matches exact role
      // attributes. A fallback role list still needs its own observed locator.
      const defaultMatches = node.tag === 'table' || ['table', 'grid', 'treegrid'].includes(String(node.attrs.role));
      const target = ref ? { ref } : !input.whole ? index === 0 && defaultMatches ? input.target : undefined
        : id ? { selector: `#${id}` } : index === 0 && defaultMatches ? {} : undefined;
      return { ...(target ? { step: { do: 'table' as const, ...target } } : {}), ...browserTableHeaders(node, input.complete),
        ...(label ? { label: label.slice(0, 80), ...(label.length > 80 ? { label_truncated: true as const } : {}) } : {}) };
    }) };
  if (files.length) out.files = files.slice(0, 3);
  if (files.length > 3) out.files_truncated = true;
  const hint = input.collection;
  if (hint) out.collection = { items: hint.step.items, fields: Object.keys(hint.step.fields), rows_in_snapshot: hint.rows_in_snapshot };
  for (const table of [...out.tables].reverse()) {
    while (JSON.stringify(out).length > 2_000 && table.columns?.length) { table.columns.pop(); table.columns_complete = false; }
    while (JSON.stringify(out).length > 2_000 && table.headers?.length) table.headers.pop();
  }
  while (JSON.stringify(out).length > 2_000 && out.files?.length) { out.files.pop(); out.files_truncated = true; }
  while (JSON.stringify(out).length > 2_000 && out.tables.length) { out.tables.pop(); out.tables_complete = false; }
  if (JSON.stringify(out).length > 2_000) delete out.collection;
  return out;
};
