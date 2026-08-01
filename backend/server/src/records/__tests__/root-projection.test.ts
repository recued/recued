/** D-226 — the declared reverse read.
 *
 *  "Everything I've ever done with this person", answered by asking each pack
 *  in its own declared terms rather than by core reading pack semantics.
 *
 *  The properties worth pinning are the ones a plausible-looking implementation
 *  gets wrong: that the walk actually TRAVERSES (a two-hop path is where a
 *  reverse resolver silently returns everything, or nothing); that one pack's
 *  rows never leak into another's rollup; and that a bounded walk SAYS SO
 *  instead of under-reporting a number the user will treat as fact. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  validateRecordsRootProjection,
  type RecordsExecutionBinding,
  type RecordsPackRef,
  type RecordsRootProjection,
  type RecordsSchemaSnapshot,
} from '@recued/contracts';

import { createRecordsStore, type RecordsStore } from '../store.js';
import { readRootProjections, ROOT_PROJECTION_MAX_IDS_PER_QUERY } from '../root-projection.js';

const SH = 'a'.repeat(64);
const DH = 'b'.repeat(64);
const BILLABLE: RecordsPackRef = { publisher: 'recued-core', pack_slug: 'billable-hours' };
const JOBS: RecordsPackRef = { publisher: 'recued-core', pack_slug: 'job-status-board' };

/** billable-hours: entry → engagement → contact. TWO levels, one hop. */
const UNBILLED: RecordsRootProjection = {
  root: 'contact',
  via: [{ field: 'engagement_ref', entity: 'engagement' }],
  key_field: 'client_contact',
  where: { billable: true, invoiced: { op: 'ne', value: true } },
  label: 'Unbilled time',
  select: {
    unbilled_minutes: { fn: 'sum', field: 'minutes' },
    entry_count: { fn: 'count' },
    last_worked_on: { fn: 'max', field: 'worked_on' },
    last_task: { fn: 'latest', field: 'task', by: 'worked_on' },
  },
};

const billableSchema: RecordsSchemaSnapshot = {
  decimal_scale: 4,
  entities: {
    engagement: {
      kind: 'engagement',
      fields: [
        { key: 'id', slot: 'pk', kind: 'id', required: true },
        { key: 'label', slot: 's1', kind: 'string', required: true },
        { key: 'client_contact', slot: 's2', kind: 'string', required: false },
      ],
    },
    entry: {
      kind: 'entry',
      roots: [UNBILLED],
      fields: [
        { key: 'id', slot: 'pk', kind: 'id', required: true },
        { key: 'engagement_ref', slot: 'r1', kind: 'ref', required: true },
        { key: 'worked_on', slot: 'd1', kind: 'date', required: true },
        { key: 'task', slot: 's1', kind: 'string', required: false },
        { key: 'minutes', slot: 'n1', kind: 'number', required: true },
        { key: 'billable', slot: 'b1', kind: 'boolean', required: true },
        { key: 'invoiced', slot: 'b2', kind: 'boolean', required: true },
      ],
    },
  },
};

/** job-status-board: the key is on the base entity itself — via: []. */
const OPEN_JOBS: RecordsRootProjection = {
  root: 'contact', via: [], key_field: 'customer_email',
  where: { archived: false }, label: 'Open jobs',
  select: { job_count: { fn: 'count' }, last_status: { fn: 'latest', field: 'status', by: 'due_at' } },
};

const jobsSchema: RecordsSchemaSnapshot = {
  decimal_scale: 4,
  entities: {
    job: {
      kind: 'job',
      roots: [OPEN_JOBS],
      fields: [
        { key: 'id', slot: 'pk', kind: 'id', required: true },
        { key: 'customer_email', slot: 's1', kind: 'string', required: false },
        { key: 'status', slot: 's2', kind: 'string', required: true },
        { key: 'archived', slot: 'b1', kind: 'boolean', required: true },
        { key: 'due_at', slot: 'd1', kind: 'date', required: true },
      ],
    },
  },
};

const bind = (owner: RecordsPackRef, entity: string): RecordsExecutionBinding => ({
  kind: 'core.records', action: 'create', entity, owner,
  pack_version: 1, storage_schema_hash: SH, declaration_hash: DH,
  operation_digest: `d:create:${owner.pack_slug}:${entity}`,
});

describe('readRootProjections', () => {
  let db: Database.Database;
  let store: RecordsStore;

  const create = (owner: RecordsPackRef, entity: string, id: string, values: Record<string, unknown>) =>
    store.execute({ binding: bind(owner, entity), principal: 'owner', args: { id, values } });

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    store = createRecordsStore(db, { now: (() => { let t = 1_800_000_000_000; return () => t++; })() });

    store.installNamespace({
      owner: BILLABLE, version: 1, storage_schema_hash: SH, declaration_hash: DH,
      artifact_digest: 'artifact-bh', schema: billableSchema,
      bindings: { create_engagement: bind(BILLABLE, 'engagement'), create_entry: bind(BILLABLE, 'entry') },
    });
    store.installNamespace({
      owner: JOBS, version: 1, storage_schema_hash: SH, declaration_hash: DH,
      artifact_digest: 'artifact-jsb', schema: jobsSchema,
      bindings: { create_job: bind(JOBS, 'job') },
    });

    // Two clients. `bob` has work under two engagements; `carol` under one.
    create(BILLABLE, 'engagement', 'e-bob-1', { label: 'Website', client_contact: 'bob@acme.test' });
    create(BILLABLE, 'engagement', 'e-bob-2', { label: 'Retainer', client_contact: 'bob@acme.test' });
    create(BILLABLE, 'engagement', 'e-carol', { label: 'Audit', client_contact: 'carol@other.test' });

    const entries: [string, string, string, string, number, boolean, boolean][] = [
      ['t1', 'engagement/e-bob-1', '2026-07-02', 'ENG-441', 60, true, false],
      ['t2', 'engagement/e-bob-1', '2026-07-09', 'ENG-441', 30, true, false],
      ['t3', 'engagement/e-bob-2', '2026-07-14', 'ENG-502', 45, true, false],
      ['t4', 'engagement/e-bob-2', '2026-07-20', 'ENG-502', 90, true, true],   // already billed
      ['t5', 'engagement/e-bob-1', '2026-07-21', 'ADMIN',  120, false, false], // not billable
      ['t6', 'engagement/e-carol', '2026-07-05', 'AUD-1',  200, true, false],  // another client
    ];
    for (const [id, ref, worked_on, task, minutes, billable, invoiced] of entries) {
      create(BILLABLE, 'entry', id, { engagement_ref: ref, worked_on, task, minutes, billable, invoiced });
    }

    create(JOBS, 'job', 'j1', { customer_email: 'bob@acme.test', status: 'in_progress', archived: false, due_at: '2026-08-01' });
    create(JOBS, 'job', 'j2', { customer_email: 'bob@acme.test', status: 'quoted', archived: false, due_at: '2026-08-10' });
    create(JOBS, 'job', 'j3', { customer_email: 'bob@acme.test', status: 'done', archived: true, due_at: '2026-06-01' });
  });
  afterEach(() => db.close());

  it('⛔ answers from EVERY installed pack that declared onto this root', () => {
    const out = readRootProjections(store, 'contact', 'bob@acme.test');
    expect(out.map(r => `${r.pack_slug}:${r.label}`))
      .toEqual(['billable-hours:Unbilled time', 'job-status-board:Open jobs']);
  });

  it('⛔ TRAVERSES the declared hop — entry → engagement → contact', () => {
    const [hours] = readRootProjections(store, 'contact', 'bob@acme.test');
    expect(hours!.value).toEqual({
      unbilled_minutes: 135,        // t1 60 + t2 30 + t3 45
      entry_count: 3,               // t4 billed, t5 not billable, t6 another client
      last_worked_on: '2026-07-14',
      last_task: 'ENG-502',
    });
    expect(hours!.complete).toBe(true);
  });

  it("⛔ another client's rows never reach this root — the join is real", () => {
    const [hours] = readRootProjections(store, 'contact', 'carol@other.test');
    expect(hours!.value.unbilled_minutes).toBe(200);   // only t6
    expect(hours!.value.entry_count).toBe(1);
    // and the witness that a broken join would fail: bob's 135 must not appear
    expect(hours!.value.unbilled_minutes).not.toBe(335);
  });

  it('resolves a projection whose key is on the base entity itself (via: [])', () => {
    const jobs = readRootProjections(store, 'contact', 'bob@acme.test')[1]!;
    expect(jobs.value).toEqual({ job_count: 2, last_status: 'quoted' });  // j3 archived
  });

  it("the pack's own `where` is applied — billed and non-billable work is excluded", () => {
    const [hours] = readRootProjections(store, 'contact', 'bob@acme.test');
    // 135 not 345: t4 (billed, 90) and t5 (non-billable, 120) are filtered out
    // by the DECLARATION, which core could not have written itself.
    expect(hours!.value.unbilled_minutes).toBe(135);
  });

  it('a contact with no work anywhere gets the empty-set contract, not an error', () => {
    const out = readRootProjections(store, 'contact', 'nobody@nowhere.test');
    expect(out).toHaveLength(2);
    expect(out[0]!.value).toEqual({
      unbilled_minutes: 0, entry_count: 0, last_worked_on: null, last_task: null,
    });
    expect(out[0]!.complete).toBe(true);   // an honest zero, not a bounded one
  });

  it('the root key is matched case-insensitively and trimmed', () => {
    const upper = readRootProjections(store, 'contact', '  BOB@ACME.TEST ');
    expect(upper[0]!.value.unbilled_minutes).toBe(135);
  });

  it('an empty key asks nothing rather than matching every blank field', () => {
    expect(readRootProjections(store, 'contact', '   ')).toEqual([]);
  });

  it('⛔ a projection declaring ANOTHER root does not answer for this one', () => {
    // The witness that separates the root filter from a blanket "answer
    // everything". RECORDS_ROOT_KINDS holds one member today, so no VALID
    // second root exists — but a pack installed under a later contract, or a
    // stale snapshot, can carry one, and it must stay silent here rather than
    // reporting its numbers as if they were about this contact.
    const FUTURE: RecordsPackRef = { publisher: 'third-party', pack_slug: 'deal-tracker' };
    store.installNamespace({
      owner: FUTURE, version: 1, storage_schema_hash: SH, declaration_hash: DH,
      artifact_digest: 'artifact-dt',
      schema: {
        decimal_scale: 4,
        entities: {
          deal: {
            kind: 'deal',
            roots: [{
              root: 'deal' as RecordsRootProjection['root'],   // not 'contact'
              via: [], key_field: 'owner_email', label: 'Deals',
              select: { deal_count: { fn: 'count' } },
            }],
            fields: [
              { key: 'id', slot: 'pk', kind: 'id', required: true },
              { key: 'owner_email', slot: 's1', kind: 'string', required: false },
            ],
          },
        },
      },
      bindings: { create_deal: bind(FUTURE, 'deal') },
    });
    create(FUTURE, 'deal', 'd1', { owner_email: 'bob@acme.test' });

    const out = readRootProjections(store, 'contact', 'bob@acme.test');
    expect(out.map(r => r.pack_slug)).toEqual(['billable-hours', 'job-status-board']);
    expect(out.some(r => r.pack_slug === 'deal-tracker')).toBe(false);
  });

  it('ordering is stable, so a root view does not reshuffle between refreshes', () => {
    const a = readRootProjections(store, 'contact', 'bob@acme.test').map(r => r.pack_slug);
    const b = readRootProjections(store, 'contact', 'bob@acme.test').map(r => r.pack_slug);
    expect(a).toEqual(b);
    expect(a).toEqual([...a].sort());
  });

  it('⛔⛔ a BOUNDED walk says so — it never under-reports as if it were whole', () => {
    // D-206's store nearly shipped a silent catastrophe twice by answering a
    // capped enumeration as the whole set. More engagements than the per-query
    // id cap must surface as `complete: false`, not as a smaller number.
    for (let i = 0; i < ROOT_PROJECTION_MAX_IDS_PER_QUERY + 5; i += 1) {
      create(BILLABLE, 'engagement', `bulk-${i}`, { label: `E${i}`, client_contact: 'many@acme.test' });
      create(BILLABLE, 'entry', `bulk-t-${i}`, {
        engagement_ref: `engagement/bulk-${i}`, worked_on: '2026-07-01',
        task: 'T', minutes: 10, billable: true, invoiced: false,
      });
    }
    const [hours] = readRootProjections(store, 'contact', 'many@acme.test');
    expect(hours!.complete).toBe(false);
    expect(hours!.incomplete_reason).toMatch(/more than/);
    // the number is still present, but it is explicitly NOT the whole answer
    expect(Number(hours!.value.unbilled_minutes)).toBeLessThan((ROOT_PROJECTION_MAX_IDS_PER_QUERY + 5) * 10);
  });
});

describe('validateRecordsRootProjection — refused at install, not at read time', () => {
  const entities = {
    engagement: { fields: [{ key: 'id', kind: 'id' }, { key: 'client_contact', kind: 'string' }] },
    entry: {
      fields: [
        { key: 'id', kind: 'id' }, { key: 'engagement_ref', kind: 'ref' },
        { key: 'minutes', kind: 'number' }, { key: 'note', kind: 'text' },
        { key: 'worked_on', kind: 'date' }, { key: 'task', kind: 'string' },
      ],
    },
  };
  const check = (p: unknown) => validateRecordsRootProjection(p, 'entry', entities);

  it('accepts the billable-hours shape', () => {
    expect(check({
      root: 'contact', via: [{ field: 'engagement_ref', entity: 'engagement' }],
      key_field: 'client_contact', select: { m: { fn: 'sum', field: 'minutes' } },
    })).toEqual([]);
  });

  it('refuses a hop through a non-ref field — it could never resolve', () => {
    expect(check({
      root: 'contact', via: [{ field: 'minutes', entity: 'engagement' }],
      key_field: 'client_contact', select: { m: { fn: 'count' } },
    })).toEqual([expect.stringContaining('only a ref can be a hop')]);
  });

  it('refuses a key_field that is not a string — it would silently never match', () => {
    expect(check({
      root: 'contact', via: [], key_field: 'minutes', select: { m: { fn: 'count' } },
    })).toEqual([expect.stringContaining('a root key must be a string')]);
  });

  it('refuses an unknown root — the list is closed on purpose', () => {
    expect(check({ root: 'deal', via: [], key_field: 'task', select: { m: { fn: 'count' } } })
      .some(p => p.includes('root'))).toBe(true);
  });

  it('runs the aggregate matrix against the BASE entity, not the final one', () => {
    // `client_contact` lives on engagement; a select naming it must be refused
    // because the select runs over ENTRY rows.
    expect(check({
      root: 'contact', via: [{ field: 'engagement_ref', entity: 'engagement' }],
      key_field: 'client_contact', select: { x: { fn: 'sum', field: 'client_contact' } },
    })).toEqual([expect.stringContaining("unknown field 'client_contact'")]);
  });

  it('refuses a where naming a field the base entity does not have', () => {
    expect(check({
      root: 'contact', via: [], key_field: 'task',
      where: { ghost: true }, select: { m: { fn: 'count' } },
    })).toEqual([expect.stringContaining("where: unknown field 'ghost'")]);
  });

  it('bounds the walk', () => {
    expect(check({
      root: 'contact', key_field: 'client_contact', select: { m: { fn: 'count' } },
      via: [
        { field: 'engagement_ref', entity: 'engagement' },
        { field: 'engagement_ref', entity: 'engagement' },
        { field: 'engagement_ref', entity: 'engagement' },
      ],
    })).toEqual([expect.stringContaining('at most 2 hops')]);
  });
});
