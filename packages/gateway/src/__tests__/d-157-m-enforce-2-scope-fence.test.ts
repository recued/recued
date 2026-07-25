/** M-ENFORCE-2 — scope fence wired into the per-call admission probe.
 *
 *  Pins `evaluatePreflightAdmission`'s `scope_path` gate (the
 *  `evaluateScopeAdmissibility` axis) + the gateway threading the call's
 *  `input` to `evaluateAdmission` so the host can derive the scope. The
 *  `deriveDispatchScope` derivation itself is pinned contract-side in
 *  `packages/contracts/src/__tests__/d-157-m-enforce-2-scope-fence.test.ts`.
 */

import {
  deriveDispatchScope,
  type AdmissionDecision,
  type ContractSnapshot,
  type ExecutionSource,
} from '@recued/contracts';
import type { CommitStore } from '@recued/storage';
import { describe, expect, it, vi } from 'vitest';

import {
  PreflightDeniedError,
  wrapWithCommitGateway,
  type CommitGatewayDeps,
  type CommitRunIdentity,
  type GatewayInner,
} from '../commit-gateway.js';
import { evaluatePreflightAdmission } from '../preflight-gate.js';

const NOW = Date.parse('2026-06-02T18:00:00.000Z');

// D-209 #1 W3 — the webhook source is an ANONYMOUS door dispatch: it carries the
// recipe's door contract_id, and its `admin` posture comes from the SNAPSHOT's
// authored `max_risk_without_approval` (passed per-test), never a flat channel rule.
const webhookSource = (): ExecutionSource => ({
  channel: 'webhook',
  actor: 'anonymous',
  vendor: 'hubspot',
  webhook_secret_id: 'ws-1',
  contract_id: 'contract-1',
});

const mcpSource = (): ExecutionSource => ({
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'agent-1',
  tool_call_id: 'tc-1',
  mcp_token_id: 'mt-1',
  contract_id: 'contract-1',
});

const userSource = (): ExecutionSource => ({
  channel: 'user',
  actor: 'user_self',
  user_id: 'local',
  client_token_id: 'c-1',
});

/** A contract snapshot that narrows BOTH the tool allowlist and the data
 *  scopes — the live path that exercises the fence today (no production
 *  dispatch carries `channel:'webhook'` yet). */
const scopedSnapshot = (
  overrides: Partial<ContractSnapshot> = {},
): ContractSnapshot => ({
  contract_id: 'contract-1',
  contract_version: 'v1',
  allowed_tools: ['enrichment-upsert', 'email-get'],
  approval_required: [],
  scope_restrictions: ['data.enrichment.*'],
  resolved_at: NOW,
  ...overrides,
});

describe('M-ENFORCE-2 evaluatePreflightAdmission scope_path gate', () => {
  it('enforces a snapshot scope fence on connection + data paths (D-187 slice 5: webhook baseline cell retired)', () => {
    // The fence now reads the contract SNAPSHOT's `scope_restrictions` directly (slice 5
    // dropped the `lookupPolicy`/baseline-cell read). D-209 #1 W3: the webhook door's
    // authored `admin` ceiling keeps an in-fence write at `admit` so the scope axis is
    // isolated; the snapshot carries the same patterns the retired cell did.
    const v = (scope_path: string) =>
      evaluatePreflightAdmission({
        source: webhookSource(),
        tool: { slug: 'x', kind: 'connection', risk_tier: 'write' },
        contract_snapshot: scopedSnapshot({
          allowed_tools: ['x'],
          scope_restrictions: ['connection.api.*', 'data.enrichment.*'],
          max_risk_without_approval: 'admin',
        }),
        scope_path,
      });
    expect(v('connection.api').verdict).toBe('admit');
    expect(v('data.enrichment').verdict).toBe('admit');
    expect(v('connection.notification')).toMatchObject({
      verdict: 'deny',
      code: 'scope_not_in_restrictions',
    });
    expect(v('data.mail')).toMatchObject({
      verdict: 'deny',
      code: 'scope_not_in_restrictions',
    });
  });

  it('is inert at the wired point: a non-null scope_path with no cell restrictions preserves the tool verdict', () => {
    // The (user, user_self) baseline carries no scope fence. A supplied,
    // out-of-family `scope_path` must NOT turn into a deny — the gate only
    // bites when the resolved policy actually sets `scope_restrictions`.
    // Guards the regression where the probe treats ANY scope_path as
    // restrictive.
    expect(
      evaluatePreflightAdmission({
        source: userSource(),
        tool: { slug: 'email-get', kind: 'storage', risk_tier: 'read' },
        scope_path: 'data.mail',
      }),
    ).toEqual({ verdict: 'admit' });
  });

  it('checks scope BEFORE the contract tool allowlist (deny reason is scope, not tool)', () => {
    // A call that fails BOTH gates — out-of-fence path AND not in the
    // snapshot's `allowed_tools` — surfaces the scope code, proving the
    // scope check short-circuits ahead of the tool-allowlist denial.
    const deny = evaluatePreflightAdmission({
      source: mcpSource(),
      tool: { slug: 'email-get', kind: 'storage', risk_tier: 'read' },
      contract_snapshot: scopedSnapshot({ allowed_tools: ['enrichment-upsert'] }),
      scope_path: 'data.mail',
    });
    expect(deny).toMatchObject({
      verdict: 'deny',
      code: 'scope_not_in_restrictions',
    });
  });

  it('is a no-op when no scope_path is supplied (tool decision unchanged)', () => {
    // A webhook-door connection write with no scope axis → the tool gate admits
    // (door allows the tool; its authored ceiling relaxes the write — D-209 #1
    // W3). Same as pre-M-ENFORCE-2. The snapshot is mandatory now: a
    // contract-bearing source without one throws rather than dispatching.
    const doorSnapshot = () => scopedSnapshot({
      allowed_tools: ['x'],
      scope_restrictions: [],
      max_risk_without_approval: 'admin',
    });
    expect(
      evaluatePreflightAdmission({
        source: webhookSource(),
        tool: { slug: 'x', kind: 'connection', risk_tier: 'write' },
        contract_snapshot: doorSnapshot(),
      }).verdict,
    ).toBe('admit');
    // Explicit null is treated identically to absent.
    expect(
      evaluatePreflightAdmission({
        source: webhookSource(),
        tool: { slug: 'x', kind: 'connection', risk_tier: 'write' },
        contract_snapshot: doorSnapshot(),
        scope_path: null,
      }).verdict,
    ).toBe('admit');
  });

  it('enforces a scope-narrowing ContractSnapshot on the mcp channel (the live path)', () => {
    // IN-fence dispatch — passes the scope fence (NOT `scope_not_in_restrictions`). D-187
    // slice 4: a contracted (mcp) WRITE then surfaces under the LOW ceiling → `ask` (the
    // scope fence cleared it through to the op-risk approval; the point here is the fence
    // did not deny it). The out-of-fence dispatch below is the scope-deny.
    const inScope = evaluatePreflightAdmission({
      source: mcpSource(),
      tool: { slug: 'enrichment-upsert', kind: 'storage', risk_tier: 'write' },
      contract_snapshot: scopedSnapshot(),
      scope_path: 'data.enrichment',
    });
    expect(inScope.verdict).toBe('ask');

    const deny = evaluatePreflightAdmission({
      source: mcpSource(),
      tool: { slug: 'email-get', kind: 'storage', risk_tier: 'read' },
      contract_snapshot: scopedSnapshot(),
      scope_path: 'data.mail',
    });
    expect(deny).toMatchObject({
      verdict: 'deny',
      code: 'scope_not_in_restrictions',
    });
  });

  it('a scope deny wins over an otherwise-ask tool verdict', () => {
    // Snapshot escalates `write` to approval AND fences scopes. An
    // in-fence write asks; an out-of-fence write is denied outright
    // (a path outside the fence is refused regardless of approval).
    const snapshot = scopedSnapshot({ approval_required: ['write'] });
    const inFence = evaluatePreflightAdmission({
      source: mcpSource(),
      tool: { slug: 'enrichment-upsert', kind: 'storage', risk_tier: 'write' },
      contract_snapshot: snapshot,
      scope_path: 'data.enrichment',
    });
    expect(inFence).toMatchObject({ verdict: 'ask', risk_tier: 'write' });

    const outOfFence = evaluatePreflightAdmission({
      source: mcpSource(),
      tool: { slug: 'email-get', kind: 'storage', risk_tier: 'write' },
      contract_snapshot: snapshot,
      scope_path: 'data.mail',
    });
    expect(outOfFence).toMatchObject({
      verdict: 'deny',
      code: 'scope_not_in_restrictions',
    });
  });
});

// ────────────────────────────────────────────────────────────────
// Gateway threading — the probe receives the call's resolved `input`
// ────────────────────────────────────────────────────────────────

const commitStore = (): CommitStore & {
  writePending: ReturnType<typeof vi.fn>;
  recordOutcome: ReturnType<typeof vi.fn>;
} =>
  ({
    writePending: vi.fn().mockResolvedValue(undefined),
    recordOutcome: vi.fn().mockResolvedValue(undefined),
  }) as unknown as CommitStore & {
    writePending: ReturnType<typeof vi.fn>;
    recordOutcome: ReturnType<typeof vi.fn>;
  };

const runIdentity = (): CommitRunIdentity => ({
  request_id: 'req-1',
  source: webhookSource(),
  channel_session_id: 'sess-1',
  correlation_id: 'corr-1',
  dispatch_depth: 0,
});

describe('M-ENFORCE-2 gateway threads input into the probe', () => {
  it('passes the resolved input so a scope-deriving probe can fence the call', async () => {
    const store = commitStore();
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    // A realistic host probe: derive the scope from (kind, slug, input)
    // and gate it through the real `evaluatePreflightAdmission`.
    const evaluateAdmission = (
      slug: string,
      input: Record<string, unknown>,
    ): AdmissionDecision | null => {
      const scopePath = deriveDispatchScope({ kind: 'connection', slug }, input);
      return evaluatePreflightAdmission({
        source: webhookSource(),
        tool: { slug, kind: 'connection', risk_tier: 'write' },
        // D-187 slice 5 — the fence reads the SNAPSHOT scope (the retired webhook cell is
        // gone). Carry the same connection.api/enrichment patterns + allow the admitted
        // tool; D-209 #1 W3 — the door's authored ceiling is what admits the write.
        contract_snapshot: scopedSnapshot({
          allowed_tools: ['deal-reader-hubspot'],
          scope_restrictions: ['connection.api.*', 'data.enrichment.*'],
          max_risk_without_approval: 'admin',
        }),
        ...(scopePath !== null ? { scope_path: scopePath } : {}),
      });
    };
    const deps: CommitGatewayDeps = {
      commitStore: store,
      identity: runIdentity(),
      genCommitId: () => 'commit-1',
      genIdempotencyKey: () => 'idem-1',
      now: () => NOW,
      evaluateAdmission,
    };
    const executor = wrapWithCommitGateway(inner, deps);

    // A connection.notification send (the input the adapter dispatches on)
    // is fenced out of the snapshot scope → PreflightDeniedError before the
    // pending commit is written and before the boundary is crossed. Capture
    // the rejection once and assert both class + shape.
    const denied = await executor('slack-post', {
      connection_kind: 'notification',
      connection: 's',
    }).catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(PreflightDeniedError);
    expect(denied).toMatchObject({
      code: 'RECIPE_POLICY_DENIED',
      admission_code: 'scope_not_in_restrictions',
    });
    expect(store.writePending).not.toHaveBeenCalled();
    expect(inner).not.toHaveBeenCalled();

    // A connection.api call with the same shape is admitted and dispatched.
    await expect(
      executor('deal-reader-hubspot', { connection_kind: 'api', connection: 'h' }),
    ).resolves.toMatchObject({ ok: true });
    expect(store.writePending).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
