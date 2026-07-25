/** D-198 — owner-trusted memory-management rpc contracts tests.
 *
 *  Slice 0 is contract-surface only (types + registry entries; the handlers
 *  land in Slice 1+). These tests lock the surface:
 *    - SERVER_RPC_METHODS registers the 5 memory management methods
 *      (boot-time wiring guard — Slice 1 wires handlers against these keys)
 *    - the management surface is `memory.*`, NOT a revival of the
 *      D-157-P0-deleted `audit.*` read family; export stays on `audit.export.*`
 *    - page-size caps are sane (default ≤ max, both positive)
 *    - the wire shapes carry the D-198 fields (origin filter, the
 *      hard-delete-vs-redact discriminator, the import outcome tally)
 */

import { describe, expect, it } from 'vitest';
import {
  MEMORY_LIST_DEFAULT_PAGE_SIZE,
  MEMORY_LIST_MAX_PAGE_SIZE,
  SERVER_RPC_METHOD_SET,
  type MemoryCreateRequest,
  type MemoryDeleteResult,
  type MemoryGetResponse,
  type MemoryImportRequest,
  type MemoryImportResult,
  type MemoryListEntry,
  type MemoryListRequest,
} from '../index.js';
import type { Actor } from '../commits.js';

describe('D-198 memory rpc registry wiring', () => {
  it('registers the 6 owner-trusted memory management methods', () => {
    for (const m of [
      'memory.list',
      'memory.get',
      'memory.create',
      'memory.update',
      'memory.delete',
      'memory.import',
    ]) {
      expect(SERVER_RPC_METHOD_SET.has(m)).toBe(true);
    }
  });

  it('does NOT revive the D-157-P0-deleted `audit.*` read family', () => {
    // The management surface is `memory.*`; reviving `audit.list` etc. would
    // regress D-157 P0. The transparent feed is `memory.list`, not `audit.list`.
    const methods = SERVER_RPC_METHOD_SET as ReadonlySet<string>;
    for (const deleted of ['audit.list', 'audit.get', 'audit.runs.list']) {
      expect(methods.has(deleted)).toBe(false);
    }
  });

  it('keeps export on the existing `audit.export.*` pair (not re-homed under memory.*)', () => {
    expect(SERVER_RPC_METHOD_SET.has('audit.export.estimate')).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has('audit.export.page')).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has('memory.export')).toBe(false);
  });
});

describe('D-198 memory.list page caps', () => {
  it('declares sane caps (both positive, default ≤ max)', () => {
    expect(MEMORY_LIST_DEFAULT_PAGE_SIZE).toBeGreaterThan(0);
    expect(MEMORY_LIST_MAX_PAGE_SIZE).toBeGreaterThan(0);
    expect(MEMORY_LIST_DEFAULT_PAGE_SIZE).toBeLessThanOrEqual(MEMORY_LIST_MAX_PAGE_SIZE);
  });
});

describe('D-198 wire shapes', () => {
  it('memory.list filters by D-161 origin_actor (the origin filter)', () => {
    const actors: Actor[] = ['user_self', 'contracted_user'];
    const req: MemoryListRequest = { origin_actors: actors, limit: 50 };
    expect(req.origin_actors).toEqual(['user_self', 'contracted_user']);
  });

  it('memory.list entries carry origin + bistemporal time + run linkage', () => {
    const entry: MemoryListEntry = {
      memory_id: 'm1',
      origin_actor: 'user_self',
      kind: 'note',
      ts: 1,
      event_at: 0,
      run_id: 'r1',
    };
    expect(entry.origin_actor).toBe('user_self');
    expect(entry.run_id).toBe('r1');
  });

  it('memory.get returns the FULL body (the detail view; unlike the list preview)', () => {
    const res: MemoryGetResponse = {
      memory_id: 'm1',
      origin_actor: 'user_self',
      kind: 'note',
      ts: 1,
      body: 'the full note text, however long, resolved from inline or the CAS blob',
      size_bytes: 4096,
    };
    expect(res.body).toContain('full note text');
    expect(res.size_bytes).toBe(4096);
  });

  it('memory.list entries ship a body PREVIEW + size, never the full body', () => {
    const entry: MemoryListEntry = {
      memory_id: 'm1',
      origin_actor: 'user_self',
      kind: 'note',
      ts: 1,
      body_preview: 'first line of a long note…',
      size_bytes: 4096,
      has_body: true,
    };
    expect(entry.body_preview).toBeDefined();
    expect(entry.size_bytes).toBe(4096);
    // The full body is deliberately NOT a list field — large text would bloat
    // the feed. It loads on demand via memory.get (D-198 §5, Slice 2).
    expect('body' in entry).toBe(false);
  });

  it('memory.create carries no origin_actor — the handler stamps user_self server-side', () => {
    // Origin-honesty (D-198 §3): a caller can never author a row of another
    // origin, so `origin_actor` is deliberately absent from the create request.
    const req: MemoryCreateRequest = { kind: 'note', body: { text: 'remember this' } };
    expect('origin_actor' in req).toBe(false);
  });

  it('memory.delete result discriminates hard-delete (own) vs redact (other)', () => {
    const hard: MemoryDeleteResult = { memory_id: 'm1', deleted: true, redacted: false };
    const soft: MemoryDeleteResult = { memory_id: 'm2', deleted: false, redacted: true };
    expect(hard.deleted).toBe(true);
    expect(hard.redacted).toBe(false);
    expect(soft.deleted).toBe(false);
    expect(soft.redacted).toBe(true);
  });

  it('memory.import returns the per-outcome tally (merge-by-id / content-dedup)', () => {
    // A user_self entry (has memory_id → merge-by-id) + an "other" entry
    // (content-dedup). The tally accounts for every submitted entry.
    const req: MemoryImportRequest = {
      entries: [
        { memory_id: 'own1', origin_actor: 'user_self', kind: 'note' },
        { origin_actor: 'system', kind: 'audit', summary: 'other memory as text' },
      ],
    };
    const result: MemoryImportResult = { merged: 1, inserted: 0, deduped: 1, skipped: 0 };
    expect(req.entries).toHaveLength(2);
    expect(result.merged + result.inserted + result.deduped + result.skipped).toBe(
      req.entries.length,
    );
  });
});
