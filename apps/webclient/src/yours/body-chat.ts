/** D-339 slice 13 (D-339 §5.6) — sending a Body's numbers from its page to its own
 *  conversation, with the model the owner picked.
 *
 *  - `sources`: the models Chat can use now, as Chat's own picker lists them
 *    (`buildChatModelSourceOptions` over the server's LLM config).
 *  - `open`: the conversation the Body keeps, or a new one titled after the Body when it has none or
 *    the one it kept was deleted; either way set to the picked model, as Chat's picker sets it.
 *  - `send`: the owner's message, by `chat.send`, as an ordinary turn of the owner's own chat. Not
 *    "Follow this work"'s send on arrival: that marks an unedited message read-only and as mail work.
 *  - `openChat`: Chat at the conversation, to follow the answer. The page opens it only once the send
 *    is accepted, so a send the server refuses leaves the owner on the form with their message. */
import { buildChatModelSourceOptions, type ChatModelSourceOption } from '../chat/model-routing.js';

/** Chat's rpc, as its route takes it (`ChatRouteConn`). */
export type BodyChatCall = (method: string, payload?: unknown) => Promise<unknown>;

export interface BodyChatDeps {
  call: BodyChatCall;
  /** Opens Chat at a conversation. */
  openChat: (sessionId: string) => void;
  /** The zone for "this week" and "today" in the answer; the browser's by default. */
  timeZone?: () => string | undefined;
  /** A fresh id, so a send repeated by the connection is one turn. */
  newId?: () => string;
}

export interface BodyChat {
  sources(): Promise<ChatModelSourceOption[]>;
  open(args: { session_id?: string; title: string; source: ChatModelSourceOption }): Promise<{ session_id: string }>;
  send(args: { session_id: string; text: string; source: ChatModelSourceOption }): Promise<void>;
  openChat(sessionId: string): void;
}

/** D-193's per-turn zone, read as the chat route reads it: "what time is it where I am", which a
 *  connected browser answers. The Body's send is a chat turn, so it is the same reading (D-269 lists it). */
const browserTimeZone = (): string | undefined => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; }
};

const errorCode = (error: unknown): string | undefined =>
  error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code : undefined;

/** The pick as Chat stores it on a conversation and sends it with a turn. */
export const bodyChatModelPref = (source: ChatModelSourceOption): { current: string; model_hint?: string; source_id: string } =>
  ({ current: source.layer, ...(source.model_hint ? { model_hint: source.model_hint } : {}), source_id: source.id });

export const createBodyChat = (deps: BodyChatDeps): BodyChat => ({
  sources: async () => {
    const result = await deps.call('server.getLLMConfig') as { config?: unknown } | null;
    return buildChatModelSourceOptions((result?.config ?? null) as Parameters<typeof buildChatModelSourceOptions>[0]);
  },
  open: async ({ session_id, title, source }) => {
    let id = session_id;
    if (id !== undefined) {
      // A look that marks nothing seen; only "no such conversation" starts another.
      try { await deps.call('chat.session.get', { session_id: id, limit: 1, mark_seen: false }); } catch (error) {
        if (errorCode(error) !== 'not_found') throw error;
        id = undefined;
      }
    }
    if (id === undefined) {
      const created = await deps.call('chat.session.create', { title }) as { session_id?: unknown } | null;
      if (typeof created?.session_id !== 'string' || created.session_id === '') throw new Error('Chat did not start a conversation.');
      id = created.session_id;
    }
    await deps.call('chat.session.set_model_pref', { session_id: id, model_pref: bodyChatModelPref(source) });
    return { session_id: id };
  },
  send: async ({ session_id, text, source }) => {
    const timeZone = (deps.timeZone ?? browserTimeZone)();
    await deps.call('chat.send', {
      session_id, message: text, picker_state: { current: 'self' }, model_pref: bodyChatModelPref(source),
      ...(timeZone ? { time_zone: timeZone } : {}),
      submission_id: deps.newId?.() ?? globalThis.crypto.randomUUID(),
    });
  },
  openChat: (sessionId) => { deps.openChat(sessionId); },
});
