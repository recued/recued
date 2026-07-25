/** D-138 Phase 1 — contact-merge substrate tests.
 *
 *  Covers the storage-side P1 surface:
 *    - Schema delta lands cleanly (ALTER + new internal tables)
 *    - Internal tables drive lookup, not JSON-extract indexes
 *      (`EXPLAIN QUERY PLAN` asserts indexed primary)
 *    - Auto-link via `linkPlatformId` materialises JSON column
 *    - Rejection round-trip (write + symmetric materialization +
 *      pre-filter; rich provenance retained on the table)
 *    - Merge candidate enqueue / list / status updates
 *    - Inline detection scans existing graph + enqueues candidates
 *    - resolveCanonicalEmail walks merged_into chain
 *    - Domain → company resolver (ambiguous cutoff at 2 distinct)
 *    - Merge transaction: platform_ids absorbed + merged_into set +
 *      annotations rewritten + losers tombstoned + cascade fires
 *    - Split reverses + writes durable rejection
 *    - Undo rejection removes the row
 *
 *  rpc-handler-level tests (RpcError shapes, broadcast emit) live in
 *  the contact-merge-handler test file. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createAnnotationStore,
  type AnnotationStore,
} from '../storage/annotation-store.js';
import { createBlobStore } from '../storage/blob-store.js';
import {
  createContactStore,
  detectInlineMergeCandidates,
  type ContactStore,
} from '../storage/contact-store.js';
import {
  handleContactMergeConfirm,
  handleContactMergeList,
  handleContactMergeReject,
  handleContactMergeSplit,
  handleContactMergeUndoRejection,
  handleContactMergeResolveRemergePrompt,
  type ContactMergeRpcDeps,
} from '../contact-merge-handler.js';

let dir: string;
let db: Database.Database;
let store: ContactStore;
let annotationStore: AnnotationStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd138-merge-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createContactStore(db);
  annotationStore = createAnnotationStore({
    db,
    blobs: createBlobStore(join(dir, 'blobs')),
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const seedContact = (
  email: string,
  fields: Partial<{
    name: string;
    phone: string;
    company: string;
    mailing_address: import('@recued/contracts').MailingAddress;
  }> = {},
): void => {
  store.upsertManual({
    email,
    ...(fields.name !== undefined ? { name: fields.name } : {}),
    ...(fields.phone !== undefined ? { phone: fields.phone } : {}),
    ...(fields.company !== undefined ? { company: fields.company } : {}),
    ...(fields.mailing_address !== undefined ? { mailing_address: fields.mailing_address } : {}),
  });
};

describe('D-138 P1 — schema delta lands cleanly', () => {
  it('contacts table grows the merge-substrate columns', () => {
    const cols = (db.prepare(`PRAGMA table_info(contacts)`).all() as { name: string }[]).map(
      (r) => r.name,
    );
    for (const col of [
      'platform_ids',
      'rejected_pairs',
      'merged_into',
      'phone',
      'mailing_address',
      'company',
      'company_source',
      'name_key',
      'address_zip_country_key',
      'company_norm',
    ]) {
      expect(cols).toContain(col);
    }
  });

  it('internal lookup tables exist with UNIQUE constraints', () => {
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toContain('contact_platform_link');
    expect(tables).toContain('contact_rejection');
    expect(tables).toContain('contact_merge_candidate_queue');
  });

  it('contacts row backfills with empty platform_ids + null merge fields', () => {
    seedContact('a@x.com', { name: 'Alice Jones' });
    const row = store.get('a@x.com');
    expect(row).not.toBeNull();
    expect(row!.platform_ids).toEqual([]);
    expect(row!.rejected_pairs).toBeUndefined();
    expect(row!.merged_into).toBeUndefined();
    expect(row!.phone).toBeUndefined();
    expect(row!.mailing_address).toBeUndefined();
    expect(row!.company).toBeUndefined();
  });
});

describe('D-138 P1 — internal tables drive lookup (Reviewer #3)', () => {
  it('platform-link lookup hits contact_platform_link UNIQUE index, not JSON scan', () => {
    seedContact('a@x.com');
    store.linkPlatformId({
      canonical_email: 'a@x.com',
      vendor: 'hubspot',
      platform_id: 'hubspot_contact_47291',
      state: 'auto',
      linked_at: 1_700_000_000_000,
      linked_by: 'reconciler:hubspot',
    });
    // EXPLAIN QUERY PLAN — must use the (vendor, platform_id) index,
    // not a full table scan.
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT canonical_email FROM contact_platform_link
           WHERE vendor = ? AND platform_id = ?`,
      )
      .all('hubspot', 'hubspot_contact_47291') as Array<{ detail: string }>;
    const detail = plan.map((r) => r.detail).join(' | ');
    expect(detail.toLowerCase()).toMatch(/using.*(index|primary key)/);
    // Lookup returns the canonical email.
    expect(store.lookupPlatformLink('hubspot', 'hubspot_contact_47291')).toBe('a@x.com');
  });

  it('rejection lookup uses (email_a, email_b) UNIQUE index', () => {
    seedContact('a@x.com');
    seedContact('b@x.com');
    store.addRejection({ email_a: 'a@x.com', email_b: 'b@x.com', rejected_at: 1 });
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT 1 FROM contact_rejection
           WHERE email_a = ? AND email_b = ?`,
      )
      .all('a@x.com', 'b@x.com') as Array<{ detail: string }>;
    const detail = plan.map((r) => r.detail).join(' | ');
    expect(detail.toLowerCase()).toMatch(/using.*(index|primary key)/);
  });
});

describe('D-138 P1 — auto-link round trip', () => {
  it('linkPlatformId materializes platform_ids JSON', () => {
    seedContact('a@x.com');
    store.linkPlatformId({
      canonical_email: 'a@x.com',
      vendor: 'hubspot',
      platform_id: 'hubspot_contact_47291',
      state: 'auto',
      linked_at: 1_700_000_000_000,
      linked_by: 'reconciler:hubspot',
    });
    const row = store.get('a@x.com');
    expect(row!.platform_ids).toEqual([
      {
        vendor: 'hubspot',
        platform_id: 'hubspot_contact_47291',
        state: 'auto',
        linked_at: 1_700_000_000_000,
        linked_by: 'reconciler:hubspot',
      },
    ]);
  });

  it('rekey re-materializes both rows (codex review fix)', () => {
    seedContact('a@x.com');
    seedContact('b@x.com');
    store.linkPlatformId({
      canonical_email: 'a@x.com',
      vendor: 'hubspot',
      platform_id: 'h1',
      state: 'auto',
      linked_at: 1,
      linked_by: 'reconciler:hubspot',
    });
    expect(store.get('a@x.com')!.platform_ids).toHaveLength(1);
    // Rekey the same (vendor, platform_id) onto b@x.com.
    store.linkPlatformId({
      canonical_email: 'b@x.com',
      vendor: 'hubspot',
      platform_id: 'h1',
      state: 'confirmed',
      linked_at: 2,
      linked_by: 'user:b@x.com',
    });
    // Both rows must reflect the move — old owner empty, new owner
    // shows the entry. Without the previous-owner re-materialization,
    // a@x.com's JSON would still carry the stale entry.
    expect(store.get('a@x.com')!.platform_ids).toEqual([]);
    expect(store.get('b@x.com')!.platform_ids).toHaveLength(1);
    expect(store.get('b@x.com')!.platform_ids![0].state).toBe('confirmed');
  });

  it('multiple entries with same vendor are allowed (HubSpot duplicates)', () => {
    seedContact('a@x.com');
    store.linkPlatformId({
      canonical_email: 'a@x.com',
      vendor: 'hubspot',
      platform_id: 'a',
      state: 'auto',
      linked_at: 1,
      linked_by: 'reconciler:hubspot',
    });
    store.linkPlatformId({
      canonical_email: 'a@x.com',
      vendor: 'hubspot',
      platform_id: 'b',
      state: 'auto',
      linked_at: 2,
      linked_by: 'reconciler:hubspot',
    });
    expect(store.get('a@x.com')!.platform_ids).toHaveLength(2);
  });

  it('unlinkPlatformId removes from internal table + re-materializes JSON', () => {
    seedContact('a@x.com');
    store.linkPlatformId({
      canonical_email: 'a@x.com',
      vendor: 'hubspot',
      platform_id: 'a',
      state: 'auto',
      linked_at: 1,
      linked_by: 'reconciler:hubspot',
    });
    expect(store.unlinkPlatformId('hubspot', 'a')).toBe('a@x.com');
    expect(store.get('a@x.com')!.platform_ids).toEqual([]);
    expect(store.lookupPlatformLink('hubspot', 'a')).toBeNull();
  });
});

describe('D-138 P1 — rejection round trip (symmetric, rich provenance)', () => {
  it('addRejection materializes both rows symmetrically', () => {
    seedContact('a@x.com');
    seedContact('b@x.com');
    store.addRejection({
      email_a: 'b@x.com', // unordered input — lex-orders internally
      email_b: 'a@x.com',
      rejected_at: 100,
      rejected_by: 'user@example.com',
      source_candidate_id: 'cand-1',
    });
    expect(store.get('a@x.com')!.rejected_pairs).toEqual(['b@x.com']);
    expect(store.get('b@x.com')!.rejected_pairs).toEqual(['a@x.com']);
    expect(store.isPairRejected('a@x.com', 'b@x.com')).toBe(true);
    expect(store.isPairRejected('b@x.com', 'a@x.com')).toBe(true);
  });

  it('removeRejection wipes both materializations', () => {
    seedContact('a@x.com');
    seedContact('b@x.com');
    store.addRejection({ email_a: 'a@x.com', email_b: 'b@x.com', rejected_at: 1 });
    expect(store.removeRejection('a@x.com', 'b@x.com')).toBe(true);
    expect(store.get('a@x.com')!.rejected_pairs).toBeUndefined();
    expect(store.get('b@x.com')!.rejected_pairs).toBeUndefined();
  });

  it('rejectedPairKeys snapshot covers every edge', () => {
    seedContact('a@x.com');
    seedContact('b@x.com');
    seedContact('c@x.com');
    store.addRejection({ email_a: 'a@x.com', email_b: 'b@x.com', rejected_at: 1 });
    store.addRejection({ email_a: 'a@x.com', email_b: 'c@x.com', rejected_at: 2 });
    const set = store.rejectedPairKeys();
    expect(set.size).toBe(2);
    expect(set.has('a@x.com|b@x.com')).toBe(true);
    expect(set.has('a@x.com|c@x.com')).toBe(true);
  });
});

describe('D-138 P1 — merge candidate queue', () => {
  beforeEach(() => {
    seedContact('a@x.com', { name: 'Alice Jones', company: 'Acme' });
    seedContact('b@x.com', { name: 'Alice Jones', company: 'Acme' });
  });

  it('enqueueMergeCandidate is idempotent on pair_key', () => {
    store.enqueueMergeCandidate({
      id: 'c1',
      email_a: 'a@x.com',
      email_b: 'b@x.com',
      matched_fields: ['name', 'company'],
      detected_at: 1,
      detected_by: 'inline',
    });
    store.enqueueMergeCandidate({
      id: 'c2',
      email_a: 'a@x.com',
      email_b: 'b@x.com',
      matched_fields: ['name', 'company'],
      detected_at: 2,
      detected_by: 'inline',
    });
    const list = store.listMergeCandidates({ status: 'pending' });
    expect(list.candidates).toHaveLength(1);
    expect(list.candidates[0].id).toBe('c1');
  });

  it('listMergeCandidates orders by detected_at descending', () => {
    store.enqueueMergeCandidate({
      id: 'c1',
      email_a: 'a@x.com',
      email_b: 'b@x.com',
      matched_fields: ['name'],
      detected_at: 1,
      detected_by: 'inline',
    });
    seedContact('c@x.com');
    store.enqueueMergeCandidate({
      id: 'c2',
      email_a: 'a@x.com',
      email_b: 'c@x.com',
      matched_fields: ['name'],
      detected_at: 2,
      detected_by: 'inline',
    });
    const list = store.listMergeCandidates({ status: 'pending' });
    expect(list.candidates.map((c) => c.id)).toEqual(['c2', 'c1']);
  });

  it('setMergeCandidateStatus flips status off pending', () => {
    store.enqueueMergeCandidate({
      id: 'c1',
      email_a: 'a@x.com',
      email_b: 'b@x.com',
      matched_fields: ['name'],
      detected_at: 1,
      detected_by: 'inline',
    });
    const updated = store.setMergeCandidateStatus('c1', 'merged', 100, 'user@x.com');
    expect(updated!.status).toBe('merged');
    expect(updated!.resolved_at).toBe(100);
    expect(updated!.resolved_by).toBe('user@x.com');
  });

  it('requeue after resolved status flips back to pending (A.10 path; codex review fix)', () => {
    store.enqueueMergeCandidate({
      id: 'c1',
      email_a: 'a@x.com',
      email_b: 'b@x.com',
      matched_fields: ['name'],
      detected_at: 1,
      detected_by: 'inline',
    });
    store.setMergeCandidateStatus('c1', 'rejected', 50, 'user@x.com');
    expect(store.listMergeCandidates({ status: 'pending' }).candidates).toHaveLength(0);
    // A.10 re-merge calls enqueueMergeCandidate again with a fresh
    // input. The substrate must surface the row in `pending` again
    // (otherwise the prompt-resolve flow leaves the queue empty
    // while reporting it queued).
    const requeued = store.enqueueMergeCandidate({
      id: 'c2',
      email_a: 'a@x.com',
      email_b: 'b@x.com',
      matched_fields: ['name', 'company'],
      detected_at: 200,
      detected_by: 'inline',
    });
    expect(requeued.status).toBe('pending');
    expect(requeued.matched_fields).toEqual(['name', 'company']);
    expect(requeued.detected_at).toBe(200);
    expect(store.listMergeCandidates({ status: 'pending' }).candidates).toHaveLength(1);
  });
});

describe('D-138 P1 — inline detection', () => {
  it('detectInlineMergeCandidates surfaces a 2-field pair', () => {
    seedContact('alice@y.com', { name: 'Alice Jones', company: 'Acme' });
    seedContact('a.jones@x.com', { name: 'Alice Jones', company: 'Acme' });
    const a = store.get('a.jones@x.com')!;
    const candidates = detectInlineMergeCandidates(store, a, {
      nowFn: () => 1,
      idFactory: () => 'cand-1',
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].matched_fields.sort()).toEqual(['company', 'name']);
  });

  it('rejection pre-filter skips already-rejected pairs', () => {
    seedContact('alice@y.com', { name: 'Alice Jones', company: 'Acme' });
    seedContact('a.jones@x.com', { name: 'Alice Jones', company: 'Acme' });
    store.addRejection({ email_a: 'alice@y.com', email_b: 'a.jones@x.com', rejected_at: 1 });
    const a = store.get('a.jones@x.com')!;
    const candidates = detectInlineMergeCandidates(store, a, {
      nowFn: () => 1,
      idFactory: () => 'cand-1',
    });
    expect(candidates).toHaveLength(0);
  });
});

describe('D-138 P1 — resolveCanonicalEmail walks chain', () => {
  it('returns the email itself when no merged_into', () => {
    seedContact('a@x.com');
    expect(store.resolveCanonicalEmail('a@x.com')).toEqual({
      canonical_email: 'a@x.com',
      chain_depth: 0,
    });
  });
  it('walks one-hop redirect', () => {
    seedContact('a@x.com');
    seedContact('b@x.com');
    const a = store.get('a@x.com')!;
    store.setMergedInto([a], 'b@x.com', Date.now());
    expect(store.resolveCanonicalEmail('a@x.com')).toEqual({
      canonical_email: 'b@x.com',
      chain_depth: 1,
    });
  });
});

describe('D-138 P1 — domain → company resolver gate (Reviewer #8)', () => {
  it('inferred when seed pool has exactly 1 vendor_meta/manual company', () => {
    store.upsertManual({ email: 'alice@acme.com', name: 'Alice', company: 'Acme' });
    expect(store.resolveCompanyForDomain('acme.com')).toEqual({
      kind: 'inferred',
      company: 'Acme',
    });
  });
  it('ambiguous when ≥ COMPANY_DOMAIN_INFERENCE_MAX_DISTINCT_COMPANIES', () => {
    store.upsertManual({ email: 'a@gmail.com', name: 'A', company: 'CompanyA' });
    store.upsertManual({ email: 'b@gmail.com', name: 'B', company: 'CompanyB' });
    expect(store.resolveCompanyForDomain('gmail.com')).toEqual({ kind: 'ambiguous' });
  });
  it('empty when no seed pool exists', () => {
    expect(store.resolveCompanyForDomain('unknown.com')).toEqual({ kind: 'empty' });
  });
});

// ────────────────────────────────────────────────────────────────
// rpc-handler integration
// ────────────────────────────────────────────────────────────────

const newDeps = (overrides: Partial<ContactMergeRpcDeps> = {}): ContactMergeRpcDeps => ({
  contactStore: store,
  annotationStore,
  now: () => 1_700_000_000_000,
  newId: () => 'cand-test',
  ...overrides,
});

describe('D-138 P1 — contact.merge.list rpc', () => {
  it('returns pending candidates ordered by detected_at desc', async () => {
    seedContact('a@x.com', { name: 'Alice Jones', company: 'Acme' });
    seedContact('b@x.com', { name: 'Alice Jones', company: 'Acme' });
    store.enqueueMergeCandidate({
      id: 'c1',
      email_a: 'a@x.com',
      email_b: 'b@x.com',
      matched_fields: ['name', 'company'],
      detected_at: 1,
      detected_by: 'inline',
    });
    const result = await handleContactMergeList(newDeps(), {});
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].id).toBe('c1');
  });
});

describe('D-138 P1 — contact.merge.confirm rpc', () => {
  beforeEach(() => {
    seedContact('survivor@x.com', { name: 'Alice Jones', company: 'Acme' });
    seedContact('loser@x.com', { name: 'Alice Jones', company: 'Acme' });
    store.linkPlatformId({
      canonical_email: 'loser@x.com',
      vendor: 'hubspot',
      platform_id: 'h1',
      state: 'auto',
      linked_at: 1,
      linked_by: 'reconciler:hubspot',
    });
    store.enqueueMergeCandidate({
      id: 'cand-1',
      email_a: 'loser@x.com',
      email_b: 'survivor@x.com',
      matched_fields: ['name', 'company'],
      detected_at: 1,
      detected_by: 'inline',
    });
  });

  it('absorbs platform_ids onto survivor + tombstones loser', async () => {
    const onIdentityChanged = vi.fn();
    const result = await handleContactMergeConfirm(
      newDeps({ onIdentityChanged }),
      {
        candidate_ids: ['cand-1'],
        survivor_email: 'survivor@x.com',
      },
    );
    expect(result.survivor.platform_ids).toHaveLength(1);
    expect(result.survivor.platform_ids![0].platform_id).toBe('h1');
    expect(result.losers[0].merged_into).toBe('survivor@x.com');
    expect(onIdentityChanged).toHaveBeenCalledWith({
      survivor_email: 'survivor@x.com',
      loser_emails: ['loser@x.com'],
    });
  });

  it('flips candidate status to merged + emits broadcast', async () => {
    const emit = vi.fn();
    await handleContactMergeConfirm(
      newDeps({ emitMergeCandidate: emit }),
      {
        candidate_ids: ['cand-1'],
        survivor_email: 'survivor@x.com',
      },
    );
    const after = store.getMergeCandidate('cand-1');
    expect(after!.status).toBe('merged');
    expect(emit).toHaveBeenCalledWith('resolved', expect.objectContaining({ id: 'cand-1' }));
  });

  it('rejects candidates not connected to survivor in the supplied edge set (codex review fix)', async () => {
    seedContact('c@x.com');
    seedContact('d@x.com');
    // A candidate over (c, d) that doesn't touch the survivor.
    store.enqueueMergeCandidate({
      id: 'cand-orphan',
      email_a: 'c@x.com',
      email_b: 'd@x.com',
      matched_fields: ['name'],
      detected_at: 1,
      detected_by: 'inline',
    });
    await expect(
      handleContactMergeConfirm(newDeps(), {
        candidate_ids: ['cand-1', 'cand-orphan'],
        survivor_email: 'survivor@x.com',
      }),
    ).rejects.toThrow(/not connected to survivor/);
  });

  it('rejects when survivor_email is not present in any supplied candidate edge', async () => {
    seedContact('c@x.com');
    seedContact('d@x.com');
    store.enqueueMergeCandidate({
      id: 'cand-orphan',
      email_a: 'c@x.com',
      email_b: 'd@x.com',
      matched_fields: ['name'],
      detected_at: 1,
      detected_by: 'inline',
    });
    await expect(
      handleContactMergeConfirm(newDeps(), {
        candidate_ids: ['cand-orphan'],
        survivor_email: 'survivor@x.com',
      }),
    ).rejects.toThrow(/not present in any of the supplied candidate edges/);
  });

  it('rejects when survivor is itself merged_into another row', async () => {
    seedContact('upstream@x.com');
    const survivor = store.get('survivor@x.com')!;
    store.setMergedInto([survivor], 'upstream@x.com', 1);
    await expect(
      handleContactMergeConfirm(newDeps(), {
        candidate_ids: ['cand-1'],
        survivor_email: 'survivor@x.com',
      }),
    ).rejects.toThrow(/merged into/);
  });

  it('rewrites annotations via AnnotationStore.rewriteRecordId', async () => {
    await annotationStore.annotate({
      target_collection: 'contact',
      target_id: 'loser@x.com',
      key: 'note',
      value: 'a-note',
      authored_by_recipe_id: 'recipe-x',
      source_record_hash: 'hash-x',
      recipe_hash: 'rh-x',
    });
    await handleContactMergeConfirm(newDeps(), {
      candidate_ids: ['cand-1'],
      survivor_email: 'survivor@x.com',
    });
    const survivorAnns = await annotationStore.annotationsForRecord('contact', 'survivor@x.com');
    expect(survivorAnns).toHaveLength(1);
    expect(survivorAnns[0].key).toBe('note');
  });
});

describe('D-138 P1 — contact.merge.reject rpc', () => {
  it('writes one rejection row per surfaced candidate (Reviewer #5)', async () => {
    seedContact('a@x.com');
    seedContact('b@x.com');
    seedContact('c@x.com');
    store.enqueueMergeCandidate({
      id: 'c1',
      email_a: 'a@x.com',
      email_b: 'b@x.com',
      matched_fields: ['name'],
      detected_at: 1,
      detected_by: 'inline',
    });
    store.enqueueMergeCandidate({
      id: 'c2',
      email_a: 'a@x.com',
      email_b: 'c@x.com',
      matched_fields: ['name'],
      detected_at: 1,
      detected_by: 'inline',
    });
    const result = await handleContactMergeReject(newDeps(), {
      candidate_ids: ['c1', 'c2'],
      rejected_by: 'user@x.com',
    });
    expect(result.rejection_rows_written).toBe(2);
    expect(store.isPairRejected('a@x.com', 'b@x.com')).toBe(true);
    expect(store.isPairRejected('a@x.com', 'c@x.com')).toBe(true);
    // b ↔ c is NOT pairwise-rejected (the cluster would have to surface
    // that pair as its own candidate row first).
    expect(store.isPairRejected('b@x.com', 'c@x.com')).toBe(false);
  });
});

describe('D-138 P1 — contact.merge.split rpc', () => {
  it('reverses a merge + writes durable rejection', async () => {
    seedContact('a@x.com');
    seedContact('b@x.com');
    store.linkPlatformId({
      canonical_email: 'b@x.com',
      vendor: 'hubspot',
      platform_id: 'h1',
      state: 'auto',
      linked_at: 1,
      linked_by: 'reconciler:hubspot',
    });
    store.enqueueMergeCandidate({
      id: 'cand-1',
      email_a: 'a@x.com',
      email_b: 'b@x.com',
      matched_fields: ['name'],
      detected_at: 1,
      detected_by: 'inline',
    });
    await handleContactMergeConfirm(newDeps(), {
      candidate_ids: ['cand-1'],
      survivor_email: 'a@x.com',
    });
    expect(store.get('b@x.com')!.merged_into).toBe('a@x.com');
    // Split: redistribute the platform_id back onto b@x.com.
    const result = await handleContactMergeSplit(newDeps(), {
      merged_email: 'b@x.com',
      platform_id_redistribution: [
        {
          platform_id_entry: {
            vendor: 'hubspot',
            platform_id: 'h1',
            state: 'confirmed',
            linked_at: 1,
            linked_by: 'reconciler:hubspot',
          },
          target_canonical_email: 'b@x.com',
        },
      ],
      rejected_by: 'user@x.com',
    });
    expect(result.canonicals.find((c) => c.email === 'b@x.com')!.merged_into).toBeUndefined();
    expect(store.isPairRejected('a@x.com', 'b@x.com')).toBe(true);
  });
});

describe('D-138 P1 — contact.merge.undo_rejection rpc', () => {
  it('removes the rejection row + clears symmetric materialisation', async () => {
    seedContact('a@x.com');
    seedContact('b@x.com');
    store.addRejection({ email_a: 'a@x.com', email_b: 'b@x.com', rejected_at: 1 });
    expect(store.isPairRejected('a@x.com', 'b@x.com')).toBe(true);
    await handleContactMergeUndoRejection(newDeps(), {
      email_a: 'a@x.com',
      email_b: 'b@x.com',
    });
    expect(store.isPairRejected('a@x.com', 'b@x.com')).toBe(false);
  });
});

describe('D-138 P1 — contact.merge.resolve_remerge_prompt rpc', () => {
  it('surfaces not_configured when no prompt store is wired (dbless fallback)', async () => {
    // Assert the stable error CODE, not the prose message.
    await expect(
      handleContactMergeResolveRemergePrompt(newDeps(), {
        prompt_id: 'p1',
        resolution: 'remerge',
      }),
    ).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('with prompt store: remerge removes rejection + queues fresh candidate', async () => {
    seedContact('a@x.com');
    seedContact('b@x.com');
    store.addRejection({ email_a: 'a@x.com', email_b: 'b@x.com', rejected_at: 1 });
    const promptStore = {
      get: vi.fn().mockReturnValue({
        id: 'p1',
        affected_email: 'a@x.com',
        partner_email: 'b@x.com',
        vendor: 'hubspot',
        fired_at: 100,
      }),
      resolve: vi.fn(),
    };
    const result = await handleContactMergeResolveRemergePrompt(
      newDeps({ promptStore }),
      { prompt_id: 'p1', resolution: 'remerge' },
    );
    expect(result.result).toBe('queued_merge_candidate');
    expect(store.isPairRejected('a@x.com', 'b@x.com')).toBe(false);
    const list = store.listMergeCandidates({ status: 'pending' });
    expect(list.candidates).toHaveLength(1);
  });
});
