/** D-318 step 7 — Settings → Email chat in a real browser, over stub callers.
 *  No server, no mailbox: what the panel sends is recorded, and the requests
 *  the round trip shows are set from the spec. Step 8 — an address added gets
 *  the code 482913, and the spec settles it as the code's email would. */
import {
  MAIL_CHAT_DOOR_DEFAULTS,
  MAIL_CHAT_ENROL_CODE_TTL_MS,
  type MailChatEnrolledSender,
  type MailChatDoorCheckResult,
  type MailChatDoorRecentRequest,
  type MailChatDoorSettings,
} from '@recued/contracts';
import { PRIMITIVE_STYLES } from '@recued/ui-shared/primitives';

import {
  MAIL_CHAT_DOOR_PANEL_STYLES,
  mountMailChatDoorPanel,
  type MailChatDoorSetArgs,
} from '../../src/settings/mail-chat-door-panel.js';

const root = document.querySelector<HTMLElement>('#root')!;
const style = document.createElement('style');
style.textContent = `${PRIMITIVE_STYLES}\n${MAIL_CHAT_DOOR_PANEL_STYLES}`;
document.head.appendChild(style);

const calls: Array<{ method: string; args: unknown }> = [];
let settings: MailChatDoorSettings = { ...MAIL_CHAT_DOOR_DEFAULTS };
let check: MailChatDoorCheckResult = { ready: true, checks: [] };
let recent: MailChatDoorRecentRequest[] = [];

const panel = mountMailChatDoorPanel({
  host: root,
  document,
  runGet: async () => settings,
  runSet: async (args: MailChatDoorSetArgs) => {
    calls.push({ method: 'collection.mail.chat_door.set', args: structuredClone(args) });
    settings = {
      ...settings,
      ...(args.chat_mailbox !== undefined
        ? { chat_mailbox: args.chat_mailbox, chat_address: args.chat_mailbox === null ? null : 'recued@chat.example' }
        : {}),
      ...(args.owner_mailboxes !== undefined ? { owner_mailboxes: [...args.owner_mailboxes] } : {}),
      ...(args.ask_prefix !== undefined ? { ask_prefix: args.ask_prefix } : {}),
      ...(args.stale_after_minutes !== undefined ? { stale_after_minutes: args.stale_after_minutes } : {}),
      ...(args.resume === true ? { paused_at: null } : {}),
      ...(args.unenroll !== undefined
        ? { enrolled_senders: settings.enrolled_senders.filter((entry) => entry.address !== args.unenroll) }
        : {}),
      ...(args.enroll !== undefined
        ? {
            enrolled_senders: [...settings.enrolled_senders.filter((entry) => entry.address !== args.enroll), {
              address: args.enroll, state: 'pending', chat_mailbox: 'recued-chat', code: '482913',
              expires_at: Date.UTC(2026, 9, 14, 9, 31) + MAIL_CHAT_ENROL_CODE_TTL_MS, attempts: 0,
              added_at: Date.UTC(2026, 9, 14, 9, 31), confirmed_at: null, checked_by: null, failure: null,
            } satisfies MailChatEnrolledSender],
          }
        : {}),
    };
    return settings;
  },
  runCheck: async (args) => {
    calls.push({ method: 'collection.mail.chat_door.check', args: structuredClone(args) });
    return check;
  },
  runRecent: async () => ({ requests: recent }),
  runListMailboxes: async () => ({
    instances: [
      { slug: 'recued-chat', account_email: 'recued@chat.example', send_capable: true },
      { slug: 'me', account_email: 'me@owner.example', send_capable: true },
      { slug: 'archive', account_email: 'archive@owner.example', send_capable: false },
    ],
  }),
  // The round trip looks again quickly here; the spec waits on what it shows.
  setTimer: (fn, _ms) => setTimeout(fn, 50),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  locale: 'en-GB',
  timeZone: 'UTC',
});

const api = {
  calls,
  state: () => panel.getState(),
  setCheck: (next: MailChatDoorCheckResult) => { check = next; },
  setRecent: (next: MailChatDoorRecentRequest[]) => { recent = next; },
  setSettings: async (next: Partial<MailChatDoorSettings>) => {
    settings = { ...settings, ...next };
    await panel.refresh();
  },
  /** The code's email arrived: the panel sees it at its next look. */
  settle: (address: string, next: Partial<MailChatEnrolledSender>) => {
    settings = {
      ...settings,
      enrolled_senders: settings.enrolled_senders.map((entry) => (entry.address === address
        ? { ...entry, code: null, expires_at: null, ...next }
        : entry)),
    };
  },
};
Object.assign(window, { __mcd: api });
declare global { interface Window { __mcd: typeof api } }
