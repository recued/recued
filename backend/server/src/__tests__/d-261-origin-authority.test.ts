import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { opGrantEntry } from '@recued/contracts';
import { createContractStore } from '../storage/contract-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createChatInboundTokenStore, ensureChatInboundTokenSchema } from '../storage/chat-inbound-token-store.js';
import { createClientTokenStore } from '../pairing/client-tokens.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { createOpAdmissionGate } from '../op-admission-gate.js';
import { createContractOverlayResolver } from '../policy-contract-overlay.js';
import { createApprovalResumeAuthorityResolver } from '../approval-resume-authority.js';
import { createPreapprovalOriginAuthority } from '../preapproval-origin-authority.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import type { ServerExecutorConfig } from '../server-executor.js';
import type { PreapprovalOrigin } from '../preapproval-model.js';
import { withContractDispatchReservation } from '../contract-dispatch-reservation.js';

const NOW = 1_800_000_000_000;
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const fixture = (maxUses?: number) => {
  const db = new Database(':memory:'); databases.push(db);
  const contracts = createContractStore(db, { now: () => NOW });
  const definitions = createContractDefinitionStore(contracts, { now: () => NOW });
  const grants = createContractGrantEntryStore(contracts);
  const gate = createOpAdmissionGate({ definitionStore: definitions, grantEntryStore: grants, now: () => NOW });
  const overlay = createContractOverlayResolver({ definitionStore: definitions, grantEntryStore: grants, now: () => NOW });
  ensureChatInboundTokenSchema(db);
  const inbound = createChatInboundTokenStore(db);
  const clients = createClientTokenStore(db, { argon2_params: { t: 1, m: 8, p: 1 } });
  const manifests = { get: (slug: string) => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null,
    slugs: () => KERNEL_MANIFESTS.map(m => m.slug) } as ServerExecutorConfig['manifests'];
  const authority = createPreapprovalOriginAuthority({ realm: 'realm', clientTokens: clients,
    opAdmissionGate: gate, connections: createConnectionStore(db),
    resumeAuthority: createApprovalResumeAuthorityResolver({ manifests, inboundTokenStore: inbound,
      clientTokens: clients, contractOverlay: overlay, opAdmissionGate: gate, now: () => NOW }) });
  const def = definitions.mint({ minted_by: 'owner', display_name: 'Assistant contract',
    ...(maxUses !== undefined ? { max_uses: maxUses } : {}),
    door_types: ['mcp'], scope: { channels: ['mcp'], actors: ['contracted_user'],
      operation_ids: ['core.preapproval.request', 'core.schedule.recipe'] } });
  for (const op of ['core.preapproval.request', 'core.schedule.recipe']) grants.set(def.contract_id, opGrantEntry(op), true, NOW);
  const issued = inbound.issueToken({ value: { label: 'Assistant', grants: {}, concurrency_tier: 3,
    chat_mode: null, contract_id: def.contract_id }, now: NOW });
  const origin: PreapprovalOrigin = { mode: 'contract', contract_id: def.contract_id, entry: 'kernel',
    credential_id: issued.record.token_id, credential_label: 'Assistant', entry_tool_grants: [],
    entry_raw_op_id: 'core.preapproval.request', recipe_grant_key: null, display_name: def.contract_id,
    source: { channel: 'mcp', actor: 'contracted_user', agent_id: 'agent', tool_call_id: 'call',
      mcp_token_id: issued.record.token_id, contract_id: def.contract_id } };
  return { db, authority, origin, inbound, clients, definitions, grants, overlay, gate };
};

describe('D-261 original authority from live stores', () => {
  it('credits only the reserved attempt while retaining live grants and hard revocation', async () => {
    const f = fixture(1);
    const reservation = f.overlay.reserveDispatchUse!(f.origin.source, 'preapproval-request')!;
    expect(f.definitions.get(f.origin.contract_id!)?.uses_remaining).toBe(0);
    expect(() => f.authority.resolve(f.origin)).toThrow(/exhausted/);
    expect(() => withContractDispatchReservation({}, () => f.authority.resolve(f.origin))).toThrow(/exhausted/);
    await withContractDispatchReservation(reservation, async () => {
      await Promise.resolve();
      expect(f.authority.resolve(f.origin).contract_snapshot?.contract_id).toBe(f.origin.contract_id);
      // A recheck can finish this attempt; it cannot reserve the next one.
      expect(() => f.overlay.reserveDispatchUse!(f.origin.source, 'preapproval-request')).toThrow(/remaining/);
      f.grants.set(f.origin.contract_id!, opGrantEntry('core.preapproval.request'), false, NOW);
      expect(() => f.authority.resolve(f.origin)).toThrow(/no longer grants/);
      f.grants.set(f.origin.contract_id!, opGrantEntry('core.preapproval.request'), true, NOW);
      f.definitions.revoke(f.origin.contract_id!, 'Owner stopped the attempt');
      expect(() => f.authority.resolve(f.origin)).toThrow(/inactive/);
    });
    expect(() => f.authority.resolve(f.origin)).toThrow();
  });
  it('admits a raw contract request without inventing an inbound checklist grant', () => {
    const f = fixture();
    expect(f.inbound.getTokenById(f.origin.credential_id!)?.grants).toEqual({});
    expect(f.authority.resolve(f.origin).contract_snapshot?.contract_id).toBe(f.origin.contract_id);
    expect(() => f.authority.validateActivationPermission(f.origin,
      { kind: 'one_shot', run_at: NOW + 60_000, time_zone: 'UTC' })).not.toThrow();
    f.grants.set(f.origin.contract_id!, opGrantEntry('core.schedule.recipe'), false, NOW);
    expect(() => f.authority.validateActivationPermission(f.origin,
      { kind: 'one_shot', run_at: NOW + 60_000, time_zone: 'UTC' })).toThrow(/scheduling/);
    f.grants.set(f.origin.contract_id!, opGrantEntry('core.preapproval.request'), false, NOW);
    expect(() => f.authority.resolve(f.origin)).toThrow(/no longer grants raw op/);
  });

  it.each(['revoke', 'rebind', 'delete'] as const)('refuses a %s of the original bearer', action => {
    const f = fixture(); const token_id = f.origin.credential_id!;
    expect(() => f.authority.resolve(f.origin)).not.toThrow();
    if (action === 'revoke') f.inbound.revokeToken({ token_id, now: NOW });
    else if (action === 'rebind') f.inbound.updateTokenContract({ token_id, contract_id: null, now: NOW });
    else f.inbound.deleteToken(token_id);
    expect(() => f.authority.resolve(f.origin)).toThrow();
  });

  it('owner interaction does not promote a revoked requester or make a CLI an owner decision surface', async () => {
    const f = fixture();
    const owner = await f.clients.issue({ client_kind: 'webclient', metadata: { instance_id: 'browser' } });
    const cli = await f.clients.issue({ client_kind: 'cli', metadata: { instance_id: 'cli' } });
    expect(() => f.authority.validateResponder({ channel: 'webclient', key: owner.token_id })).not.toThrow();
    expect(() => f.authority.validateResponder({ channel: 'webclient', key: cli.token_id })).toThrow();
    f.definitions.revoke(f.origin.contract_id!, 'Owner withdrew the contract');
    expect(() => f.authority.validateResponder({ channel: 'webclient', key: owner.token_id })).not.toThrow();
    expect(() => f.authority.resolve(f.origin)).toThrow();
  });
});
