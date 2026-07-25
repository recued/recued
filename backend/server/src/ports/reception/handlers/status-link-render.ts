/** D-149 P9 § A.5.6 — `status_link` HTML renderer.
 *
 *  Server-rendered read-only entity projection — no SPA, no inline JS
 *  beyond a closed-list `<meta http-equiv="refresh">` directive when
 *  auto-refresh is enabled (cheaper than client-side polling JS;
 *  preserves the substrate's `script-src 'none'` CSP).
 *
 *  Visitor-facing privacy contract (§ A.5.6 lines 939-948):
 *
 *    The renderer's INPUT is the redacted-packet payload built by
 *    `buildReceptionPacket('status_link_packet', ...)`. The packet's
 *    `visible_fields` is the per-projection closed list (clipped +
 *    per-field redacted) — booking codes / confirmation numbers /
 *    vendor names / internal codenames never reach this layer.
 *
 *  The renderer's only job is to HTML-escape interpolations + emit the
 *  page shell + the projection-specific body. No fields beyond the
 *  packet payload ever reach the HTML.
 *
 *  Spec: docs/d-149-spec.md § A.5.6 + § A.11 TR-10. */

import {
  RECEPTION_PAGE_STATIC_PATH_PREFIX,
  type StatusLinkProjectionKind,
} from '@recued/contracts';
import { htmlEscape } from './reception-page-render.js';

// ────────────────────────────────────────────────────────────────
// Inputs
// ────────────────────────────────────────────────────────────────

export interface StatusLinkRenderInput {
  /** Visitor-facing display name (typically Mary's first name or
   *  handle). */
  readonly display_name: string;
  /** Optional sub-header beneath the display name. */
  readonly caption?: string;
  /** The closed-list projection_kind — drives the per-projection body. */
  readonly projection_kind: StatusLinkProjectionKind;
  /** Substrate-projected visible fields (closed list per projection).
   *  Already redacted at the packet boundary; the renderer trusts the
   *  payload shape. */
  readonly visible_fields: Readonly<Record<string, unknown>>;
  /** Coarse-grained "updated X" hint (relative timestamp). */
  readonly last_updated_at_relative: string;
  /** Whether the page shows the update-history hint at all. */
  readonly updates_visible: boolean;
  /** Whether the comments toggle is exposed (v1: always false; future
   *  feature). */
  readonly comments_enabled: boolean;
  /** When >0, emits a `<meta http-equiv="refresh">` directive so the
   *  visitor's browser polls the same URL on the configured cadence.
   *  When 0 / omitted, no auto-refresh meta tag emits. */
  readonly refresh_interval_seconds?: number;
  /** D-149 P12 § A.20.7 — pre-built Public Trust Footer string from
   *  `resolveReceptionTrustFooter` (`null` ⇒ per-server toggle off, no
   *  footer block). Already HTML-safe — `buildTrustFooter` escapes the
   *  interpolated display name — so the renderer emits it verbatim. */
  readonly trust_footer?: string | null;
}

// ────────────────────────────────────────────────────────────────
// Page shell
// ────────────────────────────────────────────────────────────────

const renderHead = (title: string, refreshSeconds: number | undefined): string => {
  const refreshTag =
    refreshSeconds !== undefined && Number.isFinite(refreshSeconds) && refreshSeconds > 0
      ? `<meta http-equiv="refresh" content="${refreshSeconds}">`
      : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' http: https: data:; style-src 'self'; script-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'">
<meta name="robots" content="noindex,nofollow">
${refreshTag}
<title>${htmlEscape(title)}</title>
<link rel="icon" href="${RECEPTION_PAGE_STATIC_PATH_PREFIX}favicon.ico">
<link rel="stylesheet" href="${RECEPTION_PAGE_STATIC_PATH_PREFIX}style.css">
</head>`;
};

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
// Per-field rendering helpers
// ────────────────────────────────────────────────────────────────

const fieldString = (value: unknown): string =>
  typeof value === 'string' ? value : '';

const fieldNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const renderTitle = (value: unknown): string => {
  const v = fieldString(value);
  return v.length > 0 ? `<h2 class="rcp-status-title">${htmlEscape(v)}</h2>` : '';
};

const renderStringRow = (label: string, value: unknown): string => {
  const v = fieldString(value);
  if (v.length === 0) return '';
  return `<div class="rcp-status-row"><span class="rcp-status-label">${htmlEscape(label)}</span><span class="rcp-status-value">${htmlEscape(v)}</span></div>`;
};

const renderNumberRow = (label: string, value: unknown): string => {
  const v = fieldNumber(value);
  if (v === null) return '';
  return `<div class="rcp-status-row"><span class="rcp-status-label">${htmlEscape(label)}</span><span class="rcp-status-value">${htmlEscape(String(v))}</span></div>`;
};

const renderAttendeesList = (value: unknown): string => {
  if (!Array.isArray(value) || value.length === 0) return '';
  const items = value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => `<li class="rcp-status-item">${htmlEscape(v)}</li>`)
    .join('\n');
  if (items.length === 0) return '';
  return `<div class="rcp-status-row"><span class="rcp-status-label">Attendees</span><ul class="rcp-status-list">${items}</ul></div>`;
};

const renderLegsList = (value: unknown): string => {
  if (!Array.isArray(value) || value.length === 0) return '';
  const items = value
    .filter(
      (v): v is { origin: string; destination: string; mode: string; time: string } =>
        v !== null &&
        typeof v === 'object' &&
        typeof (v as Record<string, unknown>).origin === 'string' &&
        typeof (v as Record<string, unknown>).destination === 'string' &&
        typeof (v as Record<string, unknown>).mode === 'string' &&
        typeof (v as Record<string, unknown>).time === 'string',
    )
    .map(
      (leg) =>
        `<li class="rcp-status-item"><span class="rcp-status-leg">${htmlEscape(leg.origin)} → ${htmlEscape(leg.destination)}</span><span class="rcp-status-leg-meta">${htmlEscape(leg.mode)} · ${htmlEscape(leg.time)}</span></li>`,
    )
    .join('\n');
  if (items.length === 0) return '';
  return `<div class="rcp-status-row"><span class="rcp-status-label">Legs</span><ul class="rcp-status-list">${items}</ul></div>`;
};

const renderDateRange = (value: unknown): string => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return '';
  const v = value as Record<string, unknown>;
  const start = fieldNumber(v.start_at);
  const end = fieldNumber(v.end_at);
  if (start === null || end === null) return '';
  const startIso = new Date(start).toISOString().slice(0, 10);
  const endIso = new Date(end).toISOString().slice(0, 10);
  return `<div class="rcp-status-row"><span class="rcp-status-label">Dates</span><span class="rcp-status-value">${htmlEscape(startIso)} → ${htmlEscape(endIso)}</span></div>`;
};

const renderItemsList = (value: unknown): string => {
  if (!Array.isArray(value) || value.length === 0) return '';
  const items = value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => `<li class="rcp-status-item">${htmlEscape(v)}</li>`)
    .join('\n');
  if (items.length === 0) return '';
  return `<div class="rcp-status-row"><span class="rcp-status-label">Items</span><ul class="rcp-status-list">${items}</ul></div>`;
};

const renderTagsList = (value: unknown): string => {
  if (!Array.isArray(value) || value.length === 0) return '';
  const items = value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => `<span class="rcp-tag">${htmlEscape(v)}</span>`)
    .join(' ');
  if (items.length === 0) return '';
  return `<div class="rcp-status-row"><span class="rcp-status-label">Tags</span><span class="rcp-status-tags">${items}</span></div>`;
};

// ────────────────────────────────────────────────────────────────
// Per-projection bodies
// ────────────────────────────────────────────────────────────────

const renderEventPlanBody = (fields: Readonly<Record<string, unknown>>): string => {
  return [
    renderTitle(fields.title),
    renderStringRow('Date', fields.date),
    renderStringRow('Where', fields.location_label),
    renderStringRow('Timezone', fields.tz_label),
    renderStringRow('Agenda', fields.agenda_summary),
    renderAttendeesList(fields.visible_attendees),
  ]
    .filter((s) => s.length > 0)
    .join('\n');
};

const renderItineraryBody = (fields: Readonly<Record<string, unknown>>): string => {
  return [
    renderTitle(fields.title),
    renderDateRange(fields.date_range),
    renderLegsList(fields.visible_legs),
  ]
    .filter((s) => s.length > 0)
    .join('\n');
};

const renderProjectBody = (fields: Readonly<Record<string, unknown>>): string => {
  return [
    renderTitle(fields.title),
    renderStringRow('Status', fields.state),
    renderNumberRow('Open commitments', fields.open_commitment_count),
    renderStringRow('Last activity', fields.last_activity_at_relative),
    renderStringRow('Milestones', fields.milestone_summary),
  ]
    .filter((s) => s.length > 0)
    .join('\n');
};

const renderPackingListBody = (fields: Readonly<Record<string, unknown>>): string => {
  return [
    renderTitle(fields.title),
    renderStringRow('Due', fields.due_date_relative),
    renderNumberRow('Packed', fields.packed_count),
    renderNumberRow('Total', fields.total_count),
    renderItemsList(fields.items),
  ]
    .filter((s) => s.length > 0)
    .join('\n');
};

const renderCommitmentSummaryBody = (
  fields: Readonly<Record<string, unknown>>,
): string => {
  return [
    renderTitle(fields.title),
    renderStringRow('State', fields.state),
    renderStringRow('Due', fields.due_at_relative),
    renderStringRow('With', fields.counterparty_first_name_initial),
  ]
    .filter((s) => s.length > 0)
    .join('\n');
};

const renderCustomBody = (fields: Readonly<Record<string, unknown>>): string => {
  return [
    renderTitle(fields.title),
    renderStringRow('Summary', fields.summary),
    renderStringRow('Updated', fields.updated_at_relative),
    renderTagsList(fields.tags),
  ]
    .filter((s) => s.length > 0)
    .join('\n');
};

const renderProjectionBody = (
  projection_kind: StatusLinkProjectionKind,
  visible_fields: Readonly<Record<string, unknown>>,
): string => {
  switch (projection_kind) {
    case 'event_plan':
      return renderEventPlanBody(visible_fields);
    case 'itinerary':
      return renderItineraryBody(visible_fields);
    case 'project':
      return renderProjectBody(visible_fields);
    case 'packing_list':
      return renderPackingListBody(visible_fields);
    case 'commitment_summary':
      return renderCommitmentSummaryBody(visible_fields);
    case 'custom':
      return renderCustomBody(visible_fields);
  }
};

// ────────────────────────────────────────────────────────────────
// Main render
// ────────────────────────────────────────────────────────────────

/** Substrate-defined placeholder body — emitted when the endpoint is
 *  in a degraded / locked state. Indistinguishable from the configured
 *  shell per Must Hold I-1. */
export const renderStatusLinkPlaceholderHtml = (): string => {
  return `${renderHead('Status', undefined)}
<body>
<div class="rcp-shell">
<div class="rcp-card">
<p class="rcp-placeholder">This status link is not currently available.</p>
${renderFooter()}
</div>
</div>
</body>
</html>
`;
};

export const renderStatusLinkHtml = (input: StatusLinkRenderInput): string => {
  const body = renderProjectionBody(input.projection_kind, input.visible_fields);
  const updatedHint =
    input.updates_visible && input.last_updated_at_relative.length > 0
      ? `<p class="rcp-meta">Updated ${htmlEscape(input.last_updated_at_relative)}</p>`
      : '';
  const captionLine =
    typeof input.caption === 'string' && input.caption.length > 0
      ? `<p class="rcp-tagline">${htmlEscape(input.caption)}</p>`
      : '';
  return `${renderHead(`Status — ${input.display_name}`, input.refresh_interval_seconds)}
<body>
<div class="rcp-shell">
<div class="rcp-card">
<div class="rcp-header">
<div>
<h1 class="rcp-name">${htmlEscape(input.display_name)}</h1>
${captionLine}
${updatedHint}
</div>
</div>
<div class="rcp-status-body">
${body}
</div>
${renderFooter(input.trust_footer ?? null)}
</div>
</div>
</body>
</html>
`;
};
