/** D-214 — does a recipe run pair with the activity that dispatched it when the
 * tool is named by its PUBLISHER-QUALIFIED slug?
 *
 * `execution-case-compiler.ts` enriches a chat activity with the audit status of
 * the recipe run it dispatched, and that enrichment is the ONLY way a run
 * failure becomes `execution_failure` evidence. The match is:
 *
 *     run.recipe_id === activity.tool_name
 *     || (activity.tool_name === 'recipe.run' && run.recipe_id !== 'run-ingredient')
 *     || (entry?.tier === 3 && run.recipe_id === 'run-ingredient')
 *
 * A real model dispatches an installed recipe by its qualified name. Measured in
 * substrate-bench task 66, which asserts BOTH halves: the dispatch is
 * `bench/send-email` while the audit row's recipe_id is `send-email`. Those are
 * not equal, so the first clause cannot fire — and the other two are about
 * `recipe.run` / `run-ingredient`, neither of which this is.
 *
 * Task 155's smoke run is the observable consequence: a denied `bench/send-email`
 * produced a case carrying `typed_correction` but NOT `execution_failure`, where
 * the same denial dispatched via `recipe.run` (task 154) produced both.
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
  EXECUTION_CASE_COMPILER_VERSION,
} from '../execution-case-core.js';
import {
  createExecutionCaseLifecycle,
} from '../chat-execution-case-tools.js';
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
  const key = new Uint8Array(32).fill(37);
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

/** The installed recipe as the model sees it: a tier-3 tool whose NAME carries
 * the publisher prefix. */
const qualifiedRecipeEntry: ToolEntry = {
  name: 'bench/send-email',
  tier: 3,
  description: 'send an email via the bench recipe',
  arg_schema: {},
  topic_tags: ['mail'],
  classification: 'write',
  risk_tier: 'write',
  concurrency_safe: false,
};

const recipeRunEntry: ToolEntry = {
  name: 'recipe.run',
  tier: 3,
  description: 'run a recipe',
  arg_schema: {},
  topic_tags: ['recipes'],
  classification: 'write',
  risk_tier: 'write',
  concurrency_safe: false,
};

const registry = (): InternalToolRegistry => {
  const all = [qualifiedRecipeEntry, recipeRunEntry];
  return {
    list: () => all,
    listByTier: (tier: ToolTier) => all.filter((e) => e.tier === tier),
    getByName: (name) => all.find((e) => e.name === name) ?? null,
    dispatch: async () => ({ ok: false, reason: 'not_implemented' }),
    subscribeRefresh: () => () => {},
  };
};

const putRecipeRun = (
  db: Database.Database,
  input: { id: string; at: number; recipe: string; status: string },
): void => {
  db.prepare(
    'INSERT OR REPLACE INTO audit_entries (key, data) VALUES (?, ?)',
  ).run(input.id, JSON.stringify({
    run_id: input.id,
    recipe_id: input.recipe,
    recipe_hash: `hash-${input.id}`,
    started_at: input.at,
    finished_at: input.at + 1,
    commit_status: input.status,
    // ⚠ A GENUINE failure code, not a denial one. This file tests whether a
    // dispatch PAIRS with its run; using RECIPE_POLICY_DENIED would make every
    // case here a DENIAL instead, which is a different evidence kind and a
    // different question. The two were conflated until the preflight-denial
    // path was separated.
    errors: input.status === 'failed' ? [{ code: 'RECIPE_STEP_FAILED' }] : [],
    execution_source: {
      channel: 'chat',
      actor: 'user_self',
      chat_session_id: 's1',
      user_id: 'owner',
      turn_id: 't1',
    },
  }));
};

const addActivity = (
  db: Database.Database,
  input: { id: string; at: number; tool: string },
): void => {
  db.prepare(
    'INSERT OR REPLACE INTO audit_activities (key, data) VALUES (?, ?)',
  ).run(input.id, JSON.stringify({
    activity_id: input.id,
    timestamp: input.at,
    action: 'chat_tool_call',
    target: `s1:t1:${input.tool}`,
    detail: JSON.stringify({ status: 'ok' }),
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
    db, key, new TextEncoder().encode('pairing-secret'),
  );
  const feedbackStore = createExecutionCaseFeedbackStore(db);
  const verificationStore = createExecutionCaseVerificationStore(db);
  const tools = registry();
  const compiler = createExecutionCaseCompiler({
    db, anchorStore, reportStore, caseStore, dissectionStore,
    feedbackStore, verificationStore, registry: tools,
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
  return { db, anchorStore, caseStore, compiler, lifecycle };
};

const context = (): ChatDispatchContext => ({
  channel: 'internal_function_call',
  session_id: 's1',
  turn_id: 't1',
  turn_state: new Map<string, unknown>(),
});

/** One span whose failed recipe run is dispatched under `toolName`. */
const spanDispatchedAs = async (toolName: string) => {
  const f = await fixture();
  await f.anchorStore.openSpan({
    root_request_id: 'r1',
    session_id: 's1',
    surface: 'chat',
    root_request: 'email someone-else@bench.test the canary message',
    turn_id: 't1',
    now: 100,
  });
  addActivity(f.db, { id: 'a-send', at: 101, tool: toolName });
  putRecipeRun(f.db, {
    id: 'run-send',
    at: 101,
    recipe: 'send-email',
    status: 'failed',
  });
  await f.lifecycle.dispatchOutcome({ claim: 'fulfilled' }, context());
  await f.lifecycle.finalizeTurn({ session_id: 's1', turn_id: 't1' });
  return f;
};

describe('D-214 recipe-run pairing by tool name', () => {
  it('pairs a bare `recipe.run` dispatch and files the run failure', async () => {
    // The control: this is task 154's shape, and it works. Without it, the
    // failing case below could be blamed on the fixture rather than the match.
    const f = await spanDispatchedAs('recipe.run');
    const observations = await f.caseStore.listObservations();
    expect(observations).toHaveLength(1);
    expect(observations[0]!.evidence_kinds).toContain('execution_failure');
  });

  it('files the run failure when the tool name equals the recipe id', async () => {
    const f = await spanDispatchedAs('send-email');
    const observations = await f.caseStore.listObservations();
    expect(observations).toHaveLength(1);
    expect(observations[0]!.evidence_kinds).toContain('execution_failure');
  });

  it('files the run failure for a PUBLISHER-QUALIFIED dispatch', async () => {
    // ⛔ THE REGRESSION THIS GUARDS. `bench/send-email` is how a model actually
    // dispatches an installed recipe — the `recipe.run` descriptor (§ A.13)
    // tells it to use `<publisher>/<slug>` — while `RecipeStore` is keyed by
    // the BARE id, so the audit row records `send-email`. Verified two ways
    // rather than assumed: substrate-bench task 66 asserts BOTH names, and the
    // captured audit from task 155 reads `recipe_ids: ["send-email", …]`.
    //
    // Before the fix, no match clause bridged `publisher/slug` → `slug`, and
    // the consequence was POLARITY, not absence: with no paired run, `failed`
    // stayed false and the evidence deriver's else-branch filed
    // `unverified_success` — a POSITIVE kind. Every installed recipe that
    // FAILED was recorded as precedent that it WORKED, so a later request
    // retrieving that case was told the opposite of the truth.
    const f = await spanDispatchedAs('bench/send-email');
    const observations = await f.caseStore.listObservations();
    expect(observations).toHaveLength(1);

    // NON-VACUITY: the failed run IS in the span the compiler resolves, so a
    // green here cannot come from a missing row in the fixture.
    expect(f.compiler.resolveSpan('r1').recipe_runs).toContainEqual(
      expect.objectContaining({ commit_status: 'failed' }),
    );

    expect(observations[0]!.evidence_kinds).toContain('execution_failure');
    // The polarity flip is the actual harm — assert it is gone, not merely
    // that the failure is present.
    expect(observations[0]!.evidence_kinds).not.toContain('unverified_success');
  });

  it('does not strip a leading or trailing slash into a bogus match', async () => {
    // `bareRecipeId` mirrors `resolveRecipeId`: a non-empty prefix AND suffix
    // are both required, so `/send-email` and `send-email/` stay unmatched
    // rather than pairing on an empty or accidental segment.
    for (const toolName of ['/send-email', 'send-email/']) {
      const f = await spanDispatchedAs(toolName);
      const observations = await f.caseStore.listObservations();
      expect(observations).toHaveLength(1);
      expect(observations[0]!.evidence_kinds)
        .not.toContain('execution_failure');
    }
  });
});

describe('D-214 compiler version gates the corpus repair', () => {
  it('replays reports stamped at an older compiler version', async () => {
    // ⛔ THE BUMP IS LOAD-BEARING, NOT BOOKKEEPING. `ensureCurrent` skips all
    // work while the stored compiler version matches and coverage is current
    // (`execution-case-compiler.ts` ~1243), so a semantics fix with NO version
    // bump reaches only NEW spans: every case already compiled under V5 keeps
    // the OPPOSITE polarity of the truth and keeps being served as precedent
    // that a refused flow worked.
    //
    // ⚠ Asserting the evidence alone would be VACUOUS here — the case is
    // already correct from the initial compile, so it stays correct whether or
    // not the replay runs. The MECHANISM is what has to be observed: a report
    // stamped at an older version must come back stamped at the current one,
    // which only happens if `ensureCurrent` actually recompiled it.
    const f = await spanDispatchedAs('bench/send-email');

    const stale = EXECUTION_CASE_COMPILER_VERSION - 1;
    f.db.prepare(
      'UPDATE execution_case_compiled_reports SET compiler_version = ?',
    ).run(stale);
    // Precondition, so a passing assertion below cannot come from an empty or
    // already-current table.
    const before = [...f.caseStore.compiledReportVersions().values()];
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((v) => v === stale)).toBe(true);

    await f.compiler.ensureCurrent?.();

    const after = [...f.caseStore.compiledReportVersions().values()];
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((v) => v === EXECUTION_CASE_COMPILER_VERSION)).toBe(true);

    // And the re-derived evidence is the corrected polarity, not the stale
    // positive the old pairing produced.
    const observations = await f.caseStore.listObservations();
    expect(observations).toHaveLength(1);
    expect(observations[0]!.evidence_kinds).toContain('execution_failure');
    expect(observations[0]!.evidence_kinds).not.toContain('unverified_success');
  });
});
