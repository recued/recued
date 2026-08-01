/** D-225 — the DISPATCH joint: an installed generated pack's op, over a real socket.
 *
 *  The last unproven joint. The install joint is crossed
 *  (`d-225-generated-pack-install-e2e`); this one asks whether an op on the
 *  INSTALLED catalog actually reaches a third-party MCP server as a well-formed
 *  JSON-RPC `tools/call`.
 *
 *  🔑 It runs against a REAL loopback listener, not a stubbed fetch. An MCP
 *  connection's address is `config.endpoint` — a CONNECTION-ROW field — so
 *  pointing it at a local server is a database write, needing no seam and no env
 *  var. What the listener receives is what a real server would.
 *
 *  ⛔ The manifest is the one the REAL install path registered, not a hand-built
 *  fixture. A fixture here would be a second source of truth and would prove the
 *  gateway works on a manifest nothing produces.
 */
import { createServer, type Server } from 'node:http';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BULK_PACK_INSTALL_PERMISSION,
  D165_CONTRACT_SCHEMA,
  GENERATED_PACK_PUBLISHER,
  type IngredientManifest,
  type McpToolDescriptor,
} from '@recued/contracts';
import { mcpPackManifest, mcpToolOpSegment } from '@recued/ingredient-authoring';
import { createConnectionMcpHandler } from '@recued/ingredients';
import { runCatalogOperation } from '@recued/engine';
import type { ExecutionContext, IngredientExecutor } from '@recued/engine';

import { handlePacksInstall } from '../pack-install-handler.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';
import {
  createLocalManifestStore,
  type LocalManifestStore,
} from '../ingredient-authoring/local-manifest-store.js';
import { createManifestRegistry, type ManifestRegistry } from '../manifest-loader.js';

const NOW = 1_700_000_000_000;
const CONNECTION_NAME = 'recued_peer';
const CONNECTION = { kind: 'mcp', name: CONNECTION_NAME };
const TOOL: McpToolDescriptor = {
  name: 'project.list',
  description: 'List projects.',
  input_schema: { type: 'object', properties: { limit: { type: 'number' } } },
};

let db: Database.Database;
let recipeStore: RecipeStore;
let contractStore: ContractStore;
let localManifestStore: LocalManifestStore;
let registry: ManifestRegistry;
let server: Server;
let endpoint: string;
/** Every JSON-RPC body the listener received — the evidence. */
let received: Record<string, unknown>[];

beforeEach(async () => {
  db = new Database(':memory:');
  recipeStore = createRecipeStore('/nonexistent-d225-dispatch', db);
  contractStore = createContractStore(db, { now: () => NOW });
  contractStore.seedSchema(D165_CONTRACT_SCHEMA);
  localManifestStore = createLocalManifestStore(db);
  registry = createManifestRegistry('/nonexistent-d225-dispatch');

  received = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += String(c); });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as Record<string, unknown>;
      received.push(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: parsed.id,
        result: { content: [{ type: 'text', text: 'ok' }], projects: ['p1'] },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  endpoint = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/rpc`;
});

afterEach(async () => {
  db.close();
  await new Promise<void>((r) => server.close(() => r()));
});

/** The connection row the mcp handler dispatches against — its `endpoint` is
 *  the loopback listener, which is the whole trick: an address is DATA. */
const connectionRow = () => ({
  pk: 1,
  kind: 'mcp' as const,
  name: CONNECTION_NAME,
  display_name: CONNECTION_NAME,
  config: { transport: 'sse', endpoint },
  config_json: JSON.stringify({ transport: 'sse', endpoint }),
  enrolled_at: NOW,
  updated_at: NOW,
});

/** Install the generated pack the REAL way, and return what landed. */
const installed = async (): Promise<{ catalog: IngredientManifest; slug: string }> => {
  const manifest = await mcpPackManifest({ connection: CONNECTION, descriptors: [TOOL] });
  const { result } = await handlePacksInstall(
    { recipeStore, contractStore, localManifestStore, registry, now: () => NOW },
    { manifest, granted_permissions: [BULK_PACK_INSTALL_PERMISSION] } as never,
    GENERATED_PACK_PUBLISHER,
  );
  if (!result.ok) throw new Error(result.failure?.message ?? 'install failed');
  const slug = String(manifest.slug);
  const catalog = localManifestStore.getManifest(slug) as IngredientManifest | null;
  if (!catalog) throw new Error('catalog not registered');
  return { catalog, slug };
};

const dispatch = async (opts: { admitted: boolean }) => {
  const { catalog, slug } = await installed();
  const op = await mcpToolOpSegment(TOOL);
  const opId = `${GENERATED_PACK_PUBLISHER}.${slug}.${op}`;

  const mcpHandler = createConnectionMcpHandler({
    decodeAuth: async () => ({ type: 'bearer', token: 'secret' }),
    persistAuth: async () => undefined,
    // fetchImpl omitted ⇒ the real globalThis.fetch, so a real socket.
  } as never);

  let ctx: ExecutionContext;
  // ⛔ (slug, input, stepOutput, stepOptions, stepMeta). Taking the 3rd as
  // stepOptions shifts by one, `stepMeta.preflight_admitted` arrives undefined,
  // and the approval gate re-fires forever — a symptom that reads as a broken
  // approval contract rather than a wiring slip.
  const ingredientExecutor: IngredientExecutor = async (
    s, input, _stepOutput, stepOptions, stepMeta,
  ) => {
    const resolved = input as Record<string, unknown>;
    // ⛔ The gateway dispatches its resolved wire params back under the SAME
    // catalog slug. The two directions are told apart by payload SHAPE: a
    // catalog CALL carries `operation`; the gateway's dispatch carries `tool`.
    // Routing on the slug alone recurses forever.
    if (s === slug && typeof resolved.operation === 'string') {
      return runCatalogOperation(
        ctx, catalog, slug, resolved, CONNECTION_NAME, undefined, stepOptions, stepMeta,
      );
    }
    return mcpHandler(
      connectionRow() as never,
      resolved,
      { slug: 'connection', risk_tier: 'write', input: {}, output: {} } as never,
    );
  };

  ctx = {
    recipe: { recipe_id: 'r1' } as never,
    stores: {} as never,
    ingredientExecutor,
    // ⛔ Required, or the gateway denies `no_connection_profile`. This grant is
    // what installing the pack produces.
    connectionProfileResolver: () => ({
      allowed_operations: Object.keys(catalog.operations ?? {}),
    }),
  } as unknown as ExecutionContext;

  const stepMeta = opts.admitted
    ? {
        preflight_admitted: true,
        preflight_approved_target: {
          ingredient_slug: slug,
          operation_id: `${GENERATED_PACK_PUBLISHER}.${slug}.${op}`,
          connection_name: CONNECTION_NAME,
        },
      }
    : undefined;

  return {
    opId,
    run: () => ingredientExecutor(
      slug,
      { operation: op, connection: CONNECTION_NAME, args: { limit: 50 } },
      undefined as never,
      undefined as never,
      stepMeta as never,
    ),
  };
};

describe('D-225 — the dispatch joint, over a real socket', () => {
  it('🔑 an installed generated op reaches the server as a real tools/call', async () => {
    const { run } = await dispatch({ admitted: true });
    await run();

    // The evidence: a JSON-RPC body actually arrived on the wire.
    const call = received.find((b) => b.method === 'tools/call');
    expect(call, `no tools/call received; got ${JSON.stringify(received)}`).toBeDefined();

    // ⛔ The TOOL NAME comes from the BINDING, not from anything the caller
    // passed — the structural property the whole declared path rests on.
    expect((call!.params as { name: string }).name).toBe('project.list');
    expect((call!.params as { arguments: unknown }).arguments).toMatchObject({ limit: 50 });
  });

  it('⛔ a NON-admitted run reaches the server NOT AT ALL', async () => {
    // Every generated op is `write` + `ask`, so an unapproved run must hold
    // BEFORE the third party is touched. The paired direction of the test
    // above — without it, "it dispatched" would pass on a gate that never held.
    const { run } = await dispatch({ admitted: false });
    await run().catch(() => undefined);
    expect(received.filter((b) => b.method === 'tools/call')).toEqual([]);
  });
});
