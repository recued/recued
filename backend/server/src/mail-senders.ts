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
 *    - naming a mailbox that cannot send, or no mailbox at all → refused, the
 *      same way.
 *  Settled before the run, the value is part of its config like any other: the
 *  approval names it, the anchor records it, and a resume sends from it. */

import { RpcError, type RecipeDefinition } from '@recued/contracts';

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

/** The mailboxes that can send right now, by name, in registration order. The
 *  same test the send's readiness uses, so a mailbox offered here can send. */
export const sendCapableMailboxes = (
  registry: Pick<CollectionRegistry, 'get' | 'list'>,
): string[] =>
  registry.list()
    .filter((c) => c.platform === 'mail' && isLiveSendCapableMailInstance(registry, c.slug))
    .map((c) => c.slug);

/** A declared variable's label and default, whatever shape it was declared in. */
const declared = (recipe: RecipeDefinition, variable: string): { label?: unknown; default?: unknown } => {
  const hint: unknown = recipe.variables?.[variable];
  return hint !== null && typeof hint === 'object' ? hint as { label?: unknown; default?: unknown } : {};
};

const isEmpty = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/** The refusal: what is wrong, and the mailboxes that can send. The owner reads
 *  it on a run by hand, and Chat reads it to ask the owner, so it names the
 *  setting both ways and the mailboxes by the names a run takes. */
const refuse = (
  recipe: RecipeDefinition,
  variable: string,
  senders: readonly string[],
  named?: string,
): RpcError => {
  const { label } = declared(recipe, variable);
  const setting = typeof label === 'string' && label !== '' && label !== variable
    ? `"${label}" (${variable})` : `"${variable}"`;
  const problem = named !== undefined
    ? `${setting} is '${named}', which is not a mailbox on this server that can send.`
    : `${setting} is empty, and ${senders.length === 0 ? 'no mailbox' : `${senders.length} mailboxes`} on this server can send${senders.length === 0 ? '.' : `: ${senders.join(', ')}.`}`;
  const action = senders.length === 0
    ? named !== undefined
      ? ' No mailbox on this server can send; connect one that can under Connections → Mail.'
      : ' Connect one that can under Connections → Mail.'
    : named !== undefined
      ? ` Mailboxes that can send: ${senders.join(', ')}.`
      : ' Set it to one of them and run again.';
  return new RpcError(
    'mail_sender_required',
    `Recipe '${recipe.recipe_id}' cannot send: ${problem}${action}`,
    400,
    undefined,
    { variable, candidates: [...senders], ...(named !== undefined ? { named } : {}) },
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
  senders: readonly string[],
): Record<string, unknown> => {
  let out = config;
  for (const variable of settings) {
    const given = config[variable];
    if (!isEmpty(given)) {
      if (typeof given !== 'string') continue;
      if (senders.includes(given.trim())) continue;
      throw refuse(recipe, variable, senders, given.trim());
    }
    if (!isEmpty(declared(recipe, variable).default)) continue;
    if (senders.length !== 1) throw refuse(recipe, variable, senders);
    out = { ...out, [variable]: senders[0] };
  }
  return out;
};
