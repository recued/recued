/** D-192 source-data-removal — the CONNECTION-level teardown purge.
 *
 *  Spec D-192 § 5. Fans the per-Source
 *  `purgeSourceData` (this module's sibling `purge.ts`) over every registry
 *  Source a removed connection owns — matched by the connection name embedded
 *  in a connection-Source id (`<vendor>.<name>.<kind>`) — and sums the
 *  per-facet counts into the `ConnectionDataPurgeSummary` the delete rpc
 *  returns + the `source_data_purged` audit records.
 *
 *  Scope (slice 3a): the registry Sources a `source_id` owns cleanly — file
 *  `file_meta_ref` mirrors + work-entity `data_<kind>` records (+ their
 *  live-derived annotations/links/enrichments + edges). `contact` Sources
 *  raise `PurgeSourceUnsupportedError` from `purgeSourceData` and are counted
 *  as `sources_skipped` (the § 6 retract-contribution policy is a later slice).
 *
 *  NOT here yet (the connection/vendor-keyed footprint, a later sub-slice —
 *  it is NOT owned by a work-entity `source_id`):
 *    - the D-190 CRM platform-reference mirror (`crm_record_mirror`), keyed by
 *      the vendor-entity scope `connection.api.<vendor>.<entity>` — SHARED
 *      across every connection of that vendor (per-connection discriminator
 *      lives only in `target_id`), so a hard purge must delete by the
 *      per-connection `target_id` prefix, not the whole scope.
 *    - engagements — `connection_id`(= name)-keyed, already tombstoned on
 *      connection delete by the existing D-129/130 `addOnDelete` hook; spec
 *      keeps them tombstone-only.
 */

import {
  CONNECTION_VENDOR_ENTITIES,
  composeConnectionTargetIdPrefix,
  type ConnectionDataPurgeSummary,
} from '@recued/contracts';

import { sourceIdConnectionName } from '../work-entity-source-boot.js';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import type { FileMetaStore } from '../storage/file-meta-store.js';
import type { CrmRecordMirrorStore } from '../storage/crm-record-mirror-store.js';
import type { EnrichmentStore } from '../storage/enrichment-store.js';
import type { ContactStore } from '../storage/contact-store.js';
import {
  PurgeSourceUnsupportedError,
  purgeSourceData,
  previewSourcePurgeCount,
  type PurgeSourceDataDeps,
} from './purge.js';

export interface PurgeConnectionDataDeps extends PurgeSourceDataDeps {
  /** Additionally needs `listSources` to enumerate the connection's Sources. */
  workEntityStore: PurgeSourceDataDeps['workEntityStore'] & Pick<WorkEntityStore, 'listSources'>;
  /** The enrichment store also hard-deletes the CRM platform-reference
   *  enrichments by connection prefix (extends the per-source `deleteForSource`). */
  enrichmentStore: PurgeSourceDataDeps['enrichmentStore'] &
    Pick<EnrichmentStore, 'deleteForScopeAndTargetPrefix'>;
  /** D-192 slice 3b — the D-190 CRM platform-reference mirror. Optional: a
   *  connection with no CRM mirror (non-vendor api / dbless) skips the CRM leg. */
  crmRecordMirror?: Pick<CrmRecordMirrorStore, 'deleteForConnection'>;
  /** D-192 slice 4 — the D-138 contact store, for the messenger contact-link
   *  retract leg. Optional: absent (dbless) or a non-messenger connection skips
   *  it. */
  contactStore?: Pick<ContactStore, 'retractPlatformLinksForConnection'>;
}

const emptySummary = (): ConnectionDataPurgeSummary => ({
  sources_purged: 0,
  sources_skipped: 0,
  records_deleted: 0,
  annotations_deleted: 0,
  links_deleted: 0,
  enrichments_deleted: 0,
  edges_deleted: 0,
  crm_records_deleted: 0,
  crm_enrichments_deleted: 0,
  contact_links_retracted: 0,
});

/** Purge every registry Source owned by `connection_name` PLUS — when a
 *  `vendor` is given (api CRM connections) — the D-190 platform-reference
 *  mirror (deal/contact/account) + its enrichments for THIS connection, PLUS —
 *  when a `messenger_vendor` is given (slack/telegram notification connections)
 *  — this connection's D-138 `contact_platform_link` associations (slice 4).
 *  Idempotent (a re-run sums zeros) and total across Sources — a Source this
 *  mechanism does not hard-delete (`contact`) is skipped, not fatal. Returns
 *  the summed per-facet counts. */
export const purgeConnectionData = (
  input: { connection_name: string; vendor?: string; messenger_vendor?: string },
  deps: PurgeConnectionDataDeps,
): ConnectionDataPurgeSummary => {
  const summary = emptySummary();
  for (const source of deps.workEntityStore.listSources()) {
    // Only connection-derived Sources carry a connection name in their id;
    // builtin / adapter / dish Sources are not a connection's to purge.
    if (source.source_kind !== 'connection') continue;
    if (sourceIdConnectionName(source.id) !== input.connection_name) continue;
    try {
      const r = purgeSourceData(source, deps);
      summary.sources_purged += 1;
      summary.records_deleted += r.records_deleted;
      summary.annotations_deleted += r.annotations_deleted;
      summary.links_deleted += r.links_deleted;
      summary.enrichments_deleted += r.enrichments_deleted;
      summary.edges_deleted += r.edges_deleted;
    } catch (err) {
      // `contact` (retract-contribution, later slice) + mail/calendar (own
      // lifecycle) are skipped, not fatal — the rest of the connection's
      // Sources still purge.
      if (err instanceof PurgeSourceUnsupportedError) {
        summary.sources_skipped += 1;
        continue;
      }
      throw err;
    }
  }

  // D-192 slice 3b — the CRM platform-reference footprint (D-190), NOT a
  // registry Source. Its rows live under the vendor-SHARED scope
  // `connection.api.<vendor>.<entity>`, so cut to THIS connection by the
  // `<vendor>_<entity>_<connection_name>_` target_id prefix — the whole-scope
  // delete would irreversibly wipe a sibling same-vendor connection.
  if (input.vendor !== undefined && input.vendor.length > 0 && deps.crmRecordMirror) {
    for (const entry of CONNECTION_VENDOR_ENTITIES) {
      if (entry.vendor !== input.vendor) continue;
      const prefix = composeConnectionTargetIdPrefix(input.vendor, entry.entity, input.connection_name);
      summary.crm_records_deleted += deps.crmRecordMirror.deleteForConnection(entry.scope, prefix);
      summary.crm_enrichments_deleted += deps.enrichmentStore.deleteForScopeAndTargetPrefix(
        entry.scope,
        prefix,
      );
    }
  }

  // D-192 slice 4 — the messenger contact footprint (D-138), NOT a registry
  // Source and NOT the CRM mirror. `contact_platform_link` rows are keyed
  // `(vendor, platform_id)` with a nullable `connection_name` discriminator, so
  // cut to THIS connection by `(messenger_vendor, connection_name)`. A sibling
  // same-vendor messenger connection's rows carry a different `connection_name`
  // and are untouched (except the pre-existing D-138 collision case where two
  // connections' senders share a platform_id — the first linker owns the one PK
  // row; see the store's schema note). Removes only the sender→email
  // ASSOCIATION; the shared `contacts` row is never deleted (a messenger link
  // never owns one — every contact carries a first-party source).
  if (
    input.messenger_vendor !== undefined &&
    input.messenger_vendor.length > 0 &&
    deps.contactStore
  ) {
    summary.contact_links_retracted += deps.contactStore.retractPlatformLinksForConnection(
      input.messenger_vendor,
      input.connection_name,
    ).links_removed;
  }
  return summary;
};

export interface PreviewConnectionPurgeCountDeps {
  /** `listSources` to enumerate the connection's Sources; `countRecordsForSource`
   *  is the per-source work-entity count `previewSourcePurgeCount` reads. */
  workEntityStore: Pick<WorkEntityStore, 'listSources' | 'countRecordsForSource'>;
  /** File `file_meta_ref` mirror count (file-family Sources). */
  fileMetaStore: Pick<FileMetaStore, 'countForScope'>;
  /** The D-190 CRM platform-reference mirror. Optional — a connection with no
   *  CRM mirror (non-vendor api / dbless) skips the CRM leg (mirrors the purge). */
  crmRecordMirror?: Pick<CrmRecordMirrorStore, 'countForConnection'>;
  /** D-192 slice 4 — the D-138 contact store, for the messenger contact-link
   *  count leg (mirrors the purge's retract leg). Optional. */
  contactStore?: Pick<ContactStore, 'countPlatformLinksForConnection'>;
}

/** The removal-confirm dialog's "[N] records" preview (spec § 5 / § 8 slice 3c)
 *  — the read-only COUNT twin of `purgeConnectionData`. Sums the primary-record
 *  count (`previewSourcePurgeCount`, cheap per-family COUNT) over every registry
 *  Source the connection owns PLUS — when a `vendor` is given (api CRM
 *  connections) — the D-190 CRM mirror rows for THIS connection (per-connection
 *  `target_id` prefix, so a sibling same-vendor connection is not counted). The
 *  count is the primary records the user is deciding to remove; the live-derived
 *  cascade (annotations / links / enrichments / edges) follows the records and is
 *  deliberately NOT in the label (matching `previewSourcePurgeCount`, which
 *  counts primary records only). No mutation, no gate — exactly the quorum a
 *  `remove_mirror_data: true` delete would purge, counted not removed. */
export const previewConnectionPurgeCount = (
  input: { connection_name: string; vendor?: string; messenger_vendor?: string },
  deps: PreviewConnectionPurgeCountDeps,
): number => {
  let count = 0;
  for (const source of deps.workEntityStore.listSources()) {
    // Same Source filter as the purge: only connection-derived Sources carry a
    // connection name; builtin / adapter / dish Sources are not this
    // connection's to count.
    if (source.source_kind !== 'connection') continue;
    if (sourceIdConnectionName(source.id) !== input.connection_name) continue;
    // `contact` / `unsupported` families preview 0 (this mechanism removes
    // nothing for them) — the count matches what the purge would actually delete.
    count += previewSourcePurgeCount(source, deps);
  }

  // The CRM platform-reference footprint (D-190), cut to THIS connection by the
  // `<vendor>_<entity>_<connection_name>_` target_id prefix — the same
  // per-connection scoping the purge's CRM leg deletes by.
  if (input.vendor !== undefined && input.vendor.length > 0 && deps.crmRecordMirror) {
    for (const entry of CONNECTION_VENDOR_ENTITIES) {
      if (entry.vendor !== input.vendor) continue;
      const prefix = composeConnectionTargetIdPrefix(input.vendor, entry.entity, input.connection_name);
      count += deps.crmRecordMirror.countForConnection(entry.scope, prefix);
    }
  }

  // D-192 slice 4 — the messenger contact-link footprint (D-138), the same
  // `(messenger_vendor, connection_name)` cut the purge's retract leg deletes by
  // → the count equals exactly what a `remove_mirror_data: true` teardown removes.
  if (
    input.messenger_vendor !== undefined &&
    input.messenger_vendor.length > 0 &&
    deps.contactStore
  ) {
    count += deps.contactStore.countPlatformLinksForConnection(
      input.messenger_vendor,
      input.connection_name,
    );
  }
  return count;
};
