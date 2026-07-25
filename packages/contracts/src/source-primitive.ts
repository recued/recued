/** D-145 PA1 — Source primitive types.
 *
 *  Per § A.2. A Source is a named entity provider for a top_tier_kind.
 *  Each kind has N Sources at any time (Recued built-in + per-
 *  connection + future adapter-derived + future dish-derived). PA1
 *  lays the registration shape + table; PA2 wires the resolver +
 *  default-Source memory + connection-Source auto-register.
 *
 *  Spec: docs/d-145-spec.md § A.2. */

import {
  WORK_ENTITY_KINDS,
  WORK_ENTITY_KIND_SET,
  type WorkEntityKind,
} from './work-entities.js';

/** Source-able top tier kinds — superset of `WorkEntityKind` because
 *  § A.2.1 enumerates `mail_message` / `calendar.event` / `contact` as
 *  shapes the Source registry can carry. PA1 ships the four work
 *  entities; the broader set lands as related substrate fully wires up
 *  in later phases. `file` (D-192 file SOURCE family) is a `file_meta_ref`
 *  posture kind — populated by per-vendor meta adapters, never a reception
 *  write path (it follows the `mail_message` arm, not `contact`);
 *  `docs/d-192-file-source-family.md`. */
export const SOURCE_TOP_TIER_KINDS = [
  ...WORK_ENTITY_KINDS,
  'mail_message',
  'calendar.event',
  'contact',
  'file',
] as const;
export type SourceTopTierKind = (typeof SOURCE_TOP_TIER_KINDS)[number];
export const SOURCE_TOP_TIER_KIND_SET: ReadonlySet<SourceTopTierKind> = new Set(
  SOURCE_TOP_TIER_KINDS,
);

/** Where a Source comes from. */
export const SOURCE_KINDS = ['builtin', 'connection', 'adapter', 'dish'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const SOURCE_KIND_SET: ReadonlySet<SourceKind> = new Set(SOURCE_KINDS);

/** D-192 P-1 — how a Source syncs into the warehouse (the posture). A
 *  single shape can carry two postures (a Notion page as a note-record
 *  vs a document-meta-ref), so the spine dispatches on posture, not the
 *  shape. `records` = the full-walk reconcile every Source built today
 *  uses (mail / calendar / CRM work-entities); `file_meta_ref` = list
 *  metadata + `storage_ref:'remote'`, bytes never fetched (the file
 *  SOURCE family); `contact_import` = scoped import into `data.contact`
 *  via D-138 merge. Taxonomy `docs/d-192-kinds-taxonomy.md` § 2 +
 *  `docs/d-192-file-source-family.md`. */
export const SOURCE_SYNC_POSTURES = ['records', 'file_meta_ref', 'contact_import'] as const;
export type SourceSyncPosture = (typeof SOURCE_SYNC_POSTURES)[number];
export const SOURCE_SYNC_POSTURE_SET: ReadonlySet<SourceSyncPosture> = new Set(
  SOURCE_SYNC_POSTURES,
);

/** Substrate-shipped Recued built-in Source id format —
 *  `recued.<kind>`. PA2 auto-registers one row per kind on first server
 *  init. */
export const RECUED_BUILTIN_SOURCE_ID = (kind: SourceTopTierKind): string =>
  `recued.${kind}`;

/** Connection-derived Source id format — `<vendor>.<connection_id>.<kind>`.
 *  Examples: `hubspot.<conn_id>.task` / `salesforce.<conn_id>.task`.
 *  PA2 auto-registers when D-129 / D-130 connection is enrolled with
 *  task-capable scope. */
export const CONNECTION_SOURCE_ID = (
  vendor: string,
  connection_id: string,
  kind: SourceTopTierKind,
): string => `${vendor}.${connection_id}.${kind}`;

export interface SourceRegistration {
  id: string;
  top_tier_kind: SourceTopTierKind;
  source_kind: SourceKind;
  /** D-192 P-1 — how this Source syncs (the posture). Optional in the
   *  type so callers that pre-date P-1 keep working; the store coerces
   *  `undefined → 'records'` at write time (every Source built today is
   *  records-posture). Structural, not a user toggle — preserved across
   *  boot-wire re-registration like `enabled`. Taxonomy § 2. */
  sync_posture?: SourceSyncPosture;
  source_label: string;
  write_capable: boolean;
  mcp_exposed: boolean;
  /** D-145 PA11 — Settings → Work Entities user toggle. Disabled
   *  Sources are excluded from polymorphic `data.<kind>.*` reads + the
   *  page-header dropdown's concrete-Source list (the All-Sources
   *  sentinel still resolves; it just walks fewer Sources). Disabled
   *  Sources continue to receive reconciler updates so re-enabling
   *  doesn't strand rows behind a stale cursor. Default `true` —
   *  every Source registers enabled; users opt out per Source via
   *  Settings. Optional in the type so callers that pre-date PA11
   *  (e.g. `registerSource({ enabled: undefined })`) keep working;
   *  the store coerces `undefined → true` at write time. */
  enabled?: boolean;
  schema_extension_blob?: Record<string, unknown>;
  registered_at: number;
  config_blob?: Record<string, unknown>;
}

export const isSourceTopTierKind = (v: unknown): v is SourceTopTierKind =>
  typeof v === 'string' && SOURCE_TOP_TIER_KIND_SET.has(v as SourceTopTierKind);

export const isSourceKind = (v: unknown): v is SourceKind =>
  typeof v === 'string' && SOURCE_KIND_SET.has(v as SourceKind);

export const isSourceSyncPosture = (v: unknown): v is SourceSyncPosture =>
  typeof v === 'string' && SOURCE_SYNC_POSTURE_SET.has(v as SourceSyncPosture);

/** ⚠ Derived from `WORK_ENTITY_KIND_SET`, never re-spelled. This
 *  predicate used to hand-copy the four kinds — and because
 *  `SourceTopTierKind` SPREADS `WORK_ENTITY_KINDS` (line 22), a fifth
 *  kind widened the parameter type while the body kept answering
 *  `false`: a type predicate that compiles clean and lies at runtime.
 *  It is the gate that routes `runReceptionProjection` into the
 *  work-entity arm, so the lie surfaced as "not locally
 *  materializable" with no compile error anywhere. Keep it a set
 *  lookup. */
export const isWorkEntitySourceKind = (v: SourceTopTierKind): v is WorkEntityKind =>
  WORK_ENTITY_KIND_SET.has(v as WorkEntityKind);
