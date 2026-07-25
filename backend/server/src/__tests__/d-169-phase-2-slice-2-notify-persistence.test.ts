/** D-169 P2 Slice 2 - notification fired activity persistence. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Checkpoint } from '@recued/contracts';
import type { ActivityEntry, AuditLogStore, CheckpointStore } from '@recued/storage';
import { createCheckpointStore } from '@recued/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EventBus } from '../events/bus.js';
import { ensureCheckpointSchema } from '../memory-schema.js';
import { ensureSourceDependencyEntitySchema } from '../storage/source-dependency-entity-store.js';
import { composeNotificationBlock } from '../composition/bin/wire-notification-block.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createBlobStore } from '../storage/blob-store.js';
import {
  createAnnotationStore,
  type AnnotationStore,
} from '../storage/annotation-store.js';

const NOW = Date.parse('2026-05-28T18:00:00.000Z');

const eventBus = (
  emit: ReturnType<typeof vi.fn> = vi.fn((event) => ({ cursor: 1, ...event })),
): EventBus & { emit: ReturnType<typeof vi.fn> } => ({
  cursor: vi.fn(() => 0),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  emit,
  replay: vi.fn(() => []),
  subscriberCount: vi.fn(() => 0),
}) as unknown as EventBus & { emit: ReturnType<typeof vi.fn> };

const auditLog = (
  logActivity: ReturnType<typeof vi.fn> = vi.fn(async () => undefined),
): AuditLogStore & { logActivity: ReturnType<typeof vi.fn> } =>
  ({
    get: vi.fn(),
    logActivity,
  }) as unknown as AuditLogStore & { logActivity: ReturnType<typeof vi.fn> };

const checkpointStore = (db: Database.Database): CheckpointStore => {
  const store = createCheckpointStore(
    createSQLiteCollection<Checkpoint>(db, 'checkpoints'),
  );
  ensureCheckpointSchema(db);
  ensureSourceDependencyEntitySchema(db);
  return store;
};

const annotationStore = (
  db: Database.Database,
  dir: string,
): AnnotationStore => {
  let nextId = 0;
  return createAnnotationStore({
    db,
    blobs: createBlobStore(join(dir, 'blobs')),
    now: () => NOW,
    newId: () => `annotation-${++nextId}`,
  });
};

const cleanups: Array<() => void> = [];

const composeHarness = (overrides: {
  auditLog?: AuditLogStore & { logActivity: ReturnType<typeof vi.fn> };
  eventBus?: EventBus & { emit: ReturnType<typeof vi.fn> };
  getExecuteDeps?: () => ExecuteHandlerDeps | undefined;
} = {}) => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  const dir = mkdtempSync(join(tmpdir(), 'notification-persistence-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  const bus = overrides.eventBus ?? eventBus();
  const log = overrides.auditLog ?? auditLog();
  const getExecuteDeps: () => ExecuteHandlerDeps | undefined =
    overrides.getExecuteDeps ?? vi.fn<() => ExecuteHandlerDeps | undefined>(
      () => undefined,
    );
  const stores = {
    db,
    auditLog: log,
    checkpointStore: checkpointStore(db),
    annotationStore: annotationStore(db, dir),
    eventBus: bus,
    getExecuteDeps,
  };

  return {
    ...stores,
    ...composeNotificationBlock(stores),
  };
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe('D-169 P2 Slice 2 composeNotificationBlock notification persistence', () => {
  it('writes a notification_fired activity row when notify fires', async () => {
    const log = auditLog();
    const { block } = composeHarness({ auditLog: log });

    await block.notify({
      title: 'Heads up',
      text: 'Check the run.',
      link_url: 'https://example.test/run',
    });

    expect(log.logActivity).toHaveBeenCalledTimes(1);
    const entry = log.logActivity.mock.calls[0]![0] as ActivityEntry;
    expect(entry).toMatchObject({
      action: 'notification_fired',
      target: '',
    });
    expect(JSON.parse(entry.detail!)).toEqual({
      title: 'Heads up',
      text: 'Check the run.',
      link_url: 'https://example.test/run',
    });
  });

  it('omits title and link_url from detail JSON when they are absent', async () => {
    const log = auditLog();
    const { block } = composeHarness({ auditLog: log });

    await block.notify({ text: 'Untitled notification.' });

    const entry = log.logActivity.mock.calls[0]![0] as ActivityEntry;
    const detail = JSON.parse(entry.detail!) as Record<string, unknown>;
    expect(detail).toEqual({ text: 'Untitled notification.' });
    expect(detail).not.toHaveProperty('title');
    expect(detail).not.toHaveProperty('link_url');
  });

  it('keeps notify best-effort when logActivity rejects', async () => {
    const log = auditLog(vi.fn(async () => {
      throw new Error('activity log unavailable');
    }));
    const { block } = composeHarness({ auditLog: log });

    await expect(block.notify({ text: 'Still delivered.' })).resolves.toBeUndefined();
    expect(log.logActivity).toHaveBeenCalledTimes(1);
  });
});
