import { prepareAuthenticationHistorySupportTimeline } from './authentication-history-support-timeline.js';
import { downloadAuthenticationHistory, type PreparedAuthenticationHistoryDownload } from './authentication-history-export.js';
import { previewRecordTypes as types, previewRecordedOutcomes as outcomes, normalizePreviewSearch as normalizeSearch, previewSearchText, previewMatches } from './authentication-history-preview-fields.js';
import { createAuthenticationHistoryPreviewFields, type RevealPreviewField as RevealField } from './authentication-history-preview-fields-browser.js';
import { createAuthenticationHistoryCopy, AUTHENTICATION_HISTORY_VALUE_COPY_STYLES } from './authentication-history-preview-copy.js';
import { createAuthenticationHistoryRecordActions } from './authentication-history-record-actions.js';
import { createAuthenticationHistoryRelatedBundles, prepareAuthenticationHistoryRelatedDownload, type AuthenticationHistoryRelatedBundle } from './authentication-history-related-bundle.js';
import { createAuthenticationHistoryRelatedBrowser, AUTHENTICATION_HISTORY_RELATED_BROWSER_STYLES } from './authentication-history-related-browser.js';
import type { PreparedAuthenticationHistoryRecordDownload } from './authentication-history-saved-file.js';
import { authenticationHistoryRecordContext } from './authentication-history-record-context.js';
import { isAuthenticationIncidentHistoryFilters } from '@recued/contracts';

type PreviewEntry = PreparedAuthenticationHistoryDownload['report']['entries'][number];
type RecordFilters = Readonly<{ type: PreviewEntry['type'] | ''; outcome: PreviewEntry['outcome'] | '' }>;
type DateRange = Readonly<{ from: string; through: string }>;
type IncompleteDates = Readonly<{ from: boolean; through: boolean }>;
const matchesFilters = (entry: PreviewEntry, filters: RecordFilters): boolean => (!filters.type || entry.type === filters.type) && (!filters.outcome || entry.outcome === filters.outcome);
const matchesDates = (entry: PreviewEntry, dates: DateRange): boolean => (!dates.from || entry.record.started_at >= Date.parse(dates.from + 'T00:00:00Z'))
  && (!dates.through || entry.record.started_at < Date.parse(dates.through + 'T00:00:00Z') + 86_400_000);
const PAGE_SIZE = 20;
const SEARCH_LIMIT = 128;
const RECORD_TRAIL_LIMIT = 20;
const INCOMPLETE_DATE_GUIDANCE = 'Re-enter the incomplete date or choose Clear date range. Earlier preview results are unchanged.';
let previewCounter = 0;

/** Read-only view of the already validated download. No RPCs or runtime links.
 * Pages and lazy detail trees bound DOM work without omitting file contents. */
export const createAuthenticationHistoryPreview = (deps: { document: Document; download?(filename: string, json: string): void; closed?(): void }) => {
  const doc = deps.document; let snapshot: PreparedAuthenticationHistoryDownload | PreparedAuthenticationHistoryRecordDownload | undefined; let disposed = false; let version = 0;
  const download = deps.download ?? ((filename: string, json: string): void => downloadAuthenticationHistory(doc, filename, json));
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const element = doc.createElement(tag); if (text !== undefined) element.textContent = text; return element;
  };
  const empty = (element: HTMLElement): void => { while (element.firstChild) element.removeChild(element.firstChild); };
  const element = node('section'); element.className = 'authentication-history-preview'; element.hidden = true;
  element.setAttribute('data-history-preview', 'report'); element.setAttribute('aria-label', 'History export preview');
  let heading: HTMLHeadingElement | undefined, recordFocus: HTMLElement | undefined;
  const clear = (): void => { version++; snapshot = undefined; heading = undefined; recordFocus = undefined; element.hidden = true; empty(element); };
  const show = (value: PreparedAuthenticationHistoryDownload | PreparedAuthenticationHistoryRecordDownload, opened?: { bundle?: AuthenticationHistoryRelatedBundle; comparisonPair?: true } & ({ filename: string; source?: 'file' } | { source: 'paste' | 'live' } | { source: 'comparison'; side: 'baseline' | 'comparison'; label: string; recordIndex?: number })): void => {
    if (disposed) return;
    const initialRecordIndex = opened?.source === 'comparison' ? opened.recordIndex : undefined;
    if (initialRecordIndex !== undefined && ('entry' in value || !Number.isSafeInteger(initialRecordIndex) || initialRecordIndex < 0 || initialRecordIndex >= value.report.entries.length))
      throw new Error('Choose a record included in this source report.');
    clear(); snapshot = value; const epoch = version; const single = 'entry' in value;
    const entries = single ? [value.entry] : value.report.entries;
    const savedContext = single ? value.context : undefined;
    const contextFor = (index: number) => single ? value.context : authenticationHistoryRecordContext(value, index, opened?.bundle);
    const active = (control: HTMLElement): boolean => !disposed && epoch === version && element.contains(control);
    const button = (text: string, key: string, run: (event: MouseEvent) => void): HTMLButtonElement => {
      const control = node('button', text); control.type = 'button'; control.setAttribute('data-history-preview-control', key);
      control.addEventListener('click', event => { if (active(control) && !control.disabled) run(event); }); return control;
    };
    const pagingButton = (text: string, key: string, run: (pointerFocus?: Element | null) => void): HTMLButtonElement => {
      let pointerFocus: Element | null | undefined;
      const control = button(text, key, event => {
        const before = event.detail > 0 ? pointerFocus : undefined; pointerFocus = undefined; run(before);
      });
      // WebKit can blur the old field on pointerdown, before click runs.
      control.addEventListener('pointerdown', () => { pointerFocus = active(control) ? doc.activeElement : undefined; });
      control.addEventListener('pointercancel', () => { pointerFocus = undefined; });
      return control;
    };
    const searchNotice = node('p'); searchNotice.setAttribute('role', 'status'); searchNotice.hidden = true;
    const { fields, detail, matches: matchingFields, clear: clearReturn } = createAuthenticationHistoryPreviewFields({ document: doc, active, notice: searchNotice });
    const pasted = opened?.source === 'paste'; const live = opened?.source === 'live';
    const comparisonSource = !single && opened?.comparisonPair === true;
    const sourceReport = !single && opened?.source === 'comparison' ? opened : undefined;
    const sourceTitle = sourceReport?.side === 'baseline' ? 'Baseline' : 'Comparison';
    element.hidden = false; heading = node('h3', single ? live ? 'History record preview' : pasted ? 'Pasted history record' : 'Saved history record' : sourceReport ? sourceTitle + ' source report' : comparisonSource ? 'Comparison report from saved pair' : pasted ? 'Pasted history JSON' : opened ? 'Saved history file' : 'History export preview'); heading.setAttribute('tabindex', '-1');
    heading.id = 'history-export-preview-' + ++previewCounter; element.setAttribute('aria-labelledby', heading.id); element.appendChild(heading);
    element.setAttribute('data-history-preview-layout', single ? 'record' : 'report');
    const privateMode = single ? value.representation === 'aliases' : value.report.format === 'recued.connection-history.aliases';
    const supporting = single ? node('details') : element;
    if (single) {
      const record = value.entry.record;
      const summary = node('div'); summary.setAttribute('data-history-preview-summary', 'record');
      const title = node('p'); title.appendChild(node('strong', types[value.entry.type] + ' · ' + outcomes[value.entry.outcome])); summary.appendChild(title);
      const identity = node('p', 'Record ID: '); identity.appendChild(node('code', record.id)); summary.appendChild(identity);
      summary.appendChild(node('p', 'Started (UTC): ' + new Date(record.started_at).toISOString()));
      const finished = 'finished_at' in record ? record.finished_at : 'ended_at' in record ? record.ended_at : undefined;
      if (finished !== undefined) summary.appendChild(node('p', ('ended_at' in record ? 'Closed' : 'Finished') + ' (UTC): ' + new Date(finished).toISOString()));
      element.appendChild(summary);
      const notice = node('p', (privateMode ? 'Aliases. ' : 'Names and IDs (local use). ')
        + (savedContext ? 'Saved source context included. ' : 'Source snapshot details are unknown. ') + 'Current vendor access was not checked.');
      notice.setAttribute('data-history-preview-summary', 'notice'); element.appendChild(notice);
      supporting.setAttribute('data-history-preview-supporting', 'record'); supporting.appendChild(node('summary', 'About this record'));
    }
    if (opened) {
      const origin = node('p', sourceReport ? 'Opened from the captured ' + sourceReport.side + ' report: ' + sourceReport.label : live ? 'Prepared locally from a loaded history record.' : pasted ? 'Opened from pasted JSON.' : 'Opened locally: ' + ('filename' in opened ? opened.filename : ''));
      if (sourceReport) origin.setAttribute('data-history-preview-comparison-source', sourceReport.side);
      else origin.setAttribute(live ? 'data-history-preview-live' : pasted ? 'data-history-preview-paste' : 'data-history-preview-file', live || pasted ? 'source' : 'name'); supporting.appendChild(origin);
      supporting.appendChild(node('p', (live ? 'This record preview' : comparisonSource || sourceReport ? 'This report' : pasted ? 'This JSON' : 'This file') + ' stays in this browser tab. Its contents are saved claims, not authenticated evidence. Current vendor access was not checked. It does not change the history stored on your server.'));
      if (!single && opened.bundle) supporting.appendChild(node('p', 'Related history bundle for incident ' + opened.bundle.report.root.id + '. It contains a subset of the source snapshot. Original aliases, missing references and source limits remain recorded below.'));
    }
    if (single) {
      const context = node('p', savedContext
        ? 'Source snapshot context is included as saved claims. Snapshot captured (UTC): ' + new Date(savedContext.source_snapshot.exported_at).toISOString() + '. Scope, filters, privacy mode and limits are recorded below. Other records are not included.'
        : live ? 'Source snapshot details are unknown. This preview captures one loaded local record in the selected privacy mode. It does not include other records, a source snapshot date, scope, filters, retention or source position.'
          : 'Snapshot context is not included. Export date, scope, filters, retention, source position and original privacy settings are unknown. Related records cannot be discovered from this record.');
      context.setAttribute('data-history-preview-record-context', savedContext ? 'included' : 'unknown'); supporting.appendChild(context);
      if (savedContext) {
        supporting.appendChild(node('p', savedContext.source_position === undefined ? 'Source position is unknown. The recorded source contains ' + savedContext.source_snapshot.entry_count + ' entries.'
          : 'Source position: ' + savedContext.source_position + ' of ' + savedContext.source_snapshot.entry_count + ' recorded source entries.'));
        supporting.appendChild(node('p', 'Recorded source privacy mode: ' + value.representation + '. This context does not authenticate its source or establish links to other files.'));
      }
      supporting.appendChild(node('p', privateMode ? live ? 'Privacy mode (aliases): aliases apply only to this captured record. Matching aliases from separate files do not establish a shared account or record.'
        : 'Saved aliases: their original report is not included. Matching aliases from separate files do not establish a shared account or record.'
        : 'Names and IDs: this record includes saved labels or resource IDs. Keep it for local use.'));
      supporting.appendChild(node('p', `1 saved record. ${value.bytes.toLocaleString('en-US')} bytes. Download saves this checked record${savedContext ? ' with its source context' : ''}. Refreshing history leaves it unchanged.`));
    } else {
      supporting.appendChild(node('p', privateMode ? 'Privacy mode: aliases. Names, labels, messages and search text are removed. Aliases link records within this ' + (pasted ? 'report' : 'file') + ' only.'
      : 'Names and IDs: this report includes saved account and app labels, resource IDs and applied search text. Keep it for local use.'));
      supporting.appendChild(node('p', `Snapshot captured (UTC): ${new Date(value.report.exported_at).toISOString()}. ${value.count} ${sourceReport ? 'saved records in this ' + sourceReport.side + ' report' : comparisonSource ? 'saved records in this comparison report' : pasted ? 'saved records in this JSON' : opened ? 'saved records in this file' : 'matching retained records'}. ${value.bytes.toLocaleString('en-US')} bytes.`));
      supporting.appendChild(node('p', 'Download saves this snapshot; refreshing history leaves it unchanged. Dates, providers and outcomes remain visible. Review before sharing.'));
    }
    supporting.appendChild(node('p', 'Current vendor access was not checked. Repairs, read checks, token renewal and recovery are separate evidence. Counts refer to records, not accounts.'));
    if (!single) {
      const counts = node('dl'); counts.setAttribute('data-history-preview-counts', 'records');
      for (const [kind, label] of Object.entries(types)) { counts.appendChild(node('dt', label)); counts.appendChild(node('dd', String(entries.filter(e => e.type === kind).length))); }
      for (const [outcome, label] of Object.entries(outcomes)) {
        const count = entries.filter(e => e.outcome === outcome).length; if (count) { counts.appendChild(node('dt', label)); counts.appendChild(node('dd', String(count))); }
      }
      supporting.appendChild(counts);
    }
    if (!single) { const metadata = Object.fromEntries(Object.entries(opened?.bundle?.report ?? value.report).filter(([key]) => key !== 'entries')); detail(element, 'report_details', metadata); }
    else if (savedContext) detail(supporting, 'source_snapshot_details', savedContext.source_snapshot);
    const feedback = node('p'); feedback.setAttribute('role', 'status'); feedback.hidden = true;
    const failure = node('p'); failure.setAttribute('role', 'alert'); failure.hidden = true;
    let comparisonNotice: HTMLParagraphElement | undefined;
    if (sourceReport) {
      comparisonNotice = node('p', 'This preview and its download contain the complete ' + sourceReport.side + ' report from the captured comparison. Search and paging do not limit the download. Save comparison pair (JSON) in the comparison results keeps both reports.');
      comparisonNotice.id = heading.id + '-comparison-source'; comparisonNotice.setAttribute('data-history-preview-comparison', 'source-report'); element.appendChild(comparisonNotice);
    } else if (comparisonSource) {
      comparisonNotice = node('p', 'This preview and its download contain only the comparison report as saved in the pair. Swapping comparison sides keeps this opened report in place. Save comparison pair (JSON) in the comparison results keeps both reports in their displayed order.');
      comparisonNotice.id = heading.id + '-comparison-source'; comparisonNotice.setAttribute('data-history-preview-comparison', 'source'); element.appendChild(comparisonNotice);
    }
    const downloadLabel = sourceReport ? 'Download ' + sourceReport.side + ' report (JSON)' : comparisonSource ? 'Download comparison report (JSON)' : 'Download this preview (JSON)';
    const downloadFilename = !single && sourceReport ? 'recued-history-' + sourceReport.side + '-report-' + new Date(value.report.exported_at).toISOString().replace(/[:.]/g, '-') + '.json' : value.filename;
    let downloading = false;
    const save = button(downloadLabel, 'download', () => {
      if (downloading) return;
      downloading = true; save.setAttribute('aria-busy', 'true'); save.setAttribute('aria-disabled', 'true');
      try {
        download(downloadFilename, value.json);
        if (active(save)) { failure.textContent = ''; failure.hidden = true; feedback.textContent = single ? savedContext ? 'Saved record with source context download requested.' : 'Saved record download requested.' : sourceReport ? sourceTitle + ' report download requested. Only this complete report is included.' : comparisonSource ? 'Comparison report download requested. Only this report is included.' : `Download requested: ${value.count} matching retained entr${value.count === 1 ? 'y' : 'ies'}.`; feedback.hidden = false; }
      } catch { if (active(save)) { feedback.textContent = ''; feedback.hidden = true; failure.textContent = 'This browser could not start the file download. Try again in a browser that supports downloads. This preview is still available.'; failure.hidden = false; } }
      finally { downloading = false; if (active(save)) { save.setAttribute('aria-busy', 'false'); save.setAttribute('aria-disabled', 'false'); } }
    });
    save.setAttribute('aria-busy', 'false'); save.setAttribute('aria-disabled', 'false');
    if (comparisonNotice) save.setAttribute('aria-describedby', comparisonNotice.id);
    const close = (): void => { clear(); deps.closed?.(); };
    element.appendChild(save); element.appendChild(button(initialRecordIndex === undefined ? 'Close preview' : 'Back to comparison', 'close', close));
    element.appendChild(feedback); element.appendChild(failure);
    const byId = new Map(entries.map((entry, index) => [entry.record.id, { entry, index }]));
    const relatedBundle = single ? undefined : opened?.bundle ? () => opened.bundle! : createAuthenticationHistoryRelatedBundles(value);
    // NFKC can introduce edge spaces. Keep the applied source query so later
    // match/highlight passes do not trim those spaces from its folded form.
    const allIndices = entries.map((_, index) => index); let matching = allIndices; let appliedSearch = ''; let appliedQuery = ''; let searchIndex: string[] | undefined;
    let appliedFilters: RecordFilters = { type: '', outcome: '' };
    let appliedDates: DateRange = { from: '', through: '' };
    const matchesCriteria = (entry: PreviewEntry): boolean => matchesFilters(entry, appliedFilters) && matchesDates(entry, appliedDates);
    const searchForm = node('form'); searchForm.className = 'authentication-history-preview-search'; searchForm.setAttribute('data-history-preview-search', 'form');
    searchForm.setAttribute('aria-label', single ? 'Search saved history record' : 'Search history export preview');
    const searchLabel = node('label', 'Search this preview'); searchLabel.htmlFor = heading.id + '-search';
    const searchInput = node('input'); searchInput.id = searchLabel.htmlFor; searchInput.type = 'search'; searchInput.setAttribute('maxlength', String(SEARCH_LIMIT));
    searchInput.setAttribute('data-history-preview-search', 'query'); searchInput.setAttribute('placeholder', 'Alias, ID, or recorded reason');
    const searchHelp = node('p', single ? 'Search saved fields, including closed details, without case differences. Download keeps the complete record' + (savedContext ? ' and source context. Source snapshot details are not searched.' : '.') : 'Search all snapshot records, including fields inside closed details. Match literal text without case differences. '
      + `${downloadLabel} includes all ${entries.length} snapshot records. Record and related-history downloads use their stated contents. This search stays in the preview.`);
    searchHelp.id = heading.id + '-search-help';
    const searchApplied = node('p'); searchApplied.id = heading.id + '-search-applied'; searchApplied.setAttribute('data-history-preview-search', 'applied'); searchApplied.hidden = true;
    const searchError = node('p'); searchError.id = heading.id + '-search-error'; searchError.setAttribute('role', 'alert'); searchError.hidden = true;
    searchInput.setAttribute('aria-describedby', searchHelp.id + ' ' + searchApplied.id + ' ' + searchError.id);
    const searchSubmit = node('button', 'Search preview'); searchSubmit.type = 'submit'; searchSubmit.setAttribute('data-history-preview-control', 'search');
    const clearSearchError = (): void => { searchError.textContent = ''; searchError.hidden = true; searchInput.setAttribute('aria-invalid', 'false'); };
    const filterDescription = (): string => [appliedFilters.type ? 'Record type: ' + types[appliedFilters.type] + '.' : '', appliedFilters.outcome ? 'Recorded outcome: ' + outcomes[appliedFilters.outcome] + '.' : '',
      appliedDates.from ? 'Started from (UTC, inclusive): ' + appliedDates.from + '.' : '', appliedDates.through ? 'Started through (UTC, inclusive): ' + appliedDates.through + '.' : ''].filter(Boolean).join(' ');
    const refreshCriteria = (): void => {
      searchApplied.textContent = [appliedSearch ? 'Applied preview search: “' + appliedQuery + '”.' : '', filterDescription()].filter(Boolean).join(' '); searchApplied.hidden = !searchApplied.textContent;
      if (appliedSearch) searchIndex ??= entries.map(previewSearchText);
      matching = allIndices.filter(index => matchesCriteria(entries[index]!) && (!appliedSearch || searchIndex![index]!.includes(appliedSearch)));
    };
    const setAppliedSearch = (query: string): void => {
      appliedQuery = query; appliedSearch = normalizeSearch(query); refreshCriteria();
    };
    const applySearch = (): void => {
      if (searchInput.value.length > SEARCH_LIMIT) {
        searchError.textContent = `Use ${SEARCH_LIMIT} characters or fewer. Earlier preview results are unchanged.`; searchError.hidden = false; searchInput.setAttribute('aria-invalid', 'true'); return;
      }
      clearSearchError(); setAppliedSearch(searchInput.value.trim());
      page = 0; searchNotice.textContent = ''; searchNotice.hidden = true; renderPage();
    };
    searchInput.addEventListener('input', () => { if (active(searchInput)) clearSearchError(); });
    searchSubmit.addEventListener('click', event => {
      // WebKit pointer activation can leave focus on the body. Claim only that
      // fallback (or the old query), and preserve a newer outside focus choice.
      if (single && event.detail > 0 && active(searchSubmit) && !searchSubmit.disabled
        && (doc.activeElement === doc.body || doc.activeElement === searchInput)) searchSubmit.focus({ preventScroll: true });
    });
    const revealSearchFocus = (chosen: Element | null): void => {
      // The compact inspector sits above search. Collapsing a long entry can
      // move the focused form offscreen; respect any newer focus/scroll choice.
      if (single && chosen && doc.activeElement === chosen && searchForm.contains(chosen) && active(chosen as HTMLElement)) chosen.scrollIntoView?.({ block: 'nearest' });
    };
    searchForm.addEventListener('submit', event => {
      event.preventDefault(); if (!active(searchForm)) return;
      const chosen = doc.activeElement; applySearch(); revealSearchFocus(chosen);
    });
    const clearSearch = button('Clear preview search', 'search-clear', () => {
      const chosen = doc.activeElement; searchInput.value = ''; applySearch();
      if (!active(searchInput) || !(doc.activeElement === chosen || doc.activeElement === doc.body || !doc.activeElement?.isConnected)) return;
      searchInput.focus({ preventScroll: true }); revealSearchFocus(searchInput);
    });
    searchForm.appendChild(searchLabel); searchForm.appendChild(searchInput); searchForm.appendChild(searchHelp);
    searchForm.appendChild(searchSubmit); searchForm.appendChild(clearSearch); if (single) searchForm.appendChild(searchApplied);
    searchForm.appendChild(searchError); searchForm.appendChild(searchNotice); if (!single) element.appendChild(searchForm);
    let page = initialRecordIndex === undefined ? 0 : Math.floor(initialRecordIndex / PAGE_SIZE); const list = node('div'); list.setAttribute('data-history-preview-list', 'records');
    const range = node('p'); range.id = heading.id + '-record-range'; range.setAttribute('role', 'status'); range.setAttribute('tabindex', '-1'); range.setAttribute('data-history-preview-range', 'records');
    let typeFilter: HTMLSelectElement | undefined, outcomeFilter: HTMLSelectElement | undefined, filterError: HTMLParagraphElement | undefined;
    let fromDate: HTMLInputElement | undefined, throughDate: HTMLInputElement | undefined, dateError: HTMLParagraphElement | undefined;
    let incompleteDates: IncompleteDates = { from: false, through: false };
    const clearDateError = (): void => {
      if (dateError) { dateError.textContent = ''; dateError.hidden = true; }
      fromDate?.setAttribute('aria-invalid', 'false'); throughDate?.setAttribute('aria-invalid', 'false');
    };
    const setDateRange = (dates: DateRange): void => {
      // References can clear one applied boundary. Keep a newer unfinished
      // date draft; untouched fields should reflect the newly applied range.
      if (fromDate && dates.from !== appliedDates.from && fromDate.value === appliedDates.from && !fromDate.validity?.badInput && !incompleteDates.from) fromDate.value = dates.from;
      if (throughDate && dates.through !== appliedDates.through && throughDate.value === appliedDates.through && !throughDate.validity?.badInput && !incompleteDates.through) throughDate.value = dates.through;
      appliedDates = dates;
    };
    const setFilterChoices = (filters: RecordFilters): void => {
      appliedFilters = filters; if (typeFilter) typeFilter.value = filters.type; if (outcomeFilter) outcomeFilter.value = filters.outcome;
      if (filterError) { filterError.textContent = ''; filterError.hidden = true; }
    };
    if (!single) {
      const group = node('fieldset'); group.className = 'authentication-history-preview-filters'; group.setAttribute('data-history-preview-filter', 'controls'); group.appendChild(node('legend', 'Filter this preview'));
      const help = node('p', 'Type and outcome apply right away to the current search. Text you are still typing applies only when you choose Search. Choices describe saved records, not current vendor access. Downloads keep the complete snapshot.'); help.id = heading.id + '-filter-help';
      filterError = node('p'); filterError.id = heading.id + '-filter-error'; filterError.setAttribute('role', 'alert'); filterError.setAttribute('data-history-preview-filter', 'error'); filterError.hidden = true;
      const grid = node('div'); grid.className = 'authentication-history-preview-filter-grid';
      const presentTypes = new Set(entries.map(entry => entry.type)), presentOutcomes = new Set(entries.map(entry => entry.outcome));
      const availableTypes = (Object.keys(types) as PreviewEntry['type'][]).filter(value => presentTypes.has(value));
      const availableOutcomes = (Object.keys(outcomes) as PreviewEntry['outcome'][]).filter(value => presentOutcomes.has(value));
      const select = (key: keyof RecordFilters, title: string, all: string, labels: Readonly<Record<string, string>>, available: readonly string[]): HTMLSelectElement => {
        const field = node('div'), label = node('label', title), control = node('select'); control.id = heading!.id + '-filter-' + key; label.htmlFor = control.id;
        control.setAttribute('data-history-preview-filter', key); control.setAttribute('aria-label', title + ' for ' + heading!.textContent);
        control.setAttribute('aria-describedby', help.id + ' ' + searchApplied.id + ' ' + filterError!.id + ' ' + range.id);
        const option = node('option', all); option.value = ''; control.appendChild(option);
        for (const value of available) { const option = node('option', labels[value]); option.value = value; control.appendChild(option); }
        control.value = ''; field.appendChild(label); field.appendChild(control); grid.appendChild(field); return control;
      };
      typeFilter = select('type', 'Record type', 'All record types', types, availableTypes); outcomeFilter = select('outcome', 'Recorded outcome', 'All recorded outcomes', outcomes, availableOutcomes);
      const change = (control: HTMLSelectElement): void => {
        if (!active(control)) return;
        const type = availableTypes.find(value => value === typeFilter!.value), outcome = availableOutcomes.find(value => value === outcomeFilter!.value);
        if (typeFilter!.value && !type || outcomeFilter!.value && !outcome) {
          typeFilter!.value = appliedFilters.type; outcomeFilter!.value = appliedFilters.outcome;
          filterError!.textContent = 'Choose a record type or recorded outcome shown in this snapshot. Earlier results are unchanged.'; filterError!.hidden = false; return;
        }
        filterError!.textContent = ''; filterError!.hidden = true;
        if (appliedFilters.type === (type ?? '') && appliedFilters.outcome === (outcome ?? '')) return;
        setFilterChoices({ type: type ?? '', outcome: outcome ?? '' }); refreshCriteria(); page = 0; searchNotice.textContent = ''; searchNotice.hidden = true; renderPage();
      };
      typeFilter.addEventListener('change', () => change(typeFilter!)); outcomeFilter.addEventListener('change', () => change(outcomeFilter!));
      const reset = pagingButton('Clear type and outcome filters', 'filter-clear', before => {
        filterError!.textContent = ''; filterError!.hidden = true; if (!appliedFilters.type && !appliedFilters.outcome) return;
        setFilterChoices({ type: '', outcome: '' }); refreshCriteria(); page = 0; searchNotice.textContent = ''; searchNotice.hidden = true; renderPage(undefined, before);
      });
      reset.setAttribute('aria-label', 'Clear type and outcome filters for ' + heading.textContent);
      group.appendChild(grid); group.appendChild(help); group.appendChild(reset); group.appendChild(filterError);
      const dateForm = node('form'); dateForm.className = 'authentication-history-preview-dates'; dateForm.setAttribute('data-history-preview-date', 'form'); dateForm.setAttribute('novalidate', '');
      dateForm.setAttribute('aria-label', 'Filter UTC start dates for ' + heading.textContent);
      const dateHelp = node('p', 'Dates use the record’s original start in UTC and include both selected days. Leave an end empty for no limit. Choose Apply date range, or press Enter in a date field. Unfinished dates and text do not change the results. Downloads keep the complete snapshot.');
      dateHelp.id = heading.id + '-date-help';
      dateError = node('p'); dateError.id = heading.id + '-date-error'; dateError.setAttribute('role', 'alert'); dateError.setAttribute('data-history-preview-date', 'error'); dateError.hidden = true;
      const dateGrid = node('div'); dateGrid.className = 'authentication-history-preview-filter-grid';
      const dateInput = (key: keyof DateRange, title: string): HTMLInputElement => {
        const field = node('div'), label = node('label', title), control = node('input'); control.type = 'date'; control.id = heading!.id + '-date-' + key; label.htmlFor = control.id;
        control.setAttribute('max', '9999-12-31'); control.setAttribute('data-history-preview-date', key); control.setAttribute('aria-label', title + ' for ' + heading!.textContent);
        control.setAttribute('aria-describedby', dateHelp.id + ' ' + searchApplied.id + ' ' + dateError!.id + ' ' + range.id); control.setAttribute('aria-invalid', 'false');
        control.addEventListener('input', () => { if (active(control)) { incompleteDates = { ...incompleteDates, [key]: false }; clearDateError(); } });
        field.appendChild(label); field.appendChild(control); dateGrid.appendChild(field); return control;
      };
      fromDate = dateInput('from', 'Started from (UTC)'); throughDate = dateInput('through', 'Started through (UTC)');
      const applyDates = (): void => {
        const from = fromDate!.value, through = throughDate!.value;
        const validFrom = !incompleteDates.from && fromDate!.validity?.valid !== false && isAuthenticationIncidentHistoryFilters(from ? { from } : {});
        const validThrough = !incompleteDates.through && throughDate!.validity?.valid !== false && isAuthenticationIncidentHistoryFilters(through ? { through } : {});
        const reversed = validFrom && validThrough && !!from && !!through && from > through;
        if (!validFrom || !validThrough || reversed) {
          dateError!.textContent = incompleteDates.from || incompleteDates.through ? INCOMPLETE_DATE_GUIDANCE
            : reversed ? 'The start date must be on or before the end date. Earlier preview results are unchanged.'
              : 'Enter a complete date using the format shown in the field, or clear the field. Earlier preview results are unchanged.';
          dateError!.hidden = false; fromDate!.setAttribute('aria-invalid', String(!validFrom || reversed)); throughDate!.setAttribute('aria-invalid', String(!validThrough || reversed)); return;
        }
        clearDateError(); if (from === appliedDates.from && through === appliedDates.through) return;
        setDateRange({ from, through }); refreshCriteria(); page = 0; searchNotice.textContent = ''; searchNotice.hidden = true; renderPage();
      };
      const dateSubmit = node('button', 'Apply date range'); dateSubmit.type = 'submit'; dateSubmit.setAttribute('data-history-preview-control', 'date-apply');
      dateForm.addEventListener('submit', event => { event.preventDefault(); if (active(dateForm)) applyDates(); });
      const clearDates = pagingButton('Clear date range', 'date-clear', before => {
        incompleteDates = { from: false, through: false }; clearDateError(); fromDate!.value = ''; throughDate!.value = ''; if (!appliedDates.from && !appliedDates.through) return;
        setDateRange({ from: '', through: '' }); refreshCriteria(); page = 0; searchNotice.textContent = ''; searchNotice.hidden = true; renderPage(undefined, before);
      });
      clearDates.setAttribute('aria-label', 'Clear date range for ' + heading.textContent);
      dateForm.appendChild(dateGrid); dateForm.appendChild(dateHelp); dateForm.appendChild(dateSubmit); dateForm.appendChild(clearDates); dateForm.appendChild(dateError); group.appendChild(dateForm);
      // Immediate selects must not implicitly submit an unfinished text query.
      element.appendChild(group); element.appendChild(searchApplied);
    }
    const previous = pagingButton('Previous records', 'previous', before => { page--; renderPage(undefined, before); });
    const next = pagingButton('Next records', 'next', before => { page++; renderPage(undefined, before); });
    // Keep state, rather than parked DOM: leaving a page retires its controls
    // and pending copy feedback. Both directions build a fresh snapshot view.
    type RecordView = { index: number | undefined; page: number; query: string; draft: string; error: string; filters: RecordFilters; filterError: string;
      dates: DateRange; dateDraft: DateRange; dateError: string; dateInvalid: IncompleteDates; dateIncomplete: IncompleteDates };
    const trail: RecordView[] = [], forwardTrail: RecordView[] = [];
    let selectedIndex = initialRecordIndex; let trimmedTrail = false; let navigating = false; let renderVersion = 0;
    const captureView = (index = selectedIndex): RecordView => {
      const position = index === undefined ? -1 : matching.indexOf(index);
      return { index: position >= page * PAGE_SIZE && position < (page + 1) * PAGE_SIZE ? index : undefined,
        page, query: appliedQuery, draft: searchInput.value, error: searchError.hidden ? '' : searchError.textContent ?? '', filters: appliedFilters, filterError: filterError?.hidden ? '' : filterError?.textContent ?? '',
        dates: appliedDates, dateDraft: { from: fromDate?.value ?? '', through: throughDate?.value ?? '' }, dateError: dateError?.hidden ? '' : dateError?.textContent ?? '',
        dateInvalid: { from: fromDate?.getAttribute('aria-invalid') === 'true', through: throughDate?.getAttribute('aria-invalid') === 'true' },
        dateIncomplete: { from: incompleteDates.from || fromDate?.validity?.badInput === true, through: incompleteDates.through || throughDate?.validity?.badInput === true } };
    };
    const navigation = node('nav'); navigation.setAttribute('data-history-preview-navigation', 'records'); navigation.setAttribute('aria-label', 'Saved record navigation'); navigation.hidden = true;
    const navigationStatus = node('p'); navigationStatus.id = heading.id + '-record-navigation'; navigationStatus.setAttribute('role', 'status');
    const navigationControl = (key: string, direction: 'back' | 'forward'): HTMLButtonElement => {
      const source = direction === 'back' ? trail : forwardTrail, destination = direction === 'back' ? forwardTrail : trail;
      let pointerFocus: Element | null | undefined;
      const control = button(direction === 'back' ? 'Back to previous record' : 'Forward to next record', key, event => {
        const pointerOrigin = event.detail > 0 ? pointerFocus : undefined; pointerFocus = undefined;
        if (navigating || !source.length) return;
        const before = doc.activeElement;
        const newerFocus = pointerOrigin !== undefined && before !== pointerOrigin && before !== control && before !== doc.body && !list.contains(before) && before?.isConnected;
        const moveFocus = !newerFocus && (event.detail > 0 || before === control || before === doc.body || list.contains(before) || !before?.isConnected);
        navigating = true;
        try {
          const saved = source.pop()!; destination.push(captureView()); selectedIndex = saved.index;
          setFilterChoices(saved.filters); setDateRange(saved.dates); setAppliedSearch(saved.query); searchInput.value = saved.draft; clearSearchError(); clearDateError();
          if (fromDate) fromDate.value = saved.dateDraft.from; if (throughDate) throughDate.value = saved.dateDraft.through;
          if (saved.dateError && dateError) { dateError.textContent = saved.dateError; dateError.hidden = false; fromDate?.setAttribute('aria-invalid', String(saved.dateInvalid.from)); throughDate?.setAttribute('aria-invalid', String(saved.dateInvalid.through)); }
          // Native partial date segments cannot be serialized through .value.
          // Preserve their refusal after restoration until an explicit edit.
          incompleteDates = saved.dateIncomplete;
          if ((incompleteDates.from || incompleteDates.through) && dateError) {
            dateError.textContent = INCOMPLETE_DATE_GUIDANCE; dateError.hidden = false;
            fromDate?.setAttribute('aria-invalid', String(incompleteDates.from || saved.dateInvalid.from)); throughDate?.setAttribute('aria-invalid', String(incompleteDates.through || saved.dateInvalid.through));
          }
          if (saved.filterError && filterError) { filterError.textContent = saved.filterError; filterError.hidden = false; }
          if (saved.error) { searchError.textContent = saved.error; searchError.hidden = false; searchInput.setAttribute('aria-invalid', 'true'); }
          page = saved.page; searchNotice.textContent = (direction === 'back' ? 'Previous' : 'Next') + ' preview restored with its search, filters and page.'; searchNotice.hidden = false;
          renderPage(saved.index, undefined, moveFocus, true);
        } finally { navigating = false; }
      });
      control.addEventListener('pointerdown', () => { pointerFocus = active(control) ? doc.activeElement : undefined; });
      // Some browsers focus buttons on pointerdown; WebKit may keep the old
      // field. A later outside focus change belongs to its newer owner.
      control.addEventListener('focus', () => { if (pointerFocus !== undefined && active(control)) pointerFocus = control; });
      control.addEventListener('pointercancel', () => { pointerFocus = undefined; });
      control.setAttribute('aria-describedby', navigationStatus.id); return control;
    };
    const back = navigationControl('previous-record', 'back'), forward = navigationControl('next-record', 'forward');
    navigation.appendChild(back); navigation.appendChild(forward); navigation.appendChild(navigationStatus);
    const updateNavigation = (): void => {
      navigation.hidden = !trail.length && !forwardTrail.length && !trimmedTrail; back.disabled = !trail.length; forward.disabled = !forwardTrail.length;
      const describe = (steps: RecordView[], direction: 'Back' | 'Forward', label: 'previous' | 'next'): string => {
        const saved = steps[steps.length - 1], entry = saved?.index === undefined ? undefined : entries[saved.index];
        if (!saved) return 'No ' + label + ' records remain in this trail.';
        return (entry ? direction + ' returns to ' + types[entry.type].toLowerCase() + ' ' + entry.record.id + '. Search, filters and page are restored.'
          : direction + ' restores the ' + label + ' preview search, filters and page. No record was selected on that page.')
          + ' ' + steps.length + ' ' + label + ' record' + (steps.length === 1 ? '' : 's') + '.';
      };
      navigationStatus.textContent = describe(trail, 'Back', 'previous') + ' ' + describe(forwardTrail, 'Forward', 'next')
        + (trimmedTrail ? ' Only the last ' + RECORD_TRAIL_LIMIT + ' steps were kept. Earlier steps are no longer available.' : ' Keeps up to ' + RECORD_TRAIL_LIMIT + ' steps across Back and Forward.');
    };
    if (single) { element.appendChild(list); element.appendChild(searchForm); element.appendChild(range); element.appendChild(supporting); }
    else { element.appendChild(navigation); element.appendChild(range); element.appendChild(previous); element.appendChild(next); element.appendChild(list); }
    const reference = (parent: HTMLElement, kind: 'incident' | 'repair' | 'verification' | 'renewal', id: string, originIndex: number): void => {
      const target = byId.get(id); parent.appendChild(node('p', `${types[kind]} reference: ${id}`));
      if (single) { parent.appendChild(node('p', (savedContext ? 'Other referenced records are not included.' : 'Referenced record context is not included.') + ' Open the source report or related history bundle to view other records.')); return; }
      if (!target || target.entry.type !== kind) { parent.appendChild(node('p', 'Referenced record is not included in this snapshot.')); return; }
      if (!matchesCriteria(target.entry)) parent.appendChild(node('p', 'This record is outside the preview filters. Viewing it clears only the search or filter choices that hide it. Back restores the earlier choices.'));
      else if (!matching.includes(target.index)) parent.appendChild(node('p', 'This record is outside the preview search. Viewing it clears the preview search.'));
      parent.appendChild(button('View referenced ' + types[kind].toLowerCase(), 'reference', () => {
        if (navigating) return; navigating = true;
        try {
          forwardTrail.length = 0; trail.push(captureView(originIndex));
          if (trail.length > RECORD_TRAIL_LIMIT) { trail.shift(); trimmedTrail = true; }
          let position = matching.indexOf(target.index);
          if (position < 0) {
            const blockedByFilters = !matchesCriteria(target.entry), blockedBySearch = appliedSearch && !searchIndex![target.index]!.includes(appliedSearch);
            setFilterChoices({ type: appliedFilters.type && target.entry.type !== appliedFilters.type ? '' : appliedFilters.type, outcome: appliedFilters.outcome && target.entry.outcome !== appliedFilters.outcome ? '' : appliedFilters.outcome });
            setDateRange({ from: appliedDates.from && target.entry.record.started_at < Date.parse(appliedDates.from + 'T00:00:00Z') ? '' : appliedDates.from,
              through: appliedDates.through && target.entry.record.started_at >= Date.parse(appliedDates.through + 'T00:00:00Z') + 86_400_000 ? '' : appliedDates.through });
            if (blockedBySearch) { searchInput.value = ''; clearSearchError(); setAppliedSearch(''); } else refreshCriteria();
            position = matching.indexOf(target.index);
            searchNotice.textContent = blockedByFilters ? 'Preview criteria that hid the referenced record were cleared. Back to previous record restores the earlier search, filters and page.' : 'Preview search cleared to show the referenced record. Back to previous record restores it.'; searchNotice.hidden = false;
          } else { searchNotice.textContent = 'Referenced record opened. Back to previous record restores the earlier search and page.'; searchNotice.hidden = false; }
          selectedIndex = target.index; page = Math.floor(position / PAGE_SIZE); renderPage(target.index);
        } finally { navigating = false; }
      }));
    };
    const renderPage = (focusIndex?: number, pointerFocus?: Element | null, moveFocus = true, restoring = false): void => {
      const rendered = ++renderVersion; recordFocus = undefined;
      const currentRender = (): boolean => active(list) && rendered === renderVersion;
      // Disabling navigation or removing the old records can synchronously
      // blur their focused control. Capture ownership before either mutation.
      const focused = doc.activeElement === previous ? previous : doc.activeElement === next ? next : undefined;
      const before = doc.activeElement === doc.body ? pointerFocus ?? doc.activeElement : doc.activeElement;
      const removedFocus = list.contains(before) ? before : undefined;
      const mayFocus = (): boolean => moveFocus && (doc.activeElement === before || doc.activeElement === doc.body || list.contains(doc.activeElement) || !doc.activeElement?.isConnected);
      updateNavigation(); if (!currentRender()) return;
      clearReturn(); if (!currentRender()) return;
      // A blur handler may build a newer page inside removeChild. Never let
      // the departing render empty that newer list or resume its own work.
      while (list.firstChild && currentRender()) list.removeChild(list.firstChild);
      if (!currentRender()) return;
      const start = page * PAGE_SIZE; const end = Math.min(start + PAGE_SIZE, matching.length);
      const filtered = appliedFilters.type || appliedFilters.outcome || appliedDates.from || appliedDates.through;
      range.textContent = single ? appliedSearch ? matching.length ? 'The saved record matches this preview search.' : 'The saved record does not match this preview search. The complete record is still included in the download.' : '1 saved record.' : appliedSearch || filtered ? matching.length ? `Matching records ${start + 1}–${end} of ${matching.length} (${entries.length} in snapshot).`
        : `No records match ${appliedSearch ? filtered ? 'this preview search and these filters' : 'this preview search' : 'these preview filters'}. All ${entries.length} snapshot records are still included in the download.`
        : entries.length ? `Records ${start + 1}–${end} of ${entries.length}` : 'No retained entries matched these filters.';
      previous.disabled = page === 0; if (!currentRender()) return;
      next.disabled = end >= matching.length; if (!currentRender()) return;
      const focusRendered = (target: HTMLElement): void => {
        if (!currentRender() || !active(target) || !mayFocus()) return;
        target.getBoundingClientRect?.(); target.focus({ preventScroll: true });
        if (active(target) && rendered === renderVersion && doc.activeElement === target) target.scrollIntoView?.({ block: 'nearest' });
      };
      if (restoring && (focusIndex === undefined || !matching.slice(start, end).includes(focusIndex))) {
        recordFocus = range; focusRendered(range);
      } else if (focusIndex === undefined && mayFocus() && (focused?.disabled || removedFocus && (doc.activeElement === removedFocus || doc.activeElement === doc.body))) {
        range.focus({ preventScroll: true });
        if (currentRender() && doc.activeElement === range) range.scrollIntoView?.({ block: 'nearest' });
      }
      for (const index of matching.slice(start, end)) {
        if (!currentRender()) return;
        const entry = entries[index]!; const record = entry.record; const disclosure = node('details'); disclosure.setAttribute('data-history-preview-record', String(index));
        const label = 'group' in record && 'label' in record.group ? record.group.label : 'app_label' in record ? record.app_label : undefined;
        const summary = node('summary', single ? 'Inspect record fields' : `${types[entry.type]} · ${outcomes[entry.outcome]} · ${label ? label + ' · ' : ''}${record.id}`); disclosure.appendChild(summary); list.appendChild(disclosure);
        if (index === focusIndex) {
          recordFocus = summary; summary.setAttribute('tabindex', '0');
          if (trail.length) disclosure.appendChild(navigationControl('return-record', 'back'));
          if (forwardTrail.length) disclosure.appendChild(navigationControl('forward-record', 'forward'));
        }
        if (index === initialRecordIndex) {
          disclosure.setAttribute('data-history-preview-source-record', 'true');
          summary.setAttribute('tabindex', '0');
          const position = node('p', sourceTitle + ' source record ' + (index + 1) + ' of ' + entries.length + '. Opened from the comparison; its filters and page are kept.');
          position.id = heading!.id + '-source-record'; position.setAttribute('data-history-preview-source-position', String(index + 1));
          summary.setAttribute('aria-describedby', position.id); disclosure.appendChild(position);
          const back = button('Back to comparison', 'return-comparison', close); back.setAttribute('aria-describedby', position.id); disclosure.appendChild(back);
        }
        const recordQuery = appliedQuery; const firstMatches = recordQuery ? previewMatches(entry, recordQuery) : undefined;
        if (firstMatches?.total) {
          const hint = node('span', `${firstMatches.total} matching field${firstMatches.total === 1 ? '' : 's'}. First: ${firstMatches.matches[0]!.label}`);
          hint.className = 'authentication-history-preview-match-summary'; summary.appendChild(hint);
        }
        let populated = false; let revealMetadata: RevealField | undefined; let revealRecord: RevealField | undefined;
        const populate = (): void => {
          if (!active(disclosure) || populated) return; populated = true;
          const recordLabel = types[entry.type] + ' · ' + record.id;
          const sourceContext = contextFor(index);
          const sourcePosition = sourceContext?.source_position;
          const { element: actions, fileId } = createAuthenticationHistoryRecordActions({ document: doc, entry,
            file: single ? { filename: live ? value.filename : 'recued-opened-connection-history-record-' + entry.type + '.json' }
              : { snapshotFilename: value.filename, ...(sourcePosition === undefined ? {} : { sourcePosition: sourcePosition - 1 }) },
            ...(sourceContext ? { sourceContext } : {}), origin: summary, active, download }); disclosure.appendChild(actions);
          if (entry.type === 'incident') {
            const timeline = node('details'); timeline.className = 'authentication-history-preview-copy'; timeline.setAttribute('data-history-preview-support', 'timeline');
            const timelineSummary = node('summary', 'Support timeline'); timeline.appendChild(timelineSummary); disclosure.appendChild(timeline);
            let ready = false;
            timeline.addEventListener('toggle', () => {
              if (!active(timeline) || !timeline.open || ready) return; ready = true;
              const hasBundle = relatedBundle && (!opened?.bundle || entry.record.id === opened.bundle.report.root.id);
              timeline.appendChild(node('p', (hasBundle ? 'Copies this incident and records connected by saved references in the captured snapshot. Shared repairs may include other incidents.'
                : 'Copies this saved incident only. Other records are not included; related history cannot be discovered from it.')
                + (privateMode ? ' Uses the saved aliases; matching aliases from separate files do not establish a link.' : ' Includes saved names and IDs for local use. Review before sharing.')
                + ' Current vendor access is not checked. Repairs, read checks, renewal and recovery remain separate observations.'));
              timeline.appendChild(createAuthenticationHistoryCopy({ kind: 'timeline', document: doc, label: recordLabel, origin: timelineSummary, active,
                raw: () => prepareAuthenticationHistorySupportTimeline(hasBundle ? { bundle: relatedBundle!(index) }
                  : { entry, representation: privateMode ? 'aliases' : 'full', ...(sourceContext ? { context: sourceContext } : {}) }).text }));
            });
          }
          if (entry.type === 'incident' && relatedBundle && (!opened?.bundle || entry.record.id === opened.bundle.report.root.id)) {
            const related = node('details'); related.className = 'authentication-history-preview-copy'; related.setAttribute('data-history-preview-related', 'bundle');
            const relatedSummary = node('summary', 'Related history bundle'); relatedSummary.setAttribute('tabindex', '0'); related.appendChild(relatedSummary); disclosure.appendChild(related);
            let reviewed = false;
            related.addEventListener('toggle', () => {
              if (!active(related) || !related.open || reviewed) return; reviewed = true;
              const bundle = relatedBundle(index); const { counts, entry_count, missing_reference_count, incomplete_record_count } = bundle.report;
              const counted = (count: number, label: string): string => count + ' ' + label + (count === 1 ? '' : 's');
              const scope = node('p', `${counted(entry_count, 'saved record')}: ${counted(counts.incident, 'incident')} · ${counted(counts.repair, 'repair')} · ${counted(counts.verification, 'access check')} · ${counted(counts.renewal, 'token renewal')}.`);
              scope.setAttribute('data-history-preview-related', 'counts'); scope.id = fileId + '-related-scope'; related.appendChild(scope);
              const help = node('p', "Follows saved record references in both directions across this snapshot, including records hidden by preview search or filters. Shared repairs can include other incidents. Uses this preview's privacy mode and preserves saved values and any snapshot aliases.");
              help.id = fileId + '-related-help'; related.appendChild(help);
              related.appendChild(node('p', 'Snapshot scope, filters, retention and saved detail limits still apply. Excluded or unrecorded links cannot be discovered. Related records do not prove that a repair caused recovery or that current access works.'));
              const limits = node('p', `${counted(missing_reference_count, 'missing reference')} · ${counted(incomplete_record_count, 'record')} with saved incomplete-detail flags. Zero does not establish complete history.`);
              limits.id = fileId + '-related-limits'; limits.setAttribute('data-history-preview-related', 'limits'); related.appendChild(limits);
              if (missing_reference_count) detail(related, 'missing_references', bundle.report.missing_references);
              const bundleFile = node('p', 'File: '); bundleFile.id = fileId + '-related-file'; bundleFile.appendChild(node('code', bundle.filename)); related.appendChild(bundleFile);
              const status = node('p'); status.id = bundleFile.id + '-status'; status.hidden = true; status.setAttribute('role', 'status'); status.setAttribute('data-history-preview-related', 'status');
              const error = node('p'); error.id = bundleFile.id + '-error'; error.hidden = true; error.setAttribute('role', 'alert'); error.setAttribute('data-history-preview-related', 'error');
              let downloadingBundle = false;
              const saveBundle = button('Download related history (JSON)', 'download-related', event => {
                if (downloadingBundle) return; downloadingBundle = true;
                try {
                  if (event.detail > 0 && (doc.activeElement === summary || doc.activeElement === relatedSummary || doc.activeElement === doc.body)) saveBundle.focus({ preventScroll: true });
                  if (!active(saveBundle) || saveBundle.disabled) return;
                  const prepared = prepareAuthenticationHistoryRelatedDownload(bundle); download(prepared.filename, prepared.json); if (!active(saveBundle)) return;
                  error.textContent = ''; error.hidden = true; status.textContent = 'Related history download requested.'; status.hidden = false;
                } catch {
                  if (!active(saveBundle)) return;
                  status.textContent = ''; status.hidden = true; error.textContent = 'The related history download could not start. Try again, use Copy related history as JSON, or capture a smaller history export. The bundle must fit within 8 MiB.'; error.hidden = false;
                } finally { downloadingBundle = false; }
              });
              saveBundle.setAttribute('aria-label', 'Download related history as JSON: ' + recordLabel);
              saveBundle.setAttribute('aria-describedby', scope.id + ' ' + help.id + ' ' + limits.id + ' ' + bundleFile.id + ' ' + status.id + ' ' + error.id);
              related.appendChild(createAuthenticationHistoryCopy({ kind: 'bundle', document: doc,
                raw: () => prepareAuthenticationHistoryRelatedDownload(bundle).json, label: 'Incident ' + bundle.report.root.id,
                origin: relatedSummary, active, additionalAction: saveBundle }));
              related.appendChild(status); related.appendChild(error);
              related.appendChild(createAuthenticationHistoryRelatedBrowser({ document: doc, bundle, active, snapshotFilename: value.filename, download,
                sourcePosition: entry => byId.get(entry.record.id)!.index,
                sourceContext: entry => contextFor(byId.get(entry.record.id)!.index),
                returnToDownload: () => { if (active(saveBundle)) { saveBundle.focus({ preventScroll: true }); saveBundle.scrollIntoView?.({ block: 'nearest' }); } },
              }));
            });
          }
          if (firstMatches?.total) matchingFields({ parent: disclosure, summary, entry, query: recordQuery, firstMatches,
            open: () => { disclosure.open = true; populate(); },
            reveal: path => path[0] === 'record' ? revealRecord?.(path.slice(1)) : revealMetadata?.(path),
          });
          if ('selection' in record && record.selection.kind !== 'group') reference(disclosure, record.selection.kind, record.selection.id, index);
          if ('incidents' in record) for (const incident of record.incidents) reference(disclosure, 'incident', incident.id, index);
          revealMetadata = fields(disclosure, { type: entry.type, outcome: entry.outcome }, []); revealRecord = fields(disclosure, record, ['record']);
        };
        disclosure.addEventListener('toggle', () => { if (disclosure.open) populate(); });
        if (index === focusIndex) {
          disclosure.open = true; populate();
          focusRendered(summary);
        }
      }
    };
    renderPage(initialRecordIndex, undefined, false);
  };
  return { element, show, clear, hasSnapshot: (): boolean => snapshot !== undefined,
    focus: (): void => {
      const target = recordFocus && element.contains(recordFocus) ? recordFocus : heading; const epoch = version; if (disposed || !target) return;
      // WebKit needs layout before a summary in newly opened details can focus.
      if (target === recordFocus) target.getBoundingClientRect?.();
      target.focus({ preventScroll: true });
      // A focus handler can redirect focus or replace this preview. Keep its
      // newer scroll intent instead of scrolling an abandoned target.
      if (!disposed && version === epoch && element.contains(target) && doc.activeElement === target) target.scrollIntoView?.({ block: target === heading ? 'start' : 'nearest' });
    },
    dispose: (): void => { disposed = true; clear(); } };
};


const AUTHENTICATION_HISTORY_REPORT_FILTER_STYLES = `.authentication-history-preview-dates{border-top:1px solid var(--border);margin-top:16px;padding-top:16px}.authentication-history-preview-filters{border:0;padding:0;min-width:0;margin:12px 0}.authentication-history-preview-filters legend{font-weight:600}.authentication-history-preview-filter-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(180px,100%),1fr));gap:12px}.authentication-history-preview-filter-grid>div{min-width:0}.authentication-history-preview-filter-grid label{display:block;font-weight:600;margin-bottom:4px}.authentication-history-preview-filter-grid select,.authentication-history-preview-dates input{box-sizing:border-box;width:100%;min-width:0;height:44px;min-height:44px;font:inherit;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--fg)}.authentication-history-preview-filters>button,.authentication-history-preview-dates button{min-height:44px;max-width:100%;white-space:normal;margin:8px 0}`;

export const AUTHENTICATION_HISTORY_PREVIEW_STYLES = `.authentication-history-preview [data-history-preview-navigation]:not([hidden]){display:flex;flex-wrap:wrap;gap:8px;border:1px solid var(--border);border-radius:6px;padding:8px;margin:12px 0}.authentication-history-preview [data-history-preview-navigation] p{flex-basis:100%;margin:8px 0 0}.authentication-history-preview [data-history-preview-control="previous-record"],.authentication-history-preview [data-history-preview-control="return-record"],.authentication-history-preview [data-history-preview-control="next-record"],.authentication-history-preview [data-history-preview-control="forward-record"]{box-sizing:border-box;min-height:44px;max-width:100%;white-space:normal;margin:8px 0}.authentication-history-preview [data-history-preview-source-record="true"]>summary{border-left:3px solid var(--accent,#2f6feb);padding-left:8px}` + `.authentication-history-preview .authentication-history-record-context-choice{display:flex;align-items:center;gap:8px;min-height:44px;cursor:pointer}.authentication-history-record-context-choice input{flex:0 0 auto;width:20px;height:20px;margin:0}.authentication-history-preview{border:1px solid var(--border);border-radius:8px;padding:12px;margin:16px 0;min-width:0;overflow-wrap:anywhere}.authentication-history-preview dl{margin:8px 0}.authentication-history-preview dt{font-weight:600;margin-top:8px}.authentication-history-preview dd{margin:2px 0 8px 12px;min-width:0}.authentication-history-preview details{border-top:1px solid var(--border);padding:8px 0}.authentication-history-preview summary{cursor:pointer;min-height:44px;overflow-wrap:anywhere}.authentication-history-preview code{white-space:pre-wrap;overflow-wrap:anywhere}.authentication-history-preview ol{padding-left:24px}.authentication-history-preview [data-history-preview-counts]{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px}.authentication-history-preview [data-history-preview-counts]>dt,.authentication-history-preview [data-history-preview-counts]>dd{margin:0}.authentication-history-preview-search{margin:16px 0}.authentication-history-preview-search label{display:block;font-weight:600;margin-bottom:4px}.authentication-history-preview-search input{box-sizing:border-box;width:100%;min-width:0;min-height:44px;font:inherit;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--fg)}.authentication-history-preview-match-summary{display:block;font-size:12px;margin-top:4px}.authentication-history-preview-matches{border:1px solid var(--border);border-radius:6px;padding:8px;margin:12px 0}.authentication-history-preview-matches h4{margin:0}.authentication-history-preview-matches li{margin:12px 0}.authentication-history-preview-matches li p{margin:4px 0}.authentication-history-preview-matches li code{display:block}.authentication-history-preview [data-history-preview-highlight="match"]{background:var(--accent-weak,rgba(14,116,144,.15));color:inherit;text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:2px;box-decoration-break:clone}.authentication-history-preview [data-history-preview-value-highlight][aria-current="true"]{outline:2px solid var(--accent,#2f6feb);outline-offset:1px}.authentication-history-preview-hits{position:sticky;bottom:8px;z-index:1;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;box-sizing:border-box;width:100%;max-width:340px;padding:8px;margin:8px 0;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--fg)}.authentication-history-preview-hits>p{grid-column:1/-1;margin:0;font-size:12px}.authentication-history-preview-hits button{min-width:0;min-height:44px;padding:4px;white-space:normal}.authentication-history-preview-return{display:block;min-height:44px;max-width:100%;margin:8px 0;white-space:normal}.authentication-history-preview [data-history-preview-match-target="true"]{outline:2px solid var(--accent,#2f6feb);outline-offset:2px}.authentication-history-preview [data-history-preview-summary] p{margin:6px 0}.authentication-history-preview [data-history-preview-summary="notice"]{margin:12px 0}` + AUTHENTICATION_HISTORY_VALUE_COPY_STYLES + AUTHENTICATION_HISTORY_RELATED_BROWSER_STYLES + AUTHENTICATION_HISTORY_REPORT_FILTER_STYLES;
