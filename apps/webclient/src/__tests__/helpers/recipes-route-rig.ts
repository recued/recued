/** The Recipes route test rig: a fake DOM, recipe and list-entry builders, and
 *  `mountRoute`, which boots `bootstrapRecipesRoute` against the fakes with every
 *  caller stubbed unless a test supplies its own.
 *
 *  Moved verbatim out of `d-174-p4-recipes-route.test.ts` so a test that reads the
 *  corpus can live in a file of its own. The public export drops every test file
 *  that reads a private root, and the D-292 guided-import tests read the shipped
 *  importer, so while they shared a file they took every Recipes route test out of
 *  public CI with them. */
import { vi } from 'vitest';
import type {
  AutoRunStatusEntry,
  RecipeDefinition,
  RunnabilityStatus,
  ServerExecuteResponse,
  ServerRecipeListEntry,
  ToolEntry,
} from '@recued/contracts';

import {
  bootstrapRecipesRoute,
  type RecipeExecuteCaller,
  type RecipeFileReadCaller,
  type RecipesConnectionsListCaller,
  type RecipesListCaller,
  type RecipesRunnabilityCaller,
  type RecipesToolCatalogCaller,
} from '../../recipes/bootstrap-recipes-route.js';

export interface FakeEl {
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

export type FakeHistory = {
  replaceState: (data: unknown, unused: string, url?: string | null) => void;
  pushState?: (data: unknown, unused: string, url?: string | null) => void;
};

export interface FakeDoc {
  styleElements: FakeEl[];
  defaultView?: {
    history?: FakeHistory;
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

export const attrSelectorParts = (sel: string): { attr: string; value: string | null } | null => {
  const m = sel.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
  if (m === null) return null;
  return { attr: m[1]!, value: m[2] ?? null };
};

export const makeFakeEl = (tag: string): FakeEl => {
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

export const makeFakeDocument = (overrides: {
  confirm?: (message?: string) => boolean;
  clipboardWrite?: (value: string) => Promise<void>;
  fileBrowser?: boolean;
  /** Supplied when a test needs to tell a list->detail PUSH from an in-page REPLACE.
   *  Omitted by default so every other test keeps a `defaultView` with no `history`,
   *  which the route treats as sync-disabled — the sandboxed-embedding path. */
  history?: FakeHistory;
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
      || overrides.history !== undefined
      ? {
          defaultView: {
            ...(overrides.history !== undefined ? { history: overrides.history } : {}),
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

export const recipeDefinition = (
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

export const recipeEntry = (
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

export const targetRecipeWithEntityContext = (
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

export const toolEntry = (
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

export const executeResponse = (
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

export const autoRunStatus = (
  recipe_id: string,
  overrides: Partial<AutoRunStatusEntry> = {},
): AutoRunStatusEntry => ({
  recipe_id,
  publisher_id: 'recued-core',
  recipe_name: recipe_id,
  interval_ms: 60_000,
  dynamic: false,
  enabled: true,
  auto_disabled: false,
  consecutive_failures: 0,
  last_failure_at: null,
  last_failure_reason: null,
  next_run_at: 1_800_000_000_000,
  last_started_at: null,
  last_finished_at: null,
  config_overlay: {},
  variables: {},
  ...overrides,
});

export const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

export const mountRoute = (overrides: {
  recipesListCaller?: RecipesListCaller;
  recipeGetCaller?: Parameters<typeof bootstrapRecipesRoute>[0]['recipeGetCaller'];
  toolCatalogCaller?: RecipesToolCatalogCaller;
  recipeExecuteCaller?: RecipeExecuteCaller;
  fileReadCaller?: RecipeFileReadCaller;
  connectionsListCaller?: RecipesConnectionsListCaller;
  runnabilityCaller?: RecipesRunnabilityCaller | null;
  schedulesListCaller?: Parameters<typeof bootstrapRecipesRoute>[0]['schedulesListCaller'];
  schedulesCreateCaller?: Parameters<typeof bootstrapRecipesRoute>[0]['schedulesCreateCaller'];
  autoRunListCaller?: Parameters<typeof bootstrapRecipesRoute>[0]['autoRunListCaller'];
  autoRunUpdateCaller?: Parameters<typeof bootstrapRecipesRoute>[0]['autoRunUpdateCaller'];
  dishesListCaller?: Parameters<typeof bootstrapRecipesRoute>[0]['dishesListCaller'];
  recipeConfigGetCaller?: Parameters<typeof bootstrapRecipesRoute>[0]['recipeConfigGetCaller'];
  recipeConfigSetCaller?: Parameters<typeof bootstrapRecipesRoute>[0]['recipeConfigSetCaller'];
  sheetImportUploadCaller?: Parameters<typeof bootstrapRecipesRoute>[0]['sheetImportUploadCaller'];
  recipeCatalogCaller?: Parameters<typeof bootstrapRecipesRoute>[0]['recipeCatalogCaller'];
  packCatalogCaller?: Parameters<typeof bootstrapRecipesRoute>[0]['packCatalogCaller'];
  packRecipeRefsCaller?: Parameters<typeof bootstrapRecipesRoute>[0]['packRecipeRefsCaller'];
  packsListCaller?: Parameters<typeof bootstrapRecipesRoute>[0]['packsListCaller'];
  subscribe?: Parameters<typeof bootstrapRecipesRoute>[0]['subscribe'];
  initialRecipeId?: string;
  confirm?: (message?: string) => boolean;
  clipboardWrite?: (value: string) => Promise<void>;
  fileBrowser?: boolean;
  recordRefSearchCaller?: Parameters<typeof bootstrapRecipesRoute>[0]['recordRefSearchCaller'];
  history?: FakeHistory;
  document?: FakeDoc;
  root?: FakeEl;
  scrollRoot?: FakeEl;
} = {}) => {
  const doc = overrides.document ?? makeFakeDocument(
    {
      ...(overrides.history !== undefined ? { history: overrides.history } : {}),
      ...(overrides.confirm !== undefined ? { confirm: overrides.confirm } : {}),
      ...(overrides.clipboardWrite !== undefined
        ? { clipboardWrite: overrides.clipboardWrite }
        : {}),
      ...(overrides.fileBrowser === true ? { fileBrowser: true } : {}),
    },
  );
  const root = overrides.root ?? doc.createElement('div');
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
    ...(overrides.scrollRoot !== undefined
      ? { scrollRoot: overrides.scrollRoot as unknown as HTMLElement }
      : {}),
    recipesListCaller,
    ...(overrides.recipeGetCaller !== undefined ? { recipeGetCaller: overrides.recipeGetCaller } : {}),
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
    ...(overrides.dishesListCaller !== undefined
      ? { dishesListCaller: overrides.dishesListCaller }
      : {}),
    ...(overrides.recipeConfigGetCaller !== undefined
      ? { recipeConfigGetCaller: overrides.recipeConfigGetCaller }
      : {}),
    ...(overrides.recipeConfigSetCaller !== undefined
      ? { recipeConfigSetCaller: overrides.recipeConfigSetCaller }
      : {}),
    ...(overrides.sheetImportUploadCaller !== undefined
      ? { sheetImportUploadCaller: overrides.sheetImportUploadCaller }
      : {}),
    ...(overrides.recipeCatalogCaller !== undefined
      ? { recipeCatalogCaller: overrides.recipeCatalogCaller }
      : {}),
    ...(overrides.packCatalogCaller !== undefined
      ? { packCatalogCaller: overrides.packCatalogCaller }
      : {}),
    ...(overrides.packRecipeRefsCaller !== undefined
      ? { packRecipeRefsCaller: overrides.packRecipeRefsCaller }
      : {}),
    ...(overrides.packsListCaller !== undefined
      ? { packsListCaller: overrides.packsListCaller }
      : {}),
    ...(overrides.initialRecipeId !== undefined
      ? { initialRecipeId: overrides.initialRecipeId }
      : {}),
    ...(overrides.subscribe !== undefined ? { subscribe: overrides.subscribe } : {}),
    ...(overrides.recordRefSearchCaller !== undefined
      ? { recordRefSearchCaller: overrides.recordRefSearchCaller }
      : {}),
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
