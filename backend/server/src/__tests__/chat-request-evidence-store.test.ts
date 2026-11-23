import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionSource, ToolEntry } from '@recued/contracts';
import { createChatStore, ensureChatSchema, type AppendMessageInput } from '../storage/chat-store.js';
import { boundRequestEvidence, REQUEST_EVIDENCE_LIMITS, requestExecutionEvidence } from '../chat-request-evidence.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const source = (session = 's', turn = 'now'): Extract<ExecutionSource, { channel: 'chat' }> => ({ channel: 'chat', actor: 'user_self',
  chat_session_id: session, turn_id: turn, user_id: 'local-owner' });
const setup = () => {
  const db = new Database(':memory:'); databases.push(db); ensureChatSchema(db);
  const key = randomBytes(32), getKey = vi.fn(() => key), store = createChatStore(db, getKey);
  store.createSession({ id: 's', now: 1 }); store.createSession({ id: 'other', now: 1 });
  let time = 1;
  const append = (id: string, turn: string, role: AppendMessageInput['role'], content: string,
    extra: Partial<AppendMessageInput> = {}) => store.appendMessage({ id, session_id: 's', turn_id: turn, role, content,
    target_server: 'self', picker_at_send: { display_name: 'Self', signature: { server_kind: 'recued', version: 'test', instance_id: 'local' } },
    model_used: { provider: 'test', model_id: 'test' }, execution_source: source('s', turn), source_lifecycle: 'finalized', ts: time++, ...extra });
  return { db, store, getKey, append };
};
const registry = { getByName: (name: string): ToolEntry => ({ name, tier: 1, description: name,
  arg_schema: { type: 'object' }, topic_tags: [], concurrency_safe: false, classification: 'write' }) };

describe('bounded owner request evidence storage', () => {
  it('reads recent and cited requests without decrypting the full history or admitting other corpora', async () => {
    const { store, append, getKey } = setup();
    for (let i = 0; i < 80; i++) {
      await append(`q${i}`, `t${i}`, 'user', `Request ${i}.`);
      await append(`a${i}`, `t${i}`, 'assistant', `Answer ${i}.`);
    }
    await append('door', 'door', 'user', 'Contract secret.', { execution_source: { ...source('s', 'door'), contract_id: 'contract-a' } });
    await append('legacy', 'legacy', 'user', 'Unstamped secret.', { execution_source: undefined });
    await append('foreign', 'foreign', 'user', 'Other session secret.', { session_id: 'other', execution_source: source('other', 'foreign') });
    await append('failed', 'failed', 'user', 'Failed source secret.', { source_lifecycle: 'failed' });
    await append('remote', 'remote', 'user', 'Remote target secret.', { target_server: 'connection.mcp.remote' });
    await append('now', 'now', 'user', 'Continue.');
    getKey.mockClear();
    const window = await store.readRequestEvidenceWindow!('s', 'now', ['t0', 'door', 'legacy', 'foreign', 'failed', 'remote']);
    expect(window.messages.map(m => m.id)).toContain('q0');
    expect(window.messages.map(m => m.id)).toContain('a79');
    expect(window.messages.map(m => m.id)).not.toContain('q1');
    expect(JSON.stringify(window)).not.toContain('secret');
    expect(window.incomplete).toBe(true);
    expect(getKey.mock.calls.length).toBeLessThan(80);
    expect((await store.readRequestEvidenceWindow!('s', 'door', ['t0'])).messages).toEqual([]);
  });

  it('bounds encrypted reads and whole-turn reply coverage before a large or truncated record', async () => {
    const { store, append } = setup();
    await append('large-q', 'large', 'user', 'Tell me the result.');
    await append('large-a', 'large', 'assistant', 'private '.repeat(50_000));
    await append('busy-q', 'busy', 'user', 'Read the records.');
    for (let i = 0; i < 70; i++) await append(`busy-${i}`, 'busy', 'assistant', `Part ${i}`);
    await append('now', 'now', 'user', 'Continue.');
    const window = await store.readRequestEvidenceWindow!('s', 'now', ['large', 'busy']);
    expect(window.incomplete).toBe(true);
    expect(window.excluded_reply_turn_ids).toEqual(expect.arrayContaining(['large', 'busy']));
    expect(window.messages.some(m => m.id === 'large-a')).toBe(false);
    expect(window.messages.length).toBeLessThanOrEqual(REQUEST_EVIDENCE_LIMITS.rows);
    const evidence = requestExecutionEvidence(window.messages, 's', 'now', registry,
      ['Tell me the result.', 'Read the records.'], window.excluded_reply_turn_ids)!;
    expect(evidence.recorded_assistant_replies).toEqual([]);
  });

  it('exposes a held call only after its actual successful settlement and keeps failed envelopes out', async () => {
    const { store, append } = setup();
    const owner = await append('old-q', 'old', 'user', 'Send the update.');
    const id = await store.toolCalls!.start({ session_id: owner.session_id, target_server: owner.target_server,
      picker_at_send: owner.picker_at_send, model_used: owner.model_used, id: 'send', turn_id: 'old', role: 'tool',
      tool_name: 'fixture.send_update', content: 'fixture.send_update({"text":"Hello"})', execution_source: source('s', 'old'), ts: 3 });
    store.toolCalls!.hold(id);
    await append('old-a', 'old', 'assistant', 'I sent it.', { ts: 4 });
    await append('now', 'now', 'user', 'What happened?', { ts: 5 });
    const read = async () => {
      const window = await store.readRequestEvidenceWindow!('s', 'now', ['old']);
      return requestExecutionEvidence(window.messages, 's', 'now', registry, ['Send the update.'], window.excluded_reply_turn_ids)!;
    };
    expect((await read()).successful_actions_for_earlier_requests).toEqual([]);
    await append('send:result', 'old', 'tool', 'fixture.send_update: {"ok":true,"result":{"message_id":"outbox-1"}}',
      { ts: 6, tool_call_settlements: [{ message_id: id, state: 'succeeded' }] });
    const settled = await read();
    expect(settled.successful_actions_for_earlier_requests.map(r => r.invocation_id)).toEqual(['send']);
    expect(settled.successful_actions_for_earlier_requests[0]!.completed_for_request_id).toBe('old');
    const messages = (await store.readRequestEvidenceWindow!('s', 'now', ['old'])).messages.map(m => m.id === 'send:result'
      ? { ...m, content: 'fixture.send_update: {"ok":true,"run_failed":true,"result":{}}' } : m);
    expect(requestExecutionEvidence(messages, 's', 'now', registry)!.successful_actions_for_earlier_requests).toEqual([]);
  });

  it('does not invent a current user request for a synthetic continuation or a deferred row', async () => {
    const { store, append } = setup();
    await append('original', 'original', 'user', 'Send the update.');
    await append('continuation', 'continuation', 'system', 'The approval settled.');
    for (const current of ['continuation', 'not-yet-recorded']) {
      const window = await store.readRequestEvidenceWindow!('s', current, ['original']);
      expect(window.messages).toEqual([]);
      expect(requestExecutionEvidence(window.messages, 's', current, registry)).toBeUndefined();
    }
  });

  it('withholds reply evidence when its encrypted tool provenance cannot be read', async () => {
    const { db, store, append } = setup();
    await append('old-q', 'old', 'user', 'Read the older record.');
    await append('old-a', 'old', 'assistant', 'The recalled answer.');
    db.prepare('UPDATE chat_messages SET tool_calls_blob = ? WHERE message_id = ?').run('unreadable', 'old-a');
    await append('now', 'now', 'user', 'Continue.');
    const window = await store.readRequestEvidenceWindow!('s', 'now', ['old']);
    expect(window.incomplete).toBe(true);
    expect(window.excluded_reply_turn_ids).toContain('old');
    expect(requestExecutionEvidence(window.messages, 's', 'now', registry,
      ['Read the older record.'], window.excluded_reply_turn_ids)!.recorded_assistant_replies).toEqual([]);
  });

  it('drops complete oversized records with partial coverage and never leaves orphan receipt owners', async () => {
    const { store, append } = setup();
    await append('old-q', 'old', 'user', 'x'.repeat(4000));
    await append('old-a', 'old', 'assistant', 'y'.repeat(4000));
    await append('now', 'now', 'user', 'What happened?');
    const window = await store.readRequestEvidenceWindow!('s', 'now', []);
    const raw = requestExecutionEvidence(window.messages, 's', 'now', registry, ['x'.repeat(4000)])!;
    const bounded = boundRequestEvidence({ ...raw, prepared_assistant_reply: { request_id: 'now', text: 'z'.repeat(4000) } }, false, 1000)!;
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(1000);
    expect(bounded.coverage?.incomplete).toBe(true);
    expect(bounded.earlier_requests).toEqual([]);
    expect(bounded.recorded_assistant_replies).toEqual([]);
    expect(bounded.prepared_assistant_reply).toBeUndefined();
  });
});
