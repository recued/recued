/** D-220 Slice B — pack-shippable `intake_form` templates.
 *
 *  A pack whose recipe reads NAMED form fields (`metadata.requires_form_fields`,
 *  Slice A) can ship the form that satisfies that contract as a manifest
 *  `contents[]` entry of `type: 'reception_template'`. The template rides the
 *  pack's own install flow: it is validated with the manifest, persisted by the
 *  install handler, listed by `reception.template.list` beside the Foundation
 *  set, and removed with the pack. No filesystem scan and no marketplace row —
 *  a template exists on a server exactly when its pack is installed there.
 *
 *  Three things are different from a Foundation template, and only three:
 *
 *  1. **The ref.** `pack:<publisher>/<slug>/intake/<name>` — a separate
 *     namespace from `foundation:`, so the two closed unions and their docs
 *     lint stay untouched, and the ref carries its own provenance. The
 *     `<publisher>/<slug>` half MUST equal the manifest that ships it: a pack
 *     cannot publish a template under another pack's name.
 *  2. **The safety matrix.** Third-party content proposing a PUBLIC form's
 *     field set is clamped, never trusted: forbidden field-name vocabulary
 *     (token-boundary match, so `visitor_mobile` is caught by `mobile`), the
 *     Compose proposal field types (no `file` — a pack does not get to open a
 *     visitor-upload surface into the owner's storage), a visitor-PII ceiling
 *     of name + email, a per-IP rate limit no higher than the substrate
 *     default, and ⛔ `target_kind: 'form_response'` ONLY — the destination
 *     decides what the substrate materialises under owner authority on
 *     approve (`task` / `booking` / `contact` / `calendar` each write a real
 *     record), and a pack must not preset that.
 *  3. **Nothing else.** The body contract, the body validator and the
 *     `intakeFormConfigFromTemplate` bridge are the Foundation ones, shared.
 *
 *  The matrix is the MACHINE half. "Use template" still lands in the authoring
 *  form for the owner to review and enable — the HUMAN half stays human, and
 *  the machine half must never be presented as approval.
 *
 *  Spec: D-220 § Slice B. */

import {
  INTAKE_FORM_RATE_LIMIT_PER_IP_DEFAULT,
  type IntakeFormConfigValidationCode,
  type IntakeFormTargetKind,
} from './intake-form-config.js';
import { CONTACT_DETAIL_FORBIDDEN_FIELD_NAMES } from './compose/templates.js';
import type { IntakeFormVisitorFieldType } from './redacted-packets.js';
import {
  validateIntakeFormTemplateBody,
  type IntakeFormTemplateBody,
  type IntakeFormTemplateValidationCode,
} from './intake-form-template.js';
import type { VisitorPiiClass } from './compose/types.js';

// ────────────────────────────────────────────────────────────────
// Ref grammar — `pack:<publisher>/<slug>/intake/<name>`
// ────────────────────────────────────────────────────────────────

export const PACK_INTAKE_FORM_TEMPLATE_REF_PREFIX = 'pack:';
/** Same bound the endpoint config's `template_ref` field accepts. */
export const PACK_INTAKE_FORM_TEMPLATE_REF_MAX = 100;

/** The dot-free publisher / pack handle shape — SAME source as `SLUG_RE` in
 *  `bulk-pack.ts` (pinned equal by test). Spelled locally because `bulk-pack`
 *  imports this module: an import the other way would read `SLUG_RE` inside a
 *  half-evaluated module cycle. */
const PACK_HANDLE_SOURCE = '[a-z0-9][a-z0-9-]*[a-z0-9]';
/** Template stem — the Foundation file-stem shape (`client_inquiry`). */
const TEMPLATE_NAME_SOURCE = '[a-z][a-z0-9_]{0,63}';

export const PACK_INTAKE_FORM_TEMPLATE_REF_RE = new RegExp(
  `^pack:(${PACK_HANDLE_SOURCE})/(${PACK_HANDLE_SOURCE})/intake/(${TEMPLATE_NAME_SOURCE})$`,
);

export type PackIntakeFormTemplateRef = `pack:${string}/${string}/intake/${string}`;

export interface ParsedPackIntakeFormTemplateRef {
  readonly publisher: string;
  readonly slug: string;
  /** The stem after `/intake/` — the per-pack row key. */
  readonly name: string;
}

/** Parse a `pack:` ref into its three parts; `null` for anything that is not
 *  exactly one. Length-capped so a ref can never exceed what an endpoint
 *  config's `template_ref` field accepts downstream. */
export const parsePackIntakeFormTemplateRef = (
  value: unknown,
): ParsedPackIntakeFormTemplateRef | null => {
  if (typeof value !== 'string' || value.length > PACK_INTAKE_FORM_TEMPLATE_REF_MAX) return null;
  const m = PACK_INTAKE_FORM_TEMPLATE_REF_RE.exec(value);
  if (m === null) return null;
  return { publisher: m[1]!, slug: m[2]!, name: m[3]! };
};

export const isPackIntakeFormTemplateRef = (value: unknown): value is PackIntakeFormTemplateRef =>
  parsePackIntakeFormTemplateRef(value) !== null;

/** Build the canonical ref for a pack + stem. */
export const packIntakeFormTemplateRef = (
  publisher: string,
  slug: string,
  name: string,
): PackIntakeFormTemplateRef => `pack:${publisher}/${slug}/intake/${name}`;

// ────────────────────────────────────────────────────────────────
// Template shape
// ────────────────────────────────────────────────────────────────

/** A pack-shipped intake template: the Foundation BODY under a `pack:` ref. */
export interface PackIntakeFormTemplate extends IntakeFormTemplateBody {
  readonly template_ref: PackIntakeFormTemplateRef;
}

/** The pack that ships a template — what the ref's `<publisher>/<slug>` half
 *  must equal. Passed by the manifest validator (it knows the manifest) and by
 *  the server's row reader (it knows the row). */
export interface PackIntakeFormTemplateOwner {
  readonly publisher: string;
  readonly slug: string;
}

// ────────────────────────────────────────────────────────────────
// Safety matrix — the machine half
// ────────────────────────────────────────────────────────────────

/** Visitor-PII classes a pack template may propose. `visitor_email` is the
 *  substrate's own `required_visitor_fields.email` knob; `visitor_name` is a
 *  plain text field. Everything past that (phone, address, birthdate,
 *  employer, income, government id, payment) is refused by NAME — see
 *  `PACK_INTAKE_FORM_TEMPLATE_FORBIDDEN_FIELD_NAMES`. An owner who wants such a
 *  field adds it by hand after "Use template", where the ask is theirs. */
export const PACK_INTAKE_FORM_TEMPLATE_VISITOR_PII_CEILING = [
  'none',
  'visitor_name',
  'visitor_email',
] as const satisfies ReadonlyArray<VisitorPiiClass>;

/** The Compose contact-detail vocabulary, reused verbatim — one list, not a copy. */
export const PACK_INTAKE_FORM_TEMPLATE_FORBIDDEN_FIELD_NAMES: ReadonlyArray<string> =
  CONTACT_DETAIL_FORBIDDEN_FIELD_NAMES;

/** The visitor field types a pack template may propose — the Compose
 *  proposal list (what an AI-drafted intake may carry) intersected with the
 *  intake substrate's own vocabulary. ⛔ Deliberately NARROWER than
 *  `INTAKE_FORM_VISITOR_FIELD_TYPES`: `file` is excluded because a visitor
 *  upload field puts third-party-chosen bytes into the owner's storage, a
 *  surface the owner should open by hand rather than accept from a pack;
 *  `datetime` is excluded to stay on the Compose list. The owner can add
 *  either after "Use template". Pinned by test to be a strict subset. */
export const PACK_INTAKE_FORM_TEMPLATE_FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'boolean',
  'date',
  'enum',
  'array<text>',
] as const satisfies ReadonlyArray<IntakeFormVisitorFieldType>;

/** A pack template may lower the per-IP rate limit, never raise it past the
 *  substrate default. */
export const PACK_INTAKE_FORM_TEMPLATE_RATE_LIMIT_CEILING = INTAKE_FORM_RATE_LIMIT_PER_IP_DEFAULT;

/** ⛔ v1: `form_response` only. See the module header. */
export const PACK_INTAKE_FORM_TEMPLATE_TARGET_KINDS = [
  'form_response',
] as const satisfies ReadonlyArray<IntakeFormTargetKind>;

export interface PackIntakeFormTemplateSafetyMatrix {
  readonly allowed_field_types: ReadonlyArray<IntakeFormVisitorFieldType>;
  readonly forbidden_field_names: ReadonlyArray<string>;
  readonly allowed_visitor_pii_classes: ReadonlyArray<VisitorPiiClass>;
  readonly rate_limit_per_ip_ceiling: number;
  readonly allowed_target_kinds: ReadonlyArray<IntakeFormTargetKind>;
}

/** The one matrix every pack template is clamped against. Serialised nowhere
 *  — it is a validator input, not a model-facing packet. */
export const PACK_INTAKE_FORM_TEMPLATE_SAFETY_MATRIX: PackIntakeFormTemplateSafetyMatrix = {
  allowed_field_types: PACK_INTAKE_FORM_TEMPLATE_FIELD_TYPES,
  forbidden_field_names: PACK_INTAKE_FORM_TEMPLATE_FORBIDDEN_FIELD_NAMES,
  allowed_visitor_pii_classes: PACK_INTAKE_FORM_TEMPLATE_VISITOR_PII_CEILING,
  rate_limit_per_ip_ceiling: PACK_INTAKE_FORM_TEMPLATE_RATE_LIMIT_CEILING,
  allowed_target_kinds: PACK_INTAKE_FORM_TEMPLATE_TARGET_KINDS,
};

/** Token-boundary match of a field name against the forbidden vocabulary.
 *  `visitor_mobile` matches `mobile`; `home_street_address` matches both
 *  `address` and `street_address`; `phonebook` matches nothing (no boundary).
 *  Digits are separators too, so `phone2` / `ssn1` / `zip4` are caught — an
 *  audit found the letters-only boundary let a numeric suffix through.
 *  Returns the first vocabulary entry that matched, or `undefined`. The
 *  Compose compiler matches field names more loosely for its own purpose; this
 *  is the stricter rule a THIRD-PARTY proposal earns. */
export const packTemplateFieldNameMatchesForbidden = (
  name: string,
  forbidden: ReadonlyArray<string> = PACK_INTAKE_FORM_TEMPLATE_FORBIDDEN_FIELD_NAMES,
): string | undefined => {
  const normalized = `_${name.toLowerCase().replace(/[^a-z]+/g, '_')}_`;
  return forbidden.find((entry) => normalized.includes(`_${entry.toLowerCase()}_`));
};

/** The visitor-PII class a field PROPOSES, inferred from its name, label and
 *  type — the same keyword table Compose's compiler applies to an AI-drafted
 *  form, kept here in the pack module's own words so the ceiling has an
 *  enforcement point (a declared ceiling nothing checks is decoration). The
 *  LABEL is read as well as the name: `answer` labelled "Mobile phone number"
 *  is a phone field however it is named. Conservative by construction — a
 *  false positive costs a pack author a rename, a false negative costs a
 *  visitor their data. */
export const inferPackTemplateVisitorPiiClass = (field: {
  readonly name: string;
  readonly label?: unknown;
  readonly type?: unknown;
}): VisitorPiiClass => {
  const norm = (v: unknown): string =>
    typeof v === 'string' ? ` ${v.toLowerCase().replace(/[^a-z]+/g, ' ')} ` : ' ';
  const key = `${norm(field.name)}${norm(field.label)}${norm(field.type)}`;
  const has = (...words: string[]): boolean => words.some((w) => key.includes(` ${w} `));
  if (has('email', 'e mail')) return 'visitor_email';
  if (has('phone', 'mobile', 'telephone', 'cell', 'whatsapp')) return 'visitor_phone';
  if (has('address', 'street', 'zip', 'postcode', 'postal')) return 'visitor_address';
  if (has('birth', 'birthday', 'birthdate', 'dob')) return 'visitor_birthdate';
  if (has('employer')) return 'visitor_employer';
  if (has('income', 'salary')) return 'visitor_income';
  if (has('ssn', 'social security', 'tax id', 'government id', 'passport', 'driver license', 'national id')) {
    return 'visitor_government_id';
  }
  if (has('credit card', 'card number', 'payment', 'iban', 'bank')) return 'visitor_payment';
  if (has('name')) return 'visitor_name';
  return 'none';
};

// ────────────────────────────────────────────────────────────────
// Validator
// ────────────────────────────────────────────────────────────────

export type PackIntakeFormTemplateValidationCode =
  | Exclude<IntakeFormTemplateValidationCode, 'template_ref_unknown'>
  /** Not a `pack:<publisher>/<slug>/intake/<name>` ref (or over the length cap). */
  | 'pack_template_ref_invalid'
  /** The ref names a pack other than the manifest shipping it. */
  | 'pack_template_ref_pack_mismatch'
  /** A visitor field name matches the forbidden vocabulary. */
  | 'pack_template_forbidden_field_name'
  /** A visitor field type outside `allowed_field_types`. */
  | 'pack_template_field_type_not_allowed'
  /** A visitor field whose name / label / type infer a PII class outside
   *  `allowed_visitor_pii_classes` (the ceiling, enforced). */
  | 'pack_template_visitor_pii'
  /** `values` on a non-enum field, or `values` that is not a string array —
   *  the endpoint validator only inspects `values` on enum fields, and the
   *  authoring form assumes an array. */
  | 'pack_template_field_values_misplaced'
  /** `anti_spam_defaults.rate_limit_per_ip` above the substrate default. */
  | 'pack_template_rate_limit_ceiling'
  /** `submission_processing_rule.target_kind` outside `allowed_target_kinds`. */
  | 'pack_template_target_kind';

export interface PackIntakeFormTemplateValidationFailure {
  readonly code: PackIntakeFormTemplateValidationCode;
  readonly detail: string;
  /** Present only when `code === 'config_invalid'` — the inner
   *  `validateIntakeFormConfig` code that fired (re-emitted from the shared
   *  body validator). */
  readonly config_code?: IntakeFormConfigValidationCode;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Validate a pack-shipped intake template: shape → `pack:` ref (+ owner
 *  match when the caller knows the shipping pack) → the SHARED body validator
 *  → the safety-matrix clamp. Pure — no I/O. Empty result ⇒ valid, and a valid
 *  template converts through `intakeFormConfigFromTemplate` into a config the
 *  endpoint validator accepts (the Foundation acceptance bridge, inherited). */
export const validatePackIntakeFormTemplate = (
  template: unknown,
  owner?: PackIntakeFormTemplateOwner,
  matrix: PackIntakeFormTemplateSafetyMatrix = PACK_INTAKE_FORM_TEMPLATE_SAFETY_MATRIX,
): ReadonlyArray<PackIntakeFormTemplateValidationFailure> => {
  const failures: PackIntakeFormTemplateValidationFailure[] = [];
  if (!isRecord(template)) {
    failures.push({ code: 'template_shape_invalid', detail: 'pack intake_form template must be an object' });
    return failures;
  }
  const t = template;

  // 1. The ref — grammar, then provenance.
  const parsed = parsePackIntakeFormTemplateRef(t.template_ref);
  if (parsed === null) {
    failures.push({
      code: 'pack_template_ref_invalid',
      detail: `template_ref must match pack:<publisher>/<slug>/intake/<name> (≤ ${PACK_INTAKE_FORM_TEMPLATE_REF_MAX} chars, handles ${PACK_HANDLE_SOURCE}, name ${TEMPLATE_NAME_SOURCE})`,
    });
  } else if (owner !== undefined && (parsed.publisher !== owner.publisher || parsed.slug !== owner.slug)) {
    failures.push({
      code: 'pack_template_ref_pack_mismatch',
      detail: `template_ref names ${parsed.publisher}/${parsed.slug} but is shipped by ${owner.publisher}/${owner.slug} — a pack may only ship templates under its own name`,
    });
  }

  // 2. The shared body contract.
  for (const inner of validateIntakeFormTemplateBody(t)) {
    failures.push(inner as PackIntakeFormTemplateValidationFailure);
  }

  // 3. The matrix. Field checks run only over well-formed field records —
  //    the body validator already reports a malformed `fields` list, and a
  //    second report of the same defect would read as two.
  const formDefinition = t.form_definition;
  const fields = isRecord(formDefinition) && Array.isArray(formDefinition.fields)
    ? formDefinition.fields
    : [];
  const allowedTypes: ReadonlySet<string> = new Set(matrix.allowed_field_types);
  const allowedPii: ReadonlySet<VisitorPiiClass> = new Set(matrix.allowed_visitor_pii_classes);
  for (const field of fields) {
    if (!isRecord(field) || typeof field.name !== 'string') continue;
    const hit = packTemplateFieldNameMatchesForbidden(field.name, matrix.forbidden_field_names);
    if (hit !== undefined) {
      failures.push({
        code: 'pack_template_forbidden_field_name',
        detail: `form_definition.fields '${field.name}' matches forbidden name '${hit}' — a pack template may not propose collecting it; the owner can add such a field by hand after "Use template"`,
      });
    }
    if (typeof field.type === 'string' && !allowedTypes.has(field.type)) {
      failures.push({
        code: 'pack_template_field_type_not_allowed',
        detail: `form_definition.fields '${field.name}' type '${field.type}' is outside the pack-template matrix (${[...allowedTypes].join('|')})`,
      });
    }
    const pii = inferPackTemplateVisitorPiiClass({ name: field.name, label: field.label, type: field.type });
    if (!allowedPii.has(pii)) {
      failures.push({
        code: 'pack_template_visitor_pii',
        detail: `form_definition.fields '${field.name}' reads as ${pii} (from its name, label and type), outside the pack-template ceiling ${[...allowedPii].join('|')} — the owner can add such a field by hand after "Use template"`,
      });
    }
    if (field.values !== undefined) {
      const stringArray = Array.isArray(field.values) && field.values.every((v) => typeof v === 'string');
      if (field.type !== 'enum' || !stringArray) {
        failures.push({
          code: 'pack_template_field_values_misplaced',
          detail: `form_definition.fields '${field.name}' carries \`values\`, which only an enum field may carry, and only as a string array`,
        });
      }
    }
  }
  const antiSpam = t.anti_spam_defaults;
  if (isRecord(antiSpam) && typeof antiSpam.rate_limit_per_ip === 'number'
    && antiSpam.rate_limit_per_ip > matrix.rate_limit_per_ip_ceiling) {
    failures.push({
      code: 'pack_template_rate_limit_ceiling',
      detail: `anti_spam_defaults.rate_limit_per_ip ${antiSpam.rate_limit_per_ip} exceeds the pack-template ceiling ${matrix.rate_limit_per_ip_ceiling} — pack content may lower the substrate default, never raise it`,
    });
  }
  const rule = t.submission_processing_rule;
  if (isRecord(rule) && typeof rule.target_kind === 'string'
    && !(matrix.allowed_target_kinds as ReadonlyArray<string>).includes(rule.target_kind)) {
    failures.push({
      code: 'pack_template_target_kind',
      detail: `submission_processing_rule.target_kind '${rule.target_kind}' is not pack-shippable — a pack template may only target ${matrix.allowed_target_kinds.join('|')}; the destination is the owner's decision at "Use template"`,
    });
  }

  return failures;
};

export type PackIntakeFormTemplateParseResult =
  | { readonly ok: true; readonly template: PackIntakeFormTemplate }
  | { readonly ok: false; readonly failures: ReadonlyArray<PackIntakeFormTemplateValidationFailure> };

/** Parse + validate an unknown payload as a `PackIntakeFormTemplate`. */
export const parsePackIntakeFormTemplate = (
  input: unknown,
  owner?: PackIntakeFormTemplateOwner,
): PackIntakeFormTemplateParseResult => {
  const failures = validatePackIntakeFormTemplate(input, owner);
  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, template: input as PackIntakeFormTemplate };
};

// ────────────────────────────────────────────────────────────────
// Wire shapes — what `reception.template.list` carries for pack templates
// ────────────────────────────────────────────────────────────────

/** One pack template as the gallery receives it: the template plus the
 *  provenance the card renders and the seed resolver keys on. */
export interface PackReceptionTemplateListing {
  readonly template: PackIntakeFormTemplate;
  readonly pack_slug: string;
  readonly publisher: string;
  /** `manifest.name` at install time — the card's "From <pack>" line. */
  readonly pack_name: string;
  /** `manifest.version` at install time. A template rides its pack's version. */
  readonly pack_version: number;
}

/** A stored pack template the server could not admit at read time — a row
 *  written under an earlier rule set that a later matrix tightening now
 *  refuses. Reported, never silently dropped: the declaration-vs-absence
 *  honesty the design asks for, restored for the persisted model. */
export interface PackReceptionTemplateUnavailable {
  readonly template_ref: string;
  readonly pack_slug: string;
  readonly reason: PackIntakeFormTemplateValidationCode;
}
