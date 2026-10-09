/** The install dialog offers the packs an install needs and does not bring in.
 *
 *  A pack whose recipes call another pack's operations, and which does not bring
 *  that pack in, was refused only after the owner had made every choice: "step
 *  'x' uses the recued-core.federated-projects pack, which is not installed.
 *  Install that pack, then try again." The dialog named it and offered nothing.
 *
 *  Now the preview names such packs (`missing_packs`), and the dialog says so
 *  before the owner chooses anything, with a "Get <pack>" link to each pack's
 *  own page, and holds Install. A refusal the preview did not foresee carries
 *  them too (`failure.missing_packs`), and the dialog offers them under it.
 *
 *  Driven through `mountPacksPanel`, as the owner meets it: a test that handed
 *  the render its props could pass with the panel never passing them. */

import { describe, expect, it } from 'vitest';

import type { BulkPackManifest, PackListEntry } from '@recued/contracts';

import {
  PACKS_DIALOG_ATTR,
  PACKS_DIALOG_ERROR_ATTR,
  PACKS_DIALOG_INSTALL_BTN_ATTR,
  PACKS_DIALOG_MISSING_PACKS_ATTR,
  mountPacksPanel,
  type PacksInstallCaller,
  type PacksInstallPreviewCaller,
} from '../settings/packs-panel.js';
import {
  PACKS_DIALOG_INSTALL_REFUSAL_ATTR,
  installRefusalFromPreview,
  missingPacksFromFailure,
  missingPacksText,
  missingPacksToInstallFirst,
  type InstallPreview,
} from '../settings/packs-install-dialog.js';
import { PACK_INSTALL_OFFER_REF_ATTR } from '../shell/pack-install-offer.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';

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

const findById = (root: FakeElement, id: string): FakeElement | null => {
  if (root.id === id) return root;
  for (const c of root.children) {
    const hit = findById(c, id);
    if (hit) return hit;
  }
  return null;
};

const text = (root: FakeElement): string => root.textContent + root.children.map(text).join('');

// ──────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────

const manifest: BulkPackManifest = {
  manifest_version: 1,
  slug: 'meeting-outcomes-notes',
  publisher: 'recued-core',
  name: 'Meeting Outcomes - Typed Notes',
  description: 'A pack for testing.',
  version: 1,
  recipes: [{ slug: 'reconcile-meeting-outcomes-notes', version: 1 }],
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

const NEEDS_PROJECTS: InstallPreview = {
  resolved: true,
  will_enable: [],
  hidden_count: 0,
  missing_packs: [{ pack_ref: 'recued-core.federated-projects', needed_by: [manifest.name] }],
};

const NOTHING_MISSING: InstallPreview = { resolved: true, will_enable: [], hidden_count: 0, missing_packs: [] };

const REFUSAL_MESSAGE = "packs.install: recipe 'reconcile-meeting-outcomes-notes': step 'project' uses the "
  + 'recued-core.federated-projects pack, which is not installed. Install that pack, then try again.';

interface Harness {
  host: FakeElement;
  mount: ReturnType<typeof mountPacksPanel>;
  installs: unknown[];
  previews: unknown[];
  fire(kind: string): void;
}

const setup = (opts: {
  preview?: PacksInstallPreviewCaller;
  install?: PacksInstallCaller;
} = {}): Harness => {
  const host = makeFakeElement('div');
  const installs: unknown[] = [];
  const previews: unknown[] = [];
  const handlers = new Map<string, Array<(event: unknown) => void>>();
  const subscribe = ((kind: string, handler: (event: unknown) => void) => {
    const list = handlers.get(kind) ?? [];
    list.push(handler);
    handlers.set(kind, list);
    return () => undefined;
  }) as unknown as BroadcastSubscriber['on'];
  const mount = mountPacksPanel({
    host: host as unknown as HTMLElement,
    document: makeFakeDocument() as unknown as Document,
    runList: async () => ({ packs: [entry] }),
    initialSlug: entry.slug,
    runInstall: async (args) => {
      installs.push(args);
      return opts.install !== undefined ? opts.install(args) : { result: { ok: true } as never };
    },
    ...(opts.preview !== undefined
      ? {
          runInstallPreview: (args) => {
            previews.push(args);
            return opts.preview!(args);
          },
        }
      : {}),
    subscribe,
  });
  return {
    host,
    mount,
    installs,
    previews,
    fire: (kind) => {
      for (const handler of handlers.get(kind) ?? []) handler({ kind, cursor: 1 });
    },
  };
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

const openDialog = async (h: Harness): Promise<FakeElement> => {
  await h.mount.whenLoaded();
  h.mount.clickInstall(entry.slug);
  await settle();
  const dialog = findByAttr(h.host, PACKS_DIALOG_ATTR);
  expect(dialog).not.toBeNull();
  return dialog!;
};

const dialogOf = (h: Harness): FakeElement => findByAttr(h.host, PACKS_DIALOG_ATTR)!;
const installButton = (h: Harness): FakeElement => findByAttr(dialogOf(h), PACKS_DIALOG_INSTALL_BTN_ATTR)!;

// ──────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────

describe('the dialog says which packs to install first, before the owner chooses anything', () => {
  it('⛔ names the pack, links to its page, and holds Install', async () => {
    const h = setup({ preview: async () => NEEDS_PROJECTS });
    const dialog = await openDialog(h);
    const offer = findByAttr(dialog, PACKS_DIALOG_MISSING_PACKS_ATTR);
    expect(offer?.getAttribute(PACKS_DIALOG_MISSING_PACKS_ATTR)).toBe('preview');
    expect(text(offer!)).toContain(
      'This Pack needs federated-projects. It is not installed, and this Pack does not bring it in. '
      + 'Install it first, then come back to install this one.',
    );
    const links = findAllByAttr(offer!, PACK_INSTALL_OFFER_REF_ATTR);
    expect(links.map((link) => [
      link.tagName, link.getAttribute(PACK_INSTALL_OFFER_REF_ATTR), link.getAttribute('href'), link.textContent,
    ])).toEqual([['A', 'recued-core.federated-projects', '#packs/federated-projects', 'Get federated-projects']]);
    // Held, and pointing at why.
    const button = installButton(h);
    expect(button.disabled).toBe(true);
    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(text(findById(dialog, describedBy!)!)).toContain('This Pack needs federated-projects.');
  });

  it('⛔ the hold is the panel\'s too: a click that reaches the held button sends nothing', async () => {
    const h = setup({ preview: async () => NEEDS_PROJECTS });
    await openDialog(h);
    // `clickConfirmInstall` stops at a disabled button, as a browser does; this
    // fake does not, so a click here reaches the panel's own submit.
    const button = installButton(h);
    expect(button.disabled).toBe(true);
    button.click();
    await settle();
    expect(h.installs).toEqual([]);
    expect(h.mount.getDialogOpenFor()).toBe(entry.slug);
  });

  it('⛔ names a pack by what it is called where the server could tell, and links to its slug\'s page', async () => {
    const h = setup({
      preview: async () => ({
        ...NOTHING_MISSING,
        missing_packs: [{ pack_ref: 'recued-core.federated-projects', needed_by: [manifest.name], name: 'Federated Projects' }],
      }),
    });
    const dialog = await openDialog(h);
    const offer = findByAttr(dialog, PACKS_DIALOG_MISSING_PACKS_ATTR)!;
    expect(text(offer)).toContain('This Pack needs Federated Projects. It is not installed');
    expect(findAllByAttr(offer, PACK_INSTALL_OFFER_REF_ATTR).map((link) => [link.getAttribute('href'), link.textContent]))
      .toEqual([['#packs/federated-projects', 'Get Federated Projects']]);
  });

  it('names each pack, and the pack it brings in that needs them', async () => {
    const h = setup({
      preview: async () => ({
        ...NOTHING_MISSING,
        missing_packs: [
          { pack_ref: 'recued-core.ledger-book', needed_by: ['Month-end closer'] },
          { pack_ref: 'recued-core.statement-import', needed_by: ['Month-end closer'] },
        ],
      }),
    });
    const dialog = await openDialog(h);
    const offer = findByAttr(dialog, PACKS_DIALOG_MISSING_PACKS_ATTR)!;
    expect(text(offer)).toContain(
      'Month-end closer, which this Pack brings in, needs ledger-book and statement-import. They are not '
      + 'installed, and this Pack does not bring them in. Install them first, then come back to install this one.',
    );
    expect(findAllByAttr(offer, PACK_INSTALL_OFFER_REF_ATTR).map((link) => link.getAttribute('href')))
      .toEqual(['#packs/ledger-book', '#packs/statement-import']);
  });

  it('nothing missing, or an older server that cannot say: no offer, and Install as before', async () => {
    for (const preview of [NOTHING_MISSING, { resolved: true, will_enable: [], hidden_count: 0 }]) {
      const h = setup({ preview: async () => preview });
      const dialog = await openDialog(h);
      expect(findByAttr(dialog, PACKS_DIALOG_MISSING_PACKS_ATTR)).toBeNull();
      expect(installButton(h).disabled).toBe(false);
      await h.mount.clickConfirmInstall();
      expect(h.installs).toHaveLength(1);
    }
  });

  it('⛔ once a pack installs, the dialog asks again, and an answer naming nothing releases Install', async () => {
    // Federated Projects installed in another tab while this dialog was open.
    let answer: InstallPreview = NEEDS_PROJECTS;
    const h = setup({ preview: async () => answer });
    await openDialog(h);
    expect(installButton(h).disabled).toBe(true);
    answer = NOTHING_MISSING;
    h.fire('pack_installed');
    await settle();
    expect(h.previews).toHaveLength(2);
    expect(findByAttr(dialogOf(h), PACKS_DIALOG_MISSING_PACKS_ATTR)).toBeNull();
    expect(installButton(h).disabled).toBe(false);
  });

  it('a preview that named nothing is not asked again on every install elsewhere', async () => {
    const h = setup({ preview: async () => NOTHING_MISSING });
    await openDialog(h);
    h.fire('pack_installed');
    await settle();
    expect(h.previews).toHaveLength(1);
  });
});

describe('a refusal the preview did not foresee offers them under it', () => {
  const refusedWith = (missing: unknown): PacksInstallCaller => async () => ({
    result: {
      ok: false,
      installed: [],
      rolled_back: [],
      failure: { code: 'validator_rejected', message: REFUSAL_MESSAGE, missing_packs: missing },
    } as never,
  });

  it('⛔ from an older dialog path with no preview: the error, then "Get federated-projects"', async () => {
    const h = setup({ install: refusedWith(['recued-core.federated-projects']) });
    const dialog = await openDialog(h);
    await h.mount.clickConfirmInstall();
    await settle();
    expect(text(findByAttr(dialogOf(h), PACKS_DIALOG_ERROR_ATTR)!)).toContain('which is not installed');
    const offer = findByAttr(dialogOf(h), PACKS_DIALOG_MISSING_PACKS_ATTR);
    expect(offer?.getAttribute(PACKS_DIALOG_MISSING_PACKS_ATTR)).toBe('refusal');
    expect(findAllByAttr(offer!, PACK_INSTALL_OFFER_REF_ATTR).map((link) => link.getAttribute('href')))
      .toEqual(['#packs/federated-projects']);
    expect(dialog).toBeDefined();
  });

  it('⛔ a refusal that carries no list is offered nothing: the message is never read for packs', async () => {
    const h = setup({ install: refusedWith(undefined) });
    await openDialog(h);
    await h.mount.clickConfirmInstall();
    await settle();
    expect(h.mount.getDialogError()).toContain('recued-core.federated-projects pack');
    expect(findByAttr(dialogOf(h), PACKS_DIALOG_MISSING_PACKS_ATTR)).toBeNull();
  });

  it('the offer goes with its error: the next failure, without a list, shows none', async () => {
    let refuse = true;
    const h = setup({
      install: async (args) => {
        if (refuse) return refusedWith(['recued-core.federated-projects'])(args);
        throw new Error('network down');
      },
    });
    await openDialog(h);
    await h.mount.clickConfirmInstall();
    await settle();
    expect(findByAttr(dialogOf(h), PACKS_DIALOG_MISSING_PACKS_ATTR)).not.toBeNull();
    refuse = false;
    await h.mount.clickConfirmInstall();
    await settle();
    expect(h.mount.getDialogError()).toBe('network down');
    expect(findByAttr(dialogOf(h), PACKS_DIALOG_MISSING_PACKS_ATTR)).toBeNull();
  });

  it('named at the top already ⇒ not offered twice', async () => {
    // The owner pressed Install before the preview landed; it then named the pack.
    let land: ((preview: InstallPreview) => void) | undefined;
    const h = setup({
      preview: () => new Promise<InstallPreview>((resolve) => { land = resolve; }),
      install: refusedWith(['recued-core.federated-projects']),
    });
    await openDialog(h);
    await h.mount.clickConfirmInstall();
    await settle();
    land!(NEEDS_PROJECTS);
    await settle();
    const offers = findAllByAttr(dialogOf(h), PACKS_DIALOG_MISSING_PACKS_ATTR);
    expect(offers.map((offer) => offer.getAttribute(PACKS_DIALOG_MISSING_PACKS_ATTR))).toEqual(['preview']);
  });
});

describe('the wire is read defensively', () => {
  it('drops a malformed entry rather than drawing it', () => {
    expect(missingPacksToInstallFirst({
      resolved: true,
      will_enable: [],
      hidden_count: 0,
      missing_packs: [
        { pack_ref: 'recued-core.federated-projects', needed_by: ['A', 7], name: 3 },
        { pack_ref: 42 },
        null,
        { pack_ref: 'recued-core.pdftotext', needed_by: [], name: ' PDFToText Pack ' },
      ] as never,
    })).toEqual([
      { pack_ref: 'recued-core.federated-projects', needed_by: ['A'] },
      { pack_ref: 'recued-core.pdftotext', needed_by: [], name: 'PDFToText Pack' },
    ]);
    expect(missingPacksToInstallFirst({ resolved: true, will_enable: [], hidden_count: 0, missing_packs: 'x' as never }))
      .toEqual([]);
    expect(missingPacksFromFailure({ missing_packs: ['recued-core.pdftotext', '', 3] })).toEqual(['recued-core.pdftotext']);
    expect(missingPacksFromFailure({ missing_packs: 'recued-core.pdftotext' })).toEqual([]);
    expect(missingPacksFromFailure(undefined)).toEqual([]);
  });

  it('an update says to come back and update', () => {
    expect(missingPacksText('Pack', [{ pack_ref: 'recued-core.pdftotext' }], true))
      .toBe('This Pack needs pdftotext. It is not installed, and this Pack does not bring it in. '
        + 'Install it first, then come back to update this one.');
  });

  it('this Pack and one it brings in, both', () => {
    expect(missingPacksText('Invoice Book', [
      { pack_ref: 'recued-core.pdftotext', needed_by: ['Invoice Book', 'Billable Hours'] },
    ])).toMatch(/^This Pack and Billable Hours need pdftotext\./);
  });
});

describe('D-311 § 5 — the dialog says what the install would refuse, before the owner chooses anything', () => {
  const NEEDS_NEWER_RECUED: InstallPreview = {
    ...NOTHING_MISSING,
    install_refusal: {
      code: 'version_mismatch',
      message: `packs.install: ${manifest.name} needs a newer version of Recued. This server does not have the `
        + '"future-agent-json" progress adapter, which Future Agent Pack uses. '
        + `Update Recued, then install ${manifest.name} again.`,
    },
  };

  it('⛔ says it needs a newer Recued, in the server\'s words, and holds Install', async () => {
    const h = setup({ preview: async () => NEEDS_NEWER_RECUED });
    const dialog = await openDialog(h);
    const notice = findByAttr(dialog, PACKS_DIALOG_INSTALL_REFUSAL_ATTR);
    expect(notice?.getAttribute(PACKS_DIALOG_INSTALL_REFUSAL_ATTR)).toBe('version_mismatch');
    expect(text(notice!)).toBe(
      `⚠ ${manifest.name} needs a newer version of Recued. This server does not have the "future-agent-json" `
        + `progress adapter, which Future Agent Pack uses. Update Recued, then install ${manifest.name} again.`,
    );
    const button = installButton(h);
    expect(button.disabled).toBe(true);
    expect(text(findById(dialog, button.getAttribute('aria-describedby')!)!)).toContain('needs a newer version of Recued');
  });

  it('⛔ the hold is the panel\'s too: a click that reaches the held button sends nothing', async () => {
    const h = setup({ preview: async () => NEEDS_NEWER_RECUED });
    await openDialog(h);
    installButton(h).click();
    await settle();
    expect(h.installs).toEqual([]);
    expect(h.mount.getDialogOpenFor()).toBe(entry.slug);
  });

  it('a pack it brings in that does not pass its checks is said with a lead, since its words are the validator\'s', async () => {
    const h = setup({
      preview: async () => ({
        ...NOTHING_MISSING,
        install_refusal: {
          code: 'validator_rejected',
          message: 'dependency pack "broken-agent-pack" does not pass its checks: packs.install: composition failed validation — x',
        },
      }),
    });
    const dialog = await openDialog(h);
    expect(text(findByAttr(dialog, PACKS_DIALOG_INSTALL_REFUSAL_ATTR)!)).toBe(
      '⚠ This Pack cannot be installed. dependency pack "broken-agent-pack" does not pass its checks: '
        + 'packs.install: composition failed validation — x',
    );
    expect(installButton(h).disabled).toBe(true);
  });

  it('a preview with no refusal — an older server\'s, or nothing to refuse — holds nothing', async () => {
    const h = setup({ preview: async () => NOTHING_MISSING });
    const dialog = await openDialog(h);
    expect(findByAttr(dialog, PACKS_DIALOG_INSTALL_REFUSAL_ATTR)).toBeNull();
    expect(installButton(h).disabled).toBe(false);
  });

  it('a malformed refusal is dropped rather than drawn', () => {
    const base = { resolved: true, will_enable: [], hidden_count: 0 };
    expect(installRefusalFromPreview({ ...base, install_refusal: { code: 7, message: 'x' } as never })).toBeNull();
    expect(installRefusalFromPreview({ ...base, install_refusal: { code: 'version_mismatch', message: '  ' } })).toBeNull();
    expect(installRefusalFromPreview({ ...base, install_refusal: 'x' as never })).toBeNull();
    expect(installRefusalFromPreview(undefined)).toBeNull();
  });
});
