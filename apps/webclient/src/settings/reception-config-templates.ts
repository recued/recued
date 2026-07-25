/** D-151 — Settings → Reception → Templates browser projection for the
 *  non-intake config templates (`scheduling_link` + `reception_page`).
 *
 *  Sibling of `reception-templates.ts` (the intake_form projection). The
 *  standalone templates gallery (`reception-templates-mount.ts`, the
 *  "+ New" entry point) renders these cards alongside the intake ones;
 *  "Use template" opens the per-kind authoring form seeded from the
 *  template's config. Projection only — `buildReceptionConfigTemplatesBrowserModel`
 *  takes the `reception.template.list` result's `config_templates` the page
 *  shell supplies, exactly as the intake projection consumes `templates`.
 *
 *  ── No conversion of its own ──────────────────────────────────────
 *  The "Use template" action produces a per-kind config via the contract's
 *  `receptionConfigFromTemplate` (re-exported), not an rpc payload. That
 *  config flows into the authoring form (`seedWorkingConfig` →
 *  `buildAuthoringView`) before any preview / create rpc — the same
 *  one-import discipline `reception-templates.ts` keeps for intake.
 *
 *  Spec: docs/d-151-spec.md + docs/d-149-spec.md § A.10. */

import {
  RECEPTION_CONFIG_TEMPLATE_REFS,
  receptionConfigFromTemplate,
  type ApprovalLinkTemplate,
  type DropLinkTemplate,
  type ReceptionConfigTemplate,
  type ReceptionConfigTemplateKind,
  type ReceptionConfigTemplateRef,
  type ReceptionConfigTemplateSeed,
  type ReceptionPageTemplate,
  type SchedulingLinkTemplate,
} from '@recued/contracts';

// ════════════════════════════════════════════════════════════════
// Copy registry — closed-list per-kind copy. tsc enforces completeness
// over the two config-template kinds.
// ════════════════════════════════════════════════════════════════

/** Per-`ReceptionConfigTemplateKind` user-facing copy. `label` is the
 *  card kind badge; `help` is the section-level "what this kind is"
 *  blurb the gallery groups cards under. */
export const RECEPTION_CONFIG_TEMPLATE_KIND_COPY: Readonly<
  Record<ReceptionConfigTemplateKind, { label: string; help: string }>
> = {
  scheduling_link: {
    label: 'Scheduling link',
    help: 'A booking front door — visitors pick a time from your availability and the request lands in your inbox for review.',
  },
  reception_page: {
    label: 'Contact page',
    help: 'Your single public front page — a contact card plus call-to-action buttons linking to your other reception endpoints.',
  },
  drop_link: {
    label: 'Drop link',
    help: 'A file-upload front door — visitors send you a document or image and each upload lands for your review.',
  },
  approval_link: {
    label: 'Approval link',
    help: 'A single-use action token — one person approves wording, answers a question, or picks a time, then the link closes.',
  },
};

// ════════════════════════════════════════════════════════════════
// Summary derivation — a one-line "what this configures" blurb per card.
// ════════════════════════════════════════════════════════════════

/** Derive a `scheduling_link` template's one-line summary —
 *  "15 / 30 min · 5 days/week · email required". Reads only the stored
 *  template config (no display name). */
const schedulingSummary = (template: SchedulingLinkTemplate): string => {
  const c = template.config;
  const durations = `${c.duration_options_minutes.join(' / ')} min`;
  const w = c.available_window_definition;
  let availability: string;
  if (w.explicit_windows !== undefined && w.explicit_windows.length > 0) {
    const days = new Set(w.explicit_windows.map((win) => win.day_of_week));
    availability = `${days.size} day${days.size === 1 ? '' : 's'}/week`;
  } else {
    availability = 'custom availability';
  }
  const email = c.required_visitor_fields.email;
  const emailPart =
    email === 'required' ? 'email required' : email === 'optional' ? 'email optional' : 'no email';
  return [durations, availability, emailPart].join(' · ');
};

/** Derive a `reception_page` template's one-line summary —
 *  "4 sections · email, phone". */
const pageSummary = (template: ReceptionPageTemplate): string => {
  const sections = template.config.sections_enabled;
  const enabled = Object.values(sections).filter((v) => v === true).length;
  const methods = template.config.display_overrides.preferred_contact_methods;
  const methodPart = methods.length > 0 ? methods.join(', ') : 'no contact methods';
  return [`${enabled} section${enabled === 1 ? '' : 's'}`, methodPart].join(' · ');
};

/** Friendly one-word category per closed-allowlist drop MIME type. */
const DROP_MIME_CATEGORY: Readonly<Record<string, string>> = {
  'application/pdf': 'PDF',
  'image/jpeg': 'images',
  'image/png': 'images',
  'image/webp': 'images',
  'image/gif': 'images',
  'text/plain': 'text',
};

/** Derive a `drop_link` template's one-line summary —
 *  "PDF, images · 25 MB max · reusable". */
const dropSummary = (template: DropLinkTemplate): string => {
  const c = template.config;
  // De-duped friendly categories, in first-seen order.
  const cats: string[] = [];
  for (const m of c.allowed_mime_types) {
    const cat = DROP_MIME_CATEGORY[m] ?? m;
    if (!cats.includes(cat)) cats.push(cat);
  }
  const mimePart = cats.length > 0 ? cats.join(', ') : 'any file';
  const mb = Math.round(c.size_cap_bytes / (1024 * 1024));
  const linkPart = c.link_kind === 'one_time' ? 'one-time' : 'reusable';
  return [mimePart, `${mb} MB max`, linkPart].join(' · ');
};

/** Friendly action label per `approval_link` action kind. */
const APPROVAL_ACTION_LABEL: Readonly<Record<string, string>> = {
  pick_time: 'Pick a time',
  confirm_attendance: 'Confirm attendance',
  approve_wording: 'Approve wording',
  answer_question: 'Answer a question',
  upload_doc: 'Upload a document',
};

/** Derive an `approval_link` template's one-line summary —
 *  "Pick a time · 3 options · 14-day" / "Approve wording · 14-day". */
const approvalSummary = (template: ApprovalLinkTemplate): string => {
  const c = template.config;
  const action = APPROVAL_ACTION_LABEL[c.action_kind] ?? c.action_kind;
  const parts = [action];
  if (c.options !== undefined && c.options.length > 0) {
    parts.push(`${c.options.length} option${c.options.length === 1 ? '' : 's'}`);
  }
  parts.push(`${c.expiry_days}-day`);
  return parts.join(' · ');
};

/** Derive the per-kind summary line for a config template. Exhaustive
 *  over the discriminated union. */
const buildSummaryLabel = (template: ReceptionConfigTemplate): string => {
  switch (template.kind) {
    case 'scheduling_link':
      return schedulingSummary(template);
    case 'reception_page':
      return pageSummary(template);
    case 'drop_link':
      return dropSummary(template);
    case 'approval_link':
      return approvalSummary(template);
  }
};

// ════════════════════════════════════════════════════════════════
// Card projection
// ════════════════════════════════════════════════════════════════

/** One config-template gallery card. */
export interface ReceptionConfigTemplateCardModel {
  /** Closed-list ref — the template's stable identity + card key. */
  template_ref: ReceptionConfigTemplateRef;
  /** The reception kind this template authors — drives which authoring
   *  form "Use template" opens. */
  kind: ReceptionConfigTemplateKind;
  /** Semver string (versions independently of the pack). */
  version: string;
  /** Gallery card label (e.g. "Intro call"). */
  name: string;
  /** Gallery card blurb — what the template configures. */
  description: string;
  /** Kind badge label (from `RECEPTION_CONFIG_TEMPLATE_KIND_COPY`). */
  kind_label: string;
  /** "What this kind is" copy (from `RECEPTION_CONFIG_TEMPLATE_KIND_COPY`). */
  kind_description: string;
  /** Derived one-line "what this configures" summary. */
  summary_label: string;
}

/** Project one `ReceptionConfigTemplate` into a gallery card. Pure. */
export const buildReceptionConfigTemplateCardModel = (
  template: ReceptionConfigTemplate,
): ReceptionConfigTemplateCardModel => {
  const copy = RECEPTION_CONFIG_TEMPLATE_KIND_COPY[template.kind];
  return {
    template_ref: template.template_ref,
    kind: template.kind,
    version: template.version,
    name: template.name,
    description: template.description,
    kind_label: copy.label,
    kind_description: copy.help,
    summary_label: buildSummaryLabel(template),
  };
};

// ════════════════════════════════════════════════════════════════
// Full config-templates browser model
// ════════════════════════════════════════════════════════════════

/** The non-intake half of the Templates browser model. */
export interface ReceptionConfigTemplatesBrowserModel {
  /** Projected cards in `RECEPTION_CONFIG_TEMPLATE_REFS` canonical order
   *  (scheduling links, then contact pages) — stable regardless of the
   *  order the templates were supplied in. */
  cards: ReadonlyArray<ReceptionConfigTemplateCardModel>;
  total: number;
  /** True iff zero config templates were supplied. */
  is_empty: boolean;
  /** Closed-list refs the supplied set did NOT cover — a partial-load
   *  signal the renderer can surface. */
  missing_refs: ReadonlyArray<ReceptionConfigTemplateRef>;
  /** True iff every closed-list ref is present (`missing_refs` empty). */
  is_complete: boolean;
}

/** Build the renderable config-templates browser model from the
 *  server-supplied templates. Cards come out in
 *  `RECEPTION_CONFIG_TEMPLATE_REFS` canonical order; a duplicate ref is
 *  last-wins; a supplied template whose ref is not in the closed list is
 *  skipped (defensive — the contract types `template_ref` as a closed
 *  ref). Pure projection. */
export const buildReceptionConfigTemplatesBrowserModel = (args: {
  templates: ReadonlyArray<ReceptionConfigTemplate>;
}): ReceptionConfigTemplatesBrowserModel => {
  const byRef = new Map<ReceptionConfigTemplateRef, ReceptionConfigTemplate>();
  for (const template of args.templates) byRef.set(template.template_ref, template);

  const cards: ReceptionConfigTemplateCardModel[] = [];
  const missing_refs: ReceptionConfigTemplateRef[] = [];
  for (const ref of RECEPTION_CONFIG_TEMPLATE_REFS) {
    const template = byRef.get(ref);
    if (template === undefined) {
      missing_refs.push(ref);
      continue;
    }
    cards.push(buildReceptionConfigTemplateCardModel(template));
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
// "Use template" → authoring seed
// ════════════════════════════════════════════════════════════════

/** Convert a config template into the authoring-form seed the gallery's
 *  "Use template" opens (display name blank — the user types it in the
 *  form, the same DD#4 posture as the intake seed bridge).
 *
 *  Beyond the contract's `receptionConfigFromTemplate`, this BLANKS an
 *  `approval_link`'s `on_action.target_id`. An approval link binds to ONE
 *  specific work item the template can't know, so its templates ship a
 *  non-empty placeholder (so both the template AND the converted config
 *  validate). Clearing it for the authoring seed makes the form open with
 *  an empty target_id — identical to a fresh approval form, where the
 *  contract validator's empty-string gate then forces deliberate entry on
 *  submit. Without this, a careless "Use template → Create" could mint a
 *  live link bound to the literal placeholder. Pure — no I/O. */
export const receptionConfigTemplateAuthoringSeed = (
  template: ReceptionConfigTemplate,
): ReceptionConfigTemplateSeed => {
  const seed = receptionConfigFromTemplate(template, { display_name: '' });
  if (seed.kind === 'approval_link') {
    return {
      kind: 'approval_link',
      config: {
        ...seed.config,
        on_action: { ...seed.config.on_action, target_id: '' },
      },
    };
  }
  return seed;
};

// ════════════════════════════════════════════════════════════════
// Re-export — the contract's template → per-kind config converter, so
// callers resolve a "Use template" pick into an authoring seed with a
// single module import (same discipline as `reception-templates.ts`
// re-exporting `intakeFormConfigFromTemplate`).
// ════════════════════════════════════════════════════════════════

export { RECEPTION_CONFIG_TEMPLATE_REFS, receptionConfigFromTemplate };
