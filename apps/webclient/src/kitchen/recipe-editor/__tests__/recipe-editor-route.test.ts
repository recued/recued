import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FORM_RESPONSE_ON_SHORTHAND,
  type LocalRecipeWebhookDoorPreview,
  type LocalRecipeWebhookStatus,
  type MailFactTypeSpec,
  type MailTemplate,
  type MailTemplateDefinition,
  type RecipeDefinition,
  type RecipeRunCaptureSummary,
  type ServerExecuteResponse,
} from '@recued/contracts';
import type { BrowserVariableCallers, ConfigEditorOverlayOptions, MailboxVariableCallers } from '@recued/ui-shared';
import type { HeldRunDelivery } from '../../../held-run-follow.js';

/** D-402 slice C5 — the shared settings form a trial opens, as the editor hands it over. What the form
 *  does with them is `ui-shared`'s own (`config-editor-overlay.test.ts`); here, its confirm and close. */
const settingsForms = vi.hoisted(() => [] as Array<{ opts: ConfigEditorOverlayOptions; closed: boolean; close(): void }>);
vi.mock('@recued/ui-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@recued/ui-shared')>();
  return {
    ...actual,
    wireConfigEditorOverlay: (opts: ConfigEditorOverlayOptions) => {
      const form = { opts, closed: false, close: () => { if (form.closed) return; form.closed = true; opts.onClose?.(); } };
      settingsForms.push(form);
      return { element: {} as HTMLElement, hasInFlightWork: () => false, destroy: form.close };
    },
  };
});

import {
  RECIPE_EDITOR_ADD_ATTR,
  RECIPE_EDITOR_ADD_KIND_ATTR,
  RECIPE_EDITOR_ADD_NAME_ATTR,
  RECIPE_EDITOR_COLLAPSE_ALL_ATTR,
  RECIPE_EDITOR_COND_ADD_ATTR,
  RECIPE_EDITOR_BINDINGS_ATTR,
  RECIPE_EDITOR_CONN_VAR_ADD_ATTR,
  RECIPE_EDITOR_CONN_VAR_ADVICE_ATTR,
  RECIPE_EDITOR_CONN_VAR_KIND_ATTR,
  RECIPE_EDITOR_CONN_VAR_NAME_ATTR,
  RECIPE_EDITOR_CONN_VAR_REMOVE_ATTR,
  RECIPE_EDITOR_CONN_VAR_ROW_ATTR,
  RECIPE_EDITOR_MAIL_TEMPLATE_ADD_ATTR,
  RECIPE_EDITOR_MAIL_TEMPLATE_COPY_ATTR,
  RECIPE_EDITOR_MAIL_TEMPLATE_NAME_ATTR,
  RECIPE_EDITOR_MAIL_TEMPLATE_ROW_ATTR,
  RECIPE_EDITOR_MAIL_TEMPLATE_SOURCE_ATTR,
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
  RECIPE_EDITOR_TRIGGER_ADD_FACT_TYPE_ATTR,
  RECIPE_EDITOR_TRIGGER_ADD_KIND_ATTR,
  RECIPE_EDITOR_TRIGGER_EVENT_ATTR,
  RECIPE_EDITOR_TRIGGER_FACT_ATTR,
  RECIPE_EDITOR_TRIGGER_FORM_ID_ATTR,
  RECIPE_EDITOR_TRIGGER_REMOVE_ATTR,
  RECIPE_EDITOR_TRIGGER_ROW_ATTR,
  RECIPE_EDITOR_TRIGGERS_ATTR,
  RECIPE_EDITOR_VALIDATE_ATTR,
  RECIPE_EDITOR_WEBHOOK_ADD_ATTR,
  RECIPE_EDITOR_WEBHOOK_ARM_ATTR,
  RECIPE_EDITOR_SAVE_QUESTION_ATTR,
  RECIPE_EDITOR_SAVE_ANSWER_ATTR,
  RECIPE_EDITOR_WEBHOOK_DISARM_ATTR,
  RECIPE_EDITOR_WEBHOOK_DOOR_ATTR,
  RECIPE_EDITOR_WEBHOOK_REMOVE_ATTR,
  RECIPE_EDITOR_WEBHOOK_SELECT_ATTR,
  RECIPE_EDITOR_WEBHOOK_STATUS_ATTR,
  RECIPE_EDITOR_WEBHOOKS_ATTR,
  bootstrapRecipeEditorRoute,
  RECIPE_EDITOR_TRIAL_CAPTURE_ATTR,
  RECIPE_EDITOR_TRIAL_ERROR_ATTR,
  RECIPE_EDITOR_TRIAL_STATUS_ATTR,
  RECIPE_EDITOR_TRY_ATTR,
  TRIAL_CAPTURE_READ_DELAYS_MS,
  type RecipeSaveResult,
  type RecipeWebhookControl,
  type RecipeValidateResult,
} from '../recipe-editor-route.js';
import type { RecipeTryCaller, RecipeTryResult } from '../recipe-try-caller.js';
import {
  mountExecutionCaseDraftRoute,
  EXECUTION_CASE_DRAFT_HOST_ATTR,
  EXECUTION_CASE_DRAFT_NOTES_ATTR,
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
  mailFactTypesCaller?: () => Promise<{ readonly types: readonly MailFactTypeSpec[] }>;
  mailTemplatesCaller?: () => Promise<{ readonly templates: readonly MailTemplate[] }>;
  mailTemplateStarterCaller?: (args: { template_id: string }) => Promise<{ readonly starter: MailTemplateDefinition }>;
  tryCaller?: RecipeTryCaller;
  followHeldRun?: (held: ServerExecuteResponse, deliver: HeldRunDelivery) => () => void;
  trialCapturesCaller?: (args: { recipe_id: string }) => Promise<{ captures: RecipeRunCaptureSummary[] }>;
  trialSettingsCallers?: { browsers?: BrowserVariableCallers; mailboxes?: MailboxVariableCallers };
}
type BootstrapValidate = (args: {
  recipe: RecipeDefinition;
}) => Promise<RecipeValidateResult>;
type BootstrapSave = (args: {
  recipe: RecipeDefinition;
  publisher_id?: string;
  webhook_bindings?: ReadonlyArray<{ binding: string; ingress_id: string }>;
  webhook_on?: boolean;
  webhook_consent?: string;
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
    ...(options.mailFactTypesCaller ? { mailFactTypesCaller: options.mailFactTypesCaller } : {}),
    ...(options.mailTemplatesCaller ? { mailTemplatesCaller: options.mailTemplatesCaller } : {}),
    ...(options.mailTemplateStarterCaller ? { mailTemplateStarterCaller: options.mailTemplateStarterCaller } : {}),
    ...(options.tryCaller ? { tryCaller: options.tryCaller } : {}),
    ...(options.followHeldRun ? { followHeldRun: options.followHeldRun } : {}),
    ...(options.trialCapturesCaller ? { trialCapturesCaller: options.trialCapturesCaller } : {}),
    ...(options.trialSettingsCallers ? { trialSettingsCallers: options.trialSettingsCallers } : {}),
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
    expect(findByAttrValue(root, 'aria-label', 'Recipe editor buttons')).toBeDefined();
    expect(textOf(root)).toContain('Recipe workspace Recipe editor');
    expect(textOf(root)).toContain('Build it, check it, and save it.');
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

  it('a stop_when condition round-trips through the builder, labelled "Stop when"', () => {
    const initialRecipe: RecipeDefinition = {
      recipe_id: 'r1',
      version: 1,
      ttl: 300,
      metadata: { name: 'R1', description: '', author: '', supported_platforms: [] },
      variables: {},
      prefetch_steps: [],
      steps: [{ id: 'gate', transform: 'count', input: '{{step.x}}' } as never],
      output: { render: [] },
    };
    const { root, route } = mount({ initialRecipe });

    const reveal = findByAttrValue(root, RECIPE_EDITOR_COND_ADD_ATTR, 'gate:stop_when')!;
    expect(reveal.textContent).toBe('+ Stop when');
    expect(reveal.getAttribute('aria-label')).toBe('Add Stop when condition for step gate');
    reveal.click();

    setValue(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'stop_when'), '{{step.gate}}');
    setValue(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'stop_when_op'), 'equal');
    setValue(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'stop_when_value'), '0');

    const saved = route.getRecipe().steps[0] as Record<string, unknown>;
    expect(saved.stop_when).toBe('{{step.gate}} equal 0');
    // A control field, not a parameter the count transform receives.
    expect(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'param:stop_when')).toBeUndefined();
  });

  it('offers "+ Stop when" on a step in steps only — never on a prefetch step', () => {
    const initialRecipe: RecipeDefinition = {
      recipe_id: 'r1',
      version: 1,
      ttl: 300,
      metadata: { name: 'R1', description: '', author: '', supported_platforms: [] },
      variables: {},
      prefetch_steps: [{ id: 'pre', ingredient: 'deal-reader', input: {} } as never],
      steps: [{ id: 'gate', guard: '{{step.x}}' } as never],
      output: { render: [] },
    };
    const { root } = mount({ initialRecipe });

    expect(findByAttrValue(root, RECIPE_EDITOR_COND_ADD_ATTR, 'gate:stop_when')).toBeDefined();
    expect(findByAttrValue(root, RECIPE_EDITOR_COND_ADD_ATTR, 'pre:stop_when')).toBeUndefined();
    // The other two conditions are still offered on the prefetch step.
    expect(findByAttrValue(root, RECIPE_EDITOR_COND_ADD_ATTR, 'pre:skip_when')).toBeDefined();
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
      'Check failed',
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
      .toBe('Checked, but you have changed things since');
    expect(findByAttr(root, RECIPE_EDITOR_ISSUE_ATTR)).toBeUndefined();
    expect(textOf(root)).not.toContain('This belongs to the older snapshot');
    expect(doc.activeElement).toBe(
      findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'recipe_name'),
    );
  });

  // D-201 Slice 10AW (10AS finding 30) — a recipe may leave its variables out,
  // as the validator allows. The editor holds them, so it opens such a recipe,
  // offers to add an input, and saves the recipe with them.
  it('opens a recipe that leaves its variables out, and saves it with them', async () => {
    const { variables: _left, ...bare } = opRecipe({ id: 'note', transform: 'template', template: 'hello' });
    const saveCalls: RecipeDefinition[] = [];
    const { root, route } = mount({
      initialRecipe: bare as RecipeDefinition,
      saveCaller: async (args) => {
        saveCalls.push(args.recipe);
        return { saved: true, recipe_id: args.recipe.recipe_id, version: 2, name: args.recipe.metadata.name };
      },
    });
    expect(route.getRecipe().variables).toEqual({});
    findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)!.click();
    await tick();
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0]!.variables).toEqual({});
    expect(saveCalls[0]!.steps).toEqual(bare.steps);
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
      .toContain('Anything let through from now on');

    setValue(findByAttr(root, RECIPE_EDITOR_RECIPE_ID_ATTR), 'forked-webhook-recipe');
    findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.click();
    expect(saved).toHaveLength(1);
    expect(findByAttr(root, RECIPE_EDITOR_STATUS_ATTR)?.textContent)
      .toContain('Switch off the saved webhook');
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

  it('D-201 Slice 10I — a save while its webhook is on asks first whether to keep it on, saying what the new version can also do', async () => {
    const initialRecipe = opRecipe({ id: 'noop', transform: 'compare', left: 'x' });
    initialRecipe.webhook_requirements = [{
      binding: 'webhook_delivery',
      profile_ids: ['generic.static-header-token.v1'],
      required_event_types: ['delivery'],
      decoded_payload_access: 'metadata_only',
      source_truth_policy: 'delivery_payload_allowed',
    }];
    initialRecipe.webhook_triggers = [{ binding: 'webhook_delivery', event_types: ['delivery'] }];
    const status = (armed: boolean): LocalRecipeWebhookStatus => ({
      declared: true,
      configured: true,
      armed,
      bindings: [{ binding: 'webhook_delivery', ingress_id: 'whi_generic' }],
      door: { state: 'minted', contract_id: 'contract_keep_on', operation_ids: ['core.ai.classify'] },
    });
    const saved: Array<Parameters<BootstrapSave>[0]> = [];
    const previewed: RecipeDefinition[] = [];
    const previewBindings: unknown[] = [];
    const preview: { door: LocalRecipeWebhookDoorPreview | null } = {
      door: {
        state: 'derivable',
        operation_ids: ['core.ai.classify', 'core.mail.send'],
        added: ['core.mail.send'],
        removed: [],
        widened: [],
        kept_off: [],
        history: 'kept',
        armed: true,
        consent: 'consent-shown',
      },
    };
    const { doc, root } = mount({
      initialRecipe,
      webhookControl: {
        ingresses: [],
        initialStatus: status(true),
        armCaller: async () => ({ webhook: status(true) }),
        disarmCaller: async () => ({ webhook: status(false) }),
        previewCaller: async ({ recipe, webhook_bindings }) => {
          previewed.push(recipe);
          previewBindings.push(webhook_bindings);
          return preview;
        },
      },
      saveCaller: async (args) => {
        saved.push(args);
        return {
          saved: true,
          recipe_id: args.recipe.recipe_id,
          version: saved.length + 1,
          name: args.recipe.metadata.name,
          webhook: status(args.webhook_on === true),
        };
      },
    });
    const question = () => findByAttr(root, RECIPE_EDITOR_SAVE_QUESTION_ATTR);
    const answer = (value: string) => findByAttrValue(root, RECIPE_EDITOR_SAVE_ANSWER_ATTR, value)!;

    // Save asks first: nothing is saved before the answer.
    setValue(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'recipe_name')!, 'Sends a mail now');
    findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.click();
    await tick();
    expect(saved).toEqual([]);
    expect(previewed).toHaveLength(1);
    expect(question()?.getAttribute(RECIPE_EDITOR_SAVE_QUESTION_ATTR)).toBe('asking');
    const text = textOf(question()!);
    expect(text).toContain('Its webhook is on. Keep it on for the version you save?');
    expect(text).toContain('This version can also do these when a message comes in, which the saved one cannot:');
    expect(text).toContain('core.mail.send');
    expect(text).not.toContain('core.ai.classify');
    // The question takes the focus, not its yes, and it is read whole.
    expect(doc.activeElement).toBe(question());
    const describedBy = question()!.getAttribute('aria-describedby')!.split(' ');
    // D-201 Slice 10AC (10AA finding 23) — the history sentence is part of it.
    expect(describedBy).toHaveLength(4);
    expect(describedBy[3]).toMatch(/-history$/);
    expect(answer('keep-on').getAttribute('aria-describedby')).toBe(describedBy.join(' '));

    // An edit closes it: it was about the draft as it was.
    const nameField = findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'recipe_name')!;
    nameField.focus();
    setValue(nameField, 'Sends a mail now, edited');
    expect(question()).toBeUndefined();
    expect(saved).toEqual([]);
    findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.click();
    await tick();
    expect(previewed).toHaveLength(2);
    expect(previewed[1]!.metadata.name).toBe('Sends a mail now, edited');
    // Asked from the field (as ⌘S asks), it still takes the focus.
    expect(doc.activeElement).toBe(question());

    // Keep it on: saved with the owner's answer.
    answer('keep-on').click();
    await tick();
    expect(saved).toHaveLength(1);
    // D-201 Slice 10M — the save carries what the owner was shown, and the
    // question was asked with the ways in the save sends.
    expect(saved[0]).toMatchObject({
      webhook_on: true,
      webhook_consent: 'consent-shown',
      webhook_bindings: [{ binding: 'webhook_delivery', ingress_id: 'whi_generic' }],
    });
    expect(previewBindings[0]).toEqual([{ binding: 'webhook_delivery', ingress_id: 'whi_generic' }]);
    expect(question()).toBeUndefined();
    expect(findByAttr(root, RECIPE_EDITOR_WEBHOOK_DISARM_ATTR)).toBeDefined();

    // Cancel saves nothing and gives Save back its focus.
    setValue(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'recipe_name')!, 'Changed again');
    findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.click();
    await tick();
    answer('cancel').click();
    await tick();
    expect(saved).toHaveLength(1);
    expect(question()).toBeUndefined();
    expect(doc.activeElement).toBe(findByAttr(root, RECIPE_EDITOR_SAVE_ATTR));

    // Undo changes the draft without an edit's own path: it closes it too.
    findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.click();
    await tick();
    expect(question()).toBeDefined();
    const buttonLabelled = (el: FakeElement, label: string): FakeElement | undefined =>
      el.tagName === 'BUTTON' && el.textContent === label
        ? el
        : el.children.map((child) => buttonLabelled(child, label)).find((found) => found !== undefined);
    buttonLabelled(root, 'Undo')!.click();
    await tick();
    expect(question()).toBeUndefined();
    expect(saved).toHaveLength(1);

    // Switch it off: saved without keeping it on.
    findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.click();
    await tick();
    expect(textOf(question()!)).toContain(
      'Switching it off closes the messages that did not reach it and cancels the ones waiting.',
    );
    answer('switch-off').click();
    await tick();
    expect(saved).toHaveLength(2);
    expect(saved[1]!.webhook_on).toBeUndefined();
    expect(saved[1]!.webhook_consent).toBeUndefined();
    expect(findByAttr(root, RECIPE_EDITOR_WEBHOOK_ARM_ATTR)).toBeDefined();

    // Off, a save asks nothing.
    setValue(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'recipe_name')!, 'Saved while off');
    findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.click();
    await tick();
    expect(saved).toHaveLength(3);
    expect(question()).toBeUndefined();

    // Switching it off while asked closes the question, and saves nothing.
    findByAttr(root, RECIPE_EDITOR_WEBHOOK_ARM_ATTR)!.click();
    await tick();
    setValue(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'recipe_name')!, 'Asked, then switched off');
    findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.click();
    await tick();
    expect(question()).toBeDefined();
    findByAttr(root, RECIPE_EDITOR_WEBHOOK_DISARM_ATTR)!.click();
    await tick();
    expect(question()).toBeUndefined();
    expect(saved).toHaveLength(3);
  });

  it('D-201 Slice 10M — the question names everything the door gains, what stays off, and when the history closes; a stale answer asks again', async () => {
    const initialRecipe = opRecipe({ id: 'noop', transform: 'compare', left: 'x' });
    initialRecipe.webhook_requirements = [{
      binding: 'webhook_delivery',
      profile_ids: ['generic.static-header-token.v1'],
      required_event_types: ['delivery'],
      decoded_payload_access: 'metadata_only',
      source_truth_policy: 'delivery_payload_allowed',
    }];
    initialRecipe.webhook_triggers = [{ binding: 'webhook_delivery', event_types: ['delivery'] }];
    const status: LocalRecipeWebhookStatus = {
      declared: true,
      configured: true,
      armed: true,
      bindings: [{ binding: 'webhook_delivery', ingress_id: 'whi_generic' }],
    };
    const answers: LocalRecipeWebhookDoorPreview[] = [
      {
        state: 'derivable',
        operation_ids: ['core.ai.summarize', 'core.mail.send'],
        added: ['core.mail.send', 'connection:acct-work', 'ingredient:http-fetch'],
        removed: ['connection:acct-personal'],
        widened: ['webhook_delivery:scoped_read'],
        kept_off: ['core.ai.summarize'],
        history: 'closed',
        armed: true,
        consent: 'consent-1',
      },
      {
        state: 'derivable',
        operation_ids: ['core.mail.send'],
        added: ['core.mail.send'],
        removed: [],
        widened: [],
        kept_off: [],
        history: 'kept',
        armed: true,
        consent: 'consent-2',
      },
    ];
    let asked = 0;
    const saved: Array<Parameters<BootstrapSave>[0]> = [];
    const { root } = mount({
      initialRecipe,
      webhookControl: {
        ingresses: [],
        initialStatus: status,
        armCaller: async () => ({ webhook: status }),
        disarmCaller: async () => ({ webhook: status }),
        previewCaller: async () => ({ door: answers[Math.min(asked++, answers.length - 1)]! }),
      },
      saveCaller: async (args) => {
        saved.push(args);
        if (saved.length === 1) {
          throw Object.assign(new Error('recipe.save: what keeping its webhook on would allow changed'), {
            code: 'webhook_consent_stale',
          });
        }
        return { saved: true, recipe_id: args.recipe.recipe_id, version: 2, name: args.recipe.metadata.name, webhook: status };
      },
    });
    const question = () => findByAttr(root, RECIPE_EDITOR_SAVE_QUESTION_ATTR);
    setValue(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'recipe_name')!, 'Mails at work');
    findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.click();
    await tick();
    // The fake document joins each element's text with a space.
    const text = textOf(question()!).replace(/\s+/g, ' ');
    expect(text).toContain('core.mail.send');
    expect(text).toContain('use the connection acct-work');
    expect(text).toContain('run http-fetch');
    expect(text).toContain('read what webhook_delivery messages say');
    expect(text).toContain('These stay off, as you switched them off under Contracts: core.ai.summarize');
    // D-201 Slice 10Y — an answer without `history_triggers` is a server's
    // before 10Y: one trigger closes, it does not say which.
    expect(text).toContain('This version changes how messages reach it, so those it takes differently close if they did not reach it');
    expect(question()!.getAttribute('aria-describedby')!.split(' ')).toHaveLength(5);

    // Kept on, but what it would allow changed meanwhile: nothing saved; asked again.
    findByAttrValue(root, RECIPE_EDITOR_SAVE_ANSWER_ATTR, 'keep-on')!.click();
    await tick();
    expect(saved[0]).toMatchObject({ webhook_on: true, webhook_consent: 'consent-1' });
    expect(asked).toBe(2);
    expect(textOf(findByAttr(root, RECIPE_EDITOR_STATUS_ATTR)!))
      .toContain('What keeping its webhook on would allow changed since you were asked. Here it is again.');
    expect(textOf(question()!)).not.toContain('acct-work');
    findByAttrValue(root, RECIPE_EDITOR_SAVE_ANSWER_ATTR, 'keep-on')!.click();
    await tick();
    expect(saved[1]).toMatchObject({ webhook_on: true, webhook_consent: 'consent-2' });
    expect(question()).toBeUndefined();
  });

  it('D-201 Slice 10S — an operation the owner switched off and the draft adds back is listed once, as staying off (10Q finding 13)', async () => {
    const initialRecipe = opRecipe({ id: 'noop', transform: 'compare', left: 'x' });
    initialRecipe.webhook_requirements = [{
      binding: 'webhook_delivery',
      profile_ids: ['generic.static-header-token.v1'],
      required_event_types: ['delivery'],
      decoded_payload_access: 'metadata_only',
      source_truth_policy: 'delivery_payload_allowed',
    }];
    initialRecipe.webhook_triggers = [{ binding: 'webhook_delivery', event_types: ['delivery'] }];
    const status: LocalRecipeWebhookStatus = {
      declared: true,
      configured: true,
      armed: true,
      bindings: [{ binding: 'webhook_delivery', ingress_id: 'whi_generic' }],
    };
    const { root } = mount({
      initialRecipe,
      webhookControl: {
        ingresses: [],
        initialStatus: status,
        armCaller: async () => ({ webhook: status }),
        disarmCaller: async () => ({ webhook: status }),
        previewCaller: async () => ({
          door: {
            state: 'derivable',
            operation_ids: ['core.ai.summarize', 'core.mail.send'],
            added: ['core.ai.summarize', 'core.mail.send'],
            removed: [],
            kept_off: ['core.ai.summarize'],
            history: 'kept',
            armed: true,
            consent: 'c',
          },
        }),
      },
    });
    setValue(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'recipe_name')!, 'Adds summarize back');
    findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.click();
    await tick();
    const text = textOf(findByAttr(root, RECIPE_EDITOR_SAVE_QUESTION_ATTR)!).replace(/\s+/g, ' ');
    expect(text).toContain('which the saved one cannot: core.mail.send');
    expect(text).toContain('These stay off, as you switched them off under Contracts: core.ai.summarize');
    expect(text.split('core.ai.summarize').length - 1).toBe(1);
  });

  it('D-201 Slice 10M — a webhook switched off since the editor opened cannot be kept on', async () => {
    const initialRecipe = opRecipe({ id: 'noop', transform: 'compare', left: 'x' });
    initialRecipe.webhook_requirements = [{
      binding: 'webhook_delivery',
      profile_ids: ['generic.static-header-token.v1'],
      required_event_types: ['delivery'],
      decoded_payload_access: 'metadata_only',
      source_truth_policy: 'delivery_payload_allowed',
    }];
    initialRecipe.webhook_triggers = [{ binding: 'webhook_delivery', event_types: ['delivery'] }];
    const status: LocalRecipeWebhookStatus = {
      declared: true,
      configured: true,
      armed: true,
      bindings: [{ binding: 'webhook_delivery', ingress_id: 'whi_generic' }],
    };
    const { root } = mount({
      initialRecipe,
      webhookControl: {
        ingresses: [],
        initialStatus: status,
        armCaller: async () => ({ webhook: status }),
        disarmCaller: async () => ({ webhook: status }),
        previewCaller: async () => ({
          door: { state: 'derivable', operation_ids: [], added: [], removed: [], armed: false, consent: 'c' },
        }),
      },
    });
    setValue(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'recipe_name')!, 'Changed elsewhere');
    findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.click();
    await tick();
    expect(findByAttrValue(root, RECIPE_EDITOR_SAVE_ANSWER_ATTR, 'keep-on')!.disabled).toBe(true);
    const text = textOf(findByAttr(root, RECIPE_EDITOR_SAVE_QUESTION_ATTR)!);
    expect(text).toContain('Its webhook was switched off since you opened this. Saving now leaves it off.');
    // D-201 Slice 10S (10Q finding 13) — not "Its webhook is on." above it, and
    // no promise about keeping what it can no longer keep.
    expect(text).not.toContain('Its webhook is on.');
    expect(text).not.toContain('Keeping it on keeps them');
    // It is already off: there is nothing for switching it off to close now.
    expect(text).not.toContain('Switching it off closes');
  });

  it('D-201 Slice 10I — a version that cannot have a webhook door cannot be kept on', async () => {
    const initialRecipe = opRecipe({ id: 'noop', transform: 'compare', left: 'x' });
    initialRecipe.webhook_requirements = [{
      binding: 'webhook_delivery',
      profile_ids: ['generic.static-header-token.v1'],
      required_event_types: ['delivery'],
      decoded_payload_access: 'metadata_only',
      source_truth_policy: 'delivery_payload_allowed',
    }];
    initialRecipe.webhook_triggers = [{ binding: 'webhook_delivery', event_types: ['delivery'] }];
    const status: LocalRecipeWebhookStatus = {
      declared: true,
      configured: true,
      armed: true,
      bindings: [{ binding: 'webhook_delivery', ingress_id: 'whi_generic' }],
    };
    const saved: Array<Parameters<BootstrapSave>[0]> = [];
    const { doc, root } = mount({
      initialRecipe,
      webhookControl: {
        ingresses: [],
        initialStatus: status,
        armCaller: async () => ({ webhook: status }),
        disarmCaller: async () => ({ webhook: status }),
        previewCaller: async () => ({
          door: {
            state: 'refused',
            refusal: {
              reason: 'dynamic_dispatch',
              step_id: 'noop',
              detail: "step 'noop' chooses what to run at runtime",
            },
          },
        }),
      },
      saveCaller: async (args) => {
        saved.push(args);
        return { saved: true, recipe_id: args.recipe.recipe_id, version: 2, name: args.recipe.metadata.name };
      },
    });
    setValue(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'recipe_name')!, 'Dynamic now');
    findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.click();
    await tick();
    const keepOn = findByAttrValue(root, RECIPE_EDITOR_SAVE_ANSWER_ATTR, 'keep-on')!;
    expect(keepOn.disabled).toBe(true);
    const refusedText = textOf(findByAttr(root, RECIPE_EDITOR_SAVE_QUESTION_ATTR)!);
    expect(refusedText).toContain("This version cannot keep it on: step 'noop' chooses what to run at runtime.");
    // D-201 Slice 10S (10Q finding 13) — keeping it on is not an answer here.
    expect(refusedText).toContain('Switching it off closes the messages that did not reach it and cancels the ones waiting.');
    expect(refusedText).not.toContain('Keeping it on keeps them');
    expect(doc.activeElement).toBe(findByAttr(root, RECIPE_EDITOR_SAVE_QUESTION_ATTR));
    expect(saved).toEqual([]);
  });

  it('D-201 Slice 10X — a closed door names a remedy the owner can take, not a switch under Contracts', async () => {
    const initialRecipe = opRecipe({ id: 'noop', transform: 'compare', left: 'x' });
    initialRecipe.webhook_requirements = [{
      binding: 'webhook_delivery',
      profile_ids: ['generic.static-header-token.v1'],
      required_event_types: ['delivery'],
      decoded_payload_access: 'metadata_only',
      source_truth_policy: 'delivery_payload_allowed',
    }];
    initialRecipe.webhook_triggers = [{ binding: 'webhook_delivery', event_types: ['delivery'] }];
    const status: LocalRecipeWebhookStatus = {
      declared: true,
      configured: true,
      armed: true,
      bindings: [{ binding: 'webhook_delivery', ingress_id: 'whi_generic' }],
    };
    const { root } = mount({
      initialRecipe,
      webhookControl: {
        ingresses: [],
        initialStatus: status,
        armCaller: async () => ({ webhook: status }),
        disarmCaller: async () => ({ webhook: status }),
        previewCaller: async () => ({
          door: {
            state: 'refused',
            refusal: { reason: 'door_revoked', step_id: '<recipe>', detail: 'its door is closed' },
          },
        }),
      },
      saveCaller: async (args) => ({ saved: true, recipe_id: args.recipe.recipe_id, version: 2, name: args.recipe.metadata.name }),
    });
    setValue(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'recipe_name')!, 'Door closed');
    findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.click();
    await tick();
    const refusedText = textOf(findByAttr(root, RECIPE_EDITOR_SAVE_QUESTION_ATTR)!);
    // 10S said to switch the door on under Contracts, which has no such switch
    // for a webhook's door (10V finding 12).
    // D-201 Slice 10AC (10AA finding 16) — the remedy keeps what is waiting:
    // saving switched off, which 10X named, closes it.
    expect(refusedText).toContain(
      'Its door is closed, so this save cannot keep it on. Open its door first, from its webhook in Settings → '
        + 'Connections → Webhooks, then save again: what is waiting for it is kept. Saving with it switched off closes that.',
    );
    expect(refusedText).not.toContain('Contracts');
  });

  /** D-201 Slice 10Y — the save's question on a recipe whose webhook is on,
   *  as the server answers it with `door`. */
  const askedWith = async (door: LocalRecipeWebhookDoorPreview) => {
    const initialRecipe = opRecipe({ id: 'noop', transform: 'compare', left: 'x' });
    initialRecipe.webhook_requirements = [{
      binding: 'webhook_delivery',
      profile_ids: ['generic.static-header-token.v1'],
      required_event_types: ['delivery'],
      decoded_payload_access: 'metadata_only',
      source_truth_policy: 'delivery_payload_allowed',
    }];
    initialRecipe.webhook_triggers = [{ binding: 'webhook_delivery', event_types: ['delivery'] }];
    const status: LocalRecipeWebhookStatus = {
      declared: true,
      configured: true,
      armed: true,
      bindings: [{ binding: 'webhook_delivery', ingress_id: 'whi_generic' }],
    };
    const { root } = mount({
      initialRecipe,
      webhookControl: {
        ingresses: [],
        initialStatus: status,
        armCaller: async () => ({ webhook: status }),
        disarmCaller: async () => ({ webhook: status }),
        previewCaller: async () => ({ door }),
      },
    });
    setValue(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'recipe_name')!, 'Asked');
    findByAttr(root, RECIPE_EDITOR_SAVE_ATTR)?.click();
    await tick();
    const question = findByAttr(root, RECIPE_EDITOR_SAVE_QUESTION_ATTR)!;
    return { root, text: textOf(question).replace(/\s+/g, ' ') };
  };
  const derivable = {
    state: 'derivable',
    operation_ids: [],
    added: [],
    removed: [],
    widened: [],
    kept_off: [],
    armed: true,
    consent: 'c',
  } as const satisfies LocalRecipeWebhookDoorPreview;
  const trigger = (event_type: string, history: 'kept' | 'closed') => ({ slot: 'billing', event_type, history });

  it('D-201 Slice 10AC — the question is described by what its history does, each list included (10AA finding 23)', async () => {
    const partly = await askedWith({
      ...derivable,
      history: 'closed',
      history_triggers: [trigger('subscription.canceled', 'closed'), trigger('subscription.updated', 'kept')],
    });
    const question = findByAttr(partly.root, RECIPE_EDITOR_SAVE_QUESTION_ATTR)!;
    const ids = question.getAttribute('aria-describedby')!.split(' ');
    const describedText = ids.map((id) => {
      const element = findByAttrValue(question, 'id', id);
      expect(element, id).toBeDefined();
      return textOf(element!).replace(/\s+/g, ' ');
    }).join(' ');
    expect(describedText).toContain('so the ones that did not reach it close and the ones waiting are cancelled, whichever you choose:');
    expect(describedText).toContain('subscription.canceled on billing');
    expect(describedText).toContain('Keeping it on keeps these for this version. Switching it off closes them too:');
    expect(describedText).toContain('subscription.updated on billing');
    // The single sentence too, when every trigger's history goes the same way.
    const kept = await askedWith({
      ...derivable,
      history: 'kept',
      history_triggers: [trigger('subscription.canceled', 'kept')],
    });
    const keptQuestion = findByAttr(kept.root, RECIPE_EDITOR_SAVE_QUESTION_ATTR)!;
    const keptIds = keptQuestion.getAttribute('aria-describedby')!.split(' ');
    expect(keptIds.map((id) => textOf(findByAttrValue(keptQuestion, 'id', id)!)).join(' '))
      .toContain('Keeping it on keeps them for this version.');
  });

  it("D-201 Slice 10AC — what stays off is only what this version's door has, as a server before 10Y lists more (10AA finding 22)", async () => {
    const asked = await askedWith({
      ...derivable,
      operation_ids: ['core.mail.send'],
      kept_off: ['core.ai.summarize', 'core.mail.send'],
      history: 'kept',
    });
    expect(asked.text).toContain('These stay off, as you switched them off under Contracts: core.mail.send');
    expect(asked.text).not.toContain('core.ai.summarize');
  });

  it('D-201 Slice 10Y — the question says which history closes and which keeping it on keeps (10V finding 6)', async () => {
    const partly = await askedWith({
      ...derivable,
      history: 'closed',
      history_triggers: [trigger('subscription.canceled', 'closed'), trigger('subscription.updated', 'kept')],
    });
    expect(partly.text).toContain(
      'This version changes how these messages reach it, so the ones that did not reach it close and the ones waiting are cancelled, whichever you choose: subscription.canceled on billing',
    );
    expect(partly.text).toContain(
      'Keeping it on keeps these for this version. Switching it off closes them too: subscription.updated on billing',
    );
    // 10V reproduced "whichever you choose" for the whole history here.
    expect(partly.text).not.toContain('so the messages that did not reach it close');

    const all = await askedWith({
      ...derivable,
      history: 'closed',
      history_triggers: [trigger('subscription.canceled', 'closed'), trigger('subscription.updated', 'closed')],
    });
    expect(all.text).toContain(
      'This version changes how messages reach it, so the messages that did not reach it close and the ones waiting are cancelled, whichever you choose.',
    );
    expect(all.text).not.toContain('Keeping it on keeps');

    const kept = await askedWith({
      ...derivable,
      history: 'kept',
      history_triggers: [trigger('subscription.canceled', 'kept'), trigger('subscription.updated', 'kept')],
    });
    expect(kept.text).toContain(
      'Switching it off closes the messages that did not reach it and cancels the ones waiting. Keeping it on keeps them for this version.',
    );

    // A server before 10Y says one closes, not which.
    const older = await askedWith({ ...derivable, history: 'closed' });
    expect(older.text).toContain(
      'so those it takes differently close if they did not reach it and their waiting ones are cancelled, whichever you choose. Keeping it on keeps the rest for this version.',
    );
  });

  it('D-201 Slice 10Y — each thing a version gains is asked about on its own, and one that stays off is not a gain (10V finding 19)', async () => {
    const offOnly = await askedWith({
      ...derivable,
      operation_ids: ['core.ai.summarize'],
      added: ['core.ai.summarize'],
      kept_off: ['core.ai.summarize'],
      history: 'kept',
    });
    expect(offOnly.text).toContain('This version can do nothing a message could start that the saved one cannot.');
    expect(offOnly.text).not.toContain('can also do these');
    expect(offOnly.text).toContain('These stay off, as you switched them off under Contracts: core.ai.summarize');
    const gains: Array<[Partial<LocalRecipeWebhookDoorPreview>, string]> = [
      [{ added: ['core.mail.send'] }, 'core.mail.send'],
      [{ added: ['connection:acct-work'] }, 'use the connection acct-work'],
      [{ added: ['ingredient:http-fetch'] }, 'run http-fetch'],
      [{ widened: ['webhook_delivery:scoped_read'] }, 'read what webhook_delivery messages say'],
    ];
    for (const [gain, shown] of gains) {
      const one = await askedWith({ ...derivable, history: 'kept', ...gain });
      expect(one.text).toContain(`This version can also do these when a message comes in, which the saved one cannot: ${shown}`);
      expect(one.text).toContain('Keeping it on says yes to them.');
    }
  });

  it('D-201 Slice 10Y — a draft that cannot keep it on, on a webhook switched off since, says it is off (10V finding 21)', async () => {
    const off = await askedWith({
      state: 'refused',
      refusal: { reason: 'dynamic_dispatch', step_id: 'noop', detail: "step 'noop' chooses what to run at runtime" },
      armed: false,
    });
    expect(off.text).toContain('Its webhook was switched off since you opened this. Saving now leaves it off.');
    expect(off.text).not.toContain('Its webhook is on.');
    expect(off.text).not.toContain('Switching it off closes');
    expect(findByAttrValue(off.root, RECIPE_EDITOR_SAVE_ANSWER_ATTR, 'keep-on')!.disabled).toBe(true);
    // On, the refusal is said as before.
    const on = await askedWith({
      state: 'refused',
      refusal: { reason: 'dynamic_dispatch', step_id: 'noop', detail: "step 'noop' chooses what to run at runtime" },
      armed: true,
    });
    expect(on.text).toContain("Its webhook is on. Keep it on for the version you save? This version cannot keep it on: step 'noop' chooses what to run at runtime.");
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
    expect(busyArm.textContent).toBe('Switching on…');
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
    expect(disarm.textContent).toBe('Switch off webhook');
    expect(doc.activeElement).toBe(disarm);

    disarm.click();
    const busyDisarm = findByAttr(root, RECIPE_EDITOR_WEBHOOK_DISARM_ATTR)!;
    expect(busyDisarm).not.toBe(disarm);
    expect(busyDisarm.textContent).toBe('Switching off…');
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
      .toContain('can read what was sent');
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
      expect(text).toContain('Once this is on, anything let through may:');
      expect(text).toContain('core.mail.send');
      expect(text).toContain('recued-core/hubspot-catalog.deal.create');
      expect(text).toContain('Switching it on is your yes');
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
      expect(textOf(block!)).toContain('the door gives nothing away');
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
      expect(text).toContain('changed what this webhook may do');
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
      expect(dirtyText).not.toContain('changed what this webhook may do');
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
      expect(text).toContain('Anything let through may:');
      expect(text).not.toContain('Once this is on');
      expect(text).toContain('Switching it on was your yes');
    });

    // D-201 Slice 10S (10Q finding 12) — a save that switched it off kept the
    // door, switch-offs and all: switching it on lists those apart, never as let through.
    it('lists what the owner switched off apart from what is let through', () => {
      const count = (text: string, needle: string) => text.split(needle).length - 1;
      const { root } = mount({
        initialRecipe: webhookRecipe(),
        webhookControl: control({
          state: 'minted',
          contract_id: 'contract_door_1',
          operation_ids: ['core.ai.summarize', 'core.mail.send'],
          switched_off: ['core.ai.summarize'],
        }),
      });
      const text = textOf(findByAttrValue(root, RECIPE_EDITOR_WEBHOOK_DOOR_ATTR, 'minted')!).replace(/\s+/g, ' ');
      expect(text).toContain('Once this is on, anything let through may: core.mail.send');
      expect(text).toContain('Switched off under Contracts, so these never run: core.ai.summarize');
      expect(count(text, 'core.ai.summarize')).toBe(1);

      const { root: allOff } = mount({
        initialRecipe: webhookRecipe(),
        webhookControl: control({
          state: 'minted',
          contract_id: 'contract_door_1',
          operation_ids: ['core.ai.summarize'],
          switched_off: ['core.ai.summarize'],
        }),
      });
      expect(textOf(findByAttrValue(allOff, RECIPE_EDITOR_WEBHOOK_DOOR_ATTR, 'minted')!))
        .toContain('Everything it would ask for is switched off under Contracts, so nothing is let through.');
    });

    // D-201 Slice 10Y (10V finding 20) — a server before 10Y lists a switch-off
    // carried onto a door without that operation, and one taken back as added.
    it('lists only the door\'s own switch-offs, and none of them as added by the save', () => {
      const { root } = mount({
        initialRecipe: webhookRecipe(),
        webhookControl: control({
          state: 'minted',
          contract_id: 'contract_door_2',
          operation_ids: ['core.ai.summarize', 'core.mail.send'],
          added: ['core.ai.summarize', 'core.mail.send'],
          removed: [],
          switched_off: ['core.ai.summarize', 'core.task.delete'],
        }),
      });
      const text = textOf(findByAttrValue(root, RECIPE_EDITOR_WEBHOOK_DOOR_ATTR, 'minted')!).replace(/\s+/g, ' ');
      expect(text).toContain('Switched off under Contracts, so these never run: core.ai.summarize');
      expect(text).not.toContain('core.task.delete');
      expect(text).toContain('Saving changed what this webhook may do: + core.mail.send');
      expect(text).not.toContain('+ core.ai.summarize');
    });

    // D-201 Slice 10AC (10AA finding 9) — its switch makes or opens the door,
    // as the card's "Open its door" does: Kitchen disabled it and named a save.
    it('switches on a recipe whose door is missing or closed, which makes or opens it', async () => {
      for (const doorState of ['missing', 'closed'] as const) {
        const armed: string[] = [];
        const { root } = mount({
          initialRecipe: webhookRecipe(),
          webhookControl: {
            ...control({ state: doorState }),
            armCaller: async (args) => {
              armed.push(args.recipe_id);
              return { webhook: { ...control({ state: 'minted', contract_id: 'c', operation_ids: [] }).initialStatus, armed: true } };
            },
          },
        });
        const block = findByAttrValue(root, RECIPE_EDITOR_WEBHOOK_DOOR_ATTR, doorState)!;
        expect(textOf(block), doorState).toContain(doorState === 'missing'
          ? 'There is no door behind this webhook. Nothing gets through until there is one. Switching it on makes one.'
          : 'The door behind this webhook is closed. Nothing gets through while it is closed. Switching it on opens '
            + 'it again, with what you switched off under Contracts still off.');
        expect(findByAttr(root, RECIPE_EDITOR_WEBHOOK_STATUS_ATTR)?.textContent, doorState).toBe(doorState === 'missing'
          ? 'Its webhook door is missing. Switching it on makes one.'
          : 'Its webhook door is closed. Switching it on opens it again, with what you switched off under Contracts still off.');
        const arm = findByAttr(root, RECIPE_EDITOR_WEBHOOK_ARM_ATTR)!;
        expect(arm.textContent).toBe('Switch on webhook');
        expect(arm.disabled, doorState).toBe(false);
        arm.click();
        await tick();
        expect(armed, doorState).toEqual([webhookRecipe().recipe_id]);
      }
    });

    it('offers to open the door of a webhook already on whose door is missing or closed; one that is open needs none', async () => {
      for (const doorState of ['missing', 'closed'] as const) {
        const armed: string[] = [];
        const { root } = mount({
          initialRecipe: webhookRecipe(),
          webhookControl: {
            ...control({ state: doorState }, true),
            armCaller: async (args) => {
              armed.push(args.recipe_id);
              return { webhook: { ...control({ state: 'minted', contract_id: 'c', operation_ids: [] }).initialStatus, armed: true } };
            },
          },
        });
        expect(findByAttr(root, RECIPE_EDITOR_WEBHOOK_DISARM_ATTR), doorState).toBeDefined();
        const open = findByAttr(root, RECIPE_EDITOR_WEBHOOK_ARM_ATTR)!;
        expect(open.textContent, doorState).toBe('Open its door');
        expect(open.disabled, doorState).toBe(false);
        expect(findByAttr(root, RECIPE_EDITOR_WEBHOOK_STATUS_ATTR)?.textContent, doorState).toBe(doorState === 'missing'
          ? 'Its webhook door is missing, so nothing it lets through runs. Open its door to make one.'
          : 'Its webhook door is closed, so nothing it lets through runs. Open its door to open it again, with what you switched off under Contracts still off.');
        open.click();
        await tick();
        expect(armed, doorState).toEqual([webhookRecipe().recipe_id]);
      }
      const { root } = mount({
        initialRecipe: webhookRecipe(),
        webhookControl: control({ state: 'minted', contract_id: 'c', operation_ids: ['core.mail.send'] }, true),
      });
      expect(findByAttr(root, RECIPE_EDITOR_WEBHOOK_ARM_ATTR)).toBeUndefined();
    });

    // D-201 Slice 10AF (10AE finding 16) — a server since 10AF sends a closed
    // door as `missing` with `closed`, which a Kitchen before 10AC reads as
    // letting nothing through; this one reads it closed.
    it('reads a closed door sent as missing with closed, as it reads closed', () => {
      const { root } = mount({
        initialRecipe: webhookRecipe(),
        webhookControl: control({ state: 'missing', closed: true }, true),
      });
      expect(textOf(findByAttrValue(root, RECIPE_EDITOR_WEBHOOK_DOOR_ATTR, 'closed')!))
        .toContain('The door behind this webhook is closed.');
      expect(findByAttr(root, RECIPE_EDITOR_WEBHOOK_STATUS_ATTR)?.textContent).toBe(
        'Its webhook door is closed, so nothing it lets through runs. Open its door to open it again, with what you switched off under Contracts still off.');
    });

    // D-201 Slice 10AX (10AS finding 13) — its owner's closing in the card's
    // words (`ownerClosedDoorClause`): Kitchen said "the door behind this
    // webhook is closed" where the card said there was none, and "refused"
    // alone where the card said "you closed it".
    it("says a door its owner closed as the webhook's card does: a door there, none now, or none yet", () => {
      const cases = [
        {
          door: { state: 'missing', closed: true, closed_by_owner: true },
          lede: 'You closed its door.',
          status: 'You closed its door, so nothing it lets through runs. Open its door to open it again, with what you '
            + 'switched off under Contracts still off.',
        },
        {
          door: { state: 'missing', closed: true, closed_by_owner: true, no_door: true },
          lede: 'You closed its door, and there is no door behind it now.',
          status: 'You closed its door, and there is no door behind it now, so nothing it lets through runs. Open its '
            + 'door to make one, with what you switched off under Contracts still off.',
        },
        {
          door: { state: 'missing', closed: true, closed_by_owner: true, no_door: true, no_door_yet: true },
          lede: 'You closed it before its door was made, so there is no door behind it.',
          status: 'You closed it before its door was made, so there is no door behind it and nothing it lets through '
            + 'runs. Open its door to make one, with what you switched off under Contracts still off.',
        },
      ] as const;
      for (const { door, lede, status } of cases) {
        const { root } = mount({ initialRecipe: webhookRecipe(), webhookControl: control(door, true) });
        const block = textOf(findByAttrValue(root, RECIPE_EDITOR_WEBHOOK_DOOR_ATTR, 'closed')!);
        expect(block, lede).toContain(lede);
        expect(block, lede).not.toContain('The door behind this webhook is closed.');
        // With no door now, opening it makes one; with a door there, opens it again.
        expect(block, lede).toContain(door.closed_by_owner === true && 'no_door' in door
          ? 'Open its door to make one' : 'Open its door to open it again');
        expect(findByAttr(root, RECIPE_EDITOR_WEBHOOK_STATUS_ATTR)?.textContent, lede).toBe(status);
      }
      // Switched off, with no door now: switching it on makes one.
      const off = mount({
        initialRecipe: webhookRecipe(),
        webhookControl: control({ state: 'missing', closed: true, closed_by_owner: true, no_door: true }),
      });
      expect(findByAttr(off.root, RECIPE_EDITOR_WEBHOOK_STATUS_ATTR)?.textContent).toBe(
        'You closed its door, and there is no door behind it now. Switching it on makes one, with what you switched '
          + 'off under Contracts still off.');
      // A version that cannot have a door, under its owner's closing: both.
      const { root } = mount({
        initialRecipe: webhookRecipe(),
        webhookControl: control({
          state: 'refused',
          refusal: { reason: 'exposure_refused', step_id: '<recipe>', detail: 'it reads Records' },
          closed_by_owner: true,
          no_door: true,
        }, true),
      });
      const refused = textOf(findByAttrValue(root, RECIPE_EDITOR_WEBHOOK_DOOR_ATTR, 'refused')!);
      expect(refused).toContain('You closed its door, and there is no door behind it now. A webhook cannot start this '
        + 'Recipe as it stands:');
      expect(refused).toContain('it reads Records');
      expect(findByAttr(root, RECIPE_EDITOR_WEBHOOK_STATUS_ATTR)?.textContent).toBe(
        'You closed its door, and there is no door behind it now. This Recipe cannot have a webhook door as it '
          + 'stands. Change the step that was refused, then save.');
    });

    // D-201 Slice 10AF (10AE finding 15) — on, with its door missing: only the
    // button pressed reads busy and keeps focus. "Opening its door…" read busy
    // during a switch-off, and focus was lost after it.
    it('switching off beside "Open its door" marks only itself busy, and keeps focus on the switch', async () => {
      let finish!: () => void;
      const { root, doc } = mount({
        initialRecipe: webhookRecipe(),
        webhookControl: {
          ...control({ state: 'missing' }, true),
          disarmCaller: () => new Promise((resolve) => {
            finish = () => resolve({ webhook: { ...control({ state: 'missing' }).initialStatus, armed: false } });
          }),
        },
      });
      const disarm = findByAttr(root, RECIPE_EDITOR_WEBHOOK_DISARM_ATTR)!;
      disarm.focus();
      disarm.click();
      await tick();
      const busy = findByAttr(root, RECIPE_EDITOR_WEBHOOK_DISARM_ATTR)!;
      expect(busy.textContent).toBe('Switching off…');
      expect(busy.getAttribute('aria-busy')).toBe('true');
      const open = findByAttr(root, RECIPE_EDITOR_WEBHOOK_ARM_ATTR)!;
      expect(open.textContent).toBe('Open its door');
      expect(open.getAttribute('aria-busy')).toBeNull();
      expect(doc.activeElement).toBe(busy);
      finish();
      await tick();
      // Off: the switch drawn in its place takes focus.
      const arm = findByAttr(root, RECIPE_EDITOR_WEBHOOK_ARM_ATTR)!;
      expect(arm.textContent).toBe('Switch on webhook');
      expect(doc.activeElement).toBe(arm);
    });

    it('pressing "Open its door" keeps focus there and marks only it busy, not the switch-off drawn before it', async () => {
      let finish!: () => void;
      const { root, doc } = mount({
        initialRecipe: webhookRecipe(),
        webhookControl: {
          ...control({ state: 'missing' }, true),
          armCaller: () => new Promise((resolve) => {
            finish = () => resolve({
              webhook: { ...control({ state: 'minted', contract_id: 'c', operation_ids: [] }).initialStatus, armed: true },
            });
          }),
        },
      });
      const open = findByAttr(root, RECIPE_EDITOR_WEBHOOK_ARM_ATTR)!;
      expect(open.textContent).toBe('Open its door');
      open.focus();
      open.click();
      await tick();
      const busy = findByAttr(root, RECIPE_EDITOR_WEBHOOK_ARM_ATTR)!;
      expect(busy.textContent).toBe('Opening its door…');
      expect(busy.getAttribute('aria-busy')).toBe('true');
      const off = findByAttr(root, RECIPE_EDITOR_WEBHOOK_DISARM_ATTR)!;
      expect(off.textContent).toBe('Switch off webhook');
      expect(off.getAttribute('aria-busy')).toBeNull();
      expect(doc.activeElement).toBe(busy);
      finish();
      await tick();
    });

    // D-201 Slice 10AF (10AE finding 15) — not set up, its switch cannot be
    // pressed, so it is not offered as the remedy.
    it('a webhook not set up is not told that switching it on makes or opens its door', () => {
      for (const door of [{ state: 'missing' as const }, { state: 'missing' as const, closed: true as const }]) {
        const base = control(door);
        const { root } = mount({
          initialRecipe: webhookRecipe(),
          webhookControl: { ...base, initialStatus: { ...base.initialStatus, configured: false } },
        });
        expect(findByAttr(root, RECIPE_EDITOR_WEBHOOK_ARM_ATTR)!.disabled).toBe(true);
        const status = findByAttr(root, RECIPE_EDITOR_WEBHOOK_STATUS_ATTR)!.textContent ?? '';
        expect(status).toContain('Once its webhook is set up, switching it on');
        expect(textOf(findByAttr(root, RECIPE_EDITOR_WEBHOOK_DOOR_ATTR)!)).toContain('Once its webhook is set up, switching it on');
      }
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
      expect(text).toContain('A webhook cannot start this Recipe');
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

    // D-320 phase 3 — a step that names no connection is the normal case: the run
    // settles it, so there is no Connection slot field and nothing to say.
    expect(findByAttr(root, RECIPE_EDITOR_OP_NOTICE_ATTR)).toBeUndefined();
    expect(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'connection')).toBeUndefined();
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
    // D-320 phase 3 — the field shows only while the step names one.
    const { root, route } = mount({
      initialRecipe: opRecipe({ id: 'q', op: 'deal.search', connection: '{{config.old}}', args: {} }),
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

  it('shows the op notice only while the step names an API connection setting (D-320 phase 3)', () => {
    // Named → the notice says to leave it empty.
    const filled = opRecipe({
      id: 'q',
      op: 'deal.search',
      connection: '{{config.crm}}',
      args: {},
    });
    filled.variables = { crm: connVar('CRM') };
    const { root: filledRoot } = mount({ initialRecipe: filled });
    expect(findByAttr(filledRoot, RECIPE_EDITOR_OP_NOTICE_ATTR)?.textContent).toContain(
      'Leave Connection slot empty',
    );

    // Not named → nothing to do, so nothing said.
    const unfilled = opRecipe({ id: 'q', op: 'deal.search', args: {} });
    unfilled.variables = { crm: connVar('CRM') };
    const { root: unfilledRoot } = mount({ initialRecipe: unfilled });
    expect(findByAttr(unfilledRoot, RECIPE_EDITOR_OP_NOTICE_ATTR)).toBeUndefined();

    // A notification connection is not one a recipe stops naming.
    const notify = opRecipe({ id: 'q', op: 'deal.search', connection: '{{config.email}}', args: {} });
    notify.variables = { email: connVar('Email', 'notification') };
    const { root: notifyRoot } = mount({ initialRecipe: notify });
    expect(findByAttr(notifyRoot, RECIPE_EDITOR_OP_NOTICE_ATTR)).toBeUndefined();
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

    expect(route.getRecipe().variables!.crm).toMatchObject({
      type: 'connection',
      connection_kind: 'mcp',
      label: 'crm',
    });
    expect(findByAttrValue(root, RECIPE_EDITOR_CONN_VAR_ROW_ATTR, 'crm')).toBeDefined();
    expect(doc.activeElement).toBe(
      findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'conn_var_label:crm'),
    );
  });

  it('a new connection input is for mail, a notification or an MCP server, never an API (D-320 phase 3)', () => {
    const { root } = mount();
    const kinds = findByAttr(root, RECIPE_EDITOR_CONN_VAR_KIND_ATTR)!;
    expect(kinds.children.map((option) => option.value)).toEqual(['notification', 'mcp']);
    expect(kinds.value).toBe('notification');
    expect(textOf(findByAttr(root, RECIPE_EDITOR_BINDINGS_ATTR)!)).toContain(
      'A step that calls a pack uses the connection chosen for that pack, so a recipe names none.',
    );
  });

  it('an API connection input already there keeps its kind on show, with the advice to remove it', () => {
    const recipe = opRecipe({ id: 'q', op: 'deal.search', args: {} });
    recipe.variables = { crm: connVar('CRM'), email: connVar('Email', 'notification') };
    const { root } = mount({ initialRecipe: recipe });

    const kind = findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'conn_var_kind:crm')!;
    expect(kind.value).toBe('api');
    expect(kind.children.map((option) => option.value)).toEqual(['api', 'notification', 'mcp']);
    expect(findByAttrValue(root, RECIPE_EDITOR_CONN_VAR_ADVICE_ATTR, 'crm')?.textContent)
      .toContain('A recipe no longer asks for this');
    // A notification input is one a recipe still adds: no advice.
    expect(findByAttrValue(root, RECIPE_EDITOR_CONN_VAR_ADVICE_ATTR, 'email')).toBeUndefined();
    expect(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'conn_var_kind:email')?.children
      .map((option) => option.value)).toEqual(['notification', 'mcp']);
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

    const v = route.getRecipe().variables!.crm as unknown as Record<string, unknown>;
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

    expect('crm' in route.getRecipe().variables!).toBe(false);
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

  describe('D-315 §5.2 — a mail template setting and the template it brings', () => {
    const starter: MailTemplateDefinition = {
      name: 'Shop parcels',
      type: 'shipment',
      entrance: { conditions: [{ field: 'from', op: 'is', value: 'ship@shop.example' }], variables: ['tracking_number'] },
      rules: [{ target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'Tracking number:' } }],
      html: false,
      ai: { enabled: false },
    };
    const mine = (over: Partial<MailTemplate> = {}): MailTemplate => ({
      ...starter,
      template_id: 'mtpl_mine',
      origin: { kind: 'owner' },
      active: true,
      revision: 1,
      health: { matched: 0, entered: 0, not_entered: 0 },
      created_at: 1,
      updated_at: 1,
      ...over,
    });
    const withSetting = (hint: Record<string, unknown>): RecipeDefinition => {
      const recipe = opRecipe({ id: 'x', transform: 'coalesce', values: ['{{config.template}}'] });
      recipe.variables = { template: hint as never };
      return recipe;
    };
    const flush = async (): Promise<void> => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

    it('says what the setting brings, and keeps it out of the raw inputs', () => {
      const { root } = mount({ initialRecipe: withSetting({ label: 'Template', type: 'mail_template', starter }) });
      const row = findByAttrValue(root, RECIPE_EDITOR_MAIL_TEMPLATE_ROW_ATTR, 'template')!;
      expect(textOf(row)).toContain('Brings “Shop parcels”, a shipment template.');
      expect(findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'variables.template')).toBeUndefined();
      const none = mount({ initialRecipe: withSetting({ label: 'Template', type: 'mail_template' }) });
      expect(textOf(findByAttrValue(none.root, RECIPE_EDITOR_MAIL_TEMPLATE_ROW_ATTR, 'template')!))
        .toContain('Brings no template: whoever installs it picks one of theirs.');
    });

    it('brings one of the author’s templates, as their server copies it', async () => {
      const mailTemplateStarterCaller = vi.fn(async () => ({ starter }));
      const { root, route } = mount({
        initialRecipe: withSetting({ label: 'Template', type: 'mail_template' }),
        mailTemplatesCaller: async () => ({ templates: [mine()] }),
        mailTemplateStarterCaller,
      });
      await flush();
      setValue(findByAttrValue(root, RECIPE_EDITOR_MAIL_TEMPLATE_SOURCE_ATTR, 'template'), 'mtpl_mine');
      findByAttrValue(root, RECIPE_EDITOR_MAIL_TEMPLATE_COPY_ATTR, 'template')!.click();
      await flush();
      expect(mailTemplateStarterCaller).toHaveBeenCalledWith({ template_id: 'mtpl_mine' });
      expect(route.getRecipe().variables!.template).toMatchObject({ type: 'mail_template', starter });
    });

    it('finds the template a starter came from, and says when it changed since the copy', async () => {
      const changed = mine({ rules: [{ target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'Parcel:' } }] });
      const { root } = mount({
        initialRecipe: withSetting({ label: 'Template', type: 'mail_template', starter }),
        mailTemplatesCaller: async () => ({ templates: [changed] }),
        mailTemplateStarterCaller: async () => ({ starter }),
      });
      await flush();
      expect(textOf(findByAttrValue(root, RECIPE_EDITOR_MAIL_TEMPLATE_COPY_ATTR, 'template')!)).toBe('Update from my template');
      expect(textOf(findByAttrValue(root, RECIPE_EDITOR_MAIL_TEMPLATE_ROW_ATTR, 'template')!))
        .toContain('“Shop parcels” changed since this copy. Update from it to bring the change.');
    });

    it('⛔ shows, where the setting is, why the author’s server refused a copy', async () => {
      const refusal = Object.assign(new Error('refused'), { details: { problems: ['rules[0].find.label: holds an email address'] } });
      const { root, route } = mount({
        initialRecipe: withSetting({ label: 'Template', type: 'mail_template' }),
        mailTemplatesCaller: async () => ({ templates: [mine()] }),
        mailTemplateStarterCaller: async () => { throw refusal; },
      });
      await flush();
      setValue(findByAttrValue(root, RECIPE_EDITOR_MAIL_TEMPLATE_SOURCE_ATTR, 'template'), 'mtpl_mine');
      findByAttrValue(root, RECIPE_EDITOR_MAIL_TEMPLATE_COPY_ATTR, 'template')!.click();
      await flush();
      expect(textOf(findByAttrValue(root, RECIPE_EDITOR_MAIL_TEMPLATE_ROW_ATTR, 'template')!))
        .toContain('rules[0].find.label: holds an email address');
      expect(route.getRecipe().variables!.template).not.toHaveProperty('starter');
    });

    it('narrows a mail-fact trigger to the template a setting holds, and back to any', () => {
      const recipe = withSetting({ label: 'Parcels template', type: 'mail_template', starter });
      recipe.event_triggers = [{ on: 'mail_fact.shipment' }];
      const { root, route } = mount({ initialRecipe: recipe });
      const readBy = findByAttrValue(root, RECIPE_EDITOR_FIELD_ATTR, 'event_trigger_fact_template:0');
      expect(readBy).toBeDefined();
      setValue(readBy, 'template');
      expect(route.getRecipe().event_triggers?.[0]).toEqual({ on: 'mail_fact.shipment', template_variable: 'template' });
      setValue(readBy, '');
      expect(route.getRecipe().event_triggers?.[0]).toEqual({ on: 'mail_fact.shipment' });
    });

    it('shows only where it can matter, and adds a template setting', () => {
      const plain = mount({ mailTemplatesCaller: async () => ({ templates: [] }) });
      expect(findByAttr(plain.root, RECIPE_EDITOR_MAIL_TEMPLATE_ADD_ATTR)).toBeUndefined();
      const recipe = opRecipe({ id: 'x', transform: 'coalesce', values: ['{{context.event.payload.record_id}}'] });
      recipe.event_triggers = [{ on: 'mail_fact.shipment' }];
      const { root, route } = mount({ initialRecipe: recipe, mailTemplatesCaller: async () => ({ templates: [] }) });
      setValue(findByAttr(root, RECIPE_EDITOR_MAIL_TEMPLATE_NAME_ATTR), 'parcels');
      findByAttr(root, RECIPE_EDITOR_MAIL_TEMPLATE_ADD_ATTR)!.click();
      expect(route.getRecipe().variables!.parcels).toEqual({ label: 'Mail template', type: 'mail_template' });
    });
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
      'Your own event pattern',
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

  // ──────────────────────────────────────────────────────────────
  // D-315 §5.1 — "A mail fact"
  // ──────────────────────────────────────────────────────────────

  const fact = (root: FakeElement, part: string) => findByAttrValue(root, RECIPE_EDITOR_TRIGGER_FACT_ATTR, part);
  const setChecked = (box: FakeElement | undefined, checked: boolean): void => {
    if (box === undefined) throw new Error('missing checkbox');
    box.checked = checked;
    box.dispatch('change');
  };

  it('adds a mail fact trigger on any kind, and narrows it as the recipe declares it', () => {
    const { doc, root, route } = mount();

    setValue(findByAttr(root, RECIPE_EDITOR_TRIGGER_ADD_KIND_ATTR), 'A mail fact');
    const add = findByAttr(root, RECIPE_EDITOR_TRIGGER_ADD_ATTR)!;
    add.focus();
    add.click();
    expect(route.getRecipe().event_triggers).toEqual([{ on: 'mail_fact' }]);
    expect(textOf(findByAttrValue(root, RECIPE_EDITOR_TRIGGER_ROW_ATTR, '0')!)).toContain('A mail fact');
    expect(doc.activeElement).toBe(fact(root, '0:type'));
    expect(fact(root, '0:type')?.value).toBe('');

    setValue(fact(root, '0:field-add'), 'notice');
    setValue(fact(root, '0:field-add'), 'issuer');
    // In the order they were chosen; one chosen is not offered again.
    expect(route.getRecipe().event_triggers).toEqual([{ on: 'mail_fact', fields: ['notice', 'issuer'] }]);
    expect(textOf(fact(root, '0:field-add')!)).not.toContain('Notice —');
    expect(textOf(findByAttrValue(root, RECIPE_EDITOR_TRIGGER_ROW_ATTR, '0')!)).toContain('Issuer — bill, statement, payslip or tax form');
    setChecked(fact(root, '0:field:issuer'), false);
    expect(route.getRecipe().event_triggers).toEqual([{ on: 'mail_fact', fields: ['notice'] }]);

    const where = fact(root, '0:where')!;
    where.focus();
    setValue(where, 'notice');
    // A closed kind starts at its first value — of the kinds that have it —
    // and focus survives the repaint.
    expect(route.getRecipe().event_triggers).toEqual([
      { on: 'mail_fact', fields: ['notice'], where: { notice: 'changed' } },
    ]);
    expect(doc.activeElement).toBe(fact(root, '0:where'));
    setValue(fact(root, '0:where'), 'state');
    setValue(fact(root, '0:value'), 'overdue');
    expect(route.getRecipe().event_triggers).toEqual([
      { on: 'mail_fact', fields: ['notice'], where: { state: 'overdue' } },
    ]);
    expect(fact(root, '0:problems')?.textContent).toBe('');
    expect(fact(root, '0:notes')?.textContent).toBe('');
    expect(route.hasUnsavedChanges()).toBe(true);

    setValue(fact(root, '0:where'), '');
    expect(route.getRecipe().event_triggers).toEqual([{ on: 'mail_fact', fields: ['notice'] }]);
    expect(fact(root, '0:value')).toBeUndefined();
  });

  it('writes a typed value as the fact stores it, and names one that could never match', () => {
    const recipe = opRecipe({ id: 'q', op: 'core.test.read', args: {} });
    recipe.event_triggers = [{ on: 'mail_fact' }];
    const { root, route } = mount({ initialRecipe: recipe });

    setValue(fact(root, '0:where'), 'tracking_number');
    expect(route.getRecipe().event_triggers).toEqual([{ on: 'mail_fact', where: { tracking_number: '' } }]);
    expect(fact(root, '0:problems')?.textContent).toContain('must not be empty');

    setValue(fact(root, '0:value'), ' 1Z 999 AA1 ');
    expect(route.getRecipe().event_triggers).toEqual([{ on: 'mail_fact', where: { tracking_number: '1Z999AA1' } }]);
    expect(fact(root, '0:problems')?.textContent).toBe('');

    setValue(fact(root, '0:where'), 'complete');
    expect(route.getRecipe().event_triggers).toEqual([{ on: 'mail_fact', where: { complete: true } }]);
    setValue(fact(root, '0:value'), 'false');
    expect(route.getRecipe().event_triggers).toEqual([{ on: 'mail_fact', where: { complete: false } }]);
  });

  it('writes an id as a fact stores it, without the # or the stop around it', () => {
    const recipe = opRecipe({ id: 'q', op: 'core.test.read', args: {} });
    recipe.event_triggers = [{ on: 'mail_fact' }];
    const { root, route } = mount({ initialRecipe: recipe });
    setValue(fact(root, '0:where'), 'order_id');
    setValue(fact(root, '0:value'), '#112-3345.');
    expect(route.getRecipe().event_triggers).toEqual([{ on: 'mail_fact', where: { order_id: '112-3345' } }]);
    expect(fact(root, '0:problems')?.textContent).toBe('');
    // A date is asked for as one.
    setValue(fact(root, '0:type'), 'shipment');
    setValue(fact(root, '0:where'), 'expected_at');
    expect(fact(root, '0:value')?.type).toBe('date');
  });

  it('calls a kind of email missing only once this server’s kinds are read', async () => {
    const recipe = opRecipe({ id: 'q', op: 'core.test.read', args: {} });
    recipe.event_triggers = [{ on: 'mail_fact.custom_wine_club_box' }];
    let fail: (error: Error) => void = () => {};
    const reading = mount({
      initialRecipe: recipe,
      mailFactTypesCaller: () => new Promise((_resolve, reject) => { fail = reject; }),
    });
    const kind = (root: FakeElement) => textOf(fact(root, '0:type')!);
    // While they are read, it may well be one of the owner's.
    expect(kind(reading.root)).toContain('custom_wine_club_box (reading your kinds of email…)');
    expect(kind(reading.root)).not.toContain('not on this server');
    // Nor when they could not be read.
    fail(new Error('The server did not answer'));
    await vi.waitFor(() => expect(kind(reading.root)).toContain('custom_wine_club_box (your kinds of email could not be read)'));
    expect(kind(reading.root)).not.toContain('not on this server');
    expect(reading.route.getRecipe().event_triggers).toEqual([{ on: 'mail_fact.custom_wine_club_box' }]);

    // Read, and not among them: now it is missing.
    const read = mount({ initialRecipe: recipe, mailFactTypesCaller: async () => ({ types: [] }) });
    await vi.waitFor(() => expect(kind(read.root)).toContain('custom_wine_club_box (not on this server)'));
  });

  it('adds one on a kind of email, whose values alone it offers — and a kind change drops what belonged to the old one', () => {
    const { root, route } = mount();
    setValue(findByAttr(root, RECIPE_EDITOR_TRIGGER_ADD_KIND_ATTR), 'A mail fact');
    setValue(findByAttr(root, RECIPE_EDITOR_TRIGGER_ADD_FACT_TYPE_ATTR), 'bill');
    findByAttr(root, RECIPE_EDITOR_TRIGGER_ADD_ATTR)!.click();
    expect(route.getRecipe().event_triggers).toEqual([{ on: 'mail_fact.bill' }]);
    expect(fact(root, '0:type')?.value).toBe('bill');
    expect(textOf(fact(root, '0:field-add')!)).toContain('Amount due');
    expect(textOf(fact(root, '0:field-add')!)).not.toContain('Tracking number');
    expect(textOf(fact(root, '0:field-add')!)).toContain('A new email about it, even when nothing else changed');
    setValue(fact(root, '0:field-add'), 'last_email_at');
    setValue(fact(root, '0:where'), 'notice');
    expect(route.getRecipe().event_triggers).toEqual([{ on: 'mail_fact.bill', fields: ['last_email_at'], where: { notice: 'reminder' } }]);
    expect(fact(root, '0:problems')?.textContent).toBe('');

    setValue(fact(root, '0:type'), 'shipment');
    expect(route.getRecipe().event_triggers).toEqual([{ on: 'mail_fact.shipment' }]);
    setValue(fact(root, '0:type'), '');
    expect(route.getRecipe().event_triggers).toEqual([{ on: 'mail_fact' }]);
  });

  it('keeps what it does not edit: a template and a second filter', () => {
    const recipe = opRecipe({ id: 'q', op: 'core.test.read', args: {} });
    recipe.event_triggers = [
      { on: 'mail_fact', where: { state: 'delivered', template: 'mtpl_1', carrier: 'UPS' } },
      { on: 'mail_fact', typ: 'shipment' } as never,
    ];
    const { root, route } = mount({ initialRecipe: recipe });

    expect(fact(root, '0:where')?.value).toBe('state');
    const row = textOf(findByAttrValue(root, RECIPE_EDITOR_TRIGGER_ROW_ATTR, '0')!);
    expect(row).toContain('Other filters');
    expect(row).toContain('"template":"mtpl_1"');
    expect(row).toContain('the other filters shown still apply');
    setValue(fact(root, '0:value'), 'in_transit');
    expect(route.getRecipe().event_triggers?.[0]).toEqual({
      on: 'mail_fact', where: { state: 'in_transit', template: 'mtpl_1', carrier: 'UPS' },
    });
    // A key that is no part of one is named, not ignored.
    expect(fact(root, '1:problems')?.textContent).toContain("'typ' is not part of a mail-fact trigger");
  });

  it('offers the variables of the kinds the owner made, and notes what no built-in kind has', async () => {
    const wine: MailFactTypeSpec = {
      id: 'custom_wine_club_box', name: 'Wine club box', description: '',
      variables: [{ name: 'club', kind: 'text', required: true }, { name: 'colour', kind: 'enum', required: false, values: ['red', 'white'] }],
      states: ['shipped'], notices: [], identity: [['club']],
    };
    let answer: (value: { types: readonly MailFactTypeSpec[] }) => void = () => {};
    const recipe = opRecipe({ id: 'q', op: 'core.test.read', args: {} });
    recipe.event_triggers = [{ on: 'mail_fact', fields: ['colour'] }];
    const { root, route } = mount({ initialRecipe: recipe, mailFactTypesCaller: () => new Promise((resolve) => { answer = resolve; }) });

    // A recipe may watch it before the kinds load, or on a server with none:
    // it is noted, not refused — a kind made there may have it.
    expect(fact(root, '0:problems')?.textContent).toBe('');
    expect(fact(root, '0:notes')?.textContent)
      .toBe("'fields': no built-in kind of email has a variable 'colour' — only a kind made on the owner’s server can start it");
    expect(textOf(fact(root, '0:field-add')!)).not.toContain('Club —');

    answer({ types: [wine] });
    await vi.waitFor(() => expect(textOf(fact(root, '0:field-add')!)).toContain('Club — wine club box'));
    expect(textOf(findByAttrValue(root, RECIPE_EDITOR_TRIGGER_ROW_ATTR, '0')!)).toContain('Colour — wine club box');
    setValue(fact(root, '0:where'), 'colour');
    expect(route.getRecipe().event_triggers).toEqual([{ on: 'mail_fact', fields: ['colour'], where: { colour: 'red' } }]);
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

describe('D-335 slice W4 — a draft built from a kept browser flow', () => {
  it('shows its notes above the editor, and no refine control where the shell wires none', () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    mountExecutionCaseDraftRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      draft: { draft_key: 'k', case_id: 'browser-flow:f1', request_aliased: true,
        notes: ['Step 3 (click the button “Create”) has no selector that finds it alone.'],
        recipe: { recipe_id: 'browser-flow-github-com-f1', version: 1, ttl: 0,
          metadata: { name: 'On github.com', description: '', author: 'you', supported_platforms: [] },
          variables: {}, steps: [{ id: 'tabs', op: 'core.dom.tabs', args: { target: '*://*/*' } }], output: { render: [] } } },
      validateCaller: okValidate,
      saveCaller: okSave,
    });
    const host = findByAttr(root, EXECUTION_CASE_DRAFT_HOST_ATTR)!;
    const notes = findByAttr(host, EXECUTION_CASE_DRAFT_NOTES_ATTR)!;
    expect(notes.children.map((item) => item.textContent))
      .toEqual(['Step 3 (click the button “Create”) has no selector that finds it alone.']);
    expect(host.children.indexOf(notes)).toBeLessThan(host.children.indexOf(findByAttr(host, RECIPE_EDITOR_ROUTE_ATTR)!));
    expect(findByAttr(host, EXECUTION_CASE_DRAFT_REFINE_PANEL_ATTR)).toBeFalsy();
  });
});

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
    expect(panel.getAttribute('aria-label')).toBe('Change the AI draft');
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
    expect(note(h.root).textContent).toContain('not a working Recipe');
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

describe('D-402 slice C — "Try it" for a recipe not saved yet', () => {
  const draft = (): RecipeDefinition => ({ recipe_id: 'browser-plan-shop', version: 1, ttl: 300,
    metadata: { name: 'Shop search', description: '', author: '', supported_platforms: [] }, variables: {}, prefetch_steps: [],
    steps: [{ id: 'act_1', op: 'core.dom.act', args: { target: 'https://shop.example.com/*', steps: [] } } as never], output: { render: [] } });
  /** A trial that answers when the test says. */
  const gate = () => {
    const calls: Array<{ recipe: RecipeDefinition; config?: Record<string, unknown> }> = [];
    let finish: (result: RecipeTryResult) => void = () => undefined;
    const tryCaller: RecipeTryCaller = async (args) => { calls.push(args); return new Promise((resolve) => { finish = resolve; }); };
    return { calls, tryCaller, finish: (result: RecipeTryResult) => finish(result) };
  };

  it('shows only for Kitchen\'s work in progress, and tries the recipe as the editor holds it, saying it asks in the approvals', async () => {
    expect(findByAttr(mount({ initialRecipe: draft() }).root, RECIPE_EDITOR_TRY_ATTR)).toBeUndefined();
    const g = gate();
    const { root } = mount({ initialRecipe: draft(), tryCaller: g.tryCaller });
    const button = findByAttr(root, RECIPE_EDITOR_TRY_ATTR)!;
    expect(button.textContent).toBe('Try it');
    button.click();
    await tick();
    expect(g.calls).toEqual([{ recipe: draft(), config: {} }]);
    expect(findByAttr(root, RECIPE_EDITOR_TRY_ATTR)?.textContent).toBe('Trying…');
    expect(findByAttr(root, RECIPE_EDITOR_TRIAL_STATUS_ATTR)?.textContent).toBe('Trying… answer each change in your approvals.');
    g.finish({ success: true, errors: [], run_id: 'run-1', capture: { capture_id: 'c-1', recipe_id: 'browser-plan-shop', created_at: 1,
      expires_at: 2, state: 'ready', trial: true, run_outcome: 'passed' } } as unknown as RecipeTryResult);
    await tick();
    expect(findByAttr(root, RECIPE_EDITOR_TRIAL_STATUS_ATTR)?.textContent).toBe('It worked.');
    expect(findByAttr(root, RECIPE_EDITOR_TRIAL_CAPTURE_ATTR)?.textContent)
      .toBe('Kept as this recipe\'s saved test for 10 minutes: save the recipe, then keep it under Captured runs on its page.');
  });

  it('a step that stopped names its element, with what to fix when it named several; a trial that stopped is no saved test', async () => {
    const g = gate();
    const { root } = mount({ initialRecipe: draft(), tryCaller: g.tryCaller });
    findByAttr(root, RECIPE_EDITOR_TRY_ATTR)!.click();
    await tick();
    g.finish({ success: false, run_id: 'run-2', errors: [{ code: 'DOM_SELECTOR_NOT_FOUND', source: { step_id: 'act_1' },
      message: 'Stopped at step 1 of 2: “Delete” (button) names 8 elements on the page: the button “Delete” (e1), …' }],
    capture: { capture_id: 'c-2', recipe_id: 'browser-plan-shop', created_at: 1, expires_at: 2, state: 'unavailable', trial: true,
      reason: 'The trial did not finish, so it is no saved test. Try the recipe again once it works.' } } as unknown as RecipeTryResult);
    await tick();
    expect(findByAttr(root, RECIPE_EDITOR_TRIAL_STATUS_ATTR)?.textContent).toBe('It stopped.');
    const error = findByAttr(root, RECIPE_EDITOR_TRIAL_ERROR_ATTR)!;
    expect(textOf(error)).toContain('Step act_1: Stopped at step 1 of 2: “Delete” (button) names 8 elements on the page');
    expect(textOf(error)).toContain('To fix: name this element so that only one on the page matches it, by a selector of its own.');
    expect(findByAttr(root, RECIPE_EDITOR_TRIAL_CAPTURE_ATTR)?.textContent)
      .toBe('No saved test from this run: The trial did not finish, so it is no saved test. Try the recipe again once it works.');
  });

  it('a trial held for an answer says where to answer, and that it finishes on its own', async () => {
    const g = gate();
    const { root } = mount({ initialRecipe: draft(), tryCaller: g.tryCaller });
    findByAttr(root, RECIPE_EDITOR_TRY_ATTR)!.click();
    await tick();
    g.finish({ success: false, errors: [], awaiting_approval: true, run_id: 'run-3' } as unknown as RecipeTryResult);
    await tick();
    expect(findByAttr(root, RECIPE_EDITOR_TRIAL_STATUS_ATTR)?.textContent)
      .toBe('It waits for your answer in your approvals. It finishes once you answer, and its result shows in Logs.');
  });
});


describe('D-402 slice C5 — a trial\'s own settings, and a held trial followed to its end', () => {
  afterEach(() => { settingsForms.length = 0; vi.useRealTimers(); });

  const draft = (): RecipeDefinition => ({ recipe_id: 'browser-plan-search', version: 1, ttl: 300,
    metadata: { name: 'Shop search', description: '', author: '', supported_platforms: [] },
    variables: { query: { label: 'Search for', type: 'text', default: 'Grace Hopper' }, browser: 'b-home' },
    prefetch_steps: [],
    steps: [{ id: 'act_1', op: 'core.dom.act',
      args: { target: 'https://shop.example.com/*', bridge_id: '{{config.browser}}', steps: [] } } as never],
    output: { render: [] } });
  const noSettings = (): RecipeDefinition => ({ ...draft(), variables: {},
    steps: [{ id: 'act_1', op: 'core.dom.act', args: { target: 'https://shop.example.com/*', steps: [] } } as never] });
  /** A trial that answers when the test says. */
  const gate = () => {
    const calls: Array<{ recipe: RecipeDefinition; config?: Record<string, unknown> }> = [];
    let finish: (result: RecipeTryResult) => void = () => undefined;
    const tryCaller: RecipeTryCaller = async (args) => { calls.push(args); return new Promise((resolve) => { finish = resolve; }); };
    return { calls, tryCaller, finish: (result: RecipeTryResult) => finish(result) };
  };
  /** The shared form's confirm, as the real form does it: the settings, then it closes. */
  const confirm = (config: Record<string, unknown>): void => {
    const form = settingsForms.at(-1)!;
    void form.opts.onConfirm(config, {});
    form.close();
  };
  /** The held-run follower, as the page hands it each held trial; each follow can be stopped. */
  const follower = () => {
    const follows: Array<{ held: ServerExecuteResponse; deliver: HeldRunDelivery; stopped: boolean }> = [];
    const followHeldRun = (held: ServerExecuteResponse, deliver: HeldRunDelivery): (() => void) => {
      const one = { held, deliver, stopped: false };
      follows.push(one);
      return () => { one.stopped = true; };
    };
    return { follows, followHeldRun };
  };
  const capture: RecipeRunCaptureSummary = { capture_id: 'c-1', recipe_id: 'browser-plan-search', created_at: 1, expires_at: 2,
    state: 'running', trial: true, run_outcome: 'held', run_id: 'run-1' };
  const held = (action_ref = 'act-1'): RecipeTryResult =>
    ({ recipe_id: 'browser-plan-search', success: false, errors: [], awaiting_approval: true, action_ref, run_id: 'run-1', capture }) as unknown as RecipeTryResult;
  const status = (root: FakeElement) => findByAttr(root, RECIPE_EDITOR_TRIAL_STATUS_ATTR)?.textContent;
  const captureLine = (root: FakeElement) => findByAttr(root, RECIPE_EDITOR_TRIAL_CAPTURE_ATTR)?.textContent;
  const KEPT = 'Kept as this recipe\'s saved test for 10 minutes: save the recipe, then keep it under Captured runs on its page.';
  const UNKNOWN = 'Whether this run is the recipe\'s saved test shows on its page, once you save it.';

  it('a recipe with settings asks for this trial\'s first, each where the last trial left it, else at its default', async () => {
    const g = gate();
    const browsers: BrowserVariableCallers = { list: async () => [] };
    const mailboxes: MailboxVariableCallers = { list: async () => [] };
    const { root } = mount({ initialRecipe: draft(), tryCaller: g.tryCaller, trialSettingsCallers: { browsers, mailboxes } });
    findByAttr(root, RECIPE_EDITOR_TRY_ATTR)!.click();
    await tick();
    expect(g.calls).toEqual([]);
    expect(settingsForms).toHaveLength(1);
    const { opts } = settingsForms[0]!;
    expect(opts).toMatchObject({ title: 'Try “Shop search”', confirmLabel: 'Try it', variables: draft().variables,
      currentOverlay: {}, requireSettings: true, browsers: { settings: [{ key: 'browser' }], callers: browsers } });
    expect(opts.copy).toBe('Settings for this trial only. They do not change the recipe.');
    // No setting of this recipe names a mailbox, so the form offers no mailboxes.
    expect(opts.mailboxes).toBeUndefined();
    // A second click while the form is open opens no second one.
    findByAttr(root, RECIPE_EDITOR_TRY_ATTR)!.click();
    expect(settingsForms).toHaveLength(1);
    confirm({ query: 'Ada Lovelace', browser: 'b-work' });
    await tick();
    expect(g.calls).toEqual([{ recipe: draft(), config: { query: 'Ada Lovelace', browser: 'b-work' } }]);
    g.finish({ success: true, errors: [], run_id: 'run-1' } as unknown as RecipeTryResult);
    await tick();
    expect(status(root)).toBe('It worked.');
    // The next trial starts where this one left them.
    findByAttr(root, RECIPE_EDITOR_TRY_ATTR)!.click();
    expect(settingsForms[1]!.opts.currentOverlay).toEqual({ query: 'Ada Lovelace', browser: 'b-work' });
  });

  it('closing the form tries nothing; a setting the recipe does not declare is never sent', async () => {
    const g = gate();
    const { root } = mount({ initialRecipe: draft(), tryCaller: g.tryCaller });
    findByAttr(root, RECIPE_EDITOR_TRY_ATTR)!.click();
    // Without the owner's list of browsers, the browser setting is a text box.
    expect(settingsForms[0]!.opts.browsers).toBeUndefined();
    settingsForms[0]!.close();
    await tick();
    expect(g.calls).toEqual([]);
    findByAttr(root, RECIPE_EDITOR_TRY_ATTR)!.click();
    expect(settingsForms).toHaveLength(2);
    // One kept from an earlier trial of a recipe that has since dropped it: a run would refuse it.
    confirm({ query: 'Ada Lovelace', dropped: 'x' });
    await tick();
    expect(g.calls).toEqual([{ recipe: draft(), config: { query: 'Ada Lovelace' } }]);
  });

  it('a held trial is followed: approved anywhere, its result shows here, then whether it is the saved test', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const g = gate();
    const f = follower();
    const reads: string[] = [];
    let state: RecipeRunCaptureSummary['state'] = 'running';
    const trialCapturesCaller = async ({ recipe_id }: { recipe_id: string }) => {
      reads.push(recipe_id);
      return { captures: [{ ...capture, state, ...(state === 'ready' ? { run_outcome: 'passed' as const } : {}) }] };
    };
    const { root } = mount({ initialRecipe: noSettings(), tryCaller: g.tryCaller, followHeldRun: f.followHeldRun, trialCapturesCaller });
    findByAttr(root, RECIPE_EDITOR_TRY_ATTR)!.click();
    await tick();
    const first = held();
    g.finish(first);
    await tick();
    expect(f.follows.map((one) => one.held)).toEqual([first]);
    expect(status(root)).toBe('It waits for your answer in your approvals. Its result shows here once you answer.');
    expect(captureLine(root)).toBe('Kept for its saved test as it goes, while it waits for you.');
    // Approved elsewhere: the run finishes, and its result is delivered here.
    f.follows[0]!.deliver({ recipe_id: 'browser-plan-search', success: true, errors: [], run_id: 'run-1' } as unknown as ServerExecuteResponse,
      { replaces: first });
    await tick();
    expect(status(root)).toBe('It worked.');
    expect(captureLine(root)).toBe('Checking whether this run is the recipe\'s saved test…');
    expect(findByAttr(root, RECIPE_EDITOR_TRIAL_CAPTURE_ATTR)?.getAttribute(RECIPE_EDITOR_TRIAL_CAPTURE_ATTR)).toBe('checking');
    expect(reads).toEqual(['browser-plan-search']);
    // Still being built at the first read: read again shortly.
    state = 'ready';
    await vi.advanceTimersByTimeAsync(TRIAL_CAPTURE_READ_DELAYS_MS[0]!);
    await tick();
    expect(reads).toHaveLength(2);
    expect(captureLine(root)).toBe(KEPT);
    expect(findByAttr(root, RECIPE_EDITOR_TRIAL_CAPTURE_ATTR)?.getAttribute(RECIPE_EDITOR_TRIAL_CAPTURE_ATTR)).toBe('ready');
  });

  it('held again further on, it is followed on; declined, it says so and is no saved test', async () => {
    const g = gate();
    const f = follower();
    const trialCapturesCaller = async () => ({ captures: [{ ...capture, state: 'unavailable' as const, run_outcome: 'failed' as const,
      reason: 'The trial did not finish, so it is no saved test. Try the recipe again once it works.' }] });
    const { root } = mount({ initialRecipe: noSettings(), tryCaller: g.tryCaller, followHeldRun: f.followHeldRun, trialCapturesCaller });
    findByAttr(root, RECIPE_EDITOR_TRY_ATTR)!.click();
    await tick();
    const first = held();
    g.finish(first);
    await tick();
    const again = held('act-2') as unknown as ServerExecuteResponse;
    f.follows[0]!.deliver(again, { replaces: first });
    await tick();
    expect(status(root)).toBe('It waits for your answer in your approvals. Its result shows here once you answer.');
    expect(captureLine(root)).toBe('Kept for its saved test as it goes, while it waits for you.');
    // What no longer shows here is not replaced.
    f.follows[0]!.deliver({ recipe_id: 'browser-plan-search', success: true, errors: [] } as unknown as ServerExecuteResponse,
      { replaces: first });
    await tick();
    expect(status(root)).toBe('It waits for your answer in your approvals. Its result shows here once you answer.');
    f.follows[0]!.deliver({ recipe_id: 'browser-plan-search', success: false,
      errors: [{ message: 'You declined this, so it did not go ahead.' }] } as unknown as ServerExecuteResponse, { replaces: again });
    await tick();
    expect(status(root)).toBe('It stopped.');
    expect(textOf(findByAttr(root, RECIPE_EDITOR_TRIAL_ERROR_ATTR)!)).toBe('You declined this, so it did not go ahead.');
    expect(captureLine(root))
      .toBe('No saved test from this run: The trial did not finish, so it is no saved test. Try the recipe again once it works.');
  });

  it('a saved test no longer kept says so; one that cannot be read, or is never settled, says where it will show', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ended = async (trialCapturesCaller?: (args: { recipe_id: string }) => Promise<{ captures: RecipeRunCaptureSummary[] }>) => {
      const g = gate();
      const f = follower();
      const { root } = mount({ initialRecipe: noSettings(), tryCaller: g.tryCaller, followHeldRun: f.followHeldRun,
        ...(trialCapturesCaller !== undefined ? { trialCapturesCaller } : {}) });
      findByAttr(root, RECIPE_EDITOR_TRY_ATTR)!.click();
      await tick();
      const first = held();
      g.finish(first);
      await tick();
      f.follows[0]!.deliver({ recipe_id: 'browser-plan-search', success: true, errors: [] } as unknown as ServerExecuteResponse,
        { replaces: first });
      await tick();
      return root;
    };
    expect(captureLine(await ended(async () => ({ captures: [] })))).toBe('No saved test from this run: it is no longer kept.');
    expect(captureLine(await ended(async () => { throw new Error('Recued is busy'); }))).toBe(UNKNOWN);
    expect(captureLine(await ended())).toBe(UNKNOWN);
    // Never settled: read again at each wait, then said as unknown.
    let reads = 0;
    const root = await ended(async () => { reads += 1; return { captures: [capture] }; });
    for (const wait of TRIAL_CAPTURE_READ_DELAYS_MS) {
      expect(captureLine(root)).toBe('Checking whether this run is the recipe\'s saved test…');
      await vi.advanceTimersByTimeAsync(wait);
      await tick();
    }
    expect(reads).toBe(TRIAL_CAPTURE_READ_DELAYS_MS.length + 1);
    expect(captureLine(root)).toBe(UNKNOWN);
  });

  it('a new trial stops following the last one, as leaving the editor does; a hold with no receipt is not followed', async () => {
    const g = gate();
    const f = follower();
    const { root, route } = mount({ initialRecipe: noSettings(), tryCaller: g.tryCaller, followHeldRun: f.followHeldRun });
    findByAttr(root, RECIPE_EDITOR_TRY_ATTR)!.click();
    await tick();
    g.finish(held());
    await tick();
    expect(f.follows).toHaveLength(1);
    findByAttr(root, RECIPE_EDITOR_TRY_ATTR)!.click();
    await tick();
    expect(f.follows[0]!.stopped).toBe(true);
    g.finish(held('act-2'));
    await tick();
    expect(f.follows).toHaveLength(2);
    route.dispose();
    expect(f.follows[1]!.stopped).toBe(true);

    const other = gate();
    const g2 = follower();
    const { root: root2 } = mount({ initialRecipe: noSettings(), tryCaller: other.tryCaller, followHeldRun: g2.followHeldRun });
    findByAttr(root2, RECIPE_EDITOR_TRY_ATTR)!.click();
    await tick();
    other.finish({ ...held(), action_ref: undefined } as unknown as RecipeTryResult);
    await tick();
    expect(g2.follows).toEqual([]);
    expect(status(root2)).toBe('It waits for your answer in your approvals. It finishes once you answer, and its result shows in Logs.');
  });
});
