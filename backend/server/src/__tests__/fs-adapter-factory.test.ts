/** Phase 7 (D-110) — fs adapter factory tests.
 *
 *  Covers the probe + factory lifecycle + path-escape defence. The
 *  underlying createFsWatcher has its own coverage in
 *  file-collection.test.ts — these tests only exercise the Phase 7
 *  wrapping layer. */

import { mkdtempSync, existsSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fsAdapterFactory,
} from '../collections/file/adapters/fs/index.js';
import { probeAdapter } from '../collections/file/adapter-registry.js';
import type { FileMutationCapable } from '../collections/file/adapter-registry.js';

const makeRoot = (): string =>
  mkdtempSync(join(tmpdir(), 'recued-fs-adapter-'));

describe('fs adapter probeCaps (Phase 7 / D-110)', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports write + delete on a writable directory', async () => {
    const caps = await probeAdapter(fsAdapterFactory, { path: root });
    expect(caps.read).toBe('yes');
    expect(caps.write).toBe('yes');
    expect(caps.delete).toBe('yes');
    expect(caps.path_style).toBe('posix');
    expect(caps.watch).toBe('realtime');
  });

  it('rejects a non-existent path with a config error', async () => {
    await expect(
      probeAdapter(fsAdapterFactory, { path: '/this/does/not/exist' }),
    ).rejects.toThrow(/not a directory/);
  });

  it('reports write: no on a read-only directory', async () => {
    // Skip this test on platforms where chmod semantics don't apply
    // (Windows — our CI uses macOS/linux so this is a safe skip).
    if (process.platform === 'win32') {
      return;
    }
    chmodSync(root, 0o500);
    try {
      const caps = await probeAdapter(fsAdapterFactory, { path: root });
      expect(caps.write).toBe('no');
      expect(caps.delete).toBe('no');
    } finally {
      chmodSync(root, 0o700);
    }
  });
});

describe('fs adapter factory.create (Phase 7 / D-110)', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('start + writeRecord + readRecord + deleteRecord round-trip', async () => {
    const events: string[] = [];
    const adapter = fsAdapterFactory.create({
      slug: 't1',
      config: { path: root, debounceMs: 10 },
      onEvent: (e) => {
        events.push(`${e.type}:${e.path.replace(root, '<root>')}`);
      },
    }) as FileMutationCapable;

    await adapter.start();
    try {
      await adapter.writeRecord('a/b.txt', new TextEncoder().encode('hello'));
      // File appears on disk immediately (write is synchronous
      // on node fs); watcher events race against this step but
      // aren't what we're asserting here.
      expect(existsSync(join(root, 'a/b.txt'))).toBe(true);
      const roundTrip = await adapter.readRecord('a/b.txt');
      expect(new TextDecoder().decode(roundTrip)).toBe('hello');

      await adapter.deleteRecord('a/b.txt');
      expect(existsSync(join(root, 'a/b.txt'))).toBe(false);
    } finally {
      await adapter.stop();
    }
  });

  it('refuses absolute paths passed as records', async () => {
    const adapter = fsAdapterFactory.create({
      slug: 't2',
      config: { path: root },
      onEvent: () => {},
    }) as FileMutationCapable;
    await adapter.start();
    try {
      await expect(
        adapter.writeRecord('/etc/passwd', new Uint8Array()),
      ).rejects.toThrow(/absolute path not permitted/);
    } finally {
      await adapter.stop();
    }
  });

  it('refuses paths that escape root via .. traversal', async () => {
    const adapter = fsAdapterFactory.create({
      slug: 't3',
      config: { path: root },
      onEvent: () => {},
    }) as FileMutationCapable;
    await adapter.start();
    try {
      await expect(
        adapter.writeRecord('../outside.txt', new Uint8Array()),
      ).rejects.toThrow(/escapes root/);
    } finally {
      await adapter.stop();
    }
  });

  it('deleteRecord is idempotent for missing files', async () => {
    const adapter = fsAdapterFactory.create({
      slug: 't4',
      config: { path: root },
      onEvent: () => {},
    }) as FileMutationCapable;
    await adapter.start();
    try {
      // ENOENT must be swallowed.
      await expect(adapter.deleteRecord('ghost.txt')).resolves.toBeUndefined();
    } finally {
      await adapter.stop();
    }
  });

  it('readRecord surfaces errors for missing files', async () => {
    const adapter = fsAdapterFactory.create({
      slug: 't5',
      config: { path: root },
      onEvent: () => {},
    }) as FileMutationCapable;
    await adapter.start();
    try {
      writeFileSync(join(root, 'exists.txt'), 'data');
      const body = await adapter.readRecord('exists.txt');
      expect(body.length).toBeGreaterThan(0);

      // Non-existent path — fs adapter classifies as FileAdapterError('not_found').
      await expect(adapter.readRecord('missing.txt')).rejects.toThrow(/file not found/);

      // Sanity: readRecord output is the same as fs.readFile.
      const direct = await readFile(join(root, 'exists.txt'));
      expect(Array.from(body)).toEqual(Array.from(direct));
    } finally {
      await adapter.stop();
    }
  });
});
