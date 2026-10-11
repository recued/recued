/** A contract write refreshes the pre-approval queries over its scope only when it
 *  changed a row (2026-10-09).
 *
 *  Every boot re-seeds the recipe grants with `setIfAbsent`, which finds them present.
 *  Each of those no-op writes used to re-read and re-hash the whole scope once per
 *  recorded query: 18 s of CPU per boot on an idle machine for a realm holding one
 *  pre-approval recorded through a contract (`d-261-boot`'s stdio case), growing with
 *  the square of the grant count.
 *
 *  The probe is the stored identity itself. A refresh rewrites an identity whose hash
 *  no longer matches the rows, so a deliberately stale hash shows whether one ran. */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { createContractStore, type ContractStore } from '../storage/contract-store.js';
import {
  createContractGrantEntryStore,
  type ContractGrantEntryStore,
} from '../storage/contract-grant-entry-store.js';
import { collectPreapprovalContractReads } from '../storage/preapproval-contract-reads.js';

const NOW = 1_700_000_000_000;

let db: Database.Database;
let store: ContractStore;
let grants: ContractGrantEntryStore;

const identity = (): { revision: number; content_hash: string } =>
  db.prepare(`SELECT revision, content_hash FROM preapproval_resource_identity WHERE kind = 'contract_query'`)
    .get() as { revision: number; content_hash: string };

beforeEach(() => {
  db = new Database(':memory:');
  store = createContractStore(db, { now: () => NOW });
  grants = createContractGrantEntryStore(store);
  grants.setIfAbsent('contract-a', 'core.mail.send', true, NOW);
  // A pre-approval that read the contract's grants, as preparation does.
  db.transaction(() => collectPreapprovalContractReads(db, () => store.scan('contract_grant', ['contract-a'])))();
  expect(identity().revision).toBe(1);
  db.prepare(`UPDATE preapproval_resource_identity SET content_hash = 'stale' WHERE kind = 'contract_query'`).run();
});

describe('a contract write refreshes pre-approval queries only when it changed a row', () => {
  it('a re-seed that finds the grant present leaves them alone', () => {
    expect(grants.setIfAbsent('contract-a', 'core.mail.send', true, NOW)).toBe(false);
    expect(identity()).toEqual({ revision: 1, content_hash: 'stale' });
  });

  it('a grant that was absent refreshes them, so a review still sees the change', () => {
    expect(grants.setIfAbsent('contract-a', 'core.mail.read', true, NOW)).toBe(true);
    expect(identity().revision).toBe(2);
    expect(identity().content_hash).not.toBe('stale');
  });

  it('a revoke that rewrites the grant refreshes them', () => {
    grants.set('contract-a', 'core.mail.send', false, NOW);
    expect(identity().revision).toBe(2);
  });

  it('a delete that matched nothing leaves them alone, and one that matched refreshes them', () => {
    expect(store.delete('contract_grant', ['contract-a', 'core.nothing'])).toBe(false);
    expect(identity().content_hash).toBe('stale');
    expect(store.delete('contract_grant', ['contract-a', 'core.mail.send'])).toBe(true);
    expect(identity().content_hash).not.toBe('stale');
  });
});
