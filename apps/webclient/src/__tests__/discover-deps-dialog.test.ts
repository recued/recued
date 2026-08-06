/** Discover deps box — the recipe install consent dialog. */

import { describe, expect, it, vi } from 'vitest';

import {
  mountRecipeInstallDialog,
  RECIPE_DIALOG_CANCEL_ATTR,
  RECIPE_DIALOG_DEP_ATTR,
  RECIPE_DIALOG_DEP_TOGGLE_ATTR,
  RECIPE_DIALOG_ERROR_ATTR,
  RECIPE_DIALOG_INSTALL_ATTR,
  RECIPE_DIALOG_STYLES,
  type MountRecipeInstallDialogOptions,
} from '../discover/recipe-install-dialog.js';
import {
  INSTALL_GRANT_PICKER_ATTR,
  INSTALL_GRANT_SCOPE_OPTION_ATTR,
} from '../settings/install-grant-picker.js';
import type { ResolvedDep } from '../recipes/required-packs.js';
import type { BulkPackManifest, OpKind, PackContentRef, RiskTier } from '@recued/contracts';

/** A pack whose by-value composition binds a single non-`cli` op → a non-null
 *  grant model → the co-install row renders the {Access × Scope} picker. */
const connManifest = (
  slug: string,
  opRisk: RiskTier = 'read',
  kind: OpKind = 'connection',
): BulkPackManifest => ({
  manifest_version: 2,
  slug,
  publisher: 'recued-core',
  name: slug,
  description: '',
  version: 1,
  recipes: [],
  requires: [],
  tags: [],
  service_kind: 'entity_platform',
  contents: [
    {
      type: 'composition',
      composition: {
        schema_version: 1,
        slug: `${slug}-composition`,
        ingredients: [{ slug: 'vendor', kind }],
        operations: [
          { op: `${slug}.op`, ingredient: 'vendor', risk: opRisk, approval: opRisk === 'read' ? 'never' : 'ask', bind: {} },
        ],
      },
    } as PackContentRef,
  ],
});

const makeEl = (tag: string, onFocus?: (el: any) => void) => {
  const children: any[] = [];
  const attrs = new Map<string, string>();
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const el: any = {
    tagName: tag.toUpperCase(),
    textContent: '',
    children,
    attrs,
    listeners,
    parent: null,
    get firstChild() {
      return children[0] ?? null;
    },
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    getAttribute: (k: string) => attrs.get(k) ?? null,
    appendChild: (c: any) => {
      c.parent = el;
      children.push(c);
      return c;
    },
    removeChild: (c: any) => {
      const i = children.indexOf(c);
      if (i >= 0) children.splice(i, 1);
      c.parent = null;
      return c;
    },
    addEventListener: (t: string, fn: (ev: unknown) => void) => {
      const a = listeners.get(t) ?? [];
      a.push(fn);
      listeners.set(t, a);
    },
    removeEventListener: () => {},
    remove: () => {
      if (el.parent) el.parent.removeChild(el);
    },
    focus: () => onFocus?.(el),
  };
  return el;
};
const fakeDoc = () => {
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const doc: any = {
    activeElement: null,
    listeners,
    addEventListener: (type: string, listener: (ev: unknown) => void) => {
      const current = listeners.get(type) ?? [];
      current.push(listener);
      listeners.set(type, current);
    },
    removeEventListener: (type: string, listener: (ev: unknown) => void) => {
      const current = listeners.get(type);
      if (current === undefined) return;
      const index = current.indexOf(listener);
      if (index >= 0) current.splice(index, 1);
    },
    dispatch: (type: string, event: unknown) => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
  };
  doc.createElement = (tag: string) => makeEl(tag, (el) => {
    doc.activeElement = el;
  });
  return doc as Document & { dispatch(type: string, event: unknown): void };
};

const walk = (el: any, pred: (e: any) => boolean, out: any[] = []): any[] => {
  for (const c of el.children ?? []) {
    if (pred(c)) out.push(c);
    walk(c, pred, out);
  }
  return out;
};
const depRows = (host: any) => walk(host, (e) => e.getAttribute?.(RECIPE_DIALOG_DEP_ATTR) !== null);
const installBtn = (host: any) => walk(host, (e) => e.getAttribute?.(RECIPE_DIALOG_INSTALL_ATTR) !== null)[0];
const cancelBtn = (host: any) => walk(host, (e) => e.getAttribute?.(RECIPE_DIALOG_CANCEL_ATTR) !== null)[0];
const dialogBox = (host: any) => walk(host, (e) => e.getAttribute?.('role') === 'dialog')[0];
const depToggles = (host: any) => walk(host, (e) => e.getAttribute?.(RECIPE_DIALOG_DEP_TOGGLE_ATTR) !== null);
const errors = (host: any) => walk(host, (e) => e.getAttribute?.(RECIPE_DIALOG_ERROR_ATTR) !== null);
const pickers = (host: any) => walk(host, (e) => e.getAttribute?.(INSTALL_GRANT_PICKER_ATTR) !== null);
const scopeRadios = (host: any) => walk(host, (e) => e.getAttribute?.(INSTALL_GRANT_SCOPE_OPTION_ATTR) !== null);
const collectText = (host: any): string =>
  [host, ...walk(host, () => true)].map((e) => e.textContent ?? '').join(' ');

const dep = (over: Partial<ResolvedDep>): ResolvedDep => ({
  pack_ref: `recued-core.${over.pack ?? 'p'}`,
  publisher: 'recued-core',
  pack: 'p',
  name: 'P',
  requires: [],
  installed: false,
  known: true,
  ...over,
});

const recipe = { recipe_id: 'deal-risk', name: 'Deal Risk', publisher_id: 'recued-core', version: 3 };

const setup = (over: Partial<MountRecipeInstallDialogOptions> = {}) => {
  const document = fakeDoc();
  const host = document.createElement('div') as any;
  const installPack = vi.fn(async () => ({ ok: true }));
  const installRecipe = vi.fn(async () => ({ ok: true }));
  const onInstalled = vi.fn();
  const dialog = mountRecipeInstallDialog({
    host: host as unknown as HTMLElement,
    document,
    installPack,
    installRecipe,
    onInstalled,
    ...over,
  });
  return { host, document, dialog, installPack, installRecipe, onInstalled };
};

const deps: ResolvedDep[] = [
  dep({ pack: 'hubspot', name: 'HubSpot', installed: true, known: true, service_kind: 'entity_platform' }),
  dep({ pack: 'salesforce', name: 'Salesforce', installed: false, known: true, requires: ['install_bulk_pack', 'read_connection_salesforce'] }),
  dep({ pack: 'thirdparty', name: 'thirdparty', installed: false, known: false }),
];

describe('mountRecipeInstallDialog', () => {
  it('opens with a row per dep and defaults selection to missing+known packs', () => {
    const { host, dialog } = setup();
    dialog.open(recipe, deps);
    expect(dialog.isOpen()).toBe(true);
    expect(depRows(host)).toHaveLength(3);
    expect(collectText(host)).toContain(
      'Install this recipe together with any selected packs it needs to run.',
    );
    // hubspot installed (no checkbox), salesforce missing+known (checked),
    // thirdparty unknown (no checkbox) → only salesforce selected.
    expect(dialog.getSelectedPacks()).toEqual(['salesforce']);
  });

  it('names a missing dependency checkbox and gives it a full label target', () => {
    const { host, dialog } = setup();
    dialog.open(recipe, deps);

    const toggle = depToggles(host)[0];
    expect(toggle.getAttribute('aria-label')).toBe('Install Salesforce');
    expect(toggle.parent?.tagName).toBe('LABEL');
    expect(toggle.parent?.className).toBe('recipe-dialog-dep-select');
    expect(toggle.parent?.children[1]?.textContent).toBe('Salesforce');
    expect(RECIPE_DIALOG_STYLES).toContain(
      '.recipe-dialog-dep-select {\n'
        + '  display: inline-flex; flex: 1 1 180px; min-width: 0; max-width: 100%;\n'
        + '  align-items: center; gap: 8px; min-height: 36px;',
    );
  });

  it('contains long recipe and dependency text within the consent dialog', () => {
    expect(RECIPE_DIALOG_STYLES).toContain(
      'box-sizing: border-box; width: 100%; min-width: 0; max-width: 680px;',
    );
    expect(RECIPE_DIALOG_STYLES).toContain(
      '.recipe-dialog-box > * { min-width: 0; max-width: 100%; }',
    );
    expect(RECIPE_DIALOG_STYLES).toContain(
      'letter-spacing: -.02em; overflow-wrap: anywhere;',
    );
    expect(RECIPE_DIALOG_STYLES).toContain(
      'grid-template-columns: repeat(auto-fit, minmax(min(176px, 100%), 1fr));',
    );
    expect(RECIPE_DIALOG_STYLES).toContain(
      '.igp-access-list, .igp-scope-list\n  ) { grid-template-columns: minmax(0, 1fr); }',
    );
  });

  it('opens as a labelled modal, owns initial focus, and restores its opener', () => {
    const { host, document, dialog } = setup();
    const opener = document.createElement('button') as any;
    opener.focus();

    dialog.open(recipe, deps);

    const box = dialogBox(host);
    expect(box.getAttribute('aria-modal')).toBe('true');
    expect(box.getAttribute('aria-label')).toBe('Install Deal Risk');
    expect(document.activeElement).toBe(box);
    expect(cancelBtn(host)).toBeDefined();

    dialog.clickCancel();
    expect(dialog.isOpen()).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('keeps the pending Install command focused and single-flight through failure', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const installRecipe = vi.fn(async () => {
      await gate;
      return { ok: false, message: 'Recipe install unavailable.' };
    });
    const { host, document, dialog } = setup({ installRecipe });
    dialog.open(recipe, []);
    const original = installBtn(host);
    original.focus();

    const pending = dialog.clickInstall();
    const busy = installBtn(host);
    expect(busy).not.toBe(original);
    expect(busy.disabled).not.toBe(true);
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.textContent).toBe('Installing…');
    expect(document.activeElement).toBe(busy);

    await dialog.clickInstall();
    expect(installRecipe).toHaveBeenCalledTimes(1);
    release();
    await pending;

    const retry = installBtn(host);
    expect(retry).not.toBe(busy);
    expect(retry.getAttribute('aria-disabled')).toBeNull();
    expect(retry.getAttribute('aria-busy')).toBeNull();
    expect(document.activeElement).toBe(retry);
    expect(errors(host)).toHaveLength(1);
    expect(errors(host)[0].getAttribute('role')).toBe('alert');
    expect(errors(host)[0].textContent).toBe('Recipe install unavailable.');
  });

  it('keeps the changed dependency checkbox focused through its repaint', () => {
    const { host, document, dialog } = setup();
    dialog.open(recipe, deps);
    const original = depToggles(host)[0];
    original.focus();

    for (const listener of original.listeners.get('change') ?? []) listener({});

    const replacement = depToggles(host)[0];
    expect(replacement).not.toBe(original);
    expect(replacement.getAttribute(RECIPE_DIALOG_DEP_TOGGLE_ATTR)).toBe('salesforce');
    expect(document.activeElement).toBe(replacement);
  });

  it('ships a scroll-safe, responsive consent surface', () => {
    expect(RECIPE_DIALOG_STYLES).toContain('max-width: 680px');
    expect(RECIPE_DIALOG_STYLES).toContain('overflow-y: auto');
    expect(RECIPE_DIALOG_STYLES).toContain('@media (max-width: 560px)');
  });

  it('install button label reflects the co-install count', () => {
    const { host, dialog } = setup();
    dialog.open(recipe, deps);
    expect(installBtn(host).textContent).toBe('Install recipe + 1 pack');
    dialog.togglePack('salesforce'); // deselect
    expect(installBtn(host).textContent).toBe('Install recipe');
  });

  it('confirm installs each selected pack (with its requires) THEN the recipe, then closes', async () => {
    const { dialog, installPack, installRecipe, onInstalled } = setup();
    dialog.open(recipe, deps);
    await dialog.clickInstall();
    expect(installPack).toHaveBeenCalledWith('salesforce', ['install_bulk_pack', 'read_connection_salesforce']);
    expect(installRecipe).toHaveBeenCalledWith('deal-risk');
    // pack before recipe.
    expect(installPack.mock.invocationCallOrder[0]).toBeLessThan(installRecipe.mock.invocationCallOrder[0]);
    expect(onInstalled).toHaveBeenCalledWith('deal-risk');
    expect(dialog.isOpen()).toBe(false);
  });

  it('a deselected pack is not co-installed', async () => {
    const { dialog, installPack, installRecipe } = setup();
    dialog.open(recipe, deps);
    dialog.togglePack('salesforce');
    await dialog.clickInstall();
    expect(installPack).not.toHaveBeenCalled();
    expect(installRecipe).toHaveBeenCalledWith('deal-risk');
  });

  it('a pack install failure shows an error, skips the recipe, stays open', async () => {
    const installPack = vi.fn(async () => ({ ok: false, message: 'no network' }));
    const { dialog, installRecipe } = setup({ installPack });
    dialog.open(recipe, deps);
    await dialog.clickInstall();
    expect(dialog.getError()).toBe('no network');
    expect(installRecipe).not.toHaveBeenCalled();
    expect(dialog.isOpen()).toBe(true);
    expect(dialog.isBusy()).toBe(false);
  });

  it('a recipe install failure shows an error, stays open', async () => {
    const installRecipe = vi.fn(async () => ({ ok: false, message: 'validator rejected' }));
    const { dialog } = setup({ installRecipe });
    dialog.open(recipe, deps);
    await dialog.clickInstall();
    expect(dialog.getError()).toBe('validator rejected');
    expect(dialog.isOpen()).toBe(true);
  });

  it('cancel closes without installing', async () => {
    const { dialog, installPack, installRecipe } = setup();
    dialog.open(recipe, deps);
    dialog.clickCancel();
    expect(dialog.isOpen()).toBe(false);
    expect(installPack).not.toHaveBeenCalled();
    expect(installRecipe).not.toHaveBeenCalled();
  });

  it('open() while an install is in-flight does not clobber the busy dialog', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const installPack = vi.fn(async () => {
      await gate;
      return { ok: true };
    });
    const { dialog } = setup({ installPack });
    dialog.open(recipe, deps); // recipe A, salesforce selected
    const p = dialog.clickInstall(); // busy — awaiting the gated installPack
    expect(dialog.isBusy()).toBe(true);
    // A background card's Install re-enters open() with recipe B while busy.
    dialog.open(
      { recipe_id: 'other', name: 'Other', publisher_id: 'x', version: 1 },
      [dep({ pack: 'zzz', name: 'ZZZ', installed: false, known: true })],
    );
    // Must NOT clobber A — still A's selection, still busy.
    expect(dialog.getSelectedPacks()).toEqual(['salesforce']);
    expect(dialog.isBusy()).toBe(true);
    release();
    await p;
    expect(dialog.isOpen()).toBe(false); // A completed + closed
  });

  it('dispose removes the dialog from its host', () => {
    const { host, dialog } = setup();
    dialog.open(recipe, deps);
    expect(host.children.length).toBe(1);
    dialog.dispose();
    expect(host.children.length).toBe(0);
  });
});

describe('mountRecipeInstallDialog — per-dep grant scope (§7.1/§7.2)', () => {
  const connDep = (slug: string, opRisk: RiskTier = 'read'): ResolvedDep =>
    dep({ pack: slug, name: slug, installed: false, known: true, requires: ['install_bulk_pack'], manifest: connManifest(slug, opRisk) });

  it('renders a Scope picker for a connection-backed dep; none for a plain dep', () => {
    const { host, dialog } = setup();
    dialog.open(recipe, [connDep('salesforce'), dep({ pack: 'plain', name: 'Plain', installed: false, known: true })]);
    // One picker (salesforce is connection-backed); plain dep has a null model.
    expect(pickers(host)).toHaveLength(1);
    expect(scopeRadios(host).map((radio) => radio.getAttribute('data-scope'))).toEqual([
      'owner',
      'all_customers',
      'all_other_contracts',
    ]);
    expect(dialog.getDepGrantModel('salesforce')).not.toBeNull();
    expect(dialog.getDepGrantModel('plain')).toBeNull();
  });

  it('keeps the changed dependency grant choice focused through its repaint', () => {
    const { host, document, dialog } = setup();
    dialog.open(recipe, [connDep('salesforce')]);
    const original = scopeRadios(host).find(
      (radio) => radio.getAttribute('data-scope') === 'all_customers',
    );
    original.checked = true;
    original.focus();

    for (const listener of original.listeners.get('change') ?? []) listener({});

    const replacement = scopeRadios(host).find(
      (radio) => radio.getAttribute('data-scope') === 'all_customers',
    );
    expect(replacement).not.toBe(original);
    expect(document.activeElement).toBe(replacement);
    expect(dialog.getDepScope('salesforce')).toBe('all_customers');
  });

  it('defaults to You only (owner) + read, and sends install_scope on co-install', async () => {
    const { dialog, installPack } = setup();
    dialog.open(recipe, [connDep('salesforce')]);
    expect(dialog.getDepScope('salesforce')).toBe('owner');
    expect(dialog.getDepAccess('salesforce')).toBe('read');
    await dialog.clickInstall();
    expect(installPack).toHaveBeenCalledWith('salesforce', ['install_bulk_pack'], {
      access: 'read',
      audience: { owner: true, all_customers: false, all_other_contracts: false },
    });
  });

  it('choosing Everyone sends install_scope.scope all_contracts', async () => {
    const { dialog, installPack } = setup();
    dialog.open(recipe, [connDep('salesforce')]);
    dialog.setDepScope('salesforce', 'all_contracts');
    await dialog.clickInstall();
    expect(installPack).toHaveBeenCalledWith('salesforce', ['install_bulk_pack'], {
      access: 'read',
      audience: { owner: true, all_customers: true, all_other_contracts: true },
    });
  });

  it('choosing All customers sends install_scope.scope all_customers', async () => {
    const { dialog, installPack } = setup();
    dialog.open(recipe, [connDep('salesforce')]);
    dialog.setDepScope('salesforce', 'all_customers');
    await dialog.clickInstall();
    expect(installPack).toHaveBeenCalledWith('salesforce', ['install_bulk_pack'], {
      access: 'read',
      audience: { owner: true, all_customers: true, all_other_contracts: false },
    });
  });

  it('choosing All other contracts sends install_scope.scope all_other_contracts', async () => {
    const { dialog, installPack } = setup();
    dialog.open(recipe, [connDep('salesforce')]);
    dialog.setDepScope('salesforce', 'all_other_contracts');
    await dialog.clickInstall();
    expect(installPack).toHaveBeenCalledWith('salesforce', ['install_bulk_pack'], {
      access: 'read',
      audience: { owner: true, all_customers: false, all_other_contracts: true },
    });
  });

  it('a write-tier dep offers the Access step-up; the pick rides install_scope', async () => {
    const { dialog, installPack } = setup();
    dialog.open(recipe, [connDep('salesforce', 'write')]);
    // write-tier op → the model offers read (floor) + write; default stays read.
    expect(dialog.getDepAccess('salesforce')).toBe('read');
    dialog.setDepAccess('salesforce', 'write');
    dialog.setDepScope('salesforce', 'all_contracts');
    await dialog.clickInstall();
    expect(installPack).toHaveBeenCalledWith('salesforce', ['install_bulk_pack'], {
      access: 'write',
      audience: { owner: true, all_customers: true, all_other_contracts: true },
    });
  });

  it('a null-model (cli / recipe-only) dep co-installs with NO install_scope (2-arg call)', async () => {
    const { dialog, installPack } = setup();
    // No manifest → null model → no picker, no install_scope (unchanged wire).
    dialog.open(recipe, [dep({ pack: 'whisper', name: 'Whisper', installed: false, known: true, requires: ['install_bulk_pack'] })]);
    await dialog.clickInstall();
    expect(installPack).toHaveBeenCalledWith('whisper', ['install_bulk_pack']);
  });

  it('unchecking a connection-backed dep hides its picker', () => {
    const { host, dialog } = setup();
    dialog.open(recipe, [connDep('salesforce')]);
    expect(pickers(host)).toHaveLength(1);
    dialog.togglePack('salesforce'); // deselect → not installing → no grant choice
    expect(pickers(host)).toHaveLength(0);
  });

  it('re-opening for another recipe resets Scope to the owner default', async () => {
    const { dialog, installPack } = setup();
    dialog.open(recipe, [connDep('salesforce')]);
    dialog.setDepScope('salesforce', 'all_contracts');
    dialog.clickCancel();
    // A different recipe, same dep — the prior Everyone pick must NOT leak.
    dialog.open({ recipe_id: 'other', name: 'Other', publisher_id: 'x', version: 1 }, [connDep('salesforce')]);
    expect(dialog.getDepScope('salesforce')).toBe('owner');
    await dialog.clickInstall();
    expect(installPack).toHaveBeenCalledWith('salesforce', ['install_bulk_pack'], {
      access: 'read',
      audience: { owner: true, all_customers: false, all_other_contracts: false },
    });
  });
});
