/** D-177 N.15 slice 1 (P7) — "Allow in this chat".
 *
 *  An answer on the owner's own attended ask: approve this write, and let the same KIND of write
 *  go without asking for the rest of this conversation, for an hour and up to 100 times (the owner,
 *  2026-11-09: "bounds can be 1 hour so batch writes are possible, suppose I have an event and want
 *  to update 20 attendees", then "100 is fine").
 *
 *  The answer mints a D-177 session grant (`grant_kind: 'session'`) with `grant_mode: 'kind'`: the
 *  conversation, the ingredient and its operation (a chat's own write: its D-329 rule key,
 *  `work.create:task`), the connection when the call has one, and the recipe's version when a
 *  recipe made the call. It pins no argument, which is the widening over "Allow this session".
 *
 *  The write is named as the system already names it (§N.15.6 ruling 3, the owner: *"I feel like
 *  you are trying to build a second route on an already built system"*): a chat's own write as
 *  D-341 names it (`describeTriggerPreapprovalTier1Op`, "Add a task"), a catalog op by its label
 *  (`opLabel`: a built-in op's title, else the first sentence of what the op says it does). No
 *  vocabulary of its own.
 *
 *  This module is the pure vocabulary: the answer's id, label and bounds, the offer a held call
 *  carries on its checkpoint (`PreflightCheckpointContext.kind_grant`, read defensively), and the
 *  sentence that says what the answer lets happen. */

import type { Actor, Channel } from './commits.js';
import type { SessionGrantPermits, SessionGrantView } from './contract-definition.js';

/** The answer's option id on an ask. */
export const KIND_GRANT_OPTION_ID = 'allow_kind';
/** The answer's label: what kind of yes it is, as D-341's "Always allow for this scheduled prompt"
 *  is; the sentence before the question says what it covers. */
export const KIND_GRANT_OPTION_LABEL = 'Allow in this chat';
/** How long the grant lasts: an hour (the owner: "bounds can be 1 hour so batch writes are
 *  possible"). */
export const KIND_GRANT_TTL_MS = 60 * 60 * 1000;
/** How many writes it lets through: 100, where every standing grant stops today (delegation
 *  rules, D-329's write rules, the unattended session cells). The owner: "100 is fine". */
export const KIND_GRANT_MAX_USES = 100;
/** The longest name an offer carries: a catalog op's label is the first sentence of what it says
 *  it does, written for an AI, and can run long. */
export const KIND_GRANT_NAME_MAX = 160;

/** What a held call's "Allow in this chat" would grant, as the hold read it. Present only on a
 *  held write the owner's own conversation made that the answer could cover; the answer grants
 *  exactly this. */
export interface KindGrantOffer {
  readonly channel: Channel;
  readonly actor: Actor;
  /** The conversation (`deriveChannelSessionId`): `chat:<id>`, or a messenger's chat. */
  readonly channel_session_id: string;
  /** The held call's ingredient: a catalog op's, or `TIER1_HOLD_CATALOG_SLUG` for a chat's own
   *  write. */
  readonly ingredient_slug: string;
  /** The kind: a catalog op's id, or a chat's own write's D-329 rule key (`work.create:task`). */
  readonly operation_id: string;
  /** The connection the call goes out on, when it has one. */
  readonly connection_name?: string;
  /** The recipe that made the call, at its version, when one did. */
  readonly recipe?: { readonly recipe_id: string; readonly recipe_hash: string };
  readonly risk_tier: 'write';
  /** The write in the owner's words, as the system already names it ("Add a task"). */
  readonly name: string;
  readonly ttl_ms: number;
  readonly max_uses: number;
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** A name as an offer carries it: one line, trimmed, and cut at a word with an ellipsis past
 *  {@link KIND_GRANT_NAME_MAX}. `undefined` for nothing to say. */
export const kindGrantName = (name: string | undefined): string | undefined => {
  const trimmed = name?.replace(/\s+/gu, ' ').trim();
  if (trimmed === undefined || trimmed === '') return undefined;
  if (trimmed.length <= KIND_GRANT_NAME_MAX) return trimmed;
  const cut = trimmed.slice(0, KIND_GRANT_NAME_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > KIND_GRANT_NAME_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/u, '')}…`;
};

/** The answer as an ask offers it. */
export const kindGrantOption = (): { id: typeof KIND_GRANT_OPTION_ID; label: string } => ({
  id: KIND_GRANT_OPTION_ID,
  label: KIND_GRANT_OPTION_LABEL,
});

/** Who decides the details of each write the answer lets through. */
export const KIND_GRANT_AI_DECIDES = 'Its AI decides each one: what it says, and who or what it is for.';

/** What the answer lets happen, said before the question, in D-341's words for its own answer
 *  ("“Always allow for this scheduled prompt” stops asking about this write …"). The owner,
 *  2026-11-10: the AI decides who or what each one is for too (an email's recipients, a record),
 *  said for every op rather than by naming one. */
export const describeKindGrantOffer = (offer: Pick<KindGrantOffer, 'name' | 'max_uses'>): string =>
  `“${KIND_GRANT_OPTION_LABEL}” stops asking about “${offer.name}” in this conversation, up to `
  + `${String(offer.max_uses)} times in the next hour. ${KIND_GRANT_AI_DECIDES} `
  + 'You can end it sooner under Active passes.';

/** The same answer in a message's plain words (Telegram, Slack, email), where the app's card is not
 *  (D-343, the owner 2026-11-14). It keeps what the owner ruled on 2026-11-10: the AI decides who
 *  or what each one is for. `kinds` is the switch's name for any number of its calls ("Change
 *  tasks", `tier1KindsPhrase`). */
export const describeKindGrantOfferPlainly = (offer: Pick<KindGrantOffer, 'max_uses'>, kinds: string): string =>
  // D-343 (the owner's day audit, 2026-11-15) — shorter: it repeated on every approval at twice the
  // length of what was asked. Keeps the 2026-11-10 ruling: the AI decides who or what each is for.
  `“${KIND_GRANT_OPTION_LABEL}” lets its AI ${kinds.charAt(0).toLowerCase()}${kinds.slice(1)} without asking for the next hour `
  + `(up to ${String(offer.max_uses)}), deciding what each is and who or what it is for. End it any time under Active passes.`;

/** The grant as its row is named under Active passes. */
export const kindGrantDisplayName = (name: string): string => `Allowed in this chat — ${name}`;

/** What an "Active passes" row shows of what a pass permits. A kind pass's title already says it in
 *  the owner's words ("Allowed in this chat — Add a task") and its op is an internal key
 *  (`work.create:task`), so it shows only the connection it names, if any. Every other mode shows
 *  every axis. */
export const shownPassPermits = (grant: Pick<SessionGrantView, 'grant_mode' | 'permits'>): SessionGrantPermits =>
  grant.grant_mode !== 'kind'
    ? grant.permits
    : grant.permits.connection_names !== undefined ? { connection_names: grant.permits.connection_names } : {};

/** The actions an "Active passes" row says a pass lets through: its operations, else its
 *  ingredients, by the names the server gave them ("Send mail"), where the lists printed the ids
 *  ("send-email"). A view from an older server, or one whose names do not line up with what it
 *  shows, keeps the ids. Empty for a kind pass (`shownPassPermits`) or one that names no action. */
export const passActionNames = (
  grant: Pick<SessionGrantView, 'grant_mode' | 'permits' | 'permit_names'>,
): ReadonlyArray<string> => {
  const shown = shownPassPermits(grant);
  const ids = (shown.operation_ids?.length ?? 0) > 0 ? shown.operation_ids! : shown.ingredient_ids ?? [];
  const names = grant.permit_names;
  return names !== undefined && names.length === ids.length && names.every(name => typeof name === 'string' && name.trim() !== '')
    ? names
    : ids;
};

const isChannel = (value: unknown): value is Channel =>
  value === 'chat' || value === 'messenger';

/** The offer as a checkpoint stored it, or `undefined` for anything this version cannot read. Only
 *  the owner's own attended conversations carry one (`chat` or `messenger`, `user_self`). */
export const readKindGrantOffer = (value: unknown): KindGrantOffer | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const offer = value as Record<string, unknown>;
  if (!isChannel(offer.channel) || offer.actor !== 'user_self') return undefined;
  if (!nonEmpty(offer.channel_session_id) || !nonEmpty(offer.ingredient_slug) || !nonEmpty(offer.operation_id)) {
    return undefined;
  }
  if (offer.connection_name !== undefined && !nonEmpty(offer.connection_name)) return undefined;
  const recipe = offer.recipe as Record<string, unknown> | undefined;
  if (recipe !== undefined && (recipe === null || typeof recipe !== 'object'
    || !nonEmpty(recipe.recipe_id) || !nonEmpty(recipe.recipe_hash))) return undefined;
  if (offer.risk_tier !== 'write') return undefined;
  if (!nonEmpty(offer.name) || offer.name.length > KIND_GRANT_NAME_MAX) return undefined;
  // Never wider than the ruled bounds, whatever a row says.
  if (typeof offer.ttl_ms !== 'number' || !Number.isInteger(offer.ttl_ms)
    || offer.ttl_ms < 1 || offer.ttl_ms > KIND_GRANT_TTL_MS) return undefined;
  if (typeof offer.max_uses !== 'number' || !Number.isInteger(offer.max_uses)
    || offer.max_uses < 1 || offer.max_uses > KIND_GRANT_MAX_USES) return undefined;
  return {
    channel: offer.channel,
    actor: 'user_self',
    channel_session_id: offer.channel_session_id,
    ingredient_slug: offer.ingredient_slug,
    operation_id: offer.operation_id,
    ...(offer.connection_name !== undefined ? { connection_name: offer.connection_name as string } : {}),
    ...(recipe !== undefined
      ? { recipe: { recipe_id: recipe.recipe_id as string, recipe_hash: recipe.recipe_hash as string } }
      : {}),
    risk_tier: 'write',
    name: offer.name,
    ttl_ms: offer.ttl_ms,
    max_uses: offer.max_uses,
  };
};
