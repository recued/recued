/** D-149 § A.20.1 — Reception "Set up Reception"
 *  Launch Wizard mount + working-config container.
 *
 *  `launch-wizard.ts` is the projection layer
 *  (`buildLaunchWizardStepperModel` / `summarizeLaunchWizardValidation`
 *  / `buildLaunchWizardPlanModel` / `buildLaunchWizardDispatchPlan`) and
 *  `launch-wizard-render.ts` is the pure frame renderer
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
 *      `authoring-mount.ts` working-config machinery
 *      (`seedWorkingConfig` / `buildAuthoringView` / `applyFieldDelegateEvent`
 *      / `addRepeaterRow` / `removeRepeaterRow` / `attachFieldDelegator`);
 *    - the non-config steps show current public-access status, private
 *      visitor previews and an explicit disabled-link creation review.
 *      `renderStepContent` remains an optional custom-content seam.
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
 *  Spec: D-149 § A.20.1 (Reception Launch Wizard) + § DoD
 *  (the under-10-minute, 3-endpoint onboarding goal). */

import { e } from '@recued/ui-shared/template';
import { button } from '@recued/ui-shared/primitives';
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
  type LaunchWizardDispatchPlan,
} from './launch-wizard.js';
import {
  renderLaunchWizard,
  type LaunchWizardAction,
  type LaunchWizardRenderView,
} from './launch-wizard-render.js';
import { renderAuthoringForm } from './authoring-render.js';
import {
  addRepeaterRow,
  applyFieldDelegateEvent,
  attachFieldDelegator,
  buildAuthoringView,
  removeRepeaterRow,
  seedWorkingConfig,
  type FieldDelegateEvent,
} from './authoring-mount.js';
import type {
  LaunchWizardRunResult,
  ReceptionPageShell,
} from './page-shell.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import { trackCustomerWorkspaceFocus } from './customer-workspace-focus.js';
import { buildViewAsVisitorModel, type ViewAsVisitorModel } from './view-as-visitor.js';
import { renderViewAsVisitorView } from './page-render.js';
import { INTAKE_FORM_CALENDAR_END_MODE_KEY } from './authoring.js';

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
  | 'reception-form-remove-row'
  | 'reception-wizard-preview'
  | 'reception-wizard-close-preview';

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
  /** Profile id for the existing planner. The access UI reads the shell's
   *  current Reception status and links to the actual Exposure settings. */
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
  /** Capture acknowledged one-shot results before another step can fail. */
  onProgress?: (result: LaunchWizardRunResult) => void;
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
  hasInFlightWork(): boolean;
  hasUnsavedChanges(): boolean;
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
 *      `authoring-mount.ts` machinery;
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
  let validation: LaunchWizardValidationSummary | null = null;
  let disposed = false;
  let busy = false;
  let error: string | null = null;
  let lastHtml = '';
  let dispatchPlan: LaunchWizardDispatchPlan | null = null;
  let progress: LaunchWizardRunResult = { page_upserted: false, created: [] };
  let preview: ViewAsVisitorModel | null = null;
  let previewLoading = false;
  let previewError: string | null = null;
  let previewKind = '';
  let previewRevision = 0;
  let pendingFocus: (() => void) | null = null;
  const focusOwner = host.ownerDocument ? trackCustomerWorkspaceFocus(host.ownerDocument) : null;
  const fingerprint = () => JSON.stringify({ configs, includeDropLink });
  let savedConfig = fingerprint();
  const currentStepper = (): LaunchWizardStepperModel => buildLaunchWizardStepperModel({ current_step: currentStep, include_drop_link: includeDropLink });
  const buildWizardInput = (): LaunchWizardInput => ({
    current_exposure_profile: opts.exposureProfile,
    reception_page: configs.reception_page as unknown as ReceptionPageConfig,
    scheduling_link: configs.scheduling_link as unknown as SchedulingLinkConfig,
    intake_form: configs.intake_form as unknown as IntakeFormConfig,
    ...(includeDropLink ? { drop_link: configs.drop_link as unknown as DropLinkConfig } : {}),
  });
  const makePlan = (): LaunchWizardDispatchPlan => buildLaunchWizardDispatchPlan(buildLaunchWizardPlan(structuredClone(buildWizardInput()), now()));
  const focus = (selector: string): void => {
    const target = host.querySelector?.<HTMLElement>(selector);
    if (!target) return;
    target.tabIndex = -1;
    target.focus?.({ preventScroll: true });
    target.scrollIntoView?.({ block: 'nearest' });
  };
  const stepContentFor = (step: LaunchWizardStepId): string => {
    if (isConfigStep(step)) return renderAuthoringForm(buildAuthoringView(step, configs[step], null, true));
    const supplied = opts.renderStepContent?.(step);
    if (supplied != null) return supplied;
    if (step === 'profile_check') {
      const status = shell.getState?.()?.status;
      return `<div class="reception-wizard-access"><p>${status?.reception_public
        ? 'Public Reception access is enabled. Check your public address and visibility settings before sharing.'
        : 'Public Reception access is not enabled. You can prepare your links now and review public access before enabling them.'}</p>
        <p>Setup creates links disabled. It does not change who can reach your server.</p>
        <a href="#settings/server/exposure">Review public access</a>
        ${opts.onSwitchProfile ? button({ label: 'Change who can reach it', size: 'sm', action: 'reception-wizard-switch-profile' }) : ''}</div>`;
    }
    if (step === 'share') return '<p>Finish saves your Reception page settings and creates the new links disabled. This replaces any existing Reception page settings. Open each endpoint to review and enable it before sharing.</p>';
    const input = buildWizardInput();
    if (!summarizeLaunchWizardValidation(input).valid) return '<p>Complete your page, booking, intake and file settings before previewing the new links. Use the steps above to review them.</p>';
    const plan = buildLaunchWizardPlanModel({ plan: buildLaunchWizardPlan(input, now()), now: now() });
    return `<div class="reception-wizard-preview-actions">${plan.endpoint_drafts.map(d => button({ label: 'Preview ' + d.kind_label, size: 'sm', action: 'reception-wizard-preview', data: { kind: d.kind }, disabled: previewLoading })).join('')}</div>
      ${previewLoading ? '<p role="status">Loading visitor preview…</p>' : ''}
      ${previewError ? `<p class="reception-wizard-feedback" role="alert" tabindex="-1">${e(previewError)}</p>` : ''}
      ${preview ? `<section role="region" aria-label="Visitor preview" tabindex="-1">${renderViewAsVisitorView(preview, 'reception-wizard-close-preview', 'Close preview')}</section>` : ''}`;
  };
  const render = (): void => {
    if (disposed) return;
    const stepper = currentStepper(), input = buildWizardInput();
    const valid = summarizeLaunchWizardValidation(input).valid;
    const planModel = valid ? buildLaunchWizardPlanModel({ plan: buildLaunchWizardPlan(input, now()), now: now() }) : null;
    const view: LaunchWizardRenderView = { stepper, validation, plan: planModel, hasProfileContent: true, busy, error,
      progress: progress.page_upserted ? `Page saved. ${progress.created.length} of ${dispatchPlan?.drafts.length ?? 0} links created.${busy ? ' Saving the remaining links…' : error ? ' Retry to finish the remaining links.' : ''}` : busy ? 'Saving your Reception page…' : '' };
    const marker = `class="reception-wizard-step-slot" data-wizard-step="${e(stepper.current_step)}"></div>`;
    const html = renderLaunchWizard(view).replace(marker, `class="reception-wizard-step-slot" data-wizard-step="${e(stepper.current_step)}">${stepContentFor(stepper.current_step)}</div>`);
    if (html !== lastHtml) {
      const active = host.ownerDocument?.activeElement as HTMLInputElement | null;
      const identity = active && host.contains(active) ? { ...active.dataset } : null;
      const href = identity ? active?.getAttribute('href') : null;
      const headingFocused = identity && active?.matches('.reception-wizard-current-title');
      const selection = identity && typeof active?.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd!, active.selectionDirection] as const : null;
      host.innerHTML = html; lastHtml = html;
      for (const control of host.querySelectorAll?.<HTMLInputElement>('input,select,textarea,button') ?? []) {
        const action = control.dataset.action;
        if (busy && action !== 'reception-wizard-cancel' || progress.page_upserted && (control.matches('input,select,textarea') || action === 'reception-form-add-row' || action === 'reception-form-remove-row' || action === 'reception-wizard-toggle-drop-link')) control.disabled = true;
      }
      if (identity && !pendingFocus) {
        const next = headingFocused ? host.querySelector?.<HTMLInputElement>('.reception-wizard-current-title')
          : href ? [...host.querySelectorAll?.<HTMLInputElement>('a[href]') ?? []].find(node => node.getAttribute('href') === href)
          : [...host.querySelectorAll?.<HTMLInputElement>('[data-field-key],[data-row-field],[data-action]') ?? []].find(node =>
            ['fieldKey','repeaterKey','rowIndex','rowField','action','optionValue','stepId','kind'].every(key => node.dataset[key] === identity[key]) && !node.disabled);
        next?.focus?.({ preventScroll: true });
        if (next && selection && typeof next.selectionStart === 'number') next.setSelectionRange(selection[0], selection[1], selection[2] ?? undefined);
      }
    }
    pendingFocus?.(); pendingFocus = null;
  };
  const move = (step: LaunchWizardStepId | null): void => {
    if (busy || disposed || step === null) return;
    currentStep = step;
    pendingFocus = () => focus('.reception-wizard-current-title');
    render();
    host.querySelector?.<HTMLElement>('[aria-current="step"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  };
  const onFieldEdit = (event: FieldDelegateEvent): void => {
    if (busy || progress.page_upserted || disposed) return;
    const step = currentStepper().current_step;
    if (!isConfigStep(step)) return;
    applyFieldDelegateEvent(step, configs[step], event);
    dispatchPlan = null; previewRevision++; previewLoading = false;
    const hadFeedback = validation !== null || error !== null || preview !== null || previewError !== null;
    validation = null; error = null; preview = null; previewError = null;
    if (hadFeedback || step === 'intake_form' && (event.fieldKey === 'submission_processing_rule.target_kind' || event.fieldKey === INTAKE_FORM_CALENDAR_END_MODE_KEY)) render();
  };
  const handlers = {
    'reception-wizard-next': () => move(currentStepper().next_step),
    'reception-wizard-prev': () => move(currentStepper().prev_step),
    'reception-wizard-goto-step': (data: DOMStringMap) => { if (data.stepId && isLaunchWizardStepId(data.stepId)) move(data.stepId); },
    'reception-wizard-toggle-drop-link': () => {
      if (busy || progress.page_upserted || disposed) return;
      includeDropLink = !includeDropLink; dispatchPlan = null; preview = null; previewError = null; previewRevision++;
      if (!includeDropLink && currentStep === 'drop_link') currentStep = 'view_as_visitor';
      pendingFocus = () => focus('.reception-wizard-current-title'); render();
    },
    'reception-wizard-switch-profile': () => { if (!busy) opts.onSwitchProfile?.(); },
    'reception-wizard-finish': () => {
      if (busy || disposed) return;
      if (!dispatchPlan) {
        validation = summarizeLaunchWizardValidation(buildWizardInput());
        if (!validation.valid) { pendingFocus = () => focus('[role="alert"]'); render(); return; }
        dispatchPlan = makePlan();
      }
      busy = true; error = null; render();
      const ownsFocus = focusOwner?.capture() ?? (() => true);
      void shell.runLaunchWizard(dispatchPlan, {
        shouldContinue: () => !disposed,
        onProgress: value => {
          progress = value;
          opts.onProgress?.(value);
          if (!disposed) render();
        },
      }).then(result => {
        if (disposed) return;
        busy = false;
        if (result.cancelled) { render(); return; }
        savedConfig = fingerprint();
        opts.onClose?.(result);
      }, err => {
        if (disposed) return;
        busy = false; error = humanizeRpcError(err);
        if (ownsFocus()) pendingFocus = () => focus('[role="alert"]');
        render();
      });
    },
    'reception-wizard-cancel': () => opts.onClose?.(),
    'reception-wizard-preview': (data: DOMStringMap) => {
      if (busy || previewLoading || disposed || !summarizeLaunchWizardValidation(buildWizardInput()).valid) return;
      const item = (dispatchPlan ?? makePlan()).drafts.find(d => d.draft.kind === data.kind);
      if (!item) return;
      const revision = ++previewRevision;
      previewKind = data.kind!; previewLoading = true; previewError = null; preview = null; render();
      const ownsFocus = focusOwner?.capture() ?? (() => true);
      void shell.runPreview(structuredClone(item.preview)).then(result => {
        if (disposed || revision !== previewRevision) return;
        preview = buildViewAsVisitorModel({ result, now: now() }); previewLoading = false;
        if (ownsFocus()) pendingFocus = () => focus('[aria-label="Visitor preview"]');
        render();
      }, err => {
        if (disposed || revision !== previewRevision) return;
        previewLoading = false; previewError = humanizeRpcError(err);
        if (ownsFocus()) pendingFocus = () => focus('[role="alert"]');
        render();
      });
    },
    'reception-wizard-close-preview': () => {
      preview = null; render();
      host.querySelector?.<HTMLElement>(`[data-action="reception-wizard-preview"][data-kind="${previewKind}"]`)?.focus?.({ preventScroll: true });
    },
    'reception-form-add-row': (data: DOMStringMap) => {
      const step = currentStepper().current_step;
      if (busy || progress.page_upserted || !isConfigStep(step) || !data.repeaterKey) return;
      addRepeaterRow(configs[step], data.repeaterKey); preview = null; previewRevision++; dispatchPlan = null;
      pendingFocus = () => {
        const rows = host.querySelectorAll?.<HTMLElement>(`.reception-form-repeater-row[data-repeater-key="${data.repeaterKey}"]`);
        const control = rows?.[rows.length - 1]?.querySelector?.<HTMLElement>('input,select,textarea');
        control?.focus?.({ preventScroll: true }); control?.scrollIntoView?.({ block: 'nearest' });
      };
      render();
    },
    'reception-form-remove-row': (data: DOMStringMap) => {
      const step = currentStepper().current_step;
      if (busy || progress.page_upserted || !isConfigStep(step) || !data.repeaterKey || data.rowIndex === undefined) return;
      removeRepeaterRow(configs[step], data.repeaterKey, Number(data.rowIndex)); preview = null; previewRevision++; dispatchPlan = null;
      pendingFocus = () => {
        const control = host.querySelector?.<HTMLElement>(`[data-action="reception-form-add-row"][data-repeater-key="${data.repeaterKey}"]`);
        control?.focus?.({ preventScroll: true }); control?.scrollIntoView?.({ block: 'nearest' });
      };
      render();
    },
  } satisfies Record<WizardMountAction, (dataset: DOMStringMap) => void>;
  const detachActions = createActionDispatcher<WizardMountAction>({ root: host, handlers });
  const detachFields = attachFieldDelegator(host, onFieldEdit);
  render();
  const unsubscribe = shell.subscribe?.(() => render());
  return {
    update: render,
    hasInFlightWork: () => busy,
    hasUnsavedChanges: () => fingerprint() !== savedConfig,
    dispose: () => {
      if (disposed) return;
      disposed = true; previewRevision++;
      detachActions(); detachFields(); unsubscribe?.(); focusOwner?.dispose(); host.innerHTML = '';
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
.reception-wizard-step-slot .reception-form > .rx-action-bar {
  display: none;
}
`;
