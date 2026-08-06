import { describe, expect, it } from 'vitest';
import {
  FORM_RESPONSE_ON_SHORTHAND,
  type LocalRecipeWebhookStatus,
  type RecipeDefinition,
} from '@recued/contracts';

import {
  RECIPE_EDITOR_ADD_ATTR,
  RECIPE_EDITOR_ADD_KIND_ATTR,
  RECIPE_EDITOR_ADD_NAME_ATTR,
  RECIPE_EDITOR_COLLAPSE_ALL_ATTR,
  RECIPE_EDITOR_COND_ADD_ATTR,
  RECIPE_EDITOR_CONN_VAR_ADD_ATTR,
  RECIPE_EDITOR_CONN_VAR_KIND_ATTR,
  RECIPE_EDITOR_CONN_VAR_NAME_ATTR,
  RECIPE_EDITOR_CONN_VAR_REMOVE_ATTR,
  RECIPE_EDITOR_CONN_VAR_ROW_ATTR,
  RECIPE_EDITOR_DIRTY_ATTR,
  RECIPE_EDITOR_FIELD_ATTR,
  RECIPE_EDITOR_FORM_RESPONSE_READER_ACTION_ATTR,
  RECIPE_EDITOR_FORM_RESPONSE_READER_ATTR,
  RECIPE_EDITOR_HEADING_ATTR,
  RECIPE_EDITOR_ISSUE_ATTR,
  RECIPE_EDITOR_MOVE_DOWN_ATTR,
  RECIPE_EDITOR_MOVE_UP_ATTR,
  RECIPE_EDITOR_OP_ARG_ADD_ATTR,
  RECIPE_EDITOR_OP_ARG_NAME_ATTR,
  RECIPE_EDITOR_OP_ARG_REMOVE_ATTR,
  RECIPE_EDITOR_OP_NOTICE_ATTR,
  RECIPE_EDITOR_RECIPE_ID_ATTR,
  RECIPE_EDITOR_RECIPE_NAME_ATTR,
  RECIPE_EDITOR_REMOVE_ATTR,
  RECIPE_EDITOR_ROUTE_ATTR,
  RECIPE_EDITOR_ROW_ATTR,
  RECIPE_EDITOR_SAVE_ATTR,
  RECIPE_EDITOR_STYLES,
  RECIPE_EDITOR_STATUS_ATTR,
  RECIPE_EDITOR_TRIGGER_ADD_ATTR,
  RECIPE_EDITOR_TRIGGER_ADD_EVENT_ATTR,
  RECIPE_EDITOR_TRIGGER_ADD_KIND_ATTR,
  RECIPE_EDITOR_TRIGGER_EVENT_ATTR,
  RECIPE_EDITOR_TRIGGER_FORM_ID_ATTR,
  RECIPE_EDITOR_TRIGGER_REMOVE_ATTR,
  RECIPE_EDITOR_TRIGGER_ROW_ATTR,
  RECIPE_EDITOR_TRIGGERS_ATTR,
  RECIPE_EDITOR_VALIDATE_ATTR,
  RECIPE_EDITOR_WEBHOOK_ADD_ATTR,
  RECIPE_EDITOR_WEBHOOK_ARM_ATTR,
  RECIPE_EDITOR_WEBHOOK_DISARM_ATTR,
  RECIPE_EDITOR_WEBHOOK_DOOR_ATTR,
  RECIPE_EDITOR_WEBHOOK_REMOVE_ATTR,
  RECIPE_EDITOR_WEBHOOK_SELECT_ATTR,
  RECIPE_EDITOR_WEBHOOK_STATUS_ATTR,
  RECIPE_EDITOR_WEBHOOKS_ATTR,
  bootstrapRecipeEditorRoute,
  type RecipeSaveResult,
  type RecipeWebhookControl,
  type RecipeValidateResult,
} from '../recipe-editor-route.js';
import {
  mountExecutionCaseDraftRoute,
  EXECUTION_CASE_DRAFT_HOST_ATTR,
  EXECUTION_CASE_DRAFT_REFINE_ATTR,
  EXECUTION_CASE_DRAFT_REFINE_ERROR_ATTR,
  EXECUTION_CASE_DRAFT_REFINE_PANEL_ATTR,
  EXECUTION_CASE_DRAFT_REFINE_PROMPT_ATTR,
  type MountExecutionCaseDraftRouteOptions,
} from '../mount-execution-case-draft-route.js';

// ────────────────────────────────────────────────────────────────
// Fake DOM harness (adapted from the pack-editor test)
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
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(el: FakeElement): FakeElement;
  removeChild(el: FakeElement): FakeElement;
  remove(): void;
  addEventListener(name: string, fn: () => void): void;
  click(): void;
  dispatch(name: string): void;
  focus(): void;
}

interface FakeDocument {
  styleElements: FakeElement[];
  activeElement: FakeElement | null;
  head: {
    querySelector(sel: string): FakeElement | null;
    appendChild(el: FakeElement): FakeElement;
  };
  createElement(tag: string): FakeElement;
}

const makeFakeElement = (
  tagName: string,
  onFocus: (element: FakeElement) => void = () => {},
): FakeElement => {
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
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
    removeAttribute(k) {
      el.attrs.delete(k);
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
    focus() {
      onFocus(el);
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
  const doc: FakeDocument = {
    styleElements,
    activeElement: null,
    head: {
      querySelector(sel) {
        const attr = attrFromSelector(sel);
        if (attr === null) return null;
        return styleElements.find((el) => el.hasAttribute(attr)) ?? null;
      },
      appendChild(el) {
        styleElements.push(el);
        return el;
      },
    },
    createElement: (tag) => makeFakeElement(tag, (element) => {
      doc.activeElement = element;
    }),
  };
  return doc;
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

const findAllByAttrValue = (
  root: FakeElement,
  attr: string,
  value: string,
): FakeElement[] =>
  findAllByAttr(root, attr).filter((el) => el.getAttribute(attr) === value);

const findByAttrValue = (
  root: FakeElement,
  attr: string,
  value: string,
): FakeElement | undefined => findAllByAttrValue(root, attr, value)[0];

const textOf = (root: FakeElement): string =>
  [root.textContent, ...root.children.map((child) => textOf(child))]
    .filter((part) => part.length > 0)
    .join(' ');

const setValue = (el: FakeElement | undefined, value: string): void => {
  if (el === undefined) throw new Error(`missing element for value ${value}`);
  el.value = value;
  el.dispatch('input');
  el.dispatch('change');
};

const tick = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

const okValidate = async (): Promise<RecipeValidateResult> => ({
  ok: true,
  issues: [],
});

const okSave = async (args: {
  recipe: RecipeDefinition;
}): Promise<RecipeSaveResult> => ({
  saved: true,
  recipe_id: args.recipe.recipe_id,
  version: 1,
  name: args.recipe.metadata.name,
});

interface MountOptions {
  initialRecipe?: RecipeDefinition;
  validateCaller?: BootstrapValidate;
  saveCaller?: BootstrapSave;
  webhookControl?: RecipeWebhookControl;
}
type BootstrapValidate = (args: {
  recipe: RecipeDefinition;
}) => Promise<RecipeValidateResult>;
type BootstrapSave = (args: {
  recipe: RecipeDefinition;
  publisher_id?: string;
  webhook_bindings?: ReadonlyArray<{ binding: string; ingress_id: string }>;
}) => Promise<RecipeSaveResult>;

const mount = (options: MountOptions = {}) => {
  const doc = makeFakeDocument();
  const root = makeFakeElement('main');
  const route = bootstrapRecipeEditorRoute({
    root: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    validateCaller: options.validateCaller ?? okValidate,
    saveCaller: options.saveCaller ?? okSave,
    ...(options.webhookControl ? { webhookControl: options.webhookControl } : {}),
    ...(options.initialRecipe !== undefined
      ? { initialRecipe: options.initialRecipe }
      : {}),
  });
  return { doc, root, route };
};

/** A single-op-step recipe for the op-authoring tests. */
const opRecipe = (step: Record<string, unknown>): RecipeDefinition => ({
  recipe_id: 'r1',
  version: 1,
  ttl: 300,
  metadata: { name: 'R1', description: '', author: '', supported_platforms: [] },
  variables: {},
  prefetch_steps: [],
  steps: [step as never],
  output: { render: [] },
});

/** A `type:'connection'` recipe variable for the binding tests. */
const connVar = (label: string, kind = 'api'): never =>
  ({ label, type: 'connection', connection_kind: kind, default: '' } as never);

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

describe('recipe-editor step inspector route', () => {
  it('keeps its dense mobile editor controls at full interaction size', () => {
    expect(RECIPE_EDITOR_STYLES).toContain(
      `[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-actions .rx-btn {\n`
        + '  min-width: 36px;\n  min-height: 36px;',
    );
    expect(RECIPE_EDITOR_STYLES).toContain(
      `[${RECIPE_EDITOR_ROUTE_ATTR}] button.rx-btn {\n    min-height: 36px;`,
    );
    expect(RECIPE_EDITOR_STYLES).toContain(
      `[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-actions .rx-btn {\n`
        + '    min-width: 36px;\n    min-height: 36px;',
    );
    expect(RECIPE_EDITOR_STYLES).toContain(
      `[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-id input {\n`
        + '    min-height: 36px;',
    );
    expect(RECIPE_EDITOR_STYLES).toContain(
      `[${RECIPE_EDITOR_WEBHOOKS_ATTR}] .recipe-editor-webhook-row {\n`
        + '    min-width: 0;\n'
        + '    grid-template-columns: minmax(0, 1fr);',
    );
    expect(RECIPE_EDITOR_STYLES).toContain(
      `[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-field-grid,\n`
        + `  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-trigger-fields {\n`
        + '    grid-template-columns: minmax(0, 1fr);',
    );
    expect(RECIPE_EDITOR_STYLES).toContain(
      `[${RECIPE_EDITOR_STATUS_ATTR}] {\n`
        + '  min-width: 0;\n'
        + '  max-width: 100%;',
    );
    expect(RECIPE_EDITOR_STYLES).toContain(
      `[${RECIPE_EDITOR_ISSUE_ATTR}] > * {\n`
        + '  min-width: 0;\n'
        + '  overflow-wrap: anywhere;',
    );
    expect(RECIPE_EDITOR_STYLES).toContain(
      '@media (max-width: 340px) {\n'
        + `  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-summary {\n`
        + '    grid-template-columns: auto minmax(0, 1fr);',
    );
    expect(RECIPE_EDITOR_STYLES).toContain(
      `[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-actions {\n`
        + '    grid-column: 1 / -1;\n'
        + '    grid-row: 2;\n'
        + '    width: 100%;',
    );
  });

  it('mounts with a blank recipe and an empty Steps section', () => {
    const { doc, root, route } = mount();

    expect(findByAttr(root, RECIPE_EDITOR_ROUTE_ATTR)).toBeDefined();
    expect(findAllByAttr(root, RECIPE_EDITOR_ROW_ATTR)).toHaveLength(0);
    expect(findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.textContent).toBe('Save');
    expect(findByAttrValue(root, 'aria-label', 'Recipe editor controls')).toBeDefined();
    expect(textOf(root)).toContain('Recipe workspace Recipe editor');
    expect(textOf(root)).toContain('Build, validate, and save this automation.');
    expect(doc.activeElement).toBe(findByAttr(root, RECIPE_EDITOR_HEADING_ATTR));
    expect(textOf(root)).toContain('Add a step Steps run in order, from top to bottom.');
    expect(textOf(root)).toContain('No steps yet');
    expect(findByAttr(root, RECIPE_EDITOR_RECIPE_ID_ATTR)?.getAttribute('aria-label'))
      .toBe('Recipe id');
    expect(findByAttr(root, RECIPE_EDITOR_ADD_ATTR)?.parent?.className)
      .toContain('recipe-editor-add--step');
    expect(findByAttr(root, RECIPE_EDITOR_TRIGGER_ADD_ATTR)?.parent?.className)
      .toContain('recipe-editor-add--compact');
    expect(findByAttr(root, RECIPE_EDITOR_CONN_VAR_ADD_ATTR)?.parent?.className)
      .toContain('recipe-editor-add--compact');
    expect(route.getRecipe().steps).toHaveLength(0);
    expect(route.getRecipe().output.render).toEqual([]);
    expect(route.getRecipe().output.sidebar).toBeUndefined();

    route.dispose();
    expect(findByAttr(root, RECIPE_EDITOR_ROUTE_ATTR)).toBeUndefined();
  });

  it('does not steal initial focus from a control outside the editor root', () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const outside = doc.createElement('button');
    outside.focus();

    const route = bootstrapRecipeEditorRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      validateCaller: okValidate,
      saveCaller: okSave,
    });

    expect(doc.activeElement).toBe(outside);
    route.dispose();
  });

  it('Add step appends a transform step card', () => {
    const { root, route } = mount();

    // Default kind = transform; the name picker pre-selects the first transform.
    expect(findByAttr(root, RECIPE_EDITOR_ADD_KIND_ATTR)).toBeDefined();
    expect(findByAttr(root, RECIPE_EDITOR_ADD_NAME_ATTR)).toBeDefined();

    findByAttr(root, RECIPE_EDITOR_ADD_ATTR)?.click();

    expect(findAllByAttr(root, RECIPE_EDITOR_ROW_ATTR)).toHaveLength(1);
    expect(findByAttr(root, RECIPE_EDITOR_ROW_ATTR)?.getAttribute('data-step-kind'))
      .toBe('transform');
    const recipe = route.getRecipe();
    expect(recipe.steps).toHaveLength(1);
    expect((recipe.steps[0] as { transform?: string }).transform).toBeTypeOf('string');
  });

  it('editing a transform param mutates the recipe', () => {
    // A `truncate` transform: `max_length` is a schema-declared number param,
    // so it renders as a number field that round-trips into the recipe.
    const initialRecipe: RecipeDefinition = {
      recipe_id: 'r1',
      version: 1,
      ttl: 300,
      metadata: { name: 'R1', description: '', author: '', supported_platforms: [] },
      variables: {},
      prefetch_steps: [],
      steps: [{ id: 'pick', transform: 'truncate', input: 'hello world', max_length: 10 } as never],
      output: { render: [] },
    };
    const { root, route } = mount({ initialRecipe });

    const maxLenField = findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'param:max_length');
    expect(maxLenField).toBeDefined();
    setValue(maxLenField, '42');

    expect((route.getRecipe().steps[0] as { max_length?: number }).max_length).toBe(42);
  });

  it('a skip_when condition round-trips through the builder (revealed on demand)', () => {
    const initialRecipe: RecipeDefinition = {
      recipe_id: 'r1',
      version: 1,
      ttl: 300,
      metadata: { name: 'R1', description: '', author: '', supported_platforms: [] },
      variables: {},
      prefetch_steps: [],
      steps: [{ id: 'gate', guard: '{{step.x}}' } as never],
      output: { render: [] },
    };
    const { doc, root, route } = mount({ initialRecipe });

    // An unset condition renders no builder — only the reveal button.
    expect(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'skip_when')).toBeUndefined();
    const reveal = findByAttrValue(root, RECIPE_EDITOR_COND_ADD_ATTR, 'gate:skip_when')!;
    reveal.focus();
    reveal.click();

    const source = findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'skip_when')!;
    expect(doc.activeElement).toBe(source);
    setValue(source, '{{step.x}}');
    expect(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'skip_when')).toBe(source);
    setValue(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'skip_when_op'), 'equal');
    const value = findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'skip_when_value')!;
    setValue(value, 'done');
    expect(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'skip_when_value')).toBe(value);

    expect((route.getRecipe().steps[0] as { skip_when?: string }).skip_when).toBe(
      '{{step.x}} equal done',
    );
  });

  it('a set skip_when renders its builder without a reveal step', () => {
    const initialRecipe: RecipeDefinition = {
      recipe_id: 'r1',
      version: 1,
      ttl: 300,
      metadata: { name: 'R1', description: '', author: '', supported_platforms: [] },
      variables: {},
      prefetch_steps: [],
      steps: [{ id: 'gate', guard: '{{step.x}}', skip_when: '{{step.x}} is_null' } as never],
      output: { render: [] },
    };
    const { root } = mount({ initialRecipe });

    expect(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'skip_when')?.value).toBe(
      '{{step.x}}',
    );
    // Its reveal button is gone; the untouched fail_on still offers one.
    expect(
      findByAttrValue(root, RECIPE_EDITOR_COND_ADD_ATTR, 'gate:skip_when'),
    ).toBeUndefined();
    expect(
      findByAttrValue(root, RECIPE_EDITOR_COND_ADD_ATTR, 'gate:fail_on'),
    ).toBeDefined();
  });

  it('a unary skip_when operator drops the value field', () => {
    const initialRecipe: RecipeDefinition = {
      recipe_id: 'r1',
      version: 1,
      ttl: 300,
      metadata: { name: 'R1', description: '', author: '', supported_platforms: [] },
      variables: {},
      prefetch_steps: [],
      steps: [{ id: 'gate', guard: '{{step.x}}' } as never],
      output: { render: [] },
    };
    const { doc, root, route } = mount({ initialRecipe });

    findByAttrValue(root, RECIPE_EDITOR_COND_ADD_ATTR, 'gate:skip_when')?.click();
    setValue(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'skip_when'), '{{step.x}}');
    const operator = findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'skip_when_op')!;
    operator.focus();
    setValue(operator, 'is_null');

    // The value input is hidden for a unary op.
    expect(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'skip_when_value')).toBeUndefined();
    expect(doc.activeElement).toBe(
      findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'skip_when_op'),
    );
    expect((route.getRecipe().steps[0] as { skip_when?: string }).skip_when).toBe(
      '{{step.x}} is_null',
    );
  });

  it('Remove deletes a step and focuses its next survivor', () => {
    const initialRecipe: RecipeDefinition = {
      recipe_id: 'r1',
      version: 1,
      ttl: 300,
      metadata: { name: 'R1', description: '', author: '', supported_platforms: [] },
      variables: {},
      prefetch_steps: [],
      steps: [
        { id: 'a', guard: '{{x}}' } as never,
        { id: 'b', guard: '{{y}}' } as never,
      ],
      output: { render: [] },
    };
    const { doc, root, route } = mount({ initialRecipe });

    expect(findAllByAttr(root, RECIPE_EDITOR_ROW_ATTR)).toHaveLength(2);
    const remove = findByAttrValue(root, RECIPE_EDITOR_REMOVE_ATTR, 'a')!;
    remove.focus();
    remove.click();

    expect(findAllByAttr(root, RECIPE_EDITOR_ROW_ATTR)).toHaveLength(1);
    expect(route.getRecipe().steps.map((s) => s.id)).toEqual(['b']);
    expect(doc.activeElement?.className).toBe('recipe-editor-step-summary');
    expect(doc.activeElement?.parent?.getAttribute(RECIPE_EDITOR_ROW_ATTR)).toBe('b');
  });

  it('Remove focuses Add step when the recipe becomes empty', () => {
    const initialRecipe: RecipeDefinition = {
      recipe_id: 'r1',
      version: 1,
      ttl: 300,
      metadata: { name: 'R1', description: '', author: '', supported_platforms: [] },
      variables: {},
      prefetch_steps: [],
      steps: [{ id: 'only', guard: '{{x}}' } as never],
      output: { render: [] },
    };
    const { doc, root } = mount({ initialRecipe });

    const remove = findByAttrValue(root, RECIPE_EDITOR_REMOVE_ATTR, 'only')!;
    remove.focus();
    remove.click();

    expect(findAllByAttr(root, RECIPE_EDITOR_ROW_ATTR)).toHaveLength(0);
    expect(doc.activeElement).toBe(findByAttr(root, RECIPE_EDITOR_ADD_ATTR));
  });

  it('renaming a step id rewrites references everywhere', () => {
    const initialRecipe: RecipeDefinition = {
      recipe_id: 'r1',
      version: 1,
      ttl: 300,
      metadata: { name: 'R1', description: '', author: '', supported_platforms: [] },
      variables: {},
      prefetch_steps: [],
      steps: [
        { id: 'fetch', guard: '{{x}}' } as never,
        { id: 'use', transform: 'truncate', value: '{{step.fetch}}', length: 5 } as never,
      ],
      output: { render: [] },
    };
    const { doc, root, route } = mount({ initialRecipe });

    const idInput = findAllByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'step_id')[0];
    idInput?.focus();
    setValue(idInput, 'load');

    const recipe = route.getRecipe();
    expect(recipe.steps.map((s) => s.id)).toEqual(['load', 'use']);
    expect((recipe.steps[1] as { value?: string }).value).toBe('{{step.load}}');
    expect(doc.activeElement).toBe(
      findAllByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'step_id')[0],
    );
    expect(doc.activeElement?.value).toBe('load');
  });

  it('an invalid step rename reverts and keeps its field focused', () => {
    const initialRecipe: RecipeDefinition = {
      recipe_id: 'r1',
      version: 1,
      ttl: 300,
      metadata: { name: 'R1', description: '', author: '', supported_platforms: [] },
      variables: {},
      prefetch_steps: [],
      steps: [{ id: 'fetch', guard: '{{x}}' } as never],
      output: { render: [] },
    };
    const { doc, root, route } = mount({ initialRecipe });

    const idInput = findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'step_id')!;
    idInput.focus();
    setValue(idInput, 'not-valid');

    expect(route.getRecipe().steps[0]?.id).toBe('fetch');
    expect(doc.activeElement).toBe(
      findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'step_id'),
    );
    expect(doc.activeElement?.value).toBe('fetch');
  });

  it('Validate calls the stub and renders issues', async () => {
    const validateCalls: RecipeDefinition[] = [];
    const validateCaller: BootstrapValidate = async (args) => {
      validateCalls.push(args.recipe);
      return {
        ok: false,
        issues: [
          { path: 'steps[0].transform', message: 'unknown transform', severity: 'error' },
        ],
      };
    };
    const { doc, root } = mount({ validateCaller });

    const validate = findByAttr(root, RECIPE_EDITOR_VALIDATE_ATTR)!;
    validate.focus();
    validate.click();
    await tick();

    expect(validateCalls).toHaveLength(1);
    const issue = findByAttr(root, RECIPE_EDITOR_ISSUE_ATTR);
    expect(issue?.getAttribute('data-severity')).toBe('error');
    expect(textOf(issue!)).toContain('unknown transform');
    expect(findByAttr(root, RECIPE_EDITOR_STATUS_ATTR)?.textContent).toContain(
      'Validation failed',
    );
    expect(doc.activeElement).toBe(
      findByAttr(root, RECIPE_EDITOR_VALIDATE_ATTR),
    );
  });

  it('does not apply a stale validation result after newer edits', async () => {
    let finishValidate!: (result: RecipeValidateResult) => void;
    const validateCaller: BootstrapValidate = () => new Promise((resolve) => {
      finishValidate = resolve;
    });
    const { doc, root, route } = mount({ validateCaller });

    findByAttr(root, RECIPE_EDITOR_VALIDATE_ATTR)?.click();
    const name = findByAttrValue(
      root,
      RECIPE_EDITOR_FIELD_ATTR,
      'recipe_name',
    )!;
    name.focus();
    setValue(name, 'Edited while validation was pending');

    finishValidate({
      ok: false,
      issues: [{
        path: 'metadata.name',
        message: 'This belongs to the older snapshot',
        severity: 'error',
      }],
    });
    await tick();

    expect(route.hasUnsavedChanges()).toBe(true);
    expect(findByAttr(root, RECIPE_EDITOR_DIRTY_ATTR)?.textContent).toBe('Unsaved');
    expect(findByAttr(root, RECIPE_EDITOR_STATUS_ATTR)?.textContent)
      .toBe('Validation finished — newer edits pending');
    expect(findByAttr(root, RECIPE_EDITOR_ISSUE_ATTR)).toBeUndefined();
    expect(textOf(root)).not.toContain('This belongs to the older snapshot');
    expect(doc.activeElement).toBe(
      findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'recipe_name'),
    );
  });

  it('keeps Save focused and single-flight while the save caller is pending', async () => {
    const saveCalls: RecipeDefinition[] = [];
    const saveGate: {
      finish?: (result: RecipeSaveResult) => void;
    } = {};
    const saveCaller: BootstrapSave = (args) => {
      saveCalls.push(args.recipe);
      return new Promise((resolve) => {
        saveGate.finish = resolve;
      });
    };
    const { doc, root } = mount({ saveCaller });

    const save = findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)!;
    save.focus();
    save.click();
    const busySave = findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)!;
    expect(busySave.disabled).toBe(false);
    expect(busySave.getAttribute('aria-disabled')).toBe('true');
    expect(busySave.getAttribute('aria-busy')).toBe('true');
    expect(doc.activeElement).toBe(busySave);
    busySave.click();
    expect(saveCalls).toHaveLength(1);
    saveGate.finish?.({
      saved: true,
      recipe_id: 'new-recipe',
      version: 3,
      name: 'R',
    });
    await tick();

    expect(saveCalls).toHaveLength(1);
    expect(findByAttr(root, RECIPE_EDITOR_STATUS_ATTR)?.textContent).toContain('Saved');
    expect(findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.textContent).toBe('Saved');
    expect(findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.getAttribute('aria-disabled')).toBe('false');
    expect(findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.getAttribute('aria-busy')).toBe('false');
    expect(doc.activeElement).toBe(findByAttr(root, RECIPE_EDITOR_SAVE_ATTR));
  });

  it('preserves an active recipe field through save repaints', async () => {
    const { doc, root } = mount();
    const name = findByAttrValue(
      root,
      RECIPE_EDITOR_FIELD_ATTR,
      'recipe_name',
    )!;
    name.focus();
    setValue(name, 'Edited recipe');

    findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.click();
    await tick();

    expect(doc.activeElement).toBe(
      findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'recipe_name'),
    );
    expect(doc.activeElement?.value).toBe('Edited recipe');
  });

  it('saves owner-selected webhook bindings disarmed, then arms explicitly', async () => {
    const initialRecipe = opRecipe({ id: 'noop', transform: 'compare', left: 'x' });
    const unarmed = {
      declared: true,
      configured: true,
      armed: false,
      bindings: [{ binding: 'webhook_delivery', ingress_id: 'whi_generic' }],
    } as const;
    let armed = false;
    const saved: Array<Parameters<BootstrapSave>[0]> = [];
    const webhookControl: RecipeWebhookControl = {
      ingresses: [{
        ingress_id: 'whi_generic',
        display_name: 'Generic test webhook',
        profile_id: 'generic.static-header-token.v1',
        environment: 'test',
        registration_mode: 'manual',
        selected_event_types: ['delivery'],
        intake_state: 'enabled',
        paired_connection_id: null,
      } as never],
      initialStatus: {
        ...unarmed,
        configured: false,
        bindings: [],
      },
      armCaller: async () => {
        armed = true;
        return { webhook: { ...unarmed, armed: true } };
      },
      disarmCaller: async () => {
        armed = false;
        return { webhook: unarmed };
      },
    };
    const { doc, root } = mount({
      initialRecipe,
      webhookControl,
      saveCaller: async (args) => {
        saved.push(args);
        return {
          saved: true,
          recipe_id: args.recipe.recipe_id,
          version: 1,
          name: args.recipe.metadata.name,
          webhook: unarmed,
        };
      },
    });

    expect(findByAttr(root, RECIPE_EDITOR_WEBHOOKS_ATTR)).toBeDefined();
    setValue(
      findByAttrValue(root, RECIPE_EDITOR_WEBHOOK_SELECT_ATTR, 'new'),
      'whi_generic',
    );
    findByAttr(root, RECIPE_EDITOR_WEBHOOK_ADD_ATTR)?.click();
    const selectedIngress = findByAttrValue(
      root,
      RECIPE_EDITOR_WEBHOOK_SELECT_ATTR,
      'webhook_delivery',
    )!;
    expect(selectedIngress.value).toBe('whi_generic');
    expect(doc.activeElement).toBe(selectedIngress);
    selectedIngress.focus();
    setValue(selectedIngress, 'whi_generic');
    const repaintedIngress = findByAttrValue(
      root,
      RECIPE_EDITOR_WEBHOOK_SELECT_ATTR,
      'webhook_delivery',
    )!;
    expect(repaintedIngress).not.toBe(selectedIngress);
    expect(repaintedIngress.value).toBe('whi_generic');
    expect(doc.activeElement).toBe(repaintedIngress);
    findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.click();
    await tick();
    expect(saved[0]?.webhook_bindings).toEqual([{
      binding: 'webhook_delivery',
      ingress_id: 'whi_generic',
    }]);
    expect(findByAttr(root, RECIPE_EDITOR_WEBHOOK_ARM_ATTR)?.disabled).toBe(false);

    findByAttr(root, RECIPE_EDITOR_WEBHOOK_ARM_ATTR)?.click();
    expect(findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.disabled).toBe(false);
    expect(findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.getAttribute('aria-disabled'))
      .toBe('true');
    await tick();
    expect(armed).toBe(true);
    expect(findByAttr(root, RECIPE_EDITOR_WEBHOOK_DISARM_ATTR)).toBeDefined();
    expect(findByAttr(root, RECIPE_EDITOR_WEBHOOK_STATUS_ATTR)?.textContent)
      .toContain('Future admitted deliveries');

    setValue(findByAttr(root, RECIPE_EDITOR_RECIPE_ID_ATTR), 'forked-webhook-recipe');
    findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.click();
    expect(saved).toHaveLength(1);
    expect(findByAttr(root, RECIPE_EDITOR_STATUS_ATTR)?.textContent)
      .toContain('Disarm the saved webhook');
    findByAttr(root, RECIPE_EDITOR_WEBHOOK_DISARM_ATTR)?.click();
    await tick();
    expect(armed).toBe(false);
    expect(findByAttr(root, RECIPE_EDITOR_WEBHOOK_ARM_ATTR)).toBeDefined();
    const remove = findByAttr(root, RECIPE_EDITOR_WEBHOOK_REMOVE_ATTR)!;
    remove.focus();
    remove.click();
    expect(doc.activeElement).toBe(
      findByAttrValue(root, RECIPE_EDITOR_WEBHOOK_SELECT_ATTR, 'new'),
    );
  });

  it('keeps webhook authority focused and single-flight across Arm and Disarm', async () => {
    const initialRecipe = opRecipe({ id: 'noop', transform: 'compare', left: 'x' });
    initialRecipe.webhook_requirements = [{
      binding: 'webhook_delivery',
      profile_ids: ['generic.static-header-token.v1'],
      required_event_types: ['delivery'],
      decoded_payload_access: 'metadata_only',
      source_truth_policy: 'delivery_payload_allowed',
    }];
    initialRecipe.webhook_triggers = [{
      binding: 'webhook_delivery',
      event_types: ['delivery'],
    }];
    const status = (armed: boolean): LocalRecipeWebhookStatus => ({
      declared: true,
      configured: true,
      armed,
      bindings: [{ binding: 'webhook_delivery', ingress_id: 'whi_generic' }],
      door: {
        state: 'minted',
        contract_id: 'contract_webhook_focus',
        operation_ids: ['core.data.record.get'],
      },
    });
    const calls: Array<'arm' | 'disarm'> = [];
    // A holder rather than a `let`: the only assignment is inside the promise
    // callback, so control-flow analysis narrows a bare local to `null` and then
    // to `never` at the call, giving "this expression is not callable". The save
    // gate above uses the same shape for the same reason.
    const webhookGate: { finish?: () => void } = {};
    const transition = (
      action: 'arm' | 'disarm',
    ): Promise<{ webhook: LocalRecipeWebhookStatus }> => {
      calls.push(action);
      return new Promise((resolve) => {
        webhookGate.finish = () => resolve({ webhook: status(action === 'arm') });
      });
    };
    const { doc, root } = mount({
      initialRecipe,
      webhookControl: {
        ingresses: [],
        initialStatus: status(false),
        armCaller: async () => transition('arm'),
        disarmCaller: async () => transition('disarm'),
      },
    });

    const arm = findByAttr(root, RECIPE_EDITOR_WEBHOOK_ARM_ATTR)!;
    arm.focus();
    arm.click();
    const busyArm = findByAttr(root, RECIPE_EDITOR_WEBHOOK_ARM_ATTR)!;
    expect(busyArm).not.toBe(arm);
    expect(busyArm.textContent).toBe('Arming…');
    expect(busyArm.disabled).toBe(false);
    expect(busyArm.getAttribute('aria-disabled')).toBe('true');
    expect(busyArm.getAttribute('aria-busy')).toBe('true');
    expect(doc.activeElement).toBe(busyArm);
    busyArm.click();
    busyArm.click();
    expect(calls).toEqual(['arm']);

    webhookGate.finish?.();
    await tick();
    const disarm = findByAttr(root, RECIPE_EDITOR_WEBHOOK_DISARM_ATTR)!;
    expect(disarm.textContent).toBe('Disarm webhook');
    expect(doc.activeElement).toBe(disarm);

    disarm.click();
    const busyDisarm = findByAttr(root, RECIPE_EDITOR_WEBHOOK_DISARM_ATTR)!;
    expect(busyDisarm).not.toBe(disarm);
    expect(busyDisarm.textContent).toBe('Disarming…');
    expect(busyDisarm.disabled).toBe(false);
    expect(busyDisarm.getAttribute('aria-disabled')).toBe('true');
    expect(busyDisarm.getAttribute('aria-busy')).toBe('true');
    expect(doc.activeElement).toBe(busyDisarm);
    busyDisarm.click();
    busyDisarm.click();
    expect(calls).toEqual(['arm', 'disarm']);

    webhookGate.finish?.();
    await tick();
    expect(doc.activeElement).toBe(
      findByAttr(root, RECIPE_EDITOR_WEBHOOK_ARM_ATTR),
    );
  });

  it('discloses decoded-payload scope and keeps requirement-only bindings unarmable', () => {
    const initialRecipe = opRecipe({ id: 'noop', transform: 'compare', left: 'x' });
    initialRecipe.webhook_requirements = [{
      binding: 'webhook_delivery',
      profile_ids: ['generic.static-header-token.v1'],
      required_event_types: ['delivery'],
      decoded_payload_access: 'scoped_read',
      source_truth_policy: 'delivery_payload_allowed',
    }];
    initialRecipe.webhook_triggers = [];
    const { root } = mount({
      initialRecipe,
      webhookControl: {
        ingresses: [],
        initialStatus: {
          declared: true,
          configured: true,
          armed: false,
          bindings: [{ binding: 'webhook_delivery', ingress_id: 'whi_generic' }],
        },
        armCaller: async () => { throw new Error('must stay disabled'); },
        disarmCaller: async () => { throw new Error('not used'); },
      },
    });

    expect(textOf(findByAttr(root, RECIPE_EDITOR_WEBHOOKS_ATTR)!))
      .toContain('decoded payload access');
    expect(findByAttr(root, RECIPE_EDITOR_WEBHOOK_ARM_ATTR)?.disabled).toBe(true);
    expect(findByAttr(root, RECIPE_EDITOR_WEBHOOK_REMOVE_ATTR)).toBeDefined();
    expect(findByAttr(root, RECIPE_EDITOR_WEBHOOK_STATUS_ATTR)?.textContent)
      .toContain('Add a webhook trigger');
  });

  // D-209 #1 Task 3 — the door-authority consent block. The server returns the
  // door's derived op closure + capability diff on every save/status/arm
  // response; these pin that the editor renders it next to the Arm button
  // instead of discarding it, and that a non-minted door blocks arming with
  // the remedy named (the server would refuse `webhook_not_ready` anyway).
  describe('webhook door consent block', () => {
    const webhookRecipe = () => {
      const recipe = opRecipe({ id: 'noop', transform: 'compare', left: 'x' });
      recipe.webhook_requirements = [{
        binding: 'webhook_delivery',
        profile_ids: ['generic.static-header-token.v1'],
        required_event_types: ['delivery'],
        decoded_payload_access: 'metadata_only',
        source_truth_policy: 'delivery_payload_allowed',
      }];
      recipe.webhook_triggers = [{ binding: 'webhook_delivery', event_types: ['delivery'] }];
      return recipe;
    };
    const control = (
      door: NonNullable<RecipeWebhookControl['initialStatus']['door']>,
      armed = false,
    ): RecipeWebhookControl => ({
      ingresses: [],
      initialStatus: {
        declared: true,
        configured: true,
        armed,
        bindings: [{ binding: 'webhook_delivery', ingress_id: 'whi_generic' }],
        door,
      },
      armCaller: async () => { throw new Error('not driven by these tests'); },
      disarmCaller: async () => { throw new Error('not used'); },
    });

    it('renders the minted door op closure next to Arm and keeps it armable', () => {
      const { root } = mount({
        initialRecipe: webhookRecipe(),
        webhookControl: control({
          state: 'minted',
          contract_id: 'contract_door_1',
          operation_ids: ['core.mail.send', 'recued-core/hubspot-catalog.deal.create'],
        }),
      });

      const block = findByAttrValue(root, RECIPE_EDITOR_WEBHOOK_DOOR_ATTR, 'minted');
      expect(block).toBeDefined();
      const text = textOf(block!);
      expect(text).toContain('Once armed, an admitted delivery may:');
      expect(text).toContain('core.mail.send');
      expect(text).toContain('recued-core/hubspot-catalog.deal.create');
      expect(text).toContain('arming is that approval');
      expect(findByAttr(root, RECIPE_EDITOR_WEBHOOK_ARM_ATTR)?.disabled).toBe(false);
    });

    it('names an empty closure honestly instead of hiding it', () => {
      const { root } = mount({
        initialRecipe: webhookRecipe(),
        webhookControl: control({
          state: 'minted',
          contract_id: 'contract_door_1',
          operation_ids: [],
        }),
      });

      const block = findByAttrValue(root, RECIPE_EDITOR_WEBHOOK_DOOR_ATTR, 'minted');
      expect(textOf(block!)).toContain('the door grants nothing');
    });

    it('renders the re-save capability diff, removed ops included — until the draft goes dirty', () => {
      const { root } = mount({
        initialRecipe: webhookRecipe(),
        webhookControl: control({
          state: 'minted',
          contract_id: 'contract_door_2',
          operation_ids: ['core.mail.send'],
          added: ['core.mail.send'],
          removed: ['core.task.delete'],
        }),
      });

      const text = textOf(findByAttrValue(root, RECIPE_EDITOR_WEBHOOK_DOOR_ATTR, 'minted')!);
      expect(text).toContain('changed the webhook’s authority');
      expect(text).toContain('+ core.mail.send');
      expect(text).toContain('− core.task.delete');

      // New unsaved edits move the draft past the state "this save" describes
      // — the diff must not keep announcing it. The ops closure (the saved
      // door's live authority) stays. Drive a STRUCTURAL edit (Add step) —
      // it marks dirty AND rebuilds the section (focused field edits
      // deliberately skip the rebuild, so the whole section is equally stale
      // for those until the next structural pass).
      findByAttr(root, RECIPE_EDITOR_ADD_ATTR)?.click();
      const dirtyText = textOf(findByAttrValue(root, RECIPE_EDITOR_WEBHOOK_DOOR_ATTR, 'minted')!);
      expect(dirtyText).not.toContain('changed the webhook’s authority');
      expect(dirtyText).toContain('core.mail.send');
    });

    it('speaks in the present tense on an already-armed webhook', () => {
      const { root } = mount({
        initialRecipe: webhookRecipe(),
        webhookControl: control({
          state: 'minted',
          contract_id: 'contract_door_1',
          operation_ids: ['core.mail.send'],
        }, true),
      });

      const text = textOf(findByAttrValue(root, RECIPE_EDITOR_WEBHOOK_DOOR_ATTR, 'minted')!);
      expect(text).toContain('An admitted delivery may:');
      expect(text).not.toContain('Once armed');
      expect(text).toContain('arming was that approval');
    });

    it('disables Arm on a missing door and names the remedy', () => {
      const { root } = mount({
        initialRecipe: webhookRecipe(),
        webhookControl: control({ state: 'missing' }),
      });

      expect(findByAttrValue(root, RECIPE_EDITOR_WEBHOOK_DOOR_ATTR, 'missing')).toBeDefined();
      expect(findByAttr(root, RECIPE_EDITOR_WEBHOOK_ARM_ATTR)?.disabled).toBe(true);
      expect(findByAttr(root, RECIPE_EDITOR_WEBHOOK_STATUS_ATTR)?.textContent)
        .toContain('re-save the recipe to mint it');
    });

    it('disables Arm on a refused door and shows the refusal', () => {
      const { root } = mount({
        initialRecipe: webhookRecipe(),
        webhookControl: control({
          state: 'refused',
          refusal: {
            reason: 'dynamic_dispatch',
            step_id: 'step_3',
            detail: 'dynamic dispatch via run-ingredient',
          },
        }),
      });

      const block = findByAttrValue(root, RECIPE_EDITOR_WEBHOOK_DOOR_ATTR, 'refused');
      const text = textOf(block!);
      expect(text).toContain('cannot run from a webhook');
      expect(text).toContain('dynamic dispatch via run-ingredient');
      expect(text).toContain('(step step_3)');
      expect(findByAttr(root, RECIPE_EDITOR_WEBHOOK_ARM_ATTR)?.disabled).toBe(true);
    });
  });

  it('surfaces a save rejection (inline op-step) as an error status', async () => {
    const saveCaller: BootstrapSave = async () => {
      throw new Error('inline op-step rejected: author into a pack');
    };
    const { root } = mount({ saveCaller });

    findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.click();
    await tick();

    const status = findByAttr(root, RECIPE_EDITOR_STATUS_ATTR);
    expect(status?.getAttribute('data-state')).toBe('error');
    expect(status?.textContent).toContain('inline op-step rejected');
    // Save is usable again — not wedged disabled.
    expect(findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.disabled).toBeFalsy();
  });

  it('renders an op-step with an editable op id, args, and a condition builder', () => {
    const { root } = mount({
      initialRecipe: opRecipe({
        id: 'read_deal',
        op: 'recued-core.hubspot.deal.read',
        args: { deal_id: '{{config.deal_id}}' },
      }),
    });

    const card = findByAttrValue(root, RECIPE_EDITOR_ROW_ATTR, 'read_deal');
    expect(card).toBeDefined();
    expect(textOf(card!)).toContain('OP');

    // Op id is now an editable field (not read-only).
    const opField = findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'op');
    expect(opField).toBeDefined();
    expect(opField!.value).toBe('recued-core.hubspot.deal.read');

    // The arg renders as an editable value input pre-filled with the ref.
    expect(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'arg:deal_id')?.value).toBe(
      '{{config.deal_id}}',
    );

    // Op-steps carry skip_when / fail_on now (BaseStep) — the condition builder
    // is offered for them too (behind the reveal button until set).
    expect(
      findByAttrValue(root, RECIPE_EDITOR_COND_ADD_ATTR, 'read_deal:skip_when'),
    ).toBeDefined();

    // The guidance notice points at the connection-slot requirement.
    expect(findByAttr(root, RECIPE_EDITOR_OP_NOTICE_ATTR)?.textContent).toContain(
      'connection variable',
    );
  });

  it('editing the op id mutates the recipe', () => {
    const { root, route } = mount({
      initialRecipe: opRecipe({ id: 'q', op: 'deal.search', args: {} }),
    });

    setValue(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'op'), 'contact.search');
    expect((route.getRecipe().steps[0] as { op?: string }).op).toBe('contact.search');
  });

  it('Add step (op kind) appends an op-step with an empty args map', () => {
    const { doc, root, route } = mount();

    setValue(findByAttr(root, RECIPE_EDITOR_ADD_KIND_ATTR), 'op');
    // The name control rebuilds as a free-text op-id input.
    setValue(findByAttr(root, RECIPE_EDITOR_ADD_NAME_ATTR), 'core.crm.deal.search');
    const add = findByAttr(root, RECIPE_EDITOR_ADD_ATTR)!;
    add.focus();
    add.click();

    const recipe = route.getRecipe();
    expect(recipe.steps).toHaveLength(1);
    const step = recipe.steps[0] as { op?: string; args?: Record<string, unknown>; id: string };
    expect(step.op).toBe('core.crm.deal.search');
    expect(step.args).toEqual({});
    // The id is seeded from the op's last segment.
    expect(step.id).toBe('search');
    expect(doc.activeElement).toBe(
      findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'step_id'),
    );
  });

  it('editing an op arg value smart-parses JSON literals but keeps refs as strings', () => {
    const { root, route } = mount({
      initialRecipe: opRecipe({
        id: 'q',
        op: 'deal.search',
        args: { limit: 50, query: '{{config.q}}' },
      }),
    });

    setValue(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'arg:limit'), '200');
    setValue(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'arg:query'), '{{config.query}}');

    const args = (route.getRecipe().steps[0] as { args: Record<string, unknown> }).args;
    expect(args.limit).toBe(200);
    expect(args.query).toBe('{{config.query}}');
  });

  it('names repeated op and condition controls for their exact step', () => {
    const { root } = mount({
      initialRecipe: opRecipe({
        id: 'find_deal',
        op: 'deal.search',
        args: { query: '{{config.query}}' },
      }),
    });

    expect(findByAttrValue(root, RECIPE_EDITOR_ROW_ATTR, 'find_deal')?.getAttribute(
      'aria-label',
    )).toBe('Step find_deal');
    expect(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'arg:query')?.getAttribute(
      'aria-label',
    )).toBe('Argument query value for step find_deal');
    expect(findByAttrValue(root, RECIPE_EDITOR_OP_ARG_REMOVE_ATTR, 'query')?.getAttribute(
      'aria-label',
    )).toBe('Remove argument query from step find_deal');
    expect(findByAttr(root, RECIPE_EDITOR_OP_ARG_NAME_ATTR)?.getAttribute('aria-label'))
      .toBe('New argument name for step find_deal');
    expect(findByAttr(root, RECIPE_EDITOR_OP_ARG_ADD_ATTR)?.getAttribute('aria-label'))
      .toBe('Add argument to step find_deal');

    const reveal = findByAttrValue(
      root,
      RECIPE_EDITOR_COND_ADD_ATTR,
      'find_deal:skip_when',
    );
    expect(reveal?.getAttribute('aria-label'))
      .toBe('Add Skip when condition for step find_deal');
    reveal?.click();

    expect(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'skip_when')?.getAttribute(
      'aria-label',
    )).toBe('Skip when source for step find_deal');
    expect(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'skip_when_op')?.getAttribute(
      'aria-label',
    )).toBe('Skip when operator for step find_deal');
    expect(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'skip_when_value')?.getAttribute(
      'aria-label',
    )).toBe('Skip when value for step find_deal');
  });

  it('Add arg focuses its value and final Remove returns to the draft input', () => {
    const { doc, root, route } = mount({
      initialRecipe: opRecipe({ id: 'q', op: 'deal.search', args: {} }),
    });

    setValue(findByAttr(root, RECIPE_EDITOR_OP_ARG_NAME_ATTR), 'limit');
    const add = findByAttr(root, RECIPE_EDITOR_OP_ARG_ADD_ATTR)!;
    add.focus();
    add.click();

    const value = findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'arg:limit');
    expect(value).toBeDefined();
    expect(doc.activeElement).toBe(value);
    expect((route.getRecipe().steps[0] as { args: Record<string, unknown> }).args).toEqual({
      limit: '',
    });

    const remove = findByAttrValue(root, RECIPE_EDITOR_OP_ARG_REMOVE_ATTR, 'limit')!;
    remove.focus();
    remove.click();
    expect((route.getRecipe().steps[0] as { args: Record<string, unknown> }).args).toEqual({});
    expect(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'arg:limit')).toBeUndefined();
    expect(doc.activeElement).toBe(findByAttr(root, RECIPE_EDITOR_OP_ARG_NAME_ATTR));
  });

  it('Remove arg focuses the next surviving value', () => {
    const { doc, root } = mount({
      initialRecipe: opRecipe({
        id: 'q',
        op: 'deal.search',
        args: { query: '{{config.query}}', limit: 50 },
      }),
    });

    const remove = findByAttrValue(root, RECIPE_EDITOR_OP_ARG_REMOVE_ATTR, 'query')!;
    remove.focus();
    remove.click();

    expect(doc.activeElement).toBe(
      findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'arg:limit'),
    );
  });

  it('editing the connection slot sets the step connection; empty deletes it', () => {
    const { root, route } = mount({
      initialRecipe: opRecipe({ id: 'q', op: 'deal.search', args: {} }),
    });

    setValue(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'connection'), '{{config.crm}}');
    expect((route.getRecipe().steps[0] as { connection?: string }).connection).toBe(
      '{{config.crm}}',
    );

    setValue(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'connection'), '');
    expect('connection' in (route.getRecipe().steps[0] as object)).toBe(false);
  });

  it('a skip_when condition round-trips on an op-step', () => {
    const { root, route } = mount({
      initialRecipe: opRecipe({ id: 'q', op: 'deal.search', args: {} }),
    });

    findByAttrValue(root, RECIPE_EDITOR_COND_ADD_ATTR, 'q:skip_when')?.click();
    setValue(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'skip_when'), '{{config.skip}}');
    setValue(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'skip_when_op'), 'equal');
    setValue(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'skip_when_value'), 'true');

    expect((route.getRecipe().steps[0] as { skip_when?: string }).skip_when).toBe(
      '{{config.skip}} equal true',
    );
  });

  // ──────────────────────────────────────────────────────────────
  // Polish pass — reorder, collapse, block args, dirty semantics
  // ──────────────────────────────────────────────────────────────

  const twoStepRecipe = (): RecipeDefinition => ({
    recipe_id: 'r1',
    version: 1,
    ttl: 300,
    metadata: { name: 'R1', description: '', author: '', supported_platforms: [] },
    variables: {},
    prefetch_steps: [],
    steps: [
      { id: 'a', guard: '{{x}}' } as never,
      { id: 'b', guard: '{{y}}' } as never,
    ],
    output: { render: [] },
  });

  it('move down / move up reorder steps; ends are disabled', () => {
    const { doc, root, route } = mount({ initialRecipe: twoStepRecipe() });

    // Boundary buttons are disabled: first can't move up, last can't move down.
    expect(findByAttrValue(root, RECIPE_EDITOR_MOVE_UP_ATTR, 'a')?.disabled).toBe(true);
    expect(findByAttrValue(root, RECIPE_EDITOR_MOVE_DOWN_ATTR, 'b')?.disabled).toBe(true);
    expect(findByAttrValue(root, RECIPE_EDITOR_MOVE_UP_ATTR, 'a')?.parent?.className)
      .toBe('recipe-editor-step-actions');
    expect(findByAttrValue(root, RECIPE_EDITOR_MOVE_UP_ATTR, 'a')?.parent?.getAttribute('role'))
      .toBe('group');
    expect(findByAttrValue(root, RECIPE_EDITOR_REMOVE_ATTR, 'a')?.parent?.className)
      .toBe('recipe-editor-step-actions');

    const moveDown = findByAttrValue(root, RECIPE_EDITOR_MOVE_DOWN_ATTR, 'a')!;
    moveDown.focus();
    moveDown.click();
    expect(route.getRecipe().steps.map((s) => s.id)).toEqual(['b', 'a']);
    expect(doc.activeElement?.className).toBe('recipe-editor-step-summary');
    expect(doc.activeElement?.parent?.getAttribute(RECIPE_EDITOR_ROW_ATTR)).toBe('a');

    const moveUp = findByAttrValue(root, RECIPE_EDITOR_MOVE_UP_ATTR, 'a')!;
    moveUp.focus();
    moveUp.click();
    expect(route.getRecipe().steps.map((s) => s.id)).toEqual(['a', 'b']);
    expect(doc.activeElement?.className).toBe('recipe-editor-step-summary');
    expect(doc.activeElement?.parent?.getAttribute(RECIPE_EDITOR_ROW_ATTR)).toBe('a');
  });

  it('reordering after a focused field edit keeps the edit (no stale-list revert)', () => {
    // Focused edits mutate state.recipe WITHOUT a rerender (markDirty path);
    // the move handler must re-read the current list, not its render-time
    // snapshot, or the edit silently reverts.
    const recipe = twoStepRecipe();
    recipe.steps = [
      { id: 'a', guard: '{{x}}' } as never,
      { id: 'b', guard: '{{y}}' } as never,
      { id: 'c', guard: '{{z}}' } as never,
    ];
    const { doc, root, route } = mount({ initialRecipe: recipe });

    const guardInputs = findAllByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'guard');
    setValue(guardInputs[0], '{{step.fresh}} is_not_empty');

    const moveDown = findByAttrValue(root, RECIPE_EDITOR_MOVE_DOWN_ATTR, 'a')!;
    moveDown.focus();
    moveDown.click();

    expect(route.getRecipe().steps.map((s) => s.id)).toEqual(['b', 'a', 'c']);
    expect(
      (route.getRecipe().steps[1] as { guard?: string }).guard,
    ).toBe('{{step.fresh}} is_not_empty');
    expect(doc.activeElement).toBe(
      findByAttrValue(root, RECIPE_EDITOR_MOVE_DOWN_ATTR, 'a'),
    );
  });

  it('removing a step prunes its collapse state so a reused id opens fresh', () => {
    const { root, route } = mount({ initialRecipe: twoStepRecipe() });

    // Collapse everything, remove 'a', then re-add a step that mints id 'a'…
    findByAttr(root, RECIPE_EDITOR_COLLAPSE_ALL_ATTR)?.click();
    findByAttrValue(root, RECIPE_EDITOR_REMOVE_ATTR, 'a')?.click();

    setValue(findByAttr(root, RECIPE_EDITOR_ADD_KIND_ATTR), 'op');
    setValue(findByAttr(root, RECIPE_EDITOR_ADD_NAME_ATTR), 'ns.pack.thing.a');
    findByAttr(root, RECIPE_EDITOR_ADD_ATTR)?.click();

    expect(route.getRecipe().steps.map((s) => s.id)).toEqual(['b', 'a']);
    // …and the reborn 'a' renders OPEN (its stale collapsed entry was pruned).
    const reborn = findAllByAttrValue(root, RECIPE_EDITOR_ROW_ATTR, 'a')[0];
    expect(reborn?.hasAttribute('open')).toBe(true);
  });

  it('Collapse all closes every card, persists across rerenders, and flips to Expand all', () => {
    const { doc, root } = mount({ initialRecipe: twoStepRecipe() });

    const openCards = () =>
      findAllByAttr(root, RECIPE_EDITOR_ROW_ATTR).filter((el) => el.hasAttribute('open'));
    expect(openCards()).toHaveLength(2);

    const collapse = findByAttr(root, RECIPE_EDITOR_COLLAPSE_ALL_ATTR)!;
    collapse.focus();
    collapse.click();
    expect(openCards()).toHaveLength(0);
    const expand = findByAttr(root, RECIPE_EDITOR_COLLAPSE_ALL_ATTR)!;
    expect(expand.textContent).toBe('Expand all');
    expect(doc.activeElement).toBe(expand);

    // A structural rerender (remove a step) keeps the survivor collapsed.
    const remove = findByAttrValue(root, RECIPE_EDITOR_REMOVE_ATTR, 'a')!;
    remove.focus();
    remove.click();
    expect(openCards()).toHaveLength(0);

    const expandSurvivor = findByAttr(root, RECIPE_EDITOR_COLLAPSE_ALL_ATTR)!;
    expandSurvivor.focus();
    expandSurvivor.click();
    expect(openCards()).toHaveLength(1);
    expect(doc.activeElement).toBe(
      findByAttr(root, RECIPE_EDITOR_COLLAPSE_ALL_ATTR),
    );
  });

  it('an object-valued op arg renders as a textarea and round-trips JSON', () => {
    const { root, route } = mount({
      initialRecipe: opRecipe({
        id: 'q',
        op: 'deal.search',
        args: { body: { data: [1, 2] }, q: 'open' },
      }),
    });

    const bodyField = findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'arg:body');
    expect(bodyField?.tagName).toBe('TEXTAREA');
    // Short scalar values keep the one-line input.
    expect(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'arg:q')?.tagName).toBe('INPUT');

    setValue(bodyField, '{"data":[3]}');
    expect(
      (route.getRecipe().steps[0] as { args: Record<string, unknown> }).args.body,
    ).toEqual({ data: [3] });
  });

  it('hasUnsavedChanges tracks dirty across edit → save (leave-guard seam)', async () => {
    const { root, route } = mount();
    expect(route.hasUnsavedChanges()).toBe(false);
    expect(route.hasInFlightWork()).toBe(false);

    setValue(findByAttr(root, RECIPE_EDITOR_RECIPE_NAME_ATTR), 'Renamed');
    expect(route.hasUnsavedChanges()).toBe(true);

    findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.click();
    expect(route.hasInFlightWork()).toBe(true);
    await tick();
    expect(route.hasUnsavedChanges()).toBe(false);
    expect(route.hasInFlightWork()).toBe(false);
  });

  it('validating does not clear the unsaved cue; saving does', async () => {
    const { root } = mount();

    setValue(findByAttr(root, RECIPE_EDITOR_RECIPE_NAME_ATTR), 'Renamed');
    expect(findByAttr(root, RECIPE_EDITOR_DIRTY_ATTR)?.textContent).toBe('Unsaved');

    findByAttr(root, RECIPE_EDITOR_VALIDATE_ATTR)?.click();
    await tick();
    expect(findByAttr(root, RECIPE_EDITOR_DIRTY_ATTR)?.textContent).toBe('Unsaved');

    findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.click();
    await tick();
    expect(findByAttr(root, RECIPE_EDITOR_DIRTY_ATTR)?.textContent).toBe('');
  });

  it('shows the op notice only while the connection slot is unfilled', () => {
    // Slot filled → no notice.
    const filled = opRecipe({
      id: 'q',
      op: 'deal.search',
      connection: '{{config.crm}}',
      args: {},
    });
    filled.variables = { crm: connVar('CRM') };
    const { root: filledRoot } = mount({ initialRecipe: filled });
    expect(findByAttr(filledRoot, RECIPE_EDITOR_OP_NOTICE_ATTR)).toBeUndefined();

    // Slot empty with a variable declared → notice points at the picker.
    const unfilled = opRecipe({ id: 'q', op: 'deal.search', args: {} });
    unfilled.variables = { crm: connVar('CRM') };
    const { root: unfilledRoot } = mount({ initialRecipe: unfilled });
    expect(findByAttr(unfilledRoot, RECIPE_EDITOR_OP_NOTICE_ATTR)?.textContent).toContain(
      'pick one above',
    );
  });

  // ──────────────────────────────────────────────────────────────
  // Slice C — recipe-level connection variables + depends_on + warnings
  // ──────────────────────────────────────────────────────────────

  it("Add variable declares a type:'connection' recipe variable", () => {
    const { doc, root, route } = mount();

    setValue(findByAttr(root, RECIPE_EDITOR_CONN_VAR_NAME_ATTR), 'crm');
    setValue(findByAttr(root, RECIPE_EDITOR_CONN_VAR_KIND_ATTR), 'mcp');
    const add = findByAttr(root, RECIPE_EDITOR_CONN_VAR_ADD_ATTR)!;
    add.focus();
    add.click();

    expect(route.getRecipe().variables.crm).toMatchObject({
      type: 'connection',
      connection_kind: 'mcp',
      label: 'crm',
    });
    expect(findByAttrValue(root, RECIPE_EDITOR_CONN_VAR_ROW_ATTR, 'crm')).toBeDefined();
    expect(doc.activeElement).toBe(
      findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'conn_var_label:crm'),
    );
  });

  it('an op-step connection slot becomes a picker once a connection variable exists', () => {
    const recipe = opRecipe({ id: 'q', op: 'deal.search', args: {} });
    recipe.variables = { crm: connVar('CRM') };
    const { root, route } = mount({ initialRecipe: recipe });

    // With a declared connection var the slot is a <select>, not a text input.
    const slot = findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'connection');
    expect(slot?.tagName).toBe('SELECT');

    setValue(slot, '{{config.crm}}');
    expect((route.getRecipe().steps[0] as { connection?: string }).connection).toBe(
      '{{config.crm}}',
    );
  });

  it("editing a connection variable's label and kind mutates the recipe", () => {
    const recipe = opRecipe({ id: 'q', op: 'deal.search', args: {} });
    recipe.variables = { crm: connVar('CRM') };
    const { root, route } = mount({ initialRecipe: recipe });

    setValue(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'conn_var_label:crm'), 'My CRM');
    setValue(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'conn_var_kind:crm'), 'mcp');

    const v = route.getRecipe().variables.crm as unknown as Record<string, unknown>;
    expect(v).toMatchObject({ label: 'My CRM', connection_kind: 'mcp', type: 'connection' });
  });

  it('Remove variable deletes the connection variable', () => {
    const recipe = opRecipe({ id: 'q', op: 'deal.search', args: {} });
    recipe.variables = { crm: connVar('CRM') };
    const { doc, root, route } = mount({ initialRecipe: recipe });

    expect(findByAttrValue(root, RECIPE_EDITOR_CONN_VAR_ROW_ATTR, 'crm')).toBeDefined();
    const remove = findByAttrValue(root, RECIPE_EDITOR_CONN_VAR_REMOVE_ATTR, 'crm')!;
    remove.focus();
    remove.click();

    expect('crm' in route.getRecipe().variables).toBe(false);
    expect(findByAttrValue(root, RECIPE_EDITOR_CONN_VAR_ROW_ATTR, 'crm')).toBeUndefined();
    expect(doc.activeElement).toBe(findByAttr(root, RECIPE_EDITOR_CONN_VAR_NAME_ATTR));
  });

  it('Remove variable focuses the next surviving connection variable', () => {
    const recipe = opRecipe({ id: 'q', op: 'deal.search', args: {} });
    recipe.variables = {
      crm: connVar('CRM'),
      billing: connVar('Billing'),
    };
    const { doc, root } = mount({ initialRecipe: recipe });

    const remove = findByAttrValue(root, RECIPE_EDITOR_CONN_VAR_REMOVE_ATTR, 'crm')!;
    remove.focus();
    remove.click();

    expect(doc.activeElement).toBe(
      findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'conn_var_label:billing'),
    );
  });

  it('editing depends_on sets the Tier-P pack list (CSV); empty clears it', () => {
    const { root, route } = mount();

    setValue(
      findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'depends_on'),
      'recued-core.hubspot, recued-core.salesforce',
    );
    expect(route.getRecipe().depends_on).toEqual([
      'recued-core.hubspot',
      'recued-core.salesforce',
    ]);

    setValue(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'depends_on'), '');
    expect('depends_on' in route.getRecipe()).toBe(false);
  });

  it('save op_warnings render as warn-severity issues, not an error', async () => {
    const saveCaller: BootstrapSave = async (args) => ({
      saved: true,
      recipe_id: args.recipe.recipe_id,
      version: 2,
      name: 'R',
      op_warnings: ['Tier-P op recued-core.hubspot.deal.read not covered by depends_on'],
    });
    const { root } = mount({ saveCaller });

    findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.click();
    await tick();

    const issue = findByAttr(root, RECIPE_EDITOR_ISSUE_ATTR);
    expect(issue?.getAttribute('data-severity')).toBe('warn');
    expect(textOf(issue!)).toContain('not covered by depends_on');

    const status = findByAttr(root, RECIPE_EDITOR_STATUS_ATTR);
    expect(status?.textContent).toContain('warning');
    // Saved with advisories — NOT an error state.
    expect(status?.getAttribute('data-state')).not.toBe('error');
  });

  // ──────────────────────────────────────────────────────────────
  // Slice D — reactive trigger authoring
  // ──────────────────────────────────────────────────────────────

  it('adds an accepted-form-response trigger and narrows it by form definition', () => {
    const { doc, root, route } = mount();

    expect(findByAttr(root, RECIPE_EDITOR_TRIGGERS_ATTR)).toBeDefined();
    const add = findByAttr(root, RECIPE_EDITOR_TRIGGER_ADD_ATTR)!;
    add.focus();
    add.click();

    expect(route.getRecipe().event_triggers).toEqual([
      { on: FORM_RESPONSE_ON_SHORTHAND },
    ]);
    expect(findByAttrValue(root, RECIPE_EDITOR_TRIGGER_ROW_ATTR, '0')).toBeDefined();

    const formId = findByAttrValue(root, RECIPE_EDITOR_TRIGGER_FORM_ID_ATTR, '0');
    expect(doc.activeElement).toBe(formId);
    setValue(formId, 'client-intake');
    expect(route.getRecipe().event_triggers).toEqual([{
      on: FORM_RESPONSE_ON_SHORTHAND,
      where: { form_definition_id: 'client-intake' },
    }]);

    setValue(formId, '');
    expect(route.getRecipe().event_triggers).toEqual([
      { on: FORM_RESPONSE_ON_SHORTHAND },
    ]);
    expect(route.hasUnsavedChanges()).toBe(true);
  });

  it('allows one recipe to watch multiple accepted-response form definitions', () => {
    const recipe = opRecipe({ id: 'q', op: 'core.test.read', args: {} });
    recipe.event_triggers = [{
      on: FORM_RESPONSE_ON_SHORTHAND,
      where: { endpoint_id: 'reception', form_definition_id: 'client-intake' },
    }];
    const { root, route } = mount({ initialRecipe: recipe });

    setValue(
      findByAttrValue(root, RECIPE_EDITOR_TRIGGER_FORM_ID_ATTR, '0'),
      'updated-client-intake',
    );
    expect(route.getRecipe().event_triggers?.[0]?.where).toEqual({
      endpoint_id: 'reception',
      form_definition_id: 'updated-client-intake',
    });

    findByAttr(root, RECIPE_EDITOR_TRIGGER_ADD_ATTR)?.click();
    setValue(
      findByAttrValue(root, RECIPE_EDITOR_TRIGGER_FORM_ID_ATTR, '1'),
      'vendor-intake',
    );
    expect(route.getRecipe().event_triggers).toEqual([
      {
        on: FORM_RESPONSE_ON_SHORTHAND,
        where: { endpoint_id: 'reception', form_definition_id: 'updated-client-intake' },
      },
      {
        on: FORM_RESPONSE_ON_SHORTHAND,
        where: { form_definition_id: 'vendor-intake' },
      },
    ]);
  });

  it('adds one event-bound response reader as a prefetch step', () => {
    const recipe = opRecipe({ id: 'after', transform: 'default', value: 'ok' });
    recipe.event_triggers = [{ on: FORM_RESPONSE_ON_SHORTHAND }];
    const { root, route } = mount({ initialRecipe: recipe });

    expect(
      findByAttr(root, RECIPE_EDITOR_FORM_RESPONSE_READER_ATTR)?.getAttribute(
        RECIPE_EDITOR_FORM_RESPONSE_READER_ATTR,
      ),
    ).toBe('missing');
    findByAttrValue(root, RECIPE_EDITOR_FORM_RESPONSE_READER_ACTION_ATTR, 'add')?.click();

    expect(route.getRecipe().prefetch_steps).toEqual([{
      id: 'form_response',
      op: 'core.data.form-response.get',
      args: { submission_id: '{{context.event.payload.record_id}}' },
    }]);
    expect(route.getRecipe().steps).toEqual(recipe.steps);
    expect(
      findByAttr(root, RECIPE_EDITOR_FORM_RESPONSE_READER_ATTR)?.getAttribute(
        RECIPE_EDITOR_FORM_RESPONSE_READER_ATTR,
      ),
    ).toBe('ready');
    expect(findByAttr(root, RECIPE_EDITOR_FORM_RESPONSE_READER_ACTION_ATTR)).toBeUndefined();
    expect(textOf(findByAttr(root, RECIPE_EDITOR_FORM_RESPONSE_READER_ATTR)!)).toContain(
      '{{step.form_response.record}}',
    );
  });

  it('preserves a fixed reader by default and adds a separate event reader', () => {
    const recipe = opRecipe({ id: 'after', transform: 'default', value: 'ok' });
    recipe.event_triggers = [{ on: FORM_RESPONSE_ON_SHORTHAND }];
    recipe.prefetch_steps = [{
      id: 'response',
      op: 'core.data.form-response.get',
      args: { submission_id: 'fixed-submission', keep: 'value' },
    }];
    const { root, route } = mount({ initialRecipe: recipe });

    expect(
      findByAttr(root, RECIPE_EDITOR_FORM_RESPONSE_READER_ATTR)?.getAttribute(
        RECIPE_EDITOR_FORM_RESPONSE_READER_ATTR,
      ),
    ).toBe('needs-binding');
    findByAttrValue(root, RECIPE_EDITOR_FORM_RESPONSE_READER_ACTION_ATTR, 'add')?.click();

    expect(route.getRecipe().prefetch_steps).toEqual([
      {
        id: 'response',
        op: 'core.data.form-response.get',
        args: { submission_id: 'fixed-submission', keep: 'value' },
      },
      {
        id: 'form_response',
        op: 'core.data.form-response.get',
        args: { submission_id: '{{context.event.payload.record_id}}' },
      },
    ]);
    expect(findByAttr(root, RECIPE_EDITOR_FORM_RESPONSE_READER_ACTION_ATTR)).toBeUndefined();
  });

  it('rebinds a fixed reader only through the explicit bind action', () => {
    const recipe = opRecipe({ id: 'after', transform: 'default', value: 'ok' });
    recipe.event_triggers = [{ on: FORM_RESPONSE_ON_SHORTHAND }];
    recipe.prefetch_steps = [{
      id: 'response',
      op: 'core.data.form-response.get',
      args: { submission_id: 'fixed-submission', keep: 'value' },
    }];
    const { doc, root, route } = mount({ initialRecipe: recipe });

    const bind = findByAttrValue(
      root,
      RECIPE_EDITOR_FORM_RESPONSE_READER_ACTION_ATTR,
      'bind',
    )!;
    bind.focus();
    bind.click();

    expect(route.getRecipe().prefetch_steps).toEqual([{
      id: 'response',
      op: 'core.data.form-response.get',
      args: {
        submission_id: '{{context.event.payload.record_id}}',
        keep: 'value',
      },
    }]);
    expect(findByAttr(root, RECIPE_EDITOR_FORM_RESPONSE_READER_ACTION_ATTR)).toBeUndefined();
    expect(doc.activeElement).toBe(
      findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'step_id'),
    );
  });

  it('recognizes an event-bound reader in sequential steps without adding another', () => {
    const recipe = opRecipe({
      id: 'response',
      op: 'core.data.form-response.get',
      args: { submission_id: '{{context.event.payload.record_id}}' },
    });
    recipe.event_triggers = [{ on: FORM_RESPONSE_ON_SHORTHAND }];
    const { root, route } = mount({ initialRecipe: recipe });

    expect(
      findByAttr(root, RECIPE_EDITOR_FORM_RESPONSE_READER_ATTR)?.getAttribute(
        RECIPE_EDITOR_FORM_RESPONSE_READER_ATTR,
      ),
    ).toBe('ready');
    expect(findByAttr(root, RECIPE_EDITOR_FORM_RESPONSE_READER_ACTION_ATTR)).toBeUndefined();
    expect(route.getRecipe().prefetch_steps).toEqual([]);
    expect(route.hasUnsavedChanges()).toBe(false);
  });

  it('adds only valid custom warehouse event patterns', () => {
    const { doc, root, route } = mount();

    setValue(
      findByAttr(root, RECIPE_EDITOR_TRIGGER_ADD_KIND_ATTR),
      'Custom event pattern',
    );
    const add = findByAttr(root, RECIPE_EDITOR_TRIGGER_ADD_ATTR);
    expect(add?.disabled).toBe(true);

    const pattern = findByAttr(root, RECIPE_EDITOR_TRIGGER_ADD_EVENT_ATTR);
    setValue(pattern, 'composition.reception_form_submission');
    expect(add?.disabled).toBe(true);
    setValue(pattern, 'not.a.warehouse.path');
    expect(add?.disabled).toBe(true);
    setValue(pattern, 'run.invoice-reminder.*.completed');
    expect(add?.disabled).toBe(false);
    setValue(pattern, 'data.mail.**.created');
    expect(add?.disabled).toBe(false);
    add?.focus();
    add?.click();

    expect(route.getRecipe().event_triggers).toEqual([
      { event: 'data.mail.**.created' },
    ]);
    expect(doc.activeElement).toBe(
      findByAttrValue(root, RECIPE_EDITOR_TRIGGER_EVENT_ATTR, '0'),
    );
  });

  it('Remove trigger focuses the next survivor, then the add type when empty', () => {
    const recipe = opRecipe({ id: 'q', op: 'core.test.read', args: {} });
    recipe.event_triggers = [
      { on: FORM_RESPONSE_ON_SHORTHAND },
      { event: 'data.mail.**.created' },
    ];
    const { doc, root } = mount({ initialRecipe: recipe });

    const firstRemove = findByAttrValue(root, RECIPE_EDITOR_TRIGGER_REMOVE_ATTR, '0')!;
    firstRemove.focus();
    firstRemove.click();
    expect(doc.activeElement).toBe(
      findByAttrValue(root, RECIPE_EDITOR_TRIGGER_EVENT_ATTR, '0'),
    );

    const finalRemove = findByAttrValue(root, RECIPE_EDITOR_TRIGGER_REMOVE_ATTR, '0')!;
    finalRemove.focus();
    finalRemove.click();
    expect(doc.activeElement).toBe(findByAttr(root, RECIPE_EDITOR_TRIGGER_ADD_KIND_ATTR));
  });

  it('edits a raw pattern without dropping its advanced dispatch filter', () => {
    const recipe = opRecipe({ id: 'q', op: 'core.test.read', args: {} });
    recipe.event_triggers = [{
      event: 'data.mail.**.created',
      filter: { 'record.folder': 'inbox' },
    }];
    const { root, route } = mount({ initialRecipe: recipe });

    setValue(
      findByAttrValue(root, RECIPE_EDITOR_TRIGGER_EVENT_ATTR, '0'),
      'data.mail.primary.message.created',
    );

    expect(route.getRecipe().event_triggers).toEqual([{
      event: 'data.mail.primary.message.created',
      filter: { 'record.folder': 'inbox' },
    }]);
  });

  it('preserves advanced sugar unchanged and can remove it explicitly', () => {
    const recipe = opRecipe({ id: 'q', op: 'core.test.read', args: {} });
    recipe.event_triggers = [{ on: 'deal.changed', fields: ['stage'] }];
    const { root, route } = mount({ initialRecipe: recipe });

    expect(route.getRecipe().event_triggers).toEqual([
      { on: 'deal.changed', fields: ['stage'] },
    ]);
    expect(textOf(findByAttrValue(root, RECIPE_EDITOR_TRIGGER_ROW_ATTR, '0')!)).toContain(
      'Advanced trigger',
    );

    findByAttrValue(root, RECIPE_EDITOR_TRIGGER_REMOVE_ATTR, '0')?.click();
    expect('event_triggers' in route.getRecipe()).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// Optional fields the editor must not assume
// ────────────────────────────────────────────────────────────────

/** ⛔ `prefetch_steps` IS OPTIONAL. `blankRecipe()` seeds it, so every test
 *  that builds its fixture here had it and the assumption went unnoticed for
 *  the life of the editor — but an `initialRecipe` is used exactly as given and
 *  `parseRecipe` accepts a recipe with no such key. Mounting one threw "Cannot
 *  read properties of undefined (reading 'length')" and the route rendered a
 *  dead end.
 *
 *  Found on 2026-07-29 by the first D-219 AI-written draft reaching the Kitchen,
 *  but nothing here is AI-specific: a hand-written or imported recipe omitting
 *  the key crashed identically. The fixture is deliberately the WHOLE recipe
 *  minus that one key, so it is a valid recipe and nothing else is in play. */
describe('recipe-editor: a valid recipe with no prefetch_steps', () => {
  const noPrefetch = (): RecipeDefinition => {
    const recipe = {
      recipe_id: 'weekly-check',
      version: 1,
      ttl: 300,
      metadata: {
        name: 'Weekly check', description: '', author: 'local',
        tags: ['sales'], supported_platforms: [],
      },
      variables: { offer_id: { type: 'string', label: 'Offer', required: true } },
      steps: [{ id: 'search_mail', op: 'core.mail.email.search', args: { slug: 'default' } }],
      output: { render: [] },
    } as unknown as RecipeDefinition;
    return recipe;
  };

  it('mounts instead of throwing, and shows no Prefetch section', () => {
    const recipe = noPrefetch();
    expect('prefetch_steps' in (recipe as object)).toBe(false);
    const { root, route } = mount({ initialRecipe: recipe });
    expect(findByAttr(root, RECIPE_EDITOR_ROUTE_ATTR)).toBeDefined();
    // The step it DOES declare still renders — a guard that rendered nothing
    // would pass a "did not throw" test while hiding the recipe.
    expect(route.getRecipe().steps).toHaveLength(1);
    expect(textOf(root)).not.toContain('Prefetch');
  });
});


// ────────────────────────────────────────────────────────────────
// D-219 — refining an AI draft in place
// ────────────────────────────────────────────────────────────────

describe('execution-case draft route: iterative refinement', () => {
  /** ⛔ NO `prefetch_steps`, on purpose. The editor NORMALISES it in, so its
   *  presence in what gets sent is proof the refinement carried the EDITOR's
   *  live value and not the stashed draft object. */
  const stashedRecipe = {
    recipe_id: 'v1',
    version: 1,
    ttl: 300,
    metadata: { name: 'V1', description: '', author: '', supported_platforms: [] },
    variables: {},
    steps: [{ id: 'a', op: 'core.data.calendar.list', args: {} }],
    output: { render: [] },
  };

  const mountDraft = (over: {
    result?: Awaited<ReturnType<NonNullable<MountExecutionCaseDraftRouteOptions['runDraftRecipe']>>>;
    handed?: boolean;
    gate?: Promise<void>;
  } = {}) => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const calls: Array<{ case_id: string; prompt: string; previous_recipe: unknown }> = [];
    const refined: unknown[] = [];
    const route = mountExecutionCaseDraftRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      draft: {
        draft_key: 'k', case_id: 'case_one',
        recipe: stashedRecipe, request_aliased: true,
      },
      validateCaller: okValidate,
      saveCaller: okSave,
      runDraftRecipe: async (args) => {
        calls.push(args);
        if (over.gate !== undefined) await over.gate;
        return over.result ?? {
          ok: true, recipe: { ...stashedRecipe, recipe_id: 'v2' }, issues: [],
        };
      },
      onRefined: (d) => { refined.push(d); return over.handed ?? true; },
      refineConfirmation: 'This spends your model quota.',
    });
    return { doc, root, route, calls, refined };
  };

  const btn = (root: ReturnType<typeof makeFakeElement>) =>
    findByAttrValue(root, EXECUTION_CASE_DRAFT_REFINE_ATTR, 'case_one')!;
  const box = (root: ReturnType<typeof makeFakeElement>) =>
    findByAttr(root, EXECUTION_CASE_DRAFT_REFINE_PROMPT_ATTR)!;
  const note = (root: ReturnType<typeof makeFakeElement>) =>
    findByAttr(root, EXECUTION_CASE_DRAFT_REFINE_ERROR_ATTR)!;

  it('places a named, styled refinement panel before the long editor', () => {
    const h = mountDraft();
    const host = findByAttr(h.root, EXECUTION_CASE_DRAFT_HOST_ATTR)!;
    const panel = findByAttr(host, EXECUTION_CASE_DRAFT_REFINE_PANEL_ATTR)!;
    const editor = findByAttr(host, RECIPE_EDITOR_ROUTE_ATTR)!;

    expect(host.children.indexOf(panel)).toBeLessThan(host.children.indexOf(editor));
    expect(panel.getAttribute('aria-label')).toBe('Refine AI draft');
    expect(box(h.root).getAttribute('aria-label')).toBe('What should change?');
    expect(note(h.root).getAttribute('role')).toBe('status');
    expect(h.doc.styleElements.some((style) =>
      style.hasAttribute('data-recued-execution-case-draft-styles'))).toBe(true);
    h.route.dispose();
  });

  it('⛔ refuses to spend anything until the owner says what should change', async () => {
    // "Revise it" with nothing said is a second slow call that produces the same
    // recipe, billed to the owner.
    const h = mountDraft();
    btn(h.root).click();
    expect(h.calls).toEqual([]);
    expect(note(h.root).textContent).toContain('Say what should change');
    h.route.dispose();
  });

  it('⛔ TWO presses, and the first one shows the cost', async () => {
    const h = mountDraft();
    box(h.root).value = 'only my own meetings';
    btn(h.root).click();
    expect(h.calls).toEqual([]);
    expect(note(h.root).textContent).toContain('spends your model quota');
    btn(h.root).click();
    await h.route.whenRefineSettled();
    expect(h.calls).toHaveLength(1);
    h.route.dispose();
  });

  it('keeps the confirmed refinement focused, busy, and single-flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = mountDraft({ gate });
    box(h.root).value = 'only my own meetings';
    btn(h.root).focus();
    btn(h.root).click();
    btn(h.root).click();

    expect(h.calls).toHaveLength(1);
    expect(btn(h.root).disabled).toBe(false);
    expect(btn(h.root).getAttribute('aria-disabled')).toBe('true');
    expect(btn(h.root).getAttribute('aria-busy')).toBe('true');
    expect(h.doc.activeElement).toBe(btn(h.root));
    btn(h.root).click();
    expect(h.calls).toHaveLength(1);

    release();
    await h.route.whenRefineSettled();
    expect(btn(h.root).getAttribute('aria-disabled')).toBeNull();
    expect(btn(h.root).getAttribute('aria-busy')).toBeNull();
    expect(h.doc.activeElement).toBe(btn(h.root));
    h.route.dispose();
  });

  it('⛔ sends the EDITOR\'s current recipe, not the stashed one', async () => {
    // ⛔⛔ The owner may have renamed steps or filled in variables before
    // pressing refine. Sending the draft that arrived would silently discard
    // that work and hand back a "revision" of something they had moved past.
    const h = mountDraft();
    box(h.root).value = 'only my own meetings';
    btn(h.root).click();
    btn(h.root).click();
    await h.route.whenRefineSettled();

    const sent = h.calls[0]!.previous_recipe as Record<string, unknown>;
    expect(h.calls[0]!.prompt).toBe('only my own meetings');
    // The discriminator: the editor normalises this in, the stash never had it.
    expect('prefetch_steps' in stashedRecipe).toBe(false);
    expect(Array.isArray(sent.prefetch_steps)).toBe(true);
    // And the revision is handed back for the shell to reopen.
    expect(h.refined).toHaveLength(1);
    h.route.dispose();
  });

  it('says so when the revision is not a valid recipe, and spends nothing further', async () => {
    const h = mountDraft({
      result: { ok: false, issues: ['steps[0].op: unknown op'], reason: 'invalid_recipe' },
    });
    box(h.root).value = 'change it';
    btn(h.root).click();
    btn(h.root).click();
    await h.route.whenRefineSettled();
    expect(note(h.root).textContent).toContain('not a valid recipe');
    expect(h.refined).toEqual([]);
    h.route.dispose();
  });

  it('renders NO refine control when the caller pair is absent', async () => {
    // The D-160 removability rule: an unwired dep degrades to the route that
    // shipped before, never to a dead button.
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const route = mountExecutionCaseDraftRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      draft: {
        draft_key: 'k', case_id: 'case_one',
        recipe: stashedRecipe, request_aliased: true,
      },
      validateCaller: okValidate,
      saveCaller: okSave,
    });
    // ⚠ This file's finder returns undefined (not null) when absent.
    expect(findByAttr(root, EXECUTION_CASE_DRAFT_REFINE_ATTR)).toBeUndefined();
    route.dispose();
  });
});
