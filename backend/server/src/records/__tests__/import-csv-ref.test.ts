/** `core.records.import` taking a REF instead of text — the temp-backing variant.
 *
 *  ⛔⛔ THE PROPERTY UNDER TEST IS WHICH BACKING IS ADMITTED, not that a file can
 *  be read. Reading a file is trivial; refusing the two ref shapes that would
 *  turn a records-entity op into an ungated file-read primitive is the whole
 *  feature. A durable `data.file` record id and a `{slug, path}` instance
 *  address both LOOK like the right value — the first is literally what every
 *  shipped import recipe already holds in `{{config.file}}` — so each gets its
 *  own refusal with the route that does work, and each gets its own test.
 *
 *  🔑 AND THE JOIN IS DRIVEN, NOT THE HALVES. `resolveRecordsImportCsvRef` alone
 *  and `RecordsStore.execute` alone both pass while nothing composes them: the
 *  host would hand every `csv_ref` to a store that refuses it, and two green
 *  suites would report a working feature. So the composition tests go through
 *  `composeRecordsOperationExecutor` — the same factory `execute-handler.ts`
 *  wires — against a real store and a real file on disk.
 */

import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RECORDS_IMPORT_MAX_CSV_BYTES,
  type RecordsExecutionBinding, type RecordsImportResult,
  type RecordsPackRef, type RecordsSchemaSnapshot, type TempFileRef,
} from '@recued/contracts';

import {
  allocateRunScratchDir, cleanupRunScratch, reclaimRunScratchUnlessResumable, runScratchRoot,
} from '../../execution/run-scratch.js';
import { composeRecordsOperationExecutor, resolveRecordsImportCsvRef } from '../import-csv-ref.js';
import { createRecordsStore, type RecordsStore } from '../store.js';

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
      { key: 'posted_on', slot: 's1', kind: 'string', required: true },
      { key: 'description', slot: 's2', kind: 'string', required: true },
      { key: 'amount', slot: 'n1', kind: 'number', required: false },
    ] },
  },
};
const B = { importLine: bind('import', 'line'), searchLine: bind('search', 'line') };

const SPEC = {
  columns: [
    { column: 'Date', field: 'posted_on' },
    { column: 'Detail', field: 'description' },
    { column: 'Amt', field: 'amount' },
  ],
  numeric_fields: ['amount'],
  dedup_on: ['posted_on', 'description', 'amount'],
  scope: 'acct-1',
};
const CSV = ['Date,Detail,Amt', '01-Jan,coffee,3.50', '02-Jan,rent,1200'].join('\n');

// Each test gets its own run id so concurrent scratch roots never collide.
const runIds: string[] = [];
const freshRun = (label: string): string => {
  const id = `import-ref-${label}-${runIds.length}`;
  runIds.push(id);
  return id;
};
afterEach(() => { for (const id of runIds.splice(0)) cleanupRunScratch(id); });

/** Write a file into the run's scratch root exactly as a `storage: 'temp'` cli
 *  op would, and hand back the ref that op would surface. */
const produceTempCsv = (run_id: string, body = CSV, filename = 'converted.csv'): TempFileRef => {
  const path = join(allocateRunScratchDir(run_id), filename);
  writeFileSync(path, body, 'utf8');
  return { backing: 'temp', path, mime_type: 'text/csv', filename };
};

const call = (args: Record<string, unknown>, binding = B.importLine) =>
  ({ binding, principal: 'owner', args });

describe('records import — csv_ref', () => {
  let db: Database.Database;
  let store: RecordsStore;
  /** The composed executor the server actually wires, bound to one run. */
  let run: (run_id: string) => (c: ReturnType<typeof call>) => unknown;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    store = createRecordsStore(db, { now: (() => { let t = 1e12; return () => t++; })() });
    store.installNamespace({
      owner: OWNER, version: 1, storage_schema_hash: SH, declaration_hash: DH,
      artifact_digest: 'x', schema, bindings: B,
    });
    run = (run_id) => composeRecordsOperationExecutor((c) => store.execute(c), run_id);
  });
  afterEach(() => db.close());

  const rowCount = () =>
    (db.prepare('SELECT count(*) AS n FROM core_records').get() as { n: number }).n;

  describe('the temp backing is admitted, end to end', () => {
    it('a same-run temp CSV imports, and the RESULT carries counts, not the file', () => {
      const id = freshRun('happy');
      const ref = produceTempCsv(id);
      const r = run(id)(call({ csv_ref: ref, spec: SPEC })) as RecordsImportResult;
      expect(r.rows_read).toBe(2);
      expect(r.written).toBe(2);
      expect(r.failed).toBe(0);
      expect(rowCount()).toBe(2);
      // The arithmetic invariant still holds on this path — the thing a partial
      // import must never be able to hide.
      expect(r.written + r.replayed + r.failed + r.not_attempted).toBe(r.rows_read);
      // ⚠ THE POINT OF THE REF PATH, AND IT NEEDS ITS OWN ASSERTION. The text is
      // handed to the STORE (as `args.csv`) but is never part of what comes back,
      // so nothing file-sized enters recipe step state. An earlier title here
      // claimed "the bytes never become an arg", which is false — they become
      // exactly one arg, inside the executor.
      //
      // ⛔ AND "result SMALLER than file" IS THE WRONG TEST, which is how the
      // first version of this failed: a 64-char `source_sha256` alone outweighs a
      // three-line fixture. The property is that the result does not GROW with the
      // file — constant against variable — so it is measured across two sizes.
      expect(JSON.stringify(r)).not.toContain('coffee');
    });

    it('⚠ the result does not grow with the file — 100x the rows, same size back', () => {
      const small = freshRun('small');
      const large = freshRun('large');
      const body = ['Date,Detail,Amt', ...Array.from(
        { length: 200 }, (_, i) => `0${(i % 9) + 1}-Jan,row${i},${i}.50`,
      )].join('\n');
      const a = run(small)(call({ csv_ref: produceTempCsv(small), spec: SPEC })) as RecordsImportResult;
      const b = run(large)(
        call({ csv_ref: produceTempCsv(large, body, 'big.csv'), spec: SPEC }),
      ) as RecordsImportResult;
      expect(b.rows_read).toBe(200);
      expect(b.written).toBe(200);
      // Only the COUNTS differ; no field carries per-row content, so the two
      // results are within a few digits of each other rather than 100x apart.
      expect(Math.abs(JSON.stringify(b).length - JSON.stringify(a).length)).toBeLessThan(20);
      expect(JSON.stringify(b)).not.toContain('row17');
    });

    it('reports source_sha256 of the exact bytes, because the audit row cannot', () => {
      const id = freshRun('sha');
      const r = run(id)(call({ csv_ref: produceTempCsv(id), spec: SPEC })) as RecordsImportResult;
      expect(r.source_sha256).toBe(createHash('sha256').update(CSV, 'utf8').digest('hex'));
    });

    it('⚠ a dry run still dereferences, writes nothing, and still reports the hash', () => {
      const id = freshRun('dry');
      const r = run(id)(
        call({ csv_ref: produceTempCsv(id), spec: SPEC, dry_run: true }),
      ) as RecordsImportResult;
      expect(r.dry_run).toBe(true);
      expect(r.rows_read).toBe(2);
      expect(rowCount()).toBe(0);
      // Present on a rehearsal too: a caller comparing the rehearsal against the
      // real run needs to know it was the same file.
      expect(r.source_sha256).toBe(createHash('sha256').update(CSV, 'utf8').digest('hex'));
    });

    it('csv text still works and reports NO hash — the two paths stay distinguishable', () => {
      const id = freshRun('text');
      const r = run(id)(call({ csv: CSV, spec: SPEC })) as RecordsImportResult;
      expect(r.written).toBe(2);
      expect(r.source_sha256).toBeUndefined();
    });
  });

  describe('⛔⛔ the backings that are REFUSED, each for its own reason', () => {
    it('refuses a durable data.file record id and names the route that works', () => {
      const id = freshRun('cas');
      // The exact value every shipped import recipe holds in `{{config.file}}`.
      expect(() => run(id)(call({ csv_ref: 'file_01HZY3QK', spec: SPEC })))
        .toThrow(/not a data\.file record id/);
      expect(() => run(id)(call({ csv_ref: 'file_01HZY3QK', spec: SPEC })))
        .toThrow(/core\.storage\.data-file-read/);
      expect(rowCount()).toBe(0);
    });

    it('refuses a {slug, path} instance address — ambient reach over any enrolled instance', () => {
      const id = freshRun('slug');
      expect(() => run(id)(call({ csv_ref: { slug: 'drop', path: 'in/statement.csv' }, spec: SPEC })))
        .toThrow(/not a \{slug, path\} instance address/);
      expect(rowCount()).toBe(0);
    });

    it('refuses a half-formed temp ref rather than reading it', () => {
      const id = freshRun('half');
      // `backing` right, `mime_type` missing — `isTempFileRef` validates the FULL
      // shape precisely so a consumer gets a clean reject, not a crash downstream.
      expect(() => run(id)(call({
        csv_ref: { backing: 'temp', path: '/tmp/x.csv', filename: 'x.csv' }, spec: SPEC,
      }))).toThrow(/must be a run-scoped temp file_ref/);
    });

    it('⚠ refuses csv AND csv_ref together rather than preferring one', () => {
      const id = freshRun('both');
      // A caller that passed both meant one of them; resolving by precedence
      // silently imports the wrong file.
      expect(() => run(id)(call({ csv: CSV, csv_ref: produceTempCsv(id), spec: SPEC })))
        .toThrow(/csv OR csv_ref, not both/);
      expect(rowCount()).toBe(0);
    });
  });

  describe('⛔⛔ confinement — the input-side guard that makes the unconfined sink survivable', () => {
    it('refuses a path outside the run scratch root', () => {
      const id = freshRun('escape');
      allocateRunScratchDir(id); // the root must exist, or the earlier check fires
      const outside = join(process.cwd(), 'package.json');
      expect(() => run(id)(call({
        csv_ref: { backing: 'temp', path: outside, mime_type: 'text/csv', filename: 'p.json' },
        spec: SPEC,
      }))).toThrow(/escapes the run-scratch root/);
      expect(rowCount()).toBe(0);
    });

    it("refuses another run's temp file — a ref is confined to the run that produced it", () => {
      const mine = freshRun('mine');
      const theirs = freshRun('theirs');
      const ref = produceTempCsv(theirs);
      allocateRunScratchDir(mine);
      expect(() => run(mine)(call({ csv_ref: ref, spec: SPEC })))
        .toThrow(/escapes the run-scratch root/);
      expect(rowCount()).toBe(0);
    });

    it('refuses a ref that outlived its run (the root is gone)', () => {
      const id = freshRun('outlived');
      const ref = produceTempCsv(id);
      cleanupRunScratch(id);
      expect(() => run(id)(call({ csv_ref: ref, spec: SPEC })))
        .toThrow(/must not outlive its run/);
    });

    it('⛔ FAILS CLOSED with no run scope — an empty run_id must not read the shared parent', () => {
      const id = freshRun('noscope');
      const ref = produceTempCsv(id);
      // `runScratchRoot('')` is the parent under which EVERY run's files live.
      expect(runScratchRoot('')).not.toBe(runScratchRoot(id));
      expect(() => run('')(call({ csv_ref: ref, spec: SPEC })))
        .toThrow(/requires a run scope/);
    });
  });

  describe('⛔⛔ the byte ceiling, which nothing else on this path supplies', () => {
    /** ⚠ BOTH SIDES OF THE BOUND ARE CHECKED AT THE RESOLVER, NOT THROUGH THE
     *  STORE. The property is whether the comparison is `>` or `>=`, and the
     *  cheapest honest file that sits exactly ON a 32 MiB cap is ~3 million rows
     *  — importing them would spend minutes proving nothing about the bound. The
     *  resolver is where the refusal lives, so that is where it is pinned; the
     *  over-cap case additionally goes through the composed executor to prove
     *  nothing is written when it fires. */
    const filler = (bytes: number): string => `Date,Detail,Amt\n01-Jan,${'x'.repeat(bytes - 26)},1\n`;

    it('refuses a file past the ceiling before any row is planned', () => {
      const id = freshRun('ceiling');
      const ref = produceTempCsv(id, filler(RECORDS_IMPORT_MAX_CSV_BYTES + 1), 'huge.csv');
      expect(() => run(id)(call({ csv_ref: ref, spec: SPEC })))
        .toThrow(/past the \d+-byte ceiling/);
      expect(rowCount()).toBe(0);
    });

    it('admits a file exactly AT the ceiling — the bound is inclusive, not off by one', () => {
      const id = freshRun('atcap');
      const body = filler(RECORDS_IMPORT_MAX_CSV_BYTES);
      expect(Buffer.byteLength(body, 'utf8')).toBe(RECORDS_IMPORT_MAX_CSV_BYTES);
      const resolved = resolveRecordsImportCsvRef(
        call({ csv_ref: produceTempCsv(id, body, 'exact.csv'), spec: SPEC }) as never, id,
      );
      expect(resolved.call.args.csv).toBe(body);
    });
  });

  describe('the rewrite touches nothing it should not', () => {
    it('leaves a non-import action alone even when it carries a csv_ref key', () => {
      const id = freshRun('other-action');
      const resolved = resolveRecordsImportCsvRef(
        call({ csv_ref: produceTempCsv(id), filters: {} }, B.searchLine) as never, id,
      );
      // Untouched — same args object, no dereference, no hash.
      expect(resolved.call.args.csv_ref).toBeDefined();
      expect(resolved.call.args.csv).toBeUndefined();
      expect(resolved.source_sha256).toBeUndefined();
    });

    it('DROPS csv_ref from the args it hands the store', () => {
      const id = freshRun('drop');
      const resolved = resolveRecordsImportCsvRef(
        call({ csv_ref: produceTempCsv(id), spec: SPEC }) as never, id,
      );
      // Not merely overwritten: the store's fail-closed guard keys on its
      // PRESENCE, and leaving it would make that guard unreachable here.
      expect('csv_ref' in resolved.call.args).toBe(false);
      expect(resolved.call.args.csv).toBe(CSV);
      expect(resolved.call.args.spec).toBe(SPEC);
    });
  });

  describe('⛔⛔ the approval hold — the normal path, not an edge case', () => {
    /** All three shipped packs declare `import` at `approval: 'ask'`, so a
     *  `csv_ref` import ALWAYS stops for the owner between the cli step that
     *  produced the file and the dereference that reads it. If the run-end
     *  reclaim ran at the pause, the bytes would be gone by the time they say
     *  yes — and every one of the tests above would still pass, because none of
     *  them holds. These two drive the real reclaim decision either way. */
    it('survives the hold: produce → pause → owner approves → the import reads it', () => {
      const id = freshRun('held');
      const ref = produceTempCsv(id);
      // The run stops to ask. `resumablePause: true` is what the handler's
      // run-end `finally` passes for a durably-checkpointed hold.
      reclaimRunScratchUnlessResumable(id, true);
      // ... the owner approves, and the run resumes under the SAME run_id.
      const r = run(id)(call({ csv_ref: ref, spec: SPEC })) as RecordsImportResult;
      expect(r.written).toBe(2);
      expect(rowCount()).toBe(2);
    });

    it('⚠ but a TERMINAL end does reclaim — so the arm above is not vacuous', () => {
      // Same shape, terminal flag. If the reclaim were a no-op the assertion
      // above would pass on a function that never cleans, and a temp ref could
      // outlive its run — the D-185 §3.4 invariant, inverted.
      const id = freshRun('terminal-import');
      const ref = produceTempCsv(id);
      reclaimRunScratchUnlessResumable(id, false);
      expect(() => run(id)(call({ csv_ref: ref, spec: SPEC })))
        .toThrow(/must not outlive its run/);
      expect(rowCount()).toBe(0);
    });
  });

  describe('⛔⛔ the store fails closed when the dereference never ran', () => {
    it('refuses a csv_ref that reached the store, naming the missing composition', () => {
      // A host that wired the store WITHOUT the factory. Without this guard the
      // caller gets "import requires csv text" and goes looking at their args.
      expect(() => store.execute(call({ csv_ref: { backing: 'temp' }, spec: SPEC }) as never))
        .toThrow(/never dereferenced/);
      expect(rowCount()).toBe(0);
    });
  });
});
