/** D-221 — the durable record of one `core.records.import`.
 *
 *  ⛔⛔ WHY THIS EXISTS WHEN A GATEWAY AUDIT ROW ALREADY LANDS. It does land, and
 *  exactly once per import (the per-row writes re-enter `execute` BELOW the emit,
 *  so a 1000-row file costs one row, not a thousand). But it says
 *  `outcome: 'success'` for an import that wrote NOTHING — verified by driving a
 *  file where every row was refused: `written: 0, failed: 1000, outcome:
 *  "success"`. The gateway audits that the CALL happened and returned; an import
 *  reports partial outcomes in its RESULT rather than throwing, so "it returned"
 *  and "it worked" are different facts and only one of them is recorded there.
 *
 *  ⛔ THIS IS THE SAME DEFECT THE ACTION WAS BUILT TO REMOVE, ONE LAYER UP. The
 *  recipe-level version reported SUCCESS when every `foreach` item was rejected;
 *  `RecordsImportResult` made that unsayable to a caller. The durable trail was
 *  still saying it. A bulk write over the owner's money is precisely where "it
 *  ran" must not be mistaken for "it landed".
 *
 *  🔑 SHAPED AFTER `collection_backfill` (D-124 P2.4), which already audits a bulk
 *  ingest this way: one sync-level row, exact counts in `detail`, no per-record
 *  churn. The one deliberate divergence is reserve-class — see `RESERVE_ACTIONS`.
 */
import type { RecordsImportResult, RecordsPackRef } from '@recued/contracts';

export const RECORDS_IMPORT_ACTION = 'records_import';

/** The event the store emits. Deliberately NOT `AuditLogStore`: the records store
 *  owns no audit table and should not learn about one — it emits a typed fact and
 *  the server decides that fact becomes an activity row. Same seam the gateway
 *  uses (`ExecutionContext.onGatewayCall`), for the same reason. */
export interface RecordsImportAudit {
  readonly owner: RecordsPackRef;
  readonly entity: string;
  /** The derived principal the write ran as — who imported. */
  readonly principal: string;
  readonly duration_ms: number;
  readonly result: RecordsImportResult;
}

/** ⛔ THE COUNTS ARE CARRIED WHOLE, not summarised to a status. A single
 *  `status: 'partial'` would be smaller and would answer none of the questions an
 *  owner actually asks months later — how many landed, how many were already
 *  held, how many were refused and why, how many cells could not be read. The
 *  arithmetic invariant (`rows_read === written + replayed + failed +
 *  not_attempted`) travels with them, so a reader can prove the row accounts for
 *  every line of the file. */
export interface RecordsImportAuditDetail {
  source: 'records.import';
  publisher: string;
  pack_slug: string;
  entity: string;
  principal: string;
  duration_ms: number;
  rows_read: number;
  written: number;
  replayed: number;
  failed: number;
  not_attempted: number;
  /** Cells that arrived non-empty and would not parse. ⚠ NOT a row count — those
   *  rows landed, with the field null rather than a fabricated zero. */
  unparsed: number;
  /** Present only when the import stopped early on a namespace-level refusal
   *  (quota / fence / coherence). Its presence is what makes a short import
   *  legible as deliberate rather than as data the owner never had. */
  halted_reason?: string;
  /** ⛔ THE ONE DERIVED FIELD, and it is derived rather than trusted: an import
   *  that refused or skipped anything is NOT a clean import, whatever the
   *  dispatch row says. Stored so a query can find partial imports without
   *  re-deriving the rule, and so the rule lives in one place. */
  partial: boolean;
}

export const recordsImportAuditDetail = (
  event: RecordsImportAudit,
): RecordsImportAuditDetail => {
  const r = event.result;
  return {
    source: 'records.import',
    publisher: event.owner.publisher,
    pack_slug: event.owner.pack_slug,
    entity: event.entity,
    principal: event.principal,
    duration_ms: event.duration_ms,
    rows_read: r.rows_read,
    written: r.written,
    replayed: r.replayed,
    failed: r.failed,
    not_attempted: r.not_attempted,
    unparsed: r.unparsed,
    ...(r.halted_reason === undefined ? {} : { halted_reason: r.halted_reason }),
    partial: r.failed > 0 || r.not_attempted > 0 || r.halted_reason !== undefined,
  };
};

/** `<publisher>/<pack_slug>:<entity>` — the same faceting `collection_backfill`
 *  uses, so a list/filter query scopes without parsing the JSON detail. */
export const recordsImportAuditTarget = (event: RecordsImportAudit): string =>
  `${event.owner.publisher}/${event.owner.pack_slug}:${event.entity}`;
