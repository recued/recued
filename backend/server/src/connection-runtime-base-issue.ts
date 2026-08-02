import type {
  ConnectionRow,
  VendorOAuthRuntimeBaseResolution,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';

export type ConnectionRuntimeBaseIssue = Extract<
  VendorOAuthRuntimeBaseResolution,
  { status: 'missing' | 'invalid' }
>;

export type ConnectionRuntimeBaseIssueSink = (
  row: ConnectionRow,
  issue: ConnectionRuntimeBaseIssue,
) => void;

/** Make an ignored provider runtime-origin response visible without recording
 * the untrusted URL or any credential returned beside it. The refresh itself
 * remains usable: rotating issuers may already have invalidated the stored
 * token, so rejecting the successful exchange would make recovery worse. */
export const makeConnectionRuntimeBaseIssueSink = (
  auditLog: Pick<AuditLogStore, 'logActivity'>,
  now: () => number = Date.now,
): ConnectionRuntimeBaseIssueSink =>
  (row, issue) => {
    const timestamp = now();
    let vendor: string | undefined;
    try {
      const parsed: unknown = JSON.parse(row.config_json);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const value = (parsed as Record<string, unknown>).vendor;
        if (typeof value === 'string' && value !== '') vendor = value;
      }
    } catch {
      // The refresh gate only reports this after resolving a registered
      // provider, but keep this advisory helper total for partial hosts.
    }
    void auditLog.logActivity({
      activity_id: `rb-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp,
      action: 'connection_runtime_base_refresh_ignored',
      target: row.name,
      detail: JSON.stringify({
        kind: row.kind,
        ...(vendor !== undefined ? { vendor } : {}),
        status: issue.status,
        field: issue.field,
        ...(issue.status === 'invalid' ? { reason: issue.reason } : {}),
      }),
    }).catch(() => { /* an advisory audit failure must never break dispatch */ });
  };
