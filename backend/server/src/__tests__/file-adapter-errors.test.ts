/** Phase 7 — FileAdapterError taxonomy + statRecord coverage per adapter. */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  classifyNodeFsError,
  classifyS3Error,
  FileAdapterError,
  isFileAdapterError,
} from '../collections/file/errors.js';
import { fsAdapterFactory } from '../collections/file/adapters/fs/index.js';
import { nullAdapterFactory } from '../collections/file/adapters/null-adapter.js';
import type { FileMutationCapable } from '../collections/file/adapter-registry.js';

describe('FileAdapterError taxonomy', () => {
  it('isFileAdapterError distinguishes typed errors', () => {
    expect(isFileAdapterError(new FileAdapterError('not_found', 'x'))).toBe(true);
    expect(isFileAdapterError(new Error('plain'))).toBe(false);
    expect(isFileAdapterError('string')).toBe(false);
  });

  it('classifyNodeFsError maps common errno codes', () => {
    const mk = (code: string) => {
      const err = new Error(`fake ${code}`) as NodeJS.ErrnoException;
      err.code = code;
      return err;
    };
    expect(classifyNodeFsError(mk('ENOENT'), '/a').code).toBe('not_found');
    expect(classifyNodeFsError(mk('EACCES'), '/a').code).toBe('permission_denied');
    expect(classifyNodeFsError(mk('EPERM'), '/a').code).toBe('permission_denied');
    expect(classifyNodeFsError(mk('EROFS'), '/a').code).toBe('permission_denied');
    expect(classifyNodeFsError(mk('EISDIR'), '/a').code).toBe('io_error');
    expect(classifyNodeFsError(mk('ENOSPC'), '/a').code).toBe('io_error');
    expect(classifyNodeFsError(mk('WEIRD'), '/a').code).toBe('io_error');
  });

  it('classifyS3Error handles code + status fallbacks', () => {
    const mk = (fields: { code?: string; status?: number }) =>
      Object.assign(new Error('fake'), fields);
    expect(classifyS3Error(mk({ code: 'NoSuchKey' }), 'x').code).toBe('not_found');
    expect(classifyS3Error(mk({ code: 'NoSuchBucket' }), 'x').code).toBe('not_found');
    expect(classifyS3Error(mk({ status: 404 }), 'x').code).toBe('not_found');
    expect(classifyS3Error(mk({ code: 'AccessDenied' }), 'x').code).toBe('permission_denied');
    expect(classifyS3Error(mk({ status: 403 }), 'x').code).toBe('permission_denied');
    expect(classifyS3Error(mk({ code: 'TOO_LARGE' }), 'x').code).toBe('too_large');
    expect(classifyS3Error(mk({ code: 'SomeOther' }), 'x').code).toBe('io_error');
  });
});

describe('fs adapter statRecord', () => {
  const makeRoot = (): string => mkdtempSync(join(tmpdir(), 'recued-fs-stat-'));

  it('returns exists: true with size + mtime + mime for a present file', async () => {
    const root = makeRoot();
    try {
      writeFileSync(join(root, 'hello.json'), '{"a":1}');
      const adapter = fsAdapterFactory.create({
        slug: 't',
        config: { path: root },
        onEvent: () => {},
      }) as FileMutationCapable;
      await adapter.start();
      try {
        const stat = await adapter.statRecord('hello.json');
        expect(stat.exists).toBe(true);
        expect(stat.size_bytes).toBe(7);
        expect(typeof stat.modified_at_ms).toBe('number');
        expect(stat.mime).toBe('application/json');
      } finally {
        await adapter.stop();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns exists: false when the file is missing (NOT an error)', async () => {
    const root = makeRoot();
    try {
      const adapter = fsAdapterFactory.create({
        slug: 't',
        config: { path: root },
        onEvent: () => {},
      }) as FileMutationCapable;
      await adapter.start();
      try {
        const stat = await adapter.statRecord('ghost.txt');
        expect(stat).toEqual({ exists: false });
      } finally {
        await adapter.stop();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects path escapes during stat (io_error, not permission)', async () => {
    const root = makeRoot();
    try {
      const adapter = fsAdapterFactory.create({
        slug: 't',
        config: { path: root },
        onEvent: () => {},
      }) as FileMutationCapable;
      await adapter.start();
      try {
        await expect(
          adapter.statRecord('../outside.txt'),
        ).rejects.toThrow(FileAdapterError);
      } finally {
        await adapter.stop();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('read on missing file throws FileAdapterError(not_found)', async () => {
    const root = makeRoot();
    try {
      const adapter = fsAdapterFactory.create({
        slug: 't',
        config: { path: root },
        onEvent: () => {},
      }) as FileMutationCapable;
      await adapter.start();
      try {
        try {
          await adapter.readRecord('ghost.txt');
          throw new Error('expected throw');
        } catch (err) {
          expect(isFileAdapterError(err)).toBe(true);
          expect((err as FileAdapterError).code).toBe('not_found');
        }
      } finally {
        await adapter.stop();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('write into a read-only directory throws FileAdapterError(permission_denied)', async () => {
    if (process.platform === 'win32') return;
    const root = makeRoot();
    try {
      const adapter = fsAdapterFactory.create({
        slug: 't',
        config: { path: root },
        onEvent: () => {},
      }) as FileMutationCapable;
      await adapter.start();
      chmodSync(root, 0o500);
      try {
        try {
          await adapter.writeRecord('x.txt', new Uint8Array([1, 2, 3]));
          throw new Error('expected throw');
        } catch (err) {
          expect(isFileAdapterError(err)).toBe(true);
          expect((err as FileAdapterError).code).toBe('permission_denied');
        }
      } finally {
        chmodSync(root, 0o700);
        await adapter.stop();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('null-adapter statRecord', () => {
  it('returns cached stat after writeRecord', async () => {
    const adapter = nullAdapterFactory.create({
      slug: 't',
      config: {},
      onEvent: () => {},
    }) as FileMutationCapable;
    await adapter.start();
    try {
      await adapter.writeRecord('hello.txt', new TextEncoder().encode('hello'), 'text/plain');
      const stat = await adapter.statRecord('hello.txt');
      expect(stat.exists).toBe(true);
      expect(stat.size_bytes).toBe(5);
      expect(stat.mime).toBe('text/plain');
      expect(typeof stat.modified_at_ms).toBe('number');
    } finally {
      await adapter.stop();
    }
  });

  it('returns exists:false for missing records', async () => {
    const adapter = nullAdapterFactory.create({
      slug: 't',
      config: {},
      onEvent: () => {},
    }) as FileMutationCapable;
    await adapter.start();
    try {
      expect(await adapter.statRecord('ghost')).toEqual({ exists: false });
    } finally {
      await adapter.stop();
    }
  });

  it('read on missing throws FileAdapterError(not_found) (distinct from stat)', async () => {
    const adapter = nullAdapterFactory.create({
      slug: 't',
      config: {},
      onEvent: () => {},
    }) as FileMutationCapable;
    await adapter.start();
    try {
      try {
        await adapter.readRecord('ghost');
        throw new Error('expected throw');
      } catch (err) {
        expect(isFileAdapterError(err)).toBe(true);
        expect((err as FileAdapterError).code).toBe('not_found');
      }
    } finally {
      await adapter.stop();
    }
  });
});
