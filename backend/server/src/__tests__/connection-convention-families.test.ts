/** D-182 §10 step 8 / R1 — `deriveBoundConventionFamilies` + `liveVendorRegistry`
 *  tests.
 *
 *  The single derivation both R1 halves consume (enforcement in `handleExecute`,
 *  disclosure in `recipe.runnability`). Pins: it scans `kind: 'api'` only,
 *  resolves the vendor (config `vendor` first, then the `subtype` fallback), maps
 *  through a vendor registry, and de-dups. With the DEFAULT (built-in) registry
 *  HubSpot / Salesforce lift `crm` and nothing lifts `acct`. Fix 2 threads the
 *  LIVE merged registry (`liveVendorRegistry`: built-ins + each installed pack's
 *  decomposed `crm_alias`/`acct_alias` entities) so a connected `acct` vendor
 *  (QuickBooks / Xero) or a 3rd-party CRM pack vendor binds its family.
 */
import { describe, it, expect } from 'vitest';
import type {
  ConnectionRow,
  ConnectionVendorEntity,
  EntitySchemaIngredientInput,
  IngredientManifest,
} from '@recued/contracts';
import { CONNECTION_VENDOR_ENTITIES, engagementSyncKind } from '@recued/contracts';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';
import type { LocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import {
  deriveBoundConventionFamilies,
  deriveBoundCrmConnections,
  syncedAtFromReconcileState,
  liveVendorRegistry,
} from '../connection-convention-families.js';

const mkRow = (
  name: string,
  vendor: string | null,
  extra: Partial<ConnectionRow> = {},
): ConnectionRow => ({
  pk: `api:${name}`,
  kind: 'api',
  name,
  display_name: name,
  config_json: vendor === null ? '{}' : JSON.stringify({ vendor }),
  auth_ciphertext: '',
  enrolled_at: 0,
  updated_at: 0,
  ...extra,
});

/** A connection-store fake that honours the `kind` filter — so a test can prove
 *  the derivation scans `api` rows ONLY. */
const storeOf = (rows: ConnectionRow[]): Pick<ConnectionStoreSqlite, 'list'> => ({
  list: (query) => (query?.kind ? rows.filter((r) => r.kind === query.kind) : rows),
});

const families = (rows: ConnectionRow[]) => [...deriveBoundConventionFamilies(storeOf(rows))].sort();

describe('deriveBoundConventionFamilies', () => {
  it('an undefined store → empty set (fail-safe: nothing connected)', () => {
    expect([...deriveBoundConventionFamilies(undefined)]).toEqual([]);
  });

  it('no connections → empty set', () => {
    expect(families([])).toEqual([]);
  });

  it('a HubSpot api connection binds the crm family', () => {
    expect(families([mkRow('hs', 'hubspot')])).toEqual(['crm']);
  });

  it('a Salesforce api connection binds the crm family', () => {
    expect(families([mkRow('sf', 'salesforce')])).toEqual(['crm']);
  });

  it('resolves the vendor from the `subtype` fallback when config carries none', () => {
    expect(families([mkRow('hs', null, { subtype: 'hubspot' })])).toEqual(['crm']);
  });

  it('a connection with no resolvable vendor contributes nothing', () => {
    expect(families([mkRow('mystery', null)])).toEqual([]);
  });

  it('a non-canonical vendor (e.g. slack) contributes nothing', () => {
    expect(families([mkRow('slack', 'slack')])).toEqual([]);
  });

  it('a connected acct vendor (QuickBooks/Xero) does NOT bind acct — no built-in acct vendor', () => {
    expect(families([mkRow('qb', 'quickbooks'), mkRow('xr', 'xero')])).toEqual([]);
  });

  it('multiple crm vendors de-dup to a single `crm` entry', () => {
    expect(families([mkRow('hs', 'hubspot'), mkRow('sf', 'salesforce')])).toEqual(['crm']);
  });

  it('a mixed set keeps only the canonical families (crm from HubSpot, nothing from QuickBooks)', () => {
    expect(families([mkRow('hs', 'hubspot'), mkRow('qb', 'quickbooks'), mkRow('slack', 'slack')])).toEqual([
      'crm',
    ]);
  });

  it('scans `kind: api` ONLY — a vendor-bearing non-api row is ignored', () => {
    // A `notification` row carrying a vendor must not contribute (only api rows
    // hold a CRM/acct vendor profile). The store fake filters by kind, exactly as
    // the SQLite store does.
    const notif = mkRow('hs-notif', 'hubspot', { kind: 'notification', pk: 'notification:hs-notif' });
    expect(families([notif])).toEqual([]);
  });
});

// ──────────────── Fix 2 — merged registry ────────────────

/** A registry entity for an arbitrary vendor, alias-marked for one family. Used to
 *  prove `deriveBoundConventionFamilies` honours the registry PARAM (independent of
 *  `liveVendorRegistry`'s lift logic). */
const mkVendorEntity = (
  vendor: string,
  alias: Pick<ConnectionVendorEntity, 'crm_alias'> | Pick<ConnectionVendorEntity, 'acct_alias'>,
  entity = 'e',
): ConnectionVendorEntity => ({
  vendor,
  entity,
  scope: `connection.api.${vendor}.${entity}`,
  display_name: `${vendor} ${entity}`,
  meta_fields: [],
  ...alias,
});

/** A minimal valid `EntitySchemaIngredientInput` carrying the fields
 *  `vendorEntitiesFromComposition` lifts (`wraps_vendor` + one of
 *  `crm_alias`/`acct_alias`). Mirrors `recipe-runnability-handler.test.ts`'s
 *  fixture. */
const mkEntitySchema = (
  wraps_vendor: string,
  alias: { crm_alias: 'deal' | 'contact' | 'account' } | { acct_alias: 'invoice' },
  entity_id = `${wraps_vendor}_e`,
): EntitySchemaIngredientInput => ({
  ingredient_id: `${wraps_vendor}-pack`,
  wraps_vendor,
  entity_id,
  scope: `connection.api.${wraps_vendor}.${entity_id}`,
  projection_mode: 'platform_reference',
  schema_mode: 'static',
  ...alias,
  target_id: { fields: ['id'], template: `${entity_id}_{id}` },
  meta_fields: [{ key: 'id', type: 'string', source_path: 'id' }],
  source_operations: {},
});

/** D-192 S4 — a minimal engagement `EntitySchemaIngredientInput` (a pack's
 *  activity entity: the `engagement` facet + a source-pathed `id` field so the
 *  lift keeps it). */
const mkEngagementSchema = (
  wraps_vendor: string,
  entity_id: string,
  engagement: NonNullable<EntitySchemaIngredientInput['engagement']>,
): EntitySchemaIngredientInput => ({
  ingredient_id: `${wraps_vendor}-pack`,
  wraps_vendor,
  entity_id,
  scope: `connection.api.${wraps_vendor}.${entity_id}`,
  projection_mode: 'platform_reference',
  schema_mode: 'static',
  engagement,
  target_id: { fields: ['id'], template: `${entity_id}_{id}` },
  meta_fields: [{ key: 'id', type: 'string', source_path: 'id' }],
  source_operations: {},
});

/** A `localManifestStore` fake over a `slug → entity_schemas[]` map; only the two
 *  methods `liveVendorRegistry` reads are implemented. */
const localManifestStoreOf = (
  manifests: Map<string, EntitySchemaIngredientInput[]>,
): Pick<LocalManifestStore, 'listManifests' | 'getEntitySchemas'> => ({
  listManifests: () =>
    [...manifests.keys()].map((slug) => ({ slug }) as unknown as IngredientManifest),
  getEntitySchemas: (slug) => manifests.get(slug) ?? [],
});

const familiesWith = (rows: ConnectionRow[], registry: ReadonlyArray<ConnectionVendorEntity>) =>
  [...deriveBoundConventionFamilies(storeOf(rows), registry)].sort();

describe('deriveBoundConventionFamilies — merged registry (Fix 2)', () => {
  it('a connected pack-composition acct vendor (QuickBooks) binds `acct` with the merged registry', () => {
    const registry = [...CONNECTION_VENDOR_ENTITIES, mkVendorEntity('quickbooks', { acct_alias: 'invoice' })];
    expect(familiesWith([mkRow('qb', 'quickbooks')], registry)).toEqual(['acct']);
  });

  it('a connected 3rd-party CRM pack vendor binds `crm` with the merged registry', () => {
    const registry = [...CONNECTION_VENDOR_ENTITIES, mkVendorEntity('acme', { crm_alias: 'deal' })];
    expect(familiesWith([mkRow('acme-conn', 'acme')], registry)).toEqual(['crm']);
  });

  it('the same QuickBooks connection still binds NOTHING under the default (built-in) registry', () => {
    // The default-registry path is unchanged — the fail-safe / no-regression guard.
    expect(familiesWith([mkRow('qb', 'quickbooks')], CONNECTION_VENDOR_ENTITIES)).toEqual([]);
  });

  it('built-in HubSpot still binds `crm` under a merged registry (no regression)', () => {
    const registry = [...CONNECTION_VENDOR_ENTITIES, mkVendorEntity('quickbooks', { acct_alias: 'invoice' })];
    expect(familiesWith([mkRow('hs', 'hubspot')], registry)).toEqual(['crm']);
  });

  it('a mixed connection set resolves both families off the merged registry', () => {
    const registry = [...CONNECTION_VENDOR_ENTITIES, mkVendorEntity('quickbooks', { acct_alias: 'invoice' })];
    expect(familiesWith([mkRow('hs', 'hubspot'), mkRow('qb', 'quickbooks')], registry)).toEqual([
      'acct',
      'crm',
    ]);
  });

  it('end-to-end: a QuickBooks connection binds `acct` via deriveBound(store, liveVendorRegistry(manifestStore))', () => {
    const manifestStore = localManifestStoreOf(
      new Map([['qb-pack', [mkEntitySchema('quickbooks', { acct_alias: 'invoice' })]]]),
    );
    const fams = [
      ...deriveBoundConventionFamilies(storeOf([mkRow('qb', 'quickbooks')]), liveVendorRegistry(manifestStore)),
    ].sort();
    expect(fams).toEqual(['acct']);
  });
});

// ──────────────── S1 — per-connection enumeration + freshness gating ────────────────

describe('deriveBoundCrmConnections', () => {
  it('an undefined store → empty (nothing connected)', () => {
    expect(deriveBoundCrmConnections('deal', undefined)).toEqual([]);
  });

  it('no connections → empty', () => {
    expect(deriveBoundCrmConnections('deal', storeOf([]))).toEqual([]);
  });

  it('a HubSpot connection → one per-connection entry with its name + deal scope', () => {
    expect(deriveBoundCrmConnections('deal', storeOf([mkRow('acme-hubspot', 'hubspot')]))).toEqual([
      {
        connection_name: 'acme-hubspot',
        vendor: 'hubspot',
        entity: 'deal',
        scope: 'connection.api.hubspot.deal',
      },
    ]);
  });

  it('TWO connections of the SAME vendor → TWO entries (NOT deduped, unlike deriveBoundCrmMirrorSources)', () => {
    const rows = [mkRow('acme-hubspot', 'hubspot'), mkRow('personal-hubspot', 'hubspot')];
    expect(deriveBoundCrmConnections('deal', storeOf(rows)).map((c) => c.connection_name).sort()).toEqual([
      'acme-hubspot',
      'personal-hubspot',
    ]);
  });

  it('crm_alias contact maps HubSpot → the contact entity + scope', () => {
    expect(deriveBoundCrmConnections('contact', storeOf([mkRow('hs', 'hubspot')]))[0]).toMatchObject({
      vendor: 'hubspot',
      entity: 'contact',
      scope: 'connection.api.hubspot.contact',
    });
  });

  it('Salesforce deal alias maps to the opportunity entity', () => {
    expect(deriveBoundCrmConnections('deal', storeOf([mkRow('sf', 'salesforce')]))[0]).toMatchObject({
      vendor: 'salesforce',
      entity: 'opportunity',
      scope: 'connection.api.salesforce.opportunity',
    });
  });

  it('a non-CRM connection (slack) contributes nothing', () => {
    expect(deriveBoundCrmConnections('deal', storeOf([mkRow('slack', 'slack')]))).toEqual([]);
  });

  it('a pack-declared CRM vendor enumerates per-connection under the merged registry', () => {
    const registry = [...CONNECTION_VENDOR_ENTITIES, mkVendorEntity('acme', { crm_alias: 'deal' }, 'pipe')];
    expect(deriveBoundCrmConnections('deal', storeOf([mkRow('acme-conn', 'acme')]), registry)).toEqual([
      { connection_name: 'acme-conn', vendor: 'acme', entity: 'pipe', scope: 'connection.api.acme.pipe' },
    ]);
  });
});

describe('syncedAtFromReconcileState', () => {
  it('a null / undefined row → null (never synced)', () => {
    expect(syncedAtFromReconcileState(null)).toBeNull();
    expect(syncedAtFromReconcileState(undefined)).toBeNull();
  });

  it('a completed run → its last_run_at', () => {
    expect(syncedAtFromReconcileState({ last_run_at: 5_000, last_status: 'complete' })).toBe(5_000);
  });

  it('a yielded run (recorded pending) with a last_run_at → that wall-clock (still synced-as-of-then)', () => {
    expect(syncedAtFromReconcileState({ last_run_at: 7_000, last_status: 'pending' })).toBe(7_000);
  });

  it('a last-errored run → null (last sync failed, treat as stale/unknown)', () => {
    expect(syncedAtFromReconcileState({ last_run_at: 9_000, last_status: 'error' })).toBeNull();
  });

  it('a never-run task (last_run_at null) → null', () => {
    expect(syncedAtFromReconcileState({ last_run_at: null, last_status: 'pending' })).toBeNull();
  });
});

describe('liveVendorRegistry', () => {
  it('an undefined store → the frozen built-in registry', () => {
    expect(liveVendorRegistry(undefined)).toBe(CONNECTION_VENDOR_ENTITIES);
  });

  it('a store lifting a 3rd-party CRM entity → built-ins + that vendor', () => {
    const reg = liveVendorRegistry(
      localManifestStoreOf(new Map([['acme-pack', [mkEntitySchema('acme', { crm_alias: 'deal' })]]])),
    );
    expect(reg.length).toBe(CONNECTION_VENDOR_ENTITIES.length + 1);
    expect(reg.some((e) => e.vendor === 'acme' && e.crm_alias === 'deal')).toBe(true);
  });

  it('a store lifting a pack-composition acct entity → built-ins + that vendor (acct family)', () => {
    const reg = liveVendorRegistry(
      localManifestStoreOf(new Map([['qb-pack', [mkEntitySchema('quickbooks', { acct_alias: 'invoice' })]]])),
    );
    expect(reg.some((e) => e.vendor === 'quickbooks' && e.acct_alias === 'invoice')).toBe(true);
  });

  it('a composition CLAIMING a built-in vendor id contributes nothing (whole-pack fail-closed)', () => {
    // A 3rd-party manifest lifting an entity under the `hubspot` vendor id must not
    // merge — the entire manifest is dropped, the built-in registry stands.
    const reg = liveVendorRegistry(
      localManifestStoreOf(new Map([['rogue', [mkEntitySchema('hubspot', { crm_alias: 'deal' })]]])),
    );
    expect(reg).toBe(CONNECTION_VENDOR_ENTITIES);
  });

  it('a store with no alias-marked entities → the frozen built-in registry', () => {
    const reg = liveVendorRegistry(localManifestStoreOf(new Map([['empty', []]])));
    expect(reg).toBe(CONNECTION_VENDOR_ENTITIES);
  });

  // ── D-192 S4 — engagement facet lift + merge-guard ──
  it('a store lifting an engagement entity → built-ins + that vendor, facet carried', () => {
    const reg = liveVendorRegistry(
      localManifestStoreOf(new Map([['dyn-pack', [
        mkEngagementSchema('dynamics', 'email', { capability: 'always', sync_kind: 'delta_cursor' }),
      ]]])),
    );
    const dyn = reg.find((e) => e.vendor === 'dynamics' && e.entity === 'email');
    expect(dyn?.engagement).toEqual({ capability: 'always', sync_kind: 'delta_cursor' });
    // it is a THIRD category — not an accidental crm/acct entity.
    expect(dyn?.crm_alias).toBeUndefined();
    expect(dyn?.acct_alias).toBeUndefined();
  });

  it('a single manifest with internally-inconsistent engagement (split sync_kind) is dropped (fail-closed)', () => {
    const reg = liveVendorRegistry(
      localManifestStoreOf(new Map([['dyn-pack', [
        mkEngagementSchema('dynamics', 'email', { capability: 'always', sync_kind: 'delta_cursor' }),
        mkEngagementSchema('dynamics', 'task', { capability: 'always', sync_kind: 'poll' }),
      ]]])),
    );
    // whole manifest dropped → the frozen built-ins stand, no dynamics rows leak.
    expect(reg).toBe(CONNECTION_VENDOR_ENTITIES);
  });

  it('CROSS-PACK: two manifests declaring the SAME vendor with conflicting sync_kind → first wins, second dropped', () => {
    // The per-manifest guard alone would pass BOTH (each is internally consistent);
    // validating the ACCUMULATED third-party set drops the later conflicting one so
    // engagementSyncKind(vendor) is never order-dependent. listManifests order is the
    // Map insertion order below → `pack-a` (delta_cursor) wins.
    const reg = liveVendorRegistry(
      localManifestStoreOf(new Map([
        ['pack-a', [mkEngagementSchema('dynamics', 'email', { capability: 'always', sync_kind: 'delta_cursor' })]],
        ['pack-b', [mkEngagementSchema('dynamics', 'task', { capability: 'always', sync_kind: 'poll' })]],
      ])),
    );
    const dynRows = reg.filter((e) => e.vendor === 'dynamics');
    expect(dynRows).toHaveLength(1);
    expect(dynRows[0].entity).toBe('email');
    expect(engagementSyncKind('dynamics', reg)).toBe('delta_cursor');
  });

  it('CROSS-PACK: two manifests, same vendor, CONSISTENT engagement → both coexist (no false drop)', () => {
    const reg = liveVendorRegistry(
      localManifestStoreOf(new Map([
        ['pack-a', [mkEngagementSchema('dynamics', 'email', { capability: 'always', sync_kind: 'delta_cursor' })]],
        ['pack-b', [mkEngagementSchema('dynamics', 'task', { capability: 'always', sync_kind: 'delta_cursor' })]],
      ])),
    );
    expect(reg.filter((e) => e.vendor === 'dynamics').map((e) => e.entity).sort()).toEqual(['email', 'task']);
  });

  // ── D-192 unit-3 — reserved-namespace shadow guard ──
  it('a pack vendor named after a RESERVED data.* sub-namespace (contact) is dropped (fail-closed)', () => {
    // `contact` is a reserved first-class data.* namespace (the personal contact
    // graph). Absent the guard, this vendor would be lifted and — once it reaches
    // the read-side alias resolver via the live registry (the unit-3 seam) —
    // `matchVendorEnrichmentAlias` could rewrite `data.contact.*.enrichments.*` and
    // shadow the reserved namespace. The whole manifest is dropped, mirroring the
    // built-in boot check (`assertNoVendorPrefixClash`).
    const reg = liveVendorRegistry(
      localManifestStoreOf(new Map([['shadow', [mkEntitySchema('contact', { crm_alias: 'deal' })]]])),
    );
    expect(reg).toBe(CONNECTION_VENDOR_ENTITIES);
    expect(reg.some((e) => e.vendor === 'contact')).toBe(false);
  });
});
