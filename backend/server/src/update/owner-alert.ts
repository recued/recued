/** Owner-facing notice for an update lifecycle event discovered at boot.
 *
 * This is deliberately a NOTIFICATION, never an ask. The update state machine
 * has already decided the outcome; there is no approval to collect and no
 * honest one-option "dismiss" decision. The durable truth stays where it was
 * established: the out-of-SQLite update ledger, any retained recovery journal,
 * and the Updates surface. The notification is only the heads-up that gets an
 * unattended owner's attention.
 */

import type { NotificationBlock, NotificationMessage } from '@recued/notification';

export type UpdateOwnerAlert =
  | {
      kind: 'update-applied';
      release_identity: string;
      from_version: string;
      to_version: string;
      channel: 'stable' | 'edge';
      trigger: 'auto' | 'manual' | 'revert';
    }
  | {
      kind: 'auto-revert-starting';
      release_identity: string;
      from_version: string;
      to_version: string;
      reason: string;
    }
  | {
      kind: 'webclient-recovery-failed';
      release_identity: string;
      reason: string;
    }
  | {
      kind: 'manual-rollback-recovery-failed';
      release_identity: string;
      reason: string;
    }
  | {
      kind: 'supervisor-revert-complete';
      release_identity: string;
      from_version: string;
      to_version: string;
      reason: string;
    };

export type UpdateOwnerAlertSink = (alert: UpdateOwnerAlert) => void;

/** Pure owner copy. `update-applied` is emitted only for the durable commit
 * terminal. The auto-revert arm is intentionally prospective: it is emitted
 * before the restart drain, while the notification stack can still use SQLite,
 * and must not claim the disk rollback succeeded before the post-drain callback
 * has actually restored/swept the release. */
export const describeUpdateOwnerAlert = (
  alert: UpdateOwnerAlert,
  updates_link_url?: string,
): NotificationMessage => {
  let message: NotificationMessage;
  switch (alert.kind) {
    case 'update-applied': {
      const provenance = alert.trigger === 'auto'
        ? 'It was applied automatically.'
        : alert.trigger === 'manual'
          ? 'It was started by an owner.'
          : 'It completed through the recovery path.';
      message = {
        title: 'Server update completed',
        text:
          `Recued updated the server from ${alert.from_version} to ${alert.to_version} `
          + `on the ${alert.channel} channel. ${provenance} Review Settings → Updates.`,
      };
      break;
    }
    case 'auto-revert-starting':
      message = {
        title: 'Update failed; rollback starting',
        text:
          `Recued ${alert.to_version} failed its boot health check (${alert.reason}). `
          + `Recued is beginning a controlled recovery restart and will try to return to ${alert.from_version}. `
          + 'Review Settings → Updates after Recued restarts.',
      };
      break;
    case 'webclient-recovery-failed':
      message = {
        title: 'Update recovery needs attention',
        text:
          `Recued could not restore the previous web app for ${alert.release_identity}: `
          + `${alert.reason}. The update remains in progress so recovery can try again on the next boot. `
          + 'Review Settings → Updates.',
      };
      break;
    case 'manual-rollback-recovery-failed':
      message = {
        title: 'Rollback recovery needs attention',
        text:
          `Recued could not prove whether the interrupted rollback for ${alert.release_identity} finished: `
          + `${alert.reason}. Its recovery record was kept. Review Settings → Updates before starting another update or rollback.`,
      };
      break;
    case 'supervisor-revert-complete':
      message = {
        title: 'Update failed; previous server version restored',
        text:
          `Recued ${alert.to_version} could not launch: ${alert.reason}. `
          + `The supervisor restored server version ${alert.from_version}. Review Settings → Updates.`,
      };
      break;
  }
  return {
    ...message,
    ...(updates_link_url !== undefined ? { link_url: updates_link_url } : {}),
  };
};

/** Deliver one best-effort update owner notification. Returns false only when
 * the notification transport itself refused; update reconciliation and boot
 * must never depend on this result. */
export const notifyUpdateOwnerAlert = async (
  alert: UpdateOwnerAlert,
  notify: Pick<NotificationBlock, 'notify'>['notify'],
  updates_link_url?: string,
): Promise<boolean> => {
  try {
    await notify(describeUpdateOwnerAlert(alert, updates_link_url));
    return true;
  } catch {
    return false;
  }
};

/** Bind the production block through its `notify` member only. The returned
 * callback is synchronous and fire-and-forget so a slow or failed owner channel
 * cannot delay boot reconciliation or the safety-critical rollback/restart path.
 *
 * The unresolved condition arms intentionally have no restart dedup. `notify`
 * creates no open decision row to accumulate, and their state is re-derived
 * from the ledger/journal on the next boot. Re-announcing a still-true condition
 * is useful; dismissing it while it remains true would not be. A completed
 * apply is emitted only by the boot that appends its resolving terminal; a
 * completed outer-supervisor event is deduplicated upstream by its
 * ledger-to-audit replay id. */
export const createUpdateOwnerAlertSink = (
  block: Pick<NotificationBlock, 'notify'>,
  /** Read when the alert fires, not at boot: the server's public address can
   *  appear (a Pro name gets its certificate) or change while it runs. */
  updatesLink?: () => string | undefined,
): UpdateOwnerAlertSink =>
  (alert) => {
    void notifyUpdateOwnerAlert(alert, (message) => block.notify(message), updatesLink?.());
  };
