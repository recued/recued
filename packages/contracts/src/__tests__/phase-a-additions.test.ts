import { describe, expect, it } from 'vitest';

import {
  ERR,
  NS,
  SERVER_RPC_METHODS,
  SERVER_RPC_METHOD_SET,
  resolveRef,
  type Namespace,
  type NamespaceStores,
  type RecipeErrorCode,
  type ServerRpcRegistry,
} from '../index.js';

describe('Phase A namespace additions', () => {
  it('NS includes shared + data', () => {
    expect(NS.has('shared' as Namespace)).toBe(true);
    expect(NS.has('data' as Namespace)).toBe(true);
  });

  it('NamespaceStores type allows shared/data to be omitted', () => {
    // Type-only assertion: this compiles iff shared/data are optional.
    const partial: NamespaceStores = {
      vault: {},
      config: {},
      context: {},
      meta: {},
      step: {},
    };
    expect(partial).toBeDefined();
  });

  it('resolveRef walks tree-shaped shared.* refs', () => {
    // Engine Commit 5 wires the pre-fetch resolver; for now, the
    // contract-level resolver just walks nested objects. Flat-key
    // longest-match lookup is the pre-fetch resolver's job.
    const stores: NamespaceStores = {
      vault: {},
      config: {},
      context: {},
      meta: {},
      step: {},
      shared: { deal: { '123': { stage: 'closed_won' } } },
    };
    expect(resolveRef('{{shared.deal.123.stage}}', stores)).toBe('closed_won');
  });

  it('resolveRef walks tree-shaped data.shared.* refs', () => {
    const stores: NamespaceStores = {
      vault: {},
      config: {},
      context: {},
      meta: {},
      step: {},
      data: { shared: { deal: { '123': { value: 5000 } } } },
    };
    expect(resolveRef('{{data.shared.deal.123.value}}', stores)).toBe(5000);
  });

  it('resolveRef returns undefined when the shared store is absent', () => {
    const stores: NamespaceStores = {
      vault: {},
      config: {},
      context: {},
      meta: {},
      step: {},
    };
    expect(resolveRef('{{shared.whatever}}', stores)).toBeUndefined();
  });
});

describe('Phase A error codes', () => {
  const newCodes: RecipeErrorCode[] = [
    'STORAGE_PRESSURE',
    'QUOTA_EXCEEDED',
    'DATA_NAMESPACE_READONLY',
    'ACCOUNT_MISMATCH',
    'TIER_LIMIT_EXCEEDED',
    'SHARED_KEY_INVALID',
    'SERVER_NOT_REACHABLE',
    'VALUE_TOO_LARGE',
  ];

  for (const code of newCodes) {
    it(`ERR['${code}'] is declared with a severity`, () => {
      expect(ERR[code]).toMatch(/^(fatal|error|warn)$/);
    });
  }
});

describe('Phase A rpc methods', () => {
  const newMethods: (keyof ServerRpcRegistry)[] = [
    'shared.write',
    'shared.compare-and-set',
    'shared.read',
    'shared.list',
    'shared.search',
    'shared.delete',
    'shared.delete-prefix',
    'server.getBootstrap',
    'server.stageBootstrap',
    'server.requestRestart',
    'server.getStatus',
  ];

  for (const method of newMethods) {
    it(`SERVER_RPC_METHODS lists '${method}'`, () => {
      expect(SERVER_RPC_METHODS).toContain(method);
      expect(SERVER_RPC_METHOD_SET.has(method)).toBe(true);
    });
  }
});
