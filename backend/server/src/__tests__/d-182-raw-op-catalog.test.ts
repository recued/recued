/** D-182 §8 step 7 — raw catalog-op door exposure suite.
 *
 *  A door MAY expose installed Tier-P pack ops (`recued_op_<publisher>.<pack>.
 *  <operation>`) to an external LLM without a recipe. The grant catalog offers
 *  grantable raw READ + WRITE ops, `tools/list` advertises the granted ones, and
 *  the default grants turn raw reads ON / raw writes OFF. The §8 KIND fence
 *  (cli/service never raw) + the recipe-preferred WRITE suppression (Inc
 *  B-writes — a write a recipe covers is dropped) apply on both surfaces.
 *
 *  Runs the REAL `buildPackOpResolution` + the REAL grant-catalog / tools-list
 *  projections over a registered catalog + a scripted installed-pack inventory. */

import { describe, expect, it } from 'vitest';

import { createManifestRegistry } from '../manifest-loader.js';
import {
  _testing,
  buildMcpGrantCatalogLegacyEntries,
  buildRecipeOpCoverage,
} from '../mcp-server.js';
import { buildPackOpResolution } from '../pack-inventory.js';
import {
  buildDefaultMcpInboundTokenGrants,
  type ExecutionSource,
  type IngredientManifest,
  type ProviderSurfaces,
  type ScanFn,
  type ToolEntry,
} from '@recued/contracts';

// ── fixtures ─────────────────────────────────────────────────────────

/** A normal connection-kind catalog (externally exposable) with a READ op +
 *  a WRITE op. The per-op `risk_tier` (Invariant 1) drives raw-op classification. */
const crmCatalog: IngredientManifest = {
  slug: 'crm-catalog',
  name: 'CRM',
  description: 'A CRM catalog.',
  author: 'recued-core',
  kind: 'connection',
  version: 1,
  category: 'data',
  risk_tier: 'read',
  tags: [],
  input: {},
  output: {},
  operations: {
    'deal.search': { operation_id: 'deal.search', risk_tier: 'read', description: 'Search deals.' },
    'deal.create': { operation_id: 'deal.create', risk_tier: 'write', description: 'Create a deal.' },
  },
};

/** A cli catalog (cli_invocation connector runtime) WITH a read op — §8-fenced
 *  from raw exposure despite declaring operations. */
const whisperCli: IngredientManifest = {
  slug: 'whisper-catalog',
  name: 'Whisper',
  description: 'Transcribe audio with a local binary.',
  author: 'recued-core',
  kind: 'connection',
  version: 1,
  category: 'action',
  risk_tier: 'read',
  tags: [],
  input: {},
  output: {},
  operations: {
    'audio.transcribe': { operation_id: 'audio.transcribe', risk_tier: 'read', description: 'Transcribe.' },
  },
  surfaces: {
    connector: {
      runtime: {
        transport: 'stdio',
        wire_protocol: 'cli_invocation',
        package_ref: 'system_binary:whisper',
        entry_point: 'whisper',
        expected_protocol_version: 1,
      },
    },
  } as unknown as ProviderSurfaces,
};

const registry = () => {
  const m = createManifestRegistry('/nonexistent');
  m.register(crmCatalog);
  m.register(whisperCli);
  return m;
};

/** Installed-pack inventory: `recued-core.crm-pack` → crm-catalog,
 *  `recued-core.whisper-pack` → whisper-catalog (cli, §8-fenced). */
const PACK_ROWS = [
  { segments: ['crm-pack'], value: { publisher: 'recued-core', ingredient_ids: ['crm-catalog'] } },
  { segments: ['whisper-pack'], value: { publisher: 'recued-core', ingredient_ids: ['whisper-catalog'] } },
];
const scan = ((scope: string) => (scope === 'installed_pack' ? PACK_ROWS : [])) as ScanFn;
const scanInstalledPacks = () => scan('installed_pack', []);

const READ_OP = 'recued_op_recued-core.crm-pack.deal.search';
const WRITE_OP = 'recued_op_recued-core.crm-pack.deal.create';
const CLI_OP = 'recued_op_recued-core.whisper-pack.audio.transcribe';

const depsFor = (gate?: (name: string) => boolean) =>
  ({
    executorConfig: { manifests: registry() },
    contractScan: scan,
    baseVault: {},
    ...(gate ? { inboundTokenAuthorize: gate } : {}),
  }) as unknown as Parameters<typeof _testing.handleToolsList>[0];

// ════════════════════════════════════════════════════════════════════

describe('grant catalog raw-op projection', () => {
  it('offers raw READ + WRITE ops, not cli/service ops', () => {
    const names = buildMcpGrantCatalogLegacyEntries(registry(), scanInstalledPacks).map((e) => e.name);
    expect(names).toContain(READ_OP);
    expect(names).toContain(WRITE_OP); // Inc B-writes — writes emitted (default OFF)
    expect(names).not.toContain(CLI_OP); // §8 KIND fence
  });

  it('classifies the raw write op as write', () => {
    const entry = buildMcpGrantCatalogLegacyEntries(registry(), scanInstalledPacks).find(
      (e) => e.name === WRITE_OP,
    );
    expect(entry?.classification).toBe('write');
  });

  it('suppresses a raw WRITE op a recipe already covers (recipe-preferred)', () => {
    // A recipe with an `op:` step on `deal.create` covers that write → the raw
    // primitive is suppressed (the AI is steered to the guardrailed recipe).
    const coverage = buildRecipeOpCoverage({
      ids: () => ['cover-deal-create'],
      get: () =>
        ({ steps: [{ id: 's', op: 'recued-core.crm-pack.deal.create' }] }) as never,
    });
    const names = buildMcpGrantCatalogLegacyEntries(registry(), scanInstalledPacks, coverage).map(
      (e) => e.name,
    );
    expect(names).not.toContain(WRITE_OP); // suppressed — a recipe covers it
    expect(names).toContain(READ_OP); // reads are unaffected
  });

  it('maps a lowered ingredient-step write to its op id + suppresses it (with the pack resolution)', () => {
    // A recipe authored / persisted as an `ingredient:` step — catalog slug
    // `crm-catalog` + `input.operation: 'deal.create'` — covers the SAME write as
    // the `op:` form. The pack resolution maps the (catalog, operation) pair back
    // to the op id, so the raw write is suppressed too (the safe-direction gap
    // this closes).
    const reg = registry();
    const resolution = buildPackOpResolution(scanInstalledPacks, (s) => reg.get(s));
    const coverage = buildRecipeOpCoverage(
      {
        ids: () => ['cover-via-ingredient'],
        get: () =>
          ({
            steps: [
              { id: 's', ingredient: 'crm-catalog', input: { operation: 'deal.create' } },
            ],
          }) as never,
      },
      resolution,
    );
    expect(coverage.has('recued-core.crm-pack.deal.create')).toBe(true);
    const names = buildMcpGrantCatalogLegacyEntries(reg, scanInstalledPacks, coverage).map(
      (e) => e.name,
    );
    expect(names).not.toContain(WRITE_OP); // suppressed via the ingredient-step
    expect(names).toContain(READ_OP); // reads unaffected
  });

  it('does NOT cover an ingredient-step write without the resolution (op-step-only; the safe direction)', () => {
    // Omitting the resolution keeps the legacy op-step-only walk: an
    // ingredient-covered write is NOT mapped to an op id, so the raw write stays
    // VISIBLE (over-exposure, never hiding — the owner can still narrow it).
    const coverage = buildRecipeOpCoverage({
      ids: () => ['cover-via-ingredient'],
      get: () =>
        ({
          steps: [{ id: 's', ingredient: 'crm-catalog', input: { operation: 'deal.create' } }],
        }) as never,
    });
    expect(coverage.has('recued-core.crm-pack.deal.create')).toBe(false);
    const names = buildMcpGrantCatalogLegacyEntries(registry(), scanInstalledPacks, coverage).map(
      (e) => e.name,
    );
    expect(names).toContain(WRITE_OP); // stays visible — op-step-only coverage
  });

  it('ignores ingredient-steps whose catalog / operation is not in the resolution (no false suppression)', () => {
    // Unknown catalog slug, an operation the catalog doesn't declare, and a step
    // with no `input.operation` all contribute nothing — guards the reverse-index
    // lookup so a near-miss never suppresses an unrelated op.
    const reg = registry();
    const resolution = buildPackOpResolution(scanInstalledPacks, (s) => reg.get(s));
    const coverage = buildRecipeOpCoverage(
      {
        ids: () => ['noise'],
        get: () =>
          ({
            steps: [
              { id: 'a', ingredient: 'unknown-catalog', input: { operation: 'deal.create' } },
              { id: 'b', ingredient: 'crm-catalog', input: { operation: 'no.such.op' } },
              { id: 'c', ingredient: 'crm-catalog' },
            ],
          }) as never,
      },
      resolution,
    );
    expect(coverage.size).toBe(0);
  });

  it('classifies the raw read op as read', () => {
    const entry = buildMcpGrantCatalogLegacyEntries(registry(), scanInstalledPacks).find(
      (e) => e.name === READ_OP,
    );
    expect(entry?.classification).toBe('read');
    expect(entry?.arg_schema).toMatchObject({ properties: { connection: { type: 'string' } } });
  });

  it('emits NO raw ops without the installed-pack scan (back-compatible)', () => {
    const names = buildMcpGrantCatalogLegacyEntries(registry()).map((e) => e.name);
    expect(names.some((n) => n.startsWith('recued_op_'))).toBe(false);
  });
});

describe('tools/list raw-op advertisement', () => {
  it('the owner (no gate) sees raw read + write ops, not cli ops', async () => {
    const res = (await _testing.handleToolsList(depsFor())) as { tools: Array<{ name: string }> };
    const names = res.tools.map((t) => t.name);
    expect(names).toContain(READ_OP);
    expect(names).toContain(WRITE_OP); // Inc B-writes — emitted (no recipe covers it here)
    expect(names).not.toContain(CLI_OP);
  });

  it('suppresses a recipe-covered raw WRITE in tools/list', async () => {
    const recipeStore = {
      ids: () => ['cover'],
      get: () => ({ steps: [{ id: 's', op: 'recued-core.crm-pack.deal.create' }] }) as never,
    };
    const res = (await _testing.handleToolsList({
      ...depsFor(),
      recipeStore,
    } as unknown as Parameters<typeof _testing.handleToolsList>[0])) as {
      tools: Array<{ name: string }>;
    };
    const names = res.tools.map((t) => t.name);
    expect(names).not.toContain(WRITE_OP); // recipe covers it → suppressed
    expect(names).toContain(READ_OP);
  });

  it('suppresses an ingredient-step-covered raw WRITE in tools/list (call-site wiring)', async () => {
    // The handleToolsList call site builds the pack resolution from deps + passes
    // it to buildRecipeOpCoverage, so a recipe that writes via a lowered
    // `ingredient:` step (catalog `crm-catalog` + operation `deal.create`)
    // suppresses the raw write end-to-end — proves the resolution is wired in,
    // not just unit-tested on buildRecipeOpCoverage.
    const recipeStore = {
      ids: () => ['cover-via-ingredient'],
      get: () =>
        ({
          steps: [{ id: 's', ingredient: 'crm-catalog', input: { operation: 'deal.create' } }],
        }) as never,
    };
    const res = (await _testing.handleToolsList({
      ...depsFor(),
      recipeStore,
    } as unknown as Parameters<typeof _testing.handleToolsList>[0])) as {
      tools: Array<{ name: string }>;
    };
    const names = res.tools.map((t) => t.name);
    expect(names).not.toContain(WRITE_OP); // ingredient-step covers it → suppressed
    expect(names).toContain(READ_OP);
  });

  it('a door sees ONLY its granted raw ops (per-token gate)', async () => {
    const res = (await _testing.handleToolsList(depsFor((n) => n === READ_OP))) as {
      tools: Array<{ name: string }>;
    };
    const names = res.tools.map((t) => t.name);
    expect(names).toContain(READ_OP);
    // ai-classify is not granted by this gate → filtered out alongside everything else.
    expect(names).not.toContain('recued_ingredient_crm-catalog');
  });

  it('an un-granted raw op is not advertised to a door', async () => {
    const res = (await _testing.handleToolsList(depsFor(() => false))) as {
      tools: Array<{ name: string }>;
    };
    expect(res.tools.map((t) => t.name)).not.toContain(READ_OP);
  });

  it('an admitted seller customer sees raw ops from its contract, not its token checklist', async () => {
    const tokenGate = (_name: string): boolean => false;
    const res = (await _testing.handleToolsList({
      ...depsFor(tokenGate),
      boundContractId: 'customer-contract',
      boundContractActive: true,
      customerContractGrants: true,
      opAdmissionGate: {
        isFrozenByPause: () => false,
        isOpGranted: (_source: ExecutionSource, opId: string | undefined) =>
          opId === 'recued-core.crm-pack.deal.search',
      },
    } as unknown as Parameters<typeof _testing.handleToolsList>[0])) as {
      tools: Array<{ name: string }>;
    };
    const names = res.tools.map((tool) => tool.name);
    expect(names).toContain(READ_OP);
    expect(names).not.toContain(WRITE_OP);
    // Non-raw tools keep the ordinary per-token checklist and remain hidden.
    expect(names).not.toContain('recued_listRecipes');
  });
});

describe('Inc D — default grants for raw ops', () => {
  const entry = (name: string, classification: 'read' | 'write'): ToolEntry => ({
    name,
    tier: 2,
    description: name,
    arg_schema: {},
    topic_tags: [],
    classification,
    concurrency_safe: false,
  });

  it('raw READ defaults ON; raw WRITE defaults OFF (recipe-preferred)', () => {
    const grants = buildDefaultMcpInboundTokenGrants([
      entry(READ_OP, 'read'),
      entry(WRITE_OP, 'write'),
    ]);
    expect(grants[READ_OP]).toBe(true);
    expect(grants[WRITE_OP]).toBe(false);
  });

  it('a tier-2 legacy ingredient read still defaults OFF (raw-op rule does not leak)', () => {
    const grants = buildDefaultMcpInboundTokenGrants([entry('recued_ingredient_crm-catalog', 'read')]);
    expect(grants['recued_ingredient_crm-catalog']).toBe(false);
  });

  it('end-to-end: a server-built catalog defaults its raw read op ON (prefix in sync)', () => {
    // Catches drift between mcp-server `OP_TOOL_PREFIX` + the contracts-side
    // `RAW_OP_TOOL_PREFIX`: the catalog is built by the server, the default by
    // contracts — they must agree on `recued_op_` for the read to default ON.
    const catalog = buildMcpGrantCatalogLegacyEntries(registry(), scanInstalledPacks);
    const grants = buildDefaultMcpInboundTokenGrants(catalog);
    expect(grants[READ_OP]).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
// D-192 Slice 7 — a raw write op discloses the container reads it admits
// ════════════════════════════════════════════════════════════════════

describe('grant catalog raw-op also_reads (D-192 Slice 7)', () => {
  // A Linear-shaped work-entity catalog: `issue.create` (write) binds a `team`
  // dependency whose `list_op` is the READ `team.search`.
  const linearCatalog: IngredientManifest = {
    slug: 'linear-catalog', name: 'Linear', description: 'Linear.',
    author: 'recued-core', kind: 'connection', version: 1, category: 'data',
    risk_tier: 'read', tags: [], input: {}, output: {},
    operations: {
      'issue.search': { operation_id: 'issue.search', risk_tier: 'read', description: 'Search issues.' },
      'issue.create': { operation_id: 'issue.create', risk_tier: 'write', description: 'Create an issue.' },
      'team.search': { operation_id: 'team.search', risk_tier: 'read', description: 'Search teams.' },
    },
    work_entity_sources: [
      {
        kind: 'task',
        ops: { list: 'issue.search', create: 'issue.create' },
        source_dependencies: [
          {
            ref: 'team', list_op: 'team.search', id_field: 'id', label_field: 'name',
            binds: [{ op: 'create', arg: 'teamId' }], resolve: 'prompt',
          },
        ],
      },
    ],
  } as unknown as IngredientManifest;

  const reg = () => {
    const m = createManifestRegistry('/nonexistent');
    m.register(linearCatalog);
    return m;
  };
  const linearScan = (() => [
    { segments: ['linear-pack'], value: { publisher: 'recued-core', ingredient_ids: ['linear-catalog'] } },
  ]) as unknown as typeof scanInstalledPacks;

  const CREATE = 'recued_op_recued-core.linear-pack.issue.create';
  const SEARCH = 'recued_op_recued-core.linear-pack.issue.search';
  const TEAM = 'recued_op_recued-core.linear-pack.team.search';

  it('attaches also_reads to the raw write op that binds a container dependency', () => {
    const entry = buildMcpGrantCatalogLegacyEntries(reg(), linearScan).find((e) => e.name === CREATE);
    expect(entry?.also_reads).toEqual([{ ref: 'team', list_op: 'team.search' }]);
  });

  it('does NOT attach also_reads to ops binding no dependency (issue.search / team.search)', () => {
    const catalog = buildMcpGrantCatalogLegacyEntries(reg(), linearScan);
    for (const name of [SEARCH, TEAM]) {
      expect(catalog.find((e) => e.name === name)?.also_reads).toBeUndefined();
    }
  });
});
