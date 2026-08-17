/** D-149 § A.20.3 — Visitor Receipt resolver + renderer (follow-on wiring).
 *
 *  P12 shipped `buildVisitorReceipt` (a pure builder in `@recued/contracts`)
 *  as substrate; this is the follow-on leg that wires it into the four
 *  POST success surfaces — scheduling `/book`, intake submit, drop
 *  upload, approval consume. Two entry points:
 *
 *    - `resolveVisitorReceipt` — orchestrates the per-request build: it
 *      resolves the § A.20.7 trust footer (the receipt's `privacy_footer`
 *      per § A.20.3 "Receipt content = ... + Recued's Privacy footer"),
 *      then delegates to `buildVisitorReceipt`. Returns `null` when the
 *      per-endpoint `visitor_receipt` config is absent OR has
 *      `enabled !== true` — receipts are opt-in (the conservative
 *      default). The per-kind `fields_echo` is the caller's job; the
 *      orchestrator is otherwise per-kind-agnostic.
 *    - `renderVisitorReceiptBlock` — pure HTML render helper. Emits the
 *      receipt section (reference id + submitted-at + the verbatim
 *      field echo + the privacy footer) for a built receipt, or `''`
 *      for `null` / `undefined`. The four `render*SuccessHtml` renderers
 *      drop it in between the page header and the footer.
 *
 *  Scope: v1 is the PAGE-rendered receipt (§ N.7 "page-only at v1; mail
 *  receipt opt-in"). The renderer is `via`-agnostic — it renders the
 *  page block whenever a receipt is present; `VisitorReceipt.via` is
 *  carried on the object for a future D-127 mail-send follow-on. The
 *  email *send* path is deferred.
 *
 *  Privacy note: `privacy_footer` is produced by `buildTrustFooter`
 *  (contracts), which html-escapes its only interpolated value (the
 *  display name). It is already HTML-safe — `renderVisitorReceiptBlock`
 *  interpolates it VERBATIM and MUST NOT re-escape (re-escaping would
 *  double-encode). Every other interpolation in the block (the
 *  reference id, the field labels + values) IS html-escaped — those are
 *  visitor-supplied / substrate-supplied raw strings.
 *
 *  Spec: D-149 § A.20.3 + § A.20.7 + § N.7. */

import {
  buildVisitorReceipt,
  type ReceptionEndpointKind,
  type TrustFooterDeploymentMode,
  type VisitorReceipt,
  type VisitorReceiptConfig,
  type VisitorReceiptFieldEcho,
} from '@recued/contracts';
import type { PublicEndpointRegistryStore } from '../../../storage/public-endpoint-registry-store.js';
import { resolveReceptionTrustFooter } from './trust-footer.js';
import { htmlEscape } from './reception-page-render.js';

export interface ResolveVisitorReceiptArgs {
  readonly store: PublicEndpointRegistryStore;
  /** Boot-constant from `bin.ts` (`isProDdnsHost` → `pro_cloud` /
   *  `byo_ddns`). `undefined` ⇒ the substrate renders no trust footer,
   *  so the receipt's `privacy_footer` resolves to `null`. */
  readonly receptionDeploymentMode: TrustFooterDeploymentMode | undefined;
  /** The endpoint's `visitor_receipt` config. `undefined` ⇒ receipts
   *  disabled (the per-endpoint opt-in is absent). */
  readonly config: VisitorReceiptConfig | undefined;
  /** Opaque reference id the visitor can quote (the substrate row id —
   *  `request_id` / `submission_id` / `blob_id` / `intent_id`). */
  readonly reference_id: string;
  readonly submitted_at: number;
  /** D-240 — the minted viewback path (`/reception/lookup/<secret>`), or
   *  absent when the endpoint has no `visitor_lookup` enabled. */
  readonly lookup_path?: string | null;
  readonly endpoint_kind: ReceptionEndpointKind;
  /** Verbatim echo of the visitor-submitted fields ("what was shared").
   *  Per-kind: the caller builds this from the parsed submission. */
  readonly fields_echo: ReadonlyArray<VisitorReceiptFieldEcho>;
}

/** Resolve the Visitor Receipt for a POST success render, or `null`
 *  when the per-endpoint config has receipts off / absent. Resolves the
 *  trust footer for the receipt's `privacy_footer` slot, then delegates
 *  to the pure `buildVisitorReceipt` contract builder. */
export const resolveVisitorReceipt = (
  args: ResolveVisitorReceiptArgs,
): VisitorReceipt | null => {
  if (!args.config) return null;
  const privacy_footer =
    args.receptionDeploymentMode !== undefined
      ? resolveReceptionTrustFooter({
          store: args.store,
          deployment_mode: args.receptionDeploymentMode,
        })
      : null;
  return buildVisitorReceipt({
    reference_id: args.reference_id,
    submitted_at: args.submitted_at,
    endpoint_kind: args.endpoint_kind,
    fields_echo: args.fields_echo,
    config: args.config,
    privacy_footer,
    lookup_path: args.lookup_path ?? null,
  });
};

/** Render the Visitor Receipt block (§ A.20.3) — a `.rcp-section` with
 *  the reference id, the submitted-at stamp, the verbatim field echo,
 *  and the privacy footer. Returns `''` for a `null` / `undefined`
 *  receipt so the success renderers can interpolate it unconditionally.
 *
 *  `receipt.privacy_footer` is interpolated VERBATIM — it is already
 *  HTML-safe (see file header). Every other interpolation IS escaped. */
export const renderVisitorReceiptBlock = (
  receipt: VisitorReceipt | null | undefined,
): string => {
  if (!receipt) return '';
  const submittedIso = new Date(receipt.submitted_at).toISOString();
  const fieldsBlock =
    receipt.fields_echo.length > 0
      ? `<dl class="rcp-receipt-fields">
${receipt.fields_echo
  .map(
    (f) =>
      `<dt>${htmlEscape(f.label)}</dt><dd>${htmlEscape(f.value)}</dd>`,
  )
  .join('\n')}
</dl>`
      : '';
  const footerBlock =
    typeof receipt.privacy_footer === 'string' && receipt.privacy_footer.length > 0
      ? `\n<p class="rcp-trust-footer">${receipt.privacy_footer}</p>`
      : '';
  // D-240 — the viewback link. ⚠ HTML-ESCAPED like every other interpolation
  // here, even though the secret is server-generated base64url and cannot carry
  // markup: the escape is the file's invariant ("every other interpolation IS
  // escaped"), and an exception argued from the CURRENT shape of a value is how
  // that invariant stops holding later.
  //
  // ⛔ RELATIVE HREF, so it needs no absolute-HTTPS fence: it cannot leave this
  // origin, which is the property the D-207 `link_button` fence has to CHECK for
  // a recipe-produced href. Same-origin by construction beats same-origin by
  // validation.
  const lookupBlock =
    typeof receipt.lookup_path === 'string' && receipt.lookup_path.length > 0
      ? `\n<p class="rcp-receipt-lookup">Check on this later: `
        + `<a href="${htmlEscape(receipt.lookup_path)}">${htmlEscape(receipt.lookup_path)}</a></p>`
      : '';
  return `<div class="rcp-section rcp-receipt">
<p class="rcp-section-title">Your receipt</p>
<p class="rcp-receipt-ref">Reference ID: <code>${htmlEscape(receipt.reference_id)}</code></p>
<p class="rcp-receipt-meta">Submitted ${htmlEscape(submittedIso)}</p>${lookupBlock}
${fieldsBlock}${footerBlock}
</div>`;
};
