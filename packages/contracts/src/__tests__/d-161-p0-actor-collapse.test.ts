/** D-161 Part A / P0 actor-collapse acceptance tests.
 *
 *  Pins the identity-only actor model, the contract_id-driven snapshot
 *  rule primitive, and the self-restricted policy narrowing fold at the
 *  contracts layer. Backend gate-level missing-snapshot throws are
 *  covered by backend/server/src/__tests__/d-153-phase-2c-policy-gate.test.ts.
 */

import { describe, expect, it } from 'vitest';

import {
  ACTORS,
  executionSourceContractId,
  executionSourceHasContract,
  isActor,
  isExecutionSource,
  renderActorLabel,
  type Actor,
  type ContractSnapshot,
  type ExecutionSource,
} from '../commits.js';
const actorExhaustiveness = {
  user_self: true,
  contracted_user: true,
  system: true,
  anonymous: true,
} satisfies Record<Actor, true>;

const unrestrictedUser: ExecutionSource = {
  channel: 'user',
  actor: 'user_self',
  user_id: 'user-1',
  client_token_id: 'client-token-1',
};

const presentUndefinedUser: ExecutionSource = {
  channel: 'user',
  actor: 'user_self',
  user_id: 'user-1',
  client_token_id: 'client-token-1',
  contract_id: undefined,
};

const selfRestrictedUser: ExecutionSource = {
  channel: 'user',
  actor: 'user_self',
  user_id: 'user-1',
  client_token_id: 'client-token-1',
  contract_id: 'self-contract-1',
};

const unrestrictedChat: ExecutionSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'chat-1',
  user_id: 'user-1',
};

const selfRestrictedChat: ExecutionSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'chat-1',
  user_id: 'user-1',
  contract_id: 'self-contract-1',
};

const contractedChat: ExecutionSource = {
  channel: 'chat',
  actor: 'contracted_user',
  chat_session_id: 'chat-1',
  user_id: 'user-1',
  contract_id: 'contract-1',
};

const contractedMcp: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'agent-1',
  tool_call_id: 'tool-call-1',
  mcp_token_id: 'mcp-token-1',
  contract_id: 'self-contract-1',
};

const systemSource: ExecutionSource = {
  channel: 'schedule',
  actor: 'system',
  cron: '0 9 * * 1-5',
  source_recipe: 'weekday-briefing',
};

const anonymousSource: ExecutionSource = {
  channel: 'reception',
  actor: 'anonymous',
  reception_id: 'reception-1',
};

describe('D-161 P0 / I-1 actor closed list', () => {
  it('pins ACTORS to exactly the four identity actors in order', () => {
    expect(ACTORS).toEqual([
      'user_self',
      'contracted_user',
      'system',
      'anonymous',
    ]);
    expect(actorExhaustiveness).toEqual({
      user_self: true,
      contracted_user: true,
      system: true,
      anonymous: true,
    });
  });

  it('rejects the retired mode/synonym/dead actor values', () => {
    expect(isActor('contracted_self')).toBe(false);
    expect(isActor('mini_self')).toBe(false);
    expect(isActor('agent')).toBe(false);
  });
});

describe('D-161 N.4 contract-presence helpers', () => {
  it('reads contract_id presence from the source, not the actor', () => {
    expect(executionSourceContractId(unrestrictedUser)).toBeUndefined();
    expect(executionSourceHasContract(unrestrictedUser)).toBe(false);

    expect(executionSourceContractId(selfRestrictedUser)).toBe('self-contract-1');
    expect(executionSourceHasContract(selfRestrictedUser)).toBe(true);

    expect(executionSourceContractId(contractedChat)).toBe('contract-1');
    expect(executionSourceHasContract(contractedChat)).toBe(true);

    expect(executionSourceContractId(systemSource)).toBeUndefined();
    expect(executionSourceHasContract(systemSource)).toBe(false);

    expect(executionSourceContractId(anonymousSource)).toBeUndefined();
    expect(executionSourceHasContract(anonymousSource)).toBe(false);
  });

  it('treats present-but-undefined contract_id as absent', () => {
    expect(executionSourceContractId(presentUndefinedUser)).toBeUndefined();
    expect(executionSourceHasContract(presentUndefinedUser)).toBe(false);
    expect(renderActorLabel(presentUndefinedUser)).toBe('user_self');
  });
});

describe('D-161 I-2 renderActorLabel derived label', () => {
  it('renders self-restricted only for user_self with a contract_id', () => {
    expect(renderActorLabel(unrestrictedUser)).toBe('user_self');
    expect(renderActorLabel(selfRestrictedUser)).toBe('self-restricted');
    expect(renderActorLabel(unrestrictedChat)).toBe('user_self');
    expect(renderActorLabel(selfRestrictedChat)).toBe('self-restricted');
    expect(renderActorLabel(contractedChat)).toBe('contracted_user');
    expect(renderActorLabel(systemSource)).toBe('system');
    expect(renderActorLabel(anonymousSource)).toBe('anonymous');
  });
});

describe('D-161 A.1 isExecutionSource actor-collapse shapes', () => {
  it('accepts unrestricted and self-restricted user_self on user and chat channels', () => {
    expect(isExecutionSource(unrestrictedUser)).toBe(true);
    expect(isExecutionSource(selfRestrictedUser)).toBe(true);
    expect(isExecutionSource(unrestrictedChat)).toBe(true);
    expect(isExecutionSource(selfRestrictedChat)).toBe(true);
  });

  it('rejects non-string contract_id values', () => {
    expect(isExecutionSource({
      channel: 'user',
      actor: 'user_self',
      user_id: 'user-1',
      client_token_id: 'client-token-1',
      contract_id: 42,
    })).toBe(false);
    expect(isExecutionSource({
      channel: 'chat',
      actor: 'user_self',
      chat_session_id: 'chat-1',
      user_id: 'user-1',
      contract_id: 42,
    })).toBe(false);
    expect(isExecutionSource({
      channel: 'mcp',
      actor: 'contracted_user',
      agent_id: 'agent-1',
      tool_call_id: 'tool-call-1',
      mcp_token_id: 'mcp-token-1',
      contract_id: 42,
    })).toBe(false);
  });

  it('requires contract_id on every contracted_user variant', () => {
    expect(isExecutionSource(contractedChat)).toBe(true);
    expect(isExecutionSource(contractedMcp)).toBe(true);
    expect(isExecutionSource({
      channel: 'messenger',
      actor: 'contracted_user',
      vendor: 'slack',
      from: 'U123',
      contract_id: 'contract-1',
    })).toBe(true);
    expect(isExecutionSource({
      channel: 'reception',
      actor: 'contracted_user',
      reception_id: 'reception-1',
      contract_id: 'contract-1',
    })).toBe(true);

    expect(isExecutionSource({
      channel: 'chat',
      actor: 'contracted_user',
      chat_session_id: 'chat-1',
      user_id: 'user-1',
    })).toBe(false);
    expect(isExecutionSource({
      channel: 'mcp',
      actor: 'contracted_user',
      agent_id: 'agent-1',
      tool_call_id: 'tool-call-1',
      mcp_token_id: 'mcp-token-1',
    })).toBe(false);
    expect(isExecutionSource({
      channel: 'messenger',
      actor: 'contracted_user',
      vendor: 'slack',
      from: 'U123',
    })).toBe(false);
    expect(isExecutionSource({
      channel: 'reception',
      actor: 'contracted_user',
      reception_id: 'reception-1',
    })).toBe(false);
  });
});

describe('D-161 I-3/N.4 snapshot-presence rule primitive', () => {
  const snapshotRequired = (source: ExecutionSource): boolean =>
    executionSourceHasContract(source);

  it('requires a contract_snapshot iff contract_id is set', () => {
    expect(snapshotRequired(unrestrictedUser)).toBe(false);
    expect(snapshotRequired(presentUndefinedUser)).toBe(false);
    expect(snapshotRequired(selfRestrictedUser)).toBe(true);
    expect(snapshotRequired(contractedChat)).toBe(true);
    expect(snapshotRequired(contractedMcp)).toBe(true);
    expect(snapshotRequired(systemSource)).toBe(false);
    expect(snapshotRequired(anonymousSource)).toBe(false);
  });
});

// D-161 I-4 (self-restricted policy narrowing) was pinned against the matrix
// merge (mergePolicyWithContract / evaluateToolAdmissibility); D-187 retired
// that path — approval is now op-risk x stage-trust (pinned in d-187-slice3/4).
