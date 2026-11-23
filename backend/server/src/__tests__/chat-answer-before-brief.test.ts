/** Real queue and Chat lifecycle, controlled model timing; no judgment score. */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { TIER1_TOOL_DESCRIPTORS, type InternalToolRegistry, type ToolEntry } from '@recued/contracts';
import { piiEgress } from '@recued/gateway';
import { createChatOrchestrator, type BroadcastChatEvent } from '../chat-orchestrator.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { withQueuedChatTurns } from '../chat-turn-queue.js';
import { createMetaFieldPrivacyResolverFromLocalManifestStore } from '../meta-field-privacy-resolver.js';
import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import { CANONICAL_PII_CATALOG_MANIFESTS, CANONICAL_PII_ENTITY_PRIVACY_TAGS, CANONICAL_PII_ENTITY_SCHEMAS } from '../canonical-pii-schemas.js';

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

/** One queued turn: read a mail, then answer. `blocked` holds the closing brief,
 * or, for `cancel-before-answer`, the final main model call. */
const startTurn = (mode: 'success' | 'failure' | 'empty-brief' | 'cancel' | 'cancel-before-answer', carry = false) => {
  const db = new Database(':memory:'); ensureChatSchema(db);
  // D-347 — the closing brief's own boundaries, so a store without the carry: a turn that did tool
  //   work closes with a fold, as before the carry. D-343: `carry` keeps it, for a newer turn to take
  //   the brief over.
  const full = createChatStore(db);
  const { readSessionCarry: _read, writeSessionCarry: _write, deleteSessionCarry: _delete, ...bare } = full;
  const store = carry ? full : bare;
  const packets: Array<Record<string, unknown>> = [];
  store.createSession({ id: 'answer-before-brief' });
  // This fixture supplies Standard writer responses for its carry lifecycle.
  store.setRollingBriefEnabled(true);
  const blocked = gate();
  const executionFinished = gate();
  const events: BroadcastChatEvent[] = [];
  const sender = 'new.sender@outside.example';
  // With the carry, a source read: it may not ride raw, so the turn closes with a brief to take over.
  const tool = carry ? 'work.read' : 'mail.read';
  const catalog: ToolEntry[] = [{ ...TIER1_TOOL_DESCRIPTORS[tool], tier: 1 }];
  const registry: InternalToolRegistry = { list: () => catalog, listByTier: () => catalog,
    getByName: name => catalog.find(t => t.name === name) ?? null, subscribeRefresh: () => () => {},
    dispatch: async () => ({ ok: true, result: { body: 'Scope remains open.', hot_fields: { __entity: 'mail', from: sender } } }) };
  const calls = { main: 0, brief: 0 };
  const base = createChatOrchestrator({ chatStore: store, registry,
    piiLedgerStore: piiEgress.createSessionLedgerStore(),
    fieldPrivacyResolver: createMetaFieldPrivacyResolverFromLocalManifestStore(createLocalManifestStore(db),
      CANONICAL_PII_ENTITY_SCHEMAS, CANONICAL_PII_CATALOG_MANIFESTS, CANONICAL_PII_ENTITY_PRIVACY_TAGS),
    selfSignature: { server_kind: 'recued', version: 'test', instance_id: 'test' },
    broadcast: { emit: event => { events.push(event); } },
    executeAiCall: async (_manifest, input, opts) => {
      const packet = JSON.parse(String(input['llm.prompt']));
      expect(JSON.stringify(packet)).not.toContain(sender);
      if ('tool_results_since' in packet) {
        calls.brief++;
        // As a provider request does: it ends when its caller cancels it (D-343).
        await Promise.race([blocked.promise, new Promise((_, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new Error('LLM call was cancelled')), { once: true });
        })]);
        if (mode === 'failure') throw new Error('Controlled brief provider failure');
        if (mode === 'empty-brief' && calls.brief === 1) return { body: undefined };
        return { body: { intent: 'Explore scope', constraints: [], pending: [], findings: ['Scope remains open.'], completed: [] } };
      }
      calls.main++;
      packets.push(packet);
      const from = packet.prior_tool_calls?.[0]?.result?.hot_fields?.from;
      if (!carry && calls.main === 2) expect(from).toMatch(/^m\d+(?:\.[^@]+)?@d\d+\.invalid$/);
      if (mode === 'cancel-before-answer' && calls.main === 2) await blocked.promise;
      return { body: { response: calls.main === 1 ? 'Planning text must stay hidden.'
        : from ? `${from}: Scope remains open.` : 'Scope remains open.', events: [],
        tool_calls: calls.main === 1 ? [carry ? { tool, args: { kind: 'task', id: 't1' } } : { tool, args: { slug: 'work', record_id: 'mail:seed' } }] : [] } };
    },
  });
  const orchestrator = withQueuedChatTurns({ ...base, runTurn: async input => {
    try { return await base.runTurn(input); }
    finally { executionFinished.release(); }
  } }, { db, store, pollMs: 5 });
  const turn = orchestrator.runTurn({ session_id: 'answer-before-brief', message: 'Read mail:seed in work and explain its scope.', picker_state: { current: 'self' } });
  return { store, events, calls, packets, blocked, executionFinished, orchestrator, turn, expectedAnswer: `${sender}: Scope remains open.`,
    async close() {
      blocked.release(); await turn; await executionFinished.promise;
      orchestrator.turnQueue!.close();
      // Workers settle asynchronously after a cancelled admission returns.
      await new Promise(resolve => setImmediate(resolve));
      db.close();
    } };
};

describe('D-343 — a quick follow-up takes the last turn\'s brief over rather than wait for it', () => {
  // The owner, 2026-11-14: "stop the quick follow-ups from waiting about 30 seconds on the previous
  // reply's background summary". With the carry, the follow-up's model call starts while that brief is
  // still being written; the last turn's results ride to it raw; the brief, once it returns, is not
  // saved; and the follow-up folds those results with its own.
  it('starts the follow-up at once, hands it the last turn\'s results, and saves nothing of the brief it took over', async () => {
    const h = startTurn('success', true);
    const wait = { timeout: 5_000 };
    try {
      await vi.waitFor(() => expect(h.calls.brief).toBe(1));
      await vi.waitFor(async () => expect((await h.orchestrator.turnQueue!.snapshot('answer-before-brief')).turns[0]?.status).toBe('completed'), wait);
      await h.orchestrator.turnQueue!.submit({ family: 'chat', session_id: 'answer-before-brief', message: 'Continue.',
        input: { session_id: 'answer-before-brief', message: 'Continue.', picker_state: { current: 'self' } } }, 'quick-followup');
      // The follow-up's model call, while the first brief is still blocked.
      await vi.waitFor(() => expect(h.calls.main).toBe(3), wait);
      const followUp = h.packets[2]!;
      expect(JSON.stringify(followUp.prior_tool_calls ?? [])).toContain('work.read');
      h.blocked.release();
      await vi.waitFor(async () => expect((await h.orchestrator.turnQueue!.snapshot('answer-before-brief')).turns.every((t) => t.status === 'completed')).toBe(true), wait);
      await vi.waitFor(() => expect(h.events).toContainEqual(expect.objectContaining({ kind: 'chat.transparency', event: expect.objectContaining({
        kind: 'recued.rolling_brief.trail', decisions: expect.arrayContaining(['superseded:a newer turn took these results raw, and folds them']) }) })), wait);
      // The first brief was cancelled and saved nothing; the follow-up used no tools, so it ran no brief
      // of its own (as any such turn), and the results still ride raw for the next turn that does.
      expect(h.calls.brief).toBe(1);
      expect(await (h.store as unknown as { readSessionBrief: (id: string) => Promise<string | null> }).readSessionBrief('answer-before-brief')).toBeNull();
      expect(await (h.store as unknown as { readSessionCarry: (id: string) => Promise<string | null> }).readSessionCarry('answer-before-brief')).toContain('work.read');
      expect((await h.store.listMessages('answer-before-brief')).filter((m) => m.role === 'assistant')).toHaveLength(2);
    } finally { await h.close(); }
  });
});

describe('Chat answer display before closing carry', () => {
  // D-343 (the owner, 2026-11-14: "go ahead with ... the speed fixes") — the answer is saved, and so
  // sent to a linked messenger, BEFORE the closing brief: the owner no longer waits for a summary
  // their answer does not need. Before, it streamed first but was saved (and a messenger chat sent
  // it) only once the brief was written, and Stop during the brief withdrew it. The queue counts the
  // turn done with the answer; the conversation's next turn waits for the brief, which it reads.
  it.each(['success', 'failure', 'empty-brief'] as const)('saves the answer before the closing brief, and the next turn waits for it, on brief %s', async mode => {
    const { store, events, calls, blocked, orchestrator, turn, expectedAnswer, close } = startTurn(mode);
    try {
      await vi.waitFor(() => expect(calls.brief).toBe(1));
      expect(events).toContainEqual(expect.objectContaining({ kind: 'chat.transparency', event: expect.objectContaining({
        kind: 'recued.rolling_brief.call', phase: 'started', call_index: 1, closing: true, input_chars: expect.any(Number),
      }) }));
      expect(events.filter(e => e.kind === 'chat.token_streamed').map(e => e.delta)).toEqual([expectedAnswer]);
      // The brief is still being written, and the answer is already saved and complete.
      await vi.waitFor(async () => expect((await store.listMessages('answer-before-brief')).filter(m => m.role === 'assistant')
        .map(m => m.content)).toEqual([expectedAnswer]));
      const first = events.find(e => e.kind === 'chat.message_complete');
      expect(first && first.kind === 'chat.message_complete' ? first.final : undefined).toMatchObject({ content: expectedAnswer });
      await vi.waitFor(async () => expect((await orchestrator.turnQueue!.snapshot('answer-before-brief')).turns[0]?.status).toBe('completed'));
      // The next message waits for the brief before its model call.
      await orchestrator.turnQueue!.submit({ family: 'chat', session_id: 'answer-before-brief', message: 'Continue.',
        input: { session_id: 'answer-before-brief', message: 'Continue.', picker_state: { current: 'self' } } }, 'queued-followup');
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(calls.main).toBe(2);
      blocked.release();
      await turn;
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ kind: 'chat.transparency', event: expect.objectContaining({
        kind: 'recued.rolling_brief.call', phase: 'finished', call_index: 1, outcome: mode === 'failure' ? 'failed' : 'returned', elapsed_ms: expect.any(Number),
      }) })));
      await vi.waitFor(async () => expect((await orchestrator.turnQueue!.snapshot('answer-before-brief')).turns.every(t => t.status === 'completed')).toBe(true));
      expect(calls.main).toBe(3);
      const tokens = events.filter(e => e.kind === 'chat.token_streamed');
      expect(tokens.filter(e => e.turn_id === first?.turn_id)).toHaveLength(1);
      expect((await store.listMessages('answer-before-brief')).filter(m => m.role === 'assistant')).toHaveLength(2);
      if (mode === 'empty-brief') {
        expect(calls.brief).toBe(2);
        expect(events).toContainEqual(expect.objectContaining({ kind: 'chat.transparency', event: expect.objectContaining({
          kind: 'recued.rolling_brief.call', phase: 'finished', call_index: 2, outcome: 'returned',
        }) }));
      }
    } finally { await close(); }
  });

  // ⛔ Stop pressed while the final answer is still being written. Every other
  // case cancels after the preview, so the active-turn check in front of the
  // preview never met a cancelled turn: removing it left them all green.
  it('shows nothing from a turn stopped before its answer was ready', async () => {
    const { store, events, calls, blocked, executionFinished, orchestrator, turn, close } = startTurn('cancel-before-answer');
    try {
      await vi.waitFor(() => expect(calls.main).toBe(2));
      const [running] = (await orchestrator.turnQueue!.snapshot('answer-before-brief')).turns;
      expect(running?.status).toBe('running');
      await orchestrator.turnQueue!.cancel('answer-before-brief', running!.turn_id);
      blocked.release();
      await turn; await executionFinished.promise;
      expect(events.filter(e => e.kind === 'chat.token_streamed')).toEqual([]);
      expect(calls.brief).toBe(0);
      expect(events.some(e => e.kind === 'chat.message_complete')).toBe(false);
      expect((await store.listMessages('answer-before-brief')).some(m => m.role === 'assistant')).toBe(false);
      expect((await orchestrator.turnQueue!.snapshot('answer-before-brief')).turns.map(t => t.status)).toEqual(['cancelled']);
    } finally { await close(); }
  });
});
