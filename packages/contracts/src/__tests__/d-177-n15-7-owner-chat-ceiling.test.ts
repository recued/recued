/** D-177 §N.15.7 — the foundation: in the owner's own chat every op follows its own approval.
 *
 *  The owner: *"that lays the foundation of the approval system unformly, and
 *  automation/learner+grant/pre-approval function on top of this foundation"*. The owner's chat
 *  and messenger chat take the `read` ceiling, as automation does, so an `ask` op asks there; what
 *  the owner runs from the app keeps `admin`. And, ruled the same day, *"Their author's never"*: an
 *  op whose author set `never`, which the risk floor raises to `ask` (D-209 §1.3), runs in the
 *  owner's chat as authored; the floor keeps holding it for a door, an AI app and the owner's
 *  unattended automation. */

import { describe, expect, it } from 'vitest';

import {
  OWNER_CHAT_TRUST_CEILING,
  honorsAuthoredNever,
  resolveCatalogOperationPolicy,
  resolveTrustCeiling,
  type ExecutionSource,
  type OperationSpec,
} from '../index.js';

const CHAT = { channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'u' } as ExecutionSource;
const MESSENGER = { channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' } as ExecutionSource;
const APP = { channel: 'user', actor: 'user_self', user_id: 'u', client_token_id: 't' } as ExecutionSource;
const SCHEDULE = { channel: 'schedule', actor: 'system', cron: '0 9 * * *', source_recipe: 'r' } as ExecutionSource;
const HOUSEHOLD_CHAT = { ...CHAT, contract_id: 'ct-household' } as ExecutionSource;
const APP_AI = { channel: 'mcp', actor: 'contracted_user', contract_id: 'ct-app', mcp_token_id: 'tok' } as unknown as ExecutionSource;

const OPS: Record<string, OperationSpec> = {
  // A converter its author set to never ask.
  'document.to_markdown': { operation_id: 'pack.document.to_markdown', risk_tier: 'write', approval: 'never' },
  'deal.update': { operation_id: 'pack.deal.update', risk_tier: 'write', approval: 'ask' },
  'deal.close': { operation_id: 'pack.deal.close', risk_tier: 'write', approval: 'always' },
  'note.remove': { operation_id: 'pack.note.remove', risk_tier: 'destructive', approval: 'never' },
  'deal.read': { operation_id: 'pack.deal.read', risk_tier: 'read', approval: 'never' },
} as unknown as Record<string, OperationSpec>;

const resolve = (operation: string, source: ExecutionSource, extra: Record<string, unknown> = {}) =>
  resolveCatalogOperationPolicy({
    operations: OPS,
    operation_id: operation,
    profile: { catalog_slug: 'pack', allowed_operations: Object.keys(OPS), ...extra },
    catalog_slug: 'pack',
    ceiling: resolveTrustCeiling(source),
    ...(honorsAuthoredNever(source) ? { honor_authored_never: true } : {}),
  } as never);

describe('D-177 §N.15.7 — the owner\'s chat takes the automation ceiling; the app keeps the owner\'s', () => {
  it('chat and messenger resolve `read`; the app `admin`; a contracted chat and an AI app `read`', () => {
    expect(OWNER_CHAT_TRUST_CEILING).toBe('read');
    for (const source of [CHAT, MESSENGER, SCHEDULE, HOUSEHOLD_CHAT, APP_AI]) expect(resolveTrustCeiling(source)).toBe('read');
    expect(resolveTrustCeiling(APP)).toBe('admin');
  });

  it('honors an author\'s never only in the owner\'s own chat or messenger chat', () => {
    expect(honorsAuthoredNever(CHAT)).toBe(true);
    expect(honorsAuthoredNever(MESSENGER)).toBe(true);
    for (const source of [APP, SCHEDULE, HOUSEHOLD_CHAT, APP_AI]) expect(honorsAuthoredNever(source)).toBe(false);
  });
});

describe('D-177 §N.15.7 — "Their author\'s never"', () => {
  it('runs in the owner\'s chat as authored; the floor holds it for automation, a household chat and an AI app', () => {
    for (const source of [CHAT, MESSENGER]) {
      expect(resolve('document.to_markdown', source)).toMatchObject({
        verdict: 'admit', approval: 'never', authorization_provenance: { pre_lift_approval: 'never' },
      });
    }
    for (const source of [SCHEDULE, HOUSEHOLD_CHAT, APP_AI]) {
      expect(resolve('document.to_markdown', source)).toMatchObject({ verdict: 'ask', approval: 'ask' });
    }
    // From the app the owner's ceiling relaxes it, as it relaxes every ask.
    expect(resolve('document.to_markdown', APP).verdict).toBe('admit');
  });

  it('an ask asks in the chat and runs from the app; always asks everywhere; a read runs everywhere', () => {
    expect(resolve('deal.update', CHAT)).toMatchObject({ verdict: 'ask', authorization_provenance: { pre_lift_approval: 'ask' } });
    expect(resolve('deal.update', APP).verdict).toBe('admit');
    for (const source of [CHAT, APP]) expect(resolve('deal.close', source)).toMatchObject({ verdict: 'ask', approval: 'always' });
    for (const source of [CHAT, APP, SCHEDULE]) expect(resolve('deal.read', source).verdict).toBe('admit');
  });

  it('never above the floor: a destructive op its author set to never still asks every time', () => {
    for (const source of [CHAT, APP]) expect(resolve('note.remove', source)).toMatchObject({ verdict: 'ask', approval: 'always' });
  });

  it('the owner\'s own setting wins over the author\'s: overridden to ask, it asks in the chat', () => {
    const withOwner = (operation: string, approval: 'ask' | 'never') => resolveCatalogOperationPolicy({
      operations: OPS, operation_id: operation,
      profile: { catalog_slug: 'pack', allowed_operations: Object.keys(OPS) }, catalog_slug: 'pack',
      ceiling: resolveTrustCeiling(CHAT), honor_authored_never: true, owner_override: { approval },
    } as never);
    // The author said never; the owner said ask.
    expect(withOwner('document.to_markdown', 'ask')).toMatchObject({ verdict: 'ask', approval: 'ask' });
    // Never an owner's own below-floor value: a hand-stored never is held at the floor.
    expect(withOwner('document.to_markdown', 'never')).toMatchObject({ verdict: 'ask', approval: 'ask', approval_clamped_from: 'never' });
    expect(withOwner('deal.update', 'never')).toMatchObject({ verdict: 'ask', approval: 'ask', approval_clamped_from: 'never' });
  });

  it('a connection\'s own escalation still wins over it (owner-tighten runs last)', () => {
    expect(resolve('document.to_markdown', CHAT, { approval_defaults: { 'document.to_markdown': 'always' } }))
      .toMatchObject({ verdict: 'ask', approval: 'always' });
  });
});
