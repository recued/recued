/** D-259 supervised invocation ownership.
 *
 * A readiness-supervised CLI op is a singleton service, not a fresh detached
 * job per caller. These composition tests pin the boundary the executor uses:
 * pre-cancelled calls cannot enroll anything, same-config followers may join a
 * launch without owning it, and different-config callers cannot silently make
 * the durable row disagree with the process that is actually running. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CliInvocationCall, CliInvocationExecutor } from '@recued/engine';
import type { CliMethodBinding, IngredientManifest } from '@recued/contracts';

import {
  composeSupervisionStack,
  type SupervisionStack,
} from '../supervision/compose-supervision-stack.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

interface Harness {
  db: Database.Database;
  root: string;
  binding: CliMethodBinding;
  stack: SupervisionStack;
  launch: Deferred<{ mode: 'detached'; launched: true; pid: number }>;
  executor: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
}

const harnesses: Harness[] = [];

const makeHarness = (): Harness => {
  const db = new Database(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'recued-d259-supervision-'));
  const readyPath = join(root, 'ready');
  writeFileSync(readyPath, 'ready', 'utf8');
  const binding = {
    kind: 'cli_invocation',
    argv_template: ['daemon', '{name}'],
    stdin_handling: 'none',
    exit_code_handling: 'zero_is_success',
    detached: {
      mode: 'runtime_managed',
      completion: { kind: 'marker_file', exit_pattern: '{result_dir}/{key}.exit.{code}' },
      cancel: { kind: 'process_group', pid_pattern: '{result_dir}/{key}.pid' },
      supervision: {
        restart_policy: 'on-crash',
        restart_on_server_start: true,
        readiness: { kind: 'file_exists', path: readyPath },
        ready_timeout_ms: 1_000,
      },
    },
  } as CliMethodBinding;
  const manifest = {
    slug: 'daemon-pack',
    surfaces: { connector: { executes: { serve: binding } } },
  } as unknown as IngredientManifest;
  const launch = deferred<{ mode: 'detached'; launched: true; pid: number }>();
  const executor = vi.fn(() => launch.promise);
  let alive = true;
  const kill = vi.fn(() => { alive = false; });
  const stack = composeSupervisionStack({
    db,
    dataPath: root,
    getManifest: (slug) => slug === manifest.slug ? manifest : undefined,
    getManifests: () => [manifest],
    supervisorOverrides: {
      isPidAlive: () => alive,
      killProcessGroup: kill,
      pollIntervalMs: 60_000,
      log: () => {},
    },
  });
  stack.bindExecutor(executor as unknown as CliInvocationExecutor);
  const out = { db, root, binding, stack, launch, executor, kill };
  harnesses.push(out);
  return out;
};

const call = (
  h: Harness,
  name = 'prod',
  signal?: AbortSignal,
): CliInvocationCall => ({
  slug: 'daemon-pack',
  operation_key: 'serve',
  operation_id: 'recued-core.daemon-pack.serve',
  binding: h.binding,
  args: { name },
  ...(signal ? { signal } : {}),
});

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.stack.disposeAll();
    h.db.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

describe('D-259 supervised invocation ownership', () => {
  it('rejects a pre-aborted call before durable enrollment or launch', async () => {
    const h = makeHarness();
    const controller = new AbortController();
    controller.abort();

    await expect(h.stack.startFromInvocation(call(h, 'prod', controller.signal)))
      .rejects.toThrow(/cancelled before launch/);
    expect(h.stack.store.get('daemon-pack', 'serve')).toBeNull();
    expect(h.stack.supervisor.status('daemon-pack', 'serve')).toBeNull();
    expect(h.executor).not.toHaveBeenCalled();
  });

  it('lets a same-config follower cancel without stopping the owner launch', async () => {
    const h = makeHarness();
    const owner = h.stack.startFromInvocation(call(h));
    expect(h.executor).toHaveBeenCalledTimes(1);

    const followerAbort = new AbortController();
    const follower = h.stack.startFromInvocation(call(h, 'prod', followerAbort.signal));
    followerAbort.abort();
    await expect(follower).rejects.toThrow(/start cancelled/);
    expect(h.kill).not.toHaveBeenCalled();

    h.launch.resolve({ mode: 'detached', launched: true, pid: 4242 });
    await expect(owner).resolves.toMatchObject({
      mode: 'detached',
      pid: 4242,
      readiness: 'ready',
    });
    expect(h.executor).toHaveBeenCalledTimes(1);
    expect(h.stack.supervisor.status('daemon-pack', 'serve')).toMatchObject({
      state: 'running',
      pid: 4242,
    });
  });

  it('rejects a different-config follower without rewriting durable intent', async () => {
    const h = makeHarness();
    const owner = h.stack.startFromInvocation(call(h, 'prod'));

    await expect(h.stack.startFromInvocation(call(h, 'staging')))
      .rejects.toThrow(/already active with different configuration/);
    expect(h.stack.store.get('daemon-pack', 'serve')?.args).toEqual({ name: 'prod' });
    expect(h.executor).toHaveBeenCalledTimes(1);

    h.launch.resolve({ mode: 'detached', launched: true, pid: 4242 });
    await expect(owner).resolves.toMatchObject({ readiness: 'ready', pid: 4242 });
  });

  it('makes the establishing caller own cancellation and process-group cleanup', async () => {
    const h = makeHarness();
    const controller = new AbortController();
    const starting = h.stack.startFromInvocation(call(h, 'prod', controller.signal));
    controller.abort();
    h.launch.resolve({ mode: 'detached', launched: true, pid: 4242 });

    await expect(starting).rejects.toThrow(/start cancelled/);
    expect(h.kill).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(h.stack.supervisor.status('daemon-pack', 'serve')).toMatchObject({
      state: 'stopped',
      pid: null,
    });
  });
});
