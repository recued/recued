/** The owner's own data is budgeted for a SERVER, not a browser extension.
 *
 *  ⛔ WHAT THIS RATCHET IS FOR. The storage budgets were sized when the product
 *  lived in a browser extension against IndexedDB, and they were carried
 *  forward unchanged when it became a self-hosted server. The mirror
 *  collections were eventually re-scaled — `collection.file` 5 GB,
 *  `collection.mail` 2 GB — but the owner's OWN authored data was left on the
 *  old figures: `data.shared` 100 MB, Records 100 MB / 100k rows, and the
 *  audit log (which D-120 graduated to `data.memory.*`) 50 MB.
 *
 *  That ordering is backwards. A collection is a MIRROR — delete it and a
 *  re-sync brings it back from Gmail or the filesystem. `data.shared`, Records
 *  and memory have no upstream: they are the thing the server exists to hold.
 *  A budget that stops the irreplaceable data an order of magnitude before the
 *  replaceable data is the extension's constraint outliving the extension.
 *
 *  ⚠ THE ASYMMETRY IS THE ASSERTION. Pinning absolute byte counts would be a
 *  frozen literal that fails on any legitimate re-tuning while checking
 *  nothing. What must not regress is the RELATIONSHIP: owner-authored surfaces
 *  are never budgeted below the mirrors that can be re-fetched.
 *
 *  ⛔ CORRECTED 2026-10-10: THE MIRROR FIGURES ABOVE WERE NEVER APPLIED. The
 *  "re-scaled" 5 GB and 2 GB lived only in `collection.{file,mail}.default.*`
 *  runtime keys that nothing read (removed that day, `RETIRED_RUNTIME_SETTINGS`).
 *  Each collection takes its budget from its own instance config with a
 *  built-in default (mail and calendar 512 MiB, received files a fixed 512 MiB),
 *  in the server, which this package cannot import. So this file no longer
 *  compares against the mirrors; the gigabyte floor below keeps every
 *  owner-authored surface above all three. */

import { describe, expect, it } from 'vitest';

import {
  RECORDS_DEFAULT_BYTE_QUOTA,
  RECORDS_DEFAULT_ROW_QUOTA,
} from '@recued/contracts';

import { RUNTIME_SCHEMA } from '../schema.js';
import { createRuntimeConfigStore } from '../runtime-store.js';

const GB = 1024 * 1024 * 1024;

describe('owner-authored data is budgeted for a server', () => {
  const store = createRuntimeConfigStore({});

  /** Surfaces holding data with NO upstream to re-sync from. */
  const OWNER_AUTHORED: ReadonlyArray<readonly [string, number]> = [
    ['data.shared.quota.bytes', store.get('data.shared.quota.bytes') as number],
    ['audit.quota.bytes', store.get('audit.quota.bytes') as number],
    ['records (byte quota)', RECORDS_DEFAULT_BYTE_QUOTA],
  ];

  it('every owner-authored surface is at least a gigabyte', () => {
    // Not a magic number so much as a floor that a browser-profile budget
    // cannot accidentally satisfy: the old values were 50-100 MB.
    for (const [name, value] of OWNER_AUTHORED) {
      expect(value, name).toBeGreaterThanOrEqual(1 * GB);
    }
  });

  it('Records rows scale past what a single business pack produces', () => {
    // A ledger or job-board pack keeping a few years of rows passes 100k
    // easily, and Records REJECTS at the limit — so the old ceiling stopped
    // the owner writing rather than silently dropping anything.
    expect(RECORDS_DEFAULT_ROW_QUOTA).toBeGreaterThanOrEqual(1_000_000);
  });

  it('⛔ AUDIT IS AUDIT, MEMORY IS MEMORY — internal and external names match', () => {
    // D-198 (2026-07-11) split one substrate into two, and the vocabulary has
    // to follow or the owner is pointed at the wrong store:
    //
    //   audit_entries / audit_activities → the run-provenance trail. Runtime
    //     writes only. Quota'd. Evicts oldest-first. Config keys `audit.*`.
    //   user_memory                      → the owner's curated knowledge.
    //     Owner writes via memory.import / memory.create. No quota, no prune.
    //
    // ⚠ THE LABELS HAVE MOVED TWICE AND BOTH MOVES WERE DEFENSIBLE. D-120
    // Phase 7 renamed "audit log" → "Memory" — correct THEN, because audit was
    // the memory substrate. D-198 created `user_memory` as a purpose-built
    // store ("NOT an AuditEntry extension — injecting hand-authored rows would
    // corrupt the audit authority"), which made that rename stale IN PLACE.
    // This asserts the post-split vocabulary so neither direction drifts again.
    const misnamed = RUNTIME_SCHEMA
      .filter((e) => e.key.startsWith('audit.'))
      .filter((e) => e.section !== 'Audit' || /memory/i.test(e.label));
    expect(
      misnamed.map((e) => `${e.key} [${e.section}] ${e.label}`),
      'audit.* knobs govern the provenance trail and must not be labelled Memory',
    ).toEqual([]);
  });

  it('the volatile cache is NOT swept up in this — eviction there is correct', () => {
    // `cache.max_bytes` caps an LRU/TTL cache (the engine's L2 and the shared
    // tier; `shared.max_bytes`, a cap for the shared tier alone, was read by
    // nothing and is gone). It should stay modest: evicting a cache loses
    // nothing, and a cache sized like a data store is just wasted disk. This
    // asserts the distinction is still being drawn.
    expect(store.get('cache.max_bytes') as number).toBeLessThan(1 * GB);
  });
});
