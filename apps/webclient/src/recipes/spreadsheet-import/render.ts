/** D-292 — the guided spreadsheet import: render (state → HTML string).
 *
 *  Pure. `wire.ts` sets the result as the overlay's innerHTML and re-attaches its
 *  delegated listeners, exactly as the run modal does. Everything clickable carries
 *  a `data-recued-sheet-import-*` attribute so tests and the browser verify drive it
 *  by name, never by class.
 */
import {
  isOptionalVariable,
  type ServerExecuteResponse,
  type SpreadsheetImportDeclaration,
  type VariableDefault,
} from '@recued/contracts';
import { e, renderVariableWidget, toWidgetShape } from '@recued/ui-shared';

import {
  DELIMITER_CANDIDATES,
  delimiterLabel,
  fileOnServer,
  fileStepReady,
  formatBytes,
  formatKeys,
  formatsChanged,
  mappingProblems,
  runFailureMessage,
  settingKeys,
  sharedColumns,
  variableLabel,
  type SheetImportState,
} from './model.js';

export const SHEET_IMPORT_ATTR = 'data-recued-sheet-import';
export const SHEET_IMPORT_ACTION_ATTR = 'data-recued-sheet-import-action';
export const SHEET_IMPORT_FILE_ATTR = 'data-recued-sheet-import-file';
export const SHEET_IMPORT_DROP_ATTR = 'data-recued-sheet-import-drop';
export const SHEET_IMPORT_COLUMN_ATTR = 'data-recued-sheet-import-column';
export const SHEET_IMPORT_ROW_ATTR = 'data-recued-sheet-import-row';
export const SHEET_IMPORT_DELIMITER_ATTR = 'data-recued-sheet-import-delimiter';
export const SHEET_IMPORT_REMEMBER_ATTR = 'data-recued-sheet-import-remember';
export const SHEET_IMPORT_STEP_ATTR = 'data-recued-sheet-import-step';
export const SHEET_IMPORT_RESULT_ATTR = 'data-recued-sheet-import-result';
export const SHEET_IMPORT_EXISTING_ATTR = 'data-recued-sheet-import-existing';
/** The owner's choice for lines they already have with different details. */
export const SHEET_IMPORT_CONFLICTS_ATTR = 'data-recued-sheet-import-conflicts';
/** D-301 — the region holding the formats ("More options"). */
export const SHEET_IMPORT_FORMATS_ATTR = 'data-recued-sheet-import-formats';
/** The id prefix for the settings widgets and the existing-file picker, so they
 *  cannot collide with a run modal's widgets on the same page. */
export const SHEET_IMPORT_ID_PREFIX = 'sheet-import-var';

export interface SheetImportCaps {
  /** A new file can be uploaded from this computer. */
  readonly canUpload: boolean;
  /** A file already in Recued can be chosen (the owner-file search is wired). */
  readonly canPickExisting: boolean;
  /** "Remember these columns" can write the recipe's install config. */
  readonly canRemember: boolean;
}

export interface SheetImportRenderContext {
  readonly recipeId: string;
  readonly title: string;
  readonly declaration: SpreadsheetImportDeclaration;
  readonly variables: Readonly<Record<string, VariableDefault>>;
  readonly caps: SheetImportCaps;
  /** The host's renderer for a run's own output sections. The check shows the
   *  RECIPE's check output — its summary, its first-rows table, its refusals —
   *  so the pack keeps its own wording and this flow owns only navigation. */
  readonly renderResult: (result: ServerExecuteResponse) => string;
}

const button = (
  action: string, label: string,
  opts: { primary?: boolean; disabled?: boolean; busy?: boolean } = {},
): string => `<button type="button" class="sheet-import-button${
  opts.primary === true ? ' sheet-import-button--primary' : ''}" ${SHEET_IMPORT_ACTION_ATTR}="${e(action)}"${
  opts.disabled === true ? ' aria-disabled="true"' : ''}${opts.busy === true ? ' aria-busy="true"' : ''}>${e(label)}</button>`;

const hasColumns = (ctx: SheetImportRenderContext): boolean => ctx.declaration.columns.length > 0;

const renderStepper = (state: SheetImportState, ctx: SheetImportRenderContext): string => {
  const steps: Array<[SheetImportState['step'], string]> = [
    ['file', 'Choose the file'],
    ...(hasColumns(ctx) ? [['columns', 'Match the columns'] as [SheetImportState['step'], string]] : []),
    ['check', 'Check, then import'],
  ];
  const at = steps.findIndex(([step]) => step === state.step);
  return `<ol class="sheet-import-steps" aria-label="Steps">${steps.map(([step, label], index) => {
    const status = index < at ? 'done' : index === at ? 'current' : 'todo';
    return `<li class="sheet-import-step" data-state="${status}" ${SHEET_IMPORT_STEP_ATTR}="${step}"${
      status === 'current' ? ' aria-current="step"' : ''}><span class="sheet-import-step-n">${index + 1}</span> ${e(label)}</li>`;
  }).join('')}</ol>`;
};

/** The upload bar. `wire.ts` updates its width + text IN PLACE on every
 *  progress tick: a full repaint per tick would close a dropdown the owner has
 *  open on the Columns step while the file is still climbing. */
export const SHEET_IMPORT_PROGRESS_ATTR = 'data-recued-sheet-import-progress';
export const renderUploadProgress = (fraction: number): string => {
  const pct = Math.round(fraction * 100);
  return `<div class="sheet-import-upload" ${SHEET_IMPORT_PROGRESS_ATTR}>
    <div class="sheet-import-progress" role="progressbar" aria-label="Uploading" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
    <p class="sheet-import-meta">Sending it to your server… <span data-pct>${pct}</span>%</p>
  </div>`;
};

const renderFileStatus = (state: SheetImportState, canChangeDelimiter: boolean): string => {
  if (state.fileName === null) return '';
  const parts: string[] = [`<strong>${e(state.fileName)}</strong>`];
  if (state.fileSize !== null) parts.push(e(formatBytes(state.fileSize)));
  const inspection = state.inspection;
  if (inspection !== null) {
    if (inspection.rowCount !== null) {
      parts.push(`${inspection.rowCount.toLocaleString('en-GB')} ${inspection.rowCount === 1 ? 'row' : 'rows'}`);
    }
    parts.push(`${inspection.header.length} ${inspection.header.length === 1 ? 'column' : 'columns'}`);
  }
  const upload = state.upload;
  const uploadLine = upload.phase === 'uploading'
    ? renderUploadProgress(upload.fraction)
    : upload.phase === 'error'
      ? `<p class="sheet-import-alert" role="alert">The upload did not finish: ${e(upload.error ?? 'unknown error')}. Choose the file again to retry.</p>`
      : upload.phase === 'done' || state.recordId !== null
        ? '<p class="sheet-import-meta">On your server — ready to import.</p>'
        : '';
  const reading = state.reading ? '<p class="sheet-import-meta">Reading the file…</p>' : '';
  const readError = state.readError === null
    ? ''
    : `<p class="sheet-import-alert" role="alert">${e(state.readError)}</p>`;
  const oneColumn = inspection !== null && inspection.header.length === 1
    ? `<p class="sheet-import-warn">Only one column was found. ${canChangeDelimiter
      ? 'If the file uses another separator, choose it on the next step.'
      : 'Is this the right file?'}</p>`
    : '';
  const empty = inspection !== null && inspection.header.length === 0
    ? '<p class="sheet-import-alert" role="alert">This file has no header row Recued can read. Is it a CSV?</p>'
    : '';
  const headerList = inspection !== null && inspection.header.length > 0
    ? `<p class="sheet-import-meta sheet-import-header-list">Columns: ${inspection.header.map((name) => `<code>${e(name)}</code>`).join(' ')}</p>`
    : '';
  return `<div class="sheet-import-file-status" role="status" aria-live="polite">
    <p class="sheet-import-file-line">${parts.join(' · ')}</p>
    ${uploadLine}${reading}${readError}${empty}${oneColumn}${headerList}
  </div>`;
};

const renderFileStep = (state: SheetImportState, ctx: SheetImportRenderContext): string => {
  const fileDef = ctx.variables[ctx.declaration.file];
  const title = variableLabel(ctx.declaration.file, fileDef);
  const busy = state.upload.phase === 'uploading' || state.reading;
  const drop = ctx.caps.canUpload
    ? `<label class="sheet-import-drop" ${SHEET_IMPORT_DROP_ATTR}${busy ? ' aria-disabled="true"' : ''}>
        <input type="file" class="sheet-import-file-input" ${SHEET_IMPORT_FILE_ATTR}
          accept=".csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values"${busy ? ' disabled' : ''} />
        <span class="sheet-import-drop-title">${state.fileName === null ? 'Choose a CSV file' : 'Choose a different file'}</span>
        <span class="sheet-import-drop-hint">or drop it here. It goes to your own server; nothing is recorded yet.</span>
      </label>`
    : '<p class="sheet-import-meta">Uploading is not available here. Choose a file already in Recued.</p>';
  const existing = ctx.caps.canPickExisting
    ? `<div class="sheet-import-existing" ${SHEET_IMPORT_EXISTING_ATTR}>
        <span class="sheet-import-copy">${ctx.caps.canUpload ? 'Or use a file already in Recued' : 'Use a file already in Recued'}</span>
        ${renderVariableWidget(
          toWidgetShape(ctx.declaration.file, fileDef ?? null,
            state.fileSource === 'existing' ? state.recordId ?? undefined : undefined),
          { fileRefPicker: true, idPrefix: SHEET_IMPORT_ID_PREFIX },
        )}
      </div>`
    : '';
  return `
    <p class="sheet-import-lead">${e(title)}</p>
    ${drop}
    ${existing}
    ${renderFileStatus(state, ctx.declaration.delimiter !== undefined)}`;
};

const renderColumnRow = (
  state: SheetImportState, ctx: SheetImportRenderContext, variable: string,
  problem: string | undefined,
): string => {
  const def = ctx.variables[variable];
  const optional = isOptionalVariable(def);
  const header = state.inspection?.header ?? [];
  const chosen = state.mapping[variable] ?? '';
  const id = `sheet-import-col-${variable}`;
  const options = [
    `<option value=""${chosen === '' ? ' selected' : ''}>${optional ? '— Not in my file —' : '— Choose a column —'}</option>`,
    ...header.map((name) => `<option value="${e(name)}"${name === chosen ? ' selected' : ''}>${e(name)}</option>`),
    // A choice the file does not have (the delimiter changed under it) stays
    // visible as itself — silently dropping it would read as "not in my file".
    ...(chosen !== '' && !header.includes(chosen)
      ? [`<option value="${e(chosen)}" selected>${e(chosen)} (not in this file)</option>`]
      : []),
  ].join('');
  const samples = chosen === '' ? [] : state.inspection?.samples[chosen] ?? [];
  const sampleLine = chosen === ''
    ? ''
    : samples.length === 0
      ? '<p class="sheet-import-sample">Empty in the first rows.</p>'
      : `<p class="sheet-import-sample">e.g. ${samples.map((value) => `<span>${e(value)}</span>`).join(' · ')}</p>`;
  const source = state.mappingSource[variable];
  const sourceNote = source === 'guessed'
    ? '<p class="sheet-import-note" data-source="guessed">Guessed from the column name — check it.</p>'
    : source === 'remembered'
      ? '<p class="sheet-import-note" data-source="remembered">Remembered from last time.</p>'
      : '';
  return `<div class="sheet-import-map-row" ${SHEET_IMPORT_ROW_ATTR}="${e(variable)}"${
    problem === undefined ? '' : ' data-problem="true"'}>
    <label class="sheet-import-map-label" for="${e(id)}">${e(variableLabel(variable, def))}${
      optional ? '<span class="var-optional">optional</span>' : ''}</label>
    <select id="${e(id)}" class="sheet-import-select" ${SHEET_IMPORT_COLUMN_ATTR}="${e(variable)}"${
      problem === undefined ? '' : ` aria-invalid="true" aria-describedby="${e(id)}-problem"`}>${options}</select>
    ${sampleLine}${sourceNote}${problem === undefined
      ? ''
      : `<p class="sheet-import-problem" id="${e(id)}-problem" role="alert">${e(problem)}</p>`}
  </div>`;
};

const renderSettings = (state: SheetImportState, ctx: SheetImportRenderContext): string => {
  // The conflict choice is NOT a detail of the file — it is a decision about the
  // owner's own data, shown on the Check step beside the lines it decides.
  const keys = settingKeys(ctx.declaration, ctx.variables)
    .filter((key) => key !== ctx.declaration.conflicts);
  if (keys.length === 0) return '';
  const widget = (key: string): string => renderVariableWidget(
    toWidgetShape(key, ctx.variables[key] ?? null, state.settings[key]),
    { idPrefix: SHEET_IMPORT_ID_PREFIX },
  );
  // D-301 — how the file writes its values sits under "More options", unless one
  // is not at its default: then it is always shown, and nothing offers to hide it.
  const formats = formatKeys(ctx.declaration, ctx.variables);
  const changed = formatsChanged(ctx.declaration, ctx.variables, state.settings);
  const shown = changed || state.moreOpen;
  const more = formats.length === 0 ? '' : `${changed ? '' : `<button type="button" class="sheet-import-more" ${
    SHEET_IMPORT_ACTION_ATTR}="more" aria-expanded="${shown}" aria-controls="${SHEET_IMPORT_ID_PREFIX}-formats">More options</button>`}
    <div class="sheet-import-formats" id="${SHEET_IMPORT_ID_PREFIX}-formats" ${SHEET_IMPORT_FORMATS_ATTR}${shown ? '' : ' hidden'}>${
      formats.map(widget).join('')}</div>`;
  const rows = keys.filter((key) => !formats.includes(key)).map(widget).join('');
  return `<fieldset class="sheet-import-settings"><legend>Details</legend>${rows}${more}</fieldset>`;
};

const renderColumnsStep = (state: SheetImportState, ctx: SheetImportRenderContext): string => {
  const header = state.inspection?.header ?? [];
  const problems = new Map(mappingProblems(ctx.declaration, ctx.variables, state.mapping, header)
    .map((problem) => [problem.variable, problem.message]));
  const delimiter = ctx.declaration.delimiter === undefined
    ? ''
    : `<div class="sheet-import-delimiter">
        <label class="sheet-import-copy" for="sheet-import-delimiter">Columns are separated by</label>
        <select id="sheet-import-delimiter" class="sheet-import-select sheet-import-select--inline" ${SHEET_IMPORT_DELIMITER_ATTR}>${
          [...new Set([...DELIMITER_CANDIDATES, state.delimiter])].map((candidate) =>
            `<option value="${e(candidate)}"${candidate === state.delimiter ? ' selected' : ''}>${e(delimiterLabel(candidate))}</option>`).join('')}
        </select>
        ${state.delimiterDetected === null
          ? ''
          : `<span class="sheet-import-meta">Detected from the file.</span>`}
      </div>`;
  const shared = sharedColumns(ctx.declaration, state.mapping);
  const sharedNote = shared.length === 0
    ? ''
    : `<p class="sheet-import-warn">${shared.map((name) => `“${e(name)}”`).join(', ')} ${
      shared.length === 1 ? 'is' : 'are'} chosen for more than one field. That is allowed, but usually a slip.</p>`;
  const remember = ctx.caps.canRemember
    ? `<label class="sheet-import-remember"><input type="checkbox" ${SHEET_IMPORT_REMEMBER_ATTR}${
      state.remember ? ' checked' : ''} /> Remember these columns${
      formatKeys(ctx.declaration, ctx.variables).length > 0 ? ' and formats' : ''} for next time</label>`
    : '';
  const stillUploading = state.upload.phase === 'uploading' ? renderUploadProgress(state.upload.fraction) : '';
  return `
    <p class="sheet-import-lead">Match each field to a column of <strong>${e(state.fileName ?? 'your file')}</strong>. The choices are the file’s own column names.</p>
    ${stillUploading}
    ${delimiter}
    <div class="sheet-import-map" role="group" aria-label="Match the columns">
      ${ctx.declaration.columns.map((variable) =>
        renderColumnRow(state, ctx, variable, problems.get(variable))).join('')}
    </div>
    ${sharedNote}
    ${renderSettings(state, ctx)}
    ${remember}`;
};

/** The owner's call on a line they ALREADY HAVE with different details — right
 *  next to Import, after the check that revealed those lines. Off by default,
 *  never remembered: the recipe never decides what the owner's data keeps.
 *  Disabled while a check runs, so the answer on screen is the one being checked. */
const renderConflicts = (state: SheetImportState, ctx: SheetImportRenderContext): string => {
  const key = ctx.declaration.conflicts;
  if (key === undefined) return '';
  return `<fieldset class="sheet-import-conflicts" ${SHEET_IMPORT_CONFLICTS_ATTR}${state.busy === null ? '' : ' disabled'}>
    <legend>What you already have</legend>
    ${renderVariableWidget(
      toWidgetShape(key, ctx.variables[key] ?? null, state.settings[key]),
      { idPrefix: SHEET_IMPORT_ID_PREFIX },
    )}
  </fieldset>`;
};

const renderCheckStep = (state: SheetImportState, ctx: SheetImportRenderContext): string => {
  if (state.imported) {
    return '<p class="sheet-import-lead">Imported. The result is on the page behind this dialog.</p>';
  }
  return `${renderCheckBody(state, ctx)}${renderConflicts(state, ctx)}`;
};

const renderCheckBody = (state: SheetImportState, ctx: SheetImportRenderContext): string => {
  if (state.busy === 'check') {
    return '<p class="sheet-import-status" role="status" aria-live="polite">Checking every row of the file — nothing is recorded yet…</p>';
  }
  if (state.busy === 'import') {
    return '<p class="sheet-import-status" role="status" aria-live="polite">Importing…</p>';
  }
  const settingsWhenNoColumns = hasColumns(ctx) ? '' : renderSettings(state, ctx);
  if (state.runError !== null) {
    return `${settingsWhenNoColumns}<p class="sheet-import-alert" role="alert">${e(state.runError)}</p>`;
  }
  const result = state.checkResult;
  if (result === null) {
    return `${settingsWhenNoColumns}<p class="sheet-import-lead">Check the file first: every row goes through the same checks a real import would, and nothing is recorded.</p>`;
  }
  if (result.awaiting_approval === true) {
    return `${settingsWhenNoColumns}<p class="sheet-import-warn" role="status">The check is waiting for an approval. Approve it, then check again.</p>`;
  }
  if (result.success !== true) {
    return `${settingsWhenNoColumns}<p class="sheet-import-alert" role="alert">${e(runFailureMessage(result))}</p>
      <p class="sheet-import-meta">Change the columns or the details and check again. Nothing was recorded.</p>`;
  }
  return `${settingsWhenNoColumns}
    <p class="sheet-import-lead">Here is what importing this file would do. <strong>Nothing has been recorded yet.</strong></p>
    <div class="sheet-import-result" ${SHEET_IMPORT_RESULT_ATTR}>${ctx.renderResult(result)}</div>`;
};

/** Whether the Check button may run right now. */
export const canCheck = (state: SheetImportState, ctx: Pick<SheetImportRenderContext, 'declaration' | 'variables'>): boolean =>
  state.busy === null
  && !state.imported
  && fileStepReady(state)
  && fileOnServer(state)
  && mappingProblems(ctx.declaration, ctx.variables, state.mapping, state.inspection?.header ?? []).length === 0;

/** Whether Import may run: only after a check that SUCCEEDED on exactly what is
 *  on screen (any edit clears `checkResult`). */
export const canImport = (state: SheetImportState): boolean =>
  state.busy === null
  && !state.imported
  && state.checkResult !== null
  && state.checkResult.success === true
  && state.checkResult.awaiting_approval !== true;

const renderFooter = (state: SheetImportState, ctx: SheetImportRenderContext): string => {
  if (state.imported) {
    return `<span class="sheet-import-spacer"></span>${button('close', 'Close', { primary: true })}`;
  }
  const busy = state.busy !== null;
  if (state.step === 'file') {
    return `${button('close', 'Cancel', { disabled: busy })}<span class="sheet-import-spacer"></span>${
      hasColumns(ctx)
        ? button('next', 'Next: match the columns', { primary: true, disabled: !fileStepReady(state) })
        : button('next', 'Next: check the file', { primary: true, disabled: !fileStepReady(state) })}`;
  }
  if (state.step === 'columns') {
    return `${button('back', 'Back', { disabled: busy })}<span class="sheet-import-spacer"></span>${
      button('check', 'Check the file', { primary: true, disabled: !canCheck(state, ctx), busy: state.busy === 'check' })}`;
  }
  const checked = state.checkResult !== null;
  return `${button(hasColumns(ctx) ? 'back' : 'change-file', hasColumns(ctx) ? 'Change the columns' : 'Choose another file', { disabled: busy })}${
    hasColumns(ctx) ? button('change-file', 'Choose another file', { disabled: busy }) : ''}<span class="sheet-import-spacer"></span>${
    checked && canImport(state)
      ? button('import', 'Import', { primary: true, busy: state.busy === 'import' })
      : button('check', checked ? 'Check again' : 'Check the file', {
        primary: true, disabled: !canCheck(state, ctx), busy: state.busy === 'check' })}`;
};

export const renderSheetImport = (state: SheetImportState, ctx: SheetImportRenderContext): string => {
  const body = state.step === 'file'
    ? renderFileStep(state, ctx)
    : state.step === 'columns'
      ? renderColumnsStep(state, ctx)
      : renderCheckStep(state, ctx);
  const notice = state.notice === null
    ? ''
    : `<p class="sheet-import-warn" role="status">${e(state.notice)}</p>`;
  return `
    <div ${SHEET_IMPORT_ATTR}="${e(ctx.recipeId)}">
      <section class="sheet-import-panel" role="dialog" aria-modal="true" aria-labelledby="sheet-import-title" tabindex="-1">
        <header class="sheet-import-header">
          <div class="sheet-import-heading">
            <h2 class="sheet-import-title" id="sheet-import-title">${e(ctx.title)}</h2>
            <p class="sheet-import-meta">Guided import — nothing is recorded until you press Import.</p>
          </div>
          ${button('close', 'Close', { disabled: state.busy !== null })}
        </header>
        ${renderStepper(state, ctx)}
        <div class="sheet-import-body">${notice}${body}</div>
        <footer class="sheet-import-footer">${renderFooter(state, ctx)}</footer>
      </section>
    </div>`;
};

/** Self-contained: the flow does not depend on the run modal's or a route's
 *  stylesheet being present. `.var-*` rules re-scope the shared widgets. */
export const SHEET_IMPORT_STYLES = `
[${SHEET_IMPORT_ATTR}] {
  position: fixed;
  inset: 0;
  z-index: 140;
  display: grid;
  place-items: start center;
  padding: 40px 16px 16px;
  background: rgba(24, 33, 36, .28);
}
.sheet-import-panel {
  box-sizing: border-box;
  width: min(820px, 100%);
  max-height: calc(100vh - 56px);
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--fg);
  box-shadow: 0 24px 48px rgba(24, 33, 36, .18);
  padding: 16px;
  display: grid;
  gap: 12px;
  min-width: 0;
}
.sheet-import-header { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
.sheet-import-heading { min-width: 0; flex: 1 1 auto; }
.sheet-import-title { margin: 0; font-size: 16px; font-weight: 650; overflow-wrap: anywhere; }
.sheet-import-steps {
  display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 0; padding: 0 0 10px;
  list-style: none; border-bottom: 1px solid var(--border);
}
.sheet-import-step { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
.sheet-import-step[data-state="current"] { color: var(--fg); font-weight: 650; }
.sheet-import-step-n {
  display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%;
  border: 1px solid var(--border); font-size: 11px; font-variant-numeric: tabular-nums;
}
.sheet-import-step[data-state="current"] .sheet-import-step-n { border-color: var(--accent); background: var(--accent); color: var(--on-accent); }
.sheet-import-step[data-state="done"] .sheet-import-step-n { border-color: var(--accent); color: var(--accent); }
.sheet-import-body { display: grid; gap: 12px; min-width: 0; }
.sheet-import-lead { margin: 0; font-size: 13px; line-height: 1.45; }
.sheet-import-meta { margin: 0; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.sheet-import-copy { font-size: 12px; font-weight: 600; }
.sheet-import-alert, .sheet-import-warn, .sheet-import-status {
  margin: 0; border-radius: 6px; padding: 8px 10px; font-size: 13px; line-height: 1.4; overflow-wrap: anywhere;
}
.sheet-import-alert { background: var(--danger-subtle, var(--warn-subtle)); color: var(--danger, var(--warn)); border: 1px solid var(--danger, var(--warn)); }
.sheet-import-warn { background: var(--warn-subtle); color: var(--warn); border: 1px solid var(--warn); }
.sheet-import-status { background: var(--surface-subtle); border: 1px solid var(--border); }
.sheet-import-drop {
  position: relative; display: grid; gap: 4px; justify-items: center; text-align: center;
  padding: 22px 16px; border: 1.5px dashed var(--border-strong, var(--border)); border-radius: 8px;
  background: var(--surface-subtle); cursor: pointer;
}
.sheet-import-drop:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }
.sheet-import-drop[data-dragging="true"] { border-color: var(--accent); background: var(--accent-weak, var(--surface-subtle)); }
.sheet-import-drop[aria-disabled="true"] { cursor: progress; opacity: .7; }
.sheet-import-drop-title { font-size: 14px; font-weight: 650; }
.sheet-import-drop-hint { font-size: 12px; color: var(--muted); }
.sheet-import-file-input {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.sheet-import-existing { display: grid; gap: 6px; }
/* The shared file picker prints the recipe's file label (a div, not a label —
   the search input carries its own aria-label); the step already says it above
   the drop zone. Hidden visually, kept in the accessibility tree. */
.sheet-import-existing .var-multi-label {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.sheet-import-file-status { display: grid; gap: 6px; }
.sheet-import-file-line { margin: 0; font-size: 13px; overflow-wrap: anywhere; }
.sheet-import-header-list code { font: 11px/1.6 var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace); margin-right: 4px; }
.sheet-import-progress { height: 6px; border-radius: 3px; background: var(--surface-subtle); border: 1px solid var(--border); overflow: hidden; }
.sheet-import-progress > span { display: block; height: 100%; background: var(--accent); }
.sheet-import-delimiter { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.sheet-import-map { display: grid; gap: 10px; }
.sheet-import-map-row {
  display: grid; gap: 4px; padding: 10px; border: 1px solid var(--border); border-radius: 6px; min-width: 0;
}
.sheet-import-map-row[data-problem="true"] { border-color: var(--warn); }
.sheet-import-map-label { font-size: 12px; font-weight: 600; overflow-wrap: anywhere; }
.sheet-import-select {
  box-sizing: border-box; width: 100%; max-width: 100%; min-height: 36px; border: 1px solid var(--border);
  border-radius: 6px; padding: 6px 9px; background: var(--surface); color: var(--fg); font: inherit;
}
.sheet-import-select--inline { width: auto; }
.sheet-import-sample, .sheet-import-note, .sheet-import-problem { margin: 0; font-size: 12px; overflow-wrap: anywhere; }
.sheet-import-sample { color: var(--muted); }
.sheet-import-sample span { color: var(--fg); font-variant-numeric: tabular-nums; }
.sheet-import-note { color: var(--muted); font-style: italic; }
.sheet-import-problem { color: var(--warn); }
.sheet-import-settings { display: grid; gap: 10px; margin: 0; padding: 10px; border: 1px solid var(--border); border-radius: 6px; min-width: 0; }
.sheet-import-settings > legend { padding: 0 4px; font-size: 12px; font-weight: 650; }
.sheet-import-remember { display: flex; align-items: center; gap: 7px; min-height: 36px; font-size: 13px; }
.sheet-import-more { justify-self: start; min-height: 36px; padding: 0 2px; border: 0; background: none; color: var(--accent, inherit); font: inherit; font-size: 13px; cursor: pointer; }
.sheet-import-more::before { content: '▸ '; }
.sheet-import-more[aria-expanded="true"]::before { content: '▾ '; }
.sheet-import-formats { display: grid; gap: 10px; min-width: 0; }
.sheet-import-formats[hidden] { display: none; }
.sheet-import-conflicts { display: grid; gap: 6px; margin: 0; padding: 10px; border: 1px solid var(--border); border-radius: 6px; min-width: 0; background: var(--surface-subtle); }
.sheet-import-conflicts > legend { padding: 0 4px; font-size: 12px; font-weight: 650; }
.sheet-import-conflicts[disabled] { opacity: .7; }
.sheet-import-result { min-width: 0; display: grid; gap: 10px; }
/* ⛔ A grid item's automatic minimum is its content: without this the result
   host grows to the widest table, the table's own scroll box never engages, and
   on a phone the last columns — "What would happen" — are cut off, unreachable. */
.sheet-import-result > * { min-width: 0; }
.sheet-import-footer {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-top: 10px; border-top: 1px solid var(--border);
}
.sheet-import-spacer { flex: 1 1 auto; }
.sheet-import-button {
  box-sizing: border-box; appearance: none; min-width: 36px; min-height: 36px; padding: 6px 12px;
  border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--fg);
  font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
}
.sheet-import-button[aria-disabled="true"] { cursor: not-allowed; opacity: .55; }
.sheet-import-button--primary { border-color: var(--accent); background: var(--accent); color: var(--on-accent); }
.sheet-import-button:focus-visible, .sheet-import-select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sheet-import-panel .var-row { display: grid; gap: 4px; }
.sheet-import-panel .var-row-inline { display: block; }
.sheet-import-panel .var-row > label { font-size: 12px; font-weight: 600; }
.sheet-import-panel .var-row-inline > label { display: flex; align-items: center; min-height: 36px; gap: 7px; font-weight: 500; }
.sheet-import-panel .var-help { margin: 0; font-size: 11px; line-height: 1.4; color: var(--muted); }
.sheet-import-panel .var-optional {
  margin-left: 6px; font-size: 10px; font-weight: 500; color: var(--fg-subtle, var(--muted));
  text-transform: uppercase; letter-spacing: .04em;
}
.sheet-import-panel .var-row input[type="text"],
.sheet-import-panel .var-row input[type="number"],
.sheet-import-panel .var-row input[type="password"],
.sheet-import-panel .var-row select {
  box-sizing: border-box; width: 100%; min-height: 36px; border: 1px solid var(--border); border-radius: 6px;
  padding: 7px 9px; background: var(--surface); color: var(--fg); font: inherit;
}
.sheet-import-panel .ref-picker-input { min-height: 36px; padding-right: 40px; }
@media (max-width: 520px) {
  [${SHEET_IMPORT_ATTR}] { padding: 12px 8px 8px; }
  .sheet-import-panel { padding: 12px; max-height: calc(100vh - 20px); }
  .sheet-import-footer .sheet-import-button { flex: 1 1 auto; }
  .sheet-import-spacer { display: none; }
}
`;
