/** D-225 Slice 2 — destroy, both directions.
 *
 *  A generated MCP pack and its connection are one thing to the owner: the
 *  pack's every operation dispatches through that connection, so removing one
 *  and leaving the other is a half state neither surface explains.
 *
 *  ⛔ The two directions could recurse. The cycle is broken STRUCTURALLY at the
 *  composition site — each direction hands the other a deps object that OMITS
 *  the reverse hook, so coming back is impossible rather than merely not done.
 *  A flag would be something to forget; an absent capability is not.
 *
 *  These tests drive the HANDLERS with the same shape composition wires, and
 *  the termination test is the one that matters: it wires BOTH hooks (which
 *  production deliberately never does) and proves that even then the delete
 *  ordering stops the recursion. Belt and braces, because a cycle that only
 *  fails in production is the worst kind.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpConnectionForPackSlug, mcpGeneratedPackSlug } from '@recued/ingredient-authoring';

import { handleConnectionDelete, handleConnectionEnroll } from '../connection-handler.js';
import {
  createConnectionStore,
  type ConnectionStoreSqlite,
} from '../storage/connection-store.js';

const NOW = 1_700_000_000_000;
const key = new Uint8Array(32).fill(7);
const getEncryptionKey = (): Uint8Array => key;

let db: Database.Database;
let store: ConnectionStoreSqlite;

beforeEach(() => {
  db = new Database(':memory:');
  store = createConnectionStore(db);
});
afterEach(() => db.close());

const enrollMcp = async (name: string): Promise<string> => {
  await handleConnectionEnroll(
    { store, now: () => NOW, getEncryptionKey },
    {
      name,
      kind: 'mcp',
      subtype: 'sse',
      display_name: name,
      config: { endpoint: 'https://mcp.example.test/rpc', transport: 'sse' },
      auth: { type: 'bearer', token: 'secret' },
    },
  );
  return name;
};

describe('D-225 — destroy direction 1: connection delete tears down the pack', () => {
  it('tears down the pack the connection minted', async () => {
    const name = await enrollMcp('peer');
    const torn: string[] = [];

    await handleConnectionDelete(
      {
        store,
        now: () => NOW,
        getEncryptionKey,
        teardownGeneratedPack: async (slug) => { torn.push(slug); },
      },
      { name, kind: 'mcp' },
    );

    expect(torn).toEqual([await mcpGeneratedPackSlug({ kind: 'mcp', name })]);
    expect(store.get('mcp', name)).toBeNull();
  });

  it('does NOT tear anything down for a non-mcp connection', async () => {
    // The paired negative: a generated pack only ever exists for an mcp
    // connection, so an api connection's delete must not reach for one.
    await handleConnectionEnroll(
      { store, now: () => NOW, getEncryptionKey },
      {
        name: 'an-api',
        kind: 'api',
        display_name: 'an-api',
        config: { base_url: 'https://api.example.test' },
        auth: { type: 'bearer', token: 's' },
      },
    );
    const torn: string[] = [];
    await handleConnectionDelete(
      {
        store, now: () => NOW, getEncryptionKey,
        teardownGeneratedPack: async (slug) => { torn.push(slug); },
      },
      { name: 'an-api', kind: 'api' },
    );
    expect(torn).toEqual([]);
  });

  it('does not tear down when the connection did not exist', async () => {
    // Nothing was deleted, so nothing is downstream of the deletion.
    const torn: string[] = [];
    await handleConnectionDelete(
      {
        store, now: () => NOW, getEncryptionKey,
        teardownGeneratedPack: async (slug) => { torn.push(slug); },
      },
      { name: 'never-enrolled', kind: 'mcp' },
    );
    expect(torn).toEqual([]);
  });

  it('⛔ a teardown failure does not fail the delete', async () => {
    // The connection row is already gone by this point. Throwing would leave
    // the owner unable to retry a delete that has, in fact, happened.
    const name = await enrollMcp('peer');
    await expect(
      handleConnectionDelete(
        {
          store, now: () => NOW, getEncryptionKey,
          teardownGeneratedPack: async () => { throw new Error('uninstall exploded'); },
        },
        { name, kind: 'mcp' },
      ),
    ).resolves.toBeDefined();
    expect(store.get('mcp', name)).toBeNull();
  });
});

describe('D-225 — destroy direction 2: the reverse lookup', () => {
  it('recomputes which connection minted a pack', async () => {
    // 🔑 The slug is a one-way hash of `{kind, name}`, so the mapping cannot be
    // read backwards — it is RECOMPUTED. A stored mapping could disagree with
    // the derivation it claims to describe, and nothing would notice.
    await enrollMcp('alpha');
    await enrollMcp('beta');
    const rows = store.list({ kind: 'mcp' }).map((r) => ({ kind: r.kind, name: r.name }));

    const target = await mcpGeneratedPackSlug({ kind: 'mcp', name: 'beta' });
    expect(await mcpConnectionForPackSlug(target, rows)).toEqual({ kind: 'mcp', name: 'beta' });
  });

  it('returns null for a pack no enrolled connection derives', async () => {
    // Every ordinary pack. This is what keeps a marketplace uninstall from
    // reaching for a connection.
    await enrollMcp('alpha');
    const rows = store.list({ kind: 'mcp' }).map((r) => ({ kind: r.kind, name: r.name }));
    expect(await mcpConnectionForPackSlug('recued-core/hubspot', rows)).toBeNull();
    expect(await mcpConnectionForPackSlug(`mcp-${'0'.repeat(32)}`, rows)).toBeNull();
  });

  it('returns null when nothing is enrolled', async () => {
    expect(await mcpConnectionForPackSlug(`mcp-${'0'.repeat(32)}`, [])).toBeNull();
  });
});

describe('D-225 — the two directions terminate', () => {
  it('⛔ does not recurse even when BOTH hooks are wired', async () => {
    // Production breaks the cycle by omitting the reverse hook from the deps
    // each direction hands the other. This test wires both anyway — the shape
    // production never builds — and proves the delete ORDERING stops it too:
    // `store.delete` runs BEFORE the teardown hook, so by the time the reverse
    // cascade looks the connection up, it is already gone.
    const name = await enrollMcp('peer');
    const slug = await mcpGeneratedPackSlug({ kind: 'mcp', name });
    const teardowns: string[] = [];
    const reverseLookups: string[] = [];

    // The reverse direction, as composition builds it: find the connection for
    // the slug and delete it — with the forward hook wired, which production
    // omits.
    const reverse = async (packSlug: string): Promise<string | null> => {
      reverseLookups.push(packSlug);
      const rows = store.list({ kind: 'mcp' }).map((r) => ({ kind: r.kind, name: r.name }));
      const found = await mcpConnectionForPackSlug(packSlug, rows);
      if (found === null) return null;
      await handleConnectionDelete(
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        { store, now: () => NOW, getEncryptionKey, teardownGeneratedPack: forward },
        { name: found.name, kind: 'mcp' },
      );
      return found.name;
    };
    const forward = async (packSlug: string): Promise<void> => {
      teardowns.push(packSlug);
      await reverse(packSlug);
    };

    await handleConnectionDelete(
      { store, now: () => NOW, getEncryptionKey, teardownGeneratedPack: forward },
      { name, kind: 'mcp' },
    );

    // One pass each. The connection was deleted before the teardown fired, so
    // the reverse lookup found nothing and the chain stopped.
    expect(teardowns).toEqual([slug]);
    expect(reverseLookups).toEqual([slug]);
    expect(store.get('mcp', name)).toBeNull();
  });

  it('the reverse direction is a no-op once the connection is gone', async () => {
    // The property the termination rests on, asserted directly.
    const name = await enrollMcp('peer');
    const slug = await mcpGeneratedPackSlug({ kind: 'mcp', name });
    await handleConnectionDelete(
      { store, now: () => NOW, getEncryptionKey },
      { name, kind: 'mcp' },
    );
    const rows = store.list({ kind: 'mcp' }).map((r) => ({ kind: r.kind, name: r.name }));
    expect(await mcpConnectionForPackSlug(slug, rows)).toBeNull();
  });
});
