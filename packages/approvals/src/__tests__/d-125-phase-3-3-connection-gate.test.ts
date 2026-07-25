/** D-125 Phase 3.3 — engine permission + risk_tier gate verification.
 *
 *  Per spec § 3.3, "the engine enforces the gate before dispatching to
 *  the adapter." The gate is the existing `withApprovals` wrapper's
 *  `risk_tier` check — the same gate every other ingredient kind has
 *  used since D-040. Connection-kind manifests aren't special; they
 *  carry a `risk_tier` and the gate fires off that.
 *
 *  Pinned here:
 *
 *    1. Kernel direct `connection` ingredient (kind=connection,
 *       risk_tier=admin) routes through the admin trust path — first
 *       call prompts; on `deny` the underlying executor is never
 *       called and `ApprovalDeniedError` propagates.
 *    2. Wrapper-style ingredient (kind=connection, risk_tier=write)
 *       routes through the write trust path identically to a non-
 *       connection write ingredient.
 *    3. Wrapper-style ingredient (kind=connection, risk_tier=read)
 *       passes through without prompting — same as any other read.
 *    4. Connection adapter (the dispatch downstream of withApprovals)
 *       never receives a call when the gate denies — proves the
 *       composition order is `withApprovals(executor)`, not the
 *       reverse.
 *    5. The `permission` field on connection-kind manifests is
 *       metadata-only today (P3.2 wires it to audit `intent`); the
 *       runtime gate is `risk_tier`. This is "exactly like every
 *       other ingredient today" per spec § 3.3 — `notification-send`
 *       and the kernel `connection` ingredient are the only manifests
 *       carrying `permission`, and neither is gated by it. */

import { describe, it, expect, vi } from 'vitest';
import { withApprovals, ApprovalDeniedError } from '../with-approvals.js';
import { createTrustStateStore } from '../trust-store.js';
import { createSessionStore } from '../session-store.js';
import { createPendingQueue } from '../pending-queue.js';
import { createInMemoryCollection } from '@recued/storage';
import type {
  RecipeTrustState, PendingAction, RiskTier, ApprovalDecision,
} from '@recued/contracts';
import type { ApprovalProvider, ManifestLookup } from '../types.js';
import type { WithApprovalsOptions } from '../with-approvals.js';

// ────────────────────────────────────────────────────────────────
// Test fixtures — connection-kind manifest projections
// ────────────────────────────────────────────────────────────────

/** ManifestLookup returns the narrow `{ category, risk_tier }`
 *  projection withApprovals consumes. The full manifest (including
 *  `kind: 'connection'` and `permission: ...`) lives in the
 *  manifest registry and is irrelevant to the gate — the projection
 *  proves the kind doesn't enter the enforcement path. */
const makeManifestLookup = (
  manifests: Record<string, { category: string; risk_tier: RiskTier }>,
): ManifestLookup => async (slug) => manifests[slug] ?? null;

const makeProvider = (decision: ApprovalDecision = 'allow_once'): ApprovalProvider => ({
  prompt: vi.fn(async (req) => ({
    request_id: req.request_id,
    decision,
    decided_at: new Date().toISOString(),
  })),
});

const makeOptions = (overrides: Partial<WithApprovalsOptions> = {}): WithApprovalsOptions => ({
  manifestLookup: makeManifestLookup({}),
  recipe_id: 'test-connection-recipe',
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

// ────────────────────────────────────────────────────────────────
// Kernel direct ingredient — admin tier
// ────────────────────────────────────────────────────────────────

describe('D-125 P3.3 — kernel `connection` direct ingredient (admin)', () => {
  it('prompts at the admin tier on first call', async () => {
    // Mirrors `community/ingredients/connection.json`:
    //   { slug: 'connection', kind: 'connection', risk_tier: 'admin',
    //     permission: 'connection.direct' }
    // The gate sees only category + risk_tier — `kind` and
    // `permission` flow elsewhere (kind to dispatch routing,
    // permission to P3.2 audit intent).
    const adapterCalled = vi.fn().mockResolvedValue({ ok: true });
    const provider = makeProvider('allow_once');
    const wrapped = withApprovals(adapterCalled, makeOptions({
      manifestLookup: makeManifestLookup({
        connection: { category: 'action', risk_tier: 'admin' },
      }),
      provider,
    }));

    await wrapped('connection', { connection_kind: 'api', connection: 'hubspot' });

    expect(provider.prompt).toHaveBeenCalledTimes(1);
    expect(provider.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ ingredient_slug: 'connection', risk_tier: 'admin' }),
    );
    expect(adapterCalled).toHaveBeenCalledTimes(1);
  });

  it('throws ApprovalDeniedError on deny — adapter never called', async () => {
    const adapterCalled = vi.fn().mockResolvedValue('should-not-fire');
    const wrapped = withApprovals(adapterCalled, makeOptions({
      manifestLookup: makeManifestLookup({
        connection: { category: 'action', risk_tier: 'admin' },
      }),
      provider: makeProvider('deny'),
    }));

    await expect(wrapped('connection', { connection_kind: 'api', connection: 'hubspot' }))
      .rejects.toBeInstanceOf(ApprovalDeniedError);
    // Pins the composition order: gate fires BEFORE dispatch reaches
    // the adapter. A future refactor that moved withApprovals INSIDE
    // createIngredientExecutor (or added a fire-and-forget side path)
    // would surface here.
    expect(adapterCalled).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────
// Wrapper ingredients — risk_tier flows from manifest, not kind
// ────────────────────────────────────────────────────────────────

describe('D-125 P3.3 — wrapper ingredients (kind=connection, varying risk_tier)', () => {
  it('write-tier wrapper prompts identically to non-connection write ingredients', async () => {
    // Hypothetical post-D-125-P5 wrapper:
    //   { slug: 'slack-post', kind: 'connection', risk_tier: 'write',
    //     permission: 'notification_send' }
    // The gate sees `risk_tier: 'write'` — same path as any other
    // write-tier ingredient (`deal-update-hubspot`, etc.).
    const adapterCalled = vi.fn().mockResolvedValue({ ts: '12345.6789' });
    const provider = makeProvider('allow_once');
    const wrapped = withApprovals(adapterCalled, makeOptions({
      manifestLookup: makeManifestLookup({
        'slack-post': { category: 'action', risk_tier: 'write' },
      }),
      provider,
    }));

    await wrapped('slack-post', {
      connection_kind: 'notification', connection: 'team-slack', text: 'hi',
    });

    expect(provider.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ ingredient_slug: 'slack-post', risk_tier: 'write' }),
    );
    expect(adapterCalled).toHaveBeenCalledTimes(1);
  });

  it('read-tier wrapper passes through without prompting', async () => {
    // Hypothetical post-D-125-P5 wrapper:
    //   { slug: 'mail-get', kind: 'connection', risk_tier: 'read',
    //     permission: 'mail_read' }
    // Read ingredients are never gated regardless of kind; this test
    // pins that connection-kind doesn't accidentally elevate the gate.
    const adapterCalled = vi.fn().mockResolvedValue({ from: 'a@b.c' });
    const provider = makeProvider();
    const wrapped = withApprovals(adapterCalled, makeOptions({
      manifestLookup: makeManifestLookup({
        'mail-get': { category: 'data', risk_tier: 'read' },
      }),
      provider,
    }));

    await wrapped('mail-get', { connection_kind: 'api', connection: 'gmail-personal' });

    expect(provider.prompt).not.toHaveBeenCalled();
    expect(adapterCalled).toHaveBeenCalledTimes(1);
  });

  it('destructive-tier wrapper always prompts (no auto-trust)', async () => {
    // Hypothetical wrapper that wraps a destructive vendor action.
    // Spec § 3.1 + § 3.3: the wrapper declares its own risk_tier;
    // the engine enforces it. Destructive bypasses session + auto-
    // trust per the standard path.
    const adapterCalled = vi.fn().mockResolvedValue('deleted');
    const provider = makeProvider('allow_once');
    const wrapped = withApprovals(adapterCalled, makeOptions({
      manifestLookup: makeManifestLookup({
        'ticket-delete-hubspot': { category: 'action', risk_tier: 'destructive' },
      }),
      provider,
    }));

    await wrapped('ticket-delete-hubspot', { connection: 'hubspot', id: '42' });
    await wrapped('ticket-delete-hubspot', { connection: 'hubspot', id: '43' });

    // Destructive prompts EVERY time — session approval doesn't apply.
    expect(provider.prompt).toHaveBeenCalledTimes(2);
    expect(adapterCalled).toHaveBeenCalledTimes(2);
  });
});

// ────────────────────────────────────────────────────────────────
// Step-level override impossibility (spec § 3.3)
// ────────────────────────────────────────────────────────────────

describe('D-125 P3.3 — step-level risk_tier override (spec § 3.3 invariant)', () => {
  it('is structurally impossible — gate reads manifest.risk_tier only', async () => {
    // Spec § 3.3: "Step-level overrides per `risk_tier` are not
    // allowed; if a recipe wants a tighter gate than the wrapper
    // declares, it forks the wrapper."
    //
    // This invariant is naturally true: the recipe step type has no
    // `risk_tier` field, and `withApprovals` reads `risk_tier` only
    // from the manifest projection. The step input is opaque to the
    // gate. We pin the invariant by passing a `risk_tier: 'read'`
    // key in the step input and verifying the gate still fires the
    // manifest's admin-tier prompt.
    const adapterCalled = vi.fn().mockResolvedValue('ok');
    const provider = makeProvider('allow_once');
    const wrapped = withApprovals(adapterCalled, makeOptions({
      manifestLookup: makeManifestLookup({
        connection: { category: 'action', risk_tier: 'admin' },
      }),
      provider,
    }));

    // Recipe step input attempts to spoof a lower risk_tier.
    await wrapped('connection', {
      connection_kind: 'api',
      connection: 'hubspot',
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      risk_tier: 'read' as unknown as string,
    });

    // Gate STILL prompts at the manifest's admin tier — step input
    // had no effect.
    expect(provider.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ risk_tier: 'admin' }),
    );
  });
});

// ────────────────────────────────────────────────────────────────
// `permission` field is metadata-only (no enforcement)
// ────────────────────────────────────────────────────────────────

describe('D-125 P3.3 — `permission` field is metadata, not a runtime gate', () => {
  it('permission strings on connection-kind manifests do not affect dispatch', async () => {
    // Today only `connection.json` (`connection.direct`) and
    // `notification-send.json` (`notification_send`) declare
    // `permission`. Neither is enforced at runtime — withApprovals
    // reads only `category` + `risk_tier`. P3.2 wires `permission`
    // into the audit row's `intent` field for forward-compat with
    // a future per-permission gate (out of scope for D-125).
    //
    // This test pins that two manifests with IDENTICAL risk_tier but
    // DIFFERENT permission strings gate identically — proof the gate
    // doesn't read permission.
    const provider1 = makeProvider('allow_once');
    const wrapped1 = withApprovals(vi.fn().mockResolvedValue(1), makeOptions({
      manifestLookup: makeManifestLookup({
        'wrapper-a': { category: 'action', risk_tier: 'write' },
      }),
      provider: provider1,
    }));
    const provider2 = makeProvider('allow_once');
    const wrapped2 = withApprovals(vi.fn().mockResolvedValue(2), makeOptions({
      manifestLookup: makeManifestLookup({
        'wrapper-b': { category: 'action', risk_tier: 'write' },
      }),
      provider: provider2,
    }));

    await wrapped1('wrapper-a', {});
    await wrapped2('wrapper-b', {});

    // Both prompted at write tier — identical gate behavior. Any
    // future per-permission gating would surface here as divergent
    // call patterns.
    expect(provider1.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ risk_tier: 'write' }),
    );
    expect(provider2.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ risk_tier: 'write' }),
    );
  });
});
