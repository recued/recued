/** D-149 P8 § A.5.5 — `approval_link` HTML renderer.
 *
 *  Server-rendered consent form — no SPA, no inline JS, no `script-src`
 *  CSP allowance. The visitor fills out a `<form>` with closed-list
 *  inputs that vary by `action_kind`:
 *
 *    - pick_time          → radio buttons (one per option) + optional
 *                           visitor name + email
 *    - confirm_attendance → yes/no radio buttons
 *    - approve_wording    → "approve" / "reject (with comment)" radios
 *                           + collapsing comment textarea
 *    - answer_question    → textarea (free-form text)
 *    - upload_doc         → answer-style affordance with copy directing
 *                           the visitor to the companion drop_link
 *
 *  Visitor-facing privacy contract (§ A.5.5 lines 911-913):
 *
 *    The renderer's INPUT is the redacted-packet payload built by
 *    `buildReceptionPacket('approval_link_packet', ...)`. The packet
 *    drops `counterparty_aliases` + `private_notes` at the substrate
 *    transformation boundary; the renderer receives only the
 *    redacted shape by construction.
 *
 *  The renderer's only job is to HTML-escape interpolations + emit
 *  the page shell. No additional fields beyond the packet payload +
 *  the closed-list visitor inputs ever reach the HTML.
 *
 *  Spec: D-149 § A.5.5 + § A.11 TR-10. */

import {
  APPROVAL_LINK_VISITOR_ANSWER_MAX,
  APPROVAL_LINK_VISITOR_COMMENT_MAX,
  APPROVAL_LINK_VISITOR_EMAIL_MAX,
  APPROVAL_LINK_VISITOR_NAME_MAX,
  RECEPTION_PAGE_STATIC_PATH_PREFIX,
  type ApprovalLinkActionKind,
  type ApprovalLinkOption,
  type ApprovalLinkVisitorFieldConstraints,
  type VisitorReceipt,
} from '@recued/contracts';
import { htmlEscape } from './reception-page-render.js';
import { renderVisitorReceiptBlock } from './visitor-receipt.js';
import { RECEPTION_PAGE_STYLE_SRC } from '../static-assets.js';

// ────────────────────────────────────────────────────────────────
// Inputs
// ────────────────────────────────────────────────────────────────

export type ApprovalLinkFormValues = Partial<Record<'visitor_name' | 'visitor_email' | 'comment' | 'answer' | 'decision' | 'option_id', string>>;

export interface ApprovalLinkRenderInput {
  readonly submitted?: ApprovalLinkFormValues;
  readonly error_message?: string;
  /** Visitor-facing display name (typically Mary's first name or
   *  handle). */
  readonly display_name: string;
  /** The closed-list action_kind — drives the per-kind form body. */
  readonly completion?: boolean;
  readonly quote?: boolean;
  readonly action_kind: ApprovalLinkActionKind;
  /** Visitor-facing prompt (htmlEscape'd at emit time). */
  readonly prompt: string;
  /** Substrate-redacted context summary (counterparty_aliases +
   *  private_notes already stripped at the packet boundary). */
  readonly context_summary: string;
  /** Option list for `pick_time` / `confirm_attendance` (closed-list
   *  per § A.5.5 line 859). Absent for the other action kinds. */
  readonly options?: ReadonlyArray<ApprovalLinkOption>;
  /** Visitor self-identification requirements. */
  readonly visitor_field_constraints: ApprovalLinkVisitorFieldConstraints;
  /** Coarse-grained "expires in X days" hint. */
  readonly expiry_display: string;
  /** Submit-button label (per config; defaults to "Submit"). */
  readonly submit_button_label: string;
  /** Endpoint id (URL: `/reception/approve/<endpoint_id>` POST). */
  readonly endpoint_id: string;
  /** Per-request bearer secret — surfaces as a hidden form field so
   *  the POST request carries the token. */
  readonly bearer_secret: string;
  /** Per-request form nonce — bound to the rendered page; POST
   *  validator requires it back verbatim (single-use). */
  readonly form_nonce: string;
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
<link rel="stylesheet" href="${RECEPTION_PAGE_STYLE_SRC}">
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
// Per-action-kind form bodies
// ────────────────────────────────────────────────────────────────

const renderPickTimeBody = (options: ReadonlyArray<ApprovalLinkOption>, values: ApprovalLinkFormValues): string => {
  const opts = options
    .map((o) => {
      const description = o.description !== undefined && o.description.length > 0
        ? `<span class="rcp-option-desc">${htmlEscape(o.description)}</span>`
        : '';
      return `<label class="rcp-option">
<input type="radio" name="option_id" value="${htmlEscape(o.id)}"${values.option_id === o.id ? ' checked' : ''} required>
<span class="rcp-option-label">${htmlEscape(o.label)}</span>${description}
</label>`;
    })
    .join('\n');
  return `<fieldset class="rcp-fieldset">
<legend class="rcp-legend">Choose one</legend>
${opts}
</fieldset>`;
};

const renderConfirmAttendanceBody = (values: ApprovalLinkFormValues): string =>
  `<fieldset class="rcp-fieldset">
<legend class="rcp-legend">Will you attend?</legend>
<label class="rcp-option">
<input type="radio" name="answer" value="yes"${values.answer === 'yes' ? ' checked' : ''} required>
<span class="rcp-option-label">Yes</span>
</label>
<label class="rcp-option">
<input type="radio" name="answer" value="no"${values.answer === 'no' ? ' checked' : ''} required>
<span class="rcp-option-label">No</span>
</label>
</fieldset>`;

const renderApproveWordingBody = (completion: boolean,quote: boolean, values: ApprovalLinkFormValues): string =>
  completion ? `<div class="rcp-field">
<label for="rcp-comment">Corrections (required when requesting changes)</label>
<textarea id="rcp-comment" name="comment" rows="4" maxlength="${APPROVAL_LINK_VISITOR_COMMENT_MAX}" required>${htmlEscape(values.comment ?? '')}</textarea>
</div>
<button type="submit" name="decision" value="approve" formnovalidate class="rcp-button rcp-button-primary">Accept completion</button>
<button type="submit" name="decision" value="reject" class="rcp-button">Request corrections</button>`
  : `<fieldset class="rcp-fieldset">
<legend class="rcp-legend">Your decision</legend>
<label class="rcp-option">
<input type="radio" name="decision" value="approve"${values.decision === 'approve' ? ' checked' : ''} required>
<span class="rcp-option-label">${quote ? 'Accept this quote' : 'Approve'}</span>
</label>
<label class="rcp-option">
<input type="radio" name="decision" value="reject"${values.decision === 'reject' ? ' checked' : ''} required>
<span class="rcp-option-label">${quote ? 'Decline this quote' : 'Suggest changes'}</span>
</label>
</fieldset>
<div class="rcp-field">
<label for="rcp-comment">${quote ? 'Reason or proposed changes (optional)' : 'Comments (optional)'}</label>
<textarea id="rcp-comment" name="comment" rows="4" maxlength="${APPROVAL_LINK_VISITOR_COMMENT_MAX}">${htmlEscape(values.comment ?? '')}</textarea>
</div>`;

const renderAnswerQuestionBody = (values: ApprovalLinkFormValues): string =>
  `<div class="rcp-field">
<label for="rcp-answer">Your answer</label>
<textarea id="rcp-answer" name="answer" rows="6" maxlength="${APPROVAL_LINK_VISITOR_ANSWER_MAX}" required>${htmlEscape(values.answer ?? '')}</textarea>
</div>`;

const renderUploadDocBody = (values: ApprovalLinkFormValues): string =>
  `<div class="rcp-field">
<label for="rcp-answer">Acknowledgement</label>
<p class="rcp-meta">This action requires a file upload via the companion drop link. Type a confirmation note here once you've sent the file; the recipient will receive both records together.</p>
<textarea id="rcp-answer" name="answer" rows="4" maxlength="${APPROVAL_LINK_VISITOR_ANSWER_MAX}" required>${htmlEscape(values.answer ?? '')}</textarea>
</div>`;

const renderActionBody = (
  action_kind: ApprovalLinkActionKind,
  options: ReadonlyArray<ApprovalLinkOption> | undefined,
  completion = false,quote = false, values: ApprovalLinkFormValues = {},
): string => {
  switch (action_kind) {
    case 'pick_time':
      return renderPickTimeBody(options ?? [],values);
    case 'confirm_attendance':
      return renderConfirmAttendanceBody(values);
    case 'approve_wording':
      return renderApproveWordingBody(completion,quote,values);
    case 'answer_question':
      return renderAnswerQuestionBody(values);
    case 'upload_doc':
      return renderUploadDocBody(values);
  }
};

// ────────────────────────────────────────────────────────────────
// Visitor self-identification fields
// ────────────────────────────────────────────────────────────────

const renderVisitorIdentityFields = (
  constraints: ApprovalLinkVisitorFieldConstraints, values: ApprovalLinkFormValues,
): string => {
  const requiredAttr = (req: 'required' | 'optional'): string =>
    req === 'required' ? ' required' : '';
  const mark = (req: 'required' | 'optional'): string =>
    req === 'required' ? ' <span class="rcp-required">*</span>' : ' (optional)';
  const emailValue = constraints.require_email_match
    ? ` value="${htmlEscape(constraints.require_email_match)}" readonly`
    : ` value="${htmlEscape(values.visitor_email ?? '')}"`;
  return `<div class="rcp-field">
<label for="rcp-visitor-name">Your name${mark(constraints.name)}</label>
<input id="rcp-visitor-name" name="visitor_name" type="text" maxlength="${APPROVAL_LINK_VISITOR_NAME_MAX}" value="${htmlEscape(values.visitor_name ?? '')}"${requiredAttr(constraints.name)}>
</div>
<div class="rcp-field">
<label for="rcp-visitor-email">Your email${mark(constraints.email)}</label>
<input id="rcp-visitor-email" name="visitor_email" type="email" maxlength="${APPROVAL_LINK_VISITOR_EMAIL_MAX}"${requiredAttr(constraints.email)}${emailValue}>
</div>`;
};

// ────────────────────────────────────────────────────────────────
// Main render
// ────────────────────────────────────────────────────────────────

/** Substrate-defined placeholder body — emitted when the endpoint is
 *  in a degraded / locked state. Indistinguishable from the configured
 *  shell per Must Hold I-1. */
export const renderApprovalLinkPlaceholderHtml = (): string => {
  return `${renderHead('Approval')}
<body>
<div class="rcp-shell">
<div class="rcp-card">
<p class="rcp-placeholder">This approval link is not currently accepting responses.</p>
${renderFooter()}
</div>
</div>
</body>
</html>
`;
};

/** The dispatcher has no customer-visible terms to disclose for an inactive
 * link. Keep expiry and revocation indistinguishable and offer a next step. */
export const renderApprovalLinkUnavailableHtml = (): string => `${renderHead('Link unavailable')}
<body>
<div class="rcp-shell">
<div class="rcp-card">
<h1 class="rcp-name">This link is unavailable</h1>
<p class="rcp-tagline">Ask the business that sent it for a new link.</p>
${renderFooter()}
</div>
</div>
</body>
</html>
`;

/** Substrate-defined consumed-already body — emitted on the second
 *  presentation of a single-use approval token. Distinct from the
 *  neutral unavailable page the dispatcher emits at the cache layer
 *  because the visitor reached the handler via a valid bearer + an
 *  intent that has since been consumed. */
export const renderApprovalLinkAlreadyConsumedHtml = (input: {
  display_name: string;
}): string => {
  return `${renderHead(`Already responded — ${input.display_name}`)}
<body>
<div class="rcp-shell">
<div class="rcp-card">
<div class="rcp-header">
<div>
<h1 class="rcp-name">Already responded</h1>
<p class="rcp-tagline">This approval link has already been used. If you need to update your response, please contact the sender.</p>
</div>
</div>
${renderFooter()}
</div>
</div>
</body>
</html>
`;
};

export const renderApprovalLinkHtml = (input: ApprovalLinkRenderInput): string => {
  // A disabled first submit button blocks implicit Enter from contact fields.
  // Completion requires an explicit action; its Accept button must not default.
  const body = renderActionBody(input.action_kind, input.options, input.completion,input.quote,input.submitted);
  const identityFields = renderVisitorIdentityFields(input.visitor_field_constraints,input.submitted ?? {});
  return `${renderHead(`${input.error_message ? 'Check your response' : 'Response requested'} — ${input.display_name}`)}
<body>
<div class="rcp-shell">
<div class="rcp-card">
<div class="rcp-header">
<div>
<h1 class="rcp-name">Response requested — ${htmlEscape(input.display_name)}</h1>
<p class="rcp-tagline">${htmlEscape(input.prompt)}</p>
${input.error_message ? `<section class="rcp-error-summary" role="alert" id="rcp-error" tabindex="-1" autofocus>
<h2>Check your response</h2>
<p>${htmlEscape(input.error_message)}</p>
<a href="#rcp-response-form">Fix your response</a>
</section>` : ''}
${input.context_summary.length > 0 ? `<p class="rcp-context">${htmlEscape(input.context_summary)}</p>` : ''}
<p class="rcp-meta">${htmlEscape(input.expiry_display)}</p>
</div>
</div>
<form id="rcp-response-form" tabindex="-1" class="rcp-form"${input.error_message ? ' aria-describedby="rcp-error"' : ''} method="POST" action="/reception/approve/${htmlEscape(input.endpoint_id)}?t=${encodeURIComponent(input.bearer_secret)}">
<input type="hidden" name="form_nonce" value="${htmlEscape(input.form_nonce)}">
${input.completion ? '<button type="submit" hidden disabled aria-hidden="true" tabindex="-1"></button>' : ''}
${identityFields}
${body}
${input.completion ? '' : `<button type="submit" class="rcp-button rcp-button-primary">${htmlEscape(input.submit_button_label)}</button>`}
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

export const renderApprovalLinkSuccessHtml = (input: {
  display_name: string;
  success_message: string;
  response_summary?: {reference: string;decision: string};
  /** D-149 § A.20.3 — pre-built Visitor Receipt from
   *  `resolveVisitorReceipt` (`null` ⇒ per-endpoint receipts disabled,
   *  no receipt block). */
  receipt?: VisitorReceipt | null;
}): string => {
  return `${renderHead(`Response received — ${input.display_name}`)}
<body>
<div class="rcp-shell">
<div class="rcp-card">
<div class="rcp-header">
<div>
<h1 class="rcp-name">Response received</h1>
${input.response_summary ? `<p class="rcp-context">${htmlEscape(input.response_summary.reference)}<br><strong>${htmlEscape(input.response_summary.decision)}</strong></p>` : ''}
<p class="rcp-tagline">${htmlEscape(input.success_message)}</p>
</div>
</div>
${renderVisitorReceiptBlock(input.receipt)}
${renderFooter()}
</div>
</div>
</body>
</html>
`;
};

// ────────────────────────────────────────────────────────────────
// Error page
// ────────────────────────────────────────────────────────────────

export const renderApprovalLinkErrorHtml = (input: {
  display_name: string;
  message: string;
  recovery_url?: string;
}): string => {
  return `${renderHead(`Couldn’t submit — ${input.display_name}`)}
<body>
<div class="rcp-shell">
<div class="rcp-card">
<div class="rcp-header">
<div>
<h1 class="rcp-name">Couldn’t submit response</h1>
<p class="rcp-tagline">${htmlEscape(input.message)}</p>
${input.recovery_url ? `<a class="rcp-button" href="${htmlEscape(input.recovery_url)}" rel="noreferrer">Review request again</a>` : ''}
</div>
</div>
${renderFooter()}
</div>
</div>
</body>
</html>
`;
};
