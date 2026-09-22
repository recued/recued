/** P2/F2 change review — `listChanges`, the bounded keyset read over the change
 *  log the records write path already emits.
 *
 *  ⛔ THE CLOCK IS THE POINT OF THIS FILE. `store.test.ts` builds its store with
 *  `now: () => tick++`, so every event there lands on its OWN millisecond and a
 *  cursor keyed on `created_at` alone would pass every test in it. The bug this
 *  feature can actually ship is the TIE: several events in one millisecond (one
 *  transaction, one batch), where `> at` silently drops the losers and `>= at`
 *  replays them forever. So the clock here is HELD STILL on purpose, and the tie
 *  case is driven rather than hoped for. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RecordsContractError,
  type RecordsExecutionBinding,
  type RecordsPackRef,
  type RecordsSchemaSnapshot,
} from '@recued/contracts';

import { createRecordsStore, type RecordsStore } from '../store.js';
import { createSavedDataViewStore } from '../../saved-data-view-store.js';

const OWNER = { publisher: 'publisher-a', pack_slug: 'change-feed' } as const;
const STORAGE_HASH = 'a'.repeat(64);
const DECLARATION_HASH = 'b'.repeat(64);

const entityFields: RecordsSchemaSnapshot['entities'][string]['fields'] = [
  { key: 'id', slot: 'pk', kind: 'id', required: true, privacy: 'external_id' },
  { key: 'title', slot: 's1', kind: 'string', required: true, privacy: 'content' },
  { key: 'status', slot: 's2', kind: 'string', required: true },
  { key: 'amount', slot: 'dec1', kind: 'decimal', required: true },
  { key: 'identity.customer', slot: 's3', kind: 'string', required: true },
];

const schema: RecordsSchemaSnapshot = {
  decimal_scale: 4,
  entities: {
    job: { kind: 'job', fields: entityFields },
    draft: { kind: 'draft', fields: entityFields },
  },
};

const bind = (
  action: RecordsExecutionBinding['action'],
  extra: Partial<RecordsExecutionBinding> = {},
): RecordsExecutionBinding => ({
  kind: 'core.records',
  action,
  entity: 'job',
  owner: OWNER,
  pack_version: 1,
  storage_schema_hash: STORAGE_HASH,
  declaration_hash: DECLARATION_HASH,
  operation_digest: `${OWNER.publisher}:${action}`,
  ...extra,
});

const bindings = {
  create: bind('create', { natural_key: ['identity.customer'] }),
  draftCreate: bind('create', {
    entity: 'draft',
    operation_digest: `${OWNER.publisher}:create-draft`,
  }),
  update: bind('update'),
};

const values = (customer: string, amount = '9.00'): Record<string, unknown> => ({
  title: 'Launch',
  status: 'open',
  amount,
  identity: { customer },
});

describe('records change feed (P2/F2)', () => {
  let db: Database.Database;
  let store: RecordsStore;
  /** Held still by default — see the file header. Tests advance it explicitly. */
  let clock = 1_800_000_000_000;

  const create = (customer: string): string => (store.execute({
    binding: bindings.create,
    args: { values: values(customer) },
    principal: 'owner',
  }) as { record: { id: string } }).record.id;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    clock = 1_800_000_000_000;
    store = createRecordsStore(db, { now: () => clock });
    store.installNamespace({
      owner: OWNER,
      version: 1,
      storage_schema_hash: STORAGE_HASH,
      declaration_hash: DECLARATION_HASH,
      artifact_digest: 'artifact:change-feed',
      schema,
      bindings,
    });
  });

  afterEach(() => db.close());

  it('pages chronologically and resumes exactly where the cursor left off', () => {
    clock = 1_000; create('c1');
    clock = 2_000; create('c2');
    clock = 3_000; create('c3');

    const first = store.listChanges({ owner: OWNER, limit: 2 });
    expect(first.changes).toHaveLength(2);
    expect(first.has_more).toBe(true);
    expect(first.changes.map((c) => c.created_at)).toEqual([1_000, 2_000]);

    const second = store.listChanges({ owner: OWNER, after: first.next, limit: 2 });
    expect(second.changes.map((c) => c.created_at)).toEqual([3_000]);
    expect(second.has_more).toBe(false);
  });

  /** ⛔ THE REGRESSION THIS FEATURE EXISTS TO NOT HAVE.
   *
   *  Three events on ONE millisecond, read one at a time. A cursor of
   *  `created_at` alone gives two wrong answers here and no third option:
   *  `> at` returns nothing after the first page (two changes lost forever,
   *  silently), `>= at` returns the same row every call (the reviewer never
   *  advances). Only the `(created_at, event_id)` pair walks all three exactly
   *  once — which is what this asserts, by IDENTITY and by COUNT. */
  it('neither skips nor replays events that share a millisecond', () => {
    clock = 5_000;
    create('tie-a');
    create('tie-b');
    create('tie-c');
    expect(store.listChanges({ owner: OWNER }).changes.map((c) => c.created_at))
      .toEqual([5_000, 5_000, 5_000]);

    const seen: string[] = [];
    let cursor = store.listChanges({ owner: OWNER, limit: 1 });
    seen.push(...cursor.changes.map((c) => c.event_id));
    while (cursor.has_more) {
      cursor = store.listChanges({ owner: OWNER, after: cursor.next, limit: 1 });
      seen.push(...cursor.changes.map((c) => c.event_id));
    }

    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });

  it('reports has_more exactly, not "the page came back full"', () => {
    clock = 1_000; create('c1');
    clock = 2_000; create('c2');
    // Exactly `limit` rows exist. Inferring has_more from `length === limit`
    // would send the reader round again for an empty page.
    const page = store.listChanges({ owner: OWNER, limit: 2 });
    expect(page.changes).toHaveLength(2);
    expect(page.has_more).toBe(false);
  });

  it('omits next on an empty page so the caller keeps its watermark', () => {
    clock = 1_000; create('c1');
    const caughtUp = store.listChanges({ owner: OWNER });
    const empty = store.listChanges({ owner: OWNER, after: caughtUp.next });

    expect(empty.changes).toEqual([]);
    expect(empty.has_more).toBe(false);
    // Absent, NOT a reset-to-zero cursor: a caller that stored `next` blindly
    // would otherwise re-show its whole history the next time anything changed.
    expect(empty.next).toBeUndefined();
  });

  it('filters to one entity', () => {
    clock = 1_000; create('c1');
    clock = 2_000;
    store.execute({
      binding: bindings.draftCreate,
      args: { id: 'draft-1', values: values('c2') },
      principal: 'owner',
    });

    const jobs = store.listChanges({ owner: OWNER, entity: 'job' });
    expect(jobs.changes.map((c) => c.entity)).toEqual(['job']);
    expect(store.listChanges({ owner: OWNER }).changes).toHaveLength(2);
  });

  /** A change LANDED whether or not its notification reached a subscriber.
   *  Asserting the status is genuinely `pending` first is what stops this
   *  degenerating into "the feed returned the rows it returned". */
  it('includes changes whose notification was never delivered', () => {
    clock = 1_000; create('c1');
    expect(store.listOutbox(OWNER, 'pending')).toHaveLength(1);
    expect(store.listOutbox(OWNER, 'delivered')).toHaveLength(0);

    expect(store.listChanges({ owner: OWNER }).changes).toHaveLength(1);
  });

  it('carries the changed field names on an update', () => {
    clock = 1_000;
    const id = create('c1');
    clock = 2_000;
    store.execute({
      binding: bindings.update,
      args: {
        id, expected_version: 1, expected_revision: 0,
        set: { amount: '11.00' }, unset: [],
      },
      principal: 'owner',
    });

    const updates = store.listChanges({ owner: OWNER }).changes
      .filter((c) => c.type === 'record.updated');
    expect(updates).toHaveLength(1);
    expect(updates[0]!.changed_fields).toContain('amount');
  });

  /** ⛔ THE JOIN, which neither half's own suite can reach. `change-feed` proves
   *  the cursor walks; `saved-data-view-store` proves the mark stores. Both stay
   *  green if the two shapes disagree — if the store persisted, say, a bare
   *  timestamp, or the feed expected a different key. The only thing that
   *  catches that is feeding one's OUTPUT to the other as INPUT, which is what
   *  this does: the cursor handed to the view is the exact object later handed
   *  back to `listChanges`. */
  it('feeds its own cursor through a saved view and back, seeing each change once', () => {
    const views = createSavedDataViewStore(db);
    const view = views.create({
      name: 'Orders',
      definition: { tab: 'records', owner: OWNER, entity: 'job' },
    });

    clock = 1_000; create('c1');
    clock = 2_000; create('c2');

    const unreviewed = store.listChanges({ owner: OWNER });
    expect(unreviewed.changes).toHaveLength(2);

    // Mark reviewed at exactly what was shown — the server never stamps "now".
    const marked = views.update({
      id: view.id, expected_revision: view.revision, review: unreviewed.next,
    });

    // Nothing new since: the owner is caught up.
    expect(store.listChanges({
      owner: OWNER, after: marked.review!.reviewed_through,
    }).changes).toEqual([]);

    clock = 3_000; create('c3');
    const since = store.listChanges({ owner: OWNER, after: marked.review!.reviewed_through });
    expect(since.changes.map((c) => c.created_at)).toEqual([3_000]);
  });

  it('refuses a limit outside 1..500 and a malformed cursor', () => {
    expect(() => store.listChanges({ owner: OWNER, limit: 0 }))
      .toThrow(RecordsContractError);
    expect(() => store.listChanges({ owner: OWNER, limit: 501 }))
      .toThrow(RecordsContractError);
    expect(() => store.listChanges({
      owner: OWNER,
      after: { at: -1, event_id: 'e' },
    })).toThrow(RecordsContractError);
    expect(() => store.listChanges({
      owner: OWNER,
      after: { at: 1, event_id: '' },
    })).toThrow(RecordsContractError);
  });
});
