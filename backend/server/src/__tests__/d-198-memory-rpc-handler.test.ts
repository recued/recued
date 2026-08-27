/** D-198 Slice 1 — `memory.list` handler tests.
 *
 *  Covers the owner-trusted feed handler:
 *    - registered-client boundary (owner-only; no contract gate)
 *    - AuditEntry -> MemoryListEntry projection (origin/kind defaults, run link)
 *    - origin_actors pass-through to the storage filter
 *    - kind + since/until (event-axis) filtering
 *    - cursor pagination correctness (no dup / no skip across pages)
 *    - limit clamp + malformed-cursor fail-open
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { MemoryListRequest } from '@recued/contracts';
import { createInMemoryCollection } from '@recued/storage';
import type { AuditEntry, AuditLogStore, Collection } from '@recued/storage';
import type { EventBus } from '../events/bus.js';
import {
  handleMemoryCreate,
  handleMemoryDelete,
  handleMemoryGet,
  handleMemoryImport,
  handleMemoryList,
  handleMemoryUpdate,
  makeMemoryRpcHandlers,
  type MemoryRedactionRecord,
  type MemoryRpcDeps,
} from '../memory-rpc-handler.js';
import type { BlobStore } from '../storage/blob-store.js';
import {
  createUserMemoryStore,
  USER_MEMORY_ID_PREFIX,
  type UserMemoryRow,
  type UserMemoryStore,
} from '../user-memory-store.js';
import type { WsClient } from '../ws-server.js';

/** Minimal AuditEntry for the fields the handler reads. */
const mkRow = (o: {
  run_id: string;
  started_at: number;
  actor?: string;
  source?: AuditEntry['execution_source'];
  contract_snapshot?: AuditEntry['contract_snapshot'];
  kind?: string;
  output?: string;
  event_at?: number;
}): AuditEntry =>
  ({
    run_id: o.run_id,
    started_at: o.started_at,
    ...(o.source !== undefined
      ? { execution_source: o.source }
      : o.actor
        ? { execution_source: { actor: o.actor } }
        : {}),
    ...(o.contract_snapshot === undefined
      ? {}
      : { contract_snapshot: o.contract_snapshot }),
    ...(o.kind ? { commit_kind: o.kind } : {}),
    ...(o.output ? { output_string: o.output } : {}),
    ...(o.event_at !== undefined ? { event_at: o.event_at } : {}),
  }) as unknown as AuditEntry;

/** Fake store honouring the real `listRecent` semantics: origin filter
 *  (undefined actor -> 'system'), sort by started_at DESC, slice to limit.
 *
 *  ⛔ `listWindow` MUST MIRROR THE REAL ORDER, not merely return rows. The
 *  handler merges two independently-truncated DESC streams and trusts them down
 *  to a shared horizon; a fake that ordered differently from the SQLite
 *  implementation would make the merge look correct here and drop rows in
 *  production. So this sorts by `COALESCE(event_at, started_at) DESC, run_id
 *  DESC` — the same total order `listWindowDesc` emits and `compareEntriesDesc`
 *  expects — and applies the keyset cursor with the same strict comparison.
 *
 *  ⚠ And it applies NO ORIGIN FILTER, matching the real one. The filter runs in
 *  JS over the union; pushing it down here would hide the case where a windowed
 *  read returns fewer matching rows than the page needs. */
const auditEff = (r: AuditEntry): number => r.event_at ?? r.started_at;

/** ONE definition of the window, shared by both fakes below. Two hand-rolled
 *  copies of an ordering are two chances for one of them to drift from the
 *  SQLite implementation the handler's horizon argument depends on. */
const auditWindowOver = (rows: AuditEntry[]) =>
  async ({ limit, before }: { limit: number; before?: { ts: number; id: string } }) => {
    const ordered = [...rows].sort((a, b) =>
      (auditEff(b) - auditEff(a))
      || (a.run_id < b.run_id ? 1 : a.run_id > b.run_id ? -1 : 0));
    const after = before === undefined
      ? ordered
      : ordered.filter((r) => (auditEff(r) !== before.ts
        ? auditEff(r) < before.ts
        : r.run_id < before.id));
    return after.slice(0, limit);
  };

const depsFor = (rows: AuditEntry[]): MemoryRpcDeps => ({
  auditLog: {
    async listRecent(limit: number, opts?: { origin_actors?: readonly string[] }) {
      const filter = opts?.origin_actors;
      const matched =
        filter && filter.length > 0
          ? rows.filter((r) => filter.includes(r.execution_source?.actor ?? 'system'))
          : rows;
      return [...matched].sort((a, b) => b.started_at - a.started_at).slice(0, limit);
    },
    listWindow: auditWindowOver(rows),
  } as unknown as AuditLogStore,
});

const registered = { instance_id: 'inst-1' } as unknown as WsClient;
const unregistered = { instance_id: undefined } as unknown as WsClient;

describe('memory.list — owner-trust boundary', () => {
  it('rejects an unregistered paired client', async () => {
    const slice = makeMemoryRpcHandlers(depsFor([]));
    expect(slice).toBeDefined();
    await expect(slice!.handlers['memory.list']({}, unregistered)).rejects.toThrow(
      /registered paired client/,
    );
  });

  it('serves a registered client', async () => {
    const slice = makeMemoryRpcHandlers(depsFor([mkRow({ run_id: 'r1', started_at: 1 })]));
    const res = await slice!.handlers['memory.list']({}, registered);
    expect(res.entries).toHaveLength(1);
  });

  it('returns undefined (not_configured) with no deps', () => {
    expect(makeMemoryRpcHandlers(undefined)).toBeUndefined();
  });
});

describe('memory.list — projection', () => {
  it('maps origin/kind/summary/run link and defaults origin->system, kind->run', async () => {
    const deps = depsFor([
      mkRow({ run_id: 'a', started_at: 200, actor: 'contracted_user', kind: 'query', output: 'x', event_at: 150 }),
      mkRow({ run_id: 'b', started_at: 100 }),
    ]);
    const res = await handleMemoryList(deps, {});
    // newest-first by effective time (a: event_at 150 > b: started_at 100)
    expect(res.entries.map((e) => e.memory_id)).toEqual(['a', 'b']);
    expect(res.entries[0]).toMatchObject({
      memory_id: 'a',
      origin_actor: 'contracted_user',
      kind: 'query',
      summary: 'x',
      ts: 200,
      event_at: 150,
      run_id: 'a',
    });
    // b: no execution_source / commit_kind / output_string
    expect(res.entries[1]).toMatchObject({ memory_id: 'b', origin_actor: 'system', kind: 'run', ts: 100 });
    expect(res.entries[1].summary).toBeUndefined();
    expect(res.entries[1].event_at).toBeUndefined();
  });

  it('derives full audit attribution from the existing source and contract snapshot', async () => {
    const source = {
      channel: 'mcp',
      actor: 'contracted_user',
      agent_id: 'agent-1',
      tool_call_id: 'tool-1',
      mcp_token_id: 'token-1',
      contract_id: 'contract-1',
    } as const;
    const contract_snapshot = {
      contract_id: 'contract-1',
      contract_version: 'v3',
      grants: [],
      captured_at: 1,
    } as unknown as NonNullable<AuditEntry['contract_snapshot']>;
    const deps = depsFor([
      mkRow({ run_id: 'agent-run', started_at: 1, source, contract_snapshot }),
    ]);
    const [entry] = (await handleMemoryList(deps, {})).entries;
    expect(entry?.attribution).toEqual({
      kind: 'agent',
      origin_actor: 'contracted_user',
      agent_id: 'agent-1',
      contract_id: 'contract-1',
      contract_version: 'v3',
      label: 'agent agent-1, under contract contract-1, asserted this',
    });
  });
});

describe('memory.list — filters', () => {
  const rows = [
    mkRow({ run_id: 'u1', started_at: 300, actor: 'user_self', kind: 'action' }),
    mkRow({ run_id: 'c1', started_at: 200, actor: 'contracted_user', kind: 'query' }),
    mkRow({ run_id: 's1', started_at: 100, kind: 'query' }), // actor -> system
  ];

  it('origin_actors passes through to the storage filter', async () => {
    const res = await handleMemoryList(depsFor(rows), { origin_actors: ['user_self'] });
    expect(res.entries.map((e) => e.memory_id)).toEqual(['u1']);
  });

  it('kind filters against the projected kind (incl. the run default)', async () => {
    const res = await handleMemoryList(depsFor(rows), { kind: 'query' });
    expect(res.entries.map((e) => e.memory_id)).toEqual(['c1', 's1']);
  });

  it('since/until bound on the effective (event-axis) time', async () => {
    const res = await handleMemoryList(depsFor(rows), { since: 150, until: 250 });
    expect(res.entries.map((e) => e.memory_id)).toEqual(['c1']);
  });
});

describe('memory.list — pagination', () => {
  const rows = [1, 2, 3, 4, 5].map((n) => mkRow({ run_id: `r${n}`, started_at: n * 10 }));

  it('paginates by cursor with no dup / no skip across pages', async () => {
    const deps = depsFor(rows);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const req: MemoryListRequest = { limit: 2, ...(cursor ? { cursor } : {}) };
      const res = await handleMemoryList(deps, req);
      seen.push(...res.entries.map((e) => e.memory_id));
      cursor = res.next_cursor;
      pages += 1;
      expect(pages).toBeLessThan(10); // guard against a runaway cursor
    } while (cursor);

    // 5 rows, newest-first, each seen exactly once
    expect(seen).toEqual(['r5', 'r4', 'r3', 'r2', 'r1']);
    expect(new Set(seen).size).toBe(5);
    expect(pages).toBe(3); // 2 + 2 + 1
  });

  it('omits next_cursor on the last page', async () => {
    const res = await handleMemoryList(depsFor(rows), { limit: 100 });
    expect(res.entries).toHaveLength(5);
    expect(res.next_cursor).toBeUndefined();
  });

  it('clamps an over-large limit and fails open on a malformed cursor', async () => {
    const res = await handleMemoryList(depsFor(rows), { limit: 10_000_000, cursor: 'not-base64!!' });
    // malformed cursor -> start from the top; clamp keeps it a valid page
    expect(res.entries.map((e) => e.memory_id)).toEqual(['r5', 'r4', 'r3', 'r2', 'r1']);
  });
});

// ── Slice 2 — the write path (create/get/update/delete) + the list union ────

/** Content-addressing fake CAS — handler-test bodies stay inline, so put/get
 *  are exercised only by the (unused here) > 64 KB paths. */
const fakeBlobs = (): BlobStore => {
  const map = new Map<string, Buffer>();
  return {
    root: '/fake',
    async put(data) {
      const hash = createHash('sha256').update(data).digest('hex');
      map.set(hash, Buffer.from(data));
      return hash;
    },
    async get(hash) { return map.get(hash) ?? null; },
    async has(hash) { return map.has(hash); },
    async delete(hash) { map.delete(hash); },
    async sizeOf(hash) { return map.get(hash)?.length ?? null; },
    async sweepOrphans() { return 0; },
    async totalBytes() { return 0; },
  };
};

/** AuditLogStore mock backing both `listRecent` (origin filter) and `get`. */
const mkAuditStore = (rows: AuditEntry[]): AuditLogStore =>
  ({
    async listRecent(limit: number, opts?: { origin_actors?: readonly string[] }) {
      const filter = opts?.origin_actors;
      const matched =
        filter && filter.length > 0
          ? rows.filter((r) => filter.includes(r.execution_source?.actor ?? 'system'))
          : rows;
      return [...matched].sort((a, b) => b.started_at - a.started_at).slice(0, limit);
    },
    listWindow: auditWindowOver(rows),
    async get(run_id: string) {
      return rows.find((r) => r.run_id === run_id) ?? null;
    },
  }) as unknown as AuditLogStore;

type SpyEvent = { kind: string; subkind?: string; id?: string };
interface UserDeps extends MemoryRpcDeps {
  userMemoryStore: UserMemoryStore;
  redactionStore: Collection<MemoryRedactionRecord>;
  events: SpyEvent[];
}

/** Deps carrying a REAL `user_memory` store (in-memory collection + fake CAS),
 *  a real in-memory redaction store, + a spy bus. Deterministic ids (`umem_1`,
 *  …) + fixed clock (500, newer than the sub-500 audit rows below → user rows
 *  sort first). */
const depsWithUser = (auditRows: AuditEntry[] = []): UserDeps => {
  let seq = 0;
  const userMemoryStore = createUserMemoryStore(
    createInMemoryCollection<UserMemoryRow>(),
    fakeBlobs(),
    { now: () => 500, mintId: () => `${USER_MEMORY_ID_PREFIX}${(seq += 1)}` },
  );
  const redactionStore = createInMemoryCollection<MemoryRedactionRecord>();
  const events: SpyEvent[] = [];
  const bus = { emit: (e: SpyEvent) => { events.push(e); } } as unknown as EventBus;
  return { auditLog: mkAuditStore(auditRows), userMemoryStore, redactionStore, bus, events, now: () => 777 };
};

describe('memory.create — owner authorship', () => {
  it('stamps user_self server-side, mints an id, and emits memory:user', async () => {
    const deps = depsWithUser();
    const res = await handleMemoryCreate(deps, {
      kind: 'note',
      body: 'remember this',
      provenance_entity_ids: ['x@y.com'],
    });
    expect(res.memory_id).toBe('umem_1');
    expect(res.provenance_edges_written).toBe(1);
    const got = await handleMemoryGet(deps, { memory_id: res.memory_id });
    expect(got.origin_actor).toBe('user_self'); // never taken from the request
    expect(got.body).toBe('remember this');
    expect(deps.events).toContainEqual({ kind: 'memory', subkind: 'user', id: 'umem_1' });
  });

  it('rejects a blank kind + reports not_configured with no store', async () => {
    const deps = depsWithUser();
    await expect(handleMemoryCreate(deps, { kind: '  ' })).rejects.toThrow(/non-empty kind/);
    await expect(
      handleMemoryCreate({ auditLog: mkAuditStore([]) }, { kind: 'note' }),
    ).rejects.toThrow(/user_memory store/i);
  });
});

describe('memory.get — audit vs user routing', () => {
  it('resolves an audit row from the audit log (summary, no body)', async () => {
    const deps = depsWithUser([
      mkRow({ run_id: 'run-1', started_at: 10, actor: 'contracted_user', kind: 'query', output: 'did a thing' }),
    ]);
    const res = await handleMemoryGet(deps, { memory_id: 'run-1' });
    expect(res).toMatchObject({
      memory_id: 'run-1',
      origin_actor: 'contracted_user',
      kind: 'query',
      summary: 'did a thing',
      run_id: 'run-1',
    });
    expect(res.body).toBeUndefined();
  });

  it('resolves a user row from the user_memory store (full body)', async () => {
    const deps = depsWithUser();
    const { memory_id } = await handleMemoryCreate(deps, { kind: 'note', body: 'the full body' });
    const res = await handleMemoryGet(deps, { memory_id });
    expect(res.body).toBe('the full body');
    expect(res.origin_actor).toBe('user_self');
  });

  it('throws not_found for an unknown id + bad_request for an empty id', async () => {
    const deps = depsWithUser();
    await expect(handleMemoryGet(deps, { memory_id: 'umem_404' })).rejects.toThrow(/not found/i);
    await expect(handleMemoryGet(deps, { memory_id: '' })).rejects.toThrow(/memory_id/);
  });
});

describe('memory.update — own rows only', () => {
  it('edits a user_self row + emits', async () => {
    const deps = depsWithUser();
    const { memory_id } = await handleMemoryCreate(deps, { kind: 'note', body: 'v1' });
    deps.events.length = 0;
    await handleMemoryUpdate(deps, { memory_id, body: 'v2', summary: 'updated' });
    const got = await handleMemoryGet(deps, { memory_id });
    expect(got.body).toBe('v2');
    expect(got.summary).toBe('updated');
    expect(deps.events).toContainEqual({ kind: 'memory', subkind: 'user', id: memory_id });
  });

  it('refuses to edit a non-user_self (audit) row', async () => {
    const deps = depsWithUser([mkRow({ run_id: 'run-9', started_at: 1 })]);
    await expect(
      handleMemoryUpdate(deps, { memory_id: 'run-9', summary: 'nope' }),
    ).rejects.toThrow(/editable/i);
  });
});

describe('memory.delete — origin split', () => {
  it('hard-deletes a user_self row (deleted:true) + emits', async () => {
    const deps = depsWithUser();
    const { memory_id } = await handleMemoryCreate(deps, { kind: 'note', body: 'bye' });
    deps.events.length = 0;
    const res = await handleMemoryDelete(deps, { memory_id });
    expect(res).toEqual({ memory_id, deleted: true, redacted: false });
    await expect(handleMemoryGet(deps, { memory_id })).rejects.toThrow(/not found/i);
    expect(deps.events).toContainEqual({ kind: 'memory', subkind: 'user', id: memory_id });
  });

  it('REDACTS a non-user_self (audit) row instead of deleting it (§5)', async () => {
    const deps = depsWithUser([mkRow({ run_id: 'run-3', started_at: 1, output: 'secret' })]);
    const res = await handleMemoryDelete(deps, { memory_id: 'run-3' });
    expect(res).toEqual({ memory_id: 'run-3', deleted: false, redacted: true });
    // the redaction marker is recorded (never mutating the audit row)
    expect(await deps.redactionStore.get('run-3')).toEqual({ memory_id: 'run-3', redacted_at: 777 });
    expect(deps.events).toContainEqual({ kind: 'memory', subkind: 'user', id: 'run-3' });
  });

  it('404s a redact of an unknown audit id; not_configured without the redaction store', async () => {
    const deps = depsWithUser();
    await expect(handleMemoryDelete(deps, { memory_id: 'run-missing' })).rejects.toThrow(/not found/i);
    await expect(
      handleMemoryDelete(
        { auditLog: mkAuditStore([mkRow({ run_id: 'run-9', started_at: 1 })]), userMemoryStore: depsWithUser().userMemoryStore },
        { memory_id: 'run-9' },
      ),
    ).rejects.toThrow(/redaction store/i);
  });

  it('throws not_found for an unknown user id', async () => {
    const deps = depsWithUser();
    await expect(handleMemoryDelete(deps, { memory_id: 'umem_999' })).rejects.toThrow(/not found/i);
  });
});

describe('memory redaction overlay (§5)', () => {
  it('list shows a redacted row content-cleared but still present + flagged', async () => {
    const deps = depsWithUser([
      mkRow({ run_id: 'run-a', started_at: 100, actor: 'system', output: 'sensitive output' }),
      mkRow({ run_id: 'run-b', started_at: 200, actor: 'contracted_user', output: 'kept' }),
    ]);
    await handleMemoryDelete(deps, { memory_id: 'run-a' }); // redact run-a
    const res = await handleMemoryList(deps, {});
    const a = res.entries.find((e) => e.memory_id === 'run-a')!;
    const b = res.entries.find((e) => e.memory_id === 'run-b')!;
    // still displayed (transparency), content gone, flagged, origin/kind kept
    expect(a).toMatchObject({ memory_id: 'run-a', origin_actor: 'system', redacted: true });
    expect(a.summary).toBeUndefined();
    expect(b.redacted).toBeUndefined();
    expect(b.summary).toBe('kept');
  });

  it('get returns a redacted row with content stripped + redacted:true', async () => {
    const deps = depsWithUser([mkRow({ run_id: 'run-x', started_at: 1, actor: 'system', output: 'secret body' })]);
    await handleMemoryDelete(deps, { memory_id: 'run-x' });
    const got = await handleMemoryGet(deps, { memory_id: 'run-x' });
    expect(got).toMatchObject({ memory_id: 'run-x', origin_actor: 'system', redacted: true });
    expect(got.summary).toBeUndefined();
    expect(got.body).toBeUndefined();
  });
});

describe('memory.list — audit + user_memory union', () => {
  it('merges both sources newest-first by effective time', async () => {
    const deps = depsWithUser([
      mkRow({ run_id: 'run-a', started_at: 100, actor: 'system' }),
      mkRow({ run_id: 'run-b', started_at: 300, actor: 'contracted_user' }),
    ]);
    const u = await handleMemoryCreate(deps, { kind: 'note', body: 'mine' });
    const res = await handleMemoryList(deps, {});
    // user row (ts 500) newest, then run-b (300), then run-a (100)
    expect(res.entries.map((e) => e.memory_id)).toEqual([u.memory_id, 'run-b', 'run-a']);
    const userEntry = res.entries[0];
    expect(userEntry.origin_actor).toBe('user_self');
    expect(userEntry.has_body).toBe(true);
    expect(userEntry.body_preview).toBe('mine');
    expect(userEntry.size_bytes).toBe(4);
  });

  it('excludes user rows when the origin filter omits user_self', async () => {
    const deps = depsWithUser([mkRow({ run_id: 'run-x', started_at: 100, actor: 'system' })]);
    await handleMemoryCreate(deps, { kind: 'note', body: 'hidden' });
    const res = await handleMemoryList(deps, { origin_actors: ['system'] });
    expect(res.entries.map((e) => e.memory_id)).toEqual(['run-x']);
  });

  it('includes user rows when filtering to user_self', async () => {
    const deps = depsWithUser([mkRow({ run_id: 'run-y', started_at: 100, actor: 'system' })]);
    const u = await handleMemoryCreate(deps, { kind: 'note', body: 'mine' });
    const res = await handleMemoryList(deps, { origin_actors: ['user_self'] });
    expect(res.entries.map((e) => e.memory_id)).toEqual([u.memory_id]);
  });

  it('derives authored-memory attribution from existing origin + contract facets', async () => {
    const deps = depsWithUser();
    const row = await deps.userMemoryStore.writeAuthored({
      origin_actor: 'contracted_user',
      kind: 'fact',
      summary: 'delegated fact',
      session: { channel_session_id: 'chat-1', contract_id: 'contract-chat' },
    });
    const listEntry = (await handleMemoryList(deps, {})).entries.find(
      (entry) => entry.memory_id === row.memory_id,
    );
    expect(listEntry?.attribution).toEqual({
      kind: 'agent',
      origin_actor: 'contracted_user',
      contract_id: 'contract-chat',
      label: 'an agent, under contract contract-chat, asserted this',
    });
    const detail = await handleMemoryGet(deps, { memory_id: row.memory_id });
    expect(detail.attribution).toEqual(listEntry?.attribution);

    await handleMemoryDelete(deps, { memory_id: row.memory_id });
    const redacted = (await handleMemoryList(deps, {})).entries.find(
      (entry) => entry.memory_id === row.memory_id,
    );
    expect(redacted?.redacted).toBe(true);
    expect(redacted?.attribution).toEqual(listEntry?.attribution);
    expect((await handleMemoryGet(deps, { memory_id: row.memory_id })).attribution)
      .toEqual(listEntry?.attribution);
  });
});

describe('memory.import — coercion + tally + broadcast', () => {
  it('imports entries, returns the tally, emits, and the rows become listable', async () => {
    const deps = depsWithUser();
    const res = await handleMemoryImport(deps, {
      entries: [
        { origin_actor: 'user_self', kind: 'note', body: 'restored' },
        { origin_actor: 'contracted_user', kind: 'fact', body: 'shared knowledge' },
      ],
    });
    expect(res).toMatchObject({ inserted: 2, merged: 0, deduped: 0, skipped: 0 });
    expect(deps.events).toContainEqual({ kind: 'memory', subkind: 'user', id: 'import' });
    const list = await handleMemoryList(deps, {});
    expect(list.entries).toHaveLength(2);
    // every imported row reads as user_self (owner surface / owner-vouched)
    expect(list.entries.every((e) => e.origin_actor === 'user_self')).toBe(true);
  });

  it('reports not_configured without the store + bad_request for non-array entries', async () => {
    await expect(
      handleMemoryImport({ auditLog: mkAuditStore([]) }, { entries: [] }),
    ).rejects.toThrow(/user_memory store/i);
    await expect(
      handleMemoryImport(depsWithUser(), { entries: 'nope' as unknown as [] }),
    ).rejects.toThrow(/entries array/i);
  });

  it('does not emit when nothing changed (all skipped)', async () => {
    const deps = depsWithUser();
    const res = await handleMemoryImport(deps, {
      entries: [{ origin_actor: 'user_self', kind: '', body: 'x' }],
    });
    expect(res).toMatchObject({ skipped: 1, inserted: 0 });
    expect(deps.events.find((e) => e.id === 'import')).toBeUndefined();
  });
});
