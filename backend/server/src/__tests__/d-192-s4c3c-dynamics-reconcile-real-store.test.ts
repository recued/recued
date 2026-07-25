/** D-192 S4c3c — Dynamics reconcile through the REAL engagement store.
 *
 *  S4c3a proved the leaf drives the generic reconciler over a MOCK engagement store
 *  (spy captures). This closes the gap the mock can't: the projected rows + edges
 *  actually pass the REAL `ingestEngagementWithEdges` — its `validateRow`
 *  evidence-quality checks, the atomic row+edge write, the `edge_type:'contact'`
 *  `resolveContactRedirect` requirement, and the delete tombstone path. The
 *  reconcile→score join beyond this is vendor-agnostic (the aggregation reads
 *  standard engagement rows regardless of vendor — covered by the D-139 hb/sf
 *  suites) and its contact-identity leg is a documented follow-up (the leaf's
 *  contact-redirect is a no-op until the live contact store is threaded).
 *
 *  Spec: D-192 (S4c3). */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConnectionRecord, ConnectionVendorEntity } from '@recued/contracts';

import { buildDynamicsEngagementLeaf } from '../data/dynamics/engagement-leaf.js';
import type { DynamicsFetch, DynamicsFetchResponse } from '../data/dynamics/odata-delta.js';
import {
  buildGenericEngagementReconciler,
  type GenericEngagementSlimRecord,
} from '../data/generic-engagement-reconciler.js';
import { createEngagementStore, type EngagementStore } from '../storage/engagement-store.js';

const FIXED_NOW = 1_700_000_000_000;

const okResponse = (body: unknown): DynamicsFetchResponse => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
  json: async () => body,
});

const fakeFetch = (pages: Record<string, unknown>): DynamicsFetch & { urls: string[] } => {
  const urls: string[] = [];
  const fn: DynamicsFetch = async (url, _init) => {
    urls.push(url);
    return okResponse(pages[url] ?? { value: [] });
  };
  return Object.assign(fn, { urls });
};

const dynamicsEmail = (): ConnectionVendorEntity =>
  ({
    vendor: 'dynamics',
    entity: 'email',
    scope: 'connection.api.dynamics.email',
    display_name: 'dynamics email',
    meta_fields: [
      { key: 'id', type: 'string', description: 'id', source_path: 'activityid' },
      { key: 'subject', type: 'string', description: 'subject', source_path: 'subject' },
    ],
    engagement: { capability: 'always', sync_kind: 'delta_cursor' },
  }) as unknown as ConnectionVendorEntity;

const conn = (): ConnectionRecord => ({
  name: 'acme-dynamics',
  kind: 'api',
  display_name: 'acme-dynamics',
  config: { base_url: 'https://acme.crm.dynamics.com/api/data/v9.2' },
  auth: { type: 'bearer', token: 'tok' },
  enrolled_at: 1,
  updated_at: 1,
});

/** Drive one reconcile cycle the way the harness does. */
const driveOnce = async (
  reconciler: ReturnType<typeof buildGenericEngagementReconciler>,
  priorToken: string,
): Promise<string | null> => {
  reconciler.delta!.loadStartRef('acme-dynamics', priorToken);
  const slims: GenericEngagementSlimRecord[] = [];
  for await (const s of reconciler.listUpdatedSince(conn(), 0, 100)) slims.push(s as GenericEngagementSlimRecord);
  for (const s of slims) reconciler.selfIngest!(conn(), 'acme-dynamics', s);
  return reconciler.delta!.takeWatermark('acme-dynamics');
};

// Derived from the leaf so a $select change can't silently desync the fake fetch.
const COLD_URL = buildDynamicsEngagementLeaf(dynamicsEmail(), { fetch: fakeFetch({}) }).coldStartRef(conn());

describe('D-192 S4c3c — Dynamics reconcile through the real engagement store', () => {
  let db: Database.Database;
  let store: EngagementStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createEngagementStore(db, { now: () => FIXED_NOW });
  });
  afterEach(() => {
    db.close();
  });

  it('cold reconcile persists projected email rows + owner/contact edges via ingestEngagementWithEdges', async () => {
    const entity = dynamicsEmail();
    const fetch = fakeFetch({
      [COLD_URL]: {
        value: [
          {
            activityid: 'g1',
            subject: 'Deal follow-up',
            directioncode: true,
            senton: '2023-10-01T12:00:00Z',
            modifiedon: '2023-10-01T12:00:00Z',
            createdon: '2023-09-30T00:00:00Z',
            sender: 'rep@acme.example',
            torecipients: 'buyer@acme.example',
            _ownerid_value: 'owner-1',
            _regardingobjectid_value: 'contact-9',
            '_regardingobjectid_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'contact',
          },
          { activityid: 'g3', subject: 'Second', modifiedon: '2023-10-02T00:00:00Z' },
        ],
        '@odata.deltaLink': 'https://acme.crm.dynamics.com/api/data/v9.2/emails?$deltatoken=W1',
      },
    });
    const leaf = buildDynamicsEngagementLeaf(entity, { fetch });
    const r = buildGenericEngagementReconciler({ entity, engagementStore: store, leaf, now: () => FIXED_NOW });

    const watermark = await driveOnce(r, '');

    // The real store accepted + persisted the projected rows (validateRow passed).
    const g1 = store.get('acme-dynamics', 'dynamics_email_g1');
    expect(g1).not.toBeNull();
    expect(g1!.entity).toBe('email');
    expect(g1!.direction).toBe('outbound');
    expect(g1!.lifecycle_state).toBe('point_in_time');
    expect(g1!.event_at).toBe(Date.parse('2023-10-01T12:00:00Z'));
    expect(g1!.meta).toEqual({ id: 'g1', subject: 'Deal follow-up' });
    expect(store.get('acme-dynamics', 'dynamics_email_g3')).not.toBeNull();

    // The owner + participant-email + regarding edges persisted atomically.
    const edges = store.listEdges({ connection_id: 'acme-dynamics', engagement_target_id: 'dynamics_email_g1' });
    expect(edges.find((e) => e.edge_type === 'owner')!.target_id).toBe('dynamics_user:owner-1');

    // THE reconcile→score linkage: the email's participant `data.contact` edges carry
    // the canonical EMAILS, so the engagement is discoverable by the SAME key the
    // `data.contact.engagements` resolver (and thus the score cycle) joins on —
    // `edge_type='contact' AND target_id IN (<contact emails>)`.
    const byBuyer = store.listEdges({ edge_type: 'contact', target_kind: 'data.contact', target_id: 'buyer@acme.example' });
    expect(byBuyer.map((e) => e.engagement_target_id)).toContain('dynamics_email_g1');
    const bySender = store.listEdges({ edge_type: 'contact', target_kind: 'data.contact', target_id: 'rep@acme.example' });
    expect(bySender.map((e) => e.engagement_target_id)).toContain('dynamics_email_g1');

    expect(watermark).toBe('https://acme.crm.dynamics.com/api/data/v9.2/emails?$deltatoken=W1');
  });

  it('a malformed recipient does NOT abort the ingest — the engagement + valid contact edge still persist', async () => {
    // The store resolves every data.contact edge through resolveContactIdentity in
    // one transaction — a single garbage address would throw + drop the whole email
    // (and, since selfIngest throws uncaught, the reconcile step). The leaf's strict
    // pre-canonicalization must drop the bad one so the ingest survives.
    const entity = dynamicsEmail();
    const fetch = fakeFetch({
      [COLD_URL]: {
        value: [
          {
            activityid: 'gm',
            subject: 'Mixed recipients',
            modifiedon: '2023-10-01T00:00:00Z',
            torecipients: 'buyer@@bad; valid@acme.example',
            sender: 'garbage-no-at',
          },
        ],
        '@odata.deltaLink': 'https://acme.crm.dynamics.com/api/data/v9.2/emails?$deltatoken=W1',
      },
    });
    const leaf = buildDynamicsEngagementLeaf(entity, { fetch });
    const r = buildGenericEngagementReconciler({ entity, engagementStore: store, leaf, now: () => FIXED_NOW });

    await driveOnce(r, ''); // must not throw

    expect(store.get('acme-dynamics', 'dynamics_email_gm')).not.toBeNull(); // row survived
    const contactEdges = store
      .listEdges({ connection_id: 'acme-dynamics', engagement_target_id: 'dynamics_email_gm' })
      .filter((e) => e.edge_type === 'contact');
    expect(contactEdges.map((e) => e.target_id)).toEqual(['valid@acme.example']); // only the well-formed one
  });

  it('a later $deletedEntity delta tombstones the engagement row through the real store', async () => {
    const entity = dynamicsEmail();
    const deltaLink = 'https://acme.crm.dynamics.com/api/data/v9.2/emails?$deltatoken=W1';
    const fetch = fakeFetch({
      [COLD_URL]: {
        value: [{ activityid: 'g1', subject: 'Live', modifiedon: '2023-10-01T00:00:00Z' }],
        '@odata.deltaLink': deltaLink,
      },
      [deltaLink]: {
        value: [{ '@odata.context': 'https://x/$metadata#emails/$deletedEntity', id: 'g1', reason: 'deleted' }],
        '@odata.deltaLink': 'https://acme.crm.dynamics.com/api/data/v9.2/emails?$deltatoken=W2',
      },
    });
    const leaf = buildDynamicsEngagementLeaf(entity, { fetch });
    const r = buildGenericEngagementReconciler({ entity, engagementStore: store, leaf, now: () => FIXED_NOW });

    // Cycle 1 — ingest g1.
    const w1 = await driveOnce(r, '');
    expect(store.get('acme-dynamics', 'dynamics_email_g1')?.deleted_at).toBeUndefined();

    // Cycle 2 (warm) — the delta reports g1 deleted; the real store tombstones it.
    await driveOnce(r, w1 ?? '');
    const tombstoned = store.get('acme-dynamics', 'dynamics_email_g1');
    expect(tombstoned).not.toBeNull();
    expect(tombstoned!.deleted_at).toBeTypeOf('number'); // soft-delete tombstone
  });
});
