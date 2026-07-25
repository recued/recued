/** D-149 § A.20.1 — Settings → Server → Reception → "Set up Reception"
 *  Launch Wizard renderer (the host-side framework renderer).
 *
 *  `reception-launch-wizard.ts` is the projection layer:
 *  `buildLaunchWizardStepperModel` projects the cursor + drop-link
 *  decision into a stepper, `summarizeLaunchWizardValidation` wraps the
 *  contract validator, `buildLaunchWizardPlanModel` projects a
 *  `LaunchWizardPlan` into the renderable plan preview. All substrate —
 *  nothing draws pixels. **This is the renderer: the host-side piece
 *  that turns those models into DOM and tags every control with the
 *  `data-action` markup a wizard container binds to.**
 *
 *  ── The `renderReceptionPage` shape ───────────────────────────────
 *  Same pattern as `reception-page-render.ts` + the authoring-form
 *  renderer: a pure `renderX(props) -> string` + a companion `*_STYLES`
 *  constant, every interactive element carrying a typed `data-action`.
 *  No `mountX` — the wizard projects a *working-config + step-cursor*
 *  local state that has no container yet (the page-render handover's
 *  decision #6 names it as the next unit). So this module ships the pure
 *  renderer + the `data-action` contract a future `mountLaunchWizard` /
 *  wizard container will bind to.
 *
 *  ── The wizard is chrome; the per-step content is siblings ─────────
 *  Per `reception-launch-wizard.ts`'s contract: § A.20.1 is a 7-step
 *  first-run flow whose per-step *content* is the OTHER satellites'
 *  surfaces (the authoring forms, the Templates browser, the
 *  View-As-Visitor panel, the Share cards, D-148's exposure surface).
 *  This renderer owns the *frame*: the stepper, the validation gate, the
 *  navigation, the plan preview. The current step's content goes into a
 *  `<div class="reception-wizard-step-slot" data-wizard-step="…">` the
 *  host fills with the matching sibling renderer's output — the renderer
 *  emits the slot, never the content.
 *
 *  ── View routing — what the stepper model actually supports ────────
 *  `LaunchWizardStepperModel` is cursor-driven: the stepper is the seven
 *  `LAUNCH_WIZARD_STEPS` in canonical order, the optional `drop_link`
 *  step rendered greyed + un-clickable when `includes_drop_link` is
 *  false (it has no ordinal — navigation hops over it). Every non-skipped
 *  step is a `reception-wizard-goto-step` jump target. The current step
 *  is the only one whose frame + step-slot render.
 *
 *  ── Profile gate + drop-link toggle ───────────────────────────────
 *  Two steps carry extra chrome beyond the step-slot:
 *    - `profile_check` — when a `plan` is supplied, its
 *      `profile_gate` renders as a posture panel (a "Switch exposure
 *      profile" button — `reception-wizard-switch-profile` — iff
 *      `switch_needed`). The page shell bridges that button to D-148's
 *      exposure rpc; this renderer owns no profile-switch dispatch (per
 *      `reception-launch-wizard.ts`).
 *    - `drop_link` — the optional step. Its frame carries a
 *      `reception-wizard-toggle-drop-link` button (a button, not a
 *      checkbox — a checkbox dispatched through a click delegator would
 *      have its toggle `preventDefault`-ed); the label reflects the
 *      current `includes_drop_link` state.
 *
 *  ── Finish gating ─────────────────────────────────────────────────
 *  On the last active step the Next button becomes "Finish setup"
 *  (`reception-wizard-finish`) — disabled when a `validation` summary is
 *  supplied AND invalid (the contract validator delegates to the same
 *  per-kind validators `reception.endpoint.create` runs, so "valid"
 *  structurally implies every endpoint the plan provisions validates
 *  clean). A `null` validation leaves Finish enabled; the host validates
 *  on click.
 *
 *  ── XSS ───────────────────────────────────────────────────────────
 *  Every server-/user-supplied string (the exposure-profile ids, the
 *  validation `detail` strings, the plan summary copy) flows through
 *  `e()` before interpolation.
 *
 *  Spec: D-149 § A.20.1 (Reception Launch Wizard) + § DoD
 *  (the under-10-minute, 3-endpoint onboarding goal). */

import { e } from '@recued/ui-shared/template';
import {
  actionBar,
  badge,
  button,
  inlineHint,
  panel,
} from '@recued/ui-shared/primitives';

import type {
  LaunchWizardEndpointDraftModel,
  LaunchWizardPlanModel,
  LaunchWizardProfileGate,
  LaunchWizardStepModel,
  LaunchWizardStepperModel,
  LaunchWizardStepStatus,
  LaunchWizardValidationSummary,
} from './reception-launch-wizard.js';

// ════════════════════════════════════════════════════════════════
// Action surface
// ════════════════════════════════════════════════════════════════

/** Every `data-action` the Launch Wizard renderer emits. A future
 *  `mountLaunchWizard` dispatcher is typed against this union. */
export const LAUNCH_WIZARD_ACTIONS = [
  // ── Navigation ───────────────────────────────────────────────────
  'reception-wizard-next',
  'reception-wizard-prev',
  'reception-wizard-goto-step',
  // ── Per-step chrome ──────────────────────────────────────────────
  'reception-wizard-toggle-drop-link',
  'reception-wizard-switch-profile',
  // ── Terminal ─────────────────────────────────────────────────────
  'reception-wizard-finish',
  'reception-wizard-cancel',
] as const;

export type LaunchWizardAction = (typeof LAUNCH_WIZARD_ACTIONS)[number];

// ════════════════════════════════════════════════════════════════
// View — the renderer's input
// ════════════════════════════════════════════════════════════════

/** The renderer's input: the cursor-driven stepper (always), plus an
 *  optional validation summary (supplied once the host has run
 *  `summarizeLaunchWizardValidation` over the working form) and an
 *  optional plan preview (supplied once the host has built the
 *  `LaunchWizardPlan` — typically by the review steps). */
export interface LaunchWizardRenderView {
  readonly stepper: LaunchWizardStepperModel;
  readonly validation: LaunchWizardValidationSummary | null;
  readonly plan: LaunchWizardPlanModel | null;
}

// ════════════════════════════════════════════════════════════════
// Small shared helpers
// ════════════════════════════════════════════════════════════════

/** `data-*` attribute string from a flat record — keys emitted verbatim
 *  as `data-<key>` (callers pass already-kebab keys), values escaped.
 *  Undefined values dropped. Mirrors `reception-page-render.ts`. */
const dataAttrs = (
  data: Readonly<Record<string, string | undefined>>,
): string =>
  Object.entries(data)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([k, v]) => `data-${k}="${e(v)}"`)
    .join(' ');

/** The glyph for a stepper step's lifecycle status. */
const STEP_STATUS_GLYPH: Readonly<Record<LaunchWizardStepStatus, string>> = {
  complete: '✓',
  current: '●',
  pending: '○',
  skipped: '–',
};

// ════════════════════════════════════════════════════════════════
// Stepper
// ════════════════════════════════════════════════════════════════

/** One step in the stepper rail. A `skipped` step (the optional
 *  `drop_link` excluded from this run) renders greyed + un-clickable —
 *  it has no ordinal and navigation hops over it, so making it a jump
 *  target would be a dead end. Every other step is a
 *  `reception-wizard-goto-step` jump target. A step carrying a
 *  validation failure gets an error badge. */
const renderStepperStep = (
  step: LaunchWizardStepModel,
  failedSteps: ReadonlySet<string>,
): string => {
  const glyph = STEP_STATUS_GLYPH[step.status];
  const hasError = failedSteps.has(step.step_id);
  const errorBadge = hasError ? badge({ label: 'Needs attention', tone: 'off' }) : '';
  const optionalBadge = step.is_optional
    ? badge({ label: 'Optional', tone: 'neutral' })
    : '';
  const inner = `
    <span class="reception-wizard-step-glyph" aria-hidden="true">${glyph}</span>
    <span class="reception-wizard-step-text">
      <span class="reception-wizard-step-title">${e(step.title)}</span>
      <span class="reception-wizard-step-position">${
        step.position_label !== null ? e(step.position_label) : 'Skipped'
      }</span>
    </span>
    ${optionalBadge}
    ${errorBadge}
  `;
  if (step.status === 'skipped') {
    return `<div class="reception-wizard-step reception-wizard-step--skipped" ${dataAttrs({
      'step-id': step.step_id,
    })}>${inner}</div>`;
  }
  const currentAttr = step.status === 'current' ? ' aria-current="step"' : '';
  return `<button
      type="button"
      class="reception-wizard-step reception-wizard-step--${step.status}"
      data-action="reception-wizard-goto-step"
      ${dataAttrs({ 'step-id': step.step_id })}${currentAttr}
    >${inner}</button>`;
};

/** The full stepper rail — the seven steps in canonical order. */
const renderStepper = (
  stepper: LaunchWizardStepperModel,
  failedSteps: ReadonlySet<string>,
): string =>
  `<nav class="reception-wizard-stepper" aria-label="Launch Wizard steps">
    ${stepper.steps.map((s) => renderStepperStep(s, failedSteps)).join('')}
  </nav>`;

// ════════════════════════════════════════════════════════════════
// Validation gate
// ════════════════════════════════════════════════════════════════

/** The validation gate — surfaced only when a `validation` summary is
 *  supplied AND it carries failures. Each failure resolves to its
 *  remediation `message` + the contract `detail` + a
 *  `reception-wizard-goto-step` jump to the failing step. */
const renderValidationGate = (
  validation: LaunchWizardValidationSummary | null,
): string => {
  if (validation === null || validation.valid) return '';
  return panel({
    tone: 'danger',
    title: `Fix ${validation.failures.length} ${
      validation.failures.length === 1 ? 'problem' : 'problems'
    } before finishing setup`,
    role: 'alert',
    body: `<ul class="reception-wizard-errors">${validation.failures
      .map(
        (fail) => `<li class="reception-wizard-error">
          <span class="reception-wizard-error-msg">${e(fail.message)}</span>
          <span class="reception-wizard-error-detail">${e(fail.detail)}</span>
          ${button({
            label: 'Go to step',
            size: 'xs',
            action: 'reception-wizard-goto-step',
            data: { 'step-id': fail.step },
          })}
        </li>`,
      )
      .join('')}</ul>`,
  });
};

// ════════════════════════════════════════════════════════════════
// Per-step extra chrome — profile gate + drop-link toggle
// ════════════════════════════════════════════════════════════════

/** The § A.20.1 step-1 exposure-profile gate. Surfaced inside the
 *  `profile_check` step frame when a `plan` is supplied. When the
 *  server's exposure profile is not the one Reception needs, a "Switch
 *  exposure profile" button (`reception-wizard-switch-profile`) is
 *  offered — the page shell bridges it to D-148's exposure rpc; this
 *  renderer owns no profile-switch dispatch. */
const renderProfileGate = (gate: LaunchWizardProfileGate): string =>
  panel({
    tone: gate.switch_needed ? 'warn' : 'info',
    title: gate.headline,
    body: `
      <p class="reception-wizard-gate-detail">${e(gate.detail)}</p>
      <p class="reception-wizard-gate-profiles">
        Current: <code class="reception-wizard-mono">${e(
          gate.current_exposure_profile,
        )}</code>
        · Recommended: <code class="reception-wizard-mono">${e(
          gate.recommended_exposure_profile,
        )}</code>
      </p>
      ${
        gate.switch_needed
          ? button({
              label: 'Switch exposure profile',
              variant: 'primary',
              size: 'sm',
              action: 'reception-wizard-switch-profile',
            })
          : ''
      }
    `,
  });

/** The optional `drop_link` step's include / exclude control. A button
 *  (not a checkbox — a checkbox dispatched through a click delegator
 *  would have its toggle `preventDefault`-ed); the label reflects the
 *  current `includes_drop_link` state. */
const renderDropLinkToggle = (includesDropLink: boolean): string =>
  `<div class="reception-wizard-droptoggle">
    ${inlineHint(
      includesDropLink
        ? 'A drop link is part of this run. Skip it if you do not need file uploads yet.'
        : 'This optional step is skipped. Include a drop link to accept file uploads.',
    )}
    ${button({
      label: includesDropLink ? 'Skip this optional step' : 'Include a drop link',
      size: 'sm',
      action: 'reception-wizard-toggle-drop-link',
    })}
  </div>`;

// ════════════════════════════════════════════════════════════════
// Current step frame
// ════════════════════════════════════════════════════════════════

/** The current step's frame — its title + summary + the per-step
 *  content slot the host fills with the matching sibling renderer's
 *  output. The `profile_check` + `drop_link` steps carry extra chrome
 *  ahead of the slot. */
const renderCurrentStep = (view: LaunchWizardRenderView): string => {
  const { stepper, plan } = view;
  // The stepper guarantees `current_step` is an active step, so it is
  // always present in `steps` with a non-skipped status.
  const current = stepper.steps.find((s) => s.step_id === stepper.current_step);
  if (current === undefined) {
    // Defensive — the stepper builder never produces this. Render an
    // inert frame rather than throwing.
    return `<div class="reception-wizard-current"></div>`;
  }
  const extraChrome =
    current.step_id === 'profile_check' && plan !== null
      ? renderProfileGate(plan.profile_gate)
      : current.step_id === 'drop_link'
        ? renderDropLinkToggle(stepper.includes_drop_link)
        : '';
  return `
    <div class="reception-wizard-current">
      <div class="reception-wizard-current-head">
        <h4 class="reception-wizard-current-title">${e(current.title)}</h4>
        ${
          current.position_label !== null
            ? `<span class="reception-wizard-current-position">${e(
                current.position_label,
              )}</span>`
            : ''
        }
      </div>
      <p class="reception-wizard-current-summary">${e(current.summary)}</p>
      ${extraChrome}
      <div class="reception-wizard-step-slot" ${dataAttrs({
        'wizard-step': current.step_id,
      })}></div>
    </div>
  `;
};

// ════════════════════════════════════════════════════════════════
// Plan preview
// ════════════════════════════════════════════════════════════════

/** One endpoint-draft row in the plan preview. */
const renderPlanDraftRow = (draft: LaunchWizardEndpointDraftModel): string => `
  <div class="reception-wizard-draft">
    <div class="reception-wizard-draft-head">
      <span class="reception-wizard-draft-kind">${e(draft.kind_label)}</span>
      ${draft.is_optional_step ? badge({ label: 'Optional', tone: 'neutral' }) : ''}
      <span class="reception-wizard-draft-expiry">${e(draft.expiry_label)}</span>
    </div>
    <p class="reception-wizard-draft-desc">${e(draft.kind_description)}</p>
    <p class="reception-wizard-draft-packet">
      Packet kind <code class="reception-wizard-mono">${e(draft.packet_kind)}</code>
    </p>
  </div>
`;

/** The "what will this wizard do" plan preview — surfaced once the host
 *  has built the `LaunchWizardPlan` (typically by the review steps).
 *  The profile gate lives with the `profile_check` step frame, not here;
 *  this section is the page-upsert summary + the ordered endpoint-draft
 *  rows + the "N endpoints" confirmation. */
const renderPlanPreview = (plan: LaunchWizardPlanModel | null): string => {
  if (plan === null) return '';
  return panel({
    tone: 'info',
    title: 'What this wizard will set up',
    body: `
      <p class="reception-wizard-plan-summary">${e(plan.summary_label)}</p>
      <div class="reception-wizard-plan-rows">
        <div class="reception-wizard-draft">
          <div class="reception-wizard-draft-head">
            <span class="reception-wizard-draft-kind">Reception page</span>
            <span class="reception-wizard-draft-expiry">Per-server singleton</span>
          </div>
          <p class="reception-wizard-draft-desc">${e(plan.page_upsert_summary)}</p>
        </div>
        ${plan.endpoint_drafts.map(renderPlanDraftRow).join('')}
      </div>
    `,
  });
};

// ════════════════════════════════════════════════════════════════
// Navigation
// ════════════════════════════════════════════════════════════════

/** The bottom navigation bar. Back is disabled on the first active
 *  step; the forward control is "Next" until the last active step,
 *  where it becomes "Finish setup" (`reception-wizard-finish`) — disabled
 *  when a `validation` summary is supplied AND invalid. */
const renderNavigation = (
  stepper: LaunchWizardStepperModel,
  validation: LaunchWizardValidationSummary | null,
): string => {
  const back = button({
    label: 'Back',
    size: 'sm',
    action: 'reception-wizard-prev',
    disabled: stepper.is_first_step,
  });
  const forward = stepper.is_last_step
    ? button({
        label: 'Finish setup',
        size: 'sm',
        variant: 'primary',
        action: 'reception-wizard-finish',
        disabled: validation !== null && !validation.valid,
      })
    : button({
        label: 'Next',
        size: 'sm',
        variant: 'primary',
        action: 'reception-wizard-next',
      });
  return actionBar({ gap: 8, bordered: true, align: 'between', children: [back, forward] });
};

// ════════════════════════════════════════════════════════════════
// Top-level renderer
// ════════════════════════════════════════════════════════════════

/** Render the Reception Launch Wizard chrome from its render view. Pure
 *  — no I/O, no container reference. The stepper, the validation gate,
 *  the current-step frame (with its host-filled content slot), the plan
 *  preview, and the navigation; every interactive element carries a
 *  typed `data-action`. */
export const renderLaunchWizard = (view: LaunchWizardRenderView): string => {
  const { stepper, validation, plan } = view;
  // Copy into a `Set<string>` so the helpers stay loosely typed (the
  // contract's `failed_steps` is `ReadonlySet<LaunchWizardStepId>`).
  const failedSteps: ReadonlySet<string> = new Set<string>(
    validation !== null ? validation.failed_steps : [],
  );
  return `
    <div class="reception-wizard" ${dataAttrs({ 'current-step': stepper.current_step })}>
      <header class="reception-wizard-header">
        <h3 class="reception-wizard-title">Set up Reception</h3>
        <span class="reception-wizard-progress">Step ${stepper.current_position} of ${stepper.total_active_steps}</span>
        <span class="reception-wizard-spacer"></span>
        ${button({
          label: 'Cancel setup',
          size: 'xs',
          variant: 'danger-text',
          action: 'reception-wizard-cancel',
        })}
      </header>
      ${renderStepper(stepper, failedSteps)}
      ${renderValidationGate(validation)}
      ${renderCurrentStep(view)}
      ${renderPlanPreview(plan)}
      ${renderNavigation(stepper, validation)}
    </div>
  `;
};

// ════════════════════════════════════════════════════════════════
// Styles — self-contained `.reception-wizard-*` selectors, colours from
// the shared CSS custom properties (same convention as every primitive
// + `RECEPTION_PAGE_STYLES`).
// ════════════════════════════════════════════════════════════════

export const LAUNCH_WIZARD_STYLES = `
.reception-wizard {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: clamp(20px, 3vw, 28px);
  /* R19 Slice 3 — an OPAQUE card surface, the same fix .reception-form got
     in Slice 2. Pre-R19 the wizard carried no background, so on the modal
     overlay backdrop it rendered transparent and unusable (the "can't
     enable" bug). A bordered card on the page background reads as a real
     surface whether routed full-page (the new default) or, residually, in
     the modal slot. Wider than the authoring card: the wizard frames a
     stepper rail + the plan preview AROUND an embedded authoring
     form, so the form keeps its own breathing room inside. */
  max-width: 820px;
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: 0 1px 2px rgba(24, 24, 27, 0.04), 0 18px 46px rgba(24, 24, 27, 0.05);
}
.reception-wizard .rx-btn {
  min-height: 36px;
  border-radius: 8px;
  font-weight: 650;
}
.reception-wizard .rx-panel {
  border-radius: 11px;
  background: var(--surface-sunk);
}
.reception-wizard-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 17px;
  border-bottom: 1px solid var(--border);
}
.reception-wizard-title {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0;
}
.reception-wizard-progress {
  padding: 4px 8px;
  border-radius: 999px;
  background: var(--surface-sunk);
  font-size: 11px;
  font-weight: 650;
  color: var(--fg-muted);
}
.reception-wizard-spacer {
  flex: 1;
}
.reception-wizard-stepper {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px;
}
.reception-wizard-step {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 52px;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-sunk);
  font-family: inherit;
  font-size: 12px;
  color: var(--fg);
  cursor: pointer;
  text-align: left;
}
.reception-wizard-step:hover:not(.reception-wizard-step--skipped) {
  border-color: var(--border-strong, var(--border));
  background: var(--surface);
}
.reception-wizard-step--current {
  border-color: var(--accent);
  background: var(--accent-weak);
  box-shadow: inset 0 0 0 1px var(--accent);
}
.reception-wizard-step--skipped {
  opacity: 0.5;
  cursor: default;
}
.reception-wizard-step-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 24px;
  width: 24px;
  height: 24px;
  border-radius: 8px;
  background: var(--surface);
  font-size: 12px;
  text-align: center;
}
.reception-wizard-step--complete .reception-wizard-step-glyph {
  color: var(--ok);
}
.reception-wizard-step--current .reception-wizard-step-glyph {
  color: var(--accent);
}
.reception-wizard-step-text {
  display: flex;
  flex-direction: column;
}
.reception-wizard-step-title {
  font-weight: 500;
}
.reception-wizard-step-position {
  font-size: 11px;
  color: var(--fg-muted);
}
.reception-wizard-current {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-sunk);
}
.reception-wizard-current-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.reception-wizard-current-title {
  font-size: 17px;
  font-weight: 700;
  margin: 0;
}
.reception-wizard-current-position {
  font-size: 11px;
  color: var(--fg-muted);
}
.reception-wizard-current-summary {
  font-size: 13px;
  color: var(--fg);
  margin: 0;
  line-height: 1.55;
}
.reception-wizard-gate-detail {
  font-size: 13px;
  margin: 0 0 6px;
  line-height: 1.5;
}
.reception-wizard-gate-profiles {
  font-size: 12px;
  color: var(--fg-muted);
  margin: 0 0 8px;
}
.reception-wizard-mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
}
.reception-wizard-droptoggle {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}
.reception-wizard-step-slot {
  /* Host fills this with the matching sibling renderer's output. Empty
     when the host has not yet mounted the per-step panel. */
}
.reception-wizard-plan-summary {
  font-size: 13px;
  font-weight: 500;
  margin: 0 0 10px;
}
.reception-wizard-plan-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.reception-wizard-draft {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 11px 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface);
}
.reception-wizard-draft-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.reception-wizard-draft-kind {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
}
.reception-wizard-draft-expiry {
  font-size: 11px;
  color: var(--fg-muted);
}
.reception-wizard-draft-desc,
.reception-wizard-draft-packet {
  font-size: 12px;
  color: var(--fg-muted);
  margin: 0;
}
.reception-wizard-errors {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.reception-wizard-error {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
}
.reception-wizard-error-msg {
  color: var(--fg);
}
.reception-wizard-error-detail {
  color: var(--fg-muted);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
}
.reception-wizard > .rx-action-bar {
  margin-top: 0;
  padding-top: 18px;
}
/* R19 Slice 3 — the routed full-page wizard section chrome
   (reception-launch-wizard-section.ts): a back-link header above the
   wizard card. The wrapper also carries .reception-page, whose flex-column
   gap spaces the header from the card — same idiom as the authoring
   section. */
.reception-wizard-section-head {
  display: flex;
  align-items: center;
}
.reception-wizard-section-back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 34px;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 650;
  color: var(--fg-muted);
  text-decoration: none;
}
.reception-wizard-section-back:hover {
  color: var(--fg);
  background: var(--surface-sunk);
}
.reception-wizard-section-back:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
@media (max-width: 640px) {
  .reception-wizard { padding: 18px 14px; border-radius: 12px; }
  .reception-wizard-header { align-items: flex-start; flex-wrap: wrap; }
  .reception-wizard-title { font-size: 20px; }
  .reception-wizard-spacer { display: none; }
  .reception-wizard-header .rx-btn { margin-left: auto; }
  .reception-wizard-stepper { grid-template-columns: 1fr 1fr; }
  .reception-wizard-step { min-width: 0; }
  .reception-wizard-step .rx-badge { display: none; }
  .reception-wizard-current { padding: 14px; }
}
@media (max-width: 400px) {
  .reception-wizard-stepper { grid-template-columns: 1fr; }
}
`;
