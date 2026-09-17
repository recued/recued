/** D-149 P11 § A.10 — pre-built `intake_form` template contract.
 *
 *  Six templates ship as a Personal Organizer Foundation pack expansion
 *  (per D-145 § A.6 pre-installed pack model) — they "ride" the existing
 *  `recued-core/personal-organizer-foundation` pack rather than landing
 *  as a separate pack (avoids pack proliferation; the pack is already
 *  installed on every Recued server). The template JSON files live at
 *  `community/packs/recued-core/personal-organizer-foundation/templates/`.
 *
 *  An `IntakeFormTemplate` is a portable manifest carrying everything the
 *  Reception → Templates UX needs to pre-populate an
 *  `intake_form` endpoint: a `form_definition`, a `submission_processing_rule`,
 *  and `anti_spam_defaults`. The user picks a template, supplies their
 *  display name, reviews, and enables — `intakeFormConfigFromTemplate` is
 *  the substrate bridge that turns the template into a concrete
 *  `IntakeFormConfig` blob the existing P6 `reception.endpoint.create` rpc
 *  path consumes verbatim.
 *
 *  Spec: D-149 § A.10 + § P11 + § Scope item 10. */

import {
  INTAKE_FORM_DISPLAY_NAME_MAX,
  INTAKE_FORM_INSTRUCTIONS_MAX,
  INTAKE_FORM_SUCCESS_MESSAGE_MAX,
  INTAKE_FORM_SUBMIT_BUTTON_LABEL_MAX,
  INTAKE_FORM_TEMPLATE_VERSION_MAX,
  validateIntakeFormConfig,
  type IntakeFormConfig,
  type IntakeFormConfigField,
  type IntakeFormConfigValidationCode,
  type IntakeFormSubmissionProcessingRule,
  type IntakeFormAntiSpamConfig,
  type IntakeFormVisitorFieldRequirements,
} from './intake-form-config.js';

// ────────────────────────────────────────────────────────────────
// Closed-list template refs (§ A.10 — adding a ref is a substrate change)
// ────────────────────────────────────────────────────────────────

/** Spec § A.10 — closed list of the six Foundation-pack template refs.
 *  Each ref has a 1:1 JSON file under the pack's `templates/` directory
 *  + a documentation section in internal design notes (the
 *  P11 docs-currency CI lint asserts both). Adding a seventh template
 *  is a substrate code change here, not a config drop-in. */
export const INTAKE_FORM_TEMPLATE_REFS = [
  'foundation:intake/client_inquiry',
  'foundation:intake/event_planning',
  'foundation:intake/vendor_quote',
  'foundation:intake/travel_request',
  'foundation:intake/doctor_appointment_prep',
  'foundation:intake/house_project',
] as const;

export type IntakeFormTemplateRef = (typeof INTAKE_FORM_TEMPLATE_REFS)[number];

export const INTAKE_FORM_TEMPLATE_REF_SET: ReadonlySet<IntakeFormTemplateRef> = new Set(
  INTAKE_FORM_TEMPLATE_REFS,
);

export const isIntakeFormTemplateRef = (value: unknown): value is IntakeFormTemplateRef =>
  typeof value === 'string' &&
  INTAKE_FORM_TEMPLATE_REF_SET.has(value as IntakeFormTemplateRef);

// ────────────────────────────────────────────────────────────────
// Closed-list bound constants
// ────────────────────────────────────────────────────────────────

/** Template display name (Settings UX list label) length cap. */
export const INTAKE_FORM_TEMPLATE_NAME_MAX = 80;
/** Template description (Settings UX preview blurb) length cap. */
export const INTAKE_FORM_TEMPLATE_DESCRIPTION_MAX = 400;

/** Semver-shape `version` field. Templates version independently of the
 *  pack; the Foundation pack version pins which template versions ship
 *  (per § A.10 "Template versioning follows the Foundation pack version"). */
export const INTAKE_FORM_TEMPLATE_VERSION_RE = /^\d+\.\d+\.\d+$/;

// ────────────────────────────────────────────────────────────────
// Template manifest shape
// ────────────────────────────────────────────────────────────────

/** Anti-spam *defaults* a template ships. A subset of
 *  `IntakeFormAntiSpamConfig` — templates never ship a
 *  `known_domain_allowlist` (the user adds one per-deployment), so the
 *  defaults carry the two enforced substrate knobs plus the two reserved
 *  PoW / CAPTCHA compatibility flags. */
export interface IntakeFormTemplateAntiSpamDefaults {
  readonly honeypot_fields: ReadonlyArray<string>;
  readonly rate_limit_per_ip: number;
  readonly require_proof_of_work: boolean;
  readonly require_captcha: boolean;
}

/** Closed key set for `anti_spam_defaults`. The validator rejects any
 *  key outside this set — notably `known_domain_allowlist`, which
 *  `validateIntakeFormConfig` would otherwise accept as a valid
 *  `anti_spam` key, even though `intakeFormConfigFromTemplate` rebuilds
 *  `anti_spam` from these four fields ONLY and would silently drop it
 *  (a template that "validates" would publish without its intended
 *  restriction — D-149 P11 Codex fold). A domain allowlist is a
 *  per-deployment decision the user adds AFTER "Use template", never
 *  baked into the portable template. */
export const INTAKE_FORM_TEMPLATE_ANTI_SPAM_DEFAULT_KEYS = [
  'honeypot_fields',
  'rate_limit_per_ip',
  'require_proof_of_work',
  'require_captcha',
] as const;

export const INTAKE_FORM_TEMPLATE_ANTI_SPAM_DEFAULT_KEY_SET: ReadonlySet<string> = new Set(
  INTAKE_FORM_TEMPLATE_ANTI_SPAM_DEFAULT_KEYS,
);

/** Everything an `intake_form` template carries EXCEPT its ref. D-220 Slice B
 *  splits the body out so a pack-shipped template (`pack:<publisher>/<slug>/
 *  intake/<name>`, `pack-intake-form-template.ts`) shares one body contract,
 *  one body validator and one `intakeFormConfigFromTemplate` bridge with the
 *  Foundation set, and differs ONLY in how its ref is admitted. */
export interface IntakeFormTemplateBody {
  /** Semver string; versions independently of the pack. */
  readonly version: string;
  /** Settings UX list label (e.g. "Client inquiry"). */
  readonly name: string;
  /** Settings UX preview blurb — what the template collects + does. */
  readonly description: string;
  /** Default visitor-facing instructions paragraph. Copied into the
   *  generated config's `instructions`; the user can edit before enable. */
  readonly default_instructions?: string;
  /** Default confirmation-page copy. */
  readonly default_success_message?: string;
  /** Default submit-button label. */
  readonly default_submit_button_label?: string;
  /** Form definition — structurally identical to
   *  `IntakeFormConfig['form_definition']` so the conversion is a
   *  passthrough. `form_definition_id` is a stable per-template id;
   *  `intakeFormConfigFromTemplate` accepts a per-endpoint override. */
  readonly form_definition: {
    readonly form_definition_id: string;
    readonly fields: ReadonlyArray<IntakeFormConfigField>;
    readonly user_only_field_names?: ReadonlyArray<string>;
  };
  /** Substrate-injected visitor email knob. */
  readonly required_visitor_fields: IntakeFormVisitorFieldRequirements;
  /** Submission processing rule — structurally identical to
   *  `IntakeFormSubmissionProcessingRule`. */
  readonly submission_processing_rule: IntakeFormSubmissionProcessingRule;
  /** Anti-spam defaults (four substrate-baseline knobs; no allowlist). */
  readonly anti_spam_defaults: IntakeFormTemplateAntiSpamDefaults;
}

/** Portable `intake_form` template manifest per § A.10. Parsed from a
 *  JSON file under `community/packs/recued-core/personal-organizer-foundation/templates/`;
 *  converted to a concrete `IntakeFormConfig` via
 *  `intakeFormConfigFromTemplate` at "Use template" time. */
export interface IntakeFormTemplate extends IntakeFormTemplateBody {
  /** Closed-list ref — the template's stable identity + `data` key. */
  readonly template_ref: IntakeFormTemplateRef;
}

// ────────────────────────────────────────────────────────────────
// Validator
// ────────────────────────────────────────────────────────────────

export type IntakeFormTemplateValidationCode =
  | 'template_shape_invalid'
  | 'template_ref_unknown'
  | 'version_invalid'
  | 'name_invalid'
  | 'description_invalid'
  | 'default_instructions_too_long'
  | 'default_success_message_too_long'
  | 'default_submit_button_label_too_long'
  /** `anti_spam_defaults` carried a key outside the four substrate-
   *  baseline knobs (e.g. `known_domain_allowlist`) — rejected because
   *  `intakeFormConfigFromTemplate` would silently drop it. */
  | 'anti_spam_defaults_extra_key'
  /** A delegated `validateIntakeFormConfig` failure on the config-shaped
   *  parts of the template (form_definition / submission_processing_rule /
   *  anti_spam / required_visitor_fields). `config_code` carries the
   *  original inner code so callers + tests can assert precisely. */
  | 'config_invalid';

export interface IntakeFormTemplateValidationFailure {
  readonly code: IntakeFormTemplateValidationCode;
  readonly detail: string;
  /** Present only when `code === 'config_invalid'` — the inner
   *  `validateIntakeFormConfig` code that fired. */
  readonly config_code?: IntakeFormConfigValidationCode;
}

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0;

/** Validate an `IntakeFormTemplate`. Pure function — no I/O. Returns the
 *  list of failures; empty array ⇒ valid.
 *
 *  Template-specific fields (`template_ref` / `version` / `name` /
 *  `description` / `default_*`) are checked here directly. The
 *  config-shaped parts (`form_definition` /
 *  `required_visitor_fields` / `submission_processing_rule` /
 *  `anti_spam_defaults`) are validated by delegating to
 *  `validateIntakeFormConfig` on a candidate config — the SAME validator
 *  the P6 `reception.endpoint.create` rpc runs — so "template validates
 *  clean" structurally implies "the generated `IntakeFormConfig`
 *  validates clean" (the P11 acceptance bridge). Delegated failures are
 *  re-emitted with `code: 'config_invalid'` + the inner `config_code`. */
export const validateIntakeFormTemplate = (
  template: unknown,
): ReadonlyArray<IntakeFormTemplateValidationFailure> => {
  const failures: IntakeFormTemplateValidationFailure[] = [];
  if (template === null || typeof template !== 'object' || Array.isArray(template)) {
    failures.push({
      code: 'template_shape_invalid',
      detail: 'intake_form template must be an object',
    });
    return failures;
  }
  const t = template as Record<string, unknown>;

  // template_ref — closed list.
  if (!isIntakeFormTemplateRef(t.template_ref)) {
    failures.push({
      code: 'template_ref_unknown',
      detail: `template_ref must be one of ${INTAKE_FORM_TEMPLATE_REFS.join(', ')}`,
    });
  }

  failures.push(...validateIntakeFormTemplateBody(t));
  return failures;
};

/** Validate the ref-independent body of an intake template — every check
 *  except `template_ref`. Shared by `validateIntakeFormTemplate` (Foundation,
 *  closed-list ref) and D-220 Slice B's `validatePackIntakeFormTemplate`
 *  (`pack:` ref + safety-matrix clamp), so the two can never drift on what a
 *  template body must satisfy. Callers pass an already-shape-checked object. */
export const validateIntakeFormTemplateBody = (
  t: Record<string, unknown>,
): ReadonlyArray<IntakeFormTemplateValidationFailure> => {
  const failures: IntakeFormTemplateValidationFailure[] = [];

  // version — semver shape, within the bound the generated config's
  // `template_version` is checked against (a longer one would validate here
  // and fail at endpoint create).
  if (
    typeof t.version !== 'string'
    || !INTAKE_FORM_TEMPLATE_VERSION_RE.test(t.version)
    || t.version.length > INTAKE_FORM_TEMPLATE_VERSION_MAX
  ) {
    failures.push({
      code: 'version_invalid',
      detail: `version must match <major>.<minor>.<patch> and be ≤ ${INTAKE_FORM_TEMPLATE_VERSION_MAX} chars`,
    });
  }

  // name / description.
  if (!isNonEmptyString(t.name) || (t.name as string).length > INTAKE_FORM_TEMPLATE_NAME_MAX) {
    failures.push({
      code: 'name_invalid',
      detail: `name must be a non-empty string ≤ ${INTAKE_FORM_TEMPLATE_NAME_MAX} chars`,
    });
  }
  if (
    !isNonEmptyString(t.description) ||
    (t.description as string).length > INTAKE_FORM_TEMPLATE_DESCRIPTION_MAX
  ) {
    failures.push({
      code: 'description_invalid',
      detail: `description must be a non-empty string ≤ ${INTAKE_FORM_TEMPLATE_DESCRIPTION_MAX} chars`,
    });
  }

  // default_* copy bounds — reuse the IntakeFormConfig caps so a template
  // can never carry copy the generated config would reject.
  if (t.default_instructions !== undefined) {
    if (
      typeof t.default_instructions !== 'string' ||
      t.default_instructions.length > INTAKE_FORM_INSTRUCTIONS_MAX
    ) {
      failures.push({
        code: 'default_instructions_too_long',
        detail: `default_instructions must be a string ≤ ${INTAKE_FORM_INSTRUCTIONS_MAX} chars when present`,
      });
    }
  }
  if (t.default_success_message !== undefined) {
    if (
      typeof t.default_success_message !== 'string' ||
      t.default_success_message.length > INTAKE_FORM_SUCCESS_MESSAGE_MAX
    ) {
      failures.push({
        code: 'default_success_message_too_long',
        detail: `default_success_message must be a string ≤ ${INTAKE_FORM_SUCCESS_MESSAGE_MAX} chars when present`,
      });
    }
  }
  if (t.default_submit_button_label !== undefined) {
    if (
      typeof t.default_submit_button_label !== 'string' ||
      t.default_submit_button_label.length > INTAKE_FORM_SUBMIT_BUTTON_LABEL_MAX
    ) {
      failures.push({
        code: 'default_submit_button_label_too_long',
        detail: `default_submit_button_label must be a string ≤ ${INTAKE_FORM_SUBMIT_BUTTON_LABEL_MAX} chars when present`,
      });
    }
  }

  // anti_spam_defaults — templates ship the four substrate-baseline
  // knobs ONLY. A stray key (notably `known_domain_allowlist`) would
  // pass the delegated `validateIntakeFormConfig` check yet be silently
  // dropped by `intakeFormConfigFromTemplate` (which rebuilds anti_spam
  // from the four baseline fields) — a template that "validates" would
  // publish without its intended restriction. Reject extra keys here,
  // and build the candidate's `anti_spam` from the four baseline fields
  // ONLY so the delegated validation mirrors the conversion output
  // exactly (D-149 P11 Codex fold).
  let candidateAntiSpam: unknown = t.anti_spam_defaults;
  const rawAntiSpam = t.anti_spam_defaults;
  if (rawAntiSpam !== null && typeof rawAntiSpam === 'object' && !Array.isArray(rawAntiSpam)) {
    const a = rawAntiSpam as Record<string, unknown>;
    for (const key of Object.keys(a)) {
      if (!INTAKE_FORM_TEMPLATE_ANTI_SPAM_DEFAULT_KEY_SET.has(key)) {
        failures.push({
          code: 'anti_spam_defaults_extra_key',
          detail: `anti_spam_defaults.${key} is not a template-level anti-spam default — templates ship deployment-agnostic defaults only (a known_domain_allowlist is added per-deployment after "Use template", never baked into the portable template)`,
        });
      }
    }
    candidateAntiSpam = {
      honeypot_fields: a.honeypot_fields,
      rate_limit_per_ip: a.rate_limit_per_ip,
      require_proof_of_work: a.require_proof_of_work,
      require_captcha: a.require_captcha,
    };
  }

  // Config-shaped parts — delegate to validateIntakeFormConfig on a
  // candidate config. A fixed placeholder display_name keeps the
  // delegation pure (the real display_name arrives at conversion time).
  const candidate: Record<string, unknown> = {
    display_name: 'Template placeholder',
    form_definition: t.form_definition,
    required_visitor_fields: t.required_visitor_fields,
    submission_processing_rule: t.submission_processing_rule,
    anti_spam: candidateAntiSpam,
  };
  for (const inner of validateIntakeFormConfig(candidate)) {
    failures.push({
      code: 'config_invalid',
      detail: inner.detail,
      config_code: inner.code,
    });
  }

  return failures;
};

// ────────────────────────────────────────────────────────────────
// Template → IntakeFormConfig conversion (the "Use template" bridge)
// ────────────────────────────────────────────────────────────────

/** Per-endpoint options the template can't know — the user's display
 *  name + an optional per-endpoint `form_definition_id` override (so two
 *  endpoints created from the same template don't collide on the
 *  `reception_form_definition` primary key). */
export interface IntakeFormConfigFromTemplateOptions {
  /** Visitor-facing display name (Mary's first name / handle). */
  readonly display_name: string;
  /** Per-endpoint `form_definition_id`. Defaults to the template's own
   *  `form_definition.form_definition_id` when omitted. */
  readonly form_definition_id?: string;
}

/** Convert an `IntakeFormTemplate` into a concrete `IntakeFormConfig`
 *  blob — the shape the P6 `reception.endpoint.create` rpc persists into
 *  `public_endpoint_registry.metadata_blob`. Pure function; assumes the
 *  template already passed `validateIntakeFormTemplate` (the caller — the
 *  Settings UX or a test — validates first). The generated config is
 *  guaranteed to pass `validateIntakeFormConfig` for any valid template
 *  (the validator delegates to the same checks).
 *
 *  `template_ref` AND `template_version` are stamped onto the config so
 *  the endpoint row records its full template provenance — after the
 *  Foundation pack revs a template, an endpoint created from the older
 *  JSON stays distinguishable (Settings / engine logic can tell which
 *  schema + copy it was based on).
 *
 *  Accepts any template BODY with a string ref — the Foundation
 *  `IntakeFormTemplate` and D-220 Slice B's `PackIntakeFormTemplate` both
 *  satisfy it, so one bridge serves both galleries. */
export const intakeFormConfigFromTemplate = (
  template: IntakeFormTemplateBody & { readonly template_ref: string },
  opts: IntakeFormConfigFromTemplateOptions,
): IntakeFormConfig => {
  const formDefinitionId =
    opts.form_definition_id ?? template.form_definition.form_definition_id;

  const antiSpam: IntakeFormAntiSpamConfig = {
    honeypot_fields: template.anti_spam_defaults.honeypot_fields,
    rate_limit_per_ip: template.anti_spam_defaults.rate_limit_per_ip,
    require_proof_of_work: template.anti_spam_defaults.require_proof_of_work,
    require_captcha: template.anti_spam_defaults.require_captcha,
  };

  return {
    display_name: opts.display_name,
    ...(template.default_instructions !== undefined
      ? { instructions: template.default_instructions }
      : {}),
    ...(template.default_success_message !== undefined
      ? { success_message: template.default_success_message }
      : {}),
    ...(template.default_submit_button_label !== undefined
      ? { submit_button_label: template.default_submit_button_label }
      : {}),
    template_ref: template.template_ref,
    template_version: template.version,
    form_definition: {
      form_definition_id: formDefinitionId,
      fields: template.form_definition.fields,
      ...(template.form_definition.user_only_field_names !== undefined
        ? { user_only_field_names: template.form_definition.user_only_field_names }
        : {}),
    },
    submission_processing_rule: template.submission_processing_rule,
    anti_spam: antiSpam,
    required_visitor_fields: template.required_visitor_fields,
  };
};

// ────────────────────────────────────────────────────────────────
// Parse helper
// ────────────────────────────────────────────────────────────────

/** `parseIntakeFormTemplate` result — ok-form carries the typed
 *  template; not-ok carries the validation failures. */
export type IntakeFormTemplateParseResult =
  | { readonly ok: true; readonly template: IntakeFormTemplate }
  | { readonly ok: false; readonly failures: ReadonlyArray<IntakeFormTemplateValidationFailure> };

/** Parse + validate an unknown JSON payload as an `IntakeFormTemplate`.
 *  Thin wrapper over `validateIntakeFormTemplate` — used by the
 *  template-file loader + the P11 docs-currency / community-file tests. */
export const parseIntakeFormTemplate = (input: unknown): IntakeFormTemplateParseResult => {
  const failures = validateIntakeFormTemplate(input);
  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, template: input as IntakeFormTemplate };
};

// Re-export the display-name cap so callers validating
// `IntakeFormConfigFromTemplateOptions.display_name` before conversion
// reach for the same bound the generated config is checked against.
export { INTAKE_FORM_DISPLAY_NAME_MAX };
