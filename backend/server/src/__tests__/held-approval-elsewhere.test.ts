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

import { wrapRecipeRunResult } from '../chat-tool-handlers.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import {
  approvalElsewhereMessage,
  HELD_FOR_APPROVAL_MESSAGE,
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
const run = async (reader?: ExecuteHandlerDeps['approvalAskChannels'], notifier = true) => {
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
  return { response, held: wrapRecipeRunResult(response) as { ok: boolean; result: AgentHeldRunResult } };
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
