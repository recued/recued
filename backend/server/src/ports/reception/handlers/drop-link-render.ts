/** D-149 P7 § A.5.4 — drop_link HTML renderer.
 *
 *  Renders the upload form (multipart/form-data) + success / error /
 *  placeholder pages mirroring the intake-form renderer's shell so the
 *  visitor experience stays consistent across reception kinds. Public-
 *  mode: no scripts, no remote assets, no fingerprinting.
 *
 *  Per Must Hold I-1: a degraded endpoint renders an identical shell
 *  with a placeholder copy — the visitor can't distinguish "rate-
 *  limited" from "config missing" from "vault locked" from the rendered
 *  HTML alone.
 *
 *  Spec: D-149 § A.5.4. */

import {
  DROP_LINK_VISITOR_DESCRIPTION_MAX,
  DROP_LINK_VISITOR_EMAIL_MAX,
  DROP_LINK_VISITOR_NAME_MAX,
  RECEPTION_PAGE_STATIC_PATH_PREFIX,
  type DropLinkAllowedMimeType,
  type DropLinkVisitorFieldRequirement,
  type VisitorReceipt,
} from '@recued/contracts';
import { htmlEscape } from './reception-page-render.js';
import { renderVisitorReceiptBlock } from './visitor-receipt.js';

// ────────────────────────────────────────────────────────────────
// Inputs
// ────────────────────────────────────────────────────────────────

export interface DropLinkRenderInput {
  readonly display_name: string;
  readonly instructions?: string;
  /** Visitor-side field requirements per § A.5.4 line 783-787. */
  readonly visitor_name_requirement: DropLinkVisitorFieldRequirement;
  readonly visitor_email_requirement: DropLinkVisitorFieldRequirement;
  readonly visitor_description_requirement: DropLinkVisitorFieldRequirement;
  readonly submit_button_label: string;
  readonly size_cap_bytes: number;
  readonly allowed_mime_types: ReadonlyArray<DropLinkAllowedMimeType>;
  readonly endpoint_id: string;
  readonly bearer_secret: string;
  readonly form_nonce: string;
  /** D-149 P12 § A.20.7 — pre-built Public Trust Footer string from
   *  `resolveReceptionTrustFooter` (`null` ⇒ per-server toggle off, no
   *  footer block). Already HTML-safe — `buildTrustFooter` escapes the
   *  interpolated display name — so the renderer emits it verbatim. */
  readonly trust_footer?: string | null;
  /** D-172 step 5b/5c — the SRI-pinned resumable uploader `<script>`. When
   *  present the renderer emits ONE `<script nonce integrity src>` (progressive
   *  enhancement over the JS-free `<form>`); the same `nonce` MUST be set in the
   *  response `Content-Security-Policy` header's `script-src`. Absent ⇒ no
   *  script (the form stays single-POST-only). */
  readonly uploader_script?: {
    readonly nonce: string;
    readonly src: string;
    readonly integrity: string;
  };
}

// ────────────────────────────────────────────────────────────────
// Common shell
// ────────────────────────────────────────────────────────────────

// D-172 step 5c — the Content-Security-Policy is delivered via the HTTP RESPONSE
// HEADER (per-render nonce'd; set in drop-link.ts `writeHtmlResponse`), NOT a
// `<meta>` tag: CSP nonces are robust in the header but spotty in meta. The
// header carries `script-src 'nonce-<per-render>'` for the one uploader
// `<script>` ('none' on the JS-free pages) + the rest of the strict policy.
const renderHead = (title: string): string => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
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

const requireMark = (required: boolean): string =>
  required ? ' <span class="rcp-required">*</span>' : '';

// ────────────────────────────────────────────────────────────────
// Visitor-PII fields
// ────────────────────────────────────────────────────────────────

const renderVisitorNameField = (req: DropLinkVisitorFieldRequirement): string => {
  if (req === 'omit') return '';
  const required = req === 'required';
  const requiredAttr = required ? ' required' : '';
  return `<div class="rcp-field">
<label for="rcp-visitor-name">Name${requireMark(required)}</label>
<input id="rcp-visitor-name" name="visitor_name" type="text" maxlength="${DROP_LINK_VISITOR_NAME_MAX}"${requiredAttr}>
</div>`;
};

const renderVisitorEmailField = (req: DropLinkVisitorFieldRequirement): string => {
  if (req === 'omit') return '';
  const required = req === 'required';
  const requiredAttr = required ? ' required' : '';
  return `<div class="rcp-field">
<label for="rcp-visitor-email">Email${requireMark(required)}</label>
<input id="rcp-visitor-email" name="visitor_email" type="email" maxlength="${DROP_LINK_VISITOR_EMAIL_MAX}"${requiredAttr}>
</div>`;
};

const renderVisitorDescriptionField = (
  req: DropLinkVisitorFieldRequirement,
): string => {
  if (req === 'omit') return '';
  const required = req === 'required';
  const requiredAttr = required ? ' required' : '';
  return `<div class="rcp-field">
<label for="rcp-visitor-description">Description${requireMark(required)}</label>
<textarea id="rcp-visitor-description" name="visitor_description" maxlength="${DROP_LINK_VISITOR_DESCRIPTION_MAX}" rows="3"${requiredAttr}></textarea>
</div>`;
};

// ────────────────────────────────────────────────────────────────
// File-input field
// ────────────────────────────────────────────────────────────────

const formatBytes = (n: number): string => {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
};

const renderFileField = (
  size_cap_bytes: number,
  allowed_mime_types: ReadonlyArray<DropLinkAllowedMimeType>,
): string => {
  const accept = allowed_mime_types.map((m) => htmlEscape(m)).join(',');
  return `<div class="rcp-field">
<label for="rcp-blob">File <span class="rcp-required">*</span></label>
<input id="rcp-blob" name="blob" type="file" accept="${accept}" required>
<p class="rcp-meta">Up to ${htmlEscape(formatBytes(size_cap_bytes))}. Accepted types: ${htmlEscape(allowed_mime_types.join(', '))}.</p>
</div>`;
};

// ────────────────────────────────────────────────────────────────
// Main render
// ────────────────────────────────────────────────────────────────

/** Substrate-defined placeholder body — emitted when the endpoint is
 *  in a degraded / locked state. Indistinguishable from the configured
 *  shell per Must Hold I-1. */
export const renderDropLinkPlaceholderHtml = (): string => {
  return `${renderHead('Drop link')}
<body>
<div class="rcp-shell">
<div class="rcp-card">
<p class="rcp-placeholder">This drop link is not currently accepting uploads.</p>
${renderFooter()}
</div>
</div>
</body>
</html>
`;
};

export const renderDropLinkHtml = (input: DropLinkRenderInput): string => {
  const instructionsBlock =
    input.instructions && input.instructions.length > 0
      ? `<p class="rcp-tagline">${htmlEscape(input.instructions)}</p>`
      : '';
  // D-172 step 5b/5c — the ONE resumable-uploader script: same-origin (NO
  // `crossorigin`, so SRI stays a same-origin no-cors check, not a CORS fetch),
  // nonce-gated by the response CSP, SRI-pinned. Progressive enhancement: the
  // JS-free `<form>` above stays the upload path when this is absent / blocked.
  const us = input.uploader_script;
  const uploaderScriptBlock = us
    ? `<script nonce="${htmlEscape(us.nonce)}" integrity="${htmlEscape(us.integrity)}" src="${htmlEscape(us.src)}"></script>`
    : '';
  return `${renderHead(`Send a file to ${input.display_name}`)}
<body>
<div class="rcp-shell">
<div class="rcp-card">
<div class="rcp-header">
<div>
<h1 class="rcp-name">Send a file to ${htmlEscape(input.display_name)}</h1>
${instructionsBlock}
</div>
</div>
<form class="rcp-form" method="POST" enctype="multipart/form-data" action="/reception/drop/${htmlEscape(input.endpoint_id)}?t=${encodeURIComponent(input.bearer_secret)}">
<input type="hidden" name="form_nonce" value="${htmlEscape(input.form_nonce)}">
${renderVisitorNameField(input.visitor_name_requirement)}
${renderVisitorEmailField(input.visitor_email_requirement)}
${renderVisitorDescriptionField(input.visitor_description_requirement)}
${renderFileField(input.size_cap_bytes, input.allowed_mime_types)}
<button type="submit" class="rcp-button rcp-button-primary">${htmlEscape(input.submit_button_label)}</button>
</form>
${renderFooter(input.trust_footer ?? null)}
</div>
</div>
${uploaderScriptBlock}
</body>
</html>
`;
};

// ────────────────────────────────────────────────────────────────
// Success page
// ────────────────────────────────────────────────────────────────

export const renderDropLinkSuccessHtml = (input: {
  display_name: string;
  success_message: string;
  /** D-149 § A.20.3 — pre-built Visitor Receipt from
   *  `resolveVisitorReceipt` (`null` ⇒ per-endpoint receipts disabled,
   *  no receipt block). */
  receipt?: VisitorReceipt | null;
}): string => {
  return `${renderHead(`Upload received — ${input.display_name}`)}
<body>
<div class="rcp-shell">
<div class="rcp-card">
<div class="rcp-header">
<div>
<h1 class="rcp-name">Upload received</h1>
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

export const renderDropLinkErrorHtml = (input: {
  display_name: string;
  message: string;
}): string => {
  return `${renderHead(`Couldn’t upload — ${input.display_name}`)}
<body>
<div class="rcp-shell">
<div class="rcp-card">
<div class="rcp-header">
<div>
<h1 class="rcp-name">Couldn’t upload</h1>
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
