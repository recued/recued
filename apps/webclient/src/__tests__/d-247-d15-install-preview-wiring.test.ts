/** D-247 D15 — the install preview must be REACHED, not merely implemented.
 *
 *  ⛔⛔ THIS FILE EXISTS BECAUSE THE FEATURE SHIPPED DEAD. `packs.install_preview`
 *  had an rpc spec, a server handler, a `props.installPreview`, a renderer and a
 *  risk-scored picker — and no caller anywhere, so nothing ever supplied the
 *  prop. Every unit test around it was green: they all called the pure functions
 *  DIRECTLY. That is the fourth time in D-247 that two correct halves never met.
 *
 *  🔑 So these tests drive `mountPacksPanel` and assert on the DOM the panel
 *  produced. A test that hands `installGrantModelFromManifest` a risk map, or
 *  `renderPacksInstallDialog` an `installPreview`, cannot fail when the wiring
 *  is absent — only a test going THROUGH the panel can. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PACKS_DIALOG_ATTR,
  mountPacksPanel,
  type PacksInstallPreviewCaller,
  type PacksListCaller,
} from '../settings/packs-panel.js';
import {
  INSTALL_RECIPE_DISCLOSURE_ATTR,
  type InstallPreview,
} from '../settings/packs-install-dialog.js';
import type { BulkPackManifest, PackListEntry } from '@recued/contracts';

// ──────────────────────────────────────────────────────────────────
// Fake DOM (same shape as the sibling packs-panel suites)
// ──────────────────────────────────────────────────────────────────

interface FakeElement {
  tagName: string;
  textContent: string;
  disabled: boolean;
  checked: boolean;
  className: string;
  id: string;
  type: string;
  children: FakeElement[];
  parent: FakeElement | null;
  attrs: Map<string, string>;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(el: FakeElement): FakeElement;
  removeChild(el: FakeElement): FakeElement;
  readonly firstChild: FakeElement | null;
  remove(): void;
  addEventListener(name: string, fn: (ev: unknown) => void): void;
  removeEventListener(name: string, fn: (ev: unknown) => void): void;
  click(): void;
}

const makeFakeElement = (tagName: string): FakeElement => {
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const attrs = new Map<string, string>();
  const children: FakeElement[] = [];
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    disabled: false,
    checked: false,
    className: '',
    id: '',
    type: '',
    children,
    parent: null,
    attrs,
    listeners,
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
    getAttribute: (k) => attrs.get(k) ?? null,
    hasAttribute: (k) => attrs.has(k),
    appendChild: (next) => {
      children.push(next);
      next.parent = el;
      return next;
    },
    removeChild: (target) => {
      const idx = children.indexOf(target);
      if (idx < 0) throw new Error('removeChild: not a child');
      children.splice(idx, 1);
      target.parent = null;
      return target;
    },
    get firstChild() {
      return children[0] ?? null;
    },
    remove: () => {
      if (el.parent) el.parent.removeChild(el);
    },
    addEventListener: (name, fn) => {
      const arr = listeners.get(name) ?? [];
      arr.push(fn);
      listeners.set(name, arr);
    },
    removeEventListener: (name, fn) => {
      const arr = listeners.get(name);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    click: () => {
      for (const fn of listeners.get('click') ?? []) fn({ target: el });
    },
  };
  return el;
};

const makeFakeDocument = (): { createElement(tag: string): FakeElement } => ({
  createElement: (tag) => makeFakeElement(tag),
});

const findByAttr = (root: FakeElement, attr: string): FakeElement | null => {
  if (root.hasAttribute(attr)) return root;
  for (const c of root.children) {
    const hit = findByAttr(c, attr);
    if (hit) return hit;
  }
  return null;
};

const findAllByAttr = (root: FakeElement, attr: string): FakeElement[] => {
  const out: FakeElement[] = [];
  const walk = (n: FakeElement): void => {
    if (n.hasAttribute(attr)) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
};

// ──────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────

const manifest: BulkPackManifest = {
  manifest_version: 1,
  slug: 'fleet-money',
  publisher: 'recued-core',
  name: 'Fleet Money',
  description: 'A pack for testing.',
  version: 1,
  recipes: [{ slug: 'refund-payment-square', version: 1 }],
  requires: ['install_bulk_pack'],
  tags: ['test'],
};

const entry: PackListEntry = {
  slug: manifest.slug,
  publisher: manifest.publisher,
  name: manifest.name,
  description: manifest.description,
  version: manifest.version,
  pre_install: false,
  installed: false,
  requires: [...manifest.requires],
  recipe_count: manifest.recipes.length,
  recipe_refs: manifest.recipes.map((r) => ({ slug: r.slug, version: r.version })),
  body_visibility_grant_keys: [],
  body_visibility_grant_count: 0,
  manifest,
};

const preview: InstallPreview = {
  resolved: true,
  will_enable: [
    {
      publisher_id: 'recued-core',
      recipe_id: 'refund-payment-square',
      name: 'Refund Square payment',
      grant_class: 'open_adapter',
      top_risk: 'destructive',
      operation_ids: ['refund_payment'],
    },
  ],
  hidden_count: 0,
};

interface Harness {
  host: FakeElement;
  mount: ReturnType<typeof mountPacksPanel>;
  calls: unknown[];
}

const setup = (
  runInstallPreview: PacksInstallPreviewCaller | undefined,
): Harness => {
  const host = makeFakeElement('div');
  const doc = makeFakeDocument();
  const calls: unknown[] = [];
  const runList: PacksListCaller = async () => ({ packs: [entry] });
  const wrapped: PacksInstallPreviewCaller | undefined =
    runInstallPreview === undefined
      ? undefined
      : (args) => {
          calls.push(args);
          return runInstallPreview(args);
        };
  const mount = mountPacksPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runList,
    initialSlug: entry.slug,
    runInstall: async () => ({ result: { ok: true } as never }),
    ...(wrapped !== undefined ? { runInstallPreview: wrapped } : {}),
  });
  return { host, mount, calls };
};

/** Open the install dialog and let the panel's async work settle. */
const openDialog = async (h: Harness): Promise<void> => {
  await h.mount.whenLoaded();
  h.mount.clickInstall(entry.slug);
  // The preview fires from the dialog's render, so drain the microtask queue
  // the panel's own `render()` re-entry rides on.
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

// ──────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────

describe('D-247 D15 — the preview seam is actually called', () => {
  it('⛔ opening the install dialog calls `packs.install_preview` with the manifest', async () => {
    const h = setup(async () => preview);
    await openDialog(h);
    expect(h.mount.getDialogOpenFor()).toBe(entry.slug);
    // The assertion the missing wiring failed: the caller ran at all.
    expect(h.calls).toHaveLength(1);
    expect((h.calls[0] as { manifest: unknown }).manifest).toBe(manifest);
  });

  it('⛔⛔ the resolved preview reaches the DOM as the recipe disclosure', async () => {
    const h = setup(async () => preview);
    await openDialog(h);
    const dialog = findByAttr(h.host, PACKS_DIALOG_ATTR);
    expect(dialog).not.toBeNull();
    const disclosure = findByAttr(dialog!, INSTALL_RECIPE_DISCLOSURE_ATTR);
    // This is the end-to-end proof: server-shaped preview → panel → dialog DOM.
    expect(disclosure).not.toBeNull();
    expect(disclosure!.getAttribute('data-count')).toBe('1');
    const items = findAllByAttr(disclosure!, 'data-recipe');
    expect(items).toHaveLength(1);
    // D10's copy, rendered — the verb before the tier, and the "still asks"
    // clause that keeps ACCESS from reading as approval.
    expect(items[0]!.textContent).toContain('Refund Square payment');
    expect(items[0]!.textContent).toContain('destroy');
    expect(items[0]!.textContent).toContain('each call still asks');
  });

  it('fires ONCE per (slug, manifest) — not on every render', async () => {
    const h = setup(async () => preview);
    await openDialog(h);
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    expect(h.calls).toHaveLength(1);
  });

  it('a REJECTING server renders the pre-D-247 dialog, not an error', async () => {
    // This is the pre-26.8.18 server: it answers `packs.install_preview` with an
    // unknown-method rejection. The dialog must be unharmed.
    const h = setup(async () => {
      throw new Error('unknown method: packs.install_preview');
    });
    await openDialog(h);
    const dialog = findByAttr(h.host, PACKS_DIALOG_ATTR);
    expect(dialog).not.toBeNull();
    expect(findByAttr(dialog!, INSTALL_RECIPE_DISCLOSURE_ATTR)).toBeNull();
    // …and it does not retry forever against a server that will never answer.
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(h.calls).toHaveLength(1);
  });

  it('an UNRESOLVED preview renders nothing rather than a count it cannot verify', async () => {
    const h = setup(async () => ({ resolved: false, will_enable: [], hidden_count: 0 }));
    await openDialog(h);
    const dialog = findByAttr(h.host, PACKS_DIALOG_ATTR);
    expect(findByAttr(dialog!, INSTALL_RECIPE_DISCLOSURE_ATTR)).toBeNull();
  });

  it('no seam wired ⇒ the dialog still opens (an older host)', async () => {
    const h = setup(undefined);
    await openDialog(h);
    expect(h.mount.getDialogOpenFor()).toBe(entry.slug);
    expect(h.calls).toHaveLength(0);
    const dialog = findByAttr(h.host, PACKS_DIALOG_ATTR);
    expect(dialog).not.toBeNull();
    expect(findByAttr(dialog!, INSTALL_RECIPE_DISCLOSURE_ATTR)).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// The composition root
// ──────────────────────────────────────────────────────────────────

/** ⚠ Source-level, deliberately, and for the same reason as
 *  `run-modal-hosts-attach.test.ts`: the defect this closes was a MISSING
 *  forward in a composition root, and every layer below it passed its own tests
 *  without it. The panel tests above prove the panel consumes a seam it is
 *  GIVEN; only this proves the app gives it one. Three layers, so a prop added
 *  to one and forgotten in the next fails here. */
describe('D-247 D15 — the seam is wired end to end', () => {
  const SRC = resolve(import.meta.dirname, '..');
  const read = (rel: string): string => readFileSync(resolve(SRC, rel), 'utf-8');

  it('webclient-bootstrap builds the caller off the rpc', () => {
    const src = read('webclient-bootstrap.ts');
    expect(src).toContain("rpcConn.call('packs.install_preview', args)");
    // …and hands it to the packs route. A built-but-unpassed caller is exactly
    // the shape of the bug.
    expect(src).toMatch(/\{\s*packsInstallPreviewCaller\s*\}/);
  });

  it('the packs route forwards it into the panel', () => {
    const src = read('packs/bootstrap-packs-route.ts');
    expect(src).toContain('runInstallPreview: opts.packsInstallPreviewCaller');
  });

  it('the panel passes it to the dialog', () => {
    const src = read('settings/packs-panel.ts');
    // Word-boundary, not a bare substring: `toContain('ensureInstallPreview(')`
    // stays green against a mutation that renames the call `XensureInstallPreview(`.
    expect(src).toMatch(/\bensureInstallPreview\(pack\.slug, pack\.manifest\)/);
    expect(src).toMatch(/\binstallPreview !== undefined \? \{ installPreview \}/);
  });
});
