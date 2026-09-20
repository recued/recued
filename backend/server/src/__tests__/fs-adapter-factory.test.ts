/** Phase 7 (D-110) — fs adapter factory tests.
 *
 *  Covers the probe + factory lifecycle + path-escape defence. The
 *  underlying createFsWatcher has its own coverage in
 *  file-collection.test.ts — these tests only exercise the Phase 7
 *  wrapping layer. */

import {
  mkdtempSync, existsSync, writeFileSync, rmSync, chmodSync, symlinkSync, readFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fsAdapterFactory,
} from '../collections/file/adapters/fs/index.js';
import { probeFsCaps } from '../collections/file/adapters/fs/probe.js';
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
  });

  it('reports realtime only when a recursive watcher attaches', async () => {
    const caps = await probeFsCaps(
      { path: root },
      { probeRealtimeWatch: async () => true },
    );
    expect(caps.watch).toBe('realtime');
  });

  it('reports none, never poll, when recursive watching is unavailable', async () => {
    const caps = await probeFsCaps(
      { path: root },
      { probeRealtimeWatch: async () => false },
    );
    expect(caps.watch).toBe('none');
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

  it('watch:none performs one initial scan and stays usable without polling', async () => {
    writeFileSync(join(root, 'existing.txt'), 'before start');
    const events: string[] = [];
    const adapter = fsAdapterFactory.create({
      slug: 'one-shot',
      config: { path: root },
      caps: {
        read: 'yes', write: 'yes', delete: 'yes', watch: 'none',
        mirror: 'optional', auth: 'none', path_style: 'posix',
      },
      onEvent: (event) => { events.push(`${event.type}:${event.path}`); },
    }) as FileMutationCapable;

    await adapter.start();
    try {
      expect(events).toEqual([`present:${join(root, 'existing.txt')}`]);
      await adapter.writeRecord('manual.txt', new TextEncoder().encode('still usable'));
      expect(await readFile(join(root, 'manual.txt'), 'utf8')).toBe('still usable');
      // No background watcher means the direct write does not synthesize a
      // second event; a future refresh requires explicit Re-sync.
      expect(events).toHaveLength(1);
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

  it('\u26d4\u26d4 HAZARD \u2014 a SYMLINK inside the root is followed, in AND out', async () => {
    // \u26d4\u26d4 THIS PINS WHAT THE CODE DOES, NOT WHAT IT SHOULD DO. It is an OPEN
    // QUESTION for the owner, recorded executably rather than left in whoever
    // remembers it \u2014 see the `date-comparison-hazard` precedent.
    //
    // `ensureInsideRoot` checks the REQUESTED PATH STRING: it rejects an
    // absolute path and rejects `..`, both pinned in the two tests around
    // this one. It never resolves the path on disk, so a symlink that lives
    // INSIDE the root and points OUTSIDE it satisfies every string check and
    // the operation then runs on the target.
    //
    // \ud83d\udd11 THE ARGUMENT FOR LEAVING IT: a user who symlinks a folder into
    // their file root did so on purpose, and `~/Documents/work -> /Volumes/Work`
    // is an ordinary setup. Resolving links would silently drop those files.
    //
    // \ud83d\udd11 THE ARGUMENT AGAINST: the guard is NAMED `ensureInsideRoot` and its
    // refusal says "path escapes root", which is containment language for a
    // property it does not hold. And the sibling containment check in this
    // same codebase \u2014 `execution/run-scratch.ts` \u2014 calls `realpathSync`
    // BEFORE comparing, then refuses with "path escapes the run-scratch root".
    // Two postures, neither stating why it differs from the other.
    //
    // \u26a0 What does NOT extend the reach: the caller cannot CREATE the link.
    // `writeRecord` uses `writeFile`, which writes a regular file, so the
    // symlink must already exist \u2014 placed by the user or another local
    // process, not by a recipe or an MCP caller choosing a path.
    const outside = mkdtempSync(join(tmpdir(), 'recued-fs-outside-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'outside-the-root');
      symlinkSync(outside, join(root, 'link'));
      const adapter = fsAdapterFactory.create({
        slug: 't3b',
        config: { path: root },
        onEvent: () => {},
      }) as FileMutationCapable;
      await adapter.start();
      try {
        // READ through the link succeeds \u2026
        expect(String(await adapter.readRecord('link/secret.txt')))
          .toBe('outside-the-root');
        // \u2026 and so does WRITE, which lands on disk outside the root.
        await adapter.writeRecord('link/planted.txt', new TextEncoder().encode('planted'));
        expect(readFileSync(join(outside, 'planted.txt'), 'utf8')).toBe('planted');
      } finally {
        await adapter.stop();
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
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
