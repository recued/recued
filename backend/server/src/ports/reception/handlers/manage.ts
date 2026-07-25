/** D-210 Appendix B — the `/reception/manage/<secret>` on-the-go reschedule page.
 *
 *  A dedicated public path OUTSIDE the six endpoint kinds (mirrors
 *  `/reception/claim`): the owner reschedules a booking from a link on their
 *  phone, no webclient login. The credential is single-use, short-TTL, scoped
 *  to ONE booking record; GET is non-consuming (mail scanners can't burn it),
 *  POST consumes. The move HOLDS for the owner's approval (approach A) —
 *  `manage.ts` renders the held page; the recipe (run by the injected runner)
 *  renders nothing.
 *
 *  🔑 The TARGET (calendar slug + event) is resolved SERVER-SIDE from the
 *  credential; only the new slot comes from the form. A link holder can move
 *  only the one event the credential names, and it holds for approval anyway.
 *
 *  Role boundary (I-12): this port handler imports no engine/recipe code — the
 *  reschedule runner is INJECTED (`deps.runReschedule`) exactly as the intake
 *  paired-run coordinator is.
 *
 *  Spec: docs/d-210-spec.md Appendix B. */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type {
  ReceptionAccessAction,
  ReceptionAccessOutcome,
  SchedulingLinkConfig,
} from '@recued/contracts';

import { buildReceptionPacket, type ReceptionEndpointContext } from '../redacted-packet.js';
import { verifyReceptionSameOrigin } from './same-origin.js';
import {
  parseSchedulingLinkConfig,
  buildSchedulingLinkPacketRawInput,
} from '../transformations/scheduling-link.js';
import {
  computeSchedulingLookAheadWindow,
  enumerateSchedulingSlots,
  intersectWithAvailabilityWindows,
} from '../transformations/scheduling-link-slots.js';
import {
  renderManageReschedulePage,
  renderManageResultHtml,
  type SchedulingSlot,
} from './scheduling-link-render.js';
import type { SchedulingCalendarEventsReader, SchedulingFormNonceStore } from './scheduling-link.js';
import {
  isReceptionManageSecret,
  type ReceptionManageCredentialStore,
  type ReceptionManageScope,
} from '../../../storage/reception-manage-credential-store.js';
import type { FormSubmissionSummary } from '../../../storage/reception-form-store.js';
import type { PublicEndpointRegistryStore } from '../../../storage/public-endpoint-registry-store.js';

export const RECEPTION_MANAGE_PATH = '/reception/manage' as const;
export const RECEPTION_MANAGE_ENDPOINT_ID = '__manage__' as const;

const MAX_BODY_BYTES = 16 * 1024;
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

/** The narrow reschedule-run seam (injected — the port cannot import the
 *  engine). Returns the held/completed/failed/no_door outcome.
 *
 *  ⚠ Moves the BOOKING since D-210 A.2 (slice 3b), not a calendar event —
 *  `calendar_slug` rides along only because the recipe config still names an
 *  instance for the non-reception reschedule paths. */
export type ReceptionManageRescheduleRun = (input: {
  readonly calendar_slug: string;
  readonly booking_id: string;
  readonly new_start_at: number;
  readonly new_end_at: number;
  readonly credential_id: string;
}) => Promise<{ readonly kind: 'held' | 'completed' | 'failed' | 'no_door' }>;

export interface ReceptionManageHandlerDeps {
  readonly getCredentialStore: () => ReceptionManageCredentialStore;
  /** Load the reservation row (server-side; carries `resolved_booking_id`
   *  + the slot duration). */
  readonly findBooking: (request_id: string) => FormSubmissionSummary | null;
  readonly getRegistryStore: () => PublicEndpointRegistryStore;
  readonly getCalendarReader: () => SchedulingCalendarEventsReader;
  readonly getFormNonceStore: () => SchedulingFormNonceStore;
  /** The calendar instance reception writes booking events to (`'local'`). */
  readonly calendarSlug: string;
  readonly runReschedule: ReceptionManageRescheduleRun;
  readonly now: () => number;
  readonly trustForwardedProto?: boolean;
}

/** What the handler tells the dispatcher for the access-log write — the same
 *  `{ action_taken, outcome }` shape the seller-claim surface returns, so a
 *  probe hammering invalid/expired manage links surfaces as `rejected` in the
 *  Abuse Inbox rather than hiding behind a fixed `view/ok`. */
export interface ReceptionManageHandlerResult {
  readonly action_taken: ReceptionAccessAction;
  readonly outcome: ReceptionAccessOutcome;
}

// ────────────────────────────────────────────────────────────────
// HTTP helpers (mirror seller-claim / ask-landing)
// ────────────────────────────────────────────────────────────────

const writeHtml = (res: ServerResponse, body: string, status: number): void => {
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store, max-age=0');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('content-length', String(Buffer.byteLength(body, 'utf8')));
  res.end(body);
};

const readBodyCapped = (
  req: IncomingMessage,
  cap: number,
): Promise<{ ok: true; body: string } | { ok: false }> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const done = (r: { ok: true; body: string } | { ok: false }): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > cap) {
        chunks.length = 0;
        done({ ok: false });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => done({ ok: true, body: Buffer.concat(chunks).toString('utf-8') }));
    req.on('error', () => done({ ok: false }));
    req.on('close', () => done({ ok: false }));
  });

/** `/reception/manage/<secret>` → the secret (query + fragment stripped). */
const parseSecretFromPath = (rawUrl: string | undefined): string | null => {
  const path = (rawUrl ?? '').split('?')[0]!.split('#')[0]!;
  if (!path.startsWith(`${RECEPTION_MANAGE_PATH}/`)) return null;
  const rest = path.slice(RECEPTION_MANAGE_PATH.length + 1).replace(/\/+$/, '');
  if (rest.length === 0 || rest.includes('/')) return null;
  try {
    return decodeURIComponent(rest);
  } catch {
    return null;
  }
};

const UNAVAILABLE = (): string =>
  renderManageResultHtml({
    display_name: '',
    tz_label: '',
    heading: 'Link unavailable',
    message: 'This reschedule link is invalid, expired, or has already been used. Ask for a new one.',
  });

// ────────────────────────────────────────────────────────────────
// Booking → target + slot enumeration (same math as the booking page)
// ────────────────────────────────────────────────────────────────

interface ResolvedManageTarget {
  readonly config: SchedulingLinkConfig;
  readonly booking_id: string;
  readonly duration_minutes: number;
  readonly current_slot_label: string;
}

/** Resolve a manage credential's reservation → the reschedule target + the
 *  config, or null when anything is missing (deleted reservation, a booking not
 *  yet materialized, corrupt config).
 *
 *  ⚠ The target is the BOOKING since A.2. `resolved_booking_id` null means the
 *  owner has not approved the reservation yet — there is no record to move, so
 *  the manage page correctly refuses rather than moving something else. */
const resolveTarget = (
  deps: ReceptionManageHandlerDeps,
  scope: ReceptionManageScope,
): ResolvedManageTarget | null => {
  const booking = deps.findBooking(scope.record_id);
  if (booking === null) return null;
  // D-210 A.8 slice 4b-ii — the two frozen `resolved_*` columns collapsed into
  // the generic pair, so "has it been approved into a booking yet" is now a
  // KIND check as well as a null check. ⛔ Both halves: a row resolved to some
  // other kind is not a reschedule target, and reading its id as a booking id
  // would move the wrong record.
  if (booking.resolved_target_kind !== 'booking' || booking.resolved_target_id === null) {
    return null;
  }
  // 🔴 The slot is NULLABLE on the merged table (null on every intake row), and
  // the arithmetic below silently yields a 1-MINUTE window on a null slot:
  // `null > 0` is false, so it falls through to `null - null === 0` and
  // `Math.max(1, 0)`. Refuse instead — a manage page offering to move a booking
  // to a 1-minute slot is worse than one that says the link is unavailable.
  if (booking.slot === null) return null;
  const row = deps.getRegistryStore().findById(scope.endpoint_id);
  if (!row) return null;
  const config = parseSchedulingLinkConfig(row.metadata);
  if (!config) return null;
  const duration_minutes =
    booking.slot.duration_minutes > 0
      ? booking.slot.duration_minutes
      : Math.max(1, Math.round((booking.slot.end_at - booking.slot.start_at) / 60000));
  const current_slot_label = formatSlotRange(
    booking.slot.start_at,
    booking.slot.end_at,
    config.available_window_definition.tz,
  );
  return {
    config,
    booking_id: booking.resolved_target_id,
    duration_minutes,
    current_slot_label,
  };
};

const formatSlotRange = (start_at: number, end_at: number, tz: string): string => {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    return `${fmt.format(new Date(start_at))} – ${new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(end_at))}`;
  } catch {
    return '';
  }
};

/** Enumerate the same-duration candidate slots — the SAME pipeline the booking
 *  GET uses (look-ahead → redacted free windows → availability intersect →
 *  slot enumeration), so the POST's membership check can trust the GET's set. */
const enumerateManageSlots = (
  deps: ReceptionManageHandlerDeps,
  config: SchedulingLinkConfig,
  duration_minutes: number,
): ReadonlyArray<SchedulingSlot> => {
  const now = deps.now();
  const { window_start, window_end } = computeSchedulingLookAheadWindow({ config, now });
  const calendarEvents = deps.getCalendarReader().list({ window_start, window_end });
  const endpointCtx: ReceptionEndpointContext = {
    endpoint_id: RECEPTION_MANAGE_ENDPOINT_ID,
    kind: 'scheduling_link_packet',
  };
  const built = buildReceptionPacket(
    'scheduling_link_packet',
    buildSchedulingLinkPacketRawInput({
      calendar_events: calendarEvents,
      window_start,
      window_end,
      tz: config.available_window_definition.tz,
      duration_options: config.duration_options_minutes,
      required_visitor_fields: config.required_visitor_fields,
      min_advance_notice_hours: config.min_advance_notice_hours,
      max_lead_time_days: config.max_lead_time_days,
    }),
    endpointCtx,
    { now, randomToken: () => randomUUID() },
  );
  const availabilityRestricted = intersectWithAvailabilityWindows({
    free_windows: built.payload.free_windows,
    explicit_windows: config.available_window_definition.explicit_windows ?? [],
    tz: built.payload.tz,
    window_start,
    window_end,
  });
  return enumerateSchedulingSlots({
    free_windows: availabilityRestricted,
    duration_minutes,
    tz: built.payload.tz,
    min_advance_notice_hours: built.payload.min_advance_notice_hours,
    max_lead_time_days: built.payload.max_lead_time_days,
    now,
  }).map((c) => ({
    start_at: c.start_at,
    end_at: c.end_at,
    duration_minutes: c.duration_minutes,
    display_label: c.display_label,
  }));
};

/** Parse the POST body → `{ slot, form_nonce }`, closed-list keys only. */
const parseManageBody = (
  raw: string,
): { form_nonce: string; slot: string } | null => {
  const params = new URLSearchParams(raw);
  let form_nonce: string | null = null;
  let slot: string | null = null;
  for (const [key, value] of params) {
    if (key === 'form_nonce') {
      if (form_nonce !== null) return null;
      form_nonce = value;
    } else if (key === 'slot') {
      if (slot !== null) return null;
      slot = value;
    } else {
      return null; // unknown key
    }
  }
  if (form_nonce === null || slot === null) return null;
  return { form_nonce, slot };
};

/** `start_at|end_at|duration_minutes` → parsed, and confirmed to be one of the
 *  server-enumerated candidates (defense against a crafted slot). */
const parsePickedSlot = (
  slot: string,
  candidates: ReadonlyArray<SchedulingSlot>,
): SchedulingSlot | null => {
  const parts = slot.split('|');
  if (parts.length !== 3) return null;
  const start_at = Number.parseInt(parts[0]!, 10);
  const end_at = Number.parseInt(parts[1]!, 10);
  if (!Number.isFinite(start_at) || !Number.isFinite(end_at)) return null;
  return (
    candidates.find((c) => c.start_at === start_at && c.end_at === end_at) ?? null
  );
};

// ────────────────────────────────────────────────────────────────
// Handler
// ────────────────────────────────────────────────────────────────

export const createReceptionManageHandler = (
  deps: ReceptionManageHandlerDeps,
): ((req: IncomingMessage, res: ServerResponse) => Promise<ReceptionManageHandlerResult>) => async (
  req,
  res,
) => {
  const method = req.method === 'POST' ? 'POST' : req.method === 'GET' ? 'GET' : null;
  if (method === null) {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, POST');
    res.setHeader('cache-control', 'no-store');
    res.end('method_not_allowed');
    return { action_taken: 'reject', outcome: 'rejected' };
  }

  const secret = parseSecretFromPath(req.url);
  if (secret === null || !isReceptionManageSecret(secret)) {
    writeHtml(res, UNAVAILABLE(), 404);
    return { action_taken: 'invalid_token', outcome: 'invalid_token' };
  }

  if (method === 'GET') {
    // GET is NON-consuming (mail scanners must not burn the credential).
    const resolved = deps.getCredentialStore().peek(secret, deps.now());
    if (resolved.status !== 'ok') {
      writeHtml(res, UNAVAILABLE(), 404);
      return resolved.status === 'expired'
        ? { action_taken: 'expired', outcome: 'expired' }
        : { action_taken: 'invalid_token', outcome: 'invalid_token' };
    }
    const target = resolveTarget(deps, resolved.scope);
    if (target === null) {
      writeHtml(res, UNAVAILABLE(), 404);
      return { action_taken: 'reject', outcome: 'rejected' };
    }
    const slots = enumerateManageSlots(deps, target.config, target.duration_minutes);
    const nonce = deps.getFormNonceStore().issue(RECEPTION_MANAGE_ENDPOINT_ID, deps.now());
    writeHtml(
      res,
      renderManageReschedulePage({
        display_name: target.config.display_name,
        tz_label: target.config.available_window_definition.tz,
        current_slot_label: target.current_slot_label,
        slots,
        post_action: `${RECEPTION_MANAGE_PATH}/${encodeURIComponent(secret)}`,
        form_nonce: nonce,
        ...(target.config.instructions !== undefined
          ? { instructions: target.config.instructions }
          : {}),
      }),
      200,
    );
    return { action_taken: 'view', outcome: 'ok' };
  }

  // POST — same-origin FIRST (cheap reject before the body).
  if (!verifyReceptionSameOrigin(req, deps.trustForwardedProto === true)) {
    res.statusCode = 403;
    res.setHeader('cache-control', 'no-store');
    res.end('forbidden');
    return { action_taken: 'reject', outcome: 'rejected' };
  }
  const contentType = req.headers['content-type'];
  const mediaType =
    typeof contentType === 'string' ? contentType.split(';', 1)[0]?.trim().toLowerCase() : null;
  if (mediaType !== FORM_CONTENT_TYPE) {
    writeHtml(res, UNAVAILABLE(), 415);
    return { action_taken: 'reject', outcome: 'rejected' };
  }
  const read = await readBodyCapped(req, MAX_BODY_BYTES);
  if (!read.ok) {
    res.statusCode = 413;
    res.setHeader('cache-control', 'no-store');
    res.setHeader('connection', 'close');
    res.end('payload_too_large');
    return { action_taken: 'reject', outcome: 'rejected' };
  }
  const parsed = parseManageBody(read.body);
  if (parsed === null) {
    writeHtml(res, UNAVAILABLE(), 400);
    return { action_taken: 'reject', outcome: 'rejected' };
  }
  // Consume the single-use form nonce (CSRF), then the credential (single-use).
  if (!deps.getFormNonceStore().consume(RECEPTION_MANAGE_ENDPOINT_ID, parsed.form_nonce, deps.now())) {
    res.statusCode = 403;
    res.setHeader('cache-control', 'no-store');
    res.end('forbidden');
    return { action_taken: 'reject', outcome: 'rejected' };
  }
  const consumed = deps.getCredentialStore().consume(secret, deps.now());
  if (consumed.status !== 'ok') {
    writeHtml(res, UNAVAILABLE(), 410);
    // A replay of a spent link vs a late click after expiry — both are a
    // rejected POST, but distinguish them so the Abuse Inbox can tell a
    // double-submit from a stale link.
    return consumed.status === 'expired'
      ? { action_taken: 'expired', outcome: 'expired' }
      : { action_taken: 'invalid_token', outcome: 'invalid_token' };
  }
  const target = resolveTarget(deps, consumed.scope);
  if (target === null) {
    writeHtml(res, UNAVAILABLE(), 404);
    return { action_taken: 'reject', outcome: 'rejected' };
  }
  const candidates = enumerateManageSlots(deps, target.config, target.duration_minutes);
  const picked = parsePickedSlot(parsed.slot, candidates);
  if (picked === null) {
    writeHtml(
      res,
      renderManageResultHtml({
        display_name: target.config.display_name,
        tz_label: target.config.available_window_definition.tz,
        heading: 'That time is no longer available',
        message: 'The slot you picked is not available. Please request a new link and try again.',
      }),
      409,
    );
    return { action_taken: 'submit', outcome: 'rejected' };
  }
  // New end preserves the booking's duration (picked.end_at already = start +
  // the duration the slots were enumerated for).
  const outcome = await deps.runReschedule({
    calendar_slug: deps.calendarSlug,
    booking_id: target.booking_id,
    new_start_at: picked.start_at,
    new_end_at: picked.end_at,
    credential_id: consumed.credential_id,
  });
  if (outcome.kind === 'held' || outcome.kind === 'completed') {
    writeHtml(
      res,
      renderManageResultHtml({
        display_name: target.config.display_name,
        tz_label: target.config.available_window_definition.tz,
        heading: 'Reschedule requested',
        message:
          'Your new time has been sent for approval. Once it is confirmed, the booking will move and the visitor will be notified.',
      }),
      200,
    );
    return { action_taken: 'submit', outcome: 'ok' };
  }
  // failed / no_door — the request was not accepted; tell them plainly.
  writeHtml(
    res,
    renderManageResultHtml({
      display_name: target.config.display_name,
      tz_label: target.config.available_window_definition.tz,
      heading: 'Couldn’t request the reschedule',
      message: 'Something went wrong and your request was not recorded. Please try again later.',
    }),
    500,
  );
  return { action_taken: 'submit', outcome: 'rejected' };
};
