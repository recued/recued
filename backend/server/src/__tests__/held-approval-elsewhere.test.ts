/** A held run tells its agent where else the owner can answer the approval.
 *
 *  ⛔ With only the held message to go on, an email chat answered "You can
 *  review and approve it from the bell icon at the top of the Recued app" while
 *  the approval email was already in the owner's inbox, answerable by a reply
 *  (live, 2026-10-18). The ask's own record says where it went: the run reports
 *  it (`approval_channels`) and the agent's projection says it in words
 *  (`approval_elsewhere`).
 *
 *  Through the real `handleExecute` and the projection Chat uses
 *  (`wrapRecipeRunResult`). The composed reader, over a real notification
 *  block, is `d-157-execute-deps-composition.test.ts`. */

import { describe, expect, it, vi } from 'vitest';
import type { ExecutionSource, IngredientManifest, RecipeDefinition } from '@recued/contracts';
import { createAuditLogStore, createInMemoryCollection, type ActivityEntry, type AuditEntry } from '@recued/storage';

import { conversationCarriesOn, HELD_CARRIES_ON_MESSAGE } from '../chat-carries-on.js';
import { projectRawOpOutcome, wrapRecipeRunResult } from '../chat-tool-handlers.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import {
  approvalChannelOf,
  approvalElsewhereMessage,
  HELD_FOR_APPROVAL_MESSAGE,
  heldForApprovalMessageIn,
  type AgentHeldRunResult,
} from '../run-result-agent-projection.js';

const owner: ExecutionSource = { channel: 'user', actor: 'user_self', user_id: 'owner-1', client_token_id: 'client-1' };

const mailSendManifest = {
  slug: 'mail-send', name: 'mail-send', description: 'Test mail-send manifest',
  author: 'recued', kind: 'storage', risk_tier: 'write', version: 1,
  category: 'action', input: {}, output: { message_id: 'message_id' },
} as unknown as IngredientManifest;

/** One send: the owner's send is held for their approval. */
const recipe = {
  recipe_id: 'send-a-note',
  version: 1,
  ttl: 60,
  metadata: { name: 'Send a note', description: 'One email.', author: 'test', supported_platforms: ['test'] },
  variables: {},
  prefetch_steps: [],
  steps: [{
    id: 'send', ingredient: 'mail-send',
    input: { sender_mail_instance: 'work', to: ['bob@example.com'], subject: 'hi', body: 'hello' },
  }],
  output: { sidebar: [] },
} as unknown as RecipeDefinition;

const EMAIL_ELSEWHERE = 'This approval request also goes to the user by email; they can answer it there too. '
  + 'To answer by email, they reply to the approval email with one of the options it lists, such as Approve.';

/** The run, its approval ask raised as `ask-1`, and where that ask went read
 *  through `approvalAskChannels` when one is given. */
const run = async (
  reader?: ExecuteHandlerDeps['approvalAskChannels'],
  notifier = true,
  /** The conversation Chat projects the held run for (its `ctx.execution_source`). */
  conversation?: ExecutionSource,
) => {
  const manifests = createManifestRegistry('/nonexistent');
  manifests.register(mailSendManifest);
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe);
  const mailSend = vi.fn(async () => ({ message_id: '<m@x>' }));
  const deps: ExecuteHandlerDeps = {
    recipeStore,
    executorConfig: { manifests, kernelDispatchers: { mailSend } as never },
    baseVault: {},
    instanceId: 'held-approval-elsewhere',
    checkpointStore: { write: vi.fn(async () => undefined) } as unknown as ExecuteHandlerDeps['checkpointStore'],
    // A hold needs its approval anchor, or it fails as CHECKPOINT_WRITE_FAILED.
    auditLog: createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>()),
    ...(notifier
      ? {
        preflightNotifier: {
          ask: vi.fn(async () => ({ ask_id: 'ask-1' })),
          registerAskHandler: vi.fn(),
          notify: vi.fn(async () => undefined),
        },
      }
      : {}),
    ...(reader !== undefined ? { approvalAskChannels: reader } : {}),
  };
  const response = await handleExecute(deps, { recipe_id: recipe.recipe_id, trigger_source: 'chat', execution_source: owner });
  expect(response.errors).toEqual([]);
  expect(response.awaiting_approval).toBe(true);
  expect(mailSend).not.toHaveBeenCalled();
  return {
    response,
    held: wrapRecipeRunResult(response, undefined, conversation) as { ok: boolean; result: AgentHeldRunResult },
  };
};

describe('a held run says where else its approval can be answered', () => {
  it('the ask went by email too: the run names its channels, and the agent is told to say so', async () => {
    const asked: string[] = [];
    const { response, held } = await run(async (ask_id) => {
      asked.push(ask_id);
      return ask_id === 'ask-1' ? ['ui', 'email'] : undefined;
    });
    // The ask the run raised, not another.
    expect(asked).toEqual(['ask-1']);
    expect(response.approval_channels).toEqual(['ui', 'email']);
    expect(held.ok).toBe(true);
    expect(held.result.status).toBe('awaiting_approval');
    // The canonical message is unchanged; the channels ride beside it.
    expect(held.result.message).toBe(HELD_FOR_APPROVAL_MESSAGE);
    expect(held.result.approval_elsewhere).toBe(EMAIL_ELSEWHERE);
  });

  it('the app alone: nothing more is said', async () => {
    const { response, held } = await run(async () => ['ui']);
    expect(response.approval_channels).toEqual(['ui']);
    expect(held.result.approval_elsewhere).toBeUndefined();
  });

  it('a read that fails, an ask not found, no reader: the hold is the same, naming nowhere else', async () => {
    for (const reader of [async () => { throw new Error('store locked'); }, async () => undefined, undefined]) {
      const { response, held } = await run(reader);
      expect(response.approval_channels).toBeUndefined();
      expect(held.result.message).toBe(HELD_FOR_APPROVAL_MESSAGE);
      expect(held.result.approval_elsewhere).toBeUndefined();
    }
  });

  it('no ask raised (no notifier): nothing is read', async () => {
    const reader = vi.fn(async () => ['ui', 'email']);
    const { response } = await run(reader, false);
    expect(reader).not.toHaveBeenCalled();
    expect(response.approval_channels).toBeUndefined();
  });
});

describe('the words for the other channels', () => {
  it('each channel by the name the owner knows it by; the email one says how to answer', () => {
    expect(approvalElsewhereMessage(['slack'])).toBe(
      'This approval request also goes to the user on Slack; they can answer it there too.',
    );
    expect(approvalElsewhereMessage(['ui', 'email', 'telegram'])).toBe(
      'This approval request also goes to the user by email and on Telegram; they can answer it there too. '
      + 'To answer by email, they reply to the approval email with one of the options it lists, such as Approve.',
    );
    expect(approvalElsewhereMessage(['slack', 'teams', 'bridge'])).toBe(
      'This approval request also goes to the user on Slack, on Microsoft Teams and in the Recued browser extension; '
      + 'they can answer it there too.',
    );
  });

  it('the app alone, nothing, or a channel it has no words for: nothing is said', () => {
    expect(approvalElsewhereMessage([])).toBeUndefined();
    expect(approvalElsewhereMessage(['ui'])).toBeUndefined();
    expect(approvalElsewhereMessage(['carrier-pigeon'])).toBeUndefined();
    // An inherited key is not a channel.
    expect(approvalElsewhereMessage(['toString'])).toBeUndefined();
  });

  it('never tells the agent it can grant anything itself', () => {
    const all = approvalElsewhereMessage(['ui', 'bridge', 'slack', 'telegram', 'whatsapp', 'discord', 'teams', 'email'])!;
    expect(all).not.toMatch(/you (can|may) (grant|approve|allow)/i);
  });
});

describe('in a conversation its approval request goes to, that one is named first', () => {
  // ⛔ Live, 2026-11-01: a Telegram chat whose approval came with buttons told the owner to
  // approve "from the bell icon at the top of the Recued app".
  const telegram: ExecutionSource = { channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' };
  const email: ExecutionSource = { channel: 'messenger', actor: 'user_self', vendor: 'email', from: 'owner@example.com' };
  const TELEGRAM_HERE = 'This approval request also goes to the user on Telegram, where this conversation is: tell '
    + 'them they can answer it there in Telegram, with the buttons on the approval message.';

  it('a Telegram chat: the message says to answer it there in Telegram, and the app after', async () => {
    const { held } = await run(async () => ['ui', 'telegram'], true, telegram);
    const message = held.result.message;
    expect(message).toBe(heldForApprovalMessageIn('telegram'));
    // ⛔ The order is the point: with the bell first, an email chat led with the bell (live).
    const here = message.indexOf('This approval request goes to the user on Telegram, where this conversation is: tell '
      + 'them they can answer it there in Telegram, with the buttons on the approval message.');
    const app = message.indexOf('They can also answer it in the Recued app, from the bell');
    expect(here).toBeGreaterThan(-1);
    expect(app).toBeGreaterThan(here);
    expect(message).not.toContain('Approvals are answered in the Recued app');
    // Nothing else to name: Telegram is in the message.
    expect(held.result.approval_elsewhere).toBeUndefined();
  });

  it('an email chat: the message says to answer it by replying to the approval email', async () => {
    const { held } = await run(async () => ['ui', 'email'], true, email);
    expect(held.result.message).toBe(heldForApprovalMessageIn('email'));
    expect(held.result.message).toContain('This approval request goes to the user by email, where this conversation '
      + 'is: tell them they can answer it by replying to the approval email with one of the options it lists, such as Approve.');
    expect(held.result.approval_elsewhere).toBeUndefined();
  });

  it('a Telegram chat whose request also went by email and to Slack: those are named beside the message, as before', async () => {
    const { held } = await run(async () => ['ui', 'telegram', 'email', 'slack'], true, telegram);
    expect(held.result.message).toBe(heldForApprovalMessageIn('telegram'));
    expect(held.result.approval_elsewhere).toBe(
      'This approval request also goes to the user by email and on Slack; they can answer it there too. '
      + 'To answer by email, they reply to the approval email with one of the options it lists, such as Approve.',
    );
  });

  it('a Telegram chat whose request went by email only: the app stays the place, and email is named as before', async () => {
    const { held } = await run(async () => ['ui', 'email'], true, telegram);
    expect(held.result.message).toBe(HELD_FOR_APPROVAL_MESSAGE);
    expect(held.result.approval_elsewhere).toBe(EMAIL_ELSEWHERE);
  });

  it('the conversation\'s own channel first, then the others, with the email reply still explained', () => {
    expect(approvalElsewhereMessage(['ui', 'telegram', 'email', 'slack'], 'telegram')).toBe(
      `${TELEGRAM_HERE} It also goes to them by email and on Slack; they can answer it there too. `
      + 'To answer by email, they reply to the approval email with one of the options it lists, such as Approve.',
    );
    expect(approvalElsewhereMessage(['ui'], 'telegram')).toBeUndefined();
  });

  it('only the owner\'s own chat on a channel an approval can go to is a "here"', () => {
    expect(approvalChannelOf(telegram)).toBe('telegram');
    expect(approvalChannelOf(email)).toBe('email');
    // A household member's chat: its approvals go to the owner, who is not the one in it.
    expect(approvalChannelOf({ channel: 'messenger', actor: 'contracted_user', vendor: 'telegram', from: '7', contract_id: 'k' }))
      .toBeUndefined();
    expect(approvalChannelOf({ channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'o' })).toBeUndefined();
    expect(approvalChannelOf({ ...telegram, vendor: 'carrier-pigeon' })).toBeUndefined();
    expect(approvalChannelOf(undefined)).toBeUndefined();
  });

  it('a "here" message differs from the canonical one in its place sentence alone', () => {
    const message = heldForApprovalMessageIn('email');
    const start = message.indexOf('This approval request goes to the user by email');
    const end = message.indexOf('which opens the Approvals page.') + 'which opens the Approvals page.'.length;
    const swapped = message.slice(0, start)
      + 'Approvals are answered in the Recued app, from the bell at the top of the page (Attention), which also opens the Approvals page.'
      + message.slice(end);
    expect(start).toBeGreaterThan(-1);
    expect(swapped).toBe(HELD_FOR_APPROVAL_MESSAGE);
  });

  it('never tells the agent it can grant anything itself, nor that the request has already arrived', () => {
    for (const here of ['telegram', 'email', 'slack'] as const) {
      const said = approvalElsewhereMessage(['ui', 'bridge', 'slack', 'telegram', 'whatsapp', 'discord', 'teams', 'email'], here)!;
      expect(said).toContain('where this conversation is');
      expect(said).not.toMatch(/you (can|may) (grant|approve|allow)/i);
      expect(said).not.toMatch(/arrived|is waiting|is showing|was sent/i);
    }
  });
});

describe('D-337 §7.4 — a call held in a conversation that carries on says so', () => {
  // The owner's own conversations carry on once the approval is answered: the model gets the call
  // and its outcome then. Told nothing of it, a model could ask the user to report back, or take a
  // step that needed a result not yet there.
  const app: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 's1', user_id: 'local' };
  const telegram: ExecutionSource = { channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' };
  const email: ExecutionSource = { channel: 'messenger', actor: 'user_self', vendor: 'email', from: 'owner@example.com' };
  const scheduled: ExecutionSource = {
    channel: 'schedule', actor: 'system', schedule_id: 'sch-1', cron: '0 9 * * *',
    prompt_schedule: { schedule_id: 'sch-1', occurrence_id: 'occ-1', revision: 1, due_at: 1_000, cron: '0 9 * * *' },
    chat_session_id: 's1', turn_id: 't1',
  };
  const household: ExecutionSource = {
    channel: 'messenger', actor: 'contracted_user', vendor: 'telegram', from: '7', contract_id: 'k-house',
  };
  const selfRestricted: ExecutionSource = { ...app, contract_id: 'k-self' } as ExecutionSource;
  const door: ExecutionSource = {
    channel: 'mcp', actor: 'contracted_user', agent_id: 'a', tool_call_id: 't', mcp_token_id: 'tok', contract_id: 'k',
  };
  const recipeOnSchedule: ExecutionSource = { channel: 'schedule', actor: 'system', cron: '0 9 * * *', source_recipe: 'nightly' };

  it('which conversations carry on: the owner\'s own, and no other', () => {
    expect([app, scheduled, telegram, email].map(conversationCarriesOn)).toEqual([true, true, true, true]);
    expect([household, selfRestricted, door, recipeOnSchedule, undefined, null, 'chat'].map(conversationCarriesOn))
      .toEqual([false, false, false, false, false, false, false]);
  });

  it('a held run asked in the app chat: its message as before, and that the conversation carries on', async () => {
    const { held } = await run(async () => ['ui'], true, app);
    expect(held.result.message).toBe(HELD_FOR_APPROVAL_MESSAGE);
    expect(held.result.after_approval).toBe(HELD_CARRIES_ON_MESSAGE);
    // In a Telegram chat too, beside the message that names Telegram first.
    const fromTelegram = (await run(async () => ['ui', 'telegram'], true, telegram)).held.result;
    expect(fromTelegram.message).toBe(heldForApprovalMessageIn('telegram'));
    expect(fromTelegram.after_approval).toBe(HELD_CARRIES_ON_MESSAGE);
  });

  it('a held run with no conversation (an AI app) or under a contract: nothing is said of it', async () => {
    for (const conversation of [undefined, household, door]) {
      expect((await run(async () => ['ui'], true, conversation)).held.result).not.toHaveProperty('after_approval');
    }
  });

  it('a held pack action says the same, where the conversation carries on', () => {
    const held = { kind: 'held', op_id: 'acme.lights.set', run_id: 'run-1' } as const;
    const said = projectRawOpOutcome(held, app) as { ok: true; result: Record<string, unknown> };
    expect(said.result).toMatchObject({ status: 'awaiting_approval', after_approval: HELD_CARRIES_ON_MESSAGE });
    for (const conversation of [undefined, household]) {
      const quiet = projectRawOpOutcome(held, conversation) as { ok: true; result: Record<string, unknown> };
      expect(quiet.result).not.toHaveProperty('after_approval');
    }
  });

  it('never tells the model it can approve anything, nor that the answer has come', () => {
    expect(HELD_CARRIES_ON_MESSAGE).not.toMatch(/you (can|may) (grant|approve|allow)/i);
    expect(HELD_CARRIES_ON_MESSAGE).not.toMatch(/\b(was|has been) (approved|done)\b|has answered|already/i);
  });

  it('a step the user asked for after it waits too, even one that would ask itself, and it says why', () => {
    // Live, 2026-11-01: asked to remove an event and, once it was gone, add another, the model
    // proposed the add at once in 2 of 3 first answers under "do not take a step that needs its
    // result", and in 1 of 6 with these words.
    expect(HELD_CARRIES_ON_MESSAGE).toContain('do not take a step that should only happen after this one');
    expect(HELD_CARRIES_ON_MESSAGE).toContain('even one that would wait for approval too');
    expect(HELD_CARRIES_ON_MESSAGE).toContain('it could then run first, or run although this one was declined');
  });
});
