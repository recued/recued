/** D-106 follow-up — a watched folder's files become records (2026-10-10).
 *
 *  Until then the file stack watched every enrolled `fs` folder and dropped
 *  every event it produced. These drive the real stack (`composeFileStack`
 *  with the folder records attached) over a real folder. Most cases watch with
 *  `watch: 'none'` (a walk at start, nothing live) and use a resync as the
 *  restart, so they do not depend on when the OS delivers a watch event; one
 *  case attaches a live watch. */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus, type WarehouseEvent } from '@recued/warehouse-events';

import { composeFileStack, type FileStack } from '../collections/file/compose.js';
import { handleFileDelete, handleFileEnroll } from '../collections/file/enroll.js';
import { handleFileRead } from '../collections/file/file-read-handler.js';
import { isInboundFileRecordId } from '../collections/file/inbound-file-collection.js';
import {
  __setSharedWatchHost,
  __stopSharedWatchHost,
  createWatchHost,
  HostedWatch,
  type WatchHost,
} from '../collections/file/watch-host.js';
import {
  isWatchedFolderCollection,
  parseWatchedFileRecordId,
  watchedFileRecordId,
  type WatchedFolderCollection,
} from '../collections/file/watched-folder-collection.js';
import { createCollectionRegistry, type CollectionRegistry } from '../collections/registry.js';
import { listCollectionDataTables } from '../collections/table.js';
import { buildLoadFileCollectionRecord, createFileViewResolverFromRegistry } from '../file-view-resolver.js';
import { createBlobStore } from '../storage/blob-store.js';

const SLUG = 'invoices';

interface World {
  base: string;
  folder: string;
  db: Database.Database;
  stack: FileStack;
  registry: CollectionRegistry;
  events: WarehouseEvent[];
  released: string[];
  enroll(watch?: 'none' | 'realtime', config?: { ignore?: string[] }): Promise<void>;
  resync(): Promise<void>;
  collection(): WatchedFolderCollection;
}

const worlds: World[] = [];

const makeWorld = (): World => {
  const base = mkdtempSync(join(tmpdir(), 'watched-folder-'));
  const folder = join(base, 'Invoices');
  mkdirSync(folder);
  const db = new Database(':memory:');
  const bus = createWarehouseEventBus();
  const events: WarehouseEvent[] = [];
  bus.subscribe('**', (event) => { events.push(event); });
  const registry = createCollectionRegistry();
  const released: string[] = [];
  const stack = composeFileStack(db);
  stack.attachWatchedFolders({
    registry,
    bus,
    gates: {
      get: (slug) => createStorageGate({ quota: 512 * 1024 * 1024, reservePct: 1, surface: `collection:file:${slug}` }),
      release: (slug) => { released.push(slug); },
    },
  });
  const row = () => {
    const stored = stack.instances.get('file', SLUG)!;
    return {
      slug: stored.slug,
      platform: 'file' as const,
      adapter_type: stored.adapter_type,
      caps: stored.caps,
      auth_state: stored.auth_state,
      last_synced_at: stored.last_synced_at,
    };
  };
  const world: World = {
    base, folder, db, stack, registry, events, released,
    async enroll(watch = 'none', config = {}) {
      stack.instances.upsert({
        platform: 'file',
        slug: SLUG,
        adapter_type: 'fs',
        config: { path: folder, ...config },
        caps: { read: 'yes', write: 'yes', delete: 'yes', watch, mirror: 'optional', auth: 'none', path_style: 'posix' },
        auth_state: 'healthy',
        last_synced_at: null,
      });
      await stack.enrollDeps.onEnrolled!(row() as never);
    },
    async resync() {
      await stack.enrollDeps.onResync!(row() as never);
    },
    collection() {
      const c = registry.get('file', SLUG);
      if (!c || !isWatchedFolderCollection(c)) throw new Error('no watched folder collection');
      return c;
    },
  };
  worlds.push(world);
  return world;
};

// ⚠ 120 s for a test with a live watch: under load its events can run late (the
// tests poll up to 45 s). Its close runs in the watch process (`watch-host.ts`), slowly
// under load, and the hook lets that process go after each test, so one test's
// closes never hold up the next one's watch.
const LIVE_WATCH_MS = 120_000;

afterEach(async () => {
  for (const w of worlds.splice(0)) {
    await w.stack.disposeAll().catch(() => {});
    w.db.close();
    rmSync(w.base, { recursive: true, force: true });
  }
  __stopSharedWatchHost();
}, LIVE_WATCH_MS);

const byPath = (c: WatchedFolderCollection) =>
  new Map(c.list({ platform: 'file', slug: SLUG, limit: 100 }).map((r) => [r.hot_fields.path as string, r]));

const eventsFor = (events: WarehouseEvent[], kind: string) =>
  events.filter((e) => e.platform === 'file' && e.slug === SLUG && e.event_kind === kind);

const SKIP_LIVE = process.env.RECUED_SKIP_FS_WATCH_LIVE === '1';

/** Wait for what an OS watch delivers; never sleep for it. */
const until = async (done: () => boolean, ms = 45_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
};

describe('a watched folder’s files become records', () => {
  it('records every file, keeps a small text file’s text, and searches name, path and text', async () => {
    const w = makeWorld();
    mkdirSync(join(w.folder, 'Sandhurst'));
    writeFileSync(join(w.folder, 'Sandhurst', 'invoice-10823.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]));
    writeFileSync(join(w.folder, 'notes.md'), '# Renewal\n\nThe lease renewal notice is due Friday.');
    writeFileSync(join(w.folder, 'big.txt'), 'x'.repeat(70 * 1024));
    writeFileSync(join(w.folder, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    await w.enroll();

    const records = byPath(w.collection());
    expect([...records.keys()].sort()).toEqual(['Sandhurst/invoice-10823.pdf', 'big.txt', 'latin1.txt', 'notes.md']);
    const notes = records.get('notes.md')!;
    expect(notes.hot_fields).toMatchObject({ filename: 'notes.md', path: 'notes.md', mime_type: 'text/markdown' });
    expect(notes.body_inline).toContain('lease renewal notice');
    // Bytes stay on disk: only kept text counts toward what Recued holds.
    expect(notes.size_bytes).toBe(Buffer.byteLength(notes.body_inline!, 'utf8'));
    const pdf = records.get('Sandhurst/invoice-10823.pdf')!;
    expect(pdf.hot_fields).toMatchObject({ filename: 'invoice-10823.pdf', mime_type: 'application/pdf', size: 6 });
    expect(pdf.body_inline).toBeUndefined();
    expect(pdf.size_bytes).toBe(0);
    // Too big, and not clean UTF-8: recorded, no text kept.
    expect(records.get('big.txt')!.body_inline).toBeUndefined();
    expect(records.get('latin1.txt')!.body_inline).toBeUndefined();

    const search = (query: string) =>
      w.collection().search({ platform: 'file', slug: SLUG, query, limit: 10 }).map((m) => m.hot_fields.path);
    expect(search('renewal')).toEqual(['notes.md']);
    expect(search('Sandhurst')).toEqual(['Sandhurst/invoice-10823.pdf']);
    expect(search('10823')).toEqual(['Sandhurst/invoice-10823.pdf']);

    // Its own id space: never mistaken for bytes in the CAS.
    expect(pdf.record_id).toBe(watchedFileRecordId(SLUG, 'Sandhurst/invoice-10823.pdf'));
    expect(parseWatchedFileRecordId(pdf.record_id)).toEqual({ slug: SLUG, path: 'Sandhurst/invoice-10823.pdf' });
    expect(isInboundFileRecordId(pdf.record_id)).toBe(false);
    expect(parseWatchedFileRecordId(`file:local:${Buffer.from(SLUG).toString('base64url')}:a!b`)).toBeNull();
  });

  it('says each file of the first walk is created, with its fields and not its text, then marks the backfill done', async () => {
    const w = makeWorld();
    writeFileSync(join(w.folder, 'notes.md'), 'private text');
    await w.enroll();

    const created = eventsFor(w.events, 'created');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      entity_type: 'file',
      record_id: watchedFileRecordId(SLUG, 'notes.md'),
      record: { filename: 'notes.md', path: 'notes.md', mime_type: 'text/markdown', size: 12 },
    });
    expect(JSON.stringify(created[0])).not.toContain('private text');
    // The first walk's events fire no trigger: the dispatcher suppresses a
    // source until its backfill is done, which the stack marks after the walk.
    expect(w.stack.instances.get('file', SLUG)!.backfill_complete).toBe(true);
  });

  it('records the walk as the folder’s sync, so Connections does not say "First sync pending" for good', async () => {
    const w = makeWorld();
    writeFileSync(join(w.folder, 'notes.md'), 'x');
    const before = Date.now();
    await w.enroll();
    const stored = w.stack.instances.get('file', SLUG)!;
    expect(stored.last_synced_at).toBeGreaterThanOrEqual(before);
    expect(stored.auth_state).toBe('healthy');
  });

  it('a restart walk is quiet for unchanged files, and says what changed, appeared or went', async () => {
    const w = makeWorld();
    writeFileSync(join(w.folder, 'same.txt'), 'unchanged');
    writeFileSync(join(w.folder, 'edited.txt'), 'first');
    writeFileSync(join(w.folder, 'gone.txt'), 'soon gone');
    await w.enroll();
    w.events.length = 0;

    writeFileSync(join(w.folder, 'edited.txt'), 'second, longer');
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(w.folder, 'edited.txt'), later, later);
    writeFileSync(join(w.folder, 'new.txt'), 'new');
    unlinkSync(join(w.folder, 'gone.txt'));
    await w.resync();

    const summary = w.events
      .filter((e) => e.slug === SLUG)
      .map((e) => `${e.event_kind} ${(parseWatchedFileRecordId(e.record_id) ?? { path: '?' }).path}`)
      .sort();
    expect(summary).toEqual(['created new.txt', 'deleted gone.txt', 'updated edited.txt']);
    const updated = eventsFor(w.events, 'updated')[0]!;
    expect(updated.changed_fields).toEqual(expect.arrayContaining(['size', 'mtime', 'body']));
    expect(updated.prev).toMatchObject({ size: 5 });
    expect(byPath(w.collection()).get('edited.txt')!.body_inline).toBe('second, longer');
    expect(byPath(w.collection()).has('gone.txt')).toBe(false);
  });

  it('a walk that could not read part of the folder takes nothing out', async () => {
    if (process.getuid?.() === 0) return; // root reads a 000 directory anyway
    const w = makeWorld();
    mkdirSync(join(w.folder, 'locked'));
    writeFileSync(join(w.folder, 'locked', 'kept.txt'), 'kept');
    await w.enroll();
    w.events.length = 0;
    chmodSync(join(w.folder, 'locked'), 0o000);
    try {
      await w.resync();
    } finally {
      chmodSync(join(w.folder, 'locked'), 0o755);
    }
    expect(byPath(w.collection()).has('locked/kept.txt')).toBe(true);
    expect(eventsFor(w.events, 'deleted')).toEqual([]);
  });

  it('an edited path takes out what is not in the new folder', async () => {
    const w = makeWorld();
    writeFileSync(join(w.folder, 'old.txt'), 'old');
    await w.enroll();
    const moved = join(w.base, 'Elsewhere');
    mkdirSync(moved);
    writeFileSync(join(moved, 'fresh.txt'), 'fresh');
    const stored = w.stack.instances.get('file', SLUG)!;
    w.stack.instances.upsert({ ...stored, config: { path: moved } });
    await w.resync();
    expect([...byPath(w.collection()).keys()]).toEqual(['fresh.txt']);
  });

  it('removing the folder’s enrollment drops its records, with no deleted events', async () => {
    const w = makeWorld();
    writeFileSync(join(w.folder, 'notes.md'), 'x');
    await w.enroll();
    expect(listCollectionDataTables(w.db, 'file')).toHaveLength(1);
    w.events.length = 0;

    await handleFileDelete(w.stack.enrollDeps, { slug: SLUG });

    expect(w.registry.get('file', SLUG)).toBeUndefined();
    expect(listCollectionDataTables(w.db, 'file')).toEqual([]);
    expect(w.released).toEqual([SLUG]);
    // Removing a source is not deleting the owner's files.
    expect(w.events).toEqual([]);
  });

  it('a folder cannot be enrolled as `received`, the name of the files people send', async () => {
    const w = makeWorld();
    await expect(handleFileEnroll(w.stack.enrollDeps, {
      slug: 'received', adapter_type: 'fs', config: { path: w.folder },
    })).rejects.toThrow(/'received' is the name of the files people send you/);
  });

  // A live watch is OS-driven. RECUED_SKIP_FS_WATCH_LIVE=1 skips these on a
  // runner whose watcher misbehaves; nothing else does.
  it.skipIf(SKIP_LIVE)('with a live watch, a file written later lands as a created event', async () => {
    const w = makeWorld();
    await w.enroll('realtime');
    writeFileSync(join(w.folder, 'arrived.txt'), 'hello');
    // The watcher is OS-driven: wait for the record, never sleep for it.
    const deadline = Date.now() + 45_000;
    while (!byPath(w.collection()).has('arrived.txt') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(byPath(w.collection()).get('arrived.txt')!.body_inline).toBe('hello');
    expect(eventsFor(w.events, 'created').map((e) => e.record_id))
      .toContain(watchedFileRecordId(SLUG, 'arrived.txt'));
  }, LIVE_WATCH_MS);

  it('health: current while a live watch is attached, as of the last walk without one', async () => {
    const once = makeWorld();
    await once.enroll('none');
    const first = once.collection().health();
    await new Promise((r) => setTimeout(r, 15));
    expect(once.collection().health().last_indexed_at).toBe(first.last_indexed_at);
    expect(first).toMatchObject({ platform: 'file', slug: SLUG, state: 'connected', auth_state: 'healthy', error_count_24h: 0 });

    const live = makeWorld();
    await live.enroll('realtime');
    const before = live.collection().health().last_indexed_at;
    await new Promise((r) => setTimeout(r, 15));
    expect(live.collection().health().last_indexed_at).toBeGreaterThan(before);
  }, LIVE_WATCH_MS);
});

describe('what a watched folder records, and when it stops', () => {
  it('leaves out what the folder’s ignore patterns name', async () => {
    const w = makeWorld();
    writeFileSync(join(w.folder, 'keep.txt'), 'keep');
    writeFileSync(join(w.folder, '.DS_Store'), '');
    mkdirSync(join(w.folder, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(w.folder, 'node_modules', 'pkg', 'index.js'), '');
    await w.enroll('none', { ignore: ['.DS_Store', '**/node_modules/**'] });
    expect([...byPath(w.collection()).keys()]).toEqual(['keep.txt']);
  });

  it('names a file’s type by its extension, octet-stream when it cannot, and records its mtime', async () => {
    const w = makeWorld();
    writeFileSync(join(w.folder, 'note.md'), '# hi');
    writeFileSync(join(w.folder, 'config.json'), '{}');
    writeFileSync(join(w.folder, 'blob.unknown'), 'xxx');
    await w.enroll();
    const records = byPath(w.collection());
    expect(records.get('note.md')!.hot_fields.mime_type).toBe('text/markdown');
    expect(records.get('config.json')!.hot_fields.mime_type).toBe('application/json');
    expect(records.get('blob.unknown')!.hot_fields.mime_type).toBe('application/octet-stream');
    expect(records.get('note.md')!.hot_fields.mtime).toBeTypeOf('number');
  });

  it('takes out nothing when the folder itself cannot be read: its files may all be there', async () => {
    // An unplugged drive, a moved folder.
    const w = makeWorld();
    writeFileSync(join(w.folder, 'a.txt'), 'a');
    await w.enroll();
    w.events.length = 0;
    rmSync(w.folder, { recursive: true, force: true });
    await w.resync().catch(() => undefined);
    expect(w.events.filter((e) => e.slug === SLUG)).toEqual([]);
    expect([...byPath(w.collection()).keys()]).toEqual(['a.txt']);
  });

  it.skipIf(SKIP_LIVE)('with a live watch, an edit updates the record and a removal takes it out', async () => {
    const w = makeWorld();
    writeFileSync(join(w.folder, 'a.txt'), 'v1');
    writeFileSync(join(w.folder, 'goner.txt'), 'x');
    await w.enroll('realtime');
    w.events.length = 0;
    writeFileSync(join(w.folder, 'a.txt'), 'v2-updated');
    unlinkSync(join(w.folder, 'goner.txt'));
    await until(() => byPath(w.collection()).get('a.txt')?.body_inline === 'v2-updated'
      && !byPath(w.collection()).has('goner.txt'));
    expect(byPath(w.collection()).get('a.txt')!.body_inline).toBe('v2-updated');
    expect(byPath(w.collection()).has('goner.txt')).toBe(false);
    expect(eventsFor(w.events, 'updated').map((e) => e.record_id)).toContain(watchedFileRecordId(SLUG, 'a.txt'));
    expect(eventsFor(w.events, 'deleted').map((e) => e.record_id)).toContain(watchedFileRecordId(SLUG, 'goner.txt'));
  }, LIVE_WATCH_MS);

  it('once its adapter stops, a later file lands nothing and health says disconnected', async () => {
    const w = makeWorld();
    writeFileSync(join(w.folder, 'a.txt'), 'x');
    await w.enroll('realtime');
    const collection = w.collection();
    expect(collection.health().state).toBe('connected');
    await w.stack.disposeAll();
    writeFileSync(join(w.folder, 'b.txt'), 'added after the stop');
    // A live watch would have delivered it well within this (debounce 500 ms).
    await new Promise((r) => setTimeout(r, 1_200));
    expect([...byPath(collection).keys()]).toEqual(['a.txt']);
    expect(collection.health().state).toBe('disconnected');
  }, LIVE_WATCH_MS);

  it('is never pruned by retention: the files are the owner’s, on her disk', async () => {
    const w = makeWorld();
    writeFileSync(join(w.folder, 'a.txt'), 'x');
    await w.enroll();
    expect((await w.collection().runRetention()).skipped_reason).toBe('retention_disabled');
    expect(byPath(w.collection()).has('a.txt')).toBe(true);
  });
});

describe('a watched file in the unified file view', () => {
  it('is found by name or path, as a local file in its folder; text alone does not find it', async () => {
    const w = makeWorld();
    mkdirSync(join(w.folder, 'Sandhurst'));
    writeFileSync(join(w.folder, 'Sandhurst', 'invoice-10823.pdf'), Buffer.from([1, 2, 3]));
    writeFileSync(join(w.folder, 'notes.md'), 'about the renewal');
    await w.enroll();
    const resolver = createFileViewResolverFromRegistry(w.registry);

    const views = resolver.searchFileViews('Sandhurst invoice', 10);
    expect(views).toEqual([expect.objectContaining({
      record_id: watchedFileRecordId(SLUG, 'Sandhurst/invoice-10823.pdf'),
      posture: 'local',
      storage_ref: { kind: 'local', folder: SLUG, path: 'Sandhurst/invoice-10823.pdf' },
      filename: 'invoice-10823.pdf',
      path: 'Sandhurst/invoice-10823.pdf',
      folder: SLUG,
      mime_type: 'application/pdf',
    })]);
    // A text hit names no reason the caller can see, so it is not offered.
    expect(resolver.searchFileViews('renewal', 10)).toEqual([]);

    const id = watchedFileRecordId(SLUG, 'notes.md');
    expect(resolver.getFileView(id)).toMatchObject({ posture: 'local', folder: SLUG, path: 'notes.md' });
    expect(await buildLoadFileCollectionRecord(resolver)('file', id)).toMatchObject({
      source: 'file', kind: 'watched', payload: { record_id: id, hot_fields: { folder: SLUG, posture: 'local' } },
    });
  });
});

describe('reading a watched file by id', () => {
  const readerWorld = async () => {
    const w = makeWorld();
    writeFileSync(join(w.folder, 'notes.md'), 'the contents');
    await w.enroll();
    const audit: Array<{ action: string; detail: string }> = [];
    const deps = {
      registry: w.registry,
      blobs: createBlobStore(join(w.base, 'blobs')),
      auditLog: { logActivity: async (row: { action: string; detail: string }) => { audit.push(row); } } as never,
    };
    return { w, deps, audit, id: watchedFileRecordId(SLUG, 'notes.md') };
  };

  it('reads the bytes from disk and audits the read as local', async () => {
    const { deps, audit, id } = await readerWorld();
    const file = await handleFileRead(deps, { record_id: id });
    expect(Buffer.from(file.bytes_b64, 'base64').toString('utf8')).toBe('the contents');
    expect(file).toMatchObject({
      mime_type: 'text/markdown', filename: 'notes.md', size_bytes: 12,
      blob_hash: createHash('sha256').update('the contents').digest('hex'),
    });
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.detail)).toMatchObject({ posture: 'local', collection: `data.file.${SLUG}` });
  });

  it('refuses one too large, one gone, and any while the folder is not watched', async () => {
    const { w, deps, id } = await readerWorld();
    await expect(handleFileRead(deps, { record_id: id }, undefined, { maxBytes: 3 }))
      .rejects.toMatchObject({ code: 'file_too_large' });
    unlinkSync(join(w.folder, 'notes.md'));
    await expect(handleFileRead(deps, { record_id: id })).rejects.toMatchObject({ code: 'file_not_found' });
    writeFileSync(join(w.folder, 'notes.md'), 'back');
    await w.stack.disposeAll();
    await expect(handleFileRead(deps, { record_id: id })).rejects.toMatchObject({ code: 'file_local_unavailable' });
  });
});

// ⛔ On macOS a folder's watch shares one FSEvents stream with the others in the
// watch process, rebuilt whenever one is added or removed, and what changes
// meanwhile is lost without a word. The folder walks again when that happens.
describe('a watched folder catches up after its watch may have missed changes', () => {
  /** A watch process that watches nothing: when a watch is added or closed it
   *  tells the others to walk again, as the real one does. */
  const SCRIPTED_RESCANS = `
const live = new Set();
process.on('message', (msg) => {
  if (msg.op === 'watch') {
    for (const id of live) process.send({ id, kind: 'rescan' });
    live.add(msg.id);
    process.send({ id: msg.id, kind: 'attached' });
  } else if (msg.op === 'close') {
    live.delete(msg.id);
    for (const id of live) process.send({ id, kind: 'rescan' });
  }
});
process.on('disconnect', () => process.exit(0));
`;

  it.runIf(process.platform === 'darwin')('walks again when another folder comes and goes: what changed lands, what went is taken out', async () => {
    __setSharedWatchHost(createWatchHost({ source: SCRIPTED_RESCANS }));
    try {
      const w = makeWorld();
      writeFileSync(join(w.folder, 'a.txt'), 'a');
      writeFileSync(join(w.folder, 'gone.txt'), 'x');
      await w.enroll('realtime');
      expect([...byPath(w.collection()).keys()].sort()).toEqual(['a.txt', 'gone.txt']);
      // Past the folder's own settle walk (1 s after attaching), which would
      // catch these changes too: from here only a walk on `rescan` can.
      await new Promise((r) => setTimeout(r, 2_000));
      // Changes no event reports: the scripted process delivers none.
      writeFileSync(join(w.folder, 'a.txt'), 'a, edited');
      unlinkSync(join(w.folder, 'gone.txt'));
      writeFileSync(join(w.folder, 'new.txt'), 'new');

      const other = makeWorld();
      await other.enroll('realtime');
      await until(() => byPath(w.collection()).has('new.txt') && !byPath(w.collection()).has('gone.txt'));
      expect([...byPath(w.collection()).keys()].sort()).toEqual(['a.txt', 'new.txt']);
      expect(byPath(w.collection()).get('a.txt')!.body_inline).toBe('a, edited');

      writeFileSync(join(w.folder, 'later.txt'), 'later');
      await handleFileDelete(other.stack.enrollDeps, { slug: SLUG });
      await until(() => byPath(w.collection()).has('later.txt'));
      expect(byPath(w.collection()).has('later.txt')).toBe(true);
    } finally {
      __setSharedWatchHost(undefined);
    }
  }, LIVE_WATCH_MS);

  // ⚠ Opt-in (`RECUED_FS_WATCH_CHURN=1`): real FSEvents rebuilds take minutes on a
  // loaded machine (240 s for this one in a parallel run, 6-26 s alone), and the
  // suite must not wait on them; the scripted case above runs in it instead.
  it.runIf(process.platform === 'darwin' && process.env.RECUED_FS_WATCH_CHURN === '1')('with live watches, every file lands though another folder comes and goes meanwhile', async () => {
    const w = makeWorld();
    await w.enroll('realtime');
    const other = makeWorld();
    // Another folder connected and removed over and over: each rebuilds the
    // stream both watches ride on. Measured 2026-10-19 with no walk after it,
    // 146-148 of 148 files written at this rate were never reported.
    let churning = true;
    const churn = (async () => {
      while (churning) {
        await other.enroll('realtime');
        await new Promise((r) => setTimeout(r, 200));
        await handleFileDelete(other.stack.enrollDeps, { slug: SLUG });
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
    const written: string[] = [];
    for (let i = 0; i < 40; i++) {
      const name = `f${String(i).padStart(2, '0')}.txt`;
      writeFileSync(join(w.folder, name), name);
      written.push(name);
      await new Promise((r) => setTimeout(r, 100));
    }
    churning = false;
    await churn;
    await until(() => written.every((name) => byPath(w.collection()).has(name)), 60_000);
    expect(written.filter((name) => !byPath(w.collection()).has(name))).toEqual([]);
  }, LIVE_WATCH_MS);
});

/** A watch process that reports only what a test tells it to, through `report`. */
const scriptedWatches = () => {
  const report: Array<(eventType: string, filename: string | null) => void> = [];
  const host: WatchHost = {
    watch(_root, listener) {
      report.push(listener);
      const watch = new HostedWatch(report.length, listener, () => {}, () => {});
      watch.receive({ id: report.length, kind: 'attached' });
      return watch;
    },
    stop() {},
  };
  return { host, report };
};

// ⛔ A folder moved in or out can be reported as the folder alone: macOS and Windows do
// both ways, Linux for one moved out (measured 2026-10-20).
describe('a folder moved into or out of a watched folder', () => {
  const projects = (w: World): string => {
    const dir = join(w.base, 'Projects');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'a.txt'), 'a');
    writeFileSync(join(dir, 'sub', 'b.txt'), 'b');
    return dir;
  };
  const deletedPaths = (w: World) =>
    eventsFor(w.events, 'deleted').map((e) => parseWatchedFileRecordId(e.record_id)!.path).sort();

  it('a removal naming a folder takes out the files under it, and only those', async () => {
    const w = makeWorld();
    renameSync(projects(w), join(w.folder, 'Projects'));
    // Names that start like the folder's without being inside it: '-' and '.' sort
    // before '/', '0' just after it, '2' later.
    for (const name of ['Projects-old/c.txt', 'Projects.txt', 'Projects0', 'Projects2/d.txt']) {
      mkdirSync(join(w.folder, name, '..'), { recursive: true });
      writeFileSync(join(w.folder, name), name);
    }
    await w.enroll();
    w.events.length = 0;
    rmSync(join(w.folder, 'Projects'), { recursive: true });

    expect(await w.collection().ingest({ type: 'remove', path: join(w.folder, 'Projects') }))
      .toEqual({ outcome: 'removed' });

    expect([...byPath(w.collection()).keys()].sort())
      .toEqual(['Projects-old/c.txt', 'Projects.txt', 'Projects0', 'Projects2/d.txt']);
    expect(deletedPaths(w)).toEqual(['Projects/a.txt', 'Projects/sub/b.txt']);
    // Nothing stored there: nothing to take out.
    expect(await w.collection().ingest({ type: 'remove', path: join(w.folder, 'Projects') }))
      .toEqual({ outcome: 'unchanged_absent' });
  });

  it.runIf(process.platform === 'darwin')('its files land when it comes in and go when it leaves, the watch naming only the folder', async () => {
    const watches = scriptedWatches();
    __setSharedWatchHost(watches.host);
    try {
      const w = makeWorld();
      writeFileSync(join(w.folder, 'kept.txt'), 'kept');
      await w.enroll('realtime');
      // Past the folder's settle walk (1 s after attaching), which would find the
      // folder too: from here only the watch's report of it can.
      await new Promise((r) => setTimeout(r, 2_000));
      const away = projects(w);
      renameSync(away, join(w.folder, 'Projects'));
      watches.report[0]!('rename', 'Projects');
      await until(() => byPath(w.collection()).has('Projects/sub/b.txt'));
      expect([...byPath(w.collection()).keys()].sort()).toEqual(['Projects/a.txt', 'Projects/sub/b.txt', 'kept.txt']);

      renameSync(join(w.folder, 'Projects'), away);
      watches.report[0]!('rename', 'Projects');
      await until(() => !byPath(w.collection()).has('Projects/a.txt'));
      expect([...byPath(w.collection()).keys()]).toEqual(['kept.txt']);
      expect(deletedPaths(w)).toEqual(['Projects/a.txt', 'Projects/sub/b.txt']);
    } finally {
      __setSharedWatchHost(undefined);
    }
  }, LIVE_WATCH_MS);
});

// The housekeeping walk (`watched-folder-walk`) walks each folder with a live watch
// again now and then, for the changes no event reported.
describe('walking a watched folder again for the housekeeping walk', () => {
  // On macOS the scripted watch process reports nothing; elsewhere the folder's own
  // watch is in this process and its events come 500 ms after a change, later than
  // anything below looks.
  afterEach(() => { __setSharedWatchHost(undefined); });

  it('lists each folder with a live watch and when its last walk ended; a walk again lands what no event reported', async () => {
    __setSharedWatchHost(scriptedWatches().host);
    const w = makeWorld();
    writeFileSync(join(w.folder, 'a.txt'), 'a');
    writeFileSync(join(w.folder, 'gone.txt'), 'x');
    const before = Date.now();
    await w.enroll('realtime');
    const [listed] = w.stack.watchedFolderWalks();
    expect(listed).toEqual({ slug: SLUG, last_walk_at: expect.any(Number) });
    expect(listed!.last_walk_at).toBeGreaterThanOrEqual(before);

    await new Promise((r) => setTimeout(r, 5));
    writeFileSync(join(w.folder, 'new.txt'), 'new');
    unlinkSync(join(w.folder, 'gone.txt'));
    await w.stack.walkFolderAgain(SLUG);

    expect([...byPath(w.collection()).keys()].sort()).toEqual(['a.txt', 'new.txt']);
    expect(w.stack.watchedFolderWalks()[0]!.last_walk_at).toBeGreaterThan(listed!.last_walk_at);
  });

  it('leaves out a folder without a live watch, and one whose adapter stopped', async () => {
    __setSharedWatchHost(scriptedWatches().host);
    const once = makeWorld();
    await once.enroll('none');
    expect(once.stack.watchedFolderWalks()).toEqual([]);

    const live = makeWorld();
    await live.enroll('realtime');
    expect(live.stack.watchedFolderWalks()).toHaveLength(1);
    await live.stack.disposeAll();
    expect(live.stack.watchedFolderWalks()).toEqual([]);
    await live.stack.walkFolderAgain(SLUG);   // and asking for one then walks nothing, quietly
  });
});
