/** D-149 § A.20.1 follow-on — Settings → Server → Reception Launch
 *  Wizard renderer acceptance.
 *
 *  `renderLaunchWizard` is a PURE projection of the wizard render view
 *  (the cursor-driven stepper + an optional validation summary + an
 *  optional plan preview, all from `reception-launch-wizard.ts`) to an
 *  HTML string — these tests assert it draws the stepper rail (with the
 *  optional `drop_link` step greyed + un-clickable when excluded), the
 *  current-step frame with its host-filled `data-wizard-step` slot, the
 *  `profile_check` profile gate + `drop_link` toggle chrome, the
 *  validation gate, the plan preview, and the first/last navigation
 *  gating — and escapes every server-/user-supplied string.
 *
 *  Like the authoring-form renderer the wizard renderer has no `mountX`
 *  (it projects a working-config + step-cursor local state with no
 *  container yet), so the tests are pure string assertions. */

import { describe, expect, it } from 'vitest';
import type {
  DropLinkConfig,
  IntakeFormConfig,
  LaunchWizardInput,
  ReceptionPageConfig,
  SchedulingLinkConfig,
} from '@recued/contracts';

import {
  buildLaunchWizardPlan,
  buildLaunchWizardPlanModel,
  buildLaunchWizardStepperModel,
  summarizeLaunchWizardValidation,
  RECEPTION_RECOMMENDED_EXPOSURE_PROFILE,
} from '../settings/reception-launch-wizard.js';
import {
  renderLaunchWizard,
  LAUNCH_WIZARD_ACTIONS,
  LAUNCH_WIZARD_STYLES,
  type LaunchWizardRenderView,
} from '../settings/reception-launch-wizard-render.js';

const NOW = 1_700_000_000_000;

// ── Fixtures — the minimal valid per-kind configs the wizard produces
//    (mirror `d-149-settings-launch-wizard.test.ts`'s `goodWizardInput`).

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

/** A render view at a given step — stepper only, no validation, no plan. */
const stepperView = (
  current_step: Parameters<typeof buildLaunchWizardStepperModel>[0]['current_step'],
  include_drop_link = true,
): LaunchWizardRenderView => ({
  stepper: buildLaunchWizardStepperModel({ current_step, include_drop_link }),
  validation: null,
  plan: null,
});

/** A plan-preview model from a (valid) wizard input. */
const planModel = (over: Partial<LaunchWizardInput> = {}) =>
  buildLaunchWizardPlanModel({
    plan: buildLaunchWizardPlan(mkWizardInput(over), NOW),
    now: NOW,
  });

// ══════════════════════════════════════════════════════════════════
// renderLaunchWizard — header + stepper
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — renderLaunchWizard: header + stepper', () => {
  it('renders the header with the step-of-total progress + a cancel button', () => {
    const html = renderLaunchWizard(stepperView('profile_check'));
    expect(html).toContain('Set up Reception');
    expect(html).toContain('Step 1 of 7');
    expect(html).toContain('data-action="reception-wizard-cancel"');
    expect(html).toContain('data-current-step="profile_check"');
  });

  it('renders all seven steps as goto-step jump targets in the full sequence', () => {
    const html = renderLaunchWizard(stepperView('reception_page', true));
    for (const step of [
      'profile_check',
      'reception_page',
      'scheduling_link',
      'intake_form',
      'drop_link',
      'view_as_visitor',
      'share',
    ]) {
      expect(html).toContain(`data-step-id="${step}"`);
    }
    // Every visible step is a goto-step button.
    expect(html).toContain('data-action="reception-wizard-goto-step"');
  });

  it('marks the current step with aria-current + the --current class', () => {
    const html = renderLaunchWizard(stepperView('scheduling_link'));
    expect(html).toMatch(
      /reception-wizard-step--current[^>]*data-step-id="scheduling_link"[^>]*aria-current="step"/,
    );
  });

  it('renders the excluded optional drop_link step greyed + un-clickable', () => {
    const html = renderLaunchWizard(stepperView('intake_form', false));
    // The drop_link step is present but skipped — a <div>, not a goto-step button.
    expect(html).toContain('reception-wizard-step--skipped');
    expect(html).toMatch(
      /<div[^>]*reception-wizard-step--skipped[^>]*data-step-id="drop_link"/,
    );
    expect(html).not.toMatch(
      /data-action="reception-wizard-goto-step"[^>]*data-step-id="drop_link"/,
    );
    // Six active steps when drop_link is skipped.
    expect(html).toContain('of 6');
  });
});

// ══════════════════════════════════════════════════════════════════
// renderLaunchWizard — current step frame
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — renderLaunchWizard: current step frame', () => {
  it('renders the current step title, summary, and a host-filled content slot', () => {
    const html = renderLaunchWizard(stepperView('reception_page'));
    expect(html).toContain('Set up your Reception page');
    expect(html).toContain('reception-wizard-step-slot');
    expect(html).toContain('data-wizard-step="reception_page"');
  });

  it('the profile_check step with a plan renders the profile gate', () => {
    const plan = planModel();
    const html = renderLaunchWizard({
      stepper: buildLaunchWizardStepperModel({
        current_step: 'profile_check',
        include_drop_link: true,
      }),
      validation: null,
      plan,
    });
    expect(html).toContain('Exposure profile ready');
    // The recommended profile already serves anonymous visitors ⇒ no switch.
    expect(html).not.toContain('data-action="reception-wizard-switch-profile"');
  });

  it('the profile_check gate offers a Switch button when the profile must change', () => {
    const plan = planModel({ current_exposure_profile: 'private_clients_only' });
    const html = renderLaunchWizard({
      stepper: buildLaunchWizardStepperModel({
        current_step: 'profile_check',
        include_drop_link: true,
      }),
      validation: null,
      plan,
    });
    expect(html).toContain('Switch your exposure profile');
    expect(html).toContain('data-action="reception-wizard-switch-profile"');
    expect(html).toContain('private_clients_only');
  });

  it('the drop_link step renders the include / skip toggle', () => {
    const includedHtml = renderLaunchWizard(stepperView('drop_link', true));
    expect(includedHtml).toContain('data-action="reception-wizard-toggle-drop-link"');
    expect(includedHtml).toContain('Skip this optional step');

    const excludedHtml = renderLaunchWizard(stepperView('drop_link', false));
    // When drop_link is excluded the stepper resolves the cursor forward;
    // mount the step explicitly to exercise the excluded-label branch.
    expect(excludedHtml).not.toContain('data-current-step="drop_link"');
  });

  it('the profile gate is absent when no plan has been built yet', () => {
    const html = renderLaunchWizard(stepperView('profile_check'));
    expect(html).not.toContain('Exposure profile ready');
    expect(html).not.toContain('data-action="reception-wizard-switch-profile"');
  });
});

// ══════════════════════════════════════════════════════════════════
// renderLaunchWizard — validation gate
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — renderLaunchWizard: validation gate', () => {
  it('renders no gate for a valid wizard input', () => {
    const validation = summarizeLaunchWizardValidation(mkWizardInput());
    expect(validation.valid).toBe(true);
    const html = renderLaunchWizard({
      stepper: buildLaunchWizardStepperModel({
        current_step: 'share',
        include_drop_link: true,
      }),
      validation,
      plan: null,
    });
    expect(html).not.toContain('before finishing setup');
  });

  it('renders the gate + per-failure goto-step jumps for an invalid input', () => {
    const validation = summarizeLaunchWizardValidation(
      mkWizardInput({ scheduling_link: { ...goodScheduling, display_name: '' } }),
    );
    expect(validation.valid).toBe(false);
    expect(validation.failures.length).toBeGreaterThan(0);
    const html = renderLaunchWizard({
      stepper: buildLaunchWizardStepperModel({
        current_step: 'share',
        include_drop_link: true,
      }),
      validation,
      plan: null,
    });
    expect(html).toContain('before finishing setup');
    expect(html).toContain('data-action="reception-wizard-goto-step"');
    // The failing step is referenced in a goto-step jump.
    const failedStep = validation.failures[0]!.step;
    expect(html).toContain(`data-step-id="${failedStep}"`);
  });

  it('a failed step gets a "Needs attention" badge in the stepper', () => {
    const validation = summarizeLaunchWizardValidation(
      mkWizardInput({ scheduling_link: { ...goodScheduling, display_name: '' } }),
    );
    const html = renderLaunchWizard({
      stepper: buildLaunchWizardStepperModel({
        current_step: 'scheduling_link',
        include_drop_link: true,
      }),
      validation,
      plan: null,
    });
    expect(html).toContain('Needs attention');
  });
});

// ══════════════════════════════════════════════════════════════════
// renderLaunchWizard — plan preview
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — renderLaunchWizard: plan preview', () => {
  it('renders no plan preview when no plan is supplied', () => {
    const html = renderLaunchWizard(stepperView('view_as_visitor'));
    expect(html).not.toContain('What this wizard will set up');
  });

  it('renders the plan preview — page-upsert row + the endpoint draft rows', () => {
    const plan = planModel({ drop_link: goodDrop });
    const html = renderLaunchWizard({
      stepper: buildLaunchWizardStepperModel({
        current_step: 'share',
        include_drop_link: true,
      }),
      validation: null,
      plan,
    });
    expect(html).toContain('What this wizard will set up');
    expect(html).toContain('Reception page');
    expect(html).toContain('scheduling link');
    expect(html).toContain('intake form');
    expect(html).toContain('drop link');
    // The "N endpoints" confirmation line.
    expect(html).toContain(plan.summary_label);
  });

  it('the drop draft row is tagged Optional', () => {
    const plan = planModel({ drop_link: goodDrop });
    const html = renderLaunchWizard({
      stepper: buildLaunchWizardStepperModel({
        current_step: 'share',
        include_drop_link: true,
      }),
      validation: null,
      plan,
    });
    expect(html).toContain('Optional');
  });
});

// ══════════════════════════════════════════════════════════════════
// renderLaunchWizard — navigation
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — renderLaunchWizard: navigation', () => {
  it('disables Back on the first step + offers Next, not Finish', () => {
    const html = renderLaunchWizard(stepperView('profile_check'));
    expect(html).toMatch(/data-action="reception-wizard-prev"[^>]*disabled/);
    expect(html).toContain('data-action="reception-wizard-next"');
    expect(html).not.toContain('data-action="reception-wizard-finish"');
  });

  it('offers Back + Next on a middle step', () => {
    const html = renderLaunchWizard(stepperView('intake_form'));
    expect(html).not.toMatch(/data-action="reception-wizard-prev"[^>]*disabled/);
    expect(html).toContain('data-action="reception-wizard-next"');
  });

  it('offers Finish, not Next, on the last step', () => {
    const html = renderLaunchWizard(stepperView('share'));
    expect(html).toContain('data-action="reception-wizard-finish"');
    expect(html).not.toContain('data-action="reception-wizard-next"');
  });

  it('disables Finish when the validation summary is invalid', () => {
    const validation = summarizeLaunchWizardValidation(
      mkWizardInput({ scheduling_link: { ...goodScheduling, display_name: '' } }),
    );
    const html = renderLaunchWizard({
      stepper: buildLaunchWizardStepperModel({
        current_step: 'share',
        include_drop_link: true,
      }),
      validation,
      plan: null,
    });
    expect(html).toMatch(/data-action="reception-wizard-finish"[^>]*disabled/);
  });

  it('leaves Finish enabled for a valid (or absent) validation summary', () => {
    const html = renderLaunchWizard({
      stepper: buildLaunchWizardStepperModel({
        current_step: 'share',
        include_drop_link: true,
      }),
      validation: summarizeLaunchWizardValidation(mkWizardInput()),
      plan: null,
    });
    expect(html).not.toMatch(/data-action="reception-wizard-finish"[^>]*disabled/);
  });
});

// ══════════════════════════════════════════════════════════════════
// renderLaunchWizard — escaping + action surface + styles
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — renderLaunchWizard: escaping + action surface', () => {
  it('escapes a malicious exposure-profile id in the profile gate', () => {
    const evil = '<script>alert(1)</script>';
    const plan = planModel({ current_exposure_profile: evil });
    const html = renderLaunchWizard({
      stepper: buildLaunchWizardStepperModel({
        current_step: 'profile_check',
        include_drop_link: true,
      }),
      validation: null,
      plan,
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('every emitted data-action is a declared LAUNCH_WIZARD_ACTION', () => {
    const declared = new Set<string>(LAUNCH_WIZARD_ACTIONS);
    const invalidValidation = summarizeLaunchWizardValidation(
      mkWizardInput({ scheduling_link: { ...goodScheduling, display_name: '' } }),
    );
    const plan = planModel({
      current_exposure_profile: 'private_clients_only',
      drop_link: goodDrop,
    });
    const htmls = [
      renderLaunchWizard(stepperView('profile_check')),
      renderLaunchWizard(stepperView('drop_link', true)),
      renderLaunchWizard(stepperView('share')),
      renderLaunchWizard({
        stepper: buildLaunchWizardStepperModel({
          current_step: 'profile_check',
          include_drop_link: true,
        }),
        validation: invalidValidation,
        plan,
      }),
    ];
    for (const html of htmls) {
      for (const m of html.matchAll(/data-action="([^"]+)"/g)) {
        expect(declared).toContain(m[1]);
      }
    }
  });

  it('LAUNCH_WIZARD_STYLES is a non-empty, self-scoped stylesheet', () => {
    expect(LAUNCH_WIZARD_STYLES.length).toBeGreaterThan(0);
    expect(LAUNCH_WIZARD_STYLES).toContain('.reception-wizard');
    expect(LAUNCH_WIZARD_STYLES).toContain('grid-template-columns: repeat(auto-fit');
    expect(LAUNCH_WIZARD_STYLES).toContain('background: var(--surface)');
  });
});
