/** D-149 P6 § A.5.3 — `intake_form_packet` transformation helpers
 *  (server-side, per-kind).
 *
 *  Two responsibilities:
 *
 *    1. `buildIntakeFormPacketRawInput(source)` — adapter the GET
 *       handler calls to project a stored form_definition into the
 *       redacted-packet raw input shape. Strips user-only metadata at
 *       this boundary; the redacted-packet substrate strict-picks the
 *       fields_visible closed list AGAIN at the build step (defense in
 *       depth). The user-only field set is supplied via the source's
 *       `user_only_field_names` array OR a per-field `_visibility`
 *       map; either eliminates from the visitor-visible projection.
 *
 *    2. `parseIntakeFormConfig(metadata)` — typed parser for the
 *       per-endpoint config blob persisted in
 *       `public_endpoint_registry.metadata_blob`. Returns `null` when
 *       the blob doesn't validate (rpc-side gate already rejects;
 *       runtime falls back to placeholder on parse fail).
 *
 *  Pure module — no I/O.
 *
 *  Spec: D-149 § A.5.3 + § Must Hold I-1. */

import {
  validateIntakeFormConfig,
  type IntakeFormConfig,
  type IntakeFormConfigField,
  type IntakeFormPacketRawInput,
  type IntakeFormVisitorField,
} from '@recued/contracts';

/** Minimal source view used to build the raw input. The substrate
 *  consumer rebuilds visitor-visible fields from this closed shape
 *  + drops anything outside it. */
export interface IntakeFormPacketSourceView {
  readonly form_definition_id: string;
  readonly fields: ReadonlyArray<IntakeFormConfigField>;
  /** Closed list of field names that are user-only annotations + must
   *  NEVER reach the visitor-facing packet (per § A.5.3 line 760). */
  readonly user_only_field_names?: ReadonlyArray<string>;
  /** Honeypot fields — emitted in the rendered HTML but absent from
   *  the redacted packet's visitor-visible field list (the handler
   *  splices them back in client-side; the visitor packet stays
   *  honest about which fields the visitor "should" fill). */
  readonly honeypot_fields: ReadonlyArray<string>;
  readonly required_fields: ReadonlyArray<string>;
  readonly optional_fields: ReadonlyArray<string>;
  readonly submit_button_label: string;
  readonly success_message_template: string;
  readonly rate_limit_hint: string;
}

/** Drop user_only fields + honeypot fields from the visitor-visible
 *  field array. Honeypot fields stay in the form HTML (so bots fall
 *  into the trap) but are intentionally absent from the visitor-
 *  visible packet — the redacted packet describes what a HUMAN should
 *  see; the renderer adds honeypots on top. */
const visitorVisibleFields = (
  source: IntakeFormPacketSourceView,
): ReadonlyArray<IntakeFormVisitorField> => {
  const userOnly = new Set(source.user_only_field_names ?? []);
  const honeypot = new Set(source.honeypot_fields);
  return source.fields
    .filter((f) => !userOnly.has(f.name) && !honeypot.has(f.name))
    .map((f) => ({
      name: f.name,
      type: f.type,
      label: f.label,
      required: f.required,
    }));
};

/** Project a stored form_definition into the substrate's raw-input shape.
 *  Pure function. `visitor_visible_fields` is rebuilt from the closed-
 *  shape items so any caller-supplied extras (e.g.,
 *  `per_field_visibility` metadata, `values[]` for enum fields) stay
 *  server-side. */
export const buildIntakeFormPacketRawInput = (
  source: IntakeFormPacketSourceView,
): IntakeFormPacketRawInput => {
  const visible = visitorVisibleFields(source);
  const visibleNameSet = new Set(visible.map((f) => f.name));
  return {
    form_definition: {
      form_definition_id: source.form_definition_id,
      visitor_visible_fields: visible,
    },
    // Intersect with visitor-visible names so a stale required/optional
    // entry referencing a since-stripped user_only field is dropped at
    // the boundary (the redacted-packet substrate also re-intersects;
    // double-coverage is intentional defense in depth).
    required_fields: source.required_fields.filter((n) => visibleNameSet.has(n)),
    optional_fields: source.optional_fields.filter((n) => visibleNameSet.has(n)),
    submit_button_label: source.submit_button_label,
    success_message_template: source.success_message_template,
    rate_limit_hint: source.rate_limit_hint,
  };
};

/** Parse the stored `metadata_blob` of an `intake_form` registry row
 *  into a typed `IntakeFormConfig`. Returns `null` when the blob
 *  fails the substrate validator (the rpc-side gate normally rejects
 *  invalid configs at create time; defense in depth at runtime). */
export const parseIntakeFormConfig = (
  raw: unknown,
): IntakeFormConfig | null => {
  const failures = validateIntakeFormConfig(raw);
  if (failures.length > 0) return null;
  return raw as IntakeFormConfig;
};

/** Build the source view from a parsed `IntakeFormConfig`. The handler
 *  uses this directly; the bin.ts wiring composes the source-of-truth
 *  blob (config + Foundation pack template metadata). */
export const buildIntakeFormSourceView = (
  config: IntakeFormConfig,
  rate_limit_hint: string,
): IntakeFormPacketSourceView => {
  const required: string[] = [];
  const optional: string[] = [];
  for (const f of config.form_definition.fields) {
    if (f.required) required.push(f.name);
    else optional.push(f.name);
  }
  return {
    form_definition_id: config.form_definition.form_definition_id,
    fields: config.form_definition.fields,
    ...(config.form_definition.user_only_field_names !== undefined
      ? { user_only_field_names: config.form_definition.user_only_field_names }
      : {}),
    honeypot_fields: config.anti_spam.honeypot_fields,
    required_fields: required,
    optional_fields: optional,
    submit_button_label: config.submit_button_label ?? 'Submit',
    success_message_template: config.success_message ?? 'Submission received.',
    rate_limit_hint,
  };
};
