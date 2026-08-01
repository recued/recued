/** D-149 § A.10 — Settings → Server → Reception → Intake forms →
 *  Templates browser.
 *
 *  The fourth satellite Settings surface attaching to the § A.9
 *  management spine (`reception.ts`), after the Abuse Inbox subview, the
 *  per-kind authoring forms, and the View-As-Visitor panel. P11 shipped
 *  the template substrate — the six Foundation-pack `intake_form`
 *  template JSONs (`community/packs/recued-core/personal-organizer-foundation/templates/`),
 *  the `INTAKE_FORM_TEMPLATE_REFS` closed list, the `IntakeFormTemplate`
 *  manifest + `validateIntakeFormTemplate`, and the
 *  `intakeFormConfigFromTemplate` conversion bridge — but, consistent
 *  with how P4-P12 each deferred its Settings UX, nothing rendered it.
 *  This is the projection layer.
 *
 *  One surface:
 *
 *    - **Templates browser** (Settings → Server → Reception → Intake
 *      forms → "Use template") — a card per Foundation-pack template:
 *      the name + preview blurb, the target work-entity kind, a summary
 *      of what the form collects from a visitor (the honeypot bot-bait
 *      fields excluded — they are spam traps, not real collection), the
 *      visitor-email posture, the suggested Standing Instruction the
 *      template ships (its action explained in plain copy + the
 *      template author's rationale), and the anti-spam defaults
 *      one-lined. "Use template" mints a concrete `IntakeFormConfig`
 *      from the template + the user's display name.
 *
 *  ── Where the six template JSONs come from (the P11 open question) ──
 *  This module is **projection only** — `buildIntakeFormTemplatesBrowserModel`
 *  takes a `ReadonlyArray<IntakeFormTemplate>` the route supplies (via the
 *  standalone templates-browser modal).
 *  It deliberately does NOT own the wire mechanism: the templates are
 *  server-side pack content (they live under `community/packs/…`), and
 *  per the D-148 § A.4 invariant the webclient projects server-supplied
 *  state, never synthesises — so the templates reach the webclient FROM
 *  the server. WHICH server path (a thin `reception.template.*` rpc that
 *  reads the installed Foundation pack, or the templates riding the
 *  existing reception page-model fetch) is the page-shell follow-on's
 *  call, exactly as `reception-abuse-inbox.ts` does not own the
 *  `reception.abuse_inbox.list` plumbing and `reception-view-as-visitor.ts`
 *  does not own the `reception.endpoint.preview_draft` rpc. The module
 *  stays a pure consumer of `@recued/contracts` — NO contracts change,
 *  NO backend change — and tolerates a partial set (`missing_refs` /
 *  `is_complete` surface a partial load honestly rather than silently
 *  showing fewer cards).
 *
 *  ── No dispatch builder of its own ────────────────────────────────
 *  The "Use template" action produces an `IntakeFormConfig`, not an rpc
 *  payload. That config flows into `reception-authoring.ts`'s
 *  `buildIntakeFormFormModel` (the user reviews / edits it) and only
 *  then through `buildEndpointPreviewDispatch` → `buildEndpointCreateDispatch`
 *  — the dispatch builders the authoring sibling already owns. So the
 *  bridge this module adds is `useIntakeFormTemplate` (display-name
 *  pre-check + the contract's `intakeFormConfigFromTemplate`
 *  conversion); `intakeFormConfigFromTemplate` and `buildIntakeFormFormModel`
 *  are re-exported so the page shell composes "Use template" → editable
 *  form with a single module import (same discipline as
 *  `reception-view-as-visitor.ts` re-exporting `buildEndpointPreviewDispatch`).
 *
 *  `INTAKE_FORM_TARGET_KIND_COPY` and `RECEPTION_VISITOR_FIELD_REQUIREMENT_COPY`
 *  are imported from the authoring sibling — one copy registry per
 *  concept across the Reception Settings surface, same discipline as the
 *  shared `computeExpiryLabel` / `truncateSourceIpHash`.
 *
 *  Spec: D-149 § A.10 (Pre-built intake_form templates) +
 *  § P11 (template substrate the browser projects). */

import {
  INTAKE_FORM_DISPLAY_NAME_MAX,
  INTAKE_FORM_TEMPLATE_REFS,
  intakeFormConfigFromTemplate,
  type IntakeFormConfig,
  type IntakeFormConfigFromTemplateOptions,
  type IntakeFormTargetKind,
  type IntakeFormTemplate,
  type IntakeFormTemplateRef,
} from '@recued/contracts';

import {
  RECEPTION_VISITOR_FIELD_REQUIREMENT_COPY,
  buildIntakeFormFormModel,
  intakeFormTargetKindCopy,
  type ReceptionVisitorFieldRequirement,
} from './reception-authoring.js';

// ════════════════════════════════════════════════════════════════
// Template card projection
// ════════════════════════════════════════════════════════════════

/** A label + required flag for one visitor-meaningful form field. */
export interface IntakeFormTemplateFieldLabel {
  label: string;
  required: boolean;
}

/** Summary of what a template's form collects from a visitor. Honeypot
 *  bot-bait fields are EXCLUDED from the visitor-meaningful counts +
 *  labels — they render as hidden inputs and exist to trap bots, not to
 *  collect anything. The validator (`validateIntakeFormConfig`) enforces
 *  `anti_spam.honeypot_fields ⊆ form_definition field names`, so for a
 *  valid template `total_field_count === visitor_field_count + honeypot_field_count`. */
export interface IntakeFormTemplateCollectedFields {
  /** Every `form_definition.fields` entry — including honeypots. */
  total_field_count: number;
  /** Fields a visitor meaningfully fills in = `fields` minus honeypots. */
  visitor_field_count: number;
  honeypot_field_count: number;
  /** Visitor-meaningful fields the visitor MUST fill in. */
  required_field_count: number;
  /** Visitor-meaningful fields the visitor MAY leave blank. */
  optional_field_count: number;
  /** Visitor-meaningful field labels, in `form_definition` order — the
   *  "collects: name, company, …" preview line. Honeypots excluded. */
  field_labels: ReadonlyArray<IntakeFormTemplateFieldLabel>;
}

/** One-lined summary of the anti-spam protections the substrate actually
 *  enforces. Reserved PoW / CAPTCHA contract flags remain available for
 *  template compatibility but are deliberately not advertised here. */
export interface IntakeFormTemplateAntiSpamSummary {
  honeypot_field_count: number;
  /** Per-IP submission ceiling (per hour — the `intake_form` rate-limit
   *  window). */
  rate_limit_per_ip: number;
  require_proof_of_work: boolean;
  require_captcha: boolean;
  /** Human one-liner — "5 submissions per IP per hour · 1 honeypot
   *  field". */
  summary_label: string;
}

/** One Templates-browser card — the projection of one `IntakeFormTemplate`. */
export interface IntakeFormTemplateCardModel {
  /** Closed-list ref — the template's stable identity + card key. */
  template_ref: IntakeFormTemplateRef;
  /** Semver string (versions independently of the pack). */
  version: string;
  /** Settings UX list label (e.g. "Client inquiry"). */
  name: string;
  /** Settings UX preview blurb — what the template collects + does. */
  description: string;
  /** Default visitor-facing instructions paragraph the template ships
   *  — the renderer can show it as a secondary preview blurb. `null`
   *  when the template omits one. */
  default_instructions: string | null;
  /** Where each submission lands (`task` / `note` / `commitment` /
   *  `inbox_item`). D-210 WS2: `null` = log-only — the template materialises
   *  no destination entity (the response itself is recorded either way). */
  target_kind: IntakeFormTargetKind | null;
  target_kind_label: string;
  /** "What this entity kind is" copy (from `intakeFormTargetKindCopy`). */
  target_kind_description: string;
  /** What the form collects from a visitor (honeypots excluded). */
  collected: IntakeFormTemplateCollectedFields;
  /** `required_visitor_fields.email` posture — whether the substrate-
   *  injected visitor-email field is required / optional / omitted. */
  collects_email: ReceptionVisitorFieldRequirement;
  collects_email_label: string;
  /** "What this requirement means" copy (from
   *  `RECEPTION_VISITOR_FIELD_REQUIREMENT_COPY`). */
  collects_email_description: string;
  /** The template's anti-spam defaults, one-lined. */
  anti_spam: IntakeFormTemplateAntiSpamSummary;
}

/** Project a template's `form_definition` + `anti_spam_defaults` into
 *  the collected-fields summary. Honeypot fields are filtered out of the
 *  visitor-meaningful set — they are spam traps, not real collection. */
const buildCollectedFields = (
  template: IntakeFormTemplate,
): IntakeFormTemplateCollectedFields => {
  const honeypotSet = new Set(template.anti_spam_defaults.honeypot_fields);
  const fields = template.form_definition.fields;
  const visitorFields = fields.filter((f) => !honeypotSet.has(f.name));
  const requiredCount = visitorFields.filter((f) => f.required).length;
  return {
    total_field_count: fields.length,
    visitor_field_count: visitorFields.length,
    honeypot_field_count: fields.length - visitorFields.length,
    required_field_count: requiredCount,
    optional_field_count: visitorFields.length - requiredCount,
    field_labels: visitorFields.map((f) => ({ label: f.label, required: f.required })),
  };
};

/** Project a template's `anti_spam_defaults` into the one-lined summary. */
const buildAntiSpamSummary = (
  template: IntakeFormTemplate,
  honeypot_field_count: number,
): IntakeFormTemplateAntiSpamSummary => {
  const spam = template.anti_spam_defaults;
  const parts: string[] = [
    `${spam.rate_limit_per_ip} submission${spam.rate_limit_per_ip === 1 ? '' : 's'} per IP per hour`,
  ];
  if (honeypot_field_count > 0) {
    parts.push(
      `${honeypot_field_count} honeypot field${honeypot_field_count === 1 ? '' : 's'}`,
    );
  }
  return {
    honeypot_field_count,
    rate_limit_per_ip: spam.rate_limit_per_ip,
    require_proof_of_work: spam.require_proof_of_work,
    require_captcha: spam.require_captcha,
    summary_label: parts.join(' · '),
  };
};

/** Project one `IntakeFormTemplate` into a Templates-browser card.
 *  Pure — no I/O. */
export const buildIntakeFormTemplateCardModel = (
  template: IntakeFormTemplate,
): IntakeFormTemplateCardModel => {
  const targetCopy = intakeFormTargetKindCopy(
    template.submission_processing_rule.target_kind,
  );
  const emailReq = template.required_visitor_fields.email;
  const emailCopy = RECEPTION_VISITOR_FIELD_REQUIREMENT_COPY[emailReq];
  const collected = buildCollectedFields(template);
  return {
    template_ref: template.template_ref,
    version: template.version,
    name: template.name,
    description: template.description,
    default_instructions: template.default_instructions ?? null,
    // D-210 A.8 slice 2b step 3 — no `?? null`: a template's rule uses the same
    // `IntakeFormSubmissionProcessingRule`, where `target_kind` is REQUIRED.
    // Keeping the fallback would imply a shape that can no longer exist.
    target_kind: template.submission_processing_rule.target_kind,
    target_kind_label: targetCopy.label,
    target_kind_description: targetCopy.help,
    collected,
    collects_email: emailReq,
    collects_email_label: emailCopy.label,
    collects_email_description: emailCopy.help,
    anti_spam: buildAntiSpamSummary(template, collected.honeypot_field_count),
  };
};

// ════════════════════════════════════════════════════════════════
// Full Templates-browser model
// ════════════════════════════════════════════════════════════════

/** Full Settings → Reception → Intake forms → Templates browser model. */
export interface IntakeFormTemplatesBrowserModel {
  /** Projected cards in `INTAKE_FORM_TEMPLATE_REFS` canonical order —
   *  stable regardless of the order the templates were supplied in (same
   *  discipline as the spine grouping endpoints into
   *  `RECEPTION_ENDPOINT_KINDS` order). */
  cards: ReadonlyArray<IntakeFormTemplateCardModel>;
  total: number;
  /** True iff zero templates were supplied — the "Foundation pack
   *  templates didn't load" empty state. */
  is_empty: boolean;
  /** Closed-list `INTAKE_FORM_TEMPLATE_REFS` entries the supplied set
   *  did NOT cover — a partial-load / partial-install signal the
   *  renderer can surface ("4 of 6 templates loaded"). */
  missing_refs: ReadonlyArray<IntakeFormTemplateRef>;
  /** True iff every closed-list ref is present (`missing_refs` empty). */
  is_complete: boolean;
}

/** Build the renderable Templates-browser model from the server-supplied
 *  templates. Cards come out in `INTAKE_FORM_TEMPLATE_REFS` canonical
 *  order; a supplied template whose ref is not in the closed list is
 *  skipped (defensive — the contract types `template_ref` as a closed
 *  `IntakeFormTemplateRef`, so this is unreachable unless the contract
 *  widens ahead of this renderer). A duplicate ref is last-wins. Pure
 *  projection — the page shell re-runs it whenever it re-fetches the
 *  templates. */
export const buildIntakeFormTemplatesBrowserModel = (args: {
  templates: ReadonlyArray<IntakeFormTemplate>;
}): IntakeFormTemplatesBrowserModel => {
  const byRef = new Map<IntakeFormTemplateRef, IntakeFormTemplate>();
  for (const template of args.templates) byRef.set(template.template_ref, template);

  const cards: IntakeFormTemplateCardModel[] = [];
  const missing_refs: IntakeFormTemplateRef[] = [];
  for (const ref of INTAKE_FORM_TEMPLATE_REFS) {
    const template = byRef.get(ref);
    if (template === undefined) {
      missing_refs.push(ref);
      continue;
    }
    cards.push(buildIntakeFormTemplateCardModel(template));
  }

  return {
    cards,
    total: cards.length,
    is_empty: cards.length === 0,
    missing_refs,
    is_complete: missing_refs.length === 0,
  };
};

// ════════════════════════════════════════════════════════════════
// "Use template" bridge — display-name pre-check + the contract's
// template → IntakeFormConfig conversion. NOT a dispatch builder: the
// generated config flows into `reception-authoring.ts`'s
// `buildIntakeFormFormModel` (review / edit) before any rpc.
// ════════════════════════════════════════════════════════════════

/** Closed list of display-name validation codes for the "Use template"
 *  dialog. Mirrors the relevant `IntakeFormConfigValidationCode` members
 *  — `intakeFormConfigFromTemplate` does NOT validate `opts.display_name`
 *  (it assumes a valid caller), so the Templates browser pre-checks the
 *  one user-typed field before conversion. The check mirrors
 *  `validateIntakeFormConfig`'s `display_name` rules exactly so a config
 *  that passes here also passes the downstream validator. */
export type TemplateDisplayNameValidationCode =
  | 'display_name_empty'
  | 'display_name_too_long';

/** Closed-list `TemplateDisplayNameValidationCode` → remediation copy.
 *  Surfaced inline in the "Use template" dialog. */
export const TEMPLATE_DISPLAY_NAME_ERROR_COPY: Readonly<
  Record<TemplateDisplayNameValidationCode, string>
> = {
  display_name_empty:
    'Enter a display name — it becomes the visitor-facing heading on the form.',
  display_name_too_long: `The display name must be ${INTAKE_FORM_DISPLAY_NAME_MAX} characters or fewer.`,
};

/** Validate the user-typed display name the "Use template" dialog
 *  collects, before `intakeFormConfigFromTemplate` conversion. Returns
 *  the first failing code, or `null` when valid. Mirrors
 *  `validateIntakeFormConfig`'s `display_name` checks (empty after
 *  trim → `display_name_empty`; over the length cap → `display_name_too_long`).
 *  Pure — no I/O. */
export const validateTemplateDisplayName = (
  display_name: string,
): TemplateDisplayNameValidationCode | null => {
  if (display_name.trim().length === 0) return 'display_name_empty';
  if (display_name.length > INTAKE_FORM_DISPLAY_NAME_MAX) return 'display_name_too_long';
  return null;
};

/** `useIntakeFormTemplate` result — ok-form carries the concrete
 *  `IntakeFormConfig` ready for `buildIntakeFormFormModel`; not-ok
 *  carries the display-name failure code + its remediation copy. Mirrors
 *  the contract's `IntakeFormTemplateParseResult` result-union shape. */
export type UseIntakeFormTemplateResult =
  | { readonly ok: true; readonly config: IntakeFormConfig }
  | {
      readonly ok: false;
      readonly code: TemplateDisplayNameValidationCode;
      readonly detail: string;
    };

/** The "Use template" bridge — pre-checks the user-typed `display_name`,
 *  then delegates to the contract's `intakeFormConfigFromTemplate`. On
 *  success the returned `IntakeFormConfig` flows straight into
 *  `buildIntakeFormFormModel` (re-exported below) for the user to review
 *  / edit before preview + create. Assumes `template` already passed
 *  `validateIntakeFormTemplate` (the page shell / a test validates the
 *  raw JSON via `parseIntakeFormTemplate` before it ever reaches this
 *  module). `opts.form_definition_id` is a machine-generated per-endpoint
 *  id, not user input — not validated here. Pure — no I/O. */
export const useIntakeFormTemplate = (
  template: IntakeFormTemplate,
  opts: IntakeFormConfigFromTemplateOptions,
): UseIntakeFormTemplateResult => {
  const code = validateTemplateDisplayName(opts.display_name);
  if (code !== null) {
    return { ok: false, code, detail: TEMPLATE_DISPLAY_NAME_ERROR_COPY[code] };
  }
  return { ok: true, config: intakeFormConfigFromTemplate(template, opts) };
};

// ════════════════════════════════════════════════════════════════
// Re-exports — so the page shell composes the Templates browser + the
// "Use template" → editable-form flow with a single module import.
// ════════════════════════════════════════════════════════════════

/** Re-export of the contract's template → `IntakeFormConfig` converter
 *  (the raw bridge `useIntakeFormTemplate` wraps) + the closed-list
 *  refs + the display-name cap, so the renderer enumerates / converts
 *  without a second `@recued/contracts` import. */
export {
  INTAKE_FORM_TEMPLATE_REFS,
  INTAKE_FORM_DISPLAY_NAME_MAX,
  intakeFormConfigFromTemplate,
};

/** Re-export of the authoring sibling's `buildIntakeFormFormModel` so
 *  the page shell composes "Use template" (`useIntakeFormTemplate` →
 *  `IntakeFormConfig`) → editable authoring form with one import — same
 *  one-import discipline as `reception-view-as-visitor.ts` re-exporting
 *  `buildEndpointPreviewDispatch`. */
export { buildIntakeFormFormModel };
