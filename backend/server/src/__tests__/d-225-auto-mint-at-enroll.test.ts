/** D-225 auto-mint — ENROLLING AN MCP CONNECTION MINTS ITS PACK.
 *
 *  Three claims, and only the first is the feature:
 *
 *  1. enrolling mints, without a second owner Save;
 *  2. ⛔ a server that is DOWN still ENROLS — the connection row lands, the pack
 *     does not, and the outcome says so. Everything about the retry sweep rests
 *     on this: if enroll refused, there would be no packless row to come back to;
 *  3. ⛔⛔ it never RE-mints. `mcp-tools-drift-probe` states the governing rule
 *     (*"The probe writes a HASH; only the owner writes a GRANT"*) and it is a
 *     rule about editing past an authorization the owner already gave. A first
 *     mint has none to edit past; a second does.
 *
 *  ⚠ Every one of these is asserted through the REAL `handleConnectionEnroll`
 *  over a REAL connection store, because the whole point is what the enroll rpc
 *  does — a test that called `firstMintGeneratedPack` directly would certify a
 *  function nobody had wired.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  firstMintGeneratedPack,
  handleConnectionEnroll,
  handleMcpPackPreview,
  type ConnectionRpcDeps,
} from '../connection-handler.js';
import { mcpGeneratedPackSlug, mcpToolOpSegment } from '@recued/ingredient-authoring';
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

/** A server that answers `initialize` then returns `tools` verbatim. */
const serverWith = (tools: unknown[]): HttpFetcher =>
  vi.fn<HttpFetcher>(async (_url, init) => {
    const body = JSON.parse(init?.body ?? '{}') as { method?: string };
    if (body.method === 'initialize') {
      return jsonResponse(200, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } });
    }
    return jsonResponse(200, { jsonrpc: '2.0', id: 2, result: { tools } });
  });

/** A host that can install AND can tell whether a pack is already installed —
 *  the two conditions auto-mint needs before it will act. The installed set is
 *  REAL state, so "already installed" is observed the same way production
 *  observes it, not stubbed as a boolean. */
const host = (fetcher: HttpFetcher, extra: Partial<ConnectionRpcDeps> = {}) => {
  const installed = new Map<string, unknown>();
  const deps: ConnectionRpcDeps = {
    store,
    now: () => NOW,
    getEncryptionKey,
    fetcher,
    installGeneratedPack: async (manifest: unknown) => {
      installed.set(String((manifest as { slug: unknown }).slug), manifest);
    },
    getInstalledCatalog: (slug: string) =>
      (installed.has(slug) ? ({ slug } as IngredientManifest) : null),
    ...extra,
  };
  return { deps, installed };
};

const enroll = (deps: ConnectionRpcDeps, name = 'peer', config?: Record<string, unknown>) =>
  handleConnectionEnroll(deps, {
    name,
    kind: 'mcp',
    subtype: 'sse',
    display_name: name,
    config: { endpoint: 'https://mcp.example.test/rpc', transport: 'sse', ...config },
    auth: { type: 'bearer', token: 'secret' },
  });

const opsOf = (manifest: unknown): string[] =>
  ((manifest as { contents: { composition: { operations: { op: string }[] } }[] })
    .contents[0]!.composition.operations).map((o) => o.op);

describe('D-225 auto-mint — enrolling an mcp connection mints its pack', () => {
  it('mints at enroll, with no second Save', async () => {
    const { deps, installed } = host(serverWith([
      { name: 'project.list', inputSchema: { type: 'object' } },
      { name: 'project.create' },
    ]));

    const result = await enroll(deps);

    const slug = await mcpGeneratedPackSlug({ kind: 'mcp', name: 'peer' });
    expect(result.generated_pack).toMatchObject({
      status: 'minted',
      pack_slug: slug,
      operations: 2,
      reflected_dropped: 0,
    });
    // The ARTIFACT, not the call: one op per tool actually landed.
    expect(opsOf(installed.get(slug))).toHaveLength(2);
  });

  it('⛔ a DOWN server still ENROLS — the row lands, the pack is deferred', async () => {
    // The premise the whole retry sweep rests on. If enroll refused here, an
    // owner could not save a connection to a machine that is merely asleep, and
    // there would be no packless row for the sweep to walk.
    const dead: HttpFetcher = async () => { throw new Error('dns failed'); };
    const { deps, installed } = host(dead);

    const result = await enroll(deps);

    expect(result.connection.name).toBe('peer');
    expect(store.get('mcp', 'peer')).toBeTruthy();
    expect(result.generated_pack?.status).toBe('deferred');
    expect(installed.size).toBe(0);
  });

  it('⛔⛔ NEVER re-mints — a second enroll over an existing pack is refused', async () => {
    const { deps, installed } = host(serverWith([{ name: 'project.list' }]));
    await enroll(deps);
    const slug = await mcpGeneratedPackSlug({ kind: 'mcp', name: 'peer' });
    const firstManifest = installed.get(slug);

    // The server has since grown a tool. A re-mint would silently widen what the
    // pack declares — the exact move `mcp-tools-drift-probe` forbids unattended.
    const grown = host(serverWith([{ name: 'project.list' }, { name: 'wire_money' }]));
    // Same installed state, new tool list.
    grown.installed.set(slug, firstManifest);
    const again = await enroll(grown.deps);

    expect(again.generated_pack).toEqual({
      status: 'skipped',
      reason: 'already_installed',
      pack_slug: slug,
    });
    expect(grown.installed.get(slug)).toBe(firstManifest);
    expect(opsOf(grown.installed.get(slug))).toHaveLength(1);
  });

  it('⛔ a host that CANNOT tell whether a pack exists refuses to mint', async () => {
    // "Cannot look up" is not "looked, found nothing". Guessing `no pack` would
    // turn every enroll on a registry-less host into an unattended RE-mint.
    const { deps, installed } = host(serverWith([{ name: 'a' }]));
    const blind: ConnectionRpcDeps = { ...deps };
    delete blind.getInstalledCatalog;

    const result = await enroll(blind);

    expect(result.generated_pack).toMatchObject({
      status: 'skipped',
      reason: 'catalog_lookup_unavailable',
    });
    expect(installed.size).toBe(0);
  });

  it('a host with no installer skips cleanly — the enroll is unaffected', async () => {
    // The pre-auto-mint harness shape (dbless / partial): no install surface at
    // all. The connection must still enrol exactly as it always did.
    const result = await handleConnectionEnroll(
      { store, now: () => NOW, getEncryptionKey },
      {
        name: 'peer',
        kind: 'mcp',
        subtype: 'sse',
        display_name: 'peer',
        config: { endpoint: 'https://mcp.example.test/rpc', transport: 'sse' },
        auth: { type: 'bearer', token: 'secret' },
      },
    );
    expect(result.connection.name).toBe('peer');
    expect(result.generated_pack).toMatchObject({
      status: 'skipped',
      reason: 'installer_unavailable',
    });
  });

  it('a NON-mcp enroll reports no pack outcome at all', async () => {
    const { deps } = host(serverWith([]));
    const result = await handleConnectionEnroll(deps, {
      name: 'an-api',
      kind: 'api',
      display_name: 'an-api',
      config: { base_url: 'https://api.example.test' },
      auth: { type: 'bearer', token: 's' },
    });
    expect(result.generated_pack).toBeUndefined();
  });
});

describe('D-225 auto-mint — the loopback diff, through the real enroll', () => {
  const PEER_CONTRACT = 'contract_peer_b';

  /** What server B publishes when it has already enrolled US: its own tool, plus
   *  ours relayed through its generated pack. Built with the real derivation. */
  const peerToolsReflecting = async (ourToolName: string): Promise<unknown[]> => [
    { name: 'summarise_thread' },
    {
      name: `recued_op_recued-local.mcp-0123456789abcdef0123456789abcdef.`
        + `${await mcpToolOpSegment({ name: ourToolName })}`,
    },
  ];

  it('⛔ subtracts OUR tool coming back through the peer, and mints only theirs', async () => {
    const ourTool = 'recued_op_recued-core.crm.create_deal';
    const { deps, installed } = host(
      serverWith(await peerToolsReflecting(ourTool)),
      { exposedToolNamesForPeerContract: () => [ourTool] },
    );

    const result = await enroll(deps, 'peer', { peer_contract_id: PEER_CONTRACT });

    expect(result.generated_pack).toMatchObject({
      status: 'minted',
      operations: 1,
      reflected_dropped: 1,
    });
    const slug = await mcpGeneratedPackSlug({ kind: 'mcp', name: 'peer' });
    const ops = opsOf(installed.get(slug));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatch(/^summarise_thread_[a-f0-9]{8}$/);
  });

  it('⛔ WITHOUT a peer_contract_id the resolver is never consulted', async () => {
    // The degrade path, asserted on the CALL rather than on the outcome: an
    // ordinary third-party server has no relationship to reflect through, so
    // asking "what do we expose to it" is meaningless and must not happen.
    const resolver = vi.fn(() => ['recued_op_recued-core.crm.create_deal']);
    const { deps, installed } = host(
      serverWith(await peerToolsReflecting('recued_op_recued-core.crm.create_deal')),
      { exposedToolNamesForPeerContract: resolver },
    );

    const result = await enroll(deps, 'peer');

    expect(resolver).not.toHaveBeenCalled();
    expect(result.generated_pack).toMatchObject({ status: 'minted', operations: 2 });
    const slug = await mcpGeneratedPackSlug({ kind: 'mcp', name: 'peer' });
    expect(opsOf(installed.get(slug))).toHaveLength(2);
  });

  it('the PREVIEW hides the same reflection, and names what it hid', async () => {
    // ⛔ Not cosmetic. `mcpPackCommit`'s `reviewed_ops` guard compares the
    // owner's reviewed set against a fresh probe, so a preview that showed the
    // reflection would make every commit fail `conflict` — blaming the peer for
    // our own asymmetry.
    const ourTool = 'recued_op_recued-core.crm.create_deal';
    const reflected = await peerToolsReflecting(ourTool);
    const { deps } = host(serverWith(reflected), {
      exposedToolNamesForPeerContract: () => [ourTool],
    });
    await enroll(deps, 'peer', { peer_contract_id: PEER_CONTRACT });

    const view = await handleMcpPackPreview(deps, { name: 'peer', kind: 'mcp' });

    expect(view.rows.map((r) => r.tool)).toEqual(['summarise_thread']);
    expect(view.reflected_dropped)
      .toEqual([(reflected[1] as { name: string }).name]);
  });
});

describe('D-225 auto-mint — firstMintGeneratedPack reports, never throws', () => {
  it('turns a probe failure into a `deferred` outcome the sweep can count', async () => {
    // ⛔ The property the housekeeping sweep depends on: one unreachable
    // connection must not abort the connections after it. If this threw, the
    // sweep's own try/catch would still hold — but the ENROLL would not, and
    // that is the case with no second chance.
    const dead: HttpFetcher = async () => { throw new Error('econnrefused'); };
    const { deps } = host(dead);
    await enroll(deps, 'peer');

    const outcome = await firstMintGeneratedPack(deps, { kind: 'mcp', name: 'peer' });

    expect(outcome.status).toBe('deferred');
    expect(outcome).toMatchObject({ reason: expect.stringContaining('probe did not return') });
  });
});
