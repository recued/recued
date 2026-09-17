/** D-151 — pre-built `scheduling_link` / `reception_page` / `drop_link` /
 *  `approval_link` config templates (the non-intake half of the Reception
 *  Templates browser).
 *
 *  D-149 P11 § A.10 shipped the `intake_form` template substrate
 *  (`intake-form-template.ts`) — six Foundation-pack manifests the
 *  Reception Templates gallery projects, each convertible to a
 *  concrete `IntakeFormConfig` via `intakeFormConfigFromTemplate`. This
 *  file is the parallel substrate for the OTHER create-available reception
 *  kinds: a `scheduling_link` booking front-door, the singleton
 *  `reception_page` contact page, a `drop_link` file-upload front-door,
 *  and a single-purpose `approval_link` action token. (Only `status_link`
 *  stays template-less — it is create-hidden until its visitor reader
 *  lands.) The gallery's "+ New" entry point (D-151 `b0f953cc`) renders
 *  these cards alongside the intake ones, and "Use template" opens the
 *  SAME per-kind authoring form the manual `reception-new-endpoint` /
 *  `reception-edit-page` paths use — the only thing missing was a
 *  starting-point config to seed it with.
 *
 *  ── Why a separate file, not a widening of intake-form-template.ts ──
 *  An `IntakeFormTemplate` carries intake-specific machinery — a
 *  `form_definition`, an `anti_spam_defaults` bundle — none of which a
 *  scheduling link, contact page, drop link, or approval link has. The
 *  shared concept
 *  across these kinds is thin: presentation metadata (`name` /
 *  `description` / `version`) plus a starting config. So the intake
 *  substrate stays untouched (its closed-list refs, its docs-currency
 *  lint, its tests) and this file adds a minimal `ReceptionConfigTemplate`
 *  discriminated union for the config-only kinds. The wire
 *  (`reception.template.list`) carries both arrays.
 *
 *  ── The "template validates ⇒ generated config validates" invariant ──
 *  Mirroring the intake bridge (D-149 P11): each template stores the FULL
 *  per-kind config MINUS the user-typed display name. The validator
 *  injects a placeholder display name and delegates to the SAME validator
 *  the `reception.endpoint.create` / `reception.page.upsert` rpc runs
 *  (`validateSchedulingLinkConfig` / `validateReceptionPageConfig` /
 *  `validateDropLinkConfig` / `validateApprovalLinkConfig`), so a template
 *  that validates clean structurally implies the config it generates
 *  validates clean. The display name arrives at "Use template" time
 *  (`receptionConfigFromTemplate` opts) — for `reception_page` it nests
 *  under `config.display_overrides.display_name`; for every other kind it
 *  is the top-level `config.display_name`.
 *
 *  ── The `approval_link` `on_action.target_id` placeholder ─────────────
 *  An approval link binds to ONE specific work entity (`on_action.target_id`,
 *  a required non-empty string). A generic template can't know that id, so
 *  the approval templates ship a clearly-labeled placeholder target_id —
 *  non-empty (so the template + the converted config both validate) and
 *  surfaced as an editable field in the authoring form, where the user
 *  replaces it before creating the endpoint.
 *
 *  Spec: D-151 + D-149 § A.10 (the intake
 *  template precedent this parallels). */

import {
  validateSchedulingLinkConfig,
  type SchedulingLinkConfig,
} from './scheduling-link-config.js';
import {
  validateReceptionPageConfig,
  type ReceptionPageConfig,
  type ReceptionPageDisplayOverrides,
} from './reception-page-config.js';
import {
  validateDropLinkConfig,
  type DropLinkConfig,
} from './drop-link-config.js';
import {
  validateApprovalLinkConfig,
  type ApprovalLinkConfig,
} from './approval-link-config.js';

// ────────────────────────────────────────────────────────────────
// Closed-list template refs (adding a ref is a substrate change)
// ────────────────────────────────────────────────────────────────

/** Closed list of Foundation-pack `scheduling_link` template refs. Each
 *  ref has a 1:1 JSON file under the pack's `config-templates/` directory
 *  + a documentation section in internal design notes. Adding a
 *  template is a substrate code change here, not a config drop-in. */
export const SCHEDULING_LINK_TEMPLATE_REFS = [
  'foundation:scheduling/intro_call',
  'foundation:scheduling/office_hours',
  'foundation:scheduling/consultation',
] as const;

export type SchedulingLinkTemplateRef = (typeof SCHEDULING_LINK_TEMPLATE_REFS)[number];

/** Closed list of Foundation-pack `reception_page` template refs. */
export const RECEPTION_PAGE_TEMPLATE_REFS = [
  'foundation:page/personal_contact',
  'foundation:page/freelancer_hub',
  'foundation:page/small_business_desk',
] as const;

export type ReceptionPageTemplateRef = (typeof RECEPTION_PAGE_TEMPLATE_REFS)[number];

/** Closed list of Foundation-pack `drop_link` template refs. */
export const DROP_LINK_TEMPLATE_REFS = [
  'foundation:drop/document_request',
  'foundation:drop/signed_return',
  'foundation:drop/photo_upload',
] as const;

export type DropLinkTemplateRef = (typeof DROP_LINK_TEMPLATE_REFS)[number];

/** Closed list of Foundation-pack `approval_link` template refs. */
export const APPROVAL_LINK_TEMPLATE_REFS = [
  'foundation:approval/approve_message',
  'foundation:approval/quick_question',
  'foundation:approval/pick_time',
] as const;

export type ApprovalLinkTemplateRef = (typeof APPROVAL_LINK_TEMPLATE_REFS)[number];

/** Every config-template ref, in canonical gallery order (scheduling
 *  links, contact pages, drop links, then approval links). */
export const RECEPTION_CONFIG_TEMPLATE_REFS = [
  ...SCHEDULING_LINK_TEMPLATE_REFS,
  ...RECEPTION_PAGE_TEMPLATE_REFS,
  ...DROP_LINK_TEMPLATE_REFS,
  ...APPROVAL_LINK_TEMPLATE_REFS,
] as const;

export type ReceptionConfigTemplateRef = (typeof RECEPTION_CONFIG_TEMPLATE_REFS)[number];

export const RECEPTION_CONFIG_TEMPLATE_REF_SET: ReadonlySet<ReceptionConfigTemplateRef> = new Set(
  RECEPTION_CONFIG_TEMPLATE_REFS,
);

export const isReceptionConfigTemplateRef = (
  value: unknown,
): value is ReceptionConfigTemplateRef =>
  typeof value === 'string' &&
  RECEPTION_CONFIG_TEMPLATE_REF_SET.has(value as ReceptionConfigTemplateRef);

/** The config-only reception kinds this substrate templates. The
 *  intake_form kind is templated by `intake-form-template.ts`;
 *  `status_link` is not template-authorable (create-hidden until its
 *  visitor reader lands — no Foundation starter config). */
export type ReceptionConfigTemplateKind =
  | 'scheduling_link'
  | 'reception_page'
  | 'drop_link'
  | 'approval_link';

/** Ref → kind map, derived from the two per-kind closed lists so the two
 *  never drift. Used to gate `kind` against `template_ref` at validation
 *  time (a `kind` that disagrees with the ref's namespace is a
 *  copy-paste error). */
export const RECEPTION_CONFIG_TEMPLATE_REF_KIND: Readonly<
  Record<ReceptionConfigTemplateRef, ReceptionConfigTemplateKind>
> = Object.fromEntries([
  ...SCHEDULING_LINK_TEMPLATE_REFS.map(
    (r) => [r, 'scheduling_link'] as const,
  ),
  ...RECEPTION_PAGE_TEMPLATE_REFS.map((r) => [r, 'reception_page'] as const),
  ...DROP_LINK_TEMPLATE_REFS.map((r) => [r, 'drop_link'] as const),
  ...APPROVAL_LINK_TEMPLATE_REFS.map((r) => [r, 'approval_link'] as const),
]) as Record<ReceptionConfigTemplateRef, ReceptionConfigTemplateKind>;

// ────────────────────────────────────────────────────────────────
// Closed-list bound constants (mirroring the intake template caps)
// ────────────────────────────────────────────────────────────────

/** Template display name (gallery card label) length cap. */
export const RECEPTION_CONFIG_TEMPLATE_NAME_MAX = 80;
/** Template description (gallery card blurb) length cap. */
export const RECEPTION_CONFIG_TEMPLATE_DESCRIPTION_MAX = 400;
/** Semver-shape `version` field. Templates version independently of the
 *  pack; the Foundation pack version pins which template versions ship. */
export const RECEPTION_CONFIG_TEMPLATE_VERSION_RE = /^\d+\.\d+\.\d+$/;

// ────────────────────────────────────────────────────────────────
// Template manifest shapes (discriminated union on `kind`)
// ────────────────────────────────────────────────────────────────

/** A `reception_page` template's stored config — the full
 *  `ReceptionPageConfig` minus the user-typed `display_overrides.display_name`
 *  (supplied at "Use template" time). */
export type ReceptionPageTemplateConfig = Omit<ReceptionPageConfig, 'display_overrides'> & {
  readonly display_overrides: Omit<ReceptionPageDisplayOverrides, 'display_name'>;
};

interface ReceptionConfigTemplateBase {
  /** Semver string; versions independently of the pack. */
  readonly version: string;
  /** Gallery card label (e.g. "Intro call"). */
  readonly name: string;
  /** Gallery card blurb — what the template configures. */
  readonly description: string;
}

/** A `scheduling_link` config template. `config` is a complete
 *  `SchedulingLinkConfig` minus `display_name` (the visitor-facing name,
 *  typically the user's first name / handle, supplied at use time). */
export interface SchedulingLinkTemplate extends ReceptionConfigTemplateBase {
  readonly template_ref: SchedulingLinkTemplateRef;
  readonly kind: 'scheduling_link';
  readonly config: Omit<SchedulingLinkConfig, 'display_name'>;
}

/** A `reception_page` config template. `config` is a complete
 *  `ReceptionPageConfig` minus `display_overrides.display_name`. */
export interface ReceptionPageTemplate extends ReceptionConfigTemplateBase {
  readonly template_ref: ReceptionPageTemplateRef;
  readonly kind: 'reception_page';
  readonly config: ReceptionPageTemplateConfig;
}

/** A `drop_link` config template. `config` is a complete `DropLinkConfig`
 *  minus `display_name` (the visitor-facing name, supplied at use time). */
export interface DropLinkTemplate extends ReceptionConfigTemplateBase {
  readonly template_ref: DropLinkTemplateRef;
  readonly kind: 'drop_link';
  readonly config: Omit<DropLinkConfig, 'display_name'>;
}

/** An `approval_link` config template. `config` is a complete
 *  `ApprovalLinkConfig` minus `display_name`. The `on_action.target_id`
 *  it carries is a placeholder (see the header note) the user replaces in
 *  the authoring form. */
export interface ApprovalLinkTemplate extends ReceptionConfigTemplateBase {
  readonly template_ref: ApprovalLinkTemplateRef;
  readonly kind: 'approval_link';
  readonly config: Omit<ApprovalLinkConfig, 'display_name'>;
}

/** Portable config-template manifest — parsed from a JSON file under
 *  `community/packs/recued-core/personal-organizer-foundation/config-templates/`,
 *  converted to a concrete per-kind config via `receptionConfigFromTemplate`
 *  at "Use template" time. */
export type ReceptionConfigTemplate =
  | SchedulingLinkTemplate
  | ReceptionPageTemplate
  | DropLinkTemplate
  | ApprovalLinkTemplate;

// ────────────────────────────────────────────────────────────────
// Validator
// ────────────────────────────────────────────────────────────────

export type ReceptionConfigTemplateValidationCode =
  | 'template_shape_invalid'
  | 'template_ref_unknown'
  | 'kind_unknown'
  | 'kind_ref_mismatch'
  | 'version_invalid'
  | 'name_invalid'
  | 'description_invalid'
  /** A delegated `validateSchedulingLinkConfig` / `validateReceptionPageConfig`
   *  failure on the template's `config`. `config_code` carries the inner
   *  validator's code (as a string — the two kinds have different code
   *  unions) so callers + tests can assert precisely. */
  | 'config_invalid';

export interface ReceptionConfigTemplateValidationFailure {
  readonly code: ReceptionConfigTemplateValidationCode;
  readonly detail: string;
  /** Present only when `code === 'config_invalid'` — the inner per-kind
   *  validator code that fired. */
  readonly config_code?: string;
}

/** Placeholder display name injected before delegating to the per-kind
 *  validator. The real display name arrives at conversion time; a
 *  non-empty placeholder keeps the delegation pure + passes the
 *  per-kind `display_name_empty` gate. */
const PLACEHOLDER_DISPLAY_NAME = 'Template placeholder';

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0;

/** Validate a `scheduling_link` template's raw `config`, delegating to
 *  the robust `validateSchedulingLinkConfig` (which tolerates `unknown`).
 *  Failures are re-emitted as `config_invalid` with the inner code. */
const validateSchedulingTemplateConfig = (
  rawConfig: unknown,
  out: ReceptionConfigTemplateValidationFailure[],
): void => {
  // `validateSchedulingLinkConfig` is `unknown`-safe; inject the
  // placeholder display_name only when `config` is object-shaped (else
  // the delegate reports `config_shape_invalid` itself).
  const candidate = isObject(rawConfig)
    ? { ...rawConfig, display_name: PLACEHOLDER_DISPLAY_NAME }
    : rawConfig;
  for (const inner of validateSchedulingLinkConfig(candidate)) {
    out.push({ code: 'config_invalid', detail: inner.detail, config_code: inner.code });
  }
};

/** Validate a `drop_link` template's raw `config`, delegating to the
 *  `unknown`-safe `validateDropLinkConfig`. Same shape as the scheduling
 *  delegate — inject the placeholder display_name only when object-shaped
 *  (else the delegate reports `config_shape_invalid` itself). */
const validateDropTemplateConfig = (
  rawConfig: unknown,
  out: ReceptionConfigTemplateValidationFailure[],
): void => {
  const candidate = isObject(rawConfig)
    ? { ...rawConfig, display_name: PLACEHOLDER_DISPLAY_NAME }
    : rawConfig;
  for (const inner of validateDropLinkConfig(candidate)) {
    out.push({ code: 'config_invalid', detail: inner.detail, config_code: inner.code });
  }
};

/** Validate an `approval_link` template's raw `config`, delegating to the
 *  `unknown`-safe `validateApprovalLinkConfig`. The placeholder
 *  `on_action.target_id` the templates ship is a real (non-empty) string,
 *  so it passes the delegate's `on_action_target_id_invalid` gate. */
const validateApprovalTemplateConfig = (
  rawConfig: unknown,
  out: ReceptionConfigTemplateValidationFailure[],
): void => {
  const candidate = isObject(rawConfig)
    ? { ...rawConfig, display_name: PLACEHOLDER_DISPLAY_NAME }
    : rawConfig;
  for (const inner of validateApprovalLinkConfig(candidate)) {
    out.push({ code: 'config_invalid', detail: inner.detail, config_code: inner.code });
  }
};

/** Validate a `reception_page` template's raw `config`. Unlike the
 *  scheduling validator, `validateReceptionPageConfig` takes a TYPED
 *  param and dereferences `display_overrides` / `sections_enabled` /
 *  `linked_endpoints` directly — so it would THROW on a malformed shape.
 *  Guard those three required sub-objects here (reporting `config_invalid`
 *  ourselves) before delegating, so a corrupt template file fails closed
 *  with failures rather than an exception. */
const validatePageTemplateConfig = (
  rawConfig: unknown,
  out: ReceptionConfigTemplateValidationFailure[],
): void => {
  if (!isObject(rawConfig)) {
    out.push({
      code: 'config_invalid',
      detail: 'config must be an object',
      config_code: 'config_shape_invalid',
    });
    return;
  }
  const overrides = rawConfig.display_overrides;
  const sections = rawConfig.sections_enabled;
  const linked = rawConfig.linked_endpoints;
  let canDelegate = true;
  if (!isObject(overrides)) {
    out.push({
      code: 'config_invalid',
      detail: 'config.display_overrides must be an object',
      config_code: 'display_overrides_invalid',
    });
    canDelegate = false;
  }
  if (!isObject(sections)) {
    out.push({
      code: 'config_invalid',
      detail: 'config.sections_enabled must be an object',
      config_code: 'sections_enabled_invalid',
    });
    canDelegate = false;
  }
  if (!isObject(linked)) {
    out.push({
      code: 'config_invalid',
      detail: 'config.linked_endpoints must be an object',
      config_code: 'linked_endpoints_invalid',
    });
    canDelegate = false;
  }
  if (!canDelegate) return;
  const candidate = {
    ...rawConfig,
    display_overrides: {
      ...(overrides as Record<string, unknown>),
      display_name: PLACEHOLDER_DISPLAY_NAME,
    },
  } as ReceptionPageConfig;
  for (const inner of validateReceptionPageConfig(candidate)) {
    out.push({ code: 'config_invalid', detail: inner.detail, config_code: inner.code });
  }
};

/** Validate a `ReceptionConfigTemplate`. Pure function — no I/O. Returns
 *  the list of failures; empty array ⇒ valid.
 *
 *  Metadata fields (`template_ref` / `kind` / `version` / `name` /
 *  `description`) are checked directly; the `config` is delegated to the
 *  per-kind config validator so "template validates clean" structurally
 *  implies "the generated config validates clean". */
export const validateReceptionConfigTemplate = (
  template: unknown,
): ReadonlyArray<ReceptionConfigTemplateValidationFailure> => {
  const failures: ReceptionConfigTemplateValidationFailure[] = [];
  if (!isObject(template)) {
    failures.push({
      code: 'template_shape_invalid',
      detail: 'reception config template must be an object',
    });
    return failures;
  }

  // template_ref — closed list.
  let ownRefKind: ReceptionConfigTemplateKind | null = null;
  if (!isReceptionConfigTemplateRef(template.template_ref)) {
    failures.push({
      code: 'template_ref_unknown',
      detail: `template_ref must be one of ${RECEPTION_CONFIG_TEMPLATE_REFS.join(', ')}`,
    });
  } else {
    ownRefKind = RECEPTION_CONFIG_TEMPLATE_REF_KIND[template.template_ref];
  }

  // kind — closed discriminator, gated against the ref's namespace.
  const kind = template.kind;
  if (
    kind !== 'scheduling_link' &&
    kind !== 'reception_page' &&
    kind !== 'drop_link' &&
    kind !== 'approval_link'
  ) {
    failures.push({
      code: 'kind_unknown',
      detail:
        "kind must be 'scheduling_link' | 'reception_page' | 'drop_link' | 'approval_link'",
    });
  } else if (ownRefKind !== null && kind !== ownRefKind) {
    failures.push({
      code: 'kind_ref_mismatch',
      detail: `kind '${kind}' disagrees with template_ref '${String(
        template.template_ref,
      )}' (expected '${ownRefKind}')`,
    });
  }

  // version — semver shape.
  if (
    typeof template.version !== 'string' ||
    !RECEPTION_CONFIG_TEMPLATE_VERSION_RE.test(template.version)
  ) {
    failures.push({
      code: 'version_invalid',
      detail: 'version must match <major>.<minor>.<patch>',
    });
  }

  // name / description.
  if (
    !isNonEmptyString(template.name) ||
    template.name.length > RECEPTION_CONFIG_TEMPLATE_NAME_MAX
  ) {
    failures.push({
      code: 'name_invalid',
      detail: `name must be a non-empty string ≤ ${RECEPTION_CONFIG_TEMPLATE_NAME_MAX} chars`,
    });
  }
  if (
    !isNonEmptyString(template.description) ||
    template.description.length > RECEPTION_CONFIG_TEMPLATE_DESCRIPTION_MAX
  ) {
    failures.push({
      code: 'description_invalid',
      detail: `description must be a non-empty string ≤ ${RECEPTION_CONFIG_TEMPLATE_DESCRIPTION_MAX} chars`,
    });
  }

  // config — delegate to the per-kind validator (gated on a known kind;
  // an unknown kind already failed above + has no validator to run).
  if (kind === 'scheduling_link') {
    validateSchedulingTemplateConfig(template.config, failures);
  } else if (kind === 'reception_page') {
    validatePageTemplateConfig(template.config, failures);
  } else if (kind === 'drop_link') {
    validateDropTemplateConfig(template.config, failures);
  } else if (kind === 'approval_link') {
    validateApprovalTemplateConfig(template.config, failures);
  }

  return failures;
};

// ────────────────────────────────────────────────────────────────
// Template → config conversion (the "Use template" bridge)
// ────────────────────────────────────────────────────────────────

/** Per-endpoint options the template can't know — the user's display
 *  name. For `scheduling_link` it becomes `config.display_name`; for
 *  `reception_page` it nests under `config.display_overrides.display_name`. */
export interface ReceptionConfigFromTemplateOptions {
  readonly display_name: string;
}

/** Convert a `scheduling_link` template into a concrete
 *  `SchedulingLinkConfig`. Pure — assumes the template already passed
 *  `validateReceptionConfigTemplate`. */
export const schedulingLinkConfigFromTemplate = (
  template: SchedulingLinkTemplate,
  opts: ReceptionConfigFromTemplateOptions,
): SchedulingLinkConfig => ({
  ...template.config,
  display_name: opts.display_name,
});

/** Convert a `reception_page` template into a concrete
 *  `ReceptionPageConfig`. Pure — assumes the template already passed
 *  `validateReceptionConfigTemplate`. */
export const receptionPageConfigFromTemplate = (
  template: ReceptionPageTemplate,
  opts: ReceptionConfigFromTemplateOptions,
): ReceptionPageConfig => ({
  ...template.config,
  display_overrides: {
    ...template.config.display_overrides,
    display_name: opts.display_name,
  },
});

/** Convert a `drop_link` template into a concrete `DropLinkConfig`. Pure —
 *  assumes the template already passed `validateReceptionConfigTemplate`. */
export const dropLinkConfigFromTemplate = (
  template: DropLinkTemplate,
  opts: ReceptionConfigFromTemplateOptions,
): DropLinkConfig => ({
  ...template.config,
  display_name: opts.display_name,
});

/** Convert an `approval_link` template into a concrete `ApprovalLinkConfig`.
 *  Pure — assumes the template already passed
 *  `validateReceptionConfigTemplate`. The placeholder `on_action.target_id`
 *  carries through verbatim; the user replaces it in the authoring form. */
export const approvalLinkConfigFromTemplate = (
  template: ApprovalLinkTemplate,
  opts: ReceptionConfigFromTemplateOptions,
): ApprovalLinkConfig => ({
  ...template.config,
  display_name: opts.display_name,
});

/** A converted config-template seed — the kind + the concrete config the
 *  webclient host hands to `openAuthoringForm` as `initialConfig`. The
 *  kind is carried so the host routes to the right authoring form without
 *  re-parsing the ref. */
export type ReceptionConfigTemplateSeed =
  | { readonly kind: 'scheduling_link'; readonly config: SchedulingLinkConfig }
  | { readonly kind: 'reception_page'; readonly config: ReceptionPageConfig }
  | { readonly kind: 'drop_link'; readonly config: DropLinkConfig }
  | { readonly kind: 'approval_link'; readonly config: ApprovalLinkConfig };

/** Convert a `ReceptionConfigTemplate` into a per-kind seed. Exhaustive
 *  over the discriminated union — tsc enforces a branch per kind. Pure —
 *  no I/O, never throws. */
export const receptionConfigFromTemplate = (
  template: ReceptionConfigTemplate,
  opts: ReceptionConfigFromTemplateOptions,
): ReceptionConfigTemplateSeed => {
  switch (template.kind) {
    case 'scheduling_link':
      return {
        kind: 'scheduling_link',
        config: schedulingLinkConfigFromTemplate(template, opts),
      };
    case 'reception_page':
      return {
        kind: 'reception_page',
        config: receptionPageConfigFromTemplate(template, opts),
      };
    case 'drop_link':
      return {
        kind: 'drop_link',
        config: dropLinkConfigFromTemplate(template, opts),
      };
    case 'approval_link':
      return {
        kind: 'approval_link',
        config: approvalLinkConfigFromTemplate(template, opts),
      };
  }
};

// ────────────────────────────────────────────────────────────────
// Parse helper
// ────────────────────────────────────────────────────────────────

/** `parseReceptionConfigTemplate` result — ok-form carries the typed
 *  template; not-ok carries the validation failures. */
export type ReceptionConfigTemplateParseResult =
  | { readonly ok: true; readonly template: ReceptionConfigTemplate }
  | {
      readonly ok: false;
      readonly failures: ReadonlyArray<ReceptionConfigTemplateValidationFailure>;
    };

/** Parse + validate an unknown JSON payload as a `ReceptionConfigTemplate`.
 *  Thin wrapper over `validateReceptionConfigTemplate` — used by the
 *  backend template-file loader + the docs-currency / community-file
 *  tests. */
export const parseReceptionConfigTemplate = (
  input: unknown,
): ReceptionConfigTemplateParseResult => {
  const failures = validateReceptionConfigTemplate(input);
  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, template: input as ReceptionConfigTemplate };
};
