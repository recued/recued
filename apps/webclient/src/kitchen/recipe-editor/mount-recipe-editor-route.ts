/** Recipe-editor route mount — loads an EXISTING recipe by id, then hands the
 *  resolved definition to the load-agnostic editor.
 *
 *  `bootstrapRecipeEditorRoute` never fetches — it takes an `initialRecipe`.
 *  This wrapper is the Kitchen route's loader: it resolves `<recipe_id>` from
 *  `recipe.list` (which carries the full definition per entry — there is no
 *  `recipe.get`, by design: the list row is the record), renders a loading /
 *  not-found / error shell while it waits, then mounts the editor wired to the
 *  `recipe.validate` / `recipe.save` seam. Reached via `#kitchen/recipe/<id>`
 *  (the recipes-detail "Edit in Kitchen" link), the recipe-editing sibling of
 *  the pack editor's `#kitchen/pack[/<draft>]`.
 *
 *  Fork model (unchanged from the editor + save seam): the editor exposes an
 *  editable `recipe_id`, and `recipe.save` always persists `source:'inline'`
 *  under the `kitchen` publisher — so KEEPING the id edits-in-place (the inline
 *  row shadows a bundled original, which stays recoverable + is reversible by
 *  deleting the inline row) and CHANGING it forks to a new local recipe. No
 *  fork-vs-overwrite branching lives here.
 */

import type {
  KitchenImportDraft,
  LocalRecipeWebhookStatus,
  RecipeDefinition,
  ServerRecipeFullEntry,
  ServerRecipeListEntry,
  WebhookIngressBindingSelection,
  WebhookIngressView,
} from '@recued/contracts';
import { PRIMITIVE_STYLES } from '@recued/ui-shared/primitives';

import type { DraftRecovery } from './editor-history.js';
import type { RecipeSimulationCaller } from './recipe-simulation-caller.js';
import type { RecipeRegressionCaller } from './recipe-regression-caller.js';
import type { RecipeRunCaptureCaller } from './recipe-run-capture-caller.js';
import type { RecipeReleaseCaller } from './recipe-release-caller.js';
import type { RecipeReleaseView } from '@recued/contracts';
import { serializeShellRoute } from '../../shell/route.js';
import { humanizeRpcError } from '../../shell/rpc-error-copy.js';
import {
  createRecipeChangesKeeper,
  findRecipeChanges,
  type RecipeChangesCallers,
  type RecipeChangesKeeper,
} from '../recipe-changes.js';
import {
  adoptRecipe,
  bootstrapRecipeEditorRoute,
  RECIPE_EDITOR_ROUTE_ATTR,
  type BootstrapRecipeEditorRouteOptions,
  type RecipeEditorRoute,
  type RecipeSaveResult,
  type RecipeWebhookControl,
  type RecipeValidateResult,
} from './recipe-editor-route.js';
import {
  createFormResponseAutomationFromWorkflowTemplate,
  createFormResponseAutomationDraftKey,
  createFormResponseAutomationSeed,
} from './form-response-automation-seed.js';
import {
  findFormResponseAutomations,
  findFormResponseWorkflowTemplates,
  type FormResponseAutomationMatch,
  type FormResponseWorkflowTemplateMatch,
} from './form-response-automation-discovery.js';

/** D-333 — the bar above the editor while changes to the saved recipe are kept
 *  (`orphaned`: the link to changes whose recipe is gone). */
export const RECIPE_CHANGES_ATTR = 'data-recued-recipe-changes';

/** The loader host (value = the recipe_id being loaded). */
export const MOUNT_RECIPE_EDITOR_HOST_ATTR = 'data-recued-recipe-editor-mount';
/** The loading / not-found / error status line (value = `'loading' | 'error'`). */
export const MOUNT_RECIPE_EDITOR_STATUS_ATTR =
  'data-recued-recipe-editor-mount-status';
/** The back-to-recipe link rendered on a not-found / error state. */
export const MOUNT_RECIPE_EDITOR_BACK_ATTR = 'data-recued-recipe-editor-mount-back';
/** Retry a transient recipe-list failure without leaving Kitchen. */
export const MOUNT_RECIPE_EDITOR_RETRY_ATTR =
  'data-recued-recipe-editor-mount-retry';
/** Existing accepted-response recipes shown before another starter is minted. */
export const FORM_RESPONSE_AUTOMATION_DISCOVERY_ATTR =
  'data-recued-form-response-automation-discovery';
/** A saved recipe row (value = recipe id). */
export const FORM_RESPONSE_AUTOMATION_ITEM_ATTR =
  'data-recued-form-response-automation-item';
/** Match explanation (`this_form`, `this_form_filtered`, or `all_forms`). */
export const FORM_RESPONSE_AUTOMATION_SCOPE_ATTR =
  'data-recued-form-response-automation-scope';
/** Explicit action that replaces discovery/failure UI with a fresh draft. */
export const FORM_RESPONSE_AUTOMATION_CREATE_ATTR =
  'data-recued-form-response-automation-create';
/** Recovery link shown when the starter itself cannot be created. */
export const FORM_RESPONSE_AUTOMATION_BACK_ATTR =
  'data-recued-form-response-automation-back';
/** One installed inert workflow template row (value = recipe id). */
export const FORM_RESPONSE_WORKFLOW_TEMPLATE_ATTR =
  'data-recued-form-response-workflow-template';
/** Clone action for an installed template (value = recipe id). */
export const FORM_RESPONSE_WORKFLOW_TEMPLATE_USE_ATTR =
  'data-recued-form-response-workflow-template-use';

const MOUNT_STYLES_MARKER = 'data-recued-recipe-editor-mount-styles';
const MOUNT_STYLES = `
[${MOUNT_RECIPE_EDITOR_HOST_ATTR}] {
  box-sizing: border-box;
  max-width: 1080px;
  margin: 0 auto;
  padding: 24px;
  color: var(--fg);
}
[${MOUNT_RECIPE_EDITOR_HOST_ATTR}]:has(> [${RECIPE_EDITOR_ROUTE_ATTR}]) {
  max-width: 1200px;
  padding: 0;
}
[${MOUNT_RECIPE_EDITOR_STATUS_ATTR}] {
  margin: 0;
  color: var(--fg-muted);
  font-size: 14px;
}
[${MOUNT_RECIPE_EDITOR_STATUS_ATTR}="error"] {
  color: var(--danger);
}
[${MOUNT_RECIPE_EDITOR_BACK_ATTR}],
[${FORM_RESPONSE_AUTOMATION_BACK_ATTR}] {
  display: inline-block;
  margin-top: 12px;
  color: var(--accent);
}
[${MOUNT_RECIPE_EDITOR_RETRY_ATTR}] {
  margin-top: 12px;
  margin-right: 10px;
}
[${RECIPE_CHANGES_ATTR}]:not([${RECIPE_CHANGES_ATTR}="orphaned"]) {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  padding: 12px 24px;
  color: var(--fg-muted);
}
[${RECIPE_CHANGES_ATTR}][hidden] {
  display: none;
}
[${RECIPE_CHANGES_ATTR}="orphaned"] {
  display: inline-block;
  margin: 12px 16px 0 0;
  color: var(--accent);
}
[${MOUNT_RECIPE_EDITOR_RETRY_ATTR}][aria-disabled="true"] {
  cursor: progress;
  opacity: .72;
}
[${FORM_RESPONSE_AUTOMATION_DISCOVERY_ATTR}] {
  max-width: 760px;
  padding: 8px 0 32px;
}
[${FORM_RESPONSE_AUTOMATION_DISCOVERY_ATTR}] .form-response-automation-eyebrow {
  margin: 0 0 6px;
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .06em;
  text-transform: uppercase;
}
[${FORM_RESPONSE_AUTOMATION_DISCOVERY_ATTR}] h1 {
  margin: 0;
  font-size: clamp(24px, 3vw, 34px);
  letter-spacing: -.025em;
}
[${FORM_RESPONSE_AUTOMATION_DISCOVERY_ATTR}] .form-response-automation-intro {
  max-width: 640px;
  margin: 10px 0 22px;
  color: var(--fg-muted);
  line-height: 1.55;
}
[${FORM_RESPONSE_AUTOMATION_DISCOVERY_ATTR}] ul {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
[${FORM_RESPONSE_AUTOMATION_ITEM_ATTR}] a {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px 16px;
  padding: 15px 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  color: var(--fg);
  text-decoration: none;
  background: var(--surface, transparent);
}
[${FORM_RESPONSE_AUTOMATION_ITEM_ATTR}] a:hover {
  border-color: var(--accent);
}
[${FORM_RESPONSE_AUTOMATION_ITEM_ATTR}] strong {
  overflow: hidden;
  text-overflow: ellipsis;
}
[${FORM_RESPONSE_AUTOMATION_ITEM_ATTR}] code {
  overflow: hidden;
  color: var(--fg-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[${FORM_RESPONSE_AUTOMATION_SCOPE_ATTR}] {
  grid-column: 2;
  grid-row: 1 / span 2;
  align-self: center;
  padding: 4px 8px;
  border-radius: 999px;
  color: var(--fg-muted);
  background: var(--surface-raised, var(--surface));
  font-size: 11px;
  font-weight: 650;
  white-space: nowrap;
}
[${FORM_RESPONSE_AUTOMATION_CREATE_ATTR}] {
  margin-top: 18px;
}
[${FORM_RESPONSE_WORKFLOW_TEMPLATE_ATTR}] {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px 16px;
  align-items: center;
  margin-top: 14px;
  padding: 15px 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface, transparent);
}
[${FORM_RESPONSE_WORKFLOW_TEMPLATE_ATTR}] strong,
[${FORM_RESPONSE_WORKFLOW_TEMPLATE_ATTR}] code { overflow: hidden; text-overflow: ellipsis; }
[${FORM_RESPONSE_WORKFLOW_TEMPLATE_ATTR}] code { color: var(--fg-muted); font-size: 12px; }
[${FORM_RESPONSE_WORKFLOW_TEMPLATE_USE_ATTR}] { grid-column: 2; grid-row: 1 / span 2; }
@media (max-width: 640px) {
  [${FORM_RESPONSE_WORKFLOW_TEMPLATE_ATTR}] {
    grid-template-columns: minmax(0, 1fr);
  }
  [${FORM_RESPONSE_WORKFLOW_TEMPLATE_USE_ATTR}] {
    grid-column: 1;
    grid-row: auto;
    width: 100%;
    margin-top: 6px;
  }
  [${FORM_RESPONSE_AUTOMATION_CREATE_ATTR}] { width: 100%; }
}
`;

const injectStyles = (doc: Document): void => {
  if (
    doc.head !== undefined
    && doc.head.querySelector(`style[${MOUNT_STYLES_MARKER}]`) === null
  ) {
    const style = doc.createElement('style');
    style.setAttribute(MOUNT_STYLES_MARKER, '');
    // Discovery and loader failures render before either full editor has a
    // chance to inject its own route bundle. Ship the shared button primitives
    // here so a cold deep link never falls back to native browser controls.
    style.textContent = [PRIMITIVE_STYLES, MOUNT_STYLES].join('\n');
    doc.head.appendChild(style);
  }
};

const clearChildren = (element: HTMLElement): void => {
  while (element.firstChild !== null) element.removeChild(element.firstChild);
};

export type RecipeListCaller = () => Promise<{
  recipes: ReadonlyArray<ServerRecipeListEntry>;
}>;

export interface MountRecipeEditorRouteOptions {
  recovery?: DraftRecovery;
  root: HTMLElement;
  document?: Document;
  /** The recipe to load into the editor (seg 1 of `#kitchen/recipe/<id>`). */
  recipeId: string;
  /** Resolves the full definition. ⚠ KEPT AS THE FALLBACK, not the path:
   *  `recipe.get` now exists and {@link getCaller} is tried first. This stays
   *  because a webclient can meet an older server — self-hosted has no deploy
   *  order — and that server answers `unknown_method`. */
  listCaller: RecipeListCaller;
  /** Fetches ONE recipe by id (`recipe.get`). Preferred over
   *  {@link listCaller}: the list carries every definition on the server
   *  (9.86 MB of a 10.26 MB response on a 2,369-recipe realm) to hand this
   *  route exactly one of them. Optional so an older server still opens the
   *  editor through the list. */
  getCaller?: (args: { recipe_id: string }) => Promise<{
    recipe: ServerRecipeFullEntry | null;
  }>;
  validateCaller: (args: { recipe: RecipeDefinition }) => Promise<RecipeValidateResult>;
  simulateCaller?: RecipeSimulationCaller;
  regressionCaller?: RecipeRegressionCaller;
  captureCaller?: RecipeRunCaptureCaller;
  releaseCaller?: RecipeReleaseCaller;
  saveCaller: (args: {
    recipe: RecipeDefinition;
    publisher_id?: string;
    webhook_bindings?: ReadonlyArray<WebhookIngressBindingSelection>;
  }) => Promise<RecipeSaveResult>;
  webhookIngressListCaller?: () => Promise<{ ingresses: WebhookIngressView[] }>;
  webhookStatusCaller?: (args: { recipe_id: string }) => Promise<{
    webhook: LocalRecipeWebhookStatus;
  }>;
  webhookArmCaller?: RecipeWebhookControl['armCaller'];
  webhookDisarmCaller?: RecipeWebhookControl['disarmCaller'];
  /** D-315 §5.1 — the owner's kinds of email, for the mail-fact pickers. */
  mailFactTypesCaller?: BootstrapRecipeEditorRouteOptions['mailFactTypesCaller'];
  /** D-315 §5.2 — the author's templates, and one as a checked starter. */
  mailTemplatesCaller?: BootstrapRecipeEditorRouteOptions['mailTemplatesCaller'];
  mailTemplateStarterCaller?: BootstrapRecipeEditorRouteOptions['mailTemplateStarterCaller'];
  onSaved?: (result: RecipeSaveResult) => void;
  /** D-333 — Kitchen keeps changes to the saved recipe as they are typed, in place of
   *  this browser's {@link recovery} copy. A server from before D-333 keeps that copy. */
  changes?: RecipeChangesCallers;
  /** D-333 — the packs copied in Kitchen, for the editor's switch between a pack and its copy. */
  packCopiesCaller?: BootstrapRecipeEditorRouteOptions['packCopiesCaller'];
  confirm?: (message: string) => boolean;
}

export interface MountRecipeEditorRoute {
  dispose(): void;
  /** Leave-guard seam — false while loading / not-found (nothing to lose),
   *  else the mounted editor's dirty state. */
  hasUnsavedChanges(): boolean;
  hasInFlightWork(): boolean;
}

export interface MountFormResponseRecipeSeedRouteOptions {
  recovery?: DraftRecovery;
  root: HTMLElement;
  document?: Document;
  /** Stable form-definition scope. No submission id or answer data belongs in
   *  this route: the seeded recipe reads each accepted response at run time. */
  formDefinitionId: string;
  /** Deterministic seam for tests. Production omits it and mints 128 random
   *  bits so a new starter cannot upsert over an existing recipe. */
  draftKey?: string;
  /** Finds saved canonical accepted-response recipes before a new draft is
   *  minted, so repeat visits do not hide existing automations. */
  listCaller: RecipeListCaller;
  /** `recipe.get`. A workflow template is PROVEN and CLONED from its body, and
   *  a list row has none (see `findFormResponseWorkflowTemplates`). Without it,
   *  only an older server's body-carrying list can offer templates. */
  getCaller?: (args: { recipe_id: string }) => Promise<{
    recipe: ServerRecipeFullEntry | null;
  }>;
  validateCaller: (args: { recipe: RecipeDefinition }) => Promise<RecipeValidateResult>;
  simulateCaller?: RecipeSimulationCaller;
  saveCaller: (args: {
    recipe: RecipeDefinition;
    publisher_id?: string;
  }) => Promise<RecipeSaveResult>;
  /** D-315 §5.1 — the owner's kinds of email, for the mail-fact pickers. */
  mailFactTypesCaller?: BootstrapRecipeEditorRouteOptions['mailFactTypesCaller'];
  /** D-315 §5.2 — the author's templates, and one as a checked starter. */
  mailTemplatesCaller?: BootstrapRecipeEditorRouteOptions['mailTemplatesCaller'];
  mailTemplateStarterCaller?: BootstrapRecipeEditorRouteOptions['mailTemplateStarterCaller'];
  onSaved?: (result: RecipeSaveResult) => void;
}

/** Load `recipeId` and mount the editor on it. Synchronous return (a handle);
 *  the fetch + editor mount happen asynchronously behind a loading shell. */
export const mountRecipeEditorRoute = (
  options: MountRecipeEditorRouteOptions,
): MountRecipeEditorRoute => {
  const doc =
    options.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountRecipeEditorRoute: no document available; pass options.document for non-browser environments',
    );
  }
  injectStyles(doc);

  const host = doc.createElement('section');
  host.setAttribute(MOUNT_RECIPE_EDITOR_HOST_ATTR, options.recipeId);
  options.root.appendChild(host);

  let disposed = false;
  let editor: RecipeEditorRoute | undefined;
  let loadBusy = false;
  let lastLoadError = '';
  let keeper: RecipeChangesKeeper | undefined;
  const confirmDiscard = options.confirm ?? ((message: string) => doc.defaultView?.confirm(message) ?? false);

  /** D-333 — above the editor while changes are kept: that they are kept, and Discard. */
  const mountChangesBar = (item: KitchenImportDraft | undefined, saved: ServerRecipeFullEntry): (() => void) => {
    const bar = doc.createElement('div');
    bar.setAttribute(RECIPE_CHANGES_ATTR, '');
    const note = doc.createElement('span');
    note.textContent = item?.base !== undefined && item.base.version !== saved.version
      ? 'The recipe was saved again after these changes began. They are kept until you save or discard them.'
      : 'Your changes are kept until you save or discard them.';
    const status = doc.createElement('span');
    status.setAttribute('role', 'status');
    const discard = doc.createElement('button');
    discard.type = 'button';
    discard.className = 'rx-btn rx-btn-secondary rx-btn-sm';
    discard.textContent = 'Discard changes';
    bar.appendChild(note);
    bar.appendChild(status);
    bar.appendChild(discard);
    host.appendChild(bar);
    const sync = (): void => {
      if (disposed) return;
      bar.hidden = !(keeper?.hasChanges() ?? false);
      const now = keeper?.status() ?? { state: 'idle' as const };
      status.textContent = now.state === 'saving' ? 'Keeping your changes…'
        : now.state === 'stopped' || now.state === 'error' ? now.message : 'Kept as you type';
    };
    discard.addEventListener('click', () => {
      const current = keeper;
      if (current === undefined || discard.disabled) return;
      if (!confirmDiscard('Discard your changes? The saved recipe stays as it is.')) return;
      discard.disabled = true;
      status.textContent = 'Discarding…';
      void current.discard().then(() => {
        if (disposed) return;
        // Start again from the saved recipe.
        current.dispose();
        keeper = undefined;
        editor?.dispose();
        editor = undefined;
        void loadRecipe();
      }).catch(() => {
        discard.disabled = false;
        sync();
      });
    });
    sync();
    return sync;
  };

  /** Replace the host body with a status line (+ a back link on failure). */
  const renderStatus = (
    message: string,
    state: 'loading' | 'error',
    statusOptions: {
      allowRetry?: boolean;
      retryBusy?: boolean;
      focusRetry?: boolean;
      focusBack?: boolean;
    } = {},
  ): void => {
    clearChildren(host);
    const line = doc.createElement('p');
    line.setAttribute(MOUNT_RECIPE_EDITOR_STATUS_ATTR, state);
    line.setAttribute('role', state === 'error' ? 'alert' : 'status');
    line.textContent = message;
    host.appendChild(line);
    if (state === 'error') {
      let retry: HTMLButtonElement | null = null;
      if (statusOptions.allowRetry === true) {
        retry = doc.createElement('button');
        retry.type = 'button';
        retry.className = 'rx-btn rx-btn-secondary rx-btn-sm';
        retry.setAttribute(MOUNT_RECIPE_EDITOR_RETRY_ATTR, '');
        retry.textContent = statusOptions.retryBusy === true
          ? 'Retrying…'
          : 'Retry';
        if (statusOptions.retryBusy === true) {
          retry.setAttribute('aria-disabled', 'true');
          retry.setAttribute('aria-busy', 'true');
        }
        retry.addEventListener('click', () => {
          if (loadBusy || statusOptions.retryBusy === true) return;
          void loadRecipe(true);
        });
        host.appendChild(retry);
      }
      const back = doc.createElement('a');
      back.setAttribute(MOUNT_RECIPE_EDITOR_BACK_ATTR, '');
      back.setAttribute('href', serializeShellRoute('recipes', options.recipeId));
      back.textContent = '← Back to recipe';
      host.appendChild(back);
      if (statusOptions.focusRetry === true && retry !== null) {
        retry.focus({ preventScroll: true });
      } else if (statusOptions.focusBack === true) {
        back.focus({ preventScroll: true });
      }
    }
  };

  const statusFocusOwner = (): { retry: boolean; back: boolean } => {
    const active = doc.activeElement as HTMLElement | null | undefined;
    return {
      retry: active?.hasAttribute?.(MOUNT_RECIPE_EDITOR_RETRY_ATTR) === true,
      back: active?.hasAttribute?.(MOUNT_RECIPE_EDITOR_BACK_ATTR) === true,
    };
  };

  const loadRecipe = async (fromRetry = false): Promise<void> => {
    if (disposed || loadBusy || editor !== undefined) return;
    const activeElement = doc.activeElement as HTMLElement | null | undefined;
    const retryOwned = fromRetry
      && activeElement?.hasAttribute?.(MOUNT_RECIPE_EDITOR_RETRY_ATTR) === true;
    loadBusy = true;
    if (fromRetry) {
      renderStatus(lastLoadError, 'error', {
        allowRetry: true,
        retryBusy: true,
        focusRetry: retryOwned,
      });
    } else {
      renderStatus('Loading recipe…', 'loading');
    }
    try {
      // ⛔ BY ID FIRST, LIST ONLY AS A FALLBACK. Scanning the list downloads
      // every recipe body on the server to use one. `recipe.get` returns the
      // identical entry — asserted in `recipe-list-handler.test.ts`, which
      // requires the two doors to agree entry-for-entry.
      //
      // ⚠ The fallback is not defensive padding: a newer webclient against an
      // older server gets `unknown_method`, and self-hosted installs have no
      // deploy order that would prevent it.
      let entry: ServerRecipeFullEntry | undefined;
      let usedFallback = false;
      if (options.getCaller !== undefined) {
        try {
          const got = await options.getCaller({ recipe_id: options.recipeId });
          if (disposed) return;
          entry = got.recipe ?? undefined;
        } catch {
          usedFallback = true;
        }
      } else {
        usedFallback = true;
      }
      if (usedFallback) {
        const result = await options.listCaller();
        if (disposed) return;
        // ⚠ THE FALLBACK CANNOT PRODUCE A BODY ANY MORE. `packs.list`-style
        // trimming reached `recipe.list` too, so an older server's list row has
        // no `steps` — the editor would open on a recipe it cannot save. Treat
        // a list-only server as "cannot open by list" rather than opening
        // something hollow.
        const row = result.recipes.find((r) => r.recipe_id === options.recipeId);
        entry = row === undefined || (row.recipe as { steps?: unknown }).steps === undefined
          ? undefined
          : (row as unknown as ServerRecipeFullEntry);
      }
      if (entry === undefined) {
        const focusOwner = statusFocusOwner();
        renderStatus(
          `Recipe "${options.recipeId}" isn't installed on this server.`,
          'error',
          { focusBack: (retryOwned && focusOwner.retry) || focusOwner.back },
        );
        // D-333 — changes in progress outlive their recipe: they open as work of their own.
        if (options.changes !== undefined) {
          void findRecipeChanges(options.changes, options.recipeId).then((found) => {
            if (!found || disposed || editor !== undefined) return;
            const open = doc.createElement('a');
            open.setAttribute(RECIPE_CHANGES_ATTR, 'orphaned');
            open.setAttribute('href', serializeShellRoute('kitchen', 'import', found.draft_id));
            open.textContent = 'Open your changes to it';
            host.appendChild(open);
          });
        }
        return;
      }
      // D-333 — read alongside the others; used unless the recipe keeps a release draft.
      const changesRead = options.changes !== undefined
        ? findRecipeChanges(options.changes, entry.recipe_id)
        : undefined;
      let webhookControl: RecipeWebhookControl | undefined;
      if (options.webhookIngressListCaller
        && options.webhookStatusCaller
        && options.webhookArmCaller
        && options.webhookDisarmCaller) {
        try {
          const [ingressResult, statusResult] = await Promise.all([
            options.webhookIngressListCaller(),
            options.webhookStatusCaller({ recipe_id: entry.recipe_id }),
          ]);
          if (disposed) return;
          webhookControl = {
            ingresses: ingressResult.ingresses,
            initialStatus: statusResult.webhook,
            armCaller: options.webhookArmCaller,
            disarmCaller: options.webhookDisarmCaller,
          };
        } catch {
          // Webhook owner controls are additive. A server without 5B1 may still
          // open/edit ordinary recipes; declaring recipes remain save-closed in
          // the editor when this control bundle is absent.
          webhookControl = undefined;
        }
      }
      let releaseInitial: RecipeReleaseView | undefined;
      if (options.releaseCaller) {
        try { releaseInitial = await options.releaseCaller.get({ recipe_id: entry.recipe_id }); }
        catch (cause) {
          const code = (cause as { code?: unknown } | null)?.code;
          if (!['not_configured','method_not_found','unknown_method','not_found'].includes(String(code))) throw cause;
        }
        if (disposed) return;
      }
      // D-333 — Kitchen keeps changes to a saved recipe. A recipe under reviewed releases
      // keeps its own draft; a server from before D-333 keeps this browser's copy.
      const managed = releaseInitial?.managed === true;
      const changes = changesRead !== undefined && !managed ? await changesRead : null;
      if (disposed) return;
      let changed: RecipeDefinition | undefined;
      if (changes) {
        try { changed = JSON.parse(changes.source) as RecipeDefinition; } catch { /* the first edit replaces it */ }
      }
      clearChildren(host);
      if (options.changes !== undefined && changes !== null) {
        const sync = mountChangesBar(changes, entry);
        keeper = createRecipeChangesKeeper({
          callers: options.changes,
          base: { recipe_id: entry.recipe_id, version: entry.version },
          saved: adoptRecipe(entry.recipe)!,
          ...(changes !== undefined ? { item: changes } : {}),
          onStatus: sync,
        });
        sync();
      }
      const kept = keeper;
      editor = bootstrapRecipeEditorRoute({
        recovery: kept === undefined ? options.recovery : undefined,
        root: host,
        ...(options.document !== undefined ? { document: options.document } : {}),
        initialRecipe: changed
          ?? (releaseInitial?.managed && releaseInitial.draft ? releaseInitial.draft.recipe : entry.recipe),
        ...(changed !== undefined ? { initialDirty: true } : {}),
        ...(kept !== undefined ? { onChange: (recipe: RecipeDefinition) => kept.changed(recipe) } : {}),
        ...(options.packCopiesCaller !== undefined ? { packCopiesCaller: options.packCopiesCaller } : {}),
        // Recipes saved from Kitchen are the owner's; switching another author's makes a copy.
        ownRecipe: entry.publisher_id === 'kitchen',
        validateCaller: options.validateCaller,
        simulateCaller: options.simulateCaller,
        ...(options.regressionCaller ? { regressionCaller: options.regressionCaller } : {}),
        ...(options.captureCaller ? { captureCaller: options.captureCaller } : {}),
        ...(options.releaseCaller ? { releaseCaller: options.releaseCaller } : {}),
        ...(releaseInitial ? { releaseInitial } : {}),
        saveCaller: options.saveCaller,
        ...(webhookControl ? { webhookControl } : {}),
        ...(options.mailFactTypesCaller !== undefined ? { mailFactTypesCaller: options.mailFactTypesCaller } : {}),
        ...(options.mailTemplatesCaller !== undefined ? { mailTemplatesCaller: options.mailTemplatesCaller } : {}),
        ...(options.mailTemplateStarterCaller !== undefined
          ? { mailTemplateStarterCaller: options.mailTemplateStarterCaller }
          : {}),
        onSaved: (result, saved) => {
          kept?.saved({ recipe_id: result.recipe_id, version: result.version }, saved);
          options.onSaved?.(result);
        },
      });
    } catch (error: unknown) {
      if (disposed) return;
      // No editor to keep changes for.
      keeper?.dispose();
      keeper = undefined;
      const focusOwner = statusFocusOwner();
      lastLoadError = humanizeRpcError(error);
      renderStatus(lastLoadError, 'error', {
        allowRetry: true,
        focusRetry: retryOwned && focusOwner.retry,
        focusBack: focusOwner.back,
      });
    } finally {
      loadBusy = false;
    }
  };

  void loadRecipe();

  return {
    dispose(): void {
      disposed = true;
      keeper?.dispose(); // writes the last changes now
      editor?.dispose();
      editor = undefined;
      host.remove();
    },
    hasUnsavedChanges(): boolean {
      // Kept as typed, so leaving loses nothing unless keeping them stopped or failed.
      if (keeper !== undefined && !keeper.stopped()) return false;
      return editor?.hasUnsavedChanges() ?? false;
    },
    hasInFlightWork(): boolean {
      return (keeper?.busy() ?? false) || (editor?.hasInFlightWork() ?? false);
    },
  };
};

/** Discover recipes already watching one accepted-form stream, then either
 * open one through its canonical link or mount a fresh unsaved starter. The
 * route still carries only the stable form-definition context. */
export const mountFormResponseRecipeSeedRoute = (
  options: MountFormResponseRecipeSeedRouteOptions,
): MountRecipeEditorRoute => {
  const doc =
    options.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountFormResponseRecipeSeedRoute: no document available; pass options.document for non-browser environments',
    );
  }
  injectStyles(doc);

  const host = doc.createElement('section');
  host.setAttribute(
    MOUNT_RECIPE_EDITOR_HOST_ATTR,
    `new:form-response:${options.formDefinitionId}`,
  );
  options.root.appendChild(host);

  let disposed = false;
  let editor: RecipeEditorRoute | undefined;

  /** Discovery replaces an asynchronous loading shell. Own focus only while
   *  this route still owns the keyboard; a person who moved into persistent
   *  Kitchen chrome during the read must not be pulled back. */
  const ownsTransitionFocus = (): boolean => {
    const active = doc.activeElement as HTMLElement | null | undefined;
    const body = (doc as Partial<Pick<Document, 'body'>>).body;
    if (active === null || active === undefined || active === body) return true;
    try {
      return host.contains(active);
    } catch {
      return false;
    }
  };

  const renderDraftFailure = (error: unknown): void => {
    clearChildren(host);
    const line = doc.createElement('p');
    line.setAttribute(MOUNT_RECIPE_EDITOR_STATUS_ATTR, 'error');
    line.textContent = `Couldn’t create this automation draft: ${humanizeRpcError(error)}`;
    host.appendChild(line);

    const back = doc.createElement('a');
    back.setAttribute(FORM_RESPONSE_AUTOMATION_BACK_ATTR, '');
    back.setAttribute('href', serializeShellRoute('data'));
    back.textContent = '← Back to Data';
    host.appendChild(back);
  };

  const mountFreshDraft = (template?: ServerRecipeFullEntry): void => {
    if (disposed || editor !== undefined) return;
    try {
      const draftKey = options.draftKey ?? createFormResponseAutomationDraftKey();
      const initialRecipe = template === undefined
        ? createFormResponseAutomationSeed(options.formDefinitionId, draftKey)
        : createFormResponseAutomationFromWorkflowTemplate(
            template,
            options.formDefinitionId,
            draftKey,
          );
      clearChildren(host);
      editor = bootstrapRecipeEditorRoute({
        recovery: options.recovery,
        root: host,
        ...(options.document !== undefined ? { document: options.document } : {}),
        initialRecipe,
        initialDirty: true,
        validateCaller: options.validateCaller,
        simulateCaller: options.simulateCaller,
        saveCaller: options.saveCaller,
        ...(options.mailFactTypesCaller !== undefined ? { mailFactTypesCaller: options.mailFactTypesCaller } : {}),
        ...(options.mailTemplatesCaller !== undefined ? { mailTemplatesCaller: options.mailTemplatesCaller } : {}),
        ...(options.mailTemplateStarterCaller !== undefined
          ? { mailTemplateStarterCaller: options.mailTemplateStarterCaller }
          : {}),
        // This route's callers take the result alone.
        ...(options.onSaved !== undefined ? { onSaved: (result: RecipeSaveResult) => options.onSaved?.(result) } : {}),
      });
    } catch (error: unknown) {
      if (!disposed) renderDraftFailure(error);
    }
  };

  const makeCreateButton = (label: string): HTMLButtonElement => {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'rx-btn rx-btn-primary rx-btn-sm';
    button.setAttribute(FORM_RESPONSE_AUTOMATION_CREATE_ATTR, '');
    button.textContent = label;
    button.addEventListener('click', () => mountFreshDraft());
    return button;
  };

  const renderDiscovery = (
    matches: ReadonlyArray<FormResponseAutomationMatch>,
    templates: ReadonlyArray<FormResponseWorkflowTemplateMatch>,
  ): void => {
    const focusHeading = ownsTransitionFocus();
    clearChildren(host);
    const panel = doc.createElement('div');
    panel.setAttribute(FORM_RESPONSE_AUTOMATION_DISCOVERY_ATTR, '');

    const eyebrow = doc.createElement('p');
    eyebrow.className = 'form-response-automation-eyebrow';
    eyebrow.textContent = 'What happens when you accept an answer';
    panel.appendChild(eyebrow);

    const heading = doc.createElement('h1');
    heading.tabIndex = -1;
    heading.textContent = 'What runs for this form';
    panel.appendChild(heading);

    const intro = doc.createElement('p');
    intro.className = 'form-response-automation-intro';
    intro.textContent = matches.length === 0
      ? 'Pick a ready-made template, or start from nothing.'
      : matches.length === 1
        ? 'One saved Recipe runs when you accept an answer to this form. Open it, use a ready-made template, or start another automation.'
        : `${matches.length} saved Recipes run when you accept an answer to this form. Open one, use a ready-made template, or start another automation.`;
    panel.appendChild(intro);

    if (matches.length > 0) {
      const list = doc.createElement('ul');
      for (const match of matches) {
        const item = doc.createElement('li');
        item.setAttribute(FORM_RESPONSE_AUTOMATION_ITEM_ATTR, match.entry.recipe_id);

        const link = doc.createElement('a');
        link.setAttribute(
          'href',
          serializeShellRoute('kitchen', 'recipe', match.entry.recipe_id),
        );

        const name = doc.createElement('strong');
        name.textContent = match.entry.recipe.metadata?.name?.trim()
          || match.entry.recipe_id;
        link.appendChild(name);

        const id = doc.createElement('code');
        id.textContent = match.entry.recipe_id;
        link.appendChild(id);

        const scope = doc.createElement('span');
        scope.setAttribute(FORM_RESPONSE_AUTOMATION_SCOPE_ATTR, match.scope);
        scope.textContent = match.scope === 'this_form'
          ? 'This form'
          : match.scope === 'this_form_filtered'
            ? 'This form, plus filters'
            : 'All forms';
        if (match.scope === 'this_form_filtered') {
          scope.setAttribute(
            'title',
            'This Recipe only runs for certain answers or links.',
          );
        }
        link.appendChild(scope);

        item.appendChild(link);
        list.appendChild(item);
      }
      panel.appendChild(list);
    }

    for (const template of templates) {
      const row = doc.createElement('div');
      row.setAttribute(FORM_RESPONSE_WORKFLOW_TEMPLATE_ATTR, template.entry.recipe_id);
      const templateName = template.entry.recipe.metadata.name
        || template.entry.recipe_id;
      const name = doc.createElement('strong');
      name.textContent = templateName;
      row.appendChild(name);
      const bundle = doc.createElement('code');
      bundle.textContent = template.bundle_key;
      row.appendChild(bundle);
      const use = doc.createElement('button');
      use.type = 'button';
      use.className = 'rx-btn rx-btn-primary rx-btn-sm';
      use.setAttribute(FORM_RESPONSE_WORKFLOW_TEMPLATE_USE_ATTR, template.entry.recipe_id);
      use.setAttribute(
        'aria-label',
        `Use a ready-made template ${templateName} (${template.entry.recipe_id})`,
      );
      use.textContent = 'Use a ready-made template';
      use.addEventListener('click', () => mountFreshDraft(template.entry));
      row.appendChild(use);
      panel.appendChild(row);
    }

    panel.appendChild(makeCreateButton(
      matches.length > 0 ? 'Make another one' : 'Start from nothing',
    ));
    host.appendChild(panel);
    if (focusHeading) heading.focus?.({ preventScroll: true });
  };

  const renderDiscoveryFailure = (error: unknown): void => {
    const focusRecovery = ownsTransitionFocus();
    clearChildren(host);
    const line = doc.createElement('p');
    line.setAttribute(MOUNT_RECIPE_EDITOR_STATUS_ATTR, 'error');
    line.setAttribute('role', 'alert');
    line.textContent = `Couldn’t check existing automations: ${humanizeRpcError(error)}`;
    host.appendChild(line);
    const recovery = makeCreateButton('Make a new one anyway');
    host.appendChild(recovery);
    if (focusRecovery) recovery.focus?.({ preventScroll: true });
  };

  const loading = doc.createElement('p');
  loading.setAttribute(MOUNT_RECIPE_EDITOR_STATUS_ATTR, 'loading');
  loading.textContent = 'Looking at what you already have…';
  host.appendChild(loading);

  void Promise.resolve()
    .then(options.listCaller)
    .then(
      async (result) => {
        if (disposed) return;
        const matches = findFormResponseAutomations(
          result.recipes,
          options.formDefinitionId,
        );
        const templates = await findFormResponseWorkflowTemplates(
          result.recipes,
          options.getCaller,
        );
        if (disposed) return;
        if (matches.length === 0 && templates.length === 0) {
          mountFreshDraft();
          return;
        }
        renderDiscovery(matches, templates);
      },
      (error: unknown) => {
        if (disposed) return;
        renderDiscoveryFailure(error);
      },
    )
    .catch((error: unknown) => {
      if (disposed) return;
      renderDiscoveryFailure(error);
    });

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        editor?.dispose();
        editor = undefined;
      } finally {
        host.remove();
      }
    },
    hasUnsavedChanges(): boolean {
      return !disposed && (editor?.hasUnsavedChanges() ?? false);
    },
    hasInFlightWork(): boolean {
      return !disposed && (editor?.hasInFlightWork() ?? false);
    },
  };
};
