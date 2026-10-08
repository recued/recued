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
  PACKS_DIALOG_INSTALL_BTN_ATTR,
  mountPacksPanel,
  type PacksInstallPreviewCaller,
  type PacksListCaller,
} from '../settings/packs-panel.js';
import {
  INSTALL_RECIPE_DISCLOSURE_ATTR,
  PACKS_DIALOG_DEPENDENCIES_ATTR,
  PACKS_DIALOG_DEPENDENCY_ACCESS_ATTR,
  PACKS_DIALOG_DEPENDENCY_ATTR,
  PACKS_DIALOG_DEPENDENCY_NEEDS_ATTR,
  PACKS_DIALOG_PERMISSION_ATTR,
  PACKS_DIALOG_PERMISSION_NEEDED_BY_ATTR,
  PACKS_DIALOG_RECEPTION_OFF_ATTR,
  PACKS_DIALOG_SETTINGS_OFF_ATTR,
  PACKS_DIALOG_TRIGGER_OFF_ATTR,
  PACKS_DIALOG_WEBHOOK_OPTION_ATTR,
  PACKS_DIALOG_WEBHOOKS_ATTR,
  type InstallPreview,
} from '../settings/packs-install-dialog.js';
import {
  INSTALL_GRANT_ACCESS_OPTION_ATTR,
  INSTALL_GRANT_OWN_NEEDS_ATTR,
  INSTALL_GRANT_PICKER_ATTR,
} from '../settings/install-grant-picker.js';
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

  it('a recipe the preview does not list is closed: the dialog offers it at NO tier', async () => {
    // Live drive, 2026-10-07: a pack of trigger-driven recipes (none chat-exposed)
    // offered "Read only — Look at things only" with every recipe under it,
    // though the install writes them closed at any tier and three of them write.
    const h = setup(async () => ({ resolved: true, will_enable: [], hidden_count: 1 }));
    await openDialog(h);
    const dialog = findByAttr(h.host, PACKS_DIALOG_ATTR);
    expect(dialog).not.toBeNull();
    expect(findByAttr(dialog!, INSTALL_GRANT_PICKER_ATTR)).toBeNull();
    expect(h.mount.getDialogAccessTier()).toBeNull();
  });

  it('a listed recipe is offered at its own tier, and Read no longer claims it', async () => {
    const h = setup(async () => preview);
    await openDialog(h);
    const picker = findByAttr(findByAttr(h.host, PACKS_DIALOG_ATTR)!, INSTALL_GRANT_PICKER_ATTR);
    expect(picker).not.toBeNull();
    const textOf = (n: FakeElement): string =>
      [n.textContent ?? '', ...n.children.map(textOf)].join(' ');
    // Each tier is an `li.igp-access-row`: its radio carries the tier, its
    // caption what that tier adds.
    const rows: FakeElement[] = [];
    const walk = (n: FakeElement): void => {
      if (n.className === 'igp-access-row') rows.push(n);
      n.children.forEach(walk);
    };
    walk(picker!);
    const byTier = new Map(rows.map((row) => [
      findByAttr(row, INSTALL_GRANT_ACCESS_OPTION_ATTR)!.getAttribute('data-access'),
      textOf(row),
    ]));
    // `refund-payment-square` is destructive: Full access adds it, Read does not.
    expect([...byTier.keys()]).toEqual(['read', 'all']);
    expect(byTier.get('all')).toContain('Adds: recued-core/refund-payment-square');
    expect(byTier.get('read')).not.toContain('Adds:');
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
describe('the Access the dialog offers is the Access the install sends', () => {
  /** The dialog builds its Access choices WITH the preview's per-recipe risk; the
   *  panel validated the owner's pick, and resolved what the install sends,
   *  against a model built WITHOUT it — every recipe `read`. So a pack whose
   *  recipe destroys OFFERED "Full access", the click was dropped (the radio
   *  stayed checked, nothing re-rendered), and the install sent `read`: the
   *  owner's choice silently lost, the same shape as an update resetting Access. */
  it('⛔ a recipe that destroys offers Full access — and picking it SENDS Full access', async () => {
    const host = makeFakeElement('div');
    const installs: Array<{ install_scope?: { access?: string } }> = [];
    const mount = mountPacksPanel({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      runList: async () => ({ packs: [entry] }),
      initialSlug: entry.slug,
      runInstall: async (args) => {
        installs.push(args as never);
        return { result: { ok: true } as never };
      },
      runInstallPreview: async () => preview,
    });
    await openDialog({ host, mount, calls: [] });
    const offered = findAllByAttr(host, INSTALL_GRANT_ACCESS_OPTION_ATTR)
      .map((radio) => radio.getAttribute('data-access'));
    expect(offered, 'the dialog offers what the recipe needs').toContain('all');
    mount.clickAccessOption('all');
    expect(mount.getDialogAccessTier()).toBe('all');
    await mount.clickConfirmInstall();
    expect(installs[0]?.install_scope?.access).toBe('all');
  });
});

describe('D-295 — a webhook pack\'s dialog asks which webhook, and the install sends it', () => {
  /** The install requires one owner-chosen webhook per binding and refused every
   *  call without one; the dialog never asked, so a webhook pack could not be
   *  installed or updated from Settings → Packs at all. */
  const hookManifest = {
    ...manifest,
    slug: 'hook-pack',
    name: 'Hook pack',
    webhook_requirements: [{
      binding: 'deliveries',
      profile_ids: ['generic.static-header-token.v1'],
      required_event_types: ['delivery'],
      decoded_payload_access: 'metadata_only',
      source_truth_policy: 'delivery_payload_allowed',
    }],
  } as BulkPackManifest;
  const planEntry = (over: Record<string, unknown> = {}) => ({
    pack_slug: 'hook-pack',
    pack_name: 'Hook pack',
    binding: 'deliveries',
    vendor: 'generic',
    event_types: ['delivery'],
    candidates: [{ ingress_id: 'in-a', display_name: 'Alpha' }],
    ...over,
  });
  const mountWith = (
    plan: unknown[] | 'pending',
    entryOver: Partial<PackListEntry> = {},
  ) => {
    const host = makeFakeElement('div');
    const installs: Array<Record<string, unknown>> = [];
    const mount = mountPacksPanel({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      runList: async () => ({ packs: [{ ...entry, slug: 'hook-pack', name: 'Hook pack', manifest: hookManifest, ...entryOver }] }),
      initialSlug: 'hook-pack',
      runInstall: async (args) => {
        installs.push(args as Record<string, unknown>);
        return { result: { ok: true } as never };
      },
      runInstallPreview: plan === 'pending'
        ? () => new Promise<InstallPreview>(() => {})
        : async () => ({ resolved: true, will_enable: [], hidden_count: 0, webhook_plan: plan as never }),
    });
    return { host, mount, installs };
  };
  const open = async (h: { mount: ReturnType<typeof mountPacksPanel> }) => {
    await h.mount.whenLoaded();
    h.mount.clickInstall('hook-pack');
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  };
  const radios = (host: FakeElement) => findAllByAttr(host, PACKS_DIALOG_WEBHOOK_OPTION_ATTR);
  const installButton = (host: FakeElement) => findByAttr(host, PACKS_DIALOG_INSTALL_BTN_ATTR)!;
  const change = (el: FakeElement) => { for (const fn of el.listeners.get('change') ?? []) fn({ target: el }); };
  const text = (root: FakeElement): string => root.textContent + root.children.map(text).join('');

  it('⛔ the only webhook that fits is picked, shown, and SENT', async () => {
    const h = mountWith([planEntry()]);
    await open(h);
    expect(radios(h.host).map((radio) => [radio.getAttribute(PACKS_DIALOG_WEBHOOK_OPTION_ATTR), radio.checked]))
      .toEqual([['in-a', true]]);
    expect(installButton(h.host).disabled).toBe(false);
    await h.mount.clickConfirmInstall();
    expect(h.installs[0]?.webhook_bindings).toEqual([{ pack_slug: 'hook-pack', binding: 'deliveries', ingress_id: 'in-a' }]);
  });

  it('two fit: nothing is guessed, and Install waits until the owner chooses', async () => {
    const h = mountWith([planEntry({ candidates: [
      { ingress_id: 'in-a', display_name: 'Alpha' }, { ingress_id: 'in-b', display_name: 'Beta' },
    ] })]);
    await open(h);
    expect(radios(h.host).some((radio) => radio.checked)).toBe(false);
    expect(installButton(h.host).disabled).toBe(true);
    await h.mount.clickConfirmInstall();
    expect(h.installs).toHaveLength(0);
    // Even a click that reaches submit behind the button's back sends nothing.
    installButton(h.host).click();
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(h.installs).toHaveLength(0);
    change(radios(h.host).find((radio) => radio.getAttribute(PACKS_DIALOG_WEBHOOK_OPTION_ATTR) === 'in-b')!);
    expect(installButton(h.host).disabled).toBe(false);
    await h.mount.clickConfirmInstall();
    expect(h.installs[0]?.webhook_bindings).toEqual([{ pack_slug: 'hook-pack', binding: 'deliveries', ingress_id: 'in-b' }]);
  });

  it('an update starts at the webhook in use, and says so', async () => {
    const h = mountWith([planEntry({
      candidates: [{ ingress_id: 'in-a', display_name: 'Alpha' }, { ingress_id: 'in-b', display_name: 'Beta' }],
      current: { ingress_id: 'in-b', display_name: 'Beta', fits: true },
    })], { installed: false, installed_any_version: true });
    await open(h);
    const picked = radios(h.host).find((radio) => radio.checked);
    expect(picked?.getAttribute(PACKS_DIALOG_WEBHOOK_OPTION_ATTR)).toBe('in-b');
    expect(text(findByAttr(h.host, PACKS_DIALOG_WEBHOOKS_ATTR)!)).toContain('Beta — in use now');
  });

  it('none fits: it says where to set one up, and Install waits', async () => {
    const h = mountWith([planEntry({ candidates: [] })]);
    await open(h);
    const section = findByAttr(h.host, PACKS_DIALOG_WEBHOOKS_ATTR)!;
    expect(text(section)).toContain('Set one up in Connections → Webhooks');
    expect(installButton(h.host).disabled).toBe(true);
  });

  it('while the preview is out, Install waits for it instead of being refused', async () => {
    const h = mountWith('pending');
    await open(h);
    expect(text(findByAttr(h.host, PACKS_DIALOG_WEBHOOKS_ATTR)!)).toContain('Checking your webhooks');
    expect(installButton(h.host).disabled).toBe(true);
    await h.mount.clickConfirmInstall();
    expect(h.installs).toHaveLength(0);
  });
});

describe('D-296 — an update names each automation it switches off', () => {
  /** A changed trigger that cannot be carried lands switched off; the owner
   *  must hear it before pressing Update, not find the automation silent. */
  const switchedOff = [
    { recipe_id: 'nudge-mail', name: 'Nudge on mail', reason: 'changed' as const },
    { recipe_id: 'file-intake', name: 'File intake', reason: 'removed' as const },
  ];
  const mountWith = (entryOver: Partial<PackListEntry>) => {
    const host = makeFakeElement('div');
    const mount = mountPacksPanel({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      runList: async () => ({ packs: [{ ...entry, ...entryOver }] }),
      initialSlug: entry.slug,
      runInstall: async () => ({ result: { ok: true } as never }),
      runInstallPreview: async () => ({
        ...preview,
        triggers_switched_off: switchedOff,
        receptions_switched_off: [
          { endpoint_id: 'ep-contact', name: 'Get in touch', reason: 'params_changed' as const },
          { endpoint_id: 'ep-book', name: 'Book a call', reason: 'needs_owner' as const },
        ],
        settings_no_longer_used: [
          { recipe_id: 'import-bank-statement', recipe: 'Import a bank statement', setting: 'Thousands separator' },
          { recipe_id: 'nudge-mail', recipe: 'Nudge on mail', setting: 'Quiet hours' },
          { recipe_id: 'import-bank-statement', recipe: 'Import a bank statement', setting: 'Old currency' },
        ],
      }),
    });
    return { host, mount };
  };
  const text = (root: FakeElement): string => root.textContent + root.children.map(text).join('');

  it('⛔ one line per automation, saying what happens to it', async () => {
    const h = mountWith({ installed: false, installed_any_version: true });
    await openDialog({ ...h, calls: [] });
    const lines = findAllByAttr(h.host, PACKS_DIALOG_TRIGGER_OFF_ATTR);
    expect(lines.map((line) => [line.getAttribute(PACKS_DIALOG_TRIGGER_OFF_ATTR), line.getAttribute('role')]))
      .toEqual([['nudge-mail', 'alert'], ['file-intake', 'alert']]);
    expect(text(lines[0]!)).toBe('⚠ This update switches off “Nudge on mail”, which you have on: '
      + 'what starts it changes. Switch it back on in Automation after updating.');
    expect(text(lines[1]!)).toBe('⚠ This update switches off “File intake”, which you have on: '
      + 'it no longer starts by itself.');
  });

  it('a first install has nothing on to switch off, so it says nothing', async () => {
    const h = mountWith({ installed: false });
    await openDialog({ ...h, calls: [] });
    expect(findByAttr(h.host, PACKS_DIALOG_ATTR)).not.toBeNull();
    expect(findAllByAttr(h.host, PACKS_DIALOG_TRIGGER_OFF_ATTR)).toHaveLength(0);
    expect(findAllByAttr(h.host, PACKS_DIALOG_RECEPTION_OFF_ATTR)).toHaveLength(0);
    expect(findAllByAttr(h.host, PACKS_DIALOG_SETTINGS_OFF_ATTR)).toHaveLength(0);
  });

  it('⛔ D-303 — one line per recipe naming the saved settings the update stops using', async () => {
    const h = mountWith({ installed: false, installed_any_version: true });
    await openDialog({ ...h, calls: [] });
    const lines = findAllByAttr(h.host, PACKS_DIALOG_SETTINGS_OFF_ATTR);
    expect(lines.map((line) => [line.getAttribute(PACKS_DIALOG_SETTINGS_OFF_ATTR), line.getAttribute('role')]))
      .toEqual([['import-bank-statement', 'alert'], ['nudge-mail', 'alert']]);
    expect(text(lines[0]!)).toBe('⚠ This update drops settings you saved in “Import a bank statement”: '
      + '“Thousands separator”, “Old currency” no longer apply.');
    expect(text(lines[1]!)).toBe('⚠ This update drops a setting you saved in “Nudge on mail”: '
      + '“Quiet hours” no longer applies.');
  });

  it('⛔ D-299 — one line per Reception form or link the update stops, saying what to do', async () => {
    const h = mountWith({ installed: false, installed_any_version: true });
    await openDialog({ ...h, calls: [] });
    const lines = findAllByAttr(h.host, PACKS_DIALOG_RECEPTION_OFF_ATTR);
    expect(lines.map((line) => [line.getAttribute(PACKS_DIALOG_RECEPTION_OFF_ATTR), line.getAttribute('role')]))
      .toEqual([['ep-contact', 'alert'], ['ep-book', 'alert']]);
    expect(text(lines[0]!)).toBe('⚠ This update changes the answers “Get in touch” uses: it stops taking '
      + 'submissions until you re-enable it in Reception.');
    expect(text(lines[1]!)).toBe('⚠ This update needs your OK for “Book a call” to keep taking submissions: '
      + 'confirm it in Reception after updating.');
  });
});

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

// ══════════════════════════════════════════════════════════════════
// D-305 — the dialog asks for what the packs it brings in need
// ══════════════════════════════════════════════════════════════════

describe('D-305 — an install asks for what the packs it brings in need', () => {
  /** Found driving a live server: Personal CRM's dialog offered only its own
   *  permissions, its foundation needs `notification_send`, and the install was
   *  refused with nothing on screen able to grant it. */
  const crm: BulkPackManifest = {
    ...manifest,
    slug: 'personal-crm',
    name: 'Personal CRM',
    dependencies: [{ type: 'pack', slug: 'personal-crm-foundation', min_version: 1 }],
  };
  const crmEntry: PackListEntry = { ...entry, slug: crm.slug, name: crm.name, manifest: crm };
  const needs = [{ permission: 'notification_send', needed_by: ['Personal CRM Foundation'] }];
  const mountWith = (runInstallPreview: PacksInstallPreviewCaller) => {
    const host = makeFakeElement('div');
    const installs: Array<{ granted_permissions: readonly string[] }> = [];
    const mount = mountPacksPanel({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      runList: async () => ({ packs: [crmEntry] }),
      initialSlug: crmEntry.slug,
      runInstall: async (args) => { installs.push(args); return { result: { ok: true } as never }; },
      runInstallPreview,
    });
    return { host, mount, installs };
  };
  const drain = async (): Promise<void> => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

  it('⛔ the dependency\'s permission is offered, checked, naming the pack that needs it — and sent', async () => {
    const h = mountWith(async () => ({ ...preview, dependency_requires: needs }));
    await h.mount.whenLoaded();
    h.mount.clickInstall(crmEntry.slug);
    await drain();
    const box = findAllByAttr(h.host, PACKS_DIALOG_PERMISSION_ATTR)
      .find((el) => el.getAttribute(PACKS_DIALOG_PERMISSION_ATTR) === 'notification_send');
    expect(box?.checked).toBe(true);
    const note = findByAttr(h.host, PACKS_DIALOG_PERMISSION_NEEDED_BY_ATTR);
    expect(note?.textContent).toBe(' (needed by Personal CRM Foundation, which installs with it)');
    await h.mount.clickConfirmInstall();
    expect(h.installs).toHaveLength(1);
    expect(h.installs[0]!.granted_permissions).toContain('notification_send');
  });

  it('⛔ until the preview says, Install waits — the install would refuse', async () => {
    let answer!: (value: InstallPreview) => void;
    const h = mountWith(() => new Promise((resolve) => { answer = resolve; }));
    await h.mount.whenLoaded();
    h.mount.clickInstall(crmEntry.slug);
    await drain();
    const install = findByAttr(h.host, PACKS_DIALOG_INSTALL_BTN_ATTR)!;
    expect(install.disabled).toBe(true);
    expect(install.getAttribute('aria-describedby')).toBe('packs-dialog-permissions-checking');
    await h.mount.clickConfirmInstall();
    expect(h.installs).toHaveLength(0);
    // It lands after the dialog opened (the dialog is what asks): the permission
    // joins the selection then, checked.
    answer({ ...preview, dependency_requires: needs });
    await drain();
    expect(h.mount.getDialogPermissions().has('notification_send')).toBe(true);
    expect(findByAttr(h.host, PACKS_DIALOG_INSTALL_BTN_ATTR)!.disabled).toBe(false);
  });

  it('reopened with the preview already in hand, it starts checked again', async () => {
    const h = mountWith(async () => ({ ...preview, dependency_requires: needs }));
    await h.mount.whenLoaded();
    h.mount.clickInstall(crmEntry.slug);
    await drain();
    h.mount.togglePermission('notification_send');
    h.mount.clickCancelDialog();
    h.mount.clickInstall(crmEntry.slug);
    await drain();
    expect(h.mount.getDialogPermissions().has('notification_send')).toBe(true);
  });

  it('the owner can still untick it', async () => {
    const h = mountWith(async () => ({ ...preview, dependency_requires: needs }));
    await h.mount.whenLoaded();
    h.mount.clickInstall(crmEntry.slug);
    await drain();
    expect(h.mount.togglePermission('notification_send')).toBe(false);
    await h.mount.clickConfirmInstall();
    expect(h.installs[0]!.granted_permissions).not.toContain('notification_send');
  });
});

// ══════════════════════════════════════════════════════════════════
// D-310 — the dialog lists the packs it brings in, each with its own Access
// ══════════════════════════════════════════════════════════════════

describe('D-310 — an install asks what each pack it brings in may do', () => {
  /** Driven live: Month-end closer brought Ledger book in at its authored read
   *  defaults, and every booking was refused `operation_not_granted`. Nothing on
   *  screen said Ledger book came with it, let alone asked what it may do. */
  const closer: BulkPackManifest = {
    ...manifest,
    slug: 'month-end-closer',
    name: 'Month-end closer',
    dependencies: [
      { type: 'pack', slug: 'ledger-book', min_version: 2 },
      { type: 'pack', slug: 'statement-import', min_version: 1 },
    ],
  };
  const closerEntry: PackListEntry = { ...entry, slug: closer.slug, name: closer.name, manifest: closer };
  const ledger = {
    pack_slug: 'ledger-book',
    name: 'Ledger book',
    needed_by: ['Month-end closer'],
    access_options: ['read', 'write', 'all'] as const,
    needs: { access: 'write' as const, by: ['Month-end closer'] },
  };
  const statements = {
    pack_slug: 'statement-import',
    name: 'Bank statement import',
    needed_by: ['Month-end closer'],
    access_options: ['read', 'write', 'all'] as const,
  };
  const withPacks = (packs: unknown[]): InstallPreview =>
    ({ ...preview, dependency_packs: packs as never });
  const mountWith = (runInstallPreview: PacksInstallPreviewCaller) => {
    const host = makeFakeElement('div');
    const installs: Array<Record<string, unknown>> = [];
    const mount = mountPacksPanel({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      runList: async () => ({ packs: [closerEntry] }),
      initialSlug: closerEntry.slug,
      runInstall: async (args) => { installs.push(args as Record<string, unknown>); return { result: { ok: true } as never }; },
      runInstallPreview,
    });
    return { host, mount, installs };
  };
  const drain = async (): Promise<void> => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };
  const open = async (h: { mount: ReturnType<typeof mountPacksPanel> }): Promise<void> => {
    await h.mount.whenLoaded();
    h.mount.clickInstall(closerEntry.slug);
    await drain();
  };
  const text = (root: FakeElement): string => root.textContent + root.children.map(text).join('');
  const change = (el: FakeElement) => { for (const fn of el.listeners.get('change') ?? []) fn({ target: el }); };
  const row = (host: FakeElement, slug: string): FakeElement | undefined =>
    findAllByAttr(host, PACKS_DIALOG_DEPENDENCY_ATTR).find((el) => el.getAttribute(PACKS_DIALOG_DEPENDENCY_ATTR) === slug);
  const radios = (host: FakeElement, slug: string): FakeElement[] =>
    findAllByAttr(host, PACKS_DIALOG_DEPENDENCY_ACCESS_ATTR)
      .filter((el) => el.getAttribute(PACKS_DIALOG_DEPENDENCY_ACCESS_ATTR) === slug);
  const needsLine = (host: FakeElement, slug: string): string | undefined =>
    findAllByAttr(host, PACKS_DIALOG_DEPENDENCY_NEEDS_ATTR)
      .find((el) => el.getAttribute(PACKS_DIALOG_DEPENDENCY_NEEDS_ATTR) === slug)?.textContent;

  it('⛔ lists each pack it brings in, at Read only, and says Ledger book needs more', async () => {
    const h = mountWith(async () => withPacks([ledger, statements]));
    await open(h);
    const section = findByAttr(h.host, PACKS_DIALOG_DEPENDENCIES_ATTR)!;
    expect(text(section)).toContain('Also installs 2 Packs');
    expect(text(row(h.host, 'ledger-book')!)).toContain('Ledger book');
    expect(text(row(h.host, 'ledger-book')!)).toContain('Needed by Month-end closer.');
    expect(radios(h.host, 'ledger-book').map((r) => [r.getAttribute('data-access'), r.checked]))
      .toEqual([['read', true], ['write', false], ['all', false]]);
    expect(needsLine(h.host, 'ledger-book'))
      .toBe('Month-end closer adds and changes things in it. Choose Read + write, or those steps will be refused.');
    expect(needsLine(h.host, 'statement-import')).toBeUndefined();
  });

  it('⛔ what the owner picks for each is what the install sends, with the pack\'s own audience', async () => {
    const h = mountWith(async () => withPacks([ledger, statements]));
    await open(h);
    change(radios(h.host, 'ledger-book').find((r) => r.getAttribute('data-access') === 'write')!);
    expect(needsLine(h.host, 'ledger-book')).toBe('Month-end closer adds and changes things in it.');
    await h.mount.clickConfirmInstall();
    const audience = { owner: true, all_customers: false, all_other_contracts: false };
    expect(h.installs[0]?.dependency_install_scopes).toEqual([
      { pack_slug: 'ledger-book', install_scope: { access: 'write', audience } },
      { pack_slug: 'statement-import', install_scope: { access: 'read', audience } },
    ]);
  });

  it('who may use them follows the pack\'s own audience', async () => {
    const h = mountWith(async () => withPacks([ledger]));
    await open(h);
    h.mount.clickScopeOption('all_customers');
    await h.mount.clickConfirmInstall();
    const sent = h.installs[0]?.dependency_install_scopes as Array<{ install_scope: { audience: unknown } }>;
    expect(sent[0]?.install_scope.audience).toEqual(h.installs[0]?.install_scope
      && (h.installs[0].install_scope as { audience: unknown }).audience);
    expect((sent[0]?.install_scope.audience as { all_customers: boolean }).all_customers).toBe(true);
  });

  it('⛔ a server that predates D-310 lists none, so none is asked and none is sent', async () => {
    const h = mountWith(async () => preview);
    await open(h);
    expect(findByAttr(h.host, PACKS_DIALOG_DEPENDENCIES_ATTR)).toBeNull();
    await h.mount.clickConfirmInstall();
    expect(h.installs).toHaveLength(1);
    expect(h.installs[0]).not.toHaveProperty('dependency_install_scopes');
  });

  it('a pack the install only updates, or one with nothing to grant, is listed without a choice and not sent', async () => {
    const h = mountWith(async () => withPacks([
      { ...ledger, updates: true },
      { ...statements, access_options: [] },
    ]));
    await open(h);
    expect(text(row(h.host, 'ledger-book')!)).toContain('Installed already. This updates it for Month-end closer.');
    expect(radios(h.host, 'ledger-book')).toEqual([]);
    expect(text(row(h.host, 'statement-import')!)).toContain('Nothing to choose for it here.');
    h.mount.clickDependencyAccessOption('ledger-book', 'write');
    await h.mount.clickConfirmInstall();
    expect(h.installs[0]).not.toHaveProperty('dependency_install_scopes');
  });

  it('a tier the pack does not offer is not taken', async () => {
    const h = mountWith(async () => withPacks([{ ...statements, access_options: ['read', 'write'] }]));
    await open(h);
    h.mount.clickDependencyAccessOption('statement-import', 'all');
    expect(h.mount.getDialogDependencyScopes()?.[0]?.install_scope.access).toBe('read');
    h.mount.clickDependencyAccessOption('statement-import', 'write');
    expect(h.mount.getDialogDependencyScopes()?.[0]?.install_scope.access).toBe('write');
  });

  it('reopened, every pack starts at Read only again', async () => {
    const h = mountWith(async () => withPacks([ledger]));
    await open(h);
    h.mount.clickDependencyAccessOption('ledger-book', 'write');
    h.mount.clickCancelDialog();
    h.mount.clickInstall(closerEntry.slug);
    await drain();
    expect(h.mount.getDialogDependencyScopes()?.[0]?.install_scope.access).toBe('read');
  });

  // D-310 REV 2 — what a pack's OWN workflows need. D-310 left it to "its own
  // dialog", and no dialog said it: Seller Quote Request, brought in by Seller Quote
  // Payment Events, was listed at Read with no word, and its own opening and
  // pricing of requests were then refused.
  const quotes = {
    pack_slug: 'seller-quote-request',
    name: 'Seller Quote Request',
    needed_by: ['Month-end closer'],
    access_options: ['read', 'write', 'all'] as const,
    own_needs: 'write' as const,
  };

  it('⛔ REV 2 — a pack whose own workflows write says so, though nothing else in the install writes into it', async () => {
    const h = mountWith(async () => withPacks([quotes]));
    await open(h);
    expect(needsLine(h.host, 'seller-quote-request'))
      .toBe('Some of its own workflows add and change things. Choose Read + write, or those steps will be refused.');
    change(radios(h.host, 'seller-quote-request').find((r) => r.getAttribute('data-access') === 'write')!);
    expect(needsLine(h.host, 'seller-quote-request')).toBe('Some of its own workflows add and change things.');
  });

  it('REV 2 — both at once: names both, and asks for the higher of the two', async () => {
    const h = mountWith(async () => withPacks([{ ...ledger, own_needs: 'all' }]));
    await open(h);
    const both = 'Month-end closer adds and changes things in it. Some of its own workflows delete things or change settings.';
    expect(needsLine(h.host, 'ledger-book')).toBe(`${both} Choose Full access, or those steps will be refused.`);
    // Read + write covers the other pack's writes but not its own deletes.
    change(radios(h.host, 'ledger-book').find((r) => r.getAttribute('data-access') === 'write')!);
    expect(needsLine(h.host, 'ledger-book')).toBe(`${both} Choose Full access, or those steps will be refused.`);
    change(radios(h.host, 'ledger-book').find((r) => r.getAttribute('data-access') === 'all')!);
    expect(needsLine(h.host, 'ledger-book')).toBe(both);
  });

  const ownLine = (host: FakeElement): string | undefined => findByAttr(host, INSTALL_GRANT_OWN_NEEDS_ATTR)?.textContent;
  /** The Access choices' hints, in order (Read first). Scope's hints are
   *  `igp-scope-hint` and say "This is what we suggest." of "You", rightly. */
  const accessHints = (root: FakeElement): string[] => [
    ...(root.className === 'igp-access-hint' ? [root.textContent] : []),
    ...root.children.flatMap(accessHints),
  ];
  const readHint = (host: FakeElement): string | undefined =>
    accessHints(findByAttr(host, INSTALL_GRANT_PICKER_ATTR)!)[0];

  it('⛔ REV 2 — the pack\'s own picker says it too, and stops suggesting the tier that refuses them', async () => {
    const h = mountWith(async () => ({ ...preview, own_needs: 'all' }));
    await open(h);
    expect(ownLine(h.host))
      .toBe('Some of this Pack’s own workflows delete things or change settings. Choose Full access, or those steps will be refused.');
    expect(readHint(h.host)).toBe('Look at things only. Safe, and running it twice changes nothing.');
    h.mount.clickAccessOption('all');
    expect(ownLine(h.host)).toBe('Some of this Pack’s own workflows delete things or change settings.');
  });

  it('REV 2 — a server that predates it sends no `own_needs`: no note, and Read is still suggested', async () => {
    const h = mountWith(async () => preview);
    await open(h);
    expect(ownLine(h.host)).toBeUndefined();
    expect(readHint(h.host)).toBe('Look at things only. Safe, and running it twice changes nothing. This is what we suggest.');
  });
});

// ══════════════════════════════════════════════════════════════════
// D-311 — a pack resolved from the marketplace previews from the marketplace
// ══════════════════════════════════════════════════════════════════

describe('D-311 — a marketplace pack\'s preview resolves from the marketplace', () => {
  /** On a deployed server the Packs list is the marketplace catalog; a pack not
   *  in the roster is resolved (`packs.resolveBySlug`) and installs by slug. Its
   *  preview was sent the manifest alone, so the server looked its recipes and
   *  the packs it brings in up among the bundled packs — the foundation packs
   *  only there — and the dialog listed nothing it brings in. */
  const book: BulkPackManifest = {
    ...manifest,
    slug: 'invoice-book',
    name: 'Invoice Book',
    dependencies: [{ type: 'pack', slug: 'billable-hours', min_version: 1 }],
  };
  const hours = {
    pack_slug: 'billable-hours',
    name: 'Billable Hours',
    needed_by: ['Invoice Book'],
    access_options: ['read', 'write', 'all'] as const,
    needs: { access: 'all' as const, by: ['Invoice Book'] },
  };
  const mountMarketplace = () => {
    const host = makeFakeElement('div');
    const previews: Array<Record<string, unknown>> = [];
    const bySlug: Array<Record<string, unknown>> = [];
    const mount = mountPacksPanel({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      // The roster (a deployed server's) does not carry Invoice Book.
      runList: async () => ({ packs: [entry] }),
      initialSlug: 'invoice-book',
      onSelectSlug: () => undefined,
      runResolvePack: async () => ({ manifest: book }),
      runInstall: async () => ({ result: { ok: true } as never }),
      runInstallBySlug: async (args) => { bySlug.push(args as Record<string, unknown>); return { result: { ok: true } as never }; },
      runInstallPreview: async (args) => {
        previews.push(args as Record<string, unknown>);
        return { ...preview, dependency_packs: [hours] as never };
      },
    });
    return { host, mount, previews, bySlug };
  };
  const drain = async (): Promise<void> => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

  it('⛔ the preview asks for the marketplace, and the install sends each pack\'s Access', async () => {
    const h = mountMarketplace();
    await h.mount.whenLoaded();
    await drain();
    h.mount.clickInstall('invoice-book');
    await drain();
    expect(h.previews).toHaveLength(1);
    expect(h.previews[0]).toEqual({ manifest: book, marketplace: true });
    expect(findByAttr(h.host, PACKS_DIALOG_DEPENDENCY_ATTR)?.getAttribute(PACKS_DIALOG_DEPENDENCY_ATTR))
      .toBe('billable-hours');
    h.mount.clickDependencyAccessOption('billable-hours', 'all');
    await h.mount.clickConfirmInstall();
    expect(h.bySlug).toHaveLength(1);
    expect(h.bySlug[0]).toMatchObject({
      slug: 'invoice-book',
      dependency_install_scopes: [{ pack_slug: 'billable-hours', install_scope: { access: 'all' } }],
    });
  });

  it('a pack the roster carries previews as before, without the flag', async () => {
    const calls: unknown[] = [];
    const h = setup(async (args) => { calls.push(args); return preview; });
    await openDialog(h);
    expect(calls).toEqual([{ manifest }]);
  });
});
