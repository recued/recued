import type { AuthenticationHistoryRelatedBundle } from './authentication-history-related-bundle.js';
import { previewRecordTypes as types, previewRecordedOutcomes as outcomes, normalizePreviewSearch, previewSearchText, previewMatches } from './authentication-history-preview-fields.js';
import { createAuthenticationHistoryPreviewFields, type RevealPreviewField } from './authentication-history-preview-fields-browser.js';
import { createAuthenticationHistoryRelatedLinks, createAuthenticationHistoryRelatedLinkList } from './authentication-history-related-links.js';
import { createAuthenticationHistoryRecordActions } from './authentication-history-record-actions.js';
import type { AuthenticationHistoryRecordContext } from './authentication-history-record-context.js';

type Entry = AuthenticationHistoryRelatedBundle['report']['entries'][number];
type RecordFilters = Readonly<{ type: Entry['type'] | ''; outcome: Entry['outcome'] | '' }>;
const matchesFilters = (entry: Entry, filters: RecordFilters): boolean => (!filters.type || entry.type === filters.type) && (!filters.outcome || entry.outcome === filters.outcome);
const PAGE_SIZE = 20;
const SEARCH_LIMIT = 128;
const MAX_LINKED_VIEWS = 20;
// Immutable prepared entries can belong to several open bundles. Keep one
// public search text per entry without retaining a discarded snapshot.
const searchTexts = new WeakMap<Entry, string>();
const searchText = (entry: Entry): string => {
  let text = searchTexts.get(entry);
  if (text === undefined) { text = previewSearchText(entry); searchTexts.set(entry, text); }
  return text;
};
let browserCounter = 0;

/** Browse the exact bundle entries without changing the owner's snapshot,
 * search or record page. The owner guards detached views; both views share
 * the public saved-field trees and matching-field navigation. */
export const createAuthenticationHistoryRelatedBrowser = (deps: {
  document: Document; bundle: AuthenticationHistoryRelatedBundle; active(control: HTMLElement): boolean;
  snapshotFilename: string; download(filename: string, json: string): void;
  sourcePosition(entry: Entry): number; returnToDownload(): void;
  sourceContext?(entry: Entry): AuthenticationHistoryRecordContext | undefined;
}): HTMLDetailsElement => {
  const doc = deps.document; const entries = deps.bundle.report.entries;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const element = doc.createElement(tag); if (text !== undefined) element.textContent = text; return element;
  };
  const root = node('details'); root.className = 'authentication-history-related-browser'; root.id = 'history-related-browser-' + ++browserCounter;
  root.setAttribute('data-history-preview-related', 'records');
  const summary = node('summary', `Browse related records (${entries.length})`); summary.setAttribute('tabindex', '0');
  summary.setAttribute('aria-label', `Browse related records (${entries.length}) for incident ${deps.bundle.report.root.id}`); root.appendChild(summary);
  let populated = false;
  root.addEventListener('toggle', () => {
    if (!deps.active(root) || !root.open || populated) return; populated = true;
    const help = node('p', 'These are the records included in this bundle, in snapshot order. Open a record to read its saved details. Browsing leaves the downloaded file and preview search unchanged.');
    help.id = root.id + '-help'; summary.setAttribute('aria-describedby', help.id); root.appendChild(help);
    const range = node('p'); range.id = root.id + '-range'; range.setAttribute('role', 'status'); range.setAttribute('tabindex', '-1');
    range.setAttribute('data-history-preview-related', 'record-range');
    const items = node('ul'); items.setAttribute('role', 'list'); items.setAttribute('data-history-preview-related', 'record-list'); let offset = 0;
    const allIndices = entries.map((_, index) => index); let matching = allIndices; let appliedSearch = ''; let appliedQuery = '';
    let appliedFilters: RecordFilters = { type: '', outcome: '' };
    const notice = node('p'); notice.setAttribute('role', 'status'); notice.hidden = true; notice.setAttribute('data-history-preview-related', 'match-notice');
    type View = { nodes: HTMLElement[]; hidden: Map<HTMLElement, boolean>; fields: ReturnType<typeof createAuthenticationHistoryPreviewFields>;
      query: string; filters: RecordFilters; index?: number; origin?: HTMLButtonElement; heading?: HTMLElement; forward?: HTMLButtonElement };
    const trail: View[] = [], forwardTrail: View[] = []; let transitioning = false, renderVersion = 0;
    const linkedHost = node('div'); linkedHost.setAttribute('data-history-preview-related', 'linked-views');
    const interactive = (view: View, control: HTMLElement): boolean => !transitioning && trail[trail.length - 1] === view && deps.active(control);
    const transition = <T>(run: () => T): T => {
      transitioning = true; try { return run(); } finally { transitioning = false; }
    };
    const makeView = (nodes: HTMLElement[], status: HTMLElement, query = appliedQuery, filters = appliedFilters): View => {
      const view: View = { nodes, query, filters, hidden: new Map(), fields: createAuthenticationHistoryPreviewFields({ document: doc, active: deps.active,
        interactive: control => interactive(view, control), notice: status }) }; return view;
    };
    const results = makeView([], notice); trail.push(results); const fields = results.fields;
    const resultsActive = (control: HTMLElement): boolean => interactive(results, control);
    const links = createAuthenticationHistoryRelatedLinks(deps.bundle);
    const hide = (view: View): void => { for (const part of view.nodes) { view.hidden.set(part, part.hidden); part.hidden = true; } };
    const reveal = (view: View): void => { for (const [part, hidden] of view.hidden) part.hidden = hidden; view.hidden.clear(); };
    const mayFocusAfterTransition = (view: View, target: HTMLElement, before: Element | null): boolean => {
      const current = doc.activeElement;
      return interactive(view, target) && (current === before || current === doc.body || current === summary);
    };
    const focusAfterTransition = (view: View, target: HTMLElement, before: Element | null): boolean => {
      if (!mayFocusAfterTransition(view, target, before)) return false;
      target.getBoundingClientRect?.(); target.focus({ preventScroll: true });
      if (!interactive(view, target) || doc.activeElement !== target) return false;
      target.scrollIntoView?.({ block: 'nearest' }); return true;
    };
    const button = (label: string, key: string, run: (event: MouseEvent) => void, available = resultsActive): HTMLButtonElement => {
      const control = node('button', label); control.type = 'button'; control.setAttribute('data-history-preview-control', key);
      control.addEventListener('click', event => { if (available(control) && !control.disabled) run(event); }); return control;
    };
    const navigation = node('nav'); navigation.setAttribute('data-history-preview-related-navigation', 'records'); navigation.setAttribute('aria-label', 'Related saved record navigation for incident ' + deps.bundle.report.root.id); navigation.hidden = true;
    const navigationStatus = node('p'); navigationStatus.id = root.id + '-navigation'; navigationStatus.setAttribute('role', 'status');
    const navigationActive = (control: HTMLElement): boolean => !transitioning && deps.active(control);
    const navigationButton = (label: string, key: string, run: (moveFocus: boolean) => void, available = navigationActive): HTMLButtonElement => {
      let pointerFocus: Element | null | undefined;
      const control = button(label, key, event => {
        const pointerOrigin = event.detail > 0 ? pointerFocus : undefined; pointerFocus = undefined;
        const before = doc.activeElement, view = trail[trail.length - 1]!;
        const owned = view.nodes.some(part => part.contains(before));
        const newer = pointerOrigin !== undefined && before !== pointerOrigin && before !== control && before !== doc.body && !owned && before?.isConnected;
        run(!newer && (event.detail > 0 || before === control || before === doc.body || owned || !before?.isConnected));
      }, available);
      control.addEventListener('pointerdown', () => { pointerFocus = available(control) ? doc.activeElement : undefined; });
      control.addEventListener('focus', () => { if (pointerFocus !== undefined && available(control)) pointerFocus = control; });
      control.addEventListener('pointercancel', () => { pointerFocus = undefined; });
      control.setAttribute('aria-describedby', navigationStatus.id); return control;
    };
    const back = navigationButton('Back to previous record', 'related-history-back', moveFocus => goBack(moveFocus));
    const forward = navigationButton('Forward to next record', 'related-reference-forward', moveFocus => goForward(moveFocus));
    navigation.appendChild(back); navigation.appendChild(forward); navigation.appendChild(navigationStatus); root.appendChild(navigation);
    const viewLabel = (view?: View): string => view?.index === undefined ? 'related results' : types[entries[view.index]!.type].toLowerCase() + ' ' + entries[view.index]!.record.id;
    const updateNavigation = (): void => {
      if (!deps.active(navigation)) return;
      const current = trail[trail.length - 1]!, previous = trail[trail.length - 2], next = forwardTrail[forwardTrail.length - 1];
      navigation.hidden = trail.length === 1 && !forwardTrail.length;
      back.textContent = previous === results ? 'Back to related results' : 'Back to previous record'; back.disabled = !previous;
      if (!deps.active(navigation)) return;
      forward.disabled = !next; if (!deps.active(navigation)) return;
      if (current.forward) current.forward.disabled = !next;
      back.setAttribute('aria-label', 'Back to ' + (previous ? viewLabel(previous) : 'previous record') + ' for incident ' + deps.bundle.report.root.id);
      forward.setAttribute('aria-label', 'Forward to ' + (next ? viewLabel(next) : 'next record') + ' for incident ' + deps.bundle.report.root.id);
      navigationStatus.textContent = (previous ? 'Back returns to ' + viewLabel(previous) + '.' : 'No previous linked view.')
        + ' ' + (next ? 'Forward returns to ' + viewLabel(next) + '.' : 'No next linked view.')
        + ' ' + (trail.length - 1) + ' earlier step' + (trail.length === 2 ? '' : 's') + '. ' + forwardTrail.length + ' next step' + (forwardTrail.length === 1 ? '' : 's')
        + '. Keeps up to ' + MAX_LINKED_VIEWS + ' linked records across Back and Forward. Open details and pages are kept.';
    };
    const goBack = (moveFocus: boolean): void => {
      const view = trail[trail.length - 1]!, previous = trail[trail.length - 2];
      if (transitioning || !previous) return;
      const before = doc.activeElement, origin = view.origin;
      const restored = transition(() => {
        hide(view); if (!deps.active(root)) return false;
        trail.pop(); forwardTrail.push(view); reveal(previous); if (!deps.active(root)) return false;
        updateNavigation(); return deps.active(root);
      });
      if (!restored) return;
      const fallback = previous === results ? range : previous.heading ?? summary;
      const target = origin && interactive(previous, origin) ? origin : fallback;
      const explainFallback = (): void => { navigationStatus.textContent += ' The earlier link is no longer shown. Your current search and pages are kept.'; };
      if (target !== origin) explainFallback();
      if (moveFocus && !focusAfterTransition(previous, target, before) && target === origin && mayFocusAfterTransition(previous, fallback, before)) {
        // A retained link can still be connected inside closed details. Native
        // focus refuses it; keep those details closed and use the visible view.
        explainFallback(); focusAfterTransition(previous, fallback, before);
      }
    };
    const goForward = (moveFocus: boolean): void => {
      const view = forwardTrail[forwardTrail.length - 1]; if (transitioning || !view) return;
      const before = doc.activeElement;
      const restored = transition(() => {
        hide(trail[trail.length - 1]!); if (!deps.active(root)) return false;
        forwardTrail.pop(); trail.push(view); reveal(view); if (!deps.active(root)) return false;
        updateNavigation(); return deps.active(root);
      });
      if (restored && moveFocus) focusAfterTransition(view, view.heading!, before);
    };
    const discardForward = (): boolean => {
      while (forwardTrail.length) {
        const view = forwardTrail.pop()!;
        for (const part of view.nodes) if (linkedHost.contains(part)) linkedHost.removeChild(part);
        if (!deps.active(root)) return false;
      }
      return true;
    };
    const searchForm = node('form'); searchForm.className = 'authentication-history-preview-search'; searchForm.setAttribute('data-history-preview-related-search', 'form');
    searchForm.setAttribute('aria-label', 'Search related records for incident ' + deps.bundle.report.root.id);
    const searchLabel = node('label', 'Search related records'); searchLabel.htmlFor = root.id + '-search';
    const searchInput = node('input'); searchInput.id = searchLabel.htmlFor; searchInput.type = 'search'; searchInput.setAttribute('maxlength', String(SEARCH_LIMIT));
    searchInput.setAttribute('data-history-preview-related-search', 'query'); searchInput.setAttribute('aria-label', 'Search related records for incident ' + deps.bundle.report.root.id);
    searchInput.setAttribute('placeholder', 'Alias, ID, or recorded reason'); searchInput.setAttribute('aria-invalid', 'false');
    const searchHelp = node('p', `Search this bundle's saved fields, including closed details. Match literal text without case differences. The bundle download still includes all ${entries.length} records. The preview search stays as you left it.`);
    searchHelp.id = root.id + '-search-help';
    const applied = node('p'); applied.id = root.id + '-search-applied'; applied.setAttribute('data-history-preview-related-search', 'applied'); applied.hidden = true;
    const error = node('p'); error.id = root.id + '-search-error'; error.setAttribute('data-history-preview-related-search', 'error'); error.setAttribute('role', 'alert'); error.hidden = true;
    searchInput.setAttribute('aria-describedby', searchHelp.id + ' ' + applied.id + ' ' + error.id + ' ' + range.id);
    const clearError = (): void => { error.textContent = ''; error.hidden = true; searchInput.setAttribute('aria-invalid', 'false'); };
    const filterDescription = (filters: RecordFilters): string => [filters.type ? 'Record type: ' + types[filters.type] + '.' : '', filters.outcome ? 'Recorded outcome: ' + outcomes[filters.outcome] + '.' : ''].filter(Boolean).join(' ');
    const refreshResults = (pointerFocus?: Element | null): void => {
      applied.textContent = [appliedSearch ? 'Applied related search: “' + appliedQuery + '”.' : '', filterDescription(appliedFilters)].filter(Boolean).join(' ');
      applied.hidden = !applied.textContent;
      matching = allIndices.filter(index => matchesFilters(entries[index]!, appliedFilters) && (!appliedSearch || searchText(entries[index]!).includes(appliedSearch)));
      offset = 0; renderPage(pointerFocus);
    };
    const applySearch = (): void => {
      if (searchInput.value.length > SEARCH_LIMIT) {
        error.textContent = `Use ${SEARCH_LIMIT} characters or fewer. Earlier related results are unchanged.`; error.hidden = false; searchInput.setAttribute('aria-invalid', 'true'); return;
      }
      // Preserve source text: NFKC can introduce significant edge spaces.
      clearError(); appliedQuery = searchInput.value.trim(); appliedSearch = normalizePreviewSearch(appliedQuery); results.query = appliedQuery;
      refreshResults();
    };
    searchInput.addEventListener('input', () => { if (resultsActive(searchInput)) clearError(); });
    searchForm.addEventListener('submit', event => { event.preventDefault(); if (resultsActive(searchForm)) applySearch(); });
    const submit = node('button', 'Search related records'); submit.type = 'submit'; submit.setAttribute('data-history-preview-control', 'related-search');
    submit.setAttribute('aria-label', 'Search related records for incident ' + deps.bundle.report.root.id);
    const clear = button('Clear related search', 'related-search-clear', () => {
      const previousFocus = doc.activeElement; searchInput.value = ''; applySearch();
      const current = doc.activeElement;
      if (!resultsActive(searchInput) || current !== previousFocus && current !== doc.body && current !== summary && current !== range && current !== searchInput) return;
      searchInput.focus({ preventScroll: true });
      if (resultsActive(searchInput) && doc.activeElement === searchInput) searchInput.scrollIntoView?.({ block: 'nearest' });
    });
    clear.setAttribute('aria-label', 'Clear related search for incident ' + deps.bundle.report.root.id);
    const actions = node('div'); actions.className = 'authentication-history-related-search-actions'; actions.appendChild(submit); actions.appendChild(clear);
    const filterGroup = node('fieldset'); filterGroup.className = 'authentication-history-related-filters'; filterGroup.setAttribute('data-history-preview-related-filter', 'controls');
    filterGroup.appendChild(node('legend', 'Filter related records'));
    const filterHelp = node('p', 'Type and outcome apply right away to the current search. Text you are still typing applies only when you choose Search. These choices describe saved records, not current vendor access.');
    filterHelp.id = root.id + '-filter-help';
    const filterError = node('p'); filterError.id = root.id + '-filter-error'; filterError.setAttribute('data-history-preview-related-filter', 'error'); filterError.setAttribute('role', 'alert'); filterError.hidden = true;
    const presentTypes = new Set(entries.map(entry => entry.type)), presentOutcomes = new Set(entries.map(entry => entry.outcome));
    const availableTypes = (Object.keys(types) as Entry['type'][]).filter(type => presentTypes.has(type));
    const availableOutcomes = (Object.keys(outcomes) as Entry['outcome'][]).filter(outcome => presentOutcomes.has(outcome));
    const grid = node('div'); grid.className = 'authentication-history-related-filter-grid';
    const filterControl = (key: keyof RecordFilters, title: string, all: string, labels: Readonly<Record<string, string>>, available: readonly string[]): HTMLSelectElement => {
      const field = node('div'), label = node('label', title), control = node('select'); control.id = root.id + '-filter-' + key; label.htmlFor = control.id;
      control.setAttribute('data-history-preview-related-filter', key); control.setAttribute('aria-label', title + ' for incident ' + deps.bundle.report.root.id);
      control.setAttribute('aria-describedby', filterHelp.id + ' ' + applied.id + ' ' + filterError.id + ' ' + range.id);
      const option = node('option', all); option.value = ''; control.appendChild(option);
      for (const value of available) { const option = node('option', labels[value]); option.value = value; control.appendChild(option); }
      control.value = ''; field.appendChild(label); field.appendChild(control); grid.appendChild(field); return control;
    };
    const typeFilter = filterControl('type', 'Record type', 'All record types', types, availableTypes);
    const outcomeFilter = filterControl('outcome', 'Recorded outcome', 'All recorded outcomes', outcomes, availableOutcomes);
    const changeFilters = (control: HTMLElement): void => {
      if (!resultsActive(control)) return;
      const type = availableTypes.find(value => value === typeFilter.value), outcome = availableOutcomes.find(value => value === outcomeFilter.value);
      if (typeFilter.value && !type || outcomeFilter.value && !outcome) {
        typeFilter.value = appliedFilters.type; outcomeFilter.value = appliedFilters.outcome;
        filterError.textContent = 'Choose a record type or recorded outcome shown in this bundle. Earlier results are unchanged.'; filterError.hidden = false; return;
      }
      filterError.textContent = ''; filterError.hidden = true;
      if (appliedFilters.type === (type ?? '') && appliedFilters.outcome === (outcome ?? '')) return;
      appliedFilters = { type: type ?? '', outcome: outcome ?? '' }; results.filters = appliedFilters; refreshResults();
    };
    typeFilter.addEventListener('change', () => changeFilters(typeFilter)); outcomeFilter.addEventListener('change', () => changeFilters(outcomeFilter));
    let filterResetFocus: Element | null | undefined;
    const clearFilters = button('Clear type and outcome filters', 'related-filter-clear', event => {
      const before = event.detail > 0 ? filterResetFocus : undefined; filterResetFocus = undefined;
      filterError.textContent = ''; filterError.hidden = true;
      if (!appliedFilters.type && !appliedFilters.outcome) return;
      typeFilter.value = ''; outcomeFilter.value = ''; appliedFilters = { type: '', outcome: '' }; results.filters = appliedFilters; refreshResults(before);
    });
    clearFilters.addEventListener('pointerdown', () => { filterResetFocus = resultsActive(clearFilters) ? doc.activeElement : undefined; });
    clearFilters.addEventListener('pointercancel', () => { filterResetFocus = undefined; });
    clearFilters.setAttribute('aria-label', 'Clear type and outcome filters for incident ' + deps.bundle.report.root.id);
    filterGroup.appendChild(grid); filterGroup.appendChild(filterHelp); filterGroup.appendChild(clearFilters); filterGroup.appendChild(filterError);
    // Native selects can implicitly submit their owning form on Enter. Keep
    // immediate filters outside the text form so they cannot apply its draft.
    searchForm.appendChild(searchLabel); searchForm.appendChild(searchInput); searchForm.appendChild(searchHelp); searchForm.appendChild(actions); searchForm.appendChild(error);
    root.appendChild(searchForm); root.appendChild(filterGroup); root.appendChild(applied); root.appendChild(notice); root.appendChild(range);
    results.nodes.push(searchForm, filterGroup, applied, notice, range);
    const pager = (label: string, key: string, change: number): HTMLButtonElement => {
      let pointerFocus: Element | null | undefined;
      const control = node('button', label); control.type = 'button'; control.setAttribute('data-history-preview-control', key); control.setAttribute('aria-describedby', range.id);
      control.setAttribute('aria-label', label + ' for incident ' + deps.bundle.report.root.id);
      control.addEventListener('pointerdown', () => { pointerFocus = resultsActive(control) ? doc.activeElement : undefined; });
      control.addEventListener('pointercancel', () => { pointerFocus = undefined; });
      control.addEventListener('click', event => {
        const before = event.detail > 0 ? pointerFocus : undefined; pointerFocus = undefined;
        if (!resultsActive(control) || control.disabled) return; offset += change; renderPage(before);
      }); return control;
    };
    const previous = pager('Previous related records', 'related-previous', -PAGE_SIZE);
    const next = pager('Next related records', 'related-next', PAGE_SIZE);
    const recordContents = (parent: HTMLDetailsElement, heading: HTMLElement, index: number, query: string,
      firstMatches: ReturnType<typeof previewMatches> | undefined, view: View): void => {
      const entry = entries[index]!; const record = entry.record; const sourceContext = deps.sourceContext?.(entry);
      const sourcePosition = sourceContext ? sourceContext.source_position === undefined ? undefined : sourceContext.source_position - 1 : deps.sourcePosition(entry);
      let metadata: RevealPreviewField | undefined; let recordFields: RevealPreviewField | undefined;
      parent.appendChild(createAuthenticationHistoryRecordActions({ document: doc, entry,
        file: { snapshotFilename: deps.snapshotFilename, ...(sourcePosition === undefined ? {} : { sourcePosition }) }, origin: heading, context: 'related history for incident ' + deps.bundle.report.root.id,
        ...(sourceContext ? { sourceContext } : {}),
        active: deps.active, interactive: control => interactive(view, control), download: deps.download }).element);
      if (firstMatches?.total) view.fields.matches({ parent, summary: heading, entry, query, firstMatches,
        context: `related ${types[entry.type].toLowerCase()} ${record.id} for incident ${deps.bundle.report.root.id}`,
        open: () => { parent.open = true; },
        reveal: path => path[0] === 'record' ? recordFields?.(path.slice(1)) : metadata?.(path),
      });
      parent.appendChild(createAuthenticationHistoryRelatedLinkList({ document: doc, links: links(index), index, summary: heading,
        context: `${types[entry.type].toLowerCase()} ${record.id} for incident ${deps.bundle.report.root.id}`, canFollow: trail.length <= MAX_LINKED_VIEWS, limit: MAX_LINKED_VIEWS,
        interactive: control => interactive(view, control), open: (target, origin) => followLink(target, origin, index),
      }));
      metadata = view.fields.fields(parent, { type: entry.type, outcome: entry.outcome }, []); recordFields = view.fields.fields(parent, record, ['record']);
    };
    const followLink = (target: number, origin: HTMLButtonElement, from: number): void => {
      const previousView = trail[trail.length - 1]!; const entry = entries[target];
      if (!interactive(previousView, origin) || trail.length > MAX_LINKED_VIEWS || !entry) return;
      const before = doc.activeElement;
      const opened = transition(() => {
        hide(previousView); if (!deps.active(origin) || !discardForward()) return;
        const pane = node('section'); pane.className = 'authentication-history-related-linked-view'; pane.setAttribute('data-history-preview-related-linked', 'view');
        pane.setAttribute('aria-label', 'Linked saved record for incident ' + deps.bundle.report.root.id);
        const status = node('p'); status.setAttribute('role', 'status'); status.hidden = true; status.setAttribute('data-history-preview-related-linked', 'match-notice');
        const view = makeView([pane], status, previousView.query, previousView.filters); view.index = target; view.origin = origin; trail.push(view); linkedHost.appendChild(pane);
        const heading = node('h4', 'Linked ' + types[entry.type].toLowerCase() + ': ' + entry.record.id); heading.setAttribute('tabindex', '-1'); heading.setAttribute('data-history-preview-related-linked', 'heading'); pane.appendChild(heading); view.heading = heading;
        const back = navigationButton(previousView === results ? 'Back to related results' : 'Back to previous record', 'related-reference-back', moveFocus => goBack(moveFocus), control => interactive(view, control));
        back.setAttribute('aria-label', back.textContent + ': ' + types[entries[from]!.type].toLowerCase() + ' ' + entries[from]!.record.id + ' for incident ' + deps.bundle.report.root.id); pane.appendChild(back);
        view.forward = navigationButton('Forward to next record', 'related-inline-forward', moveFocus => goForward(moveFocus), control => interactive(view, control));
        view.forward.setAttribute('aria-label', 'Forward to next record for incident ' + deps.bundle.report.root.id); pane.appendChild(view.forward);
        pane.appendChild(node('p', 'From ' + types[entries[from]!.type].toLowerCase() + ': ' + entries[from]!.record.id + '. Back returns to the view you left.'));
        if (view.query) pane.appendChild(node('p', 'Search used for these saved fields: “' + view.query + '”. Back keeps the current related results.'));
        if (view.query && !searchText(entry).includes(normalizePreviewSearch(view.query))) pane.appendChild(node('p', 'This record was outside your related search when this view opened. Back keeps the current search and pages.'));
        if (view.filters.type || view.filters.outcome) pane.appendChild(node('p', 'Related filters used when this view opened: ' + filterDescription(view.filters) + ' Back keeps the current related results.'));
        if (!matchesFilters(entry, view.filters)) pane.appendChild(node('p', 'This record was outside those related filters when this view opened. Back keeps the current search, filters and pages.'));
        pane.appendChild(status);
        const details = node('details'); details.open = true; details.setAttribute('data-history-preview-linked-record', String(deps.sourcePosition(entry))); pane.appendChild(details);
        const title = node('summary', `${types[entry.type]} · ${outcomes[entry.outcome]} · ${entry.record.id}`); title.setAttribute('tabindex', '0'); details.appendChild(title);
        recordContents(details, title, target, view.query, view.query ? previewMatches(entry, view.query) : undefined, view);
        updateNavigation();
        return { view, heading };
      });
      if (opened) focusAfterTransition(opened.view, opened.heading, before);
    };
    const renderPage = (pointerFocus?: Element | null): void => {
      const rendered = ++renderVersion; const currentRender = (): boolean => rendered === renderVersion && resultsActive(items);
      const current = doc.activeElement;
      const before = current === doc.body || current === summary ? pointerFocus ?? current : current;
      const focused = before === previous ? previous : before === next ? next : undefined;
      const removed = items.contains(before) ? before : undefined;
      fields.clear(); if (!currentRender()) return; notice.textContent = ''; notice.hidden = true;
      while (items.firstChild && currentRender()) items.removeChild(items.firstChild);
      if (!currentRender()) return;
      for (const view of forwardTrail) if (view.origin && !deps.active(view.origin)) delete view.origin;
      const end = Math.min(offset + PAGE_SIZE, matching.length);
      const filtered = appliedFilters.type || appliedFilters.outcome;
      range.textContent = appliedSearch || filtered ? matching.length ? `Matching related records ${offset + 1}–${end} of ${matching.length} (${entries.length} in bundle).`
        : `No related records match ${appliedSearch ? filtered ? 'this search and these filters' : 'this search' : 'these filters'}. The bundle download still includes all ${entries.length} records.`
        : `Related records ${offset + 1}–${end} of ${entries.length}`;
      previous.disabled = offset === 0; if (!currentRender()) return; next.disabled = end >= matching.length; if (!currentRender()) return;
      for (const [position, index] of matching.slice(offset, end).entries()) {
        if (!currentRender()) return;
        const entry = entries[index]!;
        const record = entry.record; const item = node('li'); const details = node('details');
        // Literal ordinals avoid WebKit's nested native-disclosure counters.
        item.setAttribute('aria-posinset', String(offset + position + 1)); item.setAttribute('aria-setsize', String(matching.length));
        details.setAttribute('data-history-preview-related-record', String(deps.sourcePosition(entry))); item.appendChild(details); items.appendChild(item);
        const label = 'group' in record && 'label' in record.group ? record.group.label : 'app_label' in record ? record.app_label : undefined;
        const selected = entry.type === 'incident' && record.id === deps.bundle.report.root.id;
        const heading = node('summary', `${offset + position + 1}. ${types[entry.type]} · ${outcomes[entry.outcome]} · ${label ? label + ' · ' : ''}${record.id}${selected ? ' · Selected incident' : ''}`);
        heading.setAttribute('tabindex', '0'); details.appendChild(heading); let shown = false;
        const query = appliedQuery; const firstMatches = query ? previewMatches(entry, query) : undefined;
        if (firstMatches?.total) {
          const hint = node('span', `${firstMatches.total} matching field${firstMatches.total === 1 ? '' : 's'}. First: ${firstMatches.matches[0]!.label}`);
          hint.className = 'authentication-history-preview-match-summary'; heading.appendChild(hint);
        }
        const populate = (): void => {
          if (!deps.active(details) || shown) return; shown = true;
          recordContents(details, heading, index, query, firstMatches, results);
        };
        details.addEventListener('toggle', () => { if (details.open) populate(); });
      }
      updateNavigation(); if (!currentRender()) return;
      const fallbackFocus = doc.activeElement === doc.body || doc.activeElement === summary;
      if (resultsActive(range) && (focused?.disabled && (doc.activeElement === focused || fallbackFocus)
        || removed && (doc.activeElement === removed || doc.activeElement === doc.body))) {
        range.focus({ preventScroll: true });
        if (currentRender() && doc.activeElement === range) range.scrollIntoView?.({ block: 'nearest' });
      }
      else if (focused && resultsActive(focused) && doc.activeElement !== focused && fallbackFocus) focused.focus({ preventScroll: true });
    };
    if (entries.length > PAGE_SIZE) {
      const paging = node('div'); paging.className = 'authentication-history-related-paging'; paging.setAttribute('role', 'group'); paging.setAttribute('aria-label', 'Related record pages for incident ' + deps.bundle.report.root.id);
      paging.appendChild(previous); paging.appendChild(next); root.appendChild(paging);
      results.nodes.push(paging);
    }
    const returnDownload = button('Return to bundle download', 'related-return-download', deps.returnToDownload, deps.active);
    returnDownload.setAttribute('aria-label', 'Return to bundle download for incident ' + deps.bundle.report.root.id);
    results.nodes.push(items); root.appendChild(items); root.appendChild(linkedHost); root.appendChild(returnDownload); renderPage();
  });
  return root;
};

// Stack narrow controls rather than forcing a third text line: WebKit can
// retain an earlier native button height when a two-column grid resizes.
// Native WebKit selects also need an explicit height: their themed minimum
// can replace min-height even when the matching author rule requests 44px.
export const AUTHENTICATION_HISTORY_RELATED_BROWSER_STYLES = `.authentication-history-related-browser>[data-history-preview-related-navigation]:not([hidden]){display:flex;flex-wrap:wrap;gap:8px;border:1px solid var(--border);border-radius:6px;padding:8px;margin:12px 0;min-width:0}.authentication-history-related-browser [data-history-preview-related-navigation]>button{box-sizing:border-box;min-height:44px;max-width:100%;white-space:normal;margin:0}.authentication-history-related-browser [data-history-preview-related-navigation]>p{flex-basis:100%;margin:0;overflow-wrap:anywhere}.authentication-history-related-browser>[hidden],.authentication-history-related-linked-view[hidden]{display:none!important}.authentication-history-related-browser>summary{font-weight:600}.authentication-history-related-browser>ul{list-style:none;margin:12px 0;padding:0}.authentication-history-related-browser>ul>li{margin:8px 0;min-width:0}.authentication-history-related-browser>ul>li>details>summary{list-style-position:inside}.authentication-history-related-paging,.authentication-history-related-search-actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(140px,100%),1fr));gap:8px;margin:8px 0}.authentication-history-related-paging button,.authentication-history-related-search-actions button{width:auto;min-width:0;min-height:44px;margin:0;white-space:normal}.authentication-history-related-browser>button{margin:8px 0}.authentication-history-related-links{border:1px solid var(--border);border-radius:6px;padding:8px;margin:12px 0;min-width:0}.authentication-history-related-links h4{margin:0}.authentication-history-related-links ul{list-style:none;margin:8px 0;padding:0}.authentication-history-related-links li{border-top:1px solid var(--border);padding:8px 0;min-width:0}.authentication-history-related-links p{margin:8px 0}.authentication-history-related-linked-view{border-top:1px solid var(--border);margin:12px 0;padding-top:12px;min-width:0}.authentication-history-related-linked-view>h4{margin:0 0 8px;overflow-wrap:anywhere}.authentication-history-related-linked-view>button{min-height:44px;white-space:normal;margin:8px 0}` + `.authentication-history-related-filters{border:0;padding:0;min-width:0;margin:12px 0}.authentication-history-related-filters legend{font-weight:600}.authentication-history-related-filter-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(180px,100%),1fr));gap:12px}.authentication-history-related-filter-grid>div{min-width:0}.authentication-history-related-filter-grid label{display:block;font-weight:600;margin-bottom:4px}.authentication-history-related-filter-grid select{box-sizing:border-box;width:100%;min-width:0;height:44px;min-height:44px;font:inherit;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--fg)}.authentication-history-related-filters>button{min-height:44px;max-width:100%;white-space:normal;margin:8px 0}`;
