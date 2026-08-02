import type { ConnectionRow } from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';

export type ConnectionCredentialPersistFailureSink = (
  row: ConnectionRow,
  error: unknown,
) => void;

/** Make a swallowed refreshed-credential write audible without making the
 * already-completed exchange fail or recording credential material. */
export const makeConnectionCredentialPersistFailureSink = (
  auditLog: Pick<AuditLogStore, 'logActivity'>,
  now: () => number = Date.now,
): ConnectionCredentialPersistFailureSink =>
  (row, error) => {
    const timestamp = now();
    void auditLog.logActivity({
      activity_id: `cp-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp,
      action: 'connection_credential_persist_failed',
      target: row.name,
      detail: JSON.stringify({
        kind: row.kind,
        error: error instanceof Error ? error.message : String(error),
      }),
    }).catch(() => { /* an advisory audit failure must never break dispatch */ });
  };
