/** D-219 — the CAPTURE-ONLY tool-argument buffer.
 *
 *  ⛔ The property under test is not "arguments are stored" but "arguments are
 *  stored AND nothing exposes them". Capture and exposure are separate
 *  decisions; only the first is made, and these tests are what keep it that way.
 */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { InternalToolRegistry, ToolEntry, ToolTier } from '@recued/contracts';

import {
  createExecutionCaseArgumentStore,
  EXECUTION_CASE_ARGUMENT_MAX_BYTES,
} from '../storage/execution-case-argument-store.js';
import {
  createExecutionCaseLifecycle,
  wrapRegistryWithExecutionCaseTools,
  OUTCOME_REPORT_TOOL_NAME,
  REQUEST_DISSECTION_TOOL_NAME,
} from '../chat-execution-case-tools.js';
import { createExecutionCaseCompiler } from '../execution-case-compiler.js';
import { renderExecutionCaseCard } from '../execution-case-core.js';
import { createExecutionCaseFeedbackRecorder } from '../execution-case-feedback.js';
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
  for (let i = 0; i < key.length; i += 1) key[i] = (i * 11 + 5) & 0xff;
  return () => key;
};

/** A vault the caller can lock, to prove the skip rather than assume it. */
const lockableKeyProvider = () => {
  let locked = false;
  const key = new Uint8Array(32);
  for (let i = 0; i < key.length; i += 1) key[i] = (i * 11 + 5) & 0xff;
  const provider: D214KeyProvider = () => (locked ? null : key);
  return { provider, lock: () => { locked = true; } };
};

const entries: ToolEntry[] = [
  {
    name: 'contact.search', tier: 1, description: 'search contacts', arg_schema: {},
    topic_tags: ['contacts'], classification: 'read', risk_tier: 'read',
    concurrency_safe: true,
  },
  {
    name: 'mail.send', tier: 2, description: 'send mail', arg_schema: {},
    topic_tags: ['mail'], classification: 'write', risk_tier: 'write',
    concurrency_safe: false,
  },
];

const registry = (dispatched: string[] = []): InternalToolRegistry => ({
  list: () => [...entries],
  listByTier: (tier: ToolTier) => entries.filter((entry) => entry.tier === tier),
  getByName: (name: string) => entries.find((entry) => entry.name === name) ?? null,
  dispatch: async (name: string) => {
    dispatched.push(name);
    return { ok: true, result: {} };
  },
  subscribeRefresh: () => () => {},
});

const schema = (db: Database.Database): void => {
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
};

const addActivity = (
  db: Database.Database,
  input: { id: string; at: number; session: string; turn: string; tool: string },
): void => {
  db.prepare('INSERT INTO audit_activities (key, data) VALUES (?, ?)').run(
    input.id,
    JSON.stringify({
      activity_id: input.id,
      timestamp: input.at,
      action: 'chat_tool_call',
      target: `${input.session}:${input.turn}:${input.tool}`,
      detail: JSON.stringify({ status: 'ok' }),
    }),
  );
};

const openDb = () => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  schema(db);
  return db;
};

describe('D-219 argument capture — the store', () => {
  it('seals the values at rest', async () => {
    const db = openDb();
    const store = createExecutionCaseArgumentStore(db, keyProvider());
    expect(await store.capture({
      capture_id: 'c1',
      session_id: 's1',
      turn_id: 't1',
      tool_name: 'mail.send',
      captured_at: 1_000,
      args: { to: 'dominic@example.com', subject: 'the salary review' },
    })).toBe(true);

    // ⛔ Asserted on the RAW COLUMN. A round-trip through the store's own reader
    // would pass just as well against a plaintext write.
    const raw = db.prepare(
      'SELECT args_encrypted FROM execution_case_arguments WHERE capture_id = ?',
    ).get('c1') as { args_encrypted: string };
    expect(raw.args_encrypted).not.toContain('dominic@example.com');
    expect(raw.args_encrypted).not.toContain('salary');
    expect(raw.args_encrypted).not.toContain('subject');

    const [row] = await store.listForTurn('s1', 't1');
    expect(row!.args).toEqual({
      to: 'dominic@example.com',
      subject: 'the salary review',
    });
  });

  it('SKIPS the capture when the vault is locked, rather than storing raw', async () => {
    // ⛔ The one behaviour that must never degrade toward "write it anyway".
    const db = openDb();
    const vault = lockableKeyProvider();
    const store = createExecutionCaseArgumentStore(db, vault.provider);
    expect(await store.capture({
      capture_id: 'open-1', session_id: 's1', turn_id: 't1',
      tool_name: 'mail.send', captured_at: 1_000, args: { to: 'a@b.c' },
    })).toBe(true);

    vault.lock();
    expect(await store.capture({
      capture_id: 'locked-1', session_id: 's1', turn_id: 't1',
      tool_name: 'mail.send', captured_at: 1_001, args: { to: 'secret@b.c' },
    })).toBe(false);
    expect(store.count()).toBe(1);
    const rows = db.prepare(
      'SELECT args_encrypted FROM execution_case_arguments',
    ).all() as Array<{ args_encrypted: string }>;
    expect(rows.map((r) => r.args_encrypted).join('')).not.toContain('secret@b.c');
  });

  it('truncates an oversized payload to a marker instead of storing it', async () => {
    const db = openDb();
    const store = createExecutionCaseArgumentStore(db, keyProvider());
    const huge = 'x'.repeat(EXECUTION_CASE_ARGUMENT_MAX_BYTES + 1);
    await store.capture({
      capture_id: 'big', session_id: 's1', turn_id: 't1',
      tool_name: 'mail.send', captured_at: 1_000, args: { body: huge },
    });
    const [row] = await store.listForTurn('s1', 't1');
    expect(row!.args).toEqual({ truncated: true });
  });

  it('prunes by age — this is a buffer, not an archive', async () => {
    const db = openDb();
    const store = createExecutionCaseArgumentStore(db, keyProvider());
    for (const [id, at] of [['old', 1_000], ['new', 9_000]] as const) {
      await store.capture({
        capture_id: id, session_id: 's1', turn_id: 't1',
        tool_name: 'contact.search', captured_at: at, args: { q: id },
      });
    }
    expect(store.pruneOlderThan(5_000)).toBe(1);
    expect((await store.listForTurn('s1', 't1')).map((r) => r.capture_id))
      .toEqual(['new']);
  });

  it('deletes by turn and by session — the privacy cascade\'s two entry points', async () => {
    const db = openDb();
    const store = createExecutionCaseArgumentStore(db, keyProvider());
    await store.capture({
      capture_id: 'a', session_id: 's1', turn_id: 't1',
      tool_name: 'contact.search', captured_at: 1, args: { q: 'a' },
    });
    await store.capture({
      capture_id: 'b', session_id: 's1', turn_id: 't2',
      tool_name: 'contact.search', captured_at: 2, args: { q: 'b' },
    });
    await store.capture({
      capture_id: 'c', session_id: 's2', turn_id: 't3',
      tool_name: 'contact.search', captured_at: 3, args: { q: 'c' },
    });
    expect(store.deleteForTurns([{ session_id: 's1', turn_id: 't1' }])).toBe(1);
    expect(store.count()).toBe(2);
    // ⚠ Session-wide catches a turn that was never anchored to a root — the
    // per-root sweep alone would leave it behind.
    expect(store.deleteForSession('s1')).toBe(1);
    expect(store.count()).toBe(1);
  });

  it('does not let an in-flight capture resurrect a forgotten turn', async () => {
    const db = openDb();
    const store = createExecutionCaseArgumentStore(db, keyProvider());
    const capture = store.capture({
      capture_id: 'late-turn', session_id: 's1', turn_id: 't1',
      tool_name: 'mail.send', captured_at: 1, args: { to: 'private@example.com' },
    });

    expect(store.deleteForTurns([{ session_id: 's1', turn_id: 't1' }])).toBe(0);

    await expect(capture).resolves.toBe(false);
    await expect(store.listForTurn('s1', 't1')).resolves.toEqual([]);
    await expect(store.capture({
      capture_id: 'post-forget-turn', session_id: 's1', turn_id: 't1',
      tool_name: 'mail.send', captured_at: 2, args: { to: 'private@example.com' },
    })).resolves.toBe(false);
  });

  it('does not let an in-flight capture resurrect a forgotten session', async () => {
    const db = openDb();
    const store = createExecutionCaseArgumentStore(db, keyProvider());
    const capture = store.capture({
      capture_id: 'late-session', session_id: 's1', turn_id: 'unanchored',
      tool_name: 'contact.search', captured_at: 1, args: { query: 'private' },
    });

    expect(store.deleteForSession('s1')).toBe(0);

    await expect(capture).resolves.toBe(false);
    expect(store.count()).toBe(0);
    await expect(store.capture({
      capture_id: 'post-forget-session', session_id: 's1', turn_id: 'new-turn',
      tool_name: 'contact.search', captured_at: 2, args: { query: 'private' },
    })).resolves.toBe(false);
  });
});

describe('D-219 argument capture — the dispatch seam', () => {
  const wrapped = () => {
    const db = openDb();
    const store = createExecutionCaseArgumentStore(db, keyProvider());
    const dispatched: string[] = [];
    const captures: Array<Promise<boolean>> = [];
    let seq = 0;
    const lifecycle = {
      dispatchOutcome: async () => ({ ok: true as const, result: {} }),
      dispatchDissection: async () => ({ ok: true as const, result: {} }),
    } as never;
    const wrappedRegistry = wrapRegistryWithExecutionCaseTools(
      registry(dispatched),
      lifecycle,
      (captured) => {
        seq += 1;
        captures.push(store.capture({
          capture_id: `cap-${seq}`,
          session_id: captured.session_id,
          turn_id: captured.turn_id,
          tool_name: captured.tool_name,
          captured_at: seq,
          args: captured.args,
        }));
      },
    );
    return {
      store,
      dispatched,
      registry: wrappedRegistry,
      settled: () => Promise.all(captures),
    };
  };

  it('captures a governed call\'s arguments, in dispatch order', async () => {
    const h = wrapped();
    const context = { session_id: 's1', turn_id: 't1' } as never;
    await h.registry.dispatch('contact.search', { query: 'Wren' }, context);
    await h.registry.dispatch('mail.send', { to: 'wren@example.com' }, context);
    await h.settled();
    const rows = await h.store.listForTurn('s1', 't1');
    expect(rows.map((r) => r.tool_name)).toEqual(['contact.search', 'mail.send']);
    expect(rows.map((r) => r.args))
      .toEqual([{ query: 'Wren' }, { to: 'wren@example.com' }]);
  });

  it('captures NOTHING for the instrumentation tools or a session-less dispatch', async () => {
    // The instrumentation tools carry the model's own metadata rather than the
    // work, and a dispatch with no session/turn is a messenger / scheduled /
    // MCP-wire call — which forms no case, so a capture would be PII with no
    // possible consumer.
    const h = wrapped();
    const context = { session_id: 's1', turn_id: 't1' } as never;
    await h.registry.dispatch(OUTCOME_REPORT_TOOL_NAME, { claim: 'fulfilled' }, context);
    await h.registry.dispatch(REQUEST_DISSECTION_TOOL_NAME, { intent: 'x' }, context);
    await h.registry.dispatch('contact.search', { query: 'Wren' }, {} as never);
    await h.settled();
    expect(h.store.count()).toBe(0);
  });

  it('never lets a failing capture break a dispatch', async () => {
    const dispatched: string[] = [];
    const wrappedRegistry = wrapRegistryWithExecutionCaseTools(
      registry(dispatched),
      { dispatchOutcome: async () => ({ ok: true }), dispatchDissection: async () => ({ ok: true }) } as never,
      () => { throw new Error('disk full'); },
    );
    // ⛔ FOUND BY THIS TEST: the first version of the wrapper called the hook
    // unguarded, so a SYNCHRONOUS throw propagated to the caller and cost the
    // user their tool call — while the hook's own type said it "never lets it
    // fail a dispatch". A contract asserted in a doc comment and not in code is
    // not a contract; the wrapper now enforces it.
    await expect(wrappedRegistry.dispatch(
      'contact.search',
      { query: 'Wren' },
      { session_id: 's1', turn_id: 't1' } as never,
    )).resolves.toMatchObject({ ok: true });
    expect(dispatched).toEqual(['contact.search']);
  });
});

describe('D-219 argument capture — ⛔ capture is not exposure', () => {
  it('a captured argument reaches NO observation and NO card', async () => {
    // ⛔ THE RATCHET. The whole point of capturing before deciding is that the
    // deciding has not happened; if an argument ever leaks into the projection,
    // this is what says so.
    const db = openDb();
    const key = keyProvider();
    const anchorStore = createExecutionSpanAnchorStore(db, key);
    const reportStore = createExecutionReportStore(db, key);
    const caseStore = createExecutionCaseStore(db, key);
    const dissectionStore = createExecutionSpanDissectionStore(db, key);
    const interventionStore = createCaseInterventionStore(
      db, key, new TextEncoder().encode('capture-secret'),
    );
    const feedbackStore = createExecutionCaseFeedbackStore(db);
    const verificationStore = createExecutionCaseVerificationStore(db);
    const argumentStore = createExecutionCaseArgumentStore(db, key);
    const tools = registry();
    const compiler = createExecutionCaseCompiler({
      db, anchorStore, reportStore, caseStore, dissectionStore,
      feedbackStore, verificationStore, registry: tools,
    });
    let clock = 1_000;
    const lifecycle = createExecutionCaseLifecycle({
      anchorStore, reportStore, caseStore: undefined as never, dissectionStore,
      compiler, registry: tools, interventionStore, now: () => (clock += 1),
    } as Parameters<typeof createExecutionCaseLifecycle>[0]);
    const feedbackRecorder = createExecutionCaseFeedbackRecorder({
      anchorStore, feedbackStore, reportStore, caseStore, interventionStore,
      compiler, now: () => (clock += 1),
    });

    const SECRET = 'dominic@example.com';
    await anchorStore.openSpan({
      root_request_id: 'r1', session_id: 's1', surface: 'chat',
      root_request: 'send the quarterly report to the customer',
      turn_id: 't1', now: 100,
    });
    addActivity(db, { id: 'a1', at: 101, session: 's1', turn: 't1', tool: 'contact.search' });
    addActivity(db, { id: 'a2', at: 102, session: 's1', turn: 't1', tool: 'mail.send' });
    await argumentStore.capture({
      capture_id: 'cap-1', session_id: 's1', turn_id: 't1',
      tool_name: 'mail.send', captured_at: 102,
      args: { to: SECRET, subject: 'the salary review' },
    });
    await lifecycle.finalizeTurn({ session_id: 's1', turn_id: 't1' });
    // An owner verdict, so a case actually forms and there is a card to inspect.
    await feedbackRecorder.record({
      session_id: 's1', turn_id: 't1', kind: 'accepted',
    });

    const observations = await caseStore.listObservations();
    expect(observations.length).toBeGreaterThan(0);
    expect(JSON.stringify(observations)).not.toContain(SECRET);
    expect(JSON.stringify(observations)).not.toContain('salary');

    const cases = await caseStore.listAll();
    expect(cases).toHaveLength(1);
    const card = renderExecutionCaseCard(cases[0]!);
    expect(JSON.stringify(card)).not.toContain(SECRET);
    expect(JSON.stringify(card)).not.toContain('salary');
    // …and the capture is still there, which is the point: kept, not shown.
    expect((await argumentStore.listForTurn('s1', 't1'))[0]!.args)
      .toMatchObject({ to: SECRET });
  });
});

describe('D-219 — source retention: bound the corpus without eating precedent', () => {
  /** A full compile fixture: the retention rule is about what survives a
   *  REBUILD, so a stubbed store would test nothing. */
  const fixture = () => {
    const db = openDb();
    const key = keyProvider();
    const anchorStore = createExecutionSpanAnchorStore(db, key);
    const reportStore = createExecutionReportStore(db, key);
    const caseStore = createExecutionCaseStore(db, key);
    const dissectionStore = createExecutionSpanDissectionStore(db, key);
    const interventionStore = createCaseInterventionStore(
      db, key, new TextEncoder().encode('retention-secret'),
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
      anchorStore, reportStore, caseStore: undefined as never, dissectionStore,
      compiler, registry: tools, interventionStore, now: () => (clock += 1),
    } as Parameters<typeof createExecutionCaseLifecycle>[0]);
    const feedbackRecorder = createExecutionCaseFeedbackRecorder({
      anchorStore, feedbackStore, reportStore, caseStore, interventionStore,
      compiler, now: () => (clock += 1),
    });
    return { db, anchorStore, caseStore, reportStore, compiler, lifecycle, feedbackRecorder };
  };

  /** One recorded turn: a request, two distinct governed calls, finalization. */
  const runTurn = async (
    f: ReturnType<typeof fixture>,
    input: { root: string; session: string; turn: string; prompt?: string },
  ): Promise<void> => {
    await f.anchorStore.openSpan({
      root_request_id: input.root,
      session_id: input.session,
      surface: 'chat',
      root_request: input.prompt ?? 'send the quarterly report to the customer',
      turn_id: input.turn,
      now: 100,
    });
    addActivity(f.db, {
      id: `${input.root}-a`, at: 101, session: input.session, turn: input.turn,
      tool: 'contact.search',
    });
    addActivity(f.db, {
      id: `${input.root}-b`, at: 102, session: input.session, turn: input.turn,
      tool: 'mail.send',
    });
    await f.lifecycle.finalizeTurn({
      session_id: input.session,
      turn_id: input.turn,
    });
  };

  it('drops an old source that backs no case, with its observations', async () => {
    const f = fixture();
    await runTurn(f, { root: 'r1', session: 's1', turn: 't1' });
    expect(await f.reportStore.listAll()).toHaveLength(1);
    expect(await f.caseStore.listObservations()).toHaveLength(1);
    // Nothing admitted — an unwitnessed success is inert, which is exactly the
    // shape 9a now records on most turns.
    expect(await f.caseStore.listAll()).toEqual([]);

    expect(await f.compiler.pruneSourcesOlderThan(Date.now()))
      .toEqual({ reports: 1, observations: 1 });
    expect(await f.reportStore.listAll()).toEqual([]);
    expect(await f.caseStore.listObservations()).toEqual([]);
  });

  it('⛔ KEEPS a source a case rests on — and the case survives the rebuild', async () => {
    // THE LOAD-BEARING HALF. `rebuildMaterialized` preserves a projection only
    // while every one of its source reports still exists, so pruning a
    // supporting report would not shrink storage — it would DELETE the
    // precedent. This is the witness the rule permits.
    const f = fixture();
    await runTurn(f, { root: 'r1', session: 's1', turn: 't1' });
    await f.feedbackRecorder.record({
      session_id: 's1', turn_id: 't1', kind: 'accepted',
    });
    expect(await f.caseStore.listAll()).toHaveLength(1);

    expect(await f.compiler.pruneSourcesOlderThan(Date.now()))
      .toEqual({ reports: 0, observations: 0 });
    expect(await f.reportStore.listAll()).toHaveLength(1);
    const cases = await f.caseStore.listAll();
    expect(cases).toHaveLength(1);
    expect(cases[0]!.outcome_strength.evidence_families)
      .toContain('typed_acceptance');
  });

  it('keeps a source that is unsupported but still RECENT', async () => {
    const f = fixture();
    await runTurn(f, { root: 'r1', session: 's1', turn: 't1' });
    // The turn was recorded "now"; a window that ends before it protects it.
    expect(await f.compiler.pruneSourcesOlderThan(1))
      .toEqual({ reports: 0, observations: 0 });
    expect(await f.reportStore.listAll()).toHaveLength(1);
  });

  it('⛔ takes the COMPILED MARKER with the report, or every later turn replays', async () => {
    // A compiled-report row outliving its report makes `canCompileIncrementally`
    // refuse forever — silently downgrading every subsequent turn to a full
    // corpus replay. The prune deletes both, and this is what says so.
    const f = fixture();
    await runTurn(f, { root: 'r1', session: 's1', turn: 't1' });
    const [stored] = await f.reportStore.listAll();
    const reportId = stored!.report.report_id;
    expect([...f.caseStore.compiledReportVersions().keys()]).toContain(reportId);

    await f.compiler.pruneSourcesOlderThan(Date.now());
    expect([...f.caseStore.compiledReportVersions().keys()])
      .not.toContain(reportId);
  });

  it('prunes only what is old, leaving the rest compilable', async () => {
    const f = fixture();
    await runTurn(f, { root: 'old', session: 's-old', turn: 't1' });
    const [first] = await f.reportStore.listAll();
    const cutoff = (first!.closed_at ?? 0) + 1;
    await runTurn(f, { root: 'new', session: 's-new', turn: 't1' });

    expect(await f.compiler.pruneSourcesOlderThan(cutoff))
      .toEqual({ reports: 1, observations: 1 });
    const remaining = await f.reportStore.listAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.report.root_request_id).toBe('new');
    // …and the survivor still compiles into an admitted case when the owner
    // answers, which is the proof the prune left a working corpus behind.
    await f.feedbackRecorder.record({
      session_id: 's-new', turn_id: 't1', kind: 'accepted',
    });
    expect(await f.caseStore.listAll()).toHaveLength(1);
  });
});
