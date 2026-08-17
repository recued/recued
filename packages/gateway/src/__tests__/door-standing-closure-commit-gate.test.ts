/** Door standing closure at the COMMIT gate — the half that had no test.
 *
 *  ⛔⛔ WRITTEN BECAUSE THE UNTESTED HALF WAS BROKEN AND LOOKED FINE.
 *  `standingClosureAdmits` was called here with `identity.execution_source` — a
 *  field that does not exist on `CommitRunIdentity` (it is `identity.source`).
 *  It read `undefined`, the contract-id match could never succeed, and this gate
 *  admitted NOTHING. Nothing went red: a standing closure that never admits is
 *  byte-identical, from the outside, to a door without one — it just keeps
 *  asking, which is what doors do. Only `tsc` ever saw it.
 *
 *  🔑 The doc claimed *"one predicate, two gates"*. That was true of the
 *  predicate and false of the second gate, and the only thing that could tell
 *  the difference was a test that dispatched a kernel op on an opted-in door.
 *  This is that test.
 *
 *  ⚠ These drive the gate directly rather than through a door bind: the bind →
 *  snapshot → catalog-gate chain is covered end to end in
 *  `backend/.../door-standing-closure-e2e.test.ts`. What is unique here is the
 *  SECOND dispatch path — a simple-form kernel op (`core.mail.send`), which
 *  never touches the catalog gate at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type AdmissionDecision,
  type Commit,
  type ContractSnapshot,
  type ExecutionSource,
} from '@recued/contracts';
import {
  createCommitStore,
  createInMemoryCollection,
  type Collection,
  type CommitStore,
} from '@recued/storage';

import {
  wrapWithCommitGateway,
  type CommitGatewayDeps,
  type CommitRunIdentity,
  type GatewayInner,
} from '../commit-gateway.js';

const DISPATCHED_AT = 1_700_000_000_000;
const COMPLETED_AT = 1_700_000_000_125;
const CONTRACT_ID = 'contract-door-1';
const MAIL_SEND = 'core.mail.send';

/** A reception door's own dispatch — anonymous visitor, this door's contract. */
const doorSource = (contract_id: string = CONTRACT_ID): ExecutionSource => ({
  channel: 'reception',
  actor: 'anonymous',
  reception_id: 'ep-1',
  contract_id,
} as unknown as ExecutionSource);

const snapshot = (
  overrides: Partial<ContractSnapshot> = {},
): ContractSnapshot => ({
  contract_id: CONTRACT_ID,
  contract_version: 'authority-sha256-v1:test',
  allowed_tools: [],
  approval_required: [],
  scope_restrictions: [],
  resolved_at: DISPATCHED_AT,
  standing_closure_operation_ids: [MAIL_SEND],
  ...overrides,
});

const identity = (
  overrides: Partial<CommitRunIdentity> = {},
): CommitRunIdentity => ({
  request_id: 'request-1',
  source: doorSource(),
  channel_session_id: 'reception:ep-1',
  correlation_id: 'corr-1',
  dispatch_depth: 0,
  contract_snapshot: snapshot(),
  ...overrides,
});

const sequence = <T>(values: readonly T[]): (() => T) => {
  let index = 0;
  return () => {
    if (index >= values.length) throw new Error(`sequence exhausted at ${index}`);
    return values[index] as T;
  };
};

const askDecision = (
  risk_tier: string = 'write',
): AdmissionDecision => ({
  verdict: 'ask',
  risk_tier,
  detail: 'approval required',
  authorization_provenance: { pre_lift_approval: 'ask' },
} as unknown as AdmissionDecision);

let backing: Collection<Commit>;
let store: CommitStore;

beforeEach(() => {
  backing = createInMemoryCollection<Commit>();
  store = createCommitStore(backing);
});

const deps = (overrides: Partial<CommitGatewayDeps> = {}): CommitGatewayDeps => ({
  commitStore: store,
  identity: identity(),
  getIngredientCategory: () => 'data',
  genCommitId: sequence(['commit-1']),
  genIdempotencyKey: sequence(['idem-1']),
  now: sequence([DISPATCHED_AT, COMPLETED_AT]),
  ...overrides,
} as unknown as CommitGatewayDeps);

/** Did the op actually RUN, or did the gate hold it? A hold throws the
 *  preflight signal rather than returning, so "inner was called" is the only
 *  assertion that cannot be satisfied by a gate that merely looked at it. */
const dispatch = async (
  overrides: Partial<CommitGatewayDeps>,
  slug: string = MAIL_SEND,
): Promise<{ ran: boolean; error: unknown }> => {
  const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
  const executor = wrapWithCommitGateway(inner, deps({
    evaluateAdmission: () => askDecision(),
    resolveArgsForHash: () => ({ to: 'ada@example.com' }),
    ...overrides,
  } as Partial<CommitGatewayDeps>));
  let error: unknown;
  try {
    await executor(slug, { to: '{{config.to}}' });
  } catch (err) {
    error = err;
  }
  return { ran: inner.mock.calls.length > 0, error };
};

describe('door standing closure — the commit gate', () => {
  it('⛔⛔ admits a kernel op named in the door\'s confirmed closure', async () => {
    const { ran } = await dispatch({});
    expect(ran).toBe(true);
  });

  /** ⛔ THE ONE THAT CATCHES `identity.execution_source`. The test above passes
   *  only if the gate read the source correctly — but so would a gate that
   *  admitted unconditionally. This pins that the CONTRACT ID is what decided:
   *  same closure, same op, a source pointing at a DIFFERENT door ⇒ held. A gate
   *  reading a nonexistent field fails the first; a gate ignoring the source
   *  fails this one. Neither alone is sufficient. */
  it('⛔ holds when the dispatch runs under a DIFFERENT contract than the snapshot', async () => {
    const { ran } = await dispatch({
      identity: identity({ source: doorSource('contract-someone-else') }),
    });
    expect(ran).toBe(false);
  });

  it('⛔ holds an op the owner never confirmed', async () => {
    const { ran } = await dispatch({
      identity: identity({
        contract_snapshot: snapshot({ standing_closure_operation_ids: ['core.mail.read'] }),
      }),
    });
    expect(ran).toBe(false);
  });

  it('⛔ holds a destructive op even when the closure names it', async () => {
    const { ran } = await dispatch({
      evaluateAdmission: () => askDecision('destructive'),
      resolveArgsForHash: () => ({ to: 'ada@example.com' }),
    });
    expect(ran).toBe(false);
  });

  it('⛔ holds a door with no standing closure at all — every door before this existed', async () => {
    const { ran } = await dispatch({
      identity: identity({
        contract_snapshot: snapshot({ standing_closure_operation_ids: undefined }),
      }),
    });
    expect(ran).toBe(false);
  });

  it('⛔ holds an identity-less dispatch rather than dereferencing it', async () => {
    const { ran } = await dispatch({ identity: undefined });
    expect(ran).toBe(false);
  });
});
