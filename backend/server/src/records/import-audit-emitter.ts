/** D-221 — turn the records store's import fact into a durable activity row.
 *
 *  The mirror of `createGatewayAuditEmitter`: the store emits a typed event and
 *  knows nothing about audit tables; this translates it. Fire-and-forget, because
 *  a back-pressured audit log must never fail an import that already wrote rows.
 */
import { RESERVE_ACTIONS, type AuditLogStore } from '@recued/storage';

import {
  RECORDS_IMPORT_ACTION,
  recordsImportAuditDetail,
  recordsImportAuditTarget,
  type RecordsImportAudit,
} from './import-audit.js';

const defaultNewActivityId = (now: number): string =>
  `rec-import-${now}-${Math.random().toString(36).slice(2, 8)}`;

export const createRecordsImportAuditEmitter = (
  auditLog: AuditLogStore,
  now: () => number = Date.now,
  newActivityId: (at: number) => string = defaultNewActivityId,
): ((event: RecordsImportAudit) => void) =>
  (event) => {
    const ts = now();
    void auditLog
      .logActivity({
        activity_id: newActivityId(ts),
        timestamp: ts,
        action: RECORDS_IMPORT_ACTION,
        target: recordsImportAuditTarget(event),
        detail: JSON.stringify(recordsImportAuditDetail(event)),
      })
      .catch(() => {
        /* audit back-pressure never breaks an import */
      });
  };

/** ⛔ A COMPILE-TIME TIE between the action and its reserve classification.
 *  `RESERVE_ACTIONS` is a `Set<string>`, so a typo or a later removal there is
 *  invisible to `tsc` — and this row's whole justification is that it survives
 *  eviction (it is provenance for data that cannot be re-synced). Read at module
 *  load so a mismatch is a boot-time throw rather than a discovery months later,
 *  when the row an owner went looking for is the one that got evicted. */
export const RECORDS_IMPORT_IS_RESERVE = RESERVE_ACTIONS.has(RECORDS_IMPORT_ACTION);
if (!RECORDS_IMPORT_IS_RESERVE) {
  throw new Error(
    `D-221: '${RECORDS_IMPORT_ACTION}' must be in RESERVE_ACTIONS — an import row `
      + 'is the only record of which file put which rows in the ledger, and Records '
      + 'rows cannot be re-synced from a source the way a collection can.',
  );
}
