/** D-329 — a call that stopped for the owner's yes keeps the card it waits on, so its line follows
 *  the card: it read "couldn't change a calendar event: it is waiting for your yes" under a card
 *  saying the change was done (live, 2026-11-13). Display only: the model's account of the call is
 *  its reason and detail, as before. Through the real orchestrator and chat store. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatPriorToolCall, InternalToolRegistry, ToolEntry } from '@recued/contracts';

import { createChatOrchestrator } from '../chat-orchestrator.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

const signature = { server_kind: 'recued' as const, version: '1', instance_id: 'test' };
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

const ENTRY: ToolEntry = { name: 'recued-core/weekly-digest', tier: 2, description: 'A recipe.', arg_schema: { type: 'object' },
  topic_tags: [], classification: 'unknown', concurrency_safe: false };
const DETAIL = 'plan_id=plan_7. Sent to the owner to approve.';

const turn = async () => {
  const db = new Database(':memory:');
  cleanup.push(() => db.close());
  ensureChatSchema(db);
  const store = createChatStore(db);
  store.createSession({ id: 'session', now: 1_000 });
  const registry: InternalToolRegistry = {
    list: () => [ENTRY], listByTier: tier => (tier === 2 ? [ENTRY] : []),
    getByName: name => (name === ENTRY.name ? ENTRY : null), subscribeRefresh: () => () => {},
    // The first call stops for the owner's yes; the second runs. D-343 (2026-11-14): a round whose
    // EVERY call stops ends the turn without another model call, so the round has one that runs.
    dispatch: async () => (++dispatched === 1 ? { ok: false, reason: 'awaiting_approval', detail: DETAIL, awaiting_plan_id: 'plan_7' }
      : { ok: true, result: { sent: true } }),
  };
  const packets: Array<{ prior_tool_calls?: ChatPriorToolCall[] }> = [];
  let rounds = 0; let dispatched = 0;
  const app = createChatOrchestrator({
    chatStore: store, registry, selfSignature: signature, broadcast: { emit: () => {} },
    executeAiCall: async (_manifest, input) => {
      // What the model is sent: the packet in its prompt.
      packets.push(JSON.parse(String(input['llm.prompt'])) as { prior_tool_calls?: ChatPriorToolCall[] });
      return ++rounds === 1
        ? { body: { response: '', events: [], tool_calls: [{ tool: ENTRY.name, args: {} }, { tool: ENTRY.name, args: { again: true } }] } }
        : { body: { response: 'It is waiting for your approval.', events: [], tool_calls: [] } };
    },
  });
  await app.runTurn({ session_id: 'session', message: 'Send the weekly digest', picker_state: { current: 'self' } });
  const answer = (await store.listMessages('session')).find(message => message.role === 'assistant');
  return { kept: answer?.tool_calls ?? [], told: packets.flatMap(packet => packet.prior_tool_calls ?? []) };
};

describe('a call that stopped for the owner\'s yes keeps the card it waits on', () => {
  it('its kept call names the card; the model is told its reason and detail, as before', async () => {
    const { kept, told } = await turn();
    expect(kept).toContainEqual(expect.objectContaining({ tool_name: ENTRY.name, status: 'error', reason: 'awaiting_approval',
      detail: DETAIL, awaiting_plan_id: 'plan_7' }));
    const call = told.find(entry => entry.tool_name === ENTRY.name);
    expect(call).toMatchObject({ status: 'error', reason: 'awaiting_approval', detail: DETAIL });
    expect(call).not.toHaveProperty('awaiting_plan_id');
  });
});

describe('D-343 (the owner, 2026-11-14) — a round whose every call waits for the owner ends the turn', () => {
  it('says what waits, in their words, with no further model call', async () => {
    const db = new Database(':memory:');
    cleanup.push(() => db.close());
    ensureChatSchema(db);
    const store = createChatStore(db);
    // The delayed writer below returns the Standard brief format.
    store.setRollingBriefEnabled(true);
    store.createSession({ id: 'session', now: 1_000 });
    const registry: InternalToolRegistry = {
      list: () => [ENTRY], listByTier: tier => (tier === 2 ? [ENTRY] : []),
      getByName: name => (name === ENTRY.name ? ENTRY : null), subscribeRefresh: () => () => {},
      dispatch: async () => ({ ok: false, reason: 'awaiting_approval', detail: DETAIL, awaiting_plan_id: 'plan_7' }),
    };
    let rounds = 0;
    const app = createChatOrchestrator({
      chatStore: store, registry, selfSignature: signature, broadcast: { emit: () => {} },
      recipeTitle: (ref) => (ref === ENTRY.name ? 'Send the weekly digest' : undefined),
      executeAiCall: async (_m, input) => {
        // The turn's closing brief is a model call of its own; this counts the chat's.
        if ('tool_results_since' in (JSON.parse(String(input['llm.prompt'])) as object)) {
          return { body: { intent: 'Send the weekly digest', constraints: [], pending: [], findings: [], completed: [] } };
        }
        rounds += 1;
        // It claims a done that has not happened: the round's reply is written before the call is held.
        return { body: { response: 'Sent the weekly digest.', events: [], tool_calls: [{ tool: ENTRY.name, args: {} }] } };
      },
    });
    await app.runTurn({ session_id: 'session', message: 'Send the weekly digest', picker_state: { current: 'self' } });
    expect(rounds).toBe(1);
    const answer = (await store.listMessages('session')).find(message => message.role === 'assistant');
    expect(answer?.content).toBe('Waiting for your approval: Send the weekly digest. Once you answer it, this conversation carries on by itself.');
  });
});
