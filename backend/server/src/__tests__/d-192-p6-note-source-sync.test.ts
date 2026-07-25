/** D-192 P6 - note Source sync/write regressions over the real SQLite mirror. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ConnectionOperationProfile,
  IngredientManifest,
  Note,
  WorkEntityKind,
  WorkEntityPendingWrite,
} from '@recued/contracts';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type NoteWriteInput,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import {
  createWorkEntitySourceMirrorStore,
  createWorkEntitySourceSyncStateStore,
  ensureWorkEntitySourceSyncStateSchema,
  type WorkEntitySourceMirrorStore,
  type WorkEntitySourceSyncStateStore,
} from '../storage/work-entity-source-mirror.js';
import {
  type GatedCatalogOperationOutcome,
  type GatedCatalogOperationRequest,
  type RunGatedCatalogOperationFn,
  type SourceMirrorFetchDeps,
  type SourceMirrorFetchOutcome,
  type SourceMirrorFetchRequest,
} from '../source-mirror/fetch.js';
import {
  projectWorkEntitySourceRow,
  type ProjectedWorkEntityUpsert,
} from '../work-entity-source-projector.js';
import {
  type KernelWorkEntitySourceDeclaration,
  workEntitySourceContractHash,
} from '../work-entity-source-boot.js';
import {
  runWorkEntitySourceSync,
  type RunSourceMirrorFetchFn,
} from '../work-entity-source-sync.js';
import {
  createWorkEntitySourceWriteExecutor,
  type WorkEntitySourceWriteExecutor,
  type WorkEntityVendorWriteDispatchOutcome,
  type WorkEntityVendorWritePrepared,
  type WorkEntityVendorWritePrepareResult,
} from '../work-entity-write-executor.js';

const NOW = 1_700_000_000_000;
const SOURCE_ID = 'hubspot.acme.note';
const CONNECTION = 'acme';
const CATALOG = 'hubspot-note-test';
const VERSION_1 = '2026-07-01T00:00:00.000Z';
const VERSION_2 = '2026-07-02T00:00:00.000Z';
const VERSION_3 = '2026-07-03T00:00:00.000Z';

let dir: string;
let db: Database.Database;
let store: WorkEntityStore;
let mirror: WorkEntitySourceMirrorStore;
let syncState: WorkEntitySourceSyncStateStore;
let nowMs: number;

interface StageCall {
  kind: WorkEntityKind;
  id: string;
  pending: WorkEntityPendingWrite;
}

interface ExecutorHarness {
  executor: WorkEntitySourceWriteExecutor;
  stageCalls: StageCall[];
}

const op = (
  operation_id: string,
  risk_tier: 'read' | 'write',
  result_path?: string,
): Record<string, unknown> => ({
  operation_id,
  risk_tier,
  ...(result_path !== undefined ? { result_path } : {}),
});

const manifestFake = {
  slug: CATALOG,
  name: 'HubSpot note test catalog',
  description: 'Test catalog for D-192 P6 note Source coverage',
  author: 'recued',
  kind: 'connection',
  category: 'data',
  risk_tier: 'write',
  input: {},
  output: {},
  operations: {
    'note.list': op('note.list', 'read', 'records'),
    'note.read': op('note.read', 'read'),
    'note.update': op('note.update', 'write'),
  },
  surfaces: { api: { result_path: 'records' } },
} as unknown as IngredientManifest;

const profile: ConnectionOperationProfile = {
  allowed_operations: ['note.list', 'note.read', 'note.update'],
  catalog_slug: CATALOG,
};

const fetchDeps = (
  opts: {
    manifest?: IngredientManifest | null;
    profile?: ConnectionOperationProfile | null;
  } = {},
): SourceMirrorFetchDeps => ({
  executorConfig: {
    manifests: {
      get: (slug: string) => (slug === CATALOG ? opts.manifest ?? manifestFake : null),
    },
  },
  profiles: {
    get: (connection_name: string) =>
      connection_name === CONNECTION ? opts.profile ?? profile : null,
  },
} as unknown as SourceMirrorFetchDeps);

const noteDeclaration = (
  overrides: Partial<KernelWorkEntitySourceDeclaration> = {},
): KernelWorkEntitySourceDeclaration => ({
  kind: 'note',
  source_id_template: 'hubspot.${connection_id}.note',
  source_label_template: 'HubSpot notes (${connection_name})',
  source_kind: 'connection',
  remote: {
    entity: 'note',
    id: 'id',
    version: { kind: 'updated_at', field: 'updatedAt' },
    hash_fields: ['title', 'content', 'updatedAt'],
  },
  ops: {
    list: 'note.list',
    read: 'note.read',
    update: 'note.update',
  },
  op_bindings: {
    read: { id_arg: 'noteId' },
    update: { id_arg: 'noteId' },
  },
  sync: {
    mode: 'read_write',
    depth: 'meta',
    tombstones: 'native',
    tombstone_field: 'archived',
    stale_after_ms: 21_600_000,
  },
  read_resolution: {
    default: 'local_rich_meta',
    remote_when: ['write_preflight'],
    wild_query: {
      remote_fanout: 'bounded_targeted',
      max_sources: 1,
      max_remote_records: 10,
      on_exceeds_cap: 'ask_to_narrow',
    },
  },
  projection: {
    canonical: { title: 'title' },
    preview: { body: { field: 'content', max_chars: 96 } },
    extension: { detail_fidelity: 'preview' },
  },
  writable_fields: ['title', 'body'],
  write_policy: {
    conditional_write: 'none',
    stale_write: 'manual_merge',
    field_conflicts: 'manual_merge',
  },
  ...overrides,
});

const sourceRecordIdOf = (record: Record<string, unknown>): string => {
  const id = record.id;
  if (typeof id !== 'string') throw new Error('test vendor note needs a string id');
  return id;
};

const rawNote = (
  id: string,
  title: string,
  content: string,
  updatedAt: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  title,
  content,
  updatedAt,
  ...extra,
});

const okFetch = (
  records: ReadonlyArray<Record<string, unknown>>,
  options: { complete?: boolean; skipped_no_id?: number } = {},
): SourceMirrorFetchOutcome => ({
  ok: true,
  records: new Map(records.map((record) => [sourceRecordIdOf(record), record] as const)),
  truncated: false,
  complete: options.complete ?? true,
  skipped_no_id: options.skipped_no_id ?? 0,
});

const errorFetch = (
  kind: 'config' | 'policy' | 'error' | 'unavailable',
  reason: string,
): SourceMirrorFetchOutcome => ({ ok: false, kind, reason });

const scriptedFetch = (
  ...outcomes: SourceMirrorFetchOutcome[]
): { runFetch: RunSourceMirrorFetchFn; requests: SourceMirrorFetchRequest[] } => {
  const queue = [...outcomes];
  const requests: SourceMirrorFetchRequest[] = [];
  const runFetch: RunSourceMirrorFetchFn = async (_deps, request) => {
    requests.push(request);
    return queue.shift() ?? errorFetch('error', 'no scripted fetch outcome');
  };
  return { runFetch, requests };
};

const opOk = (record: Record<string, unknown>): GatedCatalogOperationOutcome => ({
  ok: true,
  raw: { result: record },
});

const opError = (
  kind: 'config' | 'policy' | 'error' | 'unavailable',
  reason: string,
): GatedCatalogOperationOutcome => ({ ok: false, kind, reason });

const scriptedOperation = (
  ...outcomes: GatedCatalogOperationOutcome[]
): {
  runOperation: RunGatedCatalogOperationFn;
  invocations: GatedCatalogOperationRequest[];
} => {
  const queue = [...outcomes];
  const invocations: GatedCatalogOperationRequest[] = [];
  const runOperation: RunGatedCatalogOperationFn = async (_deps, request) => {
    invocations.push(request);
    return queue.shift() ?? opError('error', 'no scripted operation outcome');
  };
  return { runOperation, invocations };
};

const registerNoteSource = (): void => {
  store.registerSource({
    id: SOURCE_ID,
    top_tier_kind: 'note',
    source_kind: 'connection',
    source_label: 'HubSpot notes (acme)',
    write_capable: false,
    mcp_exposed: false,
    registered_at: NOW,
  });
};

const seedSyncState = (
  declaration: KernelWorkEntitySourceDeclaration = noteDeclaration(),
): void => {
  syncState.upsert({
    source_id: SOURCE_ID,
    contract_hash: workEntitySourceContractHash(declaration),
    sync_depth: declaration.sync.depth,
    sync_mode: declaration.sync.mode,
    cursor_blob: null,
    last_sync_started_at: null,
    last_sync_completed_at: null,
    last_success_at: null,
    last_error_code: null,
    last_error_message: null,
    degraded: false,
    field_health_blob: null,
    list_complete: true,
    stale_after_ms: declaration.sync.stale_after_ms,
  });
};

const runSync = async (
  declaration: KernelWorkEntitySourceDeclaration,
  script: { runFetch: RunSourceMirrorFetchFn },
  deps: SourceMirrorFetchDeps = fetchDeps(),
) =>
  runWorkEntitySourceSync({
    fetchDeps: deps,
    mirror,
    syncState,
    now: () => nowMs,
    runFetch: script.runFetch,
  }, {
    source_id: SOURCE_ID,
    connection_name: CONNECTION,
    declaration,
  });

const expectSyncOk = (
  result: Awaited<ReturnType<typeof runWorkEntitySourceSync>>,
): Extract<Awaited<ReturnType<typeof runWorkEntitySourceSync>>, { ok: true }> => {
  if (!result.ok) throw new Error(`expected sync success, got ${result.kind}: ${result.reason}`);
  return result;
};

const requirePrepared = (
  result: WorkEntityVendorWritePrepareResult,
): WorkEntityVendorWritePrepared => {
  if (!result.ok) {
    throw new Error(`expected prepare success, got config failure: ${result.reason}`);
  }
  if (!result.vendor_relevant) {
    throw new Error(`expected vendor-relevant prepare, got: ${result.reason}`);
  }
  return result.prepared;
};

const requireUpdateOutcome = (
  outcome: WorkEntityVendorWriteDispatchOutcome,
): Extract<WorkEntityVendorWriteDispatchOutcome, { ok: true; operation: 'update' | 'complete' }> => {
  if (!outcome.ok || (outcome.operation !== 'update' && outcome.operation !== 'complete')) {
    throw new Error('expected update dispatch success');
  }
  return outcome;
};

const requireDispatchFailure = (
  outcome: WorkEntityVendorWriteDispatchOutcome,
): Extract<WorkEntityVendorWriteDispatchOutcome, { ok: false }> => {
  if (outcome.ok) throw new Error('expected dispatch failure');
  return outcome;
};

const projectRawNote = (
  record: Record<string, unknown>,
  declaration: KernelWorkEntitySourceDeclaration = noteDeclaration(),
): ProjectedWorkEntityUpsert => {
  const projected = projectWorkEntitySourceRow({
    declaration,
    source_id: SOURCE_ID,
    connection_name: CONNECTION,
    source_record_id: sourceRecordIdOf(record),
    raw: record,
  });
  if (!projected.ok) throw new Error(`expected note projection success: ${projected.reason}`);
  if (projected.upsert.kind !== 'note') {
    throw new Error(`expected note projection, got ${projected.upsert.kind}`);
  }
  return projected.upsert;
};

const upsertRawNote = (
  record: Record<string, unknown>,
  declaration: KernelWorkEntitySourceDeclaration = noteDeclaration(),
): Note => {
  const row = mirror.upsertBySourceIdentity(projectRawNote(record, declaration), NOW);
  if (!('last_user_action_at' in row)) throw new Error('expected note row');
  return row;
};

const noteWriteFrom = (
  note: Note,
  changes: Partial<Pick<
    Note,
    | 'title'
    | 'body'
    | 'last_user_action_at'
    | 'related_contact_ids'
    | 'related_calendar_event_ids'
    | 'related_mail_thread_ids'
    | 'related_project_ids'
    | 'updated_at'
  >>,
): NoteWriteInput => {
  const write: NoteWriteInput = {
    id: note.id,
    source_id: note.source_id,
    body: changes.body ?? note.body,
    created_at: note.created_at,
    updated_at: changes.updated_at ?? note.updated_at,
    last_user_action_at: changes.last_user_action_at ?? note.last_user_action_at,
    related_contact_ids: changes.related_contact_ids ?? note.related_contact_ids,
    related_calendar_event_ids:
      changes.related_calendar_event_ids ?? note.related_calendar_event_ids,
    related_mail_thread_ids: changes.related_mail_thread_ids ?? note.related_mail_thread_ids,
    related_project_ids: changes.related_project_ids ?? note.related_project_ids,
    sync_state: note.sync_state,
    conflict_policy: note.conflict_policy,
    last_seen_at: note.last_seen_at,
  };
  const copy = <K extends keyof NoteWriteInput>(
    key: K,
    value: NoteWriteInput[K] | undefined,
  ): void => {
    if (value !== undefined) write[key] = value;
  };
  copy('title', changes.title ?? note.title);
  copy('source_record_id', note.source_record_id);
  copy('connection_id', note.connection_id);
  copy('source_updated_at', note.source_updated_at);
  copy('source_record_hash', note.source_record_hash);
  copy('source_extension_blob', note.source_extension_blob);
  copy('source_version_token', note.source_version_token);
  return write;
};

const rewriteNote = (
  note: Note,
  changes: Parameters<typeof noteWriteFrom>[1],
  now = NOW + 1,
): Note => store.writeNote(noteWriteFrom(note, changes), now);

const readNote = (id: string): Note => {
  const row = store.readNote(id);
  if (row === null) throw new Error(`note '${id}' missing`);
  return row;
};

const stageAwaitingVerify = (note: Note, dirty_fields: string[]): void => {
  store.stagePendingWrite('note', note.id, {
    staged_at: NOW + 2,
    operation: 'update',
    dirty_fields,
    base_source_updated_at: note.source_updated_at ?? null,
    base_source_record_hash: note.source_record_hash ?? null,
    base_source_version_token: note.source_version_token ?? null,
    state: 'awaiting_verify',
    attempts: 1,
  });
};

const makeExecutor = (
  opts: {
    declaration?: KernelWorkEntitySourceDeclaration | null;
    deps?: SourceMirrorFetchDeps;
    runOperation?: RunGatedCatalogOperationFn;
    now?: () => number;
  } = {},
): ExecutorHarness => {
  const declaration = opts.declaration === undefined ? noteDeclaration() : opts.declaration;
  const stageCalls: StageCall[] = [];
  const executor = createWorkEntitySourceWriteExecutor({
    fetchDeps: opts.deps ?? fetchDeps(),
    mirror,
    store: {
      stagePendingWrite(kind, id, pending) {
        stageCalls.push({ kind, id, pending });
        return store.stagePendingWrite(kind, id, pending);
      },
      clearPendingWrite(kind, id) {
        return store.clearPendingWrite(kind, id);
      },
    },
    resolveDeclaration: (source_id) =>
      declaration !== null && source_id === SOURCE_ID
        ? { declaration, connection_name: CONNECTION }
        : null,
    now: opts.now ?? (() => NOW + 10),
    ...(opts.runOperation !== undefined ? { runOperation: opts.runOperation } : {}),
  });
  return { executor, stageCalls };
};

const prepareNoteUpdate = (
  executor: WorkEntitySourceWriteExecutor,
  patch: Record<string, unknown>,
): WorkEntityVendorWritePrepared =>
  requirePrepared(executor.prepare({
    source_id: SOURCE_ID,
    kind: 'note',
    operation: 'update',
    patch,
  }));

const expectTokenMovedHashEqual = (
  prior: Note,
  record: Record<string, unknown>,
  declaration: KernelWorkEntitySourceDeclaration,
): void => {
  const projected = projectRawNote(record, declaration).write;
  expect(prior.source_version_token).toBe(VERSION_1);
  expect(projected.source_version_token).not.toBe(prior.source_version_token);
  expect(projected.source_record_hash).toBe(prior.source_record_hash);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd192-p6-note-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  ensureWorkEntitySchema(db);
  ensureWorkEntitySourceSyncStateSchema(db);
  store = createWorkEntityStore(db);
  mirror = createWorkEntitySourceMirrorStore(db, store);
  syncState = createWorkEntitySourceSyncStateStore(db);
  registerNoteSource();
  nowMs = NOW;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('runWorkEntitySourceSync note P6', () => {
  it('syncs note previews into the extension blob, hash-skips identical rows, and native-tombstones by source identity', async () => {
    const declaration = noteDeclaration();
    seedSyncState(declaration);
    const remoteTitle = 'Vendor canonical note title A';
    const remotePreview = 'Vendor preview excerpt A - not complete note body';
    const record = rawNote('note-cycle-1', remoteTitle, remotePreview, VERSION_1);

    nowMs = NOW + 10;
    const firstScript = scriptedFetch(okFetch([record]));
    const first = expectSyncOk(await runSync(declaration, firstScript));

    expect(first).toMatchObject({
      upserted: 1,
      unchanged: 0,
      tombstoned: 0,
      deleted: 0,
      failed_rows: 0,
      skipped_dirty: 0,
      complete: true,
    });
    const row = store.listNotes({ source_id: SOURCE_ID })[0];
    if (row === undefined) throw new Error('expected synced note row');
    const stored = db.prepare(
      `SELECT title, body FROM data_note WHERE source_id = ? AND source_record_id = ?`,
    ).get(SOURCE_ID, 'note-cycle-1') as { title: string | null; body: string } | undefined;
    expect(stored).toEqual({ title: remoteTitle, body: '' });
    expect(row.title).toBe(remoteTitle);
    expect(row.title).not.toBe(remotePreview);
    expect(row.body).toBe('');
    expect(row.body).not.toBe(remotePreview);
    expect(row.source_extension_blob).toEqual({
      preview: { body: remotePreview },
      detail_fidelity: { body: 'preview' },
    });
    expect(row.source_extension_blob?.preview).not.toEqual({ title: remoteTitle });
    expect(row.connection_id).toBe(CONNECTION);
    expect(row.source_record_hash).toMatch(/^fnv1a:/);
    expect(syncState.get(SOURCE_ID)).toMatchObject({
      last_success_at: NOW + 10,
      degraded: false,
      last_error_code: null,
    });
    expect(firstScript.requests).toHaveLength(1);
    expect(firstScript.requests[0]).toMatchObject({
      operationKey: 'note.list',
      args: {},
      resultPath: 'records',
      projectionTemplate: null,
      idField: 'id',
      stepId: 'source_sync',
    });
    const firstUpdatedAt = row.updated_at;

    nowMs = NOW + 20;
    const second = expectSyncOk(await runSync(declaration, scriptedFetch(okFetch([record]))));

    expect(second).toMatchObject({ upserted: 0, unchanged: 1, tombstoned: 0 });
    expect(readNote(row.id).updated_at).toBe(firstUpdatedAt);

    nowMs = NOW + 30;
    const tombstone = expectSyncOk(await runSync(
      declaration,
      scriptedFetch(okFetch([{ id: 'note-cycle-1', archived: true }])),
    ));

    expect(tombstone).toMatchObject({ upserted: 0, unchanged: 0, tombstoned: 1 });
    expect(store.listNotes({ source_id: SOURCE_ID })).toHaveLength(0);
    expect(store.readNote(row.id)?.sync_state).toBe('tombstoned');
    expect(mirror.listSnapshotHashes('note', SOURCE_ID).has('note-cycle-1')).toBe(false);
  });

  it('folds a changed awaiting_verify note row without clearing local body or related contacts', async () => {
    const declaration = noteDeclaration();
    seedSyncState(declaration);
    const baseTitle = 'Vendor note base title B';
    const basePreview = 'Vendor preview base B';
    const foldedTitle = 'Vendor folded title B';
    const foldedPreview = 'Vendor folded preview B - not local body';
    const localBody = 'Local complete note body B survives fold';
    const localContact = 'contact-local-B-survives';

    nowMs = NOW + 10;
    expectSyncOk(await runSync(
      declaration,
      scriptedFetch(okFetch([rawNote('note-awaiting-1', baseTitle, basePreview, VERSION_1)])),
    ));
    const seeded = store.listNotes({ source_id: SOURCE_ID })[0];
    if (seeded === undefined) throw new Error('expected seeded note row');
    const local = rewriteNote(seeded, {
      body: localBody,
      related_contact_ids: [localContact],
      last_user_action_at: NOW + 15,
      updated_at: NOW + 15,
    }, NOW + 15);
    stageAwaitingVerify(seeded, ['body']);
    expect(readNote(local.id).pending_write).toMatchObject({
      state: 'awaiting_verify',
      dirty_fields: ['body'],
    });

    nowMs = NOW + 30;
    const folded = expectSyncOk(await runSync(
      declaration,
      scriptedFetch(okFetch([
        rawNote('note-awaiting-1', foldedTitle, foldedPreview, VERSION_2),
      ])),
    ));

    expect(folded).toMatchObject({
      upserted: 1,
      unchanged: 0,
      skipped_dirty: 0,
      failed_rows: 0,
    });
    const row = readNote(local.id);
    expect(row.title).toBe(foldedTitle);
    expect(row.title).not.toBe(localBody);
    expect(row.body).toBe(localBody);
    expect(row.body).not.toBe('');
    expect(row.body).not.toBe(foldedPreview);
    expect(row.related_contact_ids).toEqual([localContact]);
    expect(row.related_contact_ids).not.toEqual([foldedPreview]);
    expect(row.source_extension_blob).toEqual({
      preview: { body: foldedPreview },
      detail_fidelity: { body: 'preview' },
    });
    expect(row.source_extension_blob?.preview).not.toEqual({ body: localBody });
    expect(row.pending_write).toBeUndefined();
  });
});

describe('createWorkEntitySourceWriteExecutor note P6', () => {
  it('guards token-moved/hash-equal note preview writes while allowing source-wins and canonical-only updates', async () => {
    const baseTitle = 'Vendor note base title C';
    const basePreview = 'Vendor preview text C';

    const manualDeclaration = noteDeclaration({
      write_policy: {
        conditional_write: 'none',
        stale_write: 'manual_merge',
        field_conflicts: 'manual_merge',
      },
    });
    const manualPrior = upsertRawNote(
      rawNote('note-token-manual', baseTitle, basePreview, VERSION_1),
      manualDeclaration,
    );
    const manualLocalBody = 'Local preview-lane patch C manual';
    const manualCurrent = rewriteNote(manualPrior, {
      body: manualLocalBody,
      last_user_action_at: NOW + 11,
      updated_at: NOW + 11,
    }, NOW + 11);
    const manualPreflight = rawNote('note-token-manual', baseTitle, basePreview, VERSION_2);
    expectTokenMovedHashEqual(manualPrior, manualPreflight, manualDeclaration);
    const manualScript = scriptedOperation(opOk(manualPreflight));
    const manualHarness = makeExecutor({
      declaration: manualDeclaration,
      runOperation: manualScript.runOperation,
      now: () => NOW + 12,
    });
    const manualPrepared = prepareNoteUpdate(manualHarness.executor, { body: manualLocalBody });

    const conflict = requireDispatchFailure(await manualHarness.executor.dispatch(
      manualPrepared,
      { local_id: manualPrior.id, prior: manualPrior, current: manualCurrent },
    ));

    expect(conflict).toMatchObject({
      kind: 'conflict',
      conflicting_fields: ['body'],
      staged: true,
    });
    expect(manualScript.invocations.map((i) => i.operationKey)).toEqual(['note.read']);
    expect(manualScript.invocations.map((i) => i.operationKey)).not.toContain('note.update');
    expect(readNote(manualPrior.id)).toMatchObject({
      body: manualLocalBody,
      pending_write: expect.objectContaining({
        state: 'pending',
        dirty_fields: ['body'],
        base_source_version_token: VERSION_1,
        base_source_record_hash: manualPrior.source_record_hash,
      }),
    });
    expect(readNote(manualPrior.id).body).not.toBe(basePreview);

    const sourceWinsDeclaration = noteDeclaration({
      write_policy: {
        conditional_write: 'none',
        stale_write: 'source_wins',
        field_conflicts: 'manual_merge',
      },
    });
    const sourceWinsPrior = upsertRawNote(
      rawNote('note-token-source-wins', baseTitle, basePreview, VERSION_1),
      sourceWinsDeclaration,
    );
    const sourceWinsLocalBody = 'Local preview-lane patch C source-wins';
    const sourceWinsCurrent = rewriteNote(sourceWinsPrior, {
      body: sourceWinsLocalBody,
      last_user_action_at: NOW + 21,
      updated_at: NOW + 21,
    }, NOW + 21);
    const sourceWinsPreflight = rawNote(
      'note-token-source-wins',
      baseTitle,
      basePreview,
      VERSION_2,
    );
    expectTokenMovedHashEqual(sourceWinsPrior, sourceWinsPreflight, sourceWinsDeclaration);
    const sourceWinsScript = scriptedOperation(opOk(sourceWinsPreflight));
    const sourceWinsHarness = makeExecutor({
      declaration: sourceWinsDeclaration,
      runOperation: sourceWinsScript.runOperation,
      now: () => NOW + 22,
    });
    const sourceWinsPrepared = prepareNoteUpdate(
      sourceWinsHarness.executor,
      { body: sourceWinsLocalBody },
    );

    const sourceWins = requireUpdateOutcome(await sourceWinsHarness.executor.dispatch(
      sourceWinsPrepared,
      { local_id: sourceWinsPrior.id, prior: sourceWinsPrior, current: sourceWinsCurrent },
    ));

    expect(sourceWins).toMatchObject({
      ok: true,
      operation: 'update',
      applied: 'vendor_won',
      verified: false,
    });
    expect(sourceWinsScript.invocations.map((i) => i.operationKey)).toEqual(['note.read']);
    expect(sourceWinsScript.invocations.map((i) => i.operationKey)).not.toContain('note.update');
    expect(readNote(sourceWinsPrior.id)).toMatchObject({
      body: sourceWinsLocalBody,
      pending_write: expect.objectContaining({
        state: 'awaiting_verify',
        dirty_fields: ['body'],
        base_source_version_token: VERSION_1,
        base_source_record_hash: sourceWinsPrior.source_record_hash,
      }),
    });
    expect(readNote(sourceWinsPrior.id).body).not.toBe(basePreview);

    const canonicalDeclaration = noteDeclaration();
    const canonicalPrior = upsertRawNote(
      rawNote('note-token-canonical', baseTitle, basePreview, VERSION_1),
      canonicalDeclaration,
    );
    const localCanonicalTitle = 'Local canonical note title C pushed';
    const canonicalCurrent = rewriteNote(canonicalPrior, {
      title: localCanonicalTitle,
      last_user_action_at: NOW + 31,
      updated_at: NOW + 31,
    }, NOW + 31);
    const canonicalPreflight = rawNote(
      'note-token-canonical',
      baseTitle,
      basePreview,
      VERSION_2,
    );
    expectTokenMovedHashEqual(canonicalPrior, canonicalPreflight, canonicalDeclaration);
    const canonicalScript = scriptedOperation(
      opOk(canonicalPreflight),
      opOk(rawNote('note-token-canonical', localCanonicalTitle, basePreview, VERSION_3)),
    );
    const canonicalHarness = makeExecutor({
      declaration: canonicalDeclaration,
      runOperation: canonicalScript.runOperation,
      now: () => NOW + 32,
    });
    const canonicalPrepared = prepareNoteUpdate(
      canonicalHarness.executor,
      { title: localCanonicalTitle },
    );

    const pushed = requireUpdateOutcome(await canonicalHarness.executor.dispatch(
      canonicalPrepared,
      { local_id: canonicalPrior.id, prior: canonicalPrior, current: canonicalCurrent },
    ));

    expect(pushed).toMatchObject({
      ok: true,
      operation: 'update',
      applied: 'pushed',
      verified: true,
    });
    expect(canonicalScript.invocations.map((i) => ({
      operationKey: i.operationKey,
      args: i.args,
      stepId: i.stepId,
    }))).toEqual([
      { operationKey: 'note.read', args: { noteId: 'note-token-canonical' }, stepId: 'write_preflight' },
      {
        operationKey: 'note.update',
        args: {
          noteId: 'note-token-canonical',
          'body.title': localCanonicalTitle,
        },
        stepId: 'source_write',
      },
    ]);
    expect(Object.keys(canonicalScript.invocations[1]?.args ?? {})).not.toContain('body.content');
    const canonicalRow = readNote(canonicalPrior.id);
    expect(canonicalRow.title).toBe(localCanonicalTitle);
    expect(canonicalRow.title).not.toBe(basePreview);
    expect(canonicalRow.body).toBe(canonicalCurrent.body);
    expect(canonicalRow.body).not.toBe(basePreview);
    expect(canonicalRow.pending_write).toBeUndefined();
  });
});
