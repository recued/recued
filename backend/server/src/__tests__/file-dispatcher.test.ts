/** Phase 7 (D-110) — server-side file-mutation dispatcher tests. */

import Database from 'better-sqlite3';
import { Buffer } from 'node:buffer';
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
  handleFileWrite,
  type FileDispatcherDeps,
} from '../collections/file/dispatcher.js';
import { nullAdapterFactory } from '../collections/file/adapters/null-adapter.js';
import type {
  FileAdapterInstance,
  FileMutationCapable,
} from '../collections/file/adapter-registry.js';

const sampleCaps = (overrides: Partial<{
  write: 'yes' | 'no';
  delete: 'yes' | 'no';
  auth: 'none' | 'oauth' | 'keys';
}> = {}) => ({
  read: 'yes' as const,
  write: (overrides.write ?? 'yes') as 'yes' | 'no',
  delete: (overrides.delete ?? 'yes') as 'yes' | 'no',
  watch: 'realtime' as const,
  mirror: 'optional' as const,
  auth: (overrides.auth ?? 'none') as 'none' | 'oauth' | 'keys',
  path_style: 'posix' as const,
});

describe('file dispatcher (Phase 7 / D-110)', () => {
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

    // Enroll a live happy adapter.
    store.upsert({
      platform: 'file',
      slug: 'primary',
      adapter_type: 'null-adapter',
      config: {},
      caps: sampleCaps(),
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

  it('write → read round-trip works on a healthy instance', async () => {
    const body = new TextEncoder().encode('hello world');
    const res = await handleFileWrite(deps, {
      slug: 'primary',
      path: 'a.txt',
      body_b64: Buffer.from(body).toString('base64'),
    });
    expect(res.bytes_written).toBe(body.length);

    const read = await handleFileRead(deps, { slug: 'primary', path: 'a.txt' });
    expect(Buffer.from(read.body_b64, 'base64').toString('utf8')).toBe('hello world');
  });

  it('delete removes the record', async () => {
    await handleFileWrite(deps, {
      slug: 'primary',
      path: 'gone.txt',
      body_b64: Buffer.from('x').toString('base64'),
    });
    await handleFileDelete(deps, { slug: 'primary', path: 'gone.txt' });
    await expect(
      handleFileRead(deps, { slug: 'primary', path: 'gone.txt' }),
    ).rejects.toThrow(/not found/);
  });

  it('404s when the instance does not exist', async () => {
    try {
      await handleFileWrite(deps, {
        slug: 'ghost',
        path: 'a.txt',
        body_b64: '',
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).status).toBe(404);
      expect((err as RpcError).message).toMatch(/FILE_INSTANCE_NOT_FOUND/);
    }
  });

  it('403s when caps deny the requested mutation', async () => {
    store.updateCaps('file', 'primary', sampleCaps({ write: 'no' }));
    try {
      await handleFileWrite(deps, {
        slug: 'primary',
        path: 'a.txt',
        body_b64: '',
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as RpcError).status).toBe(403);
      expect((err as RpcError).message).toMatch(/FILE_CAPABILITY_DENIED/);
    }
  });

  it('403s on auth_state !== healthy (effective caps short-circuit)', async () => {
    store.updateAuthState('file', 'primary', { auth_state: 'expired' });
    try {
      await handleFileWrite(deps, {
        slug: 'primary',
        path: 'a.txt',
        body_b64: '',
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as RpcError).status).toBe(403);
    }
  });

  it('503s when the adapter is not live', async () => {
    adapters.delete('primary');
    try {
      await handleFileWrite(deps, {
        slug: 'primary',
        path: 'a.txt',
        body_b64: '',
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as RpcError).status).toBe(503);
    }
  });

  it('move copies source to destination and deletes source', async () => {
    // Add a second live instance as the destination.
    store.upsert({
      platform: 'file',
      slug: 'archive',
      adapter_type: 'null-adapter',
      config: {},
      caps: sampleCaps(),
      auth_state: 'healthy',
      last_synced_at: null,
    });
    const dest = nullAdapterFactory.create({
      slug: 'archive',
      config: {},
      onEvent: () => {},
    }) as FileMutationCapable;
    await dest.start();
    adapters.set('archive', dest);

    await handleFileWrite(deps, {
      slug: 'primary',
      path: 'doc.pdf',
      body_b64: Buffer.from('payload').toString('base64'),
    });

    await handleFileMove(deps, {
      from_slug: 'primary',
      from_path: 'doc.pdf',
      to_slug: 'archive',
      to_path: 'backup/doc.pdf',
    });

    const read = await handleFileRead(deps, {
      slug: 'archive',
      path: 'backup/doc.pdf',
    });
    expect(Buffer.from(read.body_b64, 'base64').toString('utf8')).toBe('payload');

    await expect(
      handleFileRead(deps, { slug: 'primary', path: 'doc.pdf' }),
    ).rejects.toThrow(/not found/);
  });

  it('move leaves source intact when destination write fails', async () => {
    store.upsert({
      platform: 'file',
      slug: 'readonly',
      adapter_type: 'null-adapter',
      config: {},
      caps: sampleCaps({ write: 'no' }),
      auth_state: 'healthy',
      last_synced_at: null,
    });
    await handleFileWrite(deps, {
      slug: 'primary',
      path: 'keep.txt',
      body_b64: Buffer.from('staying').toString('base64'),
    });

    try {
      await handleFileMove(deps, {
        from_slug: 'primary',
        from_path: 'keep.txt',
        to_slug: 'readonly',
        to_path: 'x.txt',
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as RpcError).status).toBe(403);
    }

    const read = await handleFileRead(deps, { slug: 'primary', path: 'keep.txt' });
    expect(Buffer.from(read.body_b64, 'base64').toString('utf8')).toBe('staying');
  });
});
