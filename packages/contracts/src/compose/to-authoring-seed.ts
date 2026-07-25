/** D-151 P2 — intent-first authoring seed converter.
 *
 *  `reception.compose.propose` returns a `ProposedEndpointConfig` — a
 *  free-text → AI-drafted endpoint shape spanning all kinds. The webclient
 *  authoring form (`mountAuthoringForm` / `seedWorkingConfig`) consumes a
 *  per-kind PARTIAL authoring config + fills the rest of the defaults.
 *  This pure converter projects the AI-provided sub-config into that
 *  partial shape so the host can `openAuthoringForm({ kind, initialConfig })`
 *  straight off a proposal.
 *
 *  ── Security boundary (the load-bearing part) ─────────────────────
 *  The `intake_form` projection DROPS every field whose `type` is
 *  `password` / `signature` / `trusted_html` or matches `ref<...>`. These
 *  `ProposedFormFieldType` members are structurally ABSENT from
 *  `IntakeFormVisitorFieldType` (the public-substrate field-type enum) —
 *  they can never reach the visitor renderer (I-5 / I-17 over-collection
 *  guard). The proposed shape can name them (the AI synthesises a wide
 *  union); the converter is the gate that strips them before the partial
 *  config flows into the authoring form. `visitor_pii_class` is likewise
 *  NOT mapped (it is not an `IntakeFormConfig` field).
 *
 *  Pure — no throws. An unknown / absent sub-config returns the kind with
 *  a minimal `{}` config (the authoring layer's `seedWorkingConfig`
 *  defaults take over).
 *
 *  This is contracts code — no webclient imports. */

import type { IntakeFormConfigField } from '../intake-form-config.js';
import { INTAKE_FORM_VISITOR_FIELD_TYPE_SET } from '../redacted-packets.js';
import type { IntakeFormVisitorFieldType } from '../redacted-packets.js';
import type {
  ProposedEndpointConfig,
  ProposedFormField,
} from './types.js';

/** The per-kind authoring seed the webclient host hands to
 *  `openAuthoringForm` as `initialConfig`. Always one of the three
 *  AI-proposable authoring kinds; `config` is a PARTIAL — the authoring
 *  form's `seedWorkingConfig` merges the rest of the defaults. */
export interface AuthoringSeed {
  readonly kind: 'reception_page' | 'scheduling_link' | 'intake_form';
  readonly config: object;
}

/** True iff a proposed field type can reach the public intake substrate
 *  (i.e. is a member of the closed `IntakeFormVisitorFieldType` enum).
 *  `password` / `signature` / `trusted_html` / `ref<...>` all return
 *  false — they are dropped from the seed. */
const isPublicSubstrateFieldType = (
  type: ProposedFormField['type'],
): type is IntakeFormVisitorFieldType =>
  INTAKE_FORM_VISITOR_FIELD_TYPE_SET.has(type as IntakeFormVisitorFieldType);

/** Project one proposed field into the closed `IntakeFormConfigField`
 *  shape (name / type / label / required + enum `values`). Caller has
 *  already gated the type through `isPublicSubstrateFieldType`. */
const toConfigField = (
  field: ProposedFormField,
  type: IntakeFormVisitorFieldType,
): IntakeFormConfigField => ({
  name: field.name,
  type,
  label: field.label,
  required: field.required,
  ...(field.values !== undefined ? { values: field.values } : {}),
});

/** Map a proposed `intake_form` into a partial `IntakeFormConfig`. Drops
 *  forbidden field types; an empty result keeps an empty `fields` list
 *  (the authoring form requires ≥1 — the user adds one). */
const intakeSeed = (config: ProposedEndpointConfig): object => {
  const fd = config.form_definition;
  if (fd === undefined) {
    return { display_name: config.title };
  }
  const fields: IntakeFormConfigField[] = [];
  for (const field of fd.fields) {
    if (!isPublicSubstrateFieldType(field.type)) continue;
    fields.push(toConfigField(field, field.type));
  }
  return {
    display_name: config.title,
    ...(config.description !== undefined ? { instructions: config.description } : {}),
    ...(fd.submit_button_label !== undefined
      ? { submit_button_label: fd.submit_button_label }
      : {}),
    ...(fd.success_message !== undefined ? { success_message: fd.success_message } : {}),
    form_definition: {
      ...(fd.form_definition_id !== undefined
        ? { form_definition_id: fd.form_definition_id }
        : {}),
      fields,
    },
    ...(fd.email_requirement !== undefined
      ? { required_visitor_fields: { email: fd.email_requirement } }
      : {}),
  };
};

/** Map a proposed `scheduling_link` into a partial `SchedulingLinkConfig`.
 *  Copies only the keys the AI provided; `seedWorkingConfig` fills the
 *  rest. */
const schedulingSeed = (config: ProposedEndpointConfig): object => {
  const s = config.scheduling;
  if (s === undefined) {
    return { display_name: config.title };
  }
  return {
    display_name: s.display_name ?? config.title,
    ...(s.instructions !== undefined ? { instructions: s.instructions } : {}),
    ...(s.success_message !== undefined ? { success_message: s.success_message } : {}),
    duration_options_minutes: s.duration_options_minutes,
    available_window_definition: s.available_window_definition,
    ...(s.required_visitor_fields !== undefined
      ? { required_visitor_fields: s.required_visitor_fields }
      : {}),
    ...(s.min_advance_notice_hours !== undefined
      ? { min_advance_notice_hours: s.min_advance_notice_hours }
      : {}),
    ...(s.max_lead_time_days !== undefined
      ? { max_lead_time_days: s.max_lead_time_days }
      : {}),
    ...(s.max_bookings_per_day !== undefined
      ? { max_bookings_per_day: s.max_bookings_per_day }
      : {}),
    ...(s.on_booking !== undefined ? { on_booking: s.on_booking } : {}),
  };
};

/** Map a proposed `reception_page` into a partial `ReceptionPageConfig`.
 *  The singleton's `display_overrides.display_name` seeds from the
 *  proposal title; the rest is copied where the AI provided it. */
const pageSeed = (config: ProposedEndpointConfig): object => {
  const p = config.page_layout;
  if (p === undefined) {
    return { display_overrides: { display_name: config.title } };
  }
  return {
    display_overrides: {
      ...(p.display_overrides ?? {}),
      display_name: p.display_overrides?.display_name ?? config.title,
    },
    ...(p.sections_enabled !== undefined ? { sections_enabled: p.sections_enabled } : {}),
    ...(p.linked_endpoints !== undefined ? { linked_endpoints: p.linked_endpoints } : {}),
    ...(p.custom_links !== undefined ? { custom_links: p.custom_links } : {}),
    ...(p.trust_footer_enabled !== undefined
      ? { trust_footer_enabled: p.trust_footer_enabled }
      : {}),
  };
};

/** Convert a `ProposedEndpointConfig` into a per-kind authoring seed.
 *
 *  Pure, never throws. The `intake_form` path is the security boundary:
 *  forbidden field types (`password` / `signature` / `trusted_html` /
 *  `ref<...>`) are dropped so they can never reach the public substrate.
 *  Any kind outside the three authoring kinds (e.g. `status_link`) falls
 *  through to the `reception_page` seed shape — the host only ever asks
 *  this converter for proposals it can author, and the minimal `{}` /
 *  title-only config keeps `seedWorkingConfig` in control regardless. */
export const proposedEndpointConfigToAuthoringSeed = (
  config: ProposedEndpointConfig,
): AuthoringSeed => {
  switch (config.kind) {
    case 'intake_form':
      return { kind: 'intake_form', config: intakeSeed(config) };
    case 'scheduling_link':
      return { kind: 'scheduling_link', config: schedulingSeed(config) };
    case 'reception_page':
    default:
      return { kind: 'reception_page', config: pageSeed(config) };
  }
};
