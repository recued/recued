/** Phase 7 (D-110) — composeFileStack lifecycle tests.
 *
 *  Covers the bin.ts composition contract:
 *    - startAll rehydrates live adapters for every pre-existing row.
 *    - enrollDeps.onEnrolled starts + registers on enroll.
 *    - enrollDeps.onDeleted stops + removes on delete.
 *    - disposeAll stops every live adapter and clears the map.
 *    - broken adapters during startAll log + skip without aborting boot.
 */

import { Buffer } from 'node:buffer';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nullAdapterFactory } from '../collections/file/adapters/null-adapter.js';
import {
  composeFileStack,
  type FileStack,
  type FileStackLogger,
} from '../collections/file/compose.js';

const seedRow = (
  stack: FileStack,
  slug: string,
  adapterType = 'null-adapter',
): void => {
  stack.instances.upsert({
    platform: 'file',
    slug,
    adapter_type: adapterType,
    config: {},
    caps: {
      read: 'yes',
      write: 'yes',
      delete: 'yes',
      watch: 'poll',
      mirror: 'optional',
      auth: 'none',
      path_style: 'posix',
    },
    auth_state: 'healthy',
    last_synced_at: null,
  });
};

describe('composeFileStack (Phase 7 / D-110)', () => {
  let db: Database.Database;
  let log: ReturnType<typeof vi.fn<FileStackLogger>>;
  let stack: FileStack;

  beforeEach(() => {
    db = new Database(':memory:');
    log = vi.fn<FileStackLogger>();
    stack = composeFileStack(db, { log });
    stack.adapters.register(nullAdapterFactory);
  });
  afterEach(() => db.close());

  it('registers the production adapter set', () => {
    expect(stack.adapters.listTypes()).toContain('fs');
    expect(stack.adapters.listTypes()).toContain('s3');
    expect(stack.adapters.listTypes()).toContain('ext-downloads');
  });

  it('startAll is a no-op on an empty instance store', async () => {
    await stack.startAll();
    // Dispatcher lookup should still yield FILE_ADAPTER_UNREACHABLE
    // / FILE_INSTANCE_NOT_FOUND for unknown slugs.
    await expect(
      stack.kernelDispatchers.fileWrite({
        slug: 'missing',
        path: 'x',
        body_b64: '',
      }),
    ).rejects.toThrow(/FILE_INSTANCE_NOT_FOUND/);
  });

  it('startAll rehydrates a live adapter for every pre-seeded row', async () => {
    seedRow(stack, 'a');
    seedRow(stack, 'b');
    await stack.startAll();

    // Mutation through the kernel dispatcher goes through getAdapter
    // → live map. A started null-adapter accepts writes; an unstarted
    // one throws io_error.
    await expect(
      stack.kernelDispatchers.fileWrite({
        slug: 'a',
        path: 'hello.txt',
        body_b64: Buffer.from('hi').toString('base64'),
      }),
    ).resolves.toEqual({ ok: true, bytes_written: 2 });
    await expect(
      stack.kernelDispatchers.fileRead({ slug: 'b', path: 'missing' }),
    ).rejects.toThrow(/FILE_NOT_FOUND/);
  });

  it('enrollDeps.onEnrolled starts the adapter so subsequent dispatches land', async () => {
    seedRow(stack, 'fresh');
    // bin.ts passes `enrollDeps` with onEnrolled wired to the internal
    // startLiveAdapter helper — simulate the enroll rpc calling it
    // after the row lands in the instance store.
    await stack.enrollDeps.onEnrolled!({
      slug: 'fresh',
      platform: 'file',
      adapter_type: 'null-adapter',
      caps: stack.instances.get('file', 'fresh')!.caps,
      auth_state: 'healthy',
      last_synced_at: null,
    });

    await expect(
      stack.kernelDispatchers.fileWrite({
        slug: 'fresh',
        path: 'note.md',
        body_b64: Buffer.from('x').toString('base64'),
      }),
    ).resolves.toEqual({ ok: true, bytes_written: 1 });
  });

  it('enrollDeps.onDeleted stops the adapter and clears the live entry', async () => {
    seedRow(stack, 'going');
    await stack.startAll();

    // The enroll handler removes authority first so an in-flight resync
    // cannot recreate an adapter while teardown is queued.
    stack.instances.delete('file', 'going');
    await stack.enrollDeps.onDeleted!('going');

    await expect(
      stack.kernelDispatchers.fileWrite({
        slug: 'going',
        path: 'p',
        body_b64: '',
      }),
    ).rejects.toThrow(/FILE_INSTANCE_NOT_FOUND/);
  });

  it('disposeAll stops every live adapter; the next dispatch surfaces ADAPTER_UNREACHABLE', async () => {
    seedRow(stack, 'one');
    seedRow(stack, 'two');
    await stack.startAll();

    await stack.disposeAll();

    // Rows still exist; adapters no longer live → the dispatcher
    // returns 'server_not_reachable' (FILE_ADAPTER_UNREACHABLE), which
    // is the expected drained-but-not-torn-down shape.
    await expect(
      stack.kernelDispatchers.fileWrite({
        slug: 'one',
        path: 'x',
        body_b64: '',
      }),
    ).rejects.toThrow(/FILE_ADAPTER_UNREACHABLE/);
  });

  it('disposeAll is idempotent', async () => {
    seedRow(stack, 'solo');
    await stack.startAll();
    const first = stack.disposeAll();
    const second = stack.disposeAll();
    expect(second).toBe(first);
    await first;
  });

  it('disposeAll closes replacement admission for an in-flight resync', async () => {
    let starts = 0;
    let releaseStop!: () => void;
    const stopHeld = new Promise<void>((resolve) => { releaseStop = resolve; });
    stack.adapters.register({
      type: 'draining-resync',
      async probeCaps() {
        return {
          read: 'yes', write: 'no', delete: 'no', watch: 'none',
          mirror: 'disabled', auth: 'none', path_style: 'posix',
        };
      },
      create() {
        return {
          async start() { starts += 1; },
          async stop() { await stopHeld; },
        };
      },
    });
    seedRow(stack, 'closing', 'draining-resync');
    await stack.startAll();
    const stored = stack.instances.get('file', 'closing')!;
    const resync = stack.enrollDeps.onResync!({
      slug: stored.slug,
      platform: 'file',
      adapter_type: stored.adapter_type,
      caps: stored.caps,
      auth_state: stored.auth_state,
      last_synced_at: stored.last_synced_at,
    });
    await Promise.resolve();

    const disposing = stack.disposeAll();
    releaseStop();
    await Promise.all([resync, disposing]);

    expect(starts).toBe(1);
    await expect(
      stack.kernelDispatchers.fileWrite({
        slug: 'closing', path: 'x', body_b64: '',
      }),
    ).rejects.toThrow(/FILE_ADAPTER_UNREACHABLE/);
  });

  it('disposeAll reports an adapter that fails to stop', async () => {
    stack.adapters.register({
      type: 'drain-failure',
      async probeCaps() {
        return {
          read: 'yes', write: 'no', delete: 'no', watch: 'none',
          mirror: 'disabled', auth: 'none', path_style: 'posix',
        };
      },
      create() {
        return {
          async start() {},
          async stop() { throw new Error('watcher still active'); },
        };
      },
    });
    seedRow(stack, 'stuck-drain', 'drain-failure');
    await stack.startAll();

    await expect(stack.disposeAll()).rejects.toThrow(/one or more adapters failed to stop/);
  });

  it('startAll skips rows whose adapter_type is not registered and logs', async () => {
    seedRow(stack, 'orphan', 'adapter-never-shipped');
    seedRow(stack, 'ok');
    await stack.startAll();

    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining("unknown adapter_type 'adapter-never-shipped'"),
    );
    expect(stack.instances.get('file', 'orphan')?.auth_state).toBe('degraded');
    // The healthy adapter still started.
    await expect(
      stack.kernelDispatchers.fileWrite({
        slug: 'ok',
        path: 'p',
        body_b64: '',
      }),
    ).resolves.toEqual({ ok: true, bytes_written: 0 });
  });

  it('startAll refuses a persisted OAuth row and marks it degraded', async () => {
    seedRow(stack, 'legacy-oauth');
    const stored = stack.instances.get('file', 'legacy-oauth')!;
    stack.instances.updateCaps('file', 'legacy-oauth', {
      ...stored.caps,
      auth: 'oauth',
    });

    await stack.startAll();

    expect(stack.instances.get('file', 'legacy-oauth')?.auth_state).toBe('degraded');
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining("invalid persisted caps for 'legacy-oauth'"),
      expect.objectContaining({
        err: expect.stringContaining('connection-backed D-192 Source'),
      }),
    );
    await expect(
      stack.kernelDispatchers.fileWrite({
        slug: 'legacy-oauth',
        path: 'must-not-run',
        body_b64: '',
      }),
    ).rejects.toThrow(/FILE_CAPABILITY_DENIED|FILE_INSTANCE_DEGRADED/);
  });

  it('startAll tolerates adapter.start() failures on a single row', async () => {
    stack.adapters.register({
      type: 'explodes',
      async probeCaps() {
        return {
          read: 'yes',
          write: 'no',
          delete: 'no',
          watch: 'none',
          mirror: 'disabled',
          auth: 'none',
          path_style: 'posix',
        };
      },
      create() {
        return {
          async start() {
            throw new Error('boot-time start failure');
          },
          async stop() {},
        };
      },
    });
    seedRow(stack, 'boom', 'explodes');
    seedRow(stack, 'fine');

    await stack.startAll();

    expect(log).toHaveBeenCalledWith(
      'error',
      expect.stringContaining("adapter.start failed for 'boom'"),
      expect.anything(),
    );
    expect(stack.instances.get('file', 'boom')?.auth_state).toBe('degraded');
    // 'fine' still started.
    await expect(
      stack.kernelDispatchers.fileRead({ slug: 'fine', path: 'x' }),
    ).rejects.toThrow(/FILE_NOT_FOUND/);
  });

  it('persists runtime adapter degradation after start resolves', async () => {
    let degrade: ((error: unknown) => Promise<void> | void) | undefined;
    stack.adapters.register({
      type: 'later-failure',
      async probeCaps() {
        return {
          read: 'yes', write: 'no', delete: 'no', watch: 'realtime',
          mirror: 'disabled', auth: 'none', path_style: 'posix',
        };
      },
      create(ctx) {
        degrade = ctx.onDegraded;
        return {
          async start() {},
          async stop() {},
        };
      },
    });
    seedRow(stack, 'runtime-red', 'later-failure');
    await stack.startAll();
    expect(stack.instances.get('file', 'runtime-red')?.auth_state).toBe('healthy');

    await degrade!(new Error('watch handle lost'));

    expect(stack.instances.get('file', 'runtime-red')?.auth_state).toBe('degraded');
    expect(log).toHaveBeenCalledWith(
      'error',
      expect.stringContaining("adapter runtime degraded for 'runtime-red'"),
      expect.anything(),
    );
  });

  it('onResync performs a bounded stop + start instead of scheduling polling', async () => {
    let starts = 0;
    let stops = 0;
    stack.adapters.register({
      type: 'restartable',
      async probeCaps() {
        return {
          read: 'yes', write: 'no', delete: 'no', watch: 'none',
          mirror: 'disabled', auth: 'none', path_style: 'posix',
        };
      },
      create() {
        return {
          async start() { starts++; },
          async stop() { stops++; },
        };
      },
    });
    seedRow(stack, 'manual', 'restartable');
    await stack.startAll();

    const stored = stack.instances.get('file', 'manual')!;
    await stack.enrollDeps.onResync!({
      slug: stored.slug,
      platform: 'file',
      adapter_type: stored.adapter_type,
      caps: stored.caps,
      auth_state: stored.auth_state,
      last_synced_at: stored.last_synced_at,
    });

    expect(starts).toBe(2);
    expect(stops).toBe(1);
  });

  it('serializes concurrent resyncs so only one adapter is live', async () => {
    let starts = 0;
    let stops = 0;
    let active = 0;
    let maxActive = 0;
    stack.adapters.register({
      type: 'serialized',
      async probeCaps() {
        return {
          read: 'yes', write: 'no', delete: 'no', watch: 'none',
          mirror: 'disabled', auth: 'none', path_style: 'posix',
        };
      },
      create() {
        let running = false;
        return {
          async start() {
            starts++;
            // Widen the gap between map lookup and registration. Without the
            // per-slug lifecycle queue, both replacement starts enter here.
            if (starts > 1) await new Promise<void>((resolve) => setImmediate(resolve));
            running = true;
            active++;
            maxActive = Math.max(maxActive, active);
          },
          async stop() {
            stops++;
            if (running) {
              running = false;
              active--;
            }
          },
        };
      },
    });
    seedRow(stack, 'serialized-row', 'serialized');
    await stack.startAll();
    const stored = stack.instances.get('file', 'serialized-row')!;
    const row = {
      slug: stored.slug,
      platform: 'file' as const,
      adapter_type: stored.adapter_type,
      caps: stored.caps,
      auth_state: stored.auth_state,
      last_synced_at: stored.last_synced_at,
    };

    await Promise.all([
      stack.enrollDeps.onResync!(row),
      stack.enrollDeps.onResync!(row),
    ]);

    expect(starts).toBe(3);
    expect(stops).toBe(2);
    expect(active).toBe(1);
    expect(maxActive).toBe(1);
  });

  it('does not start a replacement when the prior adapter fails to stop', async () => {
    let starts = 0;
    stack.adapters.register({
      type: 'stuck-stop',
      async probeCaps() {
        return {
          read: 'yes', write: 'no', delete: 'no', watch: 'none',
          mirror: 'disabled', auth: 'none', path_style: 'posix',
        };
      },
      create() {
        return {
          async start() { starts++; },
          async stop() { throw new Error('watcher would not close'); },
        };
      },
    });
    seedRow(stack, 'stuck', 'stuck-stop');
    await stack.startAll();
    const stored = stack.instances.get('file', 'stuck')!;

    await expect(stack.enrollDeps.onResync!({
      slug: stored.slug,
      platform: 'file',
      adapter_type: stored.adapter_type,
      caps: stored.caps,
      auth_state: stored.auth_state,
      last_synced_at: stored.last_synced_at,
    })).rejects.toThrow('watcher would not close');

    await expect(stack.enrollDeps.onResync!({
      slug: stored.slug,
      platform: 'file',
      adapter_type: stored.adapter_type,
      caps: stored.caps,
      auth_state: stored.auth_state,
      last_synced_at: stored.last_synced_at,
    })).rejects.toThrow('watcher would not close');

    expect(starts).toBe(1);
  });

  it('refuses a stale resync snapshot after the instance row is deleted', async () => {
    let starts = 0;
    stack.adapters.register({
      type: 'delete-race',
      async probeCaps() {
        return {
          read: 'yes', write: 'no', delete: 'no', watch: 'none',
          mirror: 'disabled', auth: 'none', path_style: 'posix',
        };
      },
      create() {
        return {
          async start() { starts++; },
          async stop() {},
        };
      },
    });
    seedRow(stack, 'deleted-row', 'delete-race');
    await stack.startAll();
    const stored = stack.instances.get('file', 'deleted-row')!;
    const staleRow = {
      slug: stored.slug,
      platform: 'file' as const,
      adapter_type: stored.adapter_type,
      caps: stored.caps,
      auth_state: stored.auth_state,
      last_synced_at: stored.last_synced_at,
    };

    stack.instances.delete('file', 'deleted-row');
    await stack.enrollDeps.onDeleted!('deleted-row');
    await expect(stack.enrollDeps.onResync!(staleRow)).rejects.toThrow(
      "instance row missing for slug 'deleted-row'",
    );

    expect(starts).toBe(1);
  });
});
