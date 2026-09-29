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
  type PreapprovalResult,
  type PreparePreapproval,
  type RecipeDefinition,
  type ServerExecuteResponse,
  type ServerRecipeListEntry,
  type ServerSchedule,
} from '@recued/contracts';

import {
  describeMailFactTrigger,
  initialRunModalState,
  mailFactChoiceLabel,
  mailFactCreateArgs,
  mailFactVocabulary,
  mailFactWhereOptions,
  parseRunConfig,
  recipeDisplayName,
  recipeSchedules,
  plural,
  renderRunModal,
  runTargetGate,
  wireRunModal,
  RUN_MODAL_CONFIG_ATTR,
  RUN_MODAL_FACT_ATTR,
  RUN_MODAL_FACTS_ATTR,
  RUN_MODAL_REASON_ATTR,
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
  /** Deliver an event to what listens for it, as the browser would. */
  dispatch(t: string, ev: Omit<Partial<Event>, 'target'> & { target: unknown }): void;
  appendChild(c: FakeEl): FakeEl;
  removed: boolean;
  remove(): void;
}

const makeEl = (tag: string): FakeEl => {
  const listeners = new Map<string, Array<(ev: Event) => void>>();
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
    addEventListener: (t, fn) => {
      listeners.set(t, [...(listeners.get(t) ?? []), fn]);
    },
    removeEventListener: (t, fn) => {
      listeners.set(t, (listeners.get(t) ?? []).filter((listener) => listener !== fn));
    },
    dispatch: (t, ev) => {
      for (const fn of [...(listeners.get(t) ?? [])]) fn(ev as Event);
    },
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

describe('D-261 manual preparation', () => {
  it('retries the exact preparation after a lost reply and never creates or activates a schedule', async () => {
    const requests: PreparePreapproval[] = [];
    const result: PreapprovalResult = { proposal_id: 'pap_test', future_execution_ref: 'paf_test', revision: 1,
      status: 'awaiting_owner', coverage: 'complete', eligible_members: 2, uncovered_calls: 0 };
    const schedulesCreate = vi.fn(); const onPrepared = vi.fn(); const onClose = vi.fn();
    const modal = wire({ recipe: recipeEntry(), schedulesList: async () => ({ schedules: [] }), schedulesCreate,
      preapprovalPrepare: async request => { requests.push(request); if (requests.length === 1) throw new Error('Lost response'); return result; },
      onPreapprovalPrepared: onPrepared, onClose });
    modal.setRepeat(false); modal.setRunAtLocal('2030-01-02T09:30'); modal.setConfigText('{"topic":"reviewed"}');
    await modal.reviewSchedule();
    expect(modal.getState().schedule_error).toBe('Lost response');
    await modal.reviewSchedule();
    expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
    expect(requests[0]?.subject).toEqual({ kind: 'recipe', recipe_id: 'daily-brief', publisher_id: 'recued-core', config: { topic: 'reviewed' } });
    expect(requests[0]?.activation).toEqual({ kind: 'one_shot', run_at: new Date('2030-01-02T09:30').getTime(),
      time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    expect(onClose).toHaveBeenCalledTimes(1); expect(onPrepared).toHaveBeenCalledWith(result);
    expect(schedulesCreate).not.toHaveBeenCalled();
  });
  it('does not prepare a recurring or invalid-config action', async () => {
    const prepare = vi.fn(); const modal = wire({ recipe: recipeEntry(), preapprovalPrepare: prepare });
    await modal.reviewSchedule(); expect(modal.getState().schedule_error).toContain('Run once');
    modal.setRepeat(false); modal.setRunAtLocal('2030-01-02T09:30'); modal.setConfigText('[]');
    await modal.reviewSchedule(); expect(modal.getState().schedule_error).toContain('JSON object');
    expect(prepare).not.toHaveBeenCalled(); modal.destroy();
  });
});

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

  it('⛔ Run tab: a run that returned errors says why (D-312)', () => {
    // It said only "Run returned errors": a mistyped channel failed with no
    // cause on screen, and the reason sat in the Logs detail.
    const recipe = recipeEntry();
    const failed = renderRunModal(stateWith({
      result: executeResponse(false, {
        errors: [{
          code: 'BAD_INPUT',
          message: 'notification-send: "slak" is not a channel',
          source: { recipe_id: 'daily-brief', step_id: 'send', ingredient_slug: null },
          details: { account_email: 'someone@example.com' },
        }],
      }),
    }), recipe, CAPS_FULL);
    expect(failed).toContain('Run returned errors');
    expect(failed).toContain(RUN_MODAL_REASON_ATTR);
    expect(failed).toContain('notification-send: &quot;slak&quot; is not a channel (step send)');
    // An error's details can carry addresses; only its message is shown.
    expect(failed).not.toContain('someone@example.com');
    // A hold says what it is already.
    const awaiting = renderRunModal(stateWith({
      result: executeResponse(false, { awaiting_approval: true, errors: [{ message: 'held' }] }),
    }), recipe, CAPS_FULL);
    expect(awaiting).not.toContain(RUN_MODAL_REASON_ATTR);
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

  it('⛔ confirmRun blocks a required list with every box unticked (D-314)', async () => {
    // An empty weekday list reaches the time watcher as no days: the recipe
    // would never run, and nothing on screen would say why.
    const execute = vi.fn(async () => executeResponse());
    const weekdays = { label: 'Weekdays', type: 'array', options: ['@weekdays'], default: [1, 2, 3, 4, 5] };
    const handle = wire({
      recipe: recipeEntry('daily-brief', { variables: { weekdays } as never }),
      execute,
    });
    handle.setConfigText('{"weekdays":[]}');
    await handle.confirmRun();
    expect(execute).not.toHaveBeenCalled();
    expect(handle.getState().run_error).toBe('Weekdays: tick at least one.');

    handle.setConfigText('{"weekdays":[6,7]}');
    await handle.confirmRun();
    expect(execute).toHaveBeenCalledWith({ recipe_id: 'daily-brief', config: { weekdays: [6, 7] } });
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

  it.each([
    ['⛔ the wait runs out', 'timeout', /^Still running on your server\. .*in Logs\.$/],
    ['the connection drops after it was sent', 'connection_lost', /^The connection dropped while this ran.*Logs shows how it ended\.$/],
  ])('a run whose answer never came is not reported as failed: %s', async (_label, code, copy) => {
    // A run that outlived the wait finished on the server; it read as
    // "webclient rpc: method 'execute' did not respond within 30000ms".
    const execute = vi.fn(async () => {
      throw Object.assign(new Error('webclient rpc: transport detail'), { code });
    });
    const handle = wire({ recipe: recipeEntry(), execute });
    await handle.confirmRun();
    expect(handle.getState().run_error).toMatch(copy);
  });

  it('any other failure is the error it is', async () => {
    const execute = vi.fn(async () => {
      throw Object.assign(new Error('Recipe not installed'), { code: 'not_found' });
    });
    const handle = wire({ recipe: recipeEntry(), execute });
    await handle.confirmRun();
    expect(handle.getState().run_error).toBe('Recipe not installed');
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

// ── D-315 §5.1 — "A mail fact" on the Trigger tab ─────────────────

describe('run-modal: a mail fact trigger', () => {
  // On one kind of email (ruling 43), or any kind that has what it watches
  // (ruling 42): `type` ''.
  const draft = (over: Record<string, unknown> = {}) => ({
    type: '', fields: [] as string[], where_variable: '', where_value: '', template_id: '', ...over,
  });

  it('turns the picks into the shorthand the server compiles', () => {
    expect(mailFactCreateArgs(draft())).toEqual({ on: 'mail_fact' });
    expect(mailFactCreateArgs(draft({ type: 'shipment', fields: ['state', 'last_email_at'] })))
      .toEqual({ on: 'mail_fact.shipment', fields: ['state', 'last_email_at'] });
    expect(mailFactCreateArgs(draft({ type: 'nope' }))).toEqual({ error: 'Choose a kind of email.' });
    // On one kind, only its own values: a shipment has no notice.
    expect(mailFactCreateArgs(draft({ type: 'shipment', where_variable: 'notice', where_value: 'reminder' })))
      .toEqual({ error: 'Choose what the fact must say.' });
    expect(mailFactCreateArgs(draft({ fields: ['state'], where_variable: 'state', where_value: 'delivered', template_id: 'mtpl_1' })))
      .toEqual({ on: 'mail_fact', fields: ['state'], where: { state: 'delivered', template: 'mtpl_1' } });
    expect(mailFactCreateArgs(draft({ where_variable: 'complete', where_value: 'true' }))).toEqual({
      on: 'mail_fact', where: { complete: true },
    });
    expect(mailFactCreateArgs(draft({ where_variable: 'party_size', where_value: '4' })))
      .toEqual({ on: 'mail_fact', where: { party_size: 4 } });
    expect(mailFactCreateArgs(draft({ where_variable: 'state' }))).toEqual({ error: 'Say which state it must be.' });
    expect(mailFactCreateArgs(draft({ where_variable: 'complete' }))).toEqual({ error: 'Choose yes or no.' });
    // Money is no "only when": no kind can compare it.
    expect(mailFactCreateArgs(draft({ where_variable: 'total', where_value: '5' }))).toEqual({ error: 'Choose what the fact must say.' });
  });

  it('writes a typed value as the fact stores it: text collapsed, an id without spaces', () => {
    expect(mailFactCreateArgs(draft({ where_variable: 'carrier', where_value: '  Royal   Mail ' })))
      .toEqual({ on: 'mail_fact', where: { carrier: 'Royal Mail' } });
    expect(mailFactCreateArgs(draft({ where_variable: 'tracking_number', where_value: ' 1Z 999 AA1 ' })))
      .toEqual({ on: 'mail_fact', where: { tracking_number: '1Z999AA1' } });
    expect(mailFactCreateArgs(draft({ where_variable: 'carrier', where_value: '   ' })))
      .toEqual({ error: 'Say which carrier it must be.' });
    expect(mailFactCreateArgs(draft({ where_variable: 'party_size', where_value: 'four' })))
      .toEqual({ error: 'Party size must be a number.' });
  });

  it('writes a typed value canonical, as a fact stores it: a fullwidth or hidden character is the plain one (§9)', () => {
    // Typed in fullwidth (a Japanese keyboard's default), or pasted with a zero-width space.
    expect(mailFactCreateArgs(draft({ where_variable: 'merchant', where_value: '\uFF33\uFF48\uFF4F\uFF50\u3000\uFF21' })))
      .toEqual({ on: 'mail_fact', where: { merchant: 'Shop A' } });
    expect(mailFactCreateArgs(draft({ where_variable: 'tracking_number', where_value: '\uFF11Z\u200B999 AA1' })))
      .toEqual({ on: 'mail_fact', where: { tracking_number: '1Z999AA1' } });
    expect(mailFactCreateArgs(draft({ where_variable: 'party_size', where_value: '\uFF14' })))
      .toEqual({ on: 'mail_fact', where: { party_size: 4 } });
    expect(mailFactCreateArgs(draft({ where_variable: 'carrier', where_value: '\u200B\u2060' })))
      .toEqual({ error: 'Say which carrier it must be.' });
  });

  it('offers each variable once, with the kinds that have it', () => {
    const vocabulary = mailFactVocabulary();
    const label = (name: string) => mailFactChoiceLabel(vocabulary.find((choice) => choice.name === name)!);
    expect(vocabulary.filter((choice) => choice.name === 'order_id')).toHaveLength(1);
    expect(label('state')).toBe('State — every kind of email');
    expect(label('order_id')).toBe('Order id — purchase, shipment, return or refund, order received');
    expect(label('tracking_number')).toBe('Tracking number — shipment');
    // Every thing has the time of its newest email: watching it wakes on every email (ruling 44).
    expect(label('last_email_at')).toBe('A new email about it, even when nothing else changed');
    expect(mailFactWhereOptions().find((option) => option.name === 'last_email_at')).toBeUndefined();
    // On one kind, its values alone, by name.
    expect(mailFactVocabulary([], 'shipment').map((choice) => mailFactChoiceLabel(choice, [], 'shipment')))
      .toEqual(expect.arrayContaining(['Tracking number', 'State', 'A new email about it, even when nothing else changed']));
    expect(mailFactVocabulary([], 'shipment').map((choice) => choice.name)).not.toContain('notice');
    // One "only when" per name: an enum's values from every kind that has it.
    const kind = mailFactWhereOptions().find((option) => option.name === 'kind');
    expect(kind?.kind).toBe('enum');
    expect(kind?.values).toEqual(expect.arrayContaining(['lodging', 'payslip']));
    expect(mailFactWhereOptions().find((option) => option.name === 'total')).toBeUndefined();
  });

  it('says a trigger on every email in words', () => {
    expect(describeMailFactTrigger({ pattern: 'data.mail_fact.shipment.thing.*', fields: ['last_email_at'] }, null))
      .toBe('a shipment read from mail, on every new email about it');
    expect(describeMailFactTrigger({ pattern: 'data.mail_fact.shipment.thing.*', fields: ['state', 'last_email_at'] }, null))
      .toBe('a shipment read from mail, when state changes or a new email arrives');
  });

  it('says a fact trigger in words, and nothing for another trigger', () => {
    const row = {
      pattern: 'data.mail_fact.*.thing.*',
      fields: ['state'],
      filter: { 'record.state': 'delivered', 'record.template': 'mtpl_1' },
    };
    expect(describeMailFactTrigger(row, [{ template_id: 'mtpl_1', name: 'UPS notices', type: 'shipment' }]))
      .toBe('a fact read from mail, when state changes, only when state is delivered, read by “UPS notices”');
    expect(describeMailFactTrigger({ pattern: 'data.mail_fact.*.thing.*' }, null)).toBe('a fact read from mail, on every change');
    expect(describeMailFactTrigger({ pattern: 'data.mail.**' }, null)).toBeNull();
    // A trigger on one kind of email fires for that kind alone, and says so.
    expect(describeMailFactTrigger({ pattern: 'data.mail_fact.order_received.thing.*' }, null))
      .toBe('an order received read from mail, on every change');
    // A template that is off, or gone, is said: the trigger waits on it.
    const narrowed = { pattern: 'data.mail_fact.*.thing.*', filter: { 'record.template': 'mtpl_1' } };
    expect(describeMailFactTrigger(narrowed, [{ template_id: 'mtpl_1', name: 'UPS notices', type: 'shipment', active: false }]))
      .toBe('a fact read from mail, on every change, read by “UPS notices”, which is off');
    expect(describeMailFactTrigger(narrowed, [])).toBe('a fact read from mail, on every change, read by a template that was deleted');
    expect(describeMailFactTrigger(narrowed, null)).toBe('a fact read from mail, on every change, read by one template');
    // What the owner wrote is shown as written; only an enum value is a name.
    expect(describeMailFactTrigger({
      pattern: 'data.mail_fact.*.thing.*',
      filter: { 'record.carrier': 'UPS', 'record.complete': false },
    }, null)).toBe('a fact read from mail, on every change, only when carrier is “UPS”, only when a value is missing');
  });

  it('renders the form: any kind, what it watches, one more to watch, the “only when” and its value', () => {
    const html = renderRunModal(
      stateWith({ tab: 'trigger', triggers: [], trigger_kind: 'mail_fact', mail_fact: draft({ fields: ['state'], where_variable: 'state' }) }),
      recipeEntry(),
      CAPS_FULL,
    );
    expect(html).toContain('A mail fact');
    expect(html).toMatch(/data-recued-run-modal-fact="type"[\s\S]*?<option value="" selected>Any kind that has what it watches<\/option>/);
    expect(html).toContain('It starts for a fact of any kind of email that has what it watches');
    expect(html).toMatch(/data-recued-run-modal-fact="field:state" id="run-modal-fact-field-state" checked \/>\s*State — every kind of email<\/label>/);
    expect(html).toMatch(/data-recued-run-modal-fact="field-add"[\s\S]*?<option value="tracking_number">Tracking number — shipment<\/option>/);
    // What it already watches is not offered again.
    expect(html).not.toMatch(/data-recued-run-modal-fact="field-add"[^]*?<option value="state">/);
    expect(html).toMatch(/data-recued-run-modal-fact="where-value"[\s\S]*?<option value="delivered">Delivered<\/option>/);
    // No template picker until the owner's templates are loaded.
    expect(html).not.toContain('data-recued-run-modal-fact="template"');
    // Every control has its own id: a choice repaints the form, and the focus
    // goes back to the control by it.
    const controls = [...html.matchAll(/data-recued-run-modal-fact="([^"]+)" id="([^"]+)"/g)];
    expect(controls.map(([, control]) => control)).toEqual(['type', 'field:state', 'field-add', 'where-variable', 'where-value']);
    expect(new Set(controls.map(([, , id]) => id)).size).toBe(controls.length);
    expect(html.match(/data-recued-run-modal-fact="/g)).toHaveLength(controls.length);
  });

  it('renders one kind: its own values, by name, and every new email about it', () => {
    const html = renderRunModal(
      stateWith({ tab: 'trigger', triggers: [], trigger_kind: 'mail_fact', mail_fact: draft({ type: 'shipment' }) }),
      recipeEntry(),
      CAPS_FULL,
    );
    expect(html).toMatch(/data-recued-run-modal-fact="type"[\s\S]*?<option value="shipment" selected>Shipment<\/option>/);
    // By name alone, in the values to watch as in "only when".
    expect(html).toMatch(/data-recued-run-modal-fact="field-add"[\s\S]*?<option value="tracking_number">Tracking number<\/option>/);
    expect(html).toMatch(/data-recued-run-modal-fact="where-variable"[\s\S]*?<option value="tracking_number">Tracking number<\/option>/);
    expect(html).not.toContain('— shipment');
    expect(html).toContain('<option value="last_email_at">A new email about it, even when nothing else changed</option>');
    expect(html).not.toContain('<option value="notice">');
  });

  it('adds a trigger from the form, with the config buffer, and lists it in words', async () => {
    const create = vi.fn(async () => ({ trigger: triggerRow('t9') }));
    const list = vi.fn(async () => ({
      triggers: [{ ...triggerRow('t9'), pattern: 'data.mail_fact.*.thing.*', fields: ['state'], filter: { 'record.state': 'delivered' } }],
    }));
    const handle = wire({
      recipe: recipeEntry('daily-brief', { variables: { topic: 'news' } }),
      triggersList: list,
      triggersCreate: create,
      mailFactTemplates: async () => ({ templates: [{ template_id: 'mtpl_1', name: 'UPS notices', type: 'shipment' }] }),
      initialTab: 'trigger',
    });
    handle.setTriggerKind('mail_fact');
    handle.setMailFact({ fields: ['state'], where_variable: 'state', where_value: 'delivered', template_id: 'mtpl_1' });
    handle.setConfigText('{"topic":"parcels"}');
    await handle.addTrigger();
    expect(create).toHaveBeenCalledWith({
      recipe_id: 'daily-brief',
      publisher_id: 'recued-core',
      on: 'mail_fact',
      fields: ['state'],
      where: { state: 'delivered', template: 'mtpl_1' },
      config_overlay: { topic: 'parcels' },
    });
    await vi.waitFor(() => expect(handle.getState().mail_fact_templates).not.toBeNull());
    expect(handle.getState().trigger_error).toBeNull();
    // Every template is offered, with the kind it reads.
    expect(renderRunModal(handle.getState(), recipeEntry(), CAPS_FULL)).toMatch(/<option value="mtpl_1"( selected)?>UPS notices \(shipment\)<\/option>/);
  });

  it('says why before sending when a value is missing', async () => {
    const create = vi.fn();
    const handle = wire({ recipe: recipeEntry(), triggersList: async () => ({ triggers: [] }), triggersCreate: create, initialTab: 'trigger' });
    handle.setTriggerKind('mail_fact');
    handle.setMailFact({ where_variable: 'state' });
    await handle.addTrigger();
    expect(create).not.toHaveBeenCalled();
    expect(handle.getState().trigger_error).toBe('Say which state it must be.');
  });

  /** A control of the form, as the browser hands it to the listener. */
  const control = (name: string, value: string): FakeEl => {
    const el = makeEl('select');
    el.setAttribute(RUN_MODAL_FACT_ATTR, name);
    return Object.assign(el, { value });
  };

  it('starts over when the kind of email changes: what it watched and filtered was that kind’s (ruling 43)', async () => {
    const handle = wire({ recipe: recipeEntry(), triggersList: async () => ({ triggers: [] }), initialTab: 'trigger' });
    // The form is drawn once the triggers are listed.
    await vi.waitFor(() => expect(handle.getState().triggers).toEqual([]));
    handle.setTriggerKind('mail_fact');
    handle.setMailFact({ fields: ['state'], where_variable: 'state', where_value: 'delivered', template_id: 'mtpl_1' });
    const overlay = handle.element as unknown as FakeEl;
    // The kind it has, chosen again, keeps everything.
    overlay.dispatch('change', { target: control('type', '') });
    expect(handle.getState().mail_fact).toEqual(draft({ fields: ['state'], where_variable: 'state', where_value: 'delivered', template_id: 'mtpl_1' }));
    overlay.dispatch('change', { target: control('type', 'shipment') });
    expect(handle.getState().mail_fact).toEqual(draft({ type: 'shipment' }));

    // A typed value is kept as it is typed, with no repaint to take the next click.
    handle.setMailFact({ where_variable: 'tracking_number' });
    const painted = overlay.innerHTML;
    expect(painted).toContain(`${RUN_MODAL_FACT_ATTR}="where-value"`);
    overlay.dispatch('input', { target: control('where-value', '1Z 999') });
    overlay.dispatch('change', { target: control('where-value', '1Z 999') });
    expect(handle.getState().mail_fact.where_value).toBe('1Z 999');
    expect(overlay.innerHTML).toBe(painted);
  });

  it('asks for a date as a date, and offers no date-time to filter on', () => {
    const at = (where_variable: string) => renderRunModal(
      stateWith({ tab: 'trigger', triggers: [], trigger_kind: 'mail_fact', mail_fact: draft({ type: 'shipment', where_variable }) }),
      recipeEntry(),
      CAPS_FULL,
    );
    const html = at('expected_at');
    expect(html).toMatch(/<input type="date" class="run-modal-select" data-recued-run-modal-fact="where-value"/);
    const onlyWhen = /data-recued-run-modal-fact="where-variable"[\s\S]*?<\/select>/.exec(html)![0];
    expect(onlyWhen).toContain('<option value="expected_at" selected>Expected at</option>');
    // A fact stores a date-time to the second with its zone: no value typed
    // here could meet one. It can still be watched.
    expect(onlyWhen).not.toContain('delivered_at');
    expect(html).toMatch(/data-recued-run-modal-fact="field-add"[\s\S]*?<option value="delivered_at">Delivered at<\/option>/);
    expect(mailFactWhereOptions().some((option) => option.kind === 'datetime')).toBe(false);
    // Anything else is typed as text.
    expect(at('tracking_number')).toMatch(/<input type="text" class="run-modal-select" data-recued-run-modal-fact="where-value"/);
  });

  it('keeps the templates unknown when they could not be read, and asks again', async () => {
    const wineBox = {
      id: 'custom_wine_club_box' as const, name: 'Wine club box', description: '',
      variables: [{ name: 'club', kind: 'text' as const, required: true }],
      states: ['shipped'], notices: [], identity: [],
    };
    const mailFactTemplates = vi.fn()
      .mockRejectedValueOnce(new Error('The server did not answer'))
      .mockResolvedValue({ templates: [{ template_id: 'mtpl_1', name: 'UPS notices', type: 'shipment' }] });
    const mailFactTypes = vi.fn()
      .mockResolvedValueOnce({ types: [wineBox] })
      .mockRejectedValue(new Error('The server did not answer'));
    const handle = wire({
      recipe: recipeEntry(),
      triggersList: async () => ({
        triggers: [{ ...triggerRow('t8'), pattern: 'data.mail_fact.*.thing.*', filter: { 'record.template': 'mtpl_1' } }],
      }),
      mailFactTemplates,
      mailFactTypes,
      initialTab: 'trigger',
    });
    await vi.waitFor(() => expect(handle.getState().triggers).toHaveLength(1));
    await vi.waitFor(() => expect(handle.getState().mail_fact_types).toEqual([wineBox]));
    // Not an empty list: a trigger narrowed to one is not said to wait on a deleted one.
    expect(handle.getState().mail_fact_templates).toBeNull();
    let html = renderRunModal(handle.getState(), recipeEntry(), CAPS_FULL);
    expect(html).toContain('read by one template');
    expect(html).not.toContain('a template that was deleted');

    handle.setTriggerKind('mail_fact');
    await vi.waitFor(() => expect(handle.getState().mail_fact_templates).toHaveLength(1));
    // The kinds already known stay when their list fails.
    expect(handle.getState().mail_fact_types).toEqual([wineBox]);
    html = renderRunModal(handle.getState(), recipeEntry(), CAPS_FULL);
    expect(html).toContain('read by “UPS notices”');
  });
});

describe('run-modal: a kind of email the owner made (D-315 §4.5)', () => {
  const wine = {
    id: 'custom_wine_club_box' as const,
    name: 'Wine club box',
    description: '',
    variables: [
      { name: 'club', kind: 'text' as const, required: true },
      { name: 'colour', kind: 'enum' as const, required: false, values: ['red', 'white'] },
    ],
    states: ['shipped', 'delivered'],
    notices: [],
    identity: [],
  };

  it('adds its variables to the choices, labelled with it; a trigger is on any kind that has them, or on it alone', async () => {
    const create = vi.fn(async () => ({ trigger: triggerRow('t9') }));
    const handle = wire({
      recipe: recipeEntry(),
      triggersList: async () => ({ triggers: [{ ...triggerRow('t8'), pattern: 'data.mail_fact.custom_wine_club_box.thing.*' }] }),
      triggersCreate: create,
      mailFactTemplates: async () => ({ templates: [] }),
      mailFactTypes: async () => ({ types: [wine] }),
      initialTab: 'trigger',
    });
    handle.setTriggerKind('mail_fact');
    await vi.waitFor(() => expect(handle.getState().mail_fact_types).toEqual([wine]));
    handle.setMailFact({ where_variable: 'state' });
    const html = renderRunModal(handle.getState(), recipeEntry(), CAPS_FULL);
    expect(html).toContain('<option value="colour">Colour — wine club box</option>');
    expect(html).toContain('<option value="club">Club — wine club box</option>');
    // Its states join the state's values; every kind has a state, its own included.
    expect(html).toMatch(/data-recued-run-modal-fact="where-value"[\s\S]*?<option value="shipped">Shipped<\/option>/);
    expect(html).toContain('<option value="state" selected>State — every kind of email</option>');
    // A trigger on it says which kind it is on.
    expect(html).toContain('on a wine club box read from mail, on every change');

    handle.setMailFact({ where_variable: 'colour', where_value: 'red' });
    await handle.addTrigger();
    expect(create).toHaveBeenCalledWith({
      recipe_id: 'daily-brief', publisher_id: 'recued-core', on: 'mail_fact', where: { colour: 'red' },
    });
    // Or on that kind alone.
    handle.setMailFact({ type: 'custom_wine_club_box', where_variable: 'colour', where_value: 'white' });
    await handle.addTrigger();
    expect(create).toHaveBeenLastCalledWith({
      recipe_id: 'daily-brief', publisher_id: 'recued-core', on: 'mail_fact.custom_wine_club_box', where: { colour: 'white' },
    });
  });
});
