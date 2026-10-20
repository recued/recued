import { authenticationHistorySavedReferences, type AuthenticationHistoryRelatedBundle, type AuthenticationHistorySavedReference } from './authentication-history-related-bundle.js';
import { previewRecordTypes as types } from './authentication-history-preview-fields.js';

export interface AuthenticationHistoryRelatedLink {
  readonly direction: 'references' | 'referenced_by'; readonly reference: AuthenticationHistorySavedReference;
  readonly target?: number; readonly unavailable?: 'outside_snapshot' | 'type_mismatch';
}
const key = (reference: AuthenticationHistorySavedReference): string => JSON.stringify([reference.type, reference.id]);

/** Use exactly the bundle's typed saved-reference rule. Incoming links retain
 * snapshot order; repeated outgoing references produce one link per direction. */
export const createAuthenticationHistoryRelatedLinks = (bundle: AuthenticationHistoryRelatedBundle) => {
  const entries = bundle.report.entries; let links: readonly (readonly AuthenticationHistoryRelatedLink[])[] | undefined;
  return (index: number): readonly AuthenticationHistoryRelatedLink[] => {
    if (!Number.isInteger(index) || !entries[index]) throw new Error('Choose a saved record from this bundle.');
    if (!links) {
      const byId = new Map(entries.map((entry, i) => [entry.record.id, i]));
      const outgoing: AuthenticationHistoryRelatedLink[][] = entries.map(() => []); const incoming: AuthenticationHistoryRelatedLink[][] = entries.map(() => []);
      const missing = new Map(bundle.report.missing_references.map(link => [JSON.stringify([key(link.from), key(link.to)]), link.reason]));
      entries.forEach((entry, from) => {
        const seen = new Set<string>(); const source = Object.freeze({ type: entry.type, id: entry.record.id });
        for (const saved of authenticationHistorySavedReferences(entry)) {
          const id = key(saved); if (seen.has(id)) continue; seen.add(id); const target = byId.get(saved.id);
          const reference = Object.freeze(saved);
          if (target !== undefined && entries[target]!.type === saved.type) {
            outgoing[from]!.push(Object.freeze({ direction: 'references', reference, target }));
            if (target !== from) incoming[target]!.push(Object.freeze({ direction: 'referenced_by', reference: source, target: from }));
          } else {
            const unavailable = missing.get(JSON.stringify([key(source), id])) ?? (target === undefined ? 'outside_snapshot' : 'type_mismatch');
            outgoing[from]!.push(Object.freeze({ direction: 'references', reference, unavailable }));
          }
        }
      });
      links = Object.freeze(entries.map((_, i) => Object.freeze([...outgoing[i]!, ...incoming[i]!])));
    }
    return links[index]!;
  };
};

let linksCounter = 0;
const PAGE_SIZE = 20;
export const createAuthenticationHistoryRelatedLinkList = (deps: {
  document: Document; links: readonly AuthenticationHistoryRelatedLink[]; index: number; summary: HTMLElement;
  context: string; canFollow: boolean; limit: number; interactive(control: HTMLElement): boolean; open(index: number, origin: HTMLButtonElement): void;
}): HTMLElement => {
  const doc = deps.document; const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const element = doc.createElement(tag); if (text !== undefined) element.textContent = text; return element;
  };
  const section = node('section'); section.className = 'authentication-history-related-links'; section.setAttribute('data-history-preview-related-links', 'records');
  section.setAttribute('aria-label', 'Linked saved records in ' + deps.context); section.appendChild(node('h4', `Linked saved records (${deps.links.length})`));
  if (!deps.links.length) { section.appendChild(node('p', 'No saved record links are available here. This does not establish complete history.')); return section; }
  section.appendChild(node('p', 'Links follow saved references in either direction. They do not establish that a repair caused recovery or that current access works.'));
  if (!deps.canFollow) section.appendChild(node('p', `You have ${deps.limit} linked records open. Use Back before following another link.`));
  const items = node('ul'); items.setAttribute('role', 'list'); const range = node('p'); range.id = 'history-related-links-' + ++linksCounter;
  range.setAttribute('role', 'status'); range.setAttribute('tabindex', '-1'); range.setAttribute('data-history-preview-related-link-range', 'records'); let offset = 0;
  const pager = (label: string, name: string, change: number): HTMLButtonElement => {
    let pointerFocus: Element | null | undefined;
    const control = node('button', label); control.type = 'button'; control.setAttribute('data-history-preview-control', name);
    control.setAttribute('aria-label', label + ' in ' + deps.context); control.setAttribute('aria-describedby', range.id);
    control.addEventListener('pointerdown', () => { pointerFocus = deps.interactive(control) ? doc.activeElement : undefined; });
    control.addEventListener('pointercancel', () => { pointerFocus = undefined; });
    control.addEventListener('click', event => {
      const before = event.detail > 0 ? pointerFocus : undefined; pointerFocus = undefined;
      if (!deps.interactive(control) || control.disabled) return;
      offset = Math.max(0, Math.min(offset + change, Math.floor((deps.links.length - 1) / PAGE_SIZE) * PAGE_SIZE)); render(before);
    }); return control;
  };
  const previous = pager('Previous links', 'related-links-previous', -PAGE_SIZE); const next = pager('Next links', 'related-links-next', PAGE_SIZE);
  const render = (pointerFocus?: Element | null): void => {
    const current = doc.activeElement; const before = current === doc.body || current === deps.summary ? pointerFocus ?? current : current;
    const focused = before === previous ? previous : before === next ? next : undefined; const removed = items.contains(before) ? before : undefined;
    while (items.firstChild) items.removeChild(items.firstChild);
    const end = Math.min(offset + PAGE_SIZE, deps.links.length);
    for (const link of deps.links.slice(offset, end)) {
      const item = node('li'); const label = node('p', (link.direction === 'references' ? 'References' : 'Referenced by') + ' · ' + types[link.reference.type] + ' · ');
      label.appendChild(node('code', link.reference.id)); item.appendChild(label);
      if (link.target === undefined) item.appendChild(node('p', link.unavailable === 'type_mismatch'
        ? 'This saved reference has a different record type and cannot be followed.' : 'This referenced record is not included in the bundle. No lookup is made.'));
      else if (link.target === deps.index) item.appendChild(node('p', 'This saved reference points to this record.'));
      else {
        const view = node('button', 'View linked ' + types[link.reference.type].toLowerCase()); view.type = 'button'; view.disabled = !deps.canFollow;
        view.setAttribute('data-history-preview-control', 'related-link'); view.setAttribute('data-history-preview-link-target', key(link.reference));
        view.setAttribute('data-history-preview-link-direction', link.direction);
        view.setAttribute('aria-label', 'View linked ' + types[link.reference.type].toLowerCase() + ' ' + link.reference.id + ' (' + (link.direction === 'references' ? 'references' : 'referenced by') + ') in ' + deps.context);
        view.addEventListener('click', () => { if (deps.interactive(view) && !view.disabled) deps.open(link.target!, view); }); item.appendChild(view);
      }
      items.appendChild(item);
    }
    range.textContent = `Saved links ${offset + 1}–${end} of ${deps.links.length}`; previous.disabled = offset === 0; next.disabled = end >= deps.links.length;
    const fallback = doc.activeElement === doc.body || doc.activeElement === deps.summary;
    if (deps.interactive(range) && (focused?.disabled && (doc.activeElement === focused || fallback) || removed && (doc.activeElement === removed || fallback))) {
      range.focus({ preventScroll: true }); if (deps.interactive(range) && doc.activeElement === range) range.scrollIntoView?.({ block: 'nearest' });
    } else if (focused && deps.interactive(focused) && doc.activeElement !== focused && fallback) focused.focus({ preventScroll: true });
  };
  section.appendChild(range);
  if (deps.links.length > PAGE_SIZE) { const paging = node('div'); paging.className = 'authentication-history-related-paging'; paging.appendChild(previous); paging.appendChild(next); section.appendChild(paging); }
  section.appendChild(items); render(); return section;
};
