import type { BackupWatchdogDrill, BackupWatchdogDrillPhase } from '@recued/contracts';

export interface StoredWatchdogDrill extends Omit<BackupWatchdogDrill, 'current_configuration'> {
  origin_revision: string;
  bound_revision: string;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const watchdogUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export const watchdogDrillMinutes = (v: unknown): v is StoredWatchdogDrill['pause_minutes'] => v === 10 || v === 15 || v === 30 || v === 60;
const phases = new Set<string>(['paused', 'resuming', 'awaiting_confirmation', 'completed', 'cancelled', 'superseded']);
const phase = (v: unknown): v is BackupWatchdogDrillPhase => typeof v === 'string' && phases.has(v);
export const watchdogDrillOpen = (d: StoredWatchdogDrill): boolean => d.phase === 'paused' || d.phase === 'resuming' || d.phase === 'awaiting_confirmation';
/** A closed, bounded record; no provider responses or owner-supplied text. */
export const validStoredWatchdogDrill = (v: unknown): v is StoredWatchdogDrill => {
  if (!object(v) || Object.keys(v).some(k => !['operation_id', 'origin_revision', 'bound_revision', 'phase', 'pause_minutes', 'started_at', 'pause_until', 'resumed_at', 'alert_reported_at', 'ping_acknowledged_at', 'finished_at'].includes(k))
    || !watchdogUuid(v.operation_id) || !watchdogUuid(v.origin_revision) || !watchdogUuid(v.bound_revision) || !phase(v.phase)
    || !watchdogDrillMinutes(v.pause_minutes) || !integer(v.started_at) || !integer(v.pause_until)
    || v.pause_until !== v.started_at + v.pause_minutes * 60_000) return false;
  for (const key of ['resumed_at', 'alert_reported_at', 'ping_acknowledged_at', 'finished_at']) if (v[key] !== undefined && !integer(v[key])) return false;
  const resumed = v.resumed_at, alert = v.alert_reported_at, ack = v.ping_acknowledged_at, end = v.finished_at;
  if (resumed !== undefined && (!integer(resumed) || resumed < v.started_at || resumed > v.pause_until)) return false;
  if (alert !== undefined && (!integer(alert) || alert < v.started_at)) return false;
  if (ack !== undefined && (!integer(ack) || !integer(resumed) || ack < resumed)) return false;
  if (v.phase === 'paused') return resumed === undefined && alert === undefined && ack === undefined && end === undefined;
  if (v.phase === 'resuming') return resumed !== undefined && ack === undefined && end === undefined;
  if (v.phase === 'awaiting_confirmation') return resumed !== undefined && ack !== undefined && alert === undefined && end === undefined;
  if (v.phase === 'completed') return integer(alert) && integer(ack) && integer(end) && end === Math.max(alert, ack);
  return end !== undefined;
};
/** Read projection and sender admission use the same immutable deadline. */
export const advanceWatchdogDrill = (value: StoredWatchdogDrill, at: number): StoredWatchdogDrill => {
  const d = { ...value };
  if (d.phase === 'paused' && at >= d.pause_until) { d.phase = 'resuming'; d.resumed_at = d.pause_until; }
  if ((d.phase === 'resuming' || d.phase === 'awaiting_confirmation') && d.ping_acknowledged_at !== undefined) {
    if (d.alert_reported_at === undefined) d.phase = 'awaiting_confirmation';
    else { d.phase = 'completed'; d.finished_at = Math.max(d.alert_reported_at, d.ping_acknowledged_at); }
  }
  return d;
};
export const watchdogDrillView = (value: StoredWatchdogDrill, revision: string, at: number): BackupWatchdogDrill => {
  const d = advanceWatchdogDrill(value, at);
  return { operation_id: d.operation_id, phase: d.phase, pause_minutes: d.pause_minutes, started_at: d.started_at, pause_until: d.pause_until,
    ...(d.resumed_at === undefined ? {} : { resumed_at: d.resumed_at }),
    ...(d.alert_reported_at === undefined ? {} : { alert_reported_at: d.alert_reported_at }),
    ...(d.ping_acknowledged_at === undefined ? {} : { ping_acknowledged_at: d.ping_acknowledged_at }),
    ...(d.finished_at === undefined ? {} : { finished_at: d.finished_at }), current_configuration: d.bound_revision === revision };
};
