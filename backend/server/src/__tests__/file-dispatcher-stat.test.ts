/** Phase 7 — handleFileStat + refined error mapping tests.
 *
 *  Exercises the full dispatch → adapter → typed error → RpcError
 *  chain using the null-adapter + fs adapter. */

import Database from 'better-sqlite3';
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RpcError } from '@recued/contracts';
import {
  createInstanceStore,
  type CollectionInstanceStore,
} from '../collections/instance-store.js';
import {
  handleFileDelete,
  handleFileMove,
  handleFileRead,
  handleFileStat,
  handleFileWrite,
  type FileDispatcherDeps,
} from '../collections/file/dispatcher.js';
import { nullAdapterFactory } from '../collections/file/adapters/null-adapter.js';
import { fsAdapterFactory } from '../collections/file/adapters/fs/index.js';
import type {
  FileAdapterInstance,
  FileMutationCapable,
} from '../collections/file/adapter-registry.js';

const fullCaps = () => ({
  read: 'yes' as const,
  write: 'yes' as const,
  delete: 'yes' as const,
  watch: 'realtime' as const,
  mirror: 'optional' as const,
  auth: 'none' as const,
  path_style: 'posix' as const,
});

const asRpc = (err: unknown): RpcError => {
  expect(err).toBeInstanceOf(RpcError);
  return err as RpcError;
};

describe('handleFileStat (Phase 7)', () => {
  let db: Database.Database;
  let store: CollectionInstanceStore;
  let adapters: Map<string, FileAdapterInstance>;
  let deps: FileDispatcherDeps;

  beforeEach(async () => {
    db = new Database(':memory:');
    store = createInstanceStore({ db });
    adapters = new Map();
    deps = {
      instances: store,
      getAdapter: (slug) => adapters.get(slug),
    };
    store.upsert({
      platform: 'file',
      slug: 'primary',
      adapter_type: 'null-adapter',
      config: {},
      caps: fullCaps(),
      auth_state: 'healthy',
      last_synced_at: null,
    });
    const adapter = nullAdapterFactory.create({
      slug: 'primary',
      config: {},
      onEvent: () => {},
    }) as FileMutationCapable;
    await adapter.start();
    adapters.set('primary', adapter);
  });
  afterEach(async () => {
    await Promise.all([...adapters.values()].map((a) => a.stop()));
    db.close();
  });

  it('returns size + mtime + mime for an existing file', async () => {
    await handleFileWrite(deps, {
      slug: 'primary',
      path: 'hello.txt',
      body_b64: Buffer.from('hello').toString('base64'),
      mime: 'text/plain',
    });
    const stat = await handleFileStat(deps, { slug: 'primary', path: 'hello.txt' });
    expect(stat.exists).toBe(true);
    expect(stat.size_bytes).toBe(5);
    expect(stat.mime).toBe('text/plain');
    expect(typeof stat.modified_at_ms).toBe('number');
  });

  it('returns { exists: false } without throwing for a missing record', async () => {
    const stat = await handleFileStat(deps, { slug: 'primary', path: 'ghost' });
    expect(stat).toEqual({ exists: false });
  });

  it('404s when the instance slug is unknown', async () => {
    try {
      await handleFileStat(deps, { slug: 'ghost-instance', path: 'x' });
      throw new Error('expected throw');
    } catch (err) {
      const rpc = asRpc(err);
      expect(rpc.status).toBe(404);
      expect(rpc.message).toMatch(/FILE_INSTANCE_NOT_FOUND/);
    }
  });

  it('401s when auth_state is not healthy', async () => {
    store.updateAuthState('file', 'primary', { auth_state: 'expired' });
    try {
      await handleFileStat(deps, { slug: 'primary', path: 'x' });
      throw new Error('expected throw');
    } catch (err) {
      expect(asRpc(err).status).toBe(401);
    }
  });
});

describe('refined error codes on handleFileRead / handleFileDelete / handleFileMove (Phase 7)', () => {
  let root: string;
  let db: Database.Database;
  let adapter: FileMutationCapable;
  let deps: FileDispatcherDeps;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'recued-fs-disp-'));
    db = new Database(':memory:');
    const store = createInstanceStore({ db });
    store.upsert({
      platform: 'file',
      slug: 'fs1',
      adapter_type: 'fs',
      config: { path: root },
      caps: fullCaps(),
      auth_state: 'healthy',
      last_synced_at: null,
    });
    adapter = fsAdapterFactory.create({
      slug: 'fs1',
      config: { path: root },
      onEvent: () => {},
    }) as FileMutationCapable;
    await adapter.start();
    deps = {
      instances: store,
      getAdapter: (slug) => (slug === 'fs1' ? adapter : undefined),
    };
  });
  afterEach(async () => {
    await adapter.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('handleFileRead returns FILE_NOT_FOUND (404) when the record is absent', async () => {
    try {
      await handleFileRead(deps, { slug: 'fs1', path: 'ghost.txt' });
      throw new Error('expected throw');
    } catch (err) {
      const rpc = asRpc(err);
      expect(rpc.status).toBe(404);
      expect(rpc.message).toMatch(/FILE_NOT_FOUND/);
    }
  });

  it('handleFileWrite returns FILE_PERMISSION_DENIED (403) on EACCES', async () => {
    if (process.platform === 'win32') return;
    chmodSync(root, 0o500);
    try {
      try {
        await handleFileWrite(deps, {
          slug: 'fs1',
          path: 'x.txt',
          body_b64: Buffer.from('x').toString('base64'),
        });
        throw new Error('expected throw');
      } catch (err) {
        const rpc = asRpc(err);
        expect(rpc.status).toBe(403);
        expect(rpc.message).toMatch(/FILE_PERMISSION_DENIED/);
      }
    } finally {
      chmodSync(root, 0o700);
    }
  });

  it('handleFileDelete stays silent for missing files (idempotent)', async () => {
    const res = await handleFileDelete(deps, { slug: 'fs1', path: 'ghost' });
    expect(res.ok).toBe(true);
  });

  it('handleFileMove surfaces FILE_NOT_FOUND when source is absent', async () => {
    try {
      await handleFileMove(deps, {
        from_slug: 'fs1',
        from_path: 'missing',
        to_slug: 'fs1',
        to_path: 'dest',
      });
      throw new Error('expected throw');
    } catch (err) {
      const rpc = asRpc(err);
      expect(rpc.status).toBe(404);
      expect(rpc.message).toMatch(/FILE_NOT_FOUND/);
    }
  });

  it('handleFileRead includes mime when the adapter can detect it', async () => {
    await handleFileWrite(deps, {
      slug: 'fs1',
      path: 'data.json',
      body_b64: Buffer.from('{}').toString('base64'),
      mime: 'application/json',
    });
    const res = await handleFileRead(deps, { slug: 'fs1', path: 'data.json' });
    expect(res.mime).toBe('application/json');
  });
});
