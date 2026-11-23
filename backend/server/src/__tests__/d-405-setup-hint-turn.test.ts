/** D-405 slice 1 — through the real orchestrator: a setup hint from the owner's message joins the
 *  answer's row although the model called nothing, its one line rides the packet the model is sent
 *  (`in_flight_context`), and an earlier answer of the conversation that carried it means none now.
 *  The model is scripted; the hint is the composer's (its own tests run on the real chat wire,
 *  `d-404-thing-steps-composition.test.ts`). */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIOutput, InternalToolRegistry, RecuedServerSignature } from '@recued/contracts';

import { createChatOrchestrator, type BroadcastChatEvent, type ChatOrchestratorDeps } from '../chat-orchestrator.js';
import { featureStepSentence, type PromptSetupStep } from '../next-steps/prompt-steps.js';
import { thingStepsSentence } from '../next-steps/thing-steps.js';
import { createChatStore, ensureChatSchema, type ChatStore } from '../storage/chat-store.js';

const signature: RecuedServerSignature = { server_kind: 'recued', version: '1.0.0', instance_id: 'inst-test' };
const registry: InternalToolRegistry = {
  list: () => [],
  listByTier: () => [],
  getByName: () => null,
  dispatch: async () => ({ ok: true, result: {} }),
  subscribeRefresh: () => () => undefined,
};
const PASSPORT: PromptSetupStep = {
  fixes: [{ kind: 'thing', type_id: 'passport', type_name: 'Passport' }],
  offers: [],
  line: thingStepsSentence(['Passport']),
  key: 'thing:passport',
};
/** A piece of the line with no quote in it, so it reads the same however deep the packet escapes it. */
const LINE_MARK = 'No Passport is in Yours yet';

let store: ChatStore;
let events: BroadcastChatEvent[];
beforeEach(() => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  store = createChatStore(db);
  events = [];
  store.createSession({ id: 's', now: 1_000 });
});

let chats = 0;
/** A file the owner attaches, and the name the server resolves for it. */
const SCAN = 'file:0123456789abcdef0123456789abcdef';
/** A chat whose model answers at once, calling nothing; every input it is sent, kept. */
const chat = (buildSetupHint: NonNullable<ChatOrchestratorDeps['buildSetupHint']>) => {
  const inputs: string[] = [];
  const prefix = `c${String((chats += 1))}`;
  let n = 0;
  const orchestrator = createChatOrchestrator({
    chatStore: store,
    registry,
    broadcast: { emit: (event) => events.push(event) },
    selfSignature: signature,
    mintId: () => `${prefix}-${String(++n)}`,
    executeAiCall: async (_manifest, input) => {
      inputs.push(JSON.stringify(input));
      const body: AIOutput = { response: 'There is no passport in Yours yet; you can add one from the link below.', events: [], tool_calls: [] };
      return { body };
    },
    buildSetupHint,
    resolveFileNames: (ids) => new Map(ids.filter((id) => id === SCAN).map((id) => [id, 'passport-scan.pdf'])),
  });
  const ask = async (message: string, attached = false) => {
    inputs.length = 0;
    await orchestrator.runTurn({ session_id: 's', message, picker_state: { current: 'self' },
      ...(attached ? { attachments: [{ file_id: SCAN, media_class: 'document' }] } : {}) });
    const answers = (await store.listMessages('s')).filter((entry) => entry.role === 'assistant');
    return { answer: answers.at(-1), sent: [...inputs] };
  };
  return { ask };
};

describe('D-405 slice 1 — a setup hint on the owner\'s turn', () => {
  it('joins the answer\'s row although the model called nothing, and its line rides the packet the model is sent', async () => {
    const hint = vi.fn(async (_message: string, _ctx: unknown) => PASSPORT);
    const { answer, sent } = await chat(hint).ask('When does my passport expire?');
    expect(hint).toHaveBeenCalledTimes(1);
    expect(hint.mock.calls[0]![0]).toBe('When does my passport expire?');
    expect(answer?.tool_calls ?? []).toEqual([]);
    expect(answer?.fixes).toEqual(PASSPORT.fixes);
    const complete = events.find((event) => event.kind === 'chat.message_complete');
    expect((complete as { final?: { fixes?: unknown } } | undefined)?.final?.fixes).toEqual(PASSPORT.fixes);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.some((input) => input.includes(LINE_MARK))).toBe(true);
    // The row's own field never reaches the model: it reads the line, not the side fields.
    for (const input of sent) expect(input).not.toContain('"fixes"');
  });

  it('⛔ never twice in one conversation: the answer after one that carried it gets neither the row nor the line', async () => {
    const { ask } = chat(vi.fn(async () => PASSPORT));
    expect((await ask('When does my passport expire?')).answer?.fixes).toEqual(PASSPORT.fixes);
    const again = await ask('And when should I renew my passport?');
    expect(again.answer).not.toHaveProperty('fixes');
    expect(again.sent.some((input) => input.includes(LINE_MARK))).toBe(false);
  });

  it('⛔ reads the owner\'s own words, never the attached files\' names the model is sent with them', async () => {
    const hint = vi.fn(async (_message: string, _ctx: unknown) => null);
    const { sent } = await chat(hint).ask('What does this say?', true);
    // The model is sent the file's name ("passport-scan.pdf" names a type); the hint is not.
    expect(sent.some((input) => input.includes('passport-scan.pdf'))).toBe(true);
    expect(hint.mock.calls[0]![0]).toBe('What does this say?');
  });

  it('a core feature with none connected (slice 2) joins the row and is never given twice', async () => {
    const MAIL: PromptSetupStep = { fixes: [{ kind: 'feature', feature: 'mail' }], offers: [], line: featureStepSentence('mail'), key: 'feature:mail' };
    const { ask } = chat(vi.fn(async () => MAIL));
    const first = await ask('Did Anna reply to my email?');
    expect(first.answer?.fixes).toEqual(MAIL.fixes);
    expect(first.sent.some((input) => input.includes('No mailbox is connected yet'))).toBe(true);
    const again = await ask('Any new email from Anna?');
    expect(again.answer).not.toHaveProperty('fixes');
    expect(again.sent.some((input) => input.includes('No mailbox is connected yet'))).toBe(false);
  });

  it('a hint that fails, finds nothing or runs past its budget leaves the turn as it was', async () => {
    for (const build of [
      vi.fn(async () => { throw new Error('probe failed'); }),
      vi.fn(async () => null),
      vi.fn(() => new Promise<PromptSetupStep | null>(() => undefined)),
    ]) {
      const { answer, sent } = await chat(build).ask('When does my passport expire?');
      expect(answer?.content).toContain('no passport in Yours');
      expect(answer).not.toHaveProperty('fixes');
      expect(sent.some((input) => input.includes(LINE_MARK))).toBe(false);
    }
  });
});
