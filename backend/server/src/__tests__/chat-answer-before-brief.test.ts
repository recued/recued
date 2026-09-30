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
const startTurn = (mode: 'success' | 'failure' | 'cancel' | 'cancel-before-answer') => {
  const db = new Database(':memory:'); ensureChatSchema(db);
  const store = createChatStore(db); store.createSession({ id: 'answer-before-brief' });
  store.setRollingBriefEnabled(true);
  const blocked = gate();
  const executionFinished = gate();
  const events: BroadcastChatEvent[] = [];
  const sender = 'new.sender@outside.example';
  const catalog: ToolEntry[] = [{ ...TIER1_TOOL_DESCRIPTORS['mail.read'], tier: 1 }];
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
    executeAiCall: async (_manifest, input) => {
      const packet = JSON.parse(String(input['llm.prompt']));
      expect(JSON.stringify(packet)).not.toContain(sender);
      if ('tool_results_since' in packet) {
        calls.brief++;
        await blocked.promise;
        if (mode === 'failure') throw new Error('Controlled brief provider failure');
        return { body: { intent: 'Explore scope', constraints: [], pending: [], findings: ['Scope remains open.'], completed: [] } };
      }
      calls.main++;
      const from = packet.prior_tool_calls?.[0]?.result?.hot_fields?.from;
      if (calls.main === 2) expect(from).toMatch(/^m\d+(?:\.[^@]+)?@d\d+\.invalid$/);
      if (mode === 'cancel-before-answer' && calls.main === 2) await blocked.promise;
      return { body: { response: calls.main === 1 ? 'Planning text must stay hidden.'
        : from ? `${from}: Scope remains open.` : 'Scope remains open.', events: [],
        tool_calls: calls.main === 1 ? [{ tool: 'mail.read', args: { slug: 'work', record_id: 'mail:seed' } }] : [] } };
    },
  });
  const orchestrator = withQueuedChatTurns({ ...base, runTurn: async input => {
    try { return await base.runTurn(input); }
    finally { executionFinished.release(); }
  } }, { db, store, pollMs: 5 });
  const turn = orchestrator.runTurn({ session_id: 'answer-before-brief', message: 'Read mail:seed in work and explain its scope.', picker_state: { current: 'self' } });
  return { store, events, calls, blocked, executionFinished, orchestrator, turn, expectedAnswer: `${sender}: Scope remains open.`,
    async close() {
      blocked.release(); await turn; await executionFinished.promise;
      orchestrator.turnQueue!.close();
      // Workers settle asynchronously after a cancelled admission returns.
      await new Promise(resolve => setImmediate(resolve));
      db.close();
    } };
};

describe('Chat answer display before closing carry', () => {
  it.each(['success', 'failure', 'cancel'] as const)('keeps one streamed answer and honest queue/persistence boundaries on brief %s', async mode => {
    const { store, events, calls, blocked, executionFinished, orchestrator, turn, expectedAnswer, close } = startTurn(mode);
    try {
      await vi.waitFor(() => expect(calls.brief).toBe(1));
      expect(events.filter(e => e.kind === 'chat.token_streamed').map(e => e.delta)).toEqual([expectedAnswer]);
      expect(events.some(e => e.kind === 'chat.message_complete')).toBe(false);
      expect((await store.listMessages('answer-before-brief')).some(m => m.role === 'assistant')).toBe(false);
      const snapshot = await orchestrator.turnQueue!.snapshot('answer-before-brief');
      expect(snapshot.turns[0]?.status).toBe('running');
      if (mode === 'cancel') await orchestrator.turnQueue!.cancel('answer-before-brief', snapshot.turns[0]!.turn_id);
      else {
        await orchestrator.turnQueue!.submit({ family: 'chat', session_id: 'answer-before-brief', message: 'Continue.',
          input: { session_id: 'answer-before-brief', message: 'Continue.', picker_state: { current: 'self' } } }, 'queued-followup');
        expect((await orchestrator.turnQueue!.snapshot('answer-before-brief')).turns.map(t => t.status)).toEqual(['running', 'queued']);
        expect(calls.main).toBe(2);
      }
      blocked.release();
      await turn;
      if (mode !== 'cancel') {
        await vi.waitFor(async () => expect((await orchestrator.turnQueue!.snapshot('answer-before-brief')).turns.every(t => t.status === 'completed')).toBe(true));
        const first = events.find(e => e.kind === 'chat.message_complete');
        expect(first && first.kind === 'chat.message_complete' ? first.final : undefined).toMatchObject({ content: expectedAnswer });
        const tokens = events.filter(e => e.kind === 'chat.token_streamed');
        expect(tokens.filter(e => e.turn_id === first?.turn_id)).toHaveLength(1);
        expect((await store.listMessages('answer-before-brief')).filter(m => m.role === 'assistant')).toHaveLength(2);
      } else {
        // Let the cancelled worker finish its already-started provider call.
        await executionFinished.promise;
        expect(calls.main).toBe(2);
        expect(events.some(e => e.kind === 'chat.message_complete')).toBe(false);
        expect((await store.listMessages('answer-before-brief')).some(m => m.role === 'assistant')).toBe(false);
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
