/** D-225 auto-mint — `mcp-pack-first-mint`, the retry and the backfill.
 *
 *  A server that was down when its connection was enrolled leaves a row with no
 *  pack. So does every connection enrolled before auto-mint existed. This sweep
 *  is what comes back for both, and the two are the same condition.
 *
 *  ⛔ IT RUNS THE REAL MINT. `McpPackFirstMintDeps.firstMint` is bound to the
 *  production `firstMintGeneratedPack` over a real connection store and a real
 *  installed-pack map, because a stubbed mint would let this file certify a
 *  sweep that probes nothing and installs nothing — the exact failure
 *  `mcp-tools-drift-probe`'s own header refuses for the same reason.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  firstMintGeneratedPack,
  handleConnectionEnroll,
  type ConnectionRpcDeps,
} from '../connection-handler.js';
import {
  MCP_PACK_FIRST_MINT_TASK_ID,
  buildMcpPackFirstMintTask,
  runMcpPackFirstMint,
  type McpPackFirstMintDeps,
} from '../housekeeping/tasks/mcp-pack-first-mint.js';
import { mcpGeneratedPackSlug } from '@recued/ingredient-authoring';
import type { IngredientManifest } from '@recued/contracts';
import type { HttpFetcher } from '../connection-vendor-oauth.js';
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

const jsonResponse = (status: number, body: unknown = {}): Awaited<ReturnType<HttpFetcher>> => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/** One fetcher for the whole fleet: a connection whose endpoint contains `dead`
 *  refuses, everything else answers with one tool. Routing on the URL rather
 *  than on a per-call counter keeps "which server was reached" a property of the
 *  connection under test instead of of call ORDER. */
const fleetFetcher = (): HttpFetcher =>
  vi.fn<HttpFetcher>(async (url, init) => {
    if (String(url).includes('dead')) throw new Error('econnrefused');
    const body = JSON.parse(init?.body ?? '{}') as { method?: string };
    if (body.method === 'initialize') {
      return jsonResponse(200, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } });
    }
    return jsonResponse(200, {
      jsonrpc: '2.0',
      id: 2,
      result: { tools: [{ name: `tool_of_${String(url).replace(/\W+/g, '_')}` }] },
    });
  });

const buildHost = () => {
  const installed = new Map<string, unknown>();
  const deps: ConnectionRpcDeps = {
    store,
    now: () => NOW,
    getEncryptionKey,
    fetcher: fleetFetcher(),
    installGeneratedPack: async (manifest: unknown) => {
      installed.set(String((manifest as { slug: unknown }).slug), manifest);
    },
    getInstalledCatalog: (slug: string) =>
      (installed.has(slug) ? ({ slug } as IngredientManifest) : null),
  };
  const sweepDeps: McpPackFirstMintDeps = {
    listConnections: (query) => store.list(query),
    firstMint: (connection) => firstMintGeneratedPack(deps, connection),
  };
  return { deps, installed, sweepDeps };
};

/** Enrol WITHOUT the mint wired, so the row lands packless exactly as it would
 *  have before auto-mint shipped — which is what the backfill population is. */
const enrolPackless = async (name: string, host = 'peer.example.test'): Promise<void> => {
  await handleConnectionEnroll(
    { store, now: () => NOW, getEncryptionKey },
    {
      name,
      kind: 'mcp',
      subtype: 'sse',
      display_name: name,
      config: { endpoint: `https://${host}/rpc`, transport: 'sse' },
      auth: { type: 'bearer', token: 'secret' },
    },
  );
};

describe('runMcpPackFirstMint', () => {
  it('mints the packless, skips the packed, defers the unreachable — in one sweep', async () => {
    const { deps, installed, sweepDeps } = buildHost();
    await enrolPackless('reachable');
    await enrolPackless('unreachable', 'dead.example.test');
    await enrolPackless('already');
    // `already` gets its pack the ordinary way first.
    const alreadySlug = await mcpGeneratedPackSlug({ kind: 'mcp', name: 'already' });
    expect((await firstMintGeneratedPack(deps, { kind: 'mcp', name: 'already' })).status)
      .toBe('minted');

    const result = await runMcpPackFirstMint(sweepDeps);

    expect(result).toEqual({
      minted: 1,
      skipped_has_pack: 1,
      skipped_unavailable: 0,
      deferred: 1,
    });
    // The ARTIFACT: the reachable one landed, the dead one did not, and the
    // already-packed one was not touched a second time.
    const reachableSlug = await mcpGeneratedPackSlug({ kind: 'mcp', name: 'reachable' });
    const deadSlug = await mcpGeneratedPackSlug({ kind: 'mcp', name: 'unreachable' });
    expect(installed.has(reachableSlug)).toBe(true);
    expect(installed.has(alreadySlug)).toBe(true);
    expect(installed.has(deadSlug)).toBe(false);
  });

  it('⛔ a deferred connection is retried on the NEXT sweep once its server is back', async () => {
    // The whole reason the task exists. `no_pack` never stops being true, so the
    // sweep keeps coming back — and this asserts it through two real runs rather
    // than by reading the loop.
    const installed = new Map<string, unknown>();
    let up = false;
    const deps: ConnectionRpcDeps = {
      store,
      now: () => NOW,
      getEncryptionKey,
      fetcher: async (_url, init) => {
        if (!up) throw new Error('econnrefused');
        const body = JSON.parse(init?.body ?? '{}') as { method?: string };
        if (body.method === 'initialize') {
          return jsonResponse(200, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } });
        }
        return jsonResponse(200, { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'later' }] } });
      },
      installGeneratedPack: async (manifest: unknown) => {
        installed.set(String((manifest as { slug: unknown }).slug), manifest);
      },
      getInstalledCatalog: (slug: string) =>
        (installed.has(slug) ? ({ slug } as IngredientManifest) : null),
    };
    const sweepDeps: McpPackFirstMintDeps = {
      listConnections: (query) => store.list(query),
      firstMint: (connection) => firstMintGeneratedPack(deps, connection),
    };
    await enrolPackless('asleep');

    expect(await runMcpPackFirstMint(sweepDeps)).toMatchObject({ minted: 0, deferred: 1 });
    up = true;
    expect(await runMcpPackFirstMint(sweepDeps)).toMatchObject({ minted: 1, deferred: 0 });
    // And a THIRD sweep must not mint again — the boundary holds across cycles.
    expect(await runMcpPackFirstMint(sweepDeps)).toMatchObject({
      minted: 0,
      skipped_has_pack: 1,
    });
  });

  it('counts "cannot tell" apart from "nothing to do"', async () => {
    // A host with no manifest registry cannot say whether a pack exists, so the
    // mint refuses. Folding that into `skipped_has_pack` would report a wiring
    // failure as a healthy steady state.
    const { deps, sweepDeps } = buildHost();
    delete deps.getInstalledCatalog;
    await enrolPackless('a');
    await enrolPackless('b');

    expect(await runMcpPackFirstMint(sweepDeps)).toEqual({
      minted: 0,
      skipped_has_pack: 0,
      skipped_unavailable: 2,
      deferred: 0,
    });
  });

  it('a mint that THROWS is counted and the sweep continues past it', async () => {
    // `firstMintGeneratedPack` reports its failures rather than throwing, so
    // reaching the catch means something below it broke. The connections AFTER
    // the broken one must still be minted.
    const { installed, sweepDeps, deps } = buildHost();
    await enrolPackless('boom');
    await enrolPackless('fine');
    const seen: string[] = [];
    const errors: string[] = [];
    const wrapped: McpPackFirstMintDeps = {
      listConnections: sweepDeps.listConnections,
      firstMint: async (connection) => {
        seen.push(connection.name);
        if (connection.name === 'boom') throw new Error('store exploded');
        return firstMintGeneratedPack(deps, connection);
      },
      onMintError: (name) => errors.push(name),
    };

    const result = await runMcpPackFirstMint(wrapped);

    expect(seen).toContain('fine');
    expect(errors).toEqual(['boom']);
    expect(result).toMatchObject({ minted: 1, deferred: 1 });
    expect(installed.has(await mcpGeneratedPackSlug({ kind: 'mcp', name: 'fine' }))).toBe(true);
  });

  it('an owner with no mcp connections is a no-op, not an error', async () => {
    const { sweepDeps } = buildHost();
    expect(await runMcpPackFirstMint(sweepDeps)).toEqual({
      minted: 0,
      skipped_has_pack: 0,
      skipped_unavailable: 0,
      deferred: 0,
    });
  });
});

describe('buildMcpPackFirstMintTask', () => {
  it('registers as a non-interruptible core task and completes in one step', async () => {
    // NOT interruptible is load-bearing: `step()` keeps no partial cursor, so a
    // scheduler that handed it a sliver of budget would start work it cannot
    // resume.
    const { sweepDeps } = buildHost();
    await enrolPackless('one');
    const task = buildMcpPackFirstMintTask({ deps: sweepDeps });

    expect(task.meta.id).toBe(MCP_PACK_FIRST_MINT_TASK_ID);
    expect(task.meta.interruptible).toBe(false);
    expect(task.meta.kind).toBe('core');

    const outcome = await task.step(
      {} as never,
      { kind: 'start' } as never,
      1_000,
    );
    expect(outcome.status).toBe('complete');
  });
});
