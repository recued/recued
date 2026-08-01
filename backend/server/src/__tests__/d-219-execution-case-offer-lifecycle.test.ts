/** D-219 slice 9c — WHEN the offer is raised, and what becomes of one nobody
 *  answers.
 *
 *  Driven end to end through the real compiler, the real stores and the real
 *  feedback rpc — a stubbed decision would pre-decide the thing under test. The
 *  notification block is the one fake, and it models the contract this depends
 *  on: an ask is durable, `cancelAsk` retires only an OPEN one, and an answer
 *  re-dispatches by handler kind.
 */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { InternalToolRegistry, ToolEntry, ToolTier } from '@recued/contracts';

import { createExecutionCaseCompiler } from '../execution-case-compiler.js';
import { createExecutionCaseFeedbackRecorder } from '../execution-case-feedback.js';
import { createExecutionCaseLifecycle } from '../chat-execution-case-tools.js';
import {
  createExecutionCaseFinalizerSource,
  EXECUTION_CASE_FINALIZER_MIDDLEWARE_ID,
} from '../chat-execution-case-finalizer.js';
import { createChatStreamMiddlewares } from '../chat-stream-middleware.js';
import { composeExecutionCases } from '../composition/bin/wire-execution-cases.js';
import {
  createExecutionCaseOfferLifecycle,
  executionCaseOfferEnabled,
  type ExecutionCaseOfferLifecycle,
  type ExecutionCaseOfferNotifier,
} from '../execution-case-offer-lifecycle.js';
import { EXECUTION_CASE_OFFER_ASK_KIND } from '../execution-case-offer.js';
import {
  executionCaseKey,
  requestShapeHash,
  type CaseSourceObservation,
} from '../execution-case-core.js';
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
  for (let i = 0; i < key.length; i += 1) key[i] = (i * 7 + 3) & 0xff;
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
  // ⚠ V22 — a fixture needs THREE distinct NON-core rounds to be admissible, and
  // an op the registry does not know has no tier at all, which empties
  // `tool_tiers` and refuses just as firmly.
  {
    name: 'acme/invoice-book', tier: 2, description: 'file an invoice',
    arg_schema: {}, topic_tags: ['billing'], classification: 'write',
    risk_tier: 'write', concurrency_safe: false,
  },
  {
    name: 'acme/ledger-post', tier: 2, description: 'post to the ledger',
    arg_schema: {}, topic_tags: ['billing'], classification: 'write',
    risk_tier: 'write', concurrency_safe: false,
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
    /** V20 — the tool-loop round. V22 admission measures depth in rounds, so a
     *  fixture that omits it carries an EMPTY `round_ordinals`, reads as "cannot
     *  judge", and raises no offer at all. */
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

interface FakeAsk {
  ask_id: string;
  handler_kind: string;
  handler_payload: Record<string, unknown>;
  options: ReadonlyArray<{ id: string; label: string }>;
  status: 'open' | 'answered' | 'cancelled';
}

/** The notification block's contract, as much of it as this depends on. */
const fakeNotifier = () => {
  const asks = new Map<string, FakeAsk>();
  const handlers = new Map<
    string,
    (
      payload: Record<string, unknown>,
      answer: { option: string; answered_at: number },
    ) => void | Promise<void>
  >();
  let seq = 0;
  const notifier: ExecutionCaseOfferNotifier = {
    ask: async (_message, options, handler) => {
      seq += 1;
      const ask_id = `ask-${seq}`;
      asks.set(ask_id, {
        ask_id,
        handler_kind: handler.kind,
        handler_payload: handler.payload,
        options: options.map((option) => ({ ...option })),
        status: 'open',
      });
      return { ask_id };
    },
    cancelAsk: async (ask_id) => {
      const row = asks.get(ask_id);
      if (!row || row.status !== 'open') return 'not_open';
      row.status = 'cancelled';
      return 'cancelled';
    },
    listOpenAsks: async () =>
      [...asks.values()].filter((row) => row.status === 'open'),
    registerAskHandler: (kind, handler) => {
      handlers.set(kind, handler);
    },
  };
  return {
    notifier,
    asks,
    open: () => [...asks.values()].filter((row) => row.status === 'open'),
    /** Deliver an answer the way the block would — by handler kind. */
    answer: async (ask_id: string, option: string) => {
      const row = asks.get(ask_id);
      if (!row || row.status !== 'open') return;
      row.status = 'answered';
      await handlers.get(row.handler_kind)?.(
        row.handler_payload,
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

const fixture = (options: { withOfferSwitch?: boolean } = {}) => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  schema(db);
  const key = keyProvider();
  const anchorStore = createExecutionSpanAnchorStore(db, key);
  const reportStore = createExecutionReportStore(db, key);
  const caseStore = createExecutionCaseStore(db, key);
  const dissectionStore = createExecutionSpanDissectionStore(db, key);
  const interventionStore = createCaseInterventionStore(
    db, key, new TextEncoder().encode('offer-lifecycle-secret'),
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
  const notifications = fakeNotifier();
  // ⚠ THE SWITCH IS GENUINELY ABSENT unless a test asks for it. Wiring an
  // always-true getter by default would make "absent means ON" assert against a
  // WIRED switch returning true — a different claim, and the one the production
  // fail-toward rule does not rest on.
  let offerEnabled = true;
  const offers = createExecutionCaseOfferLifecycle({
    notifier: notifications.notifier,
    compiler,
    caseStore,
    feedback: feedbackRecorder,
    caseKeyOf,
    ...(options.withOfferSwitch
      ? { isOfferEnabled: () => offerEnabled }
      : {}),
  });
  offers.registerAnswerHandler();
  return {
    db, anchorStore, caseStore, compiler, lifecycle, feedbackRecorder,
    notifications, offers,
    /** No-op unless the fixture was built `{ withOfferSwitch: true }`. */
    setOfferEnabled: (value: boolean) => {
      offerEnabled = value;
    },
  };
};

/** One complete turn: a request, two distinct governed calls, finalization. */
const runTurn = async (
  f: ReturnType<typeof fixture>,
  input: { root: string; session?: string; turn: string; prompt?: string },
): Promise<void> => {
  const session = input.session ?? 's1';
  await f.anchorStore.openSpan({
    root_request_id: input.root,
    session_id: session,
    surface: 'chat',
    root_request: input.prompt ?? 'send the quarterly report to the customer',
    turn_id: input.turn,
    now: 100,
  });
  // ⚠ V22 — three distinct NON-core rounds, or admission refuses and every test
  // below reads as "the offer never fired" for a reason that has nothing to do
  // with its subject.
  addActivity(f.db, {
    id: `${input.root}-a`, at: 101, session, turn: input.turn,
    tool: 'acme/invoice-book', round: 0,
  });
  addActivity(f.db, {
    id: `${input.root}-b`, at: 102, session, turn: input.turn,
    tool: 'acme/ledger-post', round: 1,
  });
  addActivity(f.db, {
    id: `${input.root}-c`, at: 103, session, turn: input.turn,
    tool: 'mail.send', round: 2,
  });
  await f.lifecycle.finalizeTurn({ session_id: session, turn_id: input.turn });
};

describe('D-219 slice 9c — when the offer is raised', () => {
  it('asks about a turn that did real work, and the ask names that turn', async () => {
    const f = fixture();
    await runTurn(f, { root: 'r1', turn: 't1' });
    const raised = await f.offers.offerForTurn({
      session_id: 's1',
      turn_id: 't1',
    });
    expect(raised).not.toBeNull();
    const [ask] = f.notifications.open();
    expect(ask!.handler_kind).toBe(EXECUTION_CASE_OFFER_ASK_KIND);
    expect(ask!.handler_payload).toMatchObject({
      session_id: 's1',
      turn_id: 't1',
      root_request_id: 'r1',
    });
    // Every option is one the substrate would actually file.
    expect(ask!.options.map((option) => option.id))
      .toEqual(['accepted', 'corrected', 'rejected', 'undone']);
  });

  it('asks ONCE per span, however many turns the stream runs', async () => {
    // `update` fires per middleware turn. Nothing calls `requestContinue` on
    // today's chat path, so that is once per user message — but a stream that
    // ever ran several turns must not raise an ask per turn about one request.
    const f = fixture();
    await runTurn(f, { root: 'r1', turn: 't1' });
    const first = await f.offers.offerForTurn({ session_id: 's1', turn_id: 't1' });
    await f.offers.offerForTurn({ session_id: 's1', turn_id: 't1' });
    await f.offers.offerForTurn({ session_id: 's1', turn_id: 't1' });
    // ⚠ Counting OPEN asks is not enough, and a mutation proved it: dropping
    // the dedup makes each call cancel the previous ask and raise a fresh one,
    // which still leaves exactly one open — while delivering the owner three
    // notifications about one unchanged turn. The claim is that nothing was
    // RAISED again, so the count of asks ever minted is what must be asserted.
    expect(f.notifications.asks.size).toBe(1);
    expect(f.notifications.open().map((ask) => ask.ask_id))
      .toEqual([first!.ask_id]);
  });

  it('does not ask about a turn that did nothing', async () => {
    // No governed work ⇒ 9a records no observation ⇒ nothing to ask about. The
    // owner is never interrupted about a plain conversational turn.
    const f = fixture();
    await f.anchorStore.openSpan({
      root_request_id: 'quiet', session_id: 's1', surface: 'chat',
      root_request: 'what did I ask you yesterday', turn_id: 'tq', now: 100,
    });
    await f.lifecycle.finalizeTurn({ session_id: 's1', turn_id: 'tq' });
    expect(await f.offers.offerForTurn({ session_id: 's1', turn_id: 'tq' }))
      .toBeNull();
    expect(f.notifications.open()).toHaveLength(0);
  });

  it('does not ask again once a case already covers the shape', async () => {
    // The rate limiter, and it is principled rather than a cadence: the owner
    // answering a second time changes nothing.
    const f = fixture();
    await runTurn(f, { root: 'r1', turn: 't1' });
    const first = await f.offers.offerForTurn({ session_id: 's1', turn_id: 't1' });
    await f.notifications.answer(first!.ask_id, 'accepted');
    expect(await f.caseStore.listAll()).toHaveLength(1);

    // A second, identical request — same shape, same flow, new span.
    await runTurn(f, { root: 'r2', turn: 't2' });
    expect(await f.offers.offerForTurn({ session_id: 's1', turn_id: 't2' }))
      .toBeNull();
  });
});

describe('D-219 slice 9c — an offer nobody answers', () => {
  it('is retired by the owner\'s NEXT request, not by a clock', async () => {
    const f = fixture();
    await runTurn(f, { root: 'r1', turn: 't1' });
    const raised = await f.offers.offerForTurn({ session_id: 's1', turn_id: 't1' });
    expect(f.notifications.open()).toHaveLength(1);

    // The next user message opens a fresh root — that, and only that, is what
    // says the owner moved on. §4.2 forbids deriving it from elapsed time.
    await f.anchorStore.openSpan({
      root_request_id: 'r2', session_id: 's1', surface: 'chat',
      root_request: 'now book the follow-up call', turn_id: 't2', now: 200,
    });
    expect(await f.offers.retireSupersededOffers({
      session_id: 's1',
      turn_id: 't2',
    })).toBe(1);
    expect(f.notifications.open()).toHaveLength(0);
    expect(f.notifications.asks.get(raised!.ask_id)!.status).toBe('cancelled');
  });

  it('SURVIVES the turns of its own span — the witness the rule permits', async () => {
    // ⛔ The case that separates "retires what the owner moved past" from
    // "retires everything". A tool-loop turn of the SAME request resolves to
    // the same root, and cancelling there would kill the ask before the owner
    // ever saw the answer it is asking about.
    const f = fixture();
    await runTurn(f, { root: 'r1', turn: 't1' });
    await f.offers.offerForTurn({ session_id: 's1', turn_id: 't1' });
    expect(f.anchorStore.anchorTurn({
      root_request_id: 'r1', session_id: 's1', turn_id: 't1-continued',
      origin_turn_id: 't1', now: 150,
    })).toBe(true);
    expect(await f.offers.retireSupersededOffers({
      session_id: 's1',
      turn_id: 't1-continued',
    })).toBe(0);
    expect(f.notifications.open()).toHaveLength(1);
  });

  it('keeps an offer when the new turn has no resolvable span', async () => {
    // Fail-safe direction: an unresolvable turn says nothing about whether the
    // owner moved on, and a wrongly-cancelled ask loses an answer for good.
    const f = fixture();
    await runTurn(f, { root: 'r1', turn: 't1' });
    await f.offers.offerForTurn({ session_id: 's1', turn_id: 't1' });
    expect(await f.offers.retireSupersededOffers({
      session_id: 's1',
      turn_id: 'never-anchored',
    })).toBe(0);
    expect(f.notifications.open()).toHaveLength(1);
  });

  it('leaves another session\'s offer alone', async () => {
    const f = fixture();
    await runTurn(f, { root: 'r1', turn: 't1' });
    await f.offers.offerForTurn({ session_id: 's1', turn_id: 't1' });
    await runTurn(f, { root: 'r-other', session: 's2', turn: 't-other' });
    expect(await f.offers.retireSupersededOffers({
      session_id: 's2',
      turn_id: 't-other',
    })).toBe(0);
    expect(f.notifications.open()).toHaveLength(1);
  });
});

describe('D-219 slice 9c — the answer completes the loop', () => {
  it('routes the owner\'s verdict into the EXISTING feedback rpc, and a case forms', async () => {
    // ⛔ THE POINT OF THE WHOLE ARC, asserted end to end. Before 9a this turn
    // recorded nothing; before 9c nothing asked. An owner acceptance is firm
    // evidence, so one answer admits — nothing else in the corpus would.
    const f = fixture();
    await runTurn(f, { root: 'r1', turn: 't1' });
    expect(await f.caseStore.listAll()).toEqual([]);

    const raised = await f.offers.offerForTurn({ session_id: 's1', turn_id: 't1' });
    await f.notifications.answer(raised!.ask_id, 'accepted');

    const cases = await f.caseStore.listAll();
    expect(cases).toHaveLength(1);
    expect(cases[0]!.outcome_strength.evidence_families)
      .toContain('typed_acceptance');
    expect(cases[0]!.flows[0]!.user_acceptances).toBe(1);
  });

  it('records a CORRECTION as a correction, not as an acceptance', async () => {
    const f = fixture();
    await runTurn(f, { root: 'r1', turn: 't1' });
    const raised = await f.offers.offerForTurn({ session_id: 's1', turn_id: 't1' });
    await f.notifications.answer(raised!.ask_id, 'corrected');
    const cases = await f.caseStore.listAll();
    expect(cases).toHaveLength(1);
    expect(cases[0]!.outcome_strength).toMatchObject({
      positive: 0,
      negative: 1,
    });
    expect(cases[0]!.flows[0]!.user_corrections).toBe(1);
  });

  it('records NOTHING for an option outside the feedback vocabulary', async () => {
    // The payload is persisted JSON that outlives the code that wrote it, so
    // the option is re-checked here rather than trusted.
    const f = fixture();
    await runTurn(f, { root: 'r1', turn: 't1' });
    const raised = await f.offers.offerForTurn({ session_id: 's1', turn_id: 't1' });
    await f.notifications.answer(raised!.ask_id, 'dismiss');
    expect(await f.caseStore.listAll()).toEqual([]);
  });
});

describe('D-219 slice 9c — the owner\'s switch', () => {
  it('resolves the roster OFF-ANYWHERE-WINS, and an empty roster is ON', () => {
    // The pref is per-INSTANCE but the ask is raised once for the whole server,
    // so the roster is collapsed in the QUIET direction: a device that declined
    // the question silences it everywhere. Wrongly asking trains away the one
    // signal the arc depends on; wrongly staying quiet costs a case the owner
    // can recreate by doing the work again.
    expect(executionCaseOfferEnabled([])).toBe(true);
    expect(executionCaseOfferEnabled([undefined])).toBe(true);
    expect(executionCaseOfferEnabled([{}])).toBe(true);
    expect(executionCaseOfferEnabled([
      { 'chat.execution_case_offer': true },
      { 'chat.execution_case_offer': true },
    ])).toBe(true);
    // ⛔ One device off ⇒ off, even when every other device wants it.
    expect(executionCaseOfferEnabled([
      { 'chat.execution_case_offer': true },
      { 'chat.execution_case_offer': false },
      { 'chat.execution_case_offer': true },
    ])).toBe(false);
    // A device that has never written the key is not an opt-out.
    expect(executionCaseOfferEnabled([
      {},
      { 'chat.execution_case_offer': true },
    ])).toBe(true);
  });

  it('is ON by default — an unwired switch must not silence the ask', async () => {
    // ⚠ THE FAIL-TOWARD DIRECTION, asserted rather than assumed. A composition
    // that forgets to wire the switch keeps asking; a silenced ask looks exactly
    // like a working one until someone notices the corpus never grew.
    const f = fixture();               // built with no `isOfferEnabled`
    await runTurn(f, { root: 'r1', turn: 't1' });
    expect(await f.offers.offerForTurn({ session_id: 's1', turn_id: 't1' }))
      .not.toBeNull();
  });

  it('OFF stops the raise and leaves the retirement running', async () => {
    // ⛔ THE ASYMMETRY IS THE POINT. An ask raised while the switch was on is
    // still open after it goes off, and the retirement path is the only thing
    // that closes it — gating both would strand it forever.
    const f = fixture({ withOfferSwitch: true });
    await runTurn(f, { root: 'r1', turn: 't1' });
    const raised = await f.offers.offerForTurn({ session_id: 's1', turn_id: 't1' });
    expect(raised).not.toBeNull();

    f.setOfferEnabled(false);

    // A second span, now that the owner has switched the question off.
    await runTurn(f, { root: 'r2', turn: 't2' });
    expect(await f.offers.offerForTurn({ session_id: 's1', turn_id: 't2' }))
      .toBeNull();
    expect(f.notifications.asks.size).toBe(1);
    // …and the one raised BEFORE the switch is still retired by the next turn.
    expect(await f.offers.retireSupersededOffers({
      session_id: 's1',
      turn_id: 't2',
    })).toBe(1);
    expect(f.notifications.open()).toHaveLength(0);
  });

  it('reads the switch LIVE, so a toggle applies to the next turn', async () => {
    const f = fixture({ withOfferSwitch: true });
    f.setOfferEnabled(false);
    await runTurn(f, { root: 'r1', turn: 't1' });
    expect(await f.offers.offerForTurn({ session_id: 's1', turn_id: 't1' }))
      .toBeNull();

    f.setOfferEnabled(true);
    await runTurn(f, { root: 'r2', turn: 't2' });
    expect(await f.offers.offerForTurn({ session_id: 's1', turn_id: 't2' }))
      .not.toBeNull();
  });
});

describe('D-219 slice 9c — the seams that carry it', () => {
  it('the composer builds nothing until a notification block is published', async () => {
    // ⛔ A CALL SITE IS NOT A WIRED SEAM. The lifecycle and the middleware can
    // both be right while nothing connects them, so the composition is asserted
    // here rather than assumed from the two unit tests above.
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
    expect(composed.getExecutionCaseOfferLifecycle()).toBeUndefined();

    const notifications = fakeNotifier();
    const registered: string[] = [];
    composed.publishExecutionCaseOfferNotifier({
      ...notifications.notifier,
      registerAskHandler: (kind, handler) => {
        registered.push(kind);
        notifications.notifier.registerAskHandler(kind, handler);
      },
    });
    expect(composed.getExecutionCaseOfferLifecycle()).toBeDefined();
    // The ANSWER route registers at publish, not at the first live turn: boot
    // recovery re-dispatches answered-but-unhandled asks exactly once, so a
    // verdict given while the server was down would otherwise be dropped.
    expect(registered).toEqual([EXECUTION_CASE_OFFER_ASK_KIND]);

    // Idempotent — a second publish must not register a second handler for the
    // same kind, which would record the owner's one verdict twice.
    composed.publishExecutionCaseOfferNotifier(notifications.notifier);
    expect(registered).toEqual([EXECUTION_CASE_OFFER_ASK_KIND]);
  });

  it('the chat stream builds the finalizer WITH its offer halves', async () => {
    // Before 9c the finalizer had no `prompt` hook at all, so its presence is
    // the seam: the retirement half only runs if the stream composed it.
    const retired: string[] = [];
    const middlewares = createChatStreamMiddlewares({
      getExecutionCaseLifecycle: () => ({ finalizeTurn: async () => {} } as never),
      getExecutionCaseOfferLifecycle: (): ExecutionCaseOfferLifecycle => ({
        retireSupersededOffers: async (input) => {
          retired.push(input.turn_id);
          return 0;
        },
        offerForTurn: async () => null,
        registerAnswerHandler: () => {},
      }),
      now: () => 0,
    } as never);
    const finalizer = middlewares.find((middleware) =>
      middleware.id === EXECUTION_CASE_FINALIZER_MIDDLEWARE_ID);
    expect(finalizer?.prompt).toBeDefined();
    await finalizer!.prompt!({
      session_id: 's1',
      turn_id: 't-wired',
      state: new Map(),
    } as never);
    expect(retired).toEqual(['t-wired']);
  });
});

describe('D-219 slice 9c — the middleware that runs it', () => {
  const turnCtx = (session_id: string, turn_id: string) =>
    ({ session_id, turn_id, state: new Map<string, unknown>() });

  it('retires before the turn and offers after it', async () => {
    const calls: string[] = [];
    const offers = {
      retireSupersededOffers: async () => {
        calls.push('retire');
        return 0;
      },
      offerForTurn: async () => {
        calls.push('offer');
        return null;
      },
      registerAnswerHandler: () => {},
    } satisfies ExecutionCaseOfferLifecycle;
    const middleware = createExecutionCaseFinalizerSource(
      () => ({
        finalizeTurn: async () => {
          calls.push('finalize');
        },
      } as never),
      () => offers,
    );
    await middleware.prompt?.(turnCtx('s1', 't1') as never);
    await middleware.update?.(turnCtx('s1', 't1') as never);
    // ⛔ The offer is decided from the observation finalization just recorded,
    // so the order is load-bearing, not incidental.
    expect(calls).toEqual(['retire', 'finalize', 'offer']);
  });

  it('is a faithful no-op when no offer lifecycle is wired', async () => {
    let finalized = 0;
    const middleware = createExecutionCaseFinalizerSource(() => ({
      finalizeTurn: async () => {
        finalized += 1;
      },
    } as never));
    await middleware.prompt?.(turnCtx('s1', 't1') as never);
    await middleware.update?.(turnCtx('s1', 't1') as never);
    expect(finalized).toBe(1);
  });

  it('never lets a failing offer cost the turn', async () => {
    // Advisory end to end (#13/#23): a notification failure must not surface as
    // a chat failure. Finalization still ran.
    let finalized = 0;
    const middleware = createExecutionCaseFinalizerSource(
      () => ({
        finalizeTurn: async () => {
          finalized += 1;
        },
      } as never),
      () => ({
        retireSupersededOffers: async () => {
          throw new Error('notification channel down');
        },
        offerForTurn: async () => {
          throw new Error('notification channel down');
        },
        registerAnswerHandler: () => {},
      }),
    );
    await expect(middleware.prompt?.(turnCtx('s1', 't1') as never))
      .resolves.toBeUndefined();
    await expect(middleware.update?.(turnCtx('s1', 't1') as never))
      .resolves.toBeUndefined();
    expect(finalized).toBe(1);
  });
});
