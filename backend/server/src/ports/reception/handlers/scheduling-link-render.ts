/** D-149 P5 § A.5.2 — `scheduling_link` HTML renderer.
 *
 *  Server-rendered slot picker — no SPA, no inline JS, no `script-src`
 *  allowance in the CSP. The visitor picks a slot via standard form
 *  controls (`<select>` for duration, `<select>` for slot start) and
 *  submits a POST `/book` form. Per the spec § A.5.2 line 800 "vanilla
 *  JS rendered server-side; no SPA" — the slot picker is a `<form>`
 *  with `<select>` elements; submission round-trips to the same server
 *  + the success page is server-rendered.
 *
 *  Visitor-facing privacy contract (§ A.5.2 lines 628-644):
 *
 *    The renderer's INPUT is the redacted packet payload built by
 *    `buildReceptionPacket('scheduling_link_packet', ...)`. The payload
 *    is strict-picked to `PACKET_FIELDS_VISIBLE.scheduling_link_packet`:
 *    `free_windows`, `tz`, `duration_options`, `required_visitor_fields`,
 *    `min_advance_notice_hours`, `max_lead_time_days`. Calendar event
 *    titles / attendees / agendas / tentative-vs-confirmed status / the
 *    calendar provider are absent by construction — the redacted packet
 *    transform never carries them past the boundary.
 *
 *  The renderer's only job is to HTML-escape interpolations + emit the
 *  page shell. No additional fields beyond the closed-list inputs ever
 *  reach the HTML.
 *
 *  Spec: docs/d-149-spec.md § A.5.2 + § A.11 TR-8 (custom-link XSS). */

import {
  RECEPTION_PAGE_STATIC_PATH_PREFIX,
  type FreeWindow,
  type SchedulingLinkVisitorFieldRequirements,
  type VisitorReceipt,
} from '@recued/contracts';
import { htmlEscape } from './reception-page-render.js';
import { renderVisitorReceiptBlock } from './visitor-receipt.js';

// ────────────────────────────────────────────────────────────────
// Inputs
// ────────────────────────────────────────────────────────────────

/** Substrate-validated slot. Generated server-side via `enumerateSlots`
 *  + already constrained by computeFreeWindows + advance-notice + lead-
 *  time gates. The renderer just emits the value attribute. */
export interface SchedulingSlot {
  readonly start_at: number;
  readonly end_at: number;
  readonly duration_minutes: number;
  /** Pre-formatted display string (visitor's tz, server-rendered). */
  readonly display_label: string;
}

export interface SchedulingLinkRenderInput {
  /** Visitor-facing display name (the user's first name or handle).
   *  Length-bounded at config-validate time. */
  readonly display_name: string;
  /** Optional instructions paragraph (htmlEscape'd). */
  readonly instructions?: string;
  /** Configured tz label (e.g. `'America/New_York'`). */
  readonly tz_label: string;
  /** Free windows in `[window_start, window_end)`. NEVER carries
   *  underlying event titles / attendees / notes. */
  readonly free_windows: ReadonlyArray<FreeWindow>;
  /** Slot duration options (e.g. `[15, 30, 60]` — closed-list). */
  readonly duration_options: ReadonlyArray<number>;
  /** Pre-enumerated slots — convenience precomputed at handler time
   *  so the renderer is purely string-substitution. The slot picker
   *  defaults to `duration_options[0]`; visitor can change via the
   *  `<select>` element + the GET `?duration=` query roundtrips. */
  readonly slots: ReadonlyArray<SchedulingSlot>;
  /** Per-field visitor requirement map. */
  readonly required_visitor_fields: SchedulingLinkVisitorFieldRequirements;
  readonly min_advance_notice_hours: number;
  readonly max_lead_time_days: number;
  /** Endpoint id (URL: `/reception/scheduling/<endpoint_id>/book` POST). */
  readonly endpoint_id: string;
  /** Per-request bearer secret — surfaces as a hidden form field so the
   *  POST /book request carries the token (renderer pulls this from the
   *  request URL query string). */
  readonly bearer_secret: string;
  /** Per-request form nonce (32 bytes, hex-encoded). Bound to the
   *  rendered page; POST /book validator requires it back verbatim. */
  readonly form_nonce: string;
  /** Currently-selected duration (driven by `?duration=` query string).
   *  Used to pre-select the `<select>` option in the rendered HTML. */
  readonly active_duration_minutes: number;
  /** D-149 P12 § A.20.7 — pre-built Public Trust Footer string from
   *  `resolveReceptionTrustFooter` (`null` ⇒ per-server toggle off, no
   *  footer block). Already HTML-safe — `buildTrustFooter` escapes the
   *  interpolated display name — so the renderer emits it verbatim. */
  readonly trust_footer?: string | null;
}

// ────────────────────────────────────────────────────────────────
// Common shell
// ────────────────────────────────────────────────────────────────

export const renderHead = (title: string): string => `<!DOCTYPE html>
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
export const renderFooter = (tz_label: string, trust_footer?: string | null): string => {
  const trustLine =
    typeof trust_footer === 'string' && trust_footer.length > 0
      ? `<p class="rcp-trust-footer">${trust_footer}</p>\n`
      : '';
  return `<div class="rcp-footer">${trustLine}Powered by Recued · ${htmlEscape(tz_label)}</div>`;
};

// ────────────────────────────────────────────────────────────────
// Field-requirement helpers
// ────────────────────────────────────────────────────────────────

const fieldVisible = (req: 'required' | 'optional' | 'omit'): boolean => req !== 'omit';
const fieldRequired = (req: 'required' | 'optional' | 'omit'): boolean => req === 'required';

const renderField = (input: {
  name: string;
  label: string;
  type: 'text' | 'email' | 'tel' | 'textarea';
  required: boolean;
  maxlength: number;
}): string => {
  const reqAttr = input.required ? ' required' : '';
  const labelMark = input.required ? ' <span class="rcp-required">*</span>' : '';
  if (input.type === 'textarea') {
    return `<div class="rcp-field">
<label for="rcp-${input.name}">${htmlEscape(input.label)}${labelMark}</label>
<textarea id="rcp-${input.name}" name="${htmlEscape(input.name)}" maxlength="${input.maxlength}" rows="3"${reqAttr}></textarea>
</div>`;
  }
  return `<div class="rcp-field">
<label for="rcp-${input.name}">${htmlEscape(input.label)}${labelMark}</label>
<input id="rcp-${input.name}" name="${htmlEscape(input.name)}" type="${input.type}" maxlength="${input.maxlength}"${reqAttr}>
</div>`;
};

// ────────────────────────────────────────────────────────────────
// Slot picker render
// ────────────────────────────────────────────────────────────────

const renderDurationSelect = (input: {
  options: ReadonlyArray<number>;
  active: number;
  endpoint_id: string;
  bearer_secret: string;
}): string => {
  const opts = input.options
    .map(
      (d) =>
        `<option value="${d}"${d === input.active ? ' selected' : ''}>${d}-minute</option>`,
    )
    .join('');
  // Visitor changes duration → GET request with the new ?duration param.
  // Because the form has form-action 'self', the GET form roundtrips
  // through the same handler + the slot table re-renders.
  return `<form class="rcp-duration-form" method="GET" action="/reception/scheduling/${htmlEscape(input.endpoint_id)}">
<input type="hidden" name="t" value="${htmlEscape(input.bearer_secret)}">
<label for="rcp-duration">Slot length</label>
<select id="rcp-duration" name="duration" onchange="">${opts}</select>
<button type="submit" class="rcp-button">Update</button>
</form>`;
};

export const renderSlotPicker = (input: {
  slots: ReadonlyArray<SchedulingSlot>;
}): string => {
  if (input.slots.length === 0) {
    return `<p class="rcp-empty">No available slots in the next look-ahead window.</p>`;
  }
  const options = input.slots
    .map(
      (s) =>
        `<option value="${s.start_at}|${s.end_at}|${s.duration_minutes}">${htmlEscape(s.display_label)}</option>`,
    )
    .join('');
  return `<div class="rcp-field">
<label for="rcp-slot">Choose a time</label>
<select id="rcp-slot" name="slot" required>${options}</select>
</div>`;
};

// ────────────────────────────────────────────────────────────────
// Visitor-field block
// ────────────────────────────────────────────────────────────────

const renderVisitorFields = (req: SchedulingLinkVisitorFieldRequirements): string => {
  const parts: string[] = [];
  if (fieldVisible(req.name)) {
    parts.push(
      renderField({
        name: 'visitor_name',
        label: 'Your name',
        type: 'text',
        required: fieldRequired(req.name),
        maxlength: 200,
      }),
    );
  }
  if (fieldVisible(req.email)) {
    parts.push(
      renderField({
        name: 'visitor_email',
        label: 'Email',
        type: 'email',
        required: fieldRequired(req.email),
        maxlength: 254,
      }),
    );
  }
  if (fieldVisible(req.topic)) {
    parts.push(
      renderField({
        name: 'visitor_topic',
        label: 'Topic',
        type: 'text',
        required: fieldRequired(req.topic),
        maxlength: 200,
      }),
    );
  }
  if (fieldVisible(req.phone)) {
    parts.push(
      renderField({
        name: 'visitor_phone',
        label: 'Phone',
        type: 'tel',
        required: fieldRequired(req.phone),
        maxlength: 64,
      }),
    );
  }
  if (fieldVisible(req.notes)) {
    parts.push(
      renderField({
        name: 'visitor_notes',
        label: 'Notes',
        type: 'textarea',
        required: fieldRequired(req.notes),
        maxlength: 2000,
      }),
    );
  }
  return parts.join('\n');
};

// ────────────────────────────────────────────────────────────────
// Main render
// ────────────────────────────────────────────────────────────────

/** Substrate-defined placeholder body — emitted when the endpoint is
 *  in a degraded / locked state. Indistinguishable from the configured
 *  shell per Must Hold I-1. */
export const renderSchedulingLinkPlaceholderHtml = (tz_label: string): string => {
  return `${renderHead('Schedule')}
<body>
<div class="rcp-shell">
<div class="rcp-card">
<p class="rcp-placeholder">This scheduling link is not currently accepting bookings.</p>
${renderFooter(tz_label)}
</div>
</div>
</body>
</html>
`;
};

export const renderSchedulingLinkHtml = (input: SchedulingLinkRenderInput): string => {
  const instructionsBlock =
    input.instructions && input.instructions.length > 0
      ? `<p class="rcp-tagline">${htmlEscape(input.instructions)}</p>`
      : '';
  const advanceNoticeBlock = `<p class="rcp-meta">Bookings require at least ${input.min_advance_notice_hours}h notice; book up to ${input.max_lead_time_days}d ahead.</p>`;
  const durationBlock = renderDurationSelect({
    options: input.duration_options,
    active: input.active_duration_minutes,
    endpoint_id: input.endpoint_id,
    bearer_secret: input.bearer_secret,
  });
  const slotPicker = renderSlotPicker({ slots: input.slots });
  const visitorFields = renderVisitorFields(input.required_visitor_fields);
  return `${renderHead(`Schedule with ${input.display_name}`)}
<body>
<div class="rcp-shell">
<div class="rcp-card">
<div class="rcp-header">
<div>
<h1 class="rcp-name">Schedule with ${htmlEscape(input.display_name)}</h1>
${instructionsBlock}
${advanceNoticeBlock}
</div>
</div>
${durationBlock}
<form class="rcp-form" method="POST" action="/reception/scheduling/${htmlEscape(input.endpoint_id)}/book?t=${encodeURIComponent(input.bearer_secret)}">
<input type="hidden" name="form_nonce" value="${htmlEscape(input.form_nonce)}">
<input type="hidden" name="duration" value="${input.active_duration_minutes}">
${slotPicker}
${visitorFields}
<button type="submit" class="rcp-button rcp-button-primary">Confirm booking</button>
</form>
${renderFooter(input.tz_label, input.trust_footer ?? null)}
</div>
</div>
</body>
</html>
`;
};

// ────────────────────────────────────────────────────────────────
// Booking success page
// ────────────────────────────────────────────────────────────────

export const renderSchedulingLinkSuccessHtml = (input: {
  display_name: string;
  tz_label: string;
  success_message: string;
  slot_display_label: string;
  /** D-149 § A.20.3 — pre-built Visitor Receipt from
   *  `resolveVisitorReceipt` (`null` ⇒ per-endpoint receipts disabled,
   *  no receipt block). */
  receipt?: VisitorReceipt | null;
}): string => {
  return `${renderHead(`Booked with ${input.display_name}`)}
<body>
<div class="rcp-shell">
<div class="rcp-card">
<div class="rcp-header">
<div>
<h1 class="rcp-name">Booking received</h1>
<p class="rcp-tagline">${htmlEscape(input.success_message)}</p>
<p class="rcp-meta">${htmlEscape(input.slot_display_label)}</p>
</div>
</div>
${renderVisitorReceiptBlock(input.receipt)}
${renderFooter(input.tz_label)}
</div>
</div>
</body>
</html>
`;
};

// ────────────────────────────────────────────────────────────────
// Booking-error page (validator failure / advance-notice gate / etc.)
// ────────────────────────────────────────────────────────────────

export const renderSchedulingLinkErrorHtml = (input: {
  display_name: string;
  tz_label: string;
  message: string;
}): string => {
  return `${renderHead(`Schedule with ${input.display_name}`)}
<body>
<div class="rcp-shell">
<div class="rcp-card">
<div class="rcp-header">
<div>
<h1 class="rcp-name">Couldn’t complete booking</h1>
<p class="rcp-tagline">${htmlEscape(input.message)}</p>
</div>
</div>
${renderFooter(input.tz_label)}
</div>
</div>
</body>
</html>
`;
};

// ────────────────────────────────────────────────────────────────
// D-210 Appendix B — the /reception/manage reschedule page
// ────────────────────────────────────────────────────────────────

/** The on-the-go reschedule page for one existing booking. Re-renders the
 *  scheduling endpoint's OWN slot picker (same shell, same CSP, same helpers)
 *  so the visitor/owner picks a new time exactly as they booked — but there is
 *  no duration select (a reschedule keeps the booking's length) and no visitor
 *  fields (they are not re-collected; showing blank inputs the write ignores
 *  would be a false claim). The POST holds for the owner's approval. */
export const renderManageReschedulePage = (input: {
  readonly display_name: string;
  readonly tz_label: string;
  /** The booking's CURRENT time, pre-formatted in the endpoint's tz. */
  readonly current_slot_label: string;
  /** Same-duration candidate slots, enumerated server-side. */
  readonly slots: ReadonlyArray<SchedulingSlot>;
  /** The manage POST URL — the credential is in the PATH, so no `?t=`. */
  readonly post_action: string;
  readonly form_nonce: string;
  readonly instructions?: string;
}): string => {
  const instructionsBlock =
    input.instructions && input.instructions.length > 0
      ? `<p class="rcp-tagline">${htmlEscape(input.instructions)}</p>`
      : '';
  const currentBlock = `<p class="rcp-meta">Currently booked for ${htmlEscape(input.current_slot_label)}. Pick a new time below.</p>`;
  const slotPicker = renderSlotPicker({ slots: input.slots });
  return `${renderHead(`Reschedule with ${input.display_name}`)}
<body>
<div class="rcp-shell">
<div class="rcp-card">
<div class="rcp-header">
<div>
<h1 class="rcp-name">Reschedule your booking</h1>
${instructionsBlock}
${currentBlock}
</div>
</div>
<form class="rcp-form" method="POST" action="${htmlEscape(input.post_action)}">
<input type="hidden" name="form_nonce" value="${htmlEscape(input.form_nonce)}">
${slotPicker}
<button type="submit" class="rcp-button rcp-button-primary">Request new time</button>
</form>
${renderFooter(input.tz_label)}
</div>
</div>
</body>
</html>
`;
};

/** The manage result page — held-for-approval (the honest success), or an
 *  error / unavailable. The reschedule does NOT take effect here: it holds at
 *  the owner's gate, and this page says so rather than implying the move
 *  happened. */
export const renderManageResultHtml = (input: {
  readonly display_name: string;
  readonly tz_label: string;
  readonly heading: string;
  readonly message: string;
}): string => {
  return `${renderHead(`Reschedule with ${input.display_name}`)}
<body>
<div class="rcp-shell">
<div class="rcp-card">
<div class="rcp-header">
<div>
<h1 class="rcp-name">${htmlEscape(input.heading)}</h1>
<p class="rcp-tagline">${htmlEscape(input.message)}</p>
</div>
</div>
${renderFooter(input.tz_label)}
</div>
</div>
</body>
</html>
`;
};
