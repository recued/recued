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
import { buildRawOpToolDescriptors, visibleRawOps } from '../raw-op-tool-catalog.js';
import {
  createChatRawOpDispatch,
  createChatRawOpSource,
  projectRawOpOutcome,
} from '../chat-tool-handlers.js';
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
    // D-228 slice 6 — "no gate" in this suite means THE OWNER, which is now
    // stated positively: an absent checklist denies. When a `gate` IS supplied
    // the caller is a door, so the owner claim is dropped and the checklist
    // governs — otherwise every `gate`-passing test here would admit regardless
    // of what the gate said, and the filter assertions would prove nothing.
    ...(gate ? { inboundTokenAuthorize: gate } : { ownerAdmitAll: true }),
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

  it('advertises a closed operation request schema beside the required connection selector', () => {
    const closedCatalog = {
      ...crmCatalog,
      operations: {
        ...crmCatalog.operations,
        'deal.search': {
          ...crmCatalog.operations?.['deal.search'],
          request_schema: {
            type: 'object',
            additionalProperties: false,
            required: ['query'],
            properties: {
              query: { type: 'string', minLength: 1 },
              limit: { type: 'integer', minimum: 1, maximum: 100 },
            },
          },
        },
      },
    } as IngredientManifest;
    const descriptor = buildRawOpToolDescriptors(
      scanInstalledPacks,
      (slug) => slug === closedCatalog.slug ? closedCatalog : registry().get(slug),
    ).find((entry) => entry.wireName === READ_OP);

    expect(descriptor?.inputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['connection', 'query'],
      properties: {
        connection: expect.objectContaining({ type: 'string' }),
        query: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    });
  });

  /** ⛔⛔ A DESCRIPTIVE SCHEMA IS STILL THE BEST AVAILABLE AI CONTRACT.
   *
   *  This door used to require `isClosedRequestSchema` and fall back to
   *  `{ connection, additionalProperties: true }` otherwise, so 3,539 operations
   *  whose parameters are fully documented in their pack advertised NONE of them
   *  and the model had to guess argument names that were sitting in the manifest.
   *
   *  🔑 The flag it keyed on answers a different question. `additionalProperties:
   *  false` means "the gateway REFUSES an undeclared argument", and earning it
   *  needs every value bounded — bounds vendor specs mostly do not state, and
   *  which 1,746 operations can never have because the vendor accepts arbitrary
   *  keys. None of that bears on whether the argument NAMES are worth publishing.
   *
   *  ⚠ AND THE DESCRIPTIVE PATH MUST NOT LOOK LIKE A GATE. `additionalProperties`
   *  stays TRUE — the accurate statement of a dispatcher that admits anything.
   *  The assertions below pin the DIFFERENCE between the two paths, because a
   *  descriptive schema that advertised `false` would be this repo's own
   *  "assurance-shaped non-assurance": a promise no runtime keeps. */
  it('advertises a DESCRIPTIVE schema too, without claiming it is enforced', () => {
    const descriptiveCatalog = {
      ...crmCatalog,
      operations: {
        ...crmCatalog.operations,
        'deal.search': {
          ...crmCatalog.operations?.['deal.search'],
          request_schema: {
            type: 'object',
            // No `maxLength`, a free-form nested object, an unbounded array:
            // this schema can NEVER opt in, which is precisely the case that
            // used to be advertised as nothing at all.
            required: ['query'],
            properties: {
              query: { type: 'string' },
              filters: { type: 'object' },
              tags: { type: 'array', items: { type: 'string', nullable: true } },
            },
          },
        },
      },
    } as IngredientManifest;
    const descriptor = buildRawOpToolDescriptors(
      scanInstalledPacks,
      (slug) => slug === descriptiveCatalog.slug ? descriptiveCatalog : registry().get(slug),
    ).find((entry) => entry.wireName === READ_OP);

    expect(descriptor?.inputSchema).toEqual({
      type: 'object',
      // ⛔ TRUE, and that is the whole contract of this path.
      additionalProperties: true,
      required: ['connection', 'query'],
      properties: {
        connection: expect.objectContaining({ type: 'string' }),
        query: { type: 'string' },
        filters: { type: 'object' },
        // `nullable` is OpenAPI, not JSON Schema — a strict validator rejects an
        // unknown keyword rather than ignoring it, and a rejected `inputSchema`
        // costs the model the whole tool.
        tags: { type: 'array', items: { type: 'string' } },
      },
    });
  });

  it('⛔ still falls back to the permissive descriptor when there is nothing to say', () => {
    // THE CONTROL. Without it, a change that advertised the permissive schema
    // for EVERY op would pass the assertion above while proving nothing — and a
    // change that projected something for an op with no schema would invent a
    // contract out of an absence.
    const bareCatalog = {
      ...crmCatalog,
      operations: {
        ...crmCatalog.operations,
        'deal.search': { ...crmCatalog.operations?.['deal.search'], request_schema: undefined },
      },
    } as IngredientManifest;
    const descriptor = buildRawOpToolDescriptors(
      scanInstalledPacks,
      (slug) => slug === bareCatalog.slug ? bareCatalog : registry().get(slug),
    ).find((entry) => entry.wireName === READ_OP);
    expect(descriptor?.inputSchema).toEqual({
      type: 'object',
      properties: { connection: expect.objectContaining({ type: 'string' }) },
      additionalProperties: true,
    });
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

describe('D-225 § 9.5.1 — the CHAT catalog gets the same raw-op source', () => {
  /** ⛔ The gap this closes: the raw-op projection scans installed packs and
   *  derives each tool's classification from the pack's AUTHORED `risk_tier` —
   *  no annotation store anywhere. It was bound to the inbound door alone, and
   *  that was the entire reason declared pack ops had no chat presence. Nothing
   *  about it was door-specific; chat has its own catalog and never received
   *  the source. */
  const chatDeps = (scan?: typeof scanInstalledPacks) => ({
    getExecutorConfig: () => ({ manifests: registry() }),
    ...(scan ? { scanInstalledPacks: scan } : {}),
  }) as unknown as Parameters<typeof createChatRawOpSource>[0];

  it('🔑 emits BYTE-IDENTICAL rows to the door', () => {
    // One op must not describe itself differently to chat than to the door —
    // the owner's single grant covers both, so two descriptions would be one op
    // wearing two faces.
    const chat = createChatRawOpSource(chatDeps(scanInstalledPacks))();
    const door = buildMcpGrantCatalogLegacyEntries(registry(), scanInstalledPacks)
      .filter((e) => e.name.startsWith('recued_op_'));

    expect(chat.length).toBeGreaterThan(0);
    expect(JSON.stringify(chat)).toBe(JSON.stringify(door));
  });

  it('carries the classification from the pack’s AUTHORED risk_tier', () => {
    const chat = createChatRawOpSource(chatDeps(scanInstalledPacks))();
    for (const entry of chat) {
      expect(['read', 'write', 'unknown']).toContain(entry.classification);
      expect(entry.tier).toBe(2);
      expect(entry.name.startsWith('recued_op_')).toBe(true);
    }
  });

  it('honours the §8 KIND fence — a cli catalog contributes nothing', () => {
    // `whisper-catalog` is cli and must never reach either catalog. Inherited
    // from the shared builder rather than re-implemented, which is the point of
    // sharing it.
    const names = createChatRawOpSource(chatDeps(scanInstalledPacks))().map((e) => e.name);
    expect(names.some((n) => n.includes('whisper'))).toBe(false);
  });

  it('⚠ emits NOTHING when no pack scan is wired — today’s behaviour, unchanged', () => {
    // The dep is optional so every dbless / partial harness keeps working. That
    // absence is also exactly what the gap WAS, so it must stay explicit rather
    // than become an accident again.
    expect(createChatRawOpSource(chatDeps())()).toEqual([]);
  });

  // ── D-247 open item 2 — §8 suppression, on the CHAT source ────────────
  //
  // ⛔⛔ THE GAP: `createChatRawOpSource` called the descriptor builder with TWO
  // args while the door passed THREE, so a raw WRITE an installed recipe covers
  // stayed visible to chat — while `wire-chat-orchestrator`, which has always
  // passed coverage, had already suppressed it in the GRANT CATALOG next to it.
  // The owner's checklist and the model's tool list disagreed about the same op.

  /** Deps carrying a recipe store whose recipe covers the write op. */
  const chatDepsWithRecipe = (
    steps: ReadonlyArray<unknown>,
  ): Parameters<typeof createChatRawOpSource>[0] => ({
    getExecutorConfig: () => ({ manifests: registry() }),
    scanInstalledPacks,
    getRecipeStore: () => ({
      ids: () => ['cover-deal-create'],
      get: () => ({ steps }) as never,
    }),
  }) as unknown as Parameters<typeof createChatRawOpSource>[0];

  it('⛔ suppresses a raw WRITE an installed recipe covers (op-step form)', () => {
    const names = createChatRawOpSource(
      chatDepsWithRecipe([{ id: 's', op: 'recued-core.crm-pack.deal.create' }]),
    )().map((e) => e.name);
    expect(names).not.toContain(WRITE_OP); // the recipe is the guardrailed path
    expect(names).toContain(READ_OP); // reads are AI-open, unaffected
  });

  it('⛔ and via a lowered INGREDIENT step — which needs the same pack resolution', () => {
    // The half that silently fails if the resolution is omitted: an
    // `ingredient:`-authored write maps to no op id, so nothing suppresses.
    const names = createChatRawOpSource(
      chatDepsWithRecipe([
        { id: 's', ingredient: 'crm-catalog', input: { operation: 'deal.create' } },
      ]),
    )().map((e) => e.name);
    expect(names).not.toContain(WRITE_OP);
    expect(names).toContain(READ_OP);
  });

  it('🔑 chat and the door suppress the SAME op — one doctrine, one answer', () => {
    const steps = [{ id: 's', op: 'recued-core.crm-pack.deal.create' }];
    const chat = createChatRawOpSource(chatDepsWithRecipe(steps))();
    const reg = registry();
    const coverage = buildRecipeOpCoverage(
      { ids: () => ['cover-deal-create'], get: () => ({ steps }) as never },
      buildPackOpResolution(scanInstalledPacks, (slug) => reg.get(slug)),
    );
    const door = buildMcpGrantCatalogLegacyEntries(reg, scanInstalledPacks, coverage)
      .filter((e) => e.name.startsWith('recued_op_'));
    expect(chat.length).toBeGreaterThan(0);
    expect(JSON.stringify(chat)).toBe(JSON.stringify(door));
  });

  it('⚠ no recipe store ⇒ no suppression, and the write stays VISIBLE', () => {
    // `wire-reception-substrate` supplies `getRecipeStore` through a conditional
    // spread, so absence is reachable in production despite the required type.
    // Over-exposure is the module's documented safe direction — the op is still
    // gated by its own grant — but it must be a decision someone reads.
    const names = createChatRawOpSource(chatDeps(scanInstalledPacks))().map((e) => e.name);
    expect(names).toContain(WRITE_OP);
  });
});

describe('D-225 § 9.5.1 step 2b — the chat raw-op DISPATCH', () => {
  const ctx = { execution_source: { channel: 'chat', actor: 'user_self' } } as never;
  const dispatchDeps = {} as never;

  it('refuses a non-raw-op tool name', async () => {
    const d = createChatRawOpDispatch({ getRawOpDispatchDeps: () => dispatchDeps } as never);
    const r = await d('work.search', {}, ctx);
    expect(r).toMatchObject({ ok: false, reason: 'invalid_args' });
    if (r.ok) throw new Error('unreachable');
    expect(r.detail).toMatch(/not a raw catalog op/);
  });

  it('⚠ reports unavailable rather than throwing when no dispatch deps are wired', async () => {
    // A host that offered the tools without the dispatch would advertise calls
    // it cannot make. Degrading honestly beats a stack trace at call time.
    const d = createChatRawOpDispatch({} as never);
    const r = await d('recued_op_pub.pack.op', {}, ctx);
    expect(r).toMatchObject({ ok: false, reason: 'execution_error' });
    if (r.ok) throw new Error('unreachable');
    expect(r.detail).toMatch(/unavailable/);
  });

  // ── the projection — the one-ask property ──────────────────────────────
  //
  // 🔑 Reached by extracting `projectRawOpOutcome` as a PURE function rather
  // than injecting a fake dispatcher. The behaviour worth pinning is what the
  // agent is TOLD about a held run, not that a stub was called — a test-only
  // dependency seam would have put a hole in production shape to observe
  // something that was never about the dependency.

  it('🔑 HELD projects to awaiting_approval — the ONE ASK, not a second one', () => {
    const r = projectRawOpOutcome({ kind: 'held', op_id: 'pub.pack.op', run_id: 'r1' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r).toMatchObject({
      run_held: { kind: 'approval' },
      run_id: 'r1',
      result: {
        status: 'awaiting_approval',
        awaiting_approval: true,
        op: 'pub.pack.op',
      },
    });
  });

  it('⛔ a HELD run is a SUCCESS, never an error envelope', () => {
    // An error tells a weak model to retry, which is the loop the door's own
    // handler avoids. The message must also say do-not-resend and tell-the-user,
    // or the model has no instruction other than to try again.
    const r = projectRawOpOutcome({ kind: 'held', op_id: 'pub.pack.op', run_id: 'r1' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    const message = String((r.result as { message: string }).message);
    expect(message).toMatch(/do not resend/i);
    expect(message).toMatch(/tell the user/i);
  });

  it('an ASK (hold substrate unwired) is also a success, and self-describing', () => {
    const r = projectRawOpOutcome({ kind: 'ask', op_id: 'pub.pack.op', message: 'needs approval' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.result).toMatchObject({ status: 'requires_approval', op: 'pub.pack.op' });
  });

  it('⛔ REFUSED is the one that IS an error — the paired direction', () => {
    // Without this the "held is not an error" tests would pass on a projection
    // that never errors at all.
    const r = projectRawOpOutcome({ kind: 'refused', message: 'not granted' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r).toMatchObject({ reason: 'execution_error', detail: 'not granted' });
  });

  it('a plain result passes through untouched', () => {
    const payload = { rows: [1, 2, 3] };
    expect(projectRawOpOutcome({ kind: 'result', result: payload }))
      .toEqual({ ok: true, result: payload });
  });
});

describe('D-225 § 9.8 — visibleRawOps: the caller-facing catalog comes from the contract', () => {
  const universe = () => buildRawOpToolDescriptors(scanInstalledPacks, (s) => registry().get(s));

  it('a caller sees only what its contract grants', () => {
    const all = universe();
    expect(all.length).toBeGreaterThan(1);
    const only = all[0]!.opId;
    const visible = visibleRawOps(all, (opId) => opId === only);
    expect(visible.map((d) => d.opId)).toEqual([only]);
  });

  it('a PERMISSIVE caller (owner / wildcard door) sees the whole universe', () => {
    // ⚠ The reason the signature takes a UNIVERSE. For these callers the granted
    // set is not enumerable from grant rows — it is everything minus exclusions
    // — so a `visibleOps(contract)` with no universe input could not answer.
    const all = universe();
    expect(visibleRawOps(all, () => true)).toEqual(all);
  });

  it('an explicit-only contract with no rows sees NOTHING', () => {
    // Customer / reception / PUBLIC fail closed. The paired direction of the
    // permissive case — without it, "sees everything" would pass on a filter
    // that never filters.
    expect(visibleRawOps(universe(), () => false)).toEqual([]);
  });

  it('⛔ does NOT filter the owner’s GRANT CHOOSER — that would be chicken-and-egg', () => {
    // `buildMcpGrantCatalogLegacyEntries` feeds the per-tool grant checklist. If
    // it showed only granted ops the owner could never grant a new one, because
    // an ungranted op would not be listed. Derived-from-contract is for
    // CALLER-facing catalogs; what the owner may grant is a different question.
    const chooser = buildMcpGrantCatalogLegacyEntries(registry(), scanInstalledPacks)
      .filter((e) => e.name.startsWith('recued_op_'));
    expect(chooser.length).toBe(universe().length);
    expect(chooser.length).toBeGreaterThan(0);
  });

  it('is a pure filter — it re-decides nothing about admission', () => {
    // The resolution stays `isOpGranted` / `opAuthorDefault` /
    // `ownerOnlyAdjustedAuthorDefault`, already correct and already tested. This
    // composes them with the universe; a second copy of the policy here is
    // exactly the drift the shared function exists to prevent.
    const all = universe();
    const seen: string[] = [];
    visibleRawOps(all, (opId) => { seen.push(opId); return true; });
    expect(seen).toEqual(all.map((d) => d.opId));
  });
});

describe('D-225 § 9.8.1 — chat’s catalog FILTERS by the turn’s contract', () => {
  /** ⛔ THE DENY CASE, WRITTEN FIRST.
   *
   *  A grant filter that receives an undefined source and treats it as
   *  permissive admits EVERYTHING, and is indistinguishable from a working one
   *  in any test that only checks the admit path. So the first assertion is the
   *  one where a caller is granted nothing and must therefore see nothing. */
  const sourceful = { channel: 'chat', actor: 'user_self' } as ExecutionSource;

  const chatSource = (opts: {
    gate?: { isOpGranted: (s: ExecutionSource, o: string | undefined) => boolean };
    source?: ExecutionSource;
  }) =>
    createChatRawOpSource({
      getExecutorConfig: () => ({ manifests: registry() }),
      scanInstalledPacks,
      ...(opts.gate ? { getOpAdmissionGate: () => opts.gate } : {}),
    } as never)(opts.source);

  it('⛔ a caller granted NOTHING sees NO raw ops', () => {
    const entries = chatSource({ gate: { isOpGranted: () => false }, source: sourceful });
    expect(entries).toEqual([]);
  });

  it('⛔ an ABSENT source denies — it must never read as permissive', () => {
    // `TurnContext.source` is optional ("only for bare test harnesses"), so an
    // absent one is reachable. Treating it as permissive is precisely the
    // silent fail-open this whole ordering exists to prevent.
    const entries = chatSource({ gate: { isOpGranted: () => true } });
    expect(entries).toEqual([]);
  });

  it('a granted caller sees exactly what it was granted', () => {
    // The permitting half — without it, the two denials above would pass on a
    // source that returns nothing at all.
    const all = buildRawOpToolDescriptors(scanInstalledPacks, (s) => registry().get(s));
    const only = all[0]!.opId;
    const entries = chatSource({
      gate: { isOpGranted: (_s, opId) => opId === only },
      source: sourceful,
    });
    expect(entries.map((e) => e.name)).toEqual([`recued_op_${only}`]);
  });

  it('⚠ with NO gate wired the catalog is unfiltered — today’s behaviour, explicit', () => {
    // A host with no admission gate keeps working. That is deliberate and is
    // why it is pinned: it must be a decision someone reads, not a hole.
    const entries = chatSource({ source: sourceful });
    expect(entries.length).toBeGreaterThan(0);
  });
});
