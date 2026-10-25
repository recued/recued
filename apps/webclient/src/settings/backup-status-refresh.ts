import { formatClientDateTime } from '@recued/ui-shared';

export type BackupStatusRefreshOutcome = 'success' | 'failure' | 'superseded';

/** Freshness describes a status read, not a storage scan or recovery test.
 *  Stable nodes leave policy drafts and keyboard focus with their owners. */
export const createBackupStatusRefresh = (options: {
  host: HTMLElement;
  document: Document;
  prefix: 'backup-health' | 'backup-integrity' | 'backup-watchdog' | 'unattended' | 'drill';
  now?: () => number;
  onPendingChange?: (pending: boolean) => void;
}) => {
  const status = options.document.createElement('p');
  status.setAttribute(`data-${options.prefix}-refresh-status`, '');
  status.setAttribute('role', 'status');
  const time = options.document.createElement('time');
  time.setAttribute(`data-${options.prefix}-last-refreshed`, '');
  options.host.appendChild(status);
  let disposed = false, pending = false, waiting = false, failed = false;
  let lastSuccessfulAt: number | undefined;
  const copy = options.prefix === 'drill' ? {
    waiting: 'Waiting to refresh recovery receipts after the current action. ',
    pending: 'Refreshing recovery receipts… ',
    failed: 'Recovery receipts could not be checked. Reconnect and refresh before starting a test. ',
    empty: 'No successful recovery receipt refresh yet.',
    last: 'Last successful recovery receipt refresh: ',
  } : options.prefix === 'backup-watchdog' ? {
    waiting: 'Waiting to refresh monitor status after the current action. ',
    pending: 'Refreshing monitor status… ',
    failed: 'Latest monitor status refresh failed. ',
    empty: 'No successful monitor status refresh yet.',
    last: 'Last successful monitor status refresh: ',
  } : options.prefix === 'unattended' ? {
    waiting: 'Waiting to refresh schedule status after the save. ',
    pending: 'Refreshing schedule status… ',
    failed: 'Latest schedule status refresh failed. ',
    empty: 'No successful schedule status refresh yet.',
    last: 'Last successful schedule status refresh: ',
  } : {
    waiting: 'Waiting to refresh status after the save. ',
    pending: 'Refreshing status… ',
    failed: 'Latest status refresh failed. ',
    empty: 'No successful status refresh yet.',
    last: 'Last successful status refresh: ',
  };
  const render = (): void => {
    const progress = waiting ? copy.waiting : pending ? copy.pending : failed ? copy.failed : '';
    status.textContent = progress + (lastSuccessfulAt === undefined ? copy.empty : copy.last);
    if (lastSuccessfulAt !== undefined) {
      const instant = new Date(lastSuccessfulAt);
      if (Number.isFinite(instant.getTime())) {
        time.setAttribute('datetime', instant.toISOString());
        time.textContent = formatClientDateTime(instant);
        status.appendChild(time);
      } else status.textContent += 'Unknown time';
    }
  };
  const notify = (): void => {
    try { options.onPendingChange?.(pending); } catch { /* feedback cannot invalidate a status read */ }
  };
  const begin = (afterSave: boolean): void => {
    if (disposed) return;
    pending = true; waiting = afterSave; failed = false;
    render(); notify();
  };
  render();
  return {
    start: (): void => begin(false),
    waitForSave: (): void => begin(true),
    waitForAction: (): void => begin(true),
    finish(outcome: BackupStatusRefreshOutcome): void {
      if (disposed) return;
      pending = false; waiting = false; failed = outcome === 'failure';
      if (outcome === 'success') lastSuccessfulAt = (options.now ?? Date.now)();
      render(); notify();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true; pending = false; notify();
    },
  };
};
