/** D-177 P3 session-grant mint surface tests. */

import Database from 'better-sqlite3';
import {
  STDIO_MCP_TOKEN_ID,
  D165_CONTRACT_SCHEMA,
  matchesSessionGrant,
  resolveSessionGrantOffer,
  type Checkpoint,
  type ContractSnapshot,
  type ContractDefinition,
  type ExecutionSource,
  type IngredientManifest,
  type RecipeDefinition,
  type RecipeStep,
  type SessionGrantMintContext,
} from '@recued/contracts';
import type { ExecutionResult } from '@recued/engine';
import {
  ALLOW_SESSION_ASK_OPTION,
  PREFLIGHT_ASK_OPTIONS,
  type PreflightAskContext,
  type PreflightNotifier,
} from '@recued/gateway';
import {
  buildAuditEntry,
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
  type CheckpointStore,
  type CommitStore,
} from '@recued/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const executeRecipeMock = vi.hoisted(() => vi.fn());

vi.mock('@recued/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@recued/engine')>();
  return {
    ...actual,
    executeRecipe: executeRecipeMock,
  };
});

import {
  _testing as executeHandlerTesting,
  handleExecute,
  type ExecuteHandlerDeps,
} from '../execute-handler.js';
import { createManifestRegistry, type ManifestRegistry } from '../manifest-loader.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { createRecipeStore } from '../recipe-store.js';
import { createSessionGrantResolver } from '../session-grant-resolver.js';
import type { SessionGrantResolver } from '../session-grant-resolver.js';
import type { CatalogSessionGrantHooks } from '@recued/engine';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';
import {
  createContractDefinitionStore,
  type ContractDefinitionStore,
} from '../storage/contract-definition-store.js';

const NOW = 1_700_000_000_000;
const STARTED_AT = NOW - 5_000;
const TOOL_SLUG = 'mail.send';
const STEP_ID = 'gated_step';

interface DefinitionHarness {
  db: Database.Database;
  store: ContractStore;
  defStore: ContractDefinitionStore;
}

const createDefinitionHarness = (): DefinitionHarness => {
  const db = new Database(':memory:');
  const store = createContractStore(db, { now: () => NOW });
  store.seedSchema(D165_CONTRACT_SCHEMA);
  let idSeq = 0;
  const defStore = createContractDefinitionStore(store, {
    now: () => NOW,
    newId: () => {
      idSeq += 1;
      return `ct_${idSeq}`;
    },
  });
  return { db, store, defStore };
};

let harness: DefinitionHarness;
let defStore: ContractDefinitionStore;

const chatSource: ExecutionSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'chat-1',
  user_id: 'user-1',
};

// N.14.6 — the owner's OWN local stdio / CLI client. The mcp channel forces it to
// `contracted_user` + a `contract_id` exactly like a door, so ONLY the reserved
// sentinel token separates them. It must reach the resolver with NO door binding.
const ownerStdioMcpSource: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'stdio',
  tool_call_id: 'tool-call-owner',
  mcp_token_id: STDIO_MCP_TOKEN_ID,
  contract_id: STDIO_MCP_TOKEN_ID,
};

const mcpSource: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'agent-1',
  tool_call_id: 'tool-call-1',
  mcp_token_id: 'mcp-token-1',
  contract_id: 'contract-1',
};

// D-177 P5 — deliberately UNSEEDED cell: a third party messaging in under a
// contact-bound contract gets no `allow_session` offer (fail closed).
const messengerContractedSource: ExecutionSource = {
  channel: 'messenger',
  actor: 'contracted_user',
  vendor: 'telegram',
  from: 'peer@example.com',
  contract_id: 'contract-1',
};

// D-177 N.14 — the reception door source, as the D-207 runner constructs it
// (actor stays 'anonymous'; contract_id = the server-derived door contract).
const receptionSource: ExecutionSource = {
  channel: 'reception',
  actor: 'anonymous',
  reception_id: 'endpoint-a',
  contract_id: 'ct_door_a',
};

const contractSnapshot = (): ContractSnapshot => ({
  contract_id: 'contract-1',
  contract_version: 'v1',
  allowed_tools: [TOOL_SLUG],
  approval_required: ['write', 'admin'],
  scope_restrictions: ['data.*'],
  resolved_at: NOW,
});

const mintCtx = (
  overrides: Partial<SessionGrantMintContext> = {},
): SessionGrantMintContext => ({
  channel: 'chat',
  actor: 'user_self',
  channel_session_id: 'chat-1',
  ingredient_slug: TOOL_SLUG,
  operation_id: 'mail.send',
  connection_name: 'gmail-primary',
  recipe_id: 'recipe-1',
  recipe_hash: 'recipe-hash-1',
  risk_tier: 'write',
  arg_shape_hash: 'arg-shape-hash',
  canonical_payload_hash: 'payload-hash',
  ttl_ms: 3_600_000,
  max_uses: 5,
  approved_action_ref: 'run-1',
  ...overrides,
});

const auditLogStub = (): AuditLogStore & {
  logActivity: ReturnType<typeof vi.fn>;
} => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}) as unknown as AuditLogStore & {
  logActivity: ReturnType<typeof vi.fn>;
};

const buildManifest = (
  overrides: Partial<IngredientManifest> = {},
): IngredientManifest =>
  ({
    slug: TOOL_SLUG,
    name: 'Mail Send',
    description: 'Write-tier fixture for D-177 P3 tests.',
    author: 'test',
    kind: 'http',
    category: 'action',
    risk_tier: 'write',
    version: 1,
    input: {
      method: 'POST',
      url: 'https://example.test/send',
    },
    output: { ok: 'ok' },
    ...overrides,
  }) as IngredientManifest;

const buildRecipe = (
  recipe_id = 'd-177-p3-mint-surface',
): RecipeDefinition =>
  ({
    recipe_id,
    version: 1,
    ttl: 60,
    metadata: {
      name: recipe_id,
      description: 'Minimal recipe fixture for D-177 P3 tests.',
      author: 'test',
      supported_platforms: ['test'],
      tags: ['test', 'session-grant'],
    },
    variables: {},
    prefetch_steps: [],
    steps: [
      {
        id: STEP_ID,
        ingredient: TOOL_SLUG,
        input: { body: { message: 'requires approval' } },
      } as unknown as RecipeStep,
    ],
    output: { sidebar: [] },
  }) as RecipeDefinition;

const successResult = (recipe_id: string): ExecutionResult => ({
  recipe_id,
  recipe_hash: `hash-${recipe_id}`,
  success: true,
  output: { render: [], sidebar: [] },
  steps: [],
  errors: [],
  duration_ms: 12,
  validation_issues: [],
});

const pausedResult = (
  recipe_id: string,
  awaitingOverrides: Partial<NonNullable<ExecutionResult['awaiting_approval']>> = {},
): ExecutionResult => ({
  recipe_id,
  recipe_hash: `hash-${recipe_id}`,
  success: false,
  output: { render: [], sidebar: [] },
  steps: [],
  errors: [],
  duration_ms: 7,
  validation_issues: [],
  awaiting_approval: {
    gated_step_id: STEP_ID,
    step_state: { prepared: true },
    tool_slug: TOOL_SLUG,
    risk_tier: 'write',
    reason: 'write tier requires approval',
    ...awaitingOverrides,
  },
});

const commitStore = (): CommitStore & {
  writePending: ReturnType<typeof vi.fn>;
  recordOutcome: ReturnType<typeof vi.fn>;
} => ({
  writePending: vi.fn().mockResolvedValue(undefined),
  recordOutcome: vi.fn().mockResolvedValue(undefined),
}) as unknown as CommitStore & {
  writePending: ReturnType<typeof vi.fn>;
  recordOutcome: ReturnType<typeof vi.fn>;
};

const checkpoint = (overrides: Partial<Checkpoint> = {}): Checkpoint => ({
  checkpoint_id: 'checkpoint-1',
  run_id: 'run-1',
  recipe_id: 'recipe-1',
  gated_step_id: STEP_ID,
  step_state: { previous: { ok: true } },
  created_at: NOW,
  ...overrides,
});

const checkpointStore = (): CheckpointStore & {
  written: Map<string, Checkpoint>;
  write: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
} => {
  const written = new Map<string, Checkpoint>();
  const store = {
    written,
    write: vi.fn(async (cp: Checkpoint) => {
      written.set(cp.checkpoint_id, cp);
    }),
    get: vi.fn(async (checkpoint_id: string) => written.get(checkpoint_id) ?? null),
    listByRun: vi.fn(async (run_id: string) =>
      [...written.values()].filter((cp) => cp.run_id === run_id),
    ),
    setArgOverrides: vi.fn().mockImplementation(async (checkpoint_id: string, patch) => {
      const existing = written.get(checkpoint_id);
      if (!existing) throw new Error(`checkpoint ${checkpoint_id} not found`);
      const patched = { ...existing, ...patch };
      written.set(checkpoint_id, patched);
      return patched;
    }),
    delete: vi.fn(async (checkpoint_id: string) => {
      written.delete(checkpoint_id);
    }),
    list: vi.fn(async () => [...written.values()]),
    size: vi.fn(async () => written.size),
  };
  return store as unknown as CheckpointStore & typeof store;
};

const notifier = (): PreflightNotifier & {
  ask: ReturnType<typeof vi.fn>;
  registerAskHandler: ReturnType<typeof vi.fn>;
} => ({
  ask: vi.fn().mockResolvedValue({ ask_id: 'ask-test-1' }),
  registerAskHandler: vi.fn(),
}) as unknown as PreflightNotifier & {
  ask: ReturnType<typeof vi.fn>;
  registerAskHandler: ReturnType<typeof vi.fn>;
};

const auditLog = (): AuditLogStore =>
  createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
  );

const pausedAnchor = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  ...buildAuditEntry({
    recipe_id: 'recipe-1',
    recipe_hash: 'recipe-hash-1',
    commit_status: 'awaiting_approval',
    duration_ms: NOW - STARTED_AT,
    errors: [],
    config_snapshot: { mode: 'original' },
    trigger_source: 'chat',
    instance_id: 'server-1',
    process_id: 'process-1',
    run_id: 'run-1',
    now: NOW,
    execution_source: chatSource,
    checkpoint_id: 'checkpoint-1',
  }),
  ...overrides,
});

const append = async (
  log: AuditLogStore,
  entry: AuditEntry,
): Promise<AuditEntry> => {
  await log.append(entry);
  return entry;
};

const makeDeps = (
  recipe: RecipeDefinition,
  overrides: Partial<ExecuteHandlerDeps> = {},
): ExecuteHandlerDeps => {
  const registry: ManifestRegistry = createManifestRegistry('/nonexistent');
  registry.register(buildManifest());
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe);
  return {
    recipeStore,
    executorConfig: { manifests: registry },
    baseVault: {},
    instanceId: 'server-test-1',
    commitStore: commitStore(),
    ...overrides,
  };
};

const fakeSessionGrantResolver = (): SessionGrantResolver => ({
  match: vi.fn(() => null),
  consume: vi.fn(() => true),
  // D-177 P5a / D-182 §8 — interface widened; inert in these P3 scenarios.
  claimBatchMember: vi.fn(() => false),
  mintBatch: vi.fn(() => undefined),
  mintRawOp: vi.fn(() => undefined),
  mint: vi.fn(),
});

beforeEach(() => {
  harness = createDefinitionHarness();
  defStore = harness.defStore;
  executeRecipeMock.mockReset();
  executeHandlerTesting.correlationTracker.reset();
});

afterEach(() => {
  harness.db.close();
  vi.restoreAllMocks();
});

describe('resolveSessionGrantOffer', () => {
  it('offers the attended-channel seeds and nothing else', () => {
    // The D-177 P5 follow-on seeded the attended trio: chat + messenger
    // owner cells and the mcp contracted cell all offer their seed bounds.
    for (const [channel, actor] of [
      ['chat', 'user_self'],
      ['messenger', 'user_self'],
      ['mcp', 'contracted_user'],
    ] as const) {
      expect(resolveSessionGrantOffer({
        channel,
        actor,
        risk_tier: 'write',
      }), `${channel}/${actor}`).toEqual({
        ttl_ms: 3_600_000,
        max_uses: 5,
        risk_tier: 'write',
      });
      expect(resolveSessionGrantOffer({
        channel,
        actor,
        risk_tier: 'admin',
      }), `${channel}/${actor}`).toEqual({
        ttl_ms: 3_600_000,
        max_uses: 5,
        risk_tier: 'admin',
      });
    }

    for (const risk_tier of ['read', 'destructive', undefined, 'bogus']) {
      expect(resolveSessionGrantOffer({
        channel: 'chat',
        actor: 'user_self',
        risk_tier,
      }), String(risk_tier)).toBeUndefined();
    }
    for (const [channel, actor] of [
      ['mcp', 'user_self'],
      ['messenger', 'contracted_user'],
      ['user', 'user_self'],
      ['chat', 'contracted_user'],
      ['chat', 'system'],
    ] as const) {
      expect(resolveSessionGrantOffer({
        channel,
        actor,
        risk_tier: 'write',
      }), `${channel}/${actor}`).toBeUndefined();
    }
  });
});

describe('createSessionGrantResolver.mint', () => {
  it('mints a bounded exact row that matches its own envelope, audits, and broadcasts', async () => {
    const log = auditLogStub();
    const broadcast = vi.fn();
    const resolver = createSessionGrantResolver({
      definitionStore: defStore,
      now: () => NOW,
      auditLog: log,
      broadcast,
    });
    const ctx = mintCtx();

    resolver.mint(ctx);
    await Promise.resolve();

    const rows = defStore.listSessionGrants('chat-1');
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toEqual(expect.objectContaining({
      contract_id: 'ct_1',
      minted_at: NOW,
      minted_by: 'owner',
      grant_kind: 'session',
      grant_mode: 'exact',
      channel_session_id: 'chat-1',
      bound_recipe: { recipe_id: 'recipe-1', recipe_hash: 'recipe-hash-1' },
      risk_tier: 'write',
      arg_shape_hash: 'arg-shape-hash',
      canonical_payload_hash: 'payload-hash',
      expiry_at: NOW + 3_600_000,
      max_uses: 5,
      uses_remaining: 5,
      approved_action_ref: 'run-1',
    } satisfies Partial<ContractDefinition>));
    expect(row.scope).toEqual({
      channels: ['chat'],
      actors: ['user_self'],
      ingredient_ids: [TOOL_SLUG],
      operation_ids: ['mail.send'],
      connection_names: ['gmail-primary'],
    });
    expect(row.display_name).toContain('mail.send');
    expect(matchesSessionGrant(row, ctx, NOW)).toBe(true);
    expect(log.logActivity).toHaveBeenCalledTimes(1);
    expect(log.logActivity).toHaveBeenCalledWith(expect.objectContaining({
      action: 'session_grant_minted',
      target: row.contract_id,
    }));
    expect(broadcast).toHaveBeenCalledWith({
      kind: 'contract.contract_definition_changed',
      op: 'mint',
      contract_id: row.contract_id,
    });
  });

  it('refuses non-grantable tiers without throwing, auditing, or broadcasting', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = auditLogStub();
    const broadcast = vi.fn();
    const resolver = createSessionGrantResolver({
      definitionStore: defStore,
      now: () => NOW,
      auditLog: log,
      broadcast,
    });

    expect(() => resolver.mint(mintCtx({ risk_tier: 'read' as SessionGrantMintContext['risk_tier'] })))
      .not.toThrow();

    expect(defStore.listSessionGrants('chat-1')).toEqual([]);
    expect(log.logActivity).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('dedupes the same approval and envelope durably, including revoked rows', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const resolver = createSessionGrantResolver({
      definitionStore: defStore,
      now: () => NOW,
    });

    resolver.mint(mintCtx());
    resolver.mint(mintCtx());

    expect(defStore.listSessionGrants('chat-1')).toHaveLength(1);
    const first = defStore.listSessionGrants('chat-1')[0]!;

    defStore.revoke(first.contract_id, 'owner disabled');
    resolver.mint(mintCtx());

    expect(defStore.listSessionGrants('chat-1')).toHaveLength(1);

    resolver.mint(mintCtx({ approved_action_ref: 'run-2' }));
    expect(defStore.listSessionGrants('chat-1')).toHaveLength(2);

    const local = createDefinitionHarness();
    try {
      const localResolver = createSessionGrantResolver({
        definitionStore: local.defStore,
        now: () => NOW,
      });
      localResolver.mint(mintCtx());
      localResolver.mint(mintCtx({ canonical_payload_hash: 'payload-hash-2' }));
      expect(local.defStore.listSessionGrants('chat-1')).toHaveLength(2);
    } finally {
      local.db.close();
    }
    expect(infoSpy).toHaveBeenCalled();
  });

  it('never throws on store failures, and auditLog is optional for successful mints', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const throwingStore = {
      mint: vi.fn(),
      get: vi.fn(() => null),
      list: vi.fn(() => []),
      recordUse: vi.fn(() => null),
      revoke: vi.fn(() => null),
      mintSessionGrant: vi.fn(() => {
        throw new Error('store down');
      }),
      listSessionGrants: vi.fn(() => []),
      consumeSessionGrant: vi.fn(() => false),
    } as unknown as ContractDefinitionStore;
    const failingResolver = createSessionGrantResolver({
      definitionStore: throwingStore,
      now: () => NOW,
    });

    expect(() => failingResolver.mint(mintCtx())).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();

    const realResolver = createSessionGrantResolver({
      definitionStore: defStore,
      now: () => NOW,
    });
    expect(() => realResolver.mint(mintCtx({ approved_action_ref: 'run-auditless' })))
      .not.toThrow();
    expect(defStore.listSessionGrants('chat-1')).toHaveLength(1);
  });
});

describe('PreflightResumer D-177 P3 session_grant threading', () => {
  const runResume = async (
    context: PreflightAskContext,
  ): Promise<NonNullable<Parameters<typeof executeRecipeMock>[0]>> => {
    const log = auditLog();
    await append(log, pausedAnchor());
    const recipe = buildRecipe('recipe-1');
    const deps = makeDeps(recipe);
    executeRecipeMock.mockResolvedValueOnce(successResult(recipe.recipe_id));
    const resumer = createPreflightResumer({
      auditLog: log,
      getExecuteDeps: () => deps,
    });

    await resumer.resumeRun(checkpoint(), context);

    expect(executeRecipeMock).toHaveBeenCalledTimes(1);
    return executeRecipeMock.mock.calls[0]![0];
  };

  it('threads answer context session_grant into the resumed engine context', async () => {
    const offer = { ttl_ms: 3_600_000, max_uses: 5, risk_tier: 'write' };

    const call = await runResume({
      recipe_id: 'recipe-1',
      gated_step_id: STEP_ID,
      session_grant: offer,
    });

    expect(call.resumeFrom?.session_grant).toBe(offer);
  });

  it('omits session_grant for plain approve resumes', async () => {
    const call = await runResume({
      recipe_id: 'recipe-1',
      gated_step_id: STEP_ID,
    });

    expect(call.resumeFrom).not.toHaveProperty('session_grant');
  });
});

describe('handleExecute D-177 P3 preflight offer site', () => {
  const runHeld = async (
    execution_source: ExecutionSource,
    awaitingOverrides: Partial<NonNullable<ExecutionResult['awaiting_approval']>> = {},
  ) => {
    const recipe = buildRecipe(`offer-${execution_source.channel}-${awaitingOverrides.operation_id ?? 'simple'}`);
    const log = auditLog();
    const checkpoints = checkpointStore();
    const notes = notifier();
    executeRecipeMock.mockResolvedValueOnce(pausedResult(recipe.recipe_id, awaitingOverrides));

    await handleExecute(
      makeDeps(recipe, {
        auditLog: log,
        checkpointStore: checkpoints,
        preflightNotifier: notes,
        sessionGrantResolver: fakeSessionGrantResolver(),
      }),
      {
        recipe_id: recipe.recipe_id,
        trigger_source: 'manual',
        execution_source,
        ...(execution_source.actor === 'contracted_user'
          ? { contract_snapshot: contractSnapshot() }
          : {}),
      },
    );

    expect(notes.ask).toHaveBeenCalledTimes(1);
    return notes.ask.mock.calls[0]!;
  };

  it('offers allow_session for chat user_self simple-form held writes', async () => {
    const [, options, handler] = await runHeld(chatSource);

    expect(options.map((option: { id: string }) => option.id)).toEqual([
      'approve',
      'allow_session',
      'deny',
    ]);
    expect(options[1]).toBe(ALLOW_SESSION_ASK_OPTION);
    expect(handler.payload).toMatchObject({
      session_grant: {
        ttl_ms: 3_600_000,
        max_uses: 5,
        risk_tier: 'write',
      },
    });
  });

  it('offers allow_session for mcp contracted held writes (P5 seed)', async () => {
    // D-177 P5 — the mcp contracted cell is seeded, so a contract-admitted
    // hold raised from an MCP agent's dispatch now carries the offer; the
    // owner (the only approver, N.5) answers it.
    const [, options, handler] = await runHeld(mcpSource);

    expect(options.map((option: { id: string }) => option.id)).toEqual([
      'approve',
      'allow_session',
      'deny',
    ]);
    expect(handler.payload).toMatchObject({
      session_grant: {
        ttl_ms: 3_600_000,
        max_uses: 5,
        risk_tier: 'write',
      },
    });
  });

  it('keeps binary options on an unseeded cell (messenger contracted)', async () => {
    const [, options, handler] = await runHeld(messengerContractedSource);

    expect(options).toBe(PREFLIGHT_ASK_OPTIONS);
    expect(handler.payload).not.toHaveProperty('session_grant');
  });

  it('offers allow_session (exact) for a catalog-gate hold now the catalog loop is wired', async () => {
    // D-177 catalog-gate loop — a catalog-gate hold (operation_id SET) on the
    // chat user_self cell now gets the SAME exact `allow_session` offer as a
    // simple-form hold (the catalog gate gained its own match + mint seam). The
    // open-projection upgrade is naturally absent (the walk runs at the commit
    // Gateway only), so the catalog offer stays EXACT — no grant_mode on the
    // payload.
    const [, options, handler] = await runHeld(chatSource, { operation_id: 'deal.read' });

    expect(options.map((option: { id: string }) => option.id)).toEqual([
      'approve',
      'allow_session',
      'deny',
    ]);
    expect(options[1]).toBe(ALLOW_SESSION_ASK_OPTION);
    expect(handler.payload).toMatchObject({
      session_grant: { ttl_ms: 3_600_000, max_uses: 5, risk_tier: 'write' },
    });
    expect(
      (handler.payload as { session_grant?: Record<string, unknown> }).session_grant,
    ).not.toHaveProperty('grant_mode');
  });

  it('offers allow-for-this-form on a reception door held write (N.14 seed)', async () => {
    // D-177 N.14 — the (reception, anonymous) cell is seeded with the
    // door-scaled bounds; the D-173 inbox answers the ask. The offer rides
    // the same channel-agnostic offer site as every other seeded cell.
    const [, options, handler] = await runHeld(receptionSource);

    expect(options.map((option: { id: string }) => option.id)).toEqual([
      'approve',
      'allow_session',
      'deny',
    ]);
    expect(handler.payload).toMatchObject({
      session_grant: {
        ttl_ms: 86_400_000,
        max_uses: 20,
        risk_tier: 'write',
      },
    });
  });
});

describe('D-177 N.14 — door-bound mint + match + consume (real store)', () => {
  const DOOR_SESSION = 'reception:endpoint-a';
  const doorMintCtx = (
    overrides: Partial<SessionGrantMintContext> = {},
  ): SessionGrantMintContext =>
    mintCtx({
      channel: 'reception',
      actor: 'anonymous',
      channel_session_id: DOOR_SESSION,
      source_contract_id: 'ct_door_a',
      ttl_ms: 86_400_000,
      max_uses: 2,
      ...overrides,
    });

  it('mints a door-bound row that admits the same door and only it, spend-verified', () => {
    const resolver = createSessionGrantResolver({
      definitionStore: defStore,
      now: () => NOW,
    });
    resolver.mint(doorMintCtx());

    const rows = defStore.listSessionGrants(DOOR_SESSION);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.bound_contract_id).toBe('ct_door_a');
    expect(row.scope.actors).toEqual(['anonymous']);
    expect(row.scope.channels).toEqual(['reception']);

    // A second fire on the SAME door (same payload, exact mode) matches…
    expect(matchesSessionGrant(row, doorMintCtx(), NOW)).toBe(true);
    // …but never another door's fire, even sharing every other axis.
    expect(
      matchesSessionGrant(
        row,
        doorMintCtx({ source_contract_id: 'ct_door_b' }),
        NOW,
      ),
    ).toBe(false);

    // Consume re-verifies the binding at the spend (defense in depth).
    expect(
      defStore.consumeSessionGrant(row.contract_id, {
        canonical_payload_hash: 'payload-hash',
        source_contract_id: 'ct_door_b',
      }),
    ).toBe(false);
    expect(
      defStore.consumeSessionGrant(row.contract_id, {
        canonical_payload_hash: 'payload-hash',
      }),
    ).toBe(false);
    expect(
      defStore.consumeSessionGrant(row.contract_id, {
        canonical_payload_hash: 'payload-hash',
        source_contract_id: 'ct_door_a',
      }),
    ).toBe(true);

    // Exhaustion re-holds: max_uses 2 → one more spend, then the row is
    // inert at both the matcher and the store.
    expect(
      defStore.consumeSessionGrant(row.contract_id, {
        canonical_payload_hash: 'payload-hash',
        source_contract_id: 'ct_door_a',
      }),
    ).toBe(true);
    const exhausted = defStore.listSessionGrants(DOOR_SESSION)[0]!;
    expect(exhausted.uses_remaining).toBe(0);
    expect(matchesSessionGrant(exhausted, doorMintCtx(), NOW)).toBe(false);
    expect(
      defStore.consumeSessionGrant(row.contract_id, {
        canonical_payload_hash: 'payload-hash',
        source_contract_id: 'ct_door_a',
      }),
    ).toBe(false);
  });

  it('the store refuses an anonymous-scoped mint without the door binding', () => {
    expect(() =>
      defStore.mintSessionGrant({
        minted_by: 'owner',
        display_name: 'unbound anonymous grant',
        scope: {
          channels: ['reception'],
          actors: ['anonymous'],
          ingredient_ids: [TOOL_SLUG],
        },
        channel_session_id: DOOR_SESSION,
        bound_recipe: { recipe_id: 'recipe-1', recipe_hash: 'recipe-hash-1' },
        arg_shape_hash: 'arg-shape-hash',
        risk_tier: 'write',
        canonical_payload_hash: 'payload-hash',
        expiry_at: NOW + 86_400_000,
        max_uses: 2,
      }),
    ).toThrow(/bound_contract_id/);
  });

  it('the store refuses a present-but-empty binding', () => {
    expect(() =>
      defStore.mintSessionGrant({
        minted_by: 'owner',
        display_name: 'empty binding',
        scope: {
          channels: ['reception'],
          actors: ['anonymous'],
          ingredient_ids: [TOOL_SLUG],
        },
        channel_session_id: DOOR_SESSION,
        bound_contract_id: '',
        bound_recipe: { recipe_id: 'recipe-1', recipe_hash: 'recipe-hash-1' },
        arg_shape_hash: 'arg-shape-hash',
        risk_tier: 'write',
        canonical_payload_hash: 'payload-hash',
        expiry_at: NOW + 86_400_000,
        max_uses: 2,
      }),
    ).toThrow(/non-empty/);
  });

  it('REGRESSION PIN — owner mints stay unbound and spend without a source id', () => {
    const resolver = createSessionGrantResolver({
      definitionStore: defStore,
      now: () => NOW,
    });
    resolver.mint(mintCtx());
    const row = defStore.listSessionGrants('chat-1')[0]!;
    expect(row.bound_contract_id).toBeUndefined();
    expect(
      defStore.consumeSessionGrant(row.contract_id, {
        canonical_payload_hash: 'payload-hash',
      }),
    ).toBe(true);
  });

  describe('mintDelegationRule — the N.14 door family', () => {
    const doorRuleInput = (overrides: Record<string, unknown> = {}) => ({
      minted_by: 'owner',
      display_name: 'Door rule — mail.send',
      scope: {
        channels: ['reception'],
        actors: ['anonymous'],
        ingredient_ids: [TOOL_SLUG],
        operation_ids: ['mail.send'],
      },
      grant_mode: 'exact' as const,
      bound_recipe: { recipe_id: 'recipe-1', recipe_hash: 'recipe-hash-1' },
      bound_contract_id: 'ct_door_a',
      arg_shape_hash: 'arg-shape-hash',
      risk_tier: 'write' as const,
      canonical_payload_hash: 'payload-hash',
      approved_action_ref: 'suggestion-key-hash-1',
      expiry_at: NOW + 1_000_000,
      max_uses: 50,
      ...overrides,
    });

    it('mints a door rule (anonymous + binding + reception)', () => {
      const rule = defStore.mintDelegationRule(doorRuleInput());
      expect(rule.grant_kind).toBe('delegation');
      expect(rule.bound_contract_id).toBe('ct_door_a');
      expect(rule.scope.actors).toEqual(['anonymous']);
    });

    it('refuses an anonymous rule without the binding', () => {
      expect(() =>
        defStore.mintDelegationRule(doorRuleInput({ bound_contract_id: undefined })),
      ).toThrow(/bound_contract_id/);
    });

    it('refuses an anonymous rule off the reception channel', () => {
      expect(() =>
        defStore.mintDelegationRule(
          doorRuleInput({
            scope: {
              channels: ['webhook'],
              actors: ['anonymous'],
              ingredient_ids: [TOOL_SLUG],
            },
          }),
        ),
      ).toThrow(/reception/);
    });

    it('refuses an OWNER rule carrying a binding', () => {
      expect(() =>
        defStore.mintDelegationRule(
          doorRuleInput({
            scope: {
              channels: ['chat'],
              actors: ['user_self'],
              ingredient_ids: [TOOL_SLUG],
            },
          }),
        ),
      ).toThrow(/door-only/);
    });

    it('still refuses every other actor (contracted_user)', () => {
      expect(() =>
        defStore.mintDelegationRule(
          doorRuleInput({
            scope: {
              channels: ['mcp'],
              actors: ['contracted_user'],
              ingredient_ids: [TOOL_SLUG],
            },
          }),
        ),
      ).toThrow(/user_self.*anonymous|anonymous.*user_self/);
    });
  });
});

// ── N.14.6 — the HOST WIRING layer ───────────────────────────────
//
// 🔴 Why this exists: the store fences and the pure matcher were well covered,
// but NOTHING drove the `doorSourceContractId` supply in `execute-handler`.
// Mutation-proved twice at the time it was written — deleting the claim
// threading from both closures left every suite green, AND so did deleting the
// SHIPPED N.14 `consume` threading. Every `source_contract_id` / `mcp_token_id`
// supply there was DECLARED, not BACKED: the matcher's door clause could be
// perfect and the door id never reach it.
//
// `handleExecute` builds those closures and hands them to `executeRecipe`, which
// is mocked here — so the mock's call captures the REAL closures. Driving them
// against a spy resolver asserts exactly what the wiring passes through.
describe('N.14.6 — the host closures thread the door binding into the resolver', () => {
  const driveAndCaptureHooks = async (
    execution_source: ExecutionSource,
  ): Promise<{
    resolver: SessionGrantResolver;
    hooks: NonNullable<CatalogSessionGrantHooks>;
  }> => {
    const recipe = buildRecipe(`wire-${execution_source.channel}-${execution_source.actor}`);
    const resolver = fakeSessionGrantResolver();
    executeRecipeMock.mockResolvedValueOnce(pausedResult(recipe.recipe_id));
    await handleExecute(
      makeDeps(recipe, {
        auditLog: auditLog(),
        checkpointStore: checkpointStore(),
        preflightNotifier: notifier(),
        sessionGrantResolver: resolver,
      }),
      {
        recipe_id: recipe.recipe_id,
        trigger_source: 'manual',
        execution_source,
        ...(execution_source.actor === 'contracted_user'
          ? { contract_snapshot: contractSnapshot() }
          : {}),
      },
    );
    const options = executeRecipeMock.mock.calls[0]?.[0] as {
      catalogSessionGrants?: CatalogSessionGrantHooks;
    };
    const hooks = options?.catalogSessionGrants;
    // If this throws, the wiring is gone entirely — which is the thing under test.
    if (hooks === undefined) throw new Error('catalogSessionGrants was never wired');
    return { resolver, hooks };
  };

  const CALL = {
    ingredient_slug: TOOL_SLUG,
    operation_id: 'deal.read',
    risk_tier: 'write',
    arg_shape_hash: 'arg-shape-hash',
    canonical_payload_hash: 'payload-hash',
  } as const;

  it('a reception door dispatch carries its door id into match, consume AND claim', async () => {
    const { resolver, hooks } = await driveAndCaptureHooks(receptionSource);

    hooks.match(CALL);
    expect(resolver.match).toHaveBeenCalledWith(
      expect.objectContaining({ source_contract_id: 'ct_door_a' }),
    );

    hooks.consume('ct_grant', { canonical_payload_hash: 'payload-hash' });
    expect(resolver.consume).toHaveBeenCalledWith(
      'ct_grant',
      expect.objectContaining({ source_contract_id: 'ct_door_a' }),
    );

    // The claim is the OTHER spend path (burns a member + decrements) — the
    // store re-verifies the binding there too, so the host must supply it.
    hooks.claimBatchMember?.('ct_grant', 'm1', {
      arg_shape_hash: 'arg-shape-hash',
      canonical_payload_hash: 'payload-hash',
    });
    expect(resolver.claimBatchMember).toHaveBeenCalledWith(
      'ct_grant',
      'm1',
      expect.objectContaining({ source_contract_id: 'ct_door_a' }),
    );
  });

  it('an mcp door dispatch carries its door id AND the owner-vs-door token', async () => {
    const { resolver, hooks } = await driveAndCaptureHooks(mcpSource);

    // Both halves matter: without `mcp_token_id` the matcher cannot tell this
    // door from the owner's own stdio client (the mcp channel forces BOTH to
    // `contracted_user` + a `contract_id`), and absence classifies as a door —
    // so a missing supply here would strip the OWNER of their grants.
    hooks.match(CALL);
    expect(resolver.match).toHaveBeenCalledWith(
      expect.objectContaining({
        source_contract_id: 'contract-1',
        mcp_token_id: 'mcp-token-1',
      }),
    );

    hooks.consume('ct_grant', { canonical_payload_hash: 'payload-hash' });
    expect(resolver.consume).toHaveBeenCalledWith(
      'ct_grant',
      expect.objectContaining({ source_contract_id: 'contract-1' }),
    );

    hooks.claimBatchMember?.('ct_grant', 'm1', {
      arg_shape_hash: 'arg-shape-hash',
      canonical_payload_hash: 'payload-hash',
    });
    expect(resolver.claimBatchMember).toHaveBeenCalledWith(
      'ct_grant',
      'm1',
      expect.objectContaining({ source_contract_id: 'contract-1' }),
    );
  });

  it('REGRESSION PIN — the owner\'s own stdio mcp client gets NO door binding', async () => {
    // ⚠ Mutation-derived, and the sharpest pin here: dropping
    // `isDoorDispatchSource` from the supply (so EVERY source hands over its
    // contract_id) passed every other test in this file — because the chat owner
    // carries no contract_id to leak. THIS source does: it is `(mcp,
    // contracted_user)` with a contract_id, owner-shaped and door-shaped at once.
    // Unclassified, its mint would stamp `bound_contract_id` and the owner's own
    // grants would silently become door-bound.
    const { resolver, hooks } = await driveAndCaptureHooks(ownerStdioMcpSource);

    hooks.match(CALL);
    const ctx = (resolver.match as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0]![0] as Record<string, unknown>;
    expect(ctx).not.toHaveProperty('source_contract_id');
    // …but the TOKEN is still supplied — it is what proves ownership. Absence
    // would classify the owner as a door and refuse their own unbound grants.
    expect(ctx.mcp_token_id).toBe(STDIO_MCP_TOKEN_ID);

    hooks.consume('ct_grant', { canonical_payload_hash: 'payload-hash' });
    const consumeCall = (resolver.consume as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0]![1] as Record<string, unknown>;
    expect(consumeCall).not.toHaveProperty('source_contract_id');
  });

  it('REGRESSION PIN — the owner\'s own chat dispatch supplies NEITHER field', async () => {
    // The other half of the wiring's job. An owner ctx must reach the matcher
    // with no door id (a bound grant stays inert against it) and no token id —
    // supplying either would re-key the owner as a door.
    const { resolver, hooks } = await driveAndCaptureHooks(chatSource);

    hooks.match(CALL);
    const ctx = (resolver.match as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0]![0] as Record<string, unknown>;
    expect(ctx).not.toHaveProperty('source_contract_id');
    expect(ctx).not.toHaveProperty('mcp_token_id');

    hooks.consume('ct_grant', { canonical_payload_hash: 'payload-hash' });
    const consumeCall = (resolver.consume as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0]![1] as Record<string, unknown>;
    expect(consumeCall).not.toHaveProperty('source_contract_id');
  });
});
