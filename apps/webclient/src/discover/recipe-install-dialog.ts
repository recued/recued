/** Discover deps box — the recipe install consent dialog.
 *
 *  Recipes install standalone, but a recipe HARD-depends on the Tier-P packs
 *  whose ops it uses (`recipe.depends_on`). Installing the recipe alone leaves it
 *  born-degraded until those packs are present, so — per the owner — the install
 *  is a consent step that DISCLOSES the dependency packs and CO-INSTALLS the
 *  missing ones in the same dialog (not a chain of hand-offs). A recipe with no
 *  deps skips this entirely (one-click, handled by the caller).
 *
 *  The dialog OWNS the install: on confirm it installs each checked missing pack
 *  (`installPack` — granting that pack's `requires[]`), then the recipe
 *  (`installRecipe`), showing progress + per-step errors inline, and fires
 *  `onInstalled` on success so the caller can reconcile its roster. House-style
 *  DOM (className + data-* + per-el listeners + appendChild) — drives under the
 *  routes' fake document and a real browser alike.
 *
 *  ── Per-dep grant scope (D-182 §7.1/§7.2) ────────────────────────────
 *  A co-installed dep pack IS a pack install, so — for a CONNECTION-BACKED dep
 *  (its manifest carries a by-value composition with a non-`cli` op) — the row
 *  shows the SAME {Access × Audience} grant picker the direct pack install
 *  shows (`renderInstallGrantPicker`). Access defaults to `read`; the Audience
 *  checklist defaults to `You`. The owner can independently include seller
 *  customers, non-customer contracts, or expanded tiers/contracts. Recipe
 *  tools are grantable too, so recipe-only deps also receive the checklist;
 *  a pure-`cli` dep with no recipes remains non-grantable and has no picker.
 */

import {
  installGrantModelFromManifest,
  INSTALL_GRANT_ACCESS_OPTION_ATTR,
  INSTALL_GRANT_AUDIENCE_DETAIL_OPTION_ATTR,
  INSTALL_GRANT_SCOPE_OPTION_ATTR,
  installAudienceFromLegacyScope,
  renderInstallGrantPicker,
  resolveInstallAudienceSelection,
  type InstallGrantPickerModel,
} from '../settings/install-grant-picker.js';
import { wireFocusTrap, type FocusTrapHandle } from '@recued/ui-shared';
import type {
  InstallAccessTier,
  InstallAudienceSelection,
  InstallGrantSelection,
  InstallScopeWho,
} from '@recued/contracts';

import type { ResolvedDep } from '../recipes/required-packs.js';

export const RECIPE_DIALOG_ATTR = 'data-recued-recipe-dialog';
export const RECIPE_DIALOG_DEP_ATTR = 'data-recued-recipe-dialog-dep';
export const RECIPE_DIALOG_INSTALL_ATTR = 'data-recued-recipe-dialog-install';
export const RECIPE_DIALOG_CANCEL_ATTR = 'data-recued-recipe-dialog-cancel';
export const RECIPE_DIALOG_ERROR_ATTR = 'data-recued-recipe-dialog-error';
export const RECIPE_DIALOG_DEP_TOGGLE_ATTR =
  'data-recued-recipe-dialog-dep-toggle';
const RECIPE_DIALOG_DEP_GRANT_CONTROL_ATTR =
  'data-recued-recipe-dialog-dep-grant-control';

export interface RecipeDialogRecipe {
  recipe_id: string;
  name: string;
  publisher_id: string;
  version: number;
}

export interface DialogInstallOutcome {
  ok: boolean;
  message?: string;
}

export interface MountRecipeInstallDialogOptions {
  host: HTMLElement;
  document?: Document;
  /** Install one dependency pack by slug, granting its `requires[]`. The
   *  owner's {Access × Audience} pick rides along when it has grantable ops. */
  installPack: (
    slug: string,
    requires: readonly string[],
    installScope?: InstallGrantSelection,
  ) => Promise<DialogInstallOutcome>;
  /** Install the recipe by slug (the existing `recipe.installBySlug`). */
  installRecipe: (recipe_id: string) => Promise<DialogInstallOutcome>;
  /** Fired after a fully-successful install (recipe + any co-installed packs)
   *  so the caller can re-list + reconcile install-state. */
  onInstalled?: (recipe_id: string) => void;
  /** Restore focus to the current replacement for the recipe's Discover
   *  action. The browse panel repaints after handing off, so the original DOM
   *  opener is detached before this dialog closes. Omit for a stable opener;
   *  the shared focus trap then restores that element directly. */
  returnFocus?: (recipe_id: string) => void;
  /** Humanize a service_kind slug for the type badge. */
  serviceKindLabel?: (kind: string) => string;
}

export interface RecipeInstallDialogMount {
  open(recipe: RecipeDialogRecipe, deps: readonly ResolvedDep[]): void;
  isOpen(): boolean;
  /** Slugs currently checked for co-install. */
  getSelectedPacks(): string[];
  togglePack(slug: string): void;
  /** The derived grant model for a dep; null means no grantable op or tool. */
  getDepGrantModel(slug: string): InstallGrantPickerModel | null;
  /** Legacy single-scope projection of the effective Audience. */
  getDepScope(slug: string): InstallScopeWho;
  setDepScope(slug: string, scope: InstallScopeWho): void;
  /** The effective Access tier for a dep, or null when it has no picker. */
  getDepAccess(slug: string): InstallAccessTier | null;
  setDepAccess(slug: string, access: InstallAccessTier): void;
  clickInstall(): Promise<void>;
  clickCancel(): void;
  isBusy(): boolean;
  getError(): string | null;
  dispose(): void;
}

export const mountRecipeInstallDialog = (
  opts: MountRecipeInstallDialogOptions,
): RecipeInstallDialogMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error('mountRecipeInstallDialog: no document available — pass opts.document');
  }
  const kindLabel = opts.serviceKindLabel ?? ((k: string) => k);

  let recipe: RecipeDialogRecipe | null = null;
  let deps: readonly ResolvedDep[] = [];
  let selected = new Set<string>();
  let busy = false;
  let error: string | null = null;
  let disposed = false;
  let renderedBox: HTMLElement | null = null;
  let focusTrap: FocusTrapHandle | null = null;

  type FocusSnapshot =
    | { readonly kind: 'install' | 'cancel' }
    | { readonly kind: 'dep-toggle'; readonly pack: string }
    | {
        readonly kind: 'grant-access' | 'grant-scope';
        readonly pack: string;
        readonly value: string;
      }
    | {
        readonly kind: 'grant-detail';
        readonly pack: string;
        readonly audienceKind: string;
        readonly audienceId: string;
      };

  const hasAttr = (element: HTMLElement, name: string): boolean =>
    element.getAttribute?.(name) !== null;

  const walkElements = (
    parent: HTMLElement,
    visit: (element: HTMLElement) => void,
  ): void => {
    for (const child of Array.from(parent.children ?? [])) {
      const element = child as HTMLElement;
      visit(element);
      walkElements(element, visit);
    }
  };

  const captureFocus = (): FocusSnapshot | null => {
    const active = doc.activeElement as HTMLElement | null | undefined;
    if (active === null || active === undefined) return null;
    if (hasAttr(active, RECIPE_DIALOG_INSTALL_ATTR)) {
      return { kind: 'install' };
    }
    if (hasAttr(active, RECIPE_DIALOG_CANCEL_ATTR)) {
      return { kind: 'cancel' };
    }
    const depToggle = active.getAttribute?.(RECIPE_DIALOG_DEP_TOGGLE_ATTR);
    if (depToggle !== null && depToggle !== undefined) {
      return { kind: 'dep-toggle', pack: depToggle };
    }
    const pack = active.getAttribute?.(RECIPE_DIALOG_DEP_GRANT_CONTROL_ATTR);
    if (pack === null || pack === undefined) return null;
    if (hasAttr(active, INSTALL_GRANT_ACCESS_OPTION_ATTR)) {
      return {
        kind: 'grant-access',
        pack,
        value: active.getAttribute('data-access') ?? '',
      };
    }
    if (hasAttr(active, INSTALL_GRANT_SCOPE_OPTION_ATTR)) {
      return {
        kind: 'grant-scope',
        pack,
        value: active.getAttribute('data-scope') ?? '',
      };
    }
    if (hasAttr(active, INSTALL_GRANT_AUDIENCE_DETAIL_OPTION_ATTR)) {
      return {
        kind: 'grant-detail',
        pack,
        audienceKind: active.getAttribute('data-audience-kind') ?? '',
        audienceId: active.getAttribute('data-audience-id') ?? '',
      };
    }
    return null;
  };

  const restoreFocus = (snapshot: FocusSnapshot | null): void => {
    if (snapshot === null || renderedBox === null) return;
    let replacement: HTMLElement | null = null;
    walkElements(renderedBox, (element) => {
      if (replacement !== null) return;
      if (
        snapshot.kind === 'install'
        && hasAttr(element, RECIPE_DIALOG_INSTALL_ATTR)
      ) {
        replacement = element;
        return;
      }
      if (
        snapshot.kind === 'cancel'
        && hasAttr(element, RECIPE_DIALOG_CANCEL_ATTR)
      ) {
        replacement = element;
        return;
      }
      if (
        snapshot.kind === 'dep-toggle'
        && element.getAttribute?.(RECIPE_DIALOG_DEP_TOGGLE_ATTR)
          === snapshot.pack
      ) {
        replacement = element;
        return;
      }
      if (
        snapshot.kind === 'grant-access'
        && element.getAttribute?.(RECIPE_DIALOG_DEP_GRANT_CONTROL_ATTR)
          === snapshot.pack
        && hasAttr(element, INSTALL_GRANT_ACCESS_OPTION_ATTR)
        && element.getAttribute('data-access') === snapshot.value
      ) {
        replacement = element;
        return;
      }
      if (
        snapshot.kind === 'grant-scope'
        && element.getAttribute?.(RECIPE_DIALOG_DEP_GRANT_CONTROL_ATTR)
          === snapshot.pack
        && hasAttr(element, INSTALL_GRANT_SCOPE_OPTION_ATTR)
        && element.getAttribute('data-scope') === snapshot.value
      ) {
        replacement = element;
        return;
      }
      if (
        snapshot.kind === 'grant-detail'
        && element.getAttribute?.(RECIPE_DIALOG_DEP_GRANT_CONTROL_ATTR)
          === snapshot.pack
        && hasAttr(element, INSTALL_GRANT_AUDIENCE_DETAIL_OPTION_ATTR)
        && element.getAttribute('data-audience-kind')
          === snapshot.audienceKind
        && element.getAttribute('data-audience-id') === snapshot.audienceId
      ) {
        replacement = element;
      }
    });
    (replacement as HTMLElement | null)?.focus?.({ preventScroll: true });
  };

  // Per-dep grant state (§7.1/§7.2). `grantModels` is derived once per open()
  // from each dep's manifest (null ⇒ no grantable op/tool ⇒ no picker). The
  // pick maps hold the owner's RAW choice; the effective value is resolved
  // through the model (access is clamped to an offered tier; scope defaults to
  // the safe `owner`). Absent pick ⇒ the default, so the happy path is untouched.
  let grantModels = new Map<string, InstallGrantPickerModel | null>();
  const accessPicks = new Map<string, InstallAccessTier>();
  const audiencePicks = new Map<string, InstallAudienceSelection>();

  const grantModelFor = (slug: string): InstallGrantPickerModel | null =>
    grantModels.get(slug) ?? null;
  /** Effective Access — the pick clamped to a tier the model offers, else the
   *  model default (`read`). Mirrors the settings/kitchen resolver. */
  const accessFor = (slug: string, model: InstallGrantPickerModel): InstallAccessTier => {
    const picked = accessPicks.get(slug);
    return picked !== undefined && model.accessOptions.includes(picked)
      ? picked
      : model.defaultAccess;
  };
  /** Effective Audience — the pick, or owner-only (the safe default). */
  const audienceFor = (slug: string): InstallAudienceSelection =>
    resolveInstallAudienceSelection(audiencePicks.get(slug));
  const scopeFor = (slug: string): InstallScopeWho => {
    const audience = audienceFor(slug);
    if (audience.all_customers && audience.all_other_contracts) return 'all_contracts';
    if (audience.all_customers) return 'all_customers';
    if (audience.all_other_contracts) return 'all_other_contracts';
    return 'owner';
  };

  /** The `install_scope` a co-install sends: the owner's {Access × Audience}
   *  pick for any dep with grantable composition ops or recipe tools. */
  const installScopeForDep = (dep: ResolvedDep): InstallGrantSelection | undefined => {
    const model = grantModelFor(dep.pack);
    if (model === null) return undefined;
    return { access: accessFor(dep.pack, model), audience: audienceFor(dep.pack) };
  };

  const root = doc.createElement('div');
  root.setAttribute(RECIPE_DIALOG_ATTR, '');
  root.className = 'recipe-dialog-backdrop';
  root.hidden = true;
  opts.host.appendChild(root);

  const clear = (el: HTMLElement): void => {
    while (el.firstChild) el.removeChild(el.firstChild);
  };

  /** Missing + known (roster-resolved) deps are the co-installable set. */
  const coInstallable = (): ResolvedDep[] => deps.filter((d) => !d.installed && d.known);

  const render = (): void => {
    const focusBeforeRender = captureFocus();
    root.hidden = recipe === null;
    clear(root);
    renderedBox = null;
    if (recipe === null) return;

    const box = doc.createElement('div');
    box.className = 'recipe-dialog-box';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', `Install ${recipe.name}`);
    box.setAttribute('tabindex', '-1');
    renderedBox = box;

    const h = doc.createElement('h2');
    h.className = 'recipe-dialog-title';
    h.textContent = `Install ${recipe.name}`;
    box.appendChild(h);

    const meta = doc.createElement('p');
    meta.className = 'recipe-dialog-meta';
    meta.textContent = `${recipe.publisher_id} · v${recipe.version}`;
    box.appendChild(meta);

    const intro = doc.createElement('p');
    intro.className = 'recipe-dialog-intro';
    intro.textContent =
      'Install this recipe together with any selected packs it needs to run.';
    box.appendChild(intro);

    // ── Dependencies ────────────────────────────────────────────────
    const depsHead = doc.createElement('h3');
    depsHead.className = 'recipe-dialog-section-title';
    depsHead.textContent = 'This recipe uses these packs';
    box.appendChild(depsHead);

    const list = doc.createElement('div');
    list.className = 'recipe-dialog-deps';
    for (const dep of deps) {
      list.appendChild(renderDepRow(dep));
    }
    box.appendChild(list);

    if (error !== null) {
      const err = doc.createElement('p');
      err.setAttribute(RECIPE_DIALOG_ERROR_ATTR, '');
      err.setAttribute('role', 'alert');
      err.className = 'recipe-dialog-error';
      err.textContent = error;
      box.appendChild(err);
    }

    // ── Actions ─────────────────────────────────────────────────────
    const foot = doc.createElement('div');
    foot.className = 'recipe-dialog-foot';

    const cancel = doc.createElement('button') as HTMLButtonElement;
    cancel.type = 'button';
    cancel.setAttribute(RECIPE_DIALOG_CANCEL_ATTR, '');
    cancel.className = 'recipe-dialog-btn';
    cancel.textContent = 'Cancel';
    cancel.disabled = busy;
    cancel.addEventListener('click', () => clickCancel());

    const install = doc.createElement('button') as HTMLButtonElement;
    install.type = 'button';
    install.setAttribute(RECIPE_DIALOG_INSTALL_ATTR, '');
    install.className = 'recipe-dialog-btn recipe-dialog-btn--primary';
    if (busy) {
      // Keep the command that owns the RPC keyboard-focusable. State guards
      // duplicate activation; ARIA communicates the lock without ejecting the
      // owner to <body> when this re-render replaces the button.
      install.setAttribute('aria-disabled', 'true');
      install.setAttribute('aria-busy', 'true');
    }
    const n = coInstallable().filter((d) => selected.has(d.pack)).length;
    install.textContent = busy
      ? 'Installing…'
      : n === 0
        ? 'Install recipe'
        : `Install recipe + ${n} pack${n === 1 ? '' : 's'}`;
    install.addEventListener('click', () => void clickInstall());

    foot.appendChild(cancel);
    foot.appendChild(install);
    box.appendChild(foot);

    root.appendChild(box);
    restoreFocus(focusBeforeRender);
  };

  const renderDepRow = (dep: ResolvedDep): HTMLElement => {
    const row = doc.createElement('div');
    row.setAttribute(RECIPE_DIALOG_DEP_ATTR, dep.pack);
    row.className = 'recipe-dialog-dep';

    const head = doc.createElement('div');
    head.className = 'recipe-dialog-dep-head';

    let toggle: HTMLInputElement | null = null;
    if (dep.installed) {
      const tick = doc.createElement('span');
      tick.className = 'recipe-dialog-dep-tick';
      tick.textContent = '✓';
      head.appendChild(tick);
    } else if (dep.known) {
      const cb = doc.createElement('input') as HTMLInputElement;
      cb.type = 'checkbox';
      cb.className = 'recipe-dialog-dep-check';
      cb.setAttribute(RECIPE_DIALOG_DEP_TOGGLE_ATTR, dep.pack);
      cb.setAttribute('aria-label', `Install ${dep.name}`);
      cb.checked = selected.has(dep.pack);
      cb.disabled = busy;
      cb.addEventListener('change', () => togglePack(dep.pack));
      toggle = cb;
    }

    const name = doc.createElement('span');
    name.className = 'recipe-dialog-dep-name';
    name.textContent = dep.name;
    if (toggle === null) {
      head.appendChild(name);
    } else {
      const label = doc.createElement('label');
      label.className = 'recipe-dialog-dep-select';
      label.appendChild(toggle);
      label.appendChild(name);
      head.appendChild(label);
    }

    if (dep.service_kind !== undefined) {
      const badge = doc.createElement('span');
      badge.className = 'recipe-dialog-dep-badge';
      badge.textContent = kindLabel(dep.service_kind);
      head.appendChild(badge);
    }

    const status = doc.createElement('span');
    status.className = 'recipe-dialog-dep-status';
    status.textContent = dep.installed
      ? 'installed'
      : dep.known
        ? 'will install'
        : 'install from its page';
    head.appendChild(status);
    row.appendChild(head);

    // Permissions the co-install grants (missing + known + has requires).
    if (!dep.installed && dep.known && dep.requires.length > 0) {
      const perms = doc.createElement('p');
      perms.className = 'recipe-dialog-dep-perms';
      perms.textContent = `Grants: ${dep.requires.join(', ')}`;
      row.appendChild(perms);
    }

    // §7.1/§7.2 grant picker — only for a CHECKED dep with grantable
    // composition ops or recipe tools (its manifest yields a non-null model).
    // Unchecked ⇒ not installing it ⇒ no picker; pure-cli with no recipes ⇒ no
    // grantable model and therefore no picker.
    const model = grantModelFor(dep.pack);
    if (!dep.installed && dep.known && model !== null && selected.has(dep.pack)) {
      const picker = renderInstallGrantPicker({
        document: doc,
        model,
        access: accessFor(dep.pack, model),
        audience: audienceFor(dep.pack),
        disabled: busy,
        onAccess: (tier) => {
          if (busy) return;
          accessPicks.set(dep.pack, tier);
          render();
        },
        onAudience: (audience) => {
          if (busy) return;
          audiencePicks.set(dep.pack, resolveInstallAudienceSelection(audience));
          render();
        },
      });
      // The picker is stateless and this dialog rebuilds it after each choice.
      // Stamp its controls with the dependency identity so the exact radio or
      // checkbox can regain focus after that repaint.
      walkElements(picker, (element) => {
        if (
          hasAttr(element, INSTALL_GRANT_ACCESS_OPTION_ATTR)
          || hasAttr(element, INSTALL_GRANT_SCOPE_OPTION_ATTR)
          || hasAttr(element, INSTALL_GRANT_AUDIENCE_DETAIL_OPTION_ATTR)
        ) {
          element.setAttribute(RECIPE_DIALOG_DEP_GRANT_CONTROL_ATTR, dep.pack);
        }
      });
      row.appendChild(picker);
    }
    return row;
  };

  const open = (r: RecipeDialogRecipe, d: readonly ResolvedDep[]): void => {
    // Refuse to clobber an in-flight install (a background card's Install is
    // still keyboard-reachable behind the modal backdrop; re-entering `open`
    // mid-install would reset `busy`/`selected` and half-install both).
    if (busy) return;
    focusTrap?.release();
    focusTrap = null;
    recipe = r;
    deps = d;
    // Default: co-install every missing, roster-known pack.
    selected = new Set(d.filter((x) => !x.installed && x.known).map((x) => x.pack));
    // Derive each co-installable dep's grant model once. Fresh picks each open —
    // the prior recipe's Access/Audience choices must not leak into this one.
    grantModels = new Map(
      d
        .filter((x) => !x.installed && x.known)
        .map((x) => [x.pack, x.manifest !== undefined ? installGrantModelFromManifest(x.manifest) : null] as const),
    );
    accessPicks.clear();
    audiencePicks.clear();
    busy = false;
    error = null;
    render();
    focusTrap = wireFocusTrap({
      document: doc,
      getContainer: () => renderedBox,
      restoreFocus: opts.returnFocus === undefined,
    });
  };

  const close = (): void => {
    const returnRecipeId = recipe?.recipe_id ?? null;
    const trap = focusTrap;
    focusTrap = null;
    recipe = null;
    deps = [];
    selected = new Set();
    grantModels = new Map();
    accessPicks.clear();
    audiencePicks.clear();
    busy = false;
    error = null;
    render();
    trap?.release();
    if (returnRecipeId !== null) opts.returnFocus?.(returnRecipeId);
  };

  const togglePack = (slug: string): void => {
    if (busy) return;
    if (selected.has(slug)) selected.delete(slug);
    else selected.add(slug);
    render();
  };

  const clickCancel = (): void => {
    if (busy) return;
    close();
  };

  root.addEventListener('click', (event) => {
    if (event.target === root) clickCancel();
  });

  const docEvents = doc as unknown as {
    addEventListener?: (type: string, listener: (event: Event) => void) => void;
    removeEventListener?: (type: string, listener: (event: Event) => void) => void;
  };
  const onDocumentKeydown = (event: Event): void => {
    if (recipe === null || (event as KeyboardEvent).key !== 'Escape') return;
    (event as { preventDefault?: () => void }).preventDefault?.();
    if (!busy) clickCancel();
  };
  docEvents.addEventListener?.('keydown', onDocumentKeydown);

  const clickInstall = async (): Promise<void> => {
    if (busy || recipe === null) return;
    const r = recipe;
    busy = true;
    error = null;
    render();
    try {
      // Packs first, so the recipe lands runnable. A failure stops before the
      // recipe install (a born-degraded recipe from a half-done set is worse
      // than a clear "couldn't install pack X").
      for (const dep of coInstallable()) {
        if (!selected.has(dep.pack)) continue;
        // Every dep with grantable composition ops or recipe tools carries the
        // owner's {Access × Audience} pick. A pure-cli/no-recipe dep has no
        // model and keeps the two-argument install call.
        const scope = installScopeForDep(dep);
        const res =
          scope !== undefined
            ? await opts.installPack(dep.pack, dep.requires, scope)
            : await opts.installPack(dep.pack, dep.requires);
        if (!res.ok) {
          error = res.message ?? `Couldn't install ${dep.name}.`;
          busy = false;
          render();
          return;
        }
      }
      const res = await opts.installRecipe(r.recipe_id);
      if (!res.ok) {
        error = res.message ?? "Couldn't install the recipe.";
        busy = false;
        render();
        return;
      }
    } catch (e) {
      error = (e as Error)?.message ?? 'Install failed.';
      busy = false;
      if (!disposed) render();
      return;
    }
    if (disposed) return; // torn down mid-install → don't fire callbacks / render
    opts.onInstalled?.(r.recipe_id);
    close();
  };

  return {
    open,
    isOpen: () => recipe !== null,
    getSelectedPacks: () => [...selected],
    togglePack,
    getDepGrantModel: (slug) => grantModelFor(slug),
    getDepScope: (slug) => scopeFor(slug),
    setDepScope: (slug, who) => {
      if (busy) return;
      audiencePicks.set(slug, installAudienceFromLegacyScope(who));
      render();
    },
    getDepAccess: (slug) => {
      const model = grantModelFor(slug);
      return model === null ? null : accessFor(slug, model);
    },
    setDepAccess: (slug, tier) => {
      if (busy) return;
      accessPicks.set(slug, tier);
      render();
    },
    clickInstall,
    clickCancel,
    isBusy: () => busy,
    getError: () => error,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      focusTrap?.release();
      focusTrap = null;
      docEvents.removeEventListener?.('keydown', onDocumentKeydown);
      try {
        opts.host.removeChild(root);
      } catch {
        root.remove();
      }
    },
  };
};

/** Scoped styles — a centered modal over a dimmed backdrop, on the shell tokens. */
export const RECIPE_DIALOG_STYLES = `
[${RECIPE_DIALOG_ATTR}] {
  box-sizing: border-box; position: fixed; inset: 0; z-index: 60; display: flex;
  max-width: 100%; align-items: flex-start; justify-content: center;
  overflow-y: auto; padding: clamp(16px, 4vw, 36px);
  background: rgba(9,9,11,.56); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
}
[${RECIPE_DIALOG_ATTR}][hidden] { display: none; }
[${RECIPE_DIALOG_ATTR}] .recipe-dialog-box {
  box-sizing: border-box; width: 100%; min-width: 0; max-width: 680px;
  max-height: calc(100vh - 48px); overflow-y: auto;
  background: var(--surface); color: var(--fg); border: 1px solid var(--border);
  border-radius: 16px; padding: clamp(20px, 3vw, 28px); display: grid; gap: 12px;
  box-shadow: 0 28px 80px rgba(0,0,0,.34), 0 3px 10px rgba(0,0,0,.16);
}
[${RECIPE_DIALOG_ATTR}] .recipe-dialog-box > * { min-width: 0; max-width: 100%; }
[${RECIPE_DIALOG_ATTR}] .recipe-dialog-title {
  margin: 0; font-size: 22px; font-weight: 720; line-height: 1.2;
  letter-spacing: -.02em; overflow-wrap: anywhere;
}
[${RECIPE_DIALOG_ATTR}] .recipe-dialog-meta {
  box-sizing: border-box; justify-self: start; margin: -4px 0 0; padding: 3px 8px;
  border: 1px solid var(--border); border-radius: 999px; background: var(--surface-sunk);
  font-size: 11px; color: var(--fg-muted); overflow-wrap: anywhere;
}
[${RECIPE_DIALOG_ATTR}] .recipe-dialog-intro {
  max-width: min(58ch, 100%); margin: 0 0 3px; font-size: 13px;
  line-height: 1.5; color: var(--fg-muted); overflow-wrap: anywhere;
}
[${RECIPE_DIALOG_ATTR}] .recipe-dialog-section-title {
  margin: 8px 0 0; font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
  color: var(--fg-muted); font-weight: 750;
}
[${RECIPE_DIALOG_ATTR}] .recipe-dialog-deps {
  display: grid; min-width: 0; max-width: 100%; gap: 10px;
}
[${RECIPE_DIALOG_DEP_ATTR}] {
  box-sizing: border-box; min-width: 0; max-width: 100%;
  border: 1px solid var(--border); border-radius: 12px; padding: 13px;
  background: var(--surface-sunk); display: grid; gap: 7px;
}
[${RECIPE_DIALOG_DEP_ATTR}] > * { min-width: 0; max-width: 100%; }
[${RECIPE_DIALOG_ATTR}] .recipe-dialog-dep-head {
  display: flex; min-width: 0; max-width: 100%; align-items: center;
  gap: 8px; flex-wrap: wrap;
}
[${RECIPE_DIALOG_ATTR}] .recipe-dialog-dep-select {
  display: inline-flex; flex: 1 1 180px; min-width: 0; max-width: 100%;
  align-items: center; gap: 8px; min-height: 36px; cursor: pointer;
}
[${RECIPE_DIALOG_ATTR}] .recipe-dialog-dep-select:has(input:disabled) {
  cursor: not-allowed;
}
[${RECIPE_DIALOG_ATTR}] .recipe-dialog-dep-tick { color: var(--accent); font-weight: 750; }
[${RECIPE_DIALOG_ATTR}] .recipe-dialog-dep-check {
  flex: 0 0 auto; width: 17px; height: 17px; margin: 0; accent-color: var(--accent);
}
[${RECIPE_DIALOG_ATTR}] .recipe-dialog-dep-name {
  flex: 1 1 180px; min-width: 0; max-width: 100%; font-size: 14px;
  font-weight: 700; overflow-wrap: anywhere;
}
[${RECIPE_DIALOG_ATTR}] .recipe-dialog-dep-badge {
  box-sizing: border-box; min-width: 0; max-width: 100%; font-size: 11px;
  padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border);
  color: var(--fg-muted); overflow-wrap: anywhere;
}
[${RECIPE_DIALOG_ATTR}] .recipe-dialog-dep-status {
  min-width: 0; max-width: 100%; margin-left: auto; font-size: 11px;
  color: var(--fg-subtle); overflow-wrap: anywhere;
}
[${RECIPE_DIALOG_ATTR}] .recipe-dialog-dep-perms {
  margin: 0; font-size: 11px; color: var(--fg-muted); line-height: 1.4;
  overflow-wrap: anywhere;
}
[${RECIPE_DIALOG_ERROR_ATTR}] {
  box-sizing: border-box; min-width: 0; max-width: 100%; margin: 0;
  padding: 10px 12px; font-size: 12px; color: var(--danger); overflow-wrap: anywhere;
  border: 1px solid var(--danger); border-left: 3px solid var(--danger);
  border-radius: 9px; background: var(--danger-weak);
}
[${RECIPE_DIALOG_ATTR}] .recipe-dialog-foot {
  display: flex; flex-wrap: wrap; min-width: 0; max-width: 100%;
  justify-content: flex-end; gap: 8px; margin-top: 6px;
  padding-top: 16px; border-top: 1px solid var(--border);
}
[${RECIPE_DIALOG_ATTR}] .recipe-dialog-btn {
  box-sizing: border-box; min-width: 0; max-width: 100%; min-height: 40px;
  font: inherit; font-size: 13px; font-weight: 650; padding: 8px 16px;
  border-radius: 9px; border: 1px solid var(--border-strong);
  background: var(--surface); color: var(--fg); cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, transform 120ms ease;
}
[${RECIPE_DIALOG_ATTR}] .recipe-dialog-btn:hover:not(:disabled) { transform: translateY(-1px); }
[${RECIPE_DIALOG_ATTR}] .recipe-dialog-btn--primary {
  border-color: var(--accent); background: var(--accent); color: var(--on-accent);
}
[${RECIPE_DIALOG_ATTR}] .recipe-dialog-btn:is(:disabled, [aria-disabled="true"]) {
  opacity: .65; cursor: progress;
}
/* The shared grant picker is mounted inside a dependency row. Own its outer
   width here so an operation id cannot reopen the modal's grid track. */
[${RECIPE_DIALOG_ATTR}] [data-recued-install-grant-picker] {
  box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%;
}
[${RECIPE_DIALOG_ATTR}] [data-recued-install-grant-picker] :is(
  .igp-access-list, .igp-access-row, .igp-access-label,
  .igp-scope, .igp-scope-list, .igp-scope-row, .igp-scope-label
) { min-width: 0; max-width: 100%; }
[${RECIPE_DIALOG_ATTR}] [data-recued-install-grant-picker] :is(
  .igp-heading, .igp-intro, .igp-access-name, .igp-access-hint,
  .igp-access-ops, .igp-scope-name, .igp-scope-hint
) { overflow-wrap: anywhere; }
[${RECIPE_DIALOG_ATTR}] [data-recued-install-grant-picker] .igp-access-list {
  grid-template-columns: repeat(auto-fit, minmax(min(176px, 100%), 1fr));
}
@media (max-width: 560px) {
  [${RECIPE_DIALOG_ATTR}] { padding: 10px; }
  [${RECIPE_DIALOG_ATTR}] .recipe-dialog-box {
    max-height: calc(100vh - 20px); padding: 18px 14px; border-radius: 13px;
  }
  [${RECIPE_DIALOG_ATTR}] .recipe-dialog-title { font-size: 20px; }
  [${RECIPE_DIALOG_ATTR}] .recipe-dialog-foot .recipe-dialog-btn { flex: 1 1 auto; }
  [${RECIPE_DIALOG_ATTR}] [data-recued-install-grant-picker] :is(
    .igp-access-list, .igp-scope-list
  ) { grid-template-columns: minmax(0, 1fr); }
}
`;
