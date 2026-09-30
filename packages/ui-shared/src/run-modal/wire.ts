/** Shared Run | Schedule modal — DOM glue (`wireRunModal`).
 *
 *  Builds an overlay element, paints it from state, and attaches DELEGATED
 *  click + input handlers on the stable root (so a full re-paint via
 *  `innerHTML` keeps the listeners). The Run-tab edits patch state WITHOUT
 *  a re-paint and flip the Run button + warning in place — caret
 *  preservation, identical to the recipes-route run modal. The host owns
 *  the DOM lifecycle: it appends `handle.element` to a portal and calls
 *  `handle.destroy()` on close.
 */

import {
  buildTargetRequiredMessage,
  CRON_PRESETS,
  DEFAULT_MISSED_SCHEDULE_POLICY,
  isMissedSchedulePolicy,
  parsePreparePreapproval,
  PREAPPROVAL_LIMITS,
  type MissedSchedulePolicy,
  type PreparePreapproval,
} from '@recued/contracts';

import {
  choiceListProblem,
  FILE_REF_VARIABLE_ATTR,
  fileRefVariablePickerId,
  readWidgetValue,
  toFileRefIds,
} from '../variable-widgets.js';
import {
  FILE_REF_ARRAY_STYLES,
  wireFileRefArray,
  type FileRefArrayHandle,
} from '../file-ref-array.js';
import {
  REF_PICKER_STYLES,
  wireRefPicker,
  type RefPickerHandle,
} from '../ref-picker/index.js';
import { wireRecordRefVariables } from '../record-ref-variable.js';
import { stampZone } from '../two-clock.js';

import { mailFactCreateArgs } from './mail-fact-trigger.js';
import {
  configTextAsDish,
  EMPTY_MAIL_FACT_DRAFT,
  initialDishId,
  initialRunModalState,
  parseRunConfig,
  recipeSchedules,
  recipeTriggers,
  runTargetGate,
} from './model.js';
import {
  renderRunModal,
  RUN_MODAL_ACTION_ATTR,
  RUN_MODAL_CONFIG_ATTR,
  RUN_MODAL_DISH_ATTR,
  RUN_MODAL_FACT_ATTR,
  RUN_MODAL_PATTERN_ATTR,
  RUN_MODAL_PRESET_ATTR,
  RUN_MODAL_MISSED_POLICY_ATTR,
  RUN_MODAL_NEW_MISSED_POLICY_ATTR,
  RUN_MODAL_REPEAT_ATTR,
  RUN_MODAL_RUN_AT_ATTR,
  RUN_MODAL_RULE_ID_ATTR,
  RUN_MODAL_SCHEDULE_ERROR_ATTR,
  RUN_MODAL_TAB_ATTR,
  RUN_MODAL_TARGET_ATTR,
  RUN_MODAL_TARGET_WARNING_ATTR,
  RUN_MODAL_TRIGGER_ERROR_ATTR,
  type RunModalCaps,
} from './render.js';
import { RUN_MODAL_STYLES } from './styles.js';
import { wireFocusTrap, type FocusTrapHandle } from '../focus-trap.js';
import type {
  RunModalHandle,
  RunModalState,
  RunModalTab,
  WireRunModalOptions,
} from './types.js';

/** D-215 slice 5 / § 4.6 — a `datetime-local` value carries NO zone, and
 *  `new Date(s)` on a zone-less string is parsed in the runtime's LOCAL
 *  zone. That is exactly what we want HERE and only here: the owner picked
 *  a wall-clock time in the browser, so the browser's zone IS their intent,
 *  and we convert to an absolute instant (epoch ms) before it ever leaves.
 *
 *  ⚠ The hazard § 4.6 warns about is the SERVER doing this. Resolving the
 *  zone at the picker and shipping epoch ms is what prevents it: `run_at`
 *  is an instant, never a wall clock.
 *
 *  Returns null for an empty or unparseable value. */
const parseLocalDateTime = (value: string): number | null => {
  if (value.trim().length === 0) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

const RUN_MODAL_STYLES_MARKER = 'data-recued-run-modal-styles';

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** What a run that did not come back says. The wait ran out, or the connection
 *  dropped after the run was sent: either way the run may well have finished
 *  on the server, so neither reads as a failure, and both say where its result
 *  is. Anything else is the error it is. */
const runErrMessage = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'timeout') {
    return 'Still running on your server. It will finish there, and its result will be in Logs.';
  }
  if (code === 'connection_lost') {
    return 'The connection dropped while this ran, so its result did not arrive here. Logs shows how it ended.';
  }
  return errMessage(err);
};

const injectStyles = (doc: Document): void => {
  if (doc.head.querySelector(`style[${RUN_MODAL_STYLES_MARKER}]`) !== null) {
    return;
  }
  const style = doc.createElement('style');
  style.setAttribute(RUN_MODAL_STYLES_MARKER, '');
  style.textContent = `${RUN_MODAL_STYLES}\n${REF_PICKER_STYLES}\n${FILE_REF_ARRAY_STYLES}`;
  doc.head.appendChild(style);
};

export const wireRunModal = (opts: WireRunModalOptions): RunModalHandle => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'wireRunModal: no document available — pass `opts.document` for non-browser environments',
    );
  }
  injectStyles(doc);

  const caps: RunModalCaps = {
    canExecute: opts.execute !== undefined,
    canSchedule: opts.schedulesList !== undefined,
    canPreapprove: opts.preapprovalPrepare !== undefined,
    canTrigger: opts.triggersList !== undefined,
    canPickFiles: opts.fileRefSearch !== undefined,
    canPickRecords: opts.recordRefSearch !== undefined,
  };
  const firstPreset = CRON_PRESETS[0]?.expression ?? '';
  let state: RunModalState = initialRunModalState(
    opts.initialTab ?? 'run',
    firstPreset,
    initialDishId(opts.dishes, opts.dish_id),
  );
  /** D-319 — the config the Run tab shows and checks: the chosen dish's
   *  settings, what the owner changed on top. Only the changes are sent. */
  const shownConfigText = (): string => configTextAsDish(
    state.config_text,
    opts.dishes?.find((dish) => dish.dish_id === state.dish_id)?.config_overlay,
  );
  // D-269 — resolved once at open. The server's zone does not change mid-dialog,
  // and re-reading per keystroke would be a thunk call inside a render loop.
  {
    const zone = opts.serverTimeZone?.();
    if (zone !== undefined && zone.length > 0) state = { ...state, server_time_zone: zone };
  }
  let destroyed = false;
  // Assigned after the first paint (the panel must exist to focus into); the
  // trap traps Tab within the overlay + restores focus to the opener on detach.
  let trap: FocusTrapHandle | null = null;
  let refPickers: RefPickerHandle[] = [];
  let fileRefArrays: FileRefArrayHandle[] = [];

  const overlay = doc.createElement('div');
  overlay.className = 'run-modal-overlay-root';

  type RunModalFocusIdentity =
    | { kind: 'action'; value: string; ruleId?: string }
    | {
        kind: 'id';
        value: string;
        selectionStart: number | null;
        selectionEnd: number | null;
      };

  const elementsWith = (attribute: string): HTMLElement[] =>
    Array.from(
      overlay.querySelectorAll?.(`[${attribute}]`) ?? [],
    ) as HTMLElement[];

  const focusIdentityElement = (
    identity: RunModalFocusIdentity,
  ): HTMLElement | null => {
    if (identity.kind === 'action') {
      const candidates = elementsWith(RUN_MODAL_ACTION_ATTR).filter(
        (element) => identity.ruleId === undefined
          || element.getAttribute(RUN_MODAL_RULE_ID_ATTR) === identity.ruleId,
      );
      const exact = candidates.find(
        (element) => element.getAttribute(RUN_MODAL_ACTION_ATTR) === identity.value,
      );
      if (exact !== undefined) return exact;
      const toggleFamily = /^(toggle-(?:schedule|trigger)):(?:on|off)$/.exec(
        identity.value,
      )?.[1];
      return toggleFamily === undefined
        ? null
        : candidates.find((element) =>
          element.getAttribute(RUN_MODAL_ACTION_ATTR)?.startsWith(`${toggleFamily}:`),
        ) ?? null;
    }
    return elementsWith('id').find(
      (element) => element.getAttribute('id') === identity.value,
    ) ?? null;
  };

  const captureFocusIdentity = (): RunModalFocusIdentity | null => {
    const activeElement = (
      doc as Document & { activeElement?: HTMLElement | null }
    ).activeElement;
    if (activeElement == null) return null;
    const contains = (
      overlay as HTMLElement & { contains?: (other: Node | null) => boolean }
    ).contains;
    if (typeof contains === 'function' && !contains.call(overlay, activeElement)) {
      return null;
    }
    const action = activeElement.getAttribute?.(RUN_MODAL_ACTION_ATTR);
    if (action !== null && action !== undefined) {
      const ruleId = activeElement.getAttribute?.(RUN_MODAL_RULE_ID_ATTR);
      return ruleId === null || ruleId === undefined
        ? { kind: 'action', value: action }
        : { kind: 'action', value: action, ruleId };
    }
    const id = activeElement.getAttribute?.('id');
    if (id === null || id === undefined || id.length === 0) return null;
    const selection = activeElement as HTMLElement & {
      selectionStart?: number | null;
      selectionEnd?: number | null;
    };
    return {
      kind: 'id',
      value: id,
      selectionStart: selection.selectionStart ?? null,
      selectionEnd: selection.selectionEnd ?? null,
    };
  };

  // Arm the modal's Tab focus-trap on the stable overlay. Extracted so the
  // per-row config editor can release it while open and re-arm on close.
  const armModalTrap = (): void => {
    trap = wireFocusTrap({
      document: doc,
      getContainer: () => overlay,
      initialFocus: false,
    });
  };

  const paint = (restoreFocus: RunModalFocusIdentity | null = null): void => {
    if (destroyed) return;
    for (const picker of refPickers) picker.destroy();
    refPickers = [];
    for (const list of fileRefArrays) list.destroy();
    fileRefArrays = [];
    overlay.innerHTML = renderRunModal(state, opts.recipe, caps, opts.dishes ?? []);
    mountVariablePickers();
    if (restoreFocus !== null) {
      const target = focusIdentityElement(restoreFocus);
      target?.focus?.({ preventScroll: true });
      if (restoreFocus.kind === 'id' && target !== null) {
        const selectable = target as HTMLElement & {
          setSelectionRange?: (start: number, end: number) => void;
        };
        if (
          restoreFocus.selectionStart !== null
          && restoreFocus.selectionEnd !== null
          && typeof selectable.setSelectionRange === 'function'
        ) {
          selectable.setSelectionRange(
            restoreFocus.selectionStart,
            restoreFocus.selectionEnd,
          );
        }
      }
    }
  };

  // Targeting guard (design § 8) — live half: recompute the gate and flip
  // the Run button + warning in place (no re-paint, so the active field
  // keeps its caret). Render-time state stays authoritative.
  const refreshRunGate = (): void => {
    if (state.tab !== 'run') return;
    const gate = runTargetGate(
      opts.recipe.recipe,
      shownConfigText(),
      state.target_values,
      state.context_values,
    );
    const runButton = overlay.querySelector?.(
      `[${RUN_MODAL_ACTION_ATTR}="confirm-run"]`,
    ) as HTMLButtonElement | null | undefined;
    if (runButton) {
      runButton.disabled = !caps.canExecute || !gate.assessment.ok;
      if (state.executing) {
        runButton.setAttribute('aria-disabled', 'true');
        runButton.setAttribute('aria-busy', 'true');
      } else {
        runButton.removeAttribute('aria-disabled');
        runButton.removeAttribute('aria-busy');
      }
    }
    const warning = overlay.querySelector?.(
      `[${RUN_MODAL_TARGET_WARNING_ATTR}]`,
    ) as HTMLElement | null | undefined;
    if (warning) {
      if (gate.assessment.ok) {
        warning.style.display = 'none';
      } else {
        warning.style.display = '';
        const pageMissing = gate.assessment.missing.some((t) => t.kind === 'page');
        warning.textContent =
          buildTargetRequiredMessage(opts.recipe.recipe_id, gate.assessment.missing)
          + (pageMissing
            ? ' You can also run it from Chat, and the AI will find the right one for you.'
            : '');
      }
    }
  };

  const detach = (): void => {
    if (destroyed) return;
    destroyed = true;
    for (const picker of refPickers) picker.destroy();
    refPickers = [];
    for (const list of fileRefArrays) list.destroy();
    fileRefArrays = [];
    overlay.removeEventListener('click', onClick);
    overlay.removeEventListener('input', onInput);
    overlay.removeEventListener('change', onInput);
    doc.removeEventListener('keydown', onKeydown);
    overlay.remove();
    // Detach the Tab-trap's keydown + restore focus to the opener.
    trap?.release();
  };

  const close = (): void => {
    // A user dismissal must not detach the only visible owner of an
    // in-flight side effect. Hosts can still call `destroy()` for route or
    // application teardown; only Close / Escape are held until the command
    // reaches a result or an actionable error.
    if (state.executing || state.mutating || state.trigger_mutating) return;
    detach();
    opts.onClose?.();
  };

  const confirmRun = async (): Promise<void> => {
    // Guard a double-run — the rendered Run button is aria-disabled while
    // executing so it can retain focus, but the imperative path has no such gate.
    if (state.executing) return;
    const runFocus = captureFocusIdentity();
    if (!caps.canExecute || opts.execute === undefined) {
      state = { ...state, run_error: 'Running is not available on this server yet.' };
      paint(runFocus);
      return;
    }
    let config: Record<string, unknown>;
    try {
      config = parseRunConfig(state.config_text);
    } catch (err) {
      state = { ...state, run_error: errMessage(err) };
      paint(runFocus);
      return;
    }
    // D-314 — a required list with every box unticked does not run: the recipe
    // would get an empty list (a weekday window with no days). Checked as the
    // run will see it: the dish's settings with the changes on top.
    const listProblem = choiceListProblem(
      opts.recipe.recipe.variables ?? {},
      parseRunConfig(shownConfigText()),
    );
    if (listProblem !== null) {
      state = { ...state, run_error: listProblem };
      paint(runFocus);
      return;
    }
    // Belt to the render-time disable: a targeted run with its target still
    // missing never dispatches (the server guard would block it anyway).
    const gate = runTargetGate(
      opts.recipe.recipe,
      shownConfigText(),
      state.target_values,
      state.context_values,
    );
    if (!gate.assessment.ok) {
      state = {
        ...state,
        run_error: buildTargetRequiredMessage(
          opts.recipe.recipe_id,
          gate.assessment.missing,
        ),
      };
      paint(runFocus);
      return;
    }
    state = { ...state, executing: true, run_error: null, result: null };
    paint(runFocus);
    try {
      const result = await opts.execute({
        recipe_id: opts.recipe.recipe_id,
        config,
        ...(Object.keys(gate.context).length > 0 ? { context: gate.context } : {}),
        // D-319 — as the chosen dish; `config` is what changed for this run.
        ...(state.dish_id !== null ? { dish_id: state.dish_id } : {}),
      });
      if (destroyed) return;
      const completionFocus = captureFocusIdentity();
      state = { ...state, executing: false, result };
      paint(completionFocus);
      opts.onRan?.(result);
    } catch (err) {
      if (destroyed) return;
      const completionFocus = captureFocusIdentity();
      state = { ...state, executing: false, run_error: runErrMessage(err) };
      paint(completionFocus);
    }
  };

  const loadSchedules = async (
    restoreFocus?: RunModalFocusIdentity | null,
  ): Promise<void> => {
    if (opts.schedulesList === undefined) return;
    try {
      const { schedules } = await opts.schedulesList();
      if (destroyed) return;
      state = {
        ...state,
        schedules: recipeSchedules(schedules, opts.recipe.recipe_id),
      };
      paint(restoreFocus === undefined ? captureFocusIdentity() : restoreFocus);
    } catch (err) {
      if (destroyed) return;
      state = { ...state, schedules: [], schedule_error: errMessage(err) };
      paint(restoreFocus === undefined ? captureFocusIdentity() : restoreFocus);
    }
  };

  const runScheduleMutation = async (
    fn: () => Promise<unknown>,
    successFocus?: RunModalFocusIdentity | null,
  ): Promise<void> => {
    if (state.mutating) return;
    const mutationFocus = captureFocusIdentity();
    state = { ...state, mutating: true, schedule_error: null };
    paint(mutationFocus);
    try {
      await fn();
      if (destroyed) return;
      state = { ...state, mutating: false };
      await loadSchedules(successFocus);
    } catch (err) {
      if (destroyed) return;
      const failureFocus = captureFocusIdentity();
      state = { ...state, mutating: false, schedule_error: errMessage(err) };
      paint(failureFocus);
    }
  };

  const scheduleNotWired = (): Promise<void> => {
    const unavailableFocus = captureFocusIdentity();
    state = {
      ...state,
      schedule_error: 'Scheduling is not available on this server yet.',
    };
    paint(unavailableFocus);
    return Promise.resolve();
  };

  const addSchedule = (): Promise<void> => {
    if (state.mutating) return Promise.resolve();
    const create = opts.schedulesCreate;
    if (create === undefined) return scheduleNotWired();
    const addFocus = captureFocusIdentity();
    // D-215 slice 5 — Repeat off ⇒ a ONE-SHOT. The two arms are mutually
    // exclusive at the caller, which is what keeps "one-shot" from being a
    // second concept: it is this toggle, not a second entry point.
    const runAt = state.repeat ? null : parseLocalDateTime(state.run_at_local);
    if (state.repeat) {
      // Parity with the recipes route: an empty preset never creates a row.
      if (state.preset_expression.length === 0) return Promise.resolve();
    } else if (runAt === null) {
      state = { ...state, schedule_error: 'Pick a date and time to run once.' };
      paint(addFocus);
      return Promise.resolve();
    }
    return runScheduleMutation(() =>
      create({
        recipe_id: opts.recipe.recipe_id,
        // Default to the installed recipe's publisher (recipes-route
        // parity); `opts.publisherId` overrides when a host needs it.
        publisher_id: opts.publisherId ?? opts.recipe.publisher_id,
        ...(state.repeat
          // `mode` is OMITTED for recurring, not sent as 'recurring': the
          // contract reads absent as recurring, so every pre-slice-5 host
          // and payload stays byte-identical.
          ? { cron_expression: state.preset_expression }
          // The server SYNTHESIZES `cron_expression` from `run_at`, so the
          // caller never supplies one for a one-shot.
          : { mode: 'one_shot' as const, run_at: runAt! }),
        // D-319 — the schedule runs as its dish, with the dish's settings.
        ...(state.dish_id !== null ? { dish_id: state.dish_id } : {}),
        // D-266 — omitted at the default, not sent as 'auto': the contract
        // reads absent as 'auto', so every pre-D-266 host and payload stays
        // byte-identical (same discipline as `mode` above). One-shots have no
        // missed CYCLE, so the field is scoped to the recurring arm.
        ...(state.repeat && state.missed_policy !== DEFAULT_MISSED_SCHEDULE_POLICY
          ? { missed_policy: state.missed_policy }
          : {}),
      }),
    );
  };

  // Keep the same key, deadlines and body after an uncertain response. Only
  // an explicit material edit starts a different preparation request.
  let pendingPreparation: { material: string; request: PreparePreapproval } | null = null;
  const reviewSchedule = async (): Promise<void> => {
    if (destroyed || state.mutating || !opts.preapprovalPrepare) return;
    const focus = captureFocusIdentity();
    try {
      if (state.repeat) throw new Error('Choose Run once to look at this before it is scheduled.');
      const runAt = parseLocalDateTime(state.run_at_local);
      if (runAt === null || runAt <= Date.now()) throw new Error('Pick a future date and time to run once.');
      const config = parseRunConfig(state.config_text);
      const subject = { kind: 'recipe', recipe_id: opts.recipe.recipe_id,
        publisher_id: opts.publisherId ?? opts.recipe.publisher_id, config };
      const activation = { kind: 'one_shot', run_at: runAt,
        // D-269 — the SERVER's zone: this activation is evaluated server-side.
        // Was the composing browser's, re-stamped on EVERY schedule, so
        // scheduling from a laptop abroad wrote the travel zone into the row.
        time_zone: stampZone(opts.serverTimeZone) };
      const material = JSON.stringify({ subject, activation });
      if (pendingPreparation?.material !== material) {
        pendingPreparation = { material, request: parsePreparePreapproval({
          idempotency_key: crypto.randomUUID(), subject, activation,
          decision_deadline: Math.min(runAt, Date.now() + PREAPPROVAL_LIMITS.default_decision_ms),
          dispatch_deadline: runAt + PREAPPROVAL_LIMITS.default_dispatch_grace_ms,
        }) };
      }
      state = { ...state, mutating: true, schedule_error: null }; paint(focus);
      const result = await opts.preapprovalPrepare(pendingPreparation.request);
      if (destroyed) return;
      state = { ...state, mutating: false };
      close();
      opts.onPreapprovalPrepared?.(result);
    } catch (err) {
      if (destroyed) return;
      state = { ...state, mutating: false, schedule_error: errMessage(err) }; paint(focus);
    }
  };

  /** D-266 — the policy the next Add arms the schedule with. Local
   *  state only; it reaches the server as part of `schedules.create`. */
  const setNewMissedPolicy = (policy: MissedSchedulePolicy): void => {
    state = { ...state, missed_policy: policy, schedule_error: null };
    paint(captureFocusIdentity());
  };

  const toggleSchedule = (ruleId: string, to: boolean): Promise<void> => {
    const update = opts.schedulesUpdate;
    if (update === undefined) return scheduleNotWired();
    return runScheduleMutation(() => update({ schedule_id: ruleId, enabled: to }));
  };

  /** D-266 — persist the owner's missed-run policy for one schedule.
   *  Same mutation path as pause/resume: the change lands on the
   *  server row, and the repaint comes from the reloaded list rather
   *  than from local state, so a rejected change never leaves the
   *  select showing a value the server does not hold. */
  const setMissedPolicy = (
    ruleId: string,
    policy: MissedSchedulePolicy,
  ): Promise<void> => {
    const update = opts.schedulesUpdate;
    if (update === undefined) return scheduleNotWired();
    return runScheduleMutation(
      () => update({ schedule_id: ruleId, missed_policy: policy }),
    );
  };

  const removeSchedule = (ruleId: string): Promise<void> => {
    const del = opts.schedulesDelete;
    if (del === undefined) return scheduleNotWired();
    const rows = state.schedules ?? [];
    const index = rows.findIndex((schedule) => schedule.schedule_id === ruleId);
    const successor = index < 0
      ? undefined
      : rows[index + 1] ?? rows[index - 1];
    const successFocus: RunModalFocusIdentity = successor === undefined
      ? { kind: 'action', value: 'add-schedule' }
      : {
          kind: 'action',
          value: `toggle-schedule:${successor.enabled ? 'off' : 'on'}`,
          ruleId: successor.schedule_id,
        };
    return runScheduleMutation(
      () => del({ schedule_id: ruleId }),
      successFocus,
    );
  };

  // ── R21 Trigger tab — mirrors the schedule half verbatim ──
  /** D-315 §5.1 — the owner's templates, once: the "A mail fact" form's
   *  "Read by" picker, and the names a fact trigger's row gives. */
  const loadMailFactTemplates = async (): Promise<void> => {
    if (opts.mailFactTemplates === undefined || state.mail_fact_templates !== null) return;
    // §4.5 — the owner's kinds of email come with them. A list that failed is
    // not an empty one: the templates stay unknown (a trigger narrowed to one
    // reads "read by one template", never "a template that was deleted") and
    // are asked for again next time; the kinds stay as they were.
    const [templates, types] = await Promise.all([
      opts.mailFactTemplates().then((result) => result.templates, () => null),
      opts.mailFactTypes?.().then((result) => result.types, () => null) ?? Promise.resolve(null),
    ]);
    if (destroyed) return;
    state = { ...state, mail_fact_templates: templates, mail_fact_types: types ?? state.mail_fact_types };
    paint(captureFocusIdentity());
  };

  const loadTriggers = async (
    restoreFocus?: RunModalFocusIdentity | null,
  ): Promise<void> => {
    if (opts.triggersList === undefined) return;
    void loadMailFactTemplates();
    try {
      const { triggers } = await opts.triggersList();
      if (destroyed) return;
      state = {
        ...state,
        triggers: recipeTriggers(triggers, opts.recipe.recipe_id),
      };
      paint(restoreFocus === undefined ? captureFocusIdentity() : restoreFocus);
    } catch (err) {
      if (destroyed) return;
      state = { ...state, triggers: [], trigger_error: errMessage(err) };
      paint(restoreFocus === undefined ? captureFocusIdentity() : restoreFocus);
    }
  };

  const runTriggerMutation = async (
    fn: () => Promise<unknown>,
    successFocus?: RunModalFocusIdentity | null,
  ): Promise<void> => {
    if (state.trigger_mutating) return;
    const mutationFocus = captureFocusIdentity();
    state = { ...state, trigger_mutating: true, trigger_error: null };
    paint(mutationFocus);
    try {
      await fn();
      if (destroyed) return;
      state = { ...state, trigger_mutating: false };
      await loadTriggers(successFocus);
    } catch (err) {
      if (destroyed) return;
      const failureFocus = captureFocusIdentity();
      state = { ...state, trigger_mutating: false, trigger_error: errMessage(err) };
      paint(failureFocus);
    }
  };

  const triggerNotWired = (): Promise<void> => {
    const unavailableFocus = captureFocusIdentity();
    state = {
      ...state,
      trigger_error: 'This server cannot set things off from events yet.',
    };
    paint(unavailableFocus);
    return Promise.resolve();
  };

  const addTrigger = (): Promise<void> => {
    if (state.trigger_mutating) return Promise.resolve();
    const create = opts.triggersCreate;
    if (create === undefined) return triggerNotWired();
    const addFocus = captureFocusIdentity();
    // D-315 §5.1 — "A mail fact" sends the shorthand; the server validates it
    // as it validates a recipe's, and a refusal comes back with its reason.
    const shorthand = state.trigger_kind === 'mail_fact' ? mailFactCreateArgs(state.mail_fact, state.mail_fact_types) : null;
    if (shorthand !== null && 'error' in shorthand) {
      state = { ...state, trigger_error: shorthand.error };
      paint(addFocus);
      return Promise.resolve();
    }
    const pattern = state.pattern_text.trim();
    // An empty pattern never creates a row (the rendered Add is disabled;
    // this guards the imperative path).
    if (shorthand === null && pattern.length === 0) return Promise.resolve();
    return runTriggerMutation(() =>
      create({
        recipe_id: opts.recipe.recipe_id,
        publisher_id: opts.publisherId ?? opts.recipe.publisher_id,
        ...(shorthand !== null ? shorthand : { pattern }),
        // D-319 — the trigger fires as its dish, with the dish's settings.
        ...(state.dish_id !== null ? { dish_id: state.dish_id } : {}),
      }),
    );
  };

  const toggleTrigger = (ruleId: string, to: boolean): Promise<void> => {
    const update = opts.triggersUpdate;
    if (update === undefined) return triggerNotWired();
    return runTriggerMutation(() => update({ trigger_id: ruleId, enabled: to }));
  };

  const removeTrigger = (ruleId: string): Promise<void> => {
    const del = opts.triggersDelete;
    if (del === undefined) return triggerNotWired();
    const rows = state.triggers ?? [];
    const index = rows.findIndex((trigger) => trigger.trigger_id === ruleId);
    const successor = index < 0
      ? undefined
      : rows[index + 1] ?? rows[index - 1];
    const successFocus: RunModalFocusIdentity = successor === undefined
      ? { kind: 'action', value: 'add-trigger' }
      : {
          kind: 'action',
          value: `toggle-trigger:${successor.enabled ? 'off' : 'on'}`,
          ruleId: successor.trigger_id,
        };
    return runTriggerMutation(
      () => del({ trigger_id: ruleId }),
      successFocus,
    );
  };

  function onClick(ev: Event): void {
    const start = ev.target as Element | null;
    if (start === null || typeof start.closest !== 'function') return;
    const actor = start.closest(`[${RUN_MODAL_ACTION_ATTR}]`);
    if (actor === null) return;
    const action = actor.getAttribute(RUN_MODAL_ACTION_ATTR) ?? '';
    if (action === 'close') {
      close();
      return;
    }
    if (action === 'tab:run' || action === 'tab:schedule' || action === 'tab:trigger') {
      setTab(action.slice('tab:'.length) as RunModalTab, true);
      return;
    }
    if (action === 'confirm-run') {
      void confirmRun();
      return;
    }
    if (action === 'add-schedule') {
      void addSchedule();
      return;
    }
    if (action === 'review-schedule') {
      void reviewSchedule();
      return;
    }
    if (action === 'add-trigger') {
      void addTrigger();
      return;
    }
    if (action === 'trigger-kind:pattern' || action === 'trigger-kind:mail_fact') {
      const kindFocus = captureFocusIdentity();
      state = {
        ...state,
        trigger_kind: action === 'trigger-kind:mail_fact' ? 'mail_fact' : 'pattern',
        trigger_error: null,
      };
      paint(kindFocus);
      if (state.trigger_kind === 'mail_fact') void loadMailFactTemplates();
      return;
    }
    const ruleId = actor.getAttribute(RUN_MODAL_RULE_ID_ATTR) ?? '';
    if (action === 'toggle-schedule:on') {
      void toggleSchedule(ruleId, true);
      return;
    }
    if (action === 'toggle-schedule:off') {
      void toggleSchedule(ruleId, false);
      return;
    }
    if (action === 'remove-schedule') {
      void removeSchedule(ruleId);
      return;
    }
    if (action === 'toggle-trigger:on') {
      void toggleTrigger(ruleId, true);
      return;
    }
    if (action === 'toggle-trigger:off') {
      void toggleTrigger(ruleId, false);
      return;
    }
    if (action === 'remove-trigger') {
      void removeTrigger(ruleId);
    }
  }

  function onInput(ev: Event): void {
    const target = ev.target as
      | (HTMLElement & { value?: string; dataset?: DOMStringMap })
      | null;
    if (target === null || typeof target.hasAttribute !== 'function') return;
    // D-319 — which dish: the fields repaint with its settings.
    if (target.hasAttribute(RUN_MODAL_DISH_ATTR)) {
      const next = target.value ?? '';
      if (next !== (state.dish_id ?? '')) setDish(next === '' ? null : next);
      return;
    }
    // Schedule preset — captured in state (not read at Add-click time) so a
    // re-paint mid-choice can't reset it. Selects emit input + change.
    // D-266 — the per-schedule missed-run policy. Selects emit input +
    // change; the mutation is idempotent so the double event is safe.
    // D-266 — the Add-schedule form's policy (no schedule id yet).
    if (target.hasAttribute(RUN_MODAL_NEW_MISSED_POLICY_ATTR)) {
      const value = target.value ?? '';
      if (isMissedSchedulePolicy(value)) setNewMissedPolicy(value);
      return;
    }
    if (target.hasAttribute(RUN_MODAL_MISSED_POLICY_ATTR)) {
      const ruleId = target.getAttribute?.(RUN_MODAL_RULE_ID_ATTR) ?? '';
      const value = target.value ?? '';
      if (ruleId !== '' && isMissedSchedulePolicy(value)) {
        void setMissedPolicy(ruleId, value);
      }
      return;
    }
    if (target.hasAttribute(RUN_MODAL_PRESET_ATTR)) {
      state = {
        ...state,
        preset_expression: target.value ?? '',
        schedule_error: null,
      };
      overlay.querySelector?.(`[${RUN_MODAL_SCHEDULE_ERROR_ATTR}]`)?.remove();
      return;
    }
    // D-215 slice 5 — the Repeat toggle repaints (it swaps the control),
    // unlike the preset which is captured silently.
    if (target.hasAttribute(RUN_MODAL_REPEAT_ATTR)) {
      const repeatFocus = captureFocusIdentity();
      state = {
        ...state,
        repeat: (target as unknown as { checked?: boolean }).checked === true,
        schedule_error: null,
      };
      paint(repeatFocus);
      return;
    }
    if (target.hasAttribute(RUN_MODAL_RUN_AT_ATTR)) {
      state = {
        ...state,
        run_at_local: target.value ?? '',
        schedule_error: null,
      };
      overlay.querySelector?.(`[${RUN_MODAL_SCHEDULE_ERROR_ATTR}]`)?.remove();
      return;
    }
    // D-315 §5.1 — the "A mail fact" form. A new kind, a value added to watch
    // or a new "only when" changes the controls, so those repaint; the rest
    // are kept in place (an unticked value stays shown until then, to tick
    // again). What was watched and filtered belongs to the kind it was for.
    if (target.hasAttribute(RUN_MODAL_FACT_ATTR)) {
      const control = target.getAttribute(RUN_MODAL_FACT_ATTR) ?? '';
      const value = target.value ?? '';
      const draft = state.mail_fact;
      if (control === 'type') {
        if (value === draft.type) return;
        state = { ...state, mail_fact: { ...EMPTY_MAIL_FACT_DRAFT, type: value }, trigger_error: null };
        paint(captureFocusIdentity());
      } else if (control === 'field-add') {
        if (value === '' || draft.fields.includes(value)) return;
        state = { ...state, mail_fact: { ...draft, fields: [...draft.fields, value] }, trigger_error: null };
        paint(captureFocusIdentity());
      } else if (control === 'where-variable') {
        if (value === draft.where_variable) return;
        state = { ...state, mail_fact: { ...draft, where_variable: value, where_value: '' }, trigger_error: null };
        paint(captureFocusIdentity());
      } else if (control === 'where-value') {
        state = { ...state, mail_fact: { ...draft, where_value: value }, trigger_error: null };
      } else if (control === 'template') {
        state = { ...state, mail_fact: { ...draft, template_id: value } };
      } else if (control.startsWith('field:')) {
        const name = control.slice('field:'.length);
        const on = (target as unknown as { checked?: boolean }).checked === true;
        const fields = draft.fields.filter((field) => field !== name);
        state = { ...state, mail_fact: { ...draft, fields: on ? [...fields, name] : fields } };
      }
      overlay.querySelector?.(`[${RUN_MODAL_TRIGGER_ERROR_ATTR}]`)?.remove();
      return;
    }
    // Trigger pattern (R21) — in place (caret preserved); the Add button's
    // empty-pattern disable flips live, mirroring refreshRunGate.
    if (target.hasAttribute(RUN_MODAL_PATTERN_ATTR)) {
      state = {
        ...state,
        pattern_text: target.value ?? '',
        trigger_error: null,
      };
      overlay.querySelector?.(`[${RUN_MODAL_TRIGGER_ERROR_ATTR}]`)?.remove();
      const addButton = overlay.querySelector?.(
        `[${RUN_MODAL_ACTION_ATTR}="add-trigger"]`,
      ) as HTMLButtonElement | null | undefined;
      if (addButton) {
        addButton.disabled =
          state.trigger_mutating || state.pattern_text.trim().length === 0;
      }
      return;
    }
    // Advanced raw-JSON textarea — a direct edit of config_text.
    if (target.hasAttribute(RUN_MODAL_CONFIG_ATTR)) {
      state = { ...state, config_text: target.value ?? '' };
      refreshRunGate();
      return;
    }
    // Context-target input (design § 8) — in-place, gate refresh flips Run.
    if (target.hasAttribute(RUN_MODAL_TARGET_ATTR)) {
      const key = target.getAttribute(RUN_MODAL_TARGET_ATTR) ?? '';
      if (key.length > 0) {
        state = {
          ...state,
          target_values: { ...state.target_values, [key]: target.value ?? '' },
        };
        refreshRunGate();
      }
      return;
    }
    // Variable-widget edit — merge into config_text + keep the advanced
    // textarea in sync, both in place (caret preserved).
    const varKey = target.dataset?.varKey;
    if (varKey !== undefined && varKey.length > 0) {
      setVariableConfig(varKey, readWidgetValue(target));
    }
  }

  const setVariableConfig = (key: string, value: unknown): void => {
    let cfg: Record<string, unknown> = {};
    try {
      cfg = parseRunConfig(state.config_text);
    } catch {
      cfg = {};
    }
    cfg[key] = value;
    const text = JSON.stringify(cfg, null, 2);
    state = { ...state, config_text: text };
    const ta = overlay.querySelector?.(
      `[${RUN_MODAL_CONFIG_ATTR}]`,
    ) as HTMLTextAreaElement | null | undefined;
    if (ta) ta.value = text;
    refreshRunGate();
  };

  /** Attach name→id pickers to the shells emitted for `record_ref`,
   * `file_ref`, and `file_ref[]` variables.
   * Fake/string-only DOMs have no parsed shells and simply keep the pure
   * renderer coverage; browsers attach one picker per active modal surface. */
  function mountVariablePickers(): void {
    if (typeof overlay.querySelector !== 'function') return;
    let config: Record<string, unknown> = {};
    try {
      config = parseRunConfig(shownConfigText());
    } catch {
      config = {};
    }
    if (opts.recordRefSearch !== undefined) {
      refPickers.push(...wireRecordRefVariables(overlay, {
        variables: opts.recipe.recipe.variables ?? {},
        values: config,
        idPrefix: 'run-modal-var',
        search: opts.recordRefSearch,
        onChange: setVariableConfig,
      }));
    }
    if (opts.fileRefSearch === undefined) return;
    const fileRefSearch = opts.fileRefSearch;
    for (const [key, def] of Object.entries(opts.recipe.recipe.variables ?? {})) {
      if (
        def === null
        || typeof def !== 'object'
        || Array.isArray(def)
        || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)
      ) continue;
      const hintType = (def as { type?: unknown }).type;

      // D-215 slice 5 residual — the ORDERED list row. Dispatched on the
      // DECLARED type (§ 4.6): the control follows the variable's type, never
      // the recipe, so no pack ever needs special-casing here.
      if (hintType === 'file_ref[]') {
        const list = wireFileRefArray(overlay, {
          key,
          label: String((def as { label?: unknown }).label ?? key),
          idPrefix: 'run-modal-var',
          search: fileRefSearch,
          initialIds: toFileRefIds(
            Object.prototype.hasOwnProperty.call(config, key)
              ? config[key]
              : (def as { default?: unknown }).default,
          ),
          onChange: (ids) => { setVariableConfig(key, ids); },
        });
        if (list !== null) fileRefArrays.push(list);
        continue;
      }

      if (hintType !== 'file_ref') continue;
      const pickerId = fileRefVariablePickerId(key, 'run-modal-var');
      if (overlay.querySelector(`[data-ref-picker="${pickerId}"]`) === null) continue;
      const raw = Object.prototype.hasOwnProperty.call(config, key)
        ? config[key]
        : (def as { default?: unknown }).default;
      const initialValue = typeof raw === 'string' && raw.length > 0
        ? { id: raw, label: raw }
        : null;
      const hidden = overlay.querySelector(
        `[${FILE_REF_VARIABLE_ATTR}="${key}"] [data-var-key="${key}"][data-var-type="file_ref"]`,
      ) as HTMLInputElement | null;
      refPickers.push(wireRefPicker(overlay, {
        search: opts.fileRefSearch,
        config: {
          pickerId,
          placeholder: 'Search files',
          ariaLabel: `Choose ${(def as { label?: unknown }).label ?? key}`,
          emptyText: 'No matching files.',
        },
        minChars: 0,
        initialValue,
        onChange: (selection) => {
          const value = selection?.id ?? '';
          if (hidden !== null) hidden.value = value;
          setVariableConfig(key, value);
        },
      }));
    }
  }

  function onKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      if (ev.isComposing) return;
      close();
      return;
    }
    const start = ev.target as Element | null;
    const current = start?.closest?.(`[${RUN_MODAL_TAB_ATTR}]`);
    if (current === null || current === undefined) return;
    const tabs = Array.from(
      overlay.querySelectorAll?.(`[${RUN_MODAL_TAB_ATTR}]`) ?? [],
    ) as HTMLElement[];
    const currentIndex = tabs.indexOf(current as HTMLElement);
    if (currentIndex < 0 || tabs.length === 0) return;
    let nextIndex: number | null = null;
    if (ev.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % tabs.length;
    } else if (ev.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    } else if (ev.key === 'Home') {
      nextIndex = 0;
    } else if (ev.key === 'End') {
      nextIndex = tabs.length - 1;
    }
    if (nextIndex === null) return;
    const next = tabs[nextIndex]?.getAttribute(RUN_MODAL_TAB_ATTR);
    if (next !== 'run' && next !== 'schedule' && next !== 'trigger') return;
    ev.preventDefault();
    setTab(next, true);
  }

  // Imperative controls — mirror the user-facing edits so a host can
  // drive the modal (and the fake-doc tests can exercise it without
  // dispatching DOM events).
  function setTab(tab: RunModalTab, focus = false): void {
    if (state.tab === tab) return;
    state = { ...state, tab };
    paint(focus ? { kind: 'action', value: `tab:${tab}` } : null);
    if (tab === 'schedule' && state.schedules === null && caps.canSchedule) {
      void loadSchedules();
    }
    if (tab === 'trigger' && state.triggers === null && caps.canTrigger) {
      void loadTriggers();
    }
  }
  // Imperative setters are PROGRAMMATIC (host prefill / tests), not the
  // user-type path — so they repaint to keep the visible controls in sync
  // with state (recipes-route parity: `setRunConfigText` calls render()).
  // The live caret-preserving in-place path is `onInput` + `refreshRunGate`.
  const setConfigText = (text: string): void => {
    state = { ...state, config_text: text };
    paint();
  };
  /** D-319 — changes typed for one run are that run's alone: another dish
   *  starts from its own settings. */
  function setDish(dish_id: string | null): void {
    if (state.executing || state.dish_id === dish_id) return;
    if (dish_id !== null && !(opts.dishes ?? []).some((dish) => dish.dish_id === dish_id)) return;
    state = { ...state, dish_id, config_text: '{}', run_error: null };
    paint({ kind: 'id', value: 'run-modal-dish', selectionStart: null, selectionEnd: null });
  }
  const setTargetValue = (key: string, value: string): void => {
    state = {
      ...state,
      target_values: { ...state.target_values, [key]: value },
    };
    paint();
  };
  const setContextValues = (context: Record<string, unknown>): void => {
    state = { ...state, context_values: { ...context } };
    paint();
  };
  const setPreset = (expression: string): void => {
    state = { ...state, preset_expression: expression };
    paint();
  };
  const setPatternText = (text: string): void => {
    state = { ...state, pattern_text: text };
    paint();
  };

  /** D-215 slice 5 — the Repeat toggle, host/test-drivable like setPreset.
   *  Repaints, because it swaps which control is shown. */
  const setRepeat = (repeat: boolean): void => {
    state = { ...state, repeat, schedule_error: null };
    paint();
  };

  /** D-215 slice 5 — the one-shot fire time, as the datetime-local control
   *  reports it (a zone-less wall clock; `addSchedule` resolves it against
   *  the browser's zone before it travels). */
  const setRunAtLocal = (value: string): void => {
    state = { ...state, run_at_local: value };
  };

  overlay.addEventListener('click', onClick);
  overlay.addEventListener('input', onInput);
  overlay.addEventListener('change', onInput);
  doc.addEventListener('keydown', onKeydown);

  paint();
  // Tab focus-trap + focus-restore-on-release. The container is the stable
  // overlay (its `panel` is recreated on each `paint()`, so the trap re-walks it
  // on every Tab rather than caching). Focus-in is DEFERRED: the host portals
  // `element` into the document synchronously AFTER wireRunModal returns, so
  // focusing the panel now (while detached) would no-op — fire it on the next
  // microtask, by when it is mounted.
  armModalTrap();
  void Promise.resolve().then(() => {
    if (!destroyed) trap?.focusInitial();
  });
  // Load schedules eagerly ONLY when opening on the Schedule tab; opening
  // to Run never costs a `schedules.list`. A later tab switch lazy-loads.
  if (caps.canSchedule && state.tab === 'schedule') void loadSchedules();
  if (caps.canTrigger && state.tab === 'trigger') void loadTriggers();

  return {
    element: overlay,
    getState: () => state,
    setTab,
    setDish,
    setConfigText,
    setTargetValue,
    setContextValues,
    setPreset,
    setRepeat,
    setRunAtLocal,
    confirmRun,
    addSchedule,
    reviewSchedule,
    toggleSchedule,
    setMissedPolicy,
    setNewMissedPolicy,
    removeSchedule,
    setPatternText,
    setTriggerKind: (kind) => {
      state = { ...state, trigger_kind: kind, trigger_error: null };
      paint(captureFocusIdentity());
      if (kind === 'mail_fact') void loadMailFactTemplates();
    },
    setMailFact: (draft) => {
      state = { ...state, mail_fact: { ...state.mail_fact, ...draft }, trigger_error: null };
      paint(captureFocusIdentity());
    },
    addTrigger,
    toggleTrigger,
    removeTrigger,
    hasInFlightWork: () =>
      !destroyed && (state.executing || state.mutating || state.trigger_mutating),
    destroy: detach,
  };
};
