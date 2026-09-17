/** D-149 § A.20.1 — Reception → "Set up Reception"
 *  Launch Wizard chrome.
 *
 *  The fifth — and last — satellite Settings surface attaching to the
 *  § A.9 management spine (`spine.ts`), after the Abuse Inbox
 *  subview, the per-kind authoring forms, the View-As-Visitor panel, and
 *  the Templates browser. With this module **5 of 5 satellites + the
 *  spine** are done. P12 shipped the Launch Wizard substrate —
 *  `validateLaunchWizardInput` (delegates each per-kind config to the
 *  same validator `reception.endpoint.create` runs) + `buildLaunchWizardPlan`
 *  (the ordered `reception.page.upsert` + N `preview_draft → create`
 *  sequence) + the `LAUNCH_WIZARD_STEPS` closed list — but, consistent
 *  with how P4-P12 each deferred its Settings UX, nothing rendered it.
 *  This is the projection layer.
 *
 *  ── The Launch Wizard is chrome; the per-step panels are siblings ──
 *  § A.20.1 is a 7-step first-run flow whose per-step *content* is the
 *  other satellites' (and D-148's) surfaces — this module owns the
 *  *frame*: the stepper, the validation gate, and the "what will this
 *  wizard do" plan preview + dispatch bridge. The per-step content
 *  panels the page shell mounts:
 *
 *    1. `profile_check`    — D-148 `exposure-surface.ts` (the exposure
 *                            profile switcher). The wizard surfaces the
 *                            *need* (`profile_gate`); the page shell
 *                            bridges the "Switch" button to D-148's
 *                            exposure rpc. This module owns NO
 *                            profile-switch dispatch.
 *    2. `reception_page`   — `authoring.ts` `buildReceptionPageFormModel`
 *    3. `scheduling_link`  — `authoring.ts` `buildSchedulingLinkFormModel`
 *    4. `intake_form`      — `templates.ts` (pick the
 *                            `client_inquiry` Foundation-pack template)
 *                            → `authoring.ts` `buildIntakeFormFormModel`
 *    5. `drop_link`        — `authoring.ts` `buildDropLinkFormModel`
 *                            (the optional step)
 *    6. `view_as_visitor`  — `view-as-visitor.ts` `buildViewAsVisitorModel`
 *    7. `share`            — the spine's `buildShareCards` projection
 *
 *  ── What this module owns ─────────────────────────────────────────
 *    - **The stepper chrome** — `buildLaunchWizardStepperModel` projects
 *      the seven `LAUNCH_WIZARD_STEPS` into a cursor-driven stepper:
 *      per-step status (`complete` / `current` / `pending` / `skipped`),
 *      "Step N of M" labels, next / prev navigation. The one optional
 *      step (`drop_link`, § A.20.1 step 5) is `skipped` when the user
 *      opts out — navigation hops over it and the active count drops to
 *      six.
 *    - **The validation gate** — `summarizeLaunchWizardValidation` wraps
 *      the contract's `validateLaunchWizardInput` and resolves each
 *      failure code through `LAUNCH_WIZARD_VALIDATION_COPY` (closed-list,
 *      tsc-completeness-enforced — THE established pattern from the
 *      spine's `RECEPTION_ERROR_COPY` + the authoring sibling's
 *      `*_CONFIG_ERROR_COPY`). Because the contract validator delegates
 *      to the same per-kind validators `reception.endpoint.create` runs,
 *      "the wizard input validates clean" structurally implies "every
 *      endpoint the plan provisions validates clean".
 *    - **The plan projection + dispatch bridge** —
 *      `buildLaunchWizardPlanModel` projects a `LaunchWizardPlan` into
 *      the profile gate + the ordered endpoint-draft rows + the "N
 *      endpoints" summary; `buildLaunchWizardDispatchPlan` shapes the
 *      ordered substrate operations — the `reception.page.upsert`
 *      dispatch plus one `reception.endpoint.preview_draft` dispatch per
 *      draft (paired with its draft so the page shell can run
 *      preview → create per draft). The actual dispatch *builders*
 *      (`buildReceptionPageUpsertDispatch` / `buildEndpointPreviewDispatch`
 *      / `buildEndpointCreateDispatch`) are owned by `authoring.ts`;
 *      this module reuses + re-exports them so the page shell composes
 *      the whole flow with one import (same one-import discipline as the
 *      View-As-Visitor + Templates satellites).
 *
 *  `RECEPTION_KIND_COPY` and `computeExpiryLabel` are imported from the
 *  spine — one copy registry / one expiry-label rule per concept across
 *  the whole Reception Settings surface (same discipline as the
 *  View-As-Visitor satellite reusing `computeExpiryLabel`).
 *
 *  Per D-148 § A.4 invariant — the webclient projects server-supplied
 *  state only, never synthesises. Every `build*` here is pure (no I/O).
 *  There is deliberately **no** broadcast reducer: the Launch Wizard is
 *  a one-shot client-side flow over wizard-form input + a step cursor —
 *  nothing fans a broadcast on it. Once the wizard's `page.upsert` +
 *  creates land, the spine's existing `reception.endpoint_changed`
 *  broadcast drives the list-view refresh; the wizard chrome itself
 *  carries no live server state to reduce.
 *
 *  Spec: D-149 § A.20.1 (Reception Launch Wizard) + § DoD
 *  (the under-10-minute, 3-endpoint onboarding goal the wizard
 *  satisfies). */

import {
  LAUNCH_WIZARD_STEPS,
  RECEPTION_RECOMMENDED_EXPOSURE_PROFILE,
  buildLaunchWizardPlan,
  validateLaunchWizardInput,
  type LaunchWizardEndpointDraft,
  type LaunchWizardPlan,
  type LaunchWizardStepId,
  type LaunchWizardValidationCode,
  type PacketDeclaration,
  type ReceptionEndpointKind,
  type ReceptionPageUpsertInput,
} from '@recued/contracts';

import {
  RECEPTION_KIND_COPY,
  computeExpiryLabel,
  isReceptionEndpointKindAvailable,
} from './spine.js';
import {
  buildEndpointCreateDispatch,
  buildEndpointPreviewDispatch,
  buildReceptionPageUpsertDispatch,
  type ReceptionEndpointPreviewDispatch,
  type ReceptionPageUpsertDispatch,
} from './authoring.js';

// ════════════════════════════════════════════════════════════════
// Step classification — the one optional step + the four steps that
// contribute a row to the `LaunchWizardPlan`. The contract docstring
// is explicit: `profile_check` / `view_as_visitor` / `share` are "UI
// affordances surfaced by the other P12 builders, not plan rows" — the
// other four feed `buildLaunchWizardPlan`'s output (`reception_page` →
// `page_upsert`; `scheduling_link` / `intake_form` / `drop_link` →
// `endpoint_drafts`).
// ════════════════════════════════════════════════════════════════

/** The single optional step (§ A.20.1 step 5 — "Optional drop link").
 *  `LaunchWizardInput.drop_link` is contract-optional + `buildLaunchWizardPlan`
 *  conditionally includes its draft; this set is the chrome's encoding
 *  of that fact. */
export const LAUNCH_WIZARD_OPTIONAL_STEP_SET: ReadonlySet<LaunchWizardStepId> = new Set([
  'drop_link',
]);

const isEndpointStep = (
  step: LaunchWizardStepId,
): step is Extract<LaunchWizardStepId, ReceptionEndpointKind> =>
  step === 'reception_page' ||
  step === 'scheduling_link' ||
  step === 'intake_form' ||
  step === 'drop_link';

const isLaunchWizardStepAvailable = (step: LaunchWizardStepId): boolean =>
  !isEndpointStep(step) || isReceptionEndpointKindAvailable(step);

/** The steps that contribute to the Launch Wizard plan — `reception_page`
 *  (→ `page_upsert`) + the endpoint-draft kinds. `scheduling_link` rejoined
 *  in D-173 P4.2 (its visitor slot picker is served cold-start). Hidden
 *  unavailable endpoint kinds (today: only `status_link`, which is not a
 *  wizard step) still exist in the substrate contract, but the wizard must
 *  not offer or dispatch them while their public readers are unwired —
 *  `isLaunchWizardStepAvailable` is the runtime gate. */
export const LAUNCH_WIZARD_PLAN_STEP_SET: ReadonlySet<LaunchWizardStepId> = new Set([
  'reception_page',
  'scheduling_link',
  'intake_form',
  'drop_link',
]);

// ════════════════════════════════════════════════════════════════
// Copy registries — closed-list step + validation-code copy. The
// renderer is the localisation seam; the substrate never assembles
// user-facing strings. tsc enforces completeness over both closed
// lists (`LaunchWizardStepId` is a union; `LaunchWizardValidationCode`
// is a union).
// ════════════════════════════════════════════════════════════════

/** § A.20.1 — per-`LaunchWizardStepId` user-facing copy. `title` is the
 *  stepper heading; `summary` is the "what this step does" body the
 *  renderer shows above the per-step content panel. Keyed on the step
 *  id → tsc enforces completeness over the seven-member closed list. */
export const LAUNCH_WIZARD_STEP_COPY: Readonly<
  Record<LaunchWizardStepId, { title: string; summary: string }>
> = {
  profile_check: {
    title: 'Check who can reach your server',
    summary:
      'Reception is for people who have no account, so your server has to be reachable from the internet. Recued checks this, and offers to change it if it is not.',
  },
  reception_page: {
    title: 'Set up your Reception page',
    summary:
      'Your front door at /reception/. It shows who you are, how to reach you, and how soon you usually answer. Recued fills it in from your profile. Add a tagline and change anything you like.',
  },
  scheduling_link: {
    title: 'Add a scheduling link',
    summary:
      'People pick a time from when you are free. It starts at 30 minutes. Set the times you are around.',
  },
  intake_form: {
    title: 'Add an intake form',
    summary:
      'This starts from the ready-made Client inquiry form. Each answer becomes a promise you have made. Change the boxes before you carry on.',
  },
  drop_link: {
    title: 'Add a drop link',
    summary:
      'A “send me a file” link. Files go straight to your server, and only the kinds you allow. You can skip this if you do not need it yet.',
  },
  view_as_visitor: {
    title: 'Review as a visitor',
    summary:
      'Before anything goes live, see exactly what a visitor would see for each link: what shows, what Recued strips out, and the privacy checks.',
  },
  share: {
    title: 'Share your links',
    summary:
      'Every link you switched on gets a card you can copy into email, a text, or Slack. Send them, and your Reception is live.',
  },
};

/** Closed-list `LaunchWizardValidationCode` → remediation copy. The
 *  wizard surfaces this when `validateLaunchWizardInput` rejects the
 *  wizard-form input. The contract failure also carries a `detail`
 *  string (the inner per-kind validator's first failure) — the renderer
 *  appends it, exactly as the spine's per-kind `*_config_invalid` codes
 *  do. tsc enforces completeness over the five-member closed list. */
export const LAUNCH_WIZARD_VALIDATION_COPY: Readonly<
  Record<LaunchWizardValidationCode, string>
> = {
  input_shape_invalid:
    'Something is missing. Finish every step before you finish setting up.',
  reception_page_invalid:
    'Something is wrong with your Reception page. Open step 2 and check your details, the sections, and the links.',
  scheduling_link_invalid:
    'Something is wrong with your booking link. Open step 3 and check the meeting length and when you are free.',
  intake_form_invalid:
    'Something is wrong with your form. Open step 4 and check the boxes, and what happens when someone sends it.',
  drop_link_invalid:
    'Something is wrong with your file-drop link. Open step 5 and check which file kinds you allow, the size limit, and the end date.',
};

// ════════════════════════════════════════════════════════════════
// Stepper projection — the wizard chrome's core deliverable. The
// stepper is cursor-driven: the page shell holds a `current_step` +
// the `include_drop_link` decision, and re-runs the builder on every
// navigation. The one optional step is `skipped` (greyed, no ordinal)
// when excluded — navigation hops over it.
// ════════════════════════════════════════════════════════════════

/** Per-step status in the stepper. `skipped` is exclusive to the
 *  optional `drop_link` step when the user opted out — it stays visible
 *  in the stepper (so the user sees the wizard's full shape) but
 *  carries no ordinal and navigation hops over it. */
export type LaunchWizardStepStatus = 'complete' | 'current' | 'pending' | 'skipped';

/** One projected stepper step — the projection of one `LaunchWizardStepId`. */
export interface LaunchWizardStepModel {
  step_id: LaunchWizardStepId;
  title: string;
  summary: string;
  /** True for the optional `drop_link` step (§ A.20.1 step 5). */
  is_optional: boolean;
  /** True for the four steps that feed `buildLaunchWizardPlan`'s output
   *  (`reception_page` → `page_upsert`; the three draft kinds →
   *  `endpoint_drafts`). The renderer mounts a config-editing panel for
   *  these four and a review panel for the other three. */
  contributes_to_plan: boolean;
  status: LaunchWizardStepStatus;
  /** 1-based position among the *active* steps (6 when `drop_link` is
   *  skipped, 7 otherwise). `null` for the skipped step — it has no
   *  ordinal. */
  position: number | null;
  /** "Step N of M" — `null` for the skipped step. */
  position_label: string | null;
}

/** The full stepper chrome model. */
export interface LaunchWizardStepperModel {
  /** All seven steps, in `LAUNCH_WIZARD_STEPS` canonical order — the
   *  skipped step stays in the list (greyed) so the user sees the
   *  wizard's full shape. */
  steps: ReadonlyArray<LaunchWizardStepModel>;
  /** The resolved current step. Equals the caller's `current_step`
   *  unless that was the skipped `drop_link` step — then it resolves
   *  forward to the next active step (`view_as_visitor`). */
  current_step: LaunchWizardStepId;
  /** 1-based position of `current_step` among the active steps. */
  current_position: number;
  /** Active-step count — 6 when `drop_link` is skipped, 7 otherwise. */
  total_active_steps: number;
  /** The next / previous active step, or `null` at the ends. */
  next_step: LaunchWizardStepId | null;
  prev_step: LaunchWizardStepId | null;
  is_first_step: boolean;
  is_last_step: boolean;
  /** Whether the optional `drop_link` step is part of this run. */
  includes_drop_link: boolean;
}

/** Build the wizard stepper chrome from the current step cursor + the
 *  optional-drop-link decision. The page shell holds both as live UI
 *  state and re-runs this builder on every navigation. A `current_step`
 *  of the skipped `drop_link` step (defensive — the page shell tracking
 *  `include_drop_link` correctly never passes it) resolves forward to
 *  the next active step. Pure — no I/O. */
export const buildLaunchWizardStepperModel = (args: {
  current_step: LaunchWizardStepId;
  include_drop_link: boolean;
}): LaunchWizardStepperModel => {
  const { current_step, include_drop_link } = args;

  // The renderable sequence — the contract steps minus endpoint kinds
  // that are temporarily unavailable, and minus the optional `drop_link`
  // step when the user opted out.
  const visible_steps = LAUNCH_WIZARD_STEPS.filter(isLaunchWizardStepAvailable);
  const active_steps = LAUNCH_WIZARD_STEPS.filter(
    (s) =>
      isLaunchWizardStepAvailable(s) &&
      (include_drop_link || !LAUNCH_WIZARD_OPTIONAL_STEP_SET.has(s)),
  );

  // Resolve the cursor: if the caller's `current_step` is not active
  // (only `drop_link` can be excluded), step forward to the first
  // active step at or after it in the canonical order.
  const resolved_current: LaunchWizardStepId = active_steps.includes(current_step)
    ? current_step
    : (LAUNCH_WIZARD_STEPS.slice(LAUNCH_WIZARD_STEPS.indexOf(current_step)).find((s) =>
        active_steps.includes(s),
      ) ??
      active_steps[active_steps.length - 1]!);

  const current_active_index = active_steps.indexOf(resolved_current);

  const steps: LaunchWizardStepModel[] = visible_steps.map((step_id) => {
    const copy = LAUNCH_WIZARD_STEP_COPY[step_id];
    const is_optional = LAUNCH_WIZARD_OPTIONAL_STEP_SET.has(step_id);
    const contributes_to_plan = LAUNCH_WIZARD_PLAN_STEP_SET.has(step_id);
    const active_index = active_steps.indexOf(step_id);

    let status: LaunchWizardStepStatus;
    let position: number | null;
    let position_label: string | null;
    if (active_index === -1) {
      // The optional step, excluded from this run.
      status = 'skipped';
      position = null;
      position_label = null;
    } else {
      status =
        active_index < current_active_index
          ? 'complete'
          : active_index === current_active_index
            ? 'current'
            : 'pending';
      position = active_index + 1;
      position_label = `Step ${position} of ${active_steps.length}`;
    }

    return {
      step_id,
      title: copy.title,
      summary: copy.summary,
      is_optional,
      contributes_to_plan,
      status,
      position,
      position_label,
    };
  });

  return {
    steps,
    current_step: resolved_current,
    current_position: current_active_index + 1,
    total_active_steps: active_steps.length,
    next_step: active_steps[current_active_index + 1] ?? null,
    prev_step: active_steps[current_active_index - 1] ?? null,
    is_first_step: current_active_index === 0,
    is_last_step: current_active_index === active_steps.length - 1,
    includes_drop_link: include_drop_link,
  };
};

// ════════════════════════════════════════════════════════════════
// Validation summary — wraps the contract's `validateLaunchWizardInput`
// and resolves each failure code through the copy registry. Mirrors the
// authoring sibling's `summarizeConfigValidation`.
// ════════════════════════════════════════════════════════════════

/** One resolved wizard validation failure — the contract's closed-list
 *  `code` + `step`, the renderer-ready remediation `message`, and the
 *  contract's raw `detail` (which per-kind validator + its first inner
 *  failure tripped). */
export interface LaunchWizardValidationFailureModel {
  code: LaunchWizardValidationCode;
  /** The wizard step the failure belongs to — drives the "fix step N"
   *  jump + the stepper's per-step error badge. */
  step: LaunchWizardStepId;
  message: string;
  detail: string;
}

/** The full validation summary for a wizard-form input. */
export interface LaunchWizardValidationSummary {
  /** True iff `validateLaunchWizardInput` returned zero failures —
   *  structurally implies every endpoint the plan would provision also
   *  validates clean (the contract validator delegates to the same
   *  per-kind validators the create rpc runs). */
  valid: boolean;
  failures: ReadonlyArray<LaunchWizardValidationFailureModel>;
  /** The distinct steps carrying at least one failure — drives the
   *  stepper's per-step error badges without a second walk. */
  failed_steps: ReadonlySet<LaunchWizardStepId>;
}

/** Validate a wizard-form input + resolve every failure through the
 *  copy registry. Takes `unknown` (mirroring the contract validator —
 *  the wizard's working form state can be partial / malformed mid-edit)
 *  and never throws: a malformed blob surfaces as a structured
 *  `input_shape_invalid` / `reception_page_invalid` failure. Pure — no
 *  I/O. */
export const summarizeLaunchWizardValidation = (
  input: unknown,
): LaunchWizardValidationSummary => {
  const rawFailures = validateLaunchWizardInput(input);
  const failures: LaunchWizardValidationFailureModel[] = rawFailures
    .filter((f) => isLaunchWizardStepAvailable(f.step))
    .map((f) => ({
      code: f.code,
      step: f.step,
      message: LAUNCH_WIZARD_VALIDATION_COPY[f.code],
      detail: f.detail,
    }));
  return {
    valid: failures.length === 0,
    failures,
    failed_steps: new Set(failures.map((f) => f.step)),
  };
};

// ════════════════════════════════════════════════════════════════
// Plan projection — projects a `LaunchWizardPlan` into the renderable
// "what will this wizard do" preview: the profile gate, the ordered
// endpoint-draft rows, the "N endpoints" summary.
// ════════════════════════════════════════════════════════════════

/** The § A.20.1 step-1 exposure-profile gate. The wizard surfaces the
 *  *need*; the page shell bridges the "Switch" action to D-148's
 *  exposure rpc (`exposure-surface.ts`) — this module owns no
 *  profile-switch dispatch, the same way the Templates satellite owns no
 *  template-fetch wire mechanism. */
export interface LaunchWizardProfileGate {
  /** True when the server's current exposure profile is not the one
   *  Reception needs — the renderer shows the "Switch" prompt. */
  switch_needed: boolean;
  /** Raw current / recommended exposure-profile ids (opaque strings —
   *  the contract types them `string`; the chrome surfaces them
   *  verbatim, never inventing a mapping the contract does not sanction). */
  current_exposure_profile: string;
  recommended_exposure_profile: string;
  headline: string;
  detail: string;
}

/** One projected endpoint-draft row — the projection of one
 *  `LaunchWizardEndpointDraft`. Carries the kind copy (reused from the
 *  spine's `RECEPTION_KIND_COPY`) + the expiry posture (long-lived for
 *  the scheduling / intake drafts, a bounded `expires_at` for the drop
 *  draft, derived by `buildLaunchWizardPlan` from the config's
 *  `expiry_days`). */
export interface LaunchWizardEndpointDraftModel {
  kind: ReceptionEndpointKind;
  /** Lowercase singular from `RECEPTION_KIND_COPY` — "scheduling link" /
   *  "intake form" / "drop link". The renderer cases it for headings. */
  kind_label: string;
  kind_description: string;
  /** The D-145 packet kind the draft binds to — secondary detail. */
  packet_kind: string;
  /** Full packet declaration — passthrough; the dispatch bridge + the
   *  per-step preview panel both read it. */
  packet_declaration: PacketDeclaration;
  /** The per-kind config blob — passthrough, opaque to this projection
   *  (the per-step authoring panel owns the typed view). */
  metadata: Readonly<Record<string, unknown>>;
  /** True when the draft carries no `expires_at` — the scheduling +
   *  intake kinds permit long-lived, so the planner omits it. */
  is_long_lived: boolean;
  /** The draft's `expires_at` (Unix-ms), normalised from the contract's
   *  optional field to `number | null` so it is uniform with the spine's
   *  row model + feeds `computeExpiryLabel` directly. */
  expires_at: number | null;
  /** Relative expiry label via the shared `computeExpiryLabel` ("Never
   *  expires" for the long-lived drafts, "Expires in N days" for the
   *  drop draft). */
  expiry_label: string;
  /** True for the `drop_link` draft — it comes from the wizard's one
   *  optional step. */
  is_optional_step: boolean;
}

/** Full Reception → Launch Wizard plan-preview model. */
export interface LaunchWizardPlanModel {
  profile_gate: LaunchWizardProfileGate;
  /** The `reception.page.upsert` input — passthrough; `buildLaunchWizardDispatchPlan`
   *  consumes it. */
  page_upsert: ReceptionPageUpsertInput;
  /** One-line "what the page-upsert step does" copy. */
  page_upsert_summary: string;
  /** Endpoint-draft rows for currently available kinds, preserving the
   *  planner's canonical order. */
  endpoint_drafts: ReadonlyArray<LaunchWizardEndpointDraftModel>;
  /** Total endpoints the wizard provisions — the `reception_page`
   *  singleton (always) plus each currently available draft. */
  endpoint_count: number;
  /** `endpoint_drafts.length` — `endpoint_count` minus the page
   *  singleton. */
  draft_count: number;
  includes_drop_link: boolean;
  /** Renderer-ready one-line plan confirmation. */
  summary_label: string;
}

/** `a` / `an` for a noun phrase — `an` before a vowel sound (good
 *  enough for the closed set of kind labels: "scheduling link" → "a",
 *  "intake form" → "an", "drop link" → "a"). */
const indefiniteArticle = (noun: string): string =>
  /^[aeiou]/i.test(noun.trim()) ? 'an' : 'a';

/** Join a list into an Oxford-comma "A, B, and C" phrase. */
const joinWithAnd = (parts: ReadonlyArray<string>): string => {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
};

/** Project one `LaunchWizardEndpointDraft` into a plan-preview row. */
const buildLaunchWizardEndpointDraftModel = (
  draft: LaunchWizardEndpointDraft,
  now: number,
): LaunchWizardEndpointDraftModel => {
  const copy = RECEPTION_KIND_COPY[draft.kind];
  const expires_at = draft.expires_at ?? null;
  return {
    kind: draft.kind,
    kind_label: copy.singular,
    kind_description: copy.description,
    packet_kind: draft.packet_declaration.packet_kind,
    packet_declaration: draft.packet_declaration,
    metadata: draft.metadata,
    is_long_lived: draft.expires_at === undefined,
    expires_at,
    expiry_label: computeExpiryLabel(expires_at, now),
    is_optional_step: draft.kind === 'drop_link',
  };
};

/** Build the renderable Launch Wizard plan-preview model from a
 *  `LaunchWizardPlan` (the page shell builds the plan via the
 *  re-exported `buildLaunchWizardPlan` over the validated wizard-form
 *  input). Pure projection — no I/O. */
export const buildLaunchWizardPlanModel = (args: {
  plan: LaunchWizardPlan;
  now: number;
}): LaunchWizardPlanModel => {
  const { plan, now } = args;

  const profile_gate: LaunchWizardProfileGate = {
    switch_needed: plan.profile_switch_needed,
    current_exposure_profile: plan.current_exposure_profile,
    recommended_exposure_profile: plan.recommended_exposure_profile,
    headline: plan.profile_switch_needed
      ? 'Change who can reach your server'
      : 'Your server can be reached',
    detail: plan.profile_switch_needed
      ? `Reception is for people who have no account, so your server has to be reachable from the internet. Right now it is set to “${plan.current_exposure_profile}” — switch it to “${plan.recommended_exposure_profile}” before you finish setup.`
      : `Your setting (“${plan.recommended_exposure_profile}”) already lets Reception serve anonymous visitors — no change needed.`,
  };

  const endpoint_drafts = plan.endpoint_drafts
    .filter((d) => isReceptionEndpointKindAvailable(d.kind))
    .map((d) => buildLaunchWizardEndpointDraftModel(d, now));
  const includes_drop_link = endpoint_drafts.some((d) => d.kind === 'drop_link');

  // "your Reception page" (always) + each currently available draft,
  // preserving the planner's canonical order.
  const phrases = [
    'your Reception page',
    ...endpoint_drafts.map((d) => `${indefiniteArticle(d.kind_label)} ${d.kind_label}`),
  ];
  const endpoint_count = 1 + endpoint_drafts.length;
  const summary_label = `Provisions ${endpoint_count} ${
    endpoint_count === 1 ? 'endpoint' : 'endpoints'
  } — ${joinWithAnd(phrases)}.`;

  return {
    profile_gate,
    page_upsert: plan.page_upsert,
    page_upsert_summary:
      'Creates or updates your public Reception page at /reception/ — the singleton front door for every other endpoint.',
    endpoint_drafts,
    endpoint_count,
    draft_count: endpoint_drafts.length,
    includes_drop_link,
    summary_label,
  };
};

// ════════════════════════════════════════════════════════════════
// Dispatch plan bridge — shapes the ordered substrate operations the
// wizard executes. The renderer never fires the rpc; this bridge hands
// the page shell the `reception.page.upsert` dispatch + one
// `reception.endpoint.preview_draft` dispatch per draft (each paired
// with its draft). The page shell runs page-upsert, then per draft:
// fire the preview → take the returned `preview_hash` → build the
// create dispatch via the re-exported `buildEndpointCreateDispatch` →
// fire the create. The dispatch *builders* are owned by
// `authoring.ts`; this module owns only the orchestration.
// ════════════════════════════════════════════════════════════════

/** One draft's preview dispatch, paired with the draft it came from —
 *  so the page shell can build the follow-up `reception.endpoint.create`
 *  dispatch (`buildEndpointCreateDispatch({ ...draft, preview_hash })`)
 *  without re-correlating the preview result back to a draft. */
export interface LaunchWizardDraftDispatch {
  draft: LaunchWizardEndpointDraft;
  preview: ReceptionEndpointPreviewDispatch;
}

/** The ordered substrate operations the Launch Wizard executes. */
export interface LaunchWizardDispatchPlan {
  /** `reception.page.upsert` — runs first (the singleton front door). */
  page_upsert: ReceptionPageUpsertDispatch;
  /** One `reception.endpoint.preview_draft` dispatch per currently
   *  available draft, preserving planner order. The page shell runs
   *  preview → create per entry. */
  drafts: ReadonlyArray<LaunchWizardDraftDispatch>;
}

/** Shape the ordered substrate operations from a `LaunchWizardPlan` —
 *  the `reception.page.upsert` dispatch plus one
 *  `reception.endpoint.preview_draft` dispatch per draft. The drop
 *  draft's bounded `expires_at` flows onto its preview dispatch; the
 *  long-lived scheduling / intake drafts omit it (the contract's
 *  preview-input types `expires_at` as `number`, so a long-lived draft
 *  is requested by OMITTING the field — see `ReceptionEndpointPreviewDispatch`).
 *  Pure — no I/O. */
export const buildLaunchWizardDispatchPlan = (
  plan: LaunchWizardPlan,
): LaunchWizardDispatchPlan => ({
  page_upsert: buildReceptionPageUpsertDispatch(plan.page_upsert.config),
  drafts: plan.endpoint_drafts
    .filter((draft) => isReceptionEndpointKindAvailable(draft.kind))
    .map((draft) => ({
      draft,
      preview: buildEndpointPreviewDispatch({
        kind: draft.kind,
        packet_declaration: draft.packet_declaration,
        metadata: draft.metadata,
        ...(draft.expires_at !== undefined ? { expires_at: draft.expires_at } : {}),
      }),
    })),
});

// ════════════════════════════════════════════════════════════════
// Re-exports — so the page shell drives the whole wizard flow with a
// single module import: the contract closed list + validator + planner,
// and the authoring sibling's create-dispatch builder (the page shell
// builds the per-draft create dispatch after each preview round-trip
// via `buildEndpointCreateDispatch({ ...draft, preview_hash })`).
// ════════════════════════════════════════════════════════════════

export {
  LAUNCH_WIZARD_STEPS,
  RECEPTION_RECOMMENDED_EXPOSURE_PROFILE,
  buildLaunchWizardPlan,
  validateLaunchWizardInput,
  buildEndpointCreateDispatch,
};
