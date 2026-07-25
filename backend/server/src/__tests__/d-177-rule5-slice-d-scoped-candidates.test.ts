/** D-177 N.11 rule 5 slice D — scoped sender candidates and handler wiring. */

import type {
  ExecutionSource,
  IngredientManifest,
  RecipeDefinition,
  RecipeStep,
  ScopedSenderCandidate,
} from '@recued/contracts';
import type {
  CatalogGrantCall,
  ExecutionContext,
  ExecutionResult,
} from '@recued/engine';
import type {
  CommitGatewayDeps,
  SessionGrantGateCall,
} from '@recued/gateway';
import type { CommitStore } from '@recued/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeRecipeMock = vi.hoisted(() => vi.fn());
const gatewayCapture = vi.hoisted(() => ({
  lastCommitDeps: undefined as unknown,
  wrapWithCommitGateway: vi.fn(),
}));

vi.mock('@recued/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@recued/engine')>();
  return {
    ...actual,
    executeRecipe: executeRecipeMock,
  };
});

vi.mock('@recued/gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@recued/gateway')>();
  gatewayCapture.wrapWithCommitGateway.mockImplementation((
    _inner: unknown,
    deps: unknown,
  ) => {
    gatewayCapture.lastCommitDeps = deps;
    return async () => ({ ok: true });
  });
  return {
    ...actual,
    wrapWithCommitGateway: gatewayCapture.wrapWithCommitGateway,
  };
});

import { scopedCandidatesForChannelSession } from '../chat-forwarded-sender-index.js';
import {
  _testing as executeHandlerTesting,
  handleExecute,
  type ExecuteHandlerDeps,
} from '../execute-handler.js';
import { createManifestRegistry, type ManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import type { SessionGrantResolver } from '../session-grant-resolver.js';
import type { SessionForwardedSenderIndex } from '../chat-forwarded-sender-index.js';

const TOOL_SLUG = 'mail.send';
const CATALOG_SLUG = 'pub/catalog';
const CATALOG_OPERATION_ID = 'pub/catalog.send';
const CONNECTION = 'gmail-primary';
const STEP_ID = 'gated_step';

const chatSource: ExecutionSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'chat-1',
  user_id: 'user-1',
  turn_id: 'turn-1',
};

const candidates: readonly ScopedSenderCandidate[] = [
  { email: 'sender@example.com', contributed_at: 1_700_000_000_000 },
];

const buildManifest = (
  overrides: Partial<IngredientManifest> = {},
): IngredientManifest =>
  ({
    slug: TOOL_SLUG,
    name: 'Mail Send',
    description: 'Write-tier fixture for D-177 slice-D tests.',
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
  recipe_id = 'd-177-slice-d-scoped-candidates',
): RecipeDefinition =>
  ({
    recipe_id,
    version: 1,
    ttl: 60,
    metadata: {
      name: recipe_id,
      description: 'Minimal recipe fixture for D-177 slice-D tests.',
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

type FakeSessionGrantResolver = SessionGrantResolver & {
  match: ReturnType<typeof vi.fn<SessionGrantResolver['match']>>;
  consume: ReturnType<typeof vi.fn<SessionGrantResolver['consume']>>;
  claimBatchMember: ReturnType<typeof vi.fn<SessionGrantResolver['claimBatchMember']>>;
  mintBatch: ReturnType<typeof vi.fn<SessionGrantResolver['mintBatch']>>;
  mintRawOp: ReturnType<typeof vi.fn<SessionGrantResolver['mintRawOp']>>;
  mint: ReturnType<typeof vi.fn<SessionGrantResolver['mint']>>;
};

const fakeSessionGrantResolver = (): FakeSessionGrantResolver => ({
  match: vi.fn<SessionGrantResolver['match']>(() => null),
  consume: vi.fn<SessionGrantResolver['consume']>(() => true),
  claimBatchMember: vi.fn<SessionGrantResolver['claimBatchMember']>(() => false),
  mintBatch: vi.fn<SessionGrantResolver['mintBatch']>(() => 'batch-grant-1'),
  mintRawOp: vi.fn<SessionGrantResolver['mintRawOp']>(() => undefined),
  mint: vi.fn<SessionGrantResolver['mint']>(() => undefined),
});

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

const runAndCaptureHooks = async (
  scopedSenderCandidates: ExecuteHandlerDeps['scopedSenderCandidates'],
): Promise<{
  ctx: ExecutionContext;
  resolver: FakeSessionGrantResolver;
  commitDeps: CommitGatewayDeps;
}> => {
  const recipe = buildRecipe();
  const resolver = fakeSessionGrantResolver();
  let captured: ExecutionContext | undefined;
  executeRecipeMock.mockImplementationOnce(async (ctx: ExecutionContext) => {
    captured = ctx;
    return successResult(recipe.recipe_id);
  });

  await handleExecute(
    makeDeps(recipe, {
      sessionGrantResolver: resolver,
      ...(scopedSenderCandidates !== undefined ? { scopedSenderCandidates } : {}),
    }),
    {
      recipe_id: recipe.recipe_id,
      trigger_source: 'manual',
      execution_source: chatSource,
    },
  );

  expect(captured).toBeDefined();
  const commitDeps = gatewayCapture.lastCommitDeps as CommitGatewayDeps;
  expect(commitDeps).toBeDefined();
  expect(commitDeps.sessionGrants).toBeDefined();
  return { ctx: captured!, resolver, commitDeps };
};

const commitCall = (
  overrides: Partial<SessionGrantGateCall> = {},
): SessionGrantGateCall => ({
  channel: 'chat',
  actor: 'user_self',
  channel_session_id: 'chat:chat-1',
  ingredient_slug: CATALOG_SLUG,
  operation_id: CATALOG_OPERATION_ID,
  connection_name: CONNECTION,
  risk_tier: 'write',
  arg_shape_hash: 'arg-shape-1',
  canonical_payload_hash: 'payload-1',
  ...overrides,
});

const catalogCall = (
  overrides: Partial<CatalogGrantCall> = {},
): CatalogGrantCall => ({
  ingredient_slug: CATALOG_SLUG,
  operation_id: CATALOG_OPERATION_ID,
  connection_name: CONNECTION,
  risk_tier: 'write',
  arg_shape_hash: 'arg-shape-1',
  canonical_payload_hash: 'payload-1',
  ...overrides,
});

beforeEach(() => {
  executeRecipeMock.mockReset();
  gatewayCapture.wrapWithCommitGateway.mockClear();
  gatewayCapture.lastCommitDeps = undefined;
  executeHandlerTesting.correlationTracker.reset();
});

describe('scopedCandidatesForChannelSession', () => {
  it('strips only the chat prefix and preserves raw ids containing colons', () => {
    const index: SessionForwardedSenderIndex = {
      recordUserTurn: vi.fn(),
      candidates: vi.fn(() => candidates),
      evictSession: vi.fn(),
    };

    expect(scopedCandidatesForChannelSession(index, 'chat:thread:with:colon'))
      .toBe(candidates);
    expect(index.candidates).toHaveBeenCalledWith('thread:with:colon');
  });

  it('returns an empty list for messenger, mcp, and user prefixes', () => {
    const index: SessionForwardedSenderIndex = {
      recordUserTurn: vi.fn(),
      candidates: vi.fn(() => candidates),
      evictSession: vi.fn(),
    };

    expect(scopedCandidatesForChannelSession(index, 'messenger:thread-1')).toEqual([]);
    expect(scopedCandidatesForChannelSession(index, 'mcp:tool-call-1')).toEqual([]);
    expect(scopedCandidatesForChannelSession(index, 'user:user-1')).toEqual([]);
    expect(index.candidates).not.toHaveBeenCalled();
  });

  it('returns an empty list for unknown channel-session strings', () => {
    const index: SessionForwardedSenderIndex = {
      recordUserTurn: vi.fn(),
      candidates: vi.fn(() => candidates),
      evictSession: vi.fn(),
    };

    expect(scopedCandidatesForChannelSession(index, 'unknown')).toEqual([]);
    expect(index.candidates).not.toHaveBeenCalled();
  });
});

describe('handleExecute D-177 slice-D scoped sender hook closures', () => {
  it('attaches scoped sender candidates exactly when destination_emails are present', async () => {
    const scopedSenderCandidates = vi.fn(() => candidates);
    const { ctx, resolver, commitDeps } = await runAndCaptureHooks(
      scopedSenderCandidates,
    );
    const commitHooks = commitDeps.sessionGrants!;
    const catalogHooks = ctx.catalogSessionGrants!;

    commitHooks.match(commitCall());
    expect(scopedSenderCandidates).not.toHaveBeenCalled();
    expect(resolver.match.mock.calls[0]![0])
      .not.toHaveProperty('scoped_sender_candidates');

    resolver.match.mockClear();
    scopedSenderCandidates.mockClear();
    commitHooks.match(commitCall({
      destination_emails: ['sender@example.com'],
    }));
    expect(scopedSenderCandidates).toHaveBeenCalledWith('chat:chat-1');
    expect(resolver.match).toHaveBeenCalledWith(expect.objectContaining({
      destination_emails: ['sender@example.com'],
      scoped_sender_candidates: candidates,
    }));

    resolver.consume.mockClear();
    scopedSenderCandidates.mockClear();
    commitHooks.consume('grant-1', { canonical_payload_hash: 'payload-1' });
    expect(scopedSenderCandidates).not.toHaveBeenCalled();
    expect(resolver.consume.mock.calls[0]![1])
      .not.toHaveProperty('scoped_sender_candidates');

    resolver.consume.mockClear();
    scopedSenderCandidates.mockClear();
    commitHooks.consume('grant-1', {
      canonical_payload_hash: 'payload-1',
      destination_emails: ['sender@example.com'],
    });
    expect(scopedSenderCandidates).toHaveBeenCalledWith('chat:chat-1');
    expect(resolver.consume).toHaveBeenCalledWith('grant-1', {
      canonical_payload_hash: 'payload-1',
      destination_emails: ['sender@example.com'],
      scoped_sender_candidates: candidates,
    });

    resolver.match.mockClear();
    scopedSenderCandidates.mockClear();
    catalogHooks.match(catalogCall());
    expect(scopedSenderCandidates).not.toHaveBeenCalled();
    expect(resolver.match.mock.calls[0]![0])
      .not.toHaveProperty('scoped_sender_candidates');

    resolver.match.mockClear();
    scopedSenderCandidates.mockClear();
    catalogHooks.match(catalogCall({
      destination_emails: ['sender@example.com'],
    }));
    expect(scopedSenderCandidates).toHaveBeenCalledWith('chat:chat-1');
    expect(resolver.match).toHaveBeenCalledWith(expect.objectContaining({
      destination_emails: ['sender@example.com'],
      scoped_sender_candidates: candidates,
    }));

    resolver.consume.mockClear();
    scopedSenderCandidates.mockClear();
    catalogHooks.consume('grant-1', { canonical_payload_hash: 'payload-1' });
    expect(scopedSenderCandidates).not.toHaveBeenCalled();
    expect(resolver.consume.mock.calls[0]![1])
      .not.toHaveProperty('scoped_sender_candidates');

    resolver.consume.mockClear();
    scopedSenderCandidates.mockClear();
    catalogHooks.consume('grant-1', {
      canonical_payload_hash: 'payload-1',
      destination_emails: ['sender@example.com'],
    });
    expect(scopedSenderCandidates).toHaveBeenCalledWith('chat:chat-1');
    expect(resolver.consume).toHaveBeenCalledWith('grant-1', {
      canonical_payload_hash: 'payload-1',
      destination_emails: ['sender@example.com'],
      scoped_sender_candidates: candidates,
    });
  });

  it('degrades a throwing scopedSenderCandidates lookup to calls without candidates', async () => {
    const scopedSenderCandidates = vi.fn(() => {
      throw new Error('index unavailable');
    });
    const { ctx, resolver, commitDeps } = await runAndCaptureHooks(
      scopedSenderCandidates,
    );
    const commitHooks = commitDeps.sessionGrants!;
    const catalogHooks = ctx.catalogSessionGrants!;

    commitHooks.match(commitCall({
      destination_emails: ['sender@example.com'],
    }));
    expect(resolver.match).toHaveBeenLastCalledWith(expect.not.objectContaining({
      scoped_sender_candidates: expect.anything(),
    }));

    commitHooks.consume('grant-1', {
      canonical_payload_hash: 'payload-1',
      destination_emails: ['sender@example.com'],
    });
    expect(resolver.consume).toHaveBeenLastCalledWith('grant-1', {
      canonical_payload_hash: 'payload-1',
      destination_emails: ['sender@example.com'],
    });

    catalogHooks.match(catalogCall({
      destination_emails: ['sender@example.com'],
    }));
    expect(resolver.match).toHaveBeenLastCalledWith(expect.not.objectContaining({
      scoped_sender_candidates: expect.anything(),
    }));

    catalogHooks.consume('grant-1', {
      canonical_payload_hash: 'payload-1',
      destination_emails: ['sender@example.com'],
    });
    expect(resolver.consume).toHaveBeenLastCalledWith('grant-1', {
      canonical_payload_hash: 'payload-1',
      destination_emails: ['sender@example.com'],
    });
    expect(scopedSenderCandidates).toHaveBeenCalledTimes(4);
  });
});
