/** D-341 slice B5 (ruling 11, the owner: "Any site") — a scheduled prompt's browser actions, allowed
 *  ahead: "Always allow browser actions for this scheduled prompt" on its held browser action grants a
 *  pre-approval of every Browser Toolkit write its runs make, on any site, standing for the prompt's
 *  text, checked where the chat's switch is. Uploads still ask.
 *
 *  Driven through the REAL run (`handleExecute`) and commit gateway, the REAL pass seam (with the
 *  owner's pass store), the REAL notification block and preflight answer handler, the REAL resumer
 *  and the REAL trigger pre-approval store and granter. Doubles: the Bridge (it records what it was
 *  asked to do), the resume authority, and the prompt service (its title and the version of its
 *  text). */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type {
  BridgeResult,
  Checkpoint,
  Commit,
  ExecutionSource,
  RecipeDefinition,
} from '@recued/contracts';
import { registerPreflightHandler } from '@recued/gateway';
import {
  createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel,
  type NotificationSettings, type PendingAsk,
} from '@recued/notification';
import {
  createAuditLogStore, createCommitStore, createInMemoryCollection,
  type ActivityEntry, type AuditEntry, type CheckpointStore,
} from '@recued/storage';

import type { BridgeDispatcher, DispatchOutcome } from '../bridges/dispatcher.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createOpAdmissionGate } from '../op-admission-gate.js';
import { createContractOverlayResolver } from '../policy-contract-overlay.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { createRecipeStore } from '../recipe-store.js';
import { createSessionGrantResolver } from '../session-grant-resolver.js';
import { createBrowserPassStore } from '../storage/browser-pass-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createContractScanFn, createContractStore } from '../storage/contract-store.js';
import { createTriggerPreapprovalStore } from '../storage/trigger-preapproval-store.js';
import { createTriggerPreapprovalGranter, triggerPreapprovalRecipeSha256 } from '../trigger-preapproval-rpc.js';

const V1 = '1'.repeat(64);
const V2 = '2'.repeat(64);
const BROWSER = 'browser:any_site';
const PROMPT = { kind: 'prompt_schedule', schedule_id: 'ps_1' } as const;
const ALWAYS = 'Always allow browser actions for this scheduled prompt';

/** A scheduled prompt's run of a Browser Toolkit recipe, as the scheduler stamps it. */
const scheduled = (occurrence: string, version: string = V1, schedule_id = 'ps_1'): ExecutionSource => ({
  channel: 'schedule', actor: 'system', schedule_id, cron: '0 7 * * *', turn_id: `turn-${occurrence}`,
  prompt_schedule: { schedule_id, occurrence_id: occurrence, revision: 3, due_at: 1, cron: '0 7 * * *', prompt_sha256: version },
}) as ExecutionSource;

const clickStep = (ref: string) =>
  ({ id: 'act', op: 'core.dom.click', args: { target: '*://*/*', page: '7:ABCDEF0123', ref } });
const uploadStep = () => ({ id: 'act', op: 'core.dom.act', args: { target: '*://*/*', page: '7:ABCDEF0123',
  steps: [{ do: 'upload', ref: 'e7', file: `file:${'b'.repeat(32)}` }] } });

const recipeOf = (recipe_id: string, step: Record<string, unknown>): RecipeDefinition => ({
  recipe_id, version: 1, ttl: 60,
  metadata: { name: 'Click on a web page', description: 'Clicks.', author: 'test', supported_platforms: ['test'] },
  variables: {}, prefetch_steps: [], steps: [step], output: { sidebar: [] },
} as unknown as RecipeDefinition);

const clicked = (): DispatchOutcome => ({
  kind: 'completed', bridge_client_token_id: 'bridge-1', attempts: 1,
  result: { command_id: 'c', duration_ms: 3, bridge_version: '0.0.3', idempotency_key_seen: false, status: 'ok',
    outputs: { page: '7:ABCDEF0123', url: 'https://example.test/', title: 'Example' } } as BridgeResult,
});

const fixture = (opts: { granter?: boolean } = {}) => {
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipeOf('click-a', clickStep('e12')));
  recipeStore.register(recipeOf('click-b', clickStep('e13')));
  recipeStore.register(recipeOf('upload-cv', uploadStep()));
  const manifests = createManifestRegistry('/nonexistent');
  for (const manifest of KERNEL_MANIFESTS) manifests.register(manifest);
  const contractStore = createContractStore(new Database(':memory:'));
  const definitionStore = createContractDefinitionStore(contractStore);
  const grantEntryStore = createContractGrantEntryStore(contractStore);
  const triggerPreapprovals = createTriggerPreapprovalStore(new Database(':memory:'));
  const auditLog = createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>());
  const sent = vi.fn<BridgeDispatcher['dispatch']>(async () => clicked());
  const clicks = () => sent.mock.calls.map(([request]) => request).filter((request) => request.action === 'click')
    .map((request) => request.args.ref);
  const askStore = createAskStore(createInMemoryCollection<PendingAsk>());
  const block = createNotificationBlock({
    askStore, channels: [createUiChannel({ busSink: () => undefined })],
    settingsStore: createNotificationSettingsStore(createInMemoryCollection<NotificationSettings>()),
  });
  const rows = new Map<string, Checkpoint>();
  const checkpointStore = {
    write: vi.fn(async (c: Checkpoint) => { rows.set(c.checkpoint_id, c); }),
    get: vi.fn(async (id: string) => rows.get(id) ?? null),
    delete: vi.fn(async (id: string) => { rows.delete(id); }),
    listByRun: vi.fn(async (r: string) => [...rows.values()].filter((c) => c.run_id === r)),
    list: vi.fn(async () => [...rows.values()]),
    size: vi.fn(async () => rows.size),
  } as unknown as CheckpointStore;
  // The prompt as its service reads it now: its title, and the version of its text.
  const prompt = { version: V1 };
  const granter = createTriggerPreapprovalGranter({
    store: triggerPreapprovals, recipeStore, manifestOf: (slug) => manifests.get(slug), auditLog,
    prompts: { version: async (id: string) => (id === 'ps_1' ? { title: 'Morning bills', prompt_sha256: prompt.version } : null) },
  });
  const deps = {
    recipeStore, baseVault: {}, instanceId: 'd-341-b5',
    executorConfig: {
      manifests,
      bridgeDispatcherRef: () => ({ dispatch: sent, cancel: vi.fn(), canResolve: vi.fn(() => false) }),
    },
    opAdmissionGate: createOpAdmissionGate({ grantEntryStore, definitionStore }),
    contractOverlay: createContractOverlayResolver({ definitionStore, grantEntryStore }),
    contractScan: createContractScanFn(contractStore),
    commitStore: createCommitStore(createInMemoryCollection<Commit>()),
    checkpointStore, auditLog, preflightNotifier: block,
    browserPasses: createBrowserPassStore(new Database(':memory:')),
    // As the server wires it: a scheduled run's held write would otherwise offer "Allow this session".
    sessionGrantResolver: createSessionGrantResolver({ definitionStore }),
    approvalResumeAuthority: {
      resolve: ({ execution_source }: { execution_source: ExecutionSource }) => ({ admitted: true, execution_source }),
    },
    triggerPreapprovals,
    ...(opts.granter !== false ? { triggerPreapprovalGranter: granter } : {}),
  } as unknown as ExecuteHandlerDeps;
  registerPreflightHandler(block, { checkpointStore, resumer: createPreflightResumer({ getExecuteDeps: () => deps, auditLog }) });
  const run = (recipe_id: string, source: ExecutionSource) => handleExecute(deps, {
    recipe_id, trigger_source: 'schedule', execution_source: source,
  } as Parameters<typeof handleExecute>[1]);
  const open = () => askStore.listByStatus('open');
  const answer = async (option: string) => {
    const [ask] = await open();
    if (ask === undefined) throw new Error('no open ask');
    await block.submitAnswer({ ask_id: ask.ask_id, option, via: 'ui' });
  };
  const activities = async (action: string) => (await auditLog.listActivities()).filter((a) => a.action === action);
  return { run, open, answer, clicks, triggerPreapprovals, granter, prompt, activities, rows,
    recipeOf: (id: string) => recipeStore.get(id)! };
};

describe('D-341 slice B5 — "Always allow browser actions for this scheduled prompt" (ruling 11)', () => {
  it('its held browser action offers it, and no session answer; answered, the action runs and the pre-approval is granted', async () => {
    const f = fixture();
    const held = await f.run('click-a', scheduled('ps_1:3:100'));
    expect(held.awaiting_approval).toBe(true);
    expect(f.clicks()).toEqual([]);
    const [ask] = await f.open();
    expect(ask!.options.map((option) => option.label)).toEqual(['Approve', ALWAYS, 'Deny']);
    expect(ask!.message.text).toContain(`“${ALWAYS}” stops asking about its browser actions, on any site, when it runs on`
      + ' its schedule, up to 100 a run, until you end it on the scheduled prompt\'s page or under Contracts. Sites you'
      + ' blocked, putting your files into a page and sign-in codes still ask. Its AI decides what it does. A change to its'
      + ' prompt asks you again.');
    expect([...f.rows.values()][0]!.preflight_context?.trigger_preapproval).toEqual({
      trigger: PROMPT, recipe_id: 'ps_1', recipe_sha256: V1, op: BROWSER, asks_ai: true,
    });

    await f.answer('allow_trigger');
    await vi.waitFor(() => expect(f.clicks()).toEqual(['e12']));
    expect(f.triggerPreapprovals.list()).toEqual([expect.objectContaining({
      trigger: PROMPT, recipe_id: 'ps_1', recipe_sha256: V1, writes: [BROWSER], max_per_run: 100, uses: 0,
    })]);
    expect((await f.activities('trigger_preapproval_granted')).map((a) => JSON.parse(a.detail!).via)).toEqual(['ask']);
    // Where the owner sees it (its card, Contracts): in its own words, what it does rather than writes.
    const [view] = await f.granter.list('test');
    expect(view).toMatchObject({ state: 'live', write_labels: ['Act in your browser, on any site'],
      description: 'Morning bills, when it runs on its schedule, may do this without asking: act in your browser, on any site.'
        + ' Its AI decides what it does. Up to 100 times a run, until you end it.' });
  });

  it('under it, any of its runs\' browser actions run without asking, on any recipe and element, each use audited', async () => {
    const f = fixture();
    await f.granter.grantOffer({ trigger: PROMPT, recipe_id: 'ps_1', recipe_sha256: V1, op: BROWSER, asks_ai: true }, { run_id: 'approved-run', checkpoint_id: 'approved-checkpoint' });
    const first = await f.run('click-a', scheduled('ps_1:3:200'));
    expect(first.awaiting_approval, JSON.stringify(first.errors)).toBeFalsy();
    const second = await f.run('click-b', scheduled('ps_1:3:200'));
    expect(second.awaiting_approval, JSON.stringify(second.errors)).toBeFalsy();
    expect(f.clicks()).toEqual(['e12', 'e13']);
    expect(await f.open()).toEqual([]);
    expect(f.triggerPreapprovals.list()[0]).toMatchObject({ uses: 2 });
    // Listed newest first: read in the order they were spent.
    const used = (await f.activities('trigger_preapproval_used')).map((a) => JSON.parse(a.detail!) as { uses: number })
      .sort((a, b) => a.uses - b.uses);
    expect(used).toEqual([
      expect.objectContaining({ run_id: 'prompt:ps_1:3:200', op: BROWSER, trigger: PROMPT, uses: 1 }),
      expect.objectContaining({ run_id: 'prompt:ps_1:3:200', op: BROWSER, trigger: PROMPT, uses: 2 }),
    ]);
  });

  it('covers nothing else: an edited prompt, another scheduled prompt, a scheduled recipe; an upload always asks', async () => {
    const f = fixture();
    await f.granter.grantOffer({ trigger: PROMPT, recipe_id: 'ps_1', recipe_sha256: V1, op: BROWSER, asks_ai: true }, { run_id: 'approved-run', checkpoint_id: 'approved-checkpoint' });
    expect((await f.run('click-a', scheduled('ps_1:4:100', V2))).awaiting_approval).toBe(true);
    expect((await f.run('click-a', scheduled('ps_2:1:100', V1, 'ps_2'))).awaiting_approval).toBe(true);
    const recipeSchedule = { channel: 'schedule', actor: 'system', schedule_id: 'ps_1', cron: '0 7 * * *' } as ExecutionSource;
    expect((await f.run('click-a', recipeSchedule)).awaiting_approval).toBe(true);
    // Putting one of the owner's files into a page is always asked about (D-335 AQ), and offers none.
    expect((await f.run('upload-cv', scheduled('ps_1:3:300'))).awaiting_approval).toBe(true);
    const uploadAsk = (await f.open()).at(-1)!;
    expect(uploadAsk.options.map((option) => option.label)).not.toContain(ALWAYS);
    expect(f.clicks()).toEqual([]);
    expect(f.triggerPreapprovals.list()[0]).toMatchObject({ uses: 0 });
  });

  it('a recipe\'s own pre-approval (B6) never stands in for its browser action: those are the prompt\'s (B5)', async () => {
    const f = fixture();
    // As if one were kept for the Toolkit recipe's click: no ask offers it, and none covers it.
    f.triggerPreapprovals.grant({ trigger: PROMPT, recipe_id: 'click-a', recipe_sha256: triggerPreapprovalRecipeSha256(f.recipeOf('click-a')),
      prompt_sha256: V1, writes: ['dom-click'], max_per_run: 1, now: 0 });
    expect((await f.run('click-a', scheduled('ps_1:3:800'))).awaiting_approval).toBe(true);
    expect(f.clicks()).toEqual([]);
    expect(f.triggerPreapprovals.list()[0]).toMatchObject({ uses: 0 });
    // Its ask offers the prompt's own, for its browser actions.
    expect([...f.rows.values()].at(-1)!.preflight_context?.trigger_preapproval).toMatchObject({ op: BROWSER });
  });

  it('a prompt changed since the ask: the answer approves the action and grants nothing; no granter, no offer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const f = fixture();
      await f.run('click-a', scheduled('ps_1:3:100'));
      f.prompt.version = V2;
      await f.answer('allow_trigger');
      await vi.waitFor(() => expect(f.clicks()).toEqual(['e12']));
      expect(f.triggerPreapprovals.list()).toEqual([]);

      const g = fixture({ granter: false });
      await g.run('click-a', scheduled('ps_1:3:100'));
      const [ask] = await g.open();
      expect(ask!.options.map((option) => option.label)).not.toContain(ALWAYS);
    } finally {
      warn.mockRestore();
    }
  });
});
