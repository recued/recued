/** D-192 P5 — work-graph relationship edges.
 *
 *  The scoped relationship substrate the spec's § Identity and
 *  relationships mandates: a FRESH thin `work_entity_edge` table (the
 *  i-vs-ii fork resolved at P5 — overloading the D-119 `link` store was
 *  rejected: it has no source-identity column, no unique upsert target,
 *  no tombstone, and overloading would leak sync-derived edges into the
 *  generic link consumers — `data.timeline`, `.links.*` prefetch,
 *  `cascadeDelete`, the stored-cleanliness gate). Shape mirrors
 *  `engagement_edges`' proven sync posture (source-scoped +
 *  tombstone-on-disassociate + bidirectional index); `engagement_edges`
 *  itself is NEVER re-keyed — it stays the D-139 CRM raw-association
 *  evidence layer.
 *
 *  Identity: `(source_id, source_record_id, local_field,
 *  target_scoped_key)` — the owning Source row plus the declared
 *  relationship field plus a deterministic scoped key for the target
 *  reference. The scoped key is STABLE UNDER RESOLUTION: filling
 *  `target_local_id` later never changes the row identity, so re-sync
 *  and late resolution are both idempotent.
 *
 *  Resolution posture per target family (spec § Identity and
 *  relationships):
 *  - `contact` — edges exist ONLY resolved, keyed on the stable
 *    `contact_id` (merge-safe by forwarding; an email key would orphan
 *    on mention_only→verified promotion). Unresolved contact references
 *    stay projected extension attributes — never an edge, never a raw
 *    vendor id in a canonical column (sparse by construction).
 *  - `crm.deal` / `crm.contact` / `crm.account` — resolved by
 *    COMPOSITION: `target_local_id` is the D-190 platform-reference
 *    `full_target_id` (`composePlatformRecordTargetId`), the same key
 *    `engagement_edges` uses for `connection.api` targets — no local
 *    existence check (the engagement precedent).
 *  - `task` / `project` / `note` — resolved through the sibling
 *    Source's mirror row; admissible UNRESOLVED as a scoped edge
 *    (`target_local_id` null) when the target has not synced yet — a
 *    per-cycle re-resolution pass self-heals.
 *  - `calendar.event` / `mail_message` — v1 persists the scoped
 *    reference only (`remote_id` pairing); no local resolver yet.
 *
 *  Spec: docs/d-192-spec.md § Identity and relationships + § P5;
 *  decisions-log D-192 (Relationships). */

import type {
  WorkEntityRelationshipTarget,
  WorkEntitySourceDeclarableKind,
} from './work-entity-sources.js';

/** One stored edge row. `target_local_id` is populated ONLY after
 *  resolution succeeds (spec: never a raw vendor id in a canonical
 *  local-id slot — the raw reference rides `target_remote_id`). */
export interface WorkEntityEdge {
  /** Owning Source (the work-entity Source the owner row syncs from). */
  source_id: string;
  /** Owning row's vendor-native record id. */
  source_record_id: string;
  /** Owner entity kind — which canonical table `owner_local_id` lives in. */
  owner_kind: WorkEntitySourceDeclarableKind;
  /** The owner's local canonical row id (`data_task.id` / `data_project.id`). */
  owner_local_id: string;
  /** The declared relationship's `local_field` — the edge kind. */
  local_field: string;
  target_kind: WorkEntityRelationshipTarget;
  /** Deterministic scoped identity of the target REFERENCE — stable
   *  under resolution (see the `workEntity*EdgeKey` composers). */
  target_scoped_key: string;
  /** The target's own Source id, when the target is another
   *  work-entity Source row (drives late re-resolution). */
  target_source_id?: string;
  /** Vendor-side entity of the reference (`remote_id` pairing). */
  target_remote_entity?: string;
  /** Vendor-native id of the reference (`remote_id` pairing). */
  target_remote_id?: string;
  /** Resolved local identity: `contact_id` for contacts, the
   *  platform-reference `full_target_id` for `crm.*`, the canonical
   *  row id for work-entity targets. Null until resolution succeeds. */
  target_local_id?: string;
  created_at: number;
  resolved_at?: number;
  deleted_at?: number;
}

/** The per-reference write shape the sync fold reconciles with —
 *  everything row-scoped (`source_id` / `source_record_id` / owner)
 *  rides the reconcile call, not each edge. */
export interface WorkEntityEdgeWrite {
  local_field: string;
  target_kind: WorkEntityRelationshipTarget;
  target_scoped_key: string;
  target_source_id?: string;
  target_remote_entity?: string;
  target_remote_id?: string;
  target_local_id?: string;
}

/** Read-surface projection carried on `work_entity.get` responses.
 *  `target_display` is the CONTACT edge's read-time two-hop resolve
 *  (contact_id → follow `merged_into` → survivor's name/email) — the
 *  D-138 forward-resolution the spec names as the reader's job. */
export interface WorkEntityEdgeView {
  local_field: string;
  target_kind: WorkEntityRelationshipTarget;
  resolved: boolean;
  target_local_id?: string;
  target_remote_entity?: string;
  target_remote_id?: string;
  target_display?: string;
}

// ────────────────────────────────────────────────────────────────
// Scoped-key composers — the contractual key formats. Segments join
// on ':'; every leading segment (kind / vendor / entity / source id)
// comes from a closed or dot-safe identifier vocabulary, so the final
// free-form remote id can never make two references collide.
// ────────────────────────────────────────────────────────────────

/** Contact edge — keyed on the stable canonical `contact_id`. */
export const workEntityContactEdgeKey = (contact_id: string): string =>
  `contact:${contact_id}`;

/** CRM platform-reference edge — keyed on the vendor entity + native
 *  id (connection scope is already carried by the owning Source). */
export const workEntityCrmEdgeKey = (
  vendor: string,
  entity: string,
  remote_id: string,
): string => `crm:${vendor}:${entity}:${remote_id}`;

/** Work-entity target edge — keyed on the target Source + native id. */
export const workEntityWorkEdgeKey = (
  target_kind: WorkEntityRelationshipTarget,
  target_source_id: string,
  remote_id: string,
): string => `work:${target_kind}:${target_source_id}:${remote_id}`;

/** Locally-referenced work-entity target (`canonical_id` pairing — the
 *  vendor field already carried a Recued row id). */
export const workEntityLocalEdgeKey = (
  target_kind: WorkEntityRelationshipTarget,
  local_id: string,
): string => `work:${target_kind}:local:${local_id}`;

/** Scoped-only reference (calendar.event / mail_message v1 — no local
 *  resolver yet; the remote entity disambiguates within the vendor). */
export const workEntityRefEdgeKey = (
  target_kind: WorkEntityRelationshipTarget,
  remote_entity: string | undefined,
  remote_id: string,
): string => `ref:${target_kind}:${remote_entity ?? ''}:${remote_id}`;

/** Per-cycle cap on the late re-resolution pass (unresolved work-entity
 *  targets whose Source may have synced since) — bounds the extra query
 *  cost a cycle can accrue; the remainder waits for the next cycle. */
export const WORK_ENTITY_EDGE_RERESOLVE_BATCH = 200;
