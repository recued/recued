/** D-221 — one durable row per `core.records.import`, carrying the exact outcome.
 *
 *  ⛔⛔ THE ROW EXISTS BECAUSE THE GATEWAY'S CANNOT TELL THE TRUTH HERE. A gateway
 *  audit row already lands, exactly once per import — but an import returns a
 *  RESULT rather than throwing on a partial write, so that row reads
 *  `outcome: 'success'` for a file where zero of a thousand rows landed. That was
 *  measured, not assumed. "It returned" and "it worked" are different facts, and
 *  for a bulk write over the owner's money only one of them is worth keeping.
 *
 *  ⛔ HALF OF THIS FILE IS ABOUT THE WIRING, NOT THE EMIT. A sink nobody assigns
 *  is silence — the import still succeeds, the rows still land, and no record is
 *  written that anything happened. That failure is invisible to every test that
 *  hands the store its own spy, so the second block drives the REAL boot composer
 *  and reads the activity table.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { createRuntimeConfigStore } from '@recued/config';
import { RESERVE_ACTIONS } from '@recued/storage';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  RecordsExecutionBinding, RecordsImportResult,
  RecordsPackRef, RecordsSchemaSnapshot,
} from '@recued/contracts';

import { createBootTrace } from '../../cli/boot-trace.js';
import { composeStorageContext } from '../../serve/compose-storage-context.js';
import { createRecordsStore } from '../store.js';
import {
  RECORDS_IMPORT_ACTION,
  recordsImportAuditDetail,
  recordsImportAuditTarget,
  type RecordsImportAudit,
  type RecordsImportAuditDetail,
} from '../import-audit.js';

const OWNER: RecordsPackRef = { publisher: 'recued-core', pack_slug: 'statements' };
const SH = 'a'.repeat(64), DH = 'b'.repeat(64);

const bind = (action: string, entity: string): RecordsExecutionBinding => ({
  kind: 'core.records', action: action as never, entity, owner: OWNER, pack_version: 1,
  storage_schema_hash: SH, declaration_hash: DH,
  operation_digest: `d:${action}:${entity}`,
});

const schema: RecordsSchemaSnapshot = {
  decimal_scale: 4,
  entities: {
    line: { kind: 'line', fields: [
      { key: 'id', slot: 'pk', kind: 'id', required: true },
      { key: 'day', slot: 's1', kind: 'string', required: true },
      { key: 'note', slot: 's2', kind: 'string', required: true },
      { key: 'amount', slot: 'n1', kind: 'number', required: false },
    ] },
  },
};

const SPEC = {
  columns: [
    { column: 'Day', field: 'day' },
    { column: 'Note', field: 'note' },
    { column: 'Amt', field: 'amount' },
  ],
  numeric_fields: ['amount'],
  dedup_on: ['day', 'note', 'amount'],
  scope: 'acct-1',
};
const CSV = 'Day,Note,Amt\n01-Jan,coffee,3.50\n02-Jan,rent,1200.00';

describe('the import emits its exact outcome', () => {
  let db: Database.Database;
  let seen: RecordsImportAudit[];

  const makeStore = () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    seen = [];
    const store = createRecordsStore(db, {
      now: (() => { let t = 1e12; return () => t++; })(),
      onImport: (e) => { seen.push(e); },
    });
    store.installNamespace({
      owner: OWNER, version: 1, storage_schema_hash: SH, declaration_hash: DH,
      artifact_digest: 'x', schema, bindings: { imp: bind('import', 'line') },
    });
    return store;
  };
  const importCsv = (store: ReturnType<typeof createRecordsStore>, csv = CSV) =>
    store.execute({
      binding: bind('import', 'line'), principal: 'owner', args: { csv, spec: SPEC },
    }) as RecordsImportResult;

  afterEach(() => { db?.close(); });

  it('emits ONCE per import, with the identity of what was written', () => {
    const store = makeStore();
    importCsv(store);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.owner).toEqual(OWNER);
    expect(seen[0]!.entity).toBe('line');
    expect(seen[0]!.principal, 'who imported').toBe('owner');
    expect(seen[0]!.result.written).toBe(2);
  });

  it('⛔⛔ ONE ROW PER IMPORT, NOT ONE PER ROW', () => {
    /** The per-row writes re-enter `execute` BELOW this emit. If that ever
     *  inverts, a 1000-row bank export costs 1000 reserve-class audit rows —
     *  and reserve rows never evict, so it would grow the audit table without
     *  bound. The old `line.batch` op carried this warning in its description;
     *  it belongs in an assertion. */
    const store = makeStore();
    const many = Array.from({ length: 250 }, (_, i) => `0${i}-Jan,row${i},1.00`);
    importCsv(store, ['Day,Note,Amt', ...many].join('\n'));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.result.written).toBe(250);
  });

  it('⛔⛔⛔ AN IMPORT THAT WROTE NOTHING IS RECORDED AS HAVING WRITTEN NOTHING', () => {
    /** THE WHOLE REASON THE ROW EXISTS. The gateway audits this same call as
     *  `outcome: 'success'`, because the import returned rather than threw. Here
     *  the counts are the record, so a bulk write that landed nothing cannot
     *  read as a clean import. */
    const store = makeStore();
    importCsv(store);
    db.prepare('UPDATE core_records SET s2=?').run('edited-by-owner');
    seen.length = 0;

    const result = importCsv(store);
    expect(result.written).toBe(0);
    expect(result.failed).toBe(2);

    const detail = recordsImportAuditDetail(seen[0]!);
    expect(detail.written).toBe(0);
    expect(detail.failed).toBe(2);
    expect(detail.partial, 'a refused import is not a clean one').toBe(true);
  });

  it('⚠ and a genuinely clean import is NOT marked partial', () => {
    // The over-correction: `partial: true` on everything says nothing at all.
    const store = makeStore();
    importCsv(store);
    expect(recordsImportAuditDetail(seen[0]!).partial).toBe(false);
  });

  it('a re-import of the same file is clean, not partial — replays are not failures', () => {
    /** Overlapping exports are the normal case. If a no-op re-import read as
     *  partial, the signal would fire on the most ordinary run there is. */
    const store = makeStore();
    importCsv(store);
    seen.length = 0;
    const again = importCsv(store);
    expect(again.replayed).toBe(2);
    const detail = recordsImportAuditDetail(seen[0]!);
    expect(detail.replayed).toBe(2);
    expect(detail.written).toBe(0);
    expect(detail.partial, 'already-held rows are a success').toBe(false);
  });

  it('⛔ the detail accounts for every line of the file', () => {
    /** The arithmetic invariant travels INTO the record, so a reader months
     *  later can prove the row describes the whole file rather than a slice of
     *  it. A count that does not add up is the shape of a partial import
     *  reporting clean. */
    const store = makeStore();
    importCsv(store);
    const d: RecordsImportAuditDetail = recordsImportAuditDetail(seen[0]!);
    expect(d.written + d.replayed + d.failed + d.not_attempted).toBe(d.rows_read);
    expect(d.source).toBe('records.import');
    expect(recordsImportAuditTarget(seen[0]!)).toBe('recued-core/statements:line');
  });

  it('⛔ an audit sink that THROWS cannot fail an import that already wrote rows', () => {
    /** The rows are committed before the emit. A sink allowed to throw would
     *  turn a successful bulk write into a failed step, and the owner would
     *  re-run an import that had in fact already landed. */
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const store = createRecordsStore(db, {
      now: (() => { let t = 1e12; return () => t++; })(),
      onImport: () => { throw new Error('audit sink is down'); },
    });
    store.installNamespace({
      owner: OWNER, version: 1, storage_schema_hash: SH, declaration_hash: DH,
      artifact_digest: 'x', schema, bindings: { imp: bind('import', 'line') },
    });
    expect(() => importCsv(store)).not.toThrow();
    expect((db.prepare('SELECT count(*) AS n FROM core_records').get() as { n: number }).n)
      .toBe(2);
  });

  it('⛔ the row survives eviction — it is provenance for data that cannot be re-synced', () => {
    /** `collection_backfill` is deliberately NOT reserve because a collection can
     *  be re-synced from its source. Records rows are the owner's own authored
     *  data and cannot be, so evicting this row loses the only record of which
     *  file put which rows in the ledger. */
    expect(RESERVE_ACTIONS.has(RECORDS_IMPORT_ACTION)).toBe(true);
  });
});

describe('⛔⛔ the boot composer actually wires the sink', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('an import through the REAL booted store lands a durable activity row', async () => {
    /** ⛔⛔ THIS IS THE HALF THAT CAN ROT. Everything above hands the store a spy
     *  and would keep passing if `compose-storage-context.ts` never assigned the
     *  emitter — the sink is optional, so an unwired one is not an error, it is
     *  silence. The wiring is also late-bound (the store is constructed ~70 lines
     *  before the audit log exists), which is exactly the shape where an
     *  assignment gets dropped in a refactor.
     *
     *  So this boots the real composer, imports through the store it returns, and
     *  reads `audit_activities` — no spy anywhere in the path. */
    dir = mkdtempSync(join(tmpdir(), 'recued-records-import-audit-'));
    const ctx = await composeStorageContext({
      dbPath: join(dir, 'server.db'),
      bootTrace: createBootTrace({
        entrypoint: 'serve-entry', profile: 'serve', command: 'serve', env: {},
      }),
      runtimeConfig: createRuntimeConfigStore({}),
      vaultQuotas: { perPublisherBytes: 1_234_000, totalBytes: 5_678_000 },
    });

    ctx.recordsStore.installNamespace({
      owner: OWNER, version: 1, storage_schema_hash: SH, declaration_hash: DH,
      artifact_digest: 'x', schema, bindings: { imp: bind('import', 'line') },
    });
    ctx.recordsStore.execute({
      binding: bind('import', 'line'), principal: 'owner', args: { csv: CSV, spec: SPEC },
    });
    // The emitter is fire-and-forget (`void ... .catch()`), so let its promise settle.
    await ctx.drainAuditWrites?.();

    const rows = ctx.db
      .prepare("SELECT data FROM audit_activities")
      .all() as { data: string }[];
    const imports = rows
      .map((r) => JSON.parse(r.data) as { action?: string; target?: string; detail?: string })
      .filter((r) => r.action === RECORDS_IMPORT_ACTION);

    expect(imports, 'the boot composer did not wire the import audit sink')
      .toHaveLength(1);
    expect(imports[0]!.target).toBe('recued-core/statements:line');
    const detail = JSON.parse(imports[0]!.detail ?? '{}') as RecordsImportAuditDetail;
    expect(detail.written).toBe(2);
    expect(detail.rows_read).toBe(2);
    expect(detail.partial).toBe(false);
    expect(detail.entity).toBe('line');
    ctx.db.close();
  });
});
