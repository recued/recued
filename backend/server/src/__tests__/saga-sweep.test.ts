/** D-287 follow-on — the torn-saga boot sweep.
 *
 *  Driven through `runTornSagaSweep` (the server wiring) rather than
 *  `sweepTornSagas` (the pure leaf), deliberately. The leaf takes the candidate
 *  set as a seam, so a leaf-only test can never exercise the one thing that
 *  makes this feature safe: that the candidate query asks for FAILED anchors
 *  and nothing else. Stubbing that seam would test the stub.
 */
import type { Commit, ExecutionSource, IngredientManifest } from '@recued/contracts';
import { SAGA_ANNOTATION_KEY, SAGA_HANDLER_KIND, SAGA_TARGET_COLLECTION } from '@recued/gateway';
import { describe, expect, it, vi } from 'vitest';

import { runTornSagaSweep, type TornSagaSweepWiring } from '../saga-server-wiring.js';

const DISPATCHED_AT = Date.parse('2026-06-01T10:00:00.000Z');

const source = (): ExecutionSource => ({
  channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'user-1',
});

const op = (operation_id: string, risk_tier: string): Record<string, unknown> => ({
  operation_id, description: `${operation_id} fixture`, risk_tier,
  groups: [], required_scopes: [],
});

const catalog = (): IngredientManifest => ({
  slug: 'hubspot-catalog', name: 'HubSpot catalog fixture',
  description: 'Minimal saga classifier fixture.', author: 'recued-core',
  kind: 'connection', version: 1, category: 'data', risk_tier: 'read',
  input: { operation: null, args: null }, output: { result: 'result' },
  operations: {
    'deal.create': op('recued-core/hubspot.deal.create', 'write'),
    'deal.delete': op('recued-core/hubspot.deal.delete', 'destructive'),
  },
  surfaces: {
    api: {
      executes: {
        'deal.create': { kind: 'rest', method: 'POST', path_template: '/crm/v3/objects/deals' },
        'deal.delete': { kind: 'rest', method: 'DELETE', path_template: '/crm/v3/objects/deals/{{deal_id}}' },
      },
    },
  },
} as unknown as IngredientManifest);

const landedWrite = (run_id: string, overrides: Partial<Commit> = {}): Commit => ({
  commit_id: `commit-${run_id}`, kind: 'action',
  ingredient: 'hubspot-catalog', tool: 'hubspot-catalog',
  args: { connection_kind: 'api', method: 'POST', path: '/crm/v3/objects/deals', connection: 'hubspot1' },
  status: 'succeeded', source: source(), channel_session_id: 'chat:chat-1',
  correlation_id: 'corr-1', dispatch_depth: 0, idempotency_key: `idem-${run_id}`,
  dispatched_at: DISPATCHED_AT, request_id: run_id,
  ...overrides,
} as Commit);

const anchor = (run_id: string, commit_status: string) =>
  ({ run_id, recipe_id: `recipe-for-${run_id}`, commit_status }) as never;

const wiring = (over: Partial<TornSagaSweepWiring> & {
  anchors?: Record<string, ReturnType<typeof anchor>[]>;
  commits?: Record<string, Commit[]>;
  annotations?: Record<string, Array<{ key: string }>>;
  openAsks?: Array<{ handler_kind: string; handler_payload: Record<string, unknown> }>;
} = {}) => {
  const ask = vi.fn().mockResolvedValue({ ask_id: 'ask-1' });
  const listByCommitStatus = vi.fn(async (status: string, limit: number) =>
    (over.anchors?.[status] ?? []).slice(0, limit) as never);
  const listOpenAsks = vi.fn(async () => over.openAsks ?? []);
  const full: TornSagaSweepWiring = {
    auditLog: { listByCommitStatus } as never,
    commitStore: { listByRun: async (run_id: string) => over.commits?.[run_id] ?? [] },
    annotationStore: {
      annotationsForRecord: async (_c: string, id: string) =>
        (over.annotations?.[id] ?? []) as never,
    } as never,
    notifier: { ask } as never,
    listOpenAsks,
    getManifest: (slug) => (slug === 'hubspot-catalog' ? catalog() : undefined),
    ...over,
  };
  return { wiring: full, ask, listByCommitStatus, listOpenAsks };
};

describe('torn-saga boot sweep', () => {
  it('raises one ask for a failed run whose write had already landed', async () => {
    const { wiring: w, ask } = wiring({
      anchors: { failed: [anchor('run-1', 'failed')] },
      commits: { 'run-1': [landedWrite('run-1')] },
    });
    const result = await runTornSagaSweep(w);

    expect(result).toMatchObject({ scanned: 1, raised: 1, suppressed: 0, errored: 0 });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  /** ⛔⛔ THE SAFETY PROPERTY, AND THE REASON THIS TEST DRIVES THE WIRING.
   *
   *  `detectTornSaga` returns a saga for ANY landed write — it cannot tell a
   *  failed run from a successful one. So the only thing standing between the
   *  owner and "every successful multi-write recipe failed after acting" is
   *  that the candidate query asks for `'failed'`. Asserting the ARGUMENT is
   *  what pins it: a succeeded anchor with an identical landed write exists in
   *  this fixture and must never be reached. */
  it('asks the audit log only for failed anchors, never for succeeded ones', async () => {
    const { wiring: w, ask, listByCommitStatus } = wiring({
      anchors: {
        failed: [],
        succeeded: [anchor('run-ok', 'succeeded')],
      },
      commits: { 'run-ok': [landedWrite('run-ok')] },
    });
    const result = await runTornSagaSweep(w);

    expect(listByCommitStatus).toHaveBeenCalledTimes(1);
    expect(listByCommitStatus).toHaveBeenCalledWith('failed', expect.any(Number));
    expect(result.scanned).toBe(0);
    expect(ask).not.toHaveBeenCalled();
  });

  it('skips a run that already carries an open saga ask', async () => {
    const { wiring: w, ask } = wiring({
      anchors: { failed: [anchor('run-1', 'failed')] },
      commits: { 'run-1': [landedWrite('run-1')] },
      openAsks: [{ handler_kind: SAGA_HANDLER_KIND, handler_payload: { run_id: 'run-1' } }],
    });
    const result = await runTornSagaSweep(w);

    expect(result).toMatchObject({ scanned: 1, raised: 0, suppressed: 1 });
    expect(ask).not.toHaveBeenCalled();
  });

  it('ignores an open ask of a different kind that happens to carry a run_id', async () => {
    const { wiring: w, ask } = wiring({
      anchors: { failed: [anchor('run-1', 'failed')] },
      commits: { 'run-1': [landedWrite('run-1')] },
      openAsks: [{ handler_kind: 'gateway.in_doubt', handler_payload: { run_id: 'run-1' } }],
    });
    await runTornSagaSweep(w);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('skips a run the owner already answered, whose ask is long gone', async () => {
    const { wiring: w, ask } = wiring({
      anchors: { failed: [anchor('run-1', 'failed')] },
      commits: { 'run-1': [landedWrite('run-1')] },
      annotations: { 'run-1': [{ key: SAGA_ANNOTATION_KEY }] },
    });
    const result = await runTornSagaSweep(w);

    expect(result).toMatchObject({ raised: 0, suppressed: 1 });
    expect(ask).not.toHaveBeenCalled();
  });

  it('ignores an unrelated annotation on the same run', async () => {
    const { wiring: w, ask } = wiring({
      anchors: { failed: [anchor('run-1', 'failed')] },
      commits: { 'run-1': [landedWrite('run-1')] },
      annotations: { 'run-1': [{ key: 'summary' }] },
    });
    await runTornSagaSweep(w);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('says nothing about a failed run where no write landed', async () => {
    const { wiring: w, ask } = wiring({
      anchors: { failed: [anchor('run-1', 'failed')] },
      commits: { 'run-1': [landedWrite('run-1', { status: 'failed' })] },
    });
    const result = await runTornSagaSweep(w);

    expect(result).toMatchObject({ scanned: 1, raised: 0, suppressed: 0 });
    expect(ask).not.toHaveBeenCalled();
  });

  /** One unreadable run must not cost the owner every other disclosure. */
  it('carries on past a run that throws, and counts it', async () => {
    const { wiring: w, ask } = wiring({
      anchors: { failed: [anchor('run-bad', 'failed'), anchor('run-2', 'failed')] },
      commits: { 'run-2': [landedWrite('run-2')] },
      commitStore: {
        listByRun: async (run_id: string) => {
          if (run_id === 'run-bad') throw new Error('commit log unreadable');
          return [landedWrite(run_id)];
        },
      },
      log: () => undefined,
    });
    const result = await runTornSagaSweep(w);

    expect(result).toMatchObject({ scanned: 2, raised: 1, errored: 1 });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  /** ⚠ One read for the whole sweep, not one per candidate — otherwise a
   *  200-anchor boot pays 200 store reads to answer a question one read
   *  answers, and the cost only shows up on the servers with the most history. */
  it('reads the open-ask set once regardless of how many runs it inspects', async () => {
    const { wiring: w, listOpenAsks } = wiring({
      anchors: { failed: [anchor('a', 'failed'), anchor('b', 'failed'), anchor('c', 'failed')] },
      commits: { a: [landedWrite('a')], b: [landedWrite('b')], c: [landedWrite('c')] },
    });
    await runTornSagaSweep(w);
    expect(listOpenAsks).toHaveBeenCalledTimes(1);
  });

  it('honours the limit it is given', async () => {
    const { wiring: w, listByCommitStatus } = wiring({ anchors: { failed: [] } });
    await runTornSagaSweep(w, 7);
    expect(listByCommitStatus).toHaveBeenCalledWith('failed', 7);
  });
});
