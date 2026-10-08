/** Shared Run | Schedule modal — render (state → HTML string).
 *
 *  Pure: `renderRunModal(state, recipe, caps)` returns the overlay markup.
 *  The wire layer sets it as the overlay's innerHTML and re-attaches.
 *  Markup + class names mirror the recipes-route run/automation modal so
 *  the existing CSS language carries over (the styles here re-scope the
 *  `.var-*` widget rules under the modal host).
 */

import { describePickedInstantOnServer } from '../two-clock.js';
import {
  buildTargetRequiredMessage,
  CRON_PRESETS,
  describeCron,
  DEFAULT_MISSED_SCHEDULE_POLICY,
  MAIL_FACT_BUILTIN_TYPES,
  MISSED_SCHEDULE_POLICIES,
  MISSED_SCHEDULE_POLICY_COPY,
  type Dish,
  type MissedSchedulePolicy,
  type ServerRecipeListEntry,
  type ServerSchedule,
} from '@recued/contracts';

import { e } from '../template.js';
import { formatRecipeRunFacts } from '../run-facts.js';
import { runFailureReason } from '../run-failure-reason.js';
import {
  isInvocationVariable,
  renderVariableWidget,
  toWidgetShape,
} from '../variable-widgets.js';

import {
  describeMailFactTrigger,
  humanizeFactName,
  mailFactChoiceLabel,
  mailFactTypeOf,
  mailFactVocabulary,
  mailFactWhereOptions,
} from './mail-fact-trigger.js';
import { eventTriggerInWords } from '../dish-lead.js';
import { configTextAsDish, parseRunConfig, plural, recipeDisplayName, runTargetGate } from './model.js';
import type { RunModalState, RunModalTab } from './types.js';

// ── Attribute namespace (own, NOT the recipes-route `RECIPES_ROUTE_*`) ──
export const RUN_MODAL_OVERLAY_ATTR = 'data-recued-run-modal';
export const RUN_MODAL_ACTION_ATTR = 'data-recued-run-modal-action';
export const RUN_MODAL_TAB_ATTR = 'data-recued-run-modal-tab';
/** D-319 — the "Run as" / "Add to" dish choice. */
export const RUN_MODAL_DISH_ATTR = 'data-recued-run-modal-dish';
export const RUN_MODAL_CONFIG_ATTR = 'data-recued-run-modal-config';
export const RUN_MODAL_TARGET_ATTR = 'data-recued-run-modal-target';
export const RUN_MODAL_TARGET_WARNING_ATTR = 'data-recued-run-modal-target-warning';
export const RUN_MODAL_CONTEXT_ATTR = 'data-recued-run-modal-context';
export const RUN_MODAL_IDENTITY_ATTR = 'data-recued-run-modal-identity';
export const RUN_MODAL_RESULT_ATTR = 'data-recued-run-modal-result';
export const RUN_MODAL_FACTS_ATTR = 'data-recued-run-modal-facts';
/** Why a run returned errors: the first error's message and step (D-312). */
export const RUN_MODAL_REASON_ATTR = 'data-recued-run-modal-reason';
export const RUN_MODAL_PRESET_ATTR = 'data-recued-run-modal-preset';
/** D-215 slice 5 — the Repeat toggle. Off ⇒ the datetime control replaces
 *  the CRON preset picker and Add creates a ONE-SHOT. */
export const RUN_MODAL_REPEAT_ATTR = 'data-recued-run-modal-repeat';
/** D-215 slice 5 — the one-shot datetime-local input. */
export const RUN_MODAL_SERVER_TIME_ATTR = 'data-recued-run-modal-server-time';
export const RUN_MODAL_RUN_AT_ATTR = 'data-recued-run-modal-run-at';
export const RUN_MODAL_RULE_ID_ATTR = 'data-recued-run-modal-rule-id';
export const RUN_MODAL_SCHEDULE_ERROR_ATTR = 'data-recued-run-modal-schedule-error';
/** D-266 — the per-schedule missed-run policy select. Carries the
 *  schedule id in `RUN_MODAL_RULE_ID_ATTR` alongside it. */
export const RUN_MODAL_MISSED_POLICY_ATTR = 'data-recued-run-modal-missed-policy';
/** D-266 — the Add-schedule form's policy select (no schedule id yet). */
export const RUN_MODAL_NEW_MISSED_POLICY_ATTR =
  'data-recued-run-modal-new-missed-policy';
export const RUN_MODAL_PATTERN_ATTR = 'data-recued-run-modal-pattern';
export const RUN_MODAL_TRIGGER_ERROR_ATTR = 'data-recued-run-modal-trigger-error';
/** D-315 §5.1 — a control of the "A mail fact" form: `type`, `field:<name>`,
 *  `where-variable`, `where-value`, `template`. */
export const RUN_MODAL_FACT_ATTR = 'data-recued-run-modal-fact';
/** Each "A mail fact" control's id: a choice repaints the form, and the focus
 *  returns to the control by its id — keyboard owners keep their place. */
export const factControlId = (control: string): string => `run-modal-fact-${control.replace(/[^a-z0-9_-]/gi, '-')}`;

/** What's wired — drives the "not available" degradations. */
export interface RunModalCaps {
  canExecute: boolean;
  canSchedule: boolean;
  canPreapprove?: boolean;
  /** R21 — the Trigger tab (list wired; create may still be absent). */
  canTrigger: boolean;
  /** D-200 — whether `file_ref` variables can use an owner-file picker. */
  canPickFiles?: boolean;
  /** Whether `record_ref` variables can use their pack-owned inventory. */
  canPickRecords?: boolean;
}

/** Render one widget per value a run asks for, pre-filled from the config
 *  shown (a dish's settings under the owner's changes — D-319). Returns ''
 *  when the recipe asks for none. A schedule or trigger has no settings of
 *  its own (they are its dish's), so only the Run tab asks. */
const renderVariableRows = (
  recipe: ServerRecipeListEntry,
  config_text: string,
  caps: Pick<RunModalCaps, 'canPickFiles' | 'canPickRecords'>,
): string => {
  const variables = recipe.recipe.variables ?? {};
  const varKeys = Object.keys(variables).filter((key) => isInvocationVariable(variables[key]!));
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

/** D-319 — which dish: "Run as" on the Run tab, "Add to" on the others. With
 *  one dish there is nothing to choose, so nothing shows. */
const dishChoiceLabel = (dish: Pick<Dish, 'name' | 'is_default'>): string =>
  dish.name.trim() !== '' ? `${dish.name}${dish.is_default ? ' (main)' : ''}` : dish.is_default ? 'Main' : 'Unnamed';

const renderDishChoice = (
  state: RunModalState,
  dishes: readonly Dish[],
  label: string,
): string => {
  if (dishes.length < 2) return '';
  return `
      <label class="run-modal-copy" for="run-modal-dish">${e(label)}</label>
      <select id="run-modal-dish" class="run-modal-select" ${RUN_MODAL_DISH_ATTR}>${dishes.map((dish) =>
        `<option value="${e(dish.dish_id)}"${dish.dish_id === state.dish_id ? ' selected' : ''}>${e(dishChoiceLabel(dish))}</option>`,
      ).join('')}</select>`;
};

/** A row's dish, said on the row once there is more than one. */
const dishOfRow = (dishes: readonly Dish[], dish_id: string | undefined): string =>
  dishes.length < 2 || dish_id === undefined
    ? ''
    : ` · for ${e(dishChoiceLabel(dishes.find((dish) => dish.dish_id === dish_id)
      ?? { name: '', is_default: false }))}`;

const runResultStatusLabel = (result: NonNullable<RunModalState['result']>): string => {
  if (result.awaiting_approval === true) return 'Awaiting approval';
  if (result.run_terminated !== undefined) return 'Run terminated';
  return result.success ? 'Run completed' : 'Run returned errors';
};

const renderRunTab = (
  state: RunModalState,
  recipe: ServerRecipeListEntry,
  caps: RunModalCaps,
  dishes: readonly Dish[],
): string => {
  const variables = recipe.recipe.variables ?? {};
  const varKeys = Object.keys(variables);
  // D-319 — the fields show the dish's settings; what the owner changes
  // applies to this run alone.
  const shownConfig = configTextAsDish(
    state.config_text,
    dishes.find((dish) => dish.dish_id === state.dish_id)?.config_overlay,
  );
  const widgetRows = renderVariableRows(recipe, shownConfig, caps);
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
    shownConfig,
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
            pageMissing ? ` ${e('You can also run it from Chat, and the AI will find the right one for you.')}` : ''
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
  // Only where the status says "Run returned errors": a hold and a terminated
  // run say what they are already.
  const failureReason = state.result !== null
    && runResultStatusLabel(state.result) === 'Run returned errors'
    ? runFailureReason(state.result.errors)
    : null;
  const result = state.run_error !== null
    ? `<div ${RUN_MODAL_RESULT_ATTR} role="alert">${e(state.run_error)}</div>`
    : state.result !== null
      ? `<div ${RUN_MODAL_RESULT_ATTR} role="status" aria-live="polite" aria-atomic="true">
          <span>${e(runResultStatusLabel(state.result))}</span>
          ${runFacts === null
            ? `<span> · ${e(String(state.result.duration_ms))} ms · ${e(plural(state.result.steps.length, 'step'))}</span>`
            : `<span class="run-modal-facts" ${RUN_MODAL_FACTS_ATTR}>${e(runFacts)}</span>`}
          ${failureReason === null
            ? ''
            : `<p class="run-modal-reason" ${RUN_MODAL_REASON_ATTR}>${e(failureReason)}</p>`}
        </div>`
      : '';

  const notWired = caps.canExecute
    ? ''
    : '<p class="run-modal-meta">Running is not available on this server yet.</p>';

  return `
      ${renderDishChoice(state, dishes, 'Run as')}
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

/** A stable element id per schedule, so the modal's existing
 *  focus-by-id restore survives the repaint that follows a policy
 *  change — no new focus kind needed. */
export const missedPolicySelectId = (scheduleId: string): string =>
  `run-modal-missed-policy-${scheduleId}`;

/** D-266 — the owner's answer to "what if this does not run?".
 *
 *  Rendered ON the schedule, not on the recipe: the same recipe answers
 *  differently on two schedules, and it is the owner who knows whether a
 *  late run is worth having. One-shots are excluded — there is no
 *  "missed cycle" for a schedule with exactly one occurrence; D-215
 *  already retains a one-shot that did not run as the owner's retry
 *  handle, which is the same decision made a different way. */
const missedPolicyOptions = (current: MissedSchedulePolicy): string =>
  MISSED_SCHEDULE_POLICIES.map((policy) => {
    const copy = MISSED_SCHEDULE_POLICY_COPY[policy];
    return `<option value="${e(policy)}"${policy === current ? ' selected' : ''}`
      + ` title="${e(copy.description)}">${e(copy.label)}</option>`;
  }).join('');

const renderMissedPolicy = (
  schedule: ServerSchedule,
  mutating: boolean,
): string => {
  if (schedule.mode === 'one_shot') return '';
  const options = missedPolicyOptions(
    schedule.missed_policy ?? DEFAULT_MISSED_SCHEDULE_POLICY,
  );
  return `
      <label class="run-modal-meta" for="${e(missedPolicySelectId(schedule.schedule_id))}">
        If it is missed:
        <select class="run-modal-select"
          id="${e(missedPolicySelectId(schedule.schedule_id))}"
          ${RUN_MODAL_MISSED_POLICY_ATTR}
          ${RUN_MODAL_RULE_ID_ATTR}="${e(schedule.schedule_id)}"
          aria-label="${scheduleActionName('Missed-run policy for', schedule)}"${
            mutating ? ' aria-disabled="true"' : ''
          }>${options}</select>
      </label>`;
};

const renderScheduleRow = (
  schedule: ServerSchedule,
  enabled: boolean,
  nextRunAt: number | null,
  lastError: string | null,
  mutating: boolean,
  dishLabel: string,
): string => {
  const scheduleId = schedule.schedule_id;
  const busyAttrs = mutating
    ? ' aria-disabled="true" aria-busy="true"'
    : '';
  return `
  <li class="run-modal-rule-row">
    <div>
      <div>${cadenceLine(schedule)}${enabled ? '' : ' — paused'}${dishLabel}</div>
      <div class="run-modal-meta">next ${
        enabled && nextRunAt !== null ? e(new Date(nextRunAt).toLocaleString()) : '—'
      }${lastError ? ` · ${e(lastError)}` : ''}</div>
      ${renderMissedPolicy(schedule, mutating)}
    </div>
    <div class="run-modal-actions">
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
  dishes: readonly Dish[],
): string => {
  if (!caps.canSchedule) {
    return '<p class="run-modal-meta">Scheduling is not available on this server yet.</p>';
  }
  if (state.schedules === null) {
    return '<p class="run-modal-meta">Loading schedules…</p>';
  }
  // D-319 — a schedule runs as its dish, with the dish's settings.
  const rows = state.schedules
    .map((s) =>
      renderScheduleRow(
        s,
        s.enabled,
        s.next_run_at,
        s.last_error,
        state.mutating,
        dishOfRow(dishes, s.dish_id),
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
      ${renderDishChoice(state, dishes, 'Add to')}
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
             aria-label="Run once at" />${((): string => {
               // D-269 — a `datetime-local` is read in the BROWSER's zone, and
               // the schedule runs on a machine that may keep another. The
               // instant is right; the sentence saying which clock was missing.
               // ⚠ Silent when the two agree — a line telling you 09:00 means
               // 09:00 is the line that teaches people to stop reading them.
               const picked = Date.parse(state.run_at_local);
               if (!Number.isFinite(picked)) return '';
               const note = describePickedInstantOnServer(picked, state.server_time_zone);
               return note === null ? '' : `<p class="run-modal-copy" ${RUN_MODAL_SERVER_TIME_ATTR}>${e(note)}</p>`;
             })()}`}
        ${state.repeat ? `<label class="run-modal-copy" for="run-modal-new-missed-policy">
          If it is missed:
          <select id="run-modal-new-missed-policy" class="run-modal-select"
            ${RUN_MODAL_NEW_MISSED_POLICY_ATTR}>${
              missedPolicyOptions(state.missed_policy)
            }</select>
        </label>` : ''}
        <button type="button" class="run-modal-button run-modal-button--primary"
          ${RUN_MODAL_ACTION_ATTR}="add-schedule"${state.mutating ? ' aria-disabled="true" aria-busy="true"' : ''}>
          ${state.repeat ? 'Add schedule' : 'Schedule once'}
        </button>
        ${caps.canPreapprove && !state.repeat ? `<button type="button" class="run-modal-button"
          ${RUN_MODAL_ACTION_ATTR}="review-schedule"${state.mutating ? ' aria-disabled="true" aria-busy="true"' : ''}>
          Review and pre-approve
        </button>` : ''}
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
  dishes: readonly Dish[],
): string => {
  if (!caps.canTrigger) {
    return '<p class="run-modal-meta">This server cannot set things off from events yet.</p>';
  }
  if (state.triggers === null) {
    return '<p class="run-modal-meta">Loading triggers…</p>';
  }
  const busyAttrs = state.trigger_mutating
    ? ' aria-disabled="true" aria-busy="true"'
    : '';
  const rows = state.triggers
    .map((t) => {
      const fact = describeMailFactTrigger(t, state.mail_fact_templates, state.mail_fact_types);
      const words = fact === null ? eventTriggerInWords(t) : null;
      const actionName = (action: string): string =>
        e(`${action} trigger ${fact ?? `when ${words}`} (${t.trigger_id})`);
      // Said in words, with the raw pattern kept on the meta line: this tab's
      // Add form takes patterns, so the one a row matches stays readable here.
      return `
  <li class="run-modal-rule-row">
    <div>
      <div>${fact !== null ? `on ${e(fact)}` : `when ${e(words!)}`}${t.enabled ? '' : ' — paused'}${t.origin === 'recipe' ? ' · from recipe' : ''}${dishOfRow(dishes, t.dish_id)}</div>
      <div class="run-modal-meta">${fact === null ? `<code>${e(t.pattern)}</code> · ` : ''}last fired ${
        t.last_fired_at !== null ? e(new Date(t.last_fired_at).toLocaleString()) : 'never'
      }${t.last_error ? ` · ${e(t.last_error)}` : ''}</div>
    </div>
    <div class="run-modal-actions">
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
  const kindButton = (kind: 'pattern' | 'mail_fact', label: string): string => `
        <button type="button" class="run-modal-button"
          ${RUN_MODAL_ACTION_ATTR}="trigger-kind:${kind}"
          aria-pressed="${state.trigger_kind === kind ? 'true' : 'false'}">${label}</button>`;
  const form = state.trigger_kind === 'mail_fact'
    ? renderMailFactForm(state, busyAttrs)
    : `
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
  return `
      ${error}
      ${list}
      ${renderDishChoice(state, dishes, 'Add to')}
      <div class="run-modal-actions" role="group" aria-label="What sets it off">
        ${kindButton('pattern', 'An event pattern')}
        ${kindButton('mail_fact', 'A mail fact')}
      </div>
      ${form}`;
};

const option = (value: string, label: string, selected: boolean): string =>
  `<option value="${e(value)}"${selected ? ' selected' : ''}>${e(label)}</option>`;

/** D-315 §5.1 — "A mail fact": the kind of email (or any kind), the values
 *  whose change wakes it (none: every change), one "only when", and the
 *  template. On any kind, each value is labelled with the kinds that have it,
 *  and a fact of any of them starts it (ruling 42); on one kind, only its own
 *  values are offered (ruling 43). */
const renderMailFactForm = (state: RunModalState, busyAttrs: string): string => {
  const draft = state.mail_fact;
  const owned = state.mail_fact_types;
  const type = draft.type === '' ? null : draft.type;
  const spec = type === null ? undefined : mailFactTypeOf(type, owned);
  const vocabulary = mailFactVocabulary(owned, type);
  const labelOf = (name: string): string => {
    const choice = vocabulary.find((candidate) => candidate.name === name);
    return choice === undefined ? humanizeFactName(name) : mailFactChoiceLabel(choice, owned, type);
  };
  const whereOptions = mailFactWhereOptions(owned, type);
  const chosen = whereOptions.find((candidate) => candidate.name === draft.where_variable);
  const valueControl = chosen === undefined
    ? ''
    : `<label class="run-modal-copy">Must be
        ${chosen.values !== undefined
          ? `<select class="run-modal-select" ${RUN_MODAL_FACT_ATTR}="where-value" id="${factControlId('where-value')}">
          ${option('', 'choose…', draft.where_value === '')}
          ${chosen.values.map((value) => option(value,
            chosen.kind === 'complete' || chosen.kind === 'boolean' ? (value === 'true' ? 'Yes' : 'No') : humanizeFactName(value),
            value === draft.where_value)).join('')}
        </select>`
          : `<input type="${chosen.kind === 'date' ? 'date' : 'text'}" class="run-modal-select" ${RUN_MODAL_FACT_ATTR}="where-value" id="${factControlId('where-value')}"
          value="${e(draft.where_value)}" />`}
      </label>`;
  const addable = vocabulary.filter((choice) => !draft.fields.includes(choice.name));
  const templates = (state.mail_fact_templates ?? []).filter((template) => type === null || template.type === type);
  return `
      <div class="run-modal-fact-form">
        <label class="run-modal-copy">Kind of email
          <select class="run-modal-select" ${RUN_MODAL_FACT_ATTR}="type" id="${factControlId('type')}">
            ${option('', 'Any kind that has what it watches', type === null)}
            ${MAIL_FACT_BUILTIN_TYPES.map((kind) => option(kind.id, kind.name, kind.id === type)).join('')}
            ${owned.length > 0
              ? `<optgroup label="Kinds you made">${owned.map((kind) => option(kind.id, kind.name, kind.id === type)).join('')}</optgroup>`
              : ''}
          </select>
        </label>
        <p class="run-modal-meta">${spec !== undefined
          ? e(spec.description)
          : 'It starts for a fact of any kind of email that has what it watches, including a kind you make later.'}</p>
        <fieldset class="run-modal-fact-fields">
          <legend class="run-modal-copy">Wake when one of these changes — none chosen: on every change</legend>
          ${draft.fields.map((name) => `
            <label><input type="checkbox" ${RUN_MODAL_FACT_ATTR}="field:${e(name)}" id="${factControlId(`field-${name}`)}" checked />
              ${e(labelOf(name))}</label>`).join('')}
        </fieldset>
        <label class="run-modal-copy">${draft.fields.length > 0 ? 'Also watch' : 'Watch'}
          <select class="run-modal-select" ${RUN_MODAL_FACT_ATTR}="field-add" id="${factControlId('field-add')}">
            ${option('', 'choose a value…', true)}
            ${addable.map((choice) => option(choice.name, mailFactChoiceLabel(choice, owned, type), false)).join('')}
          </select>
        </label>
        <div class="run-modal-fact-when">
          <label class="run-modal-copy">Only when
            <select class="run-modal-select" ${RUN_MODAL_FACT_ATTR}="where-variable" id="${factControlId('where-variable')}">
              ${option('', 'Always', draft.where_variable === '')}
              ${whereOptions.map((candidate) => option(candidate.name,
                candidate.kind === 'complete' ? 'Every required value was read' : labelOf(candidate.name),
                candidate.name === draft.where_variable)).join('')}
            </select>
          </label>
          ${valueControl}
        </div>
        ${state.mail_fact_templates !== null && templates.length > 0
          ? `<label class="run-modal-copy">Read by
              <select class="run-modal-select" ${RUN_MODAL_FACT_ATTR}="template" id="${factControlId('template')}">
                ${option('', 'any template, or the standard markup', draft.template_id === '')}
                ${templates.map((template) => option(
                  template.template_id,
                  type !== null
                    ? `${template.name}${template.active === false ? ' (off)' : ''}`
                    : `${template.name} (${(mailFactTypeOf(template.type, owned)?.name ?? humanizeFactName(template.type)).toLowerCase()}${template.active === false ? ', off' : ''})`,
                  template.template_id === draft.template_id,
                )).join('')}
              </select>
            </label>`
          : ''}
        <div class="run-modal-actions">
          <button type="button" class="run-modal-button run-modal-button--primary"
            ${RUN_MODAL_ACTION_ATTR}="add-trigger"${busyAttrs}>Add trigger</button>
        </div>
      </div>`;
};

/** Render the full overlay (backdrop + panel + Run|Schedule tabs). */
export const renderRunModal = (
  state: RunModalState,
  recipe: ServerRecipeListEntry,
  caps: RunModalCaps,
  /** D-319 — the recipe's dishes; none ⇒ nothing to choose. */
  dishes: readonly Dish[] = [],
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
    ? renderScheduleTab(state, recipe, caps, dishes)
    : state.tab === 'trigger'
      ? renderTriggerTab(state, recipe, caps, dishes)
      : renderRunTab(state, recipe, caps, dishes);
  return `
    <div ${RUN_MODAL_OVERLAY_ATTR}="${e(recipe.recipe_id)}">
      <section class="run-modal-panel" role="dialog" aria-modal="true" aria-label="Run a Recipe" tabindex="-1">
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
