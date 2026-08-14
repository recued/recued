/** D-192 P5 - work-graph edge substrate coverage.
 *
 *  Exercises the edge store, resolver, sync fold/repair hooks, read
 *  decoration, contact merge forwarding, and Source unregister cleanup
 *  against real in-memory SQLite stores.
 */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  RECUED_BUILTIN_SOURCE_ID,
  buildConnectionVendorEntity,
  composePlatformRecordTargetId,
  CONNECTION_VENDOR_ENTITIES,
  workEntityContactEdgeKey,
  workEntityCrmEdgeKey,
  workEntityRefEdgeKey,
  workEntityWorkEdgeKey,
  WORK_ENTITY_KINDS,
  type ConnectionOperationProfile,
  type ConnectionVendorEntity,
  type ContactRecord,
  type IngredientManifest,
  type Task,
  type WorkEntityEdge,
  type WorkEntityEdgeWrite,
  type WorkEntityPendingWrite,
  type WorkEntitySourceRelationship,
} from '@recued/contracts';
import { createWarehouseEventBus } from '@recued/warehouse-events';

import { createConnectionStore, type ConnectionStoreSqlite } from '../storage/connection-store.js';
import {
  createContactStore,
  type ContactStore,
} from '../storage/contact-store.js';
import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import {
  createWorkEntityEdgeStore,
  ensureWorkEntityEdgeSchema,
  WORK_ENTITY_EDGE_TABLE,
  type WorkEntityEdgeStore,
} from '../storage/work-entity-edge-store.js';
import {
  createWorkEntitySourceMirrorStore,
  createWorkEntitySourceSyncStateStore,
  ensureWorkEntitySourceSyncStateSchema,
  type WorkEntitySourceMirrorStore,
  type WorkEntitySourceSyncStateStore,
} from '../storage/work-entity-source-mirror.js';
import {
  handleWorkEntityGet,
  handleWorkEntityUpsert,
  type WorkEntityCrudRpcDeps,
} from '../work-entity-crud-handler.js';
import {
  desiredWorkEntityEdgesForRow,
  reResolveWorkEntityEdges,
} from '../work-entity-edge-resolution.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import {
  KERNEL_WORK_ENTITY_SOURCE_DECLARATIONS,
  wireWorkEntitySourceBoot,
  workEntitySourceContractHash,
  type KernelWorkEntitySourceDeclaration,
} from '../work-entity-source-boot.js';
import {
  type SourceMirrorFetchDeps,
  type SourceMirrorFetchOutcome,
  type SourceMirrorFetchRequest,
} from '../source-mirror/fetch.js';
import {
  runWorkEntitySourceSync,
  type RunSourceMirrorFetchFn,
} from '../work-entity-source-sync.js';

const NOW = 1_700_000_000_000;
const CONNECTION = 'edge-acme';
const TASK_SOURCE = 'salesforce.edge-acme.task';
const PROJECT_SOURCE = 'salesforce.edge-acme.project';

let db: Database.Database;
let store: WorkEntityStore;
let mirror: WorkEntitySourceMirrorStore;
let syncState: WorkEntitySourceSyncStateStore;
let edges: WorkEntityEdgeStore;
let contacts: ContactStore;
let connectionStore: ConnectionStoreSqlite;
let nowMs: number;
let nextId: number;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  ensureWorkEntitySchema(db);
  ensureWorkEntitySourceSyncStateSchema(db);
  ensureWorkEntityEdgeSchema(db);
  nextId = 0;
  store = createWorkEntityStore(db, { newId: () => `local-row-${++nextId}` });
  mirror = createWorkEntitySourceMirrorStore(db, store);
  syncState = createWorkEntitySourceSyncStateStore(db);
  edges = createWorkEntityEdgeStore(db);
  contacts = createContactStore(db);
  connectionStore = createConnectionStore(db);
  nowMs = NOW;
});

const requireContactId = (record: ContactRecord): string => {
  if (record.contact_id === undefined) throw new Error(`contact_id missing for ${record.email}`);
  return record.contact_id;
};

const edgeRowsForSource = (source_id: string): number => {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM ${WORK_ENTITY_EDGE_TABLE} WHERE source_id = ?`)
    .get(source_id) as { n: number };
  return row.n;
};

const oneEdge = <T>(items: readonly T[]): T => {
  expect(items).toHaveLength(1);
  return items[0]!;
};

const registerSource = (
  source_id: string,
  top_tier_kind: 'task' | 'project',
): void => {
  if (store.getSource(source_id) !== null) return;
  store.registerSource({
    id: source_id,
    top_tier_kind,
    source_kind: 'connection',
    source_label: source_id,
    write_capable: false,
    registered_at: NOW,
  });
};

const registerBuiltins = (): void => {
  for (const kind of WORK_ENTITY_KINDS) {
    if (store.getSource(RECUED_BUILTIN_SOURCE_ID(kind)) !== null) continue;
    store.registerSource({
      id: RECUED_BUILTIN_SOURCE_ID(kind),
      top_tier_kind: kind,
      source_kind: 'builtin',
      source_label: 'Recued built-in',
      write_capable: true,
      registered_at: NOW,
    });
  }
};

const seedSyncState = (
  source_id: string,
  declaration: KernelWorkEntitySourceDeclaration,
): void => {
  syncState.upsert({
    source_id,
    contract_hash: workEntitySourceContractHash(declaration),
    sync_depth: declaration.sync.depth,
    sync_mode: declaration.sync.mode,
    field_health_blob: null,
    cursor_blob: null,
    last_sync_started_at: null,
    last_sync_completed_at: null,
    last_success_at: null,
    last_error_code: null,
    last_error_message: null,
    degraded: false,
    list_complete: true,
    stale_after_ms: declaration.sync.stale_after_ms!,
  });
};

const prepareSource = (
  source_id: string,
  declaration: KernelWorkEntitySourceDeclaration,
): void => {
  registerSource(source_id, declaration.kind === 'project' ? 'project' : 'task');
  seedSyncState(source_id, declaration);
};

const taskDeclaration = (
  overrides: Partial<KernelWorkEntitySourceDeclaration> = {},
): KernelWorkEntitySourceDeclaration => ({
  kind: 'task',
  source_id_template: 'salesforce.${connection_id}.task',
  source_label_template: 'Salesforce tasks (${connection_name})',
  source_kind: 'connection',
  remote: {
    entity: 'Task',
    id: 'Id',
    version: { kind: 'updated_at', field: 'LastModifiedDate' },
    hash_fields: ['Subject', 'Status', 'Priority', 'ActivityDate', 'Description'],
  },
  ops: { list: 'task.list' },
  sync: {
    mode: 'read_write',
    depth: 'meta',
    tombstones: 'native',
    tombstone_field: 'Archived',
    stale_after_ms: 21_600_000,
  },
  read_resolution: {
    default: 'local_rich_meta',
    remote_when: ['field_missing', 'source_stale'],
    wild_query: {
      remote_fanout: 'bounded_targeted',
      max_sources: 3,
      max_remote_records: 10,
      on_exceeds_cap: 'ask_to_narrow',
    },
  },
  projection: {
    canonical: { title: 'Subject', done: 'Done' },
    extension: { vendor_status: 'Status' },
  },
  writable_fields: ['title'],
  write_policy: {
    conditional_write: 'none',
    stale_write: 'manual_merge',
    field_conflicts: 'manual_merge',
  },
  ...overrides,
});

const projectDeclaration = (): KernelWorkEntitySourceDeclaration => ({
  kind: 'project',
  source_id_template: 'salesforce.${connection_id}.project',
  source_label_template: 'Salesforce projects (${connection_name})',
  source_kind: 'connection',
  remote: {
    entity: 'Project',
    id: 'ProjectId',
    version: { kind: 'updated_at', field: 'ProjectModifiedAt' },
    hash_fields: ['ProjectName', 'ProjectState', 'ProjectModifiedAt'],
  },
  ops: { list: 'project.list' },
  sync: {
    mode: 'read_only',
    depth: 'meta',
    tombstones: 'none',
    stale_after_ms: 21_600_000,
  },
  read_resolution: {
    default: 'local_rich_meta',
    remote_when: ['field_missing', 'source_stale'],
    wild_query: {
      remote_fanout: 'bounded_targeted',
      max_sources: 3,
      max_remote_records: 10,
      on_exceeds_cap: 'ask_to_narrow',
    },
  },
  projection: {
    canonical: { title: 'ProjectName', state: 'ProjectState' },
  },
});

const manifestFake = {
  slug: 'cat',
  operations: { 'task.list': { result_path: 'records' } },
  surfaces: { api: { result_path: 'records' } },
} as unknown as IngredientManifest;

const profile: ConnectionOperationProfile = {
  allowed_operations: ['task.list'],
  catalog_slug: 'cat',
};

const fetchDeps = (): SourceMirrorFetchDeps => ({
  executorConfig: {
    manifests: {
      get: (slug: string) => (slug === 'cat' ? manifestFake : null),
    },
  },
  profiles: {
    get: () => profile,
  },
} as unknown as SourceMirrorFetchDeps);

const okFetch = (
  records: ReadonlyArray<Record<string, unknown>>,
  options: { complete?: boolean; skipped_no_id?: number } = {},
): SourceMirrorFetchOutcome => {
  const keyed: Array<[string, Record<string, unknown>]> = [];
  for (const record of records) {
    const id = record.Id;
    if (typeof id !== 'string') throw new Error('test record requires a string Id');
    keyed.push([id, record]);
  }
  return {
    ok: true,
    records: new Map(keyed),
    truncated: false,
    complete: options.complete ?? true,
    skipped_no_id: options.skipped_no_id ?? 0,
  };
};

const errorFetch = (reason: string): SourceMirrorFetchOutcome => ({
  ok: false,
  kind: 'error',
  reason,
});

const scriptedFetch = (
  ...outcomes: SourceMirrorFetchOutcome[]
): { runFetch: RunSourceMirrorFetchFn; requests: SourceMirrorFetchRequest[] } => {
  const queue = [...outcomes];
  const requests: SourceMirrorFetchRequest[] = [];
  const runFetch: RunSourceMirrorFetchFn = async (_deps, request) => {
    requests.push(request);
    return queue.shift() ?? errorFetch('no scripted fetch outcome');
  };
  return { runFetch, requests };
};

const rawTask = (
  id: string,
  title: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  Id: id,
  Subject: title,
  Done: false,
  Status: 'Open',
  LastModifiedDate: '2026-07-01T00:00:00.000Z',
  ...extra,
});

const runSync = async (
  declaration: KernelWorkEntitySourceDeclaration,
  script: { runFetch: RunSourceMirrorFetchFn },
  options: {
    source_id?: string;
    vendor?: string | null;
    edgeStore?: WorkEntityEdgeStore;
  } = {},
) => runWorkEntitySourceSync({
  fetchDeps: fetchDeps(),
  mirror,
  syncState,
  edges: options.edgeStore ?? edges,
  now: () => nowMs,
  runFetch: script.runFetch,
}, {
  source_id: options.source_id ?? TASK_SOURCE,
  connection_name: CONNECTION,
  declaration,
  vendor: options.vendor ?? 'salesforce',
});

const expectSyncOk = (
  result: Awaited<ReturnType<typeof runWorkEntitySourceSync>>,
): Extract<Awaited<ReturnType<typeof runWorkEntitySourceSync>>, { ok: true }> => {
  if (!result.ok) throw new Error(`expected sync success, got ${result.kind}: ${result.reason}`);
  return result;
};

const taskByRemoteId = (remoteId: string): Task => {
  const row = mirror.getBySourceIdentity('task', TASK_SOURCE, remoteId);
  if (row === null || !('done' in row)) throw new Error(`task ${remoteId} missing`);
  return row;
};

describe('D-192 P5 work entity edge store', () => {
  it('reconciles row-scoped edges, preserves resolution, tombstones drops, and deletes by Source', () => {
    const contactA = {
      local_field: 'assigned_contact_id',
      target_kind: 'contact',
      target_scoped_key: workEntityContactEdgeKey('contact-local-aaa'),
      target_local_id: 'contact-local-aaa',
    } satisfies WorkEntityEdgeWrite;
    const projectA = {
      local_field: 'parent_project_id',
      target_kind: 'project',
      target_scoped_key: workEntityWorkEdgeKey('project', 'vendor.edge.project', 'project-remote-aaa'),
      target_source_id: 'vendor.edge.project',
      target_remote_entity: 'Project',
      target_remote_id: 'project-remote-aaa',
      target_local_id: 'project-local-aaa',
    } satisfies WorkEntityEdgeWrite;

    expect(edges.reconcileRecordEdges({
      source_id: 'vendor.edge.task',
      source_record_id: 'task-remote-owner-aaa',
      owner_kind: 'task',
      owner_local_id: 'task-local-owner-aaa',
      desired: [contactA, projectA],
    }, NOW)).toEqual({ upserted: 2, tombstoned: 0 });
    expect(edges.listByOwner('task', 'task-local-owner-aaa').map((e) => e.target_scoped_key))
      .toEqual([workEntityContactEdgeKey('contact-local-aaa'), projectA.target_scoped_key]);

    expect(edges.reconcileRecordEdges({
      source_id: 'vendor.edge.task',
      source_record_id: 'task-remote-owner-aaa',
      owner_kind: 'task',
      owner_local_id: 'task-local-owner-aaa',
      desired: [projectA],
    }, NOW + 10)).toEqual({ upserted: 1, tombstoned: 1 });
    expect(edges.listByOwner('task', 'task-local-owner-aaa')).toHaveLength(1);

    expect(edges.reconcileRecordEdges({
      source_id: 'vendor.edge.task',
      source_record_id: 'task-remote-owner-aaa',
      owner_kind: 'task',
      owner_local_id: 'task-local-owner-aaa',
      desired: [contactA, projectA],
    }, NOW + 20)).toEqual({ upserted: 2, tombstoned: 0 });
    const revived = edges.listByOwner('task', 'task-local-owner-aaa')
      .find((edge) => edge.target_scoped_key === contactA.target_scoped_key);
    expect(revived?.created_at).toBe(NOW);
    expect(revived?.deleted_at).toBeUndefined();

    const projectUnresolved = {
      local_field: projectA.local_field,
      target_kind: projectA.target_kind,
      target_scoped_key: projectA.target_scoped_key,
      target_source_id: projectA.target_source_id,
      target_remote_entity: projectA.target_remote_entity,
      target_remote_id: projectA.target_remote_id,
    } satisfies WorkEntityEdgeWrite;
    edges.reconcileRecordEdges({
      source_id: 'vendor.edge.task',
      source_record_id: 'task-remote-owner-aaa',
      owner_kind: 'task',
      owner_local_id: 'task-local-owner-aaa',
      desired: [contactA, projectUnresolved],
    }, NOW + 30);
    const stillResolved = edges.listByOwner('task', 'task-local-owner-aaa')
      .find((edge) => edge.target_scoped_key === projectA.target_scoped_key);
    expect(stillResolved?.target_local_id).toBe('project-local-aaa');

    const retryable = {
      local_field: 'blocks_task_ids',
      target_kind: 'task',
      target_scoped_key: workEntityWorkEdgeKey('task', 'vendor.edge.task', 'blocked-task-remote'),
      target_source_id: 'vendor.edge.task',
      target_remote_entity: 'Task',
      target_remote_id: 'blocked-task-remote',
    } satisfies WorkEntityEdgeWrite;
    const scopedOnly = {
      local_field: 'parent_calendar_event_id',
      target_kind: 'calendar.event',
      target_scoped_key: workEntityRefEdgeKey('calendar.event', 'Event', 'calendar-event-remote'),
      target_remote_entity: 'Event',
      target_remote_id: 'calendar-event-remote',
    } satisfies WorkEntityEdgeWrite;
    edges.reconcileRecordEdges({
      source_id: 'vendor.edge.task',
      source_record_id: 'task-remote-owner-bbb',
      owner_kind: 'task',
      owner_local_id: 'task-local-owner-bbb',
      desired: [retryable, scopedOnly],
    }, NOW + 40);
    const unresolved = edges.listUnresolved('vendor.edge.task', 10);
    expect(unresolved.map((edge) => edge.target_scoped_key)).toEqual([retryable.target_scoped_key]);
    const key = oneEdge(unresolved);
    expect(edges.markResolved(key, 'blocked-task-local', NOW + 50)).toBe(true);
    expect(edges.markResolved(key, 'blocked-task-local-second', NOW + 60)).toBe(false);
    expect(oneEdge(edges.listByTarget('task', 'blocked-task-local')).target_scoped_key)
      .toBe(retryable.target_scoped_key);
    expect(edges.listByTarget('task', 'blocked-task-local-second')).toHaveLength(0);

    expect(edges.tombstoneForRecord('vendor.edge.task', 'task-remote-owner-bbb', NOW + 70)).toBe(2);
    expect(edges.listByOwner('task', 'task-local-owner-bbb')).toHaveLength(0);

    edges.reconcileRecordEdges({
      source_id: 'vendor.edge.other-task',
      source_record_id: 'other-task-remote',
      owner_kind: 'task',
      owner_local_id: 'task-local-owner-other',
      desired: [contactA],
    }, NOW + 80);
    expect(edges.deleteForSource('vendor.edge.task')).toBe(4);
    expect(edgeRowsForSource('vendor.edge.task')).toBe(0);
    expect(edges.listByOwner('task', 'task-local-owner-other')).toHaveLength(1);
  });
});

describe('D-192 P5 relationship resolution rules', () => {
  it('resolves contact references through platform links and merge redirects without email/raw-id keys', () => {
    const platformContact = contacts.upsertManual({
      email: 'platform-person@example.test',
      name: 'Platform Person',
    }, NOW, { silent: true });
    const platformContactId = requireContactId(platformContact);
    const platformId = 'sf-platform-contact-003-distinct';
    contacts.linkPlatformId({
      canonical_email: platformContact.email,
      vendor: 'salesforce',
      platform_id: platformId,
      state: 'confirmed',
      linked_at: NOW + 1,
      linked_by: 'test:platform-link',
    }, NOW + 1);
    const remoteRel = {
      local_field: 'assigned_contact_id',
      remote_field: 'WhoId',
      target: 'contact',
      remote_entity: 'Contact',
      pairing: 'remote_id',
      cardinality: 'one',
      write_back: false,
    } satisfies WorkEntitySourceRelationship;

    const remoteEdges = desiredWorkEntityEdgesForRow({
      declaration: taskDeclaration({ relationships: [remoteRel] }),
      source_id: TASK_SOURCE,
      connection_name: CONNECTION,
      vendor: 'salesforce',
      raw: rawTask('task-contact-platform', 'Contact platform', { WhoId: platformId }),
    }, { contacts });

    const remoteEdge = oneEdge(remoteEdges);
    expect(remoteEdge.target_kind).toBe('contact');
    expect(remoteEdge.target_scoped_key).toBe(workEntityContactEdgeKey(platformContactId));
    expect(remoteEdge.target_local_id).toBe(platformContactId);
    expect(remoteEdge.target_local_id).not.toBe(platformContact.email);
    expect(remoteEdge.target_local_id).not.toBe(platformId);
    expect(remoteEdge.target_scoped_key).not.toContain(platformContact.email);
    expect(remoteEdge.target_scoped_key).not.toContain(platformId);

    const loser = contacts.upsertManual({
      email: 'loser-contact-edge@example.test',
      name: 'Loser Contact Edge',
    }, NOW + 2, { silent: true });
    const survivor = contacts.upsertManual({
      email: 'survivor-contact-edge@example.test',
      name: 'Survivor Contact Edge',
    }, NOW + 3, { silent: true });
    const loserId = requireContactId(loser);
    const survivorId = requireContactId(survivor);
    contacts.setMergedInto([loser], survivor.email, NOW + 4);
    const emailRel = {
      local_field: 'assigned_contact_id',
      remote_field: 'AssigneeEmail',
      target: 'contact',
      pairing: 'lookup',
      lookup_key: 'email',
      cardinality: 'one',
      write_back: false,
    } satisfies WorkEntitySourceRelationship;

    const emailEdge = oneEdge(desiredWorkEntityEdgesForRow({
      declaration: taskDeclaration({ relationships: [emailRel] }),
      source_id: TASK_SOURCE,
      connection_name: CONNECTION,
      vendor: 'salesforce',
      raw: rawTask('task-contact-email', 'Contact email', { AssigneeEmail: loser.email }),
    }, { contacts }));
    expect(emailEdge.target_local_id).toBe(survivorId);
    expect(emailEdge.target_scoped_key).toBe(workEntityContactEdgeKey(survivorId));
    expect(emailEdge.target_local_id).not.toBe(loserId);

    expect(desiredWorkEntityEdgesForRow({
      declaration: taskDeclaration({ relationships: [remoteRel] }),
      source_id: TASK_SOURCE,
      connection_name: CONNECTION,
      vendor: 'salesforce',
      raw: rawTask('task-contact-missing', 'Missing contact', { WhoId: 'sf-platform-contact-unknown' }),
    }, { contacts })).toEqual([]);
  });

  it('composes CRM ids, persists scoped unresolved refs, and late-resolves sibling work rows', () => {
    const dealRemoteId = '006DEALREMOTE77';
    const dealRel = {
      local_field: 'parent_project_id',
      remote_field: 'OpportunityId',
      target: 'crm.deal',
      remote_entity: 'Opportunity',
      pairing: 'remote_id',
      cardinality: 'one',
      write_back: false,
    } satisfies WorkEntitySourceRelationship;
    const dealEdge = oneEdge(desiredWorkEntityEdgesForRow({
      declaration: taskDeclaration({ relationships: [dealRel] }),
      source_id: TASK_SOURCE,
      connection_name: CONNECTION,
      vendor: 'salesforce',
      raw: rawTask('task-crm-deal', 'Deal edge', { OpportunityId: dealRemoteId }),
    }, {}));
    expect(dealEdge.target_kind).toBe('crm.deal');
    expect(dealEdge.target_scoped_key).toBe(
      workEntityCrmEdgeKey('salesforce', 'opportunity', dealRemoteId),
    );
    expect(dealEdge.target_local_id).toBe(
      composePlatformRecordTargetId('salesforce', 'opportunity', CONNECTION, dealRemoteId),
    );

    const projectRemoteId = 'project-remote-target-42';
    const projectRel = {
      local_field: 'parent_project_id',
      remote_field: 'ProjectRef',
      target: 'project',
      remote_entity: 'Project',
      pairing: 'remote_id',
      cardinality: 'one',
      write_back: false,
    } satisfies WorkEntitySourceRelationship;
    const unresolvedProjectEdge = oneEdge(desiredWorkEntityEdgesForRow({
      declaration: taskDeclaration({ relationships: [projectRel] }),
      source_id: TASK_SOURCE,
      connection_name: CONNECTION,
      vendor: 'salesforce',
      raw: rawTask('task-project-unresolved', 'Project unresolved', {
        ProjectRef: projectRemoteId,
      }),
    }, { mirror }));
    expect(unresolvedProjectEdge.target_source_id).toBe(PROJECT_SOURCE);
    expect(unresolvedProjectEdge.target_scoped_key).toBe(
      workEntityWorkEdgeKey('project', PROJECT_SOURCE, projectRemoteId),
    );
    expect(unresolvedProjectEdge.target_local_id).toBeUndefined();

    edges.reconcileRecordEdges({
      source_id: TASK_SOURCE,
      source_record_id: 'task-project-unresolved',
      owner_kind: 'task',
      owner_local_id: 'task-local-project-owner',
      desired: [unresolvedProjectEdge],
    }, NOW + 10);
    expect(edges.listUnresolved(TASK_SOURCE, 10)).toHaveLength(1);

    registerSource(PROJECT_SOURCE, 'project');
    mirror.upsertBySourceIdentity({
      kind: 'project',
      write: {
        source_id: PROJECT_SOURCE,
        source_record_id: projectRemoteId,
        connection_id: CONNECTION,
        title: 'Sibling Project',
        state: 'active',
        source_record_hash: 'fnv1a:project-target',
      },
    }, NOW + 20);
    const targetProject = mirror.getBySourceIdentity('project', PROJECT_SOURCE, projectRemoteId);
    if (targetProject === null) throw new Error('target project did not land');
    expect(reResolveWorkEntityEdges(edges, { mirror }, TASK_SOURCE, () => NOW + 30)).toBe(1);
    expect(oneEdge(edges.listByOwner('task', 'task-local-project-owner')).target_local_id)
      .toBe(targetProject.id);

    const calendarRel = {
      local_field: 'parent_calendar_event_id',
      remote_field: 'CalendarEventId',
      target: 'calendar.event',
      remote_entity: 'Event',
      pairing: 'remote_id',
      cardinality: 'one',
      write_back: false,
    } satisfies WorkEntitySourceRelationship;
    const calendarRemoteId = 'calendar-event-distinct-900';
    const calendarEdge = oneEdge(desiredWorkEntityEdgesForRow({
      declaration: taskDeclaration({ relationships: [calendarRel] }),
      source_id: TASK_SOURCE,
      connection_name: CONNECTION,
      vendor: 'salesforce',
      raw: rawTask('task-calendar-ref', 'Calendar ref', {
        CalendarEventId: calendarRemoteId,
      }),
    }, {}));
    expect(calendarEdge.target_scoped_key).toBe(
      workEntityRefEdgeKey('calendar.event', 'Event', calendarRemoteId),
    );
    expect(calendarEdge.target_local_id).toBeUndefined();
    expect(calendarEdge.target_source_id).toBeUndefined();
    expect(calendarEdge.target_remote_id).toBe(calendarRemoteId);
  });
});

describe('D-192 P5 sync-runner edge integration', () => {
  const calendarRel = {
    local_field: 'parent_calendar_event_id',
    remote_field: 'CalendarEventId',
    target: 'calendar.event',
    remote_entity: 'Event',
    pairing: 'remote_id',
    cardinality: 'one',
    write_back: false,
  } satisfies WorkEntitySourceRelationship;

  const syncDeclaration = (): KernelWorkEntitySourceDeclaration =>
    taskDeclaration({ relationships: [calendarRel] });

  it('folds edges once and hash-skips unchanged rows on a healthy prior cycle', async () => {
    const declaration = syncDeclaration();
    prepareSource(TASK_SOURCE, declaration);
    let reconcileCalls = 0;
    const countingEdges: WorkEntityEdgeStore = {
      ...edges,
      reconcileRecordEdges(input, now) {
        reconcileCalls += 1;
        return edges.reconcileRecordEdges(input, now);
      },
    };

    nowMs = NOW + 10;
    const first = expectSyncOk(await runSync(
      declaration,
      scriptedFetch(okFetch([
        rawTask('sync-fold-1', 'Fold edge', { CalendarEventId: 'cal-sync-fold-1' }),
      ])),
      { edgeStore: countingEdges },
    ));
    expect(first.upserted).toBe(1);
    expect(reconcileCalls).toBe(1);
    const row = taskByRemoteId('sync-fold-1');
    expect(oneEdge(edges.listByOwner('task', row.id)).target_remote_id).toBe('cal-sync-fold-1');

    nowMs = NOW + 20;
    const second = expectSyncOk(await runSync(
      declaration,
      scriptedFetch(okFetch([
        rawTask('sync-fold-1', 'Fold edge', { CalendarEventId: 'cal-sync-fold-1' }),
      ])),
      { edgeStore: countingEdges },
    ));
    expect(second.unchanged).toBe(1);
    expect(reconcileCalls).toBe(1);
    expect(syncState.get(TASK_SOURCE)?.degraded).toBe(false);
  });

  it('reconciles PENDING dirty rows from raw vendor relationships without overwriting local values', async () => {
    const declaration = syncDeclaration();
    prepareSource(TASK_SOURCE, declaration);
    nowMs = NOW + 10;
    expectSyncOk(await runSync(
      declaration,
      scriptedFetch(okFetch([
        rawTask('sync-dirty-1', 'Remote before dirty', { CalendarEventId: 'cal-before-dirty' }),
      ])),
    ));
    const row = taskByRemoteId('sync-dirty-1');
    const pending: WorkEntityPendingWrite = {
      staged_at: NOW + 11,
      operation: 'update',
      dirty_fields: ['title'],
      state: 'pending',
      base_source_record_hash: row.source_record_hash ?? null,
    };
    expect(store.stagePendingWrite('task', row.id, pending)).toBe(true);

    nowMs = NOW + 20;
    const dirty = expectSyncOk(await runSync(
      declaration,
      scriptedFetch(okFetch([
        rawTask('sync-dirty-1', 'Remote while dirty', { CalendarEventId: 'cal-after-dirty' }),
      ])),
    ));
    expect(dirty.skipped_dirty).toBe(1);
    expect(taskByRemoteId('sync-dirty-1').title).toBe('Remote before dirty');
    const edge = oneEdge(edges.listByOwner('task', row.id));
    expect(edge.target_remote_id).toBe('cal-after-dirty');
    expect(edge.target_scoped_key).toBe(
      workEntityRefEdgeKey('calendar.event', 'Event', 'cal-after-dirty'),
    );
  });

  it('degrades on edge failure while landing the row, then repairs unchanged rows after the store heals', async () => {
    const declaration = syncDeclaration();
    prepareSource(TASK_SOURCE, declaration);
    let throwOnce = true;
    let reconcileCalls = 0;
    const flakyEdges: WorkEntityEdgeStore = {
      ...edges,
      reconcileRecordEdges(input, now) {
        reconcileCalls += 1;
        if (throwOnce) {
          throwOnce = false;
          throw new Error('edge store unavailable once');
        }
        return edges.reconcileRecordEdges(input, now);
      },
    };

    nowMs = NOW + 10;
    const degraded = expectSyncOk(await runSync(
      declaration,
      scriptedFetch(okFetch([
        rawTask('sync-repair-1', 'Repair edge', { CalendarEventId: 'cal-repair-target' }),
      ])),
      { edgeStore: flakyEdges },
    ));
    expect(degraded.upserted).toBe(1);
    expect(degraded.edge_failures).toBe(1);
    const landed = taskByRemoteId('sync-repair-1');
    expect(edges.listByOwner('task', landed.id)).toHaveLength(0);
    expect(syncState.get(TASK_SOURCE)).toMatchObject({
      degraded: true,
      last_error_code: 'edges_failed',
    });

    nowMs = NOW + 20;
    const repaired = expectSyncOk(await runSync(
      declaration,
      scriptedFetch(okFetch([
        rawTask('sync-repair-1', 'Repair edge', { CalendarEventId: 'cal-repair-target' }),
      ])),
      { edgeStore: flakyEdges },
    ));
    expect(repaired.unchanged).toBe(1);
    expect(repaired.edge_failures).toBe(0);
    expect(reconcileCalls).toBe(2);
    expect(oneEdge(edges.listByOwner('task', landed.id)).target_remote_id)
      .toBe('cal-repair-target');
    expect(syncState.get(TASK_SOURCE)?.degraded).toBe(false);
  });

  it('cascades native tombstones into tombstoneForRecord', async () => {
    const declaration = syncDeclaration();
    prepareSource(TASK_SOURCE, declaration);
    nowMs = NOW + 10;
    expectSyncOk(await runSync(
      declaration,
      scriptedFetch(okFetch([
        rawTask('sync-tombstone-1', 'Tombstone edge', { CalendarEventId: 'cal-before-tombstone' }),
      ])),
    ));
    const row = taskByRemoteId('sync-tombstone-1');
    expect(edges.listByOwner('task', row.id)).toHaveLength(1);

    nowMs = NOW + 20;
    const tombstoned = expectSyncOk(await runSync(
      declaration,
      scriptedFetch(okFetch([{ Id: 'sync-tombstone-1', Archived: true }])),
    ));
    expect(tombstoned.tombstoned).toBe(1);
    expect(store.readTask(row.id)?.deleted_at).toBe(NOW + 20);
    expect(edges.listByOwner('task', row.id)).toHaveLength(0);
  });
});

describe('D-192 P5 CRUD read decoration and contact forwarding', () => {
  it('work_entity.get decorates relationship_edges and forward-resolves loser contact ids for display', async () => {
    registerBuiltins();
    const resolver = createWorkEntityResolver(store);
    const dispatchers = createWorkEntityDispatchers({
      store,
      resolver,
      bus: createWarehouseEventBus(),
      now: () => NOW,
    });
    const deps: WorkEntityCrudRpcDeps = {
      store,
      resolver,
      dispatchers,
      edges,
      contactDisplay: contacts,
    };

    const created = await handleWorkEntityUpsert(deps, {
      kind: 'task',
      title: 'Decorated relationship edge',
    });
    const loser = contacts.upsertManual({
      email: 'crud-loser-contact@example.test',
      name: 'Crud Loser Contact',
    }, NOW + 1, { silent: true });
    const survivor = contacts.upsertManual({
      email: 'crud-survivor-contact@example.test',
      name: 'Crud Survivor Name',
    }, NOW + 2, { silent: true });
    const loserId = requireContactId(loser);
    const survivorId = requireContactId(survivor);
    contacts.setMergedInto([loser], survivor.email, NOW + 3);
    edges.reconcileRecordEdges({
      source_id: 'crm.decorated.task',
      source_record_id: 'crm-decorated-task-remote',
      owner_kind: 'task',
      owner_local_id: created.entity.id,
      desired: [{
        local_field: 'assigned_contact_id',
        target_kind: 'contact',
        target_scoped_key: workEntityContactEdgeKey(loserId),
        target_local_id: loserId,
      }],
    }, NOW + 4);

    const got = await handleWorkEntityGet(deps, {
      kind: 'task',
      id: created.entity.id,
    });
    if (got.entity === null) throw new Error('created task was not readable');
    const view = oneEdge(got.relationship_edges ?? []);
    expect(view).toMatchObject({
      local_field: 'assigned_contact_id',
      target_kind: 'contact',
      resolved: true,
      target_local_id: survivorId,
      target_display: 'Crud Survivor Name',
    });
    expect(oneEdge(edges.listByOwner('task', created.entity.id)).target_local_id)
      .toBe(loserId);
  });
});

describe('D-192 P5 contact store contact_id forwarding', () => {
  it('getByContactIdResolved returns the survivor for a loser contact_id and null for unknown', () => {
    const loser = contacts.upsertManual({
      email: 'store-loser-contact@example.test',
      name: 'Store Loser Contact',
    }, NOW + 1, { silent: true });
    const survivor = contacts.upsertManual({
      email: 'store-survivor-contact@example.test',
      name: 'Store Survivor Contact',
    }, NOW + 2, { silent: true });
    const loserId = requireContactId(loser);
    const survivorId = requireContactId(survivor);
    contacts.setMergedInto([loser], survivor.email, NOW + 3);

    expect(contacts.getByContactIdResolved(loserId)?.contact_id).toBe(survivorId);
    expect(contacts.getByContactIdResolved('unknown-contact-id-distinct')).toBeNull();
  });
});

describe('D-192 P5 boot unregister cleanup', () => {
  it('hard-deletes work entity edges when a connection Source unregisters', () => {
    connectionStore.upsert({
      kind: 'api',
      name: CONNECTION,
      display_name: 'HubSpot Edge Acme',
      config_json: JSON.stringify({ vendor: 'hubspot' }),
      auth_ciphertext: 'ciphertext',
      enrolled_at: NOW,
      updated_at: NOW,
    });
    wireWorkEntitySourceBoot({
      connectionStore,
      store,
      syncState,
      edges,
      now: () => NOW,
    });
    const source = 'hubspot.edge-acme.task';
    expect(store.getSource(source)).not.toBeNull();
    edges.reconcileRecordEdges({
      source_id: source,
      source_record_id: 'boot-edge-owner-remote',
      owner_kind: 'task',
      owner_local_id: 'boot-edge-owner-local',
      desired: [{
        local_field: 'parent_calendar_event_id',
        target_kind: 'calendar.event',
        target_scoped_key: workEntityRefEdgeKey(
          'calendar.event',
          'Event',
          'boot-calendar-event-remote',
        ),
        target_remote_entity: 'Event',
        target_remote_id: 'boot-calendar-event-remote',
      }],
    }, NOW + 1);
    expect(edgeRowsForSource(source)).toBe(1);

    expect(connectionStore.delete('api', CONNECTION)).toBe(true);

    expect(store.getSource(source)).toBeNull();
    expect(edgeRowsForSource(source)).toBe(0);
  });
});

// D-192 unit-3 — a `crm.<alias>` edge on a PACK-declared CRM resolves its
// `(vendor, entity)` only against the LIVE merged registry. Built-in CRMs
// (salesforce/hubspot/pipedrive) are unaffected; a pack CRM's crm-edge stays
// a hint until `resolveVendorRegistry` supplies the live registry.
describe('D-192 unit-3 — pack CRM crm-edge resolves only with the live registry', () => {
  const dynamicsDeal: ConnectionVendorEntity = buildConnectionVendorEntity({
    vendor: 'dynamics',
    entity: 'opportunity',
    display_name: 'Dynamics Opportunity',
    crm_alias: 'deal',
    meta_fields: [{ key: 'name', type: 'string', description: 'placeholder' }],
  });
  const liveRegistry: ReadonlyArray<ConnectionVendorEntity> = [
    ...CONNECTION_VENDOR_ENTITIES,
    dynamicsDeal,
  ];
  const dealRel = {
    local_field: 'parent_project_id',
    remote_field: 'OpportunityId',
    target: 'crm.deal',
    remote_entity: 'Opportunity',
    pairing: 'remote_id',
    cardinality: 'one',
    write_back: false,
  } satisfies WorkEntitySourceRelationship;

  const packRow = (deps: Parameters<typeof desiredWorkEntityEdgesForRow>[1]) =>
    desiredWorkEntityEdgesForRow({
      declaration: taskDeclaration({ relationships: [dealRel] }),
      source_id: 'dynamics.edge-acme.task',
      connection_name: CONNECTION,
      vendor: 'dynamics',
      raw: rawTask('task-crm-deal-pack', 'Pack deal edge', { OpportunityId: 'DYN-OPP-77' }),
    }, deps);

  it('empty deps: the pack CRM crm.deal edge fails closed (stays a hint)', () => {
    // dynamics is absent from the frozen builtin → getVendorEntityByCrmAlias
    // returns null → no edge.
    expect(packRow({})).toEqual([]);
  });

  it('live registry: the pack CRM crm.deal edge resolves to the composed platform target', () => {
    const edge = oneEdge(packRow({ resolveVendorRegistry: () => liveRegistry }));
    expect(edge.target_kind).toBe('crm.deal');
    expect(edge.target_scoped_key).toBe(
      workEntityCrmEdgeKey('dynamics', 'opportunity', 'DYN-OPP-77'),
    );
    expect(edge.target_local_id).toBe(
      composePlatformRecordTargetId('dynamics', 'opportunity', CONNECTION, 'DYN-OPP-77'),
    );
    expect(edge.target_remote_entity).toBe('Opportunity');
    expect(edge.target_remote_id).toBe('DYN-OPP-77');
  });

  it('built-in CRM crm.deal still resolves with empty deps (byte-identical)', () => {
    const edge = oneEdge(desiredWorkEntityEdgesForRow({
      declaration: taskDeclaration({ relationships: [dealRel] }),
      source_id: TASK_SOURCE,
      connection_name: CONNECTION,
      vendor: 'salesforce',
      raw: rawTask('task-crm-deal-builtin', 'Builtin deal edge', { OpportunityId: 'SF-OPP-1' }),
    }, {}));
    expect(edge.target_kind).toBe('crm.deal');
    expect(edge.target_scoped_key).toBe(
      workEntityCrmEdgeKey('salesforce', 'opportunity', 'SF-OPP-1'),
    );
  });
});
