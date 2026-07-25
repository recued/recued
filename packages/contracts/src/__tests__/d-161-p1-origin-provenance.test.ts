/** D-161 P1 — origin provenance facet helpers. */

import { describe, expect, it } from 'vitest';

import type { ExecutionSource } from '../commits.js';
import {
  isOriginProvenance,
  originProvenanceFromActor,
  originProvenanceFromOptionalSource,
  originProvenanceFromSource,
  SYSTEM_ORIGIN,
} from '../origin-provenance.js';
import type { StepMeta } from '../steps.js';

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const unrestrictedUserSource: ExecutionSource = {
  channel: 'user',
  actor: 'user_self',
  user_id: 'user-1',
  client_token_id: 'client-token-1',
};

const selfRestrictedUserSource: ExecutionSource = {
  channel: 'user',
  actor: 'user_self',
  user_id: 'user-1',
  client_token_id: 'client-token-1',
  contract_id: 'self-contract-1',
};

const contractedMcpSource: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'agent-1',
  tool_call_id: 'tool-call-1',
  mcp_token_id: 'mcp-token-1',
  contract_id: 'contract-1',
};

describe('originProvenanceFromSource', () => {
  it('maps a user_self user source with no contract_id without a contract key', () => {
    const origin = originProvenanceFromSource(unrestrictedUserSource);

    expect(origin).toEqual({ origin_actor: 'user_self' });
    expect(hasOwn(origin, 'origin_contract_id')).toBe(false);
  });

  it('maps a contracted_user mcp source with its contract_id', () => {
    expect(originProvenanceFromSource(contractedMcpSource)).toEqual({
      origin_actor: 'contracted_user',
      origin_contract_id: 'contract-1',
    });
  });

  it('includes origin_contract_id for a self-restricted user_self source', () => {
    expect(originProvenanceFromSource(selfRestrictedUserSource)).toEqual({
      origin_actor: 'user_self',
      origin_contract_id: 'self-contract-1',
    });
  });
});

describe('SYSTEM_ORIGIN', () => {
  it('is the frozen system default and cannot be mutated', () => {
    expect(SYSTEM_ORIGIN).toEqual({ origin_actor: 'system' });
    expect(Object.isFrozen(SYSTEM_ORIGIN)).toBe(true);

    try {
      (SYSTEM_ORIGIN as { origin_actor: string }).origin_actor = 'user_self';
    } catch (err) {
      expect(err).toBeInstanceOf(TypeError);
    }
    expect(SYSTEM_ORIGIN).toEqual({ origin_actor: 'system' });
  });
});

describe('originProvenanceFromOptionalSource', () => {
  it('returns SYSTEM_ORIGIN for an absent source', () => {
    expect(originProvenanceFromOptionalSource(undefined)).toBe(SYSTEM_ORIGIN);
  });

  it('matches originProvenanceFromSource for a present source', () => {
    expect(originProvenanceFromOptionalSource(contractedMcpSource)).toEqual(
      originProvenanceFromSource(contractedMcpSource),
    );
  });
});

describe('originProvenanceFromActor', () => {
  it('returns SYSTEM_ORIGIN for an absent actor', () => {
    expect(originProvenanceFromActor(undefined)).toBe(SYSTEM_ORIGIN);
  });

  it('attaches a contract_id when the actor pair carries one', () => {
    expect(originProvenanceFromActor('contracted_user', 'c1')).toEqual({
      origin_actor: 'contracted_user',
      origin_contract_id: 'c1',
    });
  });

  it('omits the contract key for a system actor without a contract_id', () => {
    const origin = originProvenanceFromActor('system');

    expect(origin).toEqual({ origin_actor: 'system' });
    expect(hasOwn(origin, 'origin_contract_id')).toBe(false);
  });
});

describe('isOriginProvenance', () => {
  it('accepts a valid origin without a contract_id', () => {
    expect(isOriginProvenance({ origin_actor: 'system' })).toBe(true);
  });

  it('accepts a valid origin with a contract_id', () => {
    expect(isOriginProvenance({
      origin_actor: 'contracted_user',
      origin_contract_id: 'c1',
    })).toBe(true);
  });

  it('rejects a missing origin_actor', () => {
    expect(isOriginProvenance({ origin_contract_id: 'c1' })).toBe(false);
  });

  it('rejects an invalid origin_actor', () => {
    expect(isOriginProvenance({ origin_actor: 'agent' })).toBe(false);
  });

  it('rejects a non-string origin_contract_id', () => {
    expect(isOriginProvenance({
      origin_actor: 'contracted_user',
      origin_contract_id: 42,
    })).toBe(false);
  });

  it('rejects null', () => {
    expect(isOriginProvenance(null)).toBe(false);
  });

  it('rejects arrays', () => {
    expect(isOriginProvenance([])).toBe(false);
  });
});

describe('StepMeta', () => {
  it('accepts D-161 actor and contract_id fields at construction time', () => {
    const meta = {
      step_id: 'step-1',
      actor: 'contracted_user',
      contract_id: 'c1',
    } satisfies StepMeta;

    expect(meta.actor).toBe('contracted_user');
    expect(meta.contract_id).toBe('c1');
  });
});
