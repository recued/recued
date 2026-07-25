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
} from '@recued/contracts';

import {
  FILE_REF_VARIABLE_ATTR,
  fileRefVariablePickerId,
  readWidgetValue,
} from '../variable-widgets.js';
import {
  REF_PICKER_STYLES,
  wireRefPicker,
  type RefPickerHandle,
} from '../ref-picker/index.js';
import {
  wireConfigEditorOverlay,
  type ConfigEditorOverlayHandle,
} from '../config-editor-overlay.js';

import {
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
  RUN_MODAL_PATTERN_ATTR,
  RUN_MODAL_PRESET_ATTR,
  RUN_MODAL_RULE_ID_ATTR,
  RUN_MODAL_TARGET_ATTR,
  RUN_MODAL_TARGET_WARNING_ATTR,
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

const RUN_MODAL_STYLES_MARKER = 'data-recued-run-modal-styles';

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const injectStyles = (doc: Document): void => {
  if (doc.head.querySelector(`style[${RUN_MODAL_STYLES_MARKER}]`) !== null) {
    return;
  }
  const style = doc.createElement('style');
  style.setAttribute(RUN_MODAL_STYLES_MARKER, '');
  style.textContent = `${RUN_MODAL_STYLES}\n${REF_PICKER_STYLES}`;
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
    canTrigger: opts.triggersList !== undefined,
    canPickFiles: opts.fileRefSearch !== undefined,
  };
  const firstPreset = CRON_PRESETS[0]?.expression ?? '';
  let state: RunModalState = initialRunModalState(
    opts.initialTab ?? 'run',
    firstPreset,
  );
  let destroyed = false;
  // Assigned after the first paint (the panel must exist to focus into); the
  // trap traps Tab within the overlay + restores focus to the opener on detach.
  let trap: FocusTrapHandle | null = null;
  // D-179 — the per-row config editor overlay (Schedule/Trigger tabs), a
  // shared component opened over the modal. It owns its own focus trap; the
  // modal's trap is released while it's open and re-armed on close.
  let configEditorHandle: ConfigEditorOverlayHandle | null = null;
  let fileRefPickers: RefPickerHandle[] = [];

  const overlay = doc.createElement('div');
  overlay.className = 'run-modal-overlay-root';

  // Arm the modal's Tab focus-trap on the stable overlay. Extracted so the
  // per-row config editor can release it while open and re-arm on close.
  const armModalTrap = (): void => {
    trap = wireFocusTrap({
      document: doc,
      getContainer: () => overlay,
      initialFocus: false,
    });
  };

  const paint = (): void => {
    if (destroyed) return;
    for (const picker of fileRefPickers) picker.destroy();
    fileRefPickers = [];
    overlay.innerHTML = renderRunModal(state, opts.recipe, caps);
    mountFileRefPickers();
  };

  // Targeting guard (design § 8) — live half: recompute the gate and flip
  // the Run button + warning in place (no re-paint, so the active field
  // keeps its caret). Render-time state stays authoritative.
  const refreshRunGate = (): void => {
    if (state.tab !== 'run') return;
    const gate = runTargetGate(
      opts.recipe.recipe,
      state.config_text,
      state.target_values,
      state.context_values,
    );
    const runButton = overlay.querySelector?.(
      `[${RUN_MODAL_ACTION_ATTR}="confirm-run"]`,
    ) as HTMLButtonElement | null | undefined;
    if (runButton) {
      runButton.disabled = state.executing || !caps.canExecute || !gate.assessment.ok;
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
            ? ' You can also run it from chat — the AI resolves the record for you.'
            : '');
      }
    }
  };

  const detach = (): void => {
    if (destroyed) return;
    destroyed = true;
    for (const picker of fileRefPickers) picker.destroy();
    fileRefPickers = [];
    overlay.removeEventListener('click', onClick);
    overlay.removeEventListener('input', onInput);
    overlay.removeEventListener('change', onInput);
    doc.removeEventListener('keydown', onKeydown);
    overlay.remove();
    // Tear down an open per-row config editor with the modal (its `onClose`
    // sees `destroyed` and skips re-arming the trap).
    configEditorHandle?.destroy();
    configEditorHandle = null;
    // Detach the Tab-trap's keydown + restore focus to the opener.
    trap?.release();
  };

  const close = (): void => {
    detach();
    opts.onClose?.();
  };

  const confirmRun = async (): Promise<void> => {
    // Guard a double-run — the rendered Run button is disabled while
    // executing, but the imperative path has no such gate.
    if (state.executing) return;
    if (!caps.canExecute || opts.execute === undefined) {
      state = { ...state, run_error: 'Running is not available on this server yet.' };
      paint();
      return;
    }
    let config: Record<string, unknown>;
    try {
      config = parseRunConfig(state.config_text);
    } catch (err) {
      state = { ...state, run_error: errMessage(err) };
      paint();
      return;
    }
    // Belt to the render-time disable: a targeted run with its target still
    // missing never dispatches (the server guard would block it anyway).
    const gate = runTargetGate(
      opts.recipe.recipe,
      state.config_text,
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
      paint();
      return;
    }
    state = { ...state, executing: true, run_error: null, result: null };
    paint();
    try {
      const result = await opts.execute({
        recipe_id: opts.recipe.recipe_id,
        config,
        ...(Object.keys(gate.context).length > 0 ? { context: gate.context } : {}),
      });
      if (destroyed) return;
      state = { ...state, executing: false, result };
      paint();
      opts.onRan?.(result);
    } catch (err) {
      if (destroyed) return;
      state = { ...state, executing: false, run_error: errMessage(err) };
      paint();
    }
  };

  const loadSchedules = async (): Promise<void> => {
    if (opts.schedulesList === undefined) return;
    try {
      const { schedules } = await opts.schedulesList();
      if (destroyed) return;
      state = {
        ...state,
        schedules: recipeSchedules(schedules, opts.recipe.recipe_id),
      };
      paint();
    } catch (err) {
      if (destroyed) return;
      state = { ...state, schedules: [], schedule_error: errMessage(err) };
      paint();
    }
  };

  const runScheduleMutation = async (
    fn: () => Promise<unknown>,
  ): Promise<void> => {
    state = { ...state, mutating: true, schedule_error: null };
    paint();
    try {
      await fn();
      if (destroyed) return;
      state = { ...state, mutating: false };
      await loadSchedules();
    } catch (err) {
      if (destroyed) return;
      state = { ...state, mutating: false, schedule_error: errMessage(err) };
      paint();
    }
  };

  const scheduleNotWired = (): Promise<void> => {
    state = {
      ...state,
      schedule_error: 'Scheduling is not available on this server yet.',
    };
    paint();
    return Promise.resolve();
  };

  const addSchedule = (): Promise<void> => {
    const create = opts.schedulesCreate;
    if (create === undefined) return scheduleNotWired();
    // Parity with the recipes route: an empty preset never creates a row.
    if (state.preset_expression.length === 0) return Promise.resolve();
    let overlay: Record<string, unknown>;
    try {
      overlay = parseRunConfig(state.config_text);
    } catch (err) {
      // Invalid config JSON (only reachable via the Run tab's advanced
      // field, which shares this buffer) — surface it like confirmRun
      // rather than silently arming with recipe defaults.
      state = { ...state, schedule_error: errMessage(err) };
      paint();
      return Promise.resolve();
    }
    return runScheduleMutation(() =>
      create({
        recipe_id: opts.recipe.recipe_id,
        // Default to the installed recipe's publisher (recipes-route
        // parity); `opts.publisherId` overrides when a host needs it.
        publisher_id: opts.publisherId ?? opts.recipe.publisher_id,
        cron_expression: state.preset_expression,
        ...(Object.keys(overlay).length > 0 ? { config_overlay: overlay } : {}),
      }),
    );
  };

  const toggleSchedule = (ruleId: string, to: boolean): Promise<void> => {
    const update = opts.schedulesUpdate;
    if (update === undefined) return scheduleNotWired();
    return runScheduleMutation(() => update({ schedule_id: ruleId, enabled: to }));
  };

  const removeSchedule = (ruleId: string): Promise<void> => {
    const del = opts.schedulesDelete;
    if (del === undefined) return scheduleNotWired();
    return runScheduleMutation(() => del({ schedule_id: ruleId }));
  };

  // ── R21 Trigger tab — mirrors the schedule half verbatim ──
  const loadTriggers = async (): Promise<void> => {
    if (opts.triggersList === undefined) return;
    try {
      const { triggers } = await opts.triggersList();
      if (destroyed) return;
      state = {
        ...state,
        triggers: recipeTriggers(triggers, opts.recipe.recipe_id),
      };
      paint();
    } catch (err) {
      if (destroyed) return;
      state = { ...state, triggers: [], trigger_error: errMessage(err) };
      paint();
    }
  };

  const runTriggerMutation = async (fn: () => Promise<unknown>): Promise<void> => {
    state = { ...state, trigger_mutating: true, trigger_error: null };
    paint();
    try {
      await fn();
      if (destroyed) return;
      state = { ...state, trigger_mutating: false };
      await loadTriggers();
    } catch (err) {
      if (destroyed) return;
      state = { ...state, trigger_mutating: false, trigger_error: errMessage(err) };
      paint();
    }
  };

  const triggerNotWired = (): Promise<void> => {
    state = {
      ...state,
      trigger_error: 'Event triggers are not available on this server yet.',
    };
    paint();
    return Promise.resolve();
  };

  const addTrigger = (): Promise<void> => {
    const create = opts.triggersCreate;
    if (create === undefined) return triggerNotWired();
    const pattern = state.pattern_text.trim();
    // An empty pattern never creates a row (the rendered Add is disabled;
    // this guards the imperative path).
    if (pattern.length === 0) return Promise.resolve();
    let overlay: Record<string, unknown>;
    try {
      overlay = parseRunConfig(state.config_text);
    } catch (err) {
      state = { ...state, trigger_error: errMessage(err) };
      paint();
      return Promise.resolve();
    }
    return runTriggerMutation(() =>
      create({
        recipe_id: opts.recipe.recipe_id,
        publisher_id: opts.publisherId ?? opts.recipe.publisher_id,
        pattern,
        ...(Object.keys(overlay).length > 0 ? { config_overlay: overlay } : {}),
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
    return runTriggerMutation(() => del({ trigger_id: ruleId }));
  };

  // ── D-179 per-row config editor (Schedule / Trigger tabs) ──
  const closeRowConfigEditor = (): void => {
    // `destroy()` fires the shared editor's `onClose`, which re-arms the
    // modal trap.
    configEditorHandle?.destroy();
  };

  const openRowConfigEditor = (
    section: 'schedule' | 'trigger',
    ruleId: string,
  ): void => {
    const row = section === 'schedule'
      ? state.schedules?.find((s) => s.schedule_id === ruleId)
      : state.triggers?.find((t) => t.trigger_id === ruleId);
    if (row === undefined || row === null) return;
    if (section === 'schedule' ? opts.schedulesUpdate === undefined
      : opts.triggersUpdate === undefined) return;
    closeRowConfigEditor();

    // Hand the focus trap to the editor: release the modal's trap so Tab
    // stays inside the editor; re-arm it on close (via `onClose`).
    trap?.release();
    trap = null;
    configEditorHandle = wireConfigEditorOverlay({
      document: doc,
      title: 'Config',
      copy: `These values apply to every ${
        section === 'schedule' ? 'scheduled' : 'triggered'
      } run.`,
      confirmLabel: 'Save',
      variables: opts.recipe.recipe.variables ?? {},
      currentOverlay: row.config_overlay ?? {},
      ...(opts.fileRefSearch !== undefined
        ? { fileRefSearch: opts.fileRefSearch }
        : {}),
      onConfirm: (config) => {
        if (section === 'schedule') {
          void runScheduleMutation(() =>
            opts.schedulesUpdate!({ schedule_id: ruleId, config_overlay: config }));
        } else {
          void runTriggerMutation(() =>
            opts.triggersUpdate!({ trigger_id: ruleId, config_overlay: config }));
        }
      },
      onClose: () => {
        configEditorHandle = null;
        if (!destroyed) armModalTrap();
      },
    });
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
    if (action === 'tab:run') {
      if (state.tab !== 'run') {
        state = { ...state, tab: 'run' };
        paint();
      }
      return;
    }
    if (action === 'tab:schedule') {
      if (state.tab !== 'schedule') {
        state = { ...state, tab: 'schedule' };
        paint();
        if (state.schedules === null && caps.canSchedule) void loadSchedules();
      }
      return;
    }
    if (action === 'tab:trigger') {
      if (state.tab !== 'trigger') {
        state = { ...state, tab: 'trigger' };
        paint();
        if (state.triggers === null && caps.canTrigger) void loadTriggers();
      }
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
    if (action === 'add-trigger') {
      void addTrigger();
      return;
    }
    const ruleId = actor.getAttribute(RUN_MODAL_RULE_ID_ATTR) ?? '';
    if (action === 'config-schedule') {
      openRowConfigEditor('schedule', ruleId);
      return;
    }
    if (action === 'config-trigger') {
      openRowConfigEditor('trigger', ruleId);
      return;
    }
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
    // Schedule preset — captured in state (not read at Add-click time) so a
    // re-paint mid-choice can't reset it. Selects emit input + change.
    if (target.hasAttribute(RUN_MODAL_PRESET_ATTR)) {
      state = { ...state, preset_expression: target.value ?? '' };
      return;
    }
    // Trigger pattern (R21) — in place (caret preserved); the Add button's
    // empty-pattern disable flips live, mirroring refreshRunGate.
    if (target.hasAttribute(RUN_MODAL_PATTERN_ATTR)) {
      state = { ...state, pattern_text: target.value ?? '' };
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

  /** Attach name→id pickers to the shells emitted for `file_ref` variables.
   * Fake/string-only DOMs have no parsed shells and simply keep the pure
   * renderer coverage; browsers attach one picker per active modal surface. */
  function mountFileRefPickers(): void {
    if (opts.fileRefSearch === undefined || typeof overlay.querySelector !== 'function') return;
    let config: Record<string, unknown> = {};
    try {
      config = parseRunConfig(state.config_text);
    } catch {
      config = {};
    }
    for (const [key, def] of Object.entries(opts.recipe.recipe.variables ?? {})) {
      if (
        def === null
        || typeof def !== 'object'
        || Array.isArray(def)
        || (def as { type?: unknown }).type !== 'file_ref'
        || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)
      ) continue;
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
      fileRefPickers.push(wireRefPicker(overlay, {
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
    if (ev.key === 'Escape') close();
  }

  // Imperative controls — mirror the user-facing edits so a host can
  // drive the modal (and the fake-doc tests can exercise it without
  // dispatching DOM events).
  const setTab = (tab: RunModalTab): void => {
    if (state.tab === tab) return;
    state = { ...state, tab };
    paint();
    if (tab === 'schedule' && state.schedules === null && caps.canSchedule) {
      void loadSchedules();
    }
    if (tab === 'trigger' && state.triggers === null && caps.canTrigger) {
      void loadTriggers();
    }
  };
  // Imperative setters are PROGRAMMATIC (host prefill / tests), not the
  // user-type path — so they repaint to keep the visible controls in sync
  // with state (recipes-route parity: `setRunConfigText` calls render()).
  // The live caret-preserving in-place path is `onInput` + `refreshRunGate`.
  const setConfigText = (text: string): void => {
    state = { ...state, config_text: text };
    paint();
  };
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
    setConfigText,
    setTargetValue,
    setContextValues,
    setPreset,
    confirmRun,
    addSchedule,
    toggleSchedule,
    removeSchedule,
    setPatternText,
    addTrigger,
    toggleTrigger,
    removeTrigger,
    destroy: detach,
  };
};
