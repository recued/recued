/** D-149 P4 § A.5.1 — Reception page HTML renderer.
 *
 *  Server-rendered (no SPA, no inline JS, no inline event handlers).
 *  All user-supplied strings HTML-escaped at the boundary. The Content-
 *  Security-Policy meta-tag declares `default-src 'self'` to gate any
 *  inadvertent third-party fetch (TR-8: custom-link XSS mitigation).
 *
 *  Render contract:
 *
 *    - INPUT: the redacted packet payload built by the D-145 substrate
 *      via `buildReceptionPacket('reception_page_packet', ...)`. The
 *      payload is already strict-picked to `PACKET_FIELDS_VISIBLE`:
 *      `display_name`, `tagline`, `avatar_url?`, `preferred_contact_methods`,
 *      `cta_buttons`, `tz_label`, `response_time_estimate?`. The
 *      renderer SHALL NOT add fields beyond these to the output.
 *
 *    - OUTPUT: a single HTML5 document string. No streaming; no
 *      partials. The substrate ships the closed-list CSS bundle via
 *      `/reception/_static/style.css` (linked from `<head>`).
 *
 *    - PLACEHOLDER: when called with `payload === null`, renders the
 *      substrate-defined `RECEPTION_PAGE_PLACEHOLDER_TEXT` body. The
 *      same DOCTYPE / head / CSP / favicon links are emitted so the
 *      configured vs unconfigured surfaces are indistinguishable on
 *      the wire (§ Must Hold I-1 no-fingerprint baseline).
 *
 *  HTML escape table covers the 5 XML predeclared entities (`&`, `<`,
 *  `>`, `"`, `'`). The escape table is intentionally narrow — the
 *  rendered surface uses no inline event handlers or `javascript:`
 *  URLs, so the named entity set suffices for safe interpolation into
 *  text content, attribute values, and href-equals targets.
 *
 *  Spec: docs/d-149-spec.md § A.5.1 + § A.11 TR-8. */

import {
  RECEPTION_PAGE_PLACEHOLDER_TEXT,
  RECEPTION_PAGE_STATIC_PATH_PREFIX,
  selectValidReceptionLinkButtons,
  type ReceptionLinkButton,
  type ReceptionPageCtaButton,
  type ReceptionPagePreferredContactMethod,
} from '@recued/contracts';
import { renderSection, type RenderContext } from '@recued/renderer';

// ────────────────────────────────────────────────────────────────
// The render context every reception surface uses
// ────────────────────────────────────────────────────────────────

/** D-207 slice 2 — what `@recued/renderer` must know about a Reception page.
 *
 *  ⛔ EVERY reception surface renders with THIS. Both fields are load-bearing,
 *  and both describe the AUDIENCE and the ENVIRONMENT — never the content:
 *
 *  - `audience: 'public'` — the reader is an anonymous visitor, so the renderer
 *    withholds the chrome it adds for an owner: internal identifiers
 *    (`recipe_id`, warehouse `record_id`) and copy that instructs the reader to
 *    open the Recipes result panel, which they have no account for. It does NOT
 *    withhold anything a RECIPE supplied — the substrate cannot judge whether
 *    the data an author put in a `summary` is fit for a stranger, and a check
 *    that looks like that assurance without being it would be worse than none.
 *    The author chose the block; the owner consented to the recipe at bind.
 *
 *  - `interactive: false` — this page's CSP is `script-src 'none'` (see
 *    `renderHead`). A Copy button here is not merely unstyled, it is DEAD: a
 *    control advertising the one thing it cannot do. */
export const RECEPTION_RENDER_CONTEXT: RenderContext = {
  audience: 'public',
  interactive: false,
};

/** One block of a recipe run's resolved output (`ExecuteResponse.output.render`).
 *
 *  The engine has already resolved each authored `OutputSection.source` ref into
 *  `data`, so what arrives here is `{ type, data, label? }` — exactly what the
 *  shared renderer's `SectionBlock` consumes, modulo the field name. Declared
 *  structurally rather than imported from the server's `ExecuteResponse` so this
 *  renderer stays a pure boundary with no dependency on the run substrate. */
export interface ReceptionOutputBlock {
  readonly type: string;
  readonly data: unknown;
  readonly label?: string;
}

/** D-207 slice 2 — render a recipe run's output blocks onto a visitor surface.
 *
 *  This is the ONE place a run's blocks become public HTML. Every block goes
 *  through the shared `@recued/renderer` with `RECEPTION_RENDER_CONTEXT`, so
 *  the audience and CSP rules above are not something each caller has to
 *  remember — a caller physically cannot render these blocks for a visitor with
 *  the owner's context.
 *
 *  ⚠ An unknown `type` renders the renderer's own `unsupported section type`
 *  block rather than throwing or being skipped. Skipping would be the wrong
 *  failure: the recipe author declared a block, the owner consented to the
 *  recipe, and a silently-missing block on a page the visitor is ACTING on
 *  (a checkout button that just is not there) is the silent-success class all
 *  over again. Better a visible "unsupported" than a page that quietly lost the
 *  thing it was supposed to hand over. */
export const renderReceptionOutputBlocks = (
  blocks: ReadonlyArray<ReceptionOutputBlock> | undefined | null,
): string => {
  if (!Array.isArray(blocks) || blocks.length === 0) return '';
  return blocks
    .map((block) =>
      renderSection(
        {
          kind: block.type,
          data: block.data,
          ...(typeof block.label === 'string' ? { label: block.label } : {}),
        },
        RECEPTION_RENDER_CONTEXT,
      ),
    )
    .join('\n');
};

// ────────────────────────────────────────────────────────────────
// HTML escape
// ────────────────────────────────────────────────────────────────

const HTML_ESCAPE_TABLE: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const HTML_ESCAPE_RE = /[&<>"']/g;

/** Pure HTML5 escape — single source of truth at the renderer
 *  boundary. Substitutes the 5 XML predeclared entities. Callers
 *  using template strings get safe interpolation via this fn. */
export const htmlEscape = (raw: string): string =>
  raw.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPE_TABLE[ch] ?? ch);

// ────────────────────────────────────────────────────────────────
// Inputs (closed-shape mirror of PACKET_FIELDS_VISIBLE.reception_page_packet)
// ────────────────────────────────────────────────────────────────

export interface ReceptionPageRenderInput {
  readonly display_name: string;
  readonly tagline: string;
  readonly tz_label: string;
  readonly preferred_contact_methods: ReadonlyArray<ReceptionPagePreferredContactMethod>;
  readonly cta_buttons: ReadonlyArray<ReceptionPageCtaButton>;
  readonly avatar_url?: string;
  readonly response_time_estimate?: string;
  /** Optional substrate-substrate-controlled custom links (per § A.5.1
   *  custom_links section). Renderer reads these from the registry
   *  metadata blob via the assembler. */
  readonly custom_links?: ReadonlyArray<{ readonly label: string; readonly url: string }>;
  /** D-196 S3 — HTTPS-only plain-navigation elements. */
  readonly link_buttons?: ReadonlyArray<ReceptionLinkButton>;
  /** D-149 P12 § A.20.7 — pre-built Public Trust Footer string from
   *  `resolveReceptionTrustFooter` (`null` ⇒ per-server toggle off, no
   *  footer block). Already HTML-safe — `buildTrustFooter` escapes the
   *  interpolated display name — so the renderer emits it verbatim. */
  readonly trust_footer?: string | null;
}

// ────────────────────────────────────────────────────────────────
// Contact-method label table
// ────────────────────────────────────────────────────────────────

/** Visitor-facing label for each contact method. Substrate-controlled;
 *  Mary cannot override per v1. The label intentionally does NOT carry
 *  the actual address (only "method" enums per § A.5.1 line 583). */
const CONTACT_METHOD_LABEL: Readonly<Record<ReceptionPagePreferredContactMethod, string>> = {
  email: 'Email',
  phone: 'Phone',
  slack: 'Slack',
  telegram: 'Telegram',
};

// ────────────────────────────────────────────────────────────────
// Renderer
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

/** D-149 P12 § A.20.7 — `trust_footer` is the string returned by
 *  `buildTrustFooter` (contracts), which html-escapes the only
 *  interpolated value (the display name). It is already HTML-safe;
 *  interpolate it VERBATIM and do NOT re-escape — re-escaping would
 *  double-encode the display name. `null` / absent ⇒ no trust block. */
const renderFooter = (tz_label: string, trust_footer?: string | null): string => {
  const trustLine =
    typeof trust_footer === 'string' && trust_footer.length > 0
      ? `<p class="rcp-trust-footer">${trust_footer}</p>\n`
      : '';
  return `<div class="rcp-footer">${trustLine}Powered by Recued · ${htmlEscape(tz_label)}</div>`;
};

/** Render the substrate placeholder body. Wrapped in the same shell as
 *  the configured render so the configured vs unconfigured surfaces
 *  are structurally indistinguishable. */
export const renderReceptionPagePlaceholderHtml = (tz_label: string): string => {
  return `${renderHead('Reception')}
<body>
<div class="rcp-shell">
<div class="rcp-card">
<p class="rcp-placeholder">${htmlEscape(RECEPTION_PAGE_PLACEHOLDER_TEXT)}</p>
${renderFooter(tz_label)}
</div>
</div>
</body>
</html>
`;
};

// ────────────────────────────────────────────────────────────────
// D-196 § 4.5 link buttons — rendered by the ONE shared block renderer
// ────────────────────────────────────────────────────────────────

/** Wrap the shared `link_button` block in this page's section chrome.
 *
 *  ⛔ THE BLOCK ITSELF IS NOT RENDERED HERE. `@recued/renderer` owns all nine
 *  block kinds, and D-207 slice 2 made the reception surfaces its second
 *  consumer precisely so this page and the intake-form RESPONSE cannot drift
 *  apart — D-196 § 4.5 settled the link button as *"a general form element…
 *  available to any reception form/page composition"*, and two renderers for
 *  one block is how a fence like the absolute-HTTPS `href` check ends up
 *  enforced on one surface and forgotten on the other. The renderer revalidates
 *  the raw rows itself; escaping a `javascript:` URL yields a working
 *  `javascript:` URL, so the scheme check is the fence, not the escape.
 *
 *  What stays HERE is layout: the section wrapper and its title are page
 *  chrome, not part of the block — none of the other eight kinds render a
 *  heading either. `''` when nothing survives validation, so the section
 *  disappears rather than showing an empty "Links". */
const renderLinkButtonsSection = (value: unknown): string => {
  const buttons = selectValidReceptionLinkButtons(value);
  if (buttons.length === 0) return '';
  return `<div class="rcp-section">
<p class="rcp-section-title">Links</p>
${renderSection({ kind: 'link_button', data: buttons }, RECEPTION_RENDER_CONTEXT)}
</div>`;
};

/** Render the configured reception_page body. Packet fields arrive through
 *  the D-145 substrate (strict-pick + per-kind transformation). */
export const renderReceptionPageHtml = (input: ReceptionPageRenderInput): string => {
  const linkButtons = selectValidReceptionLinkButtons(input.link_buttons);
  const sectionsEmpty =
    input.preferred_contact_methods.length === 0 &&
    input.cta_buttons.length === 0 &&
    (input.custom_links?.length ?? 0) === 0 &&
    linkButtons.length === 0;

  const avatarBlock = input.avatar_url
    ? `<img class="rcp-avatar" src="${htmlEscape(input.avatar_url)}" alt="">`
    : `<div class="rcp-avatar" aria-hidden="true"></div>`;

  const headerBlock = `<div class="rcp-header">
${avatarBlock}
<div>
<h1 class="rcp-name">${htmlEscape(input.display_name)}</h1>
${
  input.tagline.length > 0
    ? `<p class="rcp-tagline">${htmlEscape(input.tagline)}</p>`
    : ''
}
</div>
</div>`;

  const responseTimeBlock = input.response_time_estimate
    ? `<p class="rcp-tagline">${htmlEscape(input.response_time_estimate)}</p>`
    : '';

  const methodsBlock =
    input.preferred_contact_methods.length > 0
      ? `<div class="rcp-section">
<p class="rcp-section-title">Reach me via</p>
<div class="rcp-methods">${input.preferred_contact_methods
          .map(
            (m) =>
              `<span class="rcp-method-chip">${htmlEscape(CONTACT_METHOD_LABEL[m])}</span>`,
          )
          .join('')}</div>
</div>`
      : '';

  const ctaBlock =
    input.cta_buttons.length > 0
      ? `<div class="rcp-section">
<p class="rcp-section-title">Quick actions</p>
${input.cta_buttons
          .map(
            (b) =>
              // CTA href comes from the projector via `b.href` (Codex
              // P4 review fold) — either the full share URL Mary
              // captured at create + pasted into the config (visitor
              // round-trips end-to-end), or the token-less fallback
              // `/reception/<kind>/<endpoint_id>` (visitor hits 401;
              // Mary still expected to share the bearer URL via
              // email / Slack / DM). The renderer trusts the
              // substrate-validated value + HTML-escapes for safety.
              `<a class="rcp-cta" href="${htmlEscape(b.href)}" rel="noopener noreferrer">${htmlEscape(b.label)}</a>`,
          )
          .join('')}
</div>`
      : '';

  const customLinksBlock =
    input.custom_links && input.custom_links.length > 0
      ? `<div class="rcp-section">
<p class="rcp-section-title">Other links</p>
${input.custom_links
          .map(
            (l) =>
              `<a class="rcp-link" href="${htmlEscape(l.url)}" rel="noopener noreferrer">${htmlEscape(l.label)}</a>`,
          )
          .join('')}
</div>`
      : '';

  const linkButtonsBlock = renderLinkButtonsSection(input.link_buttons);

  const placeholderHint = sectionsEmpty
    ? `<p class="rcp-placeholder">${htmlEscape(RECEPTION_PAGE_PLACEHOLDER_TEXT)}</p>`
    : '';

  return `${renderHead(input.display_name)}
<body>
<div class="rcp-shell">
<div class="rcp-card">
${headerBlock}
${responseTimeBlock}
${methodsBlock}
${ctaBlock}
${customLinksBlock}
${linkButtonsBlock}
${placeholderHint}
${renderFooter(input.tz_label, input.trust_footer ?? null)}
</div>
</div>
</body>
</html>
`;
};

// Codex P4 review fold (2026-05-13) — `ctaKindToPathSegment` retired.
// CTA `href` is computed at the projector + carried on the button
// (`b.href`); the renderer no longer needs the kind→segment map.
