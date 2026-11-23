/** D-339 slice 13 (D-339 §5.6) — a Body's own conversation, from its page: which models
 *  Chat can use, the conversation it keeps (or a new one when that one was deleted), the model set on it
 *  as Chat's picker sets it, and the owner's message sent as an ordinary turn of their own chat.
 *
 *  Against a fake rpc that records each call and can refuse one; the page and Chat are driven in real
 *  Chrome by `scripts/drives/d-339-ask-with-numbers-live.mjs`. */
import { describe, expect, it } from 'vitest';
import { ASSET_CHAT_CONVERSATION, readAssetChatConversation } from '@recued/contracts';
import { createBodyChat, type BodyChatCall } from '../yours/body-chat.js';
import { buildChatModelSourceOptions } from '../chat/model-routing.js';

const CONFIG = { slot_1: { provider: 'anthropic', model: 'claude', has_key: true }, free_pool: [{ id: 'groq', enabled: true }] };
const [fast, pool] = buildChatModelSourceOptions(CONFIG);

/** A fake rpc: answers by method, records every call, and refuses what `refuse` names. */
const rpc = (refuse: Record<string, unknown> = {}) => {
  const calls: Array<[string, unknown]> = [];
  const call: BodyChatCall = async (method, payload) => {
    calls.push([method, payload]);
    if (Object.hasOwn(refuse, method)) throw refuse[method];
    if (method === 'server.getLLMConfig') return { config: CONFIG };
    if (method === 'chat.session.create') return { session_id: 'chat-new' };
    if (method === 'chat.send') return { turn_id: 'turn-1', status: 'queued' };
    return {};
  };
  return { call, calls, methods: () => calls.map(([method]) => method) };
};
const make = (fake: ReturnType<typeof rpc>, opened: string[] = []) =>
  createBodyChat({ call: fake.call, openChat: (id) => { opened.push(id); }, timeZone: () => 'America/Los_Angeles', newId: () => 'sub-1' });

describe('D-339 slice 13 — the Body\'s own conversation', () => {
  it('lists the models Chat\'s own picker lists, from the server\'s LLM config', async () => {
    const fake = rpc();
    expect(await make(fake).sources()).toEqual([fast, pool]);
    expect(fake.methods()).toEqual(['server.getLLMConfig']);
  });

  it('keeps the conversation the Body has, and sets the picked model on it as Chat\'s picker does', async () => {
    const fake = rpc();
    expect(await make(fake).open({ session_id: 'chat-kept', title: 'Anna’s body', source: fast! })).toEqual({ session_id: 'chat-kept' });
    expect(fake.calls).toEqual([
      // A look that marks nothing seen.
      ['chat.session.get', { session_id: 'chat-kept', limit: 1, mark_seen: false }],
      ['chat.session.set_model_pref', { session_id: 'chat-kept', model_pref: { current: 'byok', model_hint: 'fast', source_id: 'slot_1' } }],
    ]);
  });

  it('starts a new one, titled after the Body, when it has none or the one it kept was deleted', async () => {
    const none = rpc();
    expect(await make(none).open({ title: 'Anna’s body', source: pool! })).toEqual({ session_id: 'chat-new' });
    expect(none.calls).toEqual([
      ['chat.session.create', { title: 'Anna’s body' }],
      ['chat.session.set_model_pref', { session_id: 'chat-new', model_pref: { current: 'free_pool', source_id: 'free_pool' } }],
    ]);
    const deleted = rpc({ 'chat.session.get': Object.assign(new Error('chat: session chat-kept not found'), { code: 'not_found' }) });
    expect(await make(deleted).open({ session_id: 'chat-kept', title: 'Anna’s body', source: fast! })).toEqual({ session_id: 'chat-new' });
    expect(deleted.methods()).toEqual(['chat.session.get', 'chat.session.create', 'chat.session.set_model_pref']);
  });

  it('starts nothing when the look fails for another reason: the error is the owner\'s to see', async () => {
    const offline = rpc({ 'chat.session.get': Object.assign(new Error('The server is not answering'), { code: 'unavailable' }) });
    await expect(make(offline).open({ session_id: 'chat-kept', title: 'Anna’s body', source: fast! })).rejects.toThrow('not answering');
    expect(offline.methods()).toEqual(['chat.session.get']);
  });

  it('sends the owner\'s words as an ordinary turn of their own chat, with the picked model and their zone', async () => {
    const fake = rpc(); const opened: string[] = [];
    const chat = make(fake, opened);
    await chat.send({ session_id: 'chat-kept', text: 'Anna’s body, the last 7 days…', source: fast! });
    expect(fake.calls).toEqual([['chat.send', { session_id: 'chat-kept', message: 'Anna’s body, the last 7 days…', picker_state: { current: 'self' },
      model_pref: { current: 'byok', model_hint: 'fast', source_id: 'slot_1' }, time_zone: 'America/Los_Angeles', submission_id: 'sub-1' }]]);
    // None of "Follow this work"'s flags: no read-only turn, no repeat, no mail work.
    const sent = fake.calls[0]![1] as Record<string, unknown>;
    expect(['read_only', 'repeat', 'mail_work'].filter((key) => key in sent)).toEqual([]);
    // Sending opens nothing: the page opens the conversation once the send is accepted.
    expect(opened).toEqual([]);
    chat.openChat('chat-kept');
    expect(opened).toEqual(['chat-kept']);
  });

  it('rethrows a refused send', async () => {
    const refused = rpc({ 'chat.send': Object.assign(new Error('No AI model is set up'), { code: 'no_llm_source' }) });
    await expect(make(refused).send({ session_id: 'chat-kept', text: 'x', source: fast! })).rejects.toThrow('No AI model');
  });
});

describe('D-339 slice 13 — what a Body keeps of its conversation', () => {
  it('reads its setting defensively: an approval that does not parse is left out, a bad value is none', () => {
    expect(ASSET_CHAT_CONVERSATION).toBe('chat_conversation');
    const good = { at: 1, request: 'diet', days: 7, readings: ['sleep_minutes'], about: ['age', 'height'], source: 'slot_1', source_label: 'Fast · qwen' };
    expect(readAssetChatConversation({ session_id: 'chat-1', sent: [good, { ...good, request: 'diagnose' }, { ...good, source: 'local' }, 'x',
      { ...good, about: ['age', 'birth_date'] }] })).toEqual({ session_id: 'chat-1', sent: [good, { ...good, about: ['age'] }] });
    for (const bad of [undefined, null, 'chat-1', { session_id: '' }, { sent: [] }]) expect(readAssetChatConversation(bad)).toBeUndefined();
    expect(readAssetChatConversation({ session_id: 'chat-1', sent: Array.from({ length: 30 }, (_, i) => ({ ...good, at: i })) })!.sent).toHaveLength(20);
  });
});
