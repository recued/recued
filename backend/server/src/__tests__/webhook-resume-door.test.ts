/** D-320 audit — the door a webhook run waiting for approval resumes under
 *  (`webhook-resume-door.ts`). Driven end to end, with the production gate, in
 *  `seller-refund-revoke-pushed-run.test.ts`; these pin each case of the rule. */

import type { ExecutionSource } from '@recued/contracts';
import { describe, expect, it } from 'vitest';

import { createWebhookResumeDoorResolver } from '../webhook-resume-door.js';

const NOW = 1_700_000_000_000;

const door = (contract_id: string, over: Record<string, unknown> = {}) => ({
  contract_id,
  grant_kind: 'standing',
  status: 'active',
  minted_at: NOW - 10,
  door_types: ['webhook'],
  scope: { channels: ['webhook'], actors: ['anonymous'], ingredient_ids: ['catalog-x'] },
  ...over,
});

const source = (contract_id?: string): ExecutionSource => ({
  channel: 'webhook',
  actor: 'anonymous',
  vendor: 'generic',
  webhook_secret_id: 'whi_1',
  ...(contract_id !== undefined ? { contract_id } : {}),
}) as ExecutionSource;

const resolver = (doors: Record<string, ReturnType<typeof door>>, currentDoor: string | null) =>
  createWebhookResumeDoorResolver({
    consumerStore: { currentDoorForRun: () => currentDoor },
    definitionStore: { get: (id: string) => (doors[id] ?? null) as never },
    now: () => NOW,
  });

describe('D-320 audit — the door a waiting webhook run resumes under', () => {
  it("resumes under the door that replaced its own, with that door's snapshot", () => {
    const next = resolver({ old: door('old', { revoked_at: NOW - 1 }), new: door('new') }, 'new')
      .successor('run-1', source('old'));
    expect(next?.execution_source).toMatchObject({ channel: 'webhook', contract_id: 'new' });
    expect(next?.contract_snapshot).toMatchObject({ contract_id: 'new', allowed_tools: ['catalog-x'] });
  });

  it('resumes as persisted while its own door is live', () => {
    expect(resolver({ old: door('old'), new: door('new') }, 'new').successor('run-1', source('old'))).toBeUndefined();
  });

  it("has no successor for an owner's revoke: the revoked door stays stamped (D-295)", () => {
    expect(resolver({ old: door('old', { revoked_at: NOW - 1 }) }, 'old').successor('run-1', source('old'))).toBeUndefined();
  });

  it('has none when the rows were unbound, or the run has no dispatch', () => {
    expect(resolver({ old: door('old', { revoked_at: NOW - 1 }) }, null).successor('run-1', source('old'))).toBeUndefined();
  });

  it('has none when the stamped door is not live, or not a webhook door', () => {
    const revokedNew = { old: door('old', { revoked_at: NOW - 1 }), new: door('new', { revoked_at: NOW - 1 }) };
    expect(resolver(revokedNew, 'new').successor('run-1', source('old'))).toBeUndefined();
    const reception = { old: door('old', { revoked_at: NOW - 1 }), new: door('new', { door_types: ['reception'] }) };
    expect(resolver(reception, 'new').successor('run-1', source('old'))).toBeUndefined();
  });

  it('leaves a door-less run, and any other channel, as they are', () => {
    const doors = { old: door('old', { revoked_at: NOW - 1 }), new: door('new') };
    expect(resolver(doors, 'new').successor('run-1', source())).toBeUndefined();
    const chat = { channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'u' } as ExecutionSource;
    expect(resolver(doors, 'new').successor('run-1', chat)).toBeUndefined();
  });
});
