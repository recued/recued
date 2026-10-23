/** D-318 step 7 — Settings → Email chat: switching the email chat door on, its
 *  settings, and the test round trip (§4.12).
 *
 *  The owner writes from their own mailbox to a second one they connect for
 *  this, the chat mailbox, and Recued answers from it in the same thread. It is
 *  off until switched on here: the owner picks the chat mailbox and their own
 *  mailboxes, confirms only they send from those (P20), and reads where the
 *  answers are kept (P21). Switching on runs the server's checks first
 *  (`collection.mail.chat_door.check`) and saves only when every one passes.
 *
 *  ⛔ P20'S CONFIRMATION IS THE CHECK, NOT A FORMALITY. Recued knows an email to
 *  the chat mailbox is the owner's by finding it in one of their Sent folders,
 *  so anyone else who can send from that mailbox can ask Recued as the owner.
 *  No provider tells Recued who else sends from a mailbox, so the owner is the
 *  only one who can say it. Switching on is refused until they do.
 *
 *  ⛔ THE ROUND TRIP IS THE REAL TEST. The checks prove what Recued can see from
 *  here. Whether the owner's mail app keeps what it sends in the Sent folder,
 *  whether the address they write to is the chat mailbox's own, whether an
 *  answer goes out: only an email sent the way they will send them shows that.
 *  So the panel asks for one, and shows each request as the door saw it
 *  (`.recent`): checked, theirs, answered, sent, or where it stopped and why.
 *  Never the email's subject or words: a forger writes those.
 *
 *  Step 8 — proof (b): once it is on, the owner can add an address Recued does
 *  not read. The panel shows a code, and the owner sends it FROM that address
 *  TO the chat mailbox. The panel watches for the code's email, then shows the
 *  address confirmed, with its checker, or why not. ⚠ Naming none of the
 *  owner's mailboxes is allowed: such a door is for added addresses only.
 *
 *  One mailbox (§8.18) — the chat mailbox may be ticked among the owner's own
 *  too: they write to themselves. Its mail then stays theirs, and the `ask:`
 *  prefix cannot be switched off (the server refuses it): the panel says so,
 *  and offers no way to.
 *
 *  Spec: D-318 §4.10, §4.12, §8 steps 7 and 8, §8.18. */

import {
  isMailChatAskPrefix,
  isMailChatEnrollableAddress,
  isMailChatOneMailbox,
  isMailChatStaleAfterMinutes,
  mailChatCheckerOrg,
  MAIL_CHAT_ASK_PREFIX_DEFAULT,
  MAIL_CHAT_BURST_MAX,
  MAIL_CHAT_STALE_AFTER_MINUTES_MAX,
  MAIL_CHAT_STALE_AFTER_MINUTES_MIN,
  type MailChatDoorCheckResult,
  type MailChatDoorRecentRequest,
  type MailChatDoorSettings,
  type MailChatEnrolFailure,
  type MailChatEnrolledSender,
} from '@recued/contracts';

export const MAIL_CHAT_DOOR_PANEL_ATTR = 'data-recued-mail-chat-door-panel';
export const MAIL_CHAT_DOOR_STATE_ATTR = 'data-recued-mail-chat-door-state';
export const MAIL_CHAT_DOOR_CHAT_PICK_ATTR = 'data-recued-mail-chat-door-chat-pick';
export const MAIL_CHAT_DOOR_OWNER_PICK_ATTR = 'data-recued-mail-chat-door-owner-pick';
export const MAIL_CHAT_DOOR_CONFIRM_ATTR = 'data-recued-mail-chat-door-confirm';
export const MAIL_CHAT_DOOR_DISCLOSURE_ATTR = 'data-recued-mail-chat-door-disclosure';
export const MAIL_CHAT_DOOR_TURN_ON_ATTR = 'data-recued-mail-chat-door-turn-on';
export const MAIL_CHAT_DOOR_CHECK_ATTR = 'data-recued-mail-chat-door-check';
export const MAIL_CHAT_DOOR_CHECK_STATUS_ATTR = 'data-recued-mail-chat-door-check-status';
export const MAIL_CHAT_DOOR_PAUSED_ATTR = 'data-recued-mail-chat-door-paused';
export const MAIL_CHAT_DOOR_RESUME_ATTR = 'data-recued-mail-chat-door-resume';
export const MAIL_CHAT_DOOR_PREFIX_ON_ATTR = 'data-recued-mail-chat-door-prefix-on';
export const MAIL_CHAT_DOOR_PREFIX_ATTR = 'data-recued-mail-chat-door-prefix';
export const MAIL_CHAT_DOOR_STALE_ATTR = 'data-recued-mail-chat-door-stale';
export const MAIL_CHAT_DOOR_SAVE_ATTR = 'data-recued-mail-chat-door-save';
export const MAIL_CHAT_DOOR_TEST_ATTR = 'data-recued-mail-chat-door-test';
export const MAIL_CHAT_DOOR_TEST_START_ATTR = 'data-recued-mail-chat-door-test-start';
export const MAIL_CHAT_DOOR_TEST_STEP_ATTR = 'data-recued-mail-chat-door-test-step';
export const MAIL_CHAT_DOOR_RECENT_ATTR = 'data-recued-mail-chat-door-recent';
export const MAIL_CHAT_DOOR_TURN_OFF_ATTR = 'data-recued-mail-chat-door-turn-off';
export const MAIL_CHAT_DOOR_TURN_OFF_CONFIRM_ATTR = 'data-recued-mail-chat-door-turn-off-confirm';
export const MAIL_CHAT_DOOR_KEEP_ON_ATTR = 'data-recued-mail-chat-door-keep-on';
export const MAIL_CHAT_DOOR_ERROR_ATTR = 'data-recued-mail-chat-door-error';
export const MAIL_CHAT_DOOR_RETRY_ATTR = 'data-recued-mail-chat-door-retry';
export const MAIL_CHAT_DOOR_ENROL_ATTR = 'data-recued-mail-chat-door-enrol';
export const MAIL_CHAT_DOOR_ENROL_INPUT_ATTR = 'data-recued-mail-chat-door-enrol-input';
export const MAIL_CHAT_DOOR_ENROL_ADD_ATTR = 'data-recued-mail-chat-door-enrol-add';
export const MAIL_CHAT_DOOR_ENROL_SENDER_ATTR = 'data-recued-mail-chat-door-enrol-sender';
export const MAIL_CHAT_DOOR_ENROL_STATE_ATTR = 'data-recued-mail-chat-door-enrol-state';
export const MAIL_CHAT_DOOR_ENROL_CODE_ATTR = 'data-recued-mail-chat-door-enrol-code';
export const MAIL_CHAT_DOOR_ENROL_REMOVE_ATTR = 'data-recued-mail-chat-door-enrol-remove';
export const MAIL_CHAT_DOOR_ENROL_RETRY_ATTR = 'data-recued-mail-chat-door-enrol-retry';

/** How often the test round trip looks for its email, and for how long. The
 *  proof waits up to ten minutes for a Sent copy, so the watch outlasts it. */
export const MAIL_CHAT_DOOR_TEST_POLL_MS = 3_000;
export const MAIL_CHAT_DOOR_TEST_WATCH_MS = 15 * 60_000;
/** With nothing arrived after this long, the panel says what to check. */
export const MAIL_CHAT_DOOR_TEST_HINT_MS = 2 * 60_000;

/** A connected mailbox, as `collection.mail.list` lists it. */
export interface MailChatDoorMailboxRow {
  readonly slug: string;
  readonly account_email?: string | null;
  readonly send_capable?: boolean;
}

export type MailChatDoorSetArgs = {
  chat_mailbox?: string | null;
  ask_prefix?: string | null;
  owner_mailboxes?: readonly string[];
  stale_after_minutes?: number;
  resume?: true;
  /** Step 8 — add an address Recued does not read: a new code. */
  enroll?: string;
  /** Step 8 — remove one. */
  unenroll?: string;
};

export interface MountMailChatDoorPanelOptions {
  host: HTMLElement;
  document?: Document;
  runGet: () => Promise<MailChatDoorSettings>;
  runSet: (args: MailChatDoorSetArgs) => Promise<MailChatDoorSettings>;
  runCheck: (args: { chat_mailbox: string; owner_mailboxes: readonly string[] }) => Promise<MailChatDoorCheckResult>;
  runRecent: () => Promise<{ readonly requests: readonly MailChatDoorRecentRequest[] }>;
  runListMailboxes: () => Promise<{ readonly instances: readonly MailChatDoorMailboxRow[] }>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  locale?: string;
  /** The zone times are shown in. Absent ⇒ the browser's. */
  timeZone?: string;
}

export interface MailChatDoorPanelMount {
  getState(): 'loading' | 'ready' | 'error';
  getError(): string | null;
  refresh(): Promise<void>;
  dispose(): void;
}

/** Why a request stopped, as the owner reads it — the proof's codes (§8.2, §8.9). */
const REASON_WORDS: Readonly<Record<string, string>> = {
  not_in_sent: 'Recued did not find it in your Sent folder, so it was not answered. Check that your mail app keeps '
    + 'what you send in the Sent folder.',
  mismatch: 'Your Sent folder holds another email under the same message ID, so it was not answered.',
  unreachable: 'Recued could not reach your mailbox to look in its Sent folder, so it was not answered.',
  unsupported: 'Recued cannot look in that mailbox’s Sent folder, so it was not answered.',
  duplicate: 'Two copies of it arrived, and Recued answers neither.',
  unauthenticated: 'It failed the sender check (DMARC) where it arrived, so it was not answered.',
  unverified: 'Your chat mailbox’s provider did not confirm it came from that address’s mail servers, so it was '
    + 'not answered.',
  not_owner: 'It is not from one of your mailboxes or added addresses, so Recued did not answer it.',
  not_addressed: 'The chat mailbox’s own address was not in To (an alias, or Cc), so Recued did not answer it.',
  door_changed: 'The chat mailbox changed before Recued checked it.',
  no_chat_mailbox: 'The chat mailbox was not connected when Recued checked it.',
};

/** Step 8 — why an address was not added, as the owner reads it. */
const ENROL_FAILURE_WORDS: Readonly<Record<MailChatEnrolFailure, string>> = {
  no_check: 'Your chat mailbox’s provider put no sender check on its email, so an email from this address cannot '
    + 'be told apart from a forged one there.',
  foreign_check: 'The sender check on its email was not made by your chat mailbox’s provider, so Recued cannot '
    + 'rely on it.',
  failed_check: 'Its email failed the sender check (DMARC) where it arrived. Check the address’s SPF and DKIM '
    + 'settings.',
  no_pass: 'Its email did not pass the sender check where it arrived: its provider did not sign it for that '
    + 'address’s domain.',
  expired: 'The code ran out before its email arrived.',
  too_many_attempts: 'Too many emails with a wrong code arrived from it.',
};

const durationWords = (minutes: number): string => {
  if (minutes % 1440 === 0) return minutes === 1440 ? 'a day' : `${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? 'an hour' : `${minutes / 60} hours`;
  return `${minutes} minutes`;
};

/** Settled: nothing more will happen to it. */
const isSettled = (request: MailChatDoorRecentRequest): boolean =>
  request.state === 'not_proven' || request.state === 'ignored'
  || request.chat === 'dropped' || request.chat === 'gave_up'
  || request.answer === 'sent' || request.answer === 'failed' || request.answer === 'dropped';

export const mountMailChatDoorPanel = (opts: MountMailChatDoorPanelOptions): MailChatDoorPanelMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error('mountMailChatDoorPanel: no document available — pass `opts.document`');
  }
  const now = opts.now ?? ((): number => Date.now());
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let state: 'loading' | 'ready' | 'error' = 'loading';
  let settings: MailChatDoorSettings | null = null;
  let mailboxes: MailChatDoorMailboxRow[] = [];
  let recent: MailChatDoorRecentRequest[] = [];
  let error: string | null = null;
  let busy = false;
  let disposed = false;
  let pendingRead: Promise<void> | null = null;
  let retryOffered = false;
  let retryNode: HTMLButtonElement | null = null;
  let settingsVersion = 0;
  // Drafts belong to this mailbox until their corresponding save succeeds.
  let prefixDraft: { enabled: boolean; text: string } | null = null;
  let staleDraft: string | null = null;
  const editControls = new Map<string, HTMLInputElement>();
  // Switching on.
  let pickChat = '';
  const pickOwners = new Set<string>();
  let confirmed = false;
  let checks: MailChatDoorCheckResult | null = null;
  /** The owner's mailboxes already named start ticked, once. */
  let ownersSeeded = false;
  // Switched on.
  let confirmingOff = false;
  /** The test round trip: the newest request before it began, and when. */
  let test: { readonly after: number; readonly started: number } | null = null;
  let timer: unknown = null;
  /** Step 8 — the address being typed, and the look for a code's email. */
  let enrolDraft = '';
  let enrolTimer: unknown = null;
  /** ⚠ A server from before step 8 lists no addresses and refuses `enroll`:
   *  this webclient can be newer than the owner's own server. */
  let enrolSupported = true;

  /** The settings as this panel reads them, from a server of any step. */
  const normalize = (next: MailChatDoorSettings): MailChatDoorSettings => {
    if (Array.isArray((next as Partial<MailChatDoorSettings>).enrolled_senders)) return next;
    enrolSupported = false;
    return { ...next, enrolled_senders: [] };
  };

  const acceptSettings = (next: MailChatDoorSettings): void => {
    if (settings?.chat_mailbox !== next.chat_mailbox) {
      prefixDraft = null;
      staleDraft = null;
      enrolDraft = '';
    }
    settings = normalize(next);
  };

  const el = (tag: string, text?: string): HTMLElement => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const hint = (text: string): HTMLElement => {
    const p = el('p', text);
    p.className = 'mcd-hint';
    return p;
  };
  const button = (text: string, attr: string, onClick: () => void, kind = 'secondary'): HTMLButtonElement => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = `rx-btn rx-btn-${kind} rx-btn-sm`;
    b.textContent = text;
    b.disabled = busy;
    b.setAttribute(attr, '');
    b.addEventListener('click', onClick);
    return b;
  };
  const time = (ms: number): string => {
    const options: Intl.DateTimeFormatOptions = {
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      ...(opts.timeZone !== undefined ? { timeZone: opts.timeZone } : {}),
    };
    return new Intl.DateTimeFormat(opts.locale ?? 'en-GB', options).format(ms);
  };
  const addressOf = (slug: string): string =>
    mailboxes.find((row) => row.slug === slug)?.account_email ?? slug;
  const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  // ── reads and writes ──────────────────────────────────────────────────────

  const loadRecent = async (): Promise<void> => {
    try {
      recent = [...(await opts.runRecent()).requests];
    } catch {
      // The last list stays: a failed look is not "nothing arrived".
    }
  };

  const save = async (patch: MailChatDoorSetArgs): Promise<boolean> => {
    if (busy) return false;
    busy = true;
    error = null;
    render();
    try {
      const next = await opts.runSet(patch);
      if (disposed) return false;
      settingsVersion += 1;
      acceptSettings(next);
      if (patch.ask_prefix !== undefined) prefixDraft = null;
      if (patch.stale_after_minutes !== undefined) staleDraft = null;
      return true;
    } catch (err) {
      if (disposed) return false;
      error = message(err);
      return false;
    } finally {
      busy = false;
      if (!disposed) render();
    }
  };

  /** Switching on needs the chat mailbox, and P20's word for any mailbox of the
   *  owner's picked. None picked is a door for added addresses (step 8). */
  const canTurnOn = (): boolean => pickChat !== '' && (pickOwners.size === 0 || confirmed);

  const turnOn = async (): Promise<void> => {
    if (busy || !canTurnOn()) return;
    busy = true;
    error = null;
    checks = null;
    render();
    const owner_mailboxes = [...pickOwners];
    try {
      const result = await opts.runCheck({ chat_mailbox: pickChat, owner_mailboxes });
      if (disposed) return;
      checks = result;
      if (result.ready) {
        const next = await opts.runSet({ chat_mailbox: pickChat, owner_mailboxes });
        if (disposed) return;
        settingsVersion += 1;
        acceptSettings(next);
        checks = null;
        await startTest();
      }
    } catch (err) {
      if (disposed) return;
      error = message(err);
    } finally {
      busy = false;
      if (!disposed) render();
    }
  };

  const stopTest = (): void => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  // ── step 8: addresses Recued does not read ────────────────────────────────

  const isPending = (sender: MailChatEnrolledSender): boolean => sender.state === 'pending';

  const stopEnrolWatch = (): void => {
    if (enrolTimer !== null) clearTimer(enrolTimer);
    enrolTimer = null;
  };

  /** While a code waits for its email, look again every few seconds. */
  const watchEnrolment = (): void => {
    stopEnrolWatch();
    if (disposed || settings === null || !settings.enrolled_senders.some(isPending)) return;
    enrolTimer = setTimer(() => {
      enrolTimer = null;
      // A look already on its way when the panel closed asks nothing.
      if (disposed) return;
      void (async () => {
        const version = settingsVersion;
        try {
          const next = await opts.runGet();
          if (disposed) return;
          if (version === settingsVersion) {
            acceptSettings(next);
            if (!busy) render();
          }
        } catch {
          // The last view stays: a failed look is not "nothing arrived".
        }
        watchEnrolment();
      })();
    }, MAIL_CHAT_DOOR_TEST_POLL_MS);
  };

  const enrol = async (address: string): Promise<void> => {
    const bare = address.trim().toLowerCase();
    if (!isMailChatEnrollableAddress(bare)) {
      error = 'Enter an email address, such as me@example.com.';
      render();
      return;
    }
    if (await save({ enroll: bare })) {
      enrolDraft = '';
      watchEnrolment();
      render();
    }
  };

  const testRequest = (): MailChatDoorRecentRequest | null => {
    if (test === null) return null;
    const after = test.after;
    // Newest first; the oldest one after the test began is the test.
    const arrived = recent.filter((request) => request.arrived_at > after);
    return arrived.length === 0 ? null : arrived[arrived.length - 1]!;
  };

  const watch = async (): Promise<void> => {
    timer = null;
    if (disposed || test === null) return;
    await loadRecent();
    if (disposed || test === null) return;
    render();
    const request = testRequest();
    if ((request === null || !isSettled(request)) && now() - test.started < MAIL_CHAT_DOOR_TEST_WATCH_MS) {
      timer = setTimer(() => { void watch(); }, MAIL_CHAT_DOOR_TEST_POLL_MS);
    }
  };

  const startTest = async (): Promise<void> => {
    stopTest();
    await loadRecent();
    // ⚠ The server's clock, not this browser's: the test is whatever the door
    // stores after its newest request now.
    test = { after: recent.reduce((max, request) => Math.max(max, request.arrived_at), 0), started: now() };
    void watch();
  };

  // ── rendering ─────────────────────────────────────────────────────────────

  const renderError = (into: HTMLElement): void => {
    if (error === null) return;
    const p = el('p', error);
    p.setAttribute(MAIL_CHAT_DOOR_ERROR_ATTR, '');
    into.appendChild(p);
  };

  const renderChecks = (into: HTMLElement): void => {
    if (checks === null) return;
    const list = el('ul');
    for (const check of checks.checks) {
      const item = el('li');
      item.setAttribute(MAIL_CHAT_DOOR_CHECK_ATTR, check.slug);
      item.setAttribute(MAIL_CHAT_DOOR_CHECK_STATUS_ATTR, check.status);
      const mark = check.status === 'pass' ? '✓' : check.status === 'fail' ? '✗' : '…';
      const who = check.slug === '' ? '' : `${addressOf(check.slug)}: `;
      item.appendChild(el('span', `${mark} ${who}${check.text}`));
      list.appendChild(item);
    }
    into.appendChild(list);
    if (!checks.ready) {
      into.appendChild(hint(checks.checks.some((check) => check.status === 'fail')
        ? 'Email chat is still off. Fix what is marked ✗, then try again.'
        : 'Email chat is still off. Try again in a moment.'));
    }
  };

  const renderOff = (into: HTMLElement): void => {
    into.appendChild(el('p',
      'Write to Recued by email. You send from your own mailbox to a second one you connect for this, the chat '
      + 'mailbox, and Recued answers from it, in the same thread.'));

    // The chat mailbox: one that can send, since the answers go from it.
    const chatLabel = el('label');
    chatLabel.appendChild(el('span', 'Chat mailbox'));
    const select = doc.createElement('select');
    select.className = 'rx-select';
    select.disabled = busy;
    select.setAttribute(MAIL_CHAT_DOOR_CHAT_PICK_ATTR, '');
    const none = doc.createElement('option');
    none.value = '';
    none.textContent = 'Pick a mailbox';
    select.appendChild(none);
    for (const row of mailboxes) {
      const option = doc.createElement('option');
      option.value = row.slug;
      option.textContent = row.send_capable === true
        ? (row.account_email ?? row.slug)
        : `${row.account_email ?? row.slug} (cannot send)`;
      option.disabled = row.send_capable !== true;
      option.selected = row.slug === pickChat;
      select.appendChild(option);
    }
    select.value = pickChat;
    select.addEventListener('change', () => {
      pickChat = select.value;
      checks = null;
      render();
    });
    chatLabel.appendChild(select);
    into.appendChild(chatLabel);
    into.appendChild(hint('Recued answers from this mailbox, so it must be one it can send from. It can be one of '
      + 'your own: tick it under Your mailboxes too, and you write to yourself. Otherwise use a mailbox only for '
      + 'this: its mail stops being treated as yours.'));
    if (mailboxes.length === 0) {
      into.appendChild(hint('No mailbox is connected yet. Connect the chat mailbox and your own first.'));
    }

    // The owner's mailboxes: the Sent folders that prove an email is theirs.
    const owners = el('fieldset');
    owners.appendChild(el('legend', 'Your mailboxes'));
    for (const row of mailboxes) {
      const box = doc.createElement('input');
      box.type = 'checkbox';
      box.checked = pickOwners.has(row.slug);
      box.disabled = busy;
      box.setAttribute(MAIL_CHAT_DOOR_OWNER_PICK_ATTR, row.slug);
      box.addEventListener('change', () => {
        if (pickOwners.has(row.slug)) pickOwners.delete(row.slug);
        else pickOwners.add(row.slug);
        checks = null;
        render();
      });
      const label = el('label');
      label.className = 'rx-checkbox-row';
      label.appendChild(box);
      label.appendChild(el('span', ` ${row.account_email ?? row.slug}${row.slug === pickChat
        ? ' (the chat mailbox: you write to yourself)' : ''}`));
      owners.appendChild(label);
    }
    owners.appendChild(hint('The ones you write from. Recued knows an email to the chat mailbox is yours by '
      + 'finding it in one of these Sent folders.'));
    // §8.18 — one mailbox: what writing to yourself means.
    if (pickChat !== '' && pickOwners.has(pickChat)) {
      owners.appendChild(hint(`You write to yourself at ${addressOf(pickChat)}. Only an email to that address alone `
        + 'whose subject begins with the prefix (ask: unless you change it) starts a conversation, and the prefix '
        + 'cannot be turned off. Your other mail there stays yours: only the conversation is kept out of it.'));
    }
    if (pickOwners.size === 0) {
      owners.appendChild(hint('None picked: once email chat is on, you can add an address Recued does not read '
        + 'instead.'));
    }
    into.appendChild(owners);

    // ⛔ P20 — the owner's word that no one else sends from them.
    if (pickOwners.size > 0) renderConfirm(into);

    // ⛔ P21 — where the answers are kept, said before it is switched on.
    renderDisclosure(into);

    const on = button(busy ? 'Checking…' : 'Check and turn on', MAIL_CHAT_DOOR_TURN_ON_ATTR, () => { void turnOn(); },
      'primary');
    on.disabled = busy || !canTurnOn();
    into.appendChild(on);
    renderChecks(into);
  };

  const renderConfirm = (into: HTMLElement): void => {
    const confirm = doc.createElement('input');
    confirm.type = 'checkbox';
    confirm.checked = confirmed;
    confirm.disabled = busy;
    confirm.setAttribute(MAIL_CHAT_DOOR_CONFIRM_ATTR, '');
    confirm.addEventListener('change', () => {
      confirmed = !confirmed;
      render();
    });
    const confirmLabel = el('label');
    confirmLabel.className = 'rx-checkbox-row';
    confirmLabel.appendChild(confirm);
    confirmLabel.appendChild(el('span', ' Only I send email from these mailboxes'));
    into.appendChild(confirmLabel);
    into.appendChild(hint('Anyone else who can send from them, such as an assistant, a shared login or an app '
      + 'with send access, could ask Recued to act as you. Email chat stays off until you tick this.'));
  };

  const renderDisclosure = (into: HTMLElement): void => {
    const disclosure = el('p',
      'Recued’s answers are emails. Each one stays in the chat mailbox’s Sent folder and in your inbox, at those '
      + 'mail providers, like any email. An answer can quote anything Recued can read for you: a CRM record, a '
      + 'file, another mailbox’s mail.');
    disclosure.setAttribute(MAIL_CHAT_DOOR_DISCLOSURE_ATTR, '');
    into.appendChild(disclosure);
  };

  const testSteps = (request: MailChatDoorRecentRequest): string[] => {
    const steps = [`Arrived at ${time(request.arrived_at)} from ${request.from}.`];
    const added = settings?.enrolled_senders.some((sender) => sender.address === request.from) ?? false;
    if (request.state === 'pending') {
      return [...steps, added ? 'Checking who sent it…' : 'Looking for it in your Sent folder…'];
    }
    if (request.state !== 'proven') {
      return [...steps, REASON_WORDS[request.reason ?? ''] ?? 'Recued did not answer it.'];
    }
    if (request.proof === 'enrolled') {
      steps.push('It passed the sender check for an address you added: it is yours.');
    } else {
      steps.push('Found in your Sent folder: it is yours.');
      steps.push(request.sender_auth === 'pass'
        ? 'It passed the sender check (DMARC) where it arrived.'
        : 'The chat mailbox’s provider gave no sender check (DMARC) for it, so Recued relies on your Sent folder '
          + 'alone.');
    }
    if (request.chat === 'waiting' || request.chat === null) return [...steps, 'Waiting to start the chat…'];
    if (request.chat === 'dropped') return [...steps, `Not answered: ${request.chat_reason ?? 'chat did not take it'}.`];
    if (request.chat === 'gave_up') return [...steps, 'Recued could not start a chat for it within an hour.'];
    switch (request.answer) {
      case null:
      case 'pending':
        return [...steps, 'Recued is answering it…'];
      case 'sending':
        return [...steps, 'Sending the answer…'];
      case 'unknown':
        return [...steps, 'Recued is not sure the answer went out, and has asked you.'];
      case 'sent':
        return [...steps, `Answer sent at ${time(request.answered_at ?? request.arrived_at)}. Look for it in your inbox.`];
      case 'failed':
        return [...steps, 'The answer could not be sent. Check the chat mailbox’s connection.'];
      case 'dropped':
        return [...steps, 'The answer was not sent.'];
    }
  };

  const recentWords = (request: MailChatDoorRecentRequest): string => {
    const steps = testSteps(request);
    return `${time(request.arrived_at)} · ${request.from} · ${steps[steps.length - 1]}`;
  };

  /** Step 8 — the addresses Recued does not read: each one's state, and
   *  adding another. */
  const renderEnrolment = (into: HTMLElement, current: MailChatDoorSettings, chat: string): void => {
    const section = el('div');
    section.setAttribute(MAIL_CHAT_DOOR_ENROL_ATTR, '');
    section.appendChild(el('h4', 'Other addresses you write from'));
    section.appendChild(hint('An address Recued does not read, such as a personal Yahoo or iCloud address. Recued '
      + 'knows an email from it is yours by the sender check your chat mailbox’s provider makes, so you confirm it '
      + 'once, by sending a code from it.'));
    if (current.enrolled_senders.length > 0) {
      const list = el('ul');
      for (const sender of current.enrolled_senders) {
        const item = el('li');
        item.setAttribute(MAIL_CHAT_DOOR_ENROL_SENDER_ATTR, sender.address);
        item.setAttribute(MAIL_CHAT_DOOR_ENROL_STATE_ATTR, sender.state);
        const name = el('strong', sender.address);
        name.className = 'mcd-address';
        item.appendChild(name);
        if (sender.state === 'pending' && sender.code !== null) {
          const instruction = el('p');
          instruction.appendChild(el('span', `From ${sender.address}, send an email to ${chat} with this in the subject: `));
          const code = el('strong', sender.code);
          code.setAttribute(MAIL_CHAT_DOOR_ENROL_CODE_ATTR, '');
          instruction.appendChild(code);
          item.appendChild(instruction);
          item.appendChild(hint(sender.expires_at !== null
            ? `Waiting for it. The code works until ${time(sender.expires_at)}.`
            : 'Waiting for it.'));
          item.appendChild(button('Cancel', MAIL_CHAT_DOOR_ENROL_REMOVE_ATTR, () => {
            void save({ unenroll: sender.address });
          }));
        } else if (sender.state === 'confirmed') {
          // The provider, not the host it was seen on: any of its hosts checks.
          item.appendChild(el('p', `Added. Each email from it must pass the sender check by ${
            sender.checked_by === '' || sender.checked_by === null ? 'Microsoft' : mailChatCheckerOrg(sender.checked_by)}.`));
          item.appendChild(button('Remove', MAIL_CHAT_DOOR_ENROL_REMOVE_ATTR, () => {
            void save({ unenroll: sender.address });
          }));
        } else {
          item.appendChild(el('p', `Not added. ${ENROL_FAILURE_WORDS[sender.failure ?? 'no_pass']}`));
          const row = el('div');
          row.className = 'mcd-row';
          row.appendChild(button('Send a new code', MAIL_CHAT_DOOR_ENROL_RETRY_ATTR, () => { void enrol(sender.address); }));
          row.appendChild(button('Remove', MAIL_CHAT_DOOR_ENROL_REMOVE_ATTR, () => {
            void save({ unenroll: sender.address });
          }));
          item.appendChild(row);
        }
        list.appendChild(item);
      }
      section.appendChild(list);
    }
    const input = doc.createElement('input');
    input.type = 'email';
    input.className = 'rx-input';
    input.placeholder = 'you@example.com';
    input.value = enrolDraft;
    input.disabled = busy;
    input.setAttribute(MAIL_CHAT_DOOR_ENROL_INPUT_ATTR, '');
    editControls.set(MAIL_CHAT_DOOR_ENROL_INPUT_ATTR, input);
    input.addEventListener('input', () => { enrolDraft = input.value; });
    const label = el('label');
    label.appendChild(el('span', 'Add an address'));
    label.appendChild(input);
    section.appendChild(label);
    section.appendChild(button(busy ? 'Adding…' : 'Add', MAIL_CHAT_DOOR_ENROL_ADD_ATTR, () => { void enrol(input.value); }));
    section.appendChild(hint('Its mail provider decides who can send as it: anyone it lets send as you, such as '
      + 'others on a company mail server, could write to your chat.'));
    into.appendChild(section);
  };

  const renderOn = (into: HTMLElement, current: MailChatDoorSettings): void => {
    const chat = current.chat_address ?? current.chat_mailbox ?? '';
    // §8.18 — the chat mailbox is one of the owner's own: they write to themselves.
    const oneMailbox = isMailChatOneMailbox(current);
    // Whoever can write to it: the owner's mailboxes, and the addresses added.
    const owners = [
      ...current.owner_mailboxes.map((slug) => (slug === current.chat_mailbox ? 'itself' : addressOf(slug))),
      ...current.enrolled_senders.filter((sender) => sender.state === 'confirmed').map((sender) => sender.address),
    ];
    into.appendChild(el('p', oneMailbox && owners.length === 1
      ? `Email chat is on. Write to yourself at ${chat}.`
      : owners.length > 0
        ? `Email chat is on. Write to ${chat} from ${owners.join(' or ')}.`
        : `Email chat is on, from ${chat}, but no address can write to it yet: add one below, or turn it off and on `
          + 'again to name one of your mailboxes.'));

    if (current.paused_at !== null) {
      const paused = el('div');
      paused.setAttribute(MAIL_CHAT_DOOR_PAUSED_ATTR, '');
      paused.appendChild(el('p',
        `Paused since ${time(current.paused_at)}: more than ${MAIL_CHAT_BURST_MAX} of your emails reached the chat `
        + 'mailbox within a minute, which a person writing does not do. Emails that arrive while it is paused are '
        + 'not answered. A mail rule, a script or a mail app sending its outbox again can do this: stop it first.'));
      paused.appendChild(button('Resume', MAIL_CHAT_DOOR_RESUME_ATTR, () => { void save({ resume: true }); }, 'primary'));
      into.appendChild(paused);
    }

    // The settings.
    const prefixOn = doc.createElement('input');
    prefixOn.type = 'checkbox';
    prefixOn.checked = oneMailbox || (prefixDraft?.enabled ?? current.ask_prefix !== null);
    // One mailbox: always on, or every email the owner writes to themselves
    // would start a conversation (the server refuses it off).
    prefixOn.disabled = busy || oneMailbox;
    prefixOn.setAttribute(MAIL_CHAT_DOOR_PREFIX_ON_ATTR, '');
    editControls.set(MAIL_CHAT_DOOR_PREFIX_ON_ATTR, prefixOn);
    const prefix = doc.createElement('input');
    prefix.type = 'text';
    prefix.className = 'rx-input';
    prefix.value = prefixDraft?.text ?? current.ask_prefix ?? MAIL_CHAT_ASK_PREFIX_DEFAULT;
    prefix.disabled = busy || !prefixOn.checked;
    prefix.setAttribute(MAIL_CHAT_DOOR_PREFIX_ATTR, '');
    editControls.set(MAIL_CHAT_DOOR_PREFIX_ATTR, prefix);
    const keepPrefixDraft = (): void => { prefixDraft = { enabled: prefixOn.checked, text: prefix.value }; };
    prefix.addEventListener('input', keepPrefixDraft);
    prefixOn.addEventListener('change', () => {
      keepPrefixDraft();
      prefix.disabled = busy || !prefixOn.checked;
    });
    const prefixLabel = el('label');
    prefixLabel.className = 'rx-checkbox-row';
    prefixLabel.appendChild(prefixOn);
    prefixLabel.appendChild(el('span', ' Start a conversation only with a subject that begins with '));
    prefixLabel.appendChild(prefix);
    into.appendChild(prefixLabel);
    into.appendChild(hint(oneMailbox
      ? 'A reply in a conversation needs no prefix. You write to yourself, so the prefix stays on: without it, '
        + 'every email you send yourself would start a conversation.'
      : 'A reply in a conversation needs no prefix. Without one, any email you send the chat mailbox starts a '
        + 'conversation, a forwarding rule’s too.'));

    const stale = doc.createElement('input');
    stale.type = 'number';
    stale.className = 'rx-input';
    stale.value = staleDraft ?? String(current.stale_after_minutes);
    stale.disabled = busy;
    stale.setAttribute('min', String(MAIL_CHAT_STALE_AFTER_MINUTES_MIN));
    stale.setAttribute('max', String(MAIL_CHAT_STALE_AFTER_MINUTES_MAX));
    stale.setAttribute(MAIL_CHAT_DOOR_STALE_ATTR, '');
    editControls.set(MAIL_CHAT_DOOR_STALE_ATTR, stale);
    stale.addEventListener('input', () => { staleDraft = stale.value; });
    const staleLabel = el('label');
    staleLabel.appendChild(el('span', 'An email is late after'));
    staleLabel.appendChild(stale);
    staleLabel.appendChild(el('span', 'minutes'));
    into.appendChild(staleLabel);
    into.appendChild(hint('Recued answers an email it reaches that late in one line, and does not act on it. '
      + `Now ${durationWords(current.stale_after_minutes)}. This covers Recued being off, or its vault locked, `
      + 'when you wrote.'));

    const saveButton = button(busy ? 'Saving…' : 'Save', MAIL_CHAT_DOOR_SAVE_ATTR, () => {
      keepPrefixDraft();
      staleDraft = stale.value;
      const minutes = Number(stale.value);
      if (!isMailChatStaleAfterMinutes(minutes)) {
        error = `Enter whole minutes from ${MAIL_CHAT_STALE_AFTER_MINUTES_MIN} to ${MAIL_CHAT_STALE_AFTER_MINUTES_MAX}.`;
        render();
        return;
      }
      const text = prefix.value.trim();
      const withPrefix = prefixOn.checked || oneMailbox;
      if (withPrefix && !isMailChatAskPrefix(text)) {
        error = 'Enter a prefix of 1 to 32 characters, such as ask:';
        render();
        return;
      }
      void save({ ask_prefix: withPrefix ? text : null, stale_after_minutes: minutes });
    });
    into.appendChild(saveButton);
    renderError(into);

    if (enrolSupported) renderEnrolment(into, current, chat);

    // The test round trip.
    const section = el('div');
    section.setAttribute(MAIL_CHAT_DOOR_TEST_ATTR, '');
    section.appendChild(el('h4', 'Test it'));
    const subject = current.ask_prefix === null ? 'ping' : `${current.ask_prefix} ping`;
    const instruction = el('p');
    instruction.appendChild(el('span', oneMailbox && owners.length === 1
      ? `Send an email to yourself, ${chat}, with the subject `
      : `From ${owners.length > 0 ? owners.join(' or ') : 'your address'}, send an email to ${chat} with the subject `));
    const subjectText = el('strong', subject);
    subjectText.className = 'mcd-nowrap';
    instruction.appendChild(subjectText);
    instruction.appendChild(el('span', '. Recued answers it in the same thread.'));
    section.appendChild(instruction);
    const request = testRequest();
    if (test === null) {
      section.appendChild(button('Watch for my test email', MAIL_CHAT_DOOR_TEST_START_ATTR, () => { void startTest(); }));
    } else if (request === null) {
      section.appendChild(el('p', 'Waiting for your email…'));
      if (now() - test.started >= MAIL_CHAT_DOOR_TEST_HINT_MS) {
        section.appendChild(hint(current.ask_prefix === null
          ? `Nothing has arrived yet. Check it went to ${chat}.`
          : `Nothing has arrived yet. Check it went to ${chat}, and that its subject begins with “${current.ask_prefix}”.`));
      }
    } else {
      const list = el('ol');
      for (const step of testSteps(request)) {
        const item = el('li', step);
        item.setAttribute(MAIL_CHAT_DOOR_TEST_STEP_ATTR, '');
        list.appendChild(item);
      }
      section.appendChild(list);
      if (isSettled(request)) {
        section.appendChild(button('Watch for another', MAIL_CHAT_DOOR_TEST_START_ATTR, () => { void startTest(); }));
      }
    }
    into.appendChild(section);

    // What arrived lately.
    if (recent.length > 0) {
      const list = el('ul');
      list.setAttribute(MAIL_CHAT_DOOR_RECENT_ATTR, '');
      for (const item of recent) list.appendChild(el('li', recentWords(item)));
      into.appendChild(el('h4', 'Recent emails to the chat mailbox'));
      into.appendChild(list);
    }

    into.appendChild(el('p', 'Recued’s answers stay in the chat mailbox’s Sent folder and in your inbox, at those '
      + 'mail providers.'));
    if (!confirmingOff) {
      into.appendChild(button('Turn off email chat', MAIL_CHAT_DOOR_TURN_OFF_ATTR, () => {
        confirmingOff = true;
        render();
      }));
    } else {
      into.appendChild(el('p', (oneMailbox
        ? `Turn off email chat? Recued stops answering the emails you write to yourself at ${chat}. `
        : `Turn off email chat? Recued stops answering ${chat}, and its mail is treated as yours again. `)
        + 'To change the mailboxes, turn it off and on again: the addresses you added stay added for this chat '
        + 'mailbox.'));
      into.appendChild(button('Turn off', MAIL_CHAT_DOOR_TURN_OFF_CONFIRM_ATTR, () => {
        void save({ chat_mailbox: null }).then((saved) => {
          if (!saved || disposed) return;
          confirmingOff = false;
          stopTest();
          test = null;
          recent = [];
          render();
        });
      }, 'danger'));
      into.appendChild(button('Keep it on', MAIL_CHAT_DOOR_KEEP_ON_ATTR, () => {
        confirmingOff = false;
        render();
      }));
    }
  };

  const renderReadRetry = (): void => {
    const retry = button(pendingRead === null ? 'Retry Email chat settings' : 'Retrying…',
      MAIL_CHAT_DOOR_RETRY_ATTR, () => { void refresh(); });
    if (pendingRead !== null) {
      retry.setAttribute('aria-disabled', 'true');
      retry.setAttribute('aria-busy', 'true');
    }
    retryNode = retry;
    opts.host.appendChild(retry);
  };

  const render = (): void => {
    if (disposed) return;
    const ownedRetry = retryNode !== null && doc.activeElement === retryNode;
    const editing = [...editControls].find(([, node]) => node === doc.activeElement);
    const selection = editing === undefined ? null : {
      start: editing[1].selectionStart, end: editing[1].selectionEnd, direction: editing[1].selectionDirection,
    };
    editControls.clear();
    retryNode = null;
    opts.host.innerHTML = '';
    opts.host.setAttribute(MAIL_CHAT_DOOR_PANEL_ATTR, '');
    opts.host.setAttribute(MAIL_CHAT_DOOR_STATE_ATTR, state === 'ready' && settings !== null
      ? (settings.chat_mailbox === null ? 'off' : 'on')
      : state);
    const heading = el('h3', 'Email chat');
    heading.setAttribute('tabindex', '-1');
    opts.host.appendChild(heading);
    if (state === 'loading') {
      const status = el('p', retryOffered ? 'Retrying Email chat settings…' : 'Loading…');
      status.setAttribute('role', 'status');
      opts.host.appendChild(status);
      if (retryOffered) renderReadRetry();
    } else if (settings === null) {
      const p = el('p', error ?? 'Could not read the email chat settings.');
      p.setAttribute(MAIL_CHAT_DOOR_ERROR_ATTR, '');
      p.setAttribute('role', 'alert');
      opts.host.appendChild(p);
      renderReadRetry();
    } else if (settings.chat_mailbox === null) {
      renderOff(opts.host);
      renderError(opts.host);
    } else {
      renderOn(opts.host, settings);
    }
    if (ownedRetry) {
      const target = retryNode ?? opts.host.querySelector?.<HTMLElement>(
        'select:not(:disabled), input:not(:disabled), button:not(:disabled)',
      ) ?? heading;
      target.focus?.({ preventScroll: true });
    } else if (editing !== undefined) {
      // Capture the current owner at each paint: a delayed read cannot reclaim
      // focus after the owner has moved to another field or outside the panel.
      const target = editControls.get(editing[0]);
      if (target !== undefined && !target.disabled) {
        target.focus?.({ preventScroll: true });
        if (selection?.start != null && selection.end != null) {
          target.setSelectionRange?.(selection.start, selection.end, selection.direction ?? undefined);
        }
      }
    }
  };

  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (pendingRead !== null) return pendingRead;
    if (settings === null) { state = 'loading'; error = null; }
    const version = settingsVersion;
    pendingRead = (async () => {
      try {
        // Keep the batch owned until both reads settle, including when one fails
        // before the other answers. A retry must not overlap that remaining read.
        const [got, mail] = await Promise.allSettled([
          Promise.resolve().then(() => opts.runGet()),
          Promise.resolve().then(() => opts.runListMailboxes()),
        ]);
        if (got.status === 'rejected') throw got.reason;
        if (mail.status === 'rejected') throw mail.reason;
        const next = got.value;
        const listed = mail.value;
        if (disposed || version !== settingsVersion) return;
        // A server from before the door answers with nothing.
        if (next === null || typeof next !== 'object' || !('chat_mailbox' in next)) {
          throw new Error('This server does not have email chat yet. Update Recued to use it.');
        }
        acceptSettings(next);
        mailboxes = [...(listed?.instances ?? [])];
        if (!ownersSeeded) {
          ownersSeeded = true;
          for (const slug of next.owner_mailboxes) if (mailboxes.some((row) => row.slug === slug)) pickOwners.add(slug);
        }
        if (next.chat_mailbox !== null) await loadRecent();
        if (disposed || version !== settingsVersion) return;
        state = 'ready';
        error = null;
        retryOffered = false;
        watchEnrolment();
      } catch (err) {
        if (disposed || version !== settingsVersion) return;
        state = 'error';
        error = message(err);
        retryOffered = true;
      }
    })().finally(() => {
      pendingRead = null;
      if (!disposed) render();
    });
    if (settings === null) render();
    return pendingRead;
  };

  render();
  void refresh();

  return {
    getState: () => state,
    getError: () => error,
    refresh,
    dispose: () => {
      disposed = true;
      retryNode = null;
      editControls.clear();
      stopTest();
      stopEnrolWatch();
    },
  };
};

export const MAIL_CHAT_DOOR_PANEL_STYLES = `
[${MAIL_CHAT_DOOR_PANEL_ATTR}] {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg);
  font-size: 13px;
  max-width: 72ch;
}
[${MAIL_CHAT_DOOR_PANEL_ATTR}] h3,
[${MAIL_CHAT_DOOR_PANEL_ATTR}] h4 {
  margin: 0;
  font-weight: 600;
}
[${MAIL_CHAT_DOOR_PANEL_ATTR}] h3 { font-size: 14px; }
[${MAIL_CHAT_DOOR_PANEL_ATTR}] h4 { font-size: 13px; margin-top: 6px; }
[${MAIL_CHAT_DOOR_PANEL_ATTR}] p { margin: 0; }
[${MAIL_CHAT_DOOR_PANEL_ATTR}] label {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
[${MAIL_CHAT_DOOR_PANEL_ATTR}] fieldset {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
}
[${MAIL_CHAT_DOOR_PANEL_ATTR}] legend { padding: 0 4px; font-weight: 600; }
[${MAIL_CHAT_DOOR_PANEL_ATTR}] .mcd-hint {
  color: var(--fg-muted);
  font-size: 12px;
  max-width: 64ch;
}
[${MAIL_CHAT_DOOR_PANEL_ATTR}] .mcd-nowrap { white-space: nowrap; }
[${MAIL_CHAT_DOOR_PANEL_ATTR}] .mcd-address { overflow-wrap: anywhere; }
[${MAIL_CHAT_DOOR_PANEL_ATTR}] .mcd-row { display: flex; flex-wrap: wrap; gap: 6px; }
[${MAIL_CHAT_DOOR_PANEL_ATTR}] [${MAIL_CHAT_DOOR_ENROL_ATTR}] {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
[${MAIL_CHAT_DOOR_PANEL_ATTR}] [${MAIL_CHAT_DOOR_ENROL_ATTR}] ul { padding-left: 0; list-style: none; gap: 8px; }
[${MAIL_CHAT_DOOR_PANEL_ATTR}] [${MAIL_CHAT_DOOR_ENROL_SENDER_ATTR}] {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
}
[${MAIL_CHAT_DOOR_PANEL_ATTR}] [${MAIL_CHAT_DOOR_ENROL_STATE_ATTR}="failed"] p { color: var(--danger); }
[${MAIL_CHAT_DOOR_PANEL_ATTR}] [${MAIL_CHAT_DOOR_ENROL_CODE_ATTR}] {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 15px;
  letter-spacing: 0.12em;
  white-space: nowrap;
}
[${MAIL_CHAT_DOOR_PANEL_ATTR}] input[type="email"] { width: 100%; max-width: 32ch; box-sizing: border-box; }
[${MAIL_CHAT_DOOR_PANEL_ATTR}] input[type="text"] { width: 8em; }
[${MAIL_CHAT_DOOR_PANEL_ATTR}] input[type="number"] { width: 5.5em; }
[${MAIL_CHAT_DOOR_PANEL_ATTR}] button { align-self: flex-start; }
[${MAIL_CHAT_DOOR_PANEL_ATTR}] [${MAIL_CHAT_DOOR_DISCLOSURE_ATTR}] {
  padding: 8px 10px;
  border-left: 3px solid var(--accent, var(--border));
  background: var(--surface-sunk, var(--bg));
}
[${MAIL_CHAT_DOOR_PANEL_ATTR}] ul,
[${MAIL_CHAT_DOOR_PANEL_ATTR}] ol {
  margin: 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
[${MAIL_CHAT_DOOR_PANEL_ATTR}] [${MAIL_CHAT_DOOR_CHECK_STATUS_ATTR}="fail"] { color: var(--danger); }
[${MAIL_CHAT_DOOR_PANEL_ATTR}] [${MAIL_CHAT_DOOR_CHECK_STATUS_ATTR}="unknown"] { color: var(--fg-muted); }
[${MAIL_CHAT_DOOR_PANEL_ATTR}] [${MAIL_CHAT_DOOR_RECENT_ATTR}] { color: var(--fg-muted); font-size: 12px; }
[${MAIL_CHAT_DOOR_PANEL_ATTR}] [${MAIL_CHAT_DOOR_PAUSED_ATTR}] {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 4px;
  background: var(--danger-bg);
  color: var(--danger);
}
[${MAIL_CHAT_DOOR_PANEL_ATTR}] [${MAIL_CHAT_DOOR_ERROR_ATTR}] {
  padding: 6px 8px;
  background: var(--danger-bg);
  color: var(--danger);
  border-radius: 4px;
  font-size: 12px;
}
[${MAIL_CHAT_DOOR_PANEL_ATTR}] input:disabled,
[${MAIL_CHAT_DOOR_PANEL_ATTR}] select:disabled,
[${MAIL_CHAT_DOOR_PANEL_ATTR}] button:disabled {
  opacity: 0.55;
}
`;
