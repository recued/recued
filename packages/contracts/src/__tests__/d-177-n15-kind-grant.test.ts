/** D-177 N.15 — "Allow in this chat": the words, the offer as a checkpoint keeps it, and the
 *  matcher's `'kind'` arm (any arguments to one op, in one conversation, within its bounds).
 *
 *  §N.15.6 ruling 3 (2026-11-10): the answer names the write as the system already names it, so the
 *  offer carries one `name` ("Add a task", "Send an email") and the label is the same for every kind. */

import { describe, expect, it } from 'vitest';

import type { ContractDefinition } from '../contract-definition.js';
import {
  describeKindGrantOffer,
  KIND_GRANT_MAX_USES,
  KIND_GRANT_NAME_MAX,
  KIND_GRANT_TTL_MS,
  kindGrantDisplayName,
  kindGrantName,
  kindGrantOption,
  readKindGrantOffer,
  type KindGrantOffer,
} from '../kind-session-grant.js';
import { matchesDelegationRule, matchesSessionGrant, type SessionGrantMatchContext } from '../session-grant.js';

const NOW = 1_762_000_000_000;

describe('D-177 N.15 — the words', () => {
  it('one label for every kind, and the sentence names the write as the system does', () => {
    expect(kindGrantOption()).toEqual({ id: 'allow_kind', label: 'Allow in this chat' });
    expect(describeKindGrantOffer({ name: 'Add a task', max_uses: KIND_GRANT_MAX_USES })).toBe('“Allow in this chat”'
      + ' stops asking about “Add a task” in this conversation, up to 100 times in the next hour. Its AI decides each'
      + ' one: what it says, and who or what it is for. You can end it sooner under Active passes.');
    expect(kindGrantDisplayName('Send an email')).toBe('Allowed in this chat — Send an email');
  });

  it('a name is one trimmed line, cut at a word past the cap, and nothing for nothing to say', () => {
    expect(kindGrantName('  Update a\n deal  ')).toBe('Update a deal');
    expect(kindGrantName(undefined)).toBeUndefined();
    expect(kindGrantName(' \n ')).toBeUndefined();
    const long = `Update ${'the deal '.repeat(30)}now`;
    const cut = kindGrantName(long)!;
    expect(cut.length).toBeLessThanOrEqual(KIND_GRANT_NAME_MAX);
    // Cut where a word ends, with an ellipsis.
    expect(cut.endsWith('…')).toBe(true);
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
    expect(long[cut.length - 1]).toBe(' ');
    // One long word is cut where the cap falls.
    expect(kindGrantName('x'.repeat(400))!.length).toBe(KIND_GRANT_NAME_MAX);
  });
});

describe('D-177 N.15 — the offer, as a checkpoint keeps it', () => {
  const offer: KindGrantOffer = {
    channel: 'chat', actor: 'user_self', channel_session_id: 'chat:a', ingredient_slug: 'recued:tier1',
    operation_id: 'work.create:task', risk_tier: 'write', name: 'Add a task',
    ttl_ms: KIND_GRANT_TTL_MS, max_uses: KIND_GRANT_MAX_USES,
  };
  it('reads back as it was written, a recipe and a connection included', () => {
    expect(readKindGrantOffer(offer)).toEqual(offer);
    const recipe = { ...offer, ingredient_slug: 'recued-core.hubspot', operation_id: 'deal.update', connection_name: 'hubspot',
      recipe: { recipe_id: 'follow-up', recipe_hash: 'h1' } };
    expect(readKindGrantOffer(recipe)).toEqual(recipe);
  });
  it('anything wider than the ruled bounds, or not the owner\'s own attended chat, reads as none', () => {
    for (const bad of [
      { ...offer, ttl_ms: KIND_GRANT_TTL_MS + 1 }, { ...offer, max_uses: KIND_GRANT_MAX_USES + 1 }, { ...offer, max_uses: 0 },
      { ...offer, channel: 'schedule' }, { ...offer, channel: 'mcp' }, { ...offer, actor: 'system' },
      { ...offer, risk_tier: 'admin' }, { ...offer, operation_id: '' }, { ...offer, connection_name: '' },
      { ...offer, recipe: { recipe_id: 'r' } }, { ...offer, name: '' }, { ...offer, name: undefined },
      { ...offer, name: 'x'.repeat(KIND_GRANT_NAME_MAX + 1) }, { ...offer, words: { doing: 'adding tasks' }, name: undefined },
      null, 'offer', [],
    ]) {
      expect(readKindGrantOffer(bad)).toBeUndefined();
    }
  });
});

describe('D-177 N.15 — the matcher\'s kind arm', () => {
  const row = (over: Partial<ContractDefinition> = {}): ContractDefinition => ({
    contract_id: 'ct_1', minted_at: NOW - 1, minted_by: 'owner', display_name: 'Allowed in this chat — Add a task',
    scope: { channels: ['chat'], actors: ['user_self'], ingredient_ids: ['recued:tier1'], operation_ids: ['work.create:task'] },
    grant_kind: 'session', grant_mode: 'kind', channel_session_id: 'chat:a', risk_tier: 'write',
    approved_action_ref: 'run-1', expiry_at: NOW + KIND_GRANT_TTL_MS, max_uses: 100, uses_remaining: 100,
    ...over,
  } as ContractDefinition);
  const ctx = (over: Partial<SessionGrantMatchContext> = {}): SessionGrantMatchContext => ({
    channel: 'chat', actor: 'user_self', channel_session_id: 'chat:a', ingredient_slug: 'recued:tier1',
    operation_id: 'work.create:task', risk_tier: 'write', pre_lift_approval: 'ask',
    arg_shape_hash: 'shape-of-this-call', canonical_payload_hash: 'payload-of-this-call', ...over,
  });

  it('admits any arguments to its op, in its conversation, within its bounds', () => {
    expect(matchesSessionGrant(row(), ctx(), NOW)).toBe(true);
    expect(matchesSessionGrant(row(), ctx({ arg_shape_hash: 'another', canonical_payload_hash: 'another' }), NOW)).toBe(true);
    expect(matchesSessionGrant(row(), ctx({ arg_shape_hash: '', canonical_payload_hash: '' }), NOW)).toBe(true);
  });

  it('refuses another op, conversation, caller or tier, an always-ask, and a spent or expired grant', () => {
    expect(matchesSessionGrant(row(), ctx({ operation_id: 'calendar.create:local' }), NOW)).toBe(false);
    expect(matchesSessionGrant(row(), ctx({ operation_id: undefined }), NOW)).toBe(false);
    expect(matchesSessionGrant(row(), ctx({ channel_session_id: 'chat:b' }), NOW)).toBe(false);
    expect(matchesSessionGrant(row(), ctx({ channel: 'messenger' }), NOW)).toBe(false);
    expect(matchesSessionGrant(row(), ctx({ risk_tier: 'admin' }), NOW)).toBe(false);
    expect(matchesSessionGrant(row(), ctx({ pre_lift_approval: 'always' }), NOW)).toBe(false);
    expect(matchesSessionGrant(row({ uses_remaining: 0 }), ctx(), NOW)).toBe(false);
    expect(matchesSessionGrant(row(), ctx(), NOW + KIND_GRANT_TTL_MS + 1)).toBe(false);
    expect(matchesSessionGrant(row({ revoked_at: NOW - 1 } as never), ctx(), NOW)).toBe(false);
  });

  it('a row naming no op, as no mint writes one, matches nothing: an empty scope is any op everywhere else', () => {
    const scope = { channels: ['chat'], actors: ['user_self'], ingredient_ids: ['recued:tier1'] };
    expect(matchesSessionGrant(row({ scope }), ctx(), NOW)).toBe(false);
    expect(matchesSessionGrant(row({ scope: { ...scope, operation_ids: [] } }), ctx(), NOW)).toBe(false);
  });

  it('a row naming no recipe admits only a recipe-less call; one naming a recipe, only that recipe at that version', () => {
    expect(matchesSessionGrant(row(), ctx({ recipe_id: 'r', recipe_hash: 'v1' }), NOW)).toBe(false);
    const bound = row({ bound_recipe: { recipe_id: 'r', recipe_hash: 'v1' } });
    expect(matchesSessionGrant(bound, ctx({ recipe_id: 'r', recipe_hash: 'v1' }), NOW)).toBe(true);
    expect(matchesSessionGrant(bound, ctx({ recipe_id: 'r', recipe_hash: 'v2' }), NOW)).toBe(false);
    expect(matchesSessionGrant(bound, ctx(), NOW)).toBe(false);
  });

  it('an inline recipe carries the AI\'s own call: a row naming no recipe admits it, whatever its hash', () => {
    // A vendor-neutral op's one-step recipe holds its arguments, so its hash moves with every call.
    for (const recipe_hash of ['args-1', 'args-2']) {
      expect(matchesSessionGrant(row(), ctx({ recipe_id: 'canonical-deal-update', recipe_hash, recipe_inline: true }), NOW))
        .toBe(true);
    }
    // A row naming a recipe still admits only that recipe at that version.
    const bound = row({ bound_recipe: { recipe_id: 'r', recipe_hash: 'v1' } });
    expect(matchesSessionGrant(bound, ctx({ recipe_id: 'r', recipe_hash: 'v2', recipe_inline: true }), NOW)).toBe(false);
  });

  it('only the kind mode reads `recipe_inline`: an exact grant still pins its recipe', () => {
    const exact = row({
      grant_mode: 'exact', bound_recipe: { recipe_id: 'r', recipe_hash: 'v1' },
      arg_shape_hash: 'shape-of-this-call', canonical_payload_hash: 'payload-of-this-call',
    } as never);
    expect(matchesSessionGrant(exact, ctx({ recipe_id: 'r', recipe_hash: 'v1' }), NOW)).toBe(true);
    expect(matchesSessionGrant(exact, ctx({ recipe_id: 'r', recipe_hash: 'v2', recipe_inline: true }), NOW)).toBe(false);
    expect(matchesSessionGrant({ ...exact, bound_recipe: undefined } as never,
      ctx({ recipe_id: 'r', recipe_hash: 'v1', recipe_inline: true }), NOW)).toBe(false);
  });

  it('names its connection when the call has one: another connection, or a row naming none, refuses', () => {
    const scope = { channels: ['chat'], actors: ['user_self'], ingredient_ids: ['recued-core.hubspot'], operation_ids: ['deal.update'] };
    const call = ctx({ ingredient_slug: 'recued-core.hubspot', operation_id: 'deal.update', connection_name: 'hubspot' });
    expect(matchesSessionGrant(row({ scope: { ...scope, connection_names: ['hubspot'] } }), call, NOW)).toBe(true);
    expect(matchesSessionGrant(row({ scope: { ...scope, connection_names: ['hubspot'] } }),
      { ...call, connection_name: 'salesforce' }, NOW)).toBe(false);
    expect(matchesSessionGrant(row({ scope }), call, NOW)).toBe(false);
  });

  it('is never a standing rule: a delegation row in the kind mode matches nothing', () => {
    const rule = row({ grant_kind: 'delegation', channel_session_id: undefined } as never);
    expect(matchesDelegationRule(rule, ctx(), NOW)).toBe(false);
  });
});
