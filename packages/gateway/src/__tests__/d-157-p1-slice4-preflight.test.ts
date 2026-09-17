/** D-157 P1 slice 4 - gateway preflight probe and reconciliation tests. */

import { readFileSync } from 'node:fs';
import type {
  AdmissionDecision,
  Checkpoint,
  ContractSnapshot,
  ExecutionSource,
  IngredientKind,
  RiskTier,
  StepMeta,
} from '@recued/contracts';
import {
  PREFLIGHT_REQUIRED_SIGNAL_NAME,
  PreflightRequiredSignal,
} from '@recued/contracts';
import type { Answer } from '@recued/notification';
import type { CheckpointStore, CommitStore } from '@recued/storage';
import { describe, expect, it, vi } from 'vitest';

import {
  PreflightDeniedError,
  wrapWithCommitGateway,
  type CommitGatewayDeps,
  type CommitRunIdentity,
  type GatewayInner,
} from '../commit-gateway.js';
import {
  evaluatePreflightAdmission,
  raiseOnAsk,
  type PreflightTool,
} from '../preflight-gate.js';
import {
  buildPreflightAsk,
  createPreflightAnswerHandler,
  NEVER_ASK_OPERATION_OPTION_ID,
  PREFLIGHT_ASK_OPTIONS,
  PREFLIGHT_ASK_OPTIONS_WITH_SESSION,
  PREFLIGHT_HANDLER_KIND,
  raisePreflightAsk,
  RELAX_OPERATION_TO_ASK_OPTION_ID,
  type PreflightAskContext,
  type PreflightNotifier,
  type PreflightResumer,
} from '../preflight-reconciliation.js';

const NOW = Date.parse('2026-05-22T18:00:00.000Z');
const ANSWERED_AT = Date.parse('2026-05-22T18:01:00.000Z');

const userSource = (): ExecutionSource => ({
  channel: 'user',
  actor: 'user_self',
  user_id: 'local',
  client_token_id: 'client-1',
});

const chatSource = (): ExecutionSource => ({
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'chat-1',
  user_id: 'user-1',
});

const contractedSource = (): ExecutionSource => ({
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'agent-1',
  tool_call_id: 'tool-call-1',
  mcp_token_id: 'mcp-token-1',
  contract_id: 'contract-1',
});

const tool = (
  risk_tier: RiskTier,
  overrides: Partial<PreflightTool> = {},
): PreflightTool => ({
  slug: `${risk_tier}-tool`,
  kind: 'http',
  risk_tier,
  ...overrides,
});

const contractSnapshot = (): ContractSnapshot => ({
  contract_id: 'contract-1',
  contract_version: 'v1',
  allowed_tools: ['admin-tool'],
  approval_required: ['admin'],
  scope_restrictions: ['data.*'],
  resolved_at: NOW,
});

const admitDecision: AdmissionDecision = { verdict: 'admit' };

const askDecision: AdmissionDecision = {
      verdict: 'ask',
      risk_tier: 'admin',
      detail: 'admin tier needs approval',
      authorization_provenance: { pre_lift_approval: 'ask' },
};
const denyDecision: AdmissionDecision = {
  verdict: 'deny',
  code: 'tool_not_in_contract',
  detail: 'destructive tier is hard-denied',
};

const answer = (option: string): Answer => ({
  option,
  answered_at: ANSWERED_AT,
});

const checkpoint = (overrides: Partial<Checkpoint> = {}): Checkpoint => ({
  checkpoint_id: 'checkpoint-1',
  run_id: 'run-1',
  recipe_id: 'recipe-1',
  gated_step_id: 'gated_step',
  step_state: { previous: { ok: true } },
  created_at: NOW,
  ...overrides,
});

const askContext = (
  overrides: Partial<PreflightAskContext> = {},
): PreflightAskContext => ({
  recipe_id: 'recipe-1',
  gated_step_id: 'gated_step',
  ...overrides,
});

const payload = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  checkpoint_id: 'checkpoint-1',
  run_id: 'run-1',
  recipe_id: 'recipe-1',
  gated_step_id: 'gated_step',
  tool_slug: 'admin-tool',
  risk_tier: 'admin',
  reason: 'admin tier needs approval',
  ...overrides,
});

// D-182 §8 — recipe-LESS raw-op door hold fixtures. The checkpoint carries the
// `raw_op` block instead of recipe_id/gated_step_id; the ask context + payload
// carry the `raw_op` marker / `raw_op_id`.
const rawOpCheckpoint = (overrides: Partial<Checkpoint> = {}): Checkpoint => ({
  checkpoint_id: 'checkpoint-raw-1',
  run_id: 'run-raw-1',
  step_state: {},
  raw_op: {
    op_id: 'recued-core.crm-pack.deal.create',
    catalog_slug: 'recued-core/hubspot-catalog',
    operation: 'deal.create',
    connection_name: 'hubspot-prod',
    op_args: { body: { properties: { dealname: 'Acme' } } },
    execution_source: {
      channel: 'mcp',
      actor: 'contracted_user',
      agent_id: 'agent-1',
      tool_call_id: 'call-1',
      mcp_token_id: 'tok-1',
      contract_id: 'contract-1',
    },
    risk_tier: 'write',
    arg_shape_hash: 'arg-hash',
    canonical_payload_hash: 'payload-hash',
    correlation_id: 'call-1',
  },
  created_at: NOW,
  ...overrides,
});

const rawOpContext = (
  overrides: Partial<PreflightAskContext> = {},
): PreflightAskContext => ({
  raw_op: { op_id: 'recued-core.crm-pack.deal.create' },
  tool_slug: 'deal.create',
  risk_tier: 'write',
  ...overrides,
});

const rawOpPayload = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  checkpoint_id: 'checkpoint-raw-1',
  run_id: 'run-raw-1',
  raw_op_id: 'recued-core.crm-pack.deal.create',
  tool_slug: 'deal.create',
  risk_tier: 'write',
  ...overrides,
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

const checkpointStore = (
  cp: Checkpoint | null = checkpoint(),
): CheckpointStore & {
  write: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  listByRun: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  size: ReturnType<typeof vi.fn>;
} => ({
  write: vi.fn().mockResolvedValue(undefined),
  get: vi.fn().mockResolvedValue(cp),
  delete: vi.fn().mockResolvedValue(undefined),
  listByRun: vi.fn().mockResolvedValue(cp === null ? [] : [cp]),
  list: vi.fn().mockResolvedValue(cp === null ? [] : [cp]),
  size: vi.fn().mockResolvedValue(cp === null ? 0 : 1),
}) as unknown as CheckpointStore & {
  write: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  listByRun: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  size: ReturnType<typeof vi.fn>;
};

const resumer = (): PreflightResumer & {
  resumeRun: ReturnType<typeof vi.fn>;
  denyRun: ReturnType<typeof vi.fn>;
} => ({
  resumeRun: vi.fn().mockResolvedValue(undefined),
  denyRun: vi.fn().mockResolvedValue(undefined),
}) as unknown as PreflightResumer & {
  resumeRun: ReturnType<typeof vi.fn>;
  denyRun: ReturnType<typeof vi.fn>;
};

const runIdentity = (
  overrides: Partial<CommitRunIdentity> = {},
): CommitRunIdentity => ({
  request_id: 'run-1',
  source: chatSource(),
  channel_session_id: 'chat:chat-1',
  correlation_id: 'corr-1',
  dispatch_depth: 0,
  ...overrides,
});

const gatewayDeps = (
  store: CommitStore,
  overrides: Partial<CommitGatewayDeps> = {},
): CommitGatewayDeps => ({
  commitStore: store,
  identity: runIdentity(),
  getIngredientCategory: () => 'action',
  genCommitId: () => 'commit-1',
  genIdempotencyKey: () => 'idem-1',
  now: () => NOW,
  ...overrides,
});

describe('evaluatePreflightAdmission', () => {
  it('returns admit for a read-tier tool on user and user_self', () => {
    expect(evaluatePreflightAdmission({
      source: userSource(),
      tool: tool('read'),
    })).toEqual({
      verdict: 'admit',
      authorization_provenance: { pre_lift_approval: 'never' },
    });
  });

  it('returns admit for an admin-tier tool on chat and user_self (D-187: contract-less owner ceiling is admin)', () => {
    // D-187 slice 4 — the matrix's tighter (chat, user_self) `write` ceiling collapsed
    // into the ONE global contract-less owner ceiling (`admin`), so an admin-risk op
    // now runs silent in chat (was `ask` under the matrix). Destructive still
    // always-asks (next test) — the op-risk floor trust can never cross.
    expect(evaluatePreflightAdmission({
      source: chatSource(),
      tool: tool('admin'),
    })).toEqual({
      verdict: 'admit',
      authorization_provenance: { pre_lift_approval: 'never' },
    });
  });

  it('returns ask for a destructive tool on chat and user_self (D-177: approval-gated, not hard-denied)', () => {
    // D-177 read-gate (2026-06-11, ed3b56c3) flipped destructive on the owner
    // agent cells from hard-deny → APPROVAL-gated: the `(chat, user_self)`
    // baseline seed allows destructive (`allowed_risk_tiers` includes it) with
    // `max_risk_without_approval: 'write'`, so it always raises a fresh approval
    // card — it can never be auto-approved (destructive is not
    // session-grantable). This assertion was missed by that commit (the sibling
    // d-153-phase-2b-policy-enforcement.test.ts already covers the new behavior).
    expect(evaluatePreflightAdmission({
      source: chatSource(),
      tool: tool('destructive'),
    })).toMatchObject({
      verdict: 'ask',
      risk_tier: 'destructive',
    });
  });

  it('throws for a contracted_user source without a contract snapshot', () => {
    expect(() => evaluatePreflightAdmission({
      source: contractedSource(),
      tool: tool('read'),
    })).toThrow(/requires a ContractSnapshot/);
  });

  it('uses the contract snapshot when a contracted_user source provides one', () => {
    expect(evaluatePreflightAdmission({
      source: contractedSource(),
      tool: tool('admin', { slug: 'admin-tool' }),
      contract_snapshot: contractSnapshot(),
    })).toMatchObject({
      verdict: 'ask',
      risk_tier: 'admin',
    });
  });

  // D-187 policy-matrix retirement (slice 4) — the per-call probe NO LONGER reads the
  // seeded `contract.policy_matrix.*` cell for the APPROVAL verdict; approval is now
  // op-risk × stage-trust (`admitByOpRisk`) and coarse ACCESS (kind / risk-tier
  // allow-sets) moved to the Layer-1 op-admission gate. So a scan-seeded matrix cell is
  // INERT here: its `approval_tier` can't escalate an op-risk verdict, and its
  // `allowed_kinds` can't deny. (The ONLY thing `scan` still feeds in this probe is the
  // scope fence — exercised in d-157-m-enforce-2-scope-fence.test.ts, which passes a
  // `scope_path`.)
  it('ignores a scan-seeded cell approval_tier — approval is op-risk, not the matrix cell', () => {
    // A `read` op is never-class → admit regardless of any seeded cell (the probe no
    // longer accepts a `scan`; the matrix cell is fully retired from this approval path).
    expect(evaluatePreflightAdmission({
      source: userSource(),
      tool: tool('read'),
    })).toEqual({
      verdict: 'admit',
      authorization_provenance: { pre_lift_approval: 'never' },
    });
  });

  it('ignores a scan-seeded cell allowed_kinds — coarse kind access is the Layer-1 gate now', () => {
    // tool('read') is kind 'http'; the matrix coarse kind gate is retired from this
    // approval probe (it is the op-admission gate's concern, per-call), so the op-risk
    // read still admits. The probe no longer accepts a `scan` at all.
    expect(evaluatePreflightAdmission({
      source: userSource(),
      tool: tool('read'),
    })).toEqual({
      verdict: 'admit',
      authorization_provenance: { pre_lift_approval: 'never' },
    });
  });
});

describe('raiseOnAsk', () => {
  it('throws PreflightRequiredSignal only for ask verdicts', () => {
    let thrown: unknown;
    try {
      raiseOnAsk(askDecision, { slug: 'admin-tool' });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PreflightRequiredSignal);
    expect((thrown as Error).name).toBe(PREFLIGHT_REQUIRED_SIGNAL_NAME);
    expect(thrown).toMatchObject({
      authorization_provenance: { pre_lift_approval: 'ask' },
    });
  });

  it('is a no-op for admit and deny verdicts', () => {
    expect(() => raiseOnAsk(admitDecision, { slug: 'read-tool' })).not.toThrow();
    expect(() => raiseOnAsk(denyDecision, { slug: 'danger-tool' })).not.toThrow();
  });
});

describe('wrapWithCommitGateway with evaluateAdmission', () => {
  it('I-4 raises ask before writePending', async () => {
    const store = commitStore();
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, gatewayDeps(store, {
      evaluateAdmission: vi.fn(() => askDecision),
    }));

    await expect(executor('admin-tool', {})).rejects.toMatchObject({
      name: PREFLIGHT_REQUIRED_SIGNAL_NAME,
    });

    expect(store.writePending).not.toHaveBeenCalled();
    expect(inner).not.toHaveBeenCalled();
  });

  it('throws PreflightDeniedError for deny before writePending', async () => {
    const store = commitStore();
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, gatewayDeps(store, {
      evaluateAdmission: vi.fn(() => denyDecision),
    }));

    await expect(executor('destructive-tool', {})).rejects.toMatchObject({
      code: 'RECIPE_POLICY_DENIED',
      admission_code: 'tool_not_in_contract',
      name: 'PreflightDeniedError',
    });
    await expect(executor('destructive-tool', {})).rejects.toBeInstanceOf(
      PreflightDeniedError,
    );

    expect(store.writePending).not.toHaveBeenCalled();
    expect(inner).not.toHaveBeenCalled();
  });

  it('fires the probe even when commit identity is absent', async () => {
    const askStore = commitStore();
    const askInner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const askExecutor = wrapWithCommitGateway(askInner, gatewayDeps(askStore, {
      identity: undefined,
      evaluateAdmission: vi.fn(() => askDecision),
    }));

    await expect(askExecutor('admin-tool', {})).rejects.toMatchObject({
      name: PREFLIGHT_REQUIRED_SIGNAL_NAME,
    });
    expect(askStore.writePending).not.toHaveBeenCalled();
    expect(askInner).not.toHaveBeenCalled();

    const admitStore = commitStore();
    const output = { ok: true };
    const admitInner = vi.fn<GatewayInner>().mockResolvedValue(output);
    const admitExecutor = wrapWithCommitGateway(admitInner, gatewayDeps(admitStore, {
      identity: undefined,
      evaluateAdmission: vi.fn(() => admitDecision),
    }));

    await expect(admitExecutor(
      'read-tool',
      { q: 'x' },
      { previous: 'ok' },
      { cache: 'fresh' },
      { step_id: 'step-1', recipe_id: 'recipe-1' },
    )).resolves.toBe(output);

    expect(admitStore.writePending).not.toHaveBeenCalled();
    expect(admitInner).toHaveBeenCalledWith(
      'read-tool',
      { q: 'x' },
      { previous: 'ok' },
      { cache: 'fresh' },
      { step_id: 'step-1', recipe_id: 'recipe-1' },
      { cached: false },
    );
  });

  it('dispatches normally when the probe admits', async () => {
    const store = commitStore();
    const output = { ok: true };
    const inner = vi.fn<GatewayInner>().mockResolvedValue(output);
    const executor = wrapWithCommitGateway(inner, gatewayDeps(store, {
      evaluateAdmission: vi.fn(() => admitDecision),
    }));

    await expect(executor('read-tool', { q: 'x' })).resolves.toBe(output);

    expect(store.writePending).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(store.recordOutcome).toHaveBeenCalledWith(
      'commit-1',
      expect.objectContaining({
        status: 'succeeded',
        output,
      }),
    );
  });

  it('records a dispatch use once when the admission probe admits', async () => {
    const store = commitStore();
    const recordDispatchUse = vi.fn();
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, gatewayDeps(store, {
      evaluateAdmission: vi.fn(() => admitDecision),
      recordDispatchUse,
    }));

    await expect(executor('read-tool', { q: 'x' })).resolves.toEqual({ ok: true });

    expect(recordDispatchUse).toHaveBeenCalledTimes(1);
    // slice 2a — simple-form dispatch (no surface op key) threads undefined.
    expect(recordDispatchUse).toHaveBeenCalledWith('read-tool', undefined);
    expect(store.writePending).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  /** ⛔⛔ A THROW FROM THE USE SEAM MUST PREVENT THE DISPATCH, NOT RIDE ALONGSIDE
   *  IT. The host's `recordDispatchUse` now refuses a spent contract by throwing
   *  from this exact position — the same way the seller reservation beside it
   *  denies ("A denial throws and prevents dispatch"). That is only a refusal if
   *  nothing downstream runs: no pending row, and above all no `inner`.
   *
   *  🔑 WITHOUT THIS, "the host throws" and "the call was refused" are different
   *  claims and only the first is tested. A budget that threw while the effect
   *  still crossed the boundary would be worse than the clamp it replaced. */
  it('a throwing recordDispatchUse refuses the call before any pending row or effect', async () => {
    const store = commitStore();
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const recordDispatchUse = vi.fn(() => {
      throw new Error('this contract\'s use limit is spent');
    });
    const executor = wrapWithCommitGateway(inner, gatewayDeps(store, {
      evaluateAdmission: vi.fn(() => admitDecision),
      recordDispatchUse,
    }));

    await expect(executor('read-tool', { q: 'x' })).rejects.toThrow(/use limit is spent/);

    expect(recordDispatchUse).toHaveBeenCalledTimes(1);
    expect(inner).not.toHaveBeenCalled();
    expect(store.writePending).not.toHaveBeenCalled();
  });

  it('does not record a dispatch use when an ask verdict has no resume grant', async () => {
    const store = commitStore();
    const recordDispatchUse = vi.fn();
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, gatewayDeps(store, {
      evaluateAdmission: vi.fn(() => askDecision),
      recordDispatchUse,
    }));

    await expect(executor('admin-tool', {})).rejects.toMatchObject({
      name: PREFLIGHT_REQUIRED_SIGNAL_NAME,
    });

    expect(recordDispatchUse).not.toHaveBeenCalled();
    expect(store.writePending).not.toHaveBeenCalled();
    expect(inner).not.toHaveBeenCalled();
  });

  it('does not record a dispatch use when the admission probe denies', async () => {
    const store = commitStore();
    const recordDispatchUse = vi.fn();
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, gatewayDeps(store, {
      evaluateAdmission: vi.fn(() => denyDecision),
      recordDispatchUse,
    }));

    await expect(executor('destructive-tool', {}))
      .rejects.toBeInstanceOf(PreflightDeniedError);

    expect(recordDispatchUse).not.toHaveBeenCalled();
    expect(store.writePending).not.toHaveBeenCalled();
    expect(inner).not.toHaveBeenCalled();
  });

  it('admits an ask verdict on the resumed gated step', async () => {
    const store = commitStore();
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, gatewayDeps(store, {
      evaluateAdmission: vi.fn(() => askDecision),
    }));

    await expect(executor(
      'admin-tool',
      {},
      undefined,
      undefined,
      // D-165 op-identity binding — the resume grant is honored only when the
      // approved identity names THIS slug.
      {
        step_id: 'gated_step',
        recipe_id: 'recipe-1',
        preflight_admitted: true,
        preflight_approved_target: { ingredient_slug: 'admin-tool' },
      },
    )).resolves.toEqual({ ok: true });

    expect(store.writePending).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('records a dispatch use on an ask verdict with a matching resume grant', async () => {
    const store = commitStore();
    const recordDispatchUse = vi.fn();
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, gatewayDeps(store, {
      evaluateAdmission: vi.fn(() => askDecision),
      recordDispatchUse,
    }));

    await expect(executor(
      'admin-tool',
      {},
      undefined,
      undefined,
      {
        step_id: 'gated_step',
        recipe_id: 'recipe-1',
        preflight_admitted: true,
        preflight_approved_target: { ingredient_slug: 'admin-tool' },
      },
    )).resolves.toEqual({ ok: true });

    expect(recordDispatchUse).toHaveBeenCalledTimes(1);
    expect(recordDispatchUse).toHaveBeenCalledWith('admin-tool', undefined);
    expect(store.writePending).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('re-asks an ask verdict when the resumed slug does not match the approved identity', async () => {
    const store = commitStore();
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, gatewayDeps(store, {
      evaluateAdmission: vi.fn(() => askDecision),
    }));

    await expect(executor(
      'admin-tool',
      {},
      undefined,
      undefined,
      {
        step_id: 'gated_step',
        recipe_id: 'recipe-1',
        preflight_admitted: true,
        preflight_approved_target: { ingredient_slug: 'a-DIFFERENT-tool' },
      },
    )).rejects.toMatchObject({
      name: PREFLIGHT_REQUIRED_SIGNAL_NAME,
    });

    expect(inner).not.toHaveBeenCalled();
    expect(store.writePending).not.toHaveBeenCalled();
  });

  it('does not record a dispatch use when the resume grant targets a different slug', async () => {
    const store = commitStore();
    const recordDispatchUse = vi.fn();
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, gatewayDeps(store, {
      evaluateAdmission: vi.fn(() => askDecision),
      recordDispatchUse,
    }));

    await expect(executor(
      'admin-tool',
      {},
      undefined,
      undefined,
      {
        step_id: 'gated_step',
        recipe_id: 'recipe-1',
        preflight_admitted: true,
        preflight_approved_target: { ingredient_slug: 'a-DIFFERENT-tool' },
      },
    )).rejects.toMatchObject({
      name: PREFLIGHT_REQUIRED_SIGNAL_NAME,
    });

    expect(recordDispatchUse).not.toHaveBeenCalled();
    expect(store.writePending).not.toHaveBeenCalled();
    expect(inner).not.toHaveBeenCalled();
  });

  it('still blocks deny verdicts on the resumed gated step', async () => {
    const store = commitStore();
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, gatewayDeps(store, {
      evaluateAdmission: vi.fn(() => denyDecision),
    }));

    await expect(executor(
      'destructive-tool',
      {},
      undefined,
      undefined,
      { step_id: 'gated_step', recipe_id: 'recipe-1', preflight_admitted: true },
    )).rejects.toBeInstanceOf(PreflightDeniedError);

    expect(store.writePending).not.toHaveBeenCalled();
    expect(inner).not.toHaveBeenCalled();
  });

  it('strips the preflight resume markers before forwarding stepMeta', async () => {
    const store = commitStore();
    const stepMeta: StepMeta = {
      step_id: 'gated_step',
      recipe_id: 'recipe-1',
      platform_scope: 'connection.api.crm.deal',
      preflight_admitted: true,
      // D-165 op-identity binding — admitted because the approved identity
      // names this slug; both resume markers are stripped before forwarding.
      preflight_approved_target: { ingredient_slug: 'admin-tool' },
    };
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, gatewayDeps(store, {
      evaluateAdmission: vi.fn(() => askDecision),
    }));

    await executor('admin-tool', {}, undefined, undefined, stepMeta);

    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner.mock.calls[0]?.[4]).toEqual({
      step_id: 'gated_step',
      recipe_id: 'recipe-1',
      platform_scope: 'connection.api.crm.deal',
    });
    expect(inner.mock.calls[0]?.[4]).not.toHaveProperty('preflight_admitted');
    expect(inner.mock.calls[0]?.[4]).not.toHaveProperty(
      'preflight_approved_target',
    );
  });

  it('behaves like the pre-slice-4 gateway when the probe is absent', async () => {
    const store = commitStore();
    const output = { ok: true };
    const inner = vi.fn<GatewayInner>().mockResolvedValue(output);
    const executor = wrapWithCommitGateway(inner, gatewayDeps(store));

    await expect(executor('admin-tool', {})).resolves.toBe(output);

    expect(store.writePending).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(store.recordOutcome).toHaveBeenCalledWith(
      'commit-1',
      expect.objectContaining({ status: 'succeeded', output }),
    );
  });
});

describe('buildPreflightAsk', () => {
  it('builds a durable gateway.preflight handler payload with required ids', () => {
    const ask = buildPreflightAsk({
      checkpoint: checkpoint(),
      context: askContext(),
    });

    expect(ask.options).toBe(PREFLIGHT_ASK_OPTIONS);
    expect(ask.handler).toEqual({
      kind: PREFLIGHT_HANDLER_KIND,
      payload: {
        checkpoint_id: 'checkpoint-1',
        run_id: 'run-1',
        recipe_id: 'recipe-1',
        gated_step_id: 'gated_step',
      },
    });
    expect(ask.message.text).toContain('recipe-1');
    expect(ask.message.text).toContain('gated_step');
  });

  it('flows optional context fields into the payload and message only when set', () => {
    const absent = buildPreflightAsk({
      checkpoint: checkpoint(),
      context: askContext(),
    });
    expect(absent.handler.payload).not.toHaveProperty('tool_slug');
    expect(absent.handler.payload).not.toHaveProperty('risk_tier');
    expect(absent.handler.payload).not.toHaveProperty('reason');

    const present = buildPreflightAsk({
      checkpoint: checkpoint(),
      context: askContext({
        tool_slug: 'admin-tool',
        risk_tier: 'admin',
        reason: 'approval reason',
      }),
    });

    expect(present.handler.payload).toMatchObject({
      tool_slug: 'admin-tool',
      risk_tier: 'admin',
      reason: 'approval reason',
    });
    expect(present.message.text).toContain('admin-tool');
    expect(present.message.text).toContain('approval reason');
    // The tier reaches the reader as its CONSEQUENCE, not as the name of
    // the field the engine reads it from: `risk_tier='admin'` told the
    // owner nothing they could act on.
    expect(present.message.text).toContain(
      'Admin actions change account settings or access',
    );
    expect(present.message.text).not.toContain('risk_tier=');
  });

  it('offers only the paired standing ruling and surfaces floor clamps', () => {
    const offer = {
      kind: 'never_ask' as const,
      ingredient_id: 'recued-core/github',
      operation_id: 'recued-core/github.issue.read',
      op_hash: 'a'.repeat(64),
      approval: 'never' as const,
    };
    const ask = buildPreflightAsk({
      checkpoint: checkpoint(),
      context: askContext({
        tool_slug: offer.operation_id,
        risk_tier: 'read',
        owner_override_offer: offer,
      }),
    });

    expect(ask.options.map((option) => option.id)).toEqual([
      'approve',
      NEVER_ASK_OPERATION_OPTION_ID,
      'deny',
    ]);
    expect(ask.handler.payload.owner_override_offer).toEqual(offer);
    const clamped = buildPreflightAsk({
      checkpoint: checkpoint(),
      context: askContext({
        tool_slug: 'recued-core/mail.send',
        risk_tier: 'write',
        approval_clamped_from: 'never',
      }),
    });
    expect(clamped.message.text).toContain("stored approval 'never'");
    expect(clamped.message.text).toContain('was clamped');
  });

  it('renders the authored-always write escape as Relax to ask (grantable)', () => {
    const ask = buildPreflightAsk({
      checkpoint: checkpoint(),
      context: askContext({
        tool_slug: 'recued-core/mail.send',
        risk_tier: 'write',
        owner_override_offer: {
          kind: 'relax_to_ask',
          ingredient_id: 'recued-core/mail',
          operation_id: 'recued-core/mail.send',
          op_hash: 'b'.repeat(64),
          approval: 'ask',
        },
      }),
    });
    expect(ask.options).toContainEqual({
      id: RELAX_OPERATION_TO_ASK_OPTION_ID,
      label: 'Relax to ask (grantable)',
    });
  });

  it('names the connection the held call would land on', () => {
    // Which account absorbs the write — sandbox or production — is the
    // blast radius, and it was absent from the ask for its whole life.
    const ask = buildPreflightAsk({
      checkpoint: checkpoint(),
      context: askContext({
        tool_slug: 'core.mail.send',
        connection_name: 'gmail-personal',
      }),
    });
    expect(ask.message.text).toContain('core.mail.send on gmail-personal');
  });

  it('drops the connection clause when the op id already names it', () => {
    // "…/reception-intake.intake.materialize on reception-intake" spends a
    // clause restating a segment the reader just read, and a sentence that
    // repeats itself is a sentence people learn to skim.
    const ask = buildPreflightAsk({
      checkpoint: checkpoint(),
      context: askContext({
        tool_slug: 'recued-core/reception-intake.intake.materialize',
        connection_name: 'reception-intake',
      }),
    });

    expect(ask.message.text).not.toContain(' on reception-intake');
    // Not dropped from the ask — it was never a second fact.
    expect(ask.message.text).toContain(
      'recued-core/reception-intake.intake.materialize',
    );
  });

  it('keeps the connection when it DIFFERS — the sandbox-vs-production case', () => {
    // The dedup compares whole segments, so the one difference that
    // decides the blast radius survives it.
    const ask = buildPreflightAsk({
      checkpoint: checkpoint(),
      context: askContext({
        tool_slug: 'recued-core/hubspot.deal.update',
        connection_name: 'hubspot-prod',
      }),
    });

    expect(ask.message.text).toContain(
      'recued-core/hubspot.deal.update on hubspot-prod',
    );
  });

  it('clips a generated recipe id MIDDLE-OUT so the numbered tail survives', () => {
    // Hand-written recipe ids are short and are left alone; the pack
    // machinery generates 56-character ones that mostly restate the
    // operation named later in the same sentence, in front of every word
    // that decides anything.
    const short = buildPreflightAsk({
      checkpoint: checkpoint(),
      context: askContext({ recipe_id: 'send-email', tool_slug: 'mail-send' }),
    });
    expect(short.message.text).toContain('Recipe send-email wants to run');

    // ⚠ These ids are NUMBERED. A tail cut would render `…-1` and `…-2`
    // identically — two different recipes reading as one, which is worse
    // than the length it fixed.
    const one = buildPreflightAsk({
      checkpoint: checkpoint(),
      context: askContext({
        recipe_id: 'reception-intake-review-then-approve-intake-materialize-1',
        tool_slug: 'recued-core/reception-intake.intake.materialize',
      }),
    });
    const two = buildPreflightAsk({
      checkpoint: checkpoint(),
      context: askContext({
        recipe_id: 'reception-intake-review-then-approve-intake-materialize-2',
        tool_slug: 'recued-core/reception-intake.intake.materialize',
      }),
    });

    expect(one.message.text).toContain(
      'Recipe reception-intake-review-…ke-materialize-1 wants to run',
    );
    expect(one.message.text).not.toBe(two.message.text);
  });

  it('drops the publisher handle from the TITLE and keeps it in the body', () => {
    // The title is also the Slack / Telegram / OS notification preview —
    // the one line a reader is guaranteed to see, and the part a phone
    // truncates from the front. `recued-core/` is the same on every
    // first-party op, so it buys nothing and costs the distinguishing half.
    const ask = buildPreflightAsk({
      checkpoint: checkpoint(),
      context: askContext({
        tool_slug: 'recued-core/reception-intake.intake.materialize',
        risk_tier: 'write',
      }),
    });

    expect(ask.message.title).toBe(
      'Approve reception-intake.intake.materialize (write)',
    );
    // Identity still stated in full, once, where identity belongs.
    expect(ask.message.text).toContain(
      'recued-core/reception-intake.intake.materialize',
    );
  });

  it('renders an unknown risk tier as no clause rather than "undefined"', () => {
    // `risk_tier` is a widened string across JSON persistence, so it can
    // carry a value the tier table has no row for.
    const ask = buildPreflightAsk({
      checkpoint: checkpoint(),
      context: askContext({ tool_slug: 't', risk_tier: 'not-a-tier' }),
    });
    expect(ask.message.text).not.toContain('undefined');
    expect(ask.message.text).toContain('Recued held it for your approval.');
  });

  it('puts the question last, after the evidence', () => {
    // What the buttons answer has to be the last thing read. An owner who
    // must scroll back up past the evidence to find the question is an
    // owner who stops reading the evidence.
    const ask = buildPreflightAsk({
      checkpoint: checkpoint(),
      context: askContext({
        tool_slug: 'core.mail.send',
        risk_tier: 'write',
        session_grant: {
          ttl_ms: 3_600_000,
          max_uses: 10,
          risk_tier: 'write',
          grant_mode: 'open',
        },
        open_projection_preview: {
          pinned: [{ label: 'connection', value: 'gmail-personal' }],
          varying: [{ label: 'to', origin: 'step.deals[].email' }],
        },
      }),
    });
    // Even with the open-grant block appended — which used to land AFTER
    // the question, because the question was baked into the sentence.
    expect(ask.message.text.trimEnd().endsWith('Approve?')).toBe(true);
    expect(ask.message.text).toContain('pinned  connection = gmail-personal');
  });

  it('omits absent pinned inputs from the approval copy without hiding meaningful falsy values', () => {
    const ask = buildPreflightAsk({
      checkpoint: checkpoint(),
      context: askContext({
        tool_slug: 'core.mail.send',
        risk_tier: 'write',
        session_grant: {
          ttl_ms: 3_600_000,
          max_uses: 10,
          risk_tier: 'write',
          grant_mode: 'open',
        },
        open_projection_preview: {
          pinned: [
            { label: 'to', value: '"client@example.test"' },
            { label: 'attachments', value: 'null' },
            { label: 'bcc', value: '""' },
            { label: 'cc', value: '"   "' },
            { label: 'track_opens', value: 'false' },
            { label: 'retry_count', value: '0' },
            { label: 'subject', value: '"null"' },
            { label: 'tags', value: '[]' },
          ],
          varying: [],
        },
      }),
    });

    expect(ask.message.text).toContain('pinned  to = "client@example.test"');
    expect(ask.message.text).not.toContain('pinned  attachments');
    expect(ask.message.text).not.toContain('pinned  bcc');
    expect(ask.message.text).not.toContain('pinned  cc');
    expect(ask.message.text).toContain('pinned  track_opens = false');
    expect(ask.message.text).toContain('pinned  retry_count = 0');
    expect(ask.message.text).toContain('pinned  subject = "null"');
    expect(ask.message.text).toContain('pinned  tags = []');
    expect(ask.message.text).toContain('only while its fixed inputs stay exactly as approved');
  });

  it('does not leave a dangling detail colon when every preview value is absent', () => {
    const ask = buildPreflightAsk({
      checkpoint: checkpoint(),
      context: askContext({
        tool_slug: 'core.mail.send',
        risk_tier: 'write',
        session_grant: {
          ttl_ms: 3_600_000,
          max_uses: 10,
          risk_tier: 'write',
          grant_mode: 'open',
        },
        open_projection_preview: {
          pinned: [
            { label: 'attachments', value: 'null' },
            { label: 'bcc', value: '""' },
          ],
          varying: [],
        },
      }),
    });

    expect(ask.message.text).not.toContain('pinned  ');
    expect(ask.message.text).toContain('(anything else re-asks).\n\nApprove?');
  });

  // D-182 §8 — the recipe-LESS raw-op door hold.
  it('renders an op-first sentence + raw_op_id payload for a raw-op hold (no recipe fields)', () => {
    const ask = buildPreflightAsk({
      checkpoint: rawOpCheckpoint(),
      context: rawOpContext({ reason: 'write tier' }),
    });

    expect(ask.options).toBe(PREFLIGHT_ASK_OPTIONS);
    expect(ask.handler).toEqual({
      kind: PREFLIGHT_HANDLER_KIND,
      payload: {
        checkpoint_id: 'checkpoint-raw-1',
        run_id: 'run-raw-1',
        raw_op_id: 'recued-core.crm-pack.deal.create',
        tool_slug: 'deal.create',
        risk_tier: 'write',
        reason: 'write tier',
      },
    });
    // No recipe/step phrasing or fields leak into a raw-op hold.
    expect(ask.handler.payload).not.toHaveProperty('recipe_id');
    expect(ask.handler.payload).not.toHaveProperty('gated_step_id');
    expect(ask.message.text).toContain('recued-core.crm-pack.deal.create');
    expect(ask.message.text).not.toContain('Recipe');
    expect(ask.message.text).not.toContain('step');
  });

  it('offers allow_session for a raw-op hold carrying a raw_op session-grant offer', () => {
    const ask = buildPreflightAsk({
      checkpoint: rawOpCheckpoint(),
      context: rawOpContext({
        session_grant: { ttl_ms: 3_600_000, max_uses: 5, risk_tier: 'write', grant_mode: 'raw_op' },
      }),
    });

    expect(ask.options).toBe(PREFLIGHT_ASK_OPTIONS_WITH_SESSION);
    expect(ask.handler.payload).toMatchObject({
      session_grant: { ttl_ms: 3_600_000, max_uses: 5, risk_tier: 'write', grant_mode: 'raw_op' },
    });
    // raw_op never renders the 'open' projection block.
    expect(ask.message.text).not.toContain('stays exactly as approved');
  });
});

describe('createPreflightAnswerHandler', () => {
  it('persists the paired standing ruling before approving the held call', async () => {
    const cp = checkpoint();
    const store = checkpointStore(cp);
    const order: string[] = [];
    const r = resumer();
    r.resumeRun.mockImplementation(async () => {
      order.push('resume');
    });
    const upsertOverride = vi.fn(async () => {
      order.push('override');
    });
    const offer = {
      kind: 'never_ask' as const,
      ingredient_id: 'recued-core/github',
      operation_id: 'recued-core/github.issue.read',
      op_hash: 'a'.repeat(64),
      approval: 'never' as const,
    };
    const handler = createPreflightAnswerHandler({
      checkpointStore: store,
      resumer: r,
      upsertOverride,
    });

    await handler(
      payload({ owner_override_offer: offer }),
      answer(NEVER_ASK_OPERATION_OPTION_ID),
    );

    expect(upsertOverride).toHaveBeenCalledWith(offer);
    expect(order).toEqual(['override', 'resume']);
    expect(store.delete).toHaveBeenCalledWith('checkpoint-1');
  });

  it('does not persist a standing ruling after its checkpoint was consumed', async () => {
    const store = checkpointStore(null);
    const upsertOverride = vi.fn();
    const r = resumer();
    const offer = {
      kind: 'never_ask' as const,
      ingredient_id: 'recued-core/github',
      operation_id: 'recued-core/github.issue.read',
      op_hash: 'a'.repeat(64),
      approval: 'never' as const,
    };
    const handler = createPreflightAnswerHandler({
      checkpointStore: store,
      resumer: r,
      upsertOverride,
    });

    await handler(
      payload({ owner_override_offer: offer }),
      answer(NEVER_ASK_OPERATION_OPTION_ID),
    );

    expect(upsertOverride).not.toHaveBeenCalled();
    expect(r.resumeRun).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();
  });

  it('fails closed when a standing-ruling answer has no valid paired offer', async () => {
    const store = checkpointStore(checkpoint());
    const r = resumer();
    const handler = createPreflightAnswerHandler({
      checkpointStore: store,
      resumer: r,
      upsertOverride: vi.fn(),
    });

    await expect(handler(
      payload({
        owner_override_offer: {
          kind: 'never_ask',
          ingredient_id: 'recued-core/github',
          operation_id: 'recued-core/github.issue.read',
          op_hash: 'a'.repeat(64),
          approval: 'ask',
        },
      }),
      answer(NEVER_ASK_OPERATION_OPTION_ID),
    )).rejects.toThrow(/does not match a valid offer/);
    await expect(handler(
      payload({
        owner_override_offer: {
          kind: 'never_ask',
          ingredient_id: 'recued-core/github',
          operation_id: 'recued-core/github.issue.read',
          approval: 'never',
        },
      }),
      answer(NEVER_ASK_OPERATION_OPTION_ID),
    )).rejects.toThrow(/does not match a valid offer/);
    expect(r.resumeRun).not.toHaveBeenCalled();
    expect(r.denyRun).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();
  });

  it('resumes and consumes the checkpoint on approve', async () => {
    const cp = checkpoint();
    const store = checkpointStore(cp);
    const r = resumer();
    const handler = createPreflightAnswerHandler({ checkpointStore: store, resumer: r });

    // A persisted payload cannot spoof the host-side decision timestamp.
    await handler(payload({ approved_at: 1 }), answer('approve'));

    expect(store.get).toHaveBeenCalledWith('checkpoint-1');
    expect(r.resumeRun).toHaveBeenCalledTimes(1);
    expect(r.resumeRun).toHaveBeenCalledWith(cp, {
      recipe_id: 'recipe-1',
      gated_step_id: 'gated_step',
      tool_slug: 'admin-tool',
      risk_tier: 'admin',
      reason: 'admin tier needs approval',
      approved_at: ANSWERED_AT,
    });
    expect(r.denyRun).not.toHaveBeenCalled();
    expect(store.delete).toHaveBeenCalledTimes(1);
    expect(store.delete).toHaveBeenCalledWith('checkpoint-1');
  });

  it('denies and consumes the checkpoint on deny', async () => {
    const cp = checkpoint();
    const store = checkpointStore(cp);
    const r = resumer();
    const handler = createPreflightAnswerHandler({ checkpointStore: store, resumer: r });

    await handler(payload(), answer('deny'));

    expect(r.denyRun).toHaveBeenCalledTimes(1);
    expect(r.denyRun).toHaveBeenCalledWith(cp, expect.objectContaining({
      recipe_id: 'recipe-1',
      gated_step_id: 'gated_step',
    }));
    expect(r.resumeRun).not.toHaveBeenCalled();
    expect(store.delete).toHaveBeenCalledWith('checkpoint-1');
  });

  it('treats any non-approve option as deny', async () => {
    const cp = checkpoint();
    const store = checkpointStore(cp);
    const r = resumer();
    const handler = createPreflightAnswerHandler({ checkpointStore: store, resumer: r });

    await handler(payload(), answer('unexpected-option'));

    expect(r.denyRun).toHaveBeenCalledTimes(1);
    expect(r.resumeRun).not.toHaveBeenCalled();
    expect(store.delete).toHaveBeenCalledWith('checkpoint-1');
  });

  it('silently skips when the checkpoint is already absent', async () => {
    const store = checkpointStore(null);
    const r = resumer();
    const handler = createPreflightAnswerHandler({ checkpointStore: store, resumer: r });

    await handler(payload(), answer('approve'));

    expect(store.get).toHaveBeenCalledWith('checkpoint-1');
    expect(r.resumeRun).not.toHaveBeenCalled();
    expect(r.denyRun).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();
  });

  it.each([
    ['missing checkpoint_id', payload({ checkpoint_id: undefined })],
    ['empty checkpoint_id', payload({ checkpoint_id: '' })],
    ['non-string checkpoint_id', payload({ checkpoint_id: 42 })],
    ['missing run_id', payload({ run_id: undefined })],
    ['missing recipe_id', payload({ recipe_id: undefined })],
    ['missing gated_step_id', payload({ gated_step_id: undefined })],
  ])('throws on malformed payload: %s', async (_name, badPayload) => {
    const store = checkpointStore(checkpoint());
    const r = resumer();
    const handler = createPreflightAnswerHandler({ checkpointStore: store, resumer: r });

    await expect(handler(badPayload, answer('approve'))).rejects.toThrow(
      /malformed payload/,
    );
    expect(store.get).not.toHaveBeenCalled();
    expect(r.resumeRun).not.toHaveBeenCalled();
    expect(r.denyRun).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();
  });

  // D-182 §8 — the recipe-LESS raw-op door hold answer round-trip. The payload
  // carries `raw_op_id` (not recipe_id/gated_step_id); the handler reconstructs
  // a recipe-less context and routes the FULL held call (off the checkpoint's
  // `raw_op` block) to the resumer.
  it('resumes a raw-op hold with a recipe-less context on approve', async () => {
    const cp = rawOpCheckpoint();
    const store = checkpointStore(cp);
    const r = resumer();
    const handler = createPreflightAnswerHandler({ checkpointStore: store, resumer: r });

    await handler(rawOpPayload(), answer('approve'));

    expect(store.get).toHaveBeenCalledWith('checkpoint-raw-1');
    expect(r.resumeRun).toHaveBeenCalledTimes(1);
    expect(r.resumeRun).toHaveBeenCalledWith(cp, {
      raw_op: { op_id: 'recued-core.crm-pack.deal.create' },
      tool_slug: 'deal.create',
      risk_tier: 'write',
      approved_at: ANSWERED_AT,
    });
    // No recipe identity is reconstructed for a raw-op hold.
    const ctx = r.resumeRun.mock.calls[0][1] as Record<string, unknown>;
    expect(ctx).not.toHaveProperty('recipe_id');
    expect(ctx).not.toHaveProperty('gated_step_id');
    expect(store.delete).toHaveBeenCalledWith('checkpoint-raw-1');
  });

  it('threads the raw_op session-grant bounds on allow_session', async () => {
    const cp = rawOpCheckpoint();
    const store = checkpointStore(cp);
    const r = resumer();
    const handler = createPreflightAnswerHandler({ checkpointStore: store, resumer: r });

    await handler(
      rawOpPayload({ session_grant: { ttl_ms: 3_600_000, max_uses: 5, risk_tier: 'write', grant_mode: 'raw_op' } }),
      answer('allow_session'),
    );

    expect(r.resumeRun).toHaveBeenCalledTimes(1);
    const ctx = r.resumeRun.mock.calls[0][1] as { session_grant?: unknown };
    // readSessionGrantPayload preserves the bounds; the raw-op resume mints by
    // the checkpoint discriminant, so grant_mode 'raw_op' need not round-trip.
    expect(ctx.session_grant).toMatchObject({ ttl_ms: 3_600_000, max_uses: 5, risk_tier: 'write' });
  });

  it('denies a raw-op hold on deny', async () => {
    const cp = rawOpCheckpoint();
    const store = checkpointStore(cp);
    const r = resumer();
    const handler = createPreflightAnswerHandler({ checkpointStore: store, resumer: r });

    await handler(rawOpPayload(), answer('deny'));

    expect(r.denyRun).toHaveBeenCalledTimes(1);
    expect(r.resumeRun).not.toHaveBeenCalled();
    expect(store.delete).toHaveBeenCalledWith('checkpoint-raw-1');
  });

  it('does NOT throw for a raw-op payload lacking recipe_id/gated_step_id', async () => {
    const store = checkpointStore(rawOpCheckpoint());
    const r = resumer();
    const handler = createPreflightAnswerHandler({ checkpointStore: store, resumer: r });
    // raw_op_id present + recipe fields absent is the valid recipe-less shape.
    await expect(handler(rawOpPayload(), answer('approve'))).resolves.toBeUndefined();
    expect(r.resumeRun).toHaveBeenCalledTimes(1);
  });

  it('allows at-least-once dispatch when the checkpoint remains readable', async () => {
    const cp = checkpoint();
    const store = checkpointStore(cp);
    const r = resumer();
    const handler = createPreflightAnswerHandler({ checkpointStore: store, resumer: r });

    await handler(payload(), answer('approve'));
    await handler(payload(), answer('approve'));

    expect(store.get).toHaveBeenCalledTimes(2);
    expect(r.resumeRun).toHaveBeenCalledTimes(2);
    expect(store.delete).toHaveBeenCalledTimes(2);
  });

  it('silently skips a retry after the checkpoint was consumed', async () => {
    const cp = checkpoint();
    const store = checkpointStore(cp);
    store.get.mockResolvedValueOnce(cp).mockResolvedValueOnce(null);
    const r = resumer();
    const handler = createPreflightAnswerHandler({ checkpointStore: store, resumer: r });

    await handler(payload(), answer('approve'));
    await handler(payload(), answer('approve'));

    expect(store.get).toHaveBeenCalledTimes(2);
    expect(r.resumeRun).toHaveBeenCalledTimes(1);
    expect(r.denyRun).not.toHaveBeenCalled();
    expect(store.delete).toHaveBeenCalledTimes(1);
  });
});

describe('raisePreflightAsk', () => {
  it('calls notifier.ask with the constructed ask and returns the ask_id', async () => {
    const notifier: PreflightNotifier = {
      ask: vi.fn().mockResolvedValue({ ask_id: 'ask-test-1' }),
      registerAskHandler: vi.fn(),
      notify: vi.fn().mockResolvedValue(undefined),
    };

    await expect(raisePreflightAsk(notifier, {
      checkpoint: checkpoint(),
      context: askContext({
        tool_slug: 'admin-tool',
        risk_tier: 'admin',
        reason: 'approval reason',
      }),
    })).resolves.toEqual({ ask_id: 'ask-test-1' });

    expect(notifier.ask).toHaveBeenCalledTimes(1);
    expect(notifier.ask).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('approval reason'),
      }),
      PREFLIGHT_ASK_OPTIONS,
      {
        kind: PREFLIGHT_HANDLER_KIND,
        payload: expect.objectContaining({
          checkpoint_id: 'checkpoint-1',
          run_id: 'run-1',
          recipe_id: 'recipe-1',
          gated_step_id: 'gated_step',
        }),
      },
    );
  });
});

describe('TR-7 no technical timeout', () => {
  it('does not introduce timers or abort controllers in the preflight leaf sources', () => {
    const source = [
      readFileSync(new URL('../preflight-gate.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../preflight-reconciliation.ts', import.meta.url), 'utf8'),
    ].join('\n');

    expect(source).not.toMatch(/\bsetTimeout\b/);
    expect(source).not.toMatch(/\bsetInterval\b/);
    expect(source).not.toMatch(/\bAbortController\b/);
  });
});
