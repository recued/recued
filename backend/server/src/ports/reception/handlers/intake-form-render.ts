/** D-149 P6 § A.5.3 — `intake_form` HTML renderer.
 *
 *  Server-rendered form — no SPA, no inline JS, no `script-src` CSP
 *  allowance. The visitor fills out a `<form>` with closed-list input
 *  types (`text` / `textarea` / `number` / `boolean` / `date` / `enum` /
 *  `array<text>` / `file`); submission round-trips to the same server
 *  via POST. Per spec § A.5.3 line 753-758 only the closed-list field
 *  types are emitted; `password` / `signature` / `trusted_html` /
 *  `ref<T>` are structurally absent from the visitor-side type enum.
 *
 *  Visitor-facing privacy contract (§ A.5.3 lines 760-762):
 *
 *    The renderer's INPUT is the redacted-packet payload built by
 *    `buildReceptionPacket('intake_form_packet', ...)` + the
 *    closed-shape `IntakeFormConfigField` array. Both feeds drop
 *    user-only metadata (per `user_only_field_names`) at the
 *    transformation boundary; the renderer receives only visitor-
 *    visible fields by construction.
 *
 *  The renderer's only job is to HTML-escape interpolations + emit the
 *  page shell. No additional fields beyond the closed-list inputs ever
 *  reach the HTML.
 *
 *  Honeypot fields: rendered with `aria-hidden="true"` + `tabindex="-1"`
 *  + the substrate CSS positions them off-screen. Bots fill every field;
 *  humans don't (the field is invisible). When the POST handler sees a
 *  non-empty honeypot value the submission is tagged `'spam'` per § A.5.3
 *  line 704.
 *
 *  Spec: D-149 § A.5.3 + § A.11 TR-2 + TR-14 + § A.5.3
 *  line 753-758 (public-mode field-type closed list). */

import {
  RECEPTION_PAGE_STATIC_PATH_PREFIX,
  INTAKE_FORM_VISITOR_TEXT_MAX,
  INTAKE_FORM_VISITOR_TEXTAREA_MAX,
  INTAKE_FORM_VISITOR_EMAIL_MAX,
  type IntakeFormConfigField,
  type IntakeFormVisitorFieldRequirement,
  type VisitorReceipt,
} from '@recued/contracts';
import {
  htmlEscape,
  renderReceptionOutputBlocks,
  type ReceptionOutputBlock,
} from './reception-page-render.js';
import { renderVisitorReceiptBlock } from './visitor-receipt.js';

// ────────────────────────────────────────────────────────────────
// Inputs
// ────────────────────────────────────────────────────────────────

export interface IntakeFormRenderInput {
  /** Visitor-facing display name (typically Mary's first name or
   *  handle). Length-bounded at config-validate time. */
  readonly display_name: string;
  /** Optional instructions paragraph (htmlEscape'd). */
  readonly instructions?: string;
  /** Visitor-visible fields. user_only fields stripped at the
   *  transformation boundary. */
  readonly fields: ReadonlyArray<IntakeFormConfigField>;
  /** Closed-list of honeypot field names — rendered as hidden inputs
   *  inside the same form so bots see + fill them. */
  readonly honeypot_fields: ReadonlyArray<string>;
  /** Email-field requirement per § A.5.3. When `'omit'` no email field
   *  is emitted at all. */
  readonly visitor_email_requirement: IntakeFormVisitorFieldRequirement;
  /** Submit-button label (per config; defaults to `'Submit'`). */
  readonly submit_button_label: string;
  /** Endpoint id (URL: `/reception/intake/<endpoint_id>` POST). */
  readonly endpoint_id: string;
  /** Per-request bearer secret — surfaces as a hidden form field so the
   *  POST request carries the token (renderer pulls this from the
   *  request URL query string). */
  readonly bearer_secret: string;
  /** Per-request form nonce — bound to the rendered page; POST
   *  validator requires it back verbatim. */
  readonly form_nonce: string;
  /** Optional per-field placeholder + descriptive text (server-side
   *  only, never reflected from visitor input). Reserved — P6 ships
   *  with empty placeholders by default. */
  readonly field_descriptions?: Readonly<Record<string, string>>;
  /** D-149 P12 § A.20.7 — pre-built Public Trust Footer string from
   *  `resolveReceptionTrustFooter` (`null` ⇒ per-server toggle off, no
   *  footer block). Already HTML-safe — `buildTrustFooter` escapes the
   *  interpolated display name — so the renderer emits it verbatim. */
  readonly trust_footer?: string | null;
}

// ────────────────────────────────────────────────────────────────
// Common shell
// ────────────────────────────────────────────────────────────────

const renderHead = (title: string): string => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' http: https: data:; style-src 'self'; script-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'">
<meta name="robots" content="noindex,nofollow">
<title>${htmlEscape(title)}</title>
<link rel="icon" href="${RECEPTION_PAGE_STATIC_PATH_PREFIX}favicon.ico">
<link rel="stylesheet" href="${RECEPTION_PAGE_STATIC_PATH_PREFIX}style.css">
</head>`;

/** D-149 P12 § A.20.7 — `trust_footer` comes from `buildTrustFooter`
 *  (contracts), which html-escapes the interpolated display name. It is
 *  already HTML-safe; interpolate VERBATIM and do NOT re-escape. `null`
 *  / absent ⇒ no trust block. */
const renderFooter = (trust_footer?: string | null): string => {
  const trustLine =
    typeof trust_footer === 'string' && trust_footer.length > 0
      ? `<p class="rcp-trust-footer">${trust_footer}</p>\n`
      : '';
  return `<div class="rcp-footer">${trustLine}Powered by Recued</div>`;
};

// ────────────────────────────────────────────────────────────────
// Field renderers (closed list mirroring IntakeFormVisitorFieldType)
// ────────────────────────────────────────────────────────────────

const requireMark = (required: boolean): string =>
  required ? ' <span class="rcp-required">*</span>' : '';

const renderTextField = (field: IntakeFormConfigField, description: string): string => {
  const requiredAttr = field.required ? ' required' : '';
  const ph = description.length > 0 ? ` placeholder="${htmlEscape(description)}"` : '';
  return `<div class="rcp-field">
<label for="rcp-${htmlEscape(field.name)}">${htmlEscape(field.label)}${requireMark(field.required)}</label>
<input id="rcp-${htmlEscape(field.name)}" name="${htmlEscape(field.name)}" type="text" maxlength="${INTAKE_FORM_VISITOR_TEXT_MAX}"${requiredAttr}${ph}>
</div>`;
};

const renderTextareaField = (field: IntakeFormConfigField, description: string): string => {
  const requiredAttr = field.required ? ' required' : '';
  const ph = description.length > 0 ? ` placeholder="${htmlEscape(description)}"` : '';
  return `<div class="rcp-field">
<label for="rcp-${htmlEscape(field.name)}">${htmlEscape(field.label)}${requireMark(field.required)}</label>
<textarea id="rcp-${htmlEscape(field.name)}" name="${htmlEscape(field.name)}" maxlength="${INTAKE_FORM_VISITOR_TEXTAREA_MAX}" rows="4"${requiredAttr}${ph}></textarea>
</div>`;
};

const renderNumberField = (field: IntakeFormConfigField, description: string): string => {
  const requiredAttr = field.required ? ' required' : '';
  const ph = description.length > 0 ? ` placeholder="${htmlEscape(description)}"` : '';
  return `<div class="rcp-field">
<label for="rcp-${htmlEscape(field.name)}">${htmlEscape(field.label)}${requireMark(field.required)}</label>
<input id="rcp-${htmlEscape(field.name)}" name="${htmlEscape(field.name)}" type="number" step="any"${requiredAttr}${ph}>
</div>`;
};

const renderBooleanField = (field: IntakeFormConfigField): string => {
  // No native HTML "required" for a checkbox that must be checked when
  // the spec says required; render the label with the mark so the
  // visitor sees the intent. Browser-side validation tagged required.
  const requiredAttr = field.required ? ' required' : '';
  return `<div class="rcp-field rcp-field-check">
<input id="rcp-${htmlEscape(field.name)}" name="${htmlEscape(field.name)}" type="checkbox" value="true"${requiredAttr}>
<label for="rcp-${htmlEscape(field.name)}">${htmlEscape(field.label)}${requireMark(field.required)}</label>
</div>`;
};

const renderDateField = (field: IntakeFormConfigField): string => {
  const requiredAttr = field.required ? ' required' : '';
  return `<div class="rcp-field">
<label for="rcp-${htmlEscape(field.name)}">${htmlEscape(field.label)}${requireMark(field.required)}</label>
<input id="rcp-${htmlEscape(field.name)}" name="${htmlEscape(field.name)}" type="date"${requiredAttr}>
</div>`;
};

/** D-210 WS3 — `datetime` is `date` plus a time-of-day. Rendered as the native
 *  `datetime-local` control: the visitor picks a wall-clock instant in their own
 *  reading of the form, and the calendar mapping's `timezone` says which zone
 *  that instant is interpreted in. Deliberately NOT `datetime` (no such input
 *  type) and NOT a UTC-offset control — asking a visitor to reason about zones
 *  is how a 7pm dinner booking becomes a 7pm-UTC one. */
const renderDateTimeField = (field: IntakeFormConfigField): string => {
  const requiredAttr = field.required ? ' required' : '';
  return `<div class="rcp-field">
<label for="rcp-${htmlEscape(field.name)}">${htmlEscape(field.label)}${requireMark(field.required)}</label>
<input id="rcp-${htmlEscape(field.name)}" name="${htmlEscape(field.name)}" type="datetime-local"${requiredAttr}>
</div>`;
};

const renderEnumField = (field: IntakeFormConfigField): string => {
  const requiredAttr = field.required ? ' required' : '';
  const placeholder = field.required
    ? '<option value="" disabled selected>Select…</option>'
    : '<option value="">—</option>';
  const opts = (field.values ?? [])
    .map((v) => `<option value="${htmlEscape(v)}">${htmlEscape(v)}</option>`)
    .join('');
  return `<div class="rcp-field">
<label for="rcp-${htmlEscape(field.name)}">${htmlEscape(field.label)}${requireMark(field.required)}</label>
<select id="rcp-${htmlEscape(field.name)}" name="${htmlEscape(field.name)}"${requiredAttr}>${placeholder}${opts}</select>
</div>`;
};

const renderArrayField = (field: IntakeFormConfigField): string => {
  // Render as a textarea with one-entry-per-line semantics. The
  // handler splits on newline + filters empties at parse time. Bound
  // the textarea size to the substrate cap so the input doesn't bloat
  // beyond the per-field allowance.
  const requiredAttr = field.required ? ' required' : '';
  return `<div class="rcp-field">
<label for="rcp-${htmlEscape(field.name)}">${htmlEscape(field.label)}${requireMark(field.required)}</label>
<textarea id="rcp-${htmlEscape(field.name)}" name="${htmlEscape(field.name)}" rows="3" placeholder="One per line"${requiredAttr}></textarea>
<p class="rcp-meta">One value per line.</p>
</div>`;
};

const renderFileField = (field: IntakeFormConfigField): string => {
  // P6 ships the substrate hook only — the file field is intentionally
  // rendered as a disabled placeholder. Users opt in to file via a
  // companion drop_link endpoint per spec § A.5.3 line 756.
  return `<div class="rcp-field rcp-field-disabled">
<label>${htmlEscape(field.label)}${requireMark(field.required)}</label>
<p class="rcp-meta">File uploads require a companion drop link. Contact the recipient for instructions.</p>
<input type="hidden" name="${htmlEscape(field.name)}" value="">
</div>`;
};

const renderField = (
  field: IntakeFormConfigField,
  description: string,
): string => {
  switch (field.type) {
    case 'text':
      return renderTextField(field, description);
    case 'textarea':
      return renderTextareaField(field, description);
    case 'number':
      return renderNumberField(field, description);
    case 'boolean':
      return renderBooleanField(field);
    case 'date':
      return renderDateField(field);
    case 'datetime':
      return renderDateTimeField(field);
    case 'enum':
      return renderEnumField(field);
    case 'array<text>':
      return renderArrayField(field);
    case 'file':
      return renderFileField(field);
  }
};

// ────────────────────────────────────────────────────────────────
// Visitor-email field
// ────────────────────────────────────────────────────────────────

const renderEmailField = (req: IntakeFormVisitorFieldRequirement): string => {
  if (req === 'omit') return '';
  const required = req === 'required';
  const requiredAttr = required ? ' required' : '';
  return `<div class="rcp-field">
<label for="rcp-visitor-email">Email${required ? ' <span class="rcp-required">*</span>' : ''}</label>
<input id="rcp-visitor-email" name="visitor_email" type="email" maxlength="${INTAKE_FORM_VISITOR_EMAIL_MAX}"${requiredAttr}>
</div>`;
};

// ────────────────────────────────────────────────────────────────
// Honeypot fields
// ────────────────────────────────────────────────────────────────

const renderHoneypotFields = (names: ReadonlyArray<string>): string => {
  // Off-screen positioning via the existing reception style sheet's
  // `.rcp-honeypot` class. Bots fill every input; humans don't see it.
  return names
    .map(
      (n) => `<div class="rcp-honeypot" aria-hidden="true">
<label for="rcp-hp-${htmlEscape(n)}">Leave blank</label>
<input id="rcp-hp-${htmlEscape(n)}" name="${htmlEscape(n)}" type="text" tabindex="-1" autocomplete="off">
</div>`,
    )
    .join('\n');
};

// ────────────────────────────────────────────────────────────────
// Main render
// ────────────────────────────────────────────────────────────────

/** Substrate-defined placeholder body — emitted when the endpoint is
 *  in a degraded / locked state. Indistinguishable from the configured
 *  shell per Must Hold I-1. */
export const renderIntakeFormPlaceholderHtml = (): string => {
  return `${renderHead('Intake form')}
<body>
<div class="rcp-shell">
<div class="rcp-card">
<p class="rcp-placeholder">This intake form is not currently accepting submissions.</p>
${renderFooter()}
</div>
</div>
</body>
</html>
`;
};

export const renderIntakeFormHtml = (input: IntakeFormRenderInput): string => {
  const instructionsBlock =
    input.instructions && input.instructions.length > 0
      ? `<p class="rcp-tagline">${htmlEscape(input.instructions)}</p>`
      : '';
  const visibleFields = input.fields
    .filter((f) => !input.honeypot_fields.includes(f.name))
    .map((f) =>
      renderField(f, input.field_descriptions?.[f.name] ?? ''),
    )
    .join('\n');
  const honeypotBlock = renderHoneypotFields(input.honeypot_fields);
  const emailBlock = renderEmailField(input.visitor_email_requirement);
  return `${renderHead(`Send ${input.display_name} a message`)}
<body>
<div class="rcp-shell">
<div class="rcp-card">
<div class="rcp-header">
<div>
<h1 class="rcp-name">Send ${htmlEscape(input.display_name)} a message</h1>
${instructionsBlock}
</div>
</div>
<form class="rcp-form" method="POST" action="/reception/intake/${htmlEscape(input.endpoint_id)}?t=${encodeURIComponent(input.bearer_secret)}">
<input type="hidden" name="form_nonce" value="${htmlEscape(input.form_nonce)}">
${honeypotBlock}
${emailBlock}
${visibleFields}
<button type="submit" class="rcp-button rcp-button-primary">${htmlEscape(input.submit_button_label)}</button>
</form>
${renderFooter(input.trust_footer ?? null)}
</div>
</div>
</body>
</html>
`;
};

// ────────────────────────────────────────────────────────────────
// Success page
// ────────────────────────────────────────────────────────────────

export const renderIntakeFormSuccessHtml = (input: {
  display_name: string;
  success_message: string;
  /** D-149 § A.20.3 — pre-built Visitor Receipt from
   *  `resolveVisitorReceipt` (`null` ⇒ per-endpoint receipts disabled,
   *  no receipt block). Rendered identically on spam / rejected_domain
   *  outcomes — the success page must stay byte-shaped the same across
   *  outcomes so the substrate does not fingerprint honeypot / domain
   *  detection. */
  receipt?: VisitorReceipt | null;
  /** D-207 slice 2 — the `render` response mode. Resolved `output.render`
   *  blocks from a paired recipe's run, rendered by the ONE shared block
   *  renderer through `RECEPTION_RENDER_CONTEXT` (public audience, no JS).
   *
   *  Placed ABOVE the receipt deliberately: when a recipe returns something the
   *  visitor must ACT on — "Proceed to payment → [Checkout]" — that action is
   *  the point of the page, and burying it under a receipt of what they just
   *  typed would be a page that technically contains the button and practically
   *  hides it.
   *
   *  ⚠ THE ANTI-FINGERPRINT INVARIANT ABOVE. These blocks exist only when the
   *  paired recipe RAN, and it runs only on a `pending` outcome — so a spam or
   *  rejected-domain submission produces a page WITHOUT them while a clean one
   *  produces a page WITH them. That is a signal a bot can binary-search the
   *  honeypot with, and it is the same signal D-200 already emits on this path
   *  (spam → 200 success page, clean → 303 to the provider; pinned green in
   *  `d-200-slice6g2`). Absent (or empty) blocks leave the page byte-identical
   *  to before, so an UNPAIRED form — the D-149 default — is unaffected. */
  render?: ReadonlyArray<ReceptionOutputBlock> | null;
}): string => {
  const renderedBlocks = renderReceptionOutputBlocks(input.render);
  const blocksSection = renderedBlocks.length > 0
    ? `<div class="rcp-section">
${renderedBlocks}
</div>`
    : '';
  return `${renderHead(`Submission received — ${input.display_name}`)}
<body>
<div class="rcp-shell">
<div class="rcp-card">
<div class="rcp-header">
<div>
<h1 class="rcp-name">Submission received</h1>
<p class="rcp-tagline">${htmlEscape(input.success_message)}</p>
</div>
</div>
${blocksSection}
${renderVisitorReceiptBlock(input.receipt)}
${renderFooter()}
</div>
</div>
</body>
</html>
`;
};

// ────────────────────────────────────────────────────────────────
// Error page (validator failure / rate-limit / etc.)
// ────────────────────────────────────────────────────────────────

export const renderIntakeFormErrorHtml = (input: {
  display_name: string;
  message: string;
}): string => {
  return `${renderHead(`Couldn’t submit — ${input.display_name}`)}
<body>
<div class="rcp-shell">
<div class="rcp-card">
<div class="rcp-header">
<div>
<h1 class="rcp-name">Couldn’t submit form</h1>
<p class="rcp-tagline">${htmlEscape(input.message)}</p>
</div>
</div>
${renderFooter()}
</div>
</div>
</body>
</html>
`;
};
