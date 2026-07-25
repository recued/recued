/** D-149 P9 § A.5.6 — `status_link` per-endpoint config contract.
 *
 *  Each `status_link` endpoint stores a `StatusLinkConfig` blob inside
 *  the `public_endpoint_registry.metadata_blob` column. The reception
 *  handler reads the blob at request time + renders the read-only
 *  entity projection (GET HTML) or returns the projected payload as
 *  JSON (`?format=json`) for the auto-refresh polling path. The rpc
 *  admin layer writes the blob via `reception.endpoint.create` (the
 *  same path the other link-style kinds use).
 *
 *  Status-link is the visitor-facing read of ONE entity, projected
 *  through the per-projection-kind closed-list ceiling
 *  (`STATUS_PROJECTION_FIELDS_VISIBLE`) in `redacted-packets.ts`.
 *  Visitors NEVER mutate the source entity — feedback / comments are
 *  separate `approval_link` endpoints. The substrate enforces the
 *  read-only invariant by accepting GET only at the handler dispatch
 *  layer; this config file gates the *config blob* shape at admin-write
 *  time so a corrupt config never reaches the visitor path.
 *
 *  Validators in this file:
 *
 *    - Closed-shape gate on every field (defense in depth at the rpc
 *      edge before the registry write).
 *    - `display_name` / `caption` length bounds so the rendered HTML
 *      stays compact + the no-leak surface stays bounded.
 *    - `projection_kind` ∈ `StatusLinkProjectionKind` closed list
 *      (mirrors `STATUS_LINK_PROJECTION_KINDS`).
 *    - `source_ref.kind` ∈ closed set of seven entity kinds permitted
 *      by `SOURCE_QUERY_KINDS_PERMITTED_PER_PACKET_KIND['status_link_packet']`.
 *      Per-kind id field MUST be non-empty.
 *    - `fields_visible_override` (when present) MUST be a subset of
 *      `STATUS_PROJECTION_FIELDS_VISIBLE[projection_kind]`. Over-broad
 *      overrides surface as a validation failure here; the substrate
 *      also clamps at packet-build time (belt + suspenders).
 *    - `refresh_policy.auto_refresh_enabled` ∈ boolean. When true,
 *      `refresh_interval_seconds` MUST be inside
 *      `[REFRESH_INTERVAL_SECONDS_MIN, REFRESH_INTERVAL_SECONDS_MAX]`.
 *    - `expiry_days` ∈ `[1, 90]` per spec § N.4 — status_link is
 *      link-style with a hard 90d ceiling.
 *    - `comments_enabled` MUST be `false` at v1 (per spec § A.5.6
 *      line 933 "false at v1; future toggle"). The substrate rejects
 *      `true` as deferred-feature.
 *    - `shows_update_history` ∈ boolean.
 *
 *  Privacy contract (§ A.5.6 + § A.4):
 *
 *    - The redacted packet exposes ONLY the projection_kind +
 *      visible_fields (per-projection-kind closed list ceiling) +
 *      last_updated_at_relative + updates_visible + comments_enabled.
 *    - It NEVER exposes the bare source entity row beyond the
 *      ceiling — booking codes / confirmation numbers / vendor
 *      contracts / internal codenames are stripped at the boundary by
 *      the per-projection per-field redactor table in
 *      `redacted-packets.ts`.
 *    - Visitors see relative timestamps ("2 days ago") not exact
 *      ISO timestamps (per § A.14 line 1303 "no exact last-seen
 *      timestamps").
 *
 *  Spec: `docs/d-149-spec.md` § A.5.6 + § Must Hold I-2 + I-12. */

import {
  STATUS_LINK_PROJECTION_KIND_SET,
  STATUS_PROJECTION_FIELDS_VISIBLE,
  type StatusLinkProjectionKind,
} from './redacted-packets.js';
import type { SourceQueryRef } from './reception-source-query.js';

// ────────────────────────────────────────────────────────────────
// Closed-list bound constants
// ────────────────────────────────────────────────────────────────

/** Expiry ceiling per § N.4 — status_link link-style; default 30d,
 *  max 90d (the broadest link-style ceiling in the closed set; status
 *  links are intended for ongoing reference). */
export const STATUS_LINK_EXPIRY_DAYS_MAX = 90;
export const STATUS_LINK_EXPIRY_DAYS_MIN = 1;
export const STATUS_LINK_EXPIRY_DAYS_DEFAULT = 30;

/** Display surfaces — same bounds as approval_link so the renderer's
 *  HTML stays compact + the no-leak surface stays bounded. */
export const STATUS_LINK_DISPLAY_NAME_MAX = 100;
export const STATUS_LINK_CAPTION_MAX = 400;

/** Auto-refresh interval bounds per § A.5.6 line 931 — default 60s
 *  (matches RECEPTION_RATE_LIMIT_DEFAULTS.status_link.window_ms = 60s).
 *  Min 10s gates against degenerate polling; max 1h is a practical
 *  ceiling beyond which the link feels stale rather than live. */
export const STATUS_LINK_REFRESH_INTERVAL_SECONDS_MIN = 10;
export const STATUS_LINK_REFRESH_INTERVAL_SECONDS_MAX = 60 * 60;
export const STATUS_LINK_REFRESH_INTERVAL_SECONDS_DEFAULT = 60;

/** Default labels surfaced when the config omits the field. */
export const STATUS_LINK_DEFAULT_CAPTION = 'Status updates' as const;

// ────────────────────────────────────────────────────────────────
// Config shape (admin-side; persisted via metadata_blob)
// ────────────────────────────────────────────────────────────────

/** Closed-shape refresh policy per spec § A.5.6 line 929-932. */
export interface StatusLinkRefreshPolicy {
  /** Whether the visitor's browser polls for updates. When false the
   *  visitor sees a static snapshot at request time + must manually
   *  reload. */
  readonly auto_refresh_enabled: boolean;
  /** Polling cadence in seconds. Required when auto_refresh_enabled;
   *  ignored otherwise. */
  readonly refresh_interval_seconds?: number;
}

/** Singleton-config blob persisted in the registry row's `metadata_blob`.
 *  Read at every status-link render + JSON poll; write only via
 *  `reception.endpoint.create` / future update rpcs. */
export interface StatusLinkConfig {
  /** Visitor-facing display name on the page (typically Mary's first
   *  name or handle). Length-bounded so the renderer's `<title>` +
   *  `<h1>` stay compact + the HTML payload is small. */
  readonly display_name: string;
  /** Caption / sub-header beneath the display name. Optional; falls
   *  back to a generic substrate default when omitted. */
  readonly caption?: string;
  /** Projection kind — gates `STATUS_PROJECTION_FIELDS_VISIBLE`
   *  ceiling + the per-projection per-field redactor table. */
  readonly projection_kind: StatusLinkProjectionKind;
  /** Source entity ref — closed-list discriminated union per
   *  `SourceQueryRef`. The substrate cross-checks `source_ref.kind`
   *  against `SOURCE_QUERY_KINDS_PERMITTED_PER_PACKET_KIND['status_link_packet']`
   *  at the validator + at the rpc edge. */
  readonly source_ref: SourceQueryRef;
  /** Optional narrowing within the per-projection ceiling. Each entry
   *  MUST be in `STATUS_PROJECTION_FIELDS_VISIBLE[projection_kind]`;
   *  over-broad entries fail validation. */
  readonly fields_visible_override?: ReadonlyArray<string>;
  /** Visitor-side refresh behavior. */
  readonly refresh_policy: StatusLinkRefreshPolicy;
  /** v1: MUST be false. Spec § A.5.6 line 933 reserves a future
   *  toggle for separate-entity comments; v1 ships read-only. */
  readonly comments_enabled: boolean;
  /** Whether the rendered page surfaces an "updated X days ago" hint
   *  beside the projection. Defaults to true. */
  readonly shows_update_history: boolean;
  /** Link-style expiry days. Clamps within `[1, 90]`; the substrate
   *  derives `expires_at = created_at + expiry_days * 24h`. */
  readonly expiry_days: number;
  /** Optional Foundation-pack template reference. Free-form string at
   *  the substrate; the marketplace tracks the closed list. */
  readonly template_ref?: string;
}

// ────────────────────────────────────────────────────────────────
// Validator
// ────────────────────────────────────────────────────────────────

export type StatusLinkConfigValidationCode =
  | 'config_shape_invalid'
  | 'display_name_empty'
  | 'display_name_too_long'
  | 'caption_too_long'
  | 'projection_kind_unknown'
  | 'source_ref_invalid'
  | 'source_ref_kind_unknown'
  | 'source_ref_missing_id_field'
  | 'source_ref_disallowed_for_status_link'
  | 'fields_visible_override_invalid'
  | 'fields_visible_override_exceeds_ceiling'
  | 'refresh_policy_invalid'
  | 'refresh_interval_required_when_enabled'
  | 'refresh_interval_out_of_range'
  | 'expiry_days_out_of_range'
  | 'comments_enabled_must_be_false_at_v1'
  | 'shows_update_history_invalid'
  | 'template_ref_invalid';

export interface StatusLinkConfigValidationFailure {
  readonly code: StatusLinkConfigValidationCode;
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

/** Closed list — status_link source-ref kinds. Mirrors the entry in
 *  `SOURCE_QUERY_KINDS_PERMITTED_PER_PACKET_KIND['status_link_packet']`
 *  verbatim; duplicating here so the validator stays self-contained
 *  (no runtime dependency on the source-query module). The closed-list
 *  ratchet in tests asserts the two stay in lockstep. */
const STATUS_LINK_SOURCE_REF_KIND_SET: ReadonlySet<string> = new Set<string>([
  'data.task',
  'data.note',
  'data.commitment',
  'data.project',
  'data.event',
  'data.packing_list',
  'data.itinerary',
]);

/** Per-kind id field on the parsed source_ref shape. Mirrors
 *  `REQUIRED_ID_FIELD_BY_KIND` in `reception-source-query.ts`. */
const STATUS_LINK_SOURCE_REF_ID_FIELD: Readonly<Record<string, string>> = {
  'data.task': 'task_id',
  'data.note': 'note_id',
  'data.commitment': 'commitment_id',
  'data.project': 'project_id',
  'data.event': 'event_id',
  'data.packing_list': 'list_id',
  'data.itinerary': 'itinerary_id',
};

const isProjectionKind = (v: unknown): v is StatusLinkProjectionKind =>
  typeof v === 'string' &&
  STATUS_LINK_PROJECTION_KIND_SET.has(v as StatusLinkProjectionKind);

/** Validate a `StatusLinkConfig`. Pure function — no I/O. Returns the
 *  list of failures; empty array ⇒ valid. */
export const validateStatusLinkConfig = (
  config: unknown,
): ReadonlyArray<StatusLinkConfigValidationFailure> => {
  const failures: StatusLinkConfigValidationFailure[] = [];

  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return [
      { code: 'config_shape_invalid', detail: 'status_link config must be an object' },
    ];
  }
  const c = config as Record<string, unknown>;

  // display_name
  if (!isNonEmptyString(c.display_name)) {
    failures.push({ code: 'display_name_empty', detail: 'display_name is required' });
  } else if (c.display_name.length > STATUS_LINK_DISPLAY_NAME_MAX) {
    failures.push({
      code: 'display_name_too_long',
      detail: `display_name ≤ ${STATUS_LINK_DISPLAY_NAME_MAX} chars`,
    });
  }

  // caption (optional)
  if (c.caption !== undefined) {
    if (typeof c.caption !== 'string') {
      failures.push({
        code: 'caption_too_long',
        detail: 'caption must be a string when present',
      });
    } else if (c.caption.length > STATUS_LINK_CAPTION_MAX) {
      failures.push({
        code: 'caption_too_long',
        detail: `caption ≤ ${STATUS_LINK_CAPTION_MAX} chars`,
      });
    }
  }

  // projection_kind
  if (!isProjectionKind(c.projection_kind)) {
    failures.push({
      code: 'projection_kind_unknown',
      detail: 'projection_kind must be one of event_plan|itinerary|project|packing_list|commitment_summary|custom',
    });
  }

  // source_ref
  if (!c.source_ref || typeof c.source_ref !== 'object' || Array.isArray(c.source_ref)) {
    failures.push({
      code: 'source_ref_invalid',
      detail: 'source_ref must be an object',
    });
  } else {
    const src = c.source_ref as Record<string, unknown>;
    const refKind = src.kind;
    if (typeof refKind !== 'string' || !STATUS_LINK_SOURCE_REF_KIND_SET.has(refKind)) {
      failures.push({
        code: 'source_ref_kind_unknown',
        detail: `source_ref.kind must be one of ${[...STATUS_LINK_SOURCE_REF_KIND_SET].join(', ')}`,
      });
    } else {
      const idField = STATUS_LINK_SOURCE_REF_ID_FIELD[refKind];
      if (typeof idField === 'string') {
        const idValue = src[idField];
        if (typeof idValue !== 'string' || idValue.length === 0) {
          failures.push({
            code: 'source_ref_missing_id_field',
            detail: `source_ref kind=${refKind} requires non-empty ${idField}`,
          });
        }
      }
    }
  }

  // fields_visible_override (optional) — subset of projection's ceiling
  if (c.fields_visible_override !== undefined) {
    if (!Array.isArray(c.fields_visible_override)) {
      failures.push({
        code: 'fields_visible_override_invalid',
        detail: 'fields_visible_override must be a string[]',
      });
    } else if (isProjectionKind(c.projection_kind)) {
      const ceiling = STATUS_PROJECTION_FIELDS_VISIBLE[c.projection_kind];
      for (const f of c.fields_visible_override) {
        if (typeof f !== 'string' || f.length === 0) {
          failures.push({
            code: 'fields_visible_override_invalid',
            detail: 'fields_visible_override entries must be non-empty strings',
          });
          break;
        }
        if (!ceiling.includes(f)) {
          failures.push({
            code: 'fields_visible_override_exceeds_ceiling',
            detail: `field '${f}' not in STATUS_PROJECTION_FIELDS_VISIBLE[${c.projection_kind}]`,
          });
        }
      }
    }
  }

  // refresh_policy
  if (
    !c.refresh_policy ||
    typeof c.refresh_policy !== 'object' ||
    Array.isArray(c.refresh_policy)
  ) {
    failures.push({
      code: 'refresh_policy_invalid',
      detail: 'refresh_policy must be an object',
    });
  } else {
    const rp = c.refresh_policy as Record<string, unknown>;
    if (typeof rp.auto_refresh_enabled !== 'boolean') {
      failures.push({
        code: 'refresh_policy_invalid',
        detail: 'refresh_policy.auto_refresh_enabled must be a boolean',
      });
    } else if (rp.auto_refresh_enabled === true) {
      if (rp.refresh_interval_seconds === undefined) {
        failures.push({
          code: 'refresh_interval_required_when_enabled',
          detail: 'refresh_interval_seconds is required when auto_refresh_enabled is true',
        });
      } else if (
        !isFiniteIntegerInRange(
          rp.refresh_interval_seconds,
          STATUS_LINK_REFRESH_INTERVAL_SECONDS_MIN,
          STATUS_LINK_REFRESH_INTERVAL_SECONDS_MAX,
        )
      ) {
        failures.push({
          code: 'refresh_interval_out_of_range',
          detail: `refresh_interval_seconds ∈ [${STATUS_LINK_REFRESH_INTERVAL_SECONDS_MIN}, ${STATUS_LINK_REFRESH_INTERVAL_SECONDS_MAX}]`,
        });
      }
    } else if (
      rp.refresh_interval_seconds !== undefined &&
      typeof rp.refresh_interval_seconds !== 'number'
    ) {
      // Tolerate the field when auto_refresh_enabled is false but reject
      // non-number values to surface accidentally-malformed configs.
      failures.push({
        code: 'refresh_policy_invalid',
        detail: 'refresh_interval_seconds must be a number when present',
      });
    }
  }

  // comments_enabled — MUST be false at v1
  if (typeof c.comments_enabled !== 'boolean') {
    failures.push({
      code: 'config_shape_invalid',
      detail: 'comments_enabled must be a boolean',
    });
  } else if (c.comments_enabled === true) {
    failures.push({
      code: 'comments_enabled_must_be_false_at_v1',
      detail: 'comments_enabled is deferred — must be false at v1',
    });
  }

  // shows_update_history
  if (typeof c.shows_update_history !== 'boolean') {
    failures.push({
      code: 'shows_update_history_invalid',
      detail: 'shows_update_history must be a boolean',
    });
  }

  // expiry_days
  if (
    !isFiniteIntegerInRange(
      c.expiry_days,
      STATUS_LINK_EXPIRY_DAYS_MIN,
      STATUS_LINK_EXPIRY_DAYS_MAX,
    )
  ) {
    failures.push({
      code: 'expiry_days_out_of_range',
      detail: `expiry_days ∈ [${STATUS_LINK_EXPIRY_DAYS_MIN}, ${STATUS_LINK_EXPIRY_DAYS_MAX}]`,
    });
  }

  // template_ref (optional)
  if (c.template_ref !== undefined) {
    if (typeof c.template_ref !== 'string' || c.template_ref.length === 0) {
      failures.push({
        code: 'template_ref_invalid',
        detail: 'template_ref must be a non-empty string when present',
      });
    }
  }

  return failures;
};
