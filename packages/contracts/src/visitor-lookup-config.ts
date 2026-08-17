/** D-240 — Submitter viewback: per-endpoint `visitor_lookup` config.
 *
 *  The config-side half of the viewback feature — the mode closed list, the
 *  `VisitorLookupExpiry` union, the per-record-kind permitted-mode table, and the
 *  validator all three write surfaces derive from.
 *
 *  ⚠ THIS FILE IMPORTS NO VALUES, and that is structural rather than tidy. It is
 *  the exact constraint `visitor-receipt-config.ts` documents beside it:
 *  `reception-visitor-ux.ts` already imports every per-kind config file, so a
 *  per-kind file (`intake-form-config.ts`) cannot import back from it. This is
 *  the shared leaf both sides depend on. `ReceptionRecordKind` arrives as a
 *  TYPE-ONLY import — erased at compile time, so the runtime graph stays
 *  `intake-form-config → visitor-lookup-config` with no edge back.
 *
 *  Spec: D-240 § D4 / D6 / D9. */

import type { ReceptionRecordKind } from './reception-record.js';

// ════════════════════════════════════════════════════════════════
// Modes
// ════════════════════════════════════════════════════════════════

/** D-240 § D6 — how a viewback credential's expiry is anchored.
 *
 *  ⛔ FOUR MODES, AND WHICH ONES A RECORD MAY USE IS NOT FREE — see
 *  {@link VISITOR_LOOKUP_MODES_PERMITTED_PER_RECORD_KIND}. A booking's end is
 *  KNOWN AT ISSUE (`slot.end_at`), an intake's is not, and collapsing that into
 *  one configurable axis would let an author anchor a booking on a lifecycle it
 *  does not have, or an intake on an event date it never collected. */
export const VISITOR_LOOKUP_MODES = [
  /** `scheduling_link` only — the slot's own end is the anchor. */
  'after_event',
  /** From `submitted_at`. Computes at submit; `expires_at` stays NOT NULL. */
  'fixed',
  /** Stamped when the durable record flips `done` (§ D7). */
  'until_resolved',
  /** A visitor-supplied date field + ttl. Clamped and fails CLOSED (§ D9). */
  'after_field',
] as const;

export type VisitorLookupMode = (typeof VISITOR_LOOKUP_MODES)[number];

export const VISITOR_LOOKUP_MODE_SET: ReadonlySet<VisitorLookupMode> = new Set(
  VISITOR_LOOKUP_MODES,
);

export const isVisitorLookupMode = (value: unknown): value is VisitorLookupMode =>
  typeof value === 'string' && VISITOR_LOOKUP_MODE_SET.has(value as VisitorLookupMode);

/** D-240 § D6 — which modes each record kind admits.
 *
 *  🔑 THIS IS WHAT MAKES "for booking it is simple" STRUCTURAL RATHER THAN
 *  DOCUMENTARY. `after_event` is not expressible on an intake and the other three
 *  are not expressible on a booking, so the two cases cannot drift into each
 *  other through config.
 *
 *  ⛔ Keyed on the closed `ReceptionRecordKind` union rather than listing pairs,
 *  so adding a third record kind is a TYPE ERROR here — it cannot default into
 *  admitting everything, which is the direction that fails open. Same shape as
 *  `RECEPTION_PAIR_CONSUMER` and `SOURCE_QUERY_KINDS_PERMITTED_PER_PACKET_KIND`. */
export const VISITOR_LOOKUP_MODES_PERMITTED_PER_RECORD_KIND: Readonly<
  Record<ReceptionRecordKind, ReadonlyArray<VisitorLookupMode>>
> = {
  scheduling_link: ['after_event'],
  intake_form: ['fixed', 'until_resolved', 'after_field'],
};

/** D-240 § D9 — the form field types `after_field` may anchor on.
 *
 *  Both date-ish visitor field types qualify: `datetime` is `date` plus a
 *  time-of-day and "both arrive as strings" (`redacted-packets.ts`). Anything
 *  else — `text` especially — would make the anchor an unvalidated free string
 *  the submitter controls. */
/** D-240 § D7 — the intake target kinds that can REPORT COMPLETION, and so the
 *  only ones `until_resolved` can anchor on.
 *
 *  ⛔⛔ `note` / `calendar` / `contact` ARE ABSENT BECAUSE THEY HAVE NO SUCH
 *  CONCEPT — a note is written, a contact exists; neither ever "finishes". An
 *  `until_resolved` viewback on one of them can never be stamped, so it would
 *  live to the 180-day ceiling instead of its configured grace, silently and
 *  forever. The owner would have configured "expires a month after it's done"
 *  and got "expires in six months, always".
 *
 *  ⇒ Refused at CONFIG-WRITE time, where the target kind is already known
 *  (`submission_processing_rule.target_kind`) and the author is present to
 *  choose differently. The alternative — warning at sweep time — tells nobody
 *  who can act.
 *
 *  - `task`          → `done`
 *  - `booking`       → `lifecycle_state` ∈ completed / cancelled / no_show
 *  - `form_response` → `lifecycle_state` ∈ accepted / declined / no_show */
export const VISITOR_LOOKUP_COMPLETABLE_TARGET_KINDS: ReadonlyArray<string> = [
  'task',
  'booking',
  'form_response',
];

export const VISITOR_LOOKUP_COMPLETABLE_TARGET_KIND_SET: ReadonlySet<string> = new Set(
  VISITOR_LOOKUP_COMPLETABLE_TARGET_KINDS,
);

export const VISITOR_LOOKUP_ANCHOR_FIELD_TYPES: ReadonlyArray<string> = ['date', 'datetime'];

export const VISITOR_LOOKUP_ANCHOR_FIELD_TYPE_SET: ReadonlySet<string> = new Set(
  VISITOR_LOOKUP_ANCHOR_FIELD_TYPES,
);

// ════════════════════════════════════════════════════════════════
// Bounds
// ════════════════════════════════════════════════════════════════

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Floor. A viewback shorter than an hour is a link that dies before the
 *  submitter reads the email carrying it. */
export const VISITOR_LOOKUP_MIN_TTL_MS = HOUR_MS;

/** Ceiling on any AUTHORED duration — `ttl_ms` and `grace_ms` alike.
 *
 *  ⚠ 90 days mirrors D-149 § N.4's `status_link` ceiling ("status 30d default +
 *  90d max"), which is the nearest existing decision about how long a
 *  visitor-facing read may live. § D14's real bound is the record's own
 *  retention; until per-class retention exists in code (§ Not built item 1) this
 *  constant stands in for it. */
export const VISITOR_LOOKUP_MAX_TTL_MS = 90 * DAY_MS;

/** D-240 § D10 — THE BACKSTOP, and it is not the same number as the ceiling
 *  above.
 *
 *  ⛔⛔ `purge()` is `DELETE … WHERE expires_at <= ?`, and an `until_resolved`
 *  credential has NO `expires_at` until its record flips `done`. A request that
 *  is abandoned — the approver never answers, the run stalls, the pack is
 *  uninstalled — would never be collected at all. Every credential therefore
 *  carries an ALWAYS-SET `ceiling_at` that purge also reads, so "lives until the
 *  item ends" cannot silently mean "lives until the disk does".
 *
 *  ⚠ It must exceed {@link VISITOR_LOOKUP_MAX_TTL_MS} or it would truncate a
 *  legitimately-authored maximum window; asserted in the tests rather than left
 *  to the reader to notice. */
export const VISITOR_LOOKUP_ABSOLUTE_CEILING_MS = 180 * DAY_MS;

/** Default window when an author names `fixed` without a ttl. Mirrors
 *  `status_link`'s 30d default for the same reason the ceiling mirrors its max. */
export const VISITOR_LOOKUP_DEFAULT_TTL_MS = 30 * DAY_MS;

/** Default grace after the anchor for `after_event` / `until_resolved`. Long
 *  enough that someone whose request resolves on a Friday can still read the
 *  outcome after a holiday. */
export const VISITOR_LOOKUP_DEFAULT_GRACE_MS = 30 * DAY_MS;

// ════════════════════════════════════════════════════════════════
// Shapes
// ════════════════════════════════════════════════════════════════

export type VisitorLookupExpiry =
  | { readonly mode: 'after_event'; readonly grace_ms: number }
  | { readonly mode: 'fixed'; readonly ttl_ms: number }
  | { readonly mode: 'until_resolved'; readonly grace_ms: number }
  | { readonly mode: 'after_field'; readonly field: string; readonly ttl_ms: number };

/** Per-endpoint viewback config. Absent ⇒ disabled, the conservative default,
 *  matching `visitor_receipt` beside it (D-149 privacy invariant 1: every
 *  endpoint surface is default-off and separately enabled). */
export interface VisitorLookupConfig {
  readonly enabled: boolean;
  readonly expiry: VisitorLookupExpiry;
}

// ════════════════════════════════════════════════════════════════
// Validation
// ════════════════════════════════════════════════════════════════

/** D-240 slice 2 — the modes a submit path can actually MINT today.
 *
 *  ⛔ ONE LIST, CONSUMED BY THE VALIDATOR AND THE RESOLVER BOTH, so an offered
 *  mode the mint path cannot honour is not expressible. Same shape and same
 *  reason as `APPROVAL_LINK_SUPPORTED_ON_APPROVE_ACTIONS`: that list exists
 *  because `mark_resolved` was the authoring DEFAULT while its answers reached
 *  nobody, and the honest move was to stop accepting the config rather than
 *  accept it and fail later.
 *
 *  Every mode is now supported: `until_resolved` landed in slice 4 and
 *  `after_field` in slice 5, each adding its member here in the commit that made
 *  it work. ⚠ The list is KEPT rather than deleted now that it is complete — it
 *  is the shape a future mode is added through, and the refusal it produces is
 *  a distinct code (`_unsupported`, not `_unknown`) that callers switch on.
 *
 *  ⚠ THIS IS A WRITE-ONLY REFUSAL IN PRINCIPLE — a stored row is not made
 *  malformed by a later policy decision, which is the `f79683d5b` lesson (a
 *  write refusal that leaked into the READ path stopped every existing row
 *  parsing). It needs no exemption list TODAY because the pre-launch
 *  zero-installs rule means no config carrying an unsupported mode can exist:
 *  the refusal lands before the first one could be written. ⛔ If that ever
 *  stops being true, this needs the `APPROVAL_LINK_WRITE_ONLY_REFUSAL_CODES`
 *  treatment before a member is REMOVED from the list. */
export const VISITOR_LOOKUP_SUPPORTED_MODES = [
  'after_event',
  'fixed',
  // D-240 slice 4 — the deferred arm. Added in the SAME commit that makes it
  // work, which is what this list is for.
  'until_resolved',
  // D-240 slice 5 — the visitor-anchored arm, with its strict parse and clamp.
  'after_field',
] as const satisfies ReadonlyArray<VisitorLookupMode>;

export type VisitorLookupSupportedMode = (typeof VISITOR_LOOKUP_SUPPORTED_MODES)[number];

export const VISITOR_LOOKUP_SUPPORTED_MODE_SET: ReadonlySet<VisitorLookupMode> = new Set(
  VISITOR_LOOKUP_SUPPORTED_MODES,
);

export const VISITOR_LOOKUP_CONFIG_VALIDATION_CODES = [
  'visitor_lookup_not_object',
  'visitor_lookup_enabled_invalid',
  'visitor_lookup_mode_unknown',
  'visitor_lookup_mode_not_permitted_for_kind',
  /** The mode is real and permitted for this kind, but no submit path mints it
   *  yet. ⛔ A DISTINCT CODE from `_unknown` — "a mode nobody has ever defined"
   *  and "a mode we have not built yet" are different facts, and a caller
   *  switching on the code must tell them apart. */
  'visitor_lookup_mode_unsupported',
  'visitor_lookup_ttl_out_of_range',
  'visitor_lookup_field_missing',
  'visitor_lookup_field_not_a_date',
  'visitor_lookup_requires_receipt',
  /** § D7 — `until_resolved` on a destination that never finishes. */
  'visitor_lookup_target_has_no_completion',
] as const;

export type VisitorLookupConfigValidationCode =
  (typeof VISITOR_LOOKUP_CONFIG_VALIDATION_CODES)[number];

export interface VisitorLookupConfigValidationFailure {
  readonly code: VisitorLookupConfigValidationCode;
  readonly detail: string;
}

/** What the validator needs that the config itself does not carry.
 *
 *  🔑 IT IS A CONTEXT PARAMETER RATHER THAN A SECOND VALIDATOR because all three
 *  facts are about the SAME authoring act: which record kind this endpoint
 *  writes, whether the author also turned on the receipt that delivers the link,
 *  and which fields the form actually collects. Splitting them would let a caller
 *  run the shape check, skip the cross-field check, and store a config that
 *  cannot work. */
export interface VisitorLookupValidationContext {
  readonly record_kind: ReceptionRecordKind;
  /** § D4 — is a `visitor_receipt` enabled on the same endpoint? The receipt is
   *  the ONLY surface that hands the submitter anything, so it is the delivery
   *  vehicle for the link. */
  readonly receipt_enabled: boolean;
  /** Visitor-visible field name → declared type, for the `after_field` anchor
   *  check. Empty map ⇒ the form collects nothing, so no anchor can resolve. */
  readonly field_types: ReadonlyMap<string, string>;
  /** § D7 — the endpoint's `submission_processing_rule.target_kind`, so
   *  `until_resolved` can be refused on a destination that never completes.
   *  Absent ⇒ the check is skipped (a caller that does not know its destination
   *  cannot be asked to judge it). */
  readonly target_kind?: string;
}

const durationFailure = (
  label: string,
  value: unknown,
): VisitorLookupConfigValidationFailure | undefined =>
  typeof value !== 'number'
  || !Number.isFinite(value)
  || !Number.isInteger(value)
  || value < VISITOR_LOOKUP_MIN_TTL_MS
  || value > VISITOR_LOOKUP_MAX_TTL_MS
    ? {
        code: 'visitor_lookup_ttl_out_of_range',
        detail:
          `visitor_lookup.expiry.${label} must be an integer between `
          + `${VISITOR_LOOKUP_MIN_TTL_MS} and ${VISITOR_LOOKUP_MAX_TTL_MS} ms; got ${String(value)}`,
      }
    : undefined;

/** Validate a `visitor_lookup` config against its authoring context. Pure;
 *  returns every problem rather than the first, matching every sibling
 *  validator in this substrate.
 *
 *  ⚠ THE SHAPE AND MODE RULES RUN EVEN WHEN `enabled` IS FALSE. A disabled
 *  config that could not be enabled without becoming invalid is a trap the
 *  author springs on themselves later; the only rule gated on `enabled` is the
 *  receipt one, because a disabled lookup genuinely needs no delivery vehicle. */
export const validateVisitorLookupConfig = (
  config: unknown,
  ctx: VisitorLookupValidationContext,
): ReadonlyArray<VisitorLookupConfigValidationFailure> => {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return [{
      code: 'visitor_lookup_not_object',
      detail: 'visitor_lookup config must be an object',
    }];
  }
  const failures: VisitorLookupConfigValidationFailure[] = [];
  const c = config as Record<string, unknown>;

  if (typeof c.enabled !== 'boolean') {
    failures.push({
      code: 'visitor_lookup_enabled_invalid',
      detail: 'visitor_lookup.enabled must be a boolean',
    });
  }

  const expiry = c.expiry;
  if (expiry === null || typeof expiry !== 'object' || Array.isArray(expiry)) {
    failures.push({
      code: 'visitor_lookup_not_object',
      detail: 'visitor_lookup.expiry must be an object',
    });
    return failures;
  }
  const e = expiry as Record<string, unknown>;

  if (!isVisitorLookupMode(e.mode)) {
    failures.push({
      code: 'visitor_lookup_mode_unknown',
      detail:
        `visitor_lookup.expiry.mode must be one of ${VISITOR_LOOKUP_MODES.join(', ')}; `
        + `got ${JSON.stringify(e.mode)}`,
    });
    return failures;
  }
  const mode: VisitorLookupMode = e.mode;

  // § D6 — the per-kind gate. Checked BEFORE the per-mode field rules so an
  // author who picked a mode this kind cannot use is told that, rather than
  // being sent to fix a ttl on a mode they must abandon anyway.
  const permitted = VISITOR_LOOKUP_MODES_PERMITTED_PER_RECORD_KIND[ctx.record_kind];
  if (!permitted.includes(mode)) {
    failures.push({
      code: 'visitor_lookup_mode_not_permitted_for_kind',
      detail:
        `visitor_lookup.expiry.mode '${mode}' is not available for a `
        + `${ctx.record_kind} record; permitted: ${permitted.join(', ')}`,
    });
    return failures;
  }

  if (mode === 'fixed' || mode === 'after_field') {
    const failure = durationFailure('ttl_ms', e.ttl_ms);
    if (failure) failures.push(failure);
  } else {
    const failure = durationFailure('grace_ms', e.grace_ms);
    if (failure) failures.push(failure);
  }

  if (mode === 'after_field') {
    const field = e.field;
    if (typeof field !== 'string' || field.trim() === '') {
      failures.push({
        code: 'visitor_lookup_field_missing',
        detail: 'visitor_lookup.expiry.field must name a visitor-visible form field',
      });
    } else {
      const declared = ctx.field_types.get(field);
      if (declared === undefined) {
        failures.push({
          code: 'visitor_lookup_field_missing',
          detail: `visitor_lookup.expiry.field '${field}' is not a field this form collects`,
        });
      } else if (!VISITOR_LOOKUP_ANCHOR_FIELD_TYPE_SET.has(declared)) {
        // § D9.1 — checked at CONFIG-WRITE time, not at submit. At submit the
        // author is not present and the only honest option left is the fail-closed
        // fallback; here they can still fix it.
        failures.push({
          code: 'visitor_lookup_field_not_a_date',
          detail:
            `visitor_lookup.expiry.field '${field}' is declared '${declared}'; `
            + `an anchor must be one of ${VISITOR_LOOKUP_ANCHOR_FIELD_TYPES.join(', ')}`,
        });
      }
    }
  }

  // Slice 2 — the mode is real and permitted for this kind, but no submit path
  // mints it yet.
  //
  // ⚠ LAST, AND IT DOES NOT SHORT-CIRCUIT. An early return here would make every
  // per-mode rule above UNREACHABLE for exactly the two modes that have them
  // (`after_field`'s anchor checks), so the rules would sit written-and-never-run
  // until their slice landed — tested green against a validator that never
  // reached them. Reporting both facts also serves the author better: they learn
  // the mode is not available yet AND that their anchor was wrong, in one pass.
  if (!VISITOR_LOOKUP_SUPPORTED_MODE_SET.has(mode)) {
    failures.push({
      code: 'visitor_lookup_mode_unsupported',
      detail:
        `visitor_lookup.expiry.mode '${mode}' is not yet available; `
        + `supported today: ${VISITOR_LOOKUP_SUPPORTED_MODES.join(', ')}`,
    });
  }

  // § D7 — `until_resolved` needs a destination that can say it finished.
  if (
    mode === 'until_resolved'
    && ctx.target_kind !== undefined
    && !VISITOR_LOOKUP_COMPLETABLE_TARGET_KIND_SET.has(ctx.target_kind)
  ) {
    failures.push({
      code: 'visitor_lookup_target_has_no_completion',
      detail:
        `visitor_lookup.expiry.mode 'until_resolved' needs a destination that reports `
        + `completion; '${ctx.target_kind}' never does. Available: `
        + `${VISITOR_LOOKUP_COMPLETABLE_TARGET_KINDS.join(', ')}`,
    });
  }

  // § D4 — the cross-field rule. ONLY when enabled: a disabled lookup mints
  // nothing, so it needs no vehicle.
  if (c.enabled === true && !ctx.receipt_enabled) {
    failures.push({
      code: 'visitor_lookup_requires_receipt',
      detail:
        'visitor_lookup.enabled requires visitor_receipt.enabled — the receipt is the only '
        + 'surface that hands the submitter their link, so without it the credential reaches '
        + 'nobody',
    });
  }

  return failures;
};

// ════════════════════════════════════════════════════════════════
// Expiry resolution (D-240 slice 2)
// ════════════════════════════════════════════════════════════════

/** The two shapes a visitor-supplied anchor may take, matching what the intake
 *  renderer emits: `date` → `YYYY-MM-DD`, `datetime` → a WALL-CLOCK
 *  `YYYY-MM-DDTHH:MM` with no zone (`intake-form-config.ts` pins both).
 *
 *  ⛔⛔ STRICT ON PURPOSE, BECAUSE THE SUBMISSION VALIDATOR IS NOT. That layer
 *  accepts any `Date.parse`-able string — and `Date.parse('2099')` is a VALID
 *  DATE. A submitter (or a crafted POST, which is not bound by the rendered
 *  input type at all) could otherwise anchor on a bare year.
 *
 *  🔑 TWO FENCES, DIFFERENT FAILURES, AND BOTH ARE NEEDED. The shape check stops
 *  `'2099'` from parsing at all; the CLAMP stops `'2099-01-01'` from mattering.
 *  Neither substitutes for the other: without the clamp a well-formed far date
 *  wins, and without the shape check a malformed one becomes a date nobody
 *  typed. */
const ANCHOR_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ANCHOR_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;

/** Parse a visitor-supplied anchor, or `null` for anything that is not exactly
 *  one of the two shapes.
 *
 *  ⚠ A `datetime` anchor is a wall clock with no zone, so it reads in the
 *  server's local zone. Against a ttl measured in days that is noise; it is
 *  named here so nobody later mistakes it for a bug. */
export const parseVisitorLookupAnchor = (raw: unknown): number | null => {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!ANCHOR_DATE_ONLY.test(trimmed) && !ANCHOR_DATE_TIME.test(trimmed)) return null;
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return null;

  // ⛔⛔ ROUND-TRIP, BECAUSE THE SHAPE CHECK IS NOT A CALENDAR. `'2026-02-31'`
  // matches the regex and `Date.parse` does not reject it — it ROLLS OVER to
  // March 3rd. So a date that does not exist was being honoured as a visitor
  // anchor instead of taking the fail-closed default, and a leap-day typo
  // (`'2027-02-29'`) silently moved to March 1st.
  //
  // ⚠ The clamp bounds the DAMAGE (a rolled-over date is only ever days out),
  // which is why this is a correctness fix rather than a security one. It still
  // matters: the whole point of `anchor: 'field' | 'fallback'` is telling the
  // owner when their form's anchor is not working, and a rolled-over date
  // reported as `'field'` says the opposite.
  // ⛔⛔ COMPARED IN THE FRAME IT WAS PARSED IN, and my first cut got this wrong
  // in a way that would have broken EVERY plain date. ECMAScript parses a
  // date-ONLY ISO string as UTC and a zone-less date-TIME as LOCAL. Reading both
  // back with `getDate()` rejected `'2026-06-15'` on any machine behind UTC —
  // midnight UTC is the previous evening locally — so every `after_field` config
  // would have silently fallen back to the default window, with the owner warned
  // that their anchor "did not parse".
  //
  // ⇒ Same-frame comparison: UTC accessors for the date-only shape, local ones
  // for the wall-clock shape. Caught by probing the parser against real values
  // rather than trusting the round-trip idea.
  const dateOnly = ANCHOR_DATE_ONLY.test(trimmed);
  const [datePart] = trimmed.split('T');
  const [y, m, d] = datePart!.split('-').map(Number);
  const round = new Date(parsed);
  const gotY = dateOnly ? round.getUTCFullYear() : round.getFullYear();
  const gotM = (dateOnly ? round.getUTCMonth() : round.getMonth()) + 1;
  const gotD = dateOnly ? round.getUTCDate() : round.getDate();
  if (gotY !== y || gotM !== m || gotD !== d) return null;
  return parsed;
};

/** What the submit path knows when it mints. `slot_end_at` is present only for a
 *  booking; `field_value` only for `after_field` (slice 5). */
export interface VisitorLookupExpiryInputs {
  readonly expiry: VisitorLookupExpiry;
  /** Mint time. Also the `ceiling_at` anchor for EVERY mode. */
  readonly now: number;
  /** `after_event` — the booking slot's own end (`slot.end_at`). */
  readonly slot_end_at?: number;
  /** `after_field` — the RAW value the visitor submitted for the anchor field.
   *  Unknown-typed because it comes straight off a submission; parsing it is
   *  this module's job, not the caller's. */
  readonly field_value?: unknown;
}

/** ⛔ `expires_at` IS NULLABLE HERE AND THAT IS THE WHOLE `until_resolved` ARM
 *  (slice 4): the anchor does not exist yet at mint. `ceiling_at` is NEVER null,
 *  for every mode, because it is the § D10 backstop — `purge()` cannot collect a
 *  row whose only expiry column is NULL. */
export type VisitorLookupExpiryResolution =
  | {
      readonly kind: 'resolved';
      readonly expires_at: number;
      readonly ceiling_at: number;
      /** D-240 slice 5 — WHERE the expiry came from, for `after_field` only.
       *  `'fallback'` means the visitor's anchor was unusable and the
       *  conservative default was applied — which the mint LOGS, because a form
       *  whose anchor never parses would otherwise silently issue short links
       *  forever and look like it was working. Absent for the other modes. */
      readonly anchor?: 'field' | 'fallback';
    }
  /** D-240 slice 4 — `until_resolved`: no anchor exists yet, so the mint stores
   *  the grace and the credential lives until `ceiling_at` until the stamp sweep
   *  finds its record resolved.
   *
   *  ⚠ ITS OWN ARM RATHER THAN `expires_at: null` ON THE ONE ABOVE — the spec
   *  wrote it the other way, and a nullable field would have made every consumer
   *  handle a null it mostly cannot get. A distinct kind makes the deferred case
   *  a branch the compiler asks about. */
  | {
      readonly kind: 'deferred';
      readonly grace_ms: number;
      readonly ceiling_at: number;
    }
  | { readonly kind: 'unsupported'; readonly mode: VisitorLookupMode }
  /** `after_event` with no slot to anchor on — a booking row that somehow
   *  carries no end. Refused rather than silently defaulted: a mint that quietly
   *  substituted a different anchor would hand the visitor a link whose lifetime
   *  no config predicts. */
  | { readonly kind: 'anchor_missing'; readonly mode: VisitorLookupMode };

/** Compute a credential's expiry from its config at mint time. Pure.
 *
 *  ⚠ THE CLAMP IS APPLIED HERE, NOT ONLY AT THE VALIDATOR. The validator bounds
 *  what an AUTHOR may type; this bounds what the arithmetic PRODUCES — and for
 *  `after_event` those differ, because the anchor is a slot date the author
 *  never saw. A booking three years out plus a legitimate 30-day grace is a
 *  three-year credential unless something clamps the SUM. */
export const resolveVisitorLookupExpiry = (
  inputs: VisitorLookupExpiryInputs,
): VisitorLookupExpiryResolution => {
  const { expiry, now } = inputs;
  const ceiling_at = now + VISITOR_LOOKUP_ABSOLUTE_CEILING_MS;

  if (!VISITOR_LOOKUP_SUPPORTED_MODE_SET.has(expiry.mode)) {
    return { kind: 'unsupported', mode: expiry.mode };
  }

  if (expiry.mode === 'fixed') {
    return { kind: 'resolved', expires_at: now + expiry.ttl_ms, ceiling_at };
  }

  if (expiry.mode === 'until_resolved') {
    return { kind: 'deferred', grace_ms: expiry.grace_ms, ceiling_at };
  }

  if (expiry.mode === 'after_field') {
    const anchor = parseVisitorLookupAnchor(inputs.field_value);
    if (anchor === null) {
      // ⛔⛔ FAILS CLOSED — TO THE `fixed` DEFAULT, NEVER TO "no expiry", AND
      // NEVER TO A REFUSAL. The polarity is the whole rule: garbage must mean
      // SHORT. And it must not mean NOTHING either — refusing here would leave a
      // submitter with no link at all because they typed a date oddly, which is
      // a worse answer than a conservative window.
      return {
        kind: 'resolved',
        expires_at: now + VISITOR_LOOKUP_DEFAULT_TTL_MS,
        ceiling_at,
        anchor: 'fallback',
      };
    }
    // Same edge rule as `after_event`, deliberately: an anchor already in the
    // past still yields a usable window from now. The receipt is handed over at
    // submit, so an expiry behind the mint is a link that never worked once.
    const anchored = Math.max(now, anchor) + expiry.ttl_ms;
    return {
      kind: 'resolved',
      expires_at: Math.min(anchored, now + VISITOR_LOOKUP_MAX_TTL_MS),
      ceiling_at,
      anchor: 'field',
    };
  }

  // `after_event` — the only other supported mode today.
  const slotEnd = inputs.slot_end_at;
  if (typeof slotEnd !== 'number' || !Number.isFinite(slotEnd)) {
    return { kind: 'anchor_missing', mode: expiry.mode };
  }
  const grace = (expiry as { grace_ms: number }).grace_ms;
  // ⚠ `Math.max(now, slotEnd)` — a booking already in the PAST must still give
  // the submitter their grace window from now, not a link that arrives dead.
  // The receipt is handed over at submit, so an expiry behind the mint is a link
  // that never worked once.
  const anchored = Math.max(now, slotEnd) + grace;
  return {
    kind: 'resolved',
    expires_at: Math.min(anchored, now + VISITOR_LOOKUP_MAX_TTL_MS),
    ceiling_at,
  };
};
