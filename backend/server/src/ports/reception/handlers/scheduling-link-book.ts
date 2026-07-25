/** D-149 P5 § A.5.2 — `scheduling_link` POST /book handler.
 *
 *  Per § A.5.2 line 651-653:
 *
 *    Visitor selects a slot → fills required fields (form nonce + Origin
 *    header verified server-side per § Must Hold I-12b) → submits via
 *    POST to `/reception/scheduling/<endpoint_id>/book` (token re-presented
 *    + form nonce + matching Origin).
 *
 *    Reception handler validates submission → writes the reservation row →
 *    emits `public_endpoint_access_log` row + D-120 high-assurance signed audit
 *    `kind: 'form_submission.received'` (one per booking, NOT per request) →
 *    returns success page.
 *
 *  ⚠ **D-210 A.8 slice 4b-ii — that row is a `reception_form_submission` now**,
 *  not `reception_booking_request`. A booking is a submission whose destination
 *  was frozen into the schema (A.3), and with the calendar out of the booking
 *  path (A.2) the chain is submission → destination, so the sibling table lost
 *  its reason to exist. What makes the row a BOOKING is its clear slot; what it
 *  no longer has is a form definition. The five sealed visitor fields fold into
 *  one `submission_blob_encrypted` under the FORM key — see `booking-blob.ts`
 *  for why the key had to change with the table.
 *
 *  This handler runs AFTER the dispatcher has already:
 *    - Bound the per-IP rate limit
 *    - Verified the bearer token
 *    - Confirmed the registry row is enabled + non-revoked + non-expired
 *
 *  The handler's contract:
 *    1. Parse `application/x-www-form-urlencoded` body (closed-list field
 *       allowlist; reject any extra keys).
 *    2. Validate form nonce (single-use; bound to endpoint_id).
 *    3. Validate Origin header (per § Must Hold I-12b CSRF guard).
 *    4. Validate the submitted slot against re-enumerated candidates
 *       (defense in depth — visitor can't craft an arbitrary slot).
 *    5. Validate visitor-field requirements per config.
 *    6. Check per-day booking cap.
 *    7. Encrypt visitor PII with the reception sub-DEK + AAD binding.
 *    8. Insert a `reception_form_submission` row (with a slot — that is what
 *       makes it a booking; D-210 A.8 slice 4c dropped the separate table).
 *    9. Emit signed `form_submission.received` audit row.
 *   10. Return the success page.
 *
 *  Engine-side reactive trigger fires on the row insert; the engine
 *  path handles calendar event creation + the BOOKING entity minted
 *  beside it (D-210 slice 3 — this header said "commitment entity" for
 *  as long as nothing wrote one) + SI auto-confirm evaluation +
 *  notification dispatch. Substrate never blocks the visitor thread on
 *  engine work (§ Must Hold I-12).
 *
 *  Spec: docs/d-149-spec.md § A.5.2 + § Must Hold I-12 + I-12b. */

import { randomUUID } from 'node:crypto';
import { verifyReceptionSameOrigin } from './same-origin.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  validateSchedulingLinkBooking,
  type SchedulingLinkBookingInput,
  type SchedulingLinkConfig,
  type TrustFooterDeploymentMode,
  type VisitorReceiptFieldEcho,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import {
  computeSchedulingLookAheadWindow,
  enumerateSchedulingSlots,
  intersectWithAvailabilityWindows,
  isSlotAmongCandidates,
} from '../transformations/scheduling-link-slots.js';
import {
  buildSchedulingLinkPacketRawInput,
  parseSchedulingLinkConfig,
} from '../transformations/scheduling-link.js';
import { buildReceptionPacket } from '../redacted-packet.js';
import { sealBookingSubmissionBlob } from '../booking-blob.js';
import { sealFormSubmissionField } from '../form-pii.js';
import type { SchedulingFormNonceStore } from './scheduling-link.js';
import { DEFAULT_SCHEDULING_LINK_SUCCESS_MESSAGE } from './scheduling-link.js';
import {
  renderSchedulingLinkErrorHtml,
  renderSchedulingLinkSuccessHtml,
} from './scheduling-link-render.js';
import { resolveVisitorReceipt } from './visitor-receipt.js';
import type { ReceptionEndpointContext } from '../redacted-packet.js';
import type { SchedulingCalendarEventsReader } from './scheduling-link.js';
import type { PublicEndpointRegistryStore } from '../../../storage/public-endpoint-registry-store.js';
import type { FormSubmissionStore } from '../../../storage/reception-form-store.js';

const FALLBACK_TZ_LABEL = 'UTC' as const;

/** Max POST body bytes the handler accepts. Slot picker fields are
 *  small (≤ 2KB total); we cap conservatively to prevent DoS via a
 *  multi-megabyte body. */
const MAX_BODY_BYTES = 16 * 1024;

/** Hard cap on the per-endpoint booking submission rate beyond the
 *  configured `max_bookings_per_day`. The substrate defaults to no
 *  cap when the config sets `0`; otherwise the configured value
 *  applies per § A.5.2 line 683. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// ────────────────────────────────────────────────────────────────
// Response helpers
// ────────────────────────────────────────────────────────────────

const writeHtmlResponse = (
  res: ServerResponse,
  body: string,
  status: number,
): void => {
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  // Codex review fold (P2 #1, 2026-05-13) — see scheduling-link.ts;
  // POST /book + the success / error pages all live under the same
  // token-bearing URL space, so they share the strict policy.
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('content-length', String(Buffer.byteLength(body, 'utf8')));
  res.end(body);
};

const writeErrorPage = (
  res: ServerResponse,
  config: SchedulingLinkConfig | null,
  message: string,
  status: number,
): void => {
  const display_name = config?.display_name ?? 'this person';
  const tz_label = config?.available_window_definition.tz ?? FALLBACK_TZ_LABEL;
  writeHtmlResponse(
    res,
    renderSchedulingLinkErrorHtml({ display_name, tz_label, message }),
    status,
  );
};

// ────────────────────────────────────────────────────────────────
// Body parsing
// ────────────────────────────────────────────────────────────────

const readBody = async (req: IncomingMessage): Promise<string> => {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        aborted = true;
        reject(new Error('body_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => reject(err));
  });
};

/** Allowed form fields. Any other key triggers a 400. Closed-list
 *  defense — a future contract drift can't silently introduce a new
 *  surface. */
const ALLOWED_FORM_KEYS = new Set<string>([
  't',
  'form_nonce',
  'duration',
  'slot',
  'visitor_name',
  'visitor_email',
  'visitor_phone',
  'visitor_topic',
  'visitor_notes',
]);

const parseFormBody = (raw: string): Map<string, string> | { error: 'unknown_field' | 'malformed' } => {
  const out = new Map<string, string>();
  // URLSearchParams handles `+` ⇒ space + percent decoding.
  const params = new URLSearchParams(raw);
  for (const [key] of params) {
    if (!ALLOWED_FORM_KEYS.has(key)) {
      return { error: 'unknown_field' };
    }
  }
  for (const key of ALLOWED_FORM_KEYS) {
    const v = params.get(key);
    if (v !== null) out.set(key, v);
  }
  return out;
};

// ────────────────────────────────────────────────────────────────
// Origin verification
// ────────────────────────────────────────────────────────────────

const verifyOrigin = verifyReceptionSameOrigin;

// ────────────────────────────────────────────────────────────────
// Slot parse
// ────────────────────────────────────────────────────────────────

const parseSlotPipe = (
  raw: string,
): { start_at: number; end_at: number; duration_minutes: number } | null => {
  const [start, end, duration] = raw.split('|', 3);
  if (!start || !end || !duration) return null;
  const s = Number.parseInt(start, 10);
  const e = Number.parseInt(end, 10);
  const d = Number.parseInt(duration, 10);
  if (!Number.isFinite(s) || !Number.isFinite(e) || !Number.isFinite(d)) return null;
  return { start_at: s, end_at: e, duration_minutes: d };
};

// ────────────────────────────────────────────────────────────────
// Handler factory
// ────────────────────────────────────────────────────────────────

export interface SchedulingLinkBookHandlerDeps {
  readonly getStore: () => PublicEndpointRegistryStore;
  /** D-210 A.8 slice 4b-ii — the MERGED submission store. A booking is a
   *  `reception_form_submission` row with a slot; `reception_booking_request`
   *  has no writer after this slice (4c drops it). */
  readonly getSubmissionStore: () => Pick<
    FormSubmissionStore,
    'insertIfAvailable' | 'countWithinWindow'
  >;
  readonly getCalendarReader: () => SchedulingCalendarEventsReader;
  readonly getFormNonceStore: () => SchedulingFormNonceStore;
  /** D-210 A.8 slice 4b-ii — the FORM-submission PII key, not the booking one.
   *  See `booking-blob.ts`: the row's readers open with
   *  `openFormSubmissionField`, so it must be sealed with the key they use. */
  readonly getFormSubmissionPiiKey: () => Uint8Array;
  readonly auditLog: AuditLogStore;
  readonly now: () => number;
  /** D-149 § A.20.3 / § A.20.7 — deployment mode for the Public Trust
   *  Footer carried in the Visitor Receipt's `privacy_footer` slot.
   *  Absent ⇒ the receipt renders without a privacy footer (no trust
   *  footer at all when the substrate has no deployment mode wired). */
  readonly receptionDeploymentMode?: TrustFooterDeploymentMode;
}

export const createSchedulingLinkBookHandler = (
  deps: SchedulingLinkBookHandlerDeps,
): ((req: IncomingMessage, res: ServerResponse, endpoint: ReceptionEndpointContext) => Promise<void>) => {
  return async (req, res, endpoint) => {
    const endpoint_id = endpoint.endpoint_id;
    if (!endpoint_id) {
      writeErrorPage(res, null, 'Booking unavailable.', 503);
      return;
    }

    if (req.method !== 'POST') {
      // Should not happen given the dispatcher routes /book to this
      // handler only on POST; defense in depth.
      writeErrorPage(res, null, 'Method not allowed.', 405);
      return;
    }

    // Body parse
    let bodyRaw: string;
    try {
      bodyRaw = await readBody(req);
    } catch (err) {
      const message = err instanceof Error && err.message === 'body_too_large'
        ? 'Submission was too large.'
        : 'Submission could not be parsed.';
      writeErrorPage(res, null, message, 413);
      return;
    }

    const parsed = parseFormBody(bodyRaw);
    if (parsed instanceof Map) {
      // ok
    } else {
      writeErrorPage(res, null, 'Submission contained an unknown field.', 400);
      return;
    }
    const form = parsed;

    // Origin / Referer same-origin check
    if (!verifyOrigin(req)) {
      writeErrorPage(res, null, 'Submission blocked by origin policy.', 403);
      return;
    }

    // Load config
    const row = deps.getStore().findById(endpoint_id);
    if (!row) {
      writeErrorPage(res, null, 'Booking unavailable.', 503);
      return;
    }
    const config = parseSchedulingLinkConfig(row.metadata);
    if (!config) {
      writeErrorPage(res, null, 'Booking unavailable.', 503);
      return;
    }

    // Form-nonce single-use consume
    const formNonce = form.get('form_nonce') ?? '';
    if (
      formNonce.length === 0 ||
      !deps.getFormNonceStore().consume(endpoint_id, formNonce, deps.now())
    ) {
      writeErrorPage(
        res,
        config,
        'This booking form is stale. Please reload the page and try again.',
        400,
      );
      return;
    }

    // Slot parse
    const slotRaw = form.get('slot') ?? '';
    const slotParsed = parseSlotPipe(slotRaw);
    if (!slotParsed) {
      writeErrorPage(res, config, 'Please choose a valid slot.', 400);
      return;
    }

    // Re-enumerate slot candidates server-side + verify the visitor's
    // pick is among them. Defense in depth — the client could craft
    // a payload that bypasses the `<select>` (devtools / curl /
    // automated scraping); the substrate re-enumerates against the
    // current free-window snapshot at POST time + rejects mismatches.
    const now = deps.now();
    const { window_start, window_end } = computeSchedulingLookAheadWindow({ config, now });
    const calendarEvents = deps.getCalendarReader().list({ window_start, window_end });
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
    });
    // Codex review fold (P1 #1, 2026-05-13) — same availability-window
    // intersection as the GET handler; ensures POST re-enumeration is
    // identical to what the visitor saw on render.
    const availabilityRestricted = intersectWithAvailabilityWindows({
      free_windows: built.payload.free_windows,
      explicit_windows: config.available_window_definition.explicit_windows ?? [],
      tz: built.payload.tz,
      window_start,
      window_end,
    });
    const candidates = enumerateSchedulingSlots({
      free_windows: availabilityRestricted,
      duration_minutes: slotParsed.duration_minutes,
      tz: built.payload.tz,
      min_advance_notice_hours: built.payload.min_advance_notice_hours,
      max_lead_time_days: built.payload.max_lead_time_days,
      now,
    });
    if (
      !isSlotAmongCandidates({
        candidates,
        slot_start_at: slotParsed.start_at,
        slot_end_at: slotParsed.end_at,
        duration_minutes: slotParsed.duration_minutes,
      })
    ) {
      writeErrorPage(
        res,
        config,
        'That time is no longer available. Please pick another slot.',
        409,
      );
      return;
    }

    // NOTE (2026-07-16): an overlap refusal used to sit here — the Codex P1 #3
    // fold (2026-05-13) rejected any booking overlapping a non-rejected row, to
    // stop "a second visitor with a fresh form-nonce [claiming] the same slot
    // before the calendar reflects the first booking". That race is only a race
    // at CAPACITY 1, which the substrate was never entitled to assume: a
    // 100-table restaurant holds 100 bookings at the same time. The refusal is
    // gone. Concurrent bookings are admitted; how many is too many is the
    // OWNER's judgment, made at the D-157 gate against the overlap count on the
    // approval ask — exactly what D-173 D7 means by "confirmed at approval".
    // What still guards this handler: the slot-validity re-enumeration above
    // (a crafted slot is still refused) + `max_bookings_per_day` (an
    // owner-set VOLUME knob) + the pre-verify rate limiter at the listener.

    // Build booking input + validate per-config requirements.
    const input: SchedulingLinkBookingInput = {
      visitor_name: form.get('visitor_name') ?? '',
      ...(form.has('visitor_email') ? { visitor_email: form.get('visitor_email')! } : {}),
      ...(form.has('visitor_phone') ? { visitor_phone: form.get('visitor_phone')! } : {}),
      ...(form.has('visitor_topic') ? { visitor_topic: form.get('visitor_topic')! } : {}),
      ...(form.has('visitor_notes') ? { visitor_notes: form.get('visitor_notes')! } : {}),
      selected_slot_start_at: slotParsed.start_at,
      selected_slot_end_at: slotParsed.end_at,
      selected_duration_minutes: slotParsed.duration_minutes,
    };
    const validation = validateSchedulingLinkBooking(input, config, now);
    if (validation.length > 0) {
      writeErrorPage(
        res,
        config,
        validation[0]!.detail,
        400,
      );
      return;
    }

    // Per-day cap
    if (config.max_bookings_per_day > 0) {
      const count = deps.getSubmissionStore().countWithinWindow({
        endpoint_id,
        window_start_at: now - ONE_DAY_MS,
        now,
      });
      if (count >= config.max_bookings_per_day) {
        writeErrorPage(
          res,
          config,
          'This calendar has reached today’s booking limit. Please try again tomorrow.',
          429,
        );
        return;
      }
    }

    // D-210 A.8 slice 4b-ii — encrypt visitor PII into the merged table's TWO
    // ciphertexts, under the FORM-submission key.
    //
    // Through 4b-i this sealed five fields separately: four `visitor_*_
    // encrypted` columns plus `notes` stashed in `metadata_blob`, because
    // § A.5.2 never gave notes a column. The merged table has ONE
    // `submission_blob_encrypted`, so the five fold into it and the metadata
    // stash is gone with them.
    //
    // `visitor_email` KEEPS its own column — sealed twice, once in the blob and
    // once alone, exactly as intake does it. That is not redundancy for its own
    // sake: it lets the notification path decrypt ONLY the address without
    // unsealing the visitor's whole submission (§ A.5.3).
    const request_id = randomUUID();
    const key = deps.getFormSubmissionPiiKey();
    const [submission_blob_encrypted, visitor_email_encrypted] = await Promise.all([
      sealBookingSubmissionBlob({
        key,
        endpoint_id,
        submission_id: request_id,
        fields: {
          name: input.visitor_name,
          email: input.visitor_email,
          phone: input.visitor_phone,
          topic: input.visitor_topic,
          notes: input.visitor_notes,
        },
      }),
      sealFormSubmissionField({
        key,
        endpoint_id,
        submission_id: request_id,
        field: 'visitor_email',
        plaintext: input.visitor_email ?? null,
      }),
    ]);

    // Atomic re-check + insert (the per-day-cap pre-check above ran BEFORE the
    // async PII-seal, so two concurrent visitors can both pass it then both
    // insert — the seal's `await` yields the loop). The transaction re-checks
    // the cap inside the insert, closing the TOCTOU; the pre-check stays for
    // the friendly non-concurrent reject.
    //
    // ⚠ `form_definition_id: null` — a booking has no form definition, and a
    // sentinel would be a value two live equality checks collide on (4a).
    // `slot` present is what MAKES this row a booking: the store derives the
    // kind from it, and with it the outcome vocabulary this row may carry.
    const insertResult = deps.getSubmissionStore().insertIfAvailable({
      submission_id: request_id,
      endpoint_id,
      form_definition_id: null,
      submitted_at: now,
      source_ip_hash: null, // dispatcher already wrote the per-IP hash to the access log
      visitor_email_encrypted,
      submission_blob_encrypted,
      // Versions the stored ROW FORMAT, not the form — so a booking, which has
      // no form, still has one.
      schema_version: 1,
      processing_outcome: 'pending',
      slot: {
        start_at: input.selected_slot_start_at,
        end_at: input.selected_slot_end_at,
        duration_minutes: input.selected_duration_minutes,
      },
      max_bookings_per_day: config.max_bookings_per_day,
      day_window_start_at: now - ONE_DAY_MS,
      now,
    });
    if ('conflict' in insertResult) {
      // `day_cap` is the only conflict the store can return.
      writeErrorPage(
        res,
        config,
        'This calendar has reached today’s booking limit. Please try again tomorrow.',
        429,
      );
      return;
    }

    // Audit row — D-120 signed `form_submission.received` per § A.5.2
    // line 652 + § N.3 (one per booking).
    try {
      await deps.auditLog.logActivity({
        activity_id: `form_submission.received-${now}-${request_id}`,
        timestamp: now,
        action: 'form_submission.received',
        target: endpoint_id,
        detail: JSON.stringify({
          request_id,
          slot_start_at: input.selected_slot_start_at,
          slot_end_at: input.selected_slot_end_at,
          duration_minutes: input.selected_duration_minutes,
        }),
        reserve: true,
      });
    } catch {
      // Audit failure must not block the success page — the row is
      // already persisted. Operators see the failure in stderr; the
      // visitor sees a confirmed booking.
    }

    // Success page
    const successMessage =
      config.success_message && config.success_message.length > 0
        ? config.success_message
        : DEFAULT_SCHEDULING_LINK_SUCCESS_MESSAGE;
    // Reuse the slot-display label from the picker enumeration so the
    // visitor-facing copy is identical.
    const slotLabel = candidates.find(
      (c) =>
        c.start_at === input.selected_slot_start_at &&
        c.end_at === input.selected_slot_end_at &&
        c.duration_minutes === input.selected_duration_minutes,
    )?.display_label ?? `${new Date(input.selected_slot_start_at).toISOString()} (${input.selected_duration_minutes} min)`;

    // D-149 § A.20.3 — Visitor Receipt. Echoes the visitor-submitted
    // fields (verbatim — these are the visitor's own inputs) + the
    // booked slot; `null` when the endpoint's `visitor_receipt` config
    // is absent / disabled.
    const fieldsEcho: VisitorReceiptFieldEcho[] = [];
    if (input.visitor_name.length > 0) {
      fieldsEcho.push({ label: 'Name', value: input.visitor_name });
    }
    if (input.visitor_email) fieldsEcho.push({ label: 'Email', value: input.visitor_email });
    if (input.visitor_topic) fieldsEcho.push({ label: 'Topic', value: input.visitor_topic });
    if (input.visitor_phone) fieldsEcho.push({ label: 'Phone', value: input.visitor_phone });
    if (input.visitor_notes) fieldsEcho.push({ label: 'Notes', value: input.visitor_notes });
    fieldsEcho.push({ label: 'Time', value: slotLabel });
    const receipt = resolveVisitorReceipt({
      store: deps.getStore(),
      receptionDeploymentMode: deps.receptionDeploymentMode,
      config: config.visitor_receipt,
      reference_id: request_id,
      submitted_at: now,
      endpoint_kind: 'scheduling_link',
      fields_echo: fieldsEcho,
    });

    writeHtmlResponse(
      res,
      renderSchedulingLinkSuccessHtml({
        display_name: config.display_name,
        tz_label: built.payload.tz,
        success_message: successMessage,
        slot_display_label: slotLabel,
        receipt,
      }),
      200,
    );
  };
};
