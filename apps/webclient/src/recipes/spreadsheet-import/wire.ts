/** D-292 — the guided spreadsheet import: DOM glue (`wireSheetImport`).
 *
 *  Builds the overlay, paints it from state, attaches DELEGATED listeners on the
 *  stable root (a full `innerHTML` repaint keeps them), and restores focus to the
 *  same control after a repaint. It APPENDS ITSELF to `opts.mount`: the run modal
 *  leaves mounting to each host, and one of its six hosts once forgot — every press
 *  then wired a modal into nothing and latched the one-modal guard shut
 *  (`webclient-bootstrap.ts`'s packs host carries the note). A component that mounts
 *  itself cannot be half-mounted.
 *
 *  ⛔ A RUN IN FLIGHT HOLDS THE DIALOG OPEN. Close / Escape are ignored while a
 *  check or an import is running — the dialog is the only thing on screen that
 *  will say what that run did. A host teardown (`destroy`) still wins.
 */
import {
  RECORDS_IMPORT_MAX_CSV_BYTES,
  carriedFromRetired,
  retiredVariablesOf,
  type ServerExecuteResponse,
  type ServerRecipeListEntry,
  type SpreadsheetImportDeclaration,
  type VariableDefault,
} from '@recued/contracts';
import {
  FILE_REF_VARIABLE_ATTR,
  fileRefVariablePickerId,
  readWidgetValue,
  RefPicker,
  wireFocusTrap,
  type FocusTrapHandle,
} from '@recued/ui-shared';

import {
  buildRunConfig,
  decodeBase64Text,
  detectDelimiter,
  fileStepReady,
  initialMapping,
  initialSettings,
  initialSheetImportState,
  inspectSheet,
  INSPECT_CHARS,
  rememberedConfig,
  runFailureMessage,
  settingKeys,
  type SheetImportState,
} from './model.js';
import {
  canCheck,
  canImport,
  renderSheetImport,
  SHEET_IMPORT_ACTION_ATTR,
  SHEET_IMPORT_ATTR,
  SHEET_IMPORT_COLUMN_ATTR,
  SHEET_IMPORT_DELIMITER_ATTR,
  SHEET_IMPORT_DROP_ATTR,
  SHEET_IMPORT_FILE_ATTR,
  SHEET_IMPORT_ID_PREFIX,
  SHEET_IMPORT_PROGRESS_ATTR,
  SHEET_IMPORT_REMEMBER_ATTR,
  SHEET_IMPORT_STYLES,
  type SheetImportCaps,
} from './render.js';

/** A file the owner picked — a browser `File` satisfies it; tests fake it. */
export interface SheetImportFile {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  readonly lastModified: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer>; text?(): Promise<string> };
}

/** Upload a picked file to the owner's server; resolves with the `data.file`
 *  record id a `file_ref` variable holds. `onProgress` reports bytes. */
export type SheetImportUploader = (
  file: SheetImportFile,
  onProgress: (sent: number, total: number) => void,
  /** Aborted when the owner abandons the upload (another file, or the dialog
   *  closed) — the uploader cancels and reaps the server's half-written copy. */
  signal?: AbortSignal,
) => Promise<{ record_id: string }>;

export interface WireSheetImportOptions {
  recipe: ServerRecipeListEntry;
  declaration: SpreadsheetImportDeclaration;
  /** Where the overlay goes — the document body in a browser. */
  mount: HTMLElement;
  document?: Document;
  execute: (args: { recipe_id: string; config: Record<string, unknown> }) => Promise<ServerExecuteResponse>;
  /** Absent ⇒ no upload; the owner picks a file already in Recued. */
  uploadFile?: SheetImportUploader;
  /** `data.file.read` — reads a file already in Recued so its header can be
   *  shown. Absent ⇒ the existing-file picker is not offered. */
  readFile?: (args: { record_id: string }) => Promise<{
    bytes_b64: string; filename?: string; size_bytes?: number;
  }>;
  /** The owner-file inventory search (the run modal's `fileRefSearch`). */
  fileRefSearch?: RefPicker.RefPickerSearchCaller;
  /** `recipe_config.get` / `.set` — "remember these columns". Both or neither. */
  configGet?: (args: { recipe_id: string }) => Promise<{ config_overlay: Record<string, unknown> }>;
  configSet?: (args: {
    recipe_id: string; publisher_id?: string; config_overlay: Record<string, unknown>;
  }) => Promise<unknown>;
  /** Renders a run's own output sections (the recipe's check output). */
  renderResult: (result: ServerExecuteResponse) => string;
  /** Config handed in by the opener (a row action). A file id in it is read. */
  prefill?: Record<string, unknown>;
  onClose?: () => void;
  /** Fired with the REAL import's result, then the dialog closes — the host
   *  shows the receipt where it shows any run's result. */
  onRan?: (result: ServerExecuteResponse) => void;
}

export interface SheetImportHandle {
  readonly element: HTMLElement;
  getState(): Readonly<SheetImportState>;
  chooseFile(file: SheetImportFile): Promise<void>;
  useExistingFile(recordId: string, label?: string): Promise<void>;
  setColumn(variable: string, header: string): void;
  setDelimiter(delimiter: string): void;
  setSetting(key: string, value: unknown): void;
  setRemember(remember: boolean): void;
  /** D-301 — show or tuck away the formats ("More options"). */
  toggleMore(): void;
  next(): void;
  back(): void;
  changeFile(): void;
  check(): Promise<void>;
  importNow(): Promise<void>;
  /** A user dismissal — ignored while a run is in flight. */
  close(): void;
  /** Host teardown — always detaches. */
  destroy(): void;
}

const STYLES_MARKER = 'data-recued-sheet-import-styles';

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What a run would send, as one comparable string (key order ignored). */
const runConfigKey = (
  declaration: SpreadsheetImportDeclaration,
  state: Pick<SheetImportState, 'recordId' | 'delimiter' | 'mapping' | 'settings'>,
): string => {
  const config = buildRunConfig(declaration, state, false);
  return JSON.stringify(Object.keys(config).sort().map((key) => [key, config[key]]));
};

/** Read the start of a file as text: enough for the header and the first
 *  values, never the whole of a file the screen only needs a glimpse of. */
const readHead = async (file: SheetImportFile): Promise<{ text: string; truncated: boolean }> => {
  const truncated = file.size > INSPECT_CHARS;
  const slice = file.slice(0, truncated ? INSPECT_CHARS : file.size);
  const raw = typeof slice.text === 'function'
    ? await slice.text()
    : new TextDecoder('utf-8').decode(await slice.arrayBuffer());
  if (!truncated) return { text: raw, truncated };
  // A byte cut can land mid-row (or mid-character): keep whole lines only.
  const lastBreak = raw.lastIndexOf('\n');
  return { text: lastBreak > 0 ? raw.slice(0, lastBreak) : raw, truncated };
};

export const wireSheetImport = (opts: WireSheetImportOptions): SheetImportHandle => {
  const found = opts.document ?? (globalThis as { document?: Document }).document;
  if (found === undefined) {
    throw new Error('wireSheetImport: no document available — pass `opts.document`');
  }
  // Re-bound so the hoisted listener functions below see a narrowed type.
  const doc: Document = found;
  if (doc.head?.querySelector?.(`style[${STYLES_MARKER}]`) == null && doc.head !== undefined && doc.head !== null) {
    const style = doc.createElement('style');
    style.setAttribute(STYLES_MARKER, '');
    style.textContent = `${SHEET_IMPORT_STYLES}\n${RefPicker.REF_PICKER_STYLES}`;
    doc.head.appendChild(style);
  }

  const { declaration } = opts;
  const recipeId = opts.recipe.recipe_id;
  const variables = (opts.recipe.recipe.variables ?? {}) as Readonly<Record<string, VariableDefault>>;
  const caps: SheetImportCaps = {
    canUpload: opts.uploadFile !== undefined,
    canPickExisting: opts.fileRefSearch !== undefined && opts.readFile !== undefined,
    canRemember: opts.configGet !== undefined && opts.configSet !== undefined,
  };
  const ctx = {
    recipeId,
    title: opts.recipe.recipe.metadata?.name?.trim() || recipeId,
    declaration,
    variables,
    caps,
    renderResult: opts.renderResult,
  };

  let state: SheetImportState = initialSheetImportState({
    declaration, variables, canRemember: caps.canRemember,
    ...(opts.prefill === undefined ? {} : { prefill: opts.prefill }),
  });
  /** The owner's saved install config, once read — what "remember" wrote last
   *  time, and whatever they set by hand in Config. */
  let remembered: Record<string, unknown> = {};
  /** Settings the owner has edited here; a late config read never overwrites them. */
  const editedSettings = new Set<string>();
  /** Bumped on every new file, so a slow read or upload of the PREVIOUS file
   *  cannot land on the current one. */
  let fileToken = 0;
  /** Bumped on every edit, so a check that finishes after the owner changed
   *  something is discarded rather than shown as a check of what is on screen. */
  let editToken = 0;
  let destroyed = false;
  let pickers: RefPicker.RefPickerHandle[] = [];
  /** The upload in flight, if any — abandoned uploads are cancelled, not
   *  left climbing into a record nothing will use. */
  let uploadAbort: AbortController | null = null;
  const abandonUpload = (): void => {
    uploadAbort?.abort();
    uploadAbort = null;
  };

  const overlay = doc.createElement('div');
  overlay.className = 'sheet-import-overlay-root';

  type FocusIdentity = { kind: 'action' | 'column' | 'id'; value: string };
  const captureFocus = (): FocusIdentity | null => {
    const active = (doc as Document & { activeElement?: HTMLElement | null }).activeElement;
    if (active == null) return null;
    const contains = (overlay as HTMLElement & { contains?: (n: Node | null) => boolean }).contains;
    if (typeof contains === 'function' && !contains.call(overlay, active)) return null;
    const action = active.getAttribute?.(SHEET_IMPORT_ACTION_ATTR);
    if (action) return { kind: 'action', value: action };
    const column = active.getAttribute?.(SHEET_IMPORT_COLUMN_ATTR);
    if (column) return { kind: 'column', value: column };
    const id = active.getAttribute?.('id');
    return id ? { kind: 'id', value: id } : null;
  };
  const restoreFocus = (identity: FocusIdentity | null): void => {
    if (identity === null || typeof overlay.querySelector !== 'function') return;
    const attr = identity.kind === 'action' ? SHEET_IMPORT_ACTION_ATTR
      : identity.kind === 'column' ? SHEET_IMPORT_COLUMN_ATTR : 'id';
    const all = Array.from(overlay.querySelectorAll(`[${attr}]`) ?? []) as HTMLElement[];
    const target = all.find((el) => el.getAttribute(attr) === identity.value)
      // The button the owner pressed may be gone (Check became Import): land on
      // the step's primary action rather than dropping focus to <body>.
      ?? (identity.kind === 'action'
        ? overlay.querySelector('.sheet-import-button--primary') as HTMLElement | null
        : null);
    target?.focus?.({ preventScroll: true });
  };

  const mountPickers = (): void => {
    if (!caps.canPickExisting || state.step !== 'file' || typeof overlay.querySelector !== 'function') return;
    const key = declaration.file;
    const pickerId = fileRefVariablePickerId(key, SHEET_IMPORT_ID_PREFIX);
    if (overlay.querySelector(`[data-ref-picker="${pickerId}"]`) === null) return;
    const hidden = overlay.querySelector(
      `[${FILE_REF_VARIABLE_ATTR}="${key}"] [data-var-key="${key}"][data-var-type="file_ref"]`,
    ) as HTMLInputElement | null;
    pickers.push(RefPicker.wireRefPicker(overlay, {
      search: opts.fileRefSearch!,
      config: {
        pickerId,
        placeholder: 'Search your files',
        ariaLabel: 'Choose a file already in Recued',
        emptyText: 'No matching files.',
      },
      minChars: 0,
      initialValue: state.fileSource === 'existing' && state.recordId !== null && state.fileName !== null
        ? { id: state.recordId, label: state.fileName }
        : null,
      onChange: (selection) => {
        if (hidden !== null) hidden.value = selection?.id ?? '';
        if (selection !== null && selection.id !== state.recordId) {
          void handle.useExistingFile(selection.id, selection.label);
        }
      },
    }));
  };

  const paint = (focus: FocusIdentity | null = captureFocus()): void => {
    if (destroyed) return;
    for (const picker of pickers) picker.destroy();
    pickers = [];
    overlay.innerHTML = renderSheetImport(state, ctx);
    mountPickers();
    restoreFocus(focus);
  };

  /** Move the upload bar without repainting — see `SHEET_IMPORT_PROGRESS_ATTR`. */
  const updateProgress = (fraction: number): void => {
    if (typeof overlay.querySelectorAll !== 'function') return;
    const pct = String(Math.round(fraction * 100));
    for (const box of Array.from(overlay.querySelectorAll(`[${SHEET_IMPORT_PROGRESS_ATTR}]`)) as HTMLElement[]) {
      const bar = box.querySelector('[role="progressbar"]') as HTMLElement | null;
      bar?.setAttribute('aria-valuenow', pct);
      const fill = bar?.querySelector('span') as HTMLElement | null;
      if (fill !== null && fill !== undefined) fill.style.width = `${pct}%`;
      const text = box.querySelector('[data-pct]') as HTMLElement | null;
      if (text !== null) text.textContent = pct;
    }
  };

  const set = (patch: Partial<SheetImportState>, repaint = true): void => {
    state = { ...state, ...patch };
    if (repaint) paint();
  };

  /** Every edit invalidates a finished check: Import is only ever offered for
   *  exactly what is on screen. */
  const edited = (patch: Partial<SheetImportState>, repaint = true): void => {
    editToken += 1;
    set({ ...patch, checkResult: null, runError: null }, repaint);
  };

  /** Read the header of `text` with the current delimiter (detecting one first
   *  when the recipe lets the owner change it), and pre-select the columns. */
  const applyText = (text: string, truncated: boolean): void => {
    let delimiter = state.delimiter;
    let detected: string | null = null;
    if (declaration.delimiter !== undefined) {
      const found = detectDelimiter(text, delimiter);
      if (found !== delimiter) {
        detected = found;
        delimiter = found;
      }
    }
    const inspection = inspectSheet(text, delimiter, truncated);
    const { mapping, source } = initialMapping({
      declaration, variables, header: inspection.header, remembered,
    });
    edited({
      text, textTruncated: truncated, delimiter, delimiterDetected: detected,
      inspection, mapping, mappingSource: source, reading: false,
    });
  };

  const resetForFile = (patch: Partial<SheetImportState>): void => {
    edited({
      text: null, textTruncated: false, inspection: null, mapping: {}, mappingSource: {},
      readError: null, notice: null, delimiterDetected: null, step: 'file', ...patch,
    });
  };

  const handle: SheetImportHandle = {
    element: overlay,
    getState: () => state,

    async chooseFile(file) {
      if (state.busy !== null) return;
      const token = ++fileToken;
      abandonUpload();
      if (file.size > RECORDS_IMPORT_MAX_CSV_BYTES) {
        resetForFile({
          fileName: file.name, fileSize: file.size, recordId: null,
          upload: { phase: 'idle', fraction: 0, error: null },
          readError: `This file is ${Math.round(file.size / (1024 * 1024))} MB — an import reads at most ${
            RECORDS_IMPORT_MAX_CSV_BYTES / (1024 * 1024)} MB. Split it and import the parts.`,
        });
        return;
      }
      resetForFile({
        fileName: file.name, fileSize: file.size, recordId: null, fileSource: 'upload', reading: true,
        upload: { phase: opts.uploadFile === undefined ? 'idle' : 'uploading', fraction: 0, error: null },
      });
      if (opts.uploadFile !== undefined) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        uploadAbort = controller;
        const upload = opts.uploadFile(file, (sent, total) => {
          if (token !== fileToken || destroyed) return;
          const fraction = total > 0 ? Math.min(1, sent / total) : 0;
          set({ upload: { phase: 'uploading', fraction, error: null } }, false);
          updateProgress(fraction);
        }, controller?.signal);
        void upload.then(({ record_id }) => {
          if (token !== fileToken || destroyed) return;
          set({ recordId: record_id, upload: { phase: 'done', fraction: 1, error: null } });
        }, (err: unknown) => {
          if (token !== fileToken || destroyed) return;
          set({ upload: { phase: 'error', fraction: 0, error: errMessage(err) } });
        });
      }
      try {
        const { text, truncated } = await readHead(file);
        if (token !== fileToken || destroyed) return;
        applyText(text, truncated);
      } catch (err) {
        if (token !== fileToken || destroyed) return;
        set({ reading: false, readError: `Recued could not read this file: ${errMessage(err)}` });
      }
    },

    async useExistingFile(recordId, label) {
      if (state.busy !== null || opts.readFile === undefined) return;
      const token = ++fileToken;
      abandonUpload();
      resetForFile({
        fileName: label ?? recordId, fileSize: null, recordId, fileSource: 'existing', reading: true,
        upload: { phase: 'done', fraction: 1, error: null },
      });
      try {
        const read = await opts.readFile({ record_id: recordId });
        if (token !== fileToken || destroyed) return;
        const bytes = read.size_bytes ?? Math.floor(read.bytes_b64.length * 3 / 4);
        if (bytes > RECORDS_IMPORT_MAX_CSV_BYTES) {
          set({ reading: false, fileSize: bytes, readError: `This file is larger than the ${
            RECORDS_IMPORT_MAX_CSV_BYTES / (1024 * 1024)} MB an import reads.` });
          return;
        }
        const whole = decodeBase64Text(read.bytes_b64);
        const truncated = whole.length > INSPECT_CHARS;
        const lastBreak = truncated ? whole.lastIndexOf('\n', INSPECT_CHARS) : -1;
        const cut = !truncated ? whole
          : lastBreak > 0 ? whole.slice(0, lastBreak) : whole.slice(0, INSPECT_CHARS);
        state = { ...state, fileSize: bytes, fileName: read.filename ?? state.fileName };
        applyText(cut, truncated);
      } catch (err) {
        if (token !== fileToken || destroyed) return;
        set({ reading: false, readError: `Recued could not read this file: ${errMessage(err)}` });
      }
    },

    setColumn(variable, header) {
      if (!declaration.columns.includes(variable)) return;
      edited({
        mapping: { ...state.mapping, [variable]: header },
        mappingSource: { ...state.mappingSource, [variable]: 'chosen' },
      });
    },

    setDelimiter(delimiter) {
      if (declaration.delimiter === undefined || delimiter.length !== 1 || state.text === null) return;
      const inspection = inspectSheet(state.text, delimiter, state.textTruncated);
      // Keep every choice the re-read file still has; re-derive the rest.
      const { mapping, source } = initialMapping({
        declaration, variables, header: inspection.header,
        remembered: { ...remembered, ...state.mapping },
      });
      edited({ delimiter, delimiterDetected: null, inspection, mapping, mappingSource: source });
    },

    setSetting(key, value) {
      if (!settingKeys(declaration, variables).includes(key)) return;
      // A checkbox or a select fires `input` AND `change` for one act. The second
      // must not count as an edit: it would void the check the first one started.
      // (The repaint usually detaches the control before `change` fires; this
      // does not rely on it.)
      if (JSON.stringify(state.settings[key]) === JSON.stringify(value)) return;
      editedSettings.add(key);
      const answerShown = state.checkResult !== null || state.runError !== null;
      // An approval wait is not an answer: checking again would only queue
      // another held run. The owner presses Check once the approval is settled.
      const settledAnswer = answerShown && state.checkResult?.awaiting_approval !== true;
      const conflictChoice = key === declaration.conflicts;
      // Typing must keep its caret: repaint only when a shown check result has
      // to disappear because it no longer describes what would run.
      edited({ settings: { ...state.settings, [key]: value } }, conflictChoice || answerShown);
      // 🔑 The conflict choice sits beside the check that revealed the lines it
      // decides — so when an answer was on screen, check again at once and show
      // what the new choice WOULD do. The old answer was cleared above: Import is
      // never offered for a choice the owner has just changed.
      if (conflictChoice && settledAnswer && state.step === 'check' && canCheck(state, ctx)) {
        void runCheck(`${SHEET_IMPORT_ID_PREFIX}-${key}`);
      }
    },

    setRemember(remember) {
      set({ remember }, false);
    },

    toggleMore() {
      // Not an edit: nothing that would run changes, so a shown check stands.
      set({ moreOpen: !state.moreOpen });
    },

    next() {
      if (state.busy !== null) return;
      if (state.step === 'file' && fileStepReady(state)) {
        set({ step: declaration.columns.length > 0 ? 'columns' : 'check' });
      } else if (state.step === 'columns') {
        set({ step: 'check' });
      }
    },

    back() {
      if (state.busy !== null) return;
      if (state.step === 'check') set({ step: declaration.columns.length > 0 ? 'columns' : 'file' });
      else if (state.step === 'columns') set({ step: 'file' });
    },

    changeFile() {
      if (state.busy !== null) return;
      set({ step: 'file' });
    },

    check: () => runCheck(null),

    async importNow() {
      if (!canImport(state)) return;
      set({ busy: 'import', runError: null, notice: null });
      let result: ServerExecuteResponse;
      try {
        result = await opts.execute({
          recipe_id: recipeId, config: buildRunConfig(declaration, state, false),
        });
      } catch (err) {
        if (destroyed) return;
        set({ busy: null, runError: errMessage(err) });
        return;
      }
      if (destroyed) return;
      if (result.success !== true && result.awaiting_approval !== true) {
        set({ busy: null, runError: runFailureMessage(result) });
        return;
      }
      let notice: string | null = null;
      if (state.remember && result.success === true
        && opts.configGet !== undefined && opts.configSet !== undefined) {
        try {
          const existing = (await opts.configGet({ recipe_id: recipeId })).config_overlay ?? {};
          await opts.configSet({
            recipe_id: recipeId,
            publisher_id: opts.recipe.publisher_id,
            config_overlay: rememberedConfig(existing, declaration, state),
          });
        } catch (err) {
          notice = `Imported. Recued could not remember your columns for next time: ${errMessage(err)}`;
        }
      }
      if (destroyed) return;
      opts.onRan?.(result);
      if (notice === null) {
        detach();
        opts.onClose?.();
        return;
      }
      // Imported, but the owner asked for something that did not happen — say so
      // rather than closing over it. The receipt is already behind the dialog,
      // and nothing here may offer to run the import again.
      set({ busy: null, checkResult: null, notice, step: 'check', imported: true });
    },

    close() {
      if (state.busy !== null) return;
      detach();
      opts.onClose?.();
    },

    destroy() {
      detach();
    },
  };

  let trap: FocusTrapHandle | null = null;

  /** Run the check. `refocus` names the control to hand focus back to once the
   *  answer is on screen — the conflict choice is disabled while the check runs,
   *  which drops focus to <body>. Only a DROPPED focus is returned: an owner who
   *  moved on during the check keeps where they went. */
  async function runCheck(refocus: string | null): Promise<void> {
    if (!canCheck(state, ctx)) return;
    const token = editToken;
    set({ step: 'check', busy: 'check', checkResult: null, runError: null, notice: null });
    try {
      const result = await opts.execute({
        recipe_id: recipeId, config: buildRunConfig(declaration, state, true),
      });
      if (destroyed) return;
      set(token === editToken
        ? { busy: null, checkResult: result }
        : { busy: null, notice: 'Something changed while the file was being checked — check it again.' });
    } catch (err) {
      if (destroyed) return;
      set({ busy: null, runError: errMessage(err) });
    }
    if (refocus !== null && captureFocus() === null) restoreFocus({ kind: 'id', value: refocus });
  }

  function detach(): void {
    if (destroyed) return;
    destroyed = true;
    abandonUpload();
    for (const picker of pickers) picker.destroy();
    pickers = [];
    overlay.removeEventListener('click', onClick);
    overlay.removeEventListener('change', onChange);
    overlay.removeEventListener('input', onInput);
    overlay.removeEventListener('dragover', onDragOver);
    overlay.removeEventListener('dragleave', onDragLeave);
    overlay.removeEventListener('drop', onDrop);
    doc.removeEventListener('keydown', onKeydown);
    overlay.remove?.();
    trap?.release();
  }

  function onClick(ev: Event): void {
    const target = (ev.target as Element | null)?.closest?.(`[${SHEET_IMPORT_ACTION_ATTR}]`);
    if (target == null) return;
    if (target.getAttribute('aria-disabled') === 'true') return;
    const action = target.getAttribute(SHEET_IMPORT_ACTION_ATTR);
    if (action === 'close') handle.close();
    else if (action === 'next') handle.next();
    else if (action === 'back') handle.back();
    else if (action === 'change-file') handle.changeFile();
    else if (action === 'check') void handle.check();
    else if (action === 'import') void handle.importNow();
    else if (action === 'more') handle.toggleMore();
  }

  function onChange(ev: Event): void {
    const target = ev.target as HTMLInputElement | HTMLSelectElement | null;
    if (target == null || typeof target.getAttribute !== 'function') return;
    if (target.hasAttribute(SHEET_IMPORT_FILE_ATTR)) {
      const file = (target as HTMLInputElement).files?.[0];
      if (file !== undefined) void handle.chooseFile(file as unknown as SheetImportFile);
      return;
    }
    const column = target.getAttribute(SHEET_IMPORT_COLUMN_ATTR);
    if (column !== null) {
      handle.setColumn(column, target.value);
      return;
    }
    if (target.hasAttribute(SHEET_IMPORT_DELIMITER_ATTR)) {
      handle.setDelimiter(target.value);
      return;
    }
    if (target.hasAttribute(SHEET_IMPORT_REMEMBER_ATTR)) {
      handle.setRemember((target as HTMLInputElement).checked);
      return;
    }
    onInput(ev);
  }

  function onInput(ev: Event): void {
    const target = ev.target as HTMLElement | null;
    const key = target?.dataset?.varKey;
    if (key === undefined || key === declaration.file) return;
    handle.setSetting(key, readWidgetValue(target!));
  }

  const dropZone = (ev: Event): HTMLElement | null =>
    ((ev.target as Element | null)?.closest?.(`[${SHEET_IMPORT_DROP_ATTR}]`) as HTMLElement | null) ?? null;

  function onDragOver(ev: Event): void {
    const zone = dropZone(ev);
    if (zone === null) return;
    ev.preventDefault();
    zone.setAttribute('data-dragging', 'true');
  }

  function onDragLeave(ev: Event): void {
    dropZone(ev)?.removeAttribute('data-dragging');
  }

  function onDrop(ev: Event): void {
    const zone = dropZone(ev);
    if (zone === null) return;
    ev.preventDefault();
    zone.removeAttribute('data-dragging');
    const file = (ev as DragEvent).dataTransfer?.files?.[0];
    if (file !== undefined && caps.canUpload) void handle.chooseFile(file as unknown as SheetImportFile);
  }

  function onKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && !ev.isComposing) handle.close();
  }

  overlay.addEventListener('click', onClick);
  overlay.addEventListener('change', onChange);
  overlay.addEventListener('input', onInput);
  overlay.addEventListener('dragover', onDragOver);
  overlay.addEventListener('dragleave', onDragLeave);
  overlay.addEventListener('drop', onDrop);
  doc.addEventListener('keydown', onKeydown);

  paint(null);
  opts.mount.appendChild(overlay);
  trap = wireFocusTrap({ document: doc, getContainer: () => overlay, initialFocus: false });
  trap.focusInitial();

  // The owner's saved install config: remembered columns and the settings they
  // saved by hand. Late by nature; it never overwrites what they already edited.
  if (opts.configGet !== undefined) {
    void opts.configGet({ recipe_id: recipeId }).then(({ config_overlay }) => {
      if (destroyed) return;
      const saved = config_overlay ?? {};
      // A retired setting may still say what its replacement must be: the same
      // carry a run applies (`carriedFromRetired`). An owner whose old thousands
      // mark was a dot sees, and sends, the comma decimal mark (integrity audit,
      // 2026-09-24), and "remember" then saves it as their own.
      const recipe = opts.recipe.recipe;
      remembered = { ...carriedFromRetired(recipe, saved, retiredVariablesOf(recipe)), ...saved };
      const settings = initialSettings({
        declaration, variables, remembered,
        ...(opts.prefill === undefined ? {} : { prefill: opts.prefill }),
      });
      for (const key of editedSettings) settings[key] = state.settings[key];
      const patch: { -readonly [K in keyof SheetImportState]?: SheetImportState[K] } = { settings };
      if (declaration.delimiter !== undefined && state.text === null) {
        const saved = remembered[declaration.delimiter];
        if (typeof saved === 'string' && saved.length === 1) patch.delimiter = saved;
      }
      if (state.inspection !== null) {
        const chosen = Object.fromEntries(Object.entries(state.mapping)
          .filter(([variable]) => state.mappingSource[variable] === 'chosen'));
        const { mapping, source } = initialMapping({
          declaration, variables, header: state.inspection.header, remembered: { ...remembered, ...chosen },
        });
        for (const variable of Object.keys(chosen)) source[variable] = 'chosen';
        patch.mapping = mapping;
        patch.mappingSource = source;
      }
      // ⛔ A late answer that changes what would RUN is an edit, not a detail:
      // it clears a shown check (Import is only offered for what was checked)
      // and voids one in flight. Arriving before any check, it clears nothing.
      const next = { ...state, ...patch };
      if (runConfigKey(declaration, next) !== runConfigKey(declaration, state)) {
        edited(patch, state.busy === null);
      } else {
        set(patch, state.busy === null);
      }
    }, () => { /* no saved config — the recipe's defaults stand */ });
  }

  const prefilledFile = opts.prefill?.[declaration.file];
  if (typeof prefilledFile === 'string' && prefilledFile.trim() !== '' && opts.readFile !== undefined) {
    void handle.useExistingFile(prefilledFile.trim());
  }

  return handle;
};

/** True when `overlay` is one of this module's dialogs — for hosts asserting
 *  what they mounted. */
export const isSheetImportOverlay = (element: Element | null | undefined): boolean =>
  element?.querySelector?.(`[${SHEET_IMPORT_ATTR}]`) != null;
