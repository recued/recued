import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RecordsContractError,
  type RecordsExecutionBinding,
  type RecordsPackRef,
  type RecordsSchemaSnapshot,
} from '@recued/contracts';
import { recordsCatalogSlug } from '@recued/ingredient-authoring';

import { createRecordsStore, RECORDS_TABLES, type RecordsStore } from '../store.js';

const OWNER = { publisher: 'publisher-a', pack_slug: 'same-slug' } as const;
const OTHER = { publisher: 'publisher-b', pack_slug: 'same-slug' } as const;
const STORAGE_HASH = 'a'.repeat(64);
const DECLARATION_HASH = 'b'.repeat(64);
const entityFields: RecordsSchemaSnapshot['entities'][string]['fields'] = [
  { key: 'id', slot: 'pk', kind: 'id', required: true, privacy: 'external_id' },
  { key: 'title', slot: 's1', kind: 'string', required: true, privacy: 'content' },
  { key: 'status', slot: 's2', kind: 'string', required: true },
  { key: 'amount', slot: 'dec1', kind: 'decimal', required: true },
  { key: 'score', slot: 'n1', kind: 'number', required: true },
  { key: 'started_on', slot: 'd1', kind: 'date', required: true },
  { key: 'due_at', slot: 'dt1', kind: 'datetime', required: false },
  { key: 'active', slot: 'b1', kind: 'boolean', required: true },
  { key: 'note', slot: 't1', kind: 'text', required: false },
  { key: 'parent', slot: 'r1', kind: 'ref', required: false },
  { key: 'identity.customer', slot: 's3', kind: 'string', required: true },
];

const schema: RecordsSchemaSnapshot = {
  decimal_scale: 4,
  entities: {
    // `job` is the natural_key entity: its id is DERIVED, so no bind on it may
    // seat a row at a caller-chosen id.
    job: { kind: 'job', fields: entityFields },
    // `draft` is the same shape with no natural_key, which is where the
    // caller-supplied-id paths (`explicit` create, `upsert`) legally live.
    // Keeping them on `job` would model a pack the authoring validator refuses.
    draft: { kind: 'draft', fields: entityFields },
  },
};

const bind = (
  action: RecordsExecutionBinding['action'],
  owner: RecordsPackRef = OWNER,
  extra: Partial<RecordsExecutionBinding> = {},
): RecordsExecutionBinding => ({
  kind: 'core.records',
  action,
  entity: 'job',
  owner,
  pack_version: 1,
  storage_schema_hash: STORAGE_HASH,
  declaration_hash: DECLARATION_HASH,
  operation_digest: `${owner.publisher}:${action}`,
  ...extra,
});

const bindings = (owner: RecordsPackRef = OWNER): Record<string, RecordsExecutionBinding> => ({
  create: bind('create', owner, { natural_key: ['identity.customer'] }),
  explicit: bind('create', owner, {
    entity: 'draft',
    operation_digest: `${owner.publisher}:create-explicit`,
  }),
  get: bind('get', owner),
  many: bind('get_many', owner),
  search: bind('search', owner, {
    filter_fields: ['status', 'amount', 'parent'],
    sort_fields: ['amount', 'due_at', '_record.updated_at'],
  }),
  count: bind('count', owner, { filter_fields: ['status', 'amount', 'parent'] }),
  update: bind('update', owner),
  upsert: bind('upsert', owner, {
    entity: 'draft',
    operation_digest: `${owner.publisher}:upsert-draft`,
  }),
  delete: bind('delete', owner),
});

const install = (store: RecordsStore, owner: RecordsPackRef = OWNER): void => {
  store.installNamespace({
    owner,
    version: 1,
    storage_schema_hash: STORAGE_HASH,
    declaration_hash: DECLARATION_HASH,
    artifact_digest: `artifact:${owner.publisher}`,
    schema,
    bindings: bindings(owner),
  });
};

const values = (customer: string, amount = '9.00'): Record<string, unknown> => ({
  title: 'Launch',
  status: 'open',
  amount,
  score: 0.07,
  started_on: '0001-01-01',
  due_at: '2026-08-05T10:00:00-07:00',
  active: true,
  note: null,
  parent: null,
  identity: { customer },
});

describe('D-221 fixed Records store', () => {
  let db: Database.Database;
  let store: RecordsStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    let tick = 1_800_000_000_000;
    store = createRecordsStore(db, { now: () => tick++ });
    install(store);
  });

  afterEach(() => db.close());

  it('keeps same-slug publishers isolated and enforces stamped readiness', () => {
    install(store, OTHER);
    const created = store.execute({
      binding: bindings().create,
      args: { values: values('customer-1') },
      principal: 'owner',
    }) as { record: { id: string } };
    expect(created.record.id).toMatch(/^nk_/);

    expect(store.execute({
      binding: bindings(OTHER).get,
      args: { id: created.record.id },
      principal: 'owner',
    })).toEqual({ record: null });

    expect(() => store.execute({
      binding: { ...bindings().get, owner: OTHER },
      args: { id: created.record.id },
      principal: 'owner',
    })).toThrowError(RecordsContractError);
  });

  it('recognizes raw and lowered installed operation identity even while incoherent', async () => {
    const catalog = await recordsCatalogSlug(OWNER);
    expect(store.isInstalledOperationId('publisher-a.same-slug.create')).toBe(true);
    expect(store.isInstalledCatalogOperation(catalog, 'create')).toBe(true);
    expect(store.isInstalledCatalogOperation(catalog, 'missing')).toBe(false);

    db.prepare(`UPDATE ${RECORDS_TABLES.namespaces} SET row_count=1
      WHERE publisher=? AND pack_slug=?`).run(OWNER.publisher, OWNER.pack_slug);
    expect(store.auditAccounting(OWNER).coherent).toBe(false);
    expect(store.getNamespace(OWNER)?.state.state).toBe('incoherent');
    expect(store.isInstalledOperationId('publisher-a.same-slug.create')).toBe(true);
    expect(store.isInstalledCatalogOperation(catalog, 'create')).toBe(true);
  });

  it('fences new starts and drains namespace leases including foreign-pack callers', async () => {
    const lease = store.acquireExecutionLease({
      lease_id: 'run-from-pack-b',
      recipe_id: 'pack-b-read-then-send',
      caller_pack: 'publisher-b/automation',
      targets: [{ binding: bindings().get }],
    });
    const namespace = store.getNamespace(OWNER)!;
    const fence = store.fenceNamespace({
      owner: OWNER,
      expected_activation_generation: namespace.activation_generation,
    });
    await expect(store.waitForNamespaceQuiescence({ ...fence, timeout_ms: 0 }))
      .resolves.toEqual({
        drained: false,
        blockers: [{
          lease_id: 'run-from-pack-b',
          recipe_id: 'pack-b-read-then-send',
          caller_pack: 'publisher-b/automation',
        }],
      });
    expect(() => store.acquireExecutionLease({
      lease_id: 'new-run',
      recipe_id: 'new-run',
      caller_pack: 'publisher-a/same-slug',
      targets: [{ binding: bindings().get }],
    })).toThrow(/fenced/);
    expect(() => store.execute({
      binding: bindings().get,
      args: { id: 'missing' },
      principal: 'owner',
    })).toThrow(/fenced/);
    expect(store.execute({
      binding: bindings().get,
      args: { id: 'missing' },
      principal: 'owner',
      execution_lease_id: lease.lease_id,
    })).toEqual({ record: null });

    lease.release();
    await expect(store.waitForNamespaceQuiescence({ ...fence, timeout_ms: 10 }))
      .resolves.toEqual({ drained: true, blockers: [] });
    store.releaseNamespaceFence(fence);
  });

  it('derives natural keys, replays equal content, and rejects immutable edits', () => {
    const first = store.execute({ binding: bindings().create, args: { values: values('c-1') }, principal: 'owner' }) as {
      record: { id: string; amount: string; score: number; started_on: string; due_at: string; active: boolean; _record: { revision: number } };
      replayed: boolean;
    };
    const replay = store.execute({ binding: bindings().create, args: { values: values('c-1') }, principal: 'owner' }) as typeof first;
    expect(replay).toEqual({ ...first, replayed: true });
    expect(first.record.amount).toBe('9.0000');
    expect(first.record.score).toBe(0.07);
    expect(first.record.started_on).toBe('0001-01-01');
    expect(first.record.due_at).toBe('2026-08-05T17:00:00.000Z');
    expect(first.record.active).toBe(true);

    expect(() => store.execute({
      binding: bindings().update,
      args: {
        id: first.record.id,
        expected_version: 1,
        expected_revision: 0,
        set: { identity: { customer: 'c-2' } },
        unset: [],
      },
      principal: 'owner',
    })).toThrow(/immutable/);
    expect(store.getNamespace(OWNER)?.quota).toMatchObject({ row_count: 1, outbox_count: 1 });
  });

  it('collapses -0 so an exact replay stays a replay and 0 -> -0 stays a no-op', () => {
    // SQLite reads -0 back as +0, while replay-equality and the update no-op
    // check both use `Object.is`. Persisting -0 therefore made an IDENTICAL
    // create retry read as a different row, and made a change the store cannot
    // even represent read as a real edit — a revision bump and a watcher event.
    const negative = { ...values('neg'), score: -0 };
    const first = store.execute({
      binding: bindings().create, args: { values: negative }, principal: 'owner',
    }) as { record: { id: string; score: number }; replayed: boolean };
    expect(first.replayed).toBe(false);
    expect(Object.is(first.record.score, -0)).toBe(false);
    expect(store.execute({
      binding: bindings().create, args: { values: negative }, principal: 'owner',
    })).toMatchObject({ replayed: true, record: { id: first.record.id } });

    expect(() => store.execute({
      binding: bindings().update,
      args: {
        id: first.record.id,
        expected_version: 1,
        expected_revision: 0,
        set: { score: -0 },
        unset: [],
      },
      principal: 'owner',
    })).toThrow(/no effective change/);
    // The permitting case: a genuinely different number still updates, so this
    // is -0 collapsing rather than the number path refusing edits.
    expect(store.execute({
      binding: bindings().update,
      args: {
        id: first.record.id,
        expected_version: 1,
        expected_revision: 0,
        set: { score: 1.5 },
        unset: [],
      },
      principal: 'owner',
    })).toMatchObject({ record: { score: 1.5, _record: { revision: 1 } } });
  });

  it('refuses install-newer-then-older over RETAINED rows, and names exits that work', () => {
    // Uninstall retains by default, so the ordinary
    // install v3 → uninstall → install v2 path meets a namespace that is
    // `orphaned` at `last_version: 3` with its rows still there. The refusal is
    // right — those rows describe an epoch v2 does not know — but a refusal that
    // names only the pack author's exit reads as a dead end to the owner.
    const atVersion = (
      version: number,
      source: Record<string, RecordsExecutionBinding> = bindings(),
    ): Record<string, RecordsExecutionBinding> => Object.fromEntries(
      Object.entries(source).map(([key, value]) => [key, { ...value, pack_version: version }]),
    );
    const installAt = (version: number): unknown => store.installNamespace({
      owner: OWNER,
      version,
      storage_schema_hash: STORAGE_HASH,
      declaration_hash: DECLARATION_HASH,
      artifact_digest: `artifact:${OWNER.publisher}:v${version}`,
      schema,
      bindings: atVersion(version),
    });

    installAt(3);
    store.execute({
      binding: { ...bindings().create, pack_version: 3 },
      args: { values: values('retained') },
      principal: 'owner',
    });
    store.orphanNamespace(OWNER);
    expect(store.getNamespace(OWNER)?.state)
      .toMatchObject({ state: 'orphaned', last_version: 3 });

    let refusal: RecordsContractError | undefined;
    try { installAt(2); } catch (error) { refusal = error as RecordsContractError; }
    expect(refusal, 'installing v2 over retained v3 rows must refuse').toBeDefined();
    expect(refusal!.code).toBe('records_conflict');
    // The two versions are carried STRUCTURALLY, so a surface can render the
    // choice without parsing the sentence.
    expect(refusal!.details).toMatchObject({ retained_version: 3, requested_version: 2 });
    // The owner's own exit must be named, not just the pack author's.
    expect(refusal!.message).toMatch(/export and purge/);
    expect(refusal!.message).toMatch(/Install v3 or later/);
    // A refusal that mutated would be no refusal: the rows are the whole point.
    expect(store.getNamespace(OWNER)?.state)
      .toMatchObject({ state: 'orphaned', last_version: 3 });
    expect(store.getNamespace(OWNER)?.quota.row_count).toBe(1);

    // Exit 1 — reinstall at the retained version adopts the rows.
    installAt(3);
    expect(store.getNamespace(OWNER)?.state).toMatchObject({ state: 'ready', version: 3 });
    expect(store.getNamespace(OWNER)?.quota.row_count).toBe(1);

    // Exit 2 — export, purge, then the SAME v2 install succeeds on empty
    // storage. Without this the message would be advertising an exit nobody has
    // walked, which is the shape of advice that turns out to be wrong.
    const exported = store.exportNamespace(OWNER);
    expect(Object.values(exported.records).flat()).toHaveLength(1);
    store.orphanNamespace(OWNER);
    store.purgeNamespace(OWNER, `${OWNER.publisher}/${OWNER.pack_slug}`);
    expect(store.getNamespace(OWNER)).toBeNull();
    installAt(2);
    expect(store.getNamespace(OWNER)?.state).toMatchObject({ state: 'ready', version: 2 });
    expect(store.getNamespace(OWNER)?.quota.row_count).toBe(0);
  });

  it('refuses a natural_key change on a SAME-version reinstall, which reaches no coordinator', () => {
    // The migration coordinator — and therefore the upgrade authority's rekey
    // check — only runs when the VERSION moves. A same-version activation
    // replacement swaps bindings directly, so v1-over-v1 with a new key skipped
    // every other gate: the legacy row survived at its caller-chosen id and the
    // next create of that tuple seated a second row beside it.
    store.execute({
      binding: bindings().explicit,
      args: { id: 'legacy-id', values: values('c-1') },
      principal: 'owner',
    });
    const rekeyed = {
      ...bindings(),
      explicit: bind('create', OWNER, {
        entity: 'draft',
        natural_key: ['identity.customer'],
        operation_digest: `${OWNER.publisher}:create-explicit`,
      }),
    };
    const sameVersion = {
      owner: OWNER,
      version: 1,
      storage_schema_hash: STORAGE_HASH,
      declaration_hash: DECLARATION_HASH,
      artifact_digest: `artifact:${OWNER.publisher}:reinstall`,
      schema,
    };
    let refusal: RecordsContractError | undefined;
    try { store.installNamespace({ ...sameVersion, bindings: rekeyed }); }
    catch (error) { refusal = error as RecordsContractError; }
    expect(refusal, 'a same-version rekey must refuse').toBeDefined();
    expect(refusal!.code).toBe('records_conflict');
    expect(refusal!.details).toMatchObject({ rekeyed_entities: ['draft'] });
    expect(refusal!.message).toMatch(/no mapping that rewrites a primary key/);
    // Refused before the swap: the row is still where it was.
    expect(store.getNamespace(OWNER)?.quota.row_count).toBe(1);

    // Permitting: the same reinstall with the key UNCHANGED still succeeds, so
    // this refuses a rekey and not activation replacement itself.
    expect(store.installNamespace({ ...sameVersion, bindings: bindings() }))
      .toMatchObject({ owner: OWNER });
    // And rekeying a kind with NO rows is admitted — `job` is empty here.
    expect(store.installNamespace({
      ...sameVersion,
      bindings: {
        ...bindings(),
        create: bind('create', OWNER, {
          natural_key: ['identity.customer', 'status'],
          operation_digest: `${OWNER.publisher}:create`,
        }),
      },
    })).toMatchObject({ owner: OWNER });
  });

  it('refuses an unpaired surrogate, which SQLite would store as a different value', () => {
    // A lone surrogate passes a JS type + byte-length check but cannot survive
    // UTF-8: SQLite stores U+FFFD. Two distinct inputs then read back IDENTICAL
    // while having hashed to different natural ids — uniqueness defeated — and
    // an exact retry of the first write conflicts instead of replaying.
    for (const bad of ['\uD800', 'a\uD800b', '\uDC00', 'a\uDFFFb']) {
      expect(() => store.execute({
        binding: bindings().create,
        args: { values: { ...values('c-1'), title: bad } },
        principal: 'owner',
      }), bad).toThrow(/unpaired UTF-16 surrogate/);
      expect(() => store.execute({
        binding: bindings().explicit,
        args: { id: bad, values: values('c-2') },
        principal: 'owner',
      }), bad).toThrow(/unpaired UTF-16 surrogate/);
      expect(() => store.execute({
        binding: bindings().create,
        args: { values: { ...values('c-3'), note: bad } },
        principal: 'owner',
      }), bad).toThrow(/unpaired UTF-16 surrogate/);
    }
    // Permitting: a well-formed astral pair — the same code units, correctly
    // paired — round-trips, so this refuses malformed UTF-16 and not non-BMP text.
    const emoji = '\u{1F600} ok';
    const created = store.execute({
      binding: bindings().create,
      args: { values: { ...values('c-9'), title: emoji } },
      principal: 'owner',
    }) as { record: { id: string; title: string } };
    expect(created.record.title).toBe(emoji);
    expect(store.execute({
      binding: bindings().get, args: { id: created.record.id }, principal: 'owner',
    })).toMatchObject({ record: { title: emoji } });
  });

  it('prefix matches a value that continues past U+10FFFF', () => {
    // The bound was `prefix + U+10FFFF`, which is itself a string WITH that
    // prefix — so anything continuing past it sorts above the bound and was
    // excluded despite `startsWith` being true.
    const stored: string[] = [];
    for (const [suffix, customer] of [
      ['\u{10FFFF}tail', 'p-1'], ['plain', 'p-2'], ['\u{10FFFF}', 'p-3'],
    ] as const) {
      const row = store.execute({
        binding: bindings().explicit,
        args: { id: `pfx-${customer}`, values: { ...values(customer), status: `x${suffix}` } },
        principal: 'owner',
      }) as { record: { id: string } };
      stored.push(row.record.id);
    }
    const draftSearch = bind('search', OWNER, {
      entity: 'draft',
      filter_fields: ['status'],
      operation_digest: `${OWNER.publisher}:search-draft`,
    });
    db.exec(`DELETE FROM ${RECORDS_TABLES.namespaces}`);
    store.installNamespace({
      owner: OWNER,
      version: 1,
      storage_schema_hash: STORAGE_HASH,
      declaration_hash: DECLARATION_HASH,
      artifact_digest: `artifact:${OWNER.publisher}`,
      schema,
      bindings: { ...bindings(), draftSearch },
    });
    const found = store.execute({
      binding: draftSearch,
      args: { filters: { status: { op: 'prefix', value: 'x' } } },
      principal: 'owner',
    }) as { records: Array<{ id: string }> };
    expect(found.records.map((record) => record.id).sort()).toEqual([...stored].sort());
    // Permitting: the prefix still EXCLUDES a non-match, so this widened the
    // upper bound rather than dropping it.
    const narrow = store.execute({
      binding: draftSearch,
      args: { filters: { status: { op: 'prefix', value: 'xp' } } },
      principal: 'owner',
    }) as { records: Array<{ id: string }> };
    expect(narrow.records).toHaveLength(1);
  });

  it('invalidates outstanding cursors on activation replacement, and expires them', () => {
    // Its own store: this installs TWICE, and the shared fixture's outbox rows
    // would make the second activation's retirement accounting disagree.
    const ownDb = new Database(':memory:');
    ownDb.pragma('foreign_keys = ON');
    let clock = 1_800_000_000_000;
    const own = createRecordsStore(ownDb, { now: () => clock++ });
    const draftSearch = bind('search', OWNER, {
      entity: 'draft',
      sort_fields: ['amount'],
      operation_digest: `${OWNER.publisher}:search-draft`,
    });
    const installInput = {
      owner: OWNER,
      version: 1,
      storage_schema_hash: STORAGE_HASH,
      declaration_hash: DECLARATION_HASH,
      artifact_digest: `artifact:${OWNER.publisher}`,
      schema,
      bindings: { ...bindings(), draftSearch },
    };
    own.installNamespace(installInput);
    for (const customer of ['c-1', 'c-2', 'c-3']) {
      own.execute({
        binding: bindings().explicit,
        args: { id: `row-${customer}`, values: values(customer) },
        principal: 'owner',
      });
    }
    const page = own.execute({
      binding: draftSearch, args: { sort: 'amount', limit: 1 }, principal: 'owner',
    }) as { next_cursor: string };
    expect(page.next_cursor).toBeDefined();
    // Permitting: the handle pages before anything invalidates it.
    expect((own.execute({
      binding: draftSearch,
      args: { sort: 'amount', limit: 1, cursor: page.next_cursor },
      principal: 'owner',
    }) as { records: unknown[] }).records).toHaveLength(1);

    // An activation replacement moves the generation the boundary was taken in,
    // so the handle is DROPPED rather than compared against.
    own.installNamespace({
      ...installInput,
      artifact_digest: `artifact:${OWNER.publisher}:again`,
      expected_state_generation: own.getNamespace(OWNER)!.state_generation,
    });
    expect(() => own.execute({
      binding: draftSearch,
      args: { sort: 'amount', limit: 1, cursor: page.next_cursor },
      principal: 'owner',
    })).toThrow(/unknown or expired/);

    // A handle older than the TTL refuses too — bounded, where a signed payload
    // lived forever.
    const fresh = own.execute({
      binding: draftSearch, args: { sort: 'amount', limit: 1 }, principal: 'owner',
    }) as { next_cursor: string };
    ownDb.prepare(`UPDATE core_record_cursors SET created_at=? WHERE token=?`)
      .run(clock - (25 * 60 * 60 * 1000), fresh.next_cursor);
    expect(() => own.execute({
      binding: draftSearch,
      args: { sort: 'amount', limit: 1, cursor: fresh.next_cursor },
      principal: 'owner',
    })).toThrow(/unknown or expired/);
    ownDb.close();
  });

  it('cursor rows are durable, so they are swept globally and never orphaned', () => {
    // `core_record_cursors` is an ordinary durable table. The first sweep only
    // ran for whichever namespace was minting, so a pack that paged once and
    // stopped kept its rows indefinitely — unmanaged growth nobody would notice.
    const ownDb = new Database(':memory:');
    ownDb.pragma('foreign_keys = ON');
    let clock = 1_800_000_000_000;
    const mk = () => createRecordsStore(ownDb, { now: () => clock++ });
    let own = mk();
    const draftSearch = bind('search', OWNER, {
      entity: 'draft',
      sort_fields: ['amount'],
      operation_digest: `${OWNER.publisher}:search-draft`,
    });
    const other = { publisher: 'publisher-b', pack_slug: 'busy' } as const;
    const otherSearch = bind('search', other, {
      entity: 'draft',
      sort_fields: ['amount'],
      operation_digest: `${other.publisher}:search-draft`,
    });
    for (const [owner, search] of [[OWNER, draftSearch], [other, otherSearch]] as const) {
      own.installNamespace({
        owner,
        version: 1,
        storage_schema_hash: STORAGE_HASH,
        declaration_hash: DECLARATION_HASH,
        artifact_digest: `artifact:${owner.publisher}`,
        schema,
        bindings: { ...bindings(owner), search2: search },
      });
      for (const customer of ['c-1', 'c-2']) {
        own.execute({
          binding: bind('create', owner, {
            entity: 'draft',
            operation_digest: `${owner.publisher}:create-explicit`,
          }),
          args: { id: `row-${customer}`, values: values(customer) },
          principal: 'owner',
        });
      }
      own.execute({ binding: search, args: { sort: 'amount', limit: 1 }, principal: 'owner' });
    }
    const count = (): number => (ownDb.prepare(
      `SELECT count(*) AS n FROM ${RECORDS_TABLES.cursors}`,
    ).get() as { n: number }).n;
    expect(count()).toBe(2);

    // Age the ABANDONED namespace's cursor past the TTL and page only the other
    // one. A per-namespace sweep would leave the abandoned row forever.
    ownDb.prepare(`UPDATE ${RECORDS_TABLES.cursors} SET created_at=? WHERE publisher=?`)
      .run(clock - (25 * 60 * 60 * 1000), OWNER.publisher);
    own.execute({ binding: otherSearch, args: { sort: 'amount', limit: 1 }, principal: 'owner' });
    const ownedBy = (publisher: string): number => (ownDb.prepare(
      `SELECT count(*) AS n FROM ${RECORDS_TABLES.cursors} WHERE publisher=?`,
    ).get(publisher) as { n: number }).n;
    expect(ownedBy(OWNER.publisher), 'the abandoned namespace must age out too').toBe(0);
    expect(ownedBy(other.publisher), "the busy namespace keeps its own").toBeGreaterThan(0);

    // And with NOTHING paging, constructing the store sweeps once.
    ownDb.prepare(`UPDATE ${RECORDS_TABLES.cursors} SET created_at=?`)
      .run(clock - (25 * 60 * 60 * 1000));
    own = mk();
    expect(count(), 'boot must converge an idle server to empty').toBe(0);

    // Permitting: a live cursor is NOT swept by a neighbour's activity, so this
    // ages rows out rather than clearing the table opportunistically.
    const live = own.execute({
      binding: draftSearch, args: { sort: 'amount', limit: 1 }, principal: 'owner',
    }) as { next_cursor: string };
    own.execute({ binding: otherSearch, args: { sort: 'amount', limit: 1 }, principal: 'owner' });
    expect((own.execute({
      binding: draftSearch,
      args: { sort: 'amount', limit: 1, cursor: live.next_cursor },
      principal: 'owner',
    }) as { records: unknown[] }).records).toHaveLength(1);

    // Namespace teardown takes its cursors with it, so nothing outlives its owner.
    own.orphanNamespace(OWNER);
    own.purgeNamespace(OWNER, `${OWNER.publisher}/${OWNER.pack_slug}`);
    expect((ownDb.prepare(
      `SELECT count(*) AS n FROM ${RECORDS_TABLES.cursors} WHERE publisher=?`,
    ).get(OWNER.publisher) as { n: number }).n).toBe(0);
    ownDb.close();
  });

  it('returns get_many misses under the contracted `missing` key', () => {
    const created = store.execute({
      binding: bindings().create, args: { values: values('gm') }, principal: 'owner',
    }) as { record: { id: string } };
    const result = store.execute({
      binding: bindings().many,
      args: { ids: [created.record.id, 'absent'] },
      principal: 'owner',
    }) as Record<string, unknown>;
    // § 6.7 and both authoring guides promise `{ records, missing }`. It shipped
    // as `missing_ids`, so a conforming recipe read `undefined`.
    expect(Object.keys(result).sort()).toEqual(['missing', 'records']);
    expect(result.missing).toEqual(['absent']);
  });

  it('derives the key from the ENTITY, so no sibling bind can seat a second row on one tuple', () => {
    // `natural_key` is admissible only on `create`, so keying the derivation
    // off the DISPATCHED bind leaves every sibling bind on the same entity free
    // to choose an id — which turns uniqueness back into a convention. Authoring
    // now refuses this bind set, so it has to be installed directly: the store
    // is the floor for a namespace that predates that refusal.
    const siblingCreate = bind('create', OWNER, {
      operation_digest: `${OWNER.publisher}:create-unkeyed-job`,
    });
    const siblingUpsert = bind('upsert', OWNER, {
      operation_digest: `${OWNER.publisher}:upsert-job`,
    });
    const rekeyedCreate = bind('create', OWNER, {
      natural_key: ['status'],
      operation_digest: `${OWNER.publisher}:create-rekeyed`,
    });
    db.exec(`DELETE FROM ${RECORDS_TABLES.namespaces}`);
    store.installNamespace({
      owner: OWNER,
      version: 1,
      storage_schema_hash: STORAGE_HASH,
      declaration_hash: DECLARATION_HASH,
      artifact_digest: `artifact:${OWNER.publisher}`,
      schema,
      bindings: {
        ...bindings(OWNER),
        siblingCreate,
        siblingUpsert,
        rekeyedCreate,
      },
    });

    const keyed = store.execute({
      binding: bindings().create,
      args: { values: values('c-1') },
      principal: 'owner',
    }) as { record: { id: string } };
    expect(keyed.record.id).toMatch(/^nk_[0-9a-f]{64}$/);

    // The same tuple through each sibling, with a caller-chosen id.
    expect(() => store.execute({
      binding: siblingCreate,
      args: { id: 'caller-chosen', values: values('c-1') },
      principal: 'owner',
    })).toThrow(/id is forbidden on a natural_key entity/);
    expect(() => store.execute({
      binding: siblingUpsert,
      args: { id: 'caller-chosen', expected_version: 1, values: values('c-1') },
      principal: 'owner',
    })).toThrow(/upsert is not admitted on natural_key entity 'job'/);
    // A bind whose key disagrees with the installed entity key cannot redefine it.
    expect(() => store.execute({
      binding: rekeyedCreate,
      args: { values: values('c-2') },
      principal: 'owner',
    })).toThrow(/disagrees with the installed entity key/);

    // The PERMITTING case: the keyed create still converges, and the unkeyed
    // sibling still works on the entity that has no key — so the refusals above
    // are a key guard, not a blanket create refusal.
    const replay = store.execute({
      binding: bindings().create,
      args: { values: values('c-1') },
      principal: 'owner',
    }) as { record: { id: string }; replayed: boolean };
    expect(replay).toMatchObject({ replayed: true, record: { id: keyed.record.id } });
    const unkeyed = store.execute({
      binding: bindings().explicit,
      args: { id: 'caller-chosen', values: values('c-1') },
      principal: 'owner',
    }) as { record: { id: string } };
    expect(unkeyed.record.id).toBe('caller-chosen');
    expect(store.getNamespace(OWNER)?.quota).toMatchObject({ row_count: 2 });
  });

  it('checks the namespace version before an upsert insert can mutate', () => {
    expect(() => store.execute({
      binding: bindings().upsert,
      args: { id: 'stale-upsert', expected_version: 2, values: values('stale') },
      principal: 'owner',
    })).toThrow(/stale Records version/);
    expect(store.getNamespace(OWNER)?.quota).toMatchObject({
      row_count: 0,
      payload_bytes: 0,
      outbox_count: 0,
      data_generation: 0,
    });

    const inserted = store.execute({
      binding: bindings().upsert,
      args: { id: 'current-upsert', expected_version: 1, values: values('current') },
      principal: 'owner',
    }) as { record: { id: string } };
    expect(inserted.record.id).toBe('current-upsert');
  });

  it('round-trips canonical self references and refuses unsafe scalar encodings before mutation', () => {
    const self = store.execute({
      binding: bindings().explicit,
      args: { id: 'a/b', values: { ...values('self'), parent: 'draft/a%2Fb' } },
      principal: 'owner',
    }) as { record: { parent: string } };
    expect(self.record.parent).toBe('draft/a%2Fb');

    const invalid = [
      { score: Number.POSITIVE_INFINITY },
      { score: Number.MAX_SAFE_INTEGER + 1 },
      { started_on: '2026-02-30' },
      { due_at: '2026-08-05T10:00:00' },
      { due_at: '2023-02-29T10:00:00Z' },
      { due_at: '2026-08-05T24:00:00Z' },
      { due_at: '2026-08-05T10:00:00+24:00' },
      { amount: '0.07000' },
      { amount: '1e2' },
      { title: 'x'.repeat(4 * 1024 + 1) },
      { parent: 'draft/%ZZ' },
      { parent: 'draft/missing' },
    ];
    for (const [index, override] of invalid.entries()) {
      expect(() => store.execute({
        binding: bindings().explicit,
        args: {
          id: `invalid-${index}`,
          values: { ...values(`invalid-${index}`), ...override },
        },
        principal: 'owner',
      })).toThrowError(RecordsContractError);
    }
    expect(() => store.execute({
      binding: bindings().explicit,
      args: { id: 'x'.repeat(513), values: values('overlong-id') },
      principal: 'owner',
    })).toThrowError(RecordsContractError);
    expect(store.getNamespace(OWNER)?.quota.row_count).toBe(1);
  });

  it('orders exact decimals, authenticates forward/back cursors, and reports missing get_many ids', () => {
    const ids = ['c9', 'c10', 'c11'].map((customer, idx) => {
      const amount = ['9.00', '10.00', '11.00'][idx];
      return (store.execute({
        binding: bindings().create,
        args: { values: values(customer, amount) },
        principal: 'owner',
      }) as { record: { id: string } }).record.id;
    });
    const page1 = store.execute({
      binding: bindings().search,
      args: { sort: 'amount', limit: 2 },
      principal: 'owner',
    }) as { records: Array<{ amount: string }>; next_cursor: string };
    expect(page1.records.map((row) => row.amount)).toEqual(['9.0000', '10.0000']);
    const page2 = store.execute({
      binding: bindings().search,
      args: { sort: 'amount', limit: 2, cursor: page1.next_cursor },
      principal: 'owner',
    }) as { records: Array<{ amount: string }>; prev_cursor: string };
    expect(page2.records.map((row) => row.amount)).toEqual(['11.0000']);
    const back = store.execute({
      binding: bindings().search,
      args: { sort: 'amount', limit: 2, cursor: page2.prev_cursor },
      principal: 'owner',
    }) as { records: Array<{ amount: string }> };
    expect(back.records.map((row) => row.amount)).toEqual(['9.0000', '10.0000']);
    // A modified handle names no issued cursor. Under the old signed-payload
    // cursor this was "authentication failed"; the intent — a tampered cursor
    // must not page — is the same, and now there is no payload to tamper with.
    expect(() => store.execute({
      binding: bindings().search,
      args: { sort: 'amount', limit: 2, cursor: `${page1.next_cursor.slice(0, -1)}x` },
      principal: 'owner',
    })).toThrow(/unknown or expired/);
    // ⛔ And the handle DISCLOSES nothing. The old cursor was base64url+HMAC —
    // integrity without confidentiality — so decoding it yielded the raw
    // boundary id and sort value, which is the id the egress aliaser had just
    // masked in the records beside it, and which D-222 §6 puts in a public URL.
    expect(page1.next_cursor).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const secret of ['9.0000', '10.0000', 'nk_', 'job', OWNER.publisher]) {
      expect(Buffer.from(page1.next_cursor, 'base64url').toString('utf8'), secret)
        .not.toContain(secret);
    }

    expect(store.execute({
      binding: bindings().many,
      args: { ids: [ids[0], 'missing'] },
      principal: 'owner',
    })).toMatchObject({ missing: ['missing'] });
    expect(() => store.execute({
      binding: bindings().many,
      args: { ids: [ids[0], ids[0]] },
      principal: 'owner',
    })).toThrow(/duplicate/);
  });

  it('binds cursors to the sort tuple so a deleted boundary does not invalidate the next page', () => {
    const rows = ['9.00', '10.00', '11.00'].map((amount, index) =>
      store.execute({
        binding: bindings().create,
        args: { values: values(`cursor-${index}`, amount) },
        principal: 'owner',
      }) as { record: { id: string; _record: { revision: number } } });
    const page = store.execute({
      binding: bindings().search,
      args: { sort: 'amount', limit: 2 },
      principal: 'owner',
    }) as { records: Array<{ amount: string }>; next_cursor: string };
    store.ownerDelete({
      owner: OWNER,
      entity: 'job',
      id: rows[1]!.record.id,
      expected_version: 1,
      expected_revision: rows[1]!.record._record.revision,
      principal: 'owner',
    });
    expect(store.execute({
      binding: bindings().search,
      args: { sort: 'amount', limit: 2, cursor: page.next_cursor },
      principal: 'owner',
    })).toMatchObject({ records: [{ amount: '11.0000' }] });
  });

  it('commits CAS, refs, quota accounting, and outbox atomically', () => {
    const parent = store.execute({ binding: bindings().create, args: { values: values('parent') }, principal: 'owner' }) as {
      record: { id: string };
    };
    const childValues = values('child');
    childValues.parent = `job/${encodeURIComponent(parent.record.id)}`;
    const child = store.execute({ binding: bindings().create, args: { values: childValues }, principal: 'owner' }) as {
      record: { id: string; _record: { revision: number } };
    };
    expect(() => store.execute({
      binding: bindings().delete,
      args: { id: parent.record.id, expected_version: 1, expected_revision: 0 },
      principal: 'owner',
    })).toThrow(/inbound references/);

    const before = store.getNamespace(OWNER)!.quota;
    expect(() => store.execute({
      binding: bindings().update,
      args: { id: child.record.id, expected_version: 1, expected_revision: 99, set: { status: 'done' }, unset: [] },
      principal: 'owner',
    })).toThrow(/stale/);
    expect(store.getNamespace(OWNER)!.quota).toEqual(before);

    store.setQuota(OWNER, { byte_limit: before.payload_bytes });
    expect(() => store.execute({
      binding: bindings().update,
      args: { id: child.record.id, expected_version: 1, expected_revision: 0, set: { note: 'x' }, unset: [] },
      principal: 'owner',
    })).toThrow(/quota/);
    expect(store.getNamespace(OWNER)!.quota).toMatchObject({
      row_count: before.row_count,
      payload_bytes: before.payload_bytes,
      outbox_count: before.outbox_count,
      data_generation: before.data_generation,
    });
    expect(store.auditAccounting(OWNER).coherent).toBe(true);
  });

  it('repairs only audit-proven accounting drift and preserves an orphaned lifecycle state', () => {
    const parent = store.execute({
      binding: bindings().create,
      args: { values: values('repair-parent') },
      principal: 'owner',
    }) as { record: { id: string } };
    const childValues = values('repair-child');
    childValues.parent = `job/${parent.record.id}`;
    store.execute({
      binding: bindings().create,
      args: { values: childValues },
      principal: 'owner',
    });
    const generation = store.getNamespace(OWNER)!.state_generation;
    expect(store.orphanNamespace(OWNER, generation).state.state).toBe('orphaned');
    db.prepare(`UPDATE ${RECORDS_TABLES.namespaces} SET row_count=0,payload_bytes=0,outbox_count=0
      WHERE publisher=? AND pack_slug=?`).run(OWNER.publisher, OWNER.pack_slug);

    expect(store.auditAccounting(OWNER)).toMatchObject({
      coherent: false,
      expected_rows: 2,
      expected_outbox: 2,
    });
    expect(store.getNamespace(OWNER)?.state).toMatchObject({
      state: 'incoherent',
      last_known_state: 'orphaned',
      reason: 'Records accounting drift',
    });
    expect(store.repairAccounting(OWNER)).toMatchObject({
      state: { state: 'orphaned' },
      quota: { row_count: 2, outbox_count: 2 },
    });
    expect(() => store.repairAccounting(OWNER)).toThrow(/audit-detected/);
  });

  it('refuses accounting repair when physical relationship proof diverges', () => {
    const parent = store.execute({
      binding: bindings().create,
      args: { values: values('proof-parent') },
      principal: 'owner',
    }) as { record: { id: string } };
    const childValues = values('proof-child');
    childValues.parent = `job/${parent.record.id}`;
    store.execute({
      binding: bindings().create,
      args: { values: childValues },
      principal: 'owner',
    });
    db.prepare(`UPDATE ${RECORDS_TABLES.namespaces} SET row_count=0
      WHERE publisher=? AND pack_slug=?`).run(OWNER.publisher, OWNER.pack_slug);
    expect(store.auditAccounting(OWNER).coherent).toBe(false);
    db.prepare(`DELETE FROM ${RECORDS_TABLES.reverse_refs}
      WHERE publisher=? AND pack_slug=?`).run(OWNER.publisher, OWNER.pack_slug);
    expect(() => store.repairAccounting(OWNER)).toThrow(/reverse-reference/);
    expect(store.getNamespace(OWNER)?.state.state).toBe('incoherent');
  });

  it('rolls terminal event transitions back when outbox accounting underflows', () => {
    store.execute({
      binding: bindings().create,
      args: { values: values('underflow') },
      principal: 'owner',
    });
    const eventId = store.listOutbox(OWNER, 'pending')[0]!.event_id;
    db.prepare(`UPDATE ${RECORDS_TABLES.namespaces} SET outbox_count=0
      WHERE publisher=? AND pack_slug=?`).run(OWNER.publisher, OWNER.pack_slug);

    expect(() => store.deadLetterEvent(eventId, 'owner disposition')).toThrow(/accounting decrement/);
    expect(store.listOutbox(OWNER, 'pending')).toHaveLength(1);
    expect(store.auditAccounting(OWNER)).toMatchObject({ coherent: false, expected_outbox: 1 });
  });

  it('enforces exact core-wide row/byte/outbox caps across pack namespaces', () => {
    install(store, OTHER);
    store.setGlobalQuota({ row_limit: 1, outbox_limit: 1 });
    const first = store.execute({
      binding: bindings().create,
      args: { values: values('global-a') },
      principal: 'owner',
    }) as { record: { id: string; _record: { revision: number } } };
    expect(store.getGlobalQuota()).toMatchObject({
      row_count: 1,
      outbox_count: 1,
      row_limit: 1,
      outbox_limit: 1,
    });

    const otherBefore = store.getNamespace(OTHER)!.quota;
    expect(() => store.execute({
      binding: bindings(OTHER).create,
      args: { values: values('global-b') },
      principal: 'owner',
    })).toThrow(/global Records quota/);
    expect(store.getNamespace(OTHER)!.quota).toEqual(otherBefore);

    const ownerBefore = store.getNamespace(OWNER)!.quota;
    expect(() => store.execute({
      binding: bindings().update,
      args: {
        id: first.record.id,
        expected_version: 1,
        expected_revision: first.record._record.revision,
        set: { status: 'done' },
        unset: [],
      },
      principal: 'owner',
    })).toThrow(/global Records outbox quota/);
    expect(store.getNamespace(OWNER)!.quota).toEqual(ownerBefore);
    expect(store.getGlobalQuota().payload_bytes).toBe(
      store.getNamespace(OWNER)!.quota.payload_bytes
      + store.getNamespace(OTHER)!.quota.payload_bytes,
    );
  });

  it('orphan-retains by default and exports one generation-pinned friendly snapshot', () => {
    store.execute({ binding: bindings().create, args: { values: values('export') }, principal: 'owner' });
    const exported = store.exportNamespace(OWNER);
    expect(exported.format).toBe('recued.records.v1');
    expect(exported.records.job[0]).toMatchObject({ title: 'Launch', amount: '9.0000' });
    expect(exported.digest).toMatch(/^[a-f0-9]{64}$/);

    const generation = store.getNamespace(OWNER)!.state_generation;
    expect(store.orphanNamespace(OWNER, generation).state.state).toBe('orphaned');
    expect(store.ownerGet(OWNER, 'job', exported.records.job[0].id)).not.toBeNull();
    expect(() => store.execute({
      binding: bindings().get,
      args: { id: exported.records.job[0].id },
      principal: 'owner',
    })).toThrow(/orphaned/);
  });

  it('applies owner retention even when the pack publishes no delete operation', () => {
    store.installNamespace({
      owner: OTHER,
      version: 1,
      storage_schema_hash: STORAGE_HASH,
      declaration_hash: DECLARATION_HASH,
      artifact_digest: 'artifact:retention-without-delete',
      schema,
      bindings: {
        create: bind('create', OTHER),
        get: bind('get', OTHER),
      },
    });
    store.execute({
      binding: bind('create', OTHER),
      args: { id: 'expired', values: values('retention') },
      principal: 'owner',
    });
    store.setRetention(OTHER, 'job', { mode: 'expire_after_days', days: 1 });
    expect(store.runRetention(OTHER, 1_800_000_000_000 + 2 * 86_400_000)).toEqual({
      deleted: 1,
      blocked: [],
    });
    expect(store.ownerGet(OTHER, 'job', 'expired')).toBeNull();
    expect(store.listOutbox(OTHER)).toHaveLength(1);
  });

  it('installs the fixed 41-index family as sparse partial indexes and leaves t slots unindexed', () => {
    const indexes = store.explainIndexes();
    expect(indexes).toHaveLength(41);
    expect(indexes).toContain('core_records_dec1_idx');
    expect(indexes.some((name) => name.includes('_t1_'))).toBe(false);
    const definitions = db.prepare(`SELECT name,sql FROM sqlite_master
      WHERE type='index' AND name LIKE 'core_records_%_idx' ORDER BY name`)
      .all() as Array<{ name: string; sql: string }>;
    expect(definitions).toHaveLength(41);
    for (const definition of definitions) {
      const slot = definition.name.slice('core_records_'.length, -'_idx'.length);
      expect(definition.sql.toLowerCase()).toContain(`where ${slot} is not null`);
    }
  });

  it('refuses a large primary-key scan before execution while admitting a fixed sparse-index plan', () => {
    db.prepare(`UPDATE ${RECORDS_TABLES.namespaces} SET row_count=100001
      WHERE publisher=? AND pack_slug=?`).run(OWNER.publisher, OWNER.pack_slug);

    expect(() => store.execute({
      binding: bindings().search,
      args: { filters: { status: { op: 'is_null' } } },
      principal: 'owner',
    })).toThrowError(expect.objectContaining({ code: 'records_query_budget' }));
    // `<>` cannot drive a bounded sparse-index walk: a database containing
    // mostly the excluded value may inspect the whole index to return a tiny
    // result set. It remains valid only below the work ceiling or behind a
    // separate bounded driver.
    expect(() => store.execute({
      binding: bindings().search,
      args: { filters: { status: { op: 'ne', value: 'common' } } },
      principal: 'owner',
    })).toThrowError(expect.objectContaining({ code: 'records_query_budget' }));
    expect(store.execute({
      binding: bindings().search,
      args: { filters: { status: 'missing' } },
      principal: 'owner',
    })).toEqual({ records: [] });
  });

  it('refuses a broad index driver even when a second predicate hides its scan', () => {
    const insert = db.prepare(`INSERT INTO ${RECORDS_TABLES.rows}
      (publisher,pack_slug,kind,pk,version,revision,created_at,updated_at,
       created_by,updated_by,payload_bytes,s2,r1)
      VALUES (?,?,?,?,1,0,1,1,'fixture','fixture',1,?,?)`);
    db.transaction(() => {
      for (let index = 0; index <= 100_000; index += 1) {
        insert.run(
          OWNER.publisher,
          OWNER.pack_slug,
          'job',
          `budget-${index.toString().padStart(6, '0')}`,
          index === 100_000 ? 'needle' : `status-${index}`,
          'job/root',
        );
      }
      db.prepare(`UPDATE ${RECORDS_TABLES.namespaces} SET row_count=100001
        WHERE publisher=? AND pack_slug=?`).run(OWNER.publisher, OWNER.pack_slug);
    })();

    // Both are equality predicates. Lexical driver selection chooses `parent`
    // before `status`; the conjunction has one result, but proving it by
    // walking 100001 identical parent entries exceeds the fixed work budget.
    expect(() => store.execute({
      binding: bindings().search,
      args: { filters: { parent: 'job/root', status: 'needle' } },
      principal: 'owner',
    })).toThrowError(expect.objectContaining({ code: 'records_query_budget' }));
  });

  // ⛔ REGRESSION. `updateRecord` compared the RAW row against normalized values.
  // The row statements set `safeIntegers(true)`, so every INTEGER column arrives
  // as a `bigint` — `Object.is(1785000000000n, 1785000000000)` is false — and any
  // INTEGER-backed slot therefore always read as changed. The no-op refusal was
  // silently dead for `b*` and `dt*`: a re-issued identical update bumped
  // `revision` and emitted `record.updated` with `changed_fields` naming fields
  // that had not changed, i.e. a spurious watcher fire for every Records pack.
  //
  // Driven per family rather than once, because the two that broke are exactly
  // the two a single-family test would have missed: `n*` is REAL and `dec*` stays
  // a bigint on both sides, so the obvious numeric cases were always green.
  describe('the no-op refusal holds for every slot family', () => {
    const REWRITE: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      // family, identical re-write, a genuinely different value
      ['string   s*', { title: 'Launch' }, { title: 'Relaunch' }],
      ['text     t*', { note: 'hello' }, { note: 'goodbye' }],
      ['number   n*', { score: 0.07 }, { score: 0.08 }],
      ['decimal  dec*', { amount: '9.00' }, { amount: '10.00' }],
      ['date     d*', { started_on: '0001-01-01' }, { started_on: '2026-01-01' }],
      ['datetime dt*', { due_at: '2026-08-05T10:00:00-07:00' }, { due_at: '2026-08-06T10:00:00-07:00' }],
      ['boolean  b*', { active: true }, { active: false }],
      ['ref      r*', { parent: null }, { parent: null }],
    ];

    for (const [family, same, different] of REWRITE) {
      it(`refuses an identical re-write of ${family}, and still admits a real change`, () => {
        const created = store.execute({
          binding: bindings().create,
          args: { values: { ...values(`customer-${family}`), note: 'hello' } },
          principal: 'owner',
        }) as { record: { id: string; _record: { revision: number } } };
        const id = created.record.id;
        const rev = created.record._record.revision;

        // Writing back exactly what is stored must refuse — no revision bump,
        // no event.
        expect(() => store.execute({
          binding: bindings().update,
          args: { id, expected_version: 1, expected_revision: rev, set: same, unset: [] },
          principal: 'owner',
        }), family).toThrowError(expect.objectContaining({ code: 'records_noop' }));

        // ⛔ And the PERMITTING case, or the refusal above cannot distinguish a
        // working no-op check from a blanket one. `r*` has no second legal value
        // here (its only admissible target is a row that does not exist), so it
        // proves the refusal alone.
        if (JSON.stringify(same) === JSON.stringify(different)) return;
        const changed = store.execute({
          binding: bindings().update,
          args: { id, expected_version: 1, expected_revision: rev, set: different, unset: [] },
          principal: 'owner',
        }) as { record: { _record: { revision: number } } };
        expect(changed.record._record.revision, family).toBe(rev + 1);
      });
    }

    it('reports only the fields that actually moved, in a mixed write', () => {
      // The same comparison feeds `changed_fields` on the outbox pointer, so the
      // defect also made a watcher see fields that never moved.
      const created = store.execute({
        binding: bindings().create,
        args: { values: { ...values('customer-mixed'), note: 'hello' } },
        principal: 'owner',
      }) as { record: { id: string; _record: { revision: number } } };
      const updated = store.execute({
        binding: bindings().update,
        args: {
          id: created.record.id,
          expected_version: 1,
          expected_revision: created.record._record.revision,
          // Only `active` moves; the datetime and the string are re-written as-is.
          set: { active: false, due_at: '2026-08-05T10:00:00-07:00', title: 'Launch' },
          unset: [],
        },
        principal: 'owner',
      }) as { record: { active: boolean; due_at: string; title: string } };
      expect(updated.record.active).toBe(false);
      expect(updated.record.title).toBe('Launch');
      const events = store.listOutbox(OWNER)
        .filter((entry) => entry.type === 'record.updated');
      expect(events).toHaveLength(1);
      expect(events[0]!.changed_fields).toEqual(['active']);
    });
  });
});
