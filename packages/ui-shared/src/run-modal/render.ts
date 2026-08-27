/** Shared Run | Schedule modal — render (state → HTML string).
 *
 *  Pure: `renderRunModal(state, recipe, caps)` returns the overlay markup.
 *  The wire layer sets it as the overlay's innerHTML and re-attaches.
 *  Markup + class names mirror the recipes-route run/automation modal so
 *  the existing CSS language carries over (the styles here re-scope the
 *  `.var-*` widget rules under the modal host).
 */

import {
  buildTargetRequiredMessage,
  CRON_PRESETS,
  describeCron,
  type ServerRecipeListEntry,
  type ServerSchedule,
} from '@recued/contracts';

import { e } from '../template.js';
import { formatRecipeRunFacts } from '../run-facts.js';
import {
  isInvocationVariable,
  renderVariableWidget,
  toWidgetShape,
} from '../variable-widgets.js';

import { parseRunConfig, plural, recipeDisplayName, runTargetGate } from './model.js';
import type { RunModalState, RunModalTab } from './types.js';

// ── Attribute namespace (own, NOT the recipes-route `RECIPES_ROUTE_*`) ──
export const RUN_MODAL_OVERLAY_ATTR = 'data-recued-run-modal';
export const RUN_MODAL_ACTION_ATTR = 'data-recued-run-modal-action';
export const RUN_MODAL_TAB_ATTR = 'data-recued-run-modal-tab';
export const RUN_MODAL_CONFIG_ATTR = 'data-recued-run-modal-config';
export const RUN_MODAL_TARGET_ATTR = 'data-recued-run-modal-target';
export const RUN_MODAL_TARGET_WARNING_ATTR = 'data-recued-run-modal-target-warning';
export const RUN_MODAL_CONTEXT_ATTR = 'data-recued-run-modal-context';
export const RUN_MODAL_IDENTITY_ATTR = 'data-recued-run-modal-identity';
export const RUN_MODAL_RESULT_ATTR = 'data-recued-run-modal-result';
export const RUN_MODAL_FACTS_ATTR = 'data-recued-run-modal-facts';
export const RUN_MODAL_PRESET_ATTR = 'data-recued-run-modal-preset';
/** D-215 slice 5 — the Repeat toggle. Off ⇒ the datetime control replaces
 *  the CRON preset picker and Add creates a ONE-SHOT. */
export const RUN_MODAL_REPEAT_ATTR = 'data-recued-run-modal-repeat';
/** D-215 slice 5 — the one-shot datetime-local input. */
export const RUN_MODAL_RUN_AT_ATTR = 'data-recued-run-modal-run-at';
export const RUN_MODAL_RULE_ID_ATTR = 'data-recued-run-modal-rule-id';
export const RUN_MODAL_SCHEDULE_ERROR_ATTR = 'data-recued-run-modal-schedule-error';
export const RUN_MODAL_PATTERN_ATTR = 'data-recued-run-modal-pattern';
export const RUN_MODAL_TRIGGER_ERROR_ATTR = 'data-recued-run-modal-trigger-error';

/** What's wired — drives the "not available" degradations. */
export interface RunModalCaps {
  canExecute: boolean;
  canSchedule: boolean;
  /** R21 — the Trigger tab (list wired; create may still be absent). */
  canTrigger: boolean;
  /** D-200 — whether `file_ref` variables can use an owner-file picker. */
  canPickFiles?: boolean;
  /** Whether `record_ref` variables can use their pack-owned inventory. */
  canPickRecords?: boolean;
}

/** Render one variable widget per `recipe.variables` key, pre-filled
 *  from the current config overrides. Returns '' when the recipe has no
 *  variables. Shared by the Run tab and the Schedule / Trigger config
 *  sections so all three stay in one visual language. */
const renderVariableRows = (
  recipe: ServerRecipeListEntry,
  config_text: string,
  caps: Pick<RunModalCaps, 'canPickFiles' | 'canPickRecords'>,
  surface: 'invoke' | 'configure',
): string => {
  const variables = recipe.recipe.variables ?? {};
  const varKeys = Object.keys(variables).filter((key) =>
    surface === 'configure' || isInvocationVariable(variables[key]!),
  );
  if (varKeys.length === 0) return '';
  let overrides: Record<string, unknown> = {};
  try {
    overrides = parseRunConfig(config_text);
  } catch {
    overrides = {};
  }
  return varKeys
    .map((key) => {
      const def = variables[key];
      return def === undefined
        ? ''
        : renderVariableWidget(toWidgetShape(key, def, overrides[key]), {
            fileRefPicker: caps.canPickFiles === true,
            recordRefPicker: caps.canPickRecords === true,
            idPrefix: 'run-modal-var',
          });
    })
    .join('');
};

/** The Schedule / Trigger tabs' config block: a labelled variable-widget
 *  form whose edits capture the overlay every headless fire runs with.
 *  Absent when the recipe has no variables (nothing to configure). */
const renderConfigSection = (
  recipe: ServerRecipeListEntry,
  config_text: string,
  label: string,
  caps: Pick<RunModalCaps, 'canPickFiles' | 'canPickRecords'>,
): string => {
  const rows = renderVariableRows(recipe, config_text, caps, 'configure');
  if (rows.length === 0) return '';
  return `
      <label class="run-modal-copy">${e(label)}</label>
      <div class="run-modal-fields">${rows}</div>`;
};

const runResultStatusLabel = (result: NonNullable<RunModalState['result']>): string => {
  if (result.awaiting_approval === true) return 'Awaiting approval';
  if (result.run_terminated !== undefined) return 'Run terminated';
  return result.success ? 'Run completed' : 'Run returned errors';
};

const renderRunTab = (
  state: RunModalState,
  recipe: ServerRecipeListEntry,
  caps: RunModalCaps,
): string => {
  const variables = recipe.recipe.variables ?? {};
  const varKeys = Object.keys(variables);
  const widgetRows = renderVariableRows(
    recipe,
    state.config_text,
    caps,
    'invoke',
  );
  let hasConfigValues = false;
  try {
    hasConfigValues = Object.keys(parseRunConfig(state.config_text)).length > 0;
  } catch {
    // The raw editor stays visible below and confirmRun surfaces the parse error.
  }
  // ⚠ The qualifier describes the FIELDS ABOVE, so it follows `widgetRows` — not
  // `varKeys`. D-222 Slice 0 split the two: a recipe whose variables are all
  // defaulted primitives declares variables (`varKeys` non-empty) and renders NO
  // invoke fields, so keying the copy on `varKeys` promised "the fields above" to
  // a reader looking at an empty "Run with overrides" panel.
  const jsonField = `
        <label class="run-modal-copy" for="run-modal-config">Config JSON${
          widgetRows.length > 0 ? ' (advanced — overrides the fields above)' : ''
        }</label>
        <textarea id="run-modal-config" ${RUN_MODAL_CONFIG_ATTR}>${e(state.config_text)}</textarea>`;
  const configBody = widgetRows.length > 0
    ? `
        <div class="run-modal-fields">${widgetRows}</div>
        <details class="run-modal-advanced"${hasConfigValues ? ' open' : ''}>
          <summary>Advanced — raw config JSON</summary>
          ${jsonField}
        </details>`
    : varKeys.length > 0
      ? `
        <details class="run-modal-advanced"${hasConfigValues ? ' open' : ''}>
          <summary>Run with overrides</summary>
          ${jsonField}
        </details>`
      : jsonField;

  // Targeting guard (design § 8) — warn + disable Run until the target is
  // supplied. Context targets get dedicated inputs; config targets ride
  // the variable widgets; a page target the webclient can't satisfy keeps
  // the routing guidance visible and Run disabled.
  const gate = runTargetGate(
    recipe.recipe,
    state.config_text,
    state.target_values,
    state.context_values,
  );
  const contextTargets = gate.targeting.targets.filter((t) => t.kind === 'context');
  const targetRows = contextTargets
    .map((t) => {
      const hasTypedPrefill =
        !Object.prototype.hasOwnProperty.call(state.target_values, t.key)
        && Object.prototype.hasOwnProperty.call(state.context_values, t.key);
      if (hasTypedPrefill) {
        let value = '';
        try {
          value = JSON.stringify(state.context_values[t.key]) ?? '';
        } catch {
          value = String(state.context_values[t.key]);
        }
        return `
        <div class="run-modal-context-target">
          <span class="run-modal-copy">Target — ${e(t.key)}</span>
          <code>${e(value)}</code>
          <span class="run-modal-meta">Prefilled in action context</span>
        </div>`;
      }
      return `
        <label class="run-modal-copy" for="run-modal-target-${e(t.key)}">Target — ${e(t.key)}</label>
        <input id="run-modal-target-${e(t.key)}" type="text"
          ${RUN_MODAL_TARGET_ATTR}="${e(t.key)}" data-target-key="${e(t.key)}"
          value="${e(state.target_values[t.key] ?? '')}"
          placeholder="The record's id (e.g. a deal id)" />`;
    })
    .join('');
  const pageMissing = gate.assessment.missing.some((t) => t.kind === 'page');
  const targetWarning = gate.assessment.ok
    ? ''
    : `
        <div ${RUN_MODAL_TARGET_WARNING_ATTR} role="alert" class="run-modal-target-warning">
          ${e(buildTargetRequiredMessage(recipe.recipe_id, gate.assessment.missing))}${
            pageMissing ? ` ${e('You can also run it from chat — the AI resolves the record for you.')}` : ''
          }
        </div>`;
  const targetBody = targetRows.length > 0 || targetWarning.length > 0
    ? `${targetWarning}${targetRows.length > 0 ? `<div class="run-modal-fields">${targetRows}</div>` : ''}`
    : '';

  let contextJson = '';
  if (Object.keys(state.context_values).length > 0) {
    try {
      contextJson = JSON.stringify(state.context_values, null, 2) ?? '{}';
    } catch {
      contextJson = '[Context could not be serialized]';
    }
  }
  const contextReview = contextJson === ''
    ? ''
    : `
      <details class="run-modal-context-review" open>
        <summary>Context JSON (prefilled)</summary>
        <pre ${RUN_MODAL_CONTEXT_ATTR}>${e(contextJson)}</pre>
      </details>`;

  const runFacts = state.result === null
    ? null
    : formatRecipeRunFacts(state.result.run_facts);
  const result = state.run_error !== null
    ? `<div ${RUN_MODAL_RESULT_ATTR} role="alert">${e(state.run_error)}</div>`
    : state.result !== null
      ? `<div ${RUN_MODAL_RESULT_ATTR} role="status" aria-live="polite" aria-atomic="true">
          <span>${e(runResultStatusLabel(state.result))}</span>
          ${runFacts === null
            ? `<span> · ${e(String(state.result.duration_ms))} ms · ${e(plural(state.result.steps.length, 'step'))}</span>`
            : `<span class="run-modal-facts" ${RUN_MODAL_FACTS_ATTR}>${e(runFacts)}</span>`}
        </div>`
      : '';

  const notWired = caps.canExecute
    ? ''
    : '<p class="run-modal-meta">Running is not available on this server yet.</p>';

  return `
      ${targetBody}
      ${configBody}
      ${contextReview}
      ${notWired}
      <div class="run-modal-actions">
        <button type="button" class="run-modal-button run-modal-button--primary"
          ${RUN_MODAL_ACTION_ATTR}="confirm-run"
          ${!caps.canExecute || !gate.assessment.ok ? 'disabled' : ''}
          ${state.executing ? 'aria-disabled="true" aria-busy="true"' : ''}>
          ${state.executing ? 'Running...' : 'Run'}
        </button>
      </div>
      ${result}`;
};

/** D-215 slice 5 — a schedule's cadence line, MODE-FIRST.
 *
 *  ⛔ Never pass a one-shot's `cron_expression` to `describeCron`. The
 *  server SYNTHESIZES that expression from `run_at`
 *  (`${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth()+1} *`),
 *  which is a VALID ANNUAL cron — `describeCron` matches no preset and no
 *  pattern branch, and returns the raw string. A one-shot would render as
 *  `30 14 3 8 *`, which reads as a recurring rule that does not exist.
 *  The expression is an internal artifact and is never shown. */
const cadenceLine = (s: ServerSchedule): string =>
  s.mode === 'one_shot'
    ? `Once — ${e(
        typeof s.run_at === 'number'
          ? new Date(s.run_at).toLocaleString()
          : 'time not set',
      )}`
    : `${e(describeCron(s.cron_expression))} <code>${e(s.cron_expression)}</code>`;

const scheduleActionName = (
  action: string,
  schedule: ServerSchedule,
): string => {
  const cadence = schedule.mode === 'one_shot'
    ? `Once — ${typeof schedule.run_at === 'number'
      ? new Date(schedule.run_at).toLocaleString()
      : 'time not set'}`
    : describeCron(schedule.cron_expression);
  return e(`${action} schedule ${cadence} (${schedule.schedule_id})`);
};

const renderScheduleRow = (
  schedule: ServerSchedule,
  enabled: boolean,
  nextRunAt: number | null,
  lastError: string | null,
  mutating: boolean,
  showConfig: boolean,
): string => {
  const scheduleId = schedule.schedule_id;
  const busyAttrs = mutating
    ? ' aria-disabled="true" aria-busy="true"'
    : '';
  return `
  <li class="run-modal-rule-row">
    <div>
      <div>${cadenceLine(schedule)}${enabled ? '' : ' — paused'}</div>
      <div class="run-modal-meta">next ${
        enabled && nextRunAt !== null ? e(new Date(nextRunAt).toLocaleString()) : '—'
      }${lastError ? ` · ${e(lastError)}` : ''}</div>
    </div>
    <div class="run-modal-actions">
      ${showConfig ? `<button type="button" class="run-modal-button"
        aria-label="${scheduleActionName('Config', schedule)}"
        ${RUN_MODAL_ACTION_ATTR}="config-schedule"
        ${RUN_MODAL_RULE_ID_ATTR}="${e(scheduleId)}"${busyAttrs}>Config</button>` : ''}
      <button type="button" class="run-modal-button"
        aria-label="${scheduleActionName(enabled ? 'Pause' : 'Resume', schedule)}"
        ${RUN_MODAL_ACTION_ATTR}="toggle-schedule:${enabled ? 'off' : 'on'}"
        ${RUN_MODAL_RULE_ID_ATTR}="${e(scheduleId)}"${busyAttrs}>${
          enabled ? 'Pause' : 'Resume'
        }</button>
      <button type="button" class="run-modal-button"
        aria-label="${scheduleActionName('Remove', schedule)}"
        ${RUN_MODAL_ACTION_ATTR}="remove-schedule"
        ${RUN_MODAL_RULE_ID_ATTR}="${e(scheduleId)}"${busyAttrs}>Remove</button>
    </div>
  </li>`;
};

const renderScheduleTab = (
  state: RunModalState,
  recipe: ServerRecipeListEntry,
  caps: RunModalCaps,
): string => {
  if (!caps.canSchedule) {
    return '<p class="run-modal-meta">Scheduling is not available on this server yet.</p>';
  }
  if (state.schedules === null) {
    return '<p class="run-modal-meta">Loading schedules…</p>';
  }
  // Config for the headless fires this schedule drives — the variable
  // edits ride into `config_overlay` on Add (empty ⇒ recipe defaults).
  const configSection = renderConfigSection(
    recipe,
    state.config_text,
    'Config for every scheduled run',
    caps,
  );
  const hasVars = Object.keys(recipe.recipe.variables ?? {}).length > 0;
  const rows = state.schedules
    .map((s) =>
      renderScheduleRow(
        s,
        s.enabled,
        s.next_run_at,
        s.last_error,
        state.mutating,
        hasVars,
      ),
    )
    .join('');
  const list = state.schedules.length === 0
    ? '<p class="run-modal-meta">No schedules for this recipe yet.</p>'
    : `<ul class="run-modal-rule-list" role="list">${rows}</ul>`;
  const error = state.schedule_error !== null
    ? `<div ${RUN_MODAL_SCHEDULE_ERROR_ATTR} role="alert" class="run-modal-target-warning">${e(state.schedule_error)}</div>`
    : '';
  return `
      ${error}
      ${list}
      ${configSection}
      <label class="run-modal-copy" for="run-modal-preset">Run on a schedule</label>
      <div class="run-modal-actions">
        <label class="run-modal-copy">
          <input type="checkbox" id="run-modal-repeat" ${RUN_MODAL_REPEAT_ATTR}
            ${state.repeat ? 'checked' : ''} />
          Repeat
        </label>
        ${state.repeat
          ? `<select id="run-modal-preset" class="run-modal-select" ${RUN_MODAL_PRESET_ATTR}>
          ${CRON_PRESETS.map((p) => `<option value="${e(p.expression)}"${p.expression === state.preset_expression ? ' selected' : ''}>${e(p.label)}</option>`).join('')}
        </select>`
          : `<input type="datetime-local" id="run-modal-preset" class="run-modal-select"
             ${RUN_MODAL_RUN_AT_ATTR} value="${e(state.run_at_local)}"
             aria-label="Run once at" />`}
        <button type="button" class="run-modal-button run-modal-button--primary"
          ${RUN_MODAL_ACTION_ATTR}="add-schedule"${state.mutating ? ' aria-disabled="true" aria-busy="true"' : ''}>
          ${state.repeat ? 'Add schedule' : 'Schedule once'}
        </button>
      </div>`;
};

/** R21 — the Trigger tab: this recipe's warehouse event-trigger rows +
 *  an Add form (free-text bus pattern; the server validates on create —
 *  `TRIGGER_PATTERN_INVALID` surfaces as the tab error). Recipe-origin
 *  rows are reconciler-managed: no Remove (a delete would be undone on
 *  the next reconcile); Pause is the durable gesture. */
const renderTriggerTab = (
  state: RunModalState,
  recipe: ServerRecipeListEntry,
  caps: RunModalCaps,
): string => {
  if (!caps.canTrigger) {
    return '<p class="run-modal-meta">Event triggers are not available on this server yet.</p>';
  }
  if (state.triggers === null) {
    return '<p class="run-modal-meta">Loading triggers…</p>';
  }
  // Config for the headless fires the added trigger drives — the variable
  // edits ride into `config_overlay` on Add (empty ⇒ recipe defaults).
  const configSection = renderConfigSection(
    recipe,
    state.config_text,
    'Config for runs from this trigger',
    caps,
  );
  const hasVars = Object.keys(recipe.recipe.variables ?? {}).length > 0;
  const busyAttrs = state.trigger_mutating
    ? ' aria-disabled="true" aria-busy="true"'
    : '';
  const rows = state.triggers
    .map((t) => {
      const actionName = (action: string): string =>
        e(`${action} trigger ${t.pattern} (${t.trigger_id})`);
      return `
  <li class="run-modal-rule-row">
    <div>
      <div>on <code>${e(t.pattern)}</code>${t.enabled ? '' : ' — paused'}${t.origin === 'recipe' ? ' · from recipe' : ''}</div>
      <div class="run-modal-meta">last fired ${
        t.last_fired_at !== null ? e(new Date(t.last_fired_at).toLocaleString()) : 'never'
      }${t.last_error ? ` · ${e(t.last_error)}` : ''}</div>
    </div>
    <div class="run-modal-actions">
      ${hasVars ? `<button type="button" class="run-modal-button"
        aria-label="${actionName('Config')}"
        ${RUN_MODAL_ACTION_ATTR}="config-trigger"
        ${RUN_MODAL_RULE_ID_ATTR}="${e(t.trigger_id)}"${busyAttrs}>Config</button>` : ''}
      <button type="button" class="run-modal-button"
        aria-label="${actionName(t.enabled ? 'Pause' : 'Resume')}"
        ${RUN_MODAL_ACTION_ATTR}="toggle-trigger:${t.enabled ? 'off' : 'on'}"
        ${RUN_MODAL_RULE_ID_ATTR}="${e(t.trigger_id)}"${busyAttrs}>${
          t.enabled ? 'Pause' : 'Resume'
        }</button>
      ${t.origin === 'recipe'
        ? ''
        : `<button type="button" class="run-modal-button"
        aria-label="${actionName('Remove')}"
        ${RUN_MODAL_ACTION_ATTR}="remove-trigger"
        ${RUN_MODAL_RULE_ID_ATTR}="${e(t.trigger_id)}"${busyAttrs}>Remove</button>`}
    </div>
  </li>`;
    })
    .join('');
  const list = state.triggers.length === 0
    ? '<p class="run-modal-meta">No event triggers for this recipe yet.</p>'
    : `<ul class="run-modal-rule-list" role="list">${rows}</ul>`;
  const error = state.trigger_error !== null
    ? `<div ${RUN_MODAL_TRIGGER_ERROR_ATTR} role="alert" class="run-modal-target-warning">${e(state.trigger_error)}</div>`
    : '';
  return `
      ${error}
      ${list}
      ${configSection}
      <label class="run-modal-copy" for="run-modal-pattern">Fire when warehouse data matching this pattern changes</label>
      <div class="run-modal-actions">
        <input id="run-modal-pattern" type="text" class="run-modal-select"
          ${RUN_MODAL_PATTERN_ATTR} value="${e(state.pattern_text)}"
          placeholder="e.g. data.mail.*" />
        <button type="button" class="run-modal-button run-modal-button--primary"
          ${RUN_MODAL_ACTION_ATTR}="add-trigger"${state.pattern_text.trim().length === 0
            ? ' disabled'
            : busyAttrs}>
          Add trigger
        </button>
      </div>`;
};

/** Render the full overlay (backdrop + panel + Run|Schedule tabs). */
export const renderRunModal = (
  state: RunModalState,
  recipe: ServerRecipeListEntry,
  caps: RunModalCaps,
): string => {
  const title = recipeDisplayName(recipe);
  const commandPending =
    state.executing || state.mutating || state.trigger_mutating;
  const tabId = (tab: RunModalTab): string => `recued-run-modal-${tab}-tab`;
  const tabPanelId = 'recued-run-modal-tabpanel';
  const tabButton = (tab: 'run' | 'schedule' | 'trigger', label: string): string =>
    `<button type="button" class="run-modal-tab" role="tab"
        id="${tabId(tab)}" aria-controls="${tabPanelId}"
        aria-selected="${state.tab === tab ? 'true' : 'false'}"
        tabindex="${state.tab === tab ? '0' : '-1'}"
        data-active="${state.tab === tab ? 'true' : 'false'}"
        ${RUN_MODAL_TAB_ATTR}="${tab}"
        ${RUN_MODAL_ACTION_ATTR}="tab:${tab}">${e(label)}</button>`;
  const body = state.tab === 'schedule'
    ? renderScheduleTab(state, recipe, caps)
    : state.tab === 'trigger'
      ? renderTriggerTab(state, recipe, caps)
      : renderRunTab(state, recipe, caps);
  return `
    <div ${RUN_MODAL_OVERLAY_ATTR}="${e(recipe.recipe_id)}">
      <section class="run-modal-panel" role="dialog" aria-modal="true" aria-label="Run a recipe" tabindex="-1">
        <header class="run-modal-header">
          <h2 class="run-modal-title">${e(title)}</h2>
          <div class="run-modal-recipe-id" ${RUN_MODAL_IDENTITY_ATTR}
            title="Recipe that will run">Target recipe: <code>${e(recipe.recipe_id)}</code> · Publisher: <code>${e(recipe.publisher_id)}</code></div>
          <button type="button" class="run-modal-button run-modal-close"
            ${RUN_MODAL_ACTION_ATTR}="close"${commandPending
              ? ' aria-disabled="true"'
              : ''}>Close</button>
        </header>
        <div class="run-modal-tabs" role="tablist">
          ${tabButton('run', 'Run')}
          ${
            // Hide the Schedule tab when no schedule caller is wired (a run-only
            // host like the recipes route, whose scheduling lives elsewhere) —
            // an unwired tab only leads to a dead "not available" panel. Still
            // shown if the modal was opened straight onto the Schedule tab.
            caps.canSchedule || state.tab === 'schedule'
              ? tabButton('schedule', 'Schedule')
              : ''
          }
          ${
            // R21 — same hiding idiom for the Trigger tab.
            caps.canTrigger || state.tab === 'trigger'
              ? tabButton('trigger', 'Trigger')
              : ''
          }
        </div>
        <div class="run-modal-body" id="${tabPanelId}" role="tabpanel"
          aria-labelledby="${tabId(state.tab)}">${body}</div>
      </section>
    </div>`;
};
