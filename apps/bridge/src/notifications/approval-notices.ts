/** A pending approval, as an OS notification on this Bridge (the owner, 2026-11-03: "do OS
 *  notifications for approvals on the Bridge too"; D-163 O-2's follow-up).
 *
 *  The notification block's own Bridge channel never reached a Bridge: its server-side sink was
 *  left unwired, and its per-Bridge fan-out names no Bridge. A Bridge already hears every
 *  approval live on the bus (`notification.ask`), so it raises the notification itself:
 *
 *  - only when its own Notify switch is on (`notifications.my_bridge_mode`, read when unknown and
 *    again after `notification.bridge_mode_changed` or a reconnect), as Settings promises ("A
 *    bridge notifies as soon as you pair it");
 *  - once per approval: the server sends every open approval again at each restart, when the
 *    vault unlocks and when quiet hours end, so what has been shown is kept in
 *    `chrome.storage.local`, which a service worker restart keeps. It is `approval_notices_shown`,
 *    on the Bridge's closed list of stored fields, so the store's inspection includes it and its
 *    `clear` drops it (`storage/local-store.ts`); an id leaves it once its approval closes;
 *  - with the approval's title, which is written to be its preview on the OS, and a fixed line,
 *    never its text: the dispatcher's lock-screen rule (`dispatcher.ts`);
 *  - cleared once the approval closes (`notification.ask_closed`).
 *
 *  Quiet hours need nothing here: the server sends no `notification.ask` while they hold one. A
 *  click opens the approval in the paired web app (`#approvals/<ask_id>`), routed from the
 *  notification's id, so it works after the service worker has been restarted
 *  (`dispatcher.ts`). A reminder is no approval here: it has its own notification. */

import type { ChromeNotificationsApi } from './dispatcher.js';
import type { BridgeLocalStore } from '../storage/local-store.js';

const APPROVAL_NOTICE_PREFIX = 'recued-approval-';
/** The approvals remembered as shown: enough for any queue, small enough to read at each one. */
export const APPROVAL_NOTICES_SHOWN_CAP = 200;
export const APPROVAL_NOTICE_DEFAULT_TITLE = 'An approval is waiting';
export const APPROVAL_NOTICE_MESSAGE = 'Waiting for your approval. Click to open it in Recued.';
/** An approval's id as the server mints it (`ask-<uuid>`); anything else is neither shown nor routed. */
const ASK_ID = /^ask-[A-Za-z0-9-]{1,100}$/u;

export const approvalNoticeId = (ask_id: string): string => `${APPROVAL_NOTICE_PREFIX}${ask_id}`;

/** The approval a notification's id names, for its click. */
export const askIdOfApprovalNotice = (notification_id: string): string | undefined => {
  if (!notification_id.startsWith(APPROVAL_NOTICE_PREFIX)) return undefined;
  const ask_id = notification_id.slice(APPROVAL_NOTICE_PREFIX.length);
  return ASK_ID.test(ask_id) ? ask_id : undefined;
};

export interface ApprovalNoticesDeps {
  readonly notifications: Pick<ChromeNotificationsApi, 'create' | 'clear'>;
  readonly storage: Pick<BridgeLocalStore, 'get' | 'set'>;
  /** This Bridge's own Notify switch, as the server keeps it. */
  readonly readNotifySwitch: () => Promise<boolean>;
  readonly icon_url: string;
}

export interface ApprovalNotices {
  /** The switch may have changed: read it again at the next approval. */
  forgetSwitch(): void;
  /** An approval heard on the bus. Never rejects. */
  asked(event: { readonly ask_id: string; readonly title?: string; readonly reminder?: boolean }): Promise<void>;
  /** An approval closed, heard on the bus: its notification goes. Never rejects. */
  closed(ask_id: string): Promise<void>;
}

export const createApprovalNotices = (deps: ApprovalNoticesDeps): ApprovalNotices => {
  let notifySwitch: Promise<boolean> | undefined;
  /** A switch that cannot be read is taken as off, and read again at the next approval. */
  const notifies = (): Promise<boolean> => {
    notifySwitch ??= deps.readNotifySwitch().catch(() => {
      notifySwitch = undefined;
      return false;
    });
    return notifySwitch;
  };
  // One at a time: each reads and writes the list of what has been shown.
  let queue: Promise<void> = Promise.resolve();
  const inTurn = (work: () => Promise<void>): Promise<void> => {
    queue = queue.then(work).catch(() => undefined);
    return queue;
  };
  const readShown = async (): Promise<string[]> => {
    const list = await deps.storage.get('approval_notices_shown');
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [];
  };

  return {
    forgetSwitch() {
      notifySwitch = undefined;
    },
    asked(event) {
      if (event.reminder === true || !ASK_ID.test(event.ask_id)) return Promise.resolve();
      return inTurn(async () => {
        if (!(await notifies())) return;
        const shown = await readShown();
        if (shown.includes(event.ask_id)) return;
        await deps.notifications.create(approvalNoticeId(event.ask_id), {
          type: 'basic',
          title: event.title?.trim() || APPROVAL_NOTICE_DEFAULT_TITLE,
          message: APPROVAL_NOTICE_MESSAGE,
          iconUrl: deps.icon_url,
          isClickable: true,
        });
        await deps.storage.set('approval_notices_shown', [...shown, event.ask_id].slice(-APPROVAL_NOTICES_SHOWN_CAP));
      });
    },
    closed(ask_id) {
      if (!ASK_ID.test(ask_id)) return Promise.resolve();
      return inTurn(async () => {
        await deps.notifications.clear(approvalNoticeId(ask_id)).catch(() => false);
        const shown = await readShown();
        if (shown.includes(ask_id)) await deps.storage.set('approval_notices_shown', shown.filter((id) => id !== ask_id));
      });
    },
  };
};
