/** Phase 7 — end-to-end file-stat exercise.
 *
 *  Wires the kernel adapter → dispatcher → fs adapter chain the way
 *  bin.ts composes in production, and exercises real recipes + real
 *  files. Covers: happy path, missing record, permission error,
 *  read-with-mime, move surfacing FILE_NOT_FOUND on missing source. */

import Database from 'better-sqlite3';
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKernelAdapter, type KernelDispatchers } from '@recued/ingredients';
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
import { fsAdapterFactory } from '../collections/file/adapters/fs/index.js';
import type {
  FileAdapterInstance,
  FileMutationCapable,
} from '../collections/file/adapter-registry.js';

const call = (slug: string, input: Record<string, unknown>) => ({
  slug,
  risk_tier: 'write' as const,
  input,
  output: {},
});

const fullCaps = () => ({
  read: 'yes' as const,
  write: 'yes' as const,
  delete: 'yes' as const,
  watch: 'realtime' as const,
  mirror: 'optional' as const,
  auth: 'none' as const,
  path_style: 'posix' as const,
});

interface Harness {
  root: string;
  db: Database.Database;
  store: CollectionInstanceStore;
  adapter: FileMutationCapable;
  deps: FileDispatcherDeps;
  kernel: ReturnType<typeof createKernelAdapter>;
}

const mkHarness = async (): Promise<Harness> => {
  const root = mkdtempSync(join(tmpdir(), 'recued-filestat-e2e-'));
  const db = new Database(':memory:');
  const store = createInstanceStore({ db });
  store.upsert({
    platform: 'file',
    slug: 'home',
    adapter_type: 'fs',
    config: { path: root },
    caps: fullCaps(),
    auth_state: 'healthy',
    last_synced_at: null,
  });
  const adapter = fsAdapterFactory.create({
    slug: 'home',
    config: { path: root },
    onEvent: () => {},
  }) as FileMutationCapable;
  await adapter.start();
  const adapters = new Map<string, FileAdapterInstance>([['home', adapter]]);
  const deps: FileDispatcherDeps = {
    instances: store,
    getAdapter: (slug) => adapters.get(slug),
  };
  const dispatchers: KernelDispatchers = {
    fileRead: (args) => handleFileRead(deps, args),
    fileWrite: (args) => handleFileWrite(deps, args),
    fileDelete: (args) => handleFileDelete(deps, args),
    fileMove: (args) => handleFileMove(deps, args),
    fileStat: (args) => handleFileStat(deps, args),
  };
  const kernel = createKernelAdapter(dispatchers);
  return { root, db, store, adapter, deps, kernel };
};

describe('file-stat / refined errors — end-to-end (Phase 7)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await mkHarness();
  });
  afterEach(async () => {
    await h.adapter.stop();
    h.db.close();
    rmSync(h.root, { recursive: true, force: true });
  });

  it('file-stat returns full metadata after a file-write', async () => {
    await h.kernel(
      call('file-write', {
        slug: 'home',
        path: 'docs/report.json',
        body_b64: Buffer.from('{"a":1}').toString('base64'),
        mime: 'application/json',
      }),
    );
    const stat = await h.kernel(
      call('file-stat', { slug: 'home', path: 'docs/report.json' }),
    );
    expect(stat).toMatchObject({
      exists: true,
      size_bytes: 7,
      mime: 'application/json',
    });
  });

  it('file-stat returns { exists: false } for a missing file', async () => {
    const stat = await h.kernel(
      call('file-stat', { slug: 'home', path: 'never-existed.txt' }),
    );
    expect(stat).toEqual({ exists: false });
  });

  it('file-read error on missing file surfaces FILE_NOT_FOUND', async () => {
    try {
      await h.kernel(
        call('file-read', { slug: 'home', path: 'nope.txt' }),
      );
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Error).message).toMatch(/FILE_NOT_FOUND/);
    }
  });

  it('file-read returns mime when the adapter detects it', async () => {
    writeFileSync(join(h.root, 'page.html'), '<html></html>');
    const res = (await h.kernel(
      call('file-read', { slug: 'home', path: 'page.html' }),
    )) as { body_b64: string; mime?: string };
    expect(res.mime).toBe('text/html');
  });

  it('file-write to read-only dir surfaces FILE_PERMISSION_DENIED', async () => {
    if (process.platform === 'win32') return;
    chmodSync(h.root, 0o500);
    try {
      try {
        await h.kernel(
          call('file-write', {
            slug: 'home',
            path: 'block.txt',
            body_b64: Buffer.from('x').toString('base64'),
          }),
        );
        throw new Error('expected throw');
      } catch (err) {
        expect((err as Error).message).toMatch(/FILE_PERMISSION_DENIED/);
      }
    } finally {
      chmodSync(h.root, 0o700);
    }
  });

  it('file-move from a missing source surfaces FILE_NOT_FOUND (not 502)', async () => {
    try {
      await h.kernel(
        call('file-move', {
          from_slug: 'home',
          from_path: 'missing',
          to_slug: 'home',
          to_path: 'dest',
        }),
      );
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Error).message).toMatch(/FILE_NOT_FOUND/);
    }
  });

  it('kernel file-stat goes through dispatcher and reaches the adapter', async () => {
    writeFileSync(join(h.root, 'direct.txt'), 'hi');
    const stat = (await h.kernel(
      call('file-stat', { slug: 'home', path: 'direct.txt' }),
    )) as { exists: boolean; size_bytes?: number; mime?: string };
    expect(stat.exists).toBe(true);
    expect(stat.size_bytes).toBe(2);
  });

  it('file-stat bypasses the instance-not-found check with an unknown slug', async () => {
    try {
      await h.kernel(
        call('file-stat', { slug: 'ghost', path: 'x' }),
      );
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Error).message).toMatch(/FILE_INSTANCE_NOT_FOUND/);
    }
  });
});
