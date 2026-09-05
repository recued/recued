/** Tool results become durable, recallable rows — the `role: 'tool'` class that
 *  has been declared since 2026-05-11 with no writer.
 *
 *  ⛔⛔ THE GAP DOC'S STATED BLOCKER WAS COST, AND IT WAS HYPOTHETICAL. It read
 *  "100 tool calls in one turn is 100 encrypted rows, and tool results are far
 *  larger than chat turns". Measured across 29,256 real results in 14,107
 *  stored bench packets: p50 **2** calls per turn, p90 4, p99 9, max **21**;
 *  result bytes p50 490, p90 1,585. The second half is true (a chat row is p50
 *  66 bytes, so a result is ~7x one) but the first is off by an order of
 *  magnitude — a median turn writes two ~490-byte rows.
 *
 *  ⛔ OWNER CORPUS ONLY, and that is the policy call this pins. A contracted
 *  turn's tool results contain OWNER-warehouse data. The customer already sees
 *  it once, in its own turn, so a durable row is not new disclosure — it is new
 *  DURABILITY and SEARCHABILITY, and `recall.search` is lexical over the whole
 *  corpus, so a stored copy would let a customer probe for owner data across
 *  every result its recipes ever returned. */
import Database from 'better-sqlite3';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionSource } from '@recued/contracts';
import {
  CHAT_MESSAGE_RECALL_ELIGIBILITY,
  createChatStore,
  ensureChatSchema,
  type ChatStore,
} from '../storage/chat-store.js';
import { createRecallSearchBackend } from '../chat-recall-search.js';
import { isReadClassifiedTool } from '../chat-tool-row.js';
import { TIER1_CLASSIFICATIONS } from '@recued/contracts';
import {
  buildPriorToolPointers,
  renderToolRow,
  elideLongArgumentValues,
  toolCallSignatureFromRow,
  toolNameFromRow,
} from '../chat-orchestrator.js';
import { isNonTerminalToolResult } from '../chat-turn-executor.js';

const OWNER_SCOPE = {
  governing_contract_id: 'user_self',
  row_eligibility: CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT,
  recall_contract_id: null,
} as const;

const ownerSource = (session_id: string): ExecutionSource => ({
  channel: 'chat', actor: 'user_self', chat_session_id: session_id, user_id: 'local',
});
const doorSource = (session_id: string): ExecutionSource => ({
  channel: 'chat', actor: 'contracted_user',
  chat_session_id: session_id, user_id: 'customer', contract_id: 'door-alice',
} as ExecutionSource);

describe('tool results are recallable', () => {
  let db: Database.Database;
  let store: ChatStore;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureChatSchema(db);
    store = createChatStore(db);
    store.createSession({ id: 'prior', now: 1_000 });
  });
  afterEach(() => db.close());

  const appendTool = async (source: ExecutionSource, content: string) =>
    store.appendMessage({
      id: `t-${content.length}-${Math.random()}`,
      session_id: 'prior',
      role: 'tool',
      content,
      target_server: 'self',
      picker_at_send: { current: 'self' },
      model_used: { provider: 'openai', model_id: 'm' },
      execution_source: source,
      ts: 2_000,
      // ⚠ REQUIRED NOW. The scan admits tool rows only from the session's two
      // most recent TURNS, so a row with no turn is reachable by nothing.
      turn_id: 't1',
    } as never);

  it('⛔ a tool row is FOUND by recall — the whole point of the row class', async () => {
    await appendTool(
      ownerSource('prior'),
      'recipe.run: {"rows":[{"subject":"Fairview lease renewal"}]}',
    );
    const backend = createRecallSearchBackend(store);
    const got = await backend.search({
      query: { text: 'fairview lease', terms: ['fairview', 'lease'] },
      scope: OWNER_SCOPE,
      // ⛔ REQUIRED FOR A TOOL ROW. They are TASK context and a task lives in a
      // session, so a search that cannot name its session reaches none of them
      // — fail-closed by plain SQL `=` against NULL, not by a branch.
      tool_session_id: 'prior',
    });
    expect(got.matches.length).toBeGreaterThan(0);
    expect(got.matches[0]?.content).toContain('Fairview');
  });

  it('⛔ the TOOL NAME is searchable, not only the payload', async () => {
    // Recall is lexical. A body that is only the serialized result is findable
    // by the data it happened to contain and by nothing else — naming the tool
    // makes the row findable by the ACT too.
    // ⚠ An EFFECT tool, because a read's row is deliberately withheld now —
    // see the snapshot-gate tests below. The property under test (the NAME is
    // searchable, not just the payload) is unchanged by that.
    await appendTool(ownerSource('prior'), 'recued-core/mail-post: {"rows":[]}');
    const backend = createRecallSearchBackend(store);
    const got = await backend.search({
      // ⚠ ONE token: the index splits on punctuation, so neither
      // `recued-core/mail-post` nor `mail-post` matches as a whole.
      query: { text: 'post', terms: ['post'] },
      scope: OWNER_SCOPE,
      // ⛔ REQUIRED FOR A TOOL ROW. They are TASK context and a task lives in a
      // session, so a search that cannot name its session reaches none of them
      // — fail-closed by plain SQL `=` against NULL, not by a branch.
      tool_session_id: 'prior',
    });
    expect(got.matches.length).toBeGreaterThan(0);
  });

  it('⛔⛔ a DOOR-written tool row is NOT in the owner corpus', async () => {
    // Defence in depth: the orchestrator does not write these at all for a
    // contracted turn, and if one ever arrives the eligibility stamp keeps it
    // out of the owner's corpus regardless.
    await appendTool(doorSource('prior'), 'recipe.run: {"rows":["owner secret"]}');
    const backend = createRecallSearchBackend(store);
    const got = await backend.search({
      query: { text: 'owner secret', terms: ['owner', 'secret'] },
      scope: OWNER_SCOPE,
      // ⛔ REQUIRED FOR A TOOL ROW. They are TASK context and a task lives in a
      // session, so a search that cannot name its session reaches none of them
      // — fail-closed by plain SQL `=` against NULL, not by a branch.
      tool_session_id: 'prior',
    });
    expect(got.matches).toHaveLength(0);
  });

  it('⛔ tool rows stay OUT of the chat tail', async () => {
    // `listRecentConversational` wants three CONVERSATIONAL rows, and a tool
    // result is ~7x a chat row: admitting them would evict the conversation
    // from a tail sized for conversation.
    await appendTool(ownerSource('prior'), 'recipe.run: {"rows":[]}');
    const tail = await store.listRecentConversational('prior', 10);
    expect(tail.every((m) => m.role !== 'tool')).toBe(true);
  });
});

/** D-259 decoupled dispatch from completion, and that breaks the assumption a
 *  tool row rests on: that the result in hand IS the outcome. */
describe('a held run is acknowledged, not answered', () => {
  it('⛔⛔ THE REAL DISPATCH ENVELOPE — captured from a live held run', () => {
    // ⛔ THIS IS THE SHAPE THE FIRST CUT GOT WRONG, and every unit test passed
    // because the fixtures were written from the same wrong assumption as the
    // code. `awaiting_approval` does NOT sit on the top level: the engine
    // returns `{ ok, result: {…awaiting_approval…}, run_held, run_id }`, so a
    // check on the outer object never fired and a held run was stored WITH the
    // "queued" projection as its result. Bench task
    // `331-d137-held-run-settle-recallable` found it on its first honest run;
    // this fixture is copied from that capture.
    expect(isNonTerminalToolResult({
      ok: true,
      result: {
        status: 'awaiting_approval',
        awaiting_approval: true,
        recipe_id: 'canary-mail-send',
        message: 'This action is paused and is now queued…',
      },
      run_held: { kind: 'approval' },
      run_id: '20260904T112913211-w2gmw4',
    })).toBe(true);
  });

  it('⛔ `run_held` alone is enough — it is the ENGINE\'s marker', () => {
    // `awaiting_approval` is what the model is shown; `run_held` is what the
    // engine says. Reading both means a change to either shape degrades to
    // "do not store a result", which is the safe direction.
    expect(isNonTerminalToolResult({ ok: true, run_held: { kind: 'approval' } }))
      .toBe(true);
  });

  it('⛔⛔ an awaiting_approval projection is NOT a terminal result', () => {
    // ⚠ ASSERTED UNCONDITIONALLY. The first version wrapped these in
    // `if (isNonTerminalToolResult)` after a dynamic import — so a missing
    // export would have passed silently, which is the failure this whole file
    // is about in miniature.
    //
    // The row would say "queued", and recall would later return it as the
    // ANSWER to whatever the model asked. `projectRunResultForAgent` sets this
    // marker precisely so an agent does not read a pause as a failure; storing
    // it as an outcome undoes that at a longer range.
    expect(isNonTerminalToolResult({
      status: 'awaiting_approval', awaiting_approval: true, recipe_id: 'r',
    })).toBe(true);
  });

  it('⛔⛔ A HOLD WITH NO RUN ID STILL STORES NO RESULT', () => {
    // Held-ness and pairability are two questions, and folding them into one
    // is what let a run-id-less hold store its acknowledgement as the answer.
    // `isNonTerminalToolResult` alone decides whether a result is stored; the
    // run id only decides whether the halves can be joined later.
    expect(isNonTerminalToolResult({
      ok: true,
      result: { status: 'awaiting_approval', awaiting_approval: true },
      run_held: { kind: 'approval' },
      // no run_id
    })).toBe(true);
  });

  it('⚠ terminal results — including FAILURES — are recorded', () => {
    // "It failed" is a true answer, and a later turn asking "did that send go
    // out" deserves to find it.
    expect(isNonTerminalToolResult({ ok: true, matches: [] })).toBe(false);
    expect(isNonTerminalToolResult({ ok: false, reason: 'execution_error' }))
      .toBe(false);
    expect(isNonTerminalToolResult(null)).toBe(false);
    expect(isNonTerminalToolResult(undefined)).toBe(false);
    expect(isNonTerminalToolResult('awaiting_approval')).toBe(false);
    // ⛔ The marker must be the BOOLEAN `true`, not merely present — a result
    // carrying `awaiting_approval: false` is terminal.
    expect(isNonTerminalToolResult({ awaiting_approval: false })).toBe(false);
  });
});

/** ⛔⛔ ONE ROW PER EVENT, NOT PER CALL — and the pair is what makes a
 *  two-event call representable without a dishonest timestamp.
 *
 *  A synchronous tool call is ONE event: ask and answer at one instant, so one
 *  row carrying both halves. A HELD dispatch is TWO, at times that genuinely
 *  differ, and storing that as one row forces the single `ts` to be either
 *  chronologically honest or cursor-safe. Two rows, each with one unambiguous
 *  time, dissolves the trade — and pairing them means a keyword match on
 *  either returns both. */
describe('paired tool rows', () => {
  let pdb: Database.Database;
  let pstore: ChatStore;

  beforeEach(() => {
    pdb = new Database(':memory:');
    ensureChatSchema(pdb);
    pstore = createChatStore(pdb);
    pstore.createSession({ id: 'prior', now: 1_000 });
  });
  afterEach(() => pdb.close());

  const append = async (
    id: string, content: string, ts: number,
    over: Record<string, unknown> = {},
  ) => pstore.appendMessage({
    id, session_id: 'prior', role: 'tool', content,
    target_server: 'self', picker_at_send: { current: 'self' },
    model_used: { provider: 'openai', model_id: 'm' },
    execution_source: ownerSource('prior'), ts, turn_id: 't1', ...over,
  } as never);

  // ⚠ THE NEEDLES ARE SINGLE ALPHANUMERIC TOKENS ON PURPOSE. The recall
  // matcher works over a NORMALIZED body, and a needle carrying punctuation —
  // `pat@acme.test`, `XZ-9` — is split by that normalization and matches
  // nothing, so the first version of these tests failed on their own fixtures
  // rather than on the code. Nonsense words also guarantee the hit is the row
  // and not incidental prose.
  it('⛔ matching the ARGS returns the outcome too', async () => {
    await append('d1', 'recipe.run({"to":"quintaskell"})', 2_000, { pair_id: 'run-1' });
    await append('r1', 'recipe.run: {"sent":true,"receipt":"zorbulate"}', 9_000, { pair_id: 'run-1' });
    const backend = createRecallSearchBackend(pstore);
    const got = await backend.search({
      query: { text: 'quintaskell', terms: ['quintaskell'] },
      scope: OWNER_SCOPE,
      // ⛔ REQUIRED FOR A TOOL ROW. They are TASK context and a task lives in a
      // session, so a search that cannot name its session reaches none of them
      // — fail-closed by plain SQL `=` against NULL, not by a branch.
      tool_session_id: 'prior',
    });
    const ids = got.matches.map((m) => m.item_id);
    expect(ids).toContain('d1');
    expect(ids).toContain('r1');
  });

  it('⛔ matching the OUTCOME returns what was asked for', async () => {
    await append('d2', 'recipe.run({"to":"quintaskell"})', 2_000, { pair_id: 'run-2' });
    await append('r2', 'recipe.run: {"sent":true,"receipt":"zorbulate"}', 9_000, { pair_id: 'run-2' });
    const backend = createRecallSearchBackend(pstore);
    const got = await backend.search({
      query: { text: 'zorbulate', terms: ['zorbulate'] },
      scope: OWNER_SCOPE,
      // ⛔ REQUIRED FOR A TOOL ROW. They are TASK context and a task lives in a
      // session, so a search that cannot name its session reaches none of them
      // — fail-closed by plain SQL `=` against NULL, not by a branch.
      tool_session_id: 'prior',
    });
    const ids = got.matches.map((m) => m.item_id);
    expect(ids).toContain('r2');
    expect(ids).toContain('d2');
  });

  it('⚠ a dispatch with no result yet returns ALONE — truthfully', async () => {
    // "Asked, not yet answered" is a true answer. This is the state a held run
    // sits in, and it is why the dispatch row is written without a result
    // rather than with the `awaiting_approval` projection standing in for one.
    await append('d3', 'recipe.run({"to":"quintaskell"})', 2_000, { pair_id: 'run-3' });
    const backend = createRecallSearchBackend(pstore);
    const got = await backend.search({
      query: { text: 'quintaskell', terms: ['quintaskell'] },
      scope: OWNER_SCOPE,
      // ⛔ REQUIRED FOR A TOOL ROW. They are TASK context and a task lives in a
      // session, so a search that cannot name its session reaches none of them
      // — fail-closed by plain SQL `=` against NULL, not by a branch.
      tool_session_id: 'prior',
    });
    expect(got.matches.map((m) => m.item_id)).toEqual(['d3']);
  });

  it('⛔ a row matching BOTH halves is not returned twice', async () => {
    await append('d4', 'recipe.run({"query":"fairview"})', 2_000, { pair_id: 'run-4' });
    await append('r4', 'recipe.run: {"found":"fairview"}', 9_000, { pair_id: 'run-4' });
    const backend = createRecallSearchBackend(pstore);
    const got = await backend.search({
      query: { text: 'fairview', terms: ['fairview'] },
      scope: OWNER_SCOPE,
      // ⛔ REQUIRED FOR A TOOL ROW. They are TASK context and a task lives in a
      // session, so a search that cannot name its session reaches none of them
      // — fail-closed by plain SQL `=` against NULL, not by a branch.
      tool_session_id: 'prior',
    });
    const ids = got.matches.map((m) => m.item_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('⛔⛔ the pair fetch is SCOPED — it does not cross corpora', async () => {
    // A sibling fetch keyed on the pair id alone would return a row from any
    // corpus that shares a run id. `neighbours` shipped with exactly that
    // shape and it was a cross-tenant leak the moment a second corpus existed.
    await append('d5', 'recipe.run({"query":"fairview"})', 2_000, { pair_id: 'run-5' });
    await pstore.appendMessage({
      id: 'r5', session_id: 'prior', role: 'tool',
      content: 'recipe.run: {"secret":"fairview owner data"}',
      target_server: 'self', picker_at_send: { current: 'self' },
      model_used: { provider: 'openai', model_id: 'm' },
      execution_source: doorSource('prior'),
      ts: 9_000, turn_id: 't1', pair_id: 'run-5',
    } as never);
    const backend = createRecallSearchBackend(pstore);
    const got = await backend.search({
      query: { text: 'fairview', terms: ['fairview'] },
      scope: OWNER_SCOPE,
      // ⛔ REQUIRED FOR A TOOL ROW. They are TASK context and a task lives in a
      // session, so a search that cannot name its session reaches none of them
      // — fail-closed by plain SQL `=` against NULL, not by a branch.
      tool_session_id: 'prior',
    });
    const ids = got.matches.map((m) => m.item_id);
    expect(ids).toContain('d5');
    expect(ids).not.toContain('r5');
  });
});

/** The settle hook — the result half written when a HELD run finally finishes.
 *
 *  ⛔⛔ THIS IS THE HALF THAT COULD NOT EXIST BEFORE. The turn that dispatched
 *  a held run ends with only the ask recorded; the answer arrives later, from
 *  the preflight resumer, and until now nothing carried it back. The resumer
 *  recovers the ORIGINATING `execution_source` off the paused audit anchor —
 *  which is what makes the row land in the corpus of whoever ASKED rather than
 *  whoever approved. */
describe('a settled run writes the result half', () => {
  it('⛔ pairs with its dispatch row and is found by either', async () => {
    const db2 = new Database(':memory:');
    ensureChatSchema(db2);
    const store2 = createChatStore(db2);
    store2.createSession({ id: 'prior', now: 1_000 });

    // T1 — the turn dispatched a run and recorded only the ask.
    await store2.appendMessage({
      id: 'ask', session_id: 'prior', role: 'tool',
      content: 'acme/send-invoice({"customer":"quintaskell"})',
      target_server: 'self', picker_at_send: { current: 'self' },
      model_used: { provider: 'openai', model_id: 'm' },
      execution_source: ownerSource('prior'), ts: 2_000,
      turn_id: 't1', pair_id: 'run-77',
    } as never);

    // T2 — the run settles, hours later. This is what the sink writes.
    await store2.appendMessage({
      id: 'settle:run-77', session_id: 'prior', role: 'tool',
      content: 'acme/send-invoice: {"sent":true,"ref":"zorbulate"}',
      target_server: 'self', picker_at_send: { current: 'self' },
      model_used: { provider: 'recued', model_id: 'run-settled' },
      execution_source: ownerSource('prior'), ts: 99_000,
      turn_id: 't1', pair_id: 'run-77',
    } as never);

    const backend = createRecallSearchBackend(store2);
    // Asking about what was REQUESTED now finds the outcome too.
    const byAsk = await backend.search({
      query: { text: 'quintaskell', terms: ['quintaskell'] }, scope: OWNER_SCOPE,
      tool_session_id: 'prior',
    });
    expect(byAsk.matches.map((m) => m.item_id)).toEqual(
      expect.arrayContaining(['ask', 'settle:run-77']),
    );
    // And asking about the OUTCOME finds what was requested.
    const byResult = await backend.search({
      query: { text: 'zorbulate', terms: ['zorbulate'] }, scope: OWNER_SCOPE,
      tool_session_id: 'prior',
    });
    expect(byResult.matches.map((m) => m.item_id)).toEqual(
      expect.arrayContaining(['ask', 'settle:run-77']),
    );
    db2.close();
  });

  it('⚠ the two halves keep their OWN times — that is the point of the split', async () => {
    const db3 = new Database(':memory:');
    ensureChatSchema(db3);
    const store3 = createChatStore(db3);
    store3.createSession({ id: 'prior', now: 1_000 });
    await store3.appendMessage({
      id: 'ask2', session_id: 'prior', role: 'tool',
      content: 'acme/send-invoice({"customer":"quintaskell"})',
      target_server: 'self', picker_at_send: { current: 'self' },
      model_used: { provider: 'openai', model_id: 'm' },
      execution_source: ownerSource('prior'), ts: 2_000,
      turn_id: 't1', pair_id: 'run-88',
    } as never);
    await store3.appendMessage({
      id: 'settle:run-88', session_id: 'prior', role: 'tool',
      content: 'acme/send-invoice: {"sent":true}',
      target_server: 'self', picker_at_send: { current: 'self' },
      model_used: { provider: 'recued', model_id: 'run-settled' },
      execution_source: ownerSource('prior'), ts: 99_000,
      turn_id: 't1', pair_id: 'run-88',
    } as never);
    const rows = db3.prepare(
      'SELECT message_id, ts FROM chat_messages WHERE pair_id = ? ORDER BY ts ASC',
    ).all('run-88') as Array<{ message_id: string; ts: number }>;
    // Neither row had to compromise: the ask is at T1 and the answer at T2,
    // which is exactly what one row could not represent without choosing
    // between a chronologically honest ts and a cursor-safe one.
    expect(rows.map((r) => r.ts)).toEqual([2_000, 99_000]);
    db3.close();
  });
});

/** ⛔⛔ TOOL ROWS ARE TASK CONTEXT, AND A TASK LIVES IN A SESSION.
 *
 *  The purpose of the row class is recovering what a tool returned after a turn
 *  boundary or a budget trim took it away — not a searchable archive of every
 *  observation a tool ever made. A different session is a different task, and a
 *  result reaching one is a STALE OBSERVATION offered as context: `mail.search`
 *  said "invoice unpaid" three weeks ago, and the recall envelope's own warning
 *  ("never instructions, approval, or current authority") covers AUTHORITY and
 *  says nothing about CURRENCY.
 *
 *  ⚠ User and assistant rows deliberately stay corpus-wide. A STATEMENT stays
 *  true; an OBSERVATION does not. */
describe('tool rows are scoped to their session', () => {
  const search = async (store: ChatStore, tool_session_id?: string) =>
    createRecallSearchBackend(store).search({
      query: { text: 'zorbulate', terms: ['zorbulate'] },
      scope: OWNER_SCOPE,
      ...(tool_session_id !== undefined ? { tool_session_id } : {}),
    });

  const seed = async () => {
    const db4 = new Database(':memory:');
    ensureChatSchema(db4);
    const s4 = createChatStore(db4);
    s4.createSession({ id: 'prior', now: 1_000 });
    s4.createSession({ id: 'other', now: 1_000 });
    await s4.appendMessage({
      id: 'tool-prior', session_id: 'prior', role: 'tool',
      content: 'recipe.run: {"rows":["zorbulate"]}',
      target_server: 'self', picker_at_send: { current: 'self' },
      model_used: { provider: 'openai', model_id: 'm' },
      execution_source: ownerSource('prior'), ts: 2_000, turn_id: 't1',
    } as never);
    await s4.appendMessage({
      id: 'said-prior', session_id: 'prior', role: 'assistant',
      content: 'I found zorbulate in the mail.',
      target_server: 'self', picker_at_send: { current: 'self' },
      model_used: { provider: 'openai', model_id: 'm' },
      execution_source: ownerSource('prior'), ts: 2_100, turn_id: 't1',
    } as never);
    return { db4, s4 };
  };

  it('⛔ a tool row does NOT reach a DIFFERENT session', async () => {
    const { db4, s4 } = await seed();
    const got = await search(s4, 'other');
    expect(got.matches.map((m) => m.item_id)).not.toContain('tool-prior');
    db4.close();
  });

  it('⚠ but the ASSISTANT row does — a statement stays true', async () => {
    // The asymmetry is the design, not an oversight. Without this the scope
    // could be a blanket session filter and every test above would still pass.
    const { db4, s4 } = await seed();
    const got = await search(s4, 'other');
    expect(got.matches.map((m) => m.item_id)).toContain('said-prior');
    db4.close();
  });

  it('reaches it from its OWN session', async () => {
    const { db4, s4 } = await seed();
    const got = await search(s4, 'prior');
    expect(got.matches.map((m) => m.item_id)).toContain('tool-prior');
    db4.close();
  });

  it('⛔ NO session named ⇒ no tool row at all, by SQL not by a branch', async () => {
    const { db4, s4 } = await seed();
    const got = await search(s4);
    expect(got.matches.map((m) => m.item_id)).not.toContain('tool-prior');
    expect(got.matches.map((m) => m.item_id)).toContain('said-prior');
    db4.close();
  });
});

/** ⛔⛔ TWO TURNS, NOT THE WHOLE SESSION. A session can run for days, so the
 *  session bound alone still lets a turn-2 CRM snapshot surface at turn 40 — a
 *  stale observation offered as current context. Two turns covers both
 *  documented needs exactly: the in-turn trim, and "at the next turn, none of
 *  the retrieved data". */
describe('tool rows are bounded to the two most recent turns', () => {
  const seedTurns = async () => {
    const db5 = new Database(':memory:');
    ensureChatSchema(db5);
    const s5 = createChatStore(db5);
    s5.createSession({ id: 'prior', now: 1_000 });
    // Four turns, each leaving one tool row naming a distinct token.
    for (const [turn, token, ts] of [
      ['t1', 'oldestone', 1_000], ['t2', 'oldertwo', 2_000],
      ['t3', 'recentthree', 3_000], ['t4', 'newestfour', 4_000],
    ] as const) {
      await s5.appendMessage({
        id: `tool-${turn}`, session_id: 'prior', role: 'tool',
        content: `recipe.run: {"rows":["${token}"]}`,
        target_server: 'self', picker_at_send: { current: 'self' },
        model_used: { provider: 'openai', model_id: 'm' },
        execution_source: ownerSource('prior'), ts, turn_id: turn,
      } as never);
    }
    return { db5, s5 };
  };

  const find = async (store: ChatStore, term: string) =>
    (await createRecallSearchBackend(store).search({
      query: { text: term, terms: [term] },
      scope: OWNER_SCOPE,
      tool_session_id: 'prior',
    })).matches.length;

  it('reaches the two most recent turns', async () => {
    const { db5, s5 } = await seedTurns();
    expect(await find(s5, 'newestfour')).toBeGreaterThan(0);
    expect(await find(s5, 'recentthree')).toBeGreaterThan(0);
    db5.close();
  });

  it('⛔ does NOT reach further back', async () => {
    const { db5, s5 } = await seedTurns();
    expect(await find(s5, 'oldertwo')).toBe(0);
    expect(await find(s5, 'oldestone')).toBe(0);
    db5.close();
  });

  it('⛔ the PAIR fetch is EXEMPT — a late settle still arrives with its ask', async () => {
    // The window governs what can be FOUND; the pair governs what comes WITH
    // it. A held run that settles many turns later carries its ORIGINATING
    // turn, so without the exemption it would be born already outside the
    // window and the answer would be unreachable while the ask was not.
    const { db5, s5 } = await seedTurns();
    await s5.appendMessage({
      id: 'ask-old', session_id: 'prior', role: 'tool',
      content: 'recipe.run({"q":"newestfour"})',
      target_server: 'self', picker_at_send: { current: 'self' },
      model_used: { provider: 'openai', model_id: 'm' },
      execution_source: ownerSource('prior'), ts: 4_100,
      turn_id: 't4', pair_id: 'run-late',
    } as never);
    await s5.appendMessage({
      id: 'settle:run-late', session_id: 'prior', role: 'tool',
      content: 'recipe.run: {"quinzoral":true}',
      target_server: 'self', picker_at_send: { current: 'self' },
      model_used: { provider: 'recued', model_id: 'run-settled' },
      execution_source: ownerSource('prior'), ts: 4_200,
      turn_id: 't1', pair_id: 'run-late',
    } as never);
    const got = await createRecallSearchBackend(s5).search({
      query: { text: 'newestfour', terms: ['newestfour'] },
      scope: OWNER_SCOPE, tool_session_id: 'prior',
    });
    const ids = got.matches.map((m) => m.item_id);
    expect(ids).toContain('ask-old');
    // Its turn (`t1`) is outside the window; it arrives via the pair anyway.
    expect(ids).toContain('settle:run-late');
    db5.close();
  });
});

/** ⛔⛔ EACH CORPUS IS WINDOWED BY ITS OWN TURNS.
 *
 *  The outer predicate already keeps a door from READING an owner row — that is
 *  P10 and it holds. But the two-most-recent-turns subquery is a separate
 *  question: computed across every row in the session, one corpus's turns
 *  decide the other's window. No row leaks, so nothing fails loudly; the door
 *  simply stops finding its OWN recent tool rows because the owner has been
 *  talking more. A silent under-reach that looks like "recall found nothing". */
describe('the turn window is per-corpus', () => {
  it('⛔ a busier corpus in the same session does not consume the other’s window', async () => {
    const db6 = new Database(':memory:');
    ensureChatSchema(db6);
    const s6 = createChatStore(db6);
    s6.createSession({ id: 'shared', now: 1_000 });
    const put = async (
      id: string, turn: string, ts: number, token: string, src: ExecutionSource,
    ) => s6.appendMessage({
      id, session_id: 'shared', role: 'tool',
      content: `recipe.run: {"rows":["${token}"]}`,
      target_server: 'self', picker_at_send: { current: 'self' },
      model_used: { provider: 'openai', model_id: 'm' },
      execution_source: src, ts, turn_id: turn,
    } as never);

    // The door's own tool row, then TWO later owner turns in the same session.
    await put('door-row', 'dt1', 1_000, 'kwenzalor', doorSource('shared'));
    await put('owner-a', 'ot1', 2_000, 'ownerfirst', ownerSource('shared'));
    await put('owner-b', 'ot2', 3_000, 'ownersecond', ownerSource('shared'));

    const got = await createRecallSearchBackend(s6).search({
      query: { text: 'kwenzalor', terms: ['kwenzalor'] },
      scope: {
        governing_contract_id: 'door-alice',
        row_eligibility: 'chat:not_owner_authenticated',
        recall_contract_id: 'door-alice',
      } as never,
      tool_session_id: 'shared',
    });
    // `dt1` is the door's most recent turn — its ONLY one. The two owner turns
    // are newer, and if the window is computed over the whole session they take
    // both slots and the door's own row falls out.
    expect(got.matches.map((m) => m.item_id)).toContain('door-row');
    db6.close();
  });

  /** Two DIFFERENT doors. Same eligibility bucket, different contract ids --
   *  so only the contract filter separates them. */
  it('⛔ a busier SIBLING DOOR does not consume this door’s window', async () => {
    const db7 = new Database(':memory:');
    ensureChatSchema(db7);
    const s7 = createChatStore(db7);
    s7.createSession({ id: 'shared', now: 1_000 });
    const put = async (
      id: string, turn: string, ts: number, token: string, contract: string,
    ) => s7.appendMessage({
      id, session_id: 'shared', role: 'tool',
      content: `recipe.run: {"rows":["${token}"]}`,
      target_server: 'self', picker_at_send: { current: 'self' },
      model_used: { provider: 'openai', model_id: 'm' },
      execution_source: {
        channel: 'chat', actor: 'contracted_user',
        chat_session_id: 'shared', user_id: 'customer', contract_id: contract,
      } as unknown as ExecutionSource,
      ts, turn_id: turn,
    } as never);

    await put('alice-row', 'at1', 1_000, 'kwenzalor', 'door-alice');
    await put('bob-a', 'bt1', 2_000, 'bobfirst', 'door-bob');
    await put('bob-b', 'bt2', 3_000, 'bobsecond', 'door-bob');

    const got = await createRecallSearchBackend(s7).search({
      query: { text: 'kwenzalor', terms: ['kwenzalor'] },
      scope: {
        governing_contract_id: 'door-alice',
        row_eligibility: CHAT_MESSAGE_RECALL_ELIGIBILITY.UNAUTHENTICATED_CHAT,
        recall_contract_id: 'door-alice',
      } as never,
      tool_session_id: 'shared',
    });
    expect(got.matches.map((m) => m.item_id)).toContain('alice-row');
    db7.close();
  });

  /** ⚠ The owner and a CONTRACT-FREE non-owner dispatch BOTH stamp a null
   *  contract id (chat-store.ts's own note: "the owner corpus plus any
   *  non-owner contract-free dispatch"). Nothing but the eligibility bucket
   *  tells those two apart, so this is the case the contract filter cannot
   *  cover on its own. */
  it('⛔ a busier CONTRACT-FREE NON-OWNER does not consume the owner’s window', async () => {
    const db8 = new Database(':memory:');
    ensureChatSchema(db8);
    const s8 = createChatStore(db8);
    s8.createSession({ id: 'shared', now: 1_000 });
    const put = async (
      id: string, turn: string, ts: number, token: string, actor: string,
    ) => s8.appendMessage({
      id, session_id: 'shared', role: 'tool',
      content: `recipe.run: {"rows":["${token}"]}`,
      target_server: 'self', picker_at_send: { current: 'self' },
      model_used: { provider: 'openai', model_id: 'm' },
      execution_source: {
        channel: 'chat', actor, chat_session_id: 'shared', user_id: 'local',
      } as unknown as ExecutionSource,
      ts, turn_id: turn,
    } as never);

    await put('owner-row', 'ot1', 1_000, 'kwenzalor', 'user_self');
    // Contract-free, but NOT the owner -- same null contract id.
    await put('other-a', 'xt1', 2_000, 'otherfirst', 'contracted_user');
    await put('other-b', 'xt2', 3_000, 'othersecond', 'contracted_user');

    const got = await createRecallSearchBackend(s8).search({
      query: { text: 'kwenzalor', terms: ['kwenzalor'] },
      scope: OWNER_SCOPE as never,
      tool_session_id: 'shared',
    });
    expect(got.matches.map((m) => m.item_id)).toContain('owner-row');
    db8.close();
  });
});


// ── pointer-arm fixtures ────────────────────────────────────────────────────
// A session with a PREVIOUS turn (mail.search) and a CURRENT turn
// (recall.search), so "points at what left the packet, not at what is in it"
// is expressible.
const pointerDb = new Database(':memory:');
ensureChatSchema(pointerDb);
const pointerStore = createChatStore(pointerDb);
const pointerDefs = {
  // The owner resolver only needs to NOT claim a governing contract here; the
  // owner sentinel path is what an owner chat source resolves to.
  get: () => undefined,
  isRevoked: () => false,
} as unknown as Parameters<typeof buildPriorToolPointers>[1];
pointerStore.createSession({ id: 'ptr', now: 1_000 });
const seedPointerRow = async (
  id: string, turn: string, ts: number, name: string,
) => pointerStore.appendMessage({
  id, session_id: 'ptr', role: 'tool',
  content: renderToolRow(name, { q: 'x' }, { ok: true }),
  target_server: 'self', picker_at_send: { current: 'self' },
  model_used: { provider: 'openai', model_id: 'm' },
  execution_source: ownerSource('ptr'), ts, turn_id: turn,
} as never);


/** ⛔ THE POINTER ARM (D-213). A pointer is a PROMISE that recall can fetch the
 *  thing it names. Every test here exists to stop that promise being broken in
 *  a way that is silent at the call site and only visible as "the model searched
 *  and found nothing", which reads to the model as an empty store. */
describe('prior-tool pointers', () => {
  beforeAll(async () => {
    // THREE turns, so one is genuinely outside the two-turn window.
    await seedPointerRow('p-old', 'turn-old', 1_500, 'calendar.search');
    await seedPointerRow('p-prev', 'turn-prev', 2_000, 'mail.search');
    await seedPointerRow('p-now', 'turn-now', 3_000, 'recall.search');
  });

  it('⛔ the name parser round-trips the renderer, for every shape it emits', () => {
    // Not three hand-written strings: the renderer is the authority, so drive
    // it and read back. A format change breaks this without anyone editing it.
    for (const [name, args, result] of [
      ['bench/send-email', { to: 'a@b.test', body: 'hi' }, { ok: true }],
      ['recall.search', { query: 'x' }, undefined],
      ['memory.write', {}, undefined],
      ['recipe.run', { recipe_id: 'r', config: { a: 1 } }, { ok: true }],
    ] as const) {
      expect(toolNameFromRow(renderToolRow(name, args, result))).toBe(name);
    }
  });

  it('⛔ refuses a row it cannot parse rather than guessing a name', () => {
    expect(toolNameFromRow('')).toBeUndefined();
    expect(toolNameFromRow('some prose that is not a tool row')).toBeUndefined();
  });

  it('⛔ is OFF unless the flag is set — the control arm is the default', async () => {
    const before = process.env.RECUED_CHAT_TOOL_POINTERS;
    delete process.env.RECUED_CHAT_TOOL_POINTERS;
    const got = await buildPriorToolPointers(
      pointerStore, pointerDefs, ownerSource('ptr'), 'ptr', 'turn-now',
    );
    expect(got).toBeUndefined();
    if (before !== undefined) process.env.RECUED_CHAT_TOOL_POINTERS = before;
  });

  it('names an earlier turn’s tool, and NOT the current turn’s', async () => {
    process.env.RECUED_CHAT_TOOL_POINTERS = '1';
    try {
      const got = await buildPriorToolPointers(
        pointerStore, pointerDefs, ownerSource('ptr'), 'ptr', 'turn-now',
      );
      // `mail.search` ran in the previous turn — absent from the packet, so
      // worth pointing at. `recall.search` ran in THIS turn and is already in
      // `prior_tool_calls`; pointing at it competes with the content itself.
      expect(got?.calls.map((c) => c.tool)).toContain('mail.search');
      expect(got?.calls.map((c) => c.tool)).not.toContain('recall.search');
      // ⛔⛔ AND NOT THE OUT-OF-WINDOW TURN. This is the load-bearing one:
      //   `getRecallMessage` is NOT window-bound (corpus + session only, the
      //   same exemption the pair fetch takes), so an `item_id` handle resolves
      //   whatever it names. The window is therefore enforced HERE or nowhere —
      //   advertise an out-of-window row and the pointer quietly re-opens the
      //   staleness bound that the two-turn window exists to hold.
      expect(got?.calls.map((c) => c.tool)).not.toContain('calendar.search');
    } finally { delete process.env.RECUED_CHAT_TOOL_POINTERS; }
  });

  it('⛔⛔ never advertises a row the SCAN cannot reach — one window, two readers', async () => {
    process.env.RECUED_CHAT_TOOL_POINTERS = '1';
    try {
      const pointed = await buildPriorToolPointers(
        pointerStore, pointerDefs, ownerSource('ptr'), 'ptr', undefined,
      );
      // Every HANDLE the pointer advertises must resolve through the exact
      // lookup recall actually offers. If the pointer window and the scan
      // window ever drift apart, this fails naming the row it over-promised.
      expect(pointed?.calls.length).toBeGreaterThan(0);
      for (const call of pointed?.calls ?? []) {
        const got = await pointerStore.getRecallMessage?.({
          row_eligibility: OWNER_SCOPE.row_eligibility,
          recall_contract_id: OWNER_SCOPE.recall_contract_id,
          tool_session_id: 'ptr',
          item_id: call.item_id,
        } as never);
        expect(got?.readable, `pointer advertised ${call.tool}`).toBe(true);
      }
    } finally { delete process.env.RECUED_CHAT_TOOL_POINTERS; }
  });
});

/** ⛔⛔ THE HELD-RUN SHAPE, WHICH IS THE ONLY ONE THAT MATTERS FOR THE ARM.
 *  A held dispatch is TWO rows: the ask (args, no result) and the answer
 *  (result, no args). The BODY the model needs lives in the ask half. */
describe('pointers over a paired (held) dispatch', () => {
  it('⛔ advertises the DISPATCH half, not only the settle half', async () => {
    process.env.RECUED_CHAT_TOOL_POINTERS = '1';
    const db9 = new Database(':memory:');
    ensureChatSchema(db9);
    const s9 = createChatStore(db9);
    s9.createSession({ id: 'pair', now: 1_000 });
    const put = async (
      id: string, turn: string, ts: number, content: string, pair: string,
    ) => s9.appendMessage({
      id, session_id: 'pair', role: 'tool', content, pair_id: pair,
      target_server: 'self', picker_at_send: { current: 'self' },
      model_used: { provider: 'openai', model_id: 'm' },
      execution_source: ownerSource('pair'), ts, turn_id: turn,
    } as never);
    // The ask carries the composed body; the answer carries only the receipt.
    await put('a:tool:0', 't1', 2_000,
      renderToolRow('bench/send-email', { to: 'x@y.test', body: 'THE NOTE' }, undefined),
      'run-1');
    await put('settle:1', 't1', 2_100,
      renderToolRow('send-email', undefined, { ok: true, To: 'x@y.test' }),
      'run-1');
    try {
      const got = await buildPriorToolPointers(
        s9, pointerDefs, ownerSource('pair'), 'pair', 't2',
      );
      const ids = (got?.calls ?? []).map((c) => c.item_id);
      expect(ids, 'settle half advertised').toContain('settle:1');
      expect(ids, 'DISPATCH half advertised').toContain('a:tool:0');
    } finally { delete process.env.RECUED_CHAT_TOOL_POINTERS; db9.close(); }
  });
});

/** ⛔⛔ AN EXACT FETCH RETURNS BOTH HALVES, LIKE A SEARCH DOES.
 *  The pointer hands the model an `item_id`; if that returns only the half it
 *  names, WHICH half is luck. Measured on a live drive before this held: the
 *  model fetched a settle row, received `To`/`Subject` with no body, and
 *  confidently re-sent different text -- a broken promise that reads at every
 *  layer as a successful retrieval. */
describe('exact fetch honours the pair', () => {
  it('⛔ fetching the ANSWER half also returns the ASK half (which holds the args)', async () => {
    const dbA = new Database(':memory:');
    ensureChatSchema(dbA);
    const sA = createChatStore(dbA);
    sA.createSession({ id: 'ex', now: 1_000 });
    const put = async (id: string, ts: number, content: string) =>
      sA.appendMessage({
        id, session_id: 'ex', role: 'tool', content, pair_id: 'run-9',
        target_server: 'self', picker_at_send: { current: 'self' },
        model_used: { provider: 'openai', model_id: 'm' },
        execution_source: ownerSource('ex'), ts, turn_id: 't1',
      } as never);
    await put('ask-9', 2_000,
      renderToolRow('bench/send-email', { body: 'ZANTHILLOW' }, undefined));
    await put('ans-9', 2_100,
      renderToolRow('send-email', undefined, { ok: true, To: 'x@y.test' }));

    const got = await createRecallSearchBackend(sA).fetchExact(
      'ans-9', OWNER_SCOPE as never, 'ex',
    );
    expect(got.status).toBe('ok');
    const ids = got.status === 'ok'
      ? [got.match.item_id, ...(got.siblings ?? []).map((c) => c.item_id)]
      : [];
    expect(ids, 'the ask half came back with the answer').toContain('ask-9');
    dbA.close();
  });
});

/** ⛔ THE NEUTRAL ARM'S SIGNATURE SPLIT. It must drop the RESULT and keep the
 *  whole argument JSON. A naive split on the first `): ` truncates mid-argument
 *  whenever the args contain a paren or a `": "` — both routine — and would put
 *  a half-quoted fragment of the caller's own data into the packet. */
describe('toolCallSignatureFromRow', () => {
  it('keeps the full call and drops the result, through the renderer', () => {
    for (const [name, args] of [
      ['memory.search', { query: 'window (UTC): the note' }],
      ['bench/send-email', { to: 'a@b.test', body: 'Ratio 3:1 (approx)' }],
      ['deal.search', { query: 'Northwind', limit: 5 }],
    ] as const) {
      const row = renderToolRow(name, args, { ok: true, rows: ['secret'] });
      const sig = toolCallSignatureFromRow(row);
      expect(sig).toBe(`${name}(${JSON.stringify(args)})`);
      expect(sig).not.toContain('secret');
    }
  });

  it('survives a row with no result and one with no args', () => {
    expect(toolCallSignatureFromRow(renderToolRow('recall.search', { q: 'x' }, undefined)))
      .toBe('recall.search({"q":"x"})');
    expect(toolCallSignatureFromRow(renderToolRow('tools.search', {}, undefined)))
      .toBe('tools.search');
  });
});

/** ⛔⛔ THE NEUTRAL ARM MUST NOT SHIP THE PAYLOAD BACK. A send's `body` IS the
 *  composed artifact, so an uncapped call rendering re-inlines the exact text
 *  the pointer exists to avoid carrying — measured live before the cap: the
 *  model reproduced a composed note without calling recall at all. */
describe('neutral pointer caps the arguments', () => {
  it('⛔ a long composed body does NOT survive into the pointer', async () => {
    process.env.RECUED_CHAT_TOOL_POINTERS = 'neutral';
    const dbN = new Database(':memory:');
    ensureChatSchema(dbN);
    const sN = createChatStore(dbN);
    sN.createSession({ id: 'neu', now: 1_000 });
    const secret = 'ZANTHILLOW the quick brown fox jumps over the lazy dog and keeps on running';
    await sN.appendMessage({
      id: 'n:tool:0', session_id: 'neu', role: 'tool',
      content: renderToolRow('bench/send-email',
        { to: 'a@b.test', subject: 'x', body: secret }, undefined),
      target_server: 'self', picker_at_send: { current: 'self' },
      model_used: { provider: 'openai', model_id: 'm' },
      execution_source: ownerSource('neu'), ts: 2_000, turn_id: 't1',
    } as never);
    try {
      const got = await buildPriorToolPointers(
        sN, pointerDefs, ownerSource('neu'), 'neu', 't2',
      );
      const rendered = JSON.stringify(got);
      expect(rendered).not.toContain('ZANTHILLOW');
      expect(rendered).toContain('bench/send-email');
      // The short values SURVIVE — that is the trade the cap is making, and a
      // pointer that elided everything would name no more than the tool.
      expect(rendered).toContain('a@b.test');
    } finally { delete process.env.RECUED_CHAT_TOOL_POINTERS; dbN.close(); }
  });
});

describe('neutral pointer keeps what makes it informative', () => {
  it('a READ’s query survives verbatim; only long values are elided', () => {
    const row = renderToolRow(
      'memory.search', { query: 'Kestrel rollout maintenance window' }, { memories: [] },
    );
    const sig = elideLongArgumentValues(toolCallSignatureFromRow(row));
    expect(sig).toBe('memory.search({"query":"Kestrel rollout maintenance window"})');
  });
});

/** ⛔⛔ THE TRIM MARKER MUST CARRY A HANDLE, AND THE HANDLE MUST RESOLVE.
 *
 *  This is the gap the whole D-213 arc narrowed to. Within a turn,
 *  `prior_tool_calls` already carries every result — until the trim ladder
 *  elides one, and then the model is mid-task holding
 *  `{llm_gateway_context_omitted: true}` with no way back. Recall could not
 *  serve it either, because tool rows were written at TURN END: the row did
 *  not exist yet. Persisting mid-turn is what makes the marker actionable.
 *
 *  ⚠ ORDERING IS A PII CONSTRAINT, not a preference — rows are stored
 *  PRE-ALIAS with the candidate list that lets recall re-alias them, and those
 *  candidates are harvested at the AI CALL. A result persisted the moment its
 *  tool returned would be stored beside a list that does not describe it. */
describe('mid-turn persistence makes a trimmed result fetchable', () => {
  it('⛔ the row written mid-turn is retrievable by the marker’s item_id', async () => {
    const dbM = new Database(':memory:');
    ensureChatSchema(dbM);
    const sM = createChatStore(dbM);
    sM.createSession({ id: 'mid', now: 1_000 });
    // What the mid-turn writer does, at the shape it does it.
    const item_id = 'assistant-1:tool:0';
    await sM.appendMessage({
      id: item_id, session_id: 'mid', role: 'tool',
      content: renderToolRow('recipe.run', { q: 'kestrel' }, { rows: ['XANTHORIL'] }),
      target_server: 'self', picker_at_send: { current: 'self' },
      model_used: { provider: 'openai', model_id: 'm' },
      execution_source: ownerSource('mid'), ts: 2_000, turn_id: 't1',
    } as never);

    // The model, handed only the marker, fetches by that id — mid-turn, in the
    // SAME turn the row was written.
    const got = await createRecallSearchBackend(sM).fetchExact(
      item_id, OWNER_SCOPE as never, 'mid',
    );
    expect(got.status).toBe('ok');
    expect(got.status === 'ok' ? got.match.content : '').toContain('XANTHORIL');
    dbM.close();
  });

  it('⛔ a handle for a row that was never written must not be invented', async () => {
    const dbM2 = new Database(':memory:');
    ensureChatSchema(dbM2);
    const sM2 = createChatStore(dbM2);
    sM2.createSession({ id: 'mid2', now: 1_000 });
    // The first composition of a fresh result cannot be persisted (no egress
    // pass yet), so its marker carries NO id. A marker that named a row anyway
    // would send the model to fetch something that does not exist, and an empty
    // fetch reads to a model as "nothing is stored".
    const got = await createRecallSearchBackend(sM2).fetchExact(
      'assistant-9:tool:3', OWNER_SCOPE as never, 'mid2',
    );
    expect(got.status).toBe('not_found');
    dbM2.close();
  });
});

/** ⛔⛔ THE SNAPSHOT GATE. A READ's stored result is a snapshot, and recall must
 *  not serve it: re-running the read is fresher, and it is what the model
 *  already does unprompted. Measured harm when it does not hold — a live drive
 *  had the model fetch a stored `memory.search` row and email a maintenance
 *  window that had already been changed, with every layer reporting success.
 *  EFFECT rows stay, because a send's composed body cannot be re-derived. */
describe('read-classified tool rows are withheld from recall', () => {
  const seedRow = async (
    s: ChatStore, session: string, id: string, content: string,
  ) => s.appendMessage({
    id, session_id: session, role: 'tool', content,
    target_server: 'self', picker_at_send: { current: 'self' },
    model_used: { provider: 'openai', model_id: 'm' },
    execution_source: ownerSource(session), ts: 2_000, turn_id: 't1',
  } as never);

  it('⛔ a READ row is not returned; an EFFECT row beside it is', async () => {
    const dbG = new Database(':memory:');
    ensureChatSchema(dbG);
    const sG = createChatStore(dbG);
    sG.createSession({ id: 'gate', now: 1_000 });
    await seedRow(sG, 'gate', 'r1', 'mail.search: {"rows":["quilverosa"]}');
    await seedRow(sG, 'gate', 'e1', 'recipe.run: {"rows":["quilverosa"]}');
    const got = await createRecallSearchBackend(sG).search({
      query: { text: 'quilverosa', terms: ['quilverosa'] },
      scope: OWNER_SCOPE as never,
      tool_session_id: 'gate',
    });
    const ids = got.matches.map((m) => m.item_id);
    expect(ids, 'effect row served').toContain('e1');
    expect(ids, 'read row withheld').not.toContain('r1');
    dbG.close();
  });

  it('⛔⛔ an item_id HANDLE does not walk past the gate', async () => {
    // The exact path resolves whatever it names, so a filter applied only to
    // search would be decoration: anything holding the id reaches the snapshot.
    const dbH = new Database(':memory:');
    ensureChatSchema(dbH);
    const sH = createChatStore(dbH);
    sH.createSession({ id: 'gate2', now: 1_000 });
    await seedRow(sH, 'gate2', 'r2', 'mail.search: {"rows":["quilverosa"]}');
    const got = await createRecallSearchBackend(sH).fetchExact(
      'r2', OWNER_SCOPE as never, 'gate2',
    );
    expect(got.status).toBe('not_found');
    dbH.close();
  });

  it('⛔ the predicate reads the SHIPPED table, so a copy cannot drift', () => {
    // Driven off `TIER1_CLASSIFICATIONS` itself: if a tool is reclassified, or
    // a new read tool is added, this follows without anyone editing a list.
    for (const [tool, kind] of Object.entries(TIER1_CLASSIFICATIONS)) {
      expect(isReadClassifiedTool(tool), tool).toBe(kind === 'read');
    }
    // `unknown` is NOT read — this is what keeps every Tier-2 send reachable.
    expect(isReadClassifiedTool('recipe.run')).toBe(false);
    expect(isReadClassifiedTool('bench/send-email')).toBe(false);
  });
});
