import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createWarehouseEventBus } from '@recued/warehouse-events';

import { composeMailStack } from '../compose.js';

const caps = {
  read: 'yes',
  write: 'no',
  delete: 'no',
  watch: 'realtime',
  mirror: 'required',
  auth: 'oauth',
  path_style: 'uri',
} as const;

describe('composeMailStack lifecycle', () => {
  it('coalesces dispose and closes every start path before database teardown', async () => {
    const db = new Database(':memory:');
    const bus = createWarehouseEventBus();
    const stack = composeMailStack(
      db,
      {
        blobs: {
          async put() { return 'blob:test'; },
          async get() { return null; },
          async delete() {},
        } as never,
        getGate: () => ({}) as never,
        bus,
      },
      {},
    );

    const first = stack.disposeAll();
    const second = stack.disposeAll();
    expect(second).toBe(first);
    await first;
    db.close();

    try {
      await expect(stack.startAll()).resolves.toBeUndefined();
      await expect(stack.enrollDeps.onEnrolled?.({
        slug: 'late',
        platform: 'mail',
        adapter_type: 'imap',
        caps: {},
        auth_state: 'healthy',
        last_synced_at: null,
      } as never) ?? Promise.resolve()).resolves.toBeUndefined();
      await expect(stack.resumeSync()).resolves.toBeUndefined();
      expect(stack.listLive()).toEqual([]);
    } finally {
      bus.dispose();
    }
  });

  it('owns credential hydration and coalesces concurrent starts by slug', async () => {
    const db = new Database(':memory:');
    const bus = createWarehouseEventBus();
    let release!: (value: string | null) => void;
    const password = new Promise<string | null>((resolve) => { release = resolve; });
    let reads = 0;
    const stack = composeMailStack(
      db,
      {
        blobs: {
          async put() { return 'blob:test'; },
          async get() { return null; },
          async delete() {},
        } as never,
        getGate: () => ({}) as never,
        bus,
      },
      {
        accountStore: {
          async get() {
            reads += 1;
            return password;
          },
          async set() {},
          async delete() {},
        },
      },
    );
    stack.instances.upsert({
      slug: 'work',
      platform: 'mail',
      adapter_type: 'imap',
      config: {
        host: 'imap.example.com',
        port: 993,
        secure: true,
        username: 'me@example.com',
        folders: ['INBOX'],
      },
      caps,
      auth_state: 'healthy',
      last_synced_at: null,
    });

    const firstStart = stack.startAll();
    const secondStart = stack.startAll();
    await Promise.resolve();
    expect(reads).toBe(1);

    let disposed = false;
    const disposing = stack.disposeAll().then(() => { disposed = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(disposed).toBe(false);

    release(null);
    await Promise.all([firstStart, secondStart, disposing]);
    db.close();
    bus.dispose();
  });
});
