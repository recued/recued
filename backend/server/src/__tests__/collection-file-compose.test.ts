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

    await stack.enrollDeps.onDeleted!('going');
    // The row itself is deleted by the enroll handler AFTER onDeleted;
    // simulate that sequence so the post-drop dispatch reflects the
    // real production path.
    stack.instances.delete('file', 'going');

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
    await stack.disposeAll();
    await stack.disposeAll();
  });

  it('startAll skips rows whose adapter_type is not registered and logs', async () => {
    seedRow(stack, 'orphan', 'adapter-never-shipped');
    seedRow(stack, 'ok');
    await stack.startAll();

    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining("unknown adapter_type 'adapter-never-shipped'"),
    );
    // The healthy adapter still started.
    await expect(
      stack.kernelDispatchers.fileWrite({
        slug: 'ok',
        path: 'p',
        body_b64: '',
      }),
    ).resolves.toEqual({ ok: true, bytes_written: 0 });
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
    // 'fine' still started.
    await expect(
      stack.kernelDispatchers.fileRead({ slug: 'fine', path: 'x' }),
    ).rejects.toThrow(/FILE_NOT_FOUND/);
  });
});
