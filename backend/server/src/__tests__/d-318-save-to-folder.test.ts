/** D-318 follow-up 11 — chat files an emailed attachment into a folder the
 *  owner names: *"ask: put this in my Receipts folder"*.
 *
 *  Through the kernel adapter, the dispatcher and the REAL folder adapter over
 *  temporary folders on disk, with the real instance store: what lands is a
 *  file on disk, and what is refused writes nothing.
 *
 *  ⛔ What matters most here is what is NOT done. A taken name never replaces
 *  the owner's file; a folder name that fits two folders, or none, saves
 *  nothing; a read-only folder is never written. Each is checked on disk. */

import Database from 'better-sqlite3';
import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createKernelAdapter } from '@recued/ingredients';

import { createInstanceStore } from '../collections/instance-store.js';
import { handleFileFolders, handleFileSaveToFolder, type FileFolderDeps } from '../collections/file/dispatcher.js';
import { fsAdapterFactory } from '../collections/file/adapters/fs/index.js';
import type { FileAdapterInstance, FileMutationCapable } from '../collections/file/adapter-registry.js';
import {
  folderRefusal,
  numberedName,
  resolveFolder,
  safeFileName,
  subfoldersOf,
  type FileFolderView,
} from '../collections/file/folder-save.js';

const ATTACHMENT = `file:${'a'.repeat(32)}`;
const PDF = Buffer.from('%PDF-1.4 a scanned receipt\n');

const caps = (write: 'yes' | 'no') => ({
  read: 'yes' as const, write, delete: write, watch: 'realtime' as const, mirror: 'optional' as const,
  auth: 'none' as const, path_style: 'posix' as const,
});

/** Every file under `root`, as paths from it. */
const filesUnder = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push(relative(root, abs).split('\\').join('/'));
    }
  };
  walk(root);
  return out.sort();
};

const opened: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of opened.splice(0).reverse()) await close();
});

/** Connected folders on disk: `documents` (from …/Documents), `archive`, and a
 *  read-only `photos`. The paths a folder's stored files carry are, as on a
 *  server, those of the files in it. */
const harness = async (
  setup: (dirs: { documents: string; archive: string; photos: string }) => void = () => {},
) => {
  const base = mkdtempSync(join(tmpdir(), 'd318-save-to-folder-'));
  const dirs = { documents: join(base, 'Documents'), archive: join(base, 'Archive'), photos: join(base, 'Photos') };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  setup(dirs);
  const db = new Database(':memory:');
  const instances = createInstanceStore({ db });
  const adapters = new Map<string, FileAdapterInstance>();
  for (const [slug, root, write] of [
    ['documents', dirs.documents, 'yes'], ['archive', dirs.archive, 'yes'], ['photos', dirs.photos, 'no'],
  ] as const) {
    instances.upsert({
      platform: 'file', slug, adapter_type: 'fs', config: { path: root }, caps: caps(write),
      auth_state: 'healthy', last_synced_at: null,
    });
    // Walked once, never watched: no test here reads a live event, and on macOS a
    // recursive watcher's close blocks the event loop for seconds under disk load.
    // Live watching is tested in `watched-folders.test.ts`.
    const adapter = fsAdapterFactory.create({
      slug, config: { path: root }, caps: { ...caps(write), watch: 'none' }, onEvent: () => {},
    }) as FileMutationCapable;
    await adapter.start();
    adapters.set(slug, adapter);
  }
  opened.push(async () => {
    for (const adapter of adapters.values()) await (adapter as FileMutationCapable).stop();
    db.close();
    rmSync(base, { recursive: true, force: true });
  });
  const reads: string[] = [];
  const deps: FileFolderDeps & Parameters<typeof handleFileSaveToFolder>[0] = {
    instances,
    getAdapter: (slug) => adapters.get(slug),
    filePaths: (slug, max) => {
      const root = dirs[slug as keyof typeof dirs];
      return root === undefined ? [] : filesUnder(root).filter((path) => path.includes('/')).slice(0, max);
    },
    readFile: async ({ record_id }) => {
      reads.push(record_id);
      if (record_id !== ATTACHMENT) throw new Error(`no file ${record_id}`);
      return { bytes_b64: PDF.toString('base64'), mime_type: 'application/pdf' };
    },
    fileName: (record_id) => (record_id === ATTACHMENT ? 'scan.pdf' : null),
  };
  const kernel = createKernelAdapter({
    fileFolders: async () => handleFileFolders(deps),
    fileSaveToFolder: (input) => handleFileSaveToFolder(deps, input),
  });
  const call = (slug: string, input: Record<string, unknown>) =>
    kernel({ slug, risk_tier: slug === 'file-folders' ? 'read' : 'write', input, output: {} } as never);
  const save = (input: Record<string, unknown>) => call('file-save-to-folder', { file_id: ATTACHMENT, ...input });
  return { dirs, deps, reads, call, save };
};

describe('D-318 follow-up 11 — the folders a file can be saved into', () => {
  it('lists each connected folder, whether it takes a file now, and the folders inside it that hold files', async () => {
    const h = await harness(({ documents }) => {
      mkdirSync(join(documents, 'Receipts', '2026'), { recursive: true });
      writeFileSync(join(documents, 'Receipts', '2026', 'march.pdf'), 'x');
      writeFileSync(join(documents, 'notes.txt'), 'x');
    });
    const { folders } = await h.call('file-folders', {}) as { folders: FileFolderView[] };
    expect(folders.map((folder) => [folder.folder, folder.adapter, folder.root_name, folder.writable])).toEqual([
      ['documents', 'fs', 'Documents', true],
      ['archive', 'fs', 'Archive', true],
      ['photos', 'fs', 'Photos', false],
    ]);
    expect(folders[0]!.subfolders).toEqual(['Receipts', 'Receipts/2026']);
    expect(folders[0]!.inside).toBe('Receipts, Receipts/2026');
    expect(folders[1]!.subfolders).toEqual([]);
  });
});

describe('D-318 follow-up 11 — a file saved into the folder the owner named', () => {
  it('into a folder inside a connected one, by its own name, any case', async () => {
    const h = await harness(({ documents }) => {
      mkdirSync(join(documents, 'Receipts'), { recursive: true });
      writeFileSync(join(documents, 'Receipts', 'old.pdf'), 'old');
    });
    await expect(h.save({ folder: 'my receipts'.replace('my ', '') })).resolves.toMatchObject({
      ok: true, folder: 'documents', path: 'Receipts/scan.pdf', name: 'scan.pdf', renamed: false,
      bytes_written: PDF.length, message: 'Saved scan.pdf in documents/Receipts.',
    });
    expect(readFileSync(join(h.dirs.documents, 'Receipts', 'scan.pdf'))).toEqual(PDF);
    await expect(h.save({ folder: 'RECEIPTS', name: 'lunch.pdf' })).resolves.toMatchObject({ path: 'Receipts/lunch.pdf' });
  });

  it('into a connected folder by its name or its own name on disk, at its top', async () => {
    const h = await harness();
    await expect(h.save({ folder: 'archive' })).resolves.toMatchObject({ folder: 'archive', path: 'scan.pdf' });
    await expect(h.save({ folder: 'Documents', name: 'b.pdf' })).resolves.toMatchObject({ folder: 'documents', path: 'b.pdf' });
    expect(filesUnder(h.dirs.archive)).toEqual(['scan.pdf']);
    expect(filesUnder(h.dirs.documents)).toEqual(['b.pdf']);
  });

  it('into a path from a connected folder, which is made when it is not there yet', async () => {
    const h = await harness();
    await expect(h.save({ folder: 'documents/Receipts/2026' })).resolves.toMatchObject({
      folder: 'documents', path: 'Receipts/2026/scan.pdf', message: 'Saved scan.pdf in documents/Receipts/2026.',
    });
    expect(statSync(join(h.dirs.documents, 'Receipts', '2026', 'scan.pdf')).isFile()).toBe(true);
  });

  it('⛔ never over another file: a taken name gets a number, and the owner’s file is untouched', async () => {
    const h = await harness(({ documents }) => {
      mkdirSync(join(documents, 'Receipts'), { recursive: true });
      writeFileSync(join(documents, 'Receipts', 'scan.pdf'), 'the owner’s own scan');
    });
    await expect(h.save({ folder: 'Receipts' })).resolves.toMatchObject({
      path: 'Receipts/scan (2).pdf', name: 'scan (2).pdf', renamed: true,
      message: 'Saved as scan (2).pdf in documents/Receipts: scan.pdf was already there.',
    });
    await expect(h.save({ folder: 'Receipts' })).resolves.toMatchObject({ path: 'Receipts/scan (3).pdf' });
    expect(readFileSync(join(h.dirs.documents, 'Receipts', 'scan.pdf'), 'utf8')).toBe('the owner’s own scan');
    expect(filesUnder(h.dirs.documents)).toEqual(['Receipts/scan (2).pdf', 'Receipts/scan (3).pdf', 'Receipts/scan.pdf']);
  });

  it('⛔ a name that fits two folders saves nothing, and names both', async () => {
    const h = await harness(({ documents, archive }) => {
      for (const root of [documents, archive]) {
        mkdirSync(join(root, 'Receipts'), { recursive: true });
        writeFileSync(join(root, 'Receipts', 'old.pdf'), 'old');
      }
    });
    await expect(h.save({ folder: 'Receipts' })).rejects.toThrow(
      'FOLDER_NOT_FOUND: "Receipts" fits more than one folder: documents/Receipts, archive/Receipts. Ask the owner which.',
    );
    expect(h.reads).toEqual([]);
    expect(filesUnder(h.dirs.documents)).toEqual(['Receipts/old.pdf']);
    expect(filesUnder(h.dirs.archive)).toEqual(['Receipts/old.pdf']);
    // Said as a path, it is one folder.
    await expect(h.save({ folder: 'archive/Receipts' })).resolves.toMatchObject({ folder: 'archive', path: 'Receipts/scan.pdf' });
  });

  it('⛔ a name that fits none saves nothing, and names the folders Recued can save into', async () => {
    const h = await harness();
    await expect(h.save({ folder: 'Receipts' })).rejects.toThrow(
      'FOLDER_NOT_FOUND: There is no folder called "Receipts". The folders Recued can save into: documents, archive.',
    );
    expect(h.reads).toEqual([]);
    expect(filesUnder(h.dirs.documents)).toEqual([]);
  });

  it('⛔ a read-only folder is never written, and its file is not even read', async () => {
    const h = await harness(({ photos }) => {
      mkdirSync(join(photos, 'Receipts'), { recursive: true });
      writeFileSync(join(photos, 'Receipts', 'old.jpg'), 'old');
    });
    await expect(h.save({ folder: 'photos' })).rejects.toThrow('FOLDER_NOT_WRITABLE');
    await expect(h.save({ folder: 'Receipts' })).rejects.toThrow('FOLDER_NOT_WRITABLE');
    expect(h.reads).toEqual([]);
    expect(filesUnder(h.dirs.photos)).toEqual(['Receipts/old.jpg']);
  });

  it('⛔ a name with a folder in it, or a folder name with "..", saves nothing', async () => {
    const h = await harness();
    await expect(h.save({ folder: 'documents', name: '../escape.pdf' })).rejects.toThrow('FILE_NAME_INVALID');
    await expect(h.save({ folder: 'documents/../..' })).rejects.toThrow('may not hold "." or ".."');
    expect(h.reads).toEqual([]);
    expect(filesUnder(h.dirs.documents)).toEqual([]);
  });

  it('asks for the file and the folder, and says when the file is not there', async () => {
    const h = await harness();
    await expect(h.call('file-save-to-folder', { folder: 'documents' })).rejects.toThrow("'file_id' is required");
    await expect(h.call('file-save-to-folder', { file_id: ATTACHMENT })).rejects.toThrow("'folder' is required");
    await expect(h.call('file-save-to-folder', { file_id: 'file:missing', folder: 'documents' })).rejects.toThrow('no file');
    expect(filesUnder(h.dirs.documents)).toEqual([]);
  });

  it('a file too large is refused before anything is written', async () => {
    const h = await harness();
    await expect(handleFileSaveToFolder({ ...h.deps, maxBytes: 4 }, { file_id: ATTACHMENT, folder: 'documents' }))
      .rejects.toThrow('FILE_TOO_LARGE');
    expect(filesUnder(h.dirs.documents)).toEqual([]);
  });
});

describe('folder-save — finding the folder, and the name', () => {
  const view = (folder: string, subfolders: string[], over: Partial<FileFolderView> = {}): FileFolderView => ({
    folder, adapter: 'fs', root_name: null, writable: true, subfolders, inside: subfolders.join(', '), ...over,
  });

  it('a connected folder of that name wins over a folder inside another; its last parts find a folder inside', () => {
    const folders = [view('receipts', []), view('documents', ['Finance', 'Finance/Receipts'])];
    expect(resolveFolder(folders, 'Receipts')).toEqual({ kind: 'found', folder: 'receipts', dir: '' });
    expect(resolveFolder([folders[1]!], 'Receipts')).toEqual({ kind: 'found', folder: 'documents', dir: 'Finance/Receipts' });
    expect(resolveFolder([folders[1]!], 'finance/receipts')).toEqual({ kind: 'found', folder: 'documents', dir: 'Finance/Receipts' });
    // A path keeps the folder's own spelling when it is there.
    expect(resolveFolder([folders[1]!], 'Documents/finance')).toEqual({ kind: 'found', folder: 'documents', dir: 'Finance' });
    expect(resolveFolder(folders, '  ')).toEqual({ kind: 'none' });
  });

  it('the folders inside come from the files’ paths, sorted and bounded', () => {
    expect(subfoldersOf(['a/b/c.pdf', 'a/d.pdf', 'top.pdf', 'z\\y.pdf'])).toEqual(['a', 'a/b', 'z']);
    expect(subfoldersOf(Array.from({ length: 80 }, (_, i) => `f${String(i).padStart(2, '0')}/x.pdf`))).toHaveLength(50);
  });

  it('a name is a plain name: no path, no "." or "..", control characters dropped, a long one keeps its extension', () => {
    expect(safeFileName('  scan.pdf ')).toBe('scan.pdf');
    expect(safeFileName('a/b.pdf')).toBeNull();
    expect(safeFileName('a\\b.pdf')).toBeNull();
    expect(safeFileName('..')).toBeNull();
    expect(safeFileName('bad\u0000name.pdf')).toBe('badname.pdf');
    const long = safeFileName(`${'x'.repeat(300)}.pdf`)!;
    expect(long).toHaveLength(200);
    expect(long.endsWith('.pdf')).toBe(true);
    expect(numberedName('scan.pdf', 2)).toBe('scan (2).pdf');
    expect(numberedName('README', 3)).toBe('README (3)');
    expect(numberedName('.env', 2)).toBe('.env (2)');
  });

  it('with no writable folder, the refusal says where to connect one', () => {
    expect(folderRefusal('Receipts', { kind: 'none' }, [view('photos', [], { writable: false })]))
      .toBe('There is no folder called "Receipts", and no connected folder Recued can save into.'
        + ' The owner can connect one in Connections, under Files.');
  });
});
