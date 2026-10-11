/** D-320 slice 2g (ruling 16) — where a pack's runs go when a connection leaves its
 *  list, in one sentence (`packs.connections.removal`).
 *
 *  Taking a connection off a list of two moves the pack's runs that name no connection
 *  to the other one, scheduled runs included; taking the default off a longer list
 *  leaves none, so they ask; taking the last one stops them, except that an
 *  connection of a registered vendor (HubSpot, Salesforce, Pipedrive, Exa) serves its
 *  packs on no list, so the owner's own runs go on there. The Access tab's Remove
 *  (about "This pack") and the Connections page's Delete (each pack by its name)
 *  say which, in the same words. */

import type { RpcResponse, ServerRpcRegistry } from '@recued/contracts';

/** One pack holding the connection, and what removing it does there. */
export type ConnectionRemovalEffect =
  RpcResponse<ServerRpcRegistry, 'packs.connections.removal'>['packs'][number];

/** The sentence for one pack. `subject` names it: its name by default, "This
 *  pack" where the page is the pack's own. A family is named once, its members
 *  counted. */
export const connectionRemovalSentence = (
  effect: ConnectionRemovalEffect,
  subject: string = effect.pack_name,
): string => {
  const n = effect.members.length;
  const who = n === 0
    ? subject
    : `${subject} and ${n} ${n === 1 ? 'pack that signs' : 'packs that sign'} in through it`;
  const their = n === 0 ? 'its' : 'their';
  const it = n === 0 ? 'it' : 'them';
  const has = n === 0 ? 'has' : 'have';
  switch (effect.outcome) {
    case 'moves':
      return `${who} will run on ${effect.after?.display_name ?? effect.after?.connection_name ?? 'another connection'} from now on.`;
    case 'no_default':
      return `${who} will have no default: ${their} runs ask which connection to use, and scheduled runs fail until you choose one.`;
    case 'no_list': {
      const fallback = effect.fallback ?? [];
      return fallback.length === 1
        ? `${who} will have no connection on ${their} list. Scheduled runs stop; your own runs use ${fallback[0]!.display_name}, which can still serve ${it}.`
        : `${who} will have no connection on ${their} list. Scheduled runs stop; your own runs use a connection that can still serve ${it}, asking when several can.`;
    }
    case 'stops':
      return `${who} will have no connection left: ${their} runs stop until you add one.`;
    case 'unchanged':
      if (effect.after !== undefined) return `${who} will keep running on ${effect.after.display_name}.`;
      return effect.remaining.length >= 2
        ? `${who} still ${has} no default: ${their} runs ask which connection to use.`
        : `${who} ${has} no connection set up.`;
  }
};

/** The packs whose runs change, for a dialog that names only changes. */
export const connectionRemovalChanges = (
  effects: readonly ConnectionRemovalEffect[],
): ConnectionRemovalEffect[] => effects.filter((effect) => effect.outcome !== 'unchanged');

/** D-320 audit — one installed recipe whose sign-in spans two or more packs' lists
 *  (a family with no core pack keeps a list per pack). It runs only on a connection on
 *  all of them, so its answer can differ from its packs': a pack's runs move while
 *  this recipe's stop. */
export type ConnectionRemovalRecipeEffect = NonNullable<
  RpcResponse<ServerRpcRegistry, 'packs.connections.removal'>['recipes']
>[number];

/** The sentence for one recipe reading several packs' lists. */
export const connectionRemovalRecipeSentence = (effect: ConnectionRemovalRecipeEffect): string => {
  const names = effect.packs.map((pack) => pack.pack_name);
  const two = names.length === 2;
  const lists = two
    ? `both ${names[0]}'s and ${names[1]}'s lists`
    : `the lists of ${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  const onAll = two ? 'on both' : 'on all of them';
  const name = effect.recipe_name;
  switch (effect.outcome) {
    case 'moves':
      return `${name} reads ${lists}, and will run on ${effect.after?.display_name ?? 'another connection'}, the connection ${onAll}, from now on.`;
    case 'no_default':
      return `${name} reads ${lists}, and no connection ${onAll} will be its default: scheduled runs fail until you choose one.`;
    case 'no_list':
    case 'stops':
      return `${name} reads ${lists}, and no connection will be ${onAll}: its runs stop until one is.`;
    case 'unchanged':
      if (effect.after !== undefined) return `${name} will keep running on ${effect.after.display_name}.`;
      return effect.remaining.length >= 2
        ? `${name} reads ${lists}, and still has no default ${onAll}.`
        : `${name} reads ${lists}, and has no connection ${onAll}.`;
  }
};

/** The recipes whose runs change, for a dialog that names only changes. A server
 *  before the audit sends none. */
export const connectionRemovalRecipeChanges = (
  effects: readonly ConnectionRemovalRecipeEffect[] | undefined,
): ConnectionRemovalRecipeEffect[] => (effects ?? []).filter((effect) => effect.outcome !== 'unchanged');
