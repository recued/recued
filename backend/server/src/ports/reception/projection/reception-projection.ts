/** D-173 P1 § A.1 — per-kind reception projection operations.
 *
 *  The `approval_required` operations the `review-then-approve` recipe's
 *  `approved_operation` step invokes (D-173 N.4): a visitor payload →
 *  canonical entity fields, written through the right DESTINATION by
 *  `top_tier_kind` (D5). This is the ONLY reception-specific materialize
 *  code — relocation / reads are the existing D-145 Source → `data.<kind>.*`
 *  routing; this module does NOT rebuild that.
 *
 *  GENERALIZES the two D-149 drains' hardcoded materializations:
 *    - intake_form's `materialize(target_kind, …)` (task/note/commitment),
 *    - approval_link's hardcoded `create_commitment`,
 *  into one `top_tier_kind`-keyed projection so every reception kind (incl.
 *  scheduling → calendar, drop → task-with-attachment) shares one completion
 *  path with one idempotency contract. `form_response` is the non-writing
 *  terminal: it verifies the canonical pre-resume promotion instead.
 *
 *  Routing (D5):
 *    - task / note / commitment / project → the D-145 work-entity store,
 *      defaulting to the local builtin Source (`recued.<kind>`). For those
 *      kinds "relocation → `data.<kind>.*`" IS the existing Source routing;
 *      the write goes through the Source.
 *    - contact → `contact-handler.handleContactUpsert` (NOT Source-routed,
 *      D5): there is NO local `contact` Source — `contact.upsert` writes via
 *      `ContactStore.upsertManual`, outside the Source registry. So the
 *      contact projection branches to the live `contact.upsert` path.
 *      `top_tier_kind` grouping still holds (`contact` IS a source top-tier
 *      kind); only the write path differs.
 *
 *  Idempotency (I-4). Every work-entity write upserts on `ON CONFLICT(id)`,
 *  so a caller-supplied deterministic `id` (e.g. `reception_<row_id>`) makes
 *  re-release / crash-recovery a no-op (same id, overwrite — not a duplicate).
 *  Contact is keyed on canonical email (the store's natural upsert key), so a
 *  repeat upsert of the same email is idempotent by construction.
 *
 *  PII discipline. The visitor's free-text response is projected into the
 *  entity body/statement (that's the point — it's what the user reads). The
 *  visitor EMAIL is NEVER copied into a queryable work-entity blob — it stays
 *  sealed in the reception row (D-138-gated); only the provenance id reverse-
 *  links. The contact projection is the ONE exception where the email IS the
 *  payload (a contact IS an email-keyed identity) — but it goes through the
 *  same `contact.upsert` gate the manual-entry path uses.
 *
 *  This module is pure of side effects beyond the injected store writes; it
 *  holds no global state. The consolidator boot-wiring step injects the
 *  stores + exposes the projection op as `approval_required`; this file does
 *  NOT wire into server boot.
 *
 *  Spec: docs/d-173-spec.md § A.1 + D5 + I-4 + I-6. */

import {
  BOOKING_TITLE_MAX,
  COMMITMENT_STATEMENT_MAX,
  NOTE_TITLE_MAX,
  RECUED_BUILTIN_SOURCE_ID,
  TASK_TITLE_MAX,
  isWorkEntitySourceKind,
  type SourceTopTierKind,
  type WorkEntityKind,
} from '@recued/contracts';
import type { WorkEntityStore } from '../../../storage/work-entity-store.js';
import type { FormResponseStore } from '../../../storage/form-response-store.js';
import {
  handleContactUpsert,
  type ContactRpcDeps,
} from '../../../contact-handler.js';
import type { ReceptionSealedVisitorEmailResolver } from './reception-sealed-visitor-email.js';
import type { ReceptionBookingMintEffect } from './reception-booking-mint.js';

// ────────────────────────────────────────────────────────────────
// Narrow store slices — keeps the projection decoupled + unit-fakeable.
// (Mirrors the existing drain processors' `Pick<>` pattern.)
// ────────────────────────────────────────────────────────────────

/** Work-entity write slice the projection routes through — the four
 *  local-Source kinds. PARTIAL by construction: a caller supplies only the
 *  write methods for the kinds it can actually project (the approval_link
 *  drain only ever projects `commitment`, so it passes a `writeCommitment`-
 *  only store), and the projection fail-closes if it's asked to project a
 *  kind whose write method is absent. This keeps the existing drains' narrow
 *  `Pick<>` store deps assignable here without widening them (which would
 *  ripple into the deferred boot wire). */
export type ReceptionProjectionWorkEntityStore = Partial<
  Pick<WorkEntityStore, 'writeTask' | 'writeNote' | 'writeCommitment' | 'writeProject' | 'writeBooking'>
>;

// ────────────────────────────────────────────────────────────────
// Projection input
// ────────────────────────────────────────────────────────────────

/** The canonical, already-projected entity shape a reception kind's
 *  projection produced from the visitor payload. Vendor-agnostic — the
 *  reception kind owns the visitor-payload → this-shape mapping; this module
 *  owns the this-shape → destination-write mapping. */
export type ReceptionProjectionKind = SourceTopTierKind | 'form_response';

export interface ReceptionProjectionInput {
  /** Destination class → Source routing (D5) + inbox grouping (D2). */
  top_tier_kind: ReceptionProjectionKind;
  /** Deterministic entity id (I-4). For work entities the upsert key; for
   *  contact it is IGNORED (contact is email-keyed). Typically
   *  `reception_<row_id>`. */
  id: string;
  /** The entity title (task/project/note title; commitment falls back to the
   *  body). The reception kind clamps nothing — the projection clamps to the
   *  per-kind ceiling. */
  title: string;
  /** The entity body / statement (note body, task body, commitment
   *  statement). May be empty — the projection falls back to `title`. */
  body?: string;
  /** D-173 P4 / D7 — commitment due time. A scheduling booking maps its
   *  selected slot start → the commitment's `promised_for_at` (the local
   *  materialize of a booking is a commitment; the calendar event is the
   *  optional write-back, D7). Only consumed for `top_tier_kind ===
   *  'commitment'`; ignored for other kinds. Editable at the gate (D4 —
   *  "edit the start") via the pack's `editable_args`. */
  promised_for_at?: number;
  /** D-173 P4 / I-7 — when set (scheduling), the projection REFUSES to
   *  materialize a slot already in the past (`<= now`). Enforced at this
   *  single materialize choke point (I-2) so BOTH the drain path AND the
   *  approve-resume path are guarded — a booking held in the inbox whose slot
   *  passes before approval never books. Guards the commitment branch's
   *  `promised_for_at` AND the calendar branch's `start_at`. A non-scheduling
   *  commitment (e.g. an overdue approval) leaves this unset and may carry a
   *  past due time legitimately. */
  reject_if_slot_past?: boolean;
  /** D-173 P4.3 / D7 (amended) — a scheduling booking materializes a LOCAL
   *  CALENDAR EVENT (its faithful artifact — it carries start + end + duration;
   *  a commitment would drop the end). The slot start → the event `start_at`.
   *  Editable at the gate (D4 — "edit the start"). Only consumed for
   *  `top_tier_kind === 'calendar.event'`. Epoch ms. */
  start_at?: number;
  /** D-210 A.8 slice 3d — tell the visitor their booking is confirmed.
   *
   *  🔑 A per-approval OWNER CHOICE, not a policy: it arrives as an edited arg
   *  from the approval form (the pack's `editable_args`), defaulting OFF. The
   *  reactive auto-notify it replaces fired on EVERY booking update with no
   *  opt-in at all — owner-ruled out, because a message to someone else's
   *  inbox is a judgement the owner makes, not one a trigger makes for them.
   *
   *  ⚠ A ticked flag with no usable sender REFUSES rather than minting and
   *  swallowing the send: the owner asked for a notification, and silently not
   *  sending one is the failure they cannot see. Scheduling branch only. */
  notify_visitor?: boolean;
  /** D-173 P4.3 — the booked slot duration. The calendar branch computes
   *  `end_at = start_at + duration_minutes` so editing the start preserves the
   *  duration (shifts the end). Falls back to a 30-minute default when absent.
   *  Calendar branch only. */
  duration_minutes?: number;
  /** D-173 P4.3 — the calendar event's IANA timezone (from the scheduling
   *  endpoint's `available_window_definition.tz`). Defaults to `'UTC'` when
   *  absent. Calendar branch only. */
  timezone?: string;
  /** D-210 WS3 — day-scoped rather than timed. Set by an INTAKE whose calendar
   *  mapping names a `date` start field; scheduling never sets it (a booked
   *  slot always has a clock time). Calendar branch only. */
  is_all_day?: boolean;
  /** D-173 P4.3 / I-4 — the `reception_booking_request` id, the idempotency
   *  anchor for the calendar branch. `createEvent` is non-idempotent (mints a
   *  fresh UUID), so the seam pre-checks the booking's `resolved_calendar_event_id`
   *  before creating + populates it after — a re-release / crash-recovery lands
   *  the SAME event, not a duplicate. Calendar branch only. */
  booking_request_id?: string;
  /** Provenance + visitor metadata for the entity's `source_extension_blob`.
   *  MUST NOT carry the raw visitor email (sealed in the reception row); the
   *  reception kind builds this with provenance ids LAST so a visitor-named
   *  field can't spoof them. */
  metadata?: Record<string, unknown>;
  /** Destination Source id. Defaults to the local builtin Source for the
   *  kind (`recued.<kind>`) when omitted — cold-start-local (I-6). A
   *  write-back step (D6) supplies an external Source id instead. Ignored
   *  for `contact` (non-Source-routed). */
  source_id?: string;
  /** D5 contact branch — the canonical email the contact is keyed on.
   *  REQUIRED when `top_tier_kind === 'contact'`; ignored otherwise. */
  contact_email?: string;
  /** Optional contact display name (contact branch only). */
  contact_name?: string;
  /** D-173 P5 — a `data.file.received` record id (the drop's ingested file).
   *  When present on a work-entity projection (drop → a `task`), the file is
   *  attached to the materialized entity via `data.link role:'attachment'`
   *  (D-172) through the `attachFile` seam. Work-entity branch only. */
  file_id?: string;
}

/** What a projection write resolved to — the destination class + the
 *  materialized id. For contact the id is the canonical contact_id (or the
 *  email when the store didn't assign one). Drives the drain's
 *  `markProcessed` + the audit row. */
export interface ReceptionProjectionResult {
  top_tier_kind: ReceptionProjectionKind;
  target_id: string;
}

// ────────────────────────────────────────────────────────────────
// Calendar-event seam (D-173 P4.3 — NOT Source-routed)
// ────────────────────────────────────────────────────────────────

/** The canonical fields a `calendar.event` projection hands the
 *  create-calendar seam. The seam owns the destination (the default local
 *  calendar) + the idempotency pre-check; the projection owns the
 *  visitor-payload → these-fields mapping + the I-7 past-slot guard. */
export interface ReceptionCalendarEventInput {
  /** D-173 I-4 — the `reception_booking_request` id, the idempotency anchor.
   *  The seam pre-checks the booking's `resolved_calendar_event_id` before
   *  creating (createEvent is non-idempotent) + populates it after. Absent →
   *  the seam creates without the pre-check (the rare double-dispatch is the
   *  only risk; production always supplies it). */
  readonly booking_request_id?: string;
  readonly summary: string;
  readonly description?: string;
  /** Epoch ms. */
  readonly start_at: number;
  /** Epoch ms (`start_at` + the slot duration). */
  readonly end_at: number;
  /** IANA tz. */
  readonly timezone: string;
  /** D-210 WS3 — a DAY-SCOPED event rather than a timed one. Absent/false =
   *  timed (every scheduling booking, which always has a clock time). An intake
   *  targeting a calendar sets it from its `start_field`'s TYPE: a `date` field
   *  means the visitor named a day, a `datetime` field an instant. */
  readonly is_all_day?: boolean;
}

export interface ReceptionCalendarEventResult {
  /** The created (or idempotently-resolved) calendar event's `source_id`. */
  readonly source_id: string;
}

/** The injectable local-calendar create effect — the `calendar.event`
 *  branch's write path (NOT a Source). Built at the wire site over the
 *  calendar stack's create dispatcher + the scheduling booking store
 *  (idempotency). Present only when a calendar can be written (the calendar
 *  stack is up). A calendar projection without it fail-closes — it never
 *  silently drops an approved booking. */
export type ReceptionCalendarEventEffect = (
  input: ReceptionCalendarEventInput,
) => Promise<ReceptionCalendarEventResult>;

// ────────────────────────────────────────────────────────────────
// File-attach seam (D-173 P5 — drop → a task with the file attached)
// ────────────────────────────────────────────────────────────────

/** The fields the work-entity branch hands the attach seam to associate a
 *  `data.file.received` record to the just-materialized entity via
 *  `data.link role:'attachment'` (D-172). */
export interface ReceptionAttachFileInput {
  /** `data.file.received` record id (the drop's ingested file). */
  readonly file_id: string;
  /** The entity collection the file belongs to (`'task'` / `'note'` / …). */
  readonly to_collection: string;
  /** That entity's id. */
  readonly to_id: string;
}

/** The injectable file-attach effect — the drop's `data.link role:'attachment'`
 *  write path (D-172 `attachFile`). Built at the wire site over the annotation
 *  store + collection registry. Present only when the attach substrate is up;
 *  a work-entity projection carrying a `file_id` without it fail-closes
 *  (never silently drops the visitor's upload). Idempotent by construction
 *  (`attachFile` reuses an existing edge). */
export type ReceptionAttachFileEffect = (
  input: ReceptionAttachFileInput,
) => Promise<void>;

export interface ReceptionProjectionDeps {
  readonly workEntityStore: ReceptionProjectionWorkEntityStore;
  /** Canonical accepted-response store. Required only for the store-only
   *  `form_response` terminal, where the projection verifies that the shared
   *  pre-resume promotion persisted this exact intake before completing. */
  readonly formResponseStore?: Pick<FormResponseStore, 'findById'>;
  /** D5 — the live `contact.upsert` path (NOT a Source). Required only when a
   *  `contact`-kind projection can run; omit for a deployment that never
   *  receives contact-kind reception. A `contact` projection without it
   *  throws (fail-closed — never silently drops the visitor's identity). */
  readonly contactDeps?: ContactRpcDeps;
  /** D-173 P4.3 — the local-calendar create seam (NOT a Source). Required
   *  only when a `calendar.event`-kind projection can run.
   *
   *  ⚠ Since D-210 A.2 that means an INTAKE targeting a calendar, and ONLY
   *  that. Scheduling used to arrive here; it now projects as `booking` (a
   *  booking is never in the calendar), so this seam no longer sees a
   *  reservation. A calendar projection without it throws (fail-closed). */
  readonly createCalendarEvent?: ReceptionCalendarEventEffect;
  /** D-210 A.2 / slice 3b — the SCHEDULING booking write path (NOT a Source).
   *  Required only when a reservation can be approved: it opens the sealed
   *  reservation row for the slot + counterparty, which the generic
   *  work-entity `booking` arm has no access to. A reservation projection
   *  without it throws (fail-closed) — see `projectSchedulingBooking`. */
  readonly createBooking?: ReceptionBookingMintEffect;
  /** D-210 WS3 — resolve a submission's SEALED visitor email at materialize
   *  time. The `contact` branch keys on it, and it must never ride the held
   *  payload (that would put the address into step state a recipe can read).
   *  Required only when an INTAKE can target `contact`; scheduling never does.
   *  A contact projection with neither an explicit `contact_email` nor this
   *  resolver fail-closes. */
  readonly resolveSealedVisitorEmail?: ReceptionSealedVisitorEmailResolver;
  /** D-173 P5 — the file-attach seam (`data.link role:'attachment'`, D-172).
   *  Required only when a work-entity projection carries a `file_id` (drop). A
   *  work-entity projection with a `file_id` but no seam throws (fail-closed). */
  readonly attachFile?: ReceptionAttachFileEffect;
  readonly now: () => number;
}

/** D-173 P4.3 — fallback slot duration (ms) when a booking carries no
 *  resolvable `duration_minutes`. */
const DEFAULT_EVENT_DURATION_MS = 30 * 60_000;

const clamp = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s;

const safeTitle = (title: string, fallback: string): string => {
  const t = title.trim();
  return t.length > 0 ? t : fallback;
};

/** D-173 P4 — coerce a `promised_for_at` arg to an epoch-ms number, robustly.
 *  The drain prefills it as a number (the slot start), and the webclient
 *  datetime control returns a number when the prefilled value is a number —
 *  but an inbox edit (or a future caller) could hand a string. Accept a finite
 *  number as-is; parse a numeric string or an ISO date string; drop anything
 *  unparseable rather than write a junk due time (substrate-robust input). */
const coercePromisedForAt = (value: unknown): number | undefined => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim().length > 0) {
    const asNum = Number(value);
    if (Number.isFinite(asNum)) return asNum;
    const asDate = Date.parse(value);
    if (Number.isFinite(asDate)) return asDate;
  }
  return undefined;
};

/** D-173 P4 / I-7 — coerce a slot time and, when `guardPast` is set,
 *  REFUSE a past or unresolvable slot. Shared by the commitment branch
 *  (`promised_for_at`) and the calendar branch (`start_at`). The guard fires
 *  at this single materialize choke point (I-2) so BOTH the drain path and
 *  the approve-resume path are covered: a slot that passed while the booking
 *  sat in the inbox, OR an edited slot that was cleared / malformed
 *  (`coercePromisedForAt` → undefined), is refused rather than slipping past
 *  the `<= now` check and booking a timeless / past slot. Returns the coerced
 *  epoch-ms (or undefined when not guarding and the value is absent). */
const resolveGuardedSlot = (
  raw: unknown,
  now: number,
  guardPast: boolean,
): number | undefined => {
  const coerced = coercePromisedForAt(raw);
  if (guardPast) {
    if (coerced === undefined) {
      throw new Error(
        'reception scheduling projection: no resolvable slot time — a scheduling '
          + 'booking requires a valid future slot; refusing to materialize a timeless '
          + 'booking (D-173 I-7)',
      );
    }
    if (coerced <= now) {
      throw new Error(
        'reception scheduling projection: the selected slot is in the past — '
          + 'a past-slot booking is never materialized (D-173 I-7)',
      );
    }
  }
  return coerced;
};

// ────────────────────────────────────────────────────────────────
// Work-entity projections (task / note / commitment / project)
// ────────────────────────────────────────────────────────────────

/** Fail-closed accessor — the store is `Partial`, so a kind whose write
 *  method the caller didn't supply throws (never silently no-ops the
 *  visitor's submission). */
const requireWriter = <K extends keyof ReceptionProjectionWorkEntityStore>(
  store: ReceptionProjectionWorkEntityStore,
  method: K,
): NonNullable<ReceptionProjectionWorkEntityStore[K]> => {
  const fn = store[method];
  if (typeof fn !== 'function') {
    throw new Error(
      `reception projection: the work-entity store has no '${String(method)}' — `
        + `this deployment cannot project that kind`,
    );
  }
  return fn as NonNullable<ReceptionProjectionWorkEntityStore[K]>;
};

const projectWorkEntity = (
  deps: ReceptionProjectionDeps,
  kind: WorkEntityKind,
  input: ReceptionProjectionInput,
): ReceptionProjectionResult => {
  const now = deps.now();
  const sourceId = input.source_id ?? RECUED_BUILTIN_SOURCE_ID(kind);
  const metadata = input.metadata;
  const title = safeTitle(input.title, 'Reception submission');
  const body = input.body ?? '';
  const store = deps.workEntityStore;

  switch (kind) {
    case 'note': {
      const note = requireWriter(store, 'writeNote')(
        {
          id: input.id,
          title: clamp(title, NOTE_TITLE_MAX),
          // Note.body is required — fall back to the title when empty.
          body: body.length > 0 ? body : title,
          source_id: sourceId,
          ...(metadata !== undefined ? { source_extension_blob: metadata } : {}),
        },
        now,
      );
      return { top_tier_kind: 'note', target_id: note.id };
    }
    case 'commitment': {
      // D-173 P4 / I-7 — when `reject_if_slot_past` is set the slot guard
      // refuses a past or unresolvable due time at this single materialize
      // choke point (I-2). Scheduling now materializes a calendar event, not a
      // commitment (P4.3 / D7), so this guard is dormant for scheduling; it
      // stays generic substrate any dated commitment caller can opt into. A
      // non-scheduling commitment (e.g. an overdue / undated approval) leaves
      // the flag unset and may carry a past (or absent) `promised_for_at`
      // legitimately. The approval pack supplies `promised_for_at` (a due
      // time) without the guard.
      const promisedForAt = resolveGuardedSlot(
        input.promised_for_at,
        now,
        input.reject_if_slot_past === true,
      );
      // A visitor's submission is an inbound, peer-received intent.
      const commitment = requireWriter(store, 'writeCommitment')(
        {
          id: input.id,
          direction: 'inbound',
          statement: clamp(body.length > 0 ? body : title, COMMITMENT_STATEMENT_MAX),
          derivation: 'peer_received',
          lifecycle_state: 'pending',
          source_id: sourceId,
          // D7 — the slot time becomes the commitment's due time.
          ...(promisedForAt !== undefined ? { promised_for_at: promisedForAt } : {}),
          ...(metadata !== undefined ? { source_extension_blob: metadata } : {}),
        },
        now,
      );
      return { top_tier_kind: 'commitment', target_id: commitment.id };
    }
    case 'project': {
      const project = requireWriter(store, 'writeProject')(
        {
          id: input.id,
          title: clamp(title, TASK_TITLE_MAX),
          ...(body.length > 0 ? { description: body } : {}),
          source_id: sourceId,
          ...(metadata !== undefined ? { source_extension_blob: metadata } : {}),
        },
        now,
      );
      return { top_tier_kind: 'project', target_id: project.id };
    }
    // D-210 A.7 — `booking` is the primary reception destination. Before this
    // arm existed it fell through to the `default:` below and SILENTLY wrote a
    // Task: `isWorkEntitySourceKind('booking')` is true, so it reached here and
    // matched nothing. An owner selecting "booking" got a task at
    // `success: true`. ⇒ [[feedback_declared_is_not_backed]]
    case 'booking': {
      const booking = requireWriter(store, 'writeBooking')(
        {
          id: input.id,
          title: clamp(title, BOOKING_TITLE_MAX),
          source_id: sourceId,
          ...(metadata !== undefined ? { source_extension_blob: metadata } : {}),
        },
        now,
      );
      // ⛔ `counterparty_contact_id` is deliberately NOT set here. The intake
      // path has no RESOLVED contact — the visitor's address is sealed in the
      // reception row — and a booking is grantable, so writing an email into
      // that slot would leak a sealed identity through `data.booking`. It stays
      // empty until something resolves an opaque contact id.
      // `lifecycle_state` is likewise left to the store's `'confirmed'` default.
      return { top_tier_kind: 'booking', target_id: booking.id };
    }
    case 'task': {
      const task = requireWriter(store, 'writeTask')(
        {
          id: input.id,
          title: clamp(title, TASK_TITLE_MAX),
          ...(body.length > 0 ? { body } : {}),
          source_id: sourceId,
          ...(metadata !== undefined ? { source_extension_blob: metadata } : {}),
        },
        now,
      );
      return { top_tier_kind: 'task', target_id: task.id };
    }
    default: {
      // ⚠ `task` USED to carry `default:` with it, which made every unhandled
      // `WorkEntityKind` a silent task write — the bug the `booking` arm above
      // documents. Exhaustive now: the `never` binding turns the NEXT
      // `WORK_ENTITY_KINDS` addition into a compile error here, and the throw
      // fails closed at the point of use rather than laundering the kind.
      const unhandled: never = kind;
      throw new Error(
        `reception projection: no arm for work-entity kind '${String(unhandled)}' — `
          + 'add one rather than letting it fall through to a task',
      );
    }
  }
};

// ────────────────────────────────────────────────────────────────
// Contact projection (D5 — NOT Source-routed)
// ────────────────────────────────────────────────────────────────

/** D-210 WS3 — read the reception submission id out of a payload's provenance
 *  metadata. Substrate-authored at dispatch (`buildEntityShape` writes the
 *  provenance ids LAST, so a visitor-named field cannot spoof them), which is
 *  what makes it safe to resolve a sealed identity from. */
const readSubmissionIdFromProvenance = (
  metadata: Record<string, unknown> | undefined,
): string | null => {
  const raw = metadata?.reception_form_submission_id;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
};

const projectContact = async (
  deps: ReceptionProjectionDeps,
  input: ReceptionProjectionInput,
): Promise<ReceptionProjectionResult> => {
  if (deps.contactDeps === undefined) {
    // Fail-closed: a contact projection with no contact path can't write the
    // visitor's identity — surface it rather than silently drop.
    throw new Error(
      'reception contact projection requires contactDeps (the contact.upsert path) — D5',
    );
  }
  // D-210 WS3 — an INTAKE's contact payload carries NO email: it is sealed in
  // the reception row and resolved here, server-side, from the submission id
  // the provenance metadata already carries. An explicit `contact_email` still
  // wins (a caller that legitimately holds one), so this is a fallback, not a
  // replacement — but for the intake path it is the ONLY source.
  let email = input.contact_email;
  if (typeof email !== 'string' || email.trim().length === 0) {
    const submissionId = readSubmissionIdFromProvenance(input.metadata);
    if (submissionId !== null && deps.resolveSealedVisitorEmail !== undefined) {
      email = (await deps.resolveSealedVisitorEmail(submissionId)) ?? undefined;
    }
  }
  if (typeof email !== 'string' || email.trim().length === 0) {
    // Fail-closed. A contact with no key cannot be written, and inventing one
    // would be inventing an identity. The owner sees an approval that did not
    // complete rather than a contact record keyed on nothing.
    throw new Error(
      'reception contact projection requires a contact_email — none supplied and '
        + 'no sealed visitor email could be resolved for this submission',
    );
  }
  // Reuse the live `contact.upsert` validation + canonicalization path
  // (handleContactUpsert). The origin actor is whatever `contactDeps`
  // carries (server-injected, never spoofable) — the boot wire stamps it.
  const { contact } = await handleContactUpsert(deps.contactDeps, {
    email,
    ...(input.contact_name !== undefined ? { name: input.contact_name } : {}),
    last_interaction: deps.now(),
  });
  return {
    top_tier_kind: 'contact',
    // The contact_id when the store assigned one; the canonical email is the
    // stable fallback (contact is email-keyed → idempotent either way).
    target_id: contact.contact_id ?? email,
  };
};

// ────────────────────────────────────────────────────────────────
// Canonical FormResponse terminal (no second entity)
// ────────────────────────────────────────────────────────────────

/** Complete a store-only intake approval. Persistence is owned by the shared
 * pre-resume promotion hook; this projection verifies that exact canonical
 * response and its substrate provenance exist before the held operation may
 * report success. It therefore cannot silently no-op when the hook/store is
 * absent, nor point an approval at an unrelated accepted response. */
const projectFormResponse = (
  deps: ReceptionProjectionDeps,
  input: ReceptionProjectionInput,
): ReceptionProjectionResult => {
  const store = deps.formResponseStore;
  if (store === undefined) {
    throw new Error(
      'reception form_response projection requires the canonical FormResponse store',
    );
  }
  const metadata = input.metadata;
  if (
    metadata?.reception_form_submission_id !== input.id
    || typeof metadata.reception_endpoint_id !== 'string'
    || typeof metadata.form_definition_id !== 'string'
  ) {
    throw new Error(
      'reception form_response projection requires matching submission provenance',
    );
  }
  const response = store.findById(input.id);
  if (response === null) {
    throw new Error(
      `reception form_response projection: accepted response '${input.id}' was not promoted`,
    );
  }
  if (
    response.submission_id !== input.id
    || response.endpoint_id !== metadata.reception_endpoint_id
    || response.form_definition_id !== metadata.form_definition_id
  ) {
    throw new Error(
      `reception form_response projection: accepted response '${input.id}' provenance does not match`,
    );
  }
  return { top_tier_kind: 'form_response', target_id: response.submission_id };
};

// ────────────────────────────────────────────────────────────────
// Scheduling-booking projection (D-210 A.2 / slice 3b — NOT Source-routed)
// ────────────────────────────────────────────────────────────────

/** Materialize an approved SCHEDULING reservation as a `data_booking` row.
 *
 *  Through 3a this went to `projectCalendarEvent` and the booking was minted
 *  beside the event it created. A.2 made booking and calendar disjoint, so the
 *  event is gone and the booking is the whole record.
 *
 *  ⚠ Why this does NOT reuse the generic `booking` arm in `projectWorkEntity`:
 *  a reservation's slot and counterparty live in the SEALED
 *  `reception_booking_request` row, which the projection deliberately cannot
 *  read (it holds no scheduling store and no booking-PII key). The seam owns
 *  that open. The generic arm still serves an INTAKE targeting `booking`, which
 *  has no sealed slot to open — the two are different writes wearing one kind,
 *  which is exactly why they are discriminated on `booking_request_id`. */
const projectSchedulingBooking = async (
  deps: ReceptionProjectionDeps,
  input: ReceptionProjectionInput,
  booking_request_id: string,
): Promise<ReceptionProjectionResult> => {
  if (deps.createBooking === undefined) {
    // Fail-closed, mirroring the calendar arm: an approved reservation with no
    // write path must surface, never silently vanish. Since 3b this is the
    // ONLY artifact, so a silent drop would lose the booking entirely.
    throw new Error(
      'reception booking projection requires the createBooking seam '
        + '(the scheduling booking write path) — D-210 A.2',
    );
  }
  // 🔴 The slot comes from the INPUT, not the reservation row, and this is
  // load-bearing rather than incidental: the owner may EDIT the start at the
  // approval gate, and that edited value arrives here. Reading the sealed row's
  // `selected_slot_start_at` instead would silently mint the booking at the time
  // the visitor originally ASKED for — at `success: true`, with the inbox having
  // shown the owner the time they thought they were confirming.
  //
  // The two facts stay distinct, exactly as they did when a calendar event held
  // the agreement: the reservation row records what the visitor ASKED (write-once
  // provenance), the booking records what was AGREED. `d-173-i5-slot-edit-row-
  // staleness` pins the disagreement, and pins which one downstream capacity
  // counting must read — the booking.
  const now = deps.now();
  // I-7 — the same past-slot refusal the calendar arm applies, at the same
  // single materialize choke point (I-2): a booking can sit in the inbox until
  // its slot passes, or an edit can clear it.
  const startAt = resolveGuardedSlot(
    input.start_at,
    now,
    input.reject_if_slot_past === true,
  );
  if (startAt === undefined) {
    throw new Error(
      'reception booking projection: a booking requires a start time (start_at)',
    );
  }
  const durationMinutes = coercePromisedForAt(input.duration_minutes);
  const durationMs =
    durationMinutes !== undefined && durationMinutes > 0
      ? durationMinutes * 60_000
      : DEFAULT_EVENT_DURATION_MS;
  const booking_id = await deps.createBooking({
    booking_request_id,
    // ⚠ Both, always. `slot_end_at` is START + DURATION, never a separately
    // carried end — an owner who edits the start shifts the whole booking and
    // keeps its length, which is what "move my 2-hour booking an hour later"
    // means. The store refuses a half-supplied pair, so they cannot drift.
    slot_start_at: startAt,
    slot_end_at: startAt + durationMs,
    // The deterministic id the drain derived (`reception_<request_id>`). It is
    // BOTH the row's primary key and the seam's idempotency anchor, so a retry
    // reads back the row it would have written. Falling back to the request id
    // would break that pairing, hence fail-closed rather than a `??`.
    booking_id: requireProjectionId(input.id, booking_request_id),
    // The owner's per-approval choice, passed as-is. The SEAM owns both the
    // sender lookup and the refusal, because it is the only layer holding the
    // endpoint (the sender's home) and the reservation (the original ask the
    // message may need to name).
    notify_visitor: input.notify_visitor === true,
  });
  return { top_tier_kind: 'booking', target_id: booking_id };
};

/** The projection `id` a scheduling reservation must carry. Absent ⇒ throw:
 *  without it the seam's I-4 pre-check would read a different key than the
 *  write uses, and a re-approve would mint a SECOND booking for one slot. */
const requireProjectionId = (id: string | undefined, request_id: string): string => {
  if (typeof id === 'string' && id.length > 0) return id;
  throw new Error(
    `reception booking projection: reservation '${request_id}' carries no projection id — `
      + 'the deterministic booking id is the idempotency anchor and cannot be derived here',
  );
};

// ────────────────────────────────────────────────────────────────
// Calendar-event projection (D-173 P4.3 — NOT Source-routed)
// ────────────────────────────────────────────────────────────────

/** Project a scheduling booking into a LOCAL CALENDAR EVENT (D7 amended).
 *  A booking carries start + end + duration — a calendar event is its
 *  faithful artifact (a commitment would drop the end). The slot start →
 *  `start_at`; `end_at = start_at + duration_minutes` (so an edited start
 *  preserves the duration). The seam owns the destination (the default local
 *  calendar) + the idempotency pre-check (I-4); this branch owns the I-7
 *  past-slot guard (the single materialize choke point — I-2) + the
 *  visitor-payload → event-field mapping. */
const projectCalendarEvent = async (
  deps: ReceptionProjectionDeps,
  input: ReceptionProjectionInput,
): Promise<ReceptionProjectionResult> => {
  if (deps.createCalendarEvent === undefined) {
    // Fail-closed: a calendar projection with no create seam can't write the
    // booking — surface it rather than silently drop the approved submission.
    throw new Error(
      'reception calendar projection requires the createCalendarEvent seam '
        + '(the local calendar create path) — D-173 P4.3',
    );
  }
  const now = deps.now();
  // I-7 — refuse a slot already in the past (covers a booking that sat in the
  // inbox until its slot passed, or an edited start cleared / malformed).
  const startAt = resolveGuardedSlot(
    input.start_at,
    now,
    input.reject_if_slot_past === true,
  );
  if (startAt === undefined) {
    // A calendar event needs a start time even when the past-slot guard is
    // off — an event without a start can't land on the calendar.
    throw new Error(
      'reception calendar projection: a calendar event requires a start time (start_at)',
    );
  }
  const durationMinutes = coercePromisedForAt(input.duration_minutes);
  const durationMs =
    durationMinutes !== undefined && durationMinutes > 0
      ? durationMinutes * 60_000
      : DEFAULT_EVENT_DURATION_MS;
  const summary = safeTitle(input.title, 'Booking');
  const description =
    input.body !== undefined && input.body.trim().length > 0 ? input.body : undefined;
  const timezone =
    typeof input.timezone === 'string' && input.timezone.trim().length > 0
      ? input.timezone
      : 'UTC';
  const { source_id } = await deps.createCalendarEvent({
    ...(input.booking_request_id !== undefined
      ? { booking_request_id: input.booking_request_id }
      : {}),
    summary,
    ...(description !== undefined ? { description } : {}),
    start_at: startAt,
    // `end_at` is always START + DURATION, never a separately-carried end.
    // D-210 WS3's `end_field` spec is resolved to a duration UPSTREAM (in the
    // intake mapping) precisely so this stays true: an owner who edits the
    // start at the gate shifts the whole event and keeps its length, which is
    // what "move my 2-hour booking an hour later" means.
    end_at: startAt + durationMs,
    timezone,
    ...(input.is_all_day === true ? { is_all_day: true } : {}),
  });
  return { top_tier_kind: 'calendar.event', target_id: source_id };
};

// ────────────────────────────────────────────────────────────────
// The projection operation
// ────────────────────────────────────────────────────────────────

/** Project an already-canonicalized reception payload into the warehouse,
 *  routing by `top_tier_kind` (D5). Returns the destination class + the
 *  materialized id. Idempotent for a stable `id` (work entities) / email
 *  (contact) / `resolved_calendar_event_id` (calendar) — I-4.
 *
 *  Throws on an unsupported `top_tier_kind` (only `form_response` / `task` /
 *  `note` / `commitment` / `project` / `contact` / `calendar.event` are
 *  completable locally; `mail_message` has no local write path), on a
 *  contact projection missing its deps/email, or on a calendar projection
 *  missing the create seam (all fail-closed). A scheduling booking
 *  materializes as a `calendar.event` (D7 amended — its faithful artifact). */
export const runReceptionProjection = async (
  deps: ReceptionProjectionDeps,
  input: ReceptionProjectionInput,
): Promise<ReceptionProjectionResult> => {
  const kind = input.top_tier_kind;
  if (kind === 'form_response') {
    return projectFormResponse(deps, input);
  }
  if (kind === 'contact') {
    return projectContact(deps, input);
  }
  if (kind === 'calendar.event') {
    return projectCalendarEvent(deps, input);
  }
  // D-210 A.2 / slice 3b — a SCHEDULING reservation, discriminated from an
  // intake that merely names `booking` as its destination by the presence of
  // the reservation id. Intercepted BEFORE the generic work-entity branch
  // because only the seam can open the sealed slot + counterparty.
  //
  // ⚠ It therefore skips that branch's `file_id` attach leg — correct, and not
  // an oversight: a `file_id` reaches the projection only from a drop (D-173
  // P5), and a drop targets a task. A scheduling_link takes no upload, so
  // there is no attachment to lose here.
  if (kind === 'booking' && input.booking_request_id !== undefined) {
    return projectSchedulingBooking(deps, input, input.booking_request_id);
  }
  if (isWorkEntitySourceKind(kind)) {
    // D-173 P5 — a drop materializes a work entity (task) WITH the uploaded
    // file attached via `data.link role:'attachment'` (D-172). Fail-closed
    // BEFORE any write: a `file_id` with no attach seam throws here, so we
    // never write a task that then can't carry its file (no partial
    // materialization — both the entity and its attachment land, or neither).
    const wantsAttach = typeof input.file_id === 'string' && input.file_id.length > 0;
    if (wantsAttach && deps.attachFile === undefined) {
      throw new Error(
        'reception projection: file_id present but no attachFile seam '
          + '(the data.link attachment write path) — D-173 P5',
      );
    }
    // Write the entity first (so the link's `from` endpoint exists), then
    // attach. Idempotent — `attachFile` reuses an existing edge, the entity
    // upserts on its id.
    const result = projectWorkEntity(deps, kind, input);
    if (wantsAttach) {
      await deps.attachFile!({
        file_id: input.file_id!,
        to_collection: result.top_tier_kind,
        to_id: result.target_id,
      });
    }
    return result;
  }
  throw new Error(
    `reception projection: top_tier_kind '${kind}' is not locally materializable `
      + `(supported: form_response / task / note / commitment / project / contact / calendar.event)`,
  );
};
