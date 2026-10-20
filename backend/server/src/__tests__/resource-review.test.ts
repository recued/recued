import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isCheckpoint, type Commit,
  type CanonicalEvent, type InternalToolRegistry, type ResourceReview, type ToolEntry,
  type Checkpoint, type RecipeDefinition,
} from '@recued/contracts';
import { executeRecipe, resumeFromApproval } from '@recued/engine';
import { planApproval, wrapWithCommitGateway, buildPreflightAsk } from '@recued/gateway';
import { createCommitStore, createInMemoryCollection, createCheckpointStore, createAuditLogStore } from '@recued/storage';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { composeCalendarStack, type CalendarStack } from '../collections/calendar/compose.js';
import { createCalendarTable } from '../collections/calendar/calendar-table.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { createLocalCalendarAdapterFactory, LOCAL_CALENDAR_CAPS } from '../collections/calendar/local-provider.js';
import { createResourceReviewHooks, currentResourceReview } from '../resource-review.js';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import { ensureChatSchema, createChatStore } from '../storage/chat-store.js';
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';
import { buildChatTier1Handlers } from '../chat-tool-handlers.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { createNamespaceStores } from '../server-executor.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { createGatedActionStore, type GatedActionRecord } from '../gated-action-store.js';

const NOW = Date.parse('2026-10-17T14:00:00Z');
const event: CanonicalEvent = {
  source_id: 'meeting', calendar_id: 'local', ical_uid: 'meeting@local',
  summary: 'Meeting', start_at: NOW, end_at: NOW + 3600_000, timezone: 'UTC',
  is_all_day: false, status: 'confirmed', created_at: NOW, updated_at: NOW,
};
const disposers: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); });

const fixture = async () => {
  const db = new Database(':memory:');
  const bus = createWarehouseEventBus();
  let stack: CalendarStack;
  const tables = new Map<string, ReturnType<typeof createCalendarTable>>();
  stack = composeCalendarStack(db, {
    blobs: { put: async () => 'blob', get: async () => null, delete: async () => {} } as never,
    bus, getGate: () => ({ addUsed() {}, setUsed() {},
      info: () => ({ surface: 'test', used: 0, quota: 1e12, reservePct: 0, state: 'healthy' }) }) as never,
  }, { now: () => NOW, factories: [createLocalCalendarAdapterFactory({ now: () => NOW,
    readEvent: (slug, id) => tables.get(slug)?.get(id)?.event ?? null })] });
  createInstanceStore({ db }).upsert({ platform: 'calendar', slug: 'local', adapter_type: 'local',
    config: {}, caps: LOCAL_CALENDAR_CAPS, auth_state: 'healthy', last_synced_at: null });
  await stack.startAll();
  const table = stack.listLive()[0]!.table;
  tables.set('local', table);
  table.upsert({ event, size_bytes: 0 });
  disposers.push(() => { db.close(); }, () => bus.dispose(), () => stack.disposeAll());
  const manifest = (slug: string) => KERNEL_MANIFESTS.find(m => m.slug === slug);
  const hooks = () => createResourceReviewHooks({ manifest, calendar: stack.reviewMutation, now: () => NOW });
  return { db, stack, table, hooks, manifest };
};
const input = { slug: 'local', source_id: 'meeting', patch: { start_at: NOW + 3600_000, end_at: NOW + 7200_000 } };

describe('reviewed resource execution', () => {
  it.each(['update', 'delete'] as const)('rejects a stale %s after restart, then permits a newly reviewed action', async verb => {
    const f = await fixture();
    const slug = verb === 'update' ? 'calendar-update' : 'calendar-delete';
    const args = verb === 'update' ? input : { slug: 'local', source_id: 'meeting' };
    const run = () => verb === 'update' ? f.stack.kernelDispatchers.calendarUpdate(args as typeof input)
      : f.stack.kernelDispatchers.calendarDelete(args as { slug: string; source_id: string });
    const original = f.hooks().capture(slug, args)!;
    // Restart recovery reads host-owned data, not a fresh version.
    const checkpoint = JSON.parse(JSON.stringify({ checkpoint_id: 'cp', run_id: 'run', recipe_id: 'recipe',
      gated_step_id: 'write', step_state: {}, created_at: NOW, resource_review: original }));
    expect(isCheckpoint(checkpoint)).toBe(true);
    const ask = buildPreflightAsk({ checkpoint, context: { recipe_id: 'recipe', gated_step_id: 'write' } });
    expect(ask.extras?.resource_review).toEqual(original);
    expect(ask.message.text).toContain('Review the exact before/after values in Recued');
    expect(ask.message.text).not.toContain('Meeting');
    f.table.upsert({ event: { ...event, start_at: NOW + 7200_000 }, size_bytes: 0 });
    expect(() => f.hooks().capture(slug, args, checkpoint.resource_review, true)).toThrow(/changed after review/);
    await expect(f.hooks().run(checkpoint.resource_review, run)).rejects.toMatchObject({ code: 'resource_conflict' });
    expect(f.table.get('meeting')!.event.start_at).toBe(NOW + 7200_000);
    const fresh = f.hooks().capture(slug, args)!;
    expect(fresh.resources[0]!.version).not.toBe(original.resources[0]!.version);
    await f.hooks().run(fresh, run);
    expect(f.table.get('meeting')?.event.start_at).toBe(verb === 'delete' ? undefined : NOW + 3600_000);
  });

  it('closes the local check/write race, including an edit undone in the same millisecond', async () => {
    const f = await fixture();
    const reviewed = f.hooks().capture('calendar-update', input)!;
    const provider = f.stack.listLive()[0]!.provider;
    const original = provider.updateEvent.bind(provider);
    provider.updateEvent = async args => {
      const payload = await original(args);
      f.table.upsert({ event: { ...event, summary: 'Other edit' }, size_bytes: 0 });
      f.table.upsert({ event, size_bytes: 0 });
      return payload;
    };
    await expect(f.hooks().run(reviewed, () => f.stack.kernelDispatchers.calendarUpdate(input)))
      .rejects.toMatchObject({ code: 'resource_conflict' });
    expect(f.table.get('meeting')!.event.start_at).toBe(NOW);
    expect(f.table.get('meeting')!.resource_version).not.toBe(reviewed.resources[0]!.version);
    const recreatedVersion = f.table.get('meeting')!.resource_version;
    f.table.delete('meeting');
    f.table.upsert({ event, size_bytes: 0 });
    expect(f.table.get('meeting')!.resource_version).not.toBe(recreatedVersion);
  });

  it('preserves a version during unchanged resync and refuses a legacy approval or changed arguments', async () => {
    const f = await fixture();
    const review = f.hooks().capture('calendar-update', input)!;
    f.table.upsert({ event: structuredClone(event), size_bytes: 0 });
    expect(f.hooks().capture('calendar-update', input, review, true)).toEqual(review);
    expect(() => f.hooks().capture('calendar-update', input, undefined, true)).toThrow(/older approval/);
    expect(() => f.hooks().capture('calendar-update', { ...input, patch: { summary: 'Different' } }, review, true))
      .toThrow(/proposed action/);
    const changedPayload = { ...review, resources: review.resources.map(r => ({ ...r, after: { summary: 'Forged' } })) };
    expect(() => f.hooks().capture('calendar-update', input, changedPayload, true)).toThrow(/proposed action/);
    await expect(f.hooks().run(review, () => f.stack.kernelDispatchers.calendarUpdate({
      ...input, patch: { summary: 'Changed after the gateway checked' },
    }))).rejects.toMatchObject({ code: 'resource_conflict' });
  });

  it('upgrades an existing Calendar table without losing its event or inventing a stable old version', async () => {
    const f = await fixture();
    f.db.exec('ALTER TABLE ' + f.table.tableName + ' DROP COLUMN resource_version');
    const restored = createCalendarTable({ db: f.db, slug: 'local' });
    expect(restored.get('meeting')!.event).toEqual(event);
    expect(restored.get('meeting')!.resource_version).toMatch(/^[0-9a-f-]{36}$/);
    const reopened = createCalendarTable({ db: f.db, slug: 'local' });
    expect(reopened.get('meeting')!.resource_version).toBe(restored.get('meeting')!.resource_version);
  });

  it('reviews the effective all-day patch that will actually reach the provider', async () => {
    const f = await fixture();
    const day = Date.UTC(2026, 9, 17);
    f.table.upsert({ event: { ...event, is_all_day: true, start_at: day, end_at: day + 86400_000 }, size_bytes: 0 });
    const args = { ...input, patch: { start_at: day + 14 * 3600_000, end_at: day + 15 * 3600_000 } };
    const review = f.hooks().capture('calendar-update', args)!;
    expect(review.resources[0]!.after).toMatchObject({ start_at: day, end_at: day + 86400_000, is_all_day: true });
    await f.hooks().run(review, () => f.stack.kernelDispatchers.calendarUpdate(args));
    expect(f.table.get('meeting')!.event.start_at).toBe(review.resources[0]!.after!.start_at);
    expect(f.table.get('meeting')!.event.end_at).toBe(review.resources[0]!.after!.end_at);
  });

  it('refuses unsupported scopes and providers, and requires an ETag from the same synced version', async () => {
    const f = await fixture();
    expect(() => f.hooks().capture('calendar-update', { ...input, scope: 'this_and_future' })).toThrow(/one calendar occurrence/);
    const provider = f.stack.listLive()[0]!.provider;
    Object.defineProperty(provider, 'kind', { value: 'graph', configurable: true });
    expect(() => f.hooks().capture('calendar-update', input)).toThrow(/Outlook/);
    Object.defineProperty(provider, 'kind', { value: 'gcal', configurable: true });
    expect(() => f.hooks().capture('calendar-update', input)).toThrow(/Sync the calendar/);
    f.table.upsert({ event, size_bytes: 0, etag: '"synced-v1"' });
    const review = f.hooks().capture('calendar-update', input)!;
    expect(review.resources[0]!.precondition).toEqual({ kind: 'etag', value: '"synced-v1"' });
    f.table.upsert({ event, size_bytes: 0, etag: '"synced-v2"' });
    expect(() => f.hooks().capture('calendar-update', input, review, true)).toThrow(/changed after review/);
  });

  it('carries the snapshot through the real engine gate and consumes one foreach approval per item', async () => {
    const f = await fixture();
    const commits = createCommitStore(createInMemoryCollection<Commit>());
    const executor = wrapWithCommitGateway(async (_slug, args) => f.stack.kernelDispatchers.calendarUpdate(args as typeof input), {
      commitStore: commits, resourceReview: f.hooks(),
      evaluateAdmission: () => ({ verdict: 'ask', risk_tier: 'write', detail: 'Owner review',
        authorization_provenance: { pre_lift_approval: 'ask' } }) as never,
    });
    const recipe = { recipe_id: 'review-calendar', version: 1, metadata: { name: 'Review', description: 'Review',
      author: 'test', supported_platforms: [] }, variables: {}, prefetch_steps: [],
      steps: [{ id: 'write', ingredient: 'calendar-update', input, foreach: '{{config.items}}' }],
      output: { sidebar: [] } } as never;
    const context = () => ({ recipe, stores: createNamespaceStores({}, { items: [1, 2] }, {}),
      ingredientExecutor: executor, manifestGetter: f.manifest });
    const paused = await executeRecipe(context() as never);
    expect(paused.awaiting_approval?.resource_review, JSON.stringify(paused)).toMatchObject({ operation: 'calendar-update' });
    const resumed = resumeFromApproval(paused.awaiting_approval!);
    const ctx = context();
    Object.assign(ctx.stores.step, resumed.step_state);
    const next = await executeRecipe({ ...ctx, resumeFrom: resumed } as never);
    expect(next.awaiting_approval?.resource_review).toBeDefined();
    expect(next.awaiting_approval?.foreach_progress?.next_index).toBe(1);
    expect(f.table.get('meeting')!.event.start_at).toBe(NOW + 3600_000);
  });

  it.each(['missing', 'unsupported'] as const)('refuses a pinned approval when the resource guard becomes %s', async mode => {
    const f = await fixture();
    const review = f.hooks().capture('calendar-update', input)!;
    f.table.upsert({ event: { ...event, summary: 'Changed while held' }, size_bytes: 0 });
    const inner = vi.fn(async () => 'unguarded write');
    const executor = wrapWithCommitGateway(inner, {
      commitStore: createCommitStore(createInMemoryCollection<Commit>()),
      ...(mode === 'unsupported' ? { resourceReview: createResourceReviewHooks({ manifest: () => undefined }) } : {}),
      evaluateAdmission: () => ({ verdict: 'admit' }) as never,
    });
    await expect(executor('calendar-update', input, {}, {}, {
      step_id: 'write', recipe_id: 'review', preflight_admitted: true, resource_review: review,
      preflight_approved_target: { ingredient_slug: 'calendar-update' },
    })).rejects.toMatchObject({ code: 'resource_conflict' });
    expect(inner).not.toHaveBeenCalled();
  });

  it('does not require a snapshot for an independent session grant, but captures one if consumption fails', async () => {
    const f = await fixture();
    const hooks = f.hooks();
    const capture = vi.fn(hooks.capture);
    const consume = vi.fn(() => true);
    const inner = vi.fn(async () => 'grant-admitted');
    const executor = wrapWithCommitGateway(inner, {
      commitStore: createCommitStore(createInMemoryCollection<Commit>()),
      identity: { request_id: 'request', correlation_id: 'corr', dispatch_depth: 1,
        channel_session_id: 'chat:chat', source: { channel: 'chat', actor: 'user_self', chat_session_id: 'chat', user_id: 'owner' } },
      resourceReview: { ...hooks, capture },
      resolveArgsForHash: (_slug, args) => args,
      evaluateAdmission: () => ({ verdict: 'ask', risk_tier: 'write', detail: 'Owner review',
        authorization_provenance: { pre_lift_approval: 'ask' } }) as never,
      sessionGrants: { match: () => 'grant', consume },
    });
    await expect(executor('calendar-update', input)).resolves.toBe('grant-admitted');
    expect(capture).not.toHaveBeenCalled();
    expect(inner).toHaveBeenCalledTimes(1);
    consume.mockReturnValue(false);
    await expect(executor('calendar-update', input)).rejects.toMatchObject({ resource_review: { operation: 'calendar-update' } });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('does not carry a superseded snapshot into a new receipt decision', async () => {
    const f = await fixture();
    const receipts = createGatedActionStore(createInMemoryCollection<GatedActionRecord>());
    const identity = { run_id: 'run', recipe_id: 'recipe', gated_step_id: 'write' };
    const review = f.hooks().capture('calendar-update', input)!;
    const first = await receipts.createHeld({ ...identity, checkpoint_id: 'old', resource_review: review });
    const second = await receipts.createHeld({ ...identity, checkpoint_id: 'new' });
    expect(second.action_ref).toBe(first.action_ref);
    expect(second.resource_review).toBeUndefined();
    expect((await receipts.get(second.action_ref))!.resource_review).toBeUndefined();
  });

  it.each([true, false])('persists a host checkpoint and refuses stale approval through the real resumer (commit store: %s)', async withCommitStore => {
    const f = await fixture();
    const checkpoints = createCheckpointStore(createInMemoryCollection<Checkpoint>());
    const audit = createAuditLogStore(createInMemoryCollection(), createInMemoryCollection());
    const receipts = createGatedActionStore(createInMemoryCollection<GatedActionRecord>());
    const recipe: RecipeDefinition = { recipe_id: 'host-review', version: 1, ttl: 0,
      metadata: { name: 'Move meeting', description: 'Move meeting', author: 'test', supported_platforms: [] },
      variables: { event: { type: 'text', label: 'Event', default: 'meeting' } }, prefetch_steps: [],
      steps: [{ id: 'move', ingredient: 'calendar-update', input: { ...input, source_id: '{{config.event}}' } }],
      output: { sidebar: [] } };
    const manifests = createManifestRegistry();
    const contractSnapshot = { contract_id: 'review-contract', contract_version: 'fixture',
      allowed_tools: manifests.slugs(), approval_required: [], scope_restrictions: [], resolved_at: NOW };
    const deps: ExecuteHandlerDeps = {
      baseVault: {}, recipeStore: { get: () => recipe } as never,
      executorConfig: { manifests, kernelDispatchers: f.stack.kernelDispatchers, resourceReview: f.hooks() },
      ...(withCommitStore ? { commitStore: createCommitStore(createInMemoryCollection<Commit>()) } : {}),
      checkpointStore: checkpoints, auditLog: audit, gatedActionStore: receipts,
      // This fixture admits its caller; the version check must still refuse.
      // Live bearer resolution is independently covered by the authority suite.
      approvalResumeAuthority: { resolve: ({ execution_source }) => ({ admitted: true, execution_source,
        contract_snapshot: contractSnapshot }) },
    };
    const first = await handleExecute(deps, { recipe_id: recipe.recipe_id,
      execution_source: { channel: 'mcp', actor: 'contracted_user', tool_call_id: 'review',
        agent_id: 'fixture', mcp_token_id: 'review-token', contract_id: 'review-contract' },
      contract_snapshot: contractSnapshot });
    expect(first.awaiting_approval, JSON.stringify(first)).toBe(true);
    const saved = (await checkpoints.list())[0]!;
    expect(saved.resource_review?.resources[0]!.before.start_at).toBe(NOW);
    const action = await receipts.getByCheckpoint(saved.checkpoint_id);
    expect(action?.resource_review).toEqual(saved.resource_review);
    f.table.upsert({ event: { ...event, start_at: NOW + 7200_000 }, size_bytes: 0 });
    const resumer = createPreflightResumer({ auditLog: audit, getExecuteDeps: () => deps, gatedActionStore: receipts });
    await resumer.resumeRun(JSON.parse(JSON.stringify(saved)), { recipe_id: recipe.recipe_id, gated_step_id: 'move' });
    expect(f.table.get('meeting')!.event.start_at).toBe(NOW + 7200_000);
    expect((await receipts.get(action!.action_ref))!.status).toBe('failed');
    expect((await receipts.get(action!.action_ref))!.resource_review).toEqual(saved.resource_review);
    const anchor = await audit.get(saved.run_id);
    expect(anchor?.errors?.[0]).toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('changed after review') });
  });
});

describe('Chat reviews retain the resource version', () => {
  const setup = async () => {
    const f = await fixture();
    ensureChatSchema(f.db);
    const chatStore = createChatStore(f.db);
    chatStore.createSession({ id: 'chat', now: NOW, picker_state: { current: 'self' } });
    const key = new Uint8Array(32).fill(7);
    let store = createSqliteChatPlanStore(f.db, () => key, () => NOW);
    const entry: ToolEntry = { name: 'calendar.update', tier: 1, description: 'Move meeting',
      arg_schema: { type: 'object' }, topic_tags: ['calendar'], classification: 'write', concurrency_safe: false };
    const handlers = buildChatTier1Handlers({
      getCalendarWriteDeps: () => f.stack.kernelDispatchers,
      getOpAdmissionGate: () => ({ isFrozenByPause: () => false, isOpGranted: () => true }),
    } as never);
    const called = vi.fn(async (_name, args, ctx) => handlers['calendar.update']!(args, ctx));
    const registry: InternalToolRegistry = { list: () => [entry], listByTier: () => [entry],
      getByName: () => entry, dispatch: called, subscribeRefresh: () => () => {} };
    let seq = 0;
    let hooksAvailable = true;
    const build = () => createChatOrchestrator({ chatStore, registry, broadcast: { emit() {} },
      selfSignature: { server_kind: 'recued', version: '1', instance_id: 'server' },
      getResourceReview: () => hooksAvailable ? f.hooks() : undefined,
      planApprovalStore: store, now: () => NOW, mintId: () => 'plan-' + ++seq });
    let orchestrator = build();
    const args = { source_id: 'meeting', start_at: NOW + 3600_000, end_at: NOW + 7200_000 };
    const dispatch = (turn: string) => orchestrator.dispatch.dispatchTool({ session_id: 'chat', turn_id: turn,
      tool_name: 'calendar.update', arg_values: args, picker_target: 'self' });
    return { ...f, called, dispatch, getStore: () => store,
      restart: (available = true) => { hooksAvailable = available;
        store = createSqliteChatPlanStore(f.db, () => key, () => NOW); orchestrator = build(); } };
  };

  it('keeps encrypted before/after data through restart and requires a new proposal after conflict', async () => {
    const f = await setup();
    expect(await f.dispatch('proposal')).toMatchObject({ reason: 'awaiting_approval' });
    const original = (await f.getStore().get('plan-1'))!;
    expect(original.resource_review!.resources[0]!.before.start_at).toBe(NOW);
    const encrypted = f.db.prepare('SELECT resource_review_encrypted AS blob FROM chat_plans').get() as { blob: string };
    expect(encrypted.blob).not.toContain('Meeting');
    await f.getStore().resolve('plan-1', 'approved', NOW);
    f.restart();
    expect((await f.getStore().get('plan-1'))!.resource_review).toEqual(original.resource_review);
    f.table.upsert({ event: { ...event, start_at: NOW + 7200_000 }, size_bytes: 0 });
    await expect(f.dispatch('execute')).rejects.toMatchObject({ code: 'resource_conflict' });
    expect(f.called).not.toHaveBeenCalled();
    expect((await f.getStore().get('plan-1'))!.consumed_at).toBe(NOW);
    const result = await f.dispatch('fresh-proposal');
    expect(result).toMatchObject({ reason: 'awaiting_approval' });
    const freshId = (result as { detail: string }).detail.replace('plan_id=', '');
    const fresh = (await f.getStore().get(freshId))!;
    expect(fresh.resource_review!.resources[0]!.before.start_at).toBe(NOW + 7200_000);
    await f.getStore().resolve(freshId, 'approved', NOW);
    expect(await f.dispatch('fresh-execute')).toMatchObject({ ok: true });
    expect(f.called).toHaveBeenCalledTimes(1);
    expect(f.table.get('meeting')!.event.start_at).toBe(NOW + 3600_000);
    expect(currentResourceReview()).toBeUndefined();
  });

  it('cannot recover a tampered resource snapshot as an approvable plan', async () => {
    const f = await setup();
    await f.dispatch('proposal');
    f.db.prepare("UPDATE chat_plans SET resource_review_encrypted = 'broken'").run();
    f.restart();
    expect(await f.getStore().get('plan-1')).toBeUndefined();
    expect(await f.getStore().resolve('plan-1', 'approved', NOW)).toBeUndefined();
    expect(f.called).not.toHaveBeenCalled();
  });

  it('refuses a recovered plan when its resource-review integration is unavailable', async () => {
    const f = await setup();
    await f.dispatch('proposal');
    await f.getStore().resolve('plan-1', 'approved', NOW);
    f.restart(false);
    await expect(f.dispatch('execute')).rejects.toMatchObject({ code: 'resource_conflict' });
    expect(f.called).not.toHaveBeenCalled();
    expect(currentResourceReview()).toBeUndefined();
    expect(f.table.get('meeting')!.event.start_at).toBe(NOW);
  });
});
