/** D-192 file SOURCE family — `wireFileSourceBoot` (Source-registry rows).
 *
 *  Coverage: the boot scan registers a `SourceRegistration` for existing S3 /
 *  Dropbox connections (`top_tier_kind: 'file'`, `sync_posture:
 *  'file_meta_ref'`, read-only); the upsert observer registers on enrollment;
 *  the delete observer unregisters; non-file vendors + non-api kinds are inert;
 *  a boot re-scan preserves a user's enable/disable toggle;
 *  the id matches `CONNECTION_SOURCE_ID(vendor, name, 'file')`
 *  (so it agrees with `wireFileSourceSync`); and — the reason the guard exists
 *  — a file Source and a work-entity (HubSpot) Source COEXIST in the shared
 *  registry without the two boot wires sweeping each other on upsert/delete. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONNECTION_SOURCE_ID } from '@recued/contracts';

import { createConnectionStore } from '../storage/connection-store.js';
import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import { wireFileSourceBoot } from '../file-source-boot.js';
import { wireWorkEntitySourceBoot } from '../work-entity-source-boot.js';

let dir: string;
let db: Database.Database;
let store: WorkEntityStore;

const NOW = 1_700_000_000_000;

const upsertConnection = (
  cs: ReturnType<typeof createConnectionStore>,
  name: string,
  vendor: string,
  kind: 'api' | 'mcp' = 'api',
): void => {
  cs.upsert({
    kind,
    name,
    display_name: `${vendor} ${name}`,
    config_json: JSON.stringify({ vendor }),
    auth_ciphertext: 'CIPHER',
    enrolled_at: NOW,
    updated_at: NOW,
  });
};

const s3Id = (name: string): string => CONNECTION_SOURCE_ID('s3', name, 'file');
const dropboxId = (name: string): string => CONNECTION_SOURCE_ID('dropbox', name, 'file');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd192-file-boot-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureWorkEntitySchema(db);
  store = createWorkEntityStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// Boot scan
// ────────────────────────────────────────────────────────────────

describe('wireFileSourceBoot — boot scan', () => {
  it('registers a file Source for every existing S3 connection', () => {
    const cs = createConnectionStore(db);
    upsertConnection(cs, 'photos', 's3');
    upsertConnection(cs, 'backups', 's3');
    wireFileSourceBoot({ connectionStore: cs, store, now: () => NOW });

    for (const name of ['photos', 'backups']) {
      const reg = store.getSource(s3Id(name));
      expect(reg).not.toBeNull();
      expect(reg!.top_tier_kind).toBe('file');
      expect(reg!.source_kind).toBe('connection');
      expect(reg!.sync_posture).toBe('file_meta_ref');
      // Read-only meta-only mirror in v1 — no write path flips this true.
      expect(reg!.write_capable).toBe(false);
      expect(reg!.registered_at).toBe(NOW);
    }
    expect(store.getSource(s3Id('photos'))!.source_label).toBe('Amazon S3 (photos)');
  });

  it('registers a file Source for an existing Dropbox connection', () => {
    const cs = createConnectionStore(db);
    upsertConnection(cs, 'personal', 'dropbox');
    wireFileSourceBoot({ connectionStore: cs, store, now: () => NOW });
    const reg = store.getSource(dropboxId('personal'));
    expect(reg).not.toBeNull();
    expect(reg!.source_label).toBe('Dropbox (personal)');
    expect(reg!.sync_posture).toBe('file_meta_ref');
  });

  it('uses the same id shape wireFileSourceSync mints — CONNECTION_SOURCE_ID(vendor, name, file)', () => {
    const cs = createConnectionStore(db);
    upsertConnection(cs, 'photos', 's3');
    wireFileSourceBoot({ connectionStore: cs, store, now: () => NOW });
    expect(store.getSource('s3.photos.file')).not.toBeNull();
  });

  it('skips non-file vendors (hubspot / custom api connection)', () => {
    const cs = createConnectionStore(db);
    upsertConnection(cs, 'acme', 'hubspot');
    upsertConnection(cs, 'custom', 'custom-vendor');
    wireFileSourceBoot({ connectionStore: cs, store, now: () => NOW });
    expect(store.listSources('file').filter((s) => s.source_kind === 'connection')).toHaveLength(0);
  });

  it('skips connections whose config_json is malformed', () => {
    const cs = createConnectionStore(db);
    cs.upsert({
      kind: 'api',
      name: 'bad',
      display_name: 'Bad',
      config_json: '{not-json}',
      auth_ciphertext: 'CIPHER',
      enrolled_at: NOW,
      updated_at: NOW,
    });
    expect(() => wireFileSourceBoot({ connectionStore: cs, store, now: () => NOW })).not.toThrow();
    expect(store.listSources('file').filter((s) => s.source_kind === 'connection')).toHaveLength(0);
  });

  it('default `now` falls back to Date.now', () => {
    const cs = createConnectionStore(db);
    upsertConnection(cs, 'photos', 's3');
    const before = Date.now();
    wireFileSourceBoot({ connectionStore: cs, store });
    const reg = store.getSource(s3Id('photos'))!;
    expect(reg.registered_at).toBeGreaterThanOrEqual(before);
    expect(reg.registered_at).toBeLessThanOrEqual(Date.now());
  });
});

// ────────────────────────────────────────────────────────────────
// Upsert / delete observers
// ────────────────────────────────────────────────────────────────

describe('wireFileSourceBoot — observers', () => {
  it('registers a file Source on new S3 enrollment', () => {
    const cs = createConnectionStore(db);
    wireFileSourceBoot({ connectionStore: cs, store, now: () => NOW });
    upsertConnection(cs, 'photos', 's3');
    expect(store.getSource(s3Id('photos'))).not.toBeNull();
  });

  it('idempotent on token refresh — no duplicate raise, registered_at preserved', () => {
    const cs = createConnectionStore(db);
    wireFileSourceBoot({ connectionStore: cs, store, now: () => NOW });
    upsertConnection(cs, 'photos', 's3');
    const first = store.getSource(s3Id('photos'))!;
    expect(() => upsertConnection(cs, 'photos', 's3')).not.toThrow();
    const second = store.getSource(s3Id('photos'))!;
    expect(second.registered_at).toBe(first.registered_at);
  });

  it('unregisters the file Source on connection delete', () => {
    const cs = createConnectionStore(db);
    wireFileSourceBoot({ connectionStore: cs, store, now: () => NOW });
    upsertConnection(cs, 'photos', 's3');
    expect(store.getSource(s3Id('photos'))).not.toBeNull();
    cs.delete('api', 'photos');
    expect(store.getSource(s3Id('photos'))).toBeNull();
  });

  it('non-api kind upsert is a no-op', () => {
    const cs = createConnectionStore(db);
    wireFileSourceBoot({ connectionStore: cs, store, now: () => NOW });
    upsertConnection(cs, 'a-server', 's3', 'mcp');
    expect(store.listSources('file').filter((s) => s.source_kind === 'connection')).toHaveLength(0);
  });

  it('non-api upsert does not unregister an existing api file Source for the same name', () => {
    const cs = createConnectionStore(db);
    wireFileSourceBoot({ connectionStore: cs, store, now: () => NOW });
    upsertConnection(cs, 'photos', 's3');
    expect(store.getSource(s3Id('photos'))).not.toBeNull();
    // A non-api row may coexist with the api row under the same name — the
    // observer must ignore it, not reconcile away the api row's Source.
    upsertConnection(cs, 'photos', 'dropbox', 'mcp');
    expect(store.getSource(s3Id('photos'))).not.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Vendor flip
// ────────────────────────────────────────────────────────────────

describe('wireFileSourceBoot — vendor flip', () => {
  it('s3 → dropbox flip unregisters the s3 Source, registers the dropbox Source', () => {
    const cs = createConnectionStore(db);
    wireFileSourceBoot({ connectionStore: cs, store, now: () => NOW });
    upsertConnection(cs, 'shared', 's3');
    expect(store.getSource(s3Id('shared'))).not.toBeNull();
    upsertConnection(cs, 'shared', 'dropbox');
    expect(store.getSource(s3Id('shared'))).toBeNull();
    expect(store.getSource(dropboxId('shared'))).not.toBeNull();
  });

  it('s3 → non-file vendor flip unregisters the s3 file Source', () => {
    const cs = createConnectionStore(db);
    wireFileSourceBoot({ connectionStore: cs, store, now: () => NOW });
    upsertConnection(cs, 'morph', 's3');
    expect(store.getSource(s3Id('morph'))).not.toBeNull();
    upsertConnection(cs, 'morph', 'hubspot');
    expect(store.getSource(s3Id('morph'))).toBeNull();
    expect(store.listSources('file').filter((s) => s.source_kind === 'connection')).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────
// a user toggle survives a boot re-scan
// ────────────────────────────────────────────────────────────────


// ────────────────────────────────────────────────────────────────
// Cross-family coexistence — the reason each reconcile is top_tier_kind-scoped
// ────────────────────────────────────────────────────────────────

describe('file + work-entity Sources coexist in the shared registry', () => {
  it('boot scan registers both a HubSpot task Source and an S3 file Source', () => {
    const cs = createConnectionStore(db);
    upsertConnection(cs, 'acme', 'hubspot');
    upsertConnection(cs, 'bucket', 's3');
    // Both boot wires share the one registry (compose order: work-entity then file).
    wireWorkEntitySourceBoot({ connectionStore: cs, store });
    wireFileSourceBoot({ connectionStore: cs, store, now: () => NOW });
    expect(store.getSource(CONNECTION_SOURCE_ID('hubspot', 'acme', 'task'))).not.toBeNull();
    expect(store.getSource(s3Id('bucket'))).not.toBeNull();
  });

  it('a HubSpot token-refresh upsert does NOT sweep the S3 file Source (file-guard)', () => {
    const cs = createConnectionStore(db);
    wireWorkEntitySourceBoot({ connectionStore: cs, store });
    wireFileSourceBoot({ connectionStore: cs, store, now: () => NOW });
    upsertConnection(cs, 'acme', 'hubspot');
    upsertConnection(cs, 'bucket', 's3');
    // Re-upsert BOTH (token refresh) — each family's observer sees the OTHER
    // family's Source with an empty desired set; the top_tier_kind guard is
    // what stops it from unregistering the other family's row.
    upsertConnection(cs, 'acme', 'hubspot');
    upsertConnection(cs, 'bucket', 's3');
    expect(store.getSource(CONNECTION_SOURCE_ID('hubspot', 'acme', 'task'))).not.toBeNull();
    expect(store.getSource(s3Id('bucket'))).not.toBeNull();
  });

  it('deleting the S3 connection leaves the HubSpot task Source intact', () => {
    const cs = createConnectionStore(db);
    wireWorkEntitySourceBoot({ connectionStore: cs, store });
    wireFileSourceBoot({ connectionStore: cs, store, now: () => NOW });
    upsertConnection(cs, 'acme', 'hubspot');
    upsertConnection(cs, 'bucket', 's3');
    cs.delete('api', 'bucket');
    expect(store.getSource(s3Id('bucket'))).toBeNull();
    expect(store.getSource(CONNECTION_SOURCE_ID('hubspot', 'acme', 'task'))).not.toBeNull();
  });
});
