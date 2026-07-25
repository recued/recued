/** D-174 #22 — contracts surface tests for the Data-route pair-RPCs.
 *
 *  Covers:
 *    - `work_entity.{list,get,upsert,delete}` + `data.timeline` are
 *      registered in `SERVER_RPC_METHODS` + `SERVER_RPC_METHOD_SET`,
 *    - the channel decision: every new method is EXCLUDED from the MCP
 *      tool catalog (the rpc-name can never bridge onto the closed
 *      `recued_*` allowlist), and the `work_entity.` / `data.` namespaces
 *      mirror the base `contact.*` treatment — NOT in
 *      `MCP_RESERVED_RPC_PREFIXES` (the base CRUD families aren't either;
 *      the reserved list guards the sensitive sub-namespaces only),
 *    - the upsert request union accepts create (no id) + update (id) per
 *      kind — a compile-time shape check.
 */

import { describe, expect, it } from 'vitest';

import {
  SERVER_RPC_METHODS,
  SERVER_RPC_METHOD_SET,
  MCP_RESERVED_RPC_PREFIXES,
  isMcpToolName,
  type WorkEntityUpsertRpcRequest,
  type WorkEntityListRpcRequest,
  type WorkEntityDeleteRpcRequest,
} from '../index.js';

const D174_METHODS = [
  'work_entity.list',
  'work_entity.get',
  'work_entity.upsert',
  'work_entity.delete',
  'data.timeline',
] as const;

describe('D-174 #22 — rpc method registration', () => {
  it('every method appears in SERVER_RPC_METHODS', () => {
    for (const m of D174_METHODS) {
      expect(SERVER_RPC_METHODS).toContain(m);
    }
  });

  it('every method is in the O(1) lookup set', () => {
    for (const m of D174_METHODS) {
      expect(SERVER_RPC_METHOD_SET.has(m)).toBe(true);
    }
  });

  it('no duplicate method names in the registry tuple', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const m of SERVER_RPC_METHODS) {
      if (seen.has(m)) dupes.push(m);
      seen.add(m);
    }
    expect(dupes).toEqual([]);
  });
});

describe('D-174 #22 — channel decision (MCP isolation)', () => {
  it('no method is published as an MCP tool (closed recued_* catalog)', () => {
    for (const m of D174_METHODS) {
      expect(isMcpToolName(m)).toBe(false);
    }
  });

  it('work_entity. / data. mirror the base contact.* treatment — NOT reserved', () => {
    // The base contact CRUD (`contact.upsert` etc.) is NOT in the
    // reserved-prefix list; only sensitive sub-namespaces
    // (`contact.merge.` / `contact.alias.` / `contact.identity.`) are.
    // The new families follow the same model: gating is structural
    // (separate WS channel + closed MCP catalog), not via the ratchet.
    for (const prefix of MCP_RESERVED_RPC_PREFIXES) {
      expect('work_entity.list'.startsWith(prefix)).toBe(false);
      expect('work_entity.upsert'.startsWith(prefix)).toBe(false);
      expect('work_entity.delete'.startsWith(prefix)).toBe(false);
      expect('data.timeline'.startsWith(prefix)).toBe(false);
    }
  });
});

describe('D-174 #22 — upsert union shape', () => {
  it('accepts create (no id) + update (id) per kind', () => {
    const samples: WorkEntityUpsertRpcRequest[] = [
      { kind: 'task', title: 'create task' },
      { kind: 'task', id: 't1', title: 'update task' },
      { kind: 'note', body: 'create note' },
      { kind: 'note', id: 'n1', body: 'update note' },
      { kind: 'commitment', direction: 'outbound', statement: 's', derivation: 'user_declared' },
      { kind: 'commitment', id: 'c1', statement: 's2' },
      { kind: 'project', title: 'create project' },
      { kind: 'project', id: 'p1', state: 'archived' },
    ];
    // Discriminator present on every variant.
    expect(samples.every((s) => typeof s.kind === 'string')).toBe(true);
    expect(samples).toHaveLength(8);
  });

  it('list + delete requests carry the kind discriminator', () => {
    const list: WorkEntityListRpcRequest = { kind: 'task', limit: 10 };
    const del: WorkEntityDeleteRpcRequest = { kind: 'project', id: 'p1', tombstone: false };
    expect(list.kind).toBe('task');
    expect(del.tombstone).toBe(false);
  });
});
