import { describe, expect, it, vi } from 'vitest';
import type {
  PackListEntry,
  ServerExecuteResponse,
  ServerRecipeListEntry,
} from '@recued/contracts';

import {
  PACK_APP_CONTEXT_ATTR,
  PACK_APP_OPERATION_ATTR,
  PACK_APP_RESULT_ATTR,
  mountPackAppView,
  type PackAppExecuteCaller,
  type MountPackAppViewOptions,
} from '../packs/pack-app-view.js';
import type { PackAppSurface } from '../packs/pack-app-model.js';
import {
  RECIPES_ROUTE_RESULT_GRID_ATTR,
  RECIPES_ROUTE_RESULT_GRID_CELL_ATTR,
} from '../recipes/recipe-result-panel.js';

interface FakeElement {
  innerHTML: string;
  parentNode: FakeElement | null;
  children: FakeElement[];
  listeners: Map<string, Array<(event: Event) => void>>;
  attrs: Map<string, string>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: FakeElement): FakeElement;
  removeChild(child: FakeElement): FakeElement;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  querySelector(selector: string): FakeElement | null;
  remove(): void;
}

const fakeElement = (): FakeElement => {
  const element: FakeElement = {
    innerHTML: '',
    parentNode: null,
    children: [],
    listeners: new Map(),
    attrs: new Map(),
    setAttribute(name, value) { element.attrs.set(name, value); },
    getAttribute(name) { return element.attrs.get(name) ?? null; },
    appendChild(child) {
      child.parentNode = element;
      element.children.push(child);
      return child;
    },
    removeChild(child) {
      const index = element.children.indexOf(child);
      if (index < 0) throw new Error('not a child');
      element.children.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    addEventListener(type, listener) {
      element.listeners.set(type, [...(element.listeners.get(type) ?? []), listener]);
    },
    removeEventListener(type, listener) {
      element.listeners.set(
        type,
        (element.listeners.get(type) ?? []).filter((entry) => entry !== listener),
      );
    },
    querySelector() { return null; },
    remove() { element.parentNode?.removeChild(element); },
  };
  return element;
};

const settle = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
};

const entry = {
  recipe_id: 'sheet',
  publisher_id: 'recued-core',
  version: 1,
  recipe_hash: 'stored-sheet-hash',
  recipe: {
    recipe_id: 'sheet', version: 1, ttl: 0,
    metadata: {
      name: 'Sheet', description: 'Edit a sheet.', author: 'recued-core',
      supported_platforms: [], tags: [],
    },
    variables: {}, prefetch_steps: [], steps: [], requires: [],
    output: { render: [] },
  },
  source: 'bundled',
  installed_at: 0,
} as unknown as ServerRecipeListEntry;

const taskEntry = {
  ...entry,
  recipe_id: 'post-entry',
  recipe_hash: 'stored-task-hash',
  recipe: {
    ...entry.recipe,
    recipe_id: 'post-entry',
    metadata: {
      ...entry.recipe.metadata,
      name: 'Post entry',
      description: 'Record both sides and keep the receipt.',
    },
  },
} as unknown as ServerRecipeListEntry;

const lookupEntry = {
  ...entry,
  recipe_id: 'find-entry',
  recipe_hash: 'stored-lookup-hash',
  recipe: {
    ...entry.recipe,
    recipe_id: 'find-entry',
    metadata: {
      ...entry.recipe.metadata,
      name: 'Find entry',
      description: 'Review one entry.',
    },
  },
} as unknown as ServerRecipeListEntry;

const surface: PackAppSurface = {
  views: [{ recipe_id: 'sheet', name: 'Sheet', description: 'Edit a sheet.', entry }],
  lookups: [],
  operations: [],
  missing: [],
};

const pack = {
  slug: 'sheet-pack', name: 'Sheet pack', description: '',
} as unknown as PackListEntry;

const tableResult = (
  rows: Array<Record<string, string>> = [{ line_ref: 'line/1', amount: '' }],
  mode: 'fixed' | 'add_remove' = 'fixed',
): ServerExecuteResponse => ({
  recipe_id: 'sheet', recipe_hash: 'execution-hash', success: true,
  steps: [], errors: [],
  output: { render: [{
    type: 'table', data: mode === 'add_remove' ? [] : { rows },
    ...(mode === 'fixed' ? {
      record_columns: {
        entity: 'line',
        columns: [
          { field: 'line_ref', label: 'Line', kind: 'id' },
          { field: 'amount', label: 'Amount', kind: 'decimal' },
        ],
      },
    } : {}),
    table_edit: {
      section_index: 0, recipe_hash: 'stored-sheet-hash',
      into: 'lines', submit: 'Save lines', rows: mode,
      editable: mode === 'fixed' ? ['amount'] : ['description', 'quantity'],
      carry: mode === 'fixed' ? ['line_ref'] : [],
      hidden: { period: '2026-07' },
    },
  }] },
} as unknown as ServerExecuteResponse);

const mount = (
  execute: PackAppExecuteCaller,
  options: Partial<Pick<
    MountPackAppViewOptions,
    'surface' | 'installedRecipes' | 'openRunModal'
  >> = {},
) => {
  const host = fakeElement();
  const doc = {
    createElement: () => fakeElement(),
    defaultView: { confirm: () => true },
  } as unknown as Document;
  const view = mountPackAppView({
    host: host as unknown as HTMLElement,
    document: doc,
    pack,
    surface: options.surface ?? surface,
    execute,
    installedRecipes: options.installedRecipes ?? [entry],
    ...(options.openRunModal !== undefined
      ? { openRunModal: options.openRunModal }
      : {}),
  });
  return { host, root: host.children[0]!, view };
};

const emitPackControl = (
  root: FakeElement,
  attr: string,
  value = '',
): void => {
  const control = {
    getAttribute: (name: string) => name === attr ? value : null,
  };
  const target = {
    closest: (selector: string) => selector.includes(`[${attr}]`) ? control : null,
  };
  for (const listener of root.listeners.get('click') ?? []) {
    listener({ target } as unknown as Event);
  }
};

const emitAction = (
  root: FakeElement,
  action: string,
  attrs: Record<string, string>,
): void => {
  const control = {
    getAttribute: (name: string) =>
      name === 'data-recued-recipes-action' ? action : attrs[name] ?? null,
  };
  const target = {
    closest: (selector: string) =>
      selector.includes(`="${action}"`) ? control : null,
  };
  for (const listener of root.listeners.get('click') ?? []) {
    listener({ target } as unknown as Event);
  }
};

const typeGridCell = (
  root: FakeElement,
  key: string,
  address: string,
  value: string,
): { submit: { disabled: boolean }; status: { dataset: Record<string, string>; textContent: string } } => {
  const submit = { disabled: true };
  const status = { dataset: {} as Record<string, string>, textContent: '' };
  const gridRoot = {
    getAttribute: (name: string) => name === RECIPES_ROUTE_RESULT_GRID_ATTR ? key : null,
    querySelector: (selector: string) =>
      selector.includes('result-grid-submit') ? submit
        : selector === '.recipes-result-grid-status' ? status : null,
  };
  const target = {
    value,
    dataset: {},
    getAttribute: (name: string) =>
      name === RECIPES_ROUTE_RESULT_GRID_CELL_ATTR ? address : null,
    closest: (selector: string) =>
      selector === `[${RECIPES_ROUTE_RESULT_GRID_ATTR}]` ? gridRoot : null,
  };
  for (const listener of root.listeners.get('input') ?? []) {
    listener({ target } as unknown as Event);
  }
  return { submit, status };
};

describe('pack app shared editable tables', () => {
  it('edits and saves through the same config + invocation boundary as Recipes', async () => {
    const execute = vi.fn<PackAppExecuteCaller>(async () => tableResult());
    const rig = mount(execute);
    await settle();

    const key = 'sheet#grid-0';
    expect(rig.root.innerHTML).toContain(`${RECIPES_ROUTE_RESULT_GRID_ATTR}="${key}"`);
    const chrome = typeGridCell(rig.root, key, '0:amount', '125.00');
    expect(chrome.submit.disabled).toBe(false);
    expect(chrome.status).toMatchObject({
      dataset: { dirty: 'true' }, textContent: '1 row · Unsaved changes',
    });

    emitAction(rig.root, 'result-grid-submit', {
      [RECIPES_ROUTE_RESULT_GRID_ATTR]: key,
    });
    await settle();

    expect(execute).toHaveBeenNthCalledWith(2, {
      recipe_id: 'sheet',
      config: {
        period: '2026-07',
        lines: [{ line_ref: 'line/1', amount: '125.00' }],
      },
      invocation: {
        kind: 'output.table_edit',
        recipe_hash: 'stored-sheet-hash',
        section_index: 0,
      },
    });
    rig.view.dispose();
  });

  it('renders and wires add/remove for an initially empty composing table', async () => {
    const execute = vi.fn<PackAppExecuteCaller>(async () => tableResult([], 'add_remove'));
    const rig = mount(execute);
    await settle();
    const key = 'sheet#grid-0';
    expect(rig.root.innerHTML).toContain('No rows yet. Add a row to get started.');

    emitAction(rig.root, 'result-grid-add', {
      [RECIPES_ROUTE_RESULT_GRID_ATTR]: key,
    });
    expect(rig.root.innerHTML).toContain(`${RECIPES_ROUTE_RESULT_GRID_CELL_ATTR}="0:description"`);
    expect(rig.root.innerHTML).toContain('result-grid-remove');

    emitAction(rig.root, 'result-grid-remove', {
      [RECIPES_ROUTE_RESULT_GRID_ATTR]: key,
      'data-recued-recipes-result-grid-row': '0',
    });
    expect(rig.root.innerHTML).toContain('0 rows · No changes yet');
    rig.view.dispose();
  });

  it('blocks a result filter from discarding an unsaved grid', async () => {
    const result = tableResult();
    const render = (result.output as { render: unknown[] }).render;
    render.push({
      type: 'filter', data: {},
      filter: {
        section_index: 1, recipe_hash: 'stored-sheet-hash',
        fields: ['status'], hidden: [], submit: 'Search',
        definitions: { status: { label: 'Status', type: 'string', default: '' } },
        values: { status: '' },
      },
    });
    const execute = vi.fn<PackAppExecuteCaller>(async () => result);
    const rig = mount(execute);
    await settle();
    typeGridCell(rig.root, 'sheet#grid-0', '0:amount', '99.00');

    emitAction(rig.root, 'result-filter-search', {
      'data-recued-recipes-result-filter': 'sheet:stored-sheet-hash:1',
    });
    await settle();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(rig.root.innerHTML).toContain('Save the edited table first');
    rig.view.dispose();
  });
});

const taskResult = (recipeId: string, message: string): ServerExecuteResponse => ({
  recipe_id: recipeId,
  recipe_hash: `${recipeId}-execution-hash`,
  success: true,
  duration_ms: 12,
  steps: [],
  errors: [],
  output: { render: [{ type: 'summary', data: { message } }] },
} as unknown as ServerExecuteResponse);

describe('pack app business lifecycle', () => {
  it('keeps a write result in Pack detail, then refreshes the browse view on return', async () => {
    const execute = vi.fn<PackAppExecuteCaller>()
      .mockResolvedValueOnce(tableResult())
      .mockResolvedValueOnce(tableResult([{ line_ref: 'line/2', amount: '25.00' }]));
    let onRan: ((result: ServerExecuteResponse) => void) | undefined;
    const openRunModal = vi.fn<NonNullable<MountPackAppViewOptions['openRunModal']>>(
      (_entry, callback) => { onRan = callback; },
    );
    const lifecycleSurface: PackAppSurface = {
      ...surface,
      operations: [{
        recipe_id: taskEntry.recipe_id,
        name: 'Post entry',
        description: 'Record both sides and keep the receipt.',
        entry: taskEntry,
      }],
    };
    const rig = mount(execute, {
      surface: lifecycleSurface,
      installedRecipes: [entry, taskEntry],
      openRunModal,
    });
    await settle();

    emitPackControl(rig.root, PACK_APP_OPERATION_ATTR, taskEntry.recipe_id);
    expect(openRunModal).toHaveBeenCalledWith(taskEntry, expect.any(Function), undefined);

    onRan?.(taskResult(taskEntry.recipe_id, 'Entry posted'));
    expect(rig.root.innerHTML).toContain(`${PACK_APP_CONTEXT_ATTR}="task"`);
    expect(rig.root.innerHTML).toContain(`${PACK_APP_RESULT_ATTR}="post-entry"`);
    expect(rig.root.innerHTML).toContain('Run completed · Post entry');
    expect(rig.root.innerHTML).toContain('Back to Sheet');
    expect(rig.root.innerHTML).toContain('Your browse view will refresh when you return.');
    expect(execute).toHaveBeenCalledTimes(1);

    emitAction(rig.root, 'restore-result-panel', {});
    await settle();
    expect(execute).toHaveBeenNthCalledWith(2, {
      recipe_id: 'sheet',
      config: {},
    });
    expect(rig.root.innerHTML).toContain(`${PACK_APP_CONTEXT_ATTR}="view"`);
    expect(rig.root.innerHTML).toContain('line/2');
    rig.view.dispose();
  });

  it('returns from a read-only lookup to the cached view without a redundant run', async () => {
    const execute = vi.fn<PackAppExecuteCaller>(async () => tableResult());
    let onRan: ((result: ServerExecuteResponse) => void) | undefined;
    const openRunModal = vi.fn<NonNullable<MountPackAppViewOptions['openRunModal']>>(
      (_entry, callback) => { onRan = callback; },
    );
    const lifecycleSurface: PackAppSurface = {
      ...surface,
      lookups: [{
        recipe_id: lookupEntry.recipe_id,
        name: 'Find entry',
        description: 'Review one entry.',
        entry: lookupEntry,
      }],
    };
    const rig = mount(execute, {
      surface: lifecycleSurface,
      installedRecipes: [entry, lookupEntry],
      openRunModal,
    });
    await settle();

    emitPackControl(rig.root, PACK_APP_OPERATION_ATTR, lookupEntry.recipe_id);
    onRan?.(taskResult(lookupEntry.recipe_id, 'Entry found'));
    expect(rig.root.innerHTML).toContain('Back to Sheet');

    emitAction(rig.root, 'restore-result-panel', {});
    expect(execute).toHaveBeenCalledTimes(1);
    expect(rig.root.innerHTML).toContain(`${PACK_APP_RESULT_ATTR}="sheet"`);
    expect(rig.root.innerHTML).toContain(`${PACK_APP_CONTEXT_ATTR}="view"`);
    rig.view.dispose();
  });

  it('filters the displayed lookup recipe instead of accidentally re-running the browse tab', async () => {
    const lookupResult = {
      ...taskResult(lookupEntry.recipe_id, 'Entry found'),
      output: { render: [{
        type: 'filter', data: {},
        filter: {
          section_index: 0,
          recipe_hash: lookupEntry.recipe_hash,
          fields: ['period'], hidden: [], submit: 'Search',
          definitions: {
            period: { label: 'Period', type: 'string', default: '2026-07' },
          },
          values: { period: '2026-07' },
        },
      }] },
    } as unknown as ServerExecuteResponse;
    const execute = vi.fn<PackAppExecuteCaller>()
      .mockResolvedValueOnce(tableResult())
      .mockResolvedValueOnce(lookupResult);
    let onRan: ((result: ServerExecuteResponse) => void) | undefined;
    const lifecycleSurface: PackAppSurface = {
      ...surface,
      lookups: [{
        recipe_id: lookupEntry.recipe_id,
        name: 'Find entry',
        description: 'Review one entry.',
        entry: lookupEntry,
      }],
    };
    const rig = mount(execute, {
      surface: lifecycleSurface,
      installedRecipes: [entry, lookupEntry],
      openRunModal: (_entry, callback) => { onRan = callback; },
    });
    await settle();
    emitPackControl(rig.root, PACK_APP_OPERATION_ATTR, lookupEntry.recipe_id);
    onRan?.(lookupResult);

    emitAction(rig.root, 'result-filter-search', {
      'data-recued-recipes-result-filter': 'find-entry:stored-lookup-hash:0',
    });
    await settle();
    expect(execute).toHaveBeenNthCalledWith(2, {
      recipe_id: 'find-entry',
      config: { period: '2026-07' },
      invocation: {
        kind: 'output.filter',
        recipe_hash: 'stored-lookup-hash',
        section_index: 0,
      },
    });
    rig.view.dispose();
  });

  it('renders a complete task result for packs that have no zero-config browse view', async () => {
    const execute = vi.fn<PackAppExecuteCaller>();
    let onRan: ((result: ServerExecuteResponse) => void) | undefined;
    const actionOnly: PackAppSurface = {
      views: [],
      lookups: [],
      operations: [{
        recipe_id: taskEntry.recipe_id,
        name: 'Post entry',
        description: 'Record both sides and keep the receipt.',
        entry: taskEntry,
      }],
      missing: [],
    };
    const rig = mount(execute, {
      surface: actionOnly,
      installedRecipes: [taskEntry],
      openRunModal: (_entry, callback) => { onRan = callback; },
    });
    expect(rig.root.innerHTML).toContain('Choose an action below to get started.');
    expect(execute).not.toHaveBeenCalled();

    emitPackControl(rig.root, PACK_APP_OPERATION_ATTR, taskEntry.recipe_id);
    onRan?.(taskResult(taskEntry.recipe_id, 'Entry posted'));
    expect(rig.root.innerHTML).toContain(`${PACK_APP_CONTEXT_ATTR}="task"`);
    expect(rig.root.innerHTML).toContain('Run completed · Post entry');
    expect(rig.root.innerHTML).toContain('Entry posted');
    rig.view.dispose();
  });
});
