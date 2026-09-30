/** D-315 §5.2 — the pack install dialog lists the templates a pack's recipes
 *  bring: what each reads, and from which mail. Where one reads the same mail
 *  as a template the owner already has on, it asks which stays on — the
 *  recipe's by default — and the install carries the answer. It says that the
 *  recipe's trigger starts off.
 *
 *  Driven through `mountPacksPanel`, as the owner meets it: a test that handed
 *  the render its props could pass with the panel never passing them. */

import { describe, expect, it } from 'vitest';

import type { BulkPackManifest, MailTemplateInstallPreview, PackListEntry } from '@recued/contracts';

import {
  PACKS_DIALOG_ATTR,
  PACKS_DIALOG_INSTALL_BTN_ATTR,
  mountPacksPanel,
  type PacksInstallCaller,
  type PacksInstallPreviewCaller,
} from '../settings/packs-panel.js';
import {
  describeMailTemplateConditions,
  PACKS_DIALOG_FACT_SOURCES_ATTR,
  PACKS_DIALOG_MAIL_TEMPLATE_KEEP_ATTR,
  PACKS_DIALOG_MAIL_TEMPLATES_ATTR,
  type InstallPreview,
} from '../settings/packs-install-dialog.js';
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
  slug: 'shop-parcels',
  publisher: 'recued-core',
  name: 'Shop parcels',
  description: 'Parcels the shop sends.',
  version: 1,
  recipes: [{ slug: 'shop-parcels-watch', version: 1 }],
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

const starter = (over: Partial<MailTemplateInstallPreview> = {}): MailTemplateInstallPreview => ({
  recipe_id: 'shop-parcels-watch',
  recipe_name: 'Shop parcels watch',
  variable: 'template',
  name: 'Shop parcels',
  type: 'shipment',
  conditions: [{ field: 'from', op: 'is', value: 'ship@shop.example' }, { field: 'subject', op: 'contains', value: 'has shipped' }],
  reads: ['carrier', 'tracking_number', 'data.depot'],
  action: 'add',
  trigger: true,
  ...over,
});

const previewWith = (mail_templates: MailTemplateInstallPreview[], extra: Partial<InstallPreview> = {}): InstallPreview =>
  ({ resolved: true, will_enable: [], hidden_count: 0, missing_packs: [], mail_templates, ...extra });

interface Harness {
  host: FakeElement;
  mount: ReturnType<typeof mountPacksPanel>;
  installs: Array<Parameters<PacksInstallCaller>[0]>;
}

const setup = (preview: PacksInstallPreviewCaller): Harness => {
  const host = makeFakeElement('div');
  const installs: Array<Parameters<PacksInstallCaller>[0]> = [];
  const subscribe = (() => () => undefined) as unknown as BroadcastSubscriber['on'];
  const mount = mountPacksPanel({
    host: host as unknown as HTMLElement,
    document: makeFakeDocument() as unknown as Document,
    runList: async () => ({ packs: [entry] }),
    initialSlug: entry.slug,
    runInstall: async (args) => {
      installs.push(args);
      return { result: { ok: true, installed: [], rolled_back: [] } };
    },
    runInstallPreview: preview,
    subscribe,
  });
  return { host, mount, installs };
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

const install = async (h: Harness): Promise<void> => {
  findByAttr(findByAttr(h.host, PACKS_DIALOG_ATTR)!, PACKS_DIALOG_INSTALL_BTN_ATTR)!.click();
  await settle();
};

// ──────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────

describe('the templates a pack’s recipes bring (§5.2)', () => {
  it('lists each: what it reads, from which mail, and that the recipe’s trigger starts off', async () => {
    const h = setup(async () => previewWith([starter()]));
    const section = findByAttr(await openDialog(h), PACKS_DIALOG_MAIL_TEMPLATES_ATTR);
    expect(section).not.toBeNull();
    expect(text(section!)).toContain(
      'Adds “Shop parcels” for Shop parcels watch: reads carrier, tracking number, depot from mail from ship@shop.example, subject has “has shipped”.',
    );
    expect(text(section!)).toContain('A template’s AI starts off.');
    expect(text(section!)).toContain('Shop parcels watch starts on what this template reads. Its trigger stays off until you switch it on in Automation.');
    // Nothing to choose: no question, and none sent.
    expect(findAllByAttr(section!, PACKS_DIALOG_MAIL_TEMPLATE_KEEP_ATTR)).toEqual([]);
    await install(h);
    expect(h.installs).toHaveLength(1);
    expect(h.installs[0]).not.toHaveProperty('mail_template_choices');
  });

  it('asks which stays on where one already reads that mail — the recipe’s by default — and sends it', async () => {
    const h = setup(async () => previewWith([starter({ twin: { template_id: 'mtpl_mine', name: 'My shop' } })]));
    const section = findByAttr(await openDialog(h), PACKS_DIALOG_MAIL_TEMPLATES_ATTR)!;
    expect(text(section)).toContain('“My shop” already reads this mail. Only one can: which stays on?');
    const radios = findAllByAttr(section, PACKS_DIALOG_MAIL_TEMPLATE_KEEP_ATTR);
    expect(radios.map((radio) => [radio.getAttribute(PACKS_DIALOG_MAIL_TEMPLATE_KEEP_ATTR), radio.checked]))
      .toEqual([['recipe', true], ['existing', false]]);
    await install(h);
    expect(h.installs[0]?.mail_template_choices).toEqual([{ recipe_id: 'shop-parcels-watch', variable: 'template', keep: 'recipe' }]);
  });

  it('keeps the owner’s answer', async () => {
    const h = setup(async () => previewWith([starter({ twin: { template_id: 'mtpl_mine', name: 'My shop' } })]));
    const section = findByAttr(await openDialog(h), PACKS_DIALOG_MAIL_TEMPLATES_ATTR)!;
    const existing = findAllByAttr(section, PACKS_DIALOG_MAIL_TEMPLATE_KEEP_ATTR)
      .find((radio) => radio.getAttribute(PACKS_DIALOG_MAIL_TEMPLATE_KEEP_ATTR) === 'existing')!;
    for (const fn of existing.listeners.get('change') ?? []) fn({ target: existing });
    await settle();
    const again = findAllByAttr(findByAttr(h.host, PACKS_DIALOG_MAIL_TEMPLATES_ATTR)!, PACKS_DIALOG_MAIL_TEMPLATE_KEEP_ATTR);
    expect(again.map((radio) => radio.checked)).toEqual([false, true]);
    await install(h);
    expect(h.installs[0]?.mail_template_choices).toEqual([{ recipe_id: 'shop-parcels-watch', variable: 'template', keep: 'existing' }]);
  });

  it('says an update keeps the owner’s settings, and shows nothing when the recipes bring none', async () => {
    const h = setup(async () => previewWith([starter({ action: 'update', trigger: false })]));
    const section = findByAttr(await openDialog(h), PACKS_DIALOG_MAIL_TEMPLATES_ATTR)!;
    expect(text(section)).toContain('Updates “Shop parcels”');
    expect(text(section)).toContain('Its rules update; whether it is on, and its AI, stay as you set them.');
    expect(text(section)).not.toContain('Its trigger stays off');
    const none = setup(async () => previewWith([]));
    expect(findByAttr(await openDialog(none), PACKS_DIALOG_MAIL_TEMPLATES_ATTR)).toBeNull();
  });

  it('describes an entrance in words', () => {
    expect(describeMailTemplateConditions([
      { field: 'from', op: 'domain_is', value: '@amazon.com' },
      { field: 'subject', op: 'contains', value: 'Delivered', negate: true },
      { field: 'label', op: 'is', value: 'Receipts' },
    ])).toBe('from anyone at amazon.com, subject lacks “Delivered”, labelled Receipts');
  });
});

describe('where the facts a recipe starts on come from (§5.2)', () => {
  it('says what reads them here, and offers to make a template where nothing does', async () => {
    const h = setup(async () => previewWith([], {
      mail_fact_sources: [
        {
          recipe_id: 'parcel-alerts',
          recipe_name: 'Parcel alerts',
          kinds: [
            { type: 'shipment', name: 'Shipment', variables: ['tracking_number'], standards: true, templates: 2, brought: true },
            { type: 'lead', name: 'Lead', variables: [], standards: false, templates: 0, brought: false },
          ],
        },
      ],
    }));
    const section = findByAttr(await openDialog(h), PACKS_DIALOG_FACT_SOURCES_ATTR);
    expect(section).not.toBeNull();
    expect(text(section!)).toContain(
      'Parcel alerts starts on tracking number in shipment facts, which come from the markup shops and carriers put in their mail, and UPS, USPS, FedEx and DHL tracking numbers, read without a template; 2 templates of yours; the template this install adds.',
    );
    expect(text(section!)).toContain('Parcel alerts starts on any change in lead facts, and nothing reads those from your mail yet.');
    const make = findAllByAttr(section!, 'href').filter((link) => link.getAttribute('href') === '#data/mail_fact/templates/new');
    expect(make.map((link) => link.textContent)).toEqual(['Make one now']);
  });
});
