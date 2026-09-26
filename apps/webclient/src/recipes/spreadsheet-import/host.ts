/** D-292 — what a HOST needs to open the guided spreadsheet import: which recipes
 *  get it, an uploader over the same resumable path Data → Files uses, and a
 *  static renderer for the check's own output.
 *
 *  Two hosts open it today — Pack Use operations (`webclient-bootstrap.ts`) and
 *  the Recipes library (`bootstrap-recipes-route.ts`) — in place of the run modal,
 *  for a recipe whose declaration HOLDS. Every other host keeps the run modal,
 *  which still runs these recipes: the flow is a better door, not the only one.
 */
import {
  spreadsheetImportOf,
  type ServerExecuteResponse,
  type ServerRecipeListEntry,
  type SpreadsheetImportDeclaration,
} from '@recued/contracts';
import { Upload } from '@recued/ui-shared';

import {
  createResultActionRegistry,
  RECIPE_RESULT_HOST_ATTR,
  RECIPE_RESULT_PANEL_STYLES,
  renderRecipeResultSection,
  resultOutputSections,
} from '../recipe-result-panel.js';
import type { SheetImportFile, SheetImportUploader } from './wire.js';

/** The declaration a host may act on, or `null` ⇒ open the run modal.
 *
 *  ⛔⛔ A LIST ROW CARRIES NO STEPS, AND THE CHECK READS THEM. `recipe.list`
 *  stopped shipping step bodies (`listView`), while the one property that makes
 *  this flow safe — the preview switch reaches the import's `dry_run`, or
 *  "Check" imports for real — can only be read off the steps. Run on a trimmed
 *  row, `spreadsheetImportOf` finds no switch and refuses: it fails CLOSED, so
 *  every importer silently kept the plain form. Found by a live drive; every
 *  test that hand-built a row WITH steps passed over it.
 *
 *  So the SERVER judges it on the full body and projects the result
 *  (`ServerRecipeListEntry.spreadsheet_import`, beside `provably_read_only` for
 *  the same reason), and that projection is what this trusts.
 *
 *  ⚠ A row that still HAS steps comes from a server older than the trim; it is
 *  judged here with the same pure function `validateRecipe` uses — a server
 *  older than D-292 stores this metadata block without validating it, so
 *  nothing else would have checked it. A row with neither answers `null`. */
export const sheetImportFor = (entry: ServerRecipeListEntry): SpreadsheetImportDeclaration | null => {
  if (entry.spreadsheet_import !== undefined) return entry.spreadsheet_import;
  const body = entry.recipe as { steps?: unknown };
  return Array.isArray(body.steps) ? spreadsheetImportOf(entry.recipe as never) : null;
};

const RESULT_STYLES_MARKER = 'data-recued-sheet-import-result-styles';

/** The result panel's stylesheet, for a dialog portaled outside the route that
 *  normally injects it. Idempotent. */
export const ensureSheetImportResultStyles = (doc: Document | undefined): void => {
  const head = doc?.head;
  if (head === undefined || head === null) return;
  if (head.querySelector?.(`style[${RESULT_STYLES_MARKER}]`) != null) return;
  const style = doc!.createElement('style');
  style.setAttribute(RESULT_STYLES_MARKER, '');
  style.textContent = RECIPE_RESULT_PANEL_STYLES;
  head.appendChild(style);
};

/** A run's own output sections, drawn STATICALLY for the check step — the same
 *  section renderer every result panel uses, with row actions suppressed: the
 *  check is a rehearsal, and nothing on it should be pressable into a real run. */
export const renderSheetImportResult = (result: ServerExecuteResponse): string => {
  const registry = createResultActionRegistry([], null, false, new Set(), new Map(), new Set());
  const sections = resultOutputSections(result).map((section) =>
    renderRecipeResultSection(section, registry, new Map(), result.recipe_id, false,
      new Map(), false, false, true)).join('');
  return `<div ${RECIPE_RESULT_HOST_ATTR}>${sections === ''
    ? '<p class="recipes-detail-note">The check returned no output to show.</p>'
    : sections}</div>`;
};

/** An uploader over the resumable `upload.*` path (the same engine and binary
 *  socket as Data → Files and the chat composer). Resolves with the finalized
 *  `data.file` record id — the id a `file_ref` variable holds.
 *
 *  ⚠ ONE ENGINE PER FILE, torn down when it settles: the engine models a single
 *  run. `signal` cancels an upload the owner abandoned (closed the dialog, picked
 *  another file), which also reaps the half-written scratch on the server. */
export const createSheetImportUploader = (deps: {
  callers: Upload.UploadCallers;
  connect: Upload.UploadConnectFactory;
}): SheetImportUploader => (file, onProgress, signal) => new Promise((resolve, reject) => {
  const engine = Upload.createUploadEngine({
    callers: deps.callers,
    transport: Upload.createWsUploadTransport({ connect: deps.connect }),
  });
  let settled = false;
  const finish = (): void => {
    settled = true;
    off();
    try { engine.destroy(); } catch { /* idempotent */ }
  };
  const off = engine.on('progress', (progress) => {
    if (settled) return;
    if (progress.error !== undefined) {
      finish();
      reject(new Error(progress.error));
      return;
    }
    // ⛔ DONE ONLY ON A RECORD ID. A finished transfer that named no record is a
    // file nothing can import; treat it as still climbing, never as uploaded.
    if (progress.recordId !== undefined && progress.recordId.length > 0) {
      finish();
      resolve({ record_id: progress.recordId });
      return;
    }
    onProgress(progress.sent, progress.total);
  });
  signal?.addEventListener('abort', () => {
    if (settled) return;
    try { engine.cancel(); } catch { /* best effort */ }
    finish();
    reject(new Error('upload cancelled'));
  });
  engine.start(file as unknown as Upload.UploadFile & SheetImportFile);
});
