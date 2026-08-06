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
  LocalRecipeWebhookStatus,
  RecipeDefinition,
  ServerRecipeListEntry,
  WebhookIngressBindingSelection,
  WebhookIngressView,
} from '@recued/contracts';
import { PRIMITIVE_STYLES } from '@recued/ui-shared/primitives';

import { serializeShellRoute } from '../../shell/route.js';
import { humanizeRpcError } from '../../shell/rpc-error-copy.js';
import {
  bootstrapRecipeEditorRoute,
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
  max-width: 1080px;
  margin: 0 auto;
  padding: 24px;
  color: var(--fg);
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
  root: HTMLElement;
  document?: Document;
  /** The recipe to load into the editor (seg 1 of `#kitchen/recipe/<id>`). */
  recipeId: string;
  /** Resolves the full definition — reuses the recipes route's `recipe.list`
   *  caller (each entry carries `recipe`; there is no `recipe.get`). */
  listCaller: RecipeListCaller;
  validateCaller: (args: { recipe: RecipeDefinition }) => Promise<RecipeValidateResult>;
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
  onSaved?: (result: RecipeSaveResult) => void;
}

export interface MountRecipeEditorRoute {
  dispose(): void;
  /** Leave-guard seam — false while loading / not-found (nothing to lose),
   *  else the mounted editor's dirty state. */
  hasUnsavedChanges(): boolean;
  hasInFlightWork(): boolean;
}

export interface MountFormResponseRecipeSeedRouteOptions {
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
  validateCaller: (args: { recipe: RecipeDefinition }) => Promise<RecipeValidateResult>;
  saveCaller: (args: {
    recipe: RecipeDefinition;
    publisher_id?: string;
  }) => Promise<RecipeSaveResult>;
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
      const result = await options.listCaller();
      if (disposed) return;
      const entry = result.recipes.find(
        (r) => r.recipe_id === options.recipeId,
      );
      if (entry === undefined) {
        const focusOwner = statusFocusOwner();
        renderStatus(
          `Recipe "${options.recipeId}" isn't installed on this server.`,
          'error',
          { focusBack: (retryOwned && focusOwner.retry) || focusOwner.back },
        );
        return;
      }
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
      clearChildren(host);
      editor = bootstrapRecipeEditorRoute({
        root: host,
        ...(options.document !== undefined ? { document: options.document } : {}),
        initialRecipe: entry.recipe,
        validateCaller: options.validateCaller,
        saveCaller: options.saveCaller,
        ...(webhookControl ? { webhookControl } : {}),
        ...(options.onSaved !== undefined ? { onSaved: options.onSaved } : {}),
      });
    } catch (error: unknown) {
      if (disposed) return;
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
      editor?.dispose();
      editor = undefined;
      host.remove();
    },
    hasUnsavedChanges(): boolean {
      return editor?.hasUnsavedChanges() ?? false;
    },
    hasInFlightWork(): boolean {
      return editor?.hasInFlightWork() ?? false;
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

  const mountFreshDraft = (template?: ServerRecipeListEntry): void => {
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
        root: host,
        ...(options.document !== undefined ? { document: options.document } : {}),
        initialRecipe,
        initialDirty: true,
        validateCaller: options.validateCaller,
        saveCaller: options.saveCaller,
        ...(options.onSaved !== undefined ? { onSaved: options.onSaved } : {}),
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
    eyebrow.textContent = 'Accepted-response automation';
    panel.appendChild(eyebrow);

    const heading = doc.createElement('h1');
    heading.tabIndex = -1;
    heading.textContent = 'Automations for this form';
    panel.appendChild(heading);

    const intro = doc.createElement('p');
    intro.className = 'form-response-automation-intro';
    intro.textContent = matches.length === 0
      ? 'Choose an installed workflow template, or start with a blank accepted-response automation.'
      : matches.length === 1
        ? 'One saved recipe listens to accepted responses associated with this form. Open it, use an installed workflow template, or start another automation.'
        : `${matches.length} saved recipes listen to accepted responses associated with this form. Open one, use an installed workflow template, or start another automation.`;
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
            ? 'This form + filters'
            : 'All forms';
        if (match.scope === 'this_form_filtered') {
          scope.setAttribute(
            'title',
            'This recipe also narrows by response or endpoint.',
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
        `Use installed workflow template ${templateName} (${template.entry.recipe_id})`,
      );
      use.textContent = 'Use installed workflow template';
      use.addEventListener('click', () => mountFreshDraft(template.entry));
      row.appendChild(use);
      panel.appendChild(row);
    }

    panel.appendChild(makeCreateButton(
      matches.length > 0 ? 'Create another automation' : 'Start blank automation',
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
    const recovery = makeCreateButton('Create a new automation anyway');
    host.appendChild(recovery);
    if (focusRecovery) recovery.focus?.({ preventScroll: true });
  };

  const loading = doc.createElement('p');
  loading.setAttribute(MOUNT_RECIPE_EDITOR_STATUS_ATTR, 'loading');
  loading.textContent = 'Checking existing automations…';
  host.appendChild(loading);

  void Promise.resolve()
    .then(options.listCaller)
    .then(
      (result) => {
        if (disposed) return;
        const matches = findFormResponseAutomations(
          result.recipes,
          options.formDefinitionId,
        );
        const templates = findFormResponseWorkflowTemplates(result.recipes);
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
