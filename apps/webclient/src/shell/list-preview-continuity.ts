/**
 * Shared list -> preview -> detail behavior and document-local list continuity.
 *
 * The continuity map deliberately lives only for the lifetime of this browser
 * document. It survives shell route remounts (Back/Forward) without creating a
 * second durable state store or putting private filter text in the URL.
 */

export interface ListScrollPosition {
  readonly top: number;
  readonly left: number;
}

export interface ListContinuitySnapshot<Filter = unknown> {
  readonly filter?: Filter;
  readonly page?: number;
  readonly focusedId?: string;
  readonly focusKind?: string;
  readonly scroll?: ListScrollPosition;
}

const continuityByDocument = new WeakMap<
  Document,
  Map<string, ListContinuitySnapshot<unknown>>
>();

const copySnapshot = <Filter>(
  snapshot: ListContinuitySnapshot<Filter>,
): ListContinuitySnapshot<Filter> => ({
  ...snapshot,
  ...(snapshot.scroll === undefined
    ? {}
    : { scroll: { top: snapshot.scroll.top, left: snapshot.scroll.left } }),
});

export const readListContinuity = <Filter>(
  document: Document,
  key: string,
): ListContinuitySnapshot<Filter> | null => {
  const found = continuityByDocument.get(document)?.get(key);
  return found === undefined
    ? null
    : copySnapshot(found as ListContinuitySnapshot<Filter>);
};

/** Merge one owner-specific patch. This lets a list model own `filter` while
 * its composition surface independently owns focus + scroll. */
export const updateListContinuity = <Filter>(
  document: Document,
  key: string,
  patch: ListContinuitySnapshot<Filter>,
): ListContinuitySnapshot<Filter> => {
  let entries = continuityByDocument.get(document);
  if (entries === undefined) {
    entries = new Map();
    continuityByDocument.set(document, entries);
  }
  const previous = entries.get(key) as ListContinuitySnapshot<Filter> | undefined;
  const next = copySnapshot({ ...previous, ...patch });
  entries.set(key, next as ListContinuitySnapshot<unknown>);
  return copySnapshot(next);
};

export const forgetListContinuity = (document: Document, key: string): void => {
  continuityByDocument.get(document)?.delete(key);
};

export const readListScroll = (root: HTMLElement): ListScrollPosition => {
  try {
    return {
      top: Number.isFinite(root.scrollTop) ? root.scrollTop : 0,
      left: Number.isFinite(root.scrollLeft) ? root.scrollLeft : 0,
    };
  } catch {
    return { top: 0, left: 0 };
  }
};

export const restoreListScroll = (
  root: HTMLElement,
  position: ListScrollPosition | undefined,
): void => {
  if (position === undefined) return;
  try {
    root.scrollTop = position.top;
    root.scrollLeft = position.left;
  } catch {
    // Reduced DOMs keep restoration best-effort.
  }
};

export const focusListTarget = (target: HTMLElement | null | undefined): boolean => {
  if (target === null || target === undefined || target.hasAttribute?.('disabled')) {
    return false;
  }
  try {
    target.focus?.({ preventScroll: true });
    return true;
  } catch {
    return false;
  }
};

export interface ListPreviewFact {
  readonly label: string;
  readonly value: string;
}

export interface ListPreviewContent {
  readonly id: string;
  readonly eyebrow?: string;
  readonly title: string;
  readonly summary?: string;
  readonly facts?: readonly ListPreviewFact[];
  readonly primaryLabel?: string;
}

export const LIST_PREVIEW_ATTR = 'data-recued-list-preview';
export const LIST_PREVIEW_CLOSE_ATTR = 'data-recued-list-preview-close';
export const LIST_PREVIEW_TITLE_ATTR = 'data-recued-list-preview-title';
export const LIST_PREVIEW_FACTS_ATTR = 'data-recued-list-preview-facts';
export const LIST_PREVIEW_OPEN_ATTR = 'data-recued-list-preview-open';

export interface ListPreviewMount {
  open(content: ListPreviewContent, opener?: HTMLElement | null): void;
  close(): void;
  activeId(): string | null;
  dispose(): void;
}

let previewIdSequence = 0;

export const mountListPreview = (opts: {
  readonly host: HTMLElement;
  readonly document?: Document;
  readonly scrollRoot?: HTMLElement;
  readonly onOpen: (id: string) => void;
}): ListPreviewMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error('mountListPreview: no document available - pass opts.document');
  }

  const sequence = ++previewIdSequence;
  const titleId = `recued-list-preview-title-${sequence}`;
  const summaryId = `recued-list-preview-summary-${sequence}`;
  const root = doc.createElement('aside');
  root.setAttribute(LIST_PREVIEW_ATTR, '');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'false');
  root.setAttribute('aria-labelledby', titleId);
  root.hidden = true;

  const header = doc.createElement('header');
  header.className = 'list-preview-header';
  const heading = doc.createElement('div');
  heading.className = 'list-preview-heading';
  const eyebrow = doc.createElement('span');
  eyebrow.className = 'list-preview-eyebrow';
  const title = doc.createElement('h2');
  title.id = titleId;
  title.setAttribute(LIST_PREVIEW_TITLE_ATTR, '');
  title.className = 'list-preview-title';
  heading.appendChild(eyebrow);
  heading.appendChild(title);
  const close = doc.createElement('button') as HTMLButtonElement;
  close.type = 'button';
  close.setAttribute(LIST_PREVIEW_CLOSE_ATTR, '');
  close.className = 'list-preview-close';
  close.setAttribute('aria-label', 'Close preview');
  close.textContent = 'Close';
  header.appendChild(heading);
  header.appendChild(close);

  const summary = doc.createElement('p');
  summary.id = summaryId;
  summary.className = 'list-preview-summary';
  const facts = doc.createElement('dl');
  facts.setAttribute(LIST_PREVIEW_FACTS_ATTR, '');
  facts.className = 'list-preview-facts';
  const footer = doc.createElement('footer');
  footer.className = 'list-preview-footer';
  const open = doc.createElement('button') as HTMLButtonElement;
  open.type = 'button';
  open.setAttribute(LIST_PREVIEW_OPEN_ATTR, '');
  open.className = 'list-preview-open';
  footer.appendChild(open);

  root.appendChild(header);
  root.appendChild(summary);
  root.appendChild(facts);
  root.appendChild(footer);
  opts.host.appendChild(root);

  let active: ListPreviewContent | null = null;
  let returnTarget: HTMLElement | null = null;
  let returnScroll: ListScrollPosition | undefined;
  let disposed = false;

  const clearFacts = (): void => {
    while (facts.firstChild != null) facts.removeChild(facts.firstChild);
  };

  const dismiss = (restore: boolean): void => {
    if (active === null) return;
    active = null;
    root.hidden = true;
    root.removeAttribute?.('data-id');
    if (!restore) return;
    restoreListScroll(opts.scrollRoot ?? opts.host, returnScroll);
    focusListTarget(returnTarget);
    returnTarget = null;
    returnScroll = undefined;
  };

  close.addEventListener('click', () => dismiss(true));
  open.addEventListener('click', () => {
    const id = active?.id;
    if (id === undefined) return;
    dismiss(false);
    opts.onOpen(id);
  });
  const onKeyDown = (event: Event): void => {
    if ((event as KeyboardEvent).key !== 'Escape' || active === null) return;
    (event as KeyboardEvent).preventDefault();
    dismiss(true);
  };
  const eventDocument = doc as unknown as {
    addEventListener?: (type: string, listener: (event: Event) => void) => void;
    removeEventListener?: (type: string, listener: (event: Event) => void) => void;
  };
  eventDocument.addEventListener?.('keydown', onKeyDown);

  return {
    open: (content, opener = null) => {
      if (disposed) return;
      active = content;
      returnTarget = opener;
      returnScroll = readListScroll(opts.scrollRoot ?? opts.host);
      root.setAttribute('data-id', content.id);
      eyebrow.textContent = content.eyebrow ?? 'Preview';
      eyebrow.hidden = content.eyebrow === '';
      title.textContent = content.title;
      summary.textContent = content.summary ?? '';
      summary.hidden = content.summary === undefined || content.summary === '';
      if (summary.hidden) root.removeAttribute('aria-describedby');
      else root.setAttribute('aria-describedby', summaryId);
      clearFacts();
      for (const fact of content.facts ?? []) {
        const term = doc.createElement('dt');
        term.textContent = fact.label;
        const value = doc.createElement('dd');
        value.textContent = fact.value;
        facts.appendChild(term);
        facts.appendChild(value);
      }
      facts.hidden = (content.facts?.length ?? 0) === 0;
      open.textContent = content.primaryLabel ?? 'Open details';
      root.hidden = false;
      focusListTarget(close);
    },
    close: () => dismiss(true),
    activeId: () => active?.id ?? null,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      active = null;
      eventDocument.removeEventListener?.('keydown', onKeyDown);
      root.remove();
    },
  };
};

export const LIST_PREVIEW_STYLES = `
[${LIST_PREVIEW_ATTR}] {
  position: fixed; z-index: 64; inset: var(--wc-header-height, 56px) 0 0 auto;
  box-sizing: border-box; display: grid; grid-template-rows: auto auto 1fr auto;
  gap: 18px; width: min(420px, calc(100vw - 28px)); max-height: calc(100vh - var(--wc-header-height, 56px));
  padding: 22px; overflow: auto; overscroll-behavior: contain;
  color: var(--fg); background: var(--surface); border-left: 1px solid var(--border);
  box-shadow: -18px 0 44px rgba(24,24,27,.12);
}
[${LIST_PREVIEW_ATTR}][hidden] { display: none; }
[${LIST_PREVIEW_ATTR}] .list-preview-header {
  display: flex; align-items: start; justify-content: space-between; gap: 16px;
}
[${LIST_PREVIEW_ATTR}] .list-preview-heading { display: grid; gap: 4px; min-width: 0; }
[${LIST_PREVIEW_ATTR}] .list-preview-eyebrow {
  color: var(--fg-subtle); font-size: 11px; font-weight: 700;
  letter-spacing: .06em; text-transform: uppercase;
}
[${LIST_PREVIEW_ATTR}] .list-preview-title {
  margin: 0; color: var(--fg); font-size: 20px; line-height: 1.25;
  letter-spacing: -.02em; overflow-wrap: anywhere;
}
[${LIST_PREVIEW_ATTR}] .list-preview-close {
  min-height: 36px; padding: 6px 10px; border: 1px solid var(--border);
  border-radius: var(--wc-radius, 6px); color: var(--fg-muted);
  background: transparent; font: inherit; font-size: 12px; cursor: pointer;
}
[${LIST_PREVIEW_ATTR}] .list-preview-summary {
  margin: 0; color: var(--fg-muted); font-size: 14px; line-height: 1.55;
  overflow-wrap: anywhere;
}
[${LIST_PREVIEW_ATTR}] .list-preview-facts {
  display: grid; grid-template-columns: minmax(90px, auto) minmax(0, 1fr);
  align-content: start; gap: 9px 14px; margin: 0;
}
[${LIST_PREVIEW_ATTR}] .list-preview-facts dt {
  color: var(--fg-subtle); font-size: 12px; font-weight: 650;
}
[${LIST_PREVIEW_ATTR}] .list-preview-facts dd {
  min-width: 0; margin: 0; color: var(--fg); font-size: 13px; overflow-wrap: anywhere;
}
[${LIST_PREVIEW_ATTR}] .list-preview-footer {
  position: sticky; bottom: -22px; display: flex; justify-content: flex-end;
  margin: auto -22px -22px; padding: 14px 22px 22px;
  background: linear-gradient(to bottom, transparent, var(--surface) 18px);
}
[${LIST_PREVIEW_ATTR}] .list-preview-open {
  min-height: 40px; padding: 8px 14px; border: 1px solid var(--accent);
  border-radius: var(--wc-radius, 6px); color: var(--on-accent);
  background: var(--accent); font: inherit; font-size: 13px; font-weight: 700;
  cursor: pointer;
}
[${LIST_PREVIEW_ATTR}] :is(button):focus-visible {
  outline: none; box-shadow: 0 0 0 3px var(--accent-weak);
}
@media (max-width: 560px) {
  [${LIST_PREVIEW_ATTR}] {
    inset: auto 0 0; width: 100%; max-height: min(72vh, 640px);
    border-top: 1px solid var(--border); border-left: 0;
    box-shadow: 0 -18px 44px rgba(24,24,27,.14);
  }
  [${LIST_PREVIEW_ATTR}] .list-preview-close,
  [${LIST_PREVIEW_ATTR}] .list-preview-open { min-height: 44px; }
}
`;
