/** D-149 § A.20.1 — Settings → Server → Reception "Set up Reception"
 *  Launch Wizard mount + working-config container.
 *
 *  `reception-launch-wizard.ts` is the projection layer
 *  (`buildLaunchWizardStepperModel` / `summarizeLaunchWizardValidation`
 *  / `buildLaunchWizardPlanModel` / `buildLaunchWizardDispatchPlan`) and
 *  `reception-launch-wizard-render.ts` is the pure frame renderer
 *  (`renderLaunchWizard`). Both are substrate. **This is the stateful
 *  piece they were built for: the wizard's step-cursor + per-step
 *  working-config container.** It holds the four config-editing steps'
 *  working configs + the step cursor + the `include_drop_link` decision
 *  + the exposure-profile id, wires the renderer's `data-action` +
 *  `data-field-*` markup, runs `summarizeLaunchWizardValidation` on
 *  finish, and fires `buildLaunchWizardDispatchPlan` →
 *  `shell.runLaunchWizard` for the § A.20.1 first-run flow.
 *
 *  ── The wizard is chrome; the per-step content is the slot ─────────
 *  `renderLaunchWizard` owns the *frame* (stepper, validation gate,
 *  navigation, plan preview) and emits the current step's content as an
 *  empty `data-wizard-step` slot the host fills. The wizard mount is
 *  that host:
 *    - the four config-editing steps (`reception_page` / `scheduling_link`
 *      / `intake_form` / `drop_link`) embed `renderAuthoringForm` over
 *      the matching working config — the SAME per-kind authoring forms
 *      `mountAuthoringForm` drives, sharing every bit of the
 *      `reception-authoring-mount.ts` working-config machinery
 *      (`seedWorkingConfig` / `buildAuthoringView` / `applyFieldDelegateEvent`
 *      / `addRepeaterRow` / `removeRepeaterRow` / `attachFieldDelegator`);
 *    - the three non-config steps (`profile_check` / `view_as_visitor` /
 *      `share`) are other satellites' surfaces with no mount yet — the
 *      wizard exposes the `renderStepContent` host seam for those.
 *  The embedded authoring forms keep their own `reception-form-*` action
 *  bar in the markup, but it is inert inside the wizard (the wizard's
 *  action dispatcher has no handler for submit / preview / cancel — the
 *  wizard's Next / Finish / Cancel are the real controls) AND hidden by
 *  `LAUNCH_WIZARD_MOUNT_STYLES`.
 *
 *  ── Slot fill = string injection, not DOM query ───────────────────
 *  `renderCurrentStep` emits exactly one current-step slot per render.
 *  The mount string-injects content into that slot rather than
 *  `host.querySelector`-ing it, so the mount stays testable under the
 *  DOM-free fake-host pattern every Reception mount test uses.
 *
 *  ── What the wizard owns vs forwards ──────────────────────────────
 *  Owns: step cursor (`next` / `prev` / `goto-step`), the
 *  `include_drop_link` toggle, the four working configs + their field
 *  edits + repeater editing, the finish flow (validate →
 *  `buildLaunchWizardPlan` → `buildLaunchWizardDispatchPlan` →
 *  `shell.runLaunchWizard`), cancel. Forwards: `switch-profile` — the
 *  wizard owns no exposure-profile dispatch (per the renderer's
 *  contract); the host bridges it to D-148's exposure rpc via
 *  `onSwitchProfile`.
 *
 *  Spec: docs/d-149-spec.md § A.20.1 (Reception Launch Wizard) + § DoD
 *  (the under-10-minute, 3-endpoint onboarding goal). */

import { e } from '@recued/ui-shared/template';
import { createActionDispatcher } from '@recued/ui-shared/action-dispatcher';

import {
  LAUNCH_WIZARD_STEP_SET,
  type DropLinkConfig,
  type IntakeFormConfig,
  type LaunchWizardInput,
  type LaunchWizardStepId,
  type ReceptionPageConfig,
  type SchedulingLinkConfig,
} from '@recued/contracts';

import {
  buildLaunchWizardDispatchPlan,
  buildLaunchWizardPlan,
  buildLaunchWizardPlanModel,
  buildLaunchWizardStepperModel,
  summarizeLaunchWizardValidation,
  type LaunchWizardStepperModel,
  type LaunchWizardValidationSummary,
} from './reception-launch-wizard.js';
import {
  renderLaunchWizard,
  type LaunchWizardAction,
  type LaunchWizardRenderView,
} from './reception-launch-wizard-render.js';
import { renderAuthoringForm } from './reception-authoring-render.js';
import {
  addRepeaterRow,
  applyFieldDelegateEvent,
  attachFieldDelegator,
  buildAuthoringView,
  removeRepeaterRow,
  seedWorkingConfig,
  type FieldDelegateEvent,
} from './reception-authoring-mount.js';
import type {
  LaunchWizardRunResult,
  ReceptionPageShell,
} from './reception-page-shell.js';

// ════════════════════════════════════════════════════════════════
// Config-editing steps
// ════════════════════════════════════════════════════════════════

/** The four wizard steps that edit a per-kind config — exactly
 *  `LAUNCH_WIZARD_PLAN_STEP_SET`, and every member is also a
 *  `ReceptionEndpointKind`, so a config step id doubles as the kind
 *  argument to the shared working-config machinery. */
type WizardConfigStep =
  | 'reception_page'
  | 'scheduling_link'
  | 'intake_form'
  | 'drop_link';

const isConfigStep = (step: LaunchWizardStepId): step is WizardConfigStep =>
  step === 'reception_page' ||
  step === 'scheduling_link' ||
  step === 'intake_form' ||
  step === 'drop_link';

const isLaunchWizardStepId = (value: string): value is LaunchWizardStepId =>
  (LAUNCH_WIZARD_STEP_SET as ReadonlySet<string>).has(value);

/** Every `data-action` the wizard mount's dispatcher handles — the
 *  `LaunchWizardAction` frame controls plus the two repeater-editing
 *  actions the embedded authoring forms emit. The embedded forms' other
 *  `reception-form-*` actions (submit / preview / cancel) have no
 *  handler here — they are inert inside the wizard by design. */
type WizardMountAction =
  | LaunchWizardAction
  | 'reception-form-add-row'
  | 'reception-form-remove-row';

// ════════════════════════════════════════════════════════════════
// mountLaunchWizard
// ════════════════════════════════════════════════════════════════

/** Options for `mountLaunchWizard`. */
export interface LaunchWizardMountOptions {
  /** Host element the wizard is rendered into — replaced on every
   *  re-render, cleared on `dispose()`. */
  host: HTMLElement;
  /** The page shell — the finish flow fires `shell.runLaunchWizard`. */
  shell: ReceptionPageShell;
  /** The server's current exposure profile id — feeds the wizard input's
   *  `current_exposure_profile` (the planner flags `profile_switch_needed`
   *  when it is not the recommended one) + the step-1 profile gate. */
  exposureProfile: string;
  /** Optional per-kind seed configs for the four config-editing steps —
   *  omitted / `null` ⇒ a fresh default config (the step starts blank).
   *  Accepts either typed contract configs or plain working objects. */
  initialConfigs?: {
    reception_page?: object | null;
    scheduling_link?: object | null;
    intake_form?: object | null;
    drop_link?: object | null;
  };
  /** Starting step — defaults to `profile_check` (the § A.20.1 step 1). */
  initialStep?: LaunchWizardStepId;
  /** Whether the optional `drop_link` step is part of this run —
   *  defaults to `true`. The user flips it via the step's toggle. */
  includeDropLink?: boolean;
  /** Called after a successful finish (the ordered `runLaunchWizard`
   *  plan landed) and on cancel — the host unmounts the wizard.
   *
   *  A successful **finish** passes its `LaunchWizardRunResult` — each
   *  `created[].result` carries the one-shot `share_url_once` the
   *  substrate never re-surfaces (the page shell does NOT auto-cache
   *  it). The host must register them via `shell.setEndpointShare` so
   *  the § A.20.1 Share step / a later detail view can draw the Share
   *  Cards for the endpoints the wizard just created. Cancel passes no
   *  result. */
  onClose?: (result?: LaunchWizardRunResult) => void;
  /** `reception-wizard-switch-profile` forward — the wizard owns no
   *  exposure-profile dispatch; the host bridges it to D-148's exposure
   *  rpc. */
  onSwitchProfile?: () => void;
  /** Fill the per-step content slot for the three non-config-editing
   *  steps (`profile_check` / `view_as_visitor` / `share`) — other
   *  satellites' surfaces with no mount yet. Returns the slot HTML (the
   *  host owns its escaping) or `null` for an empty slot. The four
   *  config-editing steps are filled by the wizard itself with
   *  `renderAuthoringForm`. */
  renderStepContent?: (stepId: LaunchWizardStepId) => string | null;
  /** Clock seam — feeds `buildLaunchWizardPlan` + `buildLaunchWizardPlanModel`.
   *  Defaults to `Date.now`. */
  now?: () => number;
}

/** Mounted Launch Wizard handle. */
export interface LaunchWizardMount {
  /** Re-render from the current cursor + working configs. */
  update(): void;
  /** Detach both dispatchers + clear the host. Idempotent. */
  dispose(): void;
}

/** Mount the Reception Launch Wizard into a host element. Holds the four
 *  config-editing steps' working configs + the step cursor + the
 *  `include_drop_link` decision, renders the frame via `renderLaunchWizard`
 *  with the current config-step's `renderAuthoringForm` injected into the
 *  content slot, and drives:
 *    - **navigation** (`next` / `prev` / `goto-step`) — moves the cursor
 *      + re-renders;
 *    - **the drop-link toggle** — flips `include_drop_link` + re-renders;
 *    - **the embedded authoring forms' field edits + repeater editing** —
 *      mutates the active step's working config (field edits silent,
 *      repeater add / remove re-render), via the shared
 *      `reception-authoring-mount.ts` machinery;
 *    - **switch-profile** — forwards to `onSwitchProfile`;
 *    - **finish** — `summarizeLaunchWizardValidation`; if valid,
 *      `buildLaunchWizardPlan` → `buildLaunchWizardDispatchPlan` →
 *      `shell.runLaunchWizard`; if invalid, re-renders the validation
 *      gate;
 *    - **cancel** — calls `onClose`.
 *
 *  The live plan preview + step-1 profile gate appear automatically once
 *  the four working configs validate clean (`render` rebuilds the plan
 *  model every pass). The post-finish validation summary is the single
 *  error surface — the embedded authoring forms render with no per-form
 *  validation summary inside the wizard. */
export const mountLaunchWizard = (
  opts: LaunchWizardMountOptions,
): LaunchWizardMount => {
  const { host, shell } = opts;
  const now = opts.now ?? ((): number => Date.now());

  let currentStep: LaunchWizardStepId = opts.initialStep ?? 'profile_check';
  let includeDropLink = opts.includeDropLink ?? true;
  const configs: Record<WizardConfigStep, Record<string, unknown>> = {
    reception_page: seedWorkingConfig(
      'reception_page',
      opts.initialConfigs?.reception_page ?? null,
    ),
    scheduling_link: seedWorkingConfig(
      'scheduling_link',
      opts.initialConfigs?.scheduling_link ?? null,
    ),
    intake_form: seedWorkingConfig(
      'intake_form',
      opts.initialConfigs?.intake_form ?? null,
    ),
    drop_link: seedWorkingConfig(
      'drop_link',
      opts.initialConfigs?.drop_link ?? null,
    ),
  };
  // `null` until the user clicks Finish — a `null` validation leaves
  // Finish enabled + the gate hidden (the renderer's contract). A failed
  // finish sets it; the first subsequent field edit clears it.
  let validation: LaunchWizardValidationSummary | null = null;
  let disposed = false;
  let lastHtml = '';

  const currentStepper = (): LaunchWizardStepperModel =>
    buildLaunchWizardStepperModel({
      current_step: currentStep,
      include_drop_link: includeDropLink,
    });

  /** Assemble the contract `LaunchWizardInput` from the four working
   *  configs + the exposure profile. `drop_link` is included only when
   *  the optional step is part of this run (the contract field is
   *  optional + `buildLaunchWizardPlan` conditionally drafts it). The
   *  configs are seeded complete by `seedWorkingConfig`, so the casts
   *  are shape-safe; `summarizeLaunchWizardValidation` re-checks anyway. */
  const buildWizardInput = (): LaunchWizardInput => ({
    current_exposure_profile: opts.exposureProfile,
    reception_page: configs.reception_page as unknown as ReceptionPageConfig,
    scheduling_link: configs.scheduling_link as unknown as SchedulingLinkConfig,
    intake_form: configs.intake_form as unknown as IntakeFormConfig,
    ...(includeDropLink
      ? { drop_link: configs.drop_link as unknown as DropLinkConfig }
      : {}),
  });

  /** The current step's content slot fill — `renderAuthoringForm` for a
   *  config-editing step (no per-form validation summary: the wizard's
   *  gate is the single error surface), the host seam for the rest. */
  const stepContentFor = (stepId: LaunchWizardStepId): string | null => {
    if (isConfigStep(stepId)) {
      // Every endpoint the wizard provisions is created fresh ⇒ isNew.
      return renderAuthoringForm(buildAuthoringView(stepId, configs[stepId], null, true));
    }
    return opts.renderStepContent?.(stepId) ?? null;
  };

  /** Inject content into the renderer's empty `data-wizard-step` slot —
   *  see the module docstring on why this is a string replace, not a
   *  DOM query. The renderer emits exactly one current-step slot, so the
   *  first (and only) marker match is the right one. */
  const injectStepContent = (
    frameHtml: string,
    stepId: LaunchWizardStepId,
    content: string,
  ): string => {
    const marker = `class="reception-wizard-step-slot" data-wizard-step="${e(stepId)}"></div>`;
    const filled = `class="reception-wizard-step-slot" data-wizard-step="${e(stepId)}">${content}</div>`;
    return frameHtml.replace(marker, filled);
  };

  const render = (): void => {
    if (disposed) return;
    const stepper = currentStepper();
    const resolved = stepper.current_step;
    const input = buildWizardInput();
    // The live plan model + step-1 profile gate appear as soon as the
    // four working configs validate clean — `summarizeLaunchWizardValidation`
    // takes `unknown` + never throws, so a mid-edit partial config just
    // yields `valid: false` ⇒ no plan.
    const liveValidation = summarizeLaunchWizardValidation(input);
    const at = now();
    const planModel = liveValidation.valid
      ? buildLaunchWizardPlanModel({ plan: buildLaunchWizardPlan(input, at), now: at })
      : null;
    const view: LaunchWizardRenderView = { stepper, validation, plan: planModel };
    let html = renderLaunchWizard(view);
    const content = stepContentFor(resolved);
    if (content !== null) html = injectStepContent(html, resolved, content);
    if (html === lastHtml) return;
    host.innerHTML = html;
    lastHtml = html;
  };

  const swallow = (promise: Promise<unknown>): void => {
    void promise.catch(() => {});
  };

  // Field edits mutate the active config-step's working config silently —
  // the DOM input already shows the typed value. The one re-render: the
  // first edit after a failed finish clears the stale validation gate.
  const onFieldEdit = (event: FieldDelegateEvent): void => {
    const resolved = currentStepper().current_step;
    if (!isConfigStep(resolved)) return;
    applyFieldDelegateEvent(resolved, configs[resolved], event);
    if (validation !== null) {
      validation = null;
      render();
    }
  };

  const handlers = {
    'reception-wizard-next': () => {
      const next = currentStepper().next_step;
      if (next !== null) {
        currentStep = next;
        render();
      }
    },
    'reception-wizard-prev': () => {
      const prev = currentStepper().prev_step;
      if (prev !== null) {
        currentStep = prev;
        render();
      }
    },
    'reception-wizard-goto-step': (dataset: DOMStringMap) => {
      const stepId = dataset.stepId;
      if (stepId !== undefined && isLaunchWizardStepId(stepId)) {
        currentStep = stepId;
        render();
      }
    },
    'reception-wizard-toggle-drop-link': () => {
      includeDropLink = !includeDropLink;
      render();
    },
    'reception-wizard-switch-profile': () => {
      opts.onSwitchProfile?.();
    },
    'reception-wizard-finish': () => {
      const input = buildWizardInput();
      validation = summarizeLaunchWizardValidation(input);
      if (!validation.valid) {
        render();
        return;
      }
      const dispatchPlan = buildLaunchWizardDispatchPlan(
        buildLaunchWizardPlan(input, now()),
      );
      swallow(
        shell.runLaunchWizard(dispatchPlan).then((runResult) => {
          // Hand the run result back — each `created[].result` carries a
          // one-shot `share_url_once` the page shell does not auto-cache.
          opts.onClose?.(runResult);
        }),
      );
    },
    'reception-wizard-cancel': () => {
      opts.onClose?.();
    },
    // The embedded authoring form's repeater editing — the wizard owns
    // the active config step's working config.
    'reception-form-add-row': (dataset: DOMStringMap) => {
      const resolved = currentStepper().current_step;
      if (!isConfigStep(resolved) || dataset.repeaterKey === undefined) return;
      addRepeaterRow(configs[resolved], dataset.repeaterKey);
      render();
    },
    'reception-form-remove-row': (dataset: DOMStringMap) => {
      const resolved = currentStepper().current_step;
      if (
        !isConfigStep(resolved) ||
        dataset.repeaterKey === undefined ||
        dataset.rowIndex === undefined
      ) {
        return;
      }
      removeRepeaterRow(configs[resolved], dataset.repeaterKey, Number(dataset.rowIndex));
      render();
    },
  } satisfies Record<WizardMountAction, (dataset: DOMStringMap) => void>;

  const detachActions = createActionDispatcher<WizardMountAction>({
    root: host,
    handlers,
  });
  const detachFields = attachFieldDelegator(host, onFieldEdit);
  render();

  return {
    update: render,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      detachActions();
      detachFields();
      host.innerHTML = '';
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Styles — the wizard mount draws no chrome of its own beyond what
// `LAUNCH_WIZARD_STYLES` + `RECEPTION_AUTHORING_STYLES` already cover.
// The one addition: hide the embedded authoring forms' standalone
// `reception-form-*` action bar inside the wizard step slot — the
// wizard's Next / Finish / Cancel are the real controls, and the
// embedded action bar is inert here (no handler in the dispatcher).
// ════════════════════════════════════════════════════════════════

export const LAUNCH_WIZARD_MOUNT_STYLES = `
.reception-wizard-step-slot .rx-action-bar {
  display: none;
}
`;
