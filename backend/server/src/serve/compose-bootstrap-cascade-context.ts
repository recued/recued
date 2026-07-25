import type Database from 'better-sqlite3';
import type { AuditLogStore } from '@recued/storage';

import type { AuditRetention } from '../audit-retention.js';
import type { BootstrapHandlerDeps } from '../bootstrap-handler.js';
import type { CollectionRegistry } from '../collections/registry.js';
import {
  createEvictionCascade,
  DEFAULT_CASCADE_CONFIG,
  type CascadeConfig,
  type EvictionCascade,
} from '../eviction-cascade.js';
import type { PressureStateStore } from '../pressure-state.js';
import type { PressureHandlerDeps } from '../pressure-handler.js';
import type { BlobStore } from '../storage/index.js';
import { listReferencedBlobHashes } from '../storage/sqlite-cache-store.js';
import {
  listSharedReferencedBlobHashes,
  type SharedStore,
} from '../storage/shared-store.js';
import { listCollectionReferencedBlobHashes } from '../storage/collection-blob-refs.js';
import {
  listAnnotationReferencedBlobHashes,
  type AnnotationStore,
} from '../storage/annotation-store.js';
import type { GateRegistry } from '../storage-gates.js';
import type { BaseContext } from './compose-base-context.js';
import type { AppContext } from './compose-app-context.js';
import type { CollectionContext } from './compose-collection-context.js';
import type { StorageContext } from './compose-storage-context.js';

export interface ComposeBootstrapCascadeContextOptions {
  readonly base: Pick<BaseContext, 'loadedConfig' | 'runtimeConfig'>;
  readonly serverVersion: string;
  readonly storage: Pick<
    StorageContext,
    'db' | 'auditLog' | 'gateRegistry' | 'auditRetention' | 'pressureState'
  >;
  readonly app: Pick<
    AppContext,
    | 'serverState'
    | 'cacheStore'
    | 'cacheBlobs'
    | 'sharedStoreRef'
    | 'sharedBlobs'
    | 'annotationStoreRef'
  >;
  readonly collection: Pick<CollectionContext, 'collectionRegistry'>;
  readonly warn?: (message: string) => void;
}

export interface BootstrapCascadeContext {
  readonly cascade: EvictionCascade | undefined;
  readonly bootstrapDeps: BootstrapHandlerDeps | undefined;
  readonly pressureDeps: PressureHandlerDeps | undefined;
}

const resolveCascadeConfig = (
  runtimeConfig: BaseContext['runtimeConfig'],
): CascadeConfig => ({
  debounceWindowMs: (() => {
    try {
      const s = runtimeConfig.get('cascade.debounce_window_s') as number;
      return s * 1000;
    } catch {
      return DEFAULT_CASCADE_CONFIG.debounceWindowMs;
    }
  })(),
  orphanScanMaxBlobs: (() => {
    try {
      return runtimeConfig.get('cascade.orphan_scan_max_blobs') as number;
    } catch {
      return DEFAULT_CASCADE_CONFIG.orphanScanMaxBlobs;
    }
  })(),
  hysteresisRatio: DEFAULT_CASCADE_CONFIG.hysteresisRatio,
});

const composeCascade = (deps: {
  db: Database.Database | undefined;
  auditLog: AuditLogStore | undefined;
  gateRegistry: GateRegistry | undefined;
  pressureState: PressureStateStore | undefined;
  auditRetention: AuditRetention | undefined;
  cacheStore: AppContext['cacheStore'];
  cacheBlobs: BlobStore | undefined;
  sharedStore: SharedStore | undefined;
  sharedBlobs: BlobStore | undefined;
  annotationStore: AnnotationStore | undefined;
  collectionRegistry: CollectionRegistry;
  runtimeConfig: BaseContext['runtimeConfig'];
}): EvictionCascade | undefined => {
  const {
    db,
    auditLog,
    gateRegistry,
    pressureState,
    auditRetention,
    cacheStore,
    cacheBlobs,
    sharedStore,
    sharedBlobs,
    annotationStore,
    collectionRegistry,
    runtimeConfig,
  } = deps;

  if (!db || !auditLog || !gateRegistry || !pressureState) {
    return undefined;
  }

  return createEvictionCascade({
    registry: gateRegistry,
    state: pressureState,
    auditLog,
    cache: cacheStore,
    // Two posture-split CAS roots (blob-encryption Phase 1). The cache surface
    // sweeps the encrypted `cacheBlobs` root (cache ∪ collection keepset); the
    // shared_store surface sweeps the keyless `sharedBlobs` root (shared ∪
    // annotation keepset). Collections share the cache_blobs instance, so their
    // refs join the cache keepset; annotations share the blobs root, so theirs
    // join the shared keepset — omitting either would let a sweep reap a live
    // body. `listCollectionReferencedBlobHashes` returns ∅ when no collection
    // tables exist, so it is safe to wire whenever the cache root is present.
    cacheBlobs,
    sharedBlobs,
    cacheBlobRefs: cacheBlobs ? () => listReferencedBlobHashes(db) : undefined,
    collectionBlobRefs: cacheBlobs
      ? () => listCollectionReferencedBlobHashes(db)
      : undefined,
    sharedBlobRefs: sharedStore
      ? () => listSharedReferencedBlobHashes(db)
      : undefined,
    annotationBlobRefs: annotationStore
      ? () => listAnnotationReferencedBlobHashes(db)
      : undefined,
    auditRetention,
    collectionRegistry,
    config: () => resolveCascadeConfig(runtimeConfig),
    db,
  });
};

export const composeBootstrapCascadeContext = (
  options: ComposeBootstrapCascadeContextOptions,
): BootstrapCascadeContext => {
  const {
    base,
    serverVersion,
    storage,
    app,
    collection,
    warn = (message) => console.warn(message),
  } = options;

  const cascade = composeCascade({
    db: storage.db,
    auditLog: storage.auditLog,
    gateRegistry: storage.gateRegistry,
    pressureState: storage.pressureState,
    auditRetention: storage.auditRetention,
    cacheStore: app.cacheStore,
    cacheBlobs: app.cacheBlobs,
    sharedStore: app.sharedStoreRef,
    sharedBlobs: app.sharedBlobs,
    annotationStore: app.annotationStoreRef,
    collectionRegistry: collection.collectionRegistry,
    runtimeConfig: base.runtimeConfig,
  });

  const bootstrapDeps: BootstrapHandlerDeps | undefined = app.serverState
    ? {
        bootstrap: base.loadedConfig.bootstrap,
        state: app.serverState,
        gates: storage.gateRegistry?.all() ?? [],
        version: serverVersion,
        auditLog: storage.auditLog,
        pressureState: storage.pressureState,
        onRestartRequested: (reason) => {
          warn(`[bootstrap] restart requested${reason ? `: ${reason}` : ''}`);
        },
      }
    : undefined;

  const pressureDeps = cascade && storage.gateRegistry
    ? { registry: storage.gateRegistry, cascade }
    : undefined;

  return {
    cascade,
    bootstrapDeps,
    pressureDeps,
  };
};
