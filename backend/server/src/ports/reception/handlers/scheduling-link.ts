/** D-149 P5 § A.5.2 — `scheduling_link` packet handler (GET).
 *
 *  Renders the visitor-facing slot picker. The pre-handler dispatcher
 *  in `handler.ts` already verified the bearer token, the per-IP rate
 *  limit, the post-verify daily cap, and that the cached registry row
 *  is enabled + non-revoked + non-expired. By the time this handler
 *  runs the request is authorized — the only work left is:
 *
 *    1. Parse the stored `SchedulingLinkConfig` blob.
 *    2. Resolve calendar busy events from `data.calendar.combined`.
 *    3. Compute free windows via the substrate's `computeFreeWindows`.
 *    4. Build the redacted packet (strict-pick + reshape).
 *    5. Enumerate slot candidates inside the free windows.
 *    6. Render the HTML.
 *
 *  Privacy contract (§ A.5.2 lines 628-644): the visitor sees free
 *  windows + slot duration options + visitor-field requirements +
 *  the configured tz. Never event titles / attendees / agendas / the
 *  calendar provider. The redacted packet substrate enforces the
 *  ceiling; this handler only consumes the redacted payload.
 *
 *  Spec: D-149 § A.5.2 + § Must Hold I-12. */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createBoundedNonceStore } from '../../../bounded-nonce-store.js';
import {
  computeFreeWindows,
  type AvailabilityRawCalendarEvent,
  type RedactedPacketBuildAuditEvent,
  type SchedulingLinkConfig,
  type TrustFooterDeploymentMode,
} from '@recued/contracts';
import { buildReceptionPacket } from '../redacted-packet.js';
import { resolveReceptionTrustFooter } from './trust-footer.js';
import {
  buildSchedulingLinkPacketRawInput,
  parseSchedulingLinkConfig,
} from '../transformations/scheduling-link.js';
import {
  computeSchedulingLookAheadWindow,
  enumerateSchedulingSlots,
  intersectWithAvailabilityWindows,
  type SchedulingSlotCandidate,
} from '../transformations/scheduling-link-slots.js';
import {
  renderSchedulingLinkErrorHtml,
  renderSchedulingLinkHtml,
  renderSchedulingLinkPlaceholderHtml,
  type SchedulingLinkRenderInput,
  type SchedulingSlot,
} from './scheduling-link-render.js';
import type { ReceptionEndpointContext } from '../redacted-packet.js';
import type { ReceptionKindHandler } from './types.js';
import type { PublicEndpointRegistryStore } from '../../../storage/public-endpoint-registry-store.js';

const FALLBACK_TZ_LABEL = 'UTC' as const;

/** Default success message; falls back when the config omits one. */
export const DEFAULT_SCHEDULING_LINK_SUCCESS_MESSAGE =
  "Your booking has been received. You'll receive a confirmation soon." as const;

const writeHtmlResponse = (res: ServerResponse, body: string, status = 200): void => {
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  // Codex review fold (P2 #1, 2026-05-13) — scheduling URLs carry the
  // bearer in `?t=`; `same-origin` Referrer-Policy still leaks the full
  // URL (token included) to same-origin asset fetches (stylesheet,
  // favicon) + proxy logs. `no-referrer` strips the Referer header
  // entirely so the bearer never traverses HTTP intermediaries.
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('content-length', String(Buffer.byteLength(body, 'utf8')));
  res.end(body);
};

// ────────────────────────────────────────────────────────────────
// Form-nonce store (in-memory, per-process)
// ────────────────────────────────────────────────────────────────

/** Per-issued form-nonce stamp. The POST /book handler consumes
 *  these once + cross-checks against the registry. Backed by the shared
 *  bounded store (`bounded-nonce-store.ts`), which keys on the nonce itself
 *  and compares `endpoint_id` as a value — so a scope containing the old
 *  `|` delimiter cannot collide with another. */
export interface SchedulingFormNonceStore {
  /** Issue a fresh nonce + return the encoded form-nonce. */
  issue(endpoint_id: string, now: number): string;
  /** Consume a nonce — returns `true` on a single-use match within the
   *  TTL, `false` otherwise. Single-use semantics per § Must Hold
   *  I-12b form-CSRF guard. */
  consume(endpoint_id: string, nonce: string, now: number): boolean;
}

/** Default TTL — visitors have 30 minutes to submit the booking after
 *  loading the page. */
export const SCHEDULING_FORM_NONCE_TTL_MS = 30 * 60 * 1000;


/** ⚠ NO `maxPerScope`: the scope is `endpoint_id`, shared by every concurrent
 *  visitor to that booking page. A per-scope cap here would let the Nth visitor
 *  evict the first visitor's nonce. See `bounded-nonce-store.ts`. */
export const createInMemorySchedulingFormNonceStore = (): SchedulingFormNonceStore => {
  const store = createBoundedNonceStore<null>({
    ttlMs: SCHEDULING_FORM_NONCE_TTL_MS,
  });
  return {
    issue: (endpoint_id, now) => store.issue(endpoint_id, now, null),
    consume: (endpoint_id, nonce, now) =>
      store.consume(endpoint_id, nonce, now) !== null,
  };
};

// ────────────────────────────────────────────────────────────────
// Calendar-event source dep
// ────────────────────────────────────────────────────────────────

/** Adapter the handler depends on to load calendar busy/free events.
 *  Production bin.ts wires this to a `data.calendar.combined` reader
 *  that walks every `collection_calendar_*` table; tests pin a
 *  deterministic fixture. The contract is intentionally narrow: only
 *  `{start_at, end_at}` tuples — titles / attendees / notes are
 *  dropped at the adapter boundary so they can never reach the
 *  visitor-facing path. */
export interface SchedulingCalendarEventsReader {
  /** Return all events overlapping `[window_start, window_end)`. The
   *  caller has already enforced its lead-time + advance-notice
   *  bounds; this fn just returns the raw intervals. */
  list(input: {
    window_start: number;
    window_end: number;
  }): ReadonlyArray<AvailabilityRawCalendarEvent>;
}

/** Substrate-level no-op reader — returns the empty set. Used by tests
 *  that don't exercise the calendar branch + as the bin.ts placeholder
 *  before the calendar adapter is wired. */
export const NULL_SCHEDULING_CALENDAR_EVENTS_READER: SchedulingCalendarEventsReader = {
  list: () => [],
};

// ────────────────────────────────────────────────────────────────
// Handler dependencies
// ────────────────────────────────────────────────────────────────

export interface SchedulingLinkHandlerDeps {
  readonly getStore: () => PublicEndpointRegistryStore;
  readonly getCalendarReader: () => SchedulingCalendarEventsReader;
  readonly getFormNonceStore: () => SchedulingFormNonceStore;
  readonly now: () => number;
  /** Optional D-120 audit emit seam for `redacted_packet.built` events.
   *  The dispatcher's main path emits a per-request operational log
   *  entry separately; this seam fires only for packet-build telemetry
   *  per § Must Hold I-6. */
  readonly emitAudit?: (event: RedactedPacketBuildAuditEvent) => string | undefined;
  /** D-149 P12 § A.20.7 — deployment mode for the Public Trust Footer.
   *  Boot-constant derived in `bin.ts` from the public base URL host
   *  (`isProDdnsHost`). Absent ⇒ the handler renders no trust footer. */
  readonly receptionDeploymentMode?: TrustFooterDeploymentMode;
}

// ────────────────────────────────────────────────────────────────
// Slot conversion (candidates → renderer slots)
// ────────────────────────────────────────────────────────────────

const slotsForRender = (candidates: ReadonlyArray<SchedulingSlotCandidate>): ReadonlyArray<SchedulingSlot> =>
  candidates.map((c) => ({
    start_at: c.start_at,
    end_at: c.end_at,
    duration_minutes: c.duration_minutes,
    display_label: c.display_label,
  }));

// ────────────────────────────────────────────────────────────────
// Handler factory
// ────────────────────────────────────────────────────────────────

/** Parse the GET request's `?duration=` query — defaults to the first
 *  config option when omitted; clamps to a configured option. Pure
 *  query-string read; no header introspection. */
const parseRequestedDuration = (req: IncomingMessage, config: SchedulingLinkConfig): number => {
  const url = new URL(req.url ?? '/', 'http://x');
  const raw = url.searchParams.get('duration');
  if (raw !== null) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && config.duration_options_minutes.includes(n)) {
      return n;
    }
  }
  return config.duration_options_minutes[0]!;
};

const extractBearer = (req: IncomingMessage): string => {
  const url = new URL(req.url ?? '/', 'http://x');
  const q = url.searchParams.get('t');
  if (q && q.length > 0) return q;
  const headerToken = req.headers['x-recued-endpoint-token'];
  if (typeof headerToken === 'string' && headerToken.length > 0) return headerToken;
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }
  return '';
};

export const createSchedulingLinkPacketHandler = (
  deps: SchedulingLinkHandlerDeps,
): ReceptionKindHandler => {
  return async (req: IncomingMessage, res: ServerResponse, endpoint: ReceptionEndpointContext) => {
    const endpoint_id = endpoint.endpoint_id;
    if (!endpoint_id) {
      writeHtmlResponse(res, renderSchedulingLinkPlaceholderHtml(FALLBACK_TZ_LABEL), 503);
      return;
    }

    // Load the registry row's metadata → SchedulingLinkConfig.
    const row = deps.getStore().findById(endpoint_id);
    if (!row) {
      writeHtmlResponse(res, renderSchedulingLinkPlaceholderHtml(FALLBACK_TZ_LABEL), 503);
      return;
    }
    const config = parseSchedulingLinkConfig(row.metadata);
    if (!config) {
      // Corrupt config — render the placeholder rather than 500ing.
      // Same no-fingerprint baseline as the reception_page kind.
      writeHtmlResponse(res, renderSchedulingLinkPlaceholderHtml(FALLBACK_TZ_LABEL), 503);
      return;
    }

    const now = deps.now();
    const { window_start, window_end } = computeSchedulingLookAheadWindow({ config, now });

    // Calendar events → free windows. Reader returns event-free
    // intervals only (titles / attendees / notes never inputs).
    const calendarEvents = deps.getCalendarReader().list({ window_start, window_end });

    // Build the redacted packet — substrate computes free_windows +
    // drops the raw events at the boundary.
    const rawInput = buildSchedulingLinkPacketRawInput({
      calendar_events: calendarEvents,
      window_start,
      window_end,
      tz: config.available_window_definition.tz,
      duration_options: config.duration_options_minutes,
      required_visitor_fields: config.required_visitor_fields,
      min_advance_notice_hours: config.min_advance_notice_hours,
      max_lead_time_days: config.max_lead_time_days,
    });
    const built = buildReceptionPacket('scheduling_link_packet', rawInput, endpoint, {
      now,
      randomToken: () => randomUUID(),
      ...(deps.emitAudit !== undefined ? { emitAudit: deps.emitAudit } : {}),
    });

    // Codex review fold (P1 #1, 2026-05-13) — intersect free_windows
    // with the configured `explicit_windows` BEFORE enumerating slots.
    // Pre-fold the substrate emitted "any unbusy time in the look-ahead",
    // ignoring the user's "Mon 9-5" availability declaration. Standing
    // Instructions evaluation stays engine-side (§ A.5.2 line 654).
    const availabilityRestricted = intersectWithAvailabilityWindows({
      free_windows: built.payload.free_windows,
      explicit_windows: config.available_window_definition.explicit_windows ?? [],
      tz: built.payload.tz,
      window_start,
      window_end,
    });

    // Compute slot candidates inside the availability-restricted
    // windows for the active duration (default = first config option;
    // visitor-changeable via ?duration= roundtrip).
    const activeDuration = parseRequestedDuration(req, config);
    const candidates = enumerateSchedulingSlots({
      free_windows: availabilityRestricted,
      duration_minutes: activeDuration,
      tz: built.payload.tz,
      min_advance_notice_hours: built.payload.min_advance_notice_hours,
      max_lead_time_days: built.payload.max_lead_time_days,
      now,
    });

    // Issue a per-render form nonce — POST /book consumes it once.
    const nonce = deps.getFormNonceStore().issue(endpoint_id, now);

    // Defense in depth — substrate-side rejects any computed free window
    // that's misshapen (zero-length / negative bound / overlap with raw
    // events). `enumerateSchedulingSlots` clamps to the window bounds,
    // so the render path can rely on the candidate set being safe to
    // emit verbatim.

    // Re-extract bearer for the form's hidden field — already verified
    // by the dispatcher; this surfaces it back into the rendered page so
    // the POST /book request carries the token.
    const bearer = extractBearer(req);

    // D-149 P12 § A.20.7 — resolve the Public Trust Footer (reads the
    // per-server toggle off the reception_page singleton).
    const trust_footer =
      deps.receptionDeploymentMode !== undefined
        ? resolveReceptionTrustFooter({
            store: deps.getStore(),
            deployment_mode: deps.receptionDeploymentMode,
          })
        : null;

    const renderInput: SchedulingLinkRenderInput = {
      display_name: config.display_name,
      tz_label: built.payload.tz,
      free_windows: built.payload.free_windows,
      duration_options: built.payload.duration_options,
      slots: slotsForRender(candidates),
      required_visitor_fields: built.payload.required_visitor_fields,
      min_advance_notice_hours: built.payload.min_advance_notice_hours,
      max_lead_time_days: built.payload.max_lead_time_days,
      endpoint_id,
      bearer_secret: bearer,
      form_nonce: nonce,
      active_duration_minutes: activeDuration,
      trust_footer,
      ...(config.instructions !== undefined ? { instructions: config.instructions } : {}),
    };
    writeHtmlResponse(res, renderSchedulingLinkHtml(renderInput));
  };
};

/** Substrate-compatible default handler — registered in
 *  `handlers/index.ts`. The dispatcher in `handler.ts` re-binds the
 *  handler with deps at boot; this default is the deps-absent fallback
 *  and preserves the substrate-wide 503 JSON contract the P2 stub
 *  ships. The live HTML placeholder is reserved for the deps-bound
 *  path inside `createSchedulingLinkPacketHandler` so the bare
 *  registry entry stays fingerprint-free per § Must Hold I-1. */
export const handleSchedulingLinkPacket: ReceptionKindHandler = async (
  _req,
  res,
  _endpoint,
) => {
  res.statusCode = 503;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: { code: 'not_implemented' } }));
};

/** Export the error-page renderer so the POST /book handler can reuse it. */
export { renderSchedulingLinkErrorHtml };
