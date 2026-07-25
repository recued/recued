/** D-149 P5 § A.5.2 — `scheduling_link` per-endpoint config contract.
 *
 *  Each `scheduling_link` endpoint stores a `SchedulingLinkConfig` blob
 *  inside the `public_endpoint_registry.metadata_blob` column. The
 *  reception handler reads the blob at request time + builds the
 *  visitor-facing slot picker; the rpc admin layer writes the blob via
 *  `reception.endpoint.create` (the same path the other link-style
 *  kinds use).
 *
 *  Validators in this file:
 *
 *    - Closed-shape gate on every field (defense in depth at the rpc
 *      edge before the registry write).
 *    - `duration_options_minutes` ⊆ closed list per spec
 *      § A.5.2 line 599-600 (e.g. `[15, 30, 60]`).
 *    - `available_window_definition` requires *either* a
 *      `standing_instructions_ref` *or* a non-empty `explicit_windows[]`
 *      (XOR semantics; the spec at line 600-608 allows both — the
 *      runtime prefers the SI ref + falls back to `explicit_windows`
 *      when SI is absent).
 *    - `tz` is an IANA tz identifier; substrate gate is a syntactic
 *      length / charset check (spec § A.5.2 does not name a strict
 *      Intl.DateTimeFormat probe — that lives at runtime).
 *    - `min_advance_notice_hours` / `max_lead_time_days` / `max_bookings_
 *      per_day` carry per-field numeric bounds.
 *    - `on_booking.notify_visitor_sender`, when present, is a bounded non-empty
 *      send-capable mail-instance id used by approval-time notification.
 *    - `display_name` / `instructions` / `success_message` length bounds
 *      so the rendered HTML stays compact + the no-leak surface stays
 *      bounded.
 *
 *  Privacy contract (§ A.5.2 lines 628-644):
 *
 *    - The redacted packet exposes ONLY computed free windows + slot
 *      duration options + the tz label + visitor field requirements +
 *      advance / lead-time caps.
 *    - It NEVER exposes calendar event titles / attendees / agendas /
 *      tentative-vs-confirmed status / calendar provider.
 *
 *  The substrate enforces the privacy contract via the closed-shape
 *  `RedactedPacketPayloadByKind['scheduling_link_packet']` map in
 *  `redacted-packets.ts`; this config file gates the *config blob* shape
 *  at admin-write time so a corrupt config never reaches the visitor
 *  path.
 *
 *  Spec: D-149 § A.5.2 + § Must Hold I-1 + § A.11 (TR-4
 *  + TR-8). */

import {
  type SchedulingLinkVisitorFieldRequirement,
  type SchedulingLinkVisitorFieldRequirements,
} from './redacted-packets.js';
import {
  validateVisitorReceiptConfig,
  type VisitorReceiptConfig,
} from './visitor-receipt-config.js';

// ────────────────────────────────────────────────────────────────
// Closed-list bound constants
// ────────────────────────────────────────────────────────────────

/** Spec § A.5.2 line 599-600 — duration option closed list. The
 *  visitor's slot picker offers ONE pre-built dropdown sourced from
 *  this set; arbitrary integer minutes would let an attacker probe
 *  free/busy by minute (1-minute granularity is a privacy leak vector
 *  TR-2 calls out). Bound the set so the visitor-side selector is
 *  predictable + the slot-window math stays cheap. */
export const SCHEDULING_LINK_DURATION_OPTION_MINUTES_ALLOWED: ReadonlyArray<number> = [
  15,
  30,
  45,
  60,
  90,
  120,
] as const;

export const SCHEDULING_LINK_DURATION_OPTION_MINUTES_SET: ReadonlySet<number> = new Set(
  SCHEDULING_LINK_DURATION_OPTION_MINUTES_ALLOWED,
);

/** Spec § A.5.2 line 616 — default 24h advance notice. Bound the lower
 *  edge to 0 (same-day bookings opt-in) + the upper edge to two weeks
 *  (336h) so the renderer doesn't have to special-case a multi-day
 *  notice copy. */
export const SCHEDULING_LINK_MIN_ADVANCE_NOTICE_HOURS_MAX = 336;
/** Spec § A.5.2 line 617 — default 30d lead-time cap. The substrate
 *  ceiling matches the `RECEPTION_PER_KIND_EXPIRY_MAX_MS` philosophy:
 *  no link can expose more than 365d worth of calendar busy/free since
 *  the privacy attack surface scales linearly with the look-ahead. */
export const SCHEDULING_LINK_MAX_LEAD_TIME_DAYS_MAX = 365;
/** Spec § A.5.2 line 683 — per-day booking cap. Defaults to no cap
 *  (the visitor-facing layer omits the limit hint); when the user
 *  sets a value the substrate gates per-endpoint per-day post-verify. */
export const SCHEDULING_LINK_MAX_BOOKINGS_PER_DAY_MAX = 1000;

/** Visitor-typed field length caps. Match the closed-list patterns
 *  in `intake_form` substrate; bound so a single booking submission
 *  can't bloat the SQLite row + the renderer's success page stays
 *  predictable. */
export const SCHEDULING_LINK_DISPLAY_NAME_MAX = 100;
export const SCHEDULING_LINK_INSTRUCTIONS_MAX = 800;
export const SCHEDULING_LINK_SUCCESS_MESSAGE_MAX = 400;
export const SCHEDULING_LINK_TZ_MAX = 64;
export const SCHEDULING_LINK_NOTIFY_VISITOR_SENDER_MAX = 200;

/** Visitor-side field caps applied at POST `/book` parse. Each field
 *  is sub_dek-encrypted at rest; the cap is what the renderer's
 *  `<input maxlength=…>` advertises + what the handler enforces
 *  server-side. */
export const SCHEDULING_LINK_VISITOR_NAME_MAX = 200;
export const SCHEDULING_LINK_VISITOR_EMAIL_MAX = 254;
export const SCHEDULING_LINK_VISITOR_PHONE_MAX = 64;
export const SCHEDULING_LINK_VISITOR_TOPIC_MAX = 200;
export const SCHEDULING_LINK_VISITOR_NOTES_MAX = 2000;

// ────────────────────────────────────────────────────────────────
// Window definition shape
// ────────────────────────────────────────────────────────────────

/** Spec § A.5.2 line 600-608 — per-link explicit window. Day-of-week
 *  + minute-of-day bounds; visitor-side rendering converts to the
 *  visitor's local tz client-side at slot-picker render time. */
export interface SchedulingLinkExplicitWindow {
  /** 0-6 (Sun..Sat). */
  readonly day_of_week: number;
  /** Minutes from midnight in `tz`. 0..1439. */
  readonly start_minute: number;
  /** Minutes from midnight in `tz`. 0..1440 (1440 = end-of-day). */
  readonly end_minute: number;
}

/** Spec § A.5.2 line 601-608 — recurring availability declaration. The
 *  config carries EITHER a Standing Instructions ref (D-145 PB10 row;
 *  evaluated at engine-side reactive trigger time) OR a list of
 *  explicit windows (rendered directly into the slot picker). When
 *  both are present the substrate prefers `standing_instructions_ref`
 *  + ignores `explicit_windows`.
 *
 *  P5 substrate validates the shape but the engine-side SI evaluation
 *  lives downstream (Standing Instructions are consulted at the
 *  reactive-engine path, per spec § A.5.2 line 654 — never at the
 *  visitor-thread request path). */
export interface SchedulingLinkAvailableWindowDefinition {
  readonly standing_instructions_ref?: string;
  readonly explicit_windows?: ReadonlyArray<SchedulingLinkExplicitWindow>;
  /** IANA tz identifier (e.g. `'America/New_York'`). Required — the
   *  validator hard-fails on missing tz; the slot picker emits both
   *  the configured tz + the visitor's auto-detected tz client-side. */
  readonly tz: string;
}

// ────────────────────────────────────────────────────────────────
// On-booking config + per-link config
// ────────────────────────────────────────────────────────────────

/** Approval-time booking behavior. The scheduling drain mints the canonical
 *  `data.booking`; an optional sender lets the owner send the visitor's
 *  confirmation as part of that same fail-closed approval operation. */
export interface SchedulingLinkOnBookingConfig {
  /** @deprecated Compatibility-only. The booking row is canonical and this
   *  flag is ignored; new authoring and templates do not emit it. */
  readonly create_calendar_event?: boolean;
  /** @deprecated Compatibility-only. The booking row is canonical and this
   *  flag is ignored; new authoring and templates do not emit it. */
  readonly create_commitment_entity?: boolean;
  /** D-210 A.8 slice 3d — the send-capable `data.mail.<name>` the visitor
   *  confirmation is sent FROM when the owner ticks `notify_visitor` at the
   *  approval gate. The owner's own sender, never visitor PII.
   *
   *  🔑 OPTIONAL, unlike the two booleans above, and deliberately so: it is
   *  added after three config templates already shipped, and a required field
   *  would fail validation on every one of them. Absent means the owner has
   *  not designated a sender — the toggle then REFUSES at approve time rather
   *  than minting a booking and swallowing the send, because a notification
   *  the owner asked for and did not get is worse than one they were told
   *  they could not send.
   *
   *  ⛔ Not a channel selector. WHICH channels exist is the D-158 block's
   *  business; this names one mail account, matching the seller path's
   *  `sender_mail_instance_id`. */
  readonly notify_visitor_sender?: string;
  /** Where to send the booking-received notification. */
  // D-210 Phase C — `notification_target` RETIRED (owner ruling, 2026-07-18).
  // It was a per-endpoint copy of the D-158 notification-channel vocabulary
  // (`webclient`/`mail` where the block says `ui`/`email`, slack+telegram
  // hardcoded instead of spliced from `MESSENGER_VENDOR_SLUGS`) — a second
  // closed list that could only drift from the first. Its own doc admitted it
  // never dispatched: "the substrate here only persists Mary's stated intent."
  //
  // Replaced by two things that already exist: the D-158 block owns WHICH
  // channels are enabled, and Phase C's `inbox_fanout_mode` owns WHICH SURFACE
  // a held item reaches (actionable ask vs passive notify). Per-endpoint
  // routing, if ever wanted, belongs on the block's channel selector — not a
  // parallel vocabulary. The validator REFUSES a stale key.
}

/** Singleton-config blob persisted in the registry row's `metadata_blob`.
 *  Read at every page render + POST /book; write only via
 *  `reception.endpoint.create` / future update rpcs. */
export interface SchedulingLinkConfig {
  /** Visitor-facing display name on the slot picker (typically the
   *  user's first name or handle). Length-bounded so the renderer's
   *  `<title>` + `<h1>` stay compact + the HTML payload is small. */
  readonly display_name: string;
  /** Optional visitor-facing instructions paragraph (rendered above
   *  the slot picker; htmlEscape'd). */
  readonly instructions?: string;
  /** Optional confirmation-page copy. Defaults to the substrate's
   *  generic "Booking received" if absent. */
  readonly success_message?: string;
  /** Slot duration options. ⊆ SCHEDULING_LINK_DURATION_OPTION_MINUTES_ALLOWED. */
  readonly duration_options_minutes: ReadonlyArray<number>;
  /** Window definition — driven by Standing Instructions OR explicit. */
  readonly available_window_definition: SchedulingLinkAvailableWindowDefinition;
  /** Per-field visitor input requirements (rebuilt from closed shape
   *  at packet build time per `redacted-packets.ts`). */
  readonly required_visitor_fields: SchedulingLinkVisitorFieldRequirements;
  /** Minimum hours between now and the earliest selectable slot. */
  readonly min_advance_notice_hours: number;
  /** Maximum days into the future the slot picker exposes. */
  readonly max_lead_time_days: number;
  /** Per-day booking cap (0 = no cap). */
  readonly max_bookings_per_day: number;
  /** Actions to fire on successful booking. */
  readonly on_booking: SchedulingLinkOnBookingConfig;
  /** D-149 § A.20.3 — optional per-endpoint visitor-receipt config.
   *  Absent ⇒ receipts disabled (opt-in). When `enabled`, the POST
   *  /book handler renders a receipt (reference id + field echo +
   *  privacy footer) on the booking success page. */
  readonly visitor_receipt?: VisitorReceiptConfig;
}

// ────────────────────────────────────────────────────────────────
// Validator
// ────────────────────────────────────────────────────────────────

export type SchedulingLinkConfigValidationCode =
  | 'display_name_empty'
  | 'display_name_too_long'
  | 'instructions_too_long'
  | 'success_message_too_long'
  | 'tz_empty'
  | 'tz_too_long'
  | 'duration_options_empty'
  | 'duration_option_invalid'
  | 'duration_option_too_many'
  | 'window_definition_empty'
  | 'explicit_window_invalid'
  | 'visitor_fields_invalid'
  | 'min_advance_notice_out_of_range'
  | 'max_lead_time_out_of_range'
  | 'max_bookings_per_day_out_of_range'
  | 'notification_target_unknown'
  | 'on_booking_flag_invalid'
  | 'auto_confirm_ref_invalid'
  | 'standing_instructions_ref_invalid'
  | 'visitor_receipt_invalid'
  | 'config_shape_invalid';

export interface SchedulingLinkConfigValidationFailure {
  readonly code: SchedulingLinkConfigValidationCode;
  readonly detail: string;
}

/** Maximum duration options surfaced to a visitor. Beyond this the
 *  slot picker becomes unwieldy + the privacy attack surface grows
 *  (more options = more visibility into busy/free at varied
 *  granularities). */
const SCHEDULING_LINK_DURATION_OPTIONS_MAX_COUNT = 4;

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0;

const isFiniteIntegerInRange = (
  v: unknown,
  min: number,
  max: number,
): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

const isExplicitWindow = (v: unknown): v is SchedulingLinkExplicitWindow => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    isFiniteIntegerInRange(r.day_of_week, 0, 6) &&
    isFiniteIntegerInRange(r.start_minute, 0, 1440) &&
    isFiniteIntegerInRange(r.end_minute, 0, 1440) &&
    (r.start_minute as number) < (r.end_minute as number)
  );
};

/** Codex review fold (P2 #2, 2026-05-13) — per-field allowed value
 *  set, mirroring `SCHEDULING_LINK_PER_FIELD_ALLOWED` in
 *  `redacted-packets.ts`. Spec § A.5.2 line 609-615 declares phone/
 *  notes as `'optional' | 'omit'` ONLY; pre-fold the substrate
 *  validator accepted `'required'` for these fields (the broader
 *  `SchedulingLinkVisitorFieldRequirement` union) but the booking
 *  validator never enforced presence, so a misconfigured link could
 *  render a required phone/notes field that a curl submission could
 *  bypass. Closing the per-field allowlist at config-validate time
 *  rejects the malformed config before it reaches the store. */
const SCHEDULING_LINK_CONFIG_PER_FIELD_ALLOWED: Readonly<
  Record<keyof SchedulingLinkVisitorFieldRequirements, ReadonlySet<SchedulingLinkVisitorFieldRequirement>>
> = {
  name: new Set<SchedulingLinkVisitorFieldRequirement>(['required']),
  email: new Set<SchedulingLinkVisitorFieldRequirement>(['required', 'optional']),
  topic: new Set<SchedulingLinkVisitorFieldRequirement>(['required', 'optional']),
  phone: new Set<SchedulingLinkVisitorFieldRequirement>(['optional', 'omit']),
  notes: new Set<SchedulingLinkVisitorFieldRequirement>(['optional', 'omit']),
};

/** The closed visitor-field name list, DERIVED from the per-field allowed map
 * above so the two can never disagree about which fields exist.
 *
 * Exported for `receptionSchedulingPairBinding` (D-210 R-2), which digests the
 * visitor-field map and must bound its key set from this same source. */
export const SCHEDULING_LINK_VISITOR_FIELD_NAMES = Object.keys(
  SCHEDULING_LINK_CONFIG_PER_FIELD_ALLOWED,
) as ReadonlyArray<keyof SchedulingLinkVisitorFieldRequirements>;

/** Per-field-allowed guard for the visitor-field map.
 *
 * ⚠ Checks that every KNOWN field is present and allowed; it does NOT reject
 * unknown extra keys, and callers must not read it as a closed-shape guard.
 * That tolerance is fine for config validation (the renderer reads named
 * fields), but NOT for a hash subject — an extra key would ride into a digest
 * while this validator called the config unchanged. `receptionSchedulingPairBinding`
 * therefore bounds the key set with `SCHEDULING_LINK_VISITOR_FIELD_NAMES`
 * BEFORE digesting.
 *
 * Exported for that deriver, which must re-validate from the same rule the
 * endpoint validator uses — a second copy of the per-field sets could disagree
 * about what is legal, and would then hash a shape this validator rejects. */
export const isSchedulingLinkVisitorFieldRequirements = (
  v: unknown,
): v is SchedulingLinkVisitorFieldRequirements => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  for (const key of SCHEDULING_LINK_VISITOR_FIELD_NAMES) {
    if (typeof r[key] !== 'string') return false;
    const allowed = SCHEDULING_LINK_CONFIG_PER_FIELD_ALLOWED[key];
    if (!allowed.has(r[key] as SchedulingLinkVisitorFieldRequirement)) return false;
  }
  return true;
};

/** Validate a `SchedulingLinkConfig`. Pure function — no I/O. Returns
 *  the list of failures; empty array ⇒ valid. */
export const validateSchedulingLinkConfig = (
  config: unknown,
): ReadonlyArray<SchedulingLinkConfigValidationFailure> => {
  const failures: SchedulingLinkConfigValidationFailure[] = [];
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    failures.push({
      code: 'config_shape_invalid',
      detail: 'scheduling_link config must be an object',
    });
    return failures;
  }
  const c = config as Record<string, unknown>;

  if (!isNonEmptyString(c.display_name) || (c.display_name as string).trim().length === 0) {
    failures.push({ code: 'display_name_empty', detail: 'display_name must be non-empty' });
  } else if ((c.display_name as string).length > SCHEDULING_LINK_DISPLAY_NAME_MAX) {
    failures.push({
      code: 'display_name_too_long',
      detail: `display_name must be ≤ ${SCHEDULING_LINK_DISPLAY_NAME_MAX} characters`,
    });
  }

  if (c.instructions !== undefined) {
    if (typeof c.instructions !== 'string') {
      failures.push({
        code: 'instructions_too_long',
        detail: 'instructions must be a string when present',
      });
    } else if (c.instructions.length > SCHEDULING_LINK_INSTRUCTIONS_MAX) {
      failures.push({
        code: 'instructions_too_long',
        detail: `instructions must be ≤ ${SCHEDULING_LINK_INSTRUCTIONS_MAX} characters`,
      });
    }
  }

  if (c.success_message !== undefined) {
    if (typeof c.success_message !== 'string') {
      failures.push({
        code: 'success_message_too_long',
        detail: 'success_message must be a string when present',
      });
    } else if (c.success_message.length > SCHEDULING_LINK_SUCCESS_MESSAGE_MAX) {
      failures.push({
        code: 'success_message_too_long',
        detail: `success_message must be ≤ ${SCHEDULING_LINK_SUCCESS_MESSAGE_MAX} characters`,
      });
    }
  }

  // duration_options
  if (!Array.isArray(c.duration_options_minutes) || c.duration_options_minutes.length === 0) {
    failures.push({
      code: 'duration_options_empty',
      detail: 'duration_options_minutes must be a non-empty array',
    });
  } else {
    if (c.duration_options_minutes.length > SCHEDULING_LINK_DURATION_OPTIONS_MAX_COUNT) {
      failures.push({
        code: 'duration_option_too_many',
        detail: `duration_options_minutes length ${c.duration_options_minutes.length} exceeds max ${SCHEDULING_LINK_DURATION_OPTIONS_MAX_COUNT}`,
      });
    }
    for (const d of c.duration_options_minutes) {
      if (!SCHEDULING_LINK_DURATION_OPTION_MINUTES_SET.has(d as number)) {
        failures.push({
          code: 'duration_option_invalid',
          detail: `duration_option '${String(d)}' is not in the closed list`,
        });
      }
    }
  }

  // window definition
  if (
    c.available_window_definition === null ||
    typeof c.available_window_definition !== 'object' ||
    Array.isArray(c.available_window_definition)
  ) {
    failures.push({
      code: 'window_definition_empty',
      detail: 'available_window_definition must be an object',
    });
  } else {
    const w = c.available_window_definition as Record<string, unknown>;
    if (!isNonEmptyString(w.tz) || (w.tz as string).trim().length === 0) {
      failures.push({ code: 'tz_empty', detail: 'available_window_definition.tz must be non-empty' });
    } else if ((w.tz as string).length > SCHEDULING_LINK_TZ_MAX) {
      failures.push({
        code: 'tz_too_long',
        detail: `available_window_definition.tz must be ≤ ${SCHEDULING_LINK_TZ_MAX} characters`,
      });
    }
    const hasSi = w.standing_instructions_ref !== undefined;
    const hasExplicit = w.explicit_windows !== undefined;
    if (!hasSi && !hasExplicit) {
      failures.push({
        code: 'window_definition_empty',
        detail:
          'available_window_definition requires standing_instructions_ref OR explicit_windows[]',
      });
    }
    if (hasSi && !isNonEmptyString(w.standing_instructions_ref)) {
      failures.push({
        code: 'standing_instructions_ref_invalid',
        detail: 'standing_instructions_ref must be a non-empty string when present',
      });
    }
    if (hasExplicit) {
      if (!Array.isArray(w.explicit_windows) || w.explicit_windows.length === 0) {
        failures.push({
          code: 'window_definition_empty',
          detail: 'explicit_windows must be a non-empty array when present',
        });
      } else {
        for (const ew of w.explicit_windows) {
          if (!isExplicitWindow(ew)) {
            failures.push({
              code: 'explicit_window_invalid',
              detail: 'explicit_window: invalid day_of_week / start_minute / end_minute',
            });
          }
        }
      }
    }
  }

  if (!isSchedulingLinkVisitorFieldRequirements(c.required_visitor_fields)) {
    failures.push({
      code: 'visitor_fields_invalid',
      detail:
        'required_visitor_fields must declare {name, email, topic, phone, notes} per spec § A.5.2',
    });
  }

  if (
    !isFiniteIntegerInRange(
      c.min_advance_notice_hours,
      0,
      SCHEDULING_LINK_MIN_ADVANCE_NOTICE_HOURS_MAX,
    )
  ) {
    failures.push({
      code: 'min_advance_notice_out_of_range',
      detail: `min_advance_notice_hours must be 0..${SCHEDULING_LINK_MIN_ADVANCE_NOTICE_HOURS_MAX}`,
    });
  }
  if (!isFiniteIntegerInRange(c.max_lead_time_days, 1, SCHEDULING_LINK_MAX_LEAD_TIME_DAYS_MAX)) {
    failures.push({
      code: 'max_lead_time_out_of_range',
      detail: `max_lead_time_days must be 1..${SCHEDULING_LINK_MAX_LEAD_TIME_DAYS_MAX}`,
    });
  }
  if (
    !isFiniteIntegerInRange(
      c.max_bookings_per_day,
      0,
      SCHEDULING_LINK_MAX_BOOKINGS_PER_DAY_MAX,
    )
  ) {
    failures.push({
      code: 'max_bookings_per_day_out_of_range',
      detail: `max_bookings_per_day must be 0..${SCHEDULING_LINK_MAX_BOOKINGS_PER_DAY_MAX}`,
    });
  }

  // on_booking
  if (
    c.on_booking === null ||
    typeof c.on_booking !== 'object' ||
    Array.isArray(c.on_booking)
  ) {
    failures.push({
      code: 'on_booking_flag_invalid',
      detail: 'on_booking must be an object',
    });
  } else {
    const ob = c.on_booking as Record<string, unknown>;
    // D-210 compatibility: old persisted configs may contain these flags, but
    // the canonical booking mint no longer performs either advertised side
    // effect. Validate their old shape without requiring or acting on them.
    if (
      ob.create_calendar_event !== undefined
      && typeof ob.create_calendar_event !== 'boolean'
    ) {
      failures.push({
        code: 'on_booking_flag_invalid',
        detail: 'on_booking.create_calendar_event must be boolean',
      });
    }
    if (
      ob.create_commitment_entity !== undefined
      && typeof ob.create_commitment_entity !== 'boolean'
    ) {
      failures.push({
        code: 'on_booking_flag_invalid',
        detail: 'on_booking.create_commitment_entity must be boolean',
      });
    }
    // D-210 Phase C — retired; refuse a stale key (see the removal note).
    if ((ob as { notification_target?: unknown }).notification_target !== undefined) {
      failures.push({
        code: 'notification_target_unknown',
        detail:
          'on_booking.notification_target has been retired — notification channels are '
          + 'chosen in Settings, and the inbox fanout mode picks the surface. Remove the field.',
      });
    }
    if (ob.notify_visitor_sender !== undefined) {
      if (
        !isNonEmptyString(ob.notify_visitor_sender)
        || ob.notify_visitor_sender.trim().length === 0
        || ob.notify_visitor_sender.length > SCHEDULING_LINK_NOTIFY_VISITOR_SENDER_MAX
      ) {
        failures.push({
          code: 'on_booking_flag_invalid',
          detail:
            'on_booking.notify_visitor_sender must be a non-empty string no longer than '
            + `${SCHEDULING_LINK_NOTIFY_VISITOR_SENDER_MAX} characters when present`,
        });
      }
    }
    if (ob.auto_confirm_via_standing_instruction !== undefined) {
      failures.push({
        code: 'auto_confirm_ref_invalid',
        detail:
          'on_booking.auto_confirm_via_standing_instruction has been retired; '
          + 'booking approval always requires an owner action. Remove the field.',
      });
    }
  }

  // visitor_receipt — D-149 § A.20.3. Optional per-endpoint receipt
  // config; absent ⇒ receipts disabled. A present value delegates to
  // the shared contract validator (closed-list `via` + boolean
  // `enabled`).
  if (c.visitor_receipt !== undefined) {
    const vrFailures = validateVisitorReceiptConfig(c.visitor_receipt);
    if (vrFailures.length > 0) {
      failures.push({
        code: 'visitor_receipt_invalid',
        detail: `visitor_receipt: ${vrFailures[0]!.code} — ${vrFailures[0]!.detail}`,
      });
    }
  }

  return failures;
};

// ────────────────────────────────────────────────────────────────
// Booking-request input shape (POST /book)
// ────────────────────────────────────────────────────────────────

/** Visitor-supplied booking input. The visitor's fields are sealed into ONE
 *  `submission_blob_encrypted` envelope on the `reception_form_submission` row
 *  (D-210 A.8 slice 4b-ii folded the four `visitor_*_encrypted` columns; 4c
 *  dropped the table that had them), sub_dek-encrypted at write time with AAD =
 *  `(endpoint_id, submission_id, field_name)`; the typed
 *  shape here is what the substrate accepts BEFORE encryption + what
 *  the handler validates against `required_visitor_fields`. */
export interface SchedulingLinkBookingInput {
  readonly visitor_name: string;
  readonly visitor_email?: string;
  readonly visitor_phone?: string;
  readonly visitor_topic?: string;
  readonly visitor_notes?: string;
  readonly selected_slot_start_at: number;
  readonly selected_slot_end_at: number;
  readonly selected_duration_minutes: number;
}

export type SchedulingLinkBookingValidationCode =
  | 'visitor_name_required'
  | 'visitor_name_too_long'
  | 'visitor_email_required'
  | 'visitor_email_too_long'
  | 'visitor_email_invalid'
  | 'visitor_phone_too_long'
  | 'visitor_topic_required'
  | 'visitor_topic_too_long'
  | 'visitor_notes_too_long'
  | 'slot_start_invalid'
  | 'slot_end_invalid'
  | 'slot_duration_invalid'
  | 'slot_outside_window'
  | 'slot_violates_advance_notice'
  | 'slot_violates_lead_time'
  | 'duration_not_offered'
  | 'unknown_field';

export interface SchedulingLinkBookingValidationFailure {
  readonly code: SchedulingLinkBookingValidationCode;
  readonly detail: string;
}

/** Conservative email syntax probe. Mirrors the closed-list pattern
 *  in `intake_form` substrate; precision deferred to the engine
 *  reactive path (which can reach an MX-style probe if needed). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validate a visitor-supplied booking against the config + a
 *  `now` clock. Pure function — no I/O. */
export const validateSchedulingLinkBooking = (
  input: SchedulingLinkBookingInput,
  config: SchedulingLinkConfig,
  now: number,
): ReadonlyArray<SchedulingLinkBookingValidationFailure> => {
  const failures: SchedulingLinkBookingValidationFailure[] = [];
  // name
  if (typeof input.visitor_name !== 'string' || input.visitor_name.trim().length === 0) {
    failures.push({ code: 'visitor_name_required', detail: 'visitor_name must be non-empty' });
  } else if (input.visitor_name.length > SCHEDULING_LINK_VISITOR_NAME_MAX) {
    failures.push({
      code: 'visitor_name_too_long',
      detail: `visitor_name must be ≤ ${SCHEDULING_LINK_VISITOR_NAME_MAX} characters`,
    });
  }
  // email
  const emailReq = config.required_visitor_fields.email;
  if (emailReq === 'required') {
    if (typeof input.visitor_email !== 'string' || input.visitor_email.trim().length === 0) {
      failures.push({
        code: 'visitor_email_required',
        detail: 'visitor_email is required for this scheduling link',
      });
    }
  }
  if (typeof input.visitor_email === 'string' && input.visitor_email.length > 0) {
    if (input.visitor_email.length > SCHEDULING_LINK_VISITOR_EMAIL_MAX) {
      failures.push({
        code: 'visitor_email_too_long',
        detail: `visitor_email must be ≤ ${SCHEDULING_LINK_VISITOR_EMAIL_MAX} characters`,
      });
    } else if (!EMAIL_RE.test(input.visitor_email)) {
      failures.push({ code: 'visitor_email_invalid', detail: 'visitor_email must look like x@y.z' });
    }
  }
  // phone — accept the field only when config opts in.
  const phoneReq = config.required_visitor_fields.phone;
  if (input.visitor_phone !== undefined && phoneReq === 'omit') {
    failures.push({
      code: 'unknown_field',
      detail: 'visitor_phone is not accepted for this scheduling link',
    });
  } else if (typeof input.visitor_phone === 'string' && input.visitor_phone.length > 0) {
    if (input.visitor_phone.length > SCHEDULING_LINK_VISITOR_PHONE_MAX) {
      failures.push({
        code: 'visitor_phone_too_long',
        detail: `visitor_phone must be ≤ ${SCHEDULING_LINK_VISITOR_PHONE_MAX} characters`,
      });
    }
  }
  // topic
  const topicReq = config.required_visitor_fields.topic;
  if (topicReq === 'required') {
    if (typeof input.visitor_topic !== 'string' || input.visitor_topic.trim().length === 0) {
      failures.push({
        code: 'visitor_topic_required',
        detail: 'visitor_topic is required for this scheduling link',
      });
    }
  }
  if (typeof input.visitor_topic === 'string' && input.visitor_topic.length > 0) {
    if (input.visitor_topic.length > SCHEDULING_LINK_VISITOR_TOPIC_MAX) {
      failures.push({
        code: 'visitor_topic_too_long',
        detail: `visitor_topic must be ≤ ${SCHEDULING_LINK_VISITOR_TOPIC_MAX} characters`,
      });
    }
  }
  // notes
  const notesReq = config.required_visitor_fields.notes;
  if (input.visitor_notes !== undefined && notesReq === 'omit') {
    failures.push({
      code: 'unknown_field',
      detail: 'visitor_notes is not accepted for this scheduling link',
    });
  } else if (typeof input.visitor_notes === 'string' && input.visitor_notes.length > 0) {
    if (input.visitor_notes.length > SCHEDULING_LINK_VISITOR_NOTES_MAX) {
      failures.push({
        code: 'visitor_notes_too_long',
        detail: `visitor_notes must be ≤ ${SCHEDULING_LINK_VISITOR_NOTES_MAX} characters`,
      });
    }
  }
  // slot bounds
  if (
    typeof input.selected_slot_start_at !== 'number' ||
    !Number.isFinite(input.selected_slot_start_at)
  ) {
    failures.push({ code: 'slot_start_invalid', detail: 'selected_slot_start_at must be a number' });
  }
  if (
    typeof input.selected_slot_end_at !== 'number' ||
    !Number.isFinite(input.selected_slot_end_at)
  ) {
    failures.push({ code: 'slot_end_invalid', detail: 'selected_slot_end_at must be a number' });
  }
  if (
    !isFiniteIntegerInRange(input.selected_duration_minutes, 1, SCHEDULING_LINK_DURATION_OPTION_MINUTES_ALLOWED[SCHEDULING_LINK_DURATION_OPTION_MINUTES_ALLOWED.length - 1]!)
  ) {
    failures.push({
      code: 'slot_duration_invalid',
      detail: 'selected_duration_minutes must be a positive integer',
    });
  }
  if (
    typeof input.selected_slot_start_at === 'number' &&
    typeof input.selected_slot_end_at === 'number' &&
    Number.isFinite(input.selected_slot_start_at) &&
    Number.isFinite(input.selected_slot_end_at)
  ) {
    if (input.selected_slot_end_at <= input.selected_slot_start_at) {
      failures.push({
        code: 'slot_end_invalid',
        detail: 'selected_slot_end_at must be strictly greater than selected_slot_start_at',
      });
    }
    // Advance-notice gate
    const minAdvanceMs = config.min_advance_notice_hours * 60 * 60 * 1000;
    if (input.selected_slot_start_at < now + minAdvanceMs) {
      failures.push({
        code: 'slot_violates_advance_notice',
        detail: `selected_slot_start_at must be at least ${config.min_advance_notice_hours}h in the future`,
      });
    }
    // Lead-time gate
    const maxLeadMs = config.max_lead_time_days * 24 * 60 * 60 * 1000;
    if (input.selected_slot_start_at > now + maxLeadMs) {
      failures.push({
        code: 'slot_violates_lead_time',
        detail: `selected_slot_start_at must be within ${config.max_lead_time_days}d of now`,
      });
    }
  }
  // Duration must be one of the config's offered options
  if (
    Number.isInteger(input.selected_duration_minutes) &&
    !config.duration_options_minutes.includes(input.selected_duration_minutes)
  ) {
    failures.push({
      code: 'duration_not_offered',
      detail: `selected_duration_minutes ${input.selected_duration_minutes} is not in this link's offered options`,
    });
  }
  return failures;
};

// ────────────────────────────────────────────────────────────────
// Processing-outcome closed list (matches reception_booking_request)
// ────────────────────────────────────────────────────────────────

/** Spec § A.5.2 line 671 — `processing_outcome` closed set. The
 *  substrate writes `'pending'` at booking time + the engine-side
 *  reactive path flips to one of the terminal states. */
export const SCHEDULING_LINK_BOOKING_PROCESSING_OUTCOMES = [
  'pending',
  'processed',
  'auto_confirmed',
  'requires_review',
  'rejected',
] as const;

export type SchedulingLinkBookingProcessingOutcome =
  (typeof SCHEDULING_LINK_BOOKING_PROCESSING_OUTCOMES)[number];

export const SCHEDULING_LINK_BOOKING_PROCESSING_OUTCOME_SET: ReadonlySet<SchedulingLinkBookingProcessingOutcome> =
  new Set(SCHEDULING_LINK_BOOKING_PROCESSING_OUTCOMES);
