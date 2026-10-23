/** Owner-only remote archive delivery. Credentials and recovery words never
 * enter these views or the durable delivery ledger. Verification means that
 * the retrieved ciphertext matched the exported bytes, not a restored DB. */
export interface ArchiveRemoteTarget {
  operation_id: string;
  connection_name: string;
  destination_id: string;
  keep_last: number;
}

export interface ArchiveRemoteDestination {
  connection_name: string;
  /** Binds the displayed bucket/endpoint/scope, without credential material. */
  destination_id: string;
  bucket: string;
  region: string;
  endpoint: string;
  /** App-owned objects stay inside the connection's selected resource scope. */
  prefix: string;
}

export type ArchiveRemoteState = 'preparing' | 'uploading' | 'verifying'
  | 'verified' | 'unconfirmed' | 'pruning' | 'pruned';
export type ArchiveRemoteIssue = 'interrupted' | 'export_failed' | 'destination_unavailable'
  | 'transfer_unconfirmed' | 'verification_failed';

export interface ArchiveRemoteBackup {
  operation_id: string;
  job_id: string;
  destination: ArchiveRemoteDestination;
  object_key: string;
  created_at: number;
  state: ArchiveRemoteState;
  keep_last: number;
  bytes?: number;
  sha256?: string;
  verified_at?: number;
  issue?: ArchiveRemoteIssue;
  retention_pending?: boolean;
}

/** One server-owned schedule. Times are explicit UTC, including weekly day
 * (0 = Sunday). Missed slots coalesce into one run when the server returns. */
export interface ArchiveBackupSchedule {
  cadence: 'daily' | 'weekly';
  hour_utc: number;
  minute_utc: number;
  weekday_utc: number;
}
export interface ArchiveUnattendedSettings {
  enabled: boolean;
  connection_name: string;
  destination_id: string;
  keep_last: number;
  schedule: ArchiveBackupSchedule;
}
export type ArchiveUnattendedIssue = ArchiveRemoteIssue | 'vault_unavailable' | 'insufficient_storage' | 'setup_required' | 'history_unavailable' | 'retention_pending';
export const ARCHIVE_UNATTENDED_ISSUE_TEXT: Record<ArchiveUnattendedIssue, string> = {
  interrupted: 'The server stopped before the backup was confirmed.',
  export_failed: 'The encrypted archive could not be created.',
  destination_unavailable: 'The storage connection changed or is unavailable.',
  transfer_unconfirmed: 'The remote copy could not be confirmed.',
  verification_failed: 'The stored copy did not match the exported bytes.',
  vault_unavailable: 'The server vault is locked or unavailable.',
  insufficient_storage: 'The server does not have enough free disk space.',
  setup_required: 'Complete the one-time backup setup again.',
  history_unavailable: 'Backup history could not be read or saved.',
  retention_pending: 'Some older copies could not be removed.',
};
export interface ArchiveUnattendedStatus {
  configured: boolean;
  settings?: ArchiveUnattendedSettings;
  next_run_at?: number;
  last_run?: {
    operation_id: string;
    started_at: number;
    finished_at?: number;
    outcome: 'running' | 'verified' | 'failed';
    issue?: ArchiveUnattendedIssue;
  };
  alert_pending?: boolean;
}

/** A recovery check of exact remote bytes in a disposable, unstarted realm.
 * This evidence is historical: it does not assert the object still exists. */
export type ArchiveRestoreDrillState = 'retrieving' | 'restoring' | 'checking' | 'cleaning' | 'succeeded' | 'failed';
export type ArchiveRestoreDrillIssue = 'interrupted' | 'retrieval_failed' | 'restore_failed'
  | 'integrity_failed' | 'insufficient_storage' | 'cleanup_failed' | 'worker_failed' | 'worker_timeout' | 'stopped' | 'cancelled';
export const ARCHIVE_RESTORE_DRILL_ISSUE_TEXT: Record<ArchiveRestoreDrillIssue, string> = {
  interrupted: 'The server stopped before this drill finished. Start a new drill to try again.',
  retrieval_failed: 'The remote copy could not be retrieved and verified.',
  restore_failed: 'The archive could not be restored. Check its recovery words and server version.',
  integrity_failed: 'The recovered database or its referenced blobs failed a check.',
  insufficient_storage: 'The server does not have enough free disk space for this drill.',
  cleanup_failed: 'The test failed to remove its temporary realm.',
  worker_failed: 'The recovery worker stopped without a confirmed result. Start a new test to try again.',
  worker_timeout: 'The recovery worker exceeded its time limit. Its temporary files have been removed.',
  stopped: 'The server stopped this recovery test for maintenance. Start a new test when it is ready.',
  cancelled: 'You cancelled this recovery test. Its temporary files have been removed.',
};
export interface ArchiveRestoreDrillChecks {
  version: 1;
  server_version: string;
  database_integrity: 'ok';
  foreign_keys: 'ok';
  local_boot_key: 'ok';
  database_bytes: number;
  restored_blob_records: number;
  referenced_blobs: number;
  blob_bytes: number;
}
export interface ArchiveRestoreDrill {
  operation_id: string;
  backup_operation_id: string;
  destination_id: string;
  archive_sha256: string;
  archive_bytes: number;
  started_at: number;
  finished_at?: number;
  state: ArchiveRestoreDrillState;
  issue?: ArchiveRestoreDrillIssue;
  cleanup_pending?: boolean;
  /** Durable owner intent; cancellation is complete only at terminal status. */
  cancel_requested_at?: number;
  /** Later cleanup never upgrades a failed test to a pass. */
  cleanup_completed_at?: number;
  /** Only a completed drill whose private files were removed carries checks. */
  checks?: ArchiveRestoreDrillChecks;
}

/** These limits follow the enabled scheduled-backup destination. */
export interface ArchiveBackupHealthPolicy {
  alerts_enabled: boolean;
  backup_max_age_hours: number;
  recovery_max_age_days: number;
}
export type ArchiveBackupHealthState = 'waiting' | 'current' | 'due' | 'unavailable';
export type ArchiveBackupHealthIssue = 'history_unavailable' | 'clock_changed';
export type ArchiveBackupHealthAlertKind = 'backup_overdue' | 'recovery_stale' | 'evidence_unavailable';
export interface ArchiveBackupHealthAlert {
  kind: ArchiveBackupHealthAlertKind;
  first_detected_at: number;
  delivery: 'pending' | 'delivered';
}
export interface ArchiveBackupHealthStatus {
  checked_at: number;
  policy: ArchiveBackupHealthPolicy;
  monitoring: 'active' | 'paused' | 'not_configured' | 'unavailable';
  issue?: 'settings_unavailable' | 'schedule_unavailable';
  destination?: { connection_name: string; destination_id: string };
  watched_since?: number;
  backup?: {
    state: ArchiveBackupHealthState;
    issue?: ArchiveBackupHealthIssue;
    due_at?: number;
    operation_id?: string;
    /** Freshness follows snapshot/attempt creation, never a later recheck. */
    created_at?: number;
    verified_at?: number;
  };
  recovery?: {
    state: ArchiveBackupHealthState;
    issue?: ArchiveBackupHealthIssue;
    due_at?: number;
    operation_id?: string;
    backup_operation_id?: string;
    /** Historical proof for this destination, including a later pruned copy. */
    finished_at?: number;
  };
  alerts: ArchiveBackupHealthAlert[];
}

/** Opt-in full-ciphertext reads of previously verified, retained copies at the
 * enabled unattended-backup destination. No recovery factor is needed. */
export interface ArchiveBackupIntegrityPolicy {
  enabled: boolean;
  schedule: ArchiveBackupSchedule;
}
export type ArchiveBackupIntegrityIssue = ArchiveRemoteIssue | 'history_unavailable' | 'stopped';
export interface ArchiveBackupIntegrityRun {
  operation_id: string;
  destination_id: string;
  started_at: number;
  finished_at?: number;
  outcome: 'running' | 'completed' | 'failed';
  total: number;
  checked: number;
  failed: number;
  skipped: number;
  issue?: ArchiveBackupIntegrityIssue;
}
export interface ArchiveBackupIntegrityStatus {
  policy: ArchiveBackupIntegrityPolicy;
  monitoring: 'active' | 'paused' | 'not_configured' | 'unavailable';
  issue?: 'settings_unavailable' | 'schedule_unavailable' | 'clock_changed';
  destination?: { connection_name: string; destination_id: string };
  next_run_at?: number;
  last_run?: ArchiveBackupIntegrityRun;
  alert_pending?: boolean;
}
