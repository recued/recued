/** D-145 PA8 — promotion flow + D-138 reconcile (§ A.4.6).
 *
 *  When a mention_only contact gains canonical email:
 *    1. identity_status flips to 'verified'
 *    2. canonical_email is set (synthetic placeholder rewritten)
 *    3. D-138 reconciliation re-runs against existing platform
 *       contacts via the existing detectInlineMergeCandidates harness
 *    4. Merge-candidate is enqueued when the predicate matches
 *
 *  The store is decoupled from the predicate; the harness wires it
 *  externally. These tests assemble the harness explicitly to verify
 *  the flow end-to-end.
 *
 *  Spec: docs/d-145-spec.md § A.4.6. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createContactStore,
  detectInlineMergeCandidates,
  type ContactStore,
} from '../storage/contact-store.js';
import { type ContactMergeCandidate, type ContactRecord } from '@recued/contracts';

let dir: string;
let db: Database.Database;
let store: ContactStore;
let detectedCandidates: ContactMergeCandidate[];

const upsertHook = (record: ContactRecord): void => {
  const cands = detectInlineMergeCandidates(store, record, {
    nowFn: () => Date.now(),
    idFactory: () => randomUUID(),
    detected_by: 'inline',
  });
  detectedCandidates.push(...cands);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa8-promotion-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  detectedCandidates = [];
  store = createContactStore(db, {
    onContactUpserted: (rec) => upsertHook(rec),
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('D-145 PA8 — promotion flow / mention_only → verified', () => {
  it('mention_only creation does NOT enqueue D-138 candidates (excluded per § A.4.1)', () => {
    // Pre-existing real contact carrying the same display name.
    store.upsertManual({
      email: 'mary.jones@work.com',
      name: 'Mary Smith',
      phone: '+15551234567',
    });
    store.upsertManual({
      email: 'mary.smith@home.com',
      name: 'Mary Smith',
      phone: '+15551234567',
    });
    detectedCandidates = []; // clear setup-time emits

    // Creating the mention_only stub MUST NOT re-trigger detection
    // since mention_only contacts are excluded from D-138 reconcile.
    store.createMentionOnlyContact({ name: 'Mary Smith' });
    expect(detectedCandidates.length).toBe(0);
  });

  it('promotion to a fresh email + matching predicate enqueues a D-138 candidate', () => {
    // Existing CRM-derived contact (vendor_meta) with phone
    // populated.
    store.upsertManual({
      email: 'mary@crm.com',
      name: 'Mary Smith',
      phone: '+15551234567',
    });
    detectedCandidates = []; // baseline

    // Mention-only stub for "Mom".
    const stub = store.createMentionOnlyContact({ name: 'Mary Smith' });
    expect(stub.identity_status).toBe('mention_only');
    expect(detectedCandidates.length).toBe(0); // mention_only excluded

    // User confirms in chat: mom's real email is mary@personal.com.
    const promoted = store.promoteMentionOnlyToVerified({
      contact_id: stub.contact_id!,
      email: 'mary@personal.com',
      name: 'Mary Smith',
    });

    // Add phone via manual upsert post-promotion to make the
    // predicate match. (In real flow this happens through a CRM-
    // side enrichment ingest.)
    detectedCandidates = []; // clear post-promotion emits
    store.upsertManual({
      email: promoted.email,
      phone: '+15551234567',
    });

    // Predicate matched on (name + phone) → candidate enqueued.
    expect(detectedCandidates.length).toBe(1);
    expect(detectedCandidates[0]?.matched_fields).toContain('name');
    expect(detectedCandidates[0]?.matched_fields).toContain('phone');
  });

  it('promotion fires the broadcast bus event', () => {
    // Capture the upsert-hook invocations to confirm promotion
    // triggers the same plumbing observe / upsertManual do.
    const upserts: ContactRecord[] = [];
    const localStore = createContactStore(db, {
      onContactUpserted: (rec) => upserts.push(rec),
    });
    const stub = localStore.createMentionOnlyContact({ name: 'Mom' });
    upserts.length = 0;
    localStore.promoteMentionOnlyToVerified({
      contact_id: stub.contact_id!,
      email: 'mary@gmail.com',
    });
    expect(upserts.length).toBe(1);
    expect(upserts[0]?.contact_id).toBe(stub.contact_id);
    expect(upserts[0]?.identity_status).toBe('verified');
  });

  it('contact_id stays stable across promotion (alias bindings preserved)', () => {
    const stub = store.createMentionOnlyContact({ name: 'Mom' });
    store.upsertContactAlias({
      contact_id: stub.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'mom',
      source: 'manual',
    });
    const promoted = store.promoteMentionOnlyToVerified({
      contact_id: stub.contact_id!,
      email: 'mary@gmail.com',
    });
    expect(promoted.contact_id).toBe(stub.contact_id);
    // Alias still resolves post-promotion (the contact_id pointer is
    // intact even though the email column was rewritten).
    const out = store.resolveContactReference('mom', { recent_contacts: [] });
    expect(out.contact_id).toBe(stub.contact_id);
  });

  it('promotion preserves first_seen (chronology stays accurate)', () => {
    const stub = store.createMentionOnlyContact({
      name: 'Mom',
      first_seen: 100,
    });
    const promoted = store.promoteMentionOnlyToVerified({
      contact_id: stub.contact_id!,
      email: 'mary@gmail.com',
    });
    expect(promoted.first_seen).toBe(100);
  });

  it('post-promotion the contact is included in D-138 candidate scans', () => {
    // Pre-existing CRM contact with a name that will match.
    store.upsertManual({
      email: 'mary@crm.com',
      name: 'Mary Jones',
      phone: '+15551111111',
    });
    detectedCandidates = [];

    const stub = store.createMentionOnlyContact({ name: 'Mary Jones' });
    store.promoteMentionOnlyToVerified({
      contact_id: stub.contact_id!,
      email: 'mary@personal.com',
    });
    detectedCandidates = [];

    // After promotion, manually adding phone reaches the predicate.
    store.upsertManual({
      email: 'mary@personal.com',
      phone: '+15551111111',
    });

    expect(detectedCandidates.length).toBe(1);
  });

  it('mention_only contacts excluded from candidate-side scans too (other.identity_status guard)', () => {
    const stub = store.createMentionOnlyContact({ name: 'Bob' });
    detectedCandidates = [];

    // Add an existing real contact with the same name + matching
    // phone — predicate would normally surface a match.
    store.upsertManual({
      email: 'bob@x.com',
      name: 'Bob',
      phone: '+15551234567',
    });

    // The new contact upsert does NOT pair with the mention_only
    // stub on the OTHER side either — they're excluded from scans.
    expect(detectedCandidates.length).toBe(0);
    void stub;
  });
});
