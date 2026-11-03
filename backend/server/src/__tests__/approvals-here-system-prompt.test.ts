/** A Telegram or email conversation's system prompt says to answer approvals there, when its
 *  approval requests go there (the owner: "fix the bell message in telegram and email").
 *
 *  ⛔ The held message learned to name the conversation's own channel first (2026-11-01), and the
 *  system prompt went on telling every turn "Approval cards are answered from the bell at the top
 *  of the Recued app". The model keeps the order it is told places in.
 *
 *  The wording, then whole turns through the real orchestrator and chat store, a scripted model
 *  recording the system prompt it was sent. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AIOutput, ExecutionSource, InternalToolRegistry, RecuedServerSignature } from '@recued/contracts';

import { createChatOrchestrator, type ExecuteChatAiCall } from '../chat-orchestrator.js';
import {
  CHAT_MAIN_TURN_SYSTEM_PROMPT,
  FEATURE_TEXT_APPROVALS,
  featureTextApprovalsIn,
  withApprovalsHere,
} from '../chat-turn-executor.js';
import { createChatStore, ensureChatSchema, type ChatStore } from '../storage/chat-store.js';

const signature: RecuedServerSignature = { server_kind: 'recued', version: '1', instance_id: 'test' };
const BELL = 'Approval cards are answered from the bell at the top of the Recued app (Attention), which '
  + 'also opens the Approvals page, not from the Contracts view.';
/** Everything the posture says before where approvals are answered. */
const POSTURE = FEATURE_TEXT_APPROVALS.slice(0, -BELL.length);

describe('the approvals posture, in a conversation its approval requests go to', () => {
  it('a Telegram chat: answer them there in Telegram, then the app', () => {
    expect(FEATURE_TEXT_APPROVALS.endsWith(` ${BELL}`)).toBe(true);
    const told = featureTextApprovalsIn('telegram');
    expect(told).toBe(`${POSTURE}Approval requests go to the user on Telegram, where this conversation is: `
      + 'they can answer them there in Telegram, with the buttons on the approval message. They can also '
      + 'answer them from the bell at the top of the Recued app (Attention), which also opens the '
      + 'Approvals page, not from the Contracts view.');
    expect(told.indexOf('in Telegram')).toBeLessThan(told.indexOf('the bell'));
  });

  it('an email chat: answer them by replying to the approval email', () => {
    expect(featureTextApprovalsIn('email')).toBe(`${POSTURE}Approval requests go to the user by email, where `
      + 'this conversation is: they can answer them by replying to the approval email with one of the '
      + 'options it lists, such as Approve. They can also answer them from the bell at the top of the '
      + 'Recued app (Attention), which also opens the Approvals page, not from the Contracts view.');
  });

  it('a channel with no words of its own, or no channel: the bell, as before', () => {
    expect(featureTextApprovalsIn('bridge')).toBe(FEATURE_TEXT_APPROVALS);
    expect(featureTextApprovalsIn('ui')).toBe(FEATURE_TEXT_APPROVALS);
    expect(withApprovalsHere(CHAT_MAIN_TURN_SYSTEM_PROMPT, undefined)).toBe(CHAT_MAIN_TURN_SYSTEM_PROMPT);
  });

  it('changes the prompt in its place sentence alone, and leaves a prompt without the posture', () => {
    const told = withApprovalsHere(CHAT_MAIN_TURN_SYSTEM_PROMPT, 'telegram');
    expect(told).not.toBe(CHAT_MAIN_TURN_SYSTEM_PROMPT);
    expect(told.replace(featureTextApprovalsIn('telegram'), FEATURE_TEXT_APPROVALS)).toBe(CHAT_MAIN_TURN_SYSTEM_PROMPT);
    expect(withApprovalsHere('Answer briefly.', 'telegram')).toBe('Answer briefly.');
  });

  it('never tells the model it can approve anything, nor that a request is waiting now', () => {
    for (const here of ['telegram', 'slack', 'email'] as const) {
      const told = featureTextApprovalsIn(here);
      expect(told).toContain("You don't have the ability to approve, bypass, or disable these approvals");
      expect(told).not.toMatch(/you can approve|has arrived|is waiting there|already (sent|delivered)/i);
    }
  });
});

describe('each turn reads where approval requests go', () => {
  let db: Database.Database;
  let store: ChatStore;
  beforeEach(() => {
    db = new Database(':memory:');
    ensureChatSchema(db);
    store = createChatStore(db);
  });
  afterEach(() => db.close());

  const registry: InternalToolRegistry = {
    list: () => [], listByTier: () => [], getByName: () => null,
    dispatch: async () => ({ ok: true, result: {} }),
    subscribeRefresh: () => () => undefined,
  };

  /** One turn in the conversation `source` names; the system prompt the model was sent. */
  const promptOf = async (
    source: ExecutionSource,
    approvalChannels?: () => Promise<readonly string[]>,
  ): Promise<string> => {
    const prompts: string[] = [];
    const executeAiCall: ExecuteChatAiCall = async (_manifest, input) => {
      prompts.push(String(input['llm.system_prompt']));
      return { body: { response: 'You can answer it where it was sent.', events: [], tool_calls: [] } satisfies AIOutput };
    };
    const orchestrator = createChatOrchestrator({
      chatStore: store, registry, selfSignature: signature, executeAiCall,
      ...(approvalChannels !== undefined ? { approvalChannels } : {}),
    });
    if (source.channel === 'messenger') {
      const surface = `messenger-${source.vendor}` as const;
      const session_id = `messenger:${source.vendor}:${source.from}`;
      await orchestrator.runMessengerTurn({
        channel: { surface, onInbound: () => undefined, deliver: async () => undefined },
        sessionStore: orchestrator.sessionStore,
        inbound: {
          session_id, surface, text: 'How do I answer your approval requests?', from: source.from,
          source, dispatch_depth: 0, ts: 1_000,
        },
      });
    } else {
      store.createSession({ id: 's', now: 1_000 });
      await orchestrator.runTurn({ session_id: 's', message: 'How do I answer your approval requests?', picker_state: { current: 'self' } });
    }
    expect(prompts.length).toBeGreaterThan(0);
    return prompts[0]!;
  };

  const telegram: ExecutionSource = { channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' };
  const email: ExecutionSource = { channel: 'messenger', actor: 'user_self', vendor: 'email', from: 'owner@example.com' };

  it('a Telegram chat whose approvals go to Telegram: told to answer them there', async () => {
    const prompt = await promptOf(telegram, async () => ['ui', 'telegram']);
    expect(prompt).toContain(featureTextApprovalsIn('telegram'));
    expect(prompt).not.toContain(BELL);
  });

  it('a Telegram chat whose approvals go to the app alone: the bell', async () => {
    const prompt = await promptOf(telegram, async () => ['ui', 'email']);
    expect(prompt).toContain(FEATURE_TEXT_APPROVALS);
  });

  it('an email chat whose approvals go by email: told to reply to the approval email', async () => {
    const prompt = await promptOf(email, async () => ['ui', 'email']);
    expect(prompt).toContain(featureTextApprovalsIn('email'));
  });

  it('the app chat: the bell, wherever approvals go', async () => {
    const app: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'local' };
    const prompt = await promptOf(app, async () => ['ui', 'telegram', 'email']);
    expect(prompt).toContain(FEATURE_TEXT_APPROVALS);
  });

  it('no reader, or a read that fails: the bell, and the turn still runs', async () => {
    expect(await promptOf(telegram)).toContain(FEATURE_TEXT_APPROVALS);
    expect(await promptOf(telegram, async () => { throw new Error('settings unreadable'); }))
      .toContain(FEATURE_TEXT_APPROVALS);
  });
});
