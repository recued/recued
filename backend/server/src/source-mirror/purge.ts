/** D-192 source-data-removal — the per-Source teardown purge orchestrator.
 *
 *  Spec: D-192. On connection removal today's
 *  teardown cleans the derived / runtime state but deliberately ORPHANS the
 *  mirror records (`unregisterSource` orphan-flip; `file-source-boot.ts:105`
 *  TODO). D2 makes hard-removal a user opt-in ("also remove the [N] records");
 *  when checked, the connection-delete reconcile calls this per Source.
 *
 *  "One mechanism, keyed on `source_id`" (spec § 2 D1) — so this covers the
 *  registry Sources a single `source_id` owns cleanly:
 *
 *    - **file** (`file_meta_ref` posture) — the `file_meta_ref` mirror is
 *      META-ONLY: no annotation / link / enrichment writer targets a mirror
 *      row (the file enrichment producers — transcript / caption /
 *      extracted_text — run on the DISJOINT CAS `data.file.received`
 *      collection, keyed by `file:<hex>`, never a mirror `remote_id`). So the
 *      file teardown cascade is exactly the mirror-row delete.
 *    - **work-entity** (`task` / `note` / `commitment` / `project`) — the
 *      canonical `data_<kind>` rows PLUS their live-derived cascade
 *      (annotations / links / enrichments keyed `(collection = kind,
 *      target_id = row id)`) and the work-graph edges (keyed `source_id`).
 *
 *  Deliberately OUT of this per-source mechanism (a `source_id` does not own
 *  them):
 *    - The D-190 CRM platform-reference mirror (`crm_record_mirror`) + its
 *      enrichments are keyed by the VENDOR-ENTITY scope
 *      `connection.api.<vendor>.<entity>`, which is SHARED across every
 *      connection of that vendor (the per-connection discriminator lives only
 *      inside `target_id`) — a connection-level concern handled where the
 *      connection identity + vendor live (the connection-delete wiring), which
 *      is why slice 1 put `deleteAllForScope` on `CrmRecordMirrorStore`, not
 *      here.
 *    - Engagements — keyed by `connection_id`, tombstone-only.
 *    - `contact` Sources — spec § 6 retract-CONTRIBUTION policy (contacts are
 *      shared across sources, keyed on canonical email + `platform_ids`, not
 *      `source_id`), a later slice; this throws for them so the caller routes
 *      them to that policy rather than flat-deleting shared contacts.
 *
 *  NEVER touched at any tier: audit / memory provenance (`data.memory`,
 *  timeline) — the immutable record of what Recued DID, not the live record
 *  (spec § 3 "Never" tier).
 */

import type Database from 'better-sqlite3';
import { isWorkEntitySourceKind, type SourceRegistration } from '@recued/contracts';

import type { AnnotationStore } from '../storage/annotation-store.js';
import type { EnrichmentStore } from '../storage/enrichment-store.js';
import type { FileMetaStore } from '../storage/file-meta-store.js';
import type { WorkEntityStore } from '../storage/work-entity-store.js';

/** Which per-source purge path a Source dispatches to. `unsupported` covers
 *  Sources this mechanism deliberately does not reach (`mail_message` /
 *  `calendar.event` have their own lifecycle); `contact` is the § 6
 *  retract-contribution policy (a later slice). */
export type PurgeSourceFamily = 'file' | 'work_entity' | 'contact' | 'unsupported';

/** Read the purge family off a Source registration's `top_tier_kind`. */
export const resolvePurgeSourceFamily = (
  source: Pick<SourceRegistration, 'top_tier_kind'>,
): PurgeSourceFamily => {
  if (source.top_tier_kind === 'file') return 'file';
  if (isWorkEntitySourceKind(source.top_tier_kind)) return 'work_entity';
  if (source.top_tier_kind === 'contact') return 'contact';
  return 'unsupported';
};

/** Raised when `purgeSourceData` is called for a family it does not handle
 *  per-source (`contact` → § 6 retract policy; `unsupported` → own
 *  lifecycle). Carries the family so the caller can route accordingly. */
export class PurgeSourceUnsupportedError extends Error {
  constructor(
    readonly source_id: string,
    readonly family: PurgeSourceFamily,
  ) {
    super(
      `purgeSourceData: source '${source_id}' resolves to family '${family}', ` +
        `which is not handled by the per-source teardown purge`,
    );
    this.name = 'PurgeSourceUnsupportedError';
  }
}

export interface PurgeSourceDataDeps {
  /** The warehouse handle. MUST be the same `better-sqlite3` instance the
   *  other stores were created over — the work-entity family batches its
   *  per-record cascade + bulk deletes in ONE transaction over it (the inner
   *  `cascadeDelete` / `deleteRecordsForSource` transactions nest as
   *  savepoints). */
  db: Database.Database;
  /** File `file_meta_ref` mirror — file family only. */
  fileMetaStore: Pick<FileMetaStore, 'deleteAllForScope'>;
  /** Canonical work-entity records — work-entity family only. */
  workEntityStore: Pick<
    WorkEntityStore,
    'listRecordIdentitiesForSource' | 'deleteRecordsForSource'
  >;
  /** Live-derived annotations + links cascade (work-entity family). */
  annotationStore: Pick<AnnotationStore, 'cascadeDelete'>;
  /** Live-derived enrichment cascade (work-entity family). */
  enrichmentStore: Pick<EnrichmentStore, 'deleteForSource'>;
  /** Work-graph edges (D-145 P5) — hard-deleted by `source_id`. */
  edges: { deleteForSource(source_id: string): number };
}

export interface PurgeSourceDataResult {
  source_id: string;
  family: PurgeSourceFamily;
  /** Mirror / canonical records removed (`file_meta_ref` rows for file;
   *  `data_<kind>` rows for work-entity). */
  records_deleted: number;
  annotations_deleted: number;
  links_deleted: number;
  enrichments_deleted: number;
  edges_deleted: number;
}

/** Purge one Source's mirrored records + their live-derived data (the D2
 *  opt-in "also remove the mirrored data" path). Idempotent — a re-run over
 *  an already-purged Source deletes nothing and returns zeroed counts. Throws
 *  `PurgeSourceUnsupportedError` for `contact` / `unsupported` families.
 *
 *  Returns per-facet counts so the caller records the § 5 `source_data_purged`
 *  audit entry (the teardown is itself provenance). */
export const purgeSourceData = (
  source: Pick<SourceRegistration, 'id' | 'top_tier_kind'>,
  deps: PurgeSourceDataDeps,
): PurgeSourceDataResult => {
  const family = resolvePurgeSourceFamily(source);
  const base: PurgeSourceDataResult = {
    source_id: source.id,
    family,
    records_deleted: 0,
    annotations_deleted: 0,
    links_deleted: 0,
    enrichments_deleted: 0,
    edges_deleted: 0,
  };

  if (family === 'file') {
    return { ...base, records_deleted: deps.fileMetaStore.deleteAllForScope(source.id) };
  }

  if (family === 'work_entity') {
    const identities = deps.workEntityStore.listRecordIdentitiesForSource(source.id);
    const out: PurgeSourceDataResult = { ...base };
    // Phase 1 — per-record annotation/link cascade, EACH in its own
    // transaction (`cascadeDelete` self-transacts). Kept OUT of the phase-2
    // batch on purpose: `cascadeDelete` schedules physical CAS blob deletes
    // via `queueMicrotask` that fire after its transaction unwinds, so
    // running it inside a wider transaction would let a later-step rollback
    // strand a live annotation row pointing at an already-deleted blob. Per
    // record it carries the same blob-safety every other `cascadeDelete`
    // caller (merge / single-record delete) relies on.
    for (const { kind, id } of identities) {
      const cascade = deps.annotationStore.cascadeDelete(kind, id);
      out.annotations_deleted += cascade.annotations_deleted;
      out.links_deleted += cascade.links_deleted;
    }
    // Phase 2 — the blob-free bulk deletes, batched in ONE transaction (spec
    // § 5 "batch the deletes (large mirrors) inside one transaction per
    // family"): per-record enrichment deletes + the bulk record + edge
    // deletes commit atomically. The whole orchestrator is idempotent, so a
    // crash between the phases self-heals on a re-run.
    const tx = deps.db.transaction((): void => {
      for (const { kind, id } of identities) {
        // The kind IS a valid `EnrichmentScope` (task/note/commitment/project
        // are closed enrichment scopes); the row id is the enrichment
        // `target_id` (the same identity annotations use).
        out.enrichments_deleted += deps.enrichmentStore.deleteForSource(kind, id);
      }
      out.records_deleted = deps.workEntityStore.deleteRecordsForSource(source.id);
      out.edges_deleted = deps.edges.deleteForSource(source.id);
    });
    tx();
    return out;
  }

  throw new PurgeSourceUnsupportedError(source.id, family);
};

/** The removal-dialog "[N] records" preview count for a Source (spec § 5).
 *  Cheap COUNT per family; `contact` / `unsupported` preview 0 (this mechanism
 *  removes nothing for them). Kept beside `purgeSourceData` so the count and
 *  the delete share one family-dispatch. */
export const previewSourcePurgeCount = (
  source: Pick<SourceRegistration, 'id' | 'top_tier_kind'>,
  deps: {
    fileMetaStore: Pick<FileMetaStore, 'countForScope'>;
    workEntityStore: Pick<WorkEntityStore, 'countRecordsForSource'>;
  },
): number => {
  const family = resolvePurgeSourceFamily(source);
  if (family === 'file') return deps.fileMetaStore.countForScope(source.id);
  if (family === 'work_entity') return deps.workEntityStore.countRecordsForSource(source.id);
  return 0;
};
