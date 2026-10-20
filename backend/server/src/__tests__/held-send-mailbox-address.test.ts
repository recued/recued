/** A held send names the mailbox it goes from by its address.
 *
 *  ⛔ The approval for an email chat send listed `sender_mail_instance:
 *  recueddev` in its email, and the card read "Sender mail instance: recueddev"
 *  (live, 2026-10-19): the name the call passes the mailbox by, not what the
 *  owner knows it by. The owner: "the sender_mail_instance can be email address
 *  as well". The run records each sending mailbox's address when it is held, and
 *  the ask's argument lines and the card's rows both read that record.
 *
 *  The real run writes the checkpoint; the real batch coordinator raises the ask
 *  from it, as it raised the live one (a send is held as a one-member batch);
 *  the real card resolver reads it back. */

import { describe, expect, it, vi } from 'vitest';
import {
  isCheckpoint, type Checkpoint, type ExecutionSource, type IngredientManifest, type RecipeDefinition,
} from '@recued/contracts';
import { PREFLIGHT_HANDLER_KIND } from '@recued/gateway';
import {
  createAuditLogStore, createBatchAskStore, createInMemoryCollection, type ActivityEntry, type AuditEntry,
} from '@recued/storage';
import type { PendingAsk } from '@recued/notification';

import { createAskCardDetailResolver } from '../ask-card-held-op-details.js';
import { createBatchApprovalCoordinator } from '../batch-approval.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import type { SendCapableMailbox } from '../mail-senders.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';

const MAILBOXES: readonly SendCapableMailbox[] = [
  { name: 'recueddev', address: 'recued.dev@gmail.com', provider: 'Gmail' },
  { name: 'outlook', address: 'recued.dev@outlook.com', provider: 'Outlook' },
  // A mailbox whose provider has not said its address keeps its name.
  { name: 'old-imap', address: '', provider: 'IMAP' },
];

const owner: ExecutionSource = { channel: 'user', actor: 'user_self', user_id: 'owner-1', client_token_id: 'client-1' };
/** One chat turn: the sends it holds join one approval. */
const turn: ExecutionSource = {
  channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'owner-1', turn_id: 'turn-1',
} as ExecutionSource;

const auditLog = () => createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>());

/** Run one held write for the owner and return the checkpoint it wrote. */
const hold = async (
  recipe: RecipeDefinition,
  manifest: Record<string, unknown>,
  config: Record<string, unknown>,
  listSendCapableMailboxes?: () => readonly SendCapableMailbox[],
): Promise<Checkpoint> => {
  const manifests = createManifestRegistry('/nonexistent');
  manifests.register({
    name: manifest.slug, description: 'Test manifest', author: 'recued', kind: 'storage', version: 1,
    category: 'action', input: {}, output: { id: 'id' }, ...manifest,
  } as unknown as IngredientManifest);
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe);
  const checkpoints: Checkpoint[] = [];
  const deps: ExecuteHandlerDeps = {
    recipeStore,
    executorConfig: { manifests, kernelDispatchers: { mailSend: vi.fn() } as never },
    baseVault: {},
    instanceId: 'held-send-mailbox-address',
    checkpointStore: {
      write: vi.fn(async (cp: Checkpoint) => { checkpoints.push(cp); }),
    } as unknown as ExecuteHandlerDeps['checkpointStore'],
    auditLog: auditLog(),
    preflightNotifier: {
      ask: vi.fn(async () => ({ ask_id: 'ask-plain' })), registerAskHandler: vi.fn(), notify: vi.fn(async () => undefined),
    },
    ...(listSendCapableMailboxes !== undefined ? { listSendCapableMailboxes } : {}),
  };
  const response = await handleExecute(deps, {
    recipe_id: recipe.recipe_id, trigger_source: 'chat', execution_source: owner, config,
  });
  expect(response.awaiting_approval, JSON.stringify(response.errors)).toBe(true);
  expect(checkpoints).toHaveLength(1);
  return checkpoints[0]!;
};

const SEND_RECIPE = {
  recipe_id: 'send-a-note', version: 1, ttl: 60,
  metadata: { name: 'Send a note', description: 'One email.', author: 'test', supported_platforms: ['test'] },
  variables: { sender_mail_instance: { type: 'string', label: 'Send from', default: '' } },
  prefetch_steps: [],
  steps: [{
    id: 'send', ingredient: 'mail-send',
    input: { sender_mail_instance: '{{config.sender_mail_instance}}', to: ['bob@example.com'], subject: 'Renewal', body: 'hello' },
  }],
  output: { sidebar: [] },
} as unknown as RecipeDefinition;

/** The owner's send, given its "Send from" as they gave it, held for approval. */
const holdSend = (sender: string, mailboxes: () => readonly SendCapableMailbox[] = () => MAILBOXES) =>
  hold(SEND_RECIPE, { slug: 'mail-send', risk_tier: 'write' }, { sender_mail_instance: sender }, mailboxes);

const heldInput = (checkpoint: Checkpoint): Record<string, unknown> =>
  (checkpoint.step_state.send as { input: Record<string, unknown> }).input;

/** The text the approval email carries for these held sends, raised by the
 *  real batch coordinator from the checkpoints the runs wrote: one batch, one
 *  member per send, each previewing the call the run held. */
const askText = async (checkpoints: readonly Checkpoint[]): Promise<string> => {
  const rows = new Map(checkpoints.map((cp) => [cp.checkpoint_id, cp]));
  const texts: string[] = [];
  const coordinator = createBatchApprovalCoordinator({
    batchAskStore: createBatchAskStore(createInMemoryCollection()),
    checkpointStore: {
      get: vi.fn(async (id: string) => rows.get(id) ?? null),
      write: vi.fn(async (cp: Checkpoint) => { rows.set(cp.checkpoint_id, cp); }),
      delete: vi.fn(async () => undefined),
      list: vi.fn(async () => [...rows.values()]),
    } as never,
    resumer: { resume: vi.fn(), deny: vi.fn() } as never,
    notifier: {
      ask: vi.fn(async (message: { text: string }) => { texts.push(message.text); return { ask_id: `ask-${texts.length}` }; }),
      registerAskHandler: vi.fn(),
      notify: vi.fn(async () => undefined),
    },
    listUnresolvedAsks: async () => [],
    cancelAsk: async () => 'cancelled',
  });
  for (const [i, checkpoint] of checkpoints.entries()) {
    await coordinator.registerHold({
      source: turn, run_id: checkpoint.run_id, correlation_id: 'turn-1', channel_session_id: 'chat-1',
      ingredient_slug: 'mail-send', risk_tier: 'write',
      authorization_provenance: { pre_lift_approval: 'ask', lift_reason: 'review_send' },
      recipe_id: checkpoint.recipe_id!, recipe_hash: 'recipe-hash', arg_shape_hash: 'arg-shape',
      canonical_payload_hash: `payload-${i}`,
      args_preview: heldInput(checkpoint),
      checkpoint,
      ask_context: { tool_slug: 'mail-send', risk_tier: 'write', reason: checkpoint.preflight_context?.reason ?? 'held' },
    });
  }
  return texts.at(-1)!;
};

/** The card's rows for the held run, as `notification.pending_asks` serves them. */
const cardRows = async (checkpoint: Checkpoint) => {
  const resolve = createAskCardDetailResolver({
    getCheckpoint: async (id) => (id === checkpoint.checkpoint_id ? checkpoint : null),
    getAnchor: async () => ({ commit_status: 'awaiting_approval', recipe_id: checkpoint.recipe_id } as AuditEntry),
    // A Recued built-in send declares no reviewable fields: its rows come from
    // its bundled manifest, the path the live card took.
    resolveArgEditSchema: () => ({ fields: [] }),
    timeZone: 'UTC',
  });
  return resolve({
    ask_id: 'ask-1', handler_kind: PREFLIGHT_HANDLER_KIND,
    handler_payload: { checkpoint_id: checkpoint.checkpoint_id },
  } as unknown as PendingAsk);
};

describe('a held send names its mailbox by address', () => {
  it('given the address, the run sends from the mailbox, and the approval shows the address', async () => {
    const checkpoint = await holdSend('recued.dev@gmail.com');
    // The call carries the name the send takes …
    expect(heldInput(checkpoint).sender_mail_instance).toBe('recueddev');
    // … and the run recorded what the owner knows each sending mailbox by.
    expect(checkpoint.preflight_context?.value_labels).toEqual({
      sender_mail_instance: {
        recueddev: 'recued.dev@gmail.com (Gmail)',
        outlook: 'recued.dev@outlook.com (Outlook)',
      },
    });
    expect(isCheckpoint(checkpoint)).toBe(true);

    const text = await askText([checkpoint]);
    expect(text).toContain('\n  sender_mail_instance: recued.dev@gmail.com (Gmail)\n');
    expect(text).not.toContain('recueddev');

    const rows = await cardRows(checkpoint);
    expect(rows).toContainEqual({ label: 'from', value: 'recued.dev@gmail.com (Gmail)' });
    expect(JSON.stringify(rows)).not.toContain('recueddev');
  });

  it('given the name, the approval shows the address all the same', async () => {
    const checkpoint = await holdSend('outlook');
    expect(await askText([checkpoint])).toContain('\n  sender_mail_instance: recued.dev@outlook.com (Outlook)\n');
    expect(await cardRows(checkpoint)).toContainEqual({
      label: 'from', value: 'recued.dev@outlook.com (Outlook)',
    });
  });

  it('two sends from two mailboxes in one approval: each line names its own address', async () => {
    const text = await askText([await holdSend('recueddev'), await holdSend('outlook')]);
    expect(text).toContain('"Send a note" is waiting for your approval to run 2 actions, all from this chat turn.');
    expect(text).toContain('\n  1. sender_mail_instance: recued.dev@gmail.com (Gmail)\n');
    expect(text).toContain('\n  2. sender_mail_instance: recued.dev@outlook.com (Outlook)\n');
  });

  it('two sends from one mailbox share it, by its address', async () => {
    const text = await askText([await holdSend('recueddev'), await holdSend('recued.dev@gmail.com')]);
    expect(text).toContain('All 2 are the same call:\n');
    expect(text).toContain('\n  sender_mail_instance: recued.dev@gmail.com (Gmail)\n');
  });

  it('a mailbox whose address is unknown keeps its name', async () => {
    const checkpoint = await holdSend('old-imap');
    expect(checkpoint.preflight_context?.value_labels?.sender_mail_instance).not.toHaveProperty('old-imap');
    expect(await askText([checkpoint])).toContain('\n  sender_mail_instance: old-imap\n');
    expect(await cardRows(checkpoint)).toContainEqual({ label: 'from', value: 'old-imap' });
  });

  it('a mailbox list that throws costs the label, never the hold', async () => {
    let calls = 0;
    // Settling the "Send from" reads the list first; the hold's read throws.
    const checkpoint = await holdSend('recueddev', () => {
      calls += 1;
      if (calls > 1) throw new Error('registry gone');
      return MAILBOXES;
    });
    expect(calls).toBe(2);
    expect(checkpoint.preflight_context?.value_labels).toBeUndefined();
    expect(await askText([checkpoint])).toContain('\n  sender_mail_instance: recueddev\n');
  });

  it('a held call that sends from no mailbox records nothing', async () => {
    const checkpoint = await hold({
      recipe_id: 'tidy-notes', version: 1, ttl: 60,
      metadata: { name: 'Tidy notes', description: 'Removes a note.', author: 'test', supported_platforms: ['test'] },
      variables: {}, prefetch_steps: [],
      steps: [{ id: 'send', ingredient: 'note-delete', input: { note_id: 'n1' } }],
      output: { sidebar: [] },
    } as unknown as RecipeDefinition, { slug: 'note-delete', risk_tier: 'destructive' }, {}, () => MAILBOXES);
    expect(checkpoint.preflight_context).toBeDefined();
    expect(checkpoint.preflight_context?.value_labels).toBeUndefined();
  });

  it('a malformed record names nothing, and the checkpoint still loads', async () => {
    const checkpoint = await holdSend('recueddev');
    for (const value_labels of [
      'recued.dev@gmail.com',
      { sender_mail_instance: 'recued.dev@gmail.com' },
      { sender_mail_instance: { recueddev: 42 } },
      { sender_mail_instance: [] },
      { sender_mail_instance: { recueddev: '   ' } },
    ]) {
      const bad = { ...checkpoint, preflight_context: { ...checkpoint.preflight_context, value_labels } } as unknown as Checkpoint;
      expect(isCheckpoint(bad)).toBe(true);
      expect(await cardRows(bad)).toContainEqual({ label: 'from', value: 'recueddev' });
      expect(await askText([bad])).toContain('\n  sender_mail_instance: recueddev\n');
    }
  });
});
