import { authenticationHistoryComparisonSnapshot, compareAuthenticationHistorySnapshots, authenticationHistoryComparisonFieldValues, historyComparisonLabels as labels, HistoryComparisonError,
  type AuthenticationHistoryComparison, type HistoryComparisonKind } from './authentication-history-comparison.js';
import { openAuthenticationHistoryFile, type OpenedAuthenticationHistoryFile } from './authentication-history-saved-file.js';
import { createAuthenticationHistoryPreview } from './authentication-history-preview.js';
import { authenticationHistoryRecordContext, prepareAuthenticationHistoryContextRecord } from './authentication-history-record-context.js';
import { previewRecordTypes, previewRecordedOutcomes, previewTitle } from './authentication-history-preview-fields.js';
import { prepareAuthenticationHistoryComparisonSummary } from './authentication-history-comparison-summary.js';
import { createAuthenticationHistoryCopy, scrollAuthenticationHistoryText } from './authentication-history-preview-copy.js';
import { downloadAuthenticationHistory, downloadAuthenticationHistoryText } from './authentication-history-export.js';
import { prepareAuthenticationHistoryComparisonPair } from './authentication-history-comparison-pair.js';

let comparisonCounter = 0;
const PAGE_SIZE = 20;
type Selection = { source: OpenedAuthenticationHistoryFile; label: string };

/** Two captured local reports, independent of live history, export privacy and
 * unapplied file/paste drafts. No vendor operations or persistent browser data. */
export const createAuthenticationHistoryComparisonPanel = (deps: { document: Document; download?(filename: string, json: string): void; downloadText?(filename: string, text: string): void }) => {
  const doc = deps.document, id = 'history-comparison-' + ++comparisonCounter;
  const download = deps.download ?? ((filename: string, json: string): void => downloadAuthenticationHistory(doc, filename, json));
  const downloadText = deps.downloadText ?? ((filename: string, text: string): void => downloadAuthenticationHistoryText(doc, filename, text));
  let disposed = false, reading = false, epoch = 0, page = 0;
  let current: Selection | undefined, baseline: Selection | undefined, result: AuthenticationHistoryComparison | undefined;
  let sourceLabels: Record<'baseline' | 'comparison', string> | undefined;
  let swap: HTMLButtonElement | undefined;
  let inspectedOrigin: HTMLElement | undefined, inspectedReturnKey: string | undefined, inspectingSource = false, appliedQuery = '';
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const el = doc.createElement(tag); if (text !== undefined) el.textContent = text; return el;
  };
  const empty = (el: HTMLElement): void => { while (el.firstChild) el.removeChild(el.firstChild); };
  const element = node('details'); element.className = 'authentication-history-comparison'; element.setAttribute('data-history-compare', 'panel');
  const summary = node('summary', 'Compare saved snapshots'); summary.setAttribute('tabindex', '0'); summary.setAttribute('data-history-compare', 'summary'); element.appendChild(summary);
  const help = node('p', 'Open a complete Names and IDs report, use it as the baseline, then open another report and compare. Use exports from the same Recued server. Separate alias files cannot be matched.'); help.id = id + '-help'; element.appendChild(help);
  element.appendChild(node('p', 'Names and IDs stay in this browser tab for local use. Matches use saved record type and ID; this cannot verify the source server or vendor account. Current access is not checked.'));
  const active = (control: HTMLElement): boolean => !disposed && element.contains(control);
  const focus = (target: HTMLElement): void => { if (active(target)) { target.focus({ preventScroll: true }); if (doc.activeElement === target && active(target)) target.scrollIntoView?.({ block: 'nearest' }); } };
  const button = (text: string, key: string, action: () => void): HTMLButtonElement => {
    const el = node('button', text); el.type = 'button'; el.setAttribute('data-history-compare-control', key);
    el.addEventListener('click', () => { if (active(el) && !el.disabled) action(); }); return el;
  };
  const candidate = (): string => {
    if (!current) return 'Open a complete Names and IDs history report to begin.';
    try { authenticationHistoryComparisonSnapshot(current.source); return ''; }
    catch (err) { return err instanceof HistoryComparisonError ? err.message : 'This report cannot be used for comparison.'; }
  };
  const eligibility = node('p'); eligibility.id = id + '-eligibility'; eligibility.setAttribute('data-history-compare', 'eligibility');
  const baselineInfo = node('div'); baselineInfo.setAttribute('data-history-compare', 'baseline');
  const error = node('p'); error.hidden = true; error.setAttribute('role', 'alert'); error.setAttribute('data-history-compare', 'error');
  const results = node('section'); results.hidden = true; results.setAttribute('data-history-compare', 'results');
  const heading = node('h4', 'Saved snapshot comparison'); heading.setAttribute('tabindex', '-1'); heading.setAttribute('data-history-compare', 'heading'); results.appendChild(heading);
  const sources = node('div'); sources.setAttribute('data-history-compare', 'sources'); results.appendChild(sources);
  const sourceActions = node('div'); sourceActions.setAttribute('data-history-compare', 'source-actions'); results.appendChild(sourceActions);
  const direction = node('div'); direction.setAttribute('data-history-compare', 'direction'); results.appendChild(direction);
  const counts = node('p'); counts.setAttribute('data-history-compare', 'counts'); results.appendChild(counts);
  const caveats = node('p'); caveats.setAttribute('data-history-compare', 'limits'); results.appendChild(caveats);
  const support = node('div'); support.setAttribute('data-history-compare', 'support'); results.appendChild(support);
  results.appendChild(node('p', 'Only in comparison means absent from the selected baseline; it need not be a new incident. Only in baseline does not establish recovery, deletion or revoked access. Array order changes count as changed saved data.'));
  results.appendChild(node('p', 'Expand a changed field to compare its saved JSON values. A missing field was not included in that report; it does not prove removal. Large values use compact formatting.'));
  const filterLabel = node('label', 'Show records'); filterLabel.htmlFor = id + '-filter'; results.appendChild(filterLabel);
  const filter = node('select'); filter.id = filterLabel.htmlFor; filter.setAttribute('data-history-compare', 'filter');
  for (const [value, text] of [['differences', 'All differences'] as const, ...Object.entries(labels)]) { const option = node('option', text); option.value = value; filter.appendChild(option); } filter.value = 'differences'; results.appendChild(filter);
  const form = node('form'); form.setAttribute('aria-label', 'Search snapshot comparison');
  const queryLabel = node('label', 'Find saved record ID'); queryLabel.htmlFor = id + '-query';
  const query = node('input'); query.id = queryLabel.htmlFor; query.type = 'search'; query.setAttribute('maxlength', '200'); query.setAttribute('data-history-compare', 'query');
  const searchError = node('p'); searchError.hidden = true; searchError.setAttribute('id', id + '-search-error'); searchError.setAttribute('role', 'alert'); searchError.setAttribute('data-history-compare', 'search-error');
  query.setAttribute('aria-describedby', searchError.getAttribute('id')!);
  const clearSearchError = (): void => { searchError.hidden = true; searchError.textContent = ''; query.setAttribute('aria-invalid', 'false'); };
  const search = node('button', 'Find ID'); search.type = 'submit'; search.setAttribute('data-history-compare-control', 'search');
  const clearQuery = button('Clear ID search', 'clear-search', () => { query.value = ''; clearSearchError(); appliedQuery = ''; page = 0; renderRows(); focus(query); });
  form.appendChild(queryLabel); form.appendChild(query); form.appendChild(searchError); form.appendChild(search); form.appendChild(clearQuery); results.appendChild(form);
  const range = node('p'); range.setAttribute('role', 'status'); range.setAttribute('tabindex', '-1'); range.setAttribute('data-history-compare', 'range'); results.appendChild(range);
  const returnNotice = node('p'); returnNotice.hidden = true; returnNotice.setAttribute('role', 'status'); returnNotice.setAttribute('data-history-compare', 'source-return'); results.appendChild(returnNotice);
  const clearReturnNotice = (): void => { returnNotice.textContent = ''; returnNotice.hidden = true; };
  const previous = button('Previous comparison records', 'previous', () => { page--; renderRows(); focus(previous.disabled ? range : previous); });
  const next = button('Next comparison records', 'next', () => { page++; renderRows(); focus(next.disabled ? range : next); });
  results.appendChild(previous); results.appendChild(next);
  const list = node('div'); list.setAttribute('data-history-compare', 'list'); results.appendChild(list);
  const inspector = createAuthenticationHistoryPreview({ document: doc, ...(deps.download ? { download: deps.download } : {}), closed: () => {
    const origin = inspectedOrigin, key = inspectedReturnKey; inspectedOrigin = undefined; inspectedReturnKey = undefined; inspectingSource = false;
    const visible = key ? list.querySelector<HTMLButtonElement>('[data-history-compare-control="' + key + '"]') : null;
    if (key && !visible) { returnNotice.textContent = 'Source report closed. Its comparison record is outside this view. Your current filters and page are unchanged.'; returnNotice.hidden = false; }
    if (!disposed && (doc.activeElement === doc.body || !doc.activeElement?.isConnected)) focus(origin && active(origin) ? origin : visible ?? (key ? range : heading));
  } });
  inspector.element.setAttribute('data-history-preview', 'comparison-record'); results.appendChild(inspector.element);
  const clearResults = (): void => {
    const chosen = doc.activeElement; const ownedFocus = results.contains(chosen);
    epoch++; result = undefined; sourceLabels = undefined; swap = undefined; inspectedOrigin = undefined; inspectedReturnKey = undefined; inspectingSource = false; inspector.clear(); empty(list); empty(sources); empty(sourceActions); empty(direction); empty(support); results.hidden = true; error.hidden = true; clearSearchError(); clearReturnNotice(); page = 0;
    if (ownedFocus && (doc.activeElement === chosen || doc.activeElement === doc.body || !doc.activeElement?.isConnected)) focus(summary);
  };
  const update = (): void => {
    if (disposed) return;
    const reason = candidate(); eligibility.textContent = reading ? 'Reading another file. Comparison actions resume when it is ready.' : reason || (baseline?.source === current?.source ? 'The opened report is the selected baseline. Open another report to compare.' + (result ? ' You can also swap the displayed sides again.' : '') : 'The opened report can be used for comparison.');
    pin.disabled = reading || !!reason; compare.disabled = reading || !baseline || !!reason || baseline.source === current?.source; clearBaseline.disabled = !baseline;
    if (swap) swap.disabled = reading;
    element.setAttribute('aria-busy', String(reading)); empty(baselineInfo);
    if (baseline) {
      const report = authenticationHistoryComparisonSnapshot(baseline.source).report;
      baselineInfo.appendChild(node('p', 'Baseline: ' + baseline.label + ' · ' + report.entry_count + ' saved records · captured (UTC) ' + new Date(report.exported_at).toISOString() + '.'));
    } else baselineInfo.appendChild(node('p', 'No baseline selected.'));
  };
  const pin = button('Use opened report as baseline', 'baseline', () => {
    if (reading || candidate() || !current) return;
    clearResults(); baseline = current; update();
  }); pin.setAttribute('aria-describedby', help.id + ' ' + eligibility.id);
  const showSource = (capture: AuthenticationHistoryComparison, side: 'baseline' | 'comparison', label: string, origin: HTMLElement, feedback: HTMLElement, recordIndex?: number): void => {
    if (result !== capture || !active(origin)) return;
    try {
      inspector.show(capture[side], { source: 'comparison', side, label, ...(recordIndex === undefined ? {} : { recordIndex }) });
      if (result !== capture || !active(origin)) return;
      inspectingSource = true; inspectedOrigin = origin; inspectedReturnKey = recordIndex === undefined ? undefined : origin.getAttribute('data-history-compare-control') ?? undefined;
      clearReturnNotice(); feedback.hidden = true; feedback.textContent = ''; inspector.focus();
    } catch {
      if (active(origin) && result === capture) { feedback.textContent = (side === 'baseline' ? 'Baseline' : 'Comparison') + ' source report could not be opened. Try again or open the source JSON in Open saved history.'; feedback.hidden = false; }
    }
  };
  function showComparison(prepared: AuthenticationHistoryComparison, before: Selection, after: Selection): void {
    clearResults(); result = prepared; sourceLabels = { baseline: before.label, comparison: after.label }; filter.value = 'differences'; query.value = ''; query.setAttribute('aria-invalid', 'false'); appliedQuery = ''; results.hidden = false;
    empty(sources);
    for (const [title, snapshot, name] of [['Baseline', prepared.baseline, before.label], ['Comparison', prepared.comparison, after.label]] as const) {
      const source = node('details'); source.appendChild(node('summary', title + ': ' + name));
      source.appendChild(node('pre', JSON.stringify({ captured_utc: new Date(snapshot.report.exported_at).toISOString(), scope: snapshot.report.scope,
        filters: snapshot.report.filters, retained_records: snapshot.count, retention_days: snapshot.report.retention_days, finished_record_limit: snapshot.report.finished_record_limit }, null, 2)));
      sources.appendChild(source);
    }
    const sourceHelp = node('p', 'Open either complete source report in the inspector below. Its search and paging stay separate from the comparison. Download saves that whole report. Save comparison pair (JSON) keeps both reports.');
    sourceHelp.id = id + '-source-help'; sourceActions.appendChild(sourceHelp);
    for (const side of ['baseline', 'comparison'] as const) {
      const selection = side === 'baseline' ? before : after;
      const feedback = node('p'); feedback.hidden = true; feedback.id = id + '-source-error-' + side;
      feedback.setAttribute('role', 'alert'); feedback.setAttribute('data-history-compare-source-error', side);
      const openSource = button('Open ' + side + ' report', 'open-' + side, () => {
        showSource(prepared, side, selection.label, openSource, feedback);
      });
      openSource.setAttribute('aria-describedby', sourceHelp.id + ' ' + feedback.id);
      sourceActions.appendChild(openSource); sourceActions.appendChild(feedback);
    }
    const swapHelp = node('p', 'Reverses the displayed pair and sets its new baseline for the next report. Shows all differences on the first page and clears the ID search. The opened history preview stays on the same report.');
    swapHelp.id = id + '-swap-help';
    const swapSides = button('Swap baseline and comparison', 'swap', () => {
      if (reading || result !== prepared) return;
      try {
        const reversed = compareAuthenticationHistorySnapshots(after.source, before.source);
        baseline = after; showComparison(reversed, after, before); update(); focus(heading);
      } catch { error.textContent = 'The saved reports could not be swapped. The selected comparison remains open. Try again or reopen the reports.'; error.hidden = false; }
    });
    swap = swapSides; swapSides.disabled = reading; swapSides.setAttribute('aria-describedby', swapHelp.id);
    direction.appendChild(swapSides); direction.appendChild(swapHelp);
    counts.textContent = (Object.keys(labels) as HistoryComparisonKind[]).map(key => labels[key] + ': ' + prepared.counts[key]).join(' · ');
    caveats.textContent = (prepared.scope_matches ? 'Source scopes match. ' : 'Source scopes differ; record coverage can differ. ')
      + (prepared.filters_match ? 'Source filters match. ' : 'Source filters differ; record coverage can differ. ')
      + (prepared.capture_order === 'later' ? 'The comparison capture time is later. ' : prepared.capture_order === 'same' ? 'The saved capture times are equal. ' : 'The comparison capture time is earlier than the baseline. ')
      + 'Dates do not change the selected order. Capture times, scope and filters are saved claims. Retention, missing links and saved detail limits still apply. Repairs, read checks, renewal and recovery remain separate evidence.';
    support.appendChild(createAuthenticationHistoryCopy({ document: doc, kind: 'comparison', label: 'Captured saved snapshot comparison', origin: heading,
      active: control => active(control) && result === prepared, raw: () => prepareAuthenticationHistoryComparisonSummary(prepared).text }));
    const downloadHelp = node('p', 'Downloads the same complete text as Copy comparison summary. Saved IDs and scope names are included; review before sharing. Keep the source JSON for all saved fields.');
    downloadHelp.id = id + '-download-help';
    const downloadStatus = node('p'); downloadStatus.id = id + '-download-status'; downloadStatus.hidden = true;
    downloadStatus.setAttribute('role', 'status'); downloadStatus.setAttribute('data-history-compare', 'download-status');
    const downloadError = node('p'); downloadError.id = id + '-download-error'; downloadError.hidden = true;
    downloadError.setAttribute('role', 'alert'); downloadError.setAttribute('data-history-compare', 'download-error');
    let downloading = false;
    const ownsDownload = (): boolean => active(saveSummary) && result === prepared;
    const saveSummary = button('Download comparison summary (.txt)', 'download-summary', () => {
      if (downloading || !ownsDownload()) return;
      downloading = true; saveSummary.setAttribute('aria-disabled', 'true'); saveSummary.setAttribute('aria-busy', 'true');
      downloadStatus.hidden = true; downloadStatus.textContent = ''; downloadError.hidden = true; downloadError.textContent = '';
      let preparing = true;
      try {
        const ready = prepareAuthenticationHistoryComparisonSummary(prepared); preparing = false;
        if (!ownsDownload()) return;
        downloadText(ready.filename, ready.text);
        if (ownsDownload()) { downloadStatus.textContent = 'Download requested: ' + ready.differences + ' saved record differences. Check your browser’s downloads.'; downloadStatus.hidden = false; }
      } catch {
        if (ownsDownload()) {
          downloadError.textContent = preparing ? 'The comparison summary could not be prepared. The complete text must fit within 8 MiB. Save smaller reports and compare them again, then retry.'
            : 'This browser could not start the text download. Try again or use Copy comparison summary.'; downloadError.hidden = false;
        }
      } finally { downloading = false; if (ownsDownload()) { saveSummary.setAttribute('aria-disabled', 'false'); saveSummary.setAttribute('aria-busy', 'false'); } }
    });
    saveSummary.setAttribute('aria-busy', 'false'); saveSummary.setAttribute('aria-disabled', 'false'); saveSummary.setAttribute('aria-describedby', downloadHelp.id + ' ' + downloadStatus.id + ' ' + downloadError.id);
    support.appendChild(saveSummary); support.appendChild(downloadHelp); support.appendChild(downloadStatus); support.appendChild(downloadError);
    const pairHelp = node('p', 'Saves both complete Names and IDs reports, including saved field values, account/app labels and source search text. Local use: review before sharing. Up to 8 MiB combined. Filters, ID search and paging do not limit this file. Reopen it in Open saved history to restore both sides.');
    pairHelp.id = id + '-pair-help';
    const pairStatus = node('p'); pairStatus.id = id + '-pair-status'; pairStatus.hidden = true; pairStatus.setAttribute('role', 'status'); pairStatus.setAttribute('data-history-compare', 'pair-status');
    const pairError = node('p'); pairError.id = id + '-pair-error'; pairError.hidden = true; pairError.setAttribute('role', 'alert'); pairError.setAttribute('data-history-compare', 'pair-error');
    let savingPair = false;
    const ownsPair = (): boolean => active(savePair) && result === prepared;
    const savePair = button('Save comparison pair (JSON)', 'save-pair', () => {
      if (savingPair || !ownsPair()) return;
      savingPair = true; savePair.setAttribute('aria-disabled', 'true'); savePair.setAttribute('aria-busy', 'true');
      pairStatus.hidden = true; pairStatus.textContent = ''; pairError.hidden = true; pairError.textContent = '';
      let preparing = true;
      try {
        const ready = prepareAuthenticationHistoryComparisonPair(prepared); preparing = false;
        if (!ownsPair()) return;
        download(ready.filename, ready.json);
        if (ownsPair()) { pairStatus.textContent = 'Comparison pair download requested. Check your browser’s downloads.'; pairStatus.hidden = false; }
      } catch {
        if (ownsPair()) {
          pairError.textContent = preparing ? 'The comparison pair could not be prepared. Both complete reports must fit within 8 MiB together. Keep the separate reports or compare smaller reports, then retry.'
            : 'This browser could not start the comparison pair download. Try again or keep the separate source reports.'; pairError.hidden = false;
        }
      } finally { savingPair = false; if (ownsPair()) { savePair.setAttribute('aria-disabled', 'false'); savePair.setAttribute('aria-busy', 'false'); } }
    });
    savePair.setAttribute('aria-busy', 'false'); savePair.setAttribute('aria-disabled', 'false'); savePair.setAttribute('aria-describedby', pairHelp.id + ' ' + pairStatus.id + ' ' + pairError.id);
    support.appendChild(savePair); support.appendChild(pairHelp); support.appendChild(pairStatus); support.appendChild(pairError);
    renderRows();
  }
  const compare = button('Compare with baseline', 'compare', () => {
    if (reading || !baseline || !current || candidate() || baseline.source === current.source) return;
    try { showComparison(compareAuthenticationHistorySnapshots(baseline.source, current.source), baseline, current); focus(heading); }
    catch { error.textContent = 'The saved reports could not be compared. Open complete Names and IDs reports and try again.'; error.hidden = false; }
  });
  const clearBaseline = button('Clear baseline and comparison', 'clear', () => { baseline = undefined; clearResults(); update(); focus(summary); });
  function renderRows(): void {
    if (!result || !sourceLabels || disposed) return;
    const chosen = doc.activeElement, ownedFocus = list.contains(chosen) || !inspectingSource && inspector.element.contains(chosen);
    const capture = result, selectedLabels = sourceLabels, selectedEpoch = ++epoch; if (!inspectingSource) { inspector.clear(); inspectedOrigin = undefined; inspectedReturnKey = undefined; } empty(list); clearReturnNotice();
    const matches = capture.rows.map((row, index) => ({ row, index })).filter(({ row }) => (filter.value === 'differences' ? row.kind !== 'unchanged' : row.kind === filter.value) && row.id.toLowerCase().includes(appliedQuery));
    page = Math.max(0, Math.min(page, Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1)));
    const start = page * PAGE_SIZE, end = Math.min(start + PAGE_SIZE, matches.length);
    range.textContent = matches.length ? 'Comparison records ' + (start + 1) + '–' + end + ' of ' + matches.length + '.' : 'No saved records match this view. Change the record filter or clear the ID search.';
    previous.disabled = page === 0; next.disabled = end >= matches.length;
    const valid = (control: HTMLElement): boolean => active(control) && result === capture && epoch === selectedEpoch;
    for (const { row, index } of matches.slice(start, end)) {
      const article = node('article'); article.setAttribute('data-history-compare-row', String(index)); list.appendChild(article);
      article.appendChild(node('h5', labels[row.kind] + ' · ' + previewRecordTypes[row.type] + ' · ' + row.id));
      if (row.fields.length) article.appendChild(node('p', 'Changed saved fields: ' + row.fields.map(key => key === 'outcome' ? 'Recorded outcome' : previewTitle(key)).join(', ') + '.'));
      for (const field of row.fields) {
        const detail = node('details'); detail.setAttribute('data-history-compare-field', index + '-' + field); article.appendChild(detail);
        const title = field === 'outcome' ? 'Recorded outcome' : previewTitle(field);
        const toggle = node('summary', title + ' · ' + field); toggle.setAttribute('id', id + '-field-name-' + index + '-' + field); toggle.setAttribute('tabindex', '0'); detail.appendChild(toggle);
        const feedback = node('p'); feedback.hidden = true; feedback.setAttribute('id', id + '-field-error-' + index + '-' + field); feedback.setAttribute('role', 'alert');
        feedback.setAttribute('data-history-compare-field-error', index + '-' + field); toggle.setAttribute('aria-describedby', feedback.getAttribute('id')!); detail.appendChild(feedback);
        let prepared = false;
        detail.addEventListener('toggle', () => {
          if (!detail.open || prepared || !valid(detail)) return;
          try {
            const values = authenticationHistoryComparisonFieldValues(capture, index, field);
            const pair = node('div'); pair.className = 'authentication-history-field-pair';
            for (const side of ['baseline', 'comparison'] as const) {
              const value = values[side], label = side === 'baseline' ? 'Baseline' : 'Comparison';
              const section = node('section'); section.setAttribute('data-history-compare-field-side', side);
              const name = node('h6', label + ' saved value'); name.setAttribute('id', id + '-field-' + index + '-' + field + '-' + side);
              section.appendChild(name);
              const position = side === 'baseline' ? row.baseline_index! : row.comparison_index!;
              const sourcePosition = node('p', 'Record ' + (position + 1) + ' in the ' + side + ' report.'); sourcePosition.setAttribute('id', name.getAttribute('id')! + '-position'); section.appendChild(sourcePosition);
              const content: HTMLElement = value.present ? node('pre', value.json) : node('p', 'Not saved in this report.');
              content.setAttribute('data-history-compare-field-value', side);
              if (value.present) {
                content.setAttribute('tabindex', '0'); content.setAttribute('role', 'region'); content.setAttribute('aria-labelledby', toggle.getAttribute('id')! + ' ' + name.getAttribute('id')! + ' ' + sourcePosition.getAttribute('id')!);
                content.addEventListener('keydown', event => {
                  if (detail.open && valid(content)) scrollAuthenticationHistoryText(doc, content, event);
                });
              }
              section.appendChild(content); pair.appendChild(section);
            }
            if (!valid(detail)) return;
            detail.appendChild(pair); prepared = true; feedback.hidden = true; feedback.textContent = '';
          } catch { if (valid(detail)) {
            feedback.textContent = 'Saved values could not be shown. Close and reopen this field to try again, or inspect the source records.'; feedback.hidden = false;
          } }
        });
      }
      for (const side of ['baseline', 'comparison'] as const) {
        const position = side === 'baseline' ? row.baseline_index : row.comparison_index, snapshot = capture[side], title = side === 'baseline' ? 'Baseline' : 'Comparison';
        if (position === undefined) { article.appendChild(node('p', title + ': not included in this report.')); continue; }
        const entry = snapshot.report.entries[position]!; article.appendChild(node('p', title + ': ' + previewRecordedOutcomes[entry.outcome] + '.'));
        const feedback = node('p'); feedback.hidden = true; feedback.setAttribute('id', id + '-inspection-error-' + side + '-' + index); feedback.setAttribute('role', 'alert'); feedback.setAttribute('data-history-compare-inspection-error', side + '-' + index);
        const inspect = button('Inspect ' + side + ' record', 'inspect-' + side + '-' + index, () => {
          if (!valid(inspect)) return;
          try {
            const record = prepareAuthenticationHistoryContextRecord(entry, authenticationHistoryRecordContext(snapshot, position));
            const opened = openAuthenticationHistoryFile(record.json);
            if (opened.kind !== 'record') throw new Error('Expected a saved record.');
            if (!valid(inspect)) return;
            feedback.hidden = true; feedback.textContent = '';
            inspector.show(opened.record, { filename: title + ' record' }); clearReturnNotice(); inspectingSource = false; inspectedOrigin = inspect; inspectedReturnKey = undefined; inspector.focus();
          } catch { if (valid(inspect)) {
            feedback.textContent = title + ' record could not be opened for inspection. Try again or open the source report.'; feedback.hidden = false;
            if (doc.activeElement === inspect || doc.activeElement === doc.body) feedback.scrollIntoView?.({ block: 'nearest' });
          } }
        }); inspect.setAttribute('aria-describedby', feedback.getAttribute('id')!); article.appendChild(inspect);
        const openSource = button('Open ' + side + ' record in full source', 'open-' + side + '-source-' + index, () => {
          if (valid(openSource)) showSource(capture, side, selectedLabels[side], openSource, feedback, position);
        }); openSource.setAttribute('aria-describedby', id + '-source-help ' + feedback.getAttribute('id')!); article.appendChild(openSource); article.appendChild(feedback);
      }
    }
    if (ownedFocus && (doc.activeElement === chosen || doc.activeElement === doc.body || !doc.activeElement?.isConnected)) focus(range);
  }
  filter.addEventListener('change', () => { if (active(filter) && (filter.value === 'differences' || Object.hasOwn(labels, filter.value))) { page = 0; renderRows(); } });
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!active(form) || !result) return;
    if (query.value.length > 200) { searchError.textContent = 'Use 200 characters or fewer for the record ID.'; searchError.hidden = false; query.setAttribute('aria-invalid', 'true'); return; }
    clearSearchError(); appliedQuery = query.value.trim().toLowerCase(); page = 0; renderRows();
    if (doc.activeElement && form.contains(doc.activeElement)) (doc.activeElement as HTMLElement).scrollIntoView?.({ block: 'nearest' });
  });
  element.appendChild(eligibility); element.appendChild(pin); element.appendChild(baselineInfo); element.appendChild(compare); element.appendChild(clearBaseline); element.appendChild(error); element.appendChild(results); update();
  return { element,
    setCurrent(source: OpenedAuthenticationHistoryFile, label: string): void { if (!disposed) { clearResults(); current = { source, label }; update(); } },
    openPair(capture: AuthenticationHistoryComparison): void {
      if (disposed) return;
      baseline = { source: Object.freeze({ kind: 'report', snapshot: capture.baseline }), label: 'Original baseline report in saved comparison pair' };
      current = { source: Object.freeze({ kind: 'report', snapshot: capture.comparison }), label: 'Original comparison report in saved comparison pair' };
      showComparison(capture, baseline, current); element.open = true; update();
    },
    focus(): void { if (result) focus(heading); },
    setReading(value: boolean): void { if (!disposed) { reading = value; update(); } },
    reset(): void { if (!disposed) { current = undefined; baseline = undefined; reading = false; clearResults(); update(); } },
    dispose(): void {
      const hadBaseline = !!baseline; disposed = true; current = undefined; baseline = undefined; clearResults(); if (hadBaseline) empty(baselineInfo); query.value = '';
      for (const control of [pin, compare, clearBaseline, previous, next, search, clearQuery, filter, query]) control.disabled = true;
      inspector.dispose();
    },
  };
};
export const AUTHENTICATION_HISTORY_COMPARISON_STYLES = `.authentication-history-comparison{box-sizing:border-box;min-width:0;border-top:1px solid var(--border);padding-top:8px;margin-top:12px;overflow-wrap:anywhere}.authentication-history-comparison summary{min-height:44px;align-content:center;cursor:pointer}.authentication-history-comparison button,.authentication-history-comparison select,.authentication-history-comparison input[type=search]{box-sizing:border-box;min-height:44px;max-width:100%;min-width:0;white-space:normal}.authentication-history-comparison button{display:block;margin:8px 0}.authentication-history-comparison select,.authentication-history-comparison input[type=search]{width:100%}.authentication-history-comparison article{border:1px solid var(--border);border-radius:6px;margin:12px 0;padding:10px;min-width:0}.authentication-history-comparison pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto;font-size:12px}.authentication-history-comparison h5{font-size:14px;margin:0 0 8px}.authentication-history-field-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.authentication-history-field-pair section{min-width:0}.authentication-history-field-pair h6{font-size:13px;margin:8px 0}.authentication-history-field-pair pre{border:1px solid var(--border);border-radius:4px;padding:8px}.authentication-history-field-pair pre:focus-visible{outline:2px solid var(--fg);outline-offset:2px}@media(max-width:640px){.authentication-history-field-pair{grid-template-columns:minmax(0,1fr)}}`;
