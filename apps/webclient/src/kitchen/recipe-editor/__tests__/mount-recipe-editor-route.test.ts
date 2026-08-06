import { describe, expect, it, vi } from 'vitest';
import type {
  RecipeDefinition,
  RecipeEventTrigger,
  ServerRecipeListEntry,
} from '@recued/contracts';
import {
  validateRecipeContent,
  validateRecipeEventTriggerEntry,
} from '@recued/contracts';

import {
  FORM_RESPONSE_AUTOMATION_BACK_ATTR,
  FORM_RESPONSE_AUTOMATION_CREATE_ATTR,
  FORM_RESPONSE_AUTOMATION_DISCOVERY_ATTR,
  FORM_RESPONSE_AUTOMATION_ITEM_ATTR,
  FORM_RESPONSE_AUTOMATION_SCOPE_ATTR,
  FORM_RESPONSE_WORKFLOW_TEMPLATE_ATTR,
  FORM_RESPONSE_WORKFLOW_TEMPLATE_USE_ATTR,
  MOUNT_RECIPE_EDITOR_BACK_ATTR,
  MOUNT_RECIPE_EDITOR_HOST_ATTR,
  MOUNT_RECIPE_EDITOR_RETRY_ATTR,
  MOUNT_RECIPE_EDITOR_STATUS_ATTR,
  mountFormResponseRecipeSeedRoute,
  mountRecipeEditorRoute,
} from '../mount-recipe-editor-route.js';
import {
  findFormResponseAutomations,
  findFormResponseWorkflowTemplates,
} from '../form-response-automation-discovery.js';
import {
  RECIPE_EDITOR_FORM_RESPONSE_READER_ATTR,
  RECIPE_EDITOR_RECIPE_ID_ATTR,
  RECIPE_EDITOR_ROUTE_ATTR,
  RECIPE_EDITOR_SAVE_ATTR,
  RECIPE_EDITOR_TRIGGER_FORM_ID_ATTR,
  RECIPE_EDITOR_WEBHOOKS_ATTR,
} from '../recipe-editor-route.js';
import {
  createFormResponseAutomationFromWorkflowTemplate,
  createFormResponseAutomationDraftKey,
  createFormResponseAutomationSeed,
} from '../form-response-automation-seed.js';

// ────────────────────────────────────────────────────────────────
// Fake DOM harness (adapted from the recipe-editor test — proven to
// render the full editor, so the success path exercises the real mount).
// ────────────────────────────────────────────────────────────────

interface FakeElement {
  tagName: string;
  textContent: string;
  value: string;
  type: string;
  checked: boolean;
  disabled: boolean;
  selected: boolean;
  className: string;
  parent: FakeElement | null;
  attrs: Map<string, string>;
  children: FakeElement[];
  listeners: Map<string, Array<() => void>>;
  readonly firstChild: FakeElement | null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(el: FakeElement): FakeElement;
  removeChild(el: FakeElement): FakeElement;
  remove(): void;
  addEventListener(name: string, fn: () => void): void;
  click(): void;
  dispatch(name: string): void;
}

interface FakeDocument {
  styleElements: FakeElement[];
  head: {
    querySelector(sel: string): FakeElement | null;
    appendChild(el: FakeElement): FakeElement;
  };
  createElement(tag: string): FakeElement;
}

const makeFakeElement = (tagName: string): FakeElement => {
  let text = '';
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    // `textContent = ''` clears children (real-DOM semantics) — the wrapper
    // relies on it to swap the loading shell out before mounting the editor.
    get textContent() {
      return text;
    },
    set textContent(v: string) {
      text = v;
      if (v === '') el.children.splice(0, el.children.length);
    },
    value: '',
    type: '',
    checked: false,
    disabled: false,
    selected: false,
    className: '',
    parent: null,
    attrs: new Map(),
    children: [],
    listeners: new Map(),
    get firstChild() {
      return el.children[0] ?? null;
    },
    setAttribute(k, v) {
      el.attrs.set(k, v);
      if (k === 'type') el.type = v;
    },
    getAttribute(k) {
      return el.attrs.get(k) ?? null;
    },
    hasAttribute(k) {
      return el.attrs.has(k);
    },
    appendChild(child) {
      el.children.push(child);
      child.parent = el;
      return child;
    },
    removeChild(child) {
      const idx = el.children.indexOf(child);
      if (idx < 0) throw new Error('removeChild: child not found');
      el.children.splice(idx, 1);
      child.parent = null;
      return child;
    },
    remove() {
      if (el.parent) el.parent.removeChild(el);
    },
    addEventListener(name, fn) {
      const list = el.listeners.get(name) ?? [];
      list.push(fn);
      el.listeners.set(name, list);
    },
    click() {
      if (el.disabled) return;
      for (const fn of el.listeners.get('click') ?? []) fn();
    },
    dispatch(name) {
      for (const fn of el.listeners.get(name) ?? []) fn();
    },
  };
  return el;
};

const makeFakeDocument = (): FakeDocument => {
  const styleElements: FakeElement[] = [];
  const attrFromSelector = (sel: string): string | null => {
    const m = sel.match(/^style\[([\w-]+)\]$/);
    return m === null ? null : m[1]!;
  };
  return {
    styleElements,
    head: {
      querySelector(sel) {
        const attr = attrFromSelector(sel);
        if (attr === null) return null;
        return styleElements.find((s) => s.hasAttribute(attr)) ?? null;
      },
      appendChild(el) {
        styleElements.push(el);
        return el;
      },
    },
    createElement: (tag) => makeFakeElement(tag),
  };
};

const findAllByAttr = (
  root: FakeElement,
  attr: string,
  out: FakeElement[] = [],
): FakeElement[] => {
  if (root.hasAttribute(attr)) out.push(root);
  for (const child of root.children) findAllByAttr(child, attr, out);
  return out;
};

const findByAttr = (root: FakeElement, attr: string): FakeElement | undefined =>
  findAllByAttr(root, attr)[0];

const findByAttrValue = (
  root: FakeElement,
  attr: string,
  value: string,
): FakeElement | undefined =>
  findAllByAttr(root, attr).find((element) => element.getAttribute(attr) === value);

const tick = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

const sampleRecipe = (id = 'daily-brief'): RecipeDefinition => ({
  recipe_id: id,
  version: 1,
  ttl: 300,
  metadata: {
    name: 'Daily brief',
    description: '',
    author: '',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { render: [] },
});

const automationRecipe = (
  id: string,
  triggers: RecipeEventTrigger[],
): RecipeDefinition => ({
  ...sampleRecipe(id),
  metadata: {
    ...sampleRecipe(id).metadata,
    name: `Automation ${id}`,
  },
  event_triggers: triggers,
});

const entryFor = (recipe: RecipeDefinition): ServerRecipeListEntry => ({
  recipe_id: recipe.recipe_id,
  publisher_id: 'recued-core',
  version: recipe.version ?? 1,
  recipe_hash: 'hash',
  recipe,
  source: 'bundled',
  installed_at: 0,
});

const workflowTemplateEntry = (
  overrides: Partial<ServerRecipeListEntry> = {},
): ServerRecipeListEntry => {
  const recipe: RecipeDefinition = {
    ...sampleRecipe('start-paid-document-fulfillment'),
    metadata: {
      name: 'Start paid document fulfillment',
      description: 'Preview-only installed workflow origin.',
      author: 'recued-core',
      supported_platforms: [],
      recipe_bundle: 'recued-core/paid-document-fulfillment',
      tags: ['form-response-template', 'recipe-role:origin'],
    },
    variables: {
      template_file_ref: {
        label: 'Markdown template',
        type: 'file_ref',
        default: null,
      },
    },
    prefetch_steps: [{
      id: 'form_response',
      op: 'core.data.form-response.get',
      args: { submission_id: '{{context.event.payload.record_id}}' },
    }],
    steps: [{
      id: 'state_key',
      transform: 'template',
      template: 'data.shared.recipe.recued-core_paid-document-fulfillment.state.{{step.form_response.record.submission_id}}',
    }],
    output: { render: [{ type: 'text', source: 'step.state_key' }] },
  };
  return {
    ...entryFor(recipe),
    source: 'pair-sync',
    installed_at: 1,
    ...overrides,
  };
};

const okValidate = async () => ({ ok: true, issues: [] });
const okSave = async (args: { recipe: RecipeDefinition }) => ({
  saved: true as const,
  recipe_id: args.recipe.recipe_id,
  version: 1,
  name: args.recipe.metadata.name,
});

const mount = (opts: {
  recipeId?: string;
  listCaller: () => Promise<{ recipes: ReadonlyArray<ServerRecipeListEntry> }>;
  saveCaller?: (args: {
    recipe: RecipeDefinition;
    publisher_id?: string;
    webhook_bindings?: ReadonlyArray<{ binding: string; ingress_id: string }>;
  }) => Promise<{
    saved: true;
    recipe_id: string;
    version: number;
    name: string;
  }>;
  webhookIngressListCaller?: () => Promise<{ ingresses: never[] }>;
  webhookStatusCaller?: (args: { recipe_id: string }) => Promise<{
    webhook: {
      declared: boolean;
      configured: boolean;
      armed: boolean;
      bindings: ReadonlyArray<{ binding: string; ingress_id: string }>;
    };
  }>;
  webhookArmCaller?: (args: { recipe_id: string }) => Promise<never>;
  webhookDisarmCaller?: (args: { recipe_id: string }) => Promise<never>;
}) => {
  const doc = makeFakeDocument();
  const root = makeFakeElement('main');
  const handle = mountRecipeEditorRoute({
    root: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    recipeId: opts.recipeId ?? 'daily-brief',
    listCaller: opts.listCaller,
    validateCaller: okValidate,
    saveCaller: opts.saveCaller ?? okSave,
    ...(opts.webhookIngressListCaller
      ? { webhookIngressListCaller: opts.webhookIngressListCaller }
      : {}),
    ...(opts.webhookStatusCaller ? { webhookStatusCaller: opts.webhookStatusCaller } : {}),
    ...(opts.webhookArmCaller ? { webhookArmCaller: opts.webhookArmCaller } : {}),
    ...(opts.webhookDisarmCaller
      ? { webhookDisarmCaller: opts.webhookDisarmCaller }
      : {}),
  });
  return { doc, root, handle };
};

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

describe('mountRecipeEditorRoute — Edit→Kitchen loader', () => {
  it('shows a loading shell while the recipe list resolves', () => {
    const { root } = mount({
      // never resolves this tick — the loading shell is what renders first
      listCaller: () => new Promise(() => {}),
    });
    const status = findByAttr(root, MOUNT_RECIPE_EDITOR_STATUS_ATTR);
    expect(status).toBeDefined();
    expect(status!.getAttribute(MOUNT_RECIPE_EDITOR_STATUS_ATTR)).toBe('loading');
    expect(status!.textContent).toBe('Loading recipe…');
    // No back link + no editor while loading.
    expect(findByAttr(root, MOUNT_RECIPE_EDITOR_BACK_ATTR)).toBeUndefined();
    expect(findByAttr(root, RECIPE_EDITOR_ROUTE_ATTR)).toBeUndefined();
  });

  it('mounts the editor loaded on the resolved recipe + clears the loading shell', async () => {
    const recipe = sampleRecipe('daily-brief');
    const { root } = mount({
      listCaller: async () => ({ recipes: [entryFor(sampleRecipe('other')), entryFor(recipe)] }),
    });
    await tick();
    // Editor mounted; loading shell gone.
    expect(findByAttr(root, RECIPE_EDITOR_ROUTE_ATTR)).toBeDefined();
    expect(findByAttr(root, MOUNT_RECIPE_EDITOR_STATUS_ATTR)).toBeUndefined();
  });

  it('wires the save caller through to the editor (the resolved recipe saves)', async () => {
    const recipe = sampleRecipe('daily-brief');
    const saveCaller = vi.fn(okSave);
    const { root } = mount({
      listCaller: async () => ({ recipes: [entryFor(recipe)] }),
      saveCaller,
    });
    await tick();
    const saveBtn = findByAttr(root, RECIPE_EDITOR_SAVE_ATTR);
    expect(saveBtn).toBeDefined();
    saveBtn!.click();
    await tick();
    expect(saveCaller).toHaveBeenCalledTimes(1);
    expect(saveCaller.mock.calls[0]![0].recipe.recipe_id).toBe('daily-brief');
  });

  it('loads Kitchen webhook ingress choices and current arm state', async () => {
    const recipe = sampleRecipe('daily-brief');
    recipe.webhook_requirements = [{
      binding: 'generic_delivery',
      profile_ids: ['generic.static-header-token.v1'],
      required_event_types: ['delivery'],
      decoded_payload_access: 'metadata_only',
      source_truth_policy: 'delivery_payload_allowed',
    }];
    recipe.webhook_triggers = [{ binding: 'generic_delivery', event_types: ['delivery'] }];
    const listIngresses = vi.fn(async () => ({ ingresses: [] as never[] }));
    const status = vi.fn(async () => ({
      webhook: {
        declared: true,
        configured: false,
        armed: false,
        bindings: [],
      },
    }));
    const { root } = mount({
      listCaller: async () => ({ recipes: [entryFor(recipe)] }),
      webhookIngressListCaller: listIngresses,
      webhookStatusCaller: status,
      webhookArmCaller: async () => { throw new Error('not used'); },
      webhookDisarmCaller: async () => { throw new Error('not used'); },
    });
    await tick(16);

    expect(listIngresses).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith({ recipe_id: 'daily-brief' });
    expect(findByAttr(root, RECIPE_EDITOR_WEBHOOKS_ATTR)).toBeDefined();
  });

  it('renders a not-found error + a back link when the recipe is not installed', async () => {
    const { root } = mount({
      recipeId: 'missing',
      listCaller: async () => ({ recipes: [entryFor(sampleRecipe('other'))] }),
    });
    await tick();
    const status = findByAttr(root, MOUNT_RECIPE_EDITOR_STATUS_ATTR);
    expect(status).toBeDefined();
    expect(status!.getAttribute(MOUNT_RECIPE_EDITOR_STATUS_ATTR)).toBe('error');
    expect(status!.textContent).toContain("isn't installed");
    const back = findByAttr(root, MOUNT_RECIPE_EDITOR_BACK_ATTR);
    expect(back).toBeDefined();
    expect(back!.getAttribute('href')).toBe('#recipes/missing');
    // No editor mounted on the not-found path.
    expect(findByAttr(root, RECIPE_EDITOR_ROUTE_ATTR)).toBeUndefined();
  });

  it('renders an error + back link when the list caller rejects', async () => {
    const { root } = mount({
      listCaller: async () => {
        throw new Error('network down');
      },
    });
    await tick();
    const status = findByAttr(root, MOUNT_RECIPE_EDITOR_STATUS_ATTR);
    expect(status).toBeDefined();
    expect(status!.getAttribute(MOUNT_RECIPE_EDITOR_STATUS_ATTR)).toBe('error');
    expect(status!.getAttribute('role')).toBe('alert');
    expect(status!.textContent.length).toBeGreaterThan(0);
    expect(findByAttr(root, MOUNT_RECIPE_EDITOR_RETRY_ATTR)).toBeDefined();
    expect(findByAttr(root, MOUNT_RECIPE_EDITOR_BACK_ATTR)).toBeDefined();
    expect(findByAttr(root, RECIPE_EDITOR_ROUTE_ATTR)).toBeUndefined();
  });

  it('keeps a failed-load Retry single-flight and mounts the recovered recipe', async () => {
    let calls = 0;
    let resolveRetry!: (value: { recipes: ServerRecipeListEntry[] }) => void;
    const retryResult = new Promise<{ recipes: ServerRecipeListEntry[] }>((resolve) => {
      resolveRetry = resolve;
    });
    const listCaller = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('network down');
      return retryResult;
    });
    const { root } = mount({ listCaller });
    await tick();

    const retry = findByAttr(root, MOUNT_RECIPE_EDITOR_RETRY_ATTR);
    expect(retry).toBeDefined();
    retry!.click();
    const busyRetry = findByAttr(root, MOUNT_RECIPE_EDITOR_RETRY_ATTR);
    expect(busyRetry?.textContent).toBe('Retrying…');
    expect(busyRetry?.getAttribute('aria-disabled')).toBe('true');
    expect(busyRetry?.getAttribute('aria-busy')).toBe('true');
    retry!.click();
    busyRetry!.click();
    expect(listCaller).toHaveBeenCalledTimes(2);

    resolveRetry({ recipes: [entryFor(sampleRecipe('daily-brief'))] });
    await tick(16);
    expect(findByAttr(root, RECIPE_EDITOR_ROUTE_ATTR)).toBeDefined();
    expect(findByAttr(root, MOUNT_RECIPE_EDITOR_STATUS_ATTR)).toBeUndefined();
    expect(findByAttr(root, MOUNT_RECIPE_EDITOR_RETRY_ATTR)).toBeUndefined();
  });

  it('dispose removes the host + the mounted editor', async () => {
    const { root, handle } = mount({
      listCaller: async () => ({ recipes: [entryFor(sampleRecipe('daily-brief'))] }),
    });
    await tick();
    expect(findByAttr(root, MOUNT_RECIPE_EDITOR_HOST_ATTR)).toBeDefined();
    handle.dispose();
    expect(findByAttr(root, MOUNT_RECIPE_EDITOR_HOST_ATTR)).toBeUndefined();
    expect(findByAttr(root, RECIPE_EDITOR_ROUTE_ATTR)).toBeUndefined();
  });

  it('a dispose BEFORE the list resolves never mounts the editor (disposed guard)', async () => {
    let resolveList!: (v: { recipes: ServerRecipeListEntry[] }) => void;
    const pending = new Promise<{ recipes: ServerRecipeListEntry[] }>((res) => {
      resolveList = res;
    });
    const { root, handle } = mount({ listCaller: () => pending });
    // Loading shell up, then dispose before the fetch settles.
    expect(findByAttr(root, MOUNT_RECIPE_EDITOR_STATUS_ATTR)).toBeDefined();
    handle.dispose();
    // Late resolution must be a no-op — no editor, no re-added host.
    resolveList({ recipes: [entryFor(sampleRecipe('daily-brief'))] });
    await tick();
    expect(findByAttr(root, RECIPE_EDITOR_ROUTE_ATTR)).toBeUndefined();
    expect(findByAttr(root, MOUNT_RECIPE_EDITOR_HOST_ATTR)).toBeUndefined();
  });
});

describe('mountFormResponseRecipeSeedRoute — Data → Kitchen handoff', () => {
  const draftKey = '0123456789abcdef0123456789abcdef';

  it('discovers only automations provably applicable from the form id', () => {
    const exact = entryFor(automationRecipe('exact', [{
      on: 'form_response.accepted',
      where: { form_definition_id: 'project-intake' },
    }]));
    const allForms = entryFor(automationRecipe('all', [{
      on: 'form_response.accepted',
    }]));
    const exactAndAll = entryFor(automationRecipe('both', [
      { on: 'form_response.accepted' },
      {
        on: 'form_response.accepted',
        where: { form_definition_id: 'project-intake' },
      },
    ]));
    const exactFiltered = entryFor(automationRecipe('filtered', [{
      on: 'form_response.accepted',
      where: {
        form_definition_id: 'project-intake',
        endpoint_id: 'endpoint-1',
      },
    }]));
    const filteredAndAll = entryFor(automationRecipe('filtered-and-all', [
      {
        on: 'form_response.accepted',
        where: {
          form_definition_id: 'project-intake',
          id: 'submission-1',
        },
      },
      { on: 'form_response.accepted' },
    ]));
    const anotherForm = entryFor(automationRecipe('other-form', [{
      on: 'form_response.accepted',
      where: { form_definition_id: 'another-form' },
    }]));
    const endpointOnly = entryFor(automationRecipe('endpoint-only', [{
      on: 'form_response.accepted',
      where: { endpoint_id: 'endpoint-1' },
    }]));
    const responseOnly = entryFor(automationRecipe('response-only', [{
      on: 'form_response.accepted',
      where: { id: 'submission-1' },
    }]));
    const unrelated = entryFor(automationRecipe('unrelated', [{
      on: 'task.created',
    }]));

    expect(findFormResponseAutomations([
      exact,
      allForms,
      exactAndAll,
      exactFiltered,
      filteredAndAll,
      anotherForm,
      endpointOnly,
      responseOnly,
      unrelated,
    ], 'project-intake')).toEqual([
      { entry: exact, scope: 'this_form' },
      { entry: allForms, scope: 'all_forms' },
      // Exact wins the explanation and the recipe appears only once.
      { entry: exactAndAll, scope: 'this_form' },
      { entry: exactFiltered, scope: 'this_form_filtered' },
      // A broad trigger is more truthful than the recipe's filtered sibling.
      { entry: filteredAndAll, scope: 'all_forms' },
    ]);
    expect(findFormResponseAutomations([exact], ' project-intake ')).toEqual([]);
  });

  it('skips malformed triggers without crashing discovery for valid siblings', () => {
    const valid = entryFor(automationRecipe('valid', [{
      on: 'form_response.accepted',
      where: { form_definition_id: 'project-intake' },
    }]));
    // Runtime-only shapes an import / legacy write can leave behind: `where` is
    // typed `Record | undefined`, so `null` / `[]` / a templated value slip past
    // the compiler. They must be skipped, not advertised — and a single bad row
    // must never throw out of the whole lookup (the regression: `Object.keys(null)`
    // used to escape the loop and hide every other form's saved automations).
    const whereNull = entryFor(automationRecipe('where-null', [
      { on: 'form_response.accepted', where: null } as unknown as RecipeEventTrigger,
    ]));
    const whereArray = entryFor(automationRecipe('where-array', [
      { on: 'form_response.accepted', where: [] } as unknown as RecipeEventTrigger,
    ]));
    const templated = entryFor(automationRecipe('templated', [{
      on: 'form_response.accepted',
      where: { form_definition_id: 'project-intake', endpoint_id: '{{config.ep}}' },
    }]));

    expect(findFormResponseAutomations(
      [whereNull, valid, whereArray, templated],
      'project-intake',
    )).toEqual([{ entry: valid, scope: 'this_form' }]);
  });

  it('mints a fresh slug-safe 128-bit key for every new starter', () => {
    const first = createFormResponseAutomationDraftKey();
    const second = createFormResponseAutomationDraftKey();
    expect(first).toMatch(/^[a-f0-9]{32}$/);
    expect(second).toMatch(/^[a-f0-9]{32}$/);
    expect(second).not.toBe(first);
  });

  it('builds the privacy-minimized accepted-response recipe seed', () => {
    const seed = createFormResponseAutomationSeed('project/intake.v2', draftKey);
    expect(seed).toEqual({
      recipe_id: 'handle-form-0123456789abcdef0123456789abcdef-responses',
      version: 1,
      ttl: 300,
      metadata: {
        name: 'Handle accepted form responses',
        description: 'Runs after the owner accepts a response from this intake form.',
        author: 'local',
        supported_platforms: [],
      },
      variables: {},
      event_triggers: [{
        on: 'form_response.accepted',
        where: { form_definition_id: 'project/intake.v2' },
      }],
      prefetch_steps: [{
        id: 'form_response',
        op: 'core.data.form-response.get',
        args: { submission_id: '{{context.event.payload.record_id}}' },
      }],
      steps: [],
      output: { render: [] },
    });
    expect(
      validateRecipeContent(seed as unknown as Record<string, unknown>),
    ).toEqual([]);
    expect(validateRecipeEventTriggerEntry(seed.event_triggers![0]!)).toEqual([]);
    expect(() => createFormResponseAutomationSeed('   ', draftKey)).toThrow(
      'form definition id',
    );
    expect(() => createFormResponseAutomationSeed('project-intake', 'bad')).toThrow(
      '128-bit lowercase hex draft key',
    );
    const paddedId = '  project/intake.v2  ';
    expect(
      createFormResponseAutomationSeed(paddedId, draftKey).event_triggers?.[0]?.where
        ?.form_definition_id,
    ).toBe(paddedId);
    expect(
      createFormResponseAutomationSeed('client-intake', draftKey).recipe_id,
    ).not.toBe(
      createFormResponseAutomationSeed(
        'client-intake',
        'fedcba9876543210fedcba9876543210',
      ).recipe_id,
    );
    const longId = `form-${'x'.repeat(600)}`;
    const longSeed = createFormResponseAutomationSeed(longId, draftKey);
    expect(longSeed.metadata.name.length).toBeLessThanOrEqual(100);
    expect(longSeed.metadata.description.length).toBeLessThanOrEqual(500);
    expect(longSeed.event_triggers?.[0]?.where?.form_definition_id).toBe(longId);
    expect(
      validateRecipeContent(longSeed as unknown as Record<string, unknown>),
    ).toEqual([]);
    const markupId = '<script>\nclient-intake';
    const markupSeed = createFormResponseAutomationSeed(markupId, draftKey);
    expect(markupSeed.metadata.name).not.toContain('<');
    expect(markupSeed.metadata.description).not.toContain(markupId);
    expect(markupSeed.event_triggers?.[0]?.where?.form_definition_id).toBe(markupId);
    expect(
      validateRecipeContent(markupSeed as unknown as Record<string, unknown>),
    ).toEqual([]);
    expect(
      validateRecipeContent(
        createFormResponseAutomationSeed('fuck', draftKey) as unknown as Record<string, unknown>,
      ),
    ).toEqual([]);
  });

  it('discovers only installed, inert, canonical workflow templates', () => {
    const installed = workflowTemplateEntry();
    const bundledOnly = workflowTemplateEntry({ source: 'bundled' });
    const inlineOnly = workflowTemplateEntry({ source: 'inline' });
    const armed = workflowTemplateEntry();
    armed.recipe.event_triggers = [{ on: 'form_response.accepted' }];
    const webhookArmed = workflowTemplateEntry();
    (webhookArmed.recipe as unknown as { webhook_triggers: unknown[] })
      .webhook_triggers = [{}];
    const reactive = workflowTemplateEntry();
    reactive.recipe.trigger_steps = [{
      id: 'unexpected-reactive-gate',
      transform: 'template',
      template: 'not inert',
    }];
    const noReader = workflowTemplateEntry();
    noReader.recipe.prefetch_steps = [];
    const wrongPublisher = workflowTemplateEntry({ publisher_id: 'other' });
    const wrongStoredIdentity = workflowTemplateEntry({
      recipe_id: 'different-row-id',
    });
    const malformedRecipe = workflowTemplateEntry();
    (malformedRecipe as unknown as { recipe: unknown }).recipe = null;
    const malformedPrefetch = workflowTemplateEntry();
    (malformedPrefetch.recipe as unknown as { prefetch_steps: unknown })
      .prefetch_steps = 'not-an-array';

    const candidates = [
      malformedRecipe,
      malformedPrefetch,
      bundledOnly,
      inlineOnly,
      armed,
      webhookArmed,
      reactive,
      noReader,
      wrongPublisher,
      wrongStoredIdentity,
      installed,
      installed,
    ];
    expect(() => findFormResponseWorkflowTemplates(candidates)).not.toThrow();
    expect(findFormResponseWorkflowTemplates(candidates)).toEqual([{
      entry: installed,
      bundle_key: 'recued-core/paid-document-fulfillment',
    }]);
  });

  it('clones an installed template to one literal form without changing shared keys', () => {
    const entry = workflowTemplateEntry();
    const sourceSnapshot = JSON.stringify(entry.recipe);
    const clone = createFormResponseAutomationFromWorkflowTemplate(
      entry,
      'project/intake.v2',
      draftKey,
    );

    expect(clone.recipe_id).toBe(
      'handle-form-0123456789abcdef0123456789abcdef-responses',
    );
    expect(clone.event_triggers).toEqual([{
      on: 'form_response.accepted',
      where: { form_definition_id: 'project/intake.v2' },
    }]);
    expect(clone.metadata.recipe_bundle).toBeUndefined();
    expect(clone.metadata.author).toBe('local');
    expect(clone.metadata.fork_of).toEqual({
      recipe_id: 'start-paid-document-fulfillment',
      author: 'recued-core',
      version: 1,
    });
    expect(clone.variables).toEqual(entry.recipe.variables);
    expect(clone.prefetch_steps).toEqual(entry.recipe.prefetch_steps);
    expect(clone.steps).toEqual(entry.recipe.steps);
    expect(JSON.stringify(clone)).toContain(
      'data.shared.recipe.recued-core_paid-document-fulfillment.state.',
    );
    expect(JSON.stringify(entry.recipe)).toBe(sourceSnapshot);
    expect(validateRecipeContent(clone as unknown as Record<string, unknown>)).toEqual([]);
    expect(validateRecipeEventTriggerEntry(clone.event_triggers![0]!)).toEqual([]);
  });

  it('offers Use installed workflow template and mounts the cloned exact-form draft', async () => {
    const template = workflowTemplateEntry();
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    let saved: RecipeDefinition | undefined;
    const handle = mountFormResponseRecipeSeedRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      formDefinitionId: 'project-intake',
      draftKey,
      listCaller: async () => ({ recipes: [template] }),
      validateCaller: okValidate,
      saveCaller: async ({ recipe }) => {
        saved = recipe;
        return okSave({ recipe });
      },
    });
    await tick();

    expect(findByAttrValue(
      root,
      FORM_RESPONSE_WORKFLOW_TEMPLATE_ATTR,
      template.recipe_id,
    )).toBeDefined();
    const use = findByAttrValue(
      root,
      FORM_RESPONSE_WORKFLOW_TEMPLATE_USE_ATTR,
      template.recipe_id,
    );
    expect(use?.textContent).toBe('Use installed workflow template');
    expect(use?.getAttribute('aria-label')).toBe(
      'Use installed workflow template Start paid document fulfillment (start-paid-document-fulfillment)',
    );
    expect(doc.styleElements[0]?.textContent).toContain('.rx-btn-primary');
    expect(doc.styleElements[0]?.textContent).toContain(
      `[${FORM_RESPONSE_WORKFLOW_TEMPLATE_USE_ATTR}]`,
    );
    expect(findByAttr(root, RECIPE_EDITOR_ROUTE_ATTR)).toBeUndefined();

    use?.click();
    expect(findByAttr(root, RECIPE_EDITOR_ROUTE_ATTR)).toBeDefined();
    expect(findByAttr(root, RECIPE_EDITOR_TRIGGER_FORM_ID_ATTR)?.value).toBe(
      'project-intake',
    );
    expect(handle.hasUnsavedChanges()).toBe(true);

    findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.click();
    await tick();
    expect(saved?.metadata.recipe_bundle).toBeUndefined();
    expect(saved?.metadata.fork_of?.recipe_id).toBe(template.recipe_id);
    expect(JSON.stringify(saved)).toContain(
      'data.shared.recipe.recued-core_paid-document-fulfillment.state.',
    );
  });

  it('mounts a seeded editor after finding no saved automation and protects it as unsaved', async () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const onSaved = vi.fn();
    const listCaller = vi.fn(async () => ({ recipes: [] }));
    const handle = mountFormResponseRecipeSeedRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      formDefinitionId: 'project-intake',
      draftKey,
      listCaller,
      validateCaller: okValidate,
      saveCaller: okSave,
      onSaved,
    });

    expect(
      findByAttr(root, MOUNT_RECIPE_EDITOR_STATUS_ATTR)?.textContent,
    ).toBe('Checking existing automations…');
    expect(handle.hasUnsavedChanges()).toBe(false);
    await tick();

    expect(listCaller).toHaveBeenCalledTimes(1);
    expect(findByAttr(root, RECIPE_EDITOR_ROUTE_ATTR)).toBeDefined();
    expect(findByAttr(root, RECIPE_EDITOR_RECIPE_ID_ATTR)?.value).toBe(
      'handle-form-0123456789abcdef0123456789abcdef-responses',
    );
    expect(findByAttr(root, RECIPE_EDITOR_TRIGGER_FORM_ID_ATTR)?.value).toBe(
      'project-intake',
    );
    expect(
      findByAttr(root, RECIPE_EDITOR_FORM_RESPONSE_READER_ATTR)?.getAttribute(
        RECIPE_EDITOR_FORM_RESPONSE_READER_ATTR,
      ),
    ).toBe('ready');
    expect(handle.hasUnsavedChanges()).toBe(true);

    findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.click();
    await tick();
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({
      recipe_id: 'handle-form-0123456789abcdef0123456789abcdef-responses',
    }));
    expect(handle.hasUnsavedChanges()).toBe(false);

    handle.dispose();
    expect(findByAttr(root, MOUNT_RECIPE_EDITOR_HOST_ATTR)).toBeUndefined();
    expect(handle.hasUnsavedChanges()).toBe(false);
  });

  it('shows exact, additionally filtered, and all-form recipes before creating another', async () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const exact = entryFor(automationRecipe('exact', [{
      on: 'form_response.accepted',
      where: { form_definition_id: 'project-intake' },
    }]));
    const allForms = entryFor(automationRecipe('all', [{
      on: 'form_response.accepted',
      where: {},
    }]));
    const filteredRecipe = automationRecipe('filtered', [{
      on: 'form_response.accepted',
      where: {
        form_definition_id: 'project-intake',
        endpoint_id: 'endpoint-1',
      },
    }]);
    // A legacy/malformed display name must not collapse every valid match.
    (filteredRecipe as unknown as { metadata?: unknown }).metadata = undefined;
    const filtered = entryFor(filteredRecipe);
    const handle = mountFormResponseRecipeSeedRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      formDefinitionId: 'project-intake',
      draftKey,
      listCaller: async () => ({ recipes: [exact, filtered, allForms] }),
      validateCaller: okValidate,
      saveCaller: okSave,
    });
    await tick();

    expect(findByAttr(root, FORM_RESPONSE_AUTOMATION_DISCOVERY_ATTR)).toBeDefined();
    const items = findAllByAttr(root, FORM_RESPONSE_AUTOMATION_ITEM_ATTR);
    expect(items.map((item) => item.getAttribute(FORM_RESPONSE_AUTOMATION_ITEM_ATTR)))
      .toEqual(['exact', 'filtered', 'all']);
    expect(items[0]?.children[0]?.getAttribute('href')).toBe(
      '#kitchen/recipe/exact',
    );
    expect(findAllByAttr(root, FORM_RESPONSE_AUTOMATION_SCOPE_ATTR).map(
      (scope) => scope.getAttribute(FORM_RESPONSE_AUTOMATION_SCOPE_ATTR),
    )).toEqual(['this_form', 'this_form_filtered', 'all_forms']);
    expect(items[1]?.children[0]?.children[0]?.textContent).toBe('filtered');
    expect(
      findAllByAttr(root, FORM_RESPONSE_AUTOMATION_SCOPE_ATTR)[1]?.getAttribute(
        'title',
      ),
    ).toBe('This recipe also narrows by response or endpoint.');
    expect(findByAttr(root, RECIPE_EDITOR_ROUTE_ATTR)).toBeUndefined();
    expect(handle.hasUnsavedChanges()).toBe(false);

    findByAttr(root, FORM_RESPONSE_AUTOMATION_CREATE_ATTR)?.click();
    expect(findByAttr(root, FORM_RESPONSE_AUTOMATION_DISCOVERY_ATTR)).toBeUndefined();
    expect(findByAttr(root, RECIPE_EDITOR_ROUTE_ATTR)).toBeDefined();
    expect(handle.hasUnsavedChanges()).toBe(true);
  });

  it('keeps authoring available when discovery fails, but requires an explicit choice', async () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const handle = mountFormResponseRecipeSeedRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      formDefinitionId: 'project-intake',
      draftKey,
      listCaller: async () => {
        throw new Error('offline');
      },
      validateCaller: okValidate,
      saveCaller: okSave,
    });
    await tick();

    expect(
      findByAttr(root, MOUNT_RECIPE_EDITOR_STATUS_ATTR)?.getAttribute(
        MOUNT_RECIPE_EDITOR_STATUS_ATTR,
      ),
    ).toBe('error');
    expect(findByAttr(root, RECIPE_EDITOR_ROUTE_ATTR)).toBeUndefined();
    expect(handle.hasUnsavedChanges()).toBe(false);

    findByAttr(root, FORM_RESPONSE_AUTOMATION_CREATE_ATTR)?.click();
    expect(findByAttr(root, RECIPE_EDITOR_ROUTE_ATTR)).toBeDefined();
    expect(handle.hasUnsavedChanges()).toBe(true);
  });

  it('reports draft creation failures separately and offers a safe exit', async () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const handle = mountFormResponseRecipeSeedRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      formDefinitionId: 'project-intake',
      draftKey: 'not-a-valid-draft-key',
      listCaller: async () => ({ recipes: [] }),
      validateCaller: okValidate,
      saveCaller: okSave,
    });
    await tick();

    const status = findByAttr(root, MOUNT_RECIPE_EDITOR_STATUS_ATTR);
    expect(status?.getAttribute(MOUNT_RECIPE_EDITOR_STATUS_ATTR)).toBe('error');
    expect(status?.textContent).toContain('Couldn’t create this automation draft');
    expect(status?.textContent).not.toContain('check existing automations');
    expect(findByAttr(root, FORM_RESPONSE_AUTOMATION_CREATE_ATTR)).toBeUndefined();
    expect(
      findByAttr(root, FORM_RESPONSE_AUTOMATION_BACK_ATTR)?.getAttribute('href'),
    ).toBe('#data');
    expect(findByAttr(root, RECIPE_EDITOR_ROUTE_ATTR)).toBeUndefined();
    expect(handle.hasUnsavedChanges()).toBe(false);
  });

  it('ignores a late discovery result after disposal', async () => {
    let resolveList!: (value: { recipes: ServerRecipeListEntry[] }) => void;
    const pending = new Promise<{ recipes: ServerRecipeListEntry[] }>((resolve) => {
      resolveList = resolve;
    });
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const handle = mountFormResponseRecipeSeedRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      formDefinitionId: 'project-intake',
      draftKey,
      listCaller: () => pending,
      validateCaller: okValidate,
      saveCaller: okSave,
    });

    handle.dispose();
    resolveList({ recipes: [entryFor(automationRecipe('exact', [{
      on: 'form_response.accepted',
      where: { form_definition_id: 'project-intake' },
    }]))] });
    await tick();

    expect(findByAttr(root, MOUNT_RECIPE_EDITOR_HOST_ATTR)).toBeUndefined();
    expect(findByAttr(root, FORM_RESPONSE_AUTOMATION_DISCOVERY_ATTR)).toBeUndefined();
    expect(findByAttr(root, RECIPE_EDITOR_ROUTE_ATTR)).toBeUndefined();
  });
});
