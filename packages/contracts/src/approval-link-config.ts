/** D-149 P8 § A.5.5 — `approval_link` per-endpoint config contract.
 *
 *  Each `approval_link` endpoint stores an `ApprovalLinkConfig` blob
 *  inside the `public_endpoint_registry.metadata_blob` column. The
 *  reception handler reads the blob at request time + renders the
 *  consent form (GET) / consumes the approval intent (POST); the rpc
 *  admin layer writes the blob via `reception.endpoint.create` (the
 *  same path the other link-style kinds use).
 *
 *  Approval-link is a SCOPED single-purpose action surface. Each link
 *  binds exactly ONE narrow action (`action_kind`) to one target
 *  (`target_id`); the visitor performs the action, the substrate flips
 *  `consumed_at` atomically, and engine-side reactive triggers fire
 *  the downstream effect.
 *
 *  Validators in this file:
 *
 *    - Closed-shape gate on every field (defense in depth at the rpc
 *      edge before the registry write).
 *    - `display_name` / `prompt` / `context_summary` / `success_message`
 *      / `submit_button_label` length bounds so the rendered HTML stays
 *      compact + the no-leak surface stays bounded.
 *    - `action_kind` ∈ `ApprovalLinkActionKind` closed list.
 *    - `options[*]` ⊆ `[1, APPROVAL_LINK_OPTIONS_MAX]` for the
 *      pick_time / confirm_attendance action kinds; rejected as
 *      structurally absent for the other three action kinds (per spec
 *      § A.5.5 line 859 — `options` is closed list for those two only).
 *    - `expiry_days` ∈ `[1, 30]` per spec § N.4 — approval_link is
 *      link-style with a hard 30d ceiling regardless of user config.
 *    - `visitor_field_constraints.{name,email}` ∈ `'required' | 'optional'`
 *      per spec § A.5.5 line 861-865.
 *    - `visitor_field_constraints.require_email_match` (optional) MUST
 *      be a well-formed email when present (soft trust layer per
 *      § A.5.5 line 911).
 *    - `on_action.target_id` is a non-empty string.
 *    - `on_action.on_approve_action` ∈ closed list per § A.5.5 line 869.
 *    - `on_action.notification_target` ∈ closed list per § A.5.5
 *      line 870.
 *
 *  Privacy contract (§ A.5.5 + § A.4):
 *
 *    - The redacted packet exposes ONLY the action_kind + prompt +
 *      options + expiry_display + visitor_field_constraints +
 *      context_summary.
 *    - It NEVER exposes counterparty aliases, private notes, target_id,
 *      on_action callback config, `triggered_recipe_id`, or anything
 *      else from the config blob — those stay server-side at every step.
 *
 *  The substrate enforces the privacy contract via the closed-shape
 *  `RedactedPacketPayloadByKind['approval_link_packet']` map in
 *  `redacted-packets.ts`; this config file gates the *config blob*
 *  shape at admin-write time so a corrupt config never reaches the
 *  visitor path.
 *
 *  Spec: `docs/d-149-spec.md` § A.5.5 + § Must Hold I-11 + I-12. */

import {
  APPROVAL_LINK_ACTION_KIND_SET,
  type ApprovalLinkActionKind,
  type ApprovalLinkOption,
  type ApprovalLinkVisitorFieldConstraints,
} from './redacted-packets.js';
import {
  validateVisitorReceiptConfig,
  type VisitorReceiptConfig,
} from './visitor-receipt-config.js';

// ────────────────────────────────────────────────────────────────
// Closed-list bound constants
// ────────────────────────────────────────────────────────────────

/** Expiry ceiling per § N.4 — approval_link link-style; max 30 days. */
export const APPROVAL_LINK_EXPIRY_DAYS_MAX = 30;
export const APPROVAL_LINK_EXPIRY_DAYS_MIN = 1;
export const APPROVAL_LINK_EXPIRY_DAYS_DEFAULT = 7;

/** Display surfaces — same bounds as intake_form / drop_link so the
 *  renderer's HTML stays compact + the no-leak surface stays bounded. */
export const APPROVAL_LINK_DISPLAY_NAME_MAX = 100;
export const APPROVAL_LINK_PROMPT_MAX = 800;
export const APPROVAL_LINK_CONTEXT_SUMMARY_MAX = 800;
export const APPROVAL_LINK_SUCCESS_MESSAGE_MAX = 400;
export const APPROVAL_LINK_SUBMIT_BUTTON_LABEL_MAX = 60;
export const APPROVAL_LINK_OPTION_LABEL_MAX = 120;
export const APPROVAL_LINK_OPTION_DESCRIPTION_MAX = 400;
export const APPROVAL_LINK_OPTION_ID_MAX = 80;

/** Number-of-options bounds. Spec § A.5.5 doesn't pin an upper bound;
 *  16 is a practical ceiling — beyond that the picker UI degrades
 *  AND the brute-force surface widens. */
export const APPROVAL_LINK_OPTIONS_MIN = 1;
export const APPROVAL_LINK_OPTIONS_MAX = 16;

/** Visitor-supplied text caps. Sub_dek-encrypted in
 *  `reception_approval_intent.consumed_*_encrypted`; the cap is what
 *  the renderer's `<input maxlength=…>` advertises + what the handler
 *  enforces server-side. */
export const APPROVAL_LINK_VISITOR_NAME_MAX = 200;
export const APPROVAL_LINK_VISITOR_EMAIL_MAX = 254;
export const APPROVAL_LINK_VISITOR_ANSWER_MAX = 4000;
export const APPROVAL_LINK_VISITOR_COMMENT_MAX = 4000;

/** Substrate-default labels surfaced when the config omits the field. */
export const APPROVAL_LINK_DEFAULT_SUBMIT_BUTTON_LABEL = 'Submit' as const;
export const APPROVAL_LINK_DEFAULT_SUCCESS_MESSAGE =
  'Your response has been received. Thank you.' as const;

/** Closed list of `on_action.on_approve_action` values per spec
 *  § A.5.5 line 869. */
export const APPROVAL_LINK_ON_APPROVE_ACTIONS = [
  'mark_resolved',
  'create_commitment',
  'fire_recipe',
] as const;

export type ApprovalLinkOnApproveAction =
  (typeof APPROVAL_LINK_ON_APPROVE_ACTIONS)[number];

export const APPROVAL_LINK_ON_APPROVE_ACTION_SET: ReadonlySet<ApprovalLinkOnApproveAction> =
  new Set(APPROVAL_LINK_ON_APPROVE_ACTIONS);

/** Closed list of `reception_approval_intent.processing_outcome` values
 *  the substrate writes. The handler writes `'pending'` on a fresh
 *  consumption; the engine reactive path flips to terminal states. */
export const APPROVAL_LINK_PROCESSING_OUTCOMES = [
  'pending',
  'processed',
  'failed',
] as const;

export type ApprovalLinkProcessingOutcome =
  (typeof APPROVAL_LINK_PROCESSING_OUTCOMES)[number];

export const APPROVAL_LINK_PROCESSING_OUTCOME_SET: ReadonlySet<ApprovalLinkProcessingOutcome> =
  new Set(APPROVAL_LINK_PROCESSING_OUTCOMES);

/** Codex review (spec § A.5.5 line 861-865) — visitor fields are
 *  `'required' | 'optional'`; no `'omit'` variant for approval_link.
 *  The handler always renders both fields (per the spec's "visitor
 *  identifies themselves" intent); whether they're enforced depends
 *  on this setting. */
const APPROVAL_LINK_VISITOR_FIELD_VALUES: ReadonlySet<'required' | 'optional'> =
  new Set<'required' | 'optional'>(['required', 'optional']);

// ────────────────────────────────────────────────────────────────
// Config shape (admin-side; persisted via metadata_blob)
// ────────────────────────────────────────────────────────────────

/** Closed-shape on-action bundle per spec § A.5.5 line 867-871. Engine-
 *  side reactive trigger consumes the row + materialises the downstream
 *  effect (resolve the proposal / create commitment / fire recipe). */
export interface ApprovalLinkOnActionConfig {
  readonly target_id: string;
  readonly on_approve_action: ApprovalLinkOnApproveAction;
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
  /** Optional reactive-recipe id when `on_approve_action === 'fire_recipe'`.
   *  Stored verbatim; engine reactive path resolves at consume time. */
  // D-210 Phase C — `triggered_recipe_id` RETIRED (owner ruling, 2026-07-18).
  // It was a hook on the auto-accept path, and the contract already called it
  // legacy: "Reviewed responses use the canonical `form_response.accepted`
  // trigger instead." With `auto_accept` retired its whole scope went, and its
  // named replacement does NOT cover the approve moment either — WS2 moved that
  // trigger to SUBMIT time.
  //
  // The capability survives without a per-endpoint string: the approve leg
  // creates the DESTINATION entity, so a reactive recipe on that collection's
  // `created` event fires exactly when the owner approves. (A LOG-ONLY intake
  // mints no destination and so has no such signal — a post-approval event is
  // the way to close that, not this field.)
  // The validator REFUSES a stale key rather than ignoring it.
  // D-210 Phase C — `auto_accept` RETIRED (owner ruling, 2026-07-18), with
  // the intake + drop_link flags. A consumed approval's `create_commitment`
  // now always holds at the D-157 gate and is reviewed in the inbox.
  // `mark_resolved` / `fire_recipe` route through their own effect seam and
  // were never governed by this flag.
}

/** Singleton-config blob persisted in the registry row's `metadata_blob`.
 *  Read at every approval-form render + POST consume; write only via
 *  `reception.endpoint.create` / future update rpcs. */
export interface ApprovalLinkConfig {
  /** Visitor-facing display name on the form (typically Mary's first
   *  name or handle). Length-bounded so the renderer's `<title>` +
   *  `<h1>` stay compact + the HTML payload is small. */
  readonly display_name: string;
  /** The scoped action this link grants. Closed list per spec
   *  § A.5.5 line 847-852. */
  readonly action_kind: ApprovalLinkActionKind;
  /** The visitor-visible prompt. Length-bounded; htmlEscape'd at
   *  render time. */
  readonly prompt: string;
  /** Optional context summary the visitor sees alongside the prompt.
   *  This is the REDACTED summary — counterparty aliases + private
   *  notes are stripped via `context_raw → context_summary` at the
   *  packet boundary; the config blob carries the raw context and the
   *  substrate redacts at render time. */
  readonly context_raw: {
    readonly summary: string;
    readonly counterparty_aliases?: ReadonlyArray<string>;
    readonly private_notes?: ReadonlyArray<string>;
  };
  /** Required for `'pick_time' | 'confirm_attendance'`; rejected
   *  otherwise. Each option carries an id + label + optional
   *  description; rendering as radio buttons (single-select). */
  readonly options?: ReadonlyArray<ApprovalLinkOption>;
  /** Per spec § A.5.5 line 861-865 — visitor self-identification
   *  requirements. `require_email_match` (optional) gates against a
   *  specific email at the soft-trust layer. */
  readonly visitor_field_constraints: ApprovalLinkVisitorFieldConstraints;
  /** Link-style expiry days. Clamps within `[1, 30]`; the substrate
   *  derives `expires_at = created_at + expiry_days * 24h`. */
  readonly expiry_days: number;
  /** Per spec § A.5.5 line 867-871 — engine reactive trigger inputs. */
  readonly on_action: ApprovalLinkOnActionConfig;
  /** Optional confirmation-page copy. Defaults to the substrate's
   *  generic success message if absent. */
  readonly success_message?: string;
  /** Optional submit-button label. Defaults to "Submit". */
  readonly submit_button_label?: string;
  /** Optional Foundation-pack template reference. Free-form string at
   *  the substrate; the marketplace tracks the closed list. */
  readonly template_ref?: string;
  /** D-149 § A.20.3 — optional per-endpoint visitor-receipt config.
   *  Absent ⇒ receipts disabled (opt-in). When `enabled`, the POST
   *  consume handler renders a receipt (reference id + field echo +
   *  privacy footer) on the response success page. */
  readonly visitor_receipt?: VisitorReceiptConfig;
}

// ────────────────────────────────────────────────────────────────
// Validator
// ────────────────────────────────────────────────────────────────

export type ApprovalLinkConfigValidationCode =
  | 'config_shape_invalid'
  | 'display_name_empty'
  | 'display_name_too_long'
  | 'action_kind_unknown'
  | 'prompt_empty'
  | 'prompt_too_long'
  | 'context_raw_invalid'
  | 'context_summary_empty'
  | 'context_summary_too_long'
  | 'counterparty_aliases_invalid'
  | 'private_notes_invalid'
  | 'options_required_for_action_kind'
  | 'options_not_permitted_for_action_kind'
  | 'options_shape_invalid'
  | 'options_too_few'
  | 'options_too_many'
  | 'options_duplicate_id'
  | 'option_id_invalid'
  | 'option_label_invalid'
  | 'option_description_invalid'
  | 'visitor_field_constraints_invalid'
  | 'visitor_field_name_invalid'
  | 'visitor_field_email_invalid'
  | 'require_email_match_invalid'
  | 'expiry_days_out_of_range'
  | 'on_action_invalid'
  | 'on_action_target_id_invalid'
  | 'on_approve_action_unknown'
  | 'notification_target_unknown'
  | 'triggered_recipe_id_invalid'
  | 'success_message_too_long'
  | 'submit_button_label_too_long'
  | 'template_ref_invalid'
  | 'visitor_receipt_invalid';

export interface ApprovalLinkConfigValidationFailure {
  readonly code: ApprovalLinkConfigValidationCode;
  readonly detail: string;
}

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0;

const isFiniteIntegerInRange = (
  v: unknown,
  min: number,
  max: number,
): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** Closed list of action kinds that REQUIRE `options[]`. The remaining
 *  three (approve_wording / answer_question / upload_doc) MUST omit
 *  options entirely. */
const ACTION_KINDS_REQUIRING_OPTIONS: ReadonlySet<ApprovalLinkActionKind> =
  new Set<ApprovalLinkActionKind>(['pick_time', 'confirm_attendance']);

/** Pragmatic email shape check. Same as the form-config validator —
 *  full RFC-5321 conformance is the visitor's domain; we just gate the
 *  obvious "not an email" inputs. */
const looksLikeEmail = (v: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(v);

const isApprovalOption = (v: unknown): v is ApprovalLinkOption => {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (!isNonEmptyString(o.id)) return false;
  if (!isNonEmptyString(o.label)) return false;
  if (o.description !== undefined && typeof o.description !== 'string') return false;
  return true;
};

/** Validate an `ApprovalLinkConfig`. Pure function — no I/O. Returns the
 *  list of failures; empty array ⇒ valid. */
export const validateApprovalLinkConfig = (
  config: unknown,
): ReadonlyArray<ApprovalLinkConfigValidationFailure> => {
  const failures: ApprovalLinkConfigValidationFailure[] = [];
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    failures.push({
      code: 'config_shape_invalid',
      detail: 'approval_link config must be an object',
    });
    return failures;
  }
  const c = config as Record<string, unknown>;

  // display_name
  if (
    !isNonEmptyString(c.display_name) ||
    (c.display_name as string).trim().length === 0
  ) {
    failures.push({ code: 'display_name_empty', detail: 'display_name must be non-empty' });
  } else if ((c.display_name as string).length > APPROVAL_LINK_DISPLAY_NAME_MAX) {
    failures.push({
      code: 'display_name_too_long',
      detail: `display_name must be ≤ ${APPROVAL_LINK_DISPLAY_NAME_MAX} characters`,
    });
  }

  // action_kind
  let actionKind: ApprovalLinkActionKind | null = null;
  if (typeof c.action_kind !== 'string' || !APPROVAL_LINK_ACTION_KIND_SET.has(c.action_kind as ApprovalLinkActionKind)) {
    failures.push({
      code: 'action_kind_unknown',
      detail: `action_kind must be one of ${[...APPROVAL_LINK_ACTION_KIND_SET].join(' | ')}`,
    });
  } else {
    actionKind = c.action_kind as ApprovalLinkActionKind;
  }

  // prompt
  if (!isNonEmptyString(c.prompt) || (c.prompt as string).trim().length === 0) {
    failures.push({ code: 'prompt_empty', detail: 'prompt must be non-empty' });
  } else if ((c.prompt as string).length > APPROVAL_LINK_PROMPT_MAX) {
    failures.push({
      code: 'prompt_too_long',
      detail: `prompt must be ≤ ${APPROVAL_LINK_PROMPT_MAX} characters`,
    });
  }

  // context_raw
  if (c.context_raw === null || typeof c.context_raw !== 'object' || Array.isArray(c.context_raw)) {
    failures.push({
      code: 'context_raw_invalid',
      detail: 'context_raw must be an object with at least a `summary` field',
    });
  } else {
    const ctx = c.context_raw as Record<string, unknown>;
    if (!isNonEmptyString(ctx.summary) || (ctx.summary as string).trim().length === 0) {
      failures.push({
        code: 'context_summary_empty',
        detail: 'context_raw.summary must be non-empty',
      });
    } else if ((ctx.summary as string).length > APPROVAL_LINK_CONTEXT_SUMMARY_MAX) {
      failures.push({
        code: 'context_summary_too_long',
        detail: `context_raw.summary must be ≤ ${APPROVAL_LINK_CONTEXT_SUMMARY_MAX} characters`,
      });
    }
    if (ctx.counterparty_aliases !== undefined) {
      if (
        !Array.isArray(ctx.counterparty_aliases) ||
        ctx.counterparty_aliases.some((v) => typeof v !== 'string')
      ) {
        failures.push({
          code: 'counterparty_aliases_invalid',
          detail: 'context_raw.counterparty_aliases must be a string[] when present',
        });
      }
    }
    if (ctx.private_notes !== undefined) {
      if (
        !Array.isArray(ctx.private_notes) ||
        ctx.private_notes.some((v) => typeof v !== 'string')
      ) {
        failures.push({
          code: 'private_notes_invalid',
          detail: 'context_raw.private_notes must be a string[] when present',
        });
      }
    }
  }

  // options — required iff action_kind ∈ {pick_time, confirm_attendance}
  if (actionKind !== null) {
    const needsOptions = ACTION_KINDS_REQUIRING_OPTIONS.has(actionKind);
    if (needsOptions) {
      if (!Array.isArray(c.options)) {
        failures.push({
          code: 'options_required_for_action_kind',
          detail: `options[] is required for action_kind='${actionKind}'`,
        });
      } else if (c.options.length < APPROVAL_LINK_OPTIONS_MIN) {
        failures.push({
          code: 'options_too_few',
          detail: `options[] must have at least ${APPROVAL_LINK_OPTIONS_MIN} entry`,
        });
      } else if (c.options.length > APPROVAL_LINK_OPTIONS_MAX) {
        failures.push({
          code: 'options_too_many',
          detail: `options[] must have at most ${APPROVAL_LINK_OPTIONS_MAX} entries`,
        });
      } else {
        const seenIds = new Set<string>();
        for (const opt of c.options) {
          if (!isApprovalOption(opt)) {
            failures.push({
              code: 'options_shape_invalid',
              detail: 'each option must be `{ id, label, description? }` with non-empty id+label',
            });
            break;
          }
          if (opt.id.length > APPROVAL_LINK_OPTION_ID_MAX) {
            failures.push({
              code: 'option_id_invalid',
              detail: `option.id must be ≤ ${APPROVAL_LINK_OPTION_ID_MAX} characters`,
            });
            break;
          }
          if (opt.label.length > APPROVAL_LINK_OPTION_LABEL_MAX) {
            failures.push({
              code: 'option_label_invalid',
              detail: `option.label must be ≤ ${APPROVAL_LINK_OPTION_LABEL_MAX} characters`,
            });
            break;
          }
          if (
            opt.description !== undefined &&
            opt.description.length > APPROVAL_LINK_OPTION_DESCRIPTION_MAX
          ) {
            failures.push({
              code: 'option_description_invalid',
              detail: `option.description must be ≤ ${APPROVAL_LINK_OPTION_DESCRIPTION_MAX} characters`,
            });
            break;
          }
          if (seenIds.has(opt.id)) {
            failures.push({
              code: 'options_duplicate_id',
              detail: `options[] contains duplicate id='${opt.id}'`,
            });
            break;
          }
          seenIds.add(opt.id);
        }
      }
    } else {
      // approve_wording / answer_question / upload_doc — options must be absent.
      if (c.options !== undefined) {
        failures.push({
          code: 'options_not_permitted_for_action_kind',
          detail: `options[] is not permitted for action_kind='${actionKind}'`,
        });
      }
    }
  }

  // visitor_field_constraints
  if (
    c.visitor_field_constraints === null ||
    typeof c.visitor_field_constraints !== 'object' ||
    Array.isArray(c.visitor_field_constraints)
  ) {
    failures.push({
      code: 'visitor_field_constraints_invalid',
      detail: 'visitor_field_constraints must be an object with name + email entries',
    });
  } else {
    const v = c.visitor_field_constraints as Record<string, unknown>;
    if (typeof v.name !== 'string' || !APPROVAL_LINK_VISITOR_FIELD_VALUES.has(v.name as 'required' | 'optional')) {
      failures.push({
        code: 'visitor_field_name_invalid',
        detail: "visitor_field_constraints.name must be 'required' | 'optional'",
      });
    }
    if (
      typeof v.email !== 'string' ||
      !APPROVAL_LINK_VISITOR_FIELD_VALUES.has(v.email as 'required' | 'optional')
    ) {
      failures.push({
        code: 'visitor_field_email_invalid',
        detail: "visitor_field_constraints.email must be 'required' | 'optional'",
      });
    }
    if (v.require_email_match !== undefined) {
      if (typeof v.require_email_match !== 'string' || !looksLikeEmail(v.require_email_match)) {
        failures.push({
          code: 'require_email_match_invalid',
          detail: 'visitor_field_constraints.require_email_match must be a well-formed email',
        });
      } else if (v.require_email_match.length > APPROVAL_LINK_VISITOR_EMAIL_MAX) {
        failures.push({
          code: 'require_email_match_invalid',
          detail: `visitor_field_constraints.require_email_match must be ≤ ${APPROVAL_LINK_VISITOR_EMAIL_MAX} characters`,
        });
      }
    }
  }

  // expiry_days
  if (
    !isFiniteIntegerInRange(
      c.expiry_days,
      APPROVAL_LINK_EXPIRY_DAYS_MIN,
      APPROVAL_LINK_EXPIRY_DAYS_MAX,
    )
  ) {
    failures.push({
      code: 'expiry_days_out_of_range',
      detail: `expiry_days must be an integer in [${APPROVAL_LINK_EXPIRY_DAYS_MIN}, ${APPROVAL_LINK_EXPIRY_DAYS_MAX}]`,
    });
  }

  // on_action
  if (c.on_action === null || typeof c.on_action !== 'object' || Array.isArray(c.on_action)) {
    failures.push({
      code: 'on_action_invalid',
      detail: 'on_action must be an object',
    });
  } else {
    const oa = c.on_action as Record<string, unknown>;
    if (!isNonEmptyString(oa.target_id)) {
      failures.push({
        code: 'on_action_target_id_invalid',
        detail: 'on_action.target_id must be a non-empty string',
      });
    }
    if (
      typeof oa.on_approve_action !== 'string' ||
      !APPROVAL_LINK_ON_APPROVE_ACTION_SET.has(oa.on_approve_action as ApprovalLinkOnApproveAction)
    ) {
      failures.push({
        code: 'on_approve_action_unknown',
        detail: `on_action.on_approve_action must be one of ${[...APPROVAL_LINK_ON_APPROVE_ACTION_SET].join(' | ')}`,
      });
    }
    // D-210 Phase C — retired; refuse a stale key (see the removal note).
    if ((oa as { notification_target?: unknown }).notification_target !== undefined) {
      failures.push({
        code: 'notification_target_unknown',
        detail:
          'on_action.notification_target has been retired — notification channels are '
          + 'chosen in Settings, and the inbox fanout mode picks the surface. Remove the field.',
      });
    }
    // D-210 Phase C — retired; refuse a stale key (see the field's removal note).
    if (oa.triggered_recipe_id !== undefined) {
      failures.push({
        code: 'triggered_recipe_id_invalid',
        detail:
          'on_action.triggered_recipe_id has been retired — watch the materialized '
          + "commitment's `created` event instead. Remove the field.",
      });
    }
    // D-210 Phase C — `auto_accept` is RETIRED. Refuse a stale key rather than
    // ignoring it: it used to mean "materialize the commitment without
    // review", and an endpoint still carrying it now holds instead. Safe
    // direction, but silent — so say it. (This field previously had NO
    // validator arm at all; it was declared and read, never checked.)
    if (oa.auto_accept !== undefined) {
      failures.push({
        code: 'on_action_invalid',
        detail:
          'on_action.auto_accept has been retired — an approved commitment is held for '
          + 'review in the inbox. Remove the field.',
      });
    }
  }

  // success_message
  if (c.success_message !== undefined) {
    if (typeof c.success_message !== 'string') {
      failures.push({
        code: 'success_message_too_long',
        detail: 'success_message must be a string when present',
      });
    } else if (c.success_message.length > APPROVAL_LINK_SUCCESS_MESSAGE_MAX) {
      failures.push({
        code: 'success_message_too_long',
        detail: `success_message must be ≤ ${APPROVAL_LINK_SUCCESS_MESSAGE_MAX} characters`,
      });
    }
  }

  // submit_button_label
  if (c.submit_button_label !== undefined) {
    if (typeof c.submit_button_label !== 'string') {
      failures.push({
        code: 'submit_button_label_too_long',
        detail: 'submit_button_label must be a string when present',
      });
    } else if (c.submit_button_label.length > APPROVAL_LINK_SUBMIT_BUTTON_LABEL_MAX) {
      failures.push({
        code: 'submit_button_label_too_long',
        detail: `submit_button_label must be ≤ ${APPROVAL_LINK_SUBMIT_BUTTON_LABEL_MAX} characters`,
      });
    }
  }

  // template_ref
  if (c.template_ref !== undefined) {
    if (typeof c.template_ref !== 'string' || c.template_ref.length === 0 || c.template_ref.length > 100) {
      failures.push({
        code: 'template_ref_invalid',
        detail: 'template_ref must be a non-empty string ≤ 100 characters when present',
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
// Approval consumption (handler → store contract)
// ────────────────────────────────────────────────────────────────

/** Submitted-outcome shape encoded into `consumed_outcome_encrypted`.
 *  Closed taxonomy per spec § A.5.5 line 881 + line 898-902. The handler
 *  builds this from the parsed form body, validator runs, then the
 *  store seals + flips `consumed_at` atomically. */
export type ApprovalLinkConsumedOutcome =
  | { readonly kind: 'pick'; readonly option_id: string }
  | { readonly kind: 'approve' }
  | { readonly kind: 'reject'; readonly comment?: string }
  | { readonly kind: 'confirm'; readonly answer: 'yes' | 'no' }
  | { readonly kind: 'answer'; readonly answer: string };

/** Handler-side validation contract for a POST consume request. The
 *  per-action-kind branch resolves the visitor's submission into one
 *  of the closed-shape outcomes above. */
export interface ApprovalLinkConsumeInput {
  readonly visitor_name?: string;
  readonly visitor_email?: string;
  readonly outcome: ApprovalLinkConsumedOutcome;
}

export type ApprovalLinkConsumeValidationCode =
  | 'visitor_name_too_long'
  | 'visitor_email_too_long'
  | 'visitor_email_invalid'
  | 'visitor_email_match_failed'
  | 'visitor_email_required'
  | 'visitor_name_required'
  | 'option_id_unknown'
  | 'answer_required'
  | 'answer_too_long'
  | 'comment_too_long'
  | 'action_kind_mismatch';

export interface ApprovalLinkConsumeValidationFailure {
  readonly code: ApprovalLinkConsumeValidationCode;
  readonly detail: string;
}

/** Validate a consume input against a config. Pure function — no I/O.
 *  Returns the list of failures; empty array ⇒ valid. */
export const validateApprovalLinkConsume = (
  input: ApprovalLinkConsumeInput,
  config: ApprovalLinkConfig,
): ReadonlyArray<ApprovalLinkConsumeValidationFailure> => {
  const failures: ApprovalLinkConsumeValidationFailure[] = [];

  const { visitor_field_constraints: v } = config;
  if (v.name === 'required' && (input.visitor_name === undefined || input.visitor_name.trim().length === 0)) {
    failures.push({
      code: 'visitor_name_required',
      detail: 'visitor_name is required by visitor_field_constraints',
    });
  }
  if (input.visitor_name !== undefined && input.visitor_name.length > APPROVAL_LINK_VISITOR_NAME_MAX) {
    failures.push({
      code: 'visitor_name_too_long',
      detail: `visitor_name must be ≤ ${APPROVAL_LINK_VISITOR_NAME_MAX} characters`,
    });
  }

  const email = input.visitor_email;
  if (v.email === 'required' && (email === undefined || email.trim().length === 0)) {
    failures.push({
      code: 'visitor_email_required',
      detail: 'visitor_email is required by visitor_field_constraints',
    });
  }
  // Codex review P2 fold (2026-05-13) — `require_email_match` implies a
  // non-empty matching email regardless of the `email: 'required' |
  // 'optional'` setting. Pre-fold the match check was gated inside
  // `email !== undefined && email.length > 0`, so a config with
  // `email: 'optional' + require_email_match: 'mom@example.com'`
  // accepted any visitor who omitted email entirely — bypassing the
  // soft-trust gate the constraint exists for. Lifting the gate out
  // makes the contract crisp: "if require_email_match is set, the
  // visitor MUST supply a matching email." The shape failures
  // (length / format) still run only when email is present so a
  // missing-email caller doesn't get two failure codes for the same
  // omission.
  if (v.require_email_match !== undefined) {
    if (email === undefined || email.trim().length === 0) {
      failures.push({
        code: 'visitor_email_match_failed',
        detail:
          'visitor_email is required by require_email_match and must match the configured address',
      });
    } else if (
      looksLikeEmail(email) &&
      email.trim().toLowerCase() !== v.require_email_match.trim().toLowerCase()
    ) {
      // Soft-trust per spec § A.5.5 line 911 — visitor could lie, but
      // the URL token reaching the right inbox + this self-report
      // check give us a soft authorization layer.
      failures.push({
        code: 'visitor_email_match_failed',
        detail: 'visitor_email does not match the configured require_email_match',
      });
    }
  }
  if (email !== undefined && email.length > 0) {
    if (email.length > APPROVAL_LINK_VISITOR_EMAIL_MAX) {
      failures.push({
        code: 'visitor_email_too_long',
        detail: `visitor_email must be ≤ ${APPROVAL_LINK_VISITOR_EMAIL_MAX} characters`,
      });
    } else if (!looksLikeEmail(email)) {
      failures.push({
        code: 'visitor_email_invalid',
        detail: 'visitor_email is not a well-formed email address',
      });
    }
  }

  // Per-action-kind outcome validation.
  switch (config.action_kind) {
    case 'pick_time': {
      if (input.outcome.kind !== 'pick') {
        failures.push({
          code: 'action_kind_mismatch',
          detail: `outcome.kind='${input.outcome.kind}' does not match action_kind='pick_time'`,
        });
        break;
      }
      const options = config.options ?? [];
      if (!options.some((o) => o.id === (input.outcome as { option_id: string }).option_id)) {
        failures.push({
          code: 'option_id_unknown',
          detail: `option_id='${(input.outcome as { option_id: string }).option_id}' is not in the configured options`,
        });
      }
      break;
    }
    case 'confirm_attendance': {
      if (input.outcome.kind !== 'confirm') {
        failures.push({
          code: 'action_kind_mismatch',
          detail: `outcome.kind='${input.outcome.kind}' does not match action_kind='confirm_attendance'`,
        });
      }
      break;
    }
    case 'approve_wording': {
      if (input.outcome.kind !== 'approve' && input.outcome.kind !== 'reject') {
        failures.push({
          code: 'action_kind_mismatch',
          detail: `outcome.kind='${input.outcome.kind}' does not match action_kind='approve_wording'`,
        });
        break;
      }
      if (input.outcome.kind === 'reject') {
        const reject = input.outcome;
        if (reject.comment !== undefined && reject.comment.length > APPROVAL_LINK_VISITOR_COMMENT_MAX) {
          failures.push({
            code: 'comment_too_long',
            detail: `comment must be ≤ ${APPROVAL_LINK_VISITOR_COMMENT_MAX} characters`,
          });
        }
      }
      break;
    }
    case 'answer_question': {
      if (input.outcome.kind !== 'answer') {
        failures.push({
          code: 'action_kind_mismatch',
          detail: `outcome.kind='${input.outcome.kind}' does not match action_kind='answer_question'`,
        });
        break;
      }
      const answer = input.outcome.answer;
      if (answer.trim().length === 0) {
        failures.push({
          code: 'answer_required',
          detail: 'answer is required for action_kind=answer_question',
        });
      } else if (answer.length > APPROVAL_LINK_VISITOR_ANSWER_MAX) {
        failures.push({
          code: 'answer_too_long',
          detail: `answer must be ≤ ${APPROVAL_LINK_VISITOR_ANSWER_MAX} characters`,
        });
      }
      break;
    }
    case 'upload_doc': {
      // P8 ships the metadata-only branch — the visitor sees an
      // upload prompt but the file flow routes through a companion
      // drop_link per spec § A.5.5 line 902. Substrate accepts an
      // approval-token-style "I'll upload" answer for now.
      if (input.outcome.kind !== 'answer') {
        failures.push({
          code: 'action_kind_mismatch',
          detail: `outcome.kind='${input.outcome.kind}' does not match action_kind='upload_doc'`,
        });
      }
      break;
    }
  }

  return failures;
};

/** Serialize a `consumed_outcome` payload into the canonical wire-shape
 *  string the substrate persists in `consumed_outcome_encrypted` per
 *  spec § A.5.5 line 881 ("`approve` / `reject` / `pick:<option_id>` /
 *  `answer:<text>`"). Pure function. */
export const formatApprovalLinkConsumedOutcome = (
  outcome: ApprovalLinkConsumedOutcome,
): string => {
  switch (outcome.kind) {
    case 'pick':
      return `pick:${outcome.option_id}`;
    case 'approve':
      return 'approve';
    case 'reject':
      return outcome.comment !== undefined && outcome.comment.length > 0
        ? `reject:${outcome.comment}`
        : 'reject';
    case 'confirm':
      return `confirm:${outcome.answer}`;
    case 'answer':
      return `answer:${outcome.answer}`;
  }
};
