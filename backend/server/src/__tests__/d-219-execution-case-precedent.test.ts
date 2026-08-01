/** D-219 — THE CORPUS GETS A READER.
 *
 *  Everything the arc built records precedent; nothing read it. Both
 *  model-facing surfaces are gated on a complete pre-registered experiment
 *  definition (16 env fields, fail-closed), so on an ordinary self-hosted server
 *  no case ever reached a model. Answering "was that right?" changed nothing the
 *  owner could observe, which is what made the ask hard to defend.
 *
 *  Driven end to end through the real compiler, the real stores, the real
 *  offer→feedback loop and the real composition, because the claim under test is
 *  precisely that these connect with NO configuration. A stubbed case store
 *  would pre-decide it.
 */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXECUTION_CASE_CARD_NOTICE,
  OWNER_CONTRACT_ID,
  type InternalToolRegistry,
  type ToolEntry,
  type ToolTier,
} from '@recued/contracts';

import { createExecutionCaseCompiler } from '../execution-case-compiler.js';
import { createExecutionCaseFeedbackRecorder } from '../execution-case-feedback.js';
import { createExecutionCaseLifecycle } from '../chat-execution-case-tools.js';
import { createChatStreamMiddlewares } from '../chat-stream-middleware.js';
import { composeChatMainTurnPromptParts } from '../chat-turn-executor.js';
import { composeExecutionCases } from '../composition/bin/wire-execution-cases.js';
import {
  createExecutionCaseOfferLifecycle,
} from '../execution-case-offer-lifecycle.js';
import {
  createExecutionCasePrecedentSource,
  executionCaseLearnedEntry,
  readExecutionCasePrecedentContext,
  renderExecutionCasePrecedentCard,
  EXECUTION_CASE_PRECEDENT_MAX_CARDS,
  EXECUTION_CASE_PRECEDENT_MIDDLEWARE_ID,
  EXECUTION_CASE_PRECEDENT_MIN_RELEVANCE,
  type ExecutionCasePrecedentDeps,
  selectOriginObservation,
} from '../execution-case-precedent.js';
import type {
  ExecutionCasePrecedentObservation,
} from '../execution-case-precedent.js';
import {
  createD213ScanCaseCandidateSource,
} from '../execution-case-retrieval.js';
import { readConsultedExecutionCaseKeys } from '../execution-case-retrieval.js';
import {
  executionCaseKey,
  requestShapeHash,
  type CaseSourceObservation,
  analyzeExecutionCaseRequest,
  scoreExecutionCaseRelevance,
} from '../execution-case-core.js';
import { createCaseInterventionStore } from '../storage/case-intervention-store.js';
import { createExecutionCaseFeedbackStore } from '../storage/execution-case-feedback-store.js';
import { createExecutionCaseStore } from '../storage/execution-case-store.js';
import { createExecutionReportStore } from '../storage/execution-report-store.js';
import { createExecutionSpanAnchorStore } from '../storage/execution-span-anchor-store.js';
import { createExecutionSpanDissectionStore } from '../storage/execution-span-dissection-store.js';
import { createExecutionCaseVerificationStore } from '../storage/execution-case-verification-store.js';
import type { D214KeyProvider } from '../storage/d214-sealed-json.js';
import type { ExecutionCaseOfferNotifier } from '../execution-case-offer-lifecycle.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const REQUEST = 'send the quarterly report to the customer';

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
  // ⚠ Present so the V21 flow below is not STALE. `eligiblePrecedentRowFlows`
  // drops a flow naming a tool the registry cannot resolve, and a dropped flow
  // renders no card — which reads identically to "the identity was lost".
  {
    // ⚠ V22 fixtures need THREE distinct NON-core rounds to be admissible, and
    // `mail.send` was the registry's only Tier-2 entry. These two make a
    // realistic recipe chain expressible — which is what the feature is now for.
    name: 'acme/invoice-book', tier: 2, description: 'file an invoice',
    arg_schema: {}, topic_tags: ['billing'], classification: 'write',
    risk_tier: 'write', concurrency_safe: false,
  }, {
    name: 'acme/ledger-post', tier: 2, description: 'post to the ledger',
    arg_schema: {}, topic_tags: ['billing'], classification: 'write',
    risk_tier: 'write', concurrency_safe: false,
  }, {
    name: 'recipe.run', tier: 1, description: 'run a recipe', arg_schema: {},
    topic_tags: ['recipes'], classification: 'write', risk_tier: 'write',
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
  input: {
    id: string; at: number; session: string; turn: string; tool: string;
    /** V20 — the tool-loop round. Omitted reproduces a pre-V20 row exactly. */
    round?: number;
  },
): void => {
  db.prepare('INSERT INTO audit_activities (key, data) VALUES (?, ?)').run(
    input.id,
    JSON.stringify({
      activity_id: input.id,
      timestamp: input.at,
      action: 'chat_tool_call',
      target: `${input.session}:${input.turn}:${input.tool}`,
      detail: JSON.stringify({
        status: 'ok',
        ...(input.round !== undefined ? { round_index: input.round } : {}),
      }),
    }),
  );
};

/** Enough of the notification block to drive an answer back through the real
 *  feedback rpc — the ONLY way this fixture can produce a case, because after
 *  D-219 nothing else in an ordinary corpus admits. */
const fakeNotifier = () => {
  const handlers = new Map<
    string,
    (
      payload: Record<string, unknown>,
      answer: { option: string; answered_at: number },
    ) => void | Promise<void>
  >();
  const asks = new Map<string, {
    kind: string;
    payload: Record<string, unknown>;
    status: 'open' | 'answered';
  }>();
  let seq = 0;
  const notifier: ExecutionCaseOfferNotifier = {
    ask: async (_message, _options, handler) => {
      seq += 1;
      asks.set(`ask-${seq}`, {
        kind: handler.kind, payload: handler.payload, status: 'open',
      });
      return { ask_id: `ask-${seq}` };
    },
    cancelAsk: async () => 'not_open',
    listOpenAsks: async () =>
      [...asks.entries()]
        .filter(([, row]) => row.status === 'open')
        .map(([ask_id, row]) => ({
          ask_id,
          handler_kind: row.kind,
          handler_payload: row.payload,
        })),
    registerAskHandler: (kind, handler) => {
      handlers.set(kind, handler);
    },
  };
  return {
    notifier,
    answer: async (ask_id: string, option: string) => {
      const row = asks.get(ask_id);
      if (!row || row.status !== 'open') return;
      row.status = 'answered';
      await handlers.get(row.kind)?.(
        row.payload,
        { option, answered_at: 5_000 },
      );
    },
  };
};

const caseKeyOf = (observation: CaseSourceObservation): string =>
  executionCaseKey({
    governing_contract_id: observation.governing_contract_id,
    principal_key: observation.principal_key,
    request_shape_hash: requestShapeHash(observation.request_shape),
    policy_fingerprint: observation.policy_fingerprint,
  });

const fixture = () => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  schema(db);
  const key = keyProvider();
  const anchorStore = createExecutionSpanAnchorStore(db, key);
  const reportStore = createExecutionReportStore(db, key);
  const caseStore = createExecutionCaseStore(db, key);
  const dissectionStore = createExecutionSpanDissectionStore(db, key);
  const interventionStore = createCaseInterventionStore(
    db, key, new TextEncoder().encode('precedent-secret'),
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
    anchorStore, reportStore, dissectionStore,
    compiler, registry: tools, interventionStore, now: () => (clock += 1),
  } as Parameters<typeof createExecutionCaseLifecycle>[0]);
  const feedbackRecorder = createExecutionCaseFeedbackRecorder({
    anchorStore, feedbackStore, reportStore, caseStore, interventionStore,
    compiler, now: () => (clock += 1),
  });
  const notifications = fakeNotifier();
  const offers = createExecutionCaseOfferLifecycle({
    notifier: notifications.notifier,
    compiler, caseStore, feedback: feedbackRecorder, caseKeyOf,
  });
  offers.registerAnswerHandler();
  const deps: ExecutionCasePrecedentDeps = {
    anchorStore,
    caseStore,
    candidateSource: createD213ScanCaseCandidateSource(caseStore),
    ensureCasesCurrent: compiler.ensureCurrent,
    // ⚠ `OWNER_CONTRACT_ID`, exactly as `resolveOwnerScope` in the real
    // composer resolves it. A literal 'owner' here would scope the lookup to a
    // contract no case is ever filed under, and every assertion below would
    // read as "the substrate found nothing" while the substrate was fine.
    resolveScope: () => ({
      governing_contract_id: OWNER_CONTRACT_ID,
      principal_key: 'user_self',
      active: true,
    }),
  };
  return {
    db, anchorStore, caseStore, compiler, lifecycle, offers, notifications,
    // Exposed so a test can plant a deterministic verification — the evidence
    // kind that used to survive a forget and re-admit the case.
    verificationStore,
    deps,
  };
};

/** One complete turn: a request, two distinct governed calls, finalization. */
const runTurn = async (
  f: ReturnType<typeof fixture>,
  input: {
    root: string; turn: string; prompt?: string; tools?: string[];
    rounds?: number[];
  },
): Promise<void> => {
  await f.anchorStore.openSpan({
    root_request_id: input.root,
    session_id: 's1',
    surface: 'chat',
    root_request: input.prompt ?? REQUEST,
    turn_id: input.turn,
    now: 100,
  });
  // ⛔ V22 — the DEFAULT is now a THREE-ROUND NON-CORE chain, and it has to be.
  // Admission counts distinct rounds containing a non-Tier-1 op
  // (`EXECUTION_CASE_MIN_DISTINCT_ROUNDS`), so the old default
  // (`['file.search','mail.send']`, no rounds at all) is CORRECTLY inadmissible
  // now: two calls, no round information, one non-core op. Every test here whose
  // subject is something OTHER than admission needs a fixture that gets past it.
  // ⚠ `rounds` defaults to one-per-step. Omitting it leaves `round_ordinals`
  // empty, which reads as "cannot judge" and refuses — a silent no-case that
  // looks exactly like a broken assertion.
  const tools = input.tools ?? ['mail.send', 'acme/invoice-book', 'acme/ledger-post'];
  const rounds = input.rounds ?? tools.map((_, index) => index);
  tools.forEach((tool, index) => {
    addActivity(f.db, {
      id: `${input.root}-${index}`, at: 101 + index, session: 's1',
      turn: input.turn, tool,
      round: rounds[index] ?? index,
    });
  });
  await f.lifecycle.finalizeTurn({ session_id: 's1', turn_id: input.turn });
};

/** A turn the owner answered — the only shape that files a case after D-219. */
const acceptedTurn = async (
  f: ReturnType<typeof fixture>,
  input: {
    root: string; turn: string; prompt?: string; tools?: string[];
    rounds?: number[];
  },
  verdict = 'accepted',
): Promise<void> => {
  await runTurn(f, input);
  const raised = await f.offers.offerForTurn({
    session_id: 's1', turn_id: input.turn,
  });
  await f.notifications.answer(raised!.ask_id, verdict);
};

const promptCtx = (turn: string, text = REQUEST) => {
  const state = new Map<string, unknown>();
  return {
    ctx: {
      surface: 'chat',
      session_id: 's1',
      turn_id: turn,
      history: [{ role: 'user', text }],
      state,
    } as never,
    state,
  };
};

/** Open a fresh turn's span so the middleware has a rooted turn to scope. */
const openTurn = async (
  f: ReturnType<typeof fixture>,
  input: { root: string; turn: string; prompt?: string },
): Promise<void> => {
  await f.anchorStore.openSpan({
    root_request_id: input.root,
    session_id: 's1',
    surface: 'chat',
    root_request: input.prompt ?? REQUEST,
    turn_id: input.turn,
    now: 200,
  });
};

describe('D-219 — a case reaches the model with NO experiment configured', () => {
  /** ⛔⛔ INVERTED DELIBERATELY. This test used to assert the ordinary surface
   *  COMPOSED a precedent dep — "the whole point" of the slice that shipped it.
   *  The card is now removed from the chat surface on measured evidence (~5.5x
   *  invented arguments across two pre-registered A/B rounds), so the contract
   *  is the opposite and the test is kept, not deleted: a deletion leaves
   *  nothing to stop the dep being wired back, and the whole reason it is gone
   *  is that its harm is invisible without an A/B. */
  it('composes NO precedent dep — the card is off on the chat surface', () => {
    const db = new Database(':memory:');
    cleanups.push(() => db.close());
    schema(db);
    const key = keyProvider();
    const composed = composeExecutionCases({
      db,
      chatKeyProvider: key,
      registry: registry(),
      getSpanAnchorDeps: () => ({
        store: createExecutionSpanAnchorStore(db, key),
        mintRootRequestId: () => 'unused',
      }),
    });
    expect(composed.getExecutionCasePrecedentDeps?.()).toBeUndefined();
    // ⚠ The permitting witness stays: the OTHER surfaces are still correctly
    // dark, so this cannot pass against a composer that returns nothing at all.
    expect(composed.getExecutionCaseAugmentationDeps).toBeUndefined();
    expect(composed.getExecutionCaseProposalCritic).toBeUndefined();
  });

  it('⛔ stays dark while a pre-registered experiment is running', async () => {
    // A control arm that received precedent from a SECOND source is not a
    // control arm, and nothing would fail — the study would simply be measuring
    // a prompt it never recorded a fingerprint for. Asserted for the
    // `proposal_critique` surface deliberately: that experiment does not touch
    // request augmentation at all, so "different surface, no conflict" is the
    // reasoning this refuses.
    const db = new Database(':memory:');
    cleanups.push(() => db.close());
    schema(db);
    const key = keyProvider();
    const composed = composeExecutionCases({
      db,
      chatKeyProvider: key,
      registry: registry(),
      getSpanAnchorDeps: () => ({
        store: createExecutionSpanAnchorStore(db, key),
        mintRootRequestId: () => 'unused',
      }),
      experimentSecret: 'secret',
      experiment: {
        experiment_id: 'exp-critique',
        surface: 'proposal_critique',
        eligible_population: 'in-scope rooted unseen consequential proposals',
        starts_at: 1,
        ends_at: 2,
        max_roots: 10,
        max_critique_opportunities_per_root: 2,
        max_evidence: 2,
        min_relevance_score: 1,
        primary_axes: ['explicit_acceptance'],
        material_harm_bounds: { explicit_rejection: 0.1 },
        decision_rule: 'ship if no harm',
        planner_fingerprint: 'p',
        prompt_fingerprint: 'q',
        retrieval_fingerprint: 'r',
        policy_fingerprint: 's',
      },
    });
    expect(composed.getExecutionCasePrecedentDeps).toBeUndefined();
    expect(composed.getExecutionCaseProposalCritic?.()).toBeDefined();
  });

  /** ⛔⛔ THE RE-WIRING GUARD, and it is the important half of this removal.
   *  Supplying the dep used to register the hook; the registration is deleted,
   *  so it must NOT register even when a caller hands the dep over. A removal
   *  that only stops the composer leaves a live seam one edit away from
   *  restoring a measured regression — and this asserts the state that would
   *  DO the thing if the guard were gone, not merely the empty case. */
  it('⛔ does NOT register the precedent hook, even when handed the dep', () => {
    // ⚠ `getSpanAnchorDeps` is here ONLY to make the list non-empty. Without it
    // the composer returns ZERO middlewares and `not.toContain` passes against
    // an empty array — which is what the first cut of this test did, and the
    // non-vacuity assertion below is what caught it.
    const withDep = createChatStreamMiddlewares({
      now: () => 0,
      getSpanAnchorDeps: () => ({
        store: {} as never,
        mintRootRequestId: () => 'unused',
      }),
      getExecutionCasePrecedentDeps: () => undefined,
    } as Parameters<typeof createChatStreamMiddlewares>[0])
      .map((middleware) => middleware.id);
    expect(withDep).not.toContain(EXECUTION_CASE_PRECEDENT_MIDDLEWARE_ID);
    expect(withDep.length).toBeGreaterThan(0);
  });

  it('the loop closes: an answered turn becomes a card on the next one', async () => {
    // End to end, in one test: a plain turn is recorded (9a), the owner is asked
    // (9c), their answer files a case — and now the NEXT matching request
    // carries it into the prompt. Before this slice the last arrow did not
    // exist.
    const f = fixture();
    await acceptedTurn(f, { root: 'r1', turn: 't1' });
    expect(await f.caseStore.listAll()).toHaveLength(1);

    await openTurn(f, { root: 'r2', turn: 't2' });
    const { ctx, state } = promptCtx('t2');
    await createExecutionCasePrecedentSource(() => f.deps).prompt!(ctx);

    const context = readExecutionCasePrecedentContext(state);
    expect(context?.cards).toHaveLength(1);
    expect(context!.cards[0]!.flows[0]!.tools_that_may_be_needed)
      .toEqual(['acme/invoice-book', 'acme/ledger-post', 'mail.send']);
    expect(context!.cards[0]!.flows[0]!.outcome)
      .toEqual(['You confirmed this was right.']);
  });

  it('ships the contracts notice BY IDENTITY, not a fresh literal', async () => {
    // The governance sentence used to exist in three formulations, the
    // authoritative one shipping nowhere. A substring assertion passes against
    // every one of them; only identity distinguishes a reference from a copy.
    const f = fixture();
    await acceptedTurn(f, { root: 'r1', turn: 't1' });
    await openTurn(f, { root: 'r2', turn: 't2' });
    const { ctx, state } = promptCtx('t2');
    await createExecutionCasePrecedentSource(() => f.deps).prompt!(ctx);
    expect(readExecutionCasePrecedentContext(state)?.notice)
      .toBe(EXECUTION_CASE_CARD_NOTICE);
  });

  it('⛔ A31 — records the consulted key, so the card cannot reinforce itself', async () => {
    // Without this the substrate compounds its own belief: the owner accepts a
    // turn that was SHOWN this card, that acceptance files as fresh evidence
    // FOR the card, and the case grows more persuasive every time it is
    // believed. The compiler reads this exact state key when it closes the
    // report, which is why the precedent surface writes the same Set the
    // experiment surface does rather than one of its own.
    const f = fixture();
    await acceptedTurn(f, { root: 'r1', turn: 't1' });
    const [row] = await f.caseStore.listAll();
    await openTurn(f, { root: 'r2', turn: 't2' });
    const { ctx, state } = promptCtx('t2');
    await createExecutionCasePrecedentSource(() => f.deps).prompt!(ctx);
    expect(readConsultedExecutionCaseKeys(state)).toEqual([row!.case_key]);
  });

  it('shows nothing when the corpus holds no matching case', async () => {
    const f = fixture();
    await acceptedTurn(f, { root: 'r1', turn: 't1' });
    await openTurn(f, {
      root: 'r2', turn: 't2', prompt: 'what is on my calendar tomorrow',
    });
    const { ctx, state } = promptCtx('t2', 'what is on my calendar tomorrow');
    await createExecutionCasePrecedentSource(() => f.deps).prompt!(ctx);
    expect(readExecutionCasePrecedentContext(state)).toBeUndefined();
  });

  it('shows nothing on a turn with no span anchor', async () => {
    const f = fixture();
    await acceptedTurn(f, { root: 'r1', turn: 't1' });
    const { ctx, state } = promptCtx('t-unanchored');
    await createExecutionCasePrecedentSource(() => f.deps).prompt!(ctx);
    expect(readExecutionCasePrecedentContext(state)).toBeUndefined();
  });

  it('shows nothing when the scope is not the owner\'s own chat turn', async () => {
    const f = fixture();
    await acceptedTurn(f, { root: 'r1', turn: 't1' });
    await openTurn(f, { root: 'r2', turn: 't2' });
    const { ctx, state } = promptCtx('t2');
    await createExecutionCasePrecedentSource(() => ({
      ...f.deps,
      resolveScope: () => ({
        governing_contract_id: 'owner',
        principal_key: 'user_self',
        active: false,
      }),
    })).prompt!(ctx);
    expect(readExecutionCasePrecedentContext(state)).toBeUndefined();
  });

  it('⛔ never costs the turn when retrieval throws', async () => {
    // The framework does NOT swallow a middleware throw — the finalizer carries
    // its own try/catch for that reason — and unlike the experiment surface this
    // hook runs on every chat turn. The guard is at the seam rather than
    // promised in a doc comment, which is the shape the argument-capture hook
    // was caught in.
    const f = fixture();
    await acceptedTurn(f, { root: 'r1', turn: 't1' });
    await openTurn(f, { root: 'r2', turn: 't2' });
    const { ctx, state } = promptCtx('t2');
    await expect(createExecutionCasePrecedentSource(() => ({
      ...f.deps,
      candidateSource: {
        id: 'throwing',
        findCandidates: async () => {
          throw new Error('scan exploded');
        },
      },
    })).prompt!(ctx)).resolves.toBeUndefined();
    expect(readExecutionCasePrecedentContext(state)).toBeUndefined();
  });
});

describe('D-219 — SHAPE ONLY: what the card may and may not say', () => {
  const cardFor = async (
    verdict = 'accepted',
    // ⚠ V22 — a THREE-ROUND NON-CORE chain, matching `runTurn`'s default. The
    // old `['file.search','mail.send']` is now correctly inadmissible (one
    // non-core op, no round information), and every test below whose subject is
    // the CARD rather than admission needs a fixture that clears the gate.
    tools = ['mail.send', 'acme/invoice-book', 'acme/ledger-post'],
  ) => {
    const f = fixture();
    await acceptedTurn(f, { root: 'r1', turn: 't1', tools }, verdict);
    const [row] = await f.caseStore.listAll();
    return { f, row: row!, card: renderExecutionCasePrecedentCard(row!) };
  };

  it('carries the tools as a deduped CANDIDATE SET, not a sequence', async () => {
    // ⛔ `tool_sequence`, never `tools`. The latter is a `topic_tags`
    // projection: it deduplicates, and its order survives only because `Set`
    // happens to preserve insertion. They agree on every case admitted today,
    // and that agreement is an accident of slice 8's repeat exclusion.
    const { card, row } = await cardFor();
    // Sorted + deduped: a candidate LIST, so a rebuild is byte-identical and a
    // tool used twice is one candidate.
    expect(card!.flows[0]!.tools_that_may_be_needed)
      .toEqual(['acme/invoice-book', 'acme/ledger-post', 'mail.send']);
    // Non-vacuity: the COMPILED flow still carries the ordered sequence — the
    // card CHOOSES not to show it. A V18 case would have rendered nothing here,
    // which is why V19 exists.
    expect(row.flows[0]!.tool_sequence)
      .toEqual(['mail.send', 'acme/invoice-book', 'acme/ledger-post']);
  });

  it('⛔ carries no counters, no timestamps and no arguments', async () => {
    const { card } = await cardFor();
    const rendered = JSON.stringify(card);
    // `declined` reads 0 on a flow the owner refused at the Gateway — a number
    // that is wrong in the reader's sense, which is worse than an absent one.
    for (const counter of [
      'declined', 'proposed', 'accepted', 'executed', 'user_acceptances',
      'outcome_strength', 'request_observations',
    ]) expect(rendered).not.toContain(counter);
    // A raw epoch is the reliable way to make a model state the wrong date, and
    // this surface has no timezone to render one in.
    for (const stamp of ['last_seen_at', 'first_seen_at']) {
      expect(rendered).not.toContain(stamp);
    }
    // Acceptance #47 — D-214 learns PROCEDURE, not preference. The D-219 capture
    // buffer holds real argument values and is deliberately not a source here.
    expect(rendered).not.toContain('args');
    expect(Object.keys(card!)).toEqual(['request', 'flows']);
    expect(Object.keys(card!.flows[0]!))
      .toEqual(['tools_that_may_be_needed', 'outcome']);
  });

  it('says a REJECTION as a rejection, so a bare shape cannot read as advice', async () => {
    // ⛔ THE SAFETY PROPERTY. A tool sequence with nothing attached is a
    // recommendation by implication, and the route the owner REJECTED would
    // then arrive looking exactly like the one they accepted — the substrate
    // teaching back the mistake it recorded.
    const rejected = await cardFor('rejected');
    expect(rejected.card!.flows[0]!.outcome)
      .toEqual(['You rejected the result.']);
    // …and the permitting witness, so this cannot pass against a renderer that
    // says "rejected" about everything.
    const accepted = await cardFor('accepted');
    expect(accepted.card!.flows[0]!.outcome)
      .toEqual(['You confirmed this was right.']);
  });

  it('drops a flow that cannot say what was concluded about it', async () => {
    const { row } = await cardFor();
    const silent = {
      ...row,
      flows: [{
        ...row.flows[0]!,
        user_acceptances: 0,
        user_corrections: 0,
        user_rejections: 0,
        user_undos: 0,
        verified_successes: 0,
        verification_failures: 0,
        outcome_strength: {
          ...row.flows[0]!.outcome_strength,
          evidence_families: [],
        },
      }],
    };
    expect(renderExecutionCasePrecedentCard(silent)).toBeUndefined();
    // The permitting witness: the SAME row with its attestation restored still
    // renders, so this is a rule about silence and not a renderer that refuses
    // everything.
    expect(renderExecutionCasePrecedentCard(row)).toBeDefined();
  });

  it('drops a PRE-V19 stored flow rather than throwing on its absent field', async () => {
    // ⛔ Materialized cases are SEALED JSON. A case compiled under V18 carries no
    // `tool_sequence` in its stored payload however confidently the interface
    // declares one, and it survives until `ensureCurrent` re-derives the corpus.
    // Reading `.length` off it throws — which the middleware's seam guard would
    // swallow into a silent no-card, so a half-finished upgrade would look
    // exactly like an empty corpus.
    const { row } = await cardFor();
    const stored = {
      ...row,
      flows: [
        Object.fromEntries(
          Object.entries(row.flows[0]!)
            .filter(([field]) => field !== 'tool_sequence'),
        ) as (typeof row.flows)[number],
      ],
    };
    // Non-vacuity: the field really is gone from the fixture.
    expect(Object.hasOwn(stored.flows[0]!, 'tool_sequence')).toBe(false);
    expect(() => renderExecutionCasePrecedentCard(stored)).not.toThrow();
    expect(renderExecutionCasePrecedentCard(stored)).toBeUndefined();
    expect(renderExecutionCasePrecedentCard(row)).toBeDefined();
  });

  it('drops a STALE flow — it may name a tool that no longer exists', async () => {
    const { row } = await cardFor();
    expect(renderExecutionCasePrecedentCard({
      ...row,
      flows: [{ ...row.flows[0]!, stale: true }],
    })).toBeUndefined();
    expect(renderExecutionCasePrecedentCard(row)).toBeDefined();
  });

  it('reports a repeated verdict with its count rather than louder words', async () => {
    const { row } = await cardFor();
    const card = renderExecutionCasePrecedentCard({
      ...row,
      flows: [{ ...row.flows[0]!, user_acceptances: 3 }],
    });
    expect(card!.flows[0]!.outcome)
      .toEqual(['You confirmed this was right. (3 times)']);
  });
});

describe('D-219 V21 — the recipe identity survives to the card', () => {
  /** ⛔ THE SEAM, not the ends. `deriveExecutionFlowPattern` and the renderer
   *  are each covered in `d-219-flow-recipe-identity.test.ts`, and BOTH passed
   *  while this was broken: the compiled flow is a SEPARATE projection from the
   *  pattern, so a field added to the pattern reaches the card only if
   *  `emptyFlow` carries it across. V19 and V20 each shipped that exact gap and
   *  each found it the same way — by driving a real turn end to end. */
  it('carries it from a real dispatch through to the rendered card', async () => {
    const f = fixture();
    await f.anchorStore.openSpan({
      root_request_id: 'r1',
      session_id: 's1',
      surface: 'chat',
      root_request: REQUEST,
      turn_id: 't1',
      now: 100,
    });
    // ⚠ V22 — three distinct NON-core rounds, or the offer never fires. The
    // `recipe.run` step is what this test is ABOUT, and it counts as non-core
    // via its paired `recipe_id` despite the dispatcher being Tier 1.
    addActivity(f.db, {
      id: 'a-0', at: 101, session: 's1', turn: 't1', tool: 'recipe.run',
      round: 0,
    });
    addActivity(f.db, {
      id: 'a-1', at: 102, session: 's1', turn: 't1', tool: 'acme/invoice-book',
      round: 1,
    });
    addActivity(f.db, {
      id: 'a-2', at: 103, session: 's1', turn: 't1', tool: 'acme/ledger-post',
      round: 2,
    });
    // The run row the dispatch pairs against. `recipe_id` is the BARE id, which
    // is what the audit records — `RecipeStore` is keyed bare.
    f.db.prepare(
      'INSERT OR REPLACE INTO audit_entries (key, data) VALUES (?, ?)',
    ).run('run-1', JSON.stringify({
      run_id: 'run-1',
      recipe_id: 'send-email',
      recipe_hash: 'hash-run-1',
      started_at: 102,
      finished_at: 103,
      commit_status: 'committed',
      errors: [],
      execution_source: {
        channel: 'chat', actor: 'user_self', chat_session_id: 's1',
        user_id: 'owner', turn_id: 't1',
      },
    }));
    await f.lifecycle.finalizeTurn({ session_id: 's1', turn_id: 't1' });
    const raised = await f.offers.offerForTurn({
      session_id: 's1', turn_id: 't1',
    });
    await f.notifications.answer(raised!.ask_id, 'accepted');

    const [row] = await f.caseStore.listAll();
    // NON-VACUITY: the pairing really happened. Without it the flow would carry
    // no identity for an unrelated reason and the assertions below would be
    // green on an empty premise.
    expect(row!.flows[0]!.tool_sequence)
      .toEqual(['recipe.run', 'acme/invoice-book', 'acme/ledger-post']);
    expect(row!.flows[0]!.recipe_steps)
      .toEqual([{ ordinal: 0, recipe_id: 'send-email' }]);

    // The identity survives the rename: the card still names WHICH recipe ran,
    // which is the whole point of V21 — a bare `recipe.run` says a recipe ran
    // without saying which, and that is useless as a discovery hint.
    expect(renderExecutionCasePrecedentCard(row!)!.flows[0]!.tools_that_may_be_needed)
      .toEqual(['acme/invoice-book', 'acme/ledger-post', 'recipe.run (send-email)']);
  });
});

describe('D-219 — the card stays below the cacheable prefix', () => {
  it('changes only the dynamic tail', () => {
    // ⛔⛔ D-164 keeps the tool catalog in a byte-stable cacheable prefix —
    // measured at −49.9% input tokens, 98% cached. A card injected above it
    // would invalidate that cache on EVERY turn, which is a far larger
    // regression than any card is worth.
    const baseline = composeChatMainTurnPromptParts({
      available_tools: [],
      content: { chat_tail: [], user_message: REQUEST },
    });
    const augmented = composeChatMainTurnPromptParts({
      available_tools: [],
      content: { chat_tail: [], user_message: REQUEST },
      execution_precedent: {
        notice: EXECUTION_CASE_CARD_NOTICE,
        cards: [{
          request: ['send report'],
          flows: [{
            tools_that_may_be_needed: ['file.search', 'mail.send'],
            outcome: ['You confirmed this was right.'],
          }],
        }],
      },
    });
    expect(augmented.cacheable_prefix).toBe(baseline.cacheable_prefix);
    expect(augmented.body.startsWith(augmented.cacheable_prefix)).toBe(true);
    expect(augmented.body).toContain('execution_precedent');
    expect(augmented.body).toContain('file.search');
  });

  it('serializes nothing at all when no card was selected', () => {
    // An empty block would cost tokens and read to the model as "precedent was
    // consulted and found nothing", which is a different claim from silence.
    const parts = composeChatMainTurnPromptParts({
      available_tools: [],
      content: { chat_tail: [], user_message: REQUEST },
      execution_precedent: {
        notice: EXECUTION_CASE_CARD_NOTICE,
        cards: [],
      },
    });
    expect(parts.body).not.toContain('execution_precedent');
  });
});

describe('D-219 — the block is bounded', () => {
  it('shows at most the card cap, even with more matching cases', async () => {
    const f = fixture();
    // Distinct request shapes so each files its OWN case, all lexically
    // overlapping the query.
    await acceptedTurn(f, {
      root: 'r1', turn: 't1', prompt: 'send the quarterly report to the customer',
    });
    await acceptedTurn(f, {
      root: 'r2', turn: 't2', prompt: 'send the quarterly report to the auditor',
      tools: ['mail.send', 'acme/invoice-book', 'acme/ledger-post'],
    });
    await acceptedTurn(f, {
      root: 'r3', turn: 't3', prompt: 'send the quarterly summary to the customer',
      tools: ['mail.send', 'acme/invoice-book', 'acme/ledger-post'],
    });
    const cases = await f.caseStore.listAll();
    // Non-vacuity: without more cases than the cap this asserts nothing.
    expect(cases.length).toBeGreaterThan(EXECUTION_CASE_PRECEDENT_MAX_CARDS);

    await openTurn(f, { root: 'r4', turn: 't4' });
    const { ctx, state } = promptCtx('t4');
    await createExecutionCasePrecedentSource(() => f.deps).prompt!(ctx);
    expect(readExecutionCasePrecedentContext(state)?.cards)
      .toHaveLength(EXECUTION_CASE_PRECEDENT_MAX_CARDS);
  });

  it('keeps the whole block under its byte ceiling', async () => {
    const f = fixture();
    await acceptedTurn(f, { root: 'r1', turn: 't1' });
    await openTurn(f, { root: 'r2', turn: 't2' });
    const { ctx, state } = promptCtx('t2');
    await createExecutionCasePrecedentSource(() => f.deps).prompt!(ctx);
    const context = readExecutionCasePrecedentContext(state);
    expect(Buffer.byteLength(JSON.stringify(context), 'utf8'))
      .toBeLessThanOrEqual(2 * 1024);
    // ⚠ And it is genuinely small: the arc's own measurement is that the RICH
    // card changed nothing (bench 161), so paying its token cost on every turn
    // would be buying a measured null. One card here is ~100 bytes of payload,
    // against a 24 KB ceiling on the experiment surface.
    expect(EXECUTION_CASE_PRECEDENT_MIN_RELEVANCE).toBeGreaterThan(0);
  });
});

describe('D-219 item 2 — what the OWNER sees', () => {
  it('renders the owner\'s view through the SAME renderer as the model\'s', async () => {
    // ⛔ THE PROPERTY THIS PAGE RESTS ON. It exists to answer "what does it know
    // about me", so a second renderer written to look like the first would make
    // the audit surface drift from the thing it audits — silently, the first
    // time either one changed. Asserted as EQUALITY of the two projections, not
    // as two similar-looking shapes.
    const f = fixture();
    await acceptedTurn(f, { root: 'r1', turn: 't1' });
    const [row] = await f.caseStore.listAll();
    const entry = executionCaseLearnedEntry(row!);
    expect(entry.flows).toEqual(renderExecutionCasePrecedentCard(row!)!.flows);
    expect(entry.shown_to_model).toBe(true);
    expect(entry.case_id).toBe(row!.case_id);
    expect(entry.request_observations).toBe(row!.request_observations);
  });

  it('lists an INERT case rather than hiding it', async () => {
    // A case whose flows are all stale reaches no model, but it is real and
    // retained. Dropping it from the page would make the surface under-report
    // what is stored, which is the opposite of what it is for — so it is listed
    // with `shown_to_model: false` and no flows.
    const f = fixture();
    await acceptedTurn(f, { root: 'r1', turn: 't1' });
    const [row] = await f.caseStore.listAll();
    const inert = executionCaseLearnedEntry({
      ...row!,
      flows: [{ ...row!.flows[0]!, stale: true }],
    });
    expect(inert.shown_to_model).toBe(false);
    expect(inert.flows).toEqual([]);
    // …and it is still an ENTRY, with its identity intact.
    expect(inert.case_id).toBe(row!.case_id);
    expect(inert.request.length).toBeGreaterThan(0);
  });

  it('carries a timestamp the model\'s card deliberately omits', async () => {
    // The card has no timezone to render a date in, so a raw epoch there
    // invites a wrong date. A CLIENT has the viewer's zone, so the owner's view
    // can and should say when.
    const f = fixture();
    await acceptedTurn(f, { root: 'r1', turn: 't1' });
    const [row] = await f.caseStore.listAll();
    expect(executionCaseLearnedEntry(row!).last_seen_at).toBe(row!.last_seen_at);
    expect(JSON.stringify(renderExecutionCasePrecedentCard(row!)))
      .not.toContain('last_seen_at');
  });
});

describe('D-219 item 2 — forget has to actually forget', () => {
  it('⛔ survives the rebuild that re-derives every case', async () => {
    // ⛔⛔ THE TRAP THIS TEST EXISTS FOR. A case is a PROJECTION:
    // `rebuildMaterialized` re-derives all of them from the source
    // observations, so deleting the materialized row alone is a no-op that
    // reports success — the case is back on the next governed turn, minutes
    // later, after the owner was told it was gone.
    const f = fixture();
    await acceptedTurn(f, { root: 'r1', turn: 't1' });
    const [row] = await f.caseStore.listAll();

    const result = await f.compiler.forgetCase(row!.case_id);
    expect(result.removed).toBe(true);
    expect(result.reports).toBeGreaterThan(0);
    expect(await f.caseStore.listAll()).toEqual([]);

    // The assertion that separates a real forget from a cosmetic one.
    await f.compiler.rebuild();
    expect(await f.caseStore.listAll()).toEqual([]);
  });

  it('takes the owner\'s verdict with it', async () => {
    // The answer IS the asset. Leaving it stored after "forget" would keep a
    // fact about the owner that no code can ever read again — the shape this
    // arc keeps finding and removing — and it is not what a person means.
    const f = fixture();
    await acceptedTurn(f, { root: 'r1', turn: 't1' });
    const [row] = await f.caseStore.listAll();
    const result = await f.compiler.forgetCase(row!.case_id);
    expect(result.feedback).toBeGreaterThan(0);
  });

  it('⚠ RETURNS under the SAME id when the owner teaches the same shape again', async () => {
    // ⛔ THE QUESTION "what if a forgotten case comes back". `executionCaseKey`
    // is a deterministic hash of (contract, principal, request_shape_hash,
    // policy_fingerprint) — no nonce, no timestamp — so re-learning the same
    // request shape reproduces the SAME case_id, and to the owner a two-tap
    // destructive control looks undone.
    //
    // 🔑 IT IS NOT A RESURRECTION. Forget takes the source reports AND the
    // owner's verdicts, and admission needs a verdict, so nothing returns on its
    // own: this case is back only because `acceptedTurn` below ANSWERED again.
    // That distinction is the whole justification for not keeping a suppression
    // list — refusing a fresh answer would discard the one thing D-219 learns
    // from. This test exists so the behaviour is a decision on record rather
    // than a surprise.
    const f = fixture();
    await acceptedTurn(f, { root: 'r1', turn: 't1' });
    const first = (await f.caseStore.listAll())[0]!.case_id;

    await f.compiler.forgetCase(first);
    await f.compiler.rebuild();
    expect(await f.caseStore.listAll()).toEqual([]);

    // A NEW turn, same request shape, and the owner answers it again.
    await acceptedTurn(f, { root: 'r2', turn: 't2' });
    const after = await f.caseStore.listAll();
    expect(after).toHaveLength(1);
    expect(after[0]!.case_id).toBe(first);
  });

  it('⛔ stays forgotten when the same shape recurs and the owner does NOT answer', async () => {
    // ⛔ THE PERMITTING WITNESS for the test above, and the property that makes
    // forget meaningful: the request happening again is NOT enough. Without a
    // fresh verdict the span is unwitnessed, and an unwitnessed success is
    // inert — so a forgotten case cannot come back merely because the owner did
    // the same thing again.
    const f = fixture();
    await acceptedTurn(f, { root: 'r1', turn: 't1' });
    const first = (await f.caseStore.listAll())[0]!.case_id;
    await f.compiler.forgetCase(first);

    // Same shape, NO answer this time.
    await runTurn(f, { root: 'r2', turn: 't2' });
    await f.compiler.rebuild();
    expect(await f.caseStore.listAll()).toEqual([]);
  });

  it('⛔⛔ takes the root VERIFICATIONS too, so a verified case cannot re-admit itself', async () => {
    // ⛔⛔ THE DEFECT A CODEX AUDIT FOUND ON 2026-07-29, and the reason the two
    // tests above were not enough. `verification_pass` / `verification_fail` are
    // both in `strongKinds`, and `compileReport` reloads them PER ROOT — so
    // forget deleting reports + typed feedback while LEAVING verifications meant
    // the case came back with no fresh owner verdict at all, which is the one
    // thing forget promises.
    //
    // ⚠ The earlier permitting witness only ever exercised the UNWITNESSED path
    // ("same shape, no answer → stays gone"). It never constructed a retained
    // verification, and I generalised from it. That is the bug in the TEST, not
    // just in the code.
    const f = fixture();
    await acceptedTurn(f, { root: 'r1', turn: 't1' });
    const [row] = await f.caseStore.listAll();

    // A deterministic check also passed on that root — strong evidence, and
    // recorded by the production verifier rather than by the owner.
    f.verificationStore.record({
      verification_id: 'v1',
      root_request_id: 'r1',
      session_id: 's1',
      kind: 'passed',
      postcondition_key: 'mail.sent',
      source_event_id: 'e1',
      recorded_at: 300,
    });

    const result = await f.compiler.forgetCase(row!.case_id);
    expect(result.removed).toBe(true);
    // The count is the visible half of the fix: a caller can see they went.
    expect(result.verifications).toBe(1);
    expect(f.verificationStore.listForRoot('r1')).toEqual([]);

    // ⛔ The assertion that separates a real forget from one that re-admits:
    // rebuild from what is LEFT and the case must still be gone.
    await f.compiler.rebuild();
    expect(await f.caseStore.listAll()).toEqual([]);
  });

  it('leaves an UNRELATED root\'s verifications alone', async () => {
    // The permitting witness: without it the fix above passes against a forget
    // that wiped the verification table.
    const f = fixture();
    await acceptedTurn(f, { root: 'r1', turn: 't1' });
    const [row] = await f.caseStore.listAll();
    f.verificationStore.record({
      verification_id: 'v_keep',
      root_request_id: 'other-root',
      session_id: 's1',
      kind: 'passed',
      postcondition_key: 'mail.sent',
      source_event_id: 'e2',
      recorded_at: 300,
    });
    await f.compiler.forgetCase(row!.case_id);
    expect(f.verificationStore.listForRoot('other-root')).toHaveLength(1);
  });

  it('leaves an unrelated case standing', async () => {
    // The permitting witness. Without it this suite would pass against a
    // `forgetCase` that wiped the corpus.
    const f = fixture();
    await acceptedTurn(f, { root: 'r1', turn: 't1' });
    await acceptedTurn(f, {
      root: 'r2', turn: 't2', prompt: 'book a table for four on friday',
      tools: ['mail.send', 'acme/invoice-book', 'acme/ledger-post'],
    });
    const before = await f.caseStore.listAll();
    expect(before).toHaveLength(2);
    const target = before[0]!;
    const survivor = before[1]!;

    const result = await f.compiler.forgetCase(target.case_id);
    expect(result.cases_remaining).toBe(1);
    await f.compiler.rebuild();
    expect((await f.caseStore.listAll()).map((row) => row.case_id))
      .toEqual([survivor.case_id]);
  });

  it('reports an unknown case as nothing to forget, not as an error', async () => {
    const f = fixture();
    await acceptedTurn(f, { root: 'r1', turn: 't1' });
    const result = await f.compiler.forgetCase('case_does_not_exist');
    expect(result).toMatchObject({
      removed: false, reports: 0, observations: 0, feedback: 0,
    });
    // ⚠ And it left the corpus alone — a no-op prune that rebuilt anyway would
    // be the most expensive nothing in the system.
    expect(result.cases_remaining).toBe(1);
    expect(await f.caseStore.listAll()).toHaveLength(1);
  });
});

describe('D-219 — the retrieval gate: what counts as relevant', () => {
  /** Drive one turn's retrieval and report whether a card was composed. */
  const retrieve = async (
    f: ReturnType<typeof fixture>,
    turn: string,
    query: string,
    observe?: (d: ExecutionCasePrecedentObservation) => void,
  ) => {
    await openTurn(f, { root: `root-${turn}`, turn });
    const { ctx, state } = promptCtx(turn, query);
    await createExecutionCasePrecedentSource(
      () => (observe ? { ...f.deps, observe } : f.deps),
    ).prompt!(ctx);
    return readExecutionCasePrecedentContext(state);
  };

  it('⛔ a shared FUNCTION WORD is not relevance', async () => {
    // MEASURED, and this is the case that motivated the filter: against a
    // 5-case corpus, 7 of 8 topically unrelated prompts were shown a card, and
    // reading the overlap terms showed every one of those matches was made of
    // function words — `the` x18, `is` x3, `to` x3 — with not a single content
    // word among them. `overlap * 2` against a floor of 2 means one shared
    // token clears the bar exactly, and `is` is a shared token.
    const f = fixture();
    await acceptedTurn(f, { root: 'r1', turn: 't1' });   // "send the quarterly report to the customer"

    // Shares `the` and `to` with the stored request, and nothing else.
    expect(await retrieve(f, 't2', 'What is the weather forecast, and do I need to pack a coat?'))
      .toBeUndefined();
  });

  it('…and a shared CONTENT word still is — the permitting witness', async () => {
    // ⛔ WITHOUT THIS the test above passes against a scorer that refuses
    // everything, which is the same shape of vacuous pass this arc has already
    // shipped once. One content word is deliberately still enough: the floor
    // stays at 2 and recall stays the priority — the change is WHICH terms
    // count, not how many.
    const f = fixture();
    await acceptedTurn(f, { root: 'r1', turn: 't1' });
    const found = await retrieve(f, 't2', 'Has the customer replied about anything?');
    expect(found?.cards).toHaveLength(1);
  });

  it('⛔ "both texts contain an email address" is not relevance either', async () => {
    // `slotFit` compares entity KINDS and never values, so on its own it says
    // only that both texts happen to contain an address. At 3 points that
    // cleared the floor of 2 unaided. Measured before the fix: a stored "Email
    // orla@cardglen.example regarding quarterly renewal paperwork" scored 5
    // against "Ping wren@elsewhere.example about tomorrow morning football",
    // and the SAME probe with the address removed scored null — the address was
    // the entire match.
    // ⚠ THE TWO DOMAINS MUST DIFFER. A first version used `@cardglen.example`
    // and `@elsewhere.example`; `segmentExecutionCaseText` splits an address, so
    // the shared `example` TLD was a genuine CONTENT-word overlap and the probe
    // attached for a reason that had nothing to do with the slot kind it exists
    // to test.
    const f = fixture();
    await acceptedTurn(f, {
      root: 'r1', turn: 't1',
      prompt: 'Email orla@cardglen.example regarding quarterly renewal paperwork',
    });
    expect(await retrieve(
      f, 't2', 'Ping wren@othersite.invalid about tomorrow morning football',
    )).toBeUndefined();
  });

  it('…but an entity kind still BOOSTS a real lexical match', async () => {
    // The permitting witness for the slot gate: kind agreement is kept as a
    // ranking signal, because two requests that both name an address really are
    // more alike than two that do not. It simply cannot ATTACH a card alone.
    const stored = analyzeExecutionCaseRequest(
      'Email orla@cardglen.example regarding quarterly renewal paperwork',
    ).request_shape!;
    const row = {
      case_id: 'c1', request_shape: stored, flows: [{ stale: false }],
      last_seen_at: 1,
    } as never;
    const withSlot = scoreExecutionCaseRelevance(
      'Email wren@othersite.invalid regarding renewal paperwork', row,
    );
    const withoutSlot = scoreExecutionCaseRelevance(
      'Chase up the renewal paperwork', row,
    );
    // Both match lexically; the one that also agrees on entity kind ranks above
    // it. Asserted as an ordering, not a magic number, so the weight can move.
    expect(withSlot).toBeGreaterThan(withoutSlot!);
  });

  /** A stored case carrying exactly the shape a prompt would produce. */
  const rowFor = (request: string) => ({
    case_id: 'c1',
    request_shape: analyzeExecutionCaseRequest(request).request_shape!,
    flows: [{ stale: false }],
    last_seen_at: 1,
  }) as never;

  it('⛔ a COPULA is glue too — the term the shipped list omitted', async () => {
    // ⚠ SCORER-LEVEL DELIBERATELY. Stage 1 (`lexicalCandidateScore > 0`) runs
    // BEFORE ranking, so a middleware test whose probe shares nothing with the
    // stored prompt never reaches the scorer at all and would pin the candidate
    // filter while appearing to pin this. The behaviour changed here lives in
    // the scorer, so it is asserted there.
    //
    // This is the measured case verbatim: `INTENT_GROUNDING_GLUE` was tuned for
    // intent GROUNDING, where a verb never carried the label, so it contains
    // `it`, `in` and `the` but NOT `is` — and *"What is the weather forecast
    // for Tokyo?"* retrieved a contact-lookup case on that one word.
    const row = rowFor('Who is our Cardglen contact and have they written to us');
    // Shares exactly one term with the stored request: the copula.
    expect(scoreExecutionCaseRelevance('What is the weather forecast for Tokyo?', row))
      .toBeNull();
    // The permitting witness — a real shared word still scores.
    expect(scoreExecutionCaseRelevance('Has Cardglen written to us?', row))
      .toBeGreaterThan(0);
  });

  it('⛔ an entity KIND cannot clear the floor with no lexical match', async () => {
    // The reachable shape for the slot gate, and it is NOT "shares nothing":
    // stage 1 admits any lexical overlap INCLUDING glue, so a candidate can
    // reach ranking on `the` alone. Ungated, `slotFit` then contributed 3 —
    // above the floor of 2 — on the strength of both texts containing an
    // address, which is not evidence about either address.
    const stored = 'Email orla@cardglen.example regarding the renewal paperwork';
    const row = rowFor(stored);
    expect(analyzeExecutionCaseRequest(stored).request_shape!.entity_slots)
      .toEqual([{ role: 'entity_1', kind: 'email' }]);
    const probe = 'Ping wren@othersite.invalid about the football';
    // Non-vacuity: the probe really does present the same slot kind, so a
    // surviving match would genuinely be the kind agreement and not a fixture
    // that failed to set the condition up.
    expect(analyzeExecutionCaseRequest(probe).request_shape!.entity_slots)
      .toEqual([{ role: 'entity_1', kind: 'email' }]);
    expect(scoreExecutionCaseRelevance(probe, row)).toBeNull();
  });

  it('counts what retrieval did, including the turns that showed nothing', async () => {
    // ⛔ `ranked` is counted BEFORE the early return. Counting only successful
    // attachments would make every deployment report a 100% attach rate, which
    // is precisely the number this exists to make visible — the filter is
    // language-bound and fails OPEN, so an unlisted language degrades in
    // silence unless the residual is observable.
    const f = fixture();
    await acceptedTurn(f, { root: 'r1', turn: 't1' });
    const seen: ExecutionCasePrecedentObservation[] = [];
    const observe = (d: ExecutionCasePrecedentObservation) => { seen.push(d); };

    await retrieve(f, 't2', 'Has the customer replied about anything?', observe);
    await retrieve(f, 't3', 'What is the weather forecast, and do I need to pack a coat?', observe);

    expect(seen).toEqual([
      // one shared content word (`customer`) — the weakest match that attaches
      { ranked: 1, attached: 1, single_term_cards: 1 },
      // ranked, and correctly showed nothing
      { ranked: 1, attached: 0, single_term_cards: 0 },
    ]);
  });

  it('a failing counter never costs the turn', async () => {
    // Diagnostics are advisory. The middleware already wraps its body, but a
    // reporting hook that can take down a chat turn is the class of contract
    // that gets written in a comment and not enforced.
    const f = fixture();
    await acceptedTurn(f, { root: 'r1', turn: 't1' });
    const found = await retrieve(
      f, 't2', 'Has the customer replied about anything?',
      () => { throw new Error('diagnostics exploded'); },
    );
    expect(found?.cards).toHaveLength(1);
  });
});

describe('D-219 — the draft is built from ONE turn, not stitched from two', () => {
  const obs = (over: {
    id: string; basis?: string; tools?: string[]; at: number;
  }) => ({
    session_id: `s_${over.id}`,
    root_request: `request ${over.id}`,
    flow_basis: over.basis ?? 'executed',
    flow_pattern: {
      tool_sequence: over.tools ?? ['recipe.run', 'mail.send'],
      recipe_refs: [{ recipe_id: `recipe_${over.id}`, recipe_hash: 'h' }],
    },
    observed_at: over.at,
  });

  it('⛔⛔ takes the NEWEST matching observation, not the first one iterated', () => {
    // ⛔ Report iteration is lexical, so "first match" is arbitrary — while the
    // flow on screen is chosen by weight then RECENCY. Returning the first match
    // is how a draft ended up with one turn's request beside another's recipe,
    // billed to the owner.
    const chosen = selectOriginObservation(
      [obs({ id: 'old', at: 100 }), obs({ id: 'new', at: 900 })],
      { flow_basis: 'executed', tool_sequence: ['recipe.run', 'mail.send'] } as never,
    );
    expect(chosen?.session_id).toBe('s_new');
  });

  it('⛔ narrows on flow_basis too — same tools from a different basis is not a match', () => {
    const chosen = selectOriginObservation(
      [obs({ id: 'proposed_only', basis: 'proposed', at: 900 }),
        obs({ id: 'right', basis: 'executed', at: 100 })],
      { flow_basis: 'executed', tool_sequence: ['recipe.run', 'mail.send'] } as never,
    );
    expect(chosen?.session_id).toBe('s_right');
  });

  it('falls back to the newest observation when nothing matches', () => {
    // ⚠ The permitting witness. An origin from a DIFFERENT flow still gives the
    // draft the owner's request, which beats drafting from shape alone — so this
    // must NOT return undefined just because the flow disagrees.
    const chosen = selectOriginObservation(
      [obs({ id: 'a', tools: ['mail.search'], at: 100 }),
        obs({ id: 'b', tools: ['mail.search'], at: 900 })],
      { flow_basis: 'executed', tool_sequence: ['recipe.run'] } as never,
    );
    expect(chosen?.session_id).toBe('s_b');
  });

  it('returns undefined only when there is nothing at all', () => {
    expect(selectOriginObservation([], undefined)).toBeUndefined();
  });
});
