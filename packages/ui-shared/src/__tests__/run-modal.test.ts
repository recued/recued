/** Shared Run | Schedule modal (`run-modal/`) — model + render + wire.
 *
 *  Pins:
 *   - model: config parse guards, the design-§8 targeting gate, schedule
 *     filtering, display-name + state helpers.
 *   - render: Run tab (variable widgets + raw JSON + Run button + result/
 *     error), Schedule tab (preset picker + rows + empty/not-available),
 *     tab active state, the not-wired degradations.
 *   - wire: the imperative flow (the codebase's fake-document tests can't
 *     dispatch clicks, so they drive the handle directly, exactly like the
 *     recipes route's `confirmRun`): execute orchestration, the gate block,
 *     schedule mutations + reload, not-wired guards, Escape close, destroy.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  CRON_PRESETS,
  type EventTrigger,
  type RecipeDefinition,
  type ServerExecuteResponse,
  type ServerRecipeListEntry,
  type ServerSchedule,
} from '@recued/contracts';

import {
  initialRunModalState,
  parseRunConfig,
  recipeDisplayName,
  recipeSchedules,
  plural,
  renderRunModal,
  runTargetGate,
  wireRunModal,
  RUN_MODAL_CONFIG_ATTR,
  RUN_MODAL_FACTS_ATTR,
  RUN_MODAL_OVERLAY_ATTR,
  RUN_MODAL_PRESET_ATTR,
  type RunModalCaps,
  type RunModalState,
} from '../run-modal/index.js';

// ── fixtures ──────────────────────────────────────────────────────

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
  defOverrides: Partial<RecipeDefinition> = {},
): ServerRecipeListEntry => ({
  recipe_id,
  publisher_id: 'recued-core',
  version: 1,
  recipe_hash: `hash-${recipe_id}`,
  recipe: recipeDefinition(recipe_id, defOverrides),
  source: 'pair-sync',
  installed_at: 1_700_000_000_000,
});

/** A recipe that needs a `context.entity_id` (a step references it). */
const targetedEntry = (): ServerRecipeListEntry =>
  recipeEntry('detect-risk', {
    steps: [
      {
        id: 'read',
        transform: 'pick',
        input: '{{context.entity_id}}',
        fields: ['x'],
      },
    ] as unknown as RecipeDefinition['steps'],
  });

const executeResponse = (
  success = true,
  overrides: Partial<ServerExecuteResponse> = {},
): ServerExecuteResponse => ({
  recipe_id: 'daily-brief',
  recipe_hash: 'hash-daily-brief',
  success,
  output: { render: [], sidebar: [] },
  steps: [{ id: 's1', type: 'test', skipped: false, duration_ms: 3, error: null }],
  errors: [],
  duration_ms: 7,
  ...overrides,
});

const scheduleRow = (
  schedule_id: string,
  recipe_id = 'daily-brief',
  enabled = true,
): ServerSchedule => ({
  schedule_id,
  recipe_id,
  publisher_id: 'recued-core',
  cron_expression: '0 9 * * *',
  enabled,
  created_at: 1_700_000_000_000,
  last_run_at: null,
  next_run_at: null,
  last_status: null,
  last_error: null,
});

const triggerRow = (
  trigger_id: string,
  recipe_id = 'daily-brief',
  enabled = true,
): EventTrigger => ({
  trigger_id,
  recipe_id,
  publisher_id: 'recued-core',
  pattern: 'data.mail.**',
  enabled,
  created_at: 1_700_000_000_000,
  last_fired_at: null,
  last_error: null,
  origin: 'user',
});

const CAPS_FULL: RunModalCaps = { canExecute: true, canSchedule: true, canTrigger: true };

const stateWith = (over: Partial<RunModalState> = {}): RunModalState => ({
  ...initialRunModalState('run', CRON_PRESETS[0]?.expression ?? '0 9 * * *'),
  ...over,
});

// ── a minimal fake document (no jsdom in this repo) ───────────────

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  innerHTML: string;
  attrs: Map<string, string>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  addEventListener(t: string, fn: (ev: Event) => void): void;
  removeEventListener(t: string, fn: (ev: Event) => void): void;
  appendChild(c: FakeEl): FakeEl;
  removed: boolean;
  remove(): void;
}

const makeEl = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    innerHTML: '',
    attrs: new Map(),
    removed: false,
    setAttribute: (k, v) => el.attrs.set(k, v),
    getAttribute: (k) => el.attrs.get(k) ?? null,
    hasAttribute: (k) => el.attrs.has(k),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    appendChild: (c) => c,
    remove: () => {
      el.removed = true;
    },
  };
  return el;
};

interface FakeDoc {
  styles: FakeEl[];
  head: { querySelector(sel: string): FakeEl | null; appendChild(el: FakeEl): FakeEl };
  createElement(tag: string): FakeEl;
  addEventListener(t: string, fn: (ev: Event) => void): void;
  removeEventListener(t: string, fn: (ev: Event) => void): void;
  fireKeydown(key: string, isComposing?: boolean): void;
}

const makeDoc = (): FakeDoc => {
  const styles: FakeEl[] = [];
  const keydownListeners: Array<(ev: Event) => void> = [];
  return {
    styles,
    head: {
      querySelector(sel) {
        const m = sel.match(/^style\[([\w-]+)\]$/);
        const attr = m?.[1];
        if (attr === undefined) return null;
        return styles.find((s) => s.attrs.has(attr)) ?? null;
      },
      appendChild(el) {
        styles.push(el);
        return el;
      },
    },
    createElement: (tag) => makeEl(tag),
    addEventListener: (t, fn) => {
      if (t === 'keydown') keydownListeners.push(fn);
    },
    removeEventListener: (t, fn) => {
      if (t !== 'keydown') return;
      const i = keydownListeners.indexOf(fn);
      if (i >= 0) keydownListeners.splice(i, 1);
    },
    fireKeydown(key, isComposing = false) {
      for (const fn of [...keydownListeners]) {
        fn({ key, isComposing } as unknown as Event);
      }
    },
  };
};

const wire = (opts: Parameters<typeof wireRunModal>[0]) =>
  wireRunModal({ document: makeDoc() as unknown as Document, ...opts });

// ── model ─────────────────────────────────────────────────────────

describe('run-modal model', () => {
  it('parseRunConfig: empty → {}, object passes, invalid + non-object throw', () => {
    expect(parseRunConfig('')).toEqual({});
    expect(parseRunConfig('   ')).toEqual({});
    expect(parseRunConfig('{"a":1}')).toEqual({ a: 1 });
    expect(() => parseRunConfig('{not json')).toThrow();
    expect(() => parseRunConfig('[1,2]')).toThrow(/JSON object/);
    expect(() => parseRunConfig('42')).toThrow(/JSON object/);
  });

  it('runTargetGate: non-targeted recipe is always ok', () => {
    const gate = runTargetGate(recipeEntry().recipe, '{}', {});
    expect(gate.assessment.ok).toBe(true);
    expect(gate.context).toEqual({});
  });

  it('runTargetGate: a context-targeted recipe blocks until the target is supplied', () => {
    const recipe = targetedEntry().recipe;
    const blocked = runTargetGate(recipe, '{}', {});
    expect(blocked.assessment.ok).toBe(false);
    expect(blocked.assessment.missing.some((t) => t.kind === 'context')).toBe(true);

    const ok = runTargetGate(recipe, '{}', { entity_id: '123' });
    expect(ok.assessment.ok).toBe(true);
    expect(ok.context).toEqual({ entity_id: '123' });
  });

  it('recipeSchedules filters by recipe_id', () => {
    const rows = [scheduleRow('a', 'daily-brief'), scheduleRow('b', 'other')];
    expect(recipeSchedules(rows, 'daily-brief').map((s) => s.schedule_id)).toEqual(['a']);
  });

  it('recipeDisplayName prefers metadata name, falls back to id', () => {
    expect(recipeDisplayName(recipeEntry())).toBe('Daily brief');
    const noName = recipeEntry('bare', { metadata: undefined });
    expect(recipeDisplayName(noName)).toBe('bare');
  });

  it('plural', () => {
    expect(plural(1, 'step')).toBe('1 step');
    expect(plural(2, 'step')).toBe('2 steps');
  });
});

// ── render ────────────────────────────────────────────────────────

describe('run-modal render', () => {
  it('Run tab: title, tabs, variable widget, raw-JSON field, Run button', () => {
    const recipe = recipeEntry('daily-brief', {
      variables: { topic: { label: 'Topic', type: 'text', default: 'news' } },
    });
    const html = renderRunModal(stateWith(), recipe, CAPS_FULL);
    expect(html).toContain(RUN_MODAL_OVERLAY_ATTR);
    expect(html).toContain('Daily brief');
    expect(html).toContain(RUN_MODAL_CONFIG_ATTR);
    expect(html).toContain('var-topic');
    expect(html).toContain('confirm-run');
    // Run tab active in the tablist.
    expect(html).toMatch(/data-active="true"[^>]*data-recued-run-modal-tab="run"/);
  });

  it('renders one selected tab stop linked to the active panel', () => {
    const html = renderRunModal(stateWith(), recipeEntry(), CAPS_FULL);
    expect(html).toMatch(
      /role="tab"[^>]*aria-selected="true"[^>]*tabindex="0"[^>]*data-recued-run-modal-tab="run"/,
    );
    expect(html).toMatch(
      /role="tab"[^>]*aria-selected="false"[^>]*tabindex="-1"[^>]*data-recued-run-modal-tab="schedule"/,
    );
    expect(html).toContain(
      'role="tabpanel"\n          aria-labelledby="recued-run-modal-run-tab"',
    );
  });

  it('upgrades file_ref variables to an owner-file picker only when wired', () => {
    const recipe = recipeEntry('paid-document', {
      variables: {
        template_file_ref: {
          label: 'Markdown template',
          type: 'file_ref',
          default: 'file:template-1',
        },
      },
    });
    const fallback = renderRunModal(stateWith(), recipe, CAPS_FULL);
    expect(fallback).toContain('data-var-type="file_ref"');
    expect(fallback).not.toContain('data-ref-picker="run-modal-var-file-ref-template_file_ref"');

    const picker = renderRunModal(stateWith(), recipe, {
      ...CAPS_FULL,
      canPickFiles: true,
    });
    expect(picker).toContain('data-ref-picker="run-modal-var-file-ref-template_file_ref"');
    expect(picker).toContain('role="combobox"');
    expect(picker).toContain('type="hidden" data-var-key="template_file_ref"');
  });

  it('upgrades file_ref[] variables to the ordered list only when wired', () => {
    const recipe = recipeEntry('social-post', {
      variables: {
        images: {
          label: 'Post images',
          type: 'file_ref[]',
          default: ['file:a', 'file:b'],
        },
      },
    });
    const fallback = renderRunModal(stateWith(), recipe, CAPS_FULL);
    expect(fallback).toContain('data-var-type="file_ref_array"');
    expect(fallback).toContain('value="file:a, file:b"');
    expect(fallback).not.toContain('data-recued-file-refs-list');

    const picker = renderRunModal(stateWith(), recipe, {
      ...CAPS_FULL,
      canPickFiles: true,
    });
    expect(picker).toContain('data-recued-file-refs-variable="images"');
    expect(picker).toContain('data-recued-file-refs-list="images"');
    expect(picker).toContain('data-ref-picker="run-modal-var-file-refs-images"');
    // Seeded in DECLARED order — the value is a sequence, and the modal is
    // where a wrong one would ship.
    expect(picker.indexOf('file:a')).toBeLessThan(picker.indexOf('file:b'));
  });

  it('upgrades scoped record_ref variables only when a record inventory is wired', () => {
    const recipe = recipeEntry('tag-lines', {
      variables: {
        tree: {
          label: 'Which tree',
          type: 'record_ref',
          entity: 'tag',
          entity_filter: { root_ref: 'tag/departments' },
        },
      },
    });
    const fallback = renderRunModal(stateWith(), recipe, CAPS_FULL);
    expect(fallback).toContain('data-var-type="record_ref"');
    expect(fallback).not.toContain('data-ref-picker="run-modal-var-record-ref-tree"');

    const picker = renderRunModal(stateWith(), recipe, {
      ...CAPS_FULL,
      canPickRecords: true,
    });
    expect(picker).toContain('data-ref-picker="run-modal-var-record-ref-tree"');
    expect(picker).toContain('data-recued-record-ref-entity="tag"');
    expect(picker).toContain(
      'data-recued-record-ref-filter="{&quot;root_ref&quot;:&quot;tag/departments&quot;}"',
    );
  });

  it('Run tab: result + error blocks', () => {
    const recipe = recipeEntry();
    const ran = renderRunModal(stateWith({ result: executeResponse() }), recipe, CAPS_FULL);
    expect(ran).toContain('Run completed');
    expect(ran).toContain('7 ms');
    expect(ran).toContain('1 step');
    const receipt = renderRunModal(stateWith({
      result: executeResponse(true, {
        run_facts: {
          steps_run: 34,
          items_total: 1_249,
          provider_calls: 2,
          total_tokens: 13_385,
          duration_ms: 42_000,
        },
      }),
    }), recipe, CAPS_FULL);
    expect(receipt).toContain(RUN_MODAL_FACTS_ATTR);
    expect(receipt).toContain(
      '34 steps · 1,249 items · 2 provider calls · 13,385 tokens · 42 seconds',
    );
    expect(receipt).not.toContain('7 ms');
    const failed = renderRunModal(
      stateWith({ result: executeResponse(false) }),
      recipe,
      CAPS_FULL,
    );
    expect(failed).toContain('Run returned errors');
    const awaiting = renderRunModal(
      stateWith({ result: executeResponse(false, { awaiting_approval: true }) }),
      recipe,
      CAPS_FULL,
    );
    expect(awaiting).toContain('Awaiting approval');
    expect(awaiting).not.toContain('Run returned errors');
    const terminated = renderRunModal(
      stateWith({ result: executeResponse(false, { run_terminated: 'killed' }) }),
      recipe,
      CAPS_FULL,
    );
    expect(terminated).toContain('Run terminated');
    expect(terminated).not.toContain('Run returned errors');
    const errored = renderRunModal(stateWith({ run_error: 'boom' }), recipe, CAPS_FULL);
    expect(errored).toContain('boom');
    expect(errored).toContain('role="alert"');
  });

  it('Run tab: not-wired execute degrades + disables Run', () => {
    const html = renderRunModal(stateWith(), recipeEntry(), {
      canExecute: false,
      canSchedule: true,
      canTrigger: false,
    });
    expect(html).toContain('Running is not available');
    expect(html).toMatch(/confirm-run"\s+disabled/);
  });

  it('keeps the in-flight Run control focusable but inert', () => {
    const html = renderRunModal(
      stateWith({ executing: true }),
      recipeEntry(),
      CAPS_FULL,
    );
    const button = html.match(/<button[^>]*confirm-run[^>]*>/)?.[0] ?? '';
    expect(button).toContain('aria-disabled="true"');
    expect(button).toContain('aria-busy="true"');
    expect(button).not.toMatch(/\sdisabled(?:\s|>)/);
  });

  it('keeps Close focusable but inert while any command is pending', () => {
    for (const pending of [
      { executing: true },
      { mutating: true },
      { trigger_mutating: true },
    ] satisfies Array<Partial<RunModalState>>) {
      const html = renderRunModal(stateWith(pending), recipeEntry(), CAPS_FULL);
      const button = html.match(/<button[^>]*run-modal-close[^>]*>/)?.[0] ?? '';
      expect(button).toContain('aria-disabled="true"');
      expect(button).not.toMatch(/\sdisabled(?:\s|>)/);
    }
  });

  it('Schedule tab: preset picker, rows, empty + not-available', () => {
    const recipe = recipeEntry();
    const withRows = renderRunModal(
      stateWith({ tab: 'schedule', schedules: [scheduleRow('s1')] }),
      recipe,
      CAPS_FULL,
    );
    expect(withRows).toContain(RUN_MODAL_PRESET_ATTR);
    expect(withRows).toContain('id="run-modal-repeat"');
    expect(withRows).toContain('Add schedule');
    expect(withRows).toContain('toggle-schedule:off'); // an enabled row pauses
    expect(withRows).toContain('remove-schedule');
    expect(withRows).toMatch(/data-active="true"[^>]*data-recued-run-modal-tab="schedule"/);

    const empty = renderRunModal(
      stateWith({ tab: 'schedule', schedules: [] }),
      recipe,
      CAPS_FULL,
    );
    expect(empty).toContain('No schedules');

    const noCaller = renderRunModal(stateWith({ tab: 'schedule' }), recipe, {
      canExecute: true,
      canSchedule: false,
      canTrigger: false,
    });
    expect(noCaller).toContain('Scheduling is not available');
  });

  it('names repeated schedule and trigger actions by stable rule identity', () => {
    const schedules = renderRunModal(
      stateWith({
        tab: 'schedule',
        schedules: [scheduleRow('s1'), scheduleRow('s2')],
      }),
      recipeEntry(),
      CAPS_FULL,
    );
    expect(schedules).toContain(
      'aria-label="Pause schedule Daily at 9:00 AM (s1)"',
    );
    expect(schedules).toContain(
      'aria-label="Pause schedule Daily at 9:00 AM (s2)"',
    );
    expect(schedules).toContain(
      'aria-label="Remove schedule Daily at 9:00 AM (s1)"',
    );
    expect(schedules).toContain(
      'aria-label="Remove schedule Daily at 9:00 AM (s2)"',
    );

    const triggers = renderRunModal(
      stateWith({
        tab: 'trigger',
        triggers: [triggerRow('t1'), triggerRow('t2')],
      }),
      recipeEntry(),
      CAPS_FULL,
    );
    expect(triggers).toContain(
      'aria-label="Pause trigger data.mail.** (t1)"',
    );
    expect(triggers).toContain(
      'aria-label="Pause trigger data.mail.** (t2)"',
    );
    expect(triggers).toContain(
      'aria-label="Remove trigger data.mail.** (t1)"',
    );
    expect(triggers).toContain(
      'aria-label="Remove trigger data.mail.** (t2)"',
    );
  });

  it('keeps Add schedule focusable but inert during a mutation', () => {
    const html = renderRunModal(
      stateWith({ tab: 'schedule', schedules: [], mutating: true }),
      recipeEntry(),
      CAPS_FULL,
    );
    const button = html.match(/<button[^>]*add-schedule[^>]*>/)?.[0] ?? '';
    expect(button).toContain('aria-disabled="true"');
    expect(button).toContain('aria-busy="true"');
    expect(button).not.toMatch(/\sdisabled(?:\s|>)/);
  });

  it('keeps schedule row actions focusable but inert during a mutation', () => {
    const html = renderRunModal(
      stateWith({
        tab: 'schedule',
        schedules: [scheduleRow('s1')],
        mutating: true,
      }),
      recipeEntry('daily-brief', { variables: { topic: 'news' } }),
      CAPS_FULL,
    );
    for (const action of [
      'config-schedule',
      'toggle-schedule:off',
      'remove-schedule',
    ]) {
      const button = html.match(
        new RegExp(`<button[^>]*${action}[^>]*>`),
      )?.[0] ?? '';
      expect(button).toContain('aria-disabled="true"');
      expect(button).toContain('aria-busy="true"');
      expect(button).not.toMatch(/\sdisabled(?:\s|>)/);
    }
  });

  it('keeps trigger actions focusable but inert during a mutation', () => {
    const html = renderRunModal(
      stateWith({
        tab: 'trigger',
        triggers: [triggerRow('t1')],
        trigger_mutating: true,
        pattern_text: 'data.mail.**',
      }),
      recipeEntry('daily-brief', { variables: { topic: 'news' } }),
      CAPS_FULL,
    );
    for (const action of [
      'add-trigger',
      'config-trigger',
      'toggle-trigger:off',
      'remove-trigger',
    ]) {
      const button = html.match(
        new RegExp(`<button[^>]*${action}[^>]*>`),
      )?.[0] ?? '';
      expect(button).toContain('aria-disabled="true"');
      expect(button).toContain('aria-busy="true"');
      expect(button).not.toMatch(/\sdisabled(?:\s|>)/);
    }
  });

  it('Schedule/Trigger tabs surface the recipe config fields (D-179)', () => {
    const recipe = recipeEntry('daily-brief', { variables: { topic: 'news' } });

    const sched = renderRunModal(
      stateWith({ tab: 'schedule', schedules: [] }),
      recipe,
      CAPS_FULL,
    );
    expect(sched).toContain('Config for every scheduled run');
    expect(sched).toContain('var-topic');

    const trig = renderRunModal(
      stateWith({ tab: 'trigger', triggers: [] }),
      recipe,
      CAPS_FULL,
    );
    expect(trig).toContain('Config for runs from this trigger');
    expect(trig).toContain('var-topic');

    // A recipe with no variables shows no config section (nothing to set).
    const noVars = renderRunModal(
      stateWith({ tab: 'schedule', schedules: [] }),
      recipeEntry(),
      CAPS_FULL,
    );
    expect(noVars).not.toContain('Config for every scheduled run');
  });

  it('D-222 keeps invoke fields labeled while configure surfaces stay total', () => {
    const recipe = recipeEntry('d-222-fields', {
      variables: {
        labeled: { label: 'Labeled input', type: 'text', default: 'shown' },
        bare_default: 'configure-only',
        required_compatibility: null,
      },
    });

    const invoke = renderRunModal(stateWith(), recipe, CAPS_FULL);
    expect(invoke).toContain('var-labeled');
    expect(invoke).toContain('var-required_compatibility');
    expect(invoke).not.toContain('var-bare_default');

    const schedule = renderRunModal(
      stateWith({ tab: 'schedule', schedules: [] }),
      recipe,
      CAPS_FULL,
    );
    expect(schedule).toContain('var-labeled');
    expect(schedule).toContain('var-required_compatibility');
    expect(schedule).toContain('var-bare_default');
  });

  it('D-222 gives primitive-only recipes an explicit raw override path', () => {
    const recipe = recipeEntry('d-222-defaults', {
      variables: { limit: 25, include_closed: false },
    });
    const html = renderRunModal(stateWith(), recipe, CAPS_FULL);
    expect(html).toContain('<summary>Run with overrides</summary>');
    expect(html).toContain(RUN_MODAL_CONFIG_ATTR);
    expect(html).not.toContain('var-limit');
    expect(html).not.toContain('var-include_closed');
    expect(html).toContain('confirm-run');
    // ...and the raw editor must not claim fields the invoke filter withheld.
    // The qualifier describes "the fields above", and there are none here: the
    // copy keyed on `varKeys` (declared) rather than on rendered rows, so a
    // primitive-only recipe pointed a reader at an empty panel.
    expect(html).not.toContain('overrides the fields above');
  });

  // The positive case that keeps the assertion above a fix and not a deletion:
  // where fields DO render, the qualifier must still be there.
  it('D-222 keeps the "fields above" qualifier where invoke fields do render', () => {
    const recipe = recipeEntry('d-222-labeled', {
      variables: { status: { label: 'Status', type: 'text', default: 'open' } },
    });
    const html = renderRunModal(stateWith(), recipe, CAPS_FULL);
    expect(html).toContain('var-status');
    expect(html).toContain('overrides the fields above');
  });

  it('shows a per-row Config button only when the recipe has variables (D-179 edit)', () => {
    const recipe = recipeEntry('daily-brief', { variables: { topic: 'news' } });

    const sched = renderRunModal(
      stateWith({ tab: 'schedule', schedules: [scheduleRow('s1')] }),
      recipe,
      CAPS_FULL,
    );
    expect(sched).toContain('config-schedule');

    const trig = renderRunModal(
      stateWith({ tab: 'trigger', triggers: [triggerRow('t1')] }),
      recipe,
      CAPS_FULL,
    );
    expect(trig).toContain('config-trigger');

    // A variable-less recipe has nothing to configure → no Config button.
    const noVars = renderRunModal(
      stateWith({ tab: 'schedule', schedules: [scheduleRow('s1')] }),
      recipeEntry(),
      CAPS_FULL,
    );
    expect(noVars).not.toContain('config-schedule');
  });

  it('hides the Schedule tab for a run-only host (no schedule caller wired)', () => {
    // The recipes route opens the modal run-only (scheduling lives in its
    // Automation modal); an unwired Schedule tab would only lead to a dead
    // "not available" panel, so it is suppressed on the Run tab.
    const html = renderRunModal(stateWith(), recipeEntry(), {
      canExecute: true,
      canSchedule: false,
      canTrigger: false,
    });
    expect(html).toContain('data-recued-run-modal-tab="run"');
    expect(html).not.toContain('data-recued-run-modal-tab="schedule"');
  });
});

// ── wire ──────────────────────────────────────────────────────────

describe('run-modal wire', () => {
  it('confirmRun executes with parsed config + paints the result', async () => {
    const execute = vi.fn(async () => executeResponse());
    const onRan = vi.fn();
    const handle = wire({ recipe: recipeEntry(), execute, onRan });
    handle.setConfigText('{"topic":"pipeline"}');
    await handle.confirmRun();

    expect(execute).toHaveBeenCalledWith({
      recipe_id: 'daily-brief',
      config: { topic: 'pipeline' },
    });
    expect(handle.getState().result?.success).toBe(true);
    expect(handle.element.innerHTML).toContain('Run completed');
    expect(onRan).toHaveBeenCalledTimes(1);
  });

  it('D-222 raw overrides still reach a bare primitive variable', async () => {
    const execute = vi.fn(async () => executeResponse());
    const handle = wire({
      recipe: recipeEntry('daily-brief', { variables: { limit: 25 } }),
      execute,
    });
    handle.setConfigText('{"limit":50}');
    await handle.confirmRun();
    expect(execute).toHaveBeenCalledWith({
      recipe_id: 'daily-brief',
      config: { limit: 50 },
    });
  });

  it('confirmRun rejects invalid config without calling execute', async () => {
    const execute = vi.fn(async () => executeResponse());
    const handle = wire({ recipe: recipeEntry(), execute });
    handle.setConfigText('{not json');
    await handle.confirmRun();
    expect(execute).not.toHaveBeenCalled();
    expect(handle.getState().run_error).not.toBeNull();
  });

  it('confirmRun blocks a missing target, then runs with context once supplied', async () => {
    const execute = vi.fn(async () => executeResponse());
    const handle = wire({ recipe: targetedEntry(), execute });
    await handle.confirmRun();
    expect(execute).not.toHaveBeenCalled();
    expect(handle.getState().run_error).not.toBeNull();

    handle.setTargetValue('entity_id', '123');
    await handle.confirmRun();
    expect(execute).toHaveBeenCalledWith({
      recipe_id: 'detect-risk',
      config: {},
      context: { entity_id: '123' },
    });
  });

  it('confirmRun with no execute caller surfaces the not-wired note', async () => {
    const handle = wire({ recipe: recipeEntry() });
    await handle.confirmRun();
    expect(handle.getState().run_error).toMatch(/not available/);
  });

  it('schedule mutations call the right callers and reload', async () => {
    const list = vi.fn(async () => ({ schedules: [scheduleRow('s1')] }));
    const create = vi.fn(async () => ({ schedule: scheduleRow('s2') }));
    const update = vi.fn(async () => ({ schedule: scheduleRow('s1', 'daily-brief', false) }));
    const del = vi.fn(async () => ({ deleted: true as const }));
    const handle = wire({
      recipe: recipeEntry(),
      schedulesList: list,
      schedulesCreate: create,
      schedulesUpdate: update,
      schedulesDelete: del,
      initialTab: 'schedule',
    });

    handle.setPreset('0 9 * * *');
    await handle.addSchedule();
    expect(create).toHaveBeenCalledWith({
      recipe_id: 'daily-brief',
      publisher_id: 'recued-core', // defaulted from the recipe entry
      cron_expression: '0 9 * * *',
    });

    await handle.toggleSchedule('s1', false);
    expect(update).toHaveBeenCalledWith({ schedule_id: 's1', enabled: false });

    await handle.removeSchedule('s1');
    expect(del).toHaveBeenCalledWith({ schedule_id: 's1' });

    // Each mutation reloads the list (initial load + 3 mutations).
    expect(list).toHaveBeenCalledTimes(4);
    expect(handle.getState().schedules).not.toBeNull();
  });

  it('addSchedule: publisherId overrides the recipe publisher', async () => {
    const create = vi.fn(async () => ({ schedule: scheduleRow('s2') }));
    const handle = wire({
      recipe: recipeEntry(), // publisher_id 'recued-core'
      schedulesList: vi.fn(async () => ({ schedules: [] })),
      schedulesCreate: create,
      publisherId: 'override-pub',
    });
    handle.setPreset('0 9 * * *');
    await handle.addSchedule();
    expect(create).toHaveBeenCalledWith({
      recipe_id: 'daily-brief',
      publisher_id: 'override-pub',
      cron_expression: '0 9 * * *',
    });
  });

  it('addSchedule/addTrigger carry config_overlay from the config buffer (D-179)', async () => {
    const recipe = recipeEntry('daily-brief', { variables: { topic: 'news' } });

    const createS = vi.fn(async () => ({ schedule: scheduleRow('s2') }));
    const sHandle = wire({
      recipe,
      schedulesList: vi.fn(async () => ({ schedules: [] })),
      schedulesCreate: createS,
      initialTab: 'schedule',
    });
    sHandle.setPreset('0 9 * * *');
    sHandle.setConfigText('{"topic":"pipeline"}');
    await sHandle.addSchedule();
    expect(createS).toHaveBeenCalledWith({
      recipe_id: 'daily-brief',
      publisher_id: 'recued-core',
      cron_expression: '0 9 * * *',
      config_overlay: { topic: 'pipeline' },
    });

    const createT = vi.fn(async () => ({ trigger: triggerRow('t2') }));
    const tHandle = wire({
      recipe,
      triggersList: vi.fn(async () => ({ triggers: [] })),
      triggersCreate: createT,
      initialTab: 'trigger',
    });
    tHandle.setPatternText('data.mail.**');
    tHandle.setConfigText('{"topic":"pipeline"}');
    await tHandle.addTrigger();
    expect(createT).toHaveBeenCalledWith({
      recipe_id: 'daily-brief',
      publisher_id: 'recued-core',
      pattern: 'data.mail.**',
      config_overlay: { topic: 'pipeline' },
    });
  });

  it('addSchedule surfaces invalid config JSON instead of silently arming (D-179)', async () => {
    const create = vi.fn(async () => ({ schedule: scheduleRow('s2') }));
    const handle = wire({
      recipe: recipeEntry('daily-brief', { variables: { topic: 'news' } }),
      schedulesList: vi.fn(async () => ({ schedules: [] })),
      schedulesCreate: create,
      initialTab: 'schedule',
    });
    handle.setPreset('0 9 * * *');
    handle.setConfigText('{not json');
    await handle.addSchedule();
    expect(create).not.toHaveBeenCalled();
    expect(handle.getState().schedule_error).not.toBeNull();
  });

  it('imperative setters repaint the visible controls', () => {
    const cfg = wire({ recipe: recipeEntry(), execute: vi.fn(async () => executeResponse()) });
    cfg.setConfigText('{"topic":"synced"}');
    // The textarea is HTML-escaped, so assert the literal (unescaped) tokens.
    expect(cfg.element.innerHTML).toContain('topic');
    expect(cfg.element.innerHTML).toContain('synced');
    expect(cfg.getState().config_text).toBe('{"topic":"synced"}');

    const tgt = wire({ recipe: targetedEntry(), execute: vi.fn(async () => executeResponse()) });
    tgt.setTargetValue('entity_id', 'deal-42');
    expect(tgt.element.innerHTML).toContain('deal-42');
  });

  it('schedule actions with no caller surface the not-wired note', async () => {
    const handle = wire({ recipe: recipeEntry() });
    await handle.addSchedule();
    expect(handle.getState().schedule_error).toMatch(/not available/);
  });

  it('Escape closes (fires onClose) and destroy is idempotent', () => {
    const onClose = vi.fn();
    const doc = makeDoc();
    const handle = wireRunModal({
      document: doc as unknown as Document,
      recipe: recipeEntry(),
      execute: vi.fn(async () => executeResponse()),
      onClose,
    });
    expect((handle.element as unknown as FakeEl).removed).toBe(false);
    doc.fireKeydown('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect((handle.element as unknown as FakeEl).removed).toBe(true);
    handle.destroy(); // idempotent — no throw, no second onClose
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves a composing Escape to the active IME', () => {
    const onClose = vi.fn();
    const doc = makeDoc();
    const handle = wireRunModal({
      document: doc as unknown as Document,
      recipe: recipeEntry(),
      execute: vi.fn(async () => executeResponse()),
      onClose,
    });
    doc.fireKeydown('Escape', true);
    expect(onClose).not.toHaveBeenCalled();
    expect((handle.element as unknown as FakeEl).removed).toBe(false);

    doc.fireKeydown('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect((handle.element as unknown as FakeEl).removed).toBe(true);
  });

  it('holds Escape dismissal until an in-flight mutation settles', async () => {
    const onClose = vi.fn();
    const doc = makeDoc();
    let finishCreate!: (value: { schedule: ServerSchedule }) => void;
    const handle = wireRunModal({
      document: doc as unknown as Document,
      recipe: recipeEntry(),
      schedulesList: vi.fn(async () => ({ schedules: [scheduleRow('s2')] })),
      schedulesCreate: vi.fn(() =>
        new Promise<{ schedule: ServerSchedule }>((resolve) => {
          finishCreate = resolve;
        })),
      initialTab: 'schedule',
      onClose,
    });

    const pending = handle.addSchedule();
    expect(handle.getState().mutating).toBe(true);
    expect(handle.hasInFlightWork()).toBe(true);
    doc.fireKeydown('Escape');
    expect(onClose).not.toHaveBeenCalled();
    expect((handle.element as unknown as FakeEl).removed).toBe(false);

    finishCreate({ schedule: scheduleRow('s2') });
    await pending;
    expect(handle.hasInFlightWork()).toBe(false);
    doc.fireKeydown('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect((handle.element as unknown as FakeEl).removed).toBe(true);
  });

  it('injects its stylesheet once per document', () => {
    const doc = makeDoc();
    wireRunModal({ document: doc as unknown as Document, recipe: recipeEntry() });
    wireRunModal({ document: doc as unknown as Document, recipe: recipeEntry() });
    expect(doc.styles.length).toBe(1);
    const styles = doc.styles[0]?.textContent ?? '';
    expect(styles).toContain(
      '.run-modal-panel {\n  box-sizing: border-box;',
    );
    expect(styles).toContain(
      '.run-modal-tab {\n  box-sizing: border-box;\n  min-height: 36px;',
    );
    expect(styles).toContain(
      '.run-modal-button {\n  box-sizing: border-box;\n  appearance: none;\n  min-width: 36px;\n  min-height: 36px;',
    );
    expect(styles).toContain(
      '.run-modal-select {\n  box-sizing: border-box;\n  max-width: 100%;\n  min-height: 36px;',
    );
    expect(styles).toContain(
      '.run-modal-actions > label.run-modal-copy {\n  box-sizing: border-box;\n  min-height: 36px;',
    );
    expect(styles).toContain(
      '.run-modal-panel .ref-picker-clear {\n  right: 0;\n  width: 36px;\n  height: 36px;',
    );
    expect(styles).toContain(
      '.run-modal-panel .var-file-refs-btn {\n  width: 36px;\n  height: 36px;',
    );
    expect(styles).toContain(
      '.run-modal-rule-row {\n  box-sizing: border-box;\n  min-width: 0;\n  max-width: 100%;',
    );
    expect(styles).toContain(
      '@media (max-width: 520px) {\n  .run-modal-header {\n    align-items: flex-start;',
    );
    expect(styles).toContain(
      'grid-template-columns: minmax(0, 1fr) auto;',
    );
    expect(styles).toContain(
      '.run-modal-close {\n  flex: 0 0 auto;\n  margin-left: auto;',
    );
    expect(styles).toContain(
      '.run-modal-rule-row {\n    align-items: stretch;\n    flex-direction: column;',
    );
  });
});
