/** D-282 B4 — a write to a pack's Records store reaches the realtime bus.
 *
 *  ⛔⛔ THE SECOND UNWIRED SINK IN THIS FILE'S NEIGHBOURHOOD, AND THE REASON THIS
 *  SUITE EXISTS AT ALL. `packs-panel.ts` has declared AND implemented
 *  `refreshAppView()` since the Use tab shipped, and nothing has ever called it — so
 *  every open pack view went stale after a write by a schedule, a webhook, the AI, a
 *  peer or the owner's other device. An optional sink nobody assigns is not an error;
 *  it is silence, and silence lasted here for months.
 *
 *  🔑 SO THE HALF THAT MATTERS IS THE LAST TEST. The spy tests above would keep
 *  passing if `compose-storage-context.ts` never assigned the emitter. The wiring is
 *  also late-bound — the store is constructed before the bus exists — which is exactly
 *  the shape where an assignment is dropped in a refactor. That one boots the REAL
 *  composer and listens on the bus it returns, with no spy in the path. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { createRuntimeConfigStore } from '@recued/config';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  RecordsExecutionBinding,
  RecordsPackRef,
  RecordsSchemaSnapshot,
  ServerEvent,
} from '@recued/contracts';

import { createBootTrace } from '../../cli/boot-trace.js';
import { composeStorageContext } from '../../serve/compose-storage-context.js';
import { createRecordsStore, type RecordsChangeNotice } from '../store.js';

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
      { key: 'note', slot: 's1', kind: 'string', required: true },
    ] },
  },
};

const install = (store: ReturnType<typeof createRecordsStore>): void => {
  store.installNamespace({
    owner: OWNER, version: 1, storage_schema_hash: SH, declaration_hash: DH,
    artifact_digest: 'x', schema,
    bindings: {
      c: bind('create', 'line'), u: bind('update', 'line'), d: bind('delete', 'line'),
    },
  });
};

describe('the store tells a listener what changed', () => {
  let db: Database.Database;

  afterEach(() => { db?.close(); });

  const boot = (seen: RecordsChangeNotice[]) => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const store = createRecordsStore(db, { onChange: (e) => { seen.push(e); } });
    install(store);
    return store;
  };

  it('names the pack, the entity, the row and what happened to it', () => {
    const seen: RecordsChangeNotice[] = [];
    const store = boot(seen);
    store.execute({
      binding: bind('create', 'line'),
      principal: 'owner',
      args: { id: 'l-1', values: { note: 'a' } },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ owner: OWNER, entity: 'line', op: 'insert' });
    expect(seen[0]!.id).toBeTruthy();
  });

  /** ⛔⛔ THE MAPPING BUG THIS CAUGHT. The pointer's vocabulary is `record.created`,
   *  not `created`; comparing against the bare words matches nothing, so EVERY event
   *  read as an `update`. A write-path test would not notice — the write still
   *  happens — and the typecheck did not either, because the backend compiles against
   *  contracts' BUILT declarations. Only asserting all three verbs catches it. */
  it('distinguishes insert from update from delete', () => {
    const seen: RecordsChangeNotice[] = [];
    const store = boot(seen);
    const created = store.execute({
      binding: bind('create', 'line'),
      principal: 'owner',
      args: { id: 'l-1', values: { note: 'a' } },
    }) as { record: { _record: { revision: number } } };

    store.execute({
      binding: bind('update', 'line'),
      principal: 'owner',
      args: {
        id: 'l-1',
        expected_version: 1,
        expected_revision: created.record._record.revision,
        set: { note: 'b' },
        unset: [],
      },
    });
    const updated = store.execute({
      binding: bind('update', 'line'),
      principal: 'owner',
      args: {
        id: 'l-1',
        expected_version: 1,
        expected_revision: created.record._record.revision + 1,
        set: { note: 'c' },
        unset: [],
      },
    }) as { record: { _record: { revision: number } } };
    store.execute({
      binding: bind('delete', 'line'),
      principal: 'owner',
      args: {
        id: 'l-1',
        expected_version: 1,
        expected_revision: updated.record._record.revision,
      },
    });

    expect(seen.map((e) => e.op)).toEqual(['insert', 'update', 'update', 'delete']);
  });

  /** ⚠ A screen-refresh sink must never fail a write that already committed. */
  it('a sink that throws cannot fail the write', () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const store = createRecordsStore(db, {
      onChange: () => { throw new Error('the screen is gone'); },
    });
    install(store);
    expect(() => store.execute({
      binding: bind('create', 'line'),
      principal: 'owner',
      args: { id: 'l-1', values: { note: 'a' } },
    })).not.toThrow();
    expect((db.prepare('SELECT count(*) AS n FROM core_records').get() as { n: number }).n)
      .toBe(1);
  });
});

describe('the booted server puts it on the bus', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('a write through the REAL composer emits a `records` broadcast', async () => {
    dir = mkdtempSync(join(tmpdir(), 'recued-records-change-'));
    const ctx = await composeStorageContext({
      dbPath: join(dir, 'server.db'),
      bootTrace: createBootTrace({
        entrypoint: 'serve-entry', profile: 'serve', command: 'serve', env: {},
      }),
      runtimeConfig: createRuntimeConfigStore({}),
      vaultQuotas: { perPublisherBytes: 1_234_000, totalBytes: 5_678_000 },
    });

    // ⚠ The bus subscribes by KIND — a listener that does not NAME a kind never
    // receives it, which is the same trap the client half has to respect.
    const seen: ServerEvent[] = [];
    ctx.eventBus.subscribe({}, { kinds: ['records'] }, (event: ServerEvent) => {
      seen.push(event);
    });

    install(ctx.recordsStore);
    ctx.recordsStore.execute({
      binding: bind('create', 'line'),
      principal: 'owner',
      args: { id: 'l-1', values: { note: 'a' } },
    });

    const records = seen.filter((e) => e.kind === 'records');
    expect(records, 'the boot composer did not wire the records change sink')
      .toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'records',
      publisher: 'recued-core',
      pack_slug: 'statements',
      entity: 'line',
      op: 'insert',
    });
  });
});
