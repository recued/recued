/** An owner's run sends from the only mailbox that can, and is told the
 *  mailboxes otherwise, each with its address.
 *
 *  ⛔ With one mailbox that could send, Chat still asked "Which mail account
 *  should I send it from?" (live drive, 2026-10-10), and an empty "Send from"
 *  failed the send only after the owner had approved it. The owner's rule: with
 *  one mailbox that can send there is nothing to ask.
 *
 *  ⛔ With two, told only their names, Chat asked "Which one is your Gmail?"
 *  of an owner who had written "send an email from my Gmail" (live, 2026-10-18):
 *  a name is whatever the mailbox was connected under. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { afterEach, describe, expect, it } from 'vitest';

import { RpcError } from '@recued/contracts';
import type { ExecutionSource, RecipeDefinition } from '@recued/contracts';

import { createInstanceStore } from '../collections/instance-store.js';
import { createMailCollection, type MailCollection } from '../collections/mail/mail-collection.js';
import type { MailProvider } from '../collections/mail/provider.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import {
  isLiveSendCapableMailInstance,
  mailboxAddressOf,
  sendCapableMailboxes,
  settleMailSenders,
  type SendCapableMailbox,
} from '../mail-senders.js';
import { createBlobStore } from '../storage/blob-store.js';
import { mailSenderSettings } from '@recued/recipes';

const SEND_FROM = { label: 'Send from', type: 'string', default: '' };

const BENCH: SendCapableMailbox = { name: 'bench-mail', address: 'me@gmail.test', provider: 'Gmail' };
const WORK: SendCapableMailbox = { name: 'work-mail', address: 'me@work.test', provider: 'Outlook' };

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
  const settle = (config: Record<string, unknown>, senders: SendCapableMailbox[]) =>
    settleMailSenders(r, config, mailSenderSettings(r), senders);
  const refusal = (fn: () => unknown): RpcError => {
    try { fn(); } catch (e) { return e as RpcError; }
    throw new Error('expected a refusal');
  };

  it('empty, with one mailbox that can send: that mailbox', () => {
    expect(settle({}, [BENCH])).toEqual({ sender_mail_instance: 'bench-mail' });
    expect(settle({ sender_mail_instance: '  ' }, [BENCH])).toEqual({ sender_mail_instance: 'bench-mail' });
    expect(settle({ sender_mail_instance: null, to: ['x@y.z'] }, [BENCH]))
      .toEqual({ sender_mail_instance: 'bench-mail', to: ['x@y.z'] });
  });

  it('empty, with several: refused, naming each with its address, so the owner can be asked', () => {
    const e = refusal(() => settle({}, [BENCH, WORK]));
    expect(e).toBeInstanceOf(RpcError);
    expect(e.code).toBe('mail_sender_required');
    expect(e.message).toBe(
      'Recipe \'send-a-note\' cannot send: "Send from" (sender_mail_instance) is empty, and 2 mailboxes on this server can send: bench-mail (me@gmail.test, Gmail), work-mail (me@work.test, Outlook). Set it to one of them and run again.',
    );
    expect(e.details).toEqual({ variable: 'sender_mail_instance', candidates: ['bench-mail', 'work-mail'] });
  });

  it('a mailbox is listed by what is known of it', () => {
    const e = refusal(() => settle({}, [
      { name: 'home', address: 'me@home.test', provider: '' },
      { name: 'old-imap', address: '', provider: 'IMAP' },
      { name: 'bare', address: '', provider: '' },
    ]));
    expect(e.message).toContain('3 mailboxes on this server can send: home (me@home.test), old-imap (IMAP), bare.');
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
    expect(settle(config, [BENCH, WORK])).toBe(config);
    const e = refusal(() => settle({ sender_mail_instance: 'Work account' }, [BENCH, WORK]));
    expect(e.message).toBe(
      'Recipe \'send-a-note\' cannot send: "Send from" (sender_mail_instance) is \'Work account\', which is not a mailbox on this server that can send. Mailboxes that can send: bench-mail (me@gmail.test, Gmail), work-mail (me@work.test, Outlook).',
    );
    expect(e.details).toEqual({ variable: 'sender_mail_instance', candidates: ['bench-mail', 'work-mail'], named: 'Work account' });
    expect(refusal(() => settle({ sender_mail_instance: 'bench-mail' }, [])).message).toContain(
      'No mailbox on this server can send; connect one that can under Connections → Mail.',
    );
  });

  it('an address: the one mailbox that sends as it, by the name the send takes', () => {
    expect(settle({ sender_mail_instance: 'me@work.test', to: ['x@y.z'] }, [BENCH, WORK]))
      .toEqual({ sender_mail_instance: 'work-mail', to: ['x@y.z'] });
    // As the owner might type it.
    expect(settle({ sender_mail_instance: ' Me@Gmail.test ' }, [BENCH, WORK]))
      .toEqual({ sender_mail_instance: 'bench-mail' });
    // The address of a mailbox that cannot send is no mailbox that can.
    expect(refusal(() => settle({ sender_mail_instance: 'me@home.test' }, [BENCH, WORK])).message)
      .toContain('is \'me@home.test\', which is not a mailbox on this server that can send.');
  });

  it('an address two mailboxes send as: refused, naming them, for the owner to choose', () => {
    const imap: SendCapableMailbox = { name: 'bench-imap', address: 'me@gmail.test', provider: 'IMAP' };
    const e = refusal(() => settle({ sender_mail_instance: 'me@gmail.test' }, [BENCH, imap, WORK]));
    expect(e.message).toBe(
      'Recipe \'send-a-note\' cannot send: "Send from" (sender_mail_instance) is \'me@gmail.test\', the address of more than one mailbox on this server that can send. Mailboxes that can send: bench-mail (me@gmail.test, Gmail), bench-imap (me@gmail.test, IMAP), work-mail (me@work.test, Outlook).',
    );
    expect(e.details).toEqual({
      variable: 'sender_mail_instance', candidates: ['bench-mail', 'bench-imap', 'work-mail'], named: 'me@gmail.test',
    });
  });

  it('left alone: a default the author chose, and a value that is not text', () => {
    const authored = sendRecipe({ sender_mail_instance: { ...SEND_FROM, default: 'support-mail' } });
    expect(settleMailSenders(authored, {}, mailSenderSettings(authored), [BENCH, WORK])).toEqual({});
    const config = { sender_mail_instance: 7 };
    expect(settle(config, [BENCH])).toBe(config);
  });
});

describe('the mailboxes that can send', () => {
  const collection = (slug: string, over: Record<string, unknown> = {}) =>
    ({
      platform: 'mail', slug, sendCapable: true, send: async () => ({}),
      accountEmail: `${slug}@mail.test`, provider: { kind: 'gmail' }, ...over,
    });
  const registryOf = (collections: Array<Record<string, unknown>>) => ({
    list: () => collections as never[],
    get: (platform: string, slug: string) =>
      collections.find((c) => c.platform === platform && c.slug === slug) as never,
  });

  it('only those whose send is live, in registration order, each with its address and provider', () => {
    const registry = registryOf([
      collection('bench-mail'),
      collection('read-only', { sendCapable: false }),
      collection('no-sender', { send: undefined }),
      { platform: 'calendar', slug: 'work-cal' },
      collection('work-mail', { accountEmail: ' me@work.test ', provider: { kind: 'graph' } }),
    ]);
    expect(sendCapableMailboxes(registry)).toEqual([
      { name: 'bench-mail', address: 'bench-mail@mail.test', provider: 'Gmail' },
      { name: 'work-mail', address: 'me@work.test', provider: 'Outlook' },
    ]);
    expect(isLiveSendCapableMailInstance(registry, 'read-only')).toBe(false);
  });

  it('what is not known of a mailbox is empty, never a guess', () => {
    expect(mailboxAddressOf({})).toEqual({ address: '', provider: '' });
    expect(mailboxAddressOf({ accountEmail: 7, provider: null })).toEqual({ address: '', provider: '' });
    expect(mailboxAddressOf({ accountEmail: 'a@b.test', provider: { kind: 'imap' } }))
      .toEqual({ address: 'a@b.test', provider: 'IMAP' });
    // Only the providers it knows; an inherited key is not one.
    expect(mailboxAddressOf({ provider: { kind: 'exchange' } }).provider).toBe('');
    expect(mailboxAddressOf({ provider: { kind: 'toString' } }).provider).toBe('');
  });

  describe('read from real mail collections', () => {
    let db: Database.Database | undefined;
    let dir: string | undefined;
    const open: MailCollection[] = [];
    afterEach(async () => {
      for (const c of open.splice(0)) await c.close();
      db?.close();
      if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    });

    const mailbox = async (slug: string, kind: MailProvider['kind'], accountEmail: string): Promise<MailCollection> => {
      db ??= new Database(':memory:');
      dir ??= await mkdtemp(join(tmpdir(), 'mail-senders-'));
      const instances = createInstanceStore({ db });
      instances.upsert({
        platform: 'mail', slug, adapter_type: kind, config: {}, caps: {} as never, auth_state: 'healthy', last_synced_at: null,
      });
      const provider: MailProvider = {
        kind, slug, sendCapable: true, mutationCapable: false, accountEmail,
        async connect() {},
        async initialScan() {},
        async startSync() { return async () => {}; },
        async close() {},
        health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 }),
      };
      const c = createMailCollection({
        db, blobs: createBlobStore(join(dir, `blobs-${slug}`)), bus: createWarehouseEventBus(), slug, provider, instances,
        now: () => 1_800_000_000_000,
        gate: { addUsed: () => {}, getUsed: () => 0 } as never,
        config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 1024 * 1024 }),
      });
      open.push(c);
      return c;
    };

    it('each by the address it signed in as and its provider, as the run is told them', async () => {
      const registry = createCollectionRegistry();
      registry.register(await mailbox('recueddev', 'gmail', 'recued.dev@gmail.com'));
      registry.register(await mailbox('outlook', 'graph', 'recued.dev@outlook.com'));
      expect(sendCapableMailboxes(registry)).toEqual([
        { name: 'recueddev', address: 'recued.dev@gmail.com', provider: 'Gmail' },
        { name: 'outlook', address: 'recued.dev@outlook.com', provider: 'Outlook' },
      ]);
    });
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
  const deps = (senders: SendCapableMailbox[] | undefined, over: Partial<ExecuteHandlerDeps> = {}): ExecuteHandlerDeps => ({
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
    expect(await from(deps([BENCH]))).toBe('bench-mail');
  });

  it('with several, it is refused before anything runs, naming each with its address', async () => {
    await expect(from(deps([BENCH, WORK]))).rejects.toMatchObject({
      code: 'mail_sender_required',
      message: expect.stringContaining('bench-mail (me@gmail.test, Gmail), work-mail (me@work.test, Outlook)'),
      details: { candidates: ['bench-mail', 'work-mail'] },
    });
  });

  it('the owner\'s run given an address sends from the mailbox that sends as it', async () => {
    expect(await from(deps([BENCH, WORK]), { config: { sender_mail_instance: 'me@work.test' } })).toBe('work-mail');
  });

  it('the recipe\'s main dish naming one is the owner\'s choice, kept', async () => {
    const dishStore = {
      listByRecipe: () => [{ dish_id: 'd1', name: '', is_default: true, config_overlay: { sender_mail_instance: 'work-mail' } }],
    } as unknown as ExecuteHandlerDeps['dishStore'];
    expect(await from(deps([BENCH, WORK], { dishStore }))).toBe('work-mail');
  });

  it('untouched: a run that is not the owner\'s, and a server that cannot list mailboxes', async () => {
    let asked = 0;
    const counting = deps(undefined, { listSendCapableMailboxes: () => { asked += 1; return [BENCH]; } });
    // Each keeps the declared empty default, as before.
    expect(await from(counting, { execution_source: undefined })).toBe('');
    expect(asked).toBe(0);
    expect(await from(deps(undefined))).toBe('');
  });

  it('a resumed run is not settled again: it sends from the config its approval holds', async () => {
    let asked = 0;
    const two = deps(undefined, { listSendCapableMailboxes: () => { asked += 1; return [BENCH, WORK]; } });
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
