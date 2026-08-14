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


describe('D-145 PA11 — work_entity.source.* rpc methods', () => {
  // ⛔ Was four. `set_enabled` / `set_default` / `clear_default` were deleted
  // with the Settings → Work Entities page (D-187 Sources half) — a Source is
  // declared by a PACK, so pack install/uninstall is its lifecycle. `list`
  // survives for the Data route + Reception inbox.
  const PA11_METHODS = ['work_entity.source.list'] as const;
  const DELETED_METHODS = [
    'work_entity.source.set_enabled',
    'work_entity.source.set_default',
    'work_entity.source.clear_default',
  ] as const;

  it('every PA11 method appears in SERVER_RPC_METHODS', () => {
    for (const m of PA11_METHODS) {
      expect(SERVER_RPC_METHODS).toContain(m);
    }
  });

  it('the deleted write methods are absent from the registry', () => {
    for (const m of DELETED_METHODS) {
      expect(SERVER_RPC_METHODS as readonly string[]).not.toContain(m);
      expect((SERVER_RPC_METHOD_SET as ReadonlySet<string>).has(m)).toBe(false);
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
