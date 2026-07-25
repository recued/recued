/** D-145 PA10 follow-on Slice K — Settings → Packs panel post-success
 *  runnability disclosure notice (R2 build step 4, recipe-identity doc
 *  §1.6).
 *
 *  Drives `mountPacksPanel` through the same fake-DOM harness as the
 *  Slice A / Slice B tests (copied rather than imported — keeps test
 *  files self-contained, mirroring the SI panel split).
 *
 *  Test catalog:
 *    Install disclosure (4c.2)
 *      - successful install whose result carries born_blocked +
 *        born_degraded stages the notice (state + DOM: container slug,
 *        per-kind blocks in blocked-then-degraded order, per-recipe
 *        items with the shared "Add a provider for …" detail, heading
 *        anchors the pack name)
 *      - successful install with no born_* fields stages nothing
 *        (zero-noise on ordinary installs)
 *      - ok:false result carrying born_blocked stages nothing (gated
 *        on result.ok — success-path-only contract fields)
 *    Uninstall disclosure (4c.3)
 *      - successful uninstall whose result carries would_disable stages
 *        the notice (would-disable block; degraded-before item carries
 *        the "was already degraded." detail, runnable-before is bare)
 *    Lifecycle (DD#15)
 *      - notice survives a host-driven refresh
 *      - Dismiss clears state + DOM
 *      - a NEW submit kickoff clears the prior notice even when the
 *        new action fails (the notice describes the last COMPLETED
 *        action) */

import { describe, expect, it } from 'vitest';

import {
  PACKS_DISCLOSURE_ATTR,
  PACKS_DISCLOSURE_BLOCK_ATTR,
  PACKS_DISCLOSURE_DISMISS_BTN_ATTR,
  PACKS_DISCLOSURE_ITEM_ATTR,
  mountPacksPanel,
  type PacksInstallCaller,
  type PacksListCaller,
  type PacksUninstallCaller,
} from '../settings/packs-panel.js';
import type {
  BulkPackInstallResultLike,
  BulkPackManifest,
  BulkPackUninstallResultLike,
  DependencyResolution,
  PackListEntry,
  RecipeRunnabilityEntry,
  RunnabilityStatus,
} from '@recued/contracts';

// ──────────────────────────────────────────────────────────────────
// Fake DOM (mirrors Slice A / B test harness shape)
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
      const arr = listeners.get('click') ?? [];
      for (const fn of arr) fn({ target: el });
    },
  };
  return el;
};

interface FakeDocument {
  createElement(tag: string): FakeElement;
}

const makeFakeDocument = (): FakeDocument => ({
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

const findByAttrValue = (
  root: FakeElement,
  attr: string,
  value: string,
): FakeElement | null => {
  if (root.hasAttribute(attr) && root.getAttribute(attr) === value) return root;
  for (const c of root.children) {
    const hit = findByAttrValue(c, attr, value);
    if (hit) return hit;
  }
  return null;
};

// ──────────────────────────────────────────────────────────────────
// Builders
// ──────────────────────────────────────────────────────────────────

const baseManifest = (overrides: Partial<BulkPackManifest> = {}): BulkPackManifest => ({
  manifest_version: 1,
  slug: 'test-pack',
  publisher: 'recued-core',
  name: 'Test Pack',
  description: 'A pack for testing.',
  version: 1,
  recipes: [{ slug: 'recipe-a', version: 1 }],
  requires: ['install_bulk_pack'],
  tags: ['test'],
  ...overrides,
});

const baseEntry = (overrides: Partial<PackListEntry> = {}): PackListEntry => {
  const manifest = overrides.manifest ?? baseManifest();
  return {
    slug: manifest.slug,
    publisher: manifest.publisher,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    pre_install: manifest.pre_install === true,
    installed: false,
    requires: [...manifest.requires],
    recipe_count: manifest.recipes.length,
    body_visibility_grant_count:
      manifest.mcp_body_visibility_grants?.length ?? 0,
    manifest,
    ...overrides,
  };
};

const installedEntry = (overrides: Partial<PackListEntry> = {}): PackListEntry =>
  baseEntry({ installed: true, ...overrides });

const okInstallResult = (): BulkPackInstallResultLike => ({
  ok: true,
  installed: [
    {
      slug: 'recipe-a',
      publisher_id: 'recued-core',
      version: 1,
      fresh_install: true,
    },
  ],
  rolled_back: [],
});

const okUninstallResult = (): BulkPackUninstallResultLike => ({
  ok: true,
  removed: {
    recipes: ['recipe-a'],
    body_grants: [],
  },
});

const unsatisfiedDep = (
  overrides: Partial<DependencyResolution> = {},
): DependencyResolution => ({
  capability: 'deal',
  ops: ['search'],
  optional: false,
  satisfied: false,
  providers: [],
  unprovided_ops: ['search'],
  ...overrides,
});

const runnabilityEntry = (
  recipe_id: string,
  status: RunnabilityStatus,
  dependencies: DependencyResolution[] = [],
): RecipeRunnabilityEntry => ({ recipe_id, status, dependencies });

// ──────────────────────────────────────────────────────────────────
// Setup helper
// ──────────────────────────────────────────────────────────────────

interface SetupOptions {
  runList?: PacksListCaller;
  runInstall?: PacksInstallCaller;
  runUninstall?: PacksUninstallCaller;
  /** R22 list→detail — seed the DETAIL selection on mount. */
  initialSlug?: string;
}

const setupMount = (
  initialPacks: ReadonlyArray<PackListEntry>,
  overrides: SetupOptions = {},
) => {
  const host = makeFakeElement('div');
  const doc = makeFakeDocument();

  const runList: PacksListCaller =
    overrides.runList ?? (async () => ({ packs: initialPacks }));
  const defaultRunInstall: PacksInstallCaller = async () => ({
    result: okInstallResult(),
  });
  const defaultRunUninstall: PacksUninstallCaller = async () => ({
    result: okUninstallResult(),
  });

  // The panel is now the DETAIL (the browse list moved to the surface). Open the
  // first pack's detail by default so the shared-machinery seams (clickInstall /
  // clickDelete / getDisclosure / the disclosure notice) reach the same
  // affordances they used to on a list row. Tests drive a specific slug via
  // `overrides.initialSlug` / `mount.clickSelectPack`.
  const autoSlug = overrides.initialSlug ?? initialPacks[0]?.slug;
  const mount = mountPacksPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runList,
    ...(autoSlug !== undefined ? { initialSlug: autoSlug } : {}),
    runInstall: overrides.runInstall ?? defaultRunInstall,
    runUninstall: overrides.runUninstall ?? defaultRunUninstall,
  });

  return { host, mount };
};

/** Drive the full install flow on a non-installed row. */
const driveInstall = async (
  rig: ReturnType<typeof setupMount>,
  slug = 'test-pack',
): Promise<void> => {
  rig.mount.clickInstall(slug);
  await rig.mount.clickConfirmInstall();
};

/** Drive the full uninstall flow on an installed row. */
const driveUninstall = async (
  rig: ReturnType<typeof setupMount>,
  slug = 'test-pack',
): Promise<void> => {
  rig.mount.clickDelete(slug);
  await rig.mount.clickConfirmDelete();
};

// ══════════════════════════════════════════════════════════════════
// Install disclosure (4c.2)
// ══════════════════════════════════════════════════════════════════

describe('D-145 PA10 Slice K — install born-blocked / born-degraded notice', () => {
  const bornResult = (): BulkPackInstallResultLike => ({
    ...okInstallResult(),
    born_blocked: [
      runnabilityEntry('deal-watch', 'blocked', [unsatisfiedDep()]),
    ],
    born_degraded: [
      runnabilityEntry('contact-enrich', 'degraded', [
        unsatisfiedDep({
          capability: 'contact',
          ops: ['enrich'],
          optional: true,
          unprovided_ops: ['enrich'],
        }),
      ]),
    ],
  });

  it('stages + renders the notice after a successful install with born_* entries', async () => {
    const rig = setupMount([baseEntry()], {
      runInstall: async () => ({ result: bornResult() }),
    });
    await rig.mount.whenLoaded();
    await driveInstall(rig);

    const staged = rig.mount.getDisclosure();
    expect(staged).not.toBeNull();
    expect(staged!.action).toBe('installed');
    expect(staged!.pack_slug).toBe('test-pack');
    expect(staged!.pack_name).toBe('Test Pack');
    expect(staged!.blocks.map((b) => b.kind)).toEqual([
      'born-blocked',
      'born-degraded',
    ]);

    const notice = findByAttrValue(rig.host, PACKS_DISCLOSURE_ATTR, 'test-pack');
    expect(notice).not.toBeNull();
    // Heading anchors the pack once the dialog that produced it closed.
    expect(notice!.children[0]!.children[0]!.textContent).toBe(
      'Installed Test Pack.',
    );

    const blocked = findByAttrValue(
      rig.host,
      PACKS_DISCLOSURE_BLOCK_ATTR,
      'born-blocked',
    );
    expect(blocked).not.toBeNull();
    expect(blocked!.children[0]!.textContent).toBe(
      'This pack added 1 recipe that cannot run until a provider is connected:',
    );
    const blockedItem = findByAttrValue(
      blocked!,
      PACKS_DISCLOSURE_ITEM_ATTR,
      'deal-watch',
    );
    expect(blockedItem).not.toBeNull();
    expect(blockedItem!.textContent).toBe(
      'deal-watch — Add a provider for deal.search.',
    );

    const degraded = findByAttrValue(
      rig.host,
      PACKS_DISCLOSURE_BLOCK_ATTR,
      'born-degraded',
    );
    expect(degraded).not.toBeNull();
    expect(degraded!.children[0]!.textContent).toBe(
      '1 recipe will run with an optional capability skipped:',
    );
    const degradedItem = findByAttrValue(
      degraded!,
      PACKS_DISCLOSURE_ITEM_ATTR,
      'contact-enrich',
    );
    expect(degradedItem).not.toBeNull();
    expect(degradedItem!.textContent).toBe(
      'contact-enrich — Add a provider for contact.enrich (optional — those steps skip).',
    );
  });

  it('stages nothing on a successful install without born_* fields', async () => {
    const rig = setupMount([baseEntry()]);
    await rig.mount.whenLoaded();
    await driveInstall(rig);

    expect(rig.mount.getDisclosure()).toBeNull();
    expect(findByAttr(rig.host, PACKS_DISCLOSURE_ATTR)).toBeNull();
  });

  it('stages nothing on an ok:false result even when it carries born_blocked', async () => {
    const rig = setupMount([baseEntry()], {
      runInstall: async () => ({
        result: {
          ...bornResult(),
          ok: false,
          failure: { code: 'unexpected', message: 'boom' },
        },
      }),
    });
    await rig.mount.whenLoaded();
    await driveInstall(rig);

    expect(rig.mount.getDisclosure()).toBeNull();
    expect(findByAttr(rig.host, PACKS_DISCLOSURE_ATTR)).toBeNull();
    // The failure surfaced through the normal dialog error path.
    expect(rig.mount.getDialogError()).not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
// Uninstall disclosure (4c.3)
// ══════════════════════════════════════════════════════════════════

describe('D-145 PA10 Slice K — uninstall would-disable notice', () => {
  const wouldDisableResult = (): BulkPackUninstallResultLike => ({
    ...okUninstallResult(),
    would_disable: [
      { recipe_id: 'dependent-a', before: 'runnable', after: 'blocked' },
      { recipe_id: 'dependent-b', before: 'degraded', after: 'blocked' },
    ],
  });

  it('stages + renders the notice after a successful uninstall with would_disable', async () => {
    const rig = setupMount([installedEntry()], {
      runUninstall: async () => ({ result: wouldDisableResult() }),
    });
    await rig.mount.whenLoaded();
    await driveUninstall(rig);

    const staged = rig.mount.getDisclosure();
    expect(staged).not.toBeNull();
    expect(staged!.action).toBe('uninstalled');
    expect(staged!.blocks.map((b) => b.kind)).toEqual(['would-disable']);

    const notice = findByAttrValue(rig.host, PACKS_DISCLOSURE_ATTR, 'test-pack');
    expect(notice).not.toBeNull();
    expect(notice!.children[0]!.children[0]!.textContent).toBe(
      'Uninstalled Test Pack.',
    );

    const block = findByAttrValue(
      rig.host,
      PACKS_DISCLOSURE_BLOCK_ATTR,
      'would-disable',
    );
    expect(block).not.toBeNull();
    expect(block!.children[0]!.textContent).toBe(
      'This disabled 2 recipes that lost their last provider — they stay installed and recover when a provider is connected:',
    );
    const bare = findByAttrValue(
      block!,
      PACKS_DISCLOSURE_ITEM_ATTR,
      'dependent-a',
    );
    expect(bare).not.toBeNull();
    expect(bare!.textContent).toBe('dependent-a');
    const wasDegraded = findByAttrValue(
      block!,
      PACKS_DISCLOSURE_ITEM_ATTR,
      'dependent-b',
    );
    expect(wasDegraded).not.toBeNull();
    expect(wasDegraded!.textContent).toBe(
      'dependent-b — was already degraded.',
    );
  });

  it('stages nothing on a successful uninstall without would_disable', async () => {
    const rig = setupMount([installedEntry()]);
    await rig.mount.whenLoaded();
    await driveUninstall(rig);

    expect(rig.mount.getDisclosure()).toBeNull();
    expect(findByAttr(rig.host, PACKS_DISCLOSURE_ATTR)).toBeNull();
  });

  it('stages nothing on an ok:false uninstall even when it carries would_disable', async () => {
    const rig = setupMount([installedEntry()], {
      runUninstall: async () => ({
        result: {
          ok: false,
          removed: { recipes: [], standing_instructions: 0, body_grants: [] },
          would_disable: [
            { recipe_id: 'dependent-a', before: 'runnable', after: 'blocked' },
          ],
          failure: { code: 'unexpected', message: 'boom' },
        },
      }),
    });
    await rig.mount.whenLoaded();
    await driveUninstall(rig);

    expect(rig.mount.getDisclosure()).toBeNull();
    expect(findByAttr(rig.host, PACKS_DISCLOSURE_ATTR)).toBeNull();
    // The failure surfaced through the normal strip error path.
    expect(rig.mount.getDeleteError()).not.toBeNull();
  });

  it('stages BEFORE the refresh resolves and renders from the pre-submit pack identity', async () => {
    // Codex test-audit fold (MEDIUM) — pins two behaviors a completed-
    // flow assertion can't: the disclosure is staged before the post-
    // success refresh (not after it), and the notice carries the pack
    // identity captured at submit time even when the refreshed list no
    // longer contains the acted-on row.
    let listCalls = 0;
    let releaseRefresh:
      | ((value: { packs: ReadonlyArray<PackListEntry> }) => void)
      | null = null;
    const runList: PacksListCaller = () => {
      listCalls += 1;
      if (listCalls === 1) {
        return Promise.resolve({ packs: [installedEntry()] });
      }
      return new Promise((resolve) => {
        releaseRefresh = resolve;
      });
    };
    const rig = setupMount([], {
      // The DETAIL panel mounts the delete affordance only for the selected
      // pack; the first runList returns test-pack, so open it.
      initialSlug: 'test-pack',
      runList,
      runUninstall: async () => ({
        result: {
          ...okUninstallResult(),
          would_disable: [
            { recipe_id: 'dependent-a', before: 'runnable', after: 'blocked' },
          ],
        },
      }),
    });
    await rig.mount.whenLoaded();

    rig.mount.clickDelete('test-pack');
    const confirmed = rig.mount.clickConfirmDelete();
    // Let the uninstall rpc resolve; the post-success refresh stays held.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rig.mount.getState()).toBe('loading');
    expect(rig.mount.getDisclosure()).not.toBeNull(); // staged pre-refresh
    // The loading repaint does not paint the notice (DD#15 / DD#5).
    expect(findByAttr(rig.host, PACKS_DISCLOSURE_ATTR)).toBeNull();

    releaseRefresh!({
      packs: [
        baseEntry({
          slug: 'other-pack',
          manifest: baseManifest({ slug: 'other-pack', name: 'Other Pack' }),
        }),
      ],
    });
    await confirmed;

    // The refresh returned ONLY other-pack, so test-pack's detail can no longer
    // render. Open the surviving pack's detail: the notice still renders there
    // from the identity captured at SUBMIT time — decoupled from both the open
    // pack and the (now test-pack-less) roster.
    rig.mount.clickSelectPack('other-pack');

    const notice = findByAttrValue(rig.host, PACKS_DISCLOSURE_ATTR, 'test-pack');
    expect(notice).not.toBeNull();
    expect(notice!.children[0]!.children[0]!.textContent).toBe(
      'Uninstalled Test Pack.',
    );
  });
});

// ══════════════════════════════════════════════════════════════════
// Lifecycle (DD#15)
// ══════════════════════════════════════════════════════════════════

describe('D-145 PA10 Slice K — notice lifecycle (DD#15)', () => {
  const wouldDisableUninstall: PacksUninstallCaller = async () => ({
    result: {
      ...okUninstallResult(),
      would_disable: [
        { recipe_id: 'dependent-a', before: 'runnable', after: 'blocked' },
      ],
    },
  });

  it('survives a host-driven refresh', async () => {
    const rig = setupMount([installedEntry()], {
      runUninstall: wouldDisableUninstall,
    });
    await rig.mount.whenLoaded();
    await driveUninstall(rig);
    expect(rig.mount.getDisclosure()).not.toBeNull();

    rig.mount.refresh();
    await rig.mount.whenLoaded();

    expect(rig.mount.getDisclosure()).not.toBeNull();
    expect(findByAttr(rig.host, PACKS_DISCLOSURE_ATTR)).not.toBeNull();
  });

  it('Dismiss clears the staged notice + DOM', async () => {
    const rig = setupMount([installedEntry()], {
      runUninstall: wouldDisableUninstall,
    });
    await rig.mount.whenLoaded();
    await driveUninstall(rig);
    expect(findByAttr(rig.host, PACKS_DISCLOSURE_DISMISS_BTN_ATTR)).not.toBeNull();

    rig.mount.clickDismissDisclosure();

    expect(rig.mount.getDisclosure()).toBeNull();
    expect(findByAttr(rig.host, PACKS_DISCLOSURE_ATTR)).toBeNull();
  });

  it('a new submit kickoff clears the prior notice even when the new action fails', async () => {
    let installCalls = 0;
    const rig = setupMount(
      [
        installedEntry(),
        baseEntry({
          slug: 'other-pack',
          manifest: baseManifest({ slug: 'other-pack', name: 'Other Pack' }),
        }),
      ],
      {
        runUninstall: wouldDisableUninstall,
        runInstall: async () => {
          installCalls += 1;
          return {
            result: {
              ok: false,
              installed: [],
              rolled_back: [],
              failure: { code: 'unexpected', message: 'boom' },
            },
          };
        },
      },
    );
    await rig.mount.whenLoaded();
    await driveUninstall(rig);
    expect(rig.mount.getDisclosure()).not.toBeNull();

    // The install affordance lives in the target pack's DETAIL — open other-pack
    // before driving its install. Selecting a pack never clears the notice.
    rig.mount.clickSelectPack('other-pack');
    await driveInstall(rig, 'other-pack');

    expect(installCalls).toBe(1);
    expect(rig.mount.getDisclosure()).toBeNull();
    expect(findByAttr(rig.host, PACKS_DISCLOSURE_ATTR)).toBeNull();
  });

  it('clears the prior notice at submit KICKOFF, before the new rpc resolves', async () => {
    // Codex test-audit fold (MEDIUM) — a mutant that clears the notice
    // late (in the failure branch) instead of at kickoff must fail:
    // assert the clear while the second action's rpc is still in flight.
    let releaseInstall:
      | ((value: { result: BulkPackInstallResultLike }) => void)
      | null = null;
    const rig = setupMount(
      [
        installedEntry(),
        baseEntry({
          slug: 'other-pack',
          manifest: baseManifest({ slug: 'other-pack', name: 'Other Pack' }),
        }),
      ],
      {
        runUninstall: wouldDisableUninstall,
        runInstall: () =>
          new Promise((resolve) => {
            releaseInstall = resolve;
          }),
      },
    );
    await rig.mount.whenLoaded();
    await driveUninstall(rig);
    expect(rig.mount.getDisclosure()).not.toBeNull();

    // Open other-pack's DETAIL so its install affordance mounts (selecting a
    // pack never clears the staged notice — only a submit KICKOFF does).
    rig.mount.clickSelectPack('other-pack');
    rig.mount.clickInstall('other-pack');
    const confirmed = rig.mount.clickConfirmInstall();
    // The submit's synchronous kickoff section already ran.
    expect(rig.mount.isInstalling()).toBe(true);
    expect(rig.mount.getDisclosure()).toBeNull();
    expect(findByAttr(rig.host, PACKS_DISCLOSURE_ATTR)).toBeNull();

    releaseInstall!({
      result: {
        ok: false,
        installed: [],
        rolled_back: [],
        failure: { code: 'unexpected', message: 'boom' },
      },
    });
    await confirmed;
    expect(rig.mount.getDisclosure()).toBeNull();
  });

  it('getDisclosure returns a defensive copy', async () => {
    // Codex test-audit fold (LOW) — a live-reference regression must
    // fail: mutating the returned object cannot affect the staged state.
    const rig = setupMount([installedEntry()], {
      runUninstall: wouldDisableUninstall,
    });
    await rig.mount.whenLoaded();
    await driveUninstall(rig);

    const first = rig.mount.getDisclosure()!;
    (first.blocks[0]!.items[0]! as { detail: string }).detail = 'mutated';
    (first.blocks as unknown as { length: number }).length = 0;

    const second = rig.mount.getDisclosure()!;
    expect(second.blocks).toHaveLength(1);
    expect(second.blocks[0]!.items[0]!.detail).toBe('');
  });
});
