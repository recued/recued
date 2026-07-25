/** D-149 § A.9 + § A.5.x follow-on — Settings → Server → Reception
 *  per-kind authoring-form renderer acceptance.
 *
 *  `renderAuthoringForm` is a PURE projection of a `<Kind>FormModel`
 *  (from `reception-authoring.ts`) to an HTML string — these tests
 *  assert it dispatches over all six kinds, projects every `Authoring*Field`
 *  control with the right `data-field-*` / `data-repeater-*` markup,
 *  routes the preview-vs-upsert action bar by kind, gates submit on the
 *  validation summary, hides the approval-link options repeater off
 *  `action_kind_requires_options`, and escapes every server-/user-supplied
 *  string.
 *
 *  The renderer has no `mountX` — it projects a working-config local
 *  edit state with no container yet (the page-render handover's decision
 *  #6) — so there is no fake-host / fake-shell harness here; the tests
 *  are pure string assertions, like the `renderReceptionPage` half of
 *  `d-149-settings-reception-page-render.test.ts`. */

import { describe, expect, it } from 'vitest';
import type {
  ApprovalLinkConfig,
  IntakeFormConfig,
  ReceptionPageConfig,
} from '@recued/contracts';
import { INTAKE_FORM_VISITOR_FIELD_TYPES } from '@recued/contracts';

import {
  buildApprovalLinkFormModel,
  buildDropLinkFormModel,
  buildIntakeFormFormModel,
  buildReceptionPageFormModel,
  buildSchedulingLinkFormModel,
  buildStatusLinkFormModel,
  validateSchedulingLinkFormConfig,
  type AuthoringValidationSummary,
} from '../settings/reception-authoring.js';
import {
  renderAuthoringForm,
  AUTHORING_FORM_ACTIONS,
  RECEPTION_AUTHORING_STYLES,
  type AuthoringFormView,
} from '../settings/reception-authoring-render.js';

// ── Fixtures ──────────────────────────────────────────────────────

const receptionPageConfig = (
  overrides: Partial<ReceptionPageConfig> = {},
): ReceptionPageConfig => ({
  display_overrides: {
    display_name: 'Mary',
    tagline: 'Reach me here',
    tz_label: 'Pacific Time',
    preferred_contact_methods: [],
  },
  sections_enabled: {},
  linked_endpoints: {},
  ...overrides,
});

const intakeFormConfig = (): IntakeFormConfig => ({
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
});

/** A minimal `pick_time` approval config — `action_kind: 'pick_time'`
 *  ⇒ `action_kind_requires_options: true`, so the options repeater
 *  renders. */
const pickTimeApprovalConfig = (): ApprovalLinkConfig => ({
  display_name: 'Pick a slot',
  action_kind: 'pick_time',
  prompt: 'Which time works?',
  context_raw: { summary: 'Two options for our sync.' },
  options: [
    { id: 'opt-a', label: 'Tuesday 10am' },
    { id: 'opt-b', label: 'Thursday 2pm' },
  ],
  visitor_field_constraints: { name: 'required', email: 'required' },
  expiry_days: 14,
  on_action: {
    target_id: 'proposal-1',
    on_approve_action: 'mark_resolved',
  },
});

const pageView = (
  overrides: Partial<Extract<AuthoringFormView, { kind: 'reception_page' }>> = {},
): AuthoringFormView => ({
  kind: 'reception_page',
  model: buildReceptionPageFormModel(null),
  validation: null,
  ...overrides,
});

const schedulingView = (
  overrides: Partial<Extract<AuthoringFormView, { kind: 'scheduling_link' }>> = {},
): AuthoringFormView => ({
  kind: 'scheduling_link',
  model: buildSchedulingLinkFormModel(null),
  validation: null,
  ...overrides,
});

const allFreshViews = (): ReadonlyArray<AuthoringFormView> => [
  { kind: 'reception_page', model: buildReceptionPageFormModel(null), validation: null },
  { kind: 'scheduling_link', model: buildSchedulingLinkFormModel(null), validation: null },
  { kind: 'intake_form', model: buildIntakeFormFormModel(null), validation: null },
  { kind: 'drop_link', model: buildDropLinkFormModel(null), validation: null },
  { kind: 'approval_link', model: buildApprovalLinkFormModel(null), validation: null },
  { kind: 'status_link', model: buildStatusLinkFormModel(null), validation: null },
];

// ══════════════════════════════════════════════════════════════════
// renderAuthoringForm — kind dispatch + header
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — renderAuthoringForm: kind dispatch', () => {
  it('renders every one of the six kinds without throwing + tags data-kind', () => {
    for (const view of allFreshViews()) {
      const html = renderAuthoringForm(view);
      expect(html).toContain(`data-kind="${view.kind}"`);
      expect(html).toContain('reception-form-body');
    }
  });

  it('a fresh form renders the per-kind create heading', () => {
    expect(renderAuthoringForm(pageView())).toContain('Set up Reception page');
    expect(renderAuthoringForm(schedulingView())).toContain('New scheduling link');
  });

  it('an edit form (model from a config) renders the "Edit {singular}" heading', () => {
    const html = renderAuthoringForm({
      kind: 'reception_page',
      model: buildReceptionPageFormModel(receptionPageConfig()),
      validation: null,
    });
    expect(html).toContain('Edit reception page');
    expect(html).not.toContain('Set up Reception page');
  });

  it('renders the per-kind section headings', () => {
    const html = renderAuthoringForm(schedulingView());
    expect(html).toContain('Basics');
    expect(html).toContain('Availability');
    expect(html).toContain('Visitor fields');
    expect(html).toContain('Booking rules');
    expect(html).toContain('On booking');
  });
});

// ══════════════════════════════════════════════════════════════════
// renderAuthoringForm — field controls
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — renderAuthoringForm: field controls', () => {
  it('a text field carries data-field-key + data-field-control="text"', () => {
    const html = renderAuthoringForm(pageView());
    expect(html).toContain('data-field-key="display_name"');
    expect(html).toContain('data-field-control="text"');
  });

  it('a multi-line text field renders a <textarea>', () => {
    // scheduling_link.instructions is multiline.
    const html = renderAuthoringForm(schedulingView());
    expect(html).toMatch(/<textarea[^>]*data-field-key="instructions"/);
  });

  it('a text field reflects the working-config value', () => {
    const html = renderAuthoringForm({
      kind: 'reception_page',
      model: buildReceptionPageFormModel(receptionPageConfig({ display_overrides: {
        display_name: 'Mary Tagline Smith',
        tagline: 'Reach me here',
        tz_label: 'Pacific Time',
        preferred_contact_methods: [],
      } })),
      validation: null,
    });
    expect(html).toContain('value="Mary Tagline Smith"');
  });

  it('a number field carries data-field-control="number" + min/max bounds', () => {
    const html = renderAuthoringForm(schedulingView());
    // scheduling_link.min_advance_notice_hours is a bounded number field.
    expect(html).toMatch(
      /<input[^>]*data-field-key="min_advance_notice_hours"[^>]*data-field-control="number"/,
    );
    expect(html).toMatch(/data-field-key="min_advance_notice_hours"[^>]*min="0"/);
  });

  it('a toggle field carries data-field-control="toggle"', () => {
    const html = renderAuthoringForm(schedulingView());
    // scheduling_link.create_calendar_event is a toggle.
    expect(html).toContain('data-field-key="on_booking.create_calendar_event"');
    expect(html).toMatch(
      /data-field-key="on_booking.create_calendar_event"[^>]*data-field-control="toggle"/,
    );
  });

  it('a select field carries data-field-control="select" + marks the current option', () => {
    const html = renderAuthoringForm(schedulingView());
    // ⚠ D-210 Phase C — probed `on_booking.notification_target`, now retired.
    // Re-pointed at a per-visitor-field requirement select, which is the other
    // select on this form and is not going anywhere.
    expect(html).toMatch(
      /data-field-key="required_visitor_fields.email"[^>]*data-field-control="select"/,
    );
    // The fixture sets `required_visitor_fields.email: 'required'`, so that
    // option carries the `selected` marker — which is the half of this test
    // that actually distinguishes a select from any other control.
    expect(html).toMatch(/<option value="required" selected>/);
  });

  it('a multiselect field renders a checkbox per option carrying data-option-value', () => {
    const html = renderAuthoringForm(schedulingView());
    // scheduling_link.duration_options_minutes — multiselect of minutes.
    expect(html).toMatch(
      /data-field-key="duration_options_minutes"[^>]*data-field-control="multiselect"/,
    );
    expect(html).toContain('data-option-value="30"');
    expect(html).toContain('data-option-value="60"');
  });
});

// ══════════════════════════════════════════════════════════════════
// renderAuthoringForm — repeater fields
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — renderAuthoringForm: repeater fields', () => {
  it('an empty repeater renders the empty hint + an Add button, no Remove', () => {
    // reception_page.custom_links — min_rows 0, fresh ⇒ 0 rows.
    const html = renderAuthoringForm(pageView());
    expect(html).toContain('data-repeater-key="custom_links"');
    expect(html).toContain('None yet.');
    expect(html).toContain('data-action="reception-form-add-row"');
    expect(html).not.toContain('data-action="reception-form-remove-row"');
  });

  it('a populated repeater renders one row per entry with the row-index + row-field markup', () => {
    const html = renderAuthoringForm({
      kind: 'reception_page',
      model: buildReceptionPageFormModel(
        receptionPageConfig({
          link_buttons: [
            {
              label: 'My site',
              url: 'https://example.com',
              description: 'Start here',
            },
            { label: 'My blog', url: 'https://blog.example.com' },
          ],
        }),
      ),
      validation: null,
    });
    expect(html).toContain('data-row-index="0"');
    expect(html).toContain('data-row-index="1"');
    expect(html).toContain('data-row-field="label"');
    expect(html).toContain('data-row-field="url"');
    expect(html).toContain('data-repeater-key="link_buttons"');
    expect(html).toContain('data-row-field="description"');
    expect(html).toContain('value="My site"');
    expect(html).toContain('value="https://example.com"');
    expect(html).toContain('value="Start here"');
    // rows.length (2) > min_rows (0) ⇒ each row gets a Remove button.
    expect(html).toContain('data-action="reception-form-remove-row"');
    // I-20 a11y — Add / Remove buttons carry a row-scoped accessible name
    // so a screen reader announces WHICH field + row, not a bare "Remove".
    expect(html).toContain('aria-label="Remove Link buttons row 1"');
    expect(html).toContain('aria-label="Remove Link buttons row 2"');
    expect(html).toContain('aria-label="Add Link buttons row"');
  });

  it('a repeater at its min_rows floor offers no Remove button', () => {
    // intake_form.fields — min_rows 1; a config with exactly one field.
    const html = renderAuthoringForm({
      kind: 'intake_form',
      model: buildIntakeFormFormModel(intakeFormConfig()),
      validation: null,
    });
    expect(html).toContain('data-repeater-key="form_definition.fields"');
    expect(html).toContain('data-row-index="0"');
    expect(html).not.toContain('data-action="reception-form-remove-row"');
  });

  it('intake form-field rows render the name / label / type / required / values cells', () => {
    const html = renderAuthoringForm({
      kind: 'intake_form',
      model: buildIntakeFormFormModel(intakeFormConfig()),
      validation: null,
    });
    expect(html).toContain('data-row-field="name"');
    expect(html).toContain('data-row-field="label"');
    expect(html).toContain('data-row-field="type"');
    expect(html).toContain('data-row-field="required"');
    expect(html).toContain('data-row-field="values"');
    expect(html).toContain('value="your_name"');
  });

  /** D-210 WS3 — the field-builder's type select must offer EVERY contract
   *  field type.
   *
   *  ⚠ Found by a BROWSER verify, not by this suite: the option list was a
   *  hand-maintained copy, so `datetime` was missing and a datetime field
   *  rendered as "Short text" — the select had no matching option and fell back
   *  to its first. Worse than cosmetic: editing anything else in that row would
   *  have written `text` back, silently downgrading the field and orphaning any
   *  calendar mapping that named it. Asserted against the contract's own list so
   *  the next vocabulary addition cannot re-open the gap. */
  it('offers every contract field type in the field-builder type select', () => {
    const html = renderAuthoringForm({
      kind: 'intake_form',
      model: buildIntakeFormFormModel({
        display_name: 'Book a table',
        form_definition: {
          form_definition_id: 'fd_t',
          fields: [
            { name: 'arrives_at', type: 'datetime', label: 'When', required: true },
          ],
        },
        submission_processing_rule: {
          fields_to_include_in_target: [],
          fields_to_attach_as_metadata: [],
        },
        anti_spam: {
          honeypot_fields: [], rate_limit_per_ip: 5,
          require_proof_of_work: false, require_captcha: false,
        },
        required_visitor_fields: { email: 'required' },
      } as never),
      validation: null,
    });
    for (const type of INTAKE_FORM_VISITOR_FIELD_TYPES) {
      // The renderer escapes attribute values, so `array<text>` lands as
      // `array&lt;text&gt;` — compare against the escaped form rather than
      // loosening the assertion to a substring that would match anything.
      const escaped = type.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      expect(html).toContain(`value="${escaped}"`);
    }
    // …and the datetime row's own select is actually SELECTED on it, which is
    // the half a mere "the option exists" check would miss.
    expect(html).toMatch(/value="datetime"\s+selected/);
  });

  it('keeps a RESPONSE-LIST intake form free of entity-mapping controls', () => {
    const html = renderAuthoringForm({
      kind: 'intake_form',
      model: buildIntakeFormFormModel(null),
      validation: null,
    });

    // D-210 A.8 s2b.3 — re-pointed from "log-only" to `form_response`. The
    // BEHAVIOUR under test is unchanged and is the reason this test exists: a
    // destination that keeps the answers themselves has nothing to map INTO
    // another entity, so the projection controls must stay hidden. Only the
    // label moved — "Response log only" (the retired `''` sentinel) became
    // "Response list" (a real destination).
    expect(html).toContain('Response list');
    expect(html).not.toContain('Fields routed into the target entity');
    expect(html).not.toContain('Fields attached as metadata');
    expect(html).not.toContain(
      'data-field-key="submission_processing_rule.fields_to_include_in_target"',
    );
    expect(html).not.toContain(
      'data-field-key="submission_processing_rule.fields_to_attach_as_metadata"',
    );
    expect(html).not.toContain(
      'data-field-key="submission_processing_rule.triggered_recipe_id"',
    );
    expect(html).not.toContain(
      'data-field-key="submission_processing_rule.notification_target"',
    );
  });
});

// ══════════════════════════════════════════════════════════════════
// renderAuthoringForm — action bar (preview vs upsert) + submit gating
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — renderAuthoringForm: action bar', () => {
  it('available link-style kinds offer a "Preview as visitor" button', () => {
    // scheduling_link rejoined this set in D-173 P4.2 (cold-start visitor
    // slot picker is served).
    for (const kind of ['scheduling_link', 'intake_form', 'drop_link', 'approval_link'] as const) {
      const view = allFreshViews().find((v) => v.kind === kind)!;
      expect(renderAuthoringForm(view)).toContain('data-action="reception-form-preview"');
    }
  });

  it('unavailable status_link kind does not offer visitor preview (reader unwired)', () => {
    for (const kind of ['status_link'] as const) {
      const view = allFreshViews().find((v) => v.kind === kind)!;
      expect(renderAuthoringForm(view)).not.toContain('data-action="reception-form-preview"');
    }
  });

  it('the reception_page singleton offers no preview — its upsert has no preview-hash gate', () => {
    const html = renderAuthoringForm(pageView());
    expect(html).not.toContain('data-action="reception-form-preview"');
    expect(html).toContain('data-action="reception-form-submit"');
  });

  it('every form offers submit + cancel', () => {
    for (const view of allFreshViews()) {
      const html = renderAuthoringForm(view);
      expect(html).toContain('data-action="reception-form-submit"');
      expect(html).toContain('data-action="reception-form-cancel"');
    }
  });

  it('a null validation leaves submit enabled', () => {
    const html = renderAuthoringForm(schedulingView({ validation: null }));
    expect(html).not.toMatch(/data-action="reception-form-submit"[^>]*disabled/);
  });

  it('an invalid validation summary disables submit + renders the error panel', () => {
    const validation: AuthoringValidationSummary<string> = {
      valid: false,
      failures: [
        { code: 'display_name_empty', message: 'Enter a display name.', detail: 'display_name' },
      ],
    };
    const html = renderAuthoringForm(schedulingView({ validation }));
    expect(html).toContain('Fix 1 problem before saving');
    expect(html).toContain('Enter a display name.');
    expect(html).toMatch(/data-action="reception-form-submit"[^>]*disabled/);
  });

  it('a valid validation summary leaves submit enabled + renders no error panel', () => {
    const validation = validateSchedulingLinkFormConfig(
      // a minimally valid scheduling config
      {
        display_name: 'Mary',
        duration_options_minutes: [30],
        available_window_definition: {
          tz: 'America/New_York',
          explicit_windows: [{ day_of_week: 1, start_minute: 540, end_minute: 1020 }],
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
      },
    );
    expect(validation.valid).toBe(true);
    const html = renderAuthoringForm(schedulingView({ validation }));
    expect(html).not.toContain('before saving');
    expect(html).not.toMatch(/data-action="reception-form-submit"[^>]*disabled/);
  });
});

// ══════════════════════════════════════════════════════════════════
// renderAuthoringForm — approval_link options repeater gating
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — renderAuthoringForm: approval_link options gating', () => {
  it('hides the options repeater when the action kind does not require options', () => {
    // buildApprovalLinkFormModel(null) ⇒ action_kind 'approve_wording'
    // ⇒ action_kind_requires_options false.
    const model = buildApprovalLinkFormModel(null);
    expect(model.action_kind_requires_options).toBe(false);
    const html = renderAuthoringForm({ kind: 'approval_link', model, validation: null });
    expect(html).not.toContain('data-repeater-key="options"');
  });

  it('shows the options repeater when the action kind requires options', () => {
    const model = buildApprovalLinkFormModel(pickTimeApprovalConfig());
    expect(model.action_kind_requires_options).toBe(true);
    const html = renderAuthoringForm({ kind: 'approval_link', model, validation: null });
    expect(html).toContain('data-repeater-key="options"');
    expect(html).toContain('value="opt-a"');
  });
});

// ══════════════════════════════════════════════════════════════════
// renderAuthoringForm — escaping + action surface + styles
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — renderAuthoringForm: escaping + action surface', () => {
  it('escapes a malicious working-config text value', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const html = renderAuthoringForm({
      kind: 'reception_page',
      model: buildReceptionPageFormModel(
        receptionPageConfig({
          display_overrides: {
            display_name: evil,
            tagline: 'Reach me here',
            tz_label: 'Pacific Time',
            preferred_contact_methods: [],
          },
        }),
      ),
      validation: null,
    });
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes a malicious validation detail string', () => {
    const validation: AuthoringValidationSummary<string> = {
      valid: false,
      failures: [
        { code: 'x', message: 'bad', detail: '<script>alert(1)</script>' },
      ],
    };
    const html = renderAuthoringForm(schedulingView({ validation }));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('every emitted data-action is a declared AUTHORING_FORM_ACTION', () => {
    const declared = new Set<string>(AUTHORING_FORM_ACTIONS);
    const htmls = [
      ...allFreshViews().map((v) => renderAuthoringForm(v)),
      renderAuthoringForm({
        kind: 'reception_page',
        model: buildReceptionPageFormModel(
          receptionPageConfig({ custom_links: [{ label: 'L', url: 'https://e.com' }] }),
        ),
        validation: null,
      }),
      renderAuthoringForm({
        kind: 'approval_link',
        model: buildApprovalLinkFormModel(pickTimeApprovalConfig()),
        validation: {
          valid: false,
          failures: [{ code: 'x', message: 'bad', detail: 'd' }],
        },
      }),
    ];
    for (const html of htmls) {
      for (const m of html.matchAll(/data-action="([^"]+)"/g)) {
        expect(declared).toContain(m[1]);
      }
    }
  });

  it('RECEPTION_AUTHORING_STYLES is a non-empty, self-scoped stylesheet', () => {
    expect(RECEPTION_AUTHORING_STYLES.length).toBeGreaterThan(0);
    expect(RECEPTION_AUTHORING_STYLES).toContain('.reception-form');
    expect(RECEPTION_AUTHORING_STYLES).toContain('min-height: 44px');
    expect(RECEPTION_AUTHORING_STYLES).toContain('background: var(--surface)');
  });
});
