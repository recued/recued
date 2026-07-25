import { describe, expect, it, vi } from 'vitest';
import type {
  ConnectionView,
  DependencyResolution,
  RecipeDefinition,
  RecipeRunnabilityEntry,
  RunnabilityStatus,
  ServerExecuteResponse,
  ServerRecipeListEntry,
  ToolEntry,
} from '@recued/contracts';

import { RunModal } from '@recued/ui-shared';

import {
  RECIPES_ROUTE_BACK_ATTR,
  RECIPES_ROUTE_CONNECTIONS_ATTR,
  RECIPES_ROUTE_CONNECTIONS_LINK_ATTR,
  RECIPES_ROUTE_DEFINITION_ATTR,
  RECIPES_ROUTE_DETAIL_ATTR,
  RECIPES_ROUTE_EDIT_LINK_ATTR,
  RECIPES_ROUTE_FROM_PACK_ATTR,
  RECIPES_ROUTE_HEADING_ATTR,
  RECIPES_ROUTE_HOST_ATTR,
  RECIPES_ROUTE_KITCHEN_LINK_ATTR,
  RECIPES_ROUTE_RECIPE_TRIGGER_ATTR,
  RECIPES_ROUTE_RELATED_ATTR,
  RECIPES_ROUTE_RELATED_ROW_ATTR,
  RECIPES_ROUTE_RESULT_PANEL_ATTR,
  RECIPES_ROUTE_RESULT_ACTION_ATTR,
  RECIPES_ROUTE_RESULT_FILE_ATTR,
  RECIPES_ROUTE_RESULT_FILE_STATUS_ATTR,
  RECIPES_ROUTE_RESULT_PROVENANCE_ATTR,
  RECIPES_ROUTE_RESULT_RETURN_ATTR,
  RECIPES_ROUTE_RESULT_SECTION_ATTR,
  RECIPES_ROUTE_RUN_BUTTON_ATTR,
  RECIPES_ROUTE_RUNNABILITY_ATTR,
  RECIPES_ROUTE_RUNS_LINK_ATTR,
  RECIPES_ROUTE_AUTOMATION_LINK_ATTR,
  RECIPES_ROUTE_STYLES_MARKER,
  bootstrapRecipesRoute,
  type RecipeExecuteCaller,
  type RecipeFileReadCaller,
  type RecipesConnectionsListCaller,
  type RecipesListCaller,
  type RecipesRunnabilityCaller,
  type RecipesToolCatalogCaller,
} from '../recipes/bootstrap-recipes-route.js';

// The Run modal is the shared `@recued/ui-shared` RunModal — it portals to
// `opts.root` (no `body` in the fake doc), a SIBLING of the route host, and
// renders into that overlay element's `innerHTML`. This finds that overlay's
// HTML (empty string when no modal is open).
const runModalHtml = (root: FakeEl): string =>
  root.children.find((c) =>
    c.innerHTML.includes(RunModal.RUN_MODAL_OVERLAY_ATTR),
  )?.innerHTML ?? '';

type RecipesRouteSubscribe = NonNullable<
  Parameters<typeof bootstrapRecipesRoute>[0]['subscribe']
>;

interface FakeEl {
  tagName: string;
  textContent: string;
  innerHTML: string;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  listeners: Map<string, Array<(ev: Event) => void>>;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  querySelector(sel: string): FakeEl | null;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(type: string, fn: (ev: Event) => void): void;
  removeEventListener(type: string, fn: (ev: Event) => void): void;
  click(): void;
  remove(): void;
}

interface FakeDoc {
  styleElements: FakeEl[];
  defaultView?: {
    confirm?: (message?: string) => boolean;
    navigator?: {
      clipboard?: {
        writeText(value: string): Promise<void>;
      };
    };
    atob?: (value: string) => string;
    Blob?: typeof Blob;
    URL?: {
      createObjectURL(blob: Blob): string;
      revokeObjectURL(url: string): void;
    };
  };
  head: {
    querySelector(sel: string): FakeEl | null;
    appendChild(el: FakeEl): FakeEl;
  };
  createElement(tag: string): FakeEl;
  addEventListener(type: string, fn: (ev: Event) => void): void;
  removeEventListener(type: string, fn: (ev: Event) => void): void;
}

const attrSelectorParts = (sel: string): { attr: string; value: string | null } | null => {
  const m = sel.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
  if (m === null) return null;
  return { attr: m[1]!, value: m[2] ?? null };
};

const makeFakeEl = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    textContent: '',
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
    },
    getAttribute(k) {
      return el.attrs.get(k) ?? null;
    },
    hasAttribute(k) {
      return el.attrs.has(k);
    },
    querySelector(sel) {
      const parts = attrSelectorParts(sel);
      if (parts === null) return null;
      const visit = (node: FakeEl): FakeEl | null => {
        for (const child of node.children) {
          const attr = child.attrs.get(parts.attr);
          if (attr !== undefined && (parts.value === null || attr === parts.value)) {
            return child;
          }
          const found = visit(child);
          if (found !== null) return found;
        }
        return null;
      };
      return visit(el);
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
      const arr = el.listeners.get(type) ?? [];
      arr.push(fn);
      el.listeners.set(type, arr);
    },
    removeEventListener(type, fn) {
      const arr = el.listeners.get(type);
      if (arr === undefined) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    click() {},
    remove() {
      if (el.parent !== null) el.parent.removeChild(el);
    },
  };
  return el;
};

const makeFakeDocument = (overrides: {
  confirm?: (message?: string) => boolean;
  clipboardWrite?: (value: string) => Promise<void>;
  fileBrowser?: boolean;
} = {}): FakeDoc => {
  const styleElements: FakeEl[] = [];
  const docListeners = new Map<string, Array<(ev: Event) => void>>();
  const attrFromStyleSelector = (sel: string): string | null => {
    const m = sel.match(/^style\[([\w-]+)\]$/);
    return m?.[1] ?? null;
  };
  return {
    styleElements,
    ...(
      overrides.confirm !== undefined
      || overrides.clipboardWrite !== undefined
      || overrides.fileBrowser === true
      ? {
          defaultView: {
            ...(overrides.confirm !== undefined ? { confirm: overrides.confirm } : {}),
            ...(overrides.clipboardWrite !== undefined
              ? { navigator: { clipboard: { writeText: overrides.clipboardWrite } } }
              : {}),
            ...(overrides.fileBrowser === true
              ? {
                  atob: (value: string) => globalThis.atob(value),
                  Blob: globalThis.Blob,
                  URL: {
                    createObjectURL: () => 'blob:fake-result-file',
                    revokeObjectURL: () => {},
                  },
                }
              : {}),
          },
        }
      : {}),
    head: {
      querySelector(sel) {
        const attr = attrFromStyleSelector(sel);
        if (attr === null) return null;
        return styleElements.find((style) => style.attrs.has(attr)) ?? null;
      },
      appendChild(el) {
        styleElements.push(el);
        return el;
      },
    },
    createElement: (tag) => makeFakeEl(tag),
    addEventListener(type, fn) {
      const arr = docListeners.get(type) ?? [];
      arr.push(fn);
      docListeners.set(type, arr);
    },
    removeEventListener(type, fn) {
      const arr = docListeners.get(type);
      if (arr === undefined) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
  };
};

const recipeDefinition = (
  recipe_id = 'daily-brief',
  overrides: Partial<RecipeDefinition> = {},
): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 0,
  metadata: {
    name: 'Daily brief',
    description: 'Summarize today.',
    author: 'recued-core',
    supported_platforms: [],
    tags: ['briefing'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { sidebar: [] },
  requires: ['read_memory'],
  ...overrides,
});

const recipeEntry = (
  recipe_id = 'daily-brief',
  overrides: Partial<ServerRecipeListEntry> = {},
): ServerRecipeListEntry => {
  const recipe = recipeDefinition(recipe_id);
  return {
    recipe_id,
    publisher_id: 'recued-core',
    version: 1,
    recipe_hash: `hash-${recipe_id}`,
    recipe,
    source: 'pair-sync',
    installed_at: 1_700_000_000_000,
    ...overrides,
  };
};

const targetRecipeWithEntityContext = (
  recipe_id: string,
  name: string,
): ServerRecipeListEntry =>
  recipeEntry(recipe_id, {
    recipe: recipeDefinition(recipe_id, {
      metadata: {
        name,
        description: 'Run a target action.',
        author: 'recued-core',
        supported_platforms: [],
        tags: [],
      },
      output: {
        render: [{ type: 'text', source: '{{context.entity_id}}' }],
      },
    }),
  });

const toolEntry = (
  overrides: Partial<ToolEntry> = {},
): ToolEntry => ({
  name: 'recued-core/daily-brief',
  tier: 2,
  description: 'Run the daily brief recipe.',
  arg_schema: { type: 'object' },
  topic_tags: [],
  classification: 'read',
  concurrency_safe: false,
  risk_tier: 'read',
  requires_kinds: ['storage'],
  ...overrides,
});

const executeResponse = (
  overrides: Partial<ServerExecuteResponse> = {},
): ServerExecuteResponse => ({
  recipe_id: 'daily-brief',
  recipe_hash: 'hash-daily-brief',
  success: true,
  output: { render: [], sidebar: [] },
  steps: [{ id: 'step-1', type: 'test', skipped: false, duration_ms: 3, error: null }],
  errors: [],
  duration_ms: 7,
  ...overrides,
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const mountRoute = (overrides: {
  recipesListCaller?: RecipesListCaller;
  toolCatalogCaller?: RecipesToolCatalogCaller;
  recipeExecuteCaller?: RecipeExecuteCaller;
  fileReadCaller?: RecipeFileReadCaller;
  connectionsListCaller?: RecipesConnectionsListCaller;
  runnabilityCaller?: RecipesRunnabilityCaller | null;
  schedulesListCaller?: Parameters<typeof bootstrapRecipesRoute>[0]['schedulesListCaller'];
  schedulesCreateCaller?: Parameters<typeof bootstrapRecipesRoute>[0]['schedulesCreateCaller'];
  autoRunListCaller?: Parameters<typeof bootstrapRecipesRoute>[0]['autoRunListCaller'];
  autoRunUpdateCaller?: Parameters<typeof bootstrapRecipesRoute>[0]['autoRunUpdateCaller'];
  recipeConfigGetCaller?: Parameters<typeof bootstrapRecipesRoute>[0]['recipeConfigGetCaller'];
  recipeConfigSetCaller?: Parameters<typeof bootstrapRecipesRoute>[0]['recipeConfigSetCaller'];
  recipeCatalogCaller?: Parameters<typeof bootstrapRecipesRoute>[0]['recipeCatalogCaller'];
  packCatalogCaller?: Parameters<typeof bootstrapRecipesRoute>[0]['packCatalogCaller'];
  subscribe?: Parameters<typeof bootstrapRecipesRoute>[0]['subscribe'];
  initialRecipeId?: string;
  confirm?: (message?: string) => boolean;
  clipboardWrite?: (value: string) => Promise<void>;
  fileBrowser?: boolean;
} = {}) => {
  const doc = makeFakeDocument(
    {
      ...(overrides.confirm !== undefined ? { confirm: overrides.confirm } : {}),
      ...(overrides.clipboardWrite !== undefined
        ? { clipboardWrite: overrides.clipboardWrite }
        : {}),
      ...(overrides.fileBrowser === true ? { fileBrowser: true } : {}),
    },
  );
  const root = doc.createElement('div');
  const recipesListCaller =
    overrides.recipesListCaller
    ?? vi.fn<RecipesListCaller>(async () => ({
      recipes: [recipeEntry()],
    }));
  const toolCatalogCaller =
    overrides.toolCatalogCaller
    ?? vi.fn<RecipesToolCatalogCaller>(async () => ({
      catalog: [toolEntry()],
    }));
  const recipeExecuteCaller =
    overrides.recipeExecuteCaller
    ?? vi.fn<RecipeExecuteCaller>(async () => executeResponse());
  const runnabilityCaller =
    overrides.runnabilityCaller === undefined
      ? vi.fn<RecipesRunnabilityCaller>(async () => ({
          recipes: [
            'daily-brief',
            'review-queue',
            'reply-action',
            'close-action',
            'escalate',
          ].map((recipe_id) => ({
            recipe_id,
            status: 'runnable' as RunnabilityStatus,
            dependencies: [],
          })),
        }))
      : overrides.runnabilityCaller;

  const route = bootstrapRecipesRoute({
    root: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    recipesListCaller,
    toolCatalogCaller,
    recipeExecuteCaller,
    ...(overrides.fileReadCaller !== undefined
      ? { fileReadCaller: overrides.fileReadCaller }
      : {}),
    ...(overrides.connectionsListCaller !== undefined
      ? { connectionsListCaller: overrides.connectionsListCaller }
      : {}),
    ...(runnabilityCaller !== null
      ? { runnabilityCaller }
      : {}),
    ...(overrides.schedulesListCaller !== undefined
      ? { schedulesListCaller: overrides.schedulesListCaller }
      : {}),
    ...(overrides.schedulesCreateCaller !== undefined
      ? { schedulesCreateCaller: overrides.schedulesCreateCaller }
      : {}),
    ...(overrides.autoRunListCaller !== undefined
      ? { autoRunListCaller: overrides.autoRunListCaller }
      : {}),
    ...(overrides.autoRunUpdateCaller !== undefined
      ? { autoRunUpdateCaller: overrides.autoRunUpdateCaller }
      : {}),
    ...(overrides.recipeConfigGetCaller !== undefined
      ? { recipeConfigGetCaller: overrides.recipeConfigGetCaller }
      : {}),
    ...(overrides.recipeConfigSetCaller !== undefined
      ? { recipeConfigSetCaller: overrides.recipeConfigSetCaller }
      : {}),
    ...(overrides.recipeCatalogCaller !== undefined
      ? { recipeCatalogCaller: overrides.recipeCatalogCaller }
      : {}),
    ...(overrides.packCatalogCaller !== undefined
      ? { packCatalogCaller: overrides.packCatalogCaller }
      : {}),
    ...(overrides.initialRecipeId !== undefined
      ? { initialRecipeId: overrides.initialRecipeId }
      : {}),
    ...(overrides.subscribe !== undefined ? { subscribe: overrides.subscribe } : {}),
  });
  return {
    doc,
    root,
    route,
    recipesListCaller,
    toolCatalogCaller,
    recipeExecuteCaller,
  };
};

const shellHtml = (root: FakeEl): string => root.children[0]!.innerHTML;

const RESULT_ACTION_SELECT_ATTR = 'data-recued-recipes-result-action-select';

const resultActionSelection = (
  html: string,
): { groupId: string | undefined; actionIds: string[] } => ({
  groupId: html.match(
    new RegExp(`${RESULT_ACTION_SELECT_ATTR}="([^"]+)"`),
  )?.[1],
  actionIds: [...html.matchAll(/<option value="([^"]+)">/g)]
    .map((m) => m[1]!),
});

const appendSelectedResultAction = (
  doc: FakeDoc,
  routeRoot: FakeEl,
  groupId: string,
  actionId: string,
): void => {
  const select = doc.createElement('select') as FakeEl & { value: string };
  select.setAttribute(RESULT_ACTION_SELECT_ATTR, groupId);
  select.value = actionId;
  routeRoot.appendChild(select);
};

const clickRecipeAction = (
  root: FakeEl,
  action: string,
  recipeId: string,
  extraAttrs: Record<string, string> = {},
): void => {
  const actionTarget = {
    textContent: '',
    contains: () => false,
    getAttribute: (name: string) => {
      if (Object.prototype.hasOwnProperty.call(extraAttrs, name)) return extraAttrs[name]!;
      if (name === 'data-recued-recipes-action') return action;
      if (name === 'data-recipe-id') return recipeId;
      return null;
    },
    setAttribute: vi.fn(),
  };
  const target = {
    closest: (selector: string) =>
      selector.includes('data-recued-recipes-action') ? actionTarget : null,
  };
  for (const fn of root.children[0]!.listeners.get('click') ?? []) {
    fn({ target, preventDefault: vi.fn() } as unknown as Event);
  }
};

describe('R24 — Recipes route: list view', () => {
  it('mounts the installed library from recipe.list + the tool catalog', async () => {
    const rig = mountRoute();
    await rig.route.whenLoaded();

    expect(rig.recipesListCaller).toHaveBeenCalledTimes(1);
    expect(rig.toolCatalogCaller).toHaveBeenCalledTimes(1);
    expect(rig.doc.styleElements[0]?.attrs.has(RECIPES_ROUTE_STYLES_MARKER))
      .toBe(true);

    const shell = rig.root.children[0]!;
    expect(shell.attrs.has(RECIPES_ROUTE_HOST_ATTR)).toBe(true);
    expect(shell.innerHTML).toContain(RECIPES_ROUTE_HEADING_ATTR);
    expect(shell.innerHTML).toContain('Daily brief');
    expect(shell.innerHTML).toContain(RECIPES_ROUTE_KITCHEN_LINK_ATTR);
    // Pack machinery + the Exposed-tools section moved out of this route.
    expect(shell.innerHTML).not.toContain('Installed packs');
    expect(shell.innerHTML).not.toContain('Exposed tools');
    expect(rig.route.selectedRecipe()).toBeNull();

    rig.route.dispose();
  });

  it('shows the per-card "from pack X" label (delta 3)', async () => {
    const rig = mountRoute({
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('hub-sync', {
            recipe: recipeDefinition('hub-sync', {
              depends_on: ['recued-core.hubspot'],
            }),
          }),
        ],
      })),
    });
    await rig.route.whenLoaded();

    const html = shellHtml(rig.root);
    expect(html).toContain(`${RECIPES_ROUTE_FROM_PACK_ATTR}="recued-core.hubspot"`);
    expect(html).toContain('from Hubspot');
    expect(html).toContain('href="#packs"');

    rig.route.dispose();
  });

  it('classifies trigger kind structurally — delta 6 (classifyRecipeAction)', async () => {
    // A `trigger_steps` recipe is reactive even with no "notification"
    // string; a recipe whose step ids merely CONTAIN "notification" is NOT
    // an alert (the old JSON.stringify scan misfired on exactly this).
    const rig = mountRoute({
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('reactive-one', {
            recipe: recipeDefinition('reactive-one', {
              trigger_steps: [{ id: 'watch', ingredient: 'x' }],
            } as unknown as Partial<RecipeDefinition>),
          }),
          recipeEntry('notify-named', {
            recipe: recipeDefinition('notify-named', {
              steps: [{ id: 'notification-cleanup', ingredient: 'noop' }],
            } as unknown as Partial<RecipeDefinition>),
          }),
        ],
      })),
    });
    await rig.route.whenLoaded();

    const html = shellHtml(rig.root);
    expect(html).toContain(`${RECIPES_ROUTE_RECIPE_TRIGGER_ATTR}="reactive"`);
    expect(html).toContain(`${RECIPES_ROUTE_RECIPE_TRIGGER_ATTR}="manual"`);
    // The notify-named recipe is manual, not alert — the structural swap.
    expect(html).not.toContain(`${RECIPES_ROUTE_RECIPE_TRIGGER_ATTR}="alert"`);

    rig.route.dispose();
  });

  it('disposes the route and broadcast subscriptions cleanly', async () => {
    const unsubscribers = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    const subscribeKinds: string[] = [];
    let nextUnsubscriber = 0;
    const subscribe: RecipesRouteSubscribe = (kind) => {
      subscribeKinds.push(kind);
      const unsubscribe = unsubscribers[nextUnsubscriber]!;
      nextUnsubscriber += 1;
      return unsubscribe;
    };
    const rig = mountRoute({ subscribe });
    await rig.route.whenLoaded();

    expect(subscribeKinds).toEqual([
      'pack_installed',
      'pack_uninstalled',
      'chat.inbound_token_changed',
      'recipe_runnability_changed',
      'schedule',
      'automation_rule_changed',
    ]);

    rig.route.dispose();
    expect(rig.root.children).toHaveLength(0);
    expect(unsubscribers.every((fn) => fn.mock.calls.length === 1)).toBe(true);
  });
});

describe('R24 — Recipes route: list -> detail (delta 1)', () => {
  it('opens a deep-linked recipe DETAIL after the initial load (not the run modal)', async () => {
    const rig = mountRoute({ initialRecipeId: 'daily-brief' });
    await rig.route.whenLoaded();

    expect(rig.route.selectedRecipe()).toBe('daily-brief');
    const html = shellHtml(rig.root);
    expect(html).toContain(`${RECIPES_ROUTE_DETAIL_ATTR}="daily-brief"`);
    expect(html).toContain(RECIPES_ROUTE_BACK_ATTR);
    expect(html).toContain('Summarize today.'); // full description on the detail
    expect(html).toContain(RECIPES_ROUTE_DEFINITION_ATTR);
    // The deep link no longer auto-opens the run modal.
    expect(runModalHtml(rig.root)).toBe('');

    rig.route.dispose();
  });

  it('starts the detail result panel empty instead of rendering stale output (D-195 P3)', async () => {
    const rig = mountRoute({ initialRecipeId: 'daily-brief' });
    await rig.route.whenLoaded();

    const html = shellHtml(rig.root);
    expect(html).toContain(`${RECIPES_ROUTE_RESULT_PANEL_ATTR}=""`);
    expect(html).toContain('No current-session result yet');
    expect(html).not.toContain(RECIPES_ROUTE_RESULT_SECTION_ATTR);
    expect(rig.route.resultPanel()).toBeNull();

    rig.route.dispose();
  });

  it('drops a deep link to an unknown recipe back to the list', async () => {
    const rig = mountRoute({ initialRecipeId: 'ghost' });
    await rig.route.whenLoaded();

    expect(rig.route.selectedRecipe()).toBeNull();
    expect(shellHtml(rig.root)).toContain(RECIPES_ROUTE_HEADING_ATTR);

    rig.route.dispose();
  });

  it('keeps the deep-link selection through a transient list failure, then resolves on refresh (codex HIGH 1)', async () => {
    let calls = 0;
    const recipesListCaller = vi.fn<RecipesListCaller>(async () => {
      calls += 1;
      if (calls === 1) throw new Error('network');
      return { recipes: [recipeEntry()] };
    });
    const rig = mountRoute({ initialRecipeId: 'daily-brief', recipesListCaller });
    await rig.route.whenLoaded();

    // The list errored — but a transient failure must NOT discard the valid
    // deep-link (it would permanently rewrite the URL to #recipes).
    expect(rig.route.selectedRecipe()).toBe('daily-brief');

    rig.route.refresh();
    await rig.route.whenLoaded();
    expect(rig.route.selectedRecipe()).toBe('daily-brief');
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_DETAIL_ATTR}="daily-brief"`);

    rig.route.dispose();
  });

  it('openRecipe shows the detail and closeDetail returns to the list', async () => {
    const rig = mountRoute();
    await rig.route.whenLoaded();

    rig.route.openRecipe('daily-brief');
    expect(rig.route.selectedRecipe()).toBe('daily-brief');
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_DETAIL_ATTR}="daily-brief"`);

    rig.route.closeDetail();
    expect(rig.route.selectedRecipe()).toBeNull();
    const list = shellHtml(rig.root);
    expect(list).toContain(RECIPES_ROUTE_HEADING_ATTR);
    expect(list).not.toContain(RECIPES_ROUTE_DETAIL_ATTR);

    rig.route.dispose();
  });

  it('links the detail to Logs and Automation (delta 5 + #automation)', async () => {
    const rig = mountRoute({ initialRecipeId: 'daily-brief' });
    await rig.route.whenLoaded();

    const html = shellHtml(rig.root);
    expect(html).toContain(RECIPES_ROUTE_RUNS_LINK_ATTR);
    // R24 follow-on — the Logs link deep-links the recipe filter, not bare #logs.
    expect(html).toContain('href="#logs/recipe/daily-brief"');
    expect(html).toContain(RECIPES_ROUTE_AUTOMATION_LINK_ATTR);
    expect(html).toContain('href="#automation/daily-brief"');

    rig.route.dispose();
  });

  it('links "Edit in Kitchen" to the recipe editor (Edit→Kitchen)', async () => {
    const rig = mountRoute({ initialRecipeId: 'daily-brief' });
    await rig.route.whenLoaded();

    const html = shellHtml(rig.root);
    // The former disabled "coming soon" placeholder is now a live deep-link
    // into the Kitchen recipe editor loaded on this recipe.
    expect(html).toContain(RECIPES_ROUTE_EDIT_LINK_ATTR);
    expect(html).toContain('href="#kitchen/recipe/daily-brief"');
    expect(html).not.toContain('coming soon');
    expect(html).not.toContain('disabled>Edit in Kitchen');

    rig.route.dispose();
  });

  it('renders installed same-bundle siblings with eligible controls (D-195 P2)', async () => {
    const bundle = 'recued-core/outbound-follow-up-response';
    const bundledRecipe = (
      recipe_id: string,
      name: string,
      withVariable = false,
      withAutoRun = false,
    ) =>
      recipeDefinition(recipe_id, {
        depends_on: ['recued-core.follow-up-pack'],
        metadata: {
          name,
          description: `${name} description`,
          author: 'recued-core',
          supported_platforms: [],
          tags: ['bundle'],
          recipe_bundle: bundle,
        },
        ...(withVariable
          ? { variables: { thread_key: { label: 'Thread key', type: 'text' } } }
          : {}),
        ...(withAutoRun
          ? { auto_run: { interval_ms: 60_000, dynamic: false } }
          : {}),
      });
    const autoRunUpdateCaller = vi.fn(async (args: {
      recipe_id: string;
      enabled?: boolean;
    }) => ({
      entry: {
        recipe_id: args.recipe_id,
        publisher_id: 'recued-core',
        recipe_name: 'Close action',
        interval_ms: 60_000,
        dynamic: false,
        enabled: args.enabled ?? true,
        auto_disabled: false,
        consecutive_failures: 0,
        last_failure_at: null,
        last_failure_reason: null,
        next_run_at: null,
        last_started_at: null,
        last_finished_at: null,
        config_overlay: {},
        variables: {},
      },
    }));
    const rig = mountRoute({
      initialRecipeId: 'review-queue',
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('review-queue', { recipe: bundledRecipe('review-queue', 'Review queue') }),
          recipeEntry('reply-action', { recipe: bundledRecipe('reply-action', 'Reply action', true) }),
          recipeEntry('close-action', {
            recipe: bundledRecipe('close-action', 'Close action', false, true),
          }),
          recipeEntry('unrelated', {
            recipe: recipeDefinition('unrelated', {
              depends_on: ['recued-core.follow-up-pack'],
              metadata: {
                name: 'Unrelated',
                description: 'Outside the lifecycle.',
                author: 'recued-core',
                supported_platforms: [],
                tags: ['bundle'],
                recipe_bundle: 'recued-core/other-flow',
              },
            }),
          }),
        ],
      })),
      schedulesListCaller: vi.fn(async () => ({ schedules: [] })),
      schedulesCreateCaller: vi.fn(async (args) => ({
        schedule: {
          schedule_id: 'schedule-1',
          recipe_id: args.recipe_id,
          publisher_id: args.publisher_id ?? 'recued-core',
          cron_expression: args.cron_expression,
          enabled: true,
          created_at: 1,
          last_run_at: null,
          next_run_at: null,
          last_status: null,
          last_error: null,
        },
      })),
      autoRunListCaller: vi.fn(async () => ({
        entries: [{
          recipe_id: 'close-action',
          publisher_id: 'recued-core',
          recipe_name: 'Close action',
          interval_ms: 60_000,
          dynamic: false,
          enabled: true,
          auto_disabled: false,
          consecutive_failures: 0,
          last_failure_at: null,
          last_failure_reason: null,
          next_run_at: null,
          last_started_at: null,
          last_finished_at: null,
          config_overlay: {},
          variables: {},
        }],
      })),
      autoRunUpdateCaller,
      recipeConfigGetCaller: vi.fn(async () => ({ config_overlay: {} })),
      recipeConfigSetCaller: vi.fn(async () => ({ config_overlay: {} })),
      recipeCatalogCaller: vi.fn(async () => ({
        status: 'ok' as const,
        rows: [
          { recipe_id: 'review-queue', publisher_id: 'recued-core', name: 'Review queue', description: '', type: 'recipe', version: 1, platforms: [], tags: [], download_count: 0, rating_avg: 0, rating_count: 0, created_at: '', depends_on: [], recipe_bundle: bundle },
          { recipe_id: 'reply-action', publisher_id: 'recued-core', name: 'Reply action', description: '', type: 'recipe', version: 1, platforms: [], tags: [], download_count: 0, rating_avg: 0, rating_count: 0, created_at: '', depends_on: [], recipe_bundle: bundle },
          { recipe_id: 'close-action', publisher_id: 'recued-core', name: 'Close action', description: '', type: 'recipe', version: 1, platforms: [], tags: [], download_count: 0, rating_avg: 0, rating_count: 0, created_at: '', depends_on: [], recipe_bundle: bundle },
        ],
      })),
      packCatalogCaller: vi.fn(async () => ({
        status: 'ok' as const,
        rows: [{
          slug: 'outbound-follow-up-response',
          publisher_id: 'recued-core',
          name: 'Outbound Follow-Up Loop',
          description: '',
          version: 1,
          pack_kind: 'app_pack',
          tags: [],
          download_count: 0,
          item_count: 3,
          recipe_refs: [
            { slug: 'review-queue', version: 1 },
            { slug: 'reply-action', version: 1 },
            { slug: 'close-action', version: 1 },
          ],
          created_at: '',
        }],
      })),
    });
    await rig.route.whenLoaded();

    const html = shellHtml(rig.root);
    expect(html).toContain(`${RECIPES_ROUTE_RELATED_ATTR}="${bundle}"`);
    expect(html).not.toContain(`${RECIPES_ROUTE_RELATED_ROW_ATTR}="review-queue"`);
    expect(html).toContain(`${RECIPES_ROUTE_RELATED_ROW_ATTR}="reply-action"`);
    expect(html).toContain(`${RECIPES_ROUTE_RELATED_ROW_ATTR}="close-action"`);
    // Same tags / packs are not enough; only metadata.recipe_bundle groups rows.
    expect(html).not.toContain(`${RECIPES_ROUTE_RELATED_ROW_ATTR}="unrelated"`);
    expect(html).toContain('href="#recipes/reply-action"');
    expect(html).toContain(`${RECIPES_ROUTE_RUN_BUTTON_ATTR}="reply-action"`);
    expect(html).toContain('data-recipe-id="reply-action">Config</button>');
    expect(html).toContain('data-recipe-id="reply-action">Schedule</button>');
    expect(html).toContain('href="#automation/reply-action"');
    expect(html).toContain('href="#logs/recipe/reply-action"');
    expect(html).toContain('auto-run');
    expect(html).toContain('data-recued-recipes-action="toggle-auto-run:off"');
    expect(html).toContain('data-recipe-id="close-action">Pause auto-run</button>');
    expect(html).toContain('data-recued-recipes-bundle-pack="outbound-follow-up-response"');
    expect(html).toContain('href="#packs/outbound-follow-up-response"');
    expect(html).toContain('View workflow pack');
    const reactiveRow = html.match(
      /<li data-recued-recipes-related-row="close-action">[\s\S]*?<\/li>/,
    )?.[0] ?? '';
    expect(reactiveRow).not.toContain('data-recued-recipes-action="open-run"');
    expect(reactiveRow).not.toContain('data-recued-recipes-action="open-schedule"');
    expect(reactiveRow).toContain('href="#automation/close-action"');
    expect(reactiveRow).toContain('href="#logs/recipe/close-action"');
    clickRecipeAction(rig.root, 'toggle-auto-run:off', 'close-action');
    expect(autoRunUpdateCaller).toHaveBeenCalledWith({
      recipe_id: 'close-action',
      enabled: false,
    });

    rig.route.dispose();
  });

  it('offers the directly named pack when only part of a recipe_bundle is installed', async () => {
    const bundle = 'recued-core/task-closure';
    const selected = recipeDefinition('create-task', {
      metadata: {
        name: 'Create task',
        description: '',
        author: 'recued-core',
        supported_platforms: [],
        recipe_bundle: bundle,
      },
    });
    const catalogRow = (recipe_id: string, name: string) => ({
      recipe_id,
      publisher_id: 'recued-core',
      name,
      description: '',
      type: 'recipe',
      version: 1,
      platforms: [] as string[],
      tags: [] as string[],
      download_count: 0,
      rating_avg: 0,
      rating_count: 0,
      created_at: '',
      depends_on: [] as string[],
      recipe_bundle: bundle,
    });
    const rig = mountRoute({
      initialRecipeId: 'create-task',
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [recipeEntry('create-task', { recipe: selected })],
      })),
      recipeCatalogCaller: async () => ({
        status: 'ok',
        rows: [
          catalogRow('create-task', 'Create task'),
          catalogRow('watch-task', 'Watch task'),
          catalogRow('review-task', 'Review task'),
        ],
      }),
      packCatalogCaller: async () => ({
        status: 'ok',
        rows: [{
          slug: 'task-closure',
          publisher_id: 'recued-core',
          name: 'Task Closure Loop',
          description: '',
          version: 1,
          pack_kind: 'app_pack',
          tags: [],
          download_count: 0,
          item_count: 4,
          recipe_refs: [
            { slug: 'create-task', version: 1 },
            { slug: 'watch-task', version: 1 },
            { slug: 'review-task', version: 1 },
            { slug: 'pack-extra', version: 1 },
          ],
          created_at: '',
        }],
      }),
    });
    await rig.route.whenLoaded();

    const html = shellHtml(rig.root);
    expect(html).toContain(`${RECIPES_ROUTE_RELATED_ATTR}="${bundle}"`);
    expect(html).toContain('data-recued-recipes-bundle-pack="task-closure"');
    expect(html).toContain('Install complete workflow (4)');
    // The section exists for installation even though no sibling is installed.
    expect(html).not.toContain(RECIPES_ROUTE_RELATED_ROW_ATTR);

    rig.route.dispose();
  });

  it('loads bundle catalogs lazily when an installed recipe detail opens', async () => {
    const bundle = 'recued-core/task-closure';
    const selected = recipeDefinition('create-task', {
      metadata: {
        name: 'Create task',
        description: '',
        author: 'recued-core',
        supported_platforms: [],
        recipe_bundle: bundle,
      },
    });
    const recipeCatalogCaller = vi.fn(async () => ({
      status: 'ok' as const,
      rows: ['create-task', 'watch-task'].map((recipe_id) => ({
        recipe_id,
        publisher_id: 'recued-core',
        name: recipe_id,
        description: '',
        type: 'recipe',
        version: 1,
        platforms: [],
        tags: [],
        download_count: 0,
        rating_avg: 0,
        rating_count: 0,
        created_at: '',
        depends_on: [],
        recipe_bundle: bundle,
      })),
    }));
    const packCatalogCaller = vi.fn(async () => ({
      status: 'ok' as const,
      rows: [{
        slug: 'task-closure',
        publisher_id: 'recued-core',
        name: 'Task Closure Loop',
        description: '',
        version: 1,
        pack_kind: 'app_pack',
        tags: [],
        download_count: 0,
        item_count: 2,
        recipe_refs: [
          { slug: 'create-task', version: 1 },
          { slug: 'watch-task', version: 1 },
        ],
        created_at: '',
      }],
    }));
    const rig = mountRoute({
      recipesListCaller: async () => ({
        recipes: [recipeEntry('create-task', { recipe: selected })],
      }),
      recipeCatalogCaller,
      packCatalogCaller,
    });
    await rig.route.whenLoaded();
    expect(recipeCatalogCaller).not.toHaveBeenCalled();
    expect(packCatalogCaller).not.toHaveBeenCalled();

    rig.route.openRecipe('create-task');
    await vi.waitFor(() => {
      expect(shellHtml(rig.root)).toContain(
        'data-recued-recipes-bundle-pack="task-closure"',
      );
    });
    expect(recipeCatalogCaller).toHaveBeenCalledTimes(1);
    expect(packCatalogCaller).toHaveBeenCalledTimes(1);

    rig.route.dispose();
  });

  it('does not render a related-recipes panel for unbundled recipes', async () => {
    const rig = mountRoute({ initialRecipeId: 'daily-brief' });
    await rig.route.whenLoaded();

    expect(shellHtml(rig.root)).not.toContain(RECIPES_ROUTE_RELATED_ATTR);

    rig.route.dispose();
  });
});

describe('R24 — Recipes route: exposure is per-contract, no toggle', () => {
  it('the detail has NO exposure toggle and points to Contracts', async () => {
    const rig = mountRoute({ initialRecipeId: 'daily-brief' });
    await rig.route.whenLoaded();

    const html = shellHtml(rig.root);
    // The "Exposed as a tool" section is now a read-only pointer — no toggle
    // control, no per-recipe chat_exposed flag surfaced here.
    expect(html).toContain('Exposed as a tool');
    expect(html).toContain('granted per contract');
    expect(html).toContain('href="#contracts"');
    expect(html).not.toContain('toggle-chat-exposed');
    expect(html).not.toContain('set on the server');
    // The dishonest global "in the live catalog" claim is gone from Depends-on.
    expect(html).not.toContain('is in the live catalog');
    expect(html).not.toContain('No MCP-exposed recipe tool');

    rig.route.dispose();
  });
});

describe('R24 — Recipes route: run + schedule modal', () => {
  it('runs a recipe through the modal caller with parsed config', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async () =>
      executeResponse({
        output: {
          render: [
            {
              type: 'summary',
              data: { fields: [{ label: 'Deal', value: 'Acme' }] },
            },
            {
              type: 'table',
              data: {
                columns: [
                  { field: 'stage', label: 'Stage' },
                  { field: 'amount', label: 'Amount', format: 'currency' },
                  { field: 'confidence', label: 'Confidence', format: 'percent' },
                ],
                rows: [{ stage: 'Negotiation', amount: 1_500, confidence: 0.825 }],
              },
            },
            {
              type: 'checklist',
              data: {
                title: 'Review',
                items: [{ label: 'Ready', status: 'ok', detail: 'Owner can proceed' }],
              },
            },
            { type: 'copyable', label: 'Draft', data: 'copy this value' },
            // Raw step detail. Its whole reason for existing is that
            // `output.render` is the ONLY channel a run's data reaches a reader
            // through — so if this panel cannot render it, the detail is
            // unreachable everywhere.
            {
              type: 'json',
              label: 'Previous Inventory',
              data: { sku: 'A-1', stock: 4 },
            },
            {
              type: 'ai_analysis',
              data: {
                summary: 'AI says proceed',
                confidence: 0.82,
                key_points: ['Owner confirmed'],
              },
            },
            { type: 'button', data: [{ kind: 'recipe.run', label: 'Escalate', recipe_id: 'escalate' }] },
          ],
          sidebar: [{ type: 'text', data: 'legacy stale output' }],
        } as unknown as ServerExecuteResponse['output'],
      }));
    const rig = mountRoute({ recipeExecuteCaller: execute });
    await rig.route.whenLoaded();

    rig.route.openRecipe('daily-brief');
    rig.route.openRunModal('daily-brief');
    rig.route.setRunConfigText('{"topic":"pipeline"}');
    await rig.route.confirmRun();

    expect(execute).toHaveBeenCalledWith({
      recipe_id: 'daily-brief',
      config: { topic: 'pipeline' },
    });
    expect(rig.route.runModal()?.result?.success).toBe(true);
    expect(runModalHtml(rig.root)).toContain('Run completed');
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('daily-brief');
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_RESULT_PANEL_ATTR}="daily-brief"`);
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_RESULT_SECTION_ATTR}="summary"`);
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_RESULT_SECTION_ATTR}="table"`);
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_RESULT_SECTION_ATTR}="checklist"`);
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_RESULT_SECTION_ATTR}="copyable"`);
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_RESULT_SECTION_ATTR}="json"`);
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_RESULT_SECTION_ATTR}="ai_analysis"`);
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_RESULT_SECTION_ATTR}="button"`);
    expect(shellHtml(rig.root)).toContain('Acme');
    expect(shellHtml(rig.root)).toContain('Negotiation');
    expect(shellHtml(rig.root)).toContain('$1.5K');
    expect(shellHtml(rig.root)).toContain('82.5%');
    expect(shellHtml(rig.root)).toContain('Owner can proceed');
    expect(shellHtml(rig.root)).toContain('copy this value');
    // The json block: titled by its authored label, pretty-printed behind a
    // native <details> (no script — the same block reception serves under
    // `script-src 'none'`), and NOT the unsupported-kind fallback.
    expect(shellHtml(rig.root)).toContain('Previous Inventory');
    expect(shellHtml(rig.root)).toContain('&quot;stock&quot;: 4');
    expect(shellHtml(rig.root)).toContain('<details');
    expect(shellHtml(rig.root)).not.toContain('Unsupported output section type');
    expect(shellHtml(rig.root)).toContain('class="copy-btn"');
    expect(shellHtml(rig.root)).toContain('data-action="copy"');
    expect(shellHtml(rig.root)).toContain('AI says proceed');
    expect(shellHtml(rig.root)).toContain('class="ai-summary"');
    expect(shellHtml(rig.root)).toContain('82%');
    expect(shellHtml(rig.root)).toContain('Owner confirmed');
    expect(shellHtml(rig.root)).toContain('Escalate');
    expect(shellHtml(rig.root)).toContain('Recipe &quot;escalate&quot; is not installed.');
    expect(shellHtml(rig.root)).not.toContain('legacy stale output');
    expect(shellHtml(rig.root)).toContain('role="status" aria-live="polite"');
    expect(rig.route.resultPanel()).toMatchObject({
      route_recipe_id: 'daily-brief',
      source_recipe_id: 'daily-brief',
      render_recipe_id: 'daily-brief',
      origin: 'recipe-detail',
    });
    expect(shellHtml(rig.root)).toContain(
      `${RECIPES_ROUTE_RESULT_PROVENANCE_ATTR}="recipe-detail"`,
    );
    rig.route.closeRunModal();
    expect(runModalHtml(rig.root)).toBe('');
    expect(shellHtml(rig.root)).toContain('Acme');

    rig.route.dispose();
  });

  it('copies copyable output through the browser clipboard affordance (D-195 P3)', async () => {
    const clipboardWrite = vi.fn(async (_value: string) => {});
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      clipboardWrite,
      recipeExecuteCaller: vi.fn<RecipeExecuteCaller>(async () =>
        executeResponse({
          output: {
            render: [{ type: 'copyable', label: 'Draft', data: 'copy this value' }],
          } as unknown as ServerExecuteResponse['output'],
        })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();
    clickRecipeAction(rig.root, 'copy', '', { 'data-value': 'copy this value' });

    await vi.waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalledWith('copy this value');
    });

    rig.route.dispose();
  });

  it('renders unsupported result sections without dropping adjacent output (D-195 P3)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async () =>
      executeResponse({
        output: {
          render: [
            { type: 'text', data: 'known result survives' },
            {
              type: 'future_widget',
              data: { value: 'future payload' },
            },
          ],
        } as unknown as ServerExecuteResponse['output'],
      }));
    const rig = mountRoute({ initialRecipeId: 'daily-brief', recipeExecuteCaller: execute });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();

    const html = shellHtml(rig.root);
    expect(html).toContain(`${RECIPES_ROUTE_RESULT_SECTION_ATTR}="text"`);
    expect(html).toContain(`${RECIPES_ROUTE_RESULT_SECTION_ATTR}="future_widget"`);
    expect(html).toContain('known result survives');
    expect(html).toContain('Unsupported output: future_widget');
    expect(html).toContain('Unsupported output section type: future_widget');
    expect(html).toContain('future payload');

    rig.route.dispose();
  });

  it('renders held runs as awaiting approval without result output (D-195 P3)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async () =>
      executeResponse({
        success: false,
        output: {
          render: [{ type: 'text', data: 'held output must not render' }],
          sidebar: [],
        },
        awaiting_approval: true,
      }));
    const rig = mountRoute({ initialRecipeId: 'daily-brief', recipeExecuteCaller: execute });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();

    expect(shellHtml(rig.root)).toContain('Awaiting approval');
    expect(shellHtml(rig.root)).toContain('role="status" aria-live="polite"');
    expect(shellHtml(rig.root)).toContain('held for approval');
    expect(shellHtml(rig.root)).not.toContain(RECIPES_ROUTE_RESULT_SECTION_ATTR);
    expect(shellHtml(rig.root)).not.toContain('held output must not render');

    rig.route.dispose();
  });

  it('announces a terminated run and keeps returned output non-actionable (D-195 P3)', async () => {
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeExecuteCaller: vi.fn<RecipeExecuteCaller>(async () =>
        executeResponse({
          success: false,
          run_terminated: 'killed',
          awaiting_approval: true,
          output: {
            render: [{ type: 'button', data: {
              kind: 'recipe.run',
              label: 'Must not run',
              recipe_id: 'reply-action',
            } }],
          } as unknown as ServerExecuteResponse['output'],
        })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();

    const html = shellHtml(rig.root);
    expect(html).toContain('Run terminated');
    expect(html).not.toContain('Awaiting approval');
    expect(html).not.toContain('held for approval');
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).not.toContain(RECIPES_ROUTE_RESULT_SECTION_ATTR);
    expect(html).not.toContain('Must not run');

    rig.route.dispose();
  });

  it('fails closed for unknown or missing checklist statuses (D-195 P4)', async () => {
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeExecuteCaller: vi.fn<RecipeExecuteCaller>(async () =>
        executeResponse({
          output: {
            render: [{
              type: 'checklist',
              data: {
                items: [
                  { label: 'Known good', status: 'ok' },
                  { label: 'Still pending', status: 'pending' },
                  { label: 'Missing status' },
                ],
              },
            }],
          } as unknown as ServerExecuteResponse['output'],
        })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();

    const html = shellHtml(rig.root);
    expect(html).toContain('<strong>OK:</strong>');
    expect(html.match(/<strong>Unknown:<\/strong>/g)).toHaveLength(2);
    expect(html).not.toContain('<strong>OK:</strong>\n            <span>Still pending</span>');
    expect(html).not.toContain('<strong>OK:</strong>\n            <span>Missing status</span>');

    rig.route.dispose();
  });

  it('renders result output when awaiting approval is explicitly false (D-195 P3 audit)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async () =>
      executeResponse({
        output: {
          render: [{ type: 'text', data: 'visible result' }],
          sidebar: [],
        },
        awaiting_approval: false,
      }));
    const rig = mountRoute({ initialRecipeId: 'daily-brief', recipeExecuteCaller: execute });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();

    expect(shellHtml(rig.root)).toContain('Run completed');
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_RESULT_SECTION_ATTR}="text"`);
    expect(shellHtml(rig.root)).toContain('visible result');
    expect(shellHtml(rig.root)).not.toContain('Awaiting approval');
    expect(shellHtml(rig.root)).not.toContain('held for approval');

    rig.route.dispose();
  });

  it('replaces same-recipe current-session results instead of appending history (D-195 P3)', async () => {
    let runCount = 0;
    const execute = vi.fn<RecipeExecuteCaller>(async () => {
      runCount += 1;
      return executeResponse({
        output: {
          render: [{ type: 'text', data: `current result ${runCount}` }],
        } as unknown as ServerExecuteResponse['output'],
      });
    });
    const rig = mountRoute({ initialRecipeId: 'daily-brief', recipeExecuteCaller: execute });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('daily-brief');
    expect(shellHtml(rig.root)).toContain('current result 1');

    rig.route.closeRunModal();
    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();

    const html = shellHtml(rig.root);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(rig.route.resultPanel()?.route_recipe_id).toBe('daily-brief');
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('daily-brief');
    expect(html).toContain('current result 2');
    expect(html).not.toContain('current result 1');

    rig.route.dispose();
  });

  it('does not paint a modal result into a different detail after navigation (D-195 P3 audit)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async (args) =>
      executeResponse({
        recipe_id: args.recipe_id,
        recipe_hash: `hash-${args.recipe_id}`,
        output: {
          render: [{ type: 'text', data: `result for ${args.recipe_id}` }],
        } as unknown as ServerExecuteResponse['output'],
      }));
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('daily-brief'),
          recipeEntry('other-recipe', {
            recipe: recipeDefinition('other-recipe', {
              metadata: {
                name: 'Other recipe',
                description: 'Different detail.',
                author: 'recued-core',
                supported_platforms: [],
                tags: [],
              },
            }),
          }),
        ],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    rig.route.openRecipe('other-recipe');
    await rig.route.confirmRun();

    expect(execute).toHaveBeenCalledWith({ recipe_id: 'daily-brief', config: {} });
    expect(rig.route.selectedRecipe()).toBe('other-recipe');
    expect(rig.route.resultPanel()).toBeNull();
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_DETAIL_ATTR}="other-recipe"`);
    expect(shellHtml(rig.root)).not.toContain('result for daily-brief');

    rig.route.dispose();
  });

  it('falls back to legacy output.sidebar when output.render is absent (D-195 P3)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async () =>
      executeResponse({
        output: {
          sidebar: [{ type: 'text', data: 'legacy sidebar result' }],
        } as unknown as ServerExecuteResponse['output'],
      }));
    const rig = mountRoute({ initialRecipeId: 'daily-brief', recipeExecuteCaller: execute });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();

    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_RESULT_SECTION_ATTR}="text"`);
    expect(shellHtml(rig.root)).toContain('legacy sidebar result');

    rig.route.dispose();
  });

  it('renders a related-recipe run result in the current detail without navigating (D-195 P3)', async () => {
    const bundle = 'recued-core/outbound-follow-up-response';
    const bundledRecipe = (recipe_id: string, name: string) =>
      recipeDefinition(recipe_id, {
        metadata: {
          name,
          description: `${name} description`,
          author: 'recued-core',
          supported_platforms: [],
          tags: ['bundle'],
          recipe_bundle: bundle,
        },
      });
    const execute = vi.fn<RecipeExecuteCaller>(async (args) =>
      executeResponse({
        recipe_id: args.recipe_id,
        recipe_hash: `hash-${args.recipe_id}`,
        output: {
          render: [{ type: 'text', data: `result for ${args.recipe_id}` }],
        } as unknown as ServerExecuteResponse['output'],
      }));
    const rig = mountRoute({
      initialRecipeId: 'review-queue',
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('review-queue', { recipe: bundledRecipe('review-queue', 'Review queue') }),
          recipeEntry('reply-action', { recipe: bundledRecipe('reply-action', 'Reply action') }),
        ],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('review-queue');
    await rig.route.confirmRun();
    rig.route.closeRunModal();
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('review-queue');

    clickRecipeAction(rig.root, 'open-run', 'reply-action');
    await rig.route.confirmRun();

    expect(rig.route.selectedRecipe()).toBe('review-queue');
    expect(execute).toHaveBeenLastCalledWith({ recipe_id: 'reply-action', config: {} });
    expect(rig.route.resultPanel()?.route_recipe_id).toBe('review-queue');
    expect(rig.route.resultPanel()?.source_recipe_id).toBeNull();
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('reply-action');
    expect(rig.route.resultPanel()?.origin).toBe('related-recipes');
    expect(rig.route.resultPanel()?.previous?.render_recipe_id).toBe('review-queue');
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_DETAIL_ATTR}="review-queue"`);
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_RESULT_PANEL_ATTR}="reply-action"`);
    expect(shellHtml(rig.root)).toContain(
      `${RECIPES_ROUTE_RESULT_PROVENANCE_ATTR}="related-recipes"`,
    );
    expect(shellHtml(rig.root)).toContain('Source recipe:</strong> None');
    expect(shellHtml(rig.root)).toContain('Return to Review queue result');
    expect(shellHtml(rig.root)).toContain('result for reply-action');

    rig.route.dispose();
  });

  it('opens result action runs with prefilled config and context (D-195 P4)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async (args) => {
      if (args.recipe_id === 'review-queue') {
        return executeResponse({
          recipe_id: 'review-queue',
          recipe_hash: 'hash-review-queue',
          output: {
            render: [{
              type: 'button',
              data: {
                kind: 'recipe.run',
                label: 'Draft reply',
                recipe_id: 'reply-action',
                variant: 'primary',
                config: { tone: 'warm' },
                context: {
                  entity_id: 42,
                  review: { mode: 'draft', recipients: ['owner', 'legal'] },
                  notify: true,
                },
              },
            }],
          } as unknown as ServerExecuteResponse['output'],
        });
      }
      return executeResponse({
        recipe_id: args.recipe_id,
        recipe_hash: `hash-${args.recipe_id}`,
        output: {
          render: [{ type: 'text', data: `result for ${args.recipe_id}` }],
        } as unknown as ServerExecuteResponse['output'],
      });
    });
    const rig = mountRoute({
      initialRecipeId: 'review-queue',
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('review-queue'),
          recipeEntry('reply-action', {
            recipe: recipeDefinition('reply-action', {
              metadata: {
                name: 'Reply action',
                description: 'Draft a reply.',
                author: 'recued-core',
                supported_platforms: [],
                tags: [],
              },
              output: {
                sidebar: [{ type: 'text', source: '{{context.entity_id}}' }],
              },
            }),
          }),
        ],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('review-queue');
    await rig.route.confirmRun();
    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-0"`);
    rig.route.closeRunModal();

    clickRecipeAction(rig.root, 'run-result-action', '', {
      [RECIPES_ROUTE_RESULT_ACTION_ATTR]: 'result-action-0',
    });

    expect(rig.route.selectedRecipe()).toBe('review-queue');
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('review-queue');
    expect(rig.route.runModal()?.recipe_id).toBe('reply-action');
    expect(rig.route.runModal()?.config_text).toContain('"tone": "warm"');
    expect(rig.route.runModal()?.target_values).toEqual({});
    expect(rig.route.runModal()?.context_values).toEqual({
      entity_id: 42,
      review: { mode: 'draft', recipients: ['owner', 'legal'] },
      notify: true,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runModalHtml(rig.root)).toContain(`${RunModal.RUN_MODAL_OVERLAY_ATTR}="reply-action"`);
    expect(runModalHtml(rig.root)).toContain('Reply action');
    expect(runModalHtml(rig.root)).toContain('&quot;tone&quot;: &quot;warm&quot;');
    expect(runModalHtml(rig.root)).toContain('Target — entity_id');
    expect(runModalHtml(rig.root)).toContain('Context JSON (prefilled)');
    expect(runModalHtml(rig.root)).toContain('&quot;entity_id&quot;: 42');
    expect(runModalHtml(rig.root)).toContain('&quot;mode&quot;: &quot;draft&quot;');
    expect(runModalHtml(rig.root)).toContain('Target recipe: <code>reply-action</code>');
    expect(runModalHtml(rig.root)).toContain('Publisher: <code>recued-core</code>');

    await rig.route.confirmRun();

    expect(execute).toHaveBeenLastCalledWith({
      recipe_id: 'reply-action',
      config: { tone: 'warm' },
      context: {
        entity_id: 42,
        review: { mode: 'draft', recipients: ['owner', 'legal'] },
        notify: true,
      },
    });
    expect(rig.route.selectedRecipe()).toBe('review-queue');
    expect(rig.route.resultPanel()?.route_recipe_id).toBe('review-queue');
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('reply-action');
    expect(rig.route.resultPanel()?.source_recipe_id).toBe('review-queue');
    expect(rig.route.resultPanel()?.origin).toBe('result-action');
    expect(shellHtml(rig.root)).toContain(
      `${RECIPES_ROUTE_RESULT_PROVENANCE_ATTR}="result-action"`,
    );
    expect(shellHtml(rig.root)).toContain('result for reply-action');

    rig.route.dispose();
  });

  it('can return from a child result to the source result panel (D-195 P3)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async (args) => {
      if (args.recipe_id === 'review-queue') {
        return executeResponse({
          recipe_id: 'review-queue',
          recipe_hash: 'hash-review-queue',
          output: {
            render: [
              { type: 'text', data: 'source review result' },
              {
                type: 'button',
                data: {
                  kind: 'recipe.run',
                  label: 'Draft reply',
                  recipe_id: 'reply-action',
                  context: { entity_id: 'deal-42' },
                },
              },
            ],
          } as unknown as ServerExecuteResponse['output'],
        });
      }
      return executeResponse({
        recipe_id: args.recipe_id,
        recipe_hash: `hash-${args.recipe_id}`,
        output: {
          render: [{ type: 'text', data: `child result for ${args.recipe_id}` }],
        } as unknown as ServerExecuteResponse['output'],
      });
    });
    const rig = mountRoute({
      initialRecipeId: 'review-queue',
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('review-queue', {
            recipe: recipeDefinition('review-queue', {
              metadata: {
                name: 'Review queue',
                description: 'Review source results.',
                author: 'recued-core',
                supported_platforms: [],
                tags: [],
              },
            }),
          }),
          targetRecipeWithEntityContext('reply-action', 'Reply action'),
        ],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('review-queue');
    await rig.route.confirmRun();
    rig.route.closeRunModal();

    expect(rig.route.resultPanel()?.render_recipe_id).toBe('review-queue');
    expect(shellHtml(rig.root)).toContain('source review result');

    clickRecipeAction(rig.root, 'run-result-action', '', {
      [RECIPES_ROUTE_RESULT_ACTION_ATTR]: 'result-action-0',
    });

    expect(rig.route.runModal()?.recipe_id).toBe('reply-action');
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('review-queue');
    expect(shellHtml(rig.root)).toContain('source review result');

    await rig.route.confirmRun();

    let html = shellHtml(rig.root);
    expect(rig.route.selectedRecipe()).toBe('review-queue');
    expect(rig.route.resultPanel()?.route_recipe_id).toBe('review-queue');
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('reply-action');
    expect(rig.route.resultPanel()?.source_recipe_id).toBe('review-queue');
    expect(rig.route.resultPanel()?.origin).toBe('result-action');
    expect(rig.route.resultPanel()?.previous?.render_recipe_id).toBe('review-queue');
    expect(html).toContain('child result for reply-action');
    expect(html).not.toContain('source review result');
    expect(html).toContain(`${RECIPES_ROUTE_RESULT_RETURN_ATTR}="review-queue"`);
    expect(html).toContain('Return to Review queue result');

    clickRecipeAction(rig.root, 'restore-result-panel', '', {
      [RECIPES_ROUTE_RESULT_RETURN_ATTR]: 'review-queue',
    });

    html = shellHtml(rig.root);
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('review-queue');
    expect(rig.route.resultPanel()?.previous).toBeUndefined();
    expect(html).toContain('source review result');
    expect(html).not.toContain('child result for reply-action');
    expect(html).not.toContain(RECIPES_ROUTE_RESULT_RETURN_ATTR);

    rig.route.closeRunModal();
    clickRecipeAction(rig.root, 'run-result-action', '', {
      [RECIPES_ROUTE_RESULT_ACTION_ATTR]: 'result-action-0',
    });
    await rig.route.confirmRun();
    rig.route.closeRunModal();

    expect(rig.route.resultPanel()?.render_recipe_id).toBe('reply-action');
    expect(rig.route.resultPanel()?.previous?.render_recipe_id).toBe('review-queue');

    rig.route.openRunModal('review-queue');
    await rig.route.confirmRun();

    html = shellHtml(rig.root);
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('review-queue');
    expect(rig.route.resultPanel()?.previous).toBeUndefined();
    expect(html).toContain('source review result');
    expect(html).not.toContain('child result for reply-action');
    expect(html).not.toContain(RECIPES_ROUTE_RESULT_RETURN_ATTR);

    rig.route.dispose();
  });

  it('keeps a navigable result stack across nested result actions (D-195 P3)', async () => {
    const namedRecipe = (recipe_id: string, name: string) =>
      recipeEntry(recipe_id, {
        recipe: recipeDefinition(recipe_id, {
          metadata: {
            name,
            description: `${name} description`,
            author: 'recued-core',
            supported_platforms: [],
            tags: [],
          },
        }),
      });
    const execute = vi.fn<RecipeExecuteCaller>(async (args) => {
      const next = args.recipe_id === 'review-queue'
        ? { label: 'Open reply', recipe_id: 'reply-action' }
        : args.recipe_id === 'reply-action'
          ? { label: 'Close watch', recipe_id: 'close-action' }
          : null;
      return executeResponse({
        recipe_id: args.recipe_id,
        recipe_hash: `hash-${args.recipe_id}`,
        output: {
          render: [
            { type: 'text', data: `result for ${args.recipe_id}` },
            ...(next === null
              ? []
              : [{ type: 'button', data: { kind: 'recipe.run', ...next } }]),
          ],
        } as unknown as ServerExecuteResponse['output'],
      });
    });
    const rig = mountRoute({
      initialRecipeId: 'review-queue',
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          namedRecipe('review-queue', 'Review queue'),
          namedRecipe('reply-action', 'Reply action'),
          namedRecipe('close-action', 'Close action'),
        ],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('review-queue');
    await rig.route.confirmRun();
    rig.route.closeRunModal();
    clickRecipeAction(rig.root, 'run-result-action', '', {
      [RECIPES_ROUTE_RESULT_ACTION_ATTR]: 'result-action-0',
    });
    await rig.route.confirmRun();
    rig.route.closeRunModal();
    clickRecipeAction(rig.root, 'run-result-action', '', {
      [RECIPES_ROUTE_RESULT_ACTION_ATTR]: 'result-action-0',
    });
    await rig.route.confirmRun();

    expect(rig.route.resultPanel()).toMatchObject({
      render_recipe_id: 'close-action',
      source_recipe_id: 'reply-action',
      origin: 'result-action',
      previous: {
        render_recipe_id: 'reply-action',
        source_recipe_id: 'review-queue',
        previous: { render_recipe_id: 'review-queue' },
      },
    });
    expect(shellHtml(rig.root)).toContain('Return to Reply action result');

    clickRecipeAction(rig.root, 'restore-result-panel', '', {
      [RECIPES_ROUTE_RESULT_RETURN_ATTR]: 'reply-action',
    });
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('reply-action');
    expect(rig.route.resultPanel()?.previous?.render_recipe_id).toBe('review-queue');
    expect(shellHtml(rig.root)).toContain('Return to Review queue result');

    clickRecipeAction(rig.root, 'restore-result-panel', '', {
      [RECIPES_ROUTE_RESULT_RETURN_ATTR]: 'review-queue',
    });
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('review-queue');
    expect(rig.route.resultPanel()?.previous).toBeUndefined();
    expect(shellHtml(rig.root)).not.toContain(RECIPES_ROUTE_RESULT_RETURN_ATTR);

    rig.route.dispose();
  });

  it('replaces an older same-recipe snapshot when result actions cycle A to B to A', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async (args) => {
      const target = args.recipe_id === 'review-queue' ? 'reply-action' : 'review-queue';
      return executeResponse({
        recipe_id: args.recipe_id,
        recipe_hash: `hash-${args.recipe_id}`,
        output: {
          render: [
            { type: 'text', data: `fresh result for ${args.recipe_id}` },
            {
              type: 'button',
              data: {
                kind: 'recipe.run',
                label: `Run ${target}`,
                recipe_id: target,
              },
            },
          ],
        } as unknown as ServerExecuteResponse['output'],
      });
    });
    const rig = mountRoute({
      initialRecipeId: 'review-queue',
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('review-queue'),
          recipeEntry('reply-action', {
            recipe: recipeDefinition('reply-action', {
              metadata: {
                name: 'Reply action',
                description: 'Cycles back to the source recipe.',
                author: 'recued-core',
                supported_platforms: [],
                tags: [],
              },
            }),
          }),
        ],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('review-queue');
    await rig.route.confirmRun();
    rig.route.closeRunModal();
    clickRecipeAction(rig.root, 'run-result-action', '', {
      [RECIPES_ROUTE_RESULT_ACTION_ATTR]: 'result-action-0',
    });
    await rig.route.confirmRun();
    rig.route.closeRunModal();
    clickRecipeAction(rig.root, 'run-result-action', '', {
      [RECIPES_ROUTE_RESULT_ACTION_ATTR]: 'result-action-0',
    });
    await rig.route.confirmRun();

    expect(rig.route.resultPanel()).toMatchObject({
      render_recipe_id: 'review-queue',
      previous: { render_recipe_id: 'reply-action' },
    });
    expect(rig.route.resultPanel()?.previous?.previous).toBeUndefined();

    clickRecipeAction(rig.root, 'restore-result-panel', '', {
      [RECIPES_ROUTE_RESULT_RETURN_ATTR]: 'reply-action',
    });
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('reply-action');
    expect(rig.route.resultPanel()?.previous).toBeUndefined();

    rig.route.dispose();
  });

  it('honors result action confirmation before opening the target run (D-195 P4)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async (args) => {
      if (args.recipe_id === 'daily-brief') {
        return executeResponse({
          output: {
            render: [{
              type: 'button',
              data: {
                kind: 'recipe.run',
                label: 'Close watch',
                recipe_id: 'close-action',
                confirm: 'Close this watch?',
                config: { status: 'closed' },
                context: { entity_id: 'deal-42' },
              },
            }],
          } as unknown as ServerExecuteResponse['output'],
        });
      }
      return executeResponse({
        recipe_id: args.recipe_id,
        recipe_hash: `hash-${args.recipe_id}`,
        output: {
          render: [{ type: 'text', data: `result for ${args.recipe_id}` }],
        } as unknown as ServerExecuteResponse['output'],
      });
    });
    const confirm = vi.fn<(message?: string) => boolean>()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeExecuteCaller: execute,
      confirm,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('daily-brief'),
          targetRecipeWithEntityContext('close-action', 'Close action'),
        ],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();
    rig.route.closeRunModal();

    expect(shellHtml(rig.root)).toContain(`${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-0"`);

    clickRecipeAction(rig.root, 'run-result-action', '', {
      [RECIPES_ROUTE_RESULT_ACTION_ATTR]: 'result-action-0',
    });

    expect(confirm).toHaveBeenNthCalledWith(1, 'Close this watch?');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(rig.route.runModal()).toBeNull();
    expect(runModalHtml(rig.root)).toBe('');
    expect(execute).toHaveBeenCalledTimes(1);

    clickRecipeAction(rig.root, 'run-result-action', '', {
      [RECIPES_ROUTE_RESULT_ACTION_ATTR]: 'result-action-0',
    });

    expect(confirm).toHaveBeenNthCalledWith(2, 'Close this watch?');
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(rig.route.runModal()?.recipe_id).toBe('close-action');
    expect(rig.route.runModal()?.config_text).toContain('"status": "closed"');
    expect(rig.route.runModal()?.target_values).toEqual({});
    expect(rig.route.runModal()?.context_values).toEqual({ entity_id: 'deal-42' });
    expect(execute).toHaveBeenCalledTimes(1);

    await rig.route.confirmRun();

    expect(execute).toHaveBeenLastCalledWith({
      recipe_id: 'close-action',
      config: { status: 'closed' },
      context: { entity_id: 'deal-42' },
    });
    expect(shellHtml(rig.root)).toContain('result for close-action');

    rig.route.dispose();
  });

  it('renders an exact file card, authenticated download, and hash-pinned approval action (D-200)', async () => {
    const sha256 = 'a'.repeat(64);
    const fileReadCaller = vi.fn<RecipeFileReadCaller>(async ({ record_id }) => ({
      record_id,
      bytes_b64: 'JVBERi0xLjQK',
      mime_type: 'application/pdf',
      filename: 'document.pdf',
      size_bytes: 9,
      blob_hash: sha256,
    }));
    const execute = vi.fn<RecipeExecuteCaller>(async () => executeResponse({
      output: {
        render: [{
          type: 'file_artifact',
          label: 'Artifacts ready for exact review',
          data: [{
            title: 'Paid document for response submission-1',
            record_id: 'file:abcdef0123456789abcdef0123456789',
            filename: 'document.pdf',
            mime_type: 'application/pdf',
            size_bytes: 9,
            sha256,
            generated_at: Date.UTC(2026, 6, 11, 12, 0, 0),
            generation_mode: 'static',
            origin: { submission_id: 'submission-1', task_id: 'task-1' },
            payment: {
              amount_minor: 7_500,
              currency: 'usd',
              status: 'paid',
              verified_at: Date.UTC(2026, 6, 11, 11, 55, 0),
            },
            template: {
              filename: 'template.md',
              sha256: 'b'.repeat(64),
              format: 'markdown',
            },
            approval_action: {
              kind: 'recipe.run',
              label: 'Approve and send exact PDF',
              recipe_id: 'approve-deliver-paid-document',
              config: {
                submission_id: 'submission-1',
                reviewed_artifact_sha256: sha256,
              },
              variant: 'primary',
            },
            decision_actions: [{
              kind: 'recipe.run',
              label: 'Regenerate exact PDF',
              recipe_id: 'generate-paid-document',
              config: {
                submission_id: 'submission-1',
                reviewed_artifact_sha256: sha256,
              },
            }, {
              kind: 'recipe.run',
              label: 'Reject exact PDF',
              recipe_id: 'regenerate-reject-paid-document',
              config: {
                submission_id: 'submission-1',
                reviewed_artifact_sha256: sha256,
                decision: 'reject',
              },
            }, {
              kind: 'recipe.run',
              label: 'Cancel fulfillment',
              recipe_id: 'regenerate-reject-paid-document',
              config: {
                submission_id: 'submission-1',
                reviewed_artifact_sha256: sha256,
                decision: 'cancel',
              },
            }],
          }, {
            title: 'Same blob with mismatched displayed metadata',
            record_id: 'file:abcdef0123456789abcdef0123456789',
            filename: 'different-name.pdf',
            mime_type: 'application/pdf',
            size_bytes: 9,
            sha256,
            generated_at: Date.UTC(2026, 6, 11, 12, 0, 0),
            origin: { submission_id: 'submission-1' },
            approval_action: {
              kind: 'recipe.run',
              label: 'Approve and send exact PDF',
              recipe_id: 'approve-deliver-paid-document',
              config: {
                submission_id: 'submission-1',
                reviewed_artifact_sha256: sha256,
              },
            },
          }],
        }],
      } as unknown as ServerExecuteResponse['output'],
    }));
    const rig = mountRoute({
      initialRecipeId: 'review-queue',
      fileBrowser: true,
      recipeExecuteCaller: execute,
      fileReadCaller,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('review-queue'),
          recipeEntry('approve-deliver-paid-document'),
          recipeEntry('generate-paid-document'),
          recipeEntry('regenerate-reject-paid-document'),
        ],
      })),
      runnabilityCaller: vi.fn<RecipesRunnabilityCaller>(async () => ({
        recipes: [
          'review-queue',
          'approve-deliver-paid-document',
          'generate-paid-document',
          'regenerate-reject-paid-document',
        ].map((recipe_id) => ({
          recipe_id,
          status: 'runnable' as const,
          dependencies: [],
        })),
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('review-queue');
    await rig.route.confirmRun();
    rig.route.closeRunModal();

    const html = shellHtml(rig.root);
    expect(html).toContain(`${RECIPES_ROUTE_RESULT_SECTION_ATTR}="file_artifact"`);
    expect(html).toContain(`${RECIPES_ROUTE_RESULT_FILE_ATTR}="result-file-0"`);
    expect(html).toContain(`${RECIPES_ROUTE_RESULT_FILE_ATTR}="result-file-1"`);
    expect(html).toContain('Preview exact PDF');
    expect(html).toContain('Download exact PDF');
    expect(html).toContain('7,500 USD minor units');
    expect(html).toContain('template.md');
    expect(html).toContain(sha256);
    expect(html).toContain('Approve and send exact PDF');
    expect(html).toContain('Regenerate exact PDF');
    expect(html).toContain('Reject exact PDF');
    expect(html).toContain('Cancel fulfillment');
    expect(html).toContain('Preview or download this exact file before approving it.');
    expect(html).toContain('Preview or download this exact file before deciding.');
    expect(html).not.toContain(`${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-0"`);
    // INVERTED at D-207 3d·6b (`d3d60acf1`), which deleted the offer↔task link
    // substrate — op, table, rpc projection, UI and renderer paths — and took
    // `origin.task_id` out of the contract with it. This asserted the opposite:
    // that card 0's Task row rendered.
    //
    // ⚠ Card 0's fixture still CARRIES `task_id: 'task-1'`, deliberately and
    // not as leftovers. Removing it would make these assertions pass for the
    // wrong reason — "no Task row because no task data" instead of "no Task row
    // because the renderer path is gone". Feeding the deleted field and getting
    // nothing back is the only version of this that pins the deletion.
    expect(html).not.toContain('task-1');
    expect(html).not.toContain('<dt class="recipes-result-label">Task</dt>');

    clickRecipeAction(rig.root, 'open-result-file', '', {
      [RECIPES_ROUTE_RESULT_FILE_ATTR]: 'result-file-0',
      'data-recued-recipes-result-file-mode': 'download',
    });
    await vi.waitFor(() => {
      expect(fileReadCaller).toHaveBeenCalledWith({
        record_id: 'file:abcdef0123456789abcdef0123456789',
      });
      expect(shellHtml(rig.root)).toContain(
        `${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-0"`,
      );
      expect(shellHtml(rig.root)).toContain(
        `${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-3"`,
      );
      expect(shellHtml(rig.root)).not.toContain(
        `${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-4"`,
      );
    });

    clickRecipeAction(rig.root, 'run-result-action', '', {
      [RECIPES_ROUTE_RESULT_ACTION_ATTR]: 'result-action-0',
    });
    expect(rig.route.runModal()?.recipe_id).toBe('approve-deliver-paid-document');
    expect(rig.route.runModal()?.config_text).toContain('"submission_id": "submission-1"');
    expect(rig.route.runModal()?.config_text).toContain(
      `"reviewed_artifact_sha256": "${sha256}"`,
    );

    rig.route.closeRunModal();
    clickRecipeAction(rig.root, 'run-result-action', '', {
      [RECIPES_ROUTE_RESULT_ACTION_ATTR]: 'result-action-1',
    });
    expect(rig.route.runModal()?.recipe_id).toBe('generate-paid-document');
    expect(rig.route.runModal()?.config_text).toContain('"submission_id": "submission-1"');
    expect(rig.route.runModal()?.config_text).toContain(
      `"reviewed_artifact_sha256": "${sha256}"`,
    );

    rig.route.dispose();
  });

  it('keeps approval locked when the host cannot safely open returned bytes (D-200 audit)', async () => {
    const sha256 = 'a'.repeat(64);
    const fileReadCaller = vi.fn<RecipeFileReadCaller>(async ({ record_id }) => ({
      record_id,
      bytes_b64: 'WA==',
      mime_type: 'text/html',
      filename: 'unsafe.html',
      size_bytes: 1,
      blob_hash: sha256,
    }));
    const rig = mountRoute({
      initialRecipeId: 'review-queue',
      fileReadCaller,
      recipeExecuteCaller: vi.fn<RecipeExecuteCaller>(async () => executeResponse({
        output: {
          render: [{
            type: 'file_artifact',
            data: {
              record_id: 'file:abcdef0123456789abcdef0123456789',
              filename: 'unsafe.html',
              mime_type: 'text/html',
              size_bytes: 1,
              sha256,
              generated_at: Date.UTC(2026, 6, 11, 12, 0, 0),
              origin: { submission_id: 'submission-1' },
              approval_action: {
                kind: 'recipe.run',
                label: 'Approve and send exact PDF',
                recipe_id: 'approve-deliver-paid-document',
                config: {
                  submission_id: 'submission-1',
                  reviewed_artifact_sha256: sha256,
                },
              },
            },
          }],
        } as unknown as ServerExecuteResponse['output'],
      })),
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('review-queue'),
          recipeEntry('approve-deliver-paid-document'),
        ],
      })),
      runnabilityCaller: vi.fn<RecipesRunnabilityCaller>(async () => ({
        recipes: ['review-queue', 'approve-deliver-paid-document'].map((recipe_id) => ({
          recipe_id,
          status: 'runnable' as const,
          dependencies: [],
        })),
      })),
    });
    await rig.route.whenLoaded();
    rig.route.openRunModal('review-queue');
    await rig.route.confirmRun();
    rig.route.closeRunModal();

    expect(shellHtml(rig.root)).not.toContain('Preview exact PDF');
    expect(shellHtml(rig.root)).toContain('Download exact file');
    clickRecipeAction(rig.root, 'open-result-file', '', {
      [RECIPES_ROUTE_RESULT_FILE_ATTR]: 'result-file-0',
      'data-recued-recipes-result-file-mode': 'download',
    });

    await vi.waitFor(() => {
      expect(shellHtml(rig.root)).toContain(
        'This browser cannot safely open authenticated file bytes.',
      );
    });
    expect(shellHtml(rig.root)).not.toContain(
      `${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-`,
    );

    rig.route.dispose();
  });

  it('keeps approval locked when decoded bytes disagree with authenticated size metadata (D-200 audit)', async () => {
    const sha256 = 'a'.repeat(64);
    const fileReadCaller = vi.fn<RecipeFileReadCaller>(async ({ record_id }) => ({
      record_id,
      bytes_b64: 'JVBERi0xLjQ=',
      mime_type: 'application/pdf',
      filename: 'document.pdf',
      size_bytes: 9,
      blob_hash: sha256,
    }));
    const rig = mountRoute({
      initialRecipeId: 'review-queue',
      fileBrowser: true,
      fileReadCaller,
      recipeExecuteCaller: vi.fn<RecipeExecuteCaller>(async () => executeResponse({
        output: {
          render: [{
            type: 'file_artifact',
            data: {
              record_id: 'file:abcdef0123456789abcdef0123456789',
              filename: 'document.pdf',
              mime_type: 'application/pdf',
              size_bytes: 9,
              sha256,
              generated_at: Date.UTC(2026, 6, 11, 12, 0, 0),
              origin: { submission_id: 'submission-1' },
              approval_action: {
                kind: 'recipe.run',
                label: 'Approve and send exact PDF',
                recipe_id: 'approve-deliver-paid-document',
                config: {
                  submission_id: 'submission-1',
                  reviewed_artifact_sha256: sha256,
                },
              },
            },
          }],
        } as unknown as ServerExecuteResponse['output'],
      })),
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('review-queue'),
          recipeEntry('approve-deliver-paid-document'),
        ],
      })),
      runnabilityCaller: vi.fn<RecipesRunnabilityCaller>(async () => ({
        recipes: ['review-queue', 'approve-deliver-paid-document'].map((recipe_id) => ({
          recipe_id,
          status: 'runnable' as const,
          dependencies: [],
        })),
      })),
    });
    await rig.route.whenLoaded();
    rig.route.openRunModal('review-queue');
    await rig.route.confirmRun();
    rig.route.closeRunModal();

    clickRecipeAction(rig.root, 'open-result-file', '', {
      [RECIPES_ROUTE_RESULT_FILE_ATTR]: 'result-file-0',
      'data-recued-recipes-result-file-mode': 'download',
    });

    await vi.waitFor(() => {
      expect(shellHtml(rig.root)).toContain(
        'Authenticated file bytes do not match the returned file size.',
      );
    });
    expect(shellHtml(rig.root)).not.toContain(
      `${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-`,
    );

    rig.route.dispose();
  });

  it('does not let stale read cleanup clear a newer exact-file verification (D-200 audit)', async () => {
    type FileReadResult = Awaited<ReturnType<RecipeFileReadCaller>>;
    const sha256 = 'a'.repeat(64);
    const exactFile: FileReadResult = {
      record_id: 'file:abcdef0123456789abcdef0123456789',
      bytes_b64: 'JVBERi0xLjQK',
      mime_type: 'application/pdf',
      filename: 'document.pdf',
      size_bytes: 9,
      blob_hash: sha256,
    };
    const firstRead = deferred<FileReadResult>();
    const secondRead = deferred<FileReadResult>();
    const reads = [firstRead, secondRead];
    let readIndex = 0;
    const fileReadCaller = vi.fn<RecipeFileReadCaller>(() => {
      const read = reads[readIndex];
      readIndex += 1;
      if (read === undefined) throw new Error('unexpected extra file read');
      return read.promise;
    });
    const execute = vi.fn<RecipeExecuteCaller>(async () => executeResponse({
      output: {
        render: [{
          type: 'file_artifact',
          data: {
            record_id: exactFile.record_id,
            filename: exactFile.filename,
            mime_type: exactFile.mime_type,
            size_bytes: exactFile.size_bytes,
            sha256,
            generated_at: Date.UTC(2026, 6, 11, 12, 0, 0),
            origin: { submission_id: 'submission-1' },
            approval_action: {
              kind: 'recipe.run',
              label: 'Approve and send exact PDF',
              recipe_id: 'approve-deliver-paid-document',
              config: {
                submission_id: 'submission-1',
                reviewed_artifact_sha256: sha256,
              },
            },
          },
        }],
      } as unknown as ServerExecuteResponse['output'],
    }));
    const rig = mountRoute({
      initialRecipeId: 'review-queue',
      fileBrowser: true,
      fileReadCaller,
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('review-queue'),
          recipeEntry('approve-deliver-paid-document'),
        ],
      })),
      runnabilityCaller: vi.fn<RecipesRunnabilityCaller>(async () => ({
        recipes: ['review-queue', 'approve-deliver-paid-document'].map((recipe_id) => ({
          recipe_id,
          status: 'runnable' as const,
          dependencies: [],
        })),
      })),
    });
    await rig.route.whenLoaded();

    const runReview = async (): Promise<void> => {
      rig.route.openRunModal('review-queue');
      await rig.route.confirmRun();
      rig.route.closeRunModal();
    };
    const startRead = (): void => {
      clickRecipeAction(rig.root, 'open-result-file', '', {
        [RECIPES_ROUTE_RESULT_FILE_ATTR]: 'result-file-0',
        'data-recued-recipes-result-file-mode': 'download',
      });
    };

    await runReview();
    startRead();
    await vi.waitFor(() => expect(fileReadCaller).toHaveBeenCalledTimes(1));

    await runReview();
    startRead();
    await vi.waitFor(() => expect(fileReadCaller).toHaveBeenCalledTimes(2));
    expect(shellHtml(rig.root)).toContain('Reading the exact file…');

    firstRead.resolve(exactFile);
    await firstRead.promise;
    await Promise.resolve();

    expect(shellHtml(rig.root)).toContain('Reading the exact file…');
    expect(shellHtml(rig.root)).not.toContain(
      `${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-`,
    );

    secondRead.resolve(exactFile);
    await vi.waitFor(() => {
      expect(shellHtml(rig.root)).toContain(
        `${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-0"`,
      );
    });

    rig.route.dispose();
  });

  it('refuses changed authenticated bytes and mismatched approval pins (D-200)', async () => {
    const reviewedSha256 = 'a'.repeat(64);
    const fileReadCaller = vi.fn<RecipeFileReadCaller>(async ({ record_id }) => ({
      record_id,
      bytes_b64: 'JVBERi0xLjQ=',
      mime_type: 'application/pdf',
      filename: 'document.pdf',
      size_bytes: 9,
      blob_hash: 'c'.repeat(64),
    }));
    const rig = mountRoute({
      initialRecipeId: 'review-queue',
      fileReadCaller,
      recipeExecuteCaller: vi.fn<RecipeExecuteCaller>(async () => executeResponse({
        output: {
          render: [{
            type: 'file_artifact',
            data: {
              record_id: 'file:abcdef0123456789abcdef0123456789',
              filename: 'document.pdf',
              mime_type: 'application/pdf',
              size_bytes: 9,
              sha256: reviewedSha256,
              generated_at: Date.UTC(2026, 6, 11, 12, 0, 0),
              origin: { submission_id: 'submission-1' },
              approval_action: {
                kind: 'recipe.run',
                label: 'Approve and send exact PDF',
                recipe_id: 'approve-deliver-paid-document',
                config: {
                  submission_id: 'submission-1',
                  reviewed_artifact_sha256: 'b'.repeat(64),
                },
              },
            },
          }],
        } as unknown as ServerExecuteResponse['output'],
      })),
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('review-queue'),
          recipeEntry('approve-deliver-paid-document'),
        ],
      })),
      runnabilityCaller: vi.fn<RecipesRunnabilityCaller>(async () => ({
        recipes: ['review-queue', 'approve-deliver-paid-document'].map((recipe_id) => ({
          recipe_id,
          status: 'runnable' as const,
          dependencies: [],
        })),
      })),
    });
    await rig.route.whenLoaded();
    rig.route.openRunModal('review-queue');
    await rig.route.confirmRun();
    rig.route.closeRunModal();

    expect(shellHtml(rig.root)).toContain(
      'Approval action does not match this exact response and file hash.',
    );
    expect(shellHtml(rig.root)).not.toContain(
      `${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-`,
    );

    clickRecipeAction(rig.root, 'open-result-file', '', {
      [RECIPES_ROUTE_RESULT_FILE_ATTR]: 'result-file-0',
      'data-recued-recipes-result-file-mode': 'preview',
    });
    await vi.waitFor(() => {
      expect(shellHtml(rig.root)).toContain(
        'Authenticated file read no longer matches the reviewed SHA-256.',
      );
    });
    expect(shellHtml(rig.root)).toContain(RECIPES_ROUTE_RESULT_FILE_STATUS_ATTR);

    rig.route.dispose();
  });

  it('renders result actions in tables, checklists, and multi-action groups (D-195 P4)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async () =>
      executeResponse({
        output: {
          render: [
            {
              type: 'table',
              data: {
                columns: [
                  { field: 'name', label: 'Name' },
                  { field: 'action', label: 'Action', type: 'action' },
                ],
                rows: [{
                  name: 'Acme',
                  action: { kind: 'recipe.run', label: 'Open row', recipe_id: 'reply-action' },
                }],
              },
            },
            {
              type: 'checklist',
              data: {
                items: [{
                  label: 'Reply needed',
                  status: 'issue',
                  detail: 'Owner should respond',
                  actions: [
                    { kind: 'recipe.run', label: 'Approve', recipe_id: 'reply-action' },
                    { kind: 'recipe.run', label: 'Missing target', recipe_id: 'missing-action' },
                  ],
                }],
              },
            },
            {
              type: 'button',
              data: [
                { kind: 'recipe.run', label: 'Send nudge', recipe_id: 'reply-action' },
                { kind: 'recipe.run', label: 'Close watch', recipe_id: 'reply-action' },
              ],
            },
          ],
        } as unknown as ServerExecuteResponse['output'],
      }));
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [recipeEntry('daily-brief'), recipeEntry('reply-action')],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();

    const html = shellHtml(rig.root);
    expect(html).toContain('Open row');
    expect(html).toContain('Approve');
    expect(html).toContain('Send nudge');
    expect(html).toContain('Close watch');
    expect(html).toContain('data-recued-recipes-result-action-select="result-action-group-');
    expect(html).toContain('Recipe &quot;missing-action&quot; is not installed.');

    rig.route.dispose();
  });

  it('opens the fenced-delivery reconciler from a sending review row (D-200 audit)', async () => {
    const confirm = vi.fn<(message?: string) => boolean>().mockReturnValue(true);
    const rig = mountRoute({
      initialRecipeId: 'review-paid-document-artifacts',
      confirm,
      recipeExecuteCaller: vi.fn<RecipeExecuteCaller>(async () =>
        executeResponse({
          output: {
            render: [{
              type: 'table',
              data: {
                columns: [
                  { field: 'submission_id', label: 'Submission' },
                  { field: 'action', label: 'Recovery', type: 'action' },
                ],
                rows: [{
                  submission_id: 'submission-1',
                  action: {
                    kind: 'recipe.run',
                    label: 'Reconcile fenced delivery',
                    recipe_id: 'reconcile-paid-document-delivery',
                    config: { submission_id: 'submission-1' },
                    confirm: 'Check the exact provider proof without resending?',
                  },
                }],
              },
            }],
          } as unknown as ServerExecuteResponse['output'],
        })),
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('review-paid-document-artifacts'),
          recipeEntry('reconcile-paid-document-delivery'),
        ],
      })),
      runnabilityCaller: vi.fn<RecipesRunnabilityCaller>(async () => ({
        recipes: [
          'review-paid-document-artifacts',
          'reconcile-paid-document-delivery',
        ].map((recipe_id) => ({
          recipe_id,
          status: 'runnable' as const,
          dependencies: [],
        })),
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('review-paid-document-artifacts');
    await rig.route.confirmRun();
    rig.route.closeRunModal();

    expect(shellHtml(rig.root)).toContain('Reconcile fenced delivery');
    expect(shellHtml(rig.root)).toContain(
      `${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-0"`,
    );

    clickRecipeAction(rig.root, 'run-result-action', '', {
      [RECIPES_ROUTE_RESULT_ACTION_ATTR]: 'result-action-0',
    });

    expect(confirm).toHaveBeenCalledWith(
      'Check the exact provider proof without resending?',
    );
    expect(rig.route.runModal()?.recipe_id).toBe('reconcile-paid-document-delivery');
    expect(JSON.parse(rig.route.runModal()?.config_text ?? '')).toEqual({
      submission_id: 'submission-1',
    });
    expect(rig.route.runModal()?.context_values).toEqual({});

    rig.route.dispose();
  });

  it('opens a checklist item action with prefilled config and context (D-195 P4)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async (args) => {
      if (args.recipe_id === 'daily-brief') {
        return executeResponse({
          output: {
            render: [{
              type: 'checklist',
              data: {
                items: [{
                  label: 'Review needed',
                  status: 'issue',
                  detail: 'Owner should respond.',
                  action: {
                    kind: 'recipe.run',
                    label: 'Draft reply',
                    recipe_id: 'reply-action',
                    config: { tone: 'direct' },
                    context: { entity_id: 'deal-7' },
                  },
                }],
              },
            }],
          } as unknown as ServerExecuteResponse['output'],
        });
      }
      return executeResponse({
        recipe_id: args.recipe_id,
        recipe_hash: `hash-${args.recipe_id}`,
        output: {
          render: [{ type: 'text', data: `result for ${args.recipe_id}` }],
        } as unknown as ServerExecuteResponse['output'],
      });
    });
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('daily-brief'),
          targetRecipeWithEntityContext('reply-action', 'Reply action'),
        ],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();
    rig.route.closeRunModal();

    const html = shellHtml(rig.root);
    expect(html).toContain('Review needed');
    expect(html).toContain('Draft reply');
    expect(html).toContain(`${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-0"`);
    expect(html).not.toContain(`${RESULT_ACTION_SELECT_ATTR}="`);

    clickRecipeAction(rig.root, 'run-result-action', '', {
      [RECIPES_ROUTE_RESULT_ACTION_ATTR]: 'result-action-0',
    });

    expect(rig.route.runModal()?.recipe_id).toBe('reply-action');
    expect(rig.route.runModal()?.config_text).toContain('"tone": "direct"');
    expect(rig.route.runModal()?.target_values).toEqual({});
    expect(rig.route.runModal()?.context_values).toEqual({ entity_id: 'deal-7' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runModalHtml(rig.root)).toContain(`${RunModal.RUN_MODAL_OVERLAY_ATTR}="reply-action"`);
    expect(runModalHtml(rig.root)).toContain('Reply action');
    expect(runModalHtml(rig.root)).toContain('&quot;tone&quot;: &quot;direct&quot;');
    expect(runModalHtml(rig.root)).toContain('deal-7');

    await rig.route.confirmRun();

    expect(execute).toHaveBeenLastCalledWith({
      recipe_id: 'reply-action',
      config: { tone: 'direct' },
      context: { entity_id: 'deal-7' },
    });
    expect(rig.route.resultPanel()?.route_recipe_id).toBe('daily-brief');
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('reply-action');
    expect(shellHtml(rig.root)).toContain('result for reply-action');

    rig.route.dispose();
  });

  it('opens the selected result action from a checklist multi-action group (D-195 P4)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async (args) => {
      if (args.recipe_id === 'daily-brief') {
        return executeResponse({
          output: {
            render: [{
              type: 'checklist',
              data: {
                items: [{
                  label: 'Reply needed',
                  status: 'issue',
                  detail: 'Owner should choose the next action.',
                  actions: [
                    {
                      kind: 'recipe.run',
                      label: 'Draft reply',
                      recipe_id: 'reply-action',
                      config: { tone: 'warm' },
                      context: { entity_id: 'deal-42' },
                    },
                    {
                      kind: 'recipe.run',
                      label: 'Close watch',
                      recipe_id: 'close-action',
                      config: { status: 'closed' },
                      context: { entity_id: 'deal-99' },
                    },
                  ],
                }],
              },
            }],
          } as unknown as ServerExecuteResponse['output'],
        });
      }
      return executeResponse({
        recipe_id: args.recipe_id,
        recipe_hash: `hash-${args.recipe_id}`,
        output: {
          render: [{ type: 'text', data: `result for ${args.recipe_id}` }],
        } as unknown as ServerExecuteResponse['output'],
      });
    });
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('daily-brief'),
          targetRecipeWithEntityContext('reply-action', 'Reply action'),
          targetRecipeWithEntityContext('close-action', 'Close action'),
        ],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();
    rig.route.closeRunModal();

    const html = shellHtml(rig.root);
    const { groupId, actionIds } = resultActionSelection(html);
    expect(groupId).toBe('result-action-group-0');
    expect(actionIds).toEqual(['result-action-0', 'result-action-1']);

    appendSelectedResultAction(rig.doc, rig.root.children[0]!, groupId!, actionIds[1]!);

    clickRecipeAction(rig.root, 'run-selected-result-action', '', {
      [RESULT_ACTION_SELECT_ATTR]: groupId!,
    });

    expect(rig.route.runModal()?.recipe_id).toBe('close-action');
    expect(rig.route.runModal()?.config_text).toContain('"status": "closed"');
    expect(rig.route.runModal()?.target_values).toEqual({});
    expect(rig.route.runModal()?.context_values).toEqual({ entity_id: 'deal-99' });
    expect(execute).toHaveBeenCalledTimes(1);

    await rig.route.confirmRun();

    expect(execute).toHaveBeenLastCalledWith({
      recipe_id: 'close-action',
      config: { status: 'closed' },
      context: { entity_id: 'deal-99' },
    });
    expect(rig.route.resultPanel()?.route_recipe_id).toBe('daily-brief');
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('close-action');
    expect(shellHtml(rig.root)).toContain('result for close-action');

    rig.route.dispose();
  });

  it('opens the selected result action from a table-cell multi-action group (D-195 P4)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async (args) => {
      if (args.recipe_id === 'daily-brief') {
        return executeResponse({
          output: {
            render: [{
              type: 'table',
              data: {
                columns: [
                  { field: 'name', label: 'Name' },
                  { field: 'action', label: 'Action', type: 'action' },
                ],
                rows: [{
                  name: 'Acme',
                  action: [
                    {
                      kind: 'recipe.run',
                      label: 'Draft reply',
                      recipe_id: 'reply-action',
                      config: { tone: 'warm' },
                      context: { entity_id: 'deal-42' },
                    },
                    {
                      kind: 'recipe.run',
                      label: 'Close watch',
                      recipe_id: 'close-action',
                      config: { status: 'closed' },
                      context: { entity_id: 'deal-99' },
                    },
                  ],
                }],
              },
            }],
          } as unknown as ServerExecuteResponse['output'],
        });
      }
      return executeResponse({
        recipe_id: args.recipe_id,
        recipe_hash: `hash-${args.recipe_id}`,
        output: {
          render: [{ type: 'text', data: `result for ${args.recipe_id}` }],
        } as unknown as ServerExecuteResponse['output'],
      });
    });
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('daily-brief'),
          targetRecipeWithEntityContext('reply-action', 'Reply action'),
          targetRecipeWithEntityContext('close-action', 'Close action'),
        ],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();
    rig.route.closeRunModal();

    const html = shellHtml(rig.root);
    expect(html).toContain('Acme');
    expect(html).toContain('Draft reply');
    expect(html).toContain('Close watch');
    const { groupId, actionIds } = resultActionSelection(html);
    expect(groupId).toBe('result-action-group-0');
    expect(actionIds).toEqual(['result-action-0', 'result-action-1']);

    appendSelectedResultAction(rig.doc, rig.root.children[0]!, groupId!, actionIds[1]!);

    clickRecipeAction(rig.root, 'run-selected-result-action', '', {
      [RESULT_ACTION_SELECT_ATTR]: groupId!,
    });

    expect(rig.route.runModal()?.recipe_id).toBe('close-action');
    expect(rig.route.runModal()?.config_text).toContain('"status": "closed"');
    expect(rig.route.runModal()?.target_values).toEqual({});
    expect(rig.route.runModal()?.context_values).toEqual({ entity_id: 'deal-99' });
    expect(execute).toHaveBeenCalledTimes(1);

    await rig.route.confirmRun();

    expect(execute).toHaveBeenLastCalledWith({
      recipe_id: 'close-action',
      config: { status: 'closed' },
      context: { entity_id: 'deal-99' },
    });
    expect(rig.route.resultPanel()?.route_recipe_id).toBe('daily-brief');
    expect(rig.route.resultPanel()?.render_recipe_id).toBe('close-action');
    expect(shellHtml(rig.root)).toContain('result for close-action');

    rig.route.dispose();
  });

  it('escapes result output and keeps unsupported actions non-executable (D-195 P4 security)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async () =>
      executeResponse({
        output: {
          render: [
            {
              type: 'summary',
              label: '<img src=x onerror="alert(1)">',
              data: {
                fields: [
                  { label: '<script>alert(1)</script>', value: '<b>unsafe</b>' },
                ],
              },
            },
            {
              type: 'table',
              data: {
                columns: [
                  { field: 'name', label: '<th onclick="steal()">Name</th>' },
                  { field: 'action', label: 'Action', type: 'action' },
                ],
                rows: [{
                  name: '<svg onload="steal()">',
                  action: {
                    kind: 'rpc.call',
                    label: '<button onclick="steal()">Run</button>',
                    recipe_id: 'reply-action',
                  },
                }],
              },
            },
            {
              type: 'checklist',
              data: {
                items: [{
                  label: '<iframe src="bad"></iframe>',
                  status: 'issue',
                  detail: '<style>body{display:none}</style>',
                  action: {
                    kind: 'url.open',
                    label: '<a href="javascript:alert(1)">Open</a>',
                    recipe_id: 'reply-action',
                  },
                }],
              },
            },
          ],
        } as unknown as ServerExecuteResponse['output'],
      }));
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [recipeEntry('daily-brief'), recipeEntry('reply-action')],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();

    const html = shellHtml(rig.root);
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;unsafe&lt;/b&gt;');
    expect(html).toContain('&lt;th onclick=&quot;steal()&quot;&gt;Name&lt;/th&gt;');
    expect(html).toContain('&lt;svg onload=&quot;steal()&quot;&gt;');
    expect(html).toContain('&lt;iframe src=&quot;bad&quot;&gt;&lt;/iframe&gt;');
    expect(html).toContain('&lt;button onclick=&quot;steal()&quot;&gt;Run&lt;/button&gt;');
    expect(html).toContain('&lt;a href=&quot;javascript:alert(1)&quot;&gt;Open&lt;/a&gt;');
    expect(html).toContain('Only recipe.run actions can be opened.');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<th onclick=');
    expect(html).not.toContain('<svg onload');
    expect(html).not.toContain('<iframe src=');
    expect(html).not.toContain('<button onclick=');
    expect(html).not.toContain('<a href="javascript:');
    expect(html).not.toContain(`${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-`);

    rig.route.dispose();
  });

  it('rejects reserved context and blocked targets but accepts other author keys (D-195 P4)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async () =>
      executeResponse({
        output: {
          render: [{
            type: 'button',
            data: [
              {
                kind: 'recipe.run',
                label: 'Reserved context',
                recipe_id: 'reply-action',
                context: { event: 'source-event' },
              },
              {
                kind: 'recipe.run',
                label: 'Blocked target',
                recipe_id: 'blocked-action',
              },
              {
                kind: 'recipe.run',
                label: 'Author context',
                recipe_id: 'reply-action',
                context: { entity_id: 'deal-42', review_mode: 'owner' },
              },
            ],
          }],
        } as unknown as ServerExecuteResponse['output'],
      }));
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeExecuteCaller: execute,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry('daily-brief'),
          recipeEntry('reply-action'),
          recipeEntry('blocked-action'),
        ],
      })),
      runnabilityCaller: vi.fn<RecipesRunnabilityCaller>(async () => ({
        recipes: [
          {
            recipe_id: 'reply-action',
            status: 'runnable' as RunnabilityStatus,
            dependencies: [],
          },
          {
            recipe_id: 'blocked-action',
            status: 'blocked' as RunnabilityStatus,
            dependencies: [],
          },
        ],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();

    const html = shellHtml(rig.root);
    expect(html).toContain('Action context cannot set reserved key &quot;event&quot;.');
    expect(html).toContain('Target recipe is blocked by missing providers.');
    expect(html).toContain('<option value="result-action-0">Author context</option>');
    expect(html).not.toContain('is not a visible target for this recipe');

    rig.route.dispose();
  });

  it('rejects non-JSON action config and context before opening a run (D-195 P4)', async () => {
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeExecuteCaller: vi.fn<RecipeExecuteCaller>(async () =>
        executeResponse({
          output: {
            render: [{
              type: 'button',
              data: [
                {
                  kind: 'recipe.run',
                  label: 'Bad context',
                  recipe_id: 'reply-action',
                  context: { value: undefined },
                },
                {
                  kind: 'recipe.run',
                  label: 'Bad config',
                  recipe_id: 'reply-action',
                  config: { count: Number.POSITIVE_INFINITY },
                },
              ],
            }],
          } as unknown as ServerExecuteResponse['output'],
        })),
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [recipeEntry('daily-brief'), recipeEntry('reply-action')],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();

    const html = shellHtml(rig.root);
    expect(html).toContain('Action context must be a JSON-compatible object.');
    expect(html).toContain('Action config must be a JSON-compatible object.');
    expect(html).not.toContain(`${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-`);

    rig.route.dispose();
  });

  it('disables result actions when runnability cannot be verified (D-195 P4)', async () => {
    const execute = vi.fn<RecipeExecuteCaller>(async () =>
      executeResponse({
        output: {
          render: [{
            type: 'button',
            data: {
              kind: 'recipe.run',
              label: 'Draft reply',
              recipe_id: 'reply-action',
            },
          }],
        } as unknown as ServerExecuteResponse['output'],
      }));
    const rig = mountRoute({
      initialRecipeId: 'daily-brief',
      recipeExecuteCaller: execute,
      runnabilityCaller: null,
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [recipeEntry('daily-brief'), recipeEntry('reply-action')],
      })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief');
    await rig.route.confirmRun();

    const html = shellHtml(rig.root);
    expect(html).toContain('Draft reply');
    expect(html).toContain('Recipe runnability is unavailable.');
    expect(html).not.toContain(`${RECIPES_ROUTE_RESULT_ACTION_ATTR}="result-action-`);

    rig.route.dispose();
  });

  it('opens the run modal on the Schedule tab (quick-schedule via L1)', async () => {
    const rig = mountRoute({
      schedulesListCaller: vi.fn(async () => ({ schedules: [] })),
    });
    await rig.route.whenLoaded();

    rig.route.openRunModal('daily-brief', 'schedule');
    expect(rig.route.runModal()?.recipe_id).toBe('daily-brief');
    expect(runModalHtml(rig.root)).toContain('Schedule');

    rig.route.dispose();
  });
});

const connectionRecipeEntry = (): ServerRecipeListEntry =>
  recipeEntry('crm-sync', {
    recipe: recipeDefinition('crm-sync', {
      requires: ['read_memory', 'read_connection_hubspot'],
      steps: [
        {
          id: 'pull',
          ingredient: 'crm-reader',
          input: { base: '{{connection.api.hubspot.base_url}}' },
        },
      ] as unknown as RecipeDefinition['steps'],
    }),
  });

const enrolledConnection = (
  name: string,
  display_name: string,
): ConnectionView =>
  ({ name, kind: 'api', display_name }) as ConnectionView;

describe('R24 — Recipes route detail → connection needs (UX flow-10)', () => {
  it('surfaces the connection a recipe needs + an enroll CTA on the detail', async () => {
    const rig = mountRoute({
      initialRecipeId: 'crm-sync',
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [connectionRecipeEntry()],
      })),
    });
    await rig.route.whenLoaded();

    const html = shellHtml(rig.root);
    expect(html).toContain(RECIPES_ROUTE_CONNECTIONS_ATTR);
    expect(html).toContain('hubspot (api)');
    expect(html).toContain(RECIPES_ROUTE_CONNECTIONS_LINK_ATTR);
    expect(html).toContain('href="#connections"');

    rig.route.dispose();
  });

  it('marks a needed connection "connected" (no CTA) when already enrolled', async () => {
    const rig = mountRoute({
      initialRecipeId: 'crm-sync',
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [connectionRecipeEntry()],
      })),
      connectionsListCaller: vi.fn<RecipesConnectionsListCaller>(async () => ({
        connections: [enrolledConnection('hubspot', 'HubSpot Prod')],
      })),
    });
    await rig.route.whenLoaded();

    const html = shellHtml(rig.root);
    expect(html).toContain('HubSpot Prod — connected');
    expect(html).not.toContain(RECIPES_ROUTE_CONNECTIONS_LINK_ATTR);

    rig.route.dispose();
  });
});

// ── runnability consumer (the visible half) ──────────────────────────

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

describe('R24 — Recipes route runnability consumer', () => {
  it('reads recipe.runnability on mount and renders per-recipe status pills', async () => {
    const runnabilityCaller = vi.fn<RecipesRunnabilityCaller>(async () => ({
      recipes: [
        runnabilityEntry('daily-brief', 'runnable'),
        runnabilityEntry('deal-watch', 'blocked', [unsatisfiedDep()]),
        runnabilityEntry('contact-enrich', 'degraded', [
          unsatisfiedDep({
            capability: 'contact',
            ops: ['enrich'],
            optional: true,
            unprovided_ops: ['enrich'],
          }),
        ]),
      ],
    }));
    const rig = mountRoute({
      recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
        recipes: [
          recipeEntry(),
          recipeEntry('deal-watch'),
          recipeEntry('contact-enrich'),
          recipeEntry('extra-recipe'),
        ],
      })),
      runnabilityCaller,
    });
    await rig.route.whenLoaded();

    expect(runnabilityCaller).toHaveBeenCalledTimes(1);
    const html = shellHtml(rig.root);
    expect(html).toContain(`${RECIPES_ROUTE_RUNNABILITY_ATTR}="runnable"`);
    expect(html).toContain(`${RECIPES_ROUTE_RUNNABILITY_ATTR}="blocked"`);
    expect(html).toContain(`${RECIPES_ROUTE_RUNNABILITY_ATTR}="degraded"`);
    expect(html).toContain('Add a provider for deal.search.');
    expect(html).toContain(
      'Add a provider for contact.enrich (optional — those steps skip).',
    );
    // Exactly the three snapshot-covered recipes carry a pill.
    expect(html.split(`${RECIPES_ROUTE_RUNNABILITY_ATTR}="`).length - 1).toBe(3);

    rig.route.dispose();
  });

  it('patches pills in place from recipe_runnability_changed without a re-read', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const subscribe = ((kind: string, listener: (event: unknown) => void) => {
      listeners.set(kind, listener);
      return () => {};
    }) as RecipesRouteSubscribe;
    const runnabilityCaller = vi.fn<RecipesRunnabilityCaller>(async () => ({
      recipes: [runnabilityEntry('daily-brief', 'runnable')],
    }));
    const rig = mountRoute({ runnabilityCaller, subscribe });
    await rig.route.whenLoaded();
    expect(shellHtml(rig.root)).toContain(
      `${RECIPES_ROUTE_RUNNABILITY_ATTR}="runnable"`,
    );

    listeners.get('recipe_runnability_changed')!({
      kind: 'recipe_runnability_changed',
      recipes: [runnabilityEntry('daily-brief', 'blocked', [unsatisfiedDep()])],
      cursor: 7,
    });

    expect(runnabilityCaller).toHaveBeenCalledTimes(1);
    const html = shellHtml(rig.root);
    expect(html).toContain(`${RECIPES_ROUTE_RUNNABILITY_ATTR}="blocked"`);
    expect(html).toContain('Add a provider for deal.search.');

    rig.route.dispose();
  });

  it('degrades to no pills when the runnability read fails, without a load error', async () => {
    const rig = mountRoute({
      runnabilityCaller: vi.fn<RecipesRunnabilityCaller>(async () => {
        throw new Error('not_configured');
      }),
    });
    await rig.route.whenLoaded();

    expect(shellHtml(rig.root)).not.toContain(RECIPES_ROUTE_RUNNABILITY_ATTR);
    expect(rig.route.getLoadErrors()).toEqual({});

    rig.route.dispose();
  });
});

describe('R24 — targeting guard (design § 8) — run modal warn + disable', () => {
  const targetedEntry = (): ServerRecipeListEntry =>
    recipeEntry('assess-deal-risk', {
      recipe: recipeDefinition('assess-deal-risk', {
        prefetch_steps: [
          {
            id: 'deal',
            ingredient: 'deal-reader-hubspot',
            input: { deal_id: '{{context.entity_id}}' },
          },
        ],
      }),
    });

  const mountTargeted = (execute = vi.fn<RecipeExecuteCaller>(async () => executeResponse())) =>
    ({
      execute,
      rig: mountRoute({
        recipesListCaller: vi.fn<RecipesListCaller>(async () => ({
          recipes: [targetedEntry()],
        })),
        recipeExecuteCaller: execute,
      }),
    });

  it('confirmRun refuses to dispatch while the target is missing', async () => {
    const { rig, execute } = mountTargeted();
    await rig.route.whenLoaded();

    rig.route.openRunModal('assess-deal-risk');
    await rig.route.confirmRun();

    expect(execute).not.toHaveBeenCalled();
    expect(rig.route.runModal()?.error).toContain('needs a target record');

    rig.route.dispose();
  });

  it('filling the target enables Run and threads it as context', async () => {
    const { rig, execute } = mountTargeted();
    await rig.route.whenLoaded();

    rig.route.openRunModal('assess-deal-risk');
    rig.route.setRunTargetValue('entity_id', ' deal-42 ');

    await rig.route.confirmRun();
    expect(execute).toHaveBeenCalledWith({
      recipe_id: 'assess-deal-risk',
      config: {},
      context: { entity_id: 'deal-42' },
    });
    expect(rig.route.runModal()?.result?.success).toBe(true);

    rig.route.dispose();
  });
});
