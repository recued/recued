/** D-318 step 1 — the email chat door's settings: which mailbox is the chat
 *  mailbox.
 *
 *  One row, its settings as JSON, so the door's later settings (the proof, the
 *  `ask:` filter, stale requests, the burst guard, enrolled senders — D-318
 *  §4.12) join it without a schema change. A mailbox carries no role of its
 *  own: re-enrolling one rebuilds its config, which would drop a mark kept
 *  there.
 *
 *  Step 8 — the addresses Recued does not read that the owner enrolled
 *  (proof (b)): each with its code while it waits, and once its code's email
 *  arrives, the checker every later request from it is held to. A code past
 *  its time reads as expired (`get`), with nothing written. An address belongs
 *  to the chat mailbox it was enrolled through: another chat mailbox's provider
 *  makes other checks.
 *
 *  One mailbox (§8.18) — the chat mailbox may be one of the owner's own too.
 *  ⛔ Then it is NOT a chat-only mailbox (`isChatOnlyMailbox`): every reader of
 *  the owner's mail still reads it, leaving out only the conversation's emails,
 *  each marked as it is stored (`conversation-mail.ts`). And its `ask:` filter
 *  is always on: a write that would leave it off turns it on (`withFilter`).
 *
 *  ⚠ ONE STORE PER SERVER. `isChatMailbox` is asked for every synced message
 *  and every mail event, so the settings are read once and kept in memory; a
 *  `set` refreshes them. A second store over the same database would keep its
 *  own copy, which the first one's `set` never reaches — the collection context
 *  makes the one, and everything reads it from there. */

import { randomInt } from 'node:crypto';

import type Database from 'better-sqlite3';
import {
  isMailChatAskPrefix,
  isMailChatEnrollableAddress,
  isMailChatOneMailbox,
  isMailChatStaleAfterMinutes,
  MAIL_CHAT_DOOR_DEFAULTS,
  MAIL_CHAT_ENROL_ATTEMPTS_MAX,
  MAIL_CHAT_ENROL_CODE_LENGTH,
  MAIL_CHAT_ENROL_CODE_TTL_MS,
  MAIL_CHAT_ENROLLED_SENDERS_MAX,
  MAIL_CHAT_OWNER_MAILBOXES_MAX,
  type MailChatDoorSettings,
  type MailChatEnrolFailure,
  type MailChatEnrolledSender,
} from '@recued/contracts';

/** D-318 step 8 — what the email carrying a pending address's code came to. */
export type MailChatEnrolOutcome =
  /** It passed: mail from the address is checked by `checked_by` from now on. */
  | { readonly kind: 'confirmed'; readonly checked_by: string }
  /** It carried the code and did not pass: the code is spent. */
  | { readonly kind: 'failed'; readonly failure: MailChatEnrolFailure }
  /** It carried a code, not this one. */
  | { readonly kind: 'wrong_code' };

export interface MailChatDoorStore {
  get(): MailChatDoorSettings;
  /** Name the chat mailbox, with its address, or clear it with `null`. The
   *  caller has checked the mailbox exists and can send. */
  setChatMailbox(slug: string | null, address?: string | null): MailChatDoorSettings;
  /** D-318 audit — the owner's own mailboxes (slugs), whose Sent record proves a
   *  request. The caller has checked each is connected. */
  setOwnerMailboxes(slugs: readonly string[]): MailChatDoorSettings;
  /** D-318 audit — a mailbox was deleted: the door forgets it, as the chat
   *  mailbox and as the owner's. A mailbox connected later under the same name is
   *  another account, and is neither until named again. */
  forgetMailbox(slug: string): MailChatDoorSettings;
  /** D-318 step 4 — the `ask:` filter's prefix, or `null` to switch it off. The
   *  caller has checked it (`isMailChatAskPrefix`). */
  setAskPrefix(prefix: string | null): MailChatDoorSettings;
  /** D-318 step 6 — how late a request may be reached and still run. The caller
   *  has checked it (`isMailChatStaleAfterMinutes`). */
  setStaleAfterMinutes(minutes: number): MailChatDoorSettings;
  /** D-318 step 6 — the burst guard pauses the door. `false` when it was paused
   *  already: the first pause is the one the owner is told of. */
  pause(at: number): boolean;
  /** D-318 step 6 — the owner's word: the door takes requests again. */
  resume(): MailChatDoorSettings;
  /** D-318 step 8 — enrol an address through the chat mailbox, with a fresh
   *  code; one already listed starts again. The caller has checked the door is
   *  on and the address may be enrolled. */
  enrollSender(address: string): MailChatDoorSettings;
  /** D-318 step 8 — remove an enrolled address. */
  unenrollSender(address: string): MailChatDoorSettings;
  /** D-318 step 8 — the email carrying a code arrived from a pending address:
   *  what it came to. Only a pending address of this chat mailbox whose code is
   *  still good changes; its entry as it now stands, else `null`. */
  settleEnrolment(chat_mailbox: string, address: string, outcome: MailChatEnrolOutcome): MailChatEnrolledSender | null;
  /** Is this mailbox the chat mailbox? */
  isChatMailbox(slug: string): boolean;
  /** Is ALL of this mailbox's mail the conversation: the chat mailbox, and not
   *  one of the owner's own too (one mailbox, §8.18)? What every reader of the
   *  owner's mail leaves out whole. */
  isChatOnlyMailbox(slug: string): boolean;
}

/** One mailbox keeps its `ask:` filter on: the owner's own email to themselves
 *  is mail, and only one that asks starts a conversation. */
const withFilter = (settings: MailChatDoorSettings): MailChatDoorSettings =>
  settings.ask_prefix === null && isMailChatOneMailbox(settings)
    ? { ...settings, ask_prefix: MAIL_CHAT_DOOR_DEFAULTS.ask_prefix }
    : settings;

const ENROL_FAILURES: ReadonlySet<string> = new Set<MailChatEnrolFailure>([
  'no_check', 'foreign_check', 'failed_check', 'no_pass', 'expired', 'too_many_attempts',
]);

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** One stored enrolment, or `null`. ⛔ A confirmed one must name its checker:
 *  without one, no later request could be held to it. */
const parseSender = (value: unknown): MailChatEnrolledSender | null => {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const address = typeof raw.address === 'string' ? raw.address.trim().toLowerCase() : '';
  if (!isMailChatEnrollableAddress(address) || typeof raw.chat_mailbox !== 'string' || raw.chat_mailbox === '') return null;
  const added_at = finite(raw.added_at);
  if (added_at === null) return null;
  const base = {
    address, chat_mailbox: raw.chat_mailbox, added_at,
    attempts: typeof raw.attempts === 'number' && Number.isInteger(raw.attempts) && raw.attempts >= 0 ? raw.attempts : 0,
  };
  if (raw.state === 'pending') {
    const expires_at = finite(raw.expires_at);
    if (typeof raw.code !== 'string' || !new RegExp(`^\\d{${MAIL_CHAT_ENROL_CODE_LENGTH}}$`).test(raw.code)
      || expires_at === null) return null;
    return { ...base, state: 'pending', code: raw.code, expires_at, confirmed_at: null, checked_by: null, failure: null };
  }
  if (raw.state === 'confirmed') {
    const confirmed_at = finite(raw.confirmed_at);
    if (typeof raw.checked_by !== 'string' || confirmed_at === null) return null;
    return { ...base, state: 'confirmed', code: null, expires_at: null, confirmed_at, checked_by: raw.checked_by, failure: null };
  }
  if (raw.state === 'failed') {
    const failure = typeof raw.failure === 'string' && ENROL_FAILURES.has(raw.failure)
      ? raw.failure as MailChatEnrolFailure
      : 'no_pass';
    return { ...base, state: 'failed', code: null, expires_at: null, confirmed_at: null, checked_by: null, failure };
  }
  return null;
};

/** A pending code past its time, as the owner and the door see it: failed. */
const expired = (sender: MailChatEnrolledSender, at: number): MailChatEnrolledSender =>
  sender.state === 'pending' && sender.expires_at !== null && sender.expires_at <= at
    ? { ...sender, state: 'failed', code: null, expires_at: null, failure: 'expired' }
    : sender;

const parseSettings = (json: string | undefined): MailChatDoorSettings => {
  if (json === undefined) return MAIL_CHAT_DOOR_DEFAULTS;
  try {
    const raw = JSON.parse(json) as {
      chat_mailbox?: unknown; ask_prefix?: unknown; owner_mailboxes?: unknown; chat_address?: unknown;
      stale_after_minutes?: unknown; paused_at?: unknown; enrolled_senders?: unknown;
    };
    return withFilter({
      chat_mailbox: typeof raw.chat_mailbox === 'string' && raw.chat_mailbox !== '' ? raw.chat_mailbox : null,
      // A row from before the setting names none: no request is proven until the
      // owner names theirs.
      owner_mailboxes: Array.isArray(raw.owner_mailboxes)
        ? [...new Set(raw.owner_mailboxes.filter((slug): slug is string => typeof slug === 'string' && slug !== ''))]
          .slice(0, MAIL_CHAT_OWNER_MAILBOXES_MAX)
        : [],
      chat_address: typeof raw.chat_address === 'string' && raw.chat_address.includes('@')
        ? raw.chat_address.trim().toLowerCase()
        : null,
      // Switched off is a choice, kept; a row from before the setting, or one
      // that does not parse, has the filter on.
      ask_prefix: raw.ask_prefix === null
        ? null
        : isMailChatAskPrefix(raw.ask_prefix) ? raw.ask_prefix : MAIL_CHAT_DOOR_DEFAULTS.ask_prefix,
      // A row from before the setting has the default.
      stale_after_minutes: isMailChatStaleAfterMinutes(raw.stale_after_minutes)
        ? raw.stale_after_minutes
        : MAIL_CHAT_DOOR_DEFAULTS.stale_after_minutes,
      paused_at: typeof raw.paused_at === 'number' && Number.isFinite(raw.paused_at) ? raw.paused_at : null,
      // A row from before the setting enrols nobody; an entry that does not
      // parse is dropped, never read as confirmed.
      enrolled_senders: Array.isArray(raw.enrolled_senders)
        ? raw.enrolled_senders.flatMap((entry) => {
          const sender = parseSender(entry);
          return sender === null ? [] : [sender];
        }).slice(0, MAIL_CHAT_ENROLLED_SENDERS_MAX)
        : [],
    });
  } catch {
    // A row that does not parse names no chat mailbox: the mailbox's mail is
    // read as the owner's again, as before the door existed.
    return MAIL_CHAT_DOOR_DEFAULTS;
  }
};

export const createMailChatDoorStore = (
  db: Database.Database,
  now: () => number = Date.now,
): MailChatDoorStore => {
  db.exec(`CREATE TABLE IF NOT EXISTS mail_chat_door (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    settings_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  const read = db.prepare('SELECT settings_json FROM mail_chat_door WHERE id = 1');
  const write = db.prepare(`INSERT INTO mail_chat_door (id, settings_json, updated_at)
    VALUES (1, @settings_json, @updated_at)
    ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`);

  let current = parseSettings((read.get() as { settings_json: string } | undefined)?.settings_json);
  const save = (next: MailChatDoorSettings): MailChatDoorSettings => {
    const kept = withFilter(next);
    write.run({ settings_json: JSON.stringify(kept), updated_at: now() });
    current = kept;
    return current;
  };

  /** The settings as they stand now: a code past its time has run out. */
  const view = (): MailChatDoorSettings => {
    const at = now();
    return current.enrolled_senders.some((sender) => expired(sender, at) !== sender)
      ? { ...current, enrolled_senders: current.enrolled_senders.map((sender) => expired(sender, at)) }
      : current;
  };
  const newCode = (): string =>
    String(randomInt(10 ** MAIL_CHAT_ENROL_CODE_LENGTH)).padStart(MAIL_CHAT_ENROL_CODE_LENGTH, '0');

  return {
    get: view,
    setChatMailbox: (slug, address) => {
      const chat_mailbox = slug === null || slug === '' ? null : slug;
      const bare = typeof address === 'string' ? address.trim().toLowerCase() : '';
      save({
        ...current,
        chat_mailbox,
        chat_address: chat_mailbox !== null && bare.includes('@') ? bare : null,
        // The owner's mailboxes stay as named: one of them may be this one
        // (one mailbox, §8.18).
        // An address is checked by the provider of the chat mailbox it was
        // enrolled through: another chat mailbox needs it enrolled again.
        // Switched off, a confirmed one is kept for the same chat mailbox
        // switched on again (the way to change the owner's mailboxes); a code
        // is not.
        enrolled_senders: current.enrolled_senders.filter((sender) => (chat_mailbox === null
          ? sender.state === 'confirmed'
          : sender.chat_mailbox === chat_mailbox)),
      });
      return view();
    },
    enrollSender: (address) => {
      const bare = address.trim().toLowerCase();
      const at = now();
      const chat_mailbox = current.chat_mailbox;
      if (chat_mailbox === null) return view();
      const sender: MailChatEnrolledSender = {
        address: bare, state: 'pending', chat_mailbox, code: newCode(), expires_at: at + MAIL_CHAT_ENROL_CODE_TTL_MS,
        attempts: 0, added_at: at, confirmed_at: null, checked_by: null, failure: null,
      };
      const others = current.enrolled_senders.filter((entry) => entry.address !== bare);
      save({ ...current, enrolled_senders: [...others, sender].slice(-MAIL_CHAT_ENROLLED_SENDERS_MAX) });
      return view();
    },
    unenrollSender: (address) => {
      const bare = address.trim().toLowerCase();
      if (!current.enrolled_senders.some((entry) => entry.address === bare)) return view();
      save({ ...current, enrolled_senders: current.enrolled_senders.filter((entry) => entry.address !== bare) });
      return view();
    },
    settleEnrolment: (chat_mailbox, address, outcome) => {
      const at = now();
      const bare = address.trim().toLowerCase();
      const entry = current.enrolled_senders.find((sender) => sender.address === bare);
      if (entry === undefined || entry.chat_mailbox !== chat_mailbox || expired(entry, at).state !== 'pending') return null;
      let next: MailChatEnrolledSender;
      if (outcome.kind === 'confirmed') {
        next = { ...entry, state: 'confirmed', code: null, expires_at: null, confirmed_at: at, checked_by: outcome.checked_by };
      } else if (outcome.kind === 'failed') {
        next = { ...entry, state: 'failed', code: null, expires_at: null, failure: outcome.failure };
      } else {
        const attempts = entry.attempts + 1;
        next = attempts >= MAIL_CHAT_ENROL_ATTEMPTS_MAX
          ? { ...entry, attempts, state: 'failed', code: null, expires_at: null, failure: 'too_many_attempts' }
          : { ...entry, attempts };
      }
      save({ ...current, enrolled_senders: current.enrolled_senders.map((sender) => (sender === entry ? next : sender)) });
      return next;
    },
    setAskPrefix: (prefix) => {
      save({ ...current, ask_prefix: prefix });
      return view();
    },
    setStaleAfterMinutes: (minutes) => {
      save({ ...current, stale_after_minutes: minutes });
      return view();
    },
    pause: (at) => {
      if (current.paused_at !== null) return false;
      save({ ...current, paused_at: at });
      return true;
    },
    resume: () => {
      if (current.paused_at !== null) save({ ...current, paused_at: null });
      return view();
    },
    setOwnerMailboxes: (slugs) => {
      save({ ...current, owner_mailboxes: [...new Set(slugs)].slice(0, MAIL_CHAT_OWNER_MAILBOXES_MAX) });
      return view();
    },
    forgetMailbox: (slug) => {
      const enrolled = current.enrolled_senders.some((sender) => sender.chat_mailbox === slug);
      if (current.chat_mailbox !== slug && !current.owner_mailboxes.includes(slug) && !enrolled) return view();
      save({
        ...current,
        ...(current.chat_mailbox === slug ? { chat_mailbox: null, chat_address: null } : {}),
        owner_mailboxes: current.owner_mailboxes.filter((owner) => owner !== slug),
        // Enrolled through that mailbox: its provider made the checks.
        enrolled_senders: current.enrolled_senders.filter((sender) => sender.chat_mailbox !== slug),
      });
      return view();
    },
    isChatMailbox: (slug) => current.chat_mailbox !== null && current.chat_mailbox === slug,
    isChatOnlyMailbox: (slug) => current.chat_mailbox !== null && current.chat_mailbox === slug
      && !current.owner_mailboxes.includes(slug),
  };
};
