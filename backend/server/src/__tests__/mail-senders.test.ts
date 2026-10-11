/** An owner's run sends from the only mailbox that can, and is told the names
 *  otherwise.
 *
 *  ⛔ With one mailbox that could send, Chat still asked "Which mail account
 *  should I send it from?" (live drive, 2026-10-10), and an empty "Send from"
 *  failed the send only after the owner had approved it. The owner's rule: with
 *  one mailbox that can send there is nothing to ask. */

import { describe, expect, it } from 'vitest';

import { RpcError } from '@recued/contracts';
import type { ExecutionSource, RecipeDefinition } from '@recued/contracts';

import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import {
  isLiveSendCapableMailInstance,
  sendCapableMailboxes,
  settleMailSenders,
} from '../mail-senders.js';
import { mailSenderSettings } from '@recued/recipes';

const SEND_FROM = { label: 'Send from', type: 'string', default: '' };

/** A send the run skips, so nothing is dispatched, and a step that shows the
 *  mailbox the run settled on. */
const sendRecipe = (variables: Record<string, unknown> = { sender_mail_instance: SEND_FROM }): RecipeDefinition =>
  ({
    recipe_id: 'send-a-note',
    version: 1,
    ttl: 60,
    metadata: { name: 'Send a note', description: 'One email.', author: 'test', supported_platforms: [] },
    variables,
    prefetch_steps: [],
    steps: [
      { id: 'from', transform: 'coalesce', values: ['{{config.sender_mail_instance}}'] },
      {
        id: 'send',
        op: 'core.mail.send',
        skip_when: '{{step.from}} not_equal never',
        args: { sender_mail_instance: '{{config.sender_mail_instance}}', to: ['dana@sandhurst.test'], subject: 'Hi', body: 'Hello' },
      },
    ],
    output: { render: [{ type: 'text', source: 'step.from' }] },
  }) as unknown as RecipeDefinition;

describe('settling "Send from"', () => {
  const r = sendRecipe();
  const settle = (config: Record<string, unknown>, senders: string[]) =>
    settleMailSenders(r, config, mailSenderSettings(r), senders);
  const refusal = (fn: () => unknown): RpcError => {
    try { fn(); } catch (e) { return e as RpcError; }
    throw new Error('expected a refusal');
  };

  it('empty, with one mailbox that can send: that mailbox', () => {
    expect(settle({}, ['bench-mail'])).toEqual({ sender_mail_instance: 'bench-mail' });
    expect(settle({ sender_mail_instance: '  ' }, ['bench-mail'])).toEqual({ sender_mail_instance: 'bench-mail' });
    expect(settle({ sender_mail_instance: null, to: ['x@y.z'] }, ['bench-mail']))
      .toEqual({ sender_mail_instance: 'bench-mail', to: ['x@y.z'] });
  });

  it('empty, with several: refused, naming them, so the owner can be asked', () => {
    const e = refusal(() => settle({}, ['bench-mail', 'work-mail']));
    expect(e).toBeInstanceOf(RpcError);
    expect(e.code).toBe('mail_sender_required');
    expect(e.message).toBe(
      'Recipe \'send-a-note\' cannot send: "Send from" (sender_mail_instance) is empty, and 2 mailboxes on this server can send: bench-mail, work-mail. Set it to one of them and run again.',
    );
    expect(e.details).toEqual({ variable: 'sender_mail_instance', candidates: ['bench-mail', 'work-mail'] });
  });

  it('empty, with none: refused, saying so', () => {
    const e = refusal(() => settle({}, []));
    expect(e.message).toBe(
      'Recipe \'send-a-note\' cannot send: "Send from" (sender_mail_instance) is empty, and no mailbox on this server can send. Connect one that can under Connections → Mail.',
    );
    expect(e.details).toEqual({ variable: 'sender_mail_instance', candidates: [] });
  });

  it('named: kept when it can send; refused, naming those that can, when it cannot', () => {
    const config = { sender_mail_instance: 'work-mail' };
    expect(settle(config, ['bench-mail', 'work-mail'])).toBe(config);
    const e = refusal(() => settle({ sender_mail_instance: 'Work account' }, ['bench-mail', 'work-mail']));
    expect(e.message).toBe(
      'Recipe \'send-a-note\' cannot send: "Send from" (sender_mail_instance) is \'Work account\', which is not a mailbox on this server that can send. Mailboxes that can send: bench-mail, work-mail.',
    );
    expect(e.details).toEqual({ variable: 'sender_mail_instance', candidates: ['bench-mail', 'work-mail'], named: 'Work account' });
    expect(refusal(() => settle({ sender_mail_instance: 'bench-mail' }, [])).message).toContain(
      'No mailbox on this server can send; connect one that can under Connections → Mail.',
    );
  });

  it('left alone: a default the author chose, and a value that is not text', () => {
    const authored = sendRecipe({ sender_mail_instance: { ...SEND_FROM, default: 'support-mail' } });
    expect(settleMailSenders(authored, {}, mailSenderSettings(authored), ['bench-mail', 'work-mail'])).toEqual({});
    const config = { sender_mail_instance: 7 };
    expect(settle(config, ['bench-mail'])).toBe(config);
  });
});

describe('the mailboxes that can send', () => {
  const collection = (slug: string, over: Record<string, unknown> = {}) =>
    ({ platform: 'mail', slug, sendCapable: true, send: async () => ({}), ...over });
  const registryOf = (collections: Array<Record<string, unknown>>) => ({
    list: () => collections as never[],
    get: (platform: string, slug: string) =>
      collections.find((c) => c.platform === platform && c.slug === slug) as never,
  });

  it('only those whose send is live, in registration order', () => {
    const registry = registryOf([
      collection('bench-mail'),
      collection('read-only', { sendCapable: false }),
      collection('no-sender', { send: undefined }),
      { platform: 'calendar', slug: 'work-cal' },
      collection('work-mail'),
    ]);
    expect(sendCapableMailboxes(registry)).toEqual(['bench-mail', 'work-mail']);
    expect(isLiveSendCapableMailInstance(registry, 'read-only')).toBe(false);
  });
});

describe('a run', () => {
  const OWNER: ExecutionSource = { channel: 'user', actor: 'user_self', user_id: 'owner-1', client_token_id: 'tok-1' };
  /** The real kernel `mail-send`: the policy check reads every step's manifest
   *  before the run, a skipped one too. */
  const manifests = () => {
    const registry = createManifestRegistry('/nonexistent');
    registry.register(KERNEL_MANIFESTS.find((m) => m.slug === 'mail-send')!);
    return registry;
  };
  const deps = (senders: string[] | undefined, over: Partial<ExecuteHandlerDeps> = {}): ExecuteHandlerDeps => ({
    recipeStore: createRecipeStore('/nonexistent'),
    executorConfig: { manifests: manifests() },
    baseVault: {},
    instanceId: 'mail-senders-spec',
    ...(senders !== undefined ? { listSendCapableMailboxes: () => senders } : {}),
    ...over,
  });
  const from = async (d: ExecuteHandlerDeps, req: Record<string, unknown> = {}, internal?: Record<string, unknown>) => {
    const response = await handleExecute(d, { recipe: sendRecipe(), trigger_source: 'chat', execution_source: OWNER, ...req } as never, internal as never);
    expect(response.errors).toEqual([]);
    return (response.output.render[0] as { data?: unknown } | undefined)?.data;
  };

  it('the owner\'s run with "Send from" empty sends from the one mailbox that can', async () => {
    expect(await from(deps(['bench-mail']))).toBe('bench-mail');
  });

  it('with several, it is refused before anything runs, naming them', async () => {
    await expect(from(deps(['bench-mail', 'work-mail']))).rejects.toMatchObject({
      code: 'mail_sender_required',
      details: { candidates: ['bench-mail', 'work-mail'] },
    });
  });

  it('the recipe\'s main dish naming one is the owner\'s choice, kept', async () => {
    const dishStore = {
      listByRecipe: () => [{ dish_id: 'd1', name: '', is_default: true, config_overlay: { sender_mail_instance: 'work-mail' } }],
    } as unknown as ExecuteHandlerDeps['dishStore'];
    expect(await from(deps(['bench-mail', 'work-mail'], { dishStore }))).toBe('work-mail');
  });

  it('untouched: a run that is not the owner\'s, and a server that cannot list mailboxes', async () => {
    let asked = 0;
    const counting = deps(undefined, { listSendCapableMailboxes: () => { asked += 1; return ['bench-mail']; } });
    // Each keeps the declared empty default, as before.
    expect(await from(counting, { execution_source: undefined })).toBe('');
    expect(asked).toBe(0);
    expect(await from(deps(undefined))).toBe('');
  });

  it('a resumed run is not settled again: it sends from the config its approval holds', async () => {
    let asked = 0;
    const two = deps(undefined, { listSendCapableMailboxes: () => { asked += 1; return ['bench-mail', 'work-mail']; } });
    const response = await handleExecute(
      two,
      { recipe: sendRecipe(), trigger_source: 'chat', execution_source: OWNER } as never,
      { run_id: 'resume-1', resume_from: { gated_step_id: 'send', step_state: {} } } as never,
    );
    // Two mailboxes and an empty "Send from" would be refused on a first run.
    expect(response.errors).toEqual([]);
    expect(asked).toBe(0);
  });
});
