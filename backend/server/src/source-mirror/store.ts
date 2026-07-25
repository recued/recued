/** source_mirror — the mirror-store contract (D-192 P1.5 extraction).
 *
 *  The interface shape every Source-mirror store shares — "the CRM
 *  mirror store contributes an interface shape, not a table" (D-192
 *  spec § Reusing the CRM mirror pattern). The D-190
 *  `CrmRecordMirrorStore` (a dedicated `crm_record_mirror` table) is
 *  the first implementation; the D-192 P3 `WorkEntitySourceMirrorStore`
 *  (an adapter over `data_task` / `data_project` / `data_note`, keyed
 *  by `(source_id, source_record_id)`) is the second. Reconcilers /
 *  sync runners program against THIS shape, so the diff/hash spine
 *  never couples to a family's storage.
 *
 *  Type parameters: `Scope` — the row namespace (the CRM
 *  platform-reference `EnrichmentScope`, a work-entity `source_id`);
 *  `Meta` — the canonical snapshot payload; `Row` — the list row shape;
 *  `ListOpts` — the family's closed filter vocabulary. */

export interface SourceMirrorStore<Scope extends string, Meta, Row, ListOpts> {
  /** Upsert one record's canonical snapshot. Must preserve first-seen
   *  time on conflict and be idempotent for an unchanged record. */
  upsert(input: { scope: Scope; target_id: string; meta: Meta; now: number }): void;
  /** List the mirror rows for a scope with the family's closed filters
   *  applied in storage (post-filter limit — never an under-returning
   *  local trim). */
  list(scope: Scope, opts?: ListOpts): Row[];
  /** The per-scope `target_id → snapshot_hash` map, UNCAPPED — the
   *  incremental seam. A full-walk reconciler reads this once per cycle
   *  to skip unchanged records (and to compute the complete-walk delete
   *  diff). Records without a stored hash must be omitted (they re-sync
   *  as changed, never falsely match). */
  listSnapshotHashes(scope: Scope): Map<string, string>;
  /** Remove a record's mirror row (delete-cascade on a remote record
   *  delete). Returns true when a row was removed. */
  deleteForSource(scope: Scope, target_id: string): boolean;
  /** Bulk-remove EVERY mirror row for a scope — the Source-teardown purge
   *  (the opt-in "also remove the mirrored data" path; D-192 source-data-
   *  removal). Returns the number of rows deleted. Distinct from the single-row
   *  `deleteForSource` (a per-record delete-cascade during reconcile). */
  deleteAllForScope(scope: Scope): number;
  /** Count the mirror rows currently held for a scope — the preview count the
   *  teardown checkbox surfaces ("also remove [N] records"). */
  countForScope(scope: Scope): number;
}
