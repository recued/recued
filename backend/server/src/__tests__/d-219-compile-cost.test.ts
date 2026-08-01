/** D-219 — what ONE compile is allowed to read.
 *
 *  Slice 9a made recording unconditional: every turn that does governed work
 *  produces an observation, and every `compileReport` ends in a full
 *  `rebuildMaterialized()`. That made per-turn cost proportional to the WHOLE
 *  corpus — measured 0.3 → 16.5 ms over 200 sequential turns, i.e. quadratic
 *  over a session's life (~150 ms/turn at 2k observations). Retention bounds
 *  the set it walks; it does not change the shape.
 *
 *  ⛔ THESE ARE STRUCTURAL RATCHETS, NOT TIMINGS. A wall-clock assertion in this
 *  suite would flake under parallel load — two suites already have — and would
 *  measure the machine rather than the algorithm. What is asserted instead is
 *  the WORK DONE: which tables a single compile is permitted to open. That is
 *  deterministic, and it is the quantity that was quadratic.
 */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InternalToolRegistry, ToolEntry, ToolTier } from '@recued/contracts';

import { createExecutionCaseCompiler } from '../execution-case-compiler.js';
import { createExecutionCaseFeedbackRecorder } from '../execution-case-feedback.js';
import { createExecutionCaseLifecycle } from '../chat-execution-case-tools.js';
import { createCaseInterventionStore } from '../storage/case-intervention-store.js';
import { createExecutionCaseFeedbackStore } from '../storage/execution-case-feedback-store.js';
import { createExecutionCaseStore } from '../storage/execution-case-store.js';
import { createExecutionReportStore } from '../storage/execution-report-store.js';
import { createExecutionSpanAnchorStore } from '../storage/execution-span-anchor-store.js';
import { createExecutionSpanDissectionStore } from '../storage/execution-span-dissection-store.js';
import { createExecutionCaseVerificationStore } from '../storage/execution-case-verification-store.js';
import type { D214KeyProvider } from '../storage/d214-sealed-json.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const keyProvider = (): D214KeyProvider => {
  const key = new Uint8Array(32);
  for (let i = 0; i < key.length; i += 1) key[i] = (i * 5 + 11) & 0xff;
  return () => key;
};

const entries: ToolEntry[] = [
  {
    name: 'file.search', tier: 1, description: 'search files', arg_schema: {},
    topic_tags: ['files'], classification: 'read', risk_tier: 'read',
    concurrency_safe: true,
  },
  {
    name: 'mail.send', tier: 2, description: 'send mail', arg_schema: {},
    topic_tags: ['mail'], classification: 'write', risk_tier: 'write',
    concurrency_safe: false,
  },
];

const registry = (): InternalToolRegistry => ({
  list: () => [...entries],
  listByTier: (tier: ToolTier) => entries.filter((entry) => entry.tier === tier),
  getByName: (name: string) => entries.find((entry) => entry.name === name) ?? null,
  dispatch: async () => ({ ok: false, reason: 'not_implemented' }),
  subscribeRefresh: () => () => {},
});

const fixture = () => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  db.exec(`
    CREATE TABLE audit_activities (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE audit_entries (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE chat_plans (
      plan_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      retry_of_plan_id TEXT, tool TEXT NOT NULL, classification TEXT NOT NULL,
      status TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER,
      consumed_at INTEGER, execution_status TEXT, execution_turn_id TEXT,
      execution_updated_at INTEGER
    );
    CREATE TABLE correction_events (
      event_id TEXT PRIMARY KEY, source_plan_id TEXT, kind TEXT NOT NULL,
      payload_blob TEXT NOT NULL
    );
  `);
  const key = keyProvider();
  const anchorStore = createExecutionSpanAnchorStore(db, key);
  const reportStore = createExecutionReportStore(db, key);
  const caseStore = createExecutionCaseStore(db, key);
  const dissectionStore = createExecutionSpanDissectionStore(db, key);
  const tools = registry();
  const feedbackStore = createExecutionCaseFeedbackStore(db);
  const interventionStore = createCaseInterventionStore(
    db, key, new TextEncoder().encode('compile-cost'),
  );
  const compiler = createExecutionCaseCompiler({
    db, anchorStore, reportStore, caseStore, dissectionStore,
    feedbackStore,
    verificationStore: createExecutionCaseVerificationStore(db),
    registry: tools,
  });
  const feedback = createExecutionCaseFeedbackRecorder({
    anchorStore, feedbackStore, reportStore, caseStore, interventionStore,
    compiler, now: () => 9_000,
  });
  let clock = 1_000;
  const lifecycle = createExecutionCaseLifecycle({
    anchorStore, reportStore, dissectionStore, compiler, registry: tools,
    interventionStore,
    now: () => (clock += 1),
  } as Parameters<typeof createExecutionCaseLifecycle>[0]);
  return {
    db, anchorStore, reportStore, caseStore, compiler, lifecycle, feedback,
    dissectionStore,
  };
};

/** One ordinary turn: a request, two distinct governed calls, finalization. */
const runTurn = async (
  f: ReturnType<typeof fixture>,
  index: number,
): Promise<void> => {
  const turn = `t${index}`;
  await f.anchorStore.openSpan({
    root_request_id: `r${index}`,
    session_id: 's1',
    surface: 'chat',
    // Distinct shapes, so the corpus grows the way real traffic does rather
    // than collapsing into one case key.
    root_request: `send report number ${index} to the customer`,
    turn_id: turn,
    now: 100 + index,
  });
  for (const [ordinal, tool] of ['file.search', 'mail.send'].entries()) {
    f.db.prepare('INSERT INTO audit_activities (key, data) VALUES (?, ?)').run(
      `${index}-${ordinal}`,
      JSON.stringify({
        activity_id: `${index}-${ordinal}`,
        timestamp: 101 + index * 2 + ordinal,
        action: 'chat_tool_call',
        target: `s1:${turn}:${tool}`,
        detail: JSON.stringify({ status: 'ok' }),
      }),
    );
  }
  await f.lifecycle.finalizeTurn({ session_id: 's1', turn_id: turn });
};

describe('D-219 — one compile must not re-read the whole report table', () => {
  it('⛔ opens NO sealed report payload, and still checks the ids', async () => {
    // ⛔⛔ MEASURED, NOT SUSPECTED. `rebuildMaterialized` wanted exactly one
    // thing from the report table — the set of ids that still exist — and got
    // it from `listAll()`, which opens FOUR AEAD-sealed fields per row and
    // hands back plaintext discarded on the next line. Over 200 sequential
    // turns that was the single largest per-turn cost (~6.3 ms/compile at 100
    // reports, growing with the corpus); replacing it took turn 200 from
    // 16.6 ms to 5.6 ms.
    const f = fixture();
    for (let index = 0; index < 6; index += 1) await runTurn(f, index);

    const listAll = vi.spyOn(f.reportStore, 'listAll');
    await runTurn(f, 6);
    expect(listAll).not.toHaveBeenCalled();

    // ⛔ THE PERMITTING WITNESS, taken on the FULL rebuild. An ordinary turn now
    // takes the scoped path, which legitimately needs no existence check at all
    // — so asserting the id query fires there would pin the wrong thing. The
    // full rebuild is where the check lives, and without this assertion the
    // test above passes against a build that deleted the guard keeping a prior
    // projection only while every one of its sources survives.
    // ⚠ `recompileAll` DOES open report payloads, correctly — it replays every
    // closed report from its authoritative source. The claim being ratcheted is
    // about the ORDINARY TURN above, not about replay.
    const allIds = vi.spyOn(f.reportStore, 'allReportIds');
    await f.compiler.recompileAll();
    expect(allIds).toHaveBeenCalled();
    expect(allIds.mock.results[0]!.value).toHaveLength(7);
  });

  it('the id query returns EVERY report, not just the closed ones', async () => {
    // ⚠ `closedReportIds()` was the tempting reuse: every source report is
    // closed, so the two agree today. That is a property of ANOTHER function,
    // and an existence check silently meaning "exists AND closed" is the shape
    // that stops being true without anything failing. Pinned with an OPEN
    // report, which only the all-ids query sees.
    const f = fixture();
    await runTurn(f, 0);
    // A span that reported but was never finalized — its report exists and is
    // OPEN, which is the state the two queries disagree about.
    await f.anchorStore.openSpan({
      root_request_id: 'r-open',
      session_id: 's1',
      surface: 'chat',
      root_request: 'a turn still in flight',
      turn_id: 't-open',
      now: 500,
    });
    await f.lifecycle.dispatchOutcome(
      { claim: 'fulfilled' },
      {
        session_id: 's1',
        turn_id: 't-open',
        source: {
          channel: 'chat', actor: 'user_self',
          chat_session_id: 's1', turn_id: 't-open',
        },
      } as never,
    );
    const all = f.reportStore.allReportIds();
    const closed = f.reportStore.closedReportIds();
    // Non-vacuity: there really is a report the closed query cannot see.
    expect(all.length).toBeGreaterThan(closed.length);
    for (const id of closed) expect(all).toContain(id);
  });
});

describe('D-219 — the scoped rebuild must equal the full one', () => {
  /** Materialize real cases: after D-219 an owner verdict is the only thing
   *  that admits, so a corpus with none would make every assertion below
   *  vacuously true about an empty set. */
  const withCases = async (f: ReturnType<typeof fixture>, turns: number) => {
    for (let index = 0; index < turns; index += 1) {
      await runTurn(f, index);
      // Every third turn is one the owner answered.
      if (index % 3 === 0) {
        await f.feedback.record({
          session_id: 's1', turn_id: `t${index}`, kind: 'accepted',
        });
      }
    }
  };

  it('⛔ produces byte-identical cases to a full recompile', async () => {
    // ⛔⛔ THE PROPERTY THE WHOLE OPTIMISATION RESTS ON. Scoping the rebuild to
    // the touched case keys is only safe if it lands where the global rebuild
    // would; a divergence here is silent and corrupts precedent, which is the
    // one asset the arc produces. So: build a corpus the fast way, then force
    // the slow way over the same sources and compare.
    const f = fixture();
    await withCases(f, 12);

    const scoped = await f.caseStore.listAll();
    // Non-vacuity: cases really materialized. Without this the comparison
    // below is [] vs [] and passes against any implementation at all.
    expect(scoped.length).toBeGreaterThan(0);

    await f.compiler.recompileAll();
    const full = await f.caseStore.listAll();

    const canonical = (rows: typeof full) => JSON.stringify(
      [...rows].sort((a, b) => a.case_key.localeCompare(b.case_key)),
    );
    expect(canonical(scoped)).toBe(canonical(full));
  });

  it('keeps the source joins and representative prompts a full rebuild would', async () => {
    // ⛔ The prompt is the reason `preserveMissingPrompts` exists: a scoped
    // rebuild holds no observation for the cases it left alone, so the default
    // (absent ⇒ NULL) would erase their representative prompt and quietly
    // degrade stage-1 retrieval to a surface-term join. Asserted through the
    // reader that actually consumes it.
    const f = fixture();
    await withCases(f, 12);
    const before = await f.caseStore.listScope(
      { governing_contract_id: 'user_self', principal_key: 'user_self' },
      { include_superseded: true, limit: 512, with_prompt: true },
    );
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((item) => item.representative_prompt !== undefined))
      .toBe(true);
    const joins = before.map((item) =>
      [item.row.case_key, f.caseStore.sourceReportIds(item.row.case_id).length]);

    await f.compiler.recompileAll();
    const after = await f.caseStore.listScope(
      { governing_contract_id: 'user_self', principal_key: 'user_self' },
      { include_superseded: true, limit: 512, with_prompt: true },
    );
    expect(after.map((item) => item.representative_prompt).sort())
      .toEqual(before.map((item) => item.representative_prompt).sort());
    expect(after.map((item) =>
      [item.row.case_key, f.caseStore.sourceReportIds(item.row.case_id).length])
      .sort()).toEqual([...joins].sort());
  });

  it('⛔ falls back to the FULL rebuild when any observation predates the key', async () => {
    // The migration path. A row written before `case_key` existed carries none,
    // and a scoped read would silently omit it from its group — changing what
    // admits, with nothing failing. Failing to the full rebuild is always
    // correct and merely slow.
    const f = fixture();
    await withCases(f, 6);
    f.db.prepare(
      'UPDATE execution_case_observations SET case_key = NULL WHERE rowid = 1',
    ).run();
    expect(f.caseStore.keylessObservationCount()).toBe(1);

    const scopedRead = vi.spyOn(f.caseStore, 'listObservationsForCaseKeys');
    const fullRead = vi.spyOn(f.caseStore, 'listObservations');
    await runTurn(f, 6);
    expect(fullRead).toHaveBeenCalled();
    expect(scopedRead).not.toHaveBeenCalled();
  });

  it('takes the SCOPED path on an ordinary turn — the permitting witness', async () => {
    // Without this, the fallback test above passes against a build that always
    // takes the slow path, i.e. against the optimisation never happening.
    const f = fixture();
    await withCases(f, 6);
    expect(f.caseStore.keylessObservationCount()).toBe(0);

    const scopedRead = vi.spyOn(f.caseStore, 'listObservationsForCaseKeys');
    const fullRead = vi.spyOn(f.caseStore, 'listObservations');
    await runTurn(f, 6);
    expect(scopedRead).toHaveBeenCalled();
    expect(fullRead).not.toHaveBeenCalled();
    // …and it read ONLY the touched key's observations, not the corpus.
    const rows = await scopedRead.mock.results[0]!.value;
    expect(rows.length).toBeLessThan(
      (await f.caseStore.listObservations()).length,
    );
  });

  it('marks a flow stale even on a case this compile did not touch', async () => {
    // ⛔ Staleness is a GLOBAL fact: a tool that disappeared makes OLD cases
    // stale too, and a card proposing a tool that no longer exists is exactly
    // what the flag prevents. The scoped rebuild re-evaluates it over the whole
    // merged set for that reason — cheap, because cases are capped per scope.
    const f = fixture();
    await withCases(f, 6);
    expect((await f.caseStore.listAll()).some((row) =>
      row.flows.some((flow) => flow.stale))).toBe(false);

    entries.splice(entries.findIndex((entry) => entry.name === 'mail.send'), 1);
    try {
      await runTurn(f, 6);
      const rows = await f.caseStore.listAll();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) =>
        row.flows.every((flow) => flow.stale))).toBe(true);
    } finally {
      entries.push({
        name: 'mail.send', tier: 2, description: 'send mail', arg_schema: {},
        topic_tags: ['mail'], classification: 'write', risk_tier: 'write',
        concurrency_safe: false,
      });
    }
  });
});

describe('D-219 — the scoped rebuild must see BOTH sides of a recompile', () => {
  it('⛔ rebuilds the key an observation LEAVES, not just the one it arrives at', async () => {
    // ⛔⛔ A MUTATION FOUND THIS TEST MISSING. Dropping the before-side of the
    // affected keys survived every other assertion in this file, because on an
    // ordinary turn the two sides agree: a fresh report has no prior
    // observations, and a recompile that keeps the same request shape files
    // under the same key.
    //
    // They diverge when a report is RE-compiled and its observation MOVES. A
    // dissection recorded after the first compile changes `request_shape`
    // (grounded intent replaces the inferred one), so the same observation now
    // files under a different case key — and the case at the OLD key is backed
    // by nothing. Without the before-side that stale case is never rebuilt and
    // survives as precedent nothing supports.
    const f = fixture();
    await runTurn(f, 0);
    await f.feedback.record({
      session_id: 's1', turn_id: 't0', kind: 'accepted',
    });
    const before = await f.caseStore.listAll();
    expect(before).toHaveLength(1);

    // A grounded dissection: an ordered subsequence of the prompt's terms, so
    // `isExecutionCaseIntentGrounded` accepts it and the shape changes.
    await f.dissectionStore.putFirst('r0', {
      schema_version: 1,
      intent: 'send report',
      objects: ['report'],
      entities: [{ role: 'customer', kind: 'person' }],
      constraints: [],
      outcome_sought: 'sent',
    }, 500);

    // Any recompile of that report. The owner correcting their own verdict is
    // the ordinary one.
    await f.feedback.retract({
      session_id: 's1', turn_id: 't0', kind: 'accepted',
    });
    await f.feedback.record({
      session_id: 's1', turn_id: 't0', kind: 'accepted',
    });

    const after = await f.caseStore.listAll();
    // Non-vacuity: the key really moved. Without this the assertion below
    // passes on a build where the dissection changed nothing.
    expect(after.map((row) => row.case_key))
      .not.toEqual(before.map((row) => row.case_key));
    // ⛔ And exactly ONE case stands — the old key did not survive alongside it.
    expect(after).toHaveLength(1);
    // …which is also what the full rebuild lands on, stated rather than
    // assumed: this test found the scoped path keeping a stale case that the
    // full one dropped.
    await f.compiler.recompileAll();
    expect((await f.caseStore.listAll()).map((row) => row.case_key))
      .toEqual(after.map((row) => row.case_key));
  });
});

describe('D-219 — one compile must not read the whole audit history', () => {
  it('⛔ selects only its OWN span\'s activities, in SQL', async () => {
    // ⛔⛔ MEASURED. `listToolActivities` read EVERY `chat_tool_call` row the
    // server had ever written and `JSON.parse`d each one, then kept the two
    // belonging to this span. Over 60 turns against a seeded backlog of
    // unrelated calls, one `finalizeTurn` cost 0.94 ms at 0 rows, 5.5 ms at 2k,
    // 24 ms at 10k and 105 ms at 40k — linear in the whole audit history.
    //
    // ⚠ And `audit_activities` is NOT bounded by age on a default install:
    // `MEMORY_RETENTION_DEFAULT_DAYS` is null, so only size-based reclaim runs
    // and the table gains a row per tool call indefinitely.
    const f = fixture();
    // A backlog from other sessions — rows this compile has no interest in.
    const insert = f.db.prepare(
      'INSERT INTO audit_activities (key, data) VALUES (?, ?)',
    );
    for (let index = 0; index < 400; index += 1) {
      insert.run(`old-${index}`, JSON.stringify({
        activity_id: `old-${index}`,
        timestamp: index,
        action: 'chat_tool_call',
        target: `s-other:t-other-${index}:file.search`,
        detail: JSON.stringify({ status: 'ok' }),
      }));
    }

    // Count what the audit query actually hands back to JS.
    let auditRowsRead = 0;
    const realPrepare = f.db.prepare.bind(f.db);
    (f.db as { prepare: typeof realPrepare }).prepare = ((sql: string) => {
      const statement = realPrepare(sql);
      if (!/FROM audit_activities/i.test(sql)) return statement;
      const realAll = statement.all.bind(statement);
      (statement as { all: typeof realAll }).all = ((...args: unknown[]) => {
        const rows = realAll(...args) as unknown[];
        auditRowsRead += rows.length;
        return rows;
      }) as typeof realAll;
      return statement;
    }) as typeof realPrepare;

    await runTurn(f, 0);

    // ⛔ Two activities belong to this span. A handful more is fine — the SQL
    // predicate only has to avoid UNDER-selecting, and `anchors.has(...)` is
    // still the authority — but reading the BACKLOG is the defect.
    expect(auditRowsRead).toBeLessThan(50);
    // ⛔ THE PERMITTING WITNESS. Without it this passes against a query that
    // selects nothing at all, which would also read zero backlog rows — and
    // would silently stop recording every case.
    const [observation] = await f.caseStore.listObservations();
    expect(observation?.substantive_call_count).toBe(2);
  });
});
