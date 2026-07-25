/** D-149 P7 § A.5.4 — `drop_link` per-endpoint config contract.
 *
 *  Each `drop_link` endpoint stores a `DropLinkConfig` blob inside
 *  the `public_endpoint_registry.metadata_blob` column. The reception
 *  handler reads the blob at request time + renders the upload form
 *  (GET) / validates an upload (POST); the rpc admin layer writes the
 *  blob via `reception.endpoint.create` (the same path the other link-
 *  style kinds use).
 *
 *  Validators in this file:
 *
 *    - Closed-shape gate on every field (defense in depth at the rpc
 *      edge before the registry write).
 *    - `display_name` / `instructions` / `success_message` /
 *      `submit_button_label` length bounds so the rendered HTML stays
 *      compact + the no-leak surface stays bounded.
 *    - `size_cap_bytes` ∈ `[DROP_LINK_SIZE_CAP_MIN, DROP_BLOB_HARD_MAX_SIZE_BYTES]`
 *      ceiling. Sub-cap below the 1 GB hard ceiling per spec § Drop
 *      blob limits — user-configured caps must stay between 1 KB and
 *      1 GB so a stale config can't open a disk-fill attack vector.
 *    - `allowed_mime_types[*]` ⊆ closed allowlist
 *      (`DROP_LINK_ALLOWED_MIME_TYPES`). Mary chooses among MIME types
 *      the substrate's magic-byte detector can verify; adding a new
 *      MIME requires a substrate code change (registry-style).
 *    - `expiry_days` ∈ `[1, 30]` per spec § N.4 — drop_link is link-
 *      style with a hard 30d ceiling regardless of user config.
 *    - `max_uploads_per_endpoint_per_day` ∈ `[1, 1000]`. Substrate
 *      ships a 50/day default; Mary can clamp higher up to the per-
 *      day rate-limit ceiling so a single endpoint can't flood disk.
 *    - `required_visitor_fields.*` ∈ `'required' | 'optional' | 'omit'`
 *      per spec § A.5.4 line 783-787 (name / email / description).
 *    - `on_upload.notification_target` ∈ closed list per spec § A.5.4
 *      line 791; `create_data_file_entity` is a boolean;
 *      `triggered_recipe_id` is a non-empty string when present.
 *
 *  Privacy contract (§ A.5.4 + § A.4):
 *
 *    - The redacted packet exposes ONLY the size cap + allowed MIME
 *      types + instructions + visitor-field requirements + one-time-use
 *      flag + expiry display string.
 *    - It NEVER exposes the storage path, blob ids, `triggered_recipe_id`,
 *      contact-scoping metadata, or `auto_attach_to_*` fields — those
 *      stay server-side at every step.
 *
 *  The substrate enforces the privacy contract via the closed-shape
 *  `RedactedPacketPayloadByKind['drop_link_packet']` map in
 *  `redacted-packets.ts`; this config file gates the *config blob*
 *  shape at admin-write time so a corrupt config never reaches the
 *  visitor path.
 *
 *  Spec: D-149 § A.5.4 + § Must Hold I-7 + § Drop blob limits. */

import {
  type DropLinkVisitorFieldRequirement,
  type DropLinkVisitorFieldRequirements,
} from './redacted-packets.js';
import {
  validateVisitorReceiptConfig,
  type VisitorReceiptConfig,
} from './visitor-receipt-config.js';

/** Codex review P2 fold (2026-05-13) — spec § A.5.4 line 783-787
 *  declares each visitor field as `'required' | 'optional'` (NO omit).
 *  The substrate-level type union in `redacted-packets.ts` carries an
 *  `'omit'` variant for forward-compat across kinds, but the
 *  `drop_link_packet` redacted-packet validator already restricts to
 *  required/optional + would throw at GET render time if `omit` reached
 *  the build. The config validator below enforces the same closed set
 *  at the rpc edge so a stale config with `omit` is rejected at
 *  create / preview rather than failing the first visitor render. */
const DROP_LINK_CONFIG_VISITOR_FIELD_REQUIREMENTS: ReadonlySet<DropLinkVisitorFieldRequirement> =
  new Set<DropLinkVisitorFieldRequirement>(['required', 'optional']);

// ────────────────────────────────────────────────────────────────
// Closed-list bound constants
// ────────────────────────────────────────────────────────────────

/** Substrate-wide ceiling — 1 GB. Per spec § Drop blob limits
 *  `DROP_BLOB_HARD_MAX_SIZE_BYTES` — the user-configured cap CANNOT
 *  exceed this regardless of `size_cap_bytes`. Mirrored here so the
 *  validator can gate at admin-write time without re-importing the
 *  `reception-drop` module. */
export const DROP_LINK_SIZE_CAP_HARD_MAX_BYTES = 1024 * 1024 * 1024;

/** Floor — 1 KB. A useful drop endpoint should accept at least 1 KB
 *  to avoid degenerate "always-rejected" configurations. */
export const DROP_LINK_SIZE_CAP_MIN_BYTES = 1024;

/** Default — 100 MB per spec § A.5.4 line 776. */
export const DROP_LINK_SIZE_CAP_DEFAULT_BYTES = 100 * 1024 * 1024;

/** Expiry ceiling per § N.4 — drop_link link-style; max 30 days. */
export const DROP_LINK_EXPIRY_DAYS_MAX = 30;
export const DROP_LINK_EXPIRY_DAYS_MIN = 1;
export const DROP_LINK_EXPIRY_DAYS_DEFAULT = 7;

/** Per-endpoint per-day upload cap. Substrate's per_endpoint_daily_cap
 *  default for drop_link is 50/day; the per-config knob clamps within
 *  `[1, 1000]` so an aggressive endpoint can't blow disk. */
export const DROP_LINK_MAX_UPLOADS_PER_DAY_MAX = 1000;
export const DROP_LINK_MAX_UPLOADS_PER_DAY_MIN = 1;
export const DROP_LINK_MAX_UPLOADS_PER_DAY_DEFAULT = 50;

/** Display surfaces — same bounds as intake_form so the renderer's
 *  HTML stays compact + the no-leak surface stays bounded. */
export const DROP_LINK_DISPLAY_NAME_MAX = 100;
export const DROP_LINK_INSTRUCTIONS_MAX = 800;
export const DROP_LINK_SUCCESS_MESSAGE_MAX = 400;
export const DROP_LINK_SUBMIT_BUTTON_LABEL_MAX = 60;

/** Visitor-supplied text caps. Name + email + description columns are
 *  sub_dek-encrypted in the drop_blob_metadata via `drop-pii.ts`; the
 *  cap is what the renderer's `<input maxlength=…>` advertises + what
 *  the handler enforces server-side. */
export const DROP_LINK_VISITOR_NAME_MAX = 200;
export const DROP_LINK_VISITOR_EMAIL_MAX = 254;
export const DROP_LINK_VISITOR_DESCRIPTION_MAX = 4000;

/** Original (visitor-supplied) filename cap per spec § A.5.4 line 783
 *  filename-sanitization rule — 255 bytes (POSIX). The substrate
 *  truncates beyond this. */
export const DROP_LINK_VISITOR_FILENAME_MAX = 255;

/** Substrate-managed closed allowlist of MIME types. Each entry MUST
 *  match the magic-byte detector's contract; adding a new MIME requires
 *  a substrate code change. Mary picks among these in her admin UI.
 *
 *  The allowlist mirrors the safe-default set the visitor surface
 *  needs (PDFs / images / plain text); executables / scripts /
 *  binaries are structurally absent. */
export const DROP_LINK_ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'text/plain',
] as const;

export type DropLinkAllowedMimeType =
  (typeof DROP_LINK_ALLOWED_MIME_TYPES)[number];

export const DROP_LINK_ALLOWED_MIME_TYPE_SET: ReadonlySet<DropLinkAllowedMimeType> =
  new Set(DROP_LINK_ALLOWED_MIME_TYPES);

/** Closed list of processing outcomes the substrate writes to
 *  `reception_drop_blob_metadata.processing_outcome`. The handler writes
 *  `'pending'` or one of the rejection terminal states; the engine
 *  reactive path flips to `'processed'` / `'failed'`. */
export const DROP_LINK_PROCESSING_OUTCOMES = [
  'pending',
  'processed',
  'failed',
  'rejected_size',
  'rejected_mime',
  'rejected_filename',
  'rejected_domain',
] as const;

export type DropLinkProcessingOutcome =
  (typeof DROP_LINK_PROCESSING_OUTCOMES)[number];

export const DROP_LINK_PROCESSING_OUTCOME_SET: ReadonlySet<DropLinkProcessingOutcome> =
  new Set(DROP_LINK_PROCESSING_OUTCOMES);

/** Closed list of scan-status values mirroring spec § A.5.4 schema.
 *  Substrate writes `'unscanned'` when no scan hook is configured;
 *  user-installed virus scan recipes flip to `'pending'` then
 *  `'clean'` / `'flagged'`. */
export const DROP_LINK_SCAN_STATUSES = [
  'unscanned',
  'pending',
  'clean',
  'flagged',
] as const;

export type DropLinkScanStatus = (typeof DROP_LINK_SCAN_STATUSES)[number];

export const DROP_LINK_SCAN_STATUS_SET: ReadonlySet<DropLinkScanStatus> =
  new Set(DROP_LINK_SCAN_STATUSES);

// ────────────────────────────────────────────────────────────────
// Config shape (admin-side; persisted via metadata_blob)
// ────────────────────────────────────────────────────────────────

/** Optional contact-scoping per spec § A.5.4 line 771-774. When set the
 *  endpoint is bound to a known contact via D-138 — the engine reactive
 *  path uses `resolveContactIdentity` to verify the visitor email at
 *  attach time. The substrate carries this through verbatim. */
export interface DropLinkContactScoping {
  readonly contact_id: string;
  readonly require_contact_email_match: boolean;
}

/** Closed-shape on-upload bundle per spec § A.5.4 line 789-794. Engine-
 *  side reactive trigger consumes the row + materialises the `data.file`
 *  entity. `auto_attach_to_*` knobs steer the entity's annotations. */
export interface DropLinkOnUploadConfig {
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
  readonly create_data_file_entity: boolean;
  readonly auto_attach_to_contact: boolean;
  readonly auto_attach_to_project_id?: string;
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
  // the intake + approval_link flags. Every upload now holds at the D-157
  // gate and is reviewed in the inbox. The validator refuses a stale key.
}

/** Singleton-config blob persisted in the registry row's `metadata_blob`.
 *  Read at every upload-form render + POST submit; write only via
 *  `reception.endpoint.create` / future update rpcs. */
export interface DropLinkConfig {
  /** Visitor-facing display name on the form (typically Mary's first
   *  name or handle). Length-bounded so the renderer's `<title>` +
   *  `<h1>` stay compact + the HTML payload is small. */
  readonly display_name: string;
  /** Optional visitor-facing instructions paragraph (rendered above
   *  the upload widget; htmlEscape'd). */
  readonly instructions?: string;
  /** Optional confirmation-page copy. Defaults to the substrate's
   *  generic "Upload received" if absent. */
  readonly success_message?: string;
  /** Optional submit-button label. Defaults to "Upload". */
  readonly submit_button_label?: string;
  /** Optional Foundation-pack template reference. Free-form string at
   *  the substrate; the marketplace tracks the closed list. */
  readonly template_ref?: string;
  /** Per-link link kind. `one_time` revokes after a single successful
   *  upload (the substrate flips `revoked_at` post-write); `repeated`
   *  accepts up to `max_uploads_per_endpoint_per_day` per the rate
   *  limiter. */
  readonly link_kind: 'one_time' | 'repeated';
  /** Optional contact-scoping per spec § A.5.4. The engine reactive
   *  path consumes this; substrate stores verbatim. */
  readonly contact_scoping?: DropLinkContactScoping;
  /** Per-link size cap. Clamps within `[DROP_LINK_SIZE_CAP_MIN_BYTES,
   *  DROP_LINK_SIZE_CAP_HARD_MAX_BYTES]`. The handler streams to disk
   *  + rejects oversize at body parse (no partial file write). */
  readonly size_cap_bytes: number;
  /** Closed-allowlist MIME types. Each MUST be in
   *  `DROP_LINK_ALLOWED_MIME_TYPES`; the magic-byte detector verifies
   *  the actual content matches the reported MIME at upload time. */
  readonly allowed_mime_types: ReadonlyArray<DropLinkAllowedMimeType>;
  /** Link-style expiry days. Clamps within `[1, 30]`; the substrate
   *  derives `expires_at = created_at + expiry_days * 24h`. */
  readonly expiry_days: number;
  /** Per-endpoint per-day upload cap. Substrate clamps within
   *  `[1, 1000]`; default 50. */
  readonly max_uploads_per_endpoint_per_day: number;
  /** Per spec § A.5.4 line 783-787 — the visitor's name / email /
   *  description prompt requirements. */
  readonly required_visitor_fields: DropLinkVisitorFieldRequirements;
  /** Per spec § A.5.4 line 789-794 — engine reactive trigger inputs. */
  readonly on_upload: DropLinkOnUploadConfig;
  /** Optional email-domain allowlist — visitor's email's domain MUST
   *  be in this list (when set). Submissions failing the gate are
   *  tagged `'rejected_domain'`. */
  readonly known_domain_allowlist?: ReadonlyArray<string>;
  /** D-149 § A.20.3 — optional per-endpoint visitor-receipt config.
   *  Absent ⇒ receipts disabled (opt-in). When `enabled`, the POST
   *  upload handler renders a receipt (reference id + field echo +
   *  privacy footer) on the upload success page. */
  readonly visitor_receipt?: VisitorReceiptConfig;
}

// ────────────────────────────────────────────────────────────────
// Validator
// ────────────────────────────────────────────────────────────────

export type DropLinkConfigValidationCode =
  | 'config_shape_invalid'
  | 'display_name_empty'
  | 'display_name_too_long'
  | 'instructions_too_long'
  | 'success_message_too_long'
  | 'submit_button_label_too_long'
  | 'template_ref_invalid'
  | 'link_kind_unknown'
  | 'contact_scoping_invalid'
  | 'size_cap_out_of_range'
  | 'allowed_mime_types_empty'
  | 'allowed_mime_types_too_many'
  | 'allowed_mime_type_unknown'
  | 'expiry_days_out_of_range'
  | 'max_uploads_out_of_range'
  | 'visitor_fields_invalid'
  | 'on_upload_invalid'
  | 'notification_target_unknown'
  | 'triggered_recipe_id_invalid'
  | 'auto_attach_to_project_id_invalid'
  | 'domain_allowlist_too_many'
  | 'domain_allowlist_entry_too_long'
  | 'visitor_receipt_invalid';

export interface DropLinkConfigValidationFailure {
  readonly code: DropLinkConfigValidationCode;
  readonly detail: string;
}

/** Match the intake_form domain-allowlist bounds so the two surfaces
 *  feel consistent. */
export const DROP_LINK_DOMAIN_ALLOWLIST_MAX = 32;
export const DROP_LINK_DOMAIN_ALLOWLIST_ENTRY_MAX = 254;
export const DROP_LINK_ALLOWED_MIME_TYPES_PER_CONFIG_MAX =
  DROP_LINK_ALLOWED_MIME_TYPES.length;

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0;

const isFiniteIntegerInRange = (
  v: unknown,
  min: number,
  max: number,
): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

const isStringWithMax = (v: unknown, max: number): boolean =>
  typeof v === 'string' && v.length <= max;

const isVisitorFieldRequirement = (v: unknown): v is DropLinkVisitorFieldRequirement =>
  typeof v === 'string' &&
  DROP_LINK_CONFIG_VISITOR_FIELD_REQUIREMENTS.has(v as DropLinkVisitorFieldRequirement);

/** Validate a `DropLinkConfig`. Pure function — no I/O. Returns the
 *  list of failures; empty array ⇒ valid. */
export const validateDropLinkConfig = (
  config: unknown,
): ReadonlyArray<DropLinkConfigValidationFailure> => {
  const failures: DropLinkConfigValidationFailure[] = [];
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    failures.push({
      code: 'config_shape_invalid',
      detail: 'drop_link config must be an object',
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
  } else if ((c.display_name as string).length > DROP_LINK_DISPLAY_NAME_MAX) {
    failures.push({
      code: 'display_name_too_long',
      detail: `display_name must be ≤ ${DROP_LINK_DISPLAY_NAME_MAX} characters`,
    });
  }

  // instructions
  if (c.instructions !== undefined) {
    if (typeof c.instructions !== 'string') {
      failures.push({
        code: 'instructions_too_long',
        detail: 'instructions must be a string when present',
      });
    } else if (c.instructions.length > DROP_LINK_INSTRUCTIONS_MAX) {
      failures.push({
        code: 'instructions_too_long',
        detail: `instructions must be ≤ ${DROP_LINK_INSTRUCTIONS_MAX} characters`,
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
    } else if (c.success_message.length > DROP_LINK_SUCCESS_MESSAGE_MAX) {
      failures.push({
        code: 'success_message_too_long',
        detail: `success_message must be ≤ ${DROP_LINK_SUCCESS_MESSAGE_MAX} characters`,
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
    } else if (c.submit_button_label.length > DROP_LINK_SUBMIT_BUTTON_LABEL_MAX) {
      failures.push({
        code: 'submit_button_label_too_long',
        detail: `submit_button_label must be ≤ ${DROP_LINK_SUBMIT_BUTTON_LABEL_MAX} characters`,
      });
    }
  }

  // template_ref
  if (c.template_ref !== undefined) {
    if (typeof c.template_ref !== 'string' || c.template_ref.length === 0) {
      failures.push({
        code: 'template_ref_invalid',
        detail: 'template_ref must be a non-empty string when present',
      });
    }
  }

  // link_kind
  if (c.link_kind !== 'one_time' && c.link_kind !== 'repeated') {
    failures.push({
      code: 'link_kind_unknown',
      detail: `link_kind must be 'one_time' or 'repeated'`,
    });
  }

  // contact_scoping
  if (c.contact_scoping !== undefined) {
    if (
      c.contact_scoping === null ||
      typeof c.contact_scoping !== 'object' ||
      Array.isArray(c.contact_scoping)
    ) {
      failures.push({
        code: 'contact_scoping_invalid',
        detail: 'contact_scoping must be an object when present',
      });
    } else {
      const cs = c.contact_scoping as Record<string, unknown>;
      if (typeof cs.contact_id !== 'string' || cs.contact_id.length === 0) {
        failures.push({
          code: 'contact_scoping_invalid',
          detail: 'contact_scoping.contact_id must be a non-empty string',
        });
      }
      if (typeof cs.require_contact_email_match !== 'boolean') {
        failures.push({
          code: 'contact_scoping_invalid',
          detail: 'contact_scoping.require_contact_email_match must be boolean',
        });
      }
    }
  }

  // size_cap_bytes
  if (
    !isFiniteIntegerInRange(
      c.size_cap_bytes,
      DROP_LINK_SIZE_CAP_MIN_BYTES,
      DROP_LINK_SIZE_CAP_HARD_MAX_BYTES,
    )
  ) {
    failures.push({
      code: 'size_cap_out_of_range',
      detail: `size_cap_bytes must be ${DROP_LINK_SIZE_CAP_MIN_BYTES}..${DROP_LINK_SIZE_CAP_HARD_MAX_BYTES}`,
    });
  }

  // allowed_mime_types
  if (!Array.isArray(c.allowed_mime_types) || c.allowed_mime_types.length === 0) {
    failures.push({
      code: 'allowed_mime_types_empty',
      detail: 'allowed_mime_types must be a non-empty array',
    });
  } else {
    if (c.allowed_mime_types.length > DROP_LINK_ALLOWED_MIME_TYPES_PER_CONFIG_MAX) {
      failures.push({
        code: 'allowed_mime_types_too_many',
        detail: `allowed_mime_types length ${c.allowed_mime_types.length} exceeds max ${DROP_LINK_ALLOWED_MIME_TYPES_PER_CONFIG_MAX}`,
      });
    }
    const seen = new Set<string>();
    for (const m of c.allowed_mime_types) {
      if (
        typeof m !== 'string' ||
        !DROP_LINK_ALLOWED_MIME_TYPE_SET.has(m as DropLinkAllowedMimeType)
      ) {
        failures.push({
          code: 'allowed_mime_type_unknown',
          detail: `allowed_mime_types entry '${String(m)}' is not in the closed allowlist`,
        });
        continue;
      }
      seen.add(m);
    }
  }

  // expiry_days
  if (
    !isFiniteIntegerInRange(
      c.expiry_days,
      DROP_LINK_EXPIRY_DAYS_MIN,
      DROP_LINK_EXPIRY_DAYS_MAX,
    )
  ) {
    failures.push({
      code: 'expiry_days_out_of_range',
      detail: `expiry_days must be ${DROP_LINK_EXPIRY_DAYS_MIN}..${DROP_LINK_EXPIRY_DAYS_MAX}`,
    });
  }

  // max_uploads_per_endpoint_per_day
  if (
    !isFiniteIntegerInRange(
      c.max_uploads_per_endpoint_per_day,
      DROP_LINK_MAX_UPLOADS_PER_DAY_MIN,
      DROP_LINK_MAX_UPLOADS_PER_DAY_MAX,
    )
  ) {
    failures.push({
      code: 'max_uploads_out_of_range',
      detail: `max_uploads_per_endpoint_per_day must be ${DROP_LINK_MAX_UPLOADS_PER_DAY_MIN}..${DROP_LINK_MAX_UPLOADS_PER_DAY_MAX}`,
    });
  }

  // required_visitor_fields
  if (
    c.required_visitor_fields === null ||
    typeof c.required_visitor_fields !== 'object' ||
    Array.isArray(c.required_visitor_fields)
  ) {
    failures.push({
      code: 'visitor_fields_invalid',
      detail: 'required_visitor_fields must be an object',
    });
  } else {
    const v = c.required_visitor_fields as Record<string, unknown>;
    if (!isVisitorFieldRequirement(v.name)) {
      failures.push({
        code: 'visitor_fields_invalid',
        detail: `required_visitor_fields.name must be 'required' | 'optional' | 'omit'`,
      });
    }
    if (!isVisitorFieldRequirement(v.email)) {
      failures.push({
        code: 'visitor_fields_invalid',
        detail: `required_visitor_fields.email must be 'required' | 'optional' | 'omit'`,
      });
    }
    if (!isVisitorFieldRequirement(v.description)) {
      failures.push({
        code: 'visitor_fields_invalid',
        detail: `required_visitor_fields.description must be 'required' | 'optional' | 'omit'`,
      });
    }
  }

  // on_upload
  if (
    c.on_upload === null ||
    typeof c.on_upload !== 'object' ||
    Array.isArray(c.on_upload)
  ) {
    failures.push({
      code: 'on_upload_invalid',
      detail: 'on_upload must be an object',
    });
  } else {
    const o = c.on_upload as Record<string, unknown>;
    // D-210 Phase C — retired; refuse a stale key (see the removal note).
    if ((o as { notification_target?: unknown }).notification_target !== undefined) {
      failures.push({
        code: 'notification_target_unknown',
        detail:
          'on_upload.notification_target has been retired — notification channels are '
          + 'chosen in Settings, and the inbox fanout mode picks the surface. Remove the field.',
      });
    }
    if (typeof o.create_data_file_entity !== 'boolean') {
      failures.push({
        code: 'on_upload_invalid',
        detail: 'on_upload.create_data_file_entity must be boolean',
      });
    }
    if (typeof o.auto_attach_to_contact !== 'boolean') {
      failures.push({
        code: 'on_upload_invalid',
        detail: 'on_upload.auto_attach_to_contact must be boolean',
      });
    }
    if (o.auto_attach_to_project_id !== undefined) {
      if (
        typeof o.auto_attach_to_project_id !== 'string' ||
        o.auto_attach_to_project_id.length === 0
      ) {
        failures.push({
          code: 'auto_attach_to_project_id_invalid',
          detail: 'on_upload.auto_attach_to_project_id must be a non-empty string when present',
        });
      }
    }
    // D-210 Phase C — retired; refuse a stale key (see the field's removal note).
    if ((o as { triggered_recipe_id?: unknown }).triggered_recipe_id !== undefined) {
      failures.push({
        code: 'triggered_recipe_id_invalid',
        detail:
          'on_upload.triggered_recipe_id has been retired — watch the materialized '
          + "task's `created` event instead. Remove the field.",
      });
    }
    // D-210 Phase C — retired; refuse rather than ignore (see the field's
    // removal note above).
    if ((o as { auto_accept?: unknown }).auto_accept !== undefined) {
      failures.push({
        code: 'on_upload_invalid',
        detail:
          'on_upload.auto_accept has been retired — every upload is held for review in '
          + 'the inbox. Remove the field.',
      });
    }
  }

  // known_domain_allowlist
  if (c.known_domain_allowlist !== undefined) {
    if (!Array.isArray(c.known_domain_allowlist)) {
      failures.push({
        code: 'domain_allowlist_too_many',
        detail: 'known_domain_allowlist must be an array when present',
      });
    } else {
      if (c.known_domain_allowlist.length > DROP_LINK_DOMAIN_ALLOWLIST_MAX) {
        failures.push({
          code: 'domain_allowlist_too_many',
          detail: `known_domain_allowlist length ${c.known_domain_allowlist.length} exceeds max ${DROP_LINK_DOMAIN_ALLOWLIST_MAX}`,
        });
      }
      for (const n of c.known_domain_allowlist) {
        if (
          typeof n !== 'string' ||
          n.length === 0 ||
          !isStringWithMax(n, DROP_LINK_DOMAIN_ALLOWLIST_ENTRY_MAX)
        ) {
          failures.push({
            code: 'domain_allowlist_entry_too_long',
            detail: `known_domain_allowlist entries must be non-empty strings ≤ ${DROP_LINK_DOMAIN_ALLOWLIST_ENTRY_MAX} chars`,
          });
          break;
        }
      }
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
// Upload input shape (POST multipart upload)
// ────────────────────────────────────────────────────────────────

/** Visitor-supplied upload metadata. The blob itself is streamed; this
 *  shape covers the typed surrounding fields the handler parses out of
 *  the multipart form. */
export interface DropLinkUploadInput {
  readonly visitor_name?: string;
  readonly visitor_email?: string;
  readonly visitor_description?: string;
  /** Visitor-reported MIME (per the multipart field). The handler
   *  cross-checks against magic bytes at upload time. */
  readonly mime_type_reported: string;
  /** Visitor-supplied filename. Sanitized server-side (path-traversal
   *  defense + UTF-8 normalization + length cap). */
  readonly filename: string;
  /** Total uploaded bytes (after stream consumed). Substrate compares
   *  against `size_cap_bytes`. */
  readonly size_bytes: number;
}

export type DropLinkUploadValidationCode =
  | 'visitor_name_required'
  | 'visitor_name_too_long'
  | 'visitor_email_required'
  | 'visitor_email_too_long'
  | 'visitor_email_invalid'
  | 'visitor_email_domain_rejected'
  | 'visitor_description_required'
  | 'visitor_description_too_long'
  | 'mime_type_not_allowed'
  | 'filename_invalid'
  | 'size_cap_exceeded';

export interface DropLinkUploadValidationFailure {
  readonly code: DropLinkUploadValidationCode;
  readonly detail: string;
}

/** Conservative email syntax probe. Same RE as intake-form-config so the
 *  two PII surfaces behave identically; precision deferred to engine. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const extractEmailDomain = (raw: string): string | null => {
  const at = raw.indexOf('@');
  if (at < 0 || at === raw.length - 1) return null;
  return raw.slice(at + 1).toLowerCase();
};

/** Validate visitor upload against the config. Pure function — no I/O.
 *  Returns the list of failures; empty array ⇒ valid. */
export const validateDropLinkUpload = (
  input: DropLinkUploadInput,
  config: DropLinkConfig,
): ReadonlyArray<DropLinkUploadValidationFailure> => {
  const failures: DropLinkUploadValidationFailure[] = [];

  // visitor_name
  const nameReq = config.required_visitor_fields.name;
  if (nameReq !== 'omit') {
    const present =
      typeof input.visitor_name === 'string' && input.visitor_name.length > 0;
    if (nameReq === 'required' && !present) {
      failures.push({
        code: 'visitor_name_required',
        detail: 'visitor_name is required',
      });
    } else if (present && (input.visitor_name as string).length > DROP_LINK_VISITOR_NAME_MAX) {
      failures.push({
        code: 'visitor_name_too_long',
        detail: `visitor_name must be ≤ ${DROP_LINK_VISITOR_NAME_MAX} chars`,
      });
    }
  }

  // visitor_email
  const emailReq = config.required_visitor_fields.email;
  if (emailReq !== 'omit') {
    const present =
      typeof input.visitor_email === 'string' && input.visitor_email.length > 0;
    if (emailReq === 'required' && !present) {
      failures.push({
        code: 'visitor_email_required',
        detail: 'visitor_email is required',
      });
    } else if (present) {
      const email = input.visitor_email as string;
      if (email.length > DROP_LINK_VISITOR_EMAIL_MAX) {
        failures.push({
          code: 'visitor_email_too_long',
          detail: `visitor_email must be ≤ ${DROP_LINK_VISITOR_EMAIL_MAX} chars`,
        });
      } else if (!EMAIL_RE.test(email)) {
        failures.push({
          code: 'visitor_email_invalid',
          detail: 'visitor_email must look like an email address',
        });
      } else if (
        config.known_domain_allowlist &&
        config.known_domain_allowlist.length > 0
      ) {
        const dom = extractEmailDomain(email);
        if (dom === null || !config.known_domain_allowlist.includes(dom)) {
          failures.push({
            code: 'visitor_email_domain_rejected',
            detail: 'visitor_email domain is not in the allowlist',
          });
        }
      }
    }
  }

  // visitor_description
  const descReq = config.required_visitor_fields.description;
  if (descReq !== 'omit') {
    const present =
      typeof input.visitor_description === 'string' && input.visitor_description.length > 0;
    if (descReq === 'required' && !present) {
      failures.push({
        code: 'visitor_description_required',
        detail: 'visitor_description is required',
      });
    } else if (
      present &&
      (input.visitor_description as string).length > DROP_LINK_VISITOR_DESCRIPTION_MAX
    ) {
      failures.push({
        code: 'visitor_description_too_long',
        detail: `visitor_description must be ≤ ${DROP_LINK_VISITOR_DESCRIPTION_MAX} chars`,
      });
    }
  }

  // mime_type_reported — closed allowlist intersected with per-config selection
  const configSet = new Set(config.allowed_mime_types);
  if (!configSet.has(input.mime_type_reported as DropLinkAllowedMimeType)) {
    failures.push({
      code: 'mime_type_not_allowed',
      detail: `mime_type_reported '${input.mime_type_reported}' is not permitted for this endpoint`,
    });
  }

  // filename
  if (
    typeof input.filename !== 'string' ||
    input.filename.length === 0 ||
    input.filename.length > DROP_LINK_VISITOR_FILENAME_MAX
  ) {
    failures.push({
      code: 'filename_invalid',
      detail: `filename must be a non-empty string ≤ ${DROP_LINK_VISITOR_FILENAME_MAX} bytes`,
    });
  }

  // size_cap_bytes
  if (
    typeof input.size_bytes !== 'number' ||
    !Number.isFinite(input.size_bytes) ||
    input.size_bytes < 0 ||
    input.size_bytes > config.size_cap_bytes
  ) {
    failures.push({
      code: 'size_cap_exceeded',
      detail: `size ${input.size_bytes} exceeds size_cap_bytes ${config.size_cap_bytes}`,
    });
  }

  return failures;
};

/** Default success-page copy when the config omits one. */
export const DROP_LINK_DEFAULT_SUCCESS_MESSAGE = 'Upload received. Thank you.' as const;

/** Default submit-button label. */
export const DROP_LINK_DEFAULT_SUBMIT_BUTTON_LABEL = 'Upload' as const;
