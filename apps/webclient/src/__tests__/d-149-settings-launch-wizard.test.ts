/** D-149 § A.20.1 follow-on — Settings → Server → Reception Launch
 *  Wizard chrome renderer.
 *
 *  Covers the projection layer over the P12 wizard substrate
 *  (`LAUNCH_WIZARD_STEPS` / `validateLaunchWizardInput` /
 *  `buildLaunchWizardPlan`): the step + validation-code copy registries
 *  (+ their closed-list ratchets), the optional / plan step sets, the
 *  cursor-driven stepper (full + drop-skipped sequences, status
 *  derivation, navigation, the defensive cursor resolve), the validation
 *  summary, the plan projection (profile gate, endpoint-draft rows,
 *  summary label), the dispatch plan bridge, and the re-export identity
 *  of the contract closed list + validator + planner + the authoring
 *  sibling's create-dispatch builder. */

import { describe, expect, it } from 'vitest';
import {
  LAUNCH_WIZARD_STEPS as CONTRACT_LAUNCH_WIZARD_STEPS,
  RECEPTION_RECOMMENDED_EXPOSURE_PROFILE as CONTRACT_RECOMMENDED_PROFILE,
  buildLaunchWizardPlan as contractBuildLaunchWizardPlan,
  validateLaunchWizardInput as contractValidateLaunchWizardInput,
  type DropLinkConfig,
  type IntakeFormConfig,
  type LaunchWizardInput,
  type ReceptionPageConfig,
  type SchedulingLinkConfig,
} from '@recued/contracts';
import { buildEndpointCreateDispatch as authoringBuildEndpointCreateDispatch } from '../settings/reception-authoring.js';
import {
  LAUNCH_WIZARD_OPTIONAL_STEP_SET,
  LAUNCH_WIZARD_PLAN_STEP_SET,
  LAUNCH_WIZARD_STEP_COPY,
  LAUNCH_WIZARD_STEPS,
  LAUNCH_WIZARD_VALIDATION_COPY,
  RECEPTION_RECOMMENDED_EXPOSURE_PROFILE,
  buildEndpointCreateDispatch,
  buildLaunchWizardDispatchPlan,
  buildLaunchWizardPlan,
  buildLaunchWizardPlanModel,
  buildLaunchWizardStepperModel,
  summarizeLaunchWizardValidation,
  validateLaunchWizardInput,
} from '../settings/reception-launch-wizard.js';

// ════════════════════════════════════════════════════════════════
// Fixtures — mirror the contract P12 test's `goodWizardInput` shapes
// (the minimal valid per-kind configs the wizard form produces).
// ════════════════════════════════════════════════════════════════

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const goodReceptionPage: ReceptionPageConfig = {
  display_overrides: {
    display_name: 'Mary',
    tagline: 'Reach me here',
    tz_label: 'America/Los_Angeles',
    preferred_contact_methods: [],
  },
  sections_enabled: {},
  linked_endpoints: {},
};

const goodScheduling: SchedulingLinkConfig = {
  display_name: 'Mary Smith',
  duration_options_minutes: [30, 60],
  available_window_definition: {
    tz: 'America/New_York',
    explicit_windows: [{ day_of_week: 1, start_minute: 9 * 60, end_minute: 17 * 60 }],
  },
  required_visitor_fields: {
    name: 'required',
    email: 'required',
    topic: 'optional',
    phone: 'omit',
    notes: 'optional',
  },
  min_advance_notice_hours: 24,
  max_lead_time_days: 30,
  max_bookings_per_day: 0,
  on_booking: {
    create_calendar_event: true,
    create_commitment_entity: true,
  },
};

const goodIntake: IntakeFormConfig = {
  display_name: 'Mary Smith',
  form_definition: {
    form_definition_id: 'fd_client_inquiry_v1',
    fields: [{ name: 'your_name', type: 'text', label: 'Your name', required: true }],
  },
  submission_processing_rule: {
    target_kind: 'task',
    fields_to_include_in_target: ['your_name'],
    fields_to_attach_as_metadata: [],
  },
  anti_spam: {
    honeypot_fields: [],
    rate_limit_per_ip: 5,
    require_proof_of_work: false,
    require_captcha: false,
  },
  required_visitor_fields: { email: 'required' },
};

const goodDrop: DropLinkConfig = {
  display_name: 'Mary Smith',
  link_kind: 'repeated',
  size_cap_bytes: 10 * 1024 * 1024,
  allowed_mime_types: ['application/pdf'],
  expiry_days: 7,
  max_uploads_per_endpoint_per_day: 50,
  required_visitor_fields: { name: 'required', email: 'required', description: 'optional' },
  on_upload: {
    create_data_file_entity: true,
    auto_attach_to_contact: false,
  },
};

const mkWizardInput = (over: Partial<LaunchWizardInput> = {}): LaunchWizardInput => ({
  current_exposure_profile: RECEPTION_RECOMMENDED_EXPOSURE_PROFILE,
  reception_page: goodReceptionPage,
  scheduling_link: goodScheduling,
  intake_form: goodIntake,
  ...over,
});

// ════════════════════════════════════════════════════════════════
// Copy registries — closed-list completeness ratchets
// ════════════════════════════════════════════════════════════════

describe('D-149 launch-wizard — LAUNCH_WIZARD_STEP_COPY', () => {
  it('has non-empty title + summary for every wizard step', () => {
    for (const step of LAUNCH_WIZARD_STEPS) {
      const copy = LAUNCH_WIZARD_STEP_COPY[step];
      expect(copy).toBeDefined();
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.summary.length).toBeGreaterThan(0);
    }
  });

  it('covers exactly the closed-list steps — no stray keys', () => {
    expect(Object.keys(LAUNCH_WIZARD_STEP_COPY).sort()).toEqual([...LAUNCH_WIZARD_STEPS].sort());
  });
});

describe('D-149 launch-wizard — LAUNCH_WIZARD_VALIDATION_COPY', () => {
  it('covers exactly the five validation codes with non-empty copy', () => {
    expect(Object.keys(LAUNCH_WIZARD_VALIDATION_COPY).sort()).toEqual(
      [
        'drop_link_invalid',
        'input_shape_invalid',
        'intake_form_invalid',
        'reception_page_invalid',
        'scheduling_link_invalid',
      ].sort(),
    );
    for (const message of Object.values(LAUNCH_WIZARD_VALIDATION_COPY)) {
      expect(message.length).toBeGreaterThan(0);
    }
  });
});

describe('D-149 launch-wizard — step classification sets', () => {
  it('the optional step set is exactly { drop_link }', () => {
    expect([...LAUNCH_WIZARD_OPTIONAL_STEP_SET]).toEqual(['drop_link']);
  });

  it('the plan step set is the four config steps', () => {
    expect([...LAUNCH_WIZARD_PLAN_STEP_SET].sort()).toEqual(
      ['drop_link', 'intake_form', 'reception_page', 'scheduling_link'].sort(),
    );
  });

  it('both sets are subsets of LAUNCH_WIZARD_STEPS', () => {
    for (const step of [...LAUNCH_WIZARD_OPTIONAL_STEP_SET, ...LAUNCH_WIZARD_PLAN_STEP_SET]) {
      expect(LAUNCH_WIZARD_STEPS).toContain(step);
    }
  });

  it('the plan steps + the three UI-affordance steps partition the seven steps', () => {
    const affordance = LAUNCH_WIZARD_STEPS.filter((s) => !LAUNCH_WIZARD_PLAN_STEP_SET.has(s));
    expect(affordance.sort()).toEqual(['profile_check', 'share', 'view_as_visitor'].sort());
    expect(LAUNCH_WIZARD_PLAN_STEP_SET.size + affordance.length).toBe(LAUNCH_WIZARD_STEPS.length);
  });
});

// ════════════════════════════════════════════════════════════════
// buildLaunchWizardStepperModel
// ════════════════════════════════════════════════════════════════

describe('D-149 launch-wizard — buildLaunchWizardStepperModel (full sequence)', () => {
  it('lists all seven steps in canonical order with seven active steps', () => {
    const model = buildLaunchWizardStepperModel({
      current_step: 'profile_check',
      include_drop_link: true,
    });
    expect(model.steps.map((s) => s.step_id)).toEqual([...LAUNCH_WIZARD_STEPS]);
    expect(model.total_active_steps).toBe(7);
    expect(model.includes_drop_link).toBe(true);
  });

  it('marks the first step current with no prev step', () => {
    const model = buildLaunchWizardStepperModel({
      current_step: 'profile_check',
      include_drop_link: true,
    });
    expect(model.current_step).toBe('profile_check');
    expect(model.current_position).toBe(1);
    expect(model.is_first_step).toBe(true);
    expect(model.is_last_step).toBe(false);
    expect(model.prev_step).toBeNull();
    expect(model.next_step).toBe('reception_page');
    expect(model.steps.find((s) => s.step_id === 'profile_check')!.status).toBe('current');
    expect(model.steps.find((s) => s.step_id === 'reception_page')!.status).toBe('pending');
  });

  it('marks the last step current with no next step', () => {
    const model = buildLaunchWizardStepperModel({
      current_step: 'share',
      include_drop_link: true,
    });
    expect(model.current_position).toBe(7);
    expect(model.is_last_step).toBe(true);
    expect(model.next_step).toBeNull();
    expect(model.prev_step).toBe('view_as_visitor');
    expect(model.steps.every((s) => (s.step_id === 'share' ? s.status === 'current' : s.status === 'complete'))).toBe(
      true,
    );
  });

  it('derives complete / current / pending around a mid-sequence cursor', () => {
    const model = buildLaunchWizardStepperModel({
      current_step: 'intake_form',
      include_drop_link: true,
    });
    const statusOf = (id: string) => model.steps.find((s) => s.step_id === id)!.status;
    expect(statusOf('profile_check')).toBe('complete');
    expect(statusOf('scheduling_link')).toBe('complete');
    expect(statusOf('intake_form')).toBe('current');
    expect(statusOf('drop_link')).toBe('pending');
    expect(statusOf('share')).toBe('pending');
    expect(model.next_step).toBe('drop_link');
    expect(model.prev_step).toBe('scheduling_link');
  });

  it('stamps each step with its copy, optional flag, plan flag, and position label', () => {
    const model = buildLaunchWizardStepperModel({
      current_step: 'profile_check',
      include_drop_link: true,
    });
    const drop = model.steps.find((s) => s.step_id === 'drop_link')!;
    expect(drop.title).toBe(LAUNCH_WIZARD_STEP_COPY.drop_link.title);
    expect(drop.summary).toBe(LAUNCH_WIZARD_STEP_COPY.drop_link.summary);
    expect(drop.is_optional).toBe(true);
    expect(drop.contributes_to_plan).toBe(true);
    expect(drop.position).toBe(5);
    expect(drop.position_label).toBe('Step 5 of 7');

    const profile = model.steps.find((s) => s.step_id === 'profile_check')!;
    expect(profile.is_optional).toBe(false);
    expect(profile.contributes_to_plan).toBe(false);
    expect(profile.position_label).toBe('Step 1 of 7');
  });
});

describe('D-149 launch-wizard — buildLaunchWizardStepperModel (drop-link skipped)', () => {
  it('marks drop_link skipped with no ordinal and six active steps', () => {
    const model = buildLaunchWizardStepperModel({
      current_step: 'intake_form',
      include_drop_link: false,
    });
    expect(model.total_active_steps).toBe(6);
    expect(model.includes_drop_link).toBe(false);
    const drop = model.steps.find((s) => s.step_id === 'drop_link')!;
    expect(drop.status).toBe('skipped');
    expect(drop.position).toBeNull();
    expect(drop.position_label).toBeNull();
    // the skipped step still appears in the list (greyed in the UI)
    expect(model.steps.map((s) => s.step_id)).toEqual([...LAUNCH_WIZARD_STEPS]);
  });

  it('navigation hops over the skipped step in both directions', () => {
    const fromIntake = buildLaunchWizardStepperModel({
      current_step: 'intake_form',
      include_drop_link: false,
    });
    expect(fromIntake.next_step).toBe('view_as_visitor');

    const fromView = buildLaunchWizardStepperModel({
      current_step: 'view_as_visitor',
      include_drop_link: false,
    });
    expect(fromView.prev_step).toBe('intake_form');
  });

  it('position labels count out of six when drop_link is skipped', () => {
    const model = buildLaunchWizardStepperModel({
      current_step: 'view_as_visitor',
      include_drop_link: false,
    });
    expect(model.steps.find((s) => s.step_id === 'view_as_visitor')!.position_label).toBe(
      'Step 5 of 6',
    );
    expect(model.steps.find((s) => s.step_id === 'share')!.position_label).toBe('Step 6 of 6');
  });

  it('resolves a cursor parked on the skipped step forward to the next active step', () => {
    const model = buildLaunchWizardStepperModel({
      current_step: 'drop_link',
      include_drop_link: false,
    });
    // drop_link is not active — the cursor resolves to view_as_visitor.
    expect(model.current_step).toBe('view_as_visitor');
    expect(model.current_position).toBe(5);
    expect(model.steps.find((s) => s.step_id === 'view_as_visitor')!.status).toBe('current');
    expect(model.steps.find((s) => s.step_id === 'drop_link')!.status).toBe('skipped');
  });
});

// ════════════════════════════════════════════════════════════════
// summarizeLaunchWizardValidation
// ════════════════════════════════════════════════════════════════

describe('D-149 launch-wizard — summarizeLaunchWizardValidation', () => {
  it('reports a valid input clean', () => {
    const summary = summarizeLaunchWizardValidation(mkWizardInput());
    expect(summary.valid).toBe(true);
    expect(summary.failures).toEqual([]);
    expect(summary.failed_steps.size).toBe(0);
  });

  it('reports a valid input with the optional drop link clean', () => {
    const summary = summarizeLaunchWizardValidation(mkWizardInput({ drop_link: goodDrop }));
    expect(summary.valid).toBe(true);
  });

  it('flags a non-object input as input_shape_invalid on the profile_check step', () => {
    const summary = summarizeLaunchWizardValidation(null);
    expect(summary.valid).toBe(false);
    expect(summary.failures[0]!.code).toBe('input_shape_invalid');
    expect(summary.failures[0]!.step).toBe('profile_check');
    expect(summary.failures[0]!.message).toBe(
      LAUNCH_WIZARD_VALIDATION_COPY.input_shape_invalid,
    );
  });

  it('returns a structured failure for a malformed reception_page (never throws)', () => {
    const summary = summarizeLaunchWizardValidation({
      ...mkWizardInput(),
      reception_page: {},
    });
    expect(summary.valid).toBe(false);
    expect(
      summary.failures.some(
        (f) => f.code === 'reception_page_invalid' && f.step === 'reception_page',
      ),
    ).toBe(true);
    expect(summary.failed_steps.has('reception_page')).toBe(true);
  });

  it('resolves a per-kind failure copy + tags the owning step + carries the contract detail', () => {
    const summary = summarizeLaunchWizardValidation(
      mkWizardInput({ scheduling_link: { ...goodScheduling, display_name: '' } }),
    );
    const failure = summary.failures.find((f) => f.code === 'scheduling_link_invalid');
    expect(failure).toBeDefined();
    expect(failure!.step).toBe('scheduling_link');
    expect(failure!.message).toBe(LAUNCH_WIZARD_VALIDATION_COPY.scheduling_link_invalid);
    // the contract carries the inner validator's first failure in `detail`
    expect(failure!.detail.length).toBeGreaterThan(0);
    expect(summary.failed_steps.has('scheduling_link')).toBe(true);
  });

  it('flags a bad drop link only when the optional step is present', () => {
    const withBadDrop = summarizeLaunchWizardValidation(
      mkWizardInput({ drop_link: { ...goodDrop, expiry_days: 999 } }),
    );
    expect(
      withBadDrop.failures.some((f) => f.code === 'drop_link_invalid' && f.step === 'drop_link'),
    ).toBe(true);
    // omitting the drop link entirely → no drop_link failure
    const withoutDrop = summarizeLaunchWizardValidation(mkWizardInput());
    expect(withoutDrop.failures.some((f) => f.code === 'drop_link_invalid')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// buildLaunchWizardPlanModel
// ════════════════════════════════════════════════════════════════

describe('D-149 launch-wizard — buildLaunchWizardPlanModel (profile gate)', () => {
  it('does not flag a switch when already on the recommended profile', () => {
    const plan = buildLaunchWizardPlan(mkWizardInput(), NOW);
    const model = buildLaunchWizardPlanModel({ plan, now: NOW });
    expect(model.profile_gate.switch_needed).toBe(false);
    expect(model.profile_gate.headline).toBe('Your server can be reached');
    expect(model.profile_gate.recommended_exposure_profile).toBe(
      RECEPTION_RECOMMENDED_EXPOSURE_PROFILE,
    );
  });

  it('flags a switch + names both profiles when not on the recommended profile', () => {
    const plan = buildLaunchWizardPlan(
      mkWizardInput({ current_exposure_profile: 'lan_only' }),
      NOW,
    );
    const model = buildLaunchWizardPlanModel({ plan, now: NOW });
    expect(model.profile_gate.switch_needed).toBe(true);
    expect(model.profile_gate.headline).toBe('Change who can reach your server');
    expect(model.profile_gate.current_exposure_profile).toBe('lan_only');
    expect(model.profile_gate.detail).toContain('lan_only');
    expect(model.profile_gate.detail).toContain(RECEPTION_RECOMMENDED_EXPOSURE_PROFILE);
  });
});

describe('D-149 launch-wizard — buildLaunchWizardPlanModel (drafts + summary)', () => {
  it('projects the scheduling + intake drafts as long-lived (3 endpoints, no drop link)', () => {
    const plan = buildLaunchWizardPlan(mkWizardInput(), NOW);
    const model = buildLaunchWizardPlanModel({ plan, now: NOW });
    expect(model.endpoint_count).toBe(3);
    expect(model.draft_count).toBe(2);
    expect(model.includes_drop_link).toBe(false);
    expect(model.endpoint_drafts.map((d) => d.kind)).toEqual(['scheduling_link', 'intake_form']);
    for (const draft of model.endpoint_drafts) {
      expect(draft.is_long_lived).toBe(true);
      expect(draft.expires_at).toBeNull();
      expect(draft.expiry_label).toBe('Never expires');
      expect(draft.is_optional_step).toBe(false);
    }
  });

  it('projects the drop draft with a bounded expiry derived from expiry_days', () => {
    const plan = buildLaunchWizardPlan(mkWizardInput({ drop_link: goodDrop }), NOW);
    const model = buildLaunchWizardPlanModel({ plan, now: NOW });
    expect(model.endpoint_count).toBe(4);
    expect(model.draft_count).toBe(3);
    expect(model.includes_drop_link).toBe(true);
    const drop = model.endpoint_drafts.find((d) => d.kind === 'drop_link')!;
    expect(drop.is_long_lived).toBe(false);
    expect(drop.expires_at).toBe(NOW + goodDrop.expiry_days * DAY);
    expect(drop.expiry_label).toBe('Expires in 7 days');
    expect(drop.is_optional_step).toBe(true);
  });

  it('labels each draft from the spine RECEPTION_KIND_COPY and carries the packet declaration', () => {
    const plan = buildLaunchWizardPlan(mkWizardInput({ drop_link: goodDrop }), NOW);
    const model = buildLaunchWizardPlanModel({ plan, now: NOW });
    const sched = model.endpoint_drafts.find((d) => d.kind === 'scheduling_link')!;
    expect(sched.kind_label).toBe('scheduling link');
    expect(sched.packet_kind).toBe('scheduling_link_packet');
    expect(sched.packet_declaration.packet_kind).toBe('scheduling_link_packet');
    const intake = model.endpoint_drafts.find((d) => d.kind === 'intake_form')!;
    expect(intake.kind_label).toBe('intake form');
    expect(intake.metadata).toBe(plan.endpoint_drafts[1]!.metadata);
  });

  it('builds the summary label as an Oxford-comma endpoint list', () => {
    const without = buildLaunchWizardPlanModel({
      plan: buildLaunchWizardPlan(mkWizardInput(), NOW),
      now: NOW,
    });
    expect(without.summary_label).toBe(
      'Provisions 3 endpoints — your Reception page, a scheduling link, and an intake form.',
    );
    const withDrop = buildLaunchWizardPlanModel({
      plan: buildLaunchWizardPlan(mkWizardInput({ drop_link: goodDrop }), NOW),
      now: NOW,
    });
    expect(withDrop.summary_label).toBe(
      'Provisions 4 endpoints — your Reception page, a scheduling link, an intake form, and a drop link.',
    );
  });

  it('passes the reception_page upsert input through + carries a non-empty summary', () => {
    const plan = buildLaunchWizardPlan(mkWizardInput(), NOW);
    const model = buildLaunchWizardPlanModel({ plan, now: NOW });
    expect(model.page_upsert).toBe(plan.page_upsert);
    expect(model.page_upsert.config).toEqual(goodReceptionPage);
    expect(model.page_upsert_summary.length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════
// buildLaunchWizardDispatchPlan
// ════════════════════════════════════════════════════════════════

describe('D-149 launch-wizard — buildLaunchWizardDispatchPlan', () => {
  it('shapes the reception.page.upsert dispatch from the plan page config', () => {
    const plan = buildLaunchWizardPlan(mkWizardInput(), NOW);
    const dispatch = buildLaunchWizardDispatchPlan(plan);
    expect(dispatch.page_upsert).toEqual({
      op: 'reception.page.upsert',
      config: goodReceptionPage,
    });
  });

  it('emits one preview dispatch per draft in the planner canonical order', () => {
    const plan = buildLaunchWizardPlan(mkWizardInput({ drop_link: goodDrop }), NOW);
    const dispatch = buildLaunchWizardDispatchPlan(plan);
    expect(dispatch.drafts.map((d) => d.preview.kind)).toEqual([
      'scheduling_link',
      'intake_form',
      'drop_link',
    ]);
    for (const entry of dispatch.drafts) {
      expect(entry.preview.op).toBe('reception.endpoint.preview_draft');
      expect(entry.preview.kind).toBe(entry.draft.kind);
      expect(entry.preview.packet_declaration).toBe(entry.draft.packet_declaration);
    }
  });

  it('omits expires_at on the long-lived preview dispatches, carries it on the drop draft', () => {
    const plan = buildLaunchWizardPlan(mkWizardInput({ drop_link: goodDrop }), NOW);
    const dispatch = buildLaunchWizardDispatchPlan(plan);
    const sched = dispatch.drafts.find((d) => d.draft.kind === 'scheduling_link')!;
    const intake = dispatch.drafts.find((d) => d.draft.kind === 'intake_form')!;
    const drop = dispatch.drafts.find((d) => d.draft.kind === 'drop_link')!;
    expect('expires_at' in sched.preview).toBe(false);
    expect('expires_at' in intake.preview).toBe(false);
    expect(drop.preview.expires_at).toBe(NOW + goodDrop.expiry_days * DAY);
  });

  it('pairs each preview with its draft so the shell can build the follow-up create dispatch', () => {
    const plan = buildLaunchWizardPlan(mkWizardInput({ drop_link: goodDrop }), NOW);
    const dispatch = buildLaunchWizardDispatchPlan(plan);
    expect(dispatch.drafts.map((d) => d.draft)).toEqual(plan.endpoint_drafts);
    // the page shell composes the create dispatch from the paired draft +
    // the preview_hash the preview round-trip returns.
    const drop = dispatch.drafts.find((d) => d.draft.kind === 'drop_link')!;
    const create = buildEndpointCreateDispatch({ ...drop.draft, preview_hash: 'ph_test' });
    expect(create.op).toBe('reception.endpoint.create');
    expect(create.kind).toBe('drop_link');
    expect(create.preview_hash).toBe('ph_test');
    expect(create.expires_at).toBe(NOW + goodDrop.expiry_days * DAY);
  });
});

// ════════════════════════════════════════════════════════════════
// Re-export identity
// ════════════════════════════════════════════════════════════════

describe('D-149 launch-wizard — re-exports', () => {
  it('re-exports the contract closed list + constants by identity', () => {
    expect(LAUNCH_WIZARD_STEPS).toBe(CONTRACT_LAUNCH_WIZARD_STEPS);
    expect(RECEPTION_RECOMMENDED_EXPOSURE_PROFILE).toBe(CONTRACT_RECOMMENDED_PROFILE);
  });

  it('re-exports the contract validator + planner by identity', () => {
    expect(validateLaunchWizardInput).toBe(contractValidateLaunchWizardInput);
    expect(buildLaunchWizardPlan).toBe(contractBuildLaunchWizardPlan);
  });

  it('re-exports the authoring sibling create-dispatch builder by identity', () => {
    expect(buildEndpointCreateDispatch).toBe(authoringBuildEndpointCreateDispatch);
  });
});
