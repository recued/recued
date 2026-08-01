/** D-225 § 12 — the badge actually goes `current` → `drifted`.
 *
 *  The claim this file exists to settle: an installed generated pack whose
 *  third-party server has changed its tool list REPORTS as drifted, once the
 *  idle probe has run.
 *
 *  🔑 Every component here is the production one — the real connection store,
 *  the real `handleConnectionProbe`, the real sweep, the real
 *  `handleMcpPackStatus`, and a real socket. The only thing not exercised is
 *  the ws transport that carries the rpc, and the boot wiring that registers
 *  the task; both were verified against a live server (`mcpToolsDriftProbeDeps
 *  = BUILT`, `Status: Running`) rather than asserted here.
 *
 *  ⛔ Why it must be a real listener rather than a stubbed probe: the whole
 *  finding behind § 12 was that `tool_hashes` had no writer on a cadence. A
 *  test that stubbed the probe would assert the sweep called something, which
 *  is precisely the shape of evidence that let the gap survive Slice 2.
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
import { mcpGeneratedPackSlug, mcpPackManifest } from '@recued/ingredient-authoring';

import {
  handleConnectionEnroll,
  handleConnectionProbe,
  handleMcpPackStatus,
} from '../connection-handler.js';
import { runMcpToolsDriftProbe } from '../housekeeping/tasks/mcp-tools-drift-probe.js';
import { handlePacksInstall } from '../pack-install-handler.js';
import { createConnectionStore, type ConnectionStoreSqlite } from '../storage/connection-store.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';
import {
  createLocalManifestStore,
  type LocalManifestStore,
} from '../ingredient-authoring/local-manifest-store.js';
import { createManifestRegistry, type ManifestRegistry } from '../manifest-loader.js';

const NOW = 1_700_000_000_000;
const NAME = 'peer-mcp';
const encryptionKey = new Uint8Array(32).fill(7);
const getEncryptionKey = (): Uint8Array => encryptionKey;

const TOOL_A: McpToolDescriptor = {
  name: 'project.list',
  description: 'List projects.',
  input_schema: { type: 'object', properties: { limit: { type: 'number' } } },
};
const TOOL_B: McpToolDescriptor = { name: 'project.create', description: 'Create a project.' };

let db: Database.Database;
let store: ConnectionStoreSqlite;
let recipeStore: RecipeStore;
let contractStore: ContractStore;
let localManifestStore: LocalManifestStore;
let registry: ManifestRegistry;
let server: Server;
let endpoint: string;
/** What the third party currently publishes. Mutated mid-test — that mutation
 *  IS the drift. */
let published: McpToolDescriptor[];

beforeEach(async () => {
  db = new Database(':memory:');
  store = createConnectionStore(db);
  recipeStore = createRecipeStore('/nonexistent-d225-drift', db);
  contractStore = createContractStore(db, { now: () => NOW });
  contractStore.seedSchema(D165_CONTRACT_SCHEMA);
  localManifestStore = createLocalManifestStore(db);
  registry = createManifestRegistry('/nonexistent-d225-drift');

  published = [TOOL_A, TOOL_B];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += String(c); });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { id?: unknown; method?: string };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: parsed.id ?? 1,
        result: parsed.method === 'tools/list'
          ? {
              tools: published.map((t) => ({
                name: t.name,
                ...(t.description ? { description: t.description } : {}),
                ...(t.input_schema ? { inputSchema: t.input_schema } : {}),
              })),
            }
          : {},
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  endpoint = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/rpc`;

  // ⛔ Enrolled through the REAL handler, not a hand-written row. A hand-written
  // row with an empty `auth_ciphertext` makes the probe bail before it opens a
  // socket and report `unknown` with NO `last_error` — which reads exactly like
  // "never probed" and would have made this whole file pass for the wrong
  // reason had it only asserted the negative direction.
  await handleConnectionEnroll(
    { store, now: () => NOW, getEncryptionKey },
    {
      name: NAME,
      kind: 'mcp',
      subtype: 'sse',
      display_name: NAME,
      config: { transport: 'sse', endpoint },
      auth: { type: 'bearer', token: 'secret' },
    } as never,
  );
});

afterEach(async () => {
  db.close();
  await new Promise<void>((r) => server.close(() => r()));
});

// ⚠ Built per-call, not once at module scope: `store` is assigned in
// `beforeEach`, so a module-level literal would capture `undefined`.
const probeDeps = () => ({ store, getEncryptionKey }) as Parameters<typeof handleConnectionProbe>[0];
const statusDeps = () => ({
  store,
  getInstalledCatalog: (slug: string) =>
    localManifestStore.getManifest(slug) as IngredientManifest | null,
}) as Parameters<typeof handleMcpPackStatus>[0];

/** The production sweep, over the production probe. */
const sweep = async () => runMcpToolsDriftProbe({
  listConnections: (q) => store.list(q),
  installedPackSlugFor: async (c) => {
    const slug = await mcpGeneratedPackSlug(c);
    return localManifestStore.getManifest(slug) === null ? null : slug;
  },
  probe: (args) => handleConnectionProbe(probeDeps(), args),
});

const installPack = async () => {
  const manifest = await mcpPackManifest({
    connection: { kind: 'mcp', name: NAME },
    descriptors: published,
  });
  const { result } = await handlePacksInstall(
    { recipeStore, contractStore, localManifestStore, registry, now: () => NOW },
    { manifest, granted_permissions: [BULK_PACK_INSTALL_PERMISSION] } as never,
    GENERATED_PACK_PUBLISHER,
  );
  if (!result.ok) throw new Error(result.failure?.message ?? 'install failed');
};

const status = () => handleMcpPackStatus(statusDeps(), { name: NAME, kind: 'mcp' });

describe('D-225 § 12 — the drift badge, over a real socket', () => {
  it('🔑 goes current → DRIFTED when the third party adds a tool', async () => {
    await installPack();

    // Before any probe the current side is absent — and that is `unknown`, not
    // a clean bill of health. This is the false-all-clear the status handler
    // was designed to avoid, and it is also the state Slice 2 left every
    // connection in permanently.
    expect((await status()).status).toBe('unknown');

    // The idle probe runs. THIS is what Slice 2 had no caller for.
    await sweep();
    expect((await status()).status).toBe('current');

    // The third party changes what it publishes. Nothing on this server moves.
    published = [TOOL_A, TOOL_B, { name: 'project.delete', description: 'Delete a project.' }];

    // ⛔ Without a probe the badge still reads `current` — the exact staleness
    // § 12 exists to end. Asserted so the next assertion cannot pass for the
    // wrong reason: it proves the transition is caused by the SWEEP and not by
    // the status handler re-deriving something on its own.
    expect((await status()).status).toBe('current');

    await sweep();
    const after = await status();
    expect(after.status).toBe('drifted');
    expect(after.added).toBe(1);
    expect(after.removed).toBe(0);
  });

  it('🔑 detects a tool MUTATED IN PLACE — same name, changed schema', async () => {
    // The case a name-based check is blind to, and the reason drift keys on
    // descriptor hashes. A mutated tool gets a different op id, so its grant
    // does not carry over; the badge is what tells the owner to re-review.
    await installPack();
    await sweep();
    expect((await status()).status).toBe('current');

    published = [
      { ...TOOL_A, input_schema: { type: 'object', properties: { limit: { type: 'string' } } } },
      TOOL_B,
    ];
    await sweep();

    const after = await status();
    expect(after.status).toBe('drifted');
    // One descriptor left, one arrived — the same tool NAME on both sides.
    expect(after.added).toBe(1);
    expect(after.removed).toBe(1);
  });

  it('stays `current` when nothing changed — the sweep is not self-dirtying', async () => {
    // A probe that re-hashed differently each run would paint every connection
    // drifted forever, and the badge would be ignored within a day.
    await installPack();
    await sweep();
    await sweep();
    expect((await status()).status).toBe('current');
  });

  it('⛔ a connection with NO pack is left alone by the sweep', async () => {
    // No install. The badge answers `no_pack`, and the sweep must not probe it.
    const before = await status();
    expect(before.status).toBe('no_pack');
    const r = await sweep();
    expect(r).toMatchObject({ probed: 0, skipped_no_pack: 1 });
  });
});
