/** D-149 P9 § A.4 + § A.5.6 — `status_link_packet` transformation
 *  helpers (server-side, per-kind).
 *
 *  Source-query → raw-input adapter. The substrate owns the closed-list
 *  pick + per-projection-kind ceiling clamp + per-field redactor table
 *  (`STATUS_PROJECTION_FIELDS_VISIBLE` + per-field redactors in
 *  `redacted-packets.ts`); this file owns:
 *
 *    - `parseStatusLinkConfig` — read the registry row's `metadata_blob`
 *      into the canonical `StatusLinkConfig` shape. Returns null on
 *      corrupt JSON / validation failure so the dispatcher can degrade
 *      to the placeholder page rather than crash.
 *    - `buildStatusLinkSourceView` — derive the `StatusLinkSourceView`
 *      the packet builder consumes; clips the source entity row to the
 *      per-projection ceiling so a buggy upstream reader cannot leak
 *      fields beyond the closed list.
 *    - `buildStatusLinkPacketRawInput` (P2 surface; preserved as-is) —
 *      thin pass-through to the substrate.
 *
 *  Spec: docs/d-149-spec.md § A.5.6. */

import {
  STATUS_PROJECTION_FIELDS_VISIBLE,
  validateStatusLinkConfig,
  type StatusLinkConfig,
  type StatusLinkPacketRawInput,
  type StatusLinkProjectionKind,
} from '@recued/contracts';

export interface StatusLinkSourceView {
  readonly projection_kind: StatusLinkProjectionKind;
  readonly source_entity_row: Readonly<Record<string, unknown>>;
  readonly fields_visible_override?: ReadonlyArray<string>;
  readonly last_updated_at: number;
  readonly now: number;
  readonly updates_visible: boolean;
  readonly comments_enabled: boolean;
}

/** Parse a registry-row's `metadata_blob` into a canonical
 *  `StatusLinkConfig`. Returns `null` on shape failure so the
 *  dispatcher can degrade to the placeholder rather than crash. */
export const parseStatusLinkConfig = (
  raw: Readonly<Record<string, unknown>> | unknown,
): StatusLinkConfig | null => {
  const failures = validateStatusLinkConfig(raw);
  if (failures.length > 0) return null;
  // Validator only confirms shape; the `as StatusLinkConfig` cast is
  // sound because validateStatusLinkConfig gates every required field
  // + closed-list value.
  return raw as StatusLinkConfig;
};

/** Build the source-view feeding the packet raw input. Clips the
 *  upstream entity row to the per-projection ceiling BEFORE handing
 *  to the packet builder so a buggy reader cannot leak fields beyond
 *  the closed list. The substrate's strict-pick + per-field redactor
 *  table in `redacted-packets.ts` is the load-bearing privacy gate;
 *  this clip is belt-and-suspenders.
 *
 *  Codex follow-up gate (P9 implementation note): the source_entity_row
 *  payload is expected to already be a sanitized projection (the
 *  injected `StatusEntitySourceReader` is responsible for filtering at
 *  the warehouse boundary). The substrate ceiling + redactor table
 *  defend against accidental over-fetch from a future reader regression.
 */
export const buildStatusLinkSourceView = (
  config: StatusLinkConfig,
  source_entity_row: Readonly<Record<string, unknown>>,
  last_updated_at: number,
  now: number,
): StatusLinkSourceView => {
  const ceiling = STATUS_PROJECTION_FIELDS_VISIBLE[config.projection_kind];
  const allowed = config.fields_visible_override
    ? config.fields_visible_override.filter((f) => ceiling.includes(f))
    : ceiling;
  const clipped: Record<string, unknown> = {};
  for (const f of allowed) {
    if (Object.prototype.hasOwnProperty.call(source_entity_row, f)) {
      clipped[f] = source_entity_row[f];
    }
  }
  const view: {
    projection_kind: StatusLinkProjectionKind;
    source_entity_row: Readonly<Record<string, unknown>>;
    fields_visible_override?: ReadonlyArray<string>;
    last_updated_at: number;
    now: number;
    updates_visible: boolean;
    comments_enabled: boolean;
  } = {
    projection_kind: config.projection_kind,
    source_entity_row: clipped,
    last_updated_at,
    now,
    updates_visible: config.shows_update_history,
    comments_enabled: config.comments_enabled,
  };
  if (config.fields_visible_override !== undefined) {
    view.fields_visible_override = config.fields_visible_override;
  }
  return view;
};

/** Adapter — produces the raw input the substrate transform consumes.
 *  The substrate clamps `fields_visible_override` to the per-projection
 *  closed-list ceiling so over-broad overrides drop silently. */
export const buildStatusLinkPacketRawInput = (
  source: StatusLinkSourceView,
): StatusLinkPacketRawInput => {
  const raw: {
    projection_kind: StatusLinkProjectionKind;
    source_entity_row: Readonly<Record<string, unknown>>;
    fields_visible_override?: ReadonlyArray<string>;
    last_updated_at: number;
    now: number;
    updates_visible: boolean;
    comments_enabled: boolean;
  } = {
    projection_kind: source.projection_kind,
    source_entity_row: source.source_entity_row,
    last_updated_at: source.last_updated_at,
    now: source.now,
    updates_visible: source.updates_visible,
    comments_enabled: source.comments_enabled,
  };
  if (source.fields_visible_override !== undefined) {
    raw.fields_visible_override = source.fields_visible_override;
  }
  return raw;
};
