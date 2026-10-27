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
let setFailure: string | null = null;
let holdRecent = false;
let recentReadCount = 0;
const recentWaiters: Array<() => void> = [];
const manualTimers = new URLSearchParams(location.search).get('manual_timers') === '1';
let timerId = 0;
const timers = new Map<number, () => void>();
type ReadKind = 'settings' | 'mailboxes';
const readCounts = { settings: 0, mailboxes: 0 };
const readFailures = new Set<ReadKind>();
const initialFailure = new URLSearchParams(location.search).get('read_failure');
if (initialFailure === 'settings' || initialFailure === 'mailboxes') readFailures.add(initialFailure);
let holdReads = false;
const readWaiters: Record<ReadKind, Array<() => void>> = { settings: [], mailboxes: [] };
const read = async <T>(kind: ReadKind, value: () => T): Promise<T> => {
  readCounts[kind] += 1;
  if (holdReads) await new Promise<void>(resolve => { readWaiters[kind].push(resolve); });
  if (readFailures.delete(kind)) throw new Error(`Email chat ${kind} temporarily unavailable.`);
  return value();
};
const releaseRead = (kind: ReadKind): number => {
  const waiting = readWaiters[kind].splice(0);
  for (const resolve of waiting) resolve();
  return waiting.length;
};

const panel = mountMailChatDoorPanel({
  host: root,
  document,
  runGet: () => read('settings', () => settings),
  runSet: async (args: MailChatDoorSetArgs) => {
    calls.push({ method: 'collection.mail.chat_door.set', args: structuredClone(args) });
    if (setFailure !== null) {
      const message = setFailure;
      setFailure = null;
      throw new Error(message);
    }
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
  runRecent: async () => {
    recentReadCount += 1;
    if (holdRecent) await new Promise<void>(resolve => { recentWaiters.push(resolve); });
    return { requests: recent };
  },
  runListMailboxes: () => read('mailboxes', () => ({
    instances: [
      { slug: 'recued-chat', adapter_type: 'imap', account_email: 'recued@chat.example', send_capable: true },
      { slug: 'me', adapter_type: 'imap', account_email: 'me@owner.example', send_capable: true },
      { slug: 'smtp-only', adapter_type: 'smtp', account_email: 'hello@example.test', send_capable: true },
      { slug: 'archive', adapter_type: 'imap', account_email: 'archive@owner.example', send_capable: false },
    ],
  })),
  // The round trip looks again quickly here; the spec waits on what it shows.
  setTimer: (fn, _ms) => {
    if (!manualTimers) return setTimeout(fn, 50);
    const id = ++timerId;
    timers.set(id, fn);
    return id;
  },
  clearTimer: (handle) => {
    if (manualTimers) timers.delete(handle as number);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  locale: 'en-GB',
  timeZone: 'UTC',
});

const api = {
  calls,
  state: () => panel.getState(),
  tick: () => {
    const waiting = [...timers.values()];
    timers.clear();
    for (const fn of waiting) fn();
    return waiting.length;
  },
  failNextSet: (message: string) => { setFailure = message; },
  recentReadCount: () => recentReadCount,
  holdRecent: () => { holdRecent = true; },
  releaseRecent: () => {
    holdRecent = false;
    const waiting = recentWaiters.splice(0);
    for (const resolve of waiting) resolve();
    return waiting.length;
  },
  readCounts: () => ({ ...readCounts }),
  failNextRead: (kind: ReadKind) => { readFailures.add(kind); },
  holdReads: () => { holdReads = true; },
  releaseRead,
  releaseReads: () => { holdReads = false; return releaseRead('settings') + releaseRead('mailboxes'); },
  refresh: () => panel.refresh(),
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
