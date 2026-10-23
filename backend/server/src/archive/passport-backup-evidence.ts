/** Project existing receipt observers into Passport. No exports, remote reads,
 * recovery factors, notification calls, or new evidence stores belong here. */
import type { ArchiveBackupHealthStatus, ArchiveBackupIntegrityStatus, BackupWatchdogStatus,
  ServerPassportBackupEvidence, ServerPassportRecoveryBlock } from '@recued/contracts';
import type { BackupHealth } from './backup-health.js';
import type { BackupIntegrity } from './backup-integrity.js';
import type { BackupWatchdog } from './backup-watchdog.js';
import { watchdogEvidenceForPassport } from './passport-backup-watchdog.js';

export interface PassportBackupReceiptSources {
  backupHealth?: Pick<BackupHealth, 'status'>;
  backupIntegrity?: Pick<BackupIntegrity, 'status'>;
}
export interface PassportBackupSources extends PassportBackupReceiptSources {
  backupWatchdog?: Pick<BackupWatchdog, 'status'>;
}

export const backupRecoveryForPassport = (sources?: PassportBackupSources, now = Date.now): ServerPassportRecoveryBlock => {
  let health: ArchiveBackupHealthStatus | undefined, integrity: ArchiveBackupIntegrityStatus | undefined;
  let watchdog: BackupWatchdogStatus | undefined;
  try { health = sources?.backupHealth?.status(); } catch { /* Keep reconnect certificate verification available. */ }
  try { integrity = sources?.backupIntegrity?.status(); } catch { /* No raw error text enters a signed passport. */ }
  try { watchdog = sources?.backupWatchdog?.status(); } catch { /* A monitor failure must not block certificate verification. */ }
  const observed_at = now();
  const evidence: ServerPassportBackupEvidence = { observed_at, monitoring: health?.monitoring ?? 'unavailable',
    ...(health?.issue ? { issue: health.issue } : !health ? { issue: 'service_unavailable' } : {}),
    integrity: { monitoring: 'unavailable', state: 'unavailable', issue: 'service_unavailable' },
    watchdog: watchdogEvidenceForPassport(watchdog, observed_at) };
  if (health && health.checked_at > observed_at) { evidence.monitoring = 'unavailable'; evidence.issue = 'clock_changed'; }
  if (health?.destination && evidence.monitoring !== 'unavailable') evidence.destination = {
    connection_name: health.destination.connection_name, destination_id: health.destination.destination_id,
  };
  // Explicit field lists prevent future service-only metadata from leaking into
  // either full profile. Paused/unavailable observers make no current age claim.
  if (health && evidence.monitoring === 'active') {
    const b = health.backup, r = health.recovery;
    if (b) evidence.backup = { state: b.state,
      ...(b.issue === undefined ? {} : { issue: b.issue }), ...(b.due_at === undefined ? {} : { due_at: b.due_at }),
      ...(b.operation_id === undefined ? {} : { operation_id: b.operation_id }), ...(b.created_at === undefined ? {} : { created_at: b.created_at }),
      ...(b.verified_at === undefined ? {} : { verified_at: b.verified_at }) };
    if (r) evidence.recovery_test = { state: r.state,
      ...(r.issue === undefined ? {} : { issue: r.issue }), ...(r.due_at === undefined ? {} : { due_at: r.due_at }),
      ...(r.operation_id === undefined ? {} : { operation_id: r.operation_id }),
      ...(r.backup_operation_id === undefined ? {} : { backup_operation_id: r.backup_operation_id }),
      ...(r.finished_at === undefined ? {} : { finished_at: r.finished_at }) };
  }
  if (integrity) {
    const scan: ServerPassportBackupEvidence['integrity'] = { monitoring: integrity.monitoring,
      state: integrity.monitoring === 'unavailable' ? 'unavailable' : 'not_checked',
      ...(integrity.issue ? { issue: integrity.issue } : {}) };
    evidence.integrity = scan;
    if (integrity.monitoring !== 'unavailable') {
      const destination = evidence.destination, target = integrity.destination;
      if (destination && target && destination.destination_id === target.destination_id) {
        if (integrity.next_run_at !== undefined) scan.next_run_at = integrity.next_run_at;
        const run = integrity.last_run;
        if (run?.destination_id === destination.destination_id) {
          if (run.started_at > observed_at || (run.finished_at !== undefined && run.finished_at > observed_at)) {
            scan.monitoring = 'unavailable'; scan.state = 'unavailable'; scan.issue = 'clock_changed'; delete scan.next_run_at;
          } else {
            scan.state = run.outcome === 'running' ? 'running' : run.outcome === 'failed' ? 'failed'
              : run.total === 0 ? 'empty' : run.skipped > 0 || run.checked < run.total ? 'partial' : 'completed';
            scan.last_run = { operation_id: run.operation_id, started_at: run.started_at, outcome: run.outcome,
              total: run.total, checked: run.checked, failed: run.failed, skipped: run.skipped,
              ...(run.finished_at === undefined ? {} : { finished_at: run.finished_at }), ...(run.issue === undefined ? {} : { issue: run.issue }) };
          }
        }
      } else if (integrity.monitoring !== 'not_configured') {
        scan.monitoring = 'unavailable'; scan.state = 'unavailable';
        scan.issue = evidence.monitoring === 'unavailable' ? 'service_unavailable' : 'destination_changed';
      }
    }
  }
  const backup_status: ServerPassportRecoveryBlock['backup_status'] = evidence.monitoring === 'unavailable' ? 'unavailable'
    : evidence.monitoring === 'not_configured' ? 'unconfigured'
    : evidence.monitoring === 'paused' ? 'configured'
    : !evidence.backup || evidence.backup.state === 'unavailable' ? 'unavailable'
    : evidence.backup.state === 'due' ? 'overdue' : 'configured';
  return { backup_status, filevault_recovery_key_status: 'absent', backup_evidence: evidence,
    ...(evidence.backup?.created_at !== undefined && (evidence.backup.state === 'current' || evidence.backup.state === 'due')
      ? { last_backup_at: evidence.backup.created_at } : {}) };
};
