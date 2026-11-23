/** D-177 N.15 — "Allow in this chat".
 *
 *  A held write the owner's own attended conversation made carries the offer: its ask (and, for a
 *  chat's own write, its card in the chat) offers "Allow in this chat", and the answer mints a
 *  `'kind'` session grant for that conversation (`SessionGrantResolver.mintKind`). The next write of
 *  the same kind in that conversation, within the hour and its uses, goes without asking.
 *
 *  - A chat's own write (D-329's Tier-1 tools: `work.create`, `calendar.create`, `contact.write`, …;
 *    `tier1KindGrantOffer`, slice 1): the kind and its name are the ones D-341's pre-approval already
 *    gives the same write (`triggerPreapprovalTier1Op`: `work.create:task`;
 *    `describeTriggerPreapprovalTier1Op`: "Add a task"), so a save the owner is asked about every
 *    time, which neither names, gets no offer. Spent at the chat's gate (`useTier1KindGrant`).
 *  - A gateway hold (`gatewayKindGrantOffer`, §N.15.6 1b): a recipe's step, the AI's direct op, a
 *    vendor-neutral op. The kind is the op as its gate names it, on its connection; the name is the
 *    op's own (`heldCallOpLabel`). Spent at that gate, by the session-grant lookup every grant uses.
 *
 *  Who may be offered it is D-329's own owner's chat (`writeRulePrincipalOf`). */

import {
  describeKindGrantOffer,
  describeTriggerPreapprovalTier1Op,
  KIND_GRANT_MAX_USES,
  KIND_GRANT_OPTION_LABEL,
  KIND_GRANT_TTL_MS,
  kindGrantName,
  TIER1_HOLD_CATALOG_SLUG,
  triggerPreapprovalTier1Op,
  writeRulePrincipalOf,
  type ExecutionSource,
  type KindGrantOffer,
} from '@recued/contracts';
import { deriveChannelSessionId } from '@recued/gateway';

import type { SessionGrantResolver } from './session-grant-resolver.js';

/** What a held write of a chat's own the owner's own attended conversation made would grant, or
 *  `undefined` when the answer cannot be offered: another channel or caller (a scheduled run, an AI
 *  app, a chat under a contract), or a write D-341 cannot name (an unknown tool, a call that says too
 *  little, a save asked about every time). */
export const tier1KindGrantOffer = (
  source: ExecutionSource,
  tool: string,
  args: unknown,
): KindGrantOffer | undefined => {
  if (source.channel !== 'chat' && source.channel !== 'messenger') return undefined;
  if (writeRulePrincipalOf(source)?.kind !== 'owner_chat') return undefined;
  // D-343 (the owner's day audit, 2026-11-15) — a day is recorded once: "record your day without
  // asking, up to 100 times in the next hour" offered nothing an owner could want.
  if (tool === 'episode.record') return undefined;
  const operation_id = triggerPreapprovalTier1Op(tool, args);
  if (operation_id === undefined) return undefined;
  const described = describeTriggerPreapprovalTier1Op(operation_id);
  // It falls back to the op's own key when it has no name for it: no offer then.
  const name = described === operation_id ? undefined : kindGrantName(described);
  if (name === undefined) return undefined;
  return {
    channel: source.channel,
    actor: 'user_self',
    channel_session_id: deriveChannelSessionId(source),
    ingredient_slug: TIER1_HOLD_CATALOG_SLUG,
    operation_id,
    risk_tier: 'write',
    name,
    ttl_ms: KIND_GRANT_TTL_MS,
    max_uses: KIND_GRANT_MAX_USES,
  };
};

/** D-177 N.15 (§N.15.6 1b) — what a held gateway call's "Allow in this chat" would grant, or
 *  `undefined` when the answer cannot be offered. Offered where the gate could match it again: a call
 *  the owner's own conversation made; one call, not a fan-out's cover; a write held by its own
 *  approval (an `ask`, or a `never` held at the risk floor), with no review the owner gives each time
 *  and no request count to review; and a name the owner reads (`name`, `heldCallOpLabel`). The kind
 *  is the op as its gate names it (a catalog op by its declared id, a single-op ingredient by its
 *  slug, as D-211 and D-341 name them), on the connection the call goes out on. A stored recipe that
 *  made the call is bound at its version (§N.15.4 Q3); an inline one (a vendor-neutral op, the AI's
 *  direct op, a recipe the AI wrote) carries the AI's own call, and binds none. */
export const gatewayKindGrantOffer = (held: {
  readonly source: ExecutionSource | undefined;
  /** The run's conversation, as its gates match a grant against it. */
  readonly channel_session_id: string | undefined;
  readonly ingredient_slug: string | undefined;
  /** A catalog op's declared id, as its gate resolved it; absent for a single-op ingredient. */
  readonly operation_id?: string;
  readonly connection_name?: string;
  readonly risk_tier: string | undefined;
  readonly provenance: { readonly pre_lift_approval?: string; readonly lift_reason?: string } | undefined;
  /** False for a held fan-out, whose one approval covers many calls. */
  readonly single: boolean;
  /** A request bound the owner reviews before approving (D-217): never waived for an hour. */
  readonly resource_review: boolean;
  /** The stored recipe that made the call, at its version. */
  readonly recipe?: { readonly recipe_id: string; readonly recipe_hash: string };
  readonly name: string | undefined;
}): KindGrantOffer | undefined => {
  const { source, provenance } = held;
  if (source === undefined || (source.channel !== 'chat' && source.channel !== 'messenger')) return undefined;
  if (writeRulePrincipalOf(source)?.kind !== 'owner_chat') return undefined;
  if (held.channel_session_id === undefined || held.ingredient_slug === undefined) return undefined;
  if (!held.single || held.resource_review || held.risk_tier !== 'write') return undefined;
  if (provenance === undefined || provenance.lift_reason !== undefined) return undefined;
  if (provenance.pre_lift_approval !== 'ask' && provenance.pre_lift_approval !== 'never') return undefined;
  const name = kindGrantName(held.name);
  if (name === undefined) return undefined;
  return {
    channel: source.channel,
    actor: 'user_self',
    channel_session_id: held.channel_session_id,
    ingredient_slug: held.ingredient_slug,
    operation_id: held.operation_id ?? held.ingredient_slug,
    // An empty connection is none, as the gates read it.
    ...(held.connection_name ? { connection_name: held.connection_name } : {}),
    ...(held.recipe !== undefined ? { recipe: held.recipe } : {}),
    risk_tier: 'write',
    name,
    ttl_ms: KIND_GRANT_TTL_MS,
    max_uses: KIND_GRANT_MAX_USES,
  };
};

/** The answer a held write's card offers beside "Say yes, once", as its ask offers it: the label
 *  ("Allow in this chat") and what it lets happen. `undefined` when the ask offers none: no offer, or
 *  no resolver to mint it (`holdTier1Call` offers it under the same conditions). */
export const tier1KindGrantHoldAnswer = (
  resolver: SessionGrantResolver | undefined,
  source: ExecutionSource,
  tool: string,
  args: unknown,
): { readonly label: string; readonly note: string } | undefined => {
  if (resolver === undefined) return undefined;
  const offer = tier1KindGrantOffer(source, tool, args);
  return offer === undefined ? undefined : { label: KIND_GRANT_OPTION_LABEL, note: describeKindGrantOffer(offer) };
};

/** Spend one use of the kind grant that stands in for this held write's ask, if one does: a live
 *  `'kind'` grant of this conversation for this write's kind. `undefined` otherwise, and on any
 *  failure (unknown is "ask"). */
export const useTier1KindGrant = (
  resolver: SessionGrantResolver | undefined,
  source: ExecutionSource,
  tool: string,
  args: unknown,
): { readonly rule_id: string; readonly uses_remaining: number } | undefined => {
  if (resolver === undefined) return undefined;
  const offer = tier1KindGrantOffer(source, tool, args);
  if (offer === undefined) return undefined;
  try {
    const contract_id = resolver.match({
      channel: offer.channel,
      actor: offer.actor,
      channel_session_id: offer.channel_session_id,
      ingredient_slug: offer.ingredient_slug,
      operation_id: offer.operation_id,
      risk_tier: 'write',
      // A chat's own write asks by D-329's rule, never by an "ask every time" ruling (those are
      // refused above), so it is an `ask`.
      pre_lift_approval: 'ask',
      // A `'kind'` grant pins no argument: no hashes are compared, and every other mode, which
      // needs them, cannot match a call that names none.
      arg_shape_hash: '',
      canonical_payload_hash: '',
    });
    if (contract_id === null) return undefined;
    if (!resolver.consume(contract_id, { operation_id: offer.operation_id })) return undefined;
    return { rule_id: contract_id, uses_remaining: resolver.usesRemaining?.(contract_id) ?? 0 };
  } catch (error) {
    console.warn(`[kind-grants] the grant for '${tool}' could not be read: `
      + (error instanceof Error ? error.message : String(error)));
    return undefined;
  }
};
