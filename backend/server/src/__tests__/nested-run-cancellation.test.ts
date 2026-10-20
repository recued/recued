import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planExchangeRetry, type IngredientManifest, type RecipeDefinition } from '@recued/contracts';
import { classifyRunFailure, type CliInvocationCall } from '@recued/engine';
import type { AuditEntry } from '@recued/storage';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { createCliInvocationExecutor } from '../cli-invocation-executor.js';
import { InFlightRegistry } from '../execution/in-flight-registry.js';
import { LaneSemaphore } from '../execution/lane-semaphore.js';
import { currentRunAbortContext, withRunAbortContext } from '../execution/run-abort-context.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const owner = { channel: 'user' as const, actor: 'user_self' as const, user_id: 'owner', client_token_id: 'fixture' };
const recipe = (recipe_id: string, steps: RecipeDefinition['steps'], budget_ms?: number): RecipeDefinition => ({
  recipe_id, version: 1, ttl: 0,
  metadata: { name: recipe_id, description: 'Cancellation fixture.', author: 'fixture', supported_platforms: [],
    ...(budget_ms !== undefined ? { budget_ms } : {}) },
  variables: {}, prefetch_steps: [], steps, output: { render: [] },
});

const routes = ['nested', 'exchange', 'grandchild'] as const;
type Route = typeof routes[number];
const fixture = (mode: 'http' | 'cli', route: Route, budget: boolean,
  options: { registered?: boolean; leafBudget?: number; followup?: boolean; parallel?: boolean; audited?: boolean } = {}) => {
  const registered = options.registered !== false;
  const semaphore = new LaneSemaphore({ external_io_n: 1, local_heavy_n: 1 });
  const registry = new InFlightRegistry(semaphore);
  const manifests = createManifestRegistry('/nonexistent'); const recipes = createRecipeStore('/nonexistent');
  const base: IngredientManifest = { slug: 'fixture-read', version: 1, name: 'Read', description: '', author: 'fixture',
    kind: 'http', category: 'data', risk_tier: 'read', input: { method: 'GET', url: 'https://fixture.invalid/read' }, output: {} };
  manifests.register(base);
  manifests.register({ ...base, slug: 'fixture-after', input: { method: 'GET', url: 'https://fixture.invalid/after' } });
  manifests.register({ ...base, slug: 'fixture-invoke', kind: 'connection', input: {},
    operations: { invoke: { operation_id: 'fixture-invoke.invoke', risk_tier: 'read', groups: ['fixture'] },
      middle: { operation_id: 'fixture-invoke.middle', risk_tier: 'read', groups: ['fixture'] } },
    surfaces: { api: { transport: 'rest', default_base_url: 'https://fixture.invalid', auth: { kind: 'none' },
      executes: { invoke: { kind: 'mcp', tool: 'recued-core/leaf' },
        middle: { kind: 'mcp', tool: 'recued-core/middle' } } } } });
  manifests.register({ ...base, slug: 'fixture-cli', kind: 'connection', input: {},
    operations: { work: { operation_id: 'fixture-cli.work', risk_tier: 'read', groups: ['fixture'] } },
    surfaces: { connector: {
      runtime: { transport: 'stdio', wire_protocol: 'cli_invocation', package_ref: 'system_binary:fixture-cli',
        entry_point: 'fixture-cli', expected_protocol_version: 1 },
      lifecycle: { auth: { method: 'none' }, connect: { idempotent: true, startup_timeout_ms: 30_000 },
        invoke: { default_method_timeout_ms: 30_000 }, disconnect: { graceful_shutdown_timeout_ms: 30_000 },
        reconnect_policy: 'manual_only', persistent_connection: false, idle_disconnect_ms: 0 },
      executes: { work: { kind: 'cli_invocation', argv_template: ['fixture-cli'], stdin_handling: 'none',
        shape: 'text', exit_code_handling: 'zero_is_success' } },
    } } });
  const invoke = { id: 'invoke', ingredient: 'fixture-invoke', input: { operation: 'invoke', args: {} } };
  recipes.register(recipe('leaf', [{ id: 'work', ingredient: mode === 'http' ? base.slug : 'fixture-cli',
    input: mode === 'http' ? {} : { operation: 'work', args: {} } },
    ...(options.followup ? [{ id: 'must_not_run', ingredient: 'fixture-after', input: {} }] : [])], options.leafBudget));
  recipes.register(recipe('independent', [{ id: 'read', ingredient: base.slug, input: {} }]));
  recipes.register(recipe('middle', [invoke]));
  const parent = recipe('parent', route === 'exchange' ? [] : [route === 'grandchild'
    ? { ...invoke, input: { operation: 'middle', args: {} } } : invoke], budget ? 1_000 : undefined);
  if (options.parallel) {
    parent.steps = [];
    parent.prefetch_steps = [
      { ...invoke, id: 'first' },
      { ...invoke, id: 'second', input: { operation: 'middle', args: {} } },
    ];
  }
  if (route === 'exchange') parent.output = { exchange: { ref: 'fixture-ref', deliver_to: 'recued-core/leaf' } };
  recipes.register(parent);
  recipes.register({ ...parent, recipe_id: 'parent-b' });
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  const children: Array<{ child: ChildProcess; kill: ReturnType<typeof vi.fn>; close(success?: boolean): void }> = [];
  const calls: CliInvocationCall[] = [];
  const audit: AuditEntry[] = [];
  const spawn = vi.fn(() => {
    const emitter = new EventEmitter(); const stdout = new PassThrough(); const stderr = new PassThrough();
    const kill = vi.fn(() => true);
    const child = Object.assign(emitter, { pid: 10_000 + children.length, stdout, stderr, stdin: null,
      exitCode: null, signalCode: null, kill }) as unknown as ChildProcess;
    let closed = false;
    children.push({ child, kill, close: (success = false) => {
      if (closed) return; closed = true;
      stdout.end(); stderr.end(); emitter.emit('close', success ? 0 : null, success ? null : 'SIGKILL');
    } });
    return child;
  });
  const cli = createCliInvocationExecutor({ spawn: spawn as typeof import('node:child_process').spawn,
    ...(registered ? { inFlightRegistry: registry } : {}) });
  const deps: ExecuteHandlerDeps = { recipeStore: recipes, baseVault: {}, executorConfig: { manifests },
    laneGovernor: semaphore, ...(registered ? { inFlightRegistry: registry } : {}), cliReachabilityResolver: () => true,
    ...(options.audited ? { auditLog: {
      append: async (entry: AuditEntry) => { audit.push(entry); },
    } as unknown as ExecuteHandlerDeps['auditLog'] } : {}),
    cliInvocationExecutor: call => { calls.push(call); return cli(call); } };
  return { semaphore, registry, fetch, children, calls, audit,
    run: (id = 'parent', context?: Record<string, unknown>) => handleExecute(deps, { recipe_id: id, execution_source: owner,
      ...(context ? { context } : {}) }),
    stop: (id = 'parent') => {
      const run = registry.snapshot().entries.find(entry => entry.entry_kind === 'run' && entry.recipe_id === id);
      if (!run) throw new Error('Fixture parent missing');
      expect(registry.kill(run.run_id!)).toBe('killed');
    },
  };
};

describe('nested run cancellation', () => {
  it('starts an independent root from a timer that retained an expired run context', async () => {
    vi.useFakeTimers();
    const f = fixture('http', 'nested', false);
    const expired = new AbortController();
    const context = { run_id: 'retired', signal: expired.signal };
    await withRunAbortContext(context, async () => {
      const scheduled = new Promise<Awaited<ReturnType<typeof f.run>>>(resolve => {
        setTimeout(() => { resolve(f.run('independent')); }, 10);
      }).then(result => ({ result }), error => ({ error }));
      expired.abort();
      await vi.advanceTimersByTimeAsync(10);
      expect(await scheduled).toMatchObject({ result: { success: true } });
      expect(currentRunAbortContext()).toEqual(context);
    });
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.registry.activeRunCount()).toBe(0);
    expect(currentRunAbortContext()).toBeUndefined();
  });

  it('keeps an independent root and its descendants outside the ambient run family', async () => {
    vi.useFakeTimers();
    const f = fixture('cli', 'grandchild', false);
    const ambient = new AbortController();
    f.registry.registerRun({ run_id: 'ambient', recipe_id: 'ambient', source: owner,
      origin: 'attended', started_at: Date.now(), abort: () => ambient.abort() });
    const execution = withRunAbortContext({ run_id: 'ambient', signal: ambient.signal }, () => f.run());
    try {
      await vi.waitFor(() => expect(f.children).toHaveLength(1));
      f.stop('ambient');
      await vi.advanceTimersByTimeAsync(1);
      expect(f.calls[0]!.signal?.aborted).toBe(false);
      expect(f.children[0]!.kill).not.toHaveBeenCalled();
      f.children[0]!.close(true);
      expect((await execution).success).toBe(true);
    } finally {
      for (const child of f.children) child.close();
      await vi.advanceTimersByTimeAsync(1_000);
      await execution;
      f.registry.completeRun('ambient');
    }
    expect(f.registry.activeRunCount()).toBe(0);
  });

  const cases = routes.flatMap(route => [
    { route, stop: 'budget', registered: true }, { route, stop: 'budget', registered: false },
    { route, stop: 'owner', registered: true },
  ] as const);
  it.each(cases)('removes a $route lane waiter on parent $stop with registration $registered', async ({ route, stop, registered }) => {
    vi.useFakeTimers(); const f = fixture('http', route, stop === 'budget', { registered });
    const held = await f.semaphore.acquire({ call_class: 'external-io', descriptor: { recipe_id: 'other', slug: 'held' } });
    const execution = f.run(); let settled = false; void execution.then(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(f.semaphore.gatedEntries().filter(entry => entry.state === 'waiting_slot')).toHaveLength(1));
      if (stop === 'owner') f.stop();
      await vi.advanceTimersByTimeAsync(stop === 'owner' ? 1 : 1_000);
      expect(f.semaphore.gatedEntries().filter(entry => entry.state === 'waiting_slot')).toHaveLength(0);
      expect(settled).toBe(true);
      const result = await execution; expect(result.success).toBe(false);
      if (stop === 'budget') expect(result.errors).toMatchObject([{ code: 'RECIPE_BUDGET_EXCEEDED' }]);
      else expect(result.run_terminated).toBe('killed');
      expect(f.fetch).not.toHaveBeenCalled();
      held.release('succeeded'); expect((await f.run('independent')).success).toBe(true);
    } finally { held.release('succeeded'); await vi.advanceTimersByTimeAsync(1_000); await execution; }
  });

  it.each(cases)('awaits a $route CLI close on parent $stop with registration $registered', async ({ route, stop, registered }) => {
    vi.useFakeTimers(); const f = fixture('cli', route, stop === 'budget', { registered });
    const execution = f.run(); let settled = false; void execution.then(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(f.children).toHaveLength(1));
      if (stop === 'owner') f.stop();
      await vi.advanceTimersByTimeAsync(stop === 'owner' ? 1 : 1_000);
      expect(f.calls[0]?.signal?.aborted).toBe(true);
      expect(f.children[0]!.kill).toHaveBeenCalled();
      expect(settled).toBe(false);
      f.children[0]!.close();
      const result = await execution; expect(result.success).toBe(false);
      if (stop === 'budget') expect(result.errors).toMatchObject([{ code: 'RECIPE_BUDGET_EXCEEDED' }]);
      else expect(result.run_terminated).toBe('killed');
      await vi.waitFor(() => expect(f.registry.activeRunCount()).toBe(0));
      expect((await f.run('independent')).success).toBe(true);
    } finally { for (const child of f.children) child.close(); await vi.advanceTimersByTimeAsync(1_000); await execution; }
  });

  it('honors a shorter child CLI budget without waiting for the parent deadline', async () => {
    vi.useFakeTimers(); const f = fixture('cli', 'grandchild', true, { leafBudget: 200 });
    const execution = f.run();
    try {
      await vi.waitFor(() => expect(f.children).toHaveLength(1)); await vi.advanceTimersByTimeAsync(200);
      expect(f.children[0]!.kill).toHaveBeenCalled(); f.children[0]!.close();
      const result = await execution; expect(result.success).toBe(false);
      expect(JSON.stringify(result.errors)).toContain('200ms budget');
    } finally { for (const child of f.children) child.close(); await vi.advanceTimersByTimeAsync(1_000); await execution; }
  });

  it.each(['owner', 'budget'] as const)('waits for every parallel nested CLI close after parent %s', async stop => {
    vi.useFakeTimers();
    const f = fixture('cli', 'nested', stop === 'budget', { parallel: true });
    let settled = false;
    const execution = f.run().then(result => { settled = true; return result; });
    try {
      await vi.waitFor(() => expect(f.children).toHaveLength(2));
      if (stop === 'owner') f.stop();
      await vi.advanceTimersByTimeAsync(stop === 'owner' ? 1 : 1_000);
      expect(f.calls.every(call => call.signal?.aborted)).toBe(true);
      for (const child of f.children) expect(child.kill).toHaveBeenCalled();
      f.children[0]!.close();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(false);
      f.children[1]!.close();
      const result = await execution;
      expect(result.success).toBe(false);
      if (stop === 'budget') expect(result.errors).toMatchObject([{ code: 'RECIPE_BUDGET_EXCEEDED' }]);
      else expect(result.run_terminated).toBe('killed');
      await vi.waitFor(() => expect(f.registry.activeRunCount()).toBe(0));
    } finally {
      for (const child of f.children) child.close();
      await vi.advanceTimersByTimeAsync(1_000);
      await execution;
    }
  });

  it('keeps a concurrent parent and its CLI child running when another family stops', async () => {
    vi.useFakeTimers(); const f = fixture('cli', 'grandchild', false);
    const first = f.run(); await vi.waitFor(() => expect(f.children).toHaveLength(1));
    const second = f.run('parent-b');
    try {
      await vi.waitFor(() => expect(f.children).toHaveLength(2)); f.stop(); await vi.advanceTimersByTimeAsync(1);
      expect(f.children[0]!.kill).toHaveBeenCalled(); expect(f.children[1]!.kill).not.toHaveBeenCalled();
      expect(f.calls[1]!.signal?.aborted).toBe(false);
      f.children[0]!.close(); expect((await first).run_terminated).toBe('killed');
      expect(f.children[1]!.kill).not.toHaveBeenCalled(); f.children[1]!.close(true);
      expect((await second).success).toBe(true);
    } finally { for (const child of f.children) child.close(); await vi.advanceTimersByTimeAsync(1_000); await Promise.all([first, second]); }
  });

  it.each(['owner', 'budget'] as const)('drains admitted external I/O after parent %s and stops later steps', async stop => {
    vi.useFakeTimers(); const f = fixture('http', 'grandchild', stop === 'budget', { followup: true });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    f.fetch.mockImplementationOnce(async () => { await gate; return new Response('{"ok":true}'); });
    let settled = false;
    let earlyResult: Awaited<ReturnType<typeof f.run>> | undefined;
    const execution = f.run().then(result => { settled = true; earlyResult = result; return result; });
    try {
      await vi.waitFor(() => expect(f.fetch.mock.calls.length, JSON.stringify(earlyResult)).toBe(1));
      if (stop === 'owner') f.stop();
      await vi.advanceTimersByTimeAsync(stop === 'owner' ? 1 : 1_000);
      expect(settled).toBe(stop === 'owner');
      expect(f.registry.activeRunCount()).toBeGreaterThan(0);
      release(); const result = await execution; expect(result.success).toBe(false);
      if (stop === 'budget') expect(result.errors).toMatchObject([{ code: 'RECIPE_BUDGET_EXCEEDED' }]);
      else expect(result.run_terminated).toBe('killed');
      await vi.waitFor(() => expect(f.registry.activeRunCount()).toBe(0));
      expect(f.fetch).toHaveBeenCalledOnce();
    } finally { release(); await vi.advanceTimersByTimeAsync(1_000); await execution; }
  });

  it('runs both distinct external steps when the parent remains active', async () => {
    const f = fixture('http', 'grandchild', false, { followup: true });
    expect((await f.run()).success).toBe(true);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.registry.activeRunCount()).toBe(0);
  });

  it.each([
    { stop: 'owner', registered: true },
    { stop: 'budget', registered: true },
    { stop: 'budget', registered: false },
  ] as const)('does not retry an exchange stopped by parent $stop with registration $registered', async ({ stop, registered }) => {
    vi.useFakeTimers();
    const f = fixture('http', 'exchange', stop === 'budget', { registered, audited: true });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.fetch.mockImplementationOnce(async () => { await gate; return new Response('{"ok":true}'); });
    const execution = f.run();
    try {
      await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
      if (stop === 'owner') f.stop();
      await vi.advanceTimersByTimeAsync(stop === 'owner' ? 1 : 1_000);
      release();
      expect((await execution).success).toBe(false);
      await vi.waitFor(() => expect(f.audit.some(row => row.recipe_id === 'run-ingredient')).toBe(true));
      const rows = f.audit.filter(row => row.exchange_ref === 'fixture-ref').map(row => ({
        recipe_id: row.recipe_id, status: String(row.commit_status), at: row.finished_at ?? row.started_at ?? 0,
        errors: row.errors ?? [], config: row.config_snapshot ?? {},
      }));
      expect(planExchangeRetry('fixture-ref', rows, undefined, classifyRunFailure, Date.now() + 1_000_000).retry).toBe(false);
      const carrier = rows.find(row => row.recipe_id === 'run-ingredient');
      if (stop === 'owner') expect(carrier?.status).toBe('killed');
      else expect(carrier?.errors).toMatchObject([{ code: 'RECIPE_BUDGET_EXCEEDED' }]);
      await vi.waitFor(() => expect(f.registry.activeRunCount()).toBe(0));
    } finally {
      release();
      await vi.advanceTimersByTimeAsync(1_000);
      await execution;
    }
  });

  it('does not treat caller context data as host run lineage or cancellation', async () => {
    const f = fixture('http', 'nested', false);
    expect((await f.run('independent', { run_id: 'forged', parent_run_id: 'another', signal: { aborted: true } })).success).toBe(true);
    expect(f.fetch).toHaveBeenCalledOnce(); expect(f.registry.activeRunCount()).toBe(0);
  });
});
