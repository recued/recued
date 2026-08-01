/** D-225 — a GENERATED MCP pack, through the REAL install path.
 *
 *  ⛔ Everything else about D-225 is proven link by link: the transport
 *  dispatches, the generator mints, the manifest parses, the rpcs answer. What
 *  no test crossed until now is the JOINT — whether a pack minted from a
 *  third party's `tools/list` actually survives `handlePacksInstall` and lands
 *  as something the op layer can resolve.
 *
 *  Joints are where this kind of work fails, not links. "Every piece is unit
 *  proven" is the state that precedes a failing enrollment, not the state that
 *  rules one out.
 *
 *  This crosses: mint → decompose → stamp → REAL install → inventory →
 *  op-id resolution. The remaining half (a recipe op-step dispatching through
 *  the gateway to a live `tools/call`) needs the semi-live execution harness
 *  and is called out at the end rather than faked here.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BULK_PACK_INSTALL_PERMISSION,
  D165_CONTRACT_SCHEMA,
  GENERATED_PACK_PUBLISHER,
  parseOpId,
  RESERVED_GRANT_ENTRY_PREFIXES,
  RESERVED_HANDLES,
  type IngredientManifest,
  type McpToolDescriptor,
} from '@recued/contracts';
import {
  mcpGeneratedPackSlug,
  mcpPackManifest,
  mcpToolOpSegment,
} from '@recued/ingredient-authoring';

import { handlePacksInstall } from '../pack-install-handler.js';
import { buildPackOpResolution } from '../pack-inventory.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';
import {
  createLocalManifestStore,
  type LocalManifestStore,
} from '../ingredient-authoring/local-manifest-store.js';
import { createManifestRegistry, type ManifestRegistry } from '../manifest-loader.js';

const NOW = 1_700_000_000_000;
const CONNECTION = { kind: 'mcp', name: 'recued_peer' };

/** What a third-party MCP server published. */
const TOOLS: McpToolDescriptor[] = [
  {
    name: 'project.list',
    description: 'List projects.',
    input_schema: { type: 'object', properties: { limit: { type: 'number' } } },
  },
  { name: 'project.create', description: 'Create a project.' },
];

let db: Database.Database;
let recipeStore: RecipeStore;
let contractStore: ContractStore;
let localManifestStore: LocalManifestStore;
let registry: ManifestRegistry;

beforeEach(() => {
  db = new Database(':memory:');
  recipeStore = createRecipeStore('/nonexistent-d225-e2e', db);
  contractStore = createContractStore(db, { now: () => NOW });
  contractStore.seedSchema(D165_CONTRACT_SCHEMA);
  localManifestStore = createLocalManifestStore(db);
  registry = createManifestRegistry('/nonexistent-d225-e2e');
});
afterEach(() => db.close());

const install = async (descriptors: McpToolDescriptor[] = TOOLS) => {
  const manifest = await mcpPackManifest({ connection: CONNECTION, descriptors });
  const { result } = await handlePacksInstall(
    { recipeStore, contractStore, localManifestStore, registry, now: () => NOW },
    { manifest, granted_permissions: [BULK_PACK_INSTALL_PERMISSION] } as never,
    GENERATED_PACK_PUBLISHER,
  );
  return { manifest, result };
};

describe('D-225 — a generated MCP pack survives the REAL install path', () => {
  it('⛔ INSTALLS — the joint nothing crossed before', async () => {
    // Every failure mode this catches is at a seam: the publisher handling, the
    // composition branch, the inventory write. Each side was proven alone.
    const { manifest, result } = await install();
    if (!result.ok) throw new Error(result.failure?.message ?? 'install failed');

    const slug = String(manifest.slug);
    expect(contractStore.get('installed_pack', [slug])?.value).toBeDefined();
  });

  it('⛔ the INSTALLED catalog is authored `recued-local`, not first-party', async () => {
    // The defect the dispatch-joint test found, pinned at the cheaper layer.
    //
    // `decomposeComposition` stamps every body with `DEFAULT_AUTHOR`
    // (`recued-core`), and for a while nothing restamped it on this path — so a
    // pack minted from a third party's `tools/list` installed with a
    // first-party author and legacy slash-form op ids.
    //
    // ⚠ NOT a reserved-capability hole (an earlier comment here said it was):
    // `publisherMayDeclare` reads the PACK MANIFEST's publisher, always
    // `recued-local`. What it broke is § 9.6 — `opGrantEntry` returns the
    // operation_id verbatim, so the slash form made `isGeneratedPackOpEntry`
    // miss and the wildcard-door close silently did not apply.
    //
    // ⚠ This test file passed throughout, because it read the pack INVENTORY —
    // which carries `recued-local` from the manifest — and never the catalog.
    // The two disagreed and nothing reconciled them.
    const { manifest, result } = await install();
    if (!result.ok) throw new Error(result.failure?.message ?? 'install failed');

    const catalog = localManifestStore.getManifest(String(manifest.slug)) as IngredientManifest | null;
    expect(catalog!.author).toBe(GENERATED_PACK_PUBLISHER);

    // …and the op ids are the DOTTED Tier-P form a contract grant binds to,
    // not the decomposer's legacy `<author>/<pack>.<op>` slash form.
    for (const [key, spec] of Object.entries(catalog!.operations ?? {})) {
      const opId = (spec as { operation_id?: string }).operation_id;
      expect(opId).toBe(`${GENERATED_PACK_PUBLISHER}.${String(manifest.slug)}.${key}`);
      // ⚠ Narrow before reading `publisher` — it lives on `ParsedPackOp`, not
      // on the `ParsedOpId` union. Reading it unnarrowed passed vitest AND
      // `tsc -b` (neither typechecks test files) while being a type error.
      const parsed = parseOpId(opId!);
      if (parsed?.tier !== 'pack') throw new Error(`not a Tier-P op id: ${opId}`);
      expect(parsed.publisher).toBe(GENERATED_PACK_PUBLISHER);
    }
  });

  it('registers a catalog whose ops carry the mcp transport', async () => {
    // The pack is only useful if what landed is an MCP-bound catalog — an
    // install that succeeded while dropping the surface would look identical
    // from the result alone.
    const { manifest, result } = await install();
    if (!result.ok) throw new Error(result.failure?.message ?? 'install failed');

    const catalog = localManifestStore.getManifest(String(manifest.slug)) as IngredientManifest | null;
    expect(catalog).not.toBeNull();
    expect(catalog!.surfaces?.api?.transport).toBe('mcp');

    const executes = catalog!.surfaces?.api?.executes ?? {};
    const tools = Object.values(executes).map((b) => (b as { tool?: string }).tool).sort();
    expect(tools).toEqual(['project.create', 'project.list']);
  });

  it('🔑 the installed ops RESOLVE as Tier-P — reachable by an op-step', async () => {
    // The question behind "is it accessible normally via pack op". The op-step
    // lowering resolves `<publisher>.<pack>.<operation>` off this same
    // inventory, so a generated pack resolving here is what makes a recipe able
    // to name one.
    const { manifest, result } = await install();
    if (!result.ok) throw new Error(result.failure?.message ?? 'install failed');

    const resolution = buildPackOpResolution(
      () => [...contractStore.scan('installed_pack')].map((r) => ({
        segments: r.segments,
        value: r.value,
      })),
      (slug) => localManifestStore.getManifest(slug) as IngredientManifest | null,
    );

    const packRef = `${GENERATED_PACK_PUBLISHER}.${String(manifest.slug)}`;
    const binding = resolution.get(packRef);
    expect(binding, `no resolution for ${packRef}`).toBeDefined();

    // …and the op id a recipe would write parses as a pack op.
    const op = await mcpToolOpSegment(TOOLS[0]!);
    const opId = `${packRef}.${op}`;
    expect(binding!.operations).toContain(op);
    const parsed = parseOpId(opId);
    if (parsed?.tier !== 'pack') throw new Error(`not a Tier-P op id: ${opId}`);
    expect(parsed.publisher).toBe(GENERATED_PACK_PUBLISHER);
  });

  it('the pack slug is the one the connection derives — so destroy can find it', async () => {
    // The reverse lookup recomputes the derivation rather than storing a map;
    // if the INSTALLED slug ever diverged from the derived one, teardown would
    // silently find nothing.
    const { manifest } = await install();
    expect(manifest.slug).toBe(await mcpGeneratedPackSlug(CONNECTION));
  });

  it('a ONE-TOOL server installs too — the force_catalog_lowering case, end to end', async () => {
    // Proven at the decomposer in slice 2; this is the same case through the
    // real install, where a plain-ingredient lowering would have produced
    // something with no operations map to register at all.
    const { manifest, result } = await install([{ name: 'ping' }]);
    if (!result.ok) throw new Error(result.failure?.message ?? 'install failed');

    const catalog = localManifestStore.getManifest(String(manifest.slug)) as IngredientManifest | null;
    expect(Object.keys(catalog?.operations ?? {})).toHaveLength(1);
  });

  // ⏭ NOT covered: a recipe op-step dispatching through the gateway to a live
  // `tools/call` on a loopback listener. That needs the semi-live execution
  // harness (`provider-mock-pack-semi-live`), and faking it here — asserting a
  // stub was called instead of a socket receiving JSON-RPC — would prove the
  // one thing already proven (slice 1's gateway test) while implying the joint
  // that is not.
});

// ── D-225 § 9.9 ────────────────────────────────────────────────────────────
describe('D-225 § 9.9 — the grant-entry prefixes are unclaimable handles', () => {
  it('⛔ `data` and `enrichment` are RESERVED — a stamped pack cannot mint a colliding op id', async () => {
    // A stamped pack's operation_id is `<publisher>.<pack>.<key>`. If a
    // publisher could hold `data` or `enrichment`, its ops would land inside
    // the reserved grant-entry namespace: `opGrantEntry` throws, and a stored
    // key classifies as a `collection` rather than an `op` — the fail-closed
    // admission bug `grant-entry.ts` warns about, arriving via the handle.
    //
    // 🔑 The older SLASH form could not collide (a `/` before any `.`). The
    // dotted stamp broke that invariant; this restores it by construction.
    for (const handle of ['data', 'enrichment']) {
      expect(RESERVED_HANDLES.has(handle), `'${handle}' must be reserved`).toBe(true);
    }
  });

  it('🔑 every RESERVED grant-entry prefix has its bare handle reserved', () => {
    // Derived from the prefix list rather than hard-coded, so adding a fourth
    // grant-entry prefix without reserving its handle fails HERE instead of in
    // whatever pack first trips over it.
    for (const prefix of RESERVED_GRANT_ENTRY_PREFIXES) {
      const handle = prefix.replace(/\.$/, '');
      expect(RESERVED_HANDLES.has(handle), `prefix '${prefix}' => handle '${handle}'`).toBe(true);
    }
  });
});
