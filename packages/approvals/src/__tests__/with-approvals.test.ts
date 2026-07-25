import { describe, it, expect, beforeEach, vi } from 'vitest';
import { withApprovals, ApprovalDeniedError } from '../with-approvals.js';
import { createTrustStateStore } from '../trust-store.js';
import { createSessionStore } from '../session-store.js';
import { createPendingQueue } from '../pending-queue.js';
import { createInMemoryCollection } from '@recued/storage';
import { TRUST_THRESHOLDS } from '@recued/contracts';
import type {
  RecipeTrustState, PendingAction, RiskTier, ApprovalDecision,
} from '@recued/contracts';
import type { ApprovalProvider, ManifestLookup } from '../types.js';
import type { WithApprovalsOptions } from '../with-approvals.js';

const makeManifestLookup = (manifests: Record<string, { category: string; risk_tier: RiskTier }>): ManifestLookup =>
  async (slug) => manifests[slug] ?? null;

const makeProvider = (decision: ApprovalDecision = 'allow_once'): ApprovalProvider => ({
  prompt: vi.fn(async (req) => ({
    request_id: req.request_id,
    decision,
    decided_at: new Date().toISOString(),
  })),
});

const makeOptions = (overrides: Partial<WithApprovalsOptions> = {}): WithApprovalsOptions => ({
  manifestLookup: makeManifestLookup({}),
  recipe_id: 'test-recipe',
  recipe_version: 1,
  execution_mode: 'interactive',
  provider: makeProvider(),
  trustStore: createTrustStateStore(createInMemoryCollection<RecipeTrustState>()),
  sessionStore: createSessionStore(),
  pendingQueue: createPendingQueue(createInMemoryCollection<PendingAction>()),
  isPro: false,
  instance_id: 'instance-1',
  ...overrides,
});

describe('withApprovals — read tier', () => {
  it('passes through read ingredients without prompting', async () => {
    const upstream = vi.fn().mockResolvedValue('result');
    const provider = makeProvider();
    const wrapped = withApprovals(upstream, makeOptions({
      manifestLookup: makeManifestLookup({ 'deal-reader-hubspot': { category: 'data', risk_tier: 'read' } }),
      provider,
    }));

    const result = await wrapped('deal-reader-hubspot', { id: '42' });

    expect(result).toBe('result');
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(provider.prompt).not.toHaveBeenCalled();
  });
});

describe('withApprovals — AI category', () => {
  it('passes through AI ingredients without prompting (gated by recipe logic instead)', async () => {
    const upstream = vi.fn().mockResolvedValue('analysis');
    const provider = makeProvider();
    const wrapped = withApprovals(upstream, makeOptions({
      manifestLookup: makeManifestLookup({ 'ai-prompt': { category: 'ai', risk_tier: 'read' } }),
      provider,
    }));

    await wrapped('ai-prompt', {});

    expect(upstream).toHaveBeenCalled();
    expect(provider.prompt).not.toHaveBeenCalled();
  });
});

describe('withApprovals — interactive write', () => {
  it('prompts on first write', async () => {
    const upstream = vi.fn().mockResolvedValue('written');
    const provider = makeProvider('allow_once');
    const wrapped = withApprovals(upstream, makeOptions({
      manifestLookup: makeManifestLookup({ 'deal-update-hubspot': { category: 'action', risk_tier: 'write' } }),
      provider,
    }));

    const result = await wrapped('deal-update-hubspot', { id: '42', dealname: 'New' });

    expect(provider.prompt).toHaveBeenCalledTimes(1);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(result).toBe('written');
  });

  it('throws ApprovalDeniedError on deny', async () => {
    const upstream = vi.fn().mockResolvedValue('written');
    const wrapped = withApprovals(upstream, makeOptions({
      manifestLookup: makeManifestLookup({ 'deal-update-hubspot': { category: 'action', risk_tier: 'write' } }),
      provider: makeProvider('deny'),
    }));

    await expect(wrapped('deal-update-hubspot', {})).rejects.toThrow(ApprovalDeniedError);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('increments trust counter on approval', async () => {
    const trustStore = createTrustStateStore(createInMemoryCollection<RecipeTrustState>());
    const upstream = vi.fn().mockResolvedValue('ok');
    const wrapped = withApprovals(upstream, makeOptions({
      manifestLookup: makeManifestLookup({ 'deal-update-hubspot': { category: 'action', risk_tier: 'write' } }),
      provider: makeProvider('allow_once'),
      trustStore,
    }));

    await wrapped('deal-update-hubspot', {});
    await wrapped('deal-update-hubspot', {});

    const state = await trustStore.get('test-recipe');
    expect(state?.approval_counts.write).toBe(2);
  });
});

describe('withApprovals — session approval', () => {
  it('reuses session approval without prompting', async () => {
    const upstream = vi.fn().mockResolvedValue('ok');
    const provider = makeProvider('allow_session');
    const wrapped = withApprovals(upstream, makeOptions({
      manifestLookup: makeManifestLookup({ 'deal-update-hubspot': { category: 'action', risk_tier: 'write' } }),
      provider,
    }));

    await wrapped('deal-update-hubspot', {});  // first prompt
    await wrapped('deal-update-hubspot', {});  // session valid, no prompt
    await wrapped('deal-update-hubspot', {});  // still session

    expect(provider.prompt).toHaveBeenCalledTimes(1);
    expect(upstream).toHaveBeenCalledTimes(3);
  });
});

describe('withApprovals — auto trust', () => {
  it('skips prompt when trust level is auto and user is Pro', async () => {
    const trustStore = createTrustStateStore(createInMemoryCollection<RecipeTrustState>());
    await trustStore.set({
      recipe_id: 'test-recipe',
      recipe_version: 1,
      approval_counts: { write: 10, admin: 0 },
      trust_levels: { write: 'auto', admin: 'prompt' },
    });

    const upstream = vi.fn().mockResolvedValue('ok');
    const provider = makeProvider();
    const wrapped = withApprovals(upstream, makeOptions({
      manifestLookup: makeManifestLookup({ 'deal-update-hubspot': { category: 'action', risk_tier: 'write' } }),
      trustStore,
      isPro: true,
      provider,
    }));

    await wrapped('deal-update-hubspot', {});

    expect(provider.prompt).not.toHaveBeenCalled();
    expect(upstream).toHaveBeenCalled();
  });

  it('still prompts when auto but user is not Pro', async () => {
    const trustStore = createTrustStateStore(createInMemoryCollection<RecipeTrustState>());
    await trustStore.set({
      recipe_id: 'test-recipe',
      recipe_version: 1,
      approval_counts: { write: 10, admin: 0 },
      trust_levels: { write: 'auto', admin: 'prompt' },
    });

    const provider = makeProvider('allow_once');
    const wrapped = withApprovals(vi.fn().mockResolvedValue('ok'), makeOptions({
      manifestLookup: makeManifestLookup({ 'deal-update-hubspot': { category: 'action', risk_tier: 'write' } }),
      trustStore,
      isPro: false,
      provider,
    }));

    await wrapped('deal-update-hubspot', {});

    expect(provider.prompt).toHaveBeenCalled();
  });

  it('allow_always sets trust level to auto when threshold reached and Pro', async () => {
    const trustStore = createTrustStateStore(createInMemoryCollection<RecipeTrustState>());
    // Pre-fill to threshold
    await trustStore.set({
      recipe_id: 'test-recipe',
      recipe_version: 1,
      approval_counts: { write: TRUST_THRESHOLDS.write, admin: 0 },
      trust_levels: { write: 'prompt', admin: 'prompt' },
    });

    const wrapped = withApprovals(vi.fn().mockResolvedValue('ok'), makeOptions({
      manifestLookup: makeManifestLookup({ 'deal-update-hubspot': { category: 'action', risk_tier: 'write' } }),
      trustStore,
      isPro: true,
      provider: makeProvider('allow_always'),
    }));

    await wrapped('deal-update-hubspot', {});
    const state = await trustStore.get('test-recipe');
    expect(state?.trust_levels.write).toBe('auto');
  });

  it('allow_always does NOT unlock auto when threshold not reached', async () => {
    const trustStore = createTrustStateStore(createInMemoryCollection<RecipeTrustState>());
    await trustStore.set({
      recipe_id: 'test-recipe',
      recipe_version: 1,
      approval_counts: { write: 5, admin: 0 },  // below 10
      trust_levels: { write: 'prompt', admin: 'prompt' },
    });

    const wrapped = withApprovals(vi.fn().mockResolvedValue('ok'), makeOptions({
      manifestLookup: makeManifestLookup({ 'deal-update-hubspot': { category: 'action', risk_tier: 'write' } }),
      trustStore,
      isPro: true,
      provider: makeProvider('allow_always'),
    }));

    await wrapped('deal-update-hubspot', {});
    const state = await trustStore.get('test-recipe');
    expect(state?.trust_levels.write).toBe('prompt');
  });

  it('allow_always does NOT unlock for non-Pro', async () => {
    const trustStore = createTrustStateStore(createInMemoryCollection<RecipeTrustState>());
    await trustStore.set({
      recipe_id: 'test-recipe',
      recipe_version: 1,
      approval_counts: { write: TRUST_THRESHOLDS.write, admin: 0 },
      trust_levels: { write: 'prompt', admin: 'prompt' },
    });

    const wrapped = withApprovals(vi.fn().mockResolvedValue('ok'), makeOptions({
      manifestLookup: makeManifestLookup({ 'deal-update-hubspot': { category: 'action', risk_tier: 'write' } }),
      trustStore,
      isPro: false,
      provider: makeProvider('allow_always'),
    }));

    await wrapped('deal-update-hubspot', {});
    const state = await trustStore.get('test-recipe');
    expect(state?.trust_levels.write).toBe('prompt');
  });
});

describe('withApprovals — destructive', () => {
  it('always prompts for destructive (no auto-trust shortcut)', async () => {
    const trustStore = createTrustStateStore(createInMemoryCollection<RecipeTrustState>());
    // Even with hypothetical auto trust, destructive prompts
    await trustStore.set({
      recipe_id: 'test-recipe',
      recipe_version: 1,
      approval_counts: { write: 100, admin: 100 },
      trust_levels: { write: 'auto', admin: 'auto' },
    });

    const provider = makeProvider('allow_once');
    const wrapped = withApprovals(vi.fn().mockResolvedValue('ok'), makeOptions({
      manifestLookup: makeManifestLookup({ 'delete-deal-hubspot': { category: 'action', risk_tier: 'destructive' } }),
      trustStore,
      isPro: true,
      provider,
    }));

    await wrapped('delete-deal-hubspot', {});
    expect(provider.prompt).toHaveBeenCalled();
  });

  it('does NOT increment counter for destructive', async () => {
    const trustStore = createTrustStateStore(createInMemoryCollection<RecipeTrustState>());
    const wrapped = withApprovals(vi.fn().mockResolvedValue('ok'), makeOptions({
      manifestLookup: makeManifestLookup({ 'delete-deal-hubspot': { category: 'action', risk_tier: 'destructive' } }),
      provider: makeProvider('allow_once'),
      trustStore,
    }));

    await wrapped('delete-deal-hubspot', {});
    const state = await trustStore.get('test-recipe');
    // No counter increment for destructive
    expect(state).toBeNull();
  });
});

describe('withApprovals — scheduled execution', () => {
  it('queues destructive instead of running', async () => {
    const queue = createPendingQueue(createInMemoryCollection<PendingAction>());
    const upstream = vi.fn().mockResolvedValue('ok');

    const wrapped = withApprovals(upstream, makeOptions({
      manifestLookup: makeManifestLookup({ 'delete-deal-hubspot': { category: 'action', risk_tier: 'destructive' } }),
      execution_mode: 'scheduled',
      pendingQueue: queue,
    }));

    const result = await wrapped('delete-deal-hubspot', {});

    expect(result).toBeNull();
    expect(upstream).not.toHaveBeenCalled();
    const list = await queue.list();
    expect(list).toHaveLength(1);
    expect(list[0].reason).toBe('destructive');
  });

  it('queues writes when no background consent', async () => {
    const queue = createPendingQueue(createInMemoryCollection<PendingAction>());
    const upstream = vi.fn().mockResolvedValue('ok');

    const wrapped = withApprovals(upstream, makeOptions({
      manifestLookup: makeManifestLookup({ 'deal-update-hubspot': { category: 'action', risk_tier: 'write' } }),
      execution_mode: 'scheduled',
      pendingQueue: queue,
      backgroundConsent: undefined,
    }));

    await wrapped('deal-update-hubspot', {});

    expect(upstream).not.toHaveBeenCalled();
    const list = await queue.list();
    expect(list[0].reason).toBe('no_background_consent');
  });

  it('runs writes when background consent allows', async () => {
    const queue = createPendingQueue(createInMemoryCollection<PendingAction>());
    const upstream = vi.fn().mockResolvedValue('ok');

    const wrapped = withApprovals(upstream, makeOptions({
      manifestLookup: makeManifestLookup({ 'deal-update-hubspot': { category: 'action', risk_tier: 'write' } }),
      execution_mode: 'scheduled',
      pendingQueue: queue,
      backgroundConsent: {
        recipe_id: 'test-recipe',
        recipe_version: 1,
        scheduled_instance_id: 'instance-1',
        allow_unattended: true,
        granted_at: new Date().toISOString(),
      },
    }));

    await wrapped('deal-update-hubspot', {});

    expect(upstream).toHaveBeenCalled();
    const list = await queue.list();
    expect(list).toHaveLength(0);
  });

  it('NEVER auto-runs destructive even with background consent', async () => {
    const queue = createPendingQueue(createInMemoryCollection<PendingAction>());
    const upstream = vi.fn().mockResolvedValue('ok');

    const wrapped = withApprovals(upstream, makeOptions({
      manifestLookup: makeManifestLookup({ 'delete-deal-hubspot': { category: 'action', risk_tier: 'destructive' } }),
      execution_mode: 'scheduled',
      pendingQueue: queue,
      backgroundConsent: {
        recipe_id: 'test-recipe',
        recipe_version: 1,
        scheduled_instance_id: 'instance-1',
        allow_unattended: true,
        granted_at: new Date().toISOString(),
      },
    }));

    await wrapped('delete-deal-hubspot', {});
    expect(upstream).not.toHaveBeenCalled();
    const list = await queue.list();
    expect(list[0].reason).toBe('destructive');
  });
});
