import type { RecordsNamespaceView, ServerExecuteResponse, ServerRecipeListEntry } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import type { HeldRunFollower } from '../held-run-follow.js';
import {
  ensureSheetImportResultStyles, renderSheetImportResult, sheetImportFor, wireSheetImport,
  type SheetImportHandle, type WireSheetImportOptions,
} from '../recipes/spreadsheet-import/index.js';

export const RECORDS_IMPORT_OPEN = 'records-import-open';
export const RECORDS_IMPORT_RETRY = 'records-import-retry';
export const RECORDS_IMPORT_RECIPE_ATTR = 'data-records-import-recipe';

/** Discovery is scoped to the selected pack and its publisher. A metadata tag
 * alone must not let another publisher offer writes in this pack's workspace. */
export const recordsImportRecipes = (
  recipes: readonly ServerRecipeListEntry[], namespace: RecordsNamespaceView,
): readonly ServerRecipeListEntry[] => namespace.state.state !== 'ready' ? [] : recipes.filter(entry =>
  entry.source !== 'inline'
  && entry.publisher_id === namespace.owner.publisher
  && entry.recipe.metadata?.recipe_bundle === `${namespace.owner.publisher}/${namespace.owner.pack_slug}`
  && sheetImportFor(entry) !== null);

type ImportFiles = Pick<WireSheetImportOptions,
  'uploadFile' | 'readFile' | 'fileRefSearch' | 'configGet' | 'configSet'>;

export interface RecordsImportOptions extends ImportFiles {
  document: Document;
  mount: HTMLElement;
  namespace(): RecordsNamespaceView | null;
  listRecipes?: () => Promise<{ recipes: readonly ServerRecipeListEntry[] }>;
  execute?: WireSheetImportOptions['execute'];
  followHeldRun?: HeldRunFollower['follow'];
  changed(): void;
  refresh(): Promise<void>;
  returnFocus(recipeId: string): void;
}

/** The Records host for the shared importer. It owns discovery and the receipt;
 * uploads, mapping, mandatory check and execution remain in the existing flow. */
export const createRecordsImport = (opts: RecordsImportOptions) => {
  let owner: string | null = null;
  let generation = 0;
  let disposed = false;
  let loading = false;
  let refreshing = false;
  let error: string | null = null;
  let entries: readonly ServerRecipeListEntry[] = [];
  let flow: SheetImportHandle | null = null;
  let receipt: ServerExecuteResponse | null = null;
  let stopFollow: (() => void) | null = null;
  const key = (namespace: RecordsNamespaceView | null): string | null => namespace?.state.state === 'ready'
    ? JSON.stringify([namespace.owner.publisher, namespace.owner.pack_slug, namespace.activation_generation, namespace.artifact_digest]) : null;
  const current = (at: number): boolean => !disposed && generation === at && owner !== null
    && key(opts.namespace()) === owner;
  const changed = (): void => { if (!disposed) opts.changed(); };

  const load = async (namespace: RecordsNamespaceView | null, retry = false): Promise<void> => {
    const next = key(namespace);
    if (disposed || (!retry && next === owner)) return;
    const at = ++generation;
    flow?.destroy(); flow = null;
    stopFollow?.(); stopFollow = null;
    owner = next; entries = []; receipt = null; error = null; loading = false; refreshing = false;
    if (next === null || namespace === null || !opts.listRecipes || !opts.execute
      || (!opts.uploadFile && !(opts.readFile && opts.fileRefSearch))) { changed(); return; }
    loading = true; changed();
    try {
      const result = await opts.listRecipes();
      if (!current(at)) return;
      entries = recordsImportRecipes(result.recipes, namespace);
    } catch (err) {
      if (!current(at)) return;
      error = `Import recipes could not be loaded: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      if (!disposed && at === generation) {
        loading = false;
        // Leaving Data while discovery settles must not cache an unanswered
        // roster and prevent another read when the owner comes back.
        if (!current(at)) owner = null;
        changed();
      }
    }
  };

  const refreshRecords = (at: number): void => {
    refreshing = true;
    void opts.refresh().catch(err => {
      if (current(at)) {
        const message = `Records could not be refreshed: ${err instanceof Error ? err.message : String(err)}`;
        error = error === null ? message : `${error} ${message}`;
      }
    }).finally(() => {
      if (!disposed && generation === at) { refreshing = false; changed(); }
    });
  };

  const showResult = (result: ServerExecuteResponse, at: number): void => {
    if (!current(at)) return;
    receipt = result; error = null; changed();
    if (result.awaiting_approval !== true) refreshRecords(at);
  };

  const open = (recipeId: string): SheetImportHandle | null => {
    if (disposed || flow !== null || loading || refreshing || !opts.execute || key(opts.namespace()) !== owner) return null;
    const entry = entries.find(entry => entry.recipe_id === recipeId);
    const declaration = entry && sheetImportFor(entry);
    if (!entry || !declaration) return null;
    const at = generation;
    ensureSheetImportResultStyles(opts.document);
    flow = wireSheetImport({
      recipe: entry, declaration, document: opts.document, mount: opts.mount,
      execute: async args => {
        if (!current(at)) throw new Error('This pack changed. Reopen the import from Records.');
        const importing = args.config[declaration.preview] === false;
        if (importing) {
          // This attempt owns the result area, even when its reply is lost.
          // A prior held run may still finish, but must not replace this one.
          stopFollow?.(); stopFollow = null;
          receipt = null; error = null; changed();
        }
        let result: ServerExecuteResponse;
        try {
          result = await opts.execute!(args);
        } catch (err) {
          if (importing && current(at)) {
            error = 'The import outcome could not be confirmed. Check Records and run a fresh preview before retrying.';
            refreshRecords(at); changed();
          }
          throw err;
        }
        // The shared dialog stays open on failure. Retain the actual receipt
        // here too: an import that stopped can have recorded some rows.
        if (importing && result.success !== true && result.awaiting_approval !== true) {
          showResult(result, at);
        }
        return result;
      },
      ...(opts.uploadFile ? { uploadFile: opts.uploadFile } : {}),
      ...(opts.readFile ? { readFile: opts.readFile } : {}),
      ...(opts.fileRefSearch ? { fileRefSearch: opts.fileRefSearch } : {}),
      ...(opts.configGet && opts.configSet ? { configGet: opts.configGet, configSet: opts.configSet } : {}),
      renderResult: renderSheetImportResult,
      onClose: () => {
        flow = null;
        if (current(at)) { changed(); opts.returnFocus(recipeId); }
      },
      onRan: result => {
        if (!current(at)) return;
        stopFollow?.(); stopFollow = null;
        showResult(result, at);
        if (result.awaiting_approval === true && opts.followHeldRun) {
          stopFollow = opts.followHeldRun(result, (next, later) => {
            if (current(at) && receipt === later.replaces) showResult(next, at);
          });
        }
      },
    });
    return flow;
  };

  return {
    load, open,
    retry: () => load(opts.namespace(), true),
    hasInFlightWork: (): boolean => refreshing || flow?.getState().busy != null
      || flow?.getState().reading === true || flow?.getState().upload.phase === 'uploading',
    hasUnsavedChanges: (): boolean => flow !== null && !flow.getState().imported && flow.getState().fileName !== null,
    focus: (): void => flow?.element.querySelector<HTMLElement>('button:not([disabled]), input, select')?.focus(),
    render: (): string => {
      if (owner === null || key(opts.namespace()) !== owner) return '';
      if (!loading && error === null && entries.length === 0 && receipt === null) return '';
      return `<section class="records-import" aria-label="Import records">
        ${loading ? '<p role="status">Looking for import recipes…</p>' : ''}
        ${error ? `<p role="alert">${e(error)}</p>${entries.length === 0 ? `<button type="button" data-action="${RECORDS_IMPORT_RETRY}">Try loading import recipes again</button>` : ''}` : ''}
        ${entries.length ? `<h4>Import from a spreadsheet</h4><p>Choose a CSV file, match its columns, then check what would be recorded before importing.</p>
          <div class="records-export-actions">${entries.map(entry => `<button type="button" data-action="${RECORDS_IMPORT_OPEN}"
            ${RECORDS_IMPORT_RECIPE_ATTR}="${e(entry.recipe_id)}"${flow !== null || refreshing ? ' aria-disabled="true"' : ''}>${entries.length === 1 ? 'Import CSV' : `Import CSV: ${e(entry.recipe.metadata?.name || entry.recipe_id)}`}</button>`).join('')}</div>` : ''}
        ${receipt ? `<section aria-label="Last import result"><h4>Last import result</h4>
          <p role="status">${receipt.awaiting_approval ? 'Waiting for approval. The result will update when the run finishes.'
            : receipt.success ? 'The import finished. Review the row counts below.' : 'The import did not finish. Review the result below.'}</p>
          ${receipt.awaiting_approval ? '<a href="#approvals">Open approvals</a>' : ''}${renderSheetImportResult(receipt)}</section>` : ''}
      </section>`;
    },
    destroy: (): void => {
      disposed = true; generation += 1; stopFollow?.(); stopFollow = null;
      flow?.destroy(); flow = null;
    },
  };
};
