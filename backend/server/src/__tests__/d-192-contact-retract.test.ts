/** D-192 source-data-removal slice 4 — messenger contact retract-contribution.
 *
 *  On removing a messenger connection (slack/telegram, `kind: 'notification'`)
 *  with the opt-in, retract THAT connection's D-138 `contact_platform_link`
 *  associations — connection-precisely (by the nullable `connection_name`
 *  discriminator the `(vendor, platform_id)` PK cannot express), re-materializing
 *  each affected contact's `platform_ids` JSON. The shared `contacts` row is
 *  NEVER deleted (a messenger link never owns one — every contact carries a
 *  first-party `source`), so there is no source-less contact-delete path.
 *
 *  Four levels:
 *    - the contact-store primitives (`retractPlatformLinksForConnection` /
 *      `countPlatformLinksForConnection`) — connection-precision, re-materialize,
 *      idempotence, NULL-connection immunity;
 *    - the `purgeConnectionData` messenger leg;
 *    - the `previewConnectionPurgeCount` messenger leg + the count==retract parity;
 *    - the `handleConnectionDelete` / `handleConnectionPreviewPurge` gate.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  handleConnectionDelete,
  handleConnectionPreviewPurge,
} from '../connection-handler.js';
import { createConnectionStore } from '../storage/connection-store.js';
import {
  createContactStore,
  type ContactStore,
} from '../storage/contact-store.js';
import {
  previewConnectionPurgeCount,
  purgeConnectionData,
  type PurgeConnectionDataDeps,
} from '../source-mirror/connection-purge.js';

const NOW = 1_700_000_000_000;

// ── contact-store retract / count primitives ────────────────────

describe('contact-store — retract/count platform links for a connection', () => {
  let dir: string;
  let db: Database.Database;
  let store: ContactStore;

  const link = (email: string, platform_id: string, connection_name?: string): void => {
    store.linkPlatformId({
      canonical_email: email,
      vendor: 'slack',
      platform_id,
      state: 'auto',
      linked_at: NOW,
      linked_by: 'messenger:slack',
      ...(connection_name !== undefined ? { connection_name } : {}),
    });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd192-contact-retract-'));
    db = new Database(join(dir, 'test.db'));
    db.pragma('journal_mode = WAL');
    store = createContactStore(db);
    // Two same-vendor slack connections + a NULL-connection (reconciler-style)
    // link that must survive any connection retract.
    link('u1@acme.test', 'U_A1', 'acme-slack');
    link('u2@acme.test', 'U_A2', 'acme-slack');
    link('u9@other.test', 'U_P9', 'personal-slack'); // sibling connection
    link('legacy@x.test', 'U_LEGACY'); // no connection_name (never matched)
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('retracts ONLY the named connection (acme-slack != personal-slack, NULL untouched)', () => {
    expect(store.countPlatformLinksForConnection('slack', 'acme-slack')).toBe(2);

    const r = store.retractPlatformLinksForConnection('slack', 'acme-slack');
    expect(r.links_removed).toBe(2);
    expect(r.contacts_affected).toBe(2);

    // acme-slack gone…
    expect(store.countPlatformLinksForConnection('slack', 'acme-slack')).toBe(0);
    expect(store.lookupPlatformLink('slack', 'U_A1')).toBeNull();
    // …sibling connection survives (the whole-vendor delete would kill it)…
    expect(store.countPlatformLinksForConnection('slack', 'personal-slack')).toBe(1);
    expect(store.lookupPlatformLink('slack', 'U_P9')).toBe('u9@other.test');
    // …and the NULL-connection (reconciler/merge) link is immune.
    expect(store.lookupPlatformLink('slack', 'U_LEGACY')).toBe('legacy@x.test');
  });

  it('count equals exactly what the retract removes (parity)', () => {
    const counted = store.countPlatformLinksForConnection('slack', 'acme-slack');
    const removed = store.retractPlatformLinksForConnection('slack', 'acme-slack').links_removed;
    expect(counted).toBe(removed);
  });

  it('is idempotent — a re-run removes nothing', () => {
    store.retractPlatformLinksForConnection('slack', 'acme-slack');
    const again = store.retractPlatformLinksForConnection('slack', 'acme-slack');
    expect(again).toEqual({ links_removed: 0, contacts_affected: 0 });
  });

  it('re-materializes the contact row and NEVER deletes it', () => {
    // A real contact seen by mail, later linked to two slack connections'
    // senders. Retracting one connection drops only its entry from platform_ids;
    // the contact (a first-party mail row) stays.
    store.upsertManual({ email: 'alice@acme.test', name: 'Alice' });
    link('alice@acme.test', 'U_ALICE_ACME', 'acme-slack');
    link('alice@acme.test', 'U_ALICE_PERSONAL', 'personal-slack');
    expect((store.get('alice@acme.test')?.platform_ids ?? []).map((e) => e.platform_id).sort()).toEqual([
      'U_ALICE_ACME',
      'U_ALICE_PERSONAL',
    ]);

    store.retractPlatformLinksForConnection('slack', 'acme-slack');

    const after = store.get('alice@acme.test');
    expect(after).not.toBeNull(); // the shared contact SURVIVES
    expect((after?.platform_ids ?? []).map((e) => e.platform_id)).toEqual(['U_ALICE_PERSONAL']);
  });

  it('a NULL-connection link is never matched by any connection name', () => {
    expect(store.countPlatformLinksForConnection('slack', 'legacy')).toBe(0);
    expect(store.retractPlatformLinksForConnection('slack', '').links_removed).toBe(0);
    expect(store.lookupPlatformLink('slack', 'U_LEGACY')).toBe('legacy@x.test');
  });
});

// ── connection_name migration (Finding 1 regression) ───────────

describe('contact-store — connection_name migration converges an old dev DB', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd192-contact-migrate-'));
    db = new Database(join(dir, 'old.db'));
    // Simulate a PRE-slice-4 dev DB: the old `contact_platform_link` shape
    // (no `connection_name`) with a row already in it.
    db.exec(`
      CREATE TABLE contact_platform_link (
        canonical_email TEXT NOT NULL, vendor TEXT NOT NULL, platform_id TEXT NOT NULL,
        state TEXT NOT NULL, linked_at INTEGER NOT NULL, linked_by TEXT NOT NULL,
        PRIMARY KEY (vendor, platform_id));
    `);
    db.prepare(
      `INSERT INTO contact_platform_link
         (canonical_email, vendor, platform_id, state, linked_at, linked_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('old@x.test', 'slack', 'U_OLD', 'auto', 1, 'messenger:slack');
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds connection_name + the index without crashing boot, old row stays NULL-immune', () => {
    // ensureContactSchema (inside createContactStore) must ALTER the existing
    // table BEFORE creating the (vendor, connection_name) index — else the index
    // references a missing column and throws (the fixed migration-order bug).
    const store = createContactStore(db); // must NOT throw
    const cols = (
      db.prepare(`PRAGMA table_info(contact_platform_link)`).all() as { name: string }[]
    ).map((r) => r.name);
    expect(cols).toContain('connection_name');
    // The pre-existing row survived (its connection_name is NULL) and is immune
    // to any connection retract.
    expect(store.lookupPlatformLink('slack', 'U_OLD')).toBe('old@x.test');
    expect(store.retractPlatformLinksForConnection('slack', 'anything').links_removed).toBe(0);
    // A fresh connection-stamped link then retracts cleanly on the migrated DB.
    store.linkPlatformId({
      canonical_email: 'new@x.test',
      vendor: 'slack',
      platform_id: 'U_NEW',
      state: 'auto',
      linked_at: NOW,
      linked_by: 'messenger:slack',
      connection_name: 'my-slack',
    });
    expect(store.countPlatformLinksForConnection('slack', 'my-slack')).toBe(1);
    expect(store.retractPlatformLinksForConnection('slack', 'my-slack').links_removed).toBe(1);
    expect(store.lookupPlatformLink('slack', 'U_OLD')).toBe('old@x.test'); // still immune
  });
});

// ── purgeConnectionData / previewConnectionPurgeCount messenger legs ──

describe('purge + preview — messenger contact-link leg', () => {
  let dir: string;
  let db: Database.Database;
  let store: ContactStore;

  const link = (email: string, platform_id: string, connection_name: string): void => {
    store.linkPlatformId({
      canonical_email: email,
      vendor: 'slack',
      platform_id,
      state: 'auto',
      linked_at: NOW,
      linked_by: 'messenger:slack',
      connection_name,
    });
  };

  // The full purge quorum — the non-messenger legs are inert stubs (no registry
  // Sources, no CRM mirror), so ONLY the contact leg runs.
  const purgeDeps = (): PurgeConnectionDataDeps => ({
    db,
    workEntityStore: {
      listSources: () => [],
      listRecordIdentitiesForSource: () => [],
      deleteRecordsForSource: () => 0,
    },
    fileMetaStore: { deleteAllForScope: () => 0 },
    annotationStore: { cascadeDelete: () => ({ annotations_deleted: 0, links_deleted: 0 }) },
    enrichmentStore: { deleteForSource: () => 0, deleteForScopeAndTargetPrefix: () => 0 },
    edges: { deleteForSource: () => 0 },
    contactStore: store,
  });
  const previewDeps = () => ({
    workEntityStore: { listSources: () => [], countRecordsForSource: () => 0 },
    fileMetaStore: { countForScope: () => 0 },
    contactStore: store,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd192-contact-purge-'));
    db = new Database(join(dir, 'test.db'));
    db.pragma('journal_mode = WAL');
    store = createContactStore(db);
    link('u1@acme.test', 'U_A1', 'acme-slack');
    link('u2@acme.test', 'U_A2', 'acme-slack');
    link('u9@other.test', 'U_P9', 'personal-slack'); // sibling
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('retracts the connection\'s links, leaving the sibling', () => {
    const summary = purgeConnectionData(
      { connection_name: 'acme-slack', messenger_vendor: 'slack' },
      purgeDeps(),
    );
    expect(summary.contact_links_retracted).toBe(2);
    expect(store.countPlatformLinksForConnection('slack', 'personal-slack')).toBe(1);
  });

  it('skips the contact leg when no messenger_vendor is given', () => {
    const summary = purgeConnectionData({ connection_name: 'acme-slack' }, purgeDeps());
    expect(summary.contact_links_retracted).toBe(0);
    expect(store.countPlatformLinksForConnection('slack', 'acme-slack')).toBe(2);
  });

  it('PARITY — the preview count equals exactly what the purge retracts', () => {
    const previewed = previewConnectionPurgeCount(
      { connection_name: 'acme-slack', messenger_vendor: 'slack' },
      previewDeps(),
    );
    const purged = purgeConnectionData(
      { connection_name: 'acme-slack', messenger_vendor: 'slack' },
      purgeDeps(),
    );
    expect(previewed).toBe(purged.contact_links_retracted);
    // …and once retracted, the preview reads 0.
    expect(
      previewConnectionPurgeCount(
        { connection_name: 'acme-slack', messenger_vendor: 'slack' },
        previewDeps(),
      ),
    ).toBe(0);
  });
});

// ── handler gate: notification-messenger vs non-messenger ────────

describe('handleConnectionDelete / PreviewPurge — messenger gate', () => {
  let dir: string;
  let db: Database.Database;
  let store: ReturnType<typeof createConnectionStore>;

  const enroll = (name: string, subtype: string): void => {
    store.upsert({
      kind: 'notification',
      name,
      subtype,
      display_name: name,
      config_json: '{}',
      auth_ciphertext: 'x',
      enrolled_at: 1,
      updated_at: 1,
    });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd192-messenger-gate-'));
    db = new Database(join(dir, 'conn.db'));
    store = createConnectionStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const emptySummary = {
    sources_purged: 0,
    sources_skipped: 0,
    records_deleted: 0,
    annotations_deleted: 0,
    links_deleted: 0,
    enrichments_deleted: 0,
    edges_deleted: 0,
    crm_records_deleted: 0,
    crm_enrichments_deleted: 0,
    contact_links_retracted: 3,
  };

  it('delete of a messenger (slack) notification retracts via messenger_vendor', async () => {
    enroll('my-slack', 'slack');
    const purgeFn = vi.fn(() => emptySummary);
    const out = await handleConnectionDelete(
      { store, purgeConnectionData: purgeFn },
      { kind: 'notification', name: 'my-slack', remove_mirror_data: true },
    );
    expect(out).toEqual({ deleted: true, purged: emptySummary });
    expect(purgeFn).toHaveBeenCalledWith({ connection_name: 'my-slack', messenger_vendor: 'slack' });
  });

  it('delete of a non-messenger (email) notification does NOT purge', async () => {
    enroll('my-email', 'email');
    const purgeFn = vi.fn(() => emptySummary);
    const out = await handleConnectionDelete(
      { store, purgeConnectionData: purgeFn },
      { kind: 'notification', name: 'my-email', remove_mirror_data: true },
    );
    expect(out).toEqual({ deleted: true });
    expect(purgeFn).not.toHaveBeenCalled();
  });

  it('preview of a messenger (slack) notification counts via messenger_vendor', async () => {
    enroll('my-slack', 'slack');
    const previewFn = vi.fn(() => 3);
    const out = await handleConnectionPreviewPurge(
      { store, previewConnectionPurgeCount: previewFn },
      { kind: 'notification', name: 'my-slack' },
    );
    expect(out).toEqual({ count: 3 });
    expect(previewFn).toHaveBeenCalledWith({ connection_name: 'my-slack', messenger_vendor: 'slack' });
  });

  it('preview of a non-messenger (email) notification returns 0 without calling the closure', async () => {
    enroll('my-email', 'email');
    const previewFn = vi.fn(() => 3);
    const out = await handleConnectionPreviewPurge(
      { store, previewConnectionPurgeCount: previewFn },
      { kind: 'notification', name: 'my-email' },
    );
    expect(out).toEqual({ count: 0 });
    expect(previewFn).not.toHaveBeenCalled();
  });
});
