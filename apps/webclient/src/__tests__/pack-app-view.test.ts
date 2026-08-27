import { describe, expect, it, vi } from 'vitest';
import { RpcError } from '@recued/contracts';
import { PACK_INSTALL_OFFER_ATTR } from '../shell/pack-install-offer.js';
import type {
  PackListEntry,
  ServerExecuteResponse,
  ServerRecipeListEntry,
} from '@recued/contracts';

import {
  PACK_APP_AUTOMATION_ATTR,
  PACK_APP_CONTEXT_ATTR,
  PACK_APP_OPERATION_ATTR,
  PACK_APP_REFRESH_ATTR,
  PACK_APP_STATUS_ATTR,
  PACK_APP_RESULT_ATTR,
  PACK_APP_VIEW_PANEL_ATTR,
  PACK_APP_VIEW_TAB_ATTR,
  PACK_APP_STYLES,
  mountPackAppView,
  type PackAppExecuteCaller,
  type MountPackAppViewOptions,
} from '../packs/pack-app-view.js';
import type { PackAppSurface } from '../packs/pack-app-model.js';
import {
  RECIPE_RESULT_HOST_ATTR,
  RECIPE_RESULT_PANEL_STYLES,
  RECIPES_ROUTE_RESULT_GRID_ATTR,
  RECIPES_ROUTE_RESULT_GRID_CELL_ATTR,
  RECIPES_ROUTE_RESULT_FACTS_ATTR,
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
  automations: [],
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

const copyableResult = (): ServerExecuteResponse => ({
  recipe_id: 'sheet', recipe_hash: 'execution-hash', success: true,
  steps: [], errors: [],
  output: { render: [{
    type: 'copyable',
    label: 'Customer follow-up',
    data: { content: 'Send the customer the signed agreement.' },
  }] },
} as unknown as ServerExecuteResponse);

const jsonResult = (): ServerExecuteResponse => ({
  recipe_id: 'sheet', recipe_hash: 'execution-hash', success: true,
  steps: [], errors: [],
  output: { render: [{
    type: 'json',
    label: 'Provider payload',
    data: {
      status: 'ready',
      external_reference: 'provider-reference-with-a-long-unbroken-value',
    },
  }] },
} as unknown as ServerExecuteResponse);

const recordFieldsResult = (): ServerExecuteResponse => ({
  recipe_id: 'sheet', recipe_hash: 'execution-hash', success: true,
  steps: [], errors: [],
  output: { render: [{
    type: 'record_fields',
    label: 'Work order',
    data: { record: { id: 'job_1' } },
    record_fields: {
      entity: 'job',
      fields: [
        {
          key: 'title', label: 'Title', kind: 'string', present: true,
          value: 'Replace the circulation pump',
        },
        {
          key: 'contact_name', label: 'Contact name', kind: 'string',
          present: false, value: undefined,
        },
      ],
    },
  }] },
} as unknown as ServerExecuteResponse);

const aiAnalysisResult = (): ServerExecuteResponse => ({
  recipe_id: 'sheet', recipe_hash: 'execution-hash', success: true,
  steps: [], errors: [],
  output: { render: [
    {
      type: 'ai_analysis',
      label: 'Triage analysis',
      data: {
        summary: 'The request is ready for owner review.',
        category: 'Customer follow-up',
        confidence: 0.91,
        reasoning: 'Matched the provider reference to the active work order.',
        key_points: ['Document supplied', 'Dispatch confirmation pending'],
      },
    },
    {
      type: 'ai_analysis',
      label: 'Raw model metadata',
      data: { providerreference: '0123456789abcdefghijklmnopqrstuvwxyz' },
    },
  ] },
} as unknown as ServerExecuteResponse);

const linkButtonResult = (): ServerExecuteResponse => ({
  recipe_id: 'sheet', recipe_hash: 'execution-hash', success: true,
  steps: [], errors: [],
  output: { render: [{
    type: 'link_button',
    label: 'Next steps',
    data: [
      {
        label: 'Open provider work item',
        url: 'https://example.com/work/job_1',
        description: 'Review the provider work item.',
      },
      {
        label: 'View signed receipt',
        url: 'https://example.com/receipts/job_1',
      },
    ],
  }] },
} as unknown as ServerExecuteResponse);

const fileArtifactResult = (): ServerExecuteResponse => ({
  recipe_id: 'sheet', recipe_hash: 'execution-hash', success: true,
  steps: [], errors: [],
  output: { render: [{
    type: 'file_artifact',
    label: 'Generated documents',
    data: [{
      title: 'Signed customer agreement',
      record_id: 'file:abcdef0123456789abcdef0123456789',
      filename: 'customer-agreement.pdf',
      mime_type: 'application/pdf',
      size_bytes: 1_234,
      sha256: 'a'.repeat(64),
      generated_at: Date.UTC(2026, 7, 3, 12, 0, 0),
      generation_mode: 'static',
      origin: { submission_id: 'submission-1' },
    }],
  }] },
} as unknown as ServerExecuteResponse);

const mount = (
  execute: PackAppExecuteCaller,
  options: Partial<Pick<
    MountPackAppViewOptions,
    | 'surface'
    | 'installedRecipes'
    | 'openRunModal'
    | 'initialViewId'
    | 'onSelectView'
  >> = {},
) => {
  const host = fakeElement();
  const clipboardWrite = vi.fn(async (_value: string) => undefined);
  const doc = {
    createElement: () => fakeElement(),
    defaultView: {
      confirm: () => true,
      navigator: { clipboard: { writeText: clipboardWrite } },
    },
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
    ...(options.initialViewId !== undefined
      ? { initialViewId: options.initialViewId }
      : {}),
    ...(options.onSelectView !== undefined
      ? { onSelectView: options.onSelectView }
      : {}),
  });
  return { host, root: host.children[0]!, view, clipboardWrite };
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

const emitCopyAction = (root: FakeElement) => {
  const attrs = new Map<string, string>([
    ['data-action', 'copy'],
    ['data-value', 'Send the customer the signed agreement.'],
  ]);
  const control = {
    textContent: 'Copy',
    getAttribute: (name: string) => attrs.get(name) ?? null,
    setAttribute: (name: string, value: string) => attrs.set(name, value),
  };
  const target = {
    closest: (selector: string) => selector === '[data-action="copy"]'
      ? control
      : null,
  };
  for (const listener of root.listeners.get('click') ?? []) {
    listener({ target, preventDefault: vi.fn() } as unknown as Event);
  }
  return { attrs, control };
};

const typeGridCell = (
  root: FakeElement,
  key: string,
  address: string,
  value: string,
): {
  submit: {
    disabled: boolean;
    tabIndex: number;
    attrs: Map<string, string>;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
  };
  status: { dataset: Record<string, string>; textContent: string };
} => {
  const submitAttrs = new Map<string, string>();
  const submit = {
    disabled: true,
    tabIndex: 0,
    attrs: submitAttrs,
    setAttribute(name: string, value: string) { submitAttrs.set(name, value); },
    removeAttribute(name: string) { submitAttrs.delete(name); },
  };
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

const typeResultFilter = (
  root: FakeElement,
  filterKey: string,
  variableKey: string,
  value: string,
): void => {
  const form = {
    getAttribute: (name: string) =>
      name === 'data-recued-recipes-result-filter' ? filterKey : null,
  };
  const target = {
    value,
    type: 'text',
    dataset: { varKey: variableKey, varType: 'text' },
    getAttribute: () => null,
    closest: (selector: string) =>
      selector === '[data-recued-recipes-result-filter]' ? form : null,
  };
  for (const listener of root.listeners.get('input') ?? []) {
    listener({ target } as unknown as Event);
  }
};

describe('pack app shared copyable results', () => {
  it('ships its layout and full-sized Copy action with the shared panel', () => {
    expect(RECIPE_RESULT_PANEL_STYLES).toContain(
      `[${RECIPE_RESULT_HOST_ATTR}] .copyable-content {`,
    );
    expect(RECIPE_RESULT_PANEL_STYLES).toMatch(
      /\.copy-btn\s*\{[^}]*min-height:\s*36px;/s,
    );
    expect(RECIPE_RESULT_PANEL_STYLES).toMatch(
      /@media \(max-width: 520px\)[\s\S]*?\.copy-btn\s*\{[^}]*min-height:\s*44px;/s,
    );
  });

  it('copies the returned value through the Pack host', async () => {
    const rig = mount(async () => copyableResult());
    await settle();

    expect(rig.root.innerHTML).toContain('class="copy-btn"');
    expect(rig.root.innerHTML).toContain('data-recued-reference-id="sheet"');
    expect(rig.root.innerHTML).toContain('data-recued-provenance');
    const { attrs, control } = emitCopyAction(rig.root);
    await settle();

    expect(rig.clipboardWrite).toHaveBeenCalledWith(
      'Send the customer the signed agreement.',
    );
    expect(attrs.get('aria-live')).toBe('polite');
    expect(control.textContent).toBe('Copied');
    rig.view.dispose();
  });
});

describe('pack app shared JSON results', () => {
  it('ships a full-sized disclosure and wrapping payload with the shared panel', () => {
    expect(RECIPE_RESULT_PANEL_STYLES).toMatch(
      /\.json-summary\s*\{[^}]*min-height:\s*36px;/s,
    );
    expect(RECIPE_RESULT_PANEL_STYLES).toMatch(
      /\.json-content\s*\{[^}]*max-width:\s*100%;[^}]*white-space:\s*pre-wrap;[^}]*overflow-wrap:\s*anywhere;/s,
    );
    expect(RECIPE_RESULT_PANEL_STYLES).toMatch(
      /@media \(max-width: 520px\)[\s\S]*?\.json-summary\s*\{[^}]*min-height:\s*44px;/s,
    );
  });

  it('renders the labelled raw payload through the Pack host', async () => {
    const rig = mount(async () => jsonResult());
    await settle();

    expect(rig.root.innerHTML).toContain('class="json-summary"');
    expect(rig.root.innerHTML).toContain('Provider payload');
    expect(rig.root.innerHTML).toContain(
      'provider-reference-with-a-long-unbroken-value',
    );
    rig.view.dispose();
  });
});

describe('pack app shared record-field results', () => {
  it('ships the field grid, bounded values, and phone stacking with the panel', () => {
    expect(RECIPE_RESULT_PANEL_STYLES).toMatch(
      /\.summary-row\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(100px, 180px\) minmax\(0, 1fr\);/s,
    );
    expect(RECIPE_RESULT_PANEL_STYLES).toMatch(
      /\.summary-row dd\s*\{[^}]*margin:\s*0;[^}]*overflow-wrap:\s*anywhere;/s,
    );
    expect(RECIPE_RESULT_PANEL_STYLES).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.summary-row\s*\{[^}]*grid-template-columns:\s*1fr;/s,
    );
  });

  it('renders resolved and absent fields through the Pack host', async () => {
    const rig = mount(async () => recordFieldsResult());
    await settle();

    expect(rig.root.innerHTML).toContain('data-recued-output-record-fields="job"');
    expect(rig.root.innerHTML).toContain('Replace the circulation pump');
    expect(rig.root.innerHTML).toContain('class="record-field-unset"');
    expect(rig.root.innerHTML).toContain('Not set');
    rig.view.dispose();
  });
});

describe('pack app shared AI-analysis results', () => {
  it('ships structured rows and bounded long-text fallbacks with the panel', () => {
    expect(RECIPE_RESULT_PANEL_STYLES).toMatch(
      /\.ai-block\s*\{[^}]*display:\s*grid;[^}]*min-width:\s*0;/s,
    );
    expect(RECIPE_RESULT_PANEL_STYLES).toMatch(
      /\.ai-block p\s*\{[^}]*overflow-wrap:\s*anywhere;/s,
    );
    expect(RECIPE_RESULT_PANEL_STYLES).toMatch(
      /\.ai-json\s*\{[^}]*max-width:\s*100%;[^}]*white-space:\s*pre-wrap;[^}]*overflow-wrap:\s*anywhere;/s,
    );
    expect(RECIPE_RESULT_PANEL_STYLES).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.ai-row\s*\{[^}]*grid-template-columns:\s*1fr;/s,
    );
  });

  it('renders curated analysis and raw fallback data through the Pack host', async () => {
    const rig = mount(async () => aiAnalysisResult());
    await settle();

    expect(rig.root.innerHTML.match(/class="block ai-block"/g)).toHaveLength(2);
    expect(rig.root.innerHTML).toContain('Customer follow-up');
    expect(rig.root.innerHTML).toContain('class="ai-points"');
    expect(rig.root.innerHTML).toContain('class="ai-json"');
    rig.view.dispose();
  });
});

describe('pack app shared link-button results', () => {
  it('ships full-sized, wrapping anchors and descriptions with the panel', () => {
    expect(RECIPE_RESULT_PANEL_STYLES).toMatch(
      /\.link-button-block\s*\{[^}]*display:\s*grid;[^}]*gap:\s*10px;/s,
    );
    expect(RECIPE_RESULT_PANEL_STYLES).toMatch(
      /\.link-button-link\s*\{[^}]*min-height:\s*36px;[^}]*overflow-wrap:\s*anywhere;/s,
    );
    expect(RECIPE_RESULT_PANEL_STYLES).toMatch(
      /\.link-button-description\s*\{[^}]*font-size:\s*12px;[^}]*overflow-wrap:\s*anywhere;/s,
    );
    expect(RECIPE_RESULT_PANEL_STYLES).toMatch(
      /@media \(max-width: 520px\)[\s\S]*?\.link-button-link\s*\{[^}]*min-height:\s*44px;/s,
    );
  });

  it('renders safe external anchors through the Pack host', async () => {
    const rig = mount(async () => linkButtonResult());
    await settle();

    expect(rig.root.innerHTML.match(/class="link-button-link"/g)).toHaveLength(2);
    expect(rig.root.innerHTML).toContain(
      'href="https://example.com/work/job_1"',
    );
    expect(rig.root.innerHTML).toContain('rel="noopener noreferrer"');
    expect(rig.root.innerHTML).toContain('Review the provider work item.');
    rig.view.dispose();
  });
});

describe('pack app shared file-artifact results', () => {
  it('ships a bounded header and phone-stacked identity with the panel', () => {
    expect(RECIPE_RESULT_PANEL_STYLES).toMatch(
      /\.recipes-file-artifact\s*\{[^}]*min-width:\s*0;/s,
    );
    expect(RECIPE_RESULT_PANEL_STYLES).toMatch(
      /\.recipes-file-artifact-header > div\s*\{[^}]*min-width:\s*0;/s,
    );
    expect(RECIPE_RESULT_PANEL_STYLES).toMatch(
      /\.recipes-file-artifact-header h4,[\s\S]*?\.recipes-file-artifact-header p\s*\{[^}]*overflow-wrap:\s*anywhere;/s,
    );
    expect(RECIPE_RESULT_PANEL_STYLES).toMatch(
      /@media \(max-width: 520px\)[\s\S]*?\.recipes-file-artifact-header\s*\{[^}]*display:\s*grid;/s,
    );
  });

  it('renders exact-file identity and read controls through the Pack host', async () => {
    const rig = mount(async () => fileArtifactResult());
    await settle();

    expect(rig.root.innerHTML).toContain('Signed customer agreement');
    expect(rig.root.innerHTML).toContain('customer-agreement.pdf');
    expect(rig.root.innerHTML).toContain('Exact immutable file');
    expect(rig.root.innerHTML).toContain('Preview exact PDF');
    expect(rig.root.innerHTML).toContain('Download exact PDF');
    rig.view.dispose();
  });
});

describe('pack app view tabs', () => {
  it('ships full-sized desktop and phone tab targets', () => {
    expect(PACK_APP_STYLES).toMatch(
      /\.pack-app-view-tab\s*\{[^}]*min-height:\s*36px;/s,
    );
    expect(PACK_APP_STYLES).toMatch(
      /@media \(max-width: 560px\)[\s\S]*?\.pack-app-view-tab\s*\{[^}]*min-height:\s*44px;/s,
    );
  });

  it('forms one controlled tab stop and switches the named panel', async () => {
    const execute = vi.fn<PackAppExecuteCaller>(async ({ recipe_id }) => ({
      ...tableResult(),
      recipe_id,
      recipe_hash: `hash-${recipe_id}`,
    }));
    const rig = mount(execute, {
      surface: {
        ...surface,
        views: [
          surface.views[0]!,
          {
            recipe_id: lookupEntry.recipe_id,
            name: 'Find entry',
            description: 'Review one entry.',
            entry: lookupEntry,
          },
        ],
      },
      installedRecipes: [entry, lookupEntry],
    });
    await settle();

    expect(rig.root.innerHTML).toMatch(
      new RegExp(
        `aria-selected="true"\\s+tabindex="0"[^>]+${PACK_APP_VIEW_TAB_ATTR}="sheet"`,
      ),
    );
    expect(rig.root.innerHTML).toMatch(
      new RegExp(
        `aria-selected="false"\\s+tabindex="-1"[^>]+${PACK_APP_VIEW_TAB_ATTR}="find-entry"`,
      ),
    );
    expect(rig.root.innerHTML).toContain(
      'aria-controls="recued-pack-app-view-panel"',
    );
    expect(rig.root.innerHTML).toContain(
      `${PACK_APP_VIEW_PANEL_ATTR}="" id="recued-pack-app-view-panel"`
        + ' role="tabpanel" aria-labelledby="recued-pack-app-view-tab-sheet"',
    );

    emitPackControl(rig.root, PACK_APP_VIEW_TAB_ATTR, 'find-entry');
    await settle();

    expect(execute).toHaveBeenNthCalledWith(2, {
      recipe_id: 'find-entry',
      config: {},
    });
    expect(rig.view.activeViewId()).toBe('find-entry');
    expect(rig.root.innerHTML).toMatch(
      new RegExp(
        `aria-selected="true"\\s+tabindex="0"[^>]+${PACK_APP_VIEW_TAB_ATTR}="find-entry"`,
      ),
    );
    expect(rig.root.innerHTML).toContain(
      'role="tabpanel"'
        + ' aria-labelledby="recued-pack-app-view-tab-find-entry"',
    );
    rig.view.dispose();
  });

  it('hydrates a runtime-derived view without reporting a user navigation', async () => {
    const execute = vi.fn<PackAppExecuteCaller>(async ({ recipe_id }) => ({
      ...tableResult(),
      recipe_id,
      recipe_hash: `hash-${recipe_id}`,
    }));
    const onSelectView = vi.fn();
    const rig = mount(execute, {
      surface: {
        ...surface,
        views: [
          surface.views[0]!,
          {
            recipe_id: lookupEntry.recipe_id,
            name: 'Find entry',
            description: 'Review one entry.',
            entry: lookupEntry,
          },
        ],
      },
      installedRecipes: [entry, lookupEntry],
      initialViewId: 'find-entry',
      onSelectView,
    });
    await settle();

    expect(rig.view.activeViewId()).toBe('find-entry');
    expect(execute).toHaveBeenNthCalledWith(1, {
      recipe_id: 'find-entry',
      config: {},
    });
    expect(onSelectView).not.toHaveBeenCalled();

    emitPackControl(rig.root, PACK_APP_VIEW_TAB_ATTR, 'sheet');
    await settle();
    expect(onSelectView).toHaveBeenCalledWith('sheet');
    rig.view.dispose();
  });
});

describe('pack app shared editable tables', () => {
  it('edits and saves through the same config + invocation boundary as Recipes', async () => {
    const execute = vi.fn<PackAppExecuteCaller>(async () => tableResult());
    const rig = mount(execute);
    await settle();

    const key = 'sheet#grid-0';
    expect(rig.root.innerHTML).toContain(`${RECIPES_ROUTE_RESULT_GRID_ATTR}="${key}"`);
    const chrome = typeGridCell(rig.root, key, '0:amount', '125.00');
    expect(rig.view.hasUnsavedChanges()).toBe(true);
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
    expect(rig.view.hasUnsavedChanges()).toBe(false);
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

  it('reports initial runs and result filters as in-flight host work', async () => {
    const result = {
      recipe_id: 'sheet', recipe_hash: 'execution-hash', success: true,
      steps: [], errors: [],
      output: { render: [{
        type: 'filter', data: {},
        filter: {
          section_index: 0, recipe_hash: 'stored-sheet-hash',
          fields: ['status'], hidden: [], submit: 'Search',
          definitions: { status: { label: 'Status', type: 'text', default: 'open' } },
          values: { status: 'open' },
        },
      }] },
    } as unknown as ServerExecuteResponse;
    let resolveFilter!: (value: ServerExecuteResponse) => void;
    const pendingFilter = new Promise<ServerExecuteResponse>((resolve) => {
      resolveFilter = resolve;
    });
    const execute = vi.fn<PackAppExecuteCaller>()
      .mockResolvedValueOnce(result)
      .mockReturnValueOnce(pendingFilter);
    const rig = mount(execute);

    expect(rig.view.hasInFlightWork()).toBe(true);
    await settle();
    expect(rig.view.hasInFlightWork()).toBe(false);
    expect(rig.root.innerHTML).toContain('result-filter-search');
    expect(rig.root.innerHTML).toContain('sheet:stored-sheet-hash:0');

    emitAction(rig.root, 'result-filter-search', {
      'data-recued-recipes-result-filter': 'sheet:stored-sheet-hash:0',
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(rig.view.hasInFlightWork()).toBe(true);
    expect(rig.root.innerHTML).toMatch(
      new RegExp(`${PACK_APP_REFRESH_ATTR}=""[^>]* disabled`),
    );
    emitPackControl(rig.root, PACK_APP_REFRESH_ATTR);
    expect(execute).toHaveBeenCalledTimes(2);
    resolveFilter(result);
    await settle();
    expect(rig.view.hasInFlightWork()).toBe(false);
    expect(rig.root.innerHTML).not.toMatch(
      new RegExp(`${PACK_APP_REFRESH_ATTR}=""[^>]* disabled`),
    );
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
  it('keeps the audit-backed Run facts receipt inside Pack Use', () => {
    let onRan: ((result: ServerExecuteResponse) => void) | undefined;
    const rig = mount(vi.fn<PackAppExecuteCaller>(), {
      surface: {
        views: [],
        lookups: [],
        operations: [{
          recipe_id: taskEntry.recipe_id,
          name: 'Post entry',
          description: 'Record both sides and keep the receipt.',
          entry: taskEntry,
        }],
        automations: [],
        missing: [],
      },
      installedRecipes: [taskEntry],
      openRunModal: (_entry, callback) => { onRan = callback; },
    });

    emitPackControl(rig.root, PACK_APP_OPERATION_ATTR, taskEntry.recipe_id);
    onRan?.({
      ...taskResult(taskEntry.recipe_id, 'Entry posted'),
      run_facts: {
        steps_run: 34,
        items_total: 1_249,
        provider_calls: 2,
        total_tokens: 13_385,
        duration_ms: 42_000,
      },
    });

    expect(rig.root.innerHTML).toContain(RECIPES_ROUTE_RESULT_FACTS_ATTR);
    expect(rig.root.innerHTML).toContain(
      '34 steps · 1,249 items · 2 provider calls · 13,385 tokens · 42 seconds',
    );
    expect(rig.root.innerHTML).not.toContain(' · 12 ms · 0 steps');
    rig.view.dispose();
  });

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

  it('refreshes a dynamic list with its executed filter and restores its draft after a row action returns', async () => {
    const filteredActionResult = {
      recipe_id: 'sheet',
      recipe_hash: 'execution-hash',
      success: true,
      steps: [],
      errors: [],
      output: {
        render: [
          {
            type: 'filter',
            data: {},
            filter: {
              section_index: 0,
              recipe_hash: entry.recipe_hash,
              fields: ['status'],
              hidden: [],
              submit: 'Search',
              definitions: {
                status: { label: 'Status', type: 'string', default: 'open' },
              },
              values: { status: 'open' },
            },
          },
          {
            type: 'button',
            data: {
              kind: 'recipe.run',
              label: 'Open row',
              recipe_id: lookupEntry.recipe_id,
              context: { entity_id: 'row-1' },
            },
          },
        ],
      },
    } as unknown as ServerExecuteResponse;
    const execute = vi.fn<PackAppExecuteCaller>(async () => filteredActionResult);
    let onRan: ((result: ServerExecuteResponse) => void) | undefined;
    const rig = mount(execute, {
      installedRecipes: [entry, lookupEntry],
      openRunModal: (_entry, callback) => { onRan = callback; },
    });
    await settle();

    const filterKey = `sheet:${entry.recipe_hash}:0`;
    typeResultFilter(rig.root, filterKey, 'status', 'closed');
    emitAction(rig.root, 'run-result-action', {
      'data-recued-recipes-result-action': 'result-action-0',
    });
    onRan?.(taskResult(lookupEntry.recipe_id, 'Row detail'));
    expect(rig.root.innerHTML).toContain('Row detail');

    emitAction(rig.root, 'restore-result-panel', {});
    await settle();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[0]).toMatchObject({
      recipe_id: entry.recipe_id,
      config: { status: 'open' },
      invocation: {
        kind: 'output.filter',
        recipe_hash: entry.recipe_hash,
        section_index: 0,
      },
    });
    expect(rig.root.innerHTML).toContain('value="closed"');
    expect(rig.root.innerHTML).not.toContain('value="open"');
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
      automations: [],
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

describe('pack app reactive defaults', () => {
  it('offers lifecycle management without exposing or executing a manual run', () => {
    const reactiveEntry = {
      ...taskEntry,
      recipe_id: 'sync-provider-events',
      recipe: {
        ...taskEntry.recipe,
        recipe_id: 'sync-provider-events',
        auto_run: { interval_ms: 60_000 },
        metadata: {
          ...taskEntry.recipe.metadata,
          name: 'Sync provider events',
          description: 'Process events after the provider trigger arrives.',
        },
      },
    } as unknown as ServerRecipeListEntry;
    const execute = vi.fn<PackAppExecuteCaller>();
    const rig = mount(execute, {
      surface: {
        views: [],
        lookups: [],
        operations: [],
        automations: [{
          recipe_id: reactiveEntry.recipe_id,
          name: 'Sync provider events',
          description: 'Process events after the provider trigger arrives.',
          entry: reactiveEntry,
        }],
        missing: [],
      },
      installedRecipes: [reactiveEntry],
    });

    expect(rig.root.innerHTML).toContain('Manage this pack’s trigger-driven recipes below.');
    expect(rig.root.innerHTML).toContain('These recipes wait for their own triggers.');
    expect(rig.root.innerHTML).toContain(
      `${PACK_APP_AUTOMATION_ATTR}="sync-provider-events"`,
    );
    expect(rig.root.innerHTML).toContain('href="#automation/sync-provider-events"');
    expect(rig.root.innerHTML).toContain(
      'data-recued-reference-id="sync-provider-events"',
    );
    expect(rig.root.innerHTML).not.toContain(
      `${PACK_APP_OPERATION_ATTR}="sync-provider-events"`,
    );
    expect(execute).not.toHaveBeenCalled();
    rig.view.dispose();
  });
});

/** ⛔ A button that answers nothing is the worst failure this surface has: the
 *  person cannot tell a refusal from a broken build, and "nothing happened" is
 *  neither reportable nor debuggable. Every path that declines to open a run now
 *  names itself. */
describe('pack app — a press that cannot open says why', () => {
  const opsSurface = (recipeId: string): PackAppSurface => ({
    ...surface,
    operations: [{
      recipe_id: recipeId,
      name: 'Post entry',
      description: 'Record both sides and keep the receipt.',
      entry: taskEntry,
    }],
  });

  it('names the target when the roster no longer holds it', async () => {
    const rig = mount(vi.fn<PackAppExecuteCaller>().mockResolvedValue(tableResult()), {
      surface: opsSurface(taskEntry.recipe_id),
      installedRecipes: [entry, taskEntry],
      openRunModal: vi.fn(),
    });
    await settle();
    // A stale button id — the shape the lookup is supposed to make impossible.
    emitPackControl(rig.root, PACK_APP_OPERATION_ATTR, 'vanished-recipe');
    expect(rig.root.innerHTML).toContain(`${PACK_APP_STATUS_ATTR}="error"`);
    expect(rig.root.innerHTML).toContain('vanished-recipe');
  });

  it('says so when the view cannot open a run at all', async () => {
    // `openRunModal` absent normally hides the operations row, so this state can
    // only arise if the two ever disagree — which is precisely when a silent
    // swallow would be indistinguishable from a dead button.
    const rig = mount(vi.fn<PackAppExecuteCaller>().mockResolvedValue(tableResult()), {
      surface: opsSurface(taskEntry.recipe_id),
      installedRecipes: [entry, taskEntry],
    });
    await settle();
    emitPackControl(rig.root, PACK_APP_OPERATION_ATTR, taskEntry.recipe_id);
    expect(rig.root.innerHTML).toContain('cannot open a run on this server');
  });

  it('a press that CAN open still opens — the guards did not eat the happy path', async () => {
    const openRunModal = vi.fn<NonNullable<MountPackAppViewOptions['openRunModal']>>();
    const rig = mount(vi.fn<PackAppExecuteCaller>().mockResolvedValue(tableResult()), {
      surface: opsSurface(taskEntry.recipe_id),
      installedRecipes: [entry, taskEntry],
      openRunModal,
    });
    await settle();
    emitPackControl(rig.root, PACK_APP_OPERATION_ATTR, taskEntry.recipe_id);
    expect(openRunModal).toHaveBeenCalledTimes(1);
    expect(rig.root.innerHTML).not.toContain(`${PACK_APP_STATUS_ATTR}="error"`);
  });
});

/** The shared install-offer, on the pack-app surface.
 *
 *  ⛔ WIRED HERE FOR THE REASON IT WAS MADE SHARED. This view has its own
 *  execute path, so an offer wired only into the recipes route would leave a
 *  pack app printing `pack not installed: recued-core.docling` as bare text —
 *  the exact inconsistency the component exists to prevent.
 *
 *  Only the VIEW-LEVEL run is wired. The filter and grid-edit re-runs land in a
 *  per-cell error slot where a multi-line card does not structurally fit, and
 *  they re-run a recipe that just succeeded — reaching them needs the pack
 *  uninstalled between two clicks. Their plain message already names it.
 */
describe('pack app view — missing pack offer', () => {
  const packError = (packs: string[]): RpcError =>
    new RpcError('pack_not_installed', 'needs packs', 400, undefined, {
      missing_packs: packs,
    });

  it('renders the offer instead of the bare message', async () => {
    const execute = vi.fn<PackAppExecuteCaller>(async () => {
      throw packError(['recued-core.docling', 'recued-core.whisper']);
    });
    const rig = mount(execute);
    await settle();

    expect(rig.root.innerHTML).toContain(PACK_INSTALL_OFFER_ATTR);
    expect(rig.root.innerHTML).toContain('href="#packs/docling"');
    expect(rig.root.innerHTML).toContain('href="#packs/whisper"');
    // …and NOT the raw text it replaced.
    expect(rig.root.innerHTML).not.toContain('pack-app-error');
  });

  it('keeps the plain message for every other failure', async () => {
    // The offer must not swallow errors it cannot act on.
    const execute = vi.fn<PackAppExecuteCaller>(async () => {
      throw new RpcError('bad_request', 'something else went wrong', 400);
    });
    const rig = mount(execute);
    await settle();

    expect(rig.root.innerHTML).not.toContain(PACK_INSTALL_OFFER_ATTR);
    expect(rig.root.innerHTML).toContain('pack-app-error');
    expect(rig.root.innerHTML).toContain('something else went wrong');
  });
});
