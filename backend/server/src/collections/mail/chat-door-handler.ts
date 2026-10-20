/** D-318 step 1 — `collection.mail.chat_door.get` / `.set`: which connected
 *  mailbox is the email chat door's chat mailbox, (step 4) the `ask:` filter's
 *  prefix (`ask_prefix`, `null` to switch it off), (the audit) the owner's own
 *  mailboxes (`owner_mailboxes`), whose Sent record proves a request, and
 *  (step 6) how late a request may be reached and still run
 *  (`stale_after_minutes`). A call sets any of them, and `resume: true` lifts
 *  the burst guard's pause: the owner's word (§4.9).
 *
 *  The owner writes from their own mailbox to the chat mailbox, and Recued
 *  answers from it in the thread (D-318 ruling 1), so it must be able to send.
 *  Naming it takes its mail out of the owner's mail at once: no mail facts, no
 *  contacts, no mail recipe (§4.10) — unless it is one of the owner's own too
 *  (one mailbox, below). Clearing it (`null`) puts it back.
 *
 *  Owner-only: `collection.mail.chat_door.` is an MCP reserved prefix. Each
 *  change is audited (`mail_chat_door_set`).
 *
 *  Step 7 — `.check`: what switching the door on depends on (§4.12), mailbox by
 *  mailbox, in words the settings screen shows: the chat mailbox can send and
 *  its first sync is done; each of the owner's mailboxes can be asked for its
 *  Sent record — asked for a Message-ID no message has, one lookup each. ⚠ No
 *  provider tells Recued that others send from a mailbox (Gmail and Graph sign
 *  in as the account itself; IMAP has no such notion), so P20's other half is
 *  the owner's own confirmation, on the screen. And `.recent`: the latest
 *  requests and how far each got, for the test round trip — never a subject
 *  or a body.
 *
 *  Step 8 — `.set { enroll }` adds an address Recued does not read (proof
 *  (b)) once the door is on, with a fresh code the screen shows; `unenroll`
 *  removes one. Refused: the chat mailbox's own address, and one Recued reads,
 *  which is named as the owner's mailbox instead. The audit names the address,
 *  never the code. And `.check` no longer fails for none of the owner's
 *  mailboxes named: such a door is for added addresses.
 *
 *  One mailbox (§8.18) — the chat mailbox may be named among the owner's own:
 *  they write to it from itself. Its mail then stays theirs, the conversation's
 *  emails aside, and its `ask:` filter cannot be switched off (the store turns
 *  it back on; an explicit `null` is refused). `.check` asks it for its Sent
 *  record as it asks any of the owner's mailboxes. The same account connected
 *  twice, under another name, is still refused.
 *
 *  Spec: D-318 §4.1, §4.12, §8 steps 1, 7 and 8, §8.18. */

import { randomUUID } from 'node:crypto';

import {
  isMailChatAskPrefix,
  isMailChatEnrollableAddress,
  isMailChatOneMailbox,
  isMailChatStaleAfterMinutes,
  MAIL_CHAT_ENROLLED_SENDERS_MAX,
  MAIL_CHAT_OWNER_MAILBOXES_MAX,
  MAIL_CHAT_RECENT_REQUESTS_MAX,
  MAIL_CHAT_STALE_AFTER_MINUTES_MAX,
  MAIL_CHAT_STALE_AFTER_MINUTES_MIN,
  RpcError,
  type MailChatDoorCheck,
  type MailChatDoorCheckResult,
  type MailChatDoorRecentRequest,
  type MailChatDoorSettings,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';

import type { MailChatAnswers } from '../../mail-chat-door/answers.js';
import type { MailChatSentProof } from '../../mail-chat-door/sent-proof.js';
import type { MailChatDoorStore } from '../../storage/mail-chat-door-store.js';
import { handleMailList, type MailEnrollDeps } from './enroll.js';
import type { MailCollection } from './mail-collection.js';

export interface MailChatDoorHandlerDeps {
  store: MailChatDoorStore;
  /** The mailbox listing, which answers whether a mailbox exists and can send.
   *  Absent ⇒ a mailbox cannot be named (clearing still works). */
  mail?: MailEnrollDeps;
  auditLog?: AuditLogStore;
  /** Step 7 — the mailboxes running now, which `.check` asks. Absent ⇒ none is. */
  mailboxes?: () => readonly Pick<MailCollection, 'platform' | 'slug' | 'accountEmail' | 'lookupSentByMessageId'>[];
  /** Step 7 — the proof's requests and the answers, for `.recent`. */
  requests?: Pick<MailChatSentProof, 'recent'>;
  answers?: Pick<MailChatAnswers, 'ofRequest'>;
}

const bare = (address: string | null | undefined): string => {
  const angled = /<([^<>]+)>/.exec(address ?? '');
  return (angled?.[1] ?? address ?? '').trim().toLowerCase();
};

export const handleMailChatDoorGet = (deps: MailChatDoorHandlerDeps): MailChatDoorSettings =>
  deps.store.get();

export const handleMailChatDoorSet = async (
  deps: MailChatDoorHandlerDeps,
  args: unknown,
): Promise<MailChatDoorSettings> => {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new RpcError(
      'bad_request',
      'collection.mail.chat_door.set: expected { chat_mailbox?, ask_prefix?, owner_mailboxes?, stale_after_minutes?, '
        + 'resume?, enroll?, unenroll? }',
      400,
    );
  }
  const patch = args as {
    chat_mailbox?: unknown; ask_prefix?: unknown; owner_mailboxes?: unknown; stale_after_minutes?: unknown; resume?: unknown;
    enroll?: unknown; unenroll?: unknown;
  };
  const setsMailbox = Object.hasOwn(patch, 'chat_mailbox');
  const setsPrefix = Object.hasOwn(patch, 'ask_prefix');
  const setsOwners = Object.hasOwn(patch, 'owner_mailboxes');
  const setsStale = Object.hasOwn(patch, 'stale_after_minutes');
  const resumes = Object.hasOwn(patch, 'resume');
  const enrolls = Object.hasOwn(patch, 'enroll');
  const unenrolls = Object.hasOwn(patch, 'unenroll');
  if (!setsMailbox && !setsPrefix && !setsOwners && !setsStale && !resumes && !enrolls && !unenrolls) {
    throw new RpcError(
      'bad_request',
      'collection.mail.chat_door.set: name chat_mailbox, ask_prefix, owner_mailboxes, stale_after_minutes, resume, '
        + 'enroll or unenroll',
      400,
    );
  }
  // Step 8 — an address is enrolled once the door is on, on its own: the code's
  // email goes to the chat mailbox as it now stands.
  if (enrolls && (setsMailbox || setsOwners)) {
    throw new RpcError(
      'bad_request',
      'collection.mail.chat_door.set: enroll an address on its own, once the chat mailbox is set',
      400,
    );
  }
  const enroll = enrolls && typeof patch.enroll === 'string' ? bare(patch.enroll) : null;
  if (enrolls && (enroll === null || !isMailChatEnrollableAddress(enroll))) {
    throw new RpcError('bad_request', 'collection.mail.chat_door.set: enroll takes an email address', 400);
  }
  if (unenrolls && typeof patch.unenroll !== 'string') {
    throw new RpcError('bad_request', 'collection.mail.chat_door.set: unenroll takes an email address', 400);
  }
  const { chat_mailbox, ask_prefix, owner_mailboxes, stale_after_minutes } = patch;
  if (resumes && patch.resume !== true) {
    throw new RpcError('bad_request', 'collection.mail.chat_door.set: resume takes true, to take requests again', 400);
  }
  if (setsStale && !isMailChatStaleAfterMinutes(stale_after_minutes)) {
    throw new RpcError(
      'bad_request',
      `collection.mail.chat_door.set: stale_after_minutes must be a whole number of minutes from `
        + `${MAIL_CHAT_STALE_AFTER_MINUTES_MIN} to ${MAIL_CHAT_STALE_AFTER_MINUTES_MAX}`,
      400,
    );
  }
  if (setsOwners && (!Array.isArray(owner_mailboxes)
    || owner_mailboxes.length > MAIL_CHAT_OWNER_MAILBOXES_MAX
    || !owner_mailboxes.every((slug) => typeof slug === 'string' && slug !== ''))) {
    throw new RpcError(
      'bad_request',
      `collection.mail.chat_door.set: owner_mailboxes must be a list of up to ${MAIL_CHAT_OWNER_MAILBOXES_MAX} mailbox slugs`,
      400,
    );
  }
  if (setsMailbox && chat_mailbox !== null && typeof chat_mailbox !== 'string') {
    throw new RpcError(
      'bad_request',
      'collection.mail.chat_door.set: chat_mailbox must be a mailbox slug, or null to clear it',
      400,
    );
  }
  if (setsPrefix && ask_prefix !== null && !isMailChatAskPrefix(ask_prefix)) {
    throw new RpcError(
      'bad_request',
      'collection.mail.chat_door.set: ask_prefix must be 1 to 32 characters on one line, with no space at either '
        + 'end — or null to let any subject start a conversation',
      400,
    );
  }
  const naming = (setsMailbox && typeof chat_mailbox === 'string') || (setsOwners && (owner_mailboxes as string[]).length > 0)
    || enroll !== null;
  const mailboxes = naming
    ? await (async () => {
        if (deps.mail === undefined) {
          throw new RpcError('not_configured', 'collection.mail.chat_door.set: mail is not set up on this server', 503);
        }
        return (await handleMailList(deps.mail)).instances;
      })()
    : [];
  let chatAddress: string | null = null;
  if (setsMailbox && typeof chat_mailbox === 'string') {
    const row = mailboxes.find((mailbox) => mailbox.slug === chat_mailbox);
    if (row === undefined) {
      throw new RpcError('not_found', `No connected mailbox is named "${chat_mailbox}".`, 404);
    }
    if (!row.send_capable) {
      throw new RpcError(
        'failed_precondition',
        `"${chat_mailbox}" cannot send mail, and chat answers are sent from the chat mailbox. `
          + 'Connect it with sending allowed, or pick another mailbox.',
        409,
      );
    }
    chatAddress = typeof row.account_email === 'string' ? row.account_email : null;
  }
  // One mailbox (§8.18): the chat mailbox may be one of the owner's own too, and
  // then its `ask:` filter stays on — every email they write to themselves
  // would otherwise start a conversation.
  const chatAfter = setsMailbox ? (chat_mailbox as string | null) : deps.store.get().chat_mailbox;
  const ownersAfter = setsOwners ? (owner_mailboxes as string[]) : deps.store.get().owner_mailboxes;
  if (setsPrefix && ask_prefix === null
    && isMailChatOneMailbox({ chat_mailbox: chatAfter, owner_mailboxes: ownersAfter })) {
    throw new RpcError(
      'failed_precondition',
      `"${chatAfter}" is the chat mailbox and one of your own, so a new conversation must start with the prefix: `
        + 'without it, every email you write to yourself would start one.',
      409,
    );
  }
  if (setsOwners) {
    for (const slug of owner_mailboxes as string[]) {
      if (!mailboxes.some((mailbox) => mailbox.slug === slug)) {
        throw new RpcError('not_found', `No connected mailbox is named "${slug}".`, 404);
      }
    }
  }
  if (enroll !== null) {
    const current = deps.store.get();
    if (current.chat_mailbox === null) {
      throw new RpcError(
        'failed_precondition',
        'Turn email chat on first: the email with the code goes to the chat mailbox.',
        409,
      );
    }
    if (enroll === bare(current.chat_address ?? mailboxes.find((row) => row.slug === current.chat_mailbox)?.account_email)) {
      throw new RpcError('failed_precondition', `${enroll} is the chat mailbox itself: add the address you write from.`, 409);
    }
    // A mailbox Recued reads proves an email is the owner's by its Sent folder,
    // the stronger proof, and is named under the owner's mailboxes.
    if (mailboxes.some((row) => bare(typeof row.account_email === 'string' ? row.account_email : '') === enroll)) {
      throw new RpcError(
        'failed_precondition',
        `Recued reads ${enroll}: name it as one of your mailboxes instead (turn email chat off and on again to `
          + 'change them).',
        409,
      );
    }
    if (!current.enrolled_senders.some((sender) => sender.address === enroll)
      && current.enrolled_senders.length >= MAIL_CHAT_ENROLLED_SENDERS_MAX) {
      throw new RpcError(
        'failed_precondition',
        `At most ${MAIL_CHAT_ENROLLED_SENDERS_MAX} addresses can be added: remove one first.`,
        409,
      );
    }
  }
  let settings = deps.store.get();
  const prefixBefore = settings.ask_prefix;
  // The owner's mailboxes before the chat mailbox, and the prefix last: a step
  // between them that read as one mailbox would turn the filter on (the store),
  // whatever the call ends with.
  if (setsOwners) settings = deps.store.setOwnerMailboxes(owner_mailboxes as string[]);
  if (setsMailbox) settings = deps.store.setChatMailbox(chat_mailbox as string | null, chatAddress);
  if (setsPrefix) settings = deps.store.setAskPrefix(ask_prefix as string | null);
  if (setsStale) settings = deps.store.setStaleAfterMinutes(stale_after_minutes as number);
  if (resumes) settings = deps.store.resume();
  if (unenrolls) settings = deps.store.unenrollSender(bare(patch.unenroll as string));
  if (enroll !== null) settings = deps.store.enrollSender(enroll);
  if (deps.auditLog) {
    try {
      await deps.auditLog.logActivity({
        activity_id: '',
        timestamp: Date.now(),
        action: 'mail_chat_door_set',
        target: 'mail_chat_door',
        // What this call changed, as it now stands.
        detail: JSON.stringify({
          ...(setsMailbox ? { chat_mailbox: settings.chat_mailbox } : {}),
          // Named, or turned back on by one mailbox.
          ...(setsPrefix || settings.ask_prefix !== prefixBefore ? { ask_prefix: settings.ask_prefix } : {}),
          ...(setsOwners ? { owner_mailboxes: settings.owner_mailboxes } : {}),
          ...(setsStale ? { stale_after_minutes: settings.stale_after_minutes } : {}),
          ...(resumes ? { resumed: true } : {}),
          // Never the code: it is the owner's to send.
          ...(unenrolls ? { unenrolled: bare(patch.unenroll as string) } : {}),
          ...(enroll !== null ? { enrolled: enroll } : {}),
        }),
      });
    } catch {
      // best-effort — the setting is saved; a failed audit write never undoes it
    }
  }
  return settings;
};

/** Step 7 — the checks before switching the door on (§4.12): for the mailboxes
 *  given, else the ones named. ⚠ Each of the owner's mailboxes is asked for a
 *  Message-ID no message has: one lookup at its provider. */
export const handleMailChatDoorCheck = async (
  deps: MailChatDoorHandlerDeps,
  args: unknown,
): Promise<MailChatDoorCheckResult> => {
  const given = args === undefined || args === null ? {} : args;
  if (typeof given !== 'object' || Array.isArray(given)) {
    throw new RpcError('bad_request', 'collection.mail.chat_door.check: expected { chat_mailbox?, owner_mailboxes? }', 400);
  }
  const patch = given as { chat_mailbox?: unknown; owner_mailboxes?: unknown };
  if (patch.chat_mailbox !== undefined && (typeof patch.chat_mailbox !== 'string' || patch.chat_mailbox === '')) {
    throw new RpcError('bad_request', 'collection.mail.chat_door.check: chat_mailbox must be a mailbox slug', 400);
  }
  if (patch.owner_mailboxes !== undefined && (!Array.isArray(patch.owner_mailboxes)
    || patch.owner_mailboxes.length > MAIL_CHAT_OWNER_MAILBOXES_MAX
    || !patch.owner_mailboxes.every((slug) => typeof slug === 'string' && slug !== ''))) {
    throw new RpcError(
      'bad_request',
      `collection.mail.chat_door.check: owner_mailboxes must be a list of up to ${MAIL_CHAT_OWNER_MAILBOXES_MAX} mailbox slugs`,
      400,
    );
  }
  const settings = deps.store.get();
  const chatSlug = (patch.chat_mailbox as string | undefined) ?? settings.chat_mailbox;
  const ownerSlugs = [...new Set((patch.owner_mailboxes as string[] | undefined) ?? settings.owner_mailboxes)];
  const listed = deps.mail === undefined ? [] : (await handleMailList(deps.mail)).instances;
  const running = deps.mailboxes?.().filter((mailbox) => mailbox.platform === 'mail') ?? [];
  const checks: MailChatDoorCheck[] = [];

  const connected = (slug: string) => listed.find((row) => row.slug === slug);
  /** A problem every mailbox shares: not connected, not signed in, not running. */
  const reachable = (kind: MailChatDoorCheck['kind'], slug: string): MailChatDoorCheck | null => {
    const row = connected(slug);
    if (row === undefined) return { kind, slug, status: 'fail', text: `No connected mailbox is named "${slug}".` };
    if (row.auth_state !== 'healthy') {
      return { kind, slug, status: 'unknown', text: 'Recued needs you to sign in to it again: reconnect it, then check again.' };
    }
    if (!running.some((mailbox) => mailbox.slug === slug)) {
      return { kind, slug, status: 'unknown', text: 'Recued is not connected to it right now. Check again in a minute.' };
    }
    return null;
  };

  if (chatSlug === null || chatSlug === undefined) {
    checks.push({ kind: 'chat_mailbox', slug: '', status: 'fail', text: 'Pick the mailbox Recued answers from.' });
  } else {
    const row = connected(chatSlug);
    const problem = reachable('chat_mailbox', chatSlug);
    if (problem !== null) checks.push(problem);
    else if (row?.send_capable !== true) {
      checks.push({
        kind: 'chat_mailbox', slug: chatSlug, status: 'fail',
        text: 'It cannot send mail, and Recued answers from it. Connect it with sending allowed.',
      });
    } else if (deps.mail?.instances.get('mail', chatSlug)?.backfill_complete !== true) {
      checks.push({
        kind: 'chat_mailbox', slug: chatSlug, status: 'unknown',
        text: 'Its first sync is still running, and an email that arrives before it ends is not answered. '
          + 'Check again in a few minutes.',
      });
    } else {
      checks.push({ kind: 'chat_mailbox', slug: chatSlug, status: 'pass', text: 'It can send, and its first sync is done.' });
    }
  }

  // Step 8 — none named is a door for addresses Recued does not read (proof
  // (b)): they are added once it is on, and the screen says no address can
  // write to it until then.
  const chatAddress = chatSlug ? bare(connected(chatSlug)?.account_email) : '';
  for (const slug of ownerSlugs) {
    // One mailbox (§8.18): the chat mailbox named as the owner's too is asked
    // for its Sent record like any of theirs — it is what proves an email they
    // wrote to themselves.
    const itself = slug === chatSlug;
    const problem = reachable('owner_mailbox', slug);
    if (problem !== null) {
      checks.push(problem);
      continue;
    }
    const address = bare(connected(slug)?.account_email);
    if (!itself && chatAddress !== '' && address === chatAddress) {
      checks.push({
        kind: 'owner_mailbox', slug, status: 'fail',
        text: 'It is the chat mailbox\'s own account, connected twice. To write to yourself, tick the chat mailbox '
          + 'itself instead.',
      });
      continue;
    }
    const mailbox = running.find((entry) => entry.slug === slug)!;
    let result: Awaited<ReturnType<typeof mailbox.lookupSentByMessageId>>;
    try {
      result = await mailbox.lookupSentByMessageId({ rfc_message_id: `recued-door-check-${randomUUID()}@invalid` });
    } catch {
      result = { status: 'unavailable', reason: 'provider_error' };
    }
    if (result.status === 'unavailable' && result.reason === 'unsupported') {
      checks.push({
        kind: 'owner_mailbox', slug, status: 'fail',
        text: 'Recued cannot look in its Sent folder, so it could never tell that an email is from you.',
      });
    } else if (result.status === 'unavailable') {
      checks.push({ kind: 'owner_mailbox', slug, status: 'unknown', text: 'Recued could not reach it just now. Check again.' });
    } else {
      checks.push({
        kind: 'owner_mailbox', slug, status: 'pass',
        text: itself
          ? 'Recued can look in its Sent folder, which is how it knows an email you write to yourself is yours.'
          : 'Recued can look in its Sent folder, which is how it knows an email to the chat mailbox is yours.',
      });
    }
  }
  return { checks, ready: checks.every((check) => check.status === 'pass') };
};

/** Step 7 — the latest requests, newest first, and how far each got. */
export const handleMailChatDoorRecent = (
  deps: MailChatDoorHandlerDeps,
): { readonly requests: readonly MailChatDoorRecentRequest[] } => {
  const chat = deps.store.get().chat_mailbox;
  if (chat === null || deps.requests === undefined) return { requests: [] };
  return {
    requests: deps.requests.recent(chat, MAIL_CHAT_RECENT_REQUESTS_MAX).map((request) => {
      const answer = deps.answers?.ofRequest(chat, request.rfc_message_id) ?? null;
      return {
        arrived_at: request.arrived_at,
        from: request.from_address,
        state: request.state,
        proof: request.proof,
        reason: request.reason,
        chat: request.admit_state,
        chat_reason: request.admit_reason,
        sender_auth: request.sender_auth,
        answer: answer?.state ?? null,
        answered_at: answer?.sent_at ?? null,
      };
    }),
  };
};
