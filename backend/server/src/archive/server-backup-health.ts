import type { ServerBackupHealthSnapshot } from '@recued/contracts';
import { backupRecoveryForPassport, type PassportBackupReceiptSources } from './passport-backup-evidence.js';

export const SERVER_BACKUP_HEALTH_REFRESH_MS = 60_000;
/** Full ledgers are read at most once per minute, independently of heartbeat
 * cadence. Returned objects are detached; no provider action is started. */
export const createServerBackupHealthSource = (sources: PassportBackupReceiptSources, now = Date.now) => {
  let cached: { observed_at: number; value: Omit<ServerBackupHealthSnapshot, 'age_ms'> } | undefined;
  return (forceRefresh = false): ServerBackupHealthSnapshot => {
    const at = now();
    if (forceRefresh || !cached || at < cached.observed_at || at - cached.observed_at >= SERVER_BACKUP_HEALTH_REFRESH_MS) {
      // Never read the watchdog here: its status reads this same health source.
      // Explicit picks also exclude extra fields on a wider archive-deps object.
      const evidence = backupRecoveryForPassport({
        ...(sources.backupHealth ? { backupHealth: sources.backupHealth } : {}),
        ...(sources.backupIntegrity ? { backupIntegrity: sources.backupIntegrity } : {}),
      }, now).backup_evidence;
      cached = { observed_at: evidence?.observed_at ?? now(), value: {
        monitoring: evidence?.monitoring ?? 'unavailable',
        ...(evidence?.backup ? { backup_state: evidence.backup.state } : {}),
        ...(evidence?.recovery_test ? { recovery_test_state: evidence.recovery_test.state } : {}),
        integrity: evidence ? { monitoring: evidence.integrity.monitoring, state: evidence.integrity.state }
          : { monitoring: 'unavailable', state: 'unavailable' },
      } };
    }
    const age_ms = now() - cached.observed_at;
    if (!Number.isSafeInteger(age_ms) || age_ms < 0) return { age_ms: 0, monitoring: 'unavailable', integrity: { monitoring: 'unavailable', state: 'unavailable' } };
    return { ...cached.value, integrity: { ...cached.value.integrity }, age_ms };
  };
};
