/** D-145 PA11 — contracts surface tests for Settings → Work Entities.
 *
 *  Covers:
 *    - `enabled` field on `SourceRegistration`
 *    - `work_entity.source.*` rpc method names registered in
 *      `SERVER_RPC_METHODS` + `SERVER_RPC_METHOD_SET`
 */

import { describe, expect, it } from 'vitest';

import {
  SERVER_RPC_METHODS,
  SERVER_RPC_METHOD_SET,
  type SourceRegistration,
} from '../index.js';

describe('D-145 PA11 — SourceRegistration.enabled', () => {
  it('typechecks `enabled` as optional boolean (back-compat shape)', () => {
    // Not setting `enabled` — pre-PA11 callers continue to compile.
    const without_enabled: SourceRegistration = {
      id: 'recued.task',
      top_tier_kind: 'task',
      source_kind: 'builtin',
      source_label: 'Recued built-in',
      write_capable: true,
      mcp_exposed: false,
      registered_at: 1_700_000_000_000,
    };
    expect(without_enabled.enabled).toBeUndefined();

    // Setting `enabled` — PA11 callers can opt in.
    const with_enabled: SourceRegistration = {
      ...without_enabled,
      enabled: false,
    };
    expect(with_enabled.enabled).toBe(false);
  });
});

describe('D-145 PA11 — work_entity.source.* rpc methods', () => {
  const PA11_METHODS = [
    'work_entity.source.list',
    'work_entity.source.set_enabled',
    'work_entity.source.set_mcp_exposed',
    'work_entity.source.set_default',
    'work_entity.source.clear_default',
  ] as const;

  it('every PA11 method appears in SERVER_RPC_METHODS', () => {
    for (const m of PA11_METHODS) {
      expect(SERVER_RPC_METHODS).toContain(m);
    }
  });

  it('every PA11 method is in the O(1) lookup set', () => {
    for (const m of PA11_METHODS) {
      expect(SERVER_RPC_METHOD_SET.has(m)).toBe(true);
    }
  });

  it('rpc method names are unique across the registry (no double-claim)', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const m of SERVER_RPC_METHODS) {
      if (seen.has(m)) dupes.push(m);
      seen.add(m);
    }
    expect(dupes).toEqual([]);
  });
});
