import type { ServerPassportBackupEvidenceRedacted } from './passport.js';

/** State summaries only: no locations, receipt IDs, keys, or evidence times.
 * The server reports observation age so client/server clock skew is harmless. */
export interface ServerBackupHealthSnapshot extends ServerPassportBackupEvidenceRedacted {
  age_ms: number;
}
export const SERVER_BACKUP_HEALTH_STALE_MS = 120_000;
export type ServerBackupWarning = 'backup_overdue' | 'recovery_stale' | 'evidence_unavailable'
  | 'integrity_failed' | 'integrity_partial' | 'integrity_unavailable';
export interface ServerBackupHealthView {
  warnings: ServerBackupWarning[];
  rows: string[];
  aria: string;
}
const monitoring = ['active', 'paused', 'not_configured', 'unavailable'];
const ageStates = ['waiting', 'current', 'due', 'unavailable'];
const scanStates = ['not_checked', 'running', 'completed', 'partial', 'empty', 'failed', 'unavailable'];
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const member = (v: unknown, values: string[]): boolean => typeof v === 'string' && values.includes(v);
const valid = (v: unknown): v is ServerBackupHealthSnapshot => object(v)
  && typeof v.age_ms === 'number' && Number.isSafeInteger(v.age_ms) && v.age_ms >= 0
  && member(v.monitoring, monitoring) && (v.backup_state === undefined || member(v.backup_state, ageStates))
  && (v.recovery_test_state === undefined || member(v.recovery_test_state, ageStates))
  && object(v.integrity) && member(v.integrity.monitoring, monitoring) && member(v.integrity.state, scanStates);
const warningText: Record<ServerBackupWarning, string> = {
  backup_overdue: 'Backup overdue', recovery_stale: 'Recovery test overdue', evidence_unavailable: 'Backup evidence unavailable',
  integrity_failed: 'S3 scan needs attention', integrity_partial: 'S3 scan skipped copies', integrity_unavailable: 'S3 check status unavailable',
};
const unavailable = (): ServerBackupHealthView => ({ warnings: ['evidence_unavailable'], rows: ['Backup status unavailable'], aria: 'Backup status unavailable' });

/** Bad optional metadata never rejects a liveness heartbeat. Stale state is
 * attention; missing metadata preserves compatibility with older servers. */
export const serverBackupHealthView = (value: unknown, heartbeatAgeMs = 0): ServerBackupHealthView | undefined => {
  if (value === undefined) return undefined;
  if (!valid(value) || !Number.isFinite(heartbeatAgeMs) || heartbeatAgeMs < 0
    || value.age_ms + heartbeatAgeMs >= SERVER_BACKUP_HEALTH_STALE_MS || value.monitoring === 'unavailable') return unavailable();
  if (value.monitoring === 'not_configured') return { warnings: [], rows: ['Scheduled backups are not configured'], aria: 'Scheduled backups are not configured' };
  if (value.monitoring === 'paused') return { warnings: [], rows: ['Scheduled backups are paused'], aria: 'Scheduled backups are paused' };
  const warnings: ServerBackupWarning[] = [], rows: string[] = [];
  const b = value.backup_state, r = value.recovery_test_state, scan = value.integrity;
  rows.push(b === 'current' ? 'Backup within age limit' : b === 'waiting' ? 'Waiting for first verified backup'
    : b === 'due' ? 'Backup overdue' : 'Backup evidence unavailable');
  rows.push(r === 'current' ? 'Recovery test within age limit' : r === 'waiting' ? 'Waiting for first passing recovery test'
    : r === 'due' ? 'Recovery test overdue' : 'Recovery test evidence unavailable');
  if (b === 'due') warnings.push('backup_overdue');
  if (r === 'due') warnings.push('recovery_stale');
  if (b === undefined || b === 'unavailable' || r === undefined || r === 'unavailable') warnings.push('evidence_unavailable');
  if (scan.monitoring === 'unavailable' || scan.state === 'unavailable') {
    warnings.push('integrity_unavailable'); rows.push('S3 check status unavailable');
  } else if (scan.state === 'failed' || scan.state === 'partial') {
    const kind = scan.state === 'failed' ? 'integrity_failed' : 'integrity_partial'; warnings.push(kind); rows.push(warningText[kind]);
  } else if (scan.monitoring === 'not_configured') rows.push('S3 checks are not configured');
  else if (scan.state === 'completed') rows.push('Last S3 scan completed');
  else if (scan.state === 'empty') rows.push('Last S3 scan selected no copies');
  else if (scan.state === 'running') rows.push('S3 scan in progress');
  else rows.push(scan.monitoring === 'paused' ? 'S3 checks are off or paused' : 'Waiting for first S3 scan');
  return { warnings, rows, aria: warnings.map(w => warningText[w]).join('; ') };
};
