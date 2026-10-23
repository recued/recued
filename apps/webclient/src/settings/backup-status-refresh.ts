import { formatClientDateTime } from '@recued/ui-shared';

export type BackupStatusRefreshOutcome = 'success' | 'failure' | 'superseded';

/** Freshness describes a status read, not a storage scan or recovery test.
 *  Stable nodes leave policy drafts and keyboard focus with their owners. */
export const createBackupStatusRefresh = (options: {
  host: HTMLElement;
  document: Document;
  prefix: 'backup-health' | 'backup-integrity';
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
  const render = (): void => {
    const progress = waiting ? 'Waiting to refresh status after the save. '
      : pending ? 'Refreshing status… ' : failed ? 'Latest status refresh failed. ' : '';
    status.textContent = progress + (lastSuccessfulAt === undefined
      ? 'No successful status refresh yet.' : 'Last successful status refresh: ');
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
