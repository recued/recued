/** D-192 S4c3 — Dynamics 365 engagement leaf tests.
 *
 *  Proves THE only Dynamics-specific code: the Dataverse OData delta mechanics
 *  (parse / classify / resync), the per-entity evidence-quality projection, the
 *  owner/regarding edge mapping, and — the payoff — the real leaf driving the real
 *  generic engagement reconciler end-to-end over a fake Dataverse fetch (drain →
 *  project → `ingestEngagementWithEdges`).
 *
 *  Spec: D-192 (S4c3). */

import { describe, expect, it } from 'vitest';

import type {
  ConnectionRecord,
  ConnectionVendorEntity,
  EngagementRow,
} from '@recued/contracts';

import {
  buildDataverseDeltaDeps,
  classifyDataverseActivity,
  DataverseError,
  isDataverseResync,
  parseDataverseDeltaPage,
  type DynamicsFetch,
  type DynamicsFetchResponse,
} from '../data/dynamics/odata-delta.js';
import {
  buildDynamicsEngagementLeaf,
  type DynamicsEngagementLeafDeps,
} from '../data/dynamics/engagement-leaf.js';
import {
  buildGenericEngagementReconciler,
  type GenericEngagementProjectInput,
  type GenericEngagementSlimRecord,
} from '../data/generic-engagement-reconciler.js';
import type { EngagementStore, UpsertEdgeInput } from '../storage/engagement-store.js';

const FIXED_NOW = 1_700_000_000_000; // 2023-11-14T22:13:20Z

// ────────────────────────────────────────────────────────────────
// Fakes
// ────────────────────────────────────────────────────────────────

const okResponse = (body: unknown): DynamicsFetchResponse => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
  json: async () => body,
});
const errResponse = (status: number, code?: string): DynamicsFetchResponse => ({
  ok: false,
  status,
  text: async () => JSON.stringify({ error: { code: code ?? 'x' } }),
  json: async () => ({ error: { code: code ?? 'x' } }),
});

/** A fake Dataverse fetch: returns the page mapped for a URL, or a fallback. Records
 *  the URLs requested so tests can assert the cold-start query + deltaLink follow. */
const fakeFetch = (
  pages: Record<string, unknown>,
  opts: { errorOn?: Record<string, { status: number; code?: string }> } = {},
): DynamicsFetch & { urls: string[] } => {
  const urls: string[] = [];
  const fn: DynamicsFetch = async (url, _init) => {
    urls.push(url);
    const err = opts.errorOn?.[url];
    if (err) return errResponse(err.status, err.code);
    return okResponse(pages[url] ?? { value: [] });
  };
  return Object.assign(fn, { urls });
};

const dynamicsEntity = (entity: string): ConnectionVendorEntity =>
  ({
    vendor: 'dynamics',
    entity,
    scope: `connection.api.dynamics.${entity}`,
    display_name: `dynamics ${entity}`,
    meta_fields: [
      { key: 'id', type: 'string', description: 'id', source_path: 'activityid' },
      { key: 'subject', type: 'string', description: 'subject', source_path: 'subject' },
    ],
    engagement: { capability: 'always', sync_kind: 'delta_cursor' },
  }) as unknown as ConnectionVendorEntity;

const conn = (name = 'acme-dynamics'): ConnectionRecord => ({
  name,
  kind: 'api',
  display_name: name,
  config: { base_url: 'https://acme.crm.dynamics.com/api/data/v9.2' },
  auth: { type: 'bearer', token: 'tok' },
  enrolled_at: 1,
  updated_at: 1,
});

const projectInput = (raw: Record<string, unknown>, over: Partial<GenericEngagementProjectInput> = {}): GenericEngagementProjectInput => ({
  connection_id: 'acme-dynamics',
  raw,
  target_id: `dynamics_x_${String(raw.activityid ?? 'id')}`,
  meta: {},
  now: FIXED_NOW,
  ...over,
});

interface StoreSpy {
  store: EngagementStore;
  ingests: Array<{ row: EngagementRow; edges: ReadonlyArray<UpsertEdgeInput> }>;
  tombstones: Array<{ target_id: string }>;
}
const fakeEngagementStore = (): StoreSpy => {
  const ingests: StoreSpy['ingests'] = [];
  const tombstones: StoreSpy['tombstones'] = [];
  const store = {
    ingestEngagementWithEdges: (input: { row: EngagementRow; edges: ReadonlyArray<UpsertEdgeInput> }) => {
      ingests.push({ row: input.row, edges: input.edges });
      return { row: input.row, edges_upserted: input.edges.length, edges_tombstoned: 0, dedupe_candidates_upserted: 0, stale_modstamp: false };
    },
    tombstone: (input: { target_id: string }) => {
      tombstones.push({ target_id: input.target_id });
      return true;
    },
  } as unknown as EngagementStore;
  return { store, ingests, tombstones };
};

const leafFor = (entity: string, fetch: DynamicsFetch, over: Partial<DynamicsEngagementLeafDeps> = {}) =>
  buildDynamicsEngagementLeaf(dynamicsEntity(entity), { fetch, ...over });

// ────────────────────────────────────────────────────────────────
// OData delta mechanics
// ────────────────────────────────────────────────────────────────

describe('D-192 S4c3 — Dataverse OData delta mechanics', () => {
  it('parseDataverseDeltaPage maps value/nextLink/deltaLink; throws on malformed', () => {
    expect(parseDataverseDeltaPage({ value: [{ activityid: 'a' }], '@odata.nextLink': 'N', '@odata.deltaLink': 'D' }))
      .toEqual({ items: [{ activityid: 'a' }], nextRef: 'N', watermark: 'D' });
    expect(parseDataverseDeltaPage({ value: [] })).toEqual({ items: [] });
    expect(() => parseDataverseDeltaPage({})).toThrow(DataverseError); // no value array
    expect(() => parseDataverseDeltaPage(null)).toThrow(DataverseError);
    expect(() => parseDataverseDeltaPage([1, 2])).toThrow(DataverseError);
  });

  it('classifyDataverseActivity distinguishes live activity, $deletedEntity tombstone, and skip', () => {
    expect(classifyDataverseActivity({ activityid: 'g1', subject: 's' })).toEqual({ kind: 'file', id: 'g1', row: { activityid: 'g1', subject: 's' } });
    // Deleted refs: reason marker, $deletedEntity context, and @removed — all keyed on `id`.
    expect(classifyDataverseActivity({ id: 'g2', reason: 'deleted' })).toEqual({ kind: 'deleted', id: 'g2' });
    expect(classifyDataverseActivity({ '@odata.context': 'https://x/$metadata#emails/$deletedEntity', id: 'g3' })).toEqual({ kind: 'deleted', id: 'g3' });
    expect(classifyDataverseActivity({ '@removed': { reason: 'deleted' }, id: 'g4' })).toEqual({ kind: 'deleted', id: 'g4' });
    expect(classifyDataverseActivity({ subject: 'no id' })).toEqual({ kind: 'skip' });
    expect(classifyDataverseActivity(null)).toEqual({ kind: 'skip' });
  });

  it('isDataverseResync fires on 410, not on a normal error', () => {
    expect(isDataverseResync(new DataverseError(410, undefined, 'gone'))).toBe(true);
    expect(isDataverseResync(new DataverseError(500, undefined, 'boom'))).toBe(false);
    expect(isDataverseResync(new Error('other'))).toBe(false);
  });

  it('buildDataverseDeltaDeps fetchPage sends Bearer auth + surfaces a 410 as DataverseError', async () => {
    const fetch = fakeFetch({ 'https://x/emails': { value: [{ activityid: 'a' }] } });
    const deps = buildDataverseDeltaDeps(fetch, 'tok');
    const page = deps.parsePage(await deps.fetchPage('https://x/emails'));
    expect(page.items).toEqual([{ activityid: 'a' }]);

    const failing = buildDataverseDeltaDeps(fakeFetch({}, { errorOn: { 'https://x/gone': { status: 410 } } }), 'tok');
    await expect(failing.fetchPage('https://x/gone')).rejects.toBeInstanceOf(DataverseError);
  });
});

// ────────────────────────────────────────────────────────────────
// Leaf — pure surface
// ────────────────────────────────────────────────────────────────

describe('D-192 S4c3 — Dynamics leaf pure surface', () => {
  it('coldStartRef builds the entity-set $select delta query per entity', () => {
    expect(leafFor('email', fakeFetch({})).coldStartRef(conn())).toBe(
      'https://acme.crm.dynamics.com/api/data/v9.2/emails?$select=activityid,modifiedon,createdon,statecode,subject,directioncode,senton,description,torecipients,sender,_ownerid_value,_regardingobjectid_value',
    );
    expect(leafFor('task', fakeFetch({})).coldStartRef(conn())).toContain('/tasks?$select=');
    expect(leafFor('appointment', fakeFetch({})).coldStartRef(conn())).toContain('/appointments?$select=');
    expect(leafFor('phonecall', fakeFetch({})).coldStartRef(conn())).toContain('/phonecalls?$select=');
  });

  it('composeTargetId / readNativeId / readModifiedAt', () => {
    const leaf = leafFor('email', fakeFetch({}));
    expect(leaf.composeTargetId('GUID')).toBe('dynamics_email_GUID');
    expect(leaf.readNativeId({ activityid: 'G' })).toBe('G');
    expect(leaf.readNativeId({})).toBeNull();
    expect(leaf.readModifiedAt({ modifiedon: '2023-11-14T00:00:00Z' })).toBe(Date.parse('2023-11-14T00:00:00Z'));
    expect(leaf.readModifiedAt({})).toBe(0);
  });

  it('throws on an unsupported engagement entity', () => {
    expect(() => leafFor('letter', fakeFetch({}))).toThrow(/unsupported Dynamics engagement entity/);
  });

  it('buildDelta throws when the connection has no usable token', () => {
    const leaf = leafFor('email', fakeFetch({}));
    const noAuth = { ...conn(), auth: { type: 'none' } } as unknown as ConnectionRecord;
    expect(() => leaf.buildDelta(noAuth)).toThrow(/no usable access token/);
  });
});

// ────────────────────────────────────────────────────────────────
// Projection — per-entity evidence-quality state machines
// ────────────────────────────────────────────────────────────────

describe('D-192 S4c3 — Dynamics projection', () => {
  it('email: direction from directioncode, point_in_time at senton, inline body, UTC-inferred tz', () => {
    const leaf = leafFor('email', fakeFetch({}));
    const row = leaf.project(projectInput({
      activityid: 'e1', subject: 'Hi', directioncode: true, senton: '2023-10-01T12:00:00Z',
      description: 'body text', createdon: '2023-09-30T00:00:00Z', modifiedon: '2023-10-01T12:05:00Z',
    }));
    expect(row.vendor).toBe('dynamics');
    expect(row.entity).toBe('email');
    expect(row.direction).toBe('outbound');
    expect(row.lifecycle_state).toBe('point_in_time');
    expect(row.event_at).toBe(Date.parse('2023-10-01T12:00:00Z'));
    expect(row.body_state).toBe('inline_body');
    expect(row.body_inline).toBe('body text');
    expect(row.event_at_tz_hint).toBe('UTC');
    expect(row.event_at_tz_inferred).toBe(true);
    expect(row.vendor_modstamp).toBe('2023-10-01T12:05:00Z');
  });

  it('email: inbound + cancelled draft (statecode 2)', () => {
    const row = leafFor('email', fakeFetch({})).project(projectInput({ activityid: 'e2', directioncode: false, statecode: 2 }));
    expect(row.direction).toBe('inbound');
    expect(row.lifecycle_state).toBe('cancelled');
  });

  it('task: statecode → lifecycle; completed carries event_at=actualend + due_at=scheduledend', () => {
    const done = leafFor('task', fakeFetch({})).project(projectInput({
      activityid: 't1', statecode: 1, actualend: '2023-10-05T09:00:00Z', scheduledend: '2023-10-04T00:00:00Z',
    }));
    expect(done.lifecycle_state).toBe('completed');
    expect(done.event_at).toBe(Date.parse('2023-10-05T09:00:00Z'));
    expect(done.completed_at).toBe(Date.parse('2023-10-05T09:00:00Z'));
    expect(done.due_at).toBe(Date.parse('2023-10-04T00:00:00Z'));
    expect(done.direction).toBe('internal');

    const pending = leafFor('task', fakeFetch({})).project(projectInput({ activityid: 't2', statecode: 0, scheduledend: '2030-01-01T00:00:00Z' }));
    expect(pending.lifecycle_state).toBe('pending');
    expect(pending.event_at).toBeNull(); // not yet occurred
    expect(pending.due_at).toBe(Date.parse('2030-01-01T00:00:00Z'));

    const cancelled = leafFor('task', fakeFetch({})).project(projectInput({ activityid: 't3', statecode: 2 }));
    expect(cancelled.lifecycle_state).toBe('cancelled');
  });

  it('appointment: time-based completed/scheduled; statecode 3 (Scheduled) stays scheduled; statecode 2 = cancelled', () => {
    const leaf = leafFor('appointment', fakeFetch({}));
    const past = leaf.project(projectInput({ activityid: 'a1', scheduledstart: '2023-01-01T10:00:00Z' }, { now: FIXED_NOW }));
    expect(past.lifecycle_state).toBe('completed');
    expect(past.event_at).toBe(Date.parse('2023-01-01T10:00:00Z'));
    expect(past.scheduled_start_at).toBe(Date.parse('2023-01-01T10:00:00Z'));

    const future = leaf.project(projectInput({ activityid: 'a2', scheduledstart: '2030-01-01T10:00:00Z' }, { now: FIXED_NOW }));
    expect(future.lifecycle_state).toBe('scheduled');
    expect(future.event_at).toBeNull();

    // statecode 3 = Scheduled — a FUTURE appointment must NOT read as completed
    // (the bug Codex caught: `3` is Scheduled in Dataverse, not Completed).
    const scheduledStatecode = leaf.project(projectInput({ activityid: 'a3', statecode: 3, scheduledstart: '2030-01-01T10:00:00Z' }, { now: FIXED_NOW }));
    expect(scheduledStatecode.lifecycle_state).toBe('scheduled');
    expect(scheduledStatecode.event_at).toBeNull();

    // statecode 2 = Canceled — cancelled + event_at null even with a PAST start (it didn't occur).
    const cancelled = leaf.project(projectInput({ activityid: 'a4', statecode: 2, scheduledstart: '2023-01-01T10:00:00Z' }, { now: FIXED_NOW }));
    expect(cancelled.lifecycle_state).toBe('cancelled');
    expect(cancelled.event_at).toBeNull();
    expect(cancelled.scheduled_start_at).toBe(Date.parse('2023-01-01T10:00:00Z'));
  });

  it('phonecall: direction from directioncode, event_at at actualstart', () => {
    const row = leafFor('phonecall', fakeFetch({})).project(projectInput({ activityid: 'p1', directioncode: false, actualstart: '2023-10-02T08:00:00Z' }));
    expect(row.direction).toBe('inbound');
    expect(row.lifecycle_state).toBe('point_in_time');
    expect(row.event_at).toBe(Date.parse('2023-10-02T08:00:00Z'));
  });
});

// ────────────────────────────────────────────────────────────────
// Edges — owner + regarding
// ────────────────────────────────────────────────────────────────

describe('D-192 S4c3 — Dynamics edges', () => {
  it('maps owner (user) + regarding contact/account/opportunity, with a contact redirect', () => {
    const leaf = leafFor('email', fakeFetch({}));
    const edges = leaf.mapEdges({
      connection_id: 'acme-dynamics',
      target_id: 'dynamics_email_e1',
      now: FIXED_NOW,
      raw: {
        _ownerid_value: 'owner-guid',
        _regardingobjectid_value: 'contact-guid',
        '_regardingobjectid_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'contact',
      },
    });
    expect(edges).toHaveLength(2);
    const owner = edges.find((e) => e.edge_type === 'owner')!;
    expect(owner.target_kind).toBe('user');
    expect(owner.target_id).toBe('dynamics_user:owner-guid');
    const contact = edges.find((e) => e.edge_type === 'contact')!;
    expect(contact.target_kind).toBe('connection.api');
    expect(contact.target_id).toContain('dynamics_contact_');
    expect(contact.resolveContactRedirect).toBeTypeOf('function'); // required on contact edges

    const acct = leaf.mapEdges({ connection_id: 'c', target_id: 't', now: 1, raw: { _regardingobjectid_value: 'g', '_regardingobjectid_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'account' } });
    expect(acct[0].edge_type).toBe('account');
    const opp = leaf.mapEdges({ connection_id: 'c', target_id: 't', now: 1, raw: { _regardingobjectid_value: 'g', '_regardingobjectid_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'opportunity' } });
    expect(opp[0].edge_type).toBe('deal');
  });

  it('emits no edges for an unknown regarding type or a bare activity', () => {
    const leaf = leafFor('task', fakeFetch({}));
    expect(leaf.mapEdges({ connection_id: 'c', target_id: 't', now: 1, raw: {} })).toEqual([]);
    expect(leaf.mapEdges({ connection_id: 'c', target_id: 't', now: 1, raw: { _regardingobjectid_value: 'g', '_regardingobjectid_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'systemuser' } })).toEqual([]);
  });

  it('email emits data.contact EMAIL edges from sender + torecipients — the scoring linkage (deduped, canonicalized)', () => {
    const leaf = leafFor('email', fakeFetch({}));
    const edges = leaf.mapEdges({
      connection_id: 'acme-dynamics',
      target_id: 'dynamics_email_e1',
      now: FIXED_NOW,
      raw: {
        sender: 'Rep@Acme.com',
        torecipients: 'buyer@acme.example; cc@acme.example; Rep@Acme.com', // sender repeats → deduped
      },
    });
    const contactEdges = edges.filter((e) => e.edge_type === 'contact' && e.target_kind === 'data.contact');
    // The join key the `data.contact.engagements` resolver matches on is the canonical EMAIL.
    expect(contactEdges.map((e) => e.target_id).sort()).toEqual(['buyer@acme.example', 'cc@acme.example', 'rep@acme.com']);
    for (const e of contactEdges) expect(e.resolveContactRedirect).toBeTypeOf('function'); // store requires it on data.contact edges
  });

  it('email SKIPS malformed / display-name-only participants (strict canonicalize — no bad edge reaches the store)', () => {
    const edges = leafFor('email', fakeFetch({})).mapEdges({
      connection_id: 'c',
      target_id: 't',
      now: FIXED_NOW,
      raw: {
        // a multi-@ garbage address, a bare display name (no @), and an empty entry —
        // all invalid; only the well-formed address survives.
        torecipients: 'buyer@@example.com; Bob Smith; ; good@acme.example',
        sender: 'not-an-email',
      },
    });
    const contactTargets = edges.filter((e) => e.edge_type === 'contact').map((e) => e.target_id);
    expect(contactTargets).toEqual(['good@acme.example']); // the store would throw on any of the dropped ones
  });

  it('a non-email activity emits NO data.contact email edges (torecipients is email-only)', () => {
    const edges = leafFor('task', fakeFetch({})).mapEdges({
      connection_id: 'c',
      target_id: 't',
      now: 1,
      raw: { torecipients: 'x@y.com', sender: 'a@b.com', _ownerid_value: 'o' },
    });
    expect(edges.filter((e) => e.target_kind === 'data.contact')).toEqual([]);
    expect(edges.map((e) => e.edge_type)).toEqual(['owner']); // owner only
  });
});

// ────────────────────────────────────────────────────────────────
// Integration — the REAL leaf driving the REAL generic reconciler
// ────────────────────────────────────────────────────────────────

describe('D-192 S4c3 — end-to-end: Dynamics leaf + generic reconciler', () => {
  it('drains a Dataverse email delta → projects + ingests activities, tombstones deletes, advances the deltaLink', async () => {
    const spy = fakeEngagementStore();
    const entity = dynamicsEntity('email');
    const coldUrl = buildDynamicsEngagementLeaf(entity, { fetch: fakeFetch({}) }).coldStartRef(conn());
    const fetch = fakeFetch({
      [coldUrl]: {
        value: [
          { activityid: 'g1', subject: 'Deal follow-up', directioncode: true, senton: '2023-10-01T12:00:00Z', modifiedon: '2023-10-01T12:00:00Z', _ownerid_value: 'owner-1' },
          { '@odata.context': 'https://x/$metadata#emails/$deletedEntity', id: 'g2', reason: 'deleted' },
        ],
        '@odata.deltaLink': 'https://acme.crm.dynamics.com/api/data/v9.2/emails?$deltatoken=W1',
      },
    });
    const leaf = buildDynamicsEngagementLeaf(entity, { fetch });
    const r = buildGenericEngagementReconciler({ entity, engagementStore: spy.store, leaf, now: () => FIXED_NOW });

    // Drive one cold cycle the way the harness does.
    r.delta!.loadStartRef('acme-dynamics', '');
    const slims: GenericEngagementSlimRecord[] = [];
    for await (const s of r.listUpdatedSince(conn(), 0, 100)) slims.push(s as GenericEngagementSlimRecord);
    for (const s of slims) r.selfIngest!(conn(), 'acme-dynamics', s);
    const watermark = r.delta!.takeWatermark('acme-dynamics');

    // The live activity ingested as a projected engagement row (+ owner edge); the
    // $deletedEntity tombstoned; the deltaLink is the persisted cursor.
    expect(spy.ingests.map((i) => i.row.target_id)).toEqual(['dynamics_email_g1']);
    expect(spy.ingests[0].row.entity).toBe('email');
    expect(spy.ingests[0].row.direction).toBe('outbound');
    expect(spy.ingests[0].row.event_at).toBe(Date.parse('2023-10-01T12:00:00Z'));
    expect(spy.ingests[0].row.meta).toEqual({ id: 'g1', subject: 'Deal follow-up' }); // declarative flat meta
    expect(spy.ingests[0].edges.map((e) => e.target_id)).toEqual(['dynamics_user:owner-1']);
    expect(spy.tombstones).toEqual([{ target_id: 'dynamics_email_g2' }]);
    expect(watermark).toBe('https://acme.crm.dynamics.com/api/data/v9.2/emails?$deltatoken=W1');
    expect(fetch.urls[0]).toBe(coldUrl); // cold start hit the $select query, not a deltaLink
  });

  it('a warm cycle drains from the stored deltaLink, not the cold query', async () => {
    const spy = fakeEngagementStore();
    const entity = dynamicsEntity('task');
    const deltaLink = 'https://acme.crm.dynamics.com/api/data/v9.2/tasks?$deltatoken=W1';
    const fetch = fakeFetch({
      [deltaLink]: {
        value: [{ activityid: 'tk9', subject: 'Renewal', statecode: 1, actualend: '2023-10-06T09:00:00Z', modifiedon: '2023-10-06T09:00:00Z' }],
        '@odata.deltaLink': 'https://acme.crm.dynamics.com/api/data/v9.2/tasks?$deltatoken=W2',
      },
    });
    const leaf = buildDynamicsEngagementLeaf(entity, { fetch });
    const r = buildGenericEngagementReconciler({ entity, engagementStore: spy.store, leaf, now: () => FIXED_NOW });

    r.delta!.loadStartRef('acme-dynamics', deltaLink); // warm
    const slims: GenericEngagementSlimRecord[] = [];
    for await (const s of r.listUpdatedSince(conn(), 0, 100)) slims.push(s as GenericEngagementSlimRecord);
    for (const s of slims) r.selfIngest!(conn(), 'acme-dynamics', s);

    expect(fetch.urls[0]).toBe(deltaLink); // drained the stored deltaLink verbatim
    expect(spy.ingests.map((i) => i.row.target_id)).toEqual(['dynamics_task_tk9']);
    expect(spy.ingests[0].row.lifecycle_state).toBe('completed');
    expect(r.delta!.takeWatermark('acme-dynamics')).toBe('https://acme.crm.dynamics.com/api/data/v9.2/tasks?$deltatoken=W2');
  });

  it('reset recovery: a warm 410 re-drains from the cold $select query', async () => {
    const spy = fakeEngagementStore();
    const entity = dynamicsEntity('email');
    const coldUrl = leafFor('email', fakeFetch({})).coldStartRef(conn());
    const stale = 'https://acme.crm.dynamics.com/api/data/v9.2/emails?$deltatoken=STALE';
    const fetch = fakeFetch(
      { [coldUrl]: { value: [{ activityid: 'fresh', subject: 'rebuilt', senton: '2023-10-01T00:00:00Z', modifiedon: '2023-10-01T00:00:00Z' }], '@odata.deltaLink': 'D2' } },
      { errorOn: { [stale]: { status: 410 } } },
    );
    const leaf = buildDynamicsEngagementLeaf(entity, { fetch });
    const r = buildGenericEngagementReconciler({ entity, engagementStore: spy.store, leaf, now: () => FIXED_NOW });

    r.delta!.loadStartRef('acme-dynamics', stale); // warm but expired
    const slims: GenericEngagementSlimRecord[] = [];
    for await (const s of r.listUpdatedSince(conn(), 0, 100)) slims.push(s as GenericEngagementSlimRecord);
    for (const s of slims) r.selfIngest!(conn(), 'acme-dynamics', s);

    expect(fetch.urls).toEqual([stale, coldUrl]); // 410 on the stale token → recover from cold
    expect(spy.ingests.map((i) => i.row.target_id)).toEqual(['dynamics_email_fresh']);
    expect(r.delta!.takeWatermark('acme-dynamics')).toBe('D2');
  });
});
