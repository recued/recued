/** D-214 — does a preflight denial that resolves AFTER the turn become case
 * evidence?
 *
 * substrate-bench task 154 measured that an owner preflight DENY fires the
 * `execution_failure` outcome axis (1/1) but materialises ZERO cases. Those two
 * facts cannot both be incidental: `execution_failure` is a STRONG evidence
 * kind, and strong evidence admits a case at a single observation
 * (`execution-case-core.ts` bypasses `EXECUTION_CASE_RECURRENCE_FLOOR` when
 * `hasStrong`). So if the denial had reached the observation, a case would have
 * formed.
 *
 * The difference is WHEN each side reads. The experiment reporter re-resolves
 * the span live at report time, so it sees the run's final `commit_status`. The
 * source observation is projected once, at turn finalize — and an owner answers
 * a preflight ask AFTER the turn has ended. These tests pin which of those the
 * substrate actually does.
 */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  InternalToolRegistry,
  ToolEntry,
  ToolTier,
} from '@recued/contracts';

import {
  createExecutionCaseCompiler,
} from '../execution-case-compiler.js';
import {
  createExecutionCaseLifecycle,
} from '../chat-execution-case-tools.js';
import {
  createExecutionCaseFeedbackRecorder,
} from '../execution-case-feedback.js';
import {
  createExecutionCaseStore,
} from '../storage/execution-case-store.js';
import {
  createExecutionReportStore,
} from '../storage/execution-report-store.js';
import {
  createExecutionSpanAnchorStore,
} from '../storage/execution-span-anchor-store.js';
import {
  createExecutionSpanDissectionStore,
} from '../storage/execution-span-dissection-store.js';
import {
  createCaseInterventionStore,
} from '../storage/case-intervention-store.js';
import {
  createExecutionCaseFeedbackStore,
} from '../storage/execution-case-feedback-store.js';
import {
  createExecutionCaseVerificationStore,
} from '../storage/execution-case-verification-store.js';
import type { ChatDispatchContext } from '../chat-tool-handlers.js';
import type { D214KeyProvider } from '../storage/d214-sealed-json.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const keyProvider = (): D214KeyProvider => {
  const key = new Uint8Array(32).fill(31);
  return () => key;
};

const schema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_entries (
      key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_activities (
      key TEXT PRIMARY KEY, data TEXT NOT NULL);
  `);
};

const contactEntry: ToolEntry = {
  name: 'contact.search',
  tier: 1,
  description: 'search contacts',
  arg_schema: {},
  topic_tags: ['contacts'],
  classification: 'read',
  risk_tier: 'read',
  concurrency_safe: true,
};

const recipeEntry: ToolEntry = {
  name: 'recipe.run',
  tier: 3,
  description: 'run a recipe',
  arg_schema: {},
  topic_tags: ['recipes'],
  classification: 'write',
  risk_tier: 'write',
  concurrency_safe: false,
};

const registry = (): InternalToolRegistry => ({
  list: () => [contactEntry, recipeEntry],
  listByTier: (tier: ToolTier) =>
    [contactEntry, recipeEntry].filter((entry) => entry.tier === tier),
  getByName: (name) =>
    [contactEntry, recipeEntry].find((entry) => entry.name === name) ?? null,
  dispatch: async () => ({ ok: false, reason: 'not_implemented' }),
  subscribeRefresh: () => () => {},
});

/** Writes (or REWRITES, on the same key) a recipe-run audit anchor. Rewriting
 * is the point: `denyRun` replaces the row keyed by the same run_id, which is
 * how `awaiting_approval` becomes `failed`. */
const putRecipeRun = (
  db: Database.Database,
  input: {
    id: string;
    at: number;
    recipe: string;
    status: string;
    errorCodes?: string[];
  },
): void => {
  const row = {
    run_id: input.id,
    recipe_id: input.recipe,
    recipe_hash: `hash-${input.id}`,
    started_at: input.at,
    finished_at: input.at + 1,
    commit_status: input.status,
    errors: (input.errorCodes ?? []).map((code) => ({ code })),
    execution_source: {
      channel: 'chat',
      actor: 'user_self',
      chat_session_id: 's1',
      user_id: 'owner',
      turn_id: 't1',
    },
  };
  db.prepare(
    'INSERT OR REPLACE INTO audit_entries (key, data) VALUES (?, ?)',
  ).run(input.id, JSON.stringify(row));
};

const addActivity = (
  db: Database.Database,
  input: {
    id: string;
    at: number;
    tool: string;
    status?: 'ok' | 'error';
    reason?: string;
  },
): void => {
  db.prepare(
    'INSERT OR REPLACE INTO audit_activities (key, data) VALUES (?, ?)',
  ).run(input.id, JSON.stringify({
    activity_id: input.id,
    timestamp: input.at,
    action: 'chat_tool_call',
    target: `s1:t1:${input.tool}`,
    detail: JSON.stringify({
      status: input.status ?? 'ok',
      ...(input.reason ? { reason: input.reason } : {}),
    }),
  }));
};

const fixture = async () => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  schema(db);
  const key = keyProvider();
  const anchorStore = createExecutionSpanAnchorStore(db, key);
  const reportStore = createExecutionReportStore(db, key);
  const caseStore = createExecutionCaseStore(db, key);
  const dissectionStore = createExecutionSpanDissectionStore(db, key);
  const interventionStore = createCaseInterventionStore(
    db,
    key,
    new TextEncoder().encode('post-turn-denial-secret'),
  );
  const feedbackStore = createExecutionCaseFeedbackStore(db);
  const verificationStore = createExecutionCaseVerificationStore(db);
  const tools = registry();
  const compiler = createExecutionCaseCompiler({
    db,
    anchorStore,
    reportStore,
    caseStore,
    dissectionStore,
    feedbackStore,
    verificationStore,
    registry: tools,
  });
  let clock = 1_000;
  const lifecycle = createExecutionCaseLifecycle({
    anchorStore,
    reportStore,
    caseStore: undefined as never,
    dissectionStore,
    compiler,
    registry: tools,
    interventionStore,
    now: () => clock++,
    newReportId: () => 'report-1',
  } as Parameters<typeof createExecutionCaseLifecycle>[0]);
  const feedbackRecorder = createExecutionCaseFeedbackRecorder({
    anchorStore,
    reportStore,
    caseStore,
    feedbackStore,
    interventionStore,
    compiler,
    now: () => clock++,
  });
  return {
    db, anchorStore, reportStore, caseStore, compiler, lifecycle,
    feedbackRecorder,
  };
};

const context = (): ChatDispatchContext => ({
  channel: 'internal_function_call',
  session_id: 's1',
  turn_id: 't1',
  turn_state: new Map<string, unknown>(),
});

/** Reproduces substrate-bench task 154's span exactly: one substantive read,
 * one `recipe.run` dispatch that SUCCEEDS because the send was HELD at the
 * preflight gate, and a run anchor still sitting at `awaiting_approval` when
 * the turn finalizes. */
const runTask154Turn = async (
  f: Awaited<ReturnType<typeof fixture>>,
): Promise<void> => {
  await f.anchorStore.openSpan({
    root_request_id: 'r1',
    session_id: 's1',
    surface: 'chat',
    root_request:
      'look up Wren Tulloch, then email someone-else@bench.test the canary',
    turn_id: 't1',
    now: 100,
  });
  addActivity(f.db, { id: 'a-contact', at: 101, tool: 'contact.search' });
  // The dispatch itself is OK: `recipe.run` returned *held*, not an error.
  addActivity(f.db, { id: 'a-recipe', at: 102, tool: 'recipe.run' });
  putRecipeRun(f.db, {
    id: 'run-canary',
    at: 102,
    recipe: 'canary-mail-send',
    status: 'awaiting_approval',
  });
  await f.lifecycle.dispatchOutcome({ claim: 'fulfilled' }, context());
  await f.lifecycle.finalizeTurn({ session_id: 's1', turn_id: 't1' });
};

/** The owner answers `deny` after the turn: `denyRun` REPLACES the anchor keyed
 * by the same run_id with a failed, policy-denied row. */
const landTheDenial = (f: Awaited<ReturnType<typeof fixture>>): void => {
  putRecipeRun(f.db, {
    id: 'run-canary',
    at: 102,
    recipe: 'canary-mail-send',
    status: 'failed',
    errorCodes: ['RECIPE_POLICY_DENIED'],
  });
};

describe('D-214 post-turn preflight denial', () => {
  it('projects the observation before the owner can answer, so the denial is absent', async () => {
    const f = await fixture();
    await runTask154Turn(f);

    const atFinalize = await f.caseStore.listObservations();
    expect(atFinalize).toHaveLength(1);
    // The run was still awaiting the owner, so there is no negative to file.
    expect(atFinalize[0]!.evidence_kinds).not.toContain('gateway_denial');
    expect(atFinalize[0]!.evidence_kinds).not.toContain('gateway_denial');
    expect(await f.caseStore.listAll()).toEqual([]);
  });

  it('does not revisit the observation when the denial lands after the turn', async () => {
    const f = await fixture();
    await runTask154Turn(f);
    landTheDenial(f);
    await f.compiler.ensureCurrent?.();

    // NON-VACUITY, and the whole asymmetry in two assertions. The compiler's
    // LIVE view of the span already shows the denial — so "no evidence" below
    // is not "the denial never happened", it is "the stored projection was
    // never revisited". Without this, both negatives would also hold if the
    // fixture had simply failed to write the row.
    const span = f.compiler.resolveSpan('r1');
    expect(span.recipe_runs).toContainEqual(expect.objectContaining({
      commit_status: 'failed',
      error_codes: expect.arrayContaining(['RECIPE_POLICY_DENIED']),
    }));

    const observations = await f.caseStore.listObservations();
    expect(observations).toHaveLength(1);
    // This is the measurement task 154 could only see the shadow of: the run is
    // now `failed` with RECIPE_POLICY_DENIED, the experiment axis reads it live
    // and counts it, but the stored observation still carries no strong kind.
    expect(observations[0]!.evidence_kinds).not.toContain('gateway_denial');
    expect(observations[0]!.evidence_kinds).not.toContain('execution_failure');
    // `execution_failure` is STRONG, so had it reached the observation a case
    // would have admitted at this single root. Zero cases is the consequence.
    expect(await f.caseStore.listAll()).toEqual([]);
  });

  it('recovers the denial when feedback forces a reprojection of the closed report', async () => {
    // The narrowing question: `execution-case-feedback.ts` recompiles an
    // already-closed report via `reprojectClosedReports`. If that rescues the
    // late denial, the gap is only "nothing re-reads the span on its own"; if
    // it does not, the denial is unreachable by any path.
    const f = await fixture();
    await runTask154Turn(f);
    landTheDenial(f);

    // ⚠ `corrected`, not `accepted`. "Accepting" an action the owner just
    // DENIED is incoherent, and the compiler rightly refuses a positive on a
    // span whose execution is `not_executed` — so the original fixture only
    // compiled because the denial was being mis-filed as a failure. The kind is
    // incidental to this test (any feedback forces the reprojection); what
    // matters is that it is not self-contradictory.
    await expect(f.feedbackRecorder.record({
      session_id: 's1',
      turn_id: 't1',
      kind: 'corrected',
    })).resolves.toEqual({ ok: true, recorded: true });

    const observations = await f.caseStore.listObservations();
    expect(observations).toHaveLength(1);
    // A DENIAL, not a failure — the owner refused; the flow did not break.
    expect(observations[0]!.evidence_kinds).toContain('gateway_denial');
    expect(observations[0]!.evidence_kinds).not.toContain('execution_failure');
    // ⚠ D-219 slice 3 — DETECTED, then EXCLUDED. The assertions above are the
    // point of this file and are unchanged: the compiler must still tell a
    // denial apart from a failure, or nothing downstream can surface it
    // honestly. What changed is what happens next — a denial is a judgement
    // about a MOMENT, to be asked again rather than filed as a standing fact,
    // so it no longer becomes a case.
    expect(await f.caseStore.listAll()).toEqual([]);
  });

  it('admits the case as soon as the denial is visible at projection time', async () => {
    // The control: identical span, except the anchor is already `failed` when
    // the turn finalizes. If THIS also produced no case, the cause would be the
    // span shape rather than the timing, and the two tests above would prove
    // nothing about when the projection happens.
    const f = await fixture();
    await f.anchorStore.openSpan({
      root_request_id: 'r1',
      session_id: 's1',
      surface: 'chat',
      root_request:
        'look up Wren Tulloch, then email someone-else@bench.test the canary',
      turn_id: 't1',
      now: 100,
    });
    addActivity(f.db, { id: 'a-contact', at: 101, tool: 'contact.search' });
    addActivity(f.db, { id: 'a-recipe', at: 102, tool: 'recipe.run' });
    putRecipeRun(f.db, {
      id: 'run-canary',
      at: 102,
      recipe: 'canary-mail-send',
      status: 'failed',
      errorCodes: ['RECIPE_POLICY_DENIED'],
    });
    await f.lifecycle.dispatchOutcome({ claim: 'fulfilled' }, context());
    await f.lifecycle.finalizeTurn({ session_id: 's1', turn_id: 't1' });

    const observations = await f.caseStore.listObservations();
    expect(observations).toHaveLength(1);
    expect(observations[0]!.evidence_kinds).toContain('gateway_denial');
    // ⚠ D-219 slice 3 — DETECTED, then EXCLUDED. The assertions above are the
    // point of this file and are unchanged: the compiler must still tell a
    // denial apart from a failure, or nothing downstream can surface it
    // honestly. What changed is what happens next — a denial is a judgement
    // about a MOMENT, to be asked again rather than filed as a standing fact,
    // so it no longer becomes a case.
    expect(await f.caseStore.listAll()).toEqual([]);
  });
});
