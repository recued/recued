/** Owner-only configuration. The credential-bearing URL is write-only. */
export interface BackupWatchdogSave {
  enabled: boolean;
  ping_url?: string;
  forget?: boolean;
}
export type BackupWatchdogIssue = 'settings_unavailable' | 'clock_changed' | 'backup_not_current'
  | 'backup_attention' | 'scan_not_ready' | 'vault_unavailable' | 'ping_failed';
export interface BackupWatchdogStatus {
  configured: boolean;
  enabled: boolean;
  state: 'not_configured' | 'paused' | 'waiting' | 'blocked' | 'sending' | 'acknowledged' | 'failed' | 'unavailable' | 'drill_paused';
  configuration_revision?: string;
  drill?: BackupWatchdogDrill;
  issue?: BackupWatchdogIssue;
  last_attempt_at?: number;
  last_acknowledged_at?: number;
}
export const BACKUP_WATCHDOG_DRILL_MINUTES = [10, 15, 30, 60] as const;
export type BackupWatchdogDrillPhase = 'paused' | 'resuming' | 'awaiting_confirmation' | 'completed' | 'cancelled' | 'superseded';
export interface BackupWatchdogDrill {
  operation_id: string;
  phase: BackupWatchdogDrillPhase;
  pause_minutes: (typeof BACKUP_WATCHDOG_DRILL_MINUTES)[number];
  started_at: number;
  pause_until: number;
  resumed_at?: number;
  /** Owner attestation time, not an observation from the alert provider. */
  alert_reported_at?: number;
  /** Recorded only by the sender for a request admitted after resumption. */
  ping_acknowledged_at?: number;
  finished_at?: number;
  current_configuration: boolean;
}
export interface BackupWatchdogDrillStart {
  operation_id: string;
  configuration_revision: string;
  pause_minutes: (typeof BACKUP_WATCHDOG_DRILL_MINUTES)[number];
}
export interface BackupWatchdogDrillUpdate {
  operation_id: string;
  action: 'confirm_alert' | 'cancel';
}
export const BACKUP_WATCHDOG_INTERVAL_MS = 60_000;
export const BACKUP_WATCHDOG_ISSUE_TEXT: Record<BackupWatchdogIssue, string> = {
  settings_unavailable: 'Monitor settings could not be read. Pings are stopped.',
  clock_changed: 'The server clock moved behind a saved ping time. Pings are stopped.',
  backup_not_current: 'Waiting for a verified backup within the age limit. No ping is sent.',
  backup_attention: 'Backup or recovery evidence needs attention. No ping is sent.',
  scan_not_ready: 'The enabled S3 check needs a complete passing scan. No ping is sent.',
  vault_unavailable: 'The stored ping URL could not be opened. Unlock the vault and check the saved setup.',
  ping_failed: 'The monitor did not confirm the ping. Check it on the monitor host.',
};
