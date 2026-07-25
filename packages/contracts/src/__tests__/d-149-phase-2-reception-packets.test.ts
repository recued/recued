/** D-149 P2 — `redacted_packet` reception extension (§ A.4 + § A.5).
 *
 *  Slices:
 *    - Closed-list discipline: `REDACTED_PACKET_KINDS` now carries
 *      6 D-145 originals + 6 D-149 reception kinds = 12 total.
 *    - `PACKET_FIELDS_VISIBLE` has the spec-declared closed list per
 *      reception kind; the substrate ratchet passes.
 *    - Per-kind packet build round-trip for every reception kind.
 *    - No-leak structural test per kind (raw input with extra
 *      private fields → only fields_visible reach the payload).
 *    - Per-kind validator rejects shape-mismatched inputs.
 *    - `status_link_packet` clamps `fields_visible_override` to the
 *      per-projection closed-list ceiling (`STATUS_PROJECTION_FIELDS_VISIBLE`).
 *    - `reception_page_packet` projects `cta_buttons` only when the
 *      matching section toggle is enabled AND the linked endpoint
 *      id is set.
 *    - `approval_link_packet` strips counterparty_aliases +
 *      private_notes from context_raw at the boundary.
 *
 *  Spec: D-149 § A.4 + § A.5. */

import { describe, expect, it } from 'vitest';

import {
  APPROVAL_LINK_ACTION_KINDS,
  APPROVAL_LINK_ACTION_KIND_SET,
  DROP_LINK_VISITOR_FIELD_REQUIREMENTS,
  DROP_LINK_VISITOR_FIELD_REQUIREMENT_SET,
  INTAKE_FORM_VISITOR_FIELD_TYPES,
  INTAKE_FORM_VISITOR_FIELD_TYPE_SET,
  PACKET_FIELDS_VISIBLE,
  RECEPTION_PAGE_PREFERRED_CONTACT_METHODS,
  RECEPTION_PAGE_PREFERRED_CONTACT_METHOD_SET,
  REDACTED_PACKET_KINDS,
  REDACTED_PACKET_KIND_SET,
  RedactedPacketValidationError,
  S2S_PREVIEW_PACKET_KINDS,
  S2S_PREVIEW_PACKET_KIND_SET,
  SCHEDULING_LINK_VISITOR_FIELD_REQUIREMENTS,
  SCHEDULING_LINK_VISITOR_FIELD_REQUIREMENT_SET,
  STATUS_LINK_PROJECTION_KINDS,
  STATUS_LINK_PROJECTION_KIND_SET,
  STATUS_PROJECTION_FIELDS_VISIBLE,
  assertRedactedPacketInvariants,
  buildRedactedPacket,
  isS2SPreviewPacketKind,
  type ApprovalLinkPacketRawInput,
  type BuildRedactedPacketOptions,
  type DropLinkPacketRawInput,
  type IntakeFormPacketRawInput,
  type ReceptionPagePacketRawInput,
  type SchedulingLinkPacketRawInput,
  type StatusLinkPacketRawInput,
} from '../index.js';

// ── Helpers ─────────────────────────────────────────────────────────

const FIXED_NOW = 1_715_000_000_000;
const FIXED_TOKEN = 'fixed-test-token-0123456789';
const opts = (
  patch: Partial<BuildRedactedPacketOptions> = {},
): BuildRedactedPacketOptions => ({
  now: FIXED_NOW,
  randomToken: () => FIXED_TOKEN,
  ...patch,
});

const receptionPageRaw = (
  patch: Partial<ReceptionPagePacketRawInput> = {},
): ReceptionPagePacketRawInput => ({
  display_name: 'Mary Smith',
  tagline: 'Reach me here',
  preferred_contact_methods: ['email', 'phone'],
  tz_label: 'America/Los_Angeles',
  ...patch,
});

const schedulingLinkRaw = (
  patch: Partial<SchedulingLinkPacketRawInput> = {},
): SchedulingLinkPacketRawInput => ({
  calendar_events: [],
  window_start: FIXED_NOW,
  window_end: FIXED_NOW + 24 * 60 * 60 * 1000,
  tz: 'America/Los_Angeles',
  duration_options: [15, 30, 60],
  required_visitor_fields: {
    name: 'required',
    email: 'required',
    topic: 'optional',
    phone: 'omit',
    notes: 'omit',
  },
  min_advance_notice_hours: 24,
  max_lead_time_days: 30,
  ...patch,
});

const intakeFormRaw = (
  patch: Partial<IntakeFormPacketRawInput> = {},
): IntakeFormPacketRawInput => ({
  form_definition: {
    form_definition_id: 'fd-1',
    visitor_visible_fields: [
      { name: 'name', type: 'text', label: 'Your name', required: true },
      { name: 'message', type: 'textarea', label: 'Message', required: true },
    ],
  },
  required_fields: ['name', 'message'],
  optional_fields: [],
  submit_button_label: 'Send',
  success_message_template: "Thanks! I'll respond within 24 hours.",
  rate_limit_hint: '10 submissions per hour',
  ...patch,
});

const dropLinkRaw = (
  patch: Partial<DropLinkPacketRawInput> = {},
): DropLinkPacketRawInput => ({
  size_cap_bytes: 100 * 1024 * 1024,
  allowed_mime_types: ['application/pdf', 'image/png'],
  instructions: 'Drop the signed contract here',
  required_visitor_fields: {
    name: 'required',
    email: 'required',
    description: 'optional',
  },
  one_time_use: true,
  expiry_display: 'Expires in 7 days',
  ...patch,
});

const approvalLinkRaw = (
  patch: Partial<ApprovalLinkPacketRawInput> = {},
): ApprovalLinkPacketRawInput => ({
  action_kind: 'pick_time',
  prompt: 'Pick a time that works',
  options: [
    { id: 'slot_1', label: 'Tuesday at 10am' },
    { id: 'slot_2', label: 'Wednesday at 2pm' },
  ],
  expiry_display: 'Expires in 48 hours',
  visitor_field_constraints: { name: 'required', email: 'required' },
  context_raw: {
    summary: 'Please confirm a time for our intro call.',
  },
  ...patch,
});

const statusLinkRaw = (
  patch: Partial<StatusLinkPacketRawInput> = {},
): StatusLinkPacketRawInput => ({
  projection_kind: 'project',
  source_entity_row: {
    title: 'Sicily Trip',
    state: 'active',
    open_commitment_count: 4,
    last_activity_at_relative: '2h ago',
    milestone_summary: 'M1 complete; M2 in progress',
  },
  last_updated_at: FIXED_NOW - 6 * 60 * 60 * 1000,
  now: FIXED_NOW,
  updates_visible: true,
  comments_enabled: false,
  ...patch,
});

// ── Closed-list discipline ──────────────────────────────────────────

describe('D-149 P2 — closed-list discipline (§ A.4)', () => {
  it('REDACTED_PACKET_KINDS contains the 6 D-145 originals + 6 D-149 reception kinds', () => {
    expect(REDACTED_PACKET_KINDS.length).toBe(12);
    const expected = [
      // D-145 originals
      'availability',
      'project_status',
      'commitment_summary',
      'contact_card',
      'event_plan',
      'itinerary',
      // D-149 reception kinds
      'reception_page_packet',
      'scheduling_link_packet',
      'intake_form_packet',
      'drop_link_packet',
      'approval_link_packet',
      'status_link_packet',
    ];
    expect([...REDACTED_PACKET_KINDS]).toEqual(expected);
  });

  it('REDACTED_PACKET_KIND_SET mirrors REDACTED_PACKET_KINDS with no duplicates', () => {
    expect(REDACTED_PACKET_KIND_SET.size).toBe(REDACTED_PACKET_KINDS.length);
    for (const kind of REDACTED_PACKET_KINDS) {
      expect(REDACTED_PACKET_KIND_SET.has(kind)).toBe(true);
    }
  });

  it('PACKET_FIELDS_VISIBLE has the spec-declared closed list per reception kind', () => {
    expect(PACKET_FIELDS_VISIBLE.reception_page_packet).toEqual([
      'display_name',
      'tagline',
      'avatar_url',
      'preferred_contact_methods',
      'cta_buttons',
      'tz_label',
      'response_time_estimate',
    ]);
    expect(PACKET_FIELDS_VISIBLE.scheduling_link_packet).toEqual([
      'free_windows',
      'tz',
      'duration_options',
      'required_visitor_fields',
      'min_advance_notice_hours',
      'max_lead_time_days',
    ]);
    expect(PACKET_FIELDS_VISIBLE.intake_form_packet).toEqual([
      'form_definition',
      'required_fields',
      'optional_fields',
      'submit_button_label',
      'success_message_template',
      'rate_limit_hint',
    ]);
    expect(PACKET_FIELDS_VISIBLE.drop_link_packet).toEqual([
      'size_cap_bytes',
      'allowed_mime_types',
      'instructions',
      'required_visitor_fields',
      'one_time_use',
      'expiry_display',
    ]);
    expect(PACKET_FIELDS_VISIBLE.approval_link_packet).toEqual([
      'action_kind',
      'prompt',
      'options',
      'expiry_display',
      'visitor_field_constraints',
      'context_summary',
    ]);
    expect(PACKET_FIELDS_VISIBLE.status_link_packet).toEqual([
      'projection_kind',
      'visible_fields',
      'last_updated_at_relative',
      'updates_visible',
      'comments_enabled',
    ]);
  });

  it('assertRedactedPacketInvariants ratchet passes with reception kinds wired', () => {
    expect(() => assertRedactedPacketInvariants()).not.toThrow();
  });
});

// ── Per-kind closed-list constants ──────────────────────────────────

describe('D-149 P2 — per-kind closed-list constants', () => {
  it('RECEPTION_PAGE_PREFERRED_CONTACT_METHODS has 4 entries; set mirrors array', () => {
    expect(RECEPTION_PAGE_PREFERRED_CONTACT_METHODS).toEqual(['email', 'phone', 'slack', 'telegram']);
    expect(RECEPTION_PAGE_PREFERRED_CONTACT_METHOD_SET.size).toBe(4);
  });

  it('SCHEDULING_LINK_VISITOR_FIELD_REQUIREMENTS has 3 entries; set mirrors array', () => {
    expect(SCHEDULING_LINK_VISITOR_FIELD_REQUIREMENTS).toEqual(['required', 'optional', 'omit']);
    expect(SCHEDULING_LINK_VISITOR_FIELD_REQUIREMENT_SET.size).toBe(3);
  });

  it('INTAKE_FORM_VISITOR_FIELD_TYPES excludes forbidden field types (no ref<T>/password/signature/trusted_html)', () => {
    // TWO different guards, and they must not be confused for each other:
    //
    //   - The exact list is a RATCHET. Widening the vocabulary a visitor form
    //     can render is a deliberate act, so it must edit this baseline rather
    //     than slip in. `'datetime'` is D-210 WS3's deliberate addition (a
    //     calendar destination needs a start INSTANT, not just a day).
    //   - The forbidden loop below is the actual PRIVACY FENCE — the shapes
    //     that must never be collectable through a public form. Never relax
    //     THAT one to make an addition pass.
    expect(INTAKE_FORM_VISITOR_FIELD_TYPES).toEqual([
      'text',
      'textarea',
      'number',
      'boolean',
      'date',
      'datetime',
      'enum',
      'array<text>',
      'file',
    ]);
    for (const forbidden of ['ref', 'password', 'signature', 'trusted_html']) {
      expect(INTAKE_FORM_VISITOR_FIELD_TYPE_SET.has(forbidden as never)).toBe(false);
    }
  });

  it('DROP_LINK_VISITOR_FIELD_REQUIREMENTS has 3 entries; set mirrors array', () => {
    expect(DROP_LINK_VISITOR_FIELD_REQUIREMENTS).toEqual(['required', 'optional', 'omit']);
    expect(DROP_LINK_VISITOR_FIELD_REQUIREMENT_SET.size).toBe(3);
  });

  it('APPROVAL_LINK_ACTION_KINDS lists the 5 closed-list actions', () => {
    expect(APPROVAL_LINK_ACTION_KINDS).toEqual([
      'pick_time',
      'approve_wording',
      'confirm_attendance',
      'answer_question',
      'upload_doc',
    ]);
    expect(APPROVAL_LINK_ACTION_KIND_SET.size).toBe(5);
  });

  it('STATUS_LINK_PROJECTION_KINDS lists the 6 spec-declared projections', () => {
    expect(STATUS_LINK_PROJECTION_KINDS).toEqual([
      'event_plan',
      'itinerary',
      'project',
      'packing_list',
      'commitment_summary',
      'custom',
    ]);
    expect(STATUS_LINK_PROJECTION_KIND_SET.size).toBe(6);
  });

  it('STATUS_PROJECTION_FIELDS_VISIBLE has an entry for every projection kind', () => {
    for (const kind of STATUS_LINK_PROJECTION_KINDS) {
      const fields = STATUS_PROJECTION_FIELDS_VISIBLE[kind];
      expect(Array.isArray(fields)).toBe(true);
      expect(fields.length).toBeGreaterThan(0);
    }
  });

  it('STATUS_PROJECTION_FIELDS_VISIBLE mirrors spec § A.5.6 line 940-946', () => {
    expect(STATUS_PROJECTION_FIELDS_VISIBLE.event_plan).toEqual([
      'title',
      'date',
      'location_label',
      'agenda_summary',
      'visible_attendees',
      'tz_label',
    ]);
    expect(STATUS_PROJECTION_FIELDS_VISIBLE.itinerary).toEqual([
      'title',
      'date_range',
      'visible_legs',
    ]);
    expect(STATUS_PROJECTION_FIELDS_VISIBLE.project).toEqual([
      'title',
      'state',
      'open_commitment_count',
      'last_activity_at_relative',
      'milestone_summary',
    ]);
    expect(STATUS_PROJECTION_FIELDS_VISIBLE.packing_list).toEqual([
      'title',
      'items',
      'packed_count',
      'total_count',
      'due_date_relative',
    ]);
    expect(STATUS_PROJECTION_FIELDS_VISIBLE.commitment_summary).toEqual([
      'title',
      'state',
      'due_at_relative',
      'counterparty_first_name_initial',
    ]);
  });
});

// ── Per-kind round-trip builds ──────────────────────────────────────

describe('D-149 P2 — reception_page_packet build (§ A.5.1)', () => {
  it('builds the closed-list payload', () => {
    const packet = buildRedactedPacket('reception_page_packet', receptionPageRaw(), opts());
    expect(packet.packet_kind).toBe('reception_page_packet');
    expect(packet.fields_visible).toEqual(PACKET_FIELDS_VISIBLE.reception_page_packet);
    expect(packet.payload.display_name).toBe('Mary Smith');
    expect(packet.payload.tagline).toBe('Reach me here');
    expect(packet.payload.preferred_contact_methods).toEqual(['email', 'phone']);
    expect(packet.payload.cta_buttons).toEqual([]);
    expect(packet.payload.tz_label).toBe('America/Los_Angeles');
  });

  it('projects cta_buttons only when the matching section toggle is true AND the linked endpoint id is set', () => {
    const packet = buildRedactedPacket(
      'reception_page_packet',
      receptionPageRaw({
        section_config: {
          availability_cta: true,
          intake_cta: true,
          drop_cta: false, // CTA suppressed even though endpoint id is set
        },
        linked_endpoints: {
          scheduling_link_endpoint_id: 'sched-1',
          intake_form_endpoint_id: 'intake-1',
          drop_link_endpoint_id: 'drop-1',
        },
      }),
      opts(),
    );
    // D-149 P4 Codex review fold (2026-05-13) — `ReceptionPageCtaButton`
    // now carries `href`. With no `<kind>_share_url` set, the projector
    // emits the token-less fallback path.
    expect(packet.payload.cta_buttons).toEqual([
      {
        label: 'Schedule a meeting',
        endpoint_id: 'sched-1',
        kind: 'scheduling_link',
        href: '/reception/scheduling/sched-1',
      },
      {
        label: 'Send a message',
        endpoint_id: 'intake-1',
        kind: 'intake_form',
        href: '/reception/intake/intake-1',
      },
    ]);
  });

  it('suppresses cta_buttons when the section toggle is true but the endpoint id is missing', () => {
    const packet = buildRedactedPacket(
      'reception_page_packet',
      receptionPageRaw({
        section_config: { availability_cta: true },
        // No linked_endpoints — toggle alone is not enough
      }),
      opts(),
    );
    expect(packet.payload.cta_buttons).toEqual([]);
  });

  it('drops section_config + linked_endpoints from the visible payload (no-leak structural)', () => {
    const packet = buildRedactedPacket(
      'reception_page_packet',
      receptionPageRaw({
        section_config: { availability_cta: true, intake_cta: true, drop_cta: true, custom_links: true },
        linked_endpoints: {
          scheduling_link_endpoint_id: 'sched-1',
          intake_form_endpoint_id: 'intake-1',
          drop_link_endpoint_id: 'drop-1',
        },
      }),
      opts(),
    );
    const payloadKeys = Object.keys(packet.payload);
    expect(payloadKeys).not.toContain('section_config');
    expect(payloadKeys).not.toContain('linked_endpoints');
    for (const key of payloadKeys) {
      expect(PACKET_FIELDS_VISIBLE.reception_page_packet).toContain(key);
    }
  });

  it('optional fields stay absent from the payload when not supplied', () => {
    const packet = buildRedactedPacket('reception_page_packet', receptionPageRaw(), opts());
    expect(Object.prototype.hasOwnProperty.call(packet.payload, 'avatar_url')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(packet.payload, 'response_time_estimate')).toBe(false);
  });

  it('rejects unknown preferred_contact_methods entries', () => {
    expect(() =>
      buildRedactedPacket(
        'reception_page_packet',
        receptionPageRaw({
          preferred_contact_methods: ['email', 'carrier_pigeon' as never],
        }),
        opts(),
      ),
    ).toThrow(RedactedPacketValidationError);
  });
});

describe('D-149 P2 — scheduling_link_packet build (§ A.5.2)', () => {
  it('builds the closed-list payload + computes free_windows', () => {
    const packet = buildRedactedPacket('scheduling_link_packet', schedulingLinkRaw(), opts());
    expect(packet.packet_kind).toBe('scheduling_link_packet');
    expect(packet.payload.free_windows).toEqual([
      { start_at: FIXED_NOW, end_at: FIXED_NOW + 24 * 60 * 60 * 1000 },
    ]);
    expect(packet.payload.tz).toBe('America/Los_Angeles');
    expect(packet.payload.duration_options).toEqual([15, 30, 60]);
    expect(packet.payload.min_advance_notice_hours).toBe(24);
    expect(packet.payload.max_lead_time_days).toBe(30);
  });

  it('subtracts a busy event from free_windows', () => {
    const busyStart = FIXED_NOW + 60 * 60 * 1000;
    const busyEnd = FIXED_NOW + 2 * 60 * 60 * 1000;
    const packet = buildRedactedPacket(
      'scheduling_link_packet',
      schedulingLinkRaw({
        calendar_events: [{ start_at: busyStart, end_at: busyEnd }],
      }),
      opts(),
    );
    expect(packet.payload.free_windows.length).toBe(2);
    expect(packet.payload.free_windows[0]).toEqual({ start_at: FIXED_NOW, end_at: busyStart });
    expect(packet.payload.free_windows[1]).toEqual({
      start_at: busyEnd,
      end_at: FIXED_NOW + 24 * 60 * 60 * 1000,
    });
  });

  it('drops raw calendar_events from the visible payload (no-leak structural)', () => {
    // Spec § A.5.2 line 681 no-leak test — event titles / attendees /
    // agendas live on the raw shape but must never reach the payload.
    const packet = buildRedactedPacket(
      'scheduling_link_packet',
      schedulingLinkRaw({
        calendar_events: [{ start_at: FIXED_NOW + 1000, end_at: FIXED_NOW + 2000 }],
      }),
      opts(),
    );
    const payloadKeys = Object.keys(packet.payload);
    expect(payloadKeys).not.toContain('calendar_events');
    expect(payloadKeys).not.toContain('window_start');
    expect(payloadKeys).not.toContain('window_end');
    for (const key of payloadKeys) {
      expect(PACKET_FIELDS_VISIBLE.scheduling_link_packet).toContain(key);
    }
  });

  it('rejects unknown required_visitor_fields requirement values', () => {
    expect(() =>
      buildRedactedPacket(
        'scheduling_link_packet',
        schedulingLinkRaw({
          required_visitor_fields: {
            name: 'required',
            email: 'required',
            topic: 'mandatory' as never,
            phone: 'omit',
            notes: 'omit',
          },
        }),
        opts(),
      ),
    ).toThrow(RedactedPacketValidationError);
  });

  it('rejects non-numeric min_advance_notice_hours', () => {
    expect(() =>
      buildRedactedPacket(
        'scheduling_link_packet',
        schedulingLinkRaw({ min_advance_notice_hours: 'twenty-four' as never }),
        opts(),
      ),
    ).toThrow(RedactedPacketValidationError);
  });
});

describe('D-149 P2 — intake_form_packet build (§ A.5.3)', () => {
  it('builds the closed-list payload + rebuilds visitor_visible_fields per-item', () => {
    const packet = buildRedactedPacket('intake_form_packet', intakeFormRaw(), opts());
    expect(packet.packet_kind).toBe('intake_form_packet');
    expect(packet.payload.form_definition.form_definition_id).toBe('fd-1');
    expect(packet.payload.form_definition.visitor_visible_fields).toEqual([
      { name: 'name', type: 'text', label: 'Your name', required: true },
      { name: 'message', type: 'textarea', label: 'Message', required: true },
    ]);
    expect(packet.payload.required_fields).toEqual(['name', 'message']);
    expect(packet.payload.submit_button_label).toBe('Send');
  });

  it('drops user-only annotations from form fields (no-leak structural)', () => {
    // A caller-supplied field with extra annotation keys
    // (e.g., `internal_classification`, `user_only_visibility`) must
    // not leak into the visitor payload — the transform rebuilds
    // each field from the closed shape.
    const packet = buildRedactedPacket(
      'intake_form_packet',
      intakeFormRaw({
        form_definition: {
          form_definition_id: 'fd-2',
          visitor_visible_fields: [
            {
              name: 'name',
              type: 'text',
              label: 'Your name',
              required: true,
              // Extra fields the caller might attach
              ...({ internal_classification: 'vendor_inquiry' } as Record<string, unknown>),
            },
          ],
        },
      }),
      opts(),
    );
    const field = packet.payload.form_definition.visitor_visible_fields[0]!;
    expect(Object.keys(field).sort()).toEqual(['label', 'name', 'required', 'type']);
    expect(Object.prototype.hasOwnProperty.call(field, 'internal_classification')).toBe(false);
  });

  it('rejects an empty form_definition_id', () => {
    expect(() =>
      buildRedactedPacket(
        'intake_form_packet',
        intakeFormRaw({
          form_definition: {
            form_definition_id: '',
            visitor_visible_fields: [],
          },
        }),
        opts(),
      ),
    ).toThrow(RedactedPacketValidationError);
  });

  it('rejects a forbidden field type (password)', () => {
    expect(() =>
      buildRedactedPacket(
        'intake_form_packet',
        intakeFormRaw({
          form_definition: {
            form_definition_id: 'fd-1',
            visitor_visible_fields: [
              { name: 'secret', type: 'password' as never, label: 'Secret', required: true },
            ],
          },
        }),
        opts(),
      ),
    ).toThrow(RedactedPacketValidationError);
  });
});

describe('D-149 P2 — drop_link_packet build (§ A.5.4)', () => {
  it('builds the closed-list payload', () => {
    const packet = buildRedactedPacket('drop_link_packet', dropLinkRaw(), opts());
    expect(packet.packet_kind).toBe('drop_link_packet');
    expect(packet.payload.size_cap_bytes).toBe(100 * 1024 * 1024);
    expect(packet.payload.allowed_mime_types).toEqual(['application/pdf', 'image/png']);
    expect(packet.payload.one_time_use).toBe(true);
    expect(packet.payload.expiry_display).toBe('Expires in 7 days');
  });

  it('drops fields not in PACKET_FIELDS_VISIBLE (no-leak structural)', () => {
    const packet = buildRedactedPacket('drop_link_packet', dropLinkRaw(), opts());
    const payloadKeys = Object.keys(packet.payload);
    for (const key of payloadKeys) {
      expect(PACKET_FIELDS_VISIBLE.drop_link_packet).toContain(key);
    }
  });

  it('rejects size_cap_bytes ≤ 0', () => {
    expect(() =>
      buildRedactedPacket('drop_link_packet', dropLinkRaw({ size_cap_bytes: 0 }), opts()),
    ).toThrow(RedactedPacketValidationError);
  });
});

describe('D-149 P2 — approval_link_packet build (§ A.5.5)', () => {
  it('builds the closed-list payload + emits context_summary from context_raw.summary', () => {
    const packet = buildRedactedPacket('approval_link_packet', approvalLinkRaw(), opts());
    expect(packet.packet_kind).toBe('approval_link_packet');
    expect(packet.payload.action_kind).toBe('pick_time');
    expect(packet.payload.prompt).toBe('Pick a time that works');
    expect(packet.payload.context_summary).toBe('Please confirm a time for our intro call.');
  });

  it('strips counterparty_aliases + private_notes from context_raw at boundary (no-leak structural)', () => {
    // Spec § A.5.5 line 913 no-leak test — the visitor sees only
    // prompt + options + context_summary; counterparty_aliases +
    // private_notes from context_raw must NEVER appear.
    const packet = buildRedactedPacket(
      'approval_link_packet',
      approvalLinkRaw({
        context_raw: {
          summary: 'Please confirm a time.',
          counterparty_aliases: ['internal:big-vendor', 'cipher:acme-corp'],
          private_notes: ['Got bad vibes at last call', 'Pricing tier B'],
        },
      }),
      opts(),
    );
    const payloadJson = JSON.stringify(packet.payload);
    expect(payloadJson).not.toContain('internal:big-vendor');
    expect(payloadJson).not.toContain('cipher:acme-corp');
    expect(payloadJson).not.toContain('Got bad vibes');
    expect(payloadJson).not.toContain('Pricing tier B');
    const payloadKeys = Object.keys(packet.payload);
    expect(payloadKeys).not.toContain('context_raw');
    expect(payloadKeys).not.toContain('counterparty_aliases');
    expect(payloadKeys).not.toContain('private_notes');
  });

  it('rebuilds each option from the closed shape (drops caller-supplied extras)', () => {
    // The option's closed shape is `{ id, label, description? }`;
    // a caller-supplied extra (e.g., `internal_priority`) must NOT
    // surface in the visitor payload — the transform rebuilds each
    // option from the closed fields.
    const packet = buildRedactedPacket(
      'approval_link_packet',
      approvalLinkRaw({
        options: [
          {
            id: 'slot_1',
            label: 'Tuesday 10am',
            description: 'Coffee chat',
            internal_priority: 'high',
          } as never,
        ],
      }),
      opts(),
    );
    const opt = packet.payload.options?.[0]!;
    expect(Object.keys(opt).sort()).toEqual(['description', 'id', 'label']);
  });

  it('rejects unknown action_kind values', () => {
    expect(() =>
      buildRedactedPacket(
        'approval_link_packet',
        approvalLinkRaw({ action_kind: 'unknown_action' as never }),
        opts(),
      ),
    ).toThrow(RedactedPacketValidationError);
  });
});

describe('D-149 P2 — status_link_packet build (§ A.5.6)', () => {
  it('builds the closed-list payload + computes last_updated_at_relative', () => {
    const packet = buildRedactedPacket('status_link_packet', statusLinkRaw(), opts());
    expect(packet.packet_kind).toBe('status_link_packet');
    expect(packet.payload.projection_kind).toBe('project');
    expect(packet.payload.last_updated_at_relative).toBe('6h ago');
    expect(packet.payload.updates_visible).toBe(true);
    expect(packet.payload.comments_enabled).toBe(false);
  });

  it('clamps fields_visible_override to the per-projection closed-list ceiling', () => {
    // The user supplied an override that includes a field OUTSIDE the
    // ceiling; the substrate must drop it silently rather than leak.
    const packet = buildRedactedPacket(
      'status_link_packet',
      statusLinkRaw({
        source_entity_row: {
          title: 'Sicily Trip',
          state: 'active',
          // Outside the ceiling — should NEVER reach the payload
          internal_notes: 'do not share',
          counterparty_email: 'bob@example.com',
        },
        fields_visible_override: ['title', 'state', 'internal_notes', 'counterparty_email'],
      }),
      opts(),
    );
    const visible = packet.payload.visible_fields;
    expect(Object.keys(visible).sort()).toEqual(['state', 'title']);
    expect(visible).not.toHaveProperty('internal_notes');
    expect(visible).not.toHaveProperty('counterparty_email');
  });

  it('drops deep-link refs from source_entity_row (no-leak structural)', () => {
    // Spec § A.5.6 line 958 no-leak test — deep-link refs into
    // related entities must never surface. The substrate filters by
    // the closed-list ceiling; extra fields on source_entity_row are
    // dropped at boundary.
    const packet = buildRedactedPacket(
      'status_link_packet',
      statusLinkRaw({
        source_entity_row: {
          title: 'Sicily Trip',
          state: 'active',
          open_commitment_count: 4,
          milestone_summary: 'M1 complete',
          last_activity_at_relative: '2h ago',
          // Sensitive deep links — must NOT appear
          linked_mail_ids: ['mail-1', 'mail-2'],
          linked_task_ids: ['task-1'],
          standing_instruction_text: 'auto-confirm vendors',
          vault_refs: ['vault.api.openai'],
        },
      }),
      opts(),
    );
    const visible = packet.payload.visible_fields;
    expect(visible).not.toHaveProperty('linked_mail_ids');
    expect(visible).not.toHaveProperty('linked_task_ids');
    expect(visible).not.toHaveProperty('standing_instruction_text');
    expect(visible).not.toHaveProperty('vault_refs');
    for (const key of Object.keys(visible)) {
      expect(STATUS_PROJECTION_FIELDS_VISIBLE.project).toContain(key);
    }
  });

  it('falls back to the projection-kind ceiling when no override is supplied', () => {
    const packet = buildRedactedPacket('status_link_packet', statusLinkRaw(), opts());
    const visible = packet.payload.visible_fields;
    // raw row carries all ceiling fields → all should be visible
    expect(Object.keys(visible).sort()).toEqual(
      [...STATUS_PROJECTION_FIELDS_VISIBLE.project].sort(),
    );
  });

  it('rejects unknown projection_kind', () => {
    expect(() =>
      buildRedactedPacket(
        'status_link_packet',
        statusLinkRaw({ projection_kind: 'random_view' as never }),
        opts(),
      ),
    ).toThrow(RedactedPacketValidationError);
  });
});

// ── Strict-pick boundary discipline (top-level extras) ─────────────

// ── Codex review folds (2026-05-13) ─────────────────────────────────

describe('D-149 P2 — Codex P1 #3 fold: S2S_PREVIEW_PACKET_KINDS subset gate', () => {
  it('S2S_PREVIEW_PACKET_KINDS lists ONLY the 6 D-145 originals', () => {
    expect([...S2S_PREVIEW_PACKET_KINDS].sort()).toEqual([
      'availability',
      'commitment_summary',
      'contact_card',
      'event_plan',
      'itinerary',
      'project_status',
    ]);
    expect(S2S_PREVIEW_PACKET_KIND_SET.size).toBe(6);
  });

  it('isS2SPreviewPacketKind rejects every reception kind', () => {
    expect(isS2SPreviewPacketKind('reception_page_packet')).toBe(false);
    expect(isS2SPreviewPacketKind('scheduling_link_packet')).toBe(false);
    expect(isS2SPreviewPacketKind('intake_form_packet')).toBe(false);
    expect(isS2SPreviewPacketKind('drop_link_packet')).toBe(false);
    expect(isS2SPreviewPacketKind('approval_link_packet')).toBe(false);
    expect(isS2SPreviewPacketKind('status_link_packet')).toBe(false);
  });

  it('isS2SPreviewPacketKind accepts every D-145 original', () => {
    for (const kind of S2S_PREVIEW_PACKET_KINDS) {
      expect(isS2SPreviewPacketKind(kind)).toBe(true);
    }
  });

  it('every reception kind is in REDACTED_PACKET_KINDS but NOT in S2S_PREVIEW_PACKET_KINDS', () => {
    const receptionKinds = [
      'reception_page_packet',
      'scheduling_link_packet',
      'intake_form_packet',
      'drop_link_packet',
      'approval_link_packet',
      'status_link_packet',
    ] as const;
    for (const kind of receptionKinds) {
      expect(REDACTED_PACKET_KIND_SET.has(kind)).toBe(true);
      expect(S2S_PREVIEW_PACKET_KIND_SET.has(kind as never)).toBe(false);
    }
  });
});

describe('D-149 P2 — Codex P1 #1 fold: max_ttl_ms lifts D-145 30d clamp', () => {
  it('passes opts.max_ttl_ms through to the substrate clamp (default 30d → 90d)', () => {
    // Without max_ttl_ms, D-145 substrate's 30d ceiling rejects a
    // 60-day expiry. With max_ttl_ms = 90d, the substrate accepts it.
    const sixtyDays = FIXED_NOW + 60 * 24 * 60 * 60 * 1000;
    expect(() =>
      buildRedactedPacket(
        'scheduling_link_packet',
        schedulingLinkRaw(),
        opts({ expires_at: sixtyDays }),
      ),
    ).toThrow(RedactedPacketValidationError);
    expect(() =>
      buildRedactedPacket(
        'scheduling_link_packet',
        schedulingLinkRaw(),
        opts({ expires_at: sixtyDays, max_ttl_ms: 90 * 24 * 60 * 60 * 1000 }),
      ),
    ).not.toThrow();
  });

  it('still rejects expires_at beyond the override ceiling', () => {
    // max_ttl_ms = 90d but expires_at is 100d → reject.
    const oneHundredDays = FIXED_NOW + 100 * 24 * 60 * 60 * 1000;
    expect(() =>
      buildRedactedPacket(
        'scheduling_link_packet',
        schedulingLinkRaw(),
        opts({ expires_at: oneHundredDays, max_ttl_ms: 90 * 24 * 60 * 60 * 1000 }),
      ),
    ).toThrow(RedactedPacketValidationError);
  });

  it('omitted max_ttl_ms preserves the D-145 30d default ceiling', () => {
    const thirtyOneDays = FIXED_NOW + 31 * 24 * 60 * 60 * 1000;
    expect(() =>
      buildRedactedPacket(
        'scheduling_link_packet',
        schedulingLinkRaw(),
        opts({ expires_at: thirtyOneDays }),
      ),
    ).toThrow(RedactedPacketValidationError);
  });

  it('non-finite / non-positive max_ttl_ms falls back to D-145 default', () => {
    const thirtyOneDays = FIXED_NOW + 31 * 24 * 60 * 60 * 1000;
    expect(() =>
      buildRedactedPacket(
        'scheduling_link_packet',
        schedulingLinkRaw(),
        opts({ expires_at: thirtyOneDays, max_ttl_ms: 0 }),
      ),
    ).toThrow(RedactedPacketValidationError);
    expect(() =>
      buildRedactedPacket(
        'scheduling_link_packet',
        schedulingLinkRaw(),
        opts({ expires_at: thirtyOneDays, max_ttl_ms: Number.NaN }),
      ),
    ).toThrow(RedactedPacketValidationError);
  });
});

describe('D-149 P2 — Codex P1 #2 fold: status_link nested redaction', () => {
  it('itinerary leg drops booking codes / confirmation numbers / loyalty IDs', () => {
    const packet = buildRedactedPacket(
      'status_link_packet',
      statusLinkRaw({
        projection_kind: 'itinerary',
        source_entity_row: {
          title: 'Tokyo Trip',
          date_range: { start_at: FIXED_NOW, end_at: FIXED_NOW + 7 * 24 * 60 * 60 * 1000 },
          visible_legs: [
            {
              origin: 'SFO',
              destination: 'HND',
              mode: 'flight',
              time: '2026-05-20T22:00:00Z',
              // Sensitive — must NEVER appear in payload
              confirmation_number: 'ABC123',
              booking_code: 'UA-9876',
              loyalty_id: 'MP-12345678',
            },
          ],
        },
      }),
      opts(),
    );
    const legs = packet.payload.visible_fields.visible_legs as ReadonlyArray<
      Record<string, unknown>
    >;
    expect(legs.length).toBe(1);
    const leg = legs[0]!;
    expect(Object.keys(leg).sort()).toEqual(['destination', 'mode', 'origin', 'time']);
    expect(leg).not.toHaveProperty('confirmation_number');
    expect(leg).not.toHaveProperty('booking_code');
    expect(leg).not.toHaveProperty('loyalty_id');
  });

  it('event_plan visible_attendees redacts full names to first-name + initial', () => {
    const packet = buildRedactedPacket(
      'status_link_packet',
      statusLinkRaw({
        projection_kind: 'event_plan',
        source_entity_row: {
          title: 'Quarterly Offsite',
          date: '2026-06-15',
          location_label: 'Marin HQ',
          agenda_summary: 'Strategy + retrospective',
          visible_attendees: ['Mary Smith', 'James Brown', 'Bob'],
          tz_label: 'America/Los_Angeles',
        },
      }),
      opts(),
    );
    const attendees = packet.payload.visible_fields.visible_attendees as ReadonlyArray<string>;
    expect(attendees).toEqual(['Mary S.', 'James B.', 'Bob']);
    // Full last names must not appear
    const payloadJson = JSON.stringify(packet.payload);
    expect(payloadJson).not.toContain('Smith');
    expect(payloadJson).not.toContain('Brown');
  });

  it('itinerary leg with missing required field drops silently', () => {
    const packet = buildRedactedPacket(
      'status_link_packet',
      statusLinkRaw({
        projection_kind: 'itinerary',
        source_entity_row: {
          title: 'Trip',
          date_range: { start_at: FIXED_NOW, end_at: FIXED_NOW + 1000 },
          visible_legs: [
            { origin: 'SFO', destination: 'HND', mode: 'flight', time: 'now' },
            // Missing `time` — substrate drops it silently
            { origin: 'HND', destination: 'NRT', mode: 'train' },
          ],
        },
      }),
      opts(),
    );
    const legs = packet.payload.visible_fields.visible_legs as ReadonlyArray<unknown>;
    expect(legs.length).toBe(1);
  });

  it('itinerary date_range rebuilds from closed shape (drops nested extras)', () => {
    const packet = buildRedactedPacket(
      'status_link_packet',
      statusLinkRaw({
        projection_kind: 'itinerary',
        source_entity_row: {
          title: 'Trip',
          date_range: {
            start_at: FIXED_NOW,
            end_at: FIXED_NOW + 1000,
            // Sensitive — must NOT propagate
            timezone_id: 'America/Los_Angeles',
            booking_notes: 'paid in cash',
          },
          visible_legs: [],
        },
      }),
      opts(),
    );
    const range = packet.payload.visible_fields.date_range as Record<string, unknown>;
    expect(Object.keys(range).sort()).toEqual(['end_at', 'start_at']);
  });

  it('packing_list items array drops non-string entries', () => {
    const packet = buildRedactedPacket(
      'status_link_packet',
      statusLinkRaw({
        projection_kind: 'packing_list',
        source_entity_row: {
          title: 'Camping',
          items: ['Tent', 'Sleeping bag', { hidden: 'sensitive' }, 42],
          packed_count: 2,
          total_count: 2,
          due_date_relative: 'in 3 days',
        },
      }),
      opts(),
    );
    expect(packet.payload.visible_fields.items).toEqual(['Tent', 'Sleeping bag']);
  });

  it('custom projection tags drops non-string entries', () => {
    const packet = buildRedactedPacket(
      'status_link_packet',
      statusLinkRaw({
        projection_kind: 'custom',
        source_entity_row: {
          title: 'Roadmap',
          summary: 'Q3 plan',
          updated_at_relative: '1d ago',
          tags: ['priority:p1', 42, { hidden: 'sensitive' }, 'ship-blocker'],
        },
      }),
      opts(),
    );
    expect(packet.payload.visible_fields.tags).toEqual(['priority:p1', 'ship-blocker']);
  });
});

describe('D-149 P2 — Codex P2 #1 fold: intake required/optional intersection with visible names', () => {
  it('drops required_fields names that are not in visitor_visible_fields', () => {
    const packet = buildRedactedPacket(
      'intake_form_packet',
      intakeFormRaw({
        form_definition: {
          form_definition_id: 'fd-1',
          visitor_visible_fields: [
            { name: 'name', type: 'text', label: 'Name', required: true },
          ],
        },
        // `internal_classification` is a user-only metadata field name;
        // must NOT survive the boundary.
        required_fields: ['name', 'internal_classification'],
        optional_fields: ['user_only_vendor_rating'],
      }),
      opts(),
    );
    expect(packet.payload.required_fields).toEqual(['name']);
    expect(packet.payload.optional_fields).toEqual([]);
  });
});

describe('D-149 P2 — Codex P2 #2 fold: scheduling per-field requirement validation', () => {
  it("rejects name: 'optional' (spec: name MUST be 'required')", () => {
    expect(() =>
      buildRedactedPacket(
        'scheduling_link_packet',
        schedulingLinkRaw({
          required_visitor_fields: {
            name: 'optional',
            email: 'required',
            topic: 'optional',
            phone: 'omit',
            notes: 'omit',
          },
        }),
        opts(),
      ),
    ).toThrow(RedactedPacketValidationError);
  });

  it("rejects email: 'omit' (spec: email must be 'required' | 'optional')", () => {
    expect(() =>
      buildRedactedPacket(
        'scheduling_link_packet',
        schedulingLinkRaw({
          required_visitor_fields: {
            name: 'required',
            email: 'omit',
            topic: 'optional',
            phone: 'omit',
            notes: 'omit',
          },
        }),
        opts(),
      ),
    ).toThrow(RedactedPacketValidationError);
  });

  it("rejects phone: 'required' (spec: phone must be 'optional' | 'omit')", () => {
    expect(() =>
      buildRedactedPacket(
        'scheduling_link_packet',
        schedulingLinkRaw({
          required_visitor_fields: {
            name: 'required',
            email: 'required',
            topic: 'optional',
            phone: 'required',
            notes: 'omit',
          },
        }),
        opts(),
      ),
    ).toThrow(RedactedPacketValidationError);
  });

  it("rejects notes: 'required' (spec: notes must be 'optional' | 'omit')", () => {
    expect(() =>
      buildRedactedPacket(
        'scheduling_link_packet',
        schedulingLinkRaw({
          required_visitor_fields: {
            name: 'required',
            email: 'required',
            topic: 'optional',
            phone: 'omit',
            notes: 'required',
          },
        }),
        opts(),
      ),
    ).toThrow(RedactedPacketValidationError);
  });

  it('accepts the spec-permitted combinations', () => {
    // name='required', email='optional', topic='required', phone='optional', notes='omit'
    expect(() =>
      buildRedactedPacket(
        'scheduling_link_packet',
        schedulingLinkRaw({
          required_visitor_fields: {
            name: 'required',
            email: 'optional',
            topic: 'required',
            phone: 'optional',
            notes: 'omit',
          },
        }),
        opts(),
      ),
    ).not.toThrow();
  });
});

describe('D-149 P2 — Codex P2 #3 fold: drop_link per-field requirement validation', () => {
  it("rejects name: 'omit' (spec: name must be 'required' | 'optional')", () => {
    expect(() =>
      buildRedactedPacket(
        'drop_link_packet',
        dropLinkRaw({
          required_visitor_fields: {
            name: 'omit',
            email: 'required',
            description: 'optional',
          },
        }),
        opts(),
      ),
    ).toThrow(RedactedPacketValidationError);
  });

  it("rejects email: 'omit' (spec: email must be 'required' | 'optional')", () => {
    expect(() =>
      buildRedactedPacket(
        'drop_link_packet',
        dropLinkRaw({
          required_visitor_fields: {
            name: 'required',
            email: 'omit',
            description: 'optional',
          },
        }),
        opts(),
      ),
    ).toThrow(RedactedPacketValidationError);
  });

  it("rejects description: 'omit' (spec: description must be 'optional' | 'required')", () => {
    expect(() =>
      buildRedactedPacket(
        'drop_link_packet',
        dropLinkRaw({
          required_visitor_fields: {
            name: 'required',
            email: 'required',
            description: 'omit',
          },
        }),
        opts(),
      ),
    ).toThrow(RedactedPacketValidationError);
  });

  it('accepts the spec-permitted combinations', () => {
    expect(() =>
      buildRedactedPacket(
        'drop_link_packet',
        dropLinkRaw({
          required_visitor_fields: {
            name: 'optional',
            email: 'required',
            description: 'required',
          },
        }),
        opts(),
      ),
    ).not.toThrow();
  });
});

describe('D-149 P2 — strict-pick drops top-level extras (no-leak structural)', () => {
  it('reception_page_packet — caller-supplied extras at the top level are stripped', () => {
    const richRaw = {
      ...receptionPageRaw(),
      // Top-level extras that DO NOT appear in fields_visible — must drop
      account_balance: 12345,
      private_email_count: 99,
    } as ReceptionPagePacketRawInput;
    const packet = buildRedactedPacket('reception_page_packet', richRaw, opts());
    const payloadKeys = Object.keys(packet.payload);
    expect(payloadKeys).not.toContain('account_balance');
    expect(payloadKeys).not.toContain('private_email_count');
  });

  it('drop_link_packet — caller-supplied extras at the top level are stripped', () => {
    const richRaw = {
      ...dropLinkRaw(),
      storage_path: '/var/srv/secrets/keys',
      contact_email: 'mary@example.com',
    } as DropLinkPacketRawInput;
    const packet = buildRedactedPacket('drop_link_packet', richRaw, opts());
    const payloadKeys = Object.keys(packet.payload);
    expect(payloadKeys).not.toContain('storage_path');
    expect(payloadKeys).not.toContain('contact_email');
  });
});
