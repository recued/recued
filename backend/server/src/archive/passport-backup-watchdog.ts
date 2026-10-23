import { BACKUP_WATCHDOG_ISSUE_TEXT, type BackupWatchdogStatus, type ServerPassportWatchdogEvidence } from '@recued/contracts';

/** Copy only authored evidence fields. Even full profiles never receive a
 * monitor capability, encrypted URL, revision, provider response or key. */
export const watchdogEvidenceForPassport = (value: BackupWatchdogStatus | undefined, observedAt: number): ServerPassportWatchdogEvidence => {
  if (!value) return { configured: false, enabled: false, state: 'unavailable', issue: 'service_unavailable' };
  const base: ServerPassportWatchdogEvidence = { configured: value.configured, enabled: value.enabled, state: value.state,
    ...(value.issue && Object.hasOwn(BACKUP_WATCHDOG_ISSUE_TEXT, value.issue) ? { issue: value.issue } : {}) };
  const d = value.drill;
  const eventTimes = [value.last_attempt_at, value.last_acknowledged_at, d?.started_at, d?.resumed_at,
    d?.alert_reported_at, d?.ping_acknowledged_at, d?.finished_at];
  // The pause deadline may legitimately be in the future; observed events may not.
  if (!Number.isSafeInteger(observedAt) || observedAt < 0 || eventTimes.some(at => at !== undefined && (!Number.isSafeInteger(at) || at < 0 || at > observedAt))) {
    return { configured: value.configured, enabled: value.enabled, state: 'unavailable', issue: 'clock_changed' };
  }
  // An unavailable observer cannot carry a stale positive receipt into a signed claim.
  if (value.state === 'unavailable') return base;
  if (value.last_attempt_at !== undefined) base.last_attempt_at = value.last_attempt_at;
  if (value.last_acknowledged_at !== undefined) base.last_acknowledged_at = value.last_acknowledged_at;
  if (d) base.drill = { operation_id: d.operation_id, phase: d.phase, pause_minutes: d.pause_minutes,
    current_configuration: d.current_configuration, started_at: d.started_at, pause_until: d.pause_until,
    ...(d.resumed_at === undefined ? {} : { resumed_at: d.resumed_at }),
    ...(d.alert_reported_at === undefined ? {} : { alert_reported_at: d.alert_reported_at }),
    ...(d.ping_acknowledged_at === undefined ? {} : { ping_acknowledged_at: d.ping_acknowledged_at }),
    ...(d.finished_at === undefined ? {} : { finished_at: d.finished_at }) };
  return base;
};
