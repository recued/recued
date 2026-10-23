import { formatClientDateTime } from '@recued/ui-shared';

export const PASSPORT_RECOVERY_SUMMARY_ATTR = 'data-passport-recovery-summary';
export const PASSPORT_RECOVERY_ROW_ATTR = 'data-passport-recovery-row';
type RowId = 'backup' | 'recovery' | 'integrity' | 'monitor' | 'drill' | 'alert' | 'ping';
export interface PassportRecoverySummary {
  exportedAt?: number;
  rows: { id: RowId; label: string; detail: string }[];
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const record = (value: unknown): Record<string, unknown> | undefined => object(value) ? value : undefined;
const text = (table: Record<string, string>, value: unknown): string | undefined => typeof value === 'string' && Object.hasOwn(table, value) ? table[value] : undefined;
const AGE: Record<string, string> = {
  current: 'Within its age limit at export.', waiting: 'Waiting for a first verified backup.',
  due: 'Backup overdue at export.', unavailable: 'Backup-age evidence unavailable.',
};
const RECOVERY: Record<string, string> = {
  current: 'A saved passing test was within its age limit. It may have tested an earlier copy.',
  waiting: 'Waiting for a first passing recovery test.', due: 'Recovery test overdue at export.', unavailable: 'Recovery-test evidence unavailable.',
};
const SCAN: Record<string, string> = {
  not_checked: 'No completed S3 scan recorded.', running: 'A scan was in progress at export.',
  completed: 'The last scan checked all selected copies.', partial: 'The last scan was partial; some selected copies were skipped or not checked.',
  empty: 'The last scan selected no copies. This does not prove that backups passed.',
  failed: 'The last saved S3 scan failed.', unavailable: 'S3 scan evidence unavailable.',
};
const MONITOR: Record<string, string> = {
  not_configured: 'No external monitor was set up.', paused: 'Monitor pings were off.', waiting: 'Waiting for a first eligible ping.',
  blocked: 'Pings were blocked by backup proof that needed attention.', sending: 'A ping was in progress at export.',
  acknowledged: 'The last ping was acknowledged. This does not prove alert delivery.', failed: 'The last ping could not be confirmed.',
  unavailable: 'Monitor evidence unavailable.', drill_paused: 'Pings were paused for an alert drill.',
};
const DRILL: Record<string, string> = {
  paused: 'Pings were paused for this drill.', resuming: 'The pause ended; waiting for an eligible ping acknowledgment.',
  awaiting_confirmation: 'A resumption ping was acknowledged; the owner had not reported receiving an alert.',
  completed: 'The owner report and a resumption ping acknowledgment were both recorded.',
  cancelled: 'The drill was ended without a completed alert test.', superseded: 'A setup change ended this drill.',
};
const LABELS: Record<RowId, string> = { backup: 'Backup age', recovery: 'Recovery test', integrity: 'S3 scan', monitor: 'Offline monitor', drill: 'Alert drill', alert: 'Owner alert report', ping: 'Resumption ping' };

/** Interpret only the exported support snapshot. Unknown fields never become
 * prose, and configuration or a phase alone never establishes a passing test. */
export const buildPassportRecoverySummary = (input: unknown): PassportRecoverySummary => {
  const root = record(input), supported = root?.profile === 'support_redacted' && (root.passport_version === undefined || root.passport_version === '1');
  const recovery = supported ? record(root.recovery) : undefined, evidence = record(recovery?.backup_evidence);
  const details: Record<RowId, string> = {
    backup: 'Detailed backup-age evidence is not included in this Passport.', recovery: 'Recovery-test evidence is not included in this Passport.',
    integrity: 'S3 scan evidence is not included in this Passport.', monitor: 'Monitor evidence is not included in this Passport.',
    drill: 'Alert-drill evidence is not included in this Passport.', alert: 'No owner alert report is included.', ping: 'No resumption ping proof is included.',
  };
  if (!evidence) {
    const legacy = text({ configured: 'A backup schedule was configured; this alone does not prove a backup passed.',
      unconfigured: 'No unattended backup schedule was configured.', overdue: 'Backup overdue at export.', unavailable: 'Backup evidence unavailable.' }, recovery?.backup_status);
    if (legacy) details.backup += ` ${legacy}`;
  } else {
    const monitoring = evidence.monitoring;
    if (monitoring === 'active') {
      details.backup = text(AGE, evidence.backup_state) ?? 'Backup-age evidence unavailable.';
      details.recovery = text(RECOVERY, evidence.recovery_test_state) ?? 'Recovery-test evidence unavailable.';
    } else if (monitoring === 'paused') {
      details.backup = 'Backup schedule paused. No current backup age is claimed.';
      details.recovery = 'Backup monitoring paused. No current test age is claimed.';
    } else if (monitoring === 'not_configured') {
      details.backup = 'No unattended backup schedule was configured.';
      details.recovery = 'No recovery-test age is claimed without backup monitoring.';
    } else { details.backup = 'Backup-age evidence unavailable.'; details.recovery = 'Recovery-test evidence unavailable.'; }
    const scan = record(evidence.integrity), scanState = text(SCAN, scan?.state), scanMonitoring = scan?.monitoring;
    if (!scanState || typeof scanMonitoring !== 'string' || !['active', 'paused', 'not_configured'].includes(scanMonitoring)) details.integrity = 'S3 scan evidence unavailable.';
    else details.integrity = (scan?.monitoring === 'paused' ? 'Scheduled S3 checks were paused. ' : scan?.monitoring === 'not_configured' ? 'Scheduled S3 checks were not set up. ' : '') + scanState;
    const monitor = record(evidence.watchdog), monitorState = text(MONITOR, monitor?.state);
    if (monitor) {
      const validMonitor = monitorState !== undefined && typeof monitor.configured === 'boolean' && typeof monitor.enabled === 'boolean'
        && (monitor.state === 'unavailable' || (monitor.state === 'not_configured' ? !monitor.configured && !monitor.enabled
          : monitor.state === 'paused' ? monitor.configured && !monitor.enabled : monitor.configured && monitor.enabled));
      details.monitor = validMonitor ? monitorState : 'Monitor evidence unavailable.';
      if (!validMonitor || monitor.state === 'unavailable') {
        details.drill = 'Alert-drill evidence unavailable.'; details.alert = 'Owner alert report unavailable.'; details.ping = 'Resumption ping proof unavailable.';
      } else if (monitor.drill !== undefined) {
        const d = record(monitor.drill), phase = text(DRILL, d?.phase);
        const owner = d?.owner_reported_alert, ping = d?.resumption_ping_acknowledged;
        const valid = phase !== undefined && typeof d?.current_configuration === 'boolean' && typeof owner === 'boolean' && typeof ping === 'boolean'
          && (d.phase !== 'completed' || (owner && ping)) && (d.phase !== 'paused' || (!owner && !ping))
          && (d.phase !== 'resuming' || !ping) && (d.phase !== 'awaiting_confirmation' || (!owner && ping));
        if (!valid) {
          details.drill = 'Alert-drill evidence unavailable or inconsistent.'; details.alert = 'Owner alert report unavailable.'; details.ping = 'Resumption ping proof unavailable.';
        } else {
          const scope = d.current_configuration ? '' : 'Earlier monitor setup: ';
          details.drill = scope + phase;
          details.alert = scope + (owner ? 'The owner reported receiving an alert; delivery was not independently verified.' : 'The owner had not reported receiving an alert.');
          details.ping = scope + (ping ? 'A fresh ping was acknowledged after the pause.' : 'No ping acknowledgment after the pause was recorded.');
        }
      }
    }
  }
  const exportedAt = root?.exported_at;
  return { ...(supported && typeof exportedAt === 'number' && Number.isSafeInteger(exportedAt) && exportedAt >= 0 && exportedAt <= 8_640_000_000_000_000 ? { exportedAt } : {}),
    rows: (Object.keys(LABELS) as RowId[]).map(id => ({ id, label: LABELS[id], detail: details[id] })) };
};

export const PASSPORT_RECOVERY_SUMMARY_STYLES = `
[${PASSPORT_RECOVERY_SUMMARY_ATTR}] { min-width: 0; overflow-wrap: anywhere; }
[${PASSPORT_RECOVERY_SUMMARY_ATTR}] dl { margin: 0; display: grid; gap: 12px; }
[${PASSPORT_RECOVERY_SUMMARY_ATTR}] dl > div { display: grid; grid-template-columns: minmax(0, 130px) minmax(0, 1fr); gap: 10px; }
[${PASSPORT_RECOVERY_SUMMARY_ATTR}] dt { font-weight: 600; }
[${PASSPORT_RECOVERY_SUMMARY_ATTR}] dd { margin: 0; min-width: 0; }
@media (max-width: 600px) { [${PASSPORT_RECOVERY_SUMMARY_ATTR}] dl > div { grid-template-columns: minmax(0, 1fr); gap: 3px; } }
`;

export const renderPassportRecoverySummary = (doc: Document, summary: PassportRecoverySummary): HTMLElement => {
  const section = doc.createElement('section'); section.setAttribute(PASSPORT_RECOVERY_SUMMARY_ATTR, ''); section.setAttribute('aria-label', 'Recovery summary from this Passport');
  const title = doc.createElement('h3'); title.textContent = 'Recovery summary from this Passport'; section.appendChild(title);
  const note = doc.createElement('p'); note.textContent = (summary.exportedAt === undefined ? '' : `Exported ${formatClientDateTime(summary.exportedAt)}. `)
    + 'States recorded in this exported file. Review current status in Backup & Recovery. Reading this summary starts no checks.'; section.appendChild(note);
  const list = doc.createElement('dl');
  for (const row of summary.rows) {
    const item = doc.createElement('div'); item.setAttribute(PASSPORT_RECOVERY_ROW_ATTR, row.id);
    const label = doc.createElement('dt'), detail = doc.createElement('dd'); label.textContent = row.label; detail.textContent = row.detail;
    item.appendChild(label); item.appendChild(detail); list.appendChild(item);
  }
  section.appendChild(list); return section;
};
