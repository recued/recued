/** Which mailbox an owner's run sends from when its "Send from" is empty.
 *
 *  ⛔ CHAT ASKED FOR A MAILBOX IT DID NOT NEED. With one mailbox that could
 *  send, Chat still asked "Which mail account should I send it from?" (live
 *  drive, 2026-10-10): the send's "Send from" had an empty default, nothing told
 *  the model which mailboxes exist, and an empty one fails the send only after
 *  the owner has approved it. The owner's rule: with one mailbox that can send
 *  there is nothing to ask.
 *
 *  So an owner's run (Chat, or a run by hand) settles each "Send from" setting
 *  (`mailSenderSettings`) before it starts:
 *    - empty, and exactly one mailbox can send → that mailbox;
 *    - empty, and none or several can → refused, naming the ones that can;
 *    - the address of exactly one mailbox that can send → that mailbox;
 *    - naming a mailbox that cannot send, or no mailbox at all → refused, the
 *      same way.
 *  Settled before the run, the value is part of its config like any other: the
 *  approval names it, the anchor records it, and a resume sends from it.
 *
 *  ⛔ A MAILBOX'S NAME IS NOT WHAT THE OWNER CALLS IT. Asked by email to "send an
 *  email from my Gmail", Chat answered "I have two mailboxes on this server that
 *  can send: `recueddev` and `outlook`. Which one is your Gmail?" (live,
 *  2026-10-18): the refusal listed names alone, and a name is whatever the
 *  mailbox was connected under. So it lists each with its address and provider,
 *  and an address given for "Send from" is taken as the mailbox that sends as
 *  it. */

import { RpcError, type ApprovalValueLabels, type RecipeDefinition } from '@recued/contracts';

import type { MailProviderKind } from './collections/mail/provider.js';
import type { CollectionRegistry } from './collections/registry.js';

/** D-196 Rev 16 Rule 7 — Seller readiness must resolve the currently registered
 *  mail collection, not trust a stored instance id or a stale enrollment row.
 *  Keep `sendCapable` and the executable `send` method in lockstep so a malformed
 *  collection cannot make Settings report outbound mail as ready. */
export const isLiveSendCapableMailInstance = (
  registry: Pick<CollectionRegistry, 'get'>,
  instanceId: string,
): boolean => {
  const collection = registry.get('mail', instanceId);
  return collection !== undefined
    && 'sendCapable' in collection
    && collection.sendCapable === true
    && 'send' in collection
    && typeof collection.send === 'function';
};

/** A mailbox that can send: the name a run takes, and what the owner knows it by. */
export interface SendCapableMailbox {
  readonly name: string;
  /** The address it sends as; '' when its provider has not said. */
  readonly address: string;
  /** 'Gmail', 'Outlook' or 'IMAP'; '' for a provider not listed here. */
  readonly provider: string;
}

/** The labels the compose dialog shows for a mailbox's provider. */
const PROVIDER_LABELS: Readonly<Record<MailProviderKind, string>> = {
  gmail: 'Gmail',
  graph: 'Outlook',
  imap: 'IMAP',
};

/** What the owner knows a mailbox by, read from the live collection: the
 *  address it signed in as and its provider, each '' when it does not say. */
export const mailboxAddressOf = (mailbox: object): { address: string; provider: string } => {
  const address = 'accountEmail' in mailbox && typeof mailbox.accountEmail === 'string'
    ? mailbox.accountEmail.trim() : '';
  const kind = 'provider' in mailbox && typeof mailbox.provider === 'object' && mailbox.provider !== null
    && 'kind' in mailbox.provider && typeof mailbox.provider.kind === 'string'
    ? mailbox.provider.kind : '';
  return {
    address,
    provider: Object.hasOwn(PROVIDER_LABELS, kind) ? PROVIDER_LABELS[kind as MailProviderKind] : '',
  };
};

/** The mailboxes that can send right now, in registration order. The same test
 *  the send's readiness uses, so a mailbox offered here can send. */
export const sendCapableMailboxes = (
  registry: Pick<CollectionRegistry, 'get' | 'list'>,
): SendCapableMailbox[] =>
  registry.list()
    .filter((c) => c.platform === 'mail' && isLiveSendCapableMailInstance(registry, c.slug))
    .map((c) => ({ name: c.slug, ...mailboxAddressOf(c) }));

/** "recueddev (recued.dev@gmail.com, Gmail)": the name a run takes, then what
 *  the owner knows the mailbox by. */
const listed = (senders: readonly SendCapableMailbox[]): string =>
  senders.map((s) => {
    const known = [s.address, s.provider].filter((part) => part !== '');
    return known.length === 0 ? s.name : `${s.name} (${known.join(', ')})`;
  }).join(', ');

/** Whether `value` is the address `sender` sends as. */
const sendsAs = (sender: SendCapableMailbox, value: string): boolean =>
  sender.address !== '' && sender.address.toLowerCase() === value.toLowerCase();

/** A declared variable's label and default, whatever shape it was declared in. */
const declared = (recipe: RecipeDefinition, variable: string): { label?: unknown; default?: unknown } => {
  const hint: unknown = recipe.variables?.[variable];
  return hint !== null && typeof hint === 'object' ? hint as { label?: unknown; default?: unknown } : {};
};

const isEmpty = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/** The refusal: what is wrong, and the mailboxes that can send. The owner reads
 *  it on a run by hand, and Chat reads it to ask the owner, so it names the
 *  setting both ways and each mailbox by the name a run takes and by what the
 *  owner knows it by. */
const refuse = (
  recipe: RecipeDefinition,
  variable: string,
  senders: readonly SendCapableMailbox[],
  named?: string,
): RpcError => {
  const { label } = declared(recipe, variable);
  const setting = typeof label === 'string' && label !== '' && label !== variable
    ? `"${label}" (${variable})` : `"${variable}"`;
  const problem = named === undefined
    ? `${setting} is empty, and ${senders.length === 0 ? 'no mailbox' : `${senders.length} mailboxes`} on this server can send${senders.length === 0 ? '.' : `: ${listed(senders)}.`}`
    : senders.filter((s) => sendsAs(s, named)).length > 1
      ? `${setting} is '${named}', the address of more than one mailbox on this server that can send.`
      : `${setting} is '${named}', which is not a mailbox on this server that can send.`;
  const action = senders.length === 0
    ? named !== undefined
      ? ' No mailbox on this server can send; connect one that can under Connections → Mail.'
      : ' Connect one that can under Connections → Mail.'
    : named !== undefined
      ? ` Mailboxes that can send: ${listed(senders)}.`
      : ' Set it to one of them and run again.';
  return new RpcError(
    'mail_sender_required',
    `Recipe '${recipe.recipe_id}' cannot send: ${problem}${action}`,
    400,
    undefined,
    { variable, candidates: senders.map((s) => s.name), ...(named !== undefined ? { named } : {}) },
  );
};

/** The run's config with each empty "Send from" filled, or the refusal thrown.
 *  Returns `config` itself when nothing changed.
 *
 *  ⚠ An empty value under a declared default that is NOT empty is left alone:
 *  the recipe's author chose that mailbox, and the run applies it as before.
 *  A value that is not text is not this function's to judge either. */
export const settleMailSenders = (
  recipe: RecipeDefinition,
  config: Record<string, unknown>,
  settings: ReadonlySet<string>,
  senders: readonly SendCapableMailbox[],
): Record<string, unknown> => {
  let out = config;
  for (const variable of settings) {
    const given = config[variable];
    if (!isEmpty(given)) {
      if (typeof given !== 'string') continue;
      const value = given.trim();
      if (senders.some((s) => s.name === value)) continue;
      // An address, as the refusal lists it or the owner types it: the one
      // mailbox that sends as it, by the name the send takes.
      const sending = senders.filter((s) => sendsAs(s, value));
      if (sending.length !== 1) throw refuse(recipe, variable, senders, value);
      out = { ...out, [variable]: sending[0]!.name };
      continue;
    }
    if (!isEmpty(declared(recipe, variable).default)) continue;
    if (senders.length !== 1) throw refuse(recipe, variable, senders);
    out = { ...out, [variable]: senders[0]!.name };
  }
  return out;
};

/** The argument a send takes its mailbox in. */
const SENDER_ARG = 'sender_mail_instance';

/** How an approval names the mailbox a held send goes from: by its address and
 *  provider (`recued.dev@gmail.com (Gmail)`), not by the name the call passes
 *  (`recueddev`). The owner, reading `sender_mail_instance: recueddev` on an
 *  approval: "can be email address as well".
 *
 *  Every sending mailbox is named, not only this call's: a batch's approval is
 *  rendered from one member's checkpoint, and another member may send from
 *  another mailbox. One whose address is unknown keeps its name. Undefined when
 *  no held call names a sender, or no mailbox has an address. */
export const heldSenderValueLabels = (
  held: readonly unknown[],
  listMailboxes: (() => readonly SendCapableMailbox[]) | undefined,
): ApprovalValueLabels | undefined => {
  if (listMailboxes === undefined) return undefined;
  const sends = held.some((args) => args !== null && typeof args === 'object'
    && typeof (args as Record<string, unknown>)[SENDER_ARG] === 'string');
  if (!sends) return undefined;
  let mailboxes: readonly SendCapableMailbox[];
  try {
    mailboxes = listMailboxes();
  } catch {
    // A label is never worth the hold.
    return undefined;
  }
  const named = mailboxes
    .filter((m) => m.address !== '')
    .map((m) => [m.name, m.provider !== '' ? `${m.address} (${m.provider})` : m.address] as const);
  return named.length > 0 ? { [SENDER_ARG]: Object.fromEntries(named) } : undefined;
};
