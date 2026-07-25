/** D-149 P9 § A.5.6 — `status_link` packet handler (GET).
 *
 *  Renders the visitor-facing read-only entity projection. The
 *  pre-handler dispatcher in `handler.ts` already verified the bearer
 *  token, the per-IP rate limit, the post-verify daily cap, and that
 *  the cached registry row is enabled + non-revoked + non-expired. By
 *  the time this handler runs the request is authorized — the only
 *  work left is:
 *
 *    GET HTML:
 *      1. Parse the stored `StatusLinkConfig` blob.
 *      2. Read the projection row via `StatusProjectionStore.findByEndpoint`.
 *      3. Resolve the source entity via the injected
 *         `StatusEntitySourceReader`. The reader returns either a
 *         pre-sanitized row OR `null` (entity moved / deleted / not
 *         visible). On null the handler renders the placeholder.
 *      4. Build the redacted packet (strict-pick + per-projection
 *         per-field redactor at the substrate boundary).
 *      5. Render the HTML.
 *
 *    GET JSON (`?format=json`):
 *      Same source-read + packet-build path; encodes the packet payload
 *      as JSON instead of HTML so the auto-refresh polling client can
 *      consume the projection without re-rendering server-side HTML.
 *      Closed envelope shape; no surplus fields ever surface here.
 *
 *  No mutation path — status links are pure read. Future
 *  `comments_enabled: true` would route comments through a separate
 *  `feedback` entity; the source entity is never mutated by the
 *  visitor.
 *
 *  Spec: docs/d-149-spec.md § A.5.6 + § Must Hold I-2 + I-12 + I-13. */

import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  RedactedPacketBuildAuditEvent,
  StatusLinkConfig,
  StatusLinkProjectionKind,
  TrustFooterDeploymentMode,
} from '@recued/contracts';
import { buildReceptionPacket } from '../redacted-packet.js';
import { resolveReceptionTrustFooter } from './trust-footer.js';
import {
  buildStatusLinkPacketRawInput,
  buildStatusLinkSourceView,
  parseStatusLinkConfig,
} from '../transformations/status-link.js';
import {
  renderStatusLinkHtml,
  renderStatusLinkPlaceholderHtml,
  type StatusLinkRenderInput,
} from './status-link-render.js';
import type { ReceptionEndpointContext } from '../redacted-packet.js';
import type { ReceptionKindHandler } from './types.js';
import type { PublicEndpointRegistryStore } from '../../../storage/public-endpoint-registry-store.js';
import type { StatusProjectionStore } from '../../../storage/reception-status-projection-store.js';

const NOT_IMPLEMENTED_BODY = { error: { code: 'not_implemented' } } as const;

// ────────────────────────────────────────────────────────────────
// Source-entity reader dep
// ────────────────────────────────────────────────────────────────

/** Adapter the handler depends on to resolve the source entity row.
 *  Production bin.ts wires this to a `data.*` reader that walks the
 *  per-entity warehouse tables; tests pin a deterministic fixture. The
 *  contract is intentionally narrow: the reader returns the projected
 *  row already clipped to the projection's closed-list ceiling (or a
 *  superset that the substrate clamps belt-and-suspenders).
 *
 *  Return value:
 *    - `{ row, last_updated_at }` when the entity exists + is visible.
 *    - `null` when the entity is missing / deleted / outside the
 *      projection's permitted scope. The handler degrades to the
 *      placeholder page rather than emitting a 404 (fingerprint-free
 *      behavior matches the reception_page baseline). */
export interface StatusEntitySourceReader {
  read(input: {
    projection_kind: StatusLinkProjectionKind;
    source_entity_kind: string;
    source_entity_id: string;
  }): { readonly row: Readonly<Record<string, unknown>>; readonly last_updated_at: number } | null;
}

/** Substrate-level no-op reader — returns null for every read. Used by
 *  bin.ts as the placeholder before a warehouse reader is wired; the
 *  visitor flow degrades to the placeholder page. */
export const NULL_STATUS_ENTITY_SOURCE_READER: StatusEntitySourceReader = {
  read: () => null,
};

// ────────────────────────────────────────────────────────────────
// Response helpers
// ────────────────────────────────────────────────────────────────

const writeHtmlResponse = (res: ServerResponse, body: string, status = 200): void => {
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('content-length', String(Buffer.byteLength(body, 'utf8')));
  res.end(body);
};

const writeJsonResponse = (res: ServerResponse, body: unknown, status = 200): void => {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('content-length', String(Buffer.byteLength(payload, 'utf8')));
  res.end(payload);
};

// ────────────────────────────────────────────────────────────────
// Handler dependencies + factory
// ────────────────────────────────────────────────────────────────

export interface StatusLinkPacketHandlerDeps {
  readonly getStore: () => PublicEndpointRegistryStore;
  readonly getStatusProjectionStore: () => StatusProjectionStore;
  readonly getEntitySourceReader: () => StatusEntitySourceReader;
  readonly now: () => number;
  readonly emitAudit?: (event: RedactedPacketBuildAuditEvent) => string | undefined;
  /** D-149 P12 § A.20.7 — deployment mode for the Public Trust Footer.
   *  Boot-constant derived in `bin.ts` from the public base URL host
   *  (`isProDdnsHost`). Absent ⇒ the handler renders no trust footer.
   *  Only the HTML render carries the footer — the `?format=json`
   *  polling envelope is a closed structured shape and does not. */
  readonly receptionDeploymentMode?: TrustFooterDeploymentMode;
}

const isJsonRequest = (req: IncomingMessage): boolean => {
  const url = new URL(req.url ?? '/', 'http://x');
  const format = url.searchParams.get('format');
  if (format !== null) return format === 'json';
  const accept = req.headers['accept'];
  if (typeof accept !== 'string') return false;
  return accept.includes('application/json') && !accept.includes('text/html');
};

/** Closed-envelope JSON payload shape — visitor-facing. Mirrors the
 *  packet payload verbatim plus `endpoint_id` + `next_refresh_in_seconds`
 *  so a polling client can self-schedule without re-reading
 *  `refresh_policy`. NEVER carries the bearer / token / source ref. */
interface StatusLinkJsonEnvelope {
  readonly endpoint_id: string;
  readonly projection_kind: StatusLinkProjectionKind;
  readonly visible_fields: Readonly<Record<string, unknown>>;
  readonly last_updated_at_relative: string;
  readonly updates_visible: boolean;
  readonly comments_enabled: boolean;
  readonly next_refresh_in_seconds: number | null;
}

const buildJsonEnvelope = (input: {
  endpoint_id: string;
  packet_payload: {
    projection_kind: StatusLinkProjectionKind;
    visible_fields: Readonly<Record<string, unknown>>;
    last_updated_at_relative: string;
    updates_visible: boolean;
    comments_enabled: boolean;
  };
  next_refresh_in_seconds: number | null;
}): StatusLinkJsonEnvelope => ({
  endpoint_id: input.endpoint_id,
  projection_kind: input.packet_payload.projection_kind,
  visible_fields: input.packet_payload.visible_fields,
  last_updated_at_relative: input.packet_payload.last_updated_at_relative,
  updates_visible: input.packet_payload.updates_visible,
  comments_enabled: input.packet_payload.comments_enabled,
  next_refresh_in_seconds: input.next_refresh_in_seconds,
});

const refreshSecondsForConfig = (config: StatusLinkConfig): number | undefined => {
  if (!config.refresh_policy.auto_refresh_enabled) return undefined;
  const interval = config.refresh_policy.refresh_interval_seconds;
  return typeof interval === 'number' && Number.isFinite(interval) && interval > 0
    ? interval
    : undefined;
};

export const createStatusLinkPacketHandler = (
  deps: StatusLinkPacketHandlerDeps,
): ReceptionKindHandler => {
  return async (req: IncomingMessage, res: ServerResponse, endpoint: ReceptionEndpointContext) => {
    const endpoint_id = endpoint.endpoint_id;
    if (!endpoint_id) {
      writeHtmlResponse(res, renderStatusLinkPlaceholderHtml(), 503);
      return;
    }

    const row = deps.getStore().findById(endpoint_id);
    if (!row) {
      writeHtmlResponse(res, renderStatusLinkPlaceholderHtml(), 503);
      return;
    }
    const config = parseStatusLinkConfig(row.metadata);
    if (!config) {
      writeHtmlResponse(res, renderStatusLinkPlaceholderHtml(), 503);
      return;
    }

    const projection = deps.getStatusProjectionStore().findByEndpoint(endpoint_id);
    if (!projection) {
      // Substrate-side error — endpoint exists but no projection row
      // (substrate seeds the row at endpoint create; missing row is a
      // boot-state / migration anomaly). Degrade to placeholder.
      writeHtmlResponse(res, renderStatusLinkPlaceholderHtml(), 503);
      return;
    }

    const sourceRead = deps.getEntitySourceReader().read({
      projection_kind: projection.projection_kind,
      source_entity_kind: projection.source_entity_kind,
      source_entity_id: projection.source_entity_id,
    });
    if (!sourceRead) {
      // Entity missing / deleted / outside scope. Substrate degrades to
      // the placeholder (no fingerprint that distinguishes "moved" from
      // "never existed").
      writeHtmlResponse(res, renderStatusLinkPlaceholderHtml(), 503);
      return;
    }

    const now = deps.now();
    const sourceView = buildStatusLinkSourceView(
      config,
      sourceRead.row,
      sourceRead.last_updated_at,
      now,
    );
    const rawInput = buildStatusLinkPacketRawInput(sourceView);
    // The `buildReceptionPacket` wrapper already clamps to the 90d
    // reception ceiling (`RECEPTION_PACKET_MAX_TTL_MS`) — status_link's
    // 90d hard ceiling passes through without a per-call override.
    const built = buildReceptionPacket('status_link_packet', rawInput, endpoint, {
      now,
      randomToken: () => randomBytes(16).toString('hex'),
      ...(deps.emitAudit !== undefined ? { emitAudit: deps.emitAudit } : {}),
    });

    const refreshSeconds = refreshSecondsForConfig(config);

    if (isJsonRequest(req)) {
      const envelope = buildJsonEnvelope({
        endpoint_id,
        packet_payload: built.payload,
        next_refresh_in_seconds: refreshSeconds ?? null,
      });
      writeJsonResponse(res, envelope);
      return;
    }

    // D-149 P12 § A.20.7 — resolve the Public Trust Footer for the HTML
    // render (computed after the JSON early-return above so a polling
    // request doesn't pay the singleton read). Reads the per-server
    // toggle off the reception_page singleton.
    const trust_footer =
      deps.receptionDeploymentMode !== undefined
        ? resolveReceptionTrustFooter({
            store: deps.getStore(),
            deployment_mode: deps.receptionDeploymentMode,
          })
        : null;

    const renderInput: StatusLinkRenderInput = {
      display_name: config.display_name,
      projection_kind: built.payload.projection_kind,
      visible_fields: built.payload.visible_fields,
      last_updated_at_relative: built.payload.last_updated_at_relative,
      updates_visible: built.payload.updates_visible,
      comments_enabled: built.payload.comments_enabled,
      trust_footer,
      ...(config.caption !== undefined ? { caption: config.caption } : {}),
      ...(refreshSeconds !== undefined ? { refresh_interval_seconds: refreshSeconds } : {}),
    };

    writeHtmlResponse(res, renderStatusLinkHtml(renderInput));
  };
};

// ────────────────────────────────────────────────────────────────
// Default fallback (deps-absent stub)
// ────────────────────────────────────────────────────────────────

/** Substrate-compatible default handler — registered in
 *  `handlers/index.ts`. The dispatcher in `handler.ts` re-binds the
 *  handler with deps at boot; this default is the deps-absent fallback
 *  + preserves the substrate-wide 503 JSON contract the P2 stub
 *  shipped. */
export const handleStatusLinkPacket: ReceptionKindHandler = async (
  _req,
  res,
  _endpoint,
) => {
  res.statusCode = 503;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(NOT_IMPLEMENTED_BODY));
};
