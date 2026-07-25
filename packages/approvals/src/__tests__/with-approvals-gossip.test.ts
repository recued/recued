/** D-113 C5 — executor integration tests.
 *
 *  Covers the gossip-bridge path in `withApprovals`: when `approvalBus`
 *  is supplied AND `gossip_active` is true, write/admin/destructive
 *  ingredients publish a pending record to the bus and wait for the
 *  first resolution instead of calling provider.prompt.
 *
 *  Scope:
 *   - Pause → gossip-resolved (approve / reject) → resume
 *   - Pause → timeout → on_timeout policy mapping (fail / approve / reject)
 *   - Cancellation cascade — bus.cancel
 *   - Parallel pending steps — each resolves independently
 *   - Fallback: bus provided but gossip_active=false → legacy prompt
 *   - Fallback: auto-trust + session short-circuits bypass the bus
 *   - Destructive on scheduled mode routes through bus (no queue) when
 *     gossip is active. */

import { describe, it, expect, vi } from 'vitest';
import { withApprovals, ApprovalDeniedError, ApprovalTimeoutError, ApprovalCancelledError } from '../with-approvals.js';
import { createApprovalBus, type ApprovalBus } from '../gossip/bus.js';
import { createTrustStateStore } from '../trust-store.js';
import { createSessionStore } from '../session-store.js';
import { createPendingQueue } from '../pending-queue.js';
import { createInMemoryCollection } from '@recued/storage';
import type {
  RecipeTrustState, PendingAction, RiskTier, ApprovalPendingRecord,
  ApprovalResolutionRecord, StepMeta,
} from '@recued/contracts';
import type { ApprovalProvider, ManifestLookup } from '../types.js';
import type { WithApprovalsOptions } from '../with-approvals.js';

const makeManifestLookup = (manifests: Record<string, { category: string; risk_tier: RiskTier }>): ManifestLookup =>
  async (slug) => manifests[slug] ?? null;

const makeProvider = (): ApprovalProvider => ({
  prompt: vi.fn(),
});

/** Build a bus wired to capture published pendings. Tests resolve by
 *  hand via `bus.publishResolution` to simulate gossip convergence. */
const makeTestBus = (): {
  bus: ApprovalBus;
  pendings: ApprovalPendingRecord[];
} => {
  const pendings: ApprovalPendingRecord[] = [];
  const bus = createApprovalBus({
    self: { instance_id: 'instance-1' },
    onPendingPublished: (p) => { pendings.push(p); },
  });
  return { bus, pendings };
};

const makeOptions = (overrides: Partial<WithApprovalsOptions> = {}): WithApprovalsOptions => ({
  manifestLookup: makeManifestLookup({
    'deal-update-hubspot':  { category: 'action', risk_tier: 'write' },
    'delete-deal-hubspot':  { category: 'action', risk_tier: 'destructive' },
    'admin-reconfig':       { category: 'action', risk_tier: 'admin' },
  }),
  recipe_id: 'test-recipe',
  recipe_version: 1,
  execution_mode: 'interactive',
  provider: makeProvider(),
  trustStore: createTrustStateStore(createInMemoryCollection<RecipeTrustState>()),
  sessionStore: createSessionStore(),
  pendingQueue: createPendingQueue(createInMemoryCollection<PendingAction>()),
  isPro: true,
  instance_id: 'instance-1',
  gossip_active: true,
  ...overrides,
});

/** Flush microtasks — withApprovals chains through manifestLookup +
 *  trustStore.get + async branch dispatch + requestViaBus before the
 *  bus publishes. One or two `await Promise.resolve()` isn't enough.
 *  Twenty cycles is cheap (all synchronous) and covers worst-case. */
const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

const makeUserAction = (
  approval_id: string,
  decision: 'approve' | 'reject' | 'cancel',
  channel: 'extension' | 'slack' | 'telegram' | 'email' = 'extension',
): ApprovalResolutionRecord => ({
  approval_id,
  created_by_instance: 'instance-2',  // a peer resolved it
  kind: 'user_action',
  resolved_at: Date.now(),
  actor: { channel, identifier: 'u-1', user_display: 'Alice' },
  decision,
});

describe('withApprovals — gossip bridge (approve path)', () => {
  it('publishes pending on first write + executes on gossip approve', async () => {
    const { bus, pendings } = makeTestBus();
    const upstream = vi.fn().mockResolvedValue('written');
    const provider = makeProvider();
    const onApproval = vi.fn();

    const wrapped = withApprovals(upstream, makeOptions({
      approvalBus: bus,
      provider,
      onApproval,
    }));

    const stepMeta: StepMeta = { step_id: 'confirm_update', timeout_ms: 60_000 };
    const callPromise = wrapped('deal-update-hubspot', { id: '42' }, undefined, undefined, stepMeta);

    // Wait a tick so the wrapped call registers + publishes.
    await flush();
    expect(pendings).toHaveLength(1);
    expect(pendings[0].step_id).toBe('confirm_update');
    expect(pendings[0].initiator_instance).toBe('instance-1');
    expect(pendings[0].recipe_id).toBe('test-recipe');
    expect(pendings[0].timeout_at - pendings[0].created_at).toBe(60_000);

    // Simulate a remote peer approving via Slack.
    bus.publishResolution(pendings[0].approval_id, makeUserAction(pendings[0].approval_id, 'approve', 'slack'));

    expect(await callPromise).toBe('written');
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(provider.prompt).not.toHaveBeenCalled();
    expect(onApproval).toHaveBeenCalledWith('deal-update-hubspot', 'allow_once', 'write');
  });

  it('increments trust counter on gossip approve for write/admin', async () => {
    const { bus, pendings } = makeTestBus();
    const trustStore = createTrustStateStore(createInMemoryCollection<RecipeTrustState>());

    const wrapped = withApprovals(vi.fn().mockResolvedValue('ok'), makeOptions({
      approvalBus: bus, trustStore,
    }));

    const call = wrapped('deal-update-hubspot', {}, undefined, undefined, { step_id: 's1' });
    await flush();
    bus.publishResolution(pendings[0].approval_id, makeUserAction(pendings[0].approval_id, 'approve'));
    await call;

    const state = await trustStore.get('test-recipe');
    expect(state?.approval_counts.write).toBe(1);
  });

  it('does not increment counter for destructive on gossip approve', async () => {
    const { bus, pendings } = makeTestBus();
    const trustStore = createTrustStateStore(createInMemoryCollection<RecipeTrustState>());

    const wrapped = withApprovals(vi.fn().mockResolvedValue('ok'), makeOptions({
      approvalBus: bus, trustStore,
    }));

    const call = wrapped('delete-deal-hubspot', {}, undefined, undefined, { step_id: 's1' });
    await flush();
    bus.publishResolution(pendings[0].approval_id, makeUserAction(pendings[0].approval_id, 'approve'));
    await call;

    const state = await trustStore.get('test-recipe');
    // Destructive writes nothing to the store (legacy behaviour preserved).
    expect(state).toBeNull();
  });
});

describe('withApprovals — gossip bridge (reject path)', () => {
  it('throws ApprovalDeniedError on gossip reject', async () => {
    const { bus, pendings } = makeTestBus();
    const upstream = vi.fn().mockResolvedValue('nope');
    const onApproval = vi.fn();

    const wrapped = withApprovals(upstream, makeOptions({
      approvalBus: bus, onApproval,
    }));

    const callPromise = wrapped('deal-update-hubspot', {}, undefined, undefined, { step_id: 's1' });
    await flush();
    bus.publishResolution(pendings[0].approval_id, makeUserAction(pendings[0].approval_id, 'reject', 'telegram'));

    await expect(callPromise).rejects.toThrow(ApprovalDeniedError);
    expect(upstream).not.toHaveBeenCalled();
    expect(onApproval).toHaveBeenCalledWith('deal-update-hubspot', 'deny', 'write');
  });
});

describe('withApprovals — gossip bridge (timeout paths)', () => {
  it('on_timeout=fail → ApprovalTimeoutError', async () => {
    vi.useFakeTimers();
    try {
      const { bus, pendings } = makeTestBus();
      const upstream = vi.fn().mockResolvedValue('ok');
      const wrapped = withApprovals(upstream, makeOptions({ approvalBus: bus }));

      const callPromise = wrapped('deal-update-hubspot', {}, undefined, undefined, {
        step_id: 's1', timeout_ms: 1_000, on_timeout: 'fail',
      });
      // Let the call register + publish.
      await flush();
      expect(pendings).toHaveLength(1);

      // Advance past timeout_at → owner watchdog fires executor_timeout.
      vi.advanceTimersByTime(1_200);
      await expect(callPromise).rejects.toThrow(ApprovalTimeoutError);
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('on_timeout=approve → executes the ingredient on expiry', async () => {
    vi.useFakeTimers();
    try {
      const { bus } = makeTestBus();
      const upstream = vi.fn().mockResolvedValue('late-but-approved');
      const wrapped = withApprovals(upstream, makeOptions({ approvalBus: bus }));

      const callPromise = wrapped('deal-update-hubspot', {}, undefined, undefined, {
        step_id: 's1', timeout_ms: 500, on_timeout: 'approve',
      });
      await flush();
      vi.advanceTimersByTime(600);

      expect(await callPromise).toBe('late-but-approved');
      expect(upstream).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('on_timeout=reject → ApprovalDeniedError on expiry', async () => {
    vi.useFakeTimers();
    try {
      const { bus } = makeTestBus();
      const upstream = vi.fn().mockResolvedValue('ok');
      const wrapped = withApprovals(upstream, makeOptions({ approvalBus: bus }));

      const callPromise = wrapped('deal-update-hubspot', {}, undefined, undefined, {
        step_id: 's1', timeout_ms: 500, on_timeout: 'reject',
      });
      await flush();
      vi.advanceTimersByTime(600);

      await expect(callPromise).rejects.toThrow(ApprovalDeniedError);
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('withApprovals — gossip bridge (cancellation)', () => {
  it('bus.cancel → ApprovalCancelledError', async () => {
    const { bus, pendings } = makeTestBus();
    const upstream = vi.fn().mockResolvedValue('ok');
    const wrapped = withApprovals(upstream, makeOptions({ approvalBus: bus }));

    const callPromise = wrapped('deal-update-hubspot', {}, undefined, undefined, { step_id: 's1' });
    await flush();
    bus.cancel(pendings[0].approval_id, 'executor_cancelled', 'recipe killed');

    await expect(callPromise).rejects.toThrow(ApprovalCancelledError);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('disposeAll cascades ApprovalCancelledError to every pending waiter', async () => {
    const { bus } = makeTestBus();
    const upstream = vi.fn().mockResolvedValue('ok');
    const wrapped = withApprovals(upstream, makeOptions({ approvalBus: bus }));

    const p1 = wrapped('deal-update-hubspot', {}, undefined, undefined, { step_id: 'a' });
    const p2 = wrapped('admin-reconfig', {}, undefined, undefined, { step_id: 'b' });
    await flush();

    bus.disposeAll('engine shutdown');

    await expect(p1).rejects.toThrow(ApprovalCancelledError);
    await expect(p2).rejects.toThrow(ApprovalCancelledError);
  });
});

describe('withApprovals — gossip bridge (parallel)', () => {
  it('independent approval_ids resolve independently (out-of-order)', async () => {
    const { bus, pendings } = makeTestBus();
    // Return value depends on input — disentangles from mock call order
    // when the out-of-order resolve interleaves with upstream invocation.
    const upstream = vi.fn(async (slug: string) =>
      slug === 'deal-update-hubspot' ? 'first' : 'second',
    );
    const wrapped = withApprovals(upstream, makeOptions({ approvalBus: bus }));

    const p1 = wrapped('deal-update-hubspot', { id: '1' }, undefined, undefined, { step_id: 'a' });
    const p2 = wrapped('admin-reconfig', { id: '2' }, undefined, undefined, { step_id: 'b' });
    await flush();

    expect(pendings).toHaveLength(2);
    // Resolve them out of order to prove isolation — p2's approval_id
    // fires first, but p1 must still match its own record.
    bus.publishResolution(pendings[1].approval_id, makeUserAction(pendings[1].approval_id, 'approve'));
    bus.publishResolution(pendings[0].approval_id, makeUserAction(pendings[0].approval_id, 'approve'));

    expect(await p1).toBe('first');
    expect(await p2).toBe('second');
  });
});

describe('withApprovals — gossip bridge (fallback)', () => {
  it('falls back to provider.prompt when gossip_active=false', async () => {
    const { bus, pendings } = makeTestBus();
    const provider: ApprovalProvider = {
      prompt: vi.fn(async (req) => ({
        request_id: req.request_id,
        decision: 'allow_once' as const,
        decided_at: new Date().toISOString(),
      })),
    };
    const upstream = vi.fn().mockResolvedValue('ok');
    const wrapped = withApprovals(upstream, makeOptions({
      approvalBus: bus,
      gossip_active: false,  // solo-config opt-out
      provider,
    }));

    const result = await wrapped('deal-update-hubspot', {}, undefined, undefined, { step_id: 's1' });

    expect(result).toBe('ok');
    expect(provider.prompt).toHaveBeenCalledTimes(1);
    expect(pendings).toHaveLength(0);  // bus was not consulted
    expect(upstream).toHaveBeenCalled();
  });

  it('auto-trust short-circuits before the bus publishes', async () => {
    const { bus, pendings } = makeTestBus();
    const trustStore = createTrustStateStore(createInMemoryCollection<RecipeTrustState>());
    await trustStore.set({
      recipe_id: 'test-recipe', recipe_version: 1,
      approval_counts: { write: 50, admin: 0 },
      trust_levels: { write: 'auto', admin: 'prompt' },
    });

    const upstream = vi.fn().mockResolvedValue('ok');
    const wrapped = withApprovals(upstream, makeOptions({
      approvalBus: bus, trustStore, isPro: true,
    }));

    const result = await wrapped('deal-update-hubspot', {}, undefined, undefined, { step_id: 's1' });
    expect(result).toBe('ok');
    expect(pendings).toHaveLength(0);
    expect(upstream).toHaveBeenCalled();
  });
});

describe('withApprovals — gossip bridge (scheduled mode)', () => {
  it('scheduled destructive routes to gossip instead of the pending queue', async () => {
    const { bus, pendings } = makeTestBus();
    const pendingQueue = createPendingQueue(createInMemoryCollection<PendingAction>());
    const upstream = vi.fn().mockResolvedValue('deleted');

    const wrapped = withApprovals(upstream, makeOptions({
      approvalBus: bus,
      execution_mode: 'scheduled',
      pendingQueue,
    }));

    const callPromise = wrapped('delete-deal-hubspot', {}, undefined, undefined, { step_id: 's1' });
    await flush();

    expect(pendings).toHaveLength(1);
    bus.publishResolution(pendings[0].approval_id, makeUserAction(pendings[0].approval_id, 'approve'));

    expect(await callPromise).toBe('deleted');
    expect(upstream).toHaveBeenCalled();
    // Nothing was enqueued — gossip was the resolution path.
    expect(await pendingQueue.list()).toHaveLength(0);
  });
});
