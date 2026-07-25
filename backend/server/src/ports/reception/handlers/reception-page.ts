/** D-149 P4 § A.5.1 — `reception_page` per-kind handler.
 *
 *  Renders the per-server singleton landing page at `/reception/`. The
 *  dispatcher in `handler.ts` special-cases the bare singleton path
 *  (no token extract, no token verify, no post-verify daily cap) before
 *  dispatching here. By the time this handler runs, the pre-verify
 *  per-IP rate-limit has cleared.
 *
 *  Render path:
 *
 *    1. Load the singleton config row via `store.loadReceptionPageSingleton()`.
 *       Returns `null` on fresh-install — handler emits the substrate
 *       placeholder HTML.
 *    2. Assemble a source view via `assembleReceptionPageSourceView`.
 *       Falls back to placeholder if the stored blob is structurally
 *       invalid (defense in depth — a corrupt config never 500s the
 *       page).
 *    3. Build the raw packet input via `buildReceptionPagePacketRawInput`.
 *    4. Build the redacted packet via `buildReceptionPacket(...)`. The
 *       D-145 substrate's strict-pick + per-kind transformation drops
 *       `section_config` + `linked_endpoints` from the payload (only
 *       the projected `cta_buttons` survives).
 *    5. Render HTML via `renderReceptionPageHtml`. Single source of
 *       truth for HTML escape + structural emission.
 *    6. Write `200` with `text/html; charset=utf-8` + privacy-preserving
 *       response headers (`Referrer-Policy: same-origin`, `X-Content-
 *       Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cache-Control:
 *       no-store`).
 *
 *  Spec: docs/d-149-spec.md § A.5.1 + § Must Hold I-1 / I-12b. */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  RECEPTION_PAGE_PLACEHOLDER_TEXT,
  type RedactedPacketBuildAuditEvent,
  type TrustFooterDeploymentMode,
} from '@recued/contracts';
import { buildReceptionPacket, type ReceptionEndpointContext } from '../redacted-packet.js';
import type { ReceptionKindHandler } from './types.js';
import {
  renderReceptionPageHtml,
  renderReceptionPagePlaceholderHtml,
  type ReceptionPageRenderInput,
} from './reception-page-render.js';
import { buildReceptionTrustFooterFromToggle } from './trust-footer.js';
import {
  assembleReceptionPageSourceView,
  buildReceptionPagePacketRawInput,
} from '../transformations/reception-page.js';
import type { PublicEndpointRegistryStore } from '../../../storage/public-endpoint-registry-store.js';

const FALLBACK_TZ_LABEL = 'UTC' as const;

/** Privacy + safety response headers. `Referrer-Policy: same-origin` per
 *  § Must Hold I-12b default for token-less pages; `X-Frame-Options:
 *  DENY` to refuse iframe embedding (substrate is the page; embedders
 *  must not capture visitor interactions). */
const writeHtmlResponse = (
  res: ServerResponse,
  body: string,
): void => {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('content-length', String(Buffer.byteLength(body, 'utf8')));
  res.end(body);
};

export interface ReceptionPageHandlerDeps {
  readonly getStore: () => PublicEndpointRegistryStore;
  readonly now: () => number;
  /** Optional D-120 audit emit seam for `redacted_packet.built` events.
   *  The dispatcher's main path emits a per-request operational log
   *  entry separately; this seam fires only for packet-build telemetry
   *  per § Must Hold I-6. */
  readonly emitAudit?: (event: RedactedPacketBuildAuditEvent) => string | undefined;
  /** D-149 P12 § A.20.7 — deployment mode for the Public Trust Footer.
   *  Boot-constant derived in `bin.ts` from the public base URL host
   *  (`isProDdnsHost`). Absent ⇒ the handler renders no trust footer
   *  (the dispatcher passes it unconditionally once wired). */
  readonly receptionDeploymentMode?: TrustFooterDeploymentMode;
}

/** Build a handler bound to the supplied deps. The deps-bound shape
 *  is required by the dispatcher's `ReceptionKindHandler` registry; the
 *  bare exported handler still exists for the test that asserts every
 *  kind has a callable function in the registry. */
export const createReceptionPagePacketHandler = (
  deps: ReceptionPageHandlerDeps,
): ReceptionKindHandler => {
  return async (_req: IncomingMessage, res: ServerResponse, endpoint: ReceptionEndpointContext) => {
    const stored = deps.getStore().loadReceptionPageSingleton();
    if (!stored) {
      // Fresh-install — render the substrate placeholder. The `tz_label`
      // fallback is `UTC` so the footer renders something even though
      // no display profile is configured.
      writeHtmlResponse(res, renderReceptionPagePlaceholderHtml(FALLBACK_TZ_LABEL));
      return;
    }
    const source = assembleReceptionPageSourceView(stored.config);
    if (!source) {
      // Corrupt config (e.g. metadata_blob hand-edited). Fall back to
      // the placeholder rather than 500ing — visitor sees the same
      // wire shape as fresh-install, no fingerprint of "configured
      // but broken" state per § Must Hold I-1.
      writeHtmlResponse(res, renderReceptionPagePlaceholderHtml(FALLBACK_TZ_LABEL));
      return;
    }
    const raw = buildReceptionPagePacketRawInput(source);
    const now = deps.now();
    const built = buildReceptionPacket('reception_page_packet', raw, endpoint, {
      now,
      randomToken: () => randomUUID(),
      ...(deps.emitAudit !== undefined ? { emitAudit: deps.emitAudit } : {}),
    });
    // D-149 P12 § A.20.7 — resolve the Public Trust Footer. The
    // singleton config is already loaded here (`stored.config`), so the
    // pure builder reads the toggle directly — no second store read.
    const trust_footer =
      deps.receptionDeploymentMode !== undefined
        ? buildReceptionTrustFooterFromToggle({
            trust_footer_enabled: stored.config.trust_footer_enabled,
            deployment_mode: deps.receptionDeploymentMode,
          })
        : null;
    const renderInput: ReceptionPageRenderInput = {
      display_name: built.payload.display_name,
      tagline: built.payload.tagline,
      tz_label: built.payload.tz_label,
      preferred_contact_methods: built.payload.preferred_contact_methods,
      cta_buttons: built.payload.cta_buttons,
      trust_footer,
      ...(built.payload.avatar_url !== undefined ? { avatar_url: built.payload.avatar_url } : {}),
      ...(built.payload.response_time_estimate !== undefined
        ? { response_time_estimate: built.payload.response_time_estimate }
        : {}),
      ...(stored.config.custom_links !== undefined &&
      stored.config.sections_enabled.custom_links === true
        ? { custom_links: stored.config.custom_links }
        : {}),
      ...(stored.config.link_buttons !== undefined &&
      stored.config.sections_enabled.link_buttons === true
        ? { link_buttons: stored.config.link_buttons }
        : {}),
    };
    writeHtmlResponse(res, renderReceptionPageHtml(renderInput));
  };
};

/** Substrate-compatible default handler — kept around for the
 *  closed-list registry in `handlers/index.ts`. The dispatcher in
 *  `handler.ts` re-binds the handler with deps at boot; this default
 *  is the deps-absent fallback (renders the placeholder unconditionally,
 *  matching the no-fingerprint floor). */
export const handleReceptionPagePacket: ReceptionKindHandler = async (
  _req,
  res,
  _endpoint,
) => {
  // Wire-shape: the deps-absent path emits the placeholder copy with no
  // tz_label fallback (UTC). Renders the same HTML the deps-present
  // path emits for fresh-install + corrupt-config rows. The `_endpoint`
  // arg is unused (the singleton has no per-endpoint identity surface);
  // the dispatcher passes its standard context shape here for parity
  // with the link-style handlers.
  void RECEPTION_PAGE_PLACEHOLDER_TEXT;
  writeHtmlResponse(res, renderReceptionPagePlaceholderHtml(FALLBACK_TZ_LABEL));
};
