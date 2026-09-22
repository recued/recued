/** D-187 §6 follow-on — top-level Packs route acceptance.
 *
 *  Packs graduated out of Settings into the `#packs` route
 *  (`packs/bootstrap-packs-route.ts`). This drives `bootstrapPacksRoute`
 *  through a fake Document — same fake-DOM pattern as the connections-route
 *  test (`d-174-p3-connections-route.test.ts`) — and asserts the route
 *  concerns only (chrome, section mounts, caller forwarding, unavailable
 *  empty-states, the install→cli-grant-dialog wrapper, dispose). Panel
 *  internals stay covered by the panel-unit tests
 *  (`d-145-*-packs-panel*`, `d-182-cli-grant-dialog`).
 *
 *  ── The retired roster-wide "Local tools" section (2026-07-27) ────────
 *  The route used to append a second section: every installed cli tool ×
 *  every contract. It rendered under `#packs/<slug>` too (the list↔detail
 *  toggle is internal to the surface), reading as that pack's local tools
 *  while showing the whole roster. Deleted — the by-pack ACCESS section and
 *  `#contracts` are the two pack-honest axes.
 *
 *  Its FOUR callers stayed. Each has a surviving consumer, so this file
 *  asserts them per-consumer rather than "some caller fired": the universe
 *  read gates supervised-daemon rows on binary-on-PATH, and the list/set pair
 *  + contracts list drive the ACCESS panel's cli op toggles. Dropping them to
 *  "disable local tools" silently makes those toggles inert. */

import { describe, expect, it, vi } from 'vitest';
import type {
  BulkPackInstallResultLike,
  BulkPackManifest,
  PackListEntry,
  ServerRecipeListEntry,
} from '@recued/contracts';

import {
  PACKS_ROUTE_HEADING_ATTR,
  PACKS_ROUTE_PACKS_SECTION_ATTR,
  PACKS_ROUTE_STYLES,
  PACKS_ROUTE_STYLES_MARKER,
  PACKS_ROUTE_UNAVAILABLE_ATTR,
  bootstrapPacksRoute,
  resolvePackInput,
} from '../packs/bootstrap-packs-route.js';
import type { PackAppExecuteCaller } from '../packs/pack-app-view.js';
import { PACKS_DETAIL_PIN_ATTR, PACKS_DETAIL_TAB_ATTR } from '../settings/packs-panel.js';
import {
  SETTINGS_ROUTE_SECTION_ATTR,
  bootstrapSettingsRoute,
} from '../settings/bootstrap-settings-route.js';
import type {
  GrantCatalogOperationsCaller,
  GrantCliReachabilityListCaller,
  GrantCliReachabilitySetCaller,
  GrantContractsCaller,
  GrantReadCaller,
} from '../contracts/contract-grants-panel.js';
import type { SupervisionReachabilityCaller } from '../settings/supervision-controls.js';
import { createInMemoryWebclientLocalStore } from '../storage/local-store.js';

// ── Fake DOM (mirrors d-174-p3-connections-route.test.ts) ───────────
interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  disabled: boolean;
  value: string;
  innerHTML: string;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(type: string, fn: (ev: unknown) => void): void;
  removeEventListener(type: string, fn: (ev: unknown) => void): void;
  contains(el: unknown): boolean;
  querySelector(sel: string): FakeEl | null;
  click(): void;
  remove(): void;
}

interface FakeDoc {
  styleElements: FakeEl[];
  head: {
    querySelector(sel: string): FakeEl | null;
    appendChild(el: FakeEl): FakeEl;
  };
  createElement(tag: string): FakeEl;
}

const makeFakeEl = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    type: '',
    disabled: false,
    value: '',
    innerHTML: '',
    attrs: new Map(),
    children: [],
    parent: null,
    listeners: new Map(),
    get firstChild() {
      return el.children[0] ?? null;
    },
    setAttribute(k, v) {
      el.attrs.set(k, v);
      if (k === 'disabled') el.disabled = true;
    },
    removeAttribute(k) {
      el.attrs.delete(k);
      if (k === 'disabled') el.disabled = false;
    },
    getAttribute(k) {
      return el.attrs.get(k) ?? null;
    },
    hasAttribute(k) {
      return el.attrs.has(k);
    },
    appendChild(c) {
      c.parent = el;
      el.children.push(c);
      return c;
    },
    removeChild(c) {
      const idx = el.children.indexOf(c);
      if (idx < 0) throw new Error('removeChild: not a child');
      el.children.splice(idx, 1);
      c.parent = null;
      return c;
    },
    addEventListener(type, fn) {
      const list = el.listeners.get(type) ?? [];
      list.push(fn);
      el.listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = el.listeners.get(type);
      if (list === undefined) return;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    },
    contains() {
      return true;
    },
    querySelector() {
      return null;
    },
    click() {
      if (el.disabled || el.attrs.has('disabled')) return;
      for (const fn of el.listeners.get('click') ?? []) fn({ target: el });
    },
    remove() {
      if (el.parent !== null) el.parent.removeChild(el);
    },
  };
  return el;
};

const makeFakeDocument = (): FakeDoc => {
  const styleElements: FakeEl[] = [];
  const matchSelector = (sel: string): { tag: string; attr: string } | null => {
    const m = sel.match(/^([\w-]+)\[([\w-]+)\]$/);
    return m === null ? null : { tag: m[1]!.toUpperCase(), attr: m[2]! };
  };
  return {
    styleElements,
    head: {
      querySelector(sel) {
        const parsed = matchSelector(sel);
        if (parsed === null) return null;
        return (
          styleElements.find(
            (s) => s.tagName === parsed.tag && s.attrs.has(parsed.attr),
          ) ?? null
        );
      },
      appendChild(el) {
        styleElements.push(el);
        return el;
      },
    },
    createElement: (tag) => makeFakeEl(tag),
  };
};

const collectByAttr = (
  root: FakeEl,
  attr: string,
  out: FakeEl[] = [],
): FakeEl[] => {
  if (root.attrs.has(attr)) out.push(root);
  for (const child of root.children) collectByAttr(child, attr, out);
  return out;
};

/** Collect by tagName — a STRUCTURAL count that cannot rot the way a
 *  hard-coded `data-*` literal can (a typo'd attr literal is silently green
 *  forever). Used to assert the route hosts exactly ONE section. */
const collectByTag = (root: FakeEl, tag: string, out: FakeEl[] = []): FakeEl[] => {
  // The fake `createElement` upper-cases, matching the real DOM's `tagName`.
  if (root.tagName === tag.toUpperCase()) out.push(root);
  for (const child of root.children) collectByTag(child, tag, out);
  return out;
};

const collectText = (root: FakeEl): string =>
  `${root.textContent}${root.children.map(collectText).join('')}`;

/** First element carrying `attr` at all, whatever its value. */
const findByAttr = (root: FakeEl, attr: string): FakeEl | null => {
  if (root.getAttribute(attr) !== null) return root;
  for (const child of root.children) {
    const hit = findByAttr(child, attr);
    if (hit !== null) return hit;
  }
  return null;
};

const findByAttrValue = (
  root: FakeEl,
  attr: string,
  value: string,
): FakeEl | null => {
  if (root.getAttribute(attr) === value) return root;
  for (const child of root.children) {
    const hit = findByAttrValue(child, attr, value);
    if (hit !== null) return hit;
  }
  return null;
};

const tick = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

// ── Fixtures (mirror d-145-pa10-packs-panel.test.ts) ────────────────
const baseManifest = (
  overrides: Partial<BulkPackManifest> = {},
): BulkPackManifest => ({
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
    recipe_refs: manifest.recipes.map((r) => ({ slug: r.slug, version: r.version })),
    body_visibility_grant_keys: [...(manifest.mcp_body_visibility_grants ?? [])],
    ...(typeof manifest.service_kind === 'string' ? { service_kind: manifest.service_kind } : {}),
    ...(typeof manifest.repo === 'string' ? { repo: manifest.repo } : {}),
    body_visibility_grant_count: manifest.mcp_body_visibility_grants?.length ?? 0,
    manifest,
    ...overrides,
  };
};

const okInstallResult = (): BulkPackInstallResultLike => ({
  ok: true,
  installed: [
    { slug: 'recipe-a', publisher_id: 'recued-core', version: 1, fresh_install: true },
  ],
  rolled_back: [],
});

// The cli-reachability caller trio — minimal valid shapes. `runUniverse`
// returns an empty tool universe (the snapshot resolves to an empty key set,
// not null, so the install wrapper still fires `openForNewTools`).
const makeCliCallers = () => {
  const runUniverse = vi.fn<SupervisionReachabilityCaller>(async () => ({ tools: [] }));
  const runList = vi.fn<GrantCliReachabilityListCaller>(async () => ({ rows: [] }));
  const runSet = vi.fn<GrantCliReachabilitySetCaller>(async (args) => ({
    principal: args.principal ?? 'user_self',
    ingredient_id: args.ingredient_id,
    operation_id: args.operation_id,
    allowed: args.allowed,
    set_at: 1,
  }));
  return { runUniverse, runList, runSet };
};

describe('D-187 §6 packs route', () => {
  it('mounts the Packs section only — no roster-wide Local tools section — wires callers, and disposes cleanly', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const packsListCaller = vi.fn(async () => ({ packs: [baseEntry({ installed: true })] }));
    const cli = makeCliCallers();
    // Supervision feature (Slice 4) — forwarding guard (forward-or-dead trap).
    const supervisionListCaller = vi.fn(async () => ({ daemons: [] }));
    const supervisionSetCaller = vi.fn(async () => null);

    const route = bootstrapPacksRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      packsListCaller,
      localToolsUniverseCaller: cli.runUniverse,
      localToolsListCaller: cli.runList,
      localToolsSetCaller: cli.runSet,
      supervisionListCaller,
      supervisionSetCaller,
    });

    expect(collectByAttr(root, PACKS_ROUTE_HEADING_ATTR)[0]?.textContent).toBe('Packs');
    expect(collectText(root)).toContain(
      'Install capabilities, review their access, and keep local tools ready.',
    );
    expect(doc.styleElements[0]?.attrs.has(PACKS_ROUTE_STYLES_MARKER)).toBe(true);
    expect(PACKS_ROUTE_STYLES).toContain('[data-recued-install-connect]');
    expect(PACKS_ROUTE_STYLES).toContain('[data-recued-install-grant-picker]');
    expect(PACKS_ROUTE_STYLES).toContain(
      'grid-template-columns: minmax(0, 1fr);',
    );
    expect(PACKS_ROUTE_STYLES).toContain(
      'box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%; color: var(--fg);',
    );
    expect(PACKS_ROUTE_STYLES).toContain(
      '[data-recued-packs-surface-detail] > * {\n  min-width: 0; max-width: 100%;',
    );
    expect(route.packsPanel()).not.toBeNull();
    // The route hosts exactly ONE section, and it is the Packs one. Asserted
    // structurally (tag count + the live-imported attr) rather than by a
    // hard-coded `data-recued-...-local-tools` literal, which would be silently
    // green forever if the literal were ever typo'd.
    const sections = collectByTag(root, 'section');
    expect(sections).toHaveLength(1);
    expect(sections[0]!.attrs.has(PACKS_ROUTE_PACKS_SECTION_ATTR)).toBe(true);
    expect(collectText(root)).not.toContain('Local tools');

    await route.packsPanel()!.whenLoaded();
    await tick();
    // The unified surface loads packs.list TWICE at mount: once for the browse
    // list's install-state join (the discover panel's union corpus) and once for
    // the detail panel's roster (both share this caller).
    expect(packsListCaller).toHaveBeenCalledTimes(2);
    expect(route.packsPanel()!.getState()).toBe('ready');
    // The universe read survives the section's deletion because a DIFFERENT
    // consumer needs it: the supervised-daemon rows' binary-on-PATH gate. This
    // wiring has no ACCESS trio, so `runList` is correctly NOT pulled here —
    // the ACCESS path is asserted in its own case below.
    expect(cli.runUniverse).toHaveBeenCalled();
    // Supervision discovery list is pulled alongside packs.list (forwarded).
    expect(supervisionListCaller).toHaveBeenCalled();

    route.dispose();
    expect(root.children).toHaveLength(0);
  });

  it('forwards the cli list/set pair to the by-pack ACCESS panel (the retired grid was not their only consumer)', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const cli = makeCliCallers();
    // ACCESS turns on only with contracts + grant-read + catalog-operations.
    const accessContractsCaller = vi.fn<GrantContractsCaller>(async () => ({
      contracts: [],
    }));
    const contractGrantReadCaller = vi.fn<GrantReadCaller>(async () => ({ grants: [] }));
    const catalogOperationsCaller = vi.fn<GrantCatalogOperationsCaller>(async () => ({
      ingredients: [],
    }));

    const route = bootstrapPacksRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      packsListCaller: vi.fn(async () => ({ packs: [baseEntry({ installed: true })] })),
      localToolsListCaller: cli.runList,
      localToolsSetCaller: cli.runSet,
      accessContractsCaller,
      contractGrantReadCaller,
      catalogOperationsCaller,
    });

    await route.packsPanel()!.whenLoaded();
    await tick();

    // The ACCESS panel resolves cli op state from the reachability allowlist —
    // so `cli.reachability.list` is pulled with NO Local tools section present.
    // If a future change drops these callers as "local tools cleanup", the cli
    // op toggles go inert and this red catches it.
    expect(cli.runList).toHaveBeenCalled();
    expect(accessContractsCaller).toHaveBeenCalled();

    route.dispose();
  });

  it('renders unavailable empty-states + null accessors when no callers are wired', () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const route = bootstrapPacksRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
    });

    expect(route.packsPanel()).toBeNull();
    expect(route.cliGrantDialog()).toBeNull();
    // ONE unavailable panel — the Packs section's. Was 2 before the roster-wide
    // Local tools section was retired.
    expect(collectByAttr(root, PACKS_ROUTE_UNAVAILABLE_ATTR)).toHaveLength(1);
    expect(
      findByAttrValue(root, PACKS_ROUTE_PACKS_SECTION_ATTR, '')
        ?? collectByAttr(root, PACKS_ROUTE_PACKS_SECTION_ATTR)[0],
    ).not.toBeUndefined();

    route.dispose();
  });

  it('wires the install-time cli grant dialog only with the install + cli.reachability trio', () => {
    const doc = makeFakeDocument();

    // install caller but NO cli.reachability callers → dialog not wired.
    const rootA = doc.createElement('div');
    const routeA = bootstrapPacksRoute({
      root: rootA as unknown as HTMLElement,
      document: doc as unknown as Document,
      packsListCaller: vi.fn(async () => ({ packs: [] })),
      packsInstallCaller: vi.fn(async () => ({ result: okInstallResult() })),
    });
    expect(routeA.cliGrantDialog()).toBeNull();
    routeA.dispose();

    // install caller + the cli.reachability trio → dialog wired.
    const rootB = doc.createElement('div');
    const cli = makeCliCallers();
    const routeB = bootstrapPacksRoute({
      root: rootB as unknown as HTMLElement,
      document: doc as unknown as Document,
      packsListCaller: vi.fn(async () => ({ packs: [] })),
      packsInstallCaller: vi.fn(async () => ({ result: okInstallResult() })),
      localToolsUniverseCaller: cli.runUniverse,
      localToolsListCaller: cli.runList,
      localToolsSetCaller: cli.runSet,
    });
    expect(routeB.cliGrantDialog()).not.toBeNull();
    routeB.dispose();
  });

  it('on a successful install the wrapped caller opens the cli-grant dialog for the new tool + grants the op', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');

    // The cli universe is empty BEFORE the install (the wrapper's pre-install
    // snapshot `before` = ∅) and gains a tool/op AFTER it — so the post-install
    // `openForNewTools` diff detects a NEW op and pops the dialog. The install
    // caller flips the flag. (`snapshot()` reads `runUniverse` synchronously at
    // wrapper entry, before the install resolves, so `before` stays empty.)
    let installed = false;
    const runUniverse = vi.fn<SupervisionReachabilityCaller>(async () => ({
      tools: installed
        ? [
            {
              tool: 'whisper',
              catalog_slugs: ['whisper'],
              operations: [
                { operation_id: 'transcribe', catalog_slug: 'whisper', risk_tier: 'write' },
              ],
            },
          ]
        : [],
    }));
    const runList = vi.fn<GrantCliReachabilityListCaller>(async () => ({ rows: [] }));
    const runSet = vi.fn<GrantCliReachabilitySetCaller>(async (args) => ({
      principal: args.principal ?? 'user_self',
      ingredient_id: args.ingredient_id,
      operation_id: args.operation_id,
      allowed: args.allowed,
      set_at: 1,
    }));
    const packsInstallCaller = vi.fn(async () => {
      installed = true;
      return { result: okInstallResult() };
    });

    const route = bootstrapPacksRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      packsListCaller: vi.fn(async () => ({ packs: [baseEntry()] })),
      packsInstallCaller,
      localToolsUniverseCaller: runUniverse,
      localToolsListCaller: runList,
      localToolsSetCaller: runSet,
    });

    await route.packsPanel()!.whenLoaded();
    await tick();

    // Detail-only surface — open the pack's detail first so its Install
    // affordance renders (a row click does this in the real UI), then install.
    route.packsPanel()!.clickSelectPack('test-pack');
    await tick();
    route.packsPanel()!.clickInstall('test-pack');
    await route.packsPanel()!.clickConfirmInstall();
    await tick();

    // The wrapper delegated to the raw install…
    expect(packsInstallCaller).toHaveBeenCalledTimes(1);
    // …then popped the cli-grant dialog for the install's new tool.
    const dialog = route.cliGrantDialog();
    expect(dialog).not.toBeNull();
    expect(dialog!.isOpen()).toBe(true);
    expect(dialog!.getDialogTools()).toEqual([
      { tool: 'whisper', new_ops: ['transcribe'] },
    ]);

    // Granting the new op writes one fail-closed reachability row.
    dialog!.toggleOp('whisper', 'transcribe');
    await dialog!.confirm();
    await tick();
    expect(runSet).toHaveBeenCalledTimes(1);
    expect(runSet.mock.calls[0]![0]).toMatchObject({
      ingredient_id: 'whisper',
      operation_id: 'transcribe',
      allowed: true,
    });

    route.dispose();
  });

  it('Settings no longer mounts a Packs or Local tools section', () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const route = bootstrapSettingsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
    });
    expect(findByAttrValue(root as unknown as FakeEl, SETTINGS_ROUTE_SECTION_ATTR, 'packs')).toBeNull();
    expect(
      findByAttrValue(root as unknown as FakeEl, SETTINGS_ROUTE_SECTION_ATTR, 'local-tools'),
    ).toBeNull();
    route.dispose();
  });
});

// ── Packs R22 — list→detail routing (slice R1.1) ────────────────────
describe('Packs R22 — route list→detail wiring', () => {
  const twoPacks = (): PackListEntry[] => [
    baseEntry({ manifest: baseManifest({ slug: 'pack-a', name: 'Pack A' }) }),
    baseEntry({ manifest: baseManifest({ slug: 'pack-b', name: 'Pack B' }) }),
  ];

  it('initialPackSlug opens the pack detail on mount', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const route = bootstrapPacksRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      packsListCaller: vi.fn(async () => ({ packs: twoPacks() })),
      initialPackSlug: 'pack-b',
    });
    await route.packsPanel()!.whenLoaded();
    await tick();
    expect(route.packsPanel()!.getSelectedSlug()).toBe('pack-b');
    route.dispose();
  });

  const viewRecipe = (id: string): ServerRecipeListEntry => ({
    recipe_id: id,
    publisher_id: 'recued-core',
    version: 1,
    recipe_hash: `hash-${id}`,
    recipe: {
      recipe_id: id,
      version: 1,
      ttl: 0,
      metadata: {
        name: id === 'view-a' ? 'View A' : 'View B',
        description: `Read ${id}`,
        author: 'recued-core',
        supported_platforms: [],
      },
      variables: {},
      steps: [],
      requires: [],
      output: {
        render: [{ type: 'table', source: 'step.rows' }],
      },
    },
    source: 'bundled',
    installed_at: 0,
  } as unknown as ServerRecipeListEntry);

  const appPack = (): PackListEntry => baseEntry({
    installed: true,
    manifest: baseManifest({
      slug: 'app-pack',
      name: 'App Pack',
      recipes: [
        { slug: 'view-a', version: 1 },
        { slug: 'view-b', version: 1 },
      ],
    }),
  });

  it('hydrates a dynamically-derived Business Pack view from its route', async () => {
    const calls: string[] = [];
    const doc = makeFakeDocument() as FakeDoc & {
      defaultView?: {
        history: {
          replaceState: (s: unknown, t: string, url: string) => void;
          pushState: (s: unknown, t: string, url: string) => void;
        };
      };
    };
    doc.defaultView = {
      history: {
        replaceState: (_s, _t, url) => { calls.push(`replace ${url}`); },
        pushState: (_s, _t, url) => { calls.push(`push ${url}`); },
      },
    };
    const root = doc.createElement('div');
    const execute = vi.fn<PackAppExecuteCaller>(async ({ recipe_id }) => ({
      recipe_id,
      recipe_hash: `run-${recipe_id}`,
      success: true,
      duration_ms: 1,
      steps: [],
      errors: [],
      output: {
        render: [{ type: 'table', data: { rows: [] } }],
        sidebar: [],
      },
    }));
    const route = bootstrapPacksRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      packsListCaller: vi.fn(async () => ({ packs: [appPack()] })),
      recipesListCaller: vi.fn(async () => ({
        recipes: [viewRecipe('view-a'), viewRecipe('view-b')],
      })),
      recipeExecuteCaller: execute,
      initialPackSlug: 'app-pack',
      initialPackViewId: 'view-b',
    });
    await route.packsPanel()!.whenLoaded();
    await tick(20);

    expect(route.packsPanel()!.getActiveViewId()).toBe('view-b');
    expect(execute).toHaveBeenCalledWith({ recipe_id: 'view-b', config: {} });
    expect(calls, 'hydration must not duplicate the existing deep link').toEqual([]);
    route.dispose();
  });

  it('absorbs an auto-opened Business Pack view into list → preview → action history', async () => {
    const calls: string[] = [];
    const doc = makeFakeDocument() as FakeDoc & {
      defaultView?: {
        history: {
          replaceState: (s: unknown, t: string, url: string) => void;
          pushState: (s: unknown, t: string, url: string) => void;
        };
      };
    };
    doc.defaultView = {
      history: {
        replaceState: (_s, _t, url) => { calls.push(`replace ${url}`); },
        pushState: (_s, _t, url) => { calls.push(`push ${url}`); },
      },
    };
    const root = doc.createElement('div');
    const route = bootstrapPacksRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      packsListCaller: vi.fn(async () => ({ packs: [appPack()] })),
      recipesListCaller: vi.fn(async () => ({
        recipes: [viewRecipe('view-a'), viewRecipe('view-b')],
      })),
      recipeExecuteCaller: vi.fn(async ({ recipe_id }) => ({
        recipe_id,
        recipe_hash: `run-${recipe_id}`,
        success: true,
        steps: [],
        errors: [],
        output: { render: [] },
      } as never)),
    });
    await route.packsPanel()!.whenLoaded();

    route.packsPanel()!.clickSelectPack('app-pack');
    await tick(20);
    expect(route.packsPanel()!.getActiveViewId()).toBe('view-a');
    expect(calls).toEqual([
      'push #packs/app-pack',
      'replace #packs/app-pack/use/view-a',
    ]);

    findByAttrValue(root, PACKS_DETAIL_TAB_ATTR, 'detail')!.click();
    expect(calls.at(-1)).toBe('replace #packs/app-pack');
    findByAttrValue(root, PACKS_DETAIL_TAB_ATTR, 'use')!.click();
    expect(calls.at(-1)).toBe('replace #packs/app-pack/use/view-a');
    route.dispose();
  });

  /** D-282 B5 — the WHOLE thread, at the composition root.
   *
   *  ⛔⛔ EVERY LINK IN THIS CHAIN IS UNIT-TESTED SOMEWHERE ELSE, and that is
   *  exactly why this test exists: `parsePacksAddress` → `initialPackViewTarget`
   *  → `initialAppViewTarget` → `initialTarget` → `runLookup`, plus the
   *  canonicalizer that would otherwise rewrite the address away before the
   *  record loaded. A hand-wired harness for any one link cannot see a wrong
   *  option name in the next. */
  it('hydrates a bookmarked lookup address and does not canonicalize it away', async () => {
    const calls: string[] = [];
    const doc = makeFakeDocument() as FakeDoc & {
      defaultView?: {
        history: {
          replaceState: (s: unknown, t: string, url: string) => void;
          pushState: (s: unknown, t: string, url: string) => void;
        };
      };
    };
    doc.defaultView = {
      history: {
        replaceState: (_s, _t, url) => { calls.push(`replace ${url}`); },
        pushState: (_s, _t, url) => { calls.push(`push ${url}`); },
      },
    };
    const root = doc.createElement('div');
    const execute = vi.fn<PackAppExecuteCaller>(async ({ recipe_id }) => ({
      recipe_id,
      recipe_hash: `run-${recipe_id}`,
      success: true,
      duration_ms: 1,
      steps: [],
      errors: [],
      output: { render: [{ type: 'table', data: { rows: [] } }], sidebar: [] },
    }));
    // A reading surface + one required variable + no ops ⇒ a LOOKUP.
    const detailRecipe = {
      ...viewRecipe('detail-a'),
      recipe: {
        ...viewRecipe('detail-a').recipe,
        variables: { id: { label: 'The record', type: 'string' } },
      },
    } as unknown as ServerRecipeListEntry;
    const route = bootstrapPacksRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      packsListCaller: vi.fn(async () => ({
        packs: [baseEntry({
          installed: true,
          manifest: baseManifest({
            slug: 'app-pack',
            name: 'App Pack',
            recipes: [{ slug: 'view-a', version: 1 }, { slug: 'detail-a', version: 1 }],
          }),
        })],
      })),
      recipesListCaller: vi.fn(async () => ({
        recipes: [viewRecipe('view-a'), detailRecipe],
      })),
      recipeExecuteCaller: execute,
      initialPackSlug: 'app-pack',
      initialPackViewId: 'detail-a',
      initialPackViewTarget: 'rec_7',
    });
    await route.packsPanel()!.whenLoaded();
    await tick(20);

    expect(execute.mock.calls.map((call) => call[0]!.recipe_id))
      .toEqual(['view-a', 'detail-a']);
    expect(execute.mock.calls[1]![0]).toEqual({
      recipe_id: 'detail-a',
      config: { id: 'rec_7' },
    });
    // The browse tab stays the one underneath — a lookup is never a tab.
    expect(route.packsPanel()!.getActiveViewId()).toBe('view-a');
    // ⛔ AND THE ADDRESS SURVIVES. The stale-tail canonicalizer below rewrites
    // any requested id that is not the open tab; a lookup id never is, so
    // without the `hydratedLookup()` gate it would replace this deep link with
    // `#packs/app-pack/use/view-a` before the record had finished loading.
    expect(calls, 'a hydrated lookup address must not be canonicalized')
      .not.toContain('replace #packs/app-pack/use/view-a');
    route.dispose();
  });

  /** D-282 slice C — the pin control, where an app actually is.
   *
   *  ⛔ IT LIVES INSIDE THE `showUse` BRANCH ON PURPOSE. A capability pack —
   *  `adyen-checkout`, `ripgrep`: ops for other recipes to call, nothing to
   *  open — has no Use tab, and a pinned seat for one would land the owner on a
   *  management page they did not ask for. */
  it('offers a pin on a pack with an app surface, and reports the toggle', async () => {
    const onTogglePin = vi.fn();
    let pins: readonly string[] = [];
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const route = bootstrapPacksRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      packsListCaller: vi.fn(async () => ({ packs: [appPack()] })),
      recipesListCaller: vi.fn(async () => ({ recipes: [viewRecipe('view-a')] })),
      recipeExecuteCaller: vi.fn(async ({ recipe_id }) => ({
        recipe_id, recipe_hash: `run-${recipe_id}`, success: true,
        steps: [], errors: [], output: { render: [] },
      } as never)),
      initialPackSlug: 'app-pack',
      pinnedApps: () => pins,
      onTogglePin: (slug: string, pinned: boolean) => {
        onTogglePin(slug, pinned);
        // The real writer updates its list synchronously, then reconciles with
        // the server. The panel repaints straight after and reads it back
        // through the getter — that is what makes the label flip without the
        // panel keeping a second copy of the pin list.
        pins = pinned ? [...pins, slug] : pins.filter((entry) => entry !== slug);
      },
    });
    await route.packsPanel()!.whenLoaded();
    await tick(20);

    const pin = findByAttr(root, PACKS_DETAIL_PIN_ATTR)!;
    expect(pin, 'a pack with a Use tab offers a pin').toBeTruthy();
    expect(pin.getAttribute(PACKS_DETAIL_PIN_ATTR)).toBe('unpinned');

    pin.click();
    await tick(20);
    expect(onTogglePin).toHaveBeenCalledWith('app-pack', true);
    expect(findByAttr(root, PACKS_DETAIL_PIN_ATTR)!.getAttribute(PACKS_DETAIL_PIN_ATTR))
      .toBe('pinned');

    findByAttr(root, PACKS_DETAIL_PIN_ATTR)!.click();
    await tick(20);
    expect(onTogglePin).toHaveBeenLastCalledWith('app-pack', false);
    expect(findByAttr(root, PACKS_DETAIL_PIN_ATTR)!.getAttribute(PACKS_DETAIL_PIN_ATTR))
      .toBe('unpinned');
    route.dispose();
  });

  it('offers no pin on a pack with nothing to open', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const route = bootstrapPacksRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      packsListCaller: vi.fn(async () => ({ packs: [appPack()] })),
      // No installed recipes ⇒ no app surface ⇒ no Use tab.
      recipesListCaller: vi.fn(async () => ({ recipes: [] })),
      initialPackSlug: 'app-pack',
      pinnedApps: () => [],
      onTogglePin: vi.fn(),
    });
    await route.packsPanel()!.whenLoaded();
    await tick(20);

    expect(findByAttr(root, PACKS_DETAIL_PIN_ATTR)).toBeNull();
    route.dispose();
  });

  it('replace-canonicalizes a stale generated view to the first valid view', async () => {
    const replaceState = vi.fn();
    const onHashSync = vi.fn();
    const doc = makeFakeDocument() as FakeDoc & {
      defaultView?: { history: { replaceState: typeof replaceState } };
    };
    doc.defaultView = { history: { replaceState } };
    const root = doc.createElement('div');
    const route = bootstrapPacksRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      packsListCaller: vi.fn(async () => ({ packs: [appPack()] })),
      recipesListCaller: vi.fn(async () => ({
        recipes: [viewRecipe('view-a'), viewRecipe('view-b')],
      })),
      recipeExecuteCaller: vi.fn(async ({ recipe_id }) => ({
        recipe_id,
        recipe_hash: `run-${recipe_id}`,
        success: true,
        steps: [],
        errors: [],
        output: { render: [] },
      } as never)),
      initialPackSlug: 'app-pack',
      initialPackViewId: 'retired-view',
      onHashSync,
    });
    await route.packsPanel()!.whenLoaded();
    await tick(20);

    expect(route.packsPanel()!.getActiveViewId()).toBe('view-a');
    expect(replaceState).toHaveBeenCalledWith(
      null,
      '',
      '#packs/app-pack/use/view-a',
    );
    expect(onHashSync).toHaveBeenCalledWith('#packs/app-pack/use/view-a');
    route.dispose();
  });

  it('collapses a generated-view deep link when the pack has no app surface', async () => {
    const replaceState = vi.fn();
    const doc = makeFakeDocument() as FakeDoc & {
      defaultView?: { history: { replaceState: typeof replaceState } };
    };
    doc.defaultView = { history: { replaceState } };
    const root = doc.createElement('div');
    const route = bootstrapPacksRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      packsListCaller: vi.fn(async () => ({ packs: [appPack()] })),
      recipesListCaller: vi.fn(async () => ({ recipes: [] })),
      initialPackSlug: 'app-pack',
      initialPackViewId: 'retired-view',
    });
    await route.packsPanel()!.whenLoaded();
    await tick(20);

    expect(route.packsPanel()!.getActiveViewId()).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, '', '#packs/app-pack');
    route.dispose();
  });

  it('⛔⛔ opening a detail PUSHES so native Back returns to the list, not past it', async () => {
    /** `#packs` → `#packs/<slug>` used `replaceState` for the whole transition, which
     *  OVERWROTE the list entry — so the browser's Back button skipped `#packs` and
     *  landed a level above it, on the route the owner came from rather than the one
     *  they were looking at.
     *  🔑 `pushState` emits no `hashchange` either, so the reason `replaceState` was
     *  chosen — in-page navigation must never remount — is untouched. Asserted as the
     *  ORDERED sequence of history calls, because "pushState was called" alone would
     *  pass even if it also pushed on the way back, which would trap Back in a loop. */
    const calls: string[] = [];
    const doc = makeFakeDocument() as FakeDoc & {
      defaultView?: {
        history: {
          replaceState: (s: unknown, t: string, url: string) => void;
          pushState: (s: unknown, t: string, url: string) => void;
        };
      };
    };
    doc.defaultView = {
      history: {
        replaceState: (_s, _t, url) => { calls.push(`replace ${url}`); },
        pushState: (_s, _t, url) => { calls.push(`push ${url}`); },
      },
    };
    const root = doc.createElement('div');
    const route = bootstrapPacksRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      packsListCaller: vi.fn(async () => ({ packs: twoPacks() })),
    });
    await route.packsPanel()!.whenLoaded();
    await tick();

    route.packsPanel()!.clickSelectPack('pack-a');
    expect(calls, 'entering a detail must PUSH a history entry')
      .toContain('push #packs/pack-a');
    expect(calls, 'and must not merely replace the list away')
      .not.toContain('replace #packs/pack-a');

    /** ⚠ Returning to the list REPLACES. Pushing here too would leave two entries and
     *  Back would bounce the owner into the detail they just closed. */
    route.packsPanel()!.clickBackToList();
    expect(calls).toContain('replace #packs');
    expect(calls.filter((c) => c.startsWith('push ')),
      'only the detail-opening step may push').toEqual(['push #packs/pack-a']);
    route.dispose();
  });

  it('an in-page selection replaceStates AND notifies onHashSync (so the router activeHash tracks it, closing the stale-hash desync)', async () => {
    const replaceCalls: string[] = [];
    const doc = makeFakeDocument() as FakeDoc & {
      defaultView?: {
        history: { replaceState: (s: unknown, t: string, url: string) => void };
      };
    };
    doc.defaultView = {
      history: {
        replaceState: (_s, _t, url) => {
          replaceCalls.push(url);
        },
      },
    };
    const root = doc.createElement('div');
    const onHashSync = vi.fn<(hash: string) => void>();
    const route = bootstrapPacksRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      packsListCaller: vi.fn(async () => ({ packs: twoPacks() })),
      onHashSync,
    });
    await route.packsPanel()!.whenLoaded();
    await tick();

    // Opening a pack: URL + router notified together.
    route.packsPanel()!.clickSelectPack('pack-a');
    expect(replaceCalls).toContain('#packs/pack-a');
    expect(onHashSync).toHaveBeenCalledWith('#packs/pack-a');

    // Back to the list: same lockstep, bare #packs.
    route.packsPanel()!.clickBackToList();
    expect(replaceCalls).toContain('#packs');
    expect(onHashSync).toHaveBeenLastCalledWith('#packs');
    route.dispose();
  });
});

// ────────────────────────────────────────────────────────────────
// Add-a-pack (2026-07-01) — resolvePackInput (slug vs URL parser)
// ────────────────────────────────────────────────────────────────

describe('resolvePackInput', () => {
  it('parses a bare slug', () => {
    expect(resolvePackInput('deal-risk-hubspot')).toEqual({ slug: 'deal-risk-hubspot' });
    expect(resolvePackInput('  sales-pack  ')).toEqual({ slug: 'sales-pack' });
  });

  it('parses a marketplace pack URL (apex root, legacy prefix, with/without .json) to a slug', () => {
    expect(resolvePackInput('recued.com/packs/sales-pack')).toEqual({ slug: 'sales-pack' });
    expect(resolvePackInput('https://recued.com/packs/sales-pack')).toEqual({ slug: 'sales-pack' });
    expect(resolvePackInput('https://recued.com/marketplace/packs/sales-pack')).toEqual({ slug: 'sales-pack' });
    expect(resolvePackInput('https://recued.com/packs/sales-pack.json')).toEqual({ slug: 'sales-pack' });
  });

  it('passes an arbitrary (non-marketplace) URL through as { url } — the deferred local-import path', () => {
    expect(resolvePackInput('https://example.com/my-pack.json')).toEqual({ url: 'https://example.com/my-pack.json' });
    // A dotted host without a scheme is treated as a URL.
    expect(resolvePackInput('example.com/my-pack.json')).toEqual({ url: 'https://example.com/my-pack.json' });
  });

  it('returns null for empty input', () => {
    expect(resolvePackInput('')).toBeNull();
    expect(resolvePackInput('   ')).toBeNull();
  });
});
