import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { McpInboundTokenRecord } from '@recued/contracts';
import {
  MCP_RECIPE_CALLBACK_AUTHOR_ID,
  createLiveMcpTokenToolAuthorizer,
  createMcpRecipeCallbackWatcher,
  enqueueMcpRecipeCallback,
  sweepMcpRecipeCallbackRetention,
  type McpRecipeCallbackNotificationParams,
} from '../mcp-recipe-callback.js';
import { createBlobStore } from '../storage/blob-store.js';
import {
  SharedCompareAndSetConflictError,
  createSharedStore,
  type SharedRecord,
  type SharedStore,
} from '../storage/shared-store.js';

const NOW = 1_800_000_000_000;
const TOOL = 'recued-core/mail-action-required-query';

class MemoryCallbackStore implements Pick<SharedStore, 'read' | 'list' | 'compareAndSet'> {
  readonly rows = new Map<string, SharedRecord>();
  afterCompareAndSet?: () => void;

  async read(key: string): Promise<SharedRecord | null> {
    return this.rows.get(key) ?? null;
  }

  async list(prefix: string): Promise<Array<{ key: string; value: unknown }>> {
    return [...this.rows.values()]
      .filter((row) => row.key === prefix || row.key.startsWith(`${prefix}.`))
      .map((row) => ({ key: row.key, value: row.value }));
  }

  async compareAndSet(
    key: string,
    expectedRevision: number | null,
    value: unknown,
    options: { author_id: string; recipe_id?: string | null },
  ): Promise<{ bytes: number; revision: number; created: boolean }> {
    const current = this.rows.get(key);
    const actual = current?.cas_revision ?? null;
    const matches = expectedRevision === null
      ? current === undefined
      : current !== undefined && actual === expectedRevision;
    if (!matches) {
      throw new SharedCompareAndSetConflictError(
        key,
        expectedRevision,
        actual,
        current !== undefined,
      );
    }
    const revision = expectedRevision === null ? 0 : expectedRevision + 1;
    expect((value as { revision?: unknown }).revision).toBe(revision);
    const bytes = Buffer.byteLength(JSON.stringify(value));
    this.rows.set(key, {
      key,
      value,
      cas_revision: revision,
      size_bytes: bytes,
      author_id: options.author_id,
      recipe_id: options.recipe_id ?? null,
      written_at: NOW,
      last_read_at: null,
    });
    this.afterCompareAndSet?.();
    return { bytes, revision, created: current === undefined };
  }
}

const token = (overrides: Partial<McpInboundTokenRecord> = {}): McpInboundTokenRecord => ({
  token_id: '0123456789abcdef',
  bearer_hash: 'a'.repeat(64),
  label: 'office codex',
  created_at: NOW - 1_000,
  revoked_at: null,
  grants: { [TOOL]: true },
  concurrency_tier: 3,
  chat_mode: null,
  contract_id: 'ct_office',
  updated_at: NOW,
  ...overrides,
});

const enqueue = async (
  store: MemoryCallbackStore,
  tokens: McpInboundTokenRecord[] = [token()],
  callbackRef = 'mcpcb_12345678',
) => enqueueMcpRecipeCallback(
  {
    store,
    inboundTokenStore: {
      listTokens: () => tokens,
      getTokenById: (token_id) => tokens.find((item) => item.token_id === token_id) ?? null,
    },
    isContractLive: (id) => id === 'ct_office',
    permitsMcpDoor: () => true,
    now: () => NOW,
    newCallbackRef: () => callbackRef,
  },
  {
    destination_contract_id: 'ct_office',
    topic: 'mail.action-required',
    query_tool: TOOL,
    arguments: {
      mail_slug: 'work',
      record_id: 'mail:abc',
      min_confidence: 0.72,
      urgent_window_hours: 24,
    },
    ttl_seconds: 3600,
    source_recipe_id: 'mail-action-required-watch',
  },
);

describe('MCP recipe callback mailbox', () => {
  it('persists and acknowledges a callback through the real SQLite shared store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-recipe-callback-'));
    const db = new Database(join(dir, 'recued.db'));
    const store = createSharedStore({
      db,
      blobs: createBlobStore(join(dir, 'blobs')),
      now: () => NOW,
    });
    try {
      await enqueueMcpRecipeCallback(
        {
          store,
          inboundTokenStore: {
            listTokens: () => [token()],
            getTokenById: () => token(),
          },
          isContractLive: () => true,
          permitsMcpDoor: () => true,
          now: () => NOW,
          newCallbackRef: () => 'mcpcb_sqlite01',
        },
        {
          destination_contract_id: 'ct_office',
          topic: 'mail.action-required',
          query_tool: TOOL,
          arguments: { mail_slug: 'work', record_id: 'mail:sqlite' },
          ttl_seconds: 3600,
          source_recipe_id: 'mail-action-required-watch',
        },
      );

      const sent: McpRecipeCallbackNotificationParams[] = [];
      const watcher = createMcpRecipeCallbackWatcher({
        store,
        token_id: '0123456789abcdef',
        authorize: () => true,
        send: (params) => { sent.push(params); },
        now: () => NOW + 1,
      });
      watcher.setReady();
      await watcher.poll();

      expect(sent).toHaveLength(1);
      const rows = await store.list('mcp.recipe-callback.0123456789abcdef');
      expect(rows).toHaveLength(1);
      const durable = await store.read(rows[0]!.key);
      expect(durable).toMatchObject({
        author_id: MCP_RECIPE_CALLBACK_AUTHOR_ID,
        cas_revision: 1,
        value: {
          revision: 1,
          callback_ref: 'mcpcb_sqlite01',
          delivered_callback_ref: 'mcpcb_sqlite01',
          delivered_at: NOW + 1,
        },
      });
    } finally {
      store.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refreshes token, grant, binding, contract, and door authorization for long-lived stdio', () => {
    let current: McpInboundTokenRecord | null = token();
    let contractLive = true;
    let doorOpen = true;
    const authorize = createLiveMcpTokenToolAuthorizer({
      inboundTokenStore: { getTokenById: () => current },
      token_id: '0123456789abcdef',
      initial_contract_id: 'ct_office',
      isContractLive: () => contractLive,
      permitsMcpDoor: () => doorOpen,
      now: () => NOW,
    });

    expect(authorize(TOOL)).toBe(true);
    current = token({ grants: {} });
    expect(authorize(TOOL)).toBe(false);
    current = token({ revoked_at: NOW - 1 });
    expect(authorize(TOOL)).toBe(false);
    current = token({ contract_id: 'ct_other' });
    expect(authorize(TOOL)).toBe(false);
    current = token();
    contractLive = false;
    expect(authorize(TOOL)).toBe(false);
    contractLive = true;
    doorOpen = false;
    expect(authorize(TOOL)).toBe(false);
  });

  it('queues only active, contract-bound tokens with the exact query grant', async () => {
    const store = new MemoryCallbackStore();
    const result = await enqueue(store, [
      token(),
      token({ token_id: '1111111111111111', grants: { [TOOL]: false } }),
      token({ token_id: '2222222222222222', contract_id: 'ct_other' }),
      token({ token_id: '3333333333333333', revoked_at: NOW - 1 }),
    ]);
    expect(result).toEqual({
      queued_to: 1,
      failed_to: 0,
      coalesced: true,
      skipped_reason: null,
    });
    expect(store.rows).toHaveLength(1);
    const row = [...store.rows.values()][0]!;
    expect(row.author_id).toBe(MCP_RECIPE_CALLBACK_AUTHOR_ID);
    expect(row.value).toMatchObject({
      target_token_id: '0123456789abcdef',
      target_contract_id: 'ct_office',
      query_tool: TOOL,
      arguments: { mail_slug: 'work', record_id: 'mail:abc' },
    });
  });

  it('coalesces repeated events into the same bounded route row', async () => {
    const store = new MemoryCallbackStore();
    await enqueue(store);
    const key = [...store.rows.keys()][0]!;
    await enqueue(store, [token()], 'mcpcb_87654321');
    expect(store.rows).toHaveLength(1);
    expect([...store.rows.keys()][0]).toBe(key);
    expect(store.rows.get(key)?.cas_revision).toBe(1);
    expect(store.rows.get(key)?.value).toMatchObject({ callback_ref: 'mcpcb_87654321' });
  });

  it('delivers a newly coalesced ref after the prior ref was acknowledged', async () => {
    const store = new MemoryCallbackStore();
    await enqueue(store);
    const sent: McpRecipeCallbackNotificationParams[] = [];
    const watcher = createMcpRecipeCallbackWatcher({
      store,
      token_id: '0123456789abcdef',
      authorize: () => true,
      send: (params) => { sent.push(params); },
      now: () => NOW + 1_000,
    });
    watcher.setReady();
    await watcher.poll();
    await enqueue(store, [token()], 'mcpcb_87654321');
    await watcher.poll();

    expect(sent.map((item) => item.callback_ref)).toEqual([
      'mcpcb_12345678',
      'mcpcb_87654321',
    ]);
    expect(store.rows).toHaveLength(1);
  });

  it('treats a missing live/granted destination as a normal skipped branch', async () => {
    const store = new MemoryCallbackStore();
    const result = await enqueue(store, [token({ grants: {} })]);
    expect(result).toMatchObject({
      queued_to: 0,
      failed_to: 0,
      skipped_reason: 'no_active_granted_destination',
    });
    expect(store.rows).toHaveLength(0);
  });

  it('emits only after initialized, projects only supplied arguments and no privileged ids, and marks delivery', async () => {
    const store = new MemoryCallbackStore();
    await enqueue(store);
    const sent: McpRecipeCallbackNotificationParams[] = [];
    const watcher = createMcpRecipeCallbackWatcher({
      store,
      token_id: '0123456789abcdef',
      authorize: () => true,
      send: (params) => { sent.push(params); },
      now: () => NOW + 1_000,
    });

    await watcher.poll();
    expect(sent).toEqual([]);
    watcher.setReady();
    await watcher.poll();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      callback_ref: 'mcpcb_12345678',
      topic: 'mail.action-required',
      query_tool: TOOL,
      arguments: {
        mail_slug: 'work',
        record_id: 'mail:abc',
        min_confidence: 0.72,
        urgent_window_hours: 24,
      },
      triggered_at: NOW,
      expires_at: NOW + 3_600_000,
    });
    expect(JSON.stringify(sent[0])).not.toContain('ct_office');
    expect(JSON.stringify(sent[0])).not.toContain('body');
    expect(JSON.stringify(sent[0])).not.toContain('subject');

    await watcher.poll();
    expect(sent).toHaveLength(1);
    expect([...store.rows.values()][0]?.value).toMatchObject({
      delivered_callback_ref: 'mcpcb_12345678',
      delivered_at: NOW + 1_000,
    });
  });

  it('scrubs an expired route row and leaves it undelivered', async () => {
    const store = new MemoryCallbackStore();
    await enqueue(store);
    const sent: McpRecipeCallbackNotificationParams[] = [];
    const watcher = createMcpRecipeCallbackWatcher({
      store,
      token_id: '0123456789abcdef',
      authorize: () => true,
      send: (params) => { sent.push(params); },
      now: () => NOW + 3_600_000,
    });

    watcher.setReady();
    await watcher.poll();

    expect(sent).toEqual([]);
    expect(store.rows).toHaveLength(1);
    expect([...store.rows.values()][0]?.value).toEqual({
      schema_version: 1,
      revision: 1,
      retired: true,
      retired_at: NOW + 3_600_000,
    });
    expect(JSON.stringify([...store.rows.values()][0]?.value)).not.toContain('mail:abc');
  });

  it('retries the same callback when an asynchronous transport write rejects', async () => {
    const store = new MemoryCallbackStore();
    await enqueue(store);
    let rejectWrite = true;
    const sent: string[] = [];
    const watcher = createMcpRecipeCallbackWatcher({
      store,
      token_id: '0123456789abcdef',
      authorize: () => true,
      send: async (params) => {
        if (rejectWrite) throw new Error('stdout closed');
        sent.push(params.callback_ref);
      },
      now: () => NOW + 1_000,
    });
    watcher.setReady();

    await expect(watcher.poll()).rejects.toThrow('stdout closed');
    expect([...store.rows.values()][0]?.value)
      .not.toHaveProperty('delivered_callback_ref');

    rejectWrite = false;
    await watcher.poll();
    expect(sent).toEqual(['mcpcb_12345678']);
    expect([...store.rows.values()][0]?.value).toMatchObject({
      delivered_callback_ref: 'mcpcb_12345678',
    });
  });

  it('scrubs expired, unauthorized, missing-token, and malformed kernel rows', async () => {
    const store = new MemoryCallbackStore();
    const active = token();
    const revoked = token({ token_id: '1111111111111111', revoked_at: NOW - 1 });
    const ungranted = token({ token_id: '2222222222222222', grants: {} });
    const tokens = [active, revoked, ungranted];

    await enqueue(store, [active]);
    // Seed terminal rows with an active snapshot, then change lifecycle truth
    // before the retention pass.
    await enqueue(store, [token({ token_id: revoked.token_id })]);
    await enqueue(store, [token({ token_id: ungranted.token_id })]);
    await enqueue(store, [token({ token_id: '3333333333333333' })]);

    const genuine = [...store.rows.values()][0]!;
    store.rows.set('mcp.recipe-callback.4444444444444444.malformed', {
      ...genuine,
      key: 'mcp.recipe-callback.4444444444444444.malformed',
      cas_revision: 0,
      value: { revision: 0, record_id: 'must-leave-disk' },
    });

    const result = await sweepMcpRecipeCallbackRetention({
      store,
      inboundTokenStore: {
        getTokenById: (token_id) => tokens.find((item) => item.token_id === token_id) ?? null,
      },
      now: () => NOW + 1,
    });

    expect(result).toMatchObject({ scanned: 5, retained: 1, retired: 4, failed: 0 });
    const values = [...store.rows.values()].map((row) => row.value);
    expect(values.filter((value) => (value as { retired?: unknown }).retired === true))
      .toHaveLength(4);
    expect(JSON.stringify(values)).not.toContain('must-leave-disk');
    expect(JSON.stringify(values)).not.toContain('3333333333333333');
  });

  it('overwrites a retired fence when the same route receives a fresh event', async () => {
    const store = new MemoryCallbackStore();
    await enqueue(store);
    await sweepMcpRecipeCallbackRetention({
      store,
      inboundTokenStore: { getTokenById: () => null },
      token_id: '0123456789abcdef',
      now: () => NOW + 1,
    });

    await enqueue(store, [token()], 'mcpcb_fresh001');

    expect(store.rows).toHaveLength(1);
    expect([...store.rows.values()][0]).toMatchObject({
      cas_revision: 2,
      value: {
        revision: 2,
        callback_ref: 'mcpcb_fresh001',
        target_contract_id: 'ct_office',
      },
    });
  });

  it('does not carry a callback across a later token incarnation', async () => {
    const store = new MemoryCallbackStore();
    await enqueue(store);

    const result = await sweepMcpRecipeCallbackRetention({
      store,
      inboundTokenStore: {
        getTokenById: () => token({ created_at: NOW + 1 }),
      },
      token_id: '0123456789abcdef',
      now: () => NOW + 1,
    });

    expect(result.retired).toBe(1);
    expect([...store.rows.values()][0]?.value).toMatchObject({ retired: true });
  });

  it('retires a callback admitted concurrently with token revocation', async () => {
    const store = new MemoryCallbackStore();
    let current = token();
    let firstWrite = true;
    store.afterCompareAndSet = () => {
      if (firstWrite) {
        firstWrite = false;
        current = token({ revoked_at: NOW });
      }
    };

    const result = await enqueueMcpRecipeCallback(
      {
        store,
        inboundTokenStore: {
          listTokens: () => [token()],
          getTokenById: () => current,
        },
        isContractLive: () => true,
        permitsMcpDoor: () => true,
        now: () => NOW,
        newCallbackRef: () => 'mcpcb_race0001',
      },
      {
        destination_contract_id: 'ct_office',
        topic: 'mail.action-required',
        query_tool: TOOL,
        arguments: { record_id: 'mail:race' },
        ttl_seconds: 3600,
        source_recipe_id: 'mail-action-required-watch',
      },
    );

    expect(result).toEqual({
      queued_to: 0,
      failed_to: 0,
      coalesced: true,
      skipped_reason: 'no_active_granted_destination',
    });
    expect([...store.rows.values()][0]?.value).toMatchObject({ retired: true });
    expect(JSON.stringify([...store.rows.values()][0]?.value)).not.toContain('mail:race');
  });

  it('rejects oversized, content-like, and nested callback arguments', async () => {
    const store = new MemoryCallbackStore();
    const deps = {
      store,
      inboundTokenStore: {
        listTokens: () => [token()],
        getTokenById: () => token(),
      },
      isContractLive: () => true,
      permitsMcpDoor: () => true,
      now: () => NOW,
    };
    const input = {
      destination_contract_id: 'ct_office',
      topic: 'mail.action-required',
      query_tool: TOOL,
      ttl_seconds: 3600,
      source_recipe_id: 'mail-action-required-watch',
    };

    await expect(enqueueMcpRecipeCallback(deps, {
      ...input,
      arguments: { record_id: 'x'.repeat(257) },
    })).rejects.toThrow('256-character identifier');
    await expect(enqueueMcpRecipeCallback(deps, {
      ...input,
      arguments: { body_ref: 'mail-1' },
    })).rejects.toThrow('names content or credential data');
    await expect(enqueueMcpRecipeCallback(deps, {
      ...input,
      arguments: { record_id: { nested: 'mail-1' } },
    })).rejects.toThrow('flat pointer identifier');
    expect(store.rows).toHaveLength(0);
  });

  it('re-authorizes at delivery time and ignores forged shared rows', async () => {
    const store = new MemoryCallbackStore();
    await enqueue(store);
    const genuine = [...store.rows.values()][0]!;
    store.rows.set('mcp.recipe-callback.0123456789abcdef.forged', {
      ...genuine,
      key: 'mcp.recipe-callback.0123456789abcdef.forged',
      author_id: 'rpc',
    });
    let admitted = false;
    const sent: McpRecipeCallbackNotificationParams[] = [];
    const watcher = createMcpRecipeCallbackWatcher({
      store,
      token_id: '0123456789abcdef',
      authorize: () => admitted,
      send: (params) => { sent.push(params); },
      now: () => NOW + 1_000,
    });
    watcher.setReady();
    await watcher.poll();
    expect(sent).toEqual([]);

    admitted = true;
    await watcher.poll();
    expect(sent).toHaveLength(1);
  });
});
